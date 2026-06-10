# The Eternal Skald — Structural Analysis

> **Repository:** https://github.com/papicy/eternal_skald
> **Module ID:** `the-eternal-skald` · **Version:** 0.10.24 (alpha)
> **Target:** Foundry VTT v13–v14 (verified 14) · Recommends system `foundry-ironsworn`
> **Analysis type:** READ-ONLY structural review (no code modified)
> **Analyst note:** All 10 bundled tests pass; `eternal-skald-server.mjs` parses clean in module mode.

An AI-powered storyteller / oracle interpreter / tactical enemy controller for **Ironsworn** & **Ironsworn: Delve** in Foundry VTT, powered by Abacus AI ChatLLM. Players talk to "the Skald" by typing `!` in chat.

---

## Step 1 — Structural Scan

### Repository layout (~17.7k LOC, no build artifacts)
```
module.json                         manifest (id, compat 13–14, esmodules, recommends foundry-ironsworn)
scripts/eternal-skald.js   (8981)   MAIN CLIENT — sole esmodule entry point; all hooks, settings, UI, journaling
scripts/ironsworn-controller.js (1932) foundry-ironsworn rules-engine adapter (read state, trigger moves, tracks)
scripts/ironsworn-data.js   (460)   frozen reference data (oracle tables, move catalog, terminology)
scripts/browser-rag.js      (636)   in-browser semantic memory (transformers.js + IndexedDB)
scripts/eternal-skald-server.mjs (486) OPTIONAL Node --import hook; proxies /skald-api/* to the LLM
styles/eternal-skald.css    (876)   chat-card / link styling
lang/en.json                (234)   i18n strings
test/*.test.mjs (10 files)          plain-node regression tests (no framework)
```

### Entry point file(s)
- **`scripts/eternal-skald.js`** is the **only** `esmodule` in `module.json`. It statically imports the three other client scripts:
  `import { IronswornData } from "./ironsworn-data.js"`, `IronswornController`, `BrowserRAG`.
- **`scripts/eternal-skald-server.mjs`** is a **separate, optional** Node-side hook, NOT loaded by Foundry's module loader — it is injected via `node --import …` at server startup. On hosted Foundry it is simply absent (the client falls back to direct browser→AI calls).

### Hook registration locations
All `Hooks.*` calls live at the bottom of `eternal-skald.js` (lines ~8553–8981):
- `Hooks.once("init")` (8554) — registers `Settings`, the `toggleAiMode` keybinding, and the two command-intercept hooks (`chatMessage`, `preCreateChatMessage`).
- `Hooks.once("ready")` (8652, plus 4 more `once("ready")` blocks) — exposes the public API, logs integration status, posts the welcome card, primes asset/foe compendium indexes, applies link styles, runs the legacy-endpoint migration.
- Standalone `Hooks.on(...)`: `updateCombat`, `canvasReady`, `createChatMessage`, `updateChatMessage`, `renderChatMessageHTML`, `renderChatMessage` (legacy), `deleteJournalEntry`, plus loops binding `create/update/deleteJournalEntry` and `create/update/deleteItem`, `updateActor`, `deleteActor`, `controlToken` for cache invalidation.
- **`ironsworn-controller.js` registers NO hooks** — it is a pure, on-demand adapter library.

### Socket system
- **None.** No `game.socket`, `socketlib`, or `socket.on`/`emit` usage anywhere in the client. There is no cross-client messaging. The only "sockets" in the codebase are Node HTTP sockets inside the optional server hook.
- GM/player coordination is handled by **GM-guard checks** (`game.user.isGM`, `game.users.activeGM.id === game.user.id`), not by message passing.

### Settings system
- Centralized `Settings` object (`eternal-skald.js:172`); `Settings.register()` registers **47** world-scoped settings (all `MODULE_ID`-scoped, GM-only). Groups: AI provider/key/model/endpoint/streaming/connectionMode, Skald intensity, combat & move integration toggles, narration delay, effect application, journaling, RAG (6 settings), entity-linking + custom link styles, context suggestions, contradiction detection, map-vision (autoAnalyzeScenes, visionModel, mapAnalysisQuality, maxMapResolution, imageFormat).
- One hidden persisted setting: `timelineEvents` (campaign timeline store). Keybinding `toggleAiMode` registered separately.

