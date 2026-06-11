#!/usr/bin/env node
/* =====================================================================
 *  THE ETERNAL SKALD — Test Runner
 *  ---------------------------------------------------------------------
 *  Discovers and runs every `test/*.test.mjs` regression test in its own
 *  child Node process, aggregates the per-file pass/fail counts, and
 *  exits non-zero if ANY test file fails.
 *
 *  The bundled tests are framework-free: each file maintains its own
 *  pass/fail counters, prints "<n> passed, <m> failed", and calls
 *  process.exit(m ? 1 : 0). This runner simply orchestrates them so the
 *  whole suite can be run with a single `npm test`.
 *
 *  Usage:
 *      npm test                # run the whole suite
 *      node test/run-all.mjs   # same thing
 *
 *  No dependencies, no build step — pure Node ESM (Node 18+).
 * ===================================================================== */

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const files = readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();

if (files.length === 0) {
  console.error("No *.test.mjs files found in", __dirname);
  process.exit(1);
}

let filesPassed = 0;
let filesFailed = 0;
const failedFiles = [];

console.log(`\nThe Eternal Skald — running ${files.length} test file(s)\n`);

for (const file of files) {
  const full = join(__dirname, file);
  const res = spawnSync(process.execPath, [full], { encoding: "utf8" });
  const out = (res.stdout || "") + (res.stderr || "");
  const m = out.match(/(\d+) passed, (\d+) failed/);
  const summary = m ? `${m[1]} passed, ${m[2]} failed` : "(no summary)";
  const ok = res.status === 0 && (!m || Number(m[2]) === 0);

  if (ok) {
    filesPassed++;
    console.log(`  \u2713 ${file.padEnd(36)} ${summary}`);
  } else {
    filesFailed++;
    failedFiles.push(file);
    console.log(`  \u2717 ${file.padEnd(36)} ${summary}`);
    // Surface the child output so the failure is debuggable in CI logs.
    if (out.trim()) console.log(out.split("\n").map((l) => `      ${l}`).join("\n"));
  }
}

console.log("\n-----------------------------------------------------------");
console.log(`Test files: ${filesPassed} passed, ${filesFailed} failed (of ${files.length})`);
if (failedFiles.length) {
  console.log("Failed files:");
  for (const f of failedFiles) console.log(`  - ${f}`);
}
console.log("-----------------------------------------------------------\n");

process.exit(filesFailed === 0 ? 0 : 1);
