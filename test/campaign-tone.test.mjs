/* =====================================================================
 *  F2 — Campaign Genre / Tone (v0.20.0)
 *
 *  Two layers, matching the project's convention:
 *    • Structural source-guards: the two world settings are registered, the
 *      i18n keys exist, and prompt-builder injects a toneBlock into the
 *      system-prompt array (right after the persona guidance).
 *    • Behavioural: TONE_DIRECTIVES is a pure exported map, so we exercise it
 *      directly, and we re-run the (tiny, pure) tone-selection logic lifted
 *      from prompt-builder to prove default → no injection, each preset → its
 *      directive, and custom → free-text (blank custom → nothing).
 *
 *  Run: node test/campaign-tone.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readSkaldSource } from "./_skald-source.mjs";
import { TONE_DIRECTIVES } from "../scripts/core/constants.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

console.log("F2 — Campaign genre / tone\n");

const SRC = readSkaldSource();
const EN = JSON.parse(readFileSync(join(ROOT, "lang", "en.json"), "utf8"));

/* ---- [1] structural wiring -------------------------------------------- */
ok(/game\.settings\.register\(MODULE_ID,\s*["']narrativeTone["']/.test(SRC),
   "[1] settings registers the narrativeTone world setting");
ok(/game\.settings\.register\(MODULE_ID,\s*["']narrativeToneCustom["']/.test(SRC),
   "[1] settings registers the narrativeToneCustom free-text setting");
ok(/default:\s*"default"/.test(SRC),
   "[1] narrativeTone defaults to 'default' (no injection — backward compatible)");
ok(/export const TONE_DIRECTIVES\s*=\s*Object\.freeze\(/.test(SRC),
   "[1] TONE_DIRECTIVES is an exported frozen map");
ok(/toneBlock/.test(SRC) && /\[persona, rulesDigest, guidance, toneBlock,/.test(SRC),
   "[1] prompt-builder inserts toneBlock into the system-prompt array after guidance");
ok(/Settings\.get\(["']narrativeTone["']\)/.test(SRC),
   "[1] prompt-builder reads the narrativeTone setting");
ok(/Settings\.get\(["']narrativeToneCustom["']\)/.test(SRC),
   "[1] prompt-builder reads the narrativeToneCustom setting for the custom path");

/* ---- [2] i18n keys ---------------------------------------------------- */
const s = EN.ETERNAL_SKALD.settings;
ok(s.narrativeTone && s.narrativeTone.name && s.narrativeTone.hint, "[2] narrativeTone name+hint present");
ok(s.narrativeToneCustom && s.narrativeToneCustom.name && s.narrativeToneCustom.hint, "[2] narrativeToneCustom name+hint present");
for (const k of ["default", "epic", "dark", "lighthearted", "horror", "custom"]) {
  ok(typeof s.narrativeTone.choices[k] === "string" && s.narrativeTone.choices[k].length > 0,
     `[2] narrativeTone choice label '${k}' present`);
}

/* ---- [3] TONE_DIRECTIVES map content ---------------------------------- */
eq(TONE_DIRECTIVES.default, "", "[3] default directive is empty (signature voice unchanged)");
ok(Object.isFrozen(TONE_DIRECTIVES), "[3] TONE_DIRECTIVES is frozen (immutable)");
for (const k of ["epic", "dark", "lighthearted", "horror"]) {
  ok(typeof TONE_DIRECTIVES[k] === "string" && TONE_DIRECTIVES[k].length > 20,
     `[3] '${k}' directive is a non-trivial paragraph`);
  ok(/CAMPAIGN TONE/.test(TONE_DIRECTIVES[k]),
     `[3] '${k}' directive is clearly labelled as a campaign-tone instruction`);
}
ok(!("custom" in TONE_DIRECTIVES), "[3] map has no 'custom' key (free-text handled by setting)");

/* ---- [4] behavioural: tone-selection logic ---------------------------- */
// Pure re-implementation of the toneBlock selector inside prompt-builder,
// driven by a stubbed Settings.get — proves the wiring contract.
function selectTone(settings) {
  try {
    const tone = settings.narrativeTone || "default";
    if (tone === "custom") {
      const custom = settings.narrativeToneCustom;
      return (typeof custom === "string" && custom.trim()) ? custom.trim() : "";
    }
    return TONE_DIRECTIVES[tone] || "";
  } catch (_) { return ""; }
}

eq(selectTone({ narrativeTone: "default" }), "", "[4] default → no injection");
eq(selectTone({}), "", "[4] unset tone → no injection");
eq(selectTone({ narrativeTone: "epic" }), TONE_DIRECTIVES.epic, "[4] epic → epic directive");
eq(selectTone({ narrativeTone: "dark" }), TONE_DIRECTIVES.dark, "[4] dark → dark directive");
eq(selectTone({ narrativeTone: "lighthearted" }), TONE_DIRECTIVES.lighthearted, "[4] lighthearted → lighthearted directive");
eq(selectTone({ narrativeTone: "horror" }), TONE_DIRECTIVES.horror, "[4] horror → horror directive");
eq(selectTone({ narrativeTone: "custom", narrativeToneCustom: "  Speak only in riddles.  " }),
   "Speak only in riddles.", "[4] custom → trimmed free-text directive");
eq(selectTone({ narrativeTone: "custom", narrativeToneCustom: "   " }), "",
   "[4] custom with blank free-text → no injection");
eq(selectTone({ narrativeTone: "custom" }), "", "[4] custom with missing free-text → no injection");
eq(selectTone({ narrativeTone: "nonsense" }), "", "[4] unknown tone key → no injection (fail-soft)");

/* ---- summary ---------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
