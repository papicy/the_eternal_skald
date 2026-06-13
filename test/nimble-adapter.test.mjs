/* =====================================================================
 *  NimbleAdapter test for The Eternal Skald.
 *
 *  Phase 4 of the multi-system plugin architecture
 *  (see docs/PROPOSAL-multi-system-adapter-architecture.md).
 *
 *  Guards the Nimble (system id "nimble") adapter:
 *    • satisfies the SystemAdapter contract (isValidAdapter);
 *    • isActive() tracks game.system.id;
 *    • capabilities() reports characterReads + mapVision ON and every
 *      Ironsworn-specific flag (oracles / progressTracks / vows / momentum /
 *      moves / xp …) OFF — the design conclusion from the Nimble data-model
 *      inspection;
 *    • getCharacterStats() maps STR/DEX/INT/WIL ability modifiers;
 *    • getResourcePools() maps HP / Wounds / Mana / Hit Dice;
 *    • describeCharacter() / buildSystemPrompt() produce prompt-ready text
 *      and degrade to "" when inactive;
 *    • every WRITE / progress / move op returns the soft unsupported() result
 *      (never throws); rollOracle() returns null;
 *    • the registry resolves the adapter when "nimble" is the active system.
 *
 *  Run: node test/nimble-adapter.test.mjs
 * ===================================================================== */

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }
function deepEq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

