import { LOG_PREFIX, MODULE_ID, SKALD_NAME } from "../core/constants.js";
import { Settings } from "../core/settings.js";
import { Client } from "../ai/client.js";
// Call-time cross-imports (safe cycle): EntityLinker & Integration still live in
// eternal-skald.js and are only referenced inside method bodies here.
import { EntityLinker } from "../chronicle/entity-linking.js";
import { Integration } from "../narrative/integration.js";

/**
 * In-memory rolling buffer of recent messages, keyed by "channel" so
 * separate concerns (general chat, an active NPC dialogue, etc.) don't
 * pollute each other.
 *
 * Each entry: { role: "user"|"assistant", content: string }
 */
export const Memory = {
  _buffers: new Map(),

  _max() {
    return Math.max(4, Settings.get("memoryLength") ?? 20);
  },

  push(channel, role, content) {
    const buf = this._buffers.get(channel) ?? [];
    buf.push({ role, content });
    while (buf.length > this._max()) buf.shift();
    this._buffers.set(channel, buf);
  },

  get(channel) {
    return [...(this._buffers.get(channel) ?? [])];
  },

  reset(channel) {
    if (channel) this._buffers.delete(channel);
    else this._buffers.clear();
  }
};


export const Chat = {
  /**
   * Build the Skald card HTML for a given body. Extracted from
   * {@link postSkald} (v0.3.3) so streaming updates can re-render the
   * exact same markup in place via `message.update({ content })`.
   *
   * @param {string} content - HTML body
   * @param {object} [opts]
   * @param {string} [opts.title]
   * @param {string} [opts.alias]
   * @param {string} [opts.variant]
   * @returns {string} the full card HTML
   */
  renderCard(content, opts = {}) {
    const variant = opts.variant ?? "default";
    const title   = opts.title ? `<h3 class="es-title">${escapeHtml(opts.title)}</h3>` : "";
    const alias   = opts.alias ?? SKALD_NAME;
    const streamCls = opts.streaming ? " es-streaming" : "";

    return `
      <div class="eternal-skald-card es-variant-${variant}${streamCls}">
        <div class="es-banner">
          <span class="es-rune">ᚱ</span>
          <span class="es-alias">${escapeHtml(alias)}</span>
          <span class="es-rune">ᛗ</span>
        </div>
        ${title}
        <div class="es-body">${content}</div>
      </div>
    `;
  },

  /**
   * Post a styled Skald chat message. The body is wrapped in module CSS
   * classes so styles/eternal-skald.css can theme it.
   *
   * @param {string} content   - HTML body
   * @param {object} [opts]     - same shape as {@link renderCard}, plus
   *                              `gmWhisper` and `flags`.
   */
  async postSkald(content, opts = {}) {
    const variant = opts.variant ?? "default";
    const alias   = opts.alias ?? SKALD_NAME;

    const html = this.renderCard(content, opts);

    const data = {
      content: html,
      speaker: ChatMessage.getSpeaker({ alias }),
      flags: { [MODULE_ID]: { variant, alias, ...(opts.flags ?? {}) } }
    };
    if (opts.gmWhisper) {
      data.whisper = game.users.filter(u => u.isGM).map(u => u.id);
    }
    return ChatMessage.create(data);
  },

  /** Post a tiny, low-key system notice from the Skald. */
  async postSystem(content, { gmWhisper = false } = {}) {
    const data = {
      content: `<div class="eternal-skald-system">${content}</div>`,
      speaker: ChatMessage.getSpeaker({ alias: SKALD_NAME })
    };
    if (gmWhisper) {
      data.whisper = game.users.filter(u => u.isGM).map(u => u.id);
    }
    return ChatMessage.create(data);
  }
};

/** Minimal HTML escaping for user-supplied strings. */
export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Light formatter: convert simple markdown (**bold**, *italic*, line
 * breaks) coming back from the LLM into safe HTML.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.link=true]  Run entity linking as a final pass.
 *   Pass `false` for intermediate streaming frames so half-typed names
 *   aren't linked prematurely (the final frame links normally).
 */
export function formatMarkdown(text, opts = {}) {
  // Escape first, then re-introduce a tiny safe subset.
  let s = escapeHtml(text);
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\n{2,}/g, "</p><p>");
  s = s.replace(/\n/g, "<br/>");
  let html = `<p>${s}</p>`;
  if (opts.link !== false) html = EntityLinker.link(html);
  return html;
}

