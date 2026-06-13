/* =====================================================================
 *  TTS Narrator (Phase E — F7) guard.
 *
 *  Covers the PURE, browser-free helpers of narrative/tts-narrator.js:
 *  extractSpeakableText (HTML/directive/markdown stripping), selectVoice
 *  (name match + fallback), and clampRate (Web Speech legal range). Also
 *  structurally asserts the module is fail-soft (ttsAvailable guards) and
 *  exposes the documented surface. The browser-dependent speak/ wiring paths
 *  are not exercised (no DOM/speechSynthesis in Node) — they are guarded by
 *  ttsAvailable() which returns false here.
 *
 *  tts-narrator.js transitively imports settings.js → the module graph, so
 *  stub the minimal Foundry globals BEFORE the dynamic import, exactly as
 *  load-smoke.mjs / starforged-ruleset.test.mjs do.
 *
 *  Run: node test/tts-narrator.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

for (const name of ["Hooks", "game", "ui", "canvas", "CONFIG", "foundry", "Roll", "ChatMessage", "JournalEntry", "Handlebars", "TextEditor"]) {
  if (globalThis[name] === undefined) globalThis[name] = new Proxy(function () {}, { get: () => globalThis[name], apply: () => undefined, construct: () => ({}) });
}
if (globalThis.document === undefined) globalThis.document = {};
if (globalThis.window === undefined) globalThis.window = globalThis;

const { extractSpeakableText, selectVoice, clampRate, ttsAvailable, TtsNarrator } =
  await import("../scripts/narrative/tts-narrator.js");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }

const SRC = readFileSync(
  fileURLToPath(new URL("../scripts/narrative/tts-narrator.js", import.meta.url)), "utf8");

/* ---- [1] structural / layering guards (this module only) -------------- */
ok(/export function ttsAvailable\s*\(/.test(SRC), "[1] ttsAvailable exported");
ok(/window\.speechSynthesis/.test(SRC), "[1] uses browser-native speechSynthesis");
ok(!/Client\.|client\.chat|fetch\(/.test(SRC), "[1] no AI provider / network calls (narrative layer)");
ok(!/\.create\(|\.update\(|setFlag/.test(SRC), "[1] performs no Foundry document writes");
ok(typeof TtsNarrator === "object" && typeof TtsNarrator.wireNarrateButton === "function",
   "[1] TtsNarrator surface exposes wireNarrateButton");

/* ---- [2] extractSpeakableText ----------------------------------------- */
ok(extractSpeakableText("") === "", "[2] empty -> empty");
ok(extractSpeakableText(null) === "", "[2] non-string -> empty");
ok(extractSpeakableText("<p>Hello <b>world</b></p>") === "Hello world", "[2] strips HTML tags");
ok(extractSpeakableText("Roll now [[EFFECT:wounded]] then rest") === "Roll now then rest",
   "[2] strips [[DIRECTIVE]] tokens");
ok(extractSpeakableText("[[MARK_COMPLETE:vow]]") === "", "[2] directive-only -> empty");
ok(extractSpeakableText("**Bold** and _ital_ and `code`") === "Bold and ital and code",
   "[2] strips markdown emphasis markers");
ok(extractSpeakableText("# Title\n## Sub") === "Title Sub", "[2] strips heading markers + newlines");
ok(extractSpeakableText("Tom &amp; Jerry &lt;3") === "Tom & Jerry <3", "[2] decodes entities");
ok(extractSpeakableText("a    b\n\n c") === "a b c", "[2] collapses whitespace");
ok(extractSpeakableText("<div><span>nest</span> <em>ed</em></div>") === "nest ed",
   "[2] strips nested tags");

/* ---- [3] selectVoice -------------------------------------------------- */
const voices = [{ name: "Daniel" }, { name: "Samantha" }, { name: "Google US English" }];
ok(selectVoice([], "x") === null, "[3] empty list -> null");
ok(selectVoice(null) === null, "[3] non-array -> null");
ok(selectVoice(voices, "Samantha").name === "Samantha", "[3] exact name match");
ok(selectVoice(voices, "samantha").name === "Samantha", "[3] case-insensitive match");
ok(selectVoice(voices, "google").name === "Google US English", "[3] substring match");
ok(selectVoice(voices, "Nonexistent").name === "Daniel", "[3] no match -> first voice");
ok(selectVoice(voices).name === "Daniel", "[3] no preference -> first voice");

/* ---- [4] clampRate ---------------------------------------------------- */
ok(clampRate(1) === 1, "[4] 1 -> 1");
ok(clampRate(0.1) === 0.5, "[4] below min clamps to 0.5");
ok(clampRate(5) === 2, "[4] above max clamps to 2");
ok(clampRate("1.5") === 1.5, "[4] numeric string coerced");
ok(clampRate("abc") === 1, "[4] non-numeric -> default 1");
ok(clampRate(undefined) === 1, "[4] undefined -> default 1");

/* ---- [5] ttsAvailable fail-soft (no real speechSynthesis here) -------- */
ok(ttsAvailable() === false, "[5] ttsAvailable() false in Node (no SpeechSynthesisUtterance)");
ok(TtsNarrator.speak("hi") === false, "[5] speak() fail-soft returns false when unavailable");

console.log(`tts-narrator.test.mjs: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
