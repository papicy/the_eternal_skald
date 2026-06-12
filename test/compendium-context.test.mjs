/* =====================================================================
 *  Generic compendium-context test for The Eternal Skald.  (v0.15.0)
 *
 *  Guards the multi-compendium AI-context feature, which generalises the
 *  foe-cache pattern so the GM can opt additional foundry-ironsworn packs
 *  (Moves / Delve Moves / Assets / Truths / Domains / Themes) into the AI
 *  system prompt as token-efficient NAME catalogues.
 *
 *  Verifies IronswornController:
 *    • CONTEXT_PACK_MAP maps exactly the six expected categories to their
 *      official pack ids and is frozen;
 *    • _findPackById() resolves a pack by full id AND bare collection
 *      segment, and returns null when absent;
 *    • getCompendiumContextNames():
 *        – returns [] until the context cache is primed (graceful),
 *        – returns a COPY of the cached list for an enabled category,
 *        – returns [] for an unknown / unprimed category,
 *        – never lets a caller mutate the cache through the returned array.
 *
 *  Run: node test/compendium-context.test.mjs
 * ===================================================================== */

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }
function deepEq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

/* ---- Minimal Foundry globals the controller relies on at import time ---- */
function getProperty(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setProperty(obj, path, value) {
  const keys = path.split("."); let o = obj;
  while (keys.length > 1) { const k = keys.shift(); o[k] = o[k] ?? {}; o = o[k]; }
  o[keys[0]] = value;
}
globalThis.foundry = { utils: { getProperty, setProperty } };
globalThis.CONFIG = { Item: { dataModels: { "asset": {}, "progress": {} } } };
globalThis.game = { user: { id: "u1" }, actors: [], packs: [] };
globalThis.canvas = { tokens: { controlled: [] } };

const { default: Ctrl } = await import("../scripts/ironsworn-controller.js");

/* ===================================================================== */
console.log("[1] CONTEXT_PACK_MAP maps the six categories to official packs and is frozen");
deepEq(
  Object.keys(Ctrl.CONTEXT_PACK_MAP),
  ["moves", "delvemoves", "assets", "truths", "domains", "themes"],
  "CONTEXT_PACK_MAP categories"
);
eq(Ctrl.CONTEXT_PACK_MAP.moves, "foundry-ironsworn.ironswornmoves", "moves → ironswornmoves");
eq(Ctrl.CONTEXT_PACK_MAP.delvemoves, "foundry-ironsworn.ironsworndelvemoves", "delvemoves → ironsworndelvemoves");
eq(Ctrl.CONTEXT_PACK_MAP.assets, "foundry-ironsworn.ironswornassets", "assets → ironswornassets");
eq(Ctrl.CONTEXT_PACK_MAP.truths, "foundry-ironsworn.ironsworntruths", "truths → ironsworntruths");
eq(Ctrl.CONTEXT_PACK_MAP.domains, "foundry-ironsworn.ironsworndelvedomains", "domains → ironsworndelvedomains");
eq(Ctrl.CONTEXT_PACK_MAP.themes, "foundry-ironsworn.ironsworndelvethemes", "themes → ironsworndelvethemes");
ok(Object.isFrozen(Ctrl.CONTEXT_PACK_MAP), "CONTEXT_PACK_MAP is frozen");

/* ===================================================================== */
console.log("[2] _findPackById resolves by full id and bare segment, else null");
globalThis.game.packs = [
  { metadata: { id: "foundry-ironsworn.ironswornmoves", label: "Ironsworn Moves" }, documentName: "Item" },
  { collection: "ironswornassets", metadata: { label: "Assets" }, documentName: "Item" }
];
eq(Ctrl._findPackById("foundry-ironsworn.ironswornmoves")?.metadata?.id, "foundry-ironsworn.ironswornmoves", "full id match");
eq(Ctrl._findPackById("foundry-ironsworn.ironswornassets")?.collection, "ironswornassets", "bare-segment match against full request");
eq(Ctrl._findPackById("ironswornmoves")?.metadata?.id, "foundry-ironsworn.ironswornmoves", "bare-segment request match");
eq(Ctrl._findPackById("foundry-ironsworn.ironsworntruths"), null, "absent pack → null");
eq(Ctrl._findPackById(""), null, "empty id → null");
globalThis.game.packs = [];

/* ===================================================================== */
console.log("[3] getCompendiumContextNames returns [] before the cache is primed");
Ctrl._contextIndexCache = null;
deepEq(Ctrl.getCompendiumContextNames("moves"), [], "empty when cache null");
Ctrl._contextIndexCache = undefined;
deepEq(Ctrl.getCompendiumContextNames("moves"), [], "empty when cache undefined");

/* ===================================================================== */
console.log("[4] getCompendiumContextNames returns the cached list for an enabled category");
Ctrl._contextIndexCache = {
  moves: ["Face Danger", "Secure an Advantage", "Strike"],
  assets: ["Alchemist", "Archer", "Brawler"],
  truths: []
};
deepEq(Ctrl.getCompendiumContextNames("moves"), ["Face Danger", "Secure an Advantage", "Strike"], "moves names returned");
deepEq(Ctrl.getCompendiumContextNames("assets"), ["Alchemist", "Archer", "Brawler"], "assets names returned");
deepEq(Ctrl.getCompendiumContextNames("truths"), [], "empty primed category → []");
deepEq(Ctrl.getCompendiumContextNames("domains"), [], "category absent from cache → []");
deepEq(Ctrl.getCompendiumContextNames("nonsense"), [], "unknown category → []");

/* ===================================================================== */
console.log("[5] getCompendiumContextNames returns a COPY (cache is not mutable via the result)");
const got = Ctrl.getCompendiumContextNames("moves");
got.push("INJECTED");
deepEq(Ctrl.getCompendiumContextNames("moves"), ["Face Danger", "Secure an Advantage", "Strike"], "cache unchanged after mutating the returned array");

// cleanup
Ctrl._contextIndexCache = null;

/* ===================================================================== */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
