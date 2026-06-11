/* =====================================================================
 *  THE ETERNAL SKALD v0.10.30 — Foundry VTT v14 Module (Client)
 *  ---------------------------------------------------------------------
 *  An AI-powered storytelling and combat-control assistant for Ironsworn
 *  and Ironsworn: Delve campaigns. Powered by Abacus AI ChatLLM.
 *
 *  v0.5.0 adds Browser-Based RAG (AI Memory): the Skald embeds its journal
 *  entries into a local IndexedDB vector store (via transformers.js) and
 *  recalls the most semantically relevant world memory before answering.
 *  See scripts/browser-rag.js. Degrades gracefully — the AI always works
 *  even when the embedding model can't load.
 *
 *  ARCHITECTURE (v0.3.3)
 *  ---------------------
 *  API calls are made SERVER-SIDE by eternal-skald-server.mjs, which
 *  must be loaded via `node --import ...eternal-skald-server.mjs`.
 *  That hook exposes /skald-api/chat on Foundry's own HTTP port.
 *  This client simply does `fetch("/skald-api/chat", ...)` — same
 *  origin, no CORS, no proxy, no mixed-content. Works everywhere.
 *
 *  Sections:
 *      §1  CONSTANTS & IMPORTS
 *      §2  MODULE SETTINGS
 *      §3  SYSTEM PROMPT BUILDER
 *      §4  API CLIENT (simple fetch to /skald-api/chat)
 *      §5  CONVERSATION MEMORY
 *      §6  CHAT MESSAGE HELPERS
 *      §7  COMMAND HANDLERS
 *      §8  NPC DIALOGUE SYSTEM
 *      §9  ORACLE INTERPRETER
 *      §10 JOURNAL / LORE GENERATOR
 *      §11 ENEMY COMBAT CONTROLLER
 *      §12 SCENE CONTEXT
 *      §13 HOOK REGISTRATIONS
 * ===================================================================== */

console.log("=== The Eternal Skald v0.6.0 — module file loaded ===");

import { IronswornData } from "./ironsworn-data.js";
import { IronswornController } from "./ironsworn-controller.js";
import { BrowserRAG } from "./browser-rag.js";

console.log("The Eternal Skald | ironsworn-data.js imported successfully");
console.log("The Eternal Skald | ironsworn-controller.js imported successfully");
console.log("The Eternal Skald | browser-rag.js imported successfully");

/* ===================================================================== */
/*  §1  CONSTANTS                                                         */
/* ===================================================================== */

import {
  MODULE_ID, SKALD_NAME, LOG_PREFIX,
  DEFAULT_ENDPOINT, DEFAULT_MODEL, LEGACY_ABACUS_ENDPOINT,
  PROVIDER_PRESETS, OPENROUTER_VISION_MODELS, ABACUS_VISION_MODELS,
  PROVIDER_LABELS, COMMANDS
} from "./core/constants.js";



/* ===================================================================== */


import {
  buildModelChoices, fetchOpenRouterVisionModels, isCatalogueVisionModel
} from "./core/model-catalogue.js";

import { refreshModelDropdowns, migrateLegacyAbacusEndpoint } from "./ai/providers.js";
import { Client } from "./ai/client.js";
import { buildSystemPrompt, buildJournalPromptBlock, buildIronswornPromptBlock } from "./ai/prompt-builder.js";





import { Settings } from "./core/settings.js";



/* ===================================================================== */
/*  §3  SYSTEM PROMPT BUILDER                                             */
/* ===================================================================== */



/**
 * Thin host-side bridge to the Browser RAG module (v0.5.0). Centralises the
 * "fetch relevant world memory for this query" call so every AI call site
 * can opt in with one line, while keeping all failure handling in one place.
 * ALWAYS resolves to a string ("" when RAG is off, not ready, or errors) so
 * narration never blocks or breaks on memory retrieval.
 */
const RagBridge = {
  /**
   * Retrieve a "RELEVANT WORLD MEMORY" prompt block for a query.
   * @param {string} queryText - the player's prompt / move / scene seed.
   * @returns {Promise<string>}
   */
  async fetchMemory(queryText) {
    try {
      if (!BrowserRAG?.isAvailable?.()) return "";
      const q = String(queryText || "").trim();
      if (!q) return "";
      return await BrowserRAG.buildContextBlock(q);
    } catch (e) {
      console.warn(LOG_PREFIX, "[RAG] fetchMemory failed (continuing without memory):", e?.message || e);
      return "";
    }
  },

  /** Fire-and-forget: embed a freshly written/updated journal entry. */
  indexEntry(entry) {
    try {
      if (!entry || !BrowserRAG?.isAvailable?.() || !BrowserRAG.autoIndex()) return;
      BrowserRAG.indexJournalEntry(entry).catch(() => {});
    } catch (_) {}
  }
};

/**
 * Lore contradiction detector (v0.9.0).
 *
 * When enabled, newly-narrated facts are quietly compared against the Skald's
 * established semantic memory (Browser RAG). If a new fact appears to conflict
 * with recorded lore, a private GM-only alert card is posted so the GM can
 * reconcile the chronicle. Nothing is ever changed automatically.
 *
 * Design constraints (carried from earlier versions):
 *   • Fire-and-forget — NEVER blocks or breaks narration / ingestion.
 *   • Opt-in (off by default) — it costs one extra background AI call.
 *   • GM-host-gated — only the active GM runs the check, so a multi-client
 *     table never double-posts.
 *   • Defensive — every failure path degrades silently.
 */
const ContradictionDetector = {
  /** True iff the feature is switched on. */
  enabled() {
    try { return Settings.get("contradictionDetection") === true; }
    catch (_) { return false; }
  },

  /** Only the active GM runs the check (avoids duplicate alerts). */
  _isHost() {
    try {
      if (!game.user?.isGM) return false;
      const activeGM = game.users?.activeGM;
      if (activeGM && activeGM.id !== game.user.id) return false;
      return true;
    } catch (_) { return false; }
  },

  /**
   * Check a parsed metadata object's `facts` against established lore.
   * Fire-and-forget: callers should NOT await this. (v0.9.0)
   * @param {object} metadata
   */
  async check(metadata) {
    try {
      if (!this.enabled() || !this._isHost()) return;
      if (!BrowserRAG?.isAvailable?.()) return;

      const facts = Array.isArray(metadata?.facts)
        ? metadata.facts.filter(f => typeof f === "string" && f.trim()).slice(0, 8)
        : [];
      if (!facts.length) return;

      // Retrieve the most relevant established lore for these facts.
      const loreById = new Map();
      for (const fact of facts) {
        let hits = [];
        try { hits = await BrowserRAG.search(fact, { maxResults: 4 }); } catch (_) { hits = []; }
        for (const h of (hits || [])) {
          const text = String(h?.text || "").trim();
          if (text) loreById.set(h.id ?? text, text);
        }
      }
      if (!loreById.size) return; // nothing established yet to contradict

      const lore = [...loreById.values()].slice(0, 12)
        .map(t => `- ${t.slice(0, 400)}`).join("\n");
      const newFacts = facts.map(f => `- ${f}`).join("\n");

      const task =
`Compare the NEW facts against the ESTABLISHED lore from an Ironsworn campaign chronicle. ` +
`Flag ONLY genuine contradictions — a new fact that cannot both be true alongside established lore. ` +
`Ignore mere additions, elaborations, new characters, or harmless new detail.\n\n` +
`Respond with EXACTLY one of:\n` +
`• "NONE" (a single word) if there is no real contradiction.\n` +
`• Otherwise one line per conflict, formatted: "CONFLICT: <new fact> ⟂ <established lore> — <short why>"\n\n` +
`ESTABLISHED LORE:\n${lore}\n\nNEW FACTS:\n${newFacts}`;

      let verdict = "";
      try {
        verdict = await Client.chat([
          { role: "system", content: "You are a precise, terse continuity checker for a tabletop campaign. Only flag true contradictions; when in doubt, answer NONE." },
          { role: "user", content: task }
        ], { temperature: 0.1, maxTokens: 400 });
      } catch (e) {
        // AI unreachable — skip silently (continuity check is best-effort).
        console.warn(LOG_PREFIX, "[contradiction] AI check skipped:", e?.message || e);
        return;
      }

      verdict = String(verdict || "").trim();
      if (!verdict || /^none\b/i.test(verdict)) return;

      const conflicts = verdict.split(/\n+/)
        .map(l => l.trim())
        .filter(l => /^CONFLICT\s*:/i.test(l))
        .map(l => l.replace(/^CONFLICT\s*:\s*/i, "").trim())
        .filter(Boolean);
      if (!conflicts.length) return;

      const items = conflicts.map(c => `<li>${escapeHtml(c)}</li>`).join("");
      const body =
        `<p><strong>⚠ Possible lore contradiction.</strong> The latest narration may conflict with what the chronicle already holds:</p>` +
        `<ul class="es-contradiction-list">${items}</ul>` +
        `<p class="es-help-aside"><em>Nothing has been changed — review and reconcile as you see fit. Disable in <strong>Module Settings → The Eternal Skald</strong>.</em></p>`;
      await Chat.postSkald(body, { variant: "lore", title: "The Chronicle Frowns", gmWhisper: true });
    } catch (e) {
      console.warn(LOG_PREFIX, "contradiction check failed:", e?.message || e);
    }
  }
};

/**
 * A small bottom-right progress card for long RAG operations (model
 * download + bulk reindex). Reuses the journal-toast host styling, with an
 * inner determinate progress bar. All DOM access is defensive so headless
 * environments simply no-op. (v0.5.0)
 */
export const RagProgress = {
  _el: null,

  _host() {
    let host = document.getElementById("es-journal-toasts");
    if (!host) {
      host = document.createElement("div");
      host.id = "es-journal-toasts";
      document.body.appendChild(host);
    }
    return host;
  },

  /** Show (or reset) the progress card with an initial label. */
  show(label) {
    try {
      this.hide();
      const el = document.createElement("div");
      el.className = "es-journal-toast es-rag-progress";
      el.innerHTML =
        `<span class="es-jt-icon">🧠</span>` +
        `<span class="es-jt-text"><span class="es-rag-label">${escapeHtml(label || "Working…")}</span>` +
        `<span class="es-rag-bar"><span class="es-rag-bar-fill" style="width:0%"></span></span></span>`;
      this._host().appendChild(el);
      requestAnimationFrame(() => el.classList.add("es-jt-show"));
      this._el = el;
    } catch (_) { this._el = null; }
  },

  /** Update label and (optional) percentage [0–100]. */
  update(label, pct) {
    try {
      if (!this._el) return;
      const lab = this._el.querySelector(".es-rag-label");
      const fill = this._el.querySelector(".es-rag-bar-fill");
      if (lab && label) lab.textContent = label;
      if (fill && typeof pct === "number") fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    } catch (_) {}
  },

  /** Finish successfully — show a final message, then fade out. */
  done(label) { this._finish(label, 2200); },

  /** Finish with an error tint. */
  fail(label) {
    try { this._el?.classList.add("es-rag-fail"); } catch (_) {}
    this._finish(label, 3000);
  },

  _finish(label, after) {
    try {
      if (this._el) {
        const lab = this._el.querySelector(".es-rag-label");
        const fill = this._el.querySelector(".es-rag-bar-fill");
        if (lab && label) lab.textContent = label;
        if (fill) fill.style.width = "100%";
      }
    } catch (_) {}
    setTimeout(() => this.hide(), after);
  },

  hide() {
    try {
      const el = this._el;
      if (!el) return;
      el.classList.remove("es-jt-show");
      setTimeout(() => { try { el.remove(); } catch (_) {} }, 400);
      this._el = null;
    } catch (_) { this._el = null; }
  }
};




/* ===================================================================== */
/*  §4  API CLIENT                                                         */
/* ===================================================================== */


/* ===================================================================== */
/*  §5  CONVERSATION MEMORY                                               */
/* ===================================================================== */

import { Memory, Chat, escapeHtml, formatMarkdown, stripDirectivesForDisplay, parseMetadata, callSkaldStreaming } from "./chat/display.js";
import { Commands, extractMessageText, stripHtml, tryCommandFromText } from "./chat/commands.js";

/* ===================================================================== */
/*  §6  CHAT MESSAGE HELPERS                                              */
/* ===================================================================== */


/* ===================================================================== */
/*  §6a-b  ENTITY LINKING (v0.5.1)                                        */
/* ===================================================================== */

/**
 * Turns plain entity names the Skald narrates into clickable links.
 *
 * Several sources are cross-referenced:
 *   1. The Living Chronicle — auto-scribed NPC / location / discovery
 *      Journal Entries. Matches become Foundry content links
 *      (`@UUID[JournalEntry.id]{Name}`) which Foundry auto-enriches in the
 *      chat log into clickable links that open the entry.
 *   2. The Ironsworn move catalog. Matches become a custom in-chat link
 *      that, when clicked, offers a one-click roll (wired by
 *      {@link Integration.wireSuggestionCard}). Move matching is
 *      case-SENSITIVE so ordinary verbs ("you strike the wolf") are never
 *      mistaken for the move ("make a Strike").
 *   3. The Ironsworn oracle tables (IronswornData.oracles). Oracle labels
 *      ("Action Oracle", "Pay the Price Oracle", …) become links that roll
 *      the oracle via {@link OracleInterpreter}. Case-SENSITIVE to avoid
 *      matching common words like "action"/"region".
 *   4. Progress tracks on the active character (vows, journeys, bonds,
 *      combat tracks). Matches become links that show the track's status
 *      and offer to mark progress. Case-insensitive (proper-noun-ish names).
 *   5. Assets from the system's compendia (Companions, Paths, Rituals, …),
 *      read from an async-built, cached index on {@link IronswornController}.
 *      Matches become links that open the asset's card. Case-insensitive.
 *
 * The index is built lazily and cached, and invalidated whenever a journal
 * entry is created / updated / deleted or the world reloads. The whole
 * feature is additive and wrapped in try/catch: if anything goes wrong the
 * original (already-formatted) HTML is returned untouched, so narration is
 * never broken by linking.
 */
export const EntityLinker = {
  /** @type {{regex: RegExp, byName: Map<string, object>}|null} */
  _cache: null,
  _dirty: true,

  /**
   * (v0.9.0) Memoised journal sub-index. Scanning every JournalEntry (and
   * extracting its aliases) is by far the most expensive part of a rebuild,
   * and for large campaigns (100+ entries) it dominates. We cache the parsed
   * result keyed by {@link JournalSystem.journalGeneration}, so it is only
   * re-scanned when a chronicle entry is actually created / renamed / deleted
   * — NOT on the far more frequent item/actor/token changes that merely
   * affect the (cheap) move/track/asset portions of the index.
   * @type {{gen: number, list: Array<[string, object]>}|null}
   */
  _journalCache: null,

  /**
   * Mark the cached index stale; it rebuilds (lazily) on next use. The
   * journal sub-index is preserved unless the journal generation changed,
   * so frequent non-journal invalidations stay cheap (v0.9.0).
   */
  invalidate() { this._dirty = true; this._cache = null; },

  /**
   * (v0.9.0) Drop ALL caches including the journal sub-index. Used when the
   * journal collection itself changes so the next rebuild re-scans journals.
   */
  invalidateJournal() {
    this._dirty = true;
    this._cache = null;
    this._journalCache = null;
  },

  /**
   * (v0.9.0) Build (or reuse) the journal entity sub-index: an array of
   * `[lowercaseKey, descriptor]` pairs for every chronicle NPC / location /
   * discovery and its aliases. Cached against the journal generation counter
   * so repeated narrations within a stable journal state pay the scan cost
   * only once. Defensive: any failure yields an empty list (links degrade
   * gracefully, narration is never broken).
   * @returns {Array<[string, object]>}
   */
  _journalSubindex() {
    let gen = 0;
    try {
      gen = (typeof JournalSystem !== "undefined" && typeof JournalSystem.journalGeneration === "function")
        ? JournalSystem.journalGeneration() : 0;
    } catch (_) { gen = 0; }

    if (this._journalCache && this._journalCache.gen === gen) {
      return this._journalCache.list;
    }

    const list = [];
    const seenKeys = new Set();
    try {
      if (typeof JournalSystem !== "undefined" && typeof JournalSystem.listEntries === "function") {
        // Single pass over the journal collection (vs. one scan per type) —
        // we filter to the three linkable chronicle types in-loop.
        const linkable = new Set(["npc", "location", "discovery"]);
        for (const j of JournalSystem.listEntries()) {
          let type = "";
          try { type = String(j?.getFlag?.(MODULE_ID, "type") || "").toLowerCase(); } catch (_) {}
          if (!linkable.has(type)) continue;

          const name = (j?.name ?? "").trim();
          if (name.length < 3) continue;
          const key = name.toLowerCase();
          if (seenKeys.has(key)) continue; // first definition wins
          const uuid = j.uuid ?? `JournalEntry.${j.id}`;
          seenKeys.add(key);
          list.push([key, {
            key: `journal:${key}`,
            name,
            kind: "journal",
            uuid,
            caseSensitive: false
          }]);

          // (v0.8.0) Smart entity detection: register the entry's aliases so
          // narration variations ("the captain", "Reeves") resolve to the
          // same journal entity. Aliases never clobber an existing name.
          try {
            const aliases = (typeof JournalSystem._entryAliases === "function")
              ? JournalSystem._entryAliases(j) : [];
            for (const alias of aliases) {
              const a = String(alias ?? "").trim();
              if (a.length < 3) continue;
              const akey = a.toLowerCase();
              if (seenKeys.has(akey)) continue;
              seenKeys.add(akey);
              list.push([akey, {
                key: `journal:${akey}`,
                name,            // canonical label keeps the real entity name
                kind: "journal",
                uuid,
                caseSensitive: false,
                alias: true
              }]);
            }
          } catch (_) { /* alias indexing is best-effort */ }
        }
      }
    } catch (_) { /* journal not ready — skip */ }

    this._journalCache = { gen, list };
    return list;
  },

  /** True iff the feature is switched on (defaults ON). */
  enabled() { return Settings.get("entityLinking") !== false; },

  /** Escape a literal string for safe inclusion in a RegExp. */
  _escapeRe(str) { return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); },

  /**
   * Human-readable label for an oracle key (mirrors
   * {@link OracleInterpreter._labelFor} but kept self-contained so the index
   * can build before that object is referenced). Unknown keys fall back to a
   * title-cased version of the key plus an "Oracle" suffix.
   */
  _oracleLabel(key) {
    const map = {
      action: "Action Oracle",
      theme: "Theme Oracle",
      region: "Region Oracle",
      location: "Location Oracle",
      coastal: "Coastal Waters Oracle",
      npcRole: "NPC Role Oracle",
      npcGoal: "NPC Goal Oracle",
      npcDescriptor: "NPC Descriptor Oracle",
      combatAction: "Combat Action Oracle",
      mysticBacklash: "Mystic Backlash Oracle",
      payThePrice: "Pay the Price Oracle"
    };
    if (map[key]) return map[key];
    // Fallback: "someKey" → "Some Key Oracle".
    const words = String(key ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
    if (!words) return "";
    return `${words.charAt(0).toUpperCase()}${words.slice(1)} Oracle`;
  },

  /**
   * (Re)build the name → entry index and the combined matcher regex.
   * Returns the cache object (possibly with an empty index).
   */
  _build() {
    // (v0.9.0) Optional timing for large-campaign performance tuning. Only
    // computes timestamps when a debug flag is on, so it costs nothing in
    // normal play.
    const _t0 = this._perfEnabled() ? (performance?.now?.() ?? Date.now()) : 0;
    const byName = new Map();

    // --- 1) Chronicle journal entities (proper nouns; case-insensitive) ---
    //   Reuse the memoised journal sub-index (v0.9.0). This is the heavy part
    //   for large campaigns and is only re-scanned when the journal generation
    //   changes, not on every rebuild.
    try {
      for (const [key, descriptor] of this._journalSubindex()) {
        if (byName.has(key)) continue; // first definition wins
        byName.set(key, descriptor);
      }
    } catch (_) { /* journal not ready — skip */ }

    // --- 2) Ironsworn moves (case-SENSITIVE to avoid verb false-positives) ---
    try {
      if (IronswornController?.isActive?.() && Array.isArray(IronswornController.moves)) {
        for (const m of IronswornController.moves) {
          const name = (m?.name ?? "").trim();
          if (name.length < 3) continue;
          const key = name.toLowerCase();
          if (byName.has(key)) continue; // don't clobber a journal entity
          byName.set(key, {
            key: `move:${key}`,
            name,
            kind: "move",
            moveName: name,
            // Datasworn ID (e.g. "move:classic/combat/strike") — lets the
            // click handler open the *system's* official move directly.
            moveDsId: (typeof m?.id === "string" && m.id.startsWith("move:")) ? m.id : "",
            caseSensitive: true
          });
        }
      }
    } catch (_) { /* controller not ready — skip */ }

    // --- 3) Ironsworn oracles (case-SENSITIVE labels to avoid common-word
    //        false-positives like "action"/"region"). Clicking an oracle
    //        link rolls it through the OracleInterpreter. ------------------
    try {
      if (typeof IronswornData !== "undefined" && IronswornData?.oracles) {
        for (const oracleKey of Object.keys(IronswornData.oracles)) {
          const label = this._oracleLabel(oracleKey); // e.g. "Action Oracle"
          if (!label || label.length < 3) continue;
          const key = label.toLowerCase();
          if (byName.has(key)) continue; // don't clobber an earlier entity
          byName.set(key, {
            key: `oracle:${oracleKey}`,
            name: label,
            kind: "oracle",
            oracleAlias: oracleKey,
            caseSensitive: true
          });
        }
      }
    } catch (_) { /* oracle data not ready — skip */ }

    // --- 4) Progress tracks on the active character (vows, journeys, bonds,
    //        combat tracks). Proper-noun-ish names; case-insensitive like
    //        journal entities. Clicking shows / marks the track. -----------
    try {
      if (IronswornController?.isActive?.() && typeof IronswornController.getProgressTracks === "function") {
        const actor = IronswornController.getActiveCharacter?.();
        if (actor) {
          for (const track of IronswornController.getProgressTracks(actor)) {
            const name = (track?.name ?? "").trim();
            if (name.length < 3) continue;
            // Never turn a GENERIC track noun ("vow", "journey", "bond", ...)
            // into a clickable link: the bare word is not a player-chosen
            // proper name, and linking it produces a phantom card disconnected
            // from the real vow on the sheet. Such words are resolved to the
            // actual current track only when explicitly acted on, not linked.
            if (IronswornController.isGenericTrackWord?.(name)) continue;
            const key = name.toLowerCase();
            if (byName.has(key)) continue; // first definition wins
            byName.set(key, {
              key: `track:${key}`,
              name,
              kind: "track",
              trackName: name,
              caseSensitive: false
            });
          }
        }
      }
    } catch (_) { /* controller / actor not ready — skip */ }

    // --- 5) Assets from the compendium (Companions, Paths, Rituals, …).
    //        Read from IronswornController's async-built, cached index
    //        (primed on `ready`; empty until then — degrades gracefully).
    //        Case-insensitive; asset names are distinctive proper nouns. ---
    try {
      if (IronswornController?.isActive?.() && typeof IronswornController.getAssetNames === "function") {
        for (const asset of IronswornController.getAssetNames()) {
          const name = (asset?.name ?? "").trim();
          if (name.length < 3) continue;
          const key = name.toLowerCase();
          if (byName.has(key)) continue; // don't clobber a more-specific entity
          byName.set(key, {
            key: `asset:${key}`,
            name,
            kind: "asset",
            assetName: name,
            assetUuid: asset.uuid ?? "",
            caseSensitive: false
          });
        }
      }
    } catch (_) { /* asset index not ready — skip */ }

    let regex = null;
    if (byName.size) {
      // Longest names first so multi-word entities win over substrings.
      const alts = [...byName.values()]
        .map(e => e.name)
        .sort((a, b) => b.length - a.length)
        .map(n => this._escapeRe(n));
      // Unicode-aware word boundaries via lookarounds so we don't match
      // inside a longer word and so apostrophes/digits count as "word".
      try {
        regex = new RegExp(`(?<![\\p{L}\\p{N}'’])(?:${alts.join("|")})(?![\\p{L}\\p{N}'’])`, "giu");
      } catch (_) {
        // Engines without lookbehind: fall back to plain \b boundaries.
        regex = new RegExp(`\\b(?:${alts.join("|")})\\b`, "gi");
      }
    }

    this._cache = { regex, byName };
    this._dirty = false;

    // (v0.9.0) Emit a one-line timing report when performance debugging is on.
    if (_t0) {
      try {
        const ms = ((performance?.now?.() ?? Date.now()) - _t0).toFixed(1);
        console.log(`${LOG_PREFIX} [perf] EntityLinker index rebuilt: ${byName.size} names in ${ms}ms (journal entries cached).`);
      } catch (_) { /* timing is best-effort */ }
    }
    return this._cache;
  },

  /** (v0.9.0) True when performance/debug logging is requested. */
  _perfEnabled() {
    try { return Settings.get("debugLogging") === true || Settings.get("ragDebugMode") === true; }
    catch (_) { return false; }
  },

  /* ---------------- customisable link styles (v0.9.0) ---------------- */

  /**
   * Built-in per-kind link palette (colour + FontAwesome icon class). Mirrors
   * the defaults baked into eternal-skald.css so the rendered markup and the
   * stylesheet agree when no custom style is set. (v0.9.0)
   * @type {Object<string,{color:string,icon:string}>}
   */
  LINK_DEFAULTS: Object.freeze({
    journal: { color: "#d6a85a", icon: "fa-book-open" },
    move:    { color: "#e8c178", icon: "fa-dice-d6" },
    oracle:  { color: "#c4a6e8", icon: "fa-dice-d20" },
    track:   { color: "#9ec99a", icon: "fa-list-check" },
    asset:   { color: "#8fb8d6", icon: "fa-id-card" }
  }),

  /** The kinds a user may customise. */
  STYLE_KINDS: Object.freeze(["journal", "move", "oracle", "track", "asset"]),

  /** True iff the user has opted into custom link styles. */
  customStylesEnabled() {
    try { return Settings.get("customLinkStyles") === true; }
    catch (_) { return false; }
  },

  /** The raw user override object (always an object). */
  _userStyles() {
    try {
      const s = Settings.get("linkStyles");
      return (s && typeof s === "object") ? s : {};
    } catch (_) { return {}; }
  },

  /**
   * Resolve the effective {color, icon} for a link kind: the built-in default
   * merged with any user override (only when custom styles are enabled).
   * Always returns a complete, sanitised object. (v0.9.0)
   * @param {string} kind
   * @returns {{color:string,icon:string}}
   */
  _styleFor(kind) {
    const def = this.LINK_DEFAULTS[kind] || this.LINK_DEFAULTS.move;
    if (!this.customStylesEnabled()) return { color: def.color, icon: def.icon };
    const ov = this._userStyles()[kind] || {};
    const color = (typeof ov.color === "string" && this._isSafeColor(ov.color)) ? ov.color : def.color;
    const icon  = (typeof ov.icon === "string" && this._isSafeIcon(ov.icon)) ? ov.icon : def.icon;
    return { color, icon };
  },

  /** Accept #rgb / #rrggbb / #rrggbbaa hex or a short CSS colour keyword. */
  _isSafeColor(s) {
    const v = String(s || "").trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return true;
    return /^[a-z]{3,20}$/i.test(v); // simple named colour, no parentheses/escapes
  },

  /** Accept a FontAwesome glyph class like "fa-dragon" (letters/digits/dashes). */
  _isSafeIcon(s) {
    return /^fa-[a-z0-9-]{1,40}$/i.test(String(s || "").trim());
  },

  /**
   * Inject / refresh / remove the live override stylesheet that recolours the
   * inline entity links according to the user's preferences. Driven entirely
   * by CSS so it also covers the Foundry-enriched journal content-links (whose
   * markup we don't author). No-ops gracefully in headless contexts. (v0.9.0)
   */
  applyCustomStyles() {
    try {
      if (typeof document === "undefined" || !document?.head) return;
      const ID = "es-custom-link-styles";
      let el = document.getElementById(ID);

      // Disabled → remove any previously-injected overrides and bail.
      if (!this.customStylesEnabled()) {
        if (el) el.remove();
        return;
      }

      const rules = [];
      for (const kind of this.STYLE_KINDS) {
        const { color } = this._styleFor(kind);
        if (kind === "journal") {
          // Foundry renders @UUID links as <a class="content-link"> inside our
          // message; tint those (and their leading icon) within our cards only.
          rules.push(`.eternal-skald-msg a.content-link { color: ${color}; }`);
          rules.push(`.eternal-skald-msg a.content-link > i { color: ${color}; }`);
        } else {
          rules.push(`.es-entity-link.es-${kind}-link { color: ${color}; }`);
          rules.push(`.es-entity-link.es-${kind}-link:hover { color: ${color}; border-bottom-color: ${color}; }`);
        }
      }

      if (!el) {
        el = document.createElement("style");
        el.id = ID;
        document.head.appendChild(el);
      }
      el.textContent = `/* The Eternal Skald — custom link styles (v0.9.0) */\n${rules.join("\n")}`;
    } catch (_) { /* cosmetic only — never throw */ }
  },

  /**
   * Persist a colour/icon override for a link kind and enable custom styles.
   * Validates input; returns the resolved style or null on bad input. World
   * setting writes are GM-gated by Foundry, so the caller should be GM. (v0.9.0)
   * @param {string} kind  one of STYLE_KINDS
   * @param {{color?:string, icon?:string}} patch
   * @returns {Promise<{color:string,icon:string}|null>}
   */
  async setStyle(kind, patch = {}) {
    if (!this.STYLE_KINDS.includes(kind)) return null;
    const next = { ...this._userStyles() };
    const cur = { ...(next[kind] || {}) };
    if (typeof patch.color === "string" && patch.color.trim()) {
      if (!this._isSafeColor(patch.color)) return null;
      cur.color = patch.color.trim();
    }
    if (typeof patch.icon === "string" && patch.icon.trim()) {
      let ic = patch.icon.trim();
      if (!/^fa-/i.test(ic)) ic = `fa-${ic}`; // tolerate "dragon" → "fa-dragon"
      if (!this._isSafeIcon(ic)) return null;
      cur.icon = ic;
    }
    next[kind] = cur;
    try {
      await game.settings.set(MODULE_ID, "linkStyles", next);
      if (!this.customStylesEnabled()) await game.settings.set(MODULE_ID, "customLinkStyles", true);
    } catch (_) { return null; }
    // onChange handlers refresh CSS + index; refresh eagerly too.
    this.applyCustomStyles();
    this.invalidate();
    return this._styleFor(kind);
  },

  /** Clear all user overrides (keeps customLinkStyles toggle as-is). (v0.9.0) */
  async resetStyles() {
    try { await game.settings.set(MODULE_ID, "linkStyles", {}); } catch (_) {}
    this.applyCustomStyles();
    this.invalidate();
  },

  _index() {
    if (this._dirty || !this._cache) return this._build();
    return this._cache;
  },

  /** Build the replacement HTML for a single matched entity. */
  _renderLink(entry, matchedText) {
    if (entry.kind === "journal") {
      // Content-link TEXT — Foundry enriches this into a clickable link in
      // the chat log (same mechanism the !journals command relies on).
      // Strip braces from the label defensively so the syntax can't break.
      const label = matchedText.replace(/[{}]/g, "");
      return `@UUID[${entry.uuid}]{${label}}`;
    }
    if (entry.kind === "oracle") {
      // Oracle — clicking rolls the oracle and the Skald interprets it.
      const alias = escapeHtml(entry.oracleAlias ?? "");
      const label = escapeHtml(entry.name);
      const icon = escapeHtml(this._styleFor("oracle").icon); // (v0.9.0) customisable
      return `<a class="es-entity-link es-oracle-link" data-skald-action="link-oracle" ` +
        `data-es-kind="oracle" data-oracle="${alias}" ` +
        `data-tooltip="Ironsworn oracle: ${label} — click to roll">` +
        `<i class="fa-solid ${icon}"></i>${escapeHtml(matchedText)}</a>`;
    }
    if (entry.kind === "track") {
      // Progress track — clicking shows the track and offers to mark it.
      const tname = escapeHtml(entry.trackName ?? entry.name);
      const icon = escapeHtml(this._styleFor("track").icon); // (v0.9.0) customisable
      return `<a class="es-entity-link es-track-link" data-skald-action="link-track" ` +
        `data-es-kind="track" data-track="${tname}" ` +
        `data-tooltip="Progress track: ${tname} — click to view / mark">` +
        `<i class="fa-solid ${icon}"></i>${escapeHtml(matchedText)}</a>`;
    }
    if (entry.kind === "asset") {
      // Asset — clicking opens the asset card from the compendium.
      const aname = escapeHtml(entry.assetName ?? entry.name);
      const auuid = escapeHtml(entry.assetUuid ?? "");
      const icon = escapeHtml(this._styleFor("asset").icon); // (v0.9.0) customisable
      return `<a class="es-entity-link es-asset-link" data-skald-action="link-asset" ` +
        `data-es-kind="asset" data-asset="${aname}" data-asset-uuid="${auuid}" ` +
        `data-tooltip="Ironsworn asset: ${aname} — click to view">` +
        `<i class="fa-solid ${icon}"></i>${escapeHtml(matchedText)}</a>`;
    }
    // Move — custom link wired by Integration.wireSuggestionCard. We carry
    // the Datasworn ID so the click handler can open the *system's* official
    // move dialog/sheet directly (no intermediate card).
    const move = escapeHtml(entry.moveName);
    const dsid = escapeHtml(entry.moveDsId ?? "");
    const icon = escapeHtml(this._styleFor("move").icon); // (v0.9.0) customisable
    return `<a class="es-entity-link es-move-link" data-skald-action="link-move" ` +
      `data-es-kind="move" data-move="${move}" data-move-dsid="${dsid}" ` +
      `data-tooltip="Ironsworn move: ${move} — click to roll">` +
      `<i class="fa-solid ${icon}"></i>${escapeHtml(matchedText)}</a>`;
  },

  /**
   * Link entities inside an already-formatted (safe) HTML fragment.
   * Only text *between* tags is rewritten — never tag names/attributes,
   * never the contents of <code> or existing <a> elements. Each distinct
   * entity is linked at most once (its first mention) to avoid noise.
   *
   * @param {string} html  HTML produced by {@link formatMarkdown}
   * @returns {string}
   */
  link(html) {
    if (typeof html !== "string" || !html) return html;
    if (!this.enabled()) return html;

    let idx;
    try { idx = this._index(); } catch (_) { return html; }
    if (!idx?.regex || !idx.byName?.size) return html;

    try {
      const seen = new Set();
      // Split into tags vs. text, keeping the delimiters.
      const parts = html.split(/(<[^>]+>)/);
      let inCode = 0;
      let inAnchor = 0;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part) continue;

        if (part[0] === "<") {
          // It's a tag — track contexts we must not touch.
          const tag = part.toLowerCase();
          if (/^<code[\s>]/.test(tag)) inCode++;
          else if (/^<\/code>/.test(tag)) inCode = Math.max(0, inCode - 1);
          else if (/^<a[\s>]/.test(tag)) inAnchor++;
          else if (/^<\/a>/.test(tag)) inAnchor = Math.max(0, inAnchor - 1);
          continue; // never rewrite tags themselves
        }

        if (inCode || inAnchor) continue; // leave code / existing links alone

        idx.regex.lastIndex = 0;
        parts[i] = part.replace(idx.regex, (m) => {
          const entry = idx.byName.get(m.toLowerCase());
          if (!entry) return m;
          // Moves only link when the canonical capitalization matches.
          if (entry.caseSensitive && m !== entry.name) return m;
          if (seen.has(entry.key)) return m; // first mention only
          seen.add(entry.key);
          return this._renderLink(entry, m);
        });
      }

      return parts.join("");
    } catch (e) {
      console.warn(LOG_PREFIX, "entity linking failed:", e?.message || e);
      return html; // graceful: never break narration
    }
  }
};


/* ===================================================================== */
/*  §6b  STREAMING DISPLAY (v0.3.3)                                       */
/* ===================================================================== */




/* ===================================================================== */
/*  §7  COMMAND HANDLERS                                                  */
/* ===================================================================== */



/**
 * Generic conversation runner used by !skald, !scene, !combat. Manages
 * memory, builds the system prompt, calls the API, and posts the reply.
 */
