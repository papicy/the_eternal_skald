/* =====================================================================
 *  Adapter leaf-consumer migration test for The Eternal Skald.
 *
 *  Phase 2 of the multi-system plugin architecture
 *  (see docs/PROPOSAL-multi-system-adapter-architecture.md).
 *
 *  Guards the migration of two LEAF consumers off their hard Ironsworn
 *  import and onto the system-adapter registry (getActiveAdapter()):
 *
 *    • scripts/ai/prompt-builder.js
 *        – buildFoeGuidance()           → adapter.getCompendiumFoeNames()
 *        – buildCompendiumContextBlock()→ adapter.getCompendiumContextNames()
 *    • scripts/chronicle/entity-linking.js
 *        – EntityLinker._build() move / progress-track / asset entities
 *          → adapter.moves / getProgressTracks() / getAssetNames()
 *
 *  Two states are asserted for every surface:
 *    [A] an Ironsworn-LIKE adapter is registered for the active system →
 *        the consumer surfaces that adapter's data (behaviour identical to
 *        the pre-migration hard-import path);
 *    [B] NO adapter is registered → getActiveAdapter() yields the NullAdapter
 *        (isActive()===false, none of the system-specific methods present) →
 *        every system-specific block degrades to "" / is skipped, with no
 *        throw. This is the graceful-degradation contract for unsupported
 *        systems.
 *
 *  Run: node test/adapter-leaf-consumers.test.mjs
 * ===================================================================== */

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

