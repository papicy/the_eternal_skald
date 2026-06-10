/* =====================================================================
 *  Compendium Creation test (v0.10.37 — Phase 3).
 *
 *  Locks in the Phase 3 additions to the PURE controller layer that bring
 *  official foundry-ironsworn compendium content into play, plus faithful
 *  replicas of the small parse/gating logic added to the Foundry+AI layer
 *  (eternal-skald.js, which is not unit-testable in isolation):
 *
 *    • addAssetToActor   — fuzzy compendium lookup → embedded Item create,
 *                          idempotent (no-op when already owned), not-found.
 *    • addItemToActor    — searches Item packs (excludes foe/encounter),
 *                          matching ladder + dedupe + suggestion.
 *    • createFoeActor    — copies a real foe actor from the bestiary (reads
 *                          rank off the embedded progress item) and falls
 *                          back to a minimal custom foe when not found.
 *    • createCharacter   — Actor.create with clamped/default stats + meters,
 *                          optional asset seeding.
 *    • lookupFoeActorInCompendium — match ladder + suggestion.
 *    • effect parse replicas — add_asset / add_item / create_foe /
 *                          create_character (incl. quotes, rank, unique).
 *    • creation-mode gating replica — off / foes / full.
 *
 *  Run: node test/compendium-creation.test.mjs
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
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
globalThis.foundry = { utils: { getProperty, setProperty, deepClone } };
globalThis.CONFIG = { Item: { dataModels: { "asset": {}, "progress": {}, "bondset": {} } } };

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
}
class MockCollection extends Array {
  get(id) { return this.find(i => i.id === id) ?? null; }
  find(fn) { return Array.prototype.find.call(this, fn); }
}
class MockActor {
  constructor(data = {}) {
    this.id = data._id ?? `actor${++_id}`;
    this.name = data.name ?? "Unnamed";
    this.type = data.type ?? "character";
    this.uuid = `Actor.${this.id}`;
    this.system = data.system ?? {};
    this.flags = data.flags ?? {};
    this.folder = data.folder ?? null;
    this.items = new MockCollection();
    for (const it of (data.items ?? [])) this.items.push(new MockItem(it, this));
  }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  async createEmbeddedDocuments(type, dataArr) {
    const created = [];
    for (const d of dataArr) { const it = new MockItem(d, this); this.items.push(it); created.push(it); }
    return created;
  }
}

/* ---- Compendium plumbing: UUID registry + mock packs ---- */
const UUID_REGISTRY = new Map();
const CREATED_ACTORS = [];

/** A compendium Document — toObject() returns clean plain data. */
function makeDoc(packId, data) {
  const uuid = `Compendium.${packId}.${data._id}`;
  const doc = {
    ...data,
    uuid,
    toObject() { return deepClone(data); }
  };
  UUID_REGISTRY.set(uuid, doc);
  return data; // pack index entries are built from the raw data
}

class MockPack {
  constructor(id, label, documentName, docs) {
    this.documentName = documentName;
    this.collection = id;
    this.metadata = { id, label };
    this._docs = docs.map(d => makeDoc(id, d));
  }
  async getIndex(/* {fields} */) {
    const contents = this._docs.map(d => ({
      _id: d._id, name: d.name, type: d.type,
      uuid: `Compendium.${this.metadata.id}.${d._id}`
    }));
    return { contents };
  }
}

