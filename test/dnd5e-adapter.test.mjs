/* =====================================================================
 *  Dnd5eAdapter test for The Eternal Skald (Phase E).
 *
 *  Guards the read-only D&D 5e (system id "dnd5e") adapter:
 *    • satisfies the SystemAdapter contract (isValidAdapter);
 *    • isActive() tracks game.system.id;
 *    • capabilities() reports characterReads + mapVision ON and every
 *      Ironsworn-specific write flag OFF;
 *    • getCharacterStats() maps STR/DEX/CON/INT/WIS/CHA modifiers (with the
 *      score→mod fallback);
 *    • getResourcePools() maps HP / AC / spell slots / pact;
 *    • describeClassLevel() + getInventoryHighlights() summarise the sheet;
 *    • describeCharacter() / buildSystemPrompt() produce prompt-ready text and
 *      degrade to "" when inactive;
 *    • every WRITE / progress / move op returns the soft unsupported() result
 *      (never throws); rollOracle() returns null;
 *    • the registry resolves the adapter when "dnd5e" is the active system.
 *
 *  Run: node test/dnd5e-adapter.test.mjs
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
globalThis.game = { user: { id: "u1", character: null }, actors: [], system: { id: "dnd5e" } };

const { Dnd5eAdapter } = await import("../scripts/systems/dnd5e-adapter.js");
const { isValidAdapter } = await import("../scripts/systems/adapter-interface.js");
const { registerSystem, getActiveAdapter } = await import("../scripts/systems/registry.js");

/* A representative 5e character: a level-5 Wizard. */
const ACTOR = {
  name: "Aelar Moonwhisper",
  type: "character",
  classes: { wizard: { name: "Wizard", system: { levels: 5 } } },
  system: {
    abilities: {
      str: { mod: -1, value: 8 },
      dex: { mod: 2,  value: 14 },
      con: { mod: 1,  value: 12 },
      int: { mod: 4,  value: 18 },
      wis: { mod: 1,  value: 12 },
      cha: { mod: 0,  value: 10 }
    },
    attributes: {
      hp: { value: 22, max: 32, temp: 5 },
      ac: { value: 15 }
    },
    spells: {
      spell1: { value: 3, max: 4 },
      spell2: { value: 1, max: 3 },
      spell3: { value: 0, max: 2 },
      spell4: { value: 0, max: 0 },
      pact:   { value: 0, max: 0 }
    },
    details: { level: 5 }
  },
  items: [
    { name: "Quarterstaff", type: "weapon", system: { equipped: true } },
    { name: "Spellbook", type: "equipment", system: { equipped: false } },
    { name: "Cloak of Protection", type: "equipment", system: { equipped: false, attunement: 2 } }
  ]
};

/* ===================================================================== */
console.log("[1] Contract & identity");
ok(isValidAdapter(Dnd5eAdapter), "Dnd5eAdapter satisfies the SystemAdapter contract");
eq(Dnd5eAdapter.id, "dnd5e", "id is 'dnd5e'");
eq(Dnd5eAdapter.label, "D&D 5e", "label is 'D&D 5e'");
ok(Object.isFrozen(Dnd5eAdapter), "Dnd5eAdapter is frozen");
eq(Dnd5eAdapter.isActive(), true, "isActive() true when game.system.id === 'dnd5e'");
globalThis.game.system.id = "foundry-ironsworn";
eq(Dnd5eAdapter.isActive(), false, "isActive() false under a different system");
globalThis.game.system.id = "dnd5e"; // restore

/* ===================================================================== */
console.log("[2] capabilities() — reads + mapVision ON, write mechanics OFF");
const caps = Dnd5eAdapter.capabilities();
eq(caps.systemActive, true, "systemActive true while dnd5e is active");
eq(caps.characterReads, true, "characterReads ON");
eq(caps.mapVision, true, "mapVision ON (system-independent core feature)");
for (const off of ["oracles", "progressTracks", "vows", "momentum", "moves", "moveDialogs",
                   "xp", "sheetWrites", "impacts", "compendiumFoes", "compendiumAssets", "createCharacter"]) {
  eq(caps[off], false, `${off} OFF`);
}

/* ===================================================================== */
console.log("[3] getCharacterStats() maps the six ability modifiers");
deepEq(Dnd5eAdapter.getCharacterStats(ACTOR), { STR: -1, DEX: 2, CON: 1, INT: 4, WIS: 1, CHA: 0 },
       "ability modifiers mapped to short labels");
deepEq(Dnd5eAdapter.getStats(ACTOR), Dnd5eAdapter.getCharacterStats(ACTOR),
       "getStats() is a canonical alias of getCharacterStats()");
// score→mod fallback when .mod is absent; missing → null
deepEq(Dnd5eAdapter.getCharacterStats({ system: { abilities: {
         str: { value: 16 }, dex: {}, con: { value: 10 }, int: { value: 7 }, wis: {}, cha: { mod: 3 } } } }),
       { STR: 3, DEX: null, CON: 0, INT: -2, WIS: null, CHA: 3 },
       "stat resolution derives mod from score, else null");

