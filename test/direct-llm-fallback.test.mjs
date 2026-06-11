/* =====================================================================
 *  Direct browser→AI fallback test for The Eternal Skald (v0.10.12).
 *
 *  v0.10.12 fixes the runtime "/skald-api/chat 404 (Not Found)" failure
 *  seen on hosted/managed Foundry (e.g. "Foundry VTT on Abacus"), where
 *  users cannot start Foundry with the `node --import …` flag the
 *  server-side hook (eternal-skald-server.mjs) requires. Without the hook,
 *  every relative `/skald-api/*` call hits Foundry's own 404 page and the
 *  Skald can never reach the AI.
 *
 *  The fix adds a client-side DIRECT browser→AI path plus a `connectionMode`
 *  setting (auto | server | direct). In `auto` (default), a 404 or network
 *  error from the hook transparently falls back to a direct fetch against the
 *  configured OpenAI-compatible endpoint (the default Abacus AI endpoint
 *  returns permissive CORS headers, so this works from the browser).
 *
 *  These are structural guards over scripts/eternal-skald.js asserting the
 *  fix's invariants. The Client object lives inside an ESM that registers
 *  Foundry hooks at import time, so it can't be imported in isolation; we
 *  assert on the source text instead (same approach as
 *  inline-move-suggestions.test.mjs [B]).
 *
 *  Run: node test/direct-llm-fallback.test.mjs
 * ===================================================================== */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_PATH  = join(__dirname, "..", "scripts", "eternal-skald.js");
const LANG_PATH = join(__dirname, "..", "lang", "en.json");
// (Phase 2 refactor) Settings (and other definitions) were extracted verbatim
// into scripts/core/*.js. Read every core module FIRST, then the main module,
// so these source-text guards still see the relocated definitions (core is
// prepended so any brace-matching extractor keeps trailing code to scan).
const CORE_DIR = join(__dirname, "..", "scripts", "core");
let SRC = "";
try {
  for (const f of readdirSync(CORE_DIR).sort()) {
    if (f.endsWith(".js")) SRC += readFileSync(join(CORE_DIR, f), "utf8") + "\n";
  }
} catch (_) { /* core/ may not exist in older trees */ }
SRC += readFileSync(SRC_PATH, "utf8");
const LANG = JSON.parse(readFileSync(LANG_PATH, "utf8"));

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }

/* Extract a method/function body by brace-matching from a starting marker.
 * Skips past the parameter list first so `= {}` default params in the
 * signature don't prematurely terminate the match. */
