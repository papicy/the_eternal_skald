/* =====================================================================
 *  CLOSED-TRACK PROGRESS-MOVE GUARD test (v0.22.x).
 *
 *  Guards the fix for a production bug: after a combat progress track was
 *  closed at 10/10, the Skald still suggested "End the Fight" against the
 *  defeated foe, and rolling it dead-ended with a generic "Enter the fray
 *  first" error.
 *
 *  Two complementary fixes, both exercised here against the REAL controller:
 *
 *    1) IronswornController.describeCombatState (scripts/ironsworn/combat.js)
 *       — the AI-facing combat context now carries a STATE-AWARE rollability
 *       hint: "End the Fight" is announced as rollable ONLY for active foes at
 *       10/10, the AI is told NOT to suggest it when no foe is at 10/10, and
 *       NOT to suggest it against ended (closed) fights.
 *
 *    2) IronswornController.rollProgressMove (scripts/ironsworn/moves.js)
 *       — when no OPEN track of the move's kind exists but one was RECENTLY
 *       COMPLETED, the move returns a graceful { ok:false,
 *       method:"already-complete" } result (so the Skald narrates the
 *       resolution) instead of the generic "begin one first" error. Applies
 *       uniformly to combat, vows and journeys.
 *
 *  Player agency (brief §1.3) is preserved: a MANUAL roll against a still-open
 *  track below 10/10 is NOT blocked by these changes — only the AI's
 *  SUGGESTION text and the closed-track dead-end are affected.
 *
 *  Run: node test/ironsworn-closed-track.test.mjs
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

const SCOPE = "the-eternal-skald";
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
  async setFlag(scope, key, value) { this.flags[scope] = this.flags[scope] ?? {}; this.flags[scope][key] = value; return this; }
  async update(changes) {
    for (const [path, value] of Object.entries(changes)) setProperty(this, path, value);
    return this;
  }
}
class MockCollection extends Array { get(id) { return this.find(i => i.id === id) ?? null; } }
class MockActor {
  constructor() {
    this.id = "actor1"; this.name = "Test Character"; this.type = "character";
    this.items = new MockCollection();
    this.flags = {};
  }
  add(data) { const it = new MockItem(data, this); this.items.push(it); return it; }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  async setFlag(scope, key, value) { this.flags[scope] = this.flags[scope] ?? {}; this.flags[scope][key] = value; return this; }
  testUserPermission() { return true; }
}

/** Build a progress-track item of a given kind at a given filled-box count. */
function track(actor, name, kind, boxes, completed) {
  const subtype = kind === "combat" ? "foe" : (kind === "vow" ? "vow" : "progress");
  return actor.add({
    name, type: "progress",
    system: { subtype, rank: "formidable", current: boxes * 4, completed: !!completed },
    flags: { [SCOPE]: { trackKind: kind } }
  });
}

const { default: Ctrl } = await import("../scripts/ironsworn-controller.js");

/* ===================================================================== */
console.log("[1] describeCombatState — foe at 10/10 is announced ROLLABLE");
{
  const actor = new MockActor();
  track(actor, "Hrafn the Oathbreaker", "combat", 10, false);
  const txt = Ctrl.describeCombatState(actor);
  ok(/ROLLABLE now against:.*Hrafn/.test(txt), "10/10 foe announced as a valid End the Fight target");
  ok(!/Do NOT suggest "End the Fight" yet/.test(txt), "no 'not yet' warning when a foe is at 10/10");
}

console.log("[2] describeCombatState — foe BELOW 10/10 warns AI not to suggest the move");
{
  const actor = new MockActor();
  track(actor, "Snow Wolf", "combat", 6, false);
  const txt = Ctrl.describeCombatState(actor);
  ok(/Do NOT suggest "End the Fight" yet/.test(txt), "under-filled foe → 'not yet' guidance");
  ok(!/ROLLABLE now/.test(txt), "no rollable announcement below 10/10");
}

console.log("[3] describeCombatState — CLOSED fight warns AI not to suggest the move");
{
  const actor = new MockActor();
  track(actor, "Bog Rot", "combat", 10, true); // completed
  const txt = Ctrl.describeCombatState(actor);
  ok(/Recently ended fights:.*Bog Rot/.test(txt), "completed foe listed under ended fights");
  ok(/Do NOT suggest "End the Fight" against ended fights/.test(txt), "closed fight → do-not-suggest guidance");
  ok(!/ROLLABLE now/.test(txt), "a closed-only board offers no rollable End the Fight target");
}

console.log("[4] rollProgressMove — closed combat track → graceful 'already-complete'");
{
  const actor = new MockActor();
  track(actor, "Hrafn the Oathbreaker", "combat", 10, true); // defeated foe, closed
  const r = await Ctrl.rollProgressMove("End the Fight", { actor });
  eq(r.ok, false, "no roll happens against a closed track");
  eq(r.method, "already-complete", "graceful already-complete result (not the generic error)");
  eq(r.track, "Hrafn the Oathbreaker", "names the completed track");
  ok(/already complete/i.test(r.error) && /already won/i.test(r.error), "message says the fight is already won");
  ok(!/Enter the fray first/.test(r.error), "does NOT fall through to the generic 'begin one first' error");
}

console.log("[5] rollProgressMove — closed VOW track → graceful 'already-complete'");
{
  const actor = new MockActor();
  track(actor, "Avenge my father", "vow", 10, true);
  const r = await Ctrl.rollProgressMove("Fulfill Your Vow", { actor });
  eq(r.method, "already-complete", "vow closed-track fallback fires too");
  ok(/already fulfilled/i.test(r.error), "vow message says it is already fulfilled");
}

console.log("[6] rollProgressMove — closed JOURNEY track → graceful 'already-complete'");
{
  const actor = new MockActor();
  track(actor, "Journey to the Frozen Keep", "journey", 10, true);
  const r = await Ctrl.rollProgressMove("Reach Your Destination", { actor });
  eq(r.method, "already-complete", "journey closed-track fallback fires too");
  ok(/already complete/i.test(r.error), "journey message says it is already complete");
}

console.log("[7] PLAYER AGENCY — no completed track of the kind → generic error preserved");
{
  const actor = new MockActor(); // no tracks at all
  const r = await Ctrl.rollProgressMove("End the Fight", { actor });
  eq(r.method, "none", "with nothing closed, the original 'no open track' path is unchanged");
  ok(/No open fight track/.test(r.error), "generic actionable error still shown when appropriate");
  ok(r.method !== "already-complete", "the graceful fallback does NOT fire when no track was completed");
}

/* ===================================================================== */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
