/* =====================================================================
 *  THE ETERNAL SKALD — First-Run Onboarding Wizard  (U4 / U1)
 *  ---------------------------------------------------------------------
 *  A guided, multi-step ApplicationV2 form shown ONCE on first activation
 *  to surface the handful of settings that matter most to a new user:
 *    1. AI provider + API key
 *    2. Game-system integration level
 *    3. Narration tone + journaling density + intensity
 *    4. Command tips + (optional) finish
 *
 *  ADDITIVE & NON-DESTRUCTIVE: the wizard only READS/WRITES existing
 *  registered settings through the public game.settings API. It registers
 *  NO settings of its own except the world flag `firstRunComplete` (added
 *  in core/settings.js) that records whether onboarding has run, so it
 *  never nags a returning world. Every step is skippable; the GM can also
 *  re-open it any time from the settings menu ("Show setup wizard").
 *
 *  The ApplicationV2 subclass is built LAZILY (needs the Foundry global) so
 *  importing this file under plain Node (load-smoke) never throws. All the
 *  step/validation logic below is pure and unit-tested.
 * ===================================================================== */

import { MODULE_ID, LOG_PREFIX, SKALD_NAME } from "../core/constants.js";

/** Providers that require an API key (everything but a local Ollama server). */
const KEYLESS_PROVIDERS = Object.freeze(["ollama"]);

/** Ordered step descriptors. `fields` reference EXISTING setting keys only. */
export const WIZARD_STEPS = Object.freeze([
  {
    id: "provider",
    title: "1. AI Provider",
    intro: "Choose where the Skald's intelligence comes from, then paste your API key.",
    fields: [
      { key: "providerPreset", type: "select" },
      { key: "apiKey",         type: "password" }
    ]
  },
  {
    id: "system",
    title: "2. System Integration",
    intro: "Enable deep integration with the Ironsworn rules engine (recommended).",
    fields: [{ key: "ironswornIntegration", type: "boolean" }]
  },
  {
    id: "narrative",
    title: "3. Narrative Voice",
    intro: "Set the tone, how richly the chronicle is kept, and the dramatic intensity.",
    fields: [
      { key: "narrativeTone",    type: "select" },
      { key: "journalingDensity", type: "select" },
      { key: "intensity",        type: "number" }
    ]
  },
  {
    id: "finish",
    title: "4. You're Ready",
    intro: "Type ! in chat to see every command, or !skald-help for a guided tour. Welcome to the saga!",
    fields: []
  }
]);

/** Number of wizard steps. */
export function getStepCount() { return WIZARD_STEPS.length; }

/** Clamp an arbitrary index into the valid step range [0, count-1]. */
export function clampStep(index, count = WIZARD_STEPS.length) {
  const n = Number.isFinite(index) ? Math.trunc(index) : 0;
  if (n < 0) return 0;
  if (n > count - 1) return count - 1;
  return n;
}

/** Fetch a step descriptor by index (clamped). */
export function getStep(index) { return WIZARD_STEPS[clampStep(index)]; }

/** True when onboarding has NOT yet completed (flag is falsy). */
export function isFirstRun(flagValue) { return !flagValue; }

/** Does the given provider preset require an API key? */
export function providerNeedsKey(provider) {
  return !KEYLESS_PROVIDERS.includes(String(provider || "").toLowerCase());
}

/**
 * Validate a single step's collected values.
 * Returns { ok, message }. Only the provider step can fail (missing key for a
 * key-requiring provider); every other step always passes.
 */
export function validateStep(stepId, values = {}) {
  if (stepId === "provider") {
    const provider = values.providerPreset;
    const key = String(values.apiKey ?? "").trim();
    if (providerNeedsKey(provider) && key === "") {
      return { ok: false, message: "This provider needs an API key. Paste one, or pick a local provider (Ollama)." };
    }
  }
  return { ok: true, message: "" };
}

/** Next step index, clamped to the last step. */
export function nextStep(index) { return clampStep(clampStep(index) + 1); }

/** Previous step index, clamped to the first step. */
export function prevStep(index) { return clampStep(clampStep(index) - 1); }

/** True when the given index is the final ("finish") step. */
export function isLastStep(index) { return clampStep(index) === WIZARD_STEPS.length - 1; }

/** All setting keys the wizard manages, deduplicated, in declaration order. */
export function wizardSettingKeys() {
  const keys = [];
  for (const step of WIZARD_STEPS) {
    for (const f of step.fields) if (!keys.includes(f.key)) keys.push(f.key);
  }
  return keys;
}