export async function runConversation(channel, userText, { task, label, variant = "default", allowMoves = false, includeContext = false } = {}) {
  try {
    Memory.push(channel, "user", userText);
    // Inject the live Ironsworn game state when requested and available.
    const context = includeContext ? Integration.gatherContext() : "";
    // Narrative channels (skald/scene/combat) are the chronicle's primary
    // source. Allow the AI to append a [[SKALD_META]] block we can ingest.
    const allowJournal = ["skald", "scene", "combat"].includes(channel);
    // (v0.10.6) Let the Skald begin/close progress tracks (journeys, vows,
    // fights) it narrates in these conversational channels — not just after a
    // dice roll. This is what makes an organically-narrated journey actually
    // appear on the character sheet via [[EFFECT: create_journey …]]. Gated by
    // the Ironsworn integration being active AND the "AI Applies Mechanical
    // Effects" setting; only track-lifecycle effects are applied here (meter
    // changes stay dice-driven — see Integration.applyNarrativeTrackEffects).
    const allowTrackEffects = Integration.active() && (Settings.get("aiAppliesEffects") ?? true);
    // Recall semantically-relevant world memory for this prompt (v0.5.0).
    // Always resolves to a string ("" when RAG is off/not ready/fails).
    const memory = await RagBridge.fetchMemory(userText);
    const messages = [
      { role: "system", content: buildSystemPrompt({ task, allowMoves, allowTrackEffects, context, allowJournal, memory }) },
      ...Memory.get(channel)
    ];

    // ── Streaming path (v0.3.3) ──────────────────────────────────────
    // The live card IS the immediate feedback, so we skip the "listens to
    // the wind" whisper. Directives are stripped from the streamed display;
    // the full raw reply is still parsed afterwards for the move card.
    if (Settings.get("streamingEnabled") !== false) {
      try {
        const { reply } = await callSkaldStreaming(messages, { variant, title: label });
        Memory.push(channel, "assistant", reply);
        if (allowMoves && Integration.active()) {
          await Integration.postSuggestionFromReply(reply);
        }
        // (v0.10.6) Apply any track-lifecycle effects the Skald narrated
        // (e.g. create_journey) so the track appears on the sheet.
        if (allowTrackEffects) {
          await Integration.applyNarrativeTrackEffects(reply, IronswornController.getActiveCharacter());
        }
        // Fire-and-forget chronicle ingestion (never blocks/breaks play).
        if (allowJournal) JournalSystem.ingestReply(reply, { channel });
        return reply;
      } catch (streamErr) {
        // callSkaldStreaming already rendered a readable error into its card
        // (or recovered via buffered fallback). Surface a notification only.
        console.error(LOG_PREFIX, "runConversation stream:", streamErr);
        ui.notifications?.error(`${SKALD_NAME}: ${streamErr.message}`);
        return null;
      }
    }

    // ── Buffered path (streaming disabled or unavailable) ────────────
    await Chat.postSystem(`<em>${SKALD_NAME} listens to the wind…</em>`, { gmWhisper: true });
    const reply = await Client.chat(messages);
    Memory.push(channel, "assistant", reply);

    // When moves are allowed, route through the integration so the narration
    // is posted with directives stripped and any suggested move (woven into
    // the prose) is auto-linked inline by EntityLinker (v0.10.10).
    if (allowMoves && Integration.active()) {
      await Integration.postReplyWithSuggestion(reply, { variant, title: label });
    } else {
      // Strip any stray directive (move + chronicle metadata) so it never
      // leaks into the chat card.
      const { clean } = Integration.parseMoveSuggestion(reply);
      await Chat.postSkald(formatMarkdown(stripDirectivesForDisplay(clean || reply)), { variant, title: label });
    }
    // (v0.10.6) Apply any track-lifecycle effects the Skald narrated
    // (e.g. create_journey) so the track appears on the sheet.
    if (allowTrackEffects) {
      await Integration.applyNarrativeTrackEffects(reply, IronswornController.getActiveCharacter());
    }
    // Fire-and-forget chronicle ingestion (never blocks/breaks play).
    if (allowJournal) JournalSystem.ingestReply(reply, { channel });
    return reply;
  } catch (err) {
    console.error(LOG_PREFIX, err);
    await Chat.postSystem(
      `<strong>The Skald falters:</strong> ${escapeHtml(err.message)}`,
      { gmWhisper: true }
    );
    ui.notifications?.error(`${SKALD_NAME}: ${err.message}`);
    return null;
  }
}

/* ===================================================================== */
/*  §7.5  IRONSWORN INTEGRATION ORCHESTRATOR                             */
/* ===================================================================== */

/**
 * The Integration object is the glue between the Skald's AI brain and the
 * foundry-ironsworn rules engine (via IronswornController). It:
 *   • gathers live character/battlefield context for prompts,
 *   • parses the AI's structured directives ([[MOVE:…]] / [[EFFECT:…]]),
 *   • renders interactive move-suggestion cards with Roll / Choose buttons,
 *   • shows a move-selector dialog for overrides,
 *   • listens for Ironsworn roll results and feeds them back to the AI for
 *     narration + (optional) mechanical consequences.
 *
 * Everything degrades gracefully when the Ironsworn system is absent.
 */
