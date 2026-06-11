/* =====================================================================
 *  Official-foe-compendium test for The Eternal Skald.  (v0.10.14)
 *
 *  Guards the feature that constrains AI foe creation to the official
 *  foundry-ironsworn foe compendia. Regular encounters must draw from the
 *  two official packs (foundry-ironsworn.ironswornfoes +
 *  foundry-ironsworn.ironsworndelvefoes); only important narrative bosses /
 *  unique antagonists may be custom-created.
 *
 *  Verifies IronswornController:
 *    • FOE_COMPENDIUM_PACK_IDS lists exactly the two official packs;
 *    • _isOfficialFoePackId() accepts the fully-qualified id AND the bare
 *      collection segment for both packs, and rejects anything else;
 *    • getCompendiumFoeNames():
 *        – returns [] until the foe index cache is primed (graceful),
 *        – includes ONLY foes from the two official packs (drops foes that
 *          live in other/homebrew foe-like packs),
 *        – de-duplicates by lower-cased name,
 *        – is sorted by name,
 *        – carries each foe's canonical rank.
 *
 *  Run: node test/foe-compendium.test.mjs
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
globalThis.game = { user: { id: "u1" }, actors: [] };
globalThis.canvas = { tokens: { controlled: [] } };

const { default: Ctrl } = await import("../scripts/ironsworn-controller.js");

/* ===================================================================== */
console.log("[1] FOE_COMPENDIUM_PACK_IDS lists exactly the two official packs");
deepEq(
  [...Ctrl.FOE_COMPENDIUM_PACK_IDS],
  ["foundry-ironsworn.ironswornfoes", "foundry-ironsworn.ironsworndelvefoes"],
  "FOE_COMPENDIUM_PACK_IDS"
);
ok(Object.isFrozen(Ctrl.FOE_COMPENDIUM_PACK_IDS), "FOE_COMPENDIUM_PACK_IDS is frozen");

/* ===================================================================== */
console.log("[2] _isOfficialFoePackId accepts full ids and bare segments");
ok(Ctrl._isOfficialFoePackId("foundry-ironsworn.ironswornfoes"), "full id ironswornfoes");
ok(Ctrl._isOfficialFoePackId("foundry-ironsworn.ironsworndelvefoes"), "full id ironsworndelvefoes");
ok(Ctrl._isOfficialFoePackId("ironswornfoes"), "bare segment ironswornfoes");
ok(Ctrl._isOfficialFoePackId("ironsworndelvefoes"), "bare segment ironsworndelvefoes");
ok(Ctrl._isOfficialFoePackId("FOUNDRY-IRONSWORN.IronswornFoes"), "case-insensitive");
// Rejections
ok(!Ctrl._isOfficialFoePackId("foundry-ironsworn.ironswornassets"), "rejects assets pack");
ok(!Ctrl._isOfficialFoePackId("world.homebrew-foes"), "rejects homebrew foes pack");
ok(!Ctrl._isOfficialFoePackId("foundry-ironsworn.starforgedfoes"), "rejects unrelated foe pack");
ok(!Ctrl._isOfficialFoePackId(""), "rejects empty");
ok(!Ctrl._isOfficialFoePackId(null), "rejects null");
ok(!Ctrl._isOfficialFoePackId("notironswornfoes-extra"), "rejects suffix-only false positive");

/* ===================================================================== */
console.log("[3] getCompendiumFoeNames returns [] before the cache is primed");
Ctrl._foeIndexCache = null;
deepEq(Ctrl.getCompendiumFoeNames(), [], "empty when cache null");
Ctrl._foeIndexCache = undefined;
deepEq(Ctrl.getCompendiumFoeNames(), [], "empty when cache undefined");

/* ===================================================================== */
console.log("[4] getCompendiumFoeNames filters to official packs, dedupes & sorts");
Ctrl._foeIndexCache = [
  { name: "Wolf",    lc: "wolf",    rank: "dangerous",   packId: "foundry-ironsworn.ironswornfoes" },
  { name: "Bear",    lc: "bear",    rank: "dangerous",   packId: "foundry-ironsworn.ironswornfoes" },
  { name: "Basilisk", lc: "basilisk", rank: "formidable", packId: "foundry-ironsworn.ironsworndelvefoes" },
  // Duplicate of Wolf from the other official pack — should be de-duped.
  { name: "Wolf",    lc: "wolf",    rank: "dangerous",   packId: "foundry-ironsworn.ironsworndelvefoes" },
  // Non-official packs — must be excluded.
  { name: "Homebrew Horror", lc: "homebrew horror", rank: "epic", packId: "world.my-foes" },
  { name: "Star Beast", lc: "star beast", rank: "extreme", packId: "foundry-ironsworn.starforgedfoes" },
];
const foes = Ctrl.getCompendiumFoeNames();
deepEq(foes.map(f => f.name), ["Basilisk", "Bear", "Wolf"], "official foes only, sorted, deduped");
const wolf = foes.find(f => f.name === "Wolf");
eq(wolf?.rank, "dangerous", "Wolf carries its canonical rank");
ok(!foes.some(f => f.name === "Homebrew Horror"), "excludes homebrew pack foe");
ok(!foes.some(f => f.name === "Star Beast"), "excludes non-official foundry foe pack");

/* ===================================================================== */
console.log("[5] getCompendiumFoeNames tolerates bare-segment pack ids");
Ctrl._foeIndexCache = [
  { name: "Hollow", lc: "hollow", rank: "dangerous", packId: "ironswornfoes" },
  { name: "Troll",  lc: "troll",  rank: "formidable", packId: "ironsworndelvefoes" },
];
deepEq(Ctrl.getCompendiumFoeNames().map(f => f.name), ["Hollow", "Troll"], "bare-segment ids accepted");

// cleanup
Ctrl._foeIndexCache = null;

/* ===================================================================== */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
