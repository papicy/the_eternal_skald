/* =====================================================================
 *  THE ETERNAL SKALD — Ironsworn controller submodule
 *  Meters, stats & impacts (momentum / supply / harm / stress / debilities).
 *
 *  Extracted verbatim from the former monolithic ironsworn-controller.js
 *  (Phase B / H2 decomposition). These methods are composed onto the single
 *  IronswornController facade via Object.assign in ironsworn-controller.js,
 *  so `this` inside every method still resolves to that one shared object —
 *  cross-method calls (this.getActiveCharacter(), this._foeIndexCache, …)
 *  and shared cache state are unchanged. No behaviour change.
 * ===================================================================== */

import {
  dbg, warn, STAT_KEYS, METER_KEYS, DEBILITY_KEYS, canonicalImpactKey
} from "./internals.js";

export const MetersMethods = {


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
