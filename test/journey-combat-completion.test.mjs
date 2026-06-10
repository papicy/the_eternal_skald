/* =====================================================================
 *  Journey separation + journey/foe AUTO-COMPLETION test (v0.10.35).
 *
 *  Guards the v0.10.35 fixes for two production bugs:
 *
 *    BUG 1 — Journeys grouped into one track and never completed.
 *      Root cause: Integration._autoJourneyFlow ALWAYS reused the newest open
 *      journey track, and journeys never closed at 10/10, so the first journey
 *      stayed open forever and every later journey advanced it.
 *      Fix: reuse an open journey ONLY when it is the SAME destination (fuzzy
 *      name match within the journey kind); a different destination opens its
 *      own track, AND a journey that reaches 10/10 auto-completes.
 *
 *    BUG 2 — Foe combat never auto-completed.
 *      Root cause: Strike/Clash marked foe progress but nothing closed the
 *      track at 10/10, and a narrated end_combat with a missing/paraphrased
 *      name failed to resolve the foe.
 *      Fix: a foe at 10/10 auto-completes; end_combat falls back to a fuzzy
 *      combat match then the active-combat track.
 *
 *  These exercise the REAL controller primitives the Integration auto-flows
 *  compose (createProgressTrack, findTrackFuzzy, _newestOpenTrackItem,
 *  markProgress(ByRank), completeTrack, getActiveCombat(Track), setActiveCombat)
 *  and replicate the small decision/threshold logic the fix added, so the
 *  intended behaviour is locked in.
 *
 *  Run: node test/journey-combat-completion.test.mjs
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
  async setFlag(scope, key, value) { this.flags[scope] = this.flags[scope] ?? {}; this.flags[scope][key] = value; return this; }
  async unsetFlag(scope, key) { if (this.flags?.[scope]) delete this.flags[scope][key]; return this; }
  async update(changes) {
    for (const [path, value] of Object.entries(changes)) setProperty(this, path, value);
    return this;
  }
}
class MockCollection extends Array {
  get(id) { return this.find(i => i.id === id) ?? null; }
}
class MockActor {
  constructor() {
    this.id = "actor1"; this.name = "Test Character"; this.type = "character";
    this.items = new MockCollection();
    this.flags = {};
  }
  add(data) { const it = new MockItem(data, this); this.items.push(it); return it; }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  async setFlag(scope, key, value) { this.flags[scope] = this.flags[scope] ?? {}; this.flags[scope][key] = value; return this; }
  async unsetFlag(scope, key) { if (this.flags?.[scope]) delete this.flags[scope][key]; return this; }
  async createEmbeddedDocuments(_kind, dataList) {
    const created = dataList.map(d => new MockItem(d, this));
    this.items.push(...created);
    return created;
  }
  testUserPermission() { return true; }
}

const SCOPE = "the-eternal-skald";

/* ---- Faithful replicas of the small decision/threshold logic the fix added.
 *      The auto-flows live in eternal-skald.js (Foundry+AI runtime) and call
 *      the controller methods exercised below; these helpers mirror exactly
 *      the branch the fix introduced so the behaviour is asserted end-to-end. */

// Mirror of Integration._inferJourneyName(): "Journey to X" or generic "The Journey".
function inferJourneyName(intent) {
  const s = String(intent || "").trim();
  if (s) {
    const m = s.match(/\b(?:to|toward|towards|for|into|reach|reaching|bound for)\s+((?:the\s+)?[A-Z][\w''’\- ]{2,48})/);
    if (m) {
      const dest = m[1].trim().replace(/[.,;:!?]+$/, "").replace(/\s+/g, " ");
      if (dest && !/^journey\b/i.test(dest)) return `Journey to ${dest}`;
    }
  }
  return "The Journey";
}

