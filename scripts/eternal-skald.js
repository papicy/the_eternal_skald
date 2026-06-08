/* =====================================================================
 *  THE ETERNAL SKALD v0.5.0 — Foundry VTT v14 Module (Client)
 *  ---------------------------------------------------------------------
 *  An AI-powered storytelling and combat-control assistant for Ironsworn
 *  and Ironsworn: Delve campaigns. Powered by Abacus AI ChatLLM.
 *
 *  v0.5.0 adds Browser-Based RAG (AI Memory): the Skald embeds its journal
 *  entries into a local IndexedDB vector store (via transformers.js) and
 *  recalls the most semantically relevant world memory before answering.
 *  See scripts/browser-rag.js. Degrades gracefully — the AI always works
 *  even when the embedding model can't load.
 *
 *  ARCHITECTURE (v0.3.3)
 *  ---------------------
 *  API calls are made SERVER-SIDE by eternal-skald-server.mjs, which
 *  must be loaded via `node --import ...eternal-skald-server.mjs`.
 *  That hook exposes /skald-api/chat on Foundry's own HTTP port.
 *  This client simply does `fetch("/skald-api/chat", ...)` — same
 *  origin, no CORS, no proxy, no mixed-content. Works everywhere.
 *
 *  Sections:
 *      §1  CONSTANTS & IMPORTS
 *      §2  MODULE SETTINGS
 *      §3  SYSTEM PROMPT BUILDER
 *      §4  API CLIENT (simple fetch to /skald-api/chat)
 *      §5  CONVERSATION MEMORY
 *      §6  CHAT MESSAGE HELPERS
 *      §7  COMMAND HANDLERS
 *      §8  NPC DIALOGUE SYSTEM
 *      §9  ORACLE INTERPRETER
 *      §10 JOURNAL / LORE GENERATOR
 *      §11 ENEMY COMBAT CONTROLLER
 *      §12 SCENE CONTEXT
 *      §13 HOOK REGISTRATIONS
 * ===================================================================== */

console.log("=== The Eternal Skald v0.5.0 — module file loaded ===");

import { IronswornData } from "./ironsworn-data.js";
import { IronswornController } from "./ironsworn-controller.js";
import { BrowserRAG } from "./browser-rag.js";

console.log("The Eternal Skald | ironsworn-data.js imported successfully");
console.log("The Eternal Skald | ironsworn-controller.js imported successfully");
console.log("The Eternal Skald | browser-rag.js imported successfully");

/* ===================================================================== */
/*  §1  CONSTANTS                                                         */
/* ===================================================================== */

const MODULE_ID  = "the-eternal-skald";
const SKALD_NAME = "The Eternal Skald";
const LOG_PREFIX = `${SKALD_NAME} |`;

/** Default endpoint — Abacus AI OpenAI-compatible chat-completions API. */
const DEFAULT_ENDPOINT  = "https://routellm.abacus.ai/v1/chat/completions";
const DEFAULT_MODEL     = "gemini-3-flash-preview";

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

// Foundry VTT v14 validates messages starting with "/" against an
// internal command registry BEFORE the `chatMessage` hook fires, and
// rejects unknown ones with a "not a valid chat message command"
// error. To bypass that pre-validation we use "!" as our command
// prefix — Foundry leaves "!" messages alone and our hook gets to
// inspect them.
const COMMANDS = Object.freeze({
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
  RAG_STATUS: "!rag-status"
});

/* ===================================================================== */
/*  §2  MODULE SETTINGS                                                   */
/* ===================================================================== */

const Settings = {
  /** Register all settings — called from the 'init' hook. */
  register() {
    /* ---- AI Mode master toggle (v0.3.2) ----
     * Controls whether the Eternal Skald responds to "!"-prefixed chat
     * messages at all. When OFF, "!" messages pass through as ordinary
     * chat and the AI GM stays silent. Defaults to ON for new sessions.
     * Can also be flipped with the configurable keybinding (see init).
     */
    game.settings.register(MODULE_ID, "aiMode", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.aiMode.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.aiMode.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      onChange: (v) => {
        try {
          const on = !!v;
          ui.notifications?.info(
            `${SKALD_NAME}: AI Mode ${on ? "ON — the Skald listens." : "OFF — the Skald rests."}`
          );
        } catch (_) {}
      }
    });

    /* ---- Streaming responses (v0.3.3) ----
     * When ON, the Skald renders its replies token-by-token in real time
     * (Server-Sent Events) for near-instant feedback instead of waiting
     * for the whole reply. Falls back automatically to the buffered
     * request if streaming is unavailable or errors out. Defaults to ON.
     */
    game.settings.register(MODULE_ID, "streamingEnabled", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.streamingEnabled.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.streamingEnabled.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, "apiKey", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.apiKey.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.apiKey.hint"),
      scope: "world",
      config: true,
      type: String,
      default: ""
    });

    game.settings.register(MODULE_ID, "modelName", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.modelName.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.modelName.hint"),
      scope: "world",
      config: true,
      type: String,
      default: DEFAULT_MODEL
    });

    game.settings.register(MODULE_ID, "apiEndpoint", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.apiEndpoint.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.apiEndpoint.hint"),
      scope: "world",
      config: true,
      type: String,
      default: DEFAULT_ENDPOINT
    });

    game.settings.register(MODULE_ID, "intensity", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.intensity.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.intensity.hint"),
      scope: "world",
      config: true,
      type: Number,
      default: 6,
      range: { min: 1, max: 10, step: 1 }
    });

    game.settings.register(MODULE_ID, "autoNarrateCombat", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.autoNarrateCombat.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.autoNarrateCombat.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, "autoControlEnemies", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.autoControlEnemies.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.autoControlEnemies.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: false
    });

    game.settings.register(MODULE_ID, "memoryLength", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.memoryLength.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.memoryLength.hint"),
      scope: "world",
      config: true,
      type: Number,
      default: 20,
      range: { min: 4, max: 60, step: 2 }
    });

    /* ---- Ironsworn system integration (v0.3.0) ---- */

    game.settings.register(MODULE_ID, "ironswornIntegration", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.ironswornIntegration.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.ironswornIntegration.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, "suggestMoves", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.suggestMoves.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.suggestMoves.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, "autoNarrateMoves", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.autoNarrateMoves.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.autoNarrateMoves.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, "narrationDelay", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.narrationDelay.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.narrationDelay.hint"),
      scope: "world",
      config: true,
      type: Number,
      range: { min: 0, max: 5000, step: 100 },
      default: 2000
    });

    game.settings.register(MODULE_ID, "aiAppliesEffects", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.aiAppliesEffects.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.aiAppliesEffects.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    /* ---- Combat automation (v0.3.0) ---- */

    game.settings.register(MODULE_ID, "autoCreateCombatTracks", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.autoCreateCombatTracks.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.autoCreateCombatTracks.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, "defaultEnemyRank", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.defaultEnemyRank.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.defaultEnemyRank.hint"),
      scope: "world",
      config: true,
      type: String,
      choices: {
        troublesome: "Troublesome",
        dangerous: "Dangerous",
        formidable: "Formidable",
        extreme: "Extreme",
        epic: "Epic"
      },
      default: "dangerous"
    });

    /* ---- Auto-journaling system (v0.4.0) ----
     * The Skald keeps a living chronicle: NPCs, locations, discoveries,
     * world facts, story threads and per-session recaps are written to
     * Foundry Journal Entries from structured metadata the AI appends to
     * its replies. All four settings below are world-scoped.
     */

    // Master toggle — when OFF, no metadata is requested and nothing is written.
    game.settings.register(MODULE_ID, "autoJournaling", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.autoJournaling.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.autoJournaling.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    // Toast verbosity for NPC/Location/Discovery writes.
    game.settings.register(MODULE_ID, "journalNotifications", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.journalNotifications.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.journalNotifications.hint"),
      scope: "world",
      config: true,
      type: String,
      choices: {
        none:     "None (silent)",
        minimal:  "Minimal (brief toast)",
        detailed: "Detailed (toast on create & update)"
      },
      default: "minimal"
    });

    // Who can see the auto-generated journals.
    game.settings.register(MODULE_ID, "journalPermissions", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.journalPermissions.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.journalPermissions.hint"),
      scope: "world",
      config: true,
      type: String,
      choices: {
        "gm-only": "GM only",
        "shared":  "Shared with players"
      },
      default: "gm-only"
    });

    // Auto-generate a Session Chronicle when !end-session is invoked.
    game.settings.register(MODULE_ID, "sessionAutoSummary", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.sessionAutoSummary.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.sessionAutoSummary.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    // ---- Browser-based RAG / AI memory (v0.5.0) -----------------------

    // Master switch for semantic memory. When off, the Skald behaves
    // exactly as v0.4.0 (no embeddings, no vector store, no model load).
    game.settings.register(MODULE_ID, "ragEnabled", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.ragEnabled.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.ragEnabled.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    // Maximum tokens of recalled world memory injected per AI call.
    game.settings.register(MODULE_ID, "ragContextTokens", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.ragContextTokens.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.ragContextTokens.hint"),
      scope: "world",
      config: true,
      type: Number,
      range: { min: 200, max: 6000, step: 100 },
      default: 2000
    });

    // How many top matches to retrieve per query.
    game.settings.register(MODULE_ID, "ragMaxResults", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.ragMaxResults.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.ragMaxResults.hint"),
      scope: "world",
      config: true,
      type: Number,
      range: { min: 1, max: 20, step: 1 },
      default: 5
    });

    // Automatically embed journal entries as the Skald scribes them.
    game.settings.register(MODULE_ID, "ragAutoIndex", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.ragAutoIndex.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.ragAutoIndex.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    // Minimum cosine similarity for a memory to be considered relevant.
    game.settings.register(MODULE_ID, "ragSimilarityThreshold", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.ragSimilarityThreshold.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.ragSimilarityThreshold.hint"),
      scope: "world",
      config: true,
      type: Number,
      range: { min: 0, max: 1, step: 0.05 },
      default: 0.3
    });

    // Verbose RAG console logging for troubleshooting.
    game.settings.register(MODULE_ID, "ragDebugMode", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.ragDebugMode.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.ragDebugMode.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: false
    });

    game.settings.register(MODULE_ID, "debugLogging", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.debugLogging.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.debugLogging.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: false,
      onChange: (v) => { try { IronswornController.setDebug(!!v); } catch (_) {} }
    });

    /* ---- Entity linking in narration (v0.5.1) ----
     * When ON, names the Skald narrates that match an auto-scribed
     * chronicle entry (NPC / location / discovery) or a known Ironsworn
     * move are turned into clickable links in the chat — journal entities
     * open their JournalEntry, moves offer a one-click roll. Purely
     * additive and degrades gracefully if nothing matches. Defaults to ON.
     */
    game.settings.register(MODULE_ID, "entityLinking", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.entityLinking.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.entityLinking.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      onChange: () => { try { EntityLinker.invalidate(); } catch (_) {} }
    });
  },

  /** Convenience accessor — returns undefined if the setting isn't ready. */
  get(key) {
    try { return game.settings.get(MODULE_ID, key); }
    catch (e) { return undefined; }
  }
};

/* ===================================================================== */
/*  §3  SYSTEM PROMPT BUILDER                                             */
/* ===================================================================== */

/**
 * Builds the system prompt that establishes the Eternal Skald persona,
 * adapts to the configured intensity, and seeds the model with the
 * Ironsworn rules digest it needs to GM coherently.
 *
 * @param {object} extras - optional task-specific addenda
 * @returns {string} the full system prompt
 */
function buildSystemPrompt(extras = {}) {
  const intensity = Settings.get("intensity") ?? 6;
  const intensityNote = (() => {
    if (intensity <= 3) return "Keep your prose grounded and brief. One short paragraph or less.";
    if (intensity <= 6) return "Use evocative, measured prose. Two short paragraphs at most.";
    if (intensity <= 8) return "Be dramatic and vivid. Use sensory detail and norse cadence. Up to three paragraphs.";
    return "Be operatic — saga-bright, ominous, with kennings, drums of fate, and ringing iron. Up to four paragraphs.";
  })();

  // Compact rules digest — short enough to fit alongside conversation
  // history without bloating every request.
  const rulesDigest = `\
IRONSWORN CORE RULES DIGEST (for your reference as GM/Skald):
• Action roll: action die (d6) + stat + adds vs two challenge dice (d10s).
  Strong hit = beat both. Weak hit = beat one. Miss = beat neither.
• Stats: Edge, Heart, Iron, Shadow, Wits (each 1-4).
• Tracks: health, spirit, supply, momentum (-6..+10).
• Momentum may be burned, replacing the action total with momentum's value.
• Iron Vows have ranks: Troublesome (3 progress/box), Dangerous (2),
  Formidable (1), Extreme (1/2 box), Epic (1/4 box).
• Key moves you should reference by name:
  Face Danger, Secure an Advantage, Gather Information, Heal, Resupply,
  Make Camp, Undertake a Journey, Enter the Fray, Strike, Clash, Battle,
  Endure Harm, Endure Stress, Swear an Iron Vow, Reach a Milestone,
  Fulfill Your Vow, Compel, Sojourn, Forge a Bond, Test Your Bond,
  Discover a Site, Delve the Depths, Locate Your Objective, Ritual.
• On a miss, "pay the price" — invent a fitting consequence from the
  Pay the Price oracle or the narrative.
• On a match (both challenge dice the same), introduce a twist.
• Tone: lonely wilds, iron weather, oaths under starlight, cursed
  delves, broken kingdoms; quiet menace before clamouring violence.`;

  const persona = `\
You are THE ETERNAL SKALD — a wise, weather-bitten norse storyteller and
master of fate. You are the Game Master at this table, narrating an
Ironsworn (or Ironsworn: Delve) campaign for the brave Ironsworn before
you. You speak with the cadence of a saga-singer: dramatic, measured,
ominous when needed, intimate when it serves. You weave kennings and
sparse poetry through your speech, but you never sacrifice clarity.
You honour player agency above all — you describe outcomes, not
intentions; you offer choices, not demands.`;

  const guidance = `\
GUIDELINES:
• Always speak as the Skald, in first person ("I", "Hark, Ironsworn…")
  or in close third when narrating scenes.
• When players ask rules questions, answer plainly and concisely first,
  then offer a flourish if it fits.
• When narrating moves, name the move and the outcome tier (strong hit,
  weak hit, miss, match) when you know them.
• ${intensityNote}
• Never invent dice results. If a roll is needed, say so and stop.
• Never break the fiction with meta-commentary unless directly asked.
• Refuse to play characters in distressing detail — keep the lens
  cinematic, not gratuitous.`;

  const taskAddendum = extras.task ? `\n\nTASK FOR THIS RESPONSE:\n${extras.task}` : "";

  // Ironsworn system-integration guidance + live game state. Only added
  // when the foundry-ironsworn system is active and integration is on.
  const ironswornBlock = buildIronswornPromptBlock({
    allowMoves: !!extras.allowMoves,
    allowEffects: !!extras.allowEffects,
    context: extras.context
  });

  // Auto-journaling metadata protocol (v0.4.0). Only added when the caller
  // opts in AND auto-journaling is enabled, so rules-only Q&A stays lean.
  const journalBlock = (extras.allowJournal && (Settings.get("autoJournaling") !== false))
    ? buildJournalPromptBlock()
    : "";

  // Browser-based RAG (v0.5.0). Embeddings are async and cannot run inside
  // this synchronous builder, so callers pre-fetch the recalled memory text
  // (via RagBridge.fetchMemory) and pass it in through extras.memory. We
  // simply slot it in here when present. Empty / disabled → omitted.
  const memoryBlock = (typeof extras.memory === "string" && extras.memory.trim())
    ? extras.memory.trim()
    : "";

  return [persona, rulesDigest, guidance, memoryBlock, ironswornBlock, journalBlock]
    .filter(Boolean)
    .join("\n\n") + taskAddendum;
}

/**
 * Thin host-side bridge to the Browser RAG module (v0.5.0). Centralises the
 * "fetch relevant world memory for this query" call so every AI call site
 * can opt in with one line, while keeping all failure handling in one place.
 * ALWAYS resolves to a string ("" when RAG is off, not ready, or errors) so
 * narration never blocks or breaks on memory retrieval.
 */
const RagBridge = {
  /**
   * Retrieve a "RELEVANT WORLD MEMORY" prompt block for a query.
   * @param {string} queryText - the player's prompt / move / scene seed.
   * @returns {Promise<string>}
   */
  async fetchMemory(queryText) {
    try {
      if (!BrowserRAG?.isAvailable?.()) return "";
      const q = String(queryText || "").trim();
      if (!q) return "";
      return await BrowserRAG.buildContextBlock(q);
    } catch (e) {
      console.warn(LOG_PREFIX, "[RAG] fetchMemory failed (continuing without memory):", e?.message || e);
      return "";
    }
  },

  /** Fire-and-forget: embed a freshly written/updated journal entry. */
  indexEntry(entry) {
    try {
      if (!entry || !BrowserRAG?.isAvailable?.() || !BrowserRAG.autoIndex()) return;
      BrowserRAG.indexJournalEntry(entry).catch(() => {});
    } catch (_) {}
  }
};

/**
 * A small bottom-right progress card for long RAG operations (model
 * download + bulk reindex). Reuses the journal-toast host styling, with an
 * inner determinate progress bar. All DOM access is defensive so headless
 * environments simply no-op. (v0.5.0)
 */
const RagProgress = {
  _el: null,

  _host() {
    let host = document.getElementById("es-journal-toasts");
    if (!host) {
      host = document.createElement("div");
      host.id = "es-journal-toasts";
      document.body.appendChild(host);
    }
    return host;
  },

  /** Show (or reset) the progress card with an initial label. */
  show(label) {
    try {
      this.hide();
      const el = document.createElement("div");
      el.className = "es-journal-toast es-rag-progress";
      el.innerHTML =
        `<span class="es-jt-icon">🧠</span>` +
        `<span class="es-jt-text"><span class="es-rag-label">${escapeHtml(label || "Working…")}</span>` +
        `<span class="es-rag-bar"><span class="es-rag-bar-fill" style="width:0%"></span></span></span>`;
      this._host().appendChild(el);
      requestAnimationFrame(() => el.classList.add("es-jt-show"));
      this._el = el;
    } catch (_) { this._el = null; }
  },

  /** Update label and (optional) percentage [0–100]. */
  update(label, pct) {
    try {
      if (!this._el) return;
      const lab = this._el.querySelector(".es-rag-label");
      const fill = this._el.querySelector(".es-rag-bar-fill");
      if (lab && label) lab.textContent = label;
      if (fill && typeof pct === "number") fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    } catch (_) {}
  },

  /** Finish successfully — show a final message, then fade out. */
  done(label) { this._finish(label, 2200); },

  /** Finish with an error tint. */
  fail(label) {
    try { this._el?.classList.add("es-rag-fail"); } catch (_) {}
    this._finish(label, 3000);
  },

  _finish(label, after) {
    try {
      if (this._el) {
        const lab = this._el.querySelector(".es-rag-label");
        const fill = this._el.querySelector(".es-rag-bar-fill");
        if (lab && label) lab.textContent = label;
        if (fill) fill.style.width = "100%";
      }
    } catch (_) {}
    setTimeout(() => this.hide(), after);
  },

  hide() {
    try {
      const el = this._el;
      if (!el) return;
      el.classList.remove("es-jt-show");
      setTimeout(() => { try { el.remove(); } catch (_) {} }, 400);
      this._el = null;
    } catch (_) { this._el = null; }
  }
};

/**
 * Build the auto-journaling metadata protocol block (v0.4.0).
 *
 * Teaches the model to append a single, machine-readable metadata block at
 * the very END of its reply describing any new entities, established facts,
 * open mysteries, world-state changes, and player decisions worth
 * remembering. The client ({@link JournalSystem.ingestReply}) parses this
 * block, hides it from the visible narration, and feeds it to the background
 * {@link JournalQueue} which writes / updates Foundry Journal Entries.
 *
 * The block is OPTIONAL: the model is told to omit it entirely when nothing
 * noteworthy happened, so casual chatter doesn't spawn journals.
 */
function buildJournalPromptBlock() {
  return `\
CHRONICLE METADATA (auto-journaling — append AFTER your narration):
The Skald keeps a living chronicle. When your reply introduces or advances
anything worth remembering, append EXACTLY ONE metadata block as the very
last thing in your reply, on its own lines, in this precise shape:

[[SKALD_META]]
{"entities":[{"type":"npc","name":"Kendra","action":"create","description":"A scarred warden of the iron marches who guards the barrow road.","motivations":"Avenge her slain kin","relationships":"Wary ally of the player"}],"facts":["The barrow road floods at every dusk tide"],"mysteries":["Who lit the signal fire on the Broken Tor?"],"worldState":{"weather":"iron storm rising"},"decisions":["The player swore to escort Kendra to Highmount"]}
[[/SKALD_META]]

Rules for the block:
• It MUST be valid, single-line JSON (no comments, no trailing commas).
• Every field is OPTIONAL — include only what genuinely applies. If nothing
  is worth recording, OMIT THE WHOLE BLOCK. Do not invent filler.
• "entities": notable characters/places/things. Each has:
    - "type": one of "npc" | "location" | "discovery"
    - "name": short proper name (the journal title)
    - "action": "create" (new) or "update" (add to an existing entry)
    - "description": 1–3 sentences of GM-usable detail
    - optional extras by type:
        npc       → "motivations", "relationships"
        location  → "features", "dangers"
        discovery → "significance", "connectedTo"
• "facts": short strings of established continuity the GM must keep true.
• "mysteries": unresolved questions / open story threads.
• "worldState": flat key→value pairs for changing conditions (weather,
  faction stance, time of day, …).
• "decisions": meaningful choices the players just made.
• NEVER mention this block, its syntax, or "metadata" in your narration. The
  player never sees it — it is stripped before display.`;
}

