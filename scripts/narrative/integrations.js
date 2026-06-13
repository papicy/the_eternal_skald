/* =====================================================================
 *  THIRD-PARTY INTEGRATIONS  (v0.22.0, Phase E — §6.2)
 *
 *  Soft, feature-detected interop with sibling Foundry modules. Every probe
 *  is fail-soft: if the other module is absent, disabled, or exposes a
 *  different API shape, the helper returns false / null and the Skald carries
 *  on exactly as before. No module here is a hard dependency, none is declared
 *  in module.json, and nothing throws.
 *
 *  Layering: narrative/ glue. Reads only live runtime globals (game.modules,
 *  SimpleCalendar) at call time and imports nothing from the project, so it
 *  introduces no import cycle and can be consumed from any layer.
 *
 *  Covered modules:
 *    • Monk's Enhanced Journals — detection only (callers may prefer its
 *      journal types when present; chronicle still falls back to core journals).
 *    • Dice So Nice! — detection only. Skald move/oracle rolls already flow
 *      through the system's own Roll pipeline, which DSN animates automatically;
 *      no extra wiring is required, this just lets callers report capability.
 *    • Simple Calendar — read the current in-game date/time for stamping
 *      chronicle timeline events (additive, optional field).
 * ===================================================================== */

const SC_MODULE_ID = "foundryvtt-simple-calendar";
const MEJ_MODULE_ID = "monks-enhanced-journals";
const DSN_MODULE_ID = "dice-so-nice";

/** True when a module is installed AND active. Fail-soft. */
export function moduleActive(id) {
  try {
    return typeof game !== "undefined"
      && game?.modules?.get?.(id)?.active === true;
  } catch (_) {
    return false;
  }
}

/** Monk's Enhanced Journals present and active? */
export function hasMonksEnhancedJournal() {
  return moduleActive(MEJ_MODULE_ID);
}

/** Dice So Nice! present and active? */
export function hasDiceSoNice() {
  return moduleActive(DSN_MODULE_ID);
}

/**
 * Simple Calendar present, active, AND exposing the display API we use.
 * The stricter API check (not just module-active) means a future Simple
 * Calendar that drops/renames the method degrades to "absent" rather than
 * throwing.
 */
export function hasSimpleCalendar() {
  if (!moduleActive(SC_MODULE_ID)) return false;
  try {
    return typeof SimpleCalendar !== "undefined"
      && typeof SimpleCalendar?.api?.currentDateTimeDisplay === "function";
  } catch (_) {
    return false;
  }
}

/**
 * Format a Simple Calendar DateDisplayData object into a single display
 * string (e.g. "Saturday, June 13, 2026 12:00"). PURE — accepts the object
 * so it can be unit-tested without the live API.
 *
 * @param {object|null} display - a SimpleCalendar DateDisplayData-like object
 * @returns {string|null}
 */
export function formatInGameDate(display) {
  if (!display || typeof display !== "object") return null;
  const date = typeof display.date === "string" ? display.date.trim() : "";
  const time = typeof display.time === "string" ? display.time.trim() : "";
  const out = [date, time].filter(Boolean).join(" ").trim();
  return out || null;
}

/**
 * Current in-game date/time as a display string, or null when Simple Calendar
 * is unavailable. Fail-soft — never throws into the caller's path.
 *
 * @returns {string|null}
 */
export function getInGameDate() {
  if (!hasSimpleCalendar()) return null;
  try {
    return formatInGameDate(SimpleCalendar.api.currentDateTimeDisplay());
  } catch (_) {
    return null;
  }
}

export const Integrations = {
  moduleActive,
  hasMonksEnhancedJournal,
  hasDiceSoNice,
  hasSimpleCalendar,
  formatInGameDate,
  getInGameDate
};
