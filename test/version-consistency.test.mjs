/* =====================================================================
 *  Version-consistency regression guards for The Eternal Skald.
 *
 *  module.json is the SINGLE SOURCE OF TRUTH for the module version. These
 *  guards lock in the fix for a long-standing drift where runtime banners /
 *  version-display code carried a hardcoded "0.6.0" while the module shipped
 *  0.14.0. Following the project's source-text-guard style (see
 *  site-generator.test.mjs / journey-fixes.test.mjs).
 *
 *  Run: node test/version-consistency.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

console.log("Version-consistency test\n");

const moduleJson  = JSON.parse(read("module.json"));
const packageJson = JSON.parse(read("package.json"));
const VERSION = moduleJson.version;

/* --------------------------------------------------------------------- *
 * [1] module.json is the authoritative version; package.json agrees.
 * --------------------------------------------------------------------- */
ok(/^\d+\.\d+\.\d+/.test(VERSION || ""), "[1] module.json has a semver version");
eq(packageJson.version, VERSION, "[1] package.json version matches module.json");

/* --------------------------------------------------------------------- *
 * [2] Client load banner derives the version from the manifest at runtime
 *     (game.modules), NOT a hardcoded literal that can go stale.
 * --------------------------------------------------------------------- */
{
  const main = read("scripts", "eternal-skald.js");
  // The old, stale hardcoded banner must be gone.
  ok(!/v0\.6\.0\b[^\n]*module file loaded/.test(main),
     "[2] stale hardcoded 'v0.6.0 — module file loaded' banner removed");
  // The banner must read the version from game.modules.
  ok(/game\?\.modules\?\.get\?\.\(["']the-eternal-skald["']\)\?\.version/.test(main),
     "[2] load banner reads version from game.modules (the manifest)");
  // Defensive: only ever stringify a real version string (no throw at load).
  ok(/typeof v === "string"/.test(main) && /catch\b/.test(main),
     "[2] version extraction is type-checked and guarded against throwing");
}

/* --------------------------------------------------------------------- *
 * [3] init-hook authoritative banner reads the manifest version too.
 * --------------------------------------------------------------------- */
{
  const hooks = read("scripts", "hooks", "foundry-hooks.js");
  ok(/game\.modules\.get\(MODULE_ID\)\?\.version/.test(hooks),
     "[3] init-hook banner reads version from game.modules.get(MODULE_ID)");
}

/* --------------------------------------------------------------------- *
 * [4] Server hook derives VERSION from module.json (not a stale literal).
 * --------------------------------------------------------------------- */
{
  const server = read("scripts", "eternal-skald-server.mjs");
  ok(!/const VERSION\s*=\s*["']0\.6\.0["']/.test(server),
     "[4] stale hardcoded server VERSION = \"0.6.0\" removed");
  ok(/readFileSync\(\s*new URL\(["']\.\.\/module\.json["']/.test(server),
     "[4] server reads version from ../module.json");
  ok(/\.version\s*\|\|\s*["']0["']/.test(server),
     "[4] server VERSION falls back safely when manifest unreadable");
}

/* --------------------------------------------------------------------- *
 * [5] README illustrative console/health output matches the current
 *     version (historical changelog entries are intentionally untouched).
 * --------------------------------------------------------------------- */
{
  const readme = read("README.md");
  ok(readme.includes(`v${VERSION} — server hook active`),
     "[5] README server-banner example shows the current version");
  ok(readme.includes(`"version":"${VERSION}"`),
     "[5] README /skald-api/health example shows the current version");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
