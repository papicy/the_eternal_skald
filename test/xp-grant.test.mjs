/* =====================================================================
 *  XP-granting test for The Eternal Skald (v0.10.32 — Phase 1).
 *
 *  Exercises the WRITE side of experience handling added in Phase 1:
 *    • xpForRank()        — vow rank → XP scale, incl. optional weak-hit half.
 *    • getRuleset()       — classic vs starforged detection from world flags.
 *    • grantXp()          — classic (system.xp) and starforged (legacy ticks)
 *                           write models, clamping, validation.
 *    • grantVowXp()       — rank-appropriate award with per-track idempotency
 *                           (the safety flag that prevents double awards).
 *    • resolveVowForXp()  — which vow a grant_xp_vow directive attaches to.
 *
 *  Pure node, no Foundry — globals are stubbed and Mock Actor/Item record
 *  their update()/setFlag() calls so we can assert what was written.
 *
 *  Run: node test/xp-grant.test.mjs
 * ===================================================================== */

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

/* ---- Minimal Foundry globals ---- */
function getProperty(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setProperty(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  while (keys.length > 1) {
    const k = keys.shift();
    if (o[k] == null || typeof o[k] !== "object") o[k] = {};
    o = o[k];
  }
  o[keys[0]] = value;
}
globalThis.foundry = { utils: { getProperty, setProperty } };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };

// Capture chat messages instead of posting them.
const _chat = [];
globalThis.ChatMessage = {
  create: (data) => { _chat.push(data); return Promise.resolve(data); },
  getWhisperRecipients: () => [],
  getSpeaker: () => ({ alias: "test" })
};

// Configurable ruleset flags for getRuleset().
let _rulesetFlags = { "ruleset-classic": true };
globalThis.game = {
  system: { id: "foundry-ironsworn" },
  user: { id: "u1", isGM: true },
  users: { activeGM: { id: "u1" } },
  settings: { get: (scope, key) => _rulesetFlags[key] }
};
globalThis.canvas = { tokens: { controlled: [] } };

let _id = 0;
class MockItem {
  constructor(data) {
    this.id = data._id ?? `item${++_id}`;
    this.name = data.name;
    this.type = data.type ?? "progress";
    this.system = data.system ?? {};
    this.flags = data.flags ?? {};
    this.updates = [];
  }
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; }
  async setFlag(scope, key, val) {
    this.flags[scope] = this.flags[scope] ?? {};
    this.flags[scope][key] = val;
    return this;
  }
  async unsetFlag(scope, key) { if (this.flags?.[scope]) delete this.flags[scope][key]; return this; }
  async update(data) { this.updates.push(data); for (const [k, v] of Object.entries(data)) setProperty(this, k, v); return this; }
}
class MockCollection extends Array {
  get(id) { return this.find(i => i.id === id) ?? null; }
}
class MockActor {
  constructor(data = {}) {
    this.id = data.id ?? `actor${++_id}`;
    this.name = data.name ?? "Sigrún";
    this.type = data.type ?? "character";
    this.system = data.system ?? {};
    this.items = new MockCollection();
    for (const it of (data.items ?? [])) this.items.push(new MockItem(it));
    this.updates = [];
  }
  async update(data) { this.updates.push(data); for (const [k, v] of Object.entries(data)) setProperty(this, k, v); return this; }
}

/* ===================================================================== */
const { default: Ctrl } = await import("../scripts/ironsworn-controller.js");
const { default: Data } = await import("../scripts/ironsworn-data.js");

console.log("[1] xpForRank maps ranks to the canonical XP scale");
{
  eq(Ctrl.xpForRank("troublesome"), 1, "troublesome → 1");
  eq(Ctrl.xpForRank("dangerous"), 2, "dangerous → 2");
  eq(Ctrl.xpForRank("formidable"), 3, "formidable → 3");
  eq(Ctrl.xpForRank("extreme"), 4, "extreme → 4");
  eq(Ctrl.xpForRank("epic"), 5, "epic → 5");
  eq(Ctrl.xpForRank("EPIC"), 5, "case-insensitive");
  eq(Ctrl.xpForRank(3), 3, "numeric ChallengeRank 3 → 3");
  eq(Ctrl.xpForRank("bogus"), 0, "unknown rank → 0");
  // Data module mirror agrees.
  eq(Data.xpForRank("dangerous"), 2, "IronswornData.xpForRank agrees");
  eq(Data.rankXp.epic, 5, "IronswornData.rankXp table present");
}

