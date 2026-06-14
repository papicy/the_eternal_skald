/* =====================================================================
 *  THE ETERNAL SKALD — Ironsworn controller submodule
 *  Moves: catalogue, rolls, declaration detection, oracles & action routing.
 *
 *  Extracted verbatim from the former monolithic ironsworn-controller.js
 *  (Phase B / H2 decomposition). These methods are composed onto the single
 *  IronswornController facade via Object.assign in ironsworn-controller.js,
 *  so `this` inside every method still resolves to that one shared object —
 *  cross-method calls (this.getActiveCharacter(), this._foeIndexCache, …)
 *  and shared cache state are unchanged. No behaviour change.
 * ===================================================================== */

import {
  SYSTEM_ID, ES_SCOPE, dbg, warn, MOVE_CATALOG, MOVE_BY_ID, MOVE_BY_NAME, MOVE_TRIGGERS, MOVE_COMPENDIUM_BY_RULESET, dsRulesPackage
} from "./internals.js";

export const MovesMethods = {


  /* =================================================================
   *  WRITE — moves, momentum, harm/stress, progress, vows, oracles
   * ================================================================= */

  /**
   * Trigger an official Ironsworn move. Preferred path is the system's
   * own pre-roll dialog (identical to clicking the move on the sheet),
   * which produces a fully-formed Ironsworn chat card. Falls back to a
   * manual action roll when the dialog API is unavailable or rejects the
   * ID.
   *
   * @param {string} moveRef   Datasworn ID or catalog move name.
   * @param {object} [opts]
   * @param {Actor}  [opts.actor]  actor for the manual fallback.
   * @param {string} [opts.stat]   preferred stat for the manual fallback.
   * @param {number} [opts.adds]   add value for the manual fallback.
   * @returns {Promise<{ok:boolean, method:string, error?:string}>}
   */
  async triggerMove(moveRef, opts = {}) {
    const move = this._resolveMove(moveRef);
    const dataswornId = move?.id ?? (typeof moveRef === "string" && moveRef.startsWith("move:") ? moveRef : null);

    dbg("triggerMove:", { moveRef, resolved: dataswornId });

    // 0. PROGRESS MOVES — "Fulfill Your Vow", "Reach Your Destination" and
    //    "End the Fight" are not action rolls against a stat; they are PROGRESS
    //    rolls against a specific track's score. The system's generic move
    //    dialog cannot roll them without a track context (and they have no
    //    rollable stat), which is exactly why they used to dead-end with "no
    //    dialog and no rollable stat". Route them to the progress-roll path
    //    against the matching open track instead. All three share the same
    //    mechanic — roll the track's progress score (vow / journey / foe).
    if (this._isProgressMove(dataswornId, move?.name)) {
      return this.rollProgressMove(moveRef, opts);
    }

    // 0b. REACH A MILESTONE — not a roll; it simply marks progress on the
    //     active vow by its rank. Handle it here so inline links and
    //     doTriggerMove() both work without falling through to the "no
    //     rollable stat" error.
    if (this._isMilestoneMove(dataswornId, move?.name)) {
      return this._executeMilestone(opts.actor ?? this.getActiveCharacter());
    }

    // 0c. DISCOVER A SITE — a no-roll Ironsworn: Delve move with no rollable
    //     stat. It used to dead-end at the "no dialog and no rollable stat"
    //     error below. Route it to the AI site generator, which rolls a random
    //     Theme + Domain (preserving Delve DNA), enriches them into a
    //     mysterious site and creates a site progress track — degrading to a
    //     manual-oracle fallback if the AI is unavailable. The dynamic import
    //     keeps this controller free of top-level dependencies (see the
    //     "importing Settings would be circular" note elsewhere in this file).
    if (this._isDiscoverSiteMove(dataswornId, move?.name)) {
      const { SiteGenerator } = await import("../narrative/generators.js");
      return SiteGenerator.discover({ ...opts, actor: opts.actor ?? this.getActiveCharacter() });
    }

    // 1. Preferred: the system pre-roll dialog.
    if (dataswornId && this.hasPrerollDialog()) {
      try {
        await this.api().applications.IronswornPrerollDialog.showForOfficialMove(dataswornId);
        return { ok: true, method: "dialog" };
      } catch (e) {
        warn(`showForOfficialMove("${dataswornId}") failed — falling back to manual roll:`, e?.message ?? e);
      }
    }

    // 2. Fallback: a manual Ironsworn action roll posted as a chat card.
    const actor = opts.actor ?? this.getActiveCharacter();
    const stat  = (opts.stat || move?.stats?.[0] || "").toLowerCase();
    if (stat && stat !== "progress" && stat !== "supply") {
      return this.manualMoveRoll(actor, stat, opts.adds ?? 0, move?.name ?? String(moveRef));
    }

    // 3. Progress / supply moves with no dialog — post a prompt for the GM.
    return {
      ok: false,
      method: "none",
      error: `Could not trigger "${move?.name ?? moveRef}" automatically (no dialog and no rollable stat). Resolve it manually on the sheet.`
    };
  },

  /* =================================================================
   *  MOVE DOCUMENT RESOLUTION (system move sheets / direct dialog)
   * ================================================================= */

  /**
   * Resolve a move reference (catalog name or Datasworn ID) to its
   * Datasworn ID, the canonical identifier the foundry-ironsworn system
   * uses for official moves.
   *
   * @param {string} ref
   * @returns {string|null}
   */
  moveDsId(ref) {
    const move = this._resolveMove(ref);
    if (move?.id) return move.id;
    return (typeof ref === "string" && ref.startsWith("move:")) ? ref : null;
  },

  /**
   * Find the *actual* foundry-ironsworn move Item for a Datasworn ID by
   * replicating the system's own lookup (datasworn2/finding.ts): locate the
   * right move compendium for the rules package, read its index with the
   * `flags` field, and match on `flags["foundry-ironsworn"].dsid`.
   *
   * Returns null (never throws) if the system isn't active, the pack is
   * missing, or no entry matches — callers degrade gracefully.
   *
   * @param {string} dsid  e.g. "move:classic/combat/strike"
   * @returns {Promise<Item|null>}
   */
  async getFoundryMoveByDsId(dsid) {
    try {
      if (!this.isActive() || !dsid) return null;
      const rulesPackage = dsRulesPackage(dsid);
      const packId = rulesPackage && MOVE_COMPENDIUM_BY_RULESET[rulesPackage];
      if (!packId) return null;

      const pack = game.packs?.get(packId);
      if (!pack) return null;

      const index = await pack.getIndex({ fields: ["flags"] });
      const entry = (index?.contents ?? index ?? []).find(
        (x) => x?.flags?.[SYSTEM_ID]?.dsid === dsid
      );
      if (!entry) return null;

      return await pack.getDocument(entry._id);
    } catch (e) {
      warn(`getFoundryMoveByDsId("${dsid}") failed:`, e?.message ?? e);
      return null;
    }
  },

  /**
   * Resolve a move reference to the UUID of its system move Item, suitable
   * for a Foundry content link (`@UUID[...]`). Async because the move
   * compendium index must be read. Returns null on any failure.
   *
   * @param {string} ref  catalog name or Datasworn ID
   * @returns {Promise<string|null>}
   */
  async getMoveUuid(ref) {
    const dsid = this.moveDsId(ref);
    if (!dsid) return null;
    const item = await this.getFoundryMoveByDsId(dsid);
    return item?.uuid ?? null;
  },

  /**
   * Open the foundry-ironsworn move's reference sheet (its rules text), the
   * same window you get by clicking a move's title on the character sheet.
   * Falls back to {@link openMoveDialog} if the move Item can't be resolved.
   *
   * @param {string} ref  catalog name or Datasworn ID
   * @returns {Promise<{ok:boolean, method:string, error?:string}>}
   */
  async openMoveSheet(ref) {
    try {
      if (!this.isActive()) return { ok: false, method: "none", error: "Ironsworn system not active." };
      const dsid = this.moveDsId(ref);
      const item = await this.getFoundryMoveByDsId(dsid);
      if (item?.sheet?.render) {
        item.sheet.render(true);
        return { ok: true, method: "sheet" };
      }
      // No document — fall back to the roll dialog.
      return await this.openMoveDialog(ref);
    } catch (e) {
      warn(`openMoveSheet("${ref}") failed:`, e?.message ?? e);
      return { ok: false, method: "sheet", error: e?.message ?? String(e) };
    }
  },

  /**
   * Open the system's official pre-roll dialog for a move directly (the
   * exact dialog the system shows when you click a move on the sheet),
   * using the Datasworn ID. This is the system API path — no fake rolls.
   *
   * @param {string} ref  catalog name or Datasworn ID
   * @param {object} [opts]  forwarded to showForOfficialMove (e.g. progress)
   * @returns {Promise<{ok:boolean, method:string, error?:string}>}
   */
  async openMoveDialog(ref, opts = {}) {
    const dsid = this.moveDsId(ref);
    if (dsid && this.hasPrerollDialog()) {
      try {
        await this.api().applications.IronswornPrerollDialog.showForOfficialMove(dsid, opts);
        return { ok: true, method: "dialog" };
      } catch (e) {
        warn(`openMoveDialog showForOfficialMove("${dsid}") failed:`, e?.message ?? e);
      }
    }
    return { ok: false, method: "none", error: `Could not open the move dialog for "${ref}".` };
  },

  /**
   * Manual Ironsworn action roll: 1d6 + stat + adds vs 2d10. Posts a
   * standard chat card with the rolls attached so re-roll/expansion
   * features keep working. Used only when the system dialog is missing.
   */
  async manualMoveRoll(actor, stat, adds = 0, moveName = "Move") {
    try {
      const statValue = actor ? (this.getStat(actor, stat) ?? 0) : 0;
      const action    = new Roll("1d6 + @s + @a", { s: statValue, a: adds });
      const challenge = new Roll("2d10");
      await action.evaluate();
      await challenge.evaluate();

      const cResults = challenge.dice[0].results.map(r => r.result);
      const score = Math.min(action.total, 10);
      const beats = cResults.filter(c => score > c).length;
      const outcome = beats === 2 ? "Strong Hit" : beats === 1 ? "Weak Hit" : "Miss";
      const match = cResults.length === 2 && cResults[0] === cResults[1];

      const content = `
        <div class="es-manual-move">
          <p><strong>${moveName}</strong> — manual roll (+${stat})</p>
          <p>Action: <strong>${action.total}</strong> (1d6+${statValue}+${adds}, capped ${score})
             vs Challenge ${cResults.join(" / ")}</p>
          <p>Outcome: <strong>${outcome}</strong>${match ? " — <em>match!</em>" : ""}</p>
        </div>`;

      await ChatMessage.create({
        speaker: actor ? ChatMessage.getSpeaker({ actor }) : { alias: "The Eternal Skald" },
        content,
        rolls: [action, challenge],
        sound: CONFIG?.sounds?.dice,
        flags: { "the-eternal-skald": { manualMove: true, moveName, stat, outcome, score, challenge: cResults, match } }
      });

      return { ok: true, method: "manual", outcome, score, challenge: cResults, match };
    } catch (e) {
      warn("manualMoveRoll failed:", e?.message ?? e);
      return { ok: false, method: "manual", error: e?.message ?? String(e) };
    }
  },

  /**
   * True iff `name` is the name of a PROGRESS MOVE rather than a track. The AI
   * frequently emits the move name ("Fulfill Your Vow" / "Reach Your
   * Destination") in a completion directive instead of the track's real,
   * player-chosen name — such a string must never be treated as a track name.
   */
  _isProgressMoveName(name) {
    const n = String(name ?? "").toLowerCase().trim().replace(/[.!?,;:]+$/, "");
    return n === "fulfill your vow"
        || n === "reach your destination"
        || n === "swear an iron vow"
        || n === "undertake a journey";
  },

  /**
   * True iff a move is a PROGRESS move that rolls a track's progress score
   * (rather than an action roll against a stat). The three the Skald drives:
   * "Fulfill Your Vow" (vows), "Reach Your Destination" (journeys), and
   * "End the Fight" (combat foes). Matched on Datasworn ID first
   * (rules-package agnostic) then by name (case/spacing-insensitive).
   */
  _isProgressMove(dsid, name) {
    const id = String(dsid ?? "").toLowerCase();
    // (v0.11.4 — Delve) "Locate Your Objective" and "Escape the Depths" are also
    // progress rolls — they roll a SITE track's progress score, exactly like
    // Fulfill Your Vow / Reach Your Destination roll a vow/journey. Without this
    // they used to dead-end at triggerMove()'s "no rollable stat" error.
    if (/\/(fulfill_your_vow|reach_your_destination|end_the_fight|locate_your_objective|escape_the_depths)$/.test(id)) return true;
    const n = String(name ?? "").toLowerCase().trim();
    return n === "fulfill your vow" || n === "reach your destination" || n === "end the fight"
        || n === "locate your objective" || n === "escape the depths";
  },

  /**
   * Is this the "Reach a Milestone" move?  It has no dice — it simply marks
   * progress on the most recently sworn vow by its rank.
   */
  _isMilestoneMove(dsid, name) {
    const id = String(dsid ?? "").toLowerCase();
    if (/\/reach_a_milestone$/.test(id)) return true;
    const n = String(name ?? "").toLowerCase().trim();
    return n === "reach a milestone";
  },

  /**
   * Is this the Ironsworn: Delve "Discover a Site" move?  It rolls no dice and
   * has no rollable stat, so it is handled by the AI site generator rather than
   * the action/progress roll paths.
   */
  _isDiscoverSiteMove(dsid, name) {
    const id = String(dsid ?? "").toLowerCase();
    if (/\/discover_a_site$/.test(id)) return true;
    const n = String(name ?? "").toLowerCase().trim();
    return n === "discover a site";
  },

  /**
   * Roll a PROGRESS move ("Fulfill Your Vow" / "Reach Your Destination" /
   * "End the Fight") against a progress track's score, via the system's own
   * progress-roll dialog (IronswornPrerollDialog.showForProgress) — identical
   * to clicking the track's roll button. This is the correct mechanic for
   * completing a vow, journey, or fight: you roll the track's progress score
   * (filled boxes, 0–10) against the two challenge dice, NOT an action die +
   * stat. Per Ironsworn rules, completing a fight grants NO experience (only
   * fulfilling a vow does), so this path never awards XP for "End the Fight".
   *
   * The track is resolved from (in order): an explicit `opts.trackRef`, then
   * the track the move implies — vow → newest open vow, journey → newest open
   * journey, combat → the active fight (then newest open foe). The move's
   * Datasworn ID is attached so the roll card shows the right move text/title.
   *
   * @param {string} moveRef  move name or Datasworn ID.
   * @param {object} [opts]
   * @param {Actor}  [opts.actor]
   * @param {string} [opts.trackRef]  explicit track name/id to roll against.
   * @returns {Promise<{ok:boolean, method:string, track?:string, error?:string}>}
   */
  async rollProgressMove(moveRef, opts = {}) {
    const move = this._resolveMove(moveRef);
    const dsid = move?.id ?? (typeof moveRef === "string" && moveRef.startsWith("move:") ? moveRef : null);
    const actor = opts.actor ?? this.getActiveCharacter();
    if (!actor) return { ok: false, method: "none", error: "No active character for a progress roll." };

    // Which kind of track does this move roll against?
    const idl = String(dsid ?? "").toLowerCase();
    const nml = String(move?.name ?? moveRef).toLowerCase();
    const kind = /reach_your_destination/.test(idl) || nml === "reach your destination" ? "journey"
               : /fulfill_your_vow/.test(idl)       || nml === "fulfill your vow"       ? "vow"
               : /end_the_fight/.test(idl)          || nml === "end the fight"           ? "combat"
               : /locate_your_objective|escape_the_depths/.test(idl)
                 || nml === "locate your objective" || nml === "escape the depths"        ? "site"
               : null;

    // Resolve the track: explicit ref wins, else newest open track of the kind.
    let track = opts.trackRef ? this.findTrack(actor, opts.trackRef) : null;
    if (!track && kind === "combat") {
      // Combat foes are stored as progress Items tagged trackKind "combat"
      // (or carrying the system's own "foe" subtype). Prefer the explicitly
      // tracked ACTIVE combat (the fight the story is currently about), then
      // fall back to the newest open foe track. getActiveCombat()/
      // getActiveCombatTrack() return lightweight summaries, so re-read the
      // real Item from the actor to roll its score.
      const ac = this.getActiveCombat(actor) ?? this.getActiveCombatTrack(actor);
      if (ac?.id) track = actor.items?.get?.(ac.id) ?? null;
    }
    // SITE moves ("Locate Your Objective" / "Escape the Depths") roll the
    // active site's progress score. Resolution, in order:
    //   • an explicit trackRef (the site-sheet roll button passes one) — handled
    //     above by findTrack;
    //   • exactly one open site → use it automatically;
    //   • several open sites → ask the player which one (never auto-decide);
    //   • no open site → a clear, actionable error.
    if (!track && kind === "site") {
      const sites = this._openSiteTracks(actor);
      if (sites.length === 1) {
        track = sites[0];
      } else if (sites.length > 1) {
        track = await this._showSiteSelectionDialog(sites, move?.name ?? String(moveRef));
        if (!track) return { ok: false, method: "cancelled", error: "Site selection cancelled." };
      }
      // sites.length === 0 falls through to the shared "no open track" error below.
    }
    if (!track && kind && kind !== "combat" && kind !== "site") track = this._newestOpenTrackItem(actor, kind);
    if (!track) {
      // Graceful closed-track fallback (v0.22.x — closed-track guard). If no
      // OPEN track of this kind exists but one was RECENTLY COMPLETED, the move
      // was offered against a track that is already finished (e.g. "End the
      // Fight" on a foe that is already defeated, or "Fulfill Your Vow" on a
      // vow just sworn-and-sealed). Return a clear, non-error "already complete"
      // result so the Skald narrates the resolution instead of dead-ending the
      // player with "begin one first". Applies uniformly to vows, journeys and
      // combat via the shared `kind` path. Read-only; never mutates the track.
      if (kind && typeof this._newestTrackItemOfKind === "function") {
        let recent = null;
        try { recent = this._newestTrackItemOfKind(actor, kind, /*openOnly=*/false); } catch (_) {}
        if (recent && foundry.utils.getProperty(recent, "system.completed")) {
          const done = kind === "combat" ? "that fight is already won"
                     : kind === "vow"    ? "that vow is already fulfilled"
                     : kind === "journey"? "that journey is already complete"
                     :                      `that ${kind} is already complete`;
          return {
            ok: false,
            method: "already-complete",
            track: recent.name,
            error: `“${recent.name}” is already complete — ${done}. There is no open ` +
                   `${kind === "combat" ? "fight" : kind} to roll "${move?.name ?? moveRef}" against.`
          };
        }
      }
      const noun = kind ?? "progress";
      const begin = kind === "combat" ? "Enter the fray"
                  : kind === "site"   ? "Discover a Site"
                  : `Begin the ${noun}`;
      const label = noun === "combat" ? "fight" : noun;
      return {
        ok: false,
        method: "none",
        error: `No open ${label} track to roll "${move?.name ?? moveRef}" against. ` +
               `${begin} first (or open its track card and roll from there).`
      };
    }

    // Remember WHICH track this progress move actually rolled against, so the
    // post-roll completion directive can close the CORRECT track even when the
    // AI names it after the move ("Fulfill Your Vow") rather than the track's
    // real, player-chosen name. See resolveCompletionTrack()/completeTrackSmart().
    this._lastProgressTrack = {
      id: track.id,
      name: track.name,
      kind: kind ?? null,
      actorId: actor.id,
      ts: Date.now()
    };

    // Progress SCORE = filled boxes (0–10) = floor(ticks / 4), capped at 10.
    const current = Number(foundry.utils.getProperty(track, "system.current") ?? 0);
    const score = Math.max(0, Math.min(10, Math.floor(current / 4)));

    // (v0.11.3 — progress gate) "Reach Your Destination" (and other progress
    // moves) should not be rolled before the journey/vow has been meaningfully
    // advanced — in Ironsworn you mark progress along the way, then make the
    // progress roll once you arrive. Rolling at 0–few boxes is almost always a
    // premature AI-offered roll that wastes the track. Gate it behind a minimum
    // number of filled boxes (configurable; default 4). The gate is skippable
    // with opts.force (a deliberate player override). Fully defensive: any
    // Settings read failure falls back to the documented defaults.
    // NOTE: this controller intentionally has no imports (settings.js imports
    // IT, so importing Settings here would be circular). Read the world setting
    // straight from Foundry under the module scope (ES_SCOPE === MODULE_ID).
    let gateOn = true, minBoxes = 4;
    try { const g = game?.settings?.get?.(ES_SCOPE, "enforceJourneyProgressGate"); gateOn = (g === undefined || g === null) ? true : !!g; } catch (_) {}
    try { const n = Number(game?.settings?.get?.(ES_SCOPE, "journeyMinProgressBoxes")); if (Number.isFinite(n) && n >= 0) minBoxes = n; } catch (_) {}
    // (gate 2026-06-14 — exact-10 arrival) "Reach Your Destination" RESOLVES the
    // arrival, so for a JOURNEY it may only be rolled once the track is FULLY
    // charted (10/10 boxes) — pairing with the integration-layer change that no
    // longer auto-completes a full journey, leaving it OPEN for this roll. The
    // enforceJourneyProgressGate toggle and opts.force remain the deliberate
    // overrides; journeyMinProgressBoxes still governs OTHER progress kinds, but
    // a journey now requires the full track regardless of that floor.
    // (gate 2026-06-14 — symmetric 10/10 completion gate) The v0.25.4 gate only
    // blocked journeys; extend the SAME exact-10/10 requirement to vow + combat so
    // a completion roll can't fire before the track is fully charted. `site` keeps
    // the journeyMinProgressBoxes floor; enforceJourneyProgressGate + opts.force
    // remain the deliberate overrides. (Intentionally stricter than Ironsworn RAW.)
    const strictKind = kind === "journey" || kind === "vow" || kind === "combat";
    const needBoxes = strictKind ? 10 : minBoxes;
    if (strictKind && gateOn && !opts.force && score < needBoxes) {
      const noun = kind === "combat" ? "fight" : kind;
      return {
        ok: false,
        method: "none",
        error: `“${track.name}” is only at ${score}/10 — "${move?.name ?? moveRef}" can be rolled ` +
               `once the ${noun} is fully charted (10/10 boxes). ` +
               `Mark more progress first (e.g. !progress <boxes>), ` +
               `then make the completion roll.`
      };
    }

    // Preferred: the system's progress-roll dialog (attaches the move card).
    const dlg = this.api()?.applications?.IronswornPrerollDialog;
    if (typeof dlg?.showForProgress === "function") {
      try {
        await dlg.showForProgress(track.name ?? "(progress)", score, actor, dsid ?? undefined);
        return { ok: true, method: "progress-dialog", track: track.name };
      } catch (e) {
        warn(`showForProgress("${track.name}") failed — trying the item's own fulfill():`, e?.message ?? e);
      }
    }

    // Fallback: the track item's own fulfill() (the same method the sheet's
    // roll button calls; picks the Fulfill Your Vow move for vow subtypes).
    const sys = track.system;
    if (typeof sys?.fulfill === "function") {
      try {
        await sys.fulfill();
        return { ok: true, method: "fulfill", track: track.name };
      } catch (e) {
        warn(`track.system.fulfill() failed:`, e?.message ?? e);
      }
    }

    return {
      ok: false,
      method: "none",
      error: `Could not roll "${move?.name ?? moveRef}" against “${track.name}” — the ` +
             `progress-roll dialog is unavailable. Roll it from the track on the sheet.`
    };
  },

  /* =================================================================
   *  ORACLES
   * ================================================================= */

  /**
   * Roll an Ironsworn oracle by RollTable name (or partial name). Uses
   * the system's RollTable pipeline so the result is a standard Ironsworn
   * oracle chat card. Returns the joined result text (or null).
   *
   * Falls back across: exact world table → fuzzy world table → compendium
   * search. The Skald's own built-in oracle tables (ironsworn-data.js)
   * remain available as a last resort in eternal-skald.js.
   */
  async rollOracle(nameOrId, { displayChat = true } = {}) {
    try {
      // 1. World RollTables (exact then fuzzy).
      let table = game.tables?.getName?.(nameOrId) ?? null;
      if (!table && nameOrId) {
        const lc = String(nameOrId).toLowerCase();
        table = game.tables?.find?.(t => t.name?.toLowerCase().includes(lc)) ?? null;
      }
      if (table) {
        const res = await table.draw({ displayChat });
        return res.results.map(r => r.text ?? r.name ?? "").filter(Boolean).join(", ");
      }

      // 2. Compendium packs that look like Ironsworn oracle tables.
      for (const pack of (game.packs ?? [])) {
        if (pack.documentName !== "RollTable") continue;
        if (!/ironsworn/i.test(pack.metadata?.id ?? pack.collection ?? "")) continue;
        const index = await pack.getIndex();
        const lc = String(nameOrId).toLowerCase();
        const entry = index.find(e => e.name?.toLowerCase() === lc)
                   ?? index.find(e => e.name?.toLowerCase().includes(lc));
        if (entry) {
          const doc = await pack.getDocument(entry._id);
          const res = await doc.draw({ displayChat });
          return res.results.map(r => r.text ?? r.name ?? "").filter(Boolean).join(", ");
        }
      }
    } catch (e) {
      warn("rollOracle failed:", e?.message ?? e);
    }
    return null;
  },

  /** Tokenise a phrase into meaningful (≥3-char, non-stopword) keywords. */
  _bonusTokens(s) {
    return String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(t => t.length >= 3 && !this._BONUS_STOPWORDS.has(t));
  },

  /** Extract the sentence/clause of `text` that contains character `idx`. */
  _bonusSentence(text, idx) {
    const breaks = [".", "!", "?", ";", "•"];
    let start = -1;
    for (const ch of breaks) {
      const p = text.lastIndexOf(ch, Math.max(0, idx - 1));
      if (p > start) start = p;
    }
    let end = text.length;
    for (const ch of breaks) {
      const e = text.indexOf(ch, idx);
      if (e !== -1 && e < end) end = e;
    }
    let s = text.slice(start + 1, end + 1).trim();
    if (s.length > 200) s = s.slice(0, 197) + "…";
    return s;
  },

  /**
   * Scan a character's enabled asset abilities for roll bonuses that
   * plausibly apply to the move being made.
   *
   * @param {Array<{name:string,abilities?:string[]}>} assets
   *        Asset snapshot from {@link getAssets}.
   * @param {string} moveName              The move being declared.
   * @param {object} [opts]
   * @param {string} [opts.stat=""]        The stat being rolled (optional).
   * @param {number} [opts.maxResults=4]   Cap on suggestions returned.
   * @returns {Array<{asset:string,bonus:number,condition:string,relevance:number}>}
   *   Sorted by relevance (desc); never null. Empty when nothing applies.
   */
  detectAssetBonuses(assets, moveName, { stat = "", maxResults = 4 } = {}) {
    const out = [];
    if (!Array.isArray(assets) || !assets.length) return out;
    const moveTokens = this._bonusTokens(moveName);
    const statTok = String(stat ?? "").toLowerCase().trim();
    if (!moveTokens.length && !statTok) return out;
    const seen = new Set();
    for (const asset of assets) {
      const abilities = Array.isArray(asset?.abilities) ? asset.abilities : [];
      for (const raw of abilities) {
        const text = String(raw ?? "")
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (!text) continue;
        const lc = text.toLowerCase();
        const re = /\+(\d+)\b/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const bonus = parseInt(m[1], 10);
          if (!Number.isFinite(bonus) || bonus <= 0 || bonus > 9) continue;
          const condition = this._bonusSentence(text, m.index);
          const condLc = condition.toLowerCase();
          // A bonus is "relevant" when the move's keywords appear near it.
          // Matches inside the bonus's own sentence count double; matches
          // elsewhere in the ability count single. A stat match adds one.
          let relevance = 0;
          for (const t of moveTokens) {
            if (condLc.includes(t)) relevance += 2;
            else if (lc.includes(t)) relevance += 1;
          }
          if (statTok && (condLc.includes(statTok) || lc.includes(statTok))) relevance += 1;
          if (relevance <= 0) continue;
          const key = `${asset?.name ?? ""}|${bonus}|${condition}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ asset: asset?.name ?? "(asset)", bonus, condition, relevance });
        }
      }
    }
    out.sort((a, b) => (b.relevance - a.relevance) || (b.bonus - a.bonus));
    return out.slice(0, Math.max(1, maxResults));
  },

  /* =================================================================
   *  INTERNAL HELPERS
   * ================================================================= */

  /** Resolve a move catalog entry from an ID or a (fuzzy) name. */
  _resolveMove(ref) {
    if (!ref) return null;
    const s = String(ref).trim();
    if (MOVE_BY_ID.has(s)) return MOVE_BY_ID.get(s);
    const lc = s.toLowerCase();
    if (MOVE_BY_NAME.has(lc)) return MOVE_BY_NAME.get(lc);
    // Fuzzy: strip a leading "roll " and trailing "+stat", match by name.
    const cleaned = lc.replace(/^roll\s+/, "").replace(/\s*\+.*$/, "").trim();
    if (MOVE_BY_NAME.has(cleaned)) return MOVE_BY_NAME.get(cleaned);
    return MOVE_CATALOG.find(m => cleaned && m.name.toLowerCase().includes(cleaned)) ?? null;
  },

  /**
   * Decide whether a free-form player message is a MOVE DECLARATION — i.e. the
   * player naming an official Ironsworn move they wish to make right now (e.g.
   * "Face Danger", "I want to Strike", "Secure an Advantage +iron") — as
   * opposed to a narrative request, rules question, or conversational prompt.
   *
   * This powers the "player agency" rule (v0.10.33): a declared move is the
   * PLAYER's mechanical choice, so it should open the move's roll dialog and
   * STOP — the story only continues AFTER the dice resolve (handled by the
   * existing post-roll auto-narration). It must NOT trigger AI narrative.
   *
   * The matcher is deliberately CONSERVATIVE to avoid hijacking genuine
   * narration requests:
   *   • Anything containing "?" or starting with an interrogative / narration
   *     verb (what/how/should/tell/describe/continue …) is never a declaration.
   *   • An optional trailing stat ("+iron", "with wits", "using edge") is
   *     parsed and validated against the move's rollable stats.
   *   • Leading intention phrases ("I want to", "let me", "roll", "make a" …)
   *     are stripped — but exact-match is checked at every strip level first,
   *     so a move whose own name starts with such a word ("Make Camp") is not
   *     accidentally gutted.
   *   • EXACT name matches (after stripping) are accepted for ANY move.
   *   • PREFIX matches ("Secure an Advantage over the bandit") are accepted
   *     ONLY for multi-word move names with a short, non-conjunction trailing
   *     target — single-word moves (Strike, Heal, Clash…) require an exact
   *     match so common verbs used narratively are not misread.
   *
   * Pure & defensive: never throws, returns `null` on no/low confidence.
   *
   * @param {string} text  The player's free-form prompt (the part after "!").
   * @returns {{move: object, stat: string, confidence: "exact"|"prefix"}|null}
   */
  detectMoveDeclaration(text) {
    try {
      if (!text || typeof text !== "string") return null;
      let norm = text.trim();
      if (!norm) return null;
      // Questions / narration requests are never move declarations.
      if (norm.includes("?")) return null;
      norm = norm.toLowerCase().replace(/\s+/g, " ").trim();
      // Drop surrounding quotes.
      norm = norm.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "").trim();
      if (!norm) return null;
      // Reject clear interrogatives & narration-seeking verbs up front. We
      // deliberately omit auxiliary verbs (do/can/should/will…) here because
      // they double as imperative intention words ("do a Strike") and are
      // handled by the LEAD stripping below; genuine questions almost always
      // carry a "?" (already rejected) or a leading interrogative kept here.
      const NARRATION_LEAD = /^(what|how|why|where|who|when|which|whose|tell|describe|narrate|explain|continue|go on|and then|then what|give|show|help|suggest)\b/;
      if (NARRATION_LEAD.test(norm)) return null;

      // Parse an optional trailing stat ("+iron" / "with iron" / "using wits").
      // No leading \b before "+": a preceding space is a non-word/non-word
      // boundary, so "\b\+" would never match "danger +iron".
      let stat = "";
      const statMatch = norm.match(/(?:\+\s*|\bwith\s+|\busing\s+)(edge|heart|iron|shadow|wits)\b\.?$/);
      if (statMatch) {
        stat = statMatch[1];
        norm = norm.slice(0, statMatch.index).trim();
      }

      // Build progressively-stripped candidate strings. Exact match is tested
      // against EARLIER (less-stripped) candidates first so a move whose name
      // legitimately begins with an intention word is matched before that word
      // is stripped away.
      const LEAD = /^(?:i(?:'?m)? going to|i am going to|i'?m gonna|i'?m about to|going to|gonna|i want to|i'?d like to|i would like to|i wish to|i need to|let me|lets|let's|i'?ll|i will|i'?d|i shall|i|please|can i|may i|time to|now i|roll(?: the| a)?|make(?: the| a)?|do(?: the| a)?|use(?: the| a)?|trigger(?: the| a)?|attempt(?: to)?|try(?: to| and)?|invoke)\s+/;
      const candidates = [];
      const seen = new Set();
      const tidy = (c) => String(c)
        .replace(/\s+move$/, "")        // trailing "… move"
        .replace(/[.!,;:]+$/, "")        // trailing punctuation
        .trim();
      const pushCand = (c) => {
        const v = tidy(c);
        if (v && !seen.has(v)) { seen.add(v); candidates.push(v); }
      };
      pushCand(norm);
      let cur = norm;
      for (let i = 0; i < 2; i++) {
        const next = cur.replace(LEAD, "").trim();
        if (next === cur) break;
        cur = next;
        pushCand(cur);
      }

      const pickStat = (m) => (stat && Array.isArray(m.stats) && m.stats.includes(stat)) ? stat : "";

      // 1. EXACT match (any move), least-stripped candidate first.
      for (const cand of candidates) {
        for (const m of MOVE_CATALOG) {
          if (cand === m.name.toLowerCase()) {
            return { move: m, stat: pickStat(m), confidence: "exact" };
          }
        }
      }

      // 2. PREFIX match — multi-word moves only, short non-conjunction target.
      const CONNECTOR = /^(and|then|because|while|as|so|but|or)\b/;
      for (const cand of candidates) {
        for (const m of MOVE_CATALOG) {
          const lc = m.name.toLowerCase();
          if (!lc.includes(" ")) continue;            // single-word → exact only
          if (cand.startsWith(lc + " ")) {
            const rest = cand.slice(lc.length).trim();
            if (CONNECTOR.test(rest)) continue;        // looks like narration
            if (rest.split(/\s+/).length <= 4) {
              return { move: m, stat: pickStat(m), confidence: "prefix" };
            }
          }
        }
      }

      return null;
    } catch (e) {
      warn("detectMoveDeclaration failed:", e?.message ?? e);
      return null;
    }
  },

  /**
   * Build the system + user messages for the action classifier. The model is
   * asked to decide whether the player's message is a mechanical ACTION (and
   * if so, which Ironsworn move[s] it triggers), a QUESTION seeking guidance,
   * or pure ROLEPLAY — and to answer with STRICT JSON only. The move list is
   * grounded with the documented triggers in MOVE_TRIGGERS so the mapping is
   * rules-accurate rather than guessed.
   *
   * Pure: returns plain strings; never touches Foundry or the network.
   *
   * @param {string} text  The player's free-form message (after "!").
   * @param {object} [opts]
   * @param {string} [opts.sceneContext]  Optional short fiction/combat context
   *   to help disambiguate (e.g. "In combat", "Exploring a delve site").
   * @returns {{system: string, user: string}}
   */
  buildActionClassifierPrompt(text, { sceneContext = "" } = {}) {
    const lines = [];
    for (const m of MOVE_CATALOG) {
      const trig = MOVE_TRIGGERS[m.name];
      if (!trig) continue; // only the action-relevant, documented moves
      const stats = (m.stats || []).filter(s => this.ACTION_STATS.includes(s));
      const statHint = stats.length ? ` [stats: ${stats.join(", ")}]` : "";
      lines.push(`- ${m.name}${statHint}: ${trig}`);
    }
    const moveList = lines.join("\n");

    const system =
      "You are a strict classifier for an Ironsworn tabletop RPG assistant. " +
      "Given a player's chat message, decide which ONE of three intents it is:\n" +
      '  • "action"   — the player describes doing something in the fiction that ' +
      "triggers an Ironsworn move (e.g. \"I search the ruins\", \"I attack the wolf\").\n" +
      '  • "question" — the player asks for guidance, rules, or what to do ' +
      "(e.g. \"what should I do?\", \"which move fits?\").\n" +
      '  • "roleplay" — pure dialogue, description, or narration with NO ' +
      "mechanical action (e.g. \"I tell the jarl my name\", \"I admire the view\").\n\n" +
      "If and only if the intent is \"action\", identify the most likely move(s) " +
      "from the list below, most likely first. If two or more moves genuinely fit " +
      "(true ambiguity), list them all. Use ONLY exact move names from this list. " +
      "Pick a stat only if the action clearly implies one; otherwise leave it empty.\n\n" +
      "MOVES AND THEIR TRIGGERS:\n" + moveList + "\n\n" +
      "Respond with STRICT JSON ONLY (no prose, no code fence), shaped exactly:\n" +
      '{"type":"action|question|roleplay",' +
      '"moves":[{"name":"<exact move name>","stat":"<edge|heart|iron|shadow|wits or empty>","confidence":"high|medium|low"}],' +
      '"reason":"<one short clause>"}\n' +
      'For "question" or "roleplay", return an empty "moves" array. ' +
      "Be conservative: if the message is mostly description or you are unsure an " +
      'action triggers a move, prefer "roleplay" or a "low" confidence.';

    const ctx = sceneContext ? `Current scene context: ${sceneContext}\n\n` : "";
    const user = `${ctx}Player message:\n"""${String(text ?? "").trim()}"""`;

    return { system, user };
  },

  /**
   * Defensively parse the classifier's reply into a normalised object. Tolerates
   * code fences and surrounding prose by extracting the first JSON object. Every
   * candidate move is validated against the REAL catalog (invalid names dropped)
   * and its stat validated against that move's rollable stats (invalid → empty).
   *
   * Pure & never throws. Returns null when nothing usable could be parsed.
   *
   * @param {string} raw  The model's text reply.
   * @returns {{type:"action"|"question"|"roleplay",
   *            moves:Array<{move:object,name:string,stat:string,confidence:string}>,
   *            reason:string}|null}
   */
  parseActionClassification(raw) {
    try {
      if (!raw || typeof raw !== "string") return null;
      let s = raw.trim();
      // Strip a ```json … ``` fence if present.
      s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      // Extract the first {...} block if the model added stray prose.
      if (s[0] !== "{") {
        const a = s.indexOf("{");
        const b = s.lastIndexOf("}");
        if (a === -1 || b === -1 || b <= a) return null;
        s = s.slice(a, b + 1);
      }
      const obj = JSON.parse(s);
      if (!obj || typeof obj !== "object") return null;

      let type = String(obj.type || "").toLowerCase().trim();
      if (!["action", "question", "roleplay"].includes(type)) {
        // Unknown/missing type → treat as non-actionable (safe default).
        type = "roleplay";
      }

      const out = [];
      const seen = new Set();
      const rawMoves = Array.isArray(obj.moves) ? obj.moves : [];
      for (const entry of rawMoves) {
        if (!entry) continue;
        const nm = typeof entry === "string" ? entry : entry.name;
        const move = this._resolveMove(nm);
        if (!move) continue;                          // not a real move → drop
        if (seen.has(move.name)) continue;            // de-dupe
        seen.add(move.name);
        let stat = String(entry.stat || "").toLowerCase().trim();
        if (!Array.isArray(move.stats) || !move.stats.includes(stat)) stat = "";
        let confidence = String(entry.confidence || "").toLowerCase().trim();
        if (!["high", "medium", "low"].includes(confidence)) confidence = "medium";
        out.push({ move, name: move.name, stat, confidence });
      }

      return {
        type,
        moves: out,
        reason: typeof obj.reason === "string" ? obj.reason.trim() : ""
      };
    } catch (e) {
      warn("parseActionClassification failed:", e?.message ?? e);
      return null;
    }
  },

  /**
   * Decide what to DO with a parsed classification. Pure routing logic, kept
   * separate from the AI call so it can be unit-tested exhaustively.
   *
   * Routing:
   *   • non-action (question/roleplay) or no valid move        → "narrate"
   *   • ≥ 2 valid candidate moves (ambiguous)                  → "confirm"
   *   • exactly 1 move:
   *       – confidence "low"                                   → "narrate"
   *       – confidence "medium", OR alwaysConfirm set          → "confirm"
   *       – confidence "high"                                  → "roll"
   *
   * @param {object|null} parsed  Output of parseActionClassification.
   * @param {object} [opts]
   * @param {boolean} [opts.alwaysConfirm=false]  Force a confirmation card even
   *   for a single high-confidence match (player-agency / cautious GMs).
   * @returns {{action:"roll"|"confirm"|"narrate",
   *            move?:object, stat?:string,
   *            candidates?:Array<{move:object,name:string,stat:string,confidence:string}>,
   *            reason?:string}}
   */
  decideActionRouting(parsed, { alwaysConfirm = false } = {}) {
    const NARRATE = { action: "narrate" };
    try {
      if (!parsed || parsed.type !== "action") return NARRATE;
      const moves = Array.isArray(parsed.moves) ? parsed.moves : [];
      if (moves.length === 0) return NARRATE;

      if (moves.length >= 2) {
        return { action: "confirm", candidates: moves, reason: parsed.reason || "" };
      }

      const only = moves[0];
      if (only.confidence === "low") return NARRATE;
      if (alwaysConfirm || only.confidence === "medium") {
        return { action: "confirm", candidates: [only], reason: parsed.reason || "" };
      }
      // single high-confidence match
      return { action: "roll", move: only.move, stat: only.stat, reason: parsed.reason || "" };
    } catch (e) {
      warn("decideActionRouting failed:", e?.message ?? e);
      return NARRATE;
    }
  },

  /** Choose the first Item type the system actually registers. */
  _pickItemType(candidates) {
    const registered = Object.keys(CONFIG?.Item?.dataModels ?? {});
    for (const c of candidates) {
      if (registered.includes(c)) return c;
    }
    // Fall back to whatever the system lists first, else "progress".
    return registered[0] ?? "progress";
  }
};
