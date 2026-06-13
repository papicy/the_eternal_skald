/* =====================================================================
 *  Starforged ruleset-awareness (Phase E) guard.
 *
 *  CONTEXT: Starforged / Sundered Isles run on the SAME foundry-ironsworn
 *  system module as classic Ironsworn (one game.system.id), and are already
 *  served end-to-end by the ruleset-aware IronswornController (sfmoves
 *  catalogue, legacy-tick XP, starforged assets/encounters). A separate
 *  adapter would be WRONG — SystemRegistry keys one adapter per system id, so
 *  it would shadow the controller. The Phase E Starforged deliverable is
 *  therefore the missing piece: making the AI's SETTING/genre awareness follow
 *  the active ruleset, via prompt-builder.buildRulesetSettingBlock().
 *
 *  Layers: structural source-guards + behavioural (mock the Foundry `game`
 *  global and exercise the REAL exported function for every ruleset state).
 *
 *  Run: node test/starforged-ruleset.test.mjs
 * ===================================================================== */

import { readSkaldSource } from "./_skald-source.mjs";

// prompt-builder.js transitively pulls the module graph (which registers
// Foundry hooks at eval time), so stub the minimal Foundry globals BEFORE the
// dynamic import — exactly as load-smoke.mjs does. The behavioural cases then
// reassign `global.game` per ruleset state.
for (const name of ["Hooks", "game", "ui", "canvas", "CONFIG", "foundry", "Roll", "ChatMessage", "JournalEntry", "Handlebars", "TextEditor"]) {
  if (globalThis[name] === undefined) globalThis[name] = new Proxy(function () {}, { get: () => globalThis[name], apply: () => undefined, construct: () => ({}) });
}
if (globalThis.document === undefined) globalThis.document = {};
if (globalThis.window === undefined) globalThis.window = globalThis;

const { buildRulesetSettingBlock } = await import("../scripts/ai/prompt-builder.js");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }

const SRC = readSkaldSource();

/* ---- [1] structural wiring -------------------------------------------- */
ok(/export function buildRulesetSettingBlock\s*\(/.test(SRC), "[1] buildRulesetSettingBlock is exported");
ok(/toneBlock, rulesetBlock,/.test(SRC), "[1] rulesetBlock is inserted into the system-prompt array");
ok(/foundry-ironsworn/.test(SRC), "[1] gates on the foundry-ironsworn system id");
ok(/ruleset-starforged/.test(SRC) && /ruleset-sundered_isles/.test(SRC), "[1] reads the SF + Sundered Isles ruleset flags");

/* ---- [2] behavioural — mock the Foundry `game` global ----------------- */
function mockGame(systemId, flags = {}) {
  global.game = {
    system: { id: systemId },
    settings: { get: (sys, key) => (sys === "foundry-ironsworn" ? !!flags[key] : false) }
  };
}

mockGame("dnd5e");
ok(buildRulesetSettingBlock() === "", "[2] non-ironsworn system → no injection");

mockGame("foundry-ironsworn", { "ruleset-classic": true });
ok(buildRulesetSettingBlock() === "", "[2] classic ruleset → no injection (fantasy default)");

mockGame("foundry-ironsworn", { "ruleset-delve": true });
ok(buildRulesetSettingBlock() === "", "[2] delve ruleset → no injection (fantasy default)");

mockGame("foundry-ironsworn", {});
ok(buildRulesetSettingBlock() === "", "[2] no ruleset flag set → no injection (safe default)");

mockGame("foundry-ironsworn", { "ruleset-starforged": true });
const sf = buildRulesetSettingBlock();
ok(/STARFORGED/.test(sf), "[2] starforged ruleset → STARFORGED setting block");
ok(/LEGACY TRACKS/.test(sf) && /Quests, Bonds and/.test(sf), "[2] SF block names the legacy tracks");

mockGame("foundry-ironsworn", { "ruleset-sundered_isles": true });
const si = buildRulesetSettingBlock();
ok(/SUNDERED ISLES/.test(si), "[2] sundered isles ruleset → SUNDERED ISLES setting block");

// classic + starforged both on → classic wins (matches character.js getRuleset priority)
mockGame("foundry-ironsworn", { "ruleset-classic": true, "ruleset-starforged": true });
ok(buildRulesetSettingBlock() === "", "[2] classic takes priority over SF (parity with getRuleset)");

// never throws when game is absent
delete global.game;
ok(buildRulesetSettingBlock() === "", "[2] missing game global → no injection, no throw");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
