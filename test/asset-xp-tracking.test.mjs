/* =====================================================================
 *  Asset & XP tracking test for The Eternal Skald (v0.10.25).
 *
 *  Exercises the READ-ONLY controller surface added for asset and
 *  experience tracking:
 *    • getAssets(actor)       — summarise owned ASSET Items.
 *    • getExperience(actor)   — unified classic-xp + Starforged legacies.
 *    • describeCharacter()    — surfaces Assets / Experience / Legacies.
 *
 *  Also reproduces the in-memory XP diff-watcher delta logic used by the
 *  updateActor hook in eternal-skald.js (kept as a local replica so the
 *  test stays free of Foundry's hook machinery), proving that only
 *  POSITIVE deltas are reported and the first sighting seeds silently.
 *
 *  Run: node test/asset-xp-tracking.test.mjs
 * ===================================================================== */

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

/* ---- Minimal Foundry globals ---- */
function getProperty(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
globalThis.foundry = { utils: { getProperty } };
globalThis.ui = { notifications: { info: () => {}, warn: () => {}, error: () => {} } };
// isActive() requires the active system id to be foundry-ironsworn.
globalThis.game = { system: { id: "foundry-ironsworn" }, user: { id: "u1" }, actors: [] };
globalThis.canvas = { tokens: { controlled: [] } };

let _id = 0;
class MockItem {
  constructor(data) {
    this.id = data._id ?? `item${++_id}`;
    this.name = data.name;
    this.type = data.type;
    this.system = data.system ?? {};
  }
}
class MockCollection extends Array { get(id) { return this.find(i => i.id === id) ?? null; } }
class MockActor {
  constructor(data = {}) {
    this.name = data.name ?? "Sigrún";
    this.type = data.type ?? "character";
    this.system = data.system ?? {};
    this.items = new MockCollection();
    for (const it of (data.items ?? [])) this.items.push(new MockItem(it));
  }
}

/* ===================================================================== */
const { default: Ctrl } = await import("../scripts/ironsworn-controller.js");

console.log("[1] getAssets summarises asset Items (abilities, category, track)");
{
  const actor = new MockActor({
    items: [
      { name: "Sword-sister", type: "asset", system: {
        category: "Companion",
        abilities: [
          { name: "a1", enabled: true },
          { name: "a2", enabled: true },
          { name: "a3", enabled: false }
        ],
        track: { enabled: true, name: "health", value: 3, max: 5 }
      } },
      { name: "Ritualist", type: "asset", system: {
        category: "Path",
        abilities: [{ name: "p1", enabled: true }, { name: "p2", enabled: false }]
      } }
    ]
  });
  const assets = Ctrl.getAssets(actor);
  eq(assets.length, 2, "two assets returned");
  eq(assets[0].name, "Sword-sister", "first asset name");
  eq(assets[0].category, "Companion", "category read");
  eq(assets[0].unlocked, 2, "2 of 3 abilities enabled");
  eq(assets[0].total, 3, "3 abilities total");
  ok(assets[0].track && assets[0].track.value === 3 && assets[0].track.max === 5, "track surfaced");
  eq(assets[1].track, null, "asset without enabled track → null track");
  eq(assets[1].unlocked, 1, "1 of 2 abilities enabled on second asset");
}

console.log("[2] getAssets ignores non-asset Items and handles missing fields");
{
  const actor = new MockActor({
    items: [
      { name: "A Vow", type: "progress", system: { subtype: "vow", rank: 3 } },
      { name: "Bare Asset", type: "asset", system: {} }
    ]
  });
  const assets = Ctrl.getAssets(actor);
  eq(assets.length, 1, "only the asset is returned, progress track ignored");
  eq(assets[0].unlocked, 0, "no abilities → 0 unlocked");
  eq(assets[0].total, 0, "no abilities → 0 total");
  eq(assets[0].category, null, "missing category → null");
  eq(assets[0].track, null, "missing track → null");
}

console.log("[3] getAssets respects the limit and degrades safely on bad input");
{
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ name: `Asset ${i}`, type: "asset", system: { abilities: [] } });
  const actor = new MockActor({ items: many });
  eq(Ctrl.getAssets(actor).length, 12, "default limit caps at 12");
  eq(Ctrl.getAssets(actor, { limit: 3 }).length, 3, "explicit limit honoured");
  eq(Ctrl.getAssets(null).length, 0, "null actor → empty array");
  eq(Ctrl.getAssets({}).length, 0, "actor without items → empty array");
}

console.log("[4] getExperience reads the classic Ironsworn xp counter");
{
  const actor = new MockActor({ system: { xp: 7 } });
  const xp = Ctrl.getExperience(actor);
  eq(xp.xp, 7, "classic xp read");
  eq(xp.legacies, null, "no legacies present → null");
}