/* Asset items (type asset). */
const assetPack = new MockPack("foundry-ironsworn.ironswornassets", "Ironsworn Assets", "Item", [
  { _id: "a1", name: "Sword", type: "asset", system: { category: "Combat Talent", abilities: [] } },
  { _id: "a2", name: "Loyal Companion", type: "asset", system: { category: "Companion", abilities: [] } },
  { _id: "a3", name: "Fledgling Spell", type: "asset", system: { category: "Ritual", abilities: [] } }
]);
/* Non-asset items (moves) — for addItemToActor. */
const movePack = new MockPack("foundry-ironsworn.ironswornmoves", "Ironsworn Moves", "Item", [
  { _id: "m1", name: "Face Danger", type: "sfmove", system: {} },
  { _id: "m2", name: "Delve the Depths", type: "sfmove", system: {} }
]);
/* Foe ITEMS (should be EXCLUDED from addItemToActor's search). */
const foeItemPack = new MockPack("foundry-ironsworn.ironswornfoes", "Ironsworn Foes", "Item", [
  { _id: "fi1", name: "Bear", type: "progress", system: { rank: 2 } }
]);
/* Foe ACTORS (type foe, with embedded progress carrying the rank). */
const foeActorPack = new MockPack("foundry-ironsworn.foeactorsis", "Ironsworn Foe Actors", "Actor", [
  { _id: "fa1", name: "Basilisk", type: "foe", system: { dfid: "" },
    items: [{ _id: "fap1", name: "Basilisk", type: "progress", system: { rank: 3, subtype: "progress", current: 0 } }] },
  { _id: "fa2", name: "Bear", type: "foe", system: { dfid: "" },
    items: [{ _id: "fap2", name: "Bear", type: "progress", system: { rank: 2, subtype: "progress", current: 0 } }] }
]);

globalThis.game = {
  system: { id: "foundry-ironsworn" },
  user: { id: "u1" },
  actors: [],
  packs: [assetPack, movePack, foeItemPack, foeActorPack]
};
globalThis.canvas = { tokens: { controlled: [] } };
globalThis.fromUuid = async (uuid) => UUID_REGISTRY.get(uuid) ?? null;
globalThis.Actor = function Actor() {};
globalThis.Actor.create = async (data) => { const a = new MockActor(data); CREATED_ACTORS.push(a); return a; };

const { default: Ctrl } = await import("../scripts/ironsworn-controller.js");

/* =====================================================================
 *  addAssetToActor
 * ===================================================================== */
console.log("[1] addAssetToActor — adds a compendium asset to the character");
{
  const actor = new MockActor({ name: "Hero", type: "character" });
  const r = await Ctrl.addAssetToActor(actor, "Sword");
  ok(r.ok, "ok");
  eq(r.name, "Sword", "asset name");
  ok(!r.noop, "not a no-op the first time");
  eq(actor.items.length, 1, "one embedded item created");
  eq(actor.items[0].type, "asset", "embedded item is an asset");
}

console.log("[2] addAssetToActor — fuzzy match resolves a near name");
{
  const actor = new MockActor({ name: "Hero", type: "character" });
  const r = await Ctrl.addAssetToActor(actor, "loyal companion"); // lowercase
  ok(r.ok, "ok");
  eq(r.name, "Loyal Companion", "matched canonical name");
}

console.log("[3] addAssetToActor — idempotent: re-adding owned asset is a no-op");
{
  const actor = new MockActor({ name: "Hero", type: "character" });
  await Ctrl.addAssetToActor(actor, "Sword");
  const r2 = await Ctrl.addAssetToActor(actor, "Sword");
  ok(r2.ok && r2.noop, "second add is a no-op");
  eq(actor.items.length, 1, "still only one asset");
}

console.log("[4] addAssetToActor — allowDuplicate forces a second copy");
{
  const actor = new MockActor({ name: "Hero", type: "character" });
  await Ctrl.addAssetToActor(actor, "Sword");
  const r2 = await Ctrl.addAssetToActor(actor, "Sword", { allowDuplicate: true });
  ok(r2.ok && !r2.noop, "duplicate allowed");
  eq(actor.items.length, 2, "two copies");
}

console.log("[5] addAssetToActor — unknown asset → not found (no item added)");
{
  const actor = new MockActor({ name: "Hero", type: "character" });
  const r = await Ctrl.addAssetToActor(actor, "Lightsaber of Doom");
  ok(!r.ok, "not ok");
  ok(/not found/i.test(r.error || ""), "error mentions not found");
  eq(actor.items.length, 0, "nothing added");
}

console.log("[6] addAssetToActor — no actor / no name guarded");
{
  const r1 = await Ctrl.addAssetToActor(null, "Sword");
  ok(!r1.ok, "null actor rejected");
  const actor = new MockActor({ name: "Hero" });
  const r2 = await Ctrl.addAssetToActor(actor, "");
  ok(!r2.ok, "empty name rejected");
}

/* =====================================================================
 *  addItemToActor
 * ===================================================================== */
