/* =====================================================================
 *  Combat-closure + completion-filter RUNTIME guard.
 *
 *  Exercises the REAL Integration object from scripts/narrative/integration.js
 *  (NOT a copy of the logic) under stubbed Foundry globals, mirroring the
 *  harness in test/adapter-integration-spine.test.mjs. It locks in three fixes:
 *
 *    FIX 1 — A narrated end of a fight reliably CLOSES the combat track.
 *      Bug: Integration.applyEffects' `end_combat` case only tried a specific
 *      foe (fuzzy name → active-combat → literal name). When NONE resolved, a
 *      narrated ending (e.g. "End the Fight — Weak Hit") left the foe track OPEN
 *      on the sheet. Fix: fall back to closeStaleCombatTracks() so the fight
 *      always closes. We assert the open track ends up completed AND the robust
 *      sweeper was actually invoked only when the specific close failed.
 *
 *    FIX 2 — _filterRedundantCombatEffects no longer drops a genuine end_combat
 *      just because SOME other track auto-completed in the same turn. The drop
 *      is now SCOPED to the kind the rolled move resolved: end_combat is dropped
 *      only when the rolled move was the COMBAT completion ("End the Fight").
 *      A vow/journey completion that also says "auto-completed" must NOT swallow
 *      a real end_combat the AI emitted for a separately-concluded fight.
 *
 *  Run: node test/combat-close-journey.test.mjs
 * ===================================================================== */

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

/* ---- Import-time Foundry/browser stubs (mirrors load-smoke / spine test). --
 *      Any access yields a self-returning callable proxy, so the heavy
 *      eternal-skald.js graph (cross-imported by integration.js) LOADS without
 *      throwing. We install a controlled `game` AFTER import for behaviour. */
function makeStub() {
  const fn = function () { return makeStub(); };
  return new Proxy(fn, {
    get(_t, p) {
      if (p === Symbol.toPrimitive || p === Symbol.iterator) return undefined;
      if (p === "then") return undefined;
      return makeStub();
    },
    set() { return true; }, apply() { return makeStub(); }, construct() { return makeStub(); }
  });
}
for (const name of [
  "Hooks", "game", "ui", "canvas", "CONFIG", "CONST", "foundry",
  "Roll", "ChatMessage", "Actor", "Item", "Scene", "JournalEntry",
  "Dialog", "DialogV2", "FormApplication", "Application",
  "loadTemplates", "renderTemplate", "fromUuid", "fromUuidSync",
  "getDocumentClass", "Handlebars", "TextEditor", "duplicate", "mergeObject",
  "$", "jQuery"
]) {
  if (globalThis[name] === undefined) globalThis[name] = makeStub();
}
if (globalThis.document === undefined) globalThis.document = makeStub();
if (globalThis.window === undefined)   globalThis.window   = globalThis;

const { registerSystem, getActiveAdapter } = await import("../scripts/systems/registry.js");
const { Integration } = await import("../scripts/narrative/integration.js");

/* ---- A controllable `game` installed at CALL time (modules read it free). -- */
function installGame(settings = {}) {
  const defaults = {
    ironswornIntegration: true,
    showEffectAnnouncements: false,   // suppress the trailing Chat.postSystem
    debugLogging: false
  };
  const map = { ...defaults, ...settings };
  globalThis.game = {
    system: { id: "foundry-ironsworn" },
    user: { id: "u1", isGM: true },
    actors: [], packs: [],
    settings: { get(_mod, key) { return map[key]; } },
    i18n: { localize: (s) => s }
  };
  globalThis.foundry = { utils: {
    getProperty: (o, p) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o)
  } };
}

/* ---- A minimal Ironsworn-like adapter whose combat methods operate on a
 *      tiny in-memory foe list. We can dial each method's resolution to drive
 *      the exact code path (specific close succeeds vs. forces the fallback). */
function makeAdapter(foes, opts = {}) {
  const calls = { closeStale: 0, completeTrack: [], clearActive: 0 };
  const open = () => foes.filter(f => !f.completed);
  const adapter = {
    id: "foundry-ironsworn",
    label: "Test Ironsworn-like",
    isActive() { return true; },
    capabilities() { return {}; },
    getCombatTracks() { return foes.map(f => ({ ...f })); },
    findTrackFuzzy(_actor, name, _kind) {
      if (opts.fuzzyResolves === false) return null;
      const f = open().find(t => name && t.name.toLowerCase().includes(String(name).toLowerCase()));
      return f ? { id: f.id, name: f.name } : null;
    },
    getActiveCombat() {
      if (opts.activeResolves === false) return null;
      const f = open()[0];
      return f ? { id: f.id, name: f.name } : null;
    },
    async completeTrack(_actor, idOrName) {
      calls.completeTrack.push(idOrName);
      const f = foes.find(t => t.id === idOrName);   // resolve by id only
      if (!f) return { ok: false, error: `no track "${idOrName}"` };
      f.completed = true;
      return { ok: true, name: f.name };
    },
    async closeStaleCombatTracks(_actor, _o = {}) {
      calls.closeStale++;
      const closed = open().map(f => { f.completed = true; return f.name; });
      return { ok: true, closed };
    },
    async clearActiveCombat() { calls.clearActive++; return { ok: true }; }
  };
  return { adapter, calls };
}

