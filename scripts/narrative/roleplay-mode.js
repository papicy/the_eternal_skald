/* =====================================================================
 *  NPC roleplay mode for The Eternal Skald (v0.20.0, F4).
 *
 *  Holds the (in-memory, session-scoped) state for "!roleplay <name>":
 *  while active, the Skald speaks IN CHARACTER as the named NPC until the
 *  GM/player exits with "!roleplay off". The persona-task builder is a pure
 *  function so it is unit-testable without a Foundry runtime.
 *
 *  Default OFF — the flag starts inactive on every load, so this changes no
 *  behaviour until someone explicitly enters roleplay. Pure ESM, no deps.
 * ===================================================================== */

export const RoleplayMode = {
  /** @type {string|null} active NPC display name, or null when off. */
  _name: null,
  /** @type {string} the NPC dossier text injected into the persona prompt. */
  _dossier: "",

  /** Is a roleplay persona currently active? */
  isActive() { return typeof this._name === "string" && this._name.length > 0; },

  /** The active NPC's display name (or null). */
  current() { return this._name; },

  /** The active NPC's dossier text (or ""). */
  dossier() { return this._dossier || ""; },

  /**
   * Enter roleplay as `name`, optionally seeded with a chronicle `dossier`.
   * @param {string} name
   * @param {string} [dossier]
   * @returns {boolean} true when the mode became active.
   */
  start(name, dossier = "") {
    const n = String(name ?? "").trim();
    if (!n) return false;
    this._name = n;
    this._dossier = String(dossier ?? "").trim();
    return true;
  },

  /** Leave roleplay mode. Returns the name we were playing (or null). */
  stop() {
    const was = this._name;
    this._name = null;
    this._dossier = "";
    return was;
  },

  /**
   * Build the system-prompt TASK that makes the AI answer fully in-character
   * as the NPC. Pure + defensive. The AI is told to stay consistent with the
   * dossier and may be evasive about secrets, but must never break character
   * or surface game mechanics.
   *
   * @param {string} name
   * @param {string} [dossier]
   * @returns {string}
   */
  buildPersonaTask(name, dossier = "") {
    const n = String(name ?? "the character").trim() || "the character";
    const d = String(dossier ?? "").trim();
    return [
      `ROLEPLAY MODE: You ARE the non-player character "${n}". Respond ONLY in first person, in-character as ${n} — their voice, manner, knowledge and speech patterns.`,
      `Do NOT break character, do NOT narrate as the Skald, and do NOT mention dice, rules or game mechanics. You may be guarded or evasive about secrets, but never contradict what is known below.`,
      d ? `WHAT IS KNOWN OF ${n} (your dossier — keep secrets as ${n} would):\n${d}`
        : `Little is recorded of ${n}; improvise a consistent, believable personality and keep it stable across the conversation.`
    ].join("\n\n");
  }
};
