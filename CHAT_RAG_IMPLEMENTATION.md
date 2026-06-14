# Narration & Story RAG Indexing — Technical Analysis & Implementation Guide

> **Scope.** This document explains how to extend *The Eternal Skald*'s existing
> browser‑based RAG system so that **narration and story content** — and *only*
> narration/story content — becomes part of the Skald's semantic long‑term
> memory, alongside the Journal Entries and Compendium packs it already indexes.
>
> **What counts as "narration / story" (indexed):**
> * **AI‑generated story** — the Skald's own narration cards: scene‑setting,
>   outcome narration, NPC dialogue, oracle interpretations, lore, combat
>   narration, milestone/growth beats.
> * **Player‑written narration** — In‑Character (IC) prose and EMOTE messages
>   spoken through a character/token (the player describing what their hero does
>   or says).
>
> **What is explicitly EXCLUDED (never indexed):**
> * Out‑of‑character (OOC) table talk
> * Dice rolls / roll result cards
> * System / status notices, error cards, help cards, move‑suggestion prompts
> * Slash/`!` commands
> * Whispers (private messages)
>
> The narrower scope is deliberate: story content is the only material that
> improves narrative continuity on retrieval, and indexing *only* it keeps the
> corpus small — which further reduces both background CPU and retrieval latency
> (see §3). It covers the design, a realistic latency analysis, concrete
> latency‑minimisation strategies, and copy‑pasteable code.
>
> **Audience.** Module maintainers familiar with Foundry VTT hooks and the files
> `scripts/browser-rag.js`, `scripts/browser-rag-hnsw.js`,
> `scripts/hooks/foundry-hooks.js`, `scripts/chat/display.js`, and
> `scripts/core/settings.js`.

---

## 1. Current State (what exists today)

The RAG engine (`scripts/browser-rag.js`) already provides everything we need as
building blocks:

| Capability | Where | Notes |
|---|---|---|
| Local embedding | `BrowserRAG.embed(text, { role })` | `Xenova/all-MiniLM-L6-v2`, 384‑dim, mean‑pooled, normalized, via transformers.js (WASM/WebGPU). |
| Low‑level write | `BrowserRAG.indexRecord({ id, text, metadata })` | Embeds **one** record and `put`s it into IndexedDB store `eternal-skald-vectors → journals`. |
| Journal write | `BrowserRAG.indexJournalEntry(entry)` | Routes through a **serial work‑queue** (`_indexJobs` / `_drainIndexQueue`) so bursts embed one at a time off the UI critical path. |
| Retrieval | `BrowserRAG.search()` / `buildContextBlock()` | Cosine scan, or HNSW ANN when corpus ≥ `ANN_MIN_CORPUS` (1000) and the setting is on. |
| Removal | `BrowserRAG.remove(id)` | Deletes one vector + invalidates corpus cache. |
| Soft‑fail | every method | Returns empty/false when transformers.js or IndexedDB is unavailable — **RAG must never break play.** |

**The gap.** Chat hooks in `scripts/hooks/foundry-hooks.js`
(`chatMessage`, `preCreateChatMessage`, `createChatMessage`,
`updateChatMessage`) only intercept slash‑commands (`tryCommandFromText`) and
detect dice rolls. **No chat content is ever embedded.** The only automatic
indexing trigger is `RagBridge.indexEntry(entry)` in
`scripts/chronicle/journal-system.js`, fired when a *Journal Entry* is
created/updated. Chat reaches memory only *indirectly* — distilled into a
**Session Chronicle** journal entry at `!end-session`.

> **Key consequence for design:** we already have a battle‑tested
> `indexRecord` + serial‑queue + soft‑fail substrate. Narration indexing should
> **reuse** it rather than introduce a parallel pipeline. The work is mostly
> (a) a new hook, (b) a **narration classifier** that admits only story content,
> (c) a small content/metadata adapter with debouncing, and (d) user‑facing
> settings.

---

## 2. Implementation Design

### 2.1 Architecture overview

```
                       Foundry "createChatMessage" hook
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │  classifyNarration(msg)        │  ← STORY-ONLY gate (cheap, sync)
                    │  ───────────────────────────── │
                    │  AI story?  Skald card with a   │
                    │   story variant (default/lore/  │
                    │   npc/oracle/scene/combat) and  │
                    │   NOT help/error/suggest/system │
                    │           — OR —                │
                    │  Player narration? style==IC or │
                    │   EMOTE, has speaker.actor,     │
                    │   no rolls, not "!", not whisper│
                    └───────────────┬───────────────┘
                       reject ◄──────┤ (OOC / roll / system / command / whisper)
                                    │ accept → { id, text, metadata }
                                    ▼
                    ┌───────────────────────────────┐
                    │   BrowserRAG.indexNarration    │  ← NEW thin adapter
                    │   (debounce + micro-batch)     │
                    └───────────────┬───────────────┘
                                    │ enqueue
                                    ▼
                    ┌───────────────────────────────┐
                    │   serial story queue → embed   │  ← embed off the hot path
                    │   (batched) → _store.put → IDB │
                    └───────────────────────────────┘
```