### UI / Application components
- **No custom `Application`/`FormApplication`/`ApplicationV2` subclasses.** All UI is **chat-card based** — HTML strings posted as `ChatMessage`s and styled via `eternal-skald.css` + the `eternal-skald-msg` class.
- Interactive cards (move suggestions, progress-track cards, "What Comes Next") are wired post-render in `renderChatMessageHTML` / `renderChatMessage` via `Integration.wireSuggestionCard()` (button listeners, no framework).
- `EntityLinker` rewrites narration text into clickable inline content-links (NPCs/locations/moves/oracles/tracks/assets).
- Toast notifications via `ui.notifications`. Move rolls delegate to the **foundry-ironsworn system's own** `IronswornPrerollDialog` when present.

### Compendium usage
- **Read-only** compendium access, all in `ironsworn-controller.js`:
  - Foe compendia (`_foePacks`/`_buildFoeIndex`, ~1401–1452): indexes official *Ironsworn Foes* + *Delve Foes* packs for canonical foe ranks.
  - Asset compendia (`_assetPacks`/`_buildAssetIndex`, ~1716–1770): fuzzy asset lookup.
  - Oracle RollTable packs (~1672): rolls system oracle tables when available.
  - Move resolution: `getFoundryMoveByDsId` reads packs and resolves by `flags["foundry-ironsworn"].dsid`.
- Uses `pack.getIndex({fields})`, `pack.getDocument()`, `fromUuid()`. **No compendium writes.** Indexes are built once per session and cached (`clearAssetCache`/`clearEnemyCache`).

