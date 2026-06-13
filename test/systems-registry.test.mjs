/* =====================================================================
 *  System adapter registry test (Phase 1, multi-system architecture).
 *
 *  Validates the zero-blast-radius foundation:
 *    • adapter-interface.js — capability + result helpers, validity check.
 *    • null-adapter.js       — safe no-op fallback (reads empty, writes
 *                              "unsupported", capabilities OFF except mapVision).
 *    • registry.js           — register / get / has / list / unregister, and
 *                              getActiveAdapter() resolution incl. NullAdapter
 *                              fallback when no adapter matches the active system.
 *
 *  Run: node test/systems-registry.test.mjs
 *  (Pure logic — needs no Foundry globals; the active-system path is exercised
 *   by stubbing globalThis.game, which the registry reads defensively.)
 * ===================================================================== */

import {
  SYSTEM_CAPABILITIES, CAPABILITY_KEYS, emptyCapabilities,
  makeResult, unsupported, isValidAdapter
} from "../scripts/systems/adapter-interface.js";
import { NullAdapter } from "../scripts/systems/null-adapter.js";
import {
  SystemRegistry, registerSystem, getActiveAdapter, getAdapter
} from "../scripts/systems/registry.js";

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

/* ------------------------------------------------------------------ */
console.log("[1] adapter-interface helpers");
{
  ok(Object.isFrozen(SYSTEM_CAPABILITIES), "SYSTEM_CAPABILITIES is frozen");
  ok(CAPABILITY_KEYS.includes("mapVision"), "CAPABILITY_KEYS includes mapVision");
  ok(CAPABILITY_KEYS.includes("oracles"), "CAPABILITY_KEYS includes oracles");

  const caps = emptyCapabilities();
  eq(Object.keys(caps).length, CAPABILITY_KEYS.length, "emptyCapabilities has every key");
  ok(Object.values(caps).every(v => v === false), "emptyCapabilities are all false by default");
  ok(Object.values(emptyCapabilities(true)).every(v => v === true), "emptyCapabilities(true) are all true");

  const good = makeResult({ amount: 3 });
  ok(good.ok === true && good.amount === 3, "makeResult merges extra fields with ok:true");

  const bad = unsupported("nope");
  ok(bad.ok === false && bad.unsupported === true && bad.error === "nope", "unsupported() shape correct");
  ok(unsupported().error === undefined, "unsupported() omits error when no reason");

  ok(isValidAdapter({ isActive() {}, capabilities() {} }), "isValidAdapter accepts a minimal valid adapter");
  ok(!isValidAdapter({ isActive() {} }), "isValidAdapter rejects missing capabilities()");
  ok(!isValidAdapter(null), "isValidAdapter rejects null");
  ok(!isValidAdapter({}), "isValidAdapter rejects an empty object");
}

/* ------------------------------------------------------------------ */
console.log("[2] NullAdapter is a safe no-op");
{
  ok(NullAdapter.isActive() === false, "NullAdapter.isActive() is false");
  const caps = NullAdapter.capabilities();
  eq(caps.mapVision, true, "NullAdapter exposes mapVision (core feature) ON");
  ok(CAPABILITY_KEYS.filter(k => k !== "mapVision").every(k => caps[k] === false),
     "NullAdapter has every non-mapVision capability OFF");

  ok(NullAdapter.getActiveCharacter() === null, "getActiveCharacter() returns null");
  eq(Object.keys(NullAdapter.getStats()).length, 0, "getStats() returns {}");
  eq(Object.keys(NullAdapter.getMeters()).length, 0, "getMeters() returns {}");
  eq(NullAdapter.describeCharacter(), "", "describeCharacter() returns empty string");
  ok(NullAdapter.rollOracle("x") === null, "rollOracle() returns null");

  ok(NullAdapter.applyHarm(null, 1).unsupported === true, "applyHarm() is unsupported");
  ok(NullAdapter.markProgress(null, "v", 1).unsupported === true, "markProgress() is unsupported");
  ok(NullAdapter.grantXp(null, 1).unsupported === true, "grantXp() is unsupported");
  ok((await NullAdapter.triggerMove("m")).unsupported === true, "triggerMove() is unsupported");
  ok((await NullAdapter.createFoeActor("x")).unsupported === true, "createFoeActor() is unsupported");
  ok(Object.isFrozen(NullAdapter), "NullAdapter is frozen");
}

/* ------------------------------------------------------------------ */
console.log("[3] registry: register / get / has / list / unregister");
{
  // Clean slate for any ids this test touches.
  SystemRegistry.unregister("test-sys");
  SystemRegistry.unregister("foundry-ironsworn");

  const fake = { id: "test-sys", label: "Test", isActive() { return false; }, capabilities() { return emptyCapabilities(); } };

  ok(registerSystem("test-sys", fake) === true, "registerSystem accepts a valid adapter");
  ok(SystemRegistry.has("test-sys"), "has() reports the registered id");
  ok(getAdapter("test-sys") === fake, "getAdapter() returns the exact registered object");
  ok(SystemRegistry.list().includes("test-sys"), "list() includes the registered id");

  ok(registerSystem("", fake) === false, "registerSystem rejects an empty id");
  ok(registerSystem("bad-sys", { nope: true }) === false, "registerSystem rejects an invalid adapter");
  ok(getAdapter("bad-sys") === null, "getAdapter() returns null for an unregistered id");

  ok(SystemRegistry.unregister("test-sys") === true, "unregister() removes the adapter");
  ok(!SystemRegistry.has("test-sys"), "has() is false after unregister");
}

/* ------------------------------------------------------------------ */
console.log("[4] getActiveAdapter(): resolution + NullAdapter fallback");
{
  const hadGame = Object.prototype.hasOwnProperty.call(globalThis, "game");
  const savedGame = globalThis.game;

  // (a) No active system → NullAdapter.
  delete globalThis.game;
  ok(getActiveAdapter() === NullAdapter, "no game global → getActiveAdapter() is NullAdapter");

  // (b) Active system with NO registered adapter → NullAdapter.
  globalThis.game = { system: { id: "some-unknown-system" } };
  ok(getActiveAdapter() === NullAdapter, "unmatched system → getActiveAdapter() is NullAdapter");

  // (c) Active system WITH a registered adapter → that adapter.
  const iron = { id: "foundry-ironsworn", label: "Ironsworn", isActive() { return true; }, capabilities() { return emptyCapabilities(); } };
  registerSystem("foundry-ironsworn", iron);
  globalThis.game = { system: { id: "foundry-ironsworn" } };
  ok(getActiveAdapter() === iron, "matching system → getActiveAdapter() returns the registered adapter");

  // Cleanup global + registry mutation.
  SystemRegistry.unregister("foundry-ironsworn");
  if (hadGame) globalThis.game = savedGame; else delete globalThis.game;
}

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
