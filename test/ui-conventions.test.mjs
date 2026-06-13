/* =====================================================================
 *  UI conventions guard for The Eternal Skald (v0.21.0, U1).
 *
 *  Locks in the ApplicationV2 adoption standard documented in
 *  docs/UI-CONVENTIONS.md so the module stays aligned with Foundry's modern
 *  application framework (and future-proof for v15+). These are static
 *  source guards — no Foundry runtime required.
 *
 *    [1] No deprecated v1 base classes: `extends FormApplication` and
 *        `extends Application` are forbidden anywhere in scripts/.
 *    [2] Every classic `new Dialog(` is a graceful fallback — the same file
 *        must also reference DialogV2 (the modern path it falls back from).
 *    [3] Every scripts/ui/*.js window module that uses ApplicationV2 builds
 *        its subclass through a lazy factory (guarded by the Foundry global)
 *        and has NO top-level `class … extends …` (which would throw under
 *        the plain-Node load-smoke import).
 *    [4] The convention doc exists and lists the rules.
 *
 *  Run: node test/ui-conventions.test.mjs
 * ===================================================================== */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = (...p) => join(__dirname, "..", ...p);
const read = (...p) => readFileSync(root(...p), "utf8");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }

console.log("UI conventions guard (v0.21.0, U1)\n");

/** Recursively collect every .js file under scripts/. */
function collectJs(dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) collectJs(full, acc);
    else if (ent.isFile() && ent.name.endsWith(".js")) acc.push(full);
  }
  return acc;
}

const scriptsDir = root("scripts");
const files = collectJs(scriptsDir);
ok(files.length >= 20, `discovered a plausible number of scripts (${files.length})`);

/* ── [1] No deprecated v1 base classes ───────────────────────────── */
const v1Base = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  // `extends Application` but NOT ApplicationV2; and `extends FormApplication`.
  if (/extends\s+FormApplication\b/.test(src)) v1Base.push(`${f} (FormApplication)`);
  if (/extends\s+Application(?!V2)\b/.test(src)) v1Base.push(`${f} (Application)`);
}
ok(v1Base.length === 0, `no deprecated v1 base classes (offenders: ${v1Base.join(", ") || "none"})`);

/* ── [2] Every classic `new Dialog(` is a guarded fallback ───────── */
const orphanDialogs = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  if (/\bnew\s+Dialog\s*\(/.test(src) && !/DialogV2/.test(src)) orphanDialogs.push(f);
}
ok(orphanDialogs.length === 0, `every classic Dialog falls back from DialogV2 (offenders: ${orphanDialogs.join(", ") || "none"})`);
// sanity: there really ARE guarded fallbacks (so the guard above is meaningful)
const dialogFiles = files.filter((f) => /\bnew\s+Dialog\s*\(/.test(readFileSync(f, "utf8")));
ok(dialogFiles.length >= 1, `found guarded classic-Dialog fallbacks to validate (${dialogFiles.length})`);

/* ── [3] UI window modules use a lazy ApplicationV2 factory ──────── */
const uiDir = root("scripts", "ui");
const uiFiles = readdirSync(uiDir).filter((n) => n.endsWith(".js"));
ok(uiFiles.length >= 3, `scripts/ui has window modules (${uiFiles.length})`);
for (const name of uiFiles) {
  const src = read("scripts", "ui", name);
  if (!/ApplicationV2/.test(src)) continue;        // e.g. autocomplete is a plain dropdown
  // must guard on the Foundry global and bail when absent
  ok(/foundry\?\.applications\?\.api\?\.ApplicationV2/.test(src),
    `${name}: guards on foundry?.applications?.api?.ApplicationV2`);
  ok(/return null/.test(src), `${name}: lazy factory returns null when Foundry global is absent`);
  // no top-level (column-0) class declaration — the subclass lives inside the factory
  ok(!/^\s*(export\s+)?class\s+\w+\s+extends/m.test(src.replace(/^( {2,}|\t).*class.*$/gm, "")),
    `${name}: no top-level class extends (subclass is lazily defined)`);
}

/* ── [4] Convention doc present ──────────────────────────────────── */
const doc = read("docs", "UI-CONVENTIONS.md");
ok(/ApplicationV2/.test(doc), "UI-CONVENTIONS.md documents ApplicationV2");
ok(/DialogV2/.test(doc), "UI-CONVENTIONS.md documents the DialogV2-first fallback");
ok(/lazy/i.test(doc), "UI-CONVENTIONS.md documents the lazy factory pattern");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
