# Changelog

All notable changes to **The Eternal Skald** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/). It is
currently in the `0.x` **pre-release (alpha)** stage — see
[Versioning & Release Strategy](README.md#versioning--release-strategy) in the README.
Until `1.0.0`, treat every release as an experimental development build.

> **Note on version numbering:** Some early builds were mistakenly published under `2.x`
> (`v2.0.0`, `v2.0.1`, `v2.2.0`, `v2.2.1`). Those numbers were never appropriate for a
> pre-release project and have been retired. The history below reflects the corrected
> `0.x` lineage; the retired tags map to the equivalent `0.x` entries.

## [0.10.29] — 2026-06-10

### Fixed
- **Duplicate command dispatch (`!scout` ran 3×).** A single `!` command
  could be processed by all three command-interception hooks
  (`chatMessage` → `preCreateChatMessage` → `createChatMessage`). On Foundry
  builds that honour an early `return false` only the first hook fires, but on
  builds that **ignore** the cancellation (documented v14 behaviour) the same
  line reached two or three hooks — and each independently dispatched the
  command. This produced the "identical sequence runs 3×" symptom (e.g.
  `!scout` firing three AI vision passes and posting duplicate cards/notices,
  burning 3× the tokens). `tryCommandFromText()` now carries a short-lived
  cross-hook **dedupe guard**: the first hook to see a given command line
  dispatches it; identical re-dispatches within a 1.5s window are suppressed
  (the raw `!command` echo is still hidden from chat). Purely additive,
  backwards-compatible.

## [0.10.28] — 2026-06-10

### Fixed
- **MapVision 502 error.** Fixed the `MapVision 502 Bad Gateway` failure that
  broke `!scout` (and automatic scene scouting) on hosted/managed Foundry by
  expanding the hosted-mode fallback logic to handle infrastructure errors
  (502/503/504/413). Previously `Client._hookMissing()` treated **only** a
  `404` (Foundry's own not-found page) as "server hook not loaded". When a
  large map-vision request hit the missing `/skald-api` route on hosted
  Foundry, the reverse proxy (openresty) answered with a **502 Bad Gateway**
  HTML page instead of a clean 404 — so the auto-mode fallback to the direct
  browser→AI path was never triggered, the call threw `Skald API error 502`,
  and the proxy's raw HTML error page was injected into the chat card.
  `_hookMissing()` now returns `true` for a null response (network failure)
  and for status codes **404, 413, 502, 503 and 504**, so the Skald
  transparently retries the call directly and scouting works on hosted Foundry.

### Changed
- `Client._hookMissing(response)` now recognises `[404, 413, 502, 503, 504]`
  (plus a null response) as "hook unreachable", with documentation of each
  signature. This is consulted **only** in the `auto`-mode fallback branches of
  `chat()` / `chatStream()`; in `server` mode a genuine upstream error is still
  surfaced via the normal `!response.ok` path, and in `direct` mode it is never
  called — so a real AI/LLM error is never masked. Purely additive, backwards-
  compatible resilience fix.

## [0.10.27] — 2026-06-10

### Fixed
- **Combat-foe track labelling.** Combat (foe) tracks created by the Skald are
  now stored with `system.subtype = "progress"` (plus the existing
  `the-eternal-skald.trackKind = "combat"` flag) instead of the bare `"foe"`
  subtype. The foundry-ironsworn sheet only localizes the *vow / progress /
  connection* subtypes, so a `"foe"` subtype rendered as the raw key
  `IRONSWORN.ITEM.SubtypeFoe` on the track card. Foe tracks now show a proper
  rank/progress label, exactly mirroring how journeys are handled. Combat-track
  detection (`getCombatTracks`) is unchanged — it keys off the `trackKind` flag,
  not the subtype — so nothing else regresses.
- **Legacy repair (idempotent).** `IronswornController.normalizeCombatTrackSubtypes(actor)`
  migrates any combat-flagged tracks already on a sheet from the old `"foe"`
  subtype to `"progress"`. It runs automatically inside the `create_combat`
  stale-cleanup pass and is safe to run repeatedly (it only touches
  combat-flagged tracks whose subtype is still `"foe"`).

### Added
- **Story-arc awareness (Phase 2 — actor flags).** The Skald now remembers the
  focus of the current arc via two lightweight actor flags under
  `flags["the-eternal-skald"]`:
  - `activeVow` / `activeCombat` store the Item id of the focus vow and the
    active fight. New controller methods `getActiveVow` / `setActiveVow`,
    `getActiveCombatFlagTrack` / `setActiveCombat` / `clearActiveCombat`, with
    validation against the live items on the sheet.
  - `getActiveCombat(actor)` now prefers the flagged fight, falling back to the
    previous heuristic; `identifyStoryFocusVow(actor)` returns the flagged vow
    first. `setActiveCombat` is set when a fight begins and `clearActiveCombat`
    when it ends. Marking progress on a track auto-sets the matching flag
    (`_syncActiveFlagForTrack`), so the focus follows the action.
- **AI write directives (Phase 3).** The Skald can now advance and conclude
  tracks straight from the fiction with three directives, each fuzzy-matched to
  the real track on the active sheet, validated, applied safely, audit-logged,
  and whispered to the GM:
  - `[[MARK_COMPLETE:kind:Name]]` — fulfil/end/reach the named track.
  - `[[ADD_PROGRESS:kind:Name:N]]` — add **N boxes** (N×4 ticks) of progress.
  - `[[SET_PROGRESS:kind:Name:N]]` — set progress to **N boxes** absolute
    (clamped 0–10 boxes / 0–40 ticks).
  - `kind` is one of `vow` / `journey` / `combat` / `bond`. Fuzzy matching
    (`findTrackFuzzy`, word-overlap ≥ 0.5) tolerates minor title drift;
    `setProgress` writes absolute box counts and re-syncs the active flag.
    Every write is logged via `_auditWrite` and reported to the GM
    (e.g. `🤖 Skald marked "The Truth of the Star-Fall" complete`).
- **Roll integration (Phase 4).** A **Strong Hit** on *Fulfill Your Vow* /
  *End the Fight* / *Reach Your Destination* now **auto-completes** the matching
  track (resolved via the active flags, with a kind-based fallback), and the
  redundant AI completion effect is filtered out so the track is never
  double-closed. A **weak hit or miss never auto-completes** — it is narrated as
  still in progress with guidance toward the fiction. Move classification lives
  in `_completionMoveKind`; the flow in `_autoCompletionFlow` is woven into
  `_narrateOutcome`.
- **Prompt guidance.** `buildIronswornPromptBlock()` gained a
  **PROGRESS-TRACK WRITE DIRECTIVES** section teaching the directive syntax and
  the rules around it (use exact track names; only mark complete at 10/10 on a
  Strong Hit or a clear narrative conclusion; never on a weak hit or miss).

### Verified
- New `test/progress-track-writes.test.mjs` (55 assertions) covering the
  combat-foe label fix and legacy migration, the Phase 2 active-flag accessors
  and auto-sync, `findTrackFuzzy` (exact / substring / fuzzy / kind filter),
  `setProgress` (absolute boxes, clamping, flag sync), the write-directive
  parser (`MARK_COMPLETE` / `ADD_PROGRESS` / `SET_PROGRESS`, kind validation),
  and Phase 4 completion-move classification. All 13 test suites pass with no
  regressions.

## [0.10.26] — 2026-06-10

### Added
- **Progress-track context enhancement (Phase 1 — read-only).** The live game
  state the Skald sees now labels every progress track with its fullness and
  flags the active fight and the focus vow, so the AI can tell at a glance
  whether a track may be concluded:
  - `IronswornController.fullnessLabel(boxes, completed, kind)` renders
    `"7/10 boxes - NOT YET FULL"` vs `"10/10 boxes - ✅ READY TO FULFILL/END/REACH"`.
  - `IronswornController.getActiveCombat(actor)` surfaces the single active foe
    track (thin, clearly-named wrapper over `getActiveCombatTrack`).
  - `IronswornController.identifyStoryFocusVow(actor)` infers which open vow the
    current narrative is about — last-rolled vow on this actor first, newest
    open vow as fallback.
  - `describeCharacter()` now emits a grouped **PROGRESS TRACKS** block with an
    `⚔️ ACTIVE COMBAT` line, `VOWS:` / `JOURNEYS:` groups, a `[STORY FOCUS]`
    marker, and per-track FULL / NOT YET FULL labels (exact-title reference
    lines retained for directive targeting).
- **AI prompt hardening.** `buildIronswornPromptBlock()` now states a hard rule
  that the Skald must NOT offer or self-complete a track (Fulfill Your Vow /
  End the Fight / Reach Your Destination) until it is 10/10 — the main cause of
  premature conclusions — with an explicit player-override exception, plus
  multi-track guidance (act on the `[STORY FOCUS]` vow, one active combat only).

### Verified
- New `test/progress-track-context.test.mjs` (38 assertions) covering fullness
  labels, multi-vow reads, active-combat detection, story-focus resolution
  (last-rolled / fallback / cross-actor / completed-ignored), the labelled
  `describeCharacter` block, edge cases, and a read-only (no-mutation) guard.
  All 12 test suites pass with no regressions. **Phase 1 is read-only — no
  writes to actor data.**

## [0.10.24] — 2026-06-09

### Added
- **Map Analysis Quality setting (grid sectioning).** A new world setting
  — **Fast / Balanced / Thorough** (default *Balanced*) — controls how
  hard map vision looks. *Fast* runs a single whole-map pass; *Balanced*
  and *Thorough* additionally split larger maps into a **grid of
  overlapping sections** (2×2 or up to 3×3) and read each section closely,
  dramatically improving recovery of **small text labels, place names, and
  tiny symbols**.
  - **`MapVision._planGrid(w, h, quality)`** decides the grid (1×1 / 2×2 /
    3×3) from image size and quality; **`MapVision._gridRegions()`**
    computes section crop rectangles with **~8% overlap padding** and
    human-readable compass labels (e.g. *north-west*).
  - **`MapVision._analyzeMapInSections()`** runs the whole-map overview
    pass plus one pass per section, and **`MapVision._mergeAnalyses()`**
    merges them — de-duplicating POIs by name, keeping the **longer
    description** and the **higher confidence**, and unioning labels.
- **Max Map Resolution setting.** Choose the longest-edge the captured map
  is downscaled to before sending: **2048 / 3072 / 4096 / Original**
  (default **4096&nbsp;px**, up from the fixed 2048&nbsp;px in v0.10.23).
  Higher resolution keeps small labels legible at the cost of more tokens.
- **Image Format setting.** Choose the capture encoding: **Auto**
  (lossless **PNG**), **PNG**, or **JPEG** (default *Auto*). PNG preserves
  tiny text and thin lines that JPEG compression used to smear.
- **Per-POI confidence and text labels.** The vision prompt now requests a
  **`confidence`** rating and a **`labels[]`** array (verbatim text read
  off the map) for each point of interest. Low-confidence finds are kept
  but **flagged** in the scouting card and journal note rather than
  silently dropped, and any legible labels are surfaced.
- **Strong/weak model guidance.** `Client._visionModelTier()` classifies
  the configured vision model as **strong / weak / unknown**. The Vision
  Model picker now **★-marks the strongest map/OCR readers** (gpt-4o,
  claude-3-5-sonnet, gemini-2.5-pro/flash, gemini-3-flash-preview) and the
  Skald **whispers the GM a heads-up** when a weak model (e.g.
  `gpt-4o-mini`) is used — and asks for confirmation on on-demand
  `!scout`. Added `gemini-2.0-flash` as an explicit choice.

### Changed
- **Capture defaults raised for accuracy.** `MapVision._captureSceneImage()`
  now downscales to the **Max Map Resolution** (default 4096&nbsp;px) and
  encodes as **lossless PNG** by default instead of JPEG q0.85.
  `MapVision._downscaleToDataUrl()` was reworked to take an **options
  object** (`{ maxDim, mime, quality, region }`) and can crop to a
  **region** for section analysis via `drawImage()` source-rect cropping.
- **Cartographer prompt rewritten.** `MapVision.VISION_PROMPT` now frames
  the model as a **fantasy cartographer** and explicitly directs it to
  hunt for **text labels, route/road lines, faint paths, structures, and
  terrain**, and to report **confidence** — while still returning **strict
  JSON**. Section passes inject compass guidance via
  `_buildVisionMessages(imageUrl, sceneName, sectionLabel)`.
- **Richer cache & cards.** Stored analysis now records **quality**,
  **section count**, and per-POI **labels** & **confidence**; the scouting
  card and journal locations display labels and an `[uncertain]` flag for
  low-confidence finds.
- All affected JSDoc and the in-file version header bumped to
  **v0.10.24**.

### Tests
- Extended `test/map-vision.test.mjs` with coverage for
  `_visionModelTier`, `_planGrid`, `_gridRegions` (overlap/labels),
  `_mergeAnalyses` (dedup/confidence), the new `_parseAnalysis` fields
  (`labels`, `confidence`), and the rewritten `VISION_PROMPT`. Full suite
  green (417 assertions).

## [0.10.23] — 2026-06-09

### Added
- **The Skald *sees* your map (vision / image analysis).** Where v0.10.22
  read the scene's *metadata* (names, pins, tokens), the Skald can now
  **look at the actual background map image** and describe what is on it.
  A new **`MapVision`** subsystem captures the scene's background image,
  sends it to a **vision-capable LLM**, and turns the reply into a short
  scouting report plus a set of **points of interest (POIs)**.
  - **`MapVision._captureSceneImage()`** — reads only the scene's
    **background image** (`scene.background.src`, or the legacy
    `scene.img`), loads it onto an off-screen canvas, **downscales** it so
    the longest edge is at most **2048&nbsp;px**, and re-encodes it as a
    **JPEG at quality 0.85** as a base64 `data:` URL. Handles `data:`
    URLs, absolute remote URLs, and site-relative paths (resolved against
    the page origin). If the image taints the canvas (a remote host with
    no CORS), it gracefully **falls back to sending the image URL** so a
    vision model that can fetch URLs still works.
  - **Vision LLM integration.** `MapVision._buildVisionMessages()` builds
    a proper **multimodal** chat payload (an OpenAI-style `content` array
    with a `text` part and an `image_url` part) and sends it through the
    existing `Client.chat()` path. A new `Client._modelSupportsVision()`
    heuristic detects whether the configured model can accept images and
    **degrades gracefully** (whispers the GM and does nothing) when it
    cannot.
  - **Automatic scouting on scene load.** A new **`canvasReady`** hook
    auto-analyses a freshly-viewed scene **once** (per-scene, cached),
    GM-side only, when **Auto-Analyze Scenes** is enabled and the scene
    has a background image. Results are cached so the same scene is never
    re-billed on every load.
  - **`!scout` command** (aliases **`!survey`**, **`!analyze-map`**) —
    GM-only; **forces a fresh re-analysis** of the current scene, posts a
    public *Skald* scouting card, and whispers the GM a summary.
  - **POIs become journal locations.** Discovered points of interest are
    auto-scribed as **location** entries in the Living Chronicle (via
    `JournalSystem.ingestMetadata(...)`), de-duplicated against existing
    entries, and the GM gets a whispered summary of what was added.
  - **Caching.** The full analysis (timestamp, model used, and POI list)
    is stored on `scene.flags["the-eternal-skald"].mapAnalysis`, so it
    survives reloads and is reused until you force a re-`!scout`.

### Settings
- **Auto-Analyze Scenes** (`autoAnalyzeScenes`, world-scoped, default
  **on**) — toggles the automatic `canvasReady` scouting.
- **Vision Model** (`visionModel`, world-scoped, default **Inherit**) —
  choose which model handles image analysis. *Inherit* reuses your main
  model; or pick a specific vision-capable model. See the README for the
  list of supported models and their relative token costs.

### Notes
- **Read-only base map only.** Vision analyses **only the scene's
  background image** — never tokens, fog of war, drawings, walls, or
  hidden GM content — so player secrets and table state are never sent to
  the model. The scene itself is never modified.
- **Token-efficient & graceful.** Images are downscaled and JPEG-
  compressed before sending; analysis is cached per-scene; and every step
  degrades quietly (no scene, no background, non-vision model, network
  failure) without ever breaking play.

### Verified
- New `test/map-vision.test.mjs` extracts and exercises the real
  `MapVision` helpers and `Client._modelSupportsVision()` against mock
  Foundry/canvas/Image globals: background-source resolution (modern +
  legacy), absolute/relative/data URL handling, downscale-dimension math,
  JPEG quality, multimodal message shape, tolerant JSON parsing (fenced /
  prose-wrapped / deduped / capped), POI→location mapping, cache
  read/write, and the vision-model heuristic. **126 assertions pass**; the
  **full suite is green at 344 assertions across 10 files**.

## [0.10.22] — 2026-06-09

### Added
- **Map / scene awareness (read-only).** A new
  `Integration._gatherSceneContext()` reads the **active scene**
  (`game.scenes.active`, falling back to the viewed `canvas.scene`) and
  builds a concise context block:
  - **CURRENT SCENE** — the scene's `navName` (or `name`).
  - **Visible Locations** — names taken from the scene's **map notes /
    journal pins** (`scene.notes`), each resolved to its linked
    `JournalEntry` name (a note's own `text` label overrides the entry
    name). De-duplicated and capped at 12 with a `+N more` suffix.
  - **Notable Tokens** — names of placed tokens, **excluding hidden
    (GM-only) tokens** (`token.hidden`) so secrets never leak into the
    prompt. De-duplicated and capped the same way.
  `gatherContext()` folds this block into the live game state sent to the
  AI (available both in and out of combat).
- **Prompt guidance.** The system prompt now tells the Skald it can *see
  the map* and may reference the listed `CURRENT SCENE` / `Visible
  Locations` / `Notable Tokens` by name — especially when suggesting a
  destination for a journey or vow — while keeping it natural: never force
  a location, and never invent a pin that wasn't listed.

### Notes
- **Read-only by design** — the scene is never modified. The reader is
  fully defensive: it returns nothing when no scene is active (graceful
  degradation) and is token-efficient (short lines, hard caps).

### Verified
- New `test/scene-context.test.mjs` extracts the real
  `_gatherSceneContext()` body and runs it against mock Foundry globals:
  graceful no-scene degradation, `navName` precedence, journal-pin →
  linked-entry resolution, custom-label override, **hidden-token
  exclusion**, de-duplication, the 12-item cap, the exact 3-line layout,
  the `canvas.scene` fallback, plus structural guards over
  `gatherContext()` and the system prompt. All 24 assertions pass; the
  full suite (218 assertions across 9 files) is green.

## [0.10.21] — 2026-06-09

### Fixed
- **"Reach a Milestone" no longer marks the vow twice.** Triggering the
  milestone move (by clicking its inline link in the narration, or from the
  move list) ran the deterministic mechanics **once in `triggerMove()`** — which
  marks progress on the newest open vow by its rank — and then scheduled an
  outcome narration that ran `_autoMilestoneFlow()` → `_executeMilestone()`
  **a second time**, advancing the same vow by another full rank's worth of
  ticks. The track therefore jumped by *2× rank* (or appeared inconsistent with
  the narrated result). The narration step is now told the mechanics were
  already applied (`_narrateOutcome(…, { mechanicsApplied: true, autoSummary })`),
  so it reuses the single, already-computed result instead of re-marking.

### Changed
- `_narrateOutcome()` accepts an `opts` argument (`mechanicsApplied`,
  `autoSummary`) so callers that have already applied a move's mechanics can
  hand the summary straight to the narration prompt and skip the auto-flows.
- `IronswornController._executeMilestone()` now logs the resolved vow, its rank
  and resulting tick/box totals (debug channel) and derives `boxes`/`ticks`
  defensively from the update result, making future "0 progress" reports easy
  to diagnose.

### Verified
- New `test/milestone.test.mjs` exercises the full chain
  `triggerMove → _isMilestoneMove → _executeMilestone → markProgressByRank →
  markProgress` against a faithful replica of the foundry-ironsworn
  `ProgressModel` schema: recognises the move by name **and** by classic/
  Starforged Datasworn id, marks the newest open vow by its rank, works on
  hand-sworn (sheet-made) vows, and returns a clear error when no vow is open.
  All 18 assertions pass; the full suite (192 assertions across 8 files) is green.

## [0.10.20] — 2026-06-09

### Added
- **"Reach a Milestone" now marks progress automatically.** The milestone move
  has no dice — it simply marks progress on your active vow by its rank. The
  controller gained `_isMilestoneMove()` / `_executeMilestone()`, `triggerMove()`
  intercepts the move before the "no rollable stat" fallback, and a matching
  `_autoMilestoneFlow()` lets the AI enact it from narration. (Superseded by the
  double-mark fix in 0.10.21.)

## [0.10.19] — 2026-06-09

### Changed
- **Removed the last escaped backticks from the AI-prompt templates.** The
  foe-prompt template literals quoted the keyword *unique* as `` \`unique\` ``
  (escaped backticks inside a template literal). This is valid JavaScript, but it
  is exactly the fragile detail that kept being blamed for the recurring line-1342
  `missing ) after argument list` error. The word is now written with plain single
  quotes (`'unique'`), so **there are zero escaped backticks left in the file** and
  the template literal can never be mis-scanned as unterminated. No functional
  change to the prompt's meaning.

### Verified
- The current `scripts/eternal-skald.js` parses **cleanly in five independent
  parsers**: Node/V8 in non-strict *script* mode, Node/V8 in strict *module* mode,
  **Acorn** (`sourceType: 'module'`), **Babel** (`sourceType: 'module'`), and a
  **real Chrome ES-module load** — in the browser test the module parses and
  *executes*, failing only later at runtime on the Foundry-only `Hooks` global,
  which proves there is **no parse/syntax error**. All unit tests pass.
- **If you still see `missing ) after argument list` at line 1342, you are loading
  a cached copy of an old (pre-v0.10.17) script**, not this code. Fully update the
  module so Foundry re-downloads the files, then hard-refresh (`Ctrl+Shift+R` /
  `Cmd+Shift+R`) or restart Foundry to flush the cached module.

## [0.10.18] — 2026-06-09

### Changed
- **Republished to clear stale browser/Foundry caches.** Some users continued to
  see the `missing ) after argument list` syntax error (reported around **line
  1342**) *after* updating to v0.10.17. The committed script is verified clean —
  it parses without error in strict **ES-module** mode (the same mode Foundry
  uses), the previously-stray backticks (`` \`unique\` ``) are confirmed escaped,
  and all unit tests pass — so the lingering error is a **cached copy of the old
  script** in the browser/Foundry client, not a remaining code defect. This
  release republishes the verified script and bumps the version so Foundry
  re-downloads it; it also syncs the stale `v0.6.0` header comment in
  `eternal-skald.js` to the real version. **No functional change** from v0.10.17.
  If the error persists after updating, do a hard refresh (`Ctrl+Shift+R` /
  `Cmd+Shift+R`) or restart Foundry to flush the cached module.

## [0.10.17] — 2026-06-09

### Fixed
- **Module failed to load — `missing ) after argument list` syntax error.** Three
  un-escaped backtick characters (around the word `unique`) inside the
  Ironsworn effect-prompt template literal — introduced with the v0.10.14 foe
  catalogue — prematurely terminated the template string. The file is loaded by
  Foundry as an ES module (always strict mode), where this is a hard parse error
  that broke the entire module. (It went unnoticed because `node --check` parses
  `.js` in non-strict *script* mode, which happened to tolerate the stray
  backticks.) The backticks are now escaped (`` \`unique\` ``), and all scripts
  are validated in strict **module** mode.

## [0.10.16] — 2026-06-09

### Added
- **`!skald-reset` — a GM-only "clean slate" for a new campaign** (alias
  `!skald-wipe`). Wipes the Skald's chronicle in one command so a fresh saga can
  begin without dragging the old one along. After a **confirmation dialog**
  (DialogV2 with a classic `Dialog` fallback) that summarises what will be
  erased, it:
  - **deletes every *unlocked* Skald-scribed journal entry** (batched via
    `JournalEntry.deleteDocuments`, with a per-entry fallback),
  - **wipes the semantic-memory (RAG) vector store** + query cache
    (`BrowserRAG.clear()`),
  - **resets all in-memory conversation buffers** (`Memory.reset()`), and
  - **empties the campaign timeline** (`JournalSystem.clearTimeline()`).
  It then whispers a **GM-only report** listing the counts of everything that
  was cleared (and how many entries were preserved).
- **Entry locking for reset safety.** Any chronicle entry whose
  `the-eternal-skald.locked` flag is `true` is **preserved** by `!skald-reset`
  and reported separately.
- **Macro-friendly bypass.** Passing `force` / `confirm` / `yes`
  (e.g. `!skald-reset force`) skips the confirmation dialog.

### Changed
- The `!skald-help` card and the README command reference now document
  `!skald-reset` / `!skald-wipe`.

### Notes
- **Safety:** `!skald-reset` is **GM-only** and only ever deletes journals the
  Skald itself scribed (entries flagged `createdBy` `ai`/`manual`). Journals you
  created yourself are never touched.

## [0.10.15] — 2026-06-09

### Fixed
- **"Undertake a Journey" never had a track to advance.** Rolling *Undertake a
  Journey* without an open journey track meant *Reach Your Destination* later
  failed with **"No open journey track to roll 'Reach Your Destination'
  against."** The post-roll narration path now runs a deterministic
  **`_autoJourneyFlow`**: when the resolved move is *Undertake a Journey* and no
  journey track is open, it **auto-creates one** (named from the player's
  inferred destination, e.g. *"Journey to the Frozen Keep"*, else a clean
  generic title) and, on a strong/weak hit, **marks progress on it by its
  rank** — mirroring the existing `_autoCombatFlow` for fights.

### Added
- **`mark_progress` effect directive (advance a track by its exact title).**
  `[[EFFECT: mark_progress "<Vow/Journey Title>" [<+N | rank>]]]` advances a
  specific named track resolved against the real sheet items (`findTrack`).
  Quoted titles are supported; with no tick/rank suffix it marks by the track's
  rank. It is an alias of the existing `progress` effect, made title-first for
  reliable narrative matching.
- **Narrative progress + completion without a roll.** `progress` is now part of
  the track-lifecycle effect set applied by the conversational channels
  (`!skald` / `!scene` / `!combat`), so a vow/journey can be advanced *and*
  completed (`complete_vow` / `complete_journey`) directly from narration —
  no progress roll required first.
- **Open vows & journeys listed by title for the AI.** `describeCharacter()`
  now adds explicit *"Open vows"* and *"Open journeys"* lines (by exact title)
  to the live game state, and the prompt instructs the Skald to reference open
  tracks by their exact titles — never a guessed name or a move name.

### Changed
- The redundant-effect filter now also drops any AI-emitted `progress` /
  `create_journey` directives for the *Undertake a Journey* move (handled
  deterministically by `_autoJourneyFlow`), preventing duplicate journey tracks
  or double-marked progress. The prompt documents that journeys are automated
  for that move, just like combat.

## [0.10.14] — 2026-06-09

### Added
- **Official foe catalogue embedded in the AI prompt.** The names (and canonical
  ranks) of every foe in the official foundry-ironsworn foe compendia —
  `foundry-ironsworn.ironswornfoes` (*Ironsworn Foes*) and
  `foundry-ironsworn.ironsworndelvefoes` (*Ironsworn: Delve Foes*) — are now
  loaded, cached and injected into the system prompt (grouped by rank) whenever
  the Skald can create combat tracks. The AI is instructed to choose **regular
  foes from this list only**, copying the name *verbatim* so the combat track
  gets the rulebook rank automatically.
- **`unique` marker for important narrative foes.** A named boss or unique
  antagonist that the story is built around — and that is *not* in the
  compendia — may still be custom-created. The Skald gives it an explicit rank
  and appends the keyword `unique` (also accepts `boss` / `narrative` /
  `custom`), e.g. `[[EFFECT: create_combat Hrafn the Oathbreaker formidable unique]]`.
  The parser records this as an `important` flag so such foes are treated as
  intentional and never warned about.
- **GM-only "not an official foe" advisory.** When a *regular* (non-`unique`)
  foe turns out not to be in the official foe compendia, the Skald whispers a
  gentle GM-only note suggesting the closest official foe (when one is found).
  Important/unique foes are exempt. Advisory-only — it never blocks combat.
- **Foe-index priming on world `ready`.** The foe compendia are indexed once the
  world is ready (`IronswornController._buildFoeIndex`) so the synchronous prompt
  builder has the catalogue available from the first combat narration.
- New controller members: `FOE_COMPENDIUM_PACK_IDS`, `_isOfficialFoePackId()`,
  `getCompendiumFoeNames()` (sync, cached, official-packs-only, deduped, sorted)
  and `isOfficialCompendiumFoe()` (async).

### Changed
- **`create_combat` directive docs** (both the full effects block and the
  conversational track-effects block) now tell the AI to draw regular foes from
  the catalogue verbatim with no rank, and reserve explicit-rank + `unique`
  creation for genuine story-defining antagonists.

## [0.10.13] — 2026-06-09

### Fixed
- **Vow / progress-track cards now read straight from the character sheet —
  the single source of truth — fixing a phantom-vow bug.** The Skald's vow card
  could display a track that had nothing to do with your real vow: a track
  literally named *"Vow"*, rank `1`, `0/10` boxes (`0/40` ticks), marked
  *"✓ This vow is complete."*, while the actual sheet held an open vow
  (*"The Truth of the Star-Fall"*, formidable, `3/10` boxes). The card is now
  bound to the live foundry-ironsworn `progress` Item on the actor and read
  fresh every time it is shown:
  - Progress comes from `system.current` (ticks), boxes = `ticks ÷ 4`.
  - Completion comes from `system.completed`.
  - Marking progress writes back to the Item (`system.current`) so the sheet
    updates immediately.
- **Clicking the bare word *"vow"* (or "journey"/"bond"/…) now opens your
  ACTUAL current track**, not a phantom. A new display resolver
  (`IronswornController.resolveDisplayTrack`) treats generic nouns as a pointer
  at the *kind* of track and resolves them to the character's newest **open**
  track of that kind, preferring open over completed and exact names over
  substrings — all read directly from `actor.items`.

### Changed
- **Generic track nouns are no longer turned into clickable links.** The entity
  linker used to index a track whose name was a common noun like *"vow"*,
  turning every mention of the word into a phantom link. Such names are now
  skipped (a real, player-chosen vow name like *"The Truth of the Star-Fall"*
  is still linked normally), removing a parallel/stale path that could desync
  from the sheet.

## [0.10.12] — 2026-06-09

### Fixed
- **The Skald now works on hosted/managed Foundry where the server hook cannot
  be loaded.** Previously, every AI call went *only* through the same-origin
  server hook (`POST /skald-api/chat` and `/skald-api/chat-stream`), which is
  installed by starting Foundry with `node --import …/eternal-skald-server.mjs`.
  On hosted platforms (e.g. *Foundry VTT on Abacus*) users can't add that launch
  flag, so the hook never loads and every request hit Foundry's own **404 (Not
  Found)** page — surfacing in the browser console as
  `…/skald-api/chat … 404 (Not Found)` and leaving the Skald unable to reach the
  AI. The client now **automatically falls back to calling the AI endpoint
  directly from the browser** when the hook isn't present.

### Added
- **Direct browser→AI path.** `Client._directChat()` and
  `Client._directChatStream()` send the raw OpenAI-style chat-completions body
  straight to the configured `apiEndpoint` with an `Authorization: Bearer
  <apiKey>` header. The default Abacus AI endpoint
  (`https://routellm.abacus.ai/v1/chat/completions`) returns permissive CORS
  headers, so this works from the browser with no setup.
