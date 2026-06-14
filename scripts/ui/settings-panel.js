/* =====================================================================
 *  THE ETERNAL SKALD — Tabbed Settings Panel  (S1 / U1)
 *  ---------------------------------------------------------------------
 *  A custom ApplicationV2 settings window that groups the module's 60+
 *  registered settings into four tabs — AI Provider, Narrative, Memory,
 *  Advanced — for far easier navigation than the flat native list.
 *
 *  ADDITIVE & NON-DESTRUCTIVE (brief): this panel is purely an ALTERNATE
 *  editor. Every setting keeps `config: true`, so Foundry's native flat
 *  list still works exactly as before. We register NO new settings and
 *  RENAME/REMOVE none — the panel reads each setting's existing registered
 *  definition (game.settings.settings) and reads/writes via the public
 *  game.settings API. Unknown / future setting keys fall back to the
 *  "Advanced" tab automatically, so the panel can never hide a setting.
 *
 *  UI LAYER NOTE (brief §5): presentation only — no AI calls, no command
 *  dispatch. It writes settings solely through the public game.settings.set
 *  API (the same path the native panel uses) and only for keys the current
 *  user is permitted to change.
 *
 *  The ApplicationV2 subclass is built LAZILY (needs the Foundry global) so
 *  importing this file under plain Node (load-smoke) never throws.
 * ===================================================================== */

import { MODULE_ID, LOG_PREFIX, SKALD_NAME } from "../core/constants.js";

/** The four tabs, in display order. `labelKey`/`icon` drive the tab strip. */
export const SETTINGS_TABS = Object.freeze([
  { id: "aiProvider", icon: "fas fa-plug",    label: "AI Provider" },
  { id: "narrative",  icon: "fas fa-feather", label: "Narrative" },
  { id: "memory",     icon: "fas fa-book",    label: "Memory" },
  { id: "advanced",   icon: "fas fa-gears",   label: "Advanced" }
]);

const TAB_IDS = Object.freeze(SETTINGS_TABS.map((t) => t.id));

/* Explicit setting-key → tab mapping. Anything absent falls back to "advanced".
 * (gate 2026-06-14 — settings menu tidy) Every user-visible (config:true)
 * setting is mapped here so none silently lands in "Advanced": added the TTS
 * controls + autonomousTools (narrative), the narration/embed RAG controls and
 * the AI-compendium-context toggles (memory). Hidden storage settings
 * (config:false: timelineEvents, linkStyles, ragEmbedModelActive,
 * firstRunComplete) are intentionally NOT listed — the panel only renders
 * config:true keys, so mapping them would be dead code. */
const TAB_OF = Object.freeze({
  // --- AI Provider / connection ---
  aiMode: "aiProvider", providerPreset: "aiProvider", apiKey: "aiProvider",
  modelName: "aiProvider", apiEndpoint: "aiProvider", connectionMode: "aiProvider",
  streamingEnabled: "aiProvider", requestTimeout: "aiProvider",
  // --- Narrative / mechanics / vision flavour ---
  intensity: "narrative", narrativeTone: "narrative", narrativeToneCustom: "narrative",
  narrationDelay: "narrative", suggestMoves: "narrative", autoNarrateMoves: "narrative",
  autoNarrateCombat: "narrative", autoNarrateXp: "narrative", contextSuggestions: "narrative",
  ironswornIntegration: "narrative", interceptMoveDeclarations: "narrative",
  intelligentMoveDetection: "narrative", intelligentMoveConfirm: "narrative",
  assetBonusAdvisory: "narrative", aiJourneyNaming: "narrative",
  enforceJourneyProgressGate: "narrative", journeyMinProgressBoxes: "narrative",
  awardXpOnCompletion: "narrative", weakHitHalfXp: "narrative", aiAppliesEffects: "narrative",
  showEffectAnnouncements: "narrative", aiModifiesSheet: "narrative", aiCreatesContent: "narrative",
  autoControlEnemies: "narrative", autoCreateCombatTracks: "narrative",
  autoCloseStaleCombatTracks: "narrative", defaultEnemyRank: "narrative",
  tokenControlEnabled: "narrative", tokenControlAiTriggers: "narrative", tokenMoveDuration: "narrative",
  autoAnalyzeScenes: "narrative", visionModel: "narrative", mapAnalysisQuality: "narrative",
  maxMapResolution: "narrative", imageFormat: "narrative",
  autonomousTools: "narrative",
  // Text-to-speech narration (client-scoped).
  ttsEnabled: "narrative", ttsAutoNarrate: "narrative", ttsRate: "narrative", ttsVoice: "narrative",
  // --- Memory / chronicle / journaling ---
  ragEnabled: "memory", ragIndexCompendiums: "memory", ragContextTokens: "memory",
  ragMaxResults: "memory", ragAutoIndex: "memory", ragSimilarityThreshold: "memory",
  ragDebugMode: "memory", memoryLength: "memory", autoJournaling: "memory",
  journalNotifications: "memory", journalPermissions: "memory", sessionAutoSummary: "memory",
  journalingDensity: "memory", metadataBackfill: "memory", journalEditMode: "memory",
  recapObsidianFormat: "memory", sessionAutoMinutes: "memory",
  contradictionDetection: "memory", entityLinking: "memory", customLinkStyles: "memory",
  // Selectable embedding model + narration-indexing controls.
  ragEmbedModel: "memory", ragIndexNarration: "memory", ragNarrationSources: "memory",
  ragNarrationIncludeEmotes: "memory", ragNarrationMinChars: "memory",
  ragNarrationMaxRecords: "memory", ragUseAnnIndex: "memory",
  // AI compendium context (name catalogues injected into the prompt for grounding).
  contextMoves: "memory", contextDelveMoves: "memory", contextAssets: "memory",
  contextTruths: "memory", contextDomains: "memory", contextThemes: "memory", contextFoes: "memory",
  // --- Advanced / debug ---
  debugLogging: "advanced", loggingLevel: "advanced"
});

