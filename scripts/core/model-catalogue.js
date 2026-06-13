/* ===================================================================== */
/*  §1c  VISION-MODEL CATALOGUE HELPERS  (extracted - Phase 2 refactor)   */
/* ===================================================================== */
/*
 * Pure model-catalogue logic extracted verbatim from eternal-skald.js with
 * zero behavioral change. These helpers build/filter the AI Model and Vision
 * Model dropdown choices from the static catalogues in constants.js (plus an
 * optional live OpenRouter fetch). They depend only on constants.js and the
 * Foundry globals `game.i18n` / `fetch`; they never touch Settings, so this
 * module sits cleanly below settings.js in the dependency graph.
 */
import {
  LOG_PREFIX,
  PROVIDER_PRESETS, PROVIDER_LABELS,
  OPENROUTER_VISION_MODELS, ABACUS_VISION_MODELS
} from "./constants.js";
import { OLLAMA_COMMON_MODELS } from "../ai/ollama-client.js";

/**
 * (v0.10.31) Live OpenRouter vision-model list, lazily fetched from the
 * public `/models` endpoint at runtime (see {@link fetchOpenRouterVisionModels}).
 * `null` until a successful fetch completes; the static
 * {@link OPENROUTER_VISION_MODELS} list is always used as a safe fallback so
 * the dropdowns work fully offline. Never throws.
 * @type {Array<{id:string,name:string,vendor:string,price:number}>|null}
 */
let OPENROUTER_LIVE_MODELS = null;


/**
 * (v0.10.31) Format a per-1M price for display: FREE for 0, else `$X.XX`.
 * @param {number} price
 * @returns {string}
 */
function formatModelPrice(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return "FREE";
  return `$${p.toFixed(2)}`;
}

/**
 * (v0.10.31) Build the dropdown label for a model in the required format:
 *   "Model Name ($X.XX/1M) - Provider"
 * (FREE models show "(FREE/1M)"). When the model's display name carries a
 * "Vendor: Model" prefix (as OpenRouter names do), the vendor is split out and
 * used as the trailing Provider; otherwise `fallbackProviderLabel` is used.
 *
 * @param {{id:string,name:string,vendor?:string,price:number}} model
 * @param {string} fallbackProviderLabel
 * @returns {string}
 */
function formatModelLabel(model, fallbackProviderLabel) {
  let modelName = String(model?.name ?? model?.id ?? "").trim();
  let vendorDisp = fallbackProviderLabel || "";
  const colon = modelName.indexOf(": ");
  if (colon > 0 && colon < 40) {
    vendorDisp = modelName.slice(0, colon).trim();
    modelName = modelName.slice(colon + 2).trim();
  } else if (model?.vendor) {
    vendorDisp = titleCaseVendor(model.vendor);
  }
  const priceStr = formatModelPrice(model?.price);
  const tail = vendorDisp ? ` - ${vendorDisp}` : "";
  return `${modelName} (${priceStr}/1M)${tail}`;
}

/**
 * (v0.10.31) Best-effort prettifier for a raw OpenRouter vendor slug
 * (e.g. "x-ai" → "xAI", "meta-llama" → "Meta Llama"). Falls back to a simple
 * title-case. Never throws.
 * @param {string} vendor
 * @returns {string}
 */
function titleCaseVendor(vendor) {
  const v = String(vendor || "").trim();
  if (!v) return "";
  const special = {
    "openai": "OpenAI", "x-ai": "xAI", "z-ai": "Z.AI", "meta-llama": "Meta",
    "mistralai": "Mistral", "moonshotai": "MoonshotAI", "bytedance-seed": "ByteDance",
    "nex-agi": "Nex AGI", "rekaai": "Reka", "minimax": "MiniMax", "stepfun": "StepFun"
  };
  if (special[v]) return special[v];
  return v.split(/[-_/]/).map(s => s ? s[0].toUpperCase() + s.slice(1) : s).join(" ");
}

