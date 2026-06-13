/*
 * §2  MODULE SETTINGS  (extracted from eternal-skald.js - Phase 2 refactor)
 *
 * The Settings registry plus its private onChange helper applyProviderPreset,
 * moved verbatim with zero behavioral change. Settings.register() is still
 * invoked from the 'init' hook in the main module. This module imports only
 * from core/ (constants + model-catalogue), so it has no dependency back on
 * the main module and introduces no import cycle.
 */
import {
  MODULE_ID, SKALD_NAME, LOG_PREFIX,
  DEFAULT_ENDPOINT, DEFAULT_MODEL, PROVIDER_PRESETS
} from "./constants.js";
import { buildModelChoices } from "./model-catalogue.js";
// EntityLinker lives in chronicle/.
// It is only touched inside setting onChange callbacks (call-time), so this
// late binding back into the main module is cycle-safe.
import { EntityLinker } from "../chronicle/entity-linking.js";
// IronswornController is referenced only inside a setting onChange callback
// (call-time), so this import is cycle-safe.
import { IronswornController } from "../ironsworn-controller.js";
import { Logger } from "./logger.js";

/* ===================================================================== */
/*  §2  MODULE SETTINGS                                                   */
/* ===================================================================== */

export const Settings = {
  /** Register all settings — called from the 'init' hook. */
  register() {
    /* ---- AI Mode master toggle (v0.3.2) ----
     * Controls whether the Eternal Skald responds to "!"-prefixed chat
     * messages at all. When OFF, "!" messages pass through as ordinary
     * chat and the AI GM stays silent. Defaults to ON for new sessions.
     * Can also be flipped with the configurable keybinding (see init).
     */
    game.settings.register(MODULE_ID, "aiMode", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.aiMode.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.aiMode.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      onChange: (v) => {
        try {
          const on = !!v;
          ui.notifications?.info(
            `${SKALD_NAME}: AI Mode ${on ? "ON — the Skald listens." : "OFF — the Skald rests."}`
          );
        } catch (_) {}
      }
    });

    /* ---- Streaming responses (v0.3.3) ----
     * When ON, the Skald renders its replies token-by-token in real time
     * (Server-Sent Events) for near-instant feedback instead of waiting
     * for the whole reply. Falls back automatically to the buffered
     * request if streaming is unavailable or errors out. Defaults to ON.
     */
    game.settings.register(MODULE_ID, "streamingEnabled", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.streamingEnabled.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.streamingEnabled.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    // (v0.14.4 / P2) Request timeout in seconds. An AbortController in
    // ai/client.js aborts any AI fetch whose connection/response-headers phase
    // stalls longer than this, so a dead upstream can't hang the UI for the
    // upstream's full 60s. Cleared the instant headers arrive, so live SSE
    // streams and long downloads are never cut off. World-scoped, GM-only.
    game.settings.register(MODULE_ID, "requestTimeout", {
      name: "Request Timeout (seconds)",
      hint: "How long the Skald waits for the AI endpoint to start responding before giving up. Prevents a stalled request from hanging the UI. The timer only covers the initial connection; an active streaming reply is never interrupted. Default: 30.",
      scope: "world",
      config: true,
      type: Number,
      default: 30
    });

    // (v0.9.1) AI Provider preset dropdown. Picking a known provider
    // auto-fills the API Endpoint below with that provider's OpenAI-compatible
    // chat-completions URL — the user still supplies their own API key and
    // model name. "Custom" leaves the endpoint untouched (used for self-hosted
    // gateways, the legacy RouteLLM endpoint, or any other URL).
    // (v0.9.2) Added Abacus AI as the recommended default provider — the Skald
    // is powered by Abacus AI ChatLLM, so this is the smoothest path for most
    // users. Choices are listed in the documented order:
    //   Abacus AI (default) → OpenAI → OpenRouter → Google AI → Custom.
    game.settings.register(MODULE_ID, "providerPreset", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.providerPreset.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.providerPreset.hint"),
      scope: "world",
      config: true,
      type: String,
      choices: {
        abacus:     game.i18n.localize("ETERNAL_SKALD.settings.providerPreset.choices.abacus"),
        openai:     game.i18n.localize("ETERNAL_SKALD.settings.providerPreset.choices.openai"),
        openrouter: game.i18n.localize("ETERNAL_SKALD.settings.providerPreset.choices.openrouter"),
        google:     game.i18n.localize("ETERNAL_SKALD.settings.providerPreset.choices.google"),
        ollama:     game.i18n.localize("ETERNAL_SKALD.settings.providerPreset.choices.ollama"),
        custom:     game.i18n.localize("ETERNAL_SKALD.settings.providerPreset.choices.custom")
      },
      default: "abacus",
      onChange: (value) => { try { applyProviderPreset(value); } catch (_) { /* never break settings */ } }
    });

    game.settings.register(MODULE_ID, "apiKey", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.apiKey.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.apiKey.hint"),
      scope: "world",
      config: true,
      type: String,
      default: ""
    });

    // (v0.10.31) AI Model is now a provider-FILTERED dropdown instead of a
    // free-text field. Its `choices` are computed from the curated vision-model
    // catalogue for the currently-selected provider, sorted FREE-first then by
    // ascending price, labelled "Model Name ($X.XX/1M) - Provider". The list is
    // re-filtered live when the provider changes (see refreshModelDropdowns,
    // bound from the renderSettingsConfig hook). Backwards-compatible: any
    // previously-saved custom model id is preserved as a "(current)" choice,
    // and the setting type stays String so the Client sends it verbatim.
    {
      const _provider = Settings.get("providerPreset") || "abacus";
      const _current  = Settings.get("modelName");
      const _curVal   = (_current == null || _current === "") ? DEFAULT_MODEL : _current;
      game.settings.register(MODULE_ID, "modelName", {
        name: game.i18n.localize("ETERNAL_SKALD.settings.modelName.name"),
        hint: game.i18n.localize("ETERNAL_SKALD.settings.modelName.hint"),
        scope: "world",
        config: true,
        type: String,
        choices: buildModelChoices(_provider, _curVal),
        default: DEFAULT_MODEL
      });
    }

    game.settings.register(MODULE_ID, "apiEndpoint", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.apiEndpoint.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.apiEndpoint.hint"),
      scope: "world",
      config: true,
      type: String,
      default: DEFAULT_ENDPOINT
    });

    // (v0.10.12) Connection mode — how the client reaches the LLM.
    //
    //   auto    (default) Try the same-origin server hook (/skald-api/*)
    //           first; if it isn't loaded (network error or Foundry's own
    //           404 page) transparently fall back to a direct browser→LLM
    //           fetch. This is what makes the Skald work on *hosted/managed*
    //           Foundry where users cannot add the `node --import` flag that
    //           the server hook requires.
    //   server  Force the server hook only. If the hook isn't loaded, surface
    //           the helpful "--import" setup error (no direct fallback).
    //   direct  Skip the hook entirely and always call the LLM endpoint
    //           directly from the browser (works wherever the endpoint allows
    //           cross-origin requests — the default Abacus AI endpoint does).
    game.settings.register(MODULE_ID, "connectionMode", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.connectionMode.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.connectionMode.hint"),
      scope: "world",
      config: true,
      type: String,
      choices: {
        auto:   game.i18n.localize("ETERNAL_SKALD.settings.connectionMode.choices.auto"),
        server: game.i18n.localize("ETERNAL_SKALD.settings.connectionMode.choices.server"),
        direct: game.i18n.localize("ETERNAL_SKALD.settings.connectionMode.choices.direct")
      },
      default: "auto"
    });

    game.settings.register(MODULE_ID, "intensity", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.intensity.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.intensity.hint"),
      scope: "world",
      config: true,
      type: Number,
      default: 6,
      range: { min: 1, max: 10, step: 1 }
    });

    // (v0.20.0 F2) Campaign genre / tone. Selects a tone-directive paragraph
    // (see TONE_DIRECTIVES in constants.js) that is injected into the system
    // prompt to steer vocabulary, cadence and thematic emphasis WITHOUT
    // replacing the Skald's core persona. Default "default" → no injection, so
    // existing worlds are unaffected unless the GM opts in.
    game.settings.register(MODULE_ID, "narrativeTone", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.narrativeTone.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.narrativeTone.hint"),
      scope: "world",
      config: true,
      type: String,
      choices: {
        default:      game.i18n.localize("ETERNAL_SKALD.settings.narrativeTone.choices.default"),
        epic:         game.i18n.localize("ETERNAL_SKALD.settings.narrativeTone.choices.epic"),
        dark:         game.i18n.localize("ETERNAL_SKALD.settings.narrativeTone.choices.dark"),
        lighthearted: game.i18n.localize("ETERNAL_SKALD.settings.narrativeTone.choices.lighthearted"),
        horror:       game.i18n.localize("ETERNAL_SKALD.settings.narrativeTone.choices.horror"),
        custom:       game.i18n.localize("ETERNAL_SKALD.settings.narrativeTone.choices.custom")
      },
      default: "default"
    });

    // (v0.20.0 F2) Free-text tone directive, used only when narrativeTone is
    // "custom". Blank → no injection (fail-soft).
    game.settings.register(MODULE_ID, "narrativeToneCustom", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.narrativeToneCustom.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.narrativeToneCustom.hint"),
      scope: "world",
      config: true,
      type: String,
      default: ""
    });

    game.settings.register(MODULE_ID, "autoNarrateCombat", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.autoNarrateCombat.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.autoNarrateCombat.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, "autoControlEnemies", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.autoControlEnemies.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.autoControlEnemies.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: false
    });

    game.settings.register(MODULE_ID, "memoryLength", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.memoryLength.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.memoryLength.hint"),
      scope: "world",
      config: true,
      type: Number,
      default: 20,
      range: { min: 4, max: 60, step: 2 }
    });

    /* ---- Ironsworn system integration (v0.3.0) ---- */

    game.settings.register(MODULE_ID, "ironswornIntegration", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.ironswornIntegration.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.ironswornIntegration.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, "suggestMoves", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.suggestMoves.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.suggestMoves.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, "autoNarrateMoves", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.autoNarrateMoves.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.autoNarrateMoves.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    /* ---- Player move declarations (v0.10.33) ---- */

    game.settings.register(MODULE_ID, "interceptMoveDeclarations", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.interceptMoveDeclarations.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.interceptMoveDeclarations.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    /* ---- Intelligent action → move mapping (v0.10.34) ---- */

    game.settings.register(MODULE_ID, "intelligentMoveDetection", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.intelligentMoveDetection.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.intelligentMoveDetection.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, "intelligentMoveConfirm", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.intelligentMoveConfirm.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.intelligentMoveConfirm.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: false
    });

    // (v0.10.38 — Phase 4) Asset Bonus Advisory: when ON, the Skald posts a
    // non-blocking chat suggestion if one of the rolling character's assets
    // grants a bonus that plausibly applies to the move being made. Purely
    // advisory — the player applies it themselves in the roll dialog.
    game.settings.register(MODULE_ID, "assetBonusAdvisory", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.assetBonusAdvisory.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.assetBonusAdvisory.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, "autoNarrateXp", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.autoNarrateXp.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.autoNarrateXp.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    /* ---- Journey naming & progress (v0.11.3) ---- */

    // When ON, complex/poetic travel phrasing that the deterministic and
    // context layers can't parse is sent to a small, bounded LLM call to
    // extract a destination so the journey track is named meaningfully.
    game.settings.register(MODULE_ID, "aiJourneyNaming", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.aiJourneyNaming.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.aiJourneyNaming.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    // When ON, "Reach Your Destination" (and other journey progress rolls)
    // require a minimum number of filled progress boxes before they can be
    // rolled — preventing premature progress rolls on barely-started journeys.
    game.settings.register(MODULE_ID, "enforceJourneyProgressGate", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.enforceJourneyProgressGate.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.enforceJourneyProgressGate.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    // The minimum number of filled progress boxes (0–10) required before a
    // journey progress roll is allowed when the gate above is enabled.
    game.settings.register(MODULE_ID, "journeyMinProgressBoxes", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.journeyMinProgressBoxes.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.journeyMinProgressBoxes.hint"),
      scope: "world",
      config: true,
      type: Number,
      range: { min: 1, max: 10, step: 1 },
      default: 4
    });

    /* ---- Experience granting (v0.10.32 — Phase 1) ---- */

    game.settings.register(MODULE_ID, "awardXpOnCompletion", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.awardXpOnCompletion.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.awardXpOnCompletion.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, "weakHitHalfXp", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.weakHitHalfXp.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.weakHitHalfXp.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: false
    });

    game.settings.register(MODULE_ID, "narrationDelay", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.narrationDelay.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.narrationDelay.hint"),
      scope: "world",
      config: true,
      type: Number,
      range: { min: 0, max: 5000, step: 100 },
      default: 500
    });

    game.settings.register(MODULE_ID, "aiAppliesEffects", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.aiAppliesEffects.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.aiAppliesEffects.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, "showEffectAnnouncements", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.showEffectAnnouncements.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.showEffectAnnouncements.hint"),
      scope: "client",
      config: true,
      type: Boolean,
      default: true
    });

    /* ---- Full sheet modification (v0.10.36 — Phase 2) ----
     * Gate for the AI's direct character-sheet WRITES: impacts/conditions
     * and base stats. Progress/momentum/harm/supply remain governed by
     * aiAppliesEffects above; this controls only the heavier sheet edits so
     * a table that wants narration-only condition tracking can opt out.
     * Effect application already runs GM-side (the narration pipeline is
     * GM-gated), so this is an additional, explicit safety switch. */
    game.settings.register(MODULE_ID, "aiModifiesSheet", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.aiModifiesSheet.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.aiModifiesSheet.hint"),
      scope: "world",
      config: true,
      type: String,
      choices: {
        "off":      "Off — never change impacts or stats",
        "impacts":  "Impacts only — toggle conditions, never edit stats",
        "full":     "Full — impacts and base stats"
      },
      default: "impacts"
    });

    /* (v0.10.37 — Phase 3) Whether the AI GM may CREATE content out of the
     * official compendia: spawn foe actors, add assets/items to a character,
     * or create a blank player character. Entity creation is heavier than
     * sheet edits, so this is its own explicit, GM-only safety switch.
     *   "off"   — never create anything.
     *   "foes"  — spawn foe actors only (default; low-risk GM convenience).
     *   "full"  — foes + add assets/items + create characters.
     * All creation still runs GM-side through the Document API. */
    game.settings.register(MODULE_ID, "aiCreatesContent", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.aiCreatesContent.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.aiCreatesContent.hint"),
      scope: "world",
      config: true,
      type: String,
      choices: {
        "off":   "Off — never create actors or items",
        "foes":  "Foes only — spawn foe actors from the bestiary",
        "full":  "Full — foes, assets/items, and new characters"
      },
      default: "foes"
    });

    /* ---- Combat automation (v0.3.0) ---- */

    game.settings.register(MODULE_ID, "autoCreateCombatTracks", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.autoCreateCombatTracks.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.autoCreateCombatTracks.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, "autoCloseStaleCombatTracks", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.autoCloseStaleCombatTracks.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.autoCloseStaleCombatTracks.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    game.settings.register(MODULE_ID, "defaultEnemyRank", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.defaultEnemyRank.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.defaultEnemyRank.hint"),
      scope: "world",
      config: true,
      type: String,
      choices: {
        troublesome: "Troublesome",
        dangerous: "Dangerous",
        formidable: "Formidable",
        extreme: "Extreme",
        epic: "Epic"
      },
      default: "dangerous"
    });

    /* ---- Auto-journaling system (v0.4.0) ----
     * The Skald keeps a living chronicle: NPCs, locations, discoveries,
     * world facts, story threads and per-session recaps are written to
     * Foundry Journal Entries from structured metadata the AI appends to
     * its replies. All four settings below are world-scoped.
     */

    // Master toggle — when OFF, no metadata is requested and nothing is written.
    game.settings.register(MODULE_ID, "autoJournaling", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.autoJournaling.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.autoJournaling.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    // Toast verbosity for NPC/Location/Discovery writes.
    game.settings.register(MODULE_ID, "journalNotifications", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.journalNotifications.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.journalNotifications.hint"),
      scope: "world",
      config: true,
      type: String,
      choices: {
        none:     "None (silent)",
        minimal:  "Minimal (brief toast)",
        detailed: "Detailed (toast on create & update)"
      },
      default: "minimal"
    });

    // Who can see the auto-generated journals.
    game.settings.register(MODULE_ID, "journalPermissions", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.journalPermissions.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.journalPermissions.hint"),
      scope: "world",
      config: true,
      type: String,
      choices: {
        "gm-only": "GM only",
        "shared":  "Shared with players"
      },
      default: "gm-only"
    });

    // Auto-generate a Session Chronicle when !end-session is invoked.
    game.settings.register(MODULE_ID, "sessionAutoSummary", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.sessionAutoSummary.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.sessionAutoSummary.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    /* ---- Memory & journaling enhancements (v0.14.0) ----
     * Three world-scoped controls that govern HOW MUCH the chronicle records,
     * whether a backfill extractor runs when the AI forgets its metadata, and
     * whether the AI may amend/rewrite canonical entries (and how).
     * No journal/document schema changes — purely behavioral gates.
     */

    // 1) Journaling Density — how much narrative detail becomes chronicle data.
    //    "notable" reproduces the exact pre-v0.14 behavior (omit when nothing
    //    major happened); higher tiers progressively REQUIRE a metadata block
    //    and atomic Who/What/Where/When/How/Why facts. Consumed by
    //    buildJournalPromptBlock() in scripts/ai/prompt-builder.js.
    game.settings.register(MODULE_ID, "journalingDensity", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.journalingDensity.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.journalingDensity.hint"),
      scope: "world",
      config: true,
      type: String,
      choices: {
        notable:    "Notable only (record major beats — original behavior)",
        standard:   "Standard (always note 1–3 anchors per reply)",
        high:       "High (record most continuity anchors & world state)",
        exhaustive: "Exhaustive (record nearly everything worth remembering)"
      },
      default: "standard"
    });

    // 2) Metadata Backfill — when a reply has no valid [[SKALD_META]] block,
    //    run a second lightweight extractor AI call to mine the finished
    //    narrative for chronicle notes. Consumed by JournalSystem.ingestReply()
    //    in scripts/chronicle/journal-system.js. Fire-and-forget; degrades
    //    gracefully if the extractor call fails.
    game.settings.register(MODULE_ID, "metadataBackfill", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.metadataBackfill.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.metadataBackfill.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    // 3) Journal Edit Mode — governs AI-initiated amend/rewrite/merge/rename.
    //    "manual"  : only the GM commands (!journal-rewrite / !journal-amend)
    //                may mutate canonical entries.
    //    "propose" : the AI may PROPOSE changes; the GM clicks Accept/Reject on
    //                a GM-only chat card before anything is written.
    //    "auto"    : the AI applies changes automatically, but ONLY on the
    //                active-GM client (still GM-authoritative). History is
    //                always archived first — content is never hard-deleted.
    game.settings.register(MODULE_ID, "journalEditMode", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.journalEditMode.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.journalEditMode.hint"),
      scope: "world",
      config: true,
      type: String,
      choices: {
        manual:  "Manual (only GM commands rewrite/amend)",
        propose: "AI proposes (GM clicks Accept / Reject)",
        auto:    "Auto (AI applies — active GM only, history archived)"
      },
      default: "manual"
    });

    // ---- Browser-based RAG / AI memory (v0.5.0) -----------------------

    // Master switch for semantic memory. When off, the Skald behaves
    // exactly as v0.4.0 (no embeddings, no vector store, no model load).
    game.settings.register(MODULE_ID, "ragEnabled", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.ragEnabled.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.ragEnabled.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    // (v0.20.0 F1) Index official / world COMPENDIUM packs into semantic memory
    // alongside the campaign chronicle, so the Skald can recall lore, moves,
    // assets and oracle entries. Opt-in (default OFF) because large compendia
    // take time + storage to embed; run !reindex-compendiums after enabling.
    game.settings.register(MODULE_ID, "ragIndexCompendiums", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.ragIndexCompendiums.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.ragIndexCompendiums.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: false
    });

    // Maximum tokens of recalled world memory injected per AI call.
    game.settings.register(MODULE_ID, "ragContextTokens", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.ragContextTokens.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.ragContextTokens.hint"),
      scope: "world",
      config: true,
      type: Number,
      range: { min: 200, max: 6000, step: 100 },
      default: 2000
    });

    // How many top matches to retrieve per query.
    game.settings.register(MODULE_ID, "ragMaxResults", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.ragMaxResults.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.ragMaxResults.hint"),
      scope: "world",
      config: true,
      type: Number,
      range: { min: 1, max: 20, step: 1 },
      default: 5
    });

    // Automatically embed journal entries as the Skald scribes them.
    game.settings.register(MODULE_ID, "ragAutoIndex", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.ragAutoIndex.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.ragAutoIndex.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    // Minimum cosine similarity for a memory to be considered relevant.
    game.settings.register(MODULE_ID, "ragSimilarityThreshold", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.ragSimilarityThreshold.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.ragSimilarityThreshold.hint"),
      scope: "world",
      config: true,
      type: Number,
      range: { min: 0, max: 1, step: 0.05 },
      default: 0.3
    });

    // Verbose RAG console logging for troubleshooting.
    game.settings.register(MODULE_ID, "ragDebugMode", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.ragDebugMode.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.ragDebugMode.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: false
    });

    game.settings.register(MODULE_ID, "debugLogging", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.debugLogging.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.debugLogging.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: false,
      onChange: (v) => { try { IronswornController.setDebug(!!v); } catch (_) {} }
    });

    /* ---- Unified logging level (M1) ----
     * One knob for how verbose the Skald's console output is, used by the
     * shared core/logger.js facade. Additive and backwards-compatible: the
     * legacy `debugLogging` toggle above still works (when ON it forces debug
     * output regardless of this choice). Default "warn" keeps the console
     * quiet during normal play. World-scoped, GM-only.
     */
    game.settings.register(MODULE_ID, "loggingLevel", {
      name: "Logging Level",
      hint: "How much the Skald writes to the browser console. 'Off' silences it, 'Warnings' (default) shows only warnings and errors, 'Info' adds high-level activity, and 'Debug' is fully verbose. The legacy Debug Logging toggle, when on, forces Debug regardless of this setting.",
      scope: "world",
      config: true,
      type: String,
      choices: {
        off:   "Off (errors are still shown by the browser)",
        error: "Errors only",
        warn:  "Warnings and errors (default)",
        info:  "Info, warnings and errors",
        debug: "Debug (everything)"
      },
      default: "warn"
    });

    /* ---- Entity linking in narration (v0.5.1) ----
     * When ON, names the Skald narrates that match an auto-scribed
     * chronicle entry (NPC / location / discovery) or a known Ironsworn
     * move are turned into clickable links in the chat — journal entities
     * open their JournalEntry, moves offer a one-click roll. Purely
     * additive and degrades gracefully if nothing matches. Defaults to ON.
     */
    game.settings.register(MODULE_ID, "entityLinking", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.entityLinking.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.entityLinking.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      onChange: () => { try { EntityLinker.invalidate(); } catch (_) {} }
    });

    /* ---- Customisable link styles (v0.9.0) ----
     * When ON, the per-kind colours and leading icons of the inline entity
     * links the Skald weaves into narration are taken from the user's
     * `linkStyles` object (editable via the `!link-style` command). When OFF,
     * the built-in palette is used. Purely cosmetic and degrades gracefully.
     */
    game.settings.register(MODULE_ID, "customLinkStyles", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.customLinkStyles.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.customLinkStyles.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: false,
      onChange: () => {
        // Re-render the live override stylesheet and rebuild the index so
        // freshly-narrated links pick up any icon changes.
        try { EntityLinker.applyCustomStyles(); } catch (_) {}
        try { EntityLinker.invalidate(); } catch (_) {}
      }
    });

    // (v0.9.0) Per-kind colour/icon overrides, keyed by entity kind
    // ("journal"|"move"|"oracle"|"track"|"asset"). Managed in-code via the
    // !link-style command; hidden from the config UI.
    game.settings.register(MODULE_ID, "linkStyles", {
      scope: "world",
      config: false,
      type: Object,
      default: {},
      onChange: () => {
        try { EntityLinker.applyCustomStyles(); } catch (_) {}
        try { EntityLinker.invalidate(); } catch (_) {}
      }
    });

    /* ---- Context-aware next-step suggestions (v0.9.0) ----
     * When ON, the Skald may close a narration with a brief, optional hint
     * that references the party's current location/scene
     * (e.g. "Since you stand within the Ancient Ruins, you might investigate
     * the collapsed shrine…"). Player agency is preserved — it only ever
     * suggests, never dictates. Defaults to ON.
     */
    game.settings.register(MODULE_ID, "contextSuggestions", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.contextSuggestions.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.contextSuggestions.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    /* ---- Lore contradiction detection (v0.9.0) ----
     * When ON, newly-narrated facts are quietly checked against the Skald's
     * established semantic memory (RAG); if a fact appears to conflict with
     * recorded lore, a private GM-only alert card is posted. Requires
     * Semantic Memory (RAG). Costs one extra background AI call per ingest,
     * so it is OFF by default. Never blocks or breaks narration.
     */
    game.settings.register(MODULE_ID, "contradictionDetection", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.contradictionDetection.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.contradictionDetection.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: false
    });

    /* ---- Idle auto session-summary threshold (v0.9.0) ----
     * Minutes of inactivity (no narration ingested) after which the Skald
     * automatically weaves a Session Chronicle, provided "Session Chronicle"
     * (sessionAutoSummary) is enabled and there is unsaved activity. 0
     * disables the idle timer (manual !end-session still works).
     */
    game.settings.register(MODULE_ID, "sessionAutoMinutes", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.sessionAutoMinutes.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.sessionAutoMinutes.hint"),
      scope: "world",
      config: true,
      type: Number,
      range: { min: 0, max: 240, step: 5 },
      default: 0
    });

    // (v0.8.0) Living Chronicle timeline — a persistent, world-scoped log of
    // chronicle events (entity activity, revealed facts, decisions, mysteries).
    // Unlike the in-memory `_sessionLog`, this survives reloads and is NOT
    // cleared when a session chronicle is generated, so `!timeline` can render
    // the full campaign history. Hidden from the config UI (managed in-code).
    game.settings.register(MODULE_ID, "timelineEvents", {
      scope: "world",
      config: false,
      type: Array,
      default: []
    });

    /* ---- Map vision: auto-analyse scenes (v0.10.23) ----
     * When ON, the Skald automatically "scouts" the artwork of a newly
     * viewed/activated scene using a vision-capable AI model, identifying
     * terrain, landmarks, paths, hazards and points of interest. Discovered
     * locations are auto-scribed to the Living Chronicle and pinned to the
     * scene's flags so it is never re-analysed unless forced via !scout.
     * GM-only (world-scoped). Costs one vision AI call per new scene, so the
     * GM can disable it and rely on the on-demand !scout command instead.
     * Defaults to ON.
     */
    game.settings.register(MODULE_ID, "autoAnalyzeScenes", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.autoAnalyzeScenes.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.autoAnalyzeScenes.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });

    /* ---- Vision model (v0.10.23) ----
     * Which model performs map/image analysis. "inherit" (default) reuses the
     * main Narration Model (Model Name above) — sensible when that model is
     * already multimodal (e.g. gemini-3-flash-preview, gpt-4o). The explicit
     * choices let the GM pin a known vision-capable model just for scouting
     * without changing the narration model. If the selected model is NOT
     * vision-capable, the Skald degrades gracefully (a GM-only notice) rather
     * than wasting a call.
     */
    // (v0.10.31) Vision Model is now filtered by provider exactly like the AI
    // Model setting (same curated catalogue, same FREE-first price sort, same
    // "Model Name ($X.XX/1M) - Provider" labels), with an extra "inherit"
    // pseudo-choice kept first (the default — reuse the main narration model).
    // Re-filtered live when the provider changes via refreshModelDropdowns.
    // Backwards-compatible: a previously-saved custom/explicit vision model id
    // (e.g. the old hardcoded "claude-3-5-sonnet") is preserved as "(current)".
    {
      const _provider = Settings.get("providerPreset") || "abacus";
      const _current  = Settings.get("visionModel");
      const _curVal   = (_current == null || _current === "") ? "inherit" : _current;
      game.settings.register(MODULE_ID, "visionModel", {
        name: game.i18n.localize("ETERNAL_SKALD.settings.visionModel.name"),
        hint: game.i18n.localize("ETERNAL_SKALD.settings.visionModel.hint"),
        scope: "world",
        config: true,
        type: String,
        choices: buildModelChoices(_provider, _curVal, { includeInherit: true }),
        default: "inherit"
      });
    }

    /* ---- Map Analysis Quality (v0.10.24) ----
     * Controls how thoroughly the Skald reads a map.
     *   • "fast"     — a single full-map vision pass (1 AI call). Cheapest.
     *   • "balanced" — a full-map overview pass plus a 2×2 sectioned detail
     *                  pass on larger maps (recommended). Better text/POI recall.
     *   • "thorough" — full overview plus a 2×2 or 3×3 sectioned pass chosen by
     *                  map resolution, combining all findings. Best recall, but
     *                  costs several AI calls per scene.
     */
    game.settings.register(MODULE_ID, "mapAnalysisQuality", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.mapAnalysisQuality.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.mapAnalysisQuality.hint"),
      scope: "world",
      config: true,
      type: String,
      choices: {
        fast:     game.i18n.localize("ETERNAL_SKALD.settings.mapAnalysisQuality.choices.fast"),
        balanced: game.i18n.localize("ETERNAL_SKALD.settings.mapAnalysisQuality.choices.balanced"),
        thorough: game.i18n.localize("ETERNAL_SKALD.settings.mapAnalysisQuality.choices.thorough")
      },
      default: "balanced"
    });

    /* ---- Max Map Resolution (v0.10.24) ----
     * The longest-edge pixel cap the base map is downscaled to before it is
     * sent to the model. Higher keeps small text/labels legible (better recall)
     * at the cost of more image tokens. "original" disables downscaling.
     */
    game.settings.register(MODULE_ID, "maxMapResolution", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.maxMapResolution.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.maxMapResolution.hint"),
      scope: "world",
      config: true,
      type: String,
      choices: {
        "2048":     "2048 px",
        "3072":     "3072 px",
        "4096":     "4096 px ★",
        "original": game.i18n.localize("ETERNAL_SKALD.settings.maxMapResolution.choices.original")
      },
      default: "4096"
    });

    /* ---- Image Format (v0.10.24) ----
     * How captured map images are encoded before upload.
     *   • "auto" — PNG (lossless, sharpest text) for map scouting. Recommended.
     *   • "png"  — always lossless PNG.
     *   • "jpeg" — lossy JPEG (smallest payload, but compression blurs labels).
     */
    game.settings.register(MODULE_ID, "imageFormat", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.imageFormat.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.imageFormat.hint"),
      scope: "world",
      config: true,
      type: String,
      choices: {
        auto: game.i18n.localize("ETERNAL_SKALD.settings.imageFormat.choices.auto"),
        png:  "PNG",
        jpeg: "JPEG"
      },
      default: "auto"
    });

    /* ---- AI Compendium Context (v0.15.0) -------------------------------
     * Opt additional foundry-ironsworn compendia into the AI system prompt
     * as token-efficient NAME catalogues (names only, never full text), so
     * the Skald references real official Moves / Assets / Truths / Delve
     * content instead of inventing them. Each is an independent world toggle;
     * the prompt builder reads a cached snapshot and omits any category that
     * is OFF or not yet primed. Purely additive and degrades gracefully.
     * Defaults: Moves, Delve Moves, Assets and Foes ON (small, high value);
     * Truths, Domains and Themes OFF. `contextFoes` gates the EXISTING foe
     * catalogue block, preserving today's behaviour when left ON.
     */
    const CTX_DEFAULTS = {
      contextMoves:      true,
      contextDelveMoves: true,
      contextAssets:     true,
      contextTruths:     false,
      contextDomains:    false,
      contextThemes:     false,
      contextFoes:       true
    };
    for (const [key, def] of Object.entries(CTX_DEFAULTS)) {
      game.settings.register(MODULE_ID, key, {
        name: game.i18n.localize(`ETERNAL_SKALD.settings.${key}.name`),
        hint: game.i18n.localize(`ETERNAL_SKALD.settings.${key}.hint`),
        scope: "world",
        config: true,
        type: Boolean,
        default: def
      });
    }

    /* ----------------------------------------------------------------
     * Token control (v0.16.0) — move / remove / undo of scene tokens.
     * The WHOLE capability is OFF by default (brief invariant #1). AI
     * narrative-driven triggers are a second, separate opt-in so a GM can
     * enable manual control without granting the AI write access. The move
     * duration is exposed so a GM can tune or troubleshoot the animation.
     * ---------------------------------------------------------------- */
    game.settings.register(MODULE_ID, "tokenControlEnabled", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.tokenControlEnabled.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.tokenControlEnabled.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: false
    });
    game.settings.register(MODULE_ID, "tokenControlAiTriggers", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.tokenControlAiTriggers.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.tokenControlAiTriggers.hint"),
      scope: "world",
      config: true,
      type: Boolean,
      default: false
    });
    game.settings.register(MODULE_ID, "tokenMoveDuration", {
      name: game.i18n.localize("ETERNAL_SKALD.settings.tokenMoveDuration.name"),
      hint: game.i18n.localize("ETERNAL_SKALD.settings.tokenMoveDuration.hint"),
      scope: "world",
      config: true,
      type: Number,
      range: { min: 0, max: 5000, step: 100 },
      default: 1000
    });
  },

  /** Convenience accessor — returns undefined if the setting isn't ready. */
  get(key) {
    try { return game.settings.get(MODULE_ID, key); }
    catch (e) { return undefined; }
  }
};