The hook does **zero embedding work synchronously**. It runs only the cheap
synchronous narration classifier, then *enqueues* only the messages that pass.
All CPU‑heavy embedding happens later on the serial drain, exactly as journal
indexing does today.

### 2.2 Identifying narration/story content (the core of this design)

This is where the narrow scope is enforced. There are two distinct sources of
story content in the module, each detected differently.

#### (A) AI‑generated story — by Skald card *variant*

The Skald posts every card through `Chat.postSkald()` /
`callSkaldStreaming()` in `scripts/chat/display.js`, which stamps a module flag:

```js
flags: { [MODULE_ID]: { variant, alias, ... } }   // MODULE_ID = "the-eternal-skald"
```

The `variant` tells us *what kind of card it is*. Grepping the call sites, the
variants in use split cleanly into **story** vs **meta/UI**:

| Variant | Meaning | Index? |
|---|---|---|
| `default` | Main scene / outcome narration | ✅ story |
| `lore` | Lore / world‑fact / milestone‑growth narration | ✅ story |
| `npc` | NPC dialogue | ✅ story |
| `oracle` | Oracle **interpretation** narration | ✅ story |
| `scene` | Scene‑setting | ✅ story |
| `combat` | Combat **narration** | ✅ story |
| `suggest` | "A Move Beckons" suggestion prompt | ❌ meta/UI |
| `help` | Help / command‑reference card | ❌ meta/UI |
| `error` | "The Skald Falters" error card | ❌ meta/UI |

`Chat.postSystem()` cards are *not* story either — they carry **no**
`variant` flag and render inside a `<div class="eternal-skald-system">`, so they
are excluded both by the variant allow‑list and (defensively) by that class.

> ⚠️ **Caveat about `oracle`:** the `oracle` variant is reused for the
> interactive *"Make a Move?" / "Asset Bonus?"* prompt cards
> (`scripts/narrative/integration.js`) as well as for genuine oracle *result*
> narration. Those prompt cards are UI, not story. The robust fix (recommended
> below) is to stop relying on variant inference for AI content and instead have
> the narration posting path stamp an explicit, unambiguous flag.

> ✅ **Recommended (one‑line) source change — explicit `story` flag.** Rather than
> reverse‑engineering intent from `variant`, tag genuine narration at the source.
> In the narration posting paths (`postReplyWithSuggestion`, the milestone/NPC/
> oracle‑interpretation/scene/combat narration calls), pass
> `flags: { story: true }` through `postSkald`/`callSkaldStreaming`
> (both already spread `...(opts.flags ?? {})` into the module flag). Then the
> classifier prefers `flags[MODULE_ID].story === true` and only falls back to the
> variant allow‑list for older messages. This removes the `oracle` ambiguity
> entirely and is future‑proof against new variants.

#### (B) Player‑written narration — by Foundry message *style*

Foundry classifies every chat message with a style enum
(`CONST.CHAT_MESSAGE_STYLES` on v12+, formerly `CONST.CHAT_MESSAGE_TYPES` on
v11):

| Style | Value | Meaning | Index? |
|---|---|---|---|
| `IC` | 2 | In‑character — spoken through an associated character/token | ✅ narration |
| `EMOTE` | 3 | Emote performed by a character ("/em draws her blade") | ✅ narration |
| `OOC` | 1 | Out‑of‑character table talk | ❌ |
| `OTHER` | 0 | Uncategorised / system‑ish | ❌ |

So **player narration = style `IC` or `EMOTE`**, additionally requiring:

* a **speaker actor** (`message.speaker?.actor`) — confirms it's spoken in‑world,
  not a stray IC‑styled system line;
* **no rolls** — `message.rolls` is empty/absent (in v12+ dice rolls are an array
  on the document, *not* a style; on v11 they were `CHAT_MESSAGE_TYPES.ROLL`);
* **not a command** — stripped text doesn't start with `!`;
* **not a whisper** — `message.whisper` is empty.

Detect the style version‑defensively (read `CONST.CHAT_MESSAGE_STYLES` and fall
back to `CONST.CHAT_MESSAGE_TYPES`), because the repo supports a range of Foundry
builds (the hooks file already documents v14 chat quirks).

### 2.3 Where to hook

Use **`createChatMessage`** (the document is already persisted, so it has a
stable `id` we can use as the vector key and for later removal/dedupe). This is
also where the module already does roll detection and TTS auto‑narration, so the
plumbing and guards (`ourFlags`, author checks) are already proven there.

> Do **not** use `chatMessage` (pre‑create, command‑only, may pass a non‑string
> in v14) or `preCreateChatMessage` (no stable id yet) for *indexing*. Those are
> for command interception.

Also add a **`deleteChatMessage`** hook so deleting a message evicts its vector
(`BrowserRAG.remove(id)`), keeping memory consistent — mirroring the existing
`deleteJournalEntry` handler.

### 2.4 What text to embed

`message.content` is HTML in modern Foundry (and AI narration cards wrap prose in
the Skald card markup). Strip to plain text (the same
`.replace(/<[^>]+>/g, " ")` approach `_doIndexJournalEntry` uses) and lead with
the speaker alias / source so attribution influences the embedding (mirrors how
the journal path leads with the entry name):

