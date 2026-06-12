/* =====================================================================
 *  Roll#evaluate API-compatibility regression guards.
 *
 *  Foundry VTT v12 removed the `async` option from Roll#evaluate; the
 *  call is now always asynchronous (await roll.evaluate()). The module
 *  targets compatibility minimum 13 / verified 14, so the deprecated
 *  `{ async: true }` form must never reappear. This guard locks in the
 *  fix in CombatController._executeAction (scripts/eternal-skald.js) and
 *  protects the wider source tree from regressing to the old signature.
 *
 *  Source-text-guard style (see version-consistency.test.mjs).
 *
 *  Run: node test/roll-evaluate-api.test.mjs
 * ===================================================================== */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SCRIPTS = join(ROOT, "scripts");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  \u2717 FAIL:", msg); } }

console.log("Roll#evaluate API-compatibility test\n");

/** Recursively collect every *.js / *.mjs file under scripts/. */
function collect(dir, acc) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch (_) { continue; }
    if (st.isDirectory()) collect(p, acc);
    else if (name.endsWith(".js") || name.endsWith(".mjs")) acc.push(p);
  }
  return acc;
}

const files = collect(SCRIPTS, []);

/* --------------------------------------------------------------------- *
 * [1] The deprecated `evaluate({ async: ... })` signature must not exist
 *     anywhere in the shipped script tree.
 * --------------------------------------------------------------------- */
const deprecated = /\.evaluate\s*\(\s*\{\s*async\s*:/;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  ok(!deprecated.test(src),
     `[1] no deprecated Roll#evaluate({ async: ... }) in ${f.replace(ROOT + "/", "")}`);
}

/* --------------------------------------------------------------------- *
 * [2] The combat roll in eternal-skald.js evaluates with the modern,
 *     argument-free awaited form.
 * --------------------------------------------------------------------- */
{
  const main = readFileSync(join(SCRIPTS, "eternal-skald.js"), "utf8");
  ok(/await\s+roll\.evaluate\(\s*\)/.test(main),
     "[2] action roll uses `await roll.evaluate()` (no async option)");
  ok(/await\s+chal\.evaluate\(\s*\)/.test(main),
     "[2] challenge roll uses `await chal.evaluate()` (no async option)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
