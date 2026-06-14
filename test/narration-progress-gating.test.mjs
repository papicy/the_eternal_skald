/* =====================================================================
 *  Narration-respects-progress regression guards for The Eternal Skald.
 *
 *  Locks in three targeted fixes (gate 2026-06-14) that make AI narration
 *  respect the mechanical progress-track state. The affected code is tightly
 *  coupled to Foundry globals and can't be imported standalone, so — like
 *  journey-fixes.test.mjs and journey-lifecycle-pacing.test.mjs — behaviour
 *  is verified with source-text guards.
 *
 *  Fix 1 (prompt-builder.js): buildSystemPrompt must forward allowFollowups
 *         into buildIronswornPromptBlock, so post-roll narration receives the
 *         valid-move whitelist, journey-pacing rules and follow-up-move rules.
 *  Fix 2 (entity-linking.js): _renderLink must validate a COMPLETION move
 *         before making it clickable — only link when a matching track is at
 *         10/10, via the _completionMoveRollable helper (fails OPEN).
 *  Fix 3 (moves.js): the v0.25.4 journey-only 10/10 gate is extended
 *         symmetrically to vow + combat (strictKind), site keeps its floor.
 *
 *  Run: node test/narration-progress-gating.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, "..", "scripts");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }

console.log("Narration-respects-progress gating test\n");

const promptBuilder = readFileSync(join(SCRIPTS, "ai", "prompt-builder.js"), "utf8");
const entityLinking = readFileSync(join(SCRIPTS, "chronicle", "entity-linking.js"), "utf8");
const moves         = readFileSync(join(SCRIPTS, "ironsworn", "moves.js"), "utf8");

/* --------------------------------------------------------------------- *
 * [1] Fix 1 — buildSystemPrompt forwards allowFollowups (prompt-builder).
 * --------------------------------------------------------------------- */
{
  // The buildIronswornPromptBlock call inside buildSystemPrompt must pass
  // allowFollowups through. Locate the call and assert the key is present.
  const callMatch = promptBuilder.match(/buildIronswornPromptBlock\(\{[\s\S]*?\}\);/);
  ok(!!callMatch, "[1] buildIronswornPromptBlock({...}) call found");
  const call = callMatch ? callMatch[0] : "";
  ok(/allowFollowups:\s*!!extras\.allowFollowups/.test(call),
     "[1] call forwards allowFollowups: !!extras.allowFollowups");
  ok(/allowMoves:\s*!!extras\.allowMoves/.test(call),
     "[1] call still forwards allowMoves (no regression)");
  // The receiver still gates the whitelist on allowMoves || allowFollowups.
  ok(/if\s*\(allowMoves\s*\|\|\s*allowFollowups\)/.test(promptBuilder),
     "[1] VALID MOVES whitelist still gated on allowMoves || allowFollowups");
}

/* --------------------------------------------------------------------- *
 * [2] Fix 2 — completion moves validated before linking (entity-linking).
 * --------------------------------------------------------------------- */
{
  // The Move branch of _renderLink must short-circuit to plain text when the
  // completion move is not rollable.
  ok(/if\s*\(!this\._completionMoveRollable\(entry\.moveName\)\)\s*return\s+escapeHtml\(matchedText\);/.test(entityLinking),
     "[2] _renderLink returns plain text when completion move not rollable");
  // The helper exists.
  ok(/_completionMoveRollable\s*\(\s*moveName\s*\)\s*\{/.test(entityLinking),
     "[2] _completionMoveRollable(moveName) helper defined");
  // It classifies the three completion moves.
  ok(/fulfill \(\?:your\|the\|this\) vow/.test(entityLinking),
     "[2] helper classifies 'fulfill your vow' as vow");
  ok(/end the fight/.test(entityLinking),
     "[2] helper classifies 'end the fight' as combat");
  ok(/reach \(\?:your\|the\|this\) destination/.test(entityLinking),
     "[2] helper classifies 'reach your destination' as journey");
  // Non-completion moves are never gated here (returns true early).
  ok(/if\s*\(!kind\)\s*return\s+true;/.test(entityLinking),
     "[2] helper returns true (no gate) for non-completion moves");
  // It reads live tracks via the active adapter and requires boxes >= 10.
  ok(/getActiveAdapter\(\)/.test(entityLinking) && /getProgressTracks/.test(entityLinking),
     "[2] helper reads live progress tracks via the active adapter");
  ok(/Number\(t\.boxes\s*\?\?\s*0\)\s*>=\s*10/.test(entityLinking),
     "[2] helper requires a matching open track at 10/10 boxes");
  // Combat matches foe-kind tracks too.
  ok(/k\s*===\s*"combat"\s*\|\|\s*k\s*===\s*"foe"/.test(entityLinking),
     "[2] combat completion matches combat OR foe tracks");
  // Fails OPEN — a catch returns true.
  const helperMatch = entityLinking.match(/_completionMoveRollable\s*\(\s*moveName\s*\)\s*\{[\s\S]*?\n {2}\},/);
  ok(helperMatch && /catch\s*\(_\)\s*\{\s*return\s+true;/.test(helperMatch[0]),
     "[2] helper fails OPEN (catch returns true)");
}

/* --------------------------------------------------------------------- *
 * [3] Fix 3 — symmetric 10/10 completion gate covers vow + combat (moves).
 * --------------------------------------------------------------------- */
{
  // strictKind covers journey, vow AND combat.
  ok(/const strictKind\s*=\s*kind === "journey"\s*\|\|\s*kind === "vow"\s*\|\|\s*kind === "combat";/.test(moves),
     "[3] strictKind covers journey || vow || combat");
  // The needed-boxes threshold uses strictKind (full 10), else the floor.
  ok(/const needBoxes\s*=\s*strictKind\s*\?\s*10\s*:\s*minBoxes;/.test(moves),
     "[3] needBoxes is 10 for strictKind, else minBoxes (site floor preserved)");
  // The gate condition uses strictKind and still honours the toggle + force.
  ok(/if\s*\(strictKind\s*&&\s*gateOn\s*&&\s*!opts\.force\s*&&\s*score\s*<\s*needBoxes\)/.test(moves),
     "[3] gate fires on strictKind && gateOn && !opts.force && score < needBoxes");
  // The old journey-ONLY gate is gone.
  ok(!/if\s*\(kind === "journey"\s*&&\s*gateOn\s*&&\s*!opts\.force/.test(moves),
     "[3] old journey-only gate predicate removed");
  // The error message adapts the noun (fight for combat).
  ok(/const noun\s*=\s*kind === "combat"\s*\?\s*"fight"\s*:\s*kind;/.test(moves),
     "[3] error noun is 'fight' for combat, else the kind");
  // The deliberate overrides (CONTRACT setting + force) remain referenced.
  ok(/gateOn/.test(moves) && /opts\.force/.test(moves),
     "[3] enforceJourneyProgressGate toggle (gateOn) and opts.force overrides preserved");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