```
"<SpeakerAlias>: <plain-text narration body>"     // player IC/emote
"The Skald: <plain-text narration body>"          // AI story card
```

For AI cards, strip the card chrome (banner runes, title) and embed only the
`.es-body` prose so the rune glyphs / headers don't pollute the embedding.

### 2.5 Metadata schema

Store narration vectors in the **same** `journals` object store (no schema bump
needed — records are free‑form `{ id, text, vector, metadata }`). Tag them so
retrieval and maintenance can distinguish/scope/evict them:

```js
metadata: {
  type: "narration",       // distinguishes from "journal" | "session" | compendium types
  source: "ai" | "player", // who narrated it
  name: speakerAlias,      // shown in the WORLD MEMORY block label
  style: "ic" | "emote" | "ai",   // player message style, or "ai" for Skald cards
  variant,                 // AI card variant (default/lore/npc/oracle/scene/combat), else null
  user: message.author?.id,
  scene: message.speaker?.scene ?? null,
  timestamp: Date.now()
}
```

Because `indexRecord` already stamps `model`, `dims`, and `timestamp`, the
narration records are automatically model‑version‑aware and survive model
switches / reindex like any other record.

### 2.6 ID strategy (idempotency)

Use the Foundry message id directly as the vector id: `narration:${message.id}`.
The `narration:` prefix namespaces them so `!reindex` (which rebuilds from
*journal* entries) never collides, and a future "clear story memory only" command
can scan by the `narration:` prefix or `metadata.type === "narration"`.
Re‑indexing the same message id simply **replaces** the record (IndexedDB `put`),
so edits never create duplicates.

---

## 3. Latency Analysis

There are **two** latencies to reason about separately. Conflating them is the
classic mistake.

> **Why the narration‑only scope is a latency win, not just a quality one.**
> In a typical session, *most* chat traffic is **not** story: OOC banter, dice
> rolls, system notices, command echoes, "Make a Move?" prompts. Empirically that
> is often **70–90 %** of all messages. By gating on narration *before* any
> embedding work, we never embed, never store, and never have to scan the vast
> majority of messages. Every figure below (background CPU, queue depth, corpus
> growth, storage, retrieval scan cost) is therefore reduced by roughly the same
> proportion versus an "index every message" design — see §3.5 for the rollup.

### 3.1 The hot path (must stay ~0 ms)

This is the time added to *posting a chat message*. With the enqueue‑only design,
the hook does:

* a couple of synchronous boolean checks (settings read, then the narration
  classifier: a flag/variant lookup **or** a style‑enum compare),
* for the (minority of) messages that pass, an HTML strip on a short string and
  an array push.

**Budget: sub‑millisecond.** The user perceives **no** added latency when
sending a message, because embedding never runs inline — and the classifier
rejects non‑story messages after just a flag/style check, before even stripping
HTML. This is the single most important property and the design preserves it by
construction.

### 3.2 The background path (embedding cost)

This is how long the embedding itself takes on the serial queue. It does **not**
block the UI thread meaningfully when transformers.js uses WASM threads / Web
Workers, but it does consume CPU and determines how fast the queue drains.

**Per‑embedding estimates for `all-MiniLM-L6-v2` (384‑dim), short chat lines
(<128 tokens):**

| Backend | Cold (first call, incl. ~90 MB model fetch + WASM init) | Warm (per message) |
|---|---|---|
| WASM (CPU, single‑thread) | 2–6 s one‑time | ~40–120 ms |
| WASM (CPU, multi‑thread, SIMD) | 1–4 s one‑time | ~20–60 ms |
| WebGPU (when available) | 1–3 s one‑time | ~8–25 ms |

> These are order‑of‑magnitude figures for a mid‑range laptop; treat them as
> planning numbers, not guarantees. The **cold** cost is paid once per session
> (model download is browser‑cached across reloads) and the engine already lazy‑
> loads to avoid blocking the first prompts (`buildContextBlock` deliberately
> returns `""` and warms up in the background instead of blocking on the 90 MB
> fetch).

**Throughput implication.** At ~50 ms warm/message, the serial queue drains
~20 messages/second. But because **dice spam and OOC chatter are rejected by the
classifier and never enter the queue**, the queue only ever contains genuine
story beats — which arrive at human storytelling pace (seconds apart), not at
machine‑gun roll speed. A busy combat round that produces 10 dice rolls plus 2
narration beats enqueues **only the 2 beats** (~0.1 s background CPU); the rolls
cost nothing. The classic "sustained high‑volume chatter monopolising CPU" risk
is largely *designed out* by the narration gate, not merely mitigated after the
fact.

### 3.3 Retrieval‑side latency (search)

Indexing narration **grows the corpus**, which affects `search()`:

* **Linear cosine scan** is O(N·dims). At 384 dims a few thousand records score
  in a handful of ms; tens of thousands begin to add tens of ms per query.
* The engine already mitigates this: when the corpus reaches
  `ANN_MIN_CORPUS = 1000` *and* `ragUseAnnIndex` is on, it switches to the HNSW
  ANN graph (`browser-rag-hnsw.js`), turning search into roughly O(log N).