export const Integration = {
  /** ChatMessage ids whose roll we've already narrated (anti-double-fire). */
  _processedRolls: new Set(),
  /** A short note of what the player was trying to do, for narration context. */
  _lastIntent: "",

  /** True iff the Ironsworn system is active AND integration is enabled. */
  active() {
    try {
      if (!IronswornController.isActive()) return false;
      return Settings.get("ironswornIntegration") ?? true;
    } catch (_) { return false; }
  },

  /**
   * Build the live game-state context string injected into prompts:
   * active character sheet + combat snapshot or scene summary.
   */
  gatherContext() {
    if (!this.active()) return "";
    const blocks = [];
    try {
      const charDesc = IronswornController.describeCharacter();
      if (charDesc) blocks.push(charDesc);
    } catch (e) { console.warn(LOG_PREFIX, "gatherContext: character read failed", e); }

    try {
      const combatState = IronswornController.describeCombatState();
      if (combatState) blocks.push(combatState);
    } catch (e) { console.warn(LOG_PREFIX, "gatherContext: combat state read failed", e); }

    try {
      if (game?.combat?.started) {
        blocks.push("Battlefield:\n" + CombatController.summariseCurrent());
      }
      // Map / scene awareness (v0.10.22): the active scene's name, its
      // marked locations (journal pins) and notable visible tokens. Provided
      // in and out of combat so the Skald can reference REAL places on the
      // map (e.g. when suggesting a destination). Read-only and concise.
      const sceneCtx = this._gatherSceneContext();
      if (sceneCtx) blocks.push(sceneCtx);
    } catch (e) { console.warn(LOG_PREFIX, "gatherContext: scene/map read failed", e); }

    return blocks.join("\n\n");
  },

  /**
   * Build a concise, read-only description of the ACTIVE scene for the AI
   * context (v0.10.22 — map/scene awareness).
   *
   * Surfaces three things, each optional and capped for token efficiency:
   *   • CURRENT SCENE      — the active scene's navigation/label name.
   *   • Visible Locations  — names drawn from the scene's map notes (journal
   *                          pins). The linked JournalEntry's name is used
   *                          (falling back to the note's custom label text),
   *                          so the Skald references places that genuinely
   *                          exist on the map.
   *   • Notable Tokens     — names of tokens placed on the scene, EXCLUDING
   *                          hidden (GM-only) tokens so secrets never leak
   *                          into the narration prompt.
   *
   * Fully defensive: returns "" when no scene is active or on any read
   * failure, so prompt-building never breaks (graceful degradation). The
   * method intentionally avoids `this` so it is trivially unit-testable.
   *
   * @returns {string} A formatted block, or "" when there is nothing to add.
   */
  _gatherSceneContext() {
    try {
      // Prefer the explicitly-activated scene; fall back to the viewed canvas.
      const scene = game?.scenes?.active ?? canvas?.scene ?? null;
      if (!scene) return ""; // no active scene → graceful degradation

      const sceneName = String(scene.navName || scene.name || "").trim() || "(unnamed scene)";
      const lines = [`CURRENT SCENE: ${sceneName}`];

      // --- Visible locations: scene notes / journal pins → linked journals.
      const locations = [];
      const seenLoc = new Set();
      try {
        const notes = scene.notes ? Array.from(scene.notes) : [];
        for (const note of notes) {
          if (!note) continue;
          // A note's custom label text overrides the linked entry's name.
          let label = "";
          try { label = String(note.text ?? "").trim(); } catch (_) { label = ""; }
          // Resolve the linked JournalEntry by id (NoteDocument.entryId).
          let journalName = "";
          try {
            const entry = (note.entryId && game?.journal?.get)
              ? game.journal.get(note.entryId)
              : (note.entry ?? null);
            if (entry?.name) journalName = String(entry.name).trim();
          } catch (_) { journalName = ""; }
          const name = label || journalName;
          if (!name) continue;
          const key = name.toLowerCase();
          if (seenLoc.has(key)) continue;
          seenLoc.add(key);
          locations.push(name);
        }
      } catch (_) { /* notes unreadable → skip locations */ }
      if (locations.length) {
        const shown = locations.slice(0, 12);
        const extra = locations.length - shown.length;
        lines.push(`Visible Locations: ${shown.join(", ")}${extra > 0 ? `, +${extra} more` : ""}`);
      }

      // --- Notable tokens: placed tokens, EXCLUDING hidden (GM-only) ones.
      const tokenNames = [];
      const seenTok = new Set();
      try {
        const tokens = scene.tokens ? Array.from(scene.tokens) : [];
        for (const tok of tokens) {
          if (!tok) continue;
          if (tok.hidden) continue; // never expose hidden tokens to the AI
          const nm = String(tok.name ?? "").trim();
          if (!nm) continue;
          const key = nm.toLowerCase();
          if (seenTok.has(key)) continue;
          seenTok.add(key);
          tokenNames.push(nm);
        }
      } catch (_) { /* tokens unreadable → skip tokens */ }
      if (tokenNames.length) {
        const shown = tokenNames.slice(0, 12);
        const extra = tokenNames.length - shown.length;
        lines.push(`Notable Tokens: ${shown.join(", ")}${extra > 0 ? `, +${extra} more` : ""}`);
      }

      // Only the scene name and nothing else is still worth surfacing.
      return lines.join("\n");
    } catch (e) {
      console.warn(LOG_PREFIX, "_gatherSceneContext: scene read failed", e);
      return "";
    }
  },

  /* ---------------- Directive parsing ---------------- */

  /**
   * Extract a single [[MOVE: Name | Stat | reason]] directive.
   * @returns {{ suggestion: {name,stat,reason}|null, clean: string }}
   */
  parseMoveSuggestion(text) {
    if (typeof text !== "string") return { suggestion: null, clean: "" };
    const re = /\[\[\s*MOVE\s*:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*(?:\|\s*([^\]]*?))?\s*\]\]/i;
    const m = text.match(re);
    if (!m) return { suggestion: null, clean: text };
    const name = m[1].trim();
    let stat = (m[2] || "").trim().toLowerCase();
    if (stat === "—" || stat === "-" || stat === "none" || stat === "n/a") stat = "";
    const reason = (m[3] || "").trim();
    const clean = text.replace(m[0], "").trim();
    return { suggestion: { name, stat, reason }, clean };
  },

  /**
   * Extract MULTIPLE [[MOVE: Name | Stat | reason]] directives (used for
   * post-roll follow-up suggestions, where the Skald proposes two moves).
   *
   * Every suggestion is validated against the REAL move catalogue via
   * {@link IronswornController._resolveMove}; any move the AI invented (one
   * that does not exist in the system) is silently dropped, so a fabricated
   * "move" can never reach the player as a rollable suggestion. Duplicates
   * are removed and the canonical move name from the catalogue is used.
   *
   * @param {string} text
   * @param {{max?: number}} [opts]
   * @returns {{ suggestions: Array<{name,stat,reason}>, clean: string }}
   */
  parseMoveSuggestions(text, { max = 2 } = {}) {
    if (typeof text !== "string") return { suggestions: [], clean: "" };
    const re = /\[\[\s*MOVE\s*:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*(?:\|\s*([^\]]*?))?\s*\]\]/gi;
    const suggestions = [];
    const seen = new Set();
    let m;
    while ((m = re.exec(text)) !== null) {
      const rawName = (m[1] || "").trim();
      let stat = (m[2] || "").trim().toLowerCase();
      if (stat === "—" || stat === "-" || stat === "none" || stat === "n/a") stat = "";
      const reason = (m[3] || "").trim();
      // Validate against the real catalogue — DROP invented/unknown moves.
      const resolved = IronswornController._resolveMove?.(rawName);
      if (!resolved?.name) continue;
      const key = resolved.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      // Use the canonical catalogue name so buttons/labels are always real.
      suggestions.push({ name: resolved.name, stat, reason });
      if (suggestions.length >= max) break;
    }
    // Strip ALL move directives from the display copy.
    const clean = text.replace(/\[\[\s*MOVE\s*:[^\]]*?\]\]/gi, "").trim();
    return { suggestions, clean };
  },

  /**
   * Extract all [[EFFECT: …]] directives.
   * @returns {{ effects: Array<object>, clean: string }}
   */
  parseEffects(text) {
    if (typeof text !== "string") return { effects: [], clean: "" };
    const effects = [];
    const re = /\[\[\s*EFFECT\s*:\s*([^\]]+?)\s*\]\]/gi;
    let clean = text;
    let m;
    while ((m = re.exec(text)) !== null) {
      const body = m[1].trim();
      const parsed = this._parseOneEffect(body);
      if (parsed) effects.push(parsed);
    }
    clean = text.replace(re, "").trim();

    // ---- v0.10.27 — explicit progress-track WRITE directives ----
    // A second, deliberately distinct syntax the AI uses to drive precise
    // track writes when it KNOWS the exact track:
    //   [[MARK_COMPLETE:vow:The Truth of the Star-Fall]]
    //   [[MARK_COMPLETE:combat:Bog Rot]]
    //   [[MARK_COMPLETE:journey:The Long Road North]]
    //   [[ADD_PROGRESS:vow:The Truth of the Star-Fall:2]]   (add 2 boxes)
    //   [[SET_PROGRESS:vow:The Truth of the Star-Fall:8]]   (set to 8 boxes)
    // Colon-separated and verb-led (no "EFFECT:" prefix) so it never collides
    // with the established [[EFFECT: ...]] grammar above.
    const wr = /\[\[\s*(MARK_COMPLETE|ADD_PROGRESS|SET_PROGRESS)\s*:\s*([^\]]+?)\s*\]\]/gi;
    let w;
    while ((w = wr.exec(text)) !== null) {
      const parsed = this._parseWriteDirective(w[1], w[2]);
      if (parsed) effects.push(parsed);
    }
    clean = clean.replace(wr, "").trim();

    return { effects, clean };
  },

  /**
   * Parse a v0.10.27 progress-track write directive body. `verb` is one of
   * MARK_COMPLETE / ADD_PROGRESS / SET_PROGRESS; `body` is the colon-delimited
   * tail "<kind>:<Name>[:<number>]". Returns a normalized effect object or null
   * when malformed. Track KIND is validated to vow|journey|combat|bond.
   */
  _parseWriteDirective(verb, body) {
    const V = String(verb || "").toUpperCase();
    const parts = String(body || "").split(":").map(s => s.trim());
    if (parts.length < 2) return null;
    const kind = parts[0].toLowerCase();
    if (!["vow", "journey", "combat", "bond"].includes(kind)) return null;

    if (V === "MARK_COMPLETE") {
      // [[MARK_COMPLETE:kind:Name]] — Name may itself contain colons.
      const name = parts.slice(1).join(":").trim();
      if (!name) return null;
      return { kind: "mark_complete", trackKind: kind, name };
    }
    // ADD_PROGRESS / SET_PROGRESS need a trailing integer box count.
    if (parts.length < 3) return null;
    const numTok = parts[parts.length - 1];
    const num = parseInt(numTok, 10);
    if (!Number.isFinite(num)) return null;
    const name = parts.slice(1, parts.length - 1).join(":").trim();
    if (!name) return null;
    if (V === "ADD_PROGRESS") return { kind: "add_progress", trackKind: kind, name, boxes: num };
    if (V === "SET_PROGRESS") return { kind: "set_progress", trackKind: kind, name, boxes: num };
    return null;
  },

  _parseOneEffect(body) {
    // body examples: "momentum +2", "momentum reset", "harm 1", "stress 2",
    // "supply -1", "progress Vengeance on the Iron King +8", "oracle Pay the Price"
    const lc = body.toLowerCase();
    const firstWord = lc.split(/\s+/)[0];

    if (firstWord === "momentum") {
      const rest = body.slice(8).trim();
      if (/reset/i.test(rest)) return { kind: "momentum", op: "reset" };
      const n = parseInt(rest, 10);
      if (Number.isFinite(n)) return { kind: "momentum", op: "delta", value: n };
      return null;
    }
    if (firstWord === "harm")   { const n = parseInt(body.slice(4), 10); return Number.isFinite(n) ? { kind: "harm",   value: Math.abs(n) } : null; }
    if (firstWord === "stress") { const n = parseInt(body.slice(6), 10); return Number.isFinite(n) ? { kind: "stress", value: Math.abs(n) } : null; }
    if (firstWord === "supply") { const n = parseInt(body.slice(6), 10); return Number.isFinite(n) ? { kind: "supply", value: n } : null; }

    // ---- Impact / condition toggles (v0.10.36 — Phase 2) ----
    // [[EFFECT: toggle_impact <type>]]        — flip a condition on/off
    // [[EFFECT: set_impact <type> <on|off>]]  — set explicitly
    // [[EFFECT: clear_impact <type>]]         — clear a condition
    // <type> may be loose ("wounded", "permanently harmed", "in debt") —
    // the controller canonicalizes it. Multi-word types are supported.
    if (firstWord === "toggle_impact" || lc.startsWith("toggle impact")) {
      const rest = body.replace(/^toggle[_\s]impact/i, "").trim();
      return rest ? { kind: "toggle_impact", impact: rest } : null;
    }
    if (firstWord === "clear_impact" || lc.startsWith("clear impact")) {
      const rest = body.replace(/^clear[_\s]impact/i, "").trim();
      return rest ? { kind: "set_impact", impact: rest, on: false } : null;
    }
    if (firstWord === "set_impact" || lc.startsWith("set impact")) {
      const rest = body.replace(/^set[_\s]impact/i, "").trim();
      // Trailing on/off|true/false|clear toggles the desired state; default ON.
      const tm = rest.match(/\b(on|off|true|false|set|clear|add|remove)\s*$/i);
      let on = true;
      let name = rest;
      if (tm) {
        const word = tm[1].toLowerCase();
        on = ["on", "true", "set", "add"].includes(word);
        name = rest.slice(0, tm.index).trim();
      }
      return name ? { kind: "set_impact", impact: name, on } : null;
    }

    // ---- Base-stat set (v0.10.36 — Phase 2) ----
    // [[EFFECT: set_stat <edge|heart|iron|shadow|wits> <0-5>]]
    if (firstWord === "set_stat" || lc.startsWith("set stat")) {
      const rest = body.replace(/^set[_\s]stat/i, "").trim();
      const sm = rest.match(/^([a-z]+)\D*([0-9]+)/i);
      if (!sm) return null;
      const stat = sm[1].toLowerCase();
      const value = parseInt(sm[2], 10);
      if (!Number.isFinite(value)) return null;
      return { kind: "set_stat", stat, value };
    }

    // ---- Compendium creation (v0.10.37 — Phase 3) ----
    // [[EFFECT: add_asset <Asset Name>]]            — add an asset to the PC
    // [[EFFECT: add_item <Item Name>]]              — add any compendium item
    // [[EFFECT: create_foe <Name> [rank] [unique]]] — spawn a foe actor
    // [[EFFECT: create_character <Name>]]           — create a blank PC
    // Names may be quoted; ranks use the canonical rank words. A trailing
    // `unique`/`boss`/`narrative`/`custom` keyword on create_foe flags a
    // bespoke (non-compendium) antagonist so the custom-fallback is expected.
    if (firstWord === "add_asset" || lc.startsWith("add asset")) {
      const rest = body.replace(/^add[_\s]asset/i, "").trim();
      const name = this._unquote(rest);
      return name ? { kind: "add_asset", name } : null;
    }
    if (firstWord === "add_item" || lc.startsWith("add item")) {
      const rest = body.replace(/^add[_\s]item/i, "").trim();
      const name = this._unquote(rest);
      return name ? { kind: "add_item", name } : null;
    }
    if (firstWord === "create_foe" || lc.startsWith("create foe") ||
        firstWord === "spawn_foe"  || lc.startsWith("spawn foe")) {
      let rest = body.replace(/^(create|spawn)[_\s]foe/i, "").trim();
      let important = false;
      const mk = rest.match(/[\s(\[]+(unique|boss|narrative|custom)\)?\]?\s*$/i);
      if (mk) { important = true; rest = rest.slice(0, mk.index).trim(); }
      // Quoted name keeps any spaces intact; otherwise split off a trailing rank.
      const q = rest.match(/^["'“”]([^"'“”]+)["'“”]\s*(.*)$/);
      let name, rank = null;
      if (q) {
        name = q[1].trim();
        const tok = (q[2] || "").trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") || "";
        rank = this._RANKS.includes(tok) ? tok : null;
      } else {
        ({ name, rank } = this._splitNameRank(rest));
      }
      return name ? { kind: "create_foe", name, rank, important } : null;
    }
    if (firstWord === "create_character" || lc.startsWith("create character") ||
        firstWord === "create_pc" || lc.startsWith("create pc")) {
      const rest = body.replace(/^create[_\s](character|pc)/i, "").trim();
      const name = this._unquote(rest);
      return name ? { kind: "create_character", name } : null;
    }

    // "progress <Track Name> <+N | rank>" and its by-title alias
    // "mark_progress <Track Title> [+N | rank]" / 'mark_progress "Track Title"'.
    // mark_progress is meant for advancing a NAMED vow/journey from the
    // narrative (no dice roll), so when it carries no explicit tick count it
    // defaults to marking by the track's rank.
    const isMarkProgress = firstWord === "mark_progress" || lc.startsWith("mark progress ") || lc === "mark progress";
    if (firstWord === "progress" || isMarkProgress) {
      let rest;
      if (firstWord === "progress")            rest = body.slice(8).trim();
      else if (firstWord === "mark_progress")  rest = body.slice(13).trim();
      else                                     rest = body.replace(/^mark\s+progress/i, "").trim();

      let name, value = 4, byRank = false;
      // A quoted title — 'mark_progress "The Truth of the Star-Fall" +8' or
      // just 'mark_progress "The Long Road North"' — is the clearest form.
      const quoted = rest.match(/^["'“”]([^"'“”]+)["'“”]\s*(.*)$/);
      if (quoted) {
        name = quoted[1].trim();
        const tail = (quoted[2] || "").trim();
        const tm = tail.match(/([+-]?\d+)/);
        if (/\brank\b/i.test(tail)) byRank = true;
        else if (tm) value = parseInt(tm[1], 10);
        else byRank = true;                 // bare quoted title → by rank
      } else {
        const tickMatch = rest.match(/([+-]?\d+)\s*(?:ticks?)?\s*$/i);
        const rankMatch = /\brank\b\s*$/i.test(rest);
        name = rest;
        if (rankMatch)      { byRank = true; name = rest.replace(/\brank\b\s*$/i, "").trim(); }
        else if (tickMatch) { value = parseInt(tickMatch[1], 10); name = rest.slice(0, tickMatch.index).trim(); }
        else if (isMarkProgress) { byRank = true; }   // unquoted mark_progress, no ticks → by rank
      }
      name = name.replace(/^on\s+/i, "").replace(/[:\-—]+$/, "").trim();
      if (!name) return null;
      return { kind: "progress", track: name, value, byRank };
    }
    if (firstWord === "oracle") {
      const name = body.slice(6).trim();
      return name ? { kind: "oracle", name } : null;
    }

    // ---- Experience awards (v0.10.32 — Phase 1) ----
    // [[EFFECT: grant_xp <amount> <reason...>]]  — award N experience for a
    //   discretionary milestone (the reason is free text, optional).
    // [[EFFECT: grant_xp_vow <rank>]]            — award the rank's XP for a
    //   fulfilled vow (troublesome 1 … epic 5). The rank is optional; when
    //   omitted the active/just-rolled vow's own rank is used.
    if (firstWord === "grant_xp_vow" || lc.startsWith("grant_xp_vow") || lc.startsWith("grant xp vow")) {
      const rest = body.replace(/^grant[_\s]xp[_\s]vow/i, "").trim();
      const tok = rest.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "") || "";
      const rank = this._RANKS.includes(tok) ? tok : null;
      return { kind: "grant_xp_vow", rank };
    }
    if (firstWord === "grant_xp" || lc.startsWith("grant_xp") || lc.startsWith("grant xp")) {
      const rest = body.replace(/^grant[_\s]xp/i, "").trim();
      const m2 = rest.match(/^([+]?\d+)\s*(.*)$/);
      if (!m2) return null;
      const amount = parseInt(m2[1], 10);
      if (!Number.isFinite(amount) || amount <= 0) return null;
      const reason = (m2[2] || "").replace(/^[:\-—|]+/, "").trim();
      return { kind: "grant_xp", amount, reason };
    }

    // ---- Combat / quest track directives (v0.3.0) ----
    // Accept underscores or spaces: "create_combat" or "create combat".
    const m = body.match(/^(create[_\s]combat|create[_\s]vow|create[_\s]journey|begin[_\s]journey|start[_\s]journey|undertake[_\s]journey|initiative|end[_\s]combat|complete[_\s]vow|fulfill[_\s]vow|end[_\s]vow|complete[_\s]track|complete[_\s]journey|end[_\s]journey)\b\s*(.*)$/i);
    if (m) {
      const verb = m[1].toLowerCase().replace(/\s+/g, "_");
      const rest = (m[2] || "").trim();

      if (verb === "initiative") {
        const r = rest.toLowerCase();
        if (/\b(gain|win|seize|seized|take|taken|control|in[-\s]?control)\b/.test(r)) return { kind: "initiative", value: "gain" };
        if (/\b(lose|lost|los[et]|forgo|forgone|forfeit|bad[-\s]?spot|out)\b/.test(r)) return { kind: "initiative", value: "lose" };
        return null;
      }

      if (verb === "create_combat") {
        // An IMPORTANT narrative foe (boss / unique antagonist not in the
        // official compendia) is flagged with a trailing keyword — `unique`,
        // `boss`, `narrative`, or `custom`. Strip it off before splitting so
        // the marker never leaks into the foe name, and record `important` so
        // the optional "not a real compendium foe" advisory is suppressed.
        let body2 = rest;
        let important = false;
        const mk = body2.match(/[\s(\[]+(unique|boss|narrative|custom)\)?\]?\s*$/i);
        if (mk) {
          important = true;
          body2 = body2.slice(0, mk.index).trim();
        }
        const { name, rank } = this._splitNameRank(body2);
        return name ? { kind: "create_combat", name, rank, important } : null;
      }

      if (verb === "create_vow") {
        const { name, rank, desc } = this._splitNameRank(rest);
        return name ? { kind: "create_vow", name, rank, description: desc } : null;
      }

      // Begin a journey progress track (the journey counterpart of create_vow).
      if (/^(create_journey|begin_journey|start_journey|undertake_journey)$/.test(verb)) {
        const { name, rank, desc } = this._splitNameRank(rest);
        return name ? { kind: "create_journey", name, rank, description: desc } : null;
      }

      if (verb === "end_combat") {
        const { name } = this._splitNameRank(rest);
        return name ? { kind: "end_combat", name } : null;
      }

      // Mark a vow / journey / progress track COMPLETE. All of these verbs
      // (complete_vow, fulfill_vow, end_vow, complete_track, complete_journey,
      // end_journey) collapse to one "complete_track" effect — completion is
      // the same operation regardless of the track's kind. We DO preserve the
      // implied kind (vow / journey) as `trackKind` so the completion path can
      // pick the right open track when the AI names it after the move (e.g.
      // "Fulfill Your Vow") or omits the name entirely. The name is optional:
      // an empty name lets the completion path fall back to the track the last
      // progress move actually rolled against (or the newest open track of the
      // implied kind), rather than dropping the directive.
      if (/^(complete_vow|fulfill_vow|end_vow|complete_track|complete_journey|end_journey)$/.test(verb)) {
        const { name } = this._splitNameRank(rest);
        const trackKind = /vow/.test(verb) ? "vow"
                        : /journey/.test(verb) ? "journey"
                        : null;
        return { kind: "complete_track", name: name || "", trackKind };
      }
    }
    return null;
  },

  /** Ironsworn rank words, used to split "Name <rank> [description]". */
  _RANKS: ["troublesome", "dangerous", "formidable", "extreme", "epic"],

  /**
   * Strip surrounding quotes and trailing punctuation from a directive tail,
   * yielding a clean entity name. Returns "" for empty/whitespace input.
   */
  _unquote(rest) {
    if (!rest) return "";
    let s = String(rest).trim();
    const q = s.match(/^["'“”]([^"'“”]+)["'“”]\s*$/);
    if (q) s = q[1];
    return s.replace(/^[:\-—|]+/, "").replace(/[:\-—|]+$/, "").trim();
  },

  /**
   * Split a directive tail of the form "<Name...> [rank] [description...]".
   * The rank token (if any of the canonical ranks appears) separates the
   * track name from an optional trailing description. When no rank token is
   * present, the whole string is treated as the name (rank=null).
   * @returns {{name:string, rank:string|null, desc:string}}
   */
  _splitNameRank(rest) {
    if (!rest) return { name: "", rank: null, desc: "" };
    const tokens = rest.split(/\s+/);
    const idx = tokens.findIndex(t =>
      this._RANKS.includes(t.toLowerCase().replace(/[^a-z]/g, "")));
    if (idx === -1) {
      return { name: rest.replace(/[:\-—|]+$/, "").trim(), rank: null, desc: "" };
    }
    const name = tokens.slice(0, idx).join(" ").replace(/[:\-—|]+$/, "").trim();
    const rank = tokens[idx].toLowerCase().replace(/[^a-z]/g, "");
    const desc = tokens.slice(idx + 1).join(" ").replace(/^[:\-—|]+/, "").trim();
    return { name, rank, desc };
  },

  /* ---------------- AI reply posting (with suggestion card) ---------------- */

  /**
   * Post the Skald's reply for the buffered (non-streaming) path. The
   * narration is displayed with any stray [[MOVE:…]] / metadata directive
   * stripped; suggested moves are NOT surfaced as a separate card — they are
   * woven into the prose itself and auto-linked inline by {@link EntityLinker}
   * (v0.10.10). We still parse the reply to capture the move's reason for the
   * next outcome narration's intent line.
   */
  async postReplyWithSuggestion(reply, { variant = "default", title } = {}) {
    const { suggestion, clean } = this.parseMoveSuggestion(reply);
    // (v0.10.10) Suggested moves are woven into the narration prose and
    // auto-linked inline by EntityLinker (clicking rolls them through the
    // progress-aware triggerMove path) — we no longer post a separate
    // "A Move Beckons" suggestion card. Any stray [[MOVE:…]] directive the
    // model still emits is stripped from the display by stripDirectivesForDisplay.
    await Chat.postSkald(formatMarkdown(stripDirectivesForDisplay(clean || reply)), { variant, title });
    // Capture the move's reason (if any) so the next outcome narration can
    // reference the player's intent, without surfacing a card.
    if (suggestion?.reason) this._lastIntent = suggestion.reason;
    return { suggestion, clean };
  },

  /**
   * Streaming-path counterpart of {@link postReplyWithSuggestion}. The
   * narration has already been rendered live (with directives stripped), and
   * any suggested move is woven into that prose and auto-linked inline by
   * {@link EntityLinker} — so there is NO separate suggestion card to post
   * (v0.10.10). We only parse the full raw reply to capture the move's reason
   * for the next outcome narration's intent line.
   */
  async postSuggestionFromReply(reply) {
    const { suggestion } = this.parseMoveSuggestion(reply);
    if (suggestion?.reason) this._lastIntent = suggestion.reason;
    return suggestion;
  },

  // (v0.10.10) The separate move-suggestion cards — the old pre-roll and
  // post-roll standalone suggestion-card lines that used to be posted as
  // their own chat messages — have been removed entirely. Move suggestions
  // are now woven directly into the
  // Skald's narration prose (see the prompt blocks in
  // buildIronswornPromptBlock) and auto-linked inline by EntityLinker, which
  // renders each move name as a clickable link that rolls through the
  // progress-aware IronswornController.triggerMove path (see the "link-move"
  // case in wireSuggestionCard). No standalone suggestion card is posted.

  /**
   * Wire up the buttons on a rendered suggestion card. Called from the
   * renderChatMessageHTML hook for messages carrying our suggestion flag.
   */
  wireSuggestionCard(message, html) {
    const root = (html instanceof HTMLElement) ? html : html?.[0];
    if (!root) return;
    const buttons = root.querySelectorAll?.("[data-skald-action]") ?? [];
    for (const btn of buttons) {
      if (btn.dataset.skaldWired === "1") continue;
      btn.dataset.skaldWired = "1";
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const action = btn.dataset.skaldAction;
        const move = btn.dataset.move;
        const moveDsId = btn.dataset.moveDsid;
        const stat = btn.dataset.stat;
        const oracle = btn.dataset.oracle;
        const track = btn.dataset.track;
        const asset = btn.dataset.asset;
        const assetUuid = btn.dataset.assetUuid;
        try {
          if (action === "roll-move") {
            await this.doTriggerMove(move, stat);
          } else if (action === "choose-move") {
            await this.showMoveSelector(stat);
          } else if (action === "link-oracle") {
            // An inline oracle link in narration — roll it and let the Skald
            // interpret the result (the same pipeline as the !oracle command).
            await this.doRollOracleLink(oracle);
          } else if (action === "link-track") {
            // An inline progress-track link — show its status and offer to
            // mark progress by rank.
            await this.showProgressTrackCard(track);
          } else if (action === "mark-track") {
            // The "Mark Progress" button on a progress-track card.
            await this.doMarkTrack(track);
          } else if (action === "complete-track") {
            // The "Mark Complete / Fulfill Vow" button on a progress-track card.
            await this.doCompleteTrack(track);
          } else if (action === "link-asset") {
            // An inline asset link — open the asset's card from the compendium.
            await this.showAssetLink(assetUuid || asset);
          } else if (action === "link-move") {
            // An inline move link in narration — roll it through the
            // progress-aware triggerMove path (v0.10.8). For ordinary moves
            // this opens the system's own official pre-roll dialog (resolved
            // via the Datasworn ID), exactly as before; for PROGRESS moves
            // ("Reach Your Destination" / "Fulfill Your Vow") it rolls the
            // matching track's progress score instead of dead-ending in the
            // generic dialog (which has no stat and no track context). Degrade
            // gracefully with a GM-visible note when the roll can't be made.
            if (!this.active()) {
              ui.notifications?.info(`${SKALD_NAME}: ${move} — Ironsworn system not active.`);
            } else {
              const ref = moveDsId || move;
              const actor = IronswornController.getActiveCharacter();
              const res = await IronswornController.triggerMove(ref, { actor, stat });
              if (res?.ok && res.method === "milestone") {
                // Milestone has no roll card — narrate it directly. triggerMove
                // ALREADY marked progress on the vow, so pass mechanicsApplied
                // to stop _narrateOutcome from marking it a SECOND time.
                try {
                  const fp = { moveName: "Reach a Milestone", outcome: "Progress Marked", score: null, challenge: [], match: false, resolved: true };
                  const summary = res.track ? `marked progress on vow "${res.track}" (now ${res.boxes ?? "?"}/10 boxes)` : "";
                  setTimeout(() => this._narrateOutcome(null, fp, { mechanicsApplied: true, autoSummary: summary })
                    .catch(e => console.warn(LOG_PREFIX, "milestone narration failed", e)), this._narrationDelayMs());
                } catch (_) {}
              } else if (!res?.ok) {
                await Chat.postSystem(
                  `<strong>The dice would not answer:</strong> ${escapeHtml(res?.error ?? "unknown error")}`,
                  { gmWhisper: true }
                );
              }
            }
          }
        } catch (e) {
          console.error(LOG_PREFIX, "suggestion button failed", e);
          ui.notifications?.error(`${SKALD_NAME}: ${e?.message ?? e}`);
        }
      });
    }
  },

  /* ---------------- Intelligent action → move mapping (v0.10.34) ---------------- */

  /**
   * Interpret a free-form player ACTION ("I explore the cave further") and, if it
   * clearly triggers an Ironsworn move, open that move's roll dialog (or a
   * confirmation card for ambiguous / less-certain cases) INSTEAD of narrating.
   * Questions and pure roleplay fall through to narration.
   *
   * This is the AI half of the hybrid classifier: the deterministic
   * `detectMoveDeclaration` (explicit move names) already ran and missed, so we
   * ask the model to classify the message. The PROMPT, PARSE and ROUTING logic
   * are all pure functions on IronswornController (unit-tested); this method only
   * owns the Foundry/AI side: the `Client.chat` call and the resulting UI action.
   *
   * Fully defensive: any failure (no API key, malformed reply, offline) is caught
   * and reported as "not handled" so the caller falls back to ordinary narration.
   *
   * @param {string} text  The player's free-form message (after "!").
   * @returns {Promise<{handled: boolean}>}  handled=true when a dialog/card was
   *   shown and narration must be suppressed; false to narrate as normal.
   */
  async classifyAndRouteAction(text) {
    if (!this.active()) return { handled: false };
    if (!text || typeof text !== "string" || !text.trim()) return { handled: false };
    try {
      // A light scene hint helps disambiguate combat-state-dependent actions
      // (e.g. "I attack" → Enter the Fray vs Strike vs Clash). Cheap & optional.
      let sceneContext = "";
      try {
        if (game.combat?.started) sceneContext = "The party is currently in active combat.";
      } catch (_) { /* defensive */ }

      const { system, user } = IronswornController.buildActionClassifierPrompt(text, { sceneContext });
      const messages = [
        { role: "system", content: system },
        { role: "user", content: user }
      ];
      // Low temperature + small budget → fast, deterministic classification.
      const reply = await Client.chat(messages, { temperature: 0.2, maxTokens: 250 });
      const parsed = IronswornController.parseActionClassification(reply);
      const alwaysConfirm = !!Settings.get("intelligentMoveConfirm");
      const decision = IronswornController.decideActionRouting(parsed, { alwaysConfirm });

      console.log(`${LOG_PREFIX} [skald] action classify → type=${parsed?.type ?? "?"} decision=${decision.action}${decision.move ? ` move="${decision.move.name}"` : ""}${decision.candidates ? ` candidates=${decision.candidates.map(c => c.name).join("|")}` : ""}`);

      if (decision.action === "roll" && decision.move?.name) {
        // Record the player's actual words as intent so the post-roll narration
        // can reference what they were trying to do.
        this._lastIntent = text.trim();
        await this.doTriggerMove(decision.move.name, decision.stat || undefined);
        return { handled: true };
      }

      if (decision.action === "confirm" && Array.isArray(decision.candidates) && decision.candidates.length) {
        this._lastIntent = text.trim();
        await this._postActionConfirmCard(decision.candidates, { reason: decision.reason, original: text.trim() });
        return { handled: true };
      }

      // "narrate" → let the caller run normal AI narration.
      return { handled: false };
    } catch (e) {
      console.warn(LOG_PREFIX, "[skald] action classification failed — falling back to narration", e);
      return { handled: false };
    }
  },

  /**
   * Post an interactive confirmation card offering one or more candidate moves
   * for an interpreted action. Each button reuses the existing
   * `data-skald-action="link-move"` wiring (auto-wired on render by
   * {@link Integration.wireSuggestionCard}), so clicking opens that move's
   * official pre-roll dialog. The player may also simply ignore the card and
   * keep narrating. No narration is generated until a move actually resolves.
   *
   * @param {Array<{move:object,name:string,stat:string,confidence:string}>} candidates
   * @param {object} [opts]
   * @param {string} [opts.reason]    Short rationale from the classifier.
   * @param {string} [opts.original]  The player's original message (for context).
   */
  async _postActionConfirmCard(candidates, { reason = "", original = "" } = {}) {
    const buttons = candidates.map((c) => {
      const dsid = c.move?.id ? ` data-move-dsid="${escapeHtml(c.move.id)}"` : "";
      const stat = c.stat ? ` data-stat="${escapeHtml(c.stat)}"` : "";
      const label = `${escapeHtml(c.name)}${c.stat ? ` +${escapeHtml(c.stat)}` : ""}`;
      return `<button type="button" class="es-action-move-btn" data-skald-action="link-move" data-move="${escapeHtml(c.name)}"${dsid}${stat}>${label}</button>`;
    }).join("");

    const ambiguous = candidates.length > 1;
    const lead = ambiguous
      ? "That action could call for more than one move. Which do you intend?"
      : "It sounds like this calls for a move. Roll it?";
    const tail = "<p class=\"es-action-confirm-note\"><em>Or simply keep narrating — no roll will be made unless you choose a move.</em></p>";
    const why = reason ? `<p class="es-action-confirm-why"><em>${escapeHtml(reason)}</em></p>` : "";

    const body =
      `<p>${lead}</p>` +
      why +
      `<div class="es-action-move-choices">${buttons}</div>` +
      tail;

    return Chat.postSkald(body, { variant: "oracle", title: ambiguous ? "Which Move?" : "Make a Move?" });
  },

  /* ---------------- Move triggering & selector ---------------- */

  /** Trigger a move through the Ironsworn controller (or manual fallback). */
  async doTriggerMove(moveName, stat) {
    if (!this.active()) {
      ui.notifications?.warn(`${SKALD_NAME}: Ironsworn system not active — cannot roll moves.`);
      return null;
    }
    this._lastIntent = `${moveName}${stat ? ` +${stat}` : ""}` + (this._lastIntent ? ` — ${this._lastIntent}` : "");
    const actor = IronswornController.getActiveCharacter();
    // (v0.10.38 — Phase 4) Asset bonus advisory: a non-blocking suggestion if
    // one of the character's assets grants a bonus that plausibly applies to
    // this move. Purely informational — the player applies it in the dialog.
    try { await this._maybeAdviseAssetBonuses(actor, moveName, stat); }
    catch (e) { console.warn(LOG_PREFIX, "asset bonus advisory failed", e); }
    const res = await IronswornController.triggerMove(moveName, { actor, stat });
    if (!res?.ok) {
      await Chat.postSystem(
        `<strong>The dice would not answer:</strong> ${escapeHtml(res?.error ?? "unknown error")}`,
        { gmWhisper: true }
      );
    }
    // "Reach a Milestone" produces no roll card, so onIronswornRoll won't
    // fire. Narrate it directly here so the Skald acknowledges the milestone.
    if (res?.ok && res.method === "milestone") {
      // triggerMove already marked progress; tell _narrateOutcome the
      // mechanics are applied so it does NOT mark the vow a second time.
      const summary = res.track ? `marked progress on vow "${res.track}" (now ${res.boxes ?? "?"}/10 boxes)` : "";
      const milestoneDelayed = async () => {
        try {
          const fakeParsed = { moveName: "Reach a Milestone", outcome: "Progress Marked", score: null, challenge: [], match: false, resolved: true };
          await this._narrateOutcome(null, fakeParsed, { mechanicsApplied: true, autoSummary: summary });
        } catch (e) { console.warn(LOG_PREFIX, "milestone narration failed", e); }
      };
      setTimeout(milestoneDelayed, this._narrationDelayMs());
      return res;
    }
    // The resulting Ironsworn roll card (or manual card) is picked up by
    // onIronswornRoll(), which narrates the outcome.
    return res;
  },

  /**
   * (v0.10.38 — Phase 4) Asset Bonus Advisory.
   *
   * Before a move resolves, scan the active character's enabled asset
   * abilities for a roll bonus that plausibly applies to this move and, if
   * found, post a small non-blocking chat suggestion. The player chooses
   * whether to apply it in the official roll dialog — the Skald never
   * touches the roll itself, preserving full player agency and roll-system
   * stability. Fully gated by the `assetBonusAdvisory` setting (default ON).
   *
   * @param {Actor|null} actor      the rolling character (may be null)
   * @param {string}     moveName   the move being made
   * @param {string}     [stat]     the stat being rolled (optional)
   */
  async _maybeAdviseAssetBonuses(actor, moveName, stat) {
    try {
      if (!Settings.get("assetBonusAdvisory")) return;
    } catch (_) { return; }
    if (!actor || !moveName) return;
    let assets;
    try { assets = IronswornController.getAssets(actor); }
    catch (_) { return; }
    const hits = IronswornController.detectAssetBonuses(assets, moveName, { stat: stat || "" });
    if (!Array.isArray(hits) || !hits.length) return;
    const items = hits.map((h) => {
      const cond = h.condition
        ? ` — <em>${escapeHtml(h.condition)}</em>`
        : "";
      return `<li>💡 Your <strong>${escapeHtml(h.asset)}</strong> grants <strong>+${h.bonus}</strong>${cond}</li>`;
    }).join("");
    const body =
      `<p>You may have an asset bonus for <strong>${escapeHtml(moveName)}</strong>:</p>` +
      `<ul class="es-asset-advisory">${items}</ul>` +
      `<p class="es-action-confirm-note"><em>If it applies, add it yourself in the roll dialog — your call.</em></p>`;
    try { await Chat.postSkald(body, { variant: "oracle", title: "Asset Bonus?" }); }
    catch (e) { console.warn(LOG_PREFIX, "asset advisory post failed", e); }
  },

  /* ---------------- Inline entity-link handlers (v0.7.0) ---------------- */

  /**
   * Handle a click on an inline oracle link: roll the oracle through the
   * shared {@link OracleInterpreter} so the result is posted and narrated
   * exactly like the `!oracle` command. Degrades gracefully.
   */
  async doRollOracleLink(alias) {
    try {
      if (typeof OracleInterpreter === "undefined" || typeof OracleInterpreter.roll !== "function") {
        ui.notifications?.info(`${SKALD_NAME}: oracle roller unavailable.`);
        return;
      }
      await OracleInterpreter.roll(alias);
    } catch (e) {
      console.error(LOG_PREFIX, "oracle link failed", e);
      ui.notifications?.error(`${SKALD_NAME}: ${e?.message ?? e}`);
    }
  },

  /**
   * Handle a click on an inline progress-track link: post a compact card
   * showing the track's current boxes/rank, with a button to mark progress
   * by its rank. Degrades gracefully when the system/actor is unavailable.
   */
  async showProgressTrackCard(trackName) {
    try {
      if (!this.active()) {
        ui.notifications?.info(`${SKALD_NAME}: ${trackName} — Ironsworn system not active.`);
        return;
      }
      const actor = IronswornController.getActiveCharacter();
      if (!actor) {
        ui.notifications?.warn(`${SKALD_NAME}: no active character to read "${trackName}".`);
        return;
      }
      // Resolve the ACTUAL sheet Item this reference points at — read straight
      // from actor.items (the single source of truth), never a cached/parallel
      // copy. A generic word like "vow" resolves to the character's real
      // current vow (e.g. "The Truth of the Star-Fall") instead of matching a
      // phantom literally-named track. We then read the track's live state from
      // the freshly-built progress-track view so boxes/ticks/completion always
      // mirror the sheet.
      const item = IronswornController.resolveDisplayTrack(actor, trackName);
      if (!item) {
        ui.notifications?.info(`${SKALD_NAME}: progress track "${trackName}" not found on ${actor.name}.`);
        return;
      }
      const tracks = IronswornController.getProgressTracks(actor) ?? [];
      const track = tracks.find(t => t.id === item.id);
      if (!track) {
        ui.notifications?.info(`${SKALD_NAME}: progress track "${trackName}" not found on ${actor.name}.`);
        return;
      }

      const boxes = typeof track.boxes === "number" ? track.boxes : Math.floor((track.current ?? 0) / 4);
      const rank = track.rank ? `<span class="es-track-rank">${escapeHtml(String(track.rank))}</span>` : "";
      const done = track.completed ? " ✓" : "";
      // Classify the track so we can flavour the labels. A track is a vow or a
      // journey if EITHER the system subtype/type says so OR our own trackKind
      // flag (set when the Skald created it) says so — the latter catches
      // journeys the system stores as a generic "progress" track.
      const klass   = String(track.kind || track.subtype || track.type || "").toLowerCase();
      const isVow     = klass === "vow";
      const isJourney = klass === "journey";
      const noun = isVow ? "vow" : isJourney ? "journey" : "track";
      const completeLabel = isVow     ? "Fulfill Vow (mark complete)"
                          : isJourney ? "Reach Destination (mark complete)"
                          :             "Mark Complete";

      // Action buttons: marking progress is always available; "Mark Complete"
      // is offered only while the track is still open. A completed track shows
      // a static note instead so the player has clear feedback.
      const buttons = track.completed
        ? `<p class="es-track-complete-note"><em>✓ This ${noun} is complete.</em></p>`
        : `
          <div class="es-move-buttons">
            <button type="button" class="es-btn es-btn-roll"
                    data-skald-action="mark-track"
                    data-track="${escapeHtml(track.name)}">▰ Mark Progress (by rank)</button>
            <button type="button" class="es-btn es-btn-complete"
                    data-skald-action="complete-track"
                    data-track="${escapeHtml(track.name)}">✓ ${escapeHtml(completeLabel)}</button>
          </div>`;

      const body = `
        <div class="es-track-card">
          <p class="es-track-name"><strong>${escapeHtml(track.name)}</strong>${done} ${rank}</p>
          <p class="es-track-progress">Progress: <strong>${boxes}/10</strong> boxes
             <span class="es-track-ticks">(${track.current ?? 0}/40 ticks)</span></p>
          ${buttons}
        </div>`;
      const cardTitle = isVow ? "Vow" : isJourney ? "Journey" : "Progress Track";
      await Chat.postSkald(body, { variant: "suggest", title: cardTitle });
    } catch (e) {
      console.error(LOG_PREFIX, "progress-track link failed", e);
      ui.notifications?.error(`${SKALD_NAME}: ${e?.message ?? e}`);
    }
  },

  /** Mark progress on a track by its rank (wired from the track card). */
  async doMarkTrack(trackName) {
    try {
      if (!this.active()) return;
      const actor = IronswornController.getActiveCharacter();
      if (!actor) {
        ui.notifications?.warn(`${SKALD_NAME}: no active character to mark "${trackName}".`);
        return;
      }
      const res = await IronswornController.markProgressByRank(actor, trackName, 1);
      if (res?.ok) {
        ui.notifications?.info(`${SKALD_NAME}: marked progress on ${res.track} — ${res.boxes}/10 boxes.`);
      } else {
        ui.notifications?.warn(`${SKALD_NAME}: ${res?.error ?? "could not mark progress."}`);
      }
    } catch (e) {
      console.error(LOG_PREFIX, "mark-track failed", e);
      ui.notifications?.error(`${SKALD_NAME}: ${e?.message ?? e}`);
    }
  },

  /**
   * Mark a progress track (vow / journey / bond / etc.) COMPLETE — wired from
   * the "Mark Complete / Fulfill Vow" button on a progress-track card. This is
   * the manual counterpart to the [[EFFECT: complete_vow …]] directive; both
   * funnel through {@link IronswornController.completeTrack}.
   *
   * Note: Ironsworn lets you fulfill a vow at ANY progress level (the Fulfill
   * Your Vow roll simply gets harder when progress is low), so completion is
   * intentionally NOT gated on a full track — the player decides when the vow
   * is met in the fiction.
   */
  async doCompleteTrack(trackName) {
    try {
      if (!this.active()) {
        ui.notifications?.info(`${SKALD_NAME}: ${trackName} — Ironsworn system not active.`);
        return;
      }
      const actor = IronswornController.getActiveCharacter();
      if (!actor) {
        ui.notifications?.warn(`${SKALD_NAME}: no active character to complete "${trackName}".`);
        return;
      }
      const res = await IronswornController.completeTrack(actor, trackName);
      if (res?.ok) {
        ui.notifications?.info(`${SKALD_NAME}: “${res.name}” marked complete. 🏆`);
        if (Settings.get("showEffectAnnouncements") !== false) {
          await Chat.postSystem(`<em>The Skald enacts: completed “${escapeHtml(res.name)}”.</em>`, { gmWhisper: true });
        }
        // Re-post the (now-completed) track card so the chat reflects the
        // new state and the player gets immediate visual confirmation.
        try { await this.showProgressTrackCard(res.name); } catch (_) {}
      } else {
        ui.notifications?.warn(`${SKALD_NAME}: ${res?.error ?? "could not mark complete."}`);
      }
    } catch (e) {
      console.error(LOG_PREFIX, "complete-track failed", e);
      ui.notifications?.error(`${SKALD_NAME}: ${e?.message ?? e}`);
    }
  },

  /**
   * Handle a click on an inline asset link: open the asset's card (sheet)
   * from the compendium via the controller. Degrades gracefully.
   */
  async showAssetLink(ref) {
    try {
      if (!this.active()) {
        ui.notifications?.info(`${SKALD_NAME}: ${ref} — Ironsworn system not active.`);
        return;
      }
      const res = await IronswornController.showAsset(ref);
      if (!res?.ok) {
        ui.notifications?.info(`${SKALD_NAME}: could not open asset — ${res?.error ?? "not found."}`);
      }
    } catch (e) {
      console.error(LOG_PREFIX, "asset link failed", e);
      ui.notifications?.error(`${SKALD_NAME}: ${e?.message ?? e}`);
    }
  },

  /** Show a dialog letting the user pick any catalogued move + stat. */
  async showMoveSelector(prefillStat = "") {
    const grouped = {};
    for (const m of IronswornController.moves) {
      (grouped[m.cat] ??= []).push(m);
    }
    const optgroups = Object.entries(grouped).map(([cat, moves]) => {
      const opts = moves.map(m => `<option value="${escapeHtml(m.name)}" data-stats="${escapeHtml(m.stats.join(','))}">${escapeHtml(m.name)}</option>`).join("");
      return `<optgroup label="${escapeHtml(cat)}">${opts}</optgroup>`;
    }).join("");

    const statOpts = ["", "edge", "heart", "iron", "shadow", "wits"].map(s =>
      `<option value="${s}"${s === prefillStat ? " selected" : ""}>${s ? s[0].toUpperCase() + s.slice(1) : "— (no stat)"}</option>`
    ).join("");

    const content = `
      <form class="es-move-selector">
        <div class="form-group">
          <label>Move</label>
          <select name="move">${optgroups}</select>
        </div>
        <div class="form-group">
          <label>Stat</label>
          <select name="stat">${statOpts}</select>
        </div>
      </form>`;

    const doRoll = async (htmlEl) => {
      const root = (htmlEl instanceof HTMLElement) ? htmlEl : htmlEl?.[0] ?? document;
      const move = root.querySelector?.('select[name="move"]')?.value;
      const stat = root.querySelector?.('select[name="stat"]')?.value ?? "";
      if (move) await this.doTriggerMove(move, stat);
    };

    // Prefer DialogV2 (v13+) but fall back to the classic Dialog.
    try {
      const DV2 = foundry?.applications?.api?.DialogV2;
      if (DV2) {
        await DV2.prompt({
          window: { title: "Choose a Move" },
          content,
          ok: { label: "Roll Move", callback: (_ev, button) => doRoll(button.form) },
          rejectClose: false
        });
        return;
      }
    } catch (e) { console.warn(LOG_PREFIX, "DialogV2 failed, trying classic Dialog", e); }

    try {
      // eslint-disable-next-line no-undef
      new Dialog({
        title: "Choose a Move",
        content,
        buttons: {
          roll:   { icon: '<i class="fas fa-dice-d20"></i>', label: "Roll Move", callback: (html) => doRoll(html) },
          cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
        },
        default: "roll"
      }).render(true);
    } catch (e) {
      console.error(LOG_PREFIX, "No dialog API available", e);
      ui.notifications?.error(`${SKALD_NAME}: cannot open move selector.`);
    }
  },

  /* ---------------- Roll-result listener ---------------- */

  /** Verbose log gated behind the debugLogging world setting. */
  _dbg(...args) {
    try {
      if (Settings.get("debugLogging")) console.log(LOG_PREFIX, "[Ironsworn]", ...args);
    } catch (_) { /* settings may not be ready */ }
  },

  /* ---------------- Combat UI feedback ---------------- */

  /** Toast for combat-track lifecycle events (create / vow / end). */
  _notifyCombat(msg) {
    try { ui.notifications?.info(`${SKALD_NAME}: ${msg}`); } catch (_) {}
    this._dbg(`notify: ${msg}`);
  },

  /** Toast + flavour for an initiative change. */
  _notifyInitiative(gained) {
    const msg = gained
      ? "⚔ You seize the initiative — you are in control."
      : "⚠ You lose the initiative — you are in a bad spot.";
    try { gained ? ui.notifications?.info(`${SKALD_NAME}: ${msg}`)
                 : ui.notifications?.warn(`${SKALD_NAME}: ${msg}`); } catch (_) {}
    this._dbg(`notify: initiative ${gained ? "gained" : "lost"}`);
  },

  /** Toast for a progress mark on a combat track. */
  _notifyProgress(trackName, boxes) {
    try { ui.notifications?.info(`${SKALD_NAME}: progress on ${trackName} — ${boxes}/10 boxes.`); } catch (_) {}
    this._dbg(`notify: progress on ${trackName} → ${boxes}/10`);
  },

  /**
   * Console audit log for an AI-driven progress-track WRITE directive
   * (v0.10.27). Records every attempt — success or failure — so a GM can trace
   * exactly what the Skald changed and why. Never throws.
   * @param {string}  verb     "MARK_COMPLETE" | "ADD_PROGRESS" | "SET_PROGRESS"
   * @param {object}  eff      the parsed effect ({trackKind, name, boxes?})
   * @param {boolean} ok       whether the write succeeded
   * @param {string}  [detail] human-readable outcome / error
   */
  _auditWrite(verb, eff, ok, detail = "") {
    try {
      const tag = ok ? "✓" : "✗";
      const box = (eff?.boxes != null) ? `:${eff.boxes}` : "";
      console.log(
        `${LOG_PREFIX} [track-write ${tag}] ${verb} ${eff?.trackKind ?? "?"}:"${eff?.name ?? ""}"${box}`
        + (detail ? ` — ${detail}` : "")
      );
    } catch (_) { /* audit logging must never break a write */ }
  },

  /**
   * Inspect a freshly-created (or updated) ChatMessage. If it is an
   * Ironsworn move roll (or our own manual move roll), parse the outcome
   * and feed it to the AI for narration + optional mechanical effects.
   *
   * IMPORTANT — how the modern foundry-ironsworn system stores rolls:
   * It does NOT tag its move cards with `flags["foundry-ironsworn"]`.
   * Instead it serialises the roll into the card's HTML as
   *   <article class="ironsworn-roll" data-ironswornroll='{…json…}'>…
   * and attaches the Foundry Roll on `message.rolls`. We therefore detect
   * on those signals, not on a flag namespace (which is what the earlier
   * version checked — that is why auto-narration never fired).
   *
   * @param {ChatMessage} message
   * @param {{viaUpdate?: boolean}} [opts]
   */
  async onIronswornRoll(message, { viaUpdate = false } = {}) {
    try {
      this._dbg(`onIronswornRoll fired (viaUpdate=${viaUpdate}, id=${message?.id})`);

      if (!this.active())                              { this._dbg("→ skip: integration inactive"); return; }
      if (!(Settings.get("autoNarrateMoves") ?? true)) { this._dbg("→ skip: autoNarrateMoves disabled"); return; }
      if (!game.user?.isGM)                            { this._dbg("→ skip: not the GM client"); return; }
      if (!message?.id)                                { this._dbg("→ skip: message has no id"); return; }
      if (this._processedRolls.has(message.id))        { this._dbg("→ skip: already narrated this roll"); return; }

      const ourFlags = message?.flags?.[MODULE_ID];
      // Skip our own non-roll cards (narration, suggestions, etc.).
      if (ourFlags && !ourFlags.manualMove) { this._dbg("→ skip: our own non-roll card"); return; }

      const detection = this._detectIronswornRoll(message);
      if (!detection.isRoll) { this._dbg("→ skip: not an Ironsworn roll card"); return; }
      this._dbg(`→ Ironsworn roll card detected (source=${detection.source})`);

      const parsed = this._parseRollOutcome(message);
      if (!parsed) { this._dbg("→ skip: could not parse roll outcome from card"); return; }
      if (!parsed.resolved) {
        // e.g. extra challenge dice not yet resolved — wait for the
        // updateChatMessage hook to fire with the resolved content.
        this._dbg(`→ roll not yet resolved (move="${parsed.moveName}"); awaiting update`);
        return;
      }

      // Mark processed up-front so re-renders / the update hook don't
      // double-narrate the same roll.
      this._processedRolls.add(message.id);
      console.log(LOG_PREFIX, `Detected Ironsworn roll: ${parsed.moveName} → ${parsed.outcome}`);

      // Let the dice settle (incl. Dice So Nice 3D animation) before the
      // Skald speaks over the result.
      const delay = this._narrationDelayMs();
      this._dbg(`→ auto-narration scheduled in ${delay}ms`);
      setTimeout(() => {
        this._narrateOutcome(message, parsed).catch(e =>
          console.warn(LOG_PREFIX, "delayed _narrateOutcome failed", e));
      }, delay);
    } catch (e) {
      console.warn(LOG_PREFIX, "onIronswornRoll failed", e);
    }
  },

  /**
   * How long to wait before narrating, allowing dice animations to finish.
   * Reads the configurable "narrationDelay" world setting (ms), clamped to
   * the 0–5000 range. Falls back to 2000ms if the setting isn't available.
   */
  _narrationDelayMs() {
    let ms = Settings.get("narrationDelay");
    if (typeof ms !== "number" || Number.isNaN(ms)) ms = 2000;
    return Math.max(0, Math.min(5000, ms));
  },

  /**
   * (v0.10.25 — XP tracking) Narrate an experience milestone that the
   * Ironsworn system has ALREADY recorded on the character sheet. This is a
   * purely OBSERVE-ONLY reaction: the diff-watcher hook (see the
   * `updateActor` registration near the bottom of this file) detects that the
   * `system.xp` counter rose, or that a Starforged legacy track advanced, and
   * hands us the pre-computed positive delta. We never compute, write, or
   * spend XP ourselves — that stays entirely under the player's / system's
   * control.
   *
   * Fully defensive: every guard fails safe and the narration is fire-and-
   * forget, so an AI hiccup can never block the sheet update that triggered
   * it.
   *
   * @param {Actor}  actor   the actor whose experience changed.
   * @param {object} info
   * @param {number} [info.xpDelta]    positive change in `system.xp`, if any.
   * @param {number} [info.newXp]      the new total `system.xp`, if known.
   * @param {Array<{name:string,delta:number}>} [info.legacyDeltas]
   *        positive advances on named legacy tracks (Starforged), if any.
   * @returns {Promise<void>}
   */
  async onXpGain(actor, info = {}) {
    try {
      if (!this.active()) return;
      if (!actor) return;
      if ((Settings.get("autoNarrateXp") ?? true) === false) return;

      const parts = [];
      if (typeof info.xpDelta === "number" && info.xpDelta > 0) {
        const total = typeof info.newXp === "number" ? ` (now ${info.newXp} total)` : "";
        parts.push(`earned ${info.xpDelta} experience${total}`);
      }
      if (Array.isArray(info.legacyDeltas)) {
        for (const d of info.legacyDeltas) {
          if (d && typeof d.delta === "number" && d.delta > 0) {
            parts.push(`advanced their ${d.name} legacy by ${d.delta} tick${d.delta === 1 ? "" : "s"}`);
          }
        }
      }
      if (!parts.length) return; // nothing positive to celebrate

      const summary = `${actor.name} has ${parts.join(" and ")}.`;
      const ctx = this.gatherContext();
      const task = `The hero has just gained experience — a moment of growth worth marking.
What happened: ${summary}
Narrate this milestone briefly and evocatively as the Skald (1–3 sentences), framing it as hard-won growth that flows from recent deeds. Do NOT invent specific mechanical rewards, do NOT tell the player how to spend the experience, and do NOT emit any [[EFFECT:…]] or [[MOVE:…]] directives — this is pure narration of growth the rules have already recorded.`;

      const messages = [
        { role: "system", content: buildSystemPrompt({ task, context: ctx, allowEffects: false, allowFollowups: false, allowJournal: true }) }
      ];

      const cardOpts = { variant: "lore", title: "A Milestone of Growth" };
      const streaming = Settings.get("streamingEnabled") !== false;
      let reply;
      if (streaming) {
        ({ reply } = await callSkaldStreaming(messages, { ...cardOpts, chatOpts: { temperature: 0.85, maxTokens: 220 } }));
      } else {
        reply = await Client.chat(messages, { temperature: 0.85, maxTokens: 220 });
        await Chat.postSkald(formatMarkdown(stripDirectivesForDisplay(reply)), cardOpts);
      }
      // Fire-and-forget chronicle ingestion (never blocks/breaks play).
      try { JournalSystem.ingestReply(reply, { channel: "lore" }); } catch (_) { /* defensive */ }
    } catch (e) {
      console.warn(LOG_PREFIX, "onXpGain narration failed", e?.message ?? e);
    }
  },

  /**
   * Decide whether a chat message is an Ironsworn roll card.
   * @returns {{isRoll: boolean, source: string|null}}
   */
  _detectIronswornRoll(message) {
    const ourFlags = message?.flags?.[MODULE_ID];
    if (ourFlags?.manualMove) return { isRoll: true, source: "manual" };

    // Some/legacy versions DO set namespaced flags — honour them if present.
    const isFlags = message?.flags?.["foundry-ironsworn"];
    if (isFlags && (isFlags.moveDfId || isFlags.moveId || isFlags.dsid || isFlags.moveDsId)) {
      return { isRoll: true, source: "flags" };
    }

    // Modern system: the roll is serialised into the card HTML.
    const content = typeof message?.content === "string" ? message.content : "";
    if (/data-ironswornroll\s*=/.test(content) ||
        /class\s*=\s*['"][^'"]*\bironsworn-roll\b/.test(content)) {
      return { isRoll: true, source: "html" };
    }

    return { isRoll: false, source: null };
  },

  /**
   * Derive { moveName, outcome, score, challenge, match, resolved } from a
   * message. Tries, in order: our manual card flag → the serialised
   * `data-ironswornroll` HTML blob → the attached Foundry Roll dice.
   */
  _parseRollOutcome(message) {
    const ourFlags = message?.flags?.[MODULE_ID];

    // Manual move card: outcome already computed by the controller.
    if (ourFlags?.manualMove) {
      return {
        moveName:  ourFlags.moveName ?? "Move",
        outcome:   ourFlags.outcome ?? "",
        score:     ourFlags.score ?? null,
        challenge: ourFlags.challenge ?? [],
        match:     !!ourFlags.match,
        resolved:  true
      };
    }

    const fromHtml = this._parseFromHtml(message);
    if (fromHtml) { this._dbg("parsed outcome from card HTML:", JSON.stringify(fromHtml)); return fromHtml; }

    const fromRolls = this._parseFromRolls(message);
    if (fromRolls) { this._dbg("parsed outcome from message.rolls:", JSON.stringify(fromRolls)); return fromRolls; }

    return null;
  },

  /** Parse the serialised `data-ironswornroll` blob (+ rendered text) from card HTML. */
  _parseFromHtml(message) {
    const content = typeof message?.content === "string" ? message.content : "";
    if (!content) return null;

    let doc = null;
    try { doc = new DOMParser().parseFromString(content, "text/html"); } catch (_) { doc = null; }

    const titleText = doc?.querySelector?.(".ironsworn-roll-title")?.textContent?.trim();
    const outcomeText = doc?.querySelector?.(".outcome-text")?.textContent?.trim();

    // Pull the serialised roll JSON out of the article's data attribute.
    let serialized = null;
    const raw = doc?.querySelector?.("[data-ironswornroll]")?.getAttribute?.("data-ironswornroll");
    if (raw) { try { serialized = JSON.parse(raw); } catch (e) { this._dbg("data-ironswornroll JSON parse failed", e); } }

    if (serialized) {
      const pre  = serialized.preRollOptions  ?? {};
      const post = serialized.postRollOptions ?? {};
      const isProgress = pre.progress != null;

      const adds    = Number(pre.adds ?? 0) || 0;
      const statVal = Number(pre.stat?.value ?? 0) || 0;
      const action  = isProgress
        ? Number(pre.progress?.value ?? NaN)
        : Number(serialized.rawActionDieValue ?? NaN);

      // Challenge dice — post-roll replacements (momentum burn / resolve) win.
      const challenge = Array.isArray(serialized.rawChallengeDiceValues)
        ? serialized.rawChallengeDiceValues.slice(0, 2).map(Number)
        : [];
      if (post.replacedChallenge1?.value != null) challenge[0] = Number(post.replacedChallenge1.value);
      if (post.replacedChallenge2?.value != null) challenge[1] = Number(post.replacedChallenge2.value);

      const moveName =
        this._moveNameFromTitle(titleText) ??
        this._prettyMoveName(pre.moveDsId ?? pre.moveId ?? "their move");

      const haveAction = Number.isFinite(action);
      const haveChallenge = challenge.length === 2 && challenge.every(Number.isFinite);

      if (haveAction && haveChallenge) {
        const score = isProgress ? action : Math.min(action + statVal + adds, 10);
        const beats = challenge.filter(c => score > c).length;
        // Honour an explicit replaced/automatic outcome when the system set one.
        const forced =
          (typeof post.replacedOutcome?.value === "number") ? post.replacedOutcome.value :
          (typeof pre.automaticOutcome?.value === "number")  ? pre.automaticOutcome.value  : null;
        const ov = forced != null ? forced : (beats === 2 ? 2 : beats === 1 ? 1 : 0);
        const outcome = ov === 2 ? "Strong Hit" : ov === 1 ? "Weak Hit" : "Miss";
        return { moveName, outcome, score, challenge, match: challenge[0] === challenge[1], resolved: true };
      }

      // Dice not fully resolved yet — but if the system already rendered an
      // outcome label, trust it.
      const norm = this._normalizeOutcomeText(outcomeText);
      if (norm) return { moveName, outcome: norm, score: null, challenge, match: false, resolved: true };
      return { moveName, outcome: "", score: null, challenge, match: false, resolved: false };
    }

    // No serialised blob — fall back to the rendered title + outcome text.
    const norm = this._normalizeOutcomeText(outcomeText);
    if (titleText || norm) {
      const moveName = this._moveNameFromTitle(titleText) ?? "their move";
      if (norm) return { moveName, outcome: norm, score: null, challenge: [], match: false, resolved: true };
      return { moveName, outcome: "", score: null, challenge: [], match: false, resolved: false };
    }
    return null;
  },

  /** Fallback: derive an outcome from the attached Foundry Roll dice. */
  _parseFromRolls(message) {
    const rolls = message?.rolls ?? [];
    if (!rolls.length) return null;

    const allDice = rolls.flatMap(r => r.dice ?? []);
    const d10s = allDice.filter(d => d.faces === 10).flatMap(d => (d.results ?? []).map(r => r.result));
    const d6   = allDice.find(d => d.faces === 6);
    if (!d6 || d10s.length < 2) return null;

    const score = Math.min(rolls[0]?.total ?? d6.results?.[0]?.result ?? 0, 10);
    const challenge = d10s.slice(0, 2);
    const beats = challenge.filter(c => score > c).length;
    const outcome = beats === 2 ? "Strong Hit" : beats === 1 ? "Weak Hit" : "Miss";

    const isFlags = message?.flags?.["foundry-ironsworn"] ?? {};
    const moveName = this._prettyMoveName(
      isFlags.moveName ?? isFlags.move?.name ?? isFlags.dsid ?? isFlags.moveId ?? isFlags.moveDfId ?? "their move"
    );
    return { moveName, outcome, score, challenge, match: challenge[0] === challenge[1], resolved: true };
  },

  /** "Face Danger +iron" → "Face Danger"; "Fulfill Your Vow: X" → "Fulfill Your Vow". */
  _moveNameFromTitle(title) {
    if (!title || typeof title !== "string") return null;
    let t = title.split(/\s+\+/)[0];   // strip " +stat"
    t = t.split(":")[0];               // strip ": <progress source>"
    t = t.trim();
    return t || null;
  },

  /** Map a rendered outcome label to canonical text. */
  _normalizeOutcomeText(text) {
    if (!text || typeof text !== "string") return null;
    const lc = text.toLowerCase();
    if (lc.includes("strong")) return "Strong Hit";
    if (lc.includes("weak"))   return "Weak Hit";
    if (lc.includes("miss"))   return "Miss";
    return null;
  },

  _prettyMoveName(raw) {
    if (typeof raw !== "string") return "their move";
    // Turn "move:classic/adventure/face_danger" → "Face Danger".
    const tail = raw.split("/").pop() ?? raw;
    if (/^[a-z_]+$/.test(tail)) {
      return tail.split("_").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
    }
    return raw;
  },

  /**
   * Ask the AI to narrate an outcome and (optionally) apply effects.
   *
   * @param {ChatMessage|null} message  the originating roll card, if any.
   * @param {object} parsed             parsed roll/move facts.
   * @param {object} [opts]
   * @param {boolean} [opts.mechanicsApplied=false] when true, the deterministic
   *        mechanics for this move were ALREADY applied by the caller (e.g.
   *        triggerMove() executed "Reach a Milestone" and marked progress), so
   *        the auto-flows here MUST be skipped to avoid double-applying them.
   * @param {string}  [opts.autoSummary]  a ready-made summary line describing
   *        the mechanics the caller already applied, fed to the narration
   *        prompt so the AI knows what happened (and is told not to re-emit it).
   */
  async _narrateOutcome(message, parsed, opts = {}) {
    const actor = message?.speakerActor ?? IronswornController.getActiveCharacter();
    const allowEffects = Settings.get("aiAppliesEffects") ?? true;

    // 1. Apply the deterministic combat mechanics FIRST (initiative on
    //    Enter the Fray; harm/progress + initiative on Strike/Clash). This
    //    keeps the rules correct regardless of what the AI narrates, and
    //    gives us a factual summary to feed into the narration prompt.
    //
    //    When the caller already applied the mechanics (opts.mechanicsApplied
    //    — e.g. triggerMove() ran "Reach a Milestone" and marked the vow), we
    //    do NOT re-run the auto-flows here: doing so would mark progress a
    //    SECOND time (advancing the track by 2× rank). We reuse the caller's
    //    summary so the AI still narrates the correct, single effect.
    let autoSummary = "";
    if (opts.mechanicsApplied) {
      autoSummary = String(opts.autoSummary ?? "");
    } else if (allowEffects) {
      const autoParts = [];
      try { const c = await this._autoCombatFlow(parsed, actor);  if (c) autoParts.push(c); }
      catch (e) { console.warn(LOG_PREFIX, "_autoCombatFlow failed", e); }
      // Journey side: on "Undertake a Journey" ensure a journey track exists
      // and (on a hit) advance it, so "Reach Your Destination" can later roll.
      try { const j = await this._autoJourneyFlow(parsed, actor); if (j) autoParts.push(j); }
      catch (e) { console.warn(LOG_PREFIX, "_autoJourneyFlow failed", e); }
      try { const m = await this._autoMilestoneFlow(parsed, actor); if (m) autoParts.push(m); }
      catch (e) { console.warn(LOG_PREFIX, "_autoMilestoneFlow failed", e); }
      // (v0.10.27) Roll-result integration for the COMPLETION moves
      // ("Fulfill Your Vow" / "End the Fight" / "Reach Your Destination"):
      // strong hit auto-finishes the targeted track; weak/miss leave it open
      // and only steer the narration toward consequences.
      try { const fin = await this._autoCompletionFlow(parsed, actor); if (fin) autoParts.push(fin); }
      catch (e) { console.warn(LOG_PREFIX, "_autoCompletionFlow failed", e); }
      autoSummary = autoParts.join("; ");
    }

    const ctx = this.gatherContext();
    const intent = this._lastIntent ? `\nThe player's intent: ${this._lastIntent}` : "";
    const autoLine = autoSummary
      ? `\nMechanical effects ALREADY applied automatically (do NOT re-emit initiative or progress effects for this move): ${autoSummary}`
      : "";
    const task = `A move has just been resolved by the dice.
Move: ${parsed.moveName}
Outcome: ${parsed.outcome}${parsed.match ? " (MATCH — add a twist)" : ""}
Action score: ${parsed.score ?? "?"} vs challenge dice ${(parsed.challenge ?? []).join(" / ") || "?"}.${intent}${autoLine}
Narrate this outcome vividly as the Skald (2–4 sentences).${allowEffects ? " Then append any warranted [[EFFECT:…]] directives that were NOT already applied above." : " Do not emit effect directives; simply narrate."} Finally, close with a brief forward-looking line that weaves one or two fitting follow-up moves (real moves only, named exactly) directly into the prose as instructed — do NOT use [[MOVE:…]] directives or a separate list for them.`;

    // Whether the Skald may offer follow-up move suggestions after the
    // narration. Reuses the same "suggestMoves" setting that gates the
    // pre-roll suggestion card, so both honour one toggle.
    const allowFollowups = this.active() && (Settings.get("suggestMoves") ?? true);

    try {
      Memory.push("general", "user", `(${parsed.moveName} → ${parsed.outcome})`);
      // Recall relevant world memory using the move + the player's intent.
      const memory = await RagBridge.fetchMemory(`${parsed.moveName} ${this._lastIntent || ""}`.trim());
      const messages = [
        { role: "system", content: buildSystemPrompt({ task, context: ctx, allowEffects, allowFollowups, allowJournal: true, memory }) },
        ...Memory.get("general")
      ];

      const cardOpts = { variant: "combat", title: `${parsed.moveName} — ${parsed.outcome}` };
      const streaming = Settings.get("streamingEnabled") !== false;

      let reply;
      if (streaming) {
        // Stream the narration live; [[EFFECT:…]] directives are stripped
        // from the display and applied afterwards from the full raw reply.
        ({ reply } = await callSkaldStreaming(messages, {
          ...cardOpts,
          chatOpts: { temperature: 0.85, maxTokens: 500 }
        }));
      } else {
        reply = await Client.chat(messages, { temperature: 0.85, maxTokens: 500 });
        const { clean } = this.parseEffects(reply);
        await Chat.postSkald(formatMarkdown(stripDirectivesForDisplay(clean || reply)), cardOpts);
      }
      Memory.push("general", "assistant", reply);
      // Fire-and-forget chronicle ingestion (never blocks/breaks play).
      JournalSystem.ingestReply(reply, { channel: "combat" });

      const { effects } = this.parseEffects(reply);
      // Strip effects the auto-combat flow already handled, to avoid
      // double-marking progress or flipping initiative twice.
      const safeEffects = this._filterRedundantCombatEffects(effects, parsed, autoSummary);
      if (allowEffects && safeEffects.length) {
        await this.applyEffects(safeEffects, actor);
      }

      // (v0.10.10) Follow-up moves are now woven into the Skald's closing
      // prose and auto-linked inline by EntityLinker (each rolls through the
      // progress-aware triggerMove path when clicked). We no longer post a
      // separate "What Comes Next" suggestion card — any stray [[MOVE:…]]
      // directive is stripped from the displayed narration instead. The
      // `allowFollowups` flag still gates whether the prompt invites them.
    } catch (e) {
      console.warn(LOG_PREFIX, "_narrateOutcome failed", e);
    }
  },

  /**
   * Is this move name one of the core combat moves whose mechanics the
   * Skald resolves deterministically (initiative / progress)?
   */
  _isCombatMove(moveName) {
    return /\b(enter the fray|strike|clash)\b/i.test(String(moveName || ""));
  },

  /**
   * Apply Ironsworn combat mechanics for the resolved move, deterministically:
   *   • Enter the Fray  → strong/weak hit grants initiative; miss = bad spot.
   *   • Strike          → hit inflicts harm (mark foe progress); strong keeps
   *                       initiative, weak loses it; miss loses initiative.
   *   • Clash           → hit inflicts harm (mark foe progress); strong keeps
   *                       initiative, weak/miss loses it.
   * Returns a short human-readable summary of what changed (for the prompt
   * and the GM whisper), or "" when nothing applied.
   */
  async _autoCombatFlow(parsed, actor) {
    if (!actor) return "";
    const move = String(parsed.moveName || "").toLowerCase();
    if (!this._isCombatMove(move)) return "";

    const out    = String(parsed.outcome || "").toLowerCase();
    const strong = out.includes("strong");
    const hit    = strong || out.includes("weak");
    const notes  = [];

    if (/enter the fray/.test(move)) {
      const r = await IronswornController.setInitiative(actor, hit);
      if (r?.ok) { this._notifyInitiative(hit); notes.push(hit ? "seized initiative" : "in a bad spot (no initiative)"); }
      return notes.join("; ");
    }

    // Strike / Clash
    if (hit) {
      const track = IronswornController.getActiveCombatTrack(actor);
      if (track) {
        const pr = await IronswornController.markProgressByRank(actor, track.id);
        if (pr?.ok) {
          this._notifyProgress(pr.track, pr.boxes);
          notes.push(`inflicted harm on ${pr.track} (now ${pr.boxes}/10 boxes)`);
          // (fix — foe auto-completion) A foe brought to full progress (10/10)
          // is defeated; close the track deterministically instead of leaving
          // it open. Clears the active-combat flag inside the helper.
          const done = await this._autoCompleteIfFull(actor, track.id, "combat");
          if (done) notes.push(`${pr.track} defeated (10/10 — auto-completed)`);
        }
      } else {
        notes.push("no active foe track to mark — create one with [[EFFECT: create_combat …]]");
      }
      // Strong hit keeps initiative; weak hit loses it (per Strike/Clash).
      const keep = strong;
      const ir = await IronswornController.setInitiative(actor, keep);
      if (ir?.ok) { this._notifyInitiative(keep); notes.push(keep ? "kept initiative" : "lost initiative"); }
    } else {
      const ir = await IronswornController.setInitiative(actor, false);
      if (ir?.ok) { this._notifyInitiative(false); notes.push("lost initiative — pay the price"); }
    }
    return notes.join("; ");
  },

  /**
   * Is this the journey-ADVANCING move ("Undertake a Journey")? This is the
   * move whose hit marks journey progress — distinct from the journey-FINISHING
   * progress move ("Reach Your Destination"), which rolls the accumulated
   * track and is handled by IronswornController.rollProgressMove().
   */
  _isJourneyMove(moveName) {
    return /\bundertake (?:a|your|the|this) journey\b/i.test(String(moveName || ""));
  },

  /**
   * (v0.10.27 — roll-result integration) Classify a progress-COMPLETION move
   * and the track KIND it resolves:
   *   "Fulfill Your Vow"      → vow
   *   "End the Fight"         → combat
   *   "Reach Your Destination"→ journey
   * Returns the kind string, or null when `moveName` is not a completion move.
   */
  _completionMoveKind(moveName) {
    const n = String(moveName || "").toLowerCase();
    if (/\bfulfill (?:your|the|this) vow\b/.test(n)) return "vow";
    if (/\bend the fight\b/.test(n)) return "combat";
    if (/\breach (?:your|the|this) destination\b/.test(n)) return "journey";
    return null;
  },

  /**
   * (v0.10.27) Deterministically integrate the OUTCOME of a progress-completion
   * move with the relevant track:
   *   • STRONG HIT → the track is finished. Auto-complete the correct track,
   *     resolved via the story-arc flags (active vow / active combat) with a
   *     graceful fallback to the last-rolled / newest-open track of that kind.
   *   • WEAK HIT / MISS → the track is NOT completed; we only return a note so
   *     the narration prompt describes the complication / consequence and the
   *     track stays open for another attempt.
   * Returns a short human-readable summary (for the prompt + GM whisper), or ""
   * when the move isn't a completion move / nothing applied. Never throws.
   */
  async _autoCompletionFlow(parsed, actor) {
    if (!actor) return "";
    const kind = this._completionMoveKind(parsed?.moveName);
    if (!kind) return "";

    const out    = String(parsed?.outcome || "").toLowerCase();
    const strong = out.includes("strong");
    const weak   = out.includes("weak");

    // Resolve the target track, preferring the explicit story-arc flags.
    let target = null;
    if (kind === "vow") {
      const av = IronswornController.getActiveVow(actor);
      target = (av && actor.items?.get?.(av.id))
            || IronswornController.resolveCompletionTrack(actor, "", "vow");
    } else if (kind === "combat") {
      const ac = IronswornController.getActiveCombat(actor);
      target = ac && actor.items?.get?.(ac.id);
    } else { // journey
      target = IronswornController.resolveCompletionTrack(actor, "", "journey");
    }

    if (!strong) {
      // Weak hit or miss — explicitly DO NOT complete. Provide narration guidance.
      const label = kind === "combat" ? "fight" : kind;
      const name  = target?.name ? ` “${target.name}”` : "";
      return weak
        ? `${label}${name} NOT yet finished (weak hit) — narrate partial success at a cost; the track stays open`
        : `${label}${name} NOT finished (miss) — narrate a serious setback/complication; the track stays open`;
    }

    // Strong hit — complete the track.
    if (!target) {
      return `no open ${kind} track to complete (strong hit on ${parsed.moveName})`;
    }
    let r;
    if (kind === "combat") {
      r = await IronswornController.completeTrack(actor, target.id);
      if (r?.ok) { try { await IronswornController.clearActiveCombat(actor); } catch (_) {} }
    } else {
      r = await IronswornController.completeTrackSmart(actor, target.id, kind);
      if (r?.ok && kind === "vow") { try { await IronswornController.setActiveVow(actor, null); } catch (_) {} }
    }
    if (r?.ok) {
      const verb = kind === "vow" ? "fulfilled vow" : kind === "combat" ? "won the fight" : "reached destination";
      this._notifyCombat(`🏆 ${verb}: ${r.name}`);
      try { await Chat.postSystem(`<em>🤖 Skald marked “${escapeHtml(r.name)}” complete (strong hit on ${escapeHtml(parsed.moveName)}).</em>`, { gmWhisper: true }); } catch (_) {}
      this._auditWrite("ROLL_COMPLETE", { trackKind: kind, name: r.name }, true, `strong hit on ${parsed.moveName}`);
      return `${verb} “${r.name}” (strong hit — auto-completed)`;
    }
    this._auditWrite("ROLL_COMPLETE", { trackKind: kind, name: target?.name }, false, r?.error);
    return "";
  },

  /**
   * (fix — journey/combat auto-completion) Complete a progress track that has
   * reached FULL progress (10 boxes / 40 ticks). Shared by the journey and
   * combat auto-flows so a track that fills up via "Undertake a Journey" or
   * "Strike"/"Clash" closes itself deterministically instead of lingering open
   * forever.
   *
   * Two bugs were caused by tracks never closing at 10/10:
   *   • JOURNEYS — because the first journey track stayed open forever,
   *     _autoJourneyFlow kept REUSING it, collapsing every journey into one
   *     perpetually-open track (the "all journeys group together" bug).
   *   • FOES — a foe brought to 10/10 by Strikes/Clashes was never marked
   *     defeated (the "foe combat doesn't auto-complete" bug).
   *
   * Completion goes through IronswornController.completeTrack(), which only
   * flips `system.completed`. The automatic vow-XP hook (updateItem) is gated
   * to VOWS only, so completing a JOURNEY or COMBAT track here never awards XP.
   *
   * @param {Actor}  actor
   * @param {string} trackId   the track Item id
   * @param {string} kind      "journey" | "combat" (controls notification + flag cleanup)
   * @returns {Promise<boolean>} true when this call completed the track.
   */
  async _autoCompleteIfFull(actor, trackId, kind) {
    try {
      const t = actor?.items?.get?.(trackId);
      if (!t) return false;
      if (foundry.utils.getProperty(t, "system.completed")) return false;
      const cur = foundry.utils.getProperty(t, "system.current") ?? 0;
      if (cur < 40) return false;                       // not yet 10/10 boxes
      const r = await IronswornController.completeTrack(actor, trackId);
      if (!r?.ok) return false;
      // A finished fight is no longer the active combat — clear the flag.
      if (kind === "combat") { try { await IronswornController.clearActiveCombat(actor); } catch (_) {} }
      const verb = kind === "combat" ? "🏆 foe defeated" : "🏁 destination reached";
      try { this._notifyCombat(`${verb}: ${r.name} (10/10)`); } catch (_) {}
      try { await Chat.postSystem(`<em>🤖 Skald marked “${escapeHtml(r.name)}” complete (full progress — 10/10).</em>`, { gmWhisper: true }); } catch (_) {}
      this._auditWrite("AUTO_COMPLETE_FULL", { trackKind: kind, name: r.name }, true, "reached 10/10 boxes");
      return true;
    } catch (e) {
      console.warn(LOG_PREFIX, "_autoCompleteIfFull failed", e);
      return false;
    }
  },

  /**
   * Is this the "Reach a Milestone" move?  No dice — just marks progress on
   * the active vow by its rank.
   */
  _isMilestoneMove(moveName) {
    return /\breach a milestone\b/i.test(String(moveName || ""));
  },

  /**
   * Best-effort meaningful name for an auto-created journey track, derived from
   * the player's stated intent (e.g. "travel to the Frozen Keep" →
   * "Journey to the Frozen Keep"). Falls back to a clean generic title so a
   * track ALWAYS gets a sensible name rather than an empty/placeholder one.
   */
  _inferJourneyName() {
    const intent = String(this._lastIntent || "").trim();
    if (intent) {
      // "...to/toward/towards/for/into <Destination>" — capture a proper-ish
      // place name (allow a leading "the").
      const m = intent.match(/\b(?:to|toward|towards|for|into|reach|reaching|bound for)\s+((?:the\s+)?[A-Z][\w''’\- ]{2,48})/);
      if (m) {
        const dest = m[1].trim().replace(/[.,;:!?]+$/, "").replace(/\s+/g, " ");
        if (dest && !/^journey\b/i.test(dest)) return `Journey to ${dest}`;
      }
    }
    return "The Journey";
  },

  /** Default rank for an auto-created journey track. */
  _inferJourneyRank() {
    return "formidable";
  },

  /**
   * Deterministically enact the journey side of "Undertake a Journey" so that
   * "Reach Your Destination" always has an open track to roll against:
   *   • If no open journey track exists, OPEN one (named from the player's
   *     intent, or a clean generic title) — this is the root-cause fix for the
   *     "No open journey track to roll 'Reach Your Destination' against" error.
   *   • On a hit (strong/weak), MARK PROGRESS on that journey by its rank, the
   *     standard effect of a successful "Undertake a Journey".
   * Returns a short human-readable summary (for the prompt + GM whisper), or ""
   * when the move isn't a journey move / nothing applied.
   */
  async _autoJourneyFlow(parsed, actor) {
    if (!actor) return "";
    if (!this._isJourneyMove(parsed?.moveName)) return "";

    const out    = String(parsed.outcome || "").toLowerCase();
    const strong = out.includes("strong");
    const hit    = strong || out.includes("weak");
    const notes  = [];

    // Resolve WHICH journey track this move advances.
    //
    // (fix — journey separation) Previously we ALWAYS reused the newest open
    // journey track, so a journey to a *different* destination simply advanced
    // the prior, still-open track — collapsing every journey into a single
    // perpetually-open track (the "all journeys group together" bug). The root
    // cause was compounded by journeys never closing at 10/10, so that first
    // track lingered open forever and was reused indefinitely.
    //
    // Now: if we can confidently identify THIS move's destination (a specific
    // "Journey to X" inferred from the player's intent), we reuse an open
    // journey ONLY when it is the same destination; a different destination
    // opens its own track so simultaneous journeys stay separate. When the
    // destination is unknown (generic "The Journey"), we keep the conservative
    // reuse-newest behaviour to avoid spamming near-duplicate tracks.
    const inferredName = this._inferJourneyName();             // "Journey to X" | "The Journey"
    const specific     = !/^the journey$/i.test(inferredName); // did we identify a real destination?
    let track = IronswornController._newestOpenTrackItem(actor, "journey");

    if (track && specific) {
      // Reuse only an OPEN journey matching this destination; else branch a new one.
      const match     = IronswornController.findTrackFuzzy(actor, inferredName, "journey");
      const matchOpen = match && !foundry.utils.getProperty(match, "system.completed");
      track = matchOpen ? match : null;
    }

    if (!track) {
      const name = inferredName;
      const rank = this._inferJourneyRank();
      const res  = await IronswornController.createProgressTrack(actor, name, "journey", rank);
      if (res?.ok) {
        track = IronswornController.getProgressTrack(actor, res.id)
             ?? IronswornController._newestOpenTrackItem(actor, "journey");
        notes.push(`opened journey “${res.name || name}” (${rank})`);
        try { ui.notifications?.info(`${SKALD_NAME}: journey begun — ${res.name || name}.`); } catch (_) {}
      } else {
        notes.push("could not open a journey track");
      }
    }

    // On a hit, mark progress on the (now open) journey by its rank.
    if (track && hit) {
      const pr = await IronswornController.markProgressByRank(actor, track.id);
      if (pr?.ok) {
        this._notifyProgress(pr.track, pr.boxes);
        notes.push(`advanced ${pr.track} (now ${pr.boxes}/10 boxes)`);
        // (fix — journey completion) A journey that has reached full progress
        // (10/10) is finished; close it deterministically so it stops being
        // reused by later journeys (which caused the grouping bug).
        const done = await this._autoCompleteIfFull(actor, track.id, "journey");
        if (done) notes.push(`reached destination “${pr.track}” (10/10 — auto-completed)`);
      }
    }
    return notes.join("; ");
  },

  /**
   * Deterministically enact "Reach a Milestone": find the newest open vow
   * and mark progress on it by its rank. This move has NO dice — it always
   * succeeds. Returns a human-readable summary for the narration prompt.
   */
  async _autoMilestoneFlow(parsed, actor) {
    if (!actor) return "";
    if (!this._isMilestoneMove(parsed?.moveName)) return "";
    const res = await IronswornController._executeMilestone(actor);
    if (res?.ok) {
      this._notifyProgress(res.track, res.boxes);
      return `marked progress on vow "${res.track}" (now ${res.boxes ?? "?"}/10 boxes)`;
    }
    return res?.error ? `milestone: ${res.error}` : "";
  },

  /**
   * Remove progress / initiative / create_journey effects an auto-flow already
   * applied for a core combat OR journey move, so the AI can't double-apply
   * them. Non-combat / non-journey moves (and unrelated effects) pass through.
   */
  _filterRedundantCombatEffects(effects, parsed, autoSummary) {
    if (!autoSummary) return effects;
    const combat    = this._isCombatMove(parsed?.moveName);
    const journey   = this._isJourneyMove(parsed?.moveName);
    const milestone = this._isMilestoneMove(parsed?.moveName);
    // (v0.10.27) Did _autoCompletionFlow already finish a track this turn? Only
    // a STRONG hit on a completion move auto-completes; in that case drop any
    // AI-emitted completion directive to avoid a confusing double-completion
    // notification. (On weak/miss nothing was completed, so we leave the
    // effects alone — though the prompt steers the AI away from completing.)
    const autoCompleted = this._completionMoveKind(parsed?.moveName)
      && /auto-completed/.test(String(autoSummary || ""));
    if (!combat && !journey && !milestone && !autoCompleted) return effects;
    return (effects || []).filter(e => {
      if (combat && e.kind === "initiative") { this._dbg("→ dropping redundant initiative effect (auto-applied)"); return false; }
      if (e.kind === "progress")             { this._dbg("→ dropping redundant progress effect (auto-applied)"); return false; }
      // The journey track is opened deterministically by _autoJourneyFlow, so
      // drop any AI-emitted create_journey to avoid a duplicate track.
      if (journey && e.kind === "create_journey") { this._dbg("→ dropping redundant create_journey effect (auto-applied)"); return false; }
      // A completion move already auto-finished the track — drop redundant
      // completion directives (both the legacy complete_*/end_combat effects
      // and the new MARK_COMPLETE write directive).
      if (autoCompleted && (e.kind === "complete_track" || e.kind === "end_combat" || e.kind === "mark_complete")) {
        this._dbg("→ dropping redundant completion effect (auto-completed on strong hit)"); return false;
      }
      return true;
    });
  },

  /**
   * (v0.10.6) Effect kinds that represent the progress-track LIFECYCLE
   * (begin / close a journey, vow, or fight). These are the only effects the
   * conversational channels (!skald / !scene / !combat) apply, since they have
   * no dice roll to hang meter changes off. Meter effects (momentum, harm,
   * stress, supply, progress) stay dice-driven via {@link _narrateOutcome}.
   */
  // NOTE: "progress" is included so the conversational channels can advance a
  // NAMED vow/journey from the narrative (the [[EFFECT: mark_progress "Title"]]
  // / [[EFFECT: progress <Title> …]] directive) WITHOUT requiring a dice roll
  // first — markProgress() resolves the track by its title. This is separate
  // from the post-roll path (_narrateOutcome), which applies effects directly
  // and filters auto-applied progress, so there is no double-marking risk.
  // (v0.10.27) The explicit write directives (mark_complete / add_progress /
  // set_progress) are track-lifecycle operations too, so the conversational
  // channels apply them without needing a dice roll first.
  _TRACK_LIFECYCLE_KINDS: ["create_journey", "create_vow", "create_combat", "complete_track", "end_combat", "progress", "mark_complete", "add_progress", "set_progress"],

  /**
   * (v0.10.6) Parse a conversational reply for [[EFFECT:…]] directives and
   * apply ONLY the track-lifecycle ones (create_journey / create_vow /
   * create_combat / complete_* / end_combat). This is what makes a journey or
   * vow the Skald narrates in a normal !skald/!scene/!combat exchange actually
   * appear on the character sheet — previously these directives were parsed
   * for display-stripping but never applied outside the post-roll path.
   *
   * Gated by the caller (only invoked when the Ironsworn integration is active
   * and the "AI Applies Mechanical Effects" setting is on). Fully defensive:
   * never throws into the conversation flow.
   * @returns {Promise<string[]>} the list of applied-effect summaries (may be empty).
   */
  async applyNarrativeTrackEffects(reply, actor) {
    try {
      const { effects } = this.parseEffects(reply);
      const trackEffects = (effects || []).filter(e => this._TRACK_LIFECYCLE_KINDS.includes(e.kind));
      if (!trackEffects.length) return [];
      return await this.applyEffects(trackEffects, actor);
    } catch (e) {
      console.warn(LOG_PREFIX, "applyNarrativeTrackEffects failed", e);
      return [];
    }
  },

  /**
   * (v0.10.8) GM-only advisory when a track-lifecycle effect can't run because
   * there is no active character. Previously these directives failed silently,
   * so a sworn vow / begun journey simply never appeared with no explanation.
   */
  async _warnNoActor(action, name) {
    try {
      await Chat.postSystem(
        `<strong>Could not ${escapeHtml(action)}${name ? ` “${escapeHtml(name)}”` : ""}:</strong> ` +
        `no active character. Select your character's token (or assign a character to your user) and try again.`,
        { gmWhisper: true }
      );
    } catch (_) { /* advisory only */ }
  },

  /**
   * (v0.10.8) GM-only advisory when a progress-track create actually failed
   * (e.g. a data-model validation error). Surfacing the reason makes a
   * "vows aren't being created" report diagnosable instead of silent.
   */
  async _warnTrackCreateFailed(kind, name, error) {
    try {
      await Chat.postSystem(
        `<strong>Could not create the ${escapeHtml(kind)} “${escapeHtml(name ?? "")}”:</strong> ` +
        `${escapeHtml(error ?? "unknown error")}`,
        { gmWhisper: true }
      );
    } catch (_) { /* advisory only */ }
  },

  /**
   * (v0.10.37 — Phase 3) GM-only advisory when a compendium-creation effect
   * (add_asset / add_item / create_foe / create_character) could not be
   * fulfilled. Includes the closest suggested name when the lookup offered
   * one, so the GM can correct the directive. Never throws.
   */
  async _warnCreateFailed(kind, name, error, suggestion) {
    try {
      const hint = suggestion ? ` Did you mean “${escapeHtml(suggestion)}”?` : "";
      await Chat.postSystem(
        `<em>⚠ Could not add/create the ${escapeHtml(kind)} “${escapeHtml(name ?? "")}”: ` +
        `${escapeHtml(error ?? "unknown error")}.${hint}</em>`,
        { gmWhisper: true }
      );
    } catch (_) { /* advisory only */ }
  },

  /** Apply parsed [[EFFECT:…]] directives via the Ironsworn controller. */
  async applyEffects(effects, actor) {
    const applied = [];
    // Snapshot combat tracks that were already open BEFORE this batch. When a
    // new fight starts we auto-close these (one fight at a time in Ironsworn),
    // but NOT any foe tracks created within this same reply — a single
    // narration can introduce several foes in one fight.
    const preBatchCombatIds = actor
      ? IronswornController.getCombatTracks(actor).filter(t => !t.completed).map(t => t.id)
      : [];
    let staleCombatClosed = false;
    for (const eff of effects) {
      try {
        let r = null;
        switch (eff.kind) {
          case "momentum":
            if (eff.op === "reset") r = await IronswornController.resetMomentum(actor);
            else r = await IronswornController.adjustMomentum(actor, eff.value);
            if (r?.ok) applied.push(`momentum ${eff.op === "reset" ? "reset" : (eff.value >= 0 ? "+" : "") + eff.value}`);
            break;
          case "harm":
            r = await IronswornController.applyHarm(actor, eff.value);
            if (r?.ok) applied.push(`-${eff.value} health`);
            break;
          case "stress":
            r = await IronswornController.applyStress(actor, eff.value);
            if (r?.ok) applied.push(`-${eff.value} spirit`);
            break;
          case "supply":
            r = await IronswornController.adjustSupply(actor, eff.value);
            if (r?.ok) applied.push(`supply ${eff.value >= 0 ? "+" : ""}${eff.value}`);
            break;
          case "toggle_impact":
          case "set_impact": {
            // (v0.10.36 — Phase 2) Toggle/set a condition/impact. Gated by the
            // aiModifiesSheet setting ("impacts" or "full" permit it). Runs
            // GM-side via actor.update(); bounded + idempotent in the controller.
            const sheetMode = Settings.get("aiModifiesSheet") ?? "impacts";
            if (sheetMode === "off") {
              this._auditWrite("TOGGLE_IMPACT", { name: eff.impact }, false, "disabled (aiModifiesSheet=off)");
              break;
            }
            if (!actor) { await this._warnNoActor("change a condition", eff.impact); break; }
            r = (eff.kind === "toggle_impact")
              ? await IronswornController.toggleImpact(actor, eff.impact)
              : await IronswornController.setImpact(actor, eff.impact, eff.on);
            if (r?.ok && !r.noop) {
              const verb = r.state ? "marked" : "cleared";
              applied.push(`${verb} ${r.impact}`);
              this._auditWrite("TOGGLE_IMPACT", { name: r.impact }, true, `${verb} (${r.state})`);
            } else if (r?.noop) {
              this._auditWrite("TOGGLE_IMPACT", { name: r.impact }, true, "no-op (already in state)");
            } else {
              this._auditWrite("TOGGLE_IMPACT", { name: eff.impact }, false, r?.error);
            }
            break;
          }
          case "set_stat": {
            // (v0.10.36 — Phase 2) Set a base stat (0–5). Only permitted when
            // aiModifiesSheet is "full" — stat edits are rare and heavy.
            const sheetMode = Settings.get("aiModifiesSheet") ?? "impacts";
            if (sheetMode !== "full") {
              this._auditWrite("SET_STAT", { name: eff.stat, boxes: eff.value }, false, `disabled (aiModifiesSheet=${sheetMode})`);
              break;
            }
            if (!actor) { await this._warnNoActor("change a stat", eff.stat); break; }
            r = await IronswornController.setStat(actor, eff.stat, eff.value);
            if (r?.ok && !r.noop) {
              applied.push(`${r.stat} ${r.from}→${r.to}`);
              this._auditWrite("SET_STAT", { name: r.stat, boxes: r.to }, true, `${r.from}→${r.to}`);
            } else if (r?.noop) {
              this._auditWrite("SET_STAT", { name: r.stat, boxes: r.to }, true, "no-op (unchanged)");
            } else {
              this._auditWrite("SET_STAT", { name: eff.stat, boxes: eff.value }, false, r?.error);
            }
            break;
          }
          case "progress":
            r = eff.byRank
              ? await IronswornController.markProgressByRank(actor, eff.track)
              : await IronswornController.markProgress(actor, eff.track, eff.value);
            if (r?.ok) applied.push(`progress on ${r.track}`);
            break;
          case "oracle":
            r = await IronswornController.rollOracle(eff.name);
            if (r) applied.push(`oracle “${eff.name}” → ${r}`);
            break;
          case "grant_xp": {
            // [[EFFECT: grant_xp <amount> <reason>]] — discretionary award.
            if (!actor) { await this._warnNoActor("grant experience", ""); break; }
            r = await IronswornController.grantXp(actor, eff.amount, { reason: eff.reason || "a hard-won milestone" });
            if (r?.ok) {
              applied.push(`+${r.amount} XP`);
              this._auditWrite("GRANT_XP", { name: eff.reason || "", boxes: eff.amount }, true, `+${r.amount} XP (${r.mode})`);
            } else {
              this._auditWrite("GRANT_XP", { name: eff.reason || "", boxes: eff.amount }, false, r?.error);
            }
            break;
          }
          case "grant_xp_vow": {
            // [[EFFECT: grant_xp_vow <rank>]] — award the rank's XP for the
            // vow just fulfilled. Funnels through the idempotent grantVowXp so
            // it can never double up with the automatic completion hook.
            if (!actor) { await this._warnNoActor("grant vow experience", ""); break; }
            const vow = IronswornController.resolveVowForXp(actor);
            if (!vow) {
              // No vow track to attach to — fall back to the rank's flat amount
              // if a rank was supplied, else skip.
              if (eff.rank) {
                const amt = IronswornController.xpForRank(eff.rank);
                r = amt > 0 ? await IronswornController.grantXp(actor, amt, { reason: `fulfilled a ${eff.rank} vow` }) : null;
                if (r?.ok) applied.push(`+${r.amount} XP (vow)`);
              }
              this._auditWrite("GRANT_XP_VOW", { name: "", trackKind: "vow" }, !!r?.ok, r?.ok ? "no track, flat rank award" : "no vow to award");
              break;
            }
            const weakHitHalf = (Settings.get("weakHitHalfXp") ?? false) === true;
            r = await IronswornController.grantVowXp(actor, vow, { weakHitHalf, reason: eff.reason });
            if (r?.ok && r.xp > 0) {
              applied.push(`+${r.xp} XP for “${vow.name}”`);
              this._auditWrite("GRANT_XP_VOW", { name: vow.name, trackKind: "vow", boxes: r.xp }, true, `+${r.xp} XP`);
            } else if (r?.skipped) {
              this._auditWrite("GRANT_XP_VOW", { name: vow.name, trackKind: "vow" }, true, `skipped (${r.skipped})`);
            } else {
              this._auditWrite("GRANT_XP_VOW", { name: vow.name, trackKind: "vow" }, false, r?.error);
            }
            break;
          }
          case "create_combat": {
            if (!(Settings.get("autoCreateCombatTracks") ?? true)) {
              this._dbg("→ create_combat skipped: autoCreateCombatTracks disabled");
              break;
            }
            // Don't duplicate an already-active fight with the same foe.
            const existing = IronswornController.getProgressTrack(actor, eff.name);
            const existingDone = existing && foundry.utils.getProperty(existing, "system.completed");
            if (existing && !existingDone) {
              this._dbg(`→ create_combat skipped: "${eff.name}" already active`);
              applied.push(`combat “${eff.name}” already underway`);
              break;
            }
            // Rank resolution, in priority order:
            //   1. AI-specified rank  → custom enemy, trust the Skald.
            //   2. Compendium lookup  → official rank for standard foes.
            //   3. Default setting    → unknown custom foe with no rank given.
            let rank, source;
            // For the optional advisory: whether this REGULAR (non-important)
            // foe turned out NOT to be in the official compendia, plus the
            // closest suggested name if the lookup offered one.
            let notInCompendium = false;
            let compendiumSuggestion = "";
            if (eff.rank) {
              rank = IronswornController.normalizeRank(eff.rank);
              source = "custom";
              this._dbg(`→ create_combat "${eff.name}": custom enemy, using AI-specified rank "${rank}"`);
              // A regular foe given an explicit rank but NOT flagged important
              // and NOT in the official compendia is a likely invented foe —
              // note it for the GM advisory below.
              if (!eff.important) {
                try {
                  const off = await IronswornController.isOfficialCompendiumFoe(eff.name);
                  if (!off) notInCompendium = true;
                } catch (_) { /* advisory only */ }
              }
            } else {
              let lookup = null;
              try { lookup = await IronswornController.lookupEnemyInCompendium(eff.name); }
              catch (e) { console.warn(LOG_PREFIX, "compendium lookup failed", e); }
              if (lookup?.found && lookup.rank) {
                rank = lookup.rank;
                source = "compendium";
                this._dbg(`→ create_combat "${eff.name}": using compendium rank "${rank}" (matched "${lookup.matchedName}" via ${lookup.match})`);
              } else {
                rank = IronswornController.normalizeRank(Settings.get("defaultEnemyRank") ?? "dangerous");
                source = "default";
                const hint = lookup?.suggestion ? ` (did you mean "${lookup.suggestion}"?)` : "";
                this._dbg(`→ create_combat "${eff.name}": not in compendium${hint}, using default rank "${rank}"`);
                if (!eff.important) {
                  notInCompendium = true;
                  compendiumSuggestion = lookup?.suggestion || "";
                }
              }
            }
            // Ironsworn is fought one foe at a time. The first time a new
            // fight starts in this reply, tidy up any combat tracks left open
            // from a PREVIOUS fight (the AI doesn't always emit end_combat
            // when a fight fizzles out) — otherwise they linger as orphaned,
            // untracked tracks. We only close tracks open before this batch,
            // so several foes introduced in the same reply coexist fine.
            if (!staleCombatClosed && (Settings.get("autoCloseStaleCombatTracks") ?? true)) {
              staleCombatClosed = true;
              if (preBatchCombatIds.length) {
                const tidy = await IronswornController.closeStaleCombatTracks(actor, { onlyIds: preBatchCombatIds });
                if (tidy?.closed?.length) {
                  applied.push(`auto-closed prior combat ${tidy.closed.map(n => `“${n}”`).join(", ")}`);
                  this._notifyCombat(`🏳 Closed stale combat: ${tidy.closed.join(", ")}`);
                }
              }
              // Opportunistic, idempotent legacy repair: migrate any pre-existing
              // combat tracks still stored with the broken subtype "foe" (which
              // rendered the raw "IRONSWORN.ITEM.SubtypeFoe" key on the character
              // sheet) to subtype "progress". Runs once per reply, on a write path
              // only. Safe no-op when nothing needs fixing.
              try {
                const repair = await IronswornController.normalizeCombatTrackSubtypes(actor);
                if (repair?.fixed?.length) {
                  this._dbg(`→ migrated ${repair.fixed.length} legacy combat track label(s): ${repair.fixed.join(", ")}`);
                }
              } catch (e) {
                console.warn(LOG_PREFIX, "normalizeCombatTrackSubtypes failed", e);
              }
            }
            r = await IronswornController.createProgressTrack(actor, eff.name, "combat", rank);
            if (r?.ok) {
              const tag = source === "compendium" ? " [from compendium]" : source === "custom" ? " [custom]" : "";
              applied.push(`⚔ began combat “${eff.name}” [${rank}]${tag}`);
              this._notifyCombat(`⚔ Combat track created: ${eff.name} (${rank}${source === "compendium" ? ", official" : ""})`);
              // Phase 2 (story-arc tracking): a freshly-started fight is the
              // active combat — remember it so context markers and roll
              // integration target the right foe. Best-effort.
              try { await IronswornController.setActiveCombat(actor, r.id); } catch (_) {}
              // Optional GM advisory: a REGULAR foe (not flagged as an
              // important/unique narrative foe) that isn't in the official foe
              // compendia is likely an invented name. Whisper a gentle heads-up
              // to the GM so they can swap it for a catalogue foe if desired.
              // Important/unique foes are intentional and never warned.
              if (notInCompendium && !eff.important) {
                try {
                  const hint = compendiumSuggestion ? ` Closest official foe: “${compendiumSuggestion}”.` : "";
                  await Chat.postSystem(
                    `<em>⚠ “${eff.name}” is not in the official Ironsworn foe compendia. `
                    + `If this is a routine foe, prefer one from the catalogue; if it is an `
                    + `important boss/unique antagonist, that is fine.${hint}</em>`,
                    { gmWhisper: true }
                  );
                } catch (_) { /* advisory only — never block combat creation */ }
              }
            } else {
              await this._warnTrackCreateFailed("combat", eff.name, r?.error);
            }
            break;
          }
          case "create_vow": {
            if (!actor) { await this._warnNoActor("swear the vow", eff.name); break; }
            const rank = IronswornController.normalizeRank(eff.rank || "formidable");
            const existing = IronswornController.getProgressTrack(actor, eff.name);
            if (existing && !foundry.utils.getProperty(existing, "system.completed")) {
              applied.push(`vow “${eff.name}” already sworn`);
              break;
            }
            r = await IronswornController.createProgressTrack(actor, eff.name, "vow", rank, eff.description);
            if (r?.ok) {
              applied.push(`vow “${eff.name}” sworn [${rank}]`);
              this._notifyCombat(`📜 Vow sworn: ${eff.name} (${rank})`);
            } else {
              await this._warnTrackCreateFailed("vow", eff.name, r?.error);
            }
            break;
          }
          case "create_journey": {
            if (!actor) { await this._warnNoActor("begin the journey", eff.name); break; }
            const rank = IronswornController.normalizeRank(eff.rank || "formidable");
            const existing = IronswornController.getProgressTrack(actor, eff.name);
            if (existing && !foundry.utils.getProperty(existing, "system.completed")) {
              applied.push(`journey “${eff.name}” already under way`);
              break;
            }
            r = await IronswornController.createProgressTrack(actor, eff.name, "journey", rank, eff.description);
            if (r?.ok) {
              applied.push(`journey “${eff.name}” begun [${rank}]`);
              this._notifyCombat(`🧭 Journey begun: ${eff.name} (${rank})`);
            } else {
              await this._warnTrackCreateFailed("journey", eff.name, r?.error);
            }
            break;
          }

          /* ---- Compendium creation (v0.10.37 — Phase 3) ---------------------
           * Bring official compendium content into play. All creation runs
           * GM-side through the Document API in the controller, is verified
           * against the compendia first, and is gated by the aiCreatesContent
           * setting: "off" blocks everything, "foes" allows only foe spawning,
           * "full" allows assets/items/characters too. A close-but-unmatched
           * name surfaces a gentle GM advisory rather than guessing. */
          case "add_asset": {
            const mode = Settings.get("aiCreatesContent") ?? "foes";
            if (mode !== "full") {
              this._auditWrite("ADD_ASSET", { name: eff.name }, false, `disabled (aiCreatesContent=${mode})`);
              break;
            }
            if (!actor) { await this._warnNoActor("add an asset", eff.name); break; }
            r = await IronswornController.addAssetToActor(actor, eff.name);
            if (r?.ok && !r.noop) {
              applied.push(`added asset “${r.name}”`);
              this._notifyCombat(`🎴 Asset added: ${r.name}`);
              this._auditWrite("ADD_ASSET", { name: r.name }, true, `matched ${r.match} → ${actor.name}`);
            } else if (r?.noop) {
              this._auditWrite("ADD_ASSET", { name: r.name }, true, "no-op (already owned)");
            } else {
              this._auditWrite("ADD_ASSET", { name: eff.name }, false, r?.error);
              await this._warnCreateFailed("asset", eff.name, r?.error, r?.suggestion);
            }
            break;
          }
          case "add_item": {
            const mode = Settings.get("aiCreatesContent") ?? "foes";
            if (mode !== "full") {
              this._auditWrite("ADD_ITEM", { name: eff.name }, false, `disabled (aiCreatesContent=${mode})`);
              break;
            }
            if (!actor) { await this._warnNoActor("add an item", eff.name); break; }
            r = await IronswornController.addItemToActor(actor, eff.name);
            if (r?.ok && !r.noop) {
              applied.push(`added ${r.type || "item"} “${r.name}”`);
              this._notifyCombat(`📦 Item added: ${r.name}`);
              this._auditWrite("ADD_ITEM", { name: r.name }, true, `${r.type} → ${actor.name}`);
            } else if (r?.noop) {
              this._auditWrite("ADD_ITEM", { name: r.name }, true, "no-op (already owned)");
            } else {
              this._auditWrite("ADD_ITEM", { name: eff.name }, false, r?.error);
              await this._warnCreateFailed("item", eff.name, r?.error, r?.suggestion);
            }
            break;
          }
          case "create_foe": {
            // Foe spawning is the default-on creation (low-risk GM convenience):
            // allowed unless aiCreatesContent is "off".
            const mode = Settings.get("aiCreatesContent") ?? "foes";
            if (mode === "off") {
              this._auditWrite("CREATE_FOE", { name: eff.name }, false, "disabled (aiCreatesContent=off)");
              break;
            }
            r = await IronswornController.createFoeActor(eff.name, { rank: eff.rank, important: eff.important });
            if (r?.ok) {
              const tag = r.source === "compendium" ? " [official]" : " [custom]";
              const rk = r.rank ? ` [${r.rank}]` : "";
              applied.push(`👹 spawned foe “${r.name}”${rk}${tag}`);
              this._notifyCombat(`👹 Foe spawned: ${r.name}${rk}${r.source === "compendium" ? ", official" : ""}`);
              this._auditWrite("CREATE_FOE", { name: r.name }, true, `${r.source}${r.match ? `, matched ${r.match}` : ""}`);
              // Advisory: a custom foe that wasn't flagged important but has a
              // close compendium name — suggest the catalogue foe to the GM.
              if (r.source === "custom" && r.suggestion && !eff.important) {
                try {
                  await Chat.postSystem(
                    `<em>👹 “${escapeHtml(eff.name)}” was spawned as a custom foe. `
                    + `Closest official foe: “${escapeHtml(r.suggestion)}”.</em>`,
                    { gmWhisper: true }
                  );
                } catch (_) { /* advisory only */ }
              }
            } else {
              this._auditWrite("CREATE_FOE", { name: eff.name }, false, r?.error);
              await this._warnCreateFailed("foe", eff.name, r?.error, r?.suggestion);
            }
            break;
          }
          case "create_character": {
            const mode = Settings.get("aiCreatesContent") ?? "foes";
            if (mode !== "full") {
              this._auditWrite("CREATE_CHARACTER", { name: eff.name }, false, `disabled (aiCreatesContent=${mode})`);
              break;
            }
            r = await IronswornController.createCharacter(eff.name);
            if (r?.ok) {
              applied.push(`🧝 created character “${r.name}”`);
              this._notifyCombat(`🧝 Character created: ${r.name}`);
              this._auditWrite("CREATE_CHARACTER", { name: r.name }, true, `id=${r.actorId}`);
            } else {
              this._auditWrite("CREATE_CHARACTER", { name: eff.name }, false, r?.error);
              await this._warnCreateFailed("character", eff.name, r?.error);
            }
            break;
          }

          case "initiative": {
            const gain = eff.value === "gain";
            r = await IronswornController.setInitiative(actor, gain);
            if (r?.ok) {
              applied.push(gain ? "seized initiative" : "lost initiative");
              this._notifyInitiative(gain);
            }
            break;
          }
          case "end_combat": {
            // (fix — narrative conclusion) Resolve the foe track even when the
            // AI omits or paraphrases the foe name while narrating the fight's
            // end ("the beast falls", "you cut him down"). Try the literal name,
            // then a fuzzy combat-kind match, then the active-combat track, so a
            // narrated conclusion reliably closes the fight without an exact name.
            let foe = eff.name ? IronswornController.findTrackFuzzy(actor, eff.name, "combat") : null;
            if (!foe) { try { foe = IronswornController.getActiveCombat(actor); } catch (_) { foe = null; } }
            r = foe
              ? await IronswornController.completeTrack(actor, foe.id)
              : await IronswornController.completeTrack(actor, eff.name);
            if (r?.ok) {
              applied.push(`ended combat “${r.name}”`);
              this._notifyCombat(`🏆 Combat ended: ${r.name}`);
              // Phase 2 (story-arc tracking): the fight is over — clear the
              // active-combat flag so stale state never lingers. Best-effort.
              try { await IronswornController.clearActiveCombat(actor); } catch (_) {}
            }
            break;
          }
          case "complete_track": {
            // Resolve the ACTUAL track being fulfilled rather than trusting the
            // literal name the AI emitted (it often writes the move name —
            // "Fulfill Your Vow" / "Reach Your Destination" — or omits the name
            // entirely). completeTrackSmart() falls back to the track the last
            // progress move rolled against, then the newest open track of the
            // implied kind (vow / journey). See IronswornController.
            r = await IronswornController.completeTrackSmart(actor, eff.name, eff.trackKind);
            if (r?.ok) {
              applied.push(`completed “${r.name}”`);
              this._notifyCombat(`🏆 Completed: ${r.name}`);
            } else if (r?.error) {
              // Surface a clear GM-only note only when there is genuinely no
              // open track to close (the fallback already covers slightly-off
              // or move-named directives).
              await Chat.postSystem(
                `<strong>Could not mark complete:</strong> ${escapeHtml(r.error)}`,
                { gmWhisper: true }
              );
            }
            break;
          }

          /* ---- v0.10.27 explicit progress-track WRITE directives ---- */
          case "mark_complete": {
            // [[MARK_COMPLETE:kind:Name]] — close a specific, named track. Fuzzy
            // name match constrained to the directive's kind, so a slight
            // paraphrase still resolves but we never close the wrong KIND.
            const track = IronswornController.findTrackFuzzy(actor, eff.name, eff.trackKind);
            if (!track) {
              this._auditWrite("MARK_COMPLETE", eff, false, `no ${eff.trackKind} track matching "${eff.name}"`);
              await Chat.postSystem(
                `<strong>🤖 Skald could not mark complete:</strong> no ${escapeHtml(eff.trackKind)} track matching “${escapeHtml(eff.name)}”.`,
                { gmWhisper: true }
              );
              break;
            }
            if (foundry.utils.getProperty(track, "system.completed")) {
              this._auditWrite("MARK_COMPLETE", eff, true, `"${track.name}" already complete (no-op)`);
              break; // idempotent — nothing to do, no noisy notification
            }
            r = (eff.trackKind === "combat")
              ? await IronswornController.completeTrack(actor, track.id)
              : await IronswornController.completeTrackSmart(actor, track.id, eff.trackKind);
            if (r?.ok) {
              if (eff.trackKind === "combat") { try { await IronswornController.clearActiveCombat(actor); } catch (_) {} }
              applied.push(`completed “${r.name}”`);
              this._auditWrite("MARK_COMPLETE", eff, true, `completed "${r.name}"`);
              await Chat.postSystem(`<em>🤖 Skald marked “${escapeHtml(r.name)}” complete.</em>`, { gmWhisper: true });
            } else {
              this._auditWrite("MARK_COMPLETE", eff, false, r?.error);
            }
            break;
          }
          case "add_progress": {
            // [[ADD_PROGRESS:kind:Name:N]] — add N boxes (N×4 ticks).
            const track = IronswornController.findTrackFuzzy(actor, eff.name, eff.trackKind);
            if (!track) {
              this._auditWrite("ADD_PROGRESS", eff, false, `no ${eff.trackKind} track matching "${eff.name}"`);
              await Chat.postSystem(
                `<strong>🤖 Skald could not add progress:</strong> no ${escapeHtml(eff.trackKind)} track matching “${escapeHtml(eff.name)}”.`,
                { gmWhisper: true }
              );
              break;
            }
            r = await IronswornController.markProgress(actor, track.id, Math.round(Number(eff.boxes) || 0) * 4);
            if (r?.ok) {
              applied.push(`+${eff.boxes} progress on “${r.track}” (${r.boxes}/10)`);
              this._auditWrite("ADD_PROGRESS", eff, true, `"${r.track}" now ${r.boxes}/10`);
            } else {
              this._auditWrite("ADD_PROGRESS", eff, false, r?.error);
            }
            break;
          }
          case "set_progress": {
            // [[SET_PROGRESS:kind:Name:N]] — set track to exactly N boxes.
            const track = IronswornController.findTrackFuzzy(actor, eff.name, eff.trackKind);
            if (!track) {
              this._auditWrite("SET_PROGRESS", eff, false, `no ${eff.trackKind} track matching "${eff.name}"`);
              await Chat.postSystem(
                `<strong>🤖 Skald could not set progress:</strong> no ${escapeHtml(eff.trackKind)} track matching “${escapeHtml(eff.name)}”.`,
                { gmWhisper: true }
              );
              break;
            }
            r = await IronswornController.setProgress(actor, track.id, eff.boxes);
            if (r?.ok) {
              applied.push(`set “${r.track}” to ${r.boxes}/10`);
              this._auditWrite("SET_PROGRESS", eff, true, `"${r.track}" set to ${r.boxes}/10`);
            } else {
              this._auditWrite("SET_PROGRESS", eff, false, r?.error);
            }
            break;
          }
        }
        if (r && r.ok === false && r.error) {
          console.warn(LOG_PREFIX, `effect ${eff.kind} skipped:`, r.error);
        }
      } catch (e) {
        console.warn(LOG_PREFIX, "applyEffect failed", eff, e);
      }
    }
    if (applied.length && Settings.get("showEffectAnnouncements") !== false) {
      await Chat.postSystem(`<em>The Skald enacts: ${escapeHtml(applied.join("; "))}.</em>`, { gmWhisper: true });
    }
    return applied;
  }
};

