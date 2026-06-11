/* ===================================================================== */
/*  §1  CONSTANTS  (extracted from eternal-skald.js - Phase 2 refactor)   */
/* ===================================================================== */
/*
 * Pure, immutable data constants for The Eternal Skald. Extracted verbatim
 * from scripts/eternal-skald.js with zero behavioral change - the values,
 * names and order are unchanged; each definition is simply re-exported here
 * and imported back by the main module. This file has no dependencies.
 */

export const MODULE_ID  = "the-eternal-skald";
export const SKALD_NAME = "The Eternal Skald";
export const LOG_PREFIX = `${SKALD_NAME} |`;

/**
 * Default endpoint — Abacus AI OpenAI-compatible chat-completions API.
 * (v0.9.2) Aligned with the Abacus AI provider preset (the recommended,
 * default provider) so a fresh install's endpoint matches its default
 * provider selection.
 * (v0.9.3) Corrected the host/path: the working Abacus AI OpenAI-compatible
 * endpoint is `https://routellm.abacus.ai/v1/chat/completions`. The value
 * shipped in v0.9.2 (`https://api.abacus.ai/v0/chat/completions`) was a
 * non-functional URL; see `LEGACY_ABACUS_ENDPOINT` and
 * `migrateLegacyAbacusEndpoint()` for the backwards-compatible auto-migration
 * that quietly repairs existing installs still pointing at the bad URL.
 */
export const DEFAULT_ENDPOINT  = "https://routellm.abacus.ai/v1/chat/completions";
export const DEFAULT_MODEL     = "gemini-3-flash-preview";


/**
 * (v0.9.3) The non-functional Abacus AI endpoint that shipped as the default
 * in v0.9.2. Retained as a named constant so {@link migrateLegacyAbacusEndpoint}
 * can detect installs whose saved `apiEndpoint` is still pinned to this bad
 * URL and transparently repair them to {@link DEFAULT_ENDPOINT}. Do not reuse
 * this value for anything other than the migration check.
 * @type {string}
 */
export const LEGACY_ABACUS_ENDPOINT = "https://api.abacus.ai/v0/chat/completions";

/**
 * (v0.9.1) Provider presets for the AI Provider dropdown setting.
 * (v0.9.2) Added Abacus AI as the recommended, default preset.
 *
 * The Skald speaks to any OpenAI-compatible chat-completions endpoint, so
 * switching providers is purely a matter of pointing `apiEndpoint` at the
 * right URL (the user still supplies their own API key and model name
 * separately). This map drives both the dropdown's choices and the
 * auto-fill of `apiEndpoint` when a non-custom preset is chosen.
 *
 * **Abacus AI** is the recommended provider (the Skald is powered by Abacus AI
 * ChatLLM) and is the default selection. Its OpenAI-compatible endpoint is
 * `https://routellm.abacus.ai/v1/chat/completions`.
 * (v0.9.3) Corrected from the non-functional `https://api.abacus.ai/v0/...`
 * URL that shipped in v0.9.2; existing installs are auto-migrated by
 * {@link migrateLegacyAbacusEndpoint}.
 *
 * `endpoint: null` (the "custom" preset) means "leave whatever the user has
 * typed into the API Endpoint field untouched" — used for self-hosted
 * gateways, the legacy RouteLLM endpoint, or any other endpoint.
 *
 * Insertion order here also defines the dropdown order:
 *   Abacus AI (default) → OpenAI → OpenRouter → Google AI (Gemini) → Custom.
 *
 * @type {Record<string, {endpoint: string|null}>}
 */