**Crucially, the narration filter keeps the corpus growth modest.** Where an
"index everything" design might add thousands of vectors per session (mostly
noise), narration‑only adds on the order of *dozens to low‑hundreds* of
genuinely useful story vectors per session. A long campaign stays comfortably
under the HNSW threshold for far longer, and even past it the graph is smaller
and faster to build. Retrieval quality also improves: the nearest neighbours are
all story, so no OOC/roll noise competes for the top‑k slots.

**Recommendation:** still expose `ragUseAnnIndex` (it's free insurance for
marathon campaigns) and a retention cap (§4.3), but neither is as urgent as it
would be for full‑chat indexing.

### 3.4 Storage latency / footprint

Each 384‑dim record is ~1.5 KB of float data (stored as a plain `Array` for
clean IndexedDB round‑tripping) plus the text slice (capped at 8000 chars in
`indexRecord`) and metadata. With narration‑only indexing, a heavy campaign might
accumulate a few thousand story vectors over its entire life — on the order of
**5–10 MB**, versus the 15–25 MB+ that indexing *all* chat for 10,000 messages
would cost. Comfortably within browser quotas, and the retention cap (§4.3) bounds
it regardless.

### 3.5 Net effect of the narrow scope (rollup)

| Dimension | Index all chat | **Index narration only** |
|---|---|---|
| Messages reaching the embed queue | ~100 % | **~10–30 %** (story only) |
| Background CPU per session | High (rolls/OOC spam) | **Low** — story arrives at human pace |
| Vectors added per session | thousands | **dozens–low hundreds** |
| Time to cross HNSW threshold | fast | **much slower** |
| Storage footprint | 15–25 MB / 10k msgs | **~5–10 MB lifetime (typical)** |
| Retrieval top‑k quality | diluted by noise | **all story, higher signal** |
| Hot‑path cost | ~0 ms (enqueue) | **~0 ms, rejects even earlier** |

The narration gate is therefore the single biggest latency optimisation in this
whole design — it removes work rather than merely scheduling it cleverly.

---

## 4. Optimization Strategies

Ordered from "always do" to "do for high‑volume tables".

### 4.1 Asynchronous, enqueue‑only indexing (mandatory)

Never `await` an embed in the hook. Enqueue and return. The existing serial
queue (`_indexJobs` + `_drainIndexQueue`) already does this for journals; the new
narration path uses the same pattern. This is what keeps the hot path (§3.1) at
~0 ms.

Keep narration on its own queue (recommended — keeps it lower‑priority and
independently batched) or share the journal queue. A dedicated story queue lets
you batch‑embed (§4.5) and drain on idle without competing with journal writes.

### 4.2 The narration gate (highest ROI — the heart of this design)

The cheapest embedding is the one you never do, and the narration classifier
(§2.2) rejects the large majority of traffic **before** any embedding, HTML
strip, or storage. Concretely, the gate enforces, in cheap‑first order:

* **Master + feature switches:** `ragEnabled` AND a new `ragIndexNarration`
  (default **off** — opt‑in).
* **Exclude non‑story Skald cards:** a card is admitted only if it is genuine
  AI narration — `flags[MODULE_ID].story === true` (preferred) **or** its
  `variant` is in the story allow‑list `{default, lore, npc, oracle, scene,
  combat}`. Cards with variant `help`/`error`/`suggest`, and `postSystem` cards
  (no variant + `eternal-skald-system` class), are rejected.
* **Exclude OOC / OTHER:** player messages are admitted only when the message
  **style** is `IC` or `EMOTE`. `OOC` and `OTHER` are rejected outright.
* **Exclude dice rolls:** reject if `message.rolls?.length` (v12+) or the v11
  `CHAT_MESSAGE_TYPES.ROLL` style — roll result cards are noise for story memory.
* **Exclude commands:** reject if the stripped content starts with `!`.
* **Exclude whispers:** reject if `message.whisper?.length` — private/hidden.
* **Require a speaker actor for player narration:** `message.speaker?.actor`
  must be set, so a stray IC‑styled system line can't slip through.
* **Length floor:** skip narration shorter than N characters
  (`ragNarrationMinChars`, default ~20) — a one‑word emote like "/em nods" adds
  little retrievable meaning.

Realistically, this gate turns "index every message" into "index only the story",
removing ~70–90 % of traffic before it ever costs CPU or storage (see §3.5).

### 4.3 Retention / rolling window (corpus hygiene)

Even story accumulates over a long campaign. Offer `ragNarrationMaxRecords`
(e.g. 4000 — higher than a full‑chat cap would need to be, because the inflow is
already filtered). When exceeded, evict the oldest narration vectors (scan
`metadata.type === "narration"`, sort by `timestamp`, delete the overflow). This
bounds both search latency (§3.3) and storage (§3.4) without touching journal or
session‑chronicle memory.

### 4.4 Debouncing / throttling bursts

Story beats arrive at human pace, so bursts are rarer than with full‑chat
indexing — but a streamed AI narration plus a player's IC reply can still land
close together. Two complementary tactics:

