/* =====================================================================
 *  Journey-mechanic regression guards for The Eternal Skald.
 *
 *  Locks in four targeted bug fixes to the journey lifecycle. The affected
 *  code (commands.js !progress handler, integration.js roll/journey wiring)
 *  is tightly coupled to Foundry globals and can't be imported standalone,
 *  so — like site-generator.test.mjs and direct-llm-fallback.test.mjs — the
 *  behaviour is verified with source-text guards.
 *
 *  Fix 1: !progress must use the PERMISSIVE journey classifier so hand-made /
 *         legacy journeys (subtype "progress", no trackKind flag) are listed.
 *  Fix 2: _lastIntent captures are time-stamped, and _resolveJourney only
 *         trusts a RECENTLY captured intent (freshness window).
 *  Fix 3: deterministic auto-flows run regardless of the aiAppliesEffects
 *         setting (plain `else`, not `else if (allowEffects)`).
 *  Fix 4: _detectIronswornRoll / _parseFromHtml are fail-closed (try/catch)
 *         with an Ironsworn-scoped dice-shape fallback.
 *
 *  Run: node test/journey-fixes.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, "..", "scripts");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }

console.log("Journey-mechanic fixes test\n");

const commands = readFileSync(join(SCRIPTS, "chat", "commands.js"), "utf8");
const integration = readFileSync(join(SCRIPTS, "narrative", "integration.js"), "utf8");

/* --------------------------------------------------------------------- *
 * [1] Fix 1 — permissive journey detection in !progress (commands.js).
 * --------------------------------------------------------------------- */
{
  // The open-journeys lister must use the permissive classifier helper, not the
  // old strict (kind === "journey" || subtype === "journey") predicate.
  ok(/const isJourneyT\s*=/.test(commands), "[1] commands.js defines isJourneyT helper");
  ok(/const isVowT\s*=/.test(commands) && /const isCombatT\s*=/.test(commands),
     "[1] commands.js defines isVowT / isCombatT helpers");
  // Permissive branch: a track with no kind that is not a vow/combat/bond is a journey.
  ok(/!t\.kind\s*&&\s*!isVowT\(t\)\s*&&\s*!isCombatT\(t\)/.test(commands),
     "[1] isJourneyT treats flagless non-vow/non-combat tracks as journeys");
  ok(/return isJourneyT\(t\)\s*&&\s*!t\.completed/.test(commands),
     "[1] open-journeys filter uses isJourneyT and excludes completed tracks");
  // The dead, too-strict subtype === "journey" predicate must be gone.
  ok(!/String\(t\.subtype[^\n]*\)\.toLowerCase\(\)\s*===\s*["']journey["']/.test(commands),
     "[1] old strict subtype===\"journey\" predicate removed");
}

/* --------------------------------------------------------------------- *
 * [2] Fix 2 — intent staleness guard (integration.js).
 * --------------------------------------------------------------------- */
{
  // Every _lastIntent assignment must also stamp _lastIntentTs.
  const intentAssigns = (integration.match(/this\._lastIntent\s*=/g) || []).length;
  const tsAssigns = (integration.match(/this\._lastIntentTs\s*=\s*Date\.now\(\)/g) || []).length;
  ok(intentAssigns > 0, "[2] integration.js still assigns _lastIntent");
  ok(tsAssigns >= intentAssigns,
     `[2] every _lastIntent assignment is time-stamped (intent=${intentAssigns}, ts=${tsAssigns})`);
  // _resolveJourney must define a freshness window and only trust a fresh intent.
  ok(/INTENT_FRESH_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/.test(integration),
     "[2] _resolveJourney defines a 5-minute INTENT_FRESH_MS window");
  ok(/const fresh\s*=\s*ts\s*>\s*0\s*&&\s*\(Date\.now\(\)\s*-\s*ts\)\s*<=\s*INTENT_FRESH_MS/.test(integration),
     "[2] freshness computed from _lastIntentTs");
  ok(/const intent\s*=\s*fresh\s*\?\s*String\(this\._lastIntent[^\n]*:\s*""/.test(integration),
     "[2] stale/absent intent falls through as empty string");
}

/* --------------------------------------------------------------------- *
 * [3] Fix 3 — deterministic auto-flows are not gated on aiAppliesEffects.
 * --------------------------------------------------------------------- */
{
  // The auto-flow dispatch block must run via a plain `else`, then call the
  // deterministic flows. The old `else if (allowEffects)` gate must be gone.
  ok(/_autoCombatFlow\(/.test(integration) && /_autoJourneyFlow\(/.test(integration),
     "[3] deterministic auto-flows are present");
  // Locate the mechanicsApplied / autoSummary dispatch and confirm the branch
  // immediately preceding the auto* calls is a bare `else {` (not gated).
  const m = integration.match(/if \(opts\.mechanicsApplied\) \{[\s\S]*?\} else (\bif\b)?/);
  ok(m && !m[1], "[3] auto-flow branch uses plain `else` (not `else if (allowEffects)`)");
  // allowEffects must still gate the AI narrative/effect portion downstream.
  ok(/allowEffects/.test(integration), "[3] allowEffects still used to gate the AI narrative portion");
}

/* --------------------------------------------------------------------- *
 * [4] Fix 4 — resilient roll detection / HTML parsing (integration.js).
 * --------------------------------------------------------------------- */
{
  // _detectIronswornRoll fail-closed + dice-shape fallback helpers exist.
  ok(/_detectIronswornRoll\(message\)\s*\{[\s\S]*?try\s*\{/.test(integration),
     "[4] _detectIronswornRoll wraps its body in try/catch");
  ok(/_hasIronswornDiceShape\(/.test(integration), "[4] defines _hasIronswornDiceShape helper");
  ok(/_ironswornContext\(/.test(integration), "[4] defines _ironswornContext helper");
  ok(/source:\s*["']dice["']/.test(integration), "[4] dice-shape fallback reports source 'dice'");
  // Dice signature: one d6 + at least two d10s.
  ok(/faces\s*===\s*10/.test(integration) && /faces\s*===\s*6/.test(integration) && /d10s\s*>=\s*2/.test(integration),
     "[4] dice shape requires a d6 + >= 2 d10s");
  // Fallback is Ironsworn-scoped (won't fire in other systems).
  ok(/foundry-ironsworn/.test(integration), "[4] dice fallback scoped to the foundry-ironsworn system");
  // _parseFromHtml fail-closed.
  ok(/_parseFromHtml\(message\)\s*\{[\s\S]*?try\s*\{/.test(integration),
     "[4] _parseFromHtml wraps its body in try/catch");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
