/* =====================================================================
 *  Progress-track WRITE + story-arc + roll-integration test (v0.10.27).
 *
 *  Covers the new write surface added in v0.10.27:
 *    • Combat-foe labelling FIX — combat tracks are stored as subtype
 *      "progress" (not the un-localized "foe") + trackKind "combat" flag,
 *      and normalizeCombatTrackSubtypes() migrates legacy "foe" tracks.
 *    • Phase 2 story-arc flags — setActiveVow/getActiveVow,
 *      setActiveCombat/getActiveCombat(flag), identifyStoryFocusVow priority,
 *      and auto-sync of the flags when progress is marked.
 *    • Phase 3 write directives — findTrackFuzzy, setProgress, markProgress,
 *      completeTrack, plus the [[MARK_COMPLETE / ADD_PROGRESS / SET_PROGRESS]]
 *      PARSER (extracted from the source) incl. malformed / error cases.
 *    • Phase 4 roll integration — _completionMoveKind classification of the
 *      completion moves ("Fulfill Your Vow" / "End the Fight" / "Reach Your
 *      Destination") used to drive strong-hit auto-completion.
 *
 *  Run: node test/progress-track-writes.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readSkaldSource } from "./_skald-source.mjs";

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) {
  const same = (a === b) || (JSON.stringify(a) === JSON.stringify(b));
  ok(same, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

/* ---- Faithful replica of foundry-ironsworn's ProgressModel cleaning ---- */
const CHALLENGE_RANK = { troublesome: 1, dangerous: 2, formidable: 3, extreme: 4, epic: 5 };
function castRank(value) {
  if (value === "formidible") return 3;
  if (typeof value === "string") return CHALLENGE_RANK[value.toLowerCase()];
  if (typeof value === "number") return value;
  return undefined;
}
const PROGRESS_FIELDS = new Set([
  "subtype", "starred", "hasTrack", "hasClock", "clockTicks", "clockMax",
  "completed", "current", "description", "rank"
]);
function cleanProgressSystem(raw = {}) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) if (PROGRESS_FIELDS.has(k)) out[k] = v;
  out.subtype   = typeof out.subtype === "string" ? out.subtype : "progress";
  out.starred   = !!out.starred;
  out.hasTrack  = out.hasTrack === undefined ? true : !!out.hasTrack;
  out.hasClock  = !!out.hasClock;
  out.completed = !!out.completed;
  let cur = Number.isFinite(out.current) ? Math.trunc(out.current) : 0;
  out.current = Math.max(0, Math.min(40, cur));
  let rank = castRank(out.rank);
  if (!Number.isInteger(rank)) rank = 1;
  out.rank = Math.max(1, Math.min(5, rank));
  return out;
}

