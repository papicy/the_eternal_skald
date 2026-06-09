/* =====================================================================
 *  Vow / progress-track DISPLAY-sync test for The Eternal Skald.
 *
 *  Reproduces and guards against the v0.10.12 bug where the Skald's vow
 *  card showed a PHANTOM track ("Vow", rank 1, 0/10 boxes, ✓ complete)
 *  that was completely disconnected from the real vow on the character
 *  sheet ("The Truth of the Star-Fall", rank formidable, 3/10 boxes,
 *  still open). The bare word "vow" in narration had been turned into a
 *  clickable link that resolved to a junk/literal match rather than the
 *  player's actual current vow.
 *
 *  Verifies IronswornController.resolveDisplayTrack() / isGenericTrackWord():
 *    • a GENERIC noun ("vow", "the journey", ...) resolves to the real
 *      CURRENT open track of that kind (read from actor.items), never a
 *      phantom literally-named track;
 *    • the resolved Item is the LIVE sheet document, so its
 *      current/completed/rank mirror the sheet exactly;
 *    • an explicit, exact track name still wins;
 *    • an open track is preferred over a completed one of the same name;
 *    • generic words are detected so EntityLinker can skip linking them.
 *
 *  Run: node test/vow-display-sync.test.mjs
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
  constructor() { this.id = "actor1"; this.name = "Test Character"; this.items = new MockCollection(); }
  add(data) { const it = new MockItem(data, this); this.items.push(it); return it; }
}

const SCOPE = "the-eternal-skald";
function vow(name, opts = {}) {
  return { name, type: "progress",
    system: { subtype: "vow", rank: opts.rank ?? 3, current: opts.current ?? 0, completed: !!opts.completed, hasTrack: true },
    flags: { [SCOPE]: { trackKind: "vow" } }, _stats: { createdTime: opts.t ?? (1000 + (_id)) } };
}
function journey(name, opts = {}) {
  return { name, type: "progress",
    system: { subtype: "progress", rank: opts.rank ?? 2, current: opts.current ?? 0, completed: !!opts.completed, hasTrack: true },
    flags: { [SCOPE]: { trackKind: "journey" } }, _stats: { createdTime: opts.t ?? (1000 + (_id)) } };
}

/* ===================================================================== */
const { default: Ctrl } = await import("../scripts/ironsworn-controller.js");

console.log("[1] generic noun 'vow' resolves to the REAL open vow on the sheet");
{
  const actor = new MockActor();
  // The real, open vow (rank formidable=3, 3 boxes / 12 ticks) — exactly the
  // sheet state from the bug report.
  const real = actor.add(vow("The Truth of the Star-Fall", { rank: 3, current: 12, t: 200 }));
  const t = Ctrl.resolveDisplayTrack(actor, "vow");
  ok(t, "a track is resolved for the bare word 'vow'");
  eq(t?.id, real.id, "resolves to the real current vow, not a phantom");
  eq(getProperty(t, "system.current"), 12, "reads the live tick count from the sheet (12 ticks = 3 boxes)");
  eq(getProperty(t, "system.completed"), false, "reflects that the real vow is still OPEN");
}

console.log("[2] phantom completed 'Vow' never beats the real open vow for a generic ref");
{
  const actor = new MockActor();
  // A leftover/phantom track literally named "Vow" (rank 1, 0 progress, done).
  actor.add(vow("Vow", { rank: 1, current: 0, completed: true, t: 50 }));
  const real = actor.add(vow("The Truth of the Star-Fall", { rank: 3, current: 12, t: 200 }));
  const t = Ctrl.resolveDisplayTrack(actor, "vow");
  eq(t?.id, real.id, "the bare word 'vow' shows the real OPEN vow, not the completed phantom");
}

console.log("[3] generic 'journey' resolves to the open journey");
{
  const actor = new MockActor();
  actor.add(vow("Avenge the Fallen", { t: 100 }));
  const j = actor.add(journey("Cross the Frozen Waste", { current: 8, t: 200 }));
  const t = Ctrl.resolveDisplayTrack(actor, "the journey");
  eq(t?.id, j.id, "'the journey' resolves to the open journey track");
}

console.log("[4] an explicit, exact track name still wins");
{
  const actor = new MockActor();
  const a = actor.add(vow("Find the Lost Heir", { t: 100 }));
  const b = actor.add(vow("Reclaim the Vault", { t: 200 }));
  const t = Ctrl.resolveDisplayTrack(actor, "Find the Lost Heir");
  eq(t?.id, a.id, "an exact name resolves to that specific track");
}

console.log("[5] an OPEN track is preferred over a completed one of the same name");
{
  const actor = new MockActor();
  const done = actor.add(vow("Slay the Beast", { current: 40, completed: true, t: 100 }));
  const open = actor.add(vow("Slay the Beast", { current: 4, completed: false, t: 200 }));
  const t = Ctrl.resolveDisplayTrack(actor, "Slay the Beast");
  eq(t?.id, open.id, "the still-open track of that name is shown, not the completed duplicate");
}

console.log("[6] when only completed vows exist, a generic ref still surfaces one");
{
  const actor = new MockActor();
  const done = actor.add(vow("An Old Promise", { current: 40, completed: true, t: 100 }));
  const t = Ctrl.resolveDisplayTrack(actor, "vow");
  eq(t?.id, done.id, "falls back to the newest vow of the kind even if completed");
  eq(getProperty(t, "system.completed"), true, "and its completion state is read live from the sheet");
}

console.log("[7] isGenericTrackWord flags bare nouns (so EntityLinker skips them)");
{
  for (const w of ["vow", "Vow", "VOW", "the vow", "journey", "Journeys", "bond", "track", "progress", "quest", "foe", "vow."]) {
    ok(Ctrl.isGenericTrackWord(w), `"${w}" is treated as a generic track noun`);
  }
  for (const w of ["The Truth of the Star-Fall", "Avenge My Mentor", "Cross the Waste", "Brown Bear"]) {
    ok(!Ctrl.isGenericTrackWord(w), `"${w}" is NOT a generic noun (real proper name)`);
  }
}

console.log("[8] resolveDisplayTrack returns null for a truly unknown specific name");
{
  const actor = new MockActor();
  actor.add(vow("The Truth of the Star-Fall", { t: 100 }));
  const t = Ctrl.resolveDisplayTrack(actor, "Some Nonexistent Quest Name");
  eq(t, null, "an unknown specific name resolves to nothing (no false phantom)");
}

console.log("[9] marking progress on the resolved track updates the live item");
{
  const actor = new MockActor();
  const real = actor.add(vow("The Truth of the Star-Fall", { rank: 3, current: 12, t: 200 }));
  const t = Ctrl.resolveDisplayTrack(actor, "vow");
  const r = await Ctrl.markProgressByRank(actor, t.id, 1); // formidable = +4 ticks
  ok(r.ok, "markProgressByRank succeeds on the resolved track");
  eq(getProperty(real, "system.current"), 16, "the live sheet item advanced 12 → 16 ticks (4 boxes)");
}

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
