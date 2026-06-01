#!/usr/bin/env node
/* =====================================================================
 *  THE ETERNAL SKALD — Local CORS-bypass Proxy
 *  ---------------------------------------------------------------------
 *  Foundry VTT modules run inside the browser, and the browser blocks
 *  cross-origin POST requests to `https://api.abacus.ai/...` from the
 *  Foundry origin (e.g. `http://localhost:30000` or any LAN address
 *  Foundry happens to be served on). The ONLY robust fix is to relay
 *  the request through a local server.
 *
 *  This script is a single-file, zero-dependency Node.js HTTP proxy
 *  that does exactly that. Start it on the SAME machine that runs
 *  Foundry, point the module's "Proxy URL" setting at it, and every
 *  API call from the module will travel server-side instead of
 *  browser-side — no CORS, no preflight failures.
 *
 *  Usage:
 *      node proxy/skald-proxy.js
 *
 *  Requirements:
 *      Node.js 18+ (any recent LTS works). NO npm install needed.
 *
 *  Endpoints:
 *      POST /api/chat   →  Forwards { apiKey, endpoint, payload } to
 *                          `endpoint` with `Authorization: Bearer <apiKey>`,
 *                          returns the upstream JSON verbatim.
 *      OPTIONS  *       →  CORS preflight (204 + permissive headers)
 *      GET /             →  Health check (returns { status: "ok" })
 *
 *  Headers added to every response:
 *      Access-Control-Allow-Origin:  *
 *      Access-Control-Allow-Methods: GET, POST, OPTIONS
 *      Access-Control-Allow-Headers: Content-Type, Authorization, apiKey
 *
 *  Configuration (environment variables):
 *      SKALD_PROXY_PORT   default: 3001
 *      SKALD_PROXY_HOST   default: 0.0.0.0  (binds on all interfaces so
 *                                            the proxy is reachable from
 *                                            both `localhost` and any
 *                                            LAN address Foundry might
 *                                            be served on. Set to
 *                                            `localhost` / `127.0.0.1`
 *                                            to restrict to loopback.)
 *
 *  Author: The Eternal Skald Project
 *  License: MIT
 * ===================================================================== */

const http  = require("http");
const https = require("https");
const url   = require("url");

const PORT = parseInt(process.env.SKALD_PROXY_PORT, 10) || 3001;
// Bind on all interfaces by default so the proxy is reachable both via
// `http://localhost:3001` and via the LAN IP Foundry is served on. The
// module's "Proxy URL" setting still defaults to `localhost` — only the
// server-side bind is permissive.
const HOST = process.env.SKALD_PROXY_HOST || "0.0.0.0";

// Maximum body size we'll accept from the Foundry browser side (bytes).
// 2 MiB is more than enough for any chat-completion payload.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

// Maximum upstream response size we'll buffer (bytes). 8 MiB is generous
// — most chat completions are < 50 KB.
const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;

/* ---------------------------------------------------------------------
 * Logging helpers — timestamped + a tiny saga touch.
 * ------------------------------------------------------------------- */
const COLOR = {
  reset:  "\u001b[0m",
  dim:    "\u001b[2m",
  red:    "\u001b[31m",
  green:  "\u001b[32m",
  yellow: "\u001b[33m",
  cyan:   "\u001b[36m"
};
function ts() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}
function log(level, msg) {
  const c =
    level === "error" ? COLOR.red    :
    level === "warn"  ? COLOR.yellow :
    level === "ok"    ? COLOR.green  :
    COLOR.cyan;
  process.stdout.write(`${COLOR.dim}[${ts()}]${COLOR.reset} ${c}${level.toUpperCase()}${COLOR.reset} ${msg}\n`);
}

/* ---------------------------------------------------------------------
 * CORS header helper — sets the permissive headers we need so the
 * browser doesn't block the response.
 * ------------------------------------------------------------------- */
function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, apiKey");
  res.setHeader("Access-Control-Max-Age", "86400"); // 24h preflight cache
}

/* ---------------------------------------------------------------------
 * Send a JSON response (sets the right headers, stringifies safely).
 * ------------------------------------------------------------------- */
function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  setCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}

