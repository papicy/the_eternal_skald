/* =====================================================================
 *  Narration & story RAG indexing test for The Eternal Skald (v0.25.0).
 *
 *  v0.25.0 extends browser-RAG so the unfolding STORY can be embedded into
 *  semantic memory: AI-generated Skald story cards and player in-character
 *  (IC/EMOTE) narration. It is opt-in (`ragIndexNarration`, default OFF) and
 *  story-only by design — OOC, dice rolls, system/help/error/suggest cards,
 *  slash-commands and whispers are categorically excluded by the classifier.
 *
 *  Layout mirrors compendium-rag.test.mjs:
 *    [A] Source-text guards over scripts/browser-rag.js (read directly).
 *    [B] Behavioural proof of the pure helpers _aiStoryCard() and
 *        _chatStyles() — testable with no Foundry runtime present.
 *    [C] Cross-file wiring: setting registration, hook wiring, i18n keys.
 *
 *  Run: node test/narration-rag.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BrowserRAG } from "../scripts/browser-rag.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = (...p) => join(__dirname, "..", ...p);
const read = (...p) => readFileSync(root(...p), "utf8");

const RAG      = read("scripts", "browser-rag.js");
const SETTINGS = read("scripts", "core", "settings.js");
const HOOKS    = read("scripts", "hooks", "foundry-hooks.js");
const EN       = JSON.parse(read("lang", "en.json"));

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

console.log("Narration & story RAG indexing test (v0.25.0)\n");

/* --------------------------------------------------------------------- *
 * [A] Source-text guards over scripts/browser-rag.js
 * --------------------------------------------------------------------- */
ok(/indexNarration\s*\(/.test(RAG),            "[A] browser-rag defines indexNarration()");
ok(/prepareNarrationRecord\s*\(/.test(RAG),    "[A] browser-rag defines prepareNarrationRecord()");
ok(/_drainNarrationQueue\s*\(/.test(RAG),      "[A] browser-rag defines _drainNarrationQueue()");
ok(/_enforceNarrationRetention\s*\(/.test(RAG),"[A] browser-rag defines _enforceNarrationRetention()");
ok(/embedBatch\s*\(/.test(RAG),                "[A] browser-rag defines embedBatch()");
ok(/indexNarrationEnabled\s*\(/.test(RAG),     "[A] browser-rag defines indexNarrationEnabled()");
ok(/id:\s*`narration:\$\{/.test(RAG),          "[A] narration records are keyed narration:${id}");
ok(/type:\s*"narration"/.test(RAG),            "[A] narration records are tagged type:'narration'");
// Story-only: the classifier rejects rolls and whispers, requires an actor.
ok(/message\.rolls\?\.length/.test(RAG),       "[A] classifier rejects dice rolls");
ok(/message\.whisper/.test(RAG),               "[A] classifier rejects whispers");
ok(/message\.speaker\?\.actor/.test(RAG),      "[A] classifier requires a speaker actor for player narration");
ok(/requestIdleCallback/.test(RAG),            "[A] drain is scheduled off the hot path (idle callback)");

/* --------------------------------------------------------------------- *
 * [B] Behavioural proof of the pure helpers (no Foundry runtime needed).
 * --------------------------------------------------------------------- */
const MID = "the-eternal-skald";

// _chatStyles() falls back to the canonical enum when CONST is absent.
const styles = BrowserRAG._chatStyles();
eq(styles.OOC, 1,   "[B] _chatStyles OOC=1 (fallback enum)");
eq(styles.IC, 2,    "[B] _chatStyles IC=2 (fallback enum)");
eq(styles.EMOTE, 3, "[B] _chatStyles EMOTE=3 (fallback enum)");

// _aiStoryCard(): explicit story flag wins.
eq(BrowserRAG._aiStoryCard({ flags: { [MID]: { story: true } } }), true,
   "[B] _aiStoryCard true on explicit story:true");
eq(BrowserRAG._aiStoryCard({ flags: { [MID]: { story: false, variant: "lore" } } }), false,
   "[B] _aiStoryCard false on explicit story:false (overrides variant)");
// Not one of our cards.
eq(BrowserRAG._aiStoryCard({ flags: {} }), null,
   "[B] _aiStoryCard null when not a Skald card");
// Variant allow-list (legacy fallback) admits story variants...
for (const v of ["default", "lore", "npc", "oracle", "scene", "combat"]) {
  eq(BrowserRAG._aiStoryCard({ flags: { [MID]: { variant: v } } }), true,
     `[B] _aiStoryCard admits story variant '${v}'`);
}
// ...and rejects meta/UI variants.
for (const v of ["help", "error", "suggest"]) {
  eq(BrowserRAG._aiStoryCard({ flags: { [MID]: { variant: v } } }), false,
     `[B] _aiStoryCard rejects meta variant '${v}'`);
}

// prepareNarrationRecord never throws on junk input (returns null fail-soft).
eq(BrowserRAG.prepareNarrationRecord(null), null, "[B] prepareNarrationRecord(null) → null");
eq(BrowserRAG.prepareNarrationRecord({}), null,   "[B] prepareNarrationRecord({}) → null");

/* --------------------------------------------------------------------- *
 * [C] Cross-file wiring: settings, hooks, i18n.
 * --------------------------------------------------------------------- */
for (const key of [
  "ragIndexNarration", "ragNarrationSources", "ragNarrationIncludeEmotes",
  "ragNarrationMinChars", "ragNarrationMaxRecords"
]) {
  ok(SETTINGS.includes(`"${key}"`), `[C] settings.js registers ${key}`);
  ok(!!EN?.ETERNAL_SKALD?.settings?.[key]?.name, `[C] lang/en.json has ${key}.name`);
  ok(!!EN?.ETERNAL_SKALD?.settings?.[key]?.hint, `[C] lang/en.json has ${key}.hint`);
}
// Default: opt-in (registered with default:false).
ok(/"ragIndexNarration"[\s\S]*?default:\s*false/.test(SETTINGS),
   "[C] ragIndexNarration defaults to false (opt-in)");

// Hooks: enqueue on create/update, evict on delete.
ok(/Hooks\.on\("createChatMessage"[\s\S]*?indexNarration/.test(HOOKS),
   "[C] foundry-hooks wires createChatMessage → indexNarration");
ok(/Hooks\.on\("updateChatMessage"[\s\S]*?indexNarration/.test(HOOKS),
   "[C] foundry-hooks wires updateChatMessage → indexNarration");
ok(/Hooks\.on\("deleteChatMessage"[\s\S]*?narration:\$\{/.test(HOOKS),
   "[C] foundry-hooks wires deleteChatMessage → remove(narration:${id})");

/* --------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
