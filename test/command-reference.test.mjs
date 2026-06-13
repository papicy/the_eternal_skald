/* =====================================================================
 *  Interactive command reference test for The Eternal Skald (v0.21.0, Doc1).
 *
 *  The !commands window (ApplicationV2) is built from COMMAND_REGISTRY via
 *  pure helpers (buildCommandEntries / filterCommandEntries / renderReferenceHtml
 *  / escapeRefHtml), which we exercise directly. The ApplicationV2 class itself
 *  is defined lazily (needs the Foundry global) and is covered by wiring guards.
 *
 *    [A] Pure helpers: entries normalised + sorted from the registry, every
 *        registry command present, permission preserved, free-text filtering,
 *        HTML escaping, and rendered markup contains a row + a "Try it" button.
 *    [B] Cross-file wiring guards: !commands token, registry descriptor, the
 *        command handler + graceful help() fallback, and the import.
 *    [C] Node-import safety: importing the UI module without a Foundry global
 *        must NOT throw (the class is lazy) — protects the load-smoke contract.
 *
 *  Run: node test/command-reference.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildCommandEntries, filterCommandEntries, renderReferenceHtml, escapeRefHtml
} from "../scripts/ui/command-reference.js";
import { COMMAND_REGISTRY } from "../scripts/chat/command-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = (...p) => join(__dirname, "..", ...p);
const read = (...p) => readFileSync(root(...p), "utf8");

const CONSTANTS = read("scripts", "core", "constants.js");
const REGISTRY  = read("scripts", "chat", "command-registry.js");
const COMMANDS  = read("scripts", "chat", "commands.js");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

console.log("Interactive command reference test (v0.21.0, Doc1)\n");

/* ── [A] Pure helpers ────────────────────────────────────────────── */
const entries = buildCommandEntries();
ok(entries.length === COMMAND_REGISTRY.length, "one entry per registry command");
ok(entries.every(e => typeof e.command === "string" && e.command.startsWith("!")), "every entry has a !-token");
ok(entries.every(e => e.permission === "all" || e.permission === "gm"), "permission normalised to all|gm");

// sorted ascending by command
const sorted = entries.map(e => e.command);
ok(JSON.stringify(sorted) === JSON.stringify([...sorted].sort((a, b) => a.localeCompare(b))), "entries sorted by command");

// permission preserved for a known GM command
const reindexC = entries.find(e => e.command === "!reindex-compendiums");
ok(reindexC && reindexC.permission === "gm", "GM permission preserved (!reindex-compendiums)");

// the new !commands entry is present
ok(entries.some(e => e.command === "!commands"), "!commands itself is listed");

// filtering
ok(filterCommandEntries(entries, "").length === entries.length, "empty filter returns all");
const oracleOnly = filterCommandEntries(entries, "oracle");
ok(oracleOnly.length >= 1 && oracleOnly.every(e =>
  e.command.includes("oracle") || e.help.toLowerCase().includes("oracle") ||
  e.aliases.some(a => a.toLowerCase().includes("oracle"))), "filter matches command/help/alias");
ok(filterCommandEntries(entries, "zzzznotacommand").length === 0, "non-matching filter returns none");
// alias-based filter (e.g. !map is an alias of !relationships)
ok(filterCommandEntries(entries, "map").some(e => e.aliases.includes("!map")), "filter matches on aliases");

// escaping
eq(escapeRefHtml(`<b>"x"&'y'`), "&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;", "escapeRefHtml escapes HTML metacharacters");

// rendered markup
const html = renderReferenceHtml(entries);
ok(html.includes("es-cmd-search"), "rendered markup has a search box");
ok(html.includes("es-cmd-row"), "rendered markup has command rows");
ok(html.includes("es-cmd-try"), "rendered markup has Try-it buttons");
ok(html.includes('data-command="!commands"'), "rendered rows carry the command token in data-command");

/* ── [B] Cross-file wiring guards ────────────────────────────────── */
ok(/COMMANDS_REF:\s*"!commands"/.test(CONSTANTS), "constants.js defines COMMANDS_REF = !commands");
ok(/COMMANDS\.COMMANDS_REF[\s\S]*method:\s*"commandReference"/.test(REGISTRY), "registry maps !commands → commandReference");
ok(/commandReference\s*\(\s*\)\s*\{/.test(COMMANDS), "commands.js defines the commandReference handler");
ok(/openCommandReference/.test(COMMANDS), "handler calls openCommandReference");
ok(/return this\.help\(\)/.test(COMMANDS), "handler falls back to help() when ApplicationV2 is unavailable");
ok(/import\s*\{\s*openCommandReference\s*\}\s*from\s*"\.\.\/ui\/command-reference\.js"/.test(COMMANDS), "commands.js imports openCommandReference");

/* ── [C] Node-import safety ──────────────────────────────────────── */
// (Reaching this line at all proves the top-level import above did not throw
//  without a Foundry global — the ApplicationV2 subclass must stay lazy.)
ok(typeof buildCommandEntries === "function", "UI module imports cleanly under plain Node (no Foundry global)");

/* ── summary ─────────────────────────────────────────────────────── */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
