# PROPOSAL — Future-Proof Embedding-Model Architecture (Selectable Local RAG Models)

> **STATUS: DESIGN PROPOSAL (no code changed).** Output of an `INVESTIGATE` +
> `DOCUMENT` task. It designs a long-term architecture for letting the GM choose
> the local embedding model that powers semantic memory (browser RAG), supporting
> **multiple vector dimensions**, **model/dimension versioning**, **safe migration**,
> **WebGPU / transformers.js capability detection**, and **graceful degradation**.
>
> The user has explicitly accepted **higher complexity for a better long-term
> result** and is willing to **bend/break the SkaldCoder soft limits** (3 files /
> 50 lines per file). Every step that crosses an architectural boundary (brief §5)
> or busts a budget (brief §2) is called out as a **GATE** and REQUIRES recorded
> approval (brief §6) before code is written. **Nothing here has been implemented.**
>
> All claims use the mandated evidence format (brief §4). Line numbers are from the
> repo state at the time of writing.

---

## 0. Executive Summary

Today the embedding model is **hardcoded** and the vector store is **schema-blind**:
every record is a 384-dim MiniLM vector with no record of *which* model produced it,
and dimension is only enforced incidentally (a cosine length-mismatch silently scores
0). That is fine for one fixed model but breaks the moment a second model with a
different dimension enters the picture.

```
CLAIM:      The embedding model id, dimension and CDN are module-level constants, not data.
EVIDENCE:   scripts/browser-rag.js:60-61, 66  ::  EMBED_MODEL / EMBED_DIMS / TRANSFORMERS_CDN
CONFIDENCE: HIGH
BASIS:      read lines directly
```
```
CLAIM:      Stored vector records carry no model/dimension provenance — only id/text/vector/metadata{type,name,timestamp}.
EVIDENCE:   scripts/browser-rag.js:402-409  ::  indexRecord _store.put({...})
CONFIDENCE: HIGH
BASIS:      read lines directly
```
```
CLAIM:      IndexedDB is at DB_VERSION 1 with a single "journals" store; no metadata/provenance store exists.
EVIDENCE:   scripts/browser-rag.js:55-57 (constants) ; :104-113 (onupgradeneeded creates only STORE_NAME)
CONFIDENCE: HIGH
BASIS:      read lines directly
```
```
CLAIM:      A dimension mismatch degrades to a silent no-op (score 0), not a crash — so stale vectors poison recall invisibly.
EVIDENCE:   scripts/browser-rag.js:372  ::  _cosine guard `a.length !== b.length → return 0`
CONFIDENCE: HIGH
BASIS:      read line directly
```

**The recommendation in one line:** introduce a small **embedding-model catalogue**
(data, not constants), **bump IndexedDB to v2** with a tiny `meta` store that records
the **active model id + dimension**, make the embedder **model-aware** (read the
chosen model from a new setting, feature-detect WebGPU/transformers version), and on
**any dimension/model mismatch** auto-detect it and drive the existing `!reindex`
flow — **warn + one-click rebuild by default, never silent data loss**.

**Core design decisions (defended in §2–§3):**

| Question | Recommendation |
|----------|----------------|
| Multiple dimensions simultaneously? | **No — enforce one active model/dimension at a time.** Store is single-space; mixing dims breaks cosine. |
| Version the IndexedDB schema? | **Yes — bump to v2, add a `meta` store** holding `{ activeModel, dims, tfjsMajor, builtAt }`. |
| Auto-clear vs warn+reindex on mismatch? | **Warn + one-click reindex (non-destructive default).** Auto-clear only behind an explicit opt-in. |
| Per-vector or global model info? | **Both, cheaply: global is authoritative; per-record `model`+`dims` tags are a belt-and-braces filter.** |
| Upgrade transformers.js to v3/v4 now? | **Make it optional & lazy: keep v2.x as the pinned default, load v3/v4 only when a model that needs it is selected.** |
| Initial model set? | **MiniLM (default) + BGE-small (384, drop-in) on v2.x; Nomic (768) + EmbeddingGemma (768-MRL) gated behind the v3 path.** |

---

## 1. Current Architecture (the seam we build on)

