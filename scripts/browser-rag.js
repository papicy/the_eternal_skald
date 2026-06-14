/* =====================================================================
 *  THE ETERNAL SKALD — Browser-Based RAG / AI Memory
 *  (Module version lives in module.json — the single source of truth.)
 *  ---------------------------------------------------------------------
 *  Gives the Skald a *semantic long-term memory* of your saga, entirely
 *  inside the browser — no server, no cloud vector DB, no extra setup.
 *
 *  HOW IT WORKS
 *  ------------
 *   1.  Every Journal Entry the Skald scribes (NPCs, locations,
 *       discoveries, world facts, story threads, session chronicles) is
 *       turned into a 384-dimension embedding vector using a small
 *       transformer model (`Xenova/all-MiniLM-L6-v2`) that runs locally
 *       via transformers.js (WASM/WebGPU). The model (~90 MB) is fetched
 *       from a CDN on first use and cached by the browser thereafter.
 *   2.  Vectors + their source text + metadata are stored in IndexedDB
 *       (`eternal-skald-vectors` → `journals`), so memory survives reloads
 *       and lives only on the GM's machine — privacy-first by design.
 *   3.  Before the Skald answers, we embed the *query* (the player's
 *       prompt, the move, the scene seed…), find the most semantically
 *       similar journal entries via cosine similarity, and inject the top
 *       matches as a "RELEVANT WORLD MEMORY" block in the system prompt.
 *
 *  GRACEFUL DEGRADATION
 *  --------------------
 *  RAG must NEVER break play. The model load is lazy and optional; if
 *  transformers.js cannot be fetched (offline, CSP, ancient browser), or
 *  IndexedDB is unavailable, every public method fails *soft* — returning
 *  empty results — and the Skald simply answers without world memory.
 *
 *  PERFORMANCE
 *  -----------
 *   • Lazy load: the model is only fetched the first time RAG is used.
 *   • In-memory caches for both the embedder and recent query embeddings.
 *   • A small serial work-queue debounces/serialises indexing so journal
 *     writes never stack up CPU-heavy embedding work on the main thread.
 *   • transformers.js itself uses Web Workers / WASM threads where the
 *     browser allows, keeping the UI responsive.
 *
 *  This module is imported by `eternal-skald.js` and exposed on the public
 *  API as `game.modules.get("the-eternal-skald").api.rag`.
 * ===================================================================== */

import { HnswIndex } from "./browser-rag-hnsw.js";
import {
  EMBED_MODELS, DEFAULT_EMBED_MODEL, modelInfo, dimsFor, applyPrefix
} from "./core/embedding-catalogue.js";

const MODULE_ID   = "the-eternal-skald";
const LOG_PREFIX  = "The Eternal Skald |";

/* Below this corpus size the brute-force cosine scan is faster than building
 * an HNSW graph, so the ANN path only engages for genuinely large chronicles
 * even when the setting is on. */
const ANN_MIN_CORPUS = 1000;

/* IndexedDB layout.
 * v1 → only the `journals` vector store.
 * v2 → adds a tiny key/value `meta` store recording WHICH embedding model the
 *      stored vectors were built with (so a model switch can be detected and a
 *      reindex offered). The upgrade is purely additive: existing v1 vectors
 *      survive untouched and, with no meta record yet, are treated as the
 *      default MiniLM/384 model — so existing worlds need NO forced reindex. */
const DB_NAME      = "eternal-skald-vectors";
const DB_VERSION   = 2;
const STORE_NAME   = "journals";
const META_STORE   = "meta";
const META_KEY     = "index";   // the single meta record's key

/* Default embedding model. The ACTIVE model is chosen at runtime from the
 * `ragEmbedModel` setting via the catalogue (see _activeModelId); these
 * constants are the safe fallback when no setting/catalogue entry is found.
 * all-MiniLM-L6-v2 → 384-dim, mean-pooled, normalized. */
const EMBED_MODEL  = DEFAULT_EMBED_MODEL;
const EMBED_DIMS   = dimsFor(DEFAULT_EMBED_MODEL);

/* transformers.js, loaded lazily from a CDN as an ES module. Two pinned,
 * known-good releases keyed by MAJOR version: the long-standing 2.x line
 * (default path, used by the 384-dim models) and the newer 3.x line
 * (@huggingface/transformers, loaded ONLY when a model in the catalogue
 * declares tfjsMajor:3 — e.g. GTE-v1.5, Nomic). Keeping 2.x as the default
 * means existing worlds are byte-for-byte unaffected. If an import fails for
 * any reason, RAG disables itself and the Skald carries on without memory. */
const TRANSFORMERS_CDN = Object.freeze({
  2: "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2",
  3: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2"
});

/* Rough token estimate: ~4 characters per token for English prose. */
const CHARS_PER_TOKEN = 4;

/* ===================================================================== */
/*  §A  VECTOR STORE (IndexedDB)                                          */
/* ===================================================================== */

