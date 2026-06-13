/* =====================================================================
 *  Pf2eAdapter test for The Eternal Skald (Phase E).
 *
 *  Guards the read-only Pathfinder 2e (system id "pf2e") adapter:
 *    • satisfies the SystemAdapter contract (isValidAdapter);
 *    • isActive() tracks game.system.id;
 *    • capabilities() reports characterReads + mapVision ON and every
 *      Ironsworn-specific write flag OFF;
 *    • getCharacterStats() maps STR/DEX/CON/INT/WIS/CHA modifiers (with the
 *      score→mod fallback);
 *    • getResourcePools() maps HP / AC / hero points / focus points;
 *    • describeClassLevel() + getInventoryHighlights() summarise the sheet;
 *    • describeCharacter() / buildSystemPrompt() produce prompt-ready text and
 *      degrade to "" when inactive;
 *    • every WRITE / progress / move op returns the soft unsupported() result
 *      (never throws); rollOracle() returns null;
 *    • the registry resolves the adapter when "pf2e" is the active system.
 *
 *  Run: node test/pf2e-adapter.test.mjs
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
globalThis.game = { user: { id: "u1", character: null }, actors: [], system: { id: "pf2e" } };

const { Pf2eAdapter } = await import("../scripts/systems/pf2e-adapter.js");
const { isValidAdapter } = await import("../scripts/systems/adapter-interface.js");
const { registerSystem, getActiveAdapter } = await import("../scripts/systems/registry.js");

/* A representative PF2e character: a level-5 Elf Wizard. */
const ACTOR = {
  name: "Seoni Quickfingers",
  type: "character",
  ancestry: { name: "Elf" },
  class: { name: "Wizard" },
  system: {
    abilities: {
      str: { mod: -1 },
      dex: { mod: 2 },
      con: { mod: 1 },
      int: { mod: 4 },
      wis: { mod: 1 },
      cha: { mod: 0 }
    },
    attributes: {
      hp: { value: 28, max: 40, temp: 4 },
      ac: { value: 21 }
    },
    resources: {
      heroPoints: { value: 1, max: 3 },
      focus: { value: 2, max: 2 }
    },
    details: { level: { value: 5 } }
  },
  items: [
    { name: "Staff of Fire", type: "weapon", system: { equipped: { carryType: "held", invested: false } } },
    { name: "Explorer's Clothing", type: "armor", system: { equipped: { carryType: "worn", invested: false } } },
    { name: "Ring of Wizardry", type: "equipment", system: { equipped: { carryType: "worn", invested: true } } },
    { name: "Spare Dagger", type: "weapon", system: { equipped: { carryType: "stowed", invested: false } } }
  ]
};

/* ===================================================================== */
console.log("[1] Contract & identity");
ok(isValidAdapter(Pf2eAdapter), "Pf2eAdapter satisfies the SystemAdapter contract");
eq(Pf2eAdapter.id, "pf2e", "id is 'pf2e'");
eq(Pf2eAdapter.label, "Pathfinder 2e", "label is 'Pathfinder 2e'");
ok(Object.isFrozen(Pf2eAdapter), "Pf2eAdapter is frozen");
eq(Pf2eAdapter.isActive(), true, "isActive() true when game.system.id === 'pf2e'");
globalThis.game.system.id = "foundry-ironsworn";
eq(Pf2eAdapter.isActive(), false, "isActive() false under a different system");
globalThis.game.system.id = "pf2e"; // restore

/* ===================================================================== */
console.log("[2] capabilities() — reads + mapVision ON, write mechanics OFF");
const caps = Pf2eAdapter.capabilities();
eq(caps.systemActive, true, "systemActive true while pf2e is active");
eq(caps.characterReads, true, "characterReads ON");
eq(caps.mapVision, true, "mapVision ON (system-independent core feature)");
for (const off of ["oracles", "progressTracks", "vows", "momentum", "moves", "moveDialogs",
                   "xp", "sheetWrites", "impacts", "compendiumFoes", "compendiumAssets", "createCharacter"]) {
  eq(caps[off], false, `${off} OFF`);
}

/* ===================================================================== */
console.log("[3] getCharacterStats() maps the six ability modifiers");
deepEq(Pf2eAdapter.getCharacterStats(ACTOR), { STR: -1, DEX: 2, CON: 1, INT: 4, WIS: 1, CHA: 0 },
       "ability modifiers mapped to short labels");
deepEq(Pf2eAdapter.getStats(ACTOR), Pf2eAdapter.getCharacterStats(ACTOR),
       "getStats() is a canonical alias of getCharacterStats()");
// score→mod fallback when .mod is absent; missing → null
deepEq(Pf2eAdapter.getCharacterStats({ system: { abilities: {
         str: { value: 16 }, dex: {}, con: { value: 10 }, int: { value: 7 }, wis: {}, cha: { mod: 3 } } } }),
       { STR: 3, DEX: null, CON: 0, INT: -2, WIS: null, CHA: 3 },
       "stat resolution derives mod from score, else null");