console.log("[2] xpForRank weak-hit halves (rounded up)");
{
  eq(Ctrl.xpForRank("troublesome", { weakHit: true }), 1, "troublesome weak → 1 (ceil(0.5))");
  eq(Ctrl.xpForRank("dangerous", { weakHit: true }), 1, "dangerous weak → 1 (ceil(1))");
  eq(Ctrl.xpForRank("formidable", { weakHit: true }), 2, "formidable weak → 2 (ceil(1.5))");
  eq(Ctrl.xpForRank("extreme", { weakHit: true }), 2, "extreme weak → 2");
  eq(Ctrl.xpForRank("epic", { weakHit: true }), 3, "epic weak → 3 (ceil(2.5))");
}

console.log("[3] getRuleset detects classic vs starforged from world flags");
{
  _rulesetFlags = { "ruleset-classic": true };
  eq(Ctrl.getRuleset(), "classic", "classic flag → classic");
  _rulesetFlags = { "ruleset-delve": true };
  eq(Ctrl.getRuleset(), "classic", "delve flag → classic model");
  _rulesetFlags = { "ruleset-starforged": true };
  eq(Ctrl.getRuleset(), "starforged", "starforged flag → starforged");
  ok(Ctrl.isStarforgedRuleset(), "isStarforgedRuleset true under SF");
  _rulesetFlags = { "ruleset-sundered_isles": true };
  eq(Ctrl.getRuleset(), "starforged", "sundered isles → starforged");
  _rulesetFlags = { "ruleset-classic": true, "ruleset-starforged": true };
  eq(Ctrl.getRuleset(), "classic", "classic takes priority when both on");
  _rulesetFlags = {};
  eq(Ctrl.getRuleset(), "classic", "nothing set → classic default");
}

console.log("[4] grantXp (classic) increments system.xp and posts a whisper");
{
  _rulesetFlags = { "ruleset-classic": true };
  _chat.length = 0;
  const actor = new MockActor({ system: { xp: 4 } });
  const res = await Ctrl.grantXp(actor, 3, { reason: "test" });
  ok(res.ok, "ok");
  eq(res.mode, "classic", "classic mode");
  eq(res.amount, 3, "amount 3");
  eq(res.total, 7, "new total 7");
  eq(getProperty(actor, "system.xp"), 7, "system.xp written to 7");
  eq(actor.updates.length, 1, "exactly one actor.update call");
  eq(_chat.length, 1, "one GM whisper posted");
}

console.log("[5] grantXp (classic) seeds from 0 and never goes negative");
{
  _rulesetFlags = { "ruleset-classic": true };
  const actor = new MockActor({ system: {} });
  const res = await Ctrl.grantXp(actor, 2);
  eq(res.total, 2, "absent xp treated as 0 → 2");
  // invalid amounts rejected
  eq((await Ctrl.grantXp(actor, 0)).ok, false, "0 rejected");
  eq((await Ctrl.grantXp(actor, -5)).ok, false, "negative rejected");
  eq((await Ctrl.grantXp(actor, "x")).ok, false, "non-numeric rejected");
  eq((await Ctrl.grantXp(null, 2)).ok, false, "null actor rejected");
}

console.log("[6] grantXp (starforged) marks legacy ticks (4 ticks = 1 XP)");
{
  _rulesetFlags = { "ruleset-starforged": true };
  const actor = new MockActor({ system: { legacies: { quests: 8 } } });
  const res = await Ctrl.grantXp(actor, 2, { reason: "quest done" });
  ok(res.ok, "ok");
  eq(res.mode, "starforged", "starforged mode");
  eq(res.legacyKey, "quests", "defaults to quests legacy");
  eq(res.ticks, 8, "2 XP → 8 ticks");
  eq(getProperty(actor, "system.legacies.quests"), 16, "quests 8 → 16");
}

console.log("[7] grantXp (starforged) honours legacyKey and degrades when absent");
{
  _rulesetFlags = { "ruleset-starforged": true };
  const actor = new MockActor({ system: { legacies: { bonds: 0 } } });
  const res = await Ctrl.grantXp(actor, 1, { legacyKey: "bonds" });
  eq(getProperty(actor, "system.legacies.bonds"), 4, "bonds 0 → 4 ticks");
  // No legacies object at all → falls back to classic system.xp.
  const plain = new MockActor({ system: {} });
  const res2 = await Ctrl.grantXp(plain, 2);
  eq(res2.mode, "classic", "no legacy field → classic fallback");
  eq(getProperty(plain, "system.xp"), 2, "classic counter written on fallback");
}