/* ===================================================================== */
/*  §8  NPC DIALOGUE SYSTEM                                               */
/* ===================================================================== */

export const NpcDialogue = {
  /** Active NPC sessions keyed by lowercase name. */
  _sessions: new Map(),

  /**
   * Trigger an NPC turn. If the supplied descriptor matches an existing
   * session, continue it; otherwise spin up a fresh NPC persona, complete
   * with a 1-line "stat sketch", and roleplay.
   */
  async invoke(descriptor) {
    const key = descriptor.toLowerCase().slice(0, 64);

    if (!this._sessions.has(key)) {
      // First contact — generate the NPC's persona and stats.
      // If _spawn() failed (typically because the AI was
      // unreachable), it logs the error itself and DOES NOT populate
      // the session map. In that case we just bail out cleanly here
      // instead of crashing on `session.turnCount` below.
      await this._spawn(key, descriptor);
    }
    const session = this._sessions.get(key);
    if (!session) {
      // _spawn already showed a GM-whispered error; nothing more to do.
      console.warn(LOG_PREFIX, `NPC.invoke: no session for "${descriptor}" (spawn failed).`);
      return null;
    }

    // Subsequent turns: open-ended player line goes back to the NPC.
    if ((session.turnCount ?? 0) > 0) {
      const userLine = descriptor.replace(/^[^:]*:\s*/, ""); // strip "Name:" prefix if given
      return this._respond(key, userLine);
    }
    // First turn already produced a greeting from _spawn().
    return session.lastReply ?? null;
  },

  /** Create a brand-new NPC session and post their introduction. */
  async _spawn(key, descriptor) {
    const channel = `npc:${key}`;
    Memory.reset(channel);

    // Roll quick personality flavour from the oracles.
    const role = IronswornData.rollOracle(IronswornData.oracles.npcRole);
    const desc = IronswornData.rollOracle(IronswornData.oracles.npcDescriptor);
    const goal = IronswornData.rollOracle(IronswornData.oracles.npcGoal);

    const sketch = `Quick oracle sketch — Role: ${role.result} (${role.roll}); Descriptor: ${desc.result} (${desc.roll}); Goal: ${goal.result} (${goal.roll}).`;

    const task = `You are now embodying an NPC the players have just met: "${descriptor}". ${sketch}
First, produce a one-line "STATS" block in this exact format:
STATS: <name>; rank <troublesome|dangerous|formidable|extreme|epic>; <one-line manner>; goal: <short>.
Then on a new line speak as the NPC — greet the players in-character, in 2-4 sentences. Use quotation marks for their spoken dialogue.`;

    try {
      const memory = await RagBridge.fetchMemory(descriptor);
      const messages = [
        { role: "system", content: buildSystemPrompt({ task, memory }) },
        { role: "user", content: `Introduce the NPC: ${descriptor}` }
      ];
      const reply = await Client.chat(messages, { temperature: 0.9 });
      Memory.push(channel, "user", `Introduce the NPC: ${descriptor}`);
      Memory.push(channel, "assistant", reply);

      const { stats, dialogue } = this._splitStats(reply);
      this._sessions.set(key, {
        descriptor, channel,
        stats, turnCount: 1, lastReply: reply
      });

      // Scribe the freshly-met NPC into the chronicle (background, best-effort).
      try {
        const npcName = this._extractName(descriptor, stats);
        if (npcName) {
          JournalSystem.ingestMetadata({
            entities: [{
              type: "npc",
              name: npcName,
              action: "create",
              description: (dialogue || reply).replace(/\s+/g, " ").trim().slice(0, 400),
              motivations: stats || descriptor
            }]
          }, { channel: "npc" });
        }
      } catch (e) { console.warn(LOG_PREFIX, "NPC journal ingest failed", e); }

      const body = `${stats ? `<div class="es-npc-stats">${escapeHtml(stats)}</div>` : ""}${formatMarkdown(dialogue || reply)}`;
      await Chat.postSkald(body, {
        variant: "npc",
        alias: this._extractName(descriptor, stats),
        title: `Encounter`
      });
    } catch (err) {
      console.error(LOG_PREFIX, "NPC spawn failed", err);
      await Chat.postSystem(`<strong>The Skald cannot summon them:</strong> ${escapeHtml(err.message)}`, { gmWhisper: true });
    }
  },

  /** Continue a session — the NPC replies to the player's last line. */
  async _respond(key, userLine) {
    const session = this._sessions.get(key);
    if (!session) return null;
    try {
      const task = `You remain in the voice of the NPC introduced earlier ("${session.descriptor}"). Respond in-character, 1-3 sentences. Honour their stated goal and manner. Do NOT narrate other characters' actions. Use quotation marks for spoken dialogue.`;
      const memory = await RagBridge.fetchMemory(`${session.descriptor} ${userLine}`.trim());
      const messages = [
        { role: "system", content: buildSystemPrompt({ task, memory }) },
        ...Memory.get(session.channel),
        { role: "user", content: userLine }
      ];
      const alias = this._extractName(session.descriptor, session.stats);
      let reply;
      if (Settings.get("streamingEnabled") !== false) {
        // Stream the NPC's reply live in their own voice/alias.
        ({ reply } = await callSkaldStreaming(messages, {
          variant: "npc",
          alias,
          chatOpts: { temperature: 0.85 }
        }));
      } else {
        reply = await Client.chat(messages, { temperature: 0.85 });
        await Chat.postSkald(formatMarkdown(reply), { variant: "npc", alias });
      }
      Memory.push(session.channel, "user", userLine);
      Memory.push(session.channel, "assistant", reply);
      session.turnCount++;
      session.lastReply = reply;
      return reply;
    } catch (err) {
      console.error(LOG_PREFIX, "NPC respond failed", err);
      await Chat.postSystem(`<strong>The voice grows quiet:</strong> ${escapeHtml(err.message)}`, { gmWhisper: true });
      return null;
    }
  },

  /**
   * Optional: persist the most recent NPC as a Foundry Actor stub for
   * later reference. GM-only.
   */
  async persistLast() {
    if (!game.user.isGM) return null;
    const last = [...this._sessions.values()].pop();
    if (!last) {
      ui.notifications?.warn("No NPC to persist yet.");
      return null;
    }
    const name = this._extractName(last.descriptor, last.stats) || last.descriptor;
    try {
      const actor = await Actor.create({
        name,
        type: CONFIG.Actor.documentClass.metadata?.types?.[0] ?? "character",
        flags: { [MODULE_ID]: { skaldGenerated: true, stats: last.stats, descriptor: last.descriptor } }
      });
      ui.notifications?.info(`Skald scribes ${actor.name} into the chronicle.`);
      return actor;
    } catch (err) {
      console.warn(LOG_PREFIX, "Could not persist actor", err);
      ui.notifications?.warn(`Could not create actor: ${err.message}`);
      return null;
    }
  },

  _splitStats(reply) {
    const m = reply.match(/^\s*STATS:\s*(.+?)\s*$/im);
    if (!m) return { stats: null, dialogue: reply };
    const stats = m[1];
    const dialogue = reply.replace(m[0], "").trim();
    return { stats, dialogue };
  },

  _extractName(descriptor, stats) {
    if (stats) {
      const m = stats.match(/^([^;]+?);/);
      if (m) return m[1].trim();
    }
    // fall back to the words before the first comma in descriptor
    return descriptor.split(/[,—-]/)[0].trim() || "Stranger";
  }
};

