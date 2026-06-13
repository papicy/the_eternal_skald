/* =====================================================================
 *  M2 — Command handler registry (v0.20.0)
 *
 *  The hand-maintained dispatch switch was replaced by a declarative registry
 *  (scripts/chat/command-registry.js). This test proves the registry is a
 *  faithful, lossless replacement:
 *    • every COMMANDS token resolves to exactly one descriptor (canonical or
 *      alias) — no command was dropped or double-mapped;
 *    • alias routing matches the old switch (journal/journals, map, wipe,
 *      survey/analyze-map);
 *    • findCommand is case-insensitive and fail-soft on junk input;
 *    • every descriptor carries the required metadata (method, permission, help)
 *      and references a real Commands method (checked against source text);
 *    • dispatchCommand consults the registry and preserves the bare-"!"
 *      fallback + permission gate (source-guard).
 *
 *  command-registry.js is pure ESM (only imports COMMANDS), so we import it
 *  directly; commands.js is Foundry-coupled, so it is checked via source text.
 *
 *  Run: node test/command-registry.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { COMMAND_REGISTRY, findCommand } from "../scripts/chat/command-registry.js";
import { COMMANDS } from "../scripts/core/constants.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const CMD = readFileSync(join(ROOT, "scripts", "chat", "commands.js"), "utf8");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

console.log("M2 — command registry\n");

/* ---- [1] every COMMANDS token resolves -------------------------------- */
const allTokens = Object.values(COMMANDS);
for (const token of allTokens) {
  const desc = findCommand(token);
  ok(!!desc, `[1] token ${token} resolves to a descriptor`);
}
// Upper-case head normalisation (dispatch lower-cases first, but be safe).
ok(findCommand("!SCOUT") && findCommand("!SCOUT").method === "scout", "[1] findCommand is case-insensitive");

/* ---- [2] no command dropped or duplicated ----------------------------- */
const covered = new Set();
for (const d of COMMAND_REGISTRY) {
  for (const t of [d.command, ...d.aliases]) {
    ok(!covered.has(t), `[2] token ${t} is mapped exactly once (no duplicate)`);
    covered.add(t);
  }
}
for (const token of allTokens) {
  ok(covered.has(token), `[2] COMMANDS.${token} is covered by the registry`);
}

/* ---- [3] alias routing matches the old switch ------------------------- */
eq(findCommand(COMMANDS.JOURNAL).method,  "journals",      "[3] !journal → journals");
eq(findCommand(COMMANDS.JOURNALS).method, "journals",      "[3] !journals alias → journals");
eq(findCommand(COMMANDS.MAP).method,      "relationships", "[3] !map → relationships");
eq(findCommand(COMMANDS.RELATIONSHIPS).method, "relationships", "[3] !relationships → relationships");
eq(findCommand(COMMANDS.WIPE).method,     "reset",         "[3] !skald-wipe → reset");
eq(findCommand(COMMANDS.RESET).method,    "reset",         "[3] !skald-reset → reset");
eq(findCommand(COMMANDS.SURVEY).method,   "scout",         "[3] !survey → scout");
eq(findCommand(COMMANDS.ANALYZE_MAP).method, "scout",      "[3] !analyze-map → scout");
eq(findCommand(COMMANDS.HELP).method,     "help",          "[3] !skald-help → help");

/* ---- [4] fail-soft on junk ------------------------------------------- */
eq(findCommand("!nope"), null, "[4] unknown token → null (bare-! fallback handles it)");
eq(findCommand(""), null,      "[4] empty string → null");
eq(findCommand(null), null,    "[4] null → null (never throws)");
eq(findCommand(42), null,      "[4] non-string → null (never throws)");

/* ---- [5] descriptor metadata is complete + valid --------------------- */
for (const d of COMMAND_REGISTRY) {
  ok(typeof d.method === "string" && d.method.length > 0, `[5] ${d.command} has a method name`);
  ok(d.permission === "all" || d.permission === "gm", `[5] ${d.command} has a valid permission`);
  ok(typeof d.help === "string" && d.help.length > 0, `[5] ${d.command} has help text`);
  ok(Array.isArray(d.aliases), `[5] ${d.command} aliases is an array`);
  // the method must actually exist on the Commands object in commands.js
  ok(new RegExp(`\\b(async\\s+)?${d.method}\\s*\\(`).test(CMD), `[5] Commands.${d.method} exists in commands.js`);
}
ok(Object.isFrozen(COMMAND_REGISTRY), "[5] COMMAND_REGISTRY is frozen (immutable)");
// Every command that pre-dates the permission gate stays "all" so dispatch
// behaviour is unchanged; only newly-added GM-only commands use "gm".
const GM_ONLY = new Set([COMMANDS.REINDEX_COMPENDIUMS]);
ok(COMMAND_REGISTRY.filter(d => d.permission === "gm").every(d => GM_ONLY.has(d.command)),
   "[5] only the designated new commands are 'gm' (pre-existing commands unchanged)");
eq(findCommand(COMMANDS.REINDEX_COMPENDIUMS).permission, "gm",
   "[5] !reindex-compendiums is GM-gated at dispatch");
eq(findCommand(COMMANDS.REINDEX).permission, "all", "[5] !reindex stays permission 'all' (unchanged)");

/* ---- [6] dispatch wiring (source-guard) ------------------------------ */
ok(/import\s*\{\s*findCommand\s*\}\s*from\s*["']\.\/command-registry\.js["']/.test(CMD),
   "[6] commands.js imports findCommand from the registry");
ok(/const descriptor = findCommand\(head\)/.test(CMD), "[6] dispatch resolves via findCommand(head)");
ok(/Commands\[descriptor\.method\]\(args\)/.test(CMD), "[6] dispatch invokes Commands[descriptor.method](args)");
ok(/descriptor\.permission === "gm" && !game\.user\?\.isGM/.test(CMD), "[6] dispatch enforces the 'gm' permission gate");
ok(/routing to !skald|Commands\.skald\(query\)/.test(CMD), "[6] bare-\"!\" free-prompt fallback preserved");

/* ---- summary ---------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