/* ---- Minimal Foundry globals the modules touch at import / call time ---- */
function getProperty(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
globalThis.foundry = { utils: { getProperty } };
globalThis.CONFIG = { Item: { dataModels: {} } };
globalThis.Hooks = { on() {}, once() {}, callAll() {} };
globalThis.canvas = { tokens: { controlled: [] } };
// No registered world settings → Settings.get(...) returns undefined, so the
// compendium-context categories are all considered "enabled" (=== false check
// fails) and we exercise the adapter call for each.
globalThis.game = {
  user: { id: "u1" }, actors: [], packs: [],
  system: { id: "test-sys" },
  settings: { get() { return undefined; } },
  i18n: { localize: (s) => s }
};

const { registerSystem, getActiveAdapter } = await import("../scripts/systems/registry.js");
const { buildFoeGuidance, buildCompendiumContextBlock } = await import("../scripts/ai/prompt-builder.js");
const { EntityLinker } = await import("../scripts/chronicle/entity-linking.js");

/* ---- A fake Ironsworn-LIKE adapter exposing the methods the leaf -------
 *      consumers feature-detect. It satisfies the SystemAdapter contract
 *      (isActive + capabilities) and is registered under the active id. --- */
const FAKE_CHAR = { id: "char-1", name: "Sigrún" };
const fakeAdapter = {
  id: "test-sys",
  label: "Test System (Ironsworn-like)",
  isActive() { return true; },
  capabilities() { return {}; },
  // prompt-builder surfaces
  getCompendiumFoeNames() {
    return [
      { name: "Broken", rank: "troublesome" },
      { name: "Bear",   rank: "dangerous" },
      { name: "Elder Mammoth", rank: "extreme" },
      { name: "Mystery Beast" } // no rank → "Unranked"
    ];
  },
  getCompendiumContextNames(category) {
    return category === "moves" ? ["Face Danger", "Secure an Advantage"] : [];
  },
  // entity-linking surfaces
  moves: [
    { name: "Face Danger", id: "move:classic/adventure/face_danger" },
    { name: "Strike",      id: "move:classic/combat/strike" }
  ],
  getActiveCharacter() { return FAKE_CHAR; },
  getProgressTracks(actor) {
    return actor === FAKE_CHAR
      ? [{ name: "Avenge the Burning of Hearthholm" }, { name: "vow" /* generic */ }]
      : [];
  },
  isGenericTrackWord(name) { return String(name).toLowerCase() === "vow"; },
  getAssetNames() { return [{ name: "Loyal Companion" }, { name: "Bound" }]; }
};

/* ===================================================================== *
 *  STATE [A] — Ironsworn-like adapter registered for the active system
 * ===================================================================== */
console.log("[A] Ironsworn-like adapter registered → leaf consumers surface its data");

eq(registerSystem("test-sys", fakeAdapter), true, "registerSystem accepts the fake adapter");
ok(getActiveAdapter() === fakeAdapter, "getActiveAdapter() resolves to the registered adapter");

// --- prompt-builder.buildFoeGuidance() ---
const foeBlock = buildFoeGuidance();
ok(foeBlock.includes("OFFICIAL FOE CATALOGUE"), "foe guidance is emitted when adapter supplies foes");
ok(foeBlock.includes("Troublesome: Broken"), "foe guidance groups by rank (troublesome)");
ok(foeBlock.includes("Dangerous: Bear"), "foe guidance groups by rank (dangerous)");
ok(foeBlock.includes("Extreme: Elder Mammoth"), "foe guidance groups by rank (extreme)");
ok(foeBlock.includes("Unranked: Mystery Beast"), "foe guidance buckets rankless foes under Unranked");

// --- prompt-builder.buildCompendiumContextBlock() ---
const ctxBlock = buildCompendiumContextBlock();
ok(ctxBlock.includes("OFFICIAL IRONSWORN COMPENDIUM REFERENCE"), "compendium context block emitted");
ok(ctxBlock.includes("Available Ironsworn Moves: Face Danger, Secure an Advantage"),
   "compendium context lists adapter-supplied move names verbatim");

// --- entity-linking.EntityLinker._build() ---
EntityLinker._dirty = true;
const { byName: idxA } = EntityLinker._build();
ok(idxA.get("face danger")?.kind === "move", "move entity indexed from adapter.moves");
eq(idxA.get("strike")?.moveDsId, "move:classic/combat/strike", "move Datasworn id carried through");
ok(idxA.get("avenge the burning of hearthholm")?.kind === "track",
   "progress-track entity indexed from adapter.getProgressTracks()");
ok(!idxA.has("vow"), "generic track word ('vow') is excluded via adapter.isGenericTrackWord()");
ok(idxA.get("loyal companion")?.kind === "asset", "asset entity indexed from adapter.getAssetNames()");

/* ===================================================================== *
 *  STATE [B] — no adapter for the active system → NullAdapter fallback
 * ===================================================================== */
console.log("[B] No adapter registered → NullAdapter → system-specific blocks degrade gracefully");

// Point the active system at an id with NO registered adapter. getActiveAdapter()
// must now yield the NullAdapter (never null).
globalThis.game.system.id = "totally-unknown-system";
const nul = getActiveAdapter();
ok(nul && typeof nul.isActive === "function", "getActiveAdapter() still returns a usable adapter (NullAdapter)");
eq(nul.isActive(), false, "NullAdapter.isActive() is false");
eq(typeof nul.getCompendiumFoeNames, "undefined", "NullAdapter exposes no getCompendiumFoeNames (feature-detect → skip)");

// --- prompt-builder degrades to "" (no throw) ---
eq(buildFoeGuidance(), "", "buildFoeGuidance() returns '' under NullAdapter");
eq(buildCompendiumContextBlock(), "", "buildCompendiumContextBlock() returns '' under NullAdapter");

// --- entity-linking skips all system-specific kinds (no throw) ---
EntityLinker._dirty = true;
const { byName: idxB } = EntityLinker._build();
ok(!idxB.has("face danger"), "no move entities indexed under NullAdapter");
ok(!idxB.has("avenge the burning of hearthholm"), "no progress-track entities indexed under NullAdapter");
ok(!idxB.has("loyal companion"), "no asset entities indexed under NullAdapter");

/* ===================================================================== */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