### libWrapper usage
- **None.** No libWrapper dependency and no monkey-patching of Foundry core methods on the client. (The only prototype patch is server-side: `eternal-skald-server.mjs` patches `http.Server.prototype.emit` in the Node process — outside Foundry's app code.)

### Build system
- **None.** No `package.json`, bundler, transpiler, or CI workflow. Scripts are hand-authored ES modules served verbatim. Tests are standalone (`node test/<name>.test.mjs`) using a tiny inline `ok/eq` harness and **faithful replicas** of foundry-ironsworn data-model logic (no live Foundry).

---

## Step 2 — Architecture Extraction

### Core module architecture
Layered, single-large-client design:
1. **Entry/Glue layer** (`eternal-skald.js`): settings, hooks, command dispatch, chat helpers, and a dozen feature subsystems implemented as plain object literals (`Client`, `Chat`, `Memory`, `Commands`, `Integration`, `NpcDialogue`, `OracleInterpreter`, `LoreGenerator`, `JournalSystem`, `CombatController`, `SceneContext`, `MapVision`, `EntityLinker`, `RagBridge`, `ContradictionDetector`).
2. **AI transport** (`Client`): builds OpenAI-compatible payloads and reaches the LLM through one of three paths chosen by **Connection Mode** (Auto / Server-hook / Direct): same-origin `/skald-api/chat[-stream]` (server hook) **or** a direct browser→AI `fetch` fallback. Streaming via SSE with buffered fallback.
3. **Rules adapter** (`ironsworn-controller.js`): the *only* place that touches the foundry-ironsworn system — reads character state, triggers moves, manipulates progress tracks, looks up compendia. Everything is **feature-detected** and degrades to no-op when the system is absent.
4. **Reference data** (`ironsworn-data.js`): frozen oracle/move tables (pure, no Foundry deps).
5. **Memory** (`browser-rag.js`): optional, fully client-side RAG (transformers.js model from jsDelivr CDN + IndexedDB vector store `eternal-skald-vectors`).
6. **Optional server proxy** (`eternal-skald-server.mjs`): stateless LLM forwarder; keeps the API key off the browser. No game-state awareness.

### Data flow
```
User types "!…" in chat
  → chatMessage / preCreateChatMessage hook intercepts (return false suppresses normal post)
  → dispatchCommand → Commands.* handler
  → Integration.gatherContext() reads live char state (controller) + scene (SceneContext) + RAG recall (BrowserRAG)
  → buildSystemPrompt(+ ironsworn/journal/foe blocks) assembles the prompt
  → Client.chat() → (server hook | direct) → LLM → reply (streamed)
  → reply parsed: stripDirectivesForDisplay (visible) + parseMetadata([[SKALD_META]]) + parseEffects([[EFFECT:…]]) + parseMoveSuggestion([[MOVE:…]])
  → EntityLinker rewrites names to links → Chat.postSkald()
  → JournalSystem.ingestMetadata() scribes NPCs/locations/etc → BrowserRAG.upsert() embeds them
  → Integration.applyEffects() mutates the sheet via IronswornController (momentum/harm/progress/combat)
```

### Event flow (hooks → handlers → updates)
- **Command path:** `chatMessage`/`preCreateChatMessage` → `tryCommandFromText` → `dispatchCommand` → `Commands.*`. `createChatMessage` is a *last-resort* fallback (executes then deletes the raw line).
- **Roll narration:** `createChatMessage`/`updateChatMessage` → `Integration.onIronswornRoll` → detects an Ironsworn roll card → `_parseRollOutcome` → `_narrateOutcome` (and `_autoCombatFlow`/`_autoJourneyFlow`/`_autoMilestoneFlow`). A `_processedRolls` guard prevents double-narration; `updateChatMessage` re-runs to catch late-resolved rolls.
- **Combat automation:** `updateCombat` → `CombatController.onUpdateCombat` (GM-only).
- **Map scouting:** `canvasReady` → `MapVision.analyzeScene` (GM-only, once per scene, cached on scene flags).
- **Cache upkeep:** journal/item/actor/token CRUD hooks invalidate `EntityLinker` and bump `JournalSystem` generation; `deleteJournalEntry` evicts the RAG vector.

### Client vs GM responsibilities
- **GM-only:** all world-setting writes; combat enemy automation; map scouting (writes scene flags + journal entries); journaling writes; `!end-session`, `!reindex`, `!scout`, `!skald-reset`; welcome card. Guarded by `game.user.isGM` and an `activeGM` tie-break to avoid duplicate execution across multiple GMs.
- **Any client / speaker:** issuing `!` commands; the command dispatcher checks the message author equals the current user (`authorId === game.user.id`) so only the speaker runs it.
- **Per-client (client-scoped) state:** RAG model + IndexedDB vectors live in each browser; "Show Effect Announcements" is per-client.

### External module dependencies
- **`foundry-ironsworn` system (soft / recommended).** Every integration point feature-detects via `game.system.id === "foundry-ironsworn"` and `CONFIG.IRONSWORN`. Absent → Skald is a pure narrator.
- **transformers.js** `@xenova/transformers@2.17.2` from jsDelivr CDN (pinned) + model `Xenova/all-MiniLM-L6-v2` (~90 MB). Optional; RAG degrades to text search if unavailable (CSP/offline).
- **LLM provider** (Abacus AI default; OpenAI/OpenRouter/Google/Custom). User supplies key + model.
- No npm/runtime package dependencies; no other module relationships declared.

---

## Step 3 — Foundry Integration Map

### Hooks used and purpose
| Hook | Timing | Purpose |
|---|---|---|
| `init` (once) | load | Register 47 settings + keybinding + command-intercept hooks |
| `ready` (once ×5) | world ready | Public API; integration diag; welcome card; prime foe/asset indexes; apply link styles; legacy endpoint migration; clear EntityLinker |
| `chatMessage` | pre-persist (v13) | Primary `!`-command intercept (`return false` cancels normal post) |
| `preCreateChatMessage` | pre-persist | Secondary command intercept; skips own flagged messages |
| `createChatMessage` | post-persist | Roll-outcome narration **and** last-resort command fallback (deletes raw line) |
| `updateChatMessage` | on edit | Re-detect late-resolved Ironsworn rolls |
| `renderChatMessageHTML` / `renderChatMessage` | render | Add CSS class; wire interactive suggestion/track buttons (v14 + legacy) |
| `updateCombat` | combat turn | GM enemy-turn automation |
| `canvasReady` | scene view | GM map auto-scout (once/scene, cached) |
| `create/update/deleteJournalEntry` | journal CRUD | Invalidate EntityLinker, bump journal generation, evict RAG vector |
| `create/update/deleteItem`, `update/deleteActor`, `controlToken` | doc CRUD | Invalidate progress-track link index |

### Document types touched
- **ChatMessage** — create (narration/cards), update (re-render), delete (raw command line). Heavy use; own messages tagged with `flags["the-eternal-skald"]`.
- **JournalEntry + Folder** — create/update/delete (the Living Chronicle: NPCs/Locations/Discoveries/World Facts/Story Threads/Session Chronicles under a root folder). Entries flagged `createdBy`; user can set a `locked` flag to protect from reset.
- **Item** (`progress` type, subtype vow/journey/progress/bond/foe) — create/update via controller for vows, journeys, combat tracks; reads `system.current` (ticks), `system.completed`, `system.rank`.
- **Actor** — read stats/meters/debilities; update meters (`adjustMomentum`, `applyHarm`, `_tryUpdateMeter`). One `Actor.create` (NPC conjuring). Uses `actor.update()` — no direct mutation.
- **Scene** — read-only (background image for map vision, pins, visible tokens); writes only its own `flags.mapAnalysis` cache.
- **Compendium packs / RollTable** — read-only (foes, assets, oracles, moves).

### UI extensions
- Chat cards only (no sheets/sidebar tabs/HUD). Interactive buttons wired on render. Inline content-links injected into narration by `EntityLinker`. Keybinding under Configure Controls. Settings menu entries (47). Toasts via `ui.notifications`.

### Chat integrations
- Owns the `!` command space (intercepts before Foundry's slash parser; deliberately avoids `/` because v14 rejects unknown slash commands).
- Posts saga-styled narration, suggestion cards, progress-track status cards, whispered GM advisories.
- Parses inline directive protocol from LLM replies: `[[MOVE:…]]`, `[[EFFECT:…]]`, `[[SKALD_META]]…[[/SKALD_META]]` — all stripped from displayed text.
- Reads foundry-ironsworn roll cards (HTML + `message.rolls`) to narrate outcomes.

### Socket communications
- **None.** No client socket traffic. Multi-GM safety via `activeGM` checks. The optional server hook talks HTTP to the upstream LLM only (no Foundry socket layer).

---

## Step 4 — Risk Analysis

### Fragile systems
1. **foundry-ironsworn internal coupling** (`ironsworn-controller.js`) — depends on undocumented system internals that can change between system releases:
   - `CONFIG.IRONSWORN.applications.IronswornPrerollDialog.showForOfficialMove(dsid)` — the move-roll path.
   - `flags["foundry-ironsworn"].dsid` and the Datasworn ID scheme; replicates the system's own `datasworn2/finding.ts` lookup.
   - `progress` Item schema (`system.subtype/current/completed/rank`, 4 ticks = 1 box). Mitigated by feature detection + manual-roll fallback, but a system schema change is the single biggest breakage vector.
2. **Roll-outcome parsing** (`Integration._parseFromHtml` / `_parseRollOutcome`) — scrapes the system's rendered chat-card HTML and roll objects to detect strong/weak/miss. HTML structure changes silently break narration.
3. **LLM directive protocol** — relies on the model emitting well-formed `[[EFFECT:…]]` / `[[SKALD_META]]` JSON. Malformed output is largely guarded but mechanical effects can be missed or misapplied.
4. **Map vision canvas capture** — `drawImage` taints on CORS-restricted remote images (falls back to sending URL); resolution/format tradeoffs affect cost.

### Overridden core behaviors
- **Chat command interception**: `chatMessage`/`preCreateChatMessage` return `false` to suppress normal posting of `!` lines; `createChatMessage` can **delete** the user's raw message. Aggressive but scoped to `!`-prefixed, non-module messages. Any other module also intercepting chat could conflict.
- No core method patching (no libWrapper) — low override risk overall.

### Performance risks
- **Single 8981-line client module** — large parse/maintenance surface; no code-splitting.
- **EntityLinker** runs regex/text rewriting over narration on every Skald post (63 `replace/RegExp/innerHTML` sites); index rebuilt on journal/item/actor churn. Mitigated by a generation-keyed journal cache, but large worlds (100+ journals, many items) stress it.
- **RAG**: ~90 MB model download (once), WASM/WebGPU embedding + cosine scan over all vectors before each prompt. Bounded by token budget/threshold settings; degrades gracefully.
- **Map vision Thorough mode**: up to 9 LLM vision calls per scene (token-expensive); cached per scene to pay once.

### Compatibility risks across Foundry versions
- `module.json` declares **min 13 / verified 14 / max 14**. Dual hook names (`renderChatMessageHTML` v14 + `renderChatMessage` legacy) show v13/v14 straddling — a v15 chat-render API change would need updating.
- v14 slash-command rejection is the documented reason for `!` prefix; relies on `chatMessage` still firing.
- Relies on `foundry.utils.getProperty`, `fromUuid`, `pack.getIndex/getDocument`, `CONST.KEYBINDING_PRECEDENCE` — stable but version-sensitive.
- Server hook patches `http.Server.prototype.emit`; a future Foundry packaging/runtime change could break interception (already mitigated by the direct-fallback mode).

### Hidden coupling between modules
- **Implicit dependency on foundry-ironsworn compendium pack IDs/labels** (Ironsworn Foes, Delve Foes, asset packs, oracle RollTables) — names/IDs are matched heuristically; third-party foe packs are tolerated but renames break rank lookup.
- **Cross-subsystem coupling inside the single file**: `Integration` ↔ `CombatController` ↔ `IronswornController` ↔ `JournalSystem` ↔ `EntityLinker` ↔ `BrowserRAG` share state through the module's object graph and Foundry flags rather than explicit interfaces.
- **Client/server prompt contract**: the `[[SKALD_META]]`/directive protocol is duplicated knowledge between `eternal-skald.js` (parse) and the system-prompt builders (instruct); they must stay in sync (server is pass-through).
- **In-memory session state** not in flags: `_autoScoutedScenes` (Set), `_processedRolls`, asset/foe/journal caches — reset on reload; safe but invisible coupling to lifecycle.

---

## Step 5 — AI Working Memory Output

```
================================ AI_CONTEXT ================================
ARCHITECTURE SUMMARY (≤15 lines)
- Foundry VTT v13–14 module "the-eternal-skald" v0.10.24 (alpha). AI GM/narrator
  for Ironsworn, powered by Abacus AI ChatLLM. Players type "!..." in chat.
- ONE esmodule entry: scripts/eternal-skald.js (8981 LOC). Imports 3 client files.
- Subsystems are plain object literals in that file: Client(AI transport), Chat,
  Memory, Commands, Integration, NpcDialogue, OracleInterpreter, LoreGenerator,
  JournalSystem, CombatController, SceneContext, MapVision, EntityLinker, RagBridge.
- ironsworn-controller.js (1932): ONLY file touching foundry-ironsworn system.
- ironsworn-data.js: frozen oracle/move tables. browser-rag.js: optional RAG
  (transformers.js CDN + IndexedDB). eternal-skald-server.mjs: optional Node
  --import LLM proxy (stateless; client falls back to direct browser->AI).
- NO sockets, NO libWrapper, NO custom Applications, NO build system/package.json.
- UI = chat cards + inline content-links. State via Settings(47) + document flags.
- Hooks at file bottom (init/ready/chat*/updateCombat/canvasReady/render*/CRUD).
- Everything feature-detects foundry-ironsworn and degrades gracefully to no-op.
- Tests: 10 standalone node *.test.mjs (no framework) — all currently PASS.

KEY SYSTEMS
- AI transport: Client.chat() -> 3 modes (server hook /skald-api, direct fetch, auto) + SSE stream
- Command dispatch: chatMessage/preCreateChatMessage -> dispatchCommand -> Commands.*
- Rules adapter: IronswornController (moves via IronswornPrerollDialog, progress Items, meters)
- Roll narration: Integration.onIronswornRoll (parses system roll cards/HTML)
- Living Chronicle: JournalSystem (NPC/Location/Discovery/Facts/Threads journals + folders)
- Semantic memory: BrowserRAG (IndexedDB "eternal-skald-vectors", MiniLM, cosine recall)
- Map vision: MapVision (canvasReady auto-scout, scene-flag cache, grid sectioning)
- Entity linking: EntityLinker (rewrites narration into clickable links)
- LLM directive protocol: [[MOVE:]] [[EFFECT:]] [[SKALD_META]] (stripped before display)

DO-NOT-TOUCH AREAS (high blast radius, change only with explicit approval)
- ironsworn-controller.js system internals: showForOfficialMove(dsid),
  flags["foundry-ironsworn"].dsid, progress Item schema (current/completed/rank, 4 ticks=1 box).
- Chat-command intercept contract (return false / message.delete) in the 3 chat hooks.
- Client connection-mode logic + server-hook emit() patch (eternal-skald-server.mjs).
- The [[EFFECT]]/[[SKALD_META]]/[[MOVE]] protocol — parsers AND prompt builders must stay in sync.
- Settings keys + flag names (the-eternal-skald.locked, .createdBy, .mapAnalysis) — migration/back-compat.

HIGH-RISK AREAS
- Roll-outcome HTML scraping (Integration._parseFromHtml/_parseRollOutcome) — breaks on system UI change.
- foundry-ironsworn version drift (schema/dialog/compendium pack IDs).
- EntityLinker regex rewriting + index rebuilds on large worlds (perf).
- Map vision Thorough mode (token cost) + CORS canvas taint.
- Foundry v15+ chat-render/hook API changes (currently straddles render hooks).

SAFE MODIFICATION ZONES (low coupling, additive-friendly)
- ironsworn-data.js: extend oracle/move tables (pure data, no Foundry deps).
- lang/en.json: add i18n strings. styles/eternal-skald.css: visual tweaks.
- Add NEW module-scoped settings + NEW Commands.* handlers (follow existing patterns).
- Add NEW [[EFFECT:]] verbs (update BOTH parser and prompt instructions together).
- test/*.test.mjs: add regression tests (standalone node, replica data models).
- New journal entry TYPES via JournalSystem (additive, keep dedup + flags).

GUARDRAILS (per foundry-repository-steward)
- Stability over elegance; minimal assumptions about Foundry/system APIs.
- Preserve graceful degradation when foundry-ironsworn / RAG / server hook absent.
- Use Document.update() (never direct mutation); keep GM-guards + activeGM tie-break.
- No new deps, no socket layer, no libWrapper, no schema changes without approval + version bump.
===========================================================================
```
