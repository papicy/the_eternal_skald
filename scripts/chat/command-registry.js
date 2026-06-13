/* =====================================================================
 *  COMMAND REGISTRY  (v0.20.0, M2)
 *
 *  A declarative table of every "!"-prefixed Skald command. It replaces the
 *  hand-maintained switch that used to live inside dispatchCommand() with a
 *  single source of truth that each command "self-registers" into, carrying:
 *
 *    • command     — the canonical token (from COMMANDS in constants.js)
 *    • aliases      — alternate tokens that route to the same handler
 *    • method       — the Commands.<method> name to invoke (args passed through)
 *    • permission   — "all" (default) or "gm"; see note below
 *    • help         — one-line description (metadata for tooling / future help)
 *
 *  DESIGN NOTES (smallest-safe-change):
 *    • The handler bodies themselves are unchanged — they still live on the
 *      Commands object in commands.js. The registry only owns the ROUTING and
 *      METADATA, so behaviour is identical to the previous switch.
 *    • permission is enforced at dispatch ONLY for "gm" entries. Every command
 *      that existed before M2 is "all" (it was never dispatch-gated; GM-only
 *      handlers self-gate internally exactly as before), so this is a no-op for
 *      existing behaviour while giving new commands a declarative GM gate.
 *    • Pure ESM, no Foundry imports — safe to unit-test directly.
 * ===================================================================== */

import { COMMANDS } from "../core/constants.js";

/**
 * @typedef {Object} CommandDescriptor
 * @property {string}   command     Canonical "!"-token.
 * @property {string[]} aliases     Alternate tokens routing to the same method.
 * @property {string}   method      Commands.<method> to invoke with (args).
 * @property {"all"|"gm"} permission Dispatch-level permission gate.
 * @property {string}   help        One-line description.
 */

/** @type {ReadonlyArray<CommandDescriptor>} */
export const COMMAND_REGISTRY = Object.freeze([
  { command: COMMANDS.HELP,        aliases: [],                                          method: "help",          permission: "all", help: "Show the Skald command help card." },
  { command: COMMANDS.COMMANDS_REF, aliases: [],                                         method: "commandReference", permission: "all", help: "Open the interactive, searchable command reference." },
  { command: COMMANDS.SKALD,       aliases: [],                                          method: "skald",         permission: "all", help: "Speak with the Skald (explicit form)." },
  { command: COMMANDS.ORACLE,      aliases: [],                                          method: "oracle",        permission: "all", help: "Roll an Ironsworn oracle and interpret it." },
  { command: COMMANDS.NPC,         aliases: [],                                          method: "npc",           permission: "all", help: "Conjure or roleplay an NPC." },
  { command: COMMANDS.ROLEPLAY,    aliases: [],                                          method: "roleplay",      permission: "all", help: "Speak in-character as an NPC (!roleplay <name> / off)." },
  { command: COMMANDS.SCENE,       aliases: [],                                          method: "scene",         permission: "all", help: "Generate a scene / location description." },
  { command: COMMANDS.LORE,        aliases: [],                                          method: "lore",          permission: "all", help: "Generate world-building lore." },
  { command: COMMANDS.COMBAT,      aliases: [],                                          method: "combat",        permission: "all", help: "Tactical narration / advice for the current fight." },
  { command: COMMANDS.PROGRESS,    aliases: [],                                          method: "progress",      permission: "all", help: "Review or advance a journey track." },
  { command: COMMANDS.JOURNAL,     aliases: [COMMANDS.JOURNALS],                          method: "journals",      permission: "all", help: "List or open the campaign journals." },
  { command: COMMANDS.MYSTERIES,   aliases: [],                                          method: "mysteries",     permission: "all", help: "List unresolved mysteries / open threads." },
  { command: COMMANDS.REMIND,      aliases: [],                                          method: "remind",        permission: "all", help: "Recall what has happened so far." },
  { command: COMMANDS.END_SESSION, aliases: [],                                          method: "endSession",    permission: "all", help: "Wrap up and summarise the session." },
  { command: COMMANDS.SESSION_RECAP, aliases: [],                                        method: "sessionRecap",  permission: "all", help: "Generate a session recap and download it as Markdown." },
  { command: COMMANDS.REINDEX,     aliases: [],                                          method: "reindex",       permission: "all", help: "Rebuild the AI memory (RAG) index." },
  { command: COMMANDS.REINDEX_COMPENDIUMS, aliases: [],                                  method: "reindexCompendiums", permission: "gm", help: "Embed installed compendium packs into AI memory (GM)." },
  { command: COMMANDS.RAG_STATUS,  aliases: [],                                          method: "ragStatus",     permission: "all", help: "Show AI memory (RAG) status." },
  { command: COMMANDS.TIMELINE,    aliases: [],                                          method: "timeline",      permission: "all", help: "Show / edit the campaign timeline." },
  { command: COMMANDS.RELATIONSHIPS, aliases: [COMMANDS.MAP],                             method: "relationships", permission: "all", help: "Show the relationship map." },
  { command: COMMANDS.TEMPLATE,    aliases: [],                                          method: "template",      permission: "all", help: "Manage journal templates." },
  { command: COMMANDS.LINK_STYLE,  aliases: [],                                          method: "linkStyle",     permission: "all", help: "Configure entity link styling." },
  { command: COMMANDS.RESET,       aliases: [COMMANDS.WIPE],                              method: "reset",         permission: "all", help: "Reset / wipe Skald data (GM)." },
  { command: COMMANDS.SCOUT,       aliases: [COMMANDS.SURVEY, COMMANDS.ANALYZE_MAP],     method: "scout",         permission: "all", help: "Analyse the current map / scene (GM)." },
  { command: COMMANDS.JOURNAL_REWRITE, aliases: [],                                      method: "journalRewrite", permission: "all", help: "Rewrite a journal entry." },
  { command: COMMANDS.JOURNAL_AMEND,   aliases: [],                                      method: "journalAmend",   permission: "all", help: "Amend / append to a journal entry." }
]);

/**
 * Resolve a command token (canonical or alias) to its descriptor.
 * @param {string} head Lower-cased "!"-token from dispatchCommand.
 * @returns {CommandDescriptor|null}
 */
export function findCommand(head) {
  if (!head || typeof head !== "string") return null;
  const token = head.toLowerCase();
  for (const desc of COMMAND_REGISTRY) {
    if (desc.command === token) return desc;
    if (desc.aliases.includes(token)) return desc;
  }
  return null;
}
