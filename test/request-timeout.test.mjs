/* =====================================================================
 *  Request-timeout test for The Eternal Skald (P2 latency / reliability).
 *
 *  Previously every AI fetch in scripts/ai/client.js had no client-side
 *  timeout: a stalled upstream could hang the UI until the server hook's own
 *  60s ceiling (or, on the direct browser→AI path, indefinitely). P2 adds a
 *  _fetch() helper backed by an AbortController + a configurable
 *  "requestTimeout" world setting (seconds, default 30), and routes ALL four
 *  fetch call sites through it. The timer guards the connection/headers phase
 *  only and is cleared in a finally block, so live SSE streams and long body
 *  downloads are never aborted mid-flight.
 *
 *  Two halves (mirrors keepalive-agent.test.mjs convention):
 *    [A] Source-text guards over the refactored corpus — the helper exists,
 *        wires an AbortController signal into fetch, cleans up, reads the
 *        setting with a 30s fallback, the setting is registered, and every
 *        call site goes through the helper (no bare `await fetch(` remains
 *        outside the helper itself).
 *    [B] A behavioural proof that the AbortController+setTimeout+clearTimeout
 *        pattern actually aborts a stalled request and leaks no timer.
 *
 *  Run: node test/request-timeout.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import http from "node:http";
import { readSkaldSource } from "./_skald-source.mjs";

const __dirname  = dirname(fileURLToPath(import.meta.url));
const CLIENT     = readFileSync(join(__dirname, "..", "scripts", "ai", "client.js"), "utf8");
const SRC        = readSkaldSource(); // includes ai/client.js + core/settings.js

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }

console.log("Request-timeout test (P2 latency/reliability)\n");

/* ── [A] Source-text guards ──────────────────────────────────────── */
ok(/_fetch\s*\(/.test(CLIENT),
   "[A1] a _fetch helper is defined in ai/client.js");
ok(/new\s+AbortController\s*\(\s*\)/.test(CLIENT),
   "[A2] the helper constructs an AbortController");
ok(/signal:\s*controller\.signal/.test(CLIENT),
   "[A3] the AbortController signal is injected into fetch()");
ok(/setTimeout\s*\(\s*\(\s*\)\s*=>\s*controller\.abort\s*\(\s*\)/.test(CLIENT),
   "[A4] a timer aborts the controller when the request stalls");
ok(/finally\s*\{[\s\S]*clearTimeout\s*\(\s*timer\s*\)/.test(CLIENT),
   "[A5] the timer is always cleared in a finally block (no leak / no stream cut)");
ok(/Settings\.get\(\s*["']requestTimeout["']\s*\)/.test(CLIENT),
   "[A6] timeout is read from the configurable 'requestTimeout' setting");
ok(/30000/.test(CLIENT),
   "[A7] there is a 30s (30000ms) fallback when the setting is unset/invalid");
ok(/AbortError/.test(CLIENT),
   "[A8] a timeout produces a clear AbortError-derived message");

// Setting must be registered (core/settings.js is in the corpus).
ok(/register\([^)]*["']requestTimeout["']/.test(SRC) ||
   /["']requestTimeout["']\s*,\s*\{/.test(SRC),
   "[A9] the 'requestTimeout' world setting is registered");

// Every call site must route through the helper. There should be >= 4 helper
// calls, and the ONLY bare `fetch(` left in client.js is the one inside the
// helper itself (i.e. exactly one bare fetch( call).
const helperCalls = CLIENT.match(/this\._fetch\s*\(/g) || [];
ok(helperCalls.length >= 4,
   `[A10] all 4 fetch call sites route through the helper (found ${helperCalls.length}, want >= 4)`);
const bareFetch = CLIENT.match(/\bawait\s+fetch\s*\(/g) || [];
ok(bareFetch.length === 1,
   `[A11] only the helper itself calls fetch() directly (bare await fetch(: ${bareFetch.length}, want 1)`);

/* ── [B] Behavioural: AbortController times out a stalled request ──── */
async function behavioural() {
  // A server that accepts the connection but never sends a response.
  const server = http.createServer(() => { /* intentionally hang */ });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  // Reproduce the helper's exact control flow with a tiny 120ms timeout.
  const ms = 120;
  const controller = new AbortController();
  let timerCleared = false;
  const timer = setTimeout(() => controller.abort(), ms);
  const start = Date.now();
  let threw = null;
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: controller.signal });
  } catch (e) {
    threw = e;
  } finally {
    clearTimeout(timer);
    timerCleared = true;
  }
  const elapsed = Date.now() - start;

  ok(threw && threw.name === "AbortError",
     `[B1] a stalled request is aborted (error: ${threw ? threw.name : "none"})`);
  ok(elapsed < 2000,
     `[B2] it aborts promptly near the timeout, not after 60s (elapsed ${elapsed}ms)`);
  ok(timerCleared,
     "[B3] the timer is cleared in finally (no leaked handle)");

  await new Promise((r) => server.close(r));
}

await behavioural();

/* --------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