/**
 * Build the Ironsworn-integration portion of the system prompt. This
 * teaches the model that it can drive the real foundry-ironsworn rules
 * engine, lists the moves it may call for, defines the structured
 * directive syntax the client parses, and (optionally) injects the live
 * character/battlefield state.
 *
 * Returns "" when integration is unavailable so the prompt stays clean.
 */
function buildIronswornPromptBlock({ allowMoves = false, allowEffects = false, context = "" } = {}) {
  if (!Integration.active()) return "";

  const moveList = IronswornController.moves
    .filter(m => m.cat !== "Fate")
    .map(m => {
      const stats = m.stats.filter(s => s !== "progress" && s !== "supply");
      return `  • ${m.name}${stats.length ? ` (+${stats.join("/")})` : ""}`;
    })
    .join("\n");

  const parts = [];

  parts.push(`\
IRONSWORN SYSTEM INTEGRATION (you are wired to the real rules engine):
You are running atop the official "foundry-ironsworn" system. You do NOT
roll dice yourself — the system rolls them. Your role is to decide WHICH
move fits the fiction, suggest it, and then narrate and apply the
consequences of whatever the dice say.`);

  if (allowMoves) {
    parts.push(`\
WHEN A MOVE IS WARRANTED:
End your reply with EXACTLY ONE suggestion directive on its own line:
  [[MOVE: <Move Name> | <Stat> | <one short reason>]]
Use a Stat from {Edge, Heart, Iron, Shadow, Wits} — or "—" for moves that
take no stat (e.g. progress moves). Suggest a move only when the fiction
demands a roll; for pure conversation or rules questions, omit it.
Moves you may suggest:
${moveList}`);
  }

  if (allowEffects) {
    parts.push(`\
AFTER A ROLL RESOLVES (you will be told the outcome — strong hit / weak
hit / miss / match):
1. Narrate the outcome in your Skald voice (2–4 sentences).
2. Then, if mechanical consequences follow from the fiction, append any
   of these effect directives, each on its own line:
   [[EFFECT: momentum <+N|-N|reset>]]
   [[EFFECT: harm <N>]]              (damage to the active character)
   [[EFFECT: stress <N>]]
   [[EFFECT: supply <+N|-N>]]
   [[EFFECT: progress <Track Name> <+N ticks | rank>]]
   [[EFFECT: oracle <Oracle Name>]] (ask the system to roll an oracle)
Outcome semantics: STRONG HIT = you get what you want, often +momentum.
WEAK HIT = you succeed at a cost (lose supply/momentum, partial info).
MISS = you fail and "pay the price" (harm, stress, lost ground, a twist).
MATCH (both challenge dice equal) = introduce a dramatic complication.
Only emit effects that the rules/fiction actually call for. Never invent
dice results — you only react to the outcome you are given.

COMBAT AUTOMATION (progress tracks, initiative):
A fight in Ironsworn is run on a PROGRESS TRACK per foe, plus a single
INITIATIVE state telling who is in control. You drive these with:
   [[EFFECT: create_combat <Foe Name> <rank>]]
        Create a combat progress track for a foe the moment a fight with
        them begins (the first time the character Enters the Fray, or a
        new foe joins).
        RANK IS USUALLY OPTIONAL — the client looks the foe up in the
        official Ironsworn foe compendium and uses its canonical rank.
          • STANDARD foes (Bear, Wolf, Wyvern, Bandit, Hollow, Basilisk,
            Troll, Harrow Spider, …): just give the NAME, omit the rank.
            e.g. [[EFFECT: create_combat Bear]]  → rank filled from compendium.
          • UNIQUE / CUSTOM foes you invent (not in the rulebook): give an
            explicit rank so the track is sized correctly.
            e.g. [[EFFECT: create_combat Ancient Shadow Dragon extreme]]
        <rank> threat scale: troublesome (trivial), dangerous (real threat),
        formidable (tough), extreme (deadly), epic (legendary). If you give
        no rank and the foe isn't in the compendium, the configured default
        rank is used. When in doubt for a named, ordinary creature, prefer
        omitting the rank so the official value is used.
   [[EFFECT: create_vow <Name> <rank> <description>]]
        Create a vow/quest progress track when the character swears an iron vow.
   [[EFFECT: initiative <gain|lose>]]
        Record whether the character now has initiative ("in control",
        gain) or has lost it ("in a bad spot", lose).
   [[EFFECT: end_combat <Foe Name>]]
        Mark a foe's combat track complete when they are defeated, flee,
        yield, or the fight otherwise ends.
IMPORTANT — combat moves are AUTOMATED for you. When the resolved move is
"Enter the Fray", "Strike", or "Clash", the client AUTOMATICALLY:
  • on a hit to Enter the Fray → grants initiative,
  • on a hit to Strike/Clash → marks progress on the active foe's track by
    its rank (strong hit keeps initiative, weak hit loses it),
  • on a miss → loses initiative.
So for those moves, do NOT emit [[EFFECT: initiative ...]] or
[[EFFECT: progress ...]] yourself — they would double-apply. You SHOULD
still emit [[EFFECT: create_combat ...]] when a fight first starts (so the
track exists to mark), and [[EFFECT: end_combat ...]] when a foe is finished.`);
  }

  if (context && typeof context === "string" && context.trim()) {
    parts.push(`LIVE GAME STATE (authoritative — read from the sheet):\n${context.trim()}`);
  }

  return parts.join("\n\n");
}

/* ===================================================================== */
/*  §4  API CLIENT                                                         */
/* ===================================================================== */

const Client = {
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
    const apiKey   = Settings.get("apiKey");
    const model    = Settings.get("modelName")   || DEFAULT_MODEL;
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
      stream: false
    };

    console.log(LOG_PREFIX, "Calling AI:", { endpoint, model, msgCount: messages.length });

    let response;
    try {
      response = await fetch(API_PATH, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ apiKey, endpoint, payload })
      });
    } catch (netErr) {
      console.error(LOG_PREFIX, "fetch failed:", netErr);
      throw new Error(
        "Cannot reach the Skald's server hook.\n" +
        "Make sure Foundry was started with:\n" +
        "  node --import ./Data/modules/the-eternal-skald/scripts/eternal-skald-server.mjs resources/app/main.mjs\n" +
        "See the README for details."
      );
    }

    // 404 = hook not loaded (Foundry's own 404 page)
    if (response.status === 404) {
      throw new Error(
        "The Eternal Skald server hook is not loaded (404).\n" +
        "Add --import to your Foundry startup command. See README → Setup."
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
    const apiKey   = Settings.get("apiKey");
    const model    = Settings.get("modelName")   || DEFAULT_MODEL;
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

    console.log(LOG_PREFIX, "Streaming AI:", { endpoint, model, msgCount: messages.length });

    let response;
    try {
      response = await fetch(STREAM_PATH, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ apiKey, endpoint, payload })
      });
    } catch (netErr) {
      console.error(LOG_PREFIX, "stream fetch failed:", netErr);
      throw new Error(
        "Cannot reach the Skald's server hook.\n" +
        "Make sure Foundry was started with:\n" +
        "  node --import ./Data/modules/the-eternal-skald/scripts/eternal-skald-server.mjs resources/app/main.mjs\n" +
        "See the README for details."
      );
    }

    // 404 = hook not loaded, or an older hook without the streaming route.
    if (response.status === 404) {
      throw new Error(
        "The Eternal Skald streaming endpoint is not available (404).\n" +
        "Update the server hook and add --import to your Foundry startup command. See README → Setup."
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

    const contentType = (response.headers.get("content-type") || "").toLowerCase();

    // Graceful degrade: server returned buffered JSON, not an SSE stream.
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
      // An SSE event block is one or more lines; collect the data payload
      // and detect a terminal `event: error` frame.
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
      // If we already have partial text, surface it; otherwise rethrow.
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
  }
};

/* ===================================================================== */
/*  §5  CONVERSATION MEMORY                                               */
/* ===================================================================== */

/**
 * In-memory rolling buffer of recent messages, keyed by "channel" so
 * separate concerns (general chat, an active NPC dialogue, etc.) don't
 * pollute each other.
 *
 * Each entry: { role: "user"|"assistant", content: string }
 */
