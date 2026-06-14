/* =====================================================================
 *  THE ETERNAL SKALD — Embedding-Model Catalogue
 *  (Pure data + helpers. NO Foundry globals, NO imports, NO side effects.)
 *  ---------------------------------------------------------------------
 *  The local browser-RAG embedder (scripts/browser-rag.js) used to hardcode
 *  a single model id + dimension. This module turns those facts into DATA so
 *  the GM can choose among several local embedding models, and so adding a
 *  future model is a catalogue entry rather than a code change.
 *
 *  Each entry records every model-specific fact the embedder needs:
 *    • dims          — output vector dimension (drives DB compatibility).
 *    • tfjsMajor     — which transformers.js MAJOR version can load it.
 *                      2 → the pinned @xenova/transformers@2.x (default path);
 *                      3 → the lazily-loaded @huggingface/transformers@3.x.
 *    • requiresWebGPU— true when the model is heavy enough that, without a
 *                      WebGPU device, it runs noticeably slowly (we surface a
 *                      "(slow on this device)" hint rather than hiding it).
 *    • pooling/normalize — passed straight to the feature-extraction call.
 *    • queryPrefix / passagePrefix — instruction prefixes some models expect
 *                      (BGE/Nomic/GTE-v1.5). Empty strings → no behaviour
 *                      change for models (like MiniLM) that need none.
 *    • size          — human-readable quantised download size, for the UI.
 *
 *  This file is intentionally dependency-free so it is trivially unit-testable
 *  in plain Node (see test/embed-model-select.test.mjs) and cannot introduce
 *  an import cycle into the core/ layer.
 * ===================================================================== */

/**
 * @typedef {Object} EmbedModelInfo
 * @property {string}  label
 * @property {number}  dims
 * @property {2|3}     tfjsMajor
 * @property {boolean} requiresWebGPU
 * @property {"mean"|"cls"} pooling
 * @property {boolean} normalize
 * @property {string}  queryPrefix
 * @property {string}  passagePrefix
 * @property {string}  size
 * @property {string}  note
 */

/** The id of the original / default model. Changing this is a breaking change. */
export const DEFAULT_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";

/**
 * The catalogue. Keys are the exact transformers.js model ids.
 * @type {Record<string, EmbedModelInfo>}
 */
export const EMBED_MODELS = Object.freeze({
  // ---- 384-dim · transformers.js v2.x (the safe, pinned default path) ----
  "Xenova/all-MiniLM-L6-v2": {
    label: "MiniLM-L6 v2 — fast default",
    dims: 384, tfjsMajor: 2, requiresWebGPU: false,
    pooling: "mean", normalize: true,
    queryPrefix: "", passagePrefix: "",
    size: "~25 MB", note: "The original ultra-fast model. Safe everywhere."
  },
  "Xenova/bge-small-en-v1.5": {
    label: "BGE-small en v1.5 — better retrieval",
    dims: 384, tfjsMajor: 2, requiresWebGPU: false,
    pooling: "mean", normalize: true,
    // BGE is instruction-tuned: queries get a short instruction, passages none.
    queryPrefix: "Represent this sentence for searching relevant passages: ",
    passagePrefix: "",
    size: "~30 MB", note: "Drop-in 384-dim upgrade, stronger at retrieval."
  },
  "Supabase/gte-small": {
    label: "GTE-small — balanced",
    dims: 384, tfjsMajor: 2, requiresWebGPU: false,
    pooling: "mean", normalize: true,
    queryPrefix: "", passagePrefix: "",
    size: "~30 MB", note: "General Text Embeddings, 384-dim, v2-compatible."
  },

  // ---- 384-dim · transformers.js v3.x (newer architecture) ----
  "Alibaba-NLP/gte-small-en-v1.5": {
    label: "GTE-small en v1.5 — long context",
    dims: 384, tfjsMajor: 3, requiresWebGPU: false,
    pooling: "cls", normalize: true,
    queryPrefix: "", passagePrefix: "",
    size: "~70 MB", note: "8k context, 384-dim. Needs transformers.js v3."
  },

  // ---- 768-dim · transformers.js v3.x (Phase 2 / next-gen) ----
  "nomic-ai/nomic-embed-text-v1.5": {
    label: "Nomic Embed v1.5 — 768-dim, long context",
    dims: 768, tfjsMajor: 3, requiresWebGPU: true,
    pooling: "mean", normalize: true,
    // Nomic v1.5 expects task-instruction prefixes.
    queryPrefix: "search_query: ",
    passagePrefix: "search_document: ",
    size: "~140 MB", note: "8k context, 768-dim. Best for long entries; benefits from WebGPU."
  }
});

/**
 * Resolve a model id to its catalogue entry, falling back to the default for
 * unknown / removed ids. NEVER throws.
 * @param {string} id
 * @returns {EmbedModelInfo}
 */
export function modelInfo(id) {
  return EMBED_MODELS[id] || EMBED_MODELS[DEFAULT_EMBED_MODEL];
}

/**
 * Output dimension for a model id (default model's dims for unknown ids).
 * @param {string} id
 * @returns {number}
 */
export function dimsFor(id) {
  return modelInfo(id).dims;
}

/**
 * transformers.js MAJOR version a model id needs (2 or 3).
 * @param {string} id
 * @returns {number}
 */
export function tfjsMajorFor(id) {
  return modelInfo(id).tfjsMajor;
}

/**
 * Whether a model id exists in the catalogue.
 * @param {string} id
 * @returns {boolean}
 */
export function isKnownModel(id) {
  return Object.prototype.hasOwnProperty.call(EMBED_MODELS, id);
}

/**
 * Apply the correct instruction prefix for a given role to the raw text.
 * Roles: "query" (a search query) vs "passage" (a stored document). Unknown
 * roles and prefix-less models return the text unchanged → no behaviour change
 * for MiniLM and friends.
 * @param {string} text
 * @param {"query"|"passage"} role
 * @param {EmbedModelInfo} info
 * @returns {string}
 */
export function applyPrefix(text, role, info) {
  const body = String(text ?? "");
  if (!info) return body;
  if (role === "query"   && info.queryPrefix)   return info.queryPrefix + body;
  if (role === "passage" && info.passagePrefix) return info.passagePrefix + body;
  return body;
}

/**
 * Build the `choices` object for the ragEmbedModel settings dropdown.
 * Labels include the dimension and download size; models that benefit from
 * WebGPU get a "(slow on this device)" hint when no WebGPU device is present
 * — they are still selectable, just flagged.
 *
 * @param {object} [caps]
 * @param {boolean} [caps.webgpu=false] - whether a WebGPU device is available.
 * @returns {Record<string,string>} id → human label
 */
export function buildEmbedModelChoices(caps = {}) {
  const webgpu = !!caps.webgpu;
  const choices = {};
  for (const [id, info] of Object.entries(EMBED_MODELS)) {
    let label = `${info.label} · ${info.dims}-dim · ${info.size}`;
    if (info.requiresWebGPU && !webgpu) label += " (slow on this device)";
    choices[id] = label;
  }
  return choices;
}

export default EMBED_MODELS;
