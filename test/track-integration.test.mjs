/* =====================================================================
 *  Track-integration test for The Eternal Skald ⇄ foundry-ironsworn.
 *
 *  Validates that IronswornController.createProgressTrack() produces item
 *  data that conforms to the REAL foundry-ironsworn ProgressModel schema
 *  (src/module/item/subtypes/progress.ts), and that the controller detects
 *  sheet-style tracks (the "vice versa" direction).
 *
 *  Run: node test/track-integration.test.mjs
 *
 *  The schema cleaner below faithfully mirrors ProgressModel.defineSchema()
 *  and the ChallengeRank / ProgressTicksField field types as cloned from
 *  https://github.com/ben/foundry-ironsworn (verified June 2026).
 * ===================================================================== */

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

/* ---- Faithful replica of foundry-ironsworn's ProgressModel schema ---- */
const CHALLENGE_RANK = { troublesome: 1, dangerous: 2, formidable: 3, extreme: 4, epic: 5 };
function castRank(value) {
  if (value === "formidible") return 3;               // system handles this typo
  if (typeof value === "string") {
    const cap = value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
    return CHALLENGE_RANK[cap.toLowerCase()];
  }
  if (typeof value === "number") return value;
  return undefined;
}
// Only the fields ProgressModel.defineSchema() declares survive cleaning.
const PROGRESS_FIELDS = new Set([
  "subtype", "starred", "hasTrack", "hasClock", "clockTicks", "clockMax",
  "completed", "current", "description", "rank"
]);
/** Mimic Foundry DataModel cleaning for a `progress` item's system data. */
function cleanProgressSystem(raw = {}) {
  const out = {};
  // Drop unknown keys (Foundry silently strips them during cleanData).
  for (const [k, v] of Object.entries(raw)) {
    if (PROGRESS_FIELDS.has(k)) out[k] = v;
  }
  // Apply schema defaults + coercion.
  out.subtype   = typeof out.subtype === "string" ? out.subtype : "progress";
  out.starred   = !!out.starred;
  out.hasTrack  = out.hasTrack === undefined ? true : !!out.hasTrack;
  out.hasClock  = !!out.hasClock;
  out.completed = !!out.completed;
  // current: ProgressTicksField → integer clamped 0..40
  let cur = Number.isFinite(out.current) ? Math.trunc(out.current) : 0;
  out.current = Math.max(0, Math.min(40, cur));
  // rank: ChallengeRank → integer 1..5 (initial 1)
  let rank = castRank(out.rank);
  if (!Number.isInteger(rank)) rank = 1;
  out.rank = Math.max(1, Math.min(5, rank));
  return out;
}

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
globalThis.CONFIG = { Item: { dataModels: {
  // EXACT set of Item types foundry-ironsworn registers (system template).
  "asset": {}, "progress": {}, "ledger-entry": {}, "bondset": {},
  "sfmove": {}, "delve-theme": {}, "delve-domain": {}
} } };
globalThis.game = { user: { id: "u1" }, actors: [] };
globalThis.canvas = { tokens: { controlled: [] } };

/* ---- A mock embedded-Item that behaves like a cleaned progress item ---- */
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
    // Apply real schema cleaning for progress items.
    this.system = data.type === "progress"
      ? cleanProgressSystem(data.system ?? {})
      : (data.system ?? {});
    // record the RAW system the caller passed (to assert no bad keys leaked)
    this._rawSystemKeys = Object.keys(data.system ?? {});
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
  constructor(type = "character") { this.type = type; this.items = new MockCollection(); }
  async createEmbeddedDocuments(_kind, dataList) {
    const created = dataList.map(d => new MockItem(d, this));
    this.items.push(...created);
    return created;
  }
  testUserPermission() { return true; }
}

/* ===================================================================== */
const { default: Ctrl } = await import("../scripts/ironsworn-controller.js");

