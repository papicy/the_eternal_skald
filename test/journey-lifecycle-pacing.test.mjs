/* =====================================================================
 *  Journey lifecycle & pacing regression guards for The Eternal Skald.
 *
 *  Locks in the four targeted journey fixes approved on 2026-06-14. The
 *  affected code (integration.js journey/link-move wiring, moves.js progress
 *  gate) is tightly coupled to Foundry globals and cannot be imported
 *  standalone, so — like journey-fixes.test.mjs and site-generator.test.mjs —
 *  the behaviour is verified with source-text guards.
 *
 *  A: A full journey (10/10) is NO LONGER auto-completed. The track stays
 *     OPEN and the narration is steered to prompt "Reach Your Destination".
 *  B: The link-move click handler captures the FULL preceding narration as
 *     the player's intent (data-raw-intent or surrounding text) before the
 *     roll, so journey auto-naming can recover a real destination.
 *  C: After each narration, an OPEN journey deterministically suggests the
 *     correct next progress move ("Undertake a Journey", or "Reach Your
 *     Destination" at 10/10) — gated by allowFollowups / suggestMoves.
 *  D: The "Reach Your Destination" progress gate requires EXACTLY 10/10
 *     boxes for journeys (not the journeyMinProgressBoxes floor).
 *
 *  Run: node test/journey-lifecycle-pacing.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, "..", "scripts");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }

console.log("Journey lifecycle & pacing fixes test\n");

const integration = readFileSync(join(SCRIPTS, "narrative", "integration.js"), "utf8");
const moves = readFileSync(join(SCRIPTS, "ironsworn", "moves.js"), "utf8");

/* --------------------------------------------------------------------- *
 * [A] Full journey is NOT auto-completed — track stays open for the roll.
 * --------------------------------------------------------------------- */
{
  // The journey hit-handler must NOT auto-complete a full journey. Only the
  // combat flow may still call _autoCompleteIfFull.
  ok(!/_autoCompleteIfFull\(\s*actor\s*,\s*track\.id\s*,\s*["']journey["']\s*\)/.test(integration),
     "[A] journey hit-handler no longer calls _autoCompleteIfFull(..., \"journey\")");
  ok(/_autoCompleteIfFull\([^)]*["']combat["']\s*\)/.test(integration),
     "[A] combat flow still auto-completes (unchanged)");
  // At 10/10 the journey flow steers narration toward the resolving roll.
  ok(/Math\.floor\(cur2\s*\/\s*4\)\s*>=\s*10/.test(integration),
     "[A] journey flow detects a fully-charted (10/10) track");
  ok(/fully charted \(10\/10\)[\s\S]{0,160}Reach Your Destination/.test(integration),
     "[A] full journey prompts the player to roll \"Reach Your Destination\" instead of narrating arrival");
}

/* --------------------------------------------------------------------- *
 * [B] link-move handler captures the full preceding narration as intent.
 * --------------------------------------------------------------------- */
{
  // The handler delegates intent capture before rolling.
  const idx = integration.indexOf('action === "link-move"');
  ok(idx >= 0, "[B] link-move handler present");
  const block = integration.slice(idx, idx + 1500);
  ok(/_captureLinkMoveIntent\(/.test(block),
     "[B] link-move handler calls _captureLinkMoveIntent before the roll");
  // The capture helper reads data-raw-intent OR the surrounding narration text.
  ok(/_captureLinkMoveIntent\s*\(\s*btn\s*,\s*move\s*,\s*root\s*\)/.test(integration),
     "[B] _captureLinkMoveIntent defined with (btn, move, root)");
  ok(/dataset\?\.rawIntent/.test(integration),
     "[B] helper honours an explicit data-raw-intent override");
  ok(/closest\?\.\(["']\.message-content["']\)[\s\S]{0,80}closest\?\.\(["']\.chat-message["']\)/.test(integration),
     "[B] helper falls back to the full surrounding narration text");
  ok(/textContent[\s\S]{0,40}replace\(\/\\s\+\/g/.test(integration),
     "[B] surrounding text is whitespace-collapsed");
  // Intent must be time-stamped (freshness guard from the earlier fix is kept).
  ok(/this\._lastIntent\s*=\s*rawIntent;\s*this\._lastIntentTs\s*=\s*Date\.now\(\)/.test(integration),
     "[B] captured intent is time-stamped via _lastIntentTs");
}

/* --------------------------------------------------------------------- *
 * [C] Deterministic journey-continuation suggestion after narration.
 * --------------------------------------------------------------------- */
{
  // _narrateOutcome invokes the suggester inside the followups branch.
  ok(/await this\._maybeSuggestJourneyContinuation\(actor,\s*parsed\)/.test(integration),
     "[C] _narrateOutcome calls _maybeSuggestJourneyContinuation");
  ok(/async _maybeSuggestJourneyContinuation\(actor,\s*parsed\)/.test(integration),
     "[C] _maybeSuggestJourneyContinuation defined");
  // It no-ops when inactive or on the completion roll's own turn.
  ok(/if \(!actor \|\| !this\.active\(\)\) return false;/.test(integration),
     "[C] suggester no-ops when no actor / system inactive");
  ok(/_completionMoveKind\(parsed\?\.moveName\)\s*===\s*["']journey["'][\s\S]{0,20}return false/.test(integration),
     "[C] suggester never stacks on the journey-completion roll's own turn");
  // It only acts on an OPEN journey track.
  ok(/_newestOpenTrackItem\?\.\(actor,\s*["']journey["']\)/.test(integration),
     "[C] suggester targets the newest OPEN journey track");
  // Full → Reach Your Destination, else Undertake a Journey (+wits).
  ok(/const moveName = full \? ["']Reach Your Destination["'] : ["']Undertake a Journey["'];/.test(integration),
     "[C] offers Reach Your Destination at 10/10, else Undertake a Journey");
  ok(/const stat\s*=\s*full \? ["']["'] : ["']wits["'];/.test(integration),
     "[C] Undertake a Journey is offered with +wits");
  // The card reuses the existing link-move wiring and stamps the track name as
  // the explicit intent so clicking reuses the SAME track (no duplicate branch).
  ok(/data-skald-action="link-move"[\s\S]{0,160}data-raw-intent="\$\{escapeHtml\(tname\)\}"/.test(integration),
     "[C] suggestion card reuses link-move and stamps the track name as data-raw-intent");
}

/* --------------------------------------------------------------------- *
 * [D] "Reach Your Destination" gate requires EXACTLY 10/10 for journeys.
 * --------------------------------------------------------------------- */
{
  ok(/const needBoxes\s*=\s*kind === ["']journey["'] \? 10 : minBoxes;/.test(moves),
     "[D] journeys require 10 boxes; other progress kinds keep the minBoxes floor");
  ok(/kind === ["']journey["'] && gateOn && !opts\.force && score < needBoxes/.test(moves),
     "[D] gate blocks the journey progress roll below the required boxes");
  // The CONTRACT setting reads are preserved (not removed/renamed).
  ok(/journeyMinProgressBoxes/.test(moves),
     "[D] journeyMinProgressBoxes setting still read (contract preserved)");
  ok(/enforceJourneyProgressGate/.test(moves),
     "[D] enforceJourneyProgressGate setting still read (contract preserved)");
  // opts.force still bypasses the gate.
  ok(/!opts\.force/.test(moves),
     "[D] opts.force still overrides the gate");
  // Error message reflects the full-track requirement.
  ok(/fully charted \(10\/10 boxes\)/.test(moves),
     "[D] gate error explains the 10/10 requirement");
}

/* --------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