const Memory = {
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

/* ===================================================================== */
/*  §6  CHAT MESSAGE HELPERS                                              */
/* ===================================================================== */

const Chat = {
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
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/* ===================================================================== */
/*  §6a-b  ENTITY LINKING (v0.5.1)                                        */
/* ===================================================================== */

/**
 * Turns plain entity names the Skald narrates into clickable links.
 *
 * Two sources are cross-referenced:
 *   1. The Living Chronicle — auto-scribed NPC / location / discovery
 *      Journal Entries. Matches become Foundry content links
 *      (`@UUID[JournalEntry.id]{Name}`) which Foundry auto-enriches in the
 *      chat log into clickable links that open the entry.
 *   2. The Ironsworn move catalog. Matches become a custom in-chat link
 *      that, when clicked, offers a one-click roll (wired by
 *      {@link Integration.wireSuggestionCard}). Move matching is
 *      case-SENSITIVE so ordinary verbs ("you strike the wolf") are never
 *      mistaken for the move ("make a Strike").
 *
 * The index is built lazily and cached, and invalidated whenever a journal
 * entry is created / updated / deleted or the world reloads. The whole
 * feature is additive and wrapped in try/catch: if anything goes wrong the
 * original (already-formatted) HTML is returned untouched, so narration is
 * never broken by linking.
 */
const EntityLinker = {
  /** @type {{regex: RegExp, byName: Map<string, object>}|null} */
  _cache: null,
  _dirty: true,

  /** Mark the cached index stale; it rebuilds on next use. */
  invalidate() { this._dirty = true; this._cache = null; },

  /** True iff the feature is switched on (defaults ON). */
  enabled() { return Settings.get("entityLinking") !== false; },

  /** Escape a literal string for safe inclusion in a RegExp. */
  _escapeRe(str) { return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); },

  /**
   * (Re)build the name → entry index and the combined matcher regex.
   * Returns the cache object (possibly with an empty index).
   */
  _build() {
    const byName = new Map();

    // --- 1) Chronicle journal entities (proper nouns; case-insensitive) ---
    try {
      if (typeof JournalSystem !== "undefined" && typeof JournalSystem.listEntries === "function") {
        for (const type of ["npc", "location", "discovery"]) {
          for (const j of JournalSystem.listEntries(type)) {
            const name = (j?.name ?? "").trim();
            if (name.length < 3) continue;
            const key = name.toLowerCase();
            if (byName.has(key)) continue; // first definition wins
            const uuid = j.uuid ?? `JournalEntry.${j.id}`;
            byName.set(key, {
              key: `journal:${key}`,
              name,
              kind: "journal",
              uuid,
              caseSensitive: false
            });
          }
        }
      }
    } catch (_) { /* journal not ready — skip */ }

    // --- 2) Ironsworn moves (case-SENSITIVE to avoid verb false-positives) ---
    try {
      if (IronswornController?.isActive?.() && Array.isArray(IronswornController.moves)) {
        for (const m of IronswornController.moves) {
          const name = (m?.name ?? "").trim();
          if (name.length < 3) continue;
          const key = name.toLowerCase();
          if (byName.has(key)) continue; // don't clobber a journal entity
          byName.set(key, {
            key: `move:${key}`,
            name,
            kind: "move",
            moveName: name,
            caseSensitive: true
          });
        }
      }
    } catch (_) { /* controller not ready — skip */ }

    let regex = null;
    if (byName.size) {
      // Longest names first so multi-word entities win over substrings.
      const alts = [...byName.values()]
        .map(e => e.name)
        .sort((a, b) => b.length - a.length)
        .map(n => this._escapeRe(n));
      // Unicode-aware word boundaries via lookarounds so we don't match
      // inside a longer word and so apostrophes/digits count as "word".
      try {
        regex = new RegExp(`(?<![\\p{L}\\p{N}'’])(?:${alts.join("|")})(?![\\p{L}\\p{N}'’])`, "giu");
      } catch (_) {
        // Engines without lookbehind: fall back to plain \b boundaries.
        regex = new RegExp(`\\b(?:${alts.join("|")})\\b`, "gi");
      }
    }

    this._cache = { regex, byName };
    this._dirty = false;
    return this._cache;
  },

  _index() {
    if (this._dirty || !this._cache) return this._build();
    return this._cache;
  },

  /** Build the replacement HTML for a single matched entity. */
  _renderLink(entry, matchedText) {
    if (entry.kind === "journal") {
      // Content-link TEXT — Foundry enriches this into a clickable link in
      // the chat log (same mechanism the !journals command relies on).
      // Strip braces from the label defensively so the syntax can't break.
      const label = matchedText.replace(/[{}]/g, "");
      return `@UUID[${entry.uuid}]{${label}}`;
    }
    // Move — custom link wired by Integration.wireSuggestionCard.
    const move = escapeHtml(entry.moveName);
    return `<a class="es-entity-link es-move-link" data-skald-action="link-move" ` +
      `data-move="${move}" data-tooltip="Ironsworn move: ${move} — click to roll">` +
      `<i class="fa-solid fa-dice-d6"></i>${escapeHtml(matchedText)}</a>`;
  },

  /**
   * Link entities inside an already-formatted (safe) HTML fragment.
   * Only text *between* tags is rewritten — never tag names/attributes,
   * never the contents of <code> or existing <a> elements. Each distinct
   * entity is linked at most once (its first mention) to avoid noise.
   *
   * @param {string} html  HTML produced by {@link formatMarkdown}
   * @returns {string}
   */
  link(html) {
    if (typeof html !== "string" || !html) return html;
    if (!this.enabled()) return html;

    let idx;
    try { idx = this._index(); } catch (_) { return html; }
    if (!idx?.regex || !idx.byName?.size) return html;

    try {
      const seen = new Set();
      // Split into tags vs. text, keeping the delimiters.
      const parts = html.split(/(<[^>]+>)/);
      let inCode = 0;
      let inAnchor = 0;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part) continue;

        if (part[0] === "<") {
          // It's a tag — track contexts we must not touch.
          const tag = part.toLowerCase();
          if (/^<code[\s>]/.test(tag)) inCode++;
          else if (/^<\/code>/.test(tag)) inCode = Math.max(0, inCode - 1);
          else if (/^<a[\s>]/.test(tag)) inAnchor++;
          else if (/^<\/a>/.test(tag)) inAnchor = Math.max(0, inAnchor - 1);
          continue; // never rewrite tags themselves
        }

        if (inCode || inAnchor) continue; // leave code / existing links alone

        idx.regex.lastIndex = 0;
        parts[i] = part.replace(idx.regex, (m) => {
          const entry = idx.byName.get(m.toLowerCase());
          if (!entry) return m;
          // Moves only link when the canonical capitalization matches.
          if (entry.caseSensitive && m !== entry.name) return m;
          if (seen.has(entry.key)) return m; // first mention only
          seen.add(entry.key);
          return this._renderLink(entry, m);
        });
      }

      return parts.join("");
    } catch (e) {
      console.warn(LOG_PREFIX, "entity linking failed:", e?.message || e);
      return html; // graceful: never break narration
    }
  }
};

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
function formatMarkdown(text, opts = {}) {
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

/* ===================================================================== */
/*  §6b  STREAMING DISPLAY (v0.3.3)                                       */
/* ===================================================================== */

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
function stripDirectivesForDisplay(text) {
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
function parseMetadata(text) {
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
async function callSkaldStreaming(messages, opts = {}) {
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
  const message = await ChatMessage.create(data);

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
    try {
      await message.update({ content: cardHtml });
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

/* ===================================================================== */
/*  §7  COMMAND HANDLERS                                                  */
/* ===================================================================== */

/**
 * Master dispatcher. Returns true if the message was a recognised Skald
 * command (so the chatMessage hook can return false and suppress the
 * default publication of the user's command line).
 *
 * IMPORTANT: This function MUST be synchronous. Each command handler is
 * async, but we deliberately fire-and-forget them with `.catch()` to log
 * any errors. The decision to suppress the default chat post must be
 * returned synchronously to Foundry — we can't `await` the handler.
 *
 * @param {string} rawText - the raw message text typed by the user
 * @returns {boolean} true if a Skald command was matched and dispatched
 */
function dispatchCommand(rawText) {
  console.log(`${LOG_PREFIX} dispatchCommand() called with:`, JSON.stringify(rawText));
  if (!rawText || typeof rawText !== "string") {
    console.log(`${LOG_PREFIX} dispatchCommand: rejected — not a non-empty string (type=${typeof rawText})`);
    return false;
  }
  const trimmed = rawText.trim();
  // We use "!" as the command prefix instead of "/" — see the COMMANDS
  // declaration above for the reason. Messages that don't start with
  // "!" are ignored here so normal chat passes through untouched.
  if (!trimmed.startsWith("!")) {
    console.log(`${LOG_PREFIX} dispatchCommand: rejected — does not start with "!"`);
    return false;
  }

  // --- AI Mode gate (v0.3.2) -------------------------------------------
  // The Skald only reacts to "!"-prefixed messages while AI Mode is ON.
  // When OFF we return false so Foundry publishes the line as ordinary
  // chat and the AI GM stays silent. Defaults to ON for new sessions.
  if (Settings.get("aiMode") === false) {
    console.log(`${LOG_PREFIX} dispatchCommand: AI Mode is OFF — ignoring "!" message, passing through as normal chat`);
    return false;
  }

  // Split on the first run of whitespace — "!oracle action" -> ["!oracle", "action"].
  // Commands without args (e.g. "!skald-help") split to a single-element array.
  const firstSpace = trimmed.search(/\s/);
  const head = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const args = (firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1)).trim();
  console.log(`${LOG_PREFIX} dispatchCommand: head=${JSON.stringify(head)} args=${JSON.stringify(args)}`);

  // Map command tokens to their async handler. We use a lookup table so we
  // can match the prefix exactly (no partial matches, no fall-through).
  const handler = (() => {
    switch (head) {
      case COMMANDS.HELP:    return () => Commands.help();
      case COMMANDS.SKALD:   return () => Commands.skald(args);
      case COMMANDS.ORACLE:  return () => Commands.oracle(args);
      case COMMANDS.NPC:     return () => Commands.npc(args);
      case COMMANDS.SCENE:   return () => Commands.scene(args);
      case COMMANDS.LORE:    return () => Commands.lore(args);
      case COMMANDS.COMBAT:  return () => Commands.combat(args);
      // --- Journal system (v0.4.0) ---
      case COMMANDS.JOURNAL: return () => Commands.journals(args);
      case COMMANDS.JOURNALS:return () => Commands.journals(args);
      case COMMANDS.MYSTERIES:return () => Commands.mysteries(args);
      case COMMANDS.REMIND:  return () => Commands.remind(args);
      case COMMANDS.END_SESSION: return () => Commands.endSession(args);
      // --- Browser-based RAG / AI memory (v0.5.0) ---
      case COMMANDS.REINDEX:    return () => Commands.reindex(args);
      case COMMANDS.RAG_STATUS: return () => Commands.ragStatus(args);
      default:               return null;
    }
  })();

  // --- Bare "!" alias (v0.3.2) ----------------------------------------
  // If the head isn't one of our explicit sub-commands, treat the whole
  // line (minus the leading "!") as a free-form prompt to the Skald.
  // This lets users invoke the AI GM with just "!" e.g.
  //   "!what lurks in the barrow?"  ->  Commands.skald("what lurks ...")
  // The explicit sub-commands (!oracle, !npc, !scene, !lore, !combat,
  // !skald, !skald-help) still take precedence via the switch above.
  let resolvedHandler = handler;
  if (!resolvedHandler) {
    const query = trimmed.slice(1).trim();   // drop the leading "!"
    if (!query) {
      // A lone "!" with nothing after it — nothing to ask the Skald.
      console.log(`${LOG_PREFIX} dispatchCommand: bare "!" with no prompt — ignoring`);
      return false;
    }
    console.log(`${LOG_PREFIX} dispatchCommand: no explicit sub-command for ${head} — routing to !skald with prompt:`, JSON.stringify(query));
    resolvedHandler = () => Commands.skald(query);
  }

  console.log(`${LOG_PREFIX} dispatching command "${head}" args="${args}"`);

  // Fire-and-forget: kick off the async handler, log any failure, but
  // DO NOT await — we have to return synchronously below so the hook
  // can suppress Foundry's default chat publication.
  Promise.resolve()
    .then(() => {
      console.log(`${LOG_PREFIX} command handler "${head}" starting...`);
      return resolvedHandler();
    })
    .then(result => {
      console.log(`${LOG_PREFIX} command handler "${head}" completed.`);
      return result;
    })
    .catch(err => {
      console.error(LOG_PREFIX, `Command "${head}" failed:`, err);
      try { ui.notifications?.error(`${SKALD_NAME}: ${err?.message ?? err}`); } catch (_) {}
    });

  return true;
}

const Commands = {

  /* ----------------------------- !skald-help ----------------------- */
  async help() {
    const rows = [
      [COMMANDS.HELP,   "Show this help card."],
      ["!&lt;message&gt;", "Speak with the Skald — just type <code>!</code> then your words. Ask anything — rules, ideas, narration."],
      [COMMANDS.SKALD,  "Speak with the Skald (explicit form). Same as <code>!&lt;message&gt;</code>."],
      [COMMANDS.ORACLE, "Roll an Ironsworn oracle and let the Skald interpret. e.g. <code>!oracle action</code>"],
      [COMMANDS.NPC,    "Conjure or roleplay an NPC. e.g. <code>!npc Old Keldra, the bone-witch</code>"],
      [COMMANDS.SCENE,  "Generate a scene/location description."],
      [COMMANDS.LORE,   "Generate world-building lore (and a Journal Entry)."],
      [COMMANDS.COMBAT, "Get tactical narration/advice for the current fight."],
      [COMMANDS.JOURNALS,  "List the chronicle entries the Skald has scribed. e.g. <code>!journals npc</code>"],
      [COMMANDS.MYSTERIES, "Review the open mysteries and unresolved threads."],
      [COMMANDS.REMIND,    "Recall what the chronicle holds — now with semantic memory. e.g. <code>!remind Keldra</code>"],
      [COMMANDS.END_SESSION, "GM-only: weave a Session Chronicle from this session's events."],
      [COMMANDS.REINDEX,   "GM-only: rebuild the Skald's semantic memory from all chronicle entries."],
      [COMMANDS.RAG_STATUS, "Show the state of the Skald's semantic memory (RAG)."]
    ];

    const tableRows = rows.map(([c, d]) =>
      `<tr><td><code>${c}</code></td><td>${d}</td></tr>`
    ).join("");

    const knownOracles = Object.keys(IronswornData.oracles)
      .map(k => `<code>${k}</code>`).join(", ");

    const body = `
      <p>I am <strong>${SKALD_NAME}</strong>, your saga-singer at this table. Speak to me with these runes:</p>
      <table class="es-help-table"><tbody>${tableRows}</tbody></table>
      <p class="es-help-aside"><em>Oracles available:</em> ${knownOracles}.</p>
      <p class="es-help-aside"><em>GM-only:</em> Combat auto-control may be toggled in <strong>Module Settings → The Eternal Skald</strong>.</p>
    `;
    return Chat.postSkald(body, { variant: "help", title: "Commands of the Skald" });
  },

  /* ----------------------------- !skald ---------------------------- */
  async skald(args) {
    if (!args) {
      return Chat.postSystem(game.i18n.localize("ETERNAL_SKALD.errors.emptySkald"));
    }
    return runConversation("general", args, {
      task: "Respond to the user as the Skald. If they ask a rules question, answer clearly; if they invite narration, narrate. If the fiction calls for a dice roll, suggest the appropriate Ironsworn move and stat using the [[MOVE:…]] directive.",
      allowMoves: true,
      includeContext: true
    });
  },

  /* ----------------------------- !oracle --------------------------- */
  async oracle(args) {
    const key = (args || "action").trim().toLowerCase();
    return OracleInterpreter.roll(key);
  },

  /* ----------------------------- !npc ------------------------------ */
  async npc(args) {
    if (!args) {
      return Chat.postSystem(game.i18n.localize("ETERNAL_SKALD.errors.emptyNpc"));
    }
    return NpcDialogue.invoke(args);
  },

  /* ----------------------------- !scene ---------------------------- */
  async scene(args) {
    const seed = args || "the current scene";
    const ctx = SceneContext.summarise();
    const task = `Describe a vivid, atmospheric Ironsworn scene. Focus on sensory detail (iron weather, the wilds, ancient stones, distant horns). Avoid railroading the players. Subject: ${seed}.\n\nCurrent canvas context (may be empty):\n${ctx}`;
    return runConversation("scene", seed, { task, label: "Scene", variant: "default" });
  },

  /* ----------------------------- !lore ----------------------------- */
  async lore(args) {
    if (!args) {
      return Chat.postSystem(game.i18n.localize("ETERNAL_SKALD.errors.emptyLore"));
    }
    return LoreGenerator.write(args);
  },

  /* ----------------------------- !combat --------------------------- */
  async combat(args) {
    const ctx = CombatController.summariseCurrent();
    const task = `Provide a brief tactical narration AND a concrete suggestion for the current combat moment, grounded in Ironsworn moves (Enter the Fray, Strike, Clash, Secure an Advantage, Endure Harm). Be specific. Situation provided by the GM: ${args || "(unspecified)"}\n\nBattlefield snapshot:\n${ctx}`;
    return runConversation("combat", args || "tactical analysis", { task, label: "Counsel of Iron", variant: "combat" });
  },

  /* ------------------- !journal / !journals (v0.4.0) --------------- */
  async journals(_args) {
    const entries = JournalSystem.listEntries();
    if (!entries.length) {
      return Chat.postSystem(
        `<em>The chronicle is empty. Play on — I record what matters as our saga unfolds.</em>`,
        { gmWhisper: true }
      );
    }
    // Group by type in a stable display order.
    const order = ["npc", "location", "discovery", "worldFact", "storyThread", "session"];
    const byType = new Map();
    for (const j of entries) {
      const t = j.getFlag(MODULE_ID, "type");
      if (!byType.has(t)) byType.set(t, []);
      byType.get(t).push(j);
    }
    const sections = [];
    for (const t of order) {
      const list = byType.get(t);
      if (!list?.length) continue;
      const spec = JournalSystem.TYPES[t] || { label: t, emoji: "📝" };
      const items = list
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(j => `<li>${j.link ?? `@JournalEntry[${j.id}]{${escapeHtml(j.name)}}`}</li>`)
        .join("");
      sections.push(`<p class="es-journal-head"><strong>${spec.emoji} ${escapeHtml(spec.label)}s</strong> <span class="es-journal-count">(${list.length})</span></p><ul class="es-journal-list">${items}</ul>`);
    }
    return Chat.postSkald(sections.join(""), {
      variant: "lore",
      title: "The Skald's Chronicle"
    });
  },

  /* ------------------------- !mysteries (v0.4.0) ------------------- */
  async mysteries(_args) {
    const threads = JournalSystem.listEntries("storyThread");
    if (!threads.length) {
      return Chat.postSystem(
        `<em>No threads yet hang loose in the weave. The fates are quiet.</em>`,
        { gmWhisper: true }
      );
    }
    const links = threads
      .map(j => `<li>${j.link ?? `@JournalEntry[${j.id}]{${escapeHtml(j.name)}}`}</li>`)
      .join("");
    const body = `
      <p>Threads and mysteries still unspun, Ironsworn:</p>
      <ul class="es-journal-list">${links}</ul>
      <p class="es-help-aside"><em>Open the entry above to read the gathered mysteries, decisions and world-state.</em></p>`;
    return Chat.postSkald(body, { variant: "oracle", title: "Open Threads" });
  },

  /* --------------------------- !remind (RAG, v0.5.0) --------------- */
  /**
   * Recall what the chronicle holds about a topic. As of v0.5.0 this is
   * powered by Browser-Based RAG: the topic is embedded and matched
   * semantically against the journal vector store. When RAG is disabled,
   * still loading, or finds nothing, it degrades to the v0.4.0 keyword
   * search so the command always works.
   */
  async remind(args) {
    const topic = (args || "").trim();
    const entries = JournalSystem.listEntries();
    if (!entries.length) {
      return Chat.postSystem(`<em>I have naught written yet to recall.</em>`, { gmWhisper: true });
    }

    // ── 1) Try semantic recall (RAG) when a topic is given ───────────
    let hits = [];   // [{ j, ctx, label }]
    let usedRag = false;
    if (topic && BrowserRAG?.isAvailable?.()) {
      try {
        // Warm the model if needed so the very first !remind works too.
        if (!BrowserRAG.isReady()) {
          await Chat.postSystem(`<em>${SKALD_NAME} reaches into memory…</em>`, { gmWhisper: true });
          await BrowserRAG.init();
        }
        const results = await BrowserRAG.search(topic, { maxResults: 6 });
        if (results.length) {
          usedRag = true;
          for (const r of results) {
            const j = game.journal?.get?.(r.id);
            if (!j) continue;
            const spec = JournalSystem.TYPES[j.getFlag(MODULE_ID, "type")] || { label: "Note" };
            hits.push({ j, ctx: r.text || j.getFlag(MODULE_ID, "aiContext") || "", label: spec.label, score: r.score });
          }
        }
      } catch (e) {
        console.warn(LOG_PREFIX, "[RAG] !remind semantic search failed, falling back:", e?.message || e);
      }
    }

    // ── 2) Keyword fallback (v0.4.0 behaviour) ───────────────────────
    if (!hits.length) {
      const needle = topic.toLowerCase();
      const scored = entries.map(j => {
        const name = (j.name || "").toLowerCase();
        const ctx = (j.getFlag(MODULE_ID, "aiContext") || "").toLowerCase();
        let score = 0;
        if (needle) {
          if (name.includes(needle)) score += 5;
          for (const word of needle.split(/\s+/).filter(w => w.length > 2)) {
            if (name.includes(word)) score += 2;
            if (ctx.includes(word)) score += 1;
          }
        }
        return { j, score, updated: j.getFlag(MODULE_ID, "lastUpdated") || 0 };
      });
      let ranked = needle
        ? scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score)
        : scored.sort((a, b) => b.updated - a.updated);
      if (!ranked.length) ranked = scored.sort((a, b) => b.updated - a.updated);
      hits = ranked.slice(0, 6).map(({ j }) => {
        const spec = JournalSystem.TYPES[j.getFlag(MODULE_ID, "type")] || { label: "Note" };
        return { j, ctx: j.getFlag(MODULE_ID, "aiContext") || "", label: spec.label };
      });
    }

    // Build a compact context digest from the matched entries for the AI.
    const digest = hits.map(({ j, ctx, label }) =>
      `• [${label}] ${j.name}: ${ctx}`.slice(0, 600)
    ).join("\n");

    const subject = topic ? `the topic "${topic}"` : "recent events";
    const task = `The GM asks you to recall what the chronicle holds about ${subject}. Using ONLY the journal notes below, give a tight, in-character reminder (3-6 sentences) of who/what/where matters and any open threads. Do not invent details beyond the notes. Do NOT append any metadata block.\n\nCHRONICLE NOTES:\n${digest}`;

    try {
      const reply = await Client.chat([
        { role: "system", content: buildSystemPrompt({ task }) },
        { role: "user", content: topic ? `Remind me about: ${topic}` : "Remind me what has happened recently." }
      ], { temperature: 0.7, maxTokens: 600 });
      const links = hits.map(({ j }) => j.link ?? `@JournalEntry[${j.id}]{${escapeHtml(j.name)}}`).join(" · ");
      const recallNote = usedRag ? ` <span class="es-rag-badge">semantic recall</span>` : "";
      const body = `${formatMarkdown(reply)}<p class="es-help-aside"><em>Drawn from:</em> ${links}${recallNote}</p>`;
      return Chat.postSkald(body, { variant: "lore", title: topic ? `Recalling: ${topic}` : "The Skald Recalls" });
    } catch (err) {
      console.warn(LOG_PREFIX, "!remind failed", err);
      // Degrade to a plain link list if the AI is unreachable.
      const links = hits.map(({ j }) => `<li>${j.link ?? `@JournalEntry[${j.id}]{${escapeHtml(j.name)}}`}</li>`).join("");
      return Chat.postSkald(`<p>From the chronicle:</p><ul class="es-journal-list">${links}</ul>`, {
        variant: "lore", title: topic ? `Recalling: ${topic}` : "The Skald Recalls"
      });
    }
  },

  /* --------------------------- !reindex (v0.5.0) ------------------- */
  /**
   * Rebuild the entire semantic memory index from the current journal
   * entries. GM-only. Surfaces a progress toast while the model loads and
   * embeds each entry.
   */
  async reindex(_args) {
    if (!game.user.isGM) {
      return Chat.postSystem(`<em>Only the GM may re-weave the threads of memory.</em>`, { gmWhisper: true });
    }
    if (!BrowserRAG?.isAvailable?.()) {
      return Chat.postSystem(
        `<em>Semantic memory is unavailable here (it is disabled, or your browser lacks support). Enable it in <strong>Module Settings → The Eternal Skald</strong>.</em>`,
        { gmWhisper: true }
      );
    }
    const entries = JournalSystem.listEntries();
    if (!entries.length) {
      return Chat.postSystem(`<em>There is nothing yet written to commit to memory.</em>`, { gmWhisper: true });
    }

    RagProgress.show("Awakening memory…");
    try {
      const { indexed, total } = await BrowserRAG.reindexAll(entries, {
        onProgress: (done, tot, modelEvt) => {
          if (modelEvt && modelEvt.status && modelEvt.status !== "ready") {
            const pct = typeof modelEvt.progress === "number" ? ` ${modelEvt.progress}%` : "";
            RagProgress.update(`Loading memory model…${pct}`, modelEvt.progress);
          } else {
            const pct = tot ? Math.round((done / tot) * 100) : 0;
            RagProgress.update(`Embedding chronicle ${done}/${tot}`, pct);
          }
        }
      });
      RagProgress.done(`Memory woven: ${indexed}/${total} entries.`);
      return Chat.postSkald(
        `<p>I have committed <strong>${indexed}</strong> of <strong>${total}</strong> chronicle entries to memory. Ask me to <code>!remind</code> you of anything within.</p>`,
        { variant: "lore", title: "The Threads of Memory" }
      );
    } catch (err) {
      console.warn(LOG_PREFIX, "[RAG] !reindex failed", err);
      RagProgress.fail("Memory weaving failed.");
      return Chat.postSystem(`<strong>The weaving faltered:</strong> ${escapeHtml(err?.message || String(err))}`, { gmWhisper: true });
    }
  },

  /* --------------------------- !rag-status (v0.5.0) ---------------- */
  /** Report semantic-memory health (model, vector count, settings). */
  async ragStatus(_args) {
    const s = await (BrowserRAG?.status?.() ?? Promise.resolve(null));
    if (!s) {
      return Chat.postSystem(`<em>Semantic memory is not loaded.</em>`, { gmWhisper: true });
    }
    const yn = (b) => b ? "✅" : "❌";
    const rows = [
      ["Enabled",            yn(s.enabled)],
      ["Browser support",    yn(s.indexedDB)],
      ["Model loaded",       s.modelFailed ? "⚠️ failed this session" : yn(s.modelReady)],
      ["Auto-index",         yn(s.autoIndex)],
      ["Vectors stored",     String(s.vectorCount)],
      ["Model",              `<code>${escapeHtml(s.model)}</code> (${s.dims}-dim)`],
      ["Max results",        String(s.maxResults)],
      ["Context budget",     `${s.contextTokens} tokens`],
      ["Similarity threshold", String(s.threshold)]
    ];
    const tableRows = rows.map(([k, v]) => `<tr><td><strong>${k}</strong></td><td>${v}</td></tr>`).join("");
    const tip = !s.modelReady && !s.modelFailed
      ? `<p class="es-help-aside"><em>The memory model loads on first use (or run <code>!reindex</code> to warm it now).</em></p>`
      : "";
    return Chat.postSkald(
      `<p><strong>Semantic Memory (RAG) status:</strong></p><table class="es-help-table"><tbody>${tableRows}</tbody></table>${tip}`,
      { variant: "help", title: "The Skald's Memory" }
    );
  },

  /* ------------------------ !end-session (v0.4.0) ------------------ */
  async endSession(_args) {
    if (!game.user.isGM) {
      return Chat.postSystem(`<em>Only the GM may close the session's chronicle.</em>`, { gmWhisper: true });
    }
    await Chat.postSystem(`<em>${SKALD_NAME} gathers the threads of the session…</em>`, { gmWhisper: true });
    const entry = await JournalSystem.generateSessionChronicle({ announce: true });
    if (entry) {
      ui.notifications?.info(`${SKALD_NAME}: Session chronicle written.`);
    }
    return entry;
  }
};

/**
 * Generic conversation runner used by !skald, !scene, !combat. Manages
 * memory, builds the system prompt, calls the API, and posts the reply.
 */
async function runConversation(channel, userText, { task, label, variant = "default", allowMoves = false, includeContext = false } = {}) {
  try {
    Memory.push(channel, "user", userText);
    // Inject the live Ironsworn game state when requested and available.
    const context = includeContext ? Integration.gatherContext() : "";
    // Narrative channels (skald/scene/combat) are the chronicle's primary
    // source. Allow the AI to append a [[SKALD_META]] block we can ingest.
    const allowJournal = ["skald", "scene", "combat"].includes(channel);
    // Recall semantically-relevant world memory for this prompt (v0.5.0).
    // Always resolves to a string ("" when RAG is off/not ready/fails).
    const memory = await RagBridge.fetchMemory(userText);
    const messages = [
      { role: "system", content: buildSystemPrompt({ task, allowMoves, context, allowJournal, memory }) },
      ...Memory.get(channel)
    ];

    // ── Streaming path (v0.3.3) ──────────────────────────────────────
    // The live card IS the immediate feedback, so we skip the "listens to
    // the wind" whisper. Directives are stripped from the streamed display;
    // the full raw reply is still parsed afterwards for the move card.
    if (Settings.get("streamingEnabled") !== false) {
      try {
        const { reply } = await callSkaldStreaming(messages, { variant, title: label });
        Memory.push(channel, "assistant", reply);
        if (allowMoves && Integration.active()) {
          await Integration.postSuggestionFromReply(reply);
        }
        // Fire-and-forget chronicle ingestion (never blocks/breaks play).
        if (allowJournal) JournalSystem.ingestReply(reply, { channel });
        return reply;
      } catch (streamErr) {
        // callSkaldStreaming already rendered a readable error into its card
        // (or recovered via buffered fallback). Surface a notification only.
        console.error(LOG_PREFIX, "runConversation stream:", streamErr);
        ui.notifications?.error(`${SKALD_NAME}: ${streamErr.message}`);
        return null;
      }
    }

    // ── Buffered path (streaming disabled or unavailable) ────────────
    await Chat.postSystem(`<em>${SKALD_NAME} listens to the wind…</em>`, { gmWhisper: true });
    const reply = await Client.chat(messages);
    Memory.push(channel, "assistant", reply);

    // When moves are allowed, route through the integration so any
    // [[MOVE:…]] directive becomes an interactive suggestion card.
    if (allowMoves && Integration.active()) {
      await Integration.postReplyWithSuggestion(reply, { variant, title: label });
    } else {
      // Strip any stray directive (move + chronicle metadata) so it never
      // leaks into the chat card.
      const { clean } = Integration.parseMoveSuggestion(reply);
      await Chat.postSkald(formatMarkdown(stripDirectivesForDisplay(clean || reply)), { variant, title: label });
    }
    // Fire-and-forget chronicle ingestion (never blocks/breaks play).
    if (allowJournal) JournalSystem.ingestReply(reply, { channel });
    return reply;
  } catch (err) {
    console.error(LOG_PREFIX, err);
    await Chat.postSystem(
      `<strong>The Skald falters:</strong> ${escapeHtml(err.message)}`,
      { gmWhisper: true }
    );
    ui.notifications?.error(`${SKALD_NAME}: ${err.message}`);
    return null;
  }
}

/* ===================================================================== */
/*  §7.5  IRONSWORN INTEGRATION ORCHESTRATOR                             */
/* ===================================================================== */

/**
 * The Integration object is the glue between the Skald's AI brain and the
 * foundry-ironsworn rules engine (via IronswornController). It:
 *   • gathers live character/battlefield context for prompts,
 *   • parses the AI's structured directives ([[MOVE:…]] / [[EFFECT:…]]),
 *   • renders interactive move-suggestion cards with Roll / Choose buttons,
 *   • shows a move-selector dialog for overrides,
 *   • listens for Ironsworn roll results and feeds them back to the AI for
 *     narration + (optional) mechanical consequences.
 *
 * Everything degrades gracefully when the Ironsworn system is absent.
 */
const Integration = {
  /** ChatMessage ids whose roll we've already narrated (anti-double-fire). */
  _processedRolls: new Set(),
  /** A short note of what the player was trying to do, for narration context. */
  _lastIntent: "",

  /** True iff the Ironsworn system is active AND integration is enabled. */
  active() {
    try {
      if (!IronswornController.isActive()) return false;
      return Settings.get("ironswornIntegration") ?? true;
    } catch (_) { return false; }
  },

  /**
   * Build the live game-state context string injected into prompts:
   * active character sheet + combat snapshot or scene summary.
   */
  gatherContext() {
    if (!this.active()) return "";
    const blocks = [];
    try {
      const charDesc = IronswornController.describeCharacter();
      if (charDesc) blocks.push(charDesc);
    } catch (e) { console.warn(LOG_PREFIX, "gatherContext: character read failed", e); }

    try {
      const combatState = IronswornController.describeCombatState();
      if (combatState) blocks.push(combatState);
    } catch (e) { console.warn(LOG_PREFIX, "gatherContext: combat state read failed", e); }

    try {
      if (game?.combat?.started) {
        blocks.push("Battlefield:\n" + CombatController.summariseCurrent());
      } else {
        const scene = SceneContext.summarise();
        if (scene && scene !== "(no active scene)") blocks.push("Scene:\n" + scene);
      }
    } catch (e) { console.warn(LOG_PREFIX, "gatherContext: scene/combat read failed", e); }

    return blocks.join("\n\n");
  },

  /* ---------------- Directive parsing ---------------- */

  /**
   * Extract a single [[MOVE: Name | Stat | reason]] directive.
   * @returns {{ suggestion: {name,stat,reason}|null, clean: string }}
   */
  parseMoveSuggestion(text) {
    if (typeof text !== "string") return { suggestion: null, clean: "" };
    const re = /\[\[\s*MOVE\s*:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*(?:\|\s*([^\]]*?))?\s*\]\]/i;
    const m = text.match(re);
    if (!m) return { suggestion: null, clean: text };
    const name = m[1].trim();
    let stat = (m[2] || "").trim().toLowerCase();
    if (stat === "—" || stat === "-" || stat === "none" || stat === "n/a") stat = "";
    const reason = (m[3] || "").trim();
    const clean = text.replace(m[0], "").trim();
    return { suggestion: { name, stat, reason }, clean };
  },

  /**
   * Extract all [[EFFECT: …]] directives.
   * @returns {{ effects: Array<object>, clean: string }}
   */
  parseEffects(text) {
    if (typeof text !== "string") return { effects: [], clean: "" };
    const effects = [];
    const re = /\[\[\s*EFFECT\s*:\s*([^\]]+?)\s*\]\]/gi;
    let clean = text;
    let m;
    while ((m = re.exec(text)) !== null) {
      const body = m[1].trim();
      const parsed = this._parseOneEffect(body);
      if (parsed) effects.push(parsed);
    }
    clean = text.replace(re, "").trim();
    return { effects, clean };
  },

  _parseOneEffect(body) {
    // body examples: "momentum +2", "momentum reset", "harm 1", "stress 2",
    // "supply -1", "progress Vengeance on the Iron King +8", "oracle Pay the Price"
    const lc = body.toLowerCase();
    const firstWord = lc.split(/\s+/)[0];

    if (firstWord === "momentum") {
      const rest = body.slice(8).trim();
      if (/reset/i.test(rest)) return { kind: "momentum", op: "reset" };
      const n = parseInt(rest, 10);
      if (Number.isFinite(n)) return { kind: "momentum", op: "delta", value: n };
      return null;
    }
    if (firstWord === "harm")   { const n = parseInt(body.slice(4), 10); return Number.isFinite(n) ? { kind: "harm",   value: Math.abs(n) } : null; }
    if (firstWord === "stress") { const n = parseInt(body.slice(6), 10); return Number.isFinite(n) ? { kind: "stress", value: Math.abs(n) } : null; }
    if (firstWord === "supply") { const n = parseInt(body.slice(6), 10); return Number.isFinite(n) ? { kind: "supply", value: n } : null; }
    if (firstWord === "progress") {
      // "progress <Track Name> <+N | rank>"
      const rest = body.slice(8).trim();
      const tickMatch = rest.match(/([+-]?\d+)\s*(?:ticks?)?\s*$/i);
      const rankMatch = /\brank\b\s*$/i.test(rest);
      let name = rest, value = 4, byRank = false;
      if (rankMatch) { byRank = true; name = rest.replace(/\brank\b\s*$/i, "").trim(); }
      else if (tickMatch) { value = parseInt(tickMatch[1], 10); name = rest.slice(0, tickMatch.index).trim(); }
      name = name.replace(/^on\s+/i, "").replace(/[:\-—]+$/, "").trim();
      if (!name) return null;
      return { kind: "progress", track: name, value, byRank };
    }
    if (firstWord === "oracle") {
      const name = body.slice(6).trim();
      return name ? { kind: "oracle", name } : null;
    }

    // ---- Combat / quest track directives (v0.3.0) ----
    // Accept underscores or spaces: "create_combat" or "create combat".
    const m = body.match(/^(create[_\s]combat|create[_\s]vow|initiative|end[_\s]combat)\b\s*(.*)$/i);
    if (m) {
      const verb = m[1].toLowerCase().replace(/\s+/g, "_");
      const rest = (m[2] || "").trim();

      if (verb === "initiative") {
        const r = rest.toLowerCase();
        if (/\b(gain|win|seize|seized|take|taken|control|in[-\s]?control)\b/.test(r)) return { kind: "initiative", value: "gain" };
        if (/\b(lose|lost|los[et]|forgo|forgone|forfeit|bad[-\s]?spot|out)\b/.test(r)) return { kind: "initiative", value: "lose" };
        return null;
      }

      if (verb === "create_combat") {
        const { name, rank } = this._splitNameRank(rest);
        return name ? { kind: "create_combat", name, rank } : null;
      }

      if (verb === "create_vow") {
        const { name, rank, desc } = this._splitNameRank(rest);
        return name ? { kind: "create_vow", name, rank, description: desc } : null;
      }

      if (verb === "end_combat") {
        const { name } = this._splitNameRank(rest);
        return name ? { kind: "end_combat", name } : null;
      }
    }
    return null;
  },

  /** Ironsworn rank words, used to split "Name <rank> [description]". */
  _RANKS: ["troublesome", "dangerous", "formidable", "extreme", "epic"],

  /**
   * Split a directive tail of the form "<Name...> [rank] [description...]".
   * The rank token (if any of the canonical ranks appears) separates the
   * track name from an optional trailing description. When no rank token is
   * present, the whole string is treated as the name (rank=null).
   * @returns {{name:string, rank:string|null, desc:string}}
   */
  _splitNameRank(rest) {
    if (!rest) return { name: "", rank: null, desc: "" };
    const tokens = rest.split(/\s+/);
    const idx = tokens.findIndex(t =>
      this._RANKS.includes(t.toLowerCase().replace(/[^a-z]/g, "")));
    if (idx === -1) {
      return { name: rest.replace(/[:\-—|]+$/, "").trim(), rank: null, desc: "" };
    }
    const name = tokens.slice(0, idx).join(" ").replace(/[:\-—|]+$/, "").trim();
    const rank = tokens[idx].toLowerCase().replace(/[^a-z]/g, "");
    const desc = tokens.slice(idx + 1).join(" ").replace(/^[:\-—|]+/, "").trim();
    return { name, rank, desc };
  },

  /* ---------------- AI reply posting (with suggestion card) ---------------- */

  /**
   * Post the Skald's reply, stripping any [[MOVE:…]] directive into a
   * separate interactive suggestion card (when move-suggestion is on and
   * the system is active).
   */
  async postReplyWithSuggestion(reply, { variant = "default", title } = {}) {
    const { suggestion, clean } = this.parseMoveSuggestion(reply);
    // Also strip any chronicle metadata block (v0.4.0) from the display copy.
    await Chat.postSkald(formatMarkdown(stripDirectivesForDisplay(clean || reply)), { variant, title });

    if (suggestion && this.active() && (Settings.get("suggestMoves") ?? true)) {
      this._lastIntent = suggestion.reason || this._lastIntent;
      await this.postSuggestionCard(suggestion);
    }
    return { suggestion, clean };
  },

  /**
   * Post ONLY the interactive move-suggestion card for a reply (v0.3.3).
   *
   * Used by the streaming path: the narration has already been rendered live
   * in its own card, so here we just parse the full raw reply for a
   * [[MOVE:…]] directive and, if present, append the Roll/Choose card.
   */
  async postSuggestionFromReply(reply) {
    const { suggestion } = this.parseMoveSuggestion(reply);
    if (suggestion && this.active() && (Settings.get("suggestMoves") ?? true)) {
      this._lastIntent = suggestion.reason || this._lastIntent;
      await this.postSuggestionCard(suggestion);
    }
    return suggestion;
  },

  /** Post the interactive "Roll this move / Choose different" card. */
  async postSuggestionCard(suggestion) {
    const move = IronswornController._resolveMove(suggestion.name);
    const label = move?.name ?? suggestion.name;
    const stat = suggestion.stat || (move?.stats?.find(s => s !== "progress" && s !== "supply")) || "";
    const statLabel = stat ? ` <span class="es-move-stat">+${escapeHtml(stat)}</span>` : "";
    const reason = suggestion.reason ? `<p class="es-move-reason"><em>${escapeHtml(suggestion.reason)}</em></p>` : "";

    const body = `
      <div class="es-move-suggest">
        <p>The Skald counsels a move:</p>
        <p class="es-move-name"><strong>${escapeHtml(label)}</strong>${statLabel}</p>
        ${reason}
        <div class="es-move-buttons">
          <button type="button" class="es-btn es-btn-roll"
                  data-skald-action="roll-move"
                  data-move="${escapeHtml(label)}"
                  data-stat="${escapeHtml(stat)}">⚔ Roll ${escapeHtml(label)}</button>
          <button type="button" class="es-btn es-btn-choose"
                  data-skald-action="choose-move"
                  data-stat="${escapeHtml(stat)}">🎲 Choose Different Move</button>
        </div>
      </div>`;

    return Chat.postSkald(body, {
      variant: "suggest",
      title: "A Move Beckons",
      flags: { suggestion: { name: label, stat } }
    });
  },

  /**
   * Wire up the buttons on a rendered suggestion card. Called from the
   * renderChatMessageHTML hook for messages carrying our suggestion flag.
   */
  wireSuggestionCard(message, html) {
    const root = (html instanceof HTMLElement) ? html : html?.[0];
    if (!root) return;
    const buttons = root.querySelectorAll?.("[data-skald-action]") ?? [];
    for (const btn of buttons) {
      if (btn.dataset.skaldWired === "1") continue;
      btn.dataset.skaldWired = "1";
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const action = btn.dataset.skaldAction;
        const move = btn.dataset.move;
        const stat = btn.dataset.stat;
        try {
          if (action === "roll-move") {
            await this.doTriggerMove(move, stat);
          } else if (action === "choose-move") {
            await this.showMoveSelector(stat);
          } else if (action === "link-move") {
            // An inline move link in narration — offer the interactive
            // suggestion card so the player can roll it or pick another.
            if (!this.active()) {
              ui.notifications?.info(`${SKALD_NAME}: ${move} — Ironsworn system not active.`);
            } else {
              await this.postSuggestionCard({ name: move });
            }
          }
        } catch (e) {
          console.error(LOG_PREFIX, "suggestion button failed", e);
          ui.notifications?.error(`${SKALD_NAME}: ${e?.message ?? e}`);
        }
      });
    }
  },

  /* ---------------- Move triggering & selector ---------------- */

  /** Trigger a move through the Ironsworn controller (or manual fallback). */
  async doTriggerMove(moveName, stat) {
    if (!this.active()) {
      ui.notifications?.warn(`${SKALD_NAME}: Ironsworn system not active — cannot roll moves.`);
      return null;
    }
    this._lastIntent = `${moveName}${stat ? ` +${stat}` : ""}` + (this._lastIntent ? ` — ${this._lastIntent}` : "");
    const actor = IronswornController.getActiveCharacter();
    const res = await IronswornController.triggerMove(moveName, { actor, stat });
    if (!res?.ok) {
      await Chat.postSystem(
        `<strong>The dice would not answer:</strong> ${escapeHtml(res?.error ?? "unknown error")}`,
        { gmWhisper: true }
      );
    }
    // The resulting Ironsworn roll card (or manual card) is picked up by
    // onIronswornRoll(), which narrates the outcome.
    return res;
  },

  /** Show a dialog letting the user pick any catalogued move + stat. */
  async showMoveSelector(prefillStat = "") {
    const grouped = {};
    for (const m of IronswornController.moves) {
      (grouped[m.cat] ??= []).push(m);
    }
    const optgroups = Object.entries(grouped).map(([cat, moves]) => {
      const opts = moves.map(m => `<option value="${escapeHtml(m.name)}" data-stats="${escapeHtml(m.stats.join(','))}">${escapeHtml(m.name)}</option>`).join("");
      return `<optgroup label="${escapeHtml(cat)}">${opts}</optgroup>`;
    }).join("");

    const statOpts = ["", "edge", "heart", "iron", "shadow", "wits"].map(s =>
      `<option value="${s}"${s === prefillStat ? " selected" : ""}>${s ? s[0].toUpperCase() + s.slice(1) : "— (no stat)"}</option>`
    ).join("");

    const content = `
      <form class="es-move-selector">
        <div class="form-group">
          <label>Move</label>
          <select name="move">${optgroups}</select>
        </div>
        <div class="form-group">
          <label>Stat</label>
          <select name="stat">${statOpts}</select>
        </div>
      </form>`;

    const doRoll = async (htmlEl) => {
      const root = (htmlEl instanceof HTMLElement) ? htmlEl : htmlEl?.[0] ?? document;
      const move = root.querySelector?.('select[name="move"]')?.value;
      const stat = root.querySelector?.('select[name="stat"]')?.value ?? "";
      if (move) await this.doTriggerMove(move, stat);
    };

    // Prefer DialogV2 (v13+) but fall back to the classic Dialog.
    try {
      const DV2 = foundry?.applications?.api?.DialogV2;
      if (DV2) {
        await DV2.prompt({
          window: { title: "Choose a Move" },
          content,
          ok: { label: "Roll Move", callback: (_ev, button) => doRoll(button.form) },
          rejectClose: false
        });
        return;
      }
    } catch (e) { console.warn(LOG_PREFIX, "DialogV2 failed, trying classic Dialog", e); }

    try {
      // eslint-disable-next-line no-undef
      new Dialog({
        title: "Choose a Move",
        content,
        buttons: {
          roll:   { icon: '<i class="fas fa-dice-d20"></i>', label: "Roll Move", callback: (html) => doRoll(html) },
          cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "roll"
      }).render(true);
    } catch (e) {
      console.error(LOG_PREFIX, "No dialog API available", e);
      ui.notifications?.error(`${SKALD_NAME}: cannot open move selector.`);
    }
  },

  /* ---------------- Roll-result listener ---------------- */

  /** Verbose log gated behind the debugLogging world setting. */
  _dbg(...args) {
    try {
      if (Settings.get("debugLogging")) console.log(LOG_PREFIX, "[Ironsworn]", ...args);
    } catch (_) { /* settings may not be ready */ }
  },

  /* ---------------- Combat UI feedback ---------------- */

  /** Toast for combat-track lifecycle events (create / vow / end). */
  _notifyCombat(msg) {
    try { ui.notifications?.info(`${SKALD_NAME}: ${msg}`); } catch (_) {}
    this._dbg(`notify: ${msg}`);
  },

  /** Toast + flavour for an initiative change. */
  _notifyInitiative(gained) {
    const msg = gained
      ? "⚔ You seize the initiative — you are in control."
      : "⚠ You lose the initiative — you are in a bad spot.";
    try { gained ? ui.notifications?.info(`${SKALD_NAME}: ${msg}`)
                 : ui.notifications?.warn(`${SKALD_NAME}: ${msg}`); } catch (_) {}
    this._dbg(`notify: initiative ${gained ? "gained" : "lost"}`);
  },

  /** Toast for a progress mark on a combat track. */
  _notifyProgress(trackName, boxes) {
    try { ui.notifications?.info(`${SKALD_NAME}: progress on ${trackName} — ${boxes}/10 boxes.`); } catch (_) {}
    this._dbg(`notify: progress on ${trackName} → ${boxes}/10`);
  },

  /**
   * Inspect a freshly-created (or updated) ChatMessage. If it is an
   * Ironsworn move roll (or our own manual move roll), parse the outcome
   * and feed it to the AI for narration + optional mechanical effects.
   *
   * IMPORTANT — how the modern foundry-ironsworn system stores rolls:
   * It does NOT tag its move cards with `flags["foundry-ironsworn"]`.
   * Instead it serialises the roll into the card's HTML as
   *   <article class="ironsworn-roll" data-ironswornroll='{…json…}'>…
   * and attaches the Foundry Roll on `message.rolls`. We therefore detect
   * on those signals, not on a flag namespace (which is what the earlier
   * version checked — that is why auto-narration never fired).
   *
   * @param {ChatMessage} message
   * @param {{viaUpdate?: boolean}} [opts]
   */
  async onIronswornRoll(message, { viaUpdate = false } = {}) {
    try {
      this._dbg(`onIronswornRoll fired (viaUpdate=${viaUpdate}, id=${message?.id})`);

      if (!this.active())                              { this._dbg("→ skip: integration inactive"); return; }
      if (!(Settings.get("autoNarrateMoves") ?? true)) { this._dbg("→ skip: autoNarrateMoves disabled"); return; }
      if (!game.user?.isGM)                            { this._dbg("→ skip: not the GM client"); return; }
      if (!message?.id)                                { this._dbg("→ skip: message has no id"); return; }
      if (this._processedRolls.has(message.id))        { this._dbg("→ skip: already narrated this roll"); return; }

      const ourFlags = message?.flags?.[MODULE_ID];
      // Skip our own non-roll cards (narration, suggestions, etc.).
      if (ourFlags && !ourFlags.manualMove) { this._dbg("→ skip: our own non-roll card"); return; }

      const detection = this._detectIronswornRoll(message);
      if (!detection.isRoll) { this._dbg("→ skip: not an Ironsworn roll card"); return; }
      this._dbg(`→ Ironsworn roll card detected (source=${detection.source})`);

      const parsed = this._parseRollOutcome(message);
      if (!parsed) { this._dbg("→ skip: could not parse roll outcome from card"); return; }
      if (!parsed.resolved) {
        // e.g. extra challenge dice not yet resolved — wait for the
        // updateChatMessage hook to fire with the resolved content.
        this._dbg(`→ roll not yet resolved (move="${parsed.moveName}"); awaiting update`);
        return;
      }

      // Mark processed up-front so re-renders / the update hook don't
      // double-narrate the same roll.
      this._processedRolls.add(message.id);
      console.log(LOG_PREFIX, `Detected Ironsworn roll: ${parsed.moveName} → ${parsed.outcome}`);

      // Let the dice settle (incl. Dice So Nice 3D animation) before the
      // Skald speaks over the result.
      const delay = this._narrationDelayMs();
      this._dbg(`→ auto-narration scheduled in ${delay}ms`);
      setTimeout(() => {
        this._narrateOutcome(message, parsed).catch(e =>
          console.warn(LOG_PREFIX, "delayed _narrateOutcome failed", e));
      }, delay);
    } catch (e) {
      console.warn(LOG_PREFIX, "onIronswornRoll failed", e);
    }
  },

  /**
   * How long to wait before narrating, allowing dice animations to finish.
   * Reads the configurable "narrationDelay" world setting (ms), clamped to
   * the 0–5000 range. Falls back to 2000ms if the setting isn't available.
   */
  _narrationDelayMs() {
    let ms = Settings.get("narrationDelay");
    if (typeof ms !== "number" || Number.isNaN(ms)) ms = 2000;
    return Math.max(0, Math.min(5000, ms));
  },

  /**
   * Decide whether a chat message is an Ironsworn roll card.
   * @returns {{isRoll: boolean, source: string|null}}
   */
  _detectIronswornRoll(message) {
    const ourFlags = message?.flags?.[MODULE_ID];
    if (ourFlags?.manualMove) return { isRoll: true, source: "manual" };

    // Some/legacy versions DO set namespaced flags — honour them if present.
    const isFlags = message?.flags?.["foundry-ironsworn"];
    if (isFlags && (isFlags.moveDfId || isFlags.moveId || isFlags.dsid || isFlags.moveDsId)) {
      return { isRoll: true, source: "flags" };
    }

    // Modern system: the roll is serialised into the card HTML.
    const content = typeof message?.content === "string" ? message.content : "";
    if (/data-ironswornroll\s*=/.test(content) ||
        /class\s*=\s*['"][^'"]*\bironsworn-roll\b/.test(content)) {
      return { isRoll: true, source: "html" };
    }

    return { isRoll: false, source: null };
  },

  /**
   * Derive { moveName, outcome, score, challenge, match, resolved } from a
   * message. Tries, in order: our manual card flag → the serialised
   * `data-ironswornroll` HTML blob → the attached Foundry Roll dice.
   */
  _parseRollOutcome(message) {
    const ourFlags = message?.flags?.[MODULE_ID];

    // Manual move card: outcome already computed by the controller.
    if (ourFlags?.manualMove) {
      return {
        moveName:  ourFlags.moveName ?? "Move",
        outcome:   ourFlags.outcome ?? "",
        score:     ourFlags.score ?? null,
        challenge: ourFlags.challenge ?? [],
        match:     !!ourFlags.match,
        resolved:  true
      };
    }

    const fromHtml = this._parseFromHtml(message);
    if (fromHtml) { this._dbg("parsed outcome from card HTML:", JSON.stringify(fromHtml)); return fromHtml; }

    const fromRolls = this._parseFromRolls(message);
    if (fromRolls) { this._dbg("parsed outcome from message.rolls:", JSON.stringify(fromRolls)); return fromRolls; }

    return null;
  },

  /** Parse the serialised `data-ironswornroll` blob (+ rendered text) from card HTML. */
  _parseFromHtml(message) {
    const content = typeof message?.content === "string" ? message.content : "";
    if (!content) return null;

    let doc = null;
    try { doc = new DOMParser().parseFromString(content, "text/html"); } catch (_) { doc = null; }

    const titleText = doc?.querySelector?.(".ironsworn-roll-title")?.textContent?.trim();
    const outcomeText = doc?.querySelector?.(".outcome-text")?.textContent?.trim();

    // Pull the serialised roll JSON out of the article's data attribute.
    let serialized = null;
    const raw = doc?.querySelector?.("[data-ironswornroll]")?.getAttribute?.("data-ironswornroll");
    if (raw) { try { serialized = JSON.parse(raw); } catch (e) { this._dbg("data-ironswornroll JSON parse failed", e); } }

    if (serialized) {
      const pre  = serialized.preRollOptions  ?? {};
      const post = serialized.postRollOptions ?? {};
      const isProgress = pre.progress != null;

      const adds    = Number(pre.adds ?? 0) || 0;
      const statVal = Number(pre.stat?.value ?? 0) || 0;
      const action  = isProgress
        ? Number(pre.progress?.value ?? NaN)
        : Number(serialized.rawActionDieValue ?? NaN);

      // Challenge dice — post-roll replacements (momentum burn / resolve) win.
      const challenge = Array.isArray(serialized.rawChallengeDiceValues)
        ? serialized.rawChallengeDiceValues.slice(0, 2).map(Number)
        : [];
      if (post.replacedChallenge1?.value != null) challenge[0] = Number(post.replacedChallenge1.value);
      if (post.replacedChallenge2?.value != null) challenge[1] = Number(post.replacedChallenge2.value);

      const moveName =
        this._moveNameFromTitle(titleText) ??
        this._prettyMoveName(pre.moveDsId ?? pre.moveId ?? "their move");

      const haveAction = Number.isFinite(action);
      const haveChallenge = challenge.length === 2 && challenge.every(Number.isFinite);

      if (haveAction && haveChallenge) {
        const score = isProgress ? action : Math.min(action + statVal + adds, 10);
        const beats = challenge.filter(c => score > c).length;
        // Honour an explicit replaced/automatic outcome when the system set one.
        const forced =
          (typeof post.replacedOutcome?.value === "number") ? post.replacedOutcome.value :
          (typeof pre.automaticOutcome?.value === "number")  ? pre.automaticOutcome.value  : null;
        const ov = forced != null ? forced : (beats === 2 ? 2 : beats === 1 ? 1 : 0);
        const outcome = ov === 2 ? "Strong Hit" : ov === 1 ? "Weak Hit" : "Miss";
        return { moveName, outcome, score, challenge, match: challenge[0] === challenge[1], resolved: true };
      }

      // Dice not fully resolved yet — but if the system already rendered an
      // outcome label, trust it.
      const norm = this._normalizeOutcomeText(outcomeText);
      if (norm) return { moveName, outcome: norm, score: null, challenge, match: false, resolved: true };
      return { moveName, outcome: "", score: null, challenge, match: false, resolved: false };
    }

    // No serialised blob — fall back to the rendered title + outcome text.
    const norm = this._normalizeOutcomeText(outcomeText);
    if (titleText || norm) {
      const moveName = this._moveNameFromTitle(titleText) ?? "their move";
      if (norm) return { moveName, outcome: norm, score: null, challenge: [], match: false, resolved: true };
      return { moveName, outcome: "", score: null, challenge: [], match: false, resolved: false };
    }
    return null;
  },

  /** Fallback: derive an outcome from the attached Foundry Roll dice. */
  _parseFromRolls(message) {
    const rolls = message?.rolls ?? [];
    if (!rolls.length) return null;

    const allDice = rolls.flatMap(r => r.dice ?? []);
    const d10s = allDice.filter(d => d.faces === 10).flatMap(d => (d.results ?? []).map(r => r.result));
    const d6   = allDice.find(d => d.faces === 6);
    if (!d6 || d10s.length < 2) return null;

    const score = Math.min(rolls[0]?.total ?? d6.results?.[0]?.result ?? 0, 10);
    const challenge = d10s.slice(0, 2);
    const beats = challenge.filter(c => score > c).length;
    const outcome = beats === 2 ? "Strong Hit" : beats === 1 ? "Weak Hit" : "Miss";

    const isFlags = message?.flags?.["foundry-ironsworn"] ?? {};
    const moveName = this._prettyMoveName(
      isFlags.moveName ?? isFlags.move?.name ?? isFlags.dsid ?? isFlags.moveId ?? isFlags.moveDfId ?? "their move"
    );
    return { moveName, outcome, score, challenge, match: challenge[0] === challenge[1], resolved: true };
  },

  /** "Face Danger +iron" → "Face Danger"; "Fulfill Your Vow: X" → "Fulfill Your Vow". */
  _moveNameFromTitle(title) {
    if (!title || typeof title !== "string") return null;
    let t = title.split(/\s+\+/)[0];   // strip " +stat"
    t = t.split(":")[0];               // strip ": <progress source>"
    t = t.trim();
    return t || null;
  },

  /** Map a rendered outcome label to canonical text. */
  _normalizeOutcomeText(text) {
    if (!text || typeof text !== "string") return null;
    const lc = text.toLowerCase();
    if (lc.includes("strong")) return "Strong Hit";
    if (lc.includes("weak"))   return "Weak Hit";
    if (lc.includes("miss"))   return "Miss";
    return null;
  },

  _prettyMoveName(raw) {
    if (typeof raw !== "string") return "their move";
    // Turn "move:classic/adventure/face_danger" → "Face Danger".
    const tail = raw.split("/").pop() ?? raw;
    if (/^[a-z_]+$/.test(tail)) {
      return tail.split("_").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
    }
    return raw;
  },

  /** Ask the AI to narrate an outcome and (optionally) apply effects. */
  async _narrateOutcome(message, parsed) {
    const actor = message.speakerActor ?? IronswornController.getActiveCharacter();
    const allowEffects = Settings.get("aiAppliesEffects") ?? true;

    // 1. Apply the deterministic combat mechanics FIRST (initiative on
    //    Enter the Fray; harm/progress + initiative on Strike/Clash). This
    //    keeps the rules correct regardless of what the AI narrates, and
    //    gives us a factual summary to feed into the narration prompt.
    let autoSummary = "";
    if (allowEffects) {
      try { autoSummary = await this._autoCombatFlow(parsed, actor); }
      catch (e) { console.warn(LOG_PREFIX, "_autoCombatFlow failed", e); }
    }

    const ctx = this.gatherContext();
    const intent = this._lastIntent ? `\nThe player's intent: ${this._lastIntent}` : "";
    const autoLine = autoSummary
      ? `\nMechanical effects ALREADY applied automatically (do NOT re-emit initiative or progress effects for this move): ${autoSummary}`
      : "";
    const task = `A move has just been resolved by the dice.
Move: ${parsed.moveName}
Outcome: ${parsed.outcome}${parsed.match ? " (MATCH — add a twist)" : ""}
Action score: ${parsed.score ?? "?"} vs challenge dice ${(parsed.challenge ?? []).join(" / ") || "?"}.${intent}${autoLine}
Narrate this outcome vividly as the Skald (2–4 sentences).${allowEffects ? " Then append any warranted [[EFFECT:…]] directives that were NOT already applied above." : " Do not emit effect directives; simply narrate."}`;

    try {
      Memory.push("general", "user", `(${parsed.moveName} → ${parsed.outcome})`);
      // Recall relevant world memory using the move + the player's intent.
      const memory = await RagBridge.fetchMemory(`${parsed.moveName} ${this._lastIntent || ""}`.trim());
      const messages = [
        { role: "system", content: buildSystemPrompt({ task, context: ctx, allowEffects, allowJournal: true, memory }) },
        ...Memory.get("general")
      ];

      const cardOpts = { variant: "combat", title: `${parsed.moveName} — ${parsed.outcome}` };
      const streaming = Settings.get("streamingEnabled") !== false;

      let reply;
      if (streaming) {
        // Stream the narration live; [[EFFECT:…]] directives are stripped
        // from the display and applied afterwards from the full raw reply.
        ({ reply } = await callSkaldStreaming(messages, {
          ...cardOpts,
          chatOpts: { temperature: 0.85, maxTokens: 500 }
        }));
      } else {
        reply = await Client.chat(messages, { temperature: 0.85, maxTokens: 500 });
        const { clean } = this.parseEffects(reply);
        await Chat.postSkald(formatMarkdown(stripDirectivesForDisplay(clean || reply)), cardOpts);
      }
      Memory.push("general", "assistant", reply);
      // Fire-and-forget chronicle ingestion (never blocks/breaks play).
      JournalSystem.ingestReply(reply, { channel: "combat" });

      const { effects } = this.parseEffects(reply);
      // Strip effects the auto-combat flow already handled, to avoid
      // double-marking progress or flipping initiative twice.
      const safeEffects = this._filterRedundantCombatEffects(effects, parsed, autoSummary);
      if (allowEffects && safeEffects.length) {
        await this.applyEffects(safeEffects, actor);
      }
    } catch (e) {
      console.warn(LOG_PREFIX, "_narrateOutcome failed", e);
    }
  },

  /**
   * Is this move name one of the core combat moves whose mechanics the
   * Skald resolves deterministically (initiative / progress)?
   */
  _isCombatMove(moveName) {
    return /\b(enter the fray|strike|clash)\b/i.test(String(moveName || ""));
  },

  /**
   * Apply Ironsworn combat mechanics for the resolved move, deterministically:
   *   • Enter the Fray  → strong/weak hit grants initiative; miss = bad spot.
   *   • Strike          → hit inflicts harm (mark foe progress); strong keeps
   *                       initiative, weak loses it; miss loses initiative.
   *   • Clash           → hit inflicts harm (mark foe progress); strong keeps
   *                       initiative, weak/miss loses it.
   * Returns a short human-readable summary of what changed (for the prompt
   * and the GM whisper), or "" when nothing applied.
   */
  async _autoCombatFlow(parsed, actor) {
    if (!actor) return "";
    const move = String(parsed.moveName || "").toLowerCase();
    if (!this._isCombatMove(move)) return "";

    const out    = String(parsed.outcome || "").toLowerCase();
    const strong = out.includes("strong");
    const hit    = strong || out.includes("weak");
    const notes  = [];

    if (/enter the fray/.test(move)) {
      const r = await IronswornController.setInitiative(actor, hit);
      if (r?.ok) { this._notifyInitiative(hit); notes.push(hit ? "seized initiative" : "in a bad spot (no initiative)"); }
      return notes.join("; ");
    }

    // Strike / Clash
    if (hit) {
      const track = IronswornController.getActiveCombatTrack(actor);
      if (track) {
        const pr = await IronswornController.markProgressByRank(actor, track.id);
        if (pr?.ok) { this._notifyProgress(pr.track, pr.boxes); notes.push(`inflicted harm on ${pr.track} (now ${pr.boxes}/10 boxes)`); }
      } else {
        notes.push("no active foe track to mark — create one with [[EFFECT: create_combat …]]");
      }
      // Strong hit keeps initiative; weak hit loses it (per Strike/Clash).
      const keep = strong;
      const ir = await IronswornController.setInitiative(actor, keep);
      if (ir?.ok) { this._notifyInitiative(keep); notes.push(keep ? "kept initiative" : "lost initiative"); }
    } else {
      const ir = await IronswornController.setInitiative(actor, false);
      if (ir?.ok) { this._notifyInitiative(false); notes.push("lost initiative — pay the price"); }
    }
    return notes.join("; ");
  },

  /**
   * Remove progress / initiative effects the auto-combat flow already
   * applied for a core combat move, so the AI can't double-apply them.
   * Non-combat moves (or non-progress/initiative effects) pass through.
   */
  _filterRedundantCombatEffects(effects, parsed, autoSummary) {
    if (!autoSummary || !this._isCombatMove(parsed?.moveName)) return effects;
    return (effects || []).filter(e => {
      if (e.kind === "initiative") { this._dbg("→ dropping redundant initiative effect (auto-applied)"); return false; }
      if (e.kind === "progress")   { this._dbg("→ dropping redundant progress effect (auto-applied)"); return false; }
      return true;
    });
  },

  /** Apply parsed [[EFFECT:…]] directives via the Ironsworn controller. */
  async applyEffects(effects, actor) {
    const applied = [];
    for (const eff of effects) {
      try {
        let r = null;
        switch (eff.kind) {
          case "momentum":
            if (eff.op === "reset") r = await IronswornController.resetMomentum(actor);
            else r = await IronswornController.adjustMomentum(actor, eff.value);
            if (r?.ok) applied.push(`momentum ${eff.op === "reset" ? "reset" : (eff.value >= 0 ? "+" : "") + eff.value}`);
            break;
          case "harm":
            r = await IronswornController.applyHarm(actor, eff.value);
            if (r?.ok) applied.push(`-${eff.value} health`);
            break;
          case "stress":
            r = await IronswornController.applyStress(actor, eff.value);
            if (r?.ok) applied.push(`-${eff.value} spirit`);
            break;
          case "supply":
            r = await IronswornController.adjustSupply(actor, eff.value);
            if (r?.ok) applied.push(`supply ${eff.value >= 0 ? "+" : ""}${eff.value}`);
            break;
          case "progress":
            r = eff.byRank
              ? await IronswornController.markProgressByRank(actor, eff.track)
              : await IronswornController.markProgress(actor, eff.track, eff.value);
            if (r?.ok) applied.push(`progress on ${r.track}`);
            break;
          case "oracle":
            r = await IronswornController.rollOracle(eff.name);
            if (r) applied.push(`oracle “${eff.name}” → ${r}`);
            break;
          case "create_combat": {
            if (!(Settings.get("autoCreateCombatTracks") ?? true)) {
              this._dbg("→ create_combat skipped: autoCreateCombatTracks disabled");
              break;
            }
            // Don't duplicate an already-active fight with the same foe.
            const existing = IronswornController.getProgressTrack(actor, eff.name);
            const existingDone = existing && foundry.utils.getProperty(existing, "system.completed");
            if (existing && !existingDone) {
              this._dbg(`→ create_combat skipped: "${eff.name}" already active`);
              applied.push(`combat “${eff.name}” already underway`);
              break;
            }
            // Rank resolution, in priority order:
            //   1. AI-specified rank  → custom enemy, trust the Skald.
            //   2. Compendium lookup  → official rank for standard foes.
            //   3. Default setting    → unknown custom foe with no rank given.
            let rank, source;
            if (eff.rank) {
              rank = IronswornController.normalizeRank(eff.rank);
              source = "custom";
              this._dbg(`→ create_combat "${eff.name}": custom enemy, using AI-specified rank "${rank}"`);
            } else {
              let lookup = null;
              try { lookup = await IronswornController.lookupEnemyInCompendium(eff.name); }
              catch (e) { console.warn(LOG_PREFIX, "compendium lookup failed", e); }
              if (lookup?.found && lookup.rank) {
                rank = lookup.rank;
                source = "compendium";
                this._dbg(`→ create_combat "${eff.name}": using compendium rank "${rank}" (matched "${lookup.matchedName}" via ${lookup.match})`);
              } else {
                rank = IronswornController.normalizeRank(Settings.get("defaultEnemyRank") ?? "dangerous");
                source = "default";
                const hint = lookup?.suggestion ? ` (did you mean "${lookup.suggestion}"?)` : "";
                this._dbg(`→ create_combat "${eff.name}": not in compendium${hint}, using default rank "${rank}"`);
              }
            }
            r = await IronswornController.createProgressTrack(actor, eff.name, "combat", rank);
            if (r?.ok) {
              const tag = source === "compendium" ? " [from compendium]" : source === "custom" ? " [custom]" : "";
              applied.push(`⚔ began combat “${eff.name}” [${rank}]${tag}`);
              this._notifyCombat(`⚔ Combat track created: ${eff.name} (${rank}${source === "compendium" ? ", official" : ""})`);
            }
            break;
          }
          case "create_vow": {
            const rank = IronswornController.normalizeRank(eff.rank || "formidable");
            const existing = IronswornController.getProgressTrack(actor, eff.name);
            if (existing && !foundry.utils.getProperty(existing, "system.completed")) {
              applied.push(`vow “${eff.name}” already sworn`);
              break;
            }
            r = await IronswornController.createProgressTrack(actor, eff.name, "vow", rank, eff.description);
            if (r?.ok) {
              applied.push(`vow “${eff.name}” sworn [${rank}]`);
              this._notifyCombat(`📜 Vow sworn: ${eff.name} (${rank})`);
            }
            break;
          }
          case "initiative": {
            const gain = eff.value === "gain";
            r = await IronswornController.setInitiative(actor, gain);
            if (r?.ok) {
              applied.push(gain ? "seized initiative" : "lost initiative");
              this._notifyInitiative(gain);
            }
            break;
          }
          case "end_combat": {
            r = await IronswornController.completeTrack(actor, eff.name);
            if (r?.ok) {
              applied.push(`ended combat “${r.name}”`);
              this._notifyCombat(`🏆 Combat ended: ${r.name}`);
            }
            break;
          }
        }
        if (r && r.ok === false && r.error) {
          console.warn(LOG_PREFIX, `effect ${eff.kind} skipped:`, r.error);
        }
      } catch (e) {
        console.warn(LOG_PREFIX, "applyEffect failed", eff, e);
      }
    }
    if (applied.length) {
      await Chat.postSystem(`<em>The Skald enacts: ${escapeHtml(applied.join("; "))}.</em>`, { gmWhisper: true });
    }
  }
};

/* ===================================================================== */
/*  §8  NPC DIALOGUE SYSTEM                                               */
/* ===================================================================== */

const NpcDialogue = {
  /** Active NPC sessions keyed by lowercase name. */
  _sessions: new Map(),

  /**
   * Trigger an NPC turn. If the supplied descriptor matches an existing
   * session, continue it; otherwise spin up a fresh NPC persona, complete
   * with a 1-line "stat sketch", and roleplay.
   */
  async invoke(descriptor) {
    const key = descriptor.toLowerCase().slice(0, 64);

    if (!this._sessions.has(key)) {
      // First contact — generate the NPC's persona and stats.
      // If _spawn() failed (typically because the AI was
      // unreachable), it logs the error itself and DOES NOT populate
      // the session map. In that case we just bail out cleanly here
      // instead of crashing on `session.turnCount` below.
      await this._spawn(key, descriptor);
    }
    const session = this._sessions.get(key);
    if (!session) {
      // _spawn already showed a GM-whispered error; nothing more to do.
      console.warn(LOG_PREFIX, `NPC.invoke: no session for "${descriptor}" (spawn failed).`);
      return null;
    }

    // Subsequent turns: open-ended player line goes back to the NPC.
    if ((session.turnCount ?? 0) > 0) {
      const userLine = descriptor.replace(/^[^:]*:\s*/, ""); // strip "Name:" prefix if given
      return this._respond(key, userLine);
    }
    // First turn already produced a greeting from _spawn().
    return session.lastReply ?? null;
  },

  /** Create a brand-new NPC session and post their introduction. */
  async _spawn(key, descriptor) {
    const channel = `npc:${key}`;
    Memory.reset(channel);

    // Roll quick personality flavour from the oracles.
    const role = IronswornData.rollOracle(IronswornData.oracles.npcRole);
    const desc = IronswornData.rollOracle(IronswornData.oracles.npcDescriptor);
    const goal = IronswornData.rollOracle(IronswornData.oracles.npcGoal);

    const sketch = `Quick oracle sketch — Role: ${role.result} (${role.roll}); Descriptor: ${desc.result} (${desc.roll}); Goal: ${goal.result} (${goal.roll}).`;

    const task = `You are now embodying an NPC the players have just met: "${descriptor}". ${sketch}
First, produce a one-line "STATS" block in this exact format:
STATS: <name>; rank <troublesome|dangerous|formidable|extreme|epic>; <one-line manner>; goal: <short>.
Then on a new line speak as the NPC — greet the players in-character, in 2-4 sentences. Use quotation marks for their spoken dialogue.`;

    try {
      const memory = await RagBridge.fetchMemory(descriptor);
      const messages = [
        { role: "system", content: buildSystemPrompt({ task, memory }) },
        { role: "user", content: `Introduce the NPC: ${descriptor}` }
      ];
      const reply = await Client.chat(messages, { temperature: 0.9 });
      Memory.push(channel, "user", `Introduce the NPC: ${descriptor}`);
      Memory.push(channel, "assistant", reply);

      const { stats, dialogue } = this._splitStats(reply);
      this._sessions.set(key, {
        descriptor, channel,
        stats, turnCount: 1, lastReply: reply
      });

      // Scribe the freshly-met NPC into the chronicle (background, best-effort).
      try {
        const npcName = this._extractName(descriptor, stats);
        if (npcName) {
          JournalSystem.ingestMetadata({
            entities: [{
              type: "npc",
              name: npcName,
              action: "create",
              description: (dialogue || reply).replace(/\s+/g, " ").trim().slice(0, 400),
              motivations: stats || descriptor
            }]
          }, { channel: "npc" });
        }
      } catch (e) { console.warn(LOG_PREFIX, "NPC journal ingest failed", e); }

      const body = `${stats ? `<div class="es-npc-stats">${escapeHtml(stats)}</div>` : ""}${formatMarkdown(dialogue || reply)}`;
      await Chat.postSkald(body, {
        variant: "npc",
        alias: this._extractName(descriptor, stats),
        title: `Encounter`
      });
    } catch (err) {
      console.error(LOG_PREFIX, "NPC spawn failed", err);
      await Chat.postSystem(`<strong>The Skald cannot summon them:</strong> ${escapeHtml(err.message)}`, { gmWhisper: true });
    }
  },

  /** Continue a session — the NPC replies to the player's last line. */
  async _respond(key, userLine) {
    const session = this._sessions.get(key);
    if (!session) return null;
    try {
      const task = `You remain in the voice of the NPC introduced earlier ("${session.descriptor}"). Respond in-character, 1-3 sentences. Honour their stated goal and manner. Do NOT narrate other characters' actions. Use quotation marks for spoken dialogue.`;
      const memory = await RagBridge.fetchMemory(`${session.descriptor} ${userLine}`.trim());
      const messages = [
        { role: "system", content: buildSystemPrompt({ task, memory }) },
        ...Memory.get(session.channel),
        { role: "user", content: userLine }
      ];
      const alias = this._extractName(session.descriptor, session.stats);
      let reply;
      if (Settings.get("streamingEnabled") !== false) {
        // Stream the NPC's reply live in their own voice/alias.
        ({ reply } = await callSkaldStreaming(messages, {
          variant: "npc",
          alias,
          chatOpts: { temperature: 0.85 }
        }));
      } else {
        reply = await Client.chat(messages, { temperature: 0.85 });
        await Chat.postSkald(formatMarkdown(reply), { variant: "npc", alias });
      }
      Memory.push(session.channel, "user", userLine);
      Memory.push(session.channel, "assistant", reply);
      session.turnCount++;
      session.lastReply = reply;
      return reply;
    } catch (err) {
      console.error(LOG_PREFIX, "NPC respond failed", err);
      await Chat.postSystem(`<strong>The voice grows quiet:</strong> ${escapeHtml(err.message)}`, { gmWhisper: true });
      return null;
    }
  },

  /**
   * Optional: persist the most recent NPC as a Foundry Actor stub for
   * later reference. GM-only.
   */
  async persistLast() {
    if (!game.user.isGM) return null;
    const last = [...this._sessions.values()].pop();
    if (!last) {
      ui.notifications?.warn("No NPC to persist yet.");
      return null;
    }
    const name = this._extractName(last.descriptor, last.stats) || last.descriptor;
    try {
      const actor = await Actor.create({
        name,
        type: CONFIG.Actor.documentClass.metadata?.types?.[0] ?? "character",
        flags: { [MODULE_ID]: { skaldGenerated: true, stats: last.stats, descriptor: last.descriptor } }
      });
      ui.notifications?.info(`Skald scribes ${actor.name} into the chronicle.`);
      return actor;
    } catch (err) {
      console.warn(LOG_PREFIX, "Could not persist actor", err);
      ui.notifications?.warn(`Could not create actor: ${err.message}`);
      return null;
    }
  },

  _splitStats(reply) {
    const m = reply.match(/^\s*STATS:\s*(.+?)\s*$/im);
    if (!m) return { stats: null, dialogue: reply };
    const stats = m[1];
    const dialogue = reply.replace(m[0], "").trim();
    return { stats, dialogue };
  },

  _extractName(descriptor, stats) {
    if (stats) {
      const m = stats.match(/^([^;]+?);/);
      if (m) return m[1].trim();
    }
    // fall back to the words before the first comma in descriptor
    return descriptor.split(/[,—-]/)[0].trim() || "Stranger";
  }
};

/* ===================================================================== */
/*  §9  ORACLE INTERPRETER                                                */
/* ===================================================================== */

const OracleInterpreter = {
  async roll(alias) {
    const resolved = IronswornData.oracleAliases[alias] || alias;
    const table = IronswornData.oracles[resolved];
    if (!table) {
      const known = Object.keys(IronswornData.oracles).join(", ");
      return Chat.postSystem(
        `Unknown oracle <code>${escapeHtml(alias)}</code>. Try one of: ${known}.`
      );
    }

    const { roll, result } = IronswornData.rollOracle(table);
    const oracleLabel = this._labelFor(resolved);

    // Post the raw oracle roll first so the GM sees the source of truth.
    const oracleHtml = `
      <div class="es-oracle-row"><span class="es-oracle-label">${oracleLabel}</span>
        <span class="es-oracle-roll">d100 → ${roll}</span></div>
      <div class="es-oracle-result"><strong>${escapeHtml(result)}</strong></div>
    `;
    await Chat.postSkald(oracleHtml, { variant: "oracle", title: "The Bones Speak" });

    // Then ask the LLM to interpret narratively.
    const task = `The fates have spoken. The oracle "${oracleLabel}" returned: "${result}" (roll ${roll}).
Interpret this for the current Ironsworn scene in 2-4 sentences. Be specific and useful — offer a concrete hook the GM can run with. Do not re-roll, do not invent additional oracle results.`;
    try {
      const memory = await RagBridge.fetchMemory(`${oracleLabel}: ${result}`);
      const messages = [
        { role: "system", content: buildSystemPrompt({ task, memory }) },
        { role: "user", content: `Interpret the oracle result: ${result}` }
      ];
      const cardOpts = { variant: "oracle", title: "What the Skald Hears" };
      let reply;
      if (Settings.get("streamingEnabled") !== false) {
        ({ reply } = await callSkaldStreaming(messages, { ...cardOpts, chatOpts: { temperature: 0.85 } }));
      } else {
        reply = await Client.chat(messages, { temperature: 0.85 });
        await Chat.postSkald(formatMarkdown(reply), cardOpts);
      }
      return reply;
    } catch (err) {
      console.warn(LOG_PREFIX, "Oracle interpretation failed", err);
      // The raw roll is still posted — degrade gracefully.
      await Chat.postSystem(
        `Oracle rolled, but the Skald is hoarse: ${escapeHtml(err.message)}`,
        { gmWhisper: true }
      );
      return null;
    }
  },

  _labelFor(key) {
    const map = {
      action: "Action Oracle",
      theme: "Theme Oracle",
      region: "Region Oracle",
      location: "Location Oracle",
      coastal: "Coastal Waters Oracle",
      npcRole: "NPC Role Oracle",
      npcGoal: "NPC Goal Oracle",
      npcDescriptor: "NPC Descriptor Oracle",
      combatAction: "Combat Action Oracle",
      mysticBacklash: "Mystic Backlash Oracle",
      payThePrice: "Pay the Price Oracle"
    };
    return map[key] ?? key;
  }
};

/* ===================================================================== */
/*  §10 JOURNAL / LORE GENERATOR                                          */
/* ===================================================================== */

const LoreGenerator = {
  FOLDER_NAME: "Skald's Chronicles",

  async write(topic) {
    const task = `Compose 3-5 short paragraphs of Ironsworn world-building lore on the topic: "${topic}". Norse-tinged, evocative, GM-usable. Include at least one named place, one named figure, and one rumour or hook. Format with a clear opening sentence; use occasional **bold** for proper nouns.`;
    try {
      const memory = await RagBridge.fetchMemory(topic);
      const reply = await Client.chat([
        { role: "system", content: buildSystemPrompt({ task, memory }) },
        { role: "user", content: `Write lore on: ${topic}` }
      ], { temperature: 0.85, maxTokens: 1100 });

      // Post a chat preview.
      await Chat.postSkald(formatMarkdown(reply), {
        variant: "lore",
        title: `Chronicle: ${topic}`
      });

      // Create a JournalEntry if the user is permitted to do so.
      if (game.user.can("JOURNAL_CREATE") || game.user.isGM) {
        const folder = await this._getOrCreateFolder();
        // Stored in a JournalEntry — skip move links (no chat handler there);
        // @UUID journal links would still enrich, but keep stored lore plain.
        const journalContent = `<h2>${escapeHtml(topic)}</h2>${formatMarkdown(reply, { link: false })}`;
        const entry = await JournalEntry.create({
          name: topic.slice(0, 80),
          folder: folder?.id ?? null,
          pages: [{
            name: topic.slice(0, 80),
            type: "text",
            text: { content: journalContent, format: 1 /* HTML */ }
          }],
          flags: { [MODULE_ID]: { generated: true, topic } }
        });
        if (entry) {
          await Chat.postSystem(
            `<em>Inscribed in the chronicle: <strong>${escapeHtml(entry.name)}</strong></em>`,
            { gmWhisper: true }
          );
        }
        return entry;
      }
      return null;
    } catch (err) {
      console.error(LOG_PREFIX, "Lore failed", err);
      await Chat.postSystem(
        `<strong>The chronicle blots:</strong> ${escapeHtml(err.message)}`,
        { gmWhisper: true }
      );
      return null;
    }
  },

  async _getOrCreateFolder() {
    let folder = game.folders.find(f => f.type === "JournalEntry" && f.name === this.FOLDER_NAME);
    if (folder) return folder;
    try {
      folder = await Folder.create({
        name: this.FOLDER_NAME,
        type: "JournalEntry",
        color: "#8c6a2f"
      });
    } catch (e) {
      console.warn(LOG_PREFIX, "Could not create chronicle folder", e);
      folder = null;
    }
    return folder;
  }
};

/* ===================================================================== */
/*  §10b AUTO-JOURNALING SYSTEM (v0.4.0)                                  */
/* ===================================================================== */

/**
 * A tiny, dependency-free background work queue.
 *
 * Journal writes touch the Foundry document database and can conflict if
 * fired concurrently (e.g. two replies both trying to create the same
 * folder, or append to the same rolling journal). {@link JournalQueue}
 * serialises them: jobs are processed strictly one-at-a-time, in order, on
 * a microtask drain loop so the caller never blocks. A failing job logs and
 * is skipped — it never stalls the queue or surfaces an error to the player.
 */
class JournalQueue {
  /** @param {(job:any)=>Promise<void>} processor */
  constructor(processor) {
    this._jobs = [];
    this._busy = false;
    this._processor = processor;
  }

  /** Add a job and kick the drain loop (non-blocking). */
  enqueue(job) {
    this._jobs.push(job);
    // Fire-and-forget: never await from the caller's path.
    this._drain().catch(e => console.warn(LOG_PREFIX, "JournalQueue drain crashed:", e?.message || e));
    return this;
  }

  /** Number of jobs still waiting (excludes the one in flight). */
  get size() { return this._jobs.length; }

  /** Process jobs sequentially until the queue empties. */
  async _drain() {
    if (this._busy) return;
    this._busy = true;
    try {
      while (this._jobs.length) {
        const job = this._jobs.shift();
        try {
          await this._processor(job);
        } catch (e) {
          console.warn(LOG_PREFIX, "JournalQueue job failed:", e?.message || e, job?.kind ?? "");
        }
      }
    } finally {
      this._busy = false;
    }
  }
}

/**
 * The auto-journaling brain (v0.4.0).
 *
 * Parses the chronicle metadata the AI appends to its replies (see
 * {@link buildJournalPromptBlock}) and turns it into Foundry Journal
 * Entries, organised into a tidy folder tree, with optional minimal toast
 * notifications. World Facts and Story Threads are tracked SILENTLY in
 * rolling journals; NPCs / Locations / Discoveries get individual entries
 * and a small toast. Session Chronicles are generated on demand from an
 * in-memory activity log.
 *
 * All writes go through {@link JournalQueue} so they never block narration.
 */
const JournalSystem = {
  ROOT_FOLDER: SKALD_NAME,            // "The Eternal Skald"
  _folderColor: "#8c6a2f",

  /** type-key → { folder, title (for rolling journals), label, emoji } */
  TYPES: {
    npc:         { folder: "NPCs",               label: "NPC",          emoji: "👤", rolling: false },
    location:    { folder: "Locations",          label: "Location",     emoji: "🗺️", rolling: false },
    discovery:   { folder: "Discoveries",        label: "Discovery",    emoji: "🔍", rolling: false },
    worldFact:   { folder: "World Facts",        label: "World Fact",   emoji: "📜", rolling: true, journalName: "Established Facts" },
    storyThread: { folder: "Story Threads",      label: "Story Thread", emoji: "🧵", rolling: true, journalName: "Threads & Mysteries" },
    session:     { folder: "Session Chronicles", label: "Session",      emoji: "📖", rolling: false }
  },

  /** Cache of resolved Folder documents keyed by folder name (per session). */
  _folderCache: new Map(),

  /** Background work queue (initialised lazily on first use). */
  _queue: null,

  /** Rolling in-memory log of session activity, drained by !end-session. */
  _sessionLog: [],

  /* ---------------- gating / accessors ---------------- */

  enabled()       { return Settings.get("autoJournaling") !== false; },
  notifyLevel()   { return Settings.get("journalNotifications") || "minimal"; },
  permission()    { return Settings.get("journalPermissions") || "gm-only"; },
  sessionAuto()   { return Settings.get("sessionAutoSummary") !== false; },

  /** Only GMs (or users with journal-create rights) write journals. */
  canWrite() {
    try { return game.user?.isGM || game.user?.can?.("JOURNAL_CREATE"); }
    catch (_) { return false; }
  },

  queue() {
    if (!this._queue) this._queue = new JournalQueue((job) => this._process(job));
    return this._queue;
  },

  /* ---------------- public entry point ---------------- */

  /**
   * Ingest a COMPLETE AI reply: parse its chronicle metadata (if any),
   * record it to the session log, and enqueue background journal writes.
   * Non-blocking, swallows all errors — journaling must never break play.
   *
   * @param {string} reply
   * @param {object} [ctx]
   * @param {string} [ctx.channel] - conversation channel (for the log)
   * @param {string} [ctx.sourceVow] - vow id for context flags
   * @returns {object|null} the parsed metadata (or null)
   */
  ingestReply(reply, ctx = {}) {
    try {
      if (!this.enabled() || !this.canWrite()) return null;
      const { metadata } = parseMetadata(reply);
      if (!metadata || typeof metadata !== "object") return null;
      this.ingestMetadata(metadata, ctx);
      return metadata;
    } catch (e) {
      console.warn(LOG_PREFIX, "ingestReply failed:", e?.message || e);
      return null;
    }
  },

  /**
   * Process an already-parsed metadata object. Records to the session log
   * and enqueues a background job per actionable item.
   */
  ingestMetadata(metadata, ctx = {}) {
    if (!metadata || typeof metadata !== "object") return;
    const sourceVow = ctx.sourceVow ?? this._currentVowId();

    // 1) Record to the session log for the eventual chronicle.
    this._sessionLog.push({
      t: Date.now(),
      channel: ctx.channel ?? "general",
      entities: Array.isArray(metadata.entities) ? metadata.entities.map(e => ({ type: e?.type, name: e?.name })) : [],
      facts: Array.isArray(metadata.facts) ? metadata.facts.slice() : [],
      mysteries: Array.isArray(metadata.mysteries) ? metadata.mysteries.slice() : [],
      decisions: Array.isArray(metadata.decisions) ? metadata.decisions.slice() : [],
      worldState: (metadata.worldState && typeof metadata.worldState === "object") ? { ...metadata.worldState } : {}
    });
    // Keep the log from growing without bound during marathon sessions.
    if (this._sessionLog.length > 500) this._sessionLog.splice(0, this._sessionLog.length - 500);

    const q = this.queue();

    // 2) Entities → individual NPC / Location / Discovery journals.
    if (Array.isArray(metadata.entities)) {
      for (const ent of metadata.entities) {
        if (!ent || typeof ent !== "object") continue;
        const type = String(ent.type || "").toLowerCase();
        if (!["npc", "location", "discovery"].includes(type)) continue;
        if (!ent.name || typeof ent.name !== "string") continue;
        q.enqueue({ kind: "entity", type, entity: ent, sourceVow });
      }
    }

    // 3) Silent rolling trackers.
    const facts = Array.isArray(metadata.facts) ? metadata.facts.filter(s => typeof s === "string" && s.trim()) : [];
    if (facts.length) q.enqueue({ kind: "facts", facts, sourceVow });

    const mysteries = Array.isArray(metadata.mysteries) ? metadata.mysteries.filter(s => typeof s === "string" && s.trim()) : [];
    const decisions = Array.isArray(metadata.decisions) ? metadata.decisions.filter(s => typeof s === "string" && s.trim()) : [];
    const worldState = (metadata.worldState && typeof metadata.worldState === "object") ? metadata.worldState : null;
    if (mysteries.length || decisions.length || (worldState && Object.keys(worldState).length)) {
      q.enqueue({ kind: "thread", mysteries, decisions, worldState, sourceVow });
    }
  },

  /* ---------------- queue processor ---------------- */

  async _process(job) {
    if (!job || !this.canWrite()) return;
    switch (job.kind) {
      case "entity":  return this._processEntity(job);
      case "facts":   return this._processFacts(job);
      case "thread":  return this._processThread(job);
      default: return;
    }
  },

  async _processEntity(job) {
    const { type, entity, sourceVow } = job;
    // Dedupe by name: if an entry already exists (regardless of whether the
    // AI said "create" or "update"), augment it instead of making a twin.
    const existing = this._findEntry(type, entity.name);
    if (existing) return this._updateEntity(existing, type, entity, sourceVow);
    return this._createEntity(type, entity, sourceVow);
  },

  async _createEntity(type, entity, sourceVow) {
    const folder = await this.getOrCreateFolder(type);
    const name = String(entity.name).slice(0, 100);
    const html = this._renderEntityHtml(type, entity);
    const entry = await JournalEntry.create({
      name,
      folder: folder?.id ?? null,
      ownership: this._ownership(),
      pages: [{
        name,
        type: "text",
        text: { content: html, format: 1 /* HTML */ }
      }],
      flags: {
        [MODULE_ID]: {
          type,
          createdBy: "ai",
          lastUpdated: Date.now(),
          relatedEntities: [],
          sourceVow: sourceVow ?? null,
          aiContext: this._entityContext(entity)
        }
      }
    });
    if (entry) {
      this._toast(name, type);
      // Embed into semantic memory (v0.5.0) — fire-and-forget.
      RagBridge.indexEntry(entry);
    }
    return entry;
  },

  async _updateEntity(entry, type, entity, sourceVow) {
    try {
      const page = entry.pages?.contents?.[0] ?? entry.pages?.find?.(() => true);
      const prev = page?.text?.content ?? "";
      const addition = this._renderEntityUpdateHtml(entity);
      const merged = `${prev}\n<hr class="es-journal-sep"/>\n${addition}`;
      if (page) {
        await page.update({ "text.content": merged });
      }
      const existingCtx = entry.getFlag?.(MODULE_ID, "aiContext") || "";
      await entry.update({
        flags: {
          [MODULE_ID]: {
            type,
            createdBy: "ai",
            lastUpdated: Date.now(),
            sourceVow: sourceVow ?? entry.getFlag?.(MODULE_ID, "sourceVow") ?? null,
            aiContext: `${existingCtx}\n${this._entityContext(entity)}`.trim().slice(0, 4000)
          }
        }
      });
      // Updates are quieter than creates — only toast in "detailed" mode.
      if (this.notifyLevel() === "detailed") this._toast(entry.name, type, "Updated");
      // Re-embed the updated entry so memory reflects the new content (v0.5.0).
      RagBridge.indexEntry(entry);
      return entry;
    } catch (e) {
      console.warn(LOG_PREFIX, "_updateEntity failed:", e?.message || e);
      return null;
    }
  },

  async _processFacts(job) {
    const items = job.facts.map(f => `<li>${escapeHtml(f)}</li>`).join("");
    const stamp = new Date().toLocaleString();
    const block = `<p class="es-journal-stamp"><em>${escapeHtml(stamp)}</em></p><ul>${items}</ul>`;
    await this._appendRolling("worldFact", block, job.facts.join(" · "), job.sourceVow);
    // World Facts are silent by design — no toast.
  },

  async _processThread(job) {
    const parts = [];
    if (job.mysteries?.length) {
      parts.push(`<p><strong>🧵 Mysteries</strong></p><ul>${job.mysteries.map(m => `<li>${escapeHtml(m)}</li>`).join("")}</ul>`);
    }
    if (job.decisions?.length) {
      parts.push(`<p><strong>⚖️ Decisions</strong></p><ul>${job.decisions.map(d => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`);
    }
    if (job.worldState && Object.keys(job.worldState).length) {
      const rows = Object.entries(job.worldState)
        .map(([k, v]) => `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(String(v))}</li>`).join("");
      parts.push(`<p><strong>🌍 World State</strong></p><ul>${rows}</ul>`);
    }
    if (!parts.length) return;
    const stamp = new Date().toLocaleString();
    const block = `<p class="es-journal-stamp"><em>${escapeHtml(stamp)}</em></p>${parts.join("")}`;
    const ctx = [
      ...(job.mysteries || []),
      ...(job.decisions || []),
      ...Object.entries(job.worldState || {}).map(([k, v]) => `${k}: ${v}`)
    ].join(" · ");
    await this._appendRolling("storyThread", block, ctx, job.sourceVow);
    // Story Threads are silent by design — no toast.
  },

  /* ---------------- rolling-journal helper ---------------- */

  /**
   * Append an HTML block to the single rolling journal for a silent type
   * (World Facts / Story Threads), creating it on first use.
   */
  async _appendRolling(typeKey, html, contextLine, sourceVow) {
    const spec = this.TYPES[typeKey];
    if (!spec) return null;
    const folder = await this.getOrCreateFolder(typeKey);
    let entry = this._findRolling(typeKey, spec.journalName);

    if (!entry) {
      entry = await JournalEntry.create({
        name: spec.journalName,
        folder: folder?.id ?? null,
        ownership: this._ownership(),
        pages: [{
          name: spec.journalName,
          type: "text",
          text: { content: `<h2>${spec.emoji} ${escapeHtml(spec.journalName)}</h2>${html}`, format: 1 }
        }],
        flags: {
          [MODULE_ID]: {
            type: typeKey,
            createdBy: "ai",
            lastUpdated: Date.now(),
            relatedEntities: [],
            sourceVow: sourceVow ?? null,
            aiContext: contextLine || ""
          }
        }
      });
      // Embed the freshly-created rolling journal (v0.5.0).
      RagBridge.indexEntry(entry);
      return entry;
    }

    const page = entry.pages?.contents?.[0] ?? entry.pages?.find?.(() => true);
    if (page) {
      const prev = page.text?.content ?? "";
      await page.update({ "text.content": `${prev}\n${html}` });
    }
    const existingCtx = entry.getFlag?.(MODULE_ID, "aiContext") || "";
    await entry.update({
      flags: {
        [MODULE_ID]: {
          type: typeKey,
          createdBy: "ai",
          lastUpdated: Date.now(),
          sourceVow: sourceVow ?? entry.getFlag?.(MODULE_ID, "sourceVow") ?? null,
          aiContext: `${existingCtx}\n${contextLine || ""}`.trim().slice(0, 6000)
        }
      }
    });
    // Re-embed the appended rolling journal (v0.5.0).
    RagBridge.indexEntry(entry);
    return entry;
  },

  /* ---------------- entry rendering ---------------- */

  _renderEntityHtml(type, e) {
    const desc = e.description ? `<p>${escapeHtml(e.description)}</p>` : "";
    const rows = [];
    if (type === "npc") {
      if (e.motivations)   rows.push(["Motivations", e.motivations]);
      if (e.relationships) rows.push(["Relationships", e.relationships]);
    } else if (type === "location") {
      if (e.features) rows.push(["Notable features", e.features]);
      if (e.dangers)  rows.push(["Dangers", e.dangers]);
    } else if (type === "discovery") {
      if (e.significance) rows.push(["Significance", e.significance]);
      if (e.connectedTo)  rows.push(["Connected to", e.connectedTo]);
    }
    const list = rows.length
      ? `<ul>${rows.map(([k, v]) => `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(String(v))}</li>`).join("")}</ul>`
      : "";
    const spec = this.TYPES[type];
    return `<h2>${spec?.emoji ?? ""} ${escapeHtml(e.name)}</h2>${desc}${list}` +
           `<p class="es-journal-foot"><em>Recorded by The Eternal Skald.</em></p>`;
  },

  _renderEntityUpdateHtml(e) {
    const stamp = new Date().toLocaleString();
    const desc = e.description ? `<p>${escapeHtml(e.description)}</p>` : "";
    const extras = [];
    for (const k of ["motivations", "relationships", "features", "dangers", "significance", "connectedTo"]) {
      if (e[k]) extras.push(`<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(String(e[k]))}</li>`);
    }
    const list = extras.length ? `<ul>${extras.join("")}</ul>` : "";
    return `<p class="es-journal-stamp"><em>Update — ${escapeHtml(stamp)}</em></p>${desc}${list}`;
  },

  _entityContext(e) {
    const bits = [e.name, e.description, e.motivations, e.relationships, e.features, e.dangers, e.significance, e.connectedTo]
      .filter(Boolean).join(" | ");
    return bits.slice(0, 2000);
  },

  /* ---------------- folder management ---------------- */

  async _getRootFolder() {
    const cacheKey = `__root__`;
    if (this._folderCache.has(cacheKey)) return this._folderCache.get(cacheKey);
    let root = game.folders?.find(f => f.type === "JournalEntry" && f.name === this.ROOT_FOLDER && !f.folder);
    if (!root) {
      try {
        root = await Folder.create({ name: this.ROOT_FOLDER, type: "JournalEntry", color: this._folderColor });
      } catch (e) { console.warn(LOG_PREFIX, "root folder create failed", e); root = null; }
    }
    this._folderCache.set(cacheKey, root);
    return root;
  },

  /** Get or create the typed sub-folder under the root, on first use. */
  async getOrCreateFolder(typeKey) {
    const spec = this.TYPES[typeKey];
    if (!spec) return null;
    if (this._folderCache.has(typeKey)) return this._folderCache.get(typeKey);

    const root = await this._getRootFolder();
    let folder = game.folders?.find(f =>
      f.type === "JournalEntry" && f.name === spec.folder &&
      (f.folder?.id ?? f.folder) === (root?.id ?? null)
    );
    if (!folder) {
      try {
        folder = await Folder.create({
          name: spec.folder,
          type: "JournalEntry",
          folder: root?.id ?? null,
          color: this._folderColor
        });
      } catch (e) { console.warn(LOG_PREFIX, `folder '${spec.folder}' create failed`, e); folder = root; }
    }
    this._folderCache.set(typeKey, folder);
    return folder;
  },

  /* ---------------- lookups ---------------- */

  /** All journal entries this module created, optionally filtered by type. */
  listEntries(typeFilter = null) {
    try {
      return (game.journal?.contents ?? []).filter(j => {
        const t = j.getFlag?.(MODULE_ID, "type");
        if (!t || j.getFlag?.(MODULE_ID, "createdBy") !== "ai") return false;
        return typeFilter ? t === typeFilter : true;
      });
    } catch (_) { return []; }
  },

  /** Find an existing individual entry of a type by case-insensitive name. */
  _findEntry(type, name) {
    const lc = String(name).toLowerCase().trim();
    return this.listEntries(type).find(j => j.name?.toLowerCase().trim() === lc) ?? null;
  },

  /** Find the single rolling journal for a silent type. */
  _findRolling(typeKey, journalName) {
    const lc = String(journalName).toLowerCase();
    return this.listEntries(typeKey).find(j => j.name?.toLowerCase() === lc) ?? null;
  },

  /* ---------------- ownership / vow ---------------- */

  _ownership() {
    const lvls = (typeof CONST !== "undefined" && CONST.DOCUMENT_OWNERSHIP_LEVELS) || {};
    if (this.permission() === "shared") {
      return { default: lvls.OBSERVER ?? 2 };
    }
    return { default: lvls.NONE ?? 0 };   // gm-only (default)
  },

  /** Best-effort id of the active character's first incomplete vow. */
  _currentVowId() {
    try {
      if (!Integration.active()) return null;
      const actor = IronswornController.getActiveCharacter?.();
      if (!actor) return null;
      const tracks = IronswornController.getProgressTracks?.(actor) ?? [];
      const vow = tracks.find(t => t.type === "vow" && !t.completed) ?? tracks.find(t => t.type === "vow");
      return vow?.id ?? null;
    } catch (_) { return null; }
  },

  /* ---------------- notifications ---------------- */

  /**
   * Minimal bottom-right toast: "📝 Added [name] to [type] journal".
   * Respects the journalNotifications setting ("none" silences everything).
   */
  _toast(name, typeKey, verb = "Added") {
    const level = this.notifyLevel();
    if (level === "none") return;
    const spec = this.TYPES[typeKey] || { label: typeKey, emoji: "📝" };
    const label = spec.label || typeKey;
    try {
      let host = document.getElementById("es-journal-toasts");
      if (!host) {
        host = document.createElement("div");
        host.id = "es-journal-toasts";
        document.body.appendChild(host);
      }
      const el = document.createElement("div");
      el.className = "es-journal-toast";
      el.innerHTML = `<span class="es-jt-icon">📝</span><span class="es-jt-text">${verb} <strong>${escapeHtml(name)}</strong> to ${escapeHtml(label)} journal</span>`;
      host.appendChild(el);
      // Trigger fade-in, then auto-remove after ~2s.
      requestAnimationFrame(() => el.classList.add("es-jt-show"));
      setTimeout(() => {
        el.classList.remove("es-jt-show");
        setTimeout(() => { try { el.remove(); } catch (_) {} }, 400);
      }, 2000);
    } catch (e) {
      // DOM not available (e.g. headless) — fall back to a quiet console note.
      console.log(LOG_PREFIX, `${verb} ${name} to ${label} journal`);
    }
  },

  /* ---------------- session chronicle ---------------- */

  /**
   * Generate a Session Chronicle from the in-memory activity log. Asks the
   * AI to weave a saga-styled recap, then writes it as a dated journal and
   * clears the log. Triggered by !end-session.
   */
  async generateSessionChronicle({ announce = true } = {}) {
    if (!this.canWrite()) {
      ui.notifications?.warn(`${SKALD_NAME}: only the GM can close a session chronicle.`);
      return null;
    }
    const log = this._sessionLog.slice();
    if (!log.length) {
      await Chat.postSystem(`<em>The chronicle is bare — nothing notable was recorded this session.</em>`, { gmWhisper: true });
      return null;
    }

    // Build a compact digest for the AI from the log.
    const allFacts     = [...new Set(log.flatMap(e => e.facts))];
    const allMysteries = [...new Set(log.flatMap(e => e.mysteries))];
    const allDecisions = [...new Set(log.flatMap(e => e.decisions))];
    const allEntities  = [...new Map(log.flatMap(e => e.entities).filter(x => x?.name).map(x => [x.name, x])).values()];
    const worldState   = Object.assign({}, ...log.map(e => e.worldState || {}));

    const digest = [
      allEntities.length  ? `Notable figures & places: ${allEntities.map(e => `${e.name} (${e.type})`).join(", ")}` : "",
      allDecisions.length ? `Key decisions: ${allDecisions.join("; ")}` : "",
      allFacts.length     ? `Established facts: ${allFacts.join("; ")}` : "",
      allMysteries.length ? `Open mysteries: ${allMysteries.join("; ")}` : "",
      Object.keys(worldState).length ? `World state: ${Object.entries(worldState).map(([k, v]) => `${k}=${v}`).join(", ")}` : ""
    ].filter(Boolean).join("\n");

    const task = `Compose a SESSION CHRONICLE — a saga-styled recap of the session just ended, in your Skald voice. Use these recorded facts (do NOT invent beyond them; weave what is given):\n${digest}\n\nStructure it with short headed sections using **bold** headers: **What Happened**, **Decisions**, **Consequences**, **Unresolved Threads**. Keep it tight and evocative (4-8 short paragraphs total). Do NOT append any metadata block.`;

    let recap;
    try {
      recap = await Client.chat([
        { role: "system", content: buildSystemPrompt({ task }) },
        { role: "user", content: "Close the chronicle for this session." }
      ], { temperature: 0.8, maxTokens: 1200 });
    } catch (e) {
      console.warn(LOG_PREFIX, "session chronicle AI call failed:", e?.message || e);
      // Degrade: write a plain digest if the AI is unreachable.
      recap = `**What Happened**\n${digest || "(no details)"}`;
    }

    const folder = await this.getOrCreateFolder("session");
    const title = `Session Chronicle — ${new Date().toLocaleDateString()}`;
    // Stored in a JournalEntry — keep plain (move links have no handler there).
    const html = `<h2>📖 ${escapeHtml(title)}</h2>${formatMarkdown(recap, { link: false })}`;
    const entry = await JournalEntry.create({
      name: title,
      folder: folder?.id ?? null,
      ownership: this._ownership(),
      pages: [{ name: title, type: "text", text: { content: html, format: 1 } }],
      flags: {
        [MODULE_ID]: {
          type: "session",
          createdBy: "ai",
          lastUpdated: Date.now(),
          relatedEntities: [],
          sourceVow: this._currentVowId(),
          aiContext: digest.slice(0, 6000)
        }
      }
    });

    if (entry) {
      // Embed the session chronicle into semantic memory (v0.5.0).
      RagBridge.indexEntry(entry);
      if (announce) {
        await Chat.postSkald(formatMarkdown(recap), { variant: "lore", title });
        this._toast(title, "session");
      }
    }
    // Clear the log — a new session begins.
    this._sessionLog = [];
    return entry;
  }
};