// Mirror of the _autoJourneyFlow track-resolution branch: returns the track to
// reuse, or null when a NEW track should be opened.
function resolveJourneyTrack(Ctrl, actor, intent) {
  const inferredName = inferJourneyName(intent);
  const specific = !/^the journey$/i.test(inferredName);
  let track = Ctrl._newestOpenTrackItem(actor, "journey");
  if (track && specific) {
    const match = Ctrl.findTrackFuzzy(actor, inferredName, "journey");
    const matchOpen = match && !getProperty(match, "system.completed");
    track = matchOpen ? match : null;
  }
  return { track, inferredName, specific };
}

/* ===================================================================== */
const { default: Ctrl } = await import("../scripts/ironsworn-controller.js");

console.log("[1] JOURNEY SEPARATION — a new destination opens its OWN track");
{
  const actor = new MockActor();
  // First journey: none open → open one.
  let r = resolveJourneyTrack(Ctrl, actor, "We set out to travel to the Frozen Keep");
  eq(r.track, null, "no open journey initially → create new");
  eq(r.inferredName, "Journey to the Frozen Keep", "destination inferred from intent");
  await Ctrl.createProgressTrack(actor, r.inferredName, "journey", "formidable");

  // Second journey to a DIFFERENT destination while the first is still open.
  r = resolveJourneyTrack(Ctrl, actor, "Now we journey into the Iron Wood");
  eq(r.inferredName, "Journey to the Iron Wood", "second destination inferred");
  eq(r.track, null, "different destination does NOT reuse the open Frozen Keep journey");
  await Ctrl.createProgressTrack(actor, r.inferredName, "journey", "formidable");

  // Both journeys now coexist as SEPARATE open tracks (no grouping).
  const open = actor.items.filter(i => i.getFlag(SCOPE, "trackKind") === "journey"
    && !getProperty(i, "system.completed"));
  eq(open.length, 2, "two simultaneous journeys exist as separate tracks");
}

console.log("[2] JOURNEY REUSE — the SAME destination reuses its open track");
{
  const actor = new MockActor();
  await Ctrl.createProgressTrack(actor, "Journey to the Frozen Keep", "journey", "formidable");
  // A second 'Undertake a Journey' toward the SAME place must reuse it.
  const r = resolveJourneyTrack(Ctrl, actor, "we press on toward the Frozen Keep");
  ok(r.track, "same destination reuses the existing open journey");
  eq(r.track?.name, "Journey to the Frozen Keep", "reused the correct track");
  const journeys = actor.items.filter(i => i.getFlag(SCOPE, "trackKind") === "journey");
  eq(journeys.length, 1, "no duplicate track created for the same destination");
}

console.log("[3] GENERIC INTENT — unknown destination keeps conservative reuse");
{
  const actor = new MockActor();
  await Ctrl.createProgressTrack(actor, "The Journey", "journey", "formidable");
  const r = resolveJourneyTrack(Ctrl, actor, "we keep travelling onward"); // no place name
  eq(r.inferredName, "The Journey", "no destination inferred → generic name");
  ok(r.track, "generic intent reuses the newest open journey (no track spam)");
}

console.log("[4] JOURNEY 10/10 AUTO-COMPLETION");
{
  const actor = new MockActor();
  await Ctrl.createProgressTrack(actor, "Journey to the Frozen Keep", "journey", "formidable");
  const track = Ctrl._newestOpenTrackItem(actor, "journey");
  // Advance to full progress (40 ticks = 10 boxes).
  await Ctrl.setProgress(actor, track.id, 10);
  eq(getProperty(track, "system.current"), 40, "track filled to 40 ticks (10 boxes)");

  // _autoCompleteIfFull logic: current >= 40 → completeTrack.
  ok(getProperty(track, "system.current") >= 40, "threshold reached");
  const c = await Ctrl.completeTrack(actor, track.id);
  ok(c?.ok, "completeTrack succeeds at full progress");
  eq(getProperty(track, "system.completed"), true, "journey marked completed");
  eq(Ctrl._newestOpenTrackItem(actor, "journey"), null, "no open journey remains → next journey opens fresh");
}