console.log("[1] createProgressTrack → conforms to ProgressModel schema");
{
  const actor = new MockActor();

  // -- VOW --
  const vr = await Ctrl.createProgressTrack(actor, "The Mystery of the Weeping Star", "vow", "formidable", "Uncover the truth.");
  ok(vr.ok, "vow creation returns ok");
  const vow = actor.items.get(vr.id);
  eq(vow.type, "progress", "vow item type is 'progress'");
  eq(vow.system.subtype, "vow", "vow system.subtype is 'vow'");
  eq(vow.system.rank, 3, "vow rank stored as numeric 3 (formidable)");
  eq(vow.system.current, 0, "vow current ticks = 0");
  eq(vow.system.completed, false, "vow not completed");
  eq(vow.system.hasTrack, true, "vow hasTrack true");
  eq(vow.system.description, "Uncover the truth.", "vow description set (HTMLField)");
  ok(!("notes" in vow.system), "vow system has NO invalid 'notes' field");
  ok(vow.sort >= 9000000, "vow sort is high (lands at list end)");
  eq(vow.flags["the-eternal-skald"].trackKind, "vow", "vow carries trackKind flag");

  // -- JOURNEY (stored as subtype 'progress' + trackKind flag) --
  const jr = await Ctrl.createProgressTrack(actor, "Road to Greywatch", "journey", "dangerous");
  const jrn = actor.items.get(jr.id);
  eq(jrn.type, "progress", "journey item type 'progress'");
  eq(jrn.system.subtype, "progress", "journey subtype 'progress' (localizable label)");
  eq(jrn.system.rank, 2, "journey rank numeric 2 (dangerous)");
  eq(jrn.flags["the-eternal-skald"].trackKind, "journey", "journey trackKind flag");

  // -- BOND --
  const br = await Ctrl.createProgressTrack(actor, "Bond with Aelra", "bond", "troublesome");
  eq(actor.items.get(br.id).system.subtype, "bond", "bond subtype 'bond'");
  eq(actor.items.get(br.id).system.rank, 1, "bond rank numeric 1 (troublesome)");

  // -- COMBAT (foe) --
  // Combat-foe labelling fix: combat tracks on a CHARACTER are stored with
  // subtype "progress" (like journeys) — NOT "foe" — because the character
  // sheet only localizes vow/progress/connection subtypes and would otherwise
  // render the raw "IRONSWORN.ITEM.SubtypeFoe" key. Combat identity is carried
  // by the trackKind="combat" flag.
  const cr = await Ctrl.createProgressTrack(actor, "Brown Bear", "combat", "dangerous");
  const foe = actor.items.get(cr.id);
  eq(foe.type, "progress", "combat item type 'progress'");
  eq(foe.system.subtype, "progress", "combat subtype 'progress' (clean label; not raw SubtypeFoe)");
  eq(foe.flags["the-eternal-skald"].trackKind, "combat", "combat trackKind flag");
  // getCombatTracks must still recognise this track via the trackKind flag.
  ok(Ctrl.getCombatTracks(actor).some(t => t.name === "Brown Bear"), "getCombatTracks finds combat track stored as subtype 'progress'");
}

console.log("[2] detection of SHEET-MADE tracks (vice versa)");
{
  const actor = new MockActor();
  // Items exactly as the foundry-ironsworn sheet would create them (no flags).
  await actor.createEmbeddedDocuments("Item", [
    { name: "Prevent the Great Severing", type: "progress", system: { subtype: "vow", rank: 3, current: 8 } },
    { name: "Shepherd the Great Thaw",    type: "progress", system: { subtype: "vow", rank: 2, current: 0 } },
    { name: "Greywatch Trek",             type: "progress", system: { subtype: "progress", rank: 2, current: 4 } },
    { name: "Hand-made Bear",             type: "progress", system: { subtype: "foe", rank: 2, current: 12 } },
    { name: "A Sword",                    type: "asset",    system: { } }
  ]);

  const tracks = Ctrl.getProgressTracks(actor);
  ok(tracks.find(t => t.name === "Prevent the Great Severing" && t.subtype === "vow"), "getProgressTracks finds sheet vow");
  eq(tracks.find(t => t.name === "Prevent the Great Severing").boxes, 2, "vow boxes derived from current (8 ticks = 2 boxes)");

  // newest open VOW (strong subtype match)
  const vow = Ctrl._newestOpenTrackItem(actor, "vow");
  ok(vow && vow.system.subtype === "vow", "_newestOpenTrackItem('vow') finds a sheet vow");

  // journey fallback: the plain 'progress' track, NOT the vow/foe
  const jrn = Ctrl._newestOpenTrackItem(actor, "journey");
  eq(jrn?.name, "Greywatch Trek", "journey fallback picks the unflagged 'progress' track");
  ok(jrn.system.subtype !== "foe" && jrn.system.subtype !== "vow", "journey fallback never picks a foe or vow");

  // combat detection of sheet-made foe (subtype 'foe', no flag)
  const foes = Ctrl.getCombatTracks(actor);
  ok(foes.find(f => f.name === "Hand-made Bear"), "getCombatTracks recognises sheet-made foe (subtype 'foe')");
}

console.log("[3] markProgress / markProgressByRank / completeTrack write schema fields");
{
  const actor = new MockActor();
  const r = await Ctrl.createProgressTrack(actor, "Vow A", "vow", "formidable"); // formidable → +4 ticks/mark
  const item = actor.items.get(r.id);

  await Ctrl.markProgressByRank(actor, "Vow A", 1);
  eq(item.system.current, 4, "markProgressByRank(formidable) adds 4 ticks");
  await Ctrl.markProgressByRank(actor, "Vow A", 2);
  eq(item.system.current, 12, "two more marks (+8) → 12 ticks");

  await Ctrl.markProgress(actor, "Vow A", 100); // clamp test
  eq(item.system.current, 40, "markProgress clamps to 40 ticks max");

  const c = await Ctrl.completeTrack(actor, "Vow A");
  ok(c.ok, "completeTrack returns ok");
  eq(item.system.completed, true, "completeTrack sets system.completed = true");
}

console.log("");
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
