/* =====================================================================
 *  Full Sheet Awareness & Modification test (v0.10.36 — Phase 2).
 *
 *  Locks in the Phase 2 additions to the PURE controller layer plus
 *  faithful replicas of the small parse/gating logic added to the
 *  Foundry+AI layer (eternal-skald.js, not unit-testable in isolation):
 *
 *    • getDebilities  — reads the FULL impact set + custom-slot labels.
 *    • getBonds       — reads bondset items into {name, notes}.
 *    • getAssets      — surfaces enabled ability TEXT + condition meter
 *                       (current|value).
 *    • setStat        — absolute set, clamped 0–5, unknown/non-numeric
 *                       rejected, no-op detection.
 *    • setImpact /
 *      toggleImpact   — alias resolution, idempotency, unknown rejected,
 *                       Document-API write via actor.update().
 *    • describeCharacter — the snapshot now includes meters w/ max,
 *                       debilities, asset abilities and bonds.
 *    • resolveImpactKey — loose name → canonical key.
 *    • effect parse replicas — toggle_impact / set_impact / set_stat.
 *    • sheet-mode gating replica — off / impacts / full.
 *
 *  Run: node test/full-sheet-awareness.test.mjs
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
globalThis.CONFIG = { Item: { dataModels: { "asset": {}, "progress": {}, "bondset": {} } } };
globalThis.game = { system: { id: "foundry-ironsworn" }, user: { id: "u1" }, actors: [] };
globalThis.canvas = { tokens: { controlled: [] } };

let _id = 0;
class MockItem {
  constructor(data, parent) {
    this.id = data._id ?? `item${++_id}`;
    this.name = data.name;
    this.type = data.type ?? "progress";
    this.flags = data.flags ?? {};
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
  constructor(system = {}) {
    this.id = "actor1"; this.name = "Test Character"; this.type = "character";
    this.items = new MockCollection();
    this.flags = {};
    // A realistic default character system block (mirrors template.json).
    this.system = Object.assign({
      edge: 2, heart: 1, iron: 3, shadow: 1, wits: 2,
      health: 5, spirit: 4, supply: 3,
      momentum: 2, momentumReset: 2, momentumMax: 10,
      xp: 0,
      debility: {
        corrupted: false, cursed: false, encumbered: false, maimed: false,
        shaken: false, tormented: false, unprepared: false, wounded: false,
        permanentlyharmed: false, traumatized: false, doomed: false,
        indebted: false, battered: false,
        custom1: false, custom1name: "", custom2: false, custom2name: ""
      }
    }, system);
  }
  add(data) { const it = new MockItem(data, this); this.items.push(it); return it; }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  async update(changes) {
    for (const [path, value] of Object.entries(changes)) setProperty(this, path, value);
    return this;
  }
  testUserPermission() { return true; }
}

const { default: Ctrl } = await import("../scripts/ironsworn-controller.js");

/* =====================================================================
 *  READ — getDebilities
 * ===================================================================== */
console.log("[1] getDebilities — reads full impact set incl. custom labels");
{
  const actor = new MockActor();
  actor.system.debility.wounded = true;
  actor.system.debility.indebted = true;            // a Starforged impact
  actor.system.debility.custom1 = true;
  actor.system.debility.custom1name = "Hunted";
  const deb = Ctrl.getDebilities(actor);
  ok(deb.includes("wounded"), "wounded surfaced");
  ok(deb.includes("indebted"), "indebted (extended impact) surfaced");
  ok(deb.includes("Hunted"), "custom impact surfaced by its label, not 'custom1'");
  ok(!deb.includes("custom1"), "raw custom1 key not leaked");
  ok(!deb.includes("custom1name"), "name field not leaked as an impact");
  ok(!deb.includes("shaken"), "inactive impact omitted");
}

/* =====================================================================
 *  READ — getBonds
 * ===================================================================== */