function extractFrom(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  // Skip to the close of the parameter list, then to the body's `{`.
  const paramClose = src.indexOf(")", start);
  let i = src.indexOf("{", paramClose);
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

console.log("Direct browser→AI fallback structural test (v0.10.12)\n");

/* --------------------------------------------------------------------- *
 * [1] The connectionMode setting is registered with the three modes.
 * --------------------------------------------------------------------- */
ok(/register\(MODULE_ID,\s*"connectionMode"/.test(SRC),
   "[1] connectionMode setting is registered");
{
  // Scoped, non-greedy match over the connectionMode register(...) call.
  const block = SRC.slice(SRC.indexOf('register(MODULE_ID, "connectionMode"'));
  ok(/auto:/.test(block.slice(0, 600)) && /server:/.test(block.slice(0, 600)) && /direct:/.test(block.slice(0, 600)),
     "[1] connectionMode declares auto/server/direct choices");
  ok(/register\(MODULE_ID, "connectionMode"[\s\S]*?default:\s*"auto"/.test(SRC),
     "[1] connectionMode defaults to 'auto'");
}

/* --------------------------------------------------------------------- *
 * [2] The direct (browser→AI) methods exist and send an Authorization
 *     bearer header straight to the endpoint (NOT the relative API_PATH).
 * --------------------------------------------------------------------- */
ok(/_directChat\s*\(/.test(SRC), "[2] _directChat method exists");
ok(/_directChatStream\s*\(/.test(SRC), "[2] _directChatStream method exists");
{
  const dc = extractFrom(SRC, "async _directChat(");
  ok(/fetch\(endpoint/.test(dc),
     "[2] _directChat fetches the endpoint directly (not API_PATH)");
  ok(/Authorization/.test(dc) && /Bearer \$\{apiKey\}/.test(dc),
     "[2] _directChat sends Authorization: Bearer <apiKey>");
  ok(/stream:\s*false/.test(dc),
     "[2] _directChat forces stream:false");
  ok(/_extractContent/.test(dc),
     "[2] _directChat reuses _extractContent for the reply shape");
}
{
  const dcs = extractFrom(SRC, "async _directChatStream(");
  ok(/fetch\(endpoint/.test(dcs),
     "[2] _directChatStream fetches the endpoint directly");
  ok(/Bearer \$\{apiKey\}/.test(dcs),
     "[2] _directChatStream sends Authorization: Bearer <apiKey>");
  ok(/stream:\s*true/.test(dcs),
     "[2] _directChatStream forces stream:true");
  ok(/_consumeStreamingResponse/.test(dcs),
     "[2] _directChatStream reuses the shared streaming consumer");
}

/* --------------------------------------------------------------------- *
 * [3] The streaming SSE reader was extracted into a shared helper so both
 *     the server-hook and direct paths use one implementation.
 * --------------------------------------------------------------------- */
ok(/_consumeStreamingResponse\s*\(/.test(SRC),
   "[3] _consumeStreamingResponse shared helper exists");
{
  const cs = extractFrom(SRC, "async _consumeStreamingResponse(");
  ok(/text\/event-stream/.test(cs),
     "[3] consumer still checks for text/event-stream content-type");
  ok(/getReader/.test(cs),
     "[3] consumer reads the streaming body");
  ok(/\[DONE\]/.test(cs),
     "[3] consumer handles the SSE [DONE] sentinel");
}

/* --------------------------------------------------------------------- *
 * [4] chat() honours connectionMode: direct goes straight to _directChat,
 *     auto falls back to _directChat on a missing hook.
 * --------------------------------------------------------------------- */
{
  const chat = extractFrom(SRC, "async chat(messages");
  ok(/Settings\.get\("connectionMode"\)/.test(chat),
     "[4] chat() reads connectionMode");
  ok(/mode === "direct"[\s\S]*?_directChat\(/.test(chat),
     "[4] chat() routes direct mode straight to _directChat");
  ok(/_hookMissing\(response\)/.test(chat),
     "[4] chat() detects a missing hook via _hookMissing");
  ok(/mode === "auto"[\s\S]*?_directChat\(/.test(chat),
     "[4] chat() falls back to _directChat in auto mode");
  ok(/_noticeDirectFallback\(\)/.test(chat),
     "[4] chat() posts the one-time fallback notice");
}

/* --------------------------------------------------------------------- *
 * [5] chatStream() honours connectionMode the same way.
 * --------------------------------------------------------------------- */
{
  const cstream = extractFrom(SRC, "async chatStream(messages");
  ok(/Settings\.get\("connectionMode"\)/.test(cstream),
     "[5] chatStream() reads connectionMode");
  ok(/mode === "direct"[\s\S]*?_directChatStream\(/.test(cstream),
     "[5] chatStream() routes direct mode to _directChatStream");
  ok(/mode === "auto"[\s\S]*?_directChatStream\(/.test(cstream),
     "[5] chatStream() falls back to _directChatStream in auto mode");
  ok(/_consumeStreamingResponse\(response/.test(cstream),
     "[5] chatStream() uses the shared consumer for the hook path");
}

/* --------------------------------------------------------------------- *
 * [6] _hookMissing treats a null response (network error), a 404, and the
 *     infrastructure/proxy errors 413/502/503/504 as a missing/unreachable
 *     hook. The 502/503/504/413 cases (v0.10.28) fix the MapVision 502 bug
 *     where a hosted-Foundry reverse proxy answered a large vision POST to the
 *     missing /skald-api route with a 502 Bad Gateway instead of a clean 404.
 * --------------------------------------------------------------------- */
{
  const hm = extractFrom(SRC, "_hookMissing(response)");
  ok(/!response/.test(hm) && /404/.test(hm),
     "[6] _hookMissing returns true for null response or status 404");
  for (const code of [413, 502, 503, 504]) {
    ok(new RegExp(`\\b${code}\\b`).test(hm),
       `[6] _hookMissing recognises status ${code} as hook-unreachable`);
  }

  // Behavioural check: evaluate the real predicate body against sample responses.
  const body = hm.slice(hm.indexOf("{") + 1, hm.lastIndexOf("}"));
  /* eslint-disable no-new-func */
  const hookMissing = new Function("response", body);
  ok(hookMissing(null) === true,          "[6] null response → missing");
  ok(hookMissing({ status: 404 }) === true,  "[6] 404 → missing");
  ok(hookMissing({ status: 502 }) === true,  "[6] 502 → missing (MapVision fix)");
  ok(hookMissing({ status: 503 }) === true,  "[6] 503 → missing");
  ok(hookMissing({ status: 504 }) === true,  "[6] 504 → missing");
  ok(hookMissing({ status: 413 }) === true,  "[6] 413 → missing");
  ok(hookMissing({ status: 200 }) === false, "[6] 200 → present (no false fallback)");
  ok(hookMissing({ status: 400 }) === false, "[6] 400 → present (real error surfaced)");
  ok(hookMissing({ status: 500 }) === false, "[6] 500 → present (real upstream error surfaced)");
}

/* --------------------------------------------------------------------- *
 * [7] Localization strings for the new setting + notice exist.
 * --------------------------------------------------------------------- */
{
  const s = LANG?.ETERNAL_SKALD?.settings?.connectionMode;
  ok(!!s && !!s.name && !!s.hint, "[7] connectionMode setting has name + hint");
  ok(!!s?.choices?.auto && !!s?.choices?.server && !!s?.choices?.direct,
     "[7] connectionMode has all three choice labels");
  ok(!!LANG?.ETERNAL_SKALD?.notifications?.directFallback,
     "[7] directFallback notification string exists");
}

/* --------------------------------------------------------------------- *
 * [8] (v0.10.30) Session-sticky direct fallback. Once an auto-mode call
 *     finds the hook dead, the Skald latches `_hookKnownDead` and later
 *     calls skip the doomed proxy POST, going straight to direct. This fixes
 *     `!scout` still stalling on hosted Foundry: each of a scout's several
 *     vision passes re-probed the hook and waited out another slow 502.
 * --------------------------------------------------------------------- */
{
  ok(/_hookKnownDead/.test(SRC), "[8] _hookKnownDead session flag exists");

  // _noticeDirectFallback latches the flag (so all four fallback branches set it).
  const ndf = extractFrom(SRC, "_noticeDirectFallback()");
  ok(/this\._hookKnownDead\s*=\s*true/.test(ndf),
     "[8] _noticeDirectFallback latches _hookKnownDead = true");

  // chat() short-circuits to _directChat when the hook is known dead.
  const chat = extractFrom(SRC, "async chat(messages");
  ok(/mode === "auto"\s*&&\s*this\._hookKnownDead[\s\S]*?_directChat\(/.test(chat),
     "[8] chat() skips the proxy and goes direct once hook is known dead");
  // The short-circuit must come BEFORE the proxy fetch(API_PATH) in chat().
  ok(chat.indexOf("this._hookKnownDead") < chat.indexOf("fetch(API_PATH"),
     "[8] chat() short-circuit precedes the proxy fetch(API_PATH)");

  // chatStream() does the same for the streaming path.
  const cstream = extractFrom(SRC, "async chatStream(messages");
  ok(/mode === "auto"\s*&&\s*this\._hookKnownDead[\s\S]*?_directChatStream\(/.test(cstream),
     "[8] chatStream() skips the proxy once hook is known dead");
  ok(cstream.indexOf("this._hookKnownDead") < cstream.indexOf("fetch(STREAM_PATH"),
     "[8] chatStream() short-circuit precedes the proxy fetch(STREAM_PATH)");

  // Behavioural: a single scout = N passes should hit the proxy at most ONCE.
  // Model the decision the way chat() does for auto mode.
  let proxyHits = 0, directHits = 0, hookKnownDead = false;
  const PROXY_DEAD = true; // simulate the hosted-Foundry 502 hook
  function simulateAutoCall() {
    if (hookKnownDead) { directHits++; return; }      // v0.10.30 short-circuit
    proxyHits++;                                       // probe the proxy
    if (PROXY_DEAD) { hookKnownDead = true; directHits++; } // 502 → latch + fallback
  }
  // One scout fires an overview pass + 4 grid-section passes = 5 calls.
  for (let i = 0; i < 5; i++) simulateAutoCall();
  ok(proxyHits === 1,
     `[8] only the first pass probes the dead proxy (got ${proxyHits}, want 1)`);
  ok(directHits === 5,
     `[8] all 5 passes still reach the AI directly (got ${directHits}, want 5)`);
}

/* --------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
