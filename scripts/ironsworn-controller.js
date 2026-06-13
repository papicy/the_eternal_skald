/* =====================================================================
 *  THE ETERNAL SKALD — Ironsworn System Controller (composition root)
 *  (Module version lives in module.json — the single source of truth.)
 *  ---------------------------------------------------------------------
 *  This is the bridge between The Eternal Skald (the "GM brain") and the
 *  official `foundry-ironsworn` system (the "rules engine"). It decides
 *  WHAT should happen and asks the Ironsworn system to DO it.
 *
 *  As of Phase B / H2 this file is a THIN COMPOSITION ROOT: the ~120
 *  methods that once lived here inline were extracted VERBATIM into focused
 *  submodules under scripts/ironsworn/ (moves, character, combat, progress,
 *  mechanics, meters) and the shared constants / move catalogue / helpers
 *  into ./ironsworn/internals.js. They are reassembled here onto a single
 *  IronswornController object via Object.assign, so every method's `this`
 *  still resolves to this one facade and all cross-method calls + shared
 *  cache state behave exactly as before. The public API (method names,
 *  signatures, the default export) is unchanged.
 *
 *  DESIGN PRINCIPLES (unchanged): feature-detect everything; never throw out
 *  of a read; writes go through actor.update()/system dialogs; Datasworn IDs.
 * ===================================================================== */

import {
  MOVE_CATALOG, setDebug as _setDebug
} from "./ironsworn/internals.js";
import { MetersMethods }    from "./ironsworn/meters.js";
import { CharacterMethods } from "./ironsworn/character.js";
import { MovesMethods }     from "./ironsworn/moves.js";
import { ProgressMethods }  from "./ironsworn/progress.js";
import { CombatMethods }    from "./ironsworn/combat.js";
import { MechanicsMethods } from "./ironsworn/mechanics.js";

/* The composition root holds only shared state (cache fields + last-track),
 * the static `moves` getter, and `setDebug`. All behavioural methods are
 * mixed in from the submodules below. */
export const IronswornController = Object.assign(
  {


  /* ---------------- Configuration ---------------- */

  setDebug(on) { _setDebug(on); },

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

  /* =================================================================
   *  GENERIC COMPENDIUM CONTEXT (v0.15.0)
   *  Token-efficient name catalogues from arbitrary foundry-ironsworn
   *  packs (moves, assets, truths, domains, themes …) for the AI prompt.
   *  Generalises the foe-cache pattern: async index → in-memory cache →
   *  sync reader. Each category is opt-in via a world setting; the prompt
   *  builder reads the cached snapshot synchronously and degrades to "".
   * ================================================================= */

  /** category → official pack id. Bare collection segments also match. */
  CONTEXT_PACK_MAP: Object.freeze({
    moves:      "foundry-ironsworn.ironswornmoves",
    delvemoves: "foundry-ironsworn.ironsworndelvemoves",
    assets:     "foundry-ironsworn.ironswornassets",
    truths:     "foundry-ironsworn.ironsworntruths",
    domains:    "foundry-ironsworn.ironsworndelvedomains",
    themes:     "foundry-ironsworn.ironsworndelvethemes"
  }),

  /** In-memory cache: { category: [name, …] }. Cleared on world reload. */
  _contextIndexCache: null,

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

  /* ---- Foe ACTOR compendia (distinct from the foe-ITEM rank index) ----
   * The official packs foe-actors-is / foe-actors-delve / foe-actors-sf hold
   * ready-made foe ACTORS (type "foe") with an embedded progress track. We
   * index them by name so the Skald can spawn a real, stat-bearing foe actor
   * into the world rather than only a bare progress track on the PC sheet. */

  /** In-memory cache of the merged foe-actor index. Cleared on world reload. */
  _foeActorIndexCache: null,

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
  ACTION_STATS: Object.freeze(["edge", "heart", "iron", "shadow", "wits"])
  },
  MetersMethods,
  CharacterMethods,
  MovesMethods,
  ProgressMethods,
  CombatMethods,
  MechanicsMethods,
);

export default IronswornController;