/**
 * Strip the AI's structured directives ([[MOVE:...]] / [[EFFECT:...]])
 * from text destined for live display. Unlike {@link Integration.parseMoveSuggestion}
 * /{@link Integration.parseEffects}, which run once on the COMPLETE reply,
 * this also trims a *partial* trailing directive (e.g. "...the door `[[MOVE`")
 * so half-streamed tokens never flash raw bracket syntax at the player.
 *
 * The full raw reply is still processed normally after the stream ends, so
 * no move suggestion or effect is lost — this only affects what's shown.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripDirectivesForDisplay(text) {
  if (typeof text !== "string") return "";
  let s = text;
  // Remove a COMPLETE chronicle metadata block (v0.4.0) anywhere in the text.
  s = s.replace(/\[\[\s*SKALD_META\s*\]\][\s\S]*?\[\[\s*\/\s*SKALD_META\s*\]\]/gi, "");
  // Remove an OPEN-but-unclosed metadata block still streaming at the end
  // (the closing tag hasn't arrived yet). Metadata is always last, so we can
  // safely drop everything from the open tag onward.
  s = s.replace(/\[\[\s*SKALD_META\s*\]\][\s\S]*$/i, "");
  // Remove a partial OPENING tag still being streamed char-by-char:
  //   "[[", "[[S", "[[SKALD_MET" …
  s = s.replace(/\[\[\s*(?:S(?:K(?:A(?:L(?:D(?:_(?:M(?:E(?:T(?:A)?)?)?)?)?)?)?)?)?)?$/i, "");
  // Remove any COMPLETE move/effect directives anywhere in the text.
  s = s.replace(/\[\[\s*(?:MOVE|EFFECT)\s*:[^\]]*?\]\]/gi, "");
  // Remove a partial move/effect directive still being streamed at the very end:
  //   "[[", "[[MO", "[[MOVE: Fac", "[[EFFECT: harm" …
  s = s.replace(/\[\[\s*(?:M(?:O(?:V(?:E)?)?)?|E(?:F(?:F(?:E(?:C(?:T)?)?)?)?)?)?(?:\s*:[^\]]*)?$/i, "");
  return s;
}

/**
 * Extract the chronicle metadata block ([[SKALD_META]]…[[/SKALD_META]])
 * from a COMPLETE AI reply (v0.4.0). Tolerant of the model wrapping the
 * JSON in a fenced code block or adding stray whitespace.
 *
 * @param {string} text
 * @returns {{ metadata: object|null, clean: string }}
 *   `metadata` is the parsed object (or null if absent/invalid); `clean` is
 *   the reply with the block removed.
 */
export function parseMetadata(text) {
  if (typeof text !== "string") return { metadata: null, clean: "" };
  const re = /\[\[\s*SKALD_META\s*\]\]([\s\S]*?)\[\[\s*\/\s*SKALD_META\s*\]\]/i;
  const m = text.match(re);
  if (!m) return { metadata: null, clean: text };

  const clean = text.replace(m[0], "").trim();
  let raw = (m[1] || "").trim();
  // Tolerate the model fencing the JSON: ```json … ``` or ``` … ```.
  raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let metadata = null;
  try {
    metadata = JSON.parse(raw);
  } catch (_) {
    // Last-ditch: grab the outermost {...} span and try again.
    const brace = raw.match(/\{[\s\S]*\}/);
    if (brace) { try { metadata = JSON.parse(brace[0]); } catch (_) { metadata = null; } }
  }
  if (metadata && typeof metadata !== "object") metadata = null;
  return { metadata, clean };
}

/** Distance (px) from the very bottom of the chat log within which we still
 *  treat the user as "at the bottom" and keep auto-scrolling. */
const CHAT_SCROLL_THRESHOLD_PX = 150;

/**
 * Is the chat log currently scrolled to (or within {@link CHAT_SCROLL_THRESHOLD_PX}
 * of) the bottom? Used to decide whether streaming should auto-scroll. If the
 * user has scrolled UP to read earlier messages this returns false, so we leave
 * their view alone. Defaults to `true` (stick to bottom) whenever the chat UI /
 * scroll metrics are unavailable (headless tests, older Foundry), preserving the
 * "show the new narration" default.
 */
function isChatNearBottom() {
  try {
    const chat = ui?.chat;
    if (!chat) return true;
    let el = chat.element;
    if (el && el.jquery) el = el[0];                 // unwrap jQuery (Foundry ≤ v12)
    const scroller =
      el?.querySelector?.("ol.chat-log") ||
      el?.querySelector?.("#chat-log") ||
      el?.querySelector?.(".chat-scroll") ||
      el;
    if (!scroller || typeof scroller.scrollHeight !== "number") return true;
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    return distance <= CHAT_SCROLL_THRESHOLD_PX;
  } catch (_e) {
    return true;
  }
}

/**
 * Defensively scroll the chat log to the bottom. No-ops if the chat UI or the
 * scrollBottom API is unavailable (older Foundry, headless tests).
 */
function scrollChatToBottom() {
  try { ui?.chat?.scrollBottom?.(); } catch (_e) { /* non-fatal */ }
}

