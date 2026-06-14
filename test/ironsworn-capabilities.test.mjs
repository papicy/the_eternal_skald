/* =====================================================================
 *  IRONSWORN CAPABILITIES guard — the adapter capability contract.
 *
 *  Regression lock for the "progress tracking is not supported" /
 *  "tracks never complete" bug class. The Ironsworn controller IS the
 *  registered `foundry-ironsworn` system adapter, so its capabilities()
 *  MUST return the canonical SYSTEM_CAPABILITIES-shaped map (boolean keys),
 *  not the old diagnostic object. If it doesn't advertise progressTracks /
 *  moves / oracles, the AI tool registry filters those tools out and the
 *  !progress command refuses to run.
 *
 *  This test:
 *    • imports the REAL shipped MechanicsMethods.capabilities() and calls it
 *      with a Foundry-free stub `this` (the method only touches this.* shims);
 *    • asserts every canonical key from SYSTEM_CAPABILITIES is present and
 *      that the progress/move/oracle mechanics are ON;
 *    • verifies the legacy diagnostic fields are retained (backwards-compat);
 *    • feeds the live caps into the REAL buildToolSpecs() and asserts the
 *      capability-gated tools (updateProgress / rollMove / queryOracle) are
 *      actually offered to the model.
 *
 *  Run: node test/ironsworn-capabilities.test.mjs
 * ===================================================================== */

import { MechanicsMethods } from "../scripts/ironsworn/mechanics.js";
import { SYSTEM_CAPABILITIES, CAPABILITY_KEYS } from "../scripts/systems/adapter-interface.js";
import { buildToolSpecs } from "../scripts/ai/tools/registry.js";

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

/* A Foundry-free `this` for capabilities(): it only calls these four shims. */
const stub = {
  isActive: () => true,
  hasPrerollDialog: () => false,
  api: () => null,
  getActiveCharacter: () => null
};
const caps = MechanicsMethods.capabilities.call(stub);

/* ---------------- canonical shape ---------------- */
ok(caps && typeof caps === "object", "capabilities() returns an object");
for (const key of CAPABILITY_KEYS) {
  ok(key in caps, `canonical key present: ${key}`);
  eq(typeof caps[key], "boolean", `canonical key is boolean: ${key}`);
}

/* ---------------- the bug-class flags MUST be ON ---------------- */
eq(caps.progressTracks, true, "progressTracks ON (fixes !progress + updateProgress)");
eq(caps.moves, true, "moves ON");
eq(caps.oracles, true, "oracles ON");
eq(caps.vows, true, "vows ON");
eq(caps.xp, true, "xp ON");
eq(caps.sheetWrites, true, "sheetWrites ON");
eq(caps.characterReads, true, "characterReads ON");
eq(caps.mapVision, true, "mapVision ON");
eq(caps.systemActive, true, "systemActive reflects isActive() (true here)");

/* systemActive must track isActive() — false when the system is inactive. */
const inactiveCaps = MechanicsMethods.capabilities.call({ ...stub, isActive: () => false });
eq(inactiveCaps.systemActive, false, "systemActive false when system inactive");
eq(inactiveCaps.progressTracks, true, "static feature flags stay ON regardless of activeness");

/* ---------------- legacy diagnostic fields retained (backwards-compat) ---- */
ok("prerollDialog" in caps, "legacy field retained: prerollDialog");
ok("characterSheet" in caps, "legacy field retained: characterSheet");
ok("activeCharacter" in caps, "legacy field retained: activeCharacter");

/* ---------------- end-to-end: tool gating now offers the tools ----------- */
const specs = buildToolSpecs(caps);
const names = specs.map(s => s.function?.name);
ok(names.includes("updateProgress"), "updateProgress tool offered with Ironsworn caps");
ok(names.includes("rollMove"), "rollMove tool offered with Ironsworn caps");
ok(names.includes("queryOracle"), "queryOracle tool offered with Ironsworn caps");
ok(names.includes("createJournalEntry"), "always-on journal tool still offered");

/* Sanity: keys we asserted are real members of the frozen contract. */
ok(Object.isFrozen(SYSTEM_CAPABILITIES), "SYSTEM_CAPABILITIES is frozen (stable contract)");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
