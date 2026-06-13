/* =====================================================================
 *  Map / scene-awareness test for The Eternal Skald (v0.10.22).
 *
 *  v0.10.22 adds read-only map awareness: Integration._gatherSceneContext()
 *  surfaces the ACTIVE scene's name, its marked locations (journal pins →
 *  linked JournalEntry names) and its visible (non-hidden) tokens into the
 *  AI context, and gatherContext() folds that block in. The system prompt
 *  tells the Skald it can see the map and may reference those real places.
 *
 *  Integration lives inside an ESM that registers Foundry hooks at import
 *  time, so it cannot be imported in isolation. We therefore EXTRACT the
 *  _gatherSceneContext() body from the source text (brace-matched) and run
 *  it as a standalone function against mock Foundry globals — exercising the
 *  REAL logic for: graceful no-scene degradation, hidden-token exclusion,
 *  journal-pin reading, de-duplication, capping, and conciseness. We then
 *  add structural guards over gatherContext() and the system prompt.
 *
 *  Run: node test/scene-context.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readSkaldSource } from "./_skald-source.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// (Phase 2 refactor) The monolith was decomposed into scripts/<subsystem>/*.js
// modules. These source-text guards scan the whole refactored tree via the
// shared reader so relocated definitions are still seen wherever they live.
const SRC = readSkaldSource();

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; } else { failed++; console.error(`  ✗ FAIL: ${msg}\n      expected ${e}\n      got      ${a}`); }
}

/* Extract a method body by brace-matching from a starting marker. Returns
 * the full `marker { ... }` slice. (Same approach as direct-llm-fallback.) */
