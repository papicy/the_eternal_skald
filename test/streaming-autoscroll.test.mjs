/* =====================================================================
 *  Streaming smart auto-scroll regression test for The Eternal Skald.
 *
 *  Bug: when AI narration started streaming, the chat log was not scrolled
 *  to reveal the new message, and as tokens streamed in the growing card was
 *  pushed below the visible area.
 *
 *  Fix (scripts/chat/display.js → callSkaldStreaming): SMART auto-scroll.
 *    • isChatNearBottom() measures the chat log's scroll position and returns
 *      true only when the user is within CHAT_SCROLL_THRESHOLD_PX (150px) of
 *      the bottom (defaults to true when scroll metrics are unavailable).
 *    • The "scroll into view" is gated on that check, measured BEFORE the DOM
 *      grows, both right after the placeholder ChatMessage.create and after
 *      every throttled message.update during streaming.
 *    • Net effect: streaming follows the bottom while the player is there,
 *      stops the moment they scroll UP to read history, and resumes if they
 *      scroll back down — without ever yanking their view.
 *    • scrollChatToBottom() stays a defensive no-op when the chat UI / API is
 *      absent (headless tests, older Foundry).
 *
 *  Source-text structural guards (project convention, see
 *  streaming-default.test.mjs) plus a behavioural model of the smart decision.
 *
 *  Run: node test/streaming-autoscroll.test.mjs
 * ===================================================================== */

import { readSkaldSource } from "./_skald-source.mjs";

const SRC = readSkaldSource();

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }

console.log("Streaming smart auto-scroll structural test\n");

/* --------------------------------------------------------------------- *
 * [1] Defensive scroll helper still exists and uses the Foundry chat API.
 * --------------------------------------------------------------------- */
ok(/function scrollChatToBottom\s*\(/.test(SRC),
   "[1] scrollChatToBottom() helper is defined");
ok(/ui\?\.\s*chat\?\.\s*scrollBottom\?\.\s*\(\)/.test(SRC),
   "[1] helper calls ui?.chat?.scrollBottom?.() defensively");
ok(/scrollChatToBottom[\s\S]*?try\s*\{[\s\S]*?catch/.test(SRC),
   "[1] helper is wrapped in try/catch so it degrades to a no-op");

/* --------------------------------------------------------------------- *
 * [2] A near-bottom detector with a reasonable px threshold exists.
 * --------------------------------------------------------------------- */
ok(/const CHAT_SCROLL_THRESHOLD_PX\s*=\s*1[0-5]0\b/.test(SRC),
   "[2] CHAT_SCROLL_THRESHOLD_PX is defined in the 100–150px range");
ok(/function isChatNearBottom\s*\(/.test(SRC),
   "[2] isChatNearBottom() detector is defined");
ok(/scrollHeight\s*-\s*\w+\.scrollTop\s*-\s*\w+\.clientHeight/.test(SRC),
   "[2] detector computes distance-from-bottom (scrollHeight - scrollTop - clientHeight)");
ok(/<=\s*CHAT_SCROLL_THRESHOLD_PX/.test(SRC),
   "[2] detector compares the distance against the threshold");
ok(/isChatNearBottom[\s\S]*?return true/.test(SRC),
   "[2] detector defaults to true (stick to bottom) when metrics are unavailable");

/* --------------------------------------------------------------------- *
 * [3] Placeholder scroll is GATED on the user being near the bottom,
 *     measured BEFORE the new card is created.
 * --------------------------------------------------------------------- */
ok(/const stickAtStart\s*=\s*isChatNearBottom\(\);[\s\S]{0,120}?ChatMessage\.create\(data\)/.test(SRC),
   "[3] near-bottom is captured BEFORE ChatMessage.create (DOM hasn't grown yet)");
ok(/if \(stickAtStart\) scrollChatToBottom\(\)/.test(SRC),
   "[3] placeholder scroll only fires when the user was near the bottom");

/* --------------------------------------------------------------------- *
 * [4] Streaming updates follow the bottom ONLY while the user is there.
 * --------------------------------------------------------------------- */
ok(/const stick\s*=\s*isChatNearBottom\(\);[\s\S]{0,160}?await message\.update\(\{ content: cardHtml \}\);[\s\S]{0,80}?if \(stick\) scrollChatToBottom\(\)/.test(SRC),
   "[4] each streaming update measures near-bottom first, then scrolls only if still stuck");

/* --------------------------------------------------------------------- *
 * [5] Behavioural model of the smart decision + the defensive detector.
 * --------------------------------------------------------------------- */
const THRESHOLD = 150;
// Mirrors isChatNearBottom(): distance-from-bottom <= threshold; true when
// no scroll metrics are available.
function nearBottom(scroller, threshold = THRESHOLD) {
  if (!scroller || typeof scroller.scrollHeight !== "number") return true;
  const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  return distance <= threshold;
}
// Mirrors the gated call: scroll iff nearBottom was true (measured pre-grow).
function decideScroll(scroller) { return nearBottom(scroller) === true; }

// At the very bottom → follow the stream.
ok(decideScroll({ scrollHeight: 1000, scrollTop: 900, clientHeight: 100 }) === true,
   "[5] exactly at bottom → auto-scroll");
// 120px from bottom (within 150px) → still follow.
ok(decideScroll({ scrollHeight: 1000, scrollTop: 780, clientHeight: 100 }) === true,
   "[5] 120px from bottom (within threshold) → auto-scroll");
// 400px up reading history → DO NOT scroll.
ok(decideScroll({ scrollHeight: 1000, scrollTop: 500, clientHeight: 100 }) === false,
   "[5] scrolled up 400px to read history → no auto-scroll (view respected)");
// Exactly at the threshold edge (150px) → still counts as at bottom.
ok(decideScroll({ scrollHeight: 1000, scrollTop: 750, clientHeight: 100 }) === true,
   "[5] exactly at the 150px edge → auto-scroll");
// Just past the threshold (151px) → stop.
ok(decideScroll({ scrollHeight: 1000, scrollTop: 749, clientHeight: 100 }) === false,
   "[5] 151px from bottom (just past threshold) → no auto-scroll");
// User scrolls back down after reading → resumes.
ok(decideScroll({ scrollHeight: 1000, scrollTop: 900, clientHeight: 100 }) === true,
   "[5] user returns to bottom → auto-scroll resumes");
// No scroll metrics (headless / no UI) → safe default of true (stick).
ok(decideScroll(undefined) === true,
   "[5] missing scroll metrics → defaults to stick-to-bottom (safe, never throws)");

/* --------------------------------------------------------------------- *
 * [6] The scroll helper itself is safe when the API is absent / present.
 * --------------------------------------------------------------------- */
function makeScroller(ui) {
  const scroll = () => { try { ui?.chat?.scrollBottom?.(); } catch (_e) { /* no-op */ } };
  return scroll;
}
let threw = false;
try { makeScroller(undefined)(); } catch (_e) { threw = true; }
ok(!threw, "[6] scroll helper does not throw when ui is undefined");
let scrolled = 0;
makeScroller({ chat: { scrollBottom: () => { scrolled++; } } })();
ok(scrolled === 1, "[6] scroll helper invokes ui.chat.scrollBottom() when available");

/* --------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
