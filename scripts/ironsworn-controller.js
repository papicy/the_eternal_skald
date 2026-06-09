/* =====================================================================
 *  THE ETERNAL SKALD — Ironsworn System Controller (v0.6.0)
 *  ---------------------------------------------------------------------
 *  This module is the bridge between The Eternal Skald (the "GM brain")
 *  and the official `foundry-ironsworn` system (the "rules engine",
 *  maintained by Ben Straub). The Skald decides WHAT should happen
 *  narratively and mechanically; this controller asks the Ironsworn
 *  system to actually DO it — roll moves, roll oracles, update the
 *  character sheet, mark progress, apply harm/stress, etc.
 *
 *  DESIGN PRINCIPLES
 *  -----------------
 *  1. Feature-detect everything. The Ironsworn system does not publish a
 *     stable versioned developer API, so every entry point is probed
 *     defensively and degrades gracefully (see the project research:
 *     foundry_ironsworn_module_programmatic_api_report.md).
 *  2. Never throw out of a read. Reads return null / [] on failure so the
 *     AI context builder can simply omit missing data.
 *  3. Writes go through `actor.update()` and the system's own dialogs so
 *     the system stays the single source of truth and fires its hooks.
 *  4. Datasworn IDs (post v1.24.0), e.g. `move:classic/adventure/face_danger`.
 *
 *  This file is imported by eternal-skald.js. It has no Foundry imports
 *  of its own — it uses the global `game`, `canvas`, `CONFIG`, `Roll`,
 *  `ChatMessage`, and `foundry.utils` objects provided at runtime.
 * ===================================================================== */

const SYSTEM_ID = "foundry-ironsworn";
const LOG_PREFIX = "The Eternal Skald | Ironsworn |";

/* The Skald's flag scope on actors/items (initiative state, track kind). */
const ES_SCOPE = "the-eternal-skald";

/* Canonical Ironsworn progress-track ranks, lowest → highest danger. */
const RANKS = Object.freeze(["troublesome", "dangerous", "formidable", "extreme", "epic"]);

/* Ticks marked per "mark progress" action, by rank (4 ticks = 1 box). */
const RANK_TICKS = Object.freeze({
  troublesome: 12, dangerous: 8, formidable: 4, extreme: 2, epic: 1
});

/* foundry-ironsworn stores a foe's challenge rank as a NUMBER 1–5 on
 * `system.rank` (see ChallengeRank.ts in the system). Map it to our
 * canonical rank words. 1=Troublesome … 5=Epic. */
const RANK_NUM = Object.freeze({
  1: "troublesome", 2: "dangerous", 3: "formidable", 4: "extreme", 5: "epic"
});

/* Inverse of RANK_NUM: canonical rank word → the NUMBER 1–5 the
 * foundry-ironsworn ChallengeRank field stores. Used when creating progress
 * tracks so we write the numeric value the data model expects directly,
 * rather than relying on the system's string-coercion (_cast) path. */
const RANK_TO_NUM = Object.freeze({
  troublesome: 1, dangerous: 2, formidable: 3, extreme: 4, epic: 5
});

/* Debug logging is toggled by eternal-skald.js via setDebug(). */
let DEBUG = false;

function dbg(...args) {
  if (DEBUG) console.log(LOG_PREFIX, ...args);
}
function warn(...args) {
  console.warn(LOG_PREFIX, ...args);
}

/* ---------------------------------------------------------------------
 *  MOVE CATALOG
 *  ---------------------------------------------------------------------
 *  A curated catalog of the classic Ironsworn (+ Delve) moves the Skald
 *  may suggest or trigger. Each entry carries:
 *    - id    : the Datasworn move ID used by showForOfficialMove()
 *    - name  : human-readable label
 *    - stats : the stats this move can roll with (for the AI + fallback)
 *    - cat   : grouping for the move-selector UI
 *  If `showForOfficialMove` rejects an ID (older/newer data tree), the
 *  controller falls back to a manual action roll using `stats[0]`.
 * ------------------------------------------------------------------- */
