/* =====================================================================
 *  THE ETERNAL SKALD — Nimble System Adapter
 *  ---------------------------------------------------------------------
 *  Phase 4 of the multi-system plugin architecture
 *  (see docs/PROPOSAL-multi-system-adapter-architecture.md).
 *
 *  This adapter teaches the Skald to read a character running under the
 *  `nimble` game system (Nimble 2 — https://nimbrew.com / the FoundryVTT
 *  "Nimble" system, id "nimble"). It satisfies the SystemAdapter contract
 *  (adapter-interface.js) and is registered with the registry under the
 *  "nimble" system id (see scripts/hooks/foundry-hooks.js).
 *
 *  WHY READ-ONLY (for now)
 *  -----------------------
 *  Nimble's data model is fundamentally different from Ironsworn's: it has
 *  the four abilities STR / DEX / INT / WIL, the resource pools HP /
 *  Wounds / Mana / Hit Dice, a subtractive-damage combat model and a
 *  "heroic" action economy — but NO oracles, NO progress tracks, NO vows
 *  and NO momentum meter. The Skald's mechanical WRITE pipeline
 *  (markProgress / triggerMove / grantXp / momentum …) is built around
 *  those Ironsworn concepts, so for Nimble those operations are reported
 *  `unsupported()` and the consumers — which all feature-detect and consult
 *  capabilities() — simply omit them. What Nimble DOES light up is the
 *  agnostic core: character READS for AI context, the Nimble rules digest
 *  in the system prompt, and map vision (a system-independent feature).
 *
 *  DESIGN PRINCIPLES (mirroring IronswornController)
 *  -------------------------------------------------
 *    1. Feature-detect / defend everything — Nimble, like Ironsworn,
 *       publishes no stable developer API, so every read is probed
 *       defensively against `actor.system.*` and degrades gracefully.
 *    2. Reads NEVER throw — they return null / [] / {} so the AI context
 *       builder can simply omit missing data.
 *    3. Writes are GM-gated and, where the concept does not exist in
 *       Nimble, return `unsupported()` rather than guessing.
 *
 *  Like the Ironsworn controller, this file has no Foundry imports of its
 *  own; it uses the global `game`, `canvas`, and `foundry.utils` provided
 *  at runtime.
 * ===================================================================== */

import { LOG_PREFIX as BASE_PREFIX } from "../core/constants.js";
import { emptyCapabilities, unsupported } from "./adapter-interface.js";

const SYSTEM_ID = "nimble";
const LOG_PREFIX = `${BASE_PREFIX} Nimble |`;

/* Nimble's four abilities. Keys are the `system.abilities.<key>` paths the
 * Nimble data model uses; `abbr` is the short label the Skald surfaces. */
const ABILITIES = Object.freeze([
  { key: "strength",     abbr: "STR", label: "Strength" },
  { key: "dexterity",    abbr: "DEX", label: "Dexterity" },
  { key: "intelligence", abbr: "INT", label: "Intelligence" },
  { key: "will",         abbr: "WIL", label: "Will" }
]);

function warn(...args) { console.warn(LOG_PREFIX, ...args); }

/** Safe numeric read: returns the number at `path`, or `fallback`. */
function num(actor, path, fallback = null) {
  try {
    const v = foundry.utils.getProperty(actor, path);
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  } catch (_) {
    return fallback;
  }
}

/**
 * The Nimble adapter. A plain frozen object (stateless), exactly the shape
 * the registry expects. Named `NimbleAdapter` to mirror `IronswornController`.
 *
 * @type {import("./adapter-interface.js").SystemAdapter}
 */
