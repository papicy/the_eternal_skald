/* =====================================================================
 *  Static cross-module import checker (Phase 2 refactor safety net).
 *
 *  The regression tests do NOT import the runtime module (it needs Foundry
 *  globals), so they cannot catch a method that references a sibling subsystem
 *  which was never imported into its new file. This checker fills that gap.
 *
 *  Strategy: build the project's full set of top-level symbols (the names that
 *  USED to be co-located in the monolith). For every scripts/**.js module, any
 *  such symbol that the file references but neither (a) defines locally nor
 *  (b) imports must be flagged — it would be a runtime ReferenceError.
 *
 *  Run: node test/check-imports.mjs   (exit 0 = clean, 1 = problems)
 * ===================================================================== */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS   = join(__dirname, "..", "scripts");

// Files that are part of the decomposed module graph. Pre-existing siblings
// (browser-rag, ironsworn-*) and the server are independent and excluded.
const MAIN = join(SCRIPTS, "eternal-skald.js");
function collect(dir, acc) {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n); const st = statSync(p);
    if (st.isDirectory()) collect(p, acc);
    else if (n.endsWith(".js")) acc.push(p);
  }
  return acc;
}
const subFiles = [];
for (const n of readdirSync(SCRIPTS).sort()) {
  const p = join(SCRIPTS, n);
  if (statSync(p).isDirectory()) collect(p, subFiles);
}
const FILES = [MAIN, ...subFiles];

const reDef = /^(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/;
function topLevelDefs(src) {
  const out = new Set();
  for (const line of src.split("\n")) {
    const m = reDef.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}
function importedNames(src) {
  const out = new Set();
  // import { a, b as c } from "..."; and import X from "...";
  const re = /import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["'][^"']+["']/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[1]) out.add(m[1]);
    if (m[2]) for (const part of m[2].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) out.add(name);
    }
  }
  return out;
}

// Global symbol table = union of every module's top-level defs.
const fileSrc = new Map();
const ALL = new Set();
for (const f of FILES) {
  const src = readFileSync(f, "utf8");
  fileSrc.set(f, src);
  for (const d of topLevelDefs(src)) ALL.add(d);
}

let problems = 0;
for (const f of FILES) {
  const src   = fileSrc.get(f);
  const local = topLevelDefs(src);
  const imp   = importedNames(src);
  // Strip comments + strings crudely to avoid matching symbols in prose.
  const code  = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  const missing = [];
  for (const sym of ALL) {
    if (local.has(sym) || imp.has(sym)) continue;
    const re = new RegExp(`\\b${sym.replace(/[$]/g, "\\$")}\\b`);
    if (re.test(code)) missing.push(sym);
  }
  if (missing.length) {
    problems++;
    console.error(`✗ ${relative(SCRIPTS, f)} references but does not import/define:`);
    console.error("    " + missing.sort().join(", "));
  }
}
if (problems === 0) {
  console.log("✓ import check clean — every cross-module symbol is imported or local");
  process.exit(0);
} else {
  console.error(`\n${problems} file(s) with unresolved cross-module references.`);
  process.exit(1);
}