/* ===================================================================== */
console.log("[4] getResourcePools() maps HP / AC / spell slots / pact");
const pools = Dnd5eAdapter.getResourcePools(ACTOR);
deepEq(pools.hp, { value: 22, max: 32, temp: 5 }, "HP pool with temp");
deepEq(pools.ac, { value: 15, max: null }, "AC pool (value only)");
deepEq(pools.spell1, { value: 3, max: 4 }, "L1 spell slots");
deepEq(pools.spell2, { value: 1, max: 3 }, "L2 spell slots");
ok(pools.spell4 === undefined, "spell levels with max 0 are omitted");
ok(pools.pact === undefined, "pact pool with max 0 is omitted");
deepEq(Dnd5eAdapter.getMeters(ACTOR), pools, "getMeters() is a canonical alias");
deepEq(Dnd5eAdapter.getResourcePools(null), {}, "null actor → {} (no throw)");

/* ===================================================================== */
console.log("[5] describeClassLevel() + getInventoryHighlights()");
eq(Dnd5eAdapter.describeClassLevel(ACTOR), "Wizard 5", "class/level from actor.classes");
eq(Dnd5eAdapter.describeClassLevel({ system: { details: { level: 3 } } }), "Level 3",
   "falls back to system.details.level");
eq(Dnd5eAdapter.describeClassLevel({}), "", "no readable class/level → ''");
const inv = Dnd5eAdapter.getInventoryHighlights(ACTOR);
ok(inv.includes("Quarterstaff"), "equipped weapon listed");
ok(inv.includes("Cloak of Protection"), "attuned magic item listed");
ok(!inv.includes("Spellbook"), "unequipped, unattuned item omitted");
deepEq(Dnd5eAdapter.getInventoryHighlights(null), [], "null actor → [] (no throw)");

/* ===================================================================== */
console.log("[6] describeCharacter() — prompt-ready summary, graceful when inactive");
const desc = Dnd5eAdapter.describeCharacter(ACTOR);
ok(desc.includes("Character: Aelar Moonwhisper"), "describe names the character");
ok(desc.includes("Wizard 5"), "describe shows class/level");
ok(desc.includes("INT +4") && desc.includes("STR -1"), "describe shows signed ability mods");
ok(desc.includes("HP 22/32 (+5 temp)") && desc.includes("AC 15"), "describe shows vitals");
ok(desc.includes("L1 3/4") && desc.includes("L2 1/3"), "describe shows spell slots");
ok(desc.includes("Quarterstaff"), "describe shows notable items");
globalThis.game.system.id = "foundry-ironsworn";
eq(Dnd5eAdapter.describeCharacter(ACTOR), "", "describeCharacter() → '' when 5e inactive");
globalThis.game.system.id = "dnd5e";
ok(Dnd5eAdapter.describeCharacter(null).startsWith("(No active D&D 5e character"),
   "describeCharacter() gives a helpful note when no actor resolves");

/* ===================================================================== */
console.log("[7] buildSystemPrompt() / getPromptProfile() — 5e rules digest");
const prompt = Dnd5eAdapter.buildSystemPrompt();
ok(prompt.includes("D&D 5e SYSTEM CONTEXT"), "prompt is 5e-flavoured");
ok(/STR\/DEX\/CON\/INT\/WIS\/CHA/.test(prompt), "prompt names the six abilities");
ok(/Spell slots/.test(prompt) && /AC/.test(prompt) && /HP/.test(prompt), "prompt names the resources");
ok(/no oracles, vows, progress/i.test(prompt), "prompt explicitly disclaims Ironsworn concepts");
const profile = Dnd5eAdapter.getPromptProfile();
eq(profile.rulesDigest, prompt, "getPromptProfile().rulesDigest === buildSystemPrompt()");
eq(profile.moveList, "", "getPromptProfile().moveList is empty");
globalThis.game.system.id = "foundry-ironsworn";
eq(Dnd5eAdapter.buildSystemPrompt(), "", "buildSystemPrompt() → '' when 5e inactive");
globalThis.game.system.id = "dnd5e";

/* ===================================================================== */
console.log("[8] Unsupported writes degrade softly (never throw)");
for (const m of ["adjustResource", "applyHarm", "applyStress", "setStat", "setImpact",
                 "markProgress", "setProgress", "createProgressTrack", "completeTrack", "grantXp"]) {
  const r = Dnd5eAdapter[m]();
  ok(r && r.ok === false && r.unsupported === true, `${m}() returns unsupported()`);
}
eq(Dnd5eAdapter.rollOracle(), null, "rollOracle() returns null (5e has no oracles)");
const tm = await Dnd5eAdapter.triggerMove();
ok(tm && tm.unsupported === true, "triggerMove() resolves to unsupported()");
const ff = await Dnd5eAdapter.createFoeActor();
ok(ff && ff.unsupported === true, "createFoeActor() resolves to unsupported()");

/* ===================================================================== */
console.log("[9] Registry resolves the 5e adapter when dnd5e is active");
ok(registerSystem("dnd5e", Dnd5eAdapter), "registry accepts the 5e adapter");
ok(getActiveAdapter() === Dnd5eAdapter, "getActiveAdapter() resolves to Dnd5eAdapter under 'dnd5e'");

/* ===================================================================== */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
