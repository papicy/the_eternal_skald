/* =====================================================================
 *  THE ETERNAL SKALD — Ollama / local-LLM helper  (v0.20.0, F6)
 *
 *  Ollama exposes an OpenAI-compatible chat-completions API at
 *  `<base>/v1/chat/completions`, so the existing {@link Client} talks to it
 *  unchanged once the API Endpoint points there (the "ollama" provider preset
 *  does this). This module holds only the small Ollama-specific bits that the
 *  generic OpenAI path does NOT cover:
 *
 *    1. Keyless local auth — a local Ollama needs no API key, but the Client
 *       guards against an empty key. {@link resolveOllamaApiKey} supplies a
 *       harmless placeholder so local users are not forced to invent one.
 *    2. Model discovery — Ollama lists installed models at the native
 *       `<base>/api/tags` endpoint. {@link fetchOllamaModels} reads it so the
 *       Model dropdown can reflect what the user actually has pulled.
 *    3. A curated fallback catalogue of common models for the dropdown when
 *       discovery has not run (or the server is offline).
 *
 *  Pure ESM, no Foundry imports, fully defensive: every export degrades to a
 *  safe default and never throws, honouring the module's fail-soft contract.
 * ===================================================================== */

import { OLLAMA_DEFAULT_BASE } from "../core/constants.js";

/**
 * A small curated list of popular Ollama models, used to seed the Model
 * dropdown before/without live discovery. `price: 0` keeps them sorted first
 * (local inference is free). These are plain tag names exactly as Ollama's
 * OpenAI-compatible endpoint expects them in the `model` field.
 * @type {Array<{id:string,name:string,vendor:string,price:number}>}
 */
export const OLLAMA_COMMON_MODELS = [
  { id: "llama3.1",      name: "Llama 3.1 (8B)",      vendor: "ollama", price: 0 },
  { id: "llama3.2",      name: "Llama 3.2 (3B)",      vendor: "ollama", price: 0 },
  { id: "llama3",        name: "Llama 3 (8B)",        vendor: "ollama", price: 0 },
  { id: "llama2",        name: "Llama 2 (7B)",        vendor: "ollama", price: 0 },
  { id: "mistral",       name: "Mistral (7B)",        vendor: "ollama", price: 0 },
  { id: "mixtral",       name: "Mixtral (8x7B)",      vendor: "ollama", price: 0 },
  { id: "gemma2",        name: "Gemma 2 (9B)",        vendor: "ollama", price: 0 },
  { id: "qwen2.5",       name: "Qwen 2.5 (7B)",       vendor: "ollama", price: 0 },
  { id: "phi3",          name: "Phi-3 (3.8B)",        vendor: "ollama", price: 0 },
  { id: "llava",         name: "LLaVA (vision, 7B)",  vendor: "ollama", price: 0 }
];

/**
 * Resolve the effective API key for the active provider. A local Ollama server
 * ignores the Authorization header, so when the provider is "ollama" and the
 * user left the key blank we return a harmless placeholder rather than letting
 * the Client throw "no API key". For every other provider the configured key
 * is returned verbatim (empty stays empty so the existing guard still fires).
 *
 * @param {string} preset  - the active providerPreset key
 * @param {string} apiKey  - the configured apiKey setting value
 * @returns {string} the key to send (never throws)
 */
export function resolveOllamaApiKey(preset, apiKey) {
  const key = (apiKey == null) ? "" : String(apiKey);
  if (preset === "ollama" && key.trim() === "") return "ollama";
  return key;
}

/**
 * Derive the Ollama base URL (scheme://host:port) from a configured
 * chat-completions endpoint, stripping the trailing `/v1/chat/completions`.
 * Falls back to {@link OLLAMA_DEFAULT_BASE} for anything unparseable.
 *
 * @param {string} [endpoint] - the apiEndpoint setting (may be undefined)
 * @returns {string} a base URL with no trailing slash
 */
export function ollamaBaseFromEndpoint(endpoint) {
  const ep = (endpoint == null) ? "" : String(endpoint).trim();
  if (!ep) return OLLAMA_DEFAULT_BASE;
  const stripped = ep.replace(/\/v1\/chat\/completions\/?$/i, "").replace(/\/+$/, "");
  return stripped || OLLAMA_DEFAULT_BASE;
}

/**
 * Fetch the list of models installed in a local Ollama server via its native
 * `/api/tags` endpoint. Returns dropdown-shaped entries (id/name/vendor/price).
 * Fully defensive: on any network/parse error it returns an empty array so the
 * caller can fall back to {@link OLLAMA_COMMON_MODELS}.
 *
 * @param {string} [base] - Ollama base URL (default {@link OLLAMA_DEFAULT_BASE})
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl] - injectable fetch (for tests)
 * @returns {Promise<Array<{id:string,name:string,vendor:string,price:number}>>}
 */
export async function fetchOllamaModels(base = OLLAMA_DEFAULT_BASE, opts = {}) {
  const fetchImpl = opts.fetchImpl
    || (typeof fetch === "function" ? fetch : null);
  if (!fetchImpl) return [];
  const url = `${String(base).replace(/\/+$/, "")}/api/tags`;
  try {
    const res = await fetchImpl(url, { method: "GET" });
    if (!res || !res.ok) return [];
    const data = await res.json();
    const models = Array.isArray(data?.models) ? data.models : [];
    return models
      .map(m => {
        const id = (m && (m.name || m.model)) ? String(m.name || m.model) : "";
        if (!id) return null;
        return { id, name: id, vendor: "ollama", price: 0 };
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}