/* ---- Minimal Foundry globals the adapter touches at call time ---- */
function getProperty(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
globalThis.foundry = { utils: { getProperty } };
globalThis.canvas = { tokens: { controlled: [] } };
globalThis.game = { user: { id: "u1", character: null }, actors: [], system: { id: "nimble" } };

const { NimbleAdapter } = await import("../scripts/systems/nimble-adapter.js");
const { isValidAdapter } = await import("../scripts/systems/adapter-interface.js");
const { registerSystem, getActiveAdapter } = await import("../scripts/systems/registry.js");

/* A representative Nimble character actor (data shapes from the Nimble system
 * data model: system.abilities.<k>.mod; system.attributes.hp/wounds/hitDice;
 * system.resources.mana). */
const ACTOR = {
  name: "Kára Ironbreath",
  type: "character",
  system: {
    abilities: {
      strength:     { mod: 3, baseValue: 3 },
      dexterity:    { mod: 1, baseValue: 1 },
      intelligence: { mod: -1, baseValue: -1 },
      will:         { mod: 2, baseValue: 2 }
    },
    attributes: {
      hp:     { value: 18, max: 24, temp: 3 },
      wounds: { value: 1, max: 6 },
      hitDice: { d8: { current: 2, max: 3 }, d10: { current: 1, max: 1 } }
    },
    resources: { mana: { value: 4, max: 6, current: 4, baseMax: 6 } }
  }
};

/* ===================================================================== */
console.log("[1] Contract & identity");
ok(isValidAdapter(NimbleAdapter), "NimbleAdapter satisfies the SystemAdapter contract");
eq(NimbleAdapter.id, "nimble", "id is 'nimble'");
eq(NimbleAdapter.label, "Nimble", "label is 'Nimble'");
ok(Object.isFrozen(NimbleAdapter), "NimbleAdapter is frozen");
eq(NimbleAdapter.isActive(), true, "isActive() true when game.system.id === 'nimble'");
globalThis.game.system.id = "foundry-ironsworn";
eq(NimbleAdapter.isActive(), false, "isActive() false under a different system");
globalThis.game.system.id = "nimble"; // restore

/* ===================================================================== */
console.log("[2] capabilities() — reads + mapVision ON, Ironsworn mechanics OFF");
const caps = NimbleAdapter.capabilities();
eq(caps.systemActive, true, "systemActive true while nimble is active");
eq(caps.characterReads, true, "characterReads ON");
eq(caps.mapVision, true, "mapVision ON (system-independent core feature)");
for (const off of ["oracles", "progressTracks", "vows", "momentum", "moves", "moveDialogs",
                   "xp", "sheetWrites", "impacts", "compendiumFoes", "compendiumAssets", "createCharacter"]) {
  eq(caps[off], false, `${off} OFF`);
}

/* ===================================================================== */
console.log("[3] getCharacterStats() maps STR/DEX/INT/WIL modifiers");
deepEq(NimbleAdapter.getCharacterStats(ACTOR), { STR: 3, DEX: 1, INT: -1, WIL: 2 },
       "ability modifiers mapped to short labels");
eq(NimbleAdapter.getStats === undefined, false, "getStats alias present");
deepEq(NimbleAdapter.getStats(ACTOR), NimbleAdapter.getCharacterStats(ACTOR),
       "getStats() is a canonical alias of getCharacterStats()");
// Falls back to baseValue then bare number; missing → null.
deepEq(NimbleAdapter.getCharacterStats({ system: { abilities: {
         strength: { baseValue: 5 }, dexterity: 2, intelligence: {}, will: { mod: 0 } } } }),
       { STR: 5, DEX: 2, INT: null, WIL: 0 },
       "stat resolution falls back mod → baseValue → bare number → null");

/* ===================================================================== */
console.log("[4] getResourcePools() maps HP / Wounds / Mana / Hit Dice");
const pools = NimbleAdapter.getResourcePools(ACTOR);
deepEq(pools.hp, { value: 18, max: 24, temp: 3 }, "HP pool with temp");
deepEq(pools.wounds, { value: 1, max: 6 }, "Wounds pool");
deepEq(pools.mana, { value: 4, max: 6 }, "Mana pool (derived value/max)");
deepEq(pools.hitDice, { value: 3, max: 4 }, "Hit Dice aggregated across die sizes (Σ current / Σ max)");
deepEq(NimbleAdapter.getMeters(ACTOR), pools, "getMeters() is a canonical alias of getResourcePools()");
// Absent pools are omitted, not zero-filled, and nothing throws.
deepEq(NimbleAdapter.getResourcePools({ system: {} }), {}, "empty actor → no pools (no throw)");
deepEq(NimbleAdapter.getResourcePools(null), {}, "null actor → {} (no throw)");

/* ===================================================================== */
console.log("[5] describeCharacter() — prompt-ready summary, graceful when inactive");
const desc = NimbleAdapter.describeCharacter(ACTOR);
ok(desc.includes("Character: Kára Ironbreath"), "describe names the character");
ok(desc.includes("STR +3") && desc.includes("INT -1"), "describe shows signed ability mods");
ok(desc.includes("HP 18/24 (+3 temp)") && desc.includes("Mana 4/6"), "describe shows resource pools");
globalThis.game.system.id = "foundry-ironsworn";
eq(NimbleAdapter.describeCharacter(ACTOR), "", "describeCharacter() → '' when Nimble inactive");
globalThis.game.system.id = "nimble";
ok(NimbleAdapter.describeCharacter(null).startsWith("(No active Nimble character"),
   "describeCharacter() gives a helpful note when no actor resolves");

/* ===================================================================== */
console.log("[6] buildSystemPrompt() / getPromptProfile() — Nimble rules digest");
const prompt = NimbleAdapter.buildSystemPrompt();
ok(prompt.includes("NIMBLE SYSTEM CONTEXT"), "prompt is Nimble-flavoured");
ok(/STR, DEX, INT, WIL/.test(prompt), "prompt names the four abilities");
ok(/HP/.test(prompt) && /Wounds/.test(prompt) && /Mana/.test(prompt) && /Hit Dice/.test(prompt),
   "prompt names the resource pools");
ok(/no oracles, vows, progress\s*\n?\s*tracks or momentum/i.test(prompt) || /no oracles/i.test(prompt),
   "prompt explicitly disclaims Ironsworn concepts");
const profile = NimbleAdapter.getPromptProfile();
eq(profile.rulesDigest, prompt, "getPromptProfile().rulesDigest === buildSystemPrompt()");
eq(profile.moveList, "", "getPromptProfile().moveList is empty (no programmatic moves)");
globalThis.game.system.id = "foundry-ironsworn";
eq(NimbleAdapter.buildSystemPrompt(), "", "buildSystemPrompt() → '' when Nimble inactive");
globalThis.game.system.id = "nimble";

/* ===================================================================== */
console.log("[7] Unsupported writes degrade softly (never throw)");
for (const m of ["adjustResource", "applyHarm", "applyStress", "setStat", "setImpact",
                 "markProgress", "setProgress", "createProgressTrack", "completeTrack", "grantXp"]) {
  const r = NimbleAdapter[m]();
  ok(r && r.ok === false && r.unsupported === true, `${m}() returns unsupported()`);
}
eq(NimbleAdapter.rollOracle(), null, "rollOracle() returns null (Nimble has no oracles)");
const tm = await NimbleAdapter.triggerMove();
ok(tm && tm.unsupported === true, "triggerMove() resolves to unsupported()");
const ff = await NimbleAdapter.createFoeActor();
ok(ff && ff.unsupported === true, "createFoeActor() resolves to unsupported()");

/* ===================================================================== */
console.log("[8] Registry resolves the Nimble adapter when nimble is active");
ok(registerSystem("nimble", NimbleAdapter), "registry accepts the Nimble adapter");
ok(getActiveAdapter() === NimbleAdapter, "getActiveAdapter() resolves to NimbleAdapter under 'nimble'");

/* ===================================================================== */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