```
browser-rag.js                      (the RAG owner; self-contained, degrades to no-op)
 ├─ VectorStore (class)             IndexedDB wrapper, DB v1, store "journals"
 ├─ BrowserRAG (singleton)
 │   ├─ EMBED_MODEL / EMBED_DIMS    hardcoded model + dim  (lines 60-61)
 │   ├─ TRANSFORMERS_CDN            pinned @xenova/transformers@2.17.2 (line 66)
 │   ├─ _setting(key)               defensive game.settings.get wrapper (206)
 │   ├─ init()                      lazy CDN import + pipeline build, memoised (251-317)
 │   ├─ embed(text)                 mean-pool + normalize → number[] (331-361)
 │   ├─ indexRecord({id,text,meta}) embed + _store.put (397-415)
 │   ├─ reindexAll(entries)         clear store, re-embed all (496-517)
 │   ├─ search(q)                   cosine scan + optional HNSW ANN (671-714)
 │   └─ status()                    diagnostics incl. model/dims (803-820)
 └─ browser-rag-hnsw.js             pure HNSW ANN index, rebuilt in-memory from corpus snapshot
```

```
CLAIM:      Every RAG tunable is already read through one defensive accessor, so a new model setting is a one-line accessor add.
EVIDENCE:   scripts/browser-rag.js:206-226  ::  _setting / maxResults / threshold / useAnnIndex
CONFIDENCE: HIGH
BASIS:      read lines directly
```
```
CLAIM:      The embedder is memoised in `_extractor`; init() returns early if built, so a model change only takes effect after a reload or an explicit reset of `_extractor`.
EVIDENCE:   scripts/browser-rag.js:251-252 (`if (this._extractor) return true`) ; 290 (pipeline build)
CONFIDENCE: HIGH
BASIS:      read lines directly
```
```
CLAIM:      reindexAll already clears the store before rebuilding, so migration needs no new wipe primitive.
EVIDENCE:   scripts/browser-rag.js:505 (`this._store.clear()`) within reindexAll:496-517
CONFIDENCE: HIGH
BASIS:      read lines directly
```
```
CLAIM:      embed() hardcodes pooling:"mean", normalize:true — correct for MiniLM/BGE but NOT for models needing task prefixes (BGE query/passage) or Matryoshka truncation (Nomic/Gemma).
EVIDENCE:   scripts/browser-rag.js:345  ::  this._extractor(clean, { pooling:"mean", normalize:true })
CONFIDENCE: HIGH
BASIS:      read line directly
```
```
CLAIM:      The HNSW ANN index is rebuilt in-memory from a corpus snapshot and is NOT persisted to IndexedDB, so it needs no migration on a model change — it simply rebuilds.
EVIDENCE:   scripts/browser-rag.js:622-625 (`_hnsw = null` on corpus invalidation) ; browser-rag-hnsw.js header :10 ("built once from a corpus snapshot and queried")
CONFIDENCE: HIGH
BASIS:      read lines directly
```

**Implication:** the seam is excellent. Four hardcoded facts (`EMBED_MODEL`,
`EMBED_DIMS`, `TRANSFORMERS_CDN`, the fixed `embed()` call options) become
**properties of the selected catalogue entry**. The store gains a provenance record.
Everything else (search, HNSW, status, the `!reindex` command) keeps working.

---

## 2. Best-Practice Architecture

### 2.1 The Embedding-Model Catalogue (data, not constants)

Replace the two scalar constants with a typed catalogue. **Keep it inside the
`browser-rag` layer** — do **not** reuse `scripts/core/model-catalogue.js`, which is
the *vision/chat* model catalogue and lives in a different layer.

```
CLAIM:      core/model-catalogue.js is the VISION/chat-model catalogue (OpenRouter/Abacus vision lists); reusing it for embeddings crosses the core↔rag boundary for no benefit.
EVIDENCE:   scripts/core/model-catalogue.js:1-15  ::  header + imports OPENROUTER_VISION_MODELS / ABACUS_VISION_MODELS
CONFIDENCE: HIGH
BASIS:      read lines directly
```

Proposed shape — a new **pure, dependency-free** sibling module
`scripts/core/embedding-catalogue.js` (mirrors how `browser-rag-hnsw.js` was added as
a pure sibling):