- **`connectionMode` world setting** (GM-only): `auto` (default — try the
  server hook, fall back to direct on a 404/network error), `server` (hook
  only; shows the `--import` setup error if missing), and `direct` (always call
  the AI directly from the browser). A one-time GM notice is posted the first
  time `auto` falls back to direct mode.

### Changed
- The streaming SSE reader was extracted into a shared
  `Client._consumeStreamingResponse()` helper so the server-hook and direct
  streaming paths use one implementation.
- `chat()` and `chatStream()` now branch on `connectionMode`; their
  hook-missing errors additionally point users at the new *Direct* mode. No
  behavioural change for installs that already run the server hook.

## [0.10.11] — 2026-06-09

### Fixed
- **Fulfilling a vow / reaching a destination now closes the CORRECT track.**
  After a *Fulfill Your Vow* or *Reach Your Destination* progress roll, the
  post-roll narration's `complete_vow` / `complete_journey` directive could
  fail with «Track "Reach Your Destination" not found» — because the completion
  logic searched for a track named after the **move** instead of the player's
  real, named vow/journey. The controller now records which track a progress
  move actually rolled against (`_lastProgressTrack`) and the completion path
  resolves the correct track from that context.

### Changed
- `IronswornController.rollProgressMove()` now records the resolved track as
  `_lastProgressTrack` ({ id, name, kind, actorId, ts }) before rolling.