function extractFrom(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  const paramClose = src.indexOf(")", start);
  let i = src.indexOf("{", paramClose);
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

console.log("Map / scene-awareness test (v0.10.22)\n");

/* --------------------------------------------------------------------- *
 * Build a callable copy of _gatherSceneContext() from the source so we can
 * run the REAL logic against mocks. The method uses only the `game`,
 * `canvas`, `LOG_PREFIX` and `console` free variables (no `this`), so we
 * inject those as parameters of a wrapper function.
 * --------------------------------------------------------------------- */
const methodSrc = extractFrom(SRC, "_gatherSceneContext() {");
// methodSrc === "_gatherSceneContext() { ...body... }". Strip the signature
// to leave just the `{ ...body... }`, then wrap as an IIFE.
const bodyBraces = methodSrc.slice(methodSrc.indexOf("{"));
// eslint-disable-next-line no-new-func
const makeFn = new Function(
  "game", "canvas", "LOG_PREFIX", "console",
  `return (function() ${bodyBraces}).call(null);`
);
const LOG_PREFIX = "[Eternal Skald]";
const gather = (game, canvas) => makeFn(game, canvas, LOG_PREFIX, console);

/* Tiny mock builders -------------------------------------------------- */
const note = (entryId, text) => ({ entryId, text });
const token = (name, hidden = false) => ({ name, hidden });
const journal = (entries) => ({ get: (id) => entries[id] ?? null });
const scene = ({ name, navName, notes = [], tokens = [] } = {}) =>
  ({ name, navName, notes, tokens });

/* --------------------------------------------------------------------- *
 * [1] Graceful degradation: no active scene → "".
 * --------------------------------------------------------------------- */
eq(gather({ scenes: { active: null } }, { scene: null }), "",
   "[1] no active scene returns empty string");
eq(gather({}, {}), "", "[1] missing game/canvas returns empty string");
eq(gather(undefined, undefined), "", "[1] undefined globals return empty string");

/* --------------------------------------------------------------------- *
 * [2] A bare scene (no notes/tokens) surfaces just the name.
 * --------------------------------------------------------------------- */
{
  const g = { scenes: { active: scene({ name: "Frozen Reach" }) }, journal: journal({}) };
  const out = gather(g, {});
  eq(out, "CURRENT SCENE: Frozen Reach", "[2] bare scene shows only the scene name");
}

/* --------------------------------------------------------------------- *
 * [3] navName is preferred over name when present.
 * --------------------------------------------------------------------- */
{
  const g = { scenes: { active: scene({ name: "scene-01", navName: "The Hollow Vale" }) }, journal: journal({}) };
  ok(gather(g, {}).startsWith("CURRENT SCENE: The Hollow Vale"),
     "[3] navName takes precedence over internal name");
}

/* --------------------------------------------------------------------- *
 * [4] Journal pins → linked JournalEntry names are read as locations.
 * --------------------------------------------------------------------- */
{
  const entries = { j1: { name: "Ravenholt Keep" }, j2: { name: "The Sunless Mire" } };
  const g = {
    scenes: { active: scene({
      name: "Borderlands",
      notes: [ note("j1"), note("j2") ],
    }) },
    journal: journal(entries),
  };
  const out = gather(g, {});
  ok(/Visible Locations: .*Ravenholt Keep/.test(out), "[4] pin → linked journal name (Ravenholt Keep)");
  ok(/The Sunless Mire/.test(out), "[4] second pin → linked journal name (The Sunless Mire)");
}

/* --------------------------------------------------------------------- *
 * [5] A note's custom label text overrides the linked entry name; a note
 *     with neither text nor a resolvable entry is skipped.
 * --------------------------------------------------------------------- */
{
  const entries = { j1: { name: "Generic Entry" } };
  const g = {
    scenes: { active: scene({
      name: "Camp",
      notes: [ note("j1", "Old Watchtower"), note("missing"), note(null, "") ],
    }) },
    journal: journal(entries),
  };
  const out = gather(g, {});
  ok(/Visible Locations: Old Watchtower/.test(out), "[5] custom note text overrides entry name");
  ok(!/Generic Entry/.test(out), "[5] overridden entry name is not shown");
  ok(!/missing/.test(out), "[5] note with no text and unresolved entry is skipped");
}

/* --------------------------------------------------------------------- *
 * [6] Hidden tokens are excluded; visible ones are listed.
 * --------------------------------------------------------------------- */
{
  const g = {
    scenes: { active: scene({
      name: "Ambush Site",
      tokens: [ token("Kaori"), token("Lurking Wolf", true), token("Village Elder") ],
    }) },
    journal: journal({}),
  };
  const out = gather(g, {});
  ok(/Notable Tokens: /.test(out), "[6] notable tokens line present");
  ok(/Kaori/.test(out) && /Village Elder/.test(out), "[6] visible tokens are listed");
  ok(!/Lurking Wolf/.test(out), "[6] hidden token is EXCLUDED");
}

/* --------------------------------------------------------------------- *
 * [7] De-duplication (locations and tokens) + 12-item cap with "+N more".
 * --------------------------------------------------------------------- */
{
  // 15 unique tokens + a duplicate → expect 12 shown + "+3 more", dupe gone.
  const toks = [];
  for (let i = 1; i <= 15; i++) toks.push(token(`Foe ${i}`));
  toks.push(token("Foe 1")); // duplicate
  const g = { scenes: { active: scene({ name: "Horde", tokens: toks }) }, journal: journal({}) };
  const out = gather(g, {});
  ok(/Foe 12/.test(out) && !/Foe 13/.test(out), "[7] token list capped at 12 items");
  ok(/\+3 more/.test(out), "[7] overflow indicated as '+3 more'");
  const firstCount = (out.match(/Foe 1(?!\d)/g) || []).length;
  ok(firstCount === 1, "[7] duplicate token name de-duplicated");
}

/* --------------------------------------------------------------------- *
 * [8] Full formatted shape matches the documented layout.
 * --------------------------------------------------------------------- */
{
  const entries = { j1: { name: "The Iron Shrine" } };
  const g = {
    scenes: { active: scene({
      name: "Wilds",
      notes: [ note("j1") ],
      tokens: [ token("Skald"), token("Hidden Trap", true) ],
    }) },
    journal: journal(entries),
  };
  const out = gather(g, {});
  eq(out,
     "CURRENT SCENE: Wilds\nVisible Locations: The Iron Shrine\nNotable Tokens: Skald",
     "[8] full block matches the documented 3-line layout");
  // Token efficiency: a populated block stays compact (a few short lines).
  ok(out.split("\n").length <= 3 && out.length < 200, "[8] context string is concise");
}

/* --------------------------------------------------------------------- *
 * [9] canvas.scene fallback when game.scenes.active is absent.
 * --------------------------------------------------------------------- */
{
  const g = { journal: journal({}) }; // no scenes.active
  const c = { scene: scene({ name: "Canvas Only" }) };
  ok(gather(g, c).startsWith("CURRENT SCENE: Canvas Only"),
     "[9] falls back to canvas.scene when no active scene");
}

/* --------------------------------------------------------------------- *
 * [10] Structural guards: gatherContext() integrates the method, and the
 *      system prompt advertises map awareness.
 * --------------------------------------------------------------------- */
{
  const gc = extractFrom(SRC, "gatherContext() {");
  ok(/this\._gatherSceneContext\(\)/.test(gc),
     "[10] gatherContext() calls this._gatherSceneContext()");
  ok(/blocks\.push\(sceneCtx\)/.test(gc),
     "[10] gatherContext() pushes the scene block into the context");
}
{
  // (v0.20.0 M4) The guidance block was externalised to prompts/guidance.mjs
  // and pulled in via the prompt loader, so the map/scene wording now lives in
  // that template (the builder composes it). Same intent, sourced from the
  // template file — equal-strength guard.
  const guidanceTpl = readFileSync(join(__dirname, "..", "prompts", "guidance.mjs"), "utf8");
  ok(/can see the active map/i.test(guidanceTpl),
     "[10] system prompt states the Skald can see the map");
  ok(/CURRENT\s+SCENE/.test(guidanceTpl) && /Visible Locations/.test(guidanceTpl),
     "[10] system prompt references the scene context fields");
  ok(/never force/i.test(guidanceTpl) || /natural/i.test(guidanceTpl),
     "[10] system prompt keeps location references natural / non-forced");
  // and the builder must actually compose that guidance template into the prompt.
  const builder = readFileSync(join(__dirname, "..", "scripts", "ai", "prompt-builder.js"), "utf8");
  ok(/getPrompt\("guidance"/.test(builder), "[10] builder loads the guidance template via the loader");
}

/* --------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
