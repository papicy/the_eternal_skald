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
/*  §13 HOOK REGISTRATIONS (extracted to hooks/foundry-hooks.js)          */
/* ===================================================================== */
import "./hooks/foundry-hooks.js";
