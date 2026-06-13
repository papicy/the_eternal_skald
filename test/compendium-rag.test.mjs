/* =====================================================================
 *  Compendium-aware RAG indexing test for The Eternal Skald (v0.20.0, F1).
 *
 *  F1 lets the GM embed installed compendium packs into semantic memory
 *  ALONGSIDE the living chronicle, so the Skald can recall lore from
 *  modules, bestiaries, oracle tables, etc. It is GM-only, opt-in (the
 *  `ragIndexCompendiums` world setting, default OFF), and adapter-gated
 *  (RollTable/oracle packs are only pulled when the active system adapter
 *  advertises the `oracles` capability). The new `!reindex-compendiums`
 *  command — the module's first GM-permission command — drives it.
 *
 *  Layout mirrors rag-cache.test.mjs:
 *    [A] Source-text guards over scripts/browser-rag.js (read directly,
 *        as this module is excluded from the shared readSkaldSource corpus).
 *    [B] Behavioural proof of the pure _compendiumDocText() extractor across
 *        the common Foundry document shapes (never throws, name-led, HTML
 *        stripped) and of indexCompendiums() no-op / idempotent semantics
 *        against a fake store, with no Foundry runtime present.
 *    [C] Cross-file wiring guards: setting registration, command token,
 *        the "gm" registry descriptor, the command handler, and the i18n key.
 *
 *  Run: node test/compendium-rag.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BrowserRAG } from "../scripts/browser-rag.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = (...p) => join(__dirname, "..", ...p);
const read = (...p) => readFileSync(root(...p), "utf8");

const RAG       = read("scripts", "browser-rag.js");
const SETTINGS  = read("scripts", "core", "settings.js");
const CONSTANTS = read("scripts", "core", "constants.js");
const REGISTRY  = read("scripts", "chat", "command-registry.js");
const COMMANDS  = read("scripts", "chat", "commands.js");
const EN        = JSON.parse(read("lang", "en.json"));

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

console.log("Compendium-aware RAG indexing test (v0.20.0, F1)\n");

/* ── [A] Source guards over browser-rag.js ───────────────────────── */
ok(/indexCompendiumsEnabled\s*\(\s*\)\s*\{[\s\S]*?ragIndexCompendiums/.test(RAG),
   "[A1] indexCompendiumsEnabled() reads the ragIndexCompendiums setting");
ok(/_compendiumDocText\s*\(\s*doc\s*\)\s*\{/.test(RAG),
   "[A2] a pure _compendiumDocText(doc) extractor is defined");
ok(/async\s+indexCompendiums\s*\(\s*packs\s*,/.test(RAG),
   "[A3] async indexCompendiums(packs, opts) is defined");
ok(/if\s*\(\s*!this\.isAvailable\(\)\s*\|\|\s*!this\.indexCompendiumsEnabled\(\)\s*\)\s*return/.test(RAG),
   "[A4] indexCompendiums() no-ops when RAG unavailable or the setting is off");
ok(/comp:\$\{pack\?\.collection/.test(RAG),
   "[A5] compendium records use a namespaced comp:<collection>:<id> key (idempotent, collision-free)");
ok(/type:\s*"compendium"/.test(RAG),
   "[A6] compendium records are tagged metadata.type === 'compendium'");
ok(/this\._invalidateCorpus\(\)/.test(RAG.split("async indexCompendiums")[1] || ""),
   "[A7] indexCompendiums() invalidates the corpus cache when done");
// It must NOT clear the store (compendiums live alongside the chronicle).
ok(!/this\._store\.clear\(\)/.test(RAG.split("async indexCompendiums")[1].split("corpus cache")[0] || ""),
   "[A8] indexCompendiums() never clears the store (additive to the chronicle)");

/* ── [B] Behavioural proof against the real BrowserRAG ───────────── */

// _compendiumDocText is pure and defensive — callable with no Foundry runtime.
eq(BrowserRAG._compendiumDocText(null), "", "[B1] null doc → empty string (never throws)");
eq(BrowserRAG._compendiumDocText({}), "", "[B2] empty doc → empty string");

const jrnl = BrowserRAG._compendiumDocText({
  name: "The Frostfell",
  pages: { contents: [{ text: { content: "<p>A frozen <b>waste</b>.</p>" } },
                      { text: { content: "Home of the wendigo." } }] }
});
ok(jrnl.startsWith("The Frostfell."), "[B3] JournalEntry text is name-led");
ok(jrnl.includes("A frozen waste") && jrnl.includes("Home of the wendigo"),
   "[B4] JournalEntry concatenates every page's text");
ok(!/[<>]/.test(jrnl), "[B5] HTML tags are stripped from the extracted text");

const item = BrowserRAG._compendiumDocText({ name: "Runed Axe", system: { description: { value: "A keen blade." } } });
ok(item.startsWith("Runed Axe.") && item.includes("A keen blade"),
   "[B6] Item system.description.value is extracted");

const strItem = BrowserRAG._compendiumDocText({ name: "Torch", system: { description: "Sheds light." } });
ok(strItem.includes("Sheds light"), "[B7] a plain-string description is also handled");

const table = BrowserRAG._compendiumDocText({
  name: "Oracle: Action", results: { contents: [{ text: "Scheme" }, { text: "Clash" }] }
});
ok(table.includes("Scheme") && table.includes("Clash"),
   "[B8] RollTable result text is extracted (oracle support)");

// indexCompendiums() semantics against a fake store / stubbed gates.
const saved = {
  isAvailable: BrowserRAG.isAvailable,
  indexCompendiumsEnabled: BrowserRAG.indexCompendiumsEnabled,
  init: BrowserRAG.init,
  indexRecord: BrowserRAG.indexRecord,
  _invalidateCorpus: BrowserRAG._invalidateCorpus
};
try {
  // (1) No-op when the opt-in setting is OFF — even if RAG is available.
  BrowserRAG.isAvailable = () => true;
  BrowserRAG.indexCompendiumsEnabled = () => false;
  BrowserRAG.init = async () => true;
  let calls = 0;
  BrowserRAG.indexRecord = async () => { calls++; return true; };
  BrowserRAG._invalidateCorpus = () => {};
  let res = await BrowserRAG.indexCompendiums([{ collection: "x", async getDocuments() { return [{ id: "1", name: "n" }]; } }]);
  eq(res.indexed, 0, "[B9] disabled setting → nothing indexed");
  eq(calls, 0, "[B10] disabled setting → indexRecord never called");

  // (2) When enabled + available, it embeds docs with text and skips empty ones.
  BrowserRAG.indexCompendiumsEnabled = () => true;
  let invalidated = 0;
  BrowserRAG._invalidateCorpus = () => { invalidated++; };
  const seen = [];
  BrowserRAG.indexRecord = async ({ id }) => { seen.push(id); return true; };
  const pack = {
    collection: "world.bestiary", metadata: { label: "Bestiary" },
    async getDocuments() {
      return [
        { id: "a", name: "Wendigo", system: { description: { value: "A gaunt horror." } } },
        { id: "b" } // no name, no prose → empty text → skipped
      ];
    }
  };
  res = await BrowserRAG.indexCompendiums([pack]);
  eq(res.total, 2, "[B11] total counts every document in the pack");
  eq(res.indexed, 1, "[B12] only documents with extractable text are embedded");
  eq(seen[0], "comp:world.bestiary:a", "[B13] record id is namespaced comp:<collection>:<id>");
  ok(invalidated >= 1, "[B14] the corpus cache is invalidated after indexing");

  // (3) A pack whose getDocuments() throws is skipped, not fatal.
  const boom = { collection: "bad", async getDocuments() { throw new Error("load fail"); } };
  res = await BrowserRAG.indexCompendiums([boom, pack]);
  eq(res.indexed, 1, "[B15] a failing pack is skipped; healthy packs still index");
} finally {
  Object.assign(BrowserRAG, saved);
}

/* ── [C] Cross-file wiring guards ────────────────────────────────── */
ok(/register\(\s*MODULE_ID\s*,\s*"ragIndexCompendiums"/.test(SETTINGS),
   "[C1] settings.js registers the ragIndexCompendiums world setting");
ok(/default:\s*false/.test((SETTINGS.split('"ragIndexCompendiums"')[1] || "").slice(0, 400)),
   "[C2] ragIndexCompendiums defaults to false (opt-in)");
ok(/REINDEX_COMPENDIUMS:\s*"!reindex-compendiums"/.test(CONSTANTS),
   "[C3] constants.js defines the !reindex-compendiums command token");
ok(/REINDEX_COMPENDIUMS[\s\S]*?method:\s*"reindexCompendiums"[\s\S]*?permission:\s*"gm"/.test(REGISTRY),
   "[C4] the registry maps the command to reindexCompendiums with permission 'gm'");
ok(/async\s+reindexCompendiums\s*\(/.test(COMMANDS),
   "[C5] commands.js implements the reindexCompendiums handler");
ok(/if\s*\(\s*!game\.user\?\.isGM\s*\)/.test(COMMANDS.split("reindexCompendiums")[1] || ""),
   "[C6] the handler is GM-gated");
ok(EN.ETERNAL_SKALD?.settings?.ragIndexCompendiums?.name &&
   EN.ETERNAL_SKALD?.settings?.ragIndexCompendiums?.hint,
   "[C7] en.json carries the ragIndexCompendiums name + hint i18n keys");

/* ── summary ─────────────────────────────────────────────────────── */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
