/* =====================================================================
 *  AI TOOL EXECUTOR  (v0.22.0, Phase E — F5)
 *
 *  PURE validation + dispatch glue for model-emitted tool calls. This module
 *  performs NO Foundry writes itself — it would violate the §5 ai/ boundary.
 *  Instead it:
 *
 *    1. parseToolCalls(message) — normalises the OpenAI `tool_calls` array off
 *       an assistant message into a tidy [{id, name, args}] list (JSON args
 *       are parsed defensively; malformed args become {}).
 *    2. validateToolCall(name, args) — checks the tool exists and that every
 *       required JSON-Schema property is present and of a plausible type.
 *    3. executeToolCalls(calls, handlers) — routes each VALID call to an
 *       injected handler function (handlers.rollMove, .queryOracle,
 *       .updateProgress, .createJournalEntry). The narrative/ layer supplies
 *       those handlers, which are the ones allowed to touch the active adapter
 *       and the chronicle JournalSystem. The ai/ layer thus never writes to
 *       Foundry — it only decides WHAT should run and validates the payload.
 * ===================================================================== */

import { findTool } from "./registry.js";

/**
 * Normalise the `tool_calls` array from an assistant message into a flat list.
 * Tolerates the two shapes seen in the wild: the OpenAI
 * {id, function:{name, arguments}} form (arguments is a JSON string) and a
 * pre-parsed {name, args} form.
 *
 * @param {object} message - an assistant message object (may be undefined).
 * @returns {Array<{id:string, name:string, args:object}>}
 */
export function parseToolCalls(message) {
  const raw = message?.tool_calls;
  if (!Array.isArray(raw)) return [];
  return raw.map((tc, i) => {
    const fn = tc?.function || {};
    const name = fn.name ?? tc?.name ?? "";
    let args = fn.arguments ?? tc?.args ?? {};
    if (typeof args === "string") {
      try { args = JSON.parse(args || "{}"); }
      catch (_) { args = {}; }
    }
    if (!args || typeof args !== "object") args = {};
    return { id: tc?.id || `call_${i}`, name: String(name || ""), args };
  });
}

/**
 * Validate a single tool call against its registry JSON-Schema.
 * Lightweight: presence of required keys + a basic typeof check. Never throws.
 *
 * @param {string} name
 * @param {object} args
 * @returns {{ok:boolean, errors:string[], tool:(object|null)}}
 */
export function validateToolCall(name, args = {}) {
  const tool = findTool(name);
  if (!tool) return { ok: false, errors: [`unknown tool "${name}"`], tool: null };

  const a = (args && typeof args === "object") ? args : {};
  const props = tool.parameters?.properties || {};
  const required = Array.isArray(tool.parameters?.required) ? tool.parameters.required : [];
  const errors = [];

  for (const key of required) {
    if (a[key] === undefined || a[key] === null || a[key] === "") {
      errors.push(`missing required argument "${key}"`);
    }
  }
  for (const [key, val] of Object.entries(a)) {
    const schema = props[key];
    if (!schema) continue; // tolerate extra args
    if (schema.type === "number" && typeof val !== "number") {
      errors.push(`argument "${key}" must be a number`);
    } else if (schema.type === "string" && typeof val !== "string") {
      errors.push(`argument "${key}" must be a string`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(val)) {
      errors.push(`argument "${key}" must be one of: ${schema.enum.join(", ")}`);
    }
  }
  return { ok: errors.length === 0, errors, tool };
}

/**
 * Execute a list of normalised tool calls by routing each to an injected
 * handler. Returns one result descriptor per call so the caller can feed
 * tool-result messages back to the model. NEVER throws — a handler error or a
 * validation failure is captured as { ok:false, error } on that call's result.
 *
 * @param {Array<{id:string, name:string, args:object}>} calls
 * @param {Object<string, (args:object)=>Promise<any>>} handlers
 * @returns {Promise<Array<{id:string, name:string, ok:boolean, result?:any, error?:string}>>}
 */
export async function executeToolCalls(calls, handlers = {}) {
  if (!Array.isArray(calls) || calls.length === 0) return [];
  const out = [];
  for (const call of calls) {
    const { ok, errors, tool } = validateToolCall(call.name, call.args);
    if (!ok) {
      out.push({ id: call.id, name: call.name, ok: false, error: errors.join("; ") });
      continue;
    }
    const handler = handlers?.[tool.handler];
    if (typeof handler !== "function") {
      out.push({ id: call.id, name: call.name, ok: false, error: `no handler bound for "${tool.handler}"` });
      continue;
    }
    try {
      const result = await handler(call.args);
      out.push({ id: call.id, name: call.name, ok: true, result });
    } catch (e) {
      out.push({ id: call.id, name: call.name, ok: false, error: String(e?.message || e) });
    }
  }
  return out;
}