const ACTOR = { id: "actor-1", name: "Sigrún" };

/* ===================================================================== *
 *  FIX 1 — end_combat reliably closes the fight
 * ===================================================================== */
console.log("[1] end_combat: specific close FAILS → closeStaleCombatTracks fallback closes the fight");
{
  installGame();
  // AI ended the fight but emitted no usable foe name; the active-combat flag
  // has drifted (both resolvers miss) and a literal-name complete fails.
  const foes = [{ id: "c1", name: "Warrior", completed: false }];
  const { adapter, calls } = makeAdapter(foes, { fuzzyResolves: false, activeResolves: false });
  registerSystem("foundry-ironsworn", adapter);
  ok(getActiveAdapter() === adapter, "adapter registered for the active system");

  const applied = await Integration.applyEffects([{ kind: "end_combat", name: "" }], ACTOR);
  eq(foes[0].completed, true, "the open 'Warrior' combat track is now CLOSED (no lingering fight)");
  ok(calls.closeStale === 1, "the robust sweeper ran exactly once (fallback engaged)");
  ok(applied.some(s => /ended combat/.test(s)), "applyEffects reports the fight ended");
  ok(calls.clearActive >= 1, "active-combat flag cleared after the close");
}

console.log("[2] end_combat: specific foe RESOLVES → direct close, fallback NOT used");
{
  installGame();
  const foes = [{ id: "c1", name: "Warrior", completed: false }];
  const { adapter, calls } = makeAdapter(foes, { fuzzyResolves: true });
  registerSystem("foundry-ironsworn", adapter);

  const applied = await Integration.applyEffects([{ kind: "end_combat", name: "the Warrior" }], ACTOR);
  eq(foes[0].completed, true, "named foe closed directly");
  eq(calls.closeStale, 0, "sweeper NOT invoked when the specific close succeeds (no over-reach)");
  ok(applied.some(s => /ended combat/.test(s)), "applyEffects reports the fight ended");
}

/* ===================================================================== *
 *  FIX 2 — _filterRedundantCombatEffects scopes the drop to the rolled kind
 * ===================================================================== */
console.log("[3] filter: 'End the Fight' weak hit auto-completes combat → end_combat IS dropped (redundant)");
{
  installGame();
  const parsed = { moveName: "End the Fight", outcome: "Weak Hit" };
  const autoSummary = "won the fight “Warrior” (weak hit — auto-completed) — at a cost; narrate the complication";
  const out = Integration._filterRedundantCombatEffects(
    [{ kind: "end_combat", name: "Warrior" }, { kind: "momentum", value: -1 }], parsed, autoSummary);
  ok(!out.some(e => e.kind === "end_combat"), "redundant end_combat dropped (combat already auto-closed)");
  ok(out.some(e => e.kind === "momentum"), "unrelated momentum effect preserved");
}

console.log("[4] filter: 'Reach Your Destination' auto-completes a JOURNEY → a real end_combat is KEPT");
{
  installGame();
  // The rolled move finished a JOURNEY; the AI ALSO narrated a separate fight
  // ending in the same reply. The journey's "auto-completed" must NOT swallow
  // the genuine end_combat (the pre-fix substring check wrongly dropped it).
  const parsed = { moveName: "Reach Your Destination", outcome: "Strong Hit" };
  const autoSummary = "reached destination “Greymoor” (strong hit — auto-completed)";
  const out = Integration._filterRedundantCombatEffects(
    [{ kind: "end_combat", name: "Bandit" }], parsed, autoSummary);
  ok(out.some(e => e.kind === "end_combat"),
     "genuine end_combat is PRESERVED when the auto-completed track was a journey, not combat");
}

console.log("[5] filter: 'Fulfill Your Vow' auto-completes a VOW → complete_track dropped, end_combat kept");
{
  installGame();
  const parsed = { moveName: "Fulfill Your Vow", outcome: "Weak Hit" };
  const autoSummary = "fulfilled vow “Avenge the village” (weak hit — auto-completed)";
  const out = Integration._filterRedundantCombatEffects(
    [{ kind: "complete_track", trackKind: "vow", name: "" }, { kind: "end_combat", name: "Wolf" }],
    parsed, autoSummary);
  ok(!out.some(e => e.kind === "complete_track"), "redundant vow complete_track dropped");
  ok(out.some(e => e.kind === "end_combat"), "unrelated end_combat preserved (vow completion ≠ combat)");
}

console.log("[6] filter: MISS on 'End the Fight' (no auto-complete) → end_combat passes through");
{
  installGame();
  const parsed = { moveName: "End the Fight", outcome: "Miss" };
  const autoSummary = "fight “Warrior” NOT finished (miss) — narrate a serious setback; the track stays open";
  const out = Integration._filterRedundantCombatEffects(
    [{ kind: "end_combat", name: "Warrior" }], parsed, autoSummary);
  ok(out.some(e => e.kind === "end_combat"),
     "on a miss nothing auto-completed → end_combat is NOT dropped");
}

/* ===================================================================== */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
