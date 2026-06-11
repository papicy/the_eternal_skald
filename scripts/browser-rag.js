/* =====================================================================
 *  THE ETERNAL SKALD — Browser-Based RAG / AI Memory (v0.6.0)
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

const MODULE_ID   = "the-eternal-skald";
const LOG_PREFIX  = "The Eternal Skald |";

/* IndexedDB layout. */
const DB_NAME      = "eternal-skald-vectors";
const DB_VERSION   = 1;
const STORE_NAME   = "journals";

/* Embedding model. all-MiniLM-L6-v2 → 384-dim, mean-pooled, normalized. */
const EMBED_MODEL  = "Xenova/all-MiniLM-L6-v2";
const EMBED_DIMS   = 384;

/* transformers.js, loaded lazily from a CDN as an ES module. Pinned to a
 * known-good 2.x release for reproducibility. If this import fails for any
 * reason, RAG disables itself and the Skald carries on without memory. */
const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";

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
}

/* ===================================================================== */
/*  §B  BROWSER RAG                                                       */
/* ===================================================================== */

export const BrowserRAG = {
  /* ---------------- internal state ---------------- */
  _store: new VectorStore(),
  _extractor: null,        // transformers.js pipeline (feature-extraction)
  _initPromise: null,      // de-dupes concurrent init() calls
  _initFailed: false,      // sticky: don't retry a hard failure every call
  _queryCache: new Map(),  // text → vector (small LRU-ish cache)
  _QUERY_CACHE_MAX: 64,

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

  /* ---------------- lifecycle / model load ---------------- */

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
        this._debug("loading transformers.js from", TRANSFORMERS_CDN);
        onProgress?.({ status: "loading-library", progress: 0 });

        // Dynamic CDN import. Kept in a variable so bundlers/`node --check`
        // don't try to resolve it statically.
        const cdn = TRANSFORMERS_CDN;
        const transformers = await import(/* webpackIgnore: true */ cdn);

        // Allow remote model fetch + browser cache; disable local file lookups
        // (there is no local model directory inside a Foundry module).
        try {
          if (transformers.env) {
            transformers.env.allowLocalModels = false;
            transformers.env.useBrowserCache  = true;
          }
        } catch (_) {}

        this._debug("transformers.js loaded — building feature-extraction pipeline:", EMBED_MODEL);
        this._extractor = await transformers.pipeline("feature-extraction", EMBED_MODEL, {
          progress_callback: (info) => {
            try {
              if (!info) return;
              // info.status: 'initiate' | 'download' | 'progress' | 'done' | 'ready'
              const pct = typeof info.progress === "number" ? Math.round(info.progress) : undefined;
              onProgress?.({ status: info.status || "progress", progress: pct, file: info.file });
              if (info.status === "progress" && pct != null) {
                this._debug(`model download ${info.file || ""} ${pct}%`);
              }
            } catch (_) {}
          }
        });

        onProgress?.({ status: "ready", progress: 100 });
        this._debug("embedding model ready.");
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
  async embed(text, { cache = false } = {}) {
    const clean = String(text || "").trim();
    if (!clean) return null;

    if (cache && this._queryCache.has(clean)) return this._queryCache.get(clean);

    if (!this._extractor) {
      const ok = await this.init();
      if (!ok || !this._extractor) return null;
    }

    try {
      const output = await this._extractor(clean, { pooling: "mean", normalize: true });
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
        this._queryCache.set(clean, vec);
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
      const vector = await this.embed(body);
      if (!vector) return false;
      await this._store.put({
        id: String(id),
        text: body.slice(0, 8000),
        vector,
        metadata: { timestamp: Date.now(), ...metadata }
      });
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

    let indexed = 0;
    for (let i = 0; i < list.length; i++) {
      try {
        const done = await this._doIndexJournalEntry(list[i]);
        if (done) indexed++;
      } catch (_) {}
      onProgress?.(i + 1, total);
    }
    this._debug(`reindex complete — ${indexed}/${total} entries embedded.`);
    return { indexed, total };
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
      const qVec = await this.embed(q, { cache: true });
      if (!qVec) return [];

      const all = await this._store.getAll();
      if (!all.length) return [];

      const scored = [];
      for (const rec of all) {
        if (!rec || !Array.isArray(rec.vector)) continue;
        const score = this.cosineSim(qVec, rec.vector);
        if (score >= minSim) {
          scored.push({ id: rec.id, text: rec.text, metadata: rec.metadata || {}, score });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      const hits = scored.slice(0, limit);
      this._debug(`search "${q.slice(0, 40)}" → ${hits.length}/${all.length} hits (min ${minSim})`);
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
    try { await this._store.delete(String(id)); return true; }
    catch (_) { return false; }
  },

  /** Wipe all stored vectors. */
  async clear() {
    if (!VectorStore.supported()) return false;
    try { await this._store.clear(); this._queryCache.clear(); return true; }
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
    return {
      enabled:        this.enabled(),
      indexedDB:      VectorStore.supported(),
      modelReady:     this.isReady(),
      modelFailed:    this._initFailed,
      autoIndex:      this.autoIndex(),
      vectorCount:    count,
      model:          EMBED_MODEL,
      dims:           EMBED_DIMS,
      maxResults:     this.maxResults(),
      contextTokens:  this.contextTokens(),
      threshold:      this.threshold()
    };
  }
};

export { VectorStore };
export default BrowserRAG;
