/* =====================================================================
 *  THE ETERNAL SKALD — Foundry VTT v14 Module
 *  ---------------------------------------------------------------------
 *  An AI-powered storytelling and combat-control assistant for Ironsworn
 *  and Ironsworn: Delve campaigns. Powered by Abacus AI ChatLLM
 *  (Gemini 3.0 Flash by default).
 *
 *  This single file contains the entire module logic, organised into the
 *  following clearly-delimited sections:
 *
 *      §1  CONSTANTS & IMPORTS
 *      §2  MODULE SETTINGS
 *      §3  SYSTEM PROMPT BUILDER
 *      §4  ABACUS AI CHATLLM CLIENT
 *      §5  CONVERSATION MEMORY
 *      §6  CHAT MESSAGE HELPERS (styled Skald output)
 *      §7  COMMAND HANDLERS  (/skald, /oracle, /npc, /scene, /lore,
 *                              /combat, /skald-help)
 *      §8  NPC DIALOGUE SYSTEM
 *      §9  ORACLE INTERPRETER
 *      §10 JOURNAL / LORE GENERATOR
 *      §11 ENEMY COMBAT CONTROLLER
 *      §12 RULES ADJUDICATION HELPERS
 *      §13 HOOK REGISTRATIONS
 *
 *  All API interactions use async/await. All entry points handle errors
 *  gracefully — a failure in the AI layer never blocks Foundry's UI.
 * ===================================================================== */

import { IronswornData } from "./ironsworn-data.js";

/* ===================================================================== */
/*  §1  CONSTANTS                                                         */
/* ===================================================================== */

const MODULE_ID  = "the-eternal-skald";
const SKALD_NAME = "The Eternal Skald";
const LOG_PREFIX = `${SKALD_NAME} |`;

/** Default endpoint — Abacus AI OpenAI-compatible chat-completions API. */
const DEFAULT_ENDPOINT = "https://api.abacus.ai/v1/chat/completions";
const DEFAULT_MODEL    = "gemini-3.0-flash";