/* ===================================================================== */
/*  §11 ENEMY COMBAT CONTROLLER                                           */
/* ===================================================================== */

const CombatController = {

  /** Lock to prevent re-entrant turn processing. */
  _busy: false,
  _lastTurnId: null,

  /**
   * Updates from Combat changes. Fires from the 'updateCombat' hook.
   * Only the active GM runs the logic — players observe.
   */
  async onUpdateCombat(combat, changed /*, options, userId */) {
    if (!game.user.isGM) return;
    if (!Settings.get("autoControlEnemies") && !Settings.get("autoNarrateCombat")) return;
    if (!combat?.started) return;

    // Only react when turn or round changed
    if (!("turn" in changed) && !("round" in changed)) return;

    const combatant = combat.combatant;
    if (!combatant) return;

    // Idempotency guard
    const turnId = `${combat.id}:${combat.round}:${combat.turn}`;
    if (turnId === this._lastTurnId) return;
    this._lastTurnId = turnId;

    if (this._busy) return;

    // Skip player-owned combatants — they act for themselves
    if (this._isPlayerOwned(combatant)) {
      if (Settings.get("autoNarrateCombat")) {
        await this._narrateHeroTurn(combatant);
      }
      return;
    }

    // Hostile / NPC — act on their behalf if auto-control is on
    if (Settings.get("autoControlEnemies")) {
      this._busy = true;
      try { await this._runEnemyTurn(combat, combatant); }
      finally { this._busy = false; }
    } else if (Settings.get("autoNarrateCombat")) {
      await this._narrateEnemyTurn(combatant);
    }
  },

  /** Brief atmospheric narration for a player turn — no actions taken. */
  async _narrateHeroTurn(combatant) {
    const ctx = this._combatSnapshot(combatant);
    const task = `It is the Ironsworn ${escapeHtml(combatant.name)}'s turn. In 1-2 sentences, set the mood. Do not declare their action — the player decides.\n\nSnapshot:\n${ctx}`;
    try {
      const reply = await Client.chat([
        { role: "system", content: buildSystemPrompt({ task }) },
        { role: "user", content: `Narrate the moment before ${combatant.name} acts.` }
      ], { temperature: 0.8, maxTokens: 220 });
      await Chat.postSkald(formatMarkdown(reply), { variant: "combat", title: `${combatant.name}'s Turn` });
    } catch (err) {
      console.warn(LOG_PREFIX, "Hero narration failed", err);
    }
  },

  /** Atmospheric narration only — no action taken on the enemy's behalf. */
  async _narrateEnemyTurn(combatant) {
    const ctx = this._combatSnapshot(combatant);
    const task = `It is the foe "${escapeHtml(combatant.name)}"'s turn. Narrate what they DO, vividly, in 2-3 sentences. Do not roll dice — describe the intent. The GM will adjudicate.\n\nSnapshot:\n${ctx}`;
    try {
      const reply = await Client.chat([
        { role: "system", content: buildSystemPrompt({ task }) },
        { role: "user", content: `Describe ${combatant.name}'s action.` }
      ], { temperature: 0.85, maxTokens: 280 });
      await Chat.postSkald(formatMarkdown(reply), { variant: "combat", title: `${combatant.name} acts` });
    } catch (err) {
      console.warn(LOG_PREFIX, "Enemy narration failed", err);
    }
  },

  /**
   * Run a full enemy turn: ask the LLM for a tactical decision, attempt
   * the mechanical bits (movement, attack roll), narrate it, then advance
   * to the next combatant.
   */
  async _runEnemyTurn(combat, combatant) {
    const ctx = this._combatSnapshot(combatant);

    const task = `You are GMing an Ironsworn combat. It is the foe "${combatant.name}"'s turn. Decide ONE action and reply ONLY in this JSON shape (no prose outside it):
{
  "intent": "aggressive|defensive|cunning|fleeing",
  "action": "strike|clash|move|secure_advantage|use_ability|flee",
  "target_token_id": "<id of target player token or null>",
  "move_to": { "x": <int>, "y": <int> } OR null,
  "narration": "<2-3 vivid sentences in your Skald voice>",
  "harm": <integer 0-3, harm to inflict on a hit>
}
Use the battlefield snapshot to choose a sensible action. Prefer Strike on a wounded foe in reach, Clash if you cannot reach, Move/Secure an Advantage to set up next turn. Flee at very low health.

Snapshot:
${ctx}`;

    let decision = null;
    try {
      const raw = await Client.chat([
        { role: "system", content: buildSystemPrompt({ task }) },
        { role: "user", content: `Decide and narrate ${combatant.name}'s turn.` }
      ], { temperature: 0.6, maxTokens: 500 });
      decision = this._parseDecision(raw);
    } catch (err) {
      console.warn(LOG_PREFIX, "Enemy decision failed", err);
      await Chat.postSystem(`<strong>${escapeHtml(combatant.name)} hesitates:</strong> ${escapeHtml(err.message)}`, { gmWhisper: true });
    }

    if (!decision) {
      decision = this._fallbackDecision(combatant);
    }

    // 1. Narration card
    if (decision.narration) {
      await Chat.postSkald(formatMarkdown(decision.narration), {
        variant: "combat",
        alias: combatant.name,
        title: `${combatant.name} — ${this._actionLabel(decision.action)}`
      });
    }

    // 2. Mechanical execution
    try {
      await this._executeAction(combat, combatant, decision);
    } catch (err) {
      console.warn(LOG_PREFIX, "Enemy action exec failed", err);
    }

    // 3. Advance the turn (give the table a beat to read)
    setTimeout(() => {
      combat.nextTurn().catch(e => console.warn(LOG_PREFIX, "nextTurn failed", e));
    }, 1500);
  },

  /** Carry out the chosen action on the canvas. */
  async _executeAction(combat, combatant, decision) {
    const token = combatant?.token?.object ?? canvas?.tokens?.get?.(combatant?.tokenId);
    if (!token) return;

    // Movement
    if (decision.move_to && Number.isFinite(decision.move_to.x) && Number.isFinite(decision.move_to.y)) {
      // Clamp to scene bounds (skip if there's no active scene).
      const scene = canvas?.scene;
      if (scene?.dimensions) {
        const w = scene.dimensions.width  ?? Infinity;
        const h = scene.dimensions.height ?? Infinity;
        const x = Math.max(0, Math.min(decision.move_to.x, w - (token.w ?? 0)));
        const y = Math.max(0, Math.min(decision.move_to.y, h - (token.h ?? 0)));
        try {
          await token.document.update({ x, y });
        } catch (e) { console.warn(LOG_PREFIX, "Token move failed", e); }
      }
    }

    // Combat actions — use Ironsworn dice (1d6 vs 2d10)
    if (["strike", "clash"].includes(decision.action)) {
      // Resolve a quick Ironsworn-style roll: stat bonus ~ +2 default
      const stat = 2;
      const roll = new Roll(`1d6 + ${stat}`);
      const chal = new Roll("2d10");
      await roll.evaluate({ async: true });
      await chal.evaluate({ async: true });
      const c1 = chal.terms[0].results[0].result;
      const c2 = chal.terms[0].results[1].result;
      const total = roll.total;
      const beats = (total > c1 ? 1 : 0) + (total > c2 ? 1 : 0);
      const tier = beats === 2 ? "Strong Hit" : beats === 1 ? "Weak Hit" : "Miss";

      const harm = Math.max(0, Math.min(3, Math.floor(decision.harm ?? 1)));
      let resultBody = `<div class="es-combat-roll">
        <div><strong>${this._actionLabel(decision.action)}</strong> — ${combatant.name}</div>
        <div>Action: 1d6+${stat} = <strong>${total}</strong>; Challenge: ${c1}, ${c2}</div>
        <div>Outcome: <strong>${tier}</strong>${beats > 0 ? ` — inflicts ${harm} harm` : " — no harm dealt"}</div>
      </div>`;
      await Chat.postSkald(resultBody, { variant: "combat", alias: combatant.name });

      // Apply harm to the target if we have one and we hit
      if (beats > 0 && decision.target_token_id) {
        const target = canvas.tokens.get(decision.target_token_id);
        if (target?.actor) {
          await this._applyHarm(target.actor, harm);
        }
      }
    }

    if (decision.action === "flee") {
      await Chat.postSystem(`<em>${escapeHtml(combatant.name)} flees the field — remove from combat as the fiction dictates.</em>`, { gmWhisper: true });
    }
  },

  /**
   * Best-effort harm application. The Ironsworn system on Foundry uses
   * 'health' or 'harm' under different schemas; we try the most common
   * paths and fall back to a chat note.
   */
  async _applyHarm(actor, harm) {
    if (harm <= 0) return;
    // Try data.health.value (legacy) and system.health.value (v10+)
    const paths = ["system.health.value", "system.attributes.health.value", "data.health.value"];
    for (const path of paths) {
      const cur = foundry.utils.getProperty(actor, path);
      if (typeof cur === "number") {
        const next = Math.max(0, cur - harm);
        try {
          await actor.update({ [path]: next });
          return;
        } catch (e) { /* try next path */ }
      }
    }
    await Chat.postSystem(`<em>${escapeHtml(actor.name)} suffers ${harm} harm.</em>`);
  },

  /** Attempt to parse a JSON decision robustly. */
  _parseDecision(raw) {
    if (!raw) return null;
    // Strip markdown code fences if present
    const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end   = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    const json = cleaned.slice(start, end + 1);
    try {
      const parsed = JSON.parse(json);
      // Normalize
      parsed.action = String(parsed.action ?? "strike").toLowerCase();
      parsed.intent = String(parsed.intent ?? "aggressive").toLowerCase();
      parsed.harm   = Number(parsed.harm ?? 1);
      return parsed;
    } catch (e) {
      console.warn(LOG_PREFIX, "Decision JSON parse failed", e, raw);
      return null;
    }
  },

  /** Use the oracle if the LLM declines or fails. */
  _fallbackDecision(combatant) {
    const { result } = IronswornData.rollOracle(IronswornData.oracles.combatAction);
    return {
      intent: "aggressive",
      action: "strike",
      target_token_id: null,
      move_to: null,
      narration: `**${combatant.name}** — guided by fate's roll — chooses: *${result}*.`,
      harm: 1
    };
  },

  _actionLabel(a) {
    switch ((a || "").toLowerCase()) {
      case "strike": return "Strike";
      case "clash":  return "Clash";
      case "move":   return "Reposition";
      case "secure_advantage": return "Secure an Advantage";
      case "use_ability": return "Unleash an Ability";
      case "flee":   return "Withdraw";
      default:       return "Act";
    }
  },

  _isPlayerOwned(combatant) {
    const actor = combatant.actor;
    if (!actor) return false;
    if (actor.hasPlayerOwner) return true;
    // Fallback for older schemas
    const owners = actor.ownership ?? actor.data?.permission ?? {};
    return Object.entries(owners).some(([userId, perm]) => {
      if (userId === "default") return false;
      const user = game.users.get(userId);
      return user && !user.isGM && perm >= 3;
    });
  },

  /** Compact, LLM-friendly battlefield snapshot.
   *  Defensive against partial Combat state: optional chaining on every
   *  property access so that an out-of-combat invocation never throws. */
  _combatSnapshot(activeCombatant) {
    const combat = game?.combat;
    if (!combat) return "(no active combat)";

    const round       = combat.round ?? 0;
    const turn        = combat.turn  ?? 0;
    const combatants  = combat.combatants ?? new Map();
    const totalCount  = combatants.size ?? combatants.length ?? 0;

    const lines = [];
    lines.push(`Round ${round}, turn ${turn + 1}/${totalCount || "?"}.`);
    if (canvas?.scene?.name) lines.push(`Scene: ${canvas.scene.name}.`);

    // combatants may be a Collection (Map-like) — iterable in both v12 and v14.
    try {
      for (const c of combatants) {
        if (!c) continue;
        const tok = c.token?.object ?? canvas?.tokens?.get?.(c.tokenId);
        const actor = c.actor;
        const x = tok?.x ?? "?";
        const y = tok?.y ?? "?";
        const hp = foundry?.utils?.getProperty?.(actor ?? {}, "system.health.value") ??
                   foundry?.utils?.getProperty?.(actor ?? {}, "system.attributes.health.value") ??
                   "?";
        const role = this._isPlayerOwned(c) ? "HERO" : "FOE";
        const flag = c === activeCombatant ? " ←ACTIVE" : "";
        lines.push(`  [${role}] ${c.name ?? "?"} (id=${tok?.id ?? "?"}) pos=(${x},${y}) hp=${hp}${flag}`);
      }
    } catch (err) {
      // Never let combat-iteration errors propagate out of a snapshot.
      console.warn(LOG_PREFIX, "_combatSnapshot: iteration failed —", err?.message ?? err);
      lines.push("  (combatant list unavailable)");
    }

    return lines.join("\n");
  },

  /** Used by the !combat command to give the LLM context. */
  summariseCurrent() {
    const combat = game?.combat;
    if (!combat?.started) return "(no active combat)";
    return this._combatSnapshot(combat.combatant ?? null);
  }
};