console.log("[7] addItemToActor — adds a non-asset compendium item (move)");
{
  const actor = new MockActor({ name: "Hero", type: "character" });
  const r = await Ctrl.addItemToActor(actor, "Delve the Depths");
  ok(r.ok, "ok");
  eq(r.name, "Delve the Depths", "item name");
  eq(r.type, "sfmove", "item type");
  eq(actor.items.length, 1, "one embedded item");
}

console.log("[8] addItemToActor — excludes foe/encounter packs from the search");
{
  const actor = new MockActor({ name: "Hero", type: "character" });
  // "Bear" exists ONLY in the foe ITEM pack (ironswornfoes), which must be skipped.
  const r = await Ctrl.addItemToActor(actor, "Bear");
  ok(!r.ok, "not found — foe pack excluded");
  eq(actor.items.length, 0, "nothing added");
}

console.log("[9] addItemToActor — idempotent dedupe by name");
{
  const actor = new MockActor({ name: "Hero", type: "character" });
  await Ctrl.addItemToActor(actor, "Face Danger");
  const r2 = await Ctrl.addItemToActor(actor, "Face Danger");
  ok(r2.ok && r2.noop, "second add no-op");
  eq(actor.items.length, 1, "still one");
}

/* =====================================================================
 *  lookupFoeActorInCompendium
 * ===================================================================== */
console.log("[10] lookupFoeActorInCompendium — exact + suggestion");
{
  Ctrl.clearFoeActorCache();
  const hit = await Ctrl.lookupFoeActorInCompendium("Basilisk");
  ok(hit.found, "found Basilisk");
  eq(hit.match, "exact", "exact match");
  const miss = await Ctrl.lookupFoeActorInCompendium("Basilsk"); // typo
  ok(miss.found || miss.suggestion, "typo resolves via fuzzy or offers a suggestion");
}

/* =====================================================================
 *  createFoeActor
 * ===================================================================== */
console.log("[11] createFoeActor — copies a real foe actor + reads its rank");
{
  Ctrl.clearFoeActorCache();
  const before = CREATED_ACTORS.length;
  const r = await Ctrl.createFoeActor("Basilisk");
  ok(r.ok, "ok");
  eq(r.source, "compendium", "spawned from compendium");
  eq(r.name, "Basilisk", "name");
  eq(r.rank, "formidable", "rank read from embedded progress (3 → formidable)");
  eq(CREATED_ACTORS.length, before + 1, "an actor was created");
  eq(CREATED_ACTORS[CREATED_ACTORS.length - 1].type, "foe", "created actor is type foe");
}

console.log("[12] createFoeActor — custom fallback when not in the bestiary");
{
  Ctrl.clearFoeActorCache();
  const before = CREATED_ACTORS.length;
  const r = await Ctrl.createFoeActor("Hrafn the Oathbreaker", { rank: "extreme", important: true });
  ok(r.ok, "ok");
  eq(r.source, "custom", "custom foe");
  eq(r.rank, "extreme", "uses requested rank");
  eq(CREATED_ACTORS.length, before + 1, "an actor was created");
  const a = CREATED_ACTORS[CREATED_ACTORS.length - 1];
  eq(a.type, "foe", "type foe");
  eq(a.items.length, 1, "one embedded progress track");
  eq(a.items[0].type, "progress", "embedded item is progress");
}

console.log("[13] createFoeActor — custom foe with no rank defaults to dangerous");
{
  Ctrl.clearFoeActorCache();
  const r = await Ctrl.createFoeActor("Nameless Horror", { important: true });
  ok(r.ok, "ok");
  eq(r.source, "custom", "custom");
  eq(r.rank, "dangerous", "default rank");
}

console.log("[14] createFoeActor — no name guarded");
{
  const r = await Ctrl.createFoeActor("");
  ok(!r.ok, "empty name rejected");
}

/* =====================================================================
 *  createCharacter
 * ===================================================================== */