* **Debounce the drain trigger:** coalesce rapid enqueues so the drain kicks off
  once after a short quiet period (e.g. 250–500 ms) instead of per message. The
  queue itself is serial; debouncing avoids re‑entrancy churn and lets
  micro‑batching (§4.5) accumulate work.
* **Idle scheduling:** start/resume the drain via `requestIdleCallback` (with a
  `setTimeout` fallback) so embedding yields to interactive work like rendering
  the chat log and token movement.

### 4.5 Micro‑batching embeddings

transformers.js can embed an **array** of strings in one pipeline call, which
amortises per‑call overhead and is markedly faster than N separate calls. Drain
the queue in chunks (e.g. up to 8–16 texts), embed them together, then `put` each
resulting vector. This is the single biggest *background* throughput win for
chatty tables. (It requires a small `embedBatch` helper around the extractor; see
§5.3.)

### 4.6 Web Worker / backend optimisation

* transformers.js already offloads to **WASM threads / Web Workers** where the
  browser permits, keeping the main thread responsive. Ensure the page is
  **cross‑origin isolated** (COOP/COEP headers) so multi‑threaded WASM + SIMD are
  available — this alone can 2–4× warm throughput.
* The engine probes **WebGPU** (`detectCaps()`); when present and the chosen
  model supports it, embeddings run on the GPU (lowest latency). Narration
  indexing benefits automatically — no extra code.
* Avoid forcing a model download mid‑session: piggy‑back on the existing lazy
  init. If the model isn't ready when a narration beat arrives, the record can
  simply wait in the queue (it drains once init completes) rather than triggering
  a blocking fetch.

### 4.7 Dedupe & coalescing of edits

Use `updateChatMessage` carefully: re‑embedding on every keystroke‑level edit is
wasteful. Only re‑index on content change, debounced, re‑run the narration gate
(an edit could turn IC prose into an OOC aside), and key by the same
`narration:${id}` so the record is replaced, not duplicated. For AI cards, the
streamed `THINKING_HTML` placeholder is updated in place to the final prose — so
prefer indexing on the *final* content (the `streaming` flag flips off / content
stabilises) rather than the placeholder.

---

## 5. Code Examples

> These snippets drop into the existing files and reuse the `BrowserRAG`
> substrate. They follow the codebase's soft‑fail conventions (never throw into a
> hook).

### 5.1 New settings (`scripts/core/settings.js`)

Register alongside the other `rag*` settings (around the `ragAutoIndex` block):

```js
// Master opt-in for indexing narration/story into semantic memory.
game.settings.register(MODULE_ID, "ragIndexNarration", {
  name: game.i18n.localize("ETERNAL_SKALD.settings.ragIndexNarration.name"),
  hint: game.i18n.localize("ETERNAL_SKALD.settings.ragIndexNarration.hint"),
  scope: "world", config: true, type: Boolean, default: false   // opt-in by design
});

// Which narration sources to index.
game.settings.register(MODULE_ID, "ragNarrationSources", {
  name: game.i18n.localize("ETERNAL_SKALD.settings.ragNarrationSources.name"),
  hint: game.i18n.localize("ETERNAL_SKALD.settings.ragNarrationSources.hint"),
  scope: "world", config: true, type: String, default: "both",
  choices: {
    both:   "AI story + player IC narration",
    ai:     "AI-generated story only",
    player: "Player in-character narration only"
  }
});

// Include EMOTE messages as player narration (alongside IC). Default on.
game.settings.register(MODULE_ID, "ragNarrationIncludeEmotes", {
  name: game.i18n.localize("ETERNAL_SKALD.settings.ragNarrationIncludeEmotes.name"),
  hint: game.i18n.localize("ETERNAL_SKALD.settings.ragNarrationIncludeEmotes.hint"),
  scope: "world", config: true, type: Boolean, default: true
});

// Minimum narration length (characters) worth embedding.
game.settings.register(MODULE_ID, "ragNarrationMinChars", {
  name: game.i18n.localize("ETERNAL_SKALD.settings.ragNarrationMinChars.name"),
  hint: game.i18n.localize("ETERNAL_SKALD.settings.ragNarrationMinChars.hint"),
  scope: "world", config: true, type: Number,
  range: { min: 0, max: 500, step: 5 }, default: 20
});

// Rolling retention cap for narration vectors (0 = unlimited).
game.settings.register(MODULE_ID, "ragNarrationMaxRecords", {
  name: game.i18n.localize("ETERNAL_SKALD.settings.ragNarrationMaxRecords.name"),
  hint: game.i18n.localize("ETERNAL_SKALD.settings.ragNarrationMaxRecords.hint"),
  scope: "world", config: true, type: Number,
  range: { min: 0, max: 20000, step: 100 }, default: 4000
});
```

> Note: there is **no** "index OOC / rolls / whispers" option by design — those
> are categorically excluded as non‑story (see §1). Whispers are never indexed,
> which also avoids leaking hidden GM info into shared memory.

Add matching `name`/`hint` keys under the `ETERNAL_SKALD.settings.*` namespace in
`lang/en.json`.

### 5.2 Accessors + the narration classifier (`scripts/browser-rag.js`)

Add next to the other settings accessors (e.g. after `autoIndex()`):

