/* =====================================================================
 *  THE ETERNAL SKALD — System Adapter Interface (contract)
 *  ---------------------------------------------------------------------
 *  Phase 1 of the multi-system plugin architecture
 *  (see docs/PROPOSAL-multi-system-adapter-architecture.md).
 *
 *  This file defines the CONTRACT a game-system adapter must satisfy so
 *  the Skald can drive any Foundry game system, not just Ironsworn. It is
 *  PURE DOCUMENTATION + CONSTANTS — it contains no game logic, performs no
 *  Foundry writes, and imports nothing system-specific. It is therefore
 *  zero-blast-radius: adding it cannot change any existing behaviour.
 *
 *  An "adapter" is a plain object (or class instance) that the active game
 *  system registers with the registry (see registry.js). The existing
 *  `IronswornController` already satisfies this shape, and the
 *  `NullAdapter` (see null-adapter.js) is the safe no-op fallback used when
 *  no adapter is registered for the active system.
 *
 *  DESIGN PRINCIPLES (mirroring the Ironsworn controller's contract):
 *    1. Reads MUST NOT throw — return null / [] / {} on failure so the AI
 *       context builder can simply omit missing data.
 *    2. Writes MUST be GM-gated, bounds-checked and idempotent, and MUST
 *       return a result object (see makeResult / unsupported below).
 *    3. Every method except the four REQUIRED identity/capability methods
 *       is OPTIONAL. Callers MUST feature-detect (typeof fn === "function")
 *       and/or consult capabilities() before invoking a method.
 * ===================================================================== */

/**
 * Canonical capability keys. An adapter's `capabilities()` returns an object
 * whose keys are drawn from this set with boolean values. Callers gate
 * system-specific features on these flags so a system that lacks a feature
 * (e.g. Nimble has no oracles or progress tracks) silently omits it.
 *
 * Frozen so the key set is itself a stable contract.
 */
export const SYSTEM_CAPABILITIES = Object.freeze({
  systemActive:      "systemActive",      // the adapter's system is the active one
  characterReads:    "characterReads",    // can read stats / meters / sheet
  sheetWrites:       "sheetWrites",        // can write to the character sheet
  progressTracks:    "progressTracks",     // supports progress-track objectives
  vows:              "vows",               // supports Ironsworn-style vows
  oracles:           "oracles",            // supports oracle tables
  momentum:          "momentum",           // has a momentum-style resource
  impacts:           "impacts",            // supports conditions / impacts
  moves:             "moves",              // has named moves / actions
  moveDialogs:       "moveDialogs",        // can open the system's own roll dialog
  xp:                "xp",                 // supports awarding experience
  compendiumFoes:    "compendiumFoes",     // can create foes from compendia
  compendiumAssets:  "compendiumAssets",   // can grant assets/items from compendia
  createCharacter:   "createCharacter",    // can create a player character
  mapVision:         "mapVision"           // map scouting (a core Skald feature)
});

/** The full list of capability keys (stable order). */
export const CAPABILITY_KEYS = Object.freeze(Object.keys(SYSTEM_CAPABILITIES));

/**
 * Build a capability map with every key present and set to `value`
 * (default false). Adapters typically start from this and flip on what
 * they support, guaranteeing every key is always present.
 *
 * @param {boolean} [value=false]
 * @returns {Record<string, boolean>}
 */
export function emptyCapabilities(value = false) {
  const out = {};
  for (const k of CAPABILITY_KEYS) out[k] = !!value;
  return out;
}

/**
 * Standard success/data result helper for adapter WRITE methods.
 * @param {object} [extra] - additional fields to merge into the result.
 * @returns {{ok: true}}
 */
export function makeResult(extra = {}) {
  return Object.assign({ ok: true }, extra || {});
}

/**
 * Standard "this system does not support that operation" result. Used by the
 * NullAdapter and by real adapters for methods that don't apply to them
 * (e.g. Nimble.rollOracle). Never throws; callers treat it as a soft skip.
 * @param {string} [reason]
 * @returns {{ok: false, unsupported: true, error?: string}}
 */
export function unsupported(reason = "") {
  const r = { ok: false, unsupported: true };
  if (reason) r.error = String(reason);
  return r;
}

/**
 * Runtime shape check used by the registry to reject obviously-invalid
 * adapters at registration time. We only require the four identity/capability
 * members; everything else is optional and feature-detected by callers.
 *
 * @param {any} adapter
 * @returns {boolean}
 */
export function isValidAdapter(adapter) {
  if (!adapter || (typeof adapter !== "object" && typeof adapter !== "function")) return false;
  return typeof adapter.isActive === "function"
      && typeof adapter.capabilities === "function";
}

/**
 * @typedef {Object} SystemAdapter
 *
 * --- Identity & capability (REQUIRED) ---
 * @property {string}            id            Foundry game system id (e.g. "foundry-ironsworn" | "nimble").
 * @property {string}            label         Human-readable system label.
 * @property {() => boolean}     isActive      True iff this adapter's system is the active game system.
 * @property {() => Object}      capabilities  Capability map (keys from SYSTEM_CAPABILITIES).
 *
 * --- Character & state reads (OPTIONAL; normalised by the adapter) ---
 * @property {() => (Actor|null)}  [getActiveCharacter]
 * @property {(a: Actor) => Object} [getStats]            // {} when unsupported
 * @property {(a: Actor) => Object} [getMeters]           // { key: { value, max } }
 * @property {(a: Actor) => string} [describeCharacter]   // prompt-ready summary
 *
 * --- Prompt profile (system flavour for the AI; OPTIONAL) ---
 * @property {() => { persona?: string, rulesDigest?: string, moveList?: string,
 *                    terminology?: Object, oracleGuidance?: string }} [getPromptProfile]
 *
 * --- Mechanical writes (OPTIONAL; gated, capability-flagged) ---
 * @property {(a, key, delta) => object} [adjustResource]  // generic meter delta
 * @property {(a, amt) => object}        [applyHarm]
 * @property {(a, amt) => object}        [applyStress]
 * @property {(a, stat, val) => object}  [setStat]
 * @property {(a, cond, on) => object}   [setImpact]
 *
 * --- Progress / objectives (OPTIONAL; progress-track systems only) ---
 * @property {(a, ref, n) => object}     [markProgress]
 * @property {(a, ref, boxes) => object} [setProgress]
 * @property {(a, opts) => object}       [createProgressTrack]
 * @property {(a, ref) => object}        [completeTrack]
 * @property {(a, amt, opts) => object}  [grantXp]
 *
 * --- Moves / actions / oracles (OPTIONAL) ---
 * @property {(ref, opts) => Promise<object>} [triggerMove]
 * @property {(name) => any}                  [rollOracle]   // null when unsupported
 *
 * --- Compendium content creation (OPTIONAL; gated) ---
 * @property {(name, opts) => Promise<object>}    [createFoeActor]
 * @property {(a, name, opts) => Promise<object>} [addAssetToActor]
 * @property {(name, opts) => Promise<object>}    [createCharacter]
 */