/* ---- Minimal Foundry globals ---- */
function getProperty(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setProperty(obj, path, value) {
  const keys = path.split("."); let o = obj;
  while (keys.length > 1) { const k = keys.shift(); o[k] = o[k] ?? {}; o = o[k]; }
  o[keys[0]] = value;
}
globalThis.foundry = { utils: { getProperty, setProperty } };
globalThis.CONFIG = { Item: { dataModels: {
  "asset": {}, "progress": {}, "ledger-entry": {}, "bondset": {},
  "sfmove": {}, "delve-theme": {}, "delve-domain": {}
} } };
let notifications = [];
globalThis.ui = { notifications: { info: (m) => notifications.push(m), warn: () => {}, error: () => {} } };

let _id = 0;
class MockItem {
  constructor(data, parent) {
    this.id = data._id ?? `item${++_id}`;
    this.name = data.name;
    this.type = data.type;
    this.sort = data.sort ?? 0;
    this.flags = data.flags ?? {};
    this._stats = { createdTime: data._stats?.createdTime ?? Date.now() + _id };
    this.parent = parent;
    this.system = data.type === "progress" ? cleanProgressSystem(data.system ?? {}) : (data.system ?? {});
  }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  async setFlag(scope, key, val) { (this.flags[scope] ??= {})[key] = val; return this; }
  async update(changes) {
    for (const [path, value] of Object.entries(changes)) {
      // Re-clean the system block when subtype/current/etc. change so the mock
      // mirrors the real data-model coercion.
      setProperty(this, path, value);
    }
    if (this.type === "progress") this.system = cleanProgressSystem(this.system);
    return this;
  }
}
class MockCollection extends Array { get(id) { return this.find(i => i.id === id) ?? null; } }
class MockActor {
  constructor(type = "character") {
    this.id = `actor${++_id}`;
    this.name = "Test Skald";
    this.type = type;
    this.items = new MockCollection();
    this.flags = {};
  }
  async createEmbeddedDocuments(_kind, dataList) {
    const created = dataList.map(d => new MockItem(d, this));
    this.items.push(...created);
    return created;
  }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  async setFlag(scope, key, val) { (this.flags[scope] ??= {})[key] = val; return this; }
  async unsetFlag(scope, key) { if (this.flags?.[scope]) delete this.flags[scope][key]; return this; }
  testUserPermission() { return true; }
}
globalThis.game = { user: { id: "u1" }, actors: [] };
globalThis.canvas = { tokens: { controlled: [] } };

/* ===================================================================== */
const { default: Ctrl } = await import("../scripts/ironsworn-controller.js");

/* Extract a stand-alone function body by brace-matching (same approach as
 * scene-context.test.mjs) so we can exercise the REAL parser logic. */
function extractFn(src, marker) {
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
const __dirname = dirname(fileURLToPath(import.meta.url));
// (Phase 2 refactor) The monolith was decomposed into scripts/<subsystem>/*.js
// modules. This source-text guard scans the whole refactored tree via the
// shared reader so relocated definitions are still seen wherever they live.
const SRC = readSkaldSource();
// _parseWriteDirective(verb, body) and _completionMoveKind(moveName) use no
// `this`, so we can lift them straight out as plain functions.
const _parseWriteDirective = new Function(
  "return (" + extractFn(SRC, "_parseWriteDirective(verb, body)").replace(/^_parseWriteDirective/, "function _parseWriteDirective") + ")"
)();
const _completionMoveKind = new Function(
  "return (" + extractFn(SRC, "_completionMoveKind(moveName)").replace(/^_completionMoveKind/, "function _completionMoveKind") + ")"
)();
// _isProgressMove(dsid, name) lives in the root-level ironsworn-controller.js,
// which the shared corpus deliberately excludes — read that file directly. It
// uses no `this`, so we can lift it out as a plain function.
const CTRL_SRC = readFileSync(join(__dirname, "..", "scripts", "ironsworn-controller.js"), "utf8");
const _isProgressMove = new Function(
  "return (" + extractFn(CTRL_SRC, "_isProgressMove(dsid, name)").replace(/^_isProgressMove/, "function _isProgressMove") + ")"
)();

console.log("Progress-track WRITE / story-arc / roll-integration test (v0.10.27)\n");

/* --------------------------------------------------------------------- */
console.log("[1] combat-foe labelling FIX — subtype 'progress', not 'foe'");
{
  const actor = new MockActor();
  const cr = await Ctrl.createProgressTrack(actor, "Bog Rot", "combat", "dangerous");
  ok(cr.ok, "combat track created");
  const item = actor.items.get(cr.id);
  eq(item.system.subtype, "progress", "combat subtype is 'progress' (clean label, not raw SubtypeFoe)");
  eq(item.flags["the-eternal-skald"].trackKind, "combat", "combat trackKind flag set");
  ok(Ctrl.getCombatTracks(actor).some(t => t.name === "Bog Rot"), "getCombatTracks detects it via the flag");
  eq(Ctrl.getActiveCombatTrack(actor)?.name, "Bog Rot", "active combat track found");
}

/* --------------------------------------------------------------------- */
console.log("[2] normalizeCombatTrackSubtypes — legacy 'foe' migration");
{
  const actor = new MockActor();
  // A legacy combat track stored the old way (subtype 'foe' + combat flag).
  await actor.createEmbeddedDocuments("Item", [
    { name: "Old Bear", type: "progress", flags: { "the-eternal-skald": { trackKind: "combat" } }, system: { subtype: "foe", rank: 2, current: 8 } },
    // A real foe-Actor's own progress item would have NO combat flag — must be left alone.
    { name: "Sheet Foe", type: "progress", system: { subtype: "foe", rank: 2, current: 4 } }
  ]);
  const res = await Ctrl.normalizeCombatTrackSubtypes(actor);
  ok(res.ok, "normalize ran");
  ok(res.fixed.includes("Old Bear"), "legacy combat-flagged track migrated");
  ok(!res.fixed.includes("Sheet Foe"), "non-flagged foe item left untouched");
  eq(actor.items.find(i => i.name === "Old Bear").system.subtype, "progress", "Old Bear now subtype 'progress'");
  eq(actor.items.find(i => i.name === "Sheet Foe").system.subtype, "foe", "Sheet Foe still subtype 'foe'");
  // Idempotent — a second run fixes nothing.
  const again = await Ctrl.normalizeCombatTrackSubtypes(actor);
  eq(again.fixed.length, 0, "idempotent: second run migrates nothing");
}

/* --------------------------------------------------------------------- */
console.log("[3] Phase 2 — setActiveVow / getActiveVow (+ validation)");
{
  const actor = new MockActor();
  const v = await Ctrl.createProgressTrack(actor, "The Truth of the Star-Fall", "vow", "formidable");
  eq(Ctrl.getActiveVow(actor), null, "no active vow before it is set");
  const setR = await Ctrl.setActiveVow(actor, v.id);
  ok(setR.ok, "setActiveVow ok");
  eq(Ctrl.getActiveVow(actor)?.name, "The Truth of the Star-Fall", "getActiveVow returns the flagged vow");
  // Completing the vow makes the flag stale → getActiveVow returns null.
  await actor.items.get(v.id).update({ "system.completed": true });
  eq(Ctrl.getActiveVow(actor), null, "completed vow is not returned (self-heals)");
  // Set by name also works, and unset via null clears it.
  const v2 = await Ctrl.createProgressTrack(actor, "Avenge the Burned Hall", "vow", "dangerous");
  await Ctrl.setActiveVow(actor, "Avenge the Burned Hall");
  eq(Ctrl.getActiveVow(actor)?.id, v2.id, "setActiveVow by name resolves");
  await Ctrl.setActiveVow(actor, null);
  eq(Ctrl.getActiveVow(actor), null, "setActiveVow(null) clears the flag");
}

/* --------------------------------------------------------------------- */
console.log("[4] Phase 2 — setActiveCombat / getActiveCombat prefers flag");
{
  const actor = new MockActor();
  const c1 = await Ctrl.createProgressTrack(actor, "Frost Wolf", "combat", "dangerous");
  const c2 = await Ctrl.createProgressTrack(actor, "Cave Bear", "combat", "formidable");
  // Without a flag, getActiveCombat falls back to newest-open (Cave Bear).
  eq(Ctrl.getActiveCombat(actor)?.name, "Cave Bear", "fallback to newest-open combat");
  // Flag the OLDER fight as active — getActiveCombat must now prefer it.
  await Ctrl.setActiveCombat(actor, c1.id);
  eq(Ctrl.getActiveCombat(actor)?.name, "Frost Wolf", "getActiveCombat prefers the active-combat flag");
  // Completing the flagged combat makes the flag stale → fall back again.
  await actor.items.get(c1.id).update({ "system.completed": true });
  eq(Ctrl.getActiveCombat(actor)?.name, "Cave Bear", "stale combat flag self-heals to fallback");
  await Ctrl.clearActiveCombat(actor);
  eq(Ctrl.getActiveCombat(actor)?.name, "Cave Bear", "clearActiveCombat leaves heuristic intact");
}

/* --------------------------------------------------------------------- */
console.log("[5] Phase 2 — identifyStoryFocusVow prioritises the active flag");
{
  const actor = new MockActor();
  const a = await Ctrl.createProgressTrack(actor, "Vow Alpha", "vow", "formidable");
  const b = await Ctrl.createProgressTrack(actor, "Vow Beta", "vow", "formidable");
  // Newest-open fallback would pick Beta; flag Alpha and expect Alpha.
  await Ctrl.setActiveVow(actor, a.id);
  eq(Ctrl.identifyStoryFocusVow(actor)?.name, "Vow Alpha", "story focus follows the active-vow flag");
}

/* --------------------------------------------------------------------- */
console.log("[6] Phase 2 — markProgress auto-syncs the active flag");
{
  const actor = new MockActor();
  const v = await Ctrl.createProgressTrack(actor, "Reclaim the Old Throne", "vow", "dangerous");
  await Ctrl.markProgress(actor, v.id, 8);
  eq(Ctrl.getActiveVow(actor)?.id, v.id, "marking vow progress sets it active");
  const c = await Ctrl.createProgressTrack(actor, "Iron Revenant", "combat", "formidable");
  await Ctrl.markProgress(actor, c.id, 4);
  eq(Ctrl.getActiveCombat(actor)?.id, c.id, "marking combat progress sets it active");
}

/* --------------------------------------------------------------------- */
console.log("[7] findTrackFuzzy — exact, substring, fuzzy, kind filter");
{
  const actor = new MockActor();
  const v = await Ctrl.createProgressTrack(actor, "The Truth of the Star-Fall", "vow", "formidable");
  await Ctrl.createProgressTrack(actor, "The Long Road North", "journey", "dangerous");
  const c = await Ctrl.createProgressTrack(actor, "Star-Fall Wraith", "combat", "formidable");
  eq(Ctrl.findTrackFuzzy(actor, "The Truth of the Star-Fall", "vow")?.id, v.id, "exact name + kind");
  eq(Ctrl.findTrackFuzzy(actor, "Truth of the Star-Fall", "vow")?.id, v.id, "substring match");
  eq(Ctrl.findTrackFuzzy(actor, "truth star fall", "vow")?.id, v.id, "fuzzy word-overlap match");
  // Kind filter prevents matching the wrong track when names overlap.
  eq(Ctrl.findTrackFuzzy(actor, "Star-Fall", "combat")?.id, c.id, "kind filter selects the combat track");
  ok(!Ctrl.findTrackFuzzy(actor, "Completely Unrelated Name", "vow"), "no false positive for unrelated name");
  ok(!Ctrl.findTrackFuzzy(actor, "The Long Road North", "vow"), "kind mismatch returns null");
}

/* --------------------------------------------------------------------- */
console.log("[8] setProgress — absolute boxes, clamping, flag sync");
{
  const actor = new MockActor();
  const v = await Ctrl.createProgressTrack(actor, "Forge the Alliance", "vow", "formidable");
  let r = await Ctrl.setProgress(actor, v.id, 8);
  ok(r.ok, "setProgress ok");
  eq(r.boxes, 8, "8 boxes set");
  eq(actor.items.get(v.id).system.current, 32, "8 boxes = 32 ticks");
  r = await Ctrl.setProgress(actor, v.id, 99);
  eq(r.boxes, 10, "over-cap clamped to 10 boxes");
  r = await Ctrl.setProgress(actor, v.id, -5);
  eq(r.boxes, 0, "negative clamped to 0 boxes");
  r = await Ctrl.setProgress(actor, "No Such Track", 4);
  ok(!r.ok && /not found/i.test(r.error), "missing track errors gracefully");
  r = await Ctrl.setProgress(actor, v.id, "abc");
  ok(!r.ok && /invalid/i.test(r.error), "non-numeric box count errors gracefully");
}

/* --------------------------------------------------------------------- */
console.log("[9] markProgress add + completeTrack");
{
  const actor = new MockActor();
  const v = await Ctrl.createProgressTrack(actor, "End the Long Winter", "vow", "dangerous");
  let r = await Ctrl.markProgress(actor, v.id, 8); // +2 boxes
  eq(r.boxes, 2, "added 2 boxes");
  r = await Ctrl.completeTrack(actor, v.id);
  ok(r.ok, "completeTrack ok");
  eq(actor.items.get(v.id).system.completed, true, "track marked completed");
  r = await Ctrl.completeTrack(actor, "Ghost Track");
  ok(!r.ok, "completeTrack on missing track errors");
}

/* --------------------------------------------------------------------- */
console.log("[10] write-directive PARSER — MARK_COMPLETE / ADD/SET_PROGRESS");
{
  eq(_parseWriteDirective("MARK_COMPLETE", "vow:The Truth of the Star-Fall"),
     { kind: "mark_complete", trackKind: "vow", name: "The Truth of the Star-Fall" }, "MARK_COMPLETE vow");
  eq(_parseWriteDirective("MARK_COMPLETE", "combat:Bog Rot"),
     { kind: "mark_complete", trackKind: "combat", name: "Bog Rot" }, "MARK_COMPLETE combat");
  eq(_parseWriteDirective("ADD_PROGRESS", "vow:The Truth of the Star-Fall:2"),
     { kind: "add_progress", trackKind: "vow", name: "The Truth of the Star-Fall", boxes: 2 }, "ADD_PROGRESS with boxes");
  eq(_parseWriteDirective("SET_PROGRESS", "journey:The Long Road North:8"),
     { kind: "set_progress", trackKind: "journey", name: "The Long Road North", boxes: 8 }, "SET_PROGRESS with boxes");
  // Error / malformed cases.
  eq(_parseWriteDirective("MARK_COMPLETE", "bogus:Name"), null, "invalid kind rejected");
  eq(_parseWriteDirective("MARK_COMPLETE", "vow"), null, "missing name rejected");
  eq(_parseWriteDirective("ADD_PROGRESS", "vow:Name"), null, "ADD_PROGRESS without number rejected");
  eq(_parseWriteDirective("SET_PROGRESS", "vow:Name:notanumber"), null, "non-numeric boxes rejected");
}

/* --------------------------------------------------------------------- */
console.log("[11] Phase 4 — _completionMoveKind classification");
{
  eq(_completionMoveKind("Fulfill Your Vow"), "vow", "Fulfill Your Vow → vow");
  eq(_completionMoveKind("fulfill your vow: The Truth"), "vow", "case-insensitive + trailing text");
  eq(_completionMoveKind("End the Fight"), "combat", "End the Fight → combat");
  eq(_completionMoveKind("Reach Your Destination"), "journey", "Reach Your Destination → journey");
  eq(_completionMoveKind("Strike"), null, "non-completion move → null");
  eq(_completionMoveKind("Undertake a Journey"), null, "advancing move is NOT a completion move");
}

/* --------------------------------------------------------------------- */
console.log("[12] v0.11.0 — _isProgressMove recognises all three completion moves");
{
  // By Datasworn ID (rules-package agnostic).
  ok(_isProgressMove("move:classic/quest/fulfill_your_vow", null), "Fulfill Your Vow id → progress");
  ok(_isProgressMove("move:classic/adventure/reach_your_destination", null), "Reach Your Destination id → progress");
  ok(_isProgressMove("move:classic/combat/end_the_fight", null), "End the Fight id → progress (the v0.11.0 fix)");
  // By name (case/spacing-insensitive).
  ok(_isProgressMove(null, "End the Fight"), "End the Fight name → progress");
  ok(_isProgressMove(null, "  end the fight  "), "End the Fight name is trimmed + case-insensitive");
  ok(_isProgressMove(null, "Fulfill Your Vow"), "Fulfill Your Vow name → progress");
  ok(_isProgressMove(null, "Reach Your Destination"), "Reach Your Destination name → progress");
  // NON-progress (action-roll) combat moves must NOT be misclassified.
  ok(!_isProgressMove("move:classic/combat/strike", "Strike"), "Strike is NOT a progress move");
  ok(!_isProgressMove("move:classic/combat/clash", "Clash"), "Clash is NOT a progress move");
  ok(!_isProgressMove("move:classic/combat/battle", "Battle"), "Battle is NOT a progress move");
  ok(!_isProgressMove(null, "Enter the Fray"), "Enter the Fray is NOT a progress move");
}

/* ===================================================================== */
console.log(`\n${failed === 0 ? "✓ ALL PASS" : "✗ FAILURES"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