/* ===================================================================== */
console.log("[4] getResourcePools() maps HP / AC / hero / focus");
const pools = Pf2eAdapter.getResourcePools(ACTOR);
deepEq(pools.hp, { value: 28, max: 40, temp: 4 }, "HP pool with temp");
deepEq(pools.ac, { value: 21, max: null }, "AC pool (value only)");
deepEq(pools.hero, { value: 1, max: 3 }, "Hero Points pool");
deepEq(pools.focus, { value: 2, max: 2 }, "Focus Points pool");
deepEq(Pf2eAdapter.getMeters(ACTOR), pools, "getMeters() is a canonical alias");
ok(Pf2eAdapter.getResourcePools({ system: { resources: { focus: { max: 0 } } } }).focus === undefined,
   "focus pool with max 0 is omitted");
deepEq(Pf2eAdapter.getResourcePools(null), {}, "null actor → {} (no throw)");

/* ===================================================================== */
console.log("[5] describeClassLevel() + getInventoryHighlights()");
eq(Pf2eAdapter.describeClassLevel(ACTOR), "Level 5 Elf Wizard", "level + ancestry + class");
eq(Pf2eAdapter.describeClassLevel({ system: { details: { level: { value: 3 } } } }), "Level 3",
   "level only when ancestry/class absent");
eq(Pf2eAdapter.describeClassLevel({}), "", "no readable class/level → ''");
const inv = Pf2eAdapter.getInventoryHighlights(ACTOR);
ok(inv.includes("Staff of Fire"), "held weapon listed");
ok(inv.includes("Explorer's Clothing"), "worn armor listed");
ok(inv.includes("Ring of Wizardry"), "invested magic item listed");
ok(!inv.includes("Spare Dagger"), "stowed item omitted");
deepEq(Pf2eAdapter.getInventoryHighlights(null), [], "null actor → [] (no throw)");

/* ===================================================================== */
console.log("[6] describeCharacter() — prompt-ready summary, graceful when inactive");
const desc = Pf2eAdapter.describeCharacter(ACTOR);
ok(desc.includes("Character: Seoni Quickfingers"), "describe names the character");
ok(desc.includes("Level 5 Elf Wizard"), "describe shows level/ancestry/class");
ok(desc.includes("INT +4") && desc.includes("STR -1"), "describe shows signed ability mods");
ok(desc.includes("HP 28/40 (+4 temp)") && desc.includes("AC 21"), "describe shows vitals");
ok(desc.includes("Hero Points 1/3") && desc.includes("Focus 2/2"), "describe shows hero/focus points");
ok(desc.includes("Staff of Fire"), "describe shows notable items");
globalThis.game.system.id = "foundry-ironsworn";
eq(Pf2eAdapter.describeCharacter(ACTOR), "", "describeCharacter() → '' when pf2e inactive");
globalThis.game.system.id = "pf2e";
ok(Pf2eAdapter.describeCharacter(null).startsWith("(No active Pathfinder 2e character"),
   "describeCharacter() gives a helpful note when no actor resolves");

/* ===================================================================== */
console.log("[7] buildSystemPrompt() / getPromptProfile() — PF2e rules digest");
const prompt = Pf2eAdapter.buildSystemPrompt();
ok(prompt.includes("PATHFINDER 2e SYSTEM CONTEXT"), "prompt is PF2e-flavoured");
ok(/STR\/DEX\/CON\/INT\/WIS\/CHA|ability modifier/.test(prompt), "prompt names the abilities/math");
ok(/CRITICAL SUCCESS/.test(prompt) && /THREE-ACTION/.test(prompt), "prompt names degrees of success + action economy");
ok(/Hero Points/.test(prompt) && /Focus Points/.test(prompt), "prompt names the resources");
ok(/no oracles, vows, progress/i.test(prompt), "prompt explicitly disclaims Ironsworn concepts");
const profile = Pf2eAdapter.getPromptProfile();
eq(profile.rulesDigest, prompt, "getPromptProfile().rulesDigest === buildSystemPrompt()");
eq(profile.moveList, "", "getPromptProfile().moveList is empty");
globalThis.game.system.id = "foundry-ironsworn";
eq(Pf2eAdapter.buildSystemPrompt(), "", "buildSystemPrompt() → '' when pf2e inactive");
globalThis.game.system.id = "pf2e";

/* ===================================================================== */
console.log("[8] Unsupported writes degrade softly (never throw)");
for (const m of ["adjustResource", "applyHarm", "applyStress", "setStat", "setImpact",
                 "markProgress", "setProgress", "createProgressTrack", "completeTrack", "grantXp"]) {
  const r = Pf2eAdapter[m]();
  ok(r && r.ok === false && r.unsupported === true, `${m}() returns unsupported()`);
}
eq(Pf2eAdapter.rollOracle(), null, "rollOracle() returns null (PF2e has no oracles)");
const tm = await Pf2eAdapter.triggerMove();
ok(tm && tm.unsupported === true, "triggerMove() resolves to unsupported()");
const ff = await Pf2eAdapter.createFoeActor();
ok(ff && ff.unsupported === true, "createFoeActor() resolves to unsupported()");

/* ===================================================================== */
console.log("[9] Registry resolves the PF2e adapter when pf2e is active");
ok(registerSystem("pf2e", Pf2eAdapter), "registry accepts the PF2e adapter");
ok(getActiveAdapter() === Pf2eAdapter, "getActiveAdapter() resolves to Pf2eAdapter under 'pf2e'");

/* ===================================================================== */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
