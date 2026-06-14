/* =====================================================================
 *  Journey / narrative progress TRACKING test for The Eternal Skald.
 *
 *  Guards the v0.10.15 fixes for journey + narrative-driven progress:
 *    1. JOURNEY AUTO-CREATION — when "Undertake a Journey" resolves and no
 *       journey track is open, one is opened (with a meaningful name) so that
 *       "Reach Your Destination" later has a track to roll against (this is the
 *       root cause of the "No open journey track …" error).
 *    2. PROGRESS BY TITLE — a vow/journey can be advanced by its EXACT title
 *       (findTrack → markProgress / markProgressByRank), which is what the
 *       [[EFFECT: mark_progress "Title"]] / [[EFFECT: progress <Title> …]]
 *       directives drive.
 *    3. NARRATIVE COMPLETION WITHOUT A ROLL — completeTrackSmart() closes the
 *       correct named (or active) track without any progress roll first.
 *    4. AI AWARENESS — describeCharacter() lists OPEN vows and OPEN journeys by
 *       their exact titles so the prompt can reference them precisely.
 *
 *  These mirror the controller-level mechanics that Integration._autoJourneyFlow
 *  orchestrates (createProgressTrack + _newestOpenTrackItem + markProgressByRank)
 *  and that the mark_progress / complete_* effects apply.
 *
 *  Run: node test/journey-tracking.test.mjs
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
// isActive() keys off game.system.id — make the Ironsworn system "active".
globalThis.game = { system: { id: "foundry-ironsworn" }, user: { id: "u1" }, actors: [] };
globalThis.canvas = { tokens: { controlled: [] } };

let _id = 0;
class MockItem {
  constructor(data, parent) {
    this.id = data._id ?? `item${++_id}`;
    this.name = data.name;
    this.type = data.type ?? "progress";
    this.sort = data.sort ?? 0;
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
  constructor() { this.id = "actor1"; this.name = "Test Character"; this.type = "character"; this.items = new MockCollection(); }
  add(data) { const it = new MockItem(data, this); this.items.push(it); return it; }
  async createEmbeddedDocuments(_kind, dataList) {
    const created = dataList.map(d => new MockItem(d, this));
    this.items.push(...created);
    return created;
  }
  testUserPermission() { return true; }
}

const SCOPE = "the-eternal-skald";
function vow(name, opts = {}) {
  return { name, type: "progress",
    system: { subtype: "vow", rank: opts.rank ?? 3, current: opts.current ?? 0, completed: !!opts.completed, hasTrack: true },
    flags: { [SCOPE]: { trackKind: "vow" } }, _stats: { createdTime: opts.t ?? (1000 + _id) } };
}

/* ===================================================================== */
const { default: Ctrl } = await import("../scripts/ironsworn-controller.js");

console.log("[1] JOURNEY AUTO-CREATION — no open journey, then one is opened");
{
  const actor = new MockActor();
  // Before: nothing open — this is exactly the state that made
  // "Reach Your Destination" fail with "No open journey track …".
  eq(Ctrl._newestOpenTrackItem(actor, "journey"), null, "no open journey track initially");

  // Auto-flow does: createProgressTrack(actor, name, "journey", rank).
  const res = await Ctrl.createProgressTrack(actor, "Journey to the Frozen Keep", "journey", "formidable");
  ok(res?.ok, "createProgressTrack(journey) succeeds");

  const open = Ctrl._newestOpenTrackItem(actor, "journey");
  ok(open, "a journey track is now open for Reach Your Destination to roll");
  eq(open?.name, "Journey to the Frozen Keep", "the open journey carries the meaningful name");
  eq(getProperty(open, "system.subtype"), "progress", "journey stored as subtype 'progress'");
  eq(open?.getFlag(SCOPE, "trackKind"), "journey", "tagged as a journey via our flag");
}