console.log("[2] getBonds — reads bondset items, strips HTML from notes");
{
  const actor = new MockActor();
  actor.add({ type: "bondset", name: "Bonds", system: { bonds: [
    { name: "Eira of the Hearthfire", notes: "<p>Saved my life at <b>Glimmerhold</b>.</p>" },
    { name: "", notes: "ignored — no name" },
    { name: "The Iron Priory", notes: "" }
  ] } });
  const bonds = Ctrl.getBonds(actor);
  eq(bonds.length, 2, "only named bonds returned");
  eq(bonds[0].name, "Eira of the Hearthfire", "first bond name");
  eq(bonds[0].notes, "Saved my life at Glimmerhold.", "notes HTML stripped");
  eq(bonds[1].name, "The Iron Priory", "second bond name");
}
console.log("[3] getBonds — no bondset → empty array (never null)");
{
  const actor = new MockActor();
  const bonds = Ctrl.getBonds(actor);
  ok(Array.isArray(bonds) && bonds.length === 0, "empty array");
}

/* =====================================================================
 *  READ — getAssets (abilities + condition meter)
 * ===================================================================== */
console.log("[4] getAssets — surfaces enabled ability text + track current");
{
  const actor = new MockActor();
  actor.add({ type: "asset", name: "Wolf Companion", system: {
    category: "Companion",
    abilities: [
      { enabled: true,  description: "<p>Your wolf can <b>track</b> any quarry.</p>" },
      { enabled: true,  description: "When you Face Danger using the wolf, add +1." },
      { enabled: false, description: "Locked upgrade." }
    ],
    track: { enabled: true, name: "Health", current: 3, max: 5 }
  } });
  const assets = Ctrl.getAssets(actor);
  eq(assets.length, 1, "one asset");
  const a = assets[0];
  eq(a.unlocked, 2, "two enabled abilities counted");
  eq(a.total, 3, "three total abilities");
  eq(a.abilities.length, 2, "only enabled abilities returned as text");
  eq(a.abilities[0], "Your wolf can track any quarry.", "ability HTML stripped");
  eq(a.track.value, 3, "track reads `current` from template.json schema");
  eq(a.track.max, 5, "track max");
}
console.log("[5] getAssets — legacy `value` track schema still reads");
{
  const actor = new MockActor();
  actor.add({ type: "asset", name: "Old Companion", system: {
    abilities: [{ enabled: true, description: "x" }],
    track: { enabled: true, name: "HP", value: 2, max: 4 }
  } });
  const a = Ctrl.getAssets(actor)[0];
  eq(a.track.value, 2, "legacy value field read");
}

/* =====================================================================
 *  WRITE — setStat (bounds, validation, no-op)
 * ===================================================================== */
console.log("[6] setStat — clamps to 0–5, writes via actor.update()");
{
  const actor = new MockActor();
  let r = await Ctrl.setStat(actor, "iron", 4);
  ok(r.ok && r.to === 4 && r.from === 3, "iron 3→4");
  eq(getProperty(actor, "system.iron"), 4, "actor.update applied");

  r = await Ctrl.setStat(actor, "edge", 99);
  eq(r.to, 5, "clamped to max 5");
  r = await Ctrl.setStat(actor, "heart", -3);
  eq(r.to, 0, "clamped to min 0");
}
console.log("[7] setStat — unknown stat / non-numeric / no-op");
{
  const actor = new MockActor();
  let r = await Ctrl.setStat(actor, "luck", 3);
  ok(!r.ok, "unknown stat rejected");
  r = await Ctrl.setStat(actor, "wits", "abc");
  ok(!r.ok, "non-numeric rejected");
  r = await Ctrl.setStat(actor, "wits", 2);     // already 2
  ok(r.ok && r.noop === true, "unchanged value is a clean no-op");
}

/* =====================================================================
 *  WRITE — setImpact / toggleImpact (aliases, idempotency)
 * ===================================================================== */