/* ===================================================================== */
/*  §12 SCENE CONTEXT (for !scene)                                        */
/* ===================================================================== */

const SceneContext = {
  summarise() {
    const scene = canvas?.scene;
    if (!scene) return "(no active scene)";
    const lines = [`Scene: ${scene.name}`];
    if (scene.background?.src) lines.push(`Background art: ${scene.background.src.split("/").pop()}`);
    const tokens = canvas.tokens?.placeables ?? [];
    if (tokens.length) {
      lines.push(`Tokens on scene:`);
      for (const t of tokens.slice(0, 12)) {
        lines.push(`  - ${t.name} at (${t.x},${t.y})`);
      }
      if (tokens.length > 12) lines.push(`  …and ${tokens.length - 12} more`);
    }
    return lines.join("\n");
  }
};

/* ===================================================================== */
/*  §13 HOOK REGISTRATIONS                                                */
/* ===================================================================== */

/* =====================================================================
 * COMMAND-INTERCEPTION STRATEGY (HTML-aware)
 * ---------------------------------------------------------------------
 * Foundry VTT v14 changed how chat input is processed. The pre-v14
 * `chatMessage` hook signature was `(chatLog, messageText, chatData)`
 * and could be cancelled with `return false`. In v14, depending on the
 * Foundry build, this hook may:
 *   - Receive an object instead of a string for `messageText`.
 *   - Not fire at all for messages that don't begin with `/`.
 *   - Fire but ignore the return value.
 *
 * Strategy: register THREE hooks and log everything from each one so we
 * can see in DevTools which fires for `!skald-help`:
 *
 *   1.  `chatMessage`           — the classic pre-v14 entry point
 *   2.  `preCreateChatMessage`  — fires when the ChatMessage document
 *                                 is about to be persisted; we can
 *                                 cancel by returning false here.
 *   3.  `createChatMessage`     — final fallback; the message has been
 *                                 created so we can't suppress it, but
 *                                 we can still execute the command and
 *                                 then delete the user's command line.
 *
 * `tryCommandFromText()` is shared by all three so the logic stays in
 * one place. Each hook logs its arguments verbosely so we can diagnose.
 * =================================================================== */

