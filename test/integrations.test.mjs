/* =====================================================================
 *  Third-party integrations (Phase E — §6.2) guard.
 *
 *  Covers the fail-soft feature-detection helpers in
 *  narrative/integrations.js: moduleActive (active vs inactive vs absent),
 *  hasSimpleCalendar (module-active AND API-shape check), formatInGameDate
 *  (PURE display formatting), and getInGameDate (reads the live API, fail-soft).
 *
 *  The module imports nothing from the project (only call-time global probes),
 *  so it can be imported statically; we still stub the Foundry-ish globals it
 *  reads (game / SimpleCalendar) and reassign them per scenario.
 *
 *  Run: node test/integrations.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const {
  moduleActive, hasMonksEnhancedJournal, hasDiceSoNice,
  hasSimpleCalendar, formatInGameDate, getInGameDate, Integrations
} = await import("../scripts/narrative/integrations.js");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }

const SRC = readFileSync(
  fileURLToPath(new URL("../scripts/narrative/integrations.js", import.meta.url)), "utf8");

/* ---- [1] structural / layering guards (this module only) -------------- */
ok(/export function getInGameDate\s*\(/.test(SRC), "[1] getInGameDate exported");
ok(!/^import /m.test(SRC), "[1] imports nothing from the project (no cycle)");
ok(!/\.create\(|\.update\(|setFlag|client\.chat|fetch\(/.test(SRC),
   "[1] no Foundry writes / AI / network calls");
ok(typeof Integrations === "object" && typeof Integrations.getInGameDate === "function",
   "[1] Integrations surface exposes getInGameDate");

/* ---- [2] moduleActive -------------------------------------------------- */
delete globalThis.game;
ok(moduleActive("anything") === false, "[2] no game global -> false (fail-soft)");
globalThis.game = { modules: { get: (id) => id === "on" ? { active: true } : { active: false } } };
ok(moduleActive("on") === true, "[2] active module -> true");
ok(moduleActive("off") === false, "[2] inactive module -> false");
globalThis.game = { modules: { get: () => undefined } };
ok(moduleActive("missing") === false, "[2] absent module -> false");

/* ---- [3] hasSimpleCalendar (module-active AND API shape) --------------- */
globalThis.game = { modules: { get: (id) => ({ active: id === "foundryvtt-simple-calendar" }) } };
delete globalThis.SimpleCalendar;
ok(hasSimpleCalendar() === false, "[3] active but no SimpleCalendar global -> false");
globalThis.SimpleCalendar = { api: {} };
ok(hasSimpleCalendar() === false, "[3] API present but no currentDateTimeDisplay -> false");
globalThis.SimpleCalendar = { api: { currentDateTimeDisplay: () => ({ date: "June 13, 2026", time: "12:00" }) } };
ok(hasSimpleCalendar() === true, "[3] active + correct API shape -> true");
globalThis.game = { modules: { get: () => ({ active: false }) } };
ok(hasSimpleCalendar() === false, "[3] API present but module inactive -> false");

/* ---- [4] formatInGameDate (PURE) -------------------------------------- */
ok(formatInGameDate(null) === null, "[4] null -> null");
ok(formatInGameDate("x") === null, "[4] non-object -> null");
ok(formatInGameDate({}) === null, "[4] empty object -> null");
ok(formatInGameDate({ date: "June 13, 2026", time: "12:00" }) === "June 13, 2026 12:00",
   "[4] date + time joined");
ok(formatInGameDate({ date: "June 13, 2026" }) === "June 13, 2026", "[4] date only");
ok(formatInGameDate({ time: "12:00" }) === "12:00", "[4] time only");
ok(formatInGameDate({ date: "  ", time: "  " }) === null, "[4] whitespace-only -> null");

/* ---- [5] getInGameDate (live API, fail-soft) -------------------------- */
globalThis.game = { modules: { get: () => ({ active: true }) } };
globalThis.SimpleCalendar = { api: { currentDateTimeDisplay: () => ({ date: "Day 1", time: "06:30" }) } };
ok(getInGameDate() === "Day 1 06:30", "[5] returns formatted in-game date when available");
globalThis.SimpleCalendar = { api: { currentDateTimeDisplay: () => { throw new Error("boom"); } } };
ok(getInGameDate() === null, "[5] API throwing -> null (fail-soft)");
delete globalThis.SimpleCalendar;
ok(getInGameDate() === null, "[5] no Simple Calendar -> null");

/* ---- [6] MEJ / DSN detection ------------------------------------------ */
globalThis.game = { modules: { get: (id) => ({ active: id === "monks-enhanced-journals" }) } };
ok(hasMonksEnhancedJournal() === true && hasDiceSoNice() === false, "[6] MEJ active, DSN inactive");
globalThis.game = { modules: { get: (id) => ({ active: id === "dice-so-nice" }) } };
ok(hasDiceSoNice() === true && hasMonksEnhancedJournal() === false, "[6] DSN active, MEJ inactive");

delete globalThis.game;
delete globalThis.SimpleCalendar;

console.log(`integrations.test.mjs: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
