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

/* --------------------------------------------------------------------- *
 * [6] README "Alpha / Development Version (vX.Y.Z)" badge must track the
 *     current module version (it presents itself as the current version,
 *     so a stale literal here is a real inconsistency — not history).
 * --------------------------------------------------------------------- */
{
  const readme = read("README.md");
  const m = readme.match(/Alpha \/ Development Version \(v([0-9]+\.[0-9]+\.[0-9]+)\)/);
  ok(!!m, "[6] README has an 'Alpha / Development Version (vX.Y.Z)' badge");
  if (m) eq(m[1], VERSION, "[6] README alpha-version badge matches module.json");
}

/* --------------------------------------------------------------------- *
 * [7] Per-file header banners must NOT pin a hardcoded module version.
 *     These decorative banners historically drifted (v0.6.0 / v0.10.21 /
 *     v0.10.30 while the module shipped 0.14.0). They are now version-
 *     agnostic; module.json is the single source of truth. This guard
 *     fails if anyone re-introduces a "vX.Y.Z" token on the title line.
 * --------------------------------------------------------------------- */
{
  const headerFiles = [
    ["scripts", "eternal-skald.js"],
    ["scripts", "eternal-skald-server.mjs"],
    ["scripts", "ironsworn-controller.js"],
    ["scripts", "browser-rag.js"],
  ];
  for (const parts of headerFiles) {
    const src = read(...parts);
    // Inspect only the banner title line ("THE ETERNAL SKALD ..."), where the
    // stale module version used to live. "v14" (Foundry VTT version) is fine.
    const titleLine = (src.split("\n").find(l => /THE ETERNAL SKALD/.test(l)) || "");
    ok(!/v[0-9]+\.[0-9]+\.[0-9]+/.test(titleLine),
       `[7] header banner in ${parts.join("/")} pins no stale module version`);
  }
}

/* --------------------------------------------------------------------- *
 * [8] Manifest hygiene (H4): the download URL must point at the CURRENT
 *     version's release tag, not a stale older one (it drifted to v0.14.0
 *     while the module shipped 0.17.0).
 * --------------------------------------------------------------------- */
{
  const dl = moduleJson.download || "";
  ok(dl.includes(`v${VERSION}.zip`),
     `[8] module.json download URL points at the current version tag (v${VERSION})`);
  ok(!/v0\.14\.0\.zip/.test(dl),
     "[8] module.json download URL no longer pins the stale v0.14.0 tag");
}

/* --------------------------------------------------------------------- *
 * [9] Manifest hygiene (H4): module.json `url` and package.json
 *     `repository.url` must reference the SAME GitHub repository slug
 *     (they drifted: the_eternal_skald vs eternal_skald).
 * --------------------------------------------------------------------- */
{
  const slug = (u) => {
    const m = (u || "").match(/github\.com\/([^/]+\/[^/.]+)/);
    return m ? m[1] : null;
  };
  const manifestSlug = slug(moduleJson.url);
  const repoSlug = slug(packageJson.repository && packageJson.repository.url);
  ok(!!manifestSlug, "[9] module.json url is a parseable GitHub repo URL");
  ok(!!repoSlug, "[9] package.json repository.url is a parseable GitHub repo URL");
  eq(repoSlug, manifestSlug, "[9] package.json repo slug matches module.json url slug");
}

/* --------------------------------------------------------------------- *
 * [10] Manifest hygiene (H4): the description must be a concise,
 *      current-version summary — the full multi-version changelog that
 *      had been embedded (back to v0.4.0) belongs in CHANGELOG.md.
 * --------------------------------------------------------------------- */
{
  const desc = moduleJson.description || "";
  ok(desc.length < 4000,
     `[10] module.json description is concise (got ${desc.length} chars, expect < 4000)`);
  ok(!/v0\.4\.0/.test(desc),
     "[10] module.json description no longer embeds the full historical changelog");
  ok(desc.includes(`v${VERSION}`),
     "[10] module.json description references the current version");
}

/* --------------------------------------------------------------------- *
 * [11] Release hygiene (L3): the most recent CHANGELOG heading must match
 *      the module version, so a release is never cut without a changelog
 *      entry (and the entry never drifts from the shipped version). This
 *      is the third leg the CI workflow enforces:
 *      module.json == package.json == CHANGELOG latest heading.
 * --------------------------------------------------------------------- */
{
  const changelog = read("CHANGELOG.md");
  // First "## [X.Y.Z]" heading top-to-bottom is the latest release.
  const m = changelog.match(/^##\s*\[(\d+\.\d+\.\d+)\]/m);
  ok(!!m, "[11] CHANGELOG.md has a '## [X.Y.Z]' release heading");
  if (m) eq(m[1], VERSION, "[11] latest CHANGELOG heading matches module.json version");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