/* ===================================================================== */
/*  §9  ORACLE INTERPRETER                                                */
/* ===================================================================== */

export const OracleInterpreter = {
  async roll(alias) {
    const resolved = IronswornData.oracleAliases[alias] || alias;
    const table = IronswornData.oracles[resolved];
    if (!table) {
      const known = Object.keys(IronswornData.oracles).join(", ");
      return Chat.postSystem(
        `Unknown oracle <code>${escapeHtml(alias)}</code>. Try one of: ${known}.`
      );
    }

    const { roll, result } = IronswornData.rollOracle(table);
    const oracleLabel = this._labelFor(resolved);

    // Post the raw oracle roll first so the GM sees the source of truth.
    const oracleHtml = `
      <div class="es-oracle-row"><span class="es-oracle-label">${oracleLabel}</span>
        <span class="es-oracle-roll">d100 → ${roll}</span></div>
      <div class="es-oracle-result"><strong>${escapeHtml(result)}</strong></div>
    `;
    await Chat.postSkald(oracleHtml, { variant: "oracle", title: "The Bones Speak" });

    // Then ask the LLM to interpret narratively.
    const task = `The fates have spoken. The oracle "${oracleLabel}" returned: "${result}" (roll ${roll}).
Interpret this for the current Ironsworn scene in 2-4 sentences. Be specific and useful — offer a concrete hook the GM can run with. Do not re-roll, do not invent additional oracle results.`;
    try {
      const memory = await RagBridge.fetchMemory(`${oracleLabel}: ${result}`);
      const messages = [
        { role: "system", content: buildSystemPrompt({ task, memory }) },
        { role: "user", content: `Interpret the oracle result: ${result}` }
      ];
      const cardOpts = { variant: "oracle", title: "What the Skald Hears" };
      let reply;
      if (Settings.get("streamingEnabled") !== false) {
        ({ reply } = await callSkaldStreaming(messages, { ...cardOpts, chatOpts: { temperature: 0.85 } }));
      } else {
        reply = await Client.chat(messages, { temperature: 0.85 });
        await Chat.postSkald(formatMarkdown(reply), cardOpts);
      }
      return reply;
    } catch (err) {
      console.warn(LOG_PREFIX, "Oracle interpretation failed", err);
      // The raw roll is still posted — degrade gracefully.
      await Chat.postSystem(
        `Oracle rolled, but the Skald is hoarse: ${escapeHtml(err.message)}`,
        { gmWhisper: true }
      );
      return null;
    }
  },

  _labelFor(key) {
    const map = {
      action: "Action Oracle",
      theme: "Theme Oracle",
      region: "Region Oracle",
      location: "Location Oracle",
      coastal: "Coastal Waters Oracle",
      npcRole: "NPC Role Oracle",
      npcGoal: "NPC Goal Oracle",
      npcDescriptor: "NPC Descriptor Oracle",
      combatAction: "Combat Action Oracle",
      mysticBacklash: "Mystic Backlash Oracle",
      payThePrice: "Pay the Price Oracle"
    };
    return map[key] ?? key;
  }
};

/* ===================================================================== */
/*  §10 JOURNAL / LORE GENERATOR                                          */
/* ===================================================================== */

export const LoreGenerator = {
  FOLDER_NAME: "Skald's Chronicles",

  async write(topic) {
    const task = `Compose 3-5 short paragraphs of Ironsworn world-building lore on the topic: "${topic}". Norse-tinged, evocative, GM-usable. Include at least one named place, one named figure, and one rumour or hook. Format with a clear opening sentence; use occasional **bold** for proper nouns.`;
    try {
      const memory = await RagBridge.fetchMemory(topic);
      const reply = await Client.chat([
        { role: "system", content: buildSystemPrompt({ task, memory }) },
        { role: "user", content: `Write lore on: ${topic}` }
      ], { temperature: 0.85, maxTokens: 1100 });

      // Post a chat preview.
      await Chat.postSkald(formatMarkdown(reply), {
        variant: "lore",
        title: `Chronicle: ${topic}`
      });

      // Create a JournalEntry if the user is permitted to do so.
      if (game.user.can("JOURNAL_CREATE") || game.user.isGM) {
        const folder = await this._getOrCreateFolder();
        // Stored in a JournalEntry — skip move links (no chat handler there);
        // @UUID journal links would still enrich, but keep stored lore plain.
        const journalContent = `<h2>${escapeHtml(topic)}</h2>${formatMarkdown(reply, { link: false })}`;
        const entry = await JournalEntry.create({
          name: topic.slice(0, 80),
          folder: folder?.id ?? null,
          pages: [{
            name: topic.slice(0, 80),
            type: "text",
            text: { content: journalContent, format: 1 /* HTML */ }
          }],
          flags: { [MODULE_ID]: { generated: true, topic } }
        });
        if (entry) {
          await Chat.postSystem(
            `<em>Inscribed in the chronicle: <strong>${escapeHtml(entry.name)}</strong></em>`,
            { gmWhisper: true }
          );
        }
        return entry;
      }
      return null;
    } catch (err) {
      console.error(LOG_PREFIX, "Lore failed", err);
      await Chat.postSystem(
        `<strong>The chronicle blots:</strong> ${escapeHtml(err.message)}`,
        { gmWhisper: true }
      );
      return null;
    }
  },

  async _getOrCreateFolder() {
    let folder = game.folders.find(f => f.type === "JournalEntry" && f.name === this.FOLDER_NAME);
    if (folder) return folder;
    try {
      folder = await Folder.create({
        name: this.FOLDER_NAME,
        type: "JournalEntry",
        color: "#8c6a2f"
      });
    } catch (e) {
      console.warn(LOG_PREFIX, "Could not create chronicle folder", e);
      folder = null;
    }
    return folder;
  }
};

/* ===================================================================== */
/*  §10b AUTO-JOURNALING SYSTEM (v0.4.0)                                  */
/* ===================================================================== */

/**
 * A tiny, dependency-free background work queue.
 *
 * Journal writes touch the Foundry document database and can conflict if
 * fired concurrently (e.g. two replies both trying to create the same
 * folder, or append to the same rolling journal). {@link JournalQueue}
 * serialises them: jobs are processed strictly one-at-a-time, in order, on
 * a microtask drain loop so the caller never blocks. A failing job logs and
 * is skipped — it never stalls the queue or surfaces an error to the player.
 */
class JournalQueue {
  /** @param {(job:any)=>Promise<void>} processor */
  constructor(processor) {
    this._jobs = [];
    this._busy = false;
    this._processor = processor;
  }

  /** Add a job and kick the drain loop (non-blocking). */
  enqueue(job) {
    this._jobs.push(job);
    // Fire-and-forget: never await from the caller's path.
    this._drain().catch(e => console.warn(LOG_PREFIX, "JournalQueue drain crashed:", e?.message || e));
    return this;
  }

  /** Number of jobs still waiting (excludes the one in flight). */
  get size() { return this._jobs.length; }

  /** Process jobs sequentially until the queue empties. */
  async _drain() {
    if (this._busy) return;
    this._busy = true;
    try {
      while (this._jobs.length) {
        const job = this._jobs.shift();
        try {
          await this._processor(job);
        } catch (e) {
          console.warn(LOG_PREFIX, "JournalQueue job failed:", e?.message || e, job?.kind ?? "");
        }
      }
    } finally {
      this._busy = false;
    }
  }
}

/**
 * The auto-journaling brain (v0.4.0).
 *
 * Parses the chronicle metadata the AI appends to its replies (see
 * {@link buildJournalPromptBlock}) and turns it into Foundry Journal
 * Entries, organised into a tidy folder tree, with optional minimal toast
 * notifications. World Facts and Story Threads are tracked SILENTLY in
 * rolling journals; NPCs / Locations / Discoveries get individual entries
 * and a small toast. Session Chronicles are generated on demand from an
 * in-memory activity log.
 *
 * All writes go through {@link JournalQueue} so they never block narration.
 */
