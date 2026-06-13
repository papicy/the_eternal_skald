/* =====================================================================
 *  Session recap & Markdown export test for The Eternal Skald (v0.20.0, F3).
 *
 *  !session-recap composes an AI-authored recap of recent chronicle
 *  entries and downloads it as a clean Markdown file. RecapExport owns the
 *  pure Markdown assembly (buildMarkdown / slugify), so we exercise it
 *  directly; the AI call + download are environment-bound and covered only
 *  by source/wiring guards.
 *
 *    [A] Behavioural proof of RecapExport.buildMarkdown / slugify — plain
 *        and Obsidian-flavoured (YAML frontmatter + [[wikilinks]]),
 *        defensive fallbacks, filename slugging.
 *    [B] Cross-file wiring guards: command token, registry descriptor,
 *        the command handler, the opt-in setting (+ default false), i18n.
 *
 *  Run: node test/session-recap.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RecapExport } from "../scripts/chronicle/recap-export.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = (...p) => join(__dirname, "..", ...p);
const read = (...p) => readFileSync(root(...p), "utf8");

const CONSTANTS = read("scripts", "core", "constants.js");
const REGISTRY  = read("scripts", "chat", "command-registry.js");
const COMMANDS  = read("scripts", "chat", "commands.js");
const SETTINGS  = read("scripts", "core", "settings.js");
const EN        = JSON.parse(read("lang", "en.json"));

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

console.log("Session recap & Markdown export test (v0.20.0, F3)\n");

/* ── [A] RecapExport pure behaviour ──────────────────────────────── */
const date = new Date("2026-06-13T10:00:00Z");

// Plain Markdown: no frontmatter, no wikilink section, has H1 title + body.
const plain = RecapExport.buildMarkdown({
  title: "Session Recap", body: "## What Happened\nThe heroes sailed north.",
  entities: ["Captain Reeves"], date, obsidian: false
});
ok(!plain.startsWith("---"), "[A1] plain export has NO YAML frontmatter");
ok(plain.includes("# Session Recap"), "[A2] plain export has an H1 title");
ok(plain.includes("The heroes sailed north"), "[A3] plain export carries the recap body");
ok(!plain.includes("[["), "[A4] plain export has no wikilinks");
ok(plain.includes("2026-06-13"), "[A5] export stamps the ISO date");

// Obsidian flavour: frontmatter + tags + Linked Entities wikilinks.
const obs = RecapExport.buildMarkdown({
  title: "Session Recap", body: "## What Happened\nThe heroes sailed north.",
  entities: ["Captain Reeves", "Frostfell", "Captain Reeves"], date, obsidian: true
});
ok(obs.startsWith("---\n"), "[A6] Obsidian export opens with YAML frontmatter");
ok(/title:\s*"Session Recap"/.test(obs), "[A7] frontmatter carries the title");
ok(/tags:\s*\[eternal-skald, session-recap\]/.test(obs), "[A8] frontmatter carries tags");
ok(obs.includes("## Linked Entities"), "[A9] Obsidian export adds a Linked Entities section");
ok(obs.includes("[[Captain Reeves]]") && obs.includes("[[Frostfell]]"),
   "[A10] entities become [[wikilinks]]");
eq((obs.match(/\[\[Captain Reeves\]\]/g) || []).length, 1,
   "[A11] duplicate entity names are de-duplicated");

// Defensive fallbacks.
const empty = RecapExport.buildMarkdown({ title: "X", body: "", entities: [], obsidian: false });
ok(empty.includes("No events were recorded"), "[A12] empty body → graceful placeholder");
const naked = RecapExport.buildMarkdown({});
ok(naked.includes("# Session Recap"), "[A13] missing options → safe defaults (never throws)");

// slugify → filesystem-safe.
eq(RecapExport.slugify("Session Recap — 6/13/2026"), "session-recap-6-13-2026",
   "[A14] slugify lowercases + replaces unsafe chars with hyphens");
eq(RecapExport.slugify(""), "session-recap", "[A15] slugify falls back for empty input");

/* ── [B] Cross-file wiring guards ────────────────────────────────── */
ok(/SESSION_RECAP:\s*"!session-recap"/.test(CONSTANTS),
   "[B1] constants.js defines the !session-recap command token");
ok(/SESSION_RECAP[\s\S]*?method:\s*"sessionRecap"[\s\S]*?permission:\s*"all"/.test(REGISTRY),
   "[B2] the registry maps the command to sessionRecap (permission 'all')");
ok(/async\s+sessionRecap\s*\(/.test(COMMANDS),
   "[B3] commands.js implements the sessionRecap handler");
ok(/RecapExport\.buildMarkdown\(/.test(COMMANDS) && /RecapExport\.download\(/.test(COMMANDS),
   "[B4] the handler builds + downloads Markdown via RecapExport");
ok(/import\s*\{\s*RecapExport\s*\}\s*from\s*"\.\.\/chronicle\/recap-export\.js"/.test(COMMANDS),
   "[B5] commands.js imports RecapExport");
ok(/register\(\s*MODULE_ID\s*,\s*"recapObsidianFormat"/.test(SETTINGS),
   "[B6] settings.js registers the recapObsidianFormat world setting");
ok(/default:\s*false/.test((SETTINGS.split('"recapObsidianFormat"')[1] || "").slice(0, 400)),
   "[B7] recapObsidianFormat defaults to false (opt-in)");
ok(EN.ETERNAL_SKALD?.settings?.recapObsidianFormat?.name &&
   EN.ETERNAL_SKALD?.settings?.recapObsidianFormat?.hint,
   "[B8] en.json carries the recapObsidianFormat i18n keys");

/* ── summary ─────────────────────────────────────────────────────── */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
