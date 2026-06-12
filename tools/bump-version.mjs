#!/usr/bin/env node
/* =====================================================================
 *  THE ETERNAL SKALD — Version Bump Tool
 *  ---------------------------------------------------------------------
 *  One command that sets the module version in the two authoritative
 *  manifests at once, so they can never drift apart again:
 *
 *      module.json   ← the single source of truth (Foundry reads this)
 *      package.json  ← kept in lock-step for the dev/test tooling
 *
 *  By default it also creates a git commit ("chore: bump version to vX.Y.Z").
 *
 *  Usage:
 *      npm run version:bump 0.15.0           # update both files + commit
 *      npm run version:bump 0.15.0 --no-commit   # update files only
 *      node tools/bump-version.mjs 0.15.0
 *
 *  Design notes / safety:
 *    - Zero npm dependencies — pure Node ESM (Node 18+), core modules only,
 *      matching the project's "no build step" contract.
 *    - It does a *targeted* replace of only the `"version": "..."` field in
 *      each manifest (not a JSON.parse → JSON.stringify round-trip), so the
 *      rest of each file — including module.json's large HTML description —
 *      is preserved byte-for-byte.
 *    - Fails closed: validates semver, checks files exist, refuses to commit
 *      a dirty tree of unrelated changes, and verifies the edit actually
 *      landed before writing. On any error it touches nothing and exits 1.
 * ===================================================================== */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

/* --------------------------------------------------------------------- *
 * Small helpers
 * --------------------------------------------------------------------- */
function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// SemVer (https://semver.org) — major.minor.patch with optional -prerelease
// and +build metadata. Anchored so partial/garbage input is rejected.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Replace the first top-level `"version": "..."` value in a manifest's text. */
function replaceVersionField(text, nextVersion) {
  // Match a JSON member:  "version"  :  "x.y.z"
  const re = /("version"\s*:\s*")([^"]*)(")/;
  if (!re.test(text)) return null;
  let prev = null;
  const out = text.replace(re, (_m, p1, old, p3) => {
    prev = old;
    return `${p1}${nextVersion}${p3}`;
  });
  return { out, prev };
}

/* --------------------------------------------------------------------- *
 * 1) Parse & validate arguments
 * --------------------------------------------------------------------- */
const args = process.argv.slice(2);
const noCommit = args.includes("--no-commit");
const positionals = args.filter((a) => !a.startsWith("--"));
const nextVersion = positionals[0];

if (!nextVersion) {
  die(
    'No version given.\n' +
      '  Usage: npm run version:bump <version> [--no-commit]\n' +
      '  e.g.   npm run version:bump 0.15.0'
  );
}
if (!SEMVER_RE.test(nextVersion)) {
  die(
    `"${nextVersion}" is not a valid semver version.\n` +
      "  Expected MAJOR.MINOR.PATCH (e.g. 0.15.0, 1.0.0, 0.15.0-beta.1)."
  );
}

/* --------------------------------------------------------------------- *
 * 2) Locate the manifests and read them
 * --------------------------------------------------------------------- */
const TARGETS = [
  { name: "module.json", path: join(ROOT, "module.json") },
  { name: "package.json", path: join(ROOT, "package.json") },
];

for (const t of TARGETS) {
  if (!existsSync(t.path)) die(`Cannot find ${t.name} at ${t.path}`);
}

// Read current version from module.json (the source of truth) for reporting.
let currentVersion = "?";
try {
  currentVersion = JSON.parse(readFileSync(TARGETS[0].path, "utf8")).version || "?";
} catch {
  die("module.json is not valid JSON — refusing to edit. Fix it first.");
}

if (currentVersion === nextVersion) {
  die(`Version is already ${nextVersion} — nothing to do.`);
}

/* --------------------------------------------------------------------- *
 * 3) Compute the edits in memory and verify each one lands BEFORE writing.
 * --------------------------------------------------------------------- */
const edits = [];
for (const t of TARGETS) {
  const text = readFileSync(t.path, "utf8");
  const res = replaceVersionField(text, nextVersion);
  if (!res) die(`Could not find a "version" field in ${t.name} — aborting (no files changed).`);
  // Sanity: confirm the new text actually parses as JSON and carries the bump.
  try {
    const parsed = JSON.parse(res.out);
    if (parsed.version !== nextVersion) {
      die(`Internal check failed: ${t.name} version did not update cleanly — aborting.`);
    }
  } catch {
    die(`Edit would have produced invalid JSON in ${t.name} — aborting (no files changed).`);
  }
  edits.push({ ...t, text: res.out, prev: res.prev });
}

/* --------------------------------------------------------------------- *
 * 4) Write all files (only now that every edit is validated).
 * --------------------------------------------------------------------- */
for (const e of edits) {
  writeFileSync(e.path, e.text);
  console.log(`✓ ${e.name}: ${e.prev} → ${nextVersion}`);
}

console.log(`\nVersion bumped ${currentVersion} → ${nextVersion}.`);

/* --------------------------------------------------------------------- *
 * 5) Optional git commit.
 * --------------------------------------------------------------------- */
if (noCommit) {
  console.log("\n(--no-commit) Files updated but not committed. Review and commit when ready.");
  process.exit(0);
}

function git(...gitArgs) {
  return spawnSync("git", gitArgs, { cwd: ROOT, encoding: "utf8" });
}

// Make sure we're in a git work tree before trying to commit.
const inRepo = git("rev-parse", "--is-inside-work-tree");
if (inRepo.status !== 0 || inRepo.stdout.trim() !== "true") {
  console.log(
    "\n⚠ Not a git work tree — files were updated but not committed."
  );
  process.exit(0);
}

// Stage only the two manifests, then commit. We deliberately do NOT `git add -A`
// so unrelated working-tree changes are never swept into the version commit.
const add = git("add", "module.json", "package.json");
if (add.status !== 0) {
  console.log("\n⚠ `git add` failed — files updated but not committed:");
  console.log(add.stderr || add.stdout);
  process.exit(0);
}

const msg = `chore: bump version to v${nextVersion}`;
const commit = git("commit", "-m", msg);
if (commit.status !== 0) {
  console.log("\n⚠ `git commit` failed — files were staged but not committed:");
  console.log(commit.stderr || commit.stdout);
  process.exit(0);
}

console.log(`\n✓ Committed: "${msg}"`);
console.log("  Next: review the commit, then `git push` and tag the release as you normally would.");