export const JournalSystem = {
  ROOT_FOLDER: SKALD_NAME,            // "The Eternal Skald"
  _folderColor: "#8c6a2f",

  /**
   * type-key → spec. Each individual-entry type (npc / location / discovery)
   * now carries a `fields` template (v0.8.0): an ordered list of structured
   * fields the AI is asked to fill, the !template dialog renders as inputs,
   * and {@link _renderEntityHtml} displays. Each field is
   * `{ key, label, area?, choices? }`:
   *   • key     — the metadata/flag property name
   *   • label   — human-readable label for prompts, dialogs and rendering
   *   • area    — render as a multi-line <textarea> in the !template dialog
   *   • choices — optional fixed value list (rendered as a <select>)
   * The template is purely additive: legacy entries that lack a field simply
   * omit it, and unknown fields on an entity are ignored.
   */
  TYPES: {
    npc: {
      folder: "NPCs", label: "NPC", emoji: "👤", rolling: false,
      fields: [
        { key: "description",   label: "Description",   area: true },
        { key: "rank",          label: "Rank",          choices: ["troublesome", "dangerous", "formidable", "extreme", "epic"] },
        { key: "harm",          label: "Harm / Status" },
        { key: "motivations",   label: "Motivations",   area: true },
        { key: "goals",         label: "Goals",         area: true },
        { key: "relationships", label: "Relationships", area: true }
      ]
    },
    location: {
      folder: "Locations", label: "Location", emoji: "🗺️", rolling: false,
      fields: [
        { key: "description", label: "Description",      area: true },
        { key: "region",      label: "Region" },
        { key: "features",    label: "Notable features", area: true },
        { key: "dangers",     label: "Dangers",          area: true },
        { key: "resources",   label: "Resources",        area: true }
      ]
    },
    discovery: {
      folder: "Discoveries", label: "Discovery", emoji: "🔍", rolling: false,
      fields: [
        { key: "description",  label: "Description",  area: true },
        { key: "significance", label: "Significance", area: true },
        { key: "connectedTo",  label: "Connected to" }
      ]
    },
    worldFact:   { folder: "World Facts",        label: "World Fact",   emoji: "📜", rolling: true, journalName: "Established Facts" },
    storyThread: { folder: "Story Threads",      label: "Story Thread", emoji: "🧵", rolling: true, journalName: "Threads & Mysteries" },
    session:     { folder: "Session Chronicles", label: "Session",      emoji: "📖", rolling: false }
  },

  /** All structured field keys across the templated types (for update/context). */
  _allFieldKeys() {
    const keys = new Set();
    for (const t of ["npc", "location", "discovery"]) {
      for (const f of (this.TYPES[t]?.fields ?? [])) keys.add(f.key);
    }
    return [...keys];
  },

  /** Cache of resolved Folder documents keyed by folder name (per session). */
  _folderCache: new Map(),

  /** Background work queue (initialised lazily on first use). */
  _queue: null,

  /** Rolling in-memory log of session activity, drained by !end-session. */
  _sessionLog: [],

  /**
   * (v0.9.0) Monotonic "journal generation" counter. Bumped whenever a
   * chronicle JournalEntry is created, renamed, or deleted. Consumers that
   * cache an expensive scan of `game.journal` (notably {@link EntityLinker})
   * can compare against this cheap integer to know whether their cache is
   * still valid — avoiding a full re-scan of every journal on each rebuild.
   * This is the key optimisation for large campaigns (100+ journals), where
   * the per-narration entity-index rebuild previously re-walked the entire
   * journal collection (×3, once per entity type) every time.
   * @type {number}
   */
  _journalGen: 0,

  /** (v0.9.0) Handle for the idle auto-summary timer (or null). */
  _idleTimer: null,

  /** (v0.9.0) Guards against re-entrant / overlapping auto-summary runs. */
  _autoSummaryRunning: false,

  /** (v0.9.0) Current journal generation token (see {@link _journalGen}). */
  journalGeneration() { return this._journalGen; },

  /**
   * (v0.9.0) Invalidate cached journal scans by advancing the generation
   * counter. Cheap, defensive, and safe to call from hooks at high frequency.
   */
  bumpJournalGeneration() {
    this._journalGen = (this._journalGen + 1) | 0;
    if (this._journalGen < 0) this._journalGen = 0; // wrap defensively
  },

  /* ---------------- gating / accessors ---------------- */

  enabled()       { return Settings.get("autoJournaling") !== false; },
  notifyLevel()   { return Settings.get("journalNotifications") || "minimal"; },
  permission()    { return Settings.get("journalPermissions") || "gm-only"; },
  sessionAuto()   { return Settings.get("sessionAutoSummary") !== false; },

  /**
   * (v0.9.0) Idle minutes after which an automatic Session Chronicle is
   * woven if the session has unsaved activity. 0 disables the idle timer
   * (manual !end-session still works). Clamped to a sane range.
   */
  sessionAutoMinutes() {
    const n = Number(Settings.get("sessionAutoMinutes"));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(240, Math.max(1, Math.round(n)));
  },

  /* ---------------- idle auto session-summary (v0.9.0) ---------------- */

  /**
   * Is THIS client the one responsible for writing the automatic chronicle?
   * Only the active GM runs the idle timer, so a multi-client table never
   * generates duplicate session chronicles. (v0.9.0)
   */
  _isAutoSummaryHost() {
    try {
      if (!game.user?.isGM) return false;
      // Prefer the canonical "active GM" when Foundry exposes it.
      const activeGM = game.users?.activeGM;
      if (activeGM && activeGM.id !== game.user.id) return false;
      return this.sessionAuto() && this.sessionAutoMinutes() > 0;
    } catch (_) { return false; }
  },

  /** Cancel any pending idle auto-summary timer. (v0.9.0) */
  _clearIdleTimer() {
    try { if (this._idleTimer) { clearTimeout(this._idleTimer); } } catch (_) {}
    this._idleTimer = null;
  },

  /**
   * (Re)arm the inactivity timer. Called whenever the chronicle records new
   * activity. After `sessionAutoMinutes` of silence, an automatic Session
   * Chronicle is woven. Fully defensive — never throws into the ingest path.
   * (v0.9.0)
   */
  _resetIdleTimer() {
    try {
      this._clearIdleTimer();
      if (!this._isAutoSummaryHost()) return;
      const mins = this.sessionAutoMinutes();
      if (!mins) return;
      const ms = mins * 60 * 1000;
      this._idleTimer = setTimeout(() => {
        this._idleTimer = null;
        this._runAutoSummary().catch(e =>
          console.warn(LOG_PREFIX, "auto session-summary failed:", e?.message || e));
      }, ms);
    } catch (e) {
      console.warn(LOG_PREFIX, "_resetIdleTimer failed:", e?.message || e);
    }
  },

  /**
   * Weave an automatic Session Chronicle if there is unsaved activity. Guarded
   * so it never runs concurrently with itself or a manual !end-session.
   * (v0.9.0)
   */
  async _runAutoSummary() {
    if (this._autoSummaryRunning) return null;
    // Re-check conditions at fire time (settings may have changed; the log may
    // have been drained by a manual !end-session in the meantime).
    if (!this._isAutoSummaryHost()) return null;
    if (!Array.isArray(this._sessionLog) || !this._sessionLog.length) return null;
    this._autoSummaryRunning = true;
    try {
      await Chat.postSystem(
        `<em>${SKALD_NAME} senses a lull and gathers the session's threads…</em>`,
        { gmWhisper: true }
      );
      return await this.generateSessionChronicle({ announce: true, auto: true });
    } finally {
      this._autoSummaryRunning = false;
    }
  },

  /** Only GMs (or users with journal-create rights) write journals. */
  canWrite() {
    try { return game.user?.isGM || game.user?.can?.("JOURNAL_CREATE"); }
    catch (_) { return false; }
  },

  queue() {
    if (!this._queue) this._queue = new JournalQueue((job) => this._process(job));
    return this._queue;
  },

  /* ---------------- public entry point ---------------- */

  /**
   * Ingest a COMPLETE AI reply: parse its chronicle metadata (if any),
   * record it to the session log, and enqueue background journal writes.
   * Non-blocking, swallows all errors — journaling must never break play.
   *
   * @param {string} reply
   * @param {object} [ctx]
   * @param {string} [ctx.channel] - conversation channel (for the log)
   * @param {string} [ctx.sourceVow] - vow id for context flags
   * @returns {object|null} the parsed metadata (or null)
   */
  ingestReply(reply, ctx = {}) {
    try {
      if (!this.enabled() || !this.canWrite()) return null;
      const { metadata } = parseMetadata(reply);
      if (!metadata || typeof metadata !== "object") return null;
      this.ingestMetadata(metadata, ctx);
      return metadata;
    } catch (e) {
      console.warn(LOG_PREFIX, "ingestReply failed:", e?.message || e);
      return null;
    }
  },

  /**
   * Process an already-parsed metadata object. Records to the session log
   * and enqueues a background job per actionable item.
   */
  ingestMetadata(metadata, ctx = {}) {
    if (!metadata || typeof metadata !== "object") return;
    const sourceVow = ctx.sourceVow ?? this._currentVowId();

    // 1) Record to the session log for the eventual chronicle.
    this._sessionLog.push({
      t: Date.now(),
      channel: ctx.channel ?? "general",
      entities: Array.isArray(metadata.entities) ? metadata.entities.map(e => ({ type: e?.type, name: e?.name })) : [],
      facts: Array.isArray(metadata.facts) ? metadata.facts.slice() : [],
      mysteries: Array.isArray(metadata.mysteries) ? metadata.mysteries.slice() : [],
      decisions: Array.isArray(metadata.decisions) ? metadata.decisions.slice() : [],
      worldState: (metadata.worldState && typeof metadata.worldState === "object") ? { ...metadata.worldState } : {}
    });
    // Keep the log from growing without bound during marathon sessions.
    if (this._sessionLog.length > 500) this._sessionLog.splice(0, this._sessionLog.length - 500);

    // (v0.9.0) Fresh activity — (re)arm the idle auto-summary timer so a
    // lull eventually weaves a Session Chronicle on its own. Fully defensive.
    try { this._resetIdleTimer(); } catch (_) { /* never break ingest */ }

    // 1b) (v0.8.0) Persist a compact, permanent timeline event so `!timeline`
    // can render the full campaign history across reloads/sessions. This is
    // GM-only (world setting write) and fire-and-forget — never block or break
    // narration if persistence fails.
    try { this._recordTimelineEvent(metadata, ctx); } catch (_) { /* non-fatal */ }

    // 1c) (v0.9.0) Contradiction detection — compare freshly narrated facts
    // against established lore and surface a gentle GM-only advisory if the
    // saga seems to be tripping over itself. Fire-and-forget and fully
    // defensive: a detector hiccup must never interrupt the chronicle.
    try { ContradictionDetector.check(metadata); } catch (_) { /* never break ingest */ }

    const q = this.queue();

    // 2) Entities → individual NPC / Location / Discovery journals.
    if (Array.isArray(metadata.entities)) {
      for (const ent of metadata.entities) {
        if (!ent || typeof ent !== "object") continue;
        const type = String(ent.type || "").toLowerCase();
        if (!["npc", "location", "discovery"].includes(type)) continue;
        if (!ent.name || typeof ent.name !== "string") continue;
        q.enqueue({ kind: "entity", type, entity: ent, sourceVow });
      }
    }

    // 3) Silent rolling trackers.
    const facts = Array.isArray(metadata.facts) ? metadata.facts.filter(s => typeof s === "string" && s.trim()) : [];
    if (facts.length) q.enqueue({ kind: "facts", facts, sourceVow });

    const mysteries = Array.isArray(metadata.mysteries) ? metadata.mysteries.filter(s => typeof s === "string" && s.trim()) : [];
    const decisions = Array.isArray(metadata.decisions) ? metadata.decisions.filter(s => typeof s === "string" && s.trim()) : [];
    const worldState = (metadata.worldState && typeof metadata.worldState === "object") ? metadata.worldState : null;
    if (mysteries.length || decisions.length || (worldState && Object.keys(worldState).length)) {
      q.enqueue({ kind: "thread", mysteries, decisions, worldState, sourceVow });
    }
  },

  /* ---------------- timeline (v0.8.0) ---------------- */

  /**
   * (v0.8.0) Append a compact, permanent event to the world-scoped timeline.
   * Only the GM (a client that `canWrite()`) persists events, avoiding races
   * from multiple clients. Each event is small (names + short summaries) so the
   * log stays lightweight even across long campaigns; capped at 1000 entries.
   *
   * @param {object} metadata  Parsed SKALD metadata.
   * @param {object} ctx        Ingestion context ({ channel, sourceVow }).
   */
  _recordTimelineEvent(metadata, ctx = {}) {
    if (!this.canWrite()) return;
    if (!metadata || typeof metadata !== "object") return;

    const entities = Array.isArray(metadata.entities)
      ? metadata.entities
          .filter(e => e && typeof e === "object" && typeof e.name === "string" && e.name.trim())
          .map(e => ({ type: String(e.type || "").toLowerCase(), name: e.name.trim() }))
      : [];
    const facts = Array.isArray(metadata.facts)
      ? metadata.facts.filter(s => typeof s === "string" && s.trim()).map(s => s.trim()) : [];
    const mysteries = Array.isArray(metadata.mysteries)
      ? metadata.mysteries.filter(s => typeof s === "string" && s.trim()).map(s => s.trim()) : [];
    const decisions = Array.isArray(metadata.decisions)
      ? metadata.decisions.filter(s => typeof s === "string" && s.trim()).map(s => s.trim()) : [];

    // Skip empty pulses — nothing worth remembering happened.
    if (!entities.length && !facts.length && !mysteries.length && !decisions.length) return;

    const event = {
      id: `tl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      t: Date.now(),
      channel: ctx.channel ?? "general",
      entities,
      facts,
      mysteries,
      decisions
    };

    // Read → push → cap → write. Fire-and-forget; persistence must never throw
    // into the narration path.
    Promise.resolve()
      .then(() => {
        let log = [];
        try { log = Settings.get("timelineEvents") || []; } catch (_) { log = []; }
        if (!Array.isArray(log)) log = [];
        log.push(event);
        if (log.length > 1000) log.splice(0, log.length - 1000);
        return game.settings.set(MODULE_ID, "timelineEvents", log);
      })
      .catch(() => { /* non-fatal: timeline persistence is best-effort */ });
  },

  /**
   * (v0.8.0) Return the persisted timeline events (oldest → newest), optionally
   * filtered by a free-text query matching entity names, facts, mysteries,
   * decisions, or channel.
   *
   * @param {string} [query]  Optional case-insensitive search string.
   * @returns {Array<object>} Matching timeline events.
   */
  getTimeline(query = "") {
    let log = [];
    try { log = Settings.get("timelineEvents") || []; } catch (_) { log = []; }
    if (!Array.isArray(log)) log = [];
    const q = String(query || "").trim().toLowerCase();
    if (!q) return log.slice();
    return log.filter(ev => {
      try {
        const hay = [
          ev.channel,
          ...(ev.entities || []).map(e => e?.name),
          ...(ev.facts || []),
          ...(ev.mysteries || []),
          ...(ev.decisions || [])
        ].filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q);
      } catch (_) { return false; }
    });
  },

  /** (v0.8.0) Wipe the persistent timeline (GM-only). */
  async clearTimeline() {
    if (!this.canWrite()) return false;
    try { await game.settings.set(MODULE_ID, "timelineEvents", []); return true; }
    catch (_) { return false; }
  },

  /* ---------------- queue processor ---------------- */

  async _process(job) {
    if (!job || !this.canWrite()) return;
    switch (job.kind) {
      case "entity":  return this._processEntity(job);
      case "facts":   return this._processFacts(job);
      case "thread":  return this._processThread(job);
      default: return;
    }
  },

  async _processEntity(job) {
    const { type, entity, sourceVow } = job;
    // Dedupe by name (now alias- and fuzzy-aware, v0.8.0): if an entry already
    // exists for this name OR any of its aliases/synonyms, augment it instead
    // of making a twin.
    const aliases = this._extractAliases(entity);
    const existing = this._findEntry(type, entity.name, aliases);
    if (existing) return this._updateEntity(existing, type, entity, sourceVow);
    return this._createEntity(type, entity, sourceVow);
  },

  async _createEntity(type, entity, sourceVow, opts = {}) {
    const folder = await this.getOrCreateFolder(type);
    const name = String(entity.name).slice(0, 100);
    const html = this._renderEntityHtml(type, entity);
    const aliases = this._extractAliases(entity);
    const entry = await JournalEntry.create({
      name,
      folder: folder?.id ?? null,
      ownership: this._ownership(),
      pages: [{
        name,
        type: "text",
        text: { content: html, format: 1 /* HTML */ }
      }],
      flags: {
        [MODULE_ID]: {
          type,
          createdBy: opts.createdBy ?? "ai",
          lastUpdated: Date.now(),
          relatedEntities: [],
          aliases,
          sourceVow: sourceVow ?? null,
          aiContext: this._entityContext(entity)
        }
      }
    });
    if (entry) {
      this._toast(name, type);
      // Resolve & persist any AI-declared relationships, both directions (v0.8.0).
      try { await this._syncRelationships(entry, entity); }
      catch (e) { console.warn(LOG_PREFIX, "relationship sync failed:", e?.message || e); }
      // Embed into semantic memory (v0.5.0) — fire-and-forget.
      RagBridge.indexEntry(entry);
      // A new linkable entity exists — refresh the narration link index.
      try { EntityLinker.invalidate(); } catch (_) {}
    }
    return entry;
  },

  async _updateEntity(entry, type, entity, sourceVow) {
    try {
      const page = entry.pages?.contents?.[0] ?? entry.pages?.find?.(() => true);
      const prev = page?.text?.content ?? "";
      const addition = this._renderEntityUpdateHtml(entity);
      const merged = `${prev}\n<hr class="es-journal-sep"/>\n${addition}`;
      if (page) {
        await page.update({ "text.content": merged });
      }
      const existingCtx = entry.getFlag?.(MODULE_ID, "aiContext") || "";
      // Merge any newly-supplied aliases with the ones already stored.
      const mergedAliases = this._mergeAliases(
        this._entryAliases(entry), this._extractAliases(entity)
      );
      await entry.update({
        flags: {
          [MODULE_ID]: {
            type,
            lastUpdated: Date.now(),
            aliases: mergedAliases,
            sourceVow: sourceVow ?? entry.getFlag?.(MODULE_ID, "sourceVow") ?? null,
            aiContext: `${existingCtx}\n${this._entityContext(entity)}`.trim().slice(0, 4000)
          }
        }
      });
      // Resolve & persist any AI-declared relationships, both directions (v0.8.0).
      try { await this._syncRelationships(entry, entity); }
      catch (e) { console.warn(LOG_PREFIX, "relationship sync failed:", e?.message || e); }
      // Updates are quieter than creates — only toast in "detailed" mode.
      if (this.notifyLevel() === "detailed") this._toast(entry.name, type, "Updated");
      // Re-embed the updated entry so memory reflects the new content (v0.5.0).
      RagBridge.indexEntry(entry);
      try { EntityLinker.invalidate(); } catch (_) {}
      return entry;
    } catch (e) {
      console.warn(LOG_PREFIX, "_updateEntity failed:", e?.message || e);
      return null;
    }
  },

  /* ---------------- aliases & relationships (v0.8.0) ---------------- */

  /** Sanitise the AI-supplied `aliases` array into clean, de-duped strings. */
  _extractAliases(entity) {
    const raw = entity?.aliases;
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const a of raw) {
      const s = String(a ?? "").trim().slice(0, 80);
      if (!s) continue;
      const k = s.toLowerCase();
      // Don't store an "alias" that merely repeats the entity's own name.
      if (k === String(entity?.name ?? "").toLowerCase().trim()) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
    return out.slice(0, 12);
  },

  /** Union two alias lists, de-duped case-insensitively, capped. */
  _mergeAliases(existing, incoming) {
    const out = [];
    const seen = new Set();
    for (const a of [...(existing || []), ...(incoming || [])]) {
      const s = String(a ?? "").trim();
      if (!s) continue;
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
    return out.slice(0, 16);
  },

  /** Sanitise the AI-supplied `related` array into [{name, rel}] tuples. */
  _extractRelated(entity) {
    const raw = entity?.related ?? entity?.relatedEntities;
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const r of raw) {
      if (!r) continue;
      let name, rel;
      if (typeof r === "string") { name = r; rel = "related"; }
      else if (typeof r === "object") {
        name = r.name ?? r.entity ?? r.target;
        rel = r.rel ?? r.relationship ?? r.relation ?? "related";
      }
      name = String(name ?? "").trim().slice(0, 100);
      rel = String(rel ?? "related").trim().slice(0, 80) || "related";
      if (name) out.push({ name, rel });
    }
    return out.slice(0, 24);
  },

  /** Find any individual (npc/location/discovery) entry by name/alias. */
  _findAnyEntry(name) {
    for (const t of ["npc", "location", "discovery"]) {
      const hit = this._findEntry(t, name);
      if (hit) return hit;
    }
    return null;
  },

  /** Read the relatedEntities array off an entry (always an array). */
  _entryRelated(entry) {
    try {
      const r = entry?.getFlag?.(MODULE_ID, "relatedEntities");
      return Array.isArray(r) ? r.slice() : [];
    } catch (_) { return []; }
  },

  /** Merge a relationship into a relatedEntities list, de-duped by uuid. */
  _mergeRelated(list, rec) {
    const out = (list || []).filter(x => x && x.uuid !== rec.uuid);
    out.push(rec);
    return out.slice(0, 50);
  },

  /**
   * Resolve an entity's declared `related` connections to existing chronicle
   * entries and persist them as UUIDs in the `relatedEntities` flag — on BOTH
   * sides (bidirectional, v0.8.0). Targets that don't yet have an entry are
   * skipped silently (they'll link the next time either side is mentioned).
   */
  async _syncRelationships(entry, entity) {
    const related = this._extractRelated(entity);
    if (!related.length || !entry) return;
    const selfUuid = entry.uuid ?? `JournalEntry.${entry.id}`;
    let myList = this._entryRelated(entry);
    const touched = new Set(); // target entries whose connections block needs refresh

    for (const { name, rel } of related) {
      const target = this._findAnyEntry(name);
      // Skip self-references and unresolved targets.
      if (!target) continue;
      const tUuid = target.uuid ?? `JournalEntry.${target.id}`;
      if (tUuid === selfUuid) continue;

      // Forward: me → target.
      myList = this._mergeRelated(myList, { uuid: tUuid, name: target.name, rel });

      // Reciprocal: target → me (only if not already present with this uuid).
      try {
        const tList = this._mergeRelated(this._entryRelated(target),
          { uuid: selfUuid, name: entry.name, rel });
        await target.update({ flags: { [MODULE_ID]: { relatedEntities: tList } } });
        await this._refreshConnectionsBlock(target, tList);
        touched.add(tUuid);
      } catch (e) {
        console.warn(LOG_PREFIX, "reciprocal relationship write failed:", e?.message || e);
      }
    }

    try {
      await entry.update({ flags: { [MODULE_ID]: { relatedEntities: myList } } });
      await this._refreshConnectionsBlock(entry, myList);
    } catch (e) {
      console.warn(LOG_PREFIX, "relationship write failed:", e?.message || e);
    }
  },

  /** Build the HTML for an entry's Connections section (content links). */
  _renderConnectionsBlock(list) {
    if (!Array.isArray(list) || !list.length) return "";
    const items = list.map(r => {
      const label = escapeHtml(String(r.name ?? "").replace(/[{}]/g, "")) || "(unknown)";
      const link = r.uuid ? `@UUID[${r.uuid}]{${label}}` : label;
      const rel = r.rel && r.rel !== "related" ? ` — <em>${escapeHtml(String(r.rel))}</em>` : "";
      return `<li>${link}${rel}</li>`;
    }).join("");
    return `<div class="es-connections" data-es-connections="1">` +
      `<hr class="es-journal-sep"/>` +
      `<p class="es-connections-head"><strong>🔗 Connections</strong></p>` +
      `<ul class="es-connections-list">${items}</ul></div>`;
  },

  /**
   * Rewrite (idempotently) the Connections block at the end of an entry's
   * first page so the relationship list is visible inside the journal too.
   * Strips any previous block first, keyed by the data-es-connections marker.
   */
  async _refreshConnectionsBlock(entry, list) {
    try {
      const page = entry.pages?.contents?.[0] ?? entry.pages?.find?.(() => true);
      if (!page) return;
      let content = page.text?.content ?? "";
      // Remove a previously-injected connections block, if any.
      content = content.replace(/<div class="es-connections"[\s\S]*?<\/div>\s*$/i, "").trimEnd();
      const block = this._renderConnectionsBlock(list);
      if (block) content = `${content}\n${block}`;
      await page.update({ "text.content": content });
    } catch (e) {
      console.warn(LOG_PREFIX, "connections block refresh failed:", e?.message || e);
    }
  },

  async _processFacts(job) {
    const items = job.facts.map(f => `<li>${escapeHtml(f)}</li>`).join("");
    const stamp = new Date().toLocaleString();
    const block = `<p class="es-journal-stamp"><em>${escapeHtml(stamp)}</em></p><ul>${items}</ul>`;
    await this._appendRolling("worldFact", block, job.facts.join(" · "), job.sourceVow);
    // World Facts are silent by design — no toast.
  },

  async _processThread(job) {
    const parts = [];
    if (job.mysteries?.length) {
      parts.push(`<p><strong>🧵 Mysteries</strong></p><ul>${job.mysteries.map(m => `<li>${escapeHtml(m)}</li>`).join("")}</ul>`);
    }
    if (job.decisions?.length) {
      parts.push(`<p><strong>⚖️ Decisions</strong></p><ul>${job.decisions.map(d => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`);
    }
    if (job.worldState && Object.keys(job.worldState).length) {
      const rows = Object.entries(job.worldState)
        .map(([k, v]) => `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(String(v))}</li>`).join("");
      parts.push(`<p><strong>🌍 World State</strong></p><ul>${rows}</ul>`);
    }
    if (!parts.length) return;
    const stamp = new Date().toLocaleString();
    const block = `<p class="es-journal-stamp"><em>${escapeHtml(stamp)}</em></p>${parts.join("")}`;
    const ctx = [
      ...(job.mysteries || []),
      ...(job.decisions || []),
      ...Object.entries(job.worldState || {}).map(([k, v]) => `${k}: ${v}`)
    ].join(" · ");
    await this._appendRolling("storyThread", block, ctx, job.sourceVow);
    // Story Threads are silent by design — no toast.
  },

  /* ---------------- rolling-journal helper ---------------- */

  /**
   * Append an HTML block to the single rolling journal for a silent type
   * (World Facts / Story Threads), creating it on first use.
   */
  async _appendRolling(typeKey, html, contextLine, sourceVow) {
    const spec = this.TYPES[typeKey];
    if (!spec) return null;
    const folder = await this.getOrCreateFolder(typeKey);
    let entry = this._findRolling(typeKey, spec.journalName);

    if (!entry) {
      entry = await JournalEntry.create({
        name: spec.journalName,
        folder: folder?.id ?? null,
        ownership: this._ownership(),
        pages: [{
          name: spec.journalName,
          type: "text",
          text: { content: `<h2>${spec.emoji} ${escapeHtml(spec.journalName)}</h2>${html}`, format: 1 }
        }],
        flags: {
          [MODULE_ID]: {
            type: typeKey,
            createdBy: "ai",
            lastUpdated: Date.now(),
            relatedEntities: [],
            sourceVow: sourceVow ?? null,
            aiContext: contextLine || ""
          }
        }
      });
      // Embed the freshly-created rolling journal (v0.5.0).
      RagBridge.indexEntry(entry);
      return entry;
    }

    const page = entry.pages?.contents?.[0] ?? entry.pages?.find?.(() => true);
    if (page) {
      const prev = page.text?.content ?? "";
      await page.update({ "text.content": `${prev}\n${html}` });
    }
    const existingCtx = entry.getFlag?.(MODULE_ID, "aiContext") || "";
    await entry.update({
      flags: {
        [MODULE_ID]: {
          type: typeKey,
          createdBy: "ai",
          lastUpdated: Date.now(),
          sourceVow: sourceVow ?? entry.getFlag?.(MODULE_ID, "sourceVow") ?? null,
          aiContext: `${existingCtx}\n${contextLine || ""}`.trim().slice(0, 6000)
        }
      }
    });
    // Re-embed the appended rolling journal (v0.5.0).
    RagBridge.indexEntry(entry);
    return entry;
  },

  /* ---------------- entry rendering ---------------- */

  /**
   * Render the full HTML body for a new templated entry (v0.8.0). Driven by
   * the type's `fields` template: the `description` field becomes the lead
   * paragraph; every other populated field becomes a labelled row. Unknown /
   * empty fields are skipped, so legacy and partial entities render fine.
   */
  _renderEntityHtml(type, e) {
    const spec = this.TYPES[type];
    const fields = spec?.fields ?? [{ key: "description", label: "Description", area: true }];
    const desc = e.description ? `<p class="es-entity-desc">${escapeHtml(e.description)}</p>` : "";
    const rows = [];
    for (const f of fields) {
      if (f.key === "description") continue; // rendered above
      const v = e[f.key];
      if (v == null || String(v).trim() === "") continue;
      rows.push([f.label, v]);
    }
    const list = rows.length
      ? `<ul class="es-entity-fields">${rows.map(([k, v]) => `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(String(v))}</li>`).join("")}</ul>`
      : "";
    return `<h2>${spec?.emoji ?? ""} ${escapeHtml(e.name)}</h2>${desc}${list}` +
           `<p class="es-journal-foot"><em>Recorded by The Eternal Skald.</em></p>`;
  },

  _renderEntityUpdateHtml(e) {
    const stamp = new Date().toLocaleString();
    const desc = e.description ? `<p>${escapeHtml(e.description)}</p>` : "";
    const extras = [];
    // Iterate every templated field key so new fields (rank/harm/goals/
    // region/resources) are picked up on updates too.
    for (const k of this._allFieldKeys()) {
      if (k === "description") continue;
      if (e[k] != null && String(e[k]).trim() !== "") {
        extras.push(`<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(String(e[k]))}</li>`);
      }
    }
    const list = extras.length ? `<ul>${extras.join("")}</ul>` : "";
    return `<p class="es-journal-stamp"><em>Update — ${escapeHtml(stamp)}</em></p>${desc}${list}`;
  },

  _entityContext(e) {
    const bits = [e.name, ...this._allFieldKeys().map(k => e[k])]
      .filter(Boolean).join(" | ");
    return bits.slice(0, 2000);
  },

  /* ---------------- folder management ---------------- */

  async _getRootFolder() {
    const cacheKey = `__root__`;
    if (this._folderCache.has(cacheKey)) return this._folderCache.get(cacheKey);
    let root = game.folders?.find(f => f.type === "JournalEntry" && f.name === this.ROOT_FOLDER && !f.folder);
    if (!root) {
      try {
        root = await Folder.create({ name: this.ROOT_FOLDER, type: "JournalEntry", color: this._folderColor });
      } catch (e) { console.warn(LOG_PREFIX, "root folder create failed", e); root = null; }
    }
    this._folderCache.set(cacheKey, root);
    return root;
  },

  /** Get or create the typed sub-folder under the root, on first use. */
  async getOrCreateFolder(typeKey) {
    const spec = this.TYPES[typeKey];
    if (!spec) return null;
    if (this._folderCache.has(typeKey)) return this._folderCache.get(typeKey);

    const root = await this._getRootFolder();
    let folder = game.folders?.find(f =>
      f.type === "JournalEntry" && f.name === spec.folder &&
      (f.folder?.id ?? f.folder) === (root?.id ?? null)
    );
    if (!folder) {
      try {
        folder = await Folder.create({
          name: spec.folder,
          type: "JournalEntry",
          folder: root?.id ?? null,
          color: this._folderColor
        });
      } catch (e) { console.warn(LOG_PREFIX, `folder '${spec.folder}' create failed`, e); folder = root; }
    }
    this._folderCache.set(typeKey, folder);
    return folder;
  },

  /* ---------------- lookups ---------------- */

  /** All journal entries this module created, optionally filtered by type. */
  listEntries(typeFilter = null) {
    try {
      return (game.journal?.contents ?? []).filter(j => {
        const t = j.getFlag?.(MODULE_ID, "type");
        const by = j.getFlag?.(MODULE_ID, "createdBy");
        // Accept both AI-scribed and manually-templated (v0.8.0) entries.
        if (!t || (by !== "ai" && by !== "manual")) return false;
        return typeFilter ? t === typeFilter : true;
      });
    } catch (_) { return []; }
  },

  /* ---------------- fuzzy name matching (v0.8.0) ---------------- */

  /** Strip punctuation/articles and collapse whitespace for fuzzy compares. */
  _normName(s) {
    return String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\b(the|a|an|of|some)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  },

  /** Damerau-Levenshtein distance (small strings) for typo tolerance. */
  _editDistance(a, b) {
    a = String(a); b = String(b);
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) d[i][0] = i;
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[m][n];
  },

  /** Read the stored alias array off an entry (always an array). */
  _entryAliases(entry) {
    try {
      const a = entry?.getFlag?.(MODULE_ID, "aliases");
      return Array.isArray(a) ? a.filter(s => typeof s === "string" && s.trim()) : [];
    } catch (_) { return []; }
  },

  /**
   * Find an existing individual entry of a type by name. Tries, best → worst:
   * exact (case-insensitive) → stored-alias match → normalised-equal →
   * close edit-distance. This lets later mentions ("the captain", "Reeves",
   * "Capt. Reeves") resolve to the same "Captain Reeves" entry instead of
   * spawning a duplicate. Returns null when no confident match is found.
   *
   * @param {string} type   entity type ("npc"|"location"|"discovery")
   * @param {string} name   the name to resolve
   * @param {string[]} [aliases]  extra alias candidates to also match on
   */
  _findEntry(type, name, aliases = []) {
    const list = this.listEntries(type);
    if (!list.length) return null;
    const lc = String(name).toLowerCase().trim();

    // 1. Exact (case-insensitive) title match.
    let hit = list.find(j => j.name?.toLowerCase().trim() === lc);
    if (hit) return hit;

    // Candidate set of names we're trying to resolve (the name + any aliases
    // the AI supplied for this mention).
    const candidates = [lc, ...aliases.map(a => String(a).toLowerCase().trim())]
      .filter(Boolean);
    const candNorms = [...new Set(candidates.map(c => this._normName(c)).filter(Boolean))];

    // 2. Match against each entry's stored title OR its stored aliases.
    for (const j of list) {
      const names = [j.name, ...this._entryAliases(j)].filter(Boolean);
      for (const nm of names) {
        const nmLc = String(nm).toLowerCase().trim();
        if (candidates.includes(nmLc)) return j;
        const nmNorm = this._normName(nm);
        if (nmNorm && candNorms.includes(nmNorm)) return j;
      }
    }

    // 3. Fuzzy edit-distance on the normalised primary name (typo tolerance).
    const norm = this._normName(name);
    if (norm.length >= 4) {
      let best = null, bestDist = Infinity;
      for (const j of list) {
        const names = [j.name, ...this._entryAliases(j)];
        for (const nm of names) {
          const d = this._editDistance(norm, this._normName(nm));
          if (d < bestDist) { bestDist = d; best = j; }
        }
      }
      const tol = Math.min(3, Math.max(2, Math.floor(norm.length * 0.25)));
      if (best && bestDist <= tol) return best;
    }
    return null;
  },

  /** Find the single rolling journal for a silent type. */
  _findRolling(typeKey, journalName) {
    const lc = String(journalName).toLowerCase();
    return this.listEntries(typeKey).find(j => j.name?.toLowerCase() === lc) ?? null;
  },

  /* ---------------- ownership / vow ---------------- */

  _ownership() {
    const lvls = (typeof CONST !== "undefined" && CONST.DOCUMENT_OWNERSHIP_LEVELS) || {};
    if (this.permission() === "shared") {
      return { default: lvls.OBSERVER ?? 2 };
    }
    return { default: lvls.NONE ?? 0 };   // gm-only (default)
  },

  /** Best-effort id of the active character's first incomplete vow. */
  _currentVowId() {
    try {
      if (!Integration.active()) return null;
      const actor = IronswornController.getActiveCharacter?.();
      if (!actor) return null;
      const tracks = IronswornController.getProgressTracks?.(actor) ?? [];
      // Modern foundry-ironsworn stores a vow as a `progress` Item with
      // system.subtype === "vow" (older revisions used type "vow"), so match
      // either. Prefer the first still-open vow; fall back to any vow.
      const isVow = t => String(t.subtype || t.type || "").toLowerCase() === "vow";
      const vow = tracks.find(t => isVow(t) && !t.completed) ?? tracks.find(isVow);
      return vow?.id ?? null;
    } catch (_) { return null; }
  },

  /* ---------------- notifications ---------------- */

  /**
   * Minimal bottom-right toast: "📝 Added [name] to [type] journal".
   * Respects the journalNotifications setting ("none" silences everything).
   */
  _toast(name, typeKey, verb = "Added") {
    const level = this.notifyLevel();
    if (level === "none") return;
    const spec = this.TYPES[typeKey] || { label: typeKey, emoji: "📝" };
    const label = spec.label || typeKey;
    try {
      let host = document.getElementById("es-journal-toasts");
      if (!host) {
        host = document.createElement("div");
        host.id = "es-journal-toasts";
        document.body.appendChild(host);
      }
      const el = document.createElement("div");
      el.className = "es-journal-toast";
      el.innerHTML = `<span class="es-jt-icon">📝</span><span class="es-jt-text">${verb} <strong>${escapeHtml(name)}</strong> to ${escapeHtml(label)} journal</span>`;
      host.appendChild(el);
      // Trigger fade-in, then auto-remove after ~2s.
      requestAnimationFrame(() => el.classList.add("es-jt-show"));
      setTimeout(() => {
        el.classList.remove("es-jt-show");
        setTimeout(() => { try { el.remove(); } catch (_) {} }, 400);
      }, 2000);
    } catch (e) {
      // DOM not available (e.g. headless) — fall back to a quiet console note.
      console.log(LOG_PREFIX, `${verb} ${name} to ${label} journal`);
    }
  },

  /* ---------------- session chronicle ---------------- */

  /**
   * Generate a Session Chronicle from the in-memory activity log. Asks the
   * AI to weave a saga-styled recap, then writes it as a dated journal and
   * clears the log. Triggered by !end-session.
   */
  async generateSessionChronicle({ announce = true, auto = false } = {}) {
    // (v0.9.0) Whether triggered manually (!end-session) or automatically by
    // the idle timer, cancel any pending idle timer so we don't double-fire.
    try { this._clearIdleTimer(); } catch (_) {}

    if (!this.canWrite()) {
      ui.notifications?.warn(`${SKALD_NAME}: only the GM can close a session chronicle.`);
      return null;
    }
    const log = this._sessionLog.slice();
    if (!log.length) {
      await Chat.postSystem(`<em>The chronicle is bare — nothing notable was recorded this session.</em>`, { gmWhisper: true });
      return null;
    }

    // Build a compact digest for the AI from the log.
    const allFacts     = [...new Set(log.flatMap(e => e.facts))];
    const allMysteries = [...new Set(log.flatMap(e => e.mysteries))];
    const allDecisions = [...new Set(log.flatMap(e => e.decisions))];
    const allEntities  = [...new Map(log.flatMap(e => e.entities).filter(x => x?.name).map(x => [x.name, x])).values()];
    const worldState   = Object.assign({}, ...log.map(e => e.worldState || {}));

    const digest = [
      allEntities.length  ? `Notable figures & places: ${allEntities.map(e => `${e.name} (${e.type})`).join(", ")}` : "",
      allDecisions.length ? `Key decisions: ${allDecisions.join("; ")}` : "",
      allFacts.length     ? `Established facts: ${allFacts.join("; ")}` : "",
      allMysteries.length ? `Open mysteries: ${allMysteries.join("; ")}` : "",
      Object.keys(worldState).length ? `World state: ${Object.entries(worldState).map(([k, v]) => `${k}=${v}`).join(", ")}` : ""
    ].filter(Boolean).join("\n");

    const task = `Compose a SESSION CHRONICLE — a saga-styled recap of the session just ended, in your Skald voice. Use these recorded facts (do NOT invent beyond them; weave what is given):\n${digest}\n\nStructure it with short headed sections using **bold** headers: **What Happened**, **Decisions**, **Consequences**, **Unresolved Threads**. Keep it tight and evocative (4-8 short paragraphs total). Do NOT append any metadata block.`;

    let recap;
    try {
      recap = await Client.chat([
        { role: "system", content: buildSystemPrompt({ task }) },
        { role: "user", content: "Close the chronicle for this session." }
      ], { temperature: 0.8, maxTokens: 1200 });
    } catch (e) {
      console.warn(LOG_PREFIX, "session chronicle AI call failed:", e?.message || e);
      // Degrade: write a plain digest if the AI is unreachable.
      recap = `**What Happened**\n${digest || "(no details)"}`;
    }

    const folder = await this.getOrCreateFolder("session");
    // (v0.9.0) Mark auto-generated chronicles so the GM can tell them apart.
    const title = `Session Chronicle — ${new Date().toLocaleDateString()}${auto ? " (auto)" : ""}`;
    // Stored in a JournalEntry — keep plain (move links have no handler there).
    const html = `<h2>📖 ${escapeHtml(title)}</h2>${formatMarkdown(recap, { link: false })}`;
    const entry = await JournalEntry.create({
      name: title,
      folder: folder?.id ?? null,
      ownership: this._ownership(),
      pages: [{ name: title, type: "text", text: { content: html, format: 1 } }],
      flags: {
        [MODULE_ID]: {
          type: "session",
          createdBy: "ai",
          lastUpdated: Date.now(),
          relatedEntities: [],
          sourceVow: this._currentVowId(),
          aiContext: digest.slice(0, 6000),
          auto: !!auto // (v0.9.0) idle-timer-generated vs manual !end-session
        }
      }
    });

    if (entry) {
      // Embed the session chronicle into semantic memory (v0.5.0).
      RagBridge.indexEntry(entry);
      if (announce) {
        const intro = auto
          ? `<p class="es-help-aside"><em>Auto-woven after a lull. Type <code>!end-session</code> any time to close one yourself.</em></p>`
          : "";
        await Chat.postSkald(intro + formatMarkdown(recap), { variant: "lore", title });
        this._toast(title, "session");
      }
    }
    // Clear the log — a new session begins.
    this._sessionLog = [];
    return entry;
  }
};

/* ===================================================================== */
/*  §11 ENEMY COMBAT CONTROLLER                                           */
/* ===================================================================== */

export const CombatController = {

  /** Lock to prevent re-entrant turn processing. */
  _busy: false,
  _lastTurnId: null,

  /**
   * Updates from Combat changes. Fires from the 'updateCombat' hook.
   * Only the active GM runs the logic — players observe.
   */
  async onUpdateCombat(combat, changed /*, options, userId */) {
    if (!game.user.isGM) return;
    if (!Settings.get("autoControlEnemies") && !Settings.get("autoNarrateCombat")) return;
    if (!combat?.started) return;

    // Only react when turn or round changed
    if (!("turn" in changed) && !("round" in changed)) return;

    const combatant = combat.combatant;
    if (!combatant) return;

    // Idempotency guard
    const turnId = `${combat.id}:${combat.round}:${combat.turn}`;
    if (turnId === this._lastTurnId) return;
    this._lastTurnId = turnId;

    if (this._busy) return;

    // Skip player-owned combatants — they act for themselves
    if (this._isPlayerOwned(combatant)) {
      if (Settings.get("autoNarrateCombat")) {
        await this._narrateHeroTurn(combatant);
      }
      return;
    }

    // Hostile / NPC — act on their behalf if auto-control is on
    if (Settings.get("autoControlEnemies")) {
      this._busy = true;
      try { await this._runEnemyTurn(combat, combatant); }
      finally { this._busy = false; }
    } else if (Settings.get("autoNarrateCombat")) {
      await this._narrateEnemyTurn(combatant);
    }
  },

  /** Brief atmospheric narration for a player turn — no actions taken. */
  async _narrateHeroTurn(combatant) {
    const ctx = this._combatSnapshot(combatant);
    const task = `It is the Ironsworn ${escapeHtml(combatant.name)}'s turn. In 1-2 sentences, set the mood. Do not declare their action — the player decides.\n\nSnapshot:\n${ctx}`;
    try {
      const reply = await Client.chat([
        { role: "system", content: buildSystemPrompt({ task }) },
        { role: "user", content: `Narrate the moment before ${combatant.name} acts.` }
      ], { temperature: 0.8, maxTokens: 220 });
      await Chat.postSkald(formatMarkdown(reply), { variant: "combat", title: `${combatant.name}'s Turn` });
    } catch (err) {
      console.warn(LOG_PREFIX, "Hero narration failed", err);
    }
  },

  /** Atmospheric narration only — no action taken on the enemy's behalf. */
  async _narrateEnemyTurn(combatant) {
    const ctx = this._combatSnapshot(combatant);
    const task = `It is the foe "${escapeHtml(combatant.name)}"'s turn. Narrate what they DO, vividly, in 2-3 sentences. Do not roll dice — describe the intent. The GM will adjudicate.\n\nSnapshot:\n${ctx}`;
    try {
      const reply = await Client.chat([
        { role: "system", content: buildSystemPrompt({ task }) },
        { role: "user", content: `Describe ${combatant.name}'s action.` }
      ], { temperature: 0.85, maxTokens: 280 });
      await Chat.postSkald(formatMarkdown(reply), { variant: "combat", title: `${combatant.name} acts` });
    } catch (err) {
      console.warn(LOG_PREFIX, "Enemy narration failed", err);
    }
  },

  /**
   * Run a full enemy turn: ask the LLM for a tactical decision, attempt
   * the mechanical bits (movement, attack roll), narrate it, then advance
   * to the next combatant.
   */
  async _runEnemyTurn(combat, combatant) {
    const ctx = this._combatSnapshot(combatant);

    const task = `You are GMing an Ironsworn combat. It is the foe "${combatant.name}"'s turn. Decide ONE action and reply ONLY in this JSON shape (no prose outside it):
{
  "intent": "aggressive|defensive|cunning|fleeing",
  "action": "strike|clash|move|secure_advantage|use_ability|flee",
  "target_token_id": "<id of target player token or null>",
  "move_to": { "x": <int>, "y": <int> } OR null,
  "narration": "<2-3 vivid sentences in your Skald voice>",
  "harm": <integer 0-3, harm to inflict on a hit>
}
Use the battlefield snapshot to choose a sensible action. Prefer Strike on a wounded foe in reach, Clash if you cannot reach, Move/Secure an Advantage to set up next turn. Flee at very low health.

Snapshot:
${ctx}`;

    let decision = null;
    try {
      const raw = await Client.chat([
        { role: "system", content: buildSystemPrompt({ task }) },
        { role: "user", content: `Decide and narrate ${combatant.name}'s turn.` }
      ], { temperature: 0.6, maxTokens: 500 });
      decision = this._parseDecision(raw);
    } catch (err) {
      console.warn(LOG_PREFIX, "Enemy decision failed", err);
      await Chat.postSystem(`<strong>${escapeHtml(combatant.name)} hesitates:</strong> ${escapeHtml(err.message)}`, { gmWhisper: true });
    }

    if (!decision) {
      decision = this._fallbackDecision(combatant);
    }

    // 1. Narration card
    if (decision.narration) {
      await Chat.postSkald(formatMarkdown(decision.narration), {
        variant: "combat",
        alias: combatant.name,
        title: `${combatant.name} — ${this._actionLabel(decision.action)}`
      });
    }

    // 2. Mechanical execution
    try {
      await this._executeAction(combat, combatant, decision);
    } catch (err) {
      console.warn(LOG_PREFIX, "Enemy action exec failed", err);
    }

    // 3. Advance the turn (give the table a beat to read)
    setTimeout(() => {
      combat.nextTurn().catch(e => console.warn(LOG_PREFIX, "nextTurn failed", e));
    }, 1500);
  },

  /** Carry out the chosen action on the canvas. */
  async _executeAction(combat, combatant, decision) {
    const token = combatant?.token?.object ?? canvas?.tokens?.get?.(combatant?.tokenId);
    if (!token) return;

    // Movement
    if (decision.move_to && Number.isFinite(decision.move_to.x) && Number.isFinite(decision.move_to.y)) {
      // Clamp to scene bounds (skip if there's no active scene).
      const scene = canvas?.scene;
      if (scene?.dimensions) {
        const w = scene.dimensions.width  ?? Infinity;
        const h = scene.dimensions.height ?? Infinity;
        const x = Math.max(0, Math.min(decision.move_to.x, w - (token.w ?? 0)));
        const y = Math.max(0, Math.min(decision.move_to.y, h - (token.h ?? 0)));
        try {
          await token.document.update({ x, y });
        } catch (e) { console.warn(LOG_PREFIX, "Token move failed", e); }
      }
    }

    // Combat actions — use Ironsworn dice (1d6 vs 2d10)
    if (["strike", "clash"].includes(decision.action)) {
      // Resolve a quick Ironsworn-style roll: stat bonus ~ +2 default
      const stat = 2;
      const roll = new Roll(`1d6 + ${stat}`);
      const chal = new Roll("2d10");
      await roll.evaluate({ async: true });
      await chal.evaluate({ async: true });
      const c1 = chal.terms[0].results[0].result;
      const c2 = chal.terms[0].results[1].result;
      const total = roll.total;
      const beats = (total > c1 ? 1 : 0) + (total > c2 ? 1 : 0);
      const tier = beats === 2 ? "Strong Hit" : beats === 1 ? "Weak Hit" : "Miss";

      const harm = Math.max(0, Math.min(3, Math.floor(decision.harm ?? 1)));
      let resultBody = `<div class="es-combat-roll">
        <div><strong>${this._actionLabel(decision.action)}</strong> — ${combatant.name}</div>
        <div>Action: 1d6+${stat} = <strong>${total}</strong>; Challenge: ${c1}, ${c2}</div>
        <div>Outcome: <strong>${tier}</strong>${beats > 0 ? ` — inflicts ${harm} harm` : " — no harm dealt"}</div>
      </div>`;
      await Chat.postSkald(resultBody, { variant: "combat", alias: combatant.name });

      // Apply harm to the target if we have one and we hit
      if (beats > 0 && decision.target_token_id) {
        const target = canvas.tokens.get(decision.target_token_id);
        if (target?.actor) {
          await this._applyHarm(target.actor, harm);
        }
      }
    }

    if (decision.action === "flee") {
      await Chat.postSystem(`<em>${escapeHtml(combatant.name)} flees the field — remove from combat as the fiction dictates.</em>`, { gmWhisper: true });
    }
  },

  /**
   * Best-effort harm application. The Ironsworn system on Foundry uses
   * 'health' or 'harm' under different schemas; we try the most common
   * paths and fall back to a chat note.
   */
  async _applyHarm(actor, harm) {
    if (harm <= 0) return;
    // Try data.health.value (legacy) and system.health.value (v10+)
    const paths = ["system.health.value", "system.attributes.health.value", "data.health.value"];
    for (const path of paths) {
      const cur = foundry.utils.getProperty(actor, path);
      if (typeof cur === "number") {
        const next = Math.max(0, cur - harm);
        try {
          await actor.update({ [path]: next });
          return;
        } catch (e) { /* try next path */ }
      }
    }
    await Chat.postSystem(`<em>${escapeHtml(actor.name)} suffers ${harm} harm.</em>`);
  },

  /** Attempt to parse a JSON decision robustly. */
  _parseDecision(raw) {
    if (!raw) return null;
    // Strip markdown code fences if present
    const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end   = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    const json = cleaned.slice(start, end + 1);
    try {
      const parsed = JSON.parse(json);
      // Normalize
      parsed.action = String(parsed.action ?? "strike").toLowerCase();
      parsed.intent = String(parsed.intent ?? "aggressive").toLowerCase();
      parsed.harm   = Number(parsed.harm ?? 1);
      return parsed;
    } catch (e) {
      console.warn(LOG_PREFIX, "Decision JSON parse failed", e, raw);
      return null;
    }
  },

  /** Use the oracle if the LLM declines or fails. */
  _fallbackDecision(combatant) {
    const { result } = IronswornData.rollOracle(IronswornData.oracles.combatAction);
    return {
      intent: "aggressive",
      action: "strike",
      target_token_id: null,
      move_to: null,
      narration: `**${combatant.name}** — guided by fate's roll — chooses: *${result}*.`,
      harm: 1
    };
  },

  _actionLabel(a) {
    switch ((a || "").toLowerCase()) {
      case "strike": return "Strike";
      case "clash":  return "Clash";
      case "move":   return "Reposition";
      case "secure_advantage": return "Secure an Advantage";
      case "use_ability": return "Unleash an Ability";
      case "flee":   return "Withdraw";
      default:       return "Act";
    }
  },

  _isPlayerOwned(combatant) {
    const actor = combatant.actor;
    if (!actor) return false;
    if (actor.hasPlayerOwner) return true;
    // Fallback for older schemas
    const owners = actor.ownership ?? actor.data?.permission ?? {};
    return Object.entries(owners).some(([userId, perm]) => {
      if (userId === "default") return false;
      const user = game.users.get(userId);
      return user && !user.isGM && perm >= 3;
    });
  },

  /** Compact, LLM-friendly battlefield snapshot.
   *  Defensive against partial Combat state: optional chaining on every
   *  property access so that an out-of-combat invocation never throws. */
  _combatSnapshot(activeCombatant) {
    const combat = game?.combat;
    if (!combat) return "(no active combat)";

    const round       = combat.round ?? 0;
    const turn        = combat.turn  ?? 0;
    const combatants  = combat.combatants ?? new Map();
    const totalCount  = combatants.size ?? combatants.length ?? 0;

    const lines = [];
    lines.push(`Round ${round}, turn ${turn + 1}/${totalCount || "?"}.`);
    if (canvas?.scene?.name) lines.push(`Scene: ${canvas.scene.name}.`);

    // combatants may be a Collection (Map-like) — iterable in both v12 and v14.
    try {
      for (const c of combatants) {
        if (!c) continue;
        const tok = c.token?.object ?? canvas?.tokens?.get?.(c.tokenId);
        const actor = c.actor;
        const x = tok?.x ?? "?";
        const y = tok?.y ?? "?";
        const hp = foundry?.utils?.getProperty?.(actor ?? {}, "system.health.value") ??
                   foundry?.utils?.getProperty?.(actor ?? {}, "system.attributes.health.value") ??
                   "?";
        const role = this._isPlayerOwned(c) ? "HERO" : "FOE";
        const flag = c === activeCombatant ? " ←ACTIVE" : "";
        lines.push(`  [${role}] ${c.name ?? "?"} (id=${tok?.id ?? "?"}) pos=(${x},${y}) hp=${hp}${flag}`);
      }
    } catch (err) {
      // Never let combat-iteration errors propagate out of a snapshot.
      console.warn(LOG_PREFIX, "_combatSnapshot: iteration failed —", err?.message ?? err);
      lines.push("  (combatant list unavailable)");
    }

    return lines.join("\n");
  },

  /** Used by the !combat command to give the LLM context. */
  summariseCurrent() {
    const combat = game?.combat;
    if (!combat?.started) return "(no active combat)";
    return this._combatSnapshot(combat.combatant ?? null);
  }
};

/* ===================================================================== */
/*  §12 SCENE CONTEXT (for !scene)                                        */
/* ===================================================================== */

export const SceneContext = {
  summarise() {
    const scene = canvas?.scene;
    if (!scene) return "(no active scene)";
    const lines = [`Scene: ${scene.name}`];
    if (scene.background?.src) lines.push(`Background art: ${scene.background.src.split("/").pop()}`);
    const tokens = canvas.tokens?.placeables ?? [];
    if (tokens.length) {
      lines.push(`Tokens on scene:`);
      for (const t of tokens.slice(0, 12)) {
        lines.push(`  - ${t.name} at (${t.x},${t.y})`);
      }
      if (tokens.length > 12) lines.push(`  …and ${tokens.length - 12} more`);
    }
    return lines.join("\n");
  }
};

/* ===================================================================== */
/*  §12b MAP VISION / SCOUTING (v0.10.23)                                 */
/* ===================================================================== */

/**
 * The Eternal Skald can SEE the map. Given the active scene's background
 * artwork, a vision-capable (multimodal) AI model is asked to scout the
 * terrain, landmarks, paths, hazards and points of interest, and the result
 * is:
 *   • cached on the scene's flags so it is never re-analysed automatically;
 *   • posted to chat as a styled "Scouting" card;
 *   • scribed into the Living Chronicle as Location journal entries.
 *
 * Everything here is GM-only, read-only on the map itself (we only read the
 * BASE background image — never tokens, drawings or fog), and degrades
 * gracefully: missing background, a non-vision model, a tainted canvas or a
 * failed AI call all resolve to a quiet GM notice rather than an exception.
 *
 * Token efficiency: the image is downscaled to a max dimension and exported
 * as JPEG (quality 0.85) before upload, the prompt requests strict JSON, and
 * a scene is analysed at most once unless the GM forces a re-scout (!scout).
 */
export const MapVision = {
  /** Scene flag key under MODULE_ID that stores the cached analysis. */
  FLAG_KEY: "mapAnalysis",

  /**
   * (v0.10.24) The vision instruction, rewritten as a specialised fantasy-map
   * reading prompt. It explicitly directs the model to OCR text labels, spot
   * small symbols/icons, trace faint paths and roads, and catalogue every
   * settlement/structure — the things weaker prompts and models routinely
   * miss. Strict-JSON output keeps parsing reliable and bounds token cost. We
   * never ask the model to invent lore — only to report what is visibly
   * depicted (including the literal text printed on the map).
   */
  VISION_PROMPT: [
    "You are an expert fantasy cartographer scouting a tabletop RPG map image for a Game Master.",
    "Read this map with extreme care and high attention to small detail. Maps often contain:",
    "  • TEXT LABELS — place names, region names, titles, legends and captions. READ THEM LETTER BY LETTER and transcribe the exact wording. Do not skip small or stylised text.",
    "  • SMALL SYMBOLS & ICONS — towns (dots/houses), castles, towers, ruins, mountains, trees/forests, bridges, mines, caves, ports, temples. Note even tiny ones.",
    "  • PATHS & ROADS — trails, roads, rivers, borders and routes, EVEN IF FAINT, dotted or partially hidden. Describe where they run.",
    "  • STRUCTURES & SETTLEMENTS — every city, town, village, keep, fort, outpost or landmark, however small.",
    "Be thorough: prefer listing a faint or uncertain feature (with lower confidence) over omitting it.",
    "Respond with STRICT JSON only — no prose, no markdown fences — in exactly this shape:",
    "{",
    '  "summary": "<2-3 sentence overview of the terrain and atmosphere>",',
    '  "terrain": "<dominant terrain and notable natural features>",',
    '  "labels": ["<each distinct text label / name you can read, transcribed exactly>"],',
    '  "pois": [',
    '    { "name": "<the label text if readable, else a short 2-4 word name>", "type": "<landmark|path|road|hazard|structure|settlement|water|forest|mountain|ruin|natural|other>", "description": "<one concise sentence of what is depicted>", "location": "<approximate position, e.g. north-west, centre, lower edge>", "confidence": "<high|medium|low>" }',
    "  ]",
    "}",
    "List as many genuinely distinct POIs as you can find (aim for completeness, typically 5-20 on a detailed map). Transcribe label text verbatim. Describe ONLY what is visibly depicted; do not invent character names or backstory."
  ].join("\n"),

  /** True iff automatic scene analysis is enabled (defaults to ON). */
  enabled() { return Settings.get("autoAnalyzeScenes") !== false; },

  /** Only the GM may scout (it writes scene flags and journal entries). */
  _canWrite() {
    try { return !!(game?.user?.isGM); } catch (_) { return false; }
  },

  /** Resolve which model should perform vision (honouring "inherit"). */
  _visionModel() {
    const sel = Settings.get("visionModel") || "inherit";
    if (sel && sel !== "inherit") return sel;
    return Settings.get("modelName") || DEFAULT_MODEL;
  },

  /**
   * (v0.10.24) The longest-edge pixel cap for captured maps. Reads the
   * "maxMapResolution" setting; "original" → Infinity (no downscaling). Falls
   * back to 4096 when the setting is missing or invalid.
   * @returns {number}
   */
  _maxResolution() {
    try {
      const v = Settings.get("maxMapResolution");
      if (v === "original") return Infinity;
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? n : 4096;
    } catch (_) { return 4096; }
  },

  /**
   * (v0.10.24) The image MIME type to encode captures as. "auto" → PNG, which
   * keeps map text crisp (lossless) at the cost of a larger payload than JPEG.
   * @returns {{ mime: "image/png"|"image/jpeg", quality: number }}
   */
  _imageEncoding() {
    let fmt = "auto";
    try { fmt = Settings.get("imageFormat") || "auto"; } catch (_) { fmt = "auto"; }
    if (fmt === "jpeg") return { mime: "image/jpeg", quality: 0.92 };
    // "auto" and "png" both encode lossless PNG for maximum text clarity.
    return { mime: "image/png", quality: 1 };
  },

  /**
   * (v0.10.24) The configured analysis quality: "fast" | "balanced" |
   * "thorough". Defaults to "balanced".
   * @returns {"fast"|"balanced"|"thorough"}
   */
  _analysisQuality() {
    try {
      const v = String(Settings.get("mapAnalysisQuality") || "balanced").toLowerCase();
      return (v === "fast" || v === "thorough") ? v : "balanced";
    } catch (_) { return "balanced"; }
  },

  /** Resolve a scene argument to a concrete Scene (active/canvas fallback). */
  _resolveScene(scene) {
    if (scene && typeof scene === "object") return scene;
    try { return game?.scenes?.active ?? canvas?.scene ?? null; }
    catch (_) { return null; }
  },

  /**
   * The BASE background image source for a scene. Foundry v10+ stores it at
   * `scene.background.src`; very old data used `scene.img`. Tokens, tiles,
   * drawings and fog are intentionally NOT read — only the base map.
   */
  _sceneBackgroundSrc(scene) {
    try {
      const s = scene?.background?.src ?? scene?.img ?? null;
      return (typeof s === "string" && s.trim()) ? s.trim() : null;
    } catch (_) { return null; }
  },

  /** Read the cached analysis flag for a scene (or null). */
  getCached(scene) {
    try { return scene?.getFlag?.(MODULE_ID, this.FLAG_KEY) ?? null; }
    catch (_) { return null; }
  },

  /** Persist the analysis onto the scene's flags (GM-only, non-fatal). */
  async _storeAnalysis(scene, analysis) {
    try {
      if (!scene?.setFlag) return false;
      await scene.setFlag(MODULE_ID, this.FLAG_KEY, analysis);
      return true;
    } catch (e) {
      console.warn(LOG_PREFIX, "MapVision: could not store analysis flag:", e?.message || e);
      return false;
    }
  },

  /**
   * Turn a possibly-relative Foundry path (e.g. "worlds/x/maps/forest.webp")
   * into a same-origin absolute URL. Absolute http(s) and data: URLs are
   * returned unchanged. Used both for loading the image and for the
   * remote-URL pass-through fallback when canvas export is blocked by CORS.
   */
  _toAbsoluteUrl(src) {
    const s = String(src || "");
    if (!s) return "";
    if (/^(https?:|data:)/i.test(s)) return s;
    try {
      const origin = (typeof window !== "undefined" && window.location && window.location.origin)
        ? window.location.origin : "";
      if (!origin) return s;
      return `${origin}/${s.replace(/^\/+/, "")}`;
    } catch (_) { return s; }
  },

  /**
   * Load `src` into an <img>, draw it (optionally a cropped sub-region) onto an
   * offscreen <canvas> downscaled to `maxDim` (preserving aspect ratio) and
   * export as a data URL.
   *
   * (v0.10.24) Defaults raised to 4096 px and lossless PNG for crisp map text.
   * Options:
   *   • maxDim  {number}  longest-edge cap of the OUTPUT (default 4096; Infinity = no cap)
   *   • mime    {string}  "image/png" (default) or "image/jpeg"
   *   • quality {number}  encoder quality for lossy formats (default 1)
   *   • region  {object}  optional source crop {sx, sy, sw, sh} in image pixels
   *                       (used by the grid-sectioning analysis pass)
   *
   * Resolves to null (rather than rejecting) on any failure — missing DOM
   * APIs, a load error, or a CORS-tainted canvas that cannot be exported — so
   * the caller can fall back to passing a remote URL straight to the model.
   *
   * @returns {Promise<string|null>} a `data:image/…;base64,…` URL or null
   */
  _downscaleToDataUrl(src, opts = {}) {
    const maxDim = (typeof opts.maxDim === "number" && opts.maxDim > 0) ? opts.maxDim : 4096;
    const mime = opts.mime === "image/jpeg" ? "image/jpeg" : "image/png";
    const quality = typeof opts.quality === "number" ? opts.quality : 1;
    const region = (opts.region && typeof opts.region === "object") ? opts.region : null;
    return new Promise((resolve) => {
      try {
        if (typeof Image === "undefined" || typeof document === "undefined") { resolve(null); return; }
        const img = new Image();
        // crossOrigin only matters for remote http(s); data: URLs are same-origin.
        if (/^https?:/i.test(src)) img.crossOrigin = "anonymous";
        img.onload = () => {
          try {
            const fullW = img.naturalWidth || img.width;
            const fullH = img.naturalHeight || img.height;
            if (!fullW || !fullH) { resolve(null); return; }
            // Source rectangle: full image, or the requested crop region.
            let sx = 0, sy = 0, sw = fullW, sh = fullH;
            if (region) {
              sx = Math.max(0, Math.min(fullW - 1, Math.round(region.sx || 0)));
              sy = Math.max(0, Math.min(fullH - 1, Math.round(region.sy || 0)));
              sw = Math.max(1, Math.min(fullW - sx, Math.round(region.sw || fullW)));
              sh = Math.max(1, Math.min(fullH - sy, Math.round(region.sh || fullH)));
            }
            // Output size: downscale the source rect so its longest edge ≤ maxDim.
            let w = sw, h = sh;
            const longest = Math.max(w, h);
            if (Number.isFinite(maxDim) && longest > maxDim) {
              const scale = maxDim / longest;
              w = Math.max(1, Math.round(w * scale));
              h = Math.max(1, Math.round(h * scale));
            }
            const canvas = document.createElement("canvas");
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext("2d");
            if (!ctx) { resolve(null); return; }
            // High-quality resampling helps keep small labels legible.
            try { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; } catch (_) {}
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
            let url = null;
            try { url = canvas.toDataURL(mime, quality); }
            catch (taintErr) {
              console.warn(LOG_PREFIX, "MapVision: canvas tainted (CORS) — cannot export:", taintErr?.message || taintErr);
              url = null;
            }
            resolve((typeof url === "string" && url.startsWith("data:")) ? url : null);
          } catch (_) { resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = this._toAbsoluteUrl(src);
      } catch (_) { resolve(null); }
    });
  },

  /**
   * (v0.10.24) Probe the natural pixel dimensions of an image source without
   * exporting it. Used to choose the grid size for sectioned analysis.
   * Resolves to null on any failure (missing DOM, load error).
   * @returns {Promise<{width:number,height:number}|null>}
   */
  _imageDimensions(src) {
    return new Promise((resolve) => {
      try {
        if (typeof Image === "undefined") { resolve(null); return; }
        const img = new Image();
        if (/^https?:/i.test(src)) img.crossOrigin = "anonymous";
        img.onload = () => {
          const width = img.naturalWidth || img.width;
          const height = img.naturalHeight || img.height;
          resolve((width && height) ? { width, height } : null);
        };
        img.onerror = () => resolve(null);
        img.src = this._toAbsoluteUrl(src);
      } catch (_) { resolve(null); }
    });
  },

  /**
   * Capture the scene's base map as an image reference suitable for the
   * OpenAI-compatible `image_url` content part. Prefers a downscaled data URL
   * (token-efficient, CORS-safe); falls back to an absolute remote URL when
   * canvas export is unavailable. Returns null when there is no map.
   *
   * (v0.10.24) Resolution and format now follow the "Max Map Resolution" and
   * "Image Format" settings (default 4096 px / lossless PNG for crisp text).
   * An optional crop `region` ({sx,sy,sw,sh}) captures a single grid section.
   *
   * @returns {Promise<string|null>}
   */
  async _captureSceneImage(scene, opts = {}) {
    const maxDim = opts.maxDim ?? this._maxResolution();
    const enc = this._imageEncoding();
    const mime = opts.mime ?? enc.mime;
    const quality = opts.quality ?? enc.quality;
    const region = opts.region ?? null;
    try {
      const src = this._sceneBackgroundSrc(scene);
      if (!src) return null;
      const dataUrl = await this._downscaleToDataUrl(src, { maxDim, mime, quality, region });
      if (dataUrl) return dataUrl;
      // Fallback: a publicly-reachable URL can be sent to the model directly.
      // (Remote-URL fallback can only deliver the whole map, never a crop.)
      if (region) return null;
      const abs = this._toAbsoluteUrl(src);
      return /^https?:/i.test(abs) ? abs : null;
    } catch (e) {
      console.warn(LOG_PREFIX, "MapVision._captureSceneImage failed:", e?.message || e);
      return null;
    }
  },

  /**
   * (v0.10.24) Decide the grid layout for a sectioned analysis pass from the
   * map's pixel dimensions. Small maps need no sectioning; large/very large
   * maps get a 2×2 or 3×3 grid so each section is sent at higher effective
   * resolution (better small-text and icon recall).
   *
   * @param {number} width
   * @param {number} height
   * @param {"fast"|"balanced"|"thorough"} quality
   * @returns {{cols:number, rows:number}} 1×1 means "no sectioning needed"
   */
  _planGrid(width, height, quality) {
    const longest = Math.max(Number(width) || 0, Number(height) || 0);
    if (quality === "fast") return { cols: 1, rows: 1 };
    if (!longest) return { cols: 1, rows: 1 };
    if (quality === "thorough") {
      if (longest >= 4096) return { cols: 3, rows: 3 };
      if (longest >= 1600) return { cols: 2, rows: 2 };
      return { cols: 1, rows: 1 };
    }
    // "balanced": only section genuinely large maps, and never beyond 2×2.
    if (longest >= 2600) return { cols: 2, rows: 2 };
    return { cols: 1, rows: 1 };
  },

  /**
   * (v0.10.24) Compute the source-pixel crop rectangles for a cols×rows grid,
   * each padded by ~8% overlap so features straddling a seam are seen whole by
   * at least one section. Returns a flat list with a human label per cell.
   *
   * @returns {Array<{sx:number,sy:number,sw:number,sh:number,label:string,col:number,row:number}>}
   */
  _gridRegions(width, height, cols, rows) {
    const out = [];
    const w = Number(width) || 0, h = Number(height) || 0;
    if (!w || !h || cols < 1 || rows < 1) return out;
    const cellW = w / cols, cellH = h / rows;
    const padX = cellW * 0.08, padY = cellH * 0.08;
    const colNames = cols === 1 ? ["centre"] : (cols === 2 ? ["west", "east"] : ["west", "centre", "east"]);
    const rowNames = rows === 1 ? ["centre"] : (rows === 2 ? ["north", "south"] : ["north", "centre", "south"]);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const sx = Math.max(0, Math.round(c * cellW - padX));
        const sy = Math.max(0, Math.round(r * cellH - padY));
        const ex = Math.min(w, Math.round((c + 1) * cellW + padX));
        const ey = Math.min(h, Math.round((r + 1) * cellH + padY));
        const rowLabel = rowNames[r] || `row ${r + 1}`;
        const colLabel = colNames[c] || `col ${c + 1}`;
        const label = (rowLabel === "centre" && colLabel === "centre")
          ? "centre"
          : `${rowLabel}${rowLabel && colLabel ? "-" : ""}${colLabel}`.replace(/^centre-|-centre$/g, "");
        out.push({ sx, sy, sw: ex - sx, sh: ey - sy, label, col: c, row: r });
      }
    }
    return out;
  },

  /** Build the multimodal (text + image) message array for the vision call. */
  _buildVisionMessages(imageUrl, sceneName, sectionLabel) {
    const intro = sceneName ? `\n\nThis map is for the scene titled "${sceneName}".` : "";
    // (v0.10.24) When analysing one section of a larger map, tell the model
    // exactly which region of the whole map this crop represents so its
    // location fields stay meaningful after the sections are recombined.
    const section = sectionLabel
      ? `\n\nIMPORTANT: This image is only the ${sectionLabel} SECTION of a larger map, shown zoomed-in for detail. Report every feature, label and path visible in THIS section. Use "${sectionLabel}" as the location context for what you find.`
      : "";
    return [
      { role: "system", content: "You are a precise visual cartographer with excellent eyesight for small text and faint detail. When asked for JSON you output only valid JSON." },
      {
        role: "user",
        content: [
          { type: "text", text: `${this.VISION_PROMPT}${intro}${section}` },
          { type: "image_url", image_url: { url: imageUrl } }
        ]
      }
    ];
  },

  /**
   * Parse the model's reply into `{ summary, terrain, labels[], pois[] }`.
   * Tolerant of markdown code fences and surrounding prose; never throws.
   * Falls back to stashing the raw text as the summary if no JSON can be
   * recovered.
   *
   * (v0.10.24) Also captures the transcribed `labels` array and a per-POI
   * `confidence` level, and accepts options:
   *   • sectionLabel {string} default location when the model omits one (grid)
   *   • cap          {number} max POIs to keep (default 12; grid passes raise it)
   */
  _parseAnalysis(text, opts = {}) {
    const cap = (typeof opts.cap === "number" && opts.cap > 0) ? opts.cap : 12;
    const sectionLabel = typeof opts.sectionLabel === "string" ? opts.sectionLabel : "";
    const out = { summary: "", terrain: "", labels: [], pois: [] };
    if (typeof text !== "string" || !text.trim()) return out;
    let raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    let obj = null;
    try { obj = JSON.parse(raw); }
    catch (_) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) { try { obj = JSON.parse(m[0]); } catch (_) { obj = null; } }
    }
    if (!obj || typeof obj !== "object") {
      out.summary = raw.slice(0, 600);
      return out;
    }
    out.summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
    out.terrain = typeof obj.terrain === "string" ? obj.terrain.trim() : "";
    // Transcribed text labels (deduped, trimmed, bounded).
    const rawLabels = Array.isArray(obj.labels) ? obj.labels : [];
    const seenLabels = new Set();
    for (const l of rawLabels) {
      const s = String(l ?? "").trim();
      if (!s) continue;
      const k = s.toLowerCase();
      if (seenLabels.has(k)) continue;
      seenLabels.add(k);
      out.labels.push(s.slice(0, 80));
      if (out.labels.length >= 40) break;
    }
    const rawPois = Array.isArray(obj.pois) ? obj.pois
                  : (Array.isArray(obj.POIs) ? obj.POIs
                  : (Array.isArray(obj.points_of_interest) ? obj.points_of_interest : []));
    const seen = new Set();
    const normConf = (c) => {
      const v = String(c ?? "").trim().toLowerCase();
      return (v === "high" || v === "medium" || v === "low") ? v : "";
    };
    for (const p of rawPois) {
      if (!p || typeof p !== "object") continue;
      const name = String(p.name ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.pois.push({
        name: name.slice(0, 80),
        type: (String(p.type ?? "other").trim().toLowerCase().slice(0, 30)) || "other",
        description: String(p.description ?? "").trim().slice(0, 400),
        location: (String(p.location ?? "").trim() || sectionLabel).slice(0, 80),
        confidence: normConf(p.confidence)
      });
      if (out.pois.length >= cap) break;
    }
    return out;
  },

  /**
   * (v0.10.24) Merge several per-section analyses into one combined result,
   * de-duplicating POIs and labels by case-insensitive name. When the same POI
   * appears in more than one section we keep the richer record (longest
   * description, highest confidence). Section findings supplement the overview
   * pass rather than replacing it.
   *
   * @param {object} overview  - the full-map overview analysis (may be empty)
   * @param {object[]} sections - per-section parsed analyses
   * @returns {{summary:string, terrain:string, labels:string[], pois:object[]}}
   */
  _mergeAnalyses(overview, sections) {
    const base = overview && typeof overview === "object" ? overview : {};
    const out = {
      summary: typeof base.summary === "string" ? base.summary : "",
      terrain: typeof base.terrain === "string" ? base.terrain : "",
      labels: Array.isArray(base.labels) ? base.labels.slice() : [],
      pois: []
    };
    const confRank = { high: 3, medium: 2, low: 1, "": 0 };
    const poiByKey = new Map();
    const labelSet = new Set(out.labels.map(l => l.toLowerCase()));
    const addPoi = (p) => {
      if (!p || typeof p !== "object") return;
      const name = String(p.name ?? "").trim();
      if (!name) return;
      const key = name.toLowerCase();
      const existing = poiByKey.get(key);
      if (!existing) { poiByKey.set(key, { ...p, name: name.slice(0, 80) }); return; }
      // Merge: keep the longer description and the higher confidence.
      if ((p.description || "").length > (existing.description || "").length) existing.description = p.description;
      if ((confRank[p.confidence] || 0) > (confRank[existing.confidence] || 0)) existing.confidence = p.confidence;
      if (!existing.location && p.location) existing.location = p.location;
    };
    const addLabels = (labels) => {
      if (!Array.isArray(labels)) return;
      for (const l of labels) {
        const s = String(l ?? "").trim();
        if (!s) continue;
        const k = s.toLowerCase();
        if (labelSet.has(k)) continue;
        labelSet.add(k);
        out.labels.push(s.slice(0, 80));
      }
    };
    for (const p of (Array.isArray(base.pois) ? base.pois : [])) addPoi(p);
    for (const sec of (Array.isArray(sections) ? sections : [])) {
      if (!sec || typeof sec !== "object") continue;
      addLabels(sec.labels);
      for (const p of (Array.isArray(sec.pois) ? sec.pois : [])) addPoi(p);
      // If the overview produced no prose, borrow the first section's.
      if (!out.summary && sec.summary) out.summary = sec.summary;
      if (!out.terrain && sec.terrain) out.terrain = sec.terrain;
    }
    out.pois = Array.from(poiByKey.values()).slice(0, 30);
    out.labels = out.labels.slice(0, 60);
    return out;
  },

  /**
   * Scribe discovered POIs into the Living Chronicle as Location entries,
   * reusing the existing journaling pipeline (dedupe, toasts, RAG indexing).
   * Fully guarded by the journal system's own enabled/permission checks.
   */
  _journalPois(pois, scene) {
    try {
      if (!Array.isArray(pois) || !pois.length) return 0;
      if (!JournalSystem.enabled?.() || !JournalSystem.canWrite?.()) return 0;
      const sceneName = String(scene?.navName || scene?.name || "").trim();
      const entities = pois.map(p => {
        const ent = {
          type: "location",
          name: p.name,
          description: p.description || `A ${p.type || "point of interest"} observed on the map.`
        };
        if (sceneName) ent.region = sceneName;
        const feats = [];
        if (p.type) feats.push(`Type: ${p.type}.`);
        if (p.location) feats.push(`Located at the ${p.location} of the map.`);
        if (p.confidence === "low") feats.push("Observed with low confidence.");
        if (feats.length) ent.features = feats.join(" ");
        return ent;
      });
      JournalSystem.ingestMetadata({ entities }, { channel: "map-scout" });
      return entities.length;
    } catch (e) {
      console.warn(LOG_PREFIX, "MapVision._journalPois failed:", e?.message || e);
      return 0;
    }
  },

  /** Post the public "Scouting" card and a GM-only chronicle footnote. */
  async _postScoutCard(analysis, journaledCount = 0) {
    try {
      const pois = Array.isArray(analysis.pois) ? analysis.pois : [];
      const parts = [];
      if (analysis.summary) parts.push(`<p>${escapeHtml(analysis.summary)}</p>`);
      if (analysis.terrain) parts.push(`<p><strong>Terrain:</strong> ${escapeHtml(analysis.terrain)}</p>`);
      if (pois.length) {
        const items = pois.map(p => {
          const loc = p.location ? ` <span class="es-poi-loc">(${escapeHtml(p.location)})</span>` : "";
          const typ = p.type ? `<em>${escapeHtml(p.type)}</em> — ` : "";
          // (v0.10.24) Flag low-confidence sightings so the GM can verify them.
          const conf = p.confidence === "low" ? ` <span class="es-poi-conf">[uncertain]</span>` : "";
          return `<li><strong>${escapeHtml(p.name)}</strong>${loc}${conf}<br/>${typ}${escapeHtml(p.description || "")}</li>`;
        }).join("");
        parts.push(`<p><strong>Points of Interest:</strong></p><ul class="es-poi-list">${items}</ul>`);
      }
      // (v0.10.24) Surface any transcribed map text labels the model read.
      const labels = Array.isArray(analysis.labels) ? analysis.labels : [];
      if (labels.length) {
        const tags = labels.slice(0, 24).map(l => `<span class="es-map-label">${escapeHtml(l)}</span>`).join(" ");
        parts.push(`<p><strong>Map labels read:</strong> ${tags}</p>`);
      }
      if (!parts.length) parts.push(`<p><em>The map yields no clear landmarks to my eye.</em></p>`);
      const title = analysis.scene ? `Scouting: ${analysis.scene}` : "Scouting the Map";
      await Chat.postSkald(parts.join(""), { variant: "scene", title });
      if (journaledCount > 0) {
        const sectionNote = (analysis.sections && analysis.sections > 1)
          ? ` (read across ${analysis.sections} map sections)` : "";
        await Chat.postSystem(
          `<em>${journaledCount} location${journaledCount === 1 ? "" : "s"} scribed to the chronicle from the map` +
          `${analysis.scene ? ` of <strong>${escapeHtml(analysis.scene)}</strong>` : ""}${sectionNote}. ` +
          `Scouted with <code>${escapeHtml(analysis.model)}</code>.</em>`,
          { gmWhisper: true }
        );
      }
    } catch (e) {
      console.warn(LOG_PREFIX, "MapVision._postScoutCard failed:", e?.message || e);
    }
  },

  /**
   * (v0.10.24) Run a single vision pass on a captured image and return the
   * parsed analysis (or null on capture/call failure). A `region` crops the
   * source map to one grid section; `sectionLabel` is woven into the prompt and
   * used as the default POI location.
   *
   * @returns {Promise<object|null>}
   */
  async _runVisionPass(scene, sceneName, model, { region = null, sectionLabel = "", cap = 12 } = {}) {
    const imageUrl = await this._captureSceneImage(scene, region ? { region } : {});
    if (!imageUrl) return null;
    const messages = this._buildVisionMessages(imageUrl, sceneName, sectionLabel);
    let reply = "";
    try {
      reply = await Client.chat(messages, { model, temperature: 0.3, maxTokens: 1100 });
    } catch (e) {
      console.warn(LOG_PREFIX, "MapVision: vision pass failed:", e?.message || e);
      throw e;
    }
    return this._parseAnalysis(reply, { sectionLabel, cap });
  },

  /**
   * (v0.10.24) Grid-sectioned analysis. Probes the map's dimensions, plans a
   * grid (1×1 / 2×2 / 3×3) from resolution and the quality setting, then:
   *   1. runs a full-map overview pass (cheap context + catches global features)
   *   2. runs one detailed pass per section, cropped and zoomed for small text
   *   3. merges everything into a single de-duplicated analysis.
   *
   * Returns `{ analysis, sectionCount }`. Falls back to a single full-map pass
   * when sectioning isn't warranted or dimensions can't be probed.
   *
   * @returns {Promise<{analysis:object, sectionCount:number}|null>}
   */
  async _analyzeMapInSections(scene, sceneName, model, quality) {
    const src = this._sceneBackgroundSrc(scene);
    if (!src) return null;

    // 1) Always run a full-map overview pass first.
    let overview = null;
    try { overview = await this._runVisionPass(scene, sceneName, model, { cap: 16 }); }
    catch (e) { throw e; }
    if (!overview) return null;

    // Decide whether to section, based on real pixel dimensions.
    const dims = await this._imageDimensions(src);
    const grid = dims ? this._planGrid(dims.width, dims.height, quality) : { cols: 1, rows: 1 };
    const cells = (grid.cols > 1 || grid.rows > 1)
      ? this._gridRegions(dims.width, dims.height, grid.cols, grid.rows)
      : [];

    if (!cells.length) {
      return { analysis: this._mergeAnalyses(overview, []), sectionCount: 1 };
    }

    // 2) Detailed per-section passes. A failed section is skipped, not fatal.
    const sectionResults = [];
    for (const cell of cells) {
      try {
        const res = await this._runVisionPass(scene, sceneName, model, {
          region: { sx: cell.sx, sy: cell.sy, sw: cell.sw, sh: cell.sh },
          sectionLabel: cell.label,
          cap: 12
        });
        if (res) sectionResults.push(res);
      } catch (e) {
        console.warn(LOG_PREFIX, `MapVision: section "${cell.label}" failed:`, e?.message || e);
      }
    }

    // 3) Combine overview + sections.
    const merged = this._mergeAnalyses(overview, sectionResults);
    return { analysis: merged, sectionCount: 1 + sectionResults.length };
  },

  /**
   * Scout a scene's map: capture → vision call(s) → parse → cache → journal →
   * post. Returns the stored analysis object, or null on any graceful exit.
   *
   * (v0.10.24) Honours the "Map Analysis Quality" setting: "fast" runs a single
   * full-map pass, while "balanced"/"thorough" add grid-sectioned detail passes
   * for far better small-text and POI recall. Warns the GM when the chosen
   * vision model is a lightweight ("mini"/"lite") tier that tends to miss
   * fine map detail.
   *
   * @param {Scene} [scene] - target scene (defaults to active/canvas scene)
   * @param {object} [opts]
   * @param {boolean} [opts.force]  - re-analyse even if a cached result exists
   * @param {boolean} [opts.silent] - suppress the "surveys…" start notice (auto mode)
   */
  async analyzeScene(scene, opts = {}) {
    const force = !!opts.force;
    try {
      const sc = this._resolveScene(scene);
      if (!sc) {
        if (force) await Chat.postSystem(`<em>${SKALD_NAME} finds no active scene to scout.</em>`, { gmWhisper: true });
        return null;
      }
      if (!this._canWrite()) return null;

      // Skip already-scouted scenes unless explicitly forced.
      const cached = this.getCached(sc);
      if (cached && !force) {
        console.log(LOG_PREFIX, "MapVision: scene already scouted — skipping (use !scout to force).");
        return cached;
      }

      const src = this._sceneBackgroundSrc(sc);
      if (!src) {
        if (force) await Chat.postSystem(`<em>${SKALD_NAME} peers about, but this scene has no map to scout.</em>`, { gmWhisper: true });
        return null;
      }

      const model = this._visionModel();
      if (!Client._modelSupportsVision(model)) {
        await Chat.postSystem(
          `<em>${SKALD_NAME} cannot scout the map: <code>${escapeHtml(model)}</code> has no eyes for images. ` +
          `Choose a vision-capable model under <em>Settings → Vision Model</em>.</em>`,
          { gmWhisper: true }
        );
        return null;
      }

      // (v0.10.24) Advise — but never block — when the model is a weak tier.
      if (force && Client._visionModelTier?.(model) === "weak") {
        await Chat.postSystem(
          `<em>Heed this, GM: <code>${escapeHtml(model)}</code> is a lightweight vision model and often misses small ` +
          `labels and faint paths on detailed maps. For sharper scouting choose a flagship model such as ` +
          `<code>gpt-4o</code>, <code>claude-3-5-sonnet</code> or <code>gemini-2.0-flash</code> under ` +
          `<em>Settings → Vision Model</em>.</em>`,
          { gmWhisper: true }
        );
      }

      const quality = this._analysisQuality();
      const sceneName = String(sc.navName || sc.name || "").trim();
      if (!opts.silent) {
        await Chat.postSystem(
          `<em>${SKALD_NAME} surveys ${sceneName ? `<strong>${escapeHtml(sceneName)}</strong>` : "the map"}…</em>`,
          { gmWhisper: true }
        );
      }

      // Run the analysis. "fast" → one full-map pass; otherwise grid sectioning.
      let parsed = null;
      let sectionCount = 1;
      try {
        if (quality === "fast") {
          parsed = await this._runVisionPass(sc, sceneName, model, { cap: 16 });
        } else {
          const result = await this._analyzeMapInSections(sc, sceneName, model, quality);
          if (result) { parsed = result.analysis; sectionCount = result.sectionCount; }
        }
      } catch (e) {
        await Chat.postSystem(`<em>${SKALD_NAME}'s scrying of the map failed: ${escapeHtml(e?.message || String(e))}</em>`, { gmWhisper: true });
        return null;
      }

      if (!parsed) {
        await Chat.postSystem(`<em>${SKALD_NAME} could not capture the map image to scout it.</em>`, { gmWhisper: true });
        return null;
      }

      const analysis = {
        timestamp: Date.now(),
        model,
        scene: sceneName,
        quality,
        sections: sectionCount,
        summary: parsed.summary,
        terrain: parsed.terrain,
        labels: Array.isArray(parsed.labels) ? parsed.labels : [],
        pois: parsed.pois
      };

      await this._storeAnalysis(sc, analysis);
      const journaled = this._journalPois(parsed.pois, sc);
      await this._postScoutCard(analysis, journaled);
      return analysis;
    } catch (e) {
      console.error(LOG_PREFIX, "MapVision.analyzeScene failed:", e);
      return null;
    }
  }
};

