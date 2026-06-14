/* =====================================================================
 *  Embedding-model SELECTION test for The Eternal Skald (v0.21.0).
 *
 *  The browser-RAG embedder used to hardcode a single model id + dimension.
 *  This change turns the model into a GM-selectable setting backed by a pure
 *  catalogue (scripts/core/embedding-catalogue.js), with:
 *    • IndexedDB v1→v2 + a `meta` store recording which model built the store,
 *    • dimension-mismatch detection (a stale-dim vector is skipped at search),
 *    • a confirm-then-auto-reindex flow on model switch (Commands.switchEmbedModel),
 *    • a lazy transformers.js v3 loader (v2.x stays the default path),
 *    • WebGPU capability detection → "(slow on this device)" dropdown hint,
 *    • query/passage instruction prefixes for BGE/Nomic.
 *
 *  Four halves (mirrors rag-cache.test.mjs / request-timeout.test.mjs):
 *    [A] Pure-catalogue behaviour — import the catalogue module and assert its
 *        data + helpers (dims, tfjsMajor, prefixes, choices/WebGPU hint).
 *    [B] Source-text guards over scripts/browser-rag.js (excluded from the
 *        shared corpus, so read directly): DB v2 + meta store, lazy loader,
 *        active-model accessors, role-aware embed, per-record dims filter.
 *    [C] Source-text guards over the shared refactored corpus: the
 *        `ragEmbedModel` + hidden `ragEmbedModelActive` settings are
 *        registered, and Commands.switchEmbedModel is wired with confirm +
 *        reindex + revert.
 *    [D] Behavioural proof against the real BrowserRAG with a fake meta store:
 *        setActiveModel / storedModelId round-trip, resetEmbedder clears the
 *        loaded model, and the dims filter drops mismatched vectors.
 *
 *  Run: node test/embed-model-select.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readSkaldSource } from "./_skald-source.mjs";
import {
  EMBED_MODELS, DEFAULT_EMBED_MODEL,
  modelInfo, dimsFor, tfjsMajorFor, isKnownModel,
  applyPrefix, buildEmbedModelChoices
} from "../scripts/core/embedding-catalogue.js";
import { BrowserRAG } from "../scripts/browser-rag.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAG    = readFileSync(join(__dirname, "..", "scripts", "browser-rag.js"), "utf8");
const SOURCE = readSkaldSource();

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

console.log("Embedding-model selection test (v0.21.0)\n");

/* ── [A] Pure catalogue ──────────────────────────────────────────── */
eq(DEFAULT_EMBED_MODEL, "Xenova/all-MiniLM-L6-v2", "[A1] default model is MiniLM (backwards compatible)");
eq(dimsFor(DEFAULT_EMBED_MODEL), 384, "[A2] default model is 384-dim");
eq(tfjsMajorFor(DEFAULT_EMBED_MODEL), 2, "[A3] default model loads on transformers.js v2.x");

// All five approved models exist with the agreed dims / tfjs majors.
eq(dimsFor("Xenova/bge-small-en-v1.5"), 384, "[A4] BGE-small is 384-dim");
eq(dimsFor("Supabase/gte-small"), 384, "[A5] GTE-small (Supabase) is 384-dim");
eq(dimsFor("Alibaba-NLP/gte-small-en-v1.5"), 384, "[A6] GTE-small-en-v1.5 is 384-dim");
eq(dimsFor("nomic-ai/nomic-embed-text-v1.5"), 768, "[A7] Nomic Embed v1.5 is 768-dim");
eq(tfjsMajorFor("Alibaba-NLP/gte-small-en-v1.5"), 3, "[A8] GTE-v1.5 requires transformers.js v3");
eq(tfjsMajorFor("nomic-ai/nomic-embed-text-v1.5"), 3, "[A9] Nomic requires transformers.js v3");
eq(Object.keys(EMBED_MODELS).length, 5, "[A10] catalogue carries exactly the five approved models");
ok(Object.isFrozen(EMBED_MODELS), "[A11] catalogue is frozen (immutable)");

// modelInfo() falls back to the default for unknown ids and never throws.
eq(modelInfo("does/not-exist").dims, 384, "[A12] modelInfo() falls back to the default for unknown ids");
ok(!isKnownModel("does/not-exist"), "[A13] isKnownModel() rejects unknown ids");
ok(isKnownModel("nomic-ai/nomic-embed-text-v1.5"), "[A14] isKnownModel() accepts a catalogue id");