/** PURE: resolve a setting key to its tab id (fallback "advanced"). */
export function categorizeSetting(key) {
  return TAB_OF[key] || "advanced";
}

/**
 * PURE: group setting keys into the four tabs, preserving input order within
 * each tab. Unknown keys land in "advanced" so nothing is ever hidden.
 * @param {Iterable<string>} keys
 * @returns {Record<string,string[]>}
 */
export function assignSettingsToTabs(keys) {
  const out = {};
  for (const id of TAB_IDS) out[id] = [];
  for (const k of keys) out[categorizeSetting(k)].push(k);
  return out;
}

/** Minimal HTML escaper for values/labels rendered into the form. */
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* --- Runtime helpers (need the Foundry global) --------------------- */

/** Collect this module's user-visible (config:true) setting keys, grouped by tab. */
function collectGroupedSettings() {
  const keys = [];
  try {
    for (const [fullKey, cfg] of game.settings.settings.entries()) {
      if (!fullKey.startsWith(`${MODULE_ID}.`)) continue;
      if (cfg?.config !== true) continue;            // skip hidden/storage settings
      keys.push(fullKey.slice(MODULE_ID.length + 1));
    }
  } catch (e) { console.warn(LOG_PREFIX, "collectGroupedSettings failed:", e?.message ?? e); }
  return assignSettingsToTabs(keys);
}

/** Render one setting's form control + label, reading its registered definition. */
function renderField(key) {
  let cfg, value, editable = true;
  try {
    cfg = game.settings.settings.get(`${MODULE_ID}.${key}`) || {};
    value = game.settings.get(MODULE_ID, key);
    if (cfg.scope === "world" && !game.user?.isGM) editable = false;
  } catch (_) { cfg = {}; }
  const name = esc(cfg.name || key);
  const hint = cfg.hint ? `<p class="notes">${esc(cfg.hint)}</p>` : "";
  const dis = editable ? "" : "disabled";
  let control;
  if (cfg.choices && typeof cfg.choices === "object") {
    const opts = Object.entries(cfg.choices)
      .map(([v, lbl]) => `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(lbl)}</option>`)
      .join("");
    control = `<select name="${esc(key)}" ${dis}>${opts}</select>`;
  } else if (cfg.type === Boolean) {
    control = `<input type="checkbox" name="${esc(key)}" ${value ? "checked" : ""} ${dis}/>`;
  } else if (cfg.type === Number) {
    const r = cfg.range || {};
    const rangeAttrs = `${r.min != null ? `min="${esc(r.min)}"` : ""} ${r.max != null ? `max="${esc(r.max)}"` : ""} ${r.step != null ? `step="${esc(r.step)}"` : ""}`;
    control = `<input type="number" name="${esc(key)}" value="${esc(value)}" ${rangeAttrs} ${dis}/>`;
  } else {
    const t = key.toLowerCase().includes("key") ? "password" : "text";
    control = `<input type="${t}" name="${esc(key)}" value="${esc(value)}" ${dis}/>`;
  }
  return `<div class="form-group es-set-field"><label>${name}</label><div class="form-fields">${control}</div>${hint}</div>`;
}

