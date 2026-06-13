/* =====================================================================
 *  Adapter migration test for scripts/chat/commands.js  (Phase B / H1c).
 *
 *  Completes the consumer-migration leg begun in Phase 2: the chat command
 *  surface no longer hard-imports IronswornController, but resolves the
 *  active system through getActiveAdapter() and capability-gates every
 *  Ironsworn-specific feature.  This guards:
 *
 *    • !help     — the "Oracles available" line is shown ONLY when the active
 *                  adapter advertises capabilities().oracles (so Nimble / Null
 *                  worlds don't see a misleading oracle list).
 *    • !progress — character + journey-track reads and markProgress route
 *                  through the adapter, behind a capabilities().progressTracks
 *                  guard (graceful "not supported" message otherwise).
 *    • move-declaration interception reads detectMoveDeclaration via the
 *                  adapter (optional-chained; already Integration.active()-gated).
 *
 *  commands.js pulls the full Foundry-coupled module graph at import time, so
 *  this follows the project's "source-text structural guards + a behavioural
 *  model" convention (see error-cards.test.mjs / streaming-autoscroll.test.mjs):
 *  the STRUCTURAL block proves the source was migrated; the BEHAVIOURAL block
 *  replicates the exact gating decisions and verifies them against three
 *  adapter shapes — Ironsworn-like (full), Nimble-like (read-only, no oracles
 *  / no progress tracks) and the Null fallback.
 *
 *  Run: node test/adapter-commands-migration.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CMD = readFileSync(join(ROOT, "scripts", "chat", "commands.js"), "utf8");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

console.log("Adapter migration — chat/commands.js (H1c)\n");

/* ===================================================================== *
 *  [STRUCTURAL]  commands.js is migrated off the hard Ironsworn import.
 * ===================================================================== */
console.log("[STRUCTURAL] commands.js routes through getActiveAdapter()");

ok(/import\s*\{\s*getActiveAdapter\s*\}\s*from\s*["']\.\.\/systems\/registry\.js["']/.test(CMD),
   "[S1] imports getActiveAdapter from the system registry");
ok(!/import\s*\{[^}]*IronswornController[^}]*\}\s*from/.test(CMD),
   "[S2] no longer imports IronswornController");
ok(!/IronswornController\./.test(CMD),
   "[S3] no direct IronswornController.<method> references remain");

// !help — oracle list capability-gated.
ok(/getActiveAdapter\(\)\.capabilities\?\.\(\)\.oracles/.test(CMD),
   "[S4] !help gates the oracle list on capabilities().oracles");
ok(/IronswornData\.oracles/.test(CMD),
   "[S5] the static oracle key list (IronswornData.oracles) is still the data source inside that gate");

// !progress — progressTracks capability gate + adapter-routed reads/writes.
ok(/capabilities\?\.\(\)\.progressTracks/.test(CMD),
   "[S6] !progress guards on capabilities().progressTracks");
ok(/const\s+adapter\s*=\s*getActiveAdapter\(\)/.test(CMD),
   "[S7] !progress resolves the active adapter");
for (const m of ["getActiveCharacter", "getProgressTracks", "findTrackFuzzy",
                 "_newestOpenTrackItem", "markProgress"]) {
  ok(new RegExp(`adapter\\.${m}\\b`).test(CMD),
     `[S8] !progress calls adapter.${m}() (was IronswornController.${m})`);
}

// move-declaration interception via the adapter (optional-chained).
ok(/getActiveAdapter\(\)\.detectMoveDeclaration\?\./.test(CMD),
   "[S9] move-declaration interception reads detectMoveDeclaration via the adapter");

/* ===================================================================== *
 *  [BEHAVIOURAL]  Replicate the exact gating decisions the migrated code
 *  makes, and verify them against three adapter shapes.
 * ===================================================================== */
console.log("\n[BEHAVIOURAL] gating decisions across adapter shapes");

const FAKE_CHAR = { id: "char-1", name: "Sigrún" };

/* Ironsworn-like: full capabilities + every method the command surface uses. */
const ironswornLike = {
  id: "foundry-ironsworn", label: "Ironsworn (fake)",
  isActive() { return true; },
  capabilities() { return { oracles: true, progressTracks: true }; },
  getActiveCharacter() { return FAKE_CHAR; },
  getProgressTracks() { return [{ id: "t1", name: "Journey to Ironhome", kind: "journey", boxes: 2, completed: false }]; },
  findTrackFuzzy(_a, name) { return name ? { id: "t1", name: "Journey to Ironhome", system: { completed: false } } : null; },
  _newestOpenTrackItem() { return { id: "t1", name: "Journey to Ironhome" }; },
  async markProgress() { return { ok: true, track: "Journey to Ironhome", boxes: 4 }; },
  detectMoveDeclaration(args) { return /strike/i.test(args) ? { move: { name: "Strike" }, stat: "iron", confidence: 0.9 } : null; }
};

