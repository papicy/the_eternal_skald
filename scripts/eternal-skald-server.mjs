/* =====================================================================
 *  THE ETERNAL SKALD — Server-Side Hook (v0.6.0)
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
 *  GET   /skald-api/health       → { status: "ok", ... }
 *  POST  /skald-api/chat         → forwards to upstream LLM (buffered)
 *  POST  /skald-api/chat-stream  → forwards to upstream LLM and pipes the
 *                                  Server-Sent-Events token stream straight
 *                                  back to the client (v0.3.3, OpenAI SSE
 *                                  format: `data: {json}\n\n` … `data: [DONE]`).
 *                                  Falls back gracefully — on an upstream
 *                                  error before headers are flushed we reply
 *                                  with a normal JSON error; once the SSE
 *                                  stream has started we emit an
 *                                  `event: error` frame and close.
 *  OPTIONS /skald-api/*          → 204 CORS preflight
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
 *  Journal-system metadata note (v0.4.0)
 *  -------------------------------------
 *  v0.4.0 adds an auto-journaling system. Because this proxy is stateless
 *  and (for streaming) pipes the upstream SSE bytes through untouched, the
 *  structured journal metadata is NOT assembled server-side. Instead the
 *  CLIENT instructs the model (via the system prompt) to append a single
 *  trailing block to its reply:
 *
 *      [[SKALD_META]]
 *      {"entities":[…],"facts":[…],"mysteries":[…],"worldState":{…},"decisions":[…]}
 *      [[/SKALD_META]]
 *
 *  The client strips that block from the visible narration and parses it
 *  into journal entries (see JournalSystem in eternal-skald.js). Travelling
 *  inline keeps the server a pure pass-through and preserves token-by-token
 *  streaming — the metadata simply streams last and is hidden from display.
 *  No server change is required to carry it; this note documents the
 *  contract so the proxy and client stay in sync.
 *
 *  Requirements: Node 18+. Zero npm dependencies.
 *
 *  License: MIT
 * ===================================================================== */

import http  from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";

// (fix — version drift) Derive the version from module.json (the single source of
// truth) instead of a hardcoded literal that silently went stale (was "0.6.0"
// while the module shipped 0.14.0). This value feeds the User-Agent header, the
// /skald-api/health status payload, and the startup banner, so a stale literal
// mis-reported the running version on all three. module.json sits one directory
// above this file (repo-root). Falls back to "0" only if the manifest can't be
// read — never a wrong, hardcoded number. Keeps the "zero npm dependencies"
// contract (node:fs is a core module).
const VERSION    = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../module.json", import.meta.url), "utf8")).version || "0";
  } catch { return "0"; }
})();
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

/* ── Streaming upstream forwarder (v0.3.3) ───────────────────────── *
 *                                                                     *
 *  Opens the upstream LLM request with `stream: true` and pipes the   *
 *  raw Server-Sent-Events stream straight back to `clientRes`.        *
 *                                                                     *
 *  Error semantics:                                                   *
 *    • Upstream replies with HTTP >= 400  → we buffer its (small)     *
 *      error body and REJECT the promise. The caller has not yet      *
 *      flushed any headers, so it can emit a clean JSON error.        *
 *    • Connection / timeout failure BEFORE the SSE headers are sent   *
 *      → REJECT (caller emits JSON error).                            *
 *    • Failure AFTER the SSE stream has started → we write a terminal *
 *      `event: error` frame, end the response, and RESOLVE (the       *
 *      client already received a 200 + partial stream, so a JSON      *
 *      error is impossible).                                          *
 * ─────────────────────────────────────────────────────────────────── */

function forwardStream({ apiKey, endpoint, payload }, clientRes) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(endpoint); }
    catch (_) {
      const e = new Error(`Bad endpoint URL: ${endpoint}`);
      e.statusCode = 400;
      return reject(e);
    }

    const lib  = url.protocol === "https:" ? https : http;
    // Force streaming on the upstream payload regardless of what the
    // client sent — this endpoint is streaming-only.
    const streamPayload = { ...(payload ?? {}), stream: true };
    const body = Buffer.from(JSON.stringify(streamPayload), "utf8");

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
        "Accept":         "text/event-stream",
        "User-Agent":     `TheEternalSkald/${VERSION}`
      }
    };

    let headersFlushed = false;

    const req = lib.request(opts, (res) => {
      const status = res.statusCode || 502;

      // Upstream error → buffer the (small) body and reject so the
      // caller can send a clean JSON error. No SSE headers sent yet.
      if (status >= 400) {
        const buf = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes <= 64 * 1024) buf.push(chunk);
        });
        res.on("end", () => {
          let msg = `Upstream returned HTTP ${status}`;
          const raw = Buffer.concat(buf).toString("utf8");
          try {
            const j = JSON.parse(raw);
            msg = j?.error?.message || j?.error || j?.message || raw || msg;
          } catch (_) { if (raw) msg = raw; }
          const e = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
          e.statusCode = status;
          reject(e);
        });
        res.on("error", () => {
          const e = new Error(`Upstream stream error (HTTP ${status})`);
          e.statusCode = status;
          reject(e);
        });
        return;
      }

      // Success → flush SSE headers and pipe chunks straight through.
      corsHeaders(clientRes);
      clientRes.writeHead(200, {
        "Content-Type":      "text/event-stream; charset=utf-8",
        "Cache-Control":     "no-cache, no-transform",
        "Connection":        "keep-alive",
        "X-Accel-Buffering": "no"
      });
      if (typeof clientRes.flushHeaders === "function") clientRes.flushHeaders();
      headersFlushed = true;

      res.on("data", (chunk) => {
        try { clientRes.write(chunk); } catch (_) { /* client gone */ }
      });
      res.on("end", () => {
        try { clientRes.end(); } catch (_) { /* already closed */ }
        resolve();
      });
      res.on("error", (e) => {
        // Stream already started — emit a terminal SSE error frame.
        try {
          clientRes.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
          clientRes.end();
        } catch (_) { /* socket gone */ }
        resolve();
      });
    });

    // If the client hangs up, abort the upstream request to free it.
    clientRes.on("close", () => { try { req.destroy(); } catch (_) {} });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      if (headersFlushed) {
        try {
          clientRes.write(`event: error\ndata: ${JSON.stringify({ error: `Upstream timed out (${TIMEOUT_MS}ms)` })}\n\n`);
          clientRes.end();
        } catch (_) {}
        return resolve();
      }
      const e = new Error(`Upstream timed out (${TIMEOUT_MS}ms)`);
      e.statusCode = 504;
      reject(e);
    });
    req.on("error", (e) => {
      if (headersFlushed) {
        try {
          clientRes.write(`event: error\ndata: ${JSON.stringify({ error: `Upstream connection failed: ${e.message}` })}\n\n`);
          clientRes.end();
        } catch (_) {}
        return resolve();
      }
      const err2 = new Error(`Upstream connection failed: ${e.message}`);
      err2.statusCode = 502;
      reject(err2);
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

  // Streaming chat endpoint (v0.3.3)
  if (req.method === "POST" && sub === "chat-stream") {
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
      await forwardStream({ apiKey, endpoint, payload }, res);
      return;
    } catch (e) {
      err(`stream upstream: ${e.message}`);
      // forwardStream only rejects BEFORE any SSE header was flushed,
      // so a clean JSON error is always safe here.
      if (!res.headersSent) {
        return json(res, e.statusCode ?? 502, { error: e.message });
      }
      try { res.end(); } catch (_) {}
      return;
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
