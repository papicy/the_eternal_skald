/* =====================================================================
 *  PROMPT LOADER  (v0.20.0, M4)
 *
 *  A tiny, build-free templating layer for externalised prompt text. The
 *  Skald's large static prompt blocks now live as plain-text templates under
 *  /prompts/*.mjs (default-export strings). This loader imports them through
 *  the normal ESM graph — so they load in the browser with NO build step and
 *  NO async fetch (keeping buildSystemPrompt fully synchronous) — and renders
 *  {{variable}} placeholders.
 *
 *  Why .mjs string modules (not .txt + fetch): buildSystemPrompt() is sync and
 *  the module has no bundler. Static ESM imports are resolved by the browser
 *  automatically and are available synchronously once the graph has loaded,
 *  whereas fetch() would force every prompt build to become async. Editors can
 *  still treat the template body as plain text.
 *
 *  Pure ESM, no Foundry imports — directly unit-testable.
 * ===================================================================== */

import PERSONA from "../../prompts/persona.mjs";
import RULES_DIGEST from "../../prompts/rules-digest.mjs";
import GUIDANCE from "../../prompts/guidance.mjs";

/** Registry of named prompt templates (raw, with {{placeholders}}). */
export const PROMPTS = Object.freeze({
  persona: PERSONA,
  rulesDigest: RULES_DIGEST,
  guidance: GUIDANCE
});

/**
 * Substitute {{name}} placeholders in a template string.
 * Unknown / null / undefined values render as "" (fail-soft); a non-string
 * template yields "". Never throws.
 * @param {string} template
 * @param {Record<string, any>} [vars]
 * @returns {string}
 */
export function renderTemplate(template, vars = {}) {
  if (typeof template !== "string") return "";
  const lookup = (vars && typeof vars === "object") ? vars : {};
  return template.replace(/\{\{\s*([\w.$]+)\s*\}\}/g, (_, key) => {
    const v = lookup[key];
    return (v === null || v === undefined) ? "" : String(v);
  });
}

/**
 * Fetch a named prompt template, optionally interpolating {{variables}}.
 * Returns "" for an unknown name (fail-soft). When no vars are supplied the
 * raw template is returned verbatim.
 * @param {string} name  Key into PROMPTS.
 * @param {Record<string, any>} [vars]
 * @returns {string}
 */
export function getPrompt(name, vars) {
  const tpl = PROMPTS[name];
  if (typeof tpl !== "string") return "";
  return (vars && typeof vars === "object" && Object.keys(vars).length)
    ? renderTemplate(tpl, vars)
    : tpl;
}