/**
 * Thin promise-based wrapper around an IndexedDB object store holding the
 * journal vectors. Each record is:
 *   { id:string, text:string, vector:number[384], metadata:{type,name,timestamp,...} }
 *
 * All methods reject softly (callers wrap in try/catch) and the store opens
 * lazily on first use.
 */
class VectorStore {
  constructor() {
    /** @type {IDBDatabase|null} */
    this._db = null;
    this._openPromise = null;
  }

  /** Is IndexedDB usable in this environment at all? */
  static supported() {
    try { return typeof indexedDB !== "undefined" && !!indexedDB; }
    catch (_) { return false; }
  }

  /** Open (or upgrade) the database, memoising the connection. */
  async open() {
    if (this._db) return this._db;
    if (this._openPromise) return this._openPromise;
    if (!VectorStore.supported()) throw new Error("IndexedDB unavailable");

    this._openPromise = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { return reject(e); }

      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
          // A by-type index is handy for filtered reindex/inspection.
          try { store.createIndex("byType", "metadata.type", { unique: false }); }
          catch (_) {}
        }
        // v2: additive meta store. Existing `journals` vectors are left intact,
        // so upgrading an old (v1) world loses nothing and forces no reindex.
        if (!db.objectStoreNames.contains(META_STORE)) {
          try { db.createObjectStore(META_STORE, { keyPath: "key" }); }
          catch (_) {}
        }
      };
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror   = () => reject(req.error || new Error("IndexedDB open failed"));
    });
    return this._openPromise;
  }

  /** Run a transaction against the store and resolve when it completes. */
  async _tx(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let result;
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      try { result = fn(store); }
      catch (e) { return reject(e); }
      tx.oncomplete = () => resolve(result);
      tx.onerror    = () => reject(tx.error || new Error("IndexedDB tx failed"));
      tx.onabort    = () => reject(tx.error || new Error("IndexedDB tx aborted"));
    });
  }

  /** Insert or replace a single vector record (keyed by id). */
  async put(record) {
    return this._tx("readwrite", (store) => { store.put(record); return true; });
  }

  /** Insert/replace many records in a single transaction. */
  async bulkPut(records) {
    return this._tx("readwrite", (store) => {
      for (const r of records) store.put(r);
      return records.length;
    });
  }

  /** Fetch all records (used by the in-memory cosine scan during search). */
  async getAll() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error || new Error("getAll failed"));
    });
  }

  /** Delete one record by id. */
  async delete(id) {
    return this._tx("readwrite", (store) => { store.delete(id); return true; });
  }

  /** Wipe the entire store. */
  async clear() {
    return this._tx("readwrite", (store) => { store.clear(); return true; });
  }

  /** Count stored vectors. */
  async count() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror   = () => reject(req.error || new Error("count failed"));
    });
  }

  /* ---- v2 meta store: model/dimension provenance ---- */

  /** Read the single meta record's `value` (or null when absent/unavailable). */
  async getMeta() {
    const db = await this.open();
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(META_STORE, "readonly");
        const req = tx.objectStore(META_STORE).get(META_KEY);
        req.onsuccess = () => resolve(req.result?.value ?? null);
        req.onerror   = () => resolve(null);
      } catch (_) { resolve(null); }
    });
  }

  /** Write (replace) the meta record's `value`. Resolves true on success. */
  async putMeta(value) {
    const db = await this.open();
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(META_STORE, "readwrite");
        tx.objectStore(META_STORE).put({ key: META_KEY, value });
        tx.oncomplete = () => resolve(true);
        tx.onerror    = () => resolve(false);
        tx.onabort    = () => resolve(false);
      } catch (_) { resolve(false); }
    });
  }
}

/* ===================================================================== */
/*  §B  BROWSER RAG                                                       */
/* ===================================================================== */

