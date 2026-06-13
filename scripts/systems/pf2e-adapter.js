/* =====================================================================
 *  THE ETERNAL SKALD — Pathfinder 2e System Adapter (read-only)
 *  ---------------------------------------------------------------------
 *  Phase E of the multi-system plugin architecture.
 *
 *  Teaches the Skald to READ a character running under the `pf2e` game
 *  system (the official Foundry "Pathfinder Second Edition" system, id
 *  "pf2e") so it can narrate coherently with full awareness of the party's
 *  capabilities. It satisfies the SystemAdapter contract
 *  (adapter-interface.js) and registers under the "pf2e" system id (see
 *  scripts/hooks/foundry-hooks.js).
 *
 *  WHY READ-ONLY
 *  -------------
 *  The Skald's mechanical WRITE pipeline (oracles, vows, progress tracks,
 *  momentum, programmatic moves, XP/legacy writes) is built around Ironsworn
 *  concepts that do not map onto PF2e's d20 + class/level/three-action model.
 *  PF2e also has a mature, deeply-validated system that owns its own dice and
 *  resource bookkeeping. So this adapter lights up the agnostic core —
 *  character READS for AI context, a PF2e rules digest in the system prompt,
 *  and map vision — while every mechanical write reports `unsupported()` and
 *  the capability-aware consumers simply omit it. The Skald is a narrative
 *  partner for PF2e, not a rules-automation layer.
 *
 *  DESIGN PRINCIPLES (mirroring Dnd5eAdapter / NimbleAdapter)
 *  ----------------------------------------------------------
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

const SYSTEM_ID = "pf2e";
const LOG_PREFIX = `${BASE_PREFIX} PF2e |`;

/* The six PF2e ability scores. `key` is the `system.abilities.<key>` path the
 * pf2e data model uses; `abbr` is the short label the Skald surfaces. */
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
 * The Pathfinder 2e adapter. A plain frozen, stateless object — exactly the
 * shape the registry expects. Named to mirror Dnd5eAdapter / NimbleAdapter.
 *
 * @type {import("./adapter-interface.js").SystemAdapter}
 */
