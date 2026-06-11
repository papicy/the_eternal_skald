/* =====================================================================
 *  Load-smoke harness (Phase 2 refactor safety net).
 *
 *  Dynamically imports the full module graph (scripts/eternal-skald.js and,
 *  transitively, every extracted submodule) under permissively-stubbed Foundry
 *  / browser globals. This verifies the ESM graph LOADS without throwing —
 *  catching bad import paths, missing/mis-named exports, and circular-import
 *  TDZ errors that the text-based regression tests cannot see (they never
 *  import the runtime module).
 *
 *  It is NOT a behavioral test: callbacks (hooks, onChange) are registered but
 *  never invoked, so stubs only need to exist, not behave.
 *
 *  Run: node test/load-smoke.mjs   (exit 0 = graph loaded, 1 = load error)
 * ===================================================================== */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// A self-returning, callable, indexable proxy: any property access yields
// another stub, any call returns a stub. Safe for chained top-level usage like
// Hooks.on(...), game.settings.register(...), CONFIG.x.y = z, etc.
function makeStub() {
  const fn = function () { return makeStub(); };
  return new Proxy(fn, {
    get(_t, p) {
      if (p === Symbol.toPrimitive || p === Symbol.iterator) return undefined;
      if (p === "then") return undefined;            // never a thenable
      return makeStub();
    },
    set() { return true; },
    apply() { return makeStub(); },
    construct() { return makeStub(); },
  });
}

for (const name of [
  "Hooks", "game", "ui", "canvas", "CONFIG", "CONST", "foundry",
  "Roll", "ChatMessage", "Actor", "Item", "Scene", "JournalEntry",
  "Dialog", "DialogV2", "FormApplication", "Application",
  "loadTemplates", "renderTemplate", "fromUuid", "fromUuidSync",
  "getDocumentClass", "Handlebars", "TextEditor", "duplicate", "mergeObject",
  "$", "jQuery",
]) {
  if (globalThis[name] === undefined) globalThis[name] = makeStub();
}
// document / window exist in browsers; stub minimally for module load.
if (globalThis.document === undefined) globalThis.document = makeStub();
if (globalThis.window === undefined)   globalThis.window   = globalThis;

const ENTRY = join(__dirname, "..", "scripts", "eternal-skald.js");
try {
  const mod = await import(ENTRY);
  // Touch the namespace so any lazily-thrown getter surfaces.
  void Object.keys(mod);
  console.log("✓ load-smoke: module graph imported cleanly");
  process.exit(0);
} catch (err) {
  console.error("✗ load-smoke: module graph failed to import");
  console.error("   ", err && err.stack ? err.stack.split("\n").slice(0, 6).join("\n    ") : err);
  process.exit(1);
}
