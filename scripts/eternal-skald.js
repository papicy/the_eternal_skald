/* =====================================================================
 *  THE ETERNAL SKALD v2.0.0 — Foundry VTT v14 Module (Client)
 *  ---------------------------------------------------------------------
 *  An AI-powered storytelling and combat-control assistant for Ironsworn
 *  and Ironsworn: Delve campaigns. Powered by Abacus AI ChatLLM.
 *
 *  ARCHITECTURE (v2.0.0)
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

console.log("=== The Eternal Skald v2.0.0 — module file loaded ===");

import { IronswornData } from "./ironsworn-data.js";

console.log("The Eternal Skald | ironsworn-data.js imported successfully");

/* ===================================================================== */
/*  §1  CONSTANTS                                                         */
/* ===================================================================== */

const MODULE_ID  = "the-eternal-skald";
const SKALD_NAME = "The Eternal Skald";
const LOG_PREFIX = `${SKALD_NAME} |`;

/** Default endpoint — Abacus AI OpenAI-compatible chat-completions API. */
const DEFAULT_ENDPOINT  = "https://api.abacus.ai/v1/chat/completions";
const DEFAULT_MODEL     = "gemini-3.0-flash";

/**
 * The ONE endpoint this client talks to. It's a relative URL so it
 * resolves same-origin against whatever host/port/protocol Foundry is
 * served from. The server-side hook (eternal-skald-server.mjs) handles
 * this path and forwards to the upstream LLM. No CORS. No proxy. Done.
 */
const API_PATH = "/skald-api/chat";

// Foundry VTT v14 validates messages starting with "/" against an
// internal command registry BEFORE the `chatMessage` hook fires, and
// rejects unknown ones with a "not a valid chat message command"
// error. To bypass that pre-validation we use "!" as our command
// prefix — Foundry leaves "!" messages alone and our hook gets to
// inspect them.
const COMMANDS = Object.freeze({
  SKALD:  "!skald",
  ORACLE: "!oracle",
  NPC:    "!npc",
  SCENE:  "!scene",
  LORE:   "!lore",
  COMBAT: "!combat",
  HELP:   "!skald-help"
});

/* ===================================================================== */
/*  §2  MODULE SETTINGS                                                   */
/* ===================================================================== */

