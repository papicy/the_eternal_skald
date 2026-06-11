/* =====================================================================
 *  Vow / journey completion-resolution test for The Eternal Skald.
 *
 *  Reproduces and guards against the v0.10.10 bug where fulfilling a vow
 *  via a progress move ("Fulfill Your Vow" / "Reach Your Destination")
 *  failed with «Track "Reach Your Destination" not found» because the
 *  completion directive carried the MOVE name instead of the track's real,
 *  player-chosen name.
 *
 *  Verifies IronswornController.resolveCompletionTrack() / completeTrackSmart():
 *    • a move name never resolves to a literal track of that name;
 *    • the track the last progress move rolled against is closed;
 *    • an empty name falls back to the active track of the implied kind;
 *    • a real, exact track name still wins;
 *    • the right KIND (vow vs journey) is preferred.
 *
 *  Run: node test/vow-completion.test.mjs
 * ===================================================================== */

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

/* ---- Minimal Foundry globals the controller relies on ---- */
function getProperty(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setProperty(obj, path, value) {
  const keys = path.split("."); let o = obj;
  while (keys.length > 1) { const k = keys.shift(); o[k] = o[k] ?? {}; o = o[k]; }
  o[keys[0]] = value;
}
globalThis.foundry = { utils: { getProperty, setProperty } };
globalThis.CONFIG = { Item: { dataModels: { "asset": {}, "progress": {} } } };
globalThis.game = { user: { id: "u1" }, actors: [] };
globalThis.canvas = { tokens: { controlled: [] } };

let _id = 0;
class MockItem {
  constructor(data, parent) {
    this.id = data._id ?? `item${++_id}`;
    this.name = data.name;
    this.type = data.type ?? "progress";
    this.flags = data.flags ?? {};
    this._stats = { createdTime: data._stats?.createdTime ?? (Date.now() + _id) };
    this.parent = parent;
    this.system = data.system ?? {};
  }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  async update(changes) {
    for (const [path, value] of Object.entries(changes)) setProperty(this, path, value);
    return this;
  }
}
class MockCollection extends Array {
  get(id) { return this.find(i => i.id === id) ?? null; }
}
class MockActor {
  constructor() { this.id = "actor1"; this.items = new MockCollection(); }
  add(data) { const it = new MockItem(data, this); this.items.push(it); return it; }
}

const SCOPE = "the-eternal-skald";
function vow(name, opts = {}) {
  return { name, type: "progress",
    system: { subtype: "vow", rank: 3, current: opts.current ?? 0, completed: !!opts.completed, hasTrack: true },
    flags: { [SCOPE]: { trackKind: "vow" } }, _stats: { createdTime: opts.t ?? (1000 + (_id)) } };
}
function journey(name, opts = {}) {
  return { name, type: "progress",
    system: { subtype: "progress", rank: 2, current: opts.current ?? 0, completed: !!opts.completed, hasTrack: true },
    flags: { [SCOPE]: { trackKind: "journey" } }, _stats: { createdTime: opts.t ?? (1000 + (_id)) } };
}

/* ===================================================================== */
const { default: Ctrl } = await import("../scripts/ironsworn-controller.js");

console.log("[1] a MOVE name never resolves to a literal track of that name");
{
  Ctrl._lastProgressTrack = null;
  const actor = new MockActor();
  const v = actor.add(vow("Avenge the Burning of Hearthmere", { t: 100 }));
  // The AI emitted the MOVE name; there is NO track called "Fulfill Your Vow".
  const t = Ctrl.resolveCompletionTrack(actor, "Fulfill Your Vow", "vow");
  ok(t, "a track is resolved despite the move-name directive");
  eq(t?.id, v.id, "resolves to the real open vow, not a track named after the move");
}

console.log("[2] empty name + kind hint → active track of that kind");
{
  Ctrl._lastProgressTrack = null;
  const actor = new MockActor();
  const older = actor.add(vow("Old Vow", { t: 100 }));
  const newer = actor.add(vow("Recent Vow", { t: 200 }));
  const t = Ctrl.resolveCompletionTrack(actor, "", "vow");
  eq(t?.id, newer.id, "newest open vow chosen when no name is supplied");
}

console.log("[3] last-rolled progress track is preferred (the exact track just rolled)");
{
  const actor = new MockActor();
  const a = actor.add(vow("Vow A", { t: 100 }));
  const b = actor.add(vow("Vow B", { t: 300 })); // newer
  // The progress move rolled against Vow A specifically.
  Ctrl._lastProgressTrack = { id: a.id, name: a.name, kind: "vow", actorId: actor.id, ts: Date.now() };
  const t = Ctrl.resolveCompletionTrack(actor, "Fulfill Your Vow", "vow");
  eq(t?.id, a.id, "closes the track the move actually rolled against, not merely the newest");
}

console.log("[4] kind is respected: journey directive picks the journey, not a vow");
{
  Ctrl._lastProgressTrack = null;
  const actor = new MockActor();
  const v = actor.add(vow("Some Vow", { t: 100 }));
  const j = actor.add(journey("Journey to the Star-Fallen Crag", { t: 200 }));
  const t = Ctrl.resolveCompletionTrack(actor, "Reach Your Destination", "journey");
  eq(t?.id, j.id, "journey completion resolves to the journey track");
}

console.log("[5] a real exact track name still wins (and beats the last-rolled pointer)");
{
  const actor = new MockActor();
  const a = actor.add(vow("Vow A", { t: 100 }));
  const b = actor.add(vow("Find the Lost Heir", { t: 200 }));
  Ctrl._lastProgressTrack = { id: a.id, name: a.name, kind: "vow", actorId: actor.id, ts: Date.now() };
  const t = Ctrl.resolveCompletionTrack(actor, "Find the Lost Heir", "vow");
  eq(t?.id, b.id, "an explicit, exact track name is honored over the last-rolled fallback");
}

console.log("[6] completeTrackSmart marks the resolved track completed");
{
  Ctrl._lastProgressTrack = null;
  const actor = new MockActor();
  const v = actor.add(vow("Reclaim the Sunless Vault", { t: 100 }));
  const r = await Ctrl.completeTrackSmart(actor, "Fulfill Your Vow", "vow");
  ok(r.ok, "completeTrackSmart returns ok for a move-named directive");
  eq(r.name, "Reclaim the Sunless Vault", "returns the REAL track name");
  eq(getProperty(v, "system.completed"), true, "the real vow track is marked completed");
}

console.log("[7] completeTrackSmart clears the last-progress pointer it just closed");
{
  const actor = new MockActor();
  const v = actor.add(vow("Avenge My Mentor", { t: 100 }));
  Ctrl._lastProgressTrack = { id: v.id, name: v.name, kind: "vow", actorId: actor.id, ts: Date.now() };
  await Ctrl.completeTrackSmart(actor, "", "vow");
  eq(Ctrl._lastProgressTrack, null, "last-progress pointer cleared after closing that track");
}

console.log("[8] no open track of the kind → clear error (no false completion)");
{
  Ctrl._lastProgressTrack = null;
  const actor = new MockActor();
  actor.add(vow("Done Vow", { t: 100, completed: true })); // already completed
  const r = await Ctrl.completeTrackSmart(actor, "Fulfill Your Vow", "vow");
  ok(!r.ok, "no open vow → not ok");
  ok(/no open/i.test(r.error || ""), "error explains there is no open track to complete");
}

console.log("[9] rollProgressMove records the rolled track as _lastProgressTrack");
{
  // Drive the recording path without the system dialog: stub api()/showForProgress
  // is unavailable, so rollProgressMove falls through to the fulfill() path; we
  // only need it to REACH the recording line, which precedes the dialog calls.
  Ctrl._lastProgressTrack = null;
  const actor = new MockActor();
  const v = actor.add(vow("The Oath of Ashes", { current: 24, t: 100 }));
  // No IronswornPrerollDialog and no track.system.fulfill → returns not-ok, but
  // the _lastProgressTrack must already be set by then.
  await Ctrl.rollProgressMove("Fulfill Your Vow", { actor });
  ok(Ctrl._lastProgressTrack, "_lastProgressTrack recorded");
  eq(Ctrl._lastProgressTrack?.id, v.id, "records the resolved vow track id");
  eq(Ctrl._lastProgressTrack?.kind, "vow", "records the implied kind");
}

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
