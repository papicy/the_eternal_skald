/* =====================================================================
 *  THE ETERNAL SKALD — Foundry VTT Server-Side Import Hook
 *  ---------------------------------------------------------------------
 *
 *  This file is loaded BEFORE Foundry's own entry-point via Node's
 *  --import flag, e.g.:
 *
 *      node --import ./Data/modules/the-eternal-skald/proxy/skald-hook.mjs \
 *           resources/app/main.mjs
 *
 *  …or with PM2:
 *
 *      pm2 start resources/app/main.mjs \
 *          --node-args="--import ./Data/modules/the-eternal-skald/proxy/skald-hook.mjs"
 *
 *  WHY this exists
 *  ---------------
 *  Foundry VTT runs in the browser. When a module tries to call
 *  api.abacus.ai directly the browser blocks the request because Abacus
 *  AI does not return CORS headers. The previous workaround — a
 *  separate Node proxy on localhost:3001 — works on bare localhost but
 *  breaks the moment Foundry is served over HTTPS or by a different
 *  hostname (Mixed-Content blocks; the proxy is invisible from a
 *  remote browser; the user has to maintain reverse-proxy rules).
 *
 *  This hook fixes all of that in one shot by monkey-patching
 *  `http.createServer` and `https.createServer` BEFORE Foundry creates
 *  its Express server. Once Foundry calls `http.createServer(handler)`,
 *  we return a wrapper that intercepts any URL beginning with
 *  `/skald-api/` and handles it ourselves; everything else falls
 *  through to Foundry's normal handler.
 *
 *  Result: `/skald-api/chat` is a SAME-ORIGIN endpoint. It rides
 *  Foundry's own TLS, on Foundry's own port. No CORS, no Mixed
 *  Content, no extra port to open, no reverse-proxy rules.
 *
 *  Endpoints exposed
 *  -----------------
 *  GET  /skald-api/health         → { status: "ok", ... }
 *  OPTIONS /skald-api/*           → 204 + permissive CORS headers
 *  POST /skald-api/chat           → forwards { apiKey, endpoint, payload }
 *                                   to upstream (default api.abacus.ai)
 *
 *  Requirements
 *  ------------
 *  Node 18+ (Foundry v13+ already ships with this). NO npm install.
 *
 *  Author: The Eternal Skald Project
 *  License: MIT
 * ===================================================================== */

import http  from "node:http";
import https from "node:https";

const SKALD_HOOK_VERSION   = "1.0.8";
const SKALD_PATH_PREFIX    = "/skald-api/";
const SKALD_MAX_BODY_BYTES = 2 * 1024 * 1024;   // 2 MiB request limit
const SKALD_MAX_UP_BYTES   = 8 * 1024 * 1024;   // 8 MiB response limit
const SKALD_UPSTREAM_TIMEOUT_MS = 60_000;

/* ---------------------------------------------------------------------
 *  Tiny logger — prefixed so it's findable in PM2 / systemd journals.
 * ------------------------------------------------------------------- */
function skaldLog(msg)  { process.stdout.write(`⚔️  Skald-Hook | ${msg}\n`); }
function skaldErr(msg)  { process.stderr.write(`⚔️  Skald-Hook | ERROR ${msg}\n`); }

/* ---------------------------------------------------------------------
 *  Apply permissive CORS headers — harmless in the same-origin case,
 *  but lets non-browser tooling (curl with --resolve, server health
 *  pings from another origin) probe the endpoint freely.
 * ------------------------------------------------------------------- */
function applyCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, apiKey, x-skald-api-key");
  res.setHeader("Access-Control-Max-Age",       "86400");
}