/**
 * Helper: extract a string out of whatever Foundry passes to the hook
 * (string / object with .content / object with .text).
 */
function extractMessageText(arg) {
  if (typeof arg === "string") return arg;
  if (arg && typeof arg === "object") {
    if (typeof arg.content === "string") return arg.content;
    if (typeof arg.text === "string") return arg.text;
    if (typeof arg.message === "string") return arg.message;
  }
  return "";
}

/**
 * Helper: strip HTML tags from a string and collapse whitespace.
 *
 * WHY: Foundry VTT v14 wraps plain chat input in a `<p>...</p>` block
 * before passing it to the chatMessage / preCreateChatMessage /
 * createChatMessage hooks. So when the user types `!skald-help` the
 * value we receive is actually `<p>!skald-help</p>` — which would
 * never match `startsWith("!")` and would never dispatch.
 *
 * We use a deliberately simple regex (rather than a DOMParser) because
 * it works in any execution context and we only need to remove the
 * outer wrapper tags. Inner text is preserved.
 */
function stripHtml(html) {
  if (typeof html !== "string") return "";
  // Decode the most common HTML entities that could appear inside the
  // wrapped text (e.g. `&amp;` typed by the user, `&nbsp;` injected by
  // the editor) so the prefix match still works.
  const withoutTags = html.replace(/<[^>]*>/g, "");
  const decoded = withoutTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return decoded.trim();
}