console.log("[15] createCharacter — default stats + full meters");
{
  const before = CREATED_ACTORS.length;
  const r = await Ctrl.createCharacter("Astrid Wolfsbane");
  ok(r.ok, "ok");
  eq(r.name, "Astrid Wolfsbane", "name");
  eq(CREATED_ACTORS.length, before + 1, "actor created");
  const a = CREATED_ACTORS[CREATED_ACTORS.length - 1];
  eq(a.type, "character", "type character");
  eq(a.system.health, 5, "health 5");
  eq(a.system.spirit, 5, "spirit 5");
  eq(a.system.supply, 5, "supply 5");
  eq(a.system.momentum, 2, "momentum 2");
  // default stats sum to a rules-legal spread
  const sum = a.system.edge + a.system.heart + a.system.iron + a.system.shadow + a.system.wits;
  eq(sum, 9, "default stat array sums to 9 (3/2/2/1/1)");
}

console.log("[16] createCharacter — caller stats are clamped to 0–5");
{
  const r = await Ctrl.createCharacter("Bjorn", { stats: { iron: 99, edge: -4, heart: 3 } });
  ok(r.ok, "ok");
  const a = CREATED_ACTORS[CREATED_ACTORS.length - 1];
  eq(a.system.iron, 5, "iron clamped to 5");
  eq(a.system.edge, 0, "edge clamped to 0");
  eq(a.system.heart, 3, "heart respected");
}

console.log("[17] createCharacter — seeds starting assets by name");
{
  const r = await Ctrl.createCharacter("Sael", { assets: ["Sword", "Made-up Asset"] });
  ok(r.ok, "ok");
  ok(Array.isArray(r.assetsAdded) && r.assetsAdded.includes("Sword"), "Sword seeded");
  ok(!r.assetsAdded.includes("Made-up Asset"), "unknown asset silently skipped");
}

console.log("[18] createCharacter — no name guarded");
{
  const r = await Ctrl.createCharacter("");
  ok(!r.ok, "empty name rejected");
}

/* =====================================================================
 *  PARSE replicas — mirror _parseOneEffect (eternal-skald.js) for the
 *  Phase 3 directives, so the directive grammar is regression-locked.
 * ===================================================================== */
const RANKS = ["troublesome", "dangerous", "formidable", "extreme", "epic"];
function unquote(rest) {
  if (!rest) return "";
  let s = String(rest).trim();
  const q = s.match(/^["'“”]([^"'“”]+)["'“”]\s*$/);
  if (q) s = q[1];
  return s.replace(/^[:\-—|]+/, "").replace(/[:\-—|]+$/, "").trim();
}
function splitNameRank(rest) {
  if (!rest) return { name: "", rank: null };
  const tokens = rest.split(/\s+/);
  const idx = tokens.findIndex(t => RANKS.includes(t.toLowerCase().replace(/[^a-z]/g, "")));
  if (idx === -1) return { name: rest.replace(/[:\-—|]+$/, "").trim(), rank: null };
  return {
    name: tokens.slice(0, idx).join(" ").replace(/[:\-—|]+$/, "").trim(),
    rank: tokens[idx].toLowerCase().replace(/[^a-z]/g, "")
  };
}
function parseEffect(body) {
  const lc = body.toLowerCase();
  const firstWord = lc.split(/\s+/)[0];
  if (firstWord === "add_asset" || lc.startsWith("add asset")) {
    const name = unquote(body.replace(/^add[_\s]asset/i, "").trim());
    return name ? { kind: "add_asset", name } : null;
  }
  if (firstWord === "add_item" || lc.startsWith("add item")) {
    const name = unquote(body.replace(/^add[_\s]item/i, "").trim());
    return name ? { kind: "add_item", name } : null;
  }
  if (firstWord === "create_foe" || lc.startsWith("create foe") ||
      firstWord === "spawn_foe" || lc.startsWith("spawn foe")) {
    let rest = body.replace(/^(create|spawn)[_\s]foe/i, "").trim();
    let important = false;
    const mk = rest.match(/[\s(\[]+(unique|boss|narrative|custom)\)?\]?\s*$/i);
    if (mk) { important = true; rest = rest.slice(0, mk.index).trim(); }
    const q = rest.match(/^["'“”]([^"'“”]+)["'“”]\s*(.*)$/);
    let name, rank = null;
    if (q) {
      name = q[1].trim();
      const tok = (q[2] || "").trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") || "";
      rank = RANKS.includes(tok) ? tok : null;
    } else {
      ({ name, rank } = splitNameRank(rest));
    }
    return name ? { kind: "create_foe", name, rank, important } : null;
  }
  if (firstWord === "create_character" || lc.startsWith("create character") ||
      firstWord === "create_pc" || lc.startsWith("create pc")) {
    const name = unquote(body.replace(/^create[_\s](character|pc)/i, "").trim());
    return name ? { kind: "create_character", name } : null;
  }
  return null;
}