console.log("[5] getExperience reads Starforged legacy tracks");
{
  const actor = new MockActor({ system: { legacies: {
    quests: 12, questsXpSpent: 4,
    bonds: 8, bondsXpSpent: 0,
    discoveries: 20, discoveriesXpSpent: 10
  } } });
  const xp = Ctrl.getExperience(actor);
  eq(xp.xp, null, "no classic xp → null");
  ok(xp.legacies, "legacies object present");
  eq(xp.legacies.quests, 12, "quests ticks");
  eq(xp.legacies.bondsXpSpent, 0, "bondsXpSpent read");
  eq(xp.legacies.discoveries, 20, "discoveries ticks");
}

console.log("[6] getExperience returns nulls when both models absent / actor null");
{
  eq(Ctrl.getExperience(new MockActor({ system: {} })).xp, null, "absent xp → null");
  eq(Ctrl.getExperience(new MockActor({ system: {} })).legacies, null, "absent legacies → null");
  const none = Ctrl.getExperience(null);
  eq(none.xp, null, "null actor → xp null");
  eq(none.legacies, null, "null actor → legacies null");
}

console.log("[7] describeCharacter surfaces Assets / Experience / Legacies lines");
{
  const actor = new MockActor({
    name: "Sigrún",
    system: {
      xp: 5,
      legacies: { quests: 6, questsXpSpent: 0, bonds: 2, bondsXpSpent: 0, discoveries: 0, discoveriesXpSpent: 0 }
    },
    items: [
      { name: "Sword-sister", type: "asset", system: {
        category: "Companion",
        abilities: [{ name: "a1", enabled: true }, { name: "a2", enabled: false }],
        track: { enabled: true, name: "health", value: 4, max: 5 }
      } }
    ]
  });
  const desc = Ctrl.describeCharacter(actor);
  ok(/Assets:/.test(desc), "contains an Assets header");
  ok(/Sword-sister \(Companion\)/.test(desc), "names asset with category");
  ok(/1\/2 abilities/.test(desc), "shows unlock progress");
  ok(/health 4\/5/.test(desc), "shows asset track");
  ok(/Experience: 5 XP earned/.test(desc), "shows classic experience line");
  ok(/Legacies \(ticks\): Quests 6, Bonds 2, Discoveries 0/.test(desc), "shows legacies line");
}

console.log("[8] describeCharacter omits asset/xp lines when absent");
{
  const actor = new MockActor({ name: "Plain", system: {} });
  const desc = Ctrl.describeCharacter(actor);
  ok(!/Assets:/.test(desc), "no Assets header when none owned");
  ok(!/Experience:/.test(desc), "no Experience line when absent");
  ok(!/Legacies/.test(desc), "no Legacies line when absent");
}

/* ---------------------------------------------------------------------
 *  XP diff-watcher delta logic — local replica of the updateActor hook in
 *  eternal-skald.js. Proves first-sighting seeds silently and only
 *  positive deltas (xp + legacy ticks) are reported.
 * ------------------------------------------------------------------- */
function computeXpInfo(prev, current) {
  if (!prev) return null; // first sighting seeds silently
  const info = { legacyDeltas: [] };
  if (typeof current.xp === "number" && typeof prev.xp === "number" && current.xp > prev.xp) {
    info.xpDelta = current.xp - prev.xp;
    info.newXp = current.xp;
  }
  if (current.legacies && prev.legacies) {
    for (const key of ["quests", "bonds", "discoveries"]) {
      const now = current.legacies[key], was = prev.legacies[key];
      if (typeof now === "number" && typeof was === "number" && now > was) {
        info.legacyDeltas.push({ name: key, delta: now - was });
      }
    }
  }
  const hasGain = (typeof info.xpDelta === "number" && info.xpDelta > 0) || info.legacyDeltas.length > 0;
  return hasGain ? info : null;
}

console.log("[9] XP watcher seeds silently on first sighting");
{
  const current = Ctrl.getExperience(new MockActor({ system: { xp: 3 } }));
  eq(computeXpInfo(undefined, current), null, "no narration on first sighting");
}

console.log("[10] XP watcher reports a positive xp delta only");
{
  const prev = { xp: 3, legacies: null };
  const gain = computeXpInfo(prev, { xp: 6, legacies: null });
  ok(gain && gain.xpDelta === 3, "delta of +3 reported");
  eq(gain.newXp, 6, "new total carried");
  eq(computeXpInfo({ xp: 6, legacies: null }, { xp: 6, legacies: null }), null, "no change → no narration");
  eq(computeXpInfo({ xp: 9, legacies: null }, { xp: 6, legacies: null }), null, "negative change ignored");
}

console.log("[11] XP watcher reports positive legacy-track advances");
{
  const prev = { xp: null, legacies: { quests: 4, bonds: 2, discoveries: 0 } };
  const cur  = { xp: null, legacies: { quests: 7, bonds: 2, discoveries: 1 } };
  const gain = computeXpInfo(prev, cur);
  ok(gain, "advance detected");
  eq(gain.legacyDeltas.length, 2, "two legacies advanced (quests + discoveries)");
  const quests = gain.legacyDeltas.find(d => d.name === "quests");
  eq(quests.delta, 3, "quests advanced by +3");
  const disc = gain.legacyDeltas.find(d => d.name === "discoveries");
  eq(disc.delta, 1, "discoveries advanced by +1");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