/** Render the whole tabbed body. */
function renderPanelHtml() {
  const grouped = collectGroupedSettings();
  const strip = SETTINGS_TABS.map((t, i) =>
    `<a class="es-set-tab ${i === 0 ? "active" : ""}" data-tab="${t.id}"><i class="${t.icon}"></i> ${esc(t.label)}</a>`
  ).join("");
  const panes = SETTINGS_TABS.map((t, i) => {
    const fields = (grouped[t.id] || []).map(renderField).join("");
    const body = fields || `<p class="notes">No settings in this category.</p>`;
    return `<section class="es-set-pane ${i === 0 ? "active" : ""}" data-tab="${t.id}">${body}</section>`;
  }).join("");
  return `<style>
    #eternal-skald-settings-panel .window-content{display:flex;flex-direction:column;min-height:0;}
    .eternal-skald-settings{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;}
    .eternal-skald-settings .es-set-strip{display:flex;gap:.25rem;border-bottom:1px solid #0003;margin-bottom:.5rem;flex-wrap:wrap;flex:0 0 auto;}
    .eternal-skald-settings .es-set-tab{padding:.35rem .6rem;cursor:pointer;border:1px solid transparent;border-bottom:none;border-radius:4px 4px 0 0;}
    .eternal-skald-settings .es-set-tab.active{background:#0001;border-color:#0003;font-weight:bold;}
    .eternal-skald-settings .es-set-pane{display:none;overflow:auto;min-height:0;}
    .eternal-skald-settings .es-set-pane.active{display:block;flex:1 1 auto;}
    .eternal-skald-settings .es-set-field{margin:.4rem 0;}
    .eternal-skald-settings .es-set-field .notes{font-size:.85em;opacity:.8;margin:.15rem 0 0;}
    .eternal-skald-settings .es-set-footer{display:flex;justify-content:flex-end;margin-top:.5rem;flex:0 0 auto;}
  </style>
  <div class="es-set-strip">${strip}</div>
  ${panes}
  <footer class="es-set-footer"><button type="submit"><i class="fas fa-save"></i> Save Changes</button></footer>`;
}

/** Wire the tab strip (show/hide panes). */
function wireTabs(root) {
  if (!root) return;
  const tabs = Array.from(root.querySelectorAll(".es-set-tab"));
  const panes = Array.from(root.querySelectorAll(".es-set-pane"));
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const id = tab.dataset.tab;
      for (const t of tabs) t.classList.toggle("active", t.dataset.tab === id);
      for (const p of panes) p.classList.toggle("active", p.dataset.tab === id);
    });
  }
}

/* --- Lazy ApplicationV2 subclass ----------------------------------- */
let _PanelClass = null;

export function getSettingsPanelClass() {
  if (_PanelClass) return _PanelClass;
  const AppV2 = foundry?.applications?.api?.ApplicationV2;
  if (!AppV2) return null;
  _PanelClass = class SkaldSettingsPanel extends AppV2 {
    static DEFAULT_OPTIONS = {
      id: "eternal-skald-settings-panel",
      tag: "form",
      window: { title: "The Eternal Skald — Settings", icon: "fas fa-sliders", resizable: true },
      position: { width: 640, height: 680 },
      form: { handler: SkaldSettingsPanel._onSubmit, closeOnSubmit: true, submitOnChange: false }
    };
    async _renderHTML(_context, _options) {
      const el = document.createElement("div");
      el.className = "eternal-skald-settings";
      el.innerHTML = renderPanelHtml();
      return el;
    }
    _replaceHTML(result, content, _options) { content.replaceChildren(result); }
    _onRender(_context, _options) {
      try { wireTabs(this.element); } catch (e) {
        console.warn(LOG_PREFIX, "settings-panel tab wiring failed:", e?.message ?? e);
      }
    }
    /** Persist only changed, user-editable settings via the public API. */
    static async _onSubmit(_event, _form, formData) {
      const data = formData?.object ?? {};
      let changed = 0;
      for (const [key, next] of Object.entries(data)) {
        try {
          const cfg = game.settings.settings.get(`${MODULE_ID}.${key}`);
          if (!cfg) continue;
          if (cfg.scope === "world" && !game.user?.isGM) continue;   // not permitted
          const cur = game.settings.get(MODULE_ID, key);
          const coerced = (cfg.type === Number) ? Number(next) : next;
          if (cur !== coerced) { await game.settings.set(MODULE_ID, key, coerced); changed++; }
        } catch (e) { console.warn(LOG_PREFIX, `settings save failed for ${key}:`, e?.message ?? e); }
      }
      try { ui?.notifications?.info(`${SKALD_NAME}: ${changed} setting${changed === 1 ? "" : "s"} updated.`); } catch (_) {}
    }
  };
  return _PanelClass;
}

/** Open the tabbed settings panel. Returns true if shown. */
export function openSettingsPanel() {
  const Cls = getSettingsPanelClass();
  if (!Cls) return false;
  try { new Cls().render(true); return true; }
  catch (e) { console.warn(LOG_PREFIX, "openSettingsPanel failed:", e?.message ?? e); return false; }
}
