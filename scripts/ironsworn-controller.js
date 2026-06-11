/* =====================================================================
 *  THE ETERNAL SKALD — Ironsworn System Controller (v0.10.21)
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

/* Experience awarded for FULFILLING a vow / progress track, by rank — the
 * canonical Ironsworn SRD scale ("mark experience equal to the rank of the
 * vow you fulfil"): Troublesome 1 … Epic 5. Used by grantXp / xpForRank. */
const RANK_XP = Object.freeze({
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
 *  MOVE TRIGGERS (v0.10.34)
 *  ---------------------------------------------------------------------
 *  Documented, plain-language trigger text for the moves a player is most
 *  likely to invoke through free-form ACTION prose (e.g. "I explore the
 *  cave"). This data GROUNDS the AI action classifier (see
 *  `buildActionClassifierPrompt`): the model is shown each move name with the
 *  fictional condition that triggers it, so it can map natural-language
 *  actions to the correct move rather than guessing. Keyed by move name
 *  (matching MOVE_CATALOG). Moves omitted here are still rollable by name —
 *  this list only steers the action→move interpretation. Additive & frozen;
 *  changing it never alters the deterministic `detectMoveDeclaration` path.
 * ------------------------------------------------------------------- */
const MOVE_TRIGGERS = Object.freeze({
  "Face Danger":          "You attempt something risky or react to an imminent threat — act under pressure, evade, resist, withstand, or push through danger when no more specific move applies.",
  "Secure an Advantage":  "You assess a situation, make preparations, scout, take aim, set a trap, or manoeuvre to gain leverage or position before acting.",
  "Gather Information":   "You search, explore, investigate, study, ask around, or examine something to uncover facts, clues, or insight.",
  "Heal":                 "You treat a physical injury or ailment, your own or another's.",
  "Resupply":             "You hunt, forage, or scavenge in the wild to restock your supplies.",
  "Make Camp":            "You rest, recover, and tend to needs while out in the wilds during a journey.",
  "Undertake a Journey":  "You travel across the wilds toward a destination over meaningful distance or time.",
  "Reach Your Destination": "You arrive at the end of a journey (rolls the journey progress track).",
  "Enter the Fray":       "You enter into combat or a dangerous encounter erupts — the first move when a fight begins.",
  "Strike":               "You attack an enemy in combat while you have the initiative or advantage.",
  "Clash":                "You fight back, trade blows, or counter-attack when an enemy has the initiative.",
  "Battle":               "You fight an entire combat abstractly, resolving the whole conflict with a single roll.",
  "Endure Harm":          "You suffer physical injury, or push onward despite your wounds.",
  "Endure Stress":        "You suffer mental or emotional shock, or push onward despite despair.",
  "Swear an Iron Vow":    "You commit to a quest, swear a solemn promise, or pledge yourself to a cause.",
  "Reach a Milestone":    "You take a significant step that brings you closer to fulfilling a vow.",
  "Fulfill Your Vow":     "You complete the final step of a quest you vowed to achieve (rolls the vow progress).",
  "Compel":               "You try to persuade, charm, bargain with, intimidate, threaten, or coerce another character.",
  "Sojourn":              "You rest and recover within a community or settlement.",
  "Draw the Circle":      "You challenge someone to a formal duel.",
  "Forge a Bond":         "You solidify a lasting bond or relationship with a person, community, or place.",
  "Test Your Bond":       "You put an existing bond to the test under strain or conflict.",
  "Delve the Depths":     "You explore deeper into a dangerous site, dungeon, or hostile region.",
  "Ask the Oracle":       "You pose a yes/no or open question about the world or fiction to chance (often better served by the !oracle command)."
});

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

/* (v0.10.36 — Phase 2) The COMPLETE set of impact / debility flags the
 * foundry-ironsworn character data model carries under `system.debility.*`.
 * These are booleans on the character. The list mirrors template.json
 * exactly (classic conditions + Starforged/Sundered impacts), so the AI
 * snapshot and the toggle write path cover every condition the sheet shows.
 * `custom1`/`custom2` are the two user-defined slots (with paired *name
 * string fields) and are read but not written by the AI toggle path. */
const DEBILITY_KEYS = [
  "wounded", "shaken", "unprepared", "encumbered", "maimed",
  "corrupted", "cursed", "tormented", "battered", "doomed",
  "permanentlyharmed", "traumatized", "indebted"
];

/* Canonical impact aliases → the real `system.debility.<key>`. Lets the AI
 * (and players) name an impact loosely ("harmed", "permanently harmed",
 * "in debt") and still hit the correct flag. Keys are normalized to lower
 * case with spaces/underscores/hyphens stripped before lookup. */
const IMPACT_ALIASES = Object.freeze({
  harmed:            "wounded",
  injured:           "wounded",
  hurt:              "wounded",
  rattled:           "shaken",
  unready:           "unprepared",
  burdened:          "encumbered",
  overloaded:        "encumbered",
  crippled:          "maimed",
  permanentlyharmed: "permanentlyharmed",
  permaharmed:       "permanentlyharmed",
  traumatised:       "traumatized",
  indebt:            "indebted",
  debt:              "indebted",
  bruised:           "battered"
});

/** Normalize an impact name/alias to its canonical debility key, or null. */
function canonicalImpactKey(name) {
  const k = String(name ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  if (DEBILITY_KEYS.includes(k)) return k;
  if (IMPACT_ALIASES[k]) return IMPACT_ALIASES[k];
  return null;
}

/* =====================================================================
 *  THE CONTROLLER
 * ===================================================================== */
export const IronswornController = {

  /* ---------------- Configuration ---------------- */

  setDebug(on) { DEBUG = !!on; },

  /**
   * The progress track that the most recent progress move ("Fulfill Your Vow"
   * / "Reach Your Destination") actually rolled against, recorded by
   * rollProgressMove(). Shape: { id, name, kind, actorId, ts } or null. Used by
   * resolveCompletionTrack() so a post-roll completion directive closes the
   * CORRECT track even when the AI names it after the move rather than the
   * player's real track name.
   */
  _lastProgressTrack: null,

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

  /** Active debilities (conditions/banes/burdens/impacts) as a list of keys.
   *  Custom impact slots (custom1/custom2) are surfaced under their
   *  player-defined label when set, falling back to the slot key. */
  getDebilities(actor) {
    if (!actor) return [];
    const active = [];
    for (const key of DEBILITY_KEYS) {
      const v = foundry.utils.getProperty(actor, `system.debility.${key}`);
      if (v === true) active.push(key);
    }
    // Custom impact slots — surface by their authored name when enabled.
    const debilityObj = foundry.utils.getProperty(actor, "system.debility");
    if (debilityObj && typeof debilityObj === "object") {
      for (const slot of ["custom1", "custom2"]) {
        if (debilityObj[slot] === true) {
          const label = String(debilityObj[`${slot}name`] ?? "").trim() || slot;
          if (!active.includes(label)) active.push(label);
        }
      }
      // Any other true flag not already covered (forward-compatible).
      for (const [k, v] of Object.entries(debilityObj)) {
        if (v === true && !/name$/i.test(k) && !active.includes(k) &&
            !["custom1", "custom2"].includes(k)) {
          active.push(k);
        }
      }
    }
    return active;
  },

  /**
   * (v0.10.36 — Phase 2) Read the character's BONDS. foundry-ironsworn stores
   * bonds inside a single embedded Item of `type === "bondset"`, whose
   * `system.bonds` is an array of `{ name, notes }`. The character's
   * `system.legacies.bonds` ProgressTicks counter (Starforged) is reported
   * separately by {@link getExperience}; this returns the narrative bond
   * entries the player has forged. READ-ONLY, synchronous, null-guarded.
   *
   * @param {Actor} actor
   * @param {{limit?:number}} [opts]
   * @returns {Array<{name:string, notes:string}>} possibly empty, never null.
   */
  getBonds(actor, { limit = 20 } = {}) {
    if (!actor?.items) return [];
    const out = [];
    for (const item of actor.items) {
      if (item?.type !== "bondset") continue;
      const bonds = foundry.utils.getProperty(item, "system.bonds");
      if (!Array.isArray(bonds)) continue;
      for (const b of bonds) {
        const name = String(b?.name ?? "").trim();
        if (!name) continue;
        // Strip HTML from notes so the AI snapshot stays plain text.
        const notes = String(b?.notes ?? "").replace(/<[^>]*>/g, "").trim();
        out.push({ name, notes });
        if (out.length >= limit) return out;
      }
    }
    return out;
  },

  /**
   * (v0.10.25 — asset tracking) Read the character's owned ASSET Items
   * (companions, paths, combat talents, rituals, …) and summarise them in
   * an AI-friendly, token-efficient shape. READ-ONLY and synchronous, so it
   * mirrors {@link getProgressTracks} and is safe to call from the prompt
   * builder on every turn.
   *
   * The foundry-ironsworn AssetModel stores each asset as an embedded Item of
   * `type === "asset"`, whose `system` carries:
   *   • `category`   — e.g. "Companion" | "Path" | "Combat Talent" | "Ritual".
   *   • `abilities[]` — ordered list; each `{ name, enabled, description, … }`.
   *                     The count of `enabled === true` entries says how far the
   *                     asset is unlocked/upgraded.
   *   • `track`       — optional asset condition meter `{ enabled, name,
   *                     value, min, max }` (e.g. a companion's health).
   *
   * Every read is null-guarded via `foundry.utils.getProperty`, so an asset
   * authored under an older/newer schema degrades to sensible defaults rather
   * than throwing.
   *
   * @param {Actor}  actor                the actor to read (may be null).
   * @param {object} [opts]
   * @param {number} [opts.limit=12]      max assets to return (token budget).
   * @returns {Array<{id:string,name:string,category:(string|null),
   *   unlocked:number,total:number,
   *   track:({name:string,value:(number|null),max:(number|null)}|null)}>}
   *   A (possibly empty) array — never null.
   */
  getAssets(actor, { limit = 12 } = {}) {
    if (!actor?.items) return [];
    const out = [];
    for (const item of actor.items) {
      if (item?.type !== "asset") continue;
      const abilities = foundry.utils.getProperty(item, "system.abilities");
      const list = Array.isArray(abilities) ? abilities : [];
      const unlocked = list.filter(a => a?.enabled === true).length;
      // (v0.10.36 — Phase 2) Surface the TEXT of each enabled ability so the
      // AI knows what the asset actually lets the character DO, not just how
      // many boxes are ticked. HTML is stripped and each line trimmed to keep
      // the snapshot token-efficient.
      const enabledAbilities = list
        .filter(a => a?.enabled === true)
        .map(a => String(a?.description ?? "").replace(/<[^>]*>/g, "").trim())
        .filter(Boolean)
        .map(d => (d.length > 220 ? d.slice(0, 217) + "…" : d));
      const track = foundry.utils.getProperty(item, "system.track") ?? null;
      const hasTrack = track && typeof track === "object" && track.enabled === true;
      // The asset condition meter is stored as `current` in template.json;
      // older data used `value`. Accept either so both schemas read cleanly.
      const trackVal = (hasTrack && typeof track.current === "number") ? track.current
                     : (hasTrack && typeof track.value === "number")   ? track.value
                     : null;
      out.push({
        id: item.id,
        name: item.name,
        category: foundry.utils.getProperty(item, "system.category") ?? null,
        unlocked,
        total: list.length,
        abilities: enabledAbilities,
        track: hasTrack
          ? {
              name: track.name || "track",
              value: trackVal,
              max: typeof track.max === "number" ? track.max : null
            }
          : null
      });
      if (out.length >= limit) break;
    }
    return out;
  },

  /**
   * (v0.10.25 — XP tracking) Read the character's experience in a unified,
   * model-agnostic shape, covering BOTH Ironsworn rulesets:
   *   • Classic Ironsworn — a single integer counter at `system.xp`
   *     (experience earned to date).
   *   • Starforged — three legacy tracks under `system.legacies`
   *     (`quests`, `bonds`, `discoveries`), each a ProgressTicks value, with a
   *     paired `*XpSpent` counter recording XP already spent from that legacy.
   *
   * The two models are not mutually exclusive in data, so both are read and
   * returned independently; callers decide what to surface. Fully null-guarded
   * and never throws — absent fields come back as `null`.
   *
   * @param {Actor} actor   the actor to read (may be null).
   * @returns {{xp:(number|null),
   *   legacies:({quests:number,questsXpSpent:number,
   *     bonds:number,bondsXpSpent:number,
   *     discoveries:number,discoveriesXpSpent:number}|null)}}
   */
  getExperience(actor) {
    if (!actor) return { xp: null, legacies: null };
    const xpRaw = foundry.utils.getProperty(actor, "system.xp");
    const xp = typeof xpRaw === "number" ? xpRaw : null;

    const L = foundry.utils.getProperty(actor, "system.legacies");
    const num = (v) => (typeof v === "number" ? v : 0);
    const legacies = (L && typeof L === "object")
      ? {
          quests:             num(L.quests),
          questsXpSpent:      num(L.questsXpSpent),
          bonds:              num(L.bonds),
          bondsXpSpent:       num(L.bondsXpSpent),
          discoveries:        num(L.discoveries),
          discoveriesXpSpent: num(L.discoveriesXpSpent)
        }
      : null;

    return { xp, legacies };
  },

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
   * still have it. Troublesome 1 … Epic 5; weak hit halves (rounded up).
   *
   * @param {string|number} rank canonical rank word or numeric ChallengeRank.
   * @param {{weakHit?: boolean}} [opts]
   * @returns {number} whole XP (0 for an unknown rank).
   */
  xpForRank(rank, { weakHit = false } = {}) {
    let key = (typeof rank === "number") ? RANK_NUM[rank] : String(rank ?? "").toLowerCase().trim();
    const base = RANK_XP[key] ?? 0;
    if (!base) return 0;
    return weakHit ? Math.ceil(base / 2) : base;
  },

  /**
   * Detect which Ironsworn ruleset family decides HOW experience is recorded.
   * foundry-ironsworn exposes four boolean world settings (one per rules
   * package). We collapse them to two XP write models:
   *   • "classic"    — single integer counter at `system.xp` (classic, delve)
   *   • "starforged" — legacy tracks under `system.legacies` (starforged,
   *                    sundered isles)
   * Defaults to "classic" when nothing is readable — it is the safest model
   * and the field every character carries.
   *
   * @returns {"classic"|"starforged"}
   */
  getRuleset() {
    try {
      const flag = (k) => {
        try { return game?.settings?.get?.(SYSTEM_ID, k) === true; } catch (_) { return false; }
      };
      const classic = flag("ruleset-classic");
      const delve   = flag("ruleset-delve");
      const sf      = flag("ruleset-starforged");
      const si      = flag("ruleset-sundered_isles");
      // Classic/Delve take priority — `system.xp` is the simplest, universal
      // model. Only when ONLY a Starforged-family ruleset is on do we switch.
      if (classic || delve) return "classic";
      if (sf || si) return "starforged";
    } catch (_) { /* fall through */ }
    return "classic";
  },

  /** Convenience predicate — true when the active ruleset uses legacy tracks. */
  isStarforgedRuleset() {
    return this.getRuleset() === "starforged";
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

  /**
   * Common Ironsworn track NOUNS that are never a player-chosen proper name.
   * A reference like "vow" / "journey" / "the vow" is a GENERIC pointer at a
   * KIND of track, not the name of a specific one — so it must be resolved to
   * the character's actual current track of that kind (read from the sheet),
   * never matched literally. Used by the display resolver and by EntityLinker
   * (which must not turn the bare word "vow" into a clickable phantom link).
   */
  _GENERIC_TRACK_WORDS: new Set([
    "vow", "vows", "the vow", "my vow", "iron vow",
    "journey", "journeys", "the journey",
    "bond", "bonds", "the bond",
    "track", "tracks", "progress track", "progress",
    "quest", "quests", "the quest",
    "combat", "fight", "foe", "foes"
  ]),

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
      .map(k => {
        const m = meters[k];
        if (!m) return null;
        // Show value/max so the AI respects the meter's ceiling (health/
        // spirit/supply cap at 5; momentum at its momentumMax, default 10).
        return (typeof m.max === "number") ? `${k} ${m.value}/${m.max}` : `${k} ${m.value}`;
      })
      .filter(Boolean)
      .join(", ");
    if (meterStr) lines.push(`Meters: ${meterStr}`);

    const debilities = this.getDebilities(actor);
    if (debilities.length) lines.push(`Debilities: ${debilities.join(", ")}`);

    // (v0.10.26 — Phase 1 context) Progress tracks, grouped and explicitly
    // labelled FULL / NOT YET FULL, with the ACTIVE combat and the STORY FOCUS
    // vow marked. The fullness label tells the AI plainly whether a completion
    // move (Fulfill Your Vow / End the Fight / Reach Your Destination) is even
    // available yet — preventing it from concluding a track before 10/10.
    const tracks = this.getProgressTracks(actor);
    if (tracks.length) {
      const isVow = t => t.kind === "vow" || t.subtype === "vow";
      const isCombat = t => t.kind === "combat" || t.subtype === "foe";
      const isJourney = t =>
        (t.kind === "journey") ||
        (!t.kind && !isVow(t) && !isCombat(t)
         && t.subtype !== "bond" && t.subtype !== "connection" && t.subtype !== "bondset");

      const activeCombat = this.getActiveCombat(actor);
      const focusVow     = this.identifyStoryFocusVow(actor);

      const fmt = (t, kind) => {
        const rank = t.rank ? ` [${this.normalizeRank(t.rank)}]` : "";
        return `${t.name}${rank}: ${this.fullnessLabel(t.boxes, t.completed, kind)}`;
      };

      lines.push("PROGRESS TRACKS:");

      // ACTIVE COMBAT — at most one in Ironsworn; surface it first and flagged.
      if (activeCombat) {
        lines.push(`  ⚔️ ACTIVE COMBAT — ${fmt(activeCombat, "combat")}`);
      }

      const openVows     = tracks.filter(t => !t.completed && isVow(t));
      const openJourneys = tracks.filter(t => !t.completed && !isVow(t) && isJourney(t));

      if (openVows.length) {
        lines.push("  VOWS:");
        for (const t of openVows.slice(0, 8)) {
          const focus = focusVow && focusVow.id === t.id ? "[STORY FOCUS] " : "";
          lines.push(`    📜 ${focus}${fmt(t, "vow")}`);
        }
      }
      if (openJourneys.length) {
        lines.push("  JOURNEYS:");
        for (const t of openJourneys.slice(0, 8)) {
          lines.push(`    🗺️ ${fmt(t, "journey")}`);
        }
      }

      // Any other / completed tracks (bonds, finished arcs) for completeness.
      const others = tracks.filter(t =>
        t.completed || (!isVow(t) && !isJourney(t) && !(activeCombat && t.id === activeCombat.id)));
      for (const t of others.slice(0, 6)) {
        lines.push(`    • ${fmt(t, t.kind || "vow")}`);
      }

      // Reference-by-exact-title lines (kept from prior versions) so the AI can
      // target the right named track in mark-progress / completion directives.
      const openVowTitles     = openVows.map(t => `"${t.name}"`);
      const openJourneyTitles = openJourneys.map(t => `"${t.name}"`);
      if (openVowTitles.length)     lines.push(`Open vows (reference by EXACT title): ${openVowTitles.join(", ")}`);
      if (openJourneyTitles.length) lines.push(`Open journeys (reference by EXACT title): ${openJourneyTitles.join(", ")}`);
    }

    // (v0.10.25) ASSETS — companions, paths, talents, rituals. Surfaced by
    // EXACT name plus unlock progress and any condition meter, so the AI can
    // reference what the character actually owns instead of inventing kit.
    const assets = this.getAssets(actor);
    if (assets.length) {
      lines.push("Assets:");
      for (const a of assets) {
        const cat   = a.category ? ` (${a.category})` : "";
        const prog  = a.total ? ` — ${a.unlocked}/${a.total} abilities` : "";
        const track = a.track
          ? `; ${a.track.name} ${a.track.value ?? "?"}${a.track.max != null ? `/${a.track.max}` : ""}`
          : "";
        lines.push(`  - ${a.name}${cat}${prog}${track}`);
        // (v0.10.36 — Phase 2) List the enabled ability text so the AI knows
        // the concrete capabilities this asset grants the character.
        if (Array.isArray(a.abilities)) {
          for (const ab of a.abilities) lines.push(`      • ${ab}`);
        }
      }
    }

    // (v0.10.36 — Phase 2) BONDS — the narrative connections the character has
    // forged (foundry-ironsworn "bondset" item). Surfaced so the AI can honour
    // existing relationships instead of inventing or contradicting them.
    const bonds = this.getBonds(actor);
    if (bonds.length) {
      lines.push("Bonds:");
      for (const b of bonds) {
        const note = b.notes ? ` — ${b.notes.length > 160 ? b.notes.slice(0, 157) + "…" : b.notes}` : "";
        lines.push(`  - ${b.name}${note}`);
      }
    }

    // (v0.10.25) EXPERIENCE — classic Ironsworn `xp` counter and/or the
    // Starforged legacy tracks. Either may be absent depending on ruleset, so
    // each is surfaced only when present.
    const xpInfo = this.getExperience(actor);
    if (xpInfo.xp != null) lines.push(`Experience: ${xpInfo.xp} XP earned`);
    if (xpInfo.legacies) {
      const L = xpInfo.legacies;
      lines.push(`Legacies (ticks): Quests ${L.quests}, Bonds ${L.bonds}, Discoveries ${L.discoveries}`);
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

    // 0b. REACH A MILESTONE — not a roll; it simply marks progress on the
    //     active vow by its rank. Handle it here so inline links and
    //     doTriggerMove() both work without falling through to the "no
    //     rollable stat" error.
    if (this._isMilestoneMove(dataswornId, move?.name)) {
      return this._executeMilestone(opts.actor ?? this.getActiveCharacter());
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

  /* =================================================================
   *  STAT & IMPACT WRITES — Phase 2 (Full Sheet Modification)
   *  -----------------------------------------------------------------
   *  Safe, bounded, Document-API writes for the remaining mutable parts
   *  of the character sheet: the five base stats and the impact /
   *  debility flags. Everything funnels through actor.update() (never
   *  direct mutation) so the system stays the source of truth and fires
   *  its own hooks. Both methods are idempotent and fully guarded.
   * ================================================================= */

  /** Minimum/maximum a base stat (edge/heart/iron/shadow/wits) may hold.
   *  Ironsworn character creation distributes 3/2/2/1/1, but the sheet's
   *  number input allows 0–5, so we clamp to that conservative range. */
  STAT_MIN: 0,
  STAT_MAX: 5,

  /** The complete list of canonical impact / debility keys (read-only). */
  impactKeys() { return DEBILITY_KEYS.slice(); },

  /** Resolve a loose impact name/alias to its canonical key, or null. */
  resolveImpactKey(name) { return canonicalImpactKey(name); },

  /**
   * Set a base stat to an ABSOLUTE value (clamped 0–5). Stats are rarely
   * changed in play, so this is deliberately an explicit set rather than a
   * delta; callers wanting a relative change read getStat() first. Only
   * writes when the path already exists and is numeric, so an unexpected
   * data model degrades to a clear error rather than creating junk fields.
   *
   * @param {Actor}  actor
   * @param {string} stat   one of edge|heart|iron|shadow|wits
   * @param {number} value  desired value (clamped to 0–5)
   * @returns {Promise<{ok:boolean, stat?:string, from?:number, to?:number, error?:string}>}
   */
  async setStat(actor, stat, value) {
    if (!actor) return { ok: false, error: "No actor." };
    const key = String(stat ?? "").toLowerCase().trim();
    if (!STAT_KEYS.includes(key)) return { ok: false, error: `Unknown stat "${stat}".` };
    const cur = this.getStat(actor, key);
    if (typeof cur !== "number") return { ok: false, error: `Stat "${key}" not present on this character.` };
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, error: `Non-numeric value for "${key}".` };
    const to = Math.max(this.STAT_MIN, Math.min(this.STAT_MAX, Math.round(n)));
    if (to === cur) return { ok: true, stat: key, from: cur, to, noop: true };
    try {
      await actor.update({ [`system.${key}`]: to });
      dbg(`setStat: ${key} ${cur} -> ${to}`);
      return { ok: true, stat: key, from: cur, to };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },

  /**
   * Set an impact / debility flag ON or OFF. Accepts loose names/aliases
   * ("harmed", "permanently harmed", "in debt") via canonicalImpactKey.
   * Idempotent — a no-op when the flag is already in the requested state.
   * Custom impact slots are read-only here (they carry a paired name field
   * the player owns), so attempts to toggle them are rejected cleanly.
   *
   * @param {Actor}   actor
   * @param {string}  impact  impact name or alias
   * @param {boolean} on      true to set, false to clear
   * @returns {Promise<{ok:boolean, impact?:string, state?:boolean, error?:string, noop?:boolean}>}
   */
  async setImpact(actor, impact, on) {
    if (!actor) return { ok: false, error: "No actor." };
    const key = canonicalImpactKey(impact);
    if (!key) return { ok: false, error: `Unknown impact "${impact}".` };
    const path = `system.debility.${key}`;
    const cur = foundry.utils.getProperty(actor, path);
    // Only write when the flag actually exists on the data model.
    if (typeof cur !== "boolean") return { ok: false, error: `Impact "${key}" not present on this character.` };
    const want = !!on;
    if (cur === want) return { ok: true, impact: key, state: want, noop: true };
    try {
      await actor.update({ [path]: want });
      dbg(`setImpact: ${key} -> ${want}`);
      return { ok: true, impact: key, state: want };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },

  /**
   * Toggle an impact / debility flag (reads current state, flips it).
   * Thin wrapper over setImpact for the AI's [[EFFECT: toggle_impact <type>]].
   */
  async toggleImpact(actor, impact) {
    if (!actor) return { ok: false, error: "No actor." };
    const key = canonicalImpactKey(impact);
    if (!key) return { ok: false, error: `Unknown impact "${impact}".` };
    const cur = foundry.utils.getProperty(actor, `system.debility.${key}`);
    return this.setImpact(actor, key, !(cur === true));
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

  /**
   * The two OFFICIAL foundry-ironsworn foe compendium packs that REGULAR
   * encounters must draw from. Important narrative foes (bosses / unique
   * antagonists) may be custom-created outside this list — see the prompt's
   * foe-catalogue guidance and the `important` flag on create_combat.
   */
  FOE_COMPENDIUM_PACK_IDS: Object.freeze([
    "foundry-ironsworn.ironswornfoes",
    "foundry-ironsworn.ironsworndelvefoes"
  ]),

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
   *  COMPENDIUM CREATION  (v0.10.37 — Phase 3)
   *  -----------------------------------------------------------------
   *  Bring real content out of the official foundry-ironsworn compendia
   *  and into play: add an ASSET to the active character, spawn a FOE
   *  ACTOR from the foe-actor packs, add an arbitrary compendium ITEM to
   *  a character, and create a blank PLAYER CHARACTER. Every creation:
   *    • verifies the source exists (fuzzy compendium lookup) first,
   *    • goes through the Foundry Document API (Actor.create /
   *      actor.createEmbeddedDocuments) — never a raw data mutation,
   *    • is idempotent where it sensibly can be (assets/items dedupe by
   *      name on the actor), and
   *    • returns a structured {ok,…} result with a `suggestion` when a
   *      name is close but not matched, so callers can advise the GM.
   *  All async + fully defensive; they degrade to {ok:false} on any error.
   * ================================================================= */

  /**
   * Default base stats for a freshly-created Ironsworn character. The
   * canonical starting array is 3/2/2/1/1 distributed across the five
   * stats; we assign a balanced, rules-legal default the GM can re-arrange.
   */
  DEFAULT_CHARACTER_STATS: Object.freeze({ edge: 2, heart: 1, iron: 2, shadow: 1, wits: 3 }),

  /**
   * Clone a compendium Document's data into a plain object suitable for
   * creation, stripping identity/ownership fields so the new copy gets a
   * fresh id and sane defaults. Never throws.
   */
  _cleanForCreate(doc) {
    let data;
    try { data = typeof doc?.toObject === "function" ? doc.toObject() : foundry.utils.deepClone(doc); }
    catch (_) { data = {}; }
    for (const k of ["_id", "_stats", "_key", "ownership", "folder", "sort"]) {
      try { delete data[k]; } catch (_) {}
    }
    // Embedded items (e.g. a foe actor's progress track) also carry _ids
    // that must be dropped so they are re-created cleanly.
    if (Array.isArray(data.items)) {
      data.items = data.items.map(it => {
        const c = { ...it };
        for (const k of ["_id", "_stats", "_key", "ownership", "folder"]) { try { delete c[k]; } catch (_) {} }
        return c;
      });
    }
    return data;
  },

  /** Case-insensitive: does `actor` already own an Item of this name (+ optional type)? */
  _actorHasItemNamed(actor, name, type = null) {
    const lc = String(name ?? "").toLowerCase().trim();
    if (!lc || !actor?.items) return false;
    for (const it of actor.items) {
      if (type && it?.type !== type) continue;
      if (String(it?.name ?? "").toLowerCase().trim() === lc) return true;
    }
    return false;
  },

  /**
   * Add an ASSET from the asset compendia to the active character. Looks the
   * asset up by name (fuzzy), then creates a copy of it as an embedded Item
   * on the actor via the Document API. Idempotent: if the actor already owns
   * an asset of that name it is a no-op (unless `allowDuplicate`).
   *
   * @param {Actor}  actor
   * @param {string} assetName
   * @param {{allowDuplicate?:boolean}} [opts]
   * @returns {Promise<{ok:boolean, name?:string, matchedName?:string, uuid?:string, match?:string, id?:string, noop?:boolean, suggestion?:string, error?:string}>}
   */
  async addAssetToActor(actor, assetName, { allowDuplicate = false } = {}) {
    if (!actor) return { ok: false, error: "No active character." };
    if (!this.isActive()) return { ok: false, error: "Ironsworn system not active." };
    if (!assetName) return { ok: false, error: "No asset name given." };

    let lookup;
    try { lookup = await this.lookupAssetInCompendium(assetName); }
    catch (e) { return { ok: false, error: e?.message ?? String(e) }; }
    if (!lookup?.found || !lookup.uuid) {
      return { ok: false, error: `Asset "${assetName}" not found in the compendia.`, suggestion: lookup?.suggestion };
    }

    if (!allowDuplicate && this._actorHasItemNamed(actor, lookup.name, "asset")) {
      dbg(`addAssetToActor: "${lookup.name}" already owned — no-op`);
      return { ok: true, noop: true, name: lookup.name, matchedName: lookup.name, uuid: lookup.uuid, match: lookup.match };
    }

    let doc;
    try { doc = await fromUuid(lookup.uuid); }
    catch (e) { return { ok: false, error: `Could not load asset "${lookup.name}": ${e?.message ?? e}` }; }
    if (!doc) return { ok: false, error: `Could not load asset "${lookup.name}".` };

    const data = this._cleanForCreate(doc);
    try {
      const [created] = await actor.createEmbeddedDocuments("Item", [data]);
      dbg(`addAssetToActor: added "${lookup.name}" to "${actor.name}" (id=${created?.id})`);
      return { ok: true, name: created?.name ?? lookup.name, matchedName: lookup.name, uuid: lookup.uuid, match: lookup.match, id: created?.id };
    } catch (e) {
      warn("addAssetToActor failed:", e?.message ?? e);
      return { ok: false, error: e?.message ?? String(e) };
    }
  },

  /**
   * Add an arbitrary compendium ITEM (asset, move, delve theme/domain, …) to
   * a character by name. Searches every Item compendium pack (newest-style
   * `documentName === "Item"`), excluding the foe/encounter packs (those are
   * NPC catalogue entries, not character items). Idempotent by name.
   *
   * @param {Actor}  actor
   * @param {string} itemName
   * @param {{allowDuplicate?:boolean, types?:string[]}} [opts]  optional Item-type filter
   * @returns {Promise<{ok:boolean, name?:string, matchedName?:string, type?:string, packId?:string, match?:string, id?:string, noop?:boolean, suggestion?:string, error?:string}>}
   */
  async addItemToActor(actor, itemName, { allowDuplicate = false, types = null } = {}) {
    if (!actor) return { ok: false, error: "No active character." };
    if (!this.isActive()) return { ok: false, error: "Ironsworn system not active." };
    if (!itemName) return { ok: false, error: "No item name given." };

    // Build a candidate list across Item packs (excluding foe/encounter packs).
    const lc = String(itemName).toLowerCase().trim();
    const norm = this._normName(itemName);
    const typeSet = Array.isArray(types) && types.length ? new Set(types) : null;
    let exact = null, normHit = null, sub = null, suggestion = null, bestDist = Infinity;

    for (const pack of (game?.packs ?? [])) {
      try {
        if (pack.documentName !== "Item") continue;
        const id = String(pack.metadata?.id ?? pack.collection ?? "");
        const label = String(pack.metadata?.label ?? pack.title ?? "");
        if (/foe|encounter|bestiar|monster/i.test(id) || /foe|encounter|bestiar|monster/i.test(label)) continue;
        const index = await pack.getIndex({ fields: ["type"] });
        for (const e of (index?.contents ?? index ?? [])) {
          const name = (e?.name ?? "").trim();
          if (!name) continue;
          if (typeSet && e.type && !typeSet.has(e.type)) continue;
          const eLc = name.toLowerCase();
          const eNorm = this._normName(name);
          const cand = { name, type: e.type, uuid: e.uuid ?? `Compendium.${id}.${e._id}`, packId: id, _id: e._id };
          if (eLc === lc && !exact) exact = cand;
          if (eNorm === norm && !normHit) normHit = cand;
          if (!sub && norm && eNorm && (eNorm.includes(norm) || norm.includes(eNorm))) sub = cand;
          if (norm.length >= 4) {
            const d = this._editDistance(norm, eNorm);
            if (d < bestDist) { bestDist = d; suggestion = name; }
          }
        }
      } catch (e) { warn(`addItemToActor: index "${pack?.metadata?.id}" failed:`, e?.message ?? e); }
      if (exact) break;   // exact wins immediately
    }

    const hit = exact || normHit || sub;
    if (!hit) {
      const tol = Math.min(3, Math.max(2, Math.floor(norm.length * 0.25)));
      return { ok: false, error: `Item "${itemName}" not found in the compendia.`, suggestion: (bestDist <= tol + 2 ? suggestion : undefined) };
    }

    if (!allowDuplicate && this._actorHasItemNamed(actor, hit.name)) {
      dbg(`addItemToActor: "${hit.name}" already owned — no-op`);
      return { ok: true, noop: true, name: hit.name, matchedName: hit.name, type: hit.type, packId: hit.packId };
    }

    let doc;
    try { doc = await fromUuid(hit.uuid); }
    catch (e) { return { ok: false, error: `Could not load item "${hit.name}": ${e?.message ?? e}` }; }
    if (!doc) return { ok: false, error: `Could not load item "${hit.name}".` };

    const data = this._cleanForCreate(doc);
    try {
      const [created] = await actor.createEmbeddedDocuments("Item", [data]);
      dbg(`addItemToActor: added "${hit.name}" (${hit.type}) to "${actor.name}" (id=${created?.id})`);
      return { ok: true, name: created?.name ?? hit.name, matchedName: hit.name, type: created?.type ?? hit.type, packId: hit.packId, id: created?.id };
    } catch (e) {
      warn("addItemToActor failed:", e?.message ?? e);
      return { ok: false, error: e?.message ?? String(e) };
    }
  },

  /* ---- Foe ACTOR compendia (distinct from the foe-ITEM rank index) ----
   * The official packs foe-actors-is / foe-actors-delve / foe-actors-sf hold
   * ready-made foe ACTORS (type "foe") with an embedded progress track. We
   * index them by name so the Skald can spawn a real, stat-bearing foe actor
   * into the world rather than only a bare progress track on the PC sheet. */

  /** In-memory cache of the merged foe-actor index. Cleared on world reload. */
  _foeActorIndexCache: null,

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
  },

  /**
   * Create a blank PLAYER CHARACTER actor (type "character") with sensible,
   * rules-legal default stats and full meters. Optionally seed starting assets
   * by name. Returns the new actor's id.
   *
   * @param {string} name
   * @param {{stats?:object, assets?:string[], folder?:string}} [opts]
   * @returns {Promise<{ok:boolean, name?:string, actorId?:string, uuid?:string, assetsAdded?:string[], error?:string}>}
   */
  async createCharacter(name, { stats = null, assets = null, folder = null } = {}) {
    if (!this.isActive()) return { ok: false, error: "Ironsworn system not active." };
    if (!name) return { ok: false, error: "No character name given." };
    if (typeof Actor === "undefined" || typeof Actor.create !== "function") {
      return { ok: false, error: "Actor.create is unavailable." };
    }

    // Merge caller stats over the defaults, clamping each to STAT_MIN–STAT_MAX.
    const s = { ...this.DEFAULT_CHARACTER_STATS };
    if (stats && typeof stats === "object") {
      for (const k of Object.keys(this.DEFAULT_CHARACTER_STATS)) {
        const v = Number(stats[k]);
        if (Number.isFinite(v)) s[k] = Math.max(this.STAT_MIN, Math.min(this.STAT_MAX, Math.round(v)));
      }
    }
    const data = {
      name,
      type: "character",
      system: {
        edge: s.edge, heart: s.heart, iron: s.iron, shadow: s.shadow, wits: s.wits,
        health: 5, spirit: 5, supply: 5,
        momentum: 2, momentumReset: 2, momentumMax: 10
      },
      flags: { [ES_SCOPE]: { createdBy: "eternal-skald" } }
    };
    if (folder) data.folder = folder;

    let actor;
    try { actor = await Actor.create(data); }
    catch (e) { warn("createCharacter failed:", e?.message ?? e); return { ok: false, error: e?.message ?? String(e) }; }
    if (!actor) return { ok: false, error: "Actor.create returned nothing." };

    const assetsAdded = [];
    if (Array.isArray(assets) && assets.length) {
      for (const a of assets) {
        try { const r = await this.addAssetToActor(actor, a); if (r?.ok && !r.noop) assetsAdded.push(r.name); }
        catch (_) {}
      }
    }
    dbg(`createCharacter: created "${name}" (id=${actor.id})${assetsAdded.length ? `, assets: ${assetsAdded.join(", ")}` : ""}`);
    return { ok: true, name: actor.name, actorId: actor.id, uuid: actor.uuid, assetsAdded };
  },

  /* =================================================================
   *  ASSET BONUS ADVISORY (v0.10.38 — Phase 4)
   *
   *  Ironsworn assets are free-form *descriptive text*: there is no
   *  structured "bonus" field, and Foundry's roll dialogs expose no
   *  public API for injecting external modifiers. Rather than fragile
   *  automatic injection (which would break the roll system the moment
   *  the dialog markup changes), the Skald *advises*. It scans the
   *  active character's ENABLED asset abilities for roll-bonus wording
   *  (e.g. "add +1", "+2 when …", "take +1") and — when a bonus plausibly
   *  applies to the move being made — surfaces a non-blocking chat
   *  suggestion. The player decides whether to apply it. Full player
   *  agency, zero roll-system risk.
   *
   *  This method is PURE: it takes the asset snapshot (as produced by
   *  {@link getAssets}) plus the move name/stat and returns the matched
   *  bonuses. No Foundry calls, no chat, no side-effects — so it is fully
   *  unit-testable in plain Node.
   * ================================================================= */

  /** Stopwords stripped before move↔asset keyword matching. */
  _BONUS_STOPWORDS: new Set([
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "with",
    "when", "if", "you", "your", "yours", "may", "add", "take", "gain", "this",
    "that", "roll", "move", "moves", "make", "making", "made", "action",
    "instead", "also", "can", "could", "using", "use", "used", "while",
    "against", "into", "from", "but", "not", "do", "does", "it", "its", "as",
    "by", "be", "are", "is", "any", "all", "one", "two", "each", "per", "then"
  ]),

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

  /* ===================================================================
   *  INTELLIGENT ACTION → MOVE MAPPING (v0.10.34)
   *  -------------------------------------------------------------------
   *  These three PURE helpers power the hybrid action classifier. They
   *  contain NO Foundry/AI calls (so they unit-test in plain node); the
   *  actual `Client.chat` call lives in eternal-skald.js, which feeds the
   *  prompt from `buildActionClassifierPrompt`, then runs the model's reply
   *  through `parseActionClassification` and `decideActionRouting`.
   * =================================================================== */

  /** The five rollable action stats, exposed for prompt/validation reuse. */
  ACTION_STATS: Object.freeze(["edge", "heart", "iron", "shadow", "wits"]),

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