console.log("[2] JOURNEY ADVANCE — markProgressByRank advances the open journey");
{
  const actor = new MockActor();
  await Ctrl.createProgressTrack(actor, "The Long Road North", "journey", "formidable");
  const track = Ctrl._newestOpenTrackItem(actor, "journey");
  // formidable → +4 ticks (1 box) per mark.
  const pr = await Ctrl.markProgressByRank(actor, track.id);
  ok(pr?.ok, "markProgressByRank succeeds");
  eq(pr?.boxes, 1, "formidable journey gains 1 box per mark (+4 ticks)");
  eq(getProperty(track, "system.current"), 4, "track current is 4 ticks");
}

console.log("[3] PROGRESS BY TITLE — advance a vow by its EXACT title");
{
  const actor = new MockActor();
  actor.add(vow("The Truth of the Star-Fall", { rank: 2, current: 0 })); // dangerous → +8/mark
  // markProgressByRank resolves the track by TITLE via findTrack.
  const pr = await Ctrl.markProgressByRank(actor, "The Truth of the Star-Fall");
  ok(pr?.ok, "progress marked by title");
  eq(pr?.track, "The Truth of the Star-Fall", "resolved the correct named vow");
  eq(pr?.boxes, 2, "dangerous vow gains 2 boxes per mark (+8 ticks)");

  // A partial / substring title also resolves to the right track.
  const pr2 = await Ctrl.markProgress(actor, "Star-Fall", 4);
  ok(pr2?.ok, "substring title resolves the track");
  eq(pr2?.track, "The Truth of the Star-Fall", "substring matched the same vow");
}

console.log("[4] NARRATIVE COMPLETION WITHOUT A ROLL — completeTrackSmart by title");
{
  const actor = new MockActor();
  await Ctrl.createProgressTrack(actor, "Journey to the Frozen Keep", "journey", "formidable");
  const track = Ctrl._newestOpenTrackItem(actor, "journey");
  ok(!getProperty(track, "system.completed"), "journey starts open");

  // No progress roll happened — completion is purely narrative.
  Ctrl._lastProgressTrack = null;
  const r = await Ctrl.completeTrackSmart(actor, "Journey to the Frozen Keep", "journey");
  ok(r?.ok, "completeTrackSmart closes the journey without a prior roll");
  eq(r?.name, "Journey to the Frozen Keep", "closed the correctly named journey");
  eq(getProperty(track, "system.completed"), true, "track marked completed");
  eq(Ctrl._newestOpenTrackItem(actor, "journey"), null, "no open journey remains");
}

console.log("[5] COMPLETION FALLBACK — omitted name closes the active journey");
{
  const actor = new MockActor();
  await Ctrl.createProgressTrack(actor, "The Pilgrimage to Ironhome", "journey", "dangerous");
  Ctrl._lastProgressTrack = null;
  // AI omits the name (or uses the move name) → still closes the open journey.
  const r = await Ctrl.completeTrackSmart(actor, "", "journey");
  ok(r?.ok, "empty name falls back to the active journey");
  eq(r?.name, "The Pilgrimage to Ironhome", "closed the only open journey");
}

console.log("[6] AI AWARENESS — describeCharacter lists OPEN vows & journeys by title");
{
  const actor = new MockActor();
  actor.add(vow("The Oath of Ashes", { rank: 3, current: 8 }));
  actor.add(vow("A Debt Long Paid", { rank: 2, current: 40, completed: true })); // completed → excluded
  await Ctrl.createProgressTrack(actor, "Journey to the Frozen Keep", "journey", "formidable");

  const desc = Ctrl.describeCharacter(actor);
  ok(/Open vows \(reference by EXACT title\):/.test(desc), "lists an 'Open vows' line");
  ok(desc.includes('"The Oath of Ashes"'), "open vow listed by exact title");
  ok(!desc.includes('"A Debt Long Paid"'), "completed vow is NOT listed as open");
  ok(/Open journeys \(reference by EXACT title\):/.test(desc), "lists an 'Open journeys' line");
  ok(desc.includes('"Journey to the Frozen Keep"'), "open journey listed by exact title");
}