```js
// scripts/core/embedding-catalogue.js  — pure data + helpers, no Foundry globals
export const EMBED_MODELS = {
  "Xenova/all-MiniLM-L6-v2": {
    label: "MiniLM-L6 (default · fast · ~25 MB)",
    dims: 384, tfjsMajor: 2, requiresWebGPU: false,
    pooling: "mean", normalize: true,
    queryPrefix: "", passagePrefix: "",
  },
  "Xenova/bge-small-en-v1.5": {
    label: "BGE-small (better retrieval · ~30 MB)",
    dims: 384, tfjsMajor: 2, requiresWebGPU: false,
    pooling: "mean", normalize: true,
    queryPrefix: "query: ", passagePrefix: "passage: ",
  },
  // ---- v3 path (gated; only offered when capability check passes) ----
  "Xenova/nomic-embed-text-v1.5": {
    label: "Nomic v1.5 (long context · ~120 MB)",
    dims: 768, matryoshka: [768, 512, 256, 128], tfjsMajor: 3, requiresWebGPU: false,
    pooling: "mean", normalize: true,
    queryPrefix: "search_query: ", passagePrefix: "search_document: ",
  },
  "onnx-community/embeddinggemma-300m-ONNX": {
    label: "EmbeddingGemma 300M (best quality · ~400 MB)",
    dims: 768, matryoshka: [768, 512, 256, 128], tfjsMajor: 3, requiresWebGPU: true,
    pooling: "mean", normalize: true,
    queryPrefix: "task: search result | query: ", passagePrefix: "title: none | text: ",
  },
};
export const DEFAULT_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export function modelInfo(id) { return EMBED_MODELS[id] || EMBED_MODELS[DEFAULT_EMBED_MODEL]; }
export function dimsFor(id)   { return modelInfo(id).dims; }
```

Why a record per model: dimension, the **transformers.js major version** it needs,
**WebGPU requirement**, **pooling/normalize**, **task prefixes**, and optional
**Matryoshka** truncation lengths are all *model-specific facts* that the current
hardcoded `embed()` cannot express. Making them data is what makes the system
future-proof — adding a 2027 model becomes a **catalogue entry**, not a code change.

### 2.2 Capability Detection (WebGPU + transformers.js)

Add a small, cached, fail-soft probe used to (a) **filter the dropdown** so a GM is
never offered a model their browser cannot run, and (b) **pick the device** at
pipeline-build time.

```js
// inside browser-rag.js (or a tiny capability helper)
async function detectCaps() {
  let webgpu = false;
  try { webgpu = !!(navigator?.gpu && await navigator.gpu.requestAdapter()); }
  catch (_) { webgpu = false; }
  return { webgpu };
}
```

- **Dropdown filtering:** in the settings `choices` builder, hide any model whose
  `requiresWebGPU` is true when `webgpu === false`. (`requiresWebGPU` models still
  *function* on WASM but are painfully slow — better to hide than to disappoint.)
- **Device selection:** when building the pipeline, pass
  `{ device: caps.webgpu ? "webgpu" : "wasm" }` (the v3/v4 API). On v2.x there is no
  `device` option, so it is simply omitted — backward-compatible.
- **transformers.js version routing:** the catalogue entry's `tfjsMajor` selects the
  CDN URL (see §2.3). A model is only offered if its required loader can be reached.

```
CLAIM:      The pipeline build site already accepts an options object, so adding a `device` key there is a localized change.
EVIDENCE:   scripts/browser-rag.js:290-302  ::  transformers.pipeline("feature-extraction", EMBED_MODEL, { progress_callback })
CONFIDENCE: HIGH
BASIS:      read lines directly
```

### 2.3 transformers.js v3/v4 — Optional & Lazy (do NOT force-upgrade)

**Recommendation: keep v2.17.2 as the pinned default; load v3/v4 only when a model
that requires it is selected.** Rationale:

- The current pin is load-bearing and proven (`browser-rag.js:66`). A blanket bump
  changes the embedding path for **every** existing world — a §5.1 boundary cross
  with broad blast radius and no benefit for MiniLM/BGE users.
- v3/v4 is only *needed* for the newer ONNX models (Gemma/Qwen3) and WebGPU. Tie the
  loader to the catalogue:

