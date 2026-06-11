import { DEFAULT_ENDPOINT, LEGACY_ABACUS_ENDPOINT, LOG_PREFIX, MODULE_ID } from "../core/constants.js";
import { Settings } from "../core/settings.js";
import { buildModelChoices } from "../core/model-catalogue.js";

/**
 * (v0.10.31) Re-populate the AI Model and Vision Model <select> dropdowns in an
 * open Settings Config form to match the AI Provider currently chosen *in that
 * form* (not yet saved), and keep them in sync live as the provider is changed.
 *
 * This is what makes the dropdowns FILTER by provider: Foundry computes a
 * setting's `choices` once at registration, so we rebuild the option lists on
 * render and bind a `change` listener to the provider <select>. Fully
 * defensive — any failure leaves the statically-registered choices intact.
 *
 * @param {HTMLElement|jQuery} root - the rendered settings form element
 */
export function refreshModelDropdowns(root) {
  try {
    const el = root?.[0] ?? root;                       // accept jQuery or HTMLElement
    if (!el || !el.querySelector) return;
    const q = (sel) => el.querySelector(sel);
    const providerSel = q(`[name="${MODULE_ID}.providerPreset"]`);
    const modelSel    = q(`[name="${MODULE_ID}.modelName"]`);
    const visionSel   = q(`[name="${MODULE_ID}.visionModel"]`);
    if (!providerSel && !modelSel && !visionSel) return;

    const rebuild = () => {
      const preset = providerSel?.value || Settings.get("providerPreset") || "abacus";
      if (modelSel) {
        const cur = modelSel.value || Settings.get("modelName");
        populateSelect(modelSel, buildModelChoices(preset, cur), cur);
      }
      if (visionSel) {
        const cur = visionSel.value || Settings.get("visionModel");
        populateSelect(visionSel, buildModelChoices(preset, cur, { includeInherit: true }), cur);
      }
    };

    rebuild();
    if (providerSel && !providerSel.dataset.skaldBound) {
      providerSel.dataset.skaldBound = "1";
      providerSel.addEventListener("change", rebuild);
    }
  } catch (e) {
    console.warn(LOG_PREFIX, "refreshModelDropdowns failed:", e?.message || e);
  }
}

/**
 * (v0.10.31) Replace the <option>s of a <select> with `choices` (value→label),
 * preserving `selectedValue` if present (added as a temporary option if the
 * value is not among the choices, so a custom selection is never lost).
 * @param {HTMLSelectElement} sel
 * @param {Record<string,string>} choices
 * @param {string} selectedValue
 */
export function populateSelect(sel, choices, selectedValue) {
  if (!sel || sel.tagName !== "SELECT") return;
  const want = (selectedValue == null ? "" : String(selectedValue));
  const keys = Object.keys(choices);
  sel.innerHTML = "";
  for (const value of keys) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = choices[value];
    sel.appendChild(opt);
  }
  if (want && !keys.includes(want)) {
    const opt = document.createElement("option");
    opt.value = want;
    opt.textContent = `${want} (current)`;
    sel.insertBefore(opt, sel.firstChild);
  }
  if (want) sel.value = want;
}

/**
 * (v0.9.3) Backwards-compatible auto-migration for the broken Abacus AI
 * endpoint that shipped as the v0.9.2 default.
 *
 * v0.9.2 set the Abacus AI preset / default endpoint to the non-functional
 * `https://api.abacus.ai/v0/chat/completions` ({@link LEGACY_ABACUS_ENDPOINT}).
 * Any world that was created or saved under v0.9.2 will have that bad URL
 * persisted in its `apiEndpoint` world setting, which would keep failing even
 * after this patched module loads. To keep those installs working without any
 * manual intervention, this helper detects the exact legacy value and quietly
 * rewrites it to the corrected {@link DEFAULT_ENDPOINT}
 * (`https://routellm.abacus.ai/v1/chat/completions`).
 *
 * Fully defensive — never throws, never blocks startup:
 *   - Only the GM can persist a world-scoped setting, so non-GM clients bail.
 *   - We migrate *only* the exact legacy URL; any user who deliberately typed
 *     a different/custom endpoint is left completely untouched.
 *   - All work is wrapped in try/catch and failures are logged, not surfaced.
 *
 * @returns {Promise<void>}
 */
export async function migrateLegacyAbacusEndpoint() {
  try {
    // Only a GM can write the world-scoped `apiEndpoint` setting.
    if (!game.user?.isGM) return;

    const current = Settings.get("apiEndpoint");
    // Migrate only the exact, known-bad v0.9.2 default — nothing else.
    if (current !== LEGACY_ABACUS_ENDPOINT) return;

    await game.settings.set(MODULE_ID, "apiEndpoint", DEFAULT_ENDPOINT);
    console.log(
      LOG_PREFIX,
      `(v0.9.3) Migrated legacy Abacus AI endpoint ${LEGACY_ABACUS_ENDPOINT} → ${DEFAULT_ENDPOINT}`
    );
    try {
      ui.notifications?.info(
        game.i18n.localize("ETERNAL_SKALD.notifications.abacusEndpointMigrated")
      );
    } catch (_) { /* notification is best-effort */ }
  } catch (e) {
    console.warn(LOG_PREFIX, "migrateLegacyAbacusEndpoint failed:", e?.message || e);
  }
}