console.log("[7] LEGACY JOURNEY — a hand-made progress track is treated as a journey");
{
  const actor = new MockActor();
  // No trackKind flag, plain 'progress' subtype (a journey made before the flag
  // existed, or by the system UI). _newestOpenTrackItem must still find it so
  // Reach Your Destination can roll against it.
  actor.add({ name: "The Old Caravan Route", type: "progress",
    system: { subtype: "progress", rank: 2, current: 4, completed: false, hasTrack: true } });
  const open = Ctrl._newestOpenTrackItem(actor, "journey");
  ok(open, "legacy progress track resolves as a journey");
  eq(open?.name, "The Old Caravan Route", "the right legacy track is found");

  const desc = Ctrl.describeCharacter(actor);
  ok(desc.includes('"The Old Caravan Route"'), "legacy journey listed under Open journeys");
}

/*  [8/9] _autoJourneyFlow REUSE — link/dialog rolls stamp no fresh intent, so
 *  _resolveJourney falls back to a vow-guessed name flagged specific:true. With
 *  ONE open journey that must NOT branch a duplicate (the "new track every time"
 *  bug); with SEVERAL, a name-mismatch still branches. Exercises real Integration. */
const mk = () => { const f = function () { return mk(); };
  return new Proxy(f, { get(_t, p) { return (p === "then" || p === Symbol.iterator || p === Symbol.toPrimitive) ? undefined : mk(); },
    set() { return true; }, apply() { return mk(); }, construct() { return mk(); } }); };
for (const n of ["Hooks","ui","CONST","Roll","ChatMessage","Dialog","DialogV2","loadTemplates","renderTemplate","fromUuid","fromUuidSync","getDocumentClass","Handlebars","TextEditor","duplicate","mergeObject","$","jQuery","document","window"])
  if (globalThis[n] === undefined) globalThis[n] = mk();
globalThis.game.settings = { get: () => undefined };
const { registerSystem } = await import("../scripts/systems/registry.js");
const { Integration } = await import("../scripts/narrative/integration.js");

function jAdapter() {
  const calls = { created: 0, advanced: [] };
  const kindOf = (i) => i.flags?.[SCOPE]?.trackKind ?? "journey";
  const openJ  = (a) => a.items.filter(i => i.type === "progress" && kindOf(i) === "journey" && !getProperty(i, "system.completed"));
  return { calls, adapter: {
    id: "foundry-ironsworn", isActive: () => true, capabilities: () => ({}), _trackKindOf: kindOf,
    _newestOpenTrackItem: (a, k) => k === "journey" ? (openJ(a)[0] ?? null) : null,
    isGenericTrackWord: (s) => /^(the\s+)?(journey|vow|fight|combat|track|quest)$/i.test(String(s ?? "").trim()),
    findTrackFuzzy: () => null, getActiveVow: () => ({ name: "Avenge Ravensford" }),
    getProgressTrack: (a, id) => a.items.get(id),
    async createProgressTrack(a, name, _k, rank) { calls.created++;
      const it = a.add({ name, type: "progress", system: { subtype: "progress", rank, current: 0, completed: false }, flags: { [SCOPE]: { trackKind: "journey" } } });
      return { ok: true, id: it.id, name }; },
    async markProgressByRank(a, id) { const t = a.items.get(id); calls.advanced.push(t.name);
      setProperty(t, "system.current", (getProperty(t, "system.current") || 0) + 4); return { ok: true, track: t.name, boxes: 1 }; }
  } };
}
const SHJ = { moveName: "Undertake a Journey", outcome: "Strong Hit" };  // no fresh intent stamped → the bug trigger
const journeyItem = (name) => ({ name, type: "progress", system: { subtype: "progress", rank: 2, current: 4, completed: false }, flags: { [SCOPE]: { trackKind: "journey" } } });
console.log("[8] SINGLE open journey — reuse it, do NOT branch a duplicate");
{
  const actor = new MockActor(); actor.add(journeyItem("The Long Road North"));
  const { adapter, calls } = jAdapter(); registerSystem("foundry-ironsworn", adapter); Integration._lastIntentTs = 0;
  await Integration._autoJourneyFlow(SHJ, actor);
  eq(calls.created, 0, "no duplicate journey created when exactly one is open");
  eq(actor.items.length, 1, "still exactly one journey track");
  eq(calls.advanced[0], "The Long Road North", "progress marked on the existing journey");
}
console.log("[9] MULTIPLE open journeys, NO fresh intent — reuse newest, do NOT branch");
{
  // The bug trigger: a link/dialog roll stamps no fresh intent, so the name is a
  // vow/scene GUESS (not fromIntent). Even with several open journeys we must NOT
  // branch a duplicate off a guessed name — reuse the newest open journey.
  const actor = new MockActor(); actor.add(journeyItem("The Long Road North")); actor.add(journeyItem("Pilgrimage to Ironhome"));
  const { adapter, calls } = jAdapter(); registerSystem("foundry-ironsworn", adapter); Integration._lastIntentTs = 0;
  await Integration._autoJourneyFlow(SHJ, actor);
  eq(calls.created, 0, "no duplicate branched off a GUESSED name even with multiple open journeys");
  eq(actor.items.length, 2, "still exactly the two pre-existing journey tracks");
  eq(calls.advanced[0], "The Long Road North", "progress marked on the open journey returned by _newestOpenTrackItem");
}
console.log("[10] ACCUMULATED duplicates, NO fresh intent — bleed stops, reuse newest");
{
  // Regression for the production bug: once duplicates pile up (from the bug
  // itself over prior sessions), each fresh link-roll with no intent must REUSE
  // the newest open track, never adding a 4th, 5th, ... duplicate.
  const actor = new MockActor();
  actor.add(journeyItem("Journey toward Ravensford")); actor.add(journeyItem("Journey toward Ravensford"));
  actor.add(journeyItem("Journey toward Ravensford"));
  const { adapter, calls } = jAdapter(); registerSystem("foundry-ironsworn", adapter); Integration._lastIntentTs = 0;
  await Integration._autoJourneyFlow(SHJ, actor);
  eq(calls.created, 0, "no further duplicate created — the bleed stops");
  eq(actor.items.length, 3, "the three accumulated tracks are unchanged in count");
}