export const PROVIDER_PRESETS = {
  abacus:     { endpoint: "https://routellm.abacus.ai/v1/chat/completions" }, // (v0.9.3) corrected from api.abacus.ai/v0
  openai:     { endpoint: "https://api.openai.com/v1/chat/completions" },
  openrouter: { endpoint: "https://openrouter.ai/api/v1/chat/completions" },
  google:     { endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" },
  custom:     { endpoint: null }
};

/*  §1b  VISION-CAPABLE MODEL CATALOGUE  (v0.10.31)                        */
/* ===================================================================== */
/**
 * Curated catalogue of vision-capable (image→text) models, embedded so the
 * AI Model / Vision Model dropdowns can be populated and FILTERED by the
 * selected AI Provider (see {@link PROVIDER_PRESETS}). Generated from the
 * project's vision-model research (prices in USD per 1M input tokens; FREE
 * models are price 0). This data is purely additive — it drives dropdown
 * choices only and never changes how a request is sent (the {@link Client}
 * still posts the chosen `modelName` verbatim), so existing custom model
 * names keep working unchanged.
 *
 * Two source lists:
 *   • {@link OPENROUTER_VISION_MODELS} — full `vendor/model` ids for the
 *     OpenRouter aggregator (also the source for per-vendor OpenAI / Google
 *     native lists, with the vendor prefix stripped).
 *   • {@link ABACUS_VISION_MODELS} — bare ids for the Abacus AI RouteLLM
 *     endpoint (the Skald's default provider).
 *
 * @see getModelsForProvider
 * @see buildModelChoices
 */
export const OPENROUTER_VISION_MODELS = [
  { id: "nex-agi/nex-n2-pro:free", name: "Nex AGI: Nex-N2-Pro (free)", vendor: "nex-agi", price: 0.0 },
  { id: "nvidia/nemotron-3.5-content-safety:free", name: "NVIDIA: Nemotron 3.5 Content Safety (free)", vendor: "nvidia", price: 0.0 },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "NVIDIA: Nemotron 3 Nano Omni (free)", vendor: "nvidia", price: 0.0 },
  { id: "moonshotai/kimi-k2.6:free", name: "MoonshotAI: Kimi K2.6 (free)", vendor: "moonshotai", price: 0.0 },
  { id: "google/gemma-4-26b-a4b-it:free", name: "Google: Gemma 4 26B A4B  (free)", vendor: "google", price: 0.0 },
  { id: "google/gemma-4-31b-it:free", name: "Google: Gemma 4 31B (free)", vendor: "google", price: 0.0 },
  { id: "google/lyria-3-pro-preview", name: "Google: Lyria 3 Pro Preview", vendor: "google", price: 0.0 },
  { id: "google/lyria-3-clip-preview", name: "Google: Lyria 3 Clip Preview", vendor: "google", price: 0.0 },
  { id: "nvidia/nemotron-nano-12b-v2-vl:free", name: "NVIDIA: Nemotron Nano 12B 2 VL (free)", vendor: "nvidia", price: 0.0 },
  { id: "google/gemma-3-4b-it", name: "Google: Gemma 3 4B", vendor: "google", price: 0.05 },
  { id: "google/gemma-3-12b-it", name: "Google: Gemma 3 12B", vendor: "google", price: 0.05 },
  { id: "openai/gpt-5-nano", name: "OpenAI: GPT-5 Nano", vendor: "openai", price: 0.05 },
  { id: "amazon/nova-lite-v1", name: "Amazon: Nova Lite 1.0", vendor: "amazon", price: 0.06 },
  { id: "google/gemma-4-26b-a4b-it", name: "Google: Gemma 4 26B A4B", vendor: "google", price: 0.06 },
  { id: "qwen/qwen3.5-flash-02-23", name: "Qwen: Qwen3.5-Flash", vendor: "qwen", price: 0.07 },
  { id: "mistralai/mistral-small-3.2-24b-instruct", name: "Mistral: Mistral Small 3.2 24B", vendor: "mistralai", price: 0.07 },
  { id: "bytedance-seed/seed-1.6-flash", name: "ByteDance Seed: Seed 1.6 Flash", vendor: "bytedance-seed", price: 0.07 },
  { id: "google/gemma-3-27b-it", name: "Google: Gemma 3 27B", vendor: "google", price: 0.08 },
  { id: "qwen/qwen3-vl-8b-instruct", name: "Qwen: Qwen3 VL 8B Instruct", vendor: "qwen", price: 0.08 },
  { id: "rekaai/reka-edge", name: "Reka Edge", vendor: "rekaai", price: 0.1 },
  { id: "mistralai/ministral-3b-2512", name: "Mistral: Ministral 3 3B 2512", vendor: "mistralai", price: 0.1 },
  { id: "qwen/qwen3.5-9b", name: "Qwen: Qwen3.5-9B", vendor: "qwen", price: 0.1 },
  { id: "bytedance/ui-tars-1.5-7b", name: "ByteDance: UI-TARS 7B", vendor: "bytedance", price: 0.1 },
  { id: "meta-llama/llama-4-scout", name: "Meta: Llama 4 Scout", vendor: "meta-llama", price: 0.1 },
  { id: "bytedance-seed/seed-2.0-mini", name: "ByteDance Seed: Seed-2.0-Mini", vendor: "bytedance-seed", price: 0.1 },
  { id: "google/gemini-2.5-flash-lite-preview-09-2025", name: "Google: Gemini 2.5 Flash Lite Preview 09-2025", vendor: "google", price: 0.1 },
  { id: "google/gemini-2.5-flash-lite", name: "Google: Gemini 2.5 Flash Lite", vendor: "google", price: 0.1 },
  { id: "openai/gpt-4.1-nano", name: "OpenAI: GPT-4.1 Nano", vendor: "openai", price: 0.1 },
  { id: "qwen/qwen3-vl-32b-instruct", name: "Qwen: Qwen3 VL 32B Instruct", vendor: "qwen", price: 0.1 },
  { id: "qwen/qwen3-vl-8b-thinking", name: "Qwen: Qwen3 VL 8B Thinking", vendor: "qwen", price: 0.12 },
  { id: "google/gemma-4-31b-it", name: "Google: Gemma 4 31B", vendor: "google", price: 0.12 },
  { id: "qwen/qwen3-vl-30b-a3b-instruct", name: "Qwen: Qwen3 VL 30B A3B Instruct", vendor: "qwen", price: 0.13 },
  { id: "qwen/qwen3-vl-30b-a3b-thinking", name: "Qwen: Qwen3 VL 30B A3B Thinking", vendor: "qwen", price: 0.13 },
  { id: "xiaomi/mimo-v2.5", name: "Xiaomi: MiMo-V2.5", vendor: "xiaomi", price: 0.14 },
  { id: "qwen/qwen3.6-35b-a3b", name: "Qwen: Qwen3.6 35B A3B", vendor: "qwen", price: 0.14 },
  { id: "qwen/qwen3.5-35b-a3b", name: "Qwen: Qwen3.5-35B-A3B", vendor: "qwen", price: 0.14 },
  { id: "mistralai/ministral-8b-2512", name: "Mistral: Ministral 3 8B 2512", vendor: "mistralai", price: 0.15 },
  { id: "mistralai/mistral-small-2603", name: "Mistral: Mistral Small 4", vendor: "mistralai", price: 0.15 },
  { id: "meta-llama/llama-4-maverick", name: "Meta: Llama 4 Maverick", vendor: "meta-llama", price: 0.15 },
  { id: "openai/gpt-4o-mini-2024-07-18", name: "OpenAI: GPT-4o-mini (2024-07-18)", vendor: "openai", price: 0.15 },
  { id: "openai/gpt-4o-mini", name: "OpenAI: GPT-4o-mini", vendor: "openai", price: 0.15 },
  { id: "perceptron/perceptron-mk1", name: "Perceptron: Perceptron Mk1", vendor: "perceptron", price: 0.15 },
  { id: "meta-llama/llama-guard-4-12b", name: "Meta: Llama Guard 4 12B", vendor: "meta-llama", price: 0.18 },
  { id: "qwen/qwen3.6-flash", name: "Qwen: Qwen3.6 Flash", vendor: "qwen", price: 0.19 },
  { id: "qwen/qwen3.5-27b", name: "Qwen: Qwen3.5-27B", vendor: "qwen", price: 0.2 },
  { id: "mistralai/ministral-14b-2512", name: "Mistral: Ministral 3 14B 2512", vendor: "mistralai", price: 0.2 },
  { id: "qwen/qwen3-vl-235b-a22b-instruct", name: "Qwen: Qwen3 VL 235B A22B Instruct", vendor: "qwen", price: 0.2 },
  { id: "minimax/minimax-01", name: "MiniMax: MiniMax-01", vendor: "minimax", price: 0.2 },
  { id: "stepfun/step-3.7-flash", name: "StepFun: Step 3.7 Flash", vendor: "stepfun", price: 0.2 },
  { id: "openai/gpt-5.4-nano", name: "OpenAI: GPT-5.4 Nano", vendor: "openai", price: 0.2 },
  { id: "qwen/qwen2.5-vl-72b-instruct", name: "Qwen: Qwen2.5 VL 72B Instruct", vendor: "qwen", price: 0.25 },
  { id: "anthropic/claude-3-haiku", name: "Anthropic: Claude 3 Haiku", vendor: "anthropic", price: 0.25 },
  { id: "google/gemini-3.1-flash-lite", name: "Google: Gemini 3.1 Flash Lite", vendor: "google", price: 0.25 },
  { id: "google/gemini-3.1-flash-lite-preview", name: "Google: Gemini 3.1 Flash Lite Preview", vendor: "google", price: 0.25 },
  { id: "bytedance-seed/seed-2.0-lite", name: "ByteDance Seed: Seed-2.0-Lite", vendor: "bytedance-seed", price: 0.25 },
  { id: "bytedance-seed/seed-1.6", name: "ByteDance Seed: Seed 1.6", vendor: "bytedance-seed", price: 0.25 },
  { id: "openai/gpt-5.1-codex-mini", name: "OpenAI: GPT-5.1-Codex-Mini", vendor: "openai", price: 0.25 },
  { id: "openai/gpt-5-mini", name: "OpenAI: GPT-5 Mini", vendor: "openai", price: 0.25 },
  { id: "qwen/qwen3.5-plus-02-15", name: "Qwen: Qwen3.5 Plus 2026-02-15", vendor: "qwen", price: 0.26 },
  { id: "qwen/qwen3.5-122b-a10b", name: "Qwen: Qwen3.5-122B-A10B", vendor: "qwen", price: 0.26 },
  { id: "qwen/qwen3-vl-235b-a22b-thinking", name: "Qwen: Qwen3 VL 235B A22B Thinking", vendor: "qwen", price: 0.26 },
  { id: "qwen/qwen3.6-27b", name: "Qwen: Qwen3.6 27B", vendor: "qwen", price: 0.29 },
  { id: "z-ai/glm-4.6v", name: "Z.ai: GLM 4.6V", vendor: "z-ai", price: 0.3 },
  { id: "minimax/minimax-m3", name: "MiniMax: MiniMax M3", vendor: "minimax", price: 0.3 },
  { id: "qwen/qwen3.5-plus-20260420", name: "Qwen: Qwen3.5 Plus 2026-04-20", vendor: "qwen", price: 0.3 },
  { id: "amazon/nova-2-lite-v1", name: "Amazon: Nova 2 Lite", vendor: "amazon", price: 0.3 },
  { id: "google/gemini-2.5-flash-image", name: "Google: Nano Banana (Gemini 2.5 Flash Image)", vendor: "google", price: 0.3 },
  { id: "google/gemini-2.5-flash", name: "Google: Gemini 2.5 Flash", vendor: "google", price: 0.3 },
  { id: "qwen/qwen3.6-plus", name: "Qwen: Qwen3.6 Plus", vendor: "qwen", price: 0.33 },
  { id: "meta-llama/llama-3.2-11b-vision-instruct", name: "Meta: Llama 3.2 11B Vision Instruct", vendor: "meta-llama", price: 0.34 },
  { id: "mistralai/mistral-small-3.1-24b-instruct", name: "Mistral: Mistral Small 3.1 24B", vendor: "mistralai", price: 0.35 },
  { id: "qwen/qwen3.5-397b-a17b", name: "Qwen: Qwen3.5 397B A17B", vendor: "qwen", price: 0.39 },
  { id: "qwen/qwen3.7-plus", name: "Qwen: Qwen3.7 Plus", vendor: "qwen", price: 0.4 },
  { id: "openai/gpt-4.1-mini", name: "OpenAI: GPT-4.1 Mini", vendor: "openai", price: 0.4 },
  { id: "moonshotai/kimi-k2.5", name: "MoonshotAI: Kimi K2.5", vendor: "moonshotai", price: 0.4 },
  { id: "mistralai/mistral-medium-3.1", name: "Mistral: Mistral Medium 3.1", vendor: "mistralai", price: 0.4 },
  { id: "mistralai/mistral-medium-3", name: "Mistral: Mistral Medium 3", vendor: "mistralai", price: 0.4 },
  { id: "baidu/ernie-4.5-vl-424b-a47b", name: "Baidu: ERNIE 4.5 VL 424B A47B", vendor: "baidu", price: 0.42 },
  { id: "mistralai/mistral-large-2512", name: "Mistral: Mistral Large 3 2512", vendor: "mistralai", price: 0.5 },
  { id: "google/gemini-3.1-flash-image-preview", name: "Google: Nano Banana 2 (Gemini 3.1 Flash Image Preview)", vendor: "google", price: 0.5 },
  { id: "google/gemini-3-flash-preview", name: "Google: Gemini 3 Flash Preview", vendor: "google", price: 0.5 },
  { id: "z-ai/glm-4.5v", name: "Z.ai: GLM 4.5V", vendor: "z-ai", price: 0.6 },
  { id: "moonshotai/kimi-k2.6", name: "MoonshotAI: Kimi K2.6", vendor: "moonshotai", price: 0.68 },
  { id: "openai/gpt-5.4-mini", name: "OpenAI: GPT-5.4 Mini", vendor: "openai", price: 0.75 },
  { id: "amazon/nova-pro-v1", name: "Amazon: Nova Pro 1.0", vendor: "amazon", price: 0.8 },
  { id: "anthropic/claude-3.5-haiku", name: "Anthropic: Claude 3.5 Haiku", vendor: "anthropic", price: 0.8 },
  { id: "perplexity/sonar", name: "Perplexity: Sonar", vendor: "perplexity", price: 1.0 },
  { id: "x-ai/grok-build-0.1", name: "xAI: Grok Build 0.1", vendor: "x-ai", price: 1.0 },
  { id: "anthropic/claude-haiku-4.5", name: "Anthropic: Claude Haiku 4.5", vendor: "anthropic", price: 1.0 },
  { id: "openai/o4-mini-high", name: "OpenAI: o4 Mini High", vendor: "openai", price: 1.1 },
  { id: "openai/o4-mini", name: "OpenAI: o4 Mini", vendor: "openai", price: 1.1 },
  { id: "x-ai/grok-4.3", name: "xAI: Grok 4.3", vendor: "x-ai", price: 1.25 },
  { id: "x-ai/grok-4.20", name: "xAI: Grok 4.20", vendor: "x-ai", price: 1.25 },
  { id: "openai/gpt-5.1-codex-max", name: "OpenAI: GPT-5.1-Codex-Max", vendor: "openai", price: 1.25 },
  { id: "openai/gpt-5.1", name: "OpenAI: GPT-5.1", vendor: "openai", price: 1.25 },
  { id: "openai/gpt-5.1-chat", name: "OpenAI: GPT-5.1 Chat", vendor: "openai", price: 1.25 },
  { id: "openai/gpt-5.1-codex", name: "OpenAI: GPT-5.1-Codex", vendor: "openai", price: 1.25 },
  { id: "openai/gpt-5-codex", name: "OpenAI: GPT-5 Codex", vendor: "openai", price: 1.25 },
  { id: "openai/gpt-5-chat", name: "OpenAI: GPT-5 Chat", vendor: "openai", price: 1.25 },
  { id: "openai/gpt-5", name: "OpenAI: GPT-5", vendor: "openai", price: 1.25 },
  { id: "google/gemini-2.5-pro", name: "Google: Gemini 2.5 Pro", vendor: "google", price: 1.25 },
  { id: "google/gemini-2.5-pro-preview", name: "Google: Gemini 2.5 Pro Preview 06-05", vendor: "google", price: 1.25 },
  { id: "google/gemini-2.5-pro-preview-05-06", name: "Google: Gemini 2.5 Pro Preview 05-06", vendor: "google", price: 1.25 },
  { id: "mistralai/mistral-medium-3-5", name: "Mistral: Mistral Medium 3.5", vendor: "mistralai", price: 1.5 },
  { id: "google/gemini-3.5-flash", name: "Google: Gemini 3.5 Flash", vendor: "google", price: 1.5 },
  { id: "openai/gpt-5.3-chat", name: "OpenAI: GPT-5.3 Chat", vendor: "openai", price: 1.75 },
  { id: "openai/gpt-5.3-codex", name: "OpenAI: GPT-5.3-Codex", vendor: "openai", price: 1.75 },
  { id: "openai/gpt-5.2-codex", name: "OpenAI: GPT-5.2-Codex", vendor: "openai", price: 1.75 },
  { id: "openai/gpt-5.2-chat", name: "OpenAI: GPT-5.2 Chat", vendor: "openai", price: 1.75 },
  { id: "openai/gpt-5.2", name: "OpenAI: GPT-5.2", vendor: "openai", price: 1.75 },
  { id: "x-ai/grok-4.20-multi-agent", name: "xAI: Grok 4.20 Multi-Agent", vendor: "x-ai", price: 2.0 },
  { id: "openai/o4-mini-deep-research", name: "OpenAI: o4 Mini Deep Research", vendor: "openai", price: 2.0 },
  { id: "openai/o3", name: "OpenAI: o3", vendor: "openai", price: 2.0 },
  { id: "openai/gpt-4.1", name: "OpenAI: GPT-4.1", vendor: "openai", price: 2.0 },
  { id: "perplexity/sonar-reasoning-pro", name: "Perplexity: Sonar Reasoning Pro", vendor: "perplexity", price: 2.0 },
  { id: "google/gemini-3.1-pro-preview-customtools", name: "Google: Gemini 3.1 Pro Preview Custom Tools", vendor: "google", price: 2.0 },
  { id: "google/gemini-3.1-pro-preview", name: "Google: Gemini 3.1 Pro Preview", vendor: "google", price: 2.0 },
  { id: "google/gemini-3-pro-image-preview", name: "Google: Nano Banana Pro (Gemini 3 Pro Image Preview)", vendor: "google", price: 2.0 },
  { id: "openai/gpt-5-image-mini", name: "OpenAI: GPT-5 Image Mini", vendor: "openai", price: 2.5 },
  { id: "openai/gpt-4o-2024-11-20", name: "OpenAI: GPT-4o (2024-11-20)", vendor: "openai", price: 2.5 },
  { id: "openai/gpt-4o-2024-08-06", name: "OpenAI: GPT-4o (2024-08-06)", vendor: "openai", price: 2.5 },
  { id: "openai/gpt-4o", name: "OpenAI: GPT-4o", vendor: "openai", price: 2.5 },
  { id: "amazon/nova-premier-v1", name: "Amazon: Nova Premier 1.0", vendor: "amazon", price: 2.5 },
  { id: "openai/gpt-5.4", name: "OpenAI: GPT-5.4", vendor: "openai", price: 2.5 },
  { id: "anthropic/claude-sonnet-4.6", name: "Anthropic: Claude Sonnet 4.6", vendor: "anthropic", price: 3.0 },
  { id: "perplexity/sonar-pro-search", name: "Perplexity: Sonar Pro Search", vendor: "perplexity", price: 3.0 },
  { id: "anthropic/claude-sonnet-4.5", name: "Anthropic: Claude Sonnet 4.5", vendor: "anthropic", price: 3.0 },
  { id: "anthropic/claude-sonnet-4", name: "Anthropic: Claude Sonnet 4", vendor: "anthropic", price: 3.0 },
  { id: "perplexity/sonar-pro", name: "Perplexity: Sonar Pro", vendor: "perplexity", price: 3.0 },
  { id: "openai/gpt-4o-2024-05-13", name: "OpenAI: GPT-4o (2024-05-13)", vendor: "openai", price: 5.0 },
  { id: "anthropic/claude-opus-4.8", name: "Anthropic: Claude Opus 4.8", vendor: "anthropic", price: 5.0 },
  { id: "anthropic/claude-opus-4.7", name: "Anthropic: Claude Opus 4.7", vendor: "anthropic", price: 5.0 },
  { id: "anthropic/claude-opus-4.6", name: "Anthropic: Claude Opus 4.6", vendor: "anthropic", price: 5.0 },
  { id: "anthropic/claude-opus-4.5", name: "Anthropic: Claude Opus 4.5", vendor: "anthropic", price: 5.0 },
  { id: "openai/gpt-chat-latest", name: "OpenAI: GPT Chat Latest", vendor: "openai", price: 5.0 },
  { id: "openai/gpt-5.5", name: "OpenAI: GPT-5.5", vendor: "openai", price: 5.0 },
  { id: "openai/gpt-5.4-image-2", name: "OpenAI: GPT-5.4 Image 2", vendor: "openai", price: 8.0 },
  { id: "openai/gpt-5-image", name: "OpenAI: GPT-5 Image", vendor: "openai", price: 10.0 },
  { id: "openai/gpt-4-turbo", name: "OpenAI: GPT-4 Turbo", vendor: "openai", price: 10.0 },
  { id: "openai/o3-deep-research", name: "OpenAI: o3 Deep Research", vendor: "openai", price: 10.0 },
  { id: "anthropic/claude-fable-5", name: "Anthropic: Claude Fable 5", vendor: "anthropic", price: 10.0 },
  { id: "anthropic/claude-opus-4.8-fast", name: "Anthropic: Claude Opus 4.8 (Fast)", vendor: "anthropic", price: 10.0 },
  { id: "openai/o1", name: "OpenAI: o1", vendor: "openai", price: 15.0 },
  { id: "anthropic/claude-opus-4.1", name: "Anthropic: Claude Opus 4.1", vendor: "anthropic", price: 15.0 },
  { id: "anthropic/claude-opus-4", name: "Anthropic: Claude Opus 4", vendor: "anthropic", price: 15.0 },
  { id: "openai/gpt-5-pro", name: "OpenAI: GPT-5 Pro", vendor: "openai", price: 15.0 },
  { id: "openai/o3-pro", name: "OpenAI: o3 Pro", vendor: "openai", price: 20.0 },
  { id: "openai/gpt-5.2-pro", name: "OpenAI: GPT-5.2 Pro", vendor: "openai", price: 21.0 },
  { id: "anthropic/claude-opus-4.7-fast", name: "Anthropic: Claude Opus 4.7 (Fast)", vendor: "anthropic", price: 30.0 },
  { id: "anthropic/claude-opus-4.6-fast", name: "Anthropic: Claude Opus 4.6 (Fast)", vendor: "anthropic", price: 30.0 },
  { id: "openai/gpt-5.5-pro", name: "OpenAI: GPT-5.5 Pro", vendor: "openai", price: 30.0 },
  { id: "openai/gpt-5.4-pro", name: "OpenAI: GPT-5.4 Pro", vendor: "openai", price: 30.0 },
  { id: "openai/o1-pro", name: "OpenAI: o1-pro", vendor: "openai", price: 150.0 }
];

