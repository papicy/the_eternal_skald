/* =====================================================================
 *  NPC roleplay mode test for The Eternal Skald (v0.20.0, F4).
 *
 *  !roleplay <name> switches the Skald into an in-character NPC voice until
 *  !roleplay off. RoleplayMode owns the (in-memory) state + the pure
 *  persona-task builder, which we exercise directly; the command handler
 *  and the skald() interception are covered by source/wiring guards.
 *
 *    [A] Behavioural proof of RoleplayMode: starts inactive (default off),
 *        start/stop/current/dossier semantics, defensive empty input, and
 *        the pure buildPersonaTask() output (in-character, dossier-seeded,
 *        no-mechanics directive, graceful no-dossier fallback).
 *    [B] Cross-file wiring guards: command token, registry descriptor, the
 *        command handler, the skald() roleplay interception, GM-whispered
 *        dossier, and the import.
 *
 *  Run: node test/roleplay-mode.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RoleplayMode } from "../scripts/narrative/roleplay-mode.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = (...p) => join(__dirname, "..", ...p);
const read = (...p) => readFileSync(root(...p), "utf8");

const CONSTANTS = read("scripts", "core", "constants.js");
const REGISTRY  = read("scripts", "chat", "command-registry.js");
const COMMANDS  = read("scripts", "chat", "commands.js");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

console.log("NPC roleplay mode test (v0.20.0, F4)\n");

/* ── [A] RoleplayMode behaviour ──────────────────────────────────── */
// Default OFF on load — no behaviour change until explicitly entered.
ok(!RoleplayMode.isActive(), "[A1] roleplay starts inactive (default off)");
eq(RoleplayMode.current(), null, "[A2] current() is null when inactive");
eq(RoleplayMode.dossier(), "", "[A3] dossier() is '' when inactive");

// start() activates and stores name + dossier.
ok(RoleplayMode.start("Captain Reeves", "A weary harbourmaster who guards a secret."),
   "[A4] start() returns true and activates the mode");
ok(RoleplayMode.isActive(), "[A5] isActive() true after start");
eq(RoleplayMode.current(), "Captain Reeves", "[A6] current() reports the active NPC");
ok(RoleplayMode.dossier().includes("harbourmaster"), "[A7] dossier() returns the stored text");

// Empty/whitespace name is rejected (defensive).
ok(!RoleplayMode.start("   "), "[A8] start() rejects a blank name");
ok(RoleplayMode.isActive() && RoleplayMode.current() === "Captain Reeves",
   "[A9] a rejected start does not disturb the current persona");

// buildPersonaTask is pure + dossier-seeded.
const task = RoleplayMode.buildPersonaTask("Captain Reeves", "Guards a smuggling secret.");
ok(/ROLEPLAY MODE/.test(task), "[A10] persona task declares ROLEPLAY MODE");
ok(task.includes("Captain Reeves"), "[A11] persona task names the NPC");
ok(/first person/i.test(task) && /in-character/i.test(task),
   "[A12] persona task instructs first-person, in-character speech");
ok(/dice|rules|mechanics/i.test(task), "[A13] persona task forbids surfacing game mechanics");
ok(task.includes("smuggling secret"), "[A14] persona task injects the dossier");

// No-dossier path gives a graceful improvisation instruction (never throws).
const bare = RoleplayMode.buildPersonaTask("Stranger");
ok(/improvise/i.test(bare) && bare.includes("Stranger"),
   "[A15] no-dossier persona task falls back to a consistent-improv instruction");

// stop() clears everything and returns the prior name.
eq(RoleplayMode.stop(), "Captain Reeves", "[A16] stop() returns the name we were playing");
ok(!RoleplayMode.isActive() && RoleplayMode.current() === null && RoleplayMode.dossier() === "",
   "[A17] stop() fully resets the mode");

/* ── [B] Cross-file wiring guards ────────────────────────────────── */
ok(/ROLEPLAY:\s*"!roleplay"/.test(CONSTANTS),
   "[B1] constants.js defines the !roleplay command token");
ok(/ROLEPLAY[\s\S]*?method:\s*"roleplay"[\s\S]*?permission:\s*"all"/.test(REGISTRY),
   "[B2] the registry maps the command to roleplay (permission 'all')");
ok(/async\s+roleplay\s*\(/.test(COMMANDS),
   "[B3] commands.js implements the roleplay handler");
ok(/import\s*\{\s*RoleplayMode\s*\}\s*from\s*"\.\.\/narrative\/roleplay-mode\.js"/.test(COMMANDS),
   "[B4] commands.js imports RoleplayMode");
// skald() intercepts when roleplay is active and routes in-character.
ok(/if\s*\(\s*RoleplayMode\.isActive\(\)\s*\)/.test(COMMANDS),
   "[B5] skald() intercepts active roleplay before move/token handling");
ok(/runConversation\(\s*"roleplay"/.test(COMMANDS),
   "[B6] the interception routes through a dedicated 'roleplay' channel");
ok(/RoleplayMode\.buildPersonaTask\(/.test(COMMANDS),
   "[B7] the interception builds the persona task");
// The dossier is whispered to the GM only.
ok(/GM eyes only[\s\S]*?gmWhisper:\s*true/.test(COMMANDS) ||
   /dossier[\s\S]{0,200}gmWhisper:\s*true/i.test(COMMANDS),
   "[B8] the NPC dossier is whispered to the GM only");
// The roleplay channel must NOT be ingested into the chronicle as canon.
ok(!/\["skald",\s*"scene",\s*"combat",\s*"roleplay"\]/.test(read("scripts", "eternal-skald.js")),
   "[B9] the roleplay channel is not added to the journal-ingest channel list");

/* ── summary ─────────────────────────────────────────────────────── */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
