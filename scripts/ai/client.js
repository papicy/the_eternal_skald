import { LOG_PREFIX, DEFAULT_MODEL, DEFAULT_ENDPOINT } from "../core/constants.js";
import { isCatalogueVisionModel } from "../core/model-catalogue.js";
import { Settings } from "../core/settings.js";
import { resolveOllamaApiKey } from "./ollama-client.js";

/**
 * The ONE endpoint this client talks to. It's a relative URL so it
 * resolves same-origin against whatever host/port/protocol Foundry is
 * served from. The server-side hook (eternal-skald-server.mjs) handles
 * this path and forwards to the upstream LLM. No CORS. No proxy. Done.
 */
const API_PATH = "/skald-api/chat";

/**
 * Streaming sibling of {@link API_PATH} (v0.3.3). The server-side hook
 * pipes the upstream LLM's Server-Sent-Events token stream straight back
 * through this path so the client can render the reply as it arrives.
 */
const STREAM_PATH = "/skald-api/chat-stream";

export const Client = {
  /**
   * (v0.10.23) Heuristically decide whether a model name denotes a
   * vision-capable (multimodal) model that can accept inline images via the
   * OpenAI-compatible `image_url` content part.
   *
   * This is a NAME-based heuristic (there is no portable capability endpoint
   * across the providers the Skald supports), kept deliberately broad and
   * forgiving. Unknown models default to NOT vision-capable so the caller can
   * degrade gracefully instead of wasting a call on a text-only model.
   *
   * Recognised families (case-insensitive substring match):
   *   • OpenAI      gpt-4o / gpt-4o-mini / gpt-4-vision / gpt-4-turbo / o1 / o3 / o4
   *   • Google      gemini (1.5 / 2.x / 3.x — all modern Gemini models are multimodal)
   *   • Anthropic   claude-3 / claude-3.5 / claude-3.7 / claude-4 (Sonnet/Opus/Haiku)
   *   • Meta        llama-3.2 vision, llama-4
   *   • Misc        pixtral, qwen-vl / qwen2-vl, llava, grok-vision / grok-2-vision
   *
   * @param {string} model - the model identifier
   * @returns {boolean} true iff the model is believed to accept images
   */
  _modelSupportsVision(model) {
    const m = String(model || "").toLowerCase();
    if (!m) return false;
    // (v0.10.31) Authoritative check first: any model in the curated
    // vision-model catalogue (incl. the live OpenRouter list) is, by
    // definition, vision-capable. This avoids false negatives for families the
    // name heuristic below doesn't know (e.g. kimi, seed, nemotron, gemma,
    // nano_banana, minimax) now that the dropdowns offer them directly.
    try { if (isCatalogueVisionModel(model)) return true; } catch (_) { /* fall through to heuristic */ }
    // Explicit "vision"/"-vl"/multimodal markers anywhere in the name.
    if (/(vision|multimodal|-vl\b|\bvl-|llava)/.test(m)) return true;
    // OpenAI GPT-4o + GPT-4 Turbo + reasoning o-series (all multimodal).
    if (/gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-1106|gpt-5/.test(m)) return true;
    if (/\bo1\b|\bo3\b|\bo4\b|o1-|o3-|o4-/.test(m)) return true;
    // Google Gemini — every modern Gemini model is multimodal.
    if (/gemini/.test(m)) return true;
    // Anthropic Claude 3 and newer accept images; Claude 2 / instant do not.
    if (/claude-3|claude-4|claude-3\.5|claude-3\.7|claude-sonnet-4|claude-opus-4/.test(m)) return true;
    // Meta Llama 3.2 vision + Llama 4 (natively multimodal).
    if (/llama-3\.2|llama3\.2|llama-4|llama4/.test(m)) return true;
    // Other open multimodal families.
    if (/pixtral|qwen2?-vl|qwen-vl|grok.*vision|grok-2|grok-4/.test(m)) return true;
    return false;
  },

  /**
   * (v0.10.24) Classify a vision-capable model by the *quality* of its image
   * understanding for the demanding task of reading fantasy maps (small text
   * labels, faint paths, dense iconography). This is a heuristic used purely to
   * advise the GM — it never blocks a call.
   *
   *   • "strong" — flagship multimodal models with excellent OCR / detail:
   *     GPT-4o, Claude 3.5/3.7/4 Sonnet & Opus, Gemini 2.0/2.5/3 (Flash/Pro),
   *     and any explicit "-vision"/"-vl" model.
   *   • "weak"   — lightweight/mini/nano/lite/haiku tiers. They accept images
   *     but routinely miss small text and fine detail on detailed maps.
   *   • "unknown"— vision-capable but not confidently classified either way.
   *
   * @param {string} model
   * @returns {"strong"|"weak"|"unknown"}
   */
  _visionModelTier(model) {
    const m = String(model || "").toLowerCase();
    if (!m) return "unknown";
    // Lightweight tiers first — these are the ones we want to warn about.
    // Word-boundaries matter: "mini" must not match the "mini" inside "geMINI".
    if (/\bmini\b|-mini|\bnano\b|-nano|\blite\b|-lite|\bhaiku\b|\bsmall\b|\btiny\b|\b\d+b\b|phi-3|gemma/.test(m)) return "weak";
    // Flagship multimodal families with strong OCR / fine-detail vision.
    if (/gpt-4o(?!-mini)|gpt-4\.1(?!-mini|-nano)|gpt-5|o3|o4/.test(m)) return "strong";
    if (/claude-3-5-sonnet|claude-3\.5-sonnet|claude-3-7|claude-3\.7|claude-sonnet-4|claude-opus-4|claude-4/.test(m)) return "strong";
    if (/gemini-(?:2\.0|2\.5|3)|gemini-2-0|gemini-flash-2|gemini-pro-2/.test(m)) return "strong";
    if (/pixtral-large|qwen2-vl|qwen-vl-max|llama-4|grok-4|grok-2-vision/.test(m)) return "strong";
    if (/-vision\b|-vl\b|\bvl-/.test(m)) return "strong";
    return "unknown";
  },

  /**
   * Extract the assistant text from the upstream JSON, supporting
   * OpenAI `choices[0].message.content` and Abacus AI variants.
   */
  _extractContent(data) {
    return (
      data?.choices?.[0]?.message?.content ??
      data?.result?.messages?.slice(-1)?.[0]?.text ??
      data?.result?.content ??
      data?.text ??
      data?.response ??
      null
    );
  },

  /**
   * (v0.10.12) Has the one-time "falling back to direct mode" notice
   * already been shown this session? Prevents notification spam when the
   * server hook is missing and every call falls back to direct mode.
   */
  _directFallbackNoticed: false,

  /**
   * (v0.10.30) Once an `auto`-mode call has determined the server hook is
   * unusable this session (network error, 404, or 502/503/504 from a proxy),
   * remember it. Subsequent calls then skip the doomed `/skald-api/*` POST and
   * go straight to the direct browser→AI path.
   *
   * Why this matters: a single `!scout` fires several vision passes (overview
   * + map sections). Without this flag, EVERY pass re-tried the dead hook
   * first and waited out a slow gateway 502 (often many seconds) before
   * falling back — stacking up so much latency that the scout appeared to
   * hang or fail. With the flag, only the first call pays the probe cost.
   */
  _hookKnownDead: false,

  /**
   * (v0.10.12) Post a single, friendly heads-up (console + GM toast) the
   * first time an `auto`-mode call falls back to the direct browser→AI
   * path because the server hook wasn't found. Subsequent fallbacks are
   * silent. Never throws.
   *
   * (v0.10.30) Also latches {@link _hookKnownDead} so later calls this
   * session skip the dead hook entirely.
   */
  _noticeDirectFallback() {
    this._hookKnownDead = true;
    if (this._directFallbackNoticed) return;
    this._directFallbackNoticed = true;
    console.warn(
      LOG_PREFIX,
      "Server hook not detected (/skald-api/* returned 404 or was unreachable). " +
      "Falling back to direct browser→AI mode. This is normal on hosted/managed " +
      "Foundry. To use the server hook instead, start Foundry with --import (see README)."
    );
    try {
      if (game?.user?.isGM) {
        ui?.notifications?.info?.(
          game.i18n.localize("ETERNAL_SKALD.notifications.directFallback")
        );
      }
    } catch (_) { /* notifications optional */ }
  },

  /**
   * (v0.10.12) Decide whether a server-hook response means the same-origin
   * `/skald-api/*` route is effectively unusable, so auto-mode should fall
   * back to the direct browser→AI path. A network error is signalled by
   * passing a null `response`.
   *
   * Recognised signatures:
   *   • null            — network/connection failure (hook unreachable)
   *   • 404 Not Found   — Foundry served its own 404 page (hook not loaded)
   *   • 502/503/504     — (v0.10.28) reverse-proxy/gateway failure. Common on
   *                       hosted/managed Foundry when a large map-vision POST
   *                       hits the missing /skald-api route and the proxy
   *                       (e.g. openresty) returns a Bad Gateway HTML page
   *                       instead of a clean 404.
   *   • 413 Too Large   — (v0.10.28) the hook/proxy rejected an oversized body
   *                       (vision payloads exceed the 2 MiB hook limit).
   *
   * In every one of these cases the hook path cannot serve the request, so in
   * auto-mode we fall back to calling the AI directly. This is consulted ONLY
   * in the auto-mode fallback branches — in "server" mode a genuine upstream
   * error is still surfaced via the normal `!response.ok` path, and in
   * "direct" mode this is never called — so a real LLM error is never masked.
   *
   * @param {Response|null} response
   * @returns {boolean}
   */
  _hookMissing(response) {
    if (!response) return true;
    return [404, 413, 502, 503, 504].includes(response.status);
  },

  /**
   * (v0.14.4 / P2) fetch() wrapped with an AbortController timeout so a
   * stalled upstream can't hang the UI for 60+ seconds. The timer guards the
   * connection + response-headers phase only: it is cleared the instant
   * fetch() resolves, so an in-flight SSE token stream or a long body download
   * is NEVER aborted mid-flight. Timeout is configurable via the
   * "requestTimeout" world setting (seconds); falls back to 30s if unset or
   * invalid. On timeout we throw a clear, localised-ish error and always clear
   * the timer (no leaked handles), degrading exactly like any network error.
   * @param {string} resource - URL or path to fetch.
   * @param {object} [options] - standard fetch() init; `signal` is injected.
   * @returns {Promise<Response>}
   */
  async _fetch(resource, options = {}) {
    const secs = Number(Settings.get("requestTimeout"));
    const ms = (Number.isFinite(secs) && secs > 0) ? secs * 1000 : 30000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(resource, { ...options, signal: controller.signal });
    } catch (e) {
      if (e?.name === "AbortError") {
        throw new Error(
          `The Skald's request timed out after ${ms / 1000}s — the AI endpoint ` +
          `did not respond in time. Try again, or raise "Request Timeout" in settings.`
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  },

  /**
   * (v0.10.12) Call the AI endpoint DIRECTLY from the browser, bypassing
   * the server hook. Sends the raw OpenAI-style chat-completions body with
   * an `Authorization: Bearer <apiKey>` header straight to `endpoint`.
   *
   * This works wherever the endpoint permits cross-origin browser requests.
   * The default Abacus AI endpoint (https://routellm.abacus.ai/v1/chat/...)
   * returns permissive CORS headers, so it works out of the box — which is
   * what makes the Skald usable on hosted Foundry without the server hook.
   *
   * @param {object} payload - the OpenAI chat-completions request body
   * @param {string} endpoint
   * @param {string} apiKey
   * @returns {Promise<string>} the assistant's reply text
   */
  async _directChat(payload, endpoint, apiKey) {
    let response;
    try {
      response = await this._fetch(endpoint, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({ ...payload, stream: false })
      });
    } catch (netErr) {
      console.error(LOG_PREFIX, "direct fetch failed:", netErr);
      throw new Error(
        `Could not reach the AI endpoint directly (${endpoint}).\n` +
        "Check the API Endpoint setting and your network. If the endpoint " +
        "doesn't allow cross-origin (CORS) browser requests, you'll need to " +
        "run the server hook instead (see README → Setup)."
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let detail = text;
      try {
        const j = JSON.parse(text);
        detail = j?.error?.message || j?.error || j?.message || j?.detail || text;
      } catch (_) { /* not JSON */ }
      throw new Error(`AI endpoint error ${response.status}: ${String(detail).slice(0, 300)}`);
    }

    let data;
    try { data = await response.json(); }
    catch (_) { throw new Error("The Skald returned a malformed response."); }

    const content = this._extractContent(data);
    if (!content || typeof content !== "string") {
      console.error(LOG_PREFIX, "Unexpected direct response shape:", data);
      throw new Error("The Skald received an empty or malformed reply from the AI.");
    }
    return content.trim();
  },

  /**
   * (v0.10.12) Consume a chat-completions HTTP response as a token stream,
   * invoking the supplied callbacks as text arrives. Extracted so both the
   * server-hook (`chatStream`) and direct (`_directChatStream`) paths share
   * one battle-tested SSE reader.
   *
   * If the response is buffered JSON rather than an SSE event-stream, it
   * transparently degrades to a single-shot result so callers always get a
   * usable reply.
   *
   * @param {Response} response - an OK (2xx) fetch Response
   * @param {object} [handlers]
   * @param {(delta: string, full: string) => void} [handlers.onChunk]
   * @param {(full: string) => void} [handlers.onDone]
   * @param {(err: Error) => void} [handlers.onError]
   * @returns {Promise<string>} the full assistant reply text
   */
  async _consumeStreamingResponse(response, handlers = {}) {
    const { onChunk, onDone, onError } = handlers;
    const contentType = (response.headers.get("content-type") || "").toLowerCase();

    // Graceful degrade: buffered JSON, not an SSE stream.
    if (!contentType.includes("text/event-stream") || !response.body || typeof response.body.getReader !== "function") {
      let data;
      try { data = await response.json(); }
      catch (_) { throw new Error("The Skald returned a malformed response."); }
      const content = this._extractContent(data);
      if (!content || typeof content !== "string") {
        throw new Error("The Skald received an empty or malformed reply from the AI.");
      }
      const full = content.trim();
      try { onChunk?.(full, full); } catch (_) {}
      try { onDone?.(full); } catch (_) {}
      return full;
    }

    // Consume the SSE stream.
    const reader  = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let full   = "";

    const handleEvent = (block) => {
      let isError = false;
      const dataLines = [];
      for (const rawLine of block.split("\n")) {
        const line = rawLine.replace(/\r$/, "");
        if (!line || line.startsWith(":")) continue;        // comment / keep-alive
        if (line.startsWith("event:")) {
          if (line.slice(6).trim() === "error") isError = true;
          continue;
        }
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) return;
      const dataStr = dataLines.join("\n");
      if (dataStr === "[DONE]") return;

      let json;
      try { json = JSON.parse(dataStr); }
      catch (_) { return; }   // ignore unparseable frames

      if (isError || json?.error) {
        const msg = json?.error?.message || json?.error || "The Skald's stream failed.";
        throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      }

      const delta =
        json?.choices?.[0]?.delta?.content ??
        json?.choices?.[0]?.message?.content ??
        json?.delta ??
        "";
      if (delta) {
        full += delta;
        try { onChunk?.(delta, full); } catch (_) {}
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Events are separated by a blank line (\n\n).
        let sep;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          if (block.trim()) handleEvent(block);
        }
      }
      // Flush any trailing buffered event (no terminating blank line).
      buffer += decoder.decode();
      if (buffer.trim()) handleEvent(buffer);
    } catch (streamErr) {
      console.error(LOG_PREFIX, "stream read error:", streamErr);
      try { reader.cancel(); } catch (_) {}
      if (full.trim()) {
        try { onError?.(streamErr); } catch (_) {}
      } else {
        throw streamErr;
      }
    }

    const result = full.trim();
    if (!result) {
      throw new Error("The Skald received an empty reply from the AI.");
    }
    try { onDone?.(result); } catch (_) {}
    return result;
  },

  /**
   * (v0.10.12) Streaming sibling of {@link _directChat}: calls the AI
   * endpoint directly from the browser with `stream: true` and pipes the
   * response through {@link _consumeStreamingResponse}.
   *
   * @param {object} payload
   * @param {string} endpoint
   * @param {string} apiKey
   * @param {object} [handlers]
   * @returns {Promise<string>}
   */
  async _directChatStream(payload, endpoint, apiKey, handlers = {}) {
    let response;
    try {
      response = await this._fetch(endpoint, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({ ...payload, stream: true })
      });
    } catch (netErr) {
      console.error(LOG_PREFIX, "direct stream fetch failed:", netErr);
      throw new Error(
        `Could not reach the AI endpoint directly (${endpoint}).\n` +
        "Check the API Endpoint setting and your network. If the endpoint " +
        "doesn't allow cross-origin (CORS) browser requests, you'll need to " +
        "run the server hook instead (see README → Setup)."
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let detail = text;
      try {
        const j = JSON.parse(text);
        detail = j?.error?.message || j?.error || j?.message || j?.detail || text;
      } catch (_) { /* not JSON */ }
      throw new Error(`AI endpoint error ${response.status}: ${String(detail).slice(0, 300)}`);
    }

    return this._consumeStreamingResponse(response, handlers);
  },

  /**
   * Call the AI via the server-side hook. Dead simple:
   *   POST /skald-api/chat  (same origin — no CORS, no proxy)
   *
   * The server hook (eternal-skald-server.mjs) must be loaded via
   * `node --import ...` when starting Foundry. If it's not loaded,
   * this returns a clear error message telling the user how to fix it.
   *
   * @param {Array<{role: string, content: string}>} messages
   * @param {object} [opts]
   * @returns {Promise<string>} the assistant's reply text
   */
  async chat(messages, opts = {}) {
    // (v0.20.0 F6) Resolve a keyless local Ollama to a harmless placeholder so
    // the no-API-key guard below does not block local inference.
    const apiKey   = resolveOllamaApiKey(Settings.get("providerPreset"), Settings.get("apiKey"));
    // (v0.10.23) Callers may pin a specific model for one call (e.g. the map
    // vision scout uses a multimodal model that may differ from the narration
    // model). Falls back to the configured Model Name, then the default.
    const model    = opts.model || Settings.get("modelName") || DEFAULT_MODEL;
    const endpoint = Settings.get("apiEndpoint") || DEFAULT_ENDPOINT;

    if (!apiKey) {
      throw new Error(game.i18n.localize("ETERNAL_SKALD.errors.noApiKey"));
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("Cannot call ChatLLM with empty messages.");
    }

    // (v0.14.3) P1 — Streaming is now the DEFAULT transport. Unless the world
    // disabled it (streamingEnabled === false) or a caller explicitly opts out
    // (opts.buffered === true), route buffered callers through the SSE path so
    // the upstream LLM starts emitting tokens immediately → lower
    // time-to-first-token. chatStream() returns the full reply text when no
    // render handlers are supplied and transparently degrades to buffered JSON
    // if the server returns a non-SSE response, so the return contract — a
    // Promise<string> of the assistant reply — is identical for every caller.
    if (Settings.get("streamingEnabled") !== false && opts.buffered !== true) {
      return this.chatStream(messages, opts, {});
    }

    const payload = {
      model,
      messages,
      temperature: opts.temperature ?? 0.8,
      max_tokens:  opts.maxTokens   ?? 800,
      stream: false
    };

    // (v0.10.12) Connection mode decides how we reach the AI:
    //   direct → straight browser→AI fetch (skip the hook entirely)
    //   server → server hook only (helpful error if it isn't loaded)
    //   auto   → try the hook; on 404/network-error fall back to direct
    const mode = Settings.get("connectionMode") || "auto";

    console.log(LOG_PREFIX, "Calling AI:", { endpoint, model, mode, msgCount: messages.length });

    if (mode === "direct") {
      return this._directChat(payload, endpoint, apiKey);
    }

    // (v0.10.30) A previous auto-mode call already found the hook dead this
    // session — don't waste a slow proxy round-trip (502) on every subsequent
    // vision pass. Go straight to the working direct path.
    if (mode === "auto" && this._hookKnownDead) {
      return this._directChat(payload, endpoint, apiKey);
    }

    let response = null;
    try {
      response = await this._fetch(API_PATH, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ apiKey, endpoint, payload })
      });
    } catch (netErr) {
      console.error(LOG_PREFIX, "fetch failed:", netErr);
      if (mode === "auto") {
        this._noticeDirectFallback();
        return this._directChat(payload, endpoint, apiKey);
      }
      throw new Error(
        "Cannot reach the Skald's server hook.\n" +
        "Make sure Foundry was started with:\n" +
        "  node --import ./Data/modules/the-eternal-skald/scripts/eternal-skald-server.mjs resources/app/main.mjs\n" +
        "See the README for details."
      );
    }

    // 404 = hook not loaded (Foundry's own 404 page)
    if (this._hookMissing(response)) {
      if (mode === "auto") {
        this._noticeDirectFallback();
        return this._directChat(payload, endpoint, apiKey);
      }
      throw new Error(
        "The Eternal Skald server hook is not loaded (404).\n" +
        "Add --import to your Foundry startup command, or set Connection Mode to " +
        "'Direct (browser → AI)' in the module settings. See README → Setup."
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let detail = text;
      try {
        const j = JSON.parse(text);
        detail = j?.error || j?.message || j?.detail || text;
      } catch (_) { /* not JSON */ }
      throw new Error(`Skald API error ${response.status}: ${String(detail).slice(0, 300)}`);
    }

    let data;
    try { data = await response.json(); }
    catch (_) {
      throw new Error("The Skald returned a malformed response.");
    }

    const content = this._extractContent(data);
    if (!content || typeof content !== "string") {
      console.error(LOG_PREFIX, "Unexpected response shape:", data);
      throw new Error("The Skald received an empty or malformed reply from the AI.");
    }

    return content.trim();
  },

  /**
   * (v0.22.0 F5) Tool-calling sibling of {@link chat}. Performs a BUFFERED
   * (non-streaming) completion with an OpenAI-compatible `tools` array attached
   * and returns the raw assistant message so the caller can inspect any
   * `tool_calls` the model emitted. This NEVER executes tools itself — the
   * ai/ layer must not touch Foundry; the narrative/ layer is responsible for
   * running validated tool calls through the active adapter / chronicle.
   *
   * Returns { content, toolCalls } where toolCalls is the raw provider array
   * (possibly empty/undefined). Honours the same connection-mode + keyless
   * resolution as {@link chat}; in auto-mode a dead hook falls back to direct.
   *
   * @param {Array<{role:string, content:string}>} messages
   * @param {Array<object>} tools - OpenAI tools array (see tools/registry.js).
   * @param {object} [opts]
   * @returns {Promise<{content: (string|null), toolCalls: (Array|undefined)}>}
   */
  async chatWithTools(messages, tools = [], opts = {}) {
    const apiKey   = resolveOllamaApiKey(Settings.get("providerPreset"), Settings.get("apiKey"));
    const model    = opts.model || Settings.get("modelName") || DEFAULT_MODEL;
    const endpoint = Settings.get("apiEndpoint") || DEFAULT_ENDPOINT;
    if (!apiKey) throw new Error(game.i18n.localize("ETERNAL_SKALD.errors.noApiKey"));
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("Cannot call ChatLLM with empty messages.");
    }
    const payload = {
      model,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens:  opts.maxTokens   ?? 800,
      stream: false
    };
    if (Array.isArray(tools) && tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice = opts.toolChoice || "auto";
    }
    const mode = Settings.get("connectionMode") || "auto";
    let data = null;
    const direct = async () => {
      const r = await this._fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ ...payload, stream: false })
      });
      if (!r.ok) throw new Error(`AI endpoint error ${r.status}`);
      return r.json();
    };
    if (mode === "direct" || (mode === "auto" && this._hookKnownDead)) {
      data = await direct();
    } else {
      try {
        const r = await this._fetch(API_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey, endpoint, payload })
        });
        if (this._hookMissing(r)) {
          if (mode === "auto") { this._noticeDirectFallback(); data = await direct(); }
          else throw new Error("The Eternal Skald server hook is not loaded.");
        } else if (!r.ok) {
          throw new Error(`Skald API error ${r.status}`);
        } else {
          data = await r.json();
        }
      } catch (err) {
        if (mode === "auto") { this._noticeDirectFallback(); data = await direct(); }
        else throw err;
      }
    }
    const msg = data?.choices?.[0]?.message || {};
    return { content: this._extractContent(data), toolCalls: msg.tool_calls };
  },

  /**
   * Streaming sibling of {@link chat} (v0.3.3). POSTs to /skald-api/chat-stream
   * and consumes the upstream LLM's Server-Sent-Events token stream, invoking
   * the supplied callbacks as text arrives.
   *
   * If the server responds with a normal JSON body instead of an event-stream
   * (e.g. the hook is an older build, or an error occurred before streaming
   * began) it transparently degrades to a single-shot result so callers always
   * get a usable reply.
   *
   * @param {Array<{role: string, content: string}>} messages
   * @param {object} [opts]
   * @param {object} [handlers]
   * @param {(delta: string, full: string) => void} [handlers.onChunk]
   * @param {(full: string) => void} [handlers.onDone]
   * @param {(err: Error) => void} [handlers.onError]
   * @returns {Promise<string>} the full assistant reply text
   */
  async chatStream(messages, opts = {}, handlers = {}) {
    const { onChunk, onDone, onError } = handlers;
    // (v0.20.0 F6) Same keyless-Ollama resolution as chat().
    const apiKey   = resolveOllamaApiKey(Settings.get("providerPreset"), Settings.get("apiKey"));
    // (v0.14.3) Honour a per-call pinned model (opts.model) exactly as chat()
    // does, so callers that delegate here (e.g. the map-vision scout) keep
    // their multimodal model instead of silently falling back to the default.
    const model    = opts.model || Settings.get("modelName") || DEFAULT_MODEL;
    const endpoint = Settings.get("apiEndpoint") || DEFAULT_ENDPOINT;

    if (!apiKey) {
      throw new Error(game.i18n.localize("ETERNAL_SKALD.errors.noApiKey"));
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("Cannot call ChatLLM with empty messages.");
    }

    const payload = {
      model,
      messages,
      temperature: opts.temperature ?? 0.8,
      max_tokens:  opts.maxTokens   ?? 800,
      stream: true
    };

    // (v0.10.12) Same connection-mode logic as {@link chat}: direct skips the
    // hook, server forces it, auto tries the hook then falls back to direct.
    const mode = Settings.get("connectionMode") || "auto";

    console.log(LOG_PREFIX, "Streaming AI:", { endpoint, model, mode, msgCount: messages.length });

    if (mode === "direct") {
      return this._directChatStream(payload, endpoint, apiKey, handlers);
    }

    // (v0.10.30) Hook already known dead this session — skip the doomed proxy
    // POST and stream directly from the AI endpoint.
    if (mode === "auto" && this._hookKnownDead) {
      return this._directChatStream(payload, endpoint, apiKey, handlers);
    }

    let response = null;
    try {
      response = await this._fetch(STREAM_PATH, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ apiKey, endpoint, payload })
      });
    } catch (netErr) {
      console.error(LOG_PREFIX, "stream fetch failed:", netErr);
      if (mode === "auto") {
        this._noticeDirectFallback();
        return this._directChatStream(payload, endpoint, apiKey, handlers);
      }
      throw new Error(
        "Cannot reach the Skald's server hook.\n" +
        "Make sure Foundry was started with:\n" +
        "  node --import ./Data/modules/the-eternal-skald/scripts/eternal-skald-server.mjs resources/app/main.mjs\n" +
        "See the README for details."
      );
    }

    // 404 = hook not loaded, or an older hook without the streaming route.
    if (this._hookMissing(response)) {
      if (mode === "auto") {
        this._noticeDirectFallback();
        return this._directChatStream(payload, endpoint, apiKey, handlers);
      }
      throw new Error(
        "The Eternal Skald streaming endpoint is not available (404).\n" +
        "Update the server hook and add --import to your Foundry startup command, or set " +
        "Connection Mode to 'Direct (browser → AI)' in the module settings. See README → Setup."
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let detail = text;
      try {
        const j = JSON.parse(text);
        detail = j?.error || j?.message || j?.detail || text;
      } catch (_) { /* not JSON */ }
      throw new Error(`Skald API error ${response.status}: ${String(detail).slice(0, 300)}`);
    }

    return this._consumeStreamingResponse(response, handlers);
  }
};