export const BrowserRAG = {
  /* ---------------- internal state ---------------- */
  _store: new VectorStore(),
  _extractor: null,        // transformers.js pipeline (feature-extraction)
  _loadedModelId: null,    // which catalogue model `_extractor` was built for
  _tfjsCache: new Map(),   // tfjsMajor → loaded transformers module (cached)
  _caps: null,             // cached capability probe { webgpu } (null = unprobed)
  _initPromise: null,      // de-dupes concurrent init() calls
  _initFailed: false,      // sticky: don't retry a hard failure every call
  _queryCache: new Map(),  // text → vector (small LRU-ish cache)
  _QUERY_CACHE_MAX: 64,
  _corpusCache: null,      // cached array of ALL vector records (null = unloaded)
  _hnsw: null,             // lazily-built HNSW ANN index (null = not built)
  _hnswById: null,         // Map: record id → record, for ANN result hydration

  // Serial indexing queue so embedding work never stacks up on the main
  // thread when several journal writes complete back-to-back.
  _indexJobs: [],
  _indexBusy: false,

  /* ---------------- settings accessors ---------------- */

  /** Read a module setting defensively (returns undefined if unavailable). */
  _setting(key) {
    try { return game.settings.get(MODULE_ID, key); }
    catch (_) { return undefined; }
  },

  /** Master switch — RAG is on unless explicitly disabled. */
  enabled() { return this._setting("ragEnabled") !== false; },

  /** Should newly-written journals be embedded automatically? */
  autoIndex() { return this._setting("ragAutoIndex") !== false; },

  /** Verbose console logging for RAG, gated behind a setting. */
  _debug(...args) {
    try { if (this._setting("ragDebugMode")) console.log(LOG_PREFIX, "[RAG]", ...args); }
    catch (_) {}
  },

  maxResults()  { const n = Number(this._setting("ragMaxResults"));   return Number.isFinite(n) && n > 0 ? n : 5; },
  contextTokens(){ const n = Number(this._setting("ragContextTokens")); return Number.isFinite(n) && n > 0 ? n : 2000; },
  threshold()   { const n = Number(this._setting("ragSimilarityThreshold")); return Number.isFinite(n) ? n : 0.3; },

  /** Opt-in HNSW approximate index (default OFF) — for large chronicles. */
  useAnnIndex() { return this._setting("ragUseAnnIndex") === true; },

  /* ---------------- active embedding model ---------------- */

  /**
   * The id of the model the GM has SELECTED (the `ragEmbedModel` setting),
   * validated against the catalogue. Unknown / unset → the default model, so
   * existing worlds and fresh installs both resolve to MiniLM.
   * @returns {string}
   */
  _activeModelId() {
    const id = this._setting("ragEmbedModel");
    return (id && EMBED_MODELS[id]) ? id : DEFAULT_EMBED_MODEL;
  },

  /** Catalogue entry for the active model. @returns {object} */
  _activeInfo() { return modelInfo(this._activeModelId()); },

  /** Output dimension of the active model. @returns {number} */
  activeDims() { return this._activeInfo().dims; },

  /**
   * Detect (once, cached) which acceleration backends the browser offers.
   * Probing `navigator.gpu.requestAdapter()` is the only reliable WebGPU test;
   * it is async, so we memoise the result. Always fail-soft to `{webgpu:false}`.
   * @returns {Promise<{webgpu:boolean}>}
   */
  async detectCaps() {
    if (this._caps) return this._caps;
    let webgpu = false;
    try {
      if (typeof navigator !== "undefined" && navigator.gpu?.requestAdapter) {
        const adapter = await navigator.gpu.requestAdapter();
        webgpu = !!adapter;
      }
    } catch (_) { webgpu = false; }
    this._caps = { webgpu };
    this._debug("capabilities:", JSON.stringify(this._caps));
    return this._caps;
  },

  /**
   * Tear down the loaded embedder so the NEXT init() rebuilds the pipeline for
   * the currently-selected model. Used when the GM switches models. Does NOT
   * touch stored vectors — the caller decides whether to reindex.
   */
  resetEmbedder() {
    this._extractor = null;
    this._loadedModelId = null;
    this._initFailed = false;
    this._initPromise = null;
    this._queryCache.clear();
    this._debug("embedder reset — next init() will load the selected model.");
  },

  /** Read the model id the STORE was last built with (from the v2 meta record). */
  async storedModelId() {
    try { const m = await this._store.getMeta(); return m?.model || null; }
    catch (_) { return null; }
  },

  /**
   * Record (in the v2 meta store AND the hidden mirror setting) which model the
   * store is now built with. The meta store is authoritative across worlds; the
   * `ragEmbedModelActive` setting is a fast mirror the onChange handler reads to
   * detect the PREVIOUS model without an async IndexedDB call.
   * @param {string} modelId
   */
  async setActiveModel(modelId) {
    const id = (modelId && EMBED_MODELS[modelId]) ? modelId : DEFAULT_EMBED_MODEL;
    const info = modelInfo(id);
    try {
      await this._store.putMeta({ model: id, dims: info.dims, tfjsMajor: info.tfjsMajor, builtAt: Date.now(), schema: DB_VERSION });
    } catch (_) {}
    try { await game.settings.set(MODULE_ID, "ragEmbedModelActive", id); } catch (_) {}
    this._debug("active model recorded:", id, `(${info.dims}-dim)`);
  },

  /* ---------------- lifecycle / model load ---------------- */

  /**
   * Lazily import the correct transformers.js MAJOR version for a model, caching
   * the loaded module so a session never re-fetches the same library. The 2.x
   * line stays the default; 3.x is only fetched when a tfjsMajor:3 model is
   * selected, keeping existing worlds on the proven pin.
   * @param {number} tfjsMajor
   * @returns {Promise<object>} the transformers module
   */
  async _loadTransformers(tfjsMajor) {
    const major = (tfjsMajor === 3) ? 3 : 2;
    if (this._tfjsCache.has(major)) return this._tfjsCache.get(major);
    const cdn = TRANSFORMERS_CDN[major] || TRANSFORMERS_CDN[2];
    this._debug(`loading transformers.js v${major} from`, cdn);
    // Kept in a variable so bundlers / `node --check` don't resolve it statically.
    const url = cdn;
    const transformers = await import(/* webpackIgnore: true */ url);
    this._tfjsCache.set(major, transformers);
    return transformers;
  },

  /** Has the embedding model finished loading? */
  isReady() { return !!this._extractor; },

  /** Has IndexedDB + RAG support been ruled out for this session? */
  isAvailable() {
    return this.enabled() && VectorStore.supported() && !this._initFailed;
  },

  /**
   * Lazily load transformers.js + the embedding model. Safe to call many
   * times; concurrent callers share one promise. Resolves to `true` when an
   * embedder is ready, `false` on (soft) failure.
   *
   * @param {object}   [opts]
   * @param {(p:{status:string,progress?:number,file?:string})=>void} [opts.onProgress]
   *        Called with model-download progress events (0–100).
   * @returns {Promise<boolean>}
   */
  async init({ onProgress } = {}) {
    if (this._extractor) return true;
    if (this._initFailed) return false;
    if (!this.enabled()) return false;
    if (!VectorStore.supported()) { this._initFailed = true; return false; }
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      try {
        const modelId = this._activeModelId();
        const info    = modelInfo(modelId);
        const caps    = await this.detectCaps();
        onProgress?.({ status: "loading-library", progress: 0 });

        // Load (and cache) the transformers.js MAJOR version this model needs.
        const transformers = await this._loadTransformers(info.tfjsMajor);

        // Allow remote model fetch + browser cache; disable local file lookups
        // (there is no local model directory inside a Foundry module).
        try {
          if (transformers.env) {
            transformers.env.allowLocalModels = false;
            // The Cache Storage API (`caches`) is only exposed in a secure
            // context (HTTPS or localhost). Foundry is frequently served over
            // plain HTTP on a LAN/remote host, where `caches` is undefined and
            // transformers.js throws "Browser cache is not available in this
            // environment". Only opt into the browser cache when it actually
            // exists; otherwise fall back to in-memory (re-fetch each session).
            if (typeof caches !== "undefined") {
              transformers.env.useBrowserCache = true;
              console.log(`${LOG_PREFIX} [RAG] Browser cache enabled — model will persist across sessions.`);
            } else {
              transformers.env.useBrowserCache = false;
              console.warn(`${LOG_PREFIX} [RAG] Browser cache unavailable (non-HTTPS / insecure context). Using in-memory fallback — the model re-downloads each session. Serve Foundry over HTTPS or localhost for persistent caching.`);
            }
          }
        } catch (_) {}

        // Pipeline options. `device` is a v3+ concept; only pass it when the
        // loaded library understands it (tfjsMajor 3) — passing it to 2.x is
        // harmless but we keep the 2.x call byte-identical to the old default.
        const pipeOpts = {
          progress_callback: (ev) => {
            try {
              if (!ev) return;
              // ev.status: 'initiate' | 'download' | 'progress' | 'done' | 'ready'
              const pct = typeof ev.progress === "number" ? Math.round(ev.progress) : undefined;
              onProgress?.({ status: ev.status || "progress", progress: pct, file: ev.file });
              if (ev.status === "progress" && pct != null) {
                this._debug(`model download ${ev.file || ""} ${pct}%`);
              }
            } catch (_) {}
          }
        };
        if (info.tfjsMajor >= 3) {
          pipeOpts.device = caps.webgpu ? "webgpu" : "wasm";
          if (info.requiresWebGPU && !caps.webgpu) {
            console.warn(`${LOG_PREFIX} [RAG] "${modelId}" runs best with WebGPU, which is unavailable here — embedding will be slower. Consider Chrome/Edge 113+ for hardware acceleration.`);
          }
        }

        this._debug(`transformers.js v${info.tfjsMajor} loaded — building pipeline:`, modelId, `(device ${pipeOpts.device || "default"})`);
        this._extractor = await transformers.pipeline("feature-extraction", modelId, pipeOpts);
        this._loadedModelId = modelId;

        onProgress?.({ status: "ready", progress: 100 });
        this._debug("embedding model ready:", modelId, `(${info.dims}-dim)`);
        return true;
      } catch (err) {
        console.warn(LOG_PREFIX, "[RAG] model load failed — semantic memory disabled this session:", err?.message || err);
        this._initFailed = true;
        this._extractor = null;
        onProgress?.({ status: "error", progress: 0 });
        return false;
      } finally {
        this._initPromise = null;
      }
    })();
    return this._initPromise;
  },

  /* ---------------- embeddings ---------------- */

  /**
   * Embed a string into a normalized 384-dim vector. Returns null on any
   * failure (caller degrades gracefully). Loads the model on demand.
   *
   * @param {string} text
   * @param {object} [opts]
   * @param {boolean} [opts.cache=false] - cache the result (used for queries).
   * @returns {Promise<number[]|null>}
   */
  async embed(text, { cache = false, role = "passage" } = {}) {
    const clean = String(text || "").trim();
    if (!clean) return null;

    // Cache key includes role: query/passage prefixes (for BGE/Nomic) yield
    // different vectors for the same raw text. Plain models ignore role.
    const cacheKey = `${role}\u0000${clean}`;
    if (cache && this._queryCache.has(cacheKey)) return this._queryCache.get(cacheKey);

    if (!this._extractor) {
      const ok = await this.init();
      if (!ok || !this._extractor) return null;
    }

    try {
      const info = this._activeInfo();
      // Apply task-specific prefix (no-op for models without query/passage
      // prefixes such as MiniLM). Keeps default behavior byte-identical.
      const prepared = applyPrefix(clean, role, info);
      const output = await this._extractor(prepared, {
        pooling: info?.pooling || "mean",
        normalize: info?.normalize !== false
      });
      // transformers.js returns a Tensor with .data (TypedArray). Convert to
      // a plain Array so it round-trips cleanly through IndexedDB.
      const vec = Array.from(output?.data ?? output ?? []);
      if (!vec.length) return null;

      if (cache) {
        if (this._queryCache.size >= this._QUERY_CACHE_MAX) {
          // Evict the oldest entry (Map preserves insertion order).
          const firstKey = this._queryCache.keys().next().value;
          this._queryCache.delete(firstKey);
        }
        this._queryCache.set(cacheKey, vec);
      }
      return vec;
    } catch (err) {
      this._debug("embed failed:", err?.message || err);
      return null;
    }
  },

  /**
   * Cosine similarity between two equal-length vectors. Our embeddings are
   * pre-normalized, so this reduces to a dot product — but we normalise
   * defensively in case a caller passes raw vectors.
   *
   * @returns {number} similarity in [-1, 1] (0 on mismatch/empty).
   */
  cosineSim(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      dot += x * y; na += x * x; nb += y * y;
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  },

  /* ---------------- indexing ---------------- */

  /** Estimate token count for a string (rough, ~4 chars/token). */
  _estimateTokens(str) { return Math.ceil(String(str || "").length / CHARS_PER_TOKEN); },

  /**
   * Embed + store one logical memory record. Low-level; most callers use
   * {@link indexJournalEntry}. No-ops softly when RAG is unavailable.
   *
   * @param {object} rec
   * @param {string} rec.id
   * @param {string} rec.text
   * @param {object} [rec.metadata]
   * @returns {Promise<boolean>} true if stored.
   */
  async indexRecord({ id, text, metadata = {} }) {
    if (!this.isAvailable()) return false;
    const body = String(text || "").trim();
    if (!id || !body) return false;
    try {
      const vector = await this.embed(body, { role: "passage" });
      if (!vector) return false;
      await this._store.put({
        id: String(id),
        text: body.slice(0, 8000),
        vector,
        metadata: {
          timestamp: Date.now(),
          model: this._activeModelId(),
          dims: vector.length,
          ...metadata
        }
      });
      this._invalidateCorpus();
      this._debug("indexed record", id, `(${metadata?.type || "?"})`);
      return true;
    } catch (err) {
      this._debug("indexRecord failed:", err?.message || err);
      return false;
    }
  },

  /**
   * Extract searchable text + metadata from a Foundry JournalEntry and index
   * it. Uses the Skald's stored `aiContext` flag when present (a compact,
   * pre-distilled summary), falling back to the entry's rendered text.
   *
   * Routed through a serial queue so a burst of journal writes embeds one at
   * a time without janking the UI. Fire-and-forget friendly.
   *
   * @param {JournalEntry} entry
   * @param {object} [opts]
   * @param {boolean} [opts.immediate=false] - bypass the queue (await directly).
   * @returns {Promise<boolean>}
   */
  async indexJournalEntry(entry, { immediate = false } = {}) {
    if (!this.isAvailable() || !entry) return false;
    if (immediate) return this._doIndexJournalEntry(entry);
    // Enqueue and let the serial drain handle it.
    return new Promise((resolve) => {
      this._indexJobs.push({ entry, resolve });
      this._drainIndexQueue();
    });
  },

  /** Serial drain of the indexing queue. */
  async _drainIndexQueue() {
    if (this._indexBusy) return;
    this._indexBusy = true;
    try {
      while (this._indexJobs.length) {
        const job = this._indexJobs.shift();
        let ok = false;
        try { ok = await this._doIndexJournalEntry(job.entry); }
        catch (e) { this._debug("index job failed:", e?.message || e); }
        try { job.resolve?.(ok); } catch (_) {}
      }
    } finally {
      this._indexBusy = false;
    }
  },

  /** The actual per-entry indexing work (extraction + embed + store). */
  async _doIndexJournalEntry(entry) {
    try {
      const id   = entry.id || entry._id;
      const name = entry.name || "(unnamed)";
      const type = entry.getFlag?.(MODULE_ID, "type") || "journal";
      const aiCtx = entry.getFlag?.(MODULE_ID, "aiContext") || "";

      // Prefer the distilled aiContext; otherwise strip HTML from page text.
      let text = aiCtx;
      if (!text) {
        const page = entry.pages?.contents?.[0] ?? entry.pages?.find?.(() => true);
        const html = page?.text?.content || "";
        text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
      // Lead with the name so the title strongly influences the embedding.
      const composed = `${name}. ${text}`.trim();
      return await this.indexRecord({
        id,
        text: composed,
        metadata: { type, name, timestamp: entry.getFlag?.(MODULE_ID, "lastUpdated") || Date.now() }
      });
    } catch (err) {
      this._debug("_doIndexJournalEntry failed:", err?.message || err);
      return false;
    }
  },

  /**
   * Re-embed every Skald journal entry from scratch (clears the store first).
   * Used by the `!reindex` command and after large imports.
   *
   * @param {JournalEntry[]} entries
   * @param {object} [opts]
   * @param {(done:number,total:number)=>void} [opts.onProgress]
   * @returns {Promise<{indexed:number,total:number}>}
   */
  async reindexAll(entries, { onProgress } = {}) {
    const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
    const total = list.length;
    if (!this.isAvailable()) return { indexed: 0, total };

    // Make sure the model is up before we start the loop.
    const ok = await this.init({ onProgress: (p) => onProgress?.(0, total, p) });
    if (!ok) return { indexed: 0, total };

    try { await this._store.clear(); } catch (_) {}
    this._invalidateCorpus();

    let indexed = 0;
    for (let i = 0; i < list.length; i++) {
      try {
        const done = await this._doIndexJournalEntry(list[i]);
        if (done) indexed++;
      } catch (_) {}
      onProgress?.(i + 1, total);
    }
    // Stamp the store with the model it was just (re)built with, so future
    // sessions can detect dimension mismatches and offer an auto-reindex.
    try { await this.setActiveModel(this._activeModelId()); } catch (_) {}
    this._debug(`reindex complete — ${indexed}/${total} entries embedded.`);
    return { indexed, total };
  },

  /* ---------------- compendium indexing (v0.20.0, F1) ---------------- */

  /** Setting: should installed compendium packs be embedded into RAG? Opt-in. */
  indexCompendiumsEnabled() { return this._setting("ragIndexCompendiums") === true; },

  /**
   * Extract a compact, searchable text blob from a loaded compendium document.
   * Pulls the document name plus the most prose-bearing fields across the
   * common Foundry document types — JournalEntry pages, Item/Actor
   * descriptions, RollTable results. Returns "" when nothing useful is found.
   * Pure + defensive (never throws), so it is unit-testable in isolation.
   *
   * @param {object} doc A Foundry document (or doc-like object).
   * @returns {string}
   */
  _compendiumDocText(doc) {
    try {
      if (!doc) return "";
      const parts = [];
      const name = doc.name || "";
      // JournalEntry — concatenate every page's text.
      const pages = doc.pages?.contents || (Array.isArray(doc.pages) ? doc.pages : null);
      if (pages) for (const p of pages) { const t = p?.text?.content; if (t) parts.push(t); }
      // Item / Actor — system description / biography.
      const sys = doc.system || doc.data?.data || {};
      const desc = sys?.description?.value ?? (typeof sys?.description === "string" ? sys.description : "")
                 ?? sys?.details?.biography?.value ?? "";
      if (typeof desc === "string" && desc) parts.push(desc);
      // RollTable (oracles) — each result's text.
      const results = doc.results?.contents || (Array.isArray(doc.results) ? doc.results : null);
      if (results) for (const r of results) { const t = r?.text || r?.description; if (t) parts.push(t); }
      const text = parts.join(" ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return `${name}. ${text}`.trim().replace(/^\.\s*/, "");
    } catch (_) { return ""; }
  },

  /**
   * Embed the documents of the given compendium packs into semantic memory,
   * ALONGSIDE the chronicle (does not clear the store). Records use a
   * `comp:<collection>:<id>` key so re-runs are idempotent and never collide
   * with journal vectors. No-ops softly when RAG is unavailable or the
   * compendium-indexing setting is off.
   *
   * @param {Array} packs  Foundry CompendiumCollection objects (caller selects
   *                        which, typically adapter-gated by document type).
   * @param {object} [opts]
   * @param {(done:number,total:number,label?:string)=>void} [opts.onProgress]
   * @returns {Promise<{indexed:number,total:number}>}
   */
  async indexCompendiums(packs, { onProgress } = {}) {
    const list = Array.isArray(packs) ? packs.filter(Boolean) : [];
    let indexed = 0, total = 0;
    if (!this.isAvailable() || !this.indexCompendiumsEnabled()) return { indexed, total };
    const ok = await this.init();
    if (!ok) return { indexed, total };
    for (const pack of list) {
      let docs = [];
      try { docs = await pack.getDocuments(); }
      catch (e) { this._debug("compendium load failed:", e?.message || e); continue; }
      const label = pack?.metadata?.label || pack?.title || pack?.collection || "compendium";
      total += docs.length;
      for (const doc of docs) {
        try {
          const text = this._compendiumDocText(doc);
          if (!text) continue;
          const id = `comp:${pack?.collection || label}:${doc?.id || doc?._id}`;
          const done = await this.indexRecord({
            id, text,
            metadata: { type: "compendium", name: doc?.name || "(unnamed)", pack: label, timestamp: Date.now() }
          });
          if (done) indexed++;
        } catch (_) {}
      }
      try { onProgress?.(indexed, total, label); } catch (_) {}
    }
    this._invalidateCorpus();
    this._debug(`compendium index complete — ${indexed}/${total} documents embedded.`);
    return { indexed, total };
  },

  /* ---------------- corpus cache ---------------- */

  /**
   * Return every stored vector, served from a persistent in-memory cache so a
   * query never triggers a full O(n) IndexedDB reload. The cache is populated
   * lazily on first use and invalidated by every write/remove/clear. If the
   * read fails the cache stays unset, so the next call retries cleanly.
   */
  async _getCorpus() {
    if (Array.isArray(this._corpusCache)) return this._corpusCache;
    const all = await this._store.getAll();
    this._corpusCache = Array.isArray(all) ? all : [];
    this._debug(`corpus cache populated — ${this._corpusCache.length} vectors`);
    return this._corpusCache;
  },

  /** Drop the cached corpus; the next search reloads it from IndexedDB. */
  _invalidateCorpus() {
    if (this._corpusCache !== null) {
      this._corpusCache = null;
      this._debug("corpus cache invalidated");
    }
    // The ANN graph is built from the corpus snapshot, so any corpus change
    // drops it; the next ANN search rebuilds it lazily from fresh vectors.
    this._hnsw = null;
    this._hnswById = null;
  },

  /**
   * Build (or return the cached) HNSW index over the current corpus, plus an
   * id→record map for hydrating hits. Returns null when ANN is disabled, the
   * corpus is too small to benefit, or construction fails — callers then fall
   * back to the exact linear scan.
   */
  _getHnsw(corpus) {
    if (!this.useAnnIndex()) return null;
    if (!Array.isArray(corpus) || corpus.length < ANN_MIN_CORPUS) return null;
    if (this._hnsw && this._hnswById) return this._hnsw;
    try {
      const index = new HnswIndex();
      const byId = new Map();
      for (const rec of corpus) {
        if (!rec || !Array.isArray(rec.vector)) continue;
        index.add(rec.id, rec.vector);
        byId.set(rec.id, rec);
      }
      this._hnsw = index;
      this._hnswById = byId;
      this._debug(`HNSW index built — ${index.size} vectors`);
      return this._hnsw;
    } catch (err) {
      this._debug("HNSW build failed, using linear scan:", err?.message || err);
      this._hnsw = null;
      this._hnswById = null;
      return null;
    }
  },

  /* ---------------- search / retrieval ---------------- */

  /**
   * Semantic search over stored journal vectors.
   *
   * @param {string} queryText
   * @param {object} [opts]
   * @param {number} [opts.maxResults]
   * @param {number} [opts.threshold]
   * @returns {Promise<Array<{id,text,metadata,score}>>}
   */
  async search(queryText, { maxResults, threshold } = {}) {
    if (!this.isAvailable()) return [];
    const q = String(queryText || "").trim();
    if (!q) return [];

    const limit = maxResults ?? this.maxResults();
    const minSim = threshold ?? this.threshold();

    try {
      const qVec = await this.embed(q, { cache: true, role: "query" });
      if (!qVec) return [];

      const all = await this._getCorpus();
      if (!all.length) return [];

      // Defensively skip any vector whose dimensionality does not match the
      // active model. After a model switch the store is reindexed, but this
      // guards against a partial/interrupted reindex leaving mixed-dim
      // vectors that would otherwise score as 0 (or throw) in cosineSim.
      const dims = qVec.length;
      const usable = all.filter((rec) => Array.isArray(rec?.vector) && rec.vector.length === dims);
      if (usable.length !== all.length) {
        this._debug(`search: skipped ${all.length - usable.length} stale-dim vectors (active ${dims})`);
      }
      if (!usable.length) return [];

      // OPT-IN approximate path: query the HNSW graph, then hydrate + filter.
      // Any failure falls through to the exact linear scan below.
      const index = this._getHnsw(usable);
      if (index) {
        try {
          const ann = index.search(qVec, limit, undefined)
            .filter((h) => h.score >= minSim)
            .map((h) => {
              const rec = this._hnswById.get(h.id);
              return rec ? { id: rec.id, text: rec.text, metadata: rec.metadata || {}, score: h.score } : null;
            })
            .filter(Boolean);
          this._debug(`ANN search "${q.slice(0, 40)}" → ${ann.length}/${all.length} hits (min ${minSim})`);
          return ann;
        } catch (annErr) {
          this._debug("ANN search failed, falling back to linear:", annErr?.message || annErr);
        }
      }

      const scored = [];
      for (const rec of usable) {
        if (!rec || !Array.isArray(rec.vector)) continue;
        const score = this.cosineSim(qVec, rec.vector);
        if (score >= minSim) {
          scored.push({ id: rec.id, text: rec.text, metadata: rec.metadata || {}, score });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      const hits = scored.slice(0, limit);
      this._debug(`search "${q.slice(0, 40)}" → ${hits.length}/${usable.length} hits (min ${minSim})`);
      return hits;
    } catch (err) {
      this._debug("search failed:", err?.message || err);
      return [];
    }
  },

  /**
   * Search and format the results into a "RELEVANT WORLD MEMORY" block ready
   * for injection into a system prompt, honouring the token budget. Returns
   * an EMPTY string when RAG is off, the model isn't loaded yet, or nothing
   * relevant is found — so callers can simply concatenate the result.
   *
   * NOTE: this purposely does NOT trigger a model download mid-conversation.
   * If the model isn't ready yet it returns "" immediately (the first index
   * pass or an explicit !reindex/!rag-status warms it up instead), so the
   * very first prompts never block on a 90 MB fetch.
   *
   * @param {string} queryText
   * @param {object} [opts]
   * @param {number} [opts.maxTokens]
   * @param {number} [opts.maxResults]
   * @returns {Promise<string>}
   */
  async buildContextBlock(queryText, { maxTokens, maxResults } = {}) {
    if (!this.isAvailable()) return "";
    if (!this.isReady()) {
      // Warm the model up in the background for next time, but don't block.
      this.init().catch(() => {});
      return "";
    }

    const budget = maxTokens ?? this.contextTokens();
    const hits = await this.search(queryText, { maxResults });
    if (!hits.length) return "";

    const lines = [];
    let usedTokens = this._estimateTokens("RELEVANT WORLD MEMORY (recalled from your chronicle):\n");
    for (const h of hits) {
      const label = h.metadata?.name ? `${h.metadata.name}` : (h.metadata?.type || "Note");
      const typeTag = h.metadata?.type ? `[${h.metadata.type}] ` : "";
      const line = `• ${typeTag}${label}: ${String(h.text || "").replace(/\s+/g, " ").trim()}`;
      const cost = this._estimateTokens(line);
      if (usedTokens + cost > budget) {
        // Truncate this last entry to fit the remaining budget, if useful.
        const remaining = (budget - usedTokens) * CHARS_PER_TOKEN;
        if (remaining > 80) lines.push(line.slice(0, remaining) + "…");
        break;
      }
      lines.push(line);
      usedTokens += cost;
    }
    if (!lines.length) return "";

    return [
      "RELEVANT WORLD MEMORY (recalled from your chronicle — use it for continuity; do not contradict it):",
      ...lines
    ].join("\n");
  },

  /* ---------------- maintenance / status ---------------- */

  /** Remove a single entry's vector (e.g. when a journal is deleted). */
  async remove(id) {
    if (!VectorStore.supported() || !id) return false;
    try { await this._store.delete(String(id)); this._invalidateCorpus(); return true; }
    catch (_) { return false; }
  },

  /** Wipe all stored vectors. */
  async clear() {
    if (!VectorStore.supported()) return false;
    try { await this._store.clear(); this._queryCache.clear(); this._invalidateCorpus(); return true; }
    catch (_) { return false; }
  },

  /** Number of vectors currently stored. */
  async count() {
    if (!VectorStore.supported()) return 0;
    try { return await this._store.count(); }
    catch (_) { return 0; }
  },

  /**
   * Snapshot of RAG health for the !rag-status command / diagnostics.
   * @returns {Promise<object>}
   */
  async status() {
    let count = 0;
    try { count = await this.count(); } catch (_) {}
    let stored = "";
    try { stored = await this.storedModelId(); } catch (_) {}
    const activeId = this._activeModelId();
    const info = this._activeInfo();
    return {
      enabled:        this.enabled(),
      indexedDB:      VectorStore.supported(),
      modelReady:     this.isReady(),
      modelFailed:    this._initFailed,
      autoIndex:      this.autoIndex(),
      vectorCount:    count,
      model:          activeId,
      modelLabel:     info?.label || activeId,
      dims:           this.activeDims(),
      storedModel:    stored || activeId,
      dimMismatch:    !!stored && stored !== activeId &&
                      (modelInfo(stored)?.dims !== this.activeDims()),
      loadedModel:    this._loadedModelId || null,
      maxResults:     this.maxResults(),
      contextTokens:  this.contextTokens(),
      threshold:      this.threshold()
    };
  }
};

export { VectorStore };
export default BrowserRAG;
