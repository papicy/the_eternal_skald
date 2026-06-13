/* =====================================================================
 *  M4 — Externalised prompt templates + loader (v0.20.0)
 *
 *  The large static prompt blocks (persona, rules digest, guidance) were
 *  moved out of prompt-builder.js into /prompts/*.mjs and are pulled back in
 *  through scripts/ai/prompt-loader.js (a build-free, synchronous templating
 *  layer). This test proves:
 *    • the loader loads each named template and is fail-soft on junk;
 *    • {{variable}} interpolation works (and missing vars render as "");
 *    • CONTENT: the loaded templates preserve the exact wording the builder
 *      used to embed inline (durable substring invariants; one-time byte-parity
 *      was verified during the migration), so the refactor changed no prompt text;
 *    • prompt-builder.js now sources these blocks via getPrompt (source-guard).
 *
 *  prompt-loader.js + /prompts/*.mjs are pure ESM (no Foundry), so we import
 *  them directly.
 *
 *  Run: node test/prompt-loader.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PROMPTS, renderTemplate, getPrompt } from "../scripts/ai/prompt-loader.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const BUILDER = readFileSync(join(ROOT, "scripts", "ai", "prompt-builder.js"), "utf8");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg}${a === b ? "" : ` (mismatch)`}`); }

console.log("M4 — prompt loader / externalised templates\n");

/* ---- [1] templates load ----------------------------------------------- */
for (const name of ["persona", "rulesDigest", "guidance"]) {
  ok(typeof PROMPTS[name] === "string" && PROMPTS[name].length > 0, `[1] template '${name}' is loaded and non-empty`);
  ok(typeof getPrompt(name) === "string" && getPrompt(name).length > 0, `[1] getPrompt('${name}') returns it`);
}
ok(Object.isFrozen(PROMPTS), "[1] PROMPTS registry is frozen");
eq(getPrompt("does-not-exist"), "", "[1] unknown template name → '' (fail-soft)");

/* ---- [2] interpolation ------------------------------------------------ */
eq(renderTemplate("Hello {{name}}!", { name: "Skald" }), "Hello Skald!", "[2] basic {{var}} substitution");
eq(renderTemplate("a {{x}} b {{y}}", { x: "1", y: "2" }), "a 1 b 2", "[2] multiple placeholders");
eq(renderTemplate("v={{missing}}", {}), "v=", "[2] missing var → empty string");
eq(renderTemplate("v={{n}}", { n: 0 }), "v=0", "[2] numeric 0 renders (not dropped)");
eq(renderTemplate("{{ spaced }}", { spaced: "ok" }), "ok", "[2] whitespace inside braces tolerated");
eq(renderTemplate("no placeholders", { a: 1 }), "no placeholders", "[2] template without placeholders unchanged");
eq(renderTemplate(null), "", "[2] non-string template → '' (never throws)");
eq(renderTemplate("{{a}}", null), "", "[2] null vars → placeholder cleared (never throws)");
ok(getPrompt("guidance", { intensityNote: "ZZZNOTE" }).includes("ZZZNOTE"), "[2] guidance interpolates {{intensityNote}}");
ok(getPrompt("guidance").includes("{{intensityNote}}"), "[2] raw guidance (no vars) carries the {{intensityNote}} placeholder");
ok(!getPrompt("guidance", { intensityNote: "X" }).includes("{{"), "[2] interpolated guidance has no leftover placeholders");

/* ---- [3] content preserved (durable invariants) -----------------------
 * The externalised templates must carry the exact wording the builder used to
 * embed inline. The one-time byte-for-byte parity against the pre-refactor
 * source was verified during the M4 migration; these durable substring guards
 * protect the wording from silent drift on every subsequent run. */
const persona = getPrompt("persona");
ok(persona.startsWith("You are THE ETERNAL SKALD"), "[3] persona opens with the Skald declaration");
ok(/cadence of a saga-singer/.test(persona) && /honour player agency above all/.test(persona),
   "[3] persona keeps its voice + player-agency clauses");

const rules = getPrompt("rulesDigest");
ok(rules.startsWith("IRONSWORN CORE RULES DIGEST"), "[3] rules digest header preserved");
for (const move of ["Face Danger", "Swear an Iron Vow", "Delve the Depths", "Ritual."]) {
  ok(rules.includes(move), `[3] rules digest still lists the move '${move}'`);
}
ok(/Troublesome \(3 progress\/box\)/.test(rules) && /Epic \(1\/4 box\)/.test(rules),
   "[3] rules digest keeps the vow-rank progress table");

const guidance = getPrompt("guidance", { intensityNote: "NOTE" });
ok(guidance.startsWith("GUIDELINES:"), "[3] guidance header preserved");
ok(/can see the active map/.test(guidance) && /CURRENT\s+SCENE/.test(guidance) && /Visible Locations/.test(guidance),
   "[3] guidance keeps the map / scene-context wording");
ok(/never force them/.test(guidance) && /cinematic, not gratuitous/.test(guidance),
   "[3] guidance keeps the non-forced + cinematic-lens rules");

/* ---- [4] builder sources via the loader (source-guard) ---------------- */
ok(/import\s*\{\s*getPrompt\s*\}\s*from\s*["']\.\/prompt-loader\.js["']/.test(BUILDER), "[4] builder imports getPrompt");
ok(/const rulesDigest = getPrompt\("rulesDigest"\)/.test(BUILDER), "[4] builder loads rulesDigest via loader");
ok(/const persona = getPrompt\("persona"\)/.test(BUILDER), "[4] builder loads persona via loader");
ok(/const guidance = getPrompt\("guidance",\s*\{\s*intensityNote\s*\}\)/.test(BUILDER), "[4] builder loads guidance with intensityNote");

/* ---- summary ---------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