export const NimbleAdapter = Object.freeze({
  id: SYSTEM_ID,
  label: "Nimble",

  /* =================================================================
   *  Identity & capability (REQUIRED)
   * ================================================================= */

  /** True iff the active game system is Nimble. */
  isActive() {
    try { return game?.system?.id === SYSTEM_ID; }
    catch (_) { return false; }
  },

  /**
   * Capability report. Nimble supports character READS and the
   * system-independent map-vision feature; it has NO oracles, progress
   * tracks, vows or momentum, so those flags stay OFF and the Skald's
   * Ironsworn-specific pipelines are silently skipped by the consumers.
   */
  capabilities() {
    const caps = emptyCapabilities(false);
    caps.systemActive   = this.isActive();
    caps.characterReads = true;   // STR/DEX/INT/WIL + HP/Wounds/Mana/Hit Dice
    caps.mapVision      = true;   // core Skald feature, system-independent
    return caps;
  },

  /* =================================================================
   *  Character & state reads
   * ================================================================= */

  /**
   * Resolve "the actor the Skald should act for" with the same priority the
   * Ironsworn controller uses: controlled token → user's character → sole
   * owned character. Returns null when ambiguous / none.
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

  /**
   * The four Nimble ability MODIFIERS, keyed by short label (STR/DEX/INT/
   * WIL). Missing values become null. This is the Nimble analogue of the
   * Ironsworn controller's getStats(). `getStats` is provided as the
   * contract-canonical alias so generic consumers work unchanged.
   *
   * @param {Actor} [actor]
   * @returns {Record<string, number|null>}
   */
  getCharacterStats(actor = this.getActiveCharacter()) {
    const out = {};
    for (const { key, abbr } of ABILITIES) {
      // Prefer the derived `.mod`; fall back to `.baseValue` then a bare number.
      out[abbr] = num(actor, `system.abilities.${key}.mod`,
                  num(actor, `system.abilities.${key}.baseValue`,
                  num(actor, `system.abilities.${key}`, null)));
    }
    return out;
  },

  /** Contract-canonical alias of {@link getCharacterStats}. */
  getStats(actor = this.getActiveCharacter()) {
    return this.getCharacterStats(actor);
  },

  /**
   * Nimble's resource pools as `{ key: { value, max } }`:
   *   • hp       — `system.attributes.hp` (value/max, + temp if present)
   *   • wounds   — `system.attributes.wounds` (value/max)
   *   • mana     — `system.resources.mana` (current/value → value, max)
   *   • hitDice  — aggregate of `system.attributes.hitDice` (a record of
   *                die-size → { current }); value = Σ current.
   * Pools that are absent are omitted. Never throws.
   *
   * @param {Actor} [actor]
   * @returns {Record<string, {value:number, max:number|null, temp?:number}>}
   */
  getResourcePools(actor = this.getActiveCharacter()) {
    const out = {};
    if (!actor) return out;

    // HP — value/max (+ optional temp).
    const hpVal = num(actor, "system.attributes.hp.value");
    if (hpVal !== null) {
      const pool = { value: hpVal, max: num(actor, "system.attributes.hp.max") };
      const temp = num(actor, "system.attributes.hp.temp");
      if (temp) pool.temp = temp;
      out.hp = pool;
    }

    // Wounds — value/max.
    const woundsVal = num(actor, "system.attributes.wounds.value");
    if (woundsVal !== null) {
      out.wounds = { value: woundsVal, max: num(actor, "system.attributes.wounds.max") };
    }

    // Mana — derived `value`/`max`, falling back to `current`/`baseMax`.
    const manaVal = num(actor, "system.resources.mana.value",
                    num(actor, "system.resources.mana.current"));
    if (manaVal !== null) {
      out.mana = {
        value: manaVal,
        max: num(actor, "system.resources.mana.max",
             num(actor, "system.resources.mana.baseMax"))
      };
    }

    // Hit Dice — a record keyed by die size, each with a `current` count.
    try {
      const hd = foundry.utils.getProperty(actor, "system.attributes.hitDice");
      if (hd && typeof hd === "object") {
        let cur = 0, total = 0, any = false;
        for (const entry of Object.values(hd)) {
          if (entry && typeof entry.current === "number") {
            cur += entry.current; any = true;
            if (typeof entry.max === "number") total += entry.max;
          }
        }
        if (any) out.hitDice = { value: cur, max: total || null };
      }
    } catch (_) { /* hit dice absent — omit */ }

    return out;
  },

  /** Contract-canonical alias of {@link getResourcePools}. */
  getMeters(actor = this.getActiveCharacter()) {
    return this.getResourcePools(actor);
  },

  /**
   * A prompt-ready, one-block summary of the active Nimble character for the
   * AI context. Returns "" when Nimble is not active / no actor — exactly the
   * graceful-empty contract the Ironsworn controller follows.
   *
   * @param {Actor} [actor]
   * @returns {string}
   */
  describeCharacter(actor = this.getActiveCharacter()) {
    if (!this.isActive()) return "";
    if (!actor) return "(No active Nimble character could be resolved — select a token or set your player character.)";

    const lines = [`Character: ${actor.name}`];

    const stats = this.getCharacterStats(actor);
    const statStr = ABILITIES
      .map(({ abbr }) => {
        const v = stats[abbr];
        const sign = typeof v === "number" && v >= 0 ? "+" : "";
        return `${abbr} ${v === null ? "?" : `${sign}${v}`}`;
      })
      .join(", ");
    lines.push(`Abilities: ${statStr}`);

    const pools = this.getResourcePools(actor);
    const order = [["hp", "HP"], ["wounds", "Wounds"], ["mana", "Mana"], ["hitDice", "Hit Dice"]];
    const poolStr = order
      .map(([k, label]) => {
        const p = pools[k];
        if (!p) return null;
        const max = typeof p.max === "number" ? `/${p.max}` : "";
        const temp = p.temp ? ` (+${p.temp} temp)` : "";
        return `${label} ${p.value}${max}${temp}`;
      })
      .filter(Boolean)
      .join(", ");
    if (poolStr) lines.push(`Resources: ${poolStr}`);

    return lines.join("\n");
  },

  /* =================================================================
   *  Prompt profile — Nimble flavour for the AI
   * ================================================================= */

  /**
   * Build the Nimble-specific rules context the AI GM needs to narrate
   * coherently. Unlike Ironsworn the Skald does NOT drive a Nimble rules
   * engine (no programmatic move/oracle API), so this is GUIDANCE only: it
   * teaches the model Nimble's resolution math and resource model and tells
   * it to defer dice/mechanics to the players and the system sheet.
   *
   * @returns {string}
   */
  buildSystemPrompt() {
    if (!this.isActive()) return "";
    return `\
NIMBLE SYSTEM CONTEXT (you are narrating atop the "nimble" game system):
You are the GM for a game running on Nimble 2 — a fast, d20-based system. You
do NOT have a programmatic rules engine here: you decide the FICTION and the
stakes, while the players roll on their own character sheets and the Nimble
system resolves the mechanics. Narrate outcomes; never invent dice results.

CORE MATH:
• Checks/attacks roll d20 + the relevant ABILITY modifier (STR, DEX, INT, WIL)
  versus a target/Armor value. Advantage/disadvantage add or drop extra dice.
• Combat is SUBTRACTIVE: damage is rolled and subtracted from HP; primary
  attacks that hit also deal their base damage even on a miss-to-hit only when
  the rules say so — respect the players' sheet results.
• Critical hits explode damage dice; rolling the lowest result can be a fumble.

RESOURCES YOU MAY REFERENCE (read-only — never set them yourself):
• HP — hit points; reaching 0 drops the character to Wounds/dying.
• Wounds — lasting injuries that accrue as HP is depleted; track them narratively.
• Mana — spent to cast spells / use mana abilities; gate magical effects on it.
• Hit Dice — spent on rests to recover HP.

ACTION ECONOMY (heroic): characters act decisively on their turn; lean into
bold, cinematic "heroic" actions and let the players spend their resources.

WHAT NOT TO DO:
• Do NOT use Ironsworn concepts here — there are no oracles, vows, progress
  tracks or momentum in Nimble. Do not ask for or mark progress, and do not
  emit Ironsworn move/track effect directives.
• Keep mechanics in the players' hands: prompt them to roll, then narrate the
  consequences of what their sheet reports.`;
  },

  /**
   * Contract-canonical prompt profile. Surfaces the Nimble rules digest via
   * the standard {persona, rulesDigest, moveList} shape so a future prompt
   * builder can consume it uniformly. Nimble advertises no move list.
   *
   * @returns {{persona: string, rulesDigest: string, moveList: string}}
   */
  getPromptProfile() {
    return {
      persona: "",                         // keep the Skald's default persona
      rulesDigest: this.buildSystemPrompt(),
      moveList: ""                         // Nimble exposes no programmatic moves
    };
  },

  /* =================================================================
   *  Mechanical writes — UNSUPPORTED for Nimble (graceful no-ops)
   *  ---------------------------------------------------------------
   *  These Ironsworn-shaped operations have no Nimble equivalent the Skald
   *  can safely drive, so they report `unsupported()`. Consumers consult
   *  capabilities() / feature-detect first, so these are belt-and-braces.
   * ================================================================= */

  adjustResource() { return unsupported("nimble: resource writes not supported"); },
  applyHarm()      { return unsupported("nimble: harm writes not supported"); },
  applyStress()    { return unsupported("nimble: stress writes not supported"); },
  setStat()        { return unsupported("nimble: stat writes not supported"); },
  setImpact()      { return unsupported("nimble: impacts not supported"); },

  /* --- Progress / objectives — Nimble has none --- */
  markProgress()        { return unsupported("nimble: no progress tracks"); },
  setProgress()         { return unsupported("nimble: no progress tracks"); },
  createProgressTrack() { return unsupported("nimble: no progress tracks"); },
  completeTrack()       { return unsupported("nimble: no progress tracks"); },
  grantXp()             { return unsupported("nimble: xp grants not supported"); },

  /* --- Moves / actions / oracles — no programmatic engine in Nimble --- */
  async triggerMove() { return unsupported("nimble: no programmatic moves"); },
  rollOracle()        { return null; },

  /* --- Compendium content creation — not supported by this adapter --- */
  async createFoeActor()  { return unsupported("nimble: foe creation not supported"); },
  async addAssetToActor() { return unsupported("nimble: asset grants not supported"); },
  async createCharacter() { return unsupported("nimble: character creation not supported"); }
});

export default NimbleAdapter;
