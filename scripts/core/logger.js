/* ===================================================================== */
/*  §1c  UNIFIED LEVELLED LOGGER  (M1)                                    */
/* ===================================================================== */
/*
 * A single, dependency-light logging facade for The Eternal Skald. It gives
 * every subsystem one consistent, prefix-stamped, severity-gated way to log,
 * replacing ad-hoc `console.log(LOG_PREFIX, ...)` calls scattered across the
 * codebase.
 *
 * Design / safety:
 *   - Imports ONLY from constants.js, so it can be used anywhere without
 *     creating an import cycle (it never imports Settings).
 *   - Reads its level straight from `game.settings` inside a try/catch, so it
 *     NEVER throws at module-load time or in a non-Foundry context (e.g. the
 *     framework-free Node test runner, where `game` is undefined).
 *   - Backwards-compatible: it is purely additive. The long-standing
 *     `debugLogging` world setting still works — when it is ON, debug output
 *     is shown regardless of `loggingLevel`, exactly as before. Existing
 *     per-module helpers (`dbg`, `_dbgLog`, `_debug`) are untouched.
 *
 * Levels (most to least severe), with their numeric weight:
 *   off(0) < error(1) < warn(2) < info(3) < debug(4)
 * A message at level L is emitted only when the resolved level >= L.
 */
import { MODULE_ID, LOG_PREFIX } from "./constants.js";

/** Ordered severity weights. Higher = more verbose. @type {Record<string,number>} */
export const LOG_LEVELS = Object.freeze({ off: 0, error: 1, warn: 2, info: 3, debug: 4 });

/** Default when no setting is readable yet (e.g. before `init`). */
const DEFAULT_LEVEL = "warn";

/** Read a world setting without ever throwing. Returns `undefined` on failure. */
function _safeGet(key) {
  try { return game?.settings?.get?.(MODULE_ID, key); }
  catch (_) { return undefined; }
}

/**
 * Resolve the effective numeric verbosity. Combines the new `loggingLevel`
 * choice with the legacy `debugLogging` boolean so old configs keep working:
 * if `debugLogging` is ON, the floor is `debug` regardless of `loggingLevel`.
 * @returns {number}
 */
export function resolveLevel() {
  const name = _safeGet("loggingLevel");
  let weight = LOG_LEVELS[name] ?? LOG_LEVELS[DEFAULT_LEVEL];
  if (_safeGet("debugLogging") === true) weight = Math.max(weight, LOG_LEVELS.debug);
  return weight;
}

/** Emit `args` via `method` when the resolved level permits `level`. */
function _emit(level, method, args) {
  try {
    if (resolveLevel() >= LOG_LEVELS[level]) console[method](LOG_PREFIX, ...args);
  } catch (_) { /* logging must never break the caller */ }
}

/**
 * The Eternal Skald logger. Use `Logger.info("…")` etc.; pass a short
 * bracketed tag as the first arg for subsystem context, e.g.
 * `Logger.debug("[RAG]", "indexed", n, "entries")`.
 */
export const Logger = Object.freeze({
  error: (...args) => _emit("error", "error", args),
  warn:  (...args) => _emit("warn",  "warn",  args),
  info:  (...args) => _emit("info",  "log",   args),
  debug: (...args) => _emit("debug", "log",   args),
  /** Current effective level name (for diagnostics / `!rag-status`-style output). */
  levelName: () => Object.keys(LOG_LEVELS).find((k) => LOG_LEVELS[k] === resolveLevel()) || DEFAULT_LEVEL
});
