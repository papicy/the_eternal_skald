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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_PATH  = join(__dirname, "..", "scripts", "eternal-skald.js");
const LANG_PATH = join(__dirname, "..", "lang", "en.json");
const SRC  = readFileSync(SRC_PATH, "utf8");
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
 * [6] _hookMissing treats a 404 or a null response (network error) as a
 *     missing hook.
 * --------------------------------------------------------------------- */
{
  const hm = extractFrom(SRC, "_hookMissing(response)");
  ok(/!response/.test(hm) && /404/.test(hm),
     "[6] _hookMissing returns true for null response or status 404");
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

/* --------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
