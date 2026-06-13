import { LOG_PREFIX, MODULE_ID, SKALD_NAME, COMMANDS } from "../core/constants.js";
import { Settings } from "../core/settings.js";
import { Client } from "../ai/client.js";
import { buildSystemPrompt } from "../ai/prompt-builder.js";
import { Memory, Chat, escapeHtml, formatMarkdown, parseMetadata } from "./display.js";
// Call-time cross-imports (safe cycle): these subsystems still live in eternal-skald.js
// and are only invoked inside command handlers (never at module-eval).
import { runConversation, CombatController, SceneContext,
         RagProgress } from "../eternal-skald.js";
import { Integration } from "../narrative/integration.js";
import { TokenControl } from "../narrative/token-control.js";
import { NpcDialogue, OracleInterpreter, LoreGenerator } from "../narrative/generators.js";
import { MapVision } from "../vision/map-vision.js";
import { JournalSystem } from "../chronicle/journal-system.js";
import { EntityLinker } from "../chronicle/entity-linking.js";
import { IronswornData } from "../ironsworn-data.js";
import { getActiveAdapter } from "../systems/registry.js";
import { BrowserRAG } from "../browser-rag.js";

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
export function dispatchCommand(rawText) {
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
      // --- Living Chronicle (v0.8.0) ---
      case COMMANDS.TIMELINE:      return () => Commands.timeline(args);
      case COMMANDS.RELATIONSHIPS: return () => Commands.relationships(args);
      case COMMANDS.MAP:           return () => Commands.relationships(args);
      case COMMANDS.TEMPLATE:      return () => Commands.template(args);
      // --- UX / polish (v0.9.0) ---
      case COMMANDS.LINK_STYLE:    return () => Commands.linkStyle(args);
      // --- Maintenance (v0.10.16) ---
      case COMMANDS.RESET:         return () => Commands.reset(args);
      case COMMANDS.WIPE:          return () => Commands.reset(args);
      // --- Map vision / scouting (v0.10.23) ---
      case COMMANDS.SCOUT:         return () => Commands.scout(args);
      case COMMANDS.SURVEY:        return () => Commands.scout(args);
      case COMMANDS.ANALYZE_MAP:   return () => Commands.scout(args);
      // --- Manual journey progress (v0.11.3) ---
      case COMMANDS.PROGRESS:      return () => Commands.progress(args);
      // --- Journal amend / rewrite (v0.14.0) ---
      case COMMANDS.JOURNAL_REWRITE: return () => Commands.journalRewrite(args);
      case COMMANDS.JOURNAL_AMEND:   return () => Commands.journalAmend(args);
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
      // (H3) Surface the failure as a persistent GM-whispered error card so it
      // isn't lost in a transient toast / the console. Fire-and-forget &
      // fail-soft — postError never throws.
      try {
        Chat.postError(`The command ${head} could not be completed.`, {
          detail: err?.message ?? String(err),
          hint: "Check your AI Provider, API Key and Connection Mode in Module Settings. See docs/TROUBLESHOOTING.md."
        });
      } catch (_) {}
    });

  return true;
}

