# Changelog

All notable changes to **The Eternal Skald** are documented here.

This project adheres to [Semantic Versioning](https://semver.org/). It is currently in
the `0.x` **pre-release (alpha)** stage — see
[Versioning & Release Strategy](README.md#versioning--release-strategy) in the README.
Until `1.0.0`, treat every release as an experimental development build.

> **Note on version numbering:** Some early builds were mistakenly published under `2.x`
> (`v2.0.0`, `v2.0.1`, `v2.2.0`, `v2.2.1`). Those numbers were never appropriate for a
> pre-release project and have been retired. The history below reflects the corrected
> `0.x` lineage; the retired tags map to the equivalent `0.x` entries.

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

[0.3.3]: https://github.com/papicy/eternal_skald/releases/tag/v0.3.3
[0.3.2]: https://github.com/papicy/eternal_skald/releases/tag/v0.3.2
[0.3.1]: https://github.com/papicy/eternal_skald/releases/tag/v0.3.1
[0.3.0]: https://github.com/papicy/eternal_skald/releases/tag/v0.3.0
[0.2.3]: https://github.com/papicy/eternal_skald/releases/tag/v0.2.3
[0.2.2]: https://github.com/papicy/eternal_skald/releases/tag/v0.2.2