const Settings = {
  /** Register all settings — called from the 'init' hook. */
  register() {
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

  return [persona, rulesDigest, guidance].join("\n\n") + taskAddendum;
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
   * Post a styled Skald chat message. The body is wrapped in module CSS
   * classes so styles/eternal-skald.css can theme it.
   *
   * @param {string} content   - HTML body
   * @param {object} [opts]
   * @param {string} [opts.title]       - optional title shown above body
   * @param {string} [opts.alias]       - speaker alias (default: SKALD_NAME)
   * @param {string} [opts.variant]     - "default" | "oracle" | "combat" |
   *                                       "npc" | "help" | "lore"
   * @param {boolean}[opts.gmWhisper]   - whisper to GMs only
   */
  async postSkald(content, opts = {}) {
    const variant = opts.variant ?? "default";
    const title   = opts.title ? `<h3 class="es-title">${escapeHtml(opts.title)}</h3>` : "";
    const alias   = opts.alias ?? SKALD_NAME;

    const html = `
      <div class="eternal-skald-card es-variant-${variant}">
        <div class="es-banner">
          <span class="es-rune">ᚱ</span>
          <span class="es-alias">${escapeHtml(alias)}</span>
          <span class="es-rune">ᛗ</span>
        </div>
        ${title}
        <div class="es-body">${content}</div>
      </div>
    `;

    const data = {
      content: html,
      speaker: ChatMessage.getSpeaker({ alias }),
      flags: { [MODULE_ID]: { variant, alias } }
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

/**
 * Light formatter: convert simple markdown (**bold**, *italic*, line
 * breaks) coming back from the LLM into safe HTML.
 */
function formatMarkdown(text) {
  // Escape first, then re-introduce a tiny safe subset.
  let s = escapeHtml(text);
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\n{2,}/g, "</p><p>");
  s = s.replace(/\n/g, "<br/>");
  return `<p>${s}</p>`;
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
      default:               return null;
    }
  })();

  if (!handler) {
    console.log(`${LOG_PREFIX} dispatchCommand: no handler for ${head} — known commands:`, Object.values(COMMANDS));
    return false;
  }

  console.log(`${LOG_PREFIX} dispatching command "${head}" args="${args}"`);

  // Fire-and-forget: kick off the async handler, log any failure, but
  // DO NOT await — we have to return synchronously below so the hook
  // can suppress Foundry's default chat publication.
  Promise.resolve()
    .then(() => {
      console.log(`${LOG_PREFIX} command handler "${head}" starting...`);
      return handler();
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
      [COMMANDS.SKALD,  "Speak with the Skald. Ask anything — rules, ideas, narration."],
      [COMMANDS.ORACLE, "Roll an Ironsworn oracle and let the Skald interpret. e.g. <code>!oracle action</code>"],
      [COMMANDS.NPC,    "Conjure or roleplay an NPC. e.g. <code>!npc Old Keldra, the bone-witch</code>"],
      [COMMANDS.SCENE,  "Generate a scene/location description."],
      [COMMANDS.LORE,   "Generate world-building lore (and a Journal Entry)."],
      [COMMANDS.COMBAT, "Get tactical narration/advice for the current fight."]
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
      task: "Respond to the user as the Skald. If they ask a rules question, answer clearly; if they invite narration, narrate."
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
  }
};

/**
 * Generic conversation runner used by !skald, !scene, !combat. Manages
 * memory, builds the system prompt, calls the API, and posts the reply.
 */
async function runConversation(channel, userText, { task, label, variant = "default" } = {}) {
  try {
    Memory.push(channel, "user", userText);
    const messages = [
      { role: "system", content: buildSystemPrompt({ task }) },
      ...Memory.get(channel)
    ];
    await Chat.postSystem(`<em>${SKALD_NAME} listens to the wind…</em>`, { gmWhisper: true });
    const reply = await Client.chat(messages);
    Memory.push(channel, "assistant", reply);
    await Chat.postSkald(formatMarkdown(reply), { variant, title: label });
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
      const messages = [
        { role: "system", content: buildSystemPrompt({ task }) },
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
      const messages = [
        { role: "system", content: buildSystemPrompt({ task }) },
        ...Memory.get(session.channel),
        { role: "user", content: userLine }
      ];
      const reply = await Client.chat(messages, { temperature: 0.85 });
      Memory.push(session.channel, "user", userLine);
      Memory.push(session.channel, "assistant", reply);
      session.turnCount++;
      session.lastReply = reply;
      await Chat.postSkald(formatMarkdown(reply), {
        variant: "npc",
        alias: this._extractName(session.descriptor, session.stats)
      });
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
      const reply = await Client.chat([
        { role: "system", content: buildSystemPrompt({ task }) },
        { role: "user", content: `Interpret the oracle result: ${result}` }
      ], { temperature: 0.85 });
      await Chat.postSkald(formatMarkdown(reply), { variant: "oracle", title: "What the Skald Hears" });
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
      const reply = await Client.chat([
        { role: "system", content: buildSystemPrompt({ task }) },
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
        const journalContent = `<h2>${escapeHtml(topic)}</h2>${formatMarkdown(reply)}`;
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

  // Expose a small public API for macros and other modules.
  game.modules.get(MODULE_ID).api = {
    chat: Client.chat.bind(Client),
    rollOracle: IronswornData.rollOracle,
    commands: Commands,
    npc: NpcDialogue,
    combat: CombatController,
    lore: LoreGenerator,
    resetMemory: (ch) => Memory.reset(ch),
    IronswornData
  };

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

// --- renderChatMessage(HTML): allow CSS class hooks ------------------
Hooks.on("renderChatMessageHTML", (message, html /*, data */) => {
  if (message?.flags?.[MODULE_ID]) {
    html.classList?.add("eternal-skald-msg");
  }
});
// Legacy hook name for v12/v13 compatibility (no-op if unused).
Hooks.on("renderChatMessage", (message, html /*, data */) => {
  if (message?.flags?.[MODULE_ID]) {
    try { html.addClass("eternal-skald-msg"); } catch (_) { /* jq optional */ }
  }
});
