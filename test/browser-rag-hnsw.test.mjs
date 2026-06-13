/* =====================================================================
 *  HNSW approximate-nearest-neighbour index test (L1 RAG ANN Index).
 *
 *  scripts/browser-rag-hnsw.js is PURE (no Foundry graph, no imports), so
 *  it can be imported directly. These tests cover:
 *    [1] recall vs exact brute-force cosine on realistic clustered vectors,
 *    [2] determinism with a fixed seed,
 *    [3] edge cases (empty index, k > size, dimension mismatch, degenerate),
 *    [4] a performance benchmark on a 1500-vector / 384-dim corpus that
 *        demonstrates the ANN path is faster than the linear scan while
 *        keeping recall high.
 *
 *  Bounds are deliberately generous: the point is to demonstrate the
 *  behaviour, not to gate CI on exact wall-clock timing.
 *
 *  Run: node test/browser-rag-hnsw.test.mjs
 * ===================================================================== */

import { HnswIndex } from "../scripts/browser-rag-hnsw.js";

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }

/* Deterministic PRNG so the whole test is reproducible run-to-run. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* Exact top-k by brute-force cosine — the ground truth we compare against. */
function bruteForce(data, q, k) {
  return data
    .map((v, i) => ({ i, s: cosine(q, v) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.i);
}

/* Build a clustered corpus — realistic for sentence embeddings, which form
 * tight semantic neighbourhoods rather than filling the space uniformly. */
function makeClusteredCorpus(rng, n, dim, clusters, spread) {
  const centers = [];
  for (let c = 0; c < clusters; c++) {
    const v = new Array(dim);
    for (let j = 0; j < dim; j++) v[j] = rng() * 2 - 1;
    centers.push(v);
  }
  const data = [];
  for (let i = 0; i < n; i++) {
    const c = centers[i % clusters];
    const v = new Array(dim);
    for (let j = 0; j < dim; j++) v[j] = c[j] + (rng() * 2 - 1) * spread;
    data.push(v);
  }
  return { data, centers };
}

/* ---------------------------------------------------------------- [1] recall */
{
  const rng = mulberry32(7);
  const DIM = 64, N = 800, K = 10;
  const { data, centers } = makeClusteredCorpus(rng, N, DIM, 20, 0.3);
  const idx = new HnswIndex({ M: 16, efConstruction: 200, ef: 64, seed: 1 });
  for (let i = 0; i < N; i++) idx.add(i, data[i]);
  ok(idx.size === N, `[1] index holds all ${N} vectors (got ${idx.size})`);

  let recallSum = 0;
  const Q = 40;
  for (let qi = 0; qi < Q; qi++) {
    const c = centers[qi % centers.length];
    const q = new Array(DIM);
    for (let j = 0; j < DIM; j++) q[j] = c[j] + (rng() * 2 - 1) * 0.3;
    const ann = idx.search(q, K).map((h) => h.id);
    const exact = bruteForce(data, q, K);
    recallSum += ann.filter((x) => exact.includes(x)).length / K;
  }
  const recall = recallSum / Q;
  ok(recall >= 0.9, `[1] mean recall@${K} >= 0.9 (got ${recall.toFixed(3)})`);

  // Scores must be cosine similarities in [-1, 1], sorted descending.
  const c0 = centers[0];
  const q0 = new Array(DIM);
  for (let j = 0; j < DIM; j++) q0[j] = c0[j];
  const hits = idx.search(q0, K);
  ok(hits.every((h) => h.score >= -1.0001 && h.score <= 1.0001), "[1] scores are valid cosine similarities");
  let sorted = true;
  for (let i = 1; i < hits.length; i++) if (hits[i].score > hits[i - 1].score + 1e-9) sorted = false;
  ok(sorted, "[1] hits are sorted by descending similarity");
}

/* ------------------------------------------------------------ [2] determinism */
{
  const rng = mulberry32(99);
  const DIM = 48, N = 300;
  const { data } = makeClusteredCorpus(rng, N, DIM, 12, 0.35);
  const q = new Array(DIM);
  for (let j = 0; j < DIM; j++) q[j] = rng() * 2 - 1;

  const build = () => {
    const idx = new HnswIndex({ M: 16, efConstruction: 100, ef: 50, seed: 1234 });
    for (let i = 0; i < N; i++) idx.add(i, data[i]);
    return idx.search(q, 10).map((h) => `${h.id}:${h.score.toFixed(6)}`).join("|");
  };
  ok(build() === build(), "[2] identical seed → identical results");

  const other = () => {
    const idx = new HnswIndex({ M: 16, efConstruction: 100, ef: 50, seed: 4321 });
    for (let i = 0; i < N; i++) idx.add(i, data[i]);
    return idx.search(q, 10).map((h) => h.id);
  };
  // Different seed may reorder graph construction but must still return ids.
  ok(other().length === 10, "[2] a different seed still returns k results");
}

/* -------------------------------------------------------------- [3] edge cases */
{
  const empty = new HnswIndex();
  ok(Array.isArray(empty.search([1, 2, 3], 5)) && empty.search([1, 2, 3], 5).length === 0,
    "[3] search on an empty index returns []");
  ok(empty.size === 0, "[3] empty index has size 0");

  const idx = new HnswIndex({ seed: 1 });
  for (let i = 0; i < 5; i++) {
    const v = [0, 0, 0, 0];
    v[i % 4] = 1;
    idx.add(`id${i}`, v);
  }
  ok(idx.search([1, 0, 0, 0], 100).length === idx.size, "[3] k > size clamps to size");
  ok(idx.search([1, 0, 0, 0], 0).length === 0, "[3] k = 0 returns []");

  // Dimension mismatch on add is skipped; mismatched query returns [].
  const added = idx.add("bad", [1, 2, 3]); // 3-dim into a 4-dim index
  ok(added === false, "[3] mismatched-dimension add is rejected");
  ok(idx.search([1, 2, 3], 3).length === 0, "[3] mismatched-dimension query returns []");

  // Degenerate (all-zero) vectors normalise to null and are rejected.
  ok(idx.add("zero", [0, 0, 0, 0]) === false, "[3] all-zero vector is rejected");
  ok(idx.add("notvec", "nope") === false, "[3] non-array vector is rejected");

  // The first inserted unit vector must be the nearest to its own direction.
  const top = idx.search([1, 0, 0, 0], 1);
  ok(top.length === 1 && top[0].id === "id0", "[3] nearest neighbour is exact for a clean query");
}

/* --------------------------------------------------------- [4] perf benchmark */
{
  const rng = mulberry32(2024);
  const DIM = 384, N = 4000, K = 10, Q = 30;
  const { data, centers } = makeClusteredCorpus(rng, N, DIM, 50, 0.3);

  const t0 = Date.now();
  const idx = new HnswIndex({ M: 16, efConstruction: 200, ef: 64, seed: 1 });
  for (let i = 0; i < N; i++) idx.add(i, data[i]);
  const buildMs = Date.now() - t0;

  const queries = [];
  for (let qi = 0; qi < Q; qi++) {
    const c = centers[qi % centers.length];
    const q = new Array(DIM);
    for (let j = 0; j < DIM; j++) q[j] = c[j] + (rng() * 2 - 1) * 0.3;
    queries.push(q);
  }

  let annMs = 0, linMs = 0, recallSum = 0;
  for (const q of queries) {
    const a0 = Date.now();
    const ann = idx.search(q, K).map((h) => h.id);
    annMs += Date.now() - a0;

    const l0 = Date.now();
    const exact = bruteForce(data, q, K);
    linMs += Date.now() - l0;

    recallSum += ann.filter((x) => exact.includes(x)).length / K;
  }
  const recall = recallSum / Q;

  console.log(`  [perf] N=${N} dim=${DIM}: build ${buildMs}ms | ` +
    `ANN ${annMs}ms vs linear ${linMs}ms over ${Q} queries | recall@${K} ${recall.toFixed(3)}`);

  ok(recall >= 0.9, `[4] benchmark recall@${K} >= 0.9 (got ${recall.toFixed(3)})`);
  ok(annMs < linMs, `[4] ANN search faster than linear scan (ANN ${annMs}ms < linear ${linMs}ms)`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
