/* =====================================================================
 *  Move-declaration detection test for The Eternal Skald (v0.10.33).
 *
 *  Exercises IronswornController.detectMoveDeclaration() — the conservative
 *  heuristic that decides whether a free-form "!" message is the PLAYER
 *  NAMING an official Ironsworn move (→ open the roll dialog, suppress AI
 *  narration) versus a narrative request / rules question (→ narrate).
 *
 *  This is the core of the "player agency for mechanical actions" rule:
 *  declared moves open dialogs, they are never AI interpretations.
 *
 *  Pure node, no Foundry — globals are stubbed before import.
 *
 *  Run: node test/move-declaration.test.mjs
 * ===================================================================== */

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

/* ---- Minimal Foundry globals (controller imports cleanly with these) ---- */
function getProperty(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
globalThis.foundry = { utils: { getProperty, setProperty: () => {} } };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.game = { system: { id: "foundry-ironsworn" }, user: { isGM: true }, settings: { get: () => undefined } };
globalThis.canvas = { tokens: { controlled: [] } };
globalThis.CONFIG = { Item: { dataModels: {} } };

const { default: Ctrl } = await import("../scripts/ironsworn-controller.js");

/** Helper: detect and return the resolved move name (or null). */
function name(text) {
  const d = Ctrl.detectMoveDeclaration(text);
  return d?.move?.name ?? null;
}

console.log("[1] bare move names are declarations (exact match)");
{
  eq(name("Face Danger"), "Face Danger", "Face Danger");
  eq(name("Strike"), "Strike", "Strike");
  eq(name("strike"), "Strike", "lowercase strike");
  eq(name("SECURE AN ADVANTAGE"), "Secure an Advantage", "uppercase");
  eq(name("Make Camp"), "Make Camp", "Make Camp (leading word collides with 'make' strip)");
  eq(name("Swear an Iron Vow"), "Swear an Iron Vow", "Swear an Iron Vow");
  eq(name("Reach a Milestone"), "Reach a Milestone", "Reach a Milestone");
}

console.log("[2] intention phrases are stripped, move still detected");
{
  eq(name("I want to Face Danger"), "Face Danger", "I want to …");
  eq(name("let me Strike"), "Strike", "let me …");
  eq(name("I'll Secure an Advantage"), "Secure an Advantage", "I'll …");
  eq(name("roll Face Danger"), "Face Danger", "roll …");
  eq(name("make the Compel move"), "Compel", "make the … move");
  eq(name("I'm going to Endure Harm"), "Endure Harm", "I'm going to …");
  eq(name("I face danger"), "Face Danger", "I <move>");
  eq(name("do a Gather Information"), "Gather Information", "do a …");
}

console.log("[3] trailing stat is parsed and validated");
{
  const a = Ctrl.detectMoveDeclaration("Face Danger +iron");
  eq(a?.move?.name, "Face Danger", "Face Danger +iron → move");
  eq(a?.stat, "iron", "Face Danger +iron → stat iron");
  const b = Ctrl.detectMoveDeclaration("Secure an Advantage with wits");
  eq(b?.move?.name, "Secure an Advantage", "with wits → move");
  eq(b?.stat, "wits", "with wits → stat wits");
  const c = Ctrl.detectMoveDeclaration("I want to Strike using edge");
  eq(c?.move?.name, "Strike", "using edge → move");
  eq(c?.stat, "edge", "using edge → stat edge");
  // Invalid stat for the move is dropped (Heal rolls wits/iron, not shadow).
  const d = Ctrl.detectMoveDeclaration("Heal +shadow");
  eq(d?.move?.name, "Heal", "Heal +shadow → move");
  eq(d?.stat, "", "invalid stat dropped");
}

console.log("[4] multi-word moves accept a short trailing target (prefix)");
{
  eq(name("Secure an Advantage over the bandit"), "Secure an Advantage", "… over the bandit");
  eq(name("Gather Information from the elder"), "Gather Information", "… from the elder");
  eq(name("Undertake a Journey to the coast"), "Undertake a Journey", "… to the coast");
}

console.log("[5] questions & narration requests are NOT declarations");
{
  eq(name("What should I do?"), null, "question mark");
  eq(name("how do I face danger"), null, "starts with 'how'");
  eq(name("should I strike now"), null, "starts with 'should'");
  eq(name("tell me about the barrow"), null, "tell me …");
  eq(name("describe the misty hall"), null, "describe …");
  eq(name("continue the story"), null, "continue …");
  eq(name("what lurks in the dark"), null, "what lurks …");
  eq(name("narrate my journey"), null, "narrate …");
}

console.log("[6] single-word moves do NOT prefix-match narrative prose");
{
  eq(name("strike fear into their hearts"), null, "strike fear … (narration, not Strike)");
  eq(name("heal the rift between the clans someday"), null, "heal … long narration");
  eq(name("clash of steel rang through the hall"), null, "clash of steel … narration");
  // Conservative: a single-word move name + target is treated as narration
  // (the bare move name alone IS detected — see test [1]).
  eq(name("Compel the merchant"), null, "Compel the merchant (single-word + target → narrate)");
}

console.log("[7] multi-word prefix rejects narration connectors & long tails");
{
  eq(name("Face Danger and then flee into the woods at night"), null, "connector 'and' + long tail");
  eq(name("Battle because the village is burning down tonight"), null, "connector 'because'");
}

console.log("[8] junk / empty input degrades gracefully");
{
  eq(name(""), null, "empty");
  eq(name("   "), null, "whitespace");
  eq(name("xyzzy not a move"), null, "non-move text");
  eq(Ctrl.detectMoveDeclaration(null), null, "null input");
  eq(Ctrl.detectMoveDeclaration(undefined), null, "undefined input");
  eq(Ctrl.detectMoveDeclaration(42), null, "non-string input");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