console.log("[8] setImpact — sets canonical flag via actor.update()");
{
  const actor = new MockActor();
  let r = await Ctrl.setImpact(actor, "wounded", true);
  ok(r.ok && r.state === true && r.impact === "wounded", "wounded set");
  eq(getProperty(actor, "system.debility.wounded"), true, "flag written");

  r = await Ctrl.setImpact(actor, "wounded", false);
  ok(r.ok && r.state === false, "wounded cleared");
  eq(getProperty(actor, "system.debility.wounded"), false, "flag cleared");
}
console.log("[9] setImpact — alias resolution (harmed→wounded, 'in debt'→indebted)");
{
  const actor = new MockActor();
  let r = await Ctrl.setImpact(actor, "harmed", true);
  ok(r.ok && r.impact === "wounded", "'harmed' resolved to wounded");
  eq(getProperty(actor, "system.debility.wounded"), true, "wounded flag set via alias");

  r = await Ctrl.setImpact(actor, "permanently harmed", true);
  ok(r.ok && r.impact === "permanentlyharmed", "multi-word alias resolved");
}
console.log("[10] setImpact — idempotent no-op + unknown impact rejected");
{
  const actor = new MockActor();
  await Ctrl.setImpact(actor, "shaken", true);
  let r = await Ctrl.setImpact(actor, "shaken", true);   // already on
  ok(r.ok && r.noop === true, "setting already-on impact is a no-op");
  r = await Ctrl.setImpact(actor, "bewildered", true);
  ok(!r.ok, "unknown impact rejected cleanly");
}
console.log("[11] toggleImpact — flips current state");
{
  const actor = new MockActor();
  let r = await Ctrl.toggleImpact(actor, "corrupted");
  ok(r.ok && r.state === true, "off→on");
  r = await Ctrl.toggleImpact(actor, "corrupted");
  ok(r.ok && r.state === false, "on→off");
}
console.log("[12] resolveImpactKey + impactKeys");
{
  eq(Ctrl.resolveImpactKey("RATTLED"), "shaken", "alias case-insensitive");
  eq(Ctrl.resolveImpactKey("traumatised"), "traumatized", "spelling alias");
  eq(Ctrl.resolveImpactKey("nonsense"), null, "unknown → null");
  ok(Ctrl.impactKeys().includes("permanentlyharmed"), "extended key present");
  ok(Ctrl.impactKeys().length >= 13, "full impact set exposed");
}

/* =====================================================================
 *  SNAPSHOT — describeCharacter integrates the new sections
 * ===================================================================== */
console.log("[13] describeCharacter — includes meters/max, debilities, assets, bonds");
{
  const actor = new MockActor();
  actor.system.debility.wounded = true;
  actor.add({ type: "asset", name: "Sworn Sword", system: {
    category: "Combat Talent",
    abilities: [{ enabled: true, description: "When you Strike, add +1." }],
    track: { enabled: false }
  } });
  actor.add({ type: "bondset", name: "Bonds", system: { bonds: [
    { name: "Eira", notes: "Hearth-friend." }
  ] } });
  const snap = Ctrl.describeCharacter(actor);
  ok(/Iron 3/.test(snap), "stats present");
  ok(/health 5\/5/.test(snap), "meter shows value/max");
  ok(/momentum 2\/10/.test(snap), "momentum shows max");
  ok(/Debilities: .*wounded/.test(snap), "debilities listed");
  ok(/Assets:/.test(snap) && /Sworn Sword/.test(snap), "asset name present");
  ok(/When you Strike, add \+1\./.test(snap), "asset ability text present");
  ok(/Bonds:/.test(snap) && /Eira/.test(snap), "bonds section present");
}

/* =====================================================================
 *  PARSE REPLICAS — toggle_impact / set_impact / set_stat
 *  (mirror of Integration._parseOneEffect added in eternal-skald.js)
 * ===================================================================== */
