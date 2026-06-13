/* =====================================================================
 *  THE ETERNAL SKALD — Ironsworn controller submodule
 *  Progress tracks, vows, journeys, milestones & experience.
 *
 *  Extracted verbatim from the former monolithic ironsworn-controller.js
 *  (Phase B / H2 decomposition). These methods are composed onto the single
 *  IronswornController facade via Object.assign in ironsworn-controller.js,
 *  so `this` inside every method still resolves to that one shared object —
 *  cross-method calls (this.getActiveCharacter(), this._foeIndexCache, …)
 *  and shared cache state are unchanged. No behaviour change.
 * ===================================================================== */

import {
  ES_SCOPE, RANKS, RANK_TICKS, RANK_NUM, RANK_TO_NUM, RANK_XP, dbg, warn
} from "./internals.js";

export const ProgressMethods = {


  /* ===================================================================
   *  EXPERIENCE (XP) GRANTING — Phase 1
   *  -----------------------------------------------------------------
   *  WRITE counterpart to getExperience(). All experience awards in the
   *  module funnel through grantXp() so the behaviour stays consistent
   *  and auditable. Two write models, chosen by the active ruleset:
   *    • classic    → increments the integer `system.xp` counter
   *                   (Ironsworn classic & Delve).
   *    • starforged → marks ticks on a legacy track under
   *                   `system.legacies` (Starforged & Sundered Isles).
   *  Both go through actor.update() (never direct mutation) so the
   *  system stays the single source of truth and fires its own hooks.
   * ================================================================= */

  /**
   * Experience earned for fulfilling a vow / progress track of a given rank.
   * Mirrors IronswornData.xpForRank so callers that only hold the controller
   * still have it. Strong hit = rank value (Troublesome 1 … Epic 5). Per the
   * Ironsworn SRD / Datasworn "Fulfill Your Vow" move, a weak hit marks
   * experience equal to the rank value MINUS ONE, floored at 0
   * (troublesome 0, dangerous 1, formidable 2, extreme 3, epic 4).
   *
   * @param {string|number} rank canonical rank word or numeric ChallengeRank.
   * @param {{weakHit?: boolean}} [opts]
   * @returns {number} whole XP (0 for an unknown rank).
   */
  xpForRank(rank, { weakHit = false } = {}) {
    let key = (typeof rank === "number") ? RANK_NUM[rank] : String(rank ?? "").toLowerCase().trim();
    const base = RANK_XP[key] ?? 0;
    if (!base) return 0;
    return weakHit ? Math.max(0, base - 1) : base;
  },

  /**
   * Award experience to a character through the system's data model. THE
   * single XP-write entry point. Never throws; always returns a result object.
   *
   * @param {Actor}  actor
   * @param {number} amount  whole XP to grant (> 0). For the starforged model
   *        this is converted to amount×4 legacy ticks (4 ticks = 1 XP).
   * @param {object} [opts]
   * @param {string} [opts.reason]    short note shown in the GM whisper.
   * @param {"classic"|"starforged"} [opts.mode] force a write model (else
   *        auto-detected via getRuleset()).
   * @param {string} [opts.legacyKey] which legacy track to mark for the
   *        starforged model: "quests" (default) | "bonds" | "discoveries".
   * @param {boolean} [opts.silent]   suppress the GM chat confirmation.
   * @returns {Promise<{ok:boolean, mode?:string, amount?:number,
   *   total?:number, legacyKey?:string, ticks?:number, error?:string}>}
   */
  async grantXp(actor, amount, { reason = "", mode = null, legacyKey = "quests", silent = false } = {}) {
    if (!actor) return { ok: false, error: "No actor." };
    const xp = Math.round(Number(amount));
    if (!Number.isFinite(xp) || xp <= 0) {
      return { ok: false, error: `Invalid XP amount "${amount}".` };
    }

    const ruleset = (mode === "classic" || mode === "starforged") ? mode : this.getRuleset();
    try {
      if (ruleset === "starforged") {
        const key = ["quests", "bonds", "discoveries"].includes(legacyKey) ? legacyKey : "quests";
        const path = `system.legacies.${key}`;
        const cur = foundry.utils.getProperty(actor, path);
        // If this character has no legacy field (mixed/odd data), degrade to
        // the universal classic counter rather than failing the award.
        if (typeof cur !== "number") return this._grantXpClassic(actor, xp, reason, silent);
        const ticks = xp * 4;                 // 4 ticks = 1 XP on a legacy track
        const next = Math.max(0, cur + ticks);
        await actor.update({ [path]: next });
        dbg(`grantXp(starforged): ${key} ${cur} -> ${next} (+${xp} xp / ${ticks} ticks)`);
        if (!silent) await this._postXpChat(actor, xp, reason, { mode: "starforged", legacyKey: key });
        return { ok: true, mode: "starforged", amount: xp, legacyKey: key, ticks, total: next };
      }
      return this._grantXpClassic(actor, xp, reason, silent);
    } catch (e) {
      warn("grantXp failed:", e?.message ?? e);
      return { ok: false, error: e?.message ?? String(e) };
    }
  },

  /** Classic-model XP write: increment the integer `system.xp` counter. */
  async _grantXpClassic(actor, xp, reason, silent) {
    const path = "system.xp";
    const curRaw = foundry.utils.getProperty(actor, path);
    const cur = typeof curRaw === "number" ? curRaw : 0;
    const next = Math.max(0, cur + xp);       // experience never drops below 0
    await actor.update({ [path]: next });
    dbg(`grantXp(classic): system.xp ${cur} -> ${next} (+${xp})`);
    if (!silent) await this._postXpChat(actor, xp, reason, { mode: "classic", total: next });
    return { ok: true, mode: "classic", amount: xp, total: next };
  },

  /**
   * Convenience wrapper that awards the rank-appropriate XP for fulfilling a
   * vow/progress track, with idempotency: a track is flagged once awarded so
   * the same vow can never grant XP twice (whatever path completed it). This
   * is what both the automatic completion hook AND the grant_xp_vow directive
   * call, so they reconcile through the shared flag.
   *
   * @param {Actor} actor
   * @param {Item}  track  the progress-track Item being fulfilled.
   * @param {object} [opts]
   * @param {("strong"|"weak"|"miss"|string)} [opts.outcome] roll outcome — a
   *        "weak" outcome halves the award when the weak-hit rule is enabled.
   * @param {boolean} [opts.weakHitHalf] enable the optional half-XP rule.
   * @param {string}  [opts.reason]
   * @returns {Promise<{ok:boolean, skipped?:string, xp?:number, error?:string}>}
   */
  async grantVowXp(actor, track, { outcome = "strong", weakHitHalf = false, reason = "" } = {}) {
    if (!actor || !track) return { ok: false, error: "No actor or track." };
    try {
      // Idempotency: bail if this track already awarded XP.
      const already = track.getFlag?.(ES_SCOPE, "xpAwarded")
        ?? foundry.utils.getProperty(track, `flags.${ES_SCOPE}.xpAwarded`);
      if (already) {
        dbg(`grantVowXp: "${track.name}" already awarded XP — skipping`);
        return { ok: true, skipped: "already-awarded", xp: 0 };
      }
      const rank = foundry.utils.getProperty(track, "system.rank");
      const weak = String(outcome).toLowerCase() === "weak" && !!weakHitHalf;
      const xp = this.xpForRank(rank, { weakHit: weak });
      if (xp <= 0) {
        dbg(`grantVowXp: "${track.name}" rank "${rank}" yielded 0 XP — skipping`);
        return { ok: true, skipped: "zero-xp", xp: 0 };
      }
      // Flag BEFORE awarding so a re-entrant hook (the award writes the actor,
      // not the item, so it won't re-fire this path) can never double-grant.
      try { await track.setFlag?.(ES_SCOPE, "xpAwarded", true); } catch (_) { /* best-effort */ }
      const why = reason || `fulfilled “${track.name}”${rank ? ` (${this._rankWord(rank)})` : ""}${weak ? " — weak hit, half XP" : ""}`;
      const res = await this.grantXp(actor, xp, { reason: why });
      if (!res.ok) {
        // Roll back the flag so a later retry can still award.
        try { await track.unsetFlag?.(ES_SCOPE, "xpAwarded"); } catch (_) {}
        return res;
      }
      return { ok: true, xp, mode: res.mode, total: res.total };
    } catch (e) {
      warn("grantVowXp failed:", e?.message ?? e);
      return { ok: false, error: e?.message ?? String(e) };
    }
  },

  /**
   * Resolve WHICH vow a `grant_xp_vow` directive refers to. Unlike the
   * completion resolver, this also considers a JUST-COMPLETED vow, since the
   * award directive usually follows a complete_vow in the same reply. Order:
   *   1. The last progress track rolled this session, if it is a vow here.
   *   2. The explicit active vow.
   *   3. The newest vow that has NOT yet been awarded XP (open or completed),
   *      else the newest vow overall.
   * Returns the Item or null.
   */
  resolveVowForXp(actor) {
    if (!actor?.items) return null;
    const last = this._lastProgressTrack;
    if (last?.id && last.actorId === actor.id && (!last.kind || last.kind === "vow")) {
      const item = actor.items.get?.(last.id);
      if (item && this._trackKindOf(item) === "vow") return item;
    }
    const active = this.getActiveVow?.(actor);
    if (active?.id) {
      const item = actor.items.get?.(active.id);
      if (item && this._trackKindOf(item) === "vow") return item;
    }
    const vows = (actor.items.filter?.(i => this._trackKindOf(i) === "vow")) ?? [];
    if (!vows.length) return null;
    const awarded = (v) => v.getFlag?.(ES_SCOPE, "xpAwarded")
      ?? foundry.utils.getProperty(v, `flags.${ES_SCOPE}.xpAwarded`);
    const unawarded = vows.filter(v => !awarded(v));
    const pool = unawarded.length ? unawarded : vows;
    return pool[pool.length - 1];
  },

  /** Map a rank (word or numeric ChallengeRank) to its canonical word. */
  _rankWord(rank) {
    if (typeof rank === "number") return RANK_NUM[rank] ?? String(rank);
    return String(rank ?? "").toLowerCase().trim();
  },

  /** Post a concise GM-whispered confirmation that XP was awarded. */
  async _postXpChat(actor, xp, reason, info = {}) {
    try {
      const who = actor?.name ? `<strong>${actor.name}</strong>` : "The hero";
      const why = reason ? ` — <em>${reason}</em>` : "";
      const where = info.mode === "starforged"
        ? ` to the ${info.legacyKey || "quests"} legacy`
        : (typeof info.total === "number" ? ` (now ${info.total} total)` : "");
      const recipients = ChatMessage.getWhisperRecipients?.("GM") ?? [];
      await ChatMessage.create({
        speaker: { alias: "The Eternal Skald" },
        whisper: recipients,
        content: `<div class="es-xp-award"><p>✨ ${who} earned <strong>${xp} experience</strong>${where}${why}.</p></div>`,
        flags: { "the-eternal-skald": { xpAward: true, amount: xp, reason, ...info } }
      });
    } catch (e) {
      warn("_postXpChat failed:", e?.message ?? e);
    }
  },

  /**
   * All progress-track Items on the actor. Ironsworn stores vows, bonds,
   * journeys and combat/progress tracks as embedded Items whose type
   * varies between data-model revisions, so we accept several type names
   * and also anything that exposes a numeric `system.current`.
   */
  getProgressTracks(actor) {
    if (!actor?.items) return [];
    const PROGRESS_TYPES = new Set([
      "progress", "vow", "bond", "bondset", "connection", "journey", "foe", "delve-domain", "delve-theme"
    ]);
    const out = [];
    for (const item of actor.items) {
      const isProgressType = PROGRESS_TYPES.has(item.type);
      const current = foundry.utils.getProperty(item, "system.current");
      const rank = foundry.utils.getProperty(item, "system.rank");
      if (isProgressType || typeof current === "number" || rank) {
        out.push({
          id: item.id,
          name: item.name,
          type: item.type,
          // Modern foundry-ironsworn stores vows/journeys/bonds as `progress`
          // Items distinguished by `system.subtype` ("vow", "journey", …),
          // so surface it — callers can no longer rely on `type` alone.
          subtype: foundry.utils.getProperty(item, "system.subtype") ?? null,
          // Our own classification flag (set when the Skald created the track):
          // "vow" | "journey" | "combat" | "bond" | …. Lets callers identify a
          // journey even when the system stored it as a generic progress track.
          kind: item.getFlag?.(ES_SCOPE, "trackKind")
             ?? foundry.utils.getProperty(item, `flags.${ES_SCOPE}.trackKind`)
             ?? null,
          rank: rank ?? null,
          current: typeof current === "number" ? current : 0,
          boxes: typeof current === "number" ? Math.floor(current / 4) : 0,
          completed: foundry.utils.getProperty(item, "system.completed") ?? false
        });
      }
    }
    return out;
  },

  /**
   * (v0.10.26 — Phase 1 context) Human/AI-readable label describing how full a
   * progress track is, so the prompt can state plainly whether a completion
   * move is even available yet. READ-ONLY and pure.
   *
   * A track is "full" — eligible for its completion move (Fulfill Your Vow /
   * Reach Your Destination / End the Fight) — at 10/10 boxes. Below that the
   * narrative must continue; the AI must not offer the completion move.
   *
   * @param {number}  boxes      filled boxes 0–10 (floor(ticks / 4)).
   * @param {boolean} completed  whether the track is already marked complete.
   * @param {string}  [kind]     "vow" | "journey" | "combat" — tunes the verb
   *                             ("READY TO FULFILL" vs "READY TO END").
   * @returns {string}           e.g. "10/10 boxes - ✅ READY TO FULFILL" or
   *                             "7/10 boxes - NOT YET FULL".
   */
  fullnessLabel(boxes, completed = false, kind = "vow") {
    const b = Math.max(0, Math.min(10, Number(boxes) || 0));
    if (completed) return `${b}/10 boxes - (completed)`;
    if (b >= 10) {
      const verb = kind === "combat" ? "READY TO END"
                 : kind === "journey" ? "READY TO REACH"
                 : "READY TO FULFILL";
      return `10/10 boxes - ✅ ${verb}`;
    }
    return `${b}/10 boxes - NOT YET FULL`;
  },

  /* =====================================================================
   * Phase 2 — STORY-ARC TRACKING (active vow / active combat flags)
   *
   * The Skald remembers which vow and which fight the story is currently
   * about, persisted as actor flags so it survives reloads:
   *   flags["the-eternal-skald"].activeVow    → Item id of the focus vow
   *   flags["the-eternal-skald"].activeCombat → Item id of the active foe
   * These are advisory hints: every getter VALIDATES the flag still points at
   * an open track of the right kind, and returns null (never throws) otherwise,
   * so stale ids self-heal. All writes are defensive and best-effort.
   * ================================================================= */

  /** Read the actor's stored active-vow flag id (or null). */
  _activeFlagId(actor, key) {
    if (!actor) return null;
    try {
      return actor.getFlag?.(ES_SCOPE, key)
          ?? foundry.utils.getProperty(actor, `flags.${ES_SCOPE}.${key}`)
          ?? null;
    } catch (_) { return null; }
  },

  /**
   * The currently-tracked "story focus" vow as an Item, validated to still be
   * an open vow on this actor. Returns null when unset/stale/completed.
   * READ-ONLY.
   * @returns {{id:string,name:string}|null}
   */
  getActiveVow(actor) {
    if (!actor?.items) return null;
    const id = this._activeFlagId(actor, "activeVow");
    if (!id) return null;
    const item = actor.items.get?.(id);
    if (!item) return null;
    if (foundry.utils.getProperty(item, "system.completed")) return null;
    const kind = item.getFlag?.(ES_SCOPE, "trackKind")
              ?? foundry.utils.getProperty(item, `flags.${ES_SCOPE}.trackKind`);
    const subtype = String(foundry.utils.getProperty(item, "system.subtype") ?? "").toLowerCase();
    if (kind !== "vow" && subtype !== "vow") return null;
    return { id: item.id, name: item.name };
  },

  /**
   * Remember which vow the story is currently about. Accepts an Item id, a
   * track name, or a track-like object with an `id`. Validates it resolves to a
   * vow on this actor before writing. Best-effort; never throws.
   * @returns {Promise<{ok:boolean, id?:string, name?:string, error?:string}>}
   */
  async setActiveVow(actor = this.getActiveCharacter(), vowRef = null) {
    if (!actor) return { ok: false, error: "No actor." };
    try {
      if (vowRef == null) {
        await actor.unsetFlag?.(ES_SCOPE, "activeVow");
        return { ok: true, id: null };
      }
      const ref = (vowRef && typeof vowRef === "object") ? (vowRef.id ?? vowRef.name) : vowRef;
      const item = this.findTrack(actor, ref);
      if (!item) return { ok: false, error: `No track matching "${ref}".` };
      await actor.setFlag?.(ES_SCOPE, "activeVow", item.id);
      dbg(`setActiveVow: ${actor.name} → "${item.name}" (${item.id})`);
      return { ok: true, id: item.id, name: item.name };
    } catch (e) {
      warn("setActiveVow failed:", e?.message ?? e);
      return { ok: false, error: e?.message ?? String(e) };
    }
  },

  /**
   * (v0.10.26 — Phase 1 context) Best guess at WHICH open vow the current
   * narrative is about ("story focus"), so the prompt can mark it and the AI
   * applies progress/effects to the contextually-relevant arc instead of
   * conflating parallel vows. READ-ONLY; never writes.
   *
   * Resolution order (highest authority first):
   *   1. The explicit "active vow" flag ({@link getActiveVow}) when set and
   *      still pointing at an open vow — the GM/AI's deliberate story focus.
   *   2. The last progress track actually rolled this session
   *      ({@link _lastProgressTrack}) — but only if it is a still-open VOW on
   *      THIS actor. This is a strong "what we're doing right now" signal.
   *   3. The newest still-open vow ({@link _newestOpenTrackItem}) as a
   *      graceful fallback.
   * Returns null when the character has no open vow.
   *
   * @param {Actor} actor
   * @returns {{id:string,name:string}|null}
   */
  identifyStoryFocusVow(actor) {
    if (!actor?.items) return null;

    // 1. Highest authority — the explicitly-tracked active vow (story arc).
    const active = this.getActiveVow(actor);
    if (active) return active;

    // 2. Honour the last-rolled track when it is an open vow on this actor.
    const last = this._lastProgressTrack;
    if (last?.id && last.actorId === actor.id && last.kind === "vow") {
      const item = actor.items.get?.(last.id);
      if (item && !foundry.utils.getProperty(item, "system.completed")) {
        return { id: item.id, name: item.name };
      }
    }

    // 3. Fallback — the newest still-open vow.
    const vow = this._newestOpenTrackItem(actor, "vow");
    return vow ? { id: vow.id, name: vow.name } : null;
  },

  /** Find a progress track Item by (case-insensitive) name or by id. */
  findTrack(actor, nameOrId) {
    if (!actor?.items || !nameOrId) return null;
    const byId = actor.items.get?.(nameOrId);
    if (byId) return byId;
    const lc = String(nameOrId).toLowerCase();
    return actor.items.find?.(i => i.name?.toLowerCase() === lc)
        ?? actor.items.find?.(i => i.name?.toLowerCase().includes(lc))
        ?? null;
  },

  /** The trackKind ("vow"|"journey"|"combat"|"bond") of a progress Item. */
  _trackKindOf(item) {
    if (!item) return null;
    const flagKind = item.getFlag?.(ES_SCOPE, "trackKind")
                  ?? foundry.utils.getProperty(item, `flags.${ES_SCOPE}.trackKind`);
    if (flagKind) return String(flagKind).toLowerCase();
    const subtype = String(foundry.utils.getProperty(item, "system.subtype") ?? "").toLowerCase();
    if (subtype === "vow")  return "vow";
    if (subtype === "foe")  return "combat";
    if (subtype === "bond" || subtype === "connection") return "bond";
    return "journey"; // plain "progress" subtype with no flag → journey-like
  },

  /**
   * Fuzzy-match a progress track by name, optionally constrained to a track
   * KIND ("vow" | "journey" | "combat" | "bond"). Used by the AI write
   * directives, where the model may paraphrase a track's name slightly. Tries,
   * in order: exact id / exact name / substring (via findTrack), then a
   * normalized word-overlap score against open tracks of the requested kind.
   * Returns the matching Item or null (never throws).
   *
   * @param {Actor}  actor
   * @param {string} name
   * @param {string|null} [kind]
   * @returns {Item|null}
   */
  findTrackFuzzy(actor, name, kind = null) {
    if (!actor?.items || !name) return null;
    const wantKind = kind ? String(kind).toLowerCase() : null;
    const matchesKind = (it) => !wantKind || this._trackKindOf(it) === wantKind;

    // 1. Direct id / exact-name / substring match that ALSO satisfies the kind.
    const direct = this.findTrack(actor, name);
    if (direct && matchesKind(direct)) return direct;

    // Normalisation: lower-case, strip leading articles & non-alphanumerics.
    const norm = (s) => String(s ?? "").toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\b(the|a|an|of|to|your|my)\b/g, " ")
      .replace(/\s+/g, " ").trim();
    const target = norm(name);
    if (!target) return direct && matchesKind(direct) ? direct : null;
    const targetWords = new Set(target.split(" ").filter(Boolean));
    if (!targetWords.size) return null;

    // 2. Word-overlap scoring across candidate tracks of the right kind.
    let best = null, bestScore = 0;
    for (const it of actor.items) {
      if (it.type !== "progress") continue;
      if (!matchesKind(it)) continue;
      const candWords = new Set(norm(it.name).split(" ").filter(Boolean));
      if (!candWords.size) continue;
      let shared = 0;
      for (const w of targetWords) if (candWords.has(w)) shared++;
      // Jaccard-like score over the smaller set so short names still match.
      const score = shared / Math.min(targetWords.size, candWords.size);
      if (score > bestScore) { bestScore = score; best = it; }
    }
    // Require a solid majority of shared significant words to avoid mismatches.
    return bestScore >= 0.5 ? best : null;
  },

  /** True iff `s` is a generic track noun (see {@link _GENERIC_TRACK_WORDS}). */
  isGenericTrackWord(s) {
    const n = String(s ?? "").toLowerCase().trim().replace(/[.!?,;:]+$/, "");
    return this._GENERIC_TRACK_WORDS.has(n);
  },

  /**
   * Resolve the progress-track Item to DISPLAY for a (possibly generic or
   * imprecise) reference — the single source of truth for the track cards the
   * Skald posts. Always returns a LIVE Item document read straight from
   * `actor.items` (never a cached/parallel copy), so its current/completed/rank
   * are whatever the sheet currently holds.
   *
   * Resolution order:
   *   1. Empty or a GENERIC noun ("vow", "the journey", ...) → the player's
   *      real CURRENT track of that kind: newest OPEN first, else newest of the
   *      kind, else any open vow/journey. This is what makes clicking the word
   *      "vow" show "The Truth of the Star-Fall" rather than a phantom.
   *   2. A direct Item id.
   *   3. An exact (case-insensitive) name match — preferring an OPEN track when
   *      several share the name.
   *   4. A substring name match — again preferring an OPEN track.
   *
   * @param {Actor}  actor
   * @param {string} trackRef
   * @returns {Item|null}
   */
  resolveDisplayTrack(actor, trackRef) {
    if (!actor?.items) return null;
    const ref   = String(trackRef ?? "").trim();
    const refLc = ref.toLowerCase();

    // 1. Generic noun / empty → the character's real current track of the kind.
    if (!ref || this.isGenericTrackWord(ref)) {
      let kind = "vow";
      if (/journey/.test(refLc))             kind = "journey";
      else if (/bond/.test(refLc))           kind = "bond";
      else if (/combat|fight|foe/.test(refLc)) kind = "combat";
      return this._newestOpenTrackItem(actor, kind)
          ?? this._newestTrackItemOfKind(actor, kind, /*openOnly=*/false)
          ?? this._newestOpenTrackItem(actor, "vow")
          ?? this._newestOpenTrackItem(actor, "journey");
    }

    // 2. Direct id.
    const byId = actor.items.get?.(ref);
    if (byId) return byId;

    const notDone = i => !foundry.utils.getProperty(i, "system.completed");

    // 3. Exact name — prefer an OPEN track, then any.
    const exactOpen = actor.items.find?.(i => i.name?.toLowerCase() === refLc && notDone(i));
    if (exactOpen) return exactOpen;
    const exact = actor.items.find?.(i => i.name?.toLowerCase() === refLc);
    if (exact) return exact;

    // 4. Substring name — prefer an OPEN track, then any.
    const subOpen = actor.items.find?.(i => i.name?.toLowerCase().includes(refLc) && notDone(i));
    if (subOpen) return subOpen;
    return actor.items.find?.(i => i.name?.toLowerCase().includes(refLc)) ?? null;
  },

  /**
   * Mark progress on a track. `ticks` is in ticks (4 ticks = 1 box). To
   * mark "by rank" use markProgressByRank(). Clamped to 0–40.
   */
  async markProgress(actor, trackRef, ticks) {
    const track = this.findTrack(actor, trackRef);
    if (!track) return { ok: false, error: `Track "${trackRef}" not found.` };
    const cur = foundry.utils.getProperty(track, "system.current") ?? 0;
    const next = Math.max(0, Math.min(40, cur + Math.round(ticks)));
    try {
      await track.update({ "system.current": next });
      dbg(`markProgress: "${track.name}" ${cur} -> ${next}`);
      // Phase 2 (story-arc tracking): marking progress on a vow / combat track
      // is a strong "this is the current arc" signal — keep the active-vow /
      // active-combat flag in sync so context markers and AI directives target
      // the right track. Best-effort; never blocks the progress write.
      try { await this._syncActiveFlagForTrack(actor, track); } catch (_) {}
      return { ok: true, track: track.name, current: next, boxes: Math.floor(next / 4) };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },

  /**
   * Update the active-vow / active-combat flag to point at `track` when it is
   * an OPEN vow or combat track. Internal helper for the progress-marking
   * paths. Best-effort; swallows errors (advisory state only).
   */
  async _syncActiveFlagForTrack(actor, track) {
    if (!actor || !track) return;
    if (foundry.utils.getProperty(track, "system.completed")) return;
    const kind = track.getFlag?.(ES_SCOPE, "trackKind")
              ?? foundry.utils.getProperty(track, `flags.${ES_SCOPE}.trackKind`);
    const subtype = String(foundry.utils.getProperty(track, "system.subtype") ?? "").toLowerCase();
    if (kind === "vow" || (subtype === "vow" && kind !== "journey")) {
      await this.setActiveVow(actor, track.id);
    } else if (kind === "combat" || subtype === "foe") {
      await this.setActiveCombat(actor, track.id);
    }
  },

  /**
   * Mark progress by the track's rank (the normal "mark progress" action):
   *   troublesome +12, dangerous +8, formidable +4, extreme +2, epic +1.
   */
  async markProgressByRank(actor, trackRef, times = 1) {
    const track = this.findTrack(actor, trackRef);
    if (!track) return { ok: false, error: `Track "${trackRef}" not found.` };
    const rank = this.normalizeRank(foundry.utils.getProperty(track, "system.rank"));
    const perMark = RANK_TICKS[rank] ?? 4;
    return this.markProgress(actor, track.id, perMark * Math.max(1, times));
  },

  /**
   * Set a track's progress to an ABSOLUTE number of filled boxes (0–10). Used
   * by the AI [[SET_PROGRESS:kind:Name:boxes]] write directive. Boxes are
   * converted to ticks (×4) and clamped to the 0–40 schema range. Also keeps
   * the active-vow / active-combat flag in sync. Best-effort.
   *
   * @param {Actor}  actor
   * @param {string} trackRef   track name or id
   * @param {number} boxes      0–10 filled progress boxes
   * @returns {Promise<{ok:boolean, track?:string, current?:number, boxes?:number, error?:string}>}
   */
  async setProgress(actor, trackRef, boxes) {
    const track = this.findTrack(actor, trackRef);
    if (!track) return { ok: false, error: `Track "${trackRef}" not found.` };
    const n = Number(boxes);
    if (!Number.isFinite(n)) return { ok: false, error: `Invalid box count "${boxes}".` };
    const ticks = Math.max(0, Math.min(40, Math.round(n) * 4));
    try {
      await track.update({ "system.current": ticks });
      dbg(`setProgress: "${track.name}" → ${ticks} ticks (${ticks / 4} boxes)`);
      try { await this._syncActiveFlagForTrack(actor, track); } catch (_) {}
      return { ok: true, track: track.name, current: ticks, boxes: Math.floor(ticks / 4) };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },

  /**
   * Create a new progress-track Item on the actor — used to enact
   * "Swear an Iron Vow", "Begin a Journey", "Forge a Bond", or to spin up
   * a combat (foe) progress track when a fight begins.
   *
   * Two call styles are supported for convenience:
   *   createProgressTrack(actor, name, trackType, rank, description)
   *   createProgressTrack(actor, { name, trackType|type, rank, description })
   *
   * @param {Actor}  actor
   * @param {string|object} nameOrOpts  track name, or an options object.
   * @param {string} [trackType='vow']  'combat' | 'vow' | 'journey' | 'bond'.
   * @param {string} [rank='formidable'] one of RANKS.
   * @param {string} [description='']
   * @returns {Promise<{ok:boolean, id?:string, name?:string, type?:string, rank?:string, error?:string}>}
   */
  async createProgressTrack(actor, nameOrOpts, trackType = "vow", rank = "formidable", description = "") {
    if (!actor) return { ok: false, error: "No actor." };

    // Normalise the two call styles.
    let name = nameOrOpts;
    if (nameOrOpts && typeof nameOrOpts === "object") {
      const o = nameOrOpts;
      name        = o.name;
      trackType   = o.trackType || o.type || o.subtype || "vow";
      rank        = o.rank || "formidable";
      description = o.description || "";
    }
    if (!name) return { ok: false, error: "A track name is required." };

    const kind = String(trackType).toLowerCase();
    rank = this.normalizeRank(rank);

    // ── foundry-ironsworn progress-track data model (verified against
    //    src/module/item/subtypes/progress.ts and the system's own creators:
    //    progress-controls.vue creates `{ type:'progress', system:{ subtype } }`
    //    and foe-sheet.vue creates `{ type:'progress', system:{ subtype:'foe' } }`).
    //
    //    EVERY track — vow, journey, bond and combat foe — is a single Item
    //    *type* `"progress"`, distinguished ONLY by `system.subtype`:
    //      vow     → subtype "vow"   (the system's "Fulfill Your Vow" move keys
    //                                 off this subtype in ProgressModel.fulfill())
    //      journey → subtype "progress" — a journey IS a standard progress track.
    //                The system only localizes the subtypes "vow", "progress" and
    //                "bond"/"connection" (see IRONSWORN.ITEM.Subtype*), so a
    //                non-standard "journey" subtype renders the raw key on the
    //                sheet. We therefore store journeys as "progress" (correct
    //                PROGRESS label + standard mechanics) and tag them as
    //                journeys via our own `flags.<scope>.trackKind="journey"`.
    //      bond    → subtype "bond"
    //      combat  → subtype "progress" — SEE NOTE BELOW.
    //
    //    COMBAT-FOE LABELLING FIX: foe-sheet.vue uses subtype "foe", but that
    //    creator runs on a *foe Actor* (type "foe"), whose sheet supplies its own
    //    label. On a *character* sheet the progress list renders the subtype via
    //    `localize("IRONSWORN.ITEM.Subtype" + subtype.capitalize())`. The system
    //    only localizes "vow"/"progress"/"connection" (bond is special-cased to
    //    connection), so a combat track stored as subtype "foe" on a character
    //    renders the raw key "IRONSWORN.ITEM.SubtypeFoe" as its label — the
    //    "combat foes are not labelled correctly" bug. We therefore store combat
    //    tracks EXACTLY like journeys: subtype "progress" (clean "Progress" label +
    //    standard mechanics) tagged via `flags.<scope>.trackKind="combat"`. The
    //    foe's name still lives in the Item name, and getCombatTracks() detects
    //    combat primarily via the trackKind flag, so nothing downstream breaks.
    const subtypeMap = { combat: "progress", journey: "progress", vow: "vow", bond: "bond" };
    const subtype = subtypeMap[kind] ?? "progress";
    // The Item type is ALWAYS "progress" in foundry-ironsworn (there is no
    // separate "vow"/"bond"/"foe" *type* — only a subtype). Probe the
    // registered data models defensively, but the practical result is always
    // "progress".
    const itemType = this._pickItemType(["progress"]);

    // foundry-ironsworn's ChallengeRank is a NumberField (1–5). Write the
    // numeric value directly so document creation never depends on the
    // system's string coercion (which could differ across revisions); keep the
    // canonical rank WORD around for our own logging / return value.
    const rankNum = RANK_TO_NUM[rank] ?? RANK_TO_NUM.formidable;
    const data = {
      name,
      type: itemType,
      // Field names verified against ProgressModel.defineSchema():
      //   subtype (StringField), rank (ChallengeRank 1–5),
      //   current (ProgressTicksField, 0–40 ticks; 4 ticks = 1 box),
      //   completed (BooleanField), hasTrack (BooleanField, default true).
      system: { subtype, rank: rankNum, current: 0, completed: false, hasTrack: true },
      // Mirror the system's own creators (progress-controls.vue / foe-sheet.vue),
      // which set a high sort so a freshly made track lands at the list's end.
      sort: 9000000,
      flags: { [ES_SCOPE]: { trackKind: kind, createdBy: "eternal-skald" } }
    };
    // `description` (HTMLField) is the only notes-like field in the schema —
    // do NOT write a "notes" key (it is not part of ProgressModel and would be
    // dropped during data-model cleaning).
    if (description) data.system.description = description;

    try {
      const [created] = await actor.createEmbeddedDocuments("Item", [data]);
      dbg(`createProgressTrack: "${name}" kind=${kind} type=${itemType} rank=${rank} (id=${created?.id})`);
      return { ok: true, id: created?.id, name, type: itemType, rank, kind };
    } catch (e) {
      warn("createProgressTrack failed:", e?.message ?? e);
      return { ok: false, error: e?.message ?? String(e) };
    }
  },

  /**
   * Find an existing progress-track Item by (case-insensitive) name or id.
   * Returns the Item document (or null). Thin semantic wrapper over
   * findTrack() so callers reading "a progress track" are explicit.
   */
  getProgressTrack(actor, trackName) {
    return this.findTrack(actor, trackName);
  },

  /**
   * Normalise an arbitrary rank to a canonical rank word. Accepts:
   *   • rank words ("dangerous", "Formidable", "formidible" typo) → matched,
   *   • numeric ranks 1–5 (the foundry-ironsworn encoding) → mapped,
   *   • anything else → `fallback`.
   */
  normalizeRank(rank, fallback = "formidable") {
    // Numeric rank (1–5) as used by foundry-ironsworn foe items.
    if (typeof rank === "number" && RANK_NUM[rank]) return RANK_NUM[rank];
    const raw = String(rank ?? "").trim();
    if (/^[1-5]$/.test(raw)) return RANK_NUM[Number(raw)];
    const r = raw.toLowerCase().replace(/[^a-z]/g, "");
    if (RANKS.includes(r)) return r;
    if (r === "formidible") return "formidable"; // common misspelling (system handles it too)
    return fallback;
  },

  /**
   * Mark a track complete (e.g. when a combat ends or a vow is fulfilled).
   * @returns {Promise<{ok:boolean, name?:string, error?:string}>}
   */
  async completeTrack(actor, trackRef) {
    const track = this.findTrack(actor, trackRef);
    if (!track) return { ok: false, error: `Track "${trackRef}" not found.` };
    try {
      await track.update({ "system.completed": true });
      dbg(`completeTrack: "${track.name}" marked completed`);
      return { ok: true, name: track.name };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },

  /**
   * Resolve the progress track a completion directive refers to. Because the
   * narrating AI does not reliably know a track's exact name (it often writes
   * the MOVE name, a paraphrase, or nothing at all), resolution is layered:
   *   1. A direct id / exact-name / substring-name match wins — UNLESS the ref
   *      is itself a progress-MOVE name, which is never a real track.
   *   2. Otherwise the track the last progress move actually rolled against
   *      (recorded by rollProgressMove), if it is still open and belongs to
   *      this actor and matches the implied kind.
   *   3. Otherwise the newest open track of the implied kind (vow / journey),
   *      then any newest open vow, then any newest open journey.
   *
   * @param {Actor}  actor
   * @param {string} trackRef        name/id from the directive (may be empty).
   * @param {string|null} [hintKind] "vow" | "journey" inferred from the verb.
   * @returns {Item|null}
   */
  resolveCompletionTrack(actor, trackRef, hintKind = null) {
    if (!actor) return null;
    const ref   = String(trackRef ?? "").trim();
    const refLc = ref.toLowerCase();
    const refIsMove = this._isProgressMoveName(ref);

    // 1. Direct match — but never trust a progress-move name as a track name.
    if (ref && !refIsMove) {
      const direct = this.findTrack(actor, ref);
      if (direct) return direct;
    }

    // Infer the track kind from an explicit hint, else from the move name.
    let kind = hintKind;
    if (!kind) {
      if (/reach your destination/.test(refLc)) kind = "journey";
      else if (/fulfill your vow/.test(refLc))  kind = "vow";
    }

    // 2. The track the last progress move rolled against (still open & ours).
    const last = this._lastProgressTrack;
    if (last && last.actorId === actor.id && (!kind || !last.kind || last.kind === kind)) {
      const item = actor.items?.get?.(last.id);
      if (item && !foundry.utils.getProperty(item, "system.completed")) return item;
    }

    // 3. Newest open track of the implied kind; else any open vow, then journey.
    if (kind) {
      const ofKind = this._newestOpenTrackItem(actor, kind);
      if (ofKind) return ofKind;
    }
    return this._newestOpenTrackItem(actor, "vow")
        ?? this._newestOpenTrackItem(actor, "journey");
  },

  /**
   * Complete a vow/journey track, resolving the CORRECT track even when the
   * directive carries a move name, a paraphrase, or no name at all (see
   * resolveCompletionTrack). This is the completion path used for fulfilled
   * vows and reached destinations; combat tracks keep using completeTrack().
   *
   * @param {Actor}  actor
   * @param {string} trackRef
   * @param {string|null} [hintKind] "vow" | "journey".
   * @returns {Promise<{ok:boolean, name?:string, error?:string}>}
   */
  async completeTrackSmart(actor, trackRef, hintKind = null) {
    if (!actor) return { ok: false, error: "No actor." };
    const track = this.resolveCompletionTrack(actor, trackRef, hintKind);
    if (!track) {
      const noun = hintKind ? `${hintKind} track` : "vow or journey";
      const named = String(trackRef ?? "").trim();
      return {
        ok: false,
        error: named && !this._isProgressMoveName(named)
          ? `Track "${named}" not found, and no open ${noun} to complete.`
          : `No open ${noun} to complete.`
      };
    }
    try {
      await track.update({ "system.completed": true });
      // Clear the last-progress pointer if we just closed the track it named.
      if (this._lastProgressTrack?.id === track.id) this._lastProgressTrack = null;
      dbg(`completeTrackSmart: "${track.name}" marked completed (ref="${trackRef ?? ""}", kind=${hintKind ?? "?"})`);
      return { ok: true, name: track.name };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },

  /**
   * All OPEN (incomplete) site progress tracks on the actor — the tracks the
   * Skald created with trackKind "delve" (see SiteGenerator / createProgressTrack).
   * Newest first. Read-only. Used to resolve which site a Delve progress move
   * ("Locate Your Objective" / "Escape the Depths") rolls against.
   * @param {Actor} actor
   * @returns {Item[]}
   */
  _openSiteTracks(actor) {
    if (!actor?.items) return [];
    const out = [];
    for (const item of actor.items) {
      if (item.type !== "progress") continue;
      if (foundry.utils.getProperty(item, "system.completed")) continue;
      const flagKind = (item.getFlag?.(ES_SCOPE, "trackKind")
                     ?? foundry.utils.getProperty(item, `flags.${ES_SCOPE}.trackKind`)
                     ?? "").toLowerCase();
      if (flagKind === "delve") out.push(item);
    }
    out.sort((a, b) => (b._stats?.createdTime ?? 0) - (a._stats?.createdTime ?? 0));
    return out;
  },

  /**
   * Ask the player which open site a Delve progress move should roll against,
   * when more than one site is active. Returns the chosen track Item, or null
   * if the player cancels/closes (the move is then aborted — never auto-chosen).
   * Prefers DialogV2 (v13+) and falls back to the classic Dialog.
   * @param {Item[]} sites
   * @param {string} moveName
   * @returns {Promise<Item|null>}
   */
  async _showSiteSelectionDialog(sites, moveName) {
    const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const options = sites.map((s) => {
      const cur = Number(foundry.utils.getProperty(s, "system.current") ?? 0);
      const boxes = Math.max(0, Math.min(10, Math.floor(cur / 4)));
      return `<option value="${esc(s.id)}">${esc(s.name)} (${boxes}/10)</option>`;
    }).join("");
    const content = `<p>Which site are you exploring for <strong>${esc(moveName)}</strong>?</p>` +
      `<div class="form-group"><select name="es-site" style="width:100%">${options}</select></div>`;
    const pick = (id) => sites.find(s => s.id === id) ?? null;

    const DV2 = foundry?.applications?.api?.DialogV2;
    if (DV2?.prompt) {
      try {
        const id = await DV2.prompt({
          window: { title: "Select a Site" },
          content,
          ok: { label: "Roll", callback: (_ev, button) => button?.form?.elements?.["es-site"]?.value ?? null },
          rejectClose: false
        });
        return pick(id);
      } catch (e) {
        warn("site selection DialogV2 failed — falling back to classic Dialog:", e?.message ?? e);
      }
    }
    return await new Promise((resolve) => {
      try {
        new Dialog({
          title: "Select a Site",
          content,
          buttons: {
            ok: { label: "Roll", callback: (html) => {
              const root = html?.[0] ?? html;
              resolve(pick(root?.querySelector?.("select[name=es-site]")?.value));
            } },
            cancel: { label: "Cancel", callback: () => resolve(null) }
          },
          default: "ok",
          close: () => resolve(null)
        }).render(true);
      } catch (e) {
        warn("site selection dialog unavailable:", e?.message ?? e);
        resolve(null);
      }
    });
  },

  /**
   * Execute the "Reach a Milestone" move: find the newest open vow and mark
   * progress on it by rank.  Returns an {ok, track, boxes, …} result.
   */
  async _executeMilestone(actor) {
    if (!actor) return { ok: false, error: "No active character." };
    const vow = this._newestOpenTrackItem(actor, "vow");
    if (!vow) {
      dbg("_executeMilestone: no open vow found on", actor?.name);
      return { ok: false, error: "No open vow to mark progress on." };
    }
    dbg(`_executeMilestone: marking "${vow.name}" (rank ${foundry.utils.getProperty(vow, "system.rank")}, current ${foundry.utils.getProperty(vow, "system.current")})`);
    const result = await this.markProgressByRank(actor, vow.id);
    if (result?.ok) {
      const name = vow.name || "vow";
      const boxes = result.boxes ?? Math.floor((result.current ?? 0) / 4);
      dbg(`_executeMilestone: "${name}" now ${result.current} ticks (${boxes}/10 boxes)`);
      try { ui.notifications?.info(`Reach a Milestone: marked progress on "${name}" (now ${boxes}/10 boxes).`); } catch (_) {}
      return { ok: true, method: "milestone", track: name, boxes, ticks: result.current };
    }
    warn("_executeMilestone: markProgressByRank failed:", result?.error);
    return { ok: false, error: result?.error ?? "Could not mark progress." };
  },

  /**
   * The newest still-open (not completed) progress-track Item of a given
   * kind ("vow" | "journey" | "combat" | …), or null. Classification uses our
   * own `trackKind` flag first (set when the Skald created the track), then
   * falls back to the system `system.subtype` (so a hand-made "vow" item is
   * still found). Returns the live Item document.
   */
  _newestOpenTrackItem(actor, kind) {
    return this._newestTrackItemOfKind(actor, kind, /*openOnly=*/true);
  },

  /**
   * Like {@link _newestOpenTrackItem} but with control over whether already
   * completed tracks are eligible. Used by the display resolver so that, when
   * a player has only completed vows left, the card can still surface the most
   * recent one (read fresh from the sheet) instead of finding nothing.
   *
   * @param {Actor}   actor
   * @param {string}  kind       "vow" | "journey" | "combat" | "bond"
   * @param {boolean} [openOnly=true] skip completed tracks when true.
   * @returns {Item|null}
   */
  _newestTrackItemOfKind(actor, kind, openOnly = true) {
    if (!actor?.items) return null;
    const want = String(kind ?? "").toLowerCase();
    const strong = [];   // exact, confident matches (our flag / system subtype)
    const fallback = []; // best-effort matches (legacy / hand-made tracks)
    for (const item of actor.items) {
      if (openOnly && foundry.utils.getProperty(item, "system.completed")) continue;
      // Only real progress-track items can carry a progress score to roll.
      if (item.type !== "progress") continue;
      const flagKind = (item.getFlag?.(ES_SCOPE, "trackKind")
                     ?? foundry.utils.getProperty(item, `flags.${ES_SCOPE}.trackKind`)
                     ?? "").toLowerCase();
      const subtype = String(foundry.utils.getProperty(item, "system.subtype") ?? "").toLowerCase();

      if (flagKind === want) { strong.push(item); continue; }
      // Vows: the system's own "vow" subtype is an equally strong signal.
      if (want === "vow" && subtype === "vow") { strong.push(item); continue; }

      // FALLBACK — find tracks the Skald didn't create (or created before the
      // trackKind flag existed). Journeys are stored as plain "progress"
      // subtype tracks, so a legacy / hand-made journey carries no journey
      // flag. Treat any open, unclassified "progress" track (one that is NOT a
      // vow, bond, or an active combat foe) as a candidate journey so that
      // "Reach Your Destination" can still roll against it.
      if (want === "journey"
          && subtype !== "vow" && subtype !== "bond" && subtype !== "foe"
          && flagKind !== "vow" && flagKind !== "bond" && flagKind !== "combat") {
        fallback.push(item);
      }
    }
    const pool = strong.length ? strong : fallback;
    if (!pool.length) return null;
    // "Newest" by creation timestamp when available, else last in iteration.
    pool.sort((a, b) => (b._stats?.createdTime ?? 0) - (a._stats?.createdTime ?? 0));
    return pool[0];
  }
};