- New `IronswornController.resolveCompletionTrack(actor, ref, hintKind)` layered
  resolution: an exact id/name match wins (but a progress-MOVE name is never
  treated as a track); otherwise the last-rolled track (still open, right kind);
  otherwise the newest open track of the implied kind (vow / journey).
- New `IronswornController.completeTrackSmart(actor, ref, hintKind)` completes
  the resolved track and clears the last-progress pointer when it closes it.
  The `complete_track` effect now routes through this instead of the literal
  `completeTrack(name)` lookup.
- `complete_*` directives now carry the implied `trackKind` (vow / journey) and
  the track name is **optional** — an empty name (e.g. `[[EFFECT: complete_vow]]`)
  falls back to the active track instead of dropping the directive.
- Prompt directive docs updated: use the track's EXACT name when known, you MAY
  omit it when unsure, and NEVER put the move name in a `complete_*` directive.

### Tests
- Added `test/vow-completion.test.mjs` (15 assertions) covering move-name
  directives, empty-name fallback, last-rolled preference, kind preference,
  exact-name priority, and the recording in `rollProgressMove`.

## [0.10.10] — 2026-06-09

### Changed
- **Move suggestions are now woven directly into the Skald's narration prose
  instead of being posted as separate cards.** Previously, suggested moves
  arrived as standalone chat bubbles — a pre-roll *A Move Beckons* / "The path
  forward:" line and a post-roll *What Comes Next* / "The saga calls you
  onward —" line. The Skald now names the fitting move **inside** its narration
  sentence, where the existing entity-linker renders it as a subtle, clickable
  inline link. This applies to **both** ordinary narration (`!skald`, `!scene`,
  `!combat`) and the **post-roll outcome narration** after a move resolves.
