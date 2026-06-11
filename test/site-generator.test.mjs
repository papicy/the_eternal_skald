/* =====================================================================
 *  AI "Discover a Site" test for The Eternal Skald.
 *
 *  Covers the new Ironsworn: Delve "Discover a Site" feature:
 *    triggerMove("Discover a Site") → _isDiscoverSiteMove → (dynamic import)
 *    SiteGenerator.discover → rollThemeAndDomain (Delve DNA) → buildSitePrompt
 *    (mystery directives) → Client.chat → parseSiteResponse / buildFallbackSite
 *    → IronswornController.createProgressTrack
 *
 *  The pure oracle core (site-oracle.js) is imported and unit-tested directly
 *  (it has no Foundry deps). The AI/Foundry-coupled orchestration (generators.js
 *  SiteGenerator) and the LOCKED controller wiring can't be imported without
 *  Foundry globals, so they are verified with source-text guards — the same
 *  approach used by direct-llm-fallback.test.mjs and inline-move-suggestions.
 *
 *  Run: node test/site-generator.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DELVE_THEMES, DELVE_DOMAINS, SITE_RANKS,
  rollThemeAndDomain, buildSitePrompt, parseSiteResponse,
  buildFallbackSite, normalizeSiteRank
} from "../scripts/narrative/site-oracle.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, "..", "scripts");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

console.log("AI Discover a Site test\n");

/* --------------------------------------------------------------------- *
 * [1] Delve DNA — canonical theme/domain decks preserved.
 * --------------------------------------------------------------------- */
eq(DELVE_THEMES.length, 10, "[1] 10 canonical Delve themes");
eq(DELVE_DOMAINS.length, 12, "[1] 12 canonical Delve domains");
ok(DELVE_THEMES.includes("Haunted") && DELVE_THEMES.includes("Ancient"), "[1] themes include Haunted & Ancient");
ok(DELVE_DOMAINS.includes("Barrow") && DELVE_DOMAINS.includes("Underkeep"), "[1] domains include Barrow & Underkeep");

/* --------------------------------------------------------------------- *
 * [2] rollThemeAndDomain — uniform draw, always valid, RNG injectable.
 * --------------------------------------------------------------------- */
{
  const lo = rollThemeAndDomain(() => 0);
  eq(lo.theme, DELVE_THEMES[0], "[2] rng=0 picks first theme");
  eq(lo.domain, DELVE_DOMAINS[0], "[2] rng=0 picks first domain");
  const hi = rollThemeAndDomain(() => 0.999999);
  eq(hi.theme, DELVE_THEMES[DELVE_THEMES.length - 1], "[2] rng→1 picks last theme");
  eq(hi.domain, DELVE_DOMAINS[DELVE_DOMAINS.length - 1], "[2] rng→1 picks last domain");
  // 200 random rolls must always land inside the decks (never undefined/out-of-range).
  let allValid = true;
  for (let i = 0; i < 200; i++) {
    const r = rollThemeAndDomain();
    if (!DELVE_THEMES.includes(r.theme) || !DELVE_DOMAINS.includes(r.domain)) allValid = false;
  }
  ok(allValid, "[2] 200 random rolls always yield valid theme+domain");
}

/* --------------------------------------------------------------------- *
 * [3] buildSitePrompt — embeds the mandated "mystery, not explanation"
 *     directives, the rolled scaffold, and the Delve structure note.
 * --------------------------------------------------------------------- */
{
  const p = buildSitePrompt({ theme: "Haunted", domain: "Barrow" }, "Character: Kuna");
  ok(/MYSTERIES rather than explanations/i.test(p), "[3] directive: generate mysteries not explanations");
  ok(/three/i.test(p) && /UNANSWERED/i.test(p), "[3] directive: leave three unanswered questions");
  ok(/CLUES instead of answers/i.test(p), "[3] directive: clues instead of answers");
  ok(/EVOCATIVE DETAILS instead of full histories/i.test(p), "[3] directive: evocative details not histories");
  ok(p.includes("Haunted") && p.includes("Barrow"), "[3] prompt carries the rolled theme + domain");
  ok(p.includes("Kuna"), "[3] prompt weaves in campaign context");
  ok(/most features should arise from the domain/i.test(p), "[3] prompt honours Delve features structure");
  ok(/ONLY a JSON object/i.test(p), "[3] prompt requests strict JSON output");
}

