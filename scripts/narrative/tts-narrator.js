/* =====================================================================
 *  TTS NARRATOR  (v0.22.0, Phase E — F7)
 *
 *  Optional browser-native Text-to-Speech narration for the Skald's
 *  chat cards. Uses the standard Web Speech API (`window.speechSynthesis`)
 *  as a zero-cost, zero-dependency baseline — no new runtime deps, no build
 *  step, no server contract change. Premium AI-TTS providers are out of
 *  scope for this slice (kept browser-native for safety).
 *
 *  Layering: this lives in narrative/ because it is presentation glue wired
 *  from the chat-render hooks. It performs NO Foundry document writes and NO
 *  AI provider calls — it only reads rendered card text and drives the
 *  browser's speech engine. Everything is fail-soft: if speech synthesis is
 *  unavailable or the settings toggle is off, every entry point degrades to
 *  a quiet no-op.
 *
 *  Pure helpers (extractSpeakableText / selectVoice / clampRate) carry no
 *  browser dependency and are unit-tested directly.
 * ===================================================================== */

import { MODULE_ID, SKALD_NAME } from "../core/constants.js";
import { Settings } from "../core/settings.js";

/** True when the browser exposes the Web Speech synthesis API. */
export function ttsAvailable() {
  return typeof window !== "undefined"
    && typeof window.speechSynthesis !== "undefined"
    && typeof window.SpeechSynthesisUtterance !== "undefined";
}

/**
 * Reduce a Skald card's HTML/markdown body to clean, speakable prose.
 * Strips HTML tags, our `[[DIRECTIVE:...]]` control tokens, markdown
 * emphasis/heading markers, and collapses whitespace. PURE — no globals.
 *
 * @param {string} input - raw card content (HTML or text)
 * @returns {string} plain narration text (may be empty)
 */
export function extractSpeakableText(input) {
  if (typeof input !== "string" || input.length === 0) return "";
  let text = input;
  // Drop our directive tokens (EFFECT / MARK_COMPLETE / ADD_PROGRESS / ...).
  text = text.replace(/\[\[[^\]]*\]\]/g, " ");
  // Remove HTML comments then tags.
  text = text.replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ");
  // Decode the few entities our cards emit.
  text = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
             .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  // Strip markdown emphasis/heading/list markers (leave the words).
  text = text.replace(/[*_`#>]+/g, " ");
  // Collapse runs of whitespace.
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Pick a SpeechSynthesisVoice by (case-insensitive) name, falling back to
 * the first available voice. PURE.
 *
 * @param {Array<{name:string}>} voices
 * @param {string} [preferredName]
 * @returns {object|null}
 */
export function selectVoice(voices, preferredName) {
  if (!Array.isArray(voices) || voices.length === 0) return null;
  if (preferredName) {
    const want = String(preferredName).toLowerCase();
    const hit = voices.find(v => String(v?.name ?? "").toLowerCase() === want)
             ?? voices.find(v => String(v?.name ?? "").toLowerCase().includes(want));
    if (hit) return hit;
  }
  return voices[0];
}

/** Clamp a playback rate into the Web Speech legal range [0.5, 2]. PURE. */
export function clampRate(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(0.5, n));
}

/**
 * Speak a string aloud through the browser engine. Cancels any in-flight
 * utterance first so narrations don't pile up. Returns true if speech was
 * actually started. Fail-soft: returns false when unavailable / empty.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.rate]
 * @param {string} [opts.voiceName]
 * @returns {boolean}
 */
export function speak(text, opts = {}) {
  if (!ttsAvailable()) return false;
  const clean = extractSpeakableText(text);
  if (!clean) return false;
  try {
    const synth = window.speechSynthesis;
    synth.cancel();
    const utter = new window.SpeechSynthesisUtterance(clean);
    utter.rate = clampRate(opts.rate);
    const voices = synth.getVoices?.() ?? [];
    const voice = selectVoice(voices, opts.voiceName);
    if (voice) utter.voice = voice;
    synth.speak(utter);
    return true;
  } catch (_) {
    return false;
  }
}

/** Stop any current narration. Fail-soft no-op when unavailable. */
export function stopSpeaking() {
  if (!ttsAvailable()) return;
  try { window.speechSynthesis.cancel(); } catch (_) { /* defensive */ }
}

/** Resolve the configured rate/voice from settings (defensive defaults). */
function readVoiceOpts() {
  let rate = 1, voiceName = "";
  try { rate = Settings.get?.("ttsRate") ?? 1; } catch (_) {}
  try { voiceName = Settings.get?.("ttsVoice") ?? ""; } catch (_) {}
  return { rate, voiceName };
}

/**
 * Narrate a Skald chat message aloud (used by the auto-narrate hook). Reads
 * the rendered body from the message content. Fail-soft.
 * @param {object} message - a ChatMessage-like object with `.content`
 * @returns {boolean}
 */
export function narrateMessage(message) {
  const content = message?.content ?? "";
  return speak(content, readVoiceOpts());
}

/**
 * Add an idempotent "🔊 Narrate" control to a rendered Skald card. Wired from
 * the renderChatMessage(HTML) hooks alongside the suggestion buttons.
 * No-op when TTS is disabled/unavailable or the button already exists.
 *
 * @param {object} message - the ChatMessage (carries our module flag)
 * @param {HTMLElement|JQuery} html - rendered chat node
 */
export function wireNarrateButton(message, html) {
  if (!ttsAvailable()) return;
  let enabled = false;
  try { enabled = Settings.get?.("ttsEnabled") === true; } catch (_) {}
  if (!enabled) return;
  if (!message?.flags?.[MODULE_ID]) return;

  const root = (html instanceof HTMLElement) ? html : (html?.[0] ?? html);
  const card = root?.querySelector?.(".eternal-skald-card");
  if (!card) return;
  if (card.querySelector?.(".es-narrate-btn")) return; // idempotent

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "es-narrate-btn";
  btn.title = `${SKALD_NAME}: read aloud`;
  btn.textContent = "🔊";
  btn.style.cssText = "float:right;border:none;background:transparent;cursor:pointer;font-size:1em;line-height:1;";
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const body = card.querySelector?.(".es-body");
    const ok = speak(body?.innerHTML ?? card.innerHTML, readVoiceOpts());
    if (!ok) stopSpeaking();
  });
  const banner = card.querySelector?.(".es-banner");
  (banner ?? card).appendChild(btn);
}

export const TtsNarrator = {
  ttsAvailable,
  extractSpeakableText,
  selectVoice,
  clampRate,
  speak,
  stopSpeaking,
  narrateMessage,
  wireNarrateButton
};