- The system prompt and the per-command tasks were rewritten to instruct the
  AI to mention moves verbatim within the prose (so the link forms) and to
  **never** emit `[[MOVE:…]]` directives, bracketed tags, bullet lists, or a
  "suggested move" footer.

### Removed
- The separate move-suggestion card UI — `postSuggestionCard`,
  `postFollowupSuggestionCard`, and the `_inlineMoveLink` helper — has been
  removed entirely, along with their call sites in the streaming, buffered,
  and post-roll (`_narrateOutcome`) paths.

### Fixed
- Clicking an inline move link in **any** narration (including post-roll
  outcome narration) rolls through the progress-aware
  `IronswornController.triggerMove` path, so progress moves like *Reach Your
  Destination* / *Fulfill Your Vow* roll against their track rather than
  dead-ending. Any stray `[[MOVE:…]]` directive the model still emits is
  stripped from the displayed narration so it never leaks into chat.

## [0.10.9] — 2026-06-09

### Fixed
- **Progress-track creation now matches the real `foundry-ironsworn` data
  model exactly.** The integration was re-derived by studying the live system
  source (`src/module/item/subtypes/progress.ts` and the system's own creators
  `progress-controls.vue` / `foe-sheet.vue`). Every track — vow, journey, bond
  and combat foe — is a single Item **type** `progress`, distinguished only by
  `system.subtype`. Tracks are now created with:
  - `type: "progress"` (always — there is no separate `vow`/`bond`/`foe` *type*),
  - the correct `system.subtype` (`vow`, `progress`, `bond`, or `foe`),
  - a numeric `system.rank` (ChallengeRank 1–5),
  - `system.current` ticks (0–40; 4 ticks = 1 box) and `system.hasTrack: true`,
  - a high `sort` value, mirroring the system's own creators.
- **Removed a stray, non-schema `notes` field** that was being written into
  `system` on creation. It is not part of `ProgressModel` (the schema's only
  notes-like field is `description`, an HTMLField), so it was silently dropped
  during data-model cleaning — now only the valid `description` is written.
- **Combat foes now use the system's real `foe` subtype** (exactly what the
  foe sheet creates) instead of a generic `progress` subtype, so they are
  labelled and grouped correctly on the character sheet.

### Added
- **The Skald now recognises tracks you create by hand on the character
  sheet.** Vows (`subtype: "vow"`), journeys (open `progress`-subtype tracks)
  and foes (`subtype: "foe"`) made directly in `foundry-ironsworn` — without
  any Skald flag — are now detected, so marking progress, completing them, and
  the *Fulfill Your Vow* / *Reach Your Destination* progress rolls work on them
  too (the "vice versa" direction of the integration).
- **A faithful integration test** (`test/track-integration.test.mjs`) that
  replicates the real `ProgressModel` schema (field set, `ChallengeRank` cast,
  `ProgressTicksField` clamping) and asserts both that created track data is
  schema-valid and that sheet-made tracks are detected (31 assertions).

## [0.10.8] — 2026-06-09

### Changed
- **Move suggestions are once again inline clickable links inside the
  narration.** The separate *A Move Beckons* (pre-roll) and *What Comes Next*
  (follow-up) button-cards have been reverted in favour of the original style:
  the suggested move(s) are woven directly into the chat text as one-click
  entity links (e.g. *"The path forward: Face Danger."*). This restores the
  cleaner, less intrusive presentation while keeping every suggestion validated
  against the real Ironsworn / Starforged move catalogue.
- **Progress-track ranks are now stored as proper numeric challenge ranks.**
  `createProgressTrack` writes `system.rank` as the numeric value the
  `foundry-ironsworn` `ChallengeRank` field expects (e.g. *formidable* → `3`)
  rather than relying on string coercion, making vow / journey / combat track
  creation more robust.

### Fixed
- **Inline move links now roll progress moves correctly.** Clicking an inline
  move suggestion previously routed through the official move dialog, which
  dead-ended progress moves — so *Reach Your Destination* (and other progress
  moves) failed with *"Could not trigger … (no dialog and no rollable stat)."*
  Inline links now route through the same progress-aware trigger the cards used,
  so progress moves roll the active track's progress score against the challenge
  dice as intended.