function parseSheetEffect(body) {
  const lc = body.toLowerCase();
  const firstWord = lc.split(/\s+/)[0];
  if (firstWord === "toggle_impact" || lc.startsWith("toggle impact")) {
    const rest = body.replace(/^toggle[_\s]impact/i, "").trim();
    return rest ? { kind: "toggle_impact", impact: rest } : null;
  }
  if (firstWord === "clear_impact" || lc.startsWith("clear impact")) {
    const rest = body.replace(/^clear[_\s]impact/i, "").trim();
    return rest ? { kind: "set_impact", impact: rest, on: false } : null;
  }
  if (firstWord === "set_impact" || lc.startsWith("set impact")) {
    const rest = body.replace(/^set[_\s]impact/i, "").trim();
    const tm = rest.match(/\b(on|off|true|false|set|clear|add|remove)\s*$/i);
    let on = true, name = rest;
    if (tm) { const w = tm[1].toLowerCase(); on = ["on","true","set","add"].includes(w); name = rest.slice(0, tm.index).trim(); }
    return name ? { kind: "set_impact", impact: name, on } : null;
  }
  if (firstWord === "set_stat" || lc.startsWith("set stat")) {
    const rest = body.replace(/^set[_\s]stat/i, "").trim();
    const sm = rest.match(/^([a-z]+)\D*([0-9]+)/i);
    if (!sm) return null;
    const value = parseInt(sm[2], 10);
    if (!Number.isFinite(value)) return null;
    return { kind: "set_stat", stat: sm[1].toLowerCase(), value };
  }
  return null;
}
console.log("[14] parse — toggle_impact / set_impact on|off / clear_impact");
{
  eq(parseSheetEffect("toggle_impact wounded").kind, "toggle_impact", "toggle parsed");
  eq(parseSheetEffect("toggle_impact wounded").impact, "wounded", "toggle impact name");
  let p = parseSheetEffect("set_impact wounded on");
  ok(p.kind === "set_impact" && p.on === true && p.impact === "wounded", "set on");
  p = parseSheetEffect("set_impact shaken off");
  ok(p.on === false && p.impact === "shaken", "set off");
  p = parseSheetEffect("set_impact permanently harmed on");
  ok(p.impact === "permanently harmed" && p.on === true, "multi-word impact kept for controller to canonicalize");
  p = parseSheetEffect("clear_impact corrupted");
  ok(p.kind === "set_impact" && p.on === false && p.impact === "corrupted", "clear → set off");
}
console.log("[15] parse — set_stat");
{
  let p = parseSheetEffect("set_stat iron 4");
  ok(p.kind === "set_stat" && p.stat === "iron" && p.value === 4, "set_stat parsed");
  p = parseSheetEffect("set stat heart 2");
  ok(p && p.stat === "heart" && p.value === 2, "space form parsed");
  eq(parseSheetEffect("set_stat iron"), null, "no value → null");
}

/* =====================================================================
 *  GATING REPLICA — aiModifiesSheet off / impacts / full
 *  (mirror of the switch guards in Integration.applyEffects)
 * ===================================================================== */
function impactAllowed(mode) { return mode !== "off"; }
function statAllowed(mode)   { return mode === "full"; }
console.log("[16] gating — impacts permitted unless off; stats only when full");
{
  ok(!impactAllowed("off"), "off blocks impacts");
  ok(impactAllowed("impacts"), "impacts mode allows impacts");
  ok(impactAllowed("full"), "full allows impacts");
  ok(!statAllowed("off"), "off blocks stats");
  ok(!statAllowed("impacts"), "impacts mode blocks stat edits");
  ok(statAllowed("full"), "full allows stat edits");
}

/* =====================================================================
 *  REGRESSION — existing meter writes still bounded & working
 * ===================================================================== */
console.log("[17] regression — setMomentum / applyHarm still clamp correctly");
{
  const actor = new MockActor();
  let r = await Ctrl.setMomentum(actor, 999);
  eq(getProperty(actor, "system.momentum"), 10, "momentum clamped to max 10");
  r = await Ctrl.applyHarm(actor, 99);
  eq(getProperty(actor, "system.health"), 0, "health floored at 0");
}

/* ---------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
