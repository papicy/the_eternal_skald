/* =====================================================================
 *  F6 — Ollama / local-LLM provider support (v0.20.0)
 *
 *  Two layers, matching the project's convention:
 *    • Structural source-guards: the provider preset, label, dropdown case,
 *      settings choice and i18n label are all wired.
 *    • Behavioural: the importable helper (scripts/ai/ollama-client.js) is a
 *      pure ESM module with no Foundry deps, so we exercise it directly —
 *      keyless-auth resolution, base-URL derivation, and model discovery
 *      (with an injected fetch) including the fail-soft empty-array path.
 *
 *  Run: node test/ollama-provider.test.mjs
 * ===================================================================== */

import { readSkaldSource } from "./_skald-source.mjs";
import {
  OLLAMA_COMMON_MODELS,
  resolveOllamaApiKey,
  ollamaBaseFromEndpoint,
  fetchOllamaModels
} from "../scripts/ai/ollama-client.js";

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

console.log("F6 — Ollama provider support\n");

const SRC = readSkaldSource();

/* ---- [1] structural wiring -------------------------------------------- */
ok(/ollama:\s*\{\s*endpoint:\s*["']http:\/\/localhost:11434\/v1\/chat\/completions["']/.test(SRC),
   "[1] PROVIDER_PRESETS has an ollama entry pointing at the local OpenAI-compatible endpoint");
ok(/ollama:\s*["']Ollama["']/.test(SRC),
   "[1] PROVIDER_LABELS maps ollama → 'Ollama'");
ok(/case\s+["']ollama["']:/.test(SRC),
   "[1] getModelsForProvider has an 'ollama' case");
ok(/ollama:\s*game\.i18n\.localize\(["']ETERNAL_SKALD\.settings\.providerPreset\.choices\.ollama["']\)/.test(SRC),
   "[1] settings providerPreset registers the ollama choice");
ok(/resolveOllamaApiKey\(/.test(SRC),
   "[1] client.js routes the api key through resolveOllamaApiKey");

/* ---- [2] keyless local auth ------------------------------------------ */
eq(resolveOllamaApiKey("ollama", ""), "ollama",
   "[2] empty key on ollama → placeholder so the no-key guard does not block local inference");
eq(resolveOllamaApiKey("ollama", "   "), "ollama",
   "[2] whitespace-only key on ollama → placeholder");
eq(resolveOllamaApiKey("ollama", "my-real-key"), "my-real-key",
   "[2] an explicit ollama key is preserved verbatim");
eq(resolveOllamaApiKey("openai", ""), "",
   "[2] empty key on a hosted provider stays empty (existing guard still fires)");
eq(resolveOllamaApiKey("abacus", "k"), "k",
   "[2] hosted provider key passes through unchanged");
eq(resolveOllamaApiKey("ollama", null), "ollama",
   "[2] null key on ollama is tolerated → placeholder (never throws)");

/* ---- [3] base-URL derivation ----------------------------------------- */
eq(ollamaBaseFromEndpoint("http://localhost:11434/v1/chat/completions"), "http://localhost:11434",
   "[3] strips the /v1/chat/completions suffix");
eq(ollamaBaseFromEndpoint("http://192.168.1.50:11434/v1/chat/completions/"), "http://192.168.1.50:11434",
   "[3] tolerates a trailing slash and custom host");
eq(ollamaBaseFromEndpoint(""), "http://localhost:11434",
   "[3] empty endpoint → default base");
eq(ollamaBaseFromEndpoint(undefined), "http://localhost:11434",
   "[3] undefined endpoint → default base (never throws)");

/* ---- [4] curated fallback catalogue ---------------------------------- */
ok(Array.isArray(OLLAMA_COMMON_MODELS) && OLLAMA_COMMON_MODELS.length > 0,
   "[4] there is a non-empty curated common-model list");
ok(OLLAMA_COMMON_MODELS.every(m => m.price === 0),
   "[4] local models are priced 0 (free — sorts first in the dropdown)");
ok(OLLAMA_COMMON_MODELS.some(m => /llama/i.test(m.id)) && OLLAMA_COMMON_MODELS.some(m => /mistral/i.test(m.id)),
   "[4] catalogue includes common models (llama, mistral)");

/* ---- [5] model discovery (injected fetch, fail-soft) ----------------- */
async function run() {
  // happy path: Ollama /api/tags shape
  const okFetch = async (url) => {
    ok(/\/api\/tags$/.test(url), "[5] discovery calls the native /api/tags endpoint");
    return { ok: true, json: async () => ({ models: [{ name: "llama3.1:latest" }, { model: "mistral:7b" }] }) };
  };
  const models = await fetchOllamaModels("http://localhost:11434", { fetchImpl: okFetch });
  eq(models.length, 2, "[5] both discovered tags are returned");
  eq(models[0].id, "llama3.1:latest", "[5] reads the `name` field");
  eq(models[1].id, "mistral:7b", "[5] falls back to the `model` field");
  ok(models.every(m => m.vendor === "ollama" && m.price === 0), "[5] discovered models are tagged ollama/free");

  // failure paths → empty array (never throws)
  const errFetch = async () => { throw new Error("ECONNREFUSED"); };
  eq((await fetchOllamaModels("http://localhost:11434", { fetchImpl: errFetch })).length, 0,
     "[5] network error → empty array (fail-soft)");
  const badStatus = async () => ({ ok: false, json: async () => ({}) });
  eq((await fetchOllamaModels("http://localhost:11434", { fetchImpl: badStatus })).length, 0,
     "[5] non-OK status → empty array");
  const noFetch = await fetchOllamaModels("http://localhost:11434", { fetchImpl: null });
  eq(noFetch.length, 0, "[5] absent fetch impl → empty array (never throws)");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
run();
