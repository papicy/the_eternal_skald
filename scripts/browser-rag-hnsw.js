/* ===================================================================== */
/*  browser-rag-hnsw.js                                                  */
/*                                                                       */
/*  PURE, dependency-free HNSW (Hierarchical Navigable Small World)      */
/*  approximate-nearest-neighbour index — Malkov & Yashunin, 2016.       */
/*                                                                       */
/*  Self-contained: no imports, no Foundry globals, no DOM. Owned by the */
/*  browser-rag subsystem as an OPT-IN alternative to the brute-force    */
/*  cosine scan for very large chronicles (1000+ memories). The index is */
/*  built once from a corpus snapshot and queried; the owner rebuilds it */
/*  whenever the corpus changes. The metric is cosine: vectors are       */
/*  L2-normalised on insert so distance reduces to `1 - dot`.            */
/* ===================================================================== */

/** Deterministic 32-bit PRNG (mulberry32) so tests are reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** L2-normalise a vector into a Float32Array (returns null if degenerate). */
function normalise(vec) {
  if (!Array.isArray(vec) && !ArrayBuffer.isView(vec)) return null;
  const n = vec.length;
  if (!n) return null;
  let norm = 0;
  for (let i = 0; i < n; i++) norm += vec[i] * vec[i];
  if (!(norm > 0)) return null;
  const inv = 1 / Math.sqrt(norm);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = vec[i] * inv;
  return out;
}

export class HnswIndex {
  /**
   * @param {object}  [opts]
   * @param {number}  [opts.M=16]              max bi-directional links per node
   * @param {number}  [opts.efConstruction=200] build-time beam width
   * @param {number}  [opts.ef=50]             default query beam width
   * @param {number}  [opts.seed=1]            PRNG seed (deterministic levels)
   */
  constructor({ M = 16, efConstruction = 200, ef = 50, seed = 1 } = {}) {
    this.M = M;
    this.Mmax = M;          // max links on layers > 0
    this.Mmax0 = 2 * M;     // max links on layer 0
    this.efConstruction = efConstruction;
    this.ef = ef;
    this.mL = 1 / Math.log(M);
    this._rng = mulberry32(seed);

    this._vectors = [];     // internal idx → Float32Array (normalised)
    this._ids = [];         // internal idx → external id
    this._levels = [];      // internal idx → top level
    this._links = [];       // internal idx → array (per level) of neighbour idx arrays
    this._dim = null;       // expected vector dimension
    this._entry = -1;       // entry-point internal idx
    this._maxLevel = -1;
  }

  /** Number of nodes in the index. */
  get size() { return this._vectors.length; }

  /** Cosine distance between two normalised vectors (1 - dot ∈ [0, 2]). */
  _dist(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return 1 - dot;
  }

  _randomLevel() {
    return Math.floor(-Math.log(this._rng() || Number.EPSILON) * this.mL);
  }

  /**
   * Insert one vector. Vectors of a mismatched dimension are ignored
   * (the index quietly skips them so a bad record can't poison the graph).
   * @returns {boolean} true if inserted.
   */
  add(id, vector) {
    const v = normalise(vector);
    if (!v) return false;
    if (this._dim === null) this._dim = v.length;
    else if (v.length !== this._dim) return false;

    const idx = this._vectors.length;
    const level = this._randomLevel();
    this._vectors.push(v);
    this._ids.push(id);
    this._levels.push(level);
    const links = [];
    for (let l = 0; l <= level; l++) links.push([]);
    this._links.push(links);

    if (this._entry === -1) {
      this._entry = idx;
      this._maxLevel = level;
      return true;
    }

    let ep = this._entry;
    // Greedy descent through layers above the new node's top level (ef = 1).
    for (let lc = this._maxLevel; lc > level; lc--) {
      ep = this._greedyClosest(v, ep, lc);
    }
    // Connect at each layer from min(level, maxLevel) down to 0.
    for (let lc = Math.min(level, this._maxLevel); lc >= 0; lc--) {
      const cands = this._searchLayer(v, [ep], this.efConstruction, lc);
      const Mlayer = lc === 0 ? this.Mmax0 : this.Mmax;
      const neighbours = this._selectNeighbours(cands, this.M);
      for (const nb of neighbours) {
        this._links[idx][lc].push(nb);
        this._links[nb][lc].push(idx);
        // Prune the neighbour's connections if it now exceeds the budget.
        if (this._links[nb][lc].length > Mlayer) {
          this._links[nb][lc] = this._selectNeighbours(
            this._links[nb][lc].map((n) => ({ idx: n, d: this._dist(this._vectors[nb], this._vectors[n]) })),
            Mlayer,
          );
        }
      }
      ep = neighbours.length ? neighbours[0] : ep;
    }

    if (level > this._maxLevel) {
      this._maxLevel = level;
      this._entry = idx;
    }
    return true;
  }

