# The Eternal Skald

An AI-powered storyteller, oracle interpreter, and tactical enemy controller for **Ironsworn** and **Ironsworn: Delve** campaigns in Foundry Virtual Tabletop v14. The Eternal Skald is a wise, dramatic norse narrator who serves as the GM at your table — interpreting oracle rolls, voicing NPCs, generating lore, narrating combat, and even taking control of enemy combatants on their turn.

Powered by the **Abacus AI ChatLLM** platform (Gemini 3.0 Flash by default).

> ⚠️ **Alpha / Development Version (v0.15.0)** — This is experimental pre-release software under active development. Expect rough edges, breaking changes between versions, and features that may not yet work in every configuration. It is **not** production-ready. Please back up your world before use and report issues you run into. See [Versioning & Release Strategy](#versioning--release-strategy) for what the version numbers mean.

As of **v0.3.0**, the Skald integrates directly with the official [**foundry-ironsworn**](https://foundryvtt.com/packages/foundry-ironsworn) system: it reads your character's stats and meters, *suggests* the right Ironsworn move, triggers the system's own dice mechanics on one click, narrates the official strong-hit / weak-hit / miss outcome, and can optionally apply mechanical effects. See [Ironsworn Integration](#ironsworn-integration) below. The module still works standalone in any system — Ironsworn features simply activate when the system is present.

**New in v0.10.27 — sharper foe tracks and a Skald that finishes what it starts.** Combat (foe) tracks now render with a proper rank/progress label instead of the raw `IRONSWORN.ITEM.SubtypeFoe` key, and an idempotent legacy-repair pass migrates any old `"foe"`-subtype tracks already on your sheet. The Skald also gained **story-arc awareness** — it remembers the focus vow and the active fight via actor flags — and can now **advance or conclude tracks straight from the fiction** with three fuzzy-matched, GM-audited write directives (`[[MARK_COMPLETE:…]]`, `[[ADD_PROGRESS:…]]`, `[[SET_PROGRESS:…]]`). A **Strong Hit** on *Fulfill Your Vow* / *End the Fight* / *Reach Your Destination* now auto-completes the matching track (a weak hit or miss never does). Backed by a new 55-assertion test suite.

**New in v0.10.26 — the Skald knows when a track is ready to close.** A read-only context enhancement now labels every progress track with its fullness (`7/10 boxes - NOT YET FULL` vs `10/10 boxes - ✅ READY TO FULFILL/END/REACH`), flags the active fight and the **[STORY FOCUS]** vow, and groups vows and journeys in the game state the Skald reads. The AI prompt was hardened so the Skald will **not offer or self-complete a track until it is 10/10** (with an explicit player-override exception) — fixing premature conclusions. Phase 1 is strictly read-only (no writes to actor data).

**New in v0.10.25 — observe-only asset & XP tracking.** The Skald now quietly *observes* your character's assets and experience without ever mutating the sheet, giving it the context it needs to reference your gear and progress accurately in narration.

**New in v0.10.24 — sharper eyes for the Skald (better map reading).** Map vision now reads maps far more reliably, especially the **text labels, place names, and small symbols** that weaker models used to miss on compressed images. Three things changed: (1) the captured map is now sent at **higher resolution (up to 4096&nbsp;px)** and as a **lossless PNG** by default — no more JPEG smear over tiny lettering; (2) a new **Map Analysis Quality** setting can split a large map into a **grid of overlapping sections** and read each one closely (*Thorough*), or do a single quick pass (*Fast*), with a sensible **Balanced** middle ground; and (3) the cartographer prompt was rewritten to explicitly hunt for **labels, route lines, faint paths, structures, and terrain**, and to report a **confidence** for each find (low-confidence points are flagged rather than dropped). The model picker now **★-marks the strongest map readers** and **warns when a weak model** (e.g. `gpt-4o-mini`) is chosen for on-demand scouting. Two more new settings — **Max Map Resolution** and **Image Format** — let you trade detail against token cost. See [Map Vision (Image Analysis)](#map-vision-image-analysis).

**New in v0.10.23 — the Skald *sees* your map (true image vision).** Where v0.10.22 read the scene's *metadata* (names, pins, tokens), the Skald can now **look at the actual background map image** and describe what's on it. On loading a scene it quietly **captures the background image** (downscaled and JPEG-compressed for efficiency), sends it to a **vision-capable AI model**, and turns the reply into a short **scouting report** plus a set of **points of interest** that are auto-scribed into your journal as **location** entries (linked to the scene and de-duplicated). Run **`!scout`** (aliases **`!survey`**, **`!analyze-map`**) to force a fresh look at the current map. Two new world settings govern it — **Auto-Analyze Scenes** (on by default) and **Vision Model** (which model does the looking; see [Map Vision (Image Analysis)](#map-vision-image-analysis) for the supported models and their token costs). It analyses **only the base map image** — never tokens, fog of war, drawings, or hidden GM content — caches each result per-scene so you're never billed twice, and degrades gracefully (no scene, no image, a non-vision model, or a network hiccup all simply do nothing).

**New in v0.10.22 — the Skald can see your map.** The Skald now reads your **active scene** (read-only) and weaves a concise picture of it into its context: the **current scene name**, the **marked locations** on the map (journal-pin notes, resolved to the journal entry each pin links to), and the **notable visible tokens** (hidden, GM-only tokens are never exposed). With the map in view, the Skald may reference those **real places by name** — especially when suggesting where a journey or vow might lead — yet it keeps things natural: it never forces a location into the story and never invents a pin that isn't on the map. The feature is purely additive, **never manipulates the scene**, stays token-efficient, and quietly does nothing when no scene is active.

**New in v0.10.21 — "Reach a Milestone" no longer double-marks your vow.** Triggering *Reach a Milestone* (by clicking its inline link in the narration, or from the move list) used to mark progress on your active vow **twice**: once when the move was triggered, and again during the follow-up outcome narration. The track therefore jumped by *2× rank* instead of the correct one mark. The narration step is now told the mechanics were already applied, so it narrates the single, correct result and never re-marks. The milestone recognises both Ironsworn and Starforged `reach_a_milestone` moves and works on vows you swore by hand on the sheet. Backed by a new end-to-end test covering the full *triggerMove → mark-progress* chain.

**New in v0.10.20 — "Reach a Milestone" marks progress automatically.** The milestone move has no dice — it simply marks progress on your active vow by its rank. The Skald now enacts it deterministically (find the newest open vow, mark progress by rank, narrate it) whether you click the inline link or the AI narrates it. *(Superseded by the double-mark fix in v0.10.21.)*

**New in v0.10.19 — Bulletproofed the AI-prompt templates (and definitive proof the code is clean).** The foe-prompt template literals contained `` \`unique\` `` escaped backticks — valid JavaScript, but the kind of fragile detail that kept getting blamed for the line-1342 `missing ) after argument list` error. They are now written with plain quotes (`'unique'`), so there are **zero escaped backticks left in the file** and the template can never be misread as unterminated. The current script is verified clean in **five independent parsers**: Node/V8 in *script* mode, Node/V8 in *module* mode, Acorn, Babel, and a **real Chrome ES-module load** (it parses and executes — failing only later at runtime on the Foundry-only `Hooks` global, which proves there is no parse error). **If you still get `missing ) after argument list` at line 1342, you are loading a cached copy of an old script, not this code.** Fully update the module (which re-downloads the files), then **hard-refresh** (`Ctrl+Shift+R` / `Cmd+Shift+R`) or restart Foundry. No functional change.

**New in v0.10.18 — Republished to clear stale caches.** If the module still failed to load with the `missing ) after argument list` syntax error (reported around **line 1342**) *even after* updating to v0.10.17, the cause is a **stale cached copy** of the old script in your browser or Foundry client — not a remaining error in the code. The committed script is verified clean: it parses without error in strict ES-module mode (the same mode Foundry uses), all unit tests pass, and the previously-stray backticks are confirmed escaped. This release simply **republishes that verified script and bumps the version** so Foundry re-downloads it, and syncs the stale `v0.6.0` header comment to the real version. No functional change from v0.10.17. If you still see the error after updating, do a **hard refresh** (`Ctrl+Shift+R` / `Cmd+Shift+R`) or fully restart Foundry to flush the cached module.

**New in v0.10.17 — Critical hotfix (module failed to load).** Fixes a JavaScript `missing ) after argument list` syntax error that broke the module entirely. Three un-escaped backticks (around the word `unique`) inside an AI-prompt template literal — added with the v0.10.14 foe-catalogue prompt — prematurely closed the template string. It slipped through because `node --check` parses `.js` files in non-strict *script* mode (which tolerated it), whereas Foundry loads the file as an ES *module* (strict mode), where it was a hard parse error. The backticks are now escaped and every script is validated in strict module mode.

**New in v0.10.16 — Clean slate for a new campaign.** A new GM-only command, `!skald-reset` (alias `!skald-wipe`), lets you wipe the Skald's chronicle so you can start a fresh saga without dragging the old one along. It first shows a **confirmation dialog** summarising exactly what will be erased; on confirmation it **deletes every unlocked Skald-scribed journal entry**, **wipes the semantic memory (RAG) vector store**, **resets the conversation history**, and **empties the campaign timeline** — then whispers a GM-only report listing the counts of everything that was cleared. Two safety guarantees: your **own journals are never touched** (only entries the Skald itself scribed are eligible for deletion), and any entry you want to keep can be **locked** by setting its `the-eternal-skald.locked` flag to `true` — locked entries are preserved and reported separately. The command is GM-only; players who try it are politely turned away. Macro-friendly too: pass `force` (e.g. `!skald-reset force`) to skip the confirmation dialog. Purely additive and degrades gracefully.

**New in v0.10.15 — Journeys that just work.** Undertaking a journey now reliably tracks. When you roll **Undertake a Journey** and have no open journey track, the Skald **automatically opens one** — named for your destination when it can infer it (e.g. *"Journey to the Frozen Keep"*), otherwise a clean generic title — and, on a hit, **marks progress on it by its rank**. This fixes the error where **Reach Your Destination** failed with *"No open journey track to roll against"* because no track had ever been created. Beyond journeys, the Skald can now **advance or complete a specific vow/journey by its exact title straight from the fiction**: a new `[[EFFECT: mark_progress "Your Vow Title"]]` directive marks the named track (matched against your real sheet tracks), and narrative completion (`complete_vow` / `complete_journey`) no longer requires rolling a progress move first. To keep the AI precise, your **open vows and journeys are now listed by their exact titles** in the live game state the Skald reads, and it is instructed to reference them by title rather than guessing or using a move name. Purely additive and degrades gracefully.

**New in v0.10.14 — Real foes from the official compendia.** The Skald no longer invents foe names for ordinary fights. The full catalogue of foes from the official **foundry-ironsworn** foe compendia (*Ironsworn Foes* + *Ironsworn: Delve Foes*) is loaded and cached on world load, embedded into the AI prompt grouped by rank, and the Skald is instructed to draw **regular encounters from that list verbatim** — so combat tracks get the foe's *canonical rank* straight from the rulebook (no rank guessing). **Important narrative foes** — a named boss or unique antagonist the story is built around, who isn't in the compendia — may still be **custom-created**: the Skald gives them an explicit rank and marks them with a `unique` keyword (e.g. `[[EFFECT: create_combat Hrafn the Oathbreaker formidable unique]]`) so they are sized deliberately and never flagged as a mistake. If a *routine* foe turns out not to be an official compendium foe, the Skald whispers a gentle GM-only advisory (with the closest official match, when there is one) so you can swap it if you like. Purely additive and degrades gracefully — if the compendia aren't available the catalogue is simply omitted and foe creation still works.

**New in v0.10.13 — Vow tracking reads straight from your sheet.** The Skald's vow/track cards are now bound to the **foundry-ironsworn items on your character sheet** as the single source of truth, read *fresh* every time. This fixes a bug where the card could show a **phantom vow** — e.g. a track literally named *"Vow"*, rank 1, *0/10 boxes*, marked *✓ complete* — completely disconnected from your real, open vow (*"The Truth of the Star-Fall"*, formidable, 3/10 boxes). Progress is read from `system.current` (ticks ÷ 4 = boxes) and completion from `system.completed`, so the card always mirrors the sheet exactly; marking progress writes back to the item immediately. Clicking the bare word *"vow"* in narration now opens your **actual current vow** rather than a generic match, and common nouns like *"vow"* / *"journey"* are no longer turned into misleading phantom links (a real vow's name is still linked normally).

**New in v0.10.12 — Works on hosted Foundry (direct browser→AI fallback).** The Skald used to reach the AI *only* through its same-origin server hook (`/skald-api/chat`), which requires starting Foundry with the `node --import …` flag. On hosted/managed Foundry (e.g. *Foundry VTT on Abacus*) you usually can't add that flag, so the hook never loaded and every AI call hit Foundry's own **404 (Not Found)** page — visible in the browser console as `…/skald-api/chat … 404`. The Skald now **automatically falls back to calling the AI directly from your browser** when the hook isn't present, so it works out of the box on hosted platforms. A new **Connection Mode** setting (*Auto* — default, *Server hook only*, *Direct browser→AI*) lets you control this. The default Abacus AI endpoint allows the cross-origin (CORS) request, so no extra setup is needed; the server hook remains supported and optional for self-hosters who prefer to keep the API key off the client.

**New in v0.10.11 — Vow & journey completion fix.** Fulfilling a vow or reaching a destination now closes the **correct track**. Previously, completing a quest right after a *Fulfill Your Vow* / *Reach Your Destination* roll could fail with «Track "Reach Your Destination" not found», because the completion logic searched for a track named after the **move** rather than your real, player-named vow or journey. The Skald now remembers which track a progress move actually rolled against and closes *that* one. If the AI is unsure of the exact name (or omits it), completion falls back to the most recent open vow/journey of the matching kind — so a fulfilled vow always closes the track you meant.

**New in v0.10.10 — Move suggestions woven into the prose.** Suggested moves are no longer posted as separate *A Move Beckons* / *What Comes Next* cards. The Skald now names the fitting move **inside its narration**, where it renders as a subtle **clickable link woven into the story** — in ordinary narration (`!skald`, `!scene`, `!combat`) *and* in the **post-roll outcome narration** after a move resolves. Clicking the link still rolls the move through the progress-aware path (so progress moves like *Reach Your Destination* / *Fulfill Your Vow* roll against their track), and stray directives never leak into the chat. The result reads as a single, uninterrupted saga rather than a string of suggestion bubbles.

**New in v0.10.9 — Faithful progress-track integration.** After studying the live [**foundry-ironsworn**](https://github.com/ben/foundry-ironsworn) source, the Skald now creates vows, journeys, bonds and combat foes *exactly* as the system itself does: a single Item type `progress` distinguished only by `system.subtype` (`vow` / `progress` / `bond` / `foe`), with proper numeric challenge ranks (1–5) and tick-based progress (4 ticks = 1 box). A stray, non-schema `notes` field was removed, the standard high sort order is applied so new tracks land at the list's end, and combat foes now use the system's real `foe` subtype. The Skald also **recognises tracks you create by hand on the sheet** — sworn vows, journeys and foes — so marking progress, completion, and the *Fulfill Your Vow* / *Reach Your Destination* rolls work on them too.

**New in v0.10.8 — Inline move suggestions return.** Move suggestions are once again woven as **clickable links inside the narration** (reverting the separate *A Move Beckons* / *What Comes Next* button-cards). Clicking an inline move link now routes through the progress-aware trigger, so **progress moves like *Reach Your Destination* roll correctly** instead of failing with "no dialog and no rollable stat". Journey-track lookup gained a **fallback** that finds legacy or hand-made journey tracks (older `progress`-subtype tracks without the journey flag), and **vow / journey creation now surfaces failures** — if there is no active character or the data is rejected, the Skald whispers the GM exactly why instead of failing silently.

**New in v0.6.0 — Clickable entities in narration.** Names the Skald speaks are now linked inline in chat. NPCs, locations and discoveries already scribed into the [Living Chronicle](#the-living-chronicle-auto-journaling) become Foundry content links that open their Journal Entry, and known Ironsworn moves become one-click links that open the **foundry-ironsworn system's own official move dialog** directly (resolved by the move's Datasworn ID). A new world setting **Link Entities in Narration** (default on) toggles the feature; it is purely additive and degrades gracefully — unmatched names stay plain text and nothing ever breaks narration.

**New in v0.5.0 — AI Memory (Browser-Based RAG).** The Skald now *remembers your whole saga*. Every chronicle entry is embedded into a private, **in-browser** semantic memory, and the most *relevant* NPCs, locations, facts and threads are recalled automatically before the Skald speaks — so continuity holds across sessions without bloating the prompt. It runs entirely in your browser (no server, no cloud, no extra API keys); a small model downloads once and is cached. `!remind` is now semantic, joined by `!reindex` and `!rag-status`. See [AI Memory (Browser-Based RAG)](#ai-memory-browser-based-rag) below.

**New in v0.4.0 — the Living Chronicle.** The Skald now **automatically scribes your saga into Foundry Journal Entries** as you play: NPCs, locations and discoveries each get their own entry, while world facts and story threads accumulate in rolling journals — all organized into folders under *The Eternal Skald*. It runs quietly in the background and never interrupts narration. Review your world with `!journals`, `!mysteries` and `!remind`, or close out a play session with `!end-session` for a saga-styled recap. See [The Living Chronicle](#the-living-chronicle-auto-journaling) below.

---

## Setup (3 steps)

### 1. Install the module

In Foundry VTT: **Setup → Add-on Modules → Install Module**. Paste this manifest URL:

```
https://raw.githubusercontent.com/papicy/the_eternal_skald/main/module.json
```

Click **Install**, then activate the module in your world.

### 2. (Optional) Add `--import` to your Foundry startup

> **As of v0.10.12 this step is optional.** By default (**Connection Mode → Auto**) the Skald automatically calls the AI directly from your browser when the server hook isn't loaded, so it works on hosted/managed Foundry with **no startup changes**. Use the server hook below only if you self-host and prefer to keep your API key off the client / route AI traffic through the server.

The server hook makes AI calls **server-side** so the API key never reaches the browser and there are no CORS considerations. To enable it, add the `--import` flag to how you start Foundry:

**Linux / macOS:**
```bash
node \
  --import ./Data/modules/the-eternal-skald/scripts/eternal-skald-server.mjs \
  resources/app/main.mjs \
  --dataPath=/your/foundry/data
```

**systemd service (edit your existing `ExecStart=`):**
```ini
ExecStart=/usr/bin/node \
  --import /absolute/path/to/Data/modules/the-eternal-skald/scripts/eternal-skald-server.mjs \
  /path/to/foundryvtt/resources/app/main.mjs \
  --dataPath=/path/to/foundrydata
```

**PM2:**
```bash
pm2 start /opt/foundry/resources/app/main.mjs \
  --name foundry \
  --node-args="--import /opt/foundry/Data/modules/the-eternal-skald/scripts/eternal-skald-server.mjs" \
  -- --dataPath=/opt/foundry
pm2 save
```

**Docker (override entrypoint):**
```yaml
services:
  foundry:
    entrypoint: ["node",
      "--import", "/data/Data/modules/the-eternal-skald/scripts/eternal-skald-server.mjs",
      "/home/foundry/resources/app/main.mjs"]
    command: ["--dataPath=/data"]
```

**Windows:**
```cmd
node --import "./Data/modules/the-eternal-skald/scripts/eternal-skald-server.mjs" resources/app/main.mjs --dataPath=C:\foundry-data
```

When Foundry starts, you should see this in the console/logs:

```
⚔️  Skald | v0.15.0 — server hook active. /skald-api/* routes ready.
```

### 3. Set your API key

In your world: **Configure Settings → The Eternal Skald → Abacus AI API Key**. Enter your key and save.

**That's it.** Type `!skald-help` in chat.

---

## Verify it works

Open this URL in any browser that can reach your Foundry (replace host/port):

```
http://your-foundry:30000/skald-api/health
```

You should see:

```json
{"status":"ok","service":"The Eternal Skald","version":"0.15.0"}
```

If you get a 404 or Foundry's normal HTML page, the `--import` flag isn't taking effect. Double-check:
- The `--import` flag comes **before** `resources/app/main.mjs`
- The path to `eternal-skald-server.mjs` is correct and absolute
- You fully restarted Foundry (not just a browser refresh)

---

## How it works

```
Browser (Foundry)                    Foundry Server (Node.js)
     │                                       │
     │  fetch("/skald-api/chat")             │
     │ ─────────────────────────────────────►│
     │   (same origin — no CORS)             │
     │                                       │  HTTPS request to
     │                                       │  routellm.abacus.ai
     │                                       │ ──────────────────►  Abacus AI
     │                                       │ ◄──────────────────
     │  JSON response                        │
     │ ◄─────────────────────────────────────│
     │                                       │
```

The server hook (`eternal-skald-server.mjs`) is loaded into Foundry's Node.js process via `--import`. It intercepts any HTTP request to `/skald-api/*` before Foundry/Express sees it, makes the upstream API call server-side (where there are no browser CORS restrictions), and returns the response.

As of **v0.3.3** the hook also exposes `POST /skald-api/chat-stream`, which opens the upstream request with `stream: true` and pipes the LLM's Server-Sent-Events token stream straight back to the browser so the Skald's reply can render in real time. If streaming is unavailable (older hook, a non-streaming proxy, or an early error) the client falls back automatically to the buffered `/skald-api/chat` path — so it always works.

Because `/skald-api/chat` is on the **same origin** as Foundry itself:
- ✅ Works with HTTP and HTTPS
- ✅ Works behind reverse proxies (Nginx, Caddy, Apache, Cloudflare)
- ✅ Works with any domain name or IP address
- ✅ No CORS headers needed
- ✅ No Mixed Content issues
- ✅ No extra ports to open
- ✅ No separate proxy process to manage

---

## Ironsworn Integration

When the official **foundry-ironsworn** system is active, The Eternal Skald becomes more than a narrator — it becomes a true GM brain wired into the game's rules engine. The division of labour is deliberate:

- **The Skald (AI) is the GM brain.** It interprets the fiction, decides *which* Ironsworn move fits the moment, and narrates outcomes in saga style.
- **The foundry-ironsworn system is the rules engine.** It owns the dice, the action/challenge die mechanics, momentum burning, and the character sheet. The Skald never fakes a roll — it asks the system to roll, then reads the *real* result.

### The hybrid flow

```
   You describe what you do
            │
            ▼
   Skald narrates + SUGGESTS a move      ◄── "[[MOVE: Face Danger | iron]]"
            │
            ▼
   ┌──────────────────────────────┐
   │  Interactive suggestion card │
   │  [ ⚔ Roll Face Danger ]      │   ← one click
   │  [ 🎲 Choose Different Move ] │   ← you override
   └──────────────────────────────┘
            │
            ▼
   foundry-ironsworn rolls the dice  (its own dialog / mechanics)
            │
            ▼
   Skald reads the official result and NARRATES
   strong hit / weak hit / miss in the fiction
            │
            ▼
   (optional) Skald APPLIES effects: momentum, harm,
   stress, supply, progress, oracle rolls
```

At every step **you stay in control** — you can take the suggested move, pick a different one, or ignore the card entirely and roll from your sheet as usual. If you roll a move yourself, the Skald still notices and narrates the outcome (when *Auto-Narrate Move Outcomes* is on).

### What the Skald can read

The active character's stats (`edge`, `heart`, `iron`, `shadow`, `wits`), meters (`health`, `spirit`, `supply`, `momentum`), debilities, and progress tracks (vows, journeys, fights, bonds, Delve sites) are gathered client-side and injected into the AI's context, so move suggestions are grounded in your real situation.

### Moves the Skald knows

The full classic Ironsworn move set plus the Delve and Ironsworn moves — Face Danger, Secure an Advantage, Gather Information, Compel, Strike, Clash, Turn the Tide, Battle, Endure Harm, Endure Stress, Face Death, Swear an Iron Vow, Reach a Milestone, Fulfill Your Vow, Undertake a Journey, Reach Your Destination, Make Camp, Sojourn, Discover a Site, Delve the Depths, Locate Your Objective, and more — each mapped to its Datasworn move ID and default stat(s).

### Effect directives

With **AI Applies Mechanical Effects** enabled (now **on by default**), the Skald may follow its narration with mechanical changes to the active character — adjusting momentum, dealing harm/stress, spending or restoring supply, marking progress on a track, rolling an oracle, or running the [combat automation](#combat-system). Turn it **off** if you'd rather keep the player in full control of the sheet.

### Settings that govern integration

| Setting | Default | What it does |
|---|---|---|
| Ironsworn Rules Integration | On | Master switch. Read state, trigger moves, narrate outcomes. No effect if the Ironsworn system isn't installed. |
| Suggest Moves | On | Show the interactive move-suggestion card after narration. |
| Auto-Narrate Move Outcomes | On | Automatically narrate any Ironsworn roll's result. |
| Narration Delay (ms) | 2000 | How long to wait after a roll before auto-narrating, so dice animations can finish. ~2000ms with Dice So Nice, ~500ms without. Range 0–5000. |
| AI Applies Mechanical Effects | **On** | Let the Skald apply momentum/harm/stress/supply/progress/oracle effects **and** drive the combat automation. |
| Show Effect Announcements | On | Post the brief *"The Skald enacts: …"* whisper messages that announce the mechanical effects applied. Turn **off** to hide these technical notices while keeping the narration. Per-client. |
| Auto-Create Combat Tracks | On | Auto-create a combat progress track per foe when a fight begins. Requires *AI Applies Mechanical Effects*. |
| Default Enemy Rank | Dangerous | Fallback rank for **custom** foes only — used when the Skald invents a foe that isn't in the Ironsworn foe compendium *and* doesn't specify a rank. Standard foes (Bear, Wolf, Wyvern, …) automatically use their official compendium rank. |
| Debug Logging | Off | Verbose integration diagnostics in the browser console (F12). |

---

## Combat System

From **v0.3.0**, the Skald runs Ironsworn fights for you. Combat in Ironsworn is tracked with a **progress track per foe** (filled by landing blows) plus a single **initiative** state telling you whether you're *in control* or *in a bad spot*. The Skald creates and advances these automatically.

### Automatic combat-track creation

When the fiction starts a fight, the Skald emits `[[EFFECT: create_combat <Foe Name> [rank]]]` and a combat progress track is created on your character sheet for that foe. Each new foe gets its own track, so multi-enemy fights just work. The **rank** sets how much progress each hit marks:

| Rank | Threat | Progress per harm | Boxes to fill |
|---|---|---|---|
| Troublesome | trivial | +12 ticks (3 boxes) | ~4 hits |
| Dangerous | a real threat | +8 ticks (2 boxes) | ~5 hits |
| Formidable | tough | +4 ticks (1 box) | 10 hits |
| Extreme | deadly | +2 ticks | 20 hits |
| Epic | legendary | +1 tick | 40 hits |

### Where the rank comes from (compendium lookup)

From **v0.3.1**, the rank usually comes straight from the **official Ironsworn foe compendium** — you (and the Skald) rarely need to specify it. When a track is created, the rank is resolved in this order:

1. **Explicit rank** — if the Skald (or you) provides a rank, it's always honoured. This is how *unique/custom* foes get a rank.
2. **Compendium lookup** — if no rank is given, the foe name is looked up in the installed Ironsworn foe compendia (*Ironsworn Foes*, *Delve Foes*, *Starforged Encounters*, and any compatible third-party foe packs). On a match, that foe's **official challenge rank** is used. Matching is forgiving: it's case-insensitive, ignores articles/punctuation, handles plurals and simple variations (`dire wolf` → Wolf), and tolerates typos (`wyvrenn` → Wyvern). Close-but-uncertain names are logged as a suggestion.
3. **Default** — only if the foe isn't in any compendium *and* no rank was given does it fall back to the **Default Enemy Rank** setting (Dangerous).

So **standard foes** (Bear, Wolf, Wyvern, Basilisk, Troll, Bandit, Hollow, …) should be created with just a name — they automatically get their canonical rank (e.g. Bear → *formidable*, Wolf → *dangerous*, Wyvern → *extreme*). Only **invented foes** with no compendium entry need an explicit rank.

The lookup index is built once per session and **cached**; it's cleared automatically on world reload. Enable **Debug Logging** to see which path was taken (`Using compendium rank for …` vs `Custom enemy …`).

Turn off **Auto-Create Combat Tracks** to disable all of this and create foe tracks manually.

### Initiative & deterministic move resolution

When you roll **Enter the Fray**, **Strike**, or **Clash**, the Skald applies the mechanics itself (so the rules stay correct no matter how it narrates):

- **Enter the Fray** — strong/weak hit → you **gain initiative**; miss → you're in a **bad spot**.
- **Strike / Clash** — on a hit, the active foe's track is **marked by its rank**; a **strong hit keeps** initiative, a **weak hit loses** it; a **miss loses** initiative.

Because these are auto-applied, the AI is instructed *not* to also emit `[[EFFECT: initiative …]]` or `[[EFFECT: progress …]]` for those moves — no double-marking.

### Example flow

```
Player: !skald a pack of wolves and their hulking alpha ambush us
Skald:  …narrates the ambush…           → [[EFFECT: create_combat Wolf]]  (×2, rank from compendium → dangerous)
                                          → [[EFFECT: create_combat Dire Alpha formidable]]  (custom foe → explicit rank)

Player rolls Enter the Fray → Strong Hit
Skald:  "You read the charge and strike first."   (auto: initiative gained)

Player rolls Strike → Strong Hit
Skald:  "Your axe bites the alpha deep."   (auto: Dire Alpha +8 ticks, initiative kept)

Player rolls Strike → Weak Hit
Skald:  "A glancing blow — they wheel on you."   (auto: +8 ticks, initiative lost)

…the alpha falls…
Skald:  "The alpha drops to one knee and yields."  → [[EFFECT: end_combat Dire Alpha]]
```

`[[EFFECT: end_combat <Foe Name>]]` marks that foe's track complete when they're defeated, flee, or yield. Completed tracks persist on the sheet for the chronicle; only un-completed foes count as "active". Live combat state — who holds initiative, each active foe's progress, recently-ended fights — is fed back into the AI's context every turn.

### Vows

The same machinery powers quests: `[[EFFECT: create_vow <Name> <rank> <description>]]` creates a vow/quest progress track when you Swear an Iron Vow.

### Graceful by design

Every integration point feature-detects the Ironsworn system and degrades gracefully. If the system isn't present, these features quietly switch off and the Skald behaves exactly as it did in v2.0 — a pure AI storyteller. If a particular API isn't available in your Ironsworn version, the Skald falls back to a manual roll card rather than failing.

---

## The Living Chronicle (Auto-Journaling)

*(New in v0.4.0.)* As the Skald narrates, it quietly records the people, places, and events of your saga into Foundry **Journal Entries** — so your world documents itself.

### How it works

When auto-journaling is active, the Skald appends a hidden, machine-readable metadata block to its narration:

```
[[SKALD_META]]{ "entities": [...], "facts": [...], "mysteries": [...], "worldState": {...}, "decisions": [...] }[[/SKALD_META]]
```

This block is **always stripped from the displayed text** — players never see it. The client parses it and, through a background queue, turns it into journal entries. The server stays a stateless streaming proxy; all journaling happens client-side.

### What gets recorded

| Source | Where it goes | Behavior |
|---|---|---|
| **NPCs** (incl. `!npc` encounters) | *NPCs* folder | One entry per NPC. Re-mentions append an update (deduped by name). |
| **Locations** | *Locations* folder | One entry per place. |
| **Discoveries** | *Discoveries* folder | One entry per notable find/secret/clue. |
| **World facts** | *World Facts* → single rolling journal | Appended as a running, timestamped log (silent). |
| **Story threads / mysteries / decisions / world-state** | *Story Threads* → single rolling journal | Appended as a running log (silent). |
| **Session recap** (`!end-session`) | *Session Chronicles* folder | A dated, saga-styled summary of the session. |

All folders live under a root **The Eternal Skald** journal folder. Entries are **GM-only** by default; flip **Journal Visibility** to *Shared with players* to grant observer access.

### Notifications

New NPC/Location/Discovery entries surface as a subtle bottom-right **toast** that fades after ~2 seconds. Control verbosity with **Journal Notifications**: *None* (silent), *Minimal* (new entries only, default), or *Detailed* (also toasts updates). World facts and story threads are always silent.

### Reviewing your world

- `!journals [type]` — list what's been recorded (optionally filtered by type).
- `!mysteries` — see open mysteries, decisions, and tracked world-state.
- `!remind [topic]` — recall what the chronicle holds about a topic. **(v0.5.0)** Now powered by **semantic recall** — the Skald embeds your topic and finds the most *meaning-relevant* entries (not just keyword matches), falling back to scored text search if the memory model isn't ready. See [AI Memory](#ai-memory-browser-based-rag).
- `!end-session` — *(GM-only)* weave a Session Chronicle from everything recorded this session.

Auto-journaling is **on by default** and degrades gracefully — if a write ever fails, play continues uninterrupted. Toggle it any time with the **Auto-Journaling** setting.

---

## Map Vision (Image Analysis)

**New in v0.10.23** (sharpened in **v0.10.24**). Beyond *reading* your scene's metadata (see [scene awareness](#ironsworn-integration), v0.10.22), the Skald can now **look at the actual background map image** with a vision-capable AI model and tell you what's on it — terrain, structures, routes, **text labels & place names**, and notable features — then record those discoveries as journal locations. As of **v0.10.24** the capture is higher-resolution and lossless by default, the prompt explicitly hunts for labels and faint paths, and a **Map Analysis Quality** setting can read a large map in **overlapping grid sections** for far better small-detail and OCR coverage.

### How it works

1. **Capture (read-only, base map only).** When a scene loads, the Skald reads **only** the scene's background image (`scene.background.src`, or the legacy `scene.img`). It draws that image onto an off-screen canvas, **downscales** it so the longest edge is at most the **Max Map Resolution** (default **4096&nbsp;px**, up from 2048 in v0.10.23), and re-encodes it according to **Image Format** — **lossless PNG by default** (v0.10.24) so small text and thin lines survive, with JPEG available if you prefer smaller payloads. Tokens, fog of war, drawings, walls, and hidden GM content are **never** captured or sent.
2. **Analyse.** The image is sent to a **vision-capable model** as a standard multimodal message (a fantasy-cartographer instruction plus the image). The Skald asks for a short scene description and a list of **points of interest (POIs)** — each with a **confidence** rating and any **text labels** it can read — in a strict JSON shape. Under *Balanced* / *Thorough* **Map Analysis Quality**, a large map is also split into **overlapping grid sections** (2×2 or 3×3) that are each read closely, then **merged** with the whole-map overview (de-duplicating by name, keeping the richest description and highest confidence).
3. **Scribe.** Each POI becomes a **location** entry in the [Living Chronicle](#the-living-chronicle-auto-journaling), linked to the scene and de-duplicated against existing entries. Low-confidence finds are kept but flagged. The GM gets a whispered summary; a public *Skald* scouting card sets the scene for the table.
4. **Cache.** The full result (timestamp, model used, quality, section count, POI list with labels & confidence) is stored on the scene's flags, so the same map is **never analysed (or billed) twice** — until you force a fresh look.

### Using it

- **Automatic** — on by default. The first time you (the GM) view a scene with a background image, the Skald scouts it once in the background.
- **`!scout`** — *(GM-only)* force a **fresh re-analysis** of the current scene, ignoring the cache. Aliases: **`!survey`**, **`!analyze-map`**.

### Settings

| Setting | Default | What it does |
| --- | --- | --- |
| **Auto-Analyze Scenes** | On | Toggles the automatic scouting when a scene with a background image loads. Turn off to only ever scout on demand with `!scout`. |
| **Vision Model** | Inherit | Which model performs the image analysis. *Inherit* reuses your main **Model Name**; or pick a specific vision-capable model. ★-marked models are the strongest map/OCR readers; choosing a weak model whispers a heads-up. |
| **Map Analysis Quality** *(v0.10.24)* | Balanced | How hard the Skald looks. **Fast** = one whole-map pass (cheapest, 1 call). **Balanced** = overview + a 2×2 grid of overlapping sections on larger maps. **Thorough** = overview + up to a 3×3 grid (best small-text/OCR coverage, most calls). |
| **Max Map Resolution** *(v0.10.24)* | 4096 px | Longest edge the captured image is downscaled to before sending: **2048 / 3072 / 4096 / Original**. Higher = sharper labels but more tokens. |
| **Image Format** *(v0.10.24)* | Auto (PNG) | Encoding of the captured image: **Auto** (lossless PNG), **PNG**, or **JPEG**. PNG preserves tiny text and thin lines; JPEG is smaller but can smear fine detail. |

### Supported vision models & token costs

Map vision needs a **multimodal (vision) model** — a text-only model can't see the image. The Skald auto-detects whether the configured model supports vision and, if it doesn't, quietly whispers the GM and does nothing (no broken calls, no wasted tokens). Choose the model under the **Vision Model** setting:

**Pick a strong reader for maps.** Reading a fantasy map well — especially the **small text labels, place names, and tiny symbols** — is much harder than describing a photo. Stronger multimodal models are dramatically better at this OCR-like task; weaker/"mini" models often miss labels or invent them, particularly on compressed images. The **★** models below are the recommended map readers. If you pick a weak model, the Skald still runs but whispers the GM a heads-up (and, for on-demand `!scout`, asks you to confirm).

| Model | Vision | Map/OCR strength | Relative cost | Notes |
| --- | --- | --- | --- | --- |
| **Inherit (main model)** | depends | depends | — | Uses your **Model Name** setting. Vision works only if that model is multimodal (the default *Gemini 3 Flash* is). |
| **gemini-3-flash-preview** | ✅ | ★ strong | 💲 low | Fast, inexpensive, and a solid label reader; the recommended default. |
| **gemini-2.5-pro** ★ | ✅ | ★ strongest | 💲💲💲 high | Best reads of complex maps and dense labels; reserve for intricate maps / `!scout`. |
| **gpt-4o** ★ | ✅ | ★ strong | 💲💲 medium | Excellent general vision and reliable text reading; balanced cost. |
| **claude-3-5-sonnet** ★ | ✅ | ★ strong | 💲💲 medium | Excellent descriptive detail and label legibility. |
| **gemini-2.5-flash** ★ | ✅ | ★ strong | 💲 low | Cheap, quick, and a capable label reader for routine scouting. |
| **gemini-2.0-flash** | ✅ | good | 💲 low | Budget Gemini vision; fine for terrain, weaker on tiny text. |
| **gpt-4o-mini** | ✅ | ⚠ weak | 💲 low | Budget OpenAI vision; frequently misses small labels — okay for terrain, not recommended for label-heavy maps. |

**Why cost matters — and the v0.10.24 trade-offs.** Images cost far more tokens than text — a single map can run from a few hundred to a few thousand input tokens depending on its resolution, *on top of* the reply. v0.10.24 deliberately spends a little more for accuracy, so it's worth understanding the knobs:

- **Resolution & format.** Raising **Max Map Resolution** (now 4096&nbsp;px by default) and using **lossless PNG** make small labels readable but increase the per-image token/byte cost. Drop to 2048&nbsp;px or switch **Image Format** to JPEG if you want the lighter v0.10.23-style payload.
- **Grid sectioning.** **Map Analysis Quality** trades calls for coverage: *Fast* = **1** call (whole map); *Balanced* = overview **+ 4** section calls on larger maps; *Thorough* = overview **+ up to 9** section calls. More sections = better small-text/OCR coverage but proportionally more tokens.
- **What keeps it cheap.** The Skald still **caches** each scene's analysis so you pay **once per map** (not once per load), and **auto-analysis is one-shot per scene**. For the cheapest running cost, pair **Auto-Analyze Scenes: On** with **Fast** quality and a low-cost ★ model like *gemini-2.5-flash* or *gemini-3-flash-preview*, and reserve **Thorough** + *gemini-2.5-pro* for the occasional `!scout` of an especially intricate, label-heavy map.

> **Read-only & graceful.** Map vision never modifies the scene. Every step degrades quietly — no active scene, no background image, a non-vision model, a tainted (CORS-blocked) remote image, or a network failure all simply result in no analysis, never a broken turn. When a remote image can't be drawn to the canvas for downscaling, the Skald falls back to sending the image **URL** so models that fetch URLs still work.

---

## AI Memory (Browser-Based RAG)

**New in v0.5.0.** The Eternal Skald now has a long-term, *semantic* memory of your world. Instead of only feeding the AI the last few chat messages, the Skald can recall the **most meaning-relevant** journal entries — NPCs, locations, lore, world facts, story threads, session chronicles — and weave them into its context **before** it answers. The result: an AI Game-Master that remembers who the villagers are, what oaths you swore three sessions ago, and the rumor you heard in the barrow.

### How it works

This is **Retrieval-Augmented Generation (RAG) that runs entirely in your browser** — no extra server, no third-party vector database, nothing leaves your machine for the memory step.

1. **Embedding.** Whenever a journal entry is created or updated, the Skald turns its text into a 384-dimension *embedding* vector using a small open-source model ([`Xenova/all-MiniLM-L6-v2`](https://huggingface.co/Xenova/all-MiniLM-L6-v2)) running locally via [transformers.js](https://github.com/xenova/transformers.js).
2. **Storage.** Vectors are stored in your browser's **IndexedDB** (database `eternal-skald-vectors`). They persist between sessions and are scoped to your browser/world.
3. **Retrieval.** Before the Skald answers a prompt, narrates a move, conjures an NPC, interprets an oracle, or writes lore, it embeds the *current* request, compares it against every stored vector by **cosine similarity**, keeps the top matches above a relevance threshold, and packs them — newest/most-relevant first, within a token budget — into a **`RELEVANT WORLD MEMORY`** block in the system prompt.

### Privacy & where things run

- The embedding model and all vectors live **in your browser only**. The memory/retrieval step makes **no network calls** (after the one-time model download).
- Only the final, retrieved memory *text* is included in the prompt sent to your configured AI endpoint — exactly the same channel as your normal chat, and only the slices actually relevant to your request.

### First-time setup

- The first time semantic memory is needed, the browser downloads the embedding model (**~90 MB**, cached afterward by the browser). A small progress bar appears; **play is never blocked** — until the model is ready the Skald silently falls back to the v0.4.0 scored text search, then upgrades automatically.
- To warm the model and build memory for an existing world, run **`!reindex`** (GM-only). Check progress/state any time with **`!rag-status`**.

### Browser compatibility & performance

- Requires **WebAssembly (WASM)** and **IndexedDB** — available in all modern browsers (Chrome, Edge, Firefox, Safari). If your deployment's Content-Security-Policy blocks the CDN import or you're fully offline on first run, the model simply won't load and the Skald **degrades gracefully** to text search.
- If your browser supports **WebGPU**, transformers.js uses it automatically for faster embedding; otherwise it runs on WASM CPU, which is still fine for the small batches a tabletop session produces.

### Controlling it

- Toggle the whole feature with the **Semantic Memory (RAG)** setting; tune budget/threshold/result-count with the other RAG settings (see [Settings](#settings)).
- `!remind [topic]` uses semantic recall directly; `!reindex` (GM) rebuilds the whole memory; `!rag-status` reports model state, vector count and settings.
- **Graceful degradation is a hard rule:** if anything in the memory pipeline fails (model, IndexedDB, CSP, offline), the Skald logs a warning and continues exactly as in v0.4.0 — memory is purely additive and never breaks play.

---

## Commands

All commands use the **`!`** prefix (not `/`). Foundry VTT v14 rejects unknown `/` slash commands before our module sees them.

> **AI Mode required.** Commands are only processed while the **AI Mode** toggle is ON (the default for new sessions). When OFF, `!`-prefixed messages are treated as ordinary chat. Toggle it in *Module Settings → The Eternal Skald* or with the keyboard shortcut (**Alt+Shift+A** by default, rebindable under *Configure Controls*).

| Command | Description |
|---|---|
| `!<message>` | **Bare alias (v0.3.2):** just type `!` then your words — e.g. `!what lurks in the barrow?` — to speak with the Skald freely. Any `!` line that isn't one of the explicit commands below is routed here. |
| `!skald-help` | Show the command list. |
| `!skald <prompt>` | Talk to The Eternal Skald freely (explicit form of the bare `!` alias) — rules questions, narration, ideas. |
| `!oracle <name>` | Roll an Ironsworn oracle and have the Skald interpret. e.g. `!oracle action`, `!oracle theme`. |
| `!npc <name>` | Conjure (or continue) an NPC. The Skald rolls oracle personas and stays in character. |
| `!scene <subject>` | Generate a vivid scene description, factoring in your current canvas. |
| `!lore <topic>` | Write world-building lore. A JournalEntry is created in the Skald's Chronicles folder. |
| `!combat <note?>` | Get tactical narration and Ironsworn-move suggestions for the current fight. |
| `!journals [type]` | **(v0.4.0)** List the chronicle entries the Skald has auto-scribed. Optionally filter by type — e.g. `!journals npc`, `!journals location`. |
| `!mysteries` | **(v0.4.0)** Review the open mysteries, decisions and world-state the Skald is tracking. |
| `!remind [topic]` | **(v0.5.0)** Recall what the chronicle holds about a topic using **semantic recall** — embeds your topic and finds the most meaning-relevant entries, summarized in-character. Falls back to scored text search if the memory model isn't ready yet. See [AI Memory](#ai-memory-browser-based-rag). |
| `!end-session` | **(v0.4.0, GM-only)** Weave a saga-styled Session Chronicle recap from everything recorded this session into a dated journal. |
| `!reindex` | **(v0.5.0, GM-only)** Rebuild the browser-based semantic memory: warm the embedding model and (re)embed every chronicle entry into IndexedDB. A progress bar tracks the work. See [AI Memory](#ai-memory-browser-based-rag). |
| `!rag-status` | **(v0.5.0)** Report the state of the semantic memory: whether the embedding model is loaded, how many vectors are stored, and the active RAG settings. |
| `!scout` | **(v0.10.23, GM-only)** Force a fresh **vision analysis of the current scene's background map** — the Skald looks at the image, posts a scouting card, scribes the points of interest as journal locations, and whispers the GM a summary. Ignores the per-scene cache. Aliases `!survey`, `!analyze-map`. See [Map Vision](#map-vision-image-analysis). |
| `!skald-reset` | **(v0.10.16, GM-only)** Wipe the chronicle for a new campaign. After a confirmation dialog, deletes all *unlocked* Skald-scribed journal entries, clears the semantic memory (RAG) vectors, resets the conversation history, and empties the timeline — then whispers a report of what was cleared. Your own journals are never touched; lock an entry (`the-eternal-skald.locked` flag = `true`) to keep it. Alias `!skald-wipe`; pass `force` to skip the dialog. |

### Available oracles
`action`, `theme`, `region`, `location`, `coastal`, `npc`, `npc-goal`, `npc-descriptor`, `combat`, `mystic`, `price`.

---

## Settings

All in **Configure Settings → The Eternal Skald** (world-scoped, GM-only):

| Setting | Default | Description |
|---|---|---|
| AI Provider | **Abacus AI** | Pick your provider — **Abacus AI** (recommended), OpenAI, OpenRouter, Google AI (Gemini), or Custom. Selecting one auto-fills the API Endpoint with that provider's OpenAI-compatible URL. |
| API Key | *(empty)* | Required. Your AI provider's API key (Abacus AI, OpenAI, OpenRouter, Google AI, etc.). |
| Streaming Responses | **On** | Render replies in real time, word by word, as the AI generates them (Server-Sent Events) for near-instant feedback. Falls back automatically to a buffered reply if streaming is unavailable. |
| AI Model | `gemini-3-flash-preview` | Any model your chosen provider exposes (e.g. `gpt-4o`, `anthropic/claude-3.5-sonnet`, `gemini-1.5-pro`). |
| API Endpoint | `https://routellm.abacus.ai/v1/chat/completions` | Auto-filled by the AI Provider dropdown; edit directly only for a Custom backend. |
| Skald Intensity | 6 | 1 (terse) to 10 (full saga-singer operatic). |
| Auto-Narrate Combat | On | Short flavour line at each combatant's turn. |
| AI Controls Enemies | Off | Full AI turn for non-player combatants. |
| Conversation Memory | 20 | Rolling buffer length for short-term memory. |
| Ironsworn Rules Integration | On | Integrate with the foundry-ironsworn rules engine (see [Ironsworn Integration](#ironsworn-integration)). |
| Suggest Moves | On | Show the interactive move-suggestion card after narration. |
| Auto-Narrate Move Outcomes | On | Automatically narrate any Ironsworn roll's result. |
| Narration Delay (ms) | 2000 | How long to wait after a roll before auto-narrating, so dice animations can finish. ~2000ms with Dice So Nice, ~500ms without. Range 0–5000. |
| AI Applies Mechanical Effects | **On** | Let the Skald apply momentum/harm/stress/supply/progress/oracle effects and run the combat automation. |
| Show Effect Announcements | On | Post the brief *"The Skald enacts: …"* whisper messages announcing applied effects. Turn off to hide them. Per-client. |
| Auto-Create Combat Tracks | On | Auto-create a combat progress track per foe when a fight begins. |
| Default Enemy Rank | Dangerous | Fallback rank for custom foes only — used when an invented foe isn't in the compendium and no rank is given. Standard foes use their official compendium rank. |
| Auto-Journaling | **On** | **(v0.4.0)** Let the Skald automatically scribe NPCs, locations, discoveries, world facts and story threads into Journal Entries as they emerge in play. |
| Journal Notifications | Minimal | **(v0.4.0)** How loudly new chronicle entries are announced: none (silent), minimal (brief toast), or detailed (also toasts updates). |
| Journal Visibility | GM only | **(v0.4.0)** Who can read the auto-scribed entries: GM only, or shared with players (observer access). |
| Session Chronicle on Demand | On | **(v0.4.0)** Enable the `!end-session` command, which weaves a saga-styled recap of the session into a dated journal. |
| Semantic Memory (RAG) | **On** | **(v0.5.0)** Enable browser-based semantic memory: embed journal entries and retrieve the most relevant ones into the AI's context before it answers. See [AI Memory](#ai-memory-browser-based-rag). Turn off to disable retrieval and indexing entirely. |
| Memory Context Budget | 2000 | **(v0.5.0)** Maximum approximate tokens of retrieved memory injected into the prompt's `RELEVANT WORLD MEMORY` block. Range 200–6000. Higher = more recall, larger prompts. |
| Memory Results per Query | 5 | **(v0.5.0)** How many of the top-scoring entries to consider per retrieval. Range 1–20. |
| Auto-Index Journals | **On** | **(v0.5.0)** Automatically embed chronicle entries into semantic memory as they are created or updated. Off means memory only updates when you run `!reindex`. |
| Memory Relevance Threshold | 0.3 | **(v0.5.0)** Minimum cosine similarity (0–1) an entry must reach to be recalled. Higher = stricter/more precise, fewer results. Range 0–1, step 0.05. |
| Memory Debug Logging | Off | **(v0.5.0)** Verbose RAG diagnostics (embedding, scoring, retrieval) in the browser console. |
| Auto-Analyze Scenes | **On** | **(v0.10.23)** Automatically run a vision analysis of a scene's background map the first time it's viewed (GM-side, cached per-scene). Off means you only scout on demand with `!scout`. See [Map Vision](#map-vision-image-analysis). |
| Vision Model | Inherit | **(v0.10.23)** Which model performs map image analysis: *Inherit* (reuse your main AI Model) or a specific vision-capable model (e.g. `gemini-2.5-flash`, `gpt-4o-mini`, `gemini-2.5-pro`). ★-marked choices are the strongest map/OCR readers; a weak choice whispers the GM a heads-up. See [supported models & token costs](#supported-vision-models--token-costs). |
| Map Analysis Quality | Balanced | **(v0.10.24)** How hard map vision looks: *Fast* (one whole-map pass), *Balanced* (overview + 2×2 overlapping sections on larger maps), or *Thorough* (overview + up to 3×3 sections, best small-text/OCR coverage). See [Map Vision](#map-vision-image-analysis). |
| Max Map Resolution | 4096 px | **(v0.10.24)** Longest edge the captured map is downscaled to before sending (2048 / 3072 / 4096 / Original). Higher = sharper labels, more tokens. See [Map Vision](#map-vision-image-analysis). |
| Image Format | Auto (PNG) | **(v0.10.24)** Encoding of the captured map: *Auto* (lossless PNG), *PNG*, or *JPEG*. PNG preserves tiny text; JPEG is smaller but smears fine detail. See [Map Vision](#map-vision-image-analysis). |
| Link Entities in Narration | **On** | Turn names the Skald narrates into clickable links — chronicled NPCs/locations/discoveries open their Journal Entry, and known Ironsworn moves open the system's own official move dialog directly (resolved by the move's Datasworn ID). Purely additive; unmatched names stay plain text. |
| Debug Logging | Off | Verbose Ironsworn integration diagnostics in the browser console. |

---

## Public API

For macros and other modules:

```js
const skald = game.modules.get('the-eternal-skald').api;

// Direct AI call
const reply = await skald.chat([
  { role: 'system', content: 'You are a helpful Ironsworn GM.' },
  { role: 'user',   content: 'Suggest a hook for a coastal raid.' }
]);

// Roll any oracle
const { roll, result } = skald.rollOracle(skald.IronswornData.oracles.action);

// Trigger commands programmatically
await skald.commands.lore('The Fallen Keep of Vorlund');

// --- Ironsworn integration (v0.3.0) ---
// Read the active character's state
const char = skald.ironsworn.describeCharacter();   // { name, stats, meters, ... } or null
const caps = skald.ironsworn.capabilities();         // feature-detection report

// Trigger an Ironsworn move through the system's own dice mechanics
await skald.ironsworn.triggerMove('Face Danger', { stat: 'iron' });

// Adjust mechanics directly
await skald.ironsworn.adjustMomentum(+1);
await skald.ironsworn.markProgress('Find the lost ship');

// --- Combat system (v0.3.0) ---
const actor = skald.ironsworn.getActiveCharacter();
await skald.ironsworn.createProgressTrack(actor, 'Frost Wolf', 'combat', 'dangerous');
await skald.ironsworn.markProgressByRank(actor, 'Frost Wolf'); // +8 ticks (dangerous)
await skald.ironsworn.setInitiative(actor, true);             // you are in control
skald.ironsworn.hasInitiative(actor);                          // → true
skald.ironsworn.getActiveCombatTrack(actor);                   // newest un-finished foe
skald.ironsworn.describeCombatState(actor);                    // AI-friendly summary
await skald.ironsworn.completeTrack(actor, 'Frost Wolf');      // end the fight

// --- Compendium enemy-rank lookup (v0.3.1) ---
await skald.ironsworn.lookupEnemyInCompendium('wyvrenn');
// → { found: true, name: 'Wyvern', rank: 'extreme', matchedName: 'Wyvern', packId: '…', match: 'fuzzy' }
await skald.ironsworn.getEnemyRank('Bear');                    // → 'formidable' (or null if not in any foe pack)
skald.ironsworn.clearEnemyCache();                             // drop the cached foe index (auto-cleared on world reload)

// Drive the suggestion / selector UI
await skald.integration.postSuggestionCard({ name: 'Secure an Advantage', stat: 'wits' });
await skald.integration.showMoveSelector();

// --- Auto-journaling chronicle (v0.4.0) ---
// Ingest a full AI reply (parses any [[SKALD_META]] block and enqueues writes)
skald.journal.ingestReply(replyText, { channel: 'skald' });

// Or hand it a metadata object directly
skald.journal.ingestMetadata({
  entities: [{ type: 'npc', name: 'Old Keldra', description: 'A bone-witch of the fens.' }],
  facts: ['The bridge at Hallow Ford has collapsed.'],
  mysteries: ['Who lit the signal fire on the headland?']
});

// List recorded entries (optionally by type) and write a session chronicle
skald.journal.listEntries('npc');
await skald.journal.generateSessionChronicle();

// --- Browser-based semantic memory / RAG (v0.5.0) ---
await skald.rag.init();                       // lazily load the embedding model (~90MB, browser-only)
await skald.rag.indexJournalEntry(entry);     // embed + store one JournalEntry's vector in IndexedDB
await skald.rag.reindexAll(skald.journal.listEntries()); // clear + (re)embed the given entries
const hits = await skald.rag.search('who guards the barrow?', { maxResults: 5, threshold: 0.3 });
const block = await skald.rag.buildContextBlock('coastal raid', { maxTokens: 2000, maxResults: 5 });
const state = await skald.rag.status();       // { modelReady, vectorCount, model, dims, threshold, ... }
await skald.rag.remove(entry.id);             // evict one entry's vector
await skald.rag.clear();                       // wipe the whole vector store

// --- Map vision / image analysis (v0.10.23) ---
await skald.scout();                           // force a fresh vision analysis of the current scene
await skald.mapVision.analyzeScene(scene, { force: true });   // analyse a specific scene (force ignores cache)
const cached = skald.mapVision.getCached(scene);              // { ts, model, pois } | null
```

---

## Troubleshooting

**"The Eternal Skald server hook is not loaded (404)"**
This only appears if **Connection Mode** is set to **Server hook only** and the `--import` flag isn't in your Foundry startup command (or the path is wrong). On **Auto** (the default) the Skald silently falls back to direct browser→AI mode instead, so you won't see this error. To use the hook, see [Setup step 2](#2-optional-add---import-to-your-foundry-startup); otherwise switch Connection Mode to **Auto** or **Direct (browser → AI)**.

**No `⚔️ Skald | v0.15.0` line in Foundry's console output**
The hook file isn't being loaded. Check the path is absolute and correct. Run it in a terminal to see Node.js errors.

**"No Abacus AI API key is set"**
Go to Module Settings → The Eternal Skald and enter your key.

**`/skald-help` says "not a valid chat command"**
Use `!skald-help` (exclamation mark, not slash).

**Hosted Foundry (The Forge, Foundry VTT on Abacus, etc.)**
You can't add the `--import` flag, so the server hook won't load — **that's fine as of v0.10.12.** Leave **Connection Mode** on **Auto** (the default) and the Skald will automatically call the AI directly from your browser. If you ever see the old `/skald-api/chat … 404 (Not Found)` console error and the Skald still doesn't reply, open Module Settings → The Eternal Skald and set **Connection Mode** to **Direct (browser → AI)** explicitly, then confirm your **API Key** is set. (Direct mode needs an endpoint that allows cross-origin browser requests; the default Abacus AI endpoint does.)

**Auto-narration doesn't fire after an Ironsworn roll**
Enable **Debug Logging** in Module Settings and check the browser console. As of **v0.3.0**, roll detection reads the `foundry-ironsworn` roll card HTML (the system no longer attaches module flags), logs every detection step, and waits for the configurable **Narration Delay** (default 2000ms) before narrating so dice animations can finish. Make sure **Auto-Narrate Moves** is enabled and you're logged in as the GM. If you still see no `Detected Ironsworn roll` log line, copy the console output and open an issue.

**Semantic memory (RAG) isn't recalling anything / `!remind` falls back to text search**
The embedding model loads lazily the first time it's needed and is **~90 MB**. Until it finishes (or if it can't load at all), the Skald falls back to the v0.4.0 scored text search — this is by design and never blocks play. To diagnose:
1. Run **`!rag-status`** — check `modelReady` (is the model loaded?) and `vectorCount` (are entries embedded?).
2. Run **`!reindex`** *(GM-only)* to warm the model and (re)embed every chronicle entry; a progress bar tracks the work.
3. If the model never loads, your environment is likely **offline on first run** or your deployment's **Content-Security-Policy** blocks the transformers.js CDN import (the model is fetched from a CDN the first time). Allow the CDN, or accept the graceful text-search fallback. Enable **Memory Debug Logging** for verbose RAG diagnostics.
4. Requires a browser with **WebAssembly** and **IndexedDB** (all modern browsers). Private/incognito windows that block IndexedDB will disable memory storage. See [AI Memory](#ai-memory-browser-based-rag).

---

## Versioning & Release Strategy

The Eternal Skald follows [Semantic Versioning](https://semver.org/) with a deliberately conservative pre-1.0 policy:

- **`0.x.y` — pre-release (alpha/beta).** The entire `0.x` series is experimental. APIs, settings, and behavior may change without notice, and stability is not guaranteed. The project is here today.
- **Patch — `0.2.x`** → bug fixes, small tweaks, and polish. No new headline features.
- **Minor — `0.x.0`** → major new features or significant changes (and possibly breaking changes while still in `0.x`).
- **`1.0.0` — first official, production-ready release.** This will only be tagged once the module is feature-complete, well-tested across real campaigns, and stable enough to recommend for everyday play.

In short: until you see `1.0.0`, treat every release as a development build.

> **Note on earlier tags:** Some early builds were mistakenly published under `2.x` (e.g. `v2.0.0`, `v2.2.0`, `v2.2.1`). Those version numbers were never appropriate for a pre-release project and have been retired. The correct lineage is `0.1.x` → `0.2.0` → `0.2.2` (see [CHANGELOG.md](CHANGELOG.md)).

### Bumping the version (maintainers)

`module.json` is the **single source of truth** for the module version, and `package.json` is kept in lock-step with it. A small helper script updates both at once so they can never drift apart:

```bash
npm run version:bump 0.15.0            # update both manifests + create a commit
npm run version:bump 0.15.0 --no-commit  # update the files only (no commit)
```

The script (`tools/bump-version.mjs`, zero dependencies, Node 18+):

- **validates** the argument is a proper [SemVer](https://semver.org/) version (`MAJOR.MINOR.PATCH`, with optional `-prerelease` / `+build`) and refuses anything else;
- does a **targeted** edit of only the `"version"` field in each manifest, so the rest of every file — including `module.json`'s long HTML description — is preserved exactly;
- **fails closed**: it verifies both files exist and that each edit still produces valid JSON *before* writing anything, so a bad run leaves your tree untouched;
- by default creates a `chore: bump version to vX.Y.Z` commit, staging **only** `module.json` and `package.json` (never your unrelated working changes). Pass `--no-commit` to skip the commit.

After bumping, push and tag the release as usual. The `version-consistency` test suite (`npm test`) guards against any version drift creeping back into the README or the source-file banners.

---

## Upgrading from older builds

The current architecture loads a server-side hook via Node's `--import` flag:

1. **Delete any old proxy** — if you were running `skald-proxy.js` or had systemd/PM2 units for it, remove them.
2. **Update your startup command** — the `--import` path is `scripts/eternal-skald-server.mjs` (older builds used `proxy/skald-hook.mjs`).
3. **Remove the old Proxy URL setting** — it no longer exists. The module has only one networking path now.

---

## Architecture & Refactoring (Phase 2)

This release ships a fully decomposed, modular codebase. The original client logic
lived in a single ~11,000-line `scripts/eternal-skald.js` monolith. It has been
refactored into focused ES modules with **zero behavioral change**.

**What changed:**

- The monolith was reduced from **~11,048 lines to an 801-line entry point**
  (`scripts/eternal-skald.js`) that wires the module together.
- Logic was extracted into cohesive ES modules under `scripts/`:
  - `scripts/core/` — settings, constants, shared utilities, and state management
  - `scripts/ai/` — AI client, prompt assembly, and model/networking calls
  - `scripts/chat/` — chat message handling and command parsing
  - `scripts/chronicle/` — chronicle/journal persistence and rendering
  - `scripts/vision/` — image/vision-related features
  - `scripts/narrative/` — narrative generation and story logic
  - `scripts/hooks/` — Foundry hook registration and lifecycle wiring
- Modules use native `import`/`export`, loaded via the `esmodules` entry in
  `module.json` (`scripts/eternal-skald.js`).

**Quality gates:**

- **20/20 test files pass** with **971 assertions** green.
- Behavior is preserved — this is a structural refactor only, not a feature change.

See [`REFACTOR_COMPLETE.md`](REFACTOR_COMPLETE.md) in the repository root for the
full breakdown of the decomposition, module-by-module notes, and the commit history.

---

## License

This work is licensed under a [![CC BY-SA 4.0][cc-by-sa-shield]][cc-by-sa]

Buy the official Ironsworn books to support the creator.
