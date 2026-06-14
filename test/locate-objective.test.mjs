/* =====================================================================
 *  "Locate Your Objective" / "Escape the Depths" end-to-end test.
 *
 *  Reproduces the Delve site progress-roll call chain:
 *    triggerMove("Locate Your Objective") → _isProgressMove → rollProgressMove
 *    → kind "site" → _openSiteTracks → (auto | _showSiteSelectionDialog)
 *    → showForProgress(track.score)
 *
 *  Sites are progress Items tagged flags.<scope>.trackKind="delve" (created by
 *  SiteGenerator / createProgressTrack with trackType "delve"). These tests
 *  cover: whitelist recognition, the no-site error, single-site auto-detect,
 *  multi-site selection dialog (choose + cancel), the sheet-triggered trackRef
 *  path, and a regression guard that vow/journey/combat resolution is unchanged.
 *
 *  Run: node test/locate-objective.test.mjs
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
globalThis.CONFIG = {
  Item: { dataModels: { "asset": {}, "progress": {}, "ledger-entry": {}, "bondset": {}, "sfmove": {}, "delve-theme": {}, "delve-domain": {} } }
};

// Record the progress rolls the system dialog is asked to make.
let progressRolls = [];
globalThis.CONFIG.IRONSWORN = {
  applications: {
    IronswornPrerollDialog: {
      async showForProgress(name, score, actor, dsid) { progressRolls.push({ name, score, dsid }); }
    }
  }
};
globalThis.game = { user: { id: "u1" }, actors: [], system: { id: "foundry-ironsworn" } };
globalThis.canvas = { tokens: { controlled: [] } };

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
  async update(changes) { for (const [p, v] of Object.entries(changes)) setProperty(this, p, v); return this; }
}
class MockCollection extends Array { get(id) { return this.find(i => i.id === id) ?? null; } }
class MockActor {
  constructor(type = "character") { this.id = `actor${++_id}`; this.type = type; this.items = new MockCollection(); }
  async createEmbeddedDocuments(_kind, dataList) {
    const created = dataList.map(d => new MockItem(d, this));
    this.items.push(...created);
    return created;
  }
  testUserPermission() { return true; }
}

/* ===================================================================== */
const { default: Ctrl } = await import("../scripts/ironsworn-controller.js");

/** Make an open site track (trackKind "delve") and return its live Item. */
async function makeSite(actor, name, rank = "dangerous", boxes = 0) {
  const res = await Ctrl.createProgressTrack(actor, { name, trackType: "delve", rank, description: "" });
  const item = actor.items.get(res.id);
  if (boxes) await item.update({ "system.current": boxes * 4 });
  return item;
}

console.log("Locate Your Objective / Escape the Depths test\n");

console.log("[1] _isProgressMove whitelists the two Delve site moves");
{
  ok(Ctrl._isProgressMove("move:delve/delve/locate_your_objective", null), "[1] locate by dsid");
  ok(Ctrl._isProgressMove("move:delve/delve/escape_the_depths", null), "[1] escape by dsid");
  ok(Ctrl._isProgressMove(null, "Locate Your Objective"), "[1] locate by name");
  ok(Ctrl._isProgressMove(null, "Escape the Depths"), "[1] escape by name");
  // Existing progress moves still recognised.
  ok(Ctrl._isProgressMove(null, "Fulfill Your Vow"), "[1] vow still recognised");
  ok(Ctrl._isProgressMove(null, "Reach Your Destination"), "[1] journey still recognised");
  ok(Ctrl._isProgressMove(null, "End the Fight"), "[1] combat still recognised");
  // Non-progress moves rejected.
  ok(!Ctrl._isProgressMove(null, "Delve the Depths"), "[1] Delve the Depths is NOT a progress move");
  ok(!Ctrl._isProgressMove(null, "Face Danger"), "[1] Face Danger is NOT a progress move");
}

console.log("[2] _openSiteTracks finds only open delve tracks, newest first");
{
  const actor = new MockActor();
  await makeSite(actor, "The Haunted Barrow");
  await makeSite(actor, "The Sunken Stronghold");
  const completed = await makeSite(actor, "The Cleared Mine");
  await completed.update({ "system.completed": true });
  // A vow and a journey must NOT be treated as sites.
  await Ctrl.createProgressTrack(actor, { name: "A Vow", trackType: "vow", rank: "formidable" });
  await Ctrl.createProgressTrack(actor, { name: "A Journey", trackType: "journey", rank: "dangerous" });

  const sites = Ctrl._openSiteTracks(actor);
  eq(sites.length, 2, "[2] exactly the two OPEN sites are returned");
  ok(sites.every(s => s.name !== "The Cleared Mine"), "[2] completed site excluded");
  ok(sites.every(s => s.name !== "A Vow" && s.name !== "A Journey"), "[2] vow/journey excluded");
  eq(sites[0].name, "The Sunken Stronghold", "[2] newest site first");
}

console.log("[3] No open site → clear, actionable error (no crash)");
{
  const actor = new MockActor();
  const res = await Ctrl.rollProgressMove("Locate Your Objective", { actor });
  ok(!res.ok, "[3] returns not-ok");
  eq(res.method, "none", "[3] method 'none'");
  ok(/no open site track/i.test(res.error ?? ""), "[3] error names the missing site track");
  ok(/discover a site/i.test(res.error ?? ""), "[3] error tells the player to Discover a Site first");
}