export const ABACUS_VISION_MODELS = [
  { id: "nano_banana", name: "Nano Banana", price: 0.0 },
  { id: "nano_banana_pro", name: "Nano Banana Pro", price: 0.0 },
  { id: "nano_banana2", name: "Nano Banana 2", price: 0.0 },
  { id: "gpt-5-nano", name: "GPT-5 Nano", price: 0.05 },
  { id: "gpt-4.1-nano", name: "GPT-4.1 Nano", price: 0.1 },
  { id: "google/gemma-4-31b-it", name: "Gemma 4 31B IT", price: 0.14 },
  { id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8", name: "Llama 4 Maverick", price: 0.14 },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", price: 0.15 },
  { id: "gpt-5.4-nano", name: "GPT-5.4 Nano", price: 0.2 },
  { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", price: 0.25 },
  { id: "gpt-5-mini", name: "GPT-5 Mini", price: 0.25 },
  { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", price: 0.3 },
  { id: "gemini-2.5-flash-image", name: "Nano Banana (Gemini 2.5 Flash Image)", price: 0.3 },
  { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", price: 0.4 },
  { id: "gemini-3.1-flash-image-preview", name: "Nano Banana 2 (Gemini 3.1 Flash Image)", price: 0.5 },
  { id: "gemini-3-flash-preview", name: "Gemini 3 Flash", price: 0.5 },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", price: 0.75 },
  { id: "kimi-k2.6", name: "Kimi K2.6", price: 0.95 },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", price: 1.0 },
  { id: "o4-mini", name: "o4 Mini", price: 1.1 },
  { id: "grok-4.3", name: "Grok 4.3", price: 1.25 },
  { id: "gpt-5", name: "GPT-5", price: 1.25 },
  { id: "gpt-5-codex", name: "GPT-5 Codex", price: 1.25 },
  { id: "gpt-5.1", name: "GPT-5.1", price: 1.25 },
  { id: "gpt-5.1-codex", name: "GPT-5.1 Codex", price: 1.25 },
  { id: "gpt-5.1-chat-latest", name: "GPT-5.1 Instant", price: 1.25 },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", price: 1.25 },
  { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", price: 1.5 },
  { id: "gpt-5.2", name: "GPT-5.2", price: 1.75 },
  { id: "gpt-5.2-chat-latest", name: "GPT-5.2 Instant", price: 1.75 },
  { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", price: 1.75 },
  { id: "gpt-5.3-chat-latest", name: "GPT-5.3 Instant", price: 1.75 },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", price: 1.75 },
  { id: "gpt-5.3-codex-xhigh", name: "GPT-5.3 Codex XHigh", price: 1.75 },
  { id: "grok-4.20-beta-0309-non-reasoning", name: "Grok 4.2", price: 2.0 },
  { id: "o3", name: "o3", price: 2.0 },
  { id: "gpt-4.1", name: "GPT-4.1", price: 2.0 },
  { id: "gemini-3-pro-image-preview", name: "Nano Banana (Gemini 3 Pro Image)", price: 2.0 },
  { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", price: 2.0 },
  { id: "gpt-4o", name: "GPT-4o", price: 2.5 },
  { id: "gpt-5.4", name: "GPT-5.4", price: 2.5 },
  { id: "route-llm", name: "RouteLLM", price: 3.0 },
  { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", price: 3.0 },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", price: 3.0 },
  { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5", price: 5.0 },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", price: 5.0 },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", price: 5.0 },
  { id: "claude-opus-4-7-xhigh", name: "Claude Opus 4.7 XHigh", price: 5.0 },
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", price: 5.0 },
  { id: "claude-opus-4-8-xhigh", name: "Claude Opus 4.8 XHigh", price: 5.0 },
  { id: "gpt-5.5", name: "GPT-5.5", price: 5.0 },
  { id: "chat-latest", name: "GPT-5.5 Instant", price: 5.0 },
  { id: "claude-fable-5", name: "Claude Fable 5", price: 10.0 },
  { id: "claude-fable-5-xhigh", name: "Claude Fable 5 XHigh", price: 10.0 },
  { id: "claude-opus-4-1-20250805", name: "Claude Opus 4.1", price: 15.0 },
  { id: "o3-pro", name: "o3 Pro", price: 20.0 }
];

/**
 * (v0.10.31) Maps an AI Provider preset key (a key of {@link PROVIDER_PRESETS})
 * to a human-friendly label used when no per-model vendor is known.
 * @type {Record<string,string>}
 */
export const PROVIDER_LABELS = {
  abacus:     "Abacus.AI",
  openai:     "OpenAI",
  openrouter: "OpenRouter",
  google:     "Google",
  custom:     "Custom"
};

// Foundry VTT v14 validates messages starting with "/" against an
// internal command registry BEFORE the `chatMessage` hook fires, and
// rejects unknown ones with a "not a valid chat message command"
// error. To bypass that pre-validation we use "!" as our command
// prefix — Foundry leaves "!" messages alone and our hook gets to
// inspect them.
export const COMMANDS = Object.freeze({
  SKALD:    "!skald",
  ORACLE:   "!oracle",
  NPC:      "!npc",
  SCENE:    "!scene",
  LORE:     "!lore",
  COMBAT:   "!combat",
  HELP:     "!skald-help",
  // --- Journal system (v0.4.0) ---
  JOURNAL:  "!journal",
  JOURNALS: "!journals",
  MYSTERIES:"!mysteries",
  REMIND:   "!remind",
  END_SESSION: "!end-session",
  // --- Browser-based RAG / AI memory (v0.5.0) ---
  REINDEX:    "!reindex",
  RAG_STATUS: "!rag-status",
  // --- Living Chronicle (v0.8.0) ---
  TIMELINE:      "!timeline",
  RELATIONSHIPS: "!relationships",
  MAP:           "!map",
  TEMPLATE:      "!template",
  // --- UX / polish (v0.9.0) ---
  LINK_STYLE:    "!link-style",
  // --- Maintenance (v0.10.16) ---
  RESET:         "!skald-reset",
  WIPE:          "!skald-wipe",
  // --- Map vision / scouting (v0.10.23) ---
  SCOUT:        "!scout",
  SURVEY:       "!survey",
  ANALYZE_MAP:  "!analyze-map"
});