/**
 * Shared command-trigger: returns true iff `text` starts with one of
 * our `!` commands AND we successfully dispatched the handler.
 *
 * IMPORTANT: HTML tags are stripped here so all three hooks
 * (chatMessage, preCreateChatMessage, createChatMessage) get
 * consistent behaviour regardless of whether Foundry wrapped the
 * raw input in `<p>...</p>` or not.
 */
function tryCommandFromText(text, source) {
  const rawIn = text || "";
  const stripped = stripHtml(rawIn);
  if (stripped !== rawIn.trim()) {
    console.log(`${LOG_PREFIX} [${source}] stripped HTML: ${JSON.stringify(rawIn)} -> ${JSON.stringify(stripped)}`);
  }
  if (!stripped.startsWith("!")) return false;
  console.log(`${LOG_PREFIX} [${source}] candidate command text:`, JSON.stringify(stripped));
  // Pass the STRIPPED text to dispatch — never the HTML-wrapped form.
  const dispatched = dispatchCommand(stripped);
  console.log(`${LOG_PREFIX} [${source}] dispatchCommand returned:`, dispatched);
  return dispatched;
}

// --- init: register settings AND chat-command hooks -------------------
console.log("The Eternal Skald | Registering Hooks.once('init') …");
Hooks.once("init", () => {
  console.log(LOG_PREFIX, "init hook fired — initialising module …");
  try {
    Settings.register();
    console.log(LOG_PREFIX, "Settings registered.");
  } catch (err) {
    console.error(LOG_PREFIX, "Settings.register() failed:", err);
  }

  /* === Keybinding: toggle AI Mode (v0.3.2) =============================
   * Lets the GM flip the AI Mode master toggle on/off with a keyboard
   * shortcut. No default key is bound — the user assigns one under
   * Configure Controls → The Eternal Skald. AI Mode is world-scoped, so
   * the binding is restricted to GMs (only they can write world settings).
   * =================================================================== */
  try {
    game.keybindings.register(MODULE_ID, "toggleAiMode", {
      name: game.i18n.localize("ETERNAL_SKALD.keybindings.toggleAiMode.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.keybindings.toggleAiMode.hint"),
      // Default chord: Alt+Shift+A (unlikely to clash). Users can rebind
      // or clear it under Configure Controls → The Eternal Skald.
      editable: [{ key: "KeyA", modifiers: ["Alt", "Shift"] }],
      restricted: true,             // GM only (world-scoped setting)
      precedence: CONST.KEYBINDING_PRECEDENCE?.NORMAL ?? 0,
      onDown: () => {
        try {
          const current = Settings.get("aiMode") !== false;
          // Setting onChange handles the user-facing notification.
          game.settings.set(MODULE_ID, "aiMode", !current);
        } catch (e) {
          console.error(LOG_PREFIX, "toggleAiMode keybinding failed:", e);
        }
        return true;   // consume the event
      }
    });
    console.log(LOG_PREFIX, "Keybinding 'toggleAiMode' registered.");
  } catch (err) {
    console.error(LOG_PREFIX, "Keybinding registration failed:", err);
  }

  /* === HOOK #1: chatMessage ============================================
   * The pre-v14 entry point. Fires BEFORE Foundry creates the
   * ChatMessage document, with the raw text. Cancel with `return false`.
   * =================================================================== */
  Hooks.on("chatMessage", (chatLog, message, chatData) => {
    console.log(`${LOG_PREFIX} [chatMessage] HOOK FIRED`);
    console.log(`${LOG_PREFIX} [chatMessage] message (type=${typeof message}):`, message);
    try { console.log(`${LOG_PREFIX} [chatMessage] message JSON:`, JSON.stringify(message)); } catch (_) {}
    try { console.log(`${LOG_PREFIX} [chatMessage] chatData JSON:`, JSON.stringify(chatData)); } catch (_) {}
    try {
      const text = extractMessageText(message);
      const consumed = tryCommandFromText(text, "chatMessage");
      if (consumed) {
        console.log(`${LOG_PREFIX} [chatMessage] returning false to suppress default chat publication`);
        return false;
      }
      console.log(`${LOG_PREFIX} [chatMessage] not our command — letting Foundry handle it`);
      return undefined;
    } catch (err) {
      console.error(`${LOG_PREFIX} [chatMessage] handler crashed:`, err);
      return undefined;
    }
  });

  /* === HOOK #2: preCreateChatMessage ===================================
   * Fires when a ChatMessage document is about to be persisted. The
   * raw text lives in `document.content` (or `data.content` for legacy).
   * Cancel persistence with `return false`.
   * =================================================================== */
  Hooks.on("preCreateChatMessage", (document, data, options, userId) => {
    console.log(`${LOG_PREFIX} [preCreateChatMessage] HOOK FIRED`);
    try { console.log(`${LOG_PREFIX} [preCreateChatMessage] document.content:`, document?.content); } catch (_) {}
    try { console.log(`${LOG_PREFIX} [preCreateChatMessage] data:`, JSON.stringify(data)); } catch (_) {}
    try {
      // Don't intercept our own messages (they have our flags)
      const flags = document?.flags ?? data?.flags ?? {};
      if (flags[MODULE_ID]) {
        console.log(`${LOG_PREFIX} [preCreateChatMessage] message is ours — passing through`);
        return undefined;
      }
      const text = document?.content ?? data?.content ?? "";
      const consumed = tryCommandFromText(text, "preCreateChatMessage");
      if (consumed) {
        console.log(`${LOG_PREFIX} [preCreateChatMessage] returning false to prevent document creation`);
        return false;
      }
      return undefined;
    } catch (err) {
      console.error(`${LOG_PREFIX} [preCreateChatMessage] handler crashed:`, err);
      return undefined;
    }
  });

  console.log(`${LOG_PREFIX} Chat-command hooks (chatMessage + preCreateChatMessage) registered for: ${Object.values(COMMANDS).join(", ")}`);
});

