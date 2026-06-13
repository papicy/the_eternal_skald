/* =====================================================================
 *  AI TOOL REGISTRY  (v0.22.0, Phase E — F5)
 *
 *  A declarative, PURE table of the function-calling "tools" the Skald may
 *  expose to an OpenAI-compatible model. It is modelled directly on
 *  scripts/chat/command-registry.js: one frozen source of truth that carries,
 *  per tool:
 *
 *    • name        — the function name sent to the model (snake/camel token)
 *    • description — natural-language summary the model uses to choose a tool
 *    • parameters  — a JSON-Schema object describing the call arguments
 *    • capability  — the SYSTEM_CAPABILITIES key that must be true for this
 *                    tool to be offered (null = always available)
 *    • handler     — the logical handler name the EXECUTOR routes to (the
 *                    actual Foundry-writing work lives in the narrative layer,
 *                    NOT here — this module performs NO writes and imports
 *                    nothing from Foundry)
 *
 *  DESIGN NOTES (§5 boundary):
 *    • This file is pure ESM with zero Foundry / chronicle / adapter imports,
 *      so it is trivially unit-testable and never touches game state.
 *    • buildToolSpecs() turns the registry into the OpenAI `tools` array,
 *      filtered by the live adapter capabilities so a model is only ever
 *      offered tools the active system can actually honour.
 * ===================================================================== */

/**
 * @typedef {Object} ToolDescriptor
 * @property {string}      name        Function name advertised to the model.
 * @property {string}      description One-line natural-language summary.
 * @property {object}      parameters  JSON-Schema for the arguments object.
 * @property {string|null} capability  SYSTEM_CAPABILITIES gate (null = always).
 * @property {string}      handler     Logical handler the executor dispatches to.
 */

/** @type {ReadonlyArray<ToolDescriptor>} */
export const TOOL_REGISTRY = Object.freeze([
  Object.freeze({
    name: "rollMove",
    description: "Roll a named Ironsworn/Starforged move for the active character " +
      "(e.g. \"Face Danger\", \"Secure an Advantage\"). Use only when the fiction " +
      "clearly calls for a mechanical move resolution.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        move: { type: "string", description: "The exact move name to roll." },
        stat: { type: "string", description: "Optional stat/approach to roll with (e.g. edge, heart, iron)." }
      },
      required: ["move"]
    }),
    capability: "moves",
    handler: "rollMove"
  }),
  Object.freeze({
    name: "queryOracle",
    description: "Roll a named oracle table and return the result, to inspire an " +
      "unexpected detail, name, or twist in the fiction.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        oracle: { type: "string", description: "The oracle table name to roll on." }
      },
      required: ["oracle"]
    }),
    capability: "oracles",
    handler: "queryOracle"
  }),
  Object.freeze({
    name: "updateProgress",
    description: "Mark or set progress on an existing progress track (vow, journey, " +
      "or combat) for the active character.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        track:  { type: "string", description: "The progress track name to update." },
        action: { type: "string", enum: ["mark", "set"], description: "mark = advance by one rank-step; set = set absolute boxes." },
        value:  { type: "number", description: "For action=set, the number of filled boxes (0-10)." }
      },
      required: ["track"]
    }),
    capability: "progressTracks",
    handler: "updateProgress"
  }),
  Object.freeze({
    name: "createJournalEntry",
    description: "Record a chronicle journal entry (a scene, lore note, or session " +
      "memory) so it persists in the campaign's living history.",
    parameters: Object.freeze({
      type: "object",
      properties: {
        title:   { type: "string", description: "Short journal entry title." },
        content: { type: "string", description: "The journal entry body (plain text or simple HTML)." }
      },
      required: ["title", "content"]
    }),
    // Journals are not adapter-gated — the chronicle layer always supports them.
    capability: null,
    handler: "createJournalEntry"
  })
]);

/**
 * Resolve a tool descriptor by the function name the model emitted.
 * @param {string} name
 * @returns {ToolDescriptor|null}
 */
export function findTool(name) {
  if (!name || typeof name !== "string") return null;
  return TOOL_REGISTRY.find(t => t.name === name) || null;
}

/**
 * Build the OpenAI-compatible `tools` array, offering ONLY the tools whose
 * capability gate is satisfied by the supplied live capabilities object.
 *
 * @param {object} [caps] - a SYSTEM_CAPABILITIES-shaped object (truthy keys).
 * @returns {Array<{type:"function", function:{name:string, description:string, parameters:object}}>}
 */
export function buildToolSpecs(caps = {}) {
  const safeCaps = (caps && typeof caps === "object") ? caps : {};
  return TOOL_REGISTRY
    .filter(t => t.capability === null || safeCaps[t.capability] === true)
    .map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));
}
