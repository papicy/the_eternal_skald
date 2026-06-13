/* =====================================================================
 *  Tabbed settings panel test for The Eternal Skald (v0.21.0, S1).
 *
 *  The settings panel (ApplicationV2) groups every registered setting into
 *  four tabs via the pure categorizeSetting / assignSettingsToTabs helpers,
 *  which we exercise directly. The ApplicationV2 class + form I/O are runtime
 *  (Foundry global) and covered by source/wiring guards.
 *
 *    [A] Pure helpers: four tabs with the expected ids; representative key→tab
 *        mappings; totality (every key grouped, unknown→advanced, none lost);
 *        and — drift guard — EVERY setting key registered in settings.js maps
 *        to a valid tab id.
 *    [B] Wiring guards: hooks register the "tabbedSettings" menu with the panel
 *        class + import; en.json carries the menu i18n keys.
 *    [C] Node-import safety: importing the UI module without a Foundry global
 *        must NOT throw (lazy class).
 *
 *  Run: node test/settings-panel.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  SETTINGS_TABS, categorizeSetting, assignSettingsToTabs
} from "../scripts/ui/settings-panel.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = (...p) => join(__dirname, "..", ...p);
const read = (...p) => readFileSync(root(...p), "utf8");

const SETTINGS = read("scripts", "core", "settings.js");
const HOOKS    = read("scripts", "hooks", "foundry-hooks.js");
const EN       = JSON.parse(read("lang", "en.json"));

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

console.log("Tabbed settings panel test (v0.21.0, S1)\n");

/* ── [A] Pure helpers ────────────────────────────────────────────── */
const tabIds = SETTINGS_TABS.map(t => t.id);
eq(JSON.stringify(tabIds), JSON.stringify(["aiProvider", "narrative", "memory", "advanced"]), "four tabs in the expected order");
ok(SETTINGS_TABS.every(t => t.label && t.icon), "each tab has a label and an icon");

// representative mappings
eq(categorizeSetting("apiKey"), "aiProvider", "apiKey → AI Provider");
eq(categorizeSetting("providerPreset"), "aiProvider", "providerPreset → AI Provider");
eq(categorizeSetting("narrativeTone"), "narrative", "narrativeTone → Narrative");
eq(categorizeSetting("autoControlEnemies"), "narrative", "autoControlEnemies → Narrative");
eq(categorizeSetting("ragEnabled"), "memory", "ragEnabled → Memory");
eq(categorizeSetting("autoJournaling"), "memory", "autoJournaling → Memory");
eq(categorizeSetting("debugLogging"), "advanced", "debugLogging → Advanced");
eq(categorizeSetting("totallyUnknownKey"), "advanced", "unknown key → Advanced (fallback)");

// totality: nothing lost, unknown bucketed to advanced
const sample = ["apiKey", "narrativeTone", "ragEnabled", "debugLogging", "brandNewKey"];
const grouped = assignSettingsToTabs(sample);
const regrouped = Object.values(grouped).reduce((n, arr) => n + arr.length, 0);
eq(regrouped, sample.length, "assignSettingsToTabs preserves every key");
ok(grouped.advanced.includes("brandNewKey"), "unknown key grouped into advanced");
ok(Object.keys(grouped).every(k => tabIds.includes(k)), "grouping only uses known tab ids");

// drift guard: every setting registered in settings.js resolves to a valid tab
const registeredKeys = Array.from(SETTINGS.matchAll(/register\(MODULE_ID,\s*"(\w+)"/g)).map(m => m[1]);
ok(registeredKeys.length >= 50, `parsed a plausible number of settings (${registeredKeys.length})`);
const bad = registeredKeys.filter(k => !tabIds.includes(categorizeSetting(k)));
eq(bad.length, 0, `every registered setting maps to a valid tab (offenders: ${bad.join(", ") || "none"})`);

/* ── [B] Wiring guards ───────────────────────────────────────────── */
ok(/registerMenu\(MODULE_ID,\s*"tabbedSettings"/.test(HOOKS), "hooks register the tabbedSettings menu");
ok(/type:\s*PanelCls/.test(HOOKS), "menu uses the settings panel class");
ok(/import\s*\{\s*getSettingsPanelClass\s*\}\s*from\s*"\.\.\/ui\/settings-panel\.js"/.test(HOOKS), "hooks import getSettingsPanelClass");
ok(!!EN?.ETERNAL_SKALD?.settingsPanel?.menu?.name, "en.json has settingsPanel.menu.name");
ok(!!EN?.ETERNAL_SKALD?.settingsPanel?.menu?.label, "en.json has settingsPanel.menu.label");
ok(!!EN?.ETERNAL_SKALD?.settingsPanel?.menu?.hint, "en.json has settingsPanel.menu.hint");

/* ── [C] Node-import safety ──────────────────────────────────────── */
ok(typeof categorizeSetting === "function", "UI module imports cleanly under plain Node (no Foundry global)");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
