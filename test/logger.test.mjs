/* =====================================================================
 *  Unit tests for the unified levelled logger (M1).
 *
 *  Verifies severity gating, the legacy `debugLogging` backwards-compat
 *  floor, prefix stamping, and the fail-soft contract (never throws when
 *  `game` is absent — as in this Node test runner).
 *
 *  Run: node test/logger.test.mjs
 * ===================================================================== */

import { Logger, LOG_LEVELS, resolveLevel } from "../scripts/core/logger.js";
import { LOG_PREFIX } from "../scripts/core/constants.js";

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

console.log("Logger test\n");

/* --- Capture console output so we can assert what the logger emits. ----- */
const captured = [];
const real = { log: console.log, warn: console.warn, error: console.error };
function startCapture() {
  captured.length = 0;
  console.log   = (...a) => captured.push(["log", a]);
  console.warn  = (...a) => captured.push(["warn", a]);
  console.error = (...a) => captured.push(["error", a]);
}
function stopCapture() { Object.assign(console, real); }

/** Set the fake Foundry settings the logger reads. */
function setSettings({ loggingLevel, debugLogging } = {}) {
  globalThis.game = {
    settings: {
      get: (_mod, key) => {
        if (key === "loggingLevel") return loggingLevel;
        if (key === "debugLogging") return debugLogging;
        return undefined;
      }
    }
  };
}

/** Run the four log methods and return which severities were emitted. */
function emitAll() {
  startCapture();
  Logger.error("E"); Logger.warn("W"); Logger.info("I"); Logger.debug("D");
  stopCapture();
  return captured.map(([, a]) => a[1]); // the message payload after the prefix
}

/* --------------------------------------------------------------------- *
 * [1] Level ordering is the documented off<error<warn<info<debug.
 * --------------------------------------------------------------------- */
eq(LOG_LEVELS.off, 0, "[1] off = 0");
ok(LOG_LEVELS.error < LOG_LEVELS.warn && LOG_LEVELS.warn < LOG_LEVELS.info
   && LOG_LEVELS.info < LOG_LEVELS.debug, "[1] levels strictly increase");

/* --------------------------------------------------------------------- *
 * [2] Fail-soft: with no `game` at all, nothing throws and the level
 *     falls back to the default ("warn").
 * --------------------------------------------------------------------- */
delete globalThis.game;
let threw = false;
try { Logger.debug("x"); Logger.error("y"); } catch (_) { threw = true; }
ok(!threw, "[2] logging never throws when game is undefined");
eq(resolveLevel(), LOG_LEVELS.warn, "[2] default resolved level is warn");

/* --------------------------------------------------------------------- *
 * [3] Default ("warn"): warn + error emitted, info + debug suppressed.
 * --------------------------------------------------------------------- */
setSettings({ loggingLevel: "warn" });
{
  const msgs = emitAll();
  ok(msgs.includes("E"), "[3] error emitted at warn level");
  ok(msgs.includes("W"), "[3] warn emitted at warn level");
  ok(!msgs.includes("I"), "[3] info suppressed at warn level");
  ok(!msgs.includes("D"), "[3] debug suppressed at warn level");
}

/* --------------------------------------------------------------------- *
 * [4] "off" silences all four logger methods.
 * --------------------------------------------------------------------- */
setSettings({ loggingLevel: "off" });
eq(emitAll().length, 0, "[4] nothing emitted when loggingLevel is off");

/* --------------------------------------------------------------------- *
 * [5] "debug" emits everything.
 * --------------------------------------------------------------------- */
setSettings({ loggingLevel: "debug" });
{
  const msgs = emitAll();
  ok(["E", "W", "I", "D"].every((m) => msgs.includes(m)), "[5] all severities emitted at debug level");
}

/* --------------------------------------------------------------------- *
 * [6] Backwards-compat: legacy debugLogging=true forces a debug floor even
 *     when loggingLevel is the quiet default.
 * --------------------------------------------------------------------- */
setSettings({ loggingLevel: "warn", debugLogging: true });
{
  eq(resolveLevel(), LOG_LEVELS.debug, "[6] debugLogging raises the floor to debug");
  const msgs = emitAll();
  ok(msgs.includes("D"), "[6] debug output shown when legacy debugLogging is on");
}

/* --------------------------------------------------------------------- *
 * [7] Unknown / missing level falls back to the default, not silence.
 * --------------------------------------------------------------------- */
setSettings({ loggingLevel: "bogus" });
eq(resolveLevel(), LOG_LEVELS.warn, "[7] unknown level falls back to warn");

/* --------------------------------------------------------------------- *
 * [8] Every emitted line is stamped with LOG_PREFIX as the first argument.
 * --------------------------------------------------------------------- */
setSettings({ loggingLevel: "debug" });
startCapture();
Logger.info("hello");
stopCapture();
ok(captured.length === 1 && captured[0][1][0] === LOG_PREFIX,
   "[8] emitted line starts with LOG_PREFIX");

delete globalThis.game;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
