/* =====================================================================
 *  Token Control — The Eternal Skald (v0.16.0)
 *
 *  A self-contained, GM-gated scene/token-write layer. It is the ONLY place
 *  in the module that mutates Token documents on a scene. Following the same
 *  discipline as chronicle/ (journal writes) and the controller (actor writes):
 *  every write is GM-only, bounds-checked, defensive, audit-logged, and
 *  whispered to the GM (engineering-brief invariant #4).
 *
 *  Capabilities (ALL default-OFF — see core/settings.js → `tokenControlEnabled`):
 *    • move a token to absolute scene coordinates (animated);
 *    • move a token relative to itself (N units in a compass direction);
 *    • remove (delete) a token from the scene — with a GM-only confirmation
 *      pop-up before ANY player-owned token is removed (player agency, #3);
 *    • undo the last operation, up to 10 steps (move = restore position,
 *      removal = recreate the exact token document).
 *
 *  Three callers wire into this one engine: chat/commands.js (chat
 *  subcommands), the Skald card UI buttons (data-skald-action), and the AI
 *  narrative directive pipeline in narrative/integration.js. None of them
 *  duplicate write logic — they all route here.
 *
 *  Degrades gracefully: when the feature is disabled, the caller is not a GM,
 *  there is no active scene, or the canvas API is absent, every entry point
 *  is a safe no-op that returns { ok:false, error } and never throws.
 * ===================================================================== */

import { LOG_PREFIX, SKALD_NAME } from "../core/constants.js";
import { Settings } from "../core/settings.js";
import { Chat, escapeHtml } from "../chat/display.js";

const UNDO_LIMIT = 10;

/** Module-level undo ring (most-recent last). Session-scoped, capped at 10. */
const _undoStack = [];