```js
const TRANSFORMERS_CDN = {
  2: "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2",
  3: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.0", // pin exact
};
const url = TRANSFORMERS_CDN[modelInfo(id).tfjsMajor] || TRANSFORMERS_CDN[2];
const transformers = await import(/* webpackIgnore: true */ url);
```

This keeps the **default path byte-for-byte unchanged** (Invariant 1/2) while opening
the door to newer models for GMs who pick them. **Bumping/extending the CDN pin is
still a §5.1 gate** — but a *scoped, additive* one (a second pinned URL), not a
replacement.

### 2.4 Task Prefixes & Matryoshka (correctness for new models)

`embed()` must become model-aware:

- **Prefixes:** BGE/Nomic/Gemma need different text for *queries* vs *documents*.
  `embed(text, { role: "query" | "passage" })` prepends `info.queryPrefix` /
  `info.passagePrefix`. MiniLM's prefixes are empty strings → **no behavior change**.
- **Matryoshka truncation:** for models that support it, optionally slice the vector
  to a shorter length and **re-normalize**, recording the *effective* dimension in the
  meta store. This is opt-in; default is the model's native dimension.

```
CLAIM:      Today embed() applies one fixed call for all text with no role distinction — adding a role param is additive (default keeps current behavior).
EVIDENCE:   scripts/browser-rag.js:331 (signature `embed(text,{cache})`) ; :345 (fixed options)
CONFIDENCE: HIGH
BASIS:      read lines directly
```

### 2.5 Graceful Degradation (preserve Invariant 2)

The existing fail-soft posture is extended, not replaced:

1. **Unknown/removed model id** in the setting → `modelInfo()` falls back to the
   default model (never throws).
2. **Required loader unreachable** (offline, CSP) → same path as today: RAG disables
   for the session, Skald continues without memory.
3. **WebGPU-required model on a non-WebGPU client** → model is hidden from the
   dropdown; if somehow selected (saved value), it falls back to WASM with a warning,
   or to the default model if the loader can't build.
4. **Dimension mismatch with stored vectors** → detected on init (see §3), surfaced
   as a warning + one-click reindex; **never a crash, never silent corruption.**

---

## 3. Database Strategy

### 3.1 Schema Versioning — bump to DB v2, add a `meta` store

```
CLAIM:      onupgradeneeded is the single migration seam and currently only creates the journals store at v1.
EVIDENCE:   scripts/browser-rag.js:104-113  ::  indexedDB.open(DB_NAME, DB_VERSION) + onupgradeneeded
CONFIDENCE: HIGH
BASIS:      read lines directly
```

Bump `DB_VERSION` 1 → 2. In `onupgradeneeded`, **additively** create a tiny key/value
`meta` store (keep `journals` untouched so existing vectors survive the upgrade):

```js
req.onupgradeneeded = (ev) => {
  const db = ev.target.result;
  if (!db.objectStoreNames.contains(STORE_NAME)) { /* unchanged journals creation */ }
  if (!db.objectStoreNames.contains("meta")) {
    db.createObjectStore("meta", { keyPath: "key" });  // { key:"index", value:{...} }
  }
};
```

The `meta/index` record is the **authoritative provenance**:

```json
{ "key": "index",
  "value": { "activeModel": "Xenova/all-MiniLM-L6-v2",
             "dims": 384, "tfjsMajor": 2,
             "matryoshkaDim": null, "builtAt": 1718380800000,
             "vectorCount": 0, "schema": 2 } }
```

Written after every successful `reindexAll` / first index; read on `init()`.

**Backward-compat for existing v1 worlds:** on upgrade there is no `meta/index` yet,
but the store is full of 384-dim MiniLM vectors. Treat **absent meta as
`{activeModel: default, dims: 384}`** (the only model that ever existed pre-feature).
This makes the upgrade a no-op for current installs — *zero forced reindex*.

### 3.2 Per-vector vs Global model info — store **both** (cheap belt-and-braces)

- **Global (authoritative):** `meta/index` as above. One read on init tells us
  whether the store matches the selected model.
- **Per-record (defensive filter):** add `model` and `dims` to each record's
  `metadata`. Cost is a few bytes per vector; benefit is that `search()` can **skip
  any vector whose `dims` ≠ active dims** even if a migration was interrupted
  mid-flight — no poisoned results, ever.