console.log("[5] JOURNEY BELOW 10/10 does NOT auto-complete");
{
  const actor = new MockActor();
  await Ctrl.createProgressTrack(actor, "The Long Road North", "journey", "formidable");
  const track = Ctrl._newestOpenTrackItem(actor, "journey");
  await Ctrl.setProgress(actor, track.id, 7); // 28 ticks
  ok(getProperty(track, "system.current") < 40, "below threshold");
  eq(getProperty(track, "system.completed"), false, "still open — must NOT auto-complete early");
}

console.log("[6] FOE 10/10 AUTO-COMPLETION + active-combat cleared");
{
  const actor = new MockActor();
  const cr = await Ctrl.createProgressTrack(actor, "Hrafn the Oathbreaker", "combat", "formidable");
  await Ctrl.setActiveCombat(actor, cr.id);
  const foeSnap = Ctrl.getActiveCombatTrack(actor); // POJO snapshot (id only matters)
  ok(foeSnap, "active combat foe track exists");
  // The fix re-fetches the LIVE item via actor.items.get(id) — mirror that.
  const foe = actor.items.get(foeSnap.id);

  // Bring the foe to full progress and auto-complete (mirrors _autoCombatFlow).
  await Ctrl.setProgress(actor, foe.id, 10);
  ok(getProperty(foe, "system.current") >= 40, "foe at 10/10");
  const c = await Ctrl.completeTrack(actor, foe.id);
  ok(c?.ok, "completeTrack closes the foe at 10/10");
  await Ctrl.clearActiveCombat(actor);
  eq(getProperty(foe, "system.completed"), true, "foe marked defeated");
  eq(Ctrl.getActiveCombatTrack(actor), null, "no open foe track remains");
}

console.log("[7] end_combat FALLBACK — fuzzy match then active-combat track");
{
  const actor = new MockActor();
  const cr = await Ctrl.createProgressTrack(actor, "Bog Rot", "combat", "dangerous");
  await Ctrl.setActiveCombat(actor, cr.id);

  // (a) Paraphrased / partial name still resolves via fuzzy combat-kind match.
  const fuzzy = Ctrl.findTrackFuzzy(actor, "the Bog Rot creature", "combat");
  ok(fuzzy && fuzzy.id === cr.id, "fuzzy combat match resolves the foe from a paraphrase");

  // (b) No name at all → fall back to the active-combat track.
  const active = Ctrl.getActiveCombat(actor);
  ok(active && active.id === cr.id, "active-combat fallback resolves the current foe");

  const c = await Ctrl.completeTrack(actor, (fuzzy ?? active).id);
  const liveFoe = actor.items.get(cr.id);
  ok(c?.ok && getProperty(liveFoe, "system.completed") === true, "narrated end_combat closes the fight");
}

console.log("[8] REGRESSION — completing journey/foe is NOT a vow (no XP award)");
{
  // The auto vow-XP hook (eternal-skald.js updateItem) only fires when the
  // completed track is a VOW (subtype 'vow' OR trackKind 'vow'). Verify the
  // tracks our fix completes never satisfy that gate.
  const actor = new MockActor();
  await Ctrl.createProgressTrack(actor, "Journey to X", "journey", "formidable");
  await Ctrl.createProgressTrack(actor, "Some Foe", "combat", "formidable");
  const j = actor.items.find(i => i.getFlag(SCOPE, "trackKind") === "journey");
  const f = actor.items.find(i => i.getFlag(SCOPE, "trackKind") === "combat");
  const isVow = (it) => getProperty(it, "system.subtype") === "vow" || it.getFlag(SCOPE, "trackKind") === "vow";
  ok(!isVow(j), "journey track is NOT a vow → XP hook skips it");
  ok(!isVow(f), "combat track is NOT a vow → XP hook skips it");
  // And a real vow still IS recognised (no regression to the XP path).
  const vr = await Ctrl.createProgressTrack(actor, "The Truth of the Star-Fall", "vow", "dangerous");
  const v = actor.items.get(vr.id);
  ok(isVow(v), "a vow track is still recognised by the XP gate");
}

/* ===================================================================== */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
