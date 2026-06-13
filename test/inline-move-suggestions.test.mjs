/* =====================================================================
 *  Inline move-suggestion test for The Eternal Skald (v0.10.10).
 *
 *  Verifies the v0.10.10 refactor that moves suggested-move presentation
 *  OUT of separate "A Move Beckons" / "What Comes Next" cards and INTO the
 *  Skald's narration prose, where the entity-linker turns each move name
 *  into an inline clickable link.
 *
 *  Two kinds of checks:
 *   [A] A genuine behavioural test of the REAL `stripDirectivesForDisplay`
 *       function — extracted verbatim from scripts/eternal-skald.js and
 *       evaluated — proving any stray [[MOVE:…]] directive never leaks into
 *       the displayed narration (so the prose stays clean while the inline
 *       link carries the click).
 *   [B] Structural guards over scripts/eternal-skald.js asserting the
 *       refactor invariants: the separate suggestion-card functions are
 *       gone, the prompts instruct prose-weaving (never directive emission),
 *       and the inline `link-move` path still rolls through the progress-
 *       aware controller.
 *
 *  Run: node test/inline-move-suggestions.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readSkaldSource } from "./_skald-source.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// (Phase 2 refactor) The monolith was decomposed into scripts/<subsystem>/*.js
// modules. These source-text guards scan the whole refactored tree via the
// shared reader so relocated definitions are still seen wherever they live.
const SRC = readSkaldSource();

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

/* --------------------------------------------------------------------- *
 * Extract a top-level `function NAME(...) { ... }` from the source by
 * brace-matching, so we can evaluate the REAL implementation in isolation.
 * --------------------------------------------------------------------- */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in source`);
  // Find the opening brace of the body.
  let i = src.indexOf("{", start);
  if (i === -1) throw new Error(`opening brace for ${name} not found`);
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return src.slice(start, i);
}

/* ===================================================================== *
 * [A] Behavioural: the real stripDirectivesForDisplay never leaks a move
 *     directive into displayed prose.
 * ===================================================================== */
console.log("[A] stripDirectivesForDisplay — strips stray directives from displayed narration");

const stripSrc = extractFunction(SRC, "stripDirectivesForDisplay");
// eslint-disable-next-line no-new-func
const stripDirectivesForDisplay = new Function(`${stripSrc}; return stripDirectivesForDisplay;`)();

{
  // A complete trailing move directive is removed; the prose survives.
  const out = stripDirectivesForDisplay(
    "The bridge groans beneath you. [[MOVE: Face Danger | Iron | cross before it falls]]"
  );
  ok(!/\[\[MOVE/i.test(out), "complete [[MOVE:…]] directive removed from display");
  ok(out.includes("The bridge groans beneath you."), "narrative prose is preserved");
}
{
  // A partial directive still streaming at the very end is removed.
  const out = stripDirectivesForDisplay("You steel yourself to Face Danger [[MOV");
  ok(!/\[\[MOV/i.test(out), "partial trailing [[MOV directive removed");
  ok(out.includes("You steel yourself to Face Danger"), "prose before partial directive preserved");
}
{
  // Multiple directives (an old-style follow-up pair) are all removed.
  const out = stripDirectivesForDisplay(
    "The foe reels.\n[[MOVE: Strike | Iron | press the advantage]]\n[[MOVE: Clash | Iron | trade blows]]"
  );
  eq((out.match(/\[\[MOVE/gi) || []).length, 0, "all stray follow-up directives removed");
  ok(out.includes("The foe reels."), "outcome prose preserved when directives stripped");
}
{
  // Effect directives are also stripped (unchanged behaviour, sanity).
  const out = stripDirectivesForDisplay("You take a wound. [[EFFECT: harm 1]]");
  ok(!/\[\[EFFECT/i.test(out), "effect directive still stripped from display");
}
{
  // Prose with NO directive and a move named inline is left intact — the
  // entity-linker (not this function) is what turns the name into a link.
  const prose = "Only iron will see you through — you must Face Danger now.";
  eq(stripDirectivesForDisplay(prose), prose, "prose naming a move inline is left untouched");
}

/* ===================================================================== *
 * [B] Structural guards over the refactored source.
 * ===================================================================== */
console.log("[B] structural — separate suggestion cards removed, prompts weave moves into prose");

// B1: the separate card-posting functions/helper are gone.
ok(!/\bpostSuggestionCard\s*\(/.test(SRC) && !/postSuggestionCard\s*\(suggestion\)/.test(SRC),
  "postSuggestionCard removed (no definition or call)");
ok(!/postFollowupSuggestionCard/.test(SRC),
  "postFollowupSuggestionCard removed (no definition or call)");
ok(!/_inlineMoveLink/.test(SRC),
  "_inlineMoveLink helper removed");

// B2: the old separate-card copy strings are gone.
ok(!/The path forward:/.test(SRC), "pre-roll 'The path forward:' card text removed");
ok(!/The saga calls you onward/.test(SRC), "post-roll 'The saga calls you onward' card text removed");
ok(!/es-inline-suggest/.test(SRC), "es-inline-suggest suggestion-bubble markup removed");

// B3: prompts instruct weaving moves into prose, NOT emitting directives.
ok(/WEAVE IT INTO YOUR PROSE/.test(SRC), "pre-roll prompt instructs weaving the move into prose");
ok(/WEAVE FOLLOW-UP MOVES INTO YOUR CLOSING PROSE/.test(SRC),
  "post-roll prompt instructs weaving follow-up moves into prose");
ok(!/EXACTLY ONE suggestion directive/.test(SRC),
  "pre-roll prompt no longer asks for a [[MOVE:…]] directive");
ok(!/follow-up move directives/.test(SRC),
  "post-roll prompt no longer asks for follow-up [[MOVE:…]] directives");
ok(!/suggest the appropriate Ironsworn move and stat using the \[\[MOVE/.test(SRC),
  "!skald task no longer instructs the [[MOVE:…]] directive");

// B4: the inline link-move handler still rolls through the progress-aware
//     triggerMove path (so progress moves work when clicked). Phase 3 routed
//     this through the active system adapter — `sys().triggerMove` — which for
//     a foundry-ironsworn world resolves to the very same IronswornController
//     method, so the behavioural contract is unchanged.
ok(/action === "link-move"/.test(SRC), "inline 'link-move' click handler present");
const linkMoveIdx = SRC.indexOf('action === "link-move"');
const linkMoveBlock = SRC.slice(linkMoveIdx, linkMoveIdx + 1500);
ok(/(?:sys\(\)|IronswornController)\.triggerMove/.test(linkMoveBlock),
  "clicking an inline move link routes through the active adapter's triggerMove");

// B5: the renderer still emits a clickable link-move anchor for move names.
ok(/data-skald-action="link-move"/.test(SRC) && /data-es-kind="move"/.test(SRC),
  "entity-linker renders move names as clickable inline link-move anchors");

/* --------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
