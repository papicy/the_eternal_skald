/* =====================================================================
 *  First-run onboarding wizard test for The Eternal Skald (v0.21.0, U4).
 *
 *  The wizard (ApplicationV2) walks a new GM through the four critical
 *  settings. The step navigation, validation and value-collection logic is
 *  pure and exercised directly here. The ApplicationV2 class + DOM wiring are
 *  runtime (Foundry global) and covered by source/wiring guards.
 *
 *    [A] Pure helpers: ordered steps; clamping; first/last detection;
 *        provider key-requirement; per-step validation; value collection
 *        (number coercion, unknown-key rejection); HTML escaping.
 *    [B] Wiring guards: settings.js registers the firstRunComplete flag;
 *        hooks register the wizard menu + auto-launch; en.json i18n keys.
 *    [C] Node-import safety: importing the UI module without a Foundry global
 *        must NOT throw (lazy class).
 *
 *  Run: node test/first-run-wizard.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  WIZARD_STEPS, getStepCount, getStep, clampStep, isFirstRun, providerNeedsKey,
  validateStep, nextStep, prevStep, isLastStep, wizardSettingKeys,
  collectWizardValues, escapeWizHtml
} from "../scripts/ui/first-run-wizard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = (...p) => join(__dirname, "..", ...p);
const read = (...p) => readFileSync(root(...p), "utf8");

const SETTINGS = read("scripts", "core", "settings.js");
const HOOKS    = read("scripts", "hooks", "foundry-hooks.js");
const EN       = JSON.parse(read("lang", "en.json"));

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

console.log("First-run wizard test (v0.21.0, U4)\n");

/* ── [A] Pure helpers ────────────────────────────────────────────── */
// Steps: ordered, four of them, with the expected ids.
eq(getStepCount(), 4, "four wizard steps");
eq(WIZARD_STEPS[0].id, "provider", "step 1 is provider");
eq(WIZARD_STEPS[1].id, "system", "step 2 is system");
eq(WIZARD_STEPS[2].id, "narrative", "step 3 is narrative");
eq(WIZARD_STEPS[3].id, "finish", "step 4 is finish");
ok(WIZARD_STEPS.every(s => s.id && s.title && Array.isArray(s.fields)), "every step well-formed");

// getStep clamps out-of-range indices.
eq(getStep(0).id, "provider", "getStep(0)");
eq(getStep(99).id, "finish", "getStep(99) clamps to last");
eq(getStep(-5).id, "provider", "getStep(-5) clamps to first");

// clampStep
eq(clampStep(2), 2, "clampStep in range");
eq(clampStep(-1), 0, "clampStep below range");
eq(clampStep(10), 3, "clampStep above range");
eq(clampStep(1.9), 1, "clampStep truncates");
eq(clampStep(NaN), 0, "clampStep NaN → 0");

// next/prev/isLast
eq(nextStep(0), 1, "nextStep advances");
eq(nextStep(3), 3, "nextStep clamps at last");
eq(prevStep(3), 2, "prevStep retreats");
eq(prevStep(0), 0, "prevStep clamps at first");
ok(isLastStep(3) && !isLastStep(0), "isLastStep detects final step");

// isFirstRun
ok(isFirstRun(false) === true, "isFirstRun true when flag false");
ok(isFirstRun(undefined) === true, "isFirstRun true when flag unset");
ok(isFirstRun(true) === false, "isFirstRun false when flag true");

// providerNeedsKey
ok(providerNeedsKey("openai"), "openai needs a key");
ok(providerNeedsKey("abacus"), "abacus needs a key");
ok(!providerNeedsKey("ollama"), "ollama (local) needs no key");
ok(!providerNeedsKey("OLLAMA"), "provider check is case-insensitive");

// validateStep
ok(!validateStep("provider", { providerPreset: "openai", apiKey: "" }).ok, "provider step fails without key");
ok(!validateStep("provider", { providerPreset: "openai", apiKey: "   " }).ok, "blank/whitespace key fails");
ok(validateStep("provider", { providerPreset: "openai", apiKey: "sk-123" }).ok, "key present passes");
ok(validateStep("provider", { providerPreset: "ollama", apiKey: "" }).ok, "ollama passes without key");
ok(validateStep("narrative", {}).ok, "non-provider steps always pass");
ok(validateStep("finish", {}).ok, "finish step always passes");

// wizardSettingKeys — dedup, includes the four critical keys, excludes flag
const keys = wizardSettingKeys();
ok(keys.includes("providerPreset") && keys.includes("apiKey"), "wizard owns provider+key");
ok(keys.includes("narrativeTone") && keys.includes("journalingDensity") && keys.includes("intensity"), "wizard owns narrative keys");
ok(keys.includes("ironswornIntegration"), "wizard owns system-integration key");
ok(!keys.includes("firstRunComplete"), "wizard does NOT list the onboarding flag as an editable field");
eq(keys.length, new Set(keys).size, "wizard keys are deduplicated");

// collectWizardValues — number coercion + unknown-key rejection
const collected = collectWizardValues({ providerPreset: "openai", intensity: "8", bogusKey: "x" });
eq(collected.providerPreset, "openai", "collects provider");
eq(collected.intensity, 8, "coerces intensity to number");
ok(!("bogusKey" in collected), "drops unknown keys");
ok(!("apiKey" in collected), "omits keys absent from form data");

// escapeWizHtml
eq(escapeWizHtml('<b>"&\'</b>'), "&lt;b&gt;&quot;&amp;&#39;&lt;/b&gt;", "escapes HTML special chars");
eq(escapeWizHtml(null), "", "escapes null to empty string");

/* ── [B] Wiring guards ───────────────────────────────────────────── */
ok(/register\(MODULE_ID,\s*"firstRunComplete"/.test(SETTINGS), "settings.js registers firstRunComplete flag");
ok(/config:\s*false/.test(SETTINGS), "firstRunComplete is hidden (config:false present)");
ok(/registerMenu\(MODULE_ID,\s*"firstRunWizard"/.test(HOOKS), "hooks register the firstRunWizard menu");
ok(/type:\s*WizardCls/.test(HOOKS), "menu uses the wizard class");
ok(/maybeLaunchFirstRun\(\)/.test(HOOKS), "hooks auto-launch the wizard on ready");
ok(/import\s*\{\s*getWizardClass,\s*maybeLaunchFirstRun\s*\}\s*from\s*"\.\.\/ui\/first-run-wizard\.js"/.test(HOOKS), "hooks import the wizard helpers");
ok(!!EN?.ETERNAL_SKALD?.wizard?.menu?.name, "en.json has wizard.menu.name");
ok(!!EN?.ETERNAL_SKALD?.wizard?.menu?.label, "en.json has wizard.menu.label");
ok(!!EN?.ETERNAL_SKALD?.wizard?.menu?.hint, "en.json has wizard.menu.hint");

/* ── [C] Node-import safety ──────────────────────────────────────── */
ok(typeof validateStep === "function", "UI module imports cleanly under plain Node (no Foundry global)");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
