/* =====================================================================
 *  Progress-track naming / registration guard.
 *
 *  Regression coverage for two reported bugs in progress-track creation
 *  (vows / combat / journeys) that BOTH traced to one chokepoint —
 *  Integration._splitNameRank() in scripts/narrative/integration.js:
 *
 *    BUG 1 ("track never registers"):
 *      A rank word emitted BEFORE the name (mis-ordered "<rank> <Name>")
 *      yielded an empty name, so the create_* handler returned null and the
 *      directive was silently dropped — no track ever appeared.
 *
 *    BUG 2 ("bad naming"):
 *      A canonical rank WORD that is legitimately part of a track name
 *      ("Slay the Formidable Wyrm", "The Extreme Cold of the North") was
 *      mistaken for the rank and TRUNCATED the name.
 *
 *  The fix makes a rank a TRAILING token only (with a defensive recovery for
 *  a single mis-ordered leading rank). This test extracts the REAL
 *  _splitNameRank from the shipped source (not a copy) and locks the
 *  behaviour in. It also guards the documented invariant that a name is never
 *  empty when the tail carries real name tokens.
 *
 *  Run: node test/progress-track-naming.test.mjs
 * ===================================================================== */

import { readSkaldSource } from "./_skald-source.mjs";

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

/* ---- Extract the REAL _splitNameRank method from the shipped source ----
 * Locate `_splitNameRank(rest) {` then brace-match forward to its close, so
 * the test exercises the actual implementation and fails if it regresses. */
function extractMethod(src, signature) {
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`could not locate ${signature} in source`);
  const open = src.indexOf("{", start);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i); // "_splitNameRank(rest) { ... }"
}

const src = readSkaldSource();
const _RANKS = ["troublesome", "dangerous", "formidable", "extreme", "epic"];
// Anchor on the DEFINITION (method shorthand `_splitNameRank(rest) {`), which
// is the only occurrence followed by " {" — call sites read `this._splitNameRank(rest)`.
const methodText = extractMethod(src, "_splitNameRank(rest) {");
// Wrap the extracted method into a callable bound to an object that carries
// _RANKS (the only `this` dependency the method has).
// eslint-disable-next-line no-new-func
const factory = new Function("_RANKS", `const o = { _RANKS, ${methodText} }; return o;`);
const obj = factory(_RANKS);
const split = (s) => obj._splitNameRank(s);

console.log("[0] source carries the trailing-rank rule (no greedy findIndex on rank)");
ok(/recognised ONLY as a TRAILING token/i.test(src) || /TRAILING token/i.test(methodText),
   "source documents the trailing-rank rule");
ok(!/findIndex\(t\s*=>\s*\n?\s*this\._RANKS/.test(methodText),
   "old greedy first-rank findIndex is gone from _splitNameRank");

console.log("[1] canonical '<Name> <rank>' — name kept, rank parsed");
{
  const r = split("Find the Sunken Crown formidable");
  eq(r.name, "Find the Sunken Crown", "name preserved");
  eq(r.rank, "formidable", "trailing rank parsed");
}

console.log("[2] BUG 1 — mis-ordered '<rank> <Name>' recovers (NOT dropped)");
{
  const r = split("formidable Find the Sunken Crown");
  eq(r.name, "Find the Sunken Crown", "name recovered from leading rank");
  eq(r.rank, "formidable", "leading rank lifted out");
  ok(r.name.length > 0, "name is non-empty → directive will register");
}

console.log("[3] BUG 2 — rank WORD inside the name is NOT mistaken for the rank");
{
  const a = split("Slay the Formidable Wyrm");
  eq(a.name, "Slay the Formidable Wyrm", "embedded 'Formidable' kept in name");
  eq(a.rank, null, "no spurious rank extracted");

  const b = split("The Extreme Cold of the North");
  eq(b.name, "The Extreme Cold of the North", "embedded 'Extreme' kept in name");
  eq(b.rank, null, "no spurious rank extracted");
}

console.log("[4] embedded rank word + a REAL trailing rank → only trailing wins");
{
  const r = split("The Extreme Cold of the North dangerous");
  eq(r.name, "The Extreme Cold of the North", "name keeps embedded 'Extreme'");
  eq(r.rank, "dangerous", "only the trailing token is the rank");
}

console.log("[5] no rank at all — whole tail is the name");
{
  const r = split("Avenge my brother");
  eq(r.name, "Avenge my brother", "full name");
  eq(r.rank, null, "rank null (defaults downstream)");
}

console.log("[6] punctuation / quoting / whitespace are tidied");
{
  const r = split("  Road to Greywatch — dangerous  ");
  eq(r.name, "Road to Greywatch", "trailing dash punctuation trimmed off name");
  eq(r.rank, "dangerous", "rank parsed despite surrounding whitespace");
}

console.log("[7] bare rank with no name → empty name (nameless track is dropped)");
{
  const r = split("epic");
  eq(r.name, "", "no name when only a rank is supplied");
  eq(r.rank, "epic", "rank still recognised");
}

console.log("[8] short '<Name> <rank>' two-token form");
{
  const r = split("Bear dangerous");
  eq(r.name, "Bear", "single-word name kept");
  eq(r.rank, "dangerous", "trailing rank parsed");
}

console.log("[9] empty / whitespace input is safe");
{
  eq(split("").name, "", "empty input → empty name");
  eq(split("   ").name, "", "whitespace input → empty name");
  eq(split("").rank, null, "empty input → null rank");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