- **Journey-track lookup now finds legacy and hand-made journeys.** The "newest
  open journey" resolver only matched tracks carrying the Skald's own journey
  flag, missing journeys created before that flag existed (or made by hand).
  It now falls back to any open `progress`-subtype track that is not a vow,
  bond or combat track, so older journeys resolve for *Reach Your Destination*.
- **Vow / journey creation no longer fails silently.** When the Skald is asked
  to create a vow or journey but there is no active character — or the
  `foundry-ironsworn` data model rejects the item — it now whispers a GM-only
  advisory explaining exactly why (e.g. *"no active character — select a token
  or assign a character"*) instead of doing nothing with no feedback.

## [0.10.7] — 2026-06-09

### Fixed
- **Journey tracks now use the standard Ironsworn progress-track structure and
  label.** Journeys were stored with a non-standard `subtype` of `"journey"`,
  which the `foundry-ironsworn` sheet cannot localize — so the track's side
  label rendered as the raw key `IRONSWORN.ITEM.SUBTYPEJOURNEY`. A journey is
  simply a progress track, so it is now stored with the stock `"progress"`
  subtype (correct **PROGRESS** label, standard mechanics). The Skald still
  recognizes which tracks are journeys via its own internal flag, so journey
  flavour and completion still work.
- **"Reach Your Destination" and "Fulfill Your Vow" are now rolled correctly as
  PROGRESS rolls.** These are progress moves — they roll the track's progress
  score (its filled boxes) against the challenge dice, not an action die + a
  stat. Previously the Skald tried to roll them like an ordinary stat move,
  which dead-ended with *"Could not trigger … (no dialog and no rollable
  stat)."* The module now routes them through the system's own progress-roll
  dialog against the matching open journey/vow track (and reports a clear,
  actionable message if no such track exists yet).
- **Vow / journey completion now flows end-to-end.** Because the completion
  move used to fail to roll, the Skald never narrated the resolution and so
  never emitted the `complete_vow` / `complete_journey` directive — the tracks
  were never marked complete on the sheet. With the progress roll fixed, a
  successful "Reach Your Destination" / "Fulfill Your Vow" now resolves, the
  Skald narrates it, and the track is marked complete (via the existing
  `completeTrack` path, which sets `system.completed`).

### Changed
- The AI prompt now explains that "Reach Your Destination" (finish a journey)
  and "Fulfill Your Vow" (finish a vow) are progress rolls against a track —
  distinct from "Undertake a Journey" (a Wits roll to *advance* a journey) —
  and must never be treated as stat moves or invented with a fabricated stat.

## [0.10.6] — 2026-06-09

### Fixed
- **Journeys (and other progress tracks) narrated in conversation now actually
  get created.** Previously, the `create_journey` directive (and its siblings
  `create_vow` / `create_combat`) only took effect when emitted by the post-roll
  outcome narration. When the Skald introduced a journey, vow, or fight during
  ordinary `!skald` / `!scene` / `!combat` narration — the natural way these
  usually begin ("you set out for the high passes…") — the directive was stripped
  from the displayed text and silently discarded, so no progress track ever
  appeared on the character sheet. The conversational narration path now parses
  and applies these **track-lifecycle** directives
  (`create_journey` / `create_vow` / `create_combat` and their
  `complete_*` / `end_combat` counterparts). Meter changes (momentum, health,
  spirit, supply, progress ticks) remain strictly dice-driven and are **not**
  applied from casual narration. Honors the existing **"AI Applies Mechanical
  Effects"** setting.

## [0.10.5] — 2026-06-09

### Added
- **New setting: "Show Effect Announcements" (per-client, on by default).**
  Controls whether the brief `The Skald enacts: …` whisper messages — which
  announce the mechanical effects the Skald applies (momentum changes, progress
  marks, completed tracks, etc.) — are posted to chat. Turn it OFF to hide these
  technical notices and keep the chat focused on the narration. The effects
  themselves are still applied; only the announcement whisper is suppressed.

## [0.10.4] — 2026-06-09

### Fixed
- **Manual move rolls from the "What Comes Next" buttons are now narrated.**
  When the foundry-ironsworn pre-roll dialog is unavailable, rolling a move
  from the Skald's suggestion buttons falls back to the module's own
  *manual-roll* chat card (`flags["the-eternal-skald"].manualMove`). The
  `createChatMessage` hook bailed out early for **any** message carrying the
  module flag — *before* it dispatched the roll detector — so these manual
  rolls were silently never narrated and the story stalled.
  - The hook now runs `Integration.onIronswornRoll(message)` **first**
    (it has its own dedupe / GM-only / non-roll-card guards), then applies
    the "ignore our own posts" rule only to the `!command` dispatch.
  - This mirrors the existing `updateChatMessage` hook, which already
    excepted `manualMove` cards. System-produced roll cards and player
    `!`-commands are unaffected.

## [0.10.3] — 2026-06-09

### Fixed
- **Old combat tracks no longer linger untracked when a new fight begins.**
  Previously, starting a new combat left any earlier combat track open;
  because progress marking only ever targets the newest active foe track,
  those older tracks became orphaned and untracked, cluttering the sheet and
  the AI's view of combat state.
  - When a new combat track is created, the Skald now automatically marks any
    combat track left open from a **previous** fight as complete (Ironsworn is
    fought one foe at a time).
  - Several foes introduced in the **same** narration coexist as separate
    tracks — only combats that were open *before* the current reply are
    auto-closed, so multi-foe scenes still work.

### Added
- **`Auto-Close Old Combat Tracks` world setting** (default **on**). Turn it
  off to allow multiple simultaneous combat tracks instead of auto-closing
  stale ones.
- **`IronswornController.closeStaleCombatTracks(actor, opts)`** helper that
  marks active combat tracks complete (with optional `onlyIds`/`exceptId`
  scoping).

## [0.10.2] — 2026-06-09

