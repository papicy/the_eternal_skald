/* =====================================================================
 *  TOOL RUNNER  (v0.22.0, Phase E — F5)
 *
 *  The narrative-layer "safe execution middleware" for AI function-calling.
 *  The ai/ layer (client + tools/) decides WHAT a model wants to do and
 *  validates the payload; this module is where those validated tool calls are
 *  actually RUN, because it is the only side allowed to touch the active
 *  system adapter (capability-gated writes) and the chronicle JournalSystem.
 *
 *  Flow (runToolTurn):
 *    1. Hard gate on the `autonomousTools` world setting (default OFF). If the
 *       GM hasn't opted in, this returns { ran:false } and nothing is offered
 *       to the model — so the Skald never mutates the world unexpectedly.
 *    2. Offer ONLY the tools the active system can honour (buildToolSpecs is
 *       filtered by the live adapter capabilities).
 *    3. Ask the model (Client.chatWithTools), parse + validate any tool_calls,
 *       and execute each through capability-gated adapter / chronicle methods.
 *
 *  Every handler is defensive: a missing capability, a missing character, or a
 *  write that the adapter declines is returned as a soft { ok:false } result,
 *  never an exception that breaks narration.
 * ===================================================================== */

import { Settings } from "../core/settings.js";
import { Client } from "../ai/client.js";
import { getActiveAdapter } from "../systems/registry.js";
import { JournalSystem } from "../chronicle/journal-system.js";
import { buildToolSpecs } from "../ai/tools/registry.js";
import { parseToolCalls, executeToolCalls } from "../ai/tools/executor.js";

/** Resolve the active character via the adapter's own priority logic. */
function activeActor(adapter) {
  try { return adapter?.getActiveCharacter?.() ?? null; }
  catch (_) { return null; }
}

/**
 * Build the live handler map binding each logical tool to a capability-gated
 * adapter / chronicle method. Foundry writes happen ONLY here.
 * @returns {Object<string, (args:object)=>Promise<any>>}
 */
export function buildHandlers() {
  return {
    async rollMove(args) {
      const adapter = getActiveAdapter();
      if (!adapter?.capabilities?.().moves) return { ok: false, error: "moves not supported" };
      const actor = activeActor(adapter);
      const res = await adapter.triggerMove?.(args.move, { actor, stat: args.stat });
      return res ?? { ok: false, error: "no result" };
    },
    async queryOracle(args) {
      const adapter = getActiveAdapter();
      if (!adapter?.capabilities?.().oracles) return { ok: false, error: "oracles not supported" };
      const res = await adapter.rollOracle?.(args.oracle);
      return res ?? { ok: false, error: "no oracle result" };
    },
    async updateProgress(args) {
      const adapter = getActiveAdapter();
      if (!adapter?.capabilities?.().progressTracks) return { ok: false, error: "progress tracks not supported" };
      const actor = activeActor(adapter);
      if (!actor) return { ok: false, error: "no active character" };
      if (args.action === "set") {
        return (await adapter.setProgress?.(actor, args.track, Number(args.value) || 0)) ?? { ok: false };
      }
      return (await adapter.markProgress?.(actor, args.track, Number(args.value) || 1)) ?? { ok: false };
    },
    async createJournalEntry(args) {
      if (!JournalSystem.canWrite?.()) return { ok: false, error: "no write permission" };
      const folder = await JournalSystem.getOrCreateFolder?.("discovery").catch(() => null);
      const name = String(args.title || "Untitled").slice(0, 100);
      const entry = await JournalEntry.create({
        name,
        folder: folder?.id ?? null,
        ownership: JournalSystem._ownership?.(),
        pages: [{ name, type: "text", text: { content: String(args.content || ""), format: 1 } }],
        flags: { "the-eternal-skald": { type: "discovery", createdBy: "ai-tool", lastUpdated: Date.now() } }
      });
      return entry ? { ok: true, id: entry.id, name } : { ok: false, error: "create failed" };
    }
  };
}

/**
 * Run one tool-calling turn. Returns { ran:false } when autonomous tools are
 * disabled or no tools apply. Otherwise returns the model's content plus the
 * executed tool-call results. Never throws.
 *
 * @param {Array<{role:string, content:string}>} messages
 * @param {object} [opts] - forwarded to Client.chatWithTools.
 * @returns {Promise<{ran:boolean, content?:(string|null), calls?:Array, results?:Array}>}
 */
export async function runToolTurn(messages, opts = {}) {
  if (Settings.get("autonomousTools") !== true) return { ran: false };
  const adapter = getActiveAdapter();
  const caps = (() => { try { return adapter?.capabilities?.() || {}; } catch (_) { return {}; } })();
  const specs = buildToolSpecs(caps);
  if (specs.length === 0) return { ran: false };
  let resp;
  try { resp = await Client.chatWithTools(messages, specs, opts); }
  catch (e) { return { ran: false, error: String(e?.message || e) }; }
  const calls = parseToolCalls({ tool_calls: resp.toolCalls });
  const results = await executeToolCalls(calls, buildHandlers());
  return { ran: true, content: resp.content, calls, results };
}
