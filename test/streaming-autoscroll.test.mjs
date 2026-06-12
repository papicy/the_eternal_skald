/* =====================================================================
 *  Streaming auto-scroll regression test for The Eternal Skald.
 *
 *  Bug: when AI narration starts streaming, the chat log was not scrolled
 *  to reveal the new message, and as tokens streamed in the growing card
 *  was pushed below the visible area. The player could not watch the
 *  narration fill in real time.
 *
 *  Fix (scripts/chat/display.js → callSkaldStreaming): a defensive
 *  `scrollChatToBottom()` helper (ui.chat.scrollBottom) is invoked
 *    1) right after the placeholder ChatMessage.create, and
 *    2) after every successful in-place message.update during streaming.
 *  It no-ops when the chat UI / scrollBottom API is unavailable so headless
 *  contexts and older Foundry builds degrade gracefully.
 *
 *  These are source-text structural guards (matching the project convention,
 *  see streaming-default.test.mjs) plus a tiny behavioural model of the
 *  defensive helper.
 *
 *  Run: node test/streaming-autoscroll.test.mjs
 * ===================================================================== */

import { readSkaldSource } from "./_skald-source.mjs";

const SRC = readSkaldSource();

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }

console.log("Streaming auto-scroll structural test\n");

/* --------------------------------------------------------------------- *
 * [1] A defensive scroll helper exists and uses the Foundry chat API.
 * --------------------------------------------------------------------- */
ok(/function scrollChatToBottom\s*\(/.test(SRC),
   "[1] scrollChatToBottom() helper is defined");
ok(/ui\?\.\s*chat\?\.\s*scrollBottom\?\.\s*\(\)/.test(SRC),
   "[1] helper calls ui?.chat?.scrollBottom?.() defensively");
ok(/scrollChatToBottom[\s\S]*?try\s*\{[\s\S]*?catch/.test(SRC),
   "[1] helper is wrapped in try/catch so it degrades to a no-op");

/* --------------------------------------------------------------------- *
 * [2] The placeholder message is scrolled into view on create.
 * --------------------------------------------------------------------- */
ok(/ChatMessage\.create\(data\);[\s\S]{0,200}?scrollChatToBottom\(\)/.test(SRC),
   "[2] scrollChatToBottom() is called right after the placeholder create");

/* --------------------------------------------------------------------- *
 * [3] The chat keeps scrolling as the streamed message updates in place.
 * --------------------------------------------------------------------- */
ok(/await message\.update\(\{ content: cardHtml \}\);[\s\S]{0,160}?scrollChatToBottom\(\)/.test(SRC),
   "[3] scrollChatToBottom() is called after each successful streaming update");

/* --------------------------------------------------------------------- *
 * [4] Behavioural model: the helper is safe when the API is absent and
 *     fires when it is present.
 * --------------------------------------------------------------------- */
function makeScroller(ui) {
  let calls = 0;
  // Mirrors scrollChatToBottom(): optional-chained + try/catch.
  const scroll = () => { try { ui?.chat?.scrollBottom?.(); calls++; } catch (_e) { /* no-op */ } };
  return { scroll, count: () => calls };
}

// No ui at all → no throw, helper is a safe no-op.
let s = makeScroller(undefined);
let threw = false;
try { s.scroll(); } catch (_e) { threw = true; }
ok(!threw, "[4] helper does not throw when ui is undefined (headless/older Foundry)");

// ui present with scrollBottom → it gets invoked.
let scrolled = 0;
s = makeScroller({ chat: { scrollBottom: () => { scrolled++; } } });
s.scroll();
ok(scrolled === 1, "[4] helper invokes ui.chat.scrollBottom() when available");

// ui.chat present but no scrollBottom → still safe.
s = makeScroller({ chat: {} });
threw = false;
try { s.scroll(); } catch (_e) { threw = true; }
ok(!threw, "[4] helper is safe when ui.chat lacks scrollBottom");

/* --------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