const MOVE_CATALOG = Object.freeze([
  // — Adventure —
  { id: "move:classic/adventure/face_danger",          name: "Face Danger",           stats: ["edge", "heart", "iron", "shadow", "wits"], cat: "Adventure" },
  { id: "move:classic/adventure/secure_an_advantage",  name: "Secure an Advantage",   stats: ["edge", "heart", "iron", "shadow", "wits"], cat: "Adventure" },
  { id: "move:classic/adventure/gather_information",   name: "Gather Information",    stats: ["wits"],                                     cat: "Adventure" },
  { id: "move:classic/adventure/heal",                 name: "Heal",                  stats: ["wits", "iron"],                             cat: "Adventure" },
  { id: "move:classic/adventure/resupply",             name: "Resupply",              stats: ["wits"],                                     cat: "Adventure" },
  { id: "move:classic/adventure/make_camp",            name: "Make Camp",             stats: ["supply"],                                   cat: "Adventure" },
  { id: "move:classic/adventure/undertake_a_journey",  name: "Undertake a Journey",   stats: ["wits"],                                     cat: "Adventure" },
  { id: "move:classic/adventure/reach_your_destination", name: "Reach Your Destination", stats: [],                                       cat: "Adventure" },
  // — Combat —
  { id: "move:classic/combat/enter_the_fray",          name: "Enter the Fray",        stats: ["heart", "shadow", "wits"],                  cat: "Combat" },
  { id: "move:classic/combat/strike",                  name: "Strike",                stats: ["iron", "edge"],                             cat: "Combat" },
  { id: "move:classic/combat/clash",                   name: "Clash",                 stats: ["iron", "edge"],                             cat: "Combat" },
  { id: "move:classic/combat/turn_the_tide",           name: "Turn the Tide",         stats: [],                                           cat: "Combat" },
  { id: "move:classic/combat/end_the_fight",           name: "End the Fight",         stats: [],                                           cat: "Combat" },
  { id: "move:classic/combat/battle",                  name: "Battle",                stats: ["edge", "heart", "iron", "shadow", "wits"],  cat: "Combat" },
  // — Suffer —
  { id: "move:classic/suffer/endure_harm",             name: "Endure Harm",           stats: ["iron"],                                     cat: "Suffer" },
  { id: "move:classic/suffer/endure_stress",           name: "Endure Stress",         stats: ["heart"],                                    cat: "Suffer" },
  { id: "move:classic/suffer/companion_endure_harm",   name: "Companion Endure Harm", stats: ["iron"],                                     cat: "Suffer" },
  { id: "move:classic/suffer/face_death",              name: "Face Death",            stats: [],                                           cat: "Suffer" },
  { id: "move:classic/suffer/face_desolation",         name: "Face Desolation",       stats: [],                                           cat: "Suffer" },
  { id: "move:classic/suffer/out_of_supply",           name: "Out of Supply",         stats: [],                                           cat: "Suffer" },
  { id: "move:classic/suffer/face_a_setback",          name: "Face a Setback",        stats: [],                                           cat: "Suffer" },
  // — Quest —
  { id: "move:classic/quest/swear_an_iron_vow",        name: "Swear an Iron Vow",     stats: ["heart"],                                    cat: "Quest" },
  { id: "move:classic/quest/reach_a_milestone",        name: "Reach a Milestone",     stats: [],                                           cat: "Quest" },
  { id: "move:classic/quest/fulfill_your_vow",         name: "Fulfill Your Vow",      stats: ["progress"],                                 cat: "Quest" },
  { id: "move:classic/quest/forsake_your_vow",         name: "Forsake Your Vow",      stats: [],                                           cat: "Quest" },
  { id: "move:classic/quest/advance",                  name: "Advance",               stats: [],                                           cat: "Quest" },
  // — Relationship —
  { id: "move:classic/relationship/compel",            name: "Compel",                stats: ["heart", "iron", "shadow"],                  cat: "Relationship" },
  { id: "move:classic/relationship/sojourn",           name: "Sojourn",               stats: ["heart"],                                    cat: "Relationship" },
  { id: "move:classic/relationship/draw_the_circle",   name: "Draw the Circle",       stats: ["iron"],                                     cat: "Relationship" },
  { id: "move:classic/relationship/forge_a_bond",      name: "Forge a Bond",          stats: ["heart"],                                    cat: "Relationship" },
  { id: "move:classic/relationship/test_your_bond",    name: "Test Your Bond",        stats: ["heart"],                                    cat: "Relationship" },
  { id: "move:classic/relationship/aid_your_ally",     name: "Aid Your Ally",         stats: [],                                           cat: "Relationship" },
  { id: "move:classic/relationship/write_your_epilogue", name: "Write Your Epilogue", stats: ["progress"],                                 cat: "Relationship" },
  // — Delve (Ironsworn: Delve) —
  { id: "move:delve/delve/discover_a_site",            name: "Discover a Site",       stats: [],                                           cat: "Delve" },
  { id: "move:delve/delve/delve_the_depths",           name: "Delve the Depths",      stats: ["edge", "shadow", "wits"],                   cat: "Delve" },
  { id: "move:delve/delve/find_an_opportunity",        name: "Find an Opportunity",   stats: [],                                           cat: "Delve" },
  { id: "move:delve/delve/reveal_a_danger",            name: "Reveal a Danger",       stats: [],                                           cat: "Delve" },
  { id: "move:delve/delve/locate_your_objective",      name: "Locate Your Objective", stats: ["progress"],                                 cat: "Delve" },
  { id: "move:delve/delve/escape_the_depths",          name: "Escape the Depths",     stats: ["progress"],                                 cat: "Delve" },
  // — Fate / Oracle —
  { id: "move:classic/fate/ask_the_oracle",            name: "Ask the Oracle",        stats: [],                                           cat: "Fate" },
  { id: "move:classic/fate/pay_the_price",             name: "Pay the Price",         stats: [],                                           cat: "Fate" }
]);