/* Nimble-like: active, read-only — NO oracles, NO progress tracks. */
const nimbleLike = {
  id: "nimble", label: "Nimble (fake)",
  isActive() { return true; },
  capabilities() { return { oracles: false, progressTracks: false }; },
  getActiveCharacter() { return FAKE_CHAR; }
  // no progress/oracle/move methods at all
};

/* Null-like: the safe fallback — inactive, everything off, no system methods. */
const nullLike = {
  id: "null", label: "No System",
  isActive() { return false; },
  capabilities() { return { oracles: false, progressTracks: false }; }
};

/* ---- Decision replicas (mirror commands.js exactly) ------------------ */

// !help oracle line  (commands.js: getActiveAdapter().capabilities?.().oracles)
function helpShowsOracleLine(adapter) {
  try { return !!adapter.capabilities?.().oracles; } catch (_) { return false; }
}

// !progress guard  (commands.js: if (!adapter.capabilities?.().progressTracks) → unsupported)
function progressSupported(adapter) {
  return !!adapter.capabilities?.().progressTracks;
}

// !progress happy path resolution (name-targeted → fuzzy; else newest open).
async function progressMark(adapter, nameFilter) {
  if (!progressSupported(adapter)) return { ok: false, reason: "unsupported" };
  const actor = adapter.getActiveCharacter();
  if (!actor) return { ok: false, reason: "no-character" };
  let track = null;
  try {
    if (nameFilter) {
      const match = adapter.findTrackFuzzy(actor, nameFilter, "journey");
      if (match && !match?.system?.completed) track = match;
    }
    if (!track && !nameFilter) track = adapter._newestOpenTrackItem(actor, "journey");
  } catch (_) { /* fall through */ }
  if (!track) return { ok: false, reason: "no-track" };
  const res = await adapter.markProgress(actor, track.id, 4);
  return res?.ok ? { ok: true, track: res.track, boxes: res.boxes } : { ok: false, reason: "mark-failed" };
}

// move interception  (commands.js: getActiveAdapter().detectMoveDeclaration?.(args))
function detectMove(adapter, args) {
  return adapter.detectMoveDeclaration?.(args) ?? null;
}

/* ---- Ironsworn-like → full behaviour --------------------------------- */
console.log("  • Ironsworn-like adapter");
ok(helpShowsOracleLine(ironswornLike), "[B1] !help shows the oracle line for Ironsworn");
ok(progressSupported(ironswornLike), "[B2] !progress is supported for Ironsworn");
{
  const r = await progressMark(ironswornLike, "Ironhome");
  ok(r.ok && r.track === "Journey to Ironhome" && r.boxes === 4,
     "[B3] !progress marks the fuzzy-matched journey via the adapter");
  const r2 = await progressMark(ironswornLike, "");
  ok(r2.ok, "[B4] !progress falls back to the newest open journey when no name is given");
  const d = detectMove(ironswornLike, "!Strike +iron");
  ok(d?.move?.name === "Strike", "[B5] move declaration detected via the adapter");
}

/* ---- Nimble-like → read-only degradation ----------------------------- */
console.log("  • Nimble-like adapter (read-only)");
ok(!helpShowsOracleLine(nimbleLike), "[B6] !help hides the oracle line for Nimble (no oracles capability)");
{
  const r = await progressMark(nimbleLike, "anything");
  ok(!r.ok && r.reason === "unsupported",
     "[B7] !progress returns 'not supported' for Nimble (no progressTracks) without throwing");
  const d = detectMove(nimbleLike, "!Strike");
  eq(d, null, "[B8] move interception is a no-op for Nimble (no detectMoveDeclaration) — optional chaining, no throw");
}

/* ---- Null-like → safe fallback --------------------------------------- */
console.log("  • Null fallback adapter");
ok(!helpShowsOracleLine(nullLike), "[B9] !help hides the oracle line under the Null fallback");
{
  const r = await progressMark(nullLike, "");
  ok(!r.ok && r.reason === "unsupported",
     "[B10] !progress degrades to 'not supported' under the Null fallback (no throw)");
  const d = detectMove(nullLike, "!Strike");
  eq(d, null, "[B11] move interception is a no-op under the Null fallback");
}

/* ---- defensive: a totally empty object must not throw the gates ------ */
console.log("  • malformed adapter (defensive)");
ok(helpShowsOracleLine({}) === false, "[B12] oracle gate is false (not a throw) for an adapter with no capabilities()");
ok(progressSupported({}) === false, "[B13] progress gate is false for an adapter with no capabilities()");

/* ===================================================================== */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