console.log("[8] grantXp respects an explicit mode override");
{
  _rulesetFlags = { "ruleset-starforged": true };
  const actor = new MockActor({ system: { xp: 1, legacies: { quests: 0 } } });
  const res = await Ctrl.grantXp(actor, 2, { mode: "classic" });
  eq(res.mode, "classic", "forced classic even under SF world");
  eq(getProperty(actor, "system.xp"), 3, "system.xp used");
  eq(getProperty(actor, "system.legacies.quests"), 0, "legacy untouched");
}

console.log("[9] grantVowXp awards rank XP exactly ONCE (idempotency flag)");
{
  _rulesetFlags = { "ruleset-classic": true };
  const actor = new MockActor({
    system: { xp: 0 },
    items: [{ name: "Avenge the Burning", type: "progress", system: { subtype: "vow", rank: 3, completed: true } }]
  });
  const vow = actor.items[0];
  const first = await Ctrl.grantVowXp(actor, vow, {});
  ok(first.ok, "first award ok");
  eq(first.xp, 3, "formidable vow → 3 XP");
  eq(getProperty(actor, "system.xp"), 3, "system.xp now 3");
  ok(vow.getFlag("the-eternal-skald", "xpAwarded") === true, "xpAwarded flag set");
  // Second call must be a no-op.
  const second = await Ctrl.grantVowXp(actor, vow, {});
  eq(second.skipped, "already-awarded", "second call skipped");
  eq(getProperty(actor, "system.xp"), 3, "xp unchanged on second call");
}

console.log("[10] grantVowXp weak-hit half only when the rule is enabled");
{
  _rulesetFlags = { "ruleset-classic": true };
  // Rule OFF → full XP regardless of outcome.
  const a1 = new MockActor({ system: { xp: 0 }, items: [{ name: "V", type: "progress", system: { subtype: "vow", rank: 5, completed: true } }] });
  await Ctrl.grantVowXp(a1, a1.items[0], { outcome: "weak", weakHitHalf: false });
  eq(getProperty(a1, "system.xp"), 5, "epic full = 5 when rule off");
  // Rule ON + weak → half (ceil(2.5)=3).
  const a2 = new MockActor({ system: { xp: 0 }, items: [{ name: "V", type: "progress", system: { subtype: "vow", rank: 5, completed: true } }] });
  await Ctrl.grantVowXp(a2, a2.items[0], { outcome: "weak", weakHitHalf: true });
  eq(getProperty(a2, "system.xp"), 3, "epic weak half = 3 when rule on");
  // Rule ON + strong → full.
  const a3 = new MockActor({ system: { xp: 0 }, items: [{ name: "V", type: "progress", system: { subtype: "vow", rank: 5, completed: true } }] });
  await Ctrl.grantVowXp(a3, a3.items[0], { outcome: "strong", weakHitHalf: true });
  eq(getProperty(a3, "system.xp"), 5, "epic strong full = 5 even with rule on");
}

console.log("[11] resolveVowForXp finds the relevant (incl. completed) vow");
{
  const actor = new MockActor({
    items: [
      { name: "Old Vow", type: "progress", system: { subtype: "vow", rank: 1, completed: true }, flags: { "the-eternal-skald": { xpAwarded: true } } },
      { name: "Fresh Vow", type: "progress", system: { subtype: "vow", rank: 2, completed: true } },
      { name: "A Journey", type: "progress", system: { subtype: "journey", rank: 3 } }
    ]
  });
  const vow = Ctrl.resolveVowForXp(actor);
  ok(vow, "a vow resolved");
  eq(vow.name, "Fresh Vow", "prefers the unawarded vow over the already-awarded one");
  // No vows at all → null.
  const none = new MockActor({ items: [{ name: "J", type: "progress", system: { subtype: "journey" } }] });
  eq(Ctrl.resolveVowForXp(none), null, "no vow → null");
}

console.log("[12] grantVowXp skips zero-XP (unknown rank) without setting flag");
{
  _rulesetFlags = { "ruleset-classic": true };
  const actor = new MockActor({ system: { xp: 0 }, items: [{ name: "V", type: "progress", system: { subtype: "vow", completed: true } }] });
  const res = await Ctrl.grantVowXp(actor, actor.items[0], {});
  eq(res.skipped, "zero-xp", "unknown rank → skipped");
  eq(getProperty(actor, "system.xp"), 0, "no XP written");
  ok(!actor.items[0].getFlag("the-eternal-skald", "xpAwarded"), "flag NOT set on zero-XP skip");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