```
CLAIM:      Adding fields to metadata is additive — records already spread arbitrary metadata and default a timestamp.
EVIDENCE:   scripts/browser-rag.js:406-408  ::  metadata:{ timestamp:Date.now(), ...metadata }
CONFIDENCE: HIGH
BASIS:      read line directly
```

The global record is the decision-maker (fast); the per-record tag is the safety net
(robust). Together they make a partial/aborted migration **safe by construction**.

### 3.3 Migration Path — auto-detect mismatch, warn + one-click reindex (default non-destructive)

On `init()` (after the store opens, before first search):

```
1. read meta/index  → storedModel, storedDims
2. read selected model setting → wantModel, wantDims (from catalogue)
3. if store is empty            → write meta = want; proceed (nothing to migrate)
4. if storedModel == wantModel  → proceed (happy path)
5. else (MISMATCH):
   a. GM client: show a non-blocking Dialog —
      "Memory was built with {storedModel} ({storedDims}-dim). You selected
       {wantModel} ({wantDims}-dim). Stored memories are incompatible and will be
       ignored until rebuilt. Rebuild now?  [Rebuild] [Keep old model] [Later]"
      • Rebuild       → reindexAll() (clears + re-embeds + writes new meta)
      • Keep old      → revert the setting to storedModel (Settings.set), proceed
      • Later         → set a 'degraded' flag; search() filters by per-record dims so
                        only matching-dim vectors (none, after a model switch) are used
                        → memory effectively empty but SAFE until the GM reindexes
   b. Non-GM clients: never write; just honor the per-record dims filter (safe no-op).
```

**Why warn-by-default, not auto-clear:** auto-clearing destroys a GM's indexed
chronicle/compendium on a misclick. The vectors are *already inert* under a dim
mismatch (cosine→0, plus the per-record filter), so there is no correctness reason to
delete eagerly. Offer **auto-clear only behind an explicit opt-in** setting
(`ragAutoReindexOnModelChange`, default OFF) for power users who want zero friction.

**`requiresReload` synergy:** because `_extractor` is memoised
(`browser-rag.js:251`), the cleanest time to apply a model change is after a reload.
Register the model setting with `requiresReload: true` *and* run the mismatch
detector on init — the reload guarantees a fresh `_extractor` for the new model, and
init() handles the data migration.

---

## 4. Recommended Model Set (initial release)

| Model | Dims | tfjs | WebGPU | Ship in v1 of feature? | Rationale |
|-------|-----:|:----:|:------:|:----------------------:|-----------|
| `Xenova/all-MiniLM-L6-v2` | 384 | 2 | no | ✅ **default** | current model; zero-migration baseline |
| `Xenova/bge-small-en-v1.5` | 384 | 2 | no | ✅ | **drop-in** 384-dim retrieval upgrade on the *already-pinned* v2.x; no CDN/DB change |
| `Xenova/nomic-embed-text-v1.5` | 768 | 3 | no | ⏳ Phase 2 | long-context (8k) hero; needs v3 loader + reindex |
| `onnx-community/embeddinggemma-300m-ONNX` | 768 | 3 | yes | ⏳ Phase 2 | best quality; needs v3 + WebGPU; ~400 MB |
| `onnx-community/Qwen3-Embedding-0.6B-ONNX` | 1024 | 3/4 | yes | 🔭 Phase 3 | SOTA; heaviest; defer until demand |

**Initial release = MiniLM + BGE-small only.** Both are 384-dim and run on the
existing v2.17.2 pin, so Phase 1 ships the *entire* catalogue/versioning/migration
machinery **without** a CDN bump or any forced reindex for existing worlds — the
machinery is proven on a safe pair before any heavy model is introduced.

**Multiple dimensions simultaneously? No.** A single IndexedDB vector space with one
cosine metric cannot mix dimensions meaningfully, and HNSW asserts a single `_dim`
(`browser-rag-hnsw.js:88-89`). Enforce **one active model at a time**; switching
models is a deliberate, migration-gated action. This is simpler, correct, and matches
how every production vector store treats embedding-space changes.

---

## 5. Implementation Recommendation (phased)

### Phase 1 — Catalogue + Versioning + Migration (safe pair, no CDN bump)

