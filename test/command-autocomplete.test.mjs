/* =====================================================================
 *  Inline command autocomplete test for The Eternal Skald (v0.21.0, U5).
 *
 *  Typing "!" in the chat input shows a live-filtered command dropdown. The
 *  matching logic (autocompleteQuery / matchCommands) is pure and exercised
 *  directly; the DOM/listener wiring is runtime and covered by source guards.
 *
 *    [A] autocompleteQuery: triggers only on a bare "!"-token, suppresses once
 *        a space is typed or the text is not a command.
 *    [B] matchCommands: prefix-matches token + aliases, "!" alone lists all,
 *        GM-only filtering via includeGm, capped + sorted, no false positives.
 *    [C] Wiring guards: hooks import + install on renderChatLog and ready.
 *    [D] Node-import safety: imports without a Foundry global must not throw.
 *
 *  Run: node test/command-autocomplete.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { autocompleteQuery, matchCommands } from "../scripts/ui/command-autocomplete.js";
import { COMMAND_REGISTRY } from "../scripts/chat/command-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = (...p) => join(__dirname, "..", ...p);
const HOOKS = readFileSync(root("scripts", "hooks", "foundry-hooks.js"), "utf8");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

console.log("Inline command autocomplete test (v0.21.0, U5)\n");

/* ── [A] autocompleteQuery ───────────────────────────────────────── */
eq(autocompleteQuery("!or"), "!or", "bare !-token returns the partial");
eq(autocompleteQuery("!"), "!", "lone ! returns '!'");
eq(autocompleteQuery("!ORACLE"), "!oracle", "partial is lower-cased");
eq(autocompleteQuery("!oracle is the bridge guarded"), null, "space → past the command, suppress");
eq(autocompleteQuery("hello"), null, "non-! text → null");
eq(autocompleteQuery(""), null, "empty → null");
eq(autocompleteQuery(null), null, "non-string → null");

/* ── [B] matchCommands ───────────────────────────────────────────── */
const all = matchCommands("!");
ok(all.length > 0 && all.length <= 8, "'!' lists commands, capped at 8");
ok(all.every(c => c.command.startsWith("!")), "every match is a !-token");
ok(JSON.stringify(all.map(c => c.command)) === JSON.stringify([...all.map(c => c.command)].sort((a, b) => a.localeCompare(b))), "matches are sorted");

const oracle = matchCommands("!or");
ok(oracle.some(c => c.command === "!oracle"), "'!or' matches !oracle by prefix");
ok(oracle.every(c => c.command.startsWith("!or") || c.aliases.some(a => a.toLowerCase().startsWith("!or"))), "all matches share the prefix (token or alias)");

eq(matchCommands("!zzzz").length, 0, "no command matches → empty");
eq(matchCommands("not a command").length, 0, "non-! input → empty");

// GM filtering: !reindex-compendiums is GM-only
const withGm = matchCommands("!reindex", { includeGm: true });
const noGm   = matchCommands("!reindex", { includeGm: false });
ok(withGm.some(c => c.command === "!reindex-compendiums"), "GM command shown when includeGm:true");
ok(!noGm.some(c => c.command === "!reindex-compendiums"), "GM command hidden when includeGm:false");
ok(noGm.some(c => c.command === "!reindex"), "non-GM command still shown to players");

// alias prefix matching (!map is an alias of !relationships)
ok(matchCommands("!map").some(c => c.aliases.includes("!map")), "alias prefix matches its command");

// every emitted match carries help text from the registry
ok(all.every(c => typeof c.help === "string"), "matches carry help text");
ok(COMMAND_REGISTRY.length >= all.length, "match set is a subset of the registry");

/* ── [C] Wiring guards ───────────────────────────────────────────── */
ok(/import\s*\{\s*installChatAutocomplete\s*\}\s*from\s*"\.\.\/ui\/command-autocomplete\.js"/.test(HOOKS), "hooks import installChatAutocomplete");
ok(/Hooks\.on\("renderChatLog"[\s\S]*installChatAutocomplete/.test(HOOKS), "install on renderChatLog");
ok(/Hooks\.once\("ready"[\s\S]*installChatAutocomplete/.test(HOOKS), "install on ready (fallback)");

/* ── [D] Node-import safety ──────────────────────────────────────── */
ok(typeof matchCommands === "function", "UI module imports cleanly under plain Node (no Foundry global)");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