/* ---------------------------------------------------------------------
 * Read the full request body (with a hard upper bound) and return it
 * as a Buffer. Rejects on overflow or stream error.
 * ------------------------------------------------------------------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let aborted = false;

    req.on("data", chunk => {
      if (aborted) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        aborted = true;
        reject(new Error(`Request body too large (> ${MAX_BODY_BYTES} bytes)`));
        try { req.destroy(); } catch (_) {}
        return;
      }
      chunks.push(chunk);
    });
    req.on("end",   () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    req.on("error", err => { if (!aborted) reject(err); });
  });
}

/* ---------------------------------------------------------------------
 * Forward a payload to an upstream HTTP(S) URL and resolve with
 * { statusCode, headers, body } where body is a Buffer.
 * ------------------------------------------------------------------- */
function forwardToUpstream(targetUrl, payload, apiKey) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); }
    catch (e) {
      reject(new Error(`Invalid endpoint URL: ${targetUrl}`));
      return;
    }

    const isHttps = parsed.protocol === "https:";
    const lib     = isHttps ? https : http;
    const body    = Buffer.from(JSON.stringify(payload), "utf-8");

    const options = {
      method:   "POST",
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ""),
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": body.length,
        "Authorization":  `Bearer ${apiKey}`,
        // Some Abacus deployments accept the raw header instead.
        "apiKey":         apiKey,
        // Identify ourselves to upstream for easier debugging.
        "User-Agent":     "TheEternalSkaldProxy/1.0.8 (+https://github.com/papicy/eternal_skald)"
      }
    };

    const upstreamReq = lib.request(options, upstreamRes => {
      const chunks = [];
      let total = 0;
      let overflowed = false;
      upstreamRes.on("data", chunk => {
        if (overflowed) return;
        total += chunk.length;
        if (total > MAX_UPSTREAM_BYTES) {
          overflowed = true;
          upstreamRes.destroy();
          reject(new Error(`Upstream response too large (> ${MAX_UPSTREAM_BYTES} bytes)`));
          return;
        }
        chunks.push(chunk);
      });
      upstreamRes.on("end", () => {
        if (overflowed) return;
        resolve({
          statusCode: upstreamRes.statusCode || 502,
          headers:    upstreamRes.headers,
          body:       Buffer.concat(chunks)
        });
      });
      upstreamRes.on("error", reject);
    });

    upstreamReq.on("error", err => {
      reject(new Error(`Upstream network failure: ${err.message}`));
    });

    // 60 second timeout — chat-completion can be slow but not infinite.
    upstreamReq.setTimeout(60_000, () => {
      upstreamReq.destroy(new Error("Upstream request timed out after 60s"));
    });

    upstreamReq.write(body);
    upstreamReq.end();
  });
}

/* ---------------------------------------------------------------------
 * POST /api/chat handler — the workhorse.
 *
 * Expected request body (JSON):
 *   {
 *     apiKey:   "...",                                      // required
 *     endpoint: "https://api.abacus.ai/v1/chat/completions",// required
 *     payload:  { model, messages, ... }                    // required, OpenAI-style
 *   }
 *
 * Response: the upstream JSON (or error JSON if anything went wrong).
 * ------------------------------------------------------------------- */
