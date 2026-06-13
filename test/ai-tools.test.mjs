/* =====================================================================
 *  AI TOOL-CALLING (F5) guard — registry + executor.
 *
 *  Locks the PURE function-calling layer added in Phase E:
 *    • registry.js  — TOOL_REGISTRY shape, findTool, buildToolSpecs
 *                     (capability filtering must hide tools the system can't
 *                      honour, and always include the always-on journal tool).
 *    • executor.js  — parseToolCalls (OpenAI + pre-parsed shapes, bad JSON),
 *                     validateToolCall (required args, type + enum checks),
 *                     executeToolCalls (routes to injected handlers, captures
 *                     handler errors and unbound/unknown tools as soft fails).
 *
 *  These modules are pure ESM with zero Foundry imports, so the test imports
 *  the REAL shipped source directly.
 *
 *  Run: node test/ai-tools.test.mjs
 * ===================================================================== */

import { TOOL_REGISTRY, findTool, buildToolSpecs } from "../scripts/ai/tools/registry.js";
import { parseToolCalls, validateToolCall, executeToolCalls } from "../scripts/ai/tools/executor.js";

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

/* ---------------- registry ---------------- */
ok(Array.isArray(TOOL_REGISTRY) && TOOL_REGISTRY.length === 4, "registry has 4 tools");
ok(Object.isFrozen(TOOL_REGISTRY), "registry is frozen");
for (const t of TOOL_REGISTRY) {
  ok(typeof t.name === "string" && t.name, `tool ${t.name} has a name`);
  ok(typeof t.handler === "string" && t.handler, `tool ${t.name} has a handler`);
  ok(t.parameters && t.parameters.type === "object", `tool ${t.name} has object params`);
}
eq(findTool("rollMove")?.handler, "rollMove", "findTool resolves rollMove");
eq(findTool("nope"), null, "findTool unknown → null");
eq(findTool(), null, "findTool no-arg → null");

/* buildToolSpecs: capability filtering */
const fullCaps = { moves: true, oracles: true, progressTracks: true };
const fullSpecs = buildToolSpecs(fullCaps);
eq(fullSpecs.length, 4, "all 4 tools offered when caps fully enabled");
ok(fullSpecs.every(s => s.type === "function" && s.function?.name), "specs are OpenAI function shape");

const noCaps = buildToolSpecs({});
eq(noCaps.length, 1, "only the always-on journal tool when no caps");
eq(noCaps[0].function.name, "createJournalEntry", "journal tool is capability-null");

const partial = buildToolSpecs({ oracles: true });
eq(partial.length, 2, "oracle + journal offered when only oracles enabled");
ok(partial.some(s => s.function.name === "queryOracle"), "queryOracle present");
ok(!partial.some(s => s.function.name === "rollMove"), "rollMove hidden without moves cap");

/* ---------------- parseToolCalls ---------------- */
eq(parseToolCalls(undefined).length, 0, "parse undefined → []");
eq(parseToolCalls({}).length, 0, "parse no tool_calls → []");
const openAiShape = parseToolCalls({ tool_calls: [
  { id: "c1", function: { name: "rollMove", arguments: '{"move":"Face Danger","stat":"edge"}' } }
] });
eq(openAiShape.length, 1, "parses one openai tool call");
eq(openAiShape[0].name, "rollMove", "parsed name");
eq(openAiShape[0].args.move, "Face Danger", "parsed JSON args");
const badJson = parseToolCalls({ tool_calls: [{ function: { name: "x", arguments: "{not json" } }] });
eq(badJson[0].args && typeof badJson[0].args, "object", "bad JSON args → {}");
ok(badJson[0].id, "missing id is synthesised");
const preParsed = parseToolCalls({ tool_calls: [{ name: "queryOracle", args: { oracle: "Action" } }] });
eq(preParsed[0].args.oracle, "Action", "pre-parsed args shape supported");

/* ---------------- validateToolCall ---------------- */
ok(validateToolCall("rollMove", { move: "Face Danger" }).ok, "valid rollMove passes");
ok(!validateToolCall("rollMove", {}).ok, "rollMove without required move fails");
ok(!validateToolCall("ghost", {}).ok, "unknown tool fails");
ok(!validateToolCall("updateProgress", { track: "Vow", action: "boom" }).ok, "bad enum fails");
ok(validateToolCall("updateProgress", { track: "Vow", action: "set", value: 3 }).ok, "good enum + number passes");
ok(!validateToolCall("updateProgress", { track: "Vow", value: "three" }).ok, "wrong type fails");

/* ---------------- executeToolCalls ---------------- */
const log = [];
const handlers = {
  rollMove: async (a) => { log.push(["move", a.move]); return { ok: true, move: a.move }; },
  queryOracle: async () => { throw new Error("oracle boom"); }
  // updateProgress + createJournalEntry intentionally unbound
};
const results = await executeToolCalls([
  { id: "1", name: "rollMove", args: { move: "Face Danger" } },
  { id: "2", name: "queryOracle", args: { oracle: "Action" } },
  { id: "3", name: "updateProgress", args: { track: "Vow" } },
  { id: "4", name: "ghost", args: {} }
], handlers);
eq(results.length, 4, "one result per call");
ok(results[0].ok && results[0].result.move === "Face Danger", "bound handler runs");
ok(!results[1].ok && /oracle boom/.test(results[1].error), "handler throw captured");
ok(!results[2].ok && /no handler/.test(results[2].error), "unbound handler → soft fail");
ok(!results[3].ok && /unknown tool/.test(results[3].error), "unknown tool → soft fail");
eq((await executeToolCalls([], handlers)).length, 0, "empty calls → []");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