```js
/** Should narration/story be embedded automatically? (opt-in) */
indexNarrationEnabled() { return this._setting("ragIndexNarration") === true; },

/** Narration sources: "both" | "ai" | "player". */
narrationSources()      { return this._setting("ragNarrationSources") || "both"; },

/** Treat EMOTE messages as player narration too? */
narrationIncludeEmotes(){ return this._setting("ragNarrationIncludeEmotes") !== false; },

/** Minimum narration length (chars) worth embedding. */
narrationMinChars()     { const n = Number(this._setting("ragNarrationMinChars")); return Number.isFinite(n) ? n : 20; },

/** Rolling cap for narration vectors (0 = unlimited). */
narrationMaxRecords()   { const n = Number(this._setting("ragNarrationMaxRecords")); return Number.isFinite(n) && n >= 0 ? n : 4000; },

/** AI card variants that are genuine STORY (not help/error/suggest UI). */
_STORY_VARIANTS: new Set(["default", "lore", "npc", "oracle", "scene", "combat"]),
```

The classifier is the **heart of the narrow scope**: a pure, cheap, synchronous
function (no embedding) that admits only AI story cards and player IC/EMOTE
narration, and rejects everything else (OOC, rolls, system/help/error/suggest
cards, commands, whispers). Returns a prepared `{ id, text, metadata }` record or
`null` to skip. Never throws.

```js
/** Resolve Foundry's message-style enum across versions (v12+ STYLES, v11 TYPES). */
_chatStyles() {
  const C = (typeof CONST !== "undefined" && CONST) || {};
  return C.CHAT_MESSAGE_STYLES || C.CHAT_MESSAGE_TYPES || { OTHER: 0, OOC: 1, IC: 2, EMOTE: 3 };
}

/**
 * Is this one of OUR Skald cards, and is it genuine STORY narration?
 * Prefers an explicit { story:true } flag; falls back to the variant allow-list.
 * Returns true (index), false (skip — it's a meta/UI card), or null (not ours).
 */
_aiStoryCard(message) {
  const f = message?.flags?.[MODULE_ID];
  if (!f) return null;                              // not a Skald card
  if (f.story === true) return true;                // explicit, unambiguous
  if (f.story === false) return false;              // explicitly non-story
  // Legacy fallback: infer from variant. (oracle PROMPT cards are UI, but the
  // explicit flag above is the recommended fix — see §2.2.)
  return this._STORY_VARIANTS.has(f.variant);
}

/**
 * Decide whether a ChatMessage is narration/story worth embedding.
 * Cheap & synchronous so it can run on the hot path.
 */
prepareNarrationRecord(message) {
  try {
    if (!this.isAvailable() || !this.indexNarrationEnabled() || !message) return null;

    const sources = this.narrationSources();         // "both" | "ai" | "player"
    const styles  = this._chatStyles();
    const style   = (message.style ?? message.type);
    const isWhisper = Array.isArray(message.whisper) && message.whisper.length > 0;
    const isRoll    = !!message.rolls?.length || style === styles.ROLL; // ROLL only exists pre-v12

    let source = null, channel = null, alias = null;

    // --- (A) AI-generated story card? ---
    const ai = this._aiStoryCard(message);
    if (ai === true) {
      if (sources === "player") return null;         // AI excluded by setting
      source = "ai"; channel = "ai";
      alias  = message.flags?.[MODULE_ID]?.alias || "The Skald";
    } else if (ai === false) {
      return null;                                   // our meta/UI card → never index
    } else {
      // --- (B) Player narration? Only IC / EMOTE, in-world, non-roll, non-whisper ---
      if (sources === "ai") return null;             // players excluded by setting
      if (isWhisper || isRoll) return null;
      const isIc    = style === styles.IC;
      const isEmote = style === styles.EMOTE && this.narrationIncludeEmotes();
      if (!isIc && !isEmote) return null;            // OOC / OTHER → reject
      if (!message.speaker?.actor) return null;      // must be spoken in-world
      source = "player"; channel = isEmote ? "emote" : "ic";
      alias  = message.speaker?.alias || message.author?.name || "Someone";
    }

    // Extract & clean text (HTML → plain). For AI cards this also strips the
    // card chrome; leading rune glyphs collapse to whitespace and are trimmed.
    const raw  = String(message.content ?? "");
    const text = raw.replace(/<[^>]+>/g, " ").replace(/[\u16A0-\u16FF]/g, " ") // runic banner glyphs
                    .replace(/\s+/g, " ").trim();
    if (!text || text.startsWith("!")) return null;            // command / empty
    if (text.length < this.narrationMinChars()) return null;   // length floor

    return {
      id: `narration:${message.id}`,
      text: `${alias}: ${text}`,
      metadata: {
        type: "narration", source, name: alias, channel,
        variant: source === "ai" ? (message.flags?.[MODULE_ID]?.variant ?? null) : null,
        user: message.author?.id ?? null,
        scene: message.speaker?.scene ?? null,
        timestamp: Date.now()
      }
    };
  } catch (_) { return null; }   // never throw into a hook
}
```

### 5.3 Async, debounced, micro‑batched indexing (`scripts/browser-rag.js`)