| File | Change | Est. lines |
|------|--------|-----------:|
| `scripts/core/embedding-catalogue.js` *(new, pure)* | `EMBED_MODELS`, `DEFAULT_EMBED_MODEL`, `modelInfo`, `dimsFor` (MiniLM + BGE only) | ~45 |
| `scripts/browser-rag.js` | import catalogue; model-aware `init()` (read setting, choose model); DB v2 + `meta` store; mismatch detector → warn/reindex; per-record `model`/`dims`; role-aware `embed()`; `status()` reports active model | ~50–70 |
| `scripts/core/settings.js` | register `ragEmbedModel` (choices, default=MiniLM, `requiresReload:true`, onChange dim-warning) + hidden `ragEmbedModelActive`; optional `ragAutoReindexOnModelChange` (default OFF) | ~40 |
| `lang/en.json` | names/hints + choice labels for the new settings | ~12 |
| `test/embed-model-select.test.mjs` *(new)* | catalogue dims; default=MiniLM; settings registered; mismatch→reindex logic; per-record dims filter; v1→v2 upgrade treats absent meta as MiniLM | ~60 |
| `docs/ai-maintenance-log.md` | mandated entry (§8) | ~25 |

→ **6 files.** Exceeds the 3-file soft limit (GATE — see §6). No CDN change, no
forced reindex for existing worlds, default behavior unchanged.

### Phase 2 — v3 loader + 768-dim models (Nomic, EmbeddingGemma)

| File | Change | Est. lines |
|------|--------|-----------:|
| `scripts/browser-rag.js` | `TRANSFORMERS_CDN` map (add v3 pin); `device` selection via WebGPU probe; Matryoshka truncation+renormalize | ~30 |
| `scripts/core/embedding-catalogue.js` | add Nomic + Gemma entries (prefixes, matryoshka, requiresWebGPU) | ~20 |
| `scripts/core/settings.js` | WebGPU-aware dropdown filtering | ~10 |
| `lang/en.json` + test | labels + capability/migration tests | ~30 |

→ Adds the **scoped CDN pin** (second URL) — a §5.1 GATE, distinct from Phase 1.

### Phase 3 — Qwen3 / 1024-dim (demand-driven, optional)

Only if users ask. Same machinery; just a catalogue entry + WebGPU requirement.

### 5.1 Testing Strategy (framework-free, per brief §7)

The suite is pure Node ESM (`npm test` → `node test/run-all.mjs`), so tests must be
**Foundry-free** and assert on **pure logic + source-text guards** (the established
pattern, e.g. `test/site-generator.test.mjs`, `test/browser-rag-hnsw.test.mjs`).

```
CLAIM:      Tests run framework-free per-file in their own process; mixed pure-logic + source-regex guards is the house style.
EVIDENCE:   test/browser-rag-hnsw.test.mjs (pure HnswIndex unit tests) ; SKILL.md §7 (npm test == node test/run-all.mjs)
CONFIDENCE: HIGH
BASIS:      read test file + brief
```

- **Catalogue unit tests** (pure): every entry has dims/tfjsMajor/pooling; `modelInfo`
  falls back to default for unknown ids; `dimsFor` correct.
- **Migration logic** (pure, with a fake meta record): mismatch → "reindex" decision;
  match → "proceed"; empty store → "write meta"; absent meta (v1 upgrade) → treat as
  MiniLM/384.
- **Per-record dims filter** (pure): a search corpus with mixed dims yields only
  active-dim hits.
- **Source-text guards** (regex over `browser-rag.js`/`settings.js`): `DB_VERSION === 2`;
  `meta` store created in `onupgradeneeded`; `ragEmbedModel` registered with
  `requiresReload`; embed() applies role prefixes; CDN map keyed by major.
