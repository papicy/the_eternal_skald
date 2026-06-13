/* =====================================================================
 *  Adapter integration-spine test for The Eternal Skald.
 *
 *  Phase 3 of the multi-system plugin architecture
 *  (see docs/PROPOSAL-multi-system-adapter-architecture.md).
 *
 *  Guards the migration of the orchestration SPINE (scripts/narrative/
 *  integration.js) off its hard `IronswornController` import and onto the
 *  system-adapter registry via a module-local `sys()` helper.
 *
 *  The migration is purely mechanical: every `IronswornController.<m>` call
 *  became `sys().<m>`, where `sys = () => getActiveAdapter()`. Because the
 *  registry resolves by `game.system.id` — exactly the predicate
 *  `IronswornController.isActive()` already used — a `foundry-ironsworn` world
 *  resolves to the very same controller object (identical behaviour for ANY
 *  Ironsworn settings configuration), while any other / no system resolves to
 *  the safe NullAdapter.
 *
 *  Two layers of assertion:
 *    [SRC] Source-text guards pinning the migration shape (no direct controller
 *          import; registry import + `sys()` helper present; `active()` gate and
 *          `applyEffects` dispatch route through `sys()`).
 *    [A]   BEHAVIOUR — with an Ironsworn-like adapter registered for the active
 *          system, `Integration.active()` is true and `applyEffects` routes a
 *          momentum directive to that adapter (proving the spine consumes the
 *          registry, not a hard-wired singleton).
 *    [B]   BEHAVIOUR — with NO adapter for the active system, `getActiveAdapter()`
 *          yields the NullAdapter, `Integration.active()` is false, and the
 *          system-specific entry points (`applyEffects`, `applyNarrativeTrack-
 *          Effects`) degrade gracefully: they return empty and DO NOT throw.
 *
 *  Run: node test/adapter-integration-spine.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTEGRATION = join(__dirname, "..", "scripts", "narrative", "integration.js");
const SRC = readFileSync(INTEGRATION, "utf8");

/* ===================================================================== *
 *  [SRC] Source-text guards — pin the migration shape
 * ===================================================================== */
console.log("[SRC] integration.js migrated to the adapter registry");

ok(!/^import\s*\{\s*IronswornController\s*\}/m.test(SRC),
   "no direct `import { IronswornController }` remains");
ok(/import\s*\{\s*getActiveAdapter\s*\}\s*from\s*"\.\.\/systems\/registry\.js"/.test(SRC),
   "registry import present");
ok(/const\s+sys\s*=\s*\(\)\s*=>\s*getActiveAdapter\(\)\s*;/.test(SRC),
   "module-local `sys()` helper present");
ok(/if \(!sys\(\)\.isActive\(\)\) return false;/.test(SRC),
   "master active() gate routes through sys().isActive()");
ok(/sys\(\)\.adjustMomentum\(/.test(SRC) && /sys\(\)\.grantXp\(/.test(SRC),
   "applyEffects dispatch routes momentum/xp through sys()");
ok(!/[^/]\bIronswornController\.\w/.test(SRC.replace(/^\s*(\*|\/\/).*$/gm, "")),
   "no executable IronswornController.<member> call remains (comments excepted)");

/* ---- Import-time Foundry/browser stubs (mirrors test/load-smoke.mjs). ----
 *      Any access yields a self-returning callable proxy, so the heavy
 *      eternal-skald.js graph (cross-imported by integration.js) LOADS without
 *      throwing. We swap in a controlled `game` AFTER import for behaviour. */
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
const { NullAdapter } = await import("../scripts/systems/null-adapter.js");
const { Integration } = await import("../scripts/narrative/integration.js");

/* ---- A controllable `game` we install at CALL time. Modules read the free
 *      global `game` dynamically, so reassigning globalThis.game changes what
 *      Settings.get()/registry resolution see. ---- */
function installGame(systemId, settings = {}) {
  const defaults = { ironswornIntegration: true, showEffectAnnouncements: false };
  const map = { ...defaults, ...settings };
  globalThis.game = {
    system: { id: systemId },
    user: { id: "u1", isGM: true },
    actors: [], packs: [],
    settings: { get(_mod, key) { return map[key]; } },
    i18n: { localize: (s) => s }
  };
  globalThis.foundry = { utils: {
    getProperty: (o, p) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o)
  } };
}

/* ===================================================================== *
 *  [A] Ironsworn-like adapter registered → spine consumes the registry
 * ===================================================================== */
console.log("[A] Ironsworn-like adapter registered → active() true & effects route through the adapter");

const momentumCalls = [];
const fakeIronsworn = {
  id: "foundry-ironsworn",
  label: "Test Ironsworn-like",
  isActive() { return true; },
  capabilities() { return {}; },
  getCombatTracks() { return []; },
  async adjustMomentum(actor, value) { momentumCalls.push([actor, value]); return { ok: true }; },
  // present so the spine's other guarded paths never trip on this adapter:
  getActiveCharacter() { return null; }
};

installGame("foundry-ironsworn");
eq(registerSystem("foundry-ironsworn", fakeIronsworn), true, "registerSystem accepts the Ironsworn-like adapter");
ok(getActiveAdapter() === fakeIronsworn, "getActiveAdapter() resolves to the registered adapter for the active system");
eq(Integration.active(), true, "Integration.active() is true when the adapter reports active + integration enabled");

const fakeActor = { id: "actor-1", name: "Sigrún" };
const appliedA = await Integration.applyEffects([{ kind: "momentum", op: "adjust", value: 2 }], fakeActor);
eq(momentumCalls.length, 1, "applyEffects routed the momentum directive through the adapter exactly once");
ok(momentumCalls[0][0] === fakeActor && momentumCalls[0][1] === 2,
   "adapter.adjustMomentum received the correct (actor, value)");
ok(Array.isArray(appliedA) && appliedA.some(s => /momentum \+2/.test(s)),
   "applyEffects reports the applied momentum change");

/* ===================================================================== *
 *  [B] No adapter for the active system → NullAdapter → graceful no-op
 * ===================================================================== */
console.log("[B] No adapter registered → NullAdapter → spine gates off and degrades without throwing");

installGame("some-unsupported-system");   // nothing registered under this id
ok(getActiveAdapter() === NullAdapter, "getActiveAdapter() falls back to NullAdapter for an unsupported system");
eq(Integration.active(), false, "Integration.active() is false under the NullAdapter");

// Under a non-Ironsworn system the live character resolves to null (NullAdapter),
// so the spine's entry points run with actor=null and must no-op without throwing.
let threw = false, appliedB = null;
try {
  appliedB = await Integration.applyEffects([{ kind: "momentum", op: "adjust", value: 2 }], null);
} catch (_) { threw = true; }
eq(threw, false, "applyEffects does NOT throw under the NullAdapter");
ok(Array.isArray(appliedB) && appliedB.length === 0, "applyEffects applies nothing under the NullAdapter");

let threw2 = false, trackRes = null;
try {
  trackRes = await Integration.applyNarrativeTrackEffects(
    "Some narration [[ADD_PROGRESS: vow Avenge the village]] more prose.", null);
} catch (_) { threw2 = true; }
eq(threw2, false, "applyNarrativeTrackEffects does NOT throw under the NullAdapter");
ok(Array.isArray(trackRes) && trackRes.length === 0, "applyNarrativeTrackEffects applies nothing under the NullAdapter");

/* ===================================================================== */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