/* ===================================================================== */
/*  §13 HOOK REGISTRATIONS                                                */
/* ===================================================================== */

/* =====================================================================
 * COMMAND-INTERCEPTION STRATEGY (HTML-aware)
 * ---------------------------------------------------------------------
 * Foundry VTT v14 changed how chat input is processed. The pre-v14
 * `chatMessage` hook signature was `(chatLog, messageText, chatData)`
 * and could be cancelled with `return false`. In v14, depending on the
 * Foundry build, this hook may:
 *   - Receive an object instead of a string for `messageText`.
 *   - Not fire at all for messages that don't begin with `/`.
 *   - Fire but ignore the return value.
 *
 * Strategy: register THREE hooks and log everything from each one so we
 * can see in DevTools which fires for `!skald-help`:
 *
 *   1.  `chatMessage`           — the classic pre-v14 entry point
 *   2.  `preCreateChatMessage`  — fires when the ChatMessage document
 *                                 is about to be persisted; we can
 *                                 cancel by returning false here.
 *   3.  `createChatMessage`     — final fallback; the message has been
 *                                 created so we can't suppress it, but
 *                                 we can still execute the command and
 *                                 then delete the user's command line.
 *
 * `tryCommandFromText()` is shared by all three so the logic stays in
 * one place. Each hook logs its arguments verbosely so we can diagnose.
 * =================================================================== */