/**
 * Filter an arbitrary form-data object down to the settings the wizard owns,
 * coercing numbers. Unknown keys are dropped so the wizard can never write a
 * setting outside its scope.
 */
export function collectWizardValues(formData = {}, numberKeys = ["intensity"]) {
  const out = {};
  const owned = wizardSettingKeys();
  for (const key of owned) {
    if (!(key in formData)) continue;
    let v = formData[key];
    if (numberKeys.includes(key)) v = Number(v);
    out[key] = v;
  }
  return out;
}

/* --- Lazy ApplicationV2 subclass ----------------------------------- */
let _WizardClass = null;

export function getWizardClass() {
  if (_WizardClass) return _WizardClass;
  const AppV2 = foundry?.applications?.api?.ApplicationV2;
  if (!AppV2) return null;
  _WizardClass = class SkaldFirstRunWizard extends AppV2 {
    static DEFAULT_OPTIONS = {
      id: "eternal-skald-first-run-wizard",
      tag: "form",
      window: { title: "The Eternal Skald — Setup Wizard", icon: "fas fa-hat-wizard", resizable: true },
      position: { width: 560, height: 560 },
      form: { handler: SkaldFirstRunWizard._onSubmit, closeOnSubmit: true, submitOnChange: false }
    };
    constructor(...args) { super(...args); this._stepIndex = 0; }
    async _renderHTML(_context, _options) {
      const el = document.createElement("div");
      el.className = "eternal-skald-wizard";
      el.innerHTML = renderWizardHtml(this._stepIndex);
      return el;
    }
    _replaceHTML(result, content, _options) { content.replaceChildren(result); }
    _onRender(_context, _options) {
      try { wireWizard(this); } catch (e) {
        console.warn(LOG_PREFIX, "first-run-wizard wiring failed:", e?.message ?? e);
      }
    }
    /** On finish, persist wizard-owned settings + mark onboarding complete. */
    static async _onSubmit(_event, _form, formData) {
      const data = collectWizardValues(formData?.object ?? {});
      let changed = 0;
      for (const [key, next] of Object.entries(data)) {
        try {
          const cfg = game.settings.settings.get(`${MODULE_ID}.${key}`);
          if (!cfg) continue;
          if (cfg.scope === "world" && !game.user?.isGM) continue;
          const cur = game.settings.get(MODULE_ID, key);
          const coerced = (cfg.type === Number) ? Number(next) : next;
          if (cur !== coerced) { await game.settings.set(MODULE_ID, key, coerced); changed++; }
        } catch (e) { console.warn(LOG_PREFIX, `wizard save failed for ${key}:`, e?.message ?? e); }
      }
      try { await game.settings.set(MODULE_ID, "firstRunComplete", true); } catch (_) {}
      try { ui?.notifications?.info(`${SKALD_NAME}: setup complete — ${changed} setting${changed === 1 ? "" : "s"} saved.`); } catch (_) {}
    }
  };
  return _WizardClass;
}

/** Render the inner HTML for a given step index (presentation only). */
function renderWizardHtml(stepIndex) {
  const idx = clampStep(stepIndex);
  const step = WIZARD_STEPS[idx];
  const total = WIZARD_STEPS.length;
  const fieldsHtml = step.fields.map((f) => renderField(f)).join("");
  const backDisabled = idx === 0 ? "disabled" : "";
  const nextLabel = isLastStep(idx) ? "Finish" : "Next ▸";
  return `
    <style>
      .eternal-skald-wizard { padding: 12px 16px; font-size: 14px; }
      .eternal-skald-wizard .esw-progress { color: #b9935a; font-weight: 600; margin-bottom: 4px; }
      .eternal-skald-wizard h2 { border: none; margin: 0 0 6px; }
      .eternal-skald-wizard .esw-intro { opacity: .85; margin-bottom: 12px; }
      .eternal-skald-wizard .esw-field { margin-bottom: 12px; }
      .eternal-skald-wizard label { display: block; font-weight: 600; margin-bottom: 3px; }
      .eternal-skald-wizard .esw-hint { font-size: 12px; opacity: .7; }
      .eternal-skald-wizard .esw-nav { display: flex; justify-content: space-between; margin-top: 16px; }
    </style>
    <div class="esw-progress">Step ${idx + 1} of ${total}</div>
    <h2>${escapeWizHtml(step.title)}</h2>
    <p class="esw-intro">${escapeWizHtml(step.intro)}</p>
    <div class="esw-fields">${fieldsHtml}</div>
    <div class="esw-nav">
      <button type="button" data-esw-action="back" ${backDisabled}>◂ Back</button>
      <button type="${isLastStep(idx) ? "submit" : "button"}" data-esw-action="next">${nextLabel}</button>
    </div>`;
}