/**
 * (v0.9.1) Apply a provider preset: when the user picks a known provider in
 * the AI Provider dropdown, point the API Endpoint at that provider's
 * OpenAI-compatible chat-completions URL. The "custom" preset is a no-op so
 * self-hosted / legacy RouteLLM / other endpoints stay exactly as typed.
 * (v0.9.2) Abacus AI is now a first-class preset and the recommended default.
 *
 * Fully defensive — a failure here must never block the settings UI. The
 * write is GM-scoped ("world"); non-GM clients can't persist it, so we guard
 * and inform gently rather than throwing.
 *
 * @param {string} preset - one of the keys of {@link PROVIDER_PRESETS}
 * @returns {Promise<void>}
 */
async function applyProviderPreset(preset) {
  const def = PROVIDER_PRESETS[preset];
  // Unknown preset or "custom" → leave the endpoint untouched.
  if (!def || !def.endpoint) return;

  // Only a GM can write a world-scoped setting; bail quietly otherwise.
  if (!game.user?.isGM) return;

  const current = Settings.get("apiEndpoint");
  if (current === def.endpoint) return; // already correct — nothing to do

  try {
    await game.settings.set(MODULE_ID, "apiEndpoint", def.endpoint);
    Logger.info(`Provider preset "${preset}" → endpoint set to ${def.endpoint}`);
    try {
      const label = game.i18n.localize(`ETERNAL_SKALD.settings.providerPreset.choices.${preset}`);
      ui.notifications?.info(
        game.i18n.format("ETERNAL_SKALD.notifications.providerPresetApplied", {
          provider: label,
          endpoint: def.endpoint
        })
      );
    } catch (_) { /* notification is best-effort */ }
  } catch (e) {
    Logger.warn("applyProviderPreset failed:", e?.message || e);
  }
}