- **No live model download in CI** — transformers.js is never imported in tests
  (it's a runtime CDN import behind `init()`); assertions are on the orchestration.
- **Regression:** full `npm test` must stay green (currently 60 files); `node --check`
  on changed JS; `lang/en.json` must parse.

### 5.2 Backward-Compatibility Plan (existing installations)

1. **Default = MiniLM** → a world that never touches the setting behaves identically.
2. **v1→v2 upgrade is additive** (only adds `meta`; `journals` untouched) and treats
   **absent meta as MiniLM/384** → existing 384-dim vectors remain valid, **no forced
   reindex**, no data loss.
3. **No setting/flag/directive removed or renamed** (Invariant 1; brief §8).
4. **Model change is opt-in and reversible** (warn + "keep old model" revert).
5. **Everything degrades to no-op** if the loader/model/WebGPU is unavailable
   (Invariant 2).

---

## 6. SkaldCoder Compliance & Required Gates

The user has authorized exceeding the soft limits for a better long-term result. Each
overage is still recorded as a gate per brief §6 (self-approval is forbidden; this
section is the request, the user's authorization is the approval to be logged).

```
GATE REQUEST #1 — file count / budget (brief §0 rule 1, §2)
  TASK:        Phase 1 — embedding catalogue + DB v2 meta store + migration + model setting.
  LIMIT HIT:   6 files vs 3-file soft cap; browser-rag.js ~50–70 changed lines (near/over 50/file cap).
  WHY NEEDED:  §7 mandates a regression test; §8 mandates a maintenance-log entry; lang/en.json owns all
               RAG setting strings (en.json:282-314); the catalogue must be its own pure module to avoid
               crossing into core/model-catalogue.js (vision layer).
  SMALLEST SAFE OPTION: Phase 1 with MiniLM+BGE only (no CDN bump, no forced reindex). Cannot drop below
               5–6 files without violating the mandatory-test/log rules.
  BLAST RADIUS: browser-rag layer only; default = current model → existing worlds unchanged.
  ROLLBACK:    single revert commit; with default model + absent-meta=MiniLM, worlds are byte-for-byte
               unaffected until a GM changes the model.
```
```
GATE REQUEST #2 — pinned dependency change (brief §5.1)
  TASK:        Phase 2 — add a SECOND pinned transformers.js CDN (v3) for Nomic/Gemma + WebGPU device path.
  LIMIT HIT:   §5.1 — changing/extending the pinned runtime dependency (browser-rag.js:66) and introducing
               768-dim models (forced reindex on selection).
  WHY NEEDED:  Gemma/Qwen3 ONNX + WebGPU device flag require @huggingface/transformers v3+.
  SMALLEST SAFE OPTION: keep v2.x default; load v3 lazily ONLY when a v3-requiring model is selected, so
               the default path is untouched. Defer Qwen3 (Phase 3).
  BLAST RADIUS: only worlds whose GM selects a v3 model; reversible by reverting to a 384-dim model.
  ROLLBACK:    revert the CDN-map + catalogue entries; 384-dim models keep working on v2.x.
```

### What to bend/break, and why

- **BEND the 3-file / 50-line soft limits (Phase 1).** Justified: the value is a
  *system* (catalogue + versioning + migration + tests), not a one-liner. Splitting it
  artificially would create half-features that violate §7 (untested) — worse than a
  recorded gate. The user has authorized this.
- **DO NOT break: "additive & backwards-compatible" (Invariant 1) or "degrades
  gracefully" (Invariant 2).** These are load-bearing and the whole design is built to
  honor them (default model, absent-meta=MiniLM, opt-in switch, no-op fallbacks).
- **DO NOT break: no silent data mutation.** Hence warn+reindex by default, never
  auto-clear without an explicit opt-in.
- **GATE, don't bypass: the transformers.js pin.** Make the upgrade *optional and
  lazy* (a second pin) rather than a global replacement — smallest blast radius for a
  future-proof capability.

---

## 7. Open Questions for the User

1. **Phase 1 scope:** ship MiniLM + BGE-small now (safe 384-dim pair, no CDN bump),
   then Phase 2 for Nomic/Gemma — or go straight to including v3 models in one shot?
2. **Auto-reindex on model change:** default OFF (warn + one-click) as recommended, or
   default ON (zero-friction, destructive) behind a clear confirmation?
3. **Compendium index:** if `ragIndexCompendiums` is on, a model switch also
   invalidates compendium vectors — reindex both in one pass (recommended) confirmed?
4. **WebGPU-required models:** hide from the dropdown on non-WebGPU clients
   (recommended) or show with a "slow on this device" warning?

---

*No code was changed by this task. This document is the deliverable. Implementation of
any phase REQUIRES the corresponding recorded gate approval (brief §6) and a completed
pre-flight checklist (brief §3) before the first line of code.*