/* Quick lookup helpers built from the catalog. */
const MOVE_BY_ID = new Map(MOVE_CATALOG.map(m => [m.id, m]));
const MOVE_BY_NAME = new Map(MOVE_CATALOG.map(m => [m.name.toLowerCase(), m]));

/* ---------------------------------------------------------------------
 *  MOVE COMPENDIUM MAP (mirrors foundry-ironsworn's COMPENDIUM_KEY_MAP)
 *  ---------------------------------------------------------------------
 *  The official system stores every move as an `sfmove` Item inside one of
 *  these compendium packs, keyed by the rules-package segment of a Datasworn
 *  ID (`move:<rulesPackage>/<category>/<key>`). Each move Item carries the
 *  flag `flags["foundry-ironsworn"].dsid` = its Datasworn ID, which is how
 *  the system resolves an ID to a Document (see datasworn2/finding.ts:
 *  getFoundryMoveByDsId). We replicate that lookup so the Skald can turn a
 *  catalog move into a *real* system move Document / UUID and open the
 *  system's own move sheet or pre-roll dialog directly.
 * ------------------------------------------------------------------- */
const MOVE_COMPENDIUM_BY_RULESET = Object.freeze({
  classic:        "foundry-ironsworn.ironswornmoves",
  delve:          "foundry-ironsworn.ironsworndelvemoves",
  starforged:     "foundry-ironsworn.starforgedmoves",
  sundered_isles: "foundry-ironsworn.sunderedislesmoves"
});

/** Parse the rules-package segment from a Datasworn move ID. */
function dsRulesPackage(dsid) {
  // "move:classic/combat/strike" → "classic"
  const m = /^move:([^/]+)\//.exec(String(dsid ?? ""));
  return m ? m[1] : null;
}

/* The five Ironsworn stats + the standard condition meters. */
const STAT_KEYS  = ["edge", "heart", "iron", "shadow", "wits"];
const METER_KEYS = ["health", "spirit", "supply", "momentum"];
const DEBILITY_KEYS = [
  "wounded", "shaken", "unprepared", "encumbered", "maimed",
  "corrupted", "cursed", "tormented", "battered", "doomed"
];

/* =====================================================================
 *  THE CONTROLLER
 * ===================================================================== */