// applyPrefix(): instruction prefixes only for models that declare them.
eq(applyPrefix("hi", "query", modelInfo(DEFAULT_EMBED_MODEL)), "hi",
   "[A15] MiniLM has no query prefix (byte-identical behaviour)");
eq(applyPrefix("hi", "passage", modelInfo(DEFAULT_EMBED_MODEL)), "hi",
   "[A16] MiniLM has no passage prefix");
ok(applyPrefix("hi", "query", modelInfo("Xenova/bge-small-en-v1.5")).startsWith("Represent this sentence"),
   "[A17] BGE applies its query instruction prefix");
eq(applyPrefix("hi", "passage", modelInfo("Xenova/bge-small-en-v1.5")), "hi",
   "[A18] BGE leaves passages unprefixed");
eq(applyPrefix("hi", "query", modelInfo("nomic-ai/nomic-embed-text-v1.5")), "search_query: hi",
   "[A19] Nomic applies its search_query prefix");
eq(applyPrefix("hi", "passage", modelInfo("nomic-ai/nomic-embed-text-v1.5")), "search_document: hi",
   "[A20] Nomic applies its search_document prefix");

// buildEmbedModelChoices(): WebGPU hint surfaces only for requiresWebGPU models
// when no WebGPU device is present.
const noGpu = buildEmbedModelChoices({ webgpu: false });
const yesGpu = buildEmbedModelChoices({ webgpu: true });
ok(/\(slow on this device\)/.test(noGpu["nomic-ai/nomic-embed-text-v1.5"]),
   "[A21] Nomic is flagged '(slow on this device)' without WebGPU");
ok(!/\(slow on this device\)/.test(yesGpu["nomic-ai/nomic-embed-text-v1.5"]),
   "[A22] the slow hint disappears when WebGPU is available");
ok(!/\(slow on this device\)/.test(noGpu[DEFAULT_EMBED_MODEL]),
   "[A23] WebGPU-optional models are never flagged slow");
ok(noGpu[DEFAULT_EMBED_MODEL].includes("384-dim"),
   "[A24] dropdown labels surface the dimension");

/* ── [B] Source guards over browser-rag.js ───────────────────────── */
ok(/const\s+DB_VERSION\s*=\s*2\b/.test(RAG),
   "[B1] IndexedDB schema bumped to v2");