console.log("[4] Exactly one open site → auto-detected and rolled (no dialog)");
{
  progressRolls = [];
  const actor = new MockActor();
  await makeSite(actor, "The Whispering Cavern", "formidable", 3); // 3 boxes
  const res = await Ctrl.rollProgressMove("Locate Your Objective", { actor });
  ok(res.ok, "[4] roll succeeds");
  eq(res.method, "progress-dialog", "[4] used the system progress dialog");
  eq(res.track, "The Whispering Cavern", "[4] rolled against the only site");
  eq(progressRolls.length, 1, "[4] exactly one progress roll fired");
  eq(progressRolls[0].score, 3, "[4] rolled the site's score (3 boxes)");
  eq(Ctrl._lastProgressTrack?.kind, "site", "[4] last-progress pointer tagged kind 'site'");
}

console.log("[5] Multiple open sites → selection dialog; chosen site is rolled");
{
  progressRolls = [];
  const actor = new MockActor();
  const barrow = await makeSite(actor, "The Haunted Barrow", "dangerous", 5);
  const keep   = await makeSite(actor, "The Underkeep", "extreme", 2);
  // Stub DialogV2 to "choose" the Underkeep by id.
  let dialogShown = false, shownContent = "";
  globalThis.foundry.applications = { api: { DialogV2: { async prompt(cfg) {
    dialogShown = true; shownContent = cfg?.content ?? ""; return keep.id;
  } } } };
  const res = await Ctrl.rollProgressMove("Escape the Depths", { actor });
  ok(dialogShown, "[5] the selection dialog was shown");
  ok(/Escape the Depths/.test(shownContent), "[5] dialog names the move");
  ok(res.ok, "[5] roll succeeds after selection");
  eq(res.track, "The Underkeep", "[5] rolled against the chosen site");
  eq(progressRolls[0].score, 2, "[5] rolled the chosen site's score (2 boxes)");
  ok(barrow && keep, "[5] both sites existed as candidates");
}

console.log("[6] Selection dialog cancelled → move aborts cleanly (never auto-picks)");
{
  progressRolls = [];
  const actor = new MockActor();
  await makeSite(actor, "Site A");
  await makeSite(actor, "Site B");
  globalThis.foundry.applications = { api: { DialogV2: { async prompt() { return null; } } } };
  const res = await Ctrl.rollProgressMove("Locate Your Objective", { actor });
  ok(!res.ok, "[6] returns not-ok on cancel");
  eq(res.method, "cancelled", "[6] method 'cancelled'");
  eq(progressRolls.length, 0, "[6] NO roll fired when cancelled");
}

console.log("[7] Sheet-triggered: explicit trackRef rolls that site, no dialog");
{
  progressRolls = [];
  let dialogShown = false;
  globalThis.foundry.applications = { api: { DialogV2: { async prompt() { dialogShown = true; return null; } } } };
  const actor = new MockActor();
  await makeSite(actor, "Site One");
  await makeSite(actor, "Site Two", "dangerous", 4);
  const res = await Ctrl.rollProgressMove("Locate Your Objective", { actor, trackRef: "Site Two" });
  ok(res.ok, "[7] roll succeeds with explicit trackRef");
  eq(res.track, "Site Two", "[7] rolled the sheet-supplied site");
  ok(!dialogShown, "[7] dialog NOT shown when trackRef is provided");
  eq(progressRolls[0].score, 4, "[7] rolled the supplied site's score (4 boxes)");
}

console.log("[8] triggerMove routes the Delve site move through the progress path");
{
  progressRolls = [];
  const actor = new MockActor();
  await makeSite(actor, "The Lone Tomb", "formidable", 6);
  const res = await Ctrl.triggerMove("move:delve/delve/locate_your_objective", { actor });
  ok(res.ok, "[8] triggerMove → progress roll succeeds");
  eq(res.track, "The Lone Tomb", "[8] resolved the site");
  eq(progressRolls[0].score, 6, "[8] rolled 6 boxes");
}

console.log("[9] Regression: vow/journey/combat resolution is unchanged");
{
  progressRolls = [];
  const actor = new MockActor();
  await Ctrl.createProgressTrack(actor, { name: "Avenge the Fallen", trackType: "vow", rank: "formidable" });
  const vow = actor.items.find(i => i.name === "Avenge the Fallen");
  // (gate 2026-06-14) The 10/10 completion gate is now symmetric across
  // journey/vow/combat, so a completion roll fires only on a fully-charted
  // track. Charge the vow to 10/10 — this still verifies the track RESOLUTION
  // (the vow is picked, not the open site) which is what this regression guards.
  await vow.update({ "system.current": 10 * 4 }); // 10 boxes (fully charted)
  // Add an open site too — it must NOT be picked for "Fulfill Your Vow".
  await makeSite(actor, "A Distracting Site");
  const res = await Ctrl.rollProgressMove("Fulfill Your Vow", { actor });
  ok(res.ok, "[9] Fulfill Your Vow still rolls");
  eq(res.track, "Avenge the Fallen", "[9] picked the vow, not the site");
  eq(progressRolls[0].score, 10, "[9] rolled the vow's score");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
