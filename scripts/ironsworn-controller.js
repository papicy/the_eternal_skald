/* =====================================================================
 *  THE ETERNAL SKALD — Ironsworn System Controller (v0.2.3)
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
    const rank = String(foundry.utils.getProperty(track, "system.rank") ?? "formidable").toLowerCase();
    const perMark = { troublesome: 12, dangerous: 8, formidable: 4, extreme: 2, epic: 1 }[rank] ?? 4;
    return this.markProgress(actor, track.id, perMark * Math.max(1, times));
  },

  /**
   * Create a new progress-track Item on the actor — used to enact
   * "Swear an Iron Vow", "Begin a Journey", "Forge a Bond", etc. The item
   * `type` is probed against the system's registered Item types so we
   * create something the system will render; falls back to "progress".
   *
   * @returns {Promise<{ok:boolean, id?:string, error?:string}>}
   */
  async createProgressTrack(actor, { name, rank = "formidable", type = "vow", subtype } = {}) {
    if (!actor) return { ok: false, error: "No actor." };
    if (!name)  return { ok: false, error: "A track name is required." };

    const wantType = subtype || type;
    const itemType = this._pickItemType([wantType, "vow", "progress"]);
    const data = {
      name,
      type: itemType,
      system: { rank: String(rank).toLowerCase(), current: 0, completed: false }
    };
    // Some data models distinguish vow/journey/bond via a subtype field.
    if (subtype) data.system.subtype = subtype;

    try {
      const [created] = await actor.createEmbeddedDocuments("Item", [data]);
      dbg(`createProgressTrack: created "${name}" as type "${itemType}" (id=${created?.id})`);
      return { ok: true, id: created?.id, type: itemType, name };
    } catch (e) {
      warn("createProgressTrack failed:", e?.message ?? e);
      return { ok: false, error: e?.message ?? String(e) };
    }
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
