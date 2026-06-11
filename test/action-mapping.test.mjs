/* =====================================================================
 *  Intelligent action → move mapping test for The Eternal Skald (v0.10.34).
 *
 *  Exercises the PURE half of the hybrid action classifier on
 *  IronswornController:
 *    • buildActionClassifierPrompt() — prompt construction & grounding
 *    • parseActionClassification()   — defensive JSON parsing + validation
 *    • decideActionRouting()         — roll / confirm / narrate routing
 *
 *  The actual AI call lives in eternal-skald.js and is NOT exercised here;
 *  we feed canned classifier replies (the strings the model would return)
 *  and assert the parse + decision behaviour, which is where all the
 *  branching logic lives.
 *
 *  Pure node, no Foundry — globals are stubbed before import.
 *
 *  Run: node test/action-mapping.test.mjs
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

/* Convenience: build a JSON reply string the model might return. */
function reply(type, moves, reason = "") {
  return JSON.stringify({ type, moves, reason });
}

/* ===================================================================== */
console.log("[1] buildActionClassifierPrompt grounds on real moves & triggers");
{
  const { system, user } = Ctrl.buildActionClassifierPrompt("I search the ruins");
  ok(typeof system === "string" && system.length > 0, "system prompt is a non-empty string");
  ok(typeof user === "string" && user.includes("I search the ruins"), "user prompt embeds the message");
  ok(system.includes("Gather Information"), "move list includes Gather Information");
  ok(system.includes("Face Danger"), "move list includes Face Danger");
  ok(system.includes("action") && system.includes("question") && system.includes("roleplay"),
     "system prompt names all three intents");
  ok(/STRICT JSON/i.test(system), "system prompt demands strict JSON");
  // Scene context is injected when provided.
  const withCtx = Ctrl.buildActionClassifierPrompt("I attack", { sceneContext: "In combat." });
  ok(withCtx.user.includes("In combat."), "scene context is included in the user prompt");
}

console.log("[2] parseActionClassification — clean JSON, valid move");
{
  const p = Ctrl.parseActionClassification(reply("action", [{ name: "Gather Information", stat: "wits", confidence: "high" }], "searching"));
  ok(p !== null, "parsed non-null");
  eq(p.type, "action", "type is action");
  eq(p.moves.length, 1, "one move");
  eq(p.moves[0].name, "Gather Information", "move name resolved");
  eq(p.moves[0].stat, "wits", "stat kept (valid for the move)");
  eq(p.moves[0].confidence, "high", "confidence kept");
  ok(p.moves[0].move && p.moves[0].move.id === "move:classic/adventure/gather_information", "real catalog move attached");
}

console.log("[3] parseActionClassification — tolerates code fences & stray prose");
{
  const fenced = "```json\n" + reply("action", [{ name: "Strike", stat: "iron", confidence: "high" }]) + "\n```";
  const p1 = Ctrl.parseActionClassification(fenced);
  ok(p1 && p1.moves[0]?.name === "Strike", "parses fenced JSON");
  const messy = "Sure! Here is the classification: " + reply("roleplay", []) + " hope that helps";
  const p2 = Ctrl.parseActionClassification(messy);
  ok(p2 && p2.type === "roleplay", "extracts JSON embedded in prose");
}

console.log("[4] parseActionClassification — drops invalid move names & bad stats");
{
  const p = Ctrl.parseActionClassification(reply("action", [
    { name: "Totally Not A Move", stat: "iron", confidence: "high" },
    { name: "Gather Information", stat: "iron", confidence: "high" } // iron invalid for GI (wits only)
  ]));
  eq(p.moves.length, 1, "invalid move name dropped");
  eq(p.moves[0].name, "Gather Information", "valid move kept");
  eq(p.moves[0].stat, "", "invalid stat blanked");
}

console.log("[5] parseActionClassification — defensive on garbage");
{
  eq(Ctrl.parseActionClassification(""), null, "empty string → null");
  eq(Ctrl.parseActionClassification("not json at all"), null, "non-JSON, no braces → null");
  eq(Ctrl.parseActionClassification("{ broken json"), null, "broken JSON → null");
  eq(Ctrl.parseActionClassification(null), null, "null → null");
  // Unknown type degrades to roleplay (safe, non-actionable).
  const p = Ctrl.parseActionClassification(JSON.stringify({ type: "weird", moves: [] }));
  eq(p.type, "roleplay", "unknown type → roleplay");
}

console.log("[6] decideActionRouting — question & roleplay always narrate");
{
  const q = Ctrl.decideActionRouting(Ctrl.parseActionClassification(reply("question", [])));
  eq(q.action, "narrate", "question → narrate");
  const rp = Ctrl.decideActionRouting(Ctrl.parseActionClassification(reply("roleplay", [])));
  eq(rp.action, "narrate", "roleplay → narrate");
  eq(Ctrl.decideActionRouting(null).action, "narrate", "null parse → narrate");
}

console.log("[7] decideActionRouting — single high-confidence action rolls directly");
{
  const d = Ctrl.decideActionRouting(Ctrl.parseActionClassification(
    reply("action", [{ name: "Gather Information", stat: "wits", confidence: "high" }])));
  eq(d.action, "roll", "single high → roll");
  eq(d.move.name, "Gather Information", "rolls the right move");
  eq(d.stat, "wits", "carries the stat");
}

console.log("[8] decideActionRouting — single medium-confidence asks for confirmation");
{
  const d = Ctrl.decideActionRouting(Ctrl.parseActionClassification(
    reply("action", [{ name: "Face Danger", stat: "iron", confidence: "medium" }])));
  eq(d.action, "confirm", "single medium → confirm");
  eq(d.candidates.length, 1, "one candidate offered");
  eq(d.candidates[0].name, "Face Danger", "candidate is Face Danger");
}

console.log("[9] decideActionRouting — single low-confidence falls through to narration");
{
  const d = Ctrl.decideActionRouting(Ctrl.parseActionClassification(
    reply("action", [{ name: "Face Danger", stat: "", confidence: "low" }])));
  eq(d.action, "narrate", "single low → narrate");
}

console.log("[10] decideActionRouting — ambiguous (multiple moves) → confirm card");
{
  const d = Ctrl.decideActionRouting(Ctrl.parseActionClassification(
    reply("action", [
      { name: "Strike", stat: "iron", confidence: "high" },
      { name: "Clash", stat: "iron", confidence: "medium" }
    ], "depends on initiative")));
  eq(d.action, "confirm", "two moves → confirm");
  eq(d.candidates.length, 2, "both candidates offered");
  eq(d.reason, "depends on initiative", "reason carried through");
}

console.log("[11] decideActionRouting — alwaysConfirm forces a card even for high confidence");
{
  const parsed = Ctrl.parseActionClassification(
    reply("action", [{ name: "Gather Information", stat: "wits", confidence: "high" }]));
  const def = Ctrl.decideActionRouting(parsed, { alwaysConfirm: false });
  eq(def.action, "roll", "default → roll");
  const forced = Ctrl.decideActionRouting(parsed, { alwaysConfirm: true });
  eq(forced.action, "confirm", "alwaysConfirm → confirm even for high confidence");
  eq(forced.candidates[0].name, "Gather Information", "candidate preserved");
}

console.log("[12] decideActionRouting — action with zero valid moves narrates");
{
  const d = Ctrl.decideActionRouting(Ctrl.parseActionClassification(
    reply("action", [{ name: "Imaginary Move", confidence: "high" }])));
  eq(d.action, "narrate", "action but no resolvable move → narrate");
}

/* ===================================================================== */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
