/* =====================================================================
 *  §8b  DELVE SITE ORACLE  (pure, framework-free)
 *  ---------------------------------------------------------------------
 *  The deterministic, Foundry-free core of the AI "Discover a Site"
 *  feature. Everything here is a pure function over plain data so it can
 *  be unit-tested directly under Node (test/site-generator.test.mjs) with
 *  no Foundry globals. The Foundry- and AI-coupled orchestration that
 *  consumes these helpers lives in narrative/generators.js (SiteGenerator),
 *  following the same split the rest of the codebase uses for testability.
 *
 *  DELVE DNA — this module preserves Ironsworn: Delve's site structure:
 *    • A site is a random Theme (its atmosphere) + a random Domain (its
 *      physical environment), each drawn uniformly like a Delve card.
 *    • Features lean toward the Domain (Delve's Features oracle is 1–20
 *      Theme / 21–100 Domain — ~80% domain-flavoured).
 *    • Dangers blend Theme, Domain and universal perils (Delve's Dangers
 *      oracle: 1–30 Theme / 31–45 Domain / 46–100 rulebook).
 *  The AI only *enriches* this rolled scaffold with evocative, mysterious
 *  prose — it never replaces the random roll, and never decides for the
 *  player. Site content (themes/domains) is from the Ironsworn: Delve SRD
 *  by Shawn Tomkin, licensed CC BY 4.0.
 *
 *  No imports, no side effects, no module-eval globals.
 * ===================================================================== */

/** The 10 canonical Ironsworn: Delve themes (a site's atmosphere). */
export const DELVE_THEMES = Object.freeze([
  "Ancient", "Corrupted", "Fortified", "Hallowed", "Haunted",
  "Infested", "Ravaged", "Ruined", "Sacred", "Wild"
]);

/** The 12 canonical Ironsworn: Delve domains (a site's physical environment). */
export const DELVE_DOMAINS = Object.freeze([
  "Barrow", "Cavern", "Frozen Cavern", "Icereach", "Mine", "Pass",
  "Ruin", "Sea Cave", "Shadowfen", "Stronghold", "Tanglewood", "Underkeep"
]);

/** Valid Ironsworn progress ranks, weakest → strongest. */
export const SITE_RANKS = Object.freeze([
  "troublesome", "dangerous", "formidable", "extreme", "epic"
]);

/**
 * Roll a random Theme + Domain, preserving Delve's "draw a card" model
 * (uniform selection from each deck). An injectable RNG keeps it testable.
 *
 * @param {() => number} [rng] - returns a float in [0, 1); defaults to Math.random
 * @returns {{theme: string, domain: string}}
 */
export function rollThemeAndDomain(rng = Math.random) {
  const pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length];
  return { theme: pick(DELVE_THEMES), domain: pick(DELVE_DOMAINS) };
}

/**
 * Build the user-prompt that asks the model to flesh out the rolled site.
 * Embeds the campaign's mandated "generate mystery, not explanation"
 * directives and the Delve Features/Dangers probability structure so the
 * model's output keeps the Delve DNA intact.
 *
 * @param {{theme: string, domain: string, rank?: string}} rolled
 * @param {string} [context] - campaign context digest (character, vows, region…)
 * @returns {string}
 */
export function buildSitePrompt(rolled, context = "") {
  const { theme, domain } = rolled;
  const rankLine = rolled.rank
    ? `The site's danger rank is "${rolled.rank}".`
    : `Choose a fitting danger rank from: ${SITE_RANKS.join(", ")}.`;
  return `Discover a Site for an Ironsworn: Delve expedition.

ROLLED SCAFFOLD (do not change these — they are the site's Delve DNA):
• Theme (atmosphere): ${theme}
• Domain (environment): ${domain}
${rankLine}

${context ? `CAMPAIGN CONTEXT (weave the site into this, do not contradict it):\n${context}\n` : ""}
DELVE STRUCTURE — honour these proportions:
• Most FEATURES should arise from the Domain (${domain}); a few from the Theme (${theme}).
• THREATS should blend the Theme, the Domain, and the wider perils of the Ironlands.

THE SKALD'S CHARGE — craft mystery, not exposition:
• Generate MYSTERIES rather than explanations.
• Leave at least THREE questions deliberately UNANSWERED.
• Offer CLUES instead of answers — hint, never confirm.
• Give EVOCATIVE DETAILS instead of full histories.
• Preserve ambiguity: the players must wonder, investigate, and decide.
• Never resolve the players' choices for them — present the site, not its conclusion.

Respond with ONLY a JSON object (no prose, no code fences) of this exact shape:
{
  "name": "evocative site name",
  "theme": "${theme}",
  "domain": "${domain}",
  "rank": "one of ${SITE_RANKS.join("|")}",
  "summary": "2-3 sentences of mysterious overview",
  "features": ["3-5 evocative, domain-led features"],
  "denizens": ["2-4 things that dwell or linger here"],
  "opportunities": ["2-3 tempting possibilities or rewards"],
  "threats": ["2-3 dangers, kept ominous and unexplained"],
  "areas": ["2-4 distinct places within the site"],
  "questions": ["at least 3 unanswered questions the site raises"]
}`;
}