### Added
- **Journeys are now first-class progress tracks, just like vows.** The vow
  completion machinery from 0.10.1 has been extended to journeys end-to-end:
  - **`create_journey` AI effect.** The Skald can now begin a journey track
    when the character undertakes a journey —
    `[[EFFECT: create_journey <Name> <rank> <description>]]` (synonyms:
    `begin_journey`, `start_journey`, `undertake_journey`) — mirroring
    `create_vow`.
  - **`complete_journey` AI effect** (already accepted, now documented as a
    first-class directive alongside `end_journey`). Marks a journey complete
    when its destination is reached in the fiction.
  - **Manual "Reach Destination (mark complete)" button.** Progress-track
    cards now detect journeys and show a journey-flavoured completion button
    (the journey counterpart of the vow's "Fulfill Vow" button). Works even
    when AI-applied effects are disabled, and the card title and completion
    note read "Journey" instead of the generic "Progress Track".

### Changed
- **Robust journey identification.** Journeys created by the Skald are now
  tagged with `system.subtype === "journey"`, and `getProgressTracks` also
  surfaces the module's own `trackKind` flag — so a journey is recognised even
  when the system stored it as a generic `progress` track. Vow-specific logic
  (e.g. the "Fulfill Your Vow" move source) remains vow-only and is unaffected.

## [0.10.1] — 2026-06-09

### Fixed
- **Vows (and other progress tracks) can now actually be completed.** Previously
  there was no way to mark a vow as fulfilled — neither the AI nor the player
  had any control that would set a track to *complete*, so vows stayed open
  forever even when the story had clearly resolved them. This release adds two
  complementary fixes:
  - **New `complete_vow` AI effect directive.** The Skald can now close out a
    vow when the narrative fulfils it. The effect parser accepts
    `[[EFFECT: complete_vow <Vow Name>]]` and its synonyms (`fulfill_vow`,
    `end_vow`, `complete_track`, `complete_journey`, `end_journey`), all of
    which mark the named track complete.
  - **Manual "Mark Complete / Fulfill Vow" button.** Progress-track cards now
    include a one-click green **Mark Complete / Fulfill Vow** control so you can
    fulfil a vow yourself at any time (Ironsworn lets you fulfil a vow at any
    progress level). Once complete, the card shows a fulfilled note instead.
    This manual path works even when AI-applied effects are disabled.
- **Correct vow identification.** Vow lookup now matches the modern
  foundry-ironsworn data model, where vows are stored as `progress` items with
  `system.subtype === "vow"` (rather than a top-level `vow` type), so the
  active-vow detection and completion targeting find vows reliably.

## [0.10.0] — 2026-06-09

### Added
- **Follow-up move suggestions after a result.** When the Skald narrates the
  outcome of a resolved move (the post-roll narration), it now closes with a
  **"What Comes Next"** card offering **two follow-up moves** to roll next,
  mirroring the pre-roll suggestion card. Each is a one-click *Roll* button.
- **"Roll Any Other Move" everywhere.** The post-roll card always includes the
  same **Roll Any Other Move** option found in pre-roll narration (it opens the
  full move selector), so you can pivot to any move after every result — even
  when no follow-ups were suggested.

### Changed
- **The Skald may no longer invent moves.** The system prompt now ships an
  explicit, authoritative whitelist of the **only** moves that exist in the
  Ironsworn / Starforged system and forbids the model from fabricating moves or
  phrasing an ordinary action as a move (e.g. "roll to Locate Your Objective"
  unless that move literally exists). As a safety net, every suggested move —
  pre-roll and post-roll — is now validated against the real move catalogue,
  and any invented or unknown move is silently dropped before it can reach a
  rollable button.

## [0.9.3] — 2026-06-08

### Fixed
- **Corrected the Abacus AI endpoint.** The Abacus AI provider preset and the
  default API Endpoint now point at the working OpenAI-compatible URL
  `https://routellm.abacus.ai/v1/chat/completions`. The value shipped in v0.9.2
  (`https://api.abacus.ai/v0/chat/completions`) was non-functional.
- **`DEFAULT_ENDPOINT`** realigned to the corrected Abacus AI URL so fresh
  installs work out of the box.

### Changed
- **Auto-migration for affected installs.** On `ready`, the GM client detects
  any world whose saved `apiEndpoint` is still the broken v0.9.2 default and
  transparently rewrites it to the corrected endpoint — no manual change needed.
  Endpoints the user deliberately customised are left untouched.
- Settings hint (`en.json`), README and module description updated to reference
  the corrected `routellm.abacus.ai/v1` endpoint.

## [0.9.2] — 2026-06-08

### Added
- **Abacus AI provider preset (now the default).** The **AI Provider** dropdown
  gains an **Abacus AI** option — the engine that powers the Skald — pointing at
  Abacus AI's OpenAI-compatible endpoint `https://api.abacus.ai/v0/chat/completions`.
  It is now the **recommended default** selection.

### Changed
- **AI Provider dropdown order** is now: **Abacus AI** (default) → OpenAI →
  OpenRouter → Google AI (Gemini) → Custom.
- **Default API Endpoint** for fresh installs is now the Abacus AI endpoint
  (`https://api.abacus.ai/v0/chat/completions`), aligned with the default provider
  preset. Existing worlds keep whatever endpoint they have already saved.
- Settings labels and hints (`en.json`) updated to present Abacus AI as the
  recommended provider and to fold the legacy RouteLLM endpoint under **Custom**.

## [0.9.1] — 2026-06-08

### Added
- **AI Provider preset dropdown.** A new world-scoped **AI Provider** setting lets
  you choose between **OpenAI**, **OpenRouter**, **Google AI (Gemini)** and
  **Custom** from a dropdown. Picking a known provider auto-fills the **API
  Endpoint** with that provider's OpenAI-compatible chat-completions URL via the
  new `applyProviderPreset()` helper and a `PROVIDER_PRESETS` map — you still
  supply your own **API Key** and **AI Model** separately. The **Custom** preset
  (the default) leaves the endpoint untouched, so the shipped Abacus AI RouteLLM
  default, self-hosted gateways and any other endpoint keep working unchanged.
  GM-only writes, fully defensive, and backwards-compatible (no behaviour change
  on upgrade). Setting labels and a confirmation notification added to `en.json`.

## [0.9.0] — 2026-06-08

### Added
- **Context-aware suggestions.** When narrating, the Skald can now weave subtle,
  situation-aware next-step hints drawn from the active scene, the current
  location entry and recent open story threads. A new
  `buildContextSuggestionBlock()` assembles a compact, advisory-only block that is
  injected into the system prompt for narrative calls (gated by `extras.allowMoves`,
  so session chronicles are unaffected). Purely additive guidance — it never forces
  the story. Controlled by a new **Context-Aware Suggestions** setting (default ON).
- **Lore contradiction alerts.** After each narration is ingested, the new
  `ContradictionDetector` compares the freshly recorded facts against established
  chronicle lore (recalled via Semantic Memory / RAG) and uses the AI as a terse
  continuity checker. Genuine conflicts are surfaced as a GM-only whispered
  advisory card ("The Chronicle Frowns") listing each potential contradiction —
  **nothing is ever changed automatically.** Runs only on the active GM, is fully
  fire-and-forget, and degrades silently when RAG or the AI is unavailable.
  Controlled by a new **Lore Contradiction Alerts** setting (default OFF).
- **Idle auto-summaries.** A lull in play can now weave a Session Chronicle on its
  own, so a recap is never lost when `!end-session` is forgotten. A new
  **Auto-Summary Idle Timer (minutes)** setting (default `0` = off) arms an idle
  timer that is reset on every narration; when it elapses, the active GM host
  generates the chronicle automatically (titled with an "(auto)" suffix and a short
  intro note). Builds on the existing **Session Chronicle on Demand** master toggle
  and is fully backwards compatible (manual-only when the timer is `0`).
- **Customizable link styles.** The new GM-only `!link-style` command lets you
  recolor and re-icon the in-chat entity links (moves, oracles, tracks, assets) to
  taste. Styles are validated (safe colors / Font Awesome icon names only), stored
  in a new `linkStyles` object setting, and injected as a scoped
  `<style id="es-custom-link-styles">` block at runtime; `!link-style reset`
  restores the saga defaults. Gated by a new **Custom Entity Link Styles** setting
  (default OFF) and exposed on the public API as `api.setLinkStyle()` /
  `api.resetLinkStyles()`.

### Changed
- **Faster entity indexing for large campaigns.** The `EntityLinker` index now
  memoizes its journal sub-index, keyed by a `JournalSystem` generation counter
  that is bumped only when journal entries are created/updated/deleted. The journal
  scan was also reduced from three passes to a single pass over the entries, and
  optional timing instrumentation was added (gated behind a perf flag). Item, actor
  and token changes now invalidate only their own portion of the index, preserving
  the journal cache — keeping linking snappy across campaigns of 100+ journals.

### Notes
- All new behaviour is additive, backwards-compatible and degrades gracefully:
  narration is never blocked or broken if a feature's dependency (RAG, AI, DOM) is
  unavailable. This remains an early (`0.x`) **alpha** build — expect rough edges.

## [0.8.0] — 2026-06-08

### Added
- **Relationship mapping.** The chronicle now records how entities are connected.
  When the AI supplies a `related` array in its `[[SKALD_META]]` block (each item
  either a name string or `{name, rel}` object), the journal system resolves each
  target to an existing entry and stores the link as a UUID in a new
  `relatedEntities` flag — **bidirectionally**, so both sides of a bond stay in
  sync. A **Connections** section is rendered (idempotently) at the bottom of each
  entity's journal page as Foundry content-links, and the new `!relationships`
  command (alias `!map`) shows the whole web grouped by entity, with an optional
  name filter. Exposed on the public API as `api.relationships(nameOrUuid?)`.
- **Persistent campaign timeline.** A new world-scoped `timelineEvents` setting
  records a compact, permanent event for every metadata pulse (entities touched,
  facts revealed, mysteries raised, decisions made) — surviving reloads and *not*
  cleared at the end of a session (unlike the in-memory session log). The new
  `!timeline` command renders a chronological, newest-first card with human
  timestamps, channel tags and journal content-links for entities; pass a term to
  filter (`!timeline Reeves`) or `!timeline clear` (GM-only) to wipe it. Capped at
  1000 events and written GM-side only. Exposed as `api.timeline(query?)`.
- **Structured entity templates.** NPC, Location and Discovery entries now define
  structured **fields** (NPCs: rank, harm, motivations, goals, relationships;
  Locations: region, features, dangers, resources; Discoveries: significance,
  connectedTo). The journal prompt block asks the AI to populate them, the entity
  renderer displays them, and a new GM-only `!template` command opens a dialog
  (DialogV2 with a classic-Dialog fallback) to hand-author a structured entry —
  including a name + aliases — created with `createdBy: "manual"` so it lives
  alongside AI-scribed entries.
- **Smart entity detection (aliases & fuzzy matching).** Entities now carry an
  `aliases` array. Entry lookup matches by exact name → alias → normalized form →
  edit-distance fuzzy match, so narration variations ("the captain" →
  *Captain Reeves*) augment the existing entry instead of creating a duplicate.
  Aliases are also registered in the narration entity-linker, so every recognised
  variation becomes a clickable link to the canonical entry. Manual entries accept
  aliases too.

### Notes
- Purely additive and **backwards-compatible** with existing journals: entries
  without the new flags/fields render exactly as before, and every new code path
  is wrapped defensively so a failure never interrupts narration or play.

## [0.7.0] — 2026-06-08

### Added
- **Entity linking expansion — oracles, progress tracks & assets.** Building on
  the v0.6.0 clickable NPCs, locations and moves, the Skald now links three more
  kinds of entity inline in narration:
  - **Oracles.** Oracle names the Skald mentions (e.g. *Action Oracle*) become
    one-click links that roll that very oracle via the oracle interpreter. The
    index is built from `IronswornData.oracles` using case-sensitive labels.
  - **Progress Tracks.** Progress tracks on the active character become links
    that open a status card showing rank, progress boxes and ticks, with a
    one-click **Mark Progress (by rank)** button.
  - **Assets.** Asset names become links that open the asset's own Foundry sheet,
    with a graceful chat-card fallback when the sheet can't be opened. Assets are
    resolved against an in-memory index of the compendium asset packs using fuzzy
    matching (exact, normalized, substring, token-overlap and edit-distance).
- **Live index refresh.** The entity index now invalidates automatically on
  `createItem`, `updateItem`, `deleteItem`, `updateActor`, `deleteActor` and
  `controlToken`, so progress-track and asset links stay current mid-session.
- **Asset index priming.** The asset compendium index is primed once on `ready`
  (with defensive error handling) and the entity linker is refreshed so assets
  are linkable from the first narration.

### Notes
- Purely additive and degrades gracefully — unmatched names stay plain text and
  any failure leaves narration untouched. Governed by the existing **Link
  Entities in Narration** world setting (default ON).

## [0.6.0] — 2026-06-08

### Added
- **Clickable entities in narration.** Names the Skald speaks are now linked
  inline in the chat. NPCs, locations and discoveries already scribed into the
  Living Chronicle become Foundry content links that open their Journal Entry,
  and known Ironsworn moves become one-click links. The entity index is built
  from the chronicle and the move catalog, cached, and rebuilt automatically
  when journal entries change. New world setting **Link Entities in Narration**
  (default ON) toggles the feature; it is purely additive and degrades
  gracefully (unmatched names stay plain text, `<code>` and existing links are
  never touched, and any failure leaves narration untouched). Move references
  match case-sensitively so ordinary verbs ("you strike the wolf") are never
  mistaken for the move. Exposed on the public API as
  `game.modules.get('the-eternal-skald').api.entityLinker`.
- **Move links open the *real* Ironsworn move.** Clicking a linked move now
  opens the **foundry-ironsworn system's own official pre-roll dialog** for that
  move directly — the exact dialog the system shows when you click the move on a
  character sheet — instead of an intermediate Skald card. Links carry the
  move's **Datasworn ID** (e.g. `move:classic/combat/strike`); the controller
  resolves it to the system's actual move Document by mirroring the system's own
  compendium lookup (`flags["foundry-ironsworn"].dsid`) across the classic,
  delve, Starforged and Sundered Isles move packs, then calls
  `CONFIG.IRONSWORN.applications.IronswornPrerollDialog.showForOfficialMove()`.
  If the system or dialog is unavailable, it falls back to the previous
  suggestion card so play is never interrupted. New controller helpers are
  available for integrations: `IronswornController.getMoveUuid(ref)` (returns
  the system move Item's `@UUID`), `openMoveDialog(ref)` and `openMoveSheet(ref)`.

## [0.5.0] — 2026-06-07

### Added
- **AI Memory — Browser-Based RAG.** The Skald now has a *semantic long-term
  memory* of your saga, built entirely inside the browser. There is **no server
  to run, no cloud vector database, and no extra API keys** for memory — it is
  private by design and lives only on the GM's machine.
  - **Local embeddings.** Each chronicle Journal Entry (NPCs, locations,
    discoveries, world facts, story threads, session chronicles) is turned into a
    384-dimension embedding vector using a small transformer model
    (`Xenova/all-MiniLM-L6-v2`) running locally via
    [transformers.js](https://github.com/xenova/transformers.js) (WASM/WebGPU).
    The model (~90 MB) is fetched from a CDN on first use and cached by the
    browser thereafter.
  - **IndexedDB vector store.** Vectors, their source text, and metadata are
    stored in an IndexedDB database (`eternal-skald-vectors` → `journals`), so
    memory survives reloads.
  - **Relevant recall before every answer.** Before the Skald responds, your
    prompt (or the move/scene/oracle in play) is embedded and matched against the
    store with **cosine similarity**; the most relevant entries are injected as a
    `RELEVANT WORLD MEMORY` block in the system prompt. This keeps continuity
    across long campaigns without bloating the context window.
  - **Smart, bounded injection.** Retrieval honours a configurable token budget
    (default 2000), a max-results cap (default 5), and a similarity threshold
    (default 0.3), trimming the recalled block to fit.
  - **Automatic indexing.** New and updated chronicle entries are embedded in the
    background through a serial queue, so journal writes never stack CPU-heavy
    work on the main thread. Deleting a Skald journal evicts its vector too.
- **`!remind` is now semantic.** It embeds your topic and recalls the most
  *meaningfully related* entries (not just keyword matches), tagging the result
  with a "semantic recall" badge. It transparently falls back to the v0.4.0
  keyword search when memory is disabled, still loading, or finds nothing.
- **New command `!reindex`** (GM-only) — rebuilds the entire semantic memory
  from your current chronicle, with a live progress bar while the model loads
  and entries embed.
- **New command `!rag-status`** — shows memory health: whether it's enabled,
  browser support, whether the model is loaded, auto-index state, the number of
  vectors stored, and the active tuning settings.
- **Six new settings** (World-scoped): **Semantic Memory (RAG)** on/off,
  **Memory Context Budget**, **Memory Results per Query**, **Auto-Index
  Journals**, **Memory Relevance Threshold**, and **Memory Debug Logging**.
- **Public API.** `game.modules.get("the-eternal-skald").api.rag` exposes the
  `BrowserRAG` module (`search`, `buildContextBlock`, `reindexAll`, `status`,
  `clear`, …) for macros and other modules.

### Changed
- The system-prompt builder now slots a `RELEVANT WORLD MEMORY` block (when
  available) between the persona/guidance and the Ironsworn/journal blocks.
- Memory retrieval is wired into all narrative AI call sites — `!skald`,
  `!scene`, `!combat`, move-outcome narration, NPC dialogue, oracle
  interpretation and lore generation.

### Notes
- **Graceful degradation.** RAG never blocks or breaks play. If transformers.js
  can't be fetched (offline, strict CSP, very old browser) or IndexedDB is
  unavailable, every memory call fails *soft* and the Skald simply answers
  without world memory — exactly as in v0.4.0.
- **First-time setup.** The embedding model downloads once (~90 MB). The very
  first conversations after enabling RAG answer immediately without memory while
  the model warms in the background; run `!reindex` to load it and index your
  existing chronicle up front.
- Requires a modern browser with WebAssembly + IndexedDB (any recent Chrome,
  Edge, Firefox or Safari). WebGPU is used automatically when available for a
  speed boost, but is not required.

## [0.4.0] — 2026-06-07

### Added
- **The Living Chronicle — automatic journaling.** The Skald now scribes your
  saga into Foundry **Journal Entries** as it unfolds, with zero manual effort.
  As the AI narrates, it appends a hidden, machine-readable metadata block
  (`[[SKALD_META]]…[[/SKALD_META]]`) that the client parses and turns into
  journal entries. The block is always stripped from the displayed narration —
  players never see the raw protocol.
  - **Organized folders.** Entries are filed under a root **The Eternal Skald**
    journal folder, with sub-folders for **NPCs**, **Locations**, **Discoveries**,
    **World Facts**, **Story Threads**, and **Session Chronicles**.
  - **Per-entry types.** NPCs, locations and discoveries each get their own
    dedicated journal entry (deduped by name — re-mentioning an NPC appends an
    update rather than creating a twin). World facts and story threads/mysteries
    accumulate into single **rolling** journals so they read as a running log.
  - **Background queue.** All writes go through an async, sequential
    `JournalQueue`, so journaling never blocks narration and a burst of new
    entities can't race the database. The whole system degrades gracefully —
    if journaling ever fails, play continues uninterrupted.
  - **Toast notifications.** New entries surface as a subtle bottom-right toast
    that fades after ~2 seconds. Verbosity is configurable (silent / minimal /
    detailed); world facts and story threads are always silent.
- **New commands:**
  - `!journals [type]` — list the chronicle entries the Skald has recorded
    (optionally filtered by `npc`, `location`, `discovery`, etc.).
  - `!mysteries` — review the open mysteries, decisions and world-state the
    Skald is tracking.
  - `!remind [topic]` — recall what the chronicle holds about a topic via a
    scored text search across recorded entries, then summarized in-character.
    *(Full semantic/RAG recall is planned for v0.5.0.)*
  - `!end-session` — GM-only; weave a saga-styled **Session Chronicle** recap
    from everything recorded during the session, written as a dated journal.
- **Four new settings** (world-scoped): **Auto-Journaling** (master on/off),
  **Journal Notifications** (none / minimal / detailed), **Journal Visibility**
  (GM only / shared with players), and **Session Chronicle on Demand**.
- **Public API.** `game.modules.get("the-eternal-skald").api.journal` exposes the
  `JournalSystem` for macros and other modules.

### Changed
- The narrative channels (`!skald`, `!scene`, `!combat`), combat outcome
  narration, and NPC encounters now feed the chronicle automatically when
  auto-journaling is enabled.
- The system prompt teaches the AI the chronicle-metadata protocol only when
  journaling is active for the current channel, keeping other prompts lean.

## [0.3.3] — 2026-06-07

### Added
- **Streaming responses.** The Skald now renders its replies in real time —
  word by word, as the AI generates them — instead of waiting for the entire
  reply to arrive. A chat card appears instantly with a "gathering the threads
  of fate…" indicator and fills in live, cutting perceived latency dramatically.
  Implemented end-to-end over Server-Sent Events:
  - **Server hook** gains a `POST /skald-api/chat-stream` endpoint that opens the
    upstream request with `stream: true` and pipes the OpenAI-style SSE token
    stream straight back to the client. Errors before the stream starts return a
    normal JSON error; failures mid-stream emit a terminal `event: error` frame.
  - **Client** gains `Client.chatStream()` (an SSE reader) and a
    `callSkaldStreaming()` helper that posts the message immediately and rewrites
    it in place as tokens arrive, throttled to ~140 ms so it never floods
    Foundry's socket or database. The final update is always flushed.
  - Live display strips `[[MOVE:…]]` / `[[EFFECT:…]]` directives (including a
    half-typed one at the stream's tail) so raw protocol never flashes on screen;
    the **complete** raw reply is still parsed afterwards, so move-suggestion
    cards, effect application, and conversation memory all behave exactly as
    before.
  - Wired into `!skald` / `!scene` / `!combat` conversations, automatic roll-
    outcome narration, oracle interpretations, and ongoing NPC dialogue.
- **`streamingEnabled` setting** (world-scoped, **default ON**) in
  *Module Settings → The Eternal Skald* to turn streaming off if preferred.

### Changed
- `Chat.renderCard()` was extracted from `Chat.postSkald()` so the streaming
  updater and the classic post path share identical card markup.

### Notes
- **Graceful fallback:** if the streaming endpoint is unavailable (older server
  hook, a non-streaming proxy, or a network error before any token arrives), the
  client automatically falls back to the buffered `POST /skald-api/chat` path, so
  upgrading the client without the new server hook still works.
- A few call sites stay buffered by design: NPC **creation** (the speaker alias
  is parsed out of the reply, so it can't be known up front), the enemy combat
  **decision** step (returns JSON that must be parsed whole), and the **lore**
  generator (writes a Journal Entry from the full text).

## [0.3.2] — 2026-06-04

### Added
- **Bare `!` command alias.** You can now summon the Skald by typing `!`
  directly followed by your words — e.g. `!what lurks in the barrow?` — with no
  need for the `!skald` prefix. The explicit sub-commands (`!oracle`, `!npc`,
  `!scene`, `!lore`, `!combat`, `!skald`, `!skald-help`) still take precedence;
  any other `!`-prefixed line is routed to the Skald as a free-form prompt.
- **AI Mode master toggle** (`aiMode` setting, world-scoped, **default ON**).
  When ON, `!`-prefixed messages are sent to the AI GM; when OFF, they pass
  through as ordinary chat and the Skald stays silent. Available in
  *Module Settings → The Eternal Skald* and surfaced via a notification on change.
- **Keybinding to toggle AI Mode** (`toggleAiMode`) using Foundry's keybinding
  system, bound to **Alt+Shift+A** by default and rebindable under
  *Configure Controls → The Eternal Skald*. GM-only (the toggle is world-scoped).
- **Public API helpers:** `game.modules.get("the-eternal-skald").api` now exposes
  `isAiMode()`, `setAiMode(on)`, and `toggleAiMode()` for macros and other modules.

### Changed
- The `!skald-help` card now documents the bare `!<message>` alias.

## [0.3.1] — 2026-06-04

### Fixed
- **Enemy ranks now come from the Ironsworn foe compendium instead of always
  defaulting to *dangerous*.** When a combat track is auto-created without an
  explicit rank, the foe's name is looked up in the installed foe compendia
  (*Ironsworn Foes*, *Delve Foes*, *Starforged Encounters*, and any compatible
  third-party foe packs) and its **official challenge rank** is used (e.g. Bear →
  *formidable*, Wolf → *dangerous*, Wyvern → *extreme*). Foe ranks are stored as
  numbers (1–5) in the system data and are now decoded correctly.

### Added
- **Compendium enemy-rank lookup API** on `IronswornController`:
  `lookupEnemyInCompendium(name)` → `{ found, name, rank, matchedName, packId,
  match }`, `getEnemyRank(name)` → official rank or `null`, and
  `clearEnemyCache()`.
- **Forgiving name matching:** case-insensitive, article/punctuation-insensitive,
  substring and token-overlap matching (`dire wolf` → Wolf), and
  Damerau-Levenshtein typo tolerance (`wyvrenn` → Wyvern). Close-but-uncertain
  names are logged as a suggestion.
- **Cached foe index** built once per session from the foe packs (via
  `pack.getIndex`), cleared automatically on world reload.

### Changed
- **`create_combat` rank resolution priority:** explicit rank (custom foes) →
  compendium rank (standard foes) → *Default Enemy Rank* setting (only when the
  foe isn't in any compendium and no rank was given). Debug logging now reports
  which path was taken.
- **AI guidance updated:** the Skald is told that rank is *usually optional* —
  standard foes should be created with just a name (the compendium fills the
  rank) and only invented/unique foes need an explicit rank.
- **"Default Enemy Rank" setting clarified** as a fallback for custom foes only,
  in both the settings hint and the README.

## [0.3.0] — 2026-06-03

### Added
- **Automatic combat system.** The Skald now runs Ironsworn fights end-to-end.
  When a fight begins it creates a **combat progress track per foe**; landing a
  blow marks that track **by the foe's rank** (troublesome +12 … epic +1 ticks);
  and the single **initiative** state ("in control" vs "in a bad spot") is
  tracked automatically.
- **Deterministic resolution of core combat moves.** *Enter the Fray*, *Strike*,
  and *Clash* are resolved by the client itself: Enter the Fray hit → gain
  initiative (miss → bad spot); Strike/Clash hit → mark the active foe's track,
  strong hit keeps initiative / weak hit loses it; miss → lose initiative. The AI
  is told these are already applied so it never double-marks.
- **New effect directives:** `[[EFFECT: create_combat <Foe> <rank>]]`,
  `[[EFFECT: create_vow <Name> <rank> <description>]]`,
  `[[EFFECT: initiative <gain|lose>]]`, and `[[EFFECT: end_combat <Foe>]]`.
- **`IronswornController` combat/track API:** `createProgressTrack` (combat /
  vow / journey / bond, positional or options style), `getProgressTrack`,
  `completeTrack`, `getCombatTracks`, `getActiveCombatTrack`, `hasInitiative`,
  `setInitiative`, `normalizeRank`, and `describeCombatState`.
- **Live combat context** (initiative holder, active foes + progress, recently
  ended fights) injected into the AI prompt every turn.
- **UI notifications** for combat-track creation, progress marks, and initiative
  changes.
- **New settings:** *Auto-Create Combat Tracks* (default on) and *Default Enemy
  Rank* (default Dangerous), with localization.

### Changed
- **"AI Applies Mechanical Effects" now defaults to ON**, enabling the combat
  automation out of the box. Turn it off to keep the player in full control of
  the sheet.
- System prompt now documents the combat-track syntax, rank guidance, initiative
  mechanics, and that core combat moves are auto-resolved.

## [0.2.3] — 2026-06-03

### Added
- **Configurable "Narration Delay (ms)" setting.** The wait between a roll
  resolving and the Skald narrating its outcome is now a world setting in the
  module configuration UI (default `2000ms`, range `0–5000`), instead of a
  hardcoded value. Recommended ~2000ms with Dice So Nice, ~500ms without, so
  narration lines up with the dice animation. Includes localization strings.

## [0.2.2] — 2026-06-03

### Added
- **Deep integration with the `foundry-ironsworn` rules engine.** The Skald reads your
  character's stats and meters, *suggests* the right Ironsworn move, triggers the
  system's own dice mechanics on one click, narrates the official strong-hit /
  weak-hit / miss outcome, and can optionally apply mechanical effects (momentum, harm,
  stress, supply, progress, oracles).
- **Auto-narration of Ironsworn move rolls.** After a move roll resolves, the Skald
  automatically narrates the outcome.
- `updateChatMessage` hook so rerolls, momentum burns, and resolved challenges
  re-narrate the same roll card.
- Comprehensive, opt-in debug logging at every roll-detection / parse step.

### Fixed
- **Roll detection / auto-narration that never fired.** Modern `foundry-ironsworn`
  chat messages carry no module flags, so the old flag-based detection always failed.
  Detection now parses the rendered roll-card HTML (the `data-ironswornroll` attribute /
  `ironsworn-roll` class), with the legacy flags and `message.rolls` dice as fallbacks,
  and computes the outcome (Strong Hit / Weak Hit / Miss + match) from the action die,
  stat/adds, and challenge dice — honoring replaced challenge/outcome and automatic
  outcomes.
- Narration now waits for the dice animation (~1.5s, or 2.8s with Dice So Nice) before
  posting, and respects the **Auto-Narrate Moves** setting and GM-only gating.

> Retired tag: previously published as `v2.2.0` / `v2.2.1`.

## [0.2.0] — Server-side architecture rewrite

### Changed
- Complete architectural rebuild moving all upstream LLM calls to a **stateless
  server-side hook** loaded via Node's `--import` flag (`scripts/eternal-skald-server.mjs`),
  intercepting `/skald-api/*` requests before Foundry's Express server.
- Eliminated the standalone proxy and all of its networking/CORS complexity; the module
  now has a single networking path.
- Removed the old **Proxy URL** setting.

### Notes
- A follow-up patch in this line corrected the default API endpoint and model name.

> Retired tags: previously published as `v2.0.0` (rewrite) and `v2.0.1` (endpoint/model fix).

## [0.1.x] — Initial proxy attempts

### Added
- First working versions of the module: AI storyteller, oracle interpretation, NPC
  voicing, lore generation, combat narration, and enemy control.
- Networking handled by a separate **proxy** process (`skald-proxy.js` /
  `proxy/skald-hook.mjs`) to reach the upstream LLM and work around browser CORS limits.

### Notes
- The proxy approach proved fragile to deploy (reverse proxies, systemd/PM2 units,
  relative-URL handling), which motivated the `0.2.0` server-side rewrite.

[0.10.28]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.28
[0.10.27]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.27
[0.10.26]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.26
[0.10.24]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.24
[0.10.23]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.23
[0.10.22]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.22
[0.10.21]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.21
[0.10.20]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.20
[0.10.19]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.19
[0.10.18]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.18
[0.10.17]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.17
[0.10.16]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.16
[0.10.15]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.15
[0.10.14]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.14
[0.10.13]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.13
[0.10.12]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.12
[0.10.11]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.11
[0.10.10]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.10
[0.10.9]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.9
[0.10.8]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.8
[0.10.7]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.7
[0.10.6]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.6
[0.10.5]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.5
[0.10.4]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.4
[0.10.3]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.3
[0.10.2]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.2
[0.10.1]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.1
[0.10.0]: https://github.com/papicy/eternal_skald/releases/tag/v0.10.0
[0.9.3]: https://github.com/papicy/eternal_skald/releases/tag/v0.9.3
[0.9.2]: https://github.com/papicy/eternal_skald/releases/tag/v0.9.2
[0.9.1]: https://github.com/papicy/eternal_skald/releases/tag/v0.9.1
[0.9.0]: https://github.com/papicy/eternal_skald/releases/tag/v0.9.0
[0.8.0]: https://github.com/papicy/eternal_skald/releases/tag/v0.8.0
[0.7.0]: https://github.com/papicy/eternal_skald/releases/tag/v0.7.0
[0.6.0]: https://github.com/papicy/eternal_skald/releases/tag/v0.6.0
[0.5.0]: https://github.com/papicy/eternal_skald/releases/tag/v0.5.0
[0.4.0]: https://github.com/papicy/eternal_skald/releases/tag/v0.4.0
[0.3.3]: https://github.com/papicy/eternal_skald/releases/tag/v0.3.3
[0.3.2]: https://github.com/papicy/eternal_skald/releases/tag/v0.3.2
[0.3.1]: https://github.com/papicy/eternal_skald/releases/tag/v0.3.1
[0.3.0]: https://github.com/papicy/eternal_skald/releases/tag/v0.3.0
[0.2.3]: https://github.com/papicy/eternal_skald/releases/tag/v0.2.3
[0.2.2]: https://github.com/papicy/eternal_skald/releases/tag/v0.2.2