// (v0.25.2) The FRESH-INTENT cases — when the player explicitly states a
// destination this turn, _resolveJourney returns a specific, fromIntent name.
const SHJI = { moveName: "Undertake a Journey", outcome: "Strong Hit" };
console.log("[11] GENERIC placeholder open + fresh specific intent — adopt it, do NOT branch a duplicate");
{
  // Root cause of the persistent dup: the lone open journey is a GENERIC
  // placeholder ("The Journey"); the fresh intent resolves a specific name that
  // fuzzy-MISSES it. Pre-fix this branched a 2nd open journey (the duplicate the
  // user reported). Now the generic placeholder is adopted for the destination.
  const actor = new MockActor(); actor.add(journeyItem("The Journey"));
  const { adapter, calls } = jAdapter(); registerSystem("foundry-ironsworn", adapter);
  Integration._lastIntent = "travel to Greymoor"; Integration._lastIntentTs = Date.now();
  await Integration._autoJourneyFlow(SHJI, actor);
  eq(calls.created, 0, "no duplicate branched — the generic placeholder is adopted for the stated destination");
  eq(actor.items.length, 1, "still exactly one journey track");
  eq(calls.advanced[0], "The Journey", "progress marked on the adopted (formerly generic) journey");
}
console.log("[12] DISTINCT specific journey open + fresh intent for a DIFFERENT destination — branch is preserved");
{
  // The simultaneous-journeys feature must survive: a genuinely different,
  // freshly-stated destination still opens its own track.
  const actor = new MockActor(); actor.add(journeyItem("Journey to Ravensford"));
  const { adapter, calls } = jAdapter(); registerSystem("foundry-ironsworn", adapter);
  Integration._lastIntent = "travel to Greymoor"; Integration._lastIntentTs = Date.now();
  await Integration._autoJourneyFlow(SHJI, actor);
  eq(calls.created, 1, "a new track is branched for the distinct, freshly-stated destination");
  eq(actor.items.length, 2, "now two separate journey tracks (no false merge, no false dup)");
}
Integration._lastIntent = ""; Integration._lastIntentTs = 0;

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