// --- init: register settings AND chat-command hooks -------------------
console.log("The Eternal Skald | Registering Hooks.once('init') …");
Hooks.once("init", () => {
  console.log(LOG_PREFIX, "init hook fired — initialising module …");
  try {
    Settings.register();
    console.log(LOG_PREFIX, "Settings registered.");
  } catch (err) {
    console.error(LOG_PREFIX, "Settings.register() failed:", err);
  }

  /* === Keybinding: toggle AI Mode (v0.3.2) =============================
   * Lets the GM flip the AI Mode master toggle on/off with a keyboard
   * shortcut. No default key is bound — the user assigns one under
   * Configure Controls → The Eternal Skald. AI Mode is world-scoped, so
   * the binding is restricted to GMs (only they can write world settings).
   * =================================================================== */
  try {
    game.keybindings.register(MODULE_ID, "toggleAiMode", {
      name: game.i18n.localize("ETERNAL_SKALD.keybindings.toggleAiMode.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.keybindings.toggleAiMode.hint"),
      // Default chord: Alt+Shift+A (unlikely to clash). Users can rebind
      // or clear it under Configure Controls → The Eternal Skald.
      editable: [{ key: "KeyA", modifiers: ["Alt", "Shift"] }],
      restricted: true,             // GM only (world-scoped setting)
      precedence: CONST.KEYBINDING_PRECEDENCE?.NORMAL ?? 0,
      onDown: () => {
        try {
          const current = Settings.get("aiMode") !== false;
          // Setting onChange handles the user-facing notification.
          game.settings.set(MODULE_ID, "aiMode", !current);
        } catch (e) {
          console.error(LOG_PREFIX, "toggleAiMode keybinding failed:", e);
        }
        return true;   // consume the event
      }
    });
    console.log(LOG_PREFIX, "Keybinding 'toggleAiMode' registered.");
  } catch (err) {
    console.error(LOG_PREFIX, "Keybinding registration failed:", err);
  }

  /* === HOOK #1: chatMessage ============================================
   * The pre-v14 entry point. Fires BEFORE Foundry creates the
   * ChatMessage document, with the raw text. Cancel with `return false`.
   * =================================================================== */
  Hooks.on("chatMessage", (chatLog, message, chatData) => {
    console.log(`${LOG_PREFIX} [chatMessage] HOOK FIRED`);
    console.log(`${LOG_PREFIX} [chatMessage] message (type=${typeof message}):`, message);
    try { console.log(`${LOG_PREFIX} [chatMessage] message JSON:`, JSON.stringify(message)); } catch (_) {}
    try { console.log(`${LOG_PREFIX} [chatMessage] chatData JSON:`, JSON.stringify(chatData)); } catch (_) {}
    try {
      const text = extractMessageText(message);
      const consumed = tryCommandFromText(text, "chatMessage");
      if (consumed) {
        console.log(`${LOG_PREFIX} [chatMessage] returning false to suppress default chat publication`);
        return false;
      }
      console.log(`${LOG_PREFIX} [chatMessage] not our command — letting Foundry handle it`);
      return undefined;
    } catch (err) {
      console.error(`${LOG_PREFIX} [chatMessage] handler crashed:`, err);
      return undefined;
    }
  });

  /* === HOOK #2: preCreateChatMessage ===================================
   * Fires when a ChatMessage document is about to be persisted. The
   * raw text lives in `document.content` (or `data.content` for legacy).
   * Cancel persistence with `return false`.
   * =================================================================== */
  Hooks.on("preCreateChatMessage", (document, data, options, userId) => {
    console.log(`${LOG_PREFIX} [preCreateChatMessage] HOOK FIRED`);
    try { console.log(`${LOG_PREFIX} [preCreateChatMessage] document.content:`, document?.content); } catch (_) {}
    try { console.log(`${LOG_PREFIX} [preCreateChatMessage] data:`, JSON.stringify(data)); } catch (_) {}
    try {
      // Don't intercept our own messages (they have our flags)
      const flags = document?.flags ?? data?.flags ?? {};
      if (flags[MODULE_ID]) {
        console.log(`${LOG_PREFIX} [preCreateChatMessage] message is ours — passing through`);
        return undefined;
      }
      const text = document?.content ?? data?.content ?? "";
      const consumed = tryCommandFromText(text, "preCreateChatMessage");
      if (consumed) {
        console.log(`${LOG_PREFIX} [preCreateChatMessage] returning false to prevent document creation`);
        return false;
      }
      return undefined;
    } catch (err) {
      console.error(`${LOG_PREFIX} [preCreateChatMessage] handler crashed:`, err);
      return undefined;
    }
  });

  console.log(`${LOG_PREFIX} Chat-command hooks (chatMessage + preCreateChatMessage) registered for: ${Object.values(COMMANDS).join(", ")}`);
});

/* === HOOK: renderSettingsConfig (v0.10.31) ============================
 * Foundry computes a setting's `choices` ONCE at registration, so the AI
 * Model / Vision Model dropdowns are re-populated here every time the
 * Settings Config window opens, filtered to the AI Provider currently
 * chosen *in that form*, and re-filtered live whenever the provider
 * <select> changes (see refreshModelDropdowns). Fully defensive — any
 * failure leaves the statically-registered choices intact.
 * ==================================================================== */
Hooks.on("renderSettingsConfig", (app, html) => {
  try { refreshModelDropdowns(html); }
  catch (e) { console.warn(LOG_PREFIX, "renderSettingsConfig dropdown refresh failed:", e?.message || e); }
});

// --- ready: welcome banner & global API ------------------------------
console.log("The Eternal Skald | Registering Hooks.once('ready') …");
Hooks.once("ready", async () => {
  console.log(LOG_PREFIX, "ready hook fired — module fully loaded.");

  // Sync debug logging flag into the Ironsworn controller.
  try { IronswornController.setDebug(Settings.get("debugLogging")); } catch (_) {}

  // Expose a small public API for macros and other modules.
  game.modules.get(MODULE_ID).api = {
    chat: Client.chat.bind(Client),
    rollOracle: IronswornData.rollOracle,
    commands: Commands,
    npc: NpcDialogue,
    combat: CombatController,
    lore: LoreGenerator,
    // --- Auto-journaling chronicle (v0.4.0) ---
    journal: JournalSystem,
    // --- Map vision / scouting (v0.10.23) ---
    mapVision: MapVision,
    scout: (scene) => MapVision.analyzeScene(scene, { force: true }),
    // --- Browser-based RAG / semantic memory (v0.5.0) ---
    rag: BrowserRAG,
    resetMemory: (ch) => Memory.reset(ch),
    // --- AI Mode controls (v0.3.2) ---
    isAiMode: () => Settings.get("aiMode") !== false,
    setAiMode: (on) => game.settings.set(MODULE_ID, "aiMode", !!on),
    toggleAiMode: () => game.settings.set(MODULE_ID, "aiMode", Settings.get("aiMode") === false),
    IronswornData,
    // --- Ironsworn rules-engine integration (v0.3.0) ---
    ironsworn: IronswornController,
    integration: Integration,
    // --- Narration entity linking (v0.5.1) ---
    entityLinker: EntityLinker,
    // --- Customisable link styles (v0.9.0) ---
    setLinkStyle: (kind, patch) => EntityLinker.setStyle(kind, patch || {}),
    resetLinkStyles: () => EntityLinker.resetStyles(),
    // --- Living Chronicle: timeline & relationships (v0.8.0) ---
    timeline: (q) => JournalSystem.getTimeline(q),
    clearTimeline: () => JournalSystem.clearTimeline(),
    relationships: (uuidOrName) => {
      // Convenience: return the relatedEntities for a given entry name/uuid,
      // or a full map of {name: rels[]} when called with no argument.
      try {
        if (uuidOrName) {
          const hit = JournalSystem._findAnyEntry?.(String(uuidOrName));
          return hit ? JournalSystem._entryRelated(hit) : [];
        }
        const out = {};
        for (const t of ["npc", "location", "discovery"]) {
          for (const j of JournalSystem.listEntries(t)) {
            const rels = JournalSystem._entryRelated(j);
            if (rels.length) out[j.name] = rels;
          }
        }
        return out;
      } catch (_) { return uuidOrName ? [] : {}; }
    }
  };

  // Log Ironsworn integration status for diagnostics.
  try {
    if (Integration.active()) {
      const caps = IronswornController.capabilities();
      console.log(LOG_PREFIX, "Ironsworn integration ACTIVE —", JSON.stringify(caps));
    } else {
      console.log(LOG_PREFIX, "Ironsworn integration inactive (system not detected or disabled).");
    }
  } catch (_) {}

  // Welcome card — once per session, GM only.
  if (game.user.isGM) {
    const apiKey = Settings.get("apiKey");
    if (!apiKey) {
      await Chat.postSystem(
        `<strong>${SKALD_NAME}</strong> awaits your key. Open <em>Module Settings → The Eternal Skald</em> and provide your Abacus AI API key, then type <code>!skald-help</code>.`,
        { gmWhisper: true }
      );
    } else {
      await Chat.postSkald(
        `<p>I have come, summoned by iron and flame. Type <code>!skald-help</code> for the runes that wake me.</p>`,
        { variant: "default", title: "The Skald Arrives" }
      );
    }
  }
});

// --- updateCombat: enemy turn automation -----------------------------
Hooks.on("updateCombat", (combat, changed, options, userId) => {
  // Run only on the active GM to avoid duplicate actions
  if (!game.user.isGM) return;
  // Some Foundry versions route updates via the originating user — guard against double-fire
  if (game.users.activeGM && game.users.activeGM.id !== game.user.id) return;
  CombatController.onUpdateCombat(combat, changed, options, userId).catch(err => {
    console.error(LOG_PREFIX, "Combat handler failed", err);
  });
});

/* === canvasReady: auto-scout newly viewed scenes (v0.10.23) ==========
 * When the GM views/activates a scene, the Skald can automatically "scout"
 * its base map artwork with a vision model — identifying terrain, landmarks
 * and points of interest, and scribing the latter to the chronicle.
 *
 * Guards (each cheap, fail-safe):
 *   • GM only             — analysis writes scene flags + journal entries.
 *   • Setting enabled     — "Auto-Analyze Scenes" (defaults ON).
 *   • AI Mode ON          — respect the master toggle, like other AI features.
 *   • Once per scene id   — an in-memory guard prevents re-firing for the same
 *                           scene on every redraw; MapVision.analyzeScene also
 *                           skips scenes that already carry a cached analysis.
 * Fire-and-forget: the scout never blocks canvas rendering and swallows all
 * errors so a vision hiccup can never break the table.
 * ==================================================================== */
const _autoScoutedScenes = new Set();
Hooks.on("canvasReady", (canvasObj) => {
  try {
    if (!game.user?.isGM) return;
    if (game.users?.activeGM && game.users.activeGM.id !== game.user.id) return;
    if (!MapVision.enabled()) return;
    if (Settings.get("aiMode") === false) return;

    const scene = canvasObj?.scene ?? canvas?.scene ?? game?.scenes?.active ?? null;
    const sceneId = scene?.id ?? null;
    if (!scene || !sceneId) return;

    // Skip if we already auto-scouted this scene this session, or it carries
    // a cached analysis already (MapVision double-checks, but this avoids the
    // async churn entirely on every redraw of the same map).
    if (_autoScoutedScenes.has(sceneId)) return;
    if (MapVision.getCached(scene)) { _autoScoutedScenes.add(sceneId); return; }
    if (!MapVision._sceneBackgroundSrc(scene)) return; // nothing to scout

    _autoScoutedScenes.add(sceneId);
    // Auto mode is quieter: suppress the "surveys…" start notice.
    Promise.resolve()
      .then(() => MapVision.analyzeScene(scene, { force: false, silent: true }))
      .catch(err => console.warn(LOG_PREFIX, "auto-scout failed:", err?.message || err));
  } catch (err) {
    console.warn(LOG_PREFIX, "canvasReady auto-scout hook failed:", err?.message || err);
  }
});

/* === HOOK #3: createChatMessage (last-resort fallback) ================
 * If chatMessage and preCreateChatMessage both fail to intercept the
 * raw `!` command, the message has already been persisted by the time
 * we see it here. We can still execute the command and (best-effort)
 * delete the original user message so it doesn't clutter chat.
 * ==================================================================== */
Hooks.on("createChatMessage", (message) => {
  console.log(`${LOG_PREFIX} [createChatMessage] HOOK FIRED`);
  try {
    const ourFlags = message?.flags?.[MODULE_ID];

    // --- Ironsworn roll detection -------------------------------------
    // Narrate rolls so the saga continues. This must run BEFORE the
    // "ignore our own posts" guard below, because our OWN manual-fallback
    // move cards (posted by IronswornController.manualMoveRoll when the
    // system's pre-roll dialog is unavailable) carry our module flag with
    // manualMove:true. Those are exactly the rolls the player triggers from
    // the inline move links woven into the narration, so they must reach
    // onIronswornRoll.
    // onIronswornRoll has its own guards (it skips our own NON-roll cards
    // like narration/suggestions, dedupes, and is GM-only), so calling it
    // unconditionally here is safe.
    try {
      Integration.onIronswornRoll(message);
    } catch (e) {
      console.warn(`${LOG_PREFIX} [createChatMessage] onIronswornRoll dispatch failed:`, e);
    }

    // Ignore our own posts for the `!command` dispatch below — they always
    // carry our module flag, and a Skald-posted card is never a command.
    if (ourFlags) {
      console.log(`${LOG_PREFIX} [createChatMessage] message is ours — skipping command dispatch`);
      return;
    }

    const rawText = message?.content ?? "";
    console.log(`${LOG_PREFIX} [createChatMessage] raw content:`, JSON.stringify(rawText));

    // Strip HTML (Foundry v14 wraps chat input in <p>...</p>) BEFORE
    // checking the prefix.
    const stripped = stripHtml(typeof rawText === "string" ? rawText : "");
    if (stripped !== (typeof rawText === "string" ? rawText.trim() : "")) {
      console.log(`${LOG_PREFIX} [createChatMessage] stripped HTML -> ${JSON.stringify(stripped)}`);
    }
    if (!stripped.startsWith("!")) return;

    // Only the speaker (or the active GM as a safety net) should run
    // the command — otherwise every connected client would dispatch.
    const author = message?.author ?? message?.user;
    const authorId = typeof author === "string" ? author : author?.id;
    if (authorId && authorId !== game.user.id) {
      console.log(`${LOG_PREFIX} [createChatMessage] not our message (author=${authorId}, me=${game.user.id}) — skipping dispatch`);
      return;
    }

    // Use the shared helper so HTML stripping + dispatch stays consistent
    // with hooks #1 and #2.
    console.log(`${LOG_PREFIX} [createChatMessage] FALLBACK dispatch for stripped text: ${JSON.stringify(stripped)}`);
    const dispatched = tryCommandFromText(rawText, "createChatMessage");

    // Best-effort: delete the user's raw "!command" line so chat isn't cluttered.
    if (dispatched) {
      try { message.delete?.(); } catch (e) { console.warn(`${LOG_PREFIX} [createChatMessage] couldn't delete original message:`, e); }
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} [createChatMessage] handler crashed:`, err);
  }
});

/* === updateChatMessage: catch rolls that resolve after creation ======
 * Ironsworn rolls can be created in an unresolved state (extra challenge
 * dice) or have their outcome changed (resolve challenge / momentum burn).
 * The system updates the existing card's content via msg.update({content}),
 * which fires updateChatMessage rather than createChatMessage. Re-run the
 * detector so those late-resolved rolls still get narrated exactly once
 * (the _processedRolls guard prevents double-narration).
 * ==================================================================== */
Hooks.on("updateChatMessage", (message, changed /*, options, userId */) => {
  try {
    if (message?.flags?.[MODULE_ID] && !message.flags[MODULE_ID].manualMove) return;
    // Only react when the rendered content actually changed.
    if (changed && !("content" in changed) && !("rolls" in changed)) return;
    Integration.onIronswornRoll(message, { viaUpdate: true });
  } catch (e) {
    console.warn(`${LOG_PREFIX} [updateChatMessage] onIronswornRoll dispatch failed:`, e);
  }
});

// --- renderChatMessage(HTML): allow CSS class hooks ------------------
Hooks.on("renderChatMessageHTML", (message, html /*, data */) => {
  if (message?.flags?.[MODULE_ID]) {
    html.classList?.add("eternal-skald-msg");
  }
  // Wire interactive move-suggestion buttons (no-op if no suggestion flag).
  try { Integration.wireSuggestionCard(message, html); } catch (_) { /* defensive */ }
});
// Legacy hook name for v12/v13 compatibility (no-op if unused).
Hooks.on("renderChatMessage", (message, html /*, data */) => {
  if (message?.flags?.[MODULE_ID]) {
    try { html.addClass("eternal-skald-msg"); } catch (_) { /* jq optional */ }
  }
  // Wire suggestion buttons on legacy Foundry (html is jQuery here).
  try {
    const el = html?.[0] ?? html;
    Integration.wireSuggestionCard(message, el);
  } catch (_) { /* defensive */ }
});

// --- deleteJournalEntry: keep semantic memory in sync (v0.5.0) -------
// When a Skald-authored journal entry is deleted, evict its vector so it
// no longer surfaces in recall. Fire-and-forget; never throws.
Hooks.on("deleteJournalEntry", (entry /*, options, userId */) => {
  try {
    if (!entry?.getFlag?.(MODULE_ID, "createdBy")) return;
    const id = entry.id || entry._id;
    if (id) BrowserRAG?.remove?.(id);
  } catch (_) { /* defensive — memory upkeep must never break deletes */ }
});

// --- Entity-linking cache upkeep (v0.5.1) ----------------------------
// The narration entity-link index is built from the chronicle's journal
// entries. Whenever an entry is created, renamed, or removed, mark the
// index stale so the next narration rebuilds it. Cheap and defensive —
// never throws.
for (const hook of ["createJournalEntry", "updateJournalEntry", "deleteJournalEntry"]) {
  Hooks.on(hook, () => {
    try {
      // (v0.9.0) The journal collection changed — advance the generation
      // counter so the memoised journal sub-index is re-scanned, and drop
      // the linker cache entirely.
      JournalSystem.bumpJournalGeneration();
      EntityLinker.invalidateJournal();
    } catch (_) { /* defensive */ }
  });
}

// --- Progress-track upkeep (v0.7.0) ----------------------------------
// Progress tracks the index links are embedded Items on the active actor.
// Whenever an actor or any of its items is created / updated / deleted,
// the set of linkable tracks (or their names) may have changed, so mark
// the index stale. Cheap and defensive — never throws.
for (const hook of [
  "createItem", "updateItem", "deleteItem",
  "updateActor", "deleteActor", "controlToken"
]) {
  Hooks.on(hook, () => { try { EntityLinker.invalidate(); } catch (_) { /* defensive */ } });
}

/* === XP / legacy diff-watcher (v0.10.25) ============================
 * OBSERVE-ONLY experience tracking. When the foundry-ironsworn system (or the
 * player) records a gain on the sheet — the classic `system.xp` counter rises,
 * or a Starforged legacy track advances — the Skald narrates the milestone.
 *
 * It NEVER writes, computes, or spends experience: it merely reacts to a
 * change the rules have already committed, comparing against an in-memory
 * baseline so only POSITIVE deltas are celebrated. The first sighting of an
 * actor seeds that baseline silently (no narration on load / first edit).
 *
 * Registered as its OWN `updateActor` listener (separate from the linker-cache
 * loop above) so each concern stays isolated and independently fail-safe.
 *
 * Guards (each cheap, fail-safe):
 *   • Active GM only   — avoids duplicate narration across connected clients.
 *   • AI Mode ON + Ironsworn integration active.
 *   • The `changed` diff actually touched xp/legacies — otherwise we ignore
 *     the update entirely (no work on unrelated sheet edits).
 * ==================================================================== */
const _esXpBaseline = new Map(); // actorId -> { xp:(number|null), legacies:(object|null) }
Hooks.on("updateActor", (actor, changed /*, options, userId */) => {
  try {
    if (!game.user?.isGM) return;
    if (game.users?.activeGM && game.users.activeGM.id !== game.user.id) return;
    if (Settings.get("aiMode") === false) return;
    if (!IronswornController?.isActive?.()) return;
    if (!actor?.id) return;

    // Cheap gate: only react when the committed diff touched experience data.
    const sys = changed?.system;
    const touchedXp = sys && Object.prototype.hasOwnProperty.call(sys, "xp");
    const touchedLegacies = sys && Object.prototype.hasOwnProperty.call(sys, "legacies");
    if (!touchedXp && !touchedLegacies) return;

    const current = IronswornController.getExperience(actor);
    const prev = _esXpBaseline.get(actor.id);
    // Always refresh the baseline to the post-update state.
    _esXpBaseline.set(actor.id, { xp: current.xp, legacies: current.legacies ? { ...current.legacies } : null });

    // First sighting: seed silently, never narrate on load / first edit.
    if (!prev) return;

    const info = { legacyDeltas: [] };
    if (typeof current.xp === "number" && typeof prev.xp === "number" && current.xp > prev.xp) {
      info.xpDelta = current.xp - prev.xp;
      info.newXp = current.xp;
    }
    if (current.legacies && prev.legacies) {
      for (const key of ["quests", "bonds", "discoveries"]) {
        const now = current.legacies[key];
        const was = prev.legacies[key];
        if (typeof now === "number" && typeof was === "number" && now > was) {
          info.legacyDeltas.push({ name: key, delta: now - was });
        }
      }
    }

    const hasGain = (typeof info.xpDelta === "number" && info.xpDelta > 0) || info.legacyDeltas.length > 0;
    if (!hasGain) return;

    // Fire-and-forget, slightly delayed so any concurrent sheet re-render and
    // dice animation settle first. Never blocks the actor update.
    setTimeout(() => {
      Integration.onXpGain(actor, info).catch(err =>
        console.warn(LOG_PREFIX, "onXpGain failed", err?.message ?? err));
    }, Integration._narrationDelayMs?.() ?? 2000);
  } catch (err) {
    console.warn(LOG_PREFIX, "updateActor XP watcher failed:", err?.message ?? err);
  }
});

/* === Automatic vow-completion XP award (v0.10.32 — Phase 1) =========
 * The SINGLE automatic XP-granting point. When a vow progress-track Item is
 * marked complete — from the character sheet, a fulfilled-vow roll, the
 * auto-completion flow, or an AI complete_vow directive — this hook awards
 * the rank-appropriate experience exactly ONCE (Troublesome 1 … Epic 5).
 *
 * Why a hook? `system.completed` flips true through MANY code paths; watching
 * the committed change catches them all without threading XP logic through
 * each one. Idempotency is enforced by IronswornController.grantVowXp(), which
 * sets a per-track `xpAwarded` flag — so re-renders, repeated directives, or a
 * manual + AI double-complete can never grant twice.
 *
 * XP is earned for VOWS only (the Ironsworn rule); journeys and combat tracks
 * complete without an XP award. The optional weak-hit half-XP rule reads the
 * outcome an emitting path may pass through the update options as
 * `options.theEternalSkald.xpOutcome` ("weak"); absent options ⇒ full XP.
 *
 * Guards (each cheap, fail-safe):
 *   • Active GM only          — avoids duplicate awards across clients.
 *   • awardXpOnCompletion ON  — the master toggle (default ON).
 *   • Ironsworn integration active.
 *   • The committed diff actually set `system.completed` true.
 *   • The Item is a VOW track (system.subtype === "vow" or our trackKind flag).
 * ==================================================================== */
Hooks.on("updateItem", (item, changed, options /*, userId */) => {
  try {
    if (!game.user?.isGM) return;
    if (game.users?.activeGM && game.users.activeGM.id !== game.user.id) return;
    if ((Settings.get("awardXpOnCompletion") ?? true) === false) return;
    if (!IronswornController?.isActive?.()) return;

    // Only react to a fresh transition to completed === true.
    if (changed?.system?.completed !== true) return;

    // The track must belong to a character actor.
    const actor = item?.parent ?? item?.actor ?? null;
    if (!actor?.id) return;

    // VOWS only. Identify by the system subtype or our own trackKind flag —
    // never award for journeys, combat, or generic progress tracks.
    const subtype = foundry.utils.getProperty(item, "system.subtype");
    const kind = item.getFlag?.(MODULE_ID, "trackKind")
      ?? foundry.utils.getProperty(item, `flags.${MODULE_ID}.trackKind`);
    const isVow = subtype === "vow" || kind === "vow";
    if (!isVow) return;

    // Outcome (for the optional half-XP rule) may be supplied by the emitting
    // path through the document update options; default to a full (strong) award.
    const outcome = options?.theEternalSkald?.xpOutcome ?? "strong";
    const weakHitHalf = (Settings.get("weakHitHalfXp") ?? false) === true;

    IronswornController.grantVowXp(actor, item, { outcome, weakHitHalf })
      .then(res => {
        if (res && res.ok === false && res.error) {
          console.warn(LOG_PREFIX, "auto vow-XP award failed:", res.error);
        }
      })
      .catch(err => console.warn(LOG_PREFIX, "auto vow-XP award threw:", err?.message ?? err));
  } catch (err) {
    console.warn(LOG_PREFIX, "updateItem vow-XP hook failed:", err?.message ?? err);
  }
});

// A fresh world / reload starts with a clean index.
Hooks.once("ready", () => {
  try { EntityLinker.invalidate(); } catch (_) { /* defensive */ }
  // (v0.9.0) Render any user-customised link styles into the live document.
  try { EntityLinker.applyCustomStyles(); } catch (_) { /* defensive */ }
  // (v0.9.3) Repair installs still pinned to the broken v0.9.2 Abacus AI URL.
  try { migrateLegacyAbacusEndpoint(); } catch (_) { /* defensive */ }
  // (v0.10.31) Best-effort refresh of the OpenRouter vision-model catalogue
  // from its public /models endpoint. No API key needed; any failure leaves
  // the embedded static list in place. The freshened list is picked up the
  // next time the Settings Config window is opened.
  try { fetchOpenRouterVisionModels(); } catch (_) { /* defensive */ }
});

// --- Asset index priming (v0.7.0) ------------------------------------
// The asset compendium index is async to build, but the EntityLinker's
// index build is synchronous and reads a cached snapshot. Prime that cache
// once the world is ready (when the Ironsworn system + its compendia are
// available), then invalidate the linker so the next narration includes
// assets. Fire-and-forget; fully defensive — asset linking simply stays
// off if anything fails.
Hooks.once("ready", () => {
  try {
    if (IronswornController?.isActive?.() && typeof IronswornController._buildAssetIndex === "function") {
      IronswornController._buildAssetIndex()
        .then(() => { try { EntityLinker.invalidate(); } catch (_) {} })
        .catch(() => { /* defensive — asset linking stays off */ });
    }
  } catch (_) { /* defensive */ }
});

// --- Foe catalogue priming (v0.10.14) --------------------------------
// Regular foes must be drawn from the official foundry-ironsworn foe
// compendia (Ironsworn Foes + Delve Foes). The system prompt embeds that
// catalogue so the AI picks real foes instead of inventing names, but the
// prompt builder is synchronous and reads a cached snapshot. Prime the foe
// index once the world is ready (when the compendia are available) so the
// catalogue is present from the first combat narration. Fire-and-forget and
// fully defensive — if anything fails the prompt simply omits the catalogue
// and foe creation still works (falling back to compendium rank lookup).
Hooks.once("ready", () => {
  try {
    if (IronswornController?.isActive?.() && typeof IronswornController._buildFoeIndex === "function") {
      IronswornController._buildFoeIndex().catch(() => { /* defensive — catalogue stays off */ });
    }
  } catch (_) { /* defensive */ }
});

// --- Foe-ACTOR index priming (v0.10.37 — Phase 3) --------------------
// The create_foe effect spawns a real foe ACTOR copied from the foe-actor
// compendia (foe-actors-is / -delve / -sf). Building that index is async, so
// prime it once on ready (fire-and-forget, fully defensive) — the first
// create_foe directive then resolves without an indexing stall. If it fails
// the lookup simply rebuilds on demand and createFoeActor falls back to a
// minimal custom foe.
Hooks.once("ready", () => {
  try {
    if (IronswornController?.isActive?.() && typeof IronswornController._buildFoeActorIndex === "function") {
      IronswornController._buildFoeActorIndex().catch(() => { /* defensive — rebuilds on demand */ });
    }
  } catch (_) { /* defensive */ }
});
