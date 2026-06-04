/* =====================================================================
 *  THE ETERNAL SKALD — Server-Side Hook (v0.3.2)
 *  ---------------------------------------------------------------------
 *
 *  Usage:
 *      node --import ./Data/modules/the-eternal-skald/scripts/eternal-skald-server.mjs \
 *           resources/app/main.mjs --dataPath=...
 *
 *  This file is loaded BEFORE Foundry's entry-point via Node's --import
 *  flag. It monkey-patches http.Server.prototype.emit (and the https
 *  equivalent) so that ANY HTTP request whose URL begins with
 *  /skald-api/ is intercepted and handled by us — the request never
 *  reaches Express/Foundry.
 *
 *  WHY patch .emit() instead of http.createServer()?
 *  --------------------------------------------------
 *  Foundry VTT v14 bundles its dependencies. The bundled Express may
 *  capture a reference to http.createServer in a closure BEFORE our
 *  --import hook runs, making a createServer() monkey-patch invisible.
 *  But .emit('request', req, res) is called by Node's internal HTTP
 *  parser for EVERY incoming request on EVERY server, and it always
 *  goes through the prototype chain. Patching emit() is therefore
 *  100% reliable regardless of how the server was created.
 *
 *  Endpoints
 *  ---------
 *  GET   /skald-api/health  → { status: "ok", ... }
 *  POST  /skald-api/chat    → forwards to upstream LLM
 *  OPTIONS /skald-api/*     → 204 CORS preflight
 *
 *  Ironsworn integration note (v0.3.0)
 *  -----------------------------------
 *  This proxy is intentionally STATELESS — it has no access to the
 *  Foundry `game` object, the active world, or the foundry-ironsworn
 *  system. ALL Ironsworn game-state context (character sheet, meters,
 *  momentum, progress tracks, the move catalog, and the move/effect
 *  directive protocol) is gathered CLIENT-SIDE by the module's
 *  Integration layer (see scripts/eternal-skald.js → Integration and
 *  buildIronswornPromptBlock) and injected into `payload.messages`
 *  before the request ever reaches this hook. The server simply
 *  forwards those messages verbatim to the upstream LLM.
 *
 *  Requirements: Node 18+. Zero npm dependencies.
 *
 *  License: MIT
 * ===================================================================== */

import http  from "node:http";
import https from "node:https";

const VERSION    = "0.3.2";
const PREFIX     = "/skald-api/";
const MAX_BODY   = 2 * 1024 * 1024;   // 2 MiB inbound limit
const MAX_RESP   = 8 * 1024 * 1024;   // 8 MiB upstream response limit
const TIMEOUT_MS = 60_000;             // 60s upstream timeout

/* ── Logging ─────────────────────────────────────────────────────── */

const TAG = "⚔️  Skald";
const log = (msg) => process.stdout.write(`${TAG} | ${msg}\n`);
const err = (msg) => process.stderr.write(`${TAG} | ERROR: ${msg}\n`);

/* ── HTTP helpers ────────────────────────────────────────────────── */

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age",       "86400");
}