/**
 * (v0.10.31) Return the curated, price-sorted (FREE first, then ascending)
 * list of vision models appropriate for a given AI Provider preset.
 *
 *   • abacus     → the Abacus AI RouteLLM catalogue (bare ids).
 *   • openrouter → the full OpenRouter catalogue (live list if fetched, else
 *                  the embedded static list); ids keep their `vendor/model`
 *                  form as OpenRouter expects.
 *   • openai     → OpenRouter models whose vendor is OpenAI, with the
 *                  `openai/` prefix stripped (the native OpenAI endpoint wants
 *                  bare model names).
 *   • google     → OpenRouter models whose vendor is Google, `google/` prefix
 *                  stripped (native Google OpenAI-compatible endpoint).
 *   • custom / unknown → the union of every catalogue, so a self-hosted or
 *                  gateway endpoint can pick anything.
 *
 * Always returns a fresh, sorted array; never throws.
 *
 * @param {string} preset - a key of {@link PROVIDER_PRESETS}
 * @returns {Array<{id:string,name:string,vendor?:string,price:number}>}
 */
function getModelsForProvider(preset) {
  const sortByPrice = (a, b) => {
    const pa = Number(a.price) || 0, pb = Number(b.price) || 0;
    if (pa !== pb) return pa - pb;            // FREE (0) first, then ascending
    return String(a.name).localeCompare(String(b.name));
  };
  const openrouter = Array.isArray(OPENROUTER_LIVE_MODELS) && OPENROUTER_LIVE_MODELS.length
    ? OPENROUTER_LIVE_MODELS
    : OPENROUTER_VISION_MODELS;

  let list;
  switch (preset) {
    case "abacus":
      list = ABACUS_VISION_MODELS.map(m => ({ ...m }));
      break;
    case "openrouter":
      list = openrouter.map(m => ({ ...m }));
      break;
    case "openai":
      list = openrouter
        .filter(m => m.vendor === "openai")
        .map(m => ({ ...m, id: m.id.replace(/^openai\//, "") }));
      break;
    case "google":
      list = openrouter
        .filter(m => m.vendor === "google")
        .map(m => ({ ...m, id: m.id.replace(/^google\//, "") }));
      break;
    case "ollama":
      // (v0.20.0 F6) Local Ollama models. The curated common-model list seeds
      // the dropdown; live-discovered tags (via fetchOllamaModels) are merged
      // in by the settings layer when available.
      list = OLLAMA_COMMON_MODELS.map(m => ({ ...m }));
      break;
    case "custom":
    default: {
      // Union of everything, de-duplicated by id (OpenRouter first).
      const seen = new Set();
      list = [];
      for (const m of [...openrouter, ...ABACUS_VISION_MODELS]) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        list.push({ ...m });
      }
      break;
    }
  }
  return list.sort(sortByPrice);
}

/**
 * (v0.10.31) Is `model` present in the curated vision-model catalogue (the
 * Abacus list, the OpenRouter static/live list, or one of those with its
 * vendor prefix stripped)? Used by {@link Client._modelSupportsVision} so any
 * model the dropdowns offer is treated as genuinely vision-capable. Matching
 * is case-insensitive and tolerant of the `vendor/` prefix being present or
 * absent (e.g. "gpt-4o" matches "openai/gpt-4o"). Never throws.
 *
 * @param {string} model
 * @returns {boolean}
 */
export function isCatalogueVisionModel(model) {
  const id = String(model || "").trim().toLowerCase();
  if (!id) return false;
  const openrouter = Array.isArray(OPENROUTER_LIVE_MODELS) && OPENROUTER_LIVE_MODELS.length
    ? OPENROUTER_LIVE_MODELS
    : OPENROUTER_VISION_MODELS;
  for (const m of [...openrouter, ...ABACUS_VISION_MODELS]) {
    const cid = String(m.id || "").toLowerCase();
    if (!cid) continue;
    if (cid === id) return true;
    // Tolerate vendor prefix being stripped (openai/gpt-4o ↔ gpt-4o).
    const slash = cid.indexOf("/");
    if (slash > 0 && cid.slice(slash + 1) === id) return true;
  }
  return false;
}

/**
 * (v0.10.31) Build a Foundry settings `choices` object (id → label) for a
 * model dropdown, filtered to the given provider and sorted FREE-first then by
 * ascending price. Two backwards-compatibility guarantees:
 *
 *   1. If `currentValue` is a model the user already configured that is NOT in
 *      the filtered catalogue (e.g. a hand-typed custom id from before this
 *      version), it is preserved as a selectable "(current)" entry at the top
 *      so upgrading never silently drops or changes their model.
 *   2. When `includeInherit` is true (the Vision Model setting), an "inherit"
 *      pseudo-choice is added first.
 *
 * @param {string} preset
 * @param {string} [currentValue]
 * @param {{includeInherit?: boolean}} [opts]
 * @returns {Record<string,string>}
 */
export function buildModelChoices(preset, currentValue, opts = {}) {
  const choices = {};
  const fallbackLabel = PROVIDER_LABELS[preset] || PROVIDER_LABELS.custom;

  if (opts.includeInherit) {
    try {
      choices.inherit = game.i18n.localize("ETERNAL_SKALD.settings.visionModel.choices.inherit");
    } catch (_) { choices.inherit = "Inherit main model"; }
  }

  const models = getModelsForProvider(preset);
  const ids = new Set(models.map(m => m.id));

  // Preserve a pre-existing custom value that isn't in the catalogue.
  const cur = (currentValue == null ? "" : String(currentValue)).trim();
  if (cur && cur !== "inherit" && !ids.has(cur)) {
    choices[cur] = `${cur} (current)`;
  }

  for (const m of models) {
    choices[m.id] = formatModelLabel(m, fallbackLabel);
  }
  return choices;
}

/**
 * (v0.10.31) OpenRouter API integration: fetch the live model catalogue from
 * the public `https://openrouter.ai/api/v1/models` endpoint, keep only
 * vision-capable models (image in their input modalities), normalise them to
 * the Skald's `{id,name,vendor,price}` shape, sort FREE-first by price, and
 * cache the result in {@link OPENROUTER_LIVE_MODELS}.
 *
 * Purely additive and fully defensive: this endpoint needs no API key, the
 * call is best-effort, and ANY failure (network/CORS/parse) leaves the static
 * {@link OPENROUTER_VISION_MODELS} list in place. Safe to call on `ready`.
 *
 * @returns {Promise<boolean>} true if the live list was refreshed
 */
export async function fetchOpenRouterVisionModels() {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      method: "GET",
      headers: { "Accept": "application/json" }
    });
    if (!res || !res.ok) return false;
    const json = await res.json();
    const data = Array.isArray(json?.data) ? json.data : [];
    if (!data.length) return false;

    const mapped = [];
    for (const m of data) {
      const id = m?.id;
      if (!id) continue;
      const inputs = m?.architecture?.input_modalities
        || m?.architecture?.modality
        || [];
      const inputsStr = Array.isArray(inputs) ? inputs.join("+") : String(inputs || "");
      if (!/image/i.test(inputsStr)) continue;          // vision-capable only
      // Pricing is a per-token string ("0.0000005"); convert to per-1M USD.
      const promptPrice = parseFloat(m?.pricing?.prompt);
      const price = Number.isFinite(promptPrice) ? promptPrice * 1e6 : 0;
      const vendor = String(id).split("/")[0] || "";
      mapped.push({
        id,
        name: m?.name || id,
        vendor,
        price: Number.isFinite(price) ? Number(price.toFixed(4)) : 0
      });
    }
    if (!mapped.length) return false;
    OPENROUTER_LIVE_MODELS = mapped;
    console.log(LOG_PREFIX, `OpenRouter live model list loaded (${mapped.length} vision models).`);
    return true;
  } catch (e) {
    console.warn(LOG_PREFIX, "fetchOpenRouterVisionModels failed (using static list):", e?.message || e);
    return false;
  }
}