export const Commands = {

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
      [COMMANDS.PROGRESS, "Review or advance a journey. <code>!progress</code> lists your journeys; <code>!progress 2</code> marks +2 boxes on the newest (add a name to target one)."],
      [COMMANDS.JOURNALS,  "List the chronicle entries the Skald has scribed. e.g. <code>!journals npc</code>"],
      [COMMANDS.JOURNAL_REWRITE, "GM-only: rewrite a chronicle entry's canonical content (prior text archived within). e.g. <code>!journal-rewrite \"Captain Reeves\" she is revealed a traitor</code>"],
      [COMMANDS.JOURNAL_AMEND,   "GM-only: append new details to a chronicle entry. e.g. <code>!journal-amend \"Highmount\" the eastern gate collapsed</code>"],
      [COMMANDS.MYSTERIES, "Review the open mysteries and unresolved threads."],
      [COMMANDS.REMIND,    "Recall what the chronicle holds — now with semantic memory. e.g. <code>!remind Keldra</code>"],
      [COMMANDS.END_SESSION, "GM-only: weave a Session Chronicle from this session's events."],
      [COMMANDS.REINDEX,   "GM-only: rebuild the Skald's semantic memory from all chronicle entries."],
      [COMMANDS.RAG_STATUS, "Show the state of the Skald's semantic memory (RAG)."],
      [COMMANDS.TIMELINE,      "Show the campaign timeline of events. Filter with a term, e.g. <code>!timeline Reeves</code>"],
      [COMMANDS.RELATIONSHIPS, "Show the web of who-knows-whom across the chronicle. (alias <code>!map</code>)"],
      [COMMANDS.TEMPLATE,      "GM-only: scribe a structured entry by hand. e.g. <code>!template npc</code>"],
      [COMMANDS.LINK_STYLE,    "GM-only: customise narration link colours/icons. e.g. <code>!link-style oracle #ff8800 fa-eye</code> (or <code>!link-style reset</code>)"],
      [COMMANDS.RESET,         "GM-only: wipe the chronicle for a new campaign — deletes unlocked Skald entries, semantic memory, conversation history & timeline (asks to confirm first). Alias <code>!skald-wipe</code>."],
      [COMMANDS.SCOUT,         "GM-only: have the Skald SEE & scout the current map — identifies terrain, landmarks & points of interest, and scribes them to the chronicle. Aliases <code>!survey</code>, <code>!analyze-map</code>."]
    ];

    const tableRows = rows.map(([c, d]) =>
      `<tr><td><code>${c}</code></td><td>${d}</td></tr>`
    ).join("");

    // Oracles are an Ironsworn-system feature; only advertise them when the
    // active system adapter actually supports oracle tables (capability-gated
    // so non-Ironsworn worlds, e.g. Nimble, don't see a misleading line).
    let oracleLine = "";
    try {
      if (getActiveAdapter().capabilities?.().oracles) {
        const knownOracles = Object.keys(IronswornData.oracles)
          .map(k => `<code>${k}</code>`).join(", ");
        oracleLine = `<p class="es-help-aside"><em>Oracles available:</em> ${knownOracles}.</p>`;
      }
    } catch (_) { /* defensive: no adapter / no oracles → omit the line */ }

    const body = `
      <p>I am <strong>${SKALD_NAME}</strong>, your saga-singer at this table. Speak to me with these runes:</p>
      <div class="es-help-scroll"><table class="es-help-table"><tbody>${tableRows}</tbody></table></div>
      ${oracleLine}
      <p class="es-help-aside"><em>GM-only:</em> Combat auto-control may be toggled in <strong>Module Settings → The Eternal Skald</strong>.</p>
    `;
    return Chat.postSkald(body, { variant: "help", title: "Commands of the Skald" });
  },

  /* ----------------------------- !progress ------------------------- */
  /**
   * (v0.11.3) Manually advance — or review — a JOURNEY track.
   *
   *   !progress              → list open journey tracks with their progress.
   *   !progress <boxes>      → add <boxes> filled boxes to the newest open
   *                            journey (1 box = 4 ticks). e.g. !progress 2
   *   !progress <boxes> <name> → advance the journey whose name fuzzy-matches
   *                            <name> instead of the newest open one.
   *
   * This is the player-facing companion to the "Undertake a Journey" auto-flow
   * and the progress gate on "Reach Your Destination": it lets you mark travel
   * progress by hand so you can legitimately reach the minimum before rolling.
   * Defensive throughout — never throws; reports problems to chat instead.
   */
  async progress(args) {
    const integ = Integration.active();
    if (!integ) {
      return Chat.postSystem(
        `${escapeHtml(SKALD_NAME)}: progress tracking needs the Ironsworn Rules Integration to be active.`,
        { gmWhisper: true }
      );
    }

    // Route through the active system adapter (Ironsworn in practice, since
    // Integration.active() above already requires it). Capability-gated so a
    // non-progress system degrades gracefully instead of throwing.
    const adapter = getActiveAdapter();
    if (!adapter.capabilities?.().progressTracks) {
      return Chat.postSystem(
        `${escapeHtml(SKALD_NAME)}: progress tracking is not supported by the active game system.`,
        { gmWhisper: true }
      );
    }

    const actor = adapter.getActiveCharacter();
    if (!actor) {
      return Chat.postSystem(
        `${escapeHtml(SKALD_NAME)}: no active character — select a token or assign your user a character first.`,
        { gmWhisper: true }
      );
    }

    const raw = String(args || "").trim();

    // Helper: list this actor's OPEN journey tracks (with progress) as a card.
    const listOpenJourneys = () => {
      // (fix — inconsistent journey detection) Previously this used a STRICT
      // predicate (kind === "journey" || subtype === "journey") that missed
      // journeys sworn directly on the foundry-ironsworn sheet: those are stored
      // as subtype "progress" with NO trackKind flag, so getProgressTracks()
      // reports kind=null and they never appeared in !progress — even though the
      // AI context (describeCharacter) and _newestOpenTrackItem already treat
      // them as journeys. (The subtype === "journey" clause was also dead code,
      // since createProgressTrack never stores that subtype.) Mirror the SAME
      // permissive classification describeCharacter uses so hand-made / legacy
      // journeys are listed and targetable here too.
      const isVowT     = t => t.kind === "vow" || t.subtype === "vow";
      const isCombatT  = t => t.kind === "combat" || t.subtype === "foe";
      const isJourneyT = t =>
        (t.kind === "journey") ||
        (!t.kind && !isVowT(t) && !isCombatT(t)
         && t.subtype !== "bond" && t.subtype !== "connection" && t.subtype !== "bondset");
      const journeys = (adapter.getProgressTracks(actor) || []).filter(t => {
        return isJourneyT(t) && !t.completed;
      });
      if (!journeys.length) {
        return Chat.postSkald(
          `<p>No open journeys to advance. Begin one with <code>!Undertake a Journey</code> (or just describe setting out), then use <code>!progress &lt;boxes&gt;</code>.</p>`,
          { variant: "help", title: "Journeys" }
        );
      }
      const rows = journeys.map(j => {
        const boxes = Math.max(0, Math.min(10, Number(j.boxes) || 0));
        const pct   = boxes * 10;
        const rank  = j.rank ? ` <em>(${escapeHtml(String(j.rank))})</em>` : "";
        const hint  = boxes >= 7
          ? "destination near — ready to <code>!Reach Your Destination</code>"
          : boxes >= 4
            ? "well underway"
            : "just begun — waypoints are dramatic beats, not the destination";
        return `<tr><td>${escapeHtml(j.name || "The Journey")}${rank}</td>` +
               `<td>${boxes}/10 (${pct}%)</td><td class="es-help-aside">${hint}</td></tr>`;
      }).join("");
      const body = `
        <p>Your open journeys:</p>
        <div class="es-help-scroll"><table class="es-help-table"><tbody>${rows}</tbody></table></div>
        <p class="es-help-aside"><em>Advance one with</em> <code>!progress &lt;boxes&gt;</code> <em>(e.g.</em> <code>!progress 2</code><em>), or</em> <code>!progress &lt;boxes&gt; &lt;name&gt;</code> <em>to target a specific journey.</em></p>
      `;
      return Chat.postSkald(body, { variant: "help", title: "Journeys" });
    };

    // No argument (or a non-numeric first token) → just list journeys.
    if (!raw) return listOpenJourneys();

    const m = raw.match(/^([0-9]+)\b\s*(.*)$/);
    if (!m) return listOpenJourneys();

    let boxes = parseInt(m[1], 10);
    if (!Number.isFinite(boxes) || boxes < 1) boxes = 1;
    if (boxes > 10) boxes = 10;                         // a track is only 10 boxes
    const nameFilter = String(m[2] || "").trim();

    // Resolve the target journey track: explicit name (fuzzy, journey-scoped)
    // or the newest open journey.
    let track = null;
    try {
      if (nameFilter) {
        const match = adapter.findTrackFuzzy(actor, nameFilter, "journey");
        if (match && !foundry.utils.getProperty(match, "system.completed")) track = match;
      }
      if (!track && !nameFilter) track = adapter._newestOpenTrackItem(actor, "journey");
    } catch (_) { /* fall through to the no-track message */ }

    if (!track) {
      const which = nameFilter ? `no open journey matching “${escapeHtml(nameFilter)}”` : "no open journey to advance";
      return Chat.postSkald(
        `<p>${which.charAt(0).toUpperCase() + which.slice(1)}. Begin one with <code>!Undertake a Journey</code> first, or run <code>!progress</code> to list your journeys.</p>`,
        { variant: "help", title: "Journeys" }
      );
    }

    // 1 box = 4 ticks. markProgress clamps to the 0–40 (0–10 box) range.
    const res = await adapter.markProgress(actor, track.id, boxes * 4);
    if (!res?.ok) {
      return Chat.postSystem(
        `${escapeHtml(SKALD_NAME)}: could not mark progress — ${escapeHtml(res?.error || "unknown error")}.`,
        { gmWhisper: true }
      );
    }

    const noun = boxes === 1 ? "box" : "boxes";
    return Chat.postSkald(
      `<p>Marked <strong>+${boxes} ${noun}</strong> on <strong>${escapeHtml(res.track)}</strong> — now <strong>${res.boxes}/10</strong> boxes.` +
      (res.boxes >= 10 ? ` It is fully charted — you may now <code>!Reach Your Destination</code>.` : ``) +
      `</p>`,
      { variant: "help", title: "Journey Progress" }
    );
  },

  /* ----------------------------- !skald ---------------------------- */
  async skald(args) {
    if (!args) {
      return Chat.postSystem(game.i18n.localize("ETERNAL_SKALD.errors.emptySkald"));
    }

    // ── Token control subcommands (v0.16.0) ────────────────────────────
    // `!skald move <token> to <x,y>`, `!skald move <token> <n> <dir>`,
    // `!skald remove <token>`, `!skald undo`. Only fires when the GM has
    // enabled Token Control AND is the GM — otherwise it returns false and
    // ordinary narration proceeds, so player input is never shadowed.
    try {
      if (await TokenControl.handleChatSubcommand(args)) return;
    } catch (e) {
      console.warn(LOG_PREFIX, "[skald] token subcommand failed — falling back to narration", e);
    }

    // ── Player move declaration (v0.10.33) ──────────────────────────────
    // Moves are the PLAYER's mechanical choice, not the AI's interpretation.
    // If the player simply NAMES an official Ironsworn move (e.g. "!Strike",
    // "!Face Danger", "!I want to Secure an Advantage +iron"), we open that
    // move's roll dialog and STOP — we do NOT generate a narrative
    // continuation. The story resumes only AFTER the dice resolve, via the
    // existing post-roll auto-narration (Integration.onIronswornRoll →
    // _narrateOutcome). Gated by a setting (default ON) and only when the
    // Ironsworn integration is active (otherwise there is no dialog to open,
    // so we fall through to ordinary narration). Defensive: detection never
    // throws and any failure simply falls back to narration.
    try {
      if ((Settings.get("interceptMoveDeclarations") ?? true) && Integration.active()) {
        const decl = getActiveAdapter().detectMoveDeclaration?.(args);
        if (decl?.move?.name) {
          console.log(`${LOG_PREFIX} [skald] move declaration detected: "${decl.move.name}"${decl.stat ? ` +${decl.stat}` : ""} (confidence=${decl.confidence}) — opening roll dialog, suppressing narration`);
          // doTriggerMove records intent (for post-roll narration) and opens
          // the system's official pre-roll dialog (progress/milestone-aware).
          // Pass the player's ORIGINAL words as rawIntent so journey auto-naming
          // can recover any destination they named (e.g. "Undertake a Journey to
          // Ironhome" → "Journey to Ironhome"). (v0.11.3)
          await Integration.doTriggerMove(decl.move.name, decl.stat || undefined, { rawIntent: args });
          return; // STOP — player drives the roll; no AI narration here.
        }
      }
    } catch (e) {
      console.warn(LOG_PREFIX, "[skald] move-declaration interception failed — falling back to narration", e);
    }

    // ── Intelligent action → move mapping (v0.10.34) ────────────────────
    // The message did NOT explicitly name a move. If it nonetheless DESCRIBES
    // a mechanical action ("I explore the cave further", "I attack the wolf"),
    // ask the AI classifier to map it to the appropriate Ironsworn move and
    // open that dialog (or a confirmation card for ambiguous / less-certain
    // cases) — suppressing narration until the dice resolve, exactly like an
    // explicit declaration. Questions ("what should I do?") and pure roleplay
    // are classified as such and fall through to ordinary narration. Gated by
    // a setting (default ON) and only when the Ironsworn integration is active.
    // Fully defensive: any failure falls back to narration.
    try {
      if ((Settings.get("intelligentMoveDetection") ?? true) && Integration.active()) {
        const routed = await Integration.classifyAndRouteAction(args);
        if (routed?.handled) {
          return; // STOP — a roll dialog or confirmation card was shown.
        }
      }
    } catch (e) {
      console.warn(LOG_PREFIX, "[skald] intelligent action mapping failed — falling back to narration", e);
    }

    return runConversation("general", args, {
      task: "Respond to the user as the Skald. If they ask a rules question, answer clearly; if they invite narration, narrate. If the fiction calls for a dice roll, name the appropriate Ironsworn move naturally inside your narration prose (written exactly as it appears in the move list) so it reads as part of the story — do NOT use a [[MOVE:…]] directive or a separate suggestion line.",
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

  /* --------------- !scout / !survey / !analyze-map (v0.10.23) ------- */
  async scout(_args) {
    // GM-only — scouting writes scene flags and journal entries.
    if (!game.user?.isGM) {
      return Chat.postSystem(
        `<em>Only the GM may send ${SKALD_NAME} to scout the map.</em>`,
        { gmWhisper: true }
      );
    }
    if (!Settings.get("apiKey")) {
      return Chat.postSystem(game.i18n.localize("ETERNAL_SKALD.errors.noApiKey"), { gmWhisper: true });
    }
    // Force a fresh analysis even if this scene was scouted before.
    return MapVision.analyzeScene(null, { force: true });
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

  /* ------------------------ !skald-reset (v0.10.16) ---------------- */
  /**
   * GM-only "clean slate" for starting a new campaign. After a confirmation
   * dialog, this:
   *   1. Deletes every UNLOCKED Skald-scribed chronicle entry. Journals NOT
   *      created by the Skald are never touched, and any entry the GM has
   *      locked (module flag `locked === true`) is preserved.
   *   2. Wipes the semantic-memory (RAG) vector store + query cache.
   *   3. Resets all in-memory conversation buffers.
   *   4. Empties the campaign timeline.
   * Finally it whispers a report to the GM listing exactly what was cleared.
   *
   * Pass <code>force</code>/<code>confirm</code>/<code>yes</code> as an argument
   * to skip the confirmation dialog (useful for macros).
   *
   * @param {string} [args]
   */
  async reset(args) {
    if (!game.user?.isGM) {
      return Chat.postSystem(`<em>Only the GM may wipe the chronicle for a new saga.</em>`, { gmWhisper: true });
    }

    // Survey what would be cleared so the confirmation is informed.
    const isLocked = (j) => {
      try { return j?.getFlag?.(MODULE_ID, "locked") === true; }
      catch (_) { return false; }
    };
    let all = [];
    try { all = JournalSystem.listEntries(); } catch (_) { all = []; }
    const doomed = all.filter(j => !isLocked(j));
    const lockedCount = all.length - doomed.length;

    let vectorCount = 0;
    try { vectorCount = await (BrowserRAG?.count?.() ?? 0); } catch (_) {}

    let timelineCount = 0;
    try { timelineCount = (JournalSystem.getTimeline?.() ?? []).length; } catch (_) {}

    const skip = /^(force|confirm|yes|y)$/i.test(String(args || "").trim());
    if (!skip) {
      const confirmed = await this._confirmReset({
        entries: doomed.length,
        locked: lockedCount,
        vectors: vectorCount,
        timeline: timelineCount
      });
      if (!confirmed) {
        return Chat.postSystem(`<em>The chronicle stands. Nothing was erased.</em>`, { gmWhisper: true });
      }
    }

    const report = { entries: 0, vectors: 0, memory: false, timeline: false, locked: lockedCount, failed: 0 };

    // 1. Delete unlocked Skald journal entries (batched). Their vectors are
    //    wiped wholesale below, so no per-entry RAG removal is needed here.
    if (doomed.length) {
      const ids = doomed.map(j => j.id).filter(Boolean);
      try {
        await JournalEntry.deleteDocuments(ids);
        report.entries = ids.length;
      } catch (e) {
        // Fall back to one-by-one so a single bad id can't abort the wipe.
        console.warn(LOG_PREFIX, "[reset] batch delete failed, retrying individually:", e?.message || e);
        for (const j of doomed) {
          try { await j.delete(); report.entries++; }
          catch (_) { report.failed++; }
        }
      }
    }

    // 2. Wipe semantic memory (RAG vector store + query cache).
    try {
      if (BrowserRAG?.isAvailable?.()) {
        const ok = await BrowserRAG.clear();
        if (ok) report.vectors = vectorCount;
      }
    } catch (e) { console.warn(LOG_PREFIX, "[reset] RAG clear failed:", e?.message || e); }

    // 3. Reset all in-memory conversation buffers.
    try { Memory.reset(); report.memory = true; } catch (_) {}

    // 4. Empty the campaign timeline.
    try { report.timeline = await JournalSystem.clearTimeline(); } catch (_) {}

    // Report what was cleared (GM-only).
    const rows = [
      ["Chronicle entries deleted",        String(report.entries)],
      ["Entries preserved (locked)",       String(report.locked)],
      ["Semantic-memory vectors cleared",  String(report.vectors)],
      ["Conversation memory",              report.memory ? "cleared" : "—"],
      ["Campaign timeline",                report.timeline ? "cleared" : "—"]
    ];
    if (report.failed) rows.push(["Entries that could not be deleted", String(report.failed)]);
    const tableRows = rows.map(([k, v]) => `<tr><td><strong>${k}</strong></td><td>${v}</td></tr>`).join("");
    return Chat.postSkald(
      `<p>The chronicle is wiped clean — a fresh saga may begin. Your own (non-Skald) journals were left untouched.</p>` +
      `<table class="es-help-table"><tbody>${tableRows}</tbody></table>` +
      `<p class="es-help-aside"><em>Tip: protect any entry from a future reset by setting its <code>${MODULE_ID}.locked</code> flag to <code>true</code>.</em></p>`,
      { variant: "lore", title: "A Clean Slate", gmWhisper: true }
    );
  },

  /**
   * Show a yes/no confirmation before a destructive reset. Prefers DialogV2
   * (v13+) and falls back to the classic Dialog. Resolves to a boolean.
   * @param {{entries?:number, locked?:number, vectors?:number, timeline?:number}} [counts]
   * @returns {Promise<boolean>}
   */
  async _confirmReset(counts = {}) {
    const summary =
      `<ul style="margin:.25em 0 .5em 1.1em;">` +
      `<li><strong>${counts.entries || 0}</strong> chronicle entries will be deleted` +
      (counts.locked ? ` (<strong>${counts.locked}</strong> locked entries kept)` : ``) + `</li>` +
      `<li><strong>${counts.vectors || 0}</strong> semantic-memory vectors will be wiped</li>` +
      `<li><strong>${counts.timeline || 0}</strong> timeline events will be cleared</li>` +
      `<li>Conversation memory will be reset</li></ul>`;
    const content =
      `<div class="eternal-skald-card es-variant-lore"><div class="es-body">` +
      `<p><strong>Wipe the chronicle for a new campaign?</strong></p>${summary}` +
      `<p style="color:var(--color-text-dark-secondary,#888);">Your own journals (not scribed by the Skald) are <strong>not</strong> affected. This cannot be undone.</p>` +
      `</div></div>`;

    // Prefer DialogV2 (v13+).
    try {
      const DV2 = foundry?.applications?.api?.DialogV2;
      if (DV2?.confirm) {
        return await DV2.confirm({
          window: { title: "Reset the Eternal Skald" },
          content,
          rejectClose: false,
          modal: true
        });
      }
    } catch (e) {
      console.warn(LOG_PREFIX, "DialogV2 confirm failed, falling back:", e?.message || e);
    }

    // Classic Dialog fallback.
    return new Promise((resolve) => {
      try {
        // eslint-disable-next-line no-undef
        new Dialog({
          title: "Reset the Eternal Skald",
          content,
          buttons: {
            wipe:   { icon: '<i class="fas fa-trash"></i>', label: "Wipe", callback: () => resolve(true) },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel", callback: () => resolve(false) }
          },
          default: "cancel",
          close: () => resolve(false)
        }).render(true);
      } catch (e) {
        console.error(LOG_PREFIX, "No dialog API available for reset", e);
        resolve(false);
      }
    });
  },

  /* ------------------ !journal-rewrite / !journal-amend (v0.14.0) ------------------ */

  /**
   * Parse a journal command's args into { name, instruction }. Supports a
   * leading quoted name ("Captain Reeves" rest...) or, if unquoted, treats the
   * FIRST word as the name and the remainder as the instruction.
   */
  _parseJournalArgs(args) {
    const raw = String(args || "").trim();
    if (!raw) return { name: "", instruction: "" };
    const q = raw.match(/^["“']([^"”']+)["”']\s*(.*)$/);
    if (q) return { name: q[1].trim(), instruction: (q[2] || "").trim() };
    const sp = raw.search(/\s/);
    if (sp === -1) return { name: raw, instruction: "" };
    return { name: raw.slice(0, sp).trim(), instruction: raw.slice(sp + 1).trim() };
  },

  /**
   * Resolve a chronicle entry by fuzzy name across the three entity types.
   * Returns { entry, type } or null. Reuses JournalSystem._findEntry().
   */
  _resolveJournalEntry(name) {
    for (const type of ["npc", "location", "discovery"]) {
      try {
        const entry = JournalSystem._findEntry(type, name, []);
        if (entry) return { entry, type };
      } catch (_) { /* try next type */ }
    }
    return null;
  },

  /**
   * Ask the model for fresh content for an entry. Returns an entities[]-shaped
   * object via the standard [[SKALD_META]] protocol (so the existing parser
   * understands it). `mode` is "rewrite" (full regenerate) or "amend" (delta).
   */
  async _generateEntryContent(entry, type, instruction, mode) {
    const page = entry.pages?.contents?.[0];
    const current = page?.text?.content ?? "";
    const aiCtx = (() => { try { return entry.getFlag?.(MODULE_ID, "aiContext") || ""; } catch (_) { return ""; } })();
    const verb = mode === "rewrite"
      ? "Regenerate the FULL, clean canonical entry for this subject."
      : "Produce ONLY the new/changed details to add to this subject.";
    const sys = buildSystemPrompt({
      task: `${verb} Output EXACTLY ONE [[SKALD_META]] block containing a single
"entities" array with ONE object of type "${type}", action "${mode === "rewrite" ? "create" : "update"}",
name "${entry.name}", and the appropriate structured fields + a 1–3 sentence
"description". No narration, no prose outside the block.`,
      allowJournal: true
    });
    const user = `EXISTING ENTRY (HTML):\n${current.slice(0, 4000)}\n\nCONTEXT NOTES:\n${aiCtx}\n\nGM INSTRUCTION:\n${instruction || "(none — use established lore)"}`;
    let reply = "";
    try {
      reply = await Client.chat(
        [{ role: "system", content: sys }, { role: "user", content: user }],
        { temperature: 0.5, maxTokens: 900 }
      );
    } catch (e) {
      console.warn(LOG_PREFIX, "journal content generation failed:", e?.message || e);
      return null;
    }
    const { metadata } = parseMetadata(reply);
    const ent = Array.isArray(metadata?.entities) ? metadata.entities.find(e => e?.name) : null;
    return ent || null;
  },

  /**
   * !journal-rewrite "<entity>" <instruction>
   * Regenerate an entry's canonical body. Prior content is ARCHIVED by
   * JournalSystem.rewriteEntity() (via the "rewrite" queue job) — never lost.
   */
  async journalRewrite(args) {
    if (!JournalSystem.canWrite?.()) {
      return Chat.postSystem(`<em>Only the GM may rewrite the chronicle.</em>`, { gmWhisper: true });
    }
    const { name, instruction } = this._parseJournalArgs(args);
    if (!name) {
      return Chat.postSkald(
        `<p>Usage: <code>!journal-rewrite "Captain Reeves" she is now revealed a traitor</code></p>`,
        { variant: "lore", title: "Rewrite a Chronicle Entry", gmWhisper: true }
      );
    }
    const found = this._resolveJournalEntry(name);
    if (!found) {
      return Chat.postSystem(`<em>No chronicle entry found for “${escapeHtml(name)}”.</em>`, { gmWhisper: true });
    }
    const ent = await this._generateEntryContent(found.entry, found.type, instruction, "rewrite");
    if (!ent) {
      return Chat.postSystem(`<em>The Skald could not compose a rewrite for “${escapeHtml(found.entry.name)}”.</em>`, { gmWhisper: true });
    }
    // Route through the serial queue (archive-safe). Strip the title from body
    // fields; rewriteEntity() re-adds the entry's name.
    JournalSystem.queue().enqueue({
      kind: "rewrite", op: "rewrite", type: found.type,
      target: found.entry.name, aliases: [],
      body: ent, reason: instruction || "GM-requested rewrite"
    });
    return Chat.postSkald(
      `<p>Rewriting <strong>${escapeHtml(found.entry.name)}</strong> — the prior text has been archived within the entry.</p>`,
      { variant: "lore", title: "Chronicle Rewritten", gmWhisper: true }
    );
  },

  /**
   * !journal-amend "<entity>" <instruction>
   * Append a structured update to an entry (history-safe append, same engine
   * as the AI's action:"update").
   */
  async journalAmend(args) {
    if (!JournalSystem.canWrite?.()) {
      return Chat.postSystem(`<em>Only the GM may amend the chronicle.</em>`, { gmWhisper: true });
    }
    const { name, instruction } = this._parseJournalArgs(args);
    if (!name) {
      return Chat.postSkald(
        `<p>Usage: <code>!journal-amend "Highmount" the eastern gate collapsed in the storm</code></p>`,
        { variant: "lore", title: "Amend a Chronicle Entry", gmWhisper: true }
      );
    }
    const found = this._resolveJournalEntry(name);
    if (!found) {
      return Chat.postSystem(`<em>No chronicle entry found for “${escapeHtml(name)}”.</em>`, { gmWhisper: true });
    }
    const ent = await this._generateEntryContent(found.entry, found.type, instruction, "amend");
    if (!ent) {
      return Chat.postSystem(`<em>The Skald could not compose an amendment for “${escapeHtml(found.entry.name)}”.</em>`, { gmWhisper: true });
    }
    JournalSystem.queue().enqueue({
      kind: "rewrite", op: "amend", type: found.type,
      target: found.entry.name, aliases: [], body: ent
    });
    return Chat.postSkald(
      `<p>Amending <strong>${escapeHtml(found.entry.name)}</strong> with new details.</p>`,
      { variant: "lore", title: "Chronicle Amended", gmWhisper: true }
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
  },

  /* ------------------------- !link-style (v0.9.0) ----------------- */
  /**
   * Customise the colour and/or icon of the inline entity links the Skald
   * weaves into narration, per entity kind. Usage:
   *   !link-style                         → show the current palette
   *   !link-style reset                   → clear all overrides
   *   !link-style <kind> [#color] [fa-icon]
   *      kind ∈ journal | move | oracle | track | asset
   *      e.g.  !link-style oracle #ff8800 fa-eye
   *            !link-style move fa-khanda
   *            !link-style asset #8fb8d6
   * GM-only (it writes a world setting). Defensive and purely cosmetic.
   */
  async linkStyle(args) {
    if (!game.user?.isGM) {
      return Chat.postSystem(`<em>Only the GM may reshape the runes of the chronicle's links.</em>`, { gmWhisper: true });
    }
    const raw = String(args || "").trim();

    // No args → show the current palette card.
    if (!raw) return this._showLinkStyles();

    if (/^reset$/i.test(raw)) {
      await EntityLinker.resetStyles();
      return Chat.postSystem(`<em>${SKALD_NAME}: link styles reset to their default hues.</em>`, { gmWhisper: true });
    }

    const tokens = raw.split(/\s+/);
    const kind = tokens.shift()?.toLowerCase();
    if (!EntityLinker.STYLE_KINDS.includes(kind)) {
      return Chat.postSystem(
        `<em>Unknown link kind <code>${escapeHtml(String(kind))}</code>. Choose one of: ${EntityLinker.STYLE_KINDS.map(k => `<code>${k}</code>`).join(", ")}.</em>`,
        { gmWhisper: true }
      );
    }

    // Remaining tokens: a colour (#hex or word) and/or an icon (fa-… or bare).
    const patch = {};
    for (const tok of tokens) {
      if (/^#?[0-9a-f]{3,8}$/i.test(tok) && /[0-9a-f]/i.test(tok) && (tok.startsWith("#") || /^[0-9a-f]{6}$/i.test(tok))) {
        patch.color = tok.startsWith("#") ? tok : `#${tok}`;
      } else if (/^fa-/i.test(tok)) {
        patch.icon = tok;
      } else if (/^#/.test(tok)) {
        patch.color = tok;
      } else if (/^[a-z]{3,20}$/i.test(tok) && !patch.color) {
        patch.color = tok; // a named colour like "gold"
      } else {
        patch.icon = tok;  // treat as an icon glyph name (setStyle prefixes fa-)
      }
    }

    const resolved = await EntityLinker.setStyle(kind, patch);
    if (!resolved) {
      return Chat.postSystem(
        `<em>${SKALD_NAME}: I could not read that style. Try <code>!link-style ${escapeHtml(kind)} #ff8800 fa-eye</code>.</em>`,
        { gmWhisper: true }
      );
    }
    return this._showLinkStyles(`Set <strong>${escapeHtml(kind)}</strong> → <code>${escapeHtml(resolved.color)}</code> / <code>${escapeHtml(resolved.icon)}</code>.`);
  },

  /** Render a small card showing the current per-kind link palette. (v0.9.0) */
  async _showLinkStyles(note = "") {
    const on = EntityLinker.customStylesEnabled();
    const rows = EntityLinker.STYLE_KINDS.map(kind => {
      const s = EntityLinker._styleFor(kind);
      const swatch = `<span style="display:inline-block;width:12px;height:12px;border-radius:2px;border:1px solid #0006;background:${escapeHtml(s.color)};vertical-align:middle"></span>`;
      const icon = kind === "journal" ? "" : `<i class="fa-solid ${escapeHtml(s.icon)}"></i> `;
      return `<tr><td><code>${kind}</code></td><td>${swatch} <code>${escapeHtml(s.color)}</code></td><td>${icon}<code>${escapeHtml(s.icon)}</code></td></tr>`;
    }).join("");
    const body = `
      ${note ? `<p>${note}</p>` : ""}
      <p>Custom link styles are <strong>${on ? "ON" : "OFF"}</strong>${on ? "" : " — set any style to enable them"}.</p>
      <table class="es-help-table"><thead><tr><th>Kind</th><th>Colour</th><th>Icon</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="es-help-aside"><em>Usage:</em> <code>!link-style &lt;kind&gt; [#color] [fa-icon]</code> · <code>!link-style reset</code></p>`;
    return Chat.postSkald(body, { variant: "help", title: "Chronicle Link Styles", gmWhisper: true });
  },

  /* ------------------------- !timeline (v0.8.0) -------------------- */
  /**
   * Render the persistent campaign timeline as a chronological card. Events
   * are shown newest-first with a human timestamp, the channel, the entities
   * touched (as @UUID journal links when an entry exists), and short summaries
   * of facts / mysteries / decisions. An optional argument filters the log by
   * a free-text term (entity name, fact text, channel…).
   */
  async timeline(args) {
    const query = (args || "").trim();

    // Allow "!timeline clear" (GM-only) to wipe history.
    if (query.toLowerCase() === "clear") {
      if (!game.user?.isGM) {
        return Chat.postSystem(`<em>Only the GM may erase the timeline.</em>`, { gmWhisper: true });
      }
      const ok = await JournalSystem.clearTimeline();
      return Chat.postSystem(
        ok ? `<em>The timeline has been cleared.</em>` : `<em>The timeline could not be cleared.</em>`,
        { gmWhisper: true }
      );
    }

    let events = [];
    try { events = JournalSystem.getTimeline(query); } catch (_) { events = []; }

    if (!events.length) {
      const msg = query
        ? `<em>No timeline events match “${escapeHtml(query)}”.</em>`
        : `<em>The timeline is empty. Play on — I mark each turn of the saga as it happens.</em>`;
      return Chat.postSystem(msg, { gmWhisper: true });
    }

    // Newest first, cap the rendered count so the card stays readable.
    const ordered = events.slice().sort((a, b) => (b.t || 0) - (a.t || 0));
    const MAX = 40;
    const shown = ordered.slice(0, MAX);

    const fmtTime = (t) => {
      try {
        const d = new Date(t || 0);
        if (isNaN(d.getTime())) return "—";
        return d.toLocaleString(undefined, {
          year: "numeric", month: "short", day: "numeric",
          hour: "2-digit", minute: "2-digit"
        });
      } catch (_) { return "—"; }
    };

    // Turn an entity {name,type} into a journal content-link when we can find
    // a matching chronicle entry; otherwise show the bare (escaped) name.
    const entityLink = (e) => {
      const name = String(e?.name ?? "").trim();
      if (!name) return "";
      try {
        const hit = JournalSystem._findEntry?.(e?.type || "", name) || JournalSystem._findAnyEntry?.(name);
        if (hit) {
          const uuid = hit.uuid ?? `JournalEntry.${hit.id}`;
          return `@UUID[${uuid}]{${escapeHtml(hit.name || name)}}`;
        }
      } catch (_) { /* fall through to plain text */ }
      return escapeHtml(name);
    };

    const rows = shown.map(ev => {
      const ents = (ev.entities || []).map(entityLink).filter(Boolean).join(", ");
      const bits = [];
      if (ents) bits.push(`<div class="es-timeline-ents">👤 ${ents}</div>`);
      for (const f of (ev.facts || []).slice(0, 4)) {
        bits.push(`<div class="es-timeline-fact">• ${escapeHtml(f)}</div>`);
      }
      for (const m of (ev.mysteries || []).slice(0, 3)) {
        bits.push(`<div class="es-timeline-mystery">❓ ${escapeHtml(m)}</div>`);
      }
      for (const d of (ev.decisions || []).slice(0, 3)) {
        bits.push(`<div class="es-timeline-decision">⚖️ ${escapeHtml(d)}</div>`);
      }
      const chan = ev.channel ? `<span class="es-timeline-chan">${escapeHtml(ev.channel)}</span>` : "";
      return `<li class="es-timeline-event">
        <div class="es-timeline-when">🕮 ${escapeHtml(fmtTime(ev.t))} ${chan}</div>
        ${bits.join("")}
      </li>`;
    }).join("");

    const head = query
      ? `<p>Timeline — events matching “<strong>${escapeHtml(query)}</strong>” (${shown.length}${ordered.length > MAX ? ` of ${ordered.length}` : ""}):</p>`
      : `<p>The saga so far — newest first (${shown.length}${ordered.length > MAX ? ` of ${ordered.length}` : ""}):</p>`;

    const tip = ordered.length > MAX
      ? `<p class="es-help-aside"><em>Showing the latest ${MAX}. Use <code>!timeline &lt;term&gt;</code> to filter.</em></p>`
      : `<p class="es-help-aside"><em>Tip: <code>!timeline &lt;term&gt;</code> filters by name or keyword.</em></p>`;

    return Chat.postSkald(
      `${head}<ul class="es-timeline">${rows}</ul>${tip}`,
      { variant: "lore", title: "The Living Timeline" }
    );
  },

  /* ---------------------- !relationships / !map (v0.8.0) ----------- */
  /**
   * Render the chronicle's relationship web as a grouped list view. For every
   * entity that has recorded connections we show the entity (as a journal
   * link) and its outgoing relationships (also links) with their relationship
   * phrase. An optional argument filters to entities whose name matches.
   */
  async relationships(args) {
    const query = (args || "").trim().toLowerCase();

    let entries = [];
    try { entries = JournalSystem.listEntries("npc")
      .concat(JournalSystem.listEntries("location"))
      .concat(JournalSystem.listEntries("discovery")); } catch (_) { entries = []; }

    // Build [{name, uuid, rels:[{name,uuid,rel}]}] for entries that have any.
    const groups = [];
    for (const j of entries) {
      let rels = [];
      try { rels = JournalSystem._entryRelated(j); } catch (_) { rels = []; }
      if (!Array.isArray(rels) || !rels.length) continue;
      const name = j?.name ?? "";
      if (query && !name.toLowerCase().includes(query)) continue;
      const uuid = j.uuid ?? `JournalEntry.${j.id}`;
      groups.push({ name, uuid, rels });
    }

    if (!groups.length) {
      const msg = query
        ? `<em>No mapped relationships match “${escapeHtml(args.trim())}”.</em>`
        : `<em>No relationships yet woven. As folk and places connect in play, I map them here.</em>`;
      return Chat.postSystem(msg, { gmWhisper: true });
    }

    groups.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    const blocks = groups.map(g => {
      const selfLink = `@UUID[${g.uuid}]{${escapeHtml(g.name)}}`;
      const items = g.rels.map(r => {
        const label = escapeHtml(String(r.name ?? "").replace(/[{}]/g, "")) || "(unknown)";
        const link = r.uuid ? `@UUID[${r.uuid}]{${label}}` : label;
        const rel = (r.rel && r.rel !== "related") ? ` — <em>${escapeHtml(String(r.rel))}</em>` : "";
        return `<li>${link}${rel}</li>`;
      }).join("");
      return `<div class="es-rel-group">
        <p class="es-rel-name"><strong>🔗 ${selfLink}</strong> <span class="es-journal-count">(${g.rels.length})</span></p>
        <ul class="es-rel-list">${items}</ul>
      </div>`;
    }).join("");

    const head = query
      ? `<p>Relationships for entities matching “<strong>${escapeHtml(args.trim())}</strong>”:</p>`
      : `<p>The web of who-knows-whom across the chronicle:</p>`;

    return Chat.postSkald(
      `${head}${blocks}<p class="es-help-aside"><em>Tip: open any entry to see its Connections, or use <code>!map &lt;name&gt;</code> to focus.</em></p>`,
      { variant: "lore", title: "The Web of Bonds" }
    );
  },

  /* --------------------------- !template (v0.8.0) ------------------ */
  /**
   * Open a structured-entry dialog so the GM can hand-author an NPC, Location
   * or Discovery using the same template fields the AI fills. On submit the
   * entry is created via JournalSystem with createdBy:"manual" so it lives
   * alongside AI-scribed entries (and participates in linking/relationships).
   *
   * Usage: "!template", "!template npc", "!template location", "!template discovery".
   */
  async template(args) {
    if (!game.user?.isGM) {
      return Chat.postSystem(`<em>Only the GM may scribe structured entries by hand.</em>`, { gmWhisper: true });
    }

    const TYPES = JournalSystem.TYPES || {};
    const allowed = ["npc", "location", "discovery"].filter(t => TYPES[t]);
    let initialType = (args || "").trim().toLowerCase();
    if (!allowed.includes(initialType)) initialType = allowed[0] || "npc";

    // Build the form HTML for a given type's fields.
    const fieldsHtml = (type) => {
      const spec = TYPES[type] || {};
      const fields = Array.isArray(spec.fields) ? spec.fields : [];
      const parts = [
        `<div class="form-group"><label>Name</label><input type="text" name="es-name" placeholder="e.g. Captain Reeves" autofocus/></div>`,
        `<div class="form-group"><label>Aliases <span class="notes">(comma-separated)</span></label><input type="text" name="es-aliases" placeholder="the captain, Reeves"/></div>`
      ];
      for (const f of fields) {
        if (!f || !f.key) continue;
        const label = escapeHtml(f.label || f.key);
        const nm = `es-f-${escapeHtml(f.key)}`;
        if (Array.isArray(f.choices) && f.choices.length) {
          const opts = f.choices.map(c => `<option value="${escapeHtml(String(c))}">${escapeHtml(String(c))}</option>`).join("");
          parts.push(`<div class="form-group"><label>${label}</label><select name="${nm}"><option value=""></option>${opts}</select></div>`);
        } else if (f.area) {
          parts.push(`<div class="form-group"><label>${label}</label><textarea name="${nm}" rows="2"></textarea></div>`);
        } else {
          parts.push(`<div class="form-group"><label>${label}</label><input type="text" name="${nm}"/></div>`);
        }
      }
      return parts.join("");
    };

    const typeOptions = allowed.map(t =>
      `<option value="${t}"${t === initialType ? " selected" : ""}>${escapeHtml(TYPES[t].label || t)}</option>`
    ).join("");

    const content = `
      <div class="es-template-dialog">
        <div class="form-group">
          <label>Entry Type</label>
          <select name="es-type" class="es-template-type">${typeOptions}</select>
        </div>
        <hr/>
        <div class="es-template-fields">${fieldsHtml(initialType)}</div>
      </div>`;

    // Read a submitted form into an entity object and create the entry.
    const submit = async (form) => {
      try {
        if (!form) return;
        const get = (n) => {
          const el = form.querySelector(`[name="${n}"]`);
          return el ? String(el.value || "").trim() : "";
        };
        const type = get("es-type") || initialType;
        const name = get("es-name");
        if (!name) {
          ui.notifications?.warn(`${SKALD_NAME}: a name is required.`);
          return;
        }
        const spec = TYPES[type] || {};
        const fields = Array.isArray(spec.fields) ? spec.fields : [];
        const entity = { type, name };
        const aliasRaw = get("es-aliases");
        if (aliasRaw) {
          entity.aliases = aliasRaw.split(",").map(s => s.trim()).filter(Boolean);
        }
        for (const f of fields) {
          if (!f || !f.key) continue;
          const v = get(`es-f-${f.key}`);
          if (v) entity[f.key] = v;
        }
        const created = await JournalSystem._createEntity(type, entity, null, { createdBy: "manual" });
        if (created) {
          try { EntityLinker.invalidate(); } catch (_) {}
          const uuid = created.uuid ?? `JournalEntry.${created.id}`;
          await Chat.postSkald(
            `<p>Scribed a new ${escapeHtml(spec.label || type)}: @UUID[${uuid}]{${escapeHtml(name)}}.</p>`,
            { variant: "lore", title: "Entry Scribed" }
          );
        } else {
          ui.notifications?.warn(`${SKALD_NAME}: the entry could not be scribed.`);
        }
      } catch (e) {
        console.warn(LOG_PREFIX, "template submit failed:", e?.message || e);
        ui.notifications?.error(`${SKALD_NAME}: scribing failed — ${e?.message || e}`);
      }
    };

    // Wire the type-selector so the field set updates live (best-effort).
    const wireTypeSwitch = (root) => {
      try {
        const sel = root.querySelector?.("select.es-template-type");
        const box = root.querySelector?.(".es-template-fields");
        if (!sel || !box) return;
        sel.addEventListener("change", () => { box.innerHTML = fieldsHtml(sel.value); });
      } catch (_) { /* non-fatal */ }
    };

    // Prefer DialogV2 (v12+), fall back to the classic Dialog.
    const DV2 = foundry?.applications?.api?.DialogV2;
    if (DV2?.prompt) {
      try {
        return await DV2.prompt({
          window: { title: "Scribe a Structured Entry" },
          content,
          ok: {
            label: "Scribe",
            callback: (_ev, button) => submit(button?.form)
          },
          rejectClose: false,
          render: (_ev, dialog) => {
            try { wireTypeSwitch(dialog?.element ?? dialog); } catch (_) {}
          }
        });
      } catch (e) {
        console.warn(LOG_PREFIX, "DialogV2 template failed, falling back:", e?.message || e);
      }
    }

    // Classic Dialog fallback.
    return new Promise((resolve) => {
      const dlg = new Dialog({
        title: "Scribe a Structured Entry",
        content,
        buttons: {
          ok: {
            label: "Scribe",
            callback: async (html) => {
              const root = html?.[0] ?? html;
              const form = root?.querySelector?.("form") ?? root;
              await submit(form);
              resolve(true);
            }
          },
          cancel: { label: "Cancel", callback: () => resolve(false) }
        },
        default: "ok",
        render: (html) => { try { wireTypeSwitch(html?.[0] ?? html); } catch (_) {} }
      });
      dlg.render(true);
    });
  }
};

/**
 * Helper: extract a string out of whatever Foundry passes to the hook
 * (string / object with .content / object with .text).
 */
export function extractMessageText(arg) {
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
export function stripHtml(html) {
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
 * (v0.10.29) Cross-hook dispatch dedupe guard.
 *
 * WHY: a single `!command` can be seen by ALL THREE command-interception
 * hooks (chatMessage → preCreateChatMessage → createChatMessage). On
 * Foundry builds that honour an early `return false` only the first hook
 * fires, but on builds that IGNORE the cancellation (documented v14
 * behaviour, see the strategy note above) the same line reaches two or
 * three hooks — each of which would otherwise dispatch the command again.
 * That produced the "identical sequence runs 3×" symptom: e.g. `!scout`
 * firing three AI vision passes and posting duplicate cards/notices.
 *
 * The guard records the last dispatch time per normalised command text and
 * suppresses an identical re-dispatch inside a short window. We still report
 * the line as "consumed" (return true) so every hook keeps suppressing the
 * raw `!command` echo — we simply do not run the handler more than once.
 */
export const _recentDispatches = new Map();
export const _DISPATCH_DEDUPE_MS = 1500;

export function _alreadyDispatched(key) {
  const now = Date.now();
  // Opportunistic cleanup so the map never grows unbounded.
  for (const [k, t] of _recentDispatches) {
    if (now - t > _DISPATCH_DEDUPE_MS) _recentDispatches.delete(k);
  }
  const last = _recentDispatches.get(key);
  _recentDispatches.set(key, now);
  return last !== undefined && (now - last) < _DISPATCH_DEDUPE_MS;
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
export function tryCommandFromText(text, source) {
  const rawIn = text || "";
  const stripped = stripHtml(rawIn);
  if (stripped !== rawIn.trim()) {
    console.log(`${LOG_PREFIX} [${source}] stripped HTML: ${JSON.stringify(rawIn)} -> ${JSON.stringify(stripped)}`);
  }
  if (!stripped.startsWith("!")) return false;
  console.log(`${LOG_PREFIX} [${source}] candidate command text:`, JSON.stringify(stripped));

  // (v0.10.29) Suppress duplicate dispatch when more than one interception
  // hook sees the same line. Report consumed (true) so the raw echo is still
  // suppressed, but only run the handler for the first hook to reach here.
  if (_alreadyDispatched(stripped)) {
    console.log(`${LOG_PREFIX} [${source}] duplicate within ${_DISPATCH_DEDUPE_MS}ms — already dispatched, suppressing re-run`);
    return true;
  }

  // Pass the STRIPPED text to dispatch — never the HTML-wrapped form.
  const dispatched = dispatchCommand(stripped);
  console.log(`${LOG_PREFIX} [${source}] dispatchCommand returned:`, dispatched);
  return dispatched;
}
