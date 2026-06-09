/* =====================================================================
 *  "Reach a Milestone" end-to-end test for The Eternal Skald.
 *
 *  Reproduces the full call chain:
 *    triggerMove("Reach a Milestone") → _isMilestoneMove → _executeMilestone
 *    → _newestOpenTrackItem("vow") → markProgressByRank → markProgress
 *    → track.update({"system.current": ...})
 *
 *  Run: node test/milestone.test.mjs
 * ===================================================================== */

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

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
  async update(changes) {
    for (const [path, value] of Object.entries(changes)) setProperty(this, path, value);
    return this;
  }
}
class MockCollection extends Array { get(id) { return this.find(i => i.id === id) ?? null; } }
class MockActor {
  constructor(type = "character") { this.type = type; this.items = new MockCollection(); }
  async createEmbeddedDocuments(_kind, dataList) {
    const created = dataList.map(d => new MockItem(d, this));
    this.items.push(...created);
    return created;
  }
  testUserPermission() { return true; }
}
globalThis.game = { user: { id: "u1" }, actors: [] };
globalThis.canvas = { tokens: { controlled: [] } };

/* ===================================================================== */
const { default: Ctrl } = await import("../scripts/ironsworn-controller.js");

console.log("[1] _isMilestoneMove recognises name and Datasworn id");
{
  ok(Ctrl._isMilestoneMove(null, "Reach a Milestone"), "recognises by name");
  ok(Ctrl._isMilestoneMove("move:classic/quest/reach_a_milestone", null), "recognises by dsid");
  ok(Ctrl._isMilestoneMove("move:starforged/quest/reach_a_milestone", null), "recognises starforged dsid");
  ok(!Ctrl._isMilestoneMove(null, "Fulfill Your Vow"), "does NOT match other quest moves");
}

console.log("[2] _executeMilestone marks progress on the newest open vow (formidable +4)");
{
  const actor = new MockActor();
  await Ctrl.createProgressTrack(actor, "Uncover the Secrets of Warden's Reach", "vow", "formidable", "");
  const vow = actor.items.find(i => i.name.includes("Warden"));
  eq(vow.system.current, 0, "vow starts at 0 ticks");

  const res = await Ctrl._executeMilestone(actor);
  ok(res.ok, "milestone returns ok");
  eq(res.method, "milestone", "method is 'milestone'");
  eq(vow.system.current, 4, "vow now at 4 ticks (1 box) after one milestone");
  eq(res.boxes, 1, "result reports 1 box");
}

console.log("[3] triggerMove intercepts the milestone (by name)");
{
  const actor = new MockActor();
  await Ctrl.createProgressTrack(actor, "The Long Vow", "vow", "dangerous", ""); // dangerous → +8
  const vow = actor.items.find(i => i.name === "The Long Vow");

  const res = await Ctrl.triggerMove("Reach a Milestone", { actor });
  eq(res.method, "milestone", "triggerMove routes name to milestone path");
  ok(res.ok, "triggerMove milestone ok");
  eq(vow.system.current, 8, "vow advanced +8 ticks (dangerous rank)");
}

console.log("[4] triggerMove intercepts the milestone (by Datasworn id)");
{
  const actor = new MockActor();
  await Ctrl.createProgressTrack(actor, "Epic Vow", "vow", "epic", ""); // epic → +1
  const vow = actor.items.find(i => i.name === "Epic Vow");

  const res = await Ctrl.triggerMove("move:classic/quest/reach_a_milestone", { actor });
  eq(res.method, "milestone", "triggerMove routes dsid to milestone path");
  eq(vow.system.current, 1, "vow advanced +1 tick (epic rank)");
}

console.log("[5] milestone marks a SHEET-MADE vow (no Skald flag, subtype 'vow')");
{
  const actor = new MockActor();
  await actor.createEmbeddedDocuments("Item", [
    { name: "Hand-sworn Vow", type: "progress", system: { subtype: "vow", rank: 3, current: 0 } }
  ]);
  const vow = actor.items.find(i => i.name === "Hand-sworn Vow");
  const res = await Ctrl.triggerMove("Reach a Milestone", { actor });
  ok(res.ok, "milestone ok on sheet-made vow");
  eq(vow.system.current, 4, "sheet-made vow advanced +4 (formidable)");
}

console.log("[6] milestone with no open vow returns a clear error (does NOT crash)");
{
  const actor = new MockActor();
  const res = await Ctrl.triggerMove("Reach a Milestone", { actor });
  ok(!res.ok, "no-vow milestone returns not-ok");
  ok(/no open vow/i.test(res.error ?? ""), "error explains no open vow");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
