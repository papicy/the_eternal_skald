/* =====================================================================
 *  Progress-track CONTEXT test for The Eternal Skald (v0.10.26, Phase 1).
 *
 *  Exercises the READ-ONLY context surface added so the AI receives clear
 *  FULL / NOT YET FULL markers, the single ACTIVE combat, and the
 *  [STORY FOCUS] vow — the foundation that stops premature track conclusions.
 *    • fullnessLabel(boxes, completed, kind)  — FULL/NOT FULL wording.
 *    • getActiveCombat(actor)                 — the one active foe track.
 *    • identifyStoryFocusVow(actor)           — which vow the story is about.
 *    • describeCharacter(actor)               — grouped, labelled track block.
 *
 *  No writes occur — every method here is read-only; a guard test asserts
 *  the actor's items are left untouched.
 *
 *  Run: node test/progress-track-context.test.mjs
 * ===================================================================== */

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }
function has(haystack, needle, msg) { ok(typeof haystack === "string" && haystack.includes(needle), `${msg} (missing: ${JSON.stringify(needle)})`); }
function not(haystack, needle, msg) { ok(typeof haystack === "string" && !haystack.includes(needle), `${msg} (unexpectedly present: ${JSON.stringify(needle)})`); }

/* ---- Minimal Foundry globals ---- */
function getProperty(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
globalThis.foundry = { utils: { getProperty } };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
globalThis.game = { system: { id: "foundry-ironsworn" }, user: { id: "u1" }, actors: [] };
globalThis.canvas = { tokens: { controlled: [] } };

let _id = 0;
class MockItem {
  constructor(data) {
    this.id = data._id ?? `item${++_id}`;
    this.name = data.name;
    this.type = data.type;
    this.sort = data.sort ?? 0;
    this.flags = data.flags ?? {};
    this._stats = { createdTime: data._stats?.createdTime ?? Date.now() + _id };
    this.system = data.system ?? {};
  }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
}
class MockCollection extends Array { get(id) { return this.find(i => i.id === id) ?? null; } }
class MockActor {
  constructor(data = {}) {
    this.id = data.id ?? "actor1";
    this.name = data.name ?? "Sigrún";
    this.type = data.type ?? "character";
    this.system = data.system ?? {};
    this.items = new MockCollection();
    for (const it of (data.items ?? [])) this.items.push(new MockItem(it));
  }
}

const ES = "the-eternal-skald";
const vow = (name, ticks, opts = {}) => ({
  name, type: "progress",
  flags: { [ES]: { trackKind: "vow" } },
  system: { subtype: "vow", rank: opts.rank ?? 3, current: ticks, completed: opts.completed ?? false },
  _stats: { createdTime: opts.created ?? (Date.now() + Math.random()) },
  _id: opts.id
});
const journey = (name, ticks, opts = {}) => ({
  name, type: "progress",
  flags: { [ES]: { trackKind: "journey" } },
  system: { subtype: "progress", rank: opts.rank ?? 3, current: ticks, completed: opts.completed ?? false },
  _id: opts.id
});
// Combat-foe labelling fix: combat tracks created by the Skald on a character
// are stored with subtype "progress" (clean label) + trackKind "combat" flag.
const combat = (name, ticks, opts = {}) => ({
  name, type: "progress",
  flags: { [ES]: { trackKind: "combat" } },
  system: { subtype: "progress", rank: opts.rank ?? 3, current: ticks, completed: opts.completed ?? false },
  _id: opts.id
});

/* ===================================================================== */
const { default: Ctrl } = await import("../scripts/ironsworn-controller.js");

console.log("[1] fullnessLabel — FULL vs NOT YET FULL vs completed, per kind");
{
  eq(Ctrl.fullnessLabel(7, false, "vow"), "7/10 boxes - NOT YET FULL", "partial vow");
  eq(Ctrl.fullnessLabel(10, false, "vow"), "10/10 boxes - ✅ READY TO FULFILL", "full vow");
  eq(Ctrl.fullnessLabel(10, false, "combat"), "10/10 boxes - ✅ READY TO END", "full combat");
  eq(Ctrl.fullnessLabel(10, false, "journey"), "10/10 boxes - ✅ READY TO REACH", "full journey");
  has(Ctrl.fullnessLabel(10, true, "vow"), "(completed)", "completed wins over full");
  eq(Ctrl.fullnessLabel(0, false, "vow"), "0/10 boxes - NOT YET FULL", "empty track");
  // Clamping / bad input safety.
  eq(Ctrl.fullnessLabel(15, false, "vow"), "10/10 boxes - ✅ READY TO FULFILL", "over-cap clamps to 10");
  eq(Ctrl.fullnessLabel(NaN, false, "vow"), "0/10 boxes - NOT YET FULL", "NaN → 0");
}

console.log("[2] getProgressTracks reads multiple vows with correct boxes");
{
  const actor = new MockActor({ items: [
    vow("Defeat the Iron Duke", 28),   // 7 boxes
    vow("Find the Lost Heir", 40),      // 10 boxes
    vow("Cleanse the Cursed Shrine", 12) // 3 boxes
  ]});
  const tracks = Ctrl.getProgressTracks(actor);
  eq(tracks.length, 3, "three vows read");
  eq(tracks.find(t => t.name === "Defeat the Iron Duke").boxes, 7, "28 ticks → 7 boxes");
  eq(tracks.find(t => t.name === "Find the Lost Heir").boxes, 10, "40 ticks → 10 boxes");
  eq(tracks.find(t => t.name === "Cleanse the Cursed Shrine").boxes, 3, "12 ticks → 3 boxes");
}

console.log("[3] getActiveCombat returns the one open foe track, null when none");
{
  const fighting = new MockActor({ items: [
    vow("A Vow", 8),
    combat("Shadow Beast", 20),                 // open
    combat("Old Wolf", 16, { completed: true }) // finished
  ]});
  const active = Ctrl.getActiveCombat(fighting);
  ok(active && active.name === "Shadow Beast", "active combat is the open foe");
  eq(active.boxes, 5, "20 ticks → 5 boxes");

  const peaceful = new MockActor({ items: [ vow("A Vow", 8) ] });
  eq(Ctrl.getActiveCombat(peaceful), null, "no open combat → null");
  eq(Ctrl.getActiveCombat(null), null, "null actor → null");
}

console.log("[4] identifyStoryFocusVow — fallback to newest open vow");
{
  Ctrl._lastProgressTrack = null; // ensure no stale signal
  const actor = new MockActor({ items: [
    vow("Old Vow", 8, { id: "vOld", created: 1000 }),
    vow("New Vow", 8, { id: "vNew", created: 5000 })
  ]});
  const focus = Ctrl.identifyStoryFocusVow(actor);
  ok(focus && focus.id === "vNew", "newest open vow chosen as fallback");
  eq(Ctrl.identifyStoryFocusVow(null), null, "null actor → null");
  eq(Ctrl.identifyStoryFocusVow(new MockActor({ items: [] })), null, "no vows → null");
}

console.log("[5] identifyStoryFocusVow — last-rolled open vow on this actor wins");
{
  const actor = new MockActor({ id: "heroA", items: [
    vow("Old Vow", 8, { id: "vOld", created: 1000 }),
    vow("New Vow", 8, { id: "vNew", created: 5000 })
  ]});
  // Pretend the player last rolled progress on the OLDER vow.
  Ctrl._lastProgressTrack = { id: "vOld", name: "Old Vow", kind: "vow", actorId: "heroA", ts: Date.now() };
  const focus = Ctrl.identifyStoryFocusVow(actor);
  ok(focus && focus.id === "vOld", "last-rolled vow overrides newest-open fallback");

  // A last-rolled track belonging to a DIFFERENT actor must be ignored.
  Ctrl._lastProgressTrack = { id: "vOld", name: "Old Vow", kind: "vow", actorId: "someoneElse", ts: Date.now() };
  ok(Ctrl.identifyStoryFocusVow(actor).id === "vNew", "cross-actor signal ignored → fallback");

  // A last-rolled track that is now completed must be ignored.
  const actor2 = new MockActor({ id: "heroB", items: [
    vow("Done Vow", 40, { id: "vDone", completed: true, created: 9000 }),
    vow("Live Vow", 8, { id: "vLive", created: 2000 })
  ]});
  Ctrl._lastProgressTrack = { id: "vDone", name: "Done Vow", kind: "vow", actorId: "heroB", ts: Date.now() };
  ok(Ctrl.identifyStoryFocusVow(actor2).id === "vLive", "completed last-rolled vow ignored → fallback");
  Ctrl._lastProgressTrack = null; // reset for other suites
}

console.log("[6] describeCharacter — grouped, labelled, with ACTIVE COMBAT and STORY FOCUS");
{
  Ctrl._lastProgressTrack = null;
  const actor = new MockActor({ name: "Sigrún", items: [
    combat("Shadow Beast", 20, { rank: 4 }),       // 5/10 active combat
    vow("Defeat the Iron Duke", 28, { id: "vDuke", created: 9000 }), // 7/10, newest → focus
    vow("Find the Lost Heir", 40, { created: 1000 }),                // 10/10 ready
    journey("Journey to the Iron Wastes", 24)      // 6/10
  ]});
  const out = Ctrl.describeCharacter(actor);

  has(out, "PROGRESS TRACKS:", "section header present");
  has(out, "⚔️ ACTIVE COMBAT", "active combat labelled");
  has(out, "Shadow Beast", "active combat foe named");
  has(out, "NOT YET FULL", "partial tracks labelled NOT YET FULL");
  has(out, "✅ READY TO FULFILL", "full vow labelled READY TO FULFILL");
  has(out, "[STORY FOCUS]", "story-focus marker present");
  // The focus marker should sit on the newest open vow (the Iron Duke).
  const focusLine = out.split("\n").find(l => l.includes("[STORY FOCUS]"));
  has(focusLine, "Defeat the Iron Duke", "story focus is the newest open vow");
  has(out, "VOWS:", "vows group header");
  has(out, "JOURNEYS:", "journeys group header");
  has(out, "Open vows (reference by EXACT title)", "exact-title reference line retained");
}

console.log("[7] describeCharacter — edge cases (no tracks, all completed, null actor)");
{
  const bare = new MockActor({ items: [] });
  const out1 = Ctrl.describeCharacter(bare);
  not(out1, "PROGRESS TRACKS:", "no tracks → no progress section");

  const doneOnly = new MockActor({ items: [
    vow("Avenged the Fallen", 40, { completed: true })
  ]});
  const out2 = Ctrl.describeCharacter(doneOnly);
  has(out2, "PROGRESS TRACKS:", "completed-only still shows the section");
  not(out2, "[STORY FOCUS]", "no open vow → no story-focus marker");
  not(out2, "⚔️ ACTIVE COMBAT", "no open combat → no active-combat line");

  // No active character resolvable.
  eq(typeof Ctrl.describeCharacter(null), "string", "null actor returns a string, never throws");
}

console.log("[8] read-only guard — describeCharacter does not mutate the actor");
{
  Ctrl._lastProgressTrack = null;
  const actor = new MockActor({ items: [
    vow("Defeat the Iron Duke", 28),
    combat("Shadow Beast", 20)
  ]});
  const before = actor.items.map(i => ({ current: i.system.current, completed: i.system.completed }));
  Ctrl.describeCharacter(actor);
  Ctrl.getActiveCombat(actor);
  Ctrl.identifyStoryFocusVow(actor);
  const after = actor.items.map(i => ({ current: i.system.current, completed: i.system.completed }));
  eq(JSON.stringify(after), JSON.stringify(before), "track data unchanged after read-only calls");
}

/* ===================================================================== */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