export const Pf2eAdapter = Object.freeze({
  id: SYSTEM_ID,
  label: "Pathfinder 2e",

  /* =================================================================
   *  Identity & capability (REQUIRED)
   * ================================================================= */

  /** True iff the active game system is pf2e. */
  isActive() {
    try { return game?.system?.id === SYSTEM_ID; }
    catch (_) { return false; }
  },

  /**
   * Capability report. PF2e lights up character READS and the system-agnostic
   * map-vision feature only; all Ironsworn-shaped write flags stay OFF so the
   * Skald's mechanical pipelines are silently skipped by the consumers.
   */
  capabilities() {
    const caps = emptyCapabilities(false);
    caps.systemActive   = this.isActive();
    caps.characterReads = true;   // abilities + HP/AC + hero/focus points + inventory
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
   * The six PF2e ability MODIFIERS, keyed by short label (STR/DEX/CON/INT/
   * WIS/CHA). PF2e stores the derived `.mod` directly; we fall back to
   * deriving it from `.value` for older data. Missing values become null.
   * `getStats` is the contract-canonical alias.
   *
   * @param {Actor} [actor]
   * @returns {Record<string, number|null>}
   */
  getCharacterStats(actor = this.getActiveCharacter()) {
    const out = {};
    for (const { key, abbr } of ABILITIES) {
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
   * PF2e resource pools as `{ key: { value, max } }`:
   *   • hp    — `system.attributes.hp` (value/max, + temp).
   *   • ac    — `system.attributes.ac.value` (value only; max omitted).
   *   • hero  — `system.resources.heroPoints` (value/max) when present.
   *   • focus — `system.resources.focus` (value/max) when the character has a
   *             focus pool.
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

    // Hero Points.
    const heroVal = num(actor, "system.resources.heroPoints.value");
    if (heroVal !== null) out.hero = { value: heroVal, max: num(actor, "system.resources.heroPoints.max") };

    // Focus Points — only when the character actually has a focus pool.
    const focusMax = num(actor, "system.resources.focus.max");
    if (focusMax) out.focus = { value: num(actor, "system.resources.focus.value", 0), max: focusMax };

    return out;
  },

  /** Contract-canonical alias of {@link getResourcePools}. */
  getMeters(actor = this.getActiveCharacter()) {
    return this.getResourcePools(actor);
  },

  /**
   * Short class / ancestry / level descriptor, e.g. "Level 5 Elf Wizard".
   * Defends against the PF2e convenience getters (`actor.class`,
   * `actor.ancestry`) and the `system.details.level.value` total. Returns ""
   * when nothing is readable.
   *
   * @param {Actor} [actor]
   * @returns {string}
   */
  describeClassLevel(actor = this.getActiveCharacter()) {
    try {
      const level = num(actor, "system.details.level.value");
      const ancestry = actor?.ancestry?.name ?? null;
      const klass = actor?.class?.name ?? null;
      const bits = [];
      if (level !== null) bits.push(`Level ${level}`);
      if (ancestry) bits.push(ancestry);
      if (klass) bits.push(klass);
      return bits.join(" ").trim();
    } catch (_) { return ""; }
  },

  /**
   * A prompt-ready, one-block summary of the active PF2e character for the AI
   * context. Returns "" when PF2e is not active / no actor — the same graceful
   * contract the other adapters follow.
   *
   * @param {Actor} [actor]
   * @returns {string}
   */
  describeCharacter(actor = this.getActiveCharacter()) {
    if (!this.isActive()) return "";
    if (!actor) return "(No active Pathfinder 2e character could be resolved — select a token or set your player character.)";

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
    if (pools.hero) vital.push(`Hero Points ${pools.hero.value}${typeof pools.hero.max === "number" ? `/${pools.hero.max}` : ""}`);
    if (pools.focus) vital.push(`Focus ${pools.focus.value}/${pools.focus.max}`);
    if (vital.length) lines.push(`Vitals: ${vital.join(", ")}`);

    const inv = this.getInventoryHighlights(actor);
    if (inv.length) lines.push(`Notable items: ${inv.join(", ")}`);

    return lines.join("\n");
  },

  /**
   * A short list of notable carried items (invested magic items + equipped
   * weapons/armour), capped for prompt economy. PF2e marks worn magic items
   * "invested" and tracks a `system.equipped.carryType` of "worn"/"held".
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
        const invested = it?.system?.equipped?.invested === true;
        const carry = it?.system?.equipped?.carryType;
        const held = carry === "held" || carry === "worn";
        if (invested ||
            ((type === "weapon" || type === "armor") && held)) {
          if (it?.name) out.push(it.name);
        }
        if (out.length >= 8) break;
      }
      return out;
    } catch (_) { return []; }
  },

  /* =================================================================
   *  Prompt profile — PF2e flavour for the AI
   * ================================================================= */

  /**
   * Build the PF2e-specific rules context the AI GM needs to narrate
   * coherently. The Skald does NOT drive the PF2e rules engine — this is
   * GUIDANCE only: it teaches the model PF2e's resolution math and resource
   * model and tells it to defer dice/mechanics to the players and the sheet.
   *
   * @returns {string}
   */
  buildSystemPrompt() {
    if (!this.isActive()) return "";
    return `\
PATHFINDER 2e SYSTEM CONTEXT (you are narrating atop the "pf2e" game system):
You are the Game Master for a game running on Pathfinder Second Edition. You do
NOT have a programmatic rules engine here: you frame the FICTION, the stakes and
the world, while the players roll on their own character sheets and the pf2e
system resolves the mechanics. Narrate outcomes; never invent dice results or
change sheet values yourself.

CORE MATH:
• Checks roll d20 + ability modifier + proficiency (untrained/trained/expert/
  master/legendary, where proficiency adds your level + a bonus) versus a DC.
• Degrees of success matter: beating the DC by 10+ is a CRITICAL SUCCESS;
  failing by 10+ is a CRITICAL FAILURE; a natural 20 improves the degree by one
  step and a natural 1 worsens it by one step.
• Combat runs on the THREE-ACTION economy each turn (plus reactions); many
  actions can be taken in any order.

RESOURCES YOU MAY REFERENCE (read-only — never set them yourself):
• HP / temp HP — at 0 HP a character is dying (dying/wounded conditions).
• AC — the target number to hit the character.
• Hero Points — players may spend them to reroll or stave off death; suggest,
  never spend, them.
• Focus Points — gate focus spells; prompt the player to expend a point.

NARRATION:
• Lean into PF2e's tactical, gritty heroic-fantasy tone; reward clever use of
  the three-action economy and teamwork.
• Respect ancestry/class fantasy and the party's invested items when you
  describe what they can attempt.

WHAT NOT TO DO:
• Do NOT use Ironsworn concepts here — there are no oracles, vows, progress
  tracks or momentum in PF2e. Do not ask for or mark progress, and do not emit
  Ironsworn move/track effect directives.
• Keep mechanics in the players' hands: call for the check (e.g. "attempt a DC
  20 Athletics check to Climb"), then narrate the degree of success their sheet
  reports.`;
  },

  /**
   * Contract-canonical prompt profile via the standard {persona, rulesDigest,
   * moveList} shape. PF2e advertises no Ironsworn-style move list.
   *
   * @returns {{persona: string, rulesDigest: string, moveList: string}}
   */
  getPromptProfile() {
    return {
      persona: "",                         // keep the Skald's default persona
      rulesDigest: this.buildSystemPrompt(),
      moveList: ""                         // PF2e exposes no programmatic moves here
    };
  },

  /* =================================================================
   *  Mechanical writes — UNSUPPORTED for PF2e (graceful no-ops)
   *  ---------------------------------------------------------------
   *  These Ironsworn-shaped operations have no PF2e equivalent the Skald can
   *  safely drive, so they report `unsupported()`. Consumers consult
   *  capabilities() / feature-detect first, so these are belt-and-braces.
   * ================================================================= */

  adjustResource() { return unsupported("pf2e: resource writes not supported"); },
  applyHarm()      { return unsupported("pf2e: harm writes not supported"); },
  applyStress()    { return unsupported("pf2e: stress writes not supported"); },
  setStat()        { return unsupported("pf2e: stat writes not supported"); },
  setImpact()      { return unsupported("pf2e: impacts not supported"); },

  /* --- Progress / objectives — no Ironsworn tracks in PF2e --- */
  markProgress()        { return unsupported("pf2e: no progress tracks"); },
  setProgress()         { return unsupported("pf2e: no progress tracks"); },
  createProgressTrack() { return unsupported("pf2e: no progress tracks"); },
  completeTrack()       { return unsupported("pf2e: no progress tracks"); },
  grantXp()             { return unsupported("pf2e: xp grants not supported"); },

  /* --- Moves / actions / oracles — no programmatic engine here --- */
  async triggerMove() { return unsupported("pf2e: no programmatic moves"); },
  rollOracle()        { return null; },

  /* --- Compendium content creation — not supported by this adapter --- */
  async createFoeActor()  { return unsupported("pf2e: foe creation not supported"); },
  async addAssetToActor() { return unsupported("pf2e: asset grants not supported"); },
  async createCharacter() { return unsupported("pf2e: character creation not supported"); }
});

export default Pf2eAdapter;