  /** Greedy single-best walk on one layer (used for upper-layer descent). */
  _greedyClosest(q, entry, lc) {
    let cur = entry;
    let curD = this._dist(q, this._vectors[cur]);
    let improved = true;
    while (improved) {
      improved = false;
      const links = this._links[cur][lc];
      if (!links) break;
      for (const nb of links) {
        const d = this._dist(q, this._vectors[nb]);
        if (d < curD) { curD = d; cur = nb; improved = true; }
      }
    }
    return cur;
  }

  /**
   * Beam search on one layer. Returns the ef closest candidates as
   * `{idx, d}` objects (unsorted; caller selects/sorts).
   */
  _searchLayer(q, entryPoints, ef, lc) {
    const visited = new Set();
    const candidates = []; // min-heap-ish: we scan, kept small via ef
    const result = [];     // current best ef (acts as max bounded set)
    for (const ep of entryPoints) {
      const d = this._dist(q, this._vectors[ep]);
      visited.add(ep);
      candidates.push({ idx: ep, d });
      result.push({ idx: ep, d });
    }
    while (candidates.length) {
      // pop nearest candidate
      let ci = 0;
      for (let i = 1; i < candidates.length; i++) if (candidates[i].d < candidates[ci].d) ci = i;
      const c = candidates.splice(ci, 1)[0];
      // furthest in current result
      let worst = result[0];
      for (const r of result) if (r.d > worst.d) worst = r;
      if (c.d > worst.d && result.length >= ef) break;
      const links = this._links[c.idx][lc];
      if (!links) continue;
      for (const nb of links) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        const d = this._dist(q, this._vectors[nb]);
        let resWorst = result[0];
        for (const r of result) if (r.d > resWorst.d) resWorst = r;
        if (d < resWorst.d || result.length < ef) {
          candidates.push({ idx: nb, d });
          result.push({ idx: nb, d });
          if (result.length > ef) {
            // drop the furthest
            let wi = 0;
            for (let i = 1; i < result.length; i++) if (result[i].d > result[wi].d) wi = i;
            result.splice(wi, 1);
          }
        }
      }
    }
    return result;
  }

  /** Pick the `m` closest candidates (simple heuristic = nearest-m). */
  _selectNeighbours(cands, m) {
    return cands
      .slice()
      .sort((a, b) => a.d - b.d)
      .slice(0, m)
      .map((c) => c.idx);
  }

  /**
   * Approximate k-nearest-neighbour search.
   * @param {number[]} queryVector
   * @param {number}   k
   * @param {number}   [efSearch] beam width (defaults to constructor ef, min k)
   * @returns {Array<{id, score}>} score = cosine similarity, descending.
   */
  search(queryVector, k = 5, efSearch) {
    if (this._entry === -1 || k <= 0) return [];
    const q = normalise(queryVector);
    if (!q || q.length !== this._dim) return [];
    const ef = Math.max(efSearch || this.ef, k);

    let ep = this._entry;
    for (let lc = this._maxLevel; lc > 0; lc--) {
      ep = this._greedyClosest(q, ep, lc);
    }
    const found = this._searchLayer(q, [ep], ef, 0);
    found.sort((a, b) => a.d - b.d);
    return found.slice(0, k).map((c) => ({ id: this._ids[c.idx], score: 1 - c.d }));
  }
}