ok(/const\s+META_STORE\s*=\s*["']meta["']/.test(RAG),
   "[B2] a v2 'meta' object store is declared");
ok(/createObjectStore\(\s*META_STORE/.test(RAG),
   "[B3] onupgradeneeded creates the meta store (additive)");
ok(/async\s+getMeta\s*\(\s*\)/.test(RAG) && /async\s+putMeta\s*\(/.test(RAG),
   "[B4] VectorStore exposes getMeta()/putMeta()");
ok(/_activeModelId\s*\(\s*\)/.test(RAG) && /activeDims\s*\(\s*\)/.test(RAG),
   "[B5] active-model accessors exist (_activeModelId / activeDims)");
ok(/async\s+detectCaps\s*\(\s*\)/.test(RAG) && /navigator\.gpu/.test(RAG),
   "[B6] WebGPU capability probe (detectCaps + navigator.gpu)");
ok(/async\s+_loadTransformers\s*\(/.test(RAG) && /_tfjsCache/.test(RAG),
   "[B7] a lazy, cached transformers.js loader exists");
ok(/TRANSFORMERS_CDN\s*=\s*Object\.freeze\(\{[\s\S]*?2:[\s\S]*?3:/.test(RAG),
   "[B8] both v2 and v3 transformers.js CDNs are pinned");
ok(/applyPrefix\(/.test(RAG),
   "[B9] embed() applies the role-specific instruction prefix");
ok(/role\s*=\s*["']passage["']/.test(RAG),
   "[B10] embed() defaults to the 'passage' role");
ok(/role:\s*["']query["']/.test(RAG),
   "[B11] search() embeds the query with the 'query' role");
ok(/rec\.vector\.length\s*===\s*dims/.test(RAG),
   "[B12] search() skips vectors whose dimension != the active model");
ok(/setActiveModel\s*\(/.test(RAG) && /putMeta\(\{[\s\S]*?model:/.test(RAG),
   "[B13] setActiveModel() records the model in the meta store");
ok(/dims:\s*vector\.length/.test(RAG),
   "[B14] indexRecord() stamps each record with its embedding dimension");

/* ── [C] Source guards over the shared refactored corpus ─────────── */
ok(/register\(\s*MODULE_ID\s*,\s*["']ragEmbedModel["']/.test(SOURCE),
   "[C1] the ragEmbedModel setting is registered");
ok(/register\(\s*MODULE_ID\s*,\s*["']ragEmbedModelActive["']/.test(SOURCE),
   "[C2] the hidden ragEmbedModelActive mirror setting is registered");
ok(/buildEmbedModelChoices\(/.test(SOURCE),
   "[C3] the dropdown choices come from the catalogue");
ok(/switchEmbedModel\s*\(/.test(SOURCE),
   "[C4] Commands.switchEmbedModel handles the model switch");
ok(/_confirmModelSwitch\s*\(/.test(SOURCE),
   "[C5] the switch is gated behind a confirmation dialog");
ok(/resetEmbedder\?\.\(\)/.test(SOURCE) && /reindexAll\(/.test(SOURCE),
   "[C6] confirming a switch resets the embedder and reindexes");
ok(/game\.settings\.set\(\s*MODULE_ID\s*,\s*["']ragEmbedModel["']\s*,\s*prevId/.test(SOURCE),
   "[C7] cancelling a switch reverts the setting to the previous model");
ok(/indexCompendiumsEnabled\?\.\(\)/.test(SOURCE),
   "[C8] the switch reindexes compendiums too when that indexing is enabled");

/* ── [D] Behavioural proof against the real BrowserRAG ───────────── */
const origStore = BrowserRAG._store;
const origExtractor = BrowserRAG._extractor;
const origLoaded = BrowserRAG._loadedModelId;
const origSetting = BrowserRAG._setting;
const origGame = globalThis.game;
try {
  // Fake meta-backed store + a stub `game.settings` so setActiveModel can write
  // its mirror without a real Foundry runtime.
  const meta = { value: null };
  const mirror = {};
  BrowserRAG._store = {
    async getMeta() { return meta.value; },
    async putMeta(v) { meta.value = v; return true; }
  };
  globalThis.game = {
    settings: {
      get: (_m, k) => mirror[k],
      set: async (_m, k, v) => { mirror[k] = v; }
    }
  };
  // Force the active model to MiniLM regardless of the (absent) setting.
  BrowserRAG._setting = (k) => (k === "ragEmbedModel" ? DEFAULT_EMBED_MODEL : undefined);

  // storedModelId starts empty (fresh / legacy v1 store).
  eq(await BrowserRAG.storedModelId(), null, "[D1] a store with no meta reports no built model");

  await BrowserRAG.setActiveModel("nomic-ai/nomic-embed-text-v1.5");
  eq(await BrowserRAG.storedModelId(), "nomic-ai/nomic-embed-text-v1.5",
     "[D2] setActiveModel() persists the model id to meta");
  eq(meta.value.dims, 768, "[D3] meta records the model's dimension");
  eq(mirror.ragEmbedModelActive, "nomic-ai/nomic-embed-text-v1.5",
     "[D4] setActiveModel() mirrors the id into the ragEmbedModelActive setting");

  // Unknown ids fall back to the default (never persist garbage).
  await BrowserRAG.setActiveModel("bogus/model");
  eq(await BrowserRAG.storedModelId(), DEFAULT_EMBED_MODEL,
     "[D5] setActiveModel() coerces an unknown id to the default");

  // resetEmbedder() tears down the loaded pipeline so the next init rebuilds it.
  BrowserRAG._extractor = { fake: true };
  BrowserRAG._loadedModelId = "nomic-ai/nomic-embed-text-v1.5";
  BrowserRAG.resetEmbedder();
  ok(BrowserRAG._extractor === null && BrowserRAG._loadedModelId === null,
     "[D6] resetEmbedder() clears the loaded model");

  // activeDims tracks the active model (MiniLM → 384 via the stubbed setting).
  eq(BrowserRAG.activeDims(), 384, "[D7] activeDims() reflects the active model");
} finally {
  BrowserRAG._store = origStore;
  BrowserRAG._extractor = origExtractor;
  BrowserRAG._loadedModelId = origLoaded;
  BrowserRAG._setting = origSetting;
  if (origGame === undefined) delete globalThis.game; else globalThis.game = origGame;
}

/* ── summary ─────────────────────────────────────────────────────── */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
