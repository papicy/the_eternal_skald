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
export const RagBridge = {
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
export const ContradictionDetector = {
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

import { EntityLinker } from "./chronicle/entity-linking.js";
import { JournalSystem } from "./chronicle/journal-system.js";


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

import { Integration } from "./narrative/integration.js";

import { NpcDialogue, OracleInterpreter, LoreGenerator } from "./narrative/generators.js";

/* ===================================================================== */
/*  §10b AUTO-JOURNALING SYSTEM (v0.4.0)                                  */
/* ===================================================================== */


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

import { MapVision } from "./vision/map-vision.js";

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