async function handleChat(req, res) {
  let bodyBuf;
  try { bodyBuf = await readBody(req); }
  catch (e) {
    log("warn", `Body read failed: ${e.message}`);
    return sendJson(res, 413, { error: "request_too_large", message: e.message });
  }

  if (!bodyBuf || bodyBuf.length === 0) {
    return sendJson(res, 400, { error: "empty_body", message: "Request body is empty." });
  }

  let parsed;
  try { parsed = JSON.parse(bodyBuf.toString("utf-8")); }
  catch (e) {
    log("warn", `Bad JSON: ${e.message}`);
    return sendJson(res, 400, { error: "invalid_json", message: e.message });
  }

  const { apiKey, endpoint, payload } = parsed || {};
  if (typeof apiKey   !== "string" || !apiKey.length)   return sendJson(res, 400, { error: "missing_apiKey",   message: "Field 'apiKey' is required and must be a non-empty string." });
  if (typeof endpoint !== "string" || !endpoint.length) return sendJson(res, 400, { error: "missing_endpoint", message: "Field 'endpoint' is required and must be a non-empty string." });
  if (!payload || typeof payload !== "object")          return sendJson(res, 400, { error: "missing_payload",  message: "Field 'payload' is required and must be a JSON object." });

  log("info", `→ POST ${endpoint}  model=${payload.model ?? "?"}  msgs=${Array.isArray(payload.messages) ? payload.messages.length : "?"}`);

  let upstream;
  try { upstream = await forwardToUpstream(endpoint, payload, apiKey); }
  catch (e) {
    log("error", `Upstream failed: ${e.message}`);
    return sendJson(res, 502, { error: "upstream_failure", message: e.message });
  }

  // Pass the upstream status through to the browser, but with CORS headers.
  setCorsHeaders(res);
  res.statusCode = upstream.statusCode;
  const ct = upstream.headers["content-type"] || "application/json; charset=utf-8";
  res.setHeader("Content-Type", ct);
  res.setHeader("Content-Length", upstream.body.length);

  const statusStr = upstream.statusCode >= 200 && upstream.statusCode < 300 ? "ok" : "warn";
  log(statusStr, `← ${upstream.statusCode} ${upstream.body.length} bytes`);
  res.end(upstream.body);
}

/* ---------------------------------------------------------------------
 * Main HTTP server.
 * ------------------------------------------------------------------- */
const server = http.createServer(async (req, res) => {
  // CORS preflight — always answer permissively, never hit upstream.
  if (req.method === "OPTIONS") {
    setCorsHeaders(res);
    res.statusCode = 204;
    res.end();
    return;
  }

  let parsedUrl;
  try { parsedUrl = url.parse(req.url || "/", true); }
  catch (_) { parsedUrl = { pathname: "/" }; }
  const pathname = parsedUrl.pathname || "/";

  // Health check / status page
  if (req.method === "GET" && (pathname === "/" || pathname === "/health")) {
    return sendJson(res, 200, {
      status:  "ok",
      service: "The Eternal Skald Proxy",
      version: "1.0.8",
      endpoints: {
        chat:   "POST /api/chat",
        health: "GET /"
      }
    });
  }

  // Main chat-forwarding endpoint
  if (req.method === "POST" && pathname === "/api/chat") {
    try {
      await handleChat(req, res);
    } catch (e) {
      log("error", `Unhandled error in /api/chat: ${e.stack || e.message}`);
      try { sendJson(res, 500, { error: "internal_error", message: e.message }); } catch (_) {}
    }
    return;
  }

  // Fallback — 404 with CORS headers so the browser still sees it.
  sendJson(res, 404, { error: "not_found", message: `No route for ${req.method} ${pathname}` });
});

server.on("error", err => {
  if (err.code === "EADDRINUSE") {
    log("error", `Port ${PORT} is already in use. Set SKALD_PROXY_PORT to choose a different port.`);
  } else {
    log("error", `Server error: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // Friendly URL shown to the user. The server may be listening on
  // 0.0.0.0 (all interfaces), but for everyday use `localhost` is the
  // address the module's Proxy URL setting points at by default.
  const friendlyHost =
    (HOST === "0.0.0.0" || HOST === "::" || HOST === "::0") ? "localhost" : HOST;

  console.log("");
  console.log(`${COLOR.yellow}⚔️  The Eternal Skald Proxy running on http://${friendlyHost}:${PORT}${COLOR.reset}`);
  console.log("");
  log("ok",   `Listening on ${HOST}:${PORT}  (all interfaces: ${HOST === "0.0.0.0" ? "yes" : "no"})`);
  log("info", `Endpoint:  POST http://${friendlyHost}:${PORT}/api/chat`);
  log("info", `Health:    GET  http://${friendlyHost}:${PORT}/`);
  log("info", "Press Ctrl+C to stop the proxy.");
});

// Graceful shutdown on SIGINT / SIGTERM.
function shutdown(signal) {
  log("warn", `Received ${signal}, shutting down ...`);
  server.close(() => {
    log("ok", "Goodbye, Ironsworn.");
    process.exit(0);
  });
  // Force-exit after 5s if the server hangs on open connections.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
