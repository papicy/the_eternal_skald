import { LOG_PREFIX, MODULE_ID, SKALD_NAME, COMMANDS } from "../core/constants.js";
import { Settings } from "../core/settings.js";
import { Client } from "../ai/client.js";
import { fetchOpenRouterVisionModels } from "../core/model-catalogue.js";
import { refreshModelDropdowns, migrateLegacyAbacusEndpoint } from "../ai/providers.js";
import { Memory, Chat } from "../chat/display.js";
import { Commands, extractMessageText, stripHtml, tryCommandFromText } from "../chat/commands.js";
import { EntityLinker } from "../chronicle/entity-linking.js";
import { JournalSystem } from "../chronicle/journal-system.js";
import { MapVision } from "../vision/map-vision.js";
import { Integration } from "../narrative/integration.js";
import { NpcDialogue, OracleInterpreter, LoreGenerator } from "../narrative/generators.js";
import { TtsNarrator } from "../narrative/tts-narrator.js";
import { CombatController } from "../eternal-skald.js";
import { IronswornData } from "../ironsworn-data.js";
import { IronswornController } from "../ironsworn-controller.js";
import { BrowserRAG } from "../browser-rag.js";
import { SystemRegistry, registerSystem } from "../systems/registry.js";
import { NimbleAdapter } from "../systems/nimble-adapter.js";
import { Dnd5eAdapter } from "../systems/dnd5e-adapter.js";
import { Pf2eAdapter } from "../systems/pf2e-adapter.js";
import { getSettingsPanelClass } from "../ui/settings-panel.js";
import { installChatAutocomplete } from "../ui/command-autocomplete.js";
import { getWizardClass, maybeLaunchFirstRun } from "../ui/first-run-wizard.js";


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
  // (fix — version drift) Authoritative startup banner: the version is read from
  // the module manifest (module.json) via game.modules, which is guaranteed
  // populated inside the init hook. This is the reliable, always-correct version
  // log (the top-level breadcrumb in eternal-skald.js may fire before the manifest
  // is ready). Single source of truth — never goes stale on a version bump.
  console.log(LOG_PREFIX, `init hook fired — initialising module v${game.modules.get(MODULE_ID)?.version ?? "?"} …`);
  try {
    Settings.register();
    console.log(LOG_PREFIX, "Settings registered.");
  } catch (err) {
    console.error(LOG_PREFIX, "Settings.register() failed:", err);
  }

  /* === Tabbed settings panel (v0.21.0, S1) ============================
   * Register a settings MENU that opens the custom ApplicationV2 panel
   * grouping the module's settings into tabs. Purely additive — the native
   * flat list (every setting keeps config:true) is unchanged. Skipped
   * gracefully if ApplicationV2 is unavailable.
   * =================================================================== */
  try {
    const PanelCls = getSettingsPanelClass();
    if (PanelCls) {
      game.settings.registerMenu(MODULE_ID, "tabbedSettings", {
        name: game.i18n.localize("ETERNAL_SKALD.settingsPanel.menu.name"),
        label: game.i18n.localize("ETERNAL_SKALD.settingsPanel.menu.label"),
        hint: game.i18n.localize("ETERNAL_SKALD.settingsPanel.menu.hint"),
        icon: "fas fa-sliders",
        type: PanelCls,
        restricted: false
      });
      console.log(LOG_PREFIX, "Tabbed settings menu registered.");
    }
  } catch (err) {
    console.warn(LOG_PREFIX, "Tabbed settings menu registration failed:", err?.message ?? err);
  }

  /* === First-run setup wizard (v0.21.0, U4) ===========================
   * Register a settings MENU that re-opens the guided onboarding wizard at
   * any time. The wizard also launches itself automatically on first run
   * (see the ready hook below). Purely additive; skipped if ApplicationV2
   * is unavailable.
   * =================================================================== */
  try {
    const WizardCls = getWizardClass();
    if (WizardCls) {
      game.settings.registerMenu(MODULE_ID, "firstRunWizard", {
        name: game.i18n.localize("ETERNAL_SKALD.wizard.menu.name"),
        label: game.i18n.localize("ETERNAL_SKALD.wizard.menu.label"),
        hint: game.i18n.localize("ETERNAL_SKALD.wizard.menu.hint"),
        icon: "fas fa-hat-wizard",
        type: WizardCls,
        restricted: true
      });
      console.log(LOG_PREFIX, "First-run wizard menu registered.");
    }
  } catch (err) {
    console.warn(LOG_PREFIX, "First-run wizard menu registration failed:", err?.message ?? err);
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

  // (Phase 1) Register the system adapters with the multi-system registry.
  // The Ironsworn controller already satisfies the SystemAdapter contract, so
  // this is a verbatim re-registration — purely additive. NOTHING consumes
  // getActiveAdapter() yet, so existing Ironsworn behaviour is unchanged.
  try {
    registerSystem("foundry-ironsworn", IronswornController);
    // (Phase 4) Register the Nimble adapter. It lights up character READS,
    // the Nimble rules digest, and map vision; Ironsworn-only mechanics
    // (oracles / progress tracks / vows / momentum) report unsupported.
    registerSystem("nimble", NimbleAdapter);
    // (Phase E) Register the D&D 5e adapter. Read-only: it lights up character
    // READS (abilities/HP/AC/spell slots/items), the 5e rules digest, and map
    // vision; all Ironsworn-only mechanical writes report unsupported.
    registerSystem("dnd5e", Dnd5eAdapter);
    // (Phase E) Register the Pathfinder 2e adapter. Read-only: it lights up
    // character READS (abilities/HP/AC/hero & focus points/items), the PF2e
    // rules digest, and map vision; all Ironsworn-only mechanical writes report
    // unsupported.
    registerSystem("pf2e", Pf2eAdapter);
    console.log(LOG_PREFIX, "System adapter registry initialised —", JSON.stringify(SystemRegistry.list()));
  } catch (e) {
    console.warn(LOG_PREFIX, "System adapter registry init failed:", e?.message ?? e);
  }

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
    // --- Multi-system adapter registry (Phase 1) ---
    systems: SystemRegistry,
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
      // (v0.22.0 / F7) Auto-narrate brand-new Skald cards aloud when the
      // player has opted in. Fires here (creation) — NOT on render — so old
      // cards aren't re-spoken on every scrollback/reload. Fail-soft.
      try {
        if (Settings.get("ttsEnabled") === true && Settings.get("ttsAutoNarrate") === true) {
          TtsNarrator.narrateMessage(message);
        }
      } catch (_) { /* defensive — narration must never break chat */ }
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
  // Add the 🔊 narrate control (no-op when TTS disabled/unavailable).
  try { TtsNarrator.wireNarrateButton(message, html); } catch (_) { /* defensive */ }
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
    TtsNarrator.wireNarrateButton(message, el);
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

/* === Narration → RAG memory (v0.25.0, opt-in) ========================
 * Index the unfolding STORY into semantic memory: AI-generated Skald story
 * cards and player in-character (IC/EMOTE) narration. Everything else —
 * OOC, dice rolls, system/help/error/suggest cards, slash-commands and
 * whispers — is rejected by BrowserRAG.prepareNarrationRecord, so these
 * hooks stay dumb: they enqueue every message and let the classifier filter.
 *
 * Enqueue-only and soft-fail: embedding runs in the background and these
 * handlers never throw, so narration memory can never break chat. A SEPARATE
 * pair of create/update handlers (rather than editing the command/roll hooks
 * above) keeps the concern isolated and trivially removable; Foundry happily
 * runs multiple handlers for the same hook.
 * ==================================================================== */
Hooks.on("createChatMessage", (message) => {
  try { BrowserRAG?.indexNarration?.(message); }
  catch (_) { /* soft-fail: memory must never break chat */ }
});

// Re-embed on meaningful edits (debounced inside indexNarration; same id
// replaces). Crucial for AI story cards: callSkaldStreaming posts a THINKING
// placeholder, then patches in the final prose via updateChatMessage — so the
// *edit* carries the real narration. Re-running the gate here indexes the
// final content, not the placeholder, and the stable narration:${id} key means
// each re-embed replaces the prior vector (never a half-streamed fragment).
Hooks.on("updateChatMessage", (message, changed) => {
  try { if (changed?.content !== undefined) BrowserRAG?.indexNarration?.(message); }
  catch (_) { /* soft-fail */ }
});

// Evict a message's narration vector when it's deleted (mirrors deleteJournalEntry).
Hooks.on("deleteChatMessage", (message) => {
  try { if (message?.id) BrowserRAG?.remove?.(`narration:${message.id}`); }
  catch (_) { /* soft-fail */ }
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

// --- Compendium context index priming (v0.15.0) ---------------------
// The AI Compendium Context feature embeds token-efficient NAME catalogues
// (Moves / Assets / Truths / Delve content) into the system prompt. The
// prompt builder is synchronous and reads a cached snapshot, so prime the
// generic context index once the world is ready (when the compendia are
// available). Fire-and-forget and fully defensive — if anything fails the
// prompt simply omits the catalogues and everything else keeps working.
Hooks.once("ready", () => {
  try {
    if (IronswornController?.isActive?.() && typeof IronswornController._buildContextIndex === "function") {
      IronswornController._buildContextIndex().catch(() => { /* defensive — catalogues stay off */ });
    }
  } catch (_) { /* defensive */ }
});


// --- Inline command autocomplete (v0.21.0, U5) ----------------------
// Attach the "!"-command autocomplete dropdown to the chat input. We try on
// every chat-log render (covers re-renders / popout) and once on ready as a
// fallback. attachAutocomplete() is idempotent (flags the element), so
// repeated calls are safe. Fully defensive — a no-op if the input is absent.
Hooks.on("renderChatLog", (_app, html) => {
  try { installChatAutocomplete(html); } catch (_) { /* defensive */ }
});
Hooks.once("ready", () => {
  try { installChatAutocomplete(); } catch (_) { /* defensive */ }
});

// --- First-run onboarding wizard (v0.21.0, U4) ----------------------
// On the very first ready of a new world (firstRunComplete flag unset), the
// GM is greeted with the guided setup wizard. Fully defensive and a no-op
// for returning worlds, players, or when AI Mode is off.
Hooks.once("ready", () => {
  try { maybeLaunchFirstRun(); } catch (_) { /* defensive */ }
});
