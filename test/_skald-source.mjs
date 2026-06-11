/* =====================================================================
 *  Shared source-corpus reader for the source-text guard tests.
 *
 *  Several regression tests assert on the *text* of the module source
 *  (e.g. "is setting X registered?", "is command Y wired to handler Z?").
 *  The Phase 2 refactor decomposes the original eternal-skald.js monolith
 *  into many small ES-modules under scripts/<subsystem>/*.js. To keep those
 *  text guards valid no matter where a definition is relocated, this helper
 *  concatenates the WHOLE refactored source tree into one string:
 *
 *    • every *.js file inside a SUBDIRECTORY of scripts/ (recursively,
 *      sorted) — i.e. the extracted modules (core/, ai/, chat/, …);
 *    • then scripts/eternal-skald.js LAST.
 *
 *  Root-level sibling modules that the tests never inspected (browser-rag.js,
 *  ironsworn-controller.js, ironsworn-data.js, the server .mjs) are excluded,
 *  so the corpus stays exactly equivalent to "the main module and wherever its
 *  own code now lives" — no foreign text is introduced.
 *
 *  eternal-skald.js is placed LAST because the brace-matching `extractFrom`
 *  helpers locate a marker then scan FORWARD for the matching close; keeping
 *  the large main module at the tail guarantees there is always trailing code
 *  after any relocated block (e.g. `const COMMANDS = Object.freeze({ … })`).
 *
 *  This file is NOT a test (no `.test.mjs` suffix) so the runner ignores it.
 * ===================================================================== */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname    = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR  = join(__dirname, "..", "scripts");
const MAIN         = join(SCRIPTS_DIR, "eternal-skald.js");

/** Recursively collect *.js files inside subdirectories of scripts/ (sorted). */
function collectSubmodules(dir, acc) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch (_) { continue; }
    if (st.isDirectory()) collectSubmodules(p, acc);
    else if (name.endsWith(".js")) acc.push(p);
  }
  return acc;
}

/**
 * Read the full refactored Skald source as a single string: every extracted
 * submodule first (sorted, recursive) then eternal-skald.js last.
 * @returns {string}
 */
export function readSkaldSource() {
  const subFiles = [];
  for (const name of readdirSync(SCRIPTS_DIR).sort()) {
    const p = join(SCRIPTS_DIR, name);
    let st;
    try { st = statSync(p); } catch (_) { continue; }
    if (st.isDirectory()) collectSubmodules(p, subFiles);
  }
  let src = "";
  for (const f of subFiles) src += readFileSync(f, "utf8") + "\n";
  src += readFileSync(MAIN, "utf8"); // main module last
  return src;
}