console.log("[19] parse — add_asset (bare + quoted)");
{
  eq(parseEffect("add_asset Sword").kind, "add_asset", "kind");
  eq(parseEffect("add_asset Sword").name, "Sword", "name");
  eq(parseEffect('add_asset "Loyal Companion"').name, "Loyal Companion", "quoted multi-word name");
}

console.log("[20] parse — add_item");
{
  const e = parseEffect('add_item "Delve the Depths"');
  eq(e.kind, "add_item", "kind");
  eq(e.name, "Delve the Depths", "name");
}

console.log("[21] parse — create_foe with rank + unique");
{
  const e = parseEffect("create_foe Hrafn the Oathbreaker formidable unique");
  eq(e.kind, "create_foe", "kind");
  eq(e.name, "Hrafn the Oathbreaker", "name (rank/keyword stripped)");
  eq(e.rank, "formidable", "rank");
  ok(e.important, "important flagged by 'unique'");
}

console.log("[22] parse — create_foe bare (no rank, not important)");
{
  const e = parseEffect("create_foe Bear");
  eq(e.name, "Bear", "name");
  eq(e.rank, null, "no rank");
  ok(!e.important, "not important");
}

console.log("[23] parse — create_foe quoted name keeps spaces, trailing rank parsed");
{
  const e = parseEffect('create_foe "Hrafn the Oathbreaker" extreme');
  eq(e.name, "Hrafn the Oathbreaker", "quoted name");
  eq(e.rank, "extreme", "rank after quote");
}

console.log("[24] parse — create_character");
{
  const e = parseEffect("create_character Astrid Wolfsbane");
  eq(e.kind, "create_character", "kind");
  eq(e.name, "Astrid Wolfsbane", "name");
}

/* =====================================================================
 *  GATING replica — mirror the apply-case gating in applyEffects.
 *    add_asset / add_item / create_character  → require "full".
 *    create_foe                                → require !== "off".
 * ===================================================================== */
function allowedUnderMode(kind, mode) {
  if (kind === "create_foe") return mode !== "off";
  return mode === "full"; // add_asset / add_item / create_character
}

console.log("[25] gating — off blocks everything");
{
  ok(!allowedUnderMode("create_foe", "off"), "foe blocked when off");
  ok(!allowedUnderMode("add_asset", "off"), "asset blocked when off");
  ok(!allowedUnderMode("create_character", "off"), "character blocked when off");
}
console.log("[26] gating — foes allows only foe spawning");
{
  ok(allowedUnderMode("create_foe", "foes"), "foe allowed in foes mode");
  ok(!allowedUnderMode("add_asset", "foes"), "asset blocked in foes mode");
  ok(!allowedUnderMode("add_item", "foes"), "item blocked in foes mode");
  ok(!allowedUnderMode("create_character", "foes"), "character blocked in foes mode");
}
console.log("[27] gating — full allows all creation");
{
  ok(allowedUnderMode("create_foe", "full"), "foe allowed in full");
  ok(allowedUnderMode("add_asset", "full"), "asset allowed in full");
  ok(allowedUnderMode("add_item", "full"), "item allowed in full");
  ok(allowedUnderMode("create_character", "full"), "character allowed in full");
}

/* =====================================================================
 *  Defensive: methods degrade gracefully when the system is inactive.
 * ===================================================================== */
console.log("[28] inactive system → creation methods return {ok:false}, never throw");
{
  const savedId = game.system.id;
  game.system.id = "some-other-system";
  const a = await Ctrl.addAssetToActor(new MockActor({ name: "X" }), "Sword");
  const f = await Ctrl.createFoeActor("Basilisk");
  const c = await Ctrl.createCharacter("Y");
  ok(!a.ok && !f.ok && !c.ok, "all guarded off when system inactive");
  game.system.id = savedId;
}

/* ---------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
