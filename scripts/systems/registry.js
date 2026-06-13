/* =====================================================================
 *  THE ETERNAL SKALD — System Adapter Registry
 *  ---------------------------------------------------------------------
 *  Phase 1 of the multi-system plugin architecture
 *  (see docs/PROPOSAL-multi-system-adapter-architecture.md).
 *
 *  The registry is the single resolution point that lets the Skald drive
 *  ANY Foundry game system through a uniform SystemAdapter contract
 *  (adapter-interface.js). Systems register an adapter keyed by their
 *  Foundry `game.system.id`; consumers call `getActiveAdapter()` to get the
 *  adapter for the currently-active system, or the safe `NullAdapter`
 *  fallback when none is registered.
 *
 *  IMPORTANT (zero blast radius): in Phase 1 NOTHING in the existing code
 *  paths consumes this registry yet. Registering the Ironsworn controller
 *  merely stores a reference; until a later phase migrates a consumer to
 *  `getActiveAdapter()`, existing Ironsworn behaviour is byte-for-byte
 *  unchanged. The registry is PURE RESOLUTION — it contains no game logic
 *  and performs no Foundry writes.
 * ===================================================================== */

import { LOG_PREFIX } from "../core/constants.js";
import { isValidAdapter } from "./adapter-interface.js";
import { NullAdapter } from "./null-adapter.js";

/** id (string) → adapter. Module-private. */
const _adapters = new Map();

/** Read the active Foundry game system id, defensively. */
function _activeSystemId() {
  try {
    return (typeof game !== "undefined" && game?.system?.id)
      ? String(game.system.id)
      : "";
  } catch (_) {
    return "";
  }
}

export const SystemRegistry = {
  /**
   * Register a system adapter under a Foundry system id. Idempotent: a
   * second registration for the same id replaces the first (with a warning),
   * so re-running the ready hook cannot corrupt the table.
   *
   * @param {string} systemId - the Foundry `game.system.id` this adapter serves.
   * @param {import("./adapter-interface.js").SystemAdapter} adapter
   * @returns {boolean} true if registered, false if rejected.
   */
  register(systemId, adapter) {
    try {
      const id = String(systemId || "").trim();
      if (!id) {
        console.warn(LOG_PREFIX, "SystemRegistry.register: empty system id — ignored.");
        return false;
      }
      if (!isValidAdapter(adapter)) {
        console.warn(LOG_PREFIX, `SystemRegistry.register: adapter for "${id}" does not satisfy the SystemAdapter contract — ignored.`);
        return false;
      }
      if (_adapters.has(id)) {
        console.warn(LOG_PREFIX, `SystemRegistry.register: replacing existing adapter for "${id}".`);
      }
      _adapters.set(id, adapter);
      return true;
    } catch (e) {
      console.warn(LOG_PREFIX, "SystemRegistry.register failed:", e?.message ?? e);
      return false;
    }
  },

  /**
   * Get the adapter registered for a specific system id, or null if none.
   * @param {string} systemId
   * @returns {import("./adapter-interface.js").SystemAdapter|null}
   */
  get(systemId) {
    try {
      return _adapters.get(String(systemId || "").trim()) ?? null;
    } catch (_) {
      return null;
    }
  },

  /** True iff an adapter is registered for the given system id. */
  has(systemId) {
    try {
      return _adapters.has(String(systemId || "").trim());
    } catch (_) {
      return false;
    }
  },

  /**
   * Resolve the adapter for the CURRENTLY-ACTIVE game system. Never returns
   * null — when no adapter is registered for the active system (or no system
   * is active), the safe `NullAdapter` is returned so callers can always
   * call the contract methods without a null check.
   *
   * @returns {import("./adapter-interface.js").SystemAdapter}
   */
  getActive() {
    try {
      const id = _activeSystemId();
      if (id && _adapters.has(id)) return _adapters.get(id);
    } catch (_) { /* fall through to NullAdapter */ }
    return NullAdapter;
  },

  /** List the registered system ids (for diagnostics). */
  list() {
    try {
      return Array.from(_adapters.keys());
    } catch (_) {
      return [];
    }
  },

  /**
   * Remove a registered adapter (primarily for tests). No-op if absent.
   * @param {string} systemId
   * @returns {boolean} true if something was removed.
   */
  unregister(systemId) {
    try {
      return _adapters.delete(String(systemId || "").trim());
    } catch (_) {
      return false;
    }
  }
};

/* ---------------------------------------------------------------------
 *  Convenience free functions (the names used throughout the proposal).
 *  These delegate to SystemRegistry so call-sites stay terse.
 * ------------------------------------------------------------------- */

/**
 * Register a system adapter. @see SystemRegistry.register
 * @param {string} systemId
 * @param {import("./adapter-interface.js").SystemAdapter} adapter
 * @returns {boolean}
 */
export function registerSystem(systemId, adapter) {
  return SystemRegistry.register(systemId, adapter);
}

/**
 * Get the adapter for the active game system (or the NullAdapter fallback).
 * @returns {import("./adapter-interface.js").SystemAdapter}
 */
export function getActiveAdapter() {
  return SystemRegistry.getActive();
}

/**
 * Get the adapter registered for a specific system id, or null.
 * @param {string} systemId
 * @returns {import("./adapter-interface.js").SystemAdapter|null}
 */
export function getAdapter(systemId) {
  return SystemRegistry.get(systemId);
}

export default SystemRegistry;