function json(res, status, obj) {
  corsHeaders(res);
  const buf = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, {
    "Content-Type":   "application/json; charset=utf-8",
    "Content-Length":  buf.length
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        const e = new Error("Request body too large");
        e.statusCode = 413;
        reject(e);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (_) {
        const e = new Error("Invalid JSON");
        e.statusCode = 400;
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/* ── Upstream forwarder ──────────────────────────────────────────── */

function forward({ apiKey, endpoint, payload }) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(endpoint); }
    catch (_) {
      const e = new Error(`Bad endpoint URL: ${endpoint}`);
      e.statusCode = 400;
      return reject(e);
    }

    const lib  = url.protocol === "https:" ? https : http;
    const body = Buffer.from(JSON.stringify(payload ?? {}), "utf8");

    const opts = {
      method:   "POST",
      hostname: url.hostname,
      port:     url.port || (url.protocol === "https:" ? 443 : 80),
      path:     url.pathname + (url.search || ""),
      headers: {
        "Content-Type":   "application/json",
        "Content-Length":  body.length,
        "Authorization":  `Bearer ${apiKey}`,
        "apiKey":          apiKey,
        "User-Agent":     `TheEternalSkald/${VERSION}`
      }
    };

    const req = lib.request(opts, (res) => {
      const buf = [];
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_RESP) {
          req.destroy();
          const e = new Error("Upstream response too large");
          e.statusCode = 502;
          reject(e);
          return;
        }
        buf.push(chunk);
      });
      res.on("end", () => resolve({
        status: res.statusCode || 502,
        body:   Buffer.concat(buf).toString("utf8")
      }));
      res.on("error", (e) => {
        const err = new Error(`Upstream stream error: ${e.message}`);
        err.statusCode = 502;
        reject(err);
      });
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      const e = new Error(`Upstream timed out (${TIMEOUT_MS}ms)`);
      e.statusCode = 504;
      reject(e);
    });
    req.on("error", (e) => {
      const err = new Error(`Upstream connection failed: ${e.message}`);
      err.statusCode = 502;
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

/* ── Request handler ─────────────────────────────────────────────── */

async function handle(req, res) {
  const urlPath = (req.url || "").split("?")[0];
  const sub = urlPath.slice(PREFIX.length).replace(/^\/+|\/+$/g, "");

  // CORS preflight
  if (req.method === "OPTIONS") {
    corsHeaders(res);
    res.writeHead(204, { "Content-Length": "0" });
    return res.end();
  }

  // Health check
  if (req.method === "GET" && (sub === "health" || sub === "")) {
    return json(res, 200, {
      status:  "ok",
      service: "The Eternal Skald",
      version: VERSION
    });
  }

  // Chat endpoint
  if (req.method === "POST" && sub === "chat") {
    let body;
    try { body = await readBody(req); }
    catch (e) {
      return json(res, e.statusCode ?? 400, { error: e.message });
    }

    const { apiKey, endpoint, payload } = body;
    if (!apiKey || typeof apiKey !== "string") {
      return json(res, 400, { error: "Missing 'apiKey' field" });
    }
    if (!endpoint || typeof endpoint !== "string") {
      return json(res, 400, { error: "Missing 'endpoint' field" });
    }
    if (!payload || typeof payload !== "object") {
      return json(res, 400, { error: "Missing 'payload' object" });
    }

    try {
      const result = await forward({ apiKey, endpoint, payload });
      corsHeaders(res);
      res.writeHead(result.status, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(result.body);
    } catch (e) {
      err(`upstream: ${e.message}`);
      return json(res, e.statusCode ?? 502, { error: e.message });
    }
  }

  // Unknown sub-path
  return json(res, 404, { error: `Unknown path: ${urlPath}` });
}

/* ── The Patch ───────────────────────────────────────────────────── *
 *                                                                     *
 *  We patch Server.prototype.emit on BOTH http and https.             *
 *  When the 'request' event fires, we check if the URL starts with    *
 *  /skald-api/. If yes → handle it ourselves, return true (consumed). *
 *  If no → call the original emit so Express/Foundry handles it.      *
 *                                                                     *
 * ─────────────────────────────────────────────────────────────────── */

function patchEmit(ServerClass, label) {
  const orig = ServerClass.prototype.emit;
  if (ServerClass.prototype.__skaldPatched) return;

  ServerClass.prototype.emit = function skaldEmit(event, ...args) {
    if (event === "request" && args.length >= 2) {
      const req = args[0];
      const res = args[1];
      if (typeof req?.url === "string" && req.url.startsWith(PREFIX)) {
        // Our request — handle it, never let Foundry see it.
        handle(req, res).catch((e) => {
          err(`handler crash: ${e.stack || e.message}`);
          if (!res.headersSent) {
            try {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Internal server error" }));
            } catch (_) { /* socket gone */ }
          }
        });
        return true;  // event consumed
      }
    }
    // Everything else → original behaviour
    return orig.apply(this, [event, ...args]);
  };

  ServerClass.prototype.__skaldPatched = true;
  log(`patched ${label}.Server.prototype.emit`);
}

patchEmit(http.Server,  "http");
patchEmit(https.Server, "https");

log(`v${VERSION} — server hook active. /skald-api/* routes ready.`);
log(`Verify: curl http://localhost:<port>/skald-api/health`);