/**
 * The streaming counterpart to a "post a Skald reply" call (v0.3.3).
 *
 * It posts a chat message IMMEDIATELY with a thinking indicator, then
 * consumes the SSE token stream and rewrites that same message in place as
 * text arrives — throttled to ~140ms so we don't hammer Foundry's socket /
 * database with an update per token. The final update is always flushed.
 *
 * Display text has MOVE/EFFECT directives stripped (see
 * {@link stripDirectivesForDisplay}); the untouched raw reply is returned so
 * the caller can run its normal post-processing (suggestion cards, effect
 * application, memory) against the complete text.
 *
 * On a failure BEFORE any token arrives it transparently falls back to the
 * buffered {@link Client.chat} call and renders that into the same message,
 * so the player always gets a reply. If it cannot recover, the message is
 * rewritten with a readable error and the function rethrows.
 *
 * @param {Array<{role:string,content:string}>} messages
 * @param {object} [opts]
 * @param {string} [opts.variant]
 * @param {string} [opts.title]
 * @param {string} [opts.alias]
 * @param {boolean}[opts.gmWhisper]
 * @param {object} [opts.chatOpts]  - temperature/maxTokens passed to the client
 * @returns {Promise<{reply: string, message: ChatMessage}>}
 */
export async function callSkaldStreaming(messages, opts = {}) {
  const variant   = opts.variant ?? "default";
  const title     = opts.title;
  const alias     = opts.alias ?? SKALD_NAME;
  const cardOpts  = { variant, title, alias };
  const chatOpts  = opts.chatOpts ?? {};

  const THINKING_HTML = `<p class="es-thinking"><em>The Skald gathers the threads of fate…</em></p>`;

  // 1) Post the placeholder card immediately for instant feedback.
  const data = {
    content: Chat.renderCard(THINKING_HTML, cardOpts),
    speaker: ChatMessage.getSpeaker({ alias }),
    flags: { [MODULE_ID]: { variant, alias, streaming: true } }
  };
  if (opts.gmWhisper) {
    data.whisper = game.users.filter(u => u.isGM).map(u => u.id);
  }
  // Remember whether the player was at the bottom BEFORE the new card grows
  // the log, so we only pull the view down if they weren't reading history.
  const stickAtStart = isChatNearBottom();
  const message = await ChatMessage.create(data);
  // Bring the placeholder into view so the player sees the narration begin —
  // but only if they were already at/near the bottom.
  if (stickAtStart) scrollChatToBottom();

  // 2) Throttled in-place updater.
  const THROTTLE_MS = 140;
  let lastRendered  = "";
  let pendingFull   = "";
  let timer         = null;
  let updating      = false;

  const renderNow = async (raw, isFinal = false) => {
    const display = stripDirectivesForDisplay(raw).trim();
    // Only link entities on the final frame — half-streamed names should
    // not be linked prematurely (and we avoid re-indexing on every frame).
    const bodyHtml = display ? formatMarkdown(display, { link: isFinal }) : THINKING_HTML;
    const cardHtml = Chat.renderCard(bodyHtml, { ...cardOpts, streaming: !isFinal });
    if (cardHtml === lastRendered) return;
    lastRendered = cardHtml;
    updating = true;
    // Measure BEFORE the update grows the message: keep following the stream
    // only while the user is at/near the bottom. If they scrolled up to read
    // earlier messages we leave them be; if they scroll back down we resume.
    const stick = isChatNearBottom();
    try {
      await message.update({ content: cardHtml });
      if (stick) scrollChatToBottom();
    } catch (e) {
      console.warn(LOG_PREFIX, "stream message.update failed:", e?.message || e);
    } finally {
      updating = false;
    }
  };

  const scheduleUpdate = (full) => {
    pendingFull = full;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      // Skip if a previous update is still in flight; the next chunk reschedules.
      if (!updating) renderNow(pendingFull);
    }, THROTTLE_MS);
  };

  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  // 3) Stream, with graceful fallback to the buffered call.
  let reply = "";
  let gotAnyChunk = false;

  try {
    reply = await Client.chatStream(messages, chatOpts, {
      onChunk: (_delta, full) => { gotAnyChunk = true; scheduleUpdate(full); },
      onDone:  () => {},
      onError: () => {}   // partial-stream error; handled after the loop
    });
  } catch (streamErr) {
    clearTimer();
    if (!gotAnyChunk) {
      // Nothing was shown yet — fall back to the reliable buffered path.
      console.warn(LOG_PREFIX, "streaming failed, falling back to buffered chat:", streamErr?.message || streamErr);
      try {
        reply = await Client.chat(messages, chatOpts);
      } catch (fallbackErr) {
        const msg = escapeHtml(fallbackErr?.message || String(fallbackErr));
        await message.update({
          content: Chat.renderCard(`<p class="es-error"><strong>The Skald falls silent:</strong><br/>${msg}</p>`, cardOpts)
        });
        throw fallbackErr;
      }
    } else {
      // We already streamed partial text; keep whatever we captured.
      reply = streamErr?.partial || reply;
      if (!reply) throw streamErr;
    }
  } finally {
    clearTimer();
  }

  // 4) Final flush — render the complete (directive-stripped) reply and
  //    drop the live-streaming caret.
  await renderNow(reply, true);

  return { reply, message };
}
