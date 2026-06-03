# The Eternal Skald

An AI-powered storyteller, oracle interpreter, and tactical enemy controller for **Ironsworn** and **Ironsworn: Delve** campaigns in Foundry Virtual Tabletop v14. The Eternal Skald is a wise, dramatic norse narrator who serves as the GM at your table — interpreting oracle rolls, voicing NPCs, generating lore, narrating combat, and even taking control of enemy combatants on their turn.

Powered by the **Abacus AI ChatLLM** platform (Gemini 3.0 Flash by default).

> ⚠️ **Alpha / Development Version (v0.3.0)** — This is experimental pre-release software under active development. Expect rough edges, breaking changes between versions, and features that may not yet work in every configuration. It is **not** production-ready. Please back up your world before use and report issues you run into. See [Versioning & Release Strategy](#versioning--release-strategy) for what the version numbers mean.

As of **v0.3.0**, the Skald integrates directly with the official [**foundry-ironsworn**](https://foundryvtt.com/packages/foundry-ironsworn) system: it reads your character's stats and meters, *suggests* the right Ironsworn move, triggers the system's own dice mechanics on one click, narrates the official strong-hit / weak-hit / miss outcome, and can optionally apply mechanical effects. See [Ironsworn Integration](#ironsworn-integration) below. The module still works standalone in any system — Ironsworn features simply activate when the system is present.

---

## Setup (3 steps)

### 1. Install the module

In Foundry VTT: **Setup → Add-on Modules → Install Module**. Paste this manifest URL:

```
https://raw.githubusercontent.com/papicy/eternal_skald/main/module.json
```

Click **Install**, then activate the module in your world.

### 2. Add `--import` to your Foundry startup

The Skald makes AI calls **server-side** so there are no CORS or proxy issues. This requires one change to how you start Foundry — add the `--import` flag:

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
⚔️  Skald | v0.3.0 — server hook active. /skald-api/* routes ready.
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
{"status":"ok","service":"The Eternal Skald","version":"0.3.0"}
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
| Auto-Create Combat Tracks | On | Auto-create a combat progress track per foe when a fight begins. Requires *AI Applies Mechanical Effects*. |
| Default Enemy Rank | Dangerous | Challenge rank for auto-created combat tracks when the Skald doesn't specify one. |
| Debug Logging | Off | Verbose integration diagnostics in the browser console (F12). |

---

## Combat System

From **v0.3.0**, the Skald runs Ironsworn fights for you. Combat in Ironsworn is tracked with a **progress track per foe** (filled by landing blows) plus a single **initiative** state telling you whether you're *in control* or *in a bad spot*. The Skald creates and advances these automatically.

### Automatic combat-track creation

When the fiction starts a fight, the Skald emits `[[EFFECT: create_combat <Foe Name> <rank>]]` and a combat progress track is created on your character sheet for that foe. Each new foe gets its own track, so multi-enemy fights just work. Rank sets how much progress each hit marks:

| Rank | Threat | Progress per harm | Boxes to fill |
|---|---|---|---|
| Troublesome | trivial | +12 ticks (3 boxes) | ~4 hits |
| Dangerous *(default)* | a real threat | +8 ticks (2 boxes) | ~5 hits |
| Formidable | tough | +4 ticks (1 box) | 10 hits |
| Extreme | deadly | +2 ticks | 20 hits |
| Epic | legendary | +1 tick | 40 hits |

If the Skald doesn't name a rank, **Default Enemy Rank** (Dangerous) is used. Turn off **Auto-Create Combat Tracks** to disable this and create foe tracks manually.

### Initiative & deterministic move resolution

When you roll **Enter the Fray**, **Strike**, or **Clash**, the Skald applies the mechanics itself (so the rules stay correct no matter how it narrates):

- **Enter the Fray** — strong/weak hit → you **gain initiative**; miss → you're in a **bad spot**.
- **Strike / Clash** — on a hit, the active foe's track is **marked by its rank**; a **strong hit keeps** initiative, a **weak hit loses** it; a **miss loses** initiative.

Because these are auto-applied, the AI is instructed *not* to also emit `[[EFFECT: initiative …]]` or `[[EFFECT: progress …]]` for those moves — no double-marking.

### Example flow

```
Player: !skald three reavers ambush us on the cliff path
Skald:  …narrates the ambush…           → [[EFFECT: create_combat Reaver Captain dangerous]]
                                          → [[EFFECT: create_combat Reaver formidable]]  (×2)

Player rolls Enter the Fray → Strong Hit
Skald:  "You read the charge and strike first."   (auto: initiative gained)

Player rolls Strike → Strong Hit
Skald:  "Your axe bites deep."   (auto: Reaver Captain +8 ticks, initiative kept)

Player rolls Strike → Weak Hit
Skald:  "A glancing blow — they wheel on you."   (auto: +8 ticks, initiative lost)

…the captain falls…
Skald:  "The captain drops to one knee and yields."  → [[EFFECT: end_combat Reaver Captain]]
```

`[[EFFECT: end_combat <Foe Name>]]` marks that foe's track complete when they're defeated, flee, or yield. Completed tracks persist on the sheet for the chronicle; only un-completed foes count as "active". Live combat state — who holds initiative, each active foe's progress, recently-ended fights — is fed back into the AI's context every turn.

### Vows

The same machinery powers quests: `[[EFFECT: create_vow <Name> <rank> <description>]]` creates a vow/quest progress track when you Swear an Iron Vow.

### Graceful by design

Every integration point feature-detects the Ironsworn system and degrades gracefully. If the system isn't present, these features quietly switch off and the Skald behaves exactly as it did in v2.0 — a pure AI storyteller. If a particular API isn't available in your Ironsworn version, the Skald falls back to a manual roll card rather than failing.

---

## Commands

All commands use the **`!`** prefix (not `/`). Foundry VTT v14 rejects unknown `/` slash commands before our module sees them.

| Command | Description |
|---|---|
| `!skald-help` | Show the command list. |
| `!skald <prompt>` | Talk to The Eternal Skald freely — rules questions, narration, ideas. |
| `!oracle <name>` | Roll an Ironsworn oracle and have the Skald interpret. e.g. `!oracle action`, `!oracle theme`. |
| `!npc <name>` | Conjure (or continue) an NPC. The Skald rolls oracle personas and stays in character. |
| `!scene <subject>` | Generate a vivid scene description, factoring in your current canvas. |
| `!lore <topic>` | Write world-building lore. A JournalEntry is created in the Skald's Chronicles folder. |
| `!combat <note?>` | Get tactical narration and Ironsworn-move suggestions for the current fight. |

### Available oracles
`action`, `theme`, `region`, `location`, `coastal`, `npc`, `npc-goal`, `npc-descriptor`, `combat`, `mystic`, `price`.

---

## Settings

All in **Configure Settings → The Eternal Skald** (world-scoped, GM-only):

| Setting | Default | Description |
|---|---|---|
| Abacus AI API Key | *(empty)* | Required. Get from your Abacus AI account. |
| AI Model | `gemini-3-flash-preview` | Any model your Abacus AI deployment exposes. |
| API Endpoint | `https://routellm.abacus.ai/v1/chat/completions` | Override only for custom AI backends. |
| Skald Intensity | 6 | 1 (terse) to 10 (full saga-singer operatic). |
| Auto-Narrate Combat | On | Short flavour line at each combatant's turn. |
| AI Controls Enemies | Off | Full AI turn for non-player combatants. |
| Conversation Memory | 20 | Rolling buffer length for short-term memory. |
| Ironsworn Rules Integration | On | Integrate with the foundry-ironsworn rules engine (see [Ironsworn Integration](#ironsworn-integration)). |
| Suggest Moves | On | Show the interactive move-suggestion card after narration. |
| Auto-Narrate Move Outcomes | On | Automatically narrate any Ironsworn roll's result. |
| Narration Delay (ms) | 2000 | How long to wait after a roll before auto-narrating, so dice animations can finish. ~2000ms with Dice So Nice, ~500ms without. Range 0–5000. |
| AI Applies Mechanical Effects | **On** | Let the Skald apply momentum/harm/stress/supply/progress/oracle effects and run the combat automation. |
| Auto-Create Combat Tracks | On | Auto-create a combat progress track per foe when a fight begins. |
| Default Enemy Rank | Dangerous | Challenge rank for auto-created combat tracks when none is specified. |
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

// Drive the suggestion / selector UI
await skald.integration.postSuggestionCard({ name: 'Secure an Advantage', stat: 'wits' });
await skald.integration.showMoveSelector();
```

---

## Troubleshooting

**"The Eternal Skald server hook is not loaded (404)"**
The `--import` flag isn't in your Foundry startup command, or the path is wrong. See [Setup step 2](#2-add---import-to-your-foundry-startup).

**No `⚔️ Skald | v0.3.0` line in Foundry's console output**
The hook file isn't being loaded. Check the path is absolute and correct. Run it in a terminal to see Node.js errors.

**"No Abacus AI API key is set"**
Go to Module Settings → The Eternal Skald and enter your key.

**`/skald-help` says "not a valid chat command"**
Use `!skald-help` (exclamation mark, not slash).

**Hosted Foundry (The Forge, etc.)**
If you can't modify the startup command, this module won't work on hosted platforms that don't support `--import`. Contact your hosting provider to ask about custom Node flags.

**Auto-narration doesn't fire after an Ironsworn roll**
Enable **Debug Logging** in Module Settings and check the browser console. As of **v0.3.0**, roll detection reads the `foundry-ironsworn` roll card HTML (the system no longer attaches module flags), logs every detection step, and waits for the configurable **Narration Delay** (default 2000ms) before narrating so dice animations can finish. Make sure **Auto-Narrate Moves** is enabled and you're logged in as the GM. If you still see no `Detected Ironsworn roll` log line, copy the console output and open an issue.

---

## Versioning & Release Strategy

The Eternal Skald follows [Semantic Versioning](https://semver.org/) with a deliberately conservative pre-1.0 policy:

- **`0.x.y` — pre-release (alpha/beta).** The entire `0.x` series is experimental. APIs, settings, and behavior may change without notice, and stability is not guaranteed. The project is here today.
- **Patch — `0.2.x`** → bug fixes, small tweaks, and polish. No new headline features.
- **Minor — `0.x.0`** → major new features or significant changes (and possibly breaking changes while still in `0.x`).
- **`1.0.0` — first official, production-ready release.** This will only be tagged once the module is feature-complete, well-tested across real campaigns, and stable enough to recommend for everyday play.

In short: until you see `1.0.0`, treat every release as a development build.

> **Note on earlier tags:** Some early builds were mistakenly published under `2.x` (e.g. `v2.0.0`, `v2.2.0`, `v2.2.1`). Those version numbers were never appropriate for a pre-release project and have been retired. The correct lineage is `0.1.x` → `0.2.0` → `0.2.2` (see [CHANGELOG.md](CHANGELOG.md)).

---

## Upgrading from older builds

The current architecture loads a server-side hook via Node's `--import` flag:

1. **Delete any old proxy** — if you were running `skald-proxy.js` or had systemd/PM2 units for it, remove them.
2. **Update your startup command** — the `--import` path is `scripts/eternal-skald-server.mjs` (older builds used `proxy/skald-hook.mjs`).
3. **Remove the old Proxy URL setting** — it no longer exists. The module has only one networking path now.

---

## License

This work is licensed under a [![CC BY-SA 4.0][cc-by-sa-shield]][cc-by-sa]

Buy the official Ironsworn books to support the creator.
