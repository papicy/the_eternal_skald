import { LOG_PREFIX, MODULE_ID, SKALD_NAME } from "../core/constants.js";
import { Settings } from "../core/settings.js";
import { Client } from "../ai/client.js";
import { buildSystemPrompt, buildIronswornPromptBlock } from "../ai/prompt-builder.js";
import { Memory, Chat, escapeHtml, formatMarkdown, stripDirectivesForDisplay, callSkaldStreaming } from "../chat/display.js";
import { EntityLinker } from "../chronicle/entity-linking.js";
import { JournalSystem } from "../chronicle/journal-system.js";
import { OracleInterpreter } from "./generators.js";
import { IronswornController } from "../ironsworn-controller.js";
// Call-time cross-imports (safe cycle): CombatController & RagBridge still live in
// eternal-skald.js and are only referenced inside Integration methods (never module-eval).
import { CombatController, RagBridge } from "../eternal-skald.js";

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
export const Integration = {
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
      }
      // Map / scene awareness (v0.10.22): the active scene's name, its
      // marked locations (journal pins) and notable visible tokens. Provided
      // in and out of combat so the Skald can reference REAL places on the
      // map (e.g. when suggesting a destination). Read-only and concise.
      const sceneCtx = this._gatherSceneContext();
      if (sceneCtx) blocks.push(sceneCtx);
    } catch (e) { console.warn(LOG_PREFIX, "gatherContext: scene/map read failed", e); }

    return blocks.join("\n\n");
  },

  /**
   * Build a concise, read-only description of the ACTIVE scene for the AI
   * context (v0.10.22 — map/scene awareness).
   *
   * Surfaces three things, each optional and capped for token efficiency:
   *   • CURRENT SCENE      — the active scene's navigation/label name.
   *   • Visible Locations  — names drawn from the scene's map notes (journal
   *                          pins). The linked JournalEntry's name is used
   *                          (falling back to the note's custom label text),
   *                          so the Skald references places that genuinely
   *                          exist on the map.
   *   • Notable Tokens     — names of tokens placed on the scene, EXCLUDING
   *                          hidden (GM-only) tokens so secrets never leak
   *                          into the narration prompt.
   *
   * Fully defensive: returns "" when no scene is active or on any read
   * failure, so prompt-building never breaks (graceful degradation). The
   * method intentionally avoids `this` so it is trivially unit-testable.
   *
   * @returns {string} A formatted block, or "" when there is nothing to add.
   */
  _gatherSceneContext() {
    try {
      // Prefer the explicitly-activated scene; fall back to the viewed canvas.
      const scene = game?.scenes?.active ?? canvas?.scene ?? null;
      if (!scene) return ""; // no active scene → graceful degradation

      const sceneName = String(scene.navName || scene.name || "").trim() || "(unnamed scene)";
      const lines = [`CURRENT SCENE: ${sceneName}`];

      // --- Visible locations: scene notes / journal pins → linked journals.
      const locations = [];
      const seenLoc = new Set();
      try {
        const notes = scene.notes ? Array.from(scene.notes) : [];
        for (const note of notes) {
          if (!note) continue;
          // A note's custom label text overrides the linked entry's name.
          let label = "";
          try { label = String(note.text ?? "").trim(); } catch (_) { label = ""; }
          // Resolve the linked JournalEntry by id (NoteDocument.entryId).
          let journalName = "";
          try {
            const entry = (note.entryId && game?.journal?.get)
              ? game.journal.get(note.entryId)
              : (note.entry ?? null);
            if (entry?.name) journalName = String(entry.name).trim();
          } catch (_) { journalName = ""; }
          const name = label || journalName;
          if (!name) continue;
          const key = name.toLowerCase();
          if (seenLoc.has(key)) continue;
          seenLoc.add(key);
          locations.push(name);
        }
      } catch (_) { /* notes unreadable → skip locations */ }
      if (locations.length) {
        const shown = locations.slice(0, 12);
        const extra = locations.length - shown.length;
        lines.push(`Visible Locations: ${shown.join(", ")}${extra > 0 ? `, +${extra} more` : ""}`);
      }

      // --- Notable tokens: placed tokens, EXCLUDING hidden (GM-only) ones.
      const tokenNames = [];
      const seenTok = new Set();
      try {
        const tokens = scene.tokens ? Array.from(scene.tokens) : [];
        for (const tok of tokens) {
          if (!tok) continue;
          if (tok.hidden) continue; // never expose hidden tokens to the AI
          const nm = String(tok.name ?? "").trim();
          if (!nm) continue;
          const key = nm.toLowerCase();
          if (seenTok.has(key)) continue;
          seenTok.add(key);
          tokenNames.push(nm);
        }
      } catch (_) { /* tokens unreadable → skip tokens */ }
      if (tokenNames.length) {
        const shown = tokenNames.slice(0, 12);
        const extra = tokenNames.length - shown.length;
        lines.push(`Notable Tokens: ${shown.join(", ")}${extra > 0 ? `, +${extra} more` : ""}`);
      }

      // Only the scene name and nothing else is still worth surfacing.
      return lines.join("\n");
    } catch (e) {
      console.warn(LOG_PREFIX, "_gatherSceneContext: scene read failed", e);
      return "";
    }
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
   * Extract MULTIPLE [[MOVE: Name | Stat | reason]] directives (used for
   * post-roll follow-up suggestions, where the Skald proposes two moves).
   *
   * Every suggestion is validated against the REAL move catalogue via
   * {@link IronswornController._resolveMove}; any move the AI invented (one
   * that does not exist in the system) is silently dropped, so a fabricated
   * "move" can never reach the player as a rollable suggestion. Duplicates
   * are removed and the canonical move name from the catalogue is used.
   *
   * @param {string} text
   * @param {{max?: number}} [opts]
   * @returns {{ suggestions: Array<{name,stat,reason}>, clean: string }}
   */
  parseMoveSuggestions(text, { max = 2 } = {}) {
    if (typeof text !== "string") return { suggestions: [], clean: "" };
    const re = /\[\[\s*MOVE\s*:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*(?:\|\s*([^\]]*?))?\s*\]\]/gi;
    const suggestions = [];
    const seen = new Set();
    let m;
    while ((m = re.exec(text)) !== null) {
      const rawName = (m[1] || "").trim();
      let stat = (m[2] || "").trim().toLowerCase();
      if (stat === "—" || stat === "-" || stat === "none" || stat === "n/a") stat = "";
      const reason = (m[3] || "").trim();
      // Validate against the real catalogue — DROP invented/unknown moves.
      const resolved = IronswornController._resolveMove?.(rawName);
      if (!resolved?.name) continue;
      const key = resolved.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // Use the canonical catalogue name so buttons/labels are always real.
      suggestions.push({ name: resolved.name, stat, reason });
      if (suggestions.length >= max) break;
    }
    // Strip ALL move directives from the display copy.
    const clean = text.replace(/\[\[\s*MOVE\s*:[^\]]*?\]\]/gi, "").trim();
    return { suggestions, clean };
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

    // ---- v0.10.27 — explicit progress-track WRITE directives ----
    // A second, deliberately distinct syntax the AI uses to drive precise
    // track writes when it KNOWS the exact track:
    //   [[MARK_COMPLETE:vow:The Truth of the Star-Fall]]
    //   [[MARK_COMPLETE:combat:Bog Rot]]
    //   [[MARK_COMPLETE:journey:The Long Road North]]
    //   [[ADD_PROGRESS:vow:The Truth of the Star-Fall:2]]   (add 2 boxes)
    //   [[SET_PROGRESS:vow:The Truth of the Star-Fall:8]]   (set to 8 boxes)
    // Colon-separated and verb-led (no "EFFECT:" prefix) so it never collides
    // with the established [[EFFECT: ...]] grammar above.
    const wr = /\[\[\s*(MARK_COMPLETE|ADD_PROGRESS|SET_PROGRESS)\s*:\s*([^\]]+?)\s*\]\]/gi;
    let w;
    while ((w = wr.exec(text)) !== null) {
      const parsed = this._parseWriteDirective(w[1], w[2]);
      if (parsed) effects.push(parsed);
    }
    clean = clean.replace(wr, "").trim();

    return { effects, clean };
  },

  /**
   * Parse a v0.10.27 progress-track write directive body. `verb` is one of
   * MARK_COMPLETE / ADD_PROGRESS / SET_PROGRESS; `body` is the colon-delimited
   * tail "<kind>:<Name>[:<number>]". Returns a normalized effect object or null
   * when malformed. Track KIND is validated to vow|journey|combat|bond.
   */
  _parseWriteDirective(verb, body) {
    const V = String(verb || "").toUpperCase();
    const parts = String(body || "").split(":").map(s => s.trim());
    if (parts.length < 2) return null;
    const kind = parts[0].toLowerCase();
    if (!["vow", "journey", "combat", "bond"].includes(kind)) return null;

    if (V === "MARK_COMPLETE") {
      // [[MARK_COMPLETE:kind:Name]] — Name may itself contain colons.
      const name = parts.slice(1).join(":").trim();
      if (!name) return null;
      return { kind: "mark_complete", trackKind: kind, name };
    }
    // ADD_PROGRESS / SET_PROGRESS need a trailing integer box count.
    if (parts.length < 3) return null;
    const numTok = parts[parts.length - 1];
    const num = parseInt(numTok, 10);
    if (!Number.isFinite(num)) return null;
    const name = parts.slice(1, parts.length - 1).join(":").trim();
    if (!name) return null;
    if (V === "ADD_PROGRESS") return { kind: "add_progress", trackKind: kind, name, boxes: num };
    if (V === "SET_PROGRESS") return { kind: "set_progress", trackKind: kind, name, boxes: num };
    return null;
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

    // ---- Impact / condition toggles (v0.10.36 — Phase 2) ----
    // [[EFFECT: toggle_impact <type>]]        — flip a condition on/off
    // [[EFFECT: set_impact <type> <on|off>]]  — set explicitly
    // [[EFFECT: clear_impact <type>]]         — clear a condition
    // <type> may be loose ("wounded", "permanently harmed", "in debt") —
    // the controller canonicalizes it. Multi-word types are supported.
    if (firstWord === "toggle_impact" || lc.startsWith("toggle impact")) {
      const rest = body.replace(/^toggle[_\s]impact/i, "").trim();
      return rest ? { kind: "toggle_impact", impact: rest } : null;
    }
    if (firstWord === "clear_impact" || lc.startsWith("clear impact")) {
      const rest = body.replace(/^clear[_\s]impact/i, "").trim();
      return rest ? { kind: "set_impact", impact: rest, on: false } : null;
    }
    if (firstWord === "set_impact" || lc.startsWith("set impact")) {
      const rest = body.replace(/^set[_\s]impact/i, "").trim();
      // Trailing on/off|true/false|clear toggles the desired state; default ON.
      const tm = rest.match(/\b(on|off|true|false|set|clear|add|remove)\s*$/i);
      let on = true;
      let name = rest;
      if (tm) {
        const word = tm[1].toLowerCase();
        on = ["on", "true", "set", "add"].includes(word);
        name = rest.slice(0, tm.index).trim();
      }
      return name ? { kind: "set_impact", impact: name, on } : null;
    }

    // ---- Base-stat set (v0.10.36 — Phase 2) ----
    // [[EFFECT: set_stat <edge|heart|iron|shadow|wits> <0-5>]]
    if (firstWord === "set_stat" || lc.startsWith("set stat")) {
      const rest = body.replace(/^set[_\s]stat/i, "").trim();
      const sm = rest.match(/^([a-z]+)\D*([0-9]+)/i);
      if (!sm) return null;
      const stat = sm[1].toLowerCase();
      const value = parseInt(sm[2], 10);
      if (!Number.isFinite(value)) return null;
      return { kind: "set_stat", stat, value };
    }

    // ---- Compendium creation (v0.10.37 — Phase 3) ----
    // [[EFFECT: add_asset <Asset Name>]]            — add an asset to the PC
    // [[EFFECT: add_item <Item Name>]]              — add any compendium item
    // [[EFFECT: create_foe <Name> [rank] [unique]]] — spawn a foe actor
    // [[EFFECT: create_character <Name>]]           — create a blank PC
    // Names may be quoted; ranks use the canonical rank words. A trailing
    // `unique`/`boss`/`narrative`/`custom` keyword on create_foe flags a
    // bespoke (non-compendium) antagonist so the custom-fallback is expected.
    if (firstWord === "add_asset" || lc.startsWith("add asset")) {
      const rest = body.replace(/^add[_\s]asset/i, "").trim();
      const name = this._unquote(rest);
      return name ? { kind: "add_asset", name } : null;
    }
    if (firstWord === "add_item" || lc.startsWith("add item")) {
      const rest = body.replace(/^add[_\s]item/i, "").trim();
      const name = this._unquote(rest);
      return name ? { kind: "add_item", name } : null;
    }
    if (firstWord === "create_foe" || lc.startsWith("create foe") ||
        firstWord === "spawn_foe"  || lc.startsWith("spawn foe")) {
      let rest = body.replace(/^(create|spawn)[_\s]foe/i, "").trim();
      let important = false;
      const mk = rest.match(/[\s(\[]+(unique|boss|narrative|custom)\)?\]?\s*$/i);
      if (mk) { important = true; rest = rest.slice(0, mk.index).trim(); }
      // Quoted name keeps any spaces intact; otherwise split off a trailing rank.
      const q = rest.match(/^["'“”]([^"'“”]+)["'“”]\s*(.*)$/);
      let name, rank = null;
      if (q) {
        name = q[1].trim();
        const tok = (q[2] || "").trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") || "";
        rank = this._RANKS.includes(tok) ? tok : null;
      } else {
        ({ name, rank } = this._splitNameRank(rest));
      }
      return name ? { kind: "create_foe", name, rank, important } : null;
    }
    if (firstWord === "create_character" || lc.startsWith("create character") ||
        firstWord === "create_pc" || lc.startsWith("create pc")) {
      const rest = body.replace(/^create[_\s](character|pc)/i, "").trim();
      const name = this._unquote(rest);
      return name ? { kind: "create_character", name } : null;
    }

    // "progress <Track Name> <+N | rank>" and its by-title alias
    // "mark_progress <Track Title> [+N | rank]" / 'mark_progress "Track Title"'.
    // mark_progress is meant for advancing a NAMED vow/journey from the
    // narrative (no dice roll), so when it carries no explicit tick count it
    // defaults to marking by the track's rank.
    const isMarkProgress = firstWord === "mark_progress" || lc.startsWith("mark progress ") || lc === "mark progress";
    if (firstWord === "progress" || isMarkProgress) {
      let rest;
      if (firstWord === "progress")            rest = body.slice(8).trim();
      else if (firstWord === "mark_progress")  rest = body.slice(13).trim();
      else                                     rest = body.replace(/^mark\s+progress/i, "").trim();

      let name, value = 4, byRank = false;
      // A quoted title — 'mark_progress "The Truth of the Star-Fall" +8' or
      // just 'mark_progress "The Long Road North"' — is the clearest form.
      const quoted = rest.match(/^["'“”]([^"'“”]+)["'“”]\s*(.*)$/);
      if (quoted) {
        name = quoted[1].trim();
        const tail = (quoted[2] || "").trim();
        const tm = tail.match(/([+-]?\d+)/);
        if (/\brank\b/i.test(tail)) byRank = true;
        else if (tm) value = parseInt(tm[1], 10);
        else byRank = true;                 // bare quoted title → by rank
      } else {
        const tickMatch = rest.match(/([+-]?\d+)\s*(?:ticks?)?\s*$/i);
        const rankMatch = /\brank\b\s*$/i.test(rest);
        name = rest;
        if (rankMatch)      { byRank = true; name = rest.replace(/\brank\b\s*$/i, "").trim(); }
        else if (tickMatch) { value = parseInt(tickMatch[1], 10); name = rest.slice(0, tickMatch.index).trim(); }
        else if (isMarkProgress) { byRank = true; }   // unquoted mark_progress, no ticks → by rank
      }
      name = name.replace(/^on\s+/i, "").replace(/[:\-—]+$/, "").trim();
      if (!name) return null;
      return { kind: "progress", track: name, value, byRank };
    }
    if (firstWord === "oracle") {
      const name = body.slice(6).trim();
      return name ? { kind: "oracle", name } : null;
    }

    // ---- Experience awards (v0.10.32 — Phase 1) ----
    // [[EFFECT: grant_xp <amount> <reason...>]]  — award N experience for a
    //   discretionary milestone (the reason is free text, optional).
    // [[EFFECT: grant_xp_vow <rank>]]            — award the rank's XP for a
    //   fulfilled vow (troublesome 1 … epic 5). The rank is optional; when
    //   omitted the active/just-rolled vow's own rank is used.
    if (firstWord === "grant_xp_vow" || lc.startsWith("grant_xp_vow") || lc.startsWith("grant xp vow")) {
      const rest = body.replace(/^grant[_\s]xp[_\s]vow/i, "").trim();
      const tok = rest.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") || "";
      const rank = this._RANKS.includes(tok) ? tok : null;
      return { kind: "grant_xp_vow", rank };
    }
    if (firstWord === "grant_xp" || lc.startsWith("grant_xp") || lc.startsWith("grant xp")) {
      const rest = body.replace(/^grant[_\s]xp/i, "").trim();
      const m2 = rest.match(/^([+]?\d+)\s*(.*)$/);
      if (!m2) return null;
      const amount = parseInt(m2[1], 10);
      if (!Number.isFinite(amount) || amount <= 0) return null;
      const reason = (m2[2] || "").replace(/^[:\-—|]+/, "").trim();
      return { kind: "grant_xp", amount, reason };
    }

    // ---- Combat / quest track directives (v0.3.0) ----
    // Accept underscores or spaces: "create_combat" or "create combat".
    const m = body.match(/^(create[_\s]combat|create[_\s]vow|create[_\s]journey|begin[_\s]journey|start[_\s]journey|undertake[_\s]journey|initiative|end[_\s]combat|complete[_\s]vow|fulfill[_\s]vow|end[_\s]vow|complete[_\s]track|complete[_\s]journey|end[_\s]journey)\b\s*(.*)$/i);
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
        // An IMPORTANT narrative foe (boss / unique antagonist not in the
        // official compendia) is flagged with a trailing keyword — `unique`,
        // `boss`, `narrative`, or `custom`. Strip it off before splitting so
        // the marker never leaks into the foe name, and record `important` so
        // the optional "not a real compendium foe" advisory is suppressed.
        let body2 = rest;
        let important = false;
        const mk = body2.match(/[\s(\[]+(unique|boss|narrative|custom)\)?\]?\s*$/i);
        if (mk) {
          important = true;
          body2 = body2.slice(0, mk.index).trim();
        }
        const { name, rank } = this._splitNameRank(body2);
        return name ? { kind: "create_combat", name, rank, important } : null;
      }

      if (verb === "create_vow") {
        const { name, rank, desc } = this._splitNameRank(rest);
        return name ? { kind: "create_vow", name, rank, description: desc } : null;
      }

      // Begin a journey progress track (the journey counterpart of create_vow).
      if (/^(create_journey|begin_journey|start_journey|undertake_journey)$/.test(verb)) {
        const { name, rank, desc } = this._splitNameRank(rest);
        return name ? { kind: "create_journey", name, rank, description: desc } : null;
      }

      if (verb === "end_combat") {
        const { name } = this._splitNameRank(rest);
        return name ? { kind: "end_combat", name } : null;
      }

      // Mark a vow / journey / progress track COMPLETE. All of these verbs
      // (complete_vow, fulfill_vow, end_vow, complete_track, complete_journey,
      // end_journey) collapse to one "complete_track" effect — completion is
      // the same operation regardless of the track's kind. We DO preserve the
      // implied kind (vow / journey) as `trackKind` so the completion path can
      // pick the right open track when the AI names it after the move (e.g.
      // "Fulfill Your Vow") or omits the name entirely. The name is optional:
      // an empty name lets the completion path fall back to the track the last
      // progress move actually rolled against (or the newest open track of the
      // implied kind), rather than dropping the directive.
      if (/^(complete_vow|fulfill_vow|end_vow|complete_track|complete_journey|end_journey)$/.test(verb)) {
        const { name } = this._splitNameRank(rest);
        const trackKind = /vow/.test(verb) ? "vow"
                        : /journey/.test(verb) ? "journey"
                        : null;
        return { kind: "complete_track", name: name || "", trackKind };
      }
    }
    return null;
  },

  /** Ironsworn rank words, used to split "Name <rank> [description]". */
  _RANKS: ["troublesome", "dangerous", "formidable", "extreme", "epic"],

  /**
   * Strip surrounding quotes and trailing punctuation from a directive tail,
   * yielding a clean entity name. Returns "" for empty/whitespace input.
   */
  _unquote(rest) {
    if (!rest) return "";
    let s = String(rest).trim();
    const q = s.match(/^["'“”]([^"'“”]+)["'“”]\s*$/);
    if (q) s = q[1];
    return s.replace(/^[:\-—|]+/, "").replace(/[:\-—|]+$/, "").trim();
  },

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
   * Post the Skald's reply for the buffered (non-streaming) path. The
   * narration is displayed with any stray [[MOVE:…]] / metadata directive
   * stripped; suggested moves are NOT surfaced as a separate card — they are
   * woven into the prose itself and auto-linked inline by {@link EntityLinker}
   * (v0.10.10). We still parse the reply to capture the move's reason for the
   * next outcome narration's intent line.
   */
  async postReplyWithSuggestion(reply, { variant = "default", title } = {}) {
    const { suggestion, clean } = this.parseMoveSuggestion(reply);
    // (v0.10.10) Suggested moves are woven into the narration prose and
    // auto-linked inline by EntityLinker (clicking rolls them through the
    // progress-aware triggerMove path) — we no longer post a separate
    // "A Move Beckons" suggestion card. Any stray [[MOVE:…]] directive the
    // model still emits is stripped from the display by stripDirectivesForDisplay.
    await Chat.postSkald(formatMarkdown(stripDirectivesForDisplay(clean || reply)), { variant, title });
    // Capture the move's reason (if any) so the next outcome narration can
    // reference the player's intent, without surfacing a card.
    if (suggestion?.reason) this._lastIntent = suggestion.reason;
    return { suggestion, clean };
  },

  /**
   * Streaming-path counterpart of {@link postReplyWithSuggestion}. The
   * narration has already been rendered live (with directives stripped), and
   * any suggested move is woven into that prose and auto-linked inline by
   * {@link EntityLinker} — so there is NO separate suggestion card to post
   * (v0.10.10). We only parse the full raw reply to capture the move's reason
   * for the next outcome narration's intent line.
   */
  async postSuggestionFromReply(reply) {
    const { suggestion } = this.parseMoveSuggestion(reply);
    if (suggestion?.reason) this._lastIntent = suggestion.reason;
    return suggestion;
  },

  // (v0.10.10) The separate move-suggestion cards — the old pre-roll and
  // post-roll standalone suggestion-card lines that used to be posted as
  // their own chat messages — have been removed entirely. Move suggestions
  // are now woven directly into the
  // Skald's narration prose (see the prompt blocks in
  // buildIronswornPromptBlock) and auto-linked inline by EntityLinker, which
  // renders each move name as a clickable link that rolls through the
  // progress-aware IronswornController.triggerMove path (see the "link-move"
  // case in wireSuggestionCard). No standalone suggestion card is posted.

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
        const moveDsId = btn.dataset.moveDsid;
        const stat = btn.dataset.stat;
        const oracle = btn.dataset.oracle;
        const track = btn.dataset.track;
        const asset = btn.dataset.asset;
        const assetUuid = btn.dataset.assetUuid;
        try {
          if (action === "roll-move") {
            await this.doTriggerMove(move, stat);
          } else if (action === "choose-move") {
            await this.showMoveSelector(stat);
          } else if (action === "link-oracle") {
            // An inline oracle link in narration — roll it and let the Skald
            // interpret the result (the same pipeline as the !oracle command).
            await this.doRollOracleLink(oracle);
          } else if (action === "link-track") {
            // An inline progress-track link — show its status and offer to
            // mark progress by rank.
            await this.showProgressTrackCard(track);
          } else if (action === "mark-track") {
            // The "Mark Progress" button on a progress-track card.
            await this.doMarkTrack(track);
          } else if (action === "complete-track") {
            // The "Mark Complete / Fulfill Vow" button on a progress-track card.
            await this.doCompleteTrack(track);
          } else if (action === "link-asset") {
            // An inline asset link — open the asset's card from the compendium.
            await this.showAssetLink(assetUuid || asset);
          } else if (action === "link-move") {
            // An inline move link in narration — roll it through the
            // progress-aware triggerMove path (v0.10.8). For ordinary moves
            // this opens the system's own official pre-roll dialog (resolved
            // via the Datasworn ID), exactly as before; for PROGRESS moves
            // ("Reach Your Destination" / "Fulfill Your Vow") it rolls the
            // matching track's progress score instead of dead-ending in the
            // generic dialog (which has no stat and no track context). Degrade
            // gracefully with a GM-visible note when the roll can't be made.
            if (!this.active()) {
              ui.notifications?.info(`${SKALD_NAME}: ${move} — Ironsworn system not active.`);
            } else {
              const ref = moveDsId || move;
              const actor = IronswornController.getActiveCharacter();
              const res = await IronswornController.triggerMove(ref, { actor, stat });
              if (res?.ok && res.method === "milestone") {
                // Milestone has no roll card — narrate it directly. triggerMove
                // ALREADY marked progress on the vow, so pass mechanicsApplied
                // to stop _narrateOutcome from marking it a SECOND time.
                try {
                  const fp = { moveName: "Reach a Milestone", outcome: "Progress Marked", score: null, challenge: [], match: false, resolved: true };
                  const summary = res.track ? `marked progress on vow "${res.track}" (now ${res.boxes ?? "?"}/10 boxes)` : "";
                  setTimeout(() => this._narrateOutcome(null, fp, { mechanicsApplied: true, autoSummary: summary })
                    .catch(e => console.warn(LOG_PREFIX, "milestone narration failed", e)), this._narrationDelayMs());
                } catch (_) {}
              } else if (!res?.ok) {
                await Chat.postSystem(
                  `<strong>The dice would not answer:</strong> ${escapeHtml(res?.error ?? "unknown error")}`,
                  { gmWhisper: true }
                );
              }
            }
          }
        } catch (e) {
          console.error(LOG_PREFIX, "suggestion button failed", e);
          ui.notifications?.error(`${SKALD_NAME}: ${e?.message ?? e}`);
        }
      });
    }
  },

  /* ---------------- Intelligent action → move mapping (v0.10.34) ---------------- */

  /**
   * Interpret a free-form player ACTION ("I explore the cave further") and, if it
   * clearly triggers an Ironsworn move, open that move's roll dialog (or a
   * confirmation card for ambiguous / less-certain cases) INSTEAD of narrating.
   * Questions and pure roleplay fall through to narration.
   *
   * This is the AI half of the hybrid classifier: the deterministic
   * `detectMoveDeclaration` (explicit move names) already ran and missed, so we
   * ask the model to classify the message. The PROMPT, PARSE and ROUTING logic
   * are all pure functions on IronswornController (unit-tested); this method only
   * owns the Foundry/AI side: the `Client.chat` call and the resulting UI action.
   *
   * Fully defensive: any failure (no API key, malformed reply, offline) is caught
   * and reported as "not handled" so the caller falls back to ordinary narration.
   *
   * @param {string} text  The player's free-form message (after "!").
   * @returns {Promise<{handled: boolean}>}  handled=true when a dialog/card was
   *   shown and narration must be suppressed; false to narrate as normal.
   */
  async classifyAndRouteAction(text) {
    if (!this.active()) return { handled: false };
    if (!text || typeof text !== "string" || !text.trim()) return { handled: false };
    try {
      // A light scene hint helps disambiguate combat-state-dependent actions
      // (e.g. "I attack" → Enter the Fray vs Strike vs Clash). Cheap & optional.
      let sceneContext = "";
      try {
        if (game.combat?.started) sceneContext = "The party is currently in active combat.";
      } catch (_) { /* defensive */ }

      const { system, user } = IronswornController.buildActionClassifierPrompt(text, { sceneContext });
      const messages = [
        { role: "system", content: system },
        { role: "user", content: user }
      ];
      // Low temperature + small budget → fast, deterministic classification.
      const reply = await Client.chat(messages, { temperature: 0.2, maxTokens: 250 });
      const parsed = IronswornController.parseActionClassification(reply);
      const alwaysConfirm = !!Settings.get("intelligentMoveConfirm");
      const decision = IronswornController.decideActionRouting(parsed, { alwaysConfirm });

      console.log(`${LOG_PREFIX} [skald] action classify → type=${parsed?.type ?? "?"} decision=${decision.action}${decision.move ? ` move="${decision.move.name}"` : ""}${decision.candidates ? ` candidates=${decision.candidates.map(c => c.name).join("|")}` : ""}`);

      if (decision.action === "roll" && decision.move?.name) {
        // Record the player's actual words as intent so the post-roll narration
        // can reference what they were trying to do.
        this._lastIntent = text.trim();
        await this.doTriggerMove(decision.move.name, decision.stat || undefined);
        return { handled: true };
      }

      if (decision.action === "confirm" && Array.isArray(decision.candidates) && decision.candidates.length) {
        this._lastIntent = text.trim();
        await this._postActionConfirmCard(decision.candidates, { reason: decision.reason, original: text.trim() });
        return { handled: true };
      }

      // "narrate" → let the caller run normal AI narration.
      return { handled: false };
    } catch (e) {
      console.warn(LOG_PREFIX, "[skald] action classification failed — falling back to narration", e);
      return { handled: false };
    }
  },

  /**
   * Post an interactive confirmation card offering one or more candidate moves
   * for an interpreted action. Each button reuses the existing
   * `data-skald-action="link-move"` wiring (auto-wired on render by
   * {@link Integration.wireSuggestionCard}), so clicking opens that move's
   * official pre-roll dialog. The player may also simply ignore the card and
   * keep narrating. No narration is generated until a move actually resolves.
   *
   * @param {Array<{move:object,name:string,stat:string,confidence:string}>} candidates
   * @param {object} [opts]
   * @param {string} [opts.reason]    Short rationale from the classifier.
   * @param {string} [opts.original]  The player's original message (for context).
   */
  async _postActionConfirmCard(candidates, { reason = "", original = "" } = {}) {
    const buttons = candidates.map((c) => {
      const dsid = c.move?.id ? ` data-move-dsid="${escapeHtml(c.move.id)}"` : "";
      const stat = c.stat ? ` data-stat="${escapeHtml(c.stat)}"` : "";
      const label = `${escapeHtml(c.name)}${c.stat ? ` +${escapeHtml(c.stat)}` : ""}`;
      return `<button type="button" class="es-action-move-btn" data-skald-action="link-move" data-move="${escapeHtml(c.name)}"${dsid}${stat}>${label}</button>`;
    }).join("");

    const ambiguous = candidates.length > 1;
    const lead = ambiguous
      ? "That action could call for more than one move. Which do you intend?"
      : "It sounds like this calls for a move. Roll it?";
    const tail = "<p class=\"es-action-confirm-note\"><em>Or simply keep narrating — no roll will be made unless you choose a move.</em></p>";
    const why = reason ? `<p class="es-action-confirm-why"><em>${escapeHtml(reason)}</em></p>` : "";

    const body =
      `<p>${lead}</p>` +
      why +
      `<div class="es-action-move-choices">${buttons}</div>` +
      tail;

    return Chat.postSkald(body, { variant: "oracle", title: ambiguous ? "Which Move?" : "Make a Move?" });
  },

  /* ---------------- Move triggering & selector ---------------- */

  /**
   * Trigger a move through the Ironsworn controller (or manual fallback).
   *
   * @param {string}  moveName        The official move name.
   * @param {string}  [stat]          Optional stat for the manual fallback.
   * @param {object}  [opts]
   * @param {string}  [opts.rawIntent]  The player's ORIGINAL words for this
   *        action (e.g. "Undertake a Journey to Ironhome"). When a move is
   *        declared explicitly we used to pass only the move name + stat, which
   *        discarded any destination the player named — so journey auto-naming
   *        always fell back to a generic title (the "all journeys are 'The
   *        Journey'" bug). Passing the raw words here lets _resolveJourney()
   *        recover the destination. (v0.11.3 — journey naming Layer 0.)
   */
  async doTriggerMove(moveName, stat, opts = {}) {
    if (!this.active()) {
      ui.notifications?.warn(`${SKALD_NAME}: Ironsworn system not active — cannot roll moves.`);
      return null;
    }
    // Build the intent string the post-roll narration + journey naming read.
    // When the caller supplied the player's raw words (opts.rawIntent), use
    // them as the authoritative intent (they carry the destination) rather than
    // prepending to a possibly-stale prior intent. Otherwise keep the legacy
    // behaviour of decorating whatever intent the action path already recorded.
    const rawIntent = String(opts.rawIntent ?? "").trim();
    const moveTag = `${moveName}${stat ? ` +${stat}` : ""}`;
    this._lastIntent = rawIntent
      ? `${moveTag} — ${rawIntent}`
      : moveTag + (this._lastIntent ? ` — ${this._lastIntent}` : "");
    const actor = IronswornController.getActiveCharacter();
    // (v0.10.38 — Phase 4) Asset bonus advisory: a non-blocking suggestion if
    // one of the character's assets grants a bonus that plausibly applies to
    // this move. Purely informational — the player applies it in the dialog.
    try { await this._maybeAdviseAssetBonuses(actor, moveName, stat); }
    catch (e) { console.warn(LOG_PREFIX, "asset bonus advisory failed", e); }
    const res = await IronswornController.triggerMove(moveName, { actor, stat });
    if (!res?.ok) {
      await Chat.postSystem(
        `<strong>The dice would not answer:</strong> ${escapeHtml(res?.error ?? "unknown error")}`,
        { gmWhisper: true }
      );
    }
    // "Reach a Milestone" produces no roll card, so onIronswornRoll won't
    // fire. Narrate it directly here so the Skald acknowledges the milestone.
    if (res?.ok && res.method === "milestone") {
      // triggerMove already marked progress; tell _narrateOutcome the
      // mechanics are applied so it does NOT mark the vow a second time.
      const summary = res.track ? `marked progress on vow "${res.track}" (now ${res.boxes ?? "?"}/10 boxes)` : "";
      const milestoneDelayed = async () => {
        try {
          const fakeParsed = { moveName: "Reach a Milestone", outcome: "Progress Marked", score: null, challenge: [], match: false, resolved: true };
          await this._narrateOutcome(null, fakeParsed, { mechanicsApplied: true, autoSummary: summary });
        } catch (e) { console.warn(LOG_PREFIX, "milestone narration failed", e); }
      };
      setTimeout(milestoneDelayed, this._narrationDelayMs());
      return res;
    }
    // The resulting Ironsworn roll card (or manual card) is picked up by
    // onIronswornRoll(), which narrates the outcome.
    return res;
  },

  /**
   * (v0.10.38 — Phase 4) Asset Bonus Advisory.
   *
   * Before a move resolves, scan the active character's enabled asset
   * abilities for a roll bonus that plausibly applies to this move and, if
   * found, post a small non-blocking chat suggestion. The player chooses
   * whether to apply it in the official roll dialog — the Skald never
   * touches the roll itself, preserving full player agency and roll-system
   * stability. Fully gated by the `assetBonusAdvisory` setting (default ON).
   *
   * @param {Actor|null} actor      the rolling character (may be null)
   * @param {string}     moveName   the move being made
   * @param {string}     [stat]     the stat being rolled (optional)
   */
  async _maybeAdviseAssetBonuses(actor, moveName, stat) {
    try {
      if (!Settings.get("assetBonusAdvisory")) return;
    } catch (_) { return; }
    if (!actor || !moveName) return;
    let assets;
    try { assets = IronswornController.getAssets(actor); }
    catch (_) { return; }
    const hits = IronswornController.detectAssetBonuses(assets, moveName, { stat: stat || "" });
    if (!Array.isArray(hits) || !hits.length) return;
    const items = hits.map((h) => {
      const cond = h.condition
        ? ` — <em>${escapeHtml(h.condition)}</em>`
        : "";
      return `<li>💡 Your <strong>${escapeHtml(h.asset)}</strong> grants <strong>+${h.bonus}</strong>${cond}</li>`;
    }).join("");
    const body =
      `<p>You may have an asset bonus for <strong>${escapeHtml(moveName)}</strong>:</p>` +
      `<ul class="es-asset-advisory">${items}</ul>` +
      `<p class="es-action-confirm-note"><em>If it applies, add it yourself in the roll dialog — your call.</em></p>`;
    try { await Chat.postSkald(body, { variant: "oracle", title: "Asset Bonus?" }); }
    catch (e) { console.warn(LOG_PREFIX, "asset advisory post failed", e); }
  },

  /* ---------------- Inline entity-link handlers (v0.7.0) ---------------- */

  /**
   * Handle a click on an inline oracle link: roll the oracle through the
   * shared {@link OracleInterpreter} so the result is posted and narrated
   * exactly like the `!oracle` command. Degrades gracefully.
   */
  async doRollOracleLink(alias) {
    try {
      if (typeof OracleInterpreter === "undefined" || typeof OracleInterpreter.roll !== "function") {
        ui.notifications?.info(`${SKALD_NAME}: oracle roller unavailable.`);
        return;
      }
      await OracleInterpreter.roll(alias);
    } catch (e) {
      console.error(LOG_PREFIX, "oracle link failed", e);
      ui.notifications?.error(`${SKALD_NAME}: ${e?.message ?? e}`);
    }
  },

  /**
   * Handle a click on an inline progress-track link: post a compact card
   * showing the track's current boxes/rank, with a button to mark progress
   * by its rank. Degrades gracefully when the system/actor is unavailable.
   */
  async showProgressTrackCard(trackName) {
    try {
      if (!this.active()) {
        ui.notifications?.info(`${SKALD_NAME}: ${trackName} — Ironsworn system not active.`);
        return;
      }
      const actor = IronswornController.getActiveCharacter();
      if (!actor) {
        ui.notifications?.warn(`${SKALD_NAME}: no active character to read "${trackName}".`);
        return;
      }
      // Resolve the ACTUAL sheet Item this reference points at — read straight
      // from actor.items (the single source of truth), never a cached/parallel
      // copy. A generic word like "vow" resolves to the character's real
      // current vow (e.g. "The Truth of the Star-Fall") instead of matching a
      // phantom literally-named track. We then read the track's live state from
      // the freshly-built progress-track view so boxes/ticks/completion always
      // mirror the sheet.
      const item = IronswornController.resolveDisplayTrack(actor, trackName);
      if (!item) {
        ui.notifications?.info(`${SKALD_NAME}: progress track "${trackName}" not found on ${actor.name}.`);
        return;
      }
      const tracks = IronswornController.getProgressTracks(actor) ?? [];
      const track = tracks.find(t => t.id === item.id);
      if (!track) {
        ui.notifications?.info(`${SKALD_NAME}: progress track "${trackName}" not found on ${actor.name}.`);
        return;
      }

      const boxes = typeof track.boxes === "number" ? track.boxes : Math.floor((track.current ?? 0) / 4);
      const rank = track.rank ? `<span class="es-track-rank">${escapeHtml(String(track.rank))}</span>` : "";
      const done = track.completed ? " ✓" : "";
      // Classify the track so we can flavour the labels. A track is a vow or a
      // journey if EITHER the system subtype/type says so OR our own trackKind
      // flag (set when the Skald created it) says so — the latter catches
      // journeys the system stores as a generic "progress" track.
      const klass   = String(track.kind || track.subtype || track.type || "").toLowerCase();
      const isVow     = klass === "vow";
      const isJourney = klass === "journey";
      const noun = isVow ? "vow" : isJourney ? "journey" : "track";
      const completeLabel = isVow     ? "Fulfill Vow (mark complete)"
                          : isJourney ? "Reach Destination (mark complete)"
                          :             "Mark Complete";

      // Action buttons: marking progress is always available; "Mark Complete"
      // is offered only while the track is still open. A completed track shows
      // a static note instead so the player has clear feedback.
      const buttons = track.completed
        ? `<p class="es-track-complete-note"><em>✓ This ${noun} is complete.</em></p>`
        : `
          <div class="es-move-buttons">
            <button type="button" class="es-btn es-btn-roll"
                    data-skald-action="mark-track"
                    data-track="${escapeHtml(track.name)}">▰ Mark Progress (by rank)</button>
            <button type="button" class="es-btn es-btn-complete"
                    data-skald-action="complete-track"
                    data-track="${escapeHtml(track.name)}">✓ ${escapeHtml(completeLabel)}</button>
          </div>`;

      const body = `
        <div class="es-track-card">
          <p class="es-track-name"><strong>${escapeHtml(track.name)}</strong>${done} ${rank}</p>
          <p class="es-track-progress">Progress: <strong>${boxes}/10</strong> boxes
             <span class="es-track-ticks">(${track.current ?? 0}/40 ticks)</span></p>
          ${buttons}
        </div>`;
      const cardTitle = isVow ? "Vow" : isJourney ? "Journey" : "Progress Track";
      await Chat.postSkald(body, { variant: "suggest", title: cardTitle });
    } catch (e) {
      console.error(LOG_PREFIX, "progress-track link failed", e);
      ui.notifications?.error(`${SKALD_NAME}: ${e?.message ?? e}`);
    }
  },

  /** Mark progress on a track by its rank (wired from the track card). */
  async doMarkTrack(trackName) {
    try {
      if (!this.active()) return;
      const actor = IronswornController.getActiveCharacter();
      if (!actor) {
        ui.notifications?.warn(`${SKALD_NAME}: no active character to mark "${trackName}".`);
        return;
      }
      const res = await IronswornController.markProgressByRank(actor, trackName, 1);
      if (res?.ok) {
        ui.notifications?.info(`${SKALD_NAME}: marked progress on ${res.track} — ${res.boxes}/10 boxes.`);
      } else {
        ui.notifications?.warn(`${SKALD_NAME}: ${res?.error ?? "could not mark progress."}`);
      }
    } catch (e) {
      console.error(LOG_PREFIX, "mark-track failed", e);
      ui.notifications?.error(`${SKALD_NAME}: ${e?.message ?? e}`);
    }
  },

  /**
   * Mark a progress track (vow / journey / bond / etc.) COMPLETE — wired from
   * the "Mark Complete / Fulfill Vow" button on a progress-track card. This is
   * the manual counterpart to the [[EFFECT: complete_vow …]] directive; both
   * funnel through {@link IronswornController.completeTrack}.
   *
   * Note: Ironsworn lets you fulfill a vow at ANY progress level (the Fulfill
   * Your Vow roll simply gets harder when progress is low), so completion is
   * intentionally NOT gated on a full track — the player decides when the vow
   * is met in the fiction.
   */
  async doCompleteTrack(trackName) {
    try {
      if (!this.active()) {
        ui.notifications?.info(`${SKALD_NAME}: ${trackName} — Ironsworn system not active.`);
        return;
      }
      const actor = IronswornController.getActiveCharacter();
      if (!actor) {
        ui.notifications?.warn(`${SKALD_NAME}: no active character to complete "${trackName}".`);
        return;
      }
      const res = await IronswornController.completeTrack(actor, trackName);
      if (res?.ok) {
        ui.notifications?.info(`${SKALD_NAME}: “${res.name}” marked complete. 🏆`);
        if (Settings.get("showEffectAnnouncements") !== false) {
          await Chat.postSystem(`<em>The Skald enacts: completed “${escapeHtml(res.name)}”.</em>`, { gmWhisper: true });
        }
        // Re-post the (now-completed) track card so the chat reflects the
        // new state and the player gets immediate visual confirmation.
        try { await this.showProgressTrackCard(res.name); } catch (_) {}
      } else {
        ui.notifications?.warn(`${SKALD_NAME}: ${res?.error ?? "could not mark complete."}`);
      }
    } catch (e) {
      console.error(LOG_PREFIX, "complete-track failed", e);
      ui.notifications?.error(`${SKALD_NAME}: ${e?.message ?? e}`);
    }
  },

  /**
   * Handle a click on an inline asset link: open the asset's card (sheet)
   * from the compendium via the controller. Degrades gracefully.
   */
  async showAssetLink(ref) {
    try {
      if (!this.active()) {
        ui.notifications?.info(`${SKALD_NAME}: ${ref} — Ironsworn system not active.`);
        return;
      }
      const res = await IronswornController.showAsset(ref);
      if (!res?.ok) {
        ui.notifications?.info(`${SKALD_NAME}: could not open asset — ${res?.error ?? "not found."}`);
      }
    } catch (e) {
      console.error(LOG_PREFIX, "asset link failed", e);
      ui.notifications?.error(`${SKALD_NAME}: ${e?.message ?? e}`);
    }
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
    const b = Math.max(0, Math.min(10, Number(boxes) || 0));
    try { ui.notifications?.info(`${SKALD_NAME}: progress on ${trackName} — ${b}/10 boxes (${b * 10}%).`); } catch (_) {}
    this._dbg(`notify: progress on ${trackName} → ${b}/10 (${b * 10}%)`);
  },

  /**
   * Console audit log for an AI-driven progress-track WRITE directive
   * (v0.10.27). Records every attempt — success or failure — so a GM can trace
   * exactly what the Skald changed and why. Never throws.
   * @param {string}  verb     "MARK_COMPLETE" | "ADD_PROGRESS" | "SET_PROGRESS"
   * @param {object}  eff      the parsed effect ({trackKind, name, boxes?})
   * @param {boolean} ok       whether the write succeeded
   * @param {string}  [detail] human-readable outcome / error
   */
  _auditWrite(verb, eff, ok, detail = "") {
    try {
      const tag = ok ? "✓" : "✗";
      const box = (eff?.boxes != null) ? `:${eff.boxes}` : "";
      console.log(
        `${LOG_PREFIX} [track-write ${tag}] ${verb} ${eff?.trackKind ?? "?"}:"${eff?.name ?? ""}"${box}`
        + (detail ? ` — ${detail}` : "")
      );
    } catch (_) { /* audit logging must never break a write */ }
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
   * (v0.10.25 — XP tracking) Narrate an experience milestone that the
   * Ironsworn system has ALREADY recorded on the character sheet. This is a
   * purely OBSERVE-ONLY reaction: the diff-watcher hook (see the
   * `updateActor` registration near the bottom of this file) detects that the
   * `system.xp` counter rose, or that a Starforged legacy track advanced, and
   * hands us the pre-computed positive delta. We never compute, write, or
   * spend XP ourselves — that stays entirely under the player's / system's
   * control.
   *
   * Fully defensive: every guard fails safe and the narration is fire-and-
   * forget, so an AI hiccup can never block the sheet update that triggered
   * it.
   *
   * @param {Actor}  actor   the actor whose experience changed.
   * @param {object} info
   * @param {number} [info.xpDelta]    positive change in `system.xp`, if any.
   * @param {number} [info.newXp]      the new total `system.xp`, if known.
   * @param {Array<{name:string,delta:number}>} [info.legacyDeltas]
   *        positive advances on named legacy tracks (Starforged), if any.
   * @returns {Promise<void>}
   */
  async onXpGain(actor, info = {}) {
    try {
      if (!this.active()) return;
      if (!actor) return;
      if ((Settings.get("autoNarrateXp") ?? true) === false) return;

      const parts = [];
      if (typeof info.xpDelta === "number" && info.xpDelta > 0) {
        const total = typeof info.newXp === "number" ? ` (now ${info.newXp} total)` : "";
        parts.push(`earned ${info.xpDelta} experience${total}`);
      }
      if (Array.isArray(info.legacyDeltas)) {
        for (const d of info.legacyDeltas) {
          if (d && typeof d.delta === "number" && d.delta > 0) {
            parts.push(`advanced their ${d.name} legacy by ${d.delta} tick${d.delta === 1 ? "" : "s"}`);
          }
        }
      }
      if (!parts.length) return; // nothing positive to celebrate

      const summary = `${actor.name} has ${parts.join(" and ")}.`;
      const ctx = this.gatherContext();
      const task = `The hero has just gained experience — a moment of growth worth marking.
What happened: ${summary}
Narrate this milestone briefly and evocatively as the Skald (1–3 sentences), framing it as hard-won growth that flows from recent deeds. Do NOT invent specific mechanical rewards, do NOT tell the player how to spend the experience, and do NOT emit any [[EFFECT:…]] or [[MOVE:…]] directives — this is pure narration of growth the rules have already recorded.`;

      const messages = [
        { role: "system", content: buildSystemPrompt({ task, context: ctx, allowEffects: false, allowFollowups: false, allowJournal: true }) }
      ];

      const cardOpts = { variant: "lore", title: "A Milestone of Growth" };
      const streaming = Settings.get("streamingEnabled") !== false;
      let reply;
      if (streaming) {
        ({ reply } = await callSkaldStreaming(messages, { ...cardOpts, chatOpts: { temperature: 0.85, maxTokens: 220 } }));
      } else {
        reply = await Client.chat(messages, { temperature: 0.85, maxTokens: 220 });
        await Chat.postSkald(formatMarkdown(stripDirectivesForDisplay(reply)), cardOpts);
      }
      // Fire-and-forget chronicle ingestion (never blocks/breaks play).
      try { JournalSystem.ingestReply(reply, { channel: "lore" }); } catch (_) { /* defensive */ }
    } catch (e) {
      console.warn(LOG_PREFIX, "onXpGain narration failed", e?.message ?? e);
    }
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

  /**
   * Ask the AI to narrate an outcome and (optionally) apply effects.
   *
   * @param {ChatMessage|null} message  the originating roll card, if any.
   * @param {object} parsed             parsed roll/move facts.
   * @param {object} [opts]
   * @param {boolean} [opts.mechanicsApplied=false] when true, the deterministic
   *        mechanics for this move were ALREADY applied by the caller (e.g.
   *        triggerMove() executed "Reach a Milestone" and marked progress), so
   *        the auto-flows here MUST be skipped to avoid double-applying them.
   * @param {string}  [opts.autoSummary]  a ready-made summary line describing
   *        the mechanics the caller already applied, fed to the narration
   *        prompt so the AI knows what happened (and is told not to re-emit it).
   */
  async _narrateOutcome(message, parsed, opts = {}) {
    const actor = message?.speakerActor ?? IronswornController.getActiveCharacter();
    const allowEffects = Settings.get("aiAppliesEffects") ?? true;

    // 1. Apply the deterministic combat mechanics FIRST (initiative on
    //    Enter the Fray; harm/progress + initiative on Strike/Clash). This
    //    keeps the rules correct regardless of what the AI narrates, and
    //    gives us a factual summary to feed into the narration prompt.
    //
    //    When the caller already applied the mechanics (opts.mechanicsApplied
    //    — e.g. triggerMove() ran "Reach a Milestone" and marked the vow), we
    //    do NOT re-run the auto-flows here: doing so would mark progress a
    //    SECOND time (advancing the track by 2× rank). We reuse the caller's
    //    summary so the AI still narrates the correct, single effect.
    let autoSummary = "";
    if (opts.mechanicsApplied) {
      autoSummary = String(opts.autoSummary ?? "");
    } else if (allowEffects) {
      const autoParts = [];
      try { const c = await this._autoCombatFlow(parsed, actor);  if (c) autoParts.push(c); }
      catch (e) { console.warn(LOG_PREFIX, "_autoCombatFlow failed", e); }
      // Journey side: on "Undertake a Journey" ensure a journey track exists
      // and (on a hit) advance it, so "Reach Your Destination" can later roll.
      try { const j = await this._autoJourneyFlow(parsed, actor); if (j) autoParts.push(j); }
      catch (e) { console.warn(LOG_PREFIX, "_autoJourneyFlow failed", e); }
      try { const m = await this._autoMilestoneFlow(parsed, actor); if (m) autoParts.push(m); }
      catch (e) { console.warn(LOG_PREFIX, "_autoMilestoneFlow failed", e); }
      // (v0.10.27) Roll-result integration for the COMPLETION moves
      // ("Fulfill Your Vow" / "End the Fight" / "Reach Your Destination"):
      // strong hit auto-finishes the targeted track; weak/miss leave it open
      // and only steer the narration toward consequences.
      try { const fin = await this._autoCompletionFlow(parsed, actor); if (fin) autoParts.push(fin); }
      catch (e) { console.warn(LOG_PREFIX, "_autoCompletionFlow failed", e); }
      autoSummary = autoParts.join("; ");
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
Narrate this outcome vividly as the Skald (2–4 sentences).${allowEffects ? " Then append any warranted [[EFFECT:…]] directives that were NOT already applied above." : " Do not emit effect directives; simply narrate."} Finally, close with a brief forward-looking line that weaves one or two fitting follow-up moves (real moves only, named exactly) directly into the prose as instructed — do NOT use [[MOVE:…]] directives or a separate list for them.`;

    // Whether the Skald may offer follow-up move suggestions after the
    // narration. Reuses the same "suggestMoves" setting that gates the
    // pre-roll suggestion card, so both honour one toggle.
    const allowFollowups = this.active() && (Settings.get("suggestMoves") ?? true);

    try {
      Memory.push("general", "user", `(${parsed.moveName} → ${parsed.outcome})`);
      // Recall relevant world memory using the move + the player's intent.
      const memory = await RagBridge.fetchMemory(`${parsed.moveName} ${this._lastIntent || ""}`.trim());
      const messages = [
        { role: "system", content: buildSystemPrompt({ task, context: ctx, allowEffects, allowFollowups, allowJournal: true, memory }) },
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

      // (v0.10.10) Follow-up moves are now woven into the Skald's closing
      // prose and auto-linked inline by EntityLinker (each rolls through the
      // progress-aware triggerMove path when clicked). We no longer post a
      // separate "What Comes Next" suggestion card — any stray [[MOVE:…]]
      // directive is stripped from the displayed narration instead. The
      // `allowFollowups` flag still gates whether the prompt invites them.
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
        if (pr?.ok) {
          this._notifyProgress(pr.track, pr.boxes);
          notes.push(`inflicted harm on ${pr.track} (now ${pr.boxes}/10 boxes)`);
          // (fix — foe auto-completion) A foe brought to full progress (10/10)
          // is defeated; close the track deterministically instead of leaving
          // it open. Clears the active-combat flag inside the helper.
          const done = await this._autoCompleteIfFull(actor, track.id, "combat");
          if (done) notes.push(`${pr.track} defeated (10/10 — auto-completed)`);
        }
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
   * Is this the journey-ADVANCING move ("Undertake a Journey")? This is the
   * move whose hit marks journey progress — distinct from the journey-FINISHING
   * progress move ("Reach Your Destination"), which rolls the accumulated
   * track and is handled by IronswornController.rollProgressMove().
   */
  _isJourneyMove(moveName) {
    return /\bundertake (?:a|your|the|this) journey\b/i.test(String(moveName || ""));
  },

  /**
   * (v0.10.27 — roll-result integration) Classify a progress-COMPLETION move
   * and the track KIND it resolves:
   *   "Fulfill Your Vow"      → vow
   *   "End the Fight"         → combat
   *   "Reach Your Destination"→ journey
   * Returns the kind string, or null when `moveName` is not a completion move.
   */
  _completionMoveKind(moveName) {
    const n = String(moveName || "").toLowerCase();
    if (/\bfulfill (?:your|the|this) vow\b/.test(n)) return "vow";
    if (/\bend the fight\b/.test(n)) return "combat";
    if (/\breach (?:your|the|this) destination\b/.test(n)) return "journey";
    return null;
  },

  /**
   * (v0.10.27) Deterministically integrate the OUTCOME of a progress-completion
   * move with the relevant track:
   *   • STRONG HIT → the track is finished. Auto-complete the correct track,
   *     resolved via the story-arc flags (active vow / active combat) with a
   *     graceful fallback to the last-rolled / newest-open track of that kind.
   *   • WEAK HIT / MISS → the track is NOT completed; we only return a note so
   *     the narration prompt describes the complication / consequence and the
   *     track stays open for another attempt.
   * Returns a short human-readable summary (for the prompt + GM whisper), or ""
   * when the move isn't a completion move / nothing applied. Never throws.
   */
  async _autoCompletionFlow(parsed, actor) {
    if (!actor) return "";
    const kind = this._completionMoveKind(parsed?.moveName);
    if (!kind) return "";

    const out    = String(parsed?.outcome || "").toLowerCase();
    const strong = out.includes("strong");
    const weak   = out.includes("weak");

    // Resolve the target track, preferring the explicit story-arc flags.
    let target = null;
    if (kind === "vow") {
      const av = IronswornController.getActiveVow(actor);
      target = (av && actor.items?.get?.(av.id))
            || IronswornController.resolveCompletionTrack(actor, "", "vow");
    } else if (kind === "combat") {
      // (v0.11.0) Prefer the foe track the progress roll ACTUALLY rolled
      // against — recorded by IronswornController.rollProgressMove() as
      // _lastProgressTrack — so the correct fight closes even when several
      // foes are open or the active-combat flag has drifted to a different
      // foe. Fall back to the active-combat flag when no rolled track is known.
      const lpt = IronswornController._lastProgressTrack;
      if (lpt && lpt.kind === "combat" && lpt.actorId === actor.id) {
        const t = actor.items?.get?.(lpt.id);
        if (t && !foundry.utils.getProperty(t, "system.completed")) target = t;
      }
      if (!target) {
        const ac = IronswornController.getActiveCombat(actor);
        target = ac && actor.items?.get?.(ac.id);
      }
    } else { // journey
      target = IronswornController.resolveCompletionTrack(actor, "", "journey");
    }

    if (!strong) {
      // Weak hit or miss — explicitly DO NOT complete. Provide narration guidance.
      const label = kind === "combat" ? "fight" : kind;
      const name  = target?.name ? ` “${target.name}”` : "";
      return weak
        ? `${label}${name} NOT yet finished (weak hit) — narrate partial success at a cost; the track stays open`
        : `${label}${name} NOT finished (miss) — narrate a serious setback/complication; the track stays open`;
    }

    // Strong hit — complete the track.
    if (!target) {
      return `no open ${kind} track to complete (strong hit on ${parsed.moveName})`;
    }
    let r;
    if (kind === "combat") {
      r = await IronswornController.completeTrack(actor, target.id);
      if (r?.ok) { try { await IronswornController.clearActiveCombat(actor); } catch (_) {} }
    } else {
      r = await IronswornController.completeTrackSmart(actor, target.id, kind);
      if (r?.ok && kind === "vow") { try { await IronswornController.setActiveVow(actor, null); } catch (_) {} }
    }
    if (r?.ok) {
      const verb = kind === "vow" ? "fulfilled vow" : kind === "combat" ? "won the fight" : "reached destination";
      this._notifyCombat(`🏆 ${verb}: ${r.name}`);
      try { await Chat.postSystem(`<em>🤖 Skald marked “${escapeHtml(r.name)}” complete (strong hit on ${escapeHtml(parsed.moveName)}).</em>`, { gmWhisper: true }); } catch (_) {}
      this._auditWrite("ROLL_COMPLETE", { trackKind: kind, name: r.name }, true, `strong hit on ${parsed.moveName}`);
      return `${verb} “${r.name}” (strong hit — auto-completed)`;
    }
    this._auditWrite("ROLL_COMPLETE", { trackKind: kind, name: target?.name }, false, r?.error);
    return "";
  },

  /**
   * (fix — journey/combat auto-completion) Complete a progress track that has
   * reached FULL progress (10 boxes / 40 ticks). Shared by the journey and
   * combat auto-flows so a track that fills up via "Undertake a Journey" or
   * "Strike"/"Clash" closes itself deterministically instead of lingering open
   * forever.
   *
   * Two bugs were caused by tracks never closing at 10/10:
   *   • JOURNEYS — because the first journey track stayed open forever,
   *     _autoJourneyFlow kept REUSING it, collapsing every journey into one
   *     perpetually-open track (the "all journeys group together" bug).
   *   • FOES — a foe brought to 10/10 by Strikes/Clashes was never marked
   *     defeated (the "foe combat doesn't auto-complete" bug).
   *
   * Completion goes through IronswornController.completeTrack(), which only
   * flips `system.completed`. The automatic vow-XP hook (updateItem) is gated
   * to VOWS only, so completing a JOURNEY or COMBAT track here never awards XP.
   *
   * @param {Actor}  actor
   * @param {string} trackId   the track Item id
   * @param {string} kind      "journey" | "combat" (controls notification + flag cleanup)
   * @returns {Promise<boolean>} true when this call completed the track.
   */
  async _autoCompleteIfFull(actor, trackId, kind) {
    try {
      const t = actor?.items?.get?.(trackId);
      if (!t) return false;
      if (foundry.utils.getProperty(t, "system.completed")) return false;
      const cur = foundry.utils.getProperty(t, "system.current") ?? 0;
      if (cur < 40) return false;                       // not yet 10/10 boxes
      const r = await IronswornController.completeTrack(actor, trackId);
      if (!r?.ok) return false;
      // A finished fight is no longer the active combat — clear the flag.
      if (kind === "combat") { try { await IronswornController.clearActiveCombat(actor); } catch (_) {} }
      const verb = kind === "combat" ? "🏆 foe defeated" : "🏁 destination reached";
      try { this._notifyCombat(`${verb}: ${r.name} (10/10)`); } catch (_) {}
      try { await Chat.postSystem(`<em>🤖 Skald marked “${escapeHtml(r.name)}” complete (full progress — 10/10).</em>`, { gmWhisper: true }); } catch (_) {}
      this._auditWrite("AUTO_COMPLETE_FULL", { trackKind: kind, name: r.name }, true, "reached 10/10 boxes");
      return true;
    } catch (e) {
      console.warn(LOG_PREFIX, "_autoCompleteIfFull failed", e);
      return false;
    }
  },

  /**
   * Is this the "Reach a Milestone" move?  No dice — just marks progress on
   * the active vow by its rank.
   */
  _isMilestoneMove(moveName) {
    return /\breach a milestone\b/i.test(String(moveName || ""));
  },

  /* ==================================================================
   *  JOURNEY NAMING — multi-layer destination resolver (v0.11.3)
   * ==================================================================
   * Auto-created journey tracks used to be named by a single regex over the
   * player's intent, falling back to the constant "The Journey" whenever it
   * missed — which made every unparsed journey share one name (and collapse
   * into a single track). The resolver below tries, in order:
   *
   *   Layer 1  Deterministic extraction — a broadened, case-insensitive regex
   *            (more prepositions) plus bare compass-direction handling.
   *   Layer 2  Context match — compare the intent against REAL place names
   *            already in scope (scene name, map-note / journal-pin locations).
   *   Layer 3  AI semantic extraction — a small, bounded, setting-gated LLM
   *            call for complex phrasing ("we strike out past the frost-line").
   *   Layer 4  Intelligent fallback — name from the active/story-focus vow or
   *            the current scene, never a bare repeated "The Journey".
   *
   * Every layer is defensive; resolution NEVER throws and ALWAYS yields a
   * non-empty, sensible name. Returns { name, rank, specific, source } where
   * `specific` tells _autoJourneyFlow whether the destination is concrete
   * enough to branch a separate track (vs. conservatively reusing the newest).
   */
  async _resolveJourney(actor) {
    const intent = String(this._lastIntent || "").trim();

    // ---- Layer 1: deterministic regex extraction ----
    try {
      const dest = this._extractDestinationDeterministic(intent);
      if (dest) return { name: `Journey to ${dest}`, rank: this._inferJourneyRank(intent), specific: true, source: "regex" };
      const dir = this._extractDirection(intent);
      if (dir) return { name: `Journey ${dir}`, rank: this._inferJourneyRank(intent), specific: true, source: "direction" };
    } catch (e) { this._dbg?.("journey naming L1 failed", e); }

    // ---- Layer 2: context match against real, in-scope locations ----
    try {
      const ctxDest = this._matchContextLocation(intent);
      if (ctxDest) return { name: `Journey to ${ctxDest}`, rank: this._inferJourneyRank(intent), specific: true, source: "context" };
    } catch (e) { this._dbg?.("journey naming L2 failed", e); }

    // ---- Layer 3: AI semantic extraction (bounded, setting-gated) ----
    try {
      if (intent && (Settings.get("aiJourneyNaming") ?? true)) {
        const ai = await this._aiExtractDestination(intent, actor);
        if (ai?.destination) {
          const rank = this._normalizeRankWord(ai.rank) || this._inferJourneyRank(intent);
          return { name: `Journey to ${this._titleCase(ai.destination)}`, rank, specific: true, source: "ai" };
        }
      }
    } catch (e) { this._dbg?.("journey naming L3 failed", e); }

    // ---- Layer 4: intelligent fallback (active vow / scene), never bare ----
    try {
      const fb = this._fallbackJourneyName(actor);
      if (fb?.name) return { name: fb.name, rank: this._inferJourneyRank(intent), specific: !!fb.specific, source: fb.source };
    } catch (e) { this._dbg?.("journey naming L4 failed", e); }

    return { name: "The Journey", rank: this._inferJourneyRank(intent), specific: false, source: "generic" };
  },

  /**
   * Layer 1 — deterministic destination extraction. Case-INSENSITIVE, with a
   * broadened set of travel cues, returning a Title-Cased place name (or "").
   */
  _extractDestinationDeterministic(intent) {
    if (!intent) return "";
    // Travel cues that precede a destination. Multi-word cues first so e.g.
    // "set out for" wins over a bare "for". The destination is any run of
    // word-ish characters (letters/marks/apostrophes/hyphens/spaces), captured
    // case-insensitively and cleaned up afterwards.
    const CUE = "(?:bound for|set out for|set off for|head(?:ing|ed)? (?:to|for)|make for|making for|depart(?:ing)? for|venture (?:to|into)|voyage to|sail(?:ing)? (?:to|for)|march(?:ing)? (?:to|on)|ride (?:to|for)|travel(?:ling|ing)? to|journey(?:ing)? to|onward to|towards?|reach(?:ing)?|into|to|for)";
    const re = new RegExp(`\\b${CUE}\\s+((?:the\\s+)?[\\p{L}][\\p{L}''’\\- ]{1,48})`, "iu");
    const m = intent.match(re);
    if (!m) return "";
    let dest = m[1].trim()
      .replace(/[.,;:!?].*$/, "")          // cut at first sentence punctuation
      .replace(/\s+/g, " ")
      .trim();
    // The capture is deliberately greedy (place names can be multi-word), so it
    // may sweep up the clause that FOLLOWS the destination ("…to Skellmark
    // across the sea", "…for Hearthwild before the storm"). Cut at the first
    // clause-boundary / connective word so we keep only the place name itself.
    dest = dest.replace(/\s+(?:across|before|after|while|until|through|throughout|beyond|past|near|amid|amidst|when|where|because|so|once|though|although|since|unless|but|and|then|with|using|by|to|in order|despite|without).*$/i, "").trim();
    // Strip a leading travel verb the broad cue may have left attached
    // ("to reach the old watchtower" → "the old watchtower").
    dest = dest.replace(/^(?:reach(?:ing)?|go(?:ing)?|get(?:ting)?|head(?:ing)?|travel(?:ling|ing)?|journey(?:ing)?|venture|return(?:ing)?)\s+/i, "").trim();
    // Place names are short; cap to the first 5 words to avoid runaway capture.
    { const w = dest.split(/\s+/); if (w.length > 5) dest = w.slice(0, 5).join(" "); }
    // Trim any dangling article/preposition the cap or cut may have left.
    dest = dest.replace(/\s+(?:of|the|a|an|in|on|at|by|for)(?:\s+(?:a|an|the))?$/i, "").trim();
    if (!dest) return "";
    // Reject obvious non-destinations (the move name itself, generic words).
    if (/^journey\b/i.test(dest)) return "";
    if (/^(it|them|him|her|us|me|that|this|there|here|home|safety|danger|trouble)$/i.test(dest)) {
      // "home" → handled as a sensible destination; others are non-places.
      if (!/^home$/i.test(dest)) return "";
    }
    return this._titleCase(dest);
  },

  /**
   * Layer 1b — bare compass / relative direction ("journey north", "press on
   * downriver"). Returns a Title-Cased direction word or "".
   */
  _extractDirection(intent) {
    if (!intent) return "";
    const m = intent.match(/\b(north|south|east|west|northward|southward|eastward|westward|upriver|downriver|inland|seaward|homeward)\b/i);
    return m ? this._titleCase(m[1]) : "";
  },

  /**
   * Layer 2 — match the intent against REAL place names already in scope:
   * the active scene's name and its map-note / journal-pin locations (the same
   * data _gatherSceneContext surfaces to the AI). Returns the canonical place
   * name (correct spelling/casing) when the intent mentions it, else "".
   */
  _matchContextLocation(intent) {
    if (!intent) return "";
    const hay = intent.toLowerCase();
    const places = this._getContextLocations();
    // Prefer the LONGEST matching name so "the Frozen Keep" beats "Keep".
    let best = "";
    for (const p of places) {
      const needle = String(p || "").trim();
      if (needle.length < 3) continue;
      if (hay.includes(needle.toLowerCase()) && needle.length > best.length) best = needle;
    }
    return best;
  },

  /**
   * Collect real, in-scope location names: the active scene's map-note /
   * journal-pin labels and the scene name itself. Fully defensive — returns []
   * on any read failure so naming never breaks.
   */
  _getContextLocations() {
    const out = [];
    const seen = new Set();
    const push = (n) => {
      const v = String(n ?? "").trim();
      if (!v) return;
      const k = v.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k); out.push(v);
    };
    try {
      const scene = game?.scenes?.active ?? canvas?.scene ?? null;
      if (scene) {
        const notes = scene.notes ? Array.from(scene.notes) : [];
        for (const note of notes) {
          if (!note) continue;
          let label = "";
          try { label = String(note.text ?? "").trim(); } catch (_) { label = ""; }
          let journalName = "";
          try {
            const entry = (note.entryId && game?.journal?.get) ? game.journal.get(note.entryId) : (note.entry ?? null);
            if (entry?.name) journalName = String(entry.name).trim();
          } catch (_) { journalName = ""; }
          push(label || journalName);
        }
        push(String(scene.navName || scene.name || "").trim());
      }
    } catch (_) { /* graceful degradation */ }
    return out;
  },

  /**
   * Layer 3 — AI semantic extraction for complex phrasing. Bounded (low token
   * budget, low temperature), setting-gated, and fully defensive: any failure
   * returns null so resolution falls through to the Layer-4 fallback. Feeds the
   * model the player's intent plus the real in-scope locations so it grounds
   * the destination in the actual fiction. Expects a one-line JSON object.
   *
   * @returns {Promise<{destination?:string, rank?:string}|null>}
   */
  async _aiExtractDestination(intent, actor) {
    const places = this._getContextLocations().slice(0, 12);
    const vow = (() => { try { return IronswornController.getActiveVow?.(actor)?.name || ""; } catch (_) { return ""; } })();
    const placeLine = places.length ? `Known nearby places: ${places.join(", ")}.` : "No known places listed.";
    const vowLine = vow ? `The character's current vow: "${vow}".` : "";
    const system = "You extract the DESTINATION of an Ironsworn journey from a player's words. " +
      "Reply with ONE line of compact JSON only, no prose: " +
      '{"destination":"<short place name or empty>","rank":"<troublesome|dangerous|formidable|extreme|epic>"}. ' +
      "Prefer a destination that matches a known nearby place. If no destination is implied, use an empty string. " +
      "Pick a rank reflecting how arduous the trip sounds (default formidable).";
    const user = `Player intent: "${intent}"\n${placeLine}\n${vowLine}`;
    try {
      const reply = await Client.chat(
        [{ role: "system", content: system }, { role: "user", content: user }],
        { temperature: 0.2, maxTokens: 80 }
      );
      const raw = String(reply || "");
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const obj = JSON.parse(m[0]);
      let destination = String(obj?.destination ?? "").trim().replace(/[.,;:!?]+$/, "");
      if (/^journey\b/i.test(destination)) destination = destination.replace(/^journey\s+(?:to\s+)?/i, "").trim();
      if (destination.length < 2 || destination.length > 50) destination = "";
      const rank = this._normalizeRankWord(obj?.rank);
      return { destination, rank };
    } catch (e) {
      this._dbg?.("AI destination extraction failed", e);
      return null;
    }
  },

  /**
   * Layer 4 — intelligent fallback. Instead of a bare repeated "The Journey",
   * name the track from the current STORY FOCUS / active vow ("Journey toward
   * <vow keyword>") or, failing that, the current scene ("Journey from
   * <scene>"). Returns { name, specific, source }. `specific:false` keeps the
   * conservative reuse-newest behaviour so near-duplicate generic journeys
   * don't spam separate tracks; a vow/scene-seeded name is treated as specific.
   */
  _fallbackJourneyName(actor) {
    // Active / story-focus vow → a goal-oriented journey name.
    try {
      const vow = IronswornController.getActiveVow?.(actor);
      if (vow?.name) {
        const kw = this._vowKeyword(vow.name);
        if (kw) return { name: `Journey toward ${kw}`, specific: true, source: "vow" };
      }
    } catch (_) { /* ignore */ }
    // Current scene → a place-anchored journey name.
    try {
      const scene = game?.scenes?.active ?? canvas?.scene ?? null;
      const sn = String(scene?.navName || scene?.name || "").trim();
      if (sn && !/^scene$/i.test(sn)) return { name: `Journey from ${this._titleCase(sn)}`, specific: false, source: "scene" };
    } catch (_) { /* ignore */ }
    return { name: "The Journey", specific: false, source: "generic" };
  },

  /**
   * Reduce a vow title to a short, evocative keyword/phrase for naming a
   * journey after it (e.g. "Avenge the burning of Hearthwild" → "Hearthwild").
   * Best-effort: prefers a trailing proper noun, else the last few words.
   */
  _vowKeyword(vowName) {
    const n = String(vowName || "").trim().replace(/[.,;:!?]+$/, "");
    if (!n) return "";
    // A proper noun anywhere in the vow is the strongest signal.
    const proper = n.match(/\b([A-Z][\w''’\-]+(?:\s+[A-Z][\w''’\-]+)*)\b/g);
    if (proper && proper.length) {
      // Skip a leading capitalised verb ("Avenge", "Find") if more follows.
      const cand = proper.length > 1 ? proper[proper.length - 1] : proper[0];
      if (cand && cand.length > 2) return cand;
    }
    // Else the last 3 words, trimmed.
    const words = n.split(/\s+/);
    return words.slice(-3).join(" ");
  },

  /** Title-Case a place/direction phrase, preserving a leading "the". */
  _titleCase(s) {
    return String(s || "")
      .split(/\s+/)
      .map((w, i) => {
        const lw = w.toLowerCase();
        // Keep small joining words lower-case unless first.
        if (i > 0 && /^(the|of|a|an|and|to|in|on|at|by)$/.test(lw)) return lw;
        return w.charAt(0).toUpperCase() + w.slice(1);
      })
      .join(" ")
      .trim();
  },

  /** Coerce an arbitrary rank string to a canonical Ironsworn rank word or "". */
  _normalizeRankWord(r) {
    const v = String(r ?? "").trim().toLowerCase();
    return ["troublesome", "dangerous", "formidable", "extreme", "epic"].includes(v) ? v : "";
  },

  /**
   * Default rank for an auto-created journey track. Light heuristic over the
   * intent (epic/long → harder; quick/short → easier); defaults to formidable.
   */
  _inferJourneyRank(intent = "") {
    const t = String(intent || "").toLowerCase();
    if (/\b(epic|legendary|across the world|to the ends|impossible)\b/.test(t)) return "epic";
    if (/\b(extreme|perilous|treacherous|forsaken|far[- ]?off|distant)\b/.test(t)) return "extreme";
    if (/\b(dangerous|hard|arduous|gruel|harsh|long)\b/.test(t)) return "dangerous";
    if (/\b(quick|short|easy|nearby|brief|stroll|just (?:over|past)|down the road)\b/.test(t)) return "troublesome";
    return "formidable";
  },

  /**
   * (v0.13.0 — narrative pacing) Build progress-%-aware pacing guidance for the
   * journey narration prompt. Keeps the fiction aligned with the track so the
   * Skald never describes ARRIVING before the journey is nearly charted. Pure
   * advisory text — no mechanical effect. RAW-faithful: arrival is resolved only
   * by the "Reach Your Destination" progress roll.
   * @param {number} boxes filled progress boxes (0–10)
   * @returns {string} a guidance clause for the autoSummary
   */
  _journeyPacingNote(boxes) {
    const b   = Math.max(0, Math.min(10, Number(boxes) || 0));
    const pct = b * 10;
    const at  = `(${b}/10, ${pct}%)`;
    if (b <= 3) {
      return `PACING ${at}: the journey has only just begun — narrate an early leg or first complication. ` +
             `Treat this waypoint as a DRAMATIC BEAT (a hardship, choice, or discovery), NOT a geographic milestone. ` +
             `Do NOT describe arriving at — or even sighting — the destination yet.`;
    }
    if (b <= 6) {
      return `PACING ${at}: the journey is well underway — escalate the stakes mid-trek. ` +
             `This waypoint is a dramatic complication, not the destination. ` +
             `The party is still far from arrival; do NOT describe reaching the destination.`;
    }
    if (b <= 8) {
      return `PACING ${at}: the journey nears its end — you MAY foreshadow the destination on the horizon, ` +
             `but the party has NOT arrived. Arrival is resolved only by the "Reach Your Destination" roll.`;
    }
    return `PACING ${at}: the journey is all but charted — the destination is in sight. ` +
           `Do NOT auto-narrate the arrival; instead prompt the player to roll "Reach Your Destination" ` +
           `to resolve HOW the arrival goes.`;
  },

  /**
   * Deterministically enact the journey side of "Undertake a Journey" so that
   * "Reach Your Destination" always has an open track to roll against:
   *   • If no open journey track exists, OPEN one (named from the player's
   *     intent, or a clean generic title) — this is the root-cause fix for the
   *     "No open journey track to roll 'Reach Your Destination' against" error.
   *   • On a hit (strong/weak), MARK PROGRESS on that journey by its rank, the
   *     standard effect of a successful "Undertake a Journey".
   * Returns a short human-readable summary (for the prompt + GM whisper), or ""
   * when the move isn't a journey move / nothing applied.
   */
  async _autoJourneyFlow(parsed, actor) {
    if (!actor) return "";
    if (!this._isJourneyMove(parsed?.moveName)) return "";

    const out    = String(parsed.outcome || "").toLowerCase();
    const strong = out.includes("strong");
    const hit    = strong || out.includes("weak");
    const notes  = [];

    // Resolve WHICH journey track this move advances.
    //
    // (fix — journey separation) Previously we ALWAYS reused the newest open
    // journey track, so a journey to a *different* destination simply advanced
    // the prior, still-open track — collapsing every journey into a single
    // perpetually-open track (the "all journeys group together" bug). The root
    // cause was compounded by journeys never closing at 10/10, so that first
    // track lingered open forever and was reused indefinitely.
    //
    // Now: if we can confidently identify THIS move's destination (a specific
    // "Journey to X" inferred from the player's intent), we reuse an open
    // journey ONLY when it is the same destination; a different destination
    // opens its own track so simultaneous journeys stay separate. When the
    // destination is unknown (generic "The Journey"), we keep the conservative
    // reuse-newest behaviour to avoid spamming near-duplicate tracks.
    // (v0.11.3 — naming overhaul) Resolve the destination via the multi-layer
    // resolver (command-parser intent → regex → context → AI → fallback) so the
    // track is named after the real destination instead of a generic label.
    const resolved     = await this._resolveJourney(actor);
    const inferredName = resolved.name;       // "Journey to X" | "Journey north" | <fallback> | "The Journey"
    const specific     = resolved.specific;   // did we identify a real destination?
    let track = IronswornController._newestOpenTrackItem(actor, "journey");

    if (track && specific) {
      // Reuse only an OPEN journey matching this destination; else branch a new one.
      const match     = IronswornController.findTrackFuzzy(actor, inferredName, "journey");
      const matchOpen = match && !foundry.utils.getProperty(match, "system.completed");
      track = matchOpen ? match : null;
    }

    if (!track) {
      const name = inferredName;
      const rank = resolved.rank;
      const res  = await IronswornController.createProgressTrack(actor, name, "journey", rank);
      if (res?.ok) {
        track = IronswornController.getProgressTrack(actor, res.id)
             ?? IronswornController._newestOpenTrackItem(actor, "journey");
        notes.push(`opened journey “${res.name || name}” (${rank})`);
        try { ui.notifications?.info(`${SKALD_NAME}: journey begun — ${res.name || name}.`); } catch (_) {}
      } else {
        notes.push("could not open a journey track");
      }
    }

    // On a hit, mark progress on the (now open) journey by its rank.
    if (track && hit) {
      const pr = await IronswornController.markProgressByRank(actor, track.id);
      if (pr?.ok) {
        this._notifyProgress(pr.track, pr.boxes);
        notes.push(`advanced ${pr.track} (now ${pr.boxes}/10 boxes)`);
        // (v0.13.0) Progress-aware narrative pacing so the fiction stays aligned
        // with the track and never "arrives" before the journey is nearly full.
        notes.push(this._journeyPacingNote(pr.boxes));
        // (fix — journey completion) A journey that has reached full progress
        // (10/10) is finished; close it deterministically so it stops being
        // reused by later journeys (which caused the grouping bug).
        const done = await this._autoCompleteIfFull(actor, track.id, "journey");
        if (done) notes.push(`reached destination “${pr.track}” (10/10 — auto-completed)`);
      }
    } else if (track && !hit) {
      // (v0.13.0) MISS on "Undertake a Journey" — RAW: mark NO progress. The
      // party is stuck until an obstacle is resolved. Steer the narration to a
      // complication that must be overcome (a side-challenge, Pay the Price, or
      // a fresh Face Danger) rather than quietly advancing toward the goal.
      const cur   = Number(foundry.utils.getProperty(track, "system.current") ?? 0);
      const boxes = Math.max(0, Math.min(10, Math.floor(cur / 4)));
      notes.push(
        `MISS on the journey "${track.name}" (${boxes}/10, ${boxes * 10}%) — NO progress marked. ` +
        `The party is HALTED by an obstacle; narrate a complication or cost they must resolve ` +
        `(e.g. Pay the Price, Face Danger, or a short side-challenge) before they can travel on. ` +
        `Do NOT advance toward the destination this turn.`
      );
    }
    return notes.join("; ");
  },

  /**
   * Deterministically enact "Reach a Milestone": find the newest open vow
   * and mark progress on it by its rank. This move has NO dice — it always
   * succeeds. Returns a human-readable summary for the narration prompt.
   */
  async _autoMilestoneFlow(parsed, actor) {
    if (!actor) return "";
    if (!this._isMilestoneMove(parsed?.moveName)) return "";
    const res = await IronswornController._executeMilestone(actor);
    if (res?.ok) {
      this._notifyProgress(res.track, res.boxes);
      return `marked progress on vow "${res.track}" (now ${res.boxes ?? "?"}/10 boxes)`;
    }
    return res?.error ? `milestone: ${res.error}` : "";
  },

  /**
   * Remove progress / initiative / create_journey effects an auto-flow already
   * applied for a core combat OR journey move, so the AI can't double-apply
   * them. Non-combat / non-journey moves (and unrelated effects) pass through.
   */
  _filterRedundantCombatEffects(effects, parsed, autoSummary) {
    if (!autoSummary) return effects;
    const combat    = this._isCombatMove(parsed?.moveName);
    const journey   = this._isJourneyMove(parsed?.moveName);
    const milestone = this._isMilestoneMove(parsed?.moveName);
    // (v0.10.27) Did _autoCompletionFlow already finish a track this turn? Only
    // a STRONG hit on a completion move auto-completes; in that case drop any
    // AI-emitted completion directive to avoid a confusing double-completion
    // notification. (On weak/miss nothing was completed, so we leave the
    // effects alone — though the prompt steers the AI away from completing.)
    const autoCompleted = this._completionMoveKind(parsed?.moveName)
      && /auto-completed/.test(String(autoSummary || ""));
    if (!combat && !journey && !milestone && !autoCompleted) return effects;
    return (effects || []).filter(e => {
      if (combat && e.kind === "initiative") { this._dbg("→ dropping redundant initiative effect (auto-applied)"); return false; }
      if (e.kind === "progress")             { this._dbg("→ dropping redundant progress effect (auto-applied)"); return false; }
      // The journey track is opened deterministically by _autoJourneyFlow, so
      // drop any AI-emitted create_journey to avoid a duplicate track.
      if (journey && e.kind === "create_journey") { this._dbg("→ dropping redundant create_journey effect (auto-applied)"); return false; }
      // A completion move already auto-finished the track — drop redundant
      // completion directives (both the legacy complete_*/end_combat effects
      // and the new MARK_COMPLETE write directive).
      if (autoCompleted && (e.kind === "complete_track" || e.kind === "end_combat" || e.kind === "mark_complete")) {
        this._dbg("→ dropping redundant completion effect (auto-completed on strong hit)"); return false;
      }
      return true;
    });
  },

  /**
   * (v0.10.6) Effect kinds that represent the progress-track LIFECYCLE
   * (begin / close a journey, vow, or fight). These are the only effects the
   * conversational channels (!skald / !scene / !combat) apply, since they have
   * no dice roll to hang meter changes off. Meter effects (momentum, harm,
   * stress, supply, progress) stay dice-driven via {@link _narrateOutcome}.
   */
  // NOTE: "progress" is included so the conversational channels can advance a
  // NAMED vow/journey from the narrative (the [[EFFECT: mark_progress "Title"]]
  // / [[EFFECT: progress <Title> …]] directive) WITHOUT requiring a dice roll
  // first — markProgress() resolves the track by its title. This is separate
  // from the post-roll path (_narrateOutcome), which applies effects directly
  // and filters auto-applied progress, so there is no double-marking risk.
  // (v0.10.27) The explicit write directives (mark_complete / add_progress /
  // set_progress) are track-lifecycle operations too, so the conversational
  // channels apply them without needing a dice roll first.
  _TRACK_LIFECYCLE_KINDS: ["create_journey", "create_vow", "create_combat", "complete_track", "end_combat", "progress", "mark_complete", "add_progress", "set_progress"],

  /**
   * (v0.10.6) Parse a conversational reply for [[EFFECT:…]] directives and
   * apply ONLY the track-lifecycle ones (create_journey / create_vow /
   * create_combat / complete_* / end_combat). This is what makes a journey or
   * vow the Skald narrates in a normal !skald/!scene/!combat exchange actually
   * appear on the character sheet — previously these directives were parsed
   * for display-stripping but never applied outside the post-roll path.
   *
   * Gated by the caller (only invoked when the Ironsworn integration is active
   * and the "AI Applies Mechanical Effects" setting is on). Fully defensive:
   * never throws into the conversation flow.
   * @returns {Promise<string[]>} the list of applied-effect summaries (may be empty).
   */
  async applyNarrativeTrackEffects(reply, actor) {
    try {
      const { effects } = this.parseEffects(reply);
      const trackEffects = (effects || []).filter(e => this._TRACK_LIFECYCLE_KINDS.includes(e.kind));
      if (!trackEffects.length) return [];
      return await this.applyEffects(trackEffects, actor);
    } catch (e) {
      console.warn(LOG_PREFIX, "applyNarrativeTrackEffects failed", e);
      return [];
    }
  },

  /**
   * (v0.10.8) GM-only advisory when a track-lifecycle effect can't run because
   * there is no active character. Previously these directives failed silently,
   * so a sworn vow / begun journey simply never appeared with no explanation.
   */
  async _warnNoActor(action, name) {
    try {
      await Chat.postSystem(
        `<strong>Could not ${escapeHtml(action)}${name ? ` “${escapeHtml(name)}”` : ""}:</strong> ` +
        `no active character. Select your character's token (or assign a character to your user) and try again.`,
        { gmWhisper: true }
      );
    } catch (_) { /* advisory only */ }
  },

  /**
   * (v0.10.8) GM-only advisory when a progress-track create actually failed
   * (e.g. a data-model validation error). Surfacing the reason makes a
   * "vows aren't being created" report diagnosable instead of silent.
   */
  async _warnTrackCreateFailed(kind, name, error) {
    try {
      await Chat.postSystem(
        `<strong>Could not create the ${escapeHtml(kind)} “${escapeHtml(name ?? "")}”:</strong> ` +
        `${escapeHtml(error ?? "unknown error")}`,
        { gmWhisper: true }
      );
    } catch (_) { /* advisory only */ }
  },

  /**
   * (v0.10.37 — Phase 3) GM-only advisory when a compendium-creation effect
   * (add_asset / add_item / create_foe / create_character) could not be
   * fulfilled. Includes the closest suggested name when the lookup offered
   * one, so the GM can correct the directive. Never throws.
   */
  async _warnCreateFailed(kind, name, error, suggestion) {
    try {
      const hint = suggestion ? ` Did you mean “${escapeHtml(suggestion)}”?` : "";
      await Chat.postSystem(
        `<em>⚠ Could not add/create the ${escapeHtml(kind)} “${escapeHtml(name ?? "")}”: ` +
        `${escapeHtml(error ?? "unknown error")}.${hint}</em>`,
        { gmWhisper: true }
      );
    } catch (_) { /* advisory only */ }
  },

  /** Apply parsed [[EFFECT:…]] directives via the Ironsworn controller. */
  async applyEffects(effects, actor) {
    const applied = [];
    // Snapshot combat tracks that were already open BEFORE this batch. When a
    // new fight starts we auto-close these (one fight at a time in Ironsworn),
    // but NOT any foe tracks created within this same reply — a single
    // narration can introduce several foes in one fight.
    const preBatchCombatIds = actor
      ? IronswornController.getCombatTracks(actor).filter(t => !t.completed).map(t => t.id)
      : [];
    let staleCombatClosed = false;
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
          case "toggle_impact":
          case "set_impact": {
            // (v0.10.36 — Phase 2) Toggle/set a condition/impact. Gated by the
            // aiModifiesSheet setting ("impacts" or "full" permit it). Runs
            // GM-side via actor.update(); bounded + idempotent in the controller.
            const sheetMode = Settings.get("aiModifiesSheet") ?? "impacts";
            if (sheetMode === "off") {
              this._auditWrite("TOGGLE_IMPACT", { name: eff.impact }, false, "disabled (aiModifiesSheet=off)");
              break;
            }
            if (!actor) { await this._warnNoActor("change a condition", eff.impact); break; }
            r = (eff.kind === "toggle_impact")
              ? await IronswornController.toggleImpact(actor, eff.impact)
              : await IronswornController.setImpact(actor, eff.impact, eff.on);
            if (r?.ok && !r.noop) {
              const verb = r.state ? "marked" : "cleared";
              applied.push(`${verb} ${r.impact}`);
              this._auditWrite("TOGGLE_IMPACT", { name: r.impact }, true, `${verb} (${r.state})`);
            } else if (r?.noop) {
              this._auditWrite("TOGGLE_IMPACT", { name: r.impact }, true, "no-op (already in state)");
            } else {
              this._auditWrite("TOGGLE_IMPACT", { name: eff.impact }, false, r?.error);
            }
            break;
          }
          case "set_stat": {
            // (v0.10.36 — Phase 2) Set a base stat (0–5). Only permitted when
            // aiModifiesSheet is "full" — stat edits are rare and heavy.
            const sheetMode = Settings.get("aiModifiesSheet") ?? "impacts";
            if (sheetMode !== "full") {
              this._auditWrite("SET_STAT", { name: eff.stat, boxes: eff.value }, false, `disabled (aiModifiesSheet=${sheetMode})`);
              break;
            }
            if (!actor) { await this._warnNoActor("change a stat", eff.stat); break; }
            r = await IronswornController.setStat(actor, eff.stat, eff.value);
            if (r?.ok && !r.noop) {
              applied.push(`${r.stat} ${r.from}→${r.to}`);
              this._auditWrite("SET_STAT", { name: r.stat, boxes: r.to }, true, `${r.from}→${r.to}`);
            } else if (r?.noop) {
              this._auditWrite("SET_STAT", { name: r.stat, boxes: r.to }, true, "no-op (unchanged)");
            } else {
              this._auditWrite("SET_STAT", { name: eff.stat, boxes: eff.value }, false, r?.error);
            }
            break;
          }
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
          case "grant_xp": {
            // [[EFFECT: grant_xp <amount> <reason>]] — discretionary award.
            if (!actor) { await this._warnNoActor("grant experience", ""); break; }
            r = await IronswornController.grantXp(actor, eff.amount, { reason: eff.reason || "a hard-won milestone" });
            if (r?.ok) {
              applied.push(`+${r.amount} XP`);
              this._auditWrite("GRANT_XP", { name: eff.reason || "", boxes: eff.amount }, true, `+${r.amount} XP (${r.mode})`);
            } else {
              this._auditWrite("GRANT_XP", { name: eff.reason || "", boxes: eff.amount }, false, r?.error);
            }
            break;
          }
          case "grant_xp_vow": {
            // [[EFFECT: grant_xp_vow <rank>]] — award the rank's XP for the
            // vow just fulfilled. Funnels through the idempotent grantVowXp so
            // it can never double up with the automatic completion hook.
            if (!actor) { await this._warnNoActor("grant vow experience", ""); break; }
            const vow = IronswornController.resolveVowForXp(actor);
            if (!vow) {
              // No vow track to attach to — fall back to the rank's flat amount
              // if a rank was supplied, else skip.
              if (eff.rank) {
                const amt = IronswornController.xpForRank(eff.rank);
                r = amt > 0 ? await IronswornController.grantXp(actor, amt, { reason: `fulfilled a ${eff.rank} vow` }) : null;
                if (r?.ok) applied.push(`+${r.amount} XP (vow)`);
              }
              this._auditWrite("GRANT_XP_VOW", { name: "", trackKind: "vow" }, !!r?.ok, r?.ok ? "no track, flat rank award" : "no vow to award");
              break;
            }
            const weakHitHalf = (Settings.get("weakHitHalfXp") ?? false) === true;
            r = await IronswornController.grantVowXp(actor, vow, { weakHitHalf, reason: eff.reason });
            if (r?.ok && r.xp > 0) {
              applied.push(`+${r.xp} XP for “${vow.name}”`);
              this._auditWrite("GRANT_XP_VOW", { name: vow.name, trackKind: "vow", boxes: r.xp }, true, `+${r.xp} XP`);
            } else if (r?.skipped) {
              this._auditWrite("GRANT_XP_VOW", { name: vow.name, trackKind: "vow" }, true, `skipped (${r.skipped})`);
            } else {
              this._auditWrite("GRANT_XP_VOW", { name: vow.name, trackKind: "vow" }, false, r?.error);
            }
            break;
          }
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
            // For the optional advisory: whether this REGULAR (non-important)
            // foe turned out NOT to be in the official compendia, plus the
            // closest suggested name if the lookup offered one.
            let notInCompendium = false;
            let compendiumSuggestion = "";
            if (eff.rank) {
              rank = IronswornController.normalizeRank(eff.rank);
              source = "custom";
              this._dbg(`→ create_combat "${eff.name}": custom enemy, using AI-specified rank "${rank}"`);
              // A regular foe given an explicit rank but NOT flagged important
              // and NOT in the official compendia is a likely invented foe —
              // note it for the GM advisory below.
              if (!eff.important) {
                try {
                  const off = await IronswornController.isOfficialCompendiumFoe(eff.name);
                  if (!off) notInCompendium = true;
                } catch (_) { /* advisory only */ }
              }
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
                if (!eff.important) {
                  notInCompendium = true;
                  compendiumSuggestion = lookup?.suggestion || "";
                }
              }
            }
            // Ironsworn is fought one foe at a time. The first time a new
            // fight starts in this reply, tidy up any combat tracks left open
            // from a PREVIOUS fight (the AI doesn't always emit end_combat
            // when a fight fizzles out) — otherwise they linger as orphaned,
            // untracked tracks. We only close tracks open before this batch,
            // so several foes introduced in the same reply coexist fine.
            if (!staleCombatClosed && (Settings.get("autoCloseStaleCombatTracks") ?? true)) {
              staleCombatClosed = true;
              if (preBatchCombatIds.length) {
                const tidy = await IronswornController.closeStaleCombatTracks(actor, { onlyIds: preBatchCombatIds });
                if (tidy?.closed?.length) {
                  applied.push(`auto-closed prior combat ${tidy.closed.map(n => `“${n}”`).join(", ")}`);
                  this._notifyCombat(`🏳 Closed stale combat: ${tidy.closed.join(", ")}`);
                }
              }
              // Opportunistic, idempotent legacy repair: migrate any pre-existing
              // combat tracks still stored with the broken subtype "foe" (which
              // rendered the raw "IRONSWORN.ITEM.SubtypeFoe" key on the character
              // sheet) to subtype "progress". Runs once per reply, on a write path
              // only. Safe no-op when nothing needs fixing.
              try {
                const repair = await IronswornController.normalizeCombatTrackSubtypes(actor);
                if (repair?.fixed?.length) {
                  this._dbg(`→ migrated ${repair.fixed.length} legacy combat track label(s): ${repair.fixed.join(", ")}`);
                }
              } catch (e) {
                console.warn(LOG_PREFIX, "normalizeCombatTrackSubtypes failed", e);
              }
            }
            r = await IronswornController.createProgressTrack(actor, eff.name, "combat", rank);
            if (r?.ok) {
              const tag = source === "compendium" ? " [from compendium]" : source === "custom" ? " [custom]" : "";
              applied.push(`⚔ began combat “${eff.name}” [${rank}]${tag}`);
              this._notifyCombat(`⚔ Combat track created: ${eff.name} (${rank}${source === "compendium" ? ", official" : ""})`);
              // Phase 2 (story-arc tracking): a freshly-started fight is the
              // active combat — remember it so context markers and roll
              // integration target the right foe. Best-effort.
              try { await IronswornController.setActiveCombat(actor, r.id); } catch (_) {}
              // Optional GM advisory: a REGULAR foe (not flagged as an
              // important/unique narrative foe) that isn't in the official foe
              // compendia is likely an invented name. Whisper a gentle heads-up
              // to the GM so they can swap it for a catalogue foe if desired.
              // Important/unique foes are intentional and never warned.
              if (notInCompendium && !eff.important) {
                try {
                  const hint = compendiumSuggestion ? ` Closest official foe: “${compendiumSuggestion}”.` : "";
                  await Chat.postSystem(
                    `<em>⚠ “${eff.name}” is not in the official Ironsworn foe compendia. `
                    + `If this is a routine foe, prefer one from the catalogue; if it is an `
                    + `important boss/unique antagonist, that is fine.${hint}</em>`,
                    { gmWhisper: true }
                  );
                } catch (_) { /* advisory only — never block combat creation */ }
              }
            } else {
              await this._warnTrackCreateFailed("combat", eff.name, r?.error);
            }
            break;
          }
          case "create_vow": {
            if (!actor) { await this._warnNoActor("swear the vow", eff.name); break; }
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
            } else {
              await this._warnTrackCreateFailed("vow", eff.name, r?.error);
            }
            break;
          }
          case "create_journey": {
            if (!actor) { await this._warnNoActor("begin the journey", eff.name); break; }
            const rank = IronswornController.normalizeRank(eff.rank || "formidable");
            const existing = IronswornController.getProgressTrack(actor, eff.name);
            if (existing && !foundry.utils.getProperty(existing, "system.completed")) {
              applied.push(`journey “${eff.name}” already under way`);
              break;
            }
            r = await IronswornController.createProgressTrack(actor, eff.name, "journey", rank, eff.description);
            if (r?.ok) {
              applied.push(`journey “${eff.name}” begun [${rank}]`);
              this._notifyCombat(`🧭 Journey begun: ${eff.name} (${rank})`);
            } else {
              await this._warnTrackCreateFailed("journey", eff.name, r?.error);
            }
            break;
          }

          /* ---- Compendium creation (v0.10.37 — Phase 3) ---------------------
           * Bring official compendium content into play. All creation runs
           * GM-side through the Document API in the controller, is verified
           * against the compendia first, and is gated by the aiCreatesContent
           * setting: "off" blocks everything, "foes" allows only foe spawning,
           * "full" allows assets/items/characters too. A close-but-unmatched
           * name surfaces a gentle GM advisory rather than guessing. */
          case "add_asset": {
            const mode = Settings.get("aiCreatesContent") ?? "foes";
            if (mode !== "full") {
              this._auditWrite("ADD_ASSET", { name: eff.name }, false, `disabled (aiCreatesContent=${mode})`);
              break;
            }
            if (!actor) { await this._warnNoActor("add an asset", eff.name); break; }
            r = await IronswornController.addAssetToActor(actor, eff.name);
            if (r?.ok && !r.noop) {
              applied.push(`added asset “${r.name}”`);
              this._notifyCombat(`🎴 Asset added: ${r.name}`);
              this._auditWrite("ADD_ASSET", { name: r.name }, true, `matched ${r.match} → ${actor.name}`);
            } else if (r?.noop) {
              this._auditWrite("ADD_ASSET", { name: r.name }, true, "no-op (already owned)");
            } else {
              this._auditWrite("ADD_ASSET", { name: eff.name }, false, r?.error);
              await this._warnCreateFailed("asset", eff.name, r?.error, r?.suggestion);
            }
            break;
          }
          case "add_item": {
            const mode = Settings.get("aiCreatesContent") ?? "foes";
            if (mode !== "full") {
              this._auditWrite("ADD_ITEM", { name: eff.name }, false, `disabled (aiCreatesContent=${mode})`);
              break;
            }
            if (!actor) { await this._warnNoActor("add an item", eff.name); break; }
            r = await IronswornController.addItemToActor(actor, eff.name);
            if (r?.ok && !r.noop) {
              applied.push(`added ${r.type || "item"} “${r.name}”`);
              this._notifyCombat(`📦 Item added: ${r.name}`);
              this._auditWrite("ADD_ITEM", { name: r.name }, true, `${r.type} → ${actor.name}`);
            } else if (r?.noop) {
              this._auditWrite("ADD_ITEM", { name: r.name }, true, "no-op (already owned)");
            } else {
              this._auditWrite("ADD_ITEM", { name: eff.name }, false, r?.error);
              await this._warnCreateFailed("item", eff.name, r?.error, r?.suggestion);
            }
            break;
          }
          case "create_foe": {
            // Foe spawning is the default-on creation (low-risk GM convenience):
            // allowed unless aiCreatesContent is "off".
            const mode = Settings.get("aiCreatesContent") ?? "foes";
            if (mode === "off") {
              this._auditWrite("CREATE_FOE", { name: eff.name }, false, "disabled (aiCreatesContent=off)");
              break;
            }
            r = await IronswornController.createFoeActor(eff.name, { rank: eff.rank, important: eff.important });
            if (r?.ok) {
              const tag = r.source === "compendium" ? " [official]" : " [custom]";
              const rk = r.rank ? ` [${r.rank}]` : "";
              applied.push(`👹 spawned foe “${r.name}”${rk}${tag}`);
              this._notifyCombat(`👹 Foe spawned: ${r.name}${rk}${r.source === "compendium" ? ", official" : ""}`);
              this._auditWrite("CREATE_FOE", { name: r.name }, true, `${r.source}${r.match ? `, matched ${r.match}` : ""}`);
              // Advisory: a custom foe that wasn't flagged important but has a
              // close compendium name — suggest the catalogue foe to the GM.
              if (r.source === "custom" && r.suggestion && !eff.important) {
                try {
                  await Chat.postSystem(
                    `<em>👹 “${escapeHtml(eff.name)}” was spawned as a custom foe. `
                    + `Closest official foe: “${escapeHtml(r.suggestion)}”.</em>`,
                    { gmWhisper: true }
                  );
                } catch (_) { /* advisory only */ }
              }
            } else {
              this._auditWrite("CREATE_FOE", { name: eff.name }, false, r?.error);
              await this._warnCreateFailed("foe", eff.name, r?.error, r?.suggestion);
            }
            break;
          }
          case "create_character": {
            const mode = Settings.get("aiCreatesContent") ?? "foes";
            if (mode !== "full") {
              this._auditWrite("CREATE_CHARACTER", { name: eff.name }, false, `disabled (aiCreatesContent=${mode})`);
              break;
            }
            r = await IronswornController.createCharacter(eff.name);
            if (r?.ok) {
              applied.push(`🧝 created character “${r.name}”`);
              this._notifyCombat(`🧝 Character created: ${r.name}`);
              this._auditWrite("CREATE_CHARACTER", { name: r.name }, true, `id=${r.actorId}`);
            } else {
              this._auditWrite("CREATE_CHARACTER", { name: eff.name }, false, r?.error);
              await this._warnCreateFailed("character", eff.name, r?.error);
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
            // (fix — narrative conclusion) Resolve the foe track even when the
            // AI omits or paraphrases the foe name while narrating the fight's
            // end ("the beast falls", "you cut him down"). Try the literal name,
            // then a fuzzy combat-kind match, then the active-combat track, so a
            // narrated conclusion reliably closes the fight without an exact name.
            let foe = eff.name ? IronswornController.findTrackFuzzy(actor, eff.name, "combat") : null;
            if (!foe) { try { foe = IronswornController.getActiveCombat(actor); } catch (_) { foe = null; } }
            r = foe
              ? await IronswornController.completeTrack(actor, foe.id)
              : await IronswornController.completeTrack(actor, eff.name);
            if (r?.ok) {
              applied.push(`ended combat “${r.name}”`);
              this._notifyCombat(`🏆 Combat ended: ${r.name}`);
              // Phase 2 (story-arc tracking): the fight is over — clear the
              // active-combat flag so stale state never lingers. Best-effort.
              try { await IronswornController.clearActiveCombat(actor); } catch (_) {}
            }
            break;
          }
          case "complete_track": {
            // Resolve the ACTUAL track being fulfilled rather than trusting the
            // literal name the AI emitted (it often writes the move name —
            // "Fulfill Your Vow" / "Reach Your Destination" — or omits the name
            // entirely). completeTrackSmart() falls back to the track the last
            // progress move rolled against, then the newest open track of the
            // implied kind (vow / journey). See IronswornController.
            r = await IronswornController.completeTrackSmart(actor, eff.name, eff.trackKind);
            if (r?.ok) {
              applied.push(`completed “${r.name}”`);
              this._notifyCombat(`🏆 Completed: ${r.name}`);
            } else if (r?.error) {
              // Surface a clear GM-only note only when there is genuinely no
              // open track to close (the fallback already covers slightly-off
              // or move-named directives).
              await Chat.postSystem(
                `<strong>Could not mark complete:</strong> ${escapeHtml(r.error)}`,
                { gmWhisper: true }
              );
            }
            break;
          }

          /* ---- v0.10.27 explicit progress-track WRITE directives ---- */
          case "mark_complete": {
            // [[MARK_COMPLETE:kind:Name]] — close a specific, named track. Fuzzy
            // name match constrained to the directive's kind, so a slight
            // paraphrase still resolves but we never close the wrong KIND.
            const track = IronswornController.findTrackFuzzy(actor, eff.name, eff.trackKind);
            if (!track) {
              this._auditWrite("MARK_COMPLETE", eff, false, `no ${eff.trackKind} track matching "${eff.name}"`);
              await Chat.postSystem(
                `<strong>🤖 Skald could not mark complete:</strong> no ${escapeHtml(eff.trackKind)} track matching “${escapeHtml(eff.name)}”.`,
                { gmWhisper: true }
              );
              break;
            }
            if (foundry.utils.getProperty(track, "system.completed")) {
              this._auditWrite("MARK_COMPLETE", eff, true, `"${track.name}" already complete (no-op)`);
              break; // idempotent — nothing to do, no noisy notification
            }
            r = (eff.trackKind === "combat")
              ? await IronswornController.completeTrack(actor, track.id)
              : await IronswornController.completeTrackSmart(actor, track.id, eff.trackKind);
            if (r?.ok) {
              if (eff.trackKind === "combat") { try { await IronswornController.clearActiveCombat(actor); } catch (_) {} }
              applied.push(`completed “${r.name}”`);
              this._auditWrite("MARK_COMPLETE", eff, true, `completed "${r.name}"`);
              await Chat.postSystem(`<em>🤖 Skald marked “${escapeHtml(r.name)}” complete.</em>`, { gmWhisper: true });
            } else {
              this._auditWrite("MARK_COMPLETE", eff, false, r?.error);
            }
            break;
          }
          case "add_progress": {
            // [[ADD_PROGRESS:kind:Name:N]] — add N boxes (N×4 ticks).
            const track = IronswornController.findTrackFuzzy(actor, eff.name, eff.trackKind);
            if (!track) {
              this._auditWrite("ADD_PROGRESS", eff, false, `no ${eff.trackKind} track matching "${eff.name}"`);
              await Chat.postSystem(
                `<strong>🤖 Skald could not add progress:</strong> no ${escapeHtml(eff.trackKind)} track matching “${escapeHtml(eff.name)}”.`,
                { gmWhisper: true }
              );
              break;
            }
            r = await IronswornController.markProgress(actor, track.id, Math.round(Number(eff.boxes) || 0) * 4);
            if (r?.ok) {
              applied.push(`+${eff.boxes} progress on “${r.track}” (${r.boxes}/10)`);
              this._auditWrite("ADD_PROGRESS", eff, true, `"${r.track}" now ${r.boxes}/10`);
            } else {
              this._auditWrite("ADD_PROGRESS", eff, false, r?.error);
            }
            break;
          }
          case "set_progress": {
            // [[SET_PROGRESS:kind:Name:N]] — set track to exactly N boxes.
            const track = IronswornController.findTrackFuzzy(actor, eff.name, eff.trackKind);
            if (!track) {
              this._auditWrite("SET_PROGRESS", eff, false, `no ${eff.trackKind} track matching "${eff.name}"`);
              await Chat.postSystem(
                `<strong>🤖 Skald could not set progress:</strong> no ${escapeHtml(eff.trackKind)} track matching “${escapeHtml(eff.name)}”.`,
                { gmWhisper: true }
              );
              break;
            }
            r = await IronswornController.setProgress(actor, track.id, eff.boxes);
            if (r?.ok) {
              applied.push(`set “${r.track}” to ${r.boxes}/10`);
              this._auditWrite("SET_PROGRESS", eff, true, `"${r.track}" set to ${r.boxes}/10`);
            } else {
              this._auditWrite("SET_PROGRESS", eff, false, r?.error);
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
    if (applied.length && Settings.get("showEffectAnnouncements") !== false) {
      await Chat.postSystem(`<em>The Skald enacts: ${escapeHtml(applied.join("; "))}.</em>`, { gmWhisper: true });
    }
    return applied;
  }
};
