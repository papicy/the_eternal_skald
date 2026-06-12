/* =====================================================================
 *  RAG corpus-cache test for The Eternal Skald (P3 latency).
 *
 *  Previously BrowserRAG.search() called this._store.getAll() on EVERY
 *  query, reloading the entire vector corpus from IndexedDB each time —
 *  an O(n) cost per turn that grows with the chronicle. P3 adds a
 *  module-scoped _corpusCache populated lazily via _getCorpus() and
 *  invalidated (_invalidateCorpus()) on every write/remove/clear, so
 *  repeated queries hit memory instead of IndexedDB.
 *
 *  Two halves (mirrors request-timeout.test.mjs convention):
 *    [A] Source-text guards over scripts/browser-rag.js (this module is
 *        intentionally excluded from the shared readSkaldSource corpus, so
 *        we read it directly): the cache field + helpers exist, search()
 *        reads through the cache, and every mutation invalidates it.
 *    [B] A behavioural proof, importing the real BrowserRAG and swapping in
 *        a fake store: first query populates the cache, a second query
 *        serves from memory (no second getAll), invalidation forces a
 *        reload, and a failing read leaves the cache unset (graceful retry).
 *
 *  Run: node test/rag-cache.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BrowserRAG } from "../scripts/browser-rag.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAG = readFileSync(join(__dirname, "..", "scripts", "browser-rag.js"), "utf8");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }

console.log("RAG corpus-cache test (P3 latency)\n");

/* ── [A] Source-text guards ──────────────────────────────────────── */
ok(/_corpusCache\s*:/.test(RAG),
   "[A1] a module-scoped _corpusCache field is declared");
ok(/async\s+_getCorpus\s*\(\s*\)/.test(RAG),
   "[A2] a _getCorpus() cache accessor is defined");
ok(/_invalidateCorpus\s*\(\s*\)\s*\{/.test(RAG),
   "[A3] an _invalidateCorpus() helper is defined");
ok(/const\s+all\s*=\s*await\s+this\._getCorpus\s*\(\s*\)/.test(RAG),
   "[A4] search() reads the corpus through _getCorpus() (not a raw getAll)");
// getAll() should now be called from exactly ONE place in BrowserRAG: inside
// _getCorpus(). (The VectorStore class defines getAll; that's a separate def.)
ok((RAG.match(/this\._store\.getAll\s*\(/g) || []).length === 1,
   "[A5] the only this._store.getAll() call lives inside _getCorpus()");
ok(/this\._store\.put\([\s\S]*?\}\);\s*\n\s*this\._invalidateCorpus\(\)/.test(RAG),
   "[A6] indexRecord() invalidates the cache after a put");
ok(/this\._store\.delete\(String\(id\)\);\s*this\._invalidateCorpus\(\)/.test(RAG),
   "[A7] remove() invalidates the cache after a delete");
ok(/this\._store\.clear\(\);\s*this\._queryCache\.clear\(\);\s*this\._invalidateCorpus\(\)/.test(RAG),
   "[A8] clear() invalidates the cache");
ok(/await this\._store\.clear\(\); \} catch \(_\) \{\}\s*\n\s*this\._invalidateCorpus\(\)/.test(RAG),
   "[A9] reindexAll() invalidates the cache after clearing the store");

/* ── [B] Behavioural proof against the real BrowserRAG ───────────────── */
function makeFakeStore(rows) {
  return {
    getAllCalls: 0,
    _rows: rows,
    async getAll() { this.getAllCalls++; return this._rows.slice(); }
  };
}

const origStore = BrowserRAG._store;
try {
  // (1) First read populates the cache from the store.
  const store = makeFakeStore([{ id: "a" }, { id: "b" }]);
  BrowserRAG._store = store;
  BrowserRAG._corpusCache = null;

  const first = await BrowserRAG._getCorpus();
  ok(store.getAllCalls === 1 && first.length === 2,
     "[B1] first _getCorpus() loads from the store and caches the corpus");

  // (2) Second read is served from memory — no extra getAll().
  const second = await BrowserRAG._getCorpus();
  ok(store.getAllCalls === 1 && second === first,
     "[B2] a repeated query reuses the cache (no second IndexedDB getAll)");

  // (3) Invalidation forces a reload on the next read.
  BrowserRAG._invalidateCorpus();
  ok(BrowserRAG._corpusCache === null, "[B3] _invalidateCorpus() clears the cache");
  await BrowserRAG._getCorpus();
  ok(store.getAllCalls === 2, "[B4] the next query after invalidation reloads from the store");

  // (4) Graceful degradation: a failing read leaves the cache unset so the
  //     next call retries cleanly instead of serving a poisoned cache.
  const boom = { async getAll() { throw new Error("idb down"); } };
  BrowserRAG._store = boom;
  BrowserRAG._corpusCache = null;
  let threw = false;
  try { await BrowserRAG._getCorpus(); } catch (_) { threw = true; }
  ok(threw && BrowserRAG._corpusCache === null,
     "[B5] a failed read does not poison the cache (stays unset for a clean retry)");
} finally {
  BrowserRAG._store = origStore;
  BrowserRAG._corpusCache = null;
}

/* ── summary ─────────────────────────────────────────────────────── */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
