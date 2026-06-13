/* =====================================================================
 *  THE ETERNAL SKALD — Null System Adapter (safe no-op fallback)
 *  ---------------------------------------------------------------------
 *  Phase 1 of the multi-system plugin architecture
 *  (see docs/PROPOSAL-multi-system-adapter-architecture.md).
 *
 *  The NullAdapter is what the registry returns when NO adapter is
 *  registered for the active game system (or no system is active at all).
 *  It implements the SystemAdapter contract (adapter-interface.js) with
 *  every method a SAFE no-op:
 *    • reads return null / [] / {} (never throw),
 *    • writes return an "unsupported" result,
 *    • capabilities() reports everything OFF except mapVision (a core,
 *      system-independent Skald feature).
 *
 *  This is precisely what preserves the Skald's long-standing "works
 *  standalone in any system" promise: the agnostic core (chronicle, RAG
 *  memory, map vision, narration) keeps running, while system-specific
 *  mechanics simply no-op. It imports nothing system-specific and performs
 *  no Foundry writes — zero blast radius.
 * ===================================================================== */

import { emptyCapabilities, unsupported } from "./adapter-interface.js";

/**
 * The shared, frozen no-op adapter. Stateless, so a single instance is safe
 * to share. All write methods funnel through `unsupported()`.
 *
 * @type {import("./adapter-interface.js").SystemAdapter}
 */
export const NullAdapter = Object.freeze({
  id: "",
  label: "(no system adapter)",

  /* --- Identity & capability (REQUIRED) --- */

  /** The null adapter is never the "active" system in a meaningful sense. */
  isActive() { return false; },

  /**
   * Everything OFF except mapVision — map scouting works without any game
   * system, so it stays available even on an unsupported system.
   */
  capabilities() {
    const caps = emptyCapabilities(false);
    caps.mapVision = true;
    return caps;
  },

  /* --- Character & state reads — always empty, never throw --- */
  getActiveCharacter() { return null; },
  getStats()           { return {}; },
  getMeters()          { return {}; },
  describeCharacter()  { return ""; },

  /* --- Prompt profile — a generic, system-neutral GM persona --- */
  getPromptProfile() {
    return {
      persona: "",      // the prompt builder's existing default persona is kept
      rulesDigest: "",  // no system-specific rules to inject
      moveList: ""      // no moves to advertise
    };
  },

  /* --- Mechanical writes — all unsupported --- */
  adjustResource() { return unsupported("no system adapter"); },
  applyHarm()      { return unsupported("no system adapter"); },
  applyStress()    { return unsupported("no system adapter"); },
  setStat()        { return unsupported("no system adapter"); },
  setImpact()      { return unsupported("no system adapter"); },

  /* --- Progress / objectives — all unsupported --- */
  markProgress()        { return unsupported("no system adapter"); },
  setProgress()         { return unsupported("no system adapter"); },
  createProgressTrack() { return unsupported("no system adapter"); },
  completeTrack()       { return unsupported("no system adapter"); },
  grantXp()             { return unsupported("no system adapter"); },

  /* --- Moves / actions / oracles --- */
  async triggerMove() { return unsupported("no system adapter"); },
  rollOracle()        { return null; },

  /* --- Compendium content creation — all unsupported --- */
  async createFoeActor()  { return unsupported("no system adapter"); },
  async addAssetToActor() { return unsupported("no system adapter"); },
  async createCharacter() { return unsupported("no system adapter"); }
});

export default NullAdapter;
