/* =====================================================================
 *  THE ETERNAL SKALD — D&D 5e System Adapter (read-only)
 *  ---------------------------------------------------------------------
 *  Phase E of the multi-system plugin architecture.
 *
 *  Teaches the Skald to READ a character running under the `dnd5e` game
 *  system (the official Foundry "Dungeons & Dragons Fifth Edition" system,
 *  id "dnd5e") so it can narrate coherently with full awareness of the
 *  party's capabilities. It satisfies the SystemAdapter contract
 *  (adapter-interface.js) and registers under the "dnd5e" system id (see
 *  scripts/hooks/foundry-hooks.js).
 *
 *  WHY READ-ONLY
 *  -------------
 *  The Skald's mechanical WRITE pipeline (oracles, vows, progress tracks,
 *  momentum, programmatic moves, XP/legacy writes) is built around
 *  Ironsworn concepts that do not map onto 5e's d20 + class/level model. 5e
 *  also has a mature, deeply-validated system that owns its own dice and
 *  resource bookkeeping. So this adapter lights up the agnostic core —
 *  character READS for AI context, a 5e rules digest in the system prompt,
 *  and map vision — while every mechanical write reports `unsupported()` and
 *  the capability-aware consumers simply omit it. The Skald is a narrative
 *  partner for 5e, not a rules-automation layer.
 *
 *  DESIGN PRINCIPLES (mirroring NimbleAdapter / IronswornController)
 *  -----------------------------------------------------------------
 *    1. Feature-detect / defend every read against `actor.system.*`.
 *    2. Reads NEVER throw — return null / [] / {} so the context builder
 *       can simply omit missing data.
 *    3. Writes return `unsupported()` rather than guessing.
 *
 *  Like the other adapters this file has no Foundry imports of its own; it
 *  uses the runtime globals `game`, `canvas`, and `foundry.utils`.
 * ===================================================================== */

import { LOG_PREFIX as BASE_PREFIX } from "../core/constants.js";
import { emptyCapabilities, unsupported } from "./adapter-interface.js";

const SYSTEM_ID = "dnd5e";
const LOG_PREFIX = `${BASE_PREFIX} D&D5e |`;

/* The six 5e ability scores. `key` is the `system.abilities.<key>` path the
 * dnd5e data model uses; `abbr` is the short label the Skald surfaces. */