Add narration queue state to the internal state block (next to `_indexJobs` / `_indexBusy`):

```js
// Narration indexing: debounced, micro-batched, drains off the hot path.
_narrationJobs: [],
_narrationBusy: false,
_narrationTimer: null,
_NARRATION_DEBOUNCE_MS: 400,
_NARRATION_BATCH: 12,
```

Public entry point — fire‑and‑forget, never awaited by the hook:

```js
/** Enqueue a narration/story message for background embedding. Soft-fails. */
indexNarration(message) {
  const rec = this.prepareNarrationRecord(message);
  if (!rec) return;
  this._narrationJobs.push(rec);
  // Debounce: let bursts accumulate so we can batch-embed them.
  if (this._narrationTimer) return;
  const schedule = (cb) =>
    (typeof requestIdleCallback === "function")
      ? requestIdleCallback(cb, { timeout: 1000 })
      : setTimeout(cb, this._NARRATION_DEBOUNCE_MS);
  this._narrationTimer = schedule(() => { this._narrationTimer = null; this._drainNarrationQueue(); });
}
```

Batch‑embed helper (amortises per‑call overhead — §4.5):

```js
/** Embed an array of passages in ONE pipeline call when possible. */
async embedBatch(texts) {
  if (!this._extractor) { const ok = await this.init(); if (!ok || !this._extractor) return []; }
  const info = this._activeInfo();
  const prepared = texts.map((t) => applyPrefix(String(t || ""), "passage", info));
  try {
    const out = await this._extractor(prepared, {
      pooling: info?.pooling || "mean",
      normalize: info?.normalize !== false
    });
    // transformers.js returns a [batch x dims] tensor; slice per row.
    const dims = info.dims, data = out?.data ?? [];
    const vecs = [];
    for (let i = 0; i < texts.length; i++) vecs.push(Array.from(data.slice(i * dims, (i + 1) * dims)));
    return vecs;
  } catch (err) {
    this._debug("embedBatch failed, falling back to serial:", err?.message || err);
    // Soft fallback: embed one at a time so a single bad input can't drop the batch.
    const vecs = [];
    for (const t of texts) vecs.push(await this.embed(t, { role: "passage", cache: false }));
    return vecs;
  }
}
```

Serial, idle‑friendly drain with retention enforcement:

```js
async _drainNarrationQueue() {
  if (this._narrationBusy) return;
  this._narrationBusy = true;
  try {
    while (this._narrationJobs.length) {
      const batch = this._narrationJobs.splice(0, this._NARRATION_BATCH);
      const vecs  = await this.embedBatch(batch.map((b) => b.text));
      for (let i = 0; i < batch.length; i++) {
        const vec = vecs[i]; if (!vec?.length) continue;
        const b = batch[i];
        try {
          await this._store.put({
            id: b.id, text: b.text.slice(0, 8000), vector: vec,
            metadata: { model: this._activeModelId(), dims: vec.length, ...b.metadata }
          });
        } catch (e) { this._debug("narration put failed:", e?.message || e); }
      }
      this._invalidateCorpus();
      // Yield between batches so the UI stays responsive on long bursts.
      await new Promise((r) => setTimeout(r, 0));
    }
    await this._enforceNarrationRetention();   // §4.3
  } catch (e) {
    this._debug("narration drain failed:", e?.message || e);
  } finally {
    this._narrationBusy = false;
  }
}
```

Retention sweep (bounds corpus growth — §3.3 / §4.3):

```js
async _enforceNarrationRetention() {
  const cap = this.narrationMaxRecords();
  if (!cap) return;                       // 0 = unlimited
  try {
    const all  = await this._getCorpus();
    const recs = all.filter((r) => r?.metadata?.type === "narration")
                    .sort((a, b) => (a.metadata.timestamp || 0) - (b.metadata.timestamp || 0));
    const overflow = recs.length - cap;
    for (let i = 0; i < overflow; i++) await this._store.delete(recs[i].id);
    if (overflow > 0) { this._invalidateCorpus(); this._debug(`narration retention: evicted ${overflow}`); }
  } catch (e) { this._debug("narration retention failed:", e?.message || e); }
}
```

### 5.4 Hooking narration creation/edit/deletion (`scripts/hooks/foundry-hooks.js`)

`BrowserRAG` is already imported here. Add near the existing `createChatMessage`
/ `deleteJournalEntry` handlers. The classifier (`prepareNarrationRecord`) does
all the filtering, so the hooks stay dumb — they just enqueue every message and
let the gate reject non‑narration:

```js
// --- Narration → RAG memory (opt-in). Enqueue only; never blocks posting. ---
Hooks.on("createChatMessage", (message) => {
  try { BrowserRAG.indexNarration?.(message); }
  catch (_) { /* soft-fail: memory must never break chat */ }
});

// Re-embed on meaningful edits (debounced inside indexNarration; same id replaces).
// Crucial for AI story cards: callSkaldStreaming posts a THINKING placeholder, then
// patches in the final prose via updateChatMessage — so the *edit* carries the real
// narration. Re-running the gate here indexes the final content, not the placeholder.
Hooks.on("updateChatMessage", (message, changed) => {
  try { if (changed?.content !== undefined) BrowserRAG.indexNarration?.(message); }
  catch (_) { /* soft-fail */ }
});

// Evict a message's vector when it's deleted (mirrors deleteJournalEntry).
Hooks.on("deleteChatMessage", (message) => {
  try { BrowserRAG.remove?.(`narration:${message.id}`); }
  catch (_) { /* soft-fail */ }
});
```