const COMMANDS = Object.freeze({
  SKALD:  "/skald",
  ORACLE: "/oracle",
  NPC:    "/npc",
  SCENE:  "/scene",
  LORE:   "/lore",
  COMBAT: "/combat",
  HELP:   "/skald-help"
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
      default: "",
      // 'secret: true' obfuscates the value in v12+ UIs that support it.
      secret: true
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
/*  §4  ABACUS AI CHATLLM CLIENT                                          */
/* ===================================================================== */

const Client = {
  /**
   * Call the Abacus AI chat-completions endpoint with the supplied
   * messages array. Returns the assistant's reply text, or throws.
   *
   * The default endpoint is OpenAI-compatible
   * (https://api.abacus.ai/v1/chat/completions). Users with a custom
   * Abacus AI deployment can repoint to any endpoint that accepts the
   * same OpenAI-style JSON body.
   *
   * @param {Array<{role: string, content: string}>} messages
   * @param {object} [opts]
   * @param {number} [opts.temperature]
   * @param {number} [opts.maxTokens]
   * @returns {Promise<string>}
   */
  async chat(messages, opts = {}) {
    const apiKey   = Settings.get("apiKey");
    const model    = Settings.get("modelName")    || DEFAULT_MODEL;
    const endpoint = Settings.get("apiEndpoint")  || DEFAULT_ENDPOINT;

    if (!apiKey) {
      throw new Error(game.i18n.localize("ETERNAL_SKALD.errors.noApiKey"));
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error("Cannot call ChatLLM with empty messages.");
    }

    const body = {
      model,
      messages,
      temperature: opts.temperature ?? 0.8,
      max_tokens:  opts.maxTokens   ?? 800,
      stream: false
    };

    console.log(LOG_PREFIX, "Calling ChatLLM:", { endpoint, model, msgCount: messages.length });

    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          // Some Abacus deployments accept the raw header instead.
          "apiKey": apiKey
        },
        body: JSON.stringify(body)
      });
    } catch (netErr) {
      console.error(LOG_PREFIX, "Network failure", netErr);
      throw new Error(`Network error contacting the Skald: ${netErr.message}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(LOG_PREFIX, "HTTP error", response.status, text);
      throw new Error(`Skald API error ${response.status}: ${text.slice(0, 200)}`);
    }

    let data;
    try { data = await response.json(); }
    catch (e) {
      throw new Error("Skald returned a malformed response.");
    }

    // Support OpenAI-style { choices: [{ message: { content } }] }
    // as well as a couple of common Abacus AI variants.
    const content =
      data?.choices?.[0]?.message?.content ??
      data?.result?.messages?.slice(-1)?.[0]?.text ??
      data?.result?.content ??
      data?.text ??
      data?.response ??
      "";

    if (!content || typeof content !== "string") {
      console.error(LOG_PREFIX, "Unexpected response shape", data);
      throw new Error("Skald received an empty or malformed reply.");
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
 * Master dispatcher. Returns true if the message was consumed
 * (a Skald command) so Foundry doesn't also publish it verbatim.
 *
 * @param {ChatLog} chatLog
 * @param {string}  rawText
 * @param {object}  chatData
 * @returns {boolean} true to suppress default chat publication
 */
function dispatchCommand(chatLog, rawText, chatData) {
  if (!rawText || typeof rawText !== "string") return false;
  const trimmed = rawText.trim();
  if (!trimmed.startsWith("/")) return false;

  const [head, ...rest] = trimmed.split(/\s+/);
  const cmd = head.toLowerCase();
  const args = rest.join(" ").trim();

  switch (cmd) {
    case COMMANDS.HELP:    Commands.help();                    return true;
    case COMMANDS.SKALD:   Commands.skald(args);               return true;
    case COMMANDS.ORACLE:  Commands.oracle(args);              return true;
    case COMMANDS.NPC:     Commands.npc(args);                 return true;
    case COMMANDS.SCENE:   Commands.scene(args);               return true;
    case COMMANDS.LORE:    Commands.lore(args);                return true;
    case COMMANDS.COMBAT:  Commands.combat(args);              return true;
    default: return false;
  }
}

const Commands = {

  /* ----------------------------- /skald-help ----------------------- */
  async help() {
    const rows = [
      [COMMANDS.HELP,   "Show this help card."],
      [COMMANDS.SKALD,  "Speak with the Skald. Ask anything — rules, ideas, narration."],
      [COMMANDS.ORACLE, "Roll an Ironsworn oracle and let the Skald interpret. e.g. <code>/oracle action</code>"],
      [COMMANDS.NPC,    "Conjure or roleplay an NPC. e.g. <code>/npc Old Keldra, the bone-witch</code>"],
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

  /* ----------------------------- /skald ---------------------------- */
  async skald(args) {
    if (!args) {
      return Chat.postSystem(game.i18n.localize("ETERNAL_SKALD.errors.emptySkald"));
    }
    return runConversation("general", args, {
      task: "Respond to the user as the Skald. If they ask a rules question, answer clearly; if they invite narration, narrate."
    });
  },

  /* ----------------------------- /oracle --------------------------- */
  async oracle(args) {
    const key = (args || "action").trim().toLowerCase();
    return OracleInterpreter.roll(key);
  },

  /* ----------------------------- /npc ------------------------------ */
  async npc(args) {
    if (!args) {
      return Chat.postSystem(game.i18n.localize("ETERNAL_SKALD.errors.emptyNpc"));
    }
    return NpcDialogue.invoke(args);
  },

  /* ----------------------------- /scene ---------------------------- */
  async scene(args) {
    const seed = args || "the current scene";
    const ctx = SceneContext.summarise();
    const task = `Describe a vivid, atmospheric Ironsworn scene. Focus on sensory detail (iron weather, the wilds, ancient stones, distant horns). Avoid railroading the players. Subject: ${seed}.\n\nCurrent canvas context (may be empty):\n${ctx}`;
    return runConversation("scene", seed, { task, label: "Scene", variant: "default" });
  },

  /* ----------------------------- /lore ----------------------------- */
  async lore(args) {
    if (!args) {
      return Chat.postSystem(game.i18n.localize("ETERNAL_SKALD.errors.emptyLore"));
    }
    return LoreGenerator.write(args);
  },

  /* ----------------------------- /combat --------------------------- */
  async combat(args) {
    const ctx = CombatController.summariseCurrent();
    const task = `Provide a brief tactical narration AND a concrete suggestion for the current combat moment, grounded in Ironsworn moves (Enter the Fray, Strike, Clash, Secure an Advantage, Endure Harm). Be specific. Situation provided by the GM: ${args || "(unspecified)"}\n\nBattlefield snapshot:\n${ctx}`;
    return runConversation("combat", args || "tactical analysis", { task, label: "Counsel of Iron", variant: "combat" });
  }
};

/**
 * Generic conversation runner used by /skald, /scene, /combat. Manages
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
      await this._spawn(key, descriptor);
    }
    const session = this._sessions.get(key);

    // Subsequent turns: open-ended player line goes back to the NPC.
    if (session.turnCount > 0) {
      const userLine = descriptor.replace(/^[^:]*:\s*/, ""); // strip "Name:" prefix if given
      return this._respond(key, userLine);
    }
    // First turn already produced a greeting from _spawn().
    return session.lastReply;
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
    const token = combatant.token?.object ?? canvas.tokens.get(combatant.tokenId);
    if (!token) return;

    // Movement
    if (decision.move_to && Number.isFinite(decision.move_to.x) && Number.isFinite(decision.move_to.y)) {
      // Clamp to scene bounds
      const scene = canvas.scene;
      const x = Math.max(0, Math.min(decision.move_to.x, scene.dimensions.width  - token.w));
      const y = Math.max(0, Math.min(decision.move_to.y, scene.dimensions.height - token.h));
      try {
        await token.document.update({ x, y });
      } catch (e) { console.warn(LOG_PREFIX, "Token move failed", e); }
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

  /** Compact, LLM-friendly battlefield snapshot. */
  _combatSnapshot(activeCombatant) {
    const combat = game.combat;
    if (!combat) return "(no active combat)";

    const lines = [];
    lines.push(`Round ${combat.round}, turn ${combat.turn + 1}/${combat.combatants.size}.`);
    if (canvas.scene) lines.push(`Scene: ${canvas.scene.name}.`);

    for (const c of combat.combatants) {
      const tok = c.token?.object ?? canvas.tokens.get(c.tokenId);
      const actor = c.actor;
      const x = tok?.x ?? "?";
      const y = tok?.y ?? "?";
      const hp = foundry.utils.getProperty(actor ?? {}, "system.health.value") ??
                 foundry.utils.getProperty(actor ?? {}, "system.attributes.health.value") ??
                 "?";
      const role = this._isPlayerOwned(c) ? "HERO" : "FOE";
      const flag = c === activeCombatant ? " ←ACTIVE" : "";
      lines.push(`  [${role}] ${c.name} (id=${tok?.id ?? "?"}) pos=(${x},${y}) hp=${hp}${flag}`);
    }
    return lines.join("\n");
  },

  /** Used by the /combat command to give the LLM context. */
  summariseCurrent() {
    const combat = game.combat;
    if (!combat?.started) return "(no active combat)";
    return this._combatSnapshot(combat.combatant);
  }
};

/* ===================================================================== */
/*  §12 SCENE CONTEXT (for /scene)                                        */
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

// --- init: register settings -----------------------------------------
Hooks.once("init", () => {
  console.log(LOG_PREFIX, "Initialising…");
  Settings.register();
});

// --- ready: welcome banner & global API ------------------------------
Hooks.once("ready", async () => {
  console.log(LOG_PREFIX, "Ready.");

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
        `<strong>${SKALD_NAME}</strong> awaits your key. Open <em>Module Settings → The Eternal Skald</em> and provide your Abacus AI API key, then type <code>/skald-help</code>.`,
        { gmWhisper: true }
      );
    } else {
      await Chat.postSkald(
        `<p>I have come, summoned by iron and flame. Type <code>/skald-help</code> for the runes that wake me.</p>`,
        { variant: "default", title: "The Skald Arrives" }
      );
    }
  }
});

// --- chatMessage: intercept slash commands BEFORE Foundry posts them --
// Returning false from this hook prevents the default behaviour.
Hooks.on("chatMessage", (chatLog, message, chatData) => {
  try {
    const consumed = dispatchCommand(chatLog, message, chatData);
    return !consumed; // returning false suppresses the default chat post
  } catch (err) {
    console.error(LOG_PREFIX, "chatMessage handler crashed", err);
    return true; // let Foundry handle it normally
  }
});

// --- preCreateChatMessage: secondary safety net for command capture ---
Hooks.on("preCreateChatMessage", (message, data /*, options, userId */) => {
  const raw = data?.content ?? message?.content;
  if (typeof raw !== "string") return true;
  if (!raw.trim().startsWith("/")) return true;

  const head = raw.trim().split(/\s+/)[0].toLowerCase();
  if (Object.values(COMMANDS).includes(head)) {
    // Already handled in chatMessage hook — but if a macro pushes a
    // ChatMessage directly, intercept here too.
    const consumed = dispatchCommand(null, raw, data);
    return !consumed;
  }
  return true;
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

// --- createChatMessage: optional contextual reactions ----------------
// (Lightweight — only logs for now; users can extend via game.modules
// .get('the-eternal-skald').api.)
Hooks.on("createChatMessage", (message) => {
  if (message?.flags?.[MODULE_ID]) return; // ignore our own messages
  // Future hook: react to specific player triggers (e.g., "Skald,..."), kept
  // disabled by default to avoid spam.
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
