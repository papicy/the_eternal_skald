/* =====================================================================
 *  THE ETERNAL SKALD — Ironsworn System Controller
 *  (Module version lives in module.json — the single source of truth.)
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

export const SYSTEM_ID = "foundry-ironsworn";
export const LOG_PREFIX = "The Eternal Skald | Ironsworn |";

/* The Skald's flag scope on actors/items (initiative state, track kind). */
export const ES_SCOPE = "the-eternal-skald";

/* Canonical Ironsworn progress-track ranks, lowest → highest danger. */
export const RANKS = Object.freeze(["troublesome", "dangerous", "formidable", "extreme", "epic"]);

/* Ticks marked per "mark progress" action, by rank (4 ticks = 1 box). */
export const RANK_TICKS = Object.freeze({
  troublesome: 12, dangerous: 8, formidable: 4, extreme: 2, epic: 1
});

/* foundry-ironsworn stores a foe's challenge rank as a NUMBER 1–5 on
 * `system.rank` (see ChallengeRank.ts in the system). Map it to our
 * canonical rank words. 1=Troublesome … 5=Epic. */
export const RANK_NUM = Object.freeze({
  1: "troublesome", 2: "dangerous", 3: "formidable", 4: "extreme", 5: "epic"
});

/* Inverse of RANK_NUM: canonical rank word → the NUMBER 1–5 the
 * foundry-ironsworn ChallengeRank field stores. Used when creating progress
 * tracks so we write the numeric value the data model expects directly,
 * rather than relying on the system's string-coercion (_cast) path. */
export const RANK_TO_NUM = Object.freeze({
  troublesome: 1, dangerous: 2, formidable: 3, extreme: 4, epic: 5
});

/* Experience awarded for FULFILLING a vow / progress track, by rank — the
 * canonical Ironsworn SRD scale ("mark experience equal to the rank of the
 * vow you fulfil"): Troublesome 1 … Epic 5. Used by grantXp / xpForRank. */
export const RANK_XP = Object.freeze({
  troublesome: 1, dangerous: 2, formidable: 3, extreme: 4, epic: 5
});

/* Debug logging is toggled by eternal-skald.js via setDebug(). */
let DEBUG = false;

export function dbg(...args) {
  if (DEBUG) console.log(LOG_PREFIX, ...args);
}
export function warn(...args) {
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
export const MOVE_CATALOG = Object.freeze([
  // — Adventure —
  { id: "move:classic/adventure/face_danger",          name: "Face Danger",           stats: ["edge", "heart", "iron", "shadow", "wits"], cat: "Adventure" },
  { id: "move:classic/adventure/secure_an_advantage",  name: "Secure an Advantage",   stats: ["edge", "heart", "iron", "shadow", "wits"], cat: "Adventure" },
  { id: "move:classic/adventure/gather_information",   name: "Gather Information",    stats: ["wits"],                                     cat: "Adventure" },
  { id: "move:classic/adventure/heal",                 name: "Heal",                  stats: ["wits", "iron"],                             cat: "Adventure" },
  { id: "move:classic/adventure/resupply",             name: "Resupply",              stats: ["wits"],                                     cat: "Adventure" },
  { id: "move:classic/adventure/make_camp",            name: "Make Camp",             stats: ["supply"],                                   cat: "Adventure" },
  { id: "move:classic/adventure/undertake_a_journey",  name: "Undertake a Journey",   stats: ["wits"],                                     cat: "Adventure" },
  { id: "move:classic/adventure/reach_your_destination", name: "Reach Your Destination", stats: ["progress"],                             cat: "Adventure" },
  // — Combat —
  { id: "move:classic/combat/enter_the_fray",          name: "Enter the Fray",        stats: ["heart", "shadow", "wits"],                  cat: "Combat" },
  { id: "move:classic/combat/strike",                  name: "Strike",                stats: ["iron", "edge"],                             cat: "Combat" },
  { id: "move:classic/combat/clash",                   name: "Clash",                 stats: ["iron", "edge"],                             cat: "Combat" },
  { id: "move:classic/combat/turn_the_tide",           name: "Turn the Tide",         stats: [],                                           cat: "Combat" },
  { id: "move:classic/combat/end_the_fight",           name: "End the Fight",         stats: ["progress"],                                 cat: "Combat" },
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
export const MOVE_BY_ID = new Map(MOVE_CATALOG.map(m => [m.id, m]));
export const MOVE_BY_NAME = new Map(MOVE_CATALOG.map(m => [m.name.toLowerCase(), m]));

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
export const MOVE_TRIGGERS = Object.freeze({
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
export const MOVE_COMPENDIUM_BY_RULESET = Object.freeze({
  classic:        "foundry-ironsworn.ironswornmoves",
  delve:          "foundry-ironsworn.ironsworndelvemoves",
  starforged:     "foundry-ironsworn.starforgedmoves",
  sundered_isles: "foundry-ironsworn.sunderedislesmoves"
});

/** Parse the rules-package segment from a Datasworn move ID. */
export function dsRulesPackage(dsid) {
  // "move:classic/combat/strike" → "classic"
  const m = /^move:([^/]+)\//.exec(String(dsid ?? ""));
  return m ? m[1] : null;
}

/* The five Ironsworn stats + the standard condition meters. */
export const STAT_KEYS  = ["edge", "heart", "iron", "shadow", "wits"];
export const METER_KEYS = ["health", "spirit", "supply", "momentum"];

/* (v0.10.36 — Phase 2) The COMPLETE set of impact / debility flags the
 * foundry-ironsworn character data model carries under `system.debility.*`.
 * These are booleans on the character. The list mirrors template.json
 * exactly (classic conditions + Starforged/Sundered impacts), so the AI
 * snapshot and the toggle write path cover every condition the sheet shows.
 * `custom1`/`custom2` are the two user-defined slots (with paired *name
 * string fields) and are read but not written by the AI toggle path. */
export const DEBILITY_KEYS = [
  "wounded", "shaken", "unprepared", "encumbered", "maimed",
  "corrupted", "cursed", "tormented", "battered", "doomed",
  "permanentlyharmed", "traumatized", "indebted"
];

/* Canonical impact aliases → the real `system.debility.<key>`. Lets the AI
 * (and players) name an impact loosely ("harmed", "permanently harmed",
 * "in debt") and still hit the correct flag. Keys are normalized to lower
 * case with spaces/underscores/hyphens stripped before lookup. */
export const IMPACT_ALIASES = Object.freeze({
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
export function canonicalImpactKey(name) {
  const k = String(name ?? "").toLowerCase().replace(/[\s_-]+/g, "");
  if (DEBILITY_KEYS.includes(k)) return k;
  if (IMPACT_ALIASES[k]) return IMPACT_ALIASES[k];
  return null;
}

/** Toggle verbose debug logging (was IronswornController.setDebug). */
export function setDebug(on) { DEBUG = !!on; }