function sendJson(res, status, obj) {
  applyCorsHeaders(res);
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(status, {
    "Content-Type":   "application/json; charset=utf-8",
    "Content-Length": body.length
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on("data", chunk => {
      if (aborted) return;
      total += chunk.length;
      if (total > SKALD_MAX_BODY_BYTES) {
        aborted = true;
        const e = new Error(`Request body exceeded ${SKALD_MAX_BODY_BYTES} bytes`);
        e.statusCode = 413;
        return reject(e);
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        const err = new Error("Invalid JSON body");
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/* ---------------------------------------------------------------------
 *  Forward {apiKey, endpoint, payload} to the upstream LLM endpoint.
 *  Returns a Promise<{ status, body }>.
 * ------------------------------------------------------------------- */
function forwardUpstream({ apiKey, endpoint, payload }) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(endpoint); }
    catch (_) {
      const e = new Error(`Invalid endpoint URL: ${endpoint}`);
      e.statusCode = 400;
      return reject(e);
    }
    const lib = target.protocol === "https:" ? https : http;
    const body = Buffer.from(JSON.stringify(payload ?? {}), "utf8");

    const options = {
      method:   "POST",
      hostname: target.hostname,
      port:     target.port || (target.protocol === "https:" ? 443 : 80),
      path:     target.pathname + (target.search || ""),
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": body.length,
        "Authorization":  `Bearer ${apiKey}`,
        "apiKey":         apiKey,
        "User-Agent":     `TheEternalSkaldHook/${SKALD_HOOK_VERSION} (+https://github.com/papicy/eternal_skald)`
      }
    };

    const upstreamReq = lib.request(options, upstreamRes => {
      const buf = [];
      let bytes = 0;
      let abort = false;
      upstreamRes.on("data", chunk => {
        if (abort) return;
        bytes += chunk.length;
        if (bytes > SKALD_MAX_UP_BYTES) {
          abort = true;
          upstreamReq.destroy();
          const e = new Error(`Upstream response exceeded ${SKALD_MAX_UP_BYTES} bytes`);
          e.statusCode = 502;
          return reject(e);
        }
        buf.push(chunk);
      });
      upstreamRes.on("end", () => {
        if (abort) return;
        resolve({
          status: upstreamRes.statusCode || 502,
          body:   Buffer.concat(buf).toString("utf8")
        });
      });
      upstreamRes.on("error", err => {
        const e = new Error(`Upstream stream error: ${err.message}`);
        e.statusCode = 502;
        reject(e);
      });
    });

    upstreamReq.setTimeout(SKALD_UPSTREAM_TIMEOUT_MS, () => {
      upstreamReq.destroy();
      const e = new Error(`Upstream timed out after ${SKALD_UPSTREAM_TIMEOUT_MS} ms`);
      e.statusCode = 504;
      reject(e);
    });
    upstreamReq.on("error", err => {
      const e = new Error(`Upstream network failure: ${err.message}`);
      e.statusCode = 502;
      reject(e);
    });

    upstreamReq.write(body);
    upstreamReq.end();
  });
}

/* ---------------------------------------------------------------------
 *  Main handler for /skald-api/*.
 * ------------------------------------------------------------------- */
async function handleSkald(req, res) {
  // Strip any leading slash group so `/skald-api/chat?foo=bar` → `chat`.
  let path = (req.url || "").split("?")[0];
  if (path.startsWith(SKALD_PATH_PREFIX)) path = path.slice(SKALD_PATH_PREFIX.length);
  path = path.replace(/^\/+|\/+$/g, "");

  // CORS preflight (won't normally fire same-origin, but keep it correct)
  if (req.method === "OPTIONS") {
    applyCorsHeaders(res);
    res.writeHead(204, { "Content-Length": "0" });
    return res.end();
  }

  // Health check
  if (req.method === "GET" && (path === "health" || path === "" )) {
    return sendJson(res, 200, {
      status:  "ok",
      service: "The Eternal Skald Hook",
      version: SKALD_HOOK_VERSION,
      endpoints: { chat: "POST /skald-api/chat", health: "GET /skald-api/health" }
    });
  }

  // Chat completion forwarder
  if (req.method === "POST" && path === "chat") {
    let body;
    try { body = await readJsonBody(req); }
    catch (err) {
      return sendJson(res, err.statusCode ?? 400, {
        error:   "invalid_request",
        message: err.message
      });
    }

    const apiKey   = body.apiKey;
    const endpoint = body.endpoint;
    const payload  = body.payload;
    if (typeof apiKey !== "string" || !apiKey) {
      return sendJson(res, 400, { error: "missing_apiKey", message: "Field 'apiKey' is required." });
    }
    if (typeof endpoint !== "string" || !endpoint) {
      return sendJson(res, 400, { error: "missing_endpoint", message: "Field 'endpoint' is required." });
    }
    if (!payload || typeof payload !== "object") {
      return sendJson(res, 400, { error: "missing_payload", message: "Field 'payload' is required and must be an object." });
    }

    try {
      const { status, body: upstreamBody } = await forwardUpstream({ apiKey, endpoint, payload });
      applyCorsHeaders(res);
      // Pass upstream JSON verbatim — including non-2xx responses.
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(upstreamBody);
    } catch (err) {
      skaldErr(`upstream failed: ${err.message}`);
      return sendJson(res, err.statusCode ?? 502, {
        error:   "upstream_failure",
        message: err.message
      });
    }
  }

  // Unknown /skald-api/* path
  return sendJson(res, 404, {
    error:   "not_found",
    message: `Unknown skald-api path: /${path}`
  });
}

/* ---------------------------------------------------------------------
 *  Monkey-patch http.createServer and https.createServer.
 *  Foundry calls them at startup; we wrap the request handler so
 *  /skald-api/* short-circuits to ours, while everything else falls
 *  through to Foundry's existing Express handler unmodified.
 * ------------------------------------------------------------------- */
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function patchCreateServer(mod, label) {
  if (mod.__skaldPatched) return;
  const original = mod.createServer.bind(mod);

  mod.createServer = function patchedCreateServer(...args) {
    // Possible signatures:
    //   createServer()
    //   createServer(handler)
    //   createServer(options)
    //   createServer(options, handler)
    let options, handler;
    if (args.length === 0) {
      // Nothing to wrap up-front. We'll attach a 'request' listener
      // on the returned server instance later.
    } else if (args.length === 1) {
      if (typeof args[0] === "function") handler = args[0];
      else                                options = args[0];
    } else {
      options = args[0];
      handler = args[1];
    }

    const wrappedHandler = (req, res) => {
      try {
        if (typeof req.url === "string" && req.url.startsWith(SKALD_PATH_PREFIX)) {
          return handleSkald(req, res).catch(err => {
            skaldErr(`handler threw: ${err.stack || err.message}`);
            try {
              applyCorsHeaders(res);
              if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
              }
              res.end(JSON.stringify({ error: "internal_error", message: String(err.message ?? err) }));
            } catch (_) { /* ignore */ }
          });
        }
      } catch (err) {
        skaldErr(`pre-handler error: ${err.message}`);
      }
      if (typeof handler === "function") return handler(req, res);
      // No upstream handler — return 404 so we don't hang the socket.
      res.statusCode = 404;
      res.end();
    };

    let server;
    if (options && handler !== undefined) {
      server = original(options, wrappedHandler);
    } else if (options) {
      // For https we need options (TLS materials); attach our handler too.
      server = original(options, wrappedHandler);
    } else if (handler !== undefined) {
      server = original(wrappedHandler);
    } else {
      // createServer() with no args. Foundry may attach a handler later
      // via server.on('request', fn). Wrap addListener/on so the first
      // 'request' listener registered is intercepted by us, while the
      // user's listener still fires for non-skald URLs.
      server = original();
      const realOn = server.on.bind(server);
      const wrapListener = (listener) => (req, res) => {
        if (typeof req.url === "string" && req.url.startsWith(SKALD_PATH_PREFIX)) {
          return handleSkald(req, res).catch(err => {
            skaldErr(`handler threw: ${err.stack || err.message}`);
            if (!res.headersSent) {
              try {
                applyCorsHeaders(res);
                res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ error: "internal_error", message: String(err.message ?? err) }));
              } catch (_) { /* ignore */ }
            }
          });
        }
        return listener(req, res);
      };
      server.on = function patchedOn(event, listener) {
        if (event === "request" && typeof listener === "function") {
          return realOn(event, wrapListener(listener));
        }
        return realOn(event, listener);
      };
      server.addListener = server.on;
    }

    return server;
  };

  // Preserve any properties on the original function (for ESM/CJS interop).
  Object.assign(mod.createServer, original);
  mod.__skaldPatched = true;
  skaldLog(`patched ${label}.createServer (v${SKALD_HOOK_VERSION})`);
}

patchCreateServer(http,  "http");
patchCreateServer(https, "https");

skaldLog(`server hook armed — /skald-api/* routes active (v${SKALD_HOOK_VERSION})`);