/** Coerce any value into a clean, de-duplicated array of non-empty strings. */
function toStringList(v, max = 8) {
  if (!Array.isArray(v)) {
    if (typeof v === "string" && v.trim()) v = v.split(/\n|;|•/);
    else return [];
  }
  const seen = new Set();
  const out = [];
  for (const item of v) {
    const s = String(item ?? "").trim();
    if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
    if (out.length >= max) break;
  }
  return out;
}

/** Clamp a rank string to a valid SITE_RANKS value (default "dangerous"). */
export function normalizeSiteRank(rank, fallback = "dangerous") {
  const r = String(rank ?? "").toLowerCase().trim();
  return SITE_RANKS.includes(r) ? r : fallback;
}

/**
 * Parse and validate the model's reply into a clean site object. Tolerant
 * of code fences and surrounding prose: it extracts the first balanced JSON
 * object it can find. Always returns a well-formed site (filling sane
 * defaults from the rolled scaffold) so callers never crash on a sloppy
 * reply; returns ok:false only when no JSON object can be recovered at all.
 *
 * @param {string} raw - the raw model reply
 * @param {{theme: string, domain: string}} rolled - the rolled scaffold
 * @returns {{ok: boolean, site: object|null, error?: string}}
 */
export function parseSiteResponse(raw, rolled) {
  const text = String(raw ?? "");
  // Strip code fences, then grab the first {...} balanced object.
  const fenced = text.replace(/```(?:json)?/gi, "");
  const start = fenced.indexOf("{");
  if (start === -1) return { ok: false, site: null, error: "no JSON object in reply" };
  let depth = 0, end = -1;
  for (let i = start; i < fenced.length; i++) {
    if (fenced[i] === "{") depth++;
    else if (fenced[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) return { ok: false, site: null, error: "unbalanced JSON object in reply" };

  let obj;
  try { obj = JSON.parse(fenced.slice(start, end)); }
  catch (e) { return { ok: false, site: null, error: `invalid JSON: ${e.message}` }; }
  if (!obj || typeof obj !== "object") {
    return { ok: false, site: null, error: "reply was not a JSON object" };
  }

  const site = {
    name: String(obj.name ?? "").trim() || `The ${rolled.theme} ${rolled.domain}`,
    theme: String(obj.theme ?? rolled.theme).trim() || rolled.theme,
    domain: String(obj.domain ?? rolled.domain).trim() || rolled.domain,
    rank: normalizeSiteRank(obj.rank),
    summary: String(obj.summary ?? "").trim(),
    features: toStringList(obj.features),
    denizens: toStringList(obj.denizens),
    opportunities: toStringList(obj.opportunities),
    threats: toStringList(obj.threats),
    areas: toStringList(obj.areas),
    questions: toStringList(obj.questions)
  };
  return { ok: true, site };
}

/**
 * Build a deterministic fallback site from the rolled scaffold alone, for
 * when the AI is unreachable / disabled / returns garbage. Keeps the Delve
 * DNA (theme + domain) and the "mystery over explanation" spirit while
 * needing no model call — the manual-oracle safety net.
 *
 * @param {{theme: string, domain: string, rank?: string}} rolled
 * @returns {object} a well-formed site object
 */
export function buildFallbackSite(rolled) {
  const theme = rolled.theme, domain = rolled.domain;
  return {
    name: `The ${theme} ${domain}`,
    theme,
    domain,
    rank: normalizeSiteRank(rolled.rank),
    summary: `A ${theme.toLowerCase()} ${domain.toLowerCase()} broods at the edge of the known. Roll on the Theme and Domain cards' Features and Dangers oracles to reveal it.`,
    features: [`A ${domain.toLowerCase()} shaped by ${theme.toLowerCase()} forces`],
    denizens: [],
    opportunities: [],
    threats: [],
    areas: [],
    questions: [
      "Who or what last passed through here?",
      "What does this place want?",
      "What is hidden at its heart?"
    ],
    fallback: true
  };
}
