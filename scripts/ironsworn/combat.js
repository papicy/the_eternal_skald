/* =====================================================================
 *  THE ETERNAL SKALD — Ironsworn controller submodule
 *  Combat tracks, initiative & foe / enemy compendium lookups.
 *
 *  Extracted verbatim from the former monolithic ironsworn-controller.js
 *  (Phase B / H2 decomposition). These methods are composed onto the single
 *  IronswornController facade via Object.assign in ironsworn-controller.js,
 *  so `this` inside every method still resolves to that one shared object —
 *  cross-method calls (this.getActiveCharacter(), this._foeIndexCache, …)
 *  and shared cache state are unchanged. No behaviour change.
 * ===================================================================== */

import {
  ES_SCOPE, RANK_TO_NUM, dbg, warn
} from "./internals.js";

export const CombatMethods = {


  /**
   * (v0.10.26 — Phase 1 context) The single ACTIVE combat track, if the
   * character is currently fighting. Ironsworn is fought one foe at a time, so
   * there is at most one active combat. Thin, clearly-named wrapper over
   * {@link getActiveCombatTrack} provided for the Phase-1 context surface;
   * READ-ONLY.
   *
   * @param {Actor} actor
   * @returns {{id:string,name:string,rank:(string|number|null),current:number,
   *   boxes:number,completed:boolean}|null}  null when no fight is active.
   */
  getActiveCombat(actor) {
    // Phase 2 (story-arc tracking): prefer the explicitly-tracked active combat
    // flag (set when a fight begins) when it still points at an OPEN combat
    // track on this actor. Fall back to the newest-open heuristic otherwise, so
    // sheet-made foes and legacy data still resolve.
    const flagged = this.getActiveCombatFlagTrack(actor);
    if (flagged) return flagged;
    return this.getActiveCombatTrack(actor);
  },

  /**
   * The active-combat flag resolved to a combat track summary, validated to
   * still be an open combat track on this actor. Returns null when
   * unset/stale/completed. READ-ONLY.
   */
  getActiveCombatFlagTrack(actor) {
    if (!actor?.items) return null;
    const id = this._activeFlagId(actor, "activeCombat");
    if (!id) return null;
    const item = actor.items.get?.(id);
    if (!item) return null;
    if (foundry.utils.getProperty(item, "system.completed")) return null;
    const kind = item.getFlag?.(ES_SCOPE, "trackKind")
              ?? foundry.utils.getProperty(item, `flags.${ES_SCOPE}.trackKind`);
    const subtype = String(foundry.utils.getProperty(item, "system.subtype") ?? "").toLowerCase();
    if (kind !== "combat" && subtype !== "foe") return null;
    const current = foundry.utils.getProperty(item, "system.current") ?? 0;
    return {
      id: item.id,
      name: item.name,
      rank: foundry.utils.getProperty(item, "system.rank") ?? null,
      current,
      boxes: Math.floor(current / 4),
      completed: false
    };
  },

  /**
   * Remember which fight is currently active. Accepts an Item id, track name,
   * or track-like object. Validates it resolves to a combat track on this
   * actor. Best-effort; never throws.
   * @returns {Promise<{ok:boolean, id?:string, name?:string, error?:string}>}
   */
  async setActiveCombat(actor = this.getActiveCharacter(), combatRef = null) {
    if (!actor) return { ok: false, error: "No actor." };
    try {
      if (combatRef == null) {
        await actor.unsetFlag?.(ES_SCOPE, "activeCombat");
        return { ok: true, id: null };
      }
      const ref = (combatRef && typeof combatRef === "object") ? (combatRef.id ?? combatRef.name) : combatRef;
      const item = this.findTrack(actor, ref);
      if (!item) return { ok: false, error: `No track matching "${ref}".` };
      await actor.setFlag?.(ES_SCOPE, "activeCombat", item.id);
      dbg(`setActiveCombat: ${actor.name} → "${item.name}" (${item.id})`);
      return { ok: true, id: item.id, name: item.name };
    } catch (e) {
      warn("setActiveCombat failed:", e?.message ?? e);
      return { ok: false, error: e?.message ?? String(e) };
    }
  },

  /** Clear the active-combat flag (e.g. when a fight ends). Best-effort. */
  async clearActiveCombat(actor = this.getActiveCharacter()) {
    return this.setActiveCombat(actor, null);
  },

  /* =================================================================
   *  COMBAT TRACKS & INITIATIVE
   * ================================================================= */

  /**
   * All combat (foe) progress tracks on the actor — i.e. tracks the Skald
   * created with trackKind "combat". Each entry: { id, name, rank, current,
   * boxes, completed }. Most-recently-created first.
   */
  getCombatTracks(actor) {
    if (!actor?.items) return [];
    const out = [];
    for (const item of actor.items) {
      if (item.type !== "progress") continue;
      const kind = item.getFlag?.(ES_SCOPE, "trackKind")
                ?? foundry.utils.getProperty(item, `flags.${ES_SCOPE}.trackKind`);
      // A combat track is one we tagged trackKind "combat", OR any progress
      // Item carrying the system's own foe subtype (so foes added directly on
      // the sheet / via the foe browser are recognised too — the "vice versa"
      // direction of the integration).
      const subtype = String(foundry.utils.getProperty(item, "system.subtype") ?? "").toLowerCase();
      if (kind !== "combat" && subtype !== "foe") continue;
      const current = foundry.utils.getProperty(item, "system.current") ?? 0;
      out.push({
        id: item.id,
        name: item.name,
        rank: foundry.utils.getProperty(item, "system.rank") ?? null,
        current,
        boxes: Math.floor(current / 4),
        completed: foundry.utils.getProperty(item, "system.completed") ?? false
      });
    }
    // createEmbeddedDocuments preserves order; reverse for newest-first.
    return out.reverse();
  },

  /** The newest active (not-completed) combat track, or null. */
  getActiveCombatTrack(actor) {
    return this.getCombatTracks(actor).find(t => !t.completed) ?? null;
  },

  /**
   * Close (mark completed) every active combat track on the actor, optionally
   * excluding one by id. Ironsworn is fought one foe at a time, so when a new
   * combat begins we tidy up any foe tracks that were left open — the AI does
   * not always emit an explicit `end_combat` when a previous fight fizzles
   * out, which otherwise leaves orphaned, untracked combat tracks behind
   * (progress marking only ever targets the newest active track).
   *
   * @param {Actor}  actor
   * @param {object} [opts]
   * @param {string[]|Set<string>} [opts.onlyIds=null]  if given, restrict
   *                 closing to these track ids (e.g. combats that existed
   *                 BEFORE the current effect batch, so multiple foes
   *                 introduced in the same reply don't close each other).
   * @param {string} [opts.exceptId=null]  combat-track id to leave open.
   * @returns {Promise<{ok:boolean, closed:string[], error?:string}>}
   */
  async closeStaleCombatTracks(actor, { onlyIds = null, exceptId = null } = {}) {
    if (!actor) return { ok: false, closed: [], error: "No actor." };
    const allow = onlyIds ? new Set(onlyIds) : null;
    const stale = this.getCombatTracks(actor)
      .filter(t => !t.completed && t.id !== exceptId && (!allow || allow.has(t.id)));
    const closed = [];
    for (const t of stale) {
      const item = actor.items?.get(t.id);
      if (!item) continue;
      try {
        await item.update({ "system.completed": true });
        closed.push(t.name);
      } catch (e) {
        warn("closeStaleCombatTracks: failed to close", t.name, e?.message ?? e);
      }
    }
    if (closed.length) {
      dbg(`closeStaleCombatTracks: closed ${closed.length} stale combat track(s): ${closed.join(", ")}`);
    }
    return { ok: true, closed };
  },

  /**
   * LEGACY REPAIR (combat-foe labelling fix): older Skald builds stored combat
   * tracks with `system.subtype="foe"`, which renders the raw key
   * "IRONSWORN.ITEM.SubtypeFoe" as the label on the *character* sheet (only
   * vow/progress/connection subtypes are localized there). New combat tracks are
   * created with subtype "progress" (+ trackKind "combat" flag) so they label
   * cleanly. This idempotent, additive repair migrates any pre-existing
   * combat-flagged tracks still carrying subtype "foe" to subtype "progress".
   *
   * It is intentionally driven from a WRITE path (the create_combat handler),
   * never from a read/describe path. Only touches tracks WE tagged
   * trackKind="combat"; never rewrites a real foe-Actor's own progress item.
   *
   * @returns {Promise<{ok:boolean, fixed:string[], error?:string}>}
   */
  async normalizeCombatTrackSubtypes(actor = this.getActiveCharacter()) {
    if (!actor?.items) return { ok: false, fixed: [], error: "No actor." };
    const fixed = [];
    try {
      for (const item of actor.items) {
        if (item.type !== "progress") continue;
        const kind = item.getFlag?.(ES_SCOPE, "trackKind")
                  ?? foundry.utils.getProperty(item, `flags.${ES_SCOPE}.trackKind`);
        if (kind !== "combat") continue; // only our own combat tracks
        const subtype = String(foundry.utils.getProperty(item, "system.subtype") ?? "").toLowerCase();
        if (subtype !== "foe") continue; // already migrated / nothing to do
        try {
          await item.update({ "system.subtype": "progress" });
          fixed.push(item.name);
        } catch (e) {
          warn("normalizeCombatTrackSubtypes: failed to migrate", item.name, e?.message ?? e);
        }
      }
    } catch (e) {
      return { ok: false, fixed, error: e?.message ?? String(e) };
    }
    if (fixed.length) {
      dbg(`normalizeCombatTrackSubtypes: migrated ${fixed.length} legacy combat track(s) to subtype "progress": ${fixed.join(", ")}`);
    }
    return { ok: true, fixed };
  },

  /**
   * Whether the character currently has initiative ("in control" in
   * Ironsworn terms). Stored as a Skald flag on the actor so it persists
   * across sessions. Also honours the system's own field if present.
   */
  hasInitiative(actor = this.getActiveCharacter()) {
    if (!actor) return false;
    try {
      const flag = actor.getFlag?.(ES_SCOPE, "hasInitiative");
      if (typeof flag === "boolean") return flag;
      // Best-effort: some data models expose an initiative/inControl field.
      const sys = foundry.utils.getProperty(actor, "system.initiative");
      if (typeof sys === "boolean") return sys;
    } catch (_) {}
    return false;
  },

  /**
   * Set the character's initiative (in-control) state.
   * @returns {Promise<{ok:boolean, value?:boolean, error?:string}>}
   */
  async setInitiative(actor = this.getActiveCharacter(), value = true) {
    if (!actor) return { ok: false, error: "No actor." };
    const v = !!value;
    try {
      await actor.setFlag?.(ES_SCOPE, "hasInitiative", v);
      dbg(`setInitiative: ${actor.name} → ${v ? "in control" : "in a bad spot"}`);
      return { ok: true, value: v };
    } catch (e) {
      warn("setInitiative failed:", e?.message ?? e);
      return { ok: false, error: e?.message ?? String(e) };
    }
  },

  /**
   * Compact, AI-friendly description of the live combat state: who has
   * initiative, active foe tracks with progress, and recently-finished
   * fights. Returns "" when there is nothing combat-related to report.
   */
  describeCombatState(actor = this.getActiveCharacter()) {
    if (!this.isActive() || !actor) return "";
    const tracks = this.getCombatTracks(actor);
    if (!tracks.length) return "";

    const active = tracks.filter(t => !t.completed);
    const done   = tracks.filter(t => t.completed);
    const lines = [];

    lines.push(`Initiative: ${this.hasInitiative(actor) ? "YOU are in control" : "you are in a bad spot (foe has initiative)"}.`);

    if (active.length) {
      lines.push("Active foes (combat progress tracks):");
      for (const t of active) {
        const rank = t.rank ? ` [${t.rank}]` : "";
        lines.push(`  - ${t.name}${rank}: ${t.boxes}/10 boxes filled (${t.current}/40 ticks)`);
      }
    }
    if (done.length) {
      lines.push(`Recently ended fights: ${done.slice(0, 5).map(t => t.name).join(", ")}.`);
    }
    return lines.join("\n");
  },

  /** Drop the cached foe index (e.g. after enabling a foe module mid-session). */
  clearEnemyCache() {
    this._foeIndexCache = null;
    dbg("clearEnemyCache: foe index cache cleared");
  },

  /**
   * Item compendium packs that look like foe/encounter catalogs. Covers
   * Ironsworn Foes, Delve Foes, and Starforged Encounters, plus any
   * third-party pack whose id/label mentions foes or bestiary.
   */
  _foePacks() {
    const out = [];
    for (const pack of (game?.packs ?? [])) {
      try {
        if (pack.documentName !== "Item") continue;
        const id = String(pack.metadata?.id ?? pack.collection ?? "");
        const label = String(pack.metadata?.label ?? pack.title ?? "");
        if (/foe|encounter|bestiar|monster/i.test(id) || /foe|encounter|bestiar|monster/i.test(label)) {
          out.push(pack);
        }
      } catch (_) {}
    }
    return out;
  },

  /**
   * Build (and cache) a flat index of every foe entry across the foe
   * packs: [{ name, lc, rank, packId }]. `rank` is already normalised to
   * a canonical rank word. Entries without a usable numeric/string rank
   * (category headers etc.) are skipped.
   */
  async _buildFoeIndex() {
    if (Array.isArray(this._foeIndexCache)) return this._foeIndexCache;
    const entries = [];
    for (const pack of this._foePacks()) {
      try {
        // Ask the index to carry the rank + type fields so we usually
        // avoid loading full documents.
        const index = await pack.getIndex({ fields: ["system.rank", "type", "system.subtype"] });
        for (const e of index) {
          const rawRank = foundry.utils.getProperty(e, "system.rank");
          if (rawRank === undefined || rawRank === null || rawRank === "") continue;
          const rank = this.normalizeRank(rawRank, null);
          if (!rank) continue;
          entries.push({
            name: e.name,
            lc: String(e.name ?? "").toLowerCase(),
            rank,
            packId: String(pack.metadata?.id ?? pack.collection ?? "")
          });
        }
      } catch (e) {
        warn(`_buildFoeIndex: failed to index "${pack?.metadata?.id}":`, e?.message ?? e);
      }
    }
    this._foeIndexCache = entries;
    dbg(`_buildFoeIndex: indexed ${entries.length} foe entries from ${this._foePacks().length} pack(s)`);
    return entries;
  },

  /** Strip punctuation/articles and collapse whitespace for fuzzy compares. */
  _normName(s) {
    return String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\b(the|a|an|of|some)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  },

  /**
   * Damerau-Levenshtein distance (small strings) for typo tolerance.
   * Counts an adjacent transposition (e.g. "er" ↔ "re") as a single edit,
   * which models the most common kind of human typo more fairly than plain
   * Levenshtein (so "wyvrenn" is only 2 edits from "wyvern", not 3).
   */
  _editDistance(a, b) {
    a = String(a); b = String(b);
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    // Full matrix so we can reference the i-2 / j-2 row for transpositions.
    const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) d[i][0] = i;
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(
          d[i - 1][j] + 1,         // deletion
          d[i][j - 1] + 1,         // insertion
          d[i - 1][j - 1] + cost   // substitution
        );
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // transposition
        }
      }
    }
    return d[m][n];
  },

  /**
   * Look up an enemy by name in the foe compendia.
   * Matching, best → worst: exact (case-insensitive) → normalised-equal →
   * substring (either direction) → token overlap → close edit-distance.
   *
   * @param {string} enemyName
   * @returns {Promise<{found:boolean, name:string|null, rank:string|null,
   *   matchedName?:string, packId?:string, match?:string, suggestion?:string}>}
   */
  async lookupEnemyInCompendium(enemyName) {
    const result = { found: false, name: enemyName ?? null, rank: null };
    if (!enemyName || !this.isActive()) return result;
    let index;
    try { index = await this._buildFoeIndex(); }
    catch (e) { warn("lookupEnemyInCompendium failed:", e?.message ?? e); return result; }
    if (!index.length) return result;

    const lc = String(enemyName).toLowerCase().trim();
    const norm = this._normName(enemyName);

    // 1. Exact (case-insensitive).
    let hit = index.find(e => e.lc === lc);
    let match = hit ? "exact" : null;

    // 2. Normalised equal ("Bandit." / "the Bandit" → "bandit").
    if (!hit) { hit = index.find(e => this._normName(e.name) === norm); if (hit) match = "normalized"; }

    // 3. Substring either direction ("iron bear" ⊇ "bear"; "bear" ⊆ "cave bear").
    if (!hit && norm) {
      const subs = index.filter(e => {
        const en = this._normName(e.name);
        return en && (en.includes(norm) || norm.includes(en));
      });
      if (subs.length) {
        // Prefer the entry whose name is closest in length to the query.
        subs.sort((a, b) => Math.abs(this._normName(a.name).length - norm.length)
                          - Math.abs(this._normName(b.name).length - norm.length));
        hit = subs[0]; match = "substring";
      }
    }

    // 4. Token overlap (share a significant word, e.g. "giant spider" vs "spider").
    if (!hit && norm) {
      const qTokens = new Set(norm.split(" ").filter(t => t.length >= 3));
      let best = null, bestScore = 0;
      for (const e of index) {
        const eTokens = this._normName(e.name).split(" ").filter(t => t.length >= 3);
        const overlap = eTokens.filter(t => qTokens.has(t)).length;
        if (overlap > bestScore) { bestScore = overlap; best = e; }
      }
      if (best && bestScore > 0) { hit = best; match = "token"; }
    }

    // 5. Fuzzy edit-distance (typos: "wyvrenn" → "wyvern").
    if (!hit && norm.length >= 4) {
      let best = null, bestDist = Infinity;
      for (const e of index) {
        const d = this._editDistance(norm, this._normName(e.name));
        if (d < bestDist) { bestDist = d; best = e; }
      }
      // Accept only close matches (≤ ~25% of the length, min 2, max 3).
      const tol = Math.min(3, Math.max(2, Math.floor(norm.length * 0.25)));
      if (best && bestDist <= tol) { hit = best; match = "fuzzy"; }
      else if (best && bestDist <= tol + 2) {
        result.suggestion = best.name; // close but not close enough — surface as a hint
        dbg(`lookupEnemyInCompendium: "${enemyName}" no confident match; closest "${best.name}" (dist ${bestDist})`);
      }
    }

    if (hit) {
      dbg(`lookupEnemyInCompendium: "${enemyName}" → "${hit.name}" [${hit.rank}] via ${match} (${hit.packId})`);
      return { found: true, name: hit.name, rank: hit.rank, matchedName: hit.name, packId: hit.packId, match };
    }
    return result;
  },

  /**
   * Resolve the official challenge rank for an enemy from the compendium.
   * Returns a canonical rank word if a confident match is found, otherwise
   * null (so the caller can use an AI-specified rank or the default).
   *
   * @param {string} enemyName
   * @returns {Promise<string|null>}
   */
  async getEnemyRank(enemyName) {
    const r = await this.lookupEnemyInCompendium(enemyName);
    return r.found ? r.rank : null;
  },

  /**
   * True iff a pack id is one of the two official foe packs. Tolerant of both
   * the fully-qualified id ("foundry-ironsworn.ironswornfoes") and the bare
   * collection segment ("ironswornfoes"), across Foundry revisions.
   */
  _isOfficialFoePackId(id) {
    const s = String(id ?? "").toLowerCase();
    return s === "foundry-ironsworn.ironswornfoes"
        || s === "foundry-ironsworn.ironsworndelvefoes"
        || /(^|\.)ironswornfoes$/.test(s)
        || /(^|\.)ironsworndelvefoes$/.test(s);
  },

  /**
   * Synchronous read of the cached OFFICIAL compendium foe names (+ canonical
   * ranks), restricted to the two official foe packs (ironswornfoes +
   * ironsworndelvefoes). For prompt building, which is synchronous. Returns []
   * until {@link _buildFoeIndex} has populated the cache (primed on `ready`),
   * so it degrades gracefully — the foe catalogue simply isn't added to the
   * prompt until the compendia are indexed. De-duplicated and name-sorted.
   *
   * @returns {Array<{name:string, rank:string}>}
   */
  getCompendiumFoeNames() {
    if (!Array.isArray(this._foeIndexCache)) return [];
    const seen = new Set();
    const out = [];
    for (const e of this._foeIndexCache) {
      if (!this._isOfficialFoePackId(e.packId)) continue;
      const key = e.lc || String(e.name ?? "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ name: e.name, rank: e.rank });
    }
    out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return out;
  },

  /**
   * True iff `enemyName` confidently matches a foe in the OFFICIAL foe
   * compendia (the two packs above). Used for the optional "this regular foe
   * isn't a real compendium foe" advisory. Async (it may build the index).
   *
   * @param {string} enemyName
   * @returns {Promise<boolean>}
   */
  async isOfficialCompendiumFoe(enemyName) {
    if (!enemyName || !this.isActive()) return false;
    try {
      const r = await this.lookupEnemyInCompendium(enemyName);
      return !!(r.found && this._isOfficialFoePackId(r.packId));
    } catch (_) { return false; }
  },

  /** Drop the cached foe-actor index. */
  clearFoeActorCache() { this._foeActorIndexCache = null; dbg("clearFoeActorCache: cleared"); },

  /** Actor compendium packs that look like foe/bestiary catalogs. */
  _foeActorPacks() {
    const out = [];
    for (const pack of (game?.packs ?? [])) {
      try {
        if (pack.documentName !== "Actor") continue;
        const id = String(pack.metadata?.id ?? pack.collection ?? "");
        const label = String(pack.metadata?.label ?? pack.title ?? "");
        if (/foe|encounter|bestiar|monster|npc/i.test(id) || /foe|encounter|bestiar|monster|npc/i.test(label)) out.push(pack);
      } catch (_) {}
    }
    return out;
  },

  /**
   * Build (and cache) a flat index of every foe actor: [{name, lc, uuid, packId, _id}].
   * Skips folder-only entries. Never throws — returns [] on failure.
   * @returns {Promise<Array<{name:string, lc:string, uuid:string, packId:string, _id:string}>>}
   */
  async _buildFoeActorIndex() {
    if (Array.isArray(this._foeActorIndexCache)) return this._foeActorIndexCache;
    const entries = [];
    for (const pack of this._foeActorPacks()) {
      try {
        const index = await pack.getIndex({ fields: ["type"] });
        const packId = String(pack.metadata?.id ?? pack.collection ?? "");
        for (const e of (index?.contents ?? index ?? [])) {
          const name = (e?.name ?? "").trim();
          if (!name) continue;
          // Folders surface as entries without a usable actor type; skip them.
          if (e.type && e.type !== "foe" && e.type !== "npc") continue;
          entries.push({ name, lc: name.toLowerCase(), uuid: e.uuid ?? `Compendium.${packId}.${e._id}`, packId, _id: e._id });
        }
      } catch (e) {
        warn(`_buildFoeActorIndex: failed to index "${pack?.metadata?.id}":`, e?.message ?? e);
      }
    }
    this._foeActorIndexCache = entries;
    dbg(`_buildFoeActorIndex: indexed ${entries.length} foe actor(s) from ${this._foeActorPacks().length} pack(s)`);
    return entries;
  },

  /**
   * Fuzzy-look up a foe actor by name in the foe-actor compendia. Mirrors
   * lookupAssetInCompendium's matching ladder. Async.
   * @param {string} foeName
   * @returns {Promise<{found:boolean, name:string|null, uuid?:string, packId?:string, match?:string, suggestion?:string}>}
   */
  async lookupFoeActorInCompendium(foeName) {
    const result = { found: false, name: foeName ?? null };
    if (!foeName || !this.isActive()) return result;
    let index;
    try { index = await this._buildFoeActorIndex(); }
    catch (e) { warn("lookupFoeActorInCompendium failed:", e?.message ?? e); return result; }
    if (!index.length) return result;

    const lc = String(foeName).toLowerCase().trim();
    const norm = this._normName(foeName);
    let hit = index.find(e => e.lc === lc); let match = hit ? "exact" : null;
    if (!hit) { hit = index.find(e => this._normName(e.name) === norm); if (hit) match = "normalized"; }
    if (!hit && norm) {
      const subs = index.filter(e => { const en = this._normName(e.name); return en && (en.includes(norm) || norm.includes(en)); });
      if (subs.length) {
        subs.sort((a, b) => Math.abs(this._normName(a.name).length - norm.length) - Math.abs(this._normName(b.name).length - norm.length));
        hit = subs[0]; match = "substring";
      }
    }
    if (!hit && norm.length >= 4) {
      let best = null, bestDist = Infinity;
      for (const e of index) { const d = this._editDistance(norm, this._normName(e.name)); if (d < bestDist) { bestDist = d; best = e; } }
      const tol = Math.min(3, Math.max(2, Math.floor(norm.length * 0.25)));
      if (best && bestDist <= tol) { hit = best; match = "fuzzy"; }
      else if (best && bestDist <= tol + 2) result.suggestion = best.name;
    }
    if (hit) {
      dbg(`lookupFoeActorInCompendium: "${foeName}" → "${hit.name}" via ${match} (${hit.packId})`);
      return { found: true, name: hit.name, uuid: hit.uuid, packId: hit.packId, match };
    }
    return result;
  },

  /**
   * Create a FOE ACTOR in the world. Preference order:
   *   1. A real foe actor copied from the foe-actor compendia (carries the
   *      rulebook's rank, features, drives, tactics and progress track).
   *   2. If not found, a minimal custom foe actor (type "foe") with a single
   *      embedded progress track at the requested/fuzzy-looked-up/default rank
   *      — so an important narrative antagonist can still be spawned.
   *
   * @param {string} foeName
   * @param {{rank?:string, important?:boolean, folder?:string}} [opts]
   * @returns {Promise<{ok:boolean, name?:string, actorId?:string, uuid?:string, source?:"compendium"|"custom", rank?:string, match?:string, suggestion?:string, error?:string}>}
   */
  async createFoeActor(foeName, { rank = null, important = false, folder = null } = {}) {
    if (!this.isActive()) return { ok: false, error: "Ironsworn system not active." };
    if (!foeName) return { ok: false, error: "No foe name given." };
    if (typeof Actor === "undefined" || typeof Actor.create !== "function") {
      return { ok: false, error: "Actor.create is unavailable." };
    }

    // 1) Try a real foe actor from the compendia.
    let lookup = null;
    try { lookup = await this.lookupFoeActorInCompendium(foeName); }
    catch (_) { /* fall through to custom */ }

    if (lookup?.found && lookup.uuid) {
      try {
        const doc = await fromUuid(lookup.uuid);
        if (doc) {
          const data = this._cleanForCreate(doc);
          if (folder) data.folder = folder;
          const created = await Actor.create(data);
          // The rulebook rank lives on the embedded progress item.
          let foundRank = null;
          try {
            const prog = created?.items?.find?.(it => it.type === "progress");
            const rn = prog ? foundry.utils.getProperty(prog, "system.rank") : null;
            foundRank = rn != null ? this.normalizeRank(rn, null) : null;
          } catch (_) {}
          dbg(`createFoeActor: spawned "${lookup.name}" from compendium (id=${created?.id})`);
          return { ok: true, name: created?.name ?? lookup.name, actorId: created?.id, uuid: created?.uuid, source: "compendium", rank: foundRank, match: lookup.match };
        }
      } catch (e) {
        warn("createFoeActor: compendium copy failed, will try custom:", e?.message ?? e);
      }
    }

    // 2) Custom foe actor with a fresh progress track.
    const rankWord = this.normalizeRank(rank || "dangerous");
    const rankNum = RANK_TO_NUM[rankWord] ?? RANK_TO_NUM.dangerous;
    const itemType = this._pickItemType(["progress"]);
    const data = {
      name: foeName,
      type: "foe",
      system: {},
      items: [{
        name: foeName,
        type: itemType,
        system: { subtype: "progress", rank: rankNum, current: 0, completed: false, hasTrack: true },
        flags: { [ES_SCOPE]: { trackKind: "foe", createdBy: "eternal-skald" } }
      }],
      flags: { [ES_SCOPE]: { createdBy: "eternal-skald", custom: true } }
    };
    if (folder) data.folder = folder;
    try {
      const created = await Actor.create(data);
      dbg(`createFoeActor: created custom foe "${foeName}" [${rankWord}] (id=${created?.id})`);
      return { ok: true, name: created?.name ?? foeName, actorId: created?.id, uuid: created?.uuid, source: "custom", rank: rankWord, suggestion: lookup?.suggestion };
    } catch (e) {
      warn("createFoeActor failed:", e?.message ?? e);
      return { ok: false, error: e?.message ?? String(e) };
    }
  }
};