/* --------------------------------------------------------------------- *
 * [4] parseSiteResponse — tolerant JSON extraction + coercion.
 * --------------------------------------------------------------------- */
{
  const rolled = { theme: "Ruined", domain: "Mine" };
  // Clean JSON.
  const good = parseSiteResponse(JSON.stringify({
    name: "Hollow of Rusted Vows", rank: "formidable", summary: "A wound in the rock.",
    features: ["dripping shafts", "dripping shafts"], denizens: ["something patient"],
    opportunities: ["lost ore"], threats: ["the dark"], areas: ["the descent"], questions: ["who dug it?"]
  }), rolled);
  ok(good.ok, "[4] parses clean JSON");
  eq(good.site.name, "Hollow of Rusted Vows", "[4] keeps the model's name");
  eq(good.site.rank, "formidable", "[4] keeps a valid rank");
  eq(good.site.features.length, 1, "[4] de-duplicates list entries");
  // Code-fenced + surrounding prose.
  const fenced = parseSiteResponse("Here you are:\n```json\n{\"name\":\"X\",\"rank\":\"epic\"}\n```\nEnjoy.", rolled);
  ok(fenced.ok && fenced.site.name === "X" && fenced.site.rank === "epic", "[4] extracts JSON from fences + prose");
  // Missing fields → sane defaults from the rolled scaffold.
  const sparse = parseSiteResponse("{}", rolled);
  ok(sparse.ok, "[4] empty object still parses");
  eq(sparse.site.theme, "Ruined", "[4] missing theme defaults to rolled theme");
  eq(sparse.site.domain, "Mine", "[4] missing domain defaults to rolled domain");
  eq(sparse.site.rank, "dangerous", "[4] missing/invalid rank defaults to dangerous");
  ok(sparse.site.name.includes("Ruined") && sparse.site.name.includes("Mine"), "[4] synthesises a name from scaffold");
  // Garbage → graceful failure (caller falls back).
  ok(!parseSiteResponse("the bones are silent", rolled).ok, "[4] no JSON object → ok:false");
  ok(!parseSiteResponse("{not valid json", rolled).ok, "[4] unbalanced/invalid JSON → ok:false");
  ok(!parseSiteResponse("", rolled).ok, "[4] empty reply → ok:false");
}

/* --------------------------------------------------------------------- *
 * [5] normalizeSiteRank — clamps to a valid rank.
 * --------------------------------------------------------------------- */
{
  for (const r of SITE_RANKS) eq(normalizeSiteRank(r), r, `[5] valid rank "${r}" preserved`);
  eq(normalizeSiteRank("legendary"), "dangerous", "[5] invalid rank → dangerous");
  eq(normalizeSiteRank(null), "dangerous", "[5] null rank → dangerous");
  eq(normalizeSiteRank("FORMIDABLE"), "formidable", "[5] case-insensitive rank");
}

/* --------------------------------------------------------------------- *
 * [6] buildFallbackSite — manual-oracle safety net (no AI).
 * --------------------------------------------------------------------- */
{
  const fb = buildFallbackSite({ theme: "Sacred", domain: "Pass" });
  eq(fb.theme, "Sacred", "[6] fallback preserves theme");
  eq(fb.domain, "Pass", "[6] fallback preserves domain");
  ok(SITE_RANKS.includes(fb.rank), "[6] fallback has a valid rank");
  ok(fb.questions.length >= 3, "[6] fallback leaves ≥3 unanswered questions");
  ok(fb.fallback === true, "[6] fallback is flagged as such");
  ok(typeof fb.summary === "string" && fb.summary.length > 0, "[6] fallback has a summary");
}

/* --------------------------------------------------------------------- *
 * [7] Source-text guards — orchestration & LOCKED-controller wiring.
 * --------------------------------------------------------------------- */
{
  const gen = readFileSync(join(SCRIPTS, "narrative", "generators.js"), "utf8");
  ok(/export const SiteGenerator\b/.test(gen), "[7] generators.js exports SiteGenerator");
  ok(/async discover\(/.test(gen), "[7] SiteGenerator.discover exists");
  ok(/rollThemeAndDomain|buildSitePrompt|parseSiteResponse|buildFallbackSite/.test(gen), "[7] uses the oracle helpers");
  ok(/createProgressTrack\(/.test(gen), "[7] realises the site as a progress track");
  ok(/method:\s*["']discover-site["']/.test(gen), "[7] returns method 'discover-site' (avoids error path)");
  ok(/game\.user\.isGM|ITEM_CREATE|JOURNAL_CREATE/.test(gen), "[7] document writes are permission-gated");
  ok(/buildFallbackSite\(rolled\)/.test(gen), "[7] degrades to the manual-oracle fallback");

  const ctrl = readFileSync(join(SCRIPTS, "ironsworn-controller.js"), "utf8");
  ok(/_isDiscoverSiteMove\(/.test(ctrl), "[7] controller defines _isDiscoverSiteMove");
  ok(/discover_a_site\$/.test(ctrl), "[7] classifier matches the discover_a_site datasworn id");
  ok(/await import\(["']\.\/narrative\/generators\.js["']\)/.test(ctrl), "[7] controller dynamically imports the generator");
  ok(/SiteGenerator\.discover\(/.test(ctrl), "[7] controller branch delegates to SiteGenerator.discover");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