// --- ready: welcome banner & global API ------------------------------
console.log("The Eternal Skald | Registering Hooks.once('ready') …");
Hooks.once("ready", async () => {
  console.log(LOG_PREFIX, "ready hook fired — module fully loaded.");

  // Sync debug logging flag into the Ironsworn controller.
  try { IronswornController.setDebug(Settings.get("debugLogging")); } catch (_) {}

  // Expose a small public API for macros and other modules.
  game.modules.get(MODULE_ID).api = {
    chat: Client.chat.bind(Client),
    rollOracle: IronswornData.rollOracle,
    commands: Commands,
    npc: NpcDialogue,
    combat: CombatController,
    lore: LoreGenerator,
    // --- Auto-journaling chronicle (v0.4.0) ---
    journal: JournalSystem,
    // --- Browser-based RAG / semantic memory (v0.5.0) ---
    rag: BrowserRAG,
    resetMemory: (ch) => Memory.reset(ch),
    // --- AI Mode controls (v0.3.2) ---
    isAiMode: () => Settings.get("aiMode") !== false,
    setAiMode: (on) => game.settings.set(MODULE_ID, "aiMode", !!on),
    toggleAiMode: () => game.settings.set(MODULE_ID, "aiMode", Settings.get("aiMode") === false),
    IronswornData,
    // --- Ironsworn rules-engine integration (v0.3.0) ---
    ironsworn: IronswornController,
    integration: Integration,
    // --- Narration entity linking (v0.5.1) ---
    entityLinker: EntityLinker
  };

  // Log Ironsworn integration status for diagnostics.
  try {
    if (Integration.active()) {
      const caps = IronswornController.capabilities();
      console.log(LOG_PREFIX, "Ironsworn integration ACTIVE —", JSON.stringify(caps));
    } else {
      console.log(LOG_PREFIX, "Ironsworn integration inactive (system not detected or disabled).");
    }
  } catch (_) {}

  // Welcome card — once per session, GM only.
  if (game.user.isGM) {
    const apiKey = Settings.get("apiKey");
    if (!apiKey) {
      await Chat.postSystem(
        `<strong>${SKALD_NAME}</strong> awaits your key. Open <em>Module Settings → The Eternal Skald</em> and provide your Abacus AI API key, then type <code>!skald-help</code>.`,
        { gmWhisper: true }
      );
    } else {
      await Chat.postSkald(
        `<p>I have come, summoned by iron and flame. Type <code>!skald-help</code> for the runes that wake me.</p>`,
        { variant: "default", title: "The Skald Arrives" }
      );
    }
  }
});

// --- updateCombat: enemy turn automation -----------------------------
Hooks.on("updateCombat", (combat, changed, options, userId) => {
  // Run only on the active GM to avoid duplicate actions
  if (!game.user.isGM) return;
  // Some Foundry versions route updates via the originating user — guard against double-fire
  if (game.users.activeGM && game.users.activeGM.id !== game.user.id) return;
  CombatController.onUpdateCombat(combat, changed, options, userId).catch(err => {
    console.error(LOG_PREFIX, "Combat handler failed", err);
  });
});

/* === HOOK #3: createChatMessage (last-resort fallback) ================
 * If chatMessage and preCreateChatMessage both fail to intercept the
 * raw `!` command, the message has already been persisted by the time
 * we see it here. We can still execute the command and (best-effort)
 * delete the original user message so it doesn't clutter chat.
 * ==================================================================== */
Hooks.on("createChatMessage", (message) => {
  console.log(`${LOG_PREFIX} [createChatMessage] HOOK FIRED`);
  try {
    // Ignore our own posts — they always carry our module flag.
    if (message?.flags?.[MODULE_ID]) {
      console.log(`${LOG_PREFIX} [createChatMessage] message is ours — ignoring`);
      return;
    }

    // --- Ironsworn roll detection -------------------------------------
    // If this message is a roll produced by the foundry-ironsworn system
    // (e.g. the user triggered a move themselves, or via our suggestion
    // card), let the Integration layer narrate the outcome. This runs
    // independently of the `!command` dispatch below and never blocks it.
    try {
      Integration.onIronswornRoll(message);
    } catch (e) {
      console.warn(`${LOG_PREFIX} [createChatMessage] onIronswornRoll dispatch failed:`, e);
    }

    const rawText = message?.content ?? "";
    console.log(`${LOG_PREFIX} [createChatMessage] raw content:`, JSON.stringify(rawText));

    // Strip HTML (Foundry v14 wraps chat input in <p>...</p>) BEFORE
    // checking the prefix.
    const stripped = stripHtml(typeof rawText === "string" ? rawText : "");
    if (stripped !== (typeof rawText === "string" ? rawText.trim() : "")) {
      console.log(`${LOG_PREFIX} [createChatMessage] stripped HTML -> ${JSON.stringify(stripped)}`);
    }
    if (!stripped.startsWith("!")) return;

    // Only the speaker (or the active GM as a safety net) should run
    // the command — otherwise every connected client would dispatch.
    const author = message?.author ?? message?.user;
    const authorId = typeof author === "string" ? author : author?.id;
    if (authorId && authorId !== game.user.id) {
      console.log(`${LOG_PREFIX} [createChatMessage] not our message (author=${authorId}, me=${game.user.id}) — skipping dispatch`);
      return;
    }

    // Use the shared helper so HTML stripping + dispatch stays consistent
    // with hooks #1 and #2.
    console.log(`${LOG_PREFIX} [createChatMessage] FALLBACK dispatch for stripped text: ${JSON.stringify(stripped)}`);
    const dispatched = tryCommandFromText(rawText, "createChatMessage");

    // Best-effort: delete the user's raw "!command" line so chat isn't cluttered.
    if (dispatched) {
      try { message.delete?.(); } catch (e) { console.warn(`${LOG_PREFIX} [createChatMessage] couldn't delete original message:`, e); }
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} [createChatMessage] handler crashed:`, err);
  }
});

/* === updateChatMessage: catch rolls that resolve after creation ======
 * Ironsworn rolls can be created in an unresolved state (extra challenge
 * dice) or have their outcome changed (resolve challenge / momentum burn).
 * The system updates the existing card's content via msg.update({content}),
 * which fires updateChatMessage rather than createChatMessage. Re-run the
 * detector so those late-resolved rolls still get narrated exactly once
 * (the _processedRolls guard prevents double-narration).
 * ==================================================================== */
Hooks.on("updateChatMessage", (message, changed /*, options, userId */) => {
  try {
    if (message?.flags?.[MODULE_ID] && !message.flags[MODULE_ID].manualMove) return;
    // Only react when the rendered content actually changed.
    if (changed && !("content" in changed) && !("rolls" in changed)) return;
    Integration.onIronswornRoll(message, { viaUpdate: true });
  } catch (e) {
    console.warn(`${LOG_PREFIX} [updateChatMessage] onIronswornRoll dispatch failed:`, e);
  }
});

// --- renderChatMessage(HTML): allow CSS class hooks ------------------
Hooks.on("renderChatMessageHTML", (message, html /*, data */) => {
  if (message?.flags?.[MODULE_ID]) {
    html.classList?.add("eternal-skald-msg");
  }
  // Wire interactive move-suggestion buttons (no-op if no suggestion flag).
  try { Integration.wireSuggestionCard(message, html); } catch (_) { /* defensive */ }
});
// Legacy hook name for v12/v13 compatibility (no-op if unused).
Hooks.on("renderChatMessage", (message, html /*, data */) => {
  if (message?.flags?.[MODULE_ID]) {
    try { html.addClass("eternal-skald-msg"); } catch (_) { /* jq optional */ }
  }
  // Wire suggestion buttons on legacy Foundry (html is jQuery here).
  try {
    const el = html?.[0] ?? html;
    Integration.wireSuggestionCard(message, el);
  } catch (_) { /* defensive */ }
});

// --- deleteJournalEntry: keep semantic memory in sync (v0.5.0) -------
// When a Skald-authored journal entry is deleted, evict its vector so it
// no longer surfaces in recall. Fire-and-forget; never throws.
Hooks.on("deleteJournalEntry", (entry /*, options, userId */) => {
  try {
    if (!entry?.getFlag?.(MODULE_ID, "createdBy")) return;
    const id = entry.id || entry._id;
    if (id) BrowserRAG?.remove?.(id);
  } catch (_) { /* defensive — memory upkeep must never break deletes */ }
});

// --- Entity-linking cache upkeep (v0.5.1) ----------------------------
// The narration entity-link index is built from the chronicle's journal
// entries. Whenever an entry is created, renamed, or removed, mark the
// index stale so the next narration rebuilds it. Cheap and defensive —
// never throws.
for (const hook of ["createJournalEntry", "updateJournalEntry", "deleteJournalEntry"]) {
  Hooks.on(hook, () => { try { EntityLinker.invalidate(); } catch (_) { /* defensive */ } });
}
// A fresh world / reload starts with a clean index.
Hooks.once("ready", () => { try { EntityLinker.invalidate(); } catch (_) { /* defensive */ } });