/** Render a single settings field from its live registered definition. */
function renderField(field) {
  let cfg = null, value;
  try {
    cfg = game.settings.settings.get(`${MODULE_ID}.${field.key}`);
    value = game.settings.get(MODULE_ID, field.key);
  } catch (_) { /* defensive */ }
  const name = cfg?.name ? escapeWizHtml(cfg.name) : field.key;
  const hint = cfg?.hint ? `<div class="esw-hint">${escapeWizHtml(cfg.hint)}</div>` : "";
  let input = "";
  if (field.type === "select" && cfg?.choices) {
    const opts = Object.entries(cfg.choices).map(([k, lbl]) =>
      `<option value="${escapeWizHtml(k)}" ${k === value ? "selected" : ""}>${escapeWizHtml(lbl)}</option>`).join("");
    input = `<select name="${field.key}">${opts}</select>`;
  } else if (field.type === "boolean") {
    input = `<input type="checkbox" name="${field.key}" ${value ? "checked" : ""}>`;
  } else if (field.type === "number") {
    input = `<input type="number" name="${field.key}" value="${value ?? ""}">`;
  } else if (field.type === "password") {
    input = `<input type="password" name="${field.key}" value="${escapeWizHtml(value ?? "")}" placeholder="sk-...">`;
  } else {
    input = `<input type="text" name="${field.key}" value="${escapeWizHtml(value ?? "")}">`;
  }
  return `<div class="esw-field"><label>${name}</label>${input}${hint}</div>`;
}

/** Minimal HTML-escape for interpolated strings. */
export function escapeWizHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Wire the Back/Next buttons of a live wizard instance (browser-only). */
function wireWizard(app) {
  const root = app.element;
  if (!root) return;
  const back = root.querySelector('[data-esw-action="back"]');
  const next = root.querySelector('[data-esw-action="next"]');
  back?.addEventListener("click", () => { app._stepIndex = prevStep(app._stepIndex); app.render(); });
  next?.addEventListener("click", (ev) => {
    if (isLastStep(app._stepIndex)) return;   // let the submit handler run
    ev.preventDefault();
    const step = WIZARD_STEPS[clampStep(app._stepIndex)];
    const values = readStepValues(root, step);
    const v = validateStep(step.id, values);
    if (!v.ok) { try { ui?.notifications?.warn(v.message); } catch (_) {} return; }
    persistStep(values);
    app._stepIndex = nextStep(app._stepIndex);
    app.render();
  });
}

/** Read the current step's field values from the live DOM. */
function readStepValues(root, step) {
  const out = {};
  for (const f of step.fields) {
    const el = root.querySelector(`[name="${f.key}"]`);
    if (!el) continue;
    out[f.key] = f.type === "boolean" ? el.checked : el.value;
  }
  return out;
}

/** Persist a step's values immediately (so Back/Next never loses input). */
function persistStep(values) {
  const data = collectWizardValues(values);
  for (const [key, next] of Object.entries(data)) {
    try {
      const cfg = game.settings.settings.get(`${MODULE_ID}.${key}`);
      if (!cfg) continue;
      if (cfg.scope === "world" && !game.user?.isGM) continue;
      const coerced = (cfg.type === Number) ? Number(next) : next;
      if (game.settings.get(MODULE_ID, key) !== coerced) game.settings.set(MODULE_ID, key, coerced);
    } catch (_) { /* defensive */ }
  }
}

/** Open the wizard window. Returns true if shown. */
export function openFirstRunWizard() {
  const Cls = getWizardClass();
  if (!Cls) return false;
  try { new Cls().render(true); return true; }
  catch (e) { console.warn(LOG_PREFIX, "openFirstRunWizard failed:", e?.message ?? e); return false; }
}

/**
 * Launch the wizard automatically on first run. Only the GM (who can write
 * world settings) is prompted, and only when AI Mode is on and the
 * firstRunComplete flag is unset. Safe no-op otherwise.
 */
export function maybeLaunchFirstRun() {
  try {
    if (!game.user?.isGM) return false;
    if (!isFirstRun(game.settings.get(MODULE_ID, "firstRunComplete"))) return false;
    if (!game.settings.get(MODULE_ID, "aiMode")) return false;
    return openFirstRunWizard();
  } catch (_) { return false; }
}