export const TokenControl = {
  /* ---------------------------------------------------------------- *
   *  Gates & small helpers
   * ---------------------------------------------------------------- */

  /** Master feature gate — the whole capability is OFF unless a GM opts in. */
  isEnabled() {
    return Settings.get("tokenControlEnabled") === true;
  },

  /** Are AI narrative-driven token directives permitted? (separate, default OFF) */
  aiTriggersEnabled() {
    return this.isEnabled() && Settings.get("tokenControlAiTriggers") === true;
  },

  /** Configured animation duration in ms (GM-tunable; safe fallback 1000). */
  moveDurationMs() {
    const n = Number(Settings.get("tokenMoveDuration"));
    return Number.isFinite(n) && n >= 0 ? n : 1000;
  },

  _isGM() {
    try { return game?.user?.isGM === true; } catch (_) { return false; }
  },

  /** The scene we operate on (the viewed canvas scene, else the active scene). */
  _scene() {
    try { return canvas?.scene ?? game?.scenes?.active ?? null; } catch (_) { return null; }
  },

  /** Common precondition check shared by every write entry point. */
  _guard() {
    if (!this.isEnabled()) return "Token control is disabled (enable it in the Skald settings).";
    if (!this._isGM())     return "Only the GM may move or remove tokens.";
    if (!this._scene())    return "There is no active scene to act on.";
    return null;
  },

  /**
   * Resolve a token PLACEABLE on the current scene by id, name (case-
   * insensitive, exact then prefix), or the literal "selected"/"target"
   * for the GM's currently controlled/targeted token. Returns null if no
   * unambiguous single match is found.
   */
  findToken(identifier) {
    const scene = this._scene();
    if (!scene) return null;
    const all = (() => {
      try { return canvas?.tokens?.placeables ?? []; } catch (_) { return []; }
    })();
    if (!all.length) return null;

    const id = String(identifier ?? "").trim();
    if (!id) return null;
    const lc = id.toLowerCase();

    if (lc === "selected" || lc === "controlled") {
      const sel = canvas?.tokens?.controlled ?? [];
      return sel.length === 1 ? sel[0] : null;
    }
    if (lc === "target" || lc === "targeted") {
      const tg = Array.from(game?.user?.targets ?? []);
      return tg.length === 1 ? tg[0] : null;
    }

    // Exact id, then exact name, then unique prefix.
    const byId = all.find(t => t?.id === id || t?.document?.id === id);
    if (byId) return byId;
    const exact = all.filter(t => (t?.name ?? "").toLowerCase() === lc);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;            // ambiguous — refuse
    const prefix = all.filter(t => (t?.name ?? "").toLowerCase().startsWith(lc));
    return prefix.length === 1 ? prefix[0] : null;
  },

  /** True when a token is owned by at least one player (non-GM) user. */
  isPlayerOwned(token) {
    try {
      const actor = token?.actor ?? token?.document?.actor;
      if (actor?.hasPlayerOwner === true) return true;
      // Fall back to the token document's own ownership map.
      const own = token?.document?.ownership ?? {};
      return Object.entries(own).some(([uid, lvl]) => {
        if (lvl < 3) return false;                // < OWNER
        const u = game?.users?.get?.(uid);
        return u && !u.isGM;
      });
    } catch (_) { return false; }
  },

  /* ---------------------------------------------------------------- *
   *  PURE parsing/geometry helpers (unit-tested without Foundry)
   * ---------------------------------------------------------------- */

  /** Parse "x,y" / "x, y" / "(x, y)" into {x,y} integers, or null. */
  parseCoords(str) {
    const m = String(str ?? "").match(/-?\d+(?:\.\d+)?\s*[, ]\s*-?\d+(?:\.\d+)?/);
    if (!m) return null;
    const parts = m[0].split(/[, ]+/).map(Number);
    if (parts.length !== 2 || parts.some(n => !Number.isFinite(n))) return null;
    return { x: Math.round(parts[0]), y: Math.round(parts[1]) };
  },

  /** Unit vector for a compass/relative direction, or null. */
  directionVector(dir) {
    switch (String(dir ?? "").toLowerCase()) {
      case "n": case "north": case "up":          return { ux: 0,  uy: -1 };
      case "s": case "south": case "down":        return { ux: 0,  uy:  1 };
      case "e": case "east":  case "right":       return { ux: 1,  uy:  0 };
      case "w": case "west":  case "left":        return { ux: -1, uy:  0 };
      case "ne": case "northeast":                return { ux: 1,  uy: -1 };
      case "nw": case "northwest":                return { ux: -1, uy: -1 };
      case "se": case "southeast":                return { ux: 1,  uy:  1 };
      case "sw": case "southwest":                return { ux: -1, uy:  1 };
      default: return null;
    }
  },

  /**
   * Parse a relative-move tail like "5 feet north", "3 squares NE",
   * "north 5", "2 west". Returns {distance, unit, direction} or null.
   */
  parseRelative(str) {
    const s = String(str ?? "").trim();
    if (!s) return null;
    const dirWord = "(north|south|east|west|ne|nw|se|sw|northeast|northwest|southeast|southwest|n|s|e|w|up|down|left|right)";
    const unitWord = "(feet|foot|ft|squares?|sq|tiles?|cells?|units?|spaces?|px|pixels?)";
    // "<num> [unit] <dir>"  or  "<dir> <num> [unit]"
    let m = s.match(new RegExp(`^(-?\\d+(?:\\.\\d+)?)\\s*${unitWord}?\\s+${dirWord}$`, "i"));
    if (m) return { distance: Number(m[1]), unit: (m[2] || "").toLowerCase(), direction: m[3].toLowerCase() };
    m = s.match(new RegExp(`^${dirWord}\\s+(-?\\d+(?:\\.\\d+)?)\\s*${unitWord}?$`, "i"));
    if (m) return { distance: Number(m[2]), unit: (m[3] || "").toLowerCase(), direction: m[1].toLowerCase() };
    return null;
  },

  /**
   * Convert a (distance, unit, direction) into a pixel delta {dx,dy} for the
   * given grid metrics. `gridSize` = px per square, `gridDistance` = scene
   * units per square (e.g. 5 ft). Square/tile/cell → grid squares; distance
   * units (feet/ft/units) → scene units; px → raw pixels.
   */
  relativePixels({ distance, unit, direction }, gridSize, gridDistance) {
    const vec = this.directionVector(direction);
    if (!vec || !Number.isFinite(distance)) return null;
    const gs = Number(gridSize) > 0 ? Number(gridSize) : 100;
    const gd = Number(gridDistance) > 0 ? Number(gridDistance) : 5;
    let px;
    const u = String(unit || "").toLowerCase();
    if (/^(px|pixel)/.test(u))                       px = distance;
    else if (/^(square|sq|tile|cell|space)/.test(u)) px = distance * gs;
    else                                             px = (distance / gd) * gs; // feet/units (default)
    return { dx: Math.round(vec.ux * px), dy: Math.round(vec.uy * px) };
  },

  /* ---------------------------------------------------------------- *
   *  Undo stack
   * ---------------------------------------------------------------- */

  _pushUndo(entry) {
    _undoStack.push(entry);
    while (_undoStack.length > UNDO_LIMIT) _undoStack.shift();
  },

  undoDepth() { return _undoStack.length; },

  _clampToScene(scene, x, y) {
    try {
      const w = scene?.dimensions?.width ?? scene?.width ?? Infinity;
      const h = scene?.dimensions?.height ?? scene?.height ?? Infinity;
      return {
        x: Math.max(0, Math.min(Number.isFinite(w) ? w : x, x)),
        y: Math.max(0, Math.min(Number.isFinite(h) ? h : y, y))
      };
    } catch (_) { return { x, y }; }
  },

  _audit(verb, name, ok, detail = "") {
    try {
      console.log(`${LOG_PREFIX} [token ${ok ? "✓" : "✗"}] ${verb} "${name}"${detail ? ` — ${detail}` : ""}`);
    } catch (_) { /* never break a write */ }
  },

  async _whisper(html) {
    try { await Chat.postSystem(html, { gmWhisper: true }); } catch (_) {}
  },

  /* ---------------------------------------------------------------- *
   *  WRITE entry points
   * ---------------------------------------------------------------- */

  /** Move a token to absolute scene pixel coordinates (animated). */
  async moveTokenTo(identifier, x, y, { animate = true } = {}) {
    const blocked = this._guard();
    if (blocked) return { ok: false, error: blocked };
    const token = this.findToken(identifier);
    if (!token) return { ok: false, error: `No single token matches “${identifier}”.` };
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: "Invalid coordinates." };

    const scene = this._scene();
    const dest = this._clampToScene(scene, Math.round(x), Math.round(y));
    const doc = token.document;
    const from = { x: doc.x, y: doc.y };
    try {
      await doc.update({ x: dest.x, y: dest.y },
        { animate, animation: { duration: this.moveDurationMs() } });
    } catch (e) {
      this._audit("MOVE", token.name, false, e?.message || String(e));
      return { ok: false, error: `Move failed: ${e?.message ?? e}` };
    }
    this._pushUndo({ type: "move", sceneId: scene?.id, tokenId: doc.id, name: token.name, from });
    this._audit("MOVE", token.name, true, `(${from.x},${from.y})→(${dest.x},${dest.y})`);
    await this._whisper(`<em>${escapeHtml(SKALD_NAME)} moved <strong>${escapeHtml(token.name)}</strong> to (${dest.x}, ${dest.y}).</em>`);
    return { ok: true, name: token.name, from, to: dest };
  },

  /** Move a token relative to itself, e.g. 5 feet north. */
  async moveTokenRelative(identifier, spec, { animate = true } = {}) {
    const blocked = this._guard();
    if (blocked) return { ok: false, error: blocked };
    const token = this.findToken(identifier);
    if (!token) return { ok: false, error: `No single token matches “${identifier}”.` };

    const scene = this._scene();
    const grid = scene?.grid ?? {};
    const delta = this.relativePixels(spec, grid.size, grid.distance);
    if (!delta) return { ok: false, error: "Could not parse the direction/distance." };
    const doc = token.document;
    return this.moveTokenTo(identifier, doc.x + delta.dx, doc.y + delta.dy, { animate });
  },

  /**
   * Remove a token from the scene. Player-owned tokens REQUIRE explicit GM
   * confirmation via a pop-up (unless force:true is supplied by a caller that
   * has already confirmed, e.g. a typed `confirm` chat subcommand).
   */
  async removeToken(identifier, { force = false } = {}) {
    const blocked = this._guard();
    if (blocked) return { ok: false, error: blocked };
    const token = this.findToken(identifier);
    if (!token) return { ok: false, error: `No single token matches “${identifier}”.` };

    const playerOwned = this.isPlayerOwned(token);
    if (playerOwned && !force) {
      const confirmed = await this._confirmPlayerRemoval(token.name);
      if (!confirmed) {
        this._audit("REMOVE", token.name, false, "GM declined player-token removal");
        return { ok: false, cancelled: true, error: "Removal cancelled." };
      }
    }

    const scene = this._scene();
    const doc = token.document;
    let snapshot = null;
    try { snapshot = doc.toObject(); } catch (_) { snapshot = null; }
    try {
      await doc.delete();
    } catch (e) {
      this._audit("REMOVE", token.name, false, e?.message || String(e));
      return { ok: false, error: `Removal failed: ${e?.message ?? e}` };
    }
    if (snapshot) this._pushUndo({ type: "remove", sceneId: scene?.id, name: token.name, data: snapshot });
    this._audit("REMOVE", token.name, true, playerOwned ? "(player-owned, confirmed)" : "");
    await this._whisper(`<em>${escapeHtml(SKALD_NAME)} removed <strong>${escapeHtml(token.name)}</strong> from the scene.</em>`);
    return { ok: true, name: token.name, playerOwned };
  },

  /** Undo the most recent token operation (move restore / removal recreate). */
  async undo() {
    if (!this.isEnabled()) return { ok: false, error: "Token control is disabled." };
    if (!this._isGM())     return { ok: false, error: "Only the GM may undo token operations." };
    const entry = _undoStack.pop();
    if (!entry) return { ok: false, error: "Nothing to undo." };

    try {
      const scene = game?.scenes?.get?.(entry.sceneId) ?? this._scene();
      if (!scene) return { ok: false, error: "The original scene is no longer available." };

      if (entry.type === "move") {
        const doc = scene.tokens?.get?.(entry.tokenId);
        if (!doc) return { ok: false, error: `“${entry.name}” is no longer on the scene.` };
        await doc.update({ x: entry.from.x, y: entry.from.y },
          { animate: true, animation: { duration: this.moveDurationMs() } });
        this._audit("UNDO-MOVE", entry.name, true, `→(${entry.from.x},${entry.from.y})`);
        await this._whisper(`<em>${escapeHtml(SKALD_NAME)} undid the move of <strong>${escapeHtml(entry.name)}</strong>.</em>`);
        return { ok: true, type: "move", name: entry.name };
      }
      if (entry.type === "remove") {
        await scene.createEmbeddedDocuments("Token", [entry.data]);
        this._audit("UNDO-REMOVE", entry.name, true, "recreated");
        await this._whisper(`<em>${escapeHtml(SKALD_NAME)} restored <strong>${escapeHtml(entry.name)}</strong> to the scene.</em>`);
        return { ok: true, type: "remove", name: entry.name };
      }
      return { ok: false, error: "Unknown undo entry." };
    } catch (e) {
      // Re-push so the operation can be retried; undo must be safe.
      _undoStack.push(entry);
      this._audit("UNDO", entry.name, false, e?.message || String(e));
      return { ok: false, error: `Undo failed: ${e?.message ?? e}` };
    }
  },

  /**
   * GM-only yes/no confirmation pop-up before removing a player-owned token.
   * Mirrors the established Skald dialog style (DialogV2 with a classic
   * Dialog fallback). Resolves to a boolean.
   */
  async _confirmPlayerRemoval(name) {
    const content =
      `<div class="eternal-skald-card es-variant-lore"><div class="es-body">` +
      `<p><strong>Remove a player-owned token?</strong></p>` +
      `<p>“<strong>${escapeHtml(name)}</strong>” belongs to a player. Removing it deletes it from the scene.</p>` +
      `<p style="color:var(--color-text-dark-secondary,#888);">You can undo this with <code>!skald undo</code>.</p>` +
      `</div></div>`;
    try {
      const DV2 = foundry?.applications?.api?.DialogV2;
      if (DV2?.confirm) {
        return await DV2.confirm({
          window: { title: "Remove Player Token" },
          content, rejectClose: false, modal: true
        });
      }
    } catch (e) {
      console.warn(LOG_PREFIX, "DialogV2 confirm failed, falling back:", e?.message || e);
    }
    return new Promise((resolve) => {
      try {
        // eslint-disable-next-line no-undef
        new Dialog({
          title: "Remove Player Token",
          content,
          buttons: {
            remove: { icon: '<i class="fas fa-trash"></i>', label: "Remove", callback: () => resolve(true) },
            cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel", callback: () => resolve(false) }
          },
          default: "cancel",
          close: () => resolve(false)
        }).render(true);
      } catch (e) {
        console.error(LOG_PREFIX, "No dialog API available for player-token removal", e);
        resolve(false);
      }
    });
  },

  /* ---------------------------------------------------------------- *
   *  Chat-subcommand front door (parses `move|remove|undo` tails)
   * ---------------------------------------------------------------- */

  /**
   * Detect & handle a token subcommand inside a `!skald …` line. Returns
   * true if the text was a token subcommand (so the caller stops), false
   * to let normal Skald narration proceed. Only fires when the feature is
   * enabled AND the caller is a GM, so it never shadows player narration.
   */
  async handleChatSubcommand(args) {
    if (!this.isEnabled() || !this._isGM()) return false;
    const text = String(args ?? "").trim();
    const verb = text.split(/\s+/)[0]?.toLowerCase();

    if (verb === "undo") {
      const r = await this.undo();
      if (!r.ok) await this._whisper(`<em>Undo: ${escapeHtml(r.error)}</em>`);
      return true;
    }

    if (verb === "tokens" || verb === "panel" || verb === "ui") {
      await this.postPanel();
      return true;
    }

    if (verb === "remove" || verb === "delete") {
      let rest = text.replace(/^(remove|delete)\s+/i, "").trim();
      let force = false;
      if (/\s+confirm$/i.test(rest)) { force = true; rest = rest.replace(/\s+confirm$/i, "").trim(); }
      const name = this._unquote(rest);
      if (!name) { await this._whisper(`<em>Usage: <code>!skald remove &lt;token&gt;</code></em>`); return true; }
      const r = await this.removeToken(name, { force });
      if (!r.ok && !r.cancelled) await this._whisper(`<em>Remove: ${escapeHtml(r.error)}</em>`);
      return true;
    }

    if (verb === "move") {
      const body = text.replace(/^move\s+/i, "").trim();
      // Absolute form: "<token> to <x>,<y>"
      const toSplit = body.split(/\s+to\s+/i);
      if (toSplit.length === 2) {
        const coords = this.parseCoords(toSplit[1]);
        const name = this._unquote(toSplit[0]);
        if (coords && name) {
          const r = await this.moveTokenTo(name, coords.x, coords.y);
          if (!r.ok) await this._whisper(`<em>Move: ${escapeHtml(r.error)}</em>`);
          return true;
        }
      }
      // Relative form: "<token> <distance> <direction>" (try longest token match)
      const rel = this._splitRelative(body);
      if (rel) {
        const r = await this.moveTokenRelative(rel.name, rel.spec);
        if (!r.ok) await this._whisper(`<em>Move: ${escapeHtml(r.error)}</em>`);
        return true;
      }
      await this._whisper(`<em>Usage: <code>!skald move &lt;token&gt; to &lt;x,y&gt;</code> or <code>!skald move &lt;token&gt; &lt;n&gt; &lt;direction&gt;</code></em>`);
      return true;
    }

    return false;   // not a token subcommand → let Skald narrate
  },

  /**
   * Apply an AI narrative directive body, e.g. "move_token Goblin to 500,300",
   * "move_token Goblin 5 north", "remove_token Goblin". Gated by the SEPARATE
   * `tokenControlAiTriggers` opt-in (default OFF). Player-owned removals still
   * trigger the GM confirmation pop-up (force is never set here). Returns a
   * result object; never throws.
   */
  async runFromDirective(body) {
    if (!this.aiTriggersEnabled()) return { ok: false, error: "AI token triggers are disabled." };
    const text = String(body ?? "").trim();
    const verb = text.split(/\s+/)[0]?.toLowerCase();

    if (verb === "remove_token" || /^remove[_\s]token/i.test(text) || verb === "delete_token") {
      const name = this._unquote(text.replace(/^(remove|delete)[_\s]token\s*/i, "").trim());
      if (!name) return { ok: false, error: "remove_token: missing token name." };
      return this.removeToken(name);
    }
    if (verb === "move_token" || /^move[_\s]token/i.test(text)) {
      const rest = text.replace(/^move[_\s]token\s*/i, "").trim();
      const toSplit = rest.split(/\s+to\s+/i);
      if (toSplit.length === 2) {
        const coords = this.parseCoords(toSplit[1]);
        const name = this._unquote(toSplit[0]);
        if (coords && name) return this.moveTokenTo(name, coords.x, coords.y);
      }
      const rel = this._splitRelative(rest);
      if (rel) return this.moveTokenRelative(rel.name, rel.spec);
      return { ok: false, error: "move_token: could not parse target/destination." };
    }
    return { ok: false, error: "Unknown token directive." };
  },

  /* ---------------------------------------------------------------- *
   *  Skald-card UI panel (buttons wired by Integration.wireSuggestionCard)
   * ---------------------------------------------------------------- */

  /**
   * Post the Token Control panel as a GM-whispered Skald card. The buttons
   * use `data-skald-action` so the existing render hook wires them with no
   * extra plumbing. The panel operates on the GM's currently SELECTED token
   * (nudge by one grid square in a direction, remove it) plus a global Undo.
   */
  async postPanel() {
    if (!this.isEnabled() || !this._isGM()) return null;
    const b = (action, label, extra = "") =>
      `<button type="button" class="es-action-move-btn" data-skald-action="${action}"${extra}>${label}</button>`;
    const body =
      `<p>Select a token on the canvas, then nudge or remove it. Moves and removals can be undone (up to ${UNDO_LIMIT} steps).</p>` +
      `<div class="es-token-nudge" style="display:flex;gap:.25em;flex-wrap:wrap;margin:.4em 0;">` +
        b("token-nudge", "▲ N", ' data-dir="north"') +
        b("token-nudge", "▼ S", ' data-dir="south"') +
        b("token-nudge", "◀ W", ' data-dir="west"') +
        b("token-nudge", "▶ E", ' data-dir="east"') +
      `</div>` +
      `<div class="es-token-ops" style="display:flex;gap:.4em;flex-wrap:wrap;">` +
        b("token-remove-selected", '<i class="fas fa-trash"></i> Remove selected') +
        b("token-undo", '<i class="fas fa-rotate-left"></i> Undo last') +
      `</div>`;
    try {
      return await Chat.postSkald(body, { variant: "help", title: "Token Control", gmWhisper: true });
    } catch (_) { return null; }
  },

  /** Nudge the GM's selected token one grid square in a compass direction. */
  async nudgeSelected(direction) {
    return this.moveTokenRelative("selected", { distance: 1, unit: "square", direction });
  },

  /** Strip matching surrounding quotes from a token name. */
  _unquote(s) {
    const t = String(s ?? "").trim();
    const m = t.match(/^["'“”](.+)["'“”]$/);
    return (m ? m[1] : t).trim();
  },

  /**
   * Split a "move" relative body into {name, spec} by peeling the trailing
   * "<distance> <direction>" (or "<direction> <distance>") off the end and
   * treating the remainder as the token name.
   */
  _splitRelative(body) {
    const s = String(body ?? "").trim();
    // Try progressively shorter token names from the right.
    const tokens = s.split(/\s+/);
    for (let cut = tokens.length - 1; cut >= 1; cut--) {
      const name = this._unquote(tokens.slice(0, cut).join(" "));
      const tail = tokens.slice(cut).join(" ");
      const spec = this.parseRelative(tail);
      if (name && spec) return { name, spec };
    }
    return null;
  }
};