> A *separate* second `createChatMessage` handler (rather than editing the
> existing command/roll/TTS handler) keeps the concern isolated and trivially
> removable. Foundry happily runs multiple handlers for the same hook.
>
> **Streaming note:** because `callSkaldStreaming` mutates the same message in
> place while tokens arrive, `indexNarration` keys on `narration:${id}` so each
> re-embed *replaces* the prior vector — the corpus only ever holds the final,
> complete narration for a given card, never a half‑streamed fragment.

### 5.5 Optional: status surface (`!rag-status`)

For parity with `!reindex` / `!rag-status`, expose a narration count so GMs can
see narration‑memory health. In `BrowserRAG.status()` compute a `narration` count
by filtering the corpus on `metadata.type === "narration"` (optionally split by
`metadata.source` into `ai` / `player` sub‑counts), and render it in the status card.

---

## 6. Recommended Defaults & Rollout

| Setting | Default | Rationale |
|---|---|---|
| `ragIndexNarration` | **off** | Opt‑in: changes corpus growth & privacy surface. |
| `ragNarrationSources` | `both` | Index AI story cards *and* player IC/EMOTE prose — the full shared story. Narrow to `ai` or `player` if desired. |
| `ragNarrationIncludeEmotes` | `on` | EMOTE (`*draws his axe*`) is in‑world action — genuine narrative signal. |
| `ragNarrationMinChars` | `20` | Drops "k"/"lol"/one‑word emote spam — saves CPU & storage. |
| `ragNarrationMaxRecords` | `2000` | Bounds search latency & IndexedDB footprint. |
| `ragUseAnnIndex` | recommend **on** when narration‑RAG is enabled | Keeps retrieval ~O(log N) past 1000 records. |

> Note there is **no** whisper / OOC / roll toggle: those channels are rejected
> unconditionally by the classifier (§5.2), not gated behind a setting. Narration
> RAG is, by definition, story‑only — exposing a "also index OOC" switch would
> reintroduce exactly the noise this scope was built to avoid.

**Rollout suggestion:** ship behind `ragIndexNarration=false`, document it, and add
a first‑run/settings hint that turning it on for busy tables should be paired with
`ragUseAnnIndex` and a sensible retention cap. Strongly recommend adding the explicit
`flags["the-eternal-skald"].story` boolean to Skald cards at the point they're posted
(§2.2) so AI‑story detection never depends on the `variant` allow‑list. Add a
`test/*.test.mjs` source‑guard (the repo's framework‑free style) asserting the hooks
are wired and `prepareNarrationRecord` admits IC/EMOTE + story cards while rejecting
OOC, rolls, whispers, and help/error/suggest cards.

---

## 7. Summary

* **Scope:** Index **narration/story only** — AI‑generated Skald story cards
  *and* player IC/EMOTE prose. Exclude everything else: OOC chat, dice rolls,
  system/help/error/suggest cards, slash‑commands, and whispers. This is enforced
  in one place — the `prepareNarrationRecord` classifier (§5.2).
* **Design:** Hook `createChatMessage` (+ `updateChatMessage`/`deleteChatMessage`),
  run the cheap synchronous classifier (`prepareNarrationRecord`), then **enqueue**
  into a dedicated serial narration queue → batch embed → `_store.put`. Tag records
  `type:"narration"` (with `source:"ai"|"player"`), key them `narration:${id}`.
  No DB schema change required.
* **Detection:** AI story = our Skald card with explicit `flags["the-eternal-skald"].story === true`
  (recommended) or, as a fallback, a story `variant` from the allow‑list (excludes
  `help`/`error`/`suggest`, and the `oracle` UI‑prompt cards). Player narration =
  Foundry message `style` of `IC` or `EMOTE` (via `CONST.CHAT_MESSAGE_STYLES`),
  spoken by an actor, with no rolls/whisper/command.
* **Latency:** The **hot path stays ~0 ms** because embedding never runs inline.
  The narrow scope makes background cost *lower still* — the classifier rejects
  the bulk of traffic (rolls, OOC, system cards) before any embedding, so far fewer
  messages are ever queued or stored. Warm embeddings cost ~20–120 ms each in the
  background (faster with WebGPU / multi‑thread WASM / batching); cold model load
  is paid once and browser‑cached. A smaller, story‑only corpus also keeps
  retrieval fast and IndexedDB lean.
* **Optimisation:** async enqueue‑only (mandatory) → narration‑only classifier
  (highest ROI — fewest records) → retention window → debounce + idle scheduling →
  micro‑batching → cross‑origin isolation / WebGPU → streaming edit‑dedupe.
* **Safety:** every path soft‑fails, exactly like the existing RAG code — narration
  indexing can never break play.