const ABILITIES = Object.freeze([
  { key: "str", abbr: "STR", label: "Strength" },
  { key: "dex", abbr: "DEX", label: "Dexterity" },
  { key: "con", abbr: "CON", label: "Constitution" },
  { key: "int", abbr: "INT", label: "Intelligence" },
  { key: "wis", abbr: "WIS", label: "Wisdom" },
  { key: "cha", abbr: "CHA", label: "Charisma" }
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
 * The D&D 5e adapter. A plain frozen, stateless object — exactly the shape
 * the registry expects. Named to mirror NimbleAdapter / IronswornController.
 *
 * @type {import("./adapter-interface.js").SystemAdapter}
 */
export const Dnd5eAdapter = Object.freeze({
  id: SYSTEM_ID,
  label: "D&D 5e",

  /* =================================================================
   *  Identity & capability (REQUIRED)
   * ================================================================= */

  /** True iff the active game system is dnd5e. */
  isActive() {
    try { return game?.system?.id === SYSTEM_ID; }
    catch (_) { return false; }
  },

  /**
   * Capability report. 5e lights up character READS and the system-agnostic
   * map-vision feature only; all Ironsworn-shaped write flags stay OFF so the
   * Skald's mechanical pipelines are silently skipped by the consumers.
   */
  capabilities() {
    const caps = emptyCapabilities(false);
    caps.systemActive   = this.isActive();
    caps.characterReads = true;   // abilities + HP/AC + spell slots + inventory
    caps.mapVision      = true;   // core Skald feature, system-independent
    return caps;
  },

  /* =================================================================
   *  Character & state reads
   * ================================================================= */

  /**
   * Resolve "the actor the Skald should act for" with the same priority the
   * other adapters use: controlled token → user's character → sole owned
   * character. Returns null when ambiguous / none.
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
   * The six 5e ability MODIFIERS, keyed by short label (STR/DEX/CON/INT/
   * WIS/CHA). Missing values become null. `getStats` is the contract-canonical
   * alias so generic consumers work unchanged.
   *
   * @param {Actor} [actor]
   * @returns {Record<string, number|null>}
   */
  getCharacterStats(actor = this.getActiveCharacter()) {
    const out = {};
    for (const { key, abbr } of ABILITIES) {
      // Prefer the derived `.mod`; fall back to deriving it from `.value`.
      let mod = num(actor, `system.abilities.${key}.mod`, null);
      if (mod === null) {
        const score = num(actor, `system.abilities.${key}.value`, null);
        if (score !== null) mod = Math.floor((score - 10) / 2);
      }
      out[abbr] = mod;
    }
    return out;
  },

  /** Contract-canonical alias of {@link getCharacterStats}. */
  getStats(actor = this.getActiveCharacter()) {
    return this.getCharacterStats(actor);
  },

  /**
   * 5e resource pools as `{ key: { value, max } }`:
   *   • hp        — `system.attributes.hp` (value/max, + temp).
   *   • ac        — `system.attributes.ac.value` (value only; max omitted).
   *   • spell1..9 — `system.spells.spell<N>` (value/max) for any level that
   *                 has a non-zero max (so cantrips / unused levels are
   *                 omitted), plus the warlock `pact` pool when present.
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

    // AC — value only.
    const ac = num(actor, "system.attributes.ac.value");
    if (ac !== null) out.ac = { value: ac, max: null };

    // Spell slots — levels 1..9 with a real max, plus the pact pool.
    for (let lvl = 1; lvl <= 9; lvl++) {
      const max = num(actor, `system.spells.spell${lvl}.max`);
      if (max) out[`spell${lvl}`] = { value: num(actor, `system.spells.spell${lvl}.value`, 0), max };
    }
    const pactMax = num(actor, "system.spells.pact.max");
    if (pactMax) out.pact = { value: num(actor, "system.spells.pact.value", 0), max: pactMax };

    return out;
  },

  /** Contract-canonical alias of {@link getResourcePools}. */
  getMeters(actor = this.getActiveCharacter()) {
    return this.getResourcePools(actor);
  },

  /**
   * Short class / level descriptor, e.g. "Level 5 Wizard" or "Fighter 3 /
   * Rogue 2". Defends against both the modern `actor.classes` record and the
   * `system.details.level` total. Returns "" when nothing is readable.
   *
   * @param {Actor} [actor]
   * @returns {string}
   */
  describeClassLevel(actor = this.getActiveCharacter()) {
    try {
      const classes = actor?.classes;
      if (classes && typeof classes === "object") {
        const parts = Object.values(classes)
          .map(c => {
            const name = c?.name ?? c?.system?.identifier;
            const lv = c?.system?.levels;
            return name ? `${name}${typeof lv === "number" ? ` ${lv}` : ""}` : null;
          })
          .filter(Boolean);
        if (parts.length) return parts.join(" / ");
      }
      const total = num(actor, "system.details.level");
      return total !== null ? `Level ${total}` : "";
    } catch (_) { return ""; }
  },

  /**
   * A prompt-ready, one-block summary of the active 5e character for the AI
   * context. Returns "" when 5e is not active / no actor — the same graceful
   * contract the other adapters follow.
   *
   * @param {Actor} [actor]
   * @returns {string}
   */
  describeCharacter(actor = this.getActiveCharacter()) {
    if (!this.isActive()) return "";
    if (!actor) return "(No active D&D 5e character could be resolved — select a token or set your player character.)";

    const lines = [`Character: ${actor.name}`];
    const cl = this.describeClassLevel(actor);
    if (cl) lines.push(cl);

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
    const vital = [];
    if (pools.hp) {
      const max = typeof pools.hp.max === "number" ? `/${pools.hp.max}` : "";
      const temp = pools.hp.temp ? ` (+${pools.hp.temp} temp)` : "";
      vital.push(`HP ${pools.hp.value}${max}${temp}`);
    }
    if (pools.ac) vital.push(`AC ${pools.ac.value}`);
    if (vital.length) lines.push(`Vitals: ${vital.join(", ")}`);

    const slots = [];
    for (let lvl = 1; lvl <= 9; lvl++) {
      const p = pools[`spell${lvl}`];
      if (p) slots.push(`L${lvl} ${p.value}/${p.max}`);
    }
    if (pools.pact) slots.push(`Pact ${pools.pact.value}/${pools.pact.max}`);
    if (slots.length) lines.push(`Spell slots: ${slots.join(", ")}`);

    const inv = this.getInventoryHighlights(actor);
    if (inv.length) lines.push(`Notable items: ${inv.join(", ")}`);

    return lines.join("\n");
  },

  /**
   * A short list of notable carried items (equipped weapons + equipped
   * armour/shields + attuned magic items), capped for prompt economy.
   * Returns [] when nothing readable. Never throws.
   *
   * @param {Actor} [actor]
   * @returns {string[]}
   */
  getInventoryHighlights(actor = this.getActiveCharacter()) {
    try {
      const items = actor?.items;
      if (!items) return [];
      const out = [];
      for (const it of items) {
        const type = it?.type;
        const equipped = it?.system?.equipped === true;
        const attuned = it?.system?.attuned === true || it?.system?.attunement === 2;
        if ((type === "weapon" && equipped) ||
            (type === "equipment" && equipped) ||
            attuned) {
          if (it?.name) out.push(it.name);
        }
        if (out.length >= 8) break;
      }
      return out;
    } catch (_) { return []; }
  },

  /* =================================================================
   *  Prompt profile — 5e flavour for the AI
   * ================================================================= */

  /**
   * Build the 5e-specific rules context the AI GM needs to narrate
   * coherently. The Skald does NOT drive the 5e rules engine — this is
   * GUIDANCE only: it teaches the model 5e's resolution math and resource
   * model and tells it to defer dice/mechanics to the players and the sheet.
   *
   * @returns {string}
   */
  buildSystemPrompt() {
    if (!this.isActive()) return "";
    return `\
D&D 5e SYSTEM CONTEXT (you are narrating atop the "dnd5e" game system):
You are the Dungeon Master for a game running on Dungeons & Dragons Fifth
Edition. You do NOT have a programmatic rules engine here: you frame the
FICTION, the stakes and the world, while the players roll on their own
character sheets and the dnd5e system resolves the mechanics. Narrate
outcomes; never invent dice results or change sheet values yourself.

CORE MATH:
• Ability checks, attacks and saving throws roll d20 + the relevant ability
  modifier (STR/DEX/CON/INT/WIS/CHA) + proficiency where it applies, versus a
  DC or Armor Class. Advantage/disadvantage roll two d20 and keep the
  higher/lower.
• A natural 20 on an attack is a critical hit (double damage dice); a natural 1
  is an automatic miss.

RESOURCES YOU MAY REFERENCE (read-only — never set them yourself):
• HP / temp HP — damage subtracts from HP; 0 HP means dying (death saves).
• AC — the target number to hit the character.
• Spell slots (by level) and pact slots — gate spellcasting on available slots;
  prompt the player to expend a slot rather than spending it for them.

NARRATION:
• Honour the six pillars of play: exploration, social interaction and combat.
  Lean into vivid description, evocative NPCs and meaningful choices.
• Respect class fantasy and the party's notable items when you describe what
  they can attempt.

WHAT NOT TO DO:
• Do NOT use Ironsworn concepts here — there are no oracles, vows, progress
  tracks or momentum in 5e. Do not ask for or mark progress, and do not emit
  Ironsworn move/track effect directives.
• Keep mechanics in the players' hands: call for the roll (e.g. "make a DC 15
  Dexterity save"), then narrate the consequences of what their sheet reports.`;
  },

  /**
   * Contract-canonical prompt profile via the standard {persona, rulesDigest,
   * moveList} shape. 5e advertises no Ironsworn-style move list.
   *
   * @returns {{persona: string, rulesDigest: string, moveList: string}}
   */
  getPromptProfile() {
    return {
      persona: "",                         // keep the Skald's default persona
      rulesDigest: this.buildSystemPrompt(),
      moveList: ""                         // 5e exposes no programmatic moves here
    };
  },

  /* =================================================================
   *  Mechanical writes — UNSUPPORTED for 5e (graceful no-ops)
   *  ---------------------------------------------------------------
   *  These Ironsworn-shaped operations have no 5e equivalent the Skald can
   *  safely drive, so they report `unsupported()`. Consumers consult
   *  capabilities() / feature-detect first, so these are belt-and-braces.
   * ================================================================= */

  adjustResource() { return unsupported("dnd5e: resource writes not supported"); },
  applyHarm()      { return unsupported("dnd5e: harm writes not supported"); },
  applyStress()    { return unsupported("dnd5e: stress writes not supported"); },
  setStat()        { return unsupported("dnd5e: stat writes not supported"); },
  setImpact()      { return unsupported("dnd5e: impacts not supported"); },

  /* --- Progress / objectives — no Ironsworn tracks in 5e --- */
  markProgress()        { return unsupported("dnd5e: no progress tracks"); },
  setProgress()         { return unsupported("dnd5e: no progress tracks"); },
  createProgressTrack() { return unsupported("dnd5e: no progress tracks"); },
  completeTrack()       { return unsupported("dnd5e: no progress tracks"); },
  grantXp()             { return unsupported("dnd5e: xp grants not supported"); },

  /* --- Moves / actions / oracles — no programmatic engine here --- */
  async triggerMove() { return unsupported("dnd5e: no programmatic moves"); },
  rollOracle()        { return null; },

  /* --- Compendium content creation — not supported by this adapter --- */
  async createFoeActor()  { return unsupported("dnd5e: foe creation not supported"); },
  async addAssetToActor() { return unsupported("dnd5e: asset grants not supported"); },
  async createCharacter() { return unsupported("dnd5e: character creation not supported"); }
});

export default Dnd5eAdapter;