export const IronswornController = {

  /* ---------------- Configuration ---------------- */

  setDebug(on) { DEBUG = !!on; },

  /** Expose the catalog (read-only) for the UI / system prompt. */
  get moves() { return MOVE_CATALOG; },

  /* ---------------- Detection & probing ---------------- */

  /** True iff the active game system is foundry-ironsworn. */
  isActive() {
    try { return game?.system?.id === SYSTEM_ID; }
    catch (_) { return false; }
  },

  /** The CONFIG.IRONSWORN namespace, or null. */
  api() {
    if (!this.isActive()) return null;
    return globalThis.CONFIG?.IRONSWORN ?? null;
  },

  /** True iff the official move pre-roll dialog is available. */
  hasPrerollDialog() {
    const api = this.api();
    return typeof api?.applications?.IronswornPrerollDialog?.showForOfficialMove === "function";
  },

  /** A small capability report for diagnostics / the !skald-status card. */
  capabilities() {
    return {
      systemActive:    this.isActive(),
      prerollDialog:   this.hasPrerollDialog(),
      characterSheet:  !!this.api()?.applications?.SFCharacterMoveSheet,
      activeCharacter: !!this.getActiveCharacter()
    };
  },

  /* =================================================================
   *  READ — character, stats, meters, debilities, progress tracks
   * ================================================================= */

  /**
   * Resolve "the actor the Skald should act for" with the same priority
   * the Ironsworn dialog uses: controlled token → user's character →
   * sole owned character.
   */
  getActiveCharacter() {
    try {
      const controlled = canvas?.tokens?.controlled?.[0]?.actor;
      if (controlled) return controlled;
      if (game?.user?.character) return game.user.character;
      const owned = (game?.actors ?? []).filter(a =>
        a?.type === "character" && a.testUserPermission?.(game.user, "OWNER"));
      return owned.length === 1 ? owned[0] : null;
    } catch (e) {
      warn("getActiveCharacter failed:", e?.message ?? e);
      return null;
    }
  },

  /** Read a single stat (edge|heart|iron|shadow|wits), or null. */
  getStat(actor, stat) {
    if (!actor) return null;
    const v = foundry.utils.getProperty(actor, `system.${stat}`);
    return typeof v === "number" ? v : null;
  },

  /** All five stats as an object; missing values become null. */
  getStats(actor) {
    const out = {};
    for (const s of STAT_KEYS) out[s] = this.getStat(actor, s);
    return out;
  },

  /**
   * Read a condition meter (health|spirit|supply|momentum). Returns
   * `{ value, max, min }` (max/min may be null). Tries the common
   * v10+ paths and a couple of legacy shapes.
   */
  getMeter(actor, key) {
    if (!actor) return null;
    const candidates = [
      `system.${key}`,
      `system.${key}.value`,
      `system.attributes.${key}.value`
    ];
    for (const path of candidates) {
      const v = foundry.utils.getProperty(actor, path);
      if (typeof v === "number") {
        // momentum has a reset & max; supply is 0-5; health/spirit 0-5
        const max = foundry.utils.getProperty(actor, `system.${key}.max`) ??
                    (key === "momentum" ? 10 : 5);
        const min = key === "momentum" ? -6 : 0;
        return { value: v, max, min };
      }
    }
    return null;
  },

  /** All standard meters as an object of `{ value, max, min }` (or null). */
  getMeters(actor) {
    const out = {};
    for (const k of METER_KEYS) out[k] = this.getMeter(actor, k);
    return out;
  },

  /** Active debilities (conditions/banes/burdens) as a list of keys. */
  getDebilities(actor) {
    if (!actor) return [];
    const active = [];
    for (const key of DEBILITY_KEYS) {
      const v = foundry.utils.getProperty(actor, `system.debility.${key}`);
      if (v === true) active.push(key);
    }
    // Some data models nest condition flags differently — best effort.
    const debilityObj = foundry.utils.getProperty(actor, "system.debility");
    if (debilityObj && typeof debilityObj === "object") {
      for (const [k, v] of Object.entries(debilityObj)) {
        if (v === true && !active.includes(k)) active.push(k);
      }
    }
    return active;
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

  /**
   * Produce a compact, AI-friendly description of a character's full
   * mechanical state. Returns "" when no character is resolvable so the
   * prompt builder can omit the section cleanly.
   */
  describeCharacter(actor = this.getActiveCharacter()) {
    if (!this.isActive()) return "";
    if (!actor) return "(No active Ironsworn character could be resolved — select a token or set your player character.)";

    const lines = [`Character: ${actor.name}`];

    const stats = this.getStats(actor);
    const statStr = STAT_KEYS
      .map(s => `${s[0].toUpperCase()}${s.slice(1)} ${stats[s] ?? "?"}`)
      .join(", ");
    lines.push(`Stats: ${statStr}`);

    const meters = this.getMeters(actor);
    const meterStr = METER_KEYS
      .map(k => meters[k] ? `${k} ${meters[k].value}` : null)
      .filter(Boolean)
      .join(", ");
    if (meterStr) lines.push(`Meters: ${meterStr}`);

    const debilities = this.getDebilities(actor);
    if (debilities.length) lines.push(`Debilities: ${debilities.join(", ")}`);

    const tracks = this.getProgressTracks(actor);
    if (tracks.length) {
      lines.push("Progress tracks:");
      for (const t of tracks.slice(0, 12)) {
        const rank = t.rank ? ` [${t.rank}]` : "";
        const done = t.completed ? " (completed)" : "";
        lines.push(`  - ${t.name}${rank}: ${t.boxes}/10 boxes (${t.current}/40 ticks)${done}`);
      }
    }
    return lines.join("\n");
  },

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

    // 0. PROGRESS MOVES — "Fulfill Your Vow" and "Reach Your Destination" are
    //    not action rolls against a stat; they are PROGRESS rolls against a
    //    specific track's score. The system's generic move dialog cannot roll
    //    them without a track context (and they have no rollable stat), which
    //    is exactly why they used to dead-end with "no dialog and no rollable
    //    stat". Route them to the progress-roll path against the matching open
    //    track instead. Reach Your Destination uses the same mechanics as
    //    Fulfill Your Vow — both roll the track's progress score.
    if (this._isProgressMove(dataswornId, move?.name)) {
      return this.rollProgressMove(moveRef, opts);
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

  /** Set momentum to an absolute value (clamped to the meter range). */
  async setMomentum(actor, value) {
    if (!actor) return { ok: false, error: "No actor." };
    const meter = this.getMeter(actor, "momentum") ?? { min: -6, max: 10 };
    const v = Math.max(meter.min ?? -6, Math.min(meter.max ?? 10, Math.round(value)));
    return this._tryUpdateMeter(actor, "momentum", v);
  },

  /** Adjust momentum by a delta (e.g. +1, -2). */
  async adjustMomentum(actor, delta) {
    if (!actor) return { ok: false, error: "No actor." };
    const meter = this.getMeter(actor, "momentum");
    const cur = meter?.value ?? 0;
    return this.setMomentum(actor, cur + Number(delta || 0));
  },

  /** Reset momentum to the actor's momentum-reset value (default +2). */
  async resetMomentum(actor) {
    if (!actor) return { ok: false, error: "No actor." };
    const reset = foundry.utils.getProperty(actor, "system.momentumReset") ?? 2;
    return this.setMomentum(actor, reset);
  },

  /**
   * Apply harm: reduce health by `amount`. This is the bookkeeping half
   * of Endure Harm — the narrative move itself can be triggered via
   * triggerMove("Endure Harm") when a roll is wanted.
   */
  async applyHarm(actor, amount) {
    if (!actor || !(amount > 0)) return { ok: false, error: "No actor or non-positive amount." };
    const meter = this.getMeter(actor, "health");
    if (!meter) return { ok: false, error: "No health meter found." };
    const next = Math.max(meter.min ?? 0, meter.value - amount);
    return this._tryUpdateMeter(actor, "health", next);
  },

  /** Apply stress: reduce spirit by `amount` (bookkeeping for Endure Stress). */
  async applyStress(actor, amount) {
    if (!actor || !(amount > 0)) return { ok: false, error: "No actor or non-positive amount." };
    const meter = this.getMeter(actor, "spirit");
    if (!meter) return { ok: false, error: "No spirit meter found." };
    const next = Math.max(meter.min ?? 0, meter.value - amount);
    return this._tryUpdateMeter(actor, "spirit", next);
  },

  /** Spend supply (reduce by amount) or set absolute when `absolute` true. */
  async adjustSupply(actor, amount, absolute = false) {
    if (!actor) return { ok: false, error: "No actor." };
    const meter = this.getMeter(actor, "supply");
    if (!meter) return { ok: false, error: "No supply meter found." };
    const next = absolute ? amount : meter.value + amount;
    return this._tryUpdateMeter(actor, "supply", Math.max(meter.min ?? 0, Math.min(meter.max ?? 5, next)));
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
      return { ok: true, track: track.name, current: next, boxes: Math.floor(next / 4) };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
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
    //      combat  → subtype "foe"   (exactly what the foe sheet creates)
    const subtypeMap = { combat: "foe", journey: "progress", vow: "vow", bond: "bond" };
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
   * True iff a move is a PROGRESS move that rolls a track's progress score
   * (rather than an action roll against a stat). Currently the two the Skald
   * drives: "Fulfill Your Vow" (vows) and "Reach Your Destination" (journeys).
   * Matched on Datasworn ID first (rules-package agnostic) then by name.
   */
  _isProgressMove(dsid, name) {
    const id = String(dsid ?? "").toLowerCase();
    if (/\/(fulfill_your_vow|reach_your_destination)$/.test(id)) return true;
    const n = String(name ?? "").toLowerCase().trim();
    return n === "fulfill your vow" || n === "reach your destination";
  },

  /**
   * The newest still-open (not completed) progress-track Item of a given
   * kind ("vow" | "journey" | "combat" | …), or null. Classification uses our
   * own `trackKind` flag first (set when the Skald created the track), then
   * falls back to the system `system.subtype` (so a hand-made "vow" item is
   * still found). Returns the live Item document.
   */
  _newestOpenTrackItem(actor, kind) {
    if (!actor?.items) return null;
    const want = String(kind ?? "").toLowerCase();
    const strong = [];   // exact, confident matches (our flag / system subtype)
    const fallback = []; // best-effort matches (legacy / hand-made tracks)
    for (const item of actor.items) {
      if (foundry.utils.getProperty(item, "system.completed")) continue;
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
  },

  /**
   * Roll a PROGRESS move ("Fulfill Your Vow" / "Reach Your Destination")
   * against a progress track's score, via the system's own progress-roll
   * dialog (IronswornPrerollDialog.showForProgress) — identical to clicking
   * the track's roll button. This is the correct mechanic for completing a
   * vow or journey: you roll the track's progress score (filled boxes, 0–10)
   * against the two challenge dice, NOT an action die + stat.
   *
   * The track is resolved from (in order): an explicit `opts.trackRef`, then
   * the newest open track of the kind the move implies (vow → vow track,
   * journey → journey track). The move's Datasworn ID is attached so the roll
   * card shows the right move text/title.
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
               : null;

    // Resolve the track: explicit ref wins, else newest open track of the kind.
    let track = opts.trackRef ? this.findTrack(actor, opts.trackRef) : null;
    if (!track && kind) track = this._newestOpenTrackItem(actor, kind);
    if (!track) {
      const noun = kind ?? "progress";
      return {
        ok: false,
        method: "none",
        error: `No open ${noun} track to roll "${move?.name ?? moveRef}" against. ` +
               `Begin the ${noun} first (or open its track card and roll from there).`
      };
    }

    // Progress SCORE = filled boxes (0–10) = floor(ticks / 4), capped at 10.
    const current = Number(foundry.utils.getProperty(track, "system.current") ?? 0);
    const score = Math.max(0, Math.min(10, Math.floor(current / 4)));

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

  /* =================================================================
   *  COMPENDIUM ENEMY-RANK LOOKUP
   *  -----------------------------------------------------------------
   *  The official foundry-ironsworn foe compendia store each foe as a
   *  progress-track Item whose `system.rank` is a NUMBER 1–5. We index
   *  those packs once (cached), then match an enemy name to look up its
   *  canonical rank — so "Bear", "Wyvern", "Bandit" etc. get the rank the
   *  rulebook assigns, instead of always defaulting to "dangerous".
   * ================================================================= */

  /** In-memory cache of the merged foe index. Cleared on world reload. */
  _foeIndexCache: null,

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

  /* =================================================================
   *  ASSETS  (v0.7.0 — compendium lookup for entity linking)
   * =================================================================
   *  Assets (Companions, Paths, Combat Talents, Rituals, …) are stored by
   *  the foundry-ironsworn system as `asset` Items inside compendium packs
   *  (ironswornassets, starforgedassets, …). We index them by name so the
   *  EntityLinker can turn an asset name the Skald narrates into a clickable
   *  link that opens the asset's card. Mirrors the foe-index approach:
   *  async build + in-memory cache, fuzzy matching, fully defensive.
   * ================================================================= */

  /** In-memory cache of the merged asset index. Cleared on world reload. */
  _assetIndexCache: null,

  /** Drop the cached asset index (e.g. after enabling an asset module). */
  clearAssetCache() {
    this._assetIndexCache = null;
    dbg("clearAssetCache: asset index cache cleared");
  },

  /**
   * Item compendium packs that look like asset catalogs. Covers Ironsworn,
   * Delve, Starforged and Sundered Isles asset packs, plus any third-party
   * pack whose id/label mentions assets.
   */
  _assetPacks() {
    const out = [];
    for (const pack of (game?.packs ?? [])) {
      try {
        if (pack.documentName !== "Item") continue;
        const id = String(pack.metadata?.id ?? pack.collection ?? "");
        const label = String(pack.metadata?.label ?? pack.title ?? "");
        if (/asset/i.test(id) || /asset/i.test(label)) out.push(pack);
      } catch (_) {}
    }
    return out;
  },

  /**
   * Build (and cache) a flat index of every asset across the asset packs:
   * [{ name, lc, uuid, packId, _id }]. Returns the cached array on repeat
   * calls. Never throws — returns [] on failure.
   *
   * @returns {Promise<Array<{name:string, lc:string, uuid:string, packId:string, _id:string}>>}
   */
  async _buildAssetIndex() {
    if (Array.isArray(this._assetIndexCache)) return this._assetIndexCache;
    const entries = [];
    for (const pack of this._assetPacks()) {
      try {
        const index = await pack.getIndex();
        const packId = String(pack.metadata?.id ?? pack.collection ?? "");
        for (const e of (index?.contents ?? index ?? [])) {
          const name = (e?.name ?? "").trim();
          if (!name) continue;
          entries.push({
            name,
            lc: name.toLowerCase(),
            uuid: e.uuid ?? `Compendium.${packId}.${e._id}`,
            packId,
            _id: e._id
          });
        }
      } catch (e) {
        warn(`_buildAssetIndex: failed to index "${pack?.metadata?.id}":`, e?.message ?? e);
      }
    }
    this._assetIndexCache = entries;
    dbg(`_buildAssetIndex: indexed ${entries.length} asset(s) from ${this._assetPacks().length} pack(s)`);
    return entries;
  },

  /**
   * Synchronous read of the cached asset names (for the EntityLinker, whose
   * index build is synchronous). Returns [] until {@link _buildAssetIndex}
   * has populated the cache (primed on `ready`). Never triggers a build.
   *
   * @returns {Array<{name:string, uuid:string}>}
   */
  getAssetNames() {
    return Array.isArray(this._assetIndexCache)
      ? this._assetIndexCache.map(a => ({ name: a.name, uuid: a.uuid }))
      : [];
  },

  /**
   * Look up an asset by name in the asset compendia. Matching, best → worst:
   * exact (case-insensitive) → normalised-equal → substring → token overlap
   * → close edit-distance. Reuses the foe-matcher's helpers.
   *
   * @param {string} assetName
   * @returns {Promise<{found:boolean, name:string|null, uuid?:string, packId?:string, match?:string, suggestion?:string}>}
   */
  async lookupAssetInCompendium(assetName) {
    const result = { found: false, name: assetName ?? null };
    if (!assetName || !this.isActive()) return result;
    let index;
    try { index = await this._buildAssetIndex(); }
    catch (e) { warn("lookupAssetInCompendium failed:", e?.message ?? e); return result; }
    if (!index.length) return result;

    const lc = String(assetName).toLowerCase().trim();
    const norm = this._normName(assetName);

    let hit = index.find(e => e.lc === lc);
    let match = hit ? "exact" : null;

    if (!hit) { hit = index.find(e => this._normName(e.name) === norm); if (hit) match = "normalized"; }

    if (!hit && norm) {
      const subs = index.filter(e => {
        const en = this._normName(e.name);
        return en && (en.includes(norm) || norm.includes(en));
      });
      if (subs.length) {
        subs.sort((a, b) => Math.abs(this._normName(a.name).length - norm.length)
                          - Math.abs(this._normName(b.name).length - norm.length));
        hit = subs[0]; match = "substring";
      }
    }

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

    if (!hit && norm.length >= 4) {
      let best = null, bestDist = Infinity;
      for (const e of index) {
        const d = this._editDistance(norm, this._normName(e.name));
        if (d < bestDist) { bestDist = d; best = e; }
      }
      const tol = Math.min(3, Math.max(2, Math.floor(norm.length * 0.25)));
      if (best && bestDist <= tol) { hit = best; match = "fuzzy"; }
      else if (best && bestDist <= tol + 2) result.suggestion = best.name;
    }

    if (hit) {
      dbg(`lookupAssetInCompendium: "${assetName}" → "${hit.name}" via ${match} (${hit.packId})`);
      return { found: true, name: hit.name, uuid: hit.uuid, packId: hit.packId, match };
    }
    return result;
  },

  /**
   * Open / display an asset card. Resolves a UUID (preferred) or a name to
   * the asset Document and renders its sheet. Falls back to a chat card with
   * the asset's description when no sheet is available. Fully defensive.
   *
   * @param {string} ref  asset UUID (Compendium.…) or asset name
   * @returns {Promise<{ok:boolean, method:string, error?:string}>}
   */
  async showAsset(ref) {
    try {
      if (!this.isActive()) return { ok: false, method: "none", error: "Ironsworn system not active." };
      if (!ref) return { ok: false, method: "none", error: "No asset reference." };

      let doc = null;
      // 1) Direct UUID resolution (works for Compendium.* and world Items).
      if (/^(Compendium|Item|Actor)\./.test(String(ref))) {
        try { doc = await fromUuid(ref); } catch (_) { /* fall through to name lookup */ }
      }
      // 2) Name lookup via the compendium index.
      if (!doc) {
        const found = await this.lookupAssetInCompendium(ref);
        if (found.found && found.uuid) {
          try { doc = await fromUuid(found.uuid); } catch (_) {}
        }
      }
      if (!doc) return { ok: false, method: "none", error: `Asset "${ref}" not found.` };

      if (doc.sheet?.render) {
        doc.sheet.render(true);
        return { ok: true, method: "sheet" };
      }
      return { ok: false, method: "none", error: "Asset has no renderable sheet." };
    } catch (e) {
      warn(`showAsset("${ref}") failed:`, e?.message ?? e);
      return { ok: false, method: "sheet", error: e?.message ?? String(e) };
    }
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

  /** Choose the first Item type the system actually registers. */
  _pickItemType(candidates) {
    const registered = Object.keys(CONFIG?.Item?.dataModels ?? {});
    for (const c of candidates) {
      if (registered.includes(c)) return c;
    }
    // Fall back to whatever the system lists first, else "progress".
    return registered[0] ?? "progress";
  },

  /**
   * Update a meter, trying several schema paths. Returns
   * `{ok, path?, value?, error?}`.
   */
  async _tryUpdateMeter(actor, key, value) {
    const paths = [
      `system.${key}.value`,
      `system.${key}`,
      `system.attributes.${key}.value`
    ];
    for (const path of paths) {
      const cur = foundry.utils.getProperty(actor, path);
      if (typeof cur === "number") {
        try {
          await actor.update({ [path]: value });
          dbg(`_tryUpdateMeter: ${key} (${path}) -> ${value}`);
          return { ok: true, path, value };
        } catch (e) {
          warn(`update ${path} failed:`, e?.message ?? e);
        }
      }
    }
    return { ok: false, error: `Could not write meter "${key}" (no known path).` };
  }
};

export default IronswornController;
