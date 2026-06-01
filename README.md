# The Eternal Skald

An AI-powered storyteller, oracle interpreter, and tactical enemy controller for **Ironsworn** and **Ironsworn: Delve** campaigns in Foundry Virtual Tabletop v14. The Eternal Skald is a wise, dramatic norse narrator who serves as the GM at your table — interpreting oracle rolls, voicing NPCs, generating lore, narrating combat, and even taking control of enemy combatants on their turn.

Powered by the **Abacus AI ChatLLM** platform (Gemini 3.0 Flash by default).

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
⚔️  Skald | v2.0.0 — server hook active. /skald-api/* routes ready.
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
{"status":"ok","service":"The Eternal Skald","version":"2.0.0"}
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
     │                                       │  api.abacus.ai
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
| AI Model | `gemini-3.0-flash` | Any model your Abacus AI deployment exposes. |
| API Endpoint | `https://api.abacus.ai/v1/chat/completions` | Override only for custom AI backends. |
| Skald Intensity | 6 | 1 (terse) to 10 (full saga-singer operatic). |
| Auto-Narrate Combat | On | Short flavour line at each combatant's turn. |
| AI Controls Enemies | Off | Full AI turn for non-player combatants. |
| Conversation Memory | 20 | Rolling buffer length for short-term memory. |

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
```

---

## Troubleshooting

**"The Eternal Skald server hook is not loaded (404)"**
The `--import` flag isn't in your Foundry startup command, or the path is wrong. See [Setup step 2](#2-add---import-to-your-foundry-startup).

**No `⚔️ Skald | v2.0.0` line in Foundry's console output**
The hook file isn't being loaded. Check the path is absolute and correct. Run it in a terminal to see Node.js errors.

**"No Abacus AI API key is set"**
Go to Module Settings → The Eternal Skald and enter your key.

**`/skald-help` says "not a valid chat command"**
Use `!skald-help` (exclamation mark, not slash).

**Hosted Foundry (The Forge, etc.)**
If you can't modify the startup command, this module won't work on hosted platforms that don't support `--import`. Contact your hosting provider to ask about custom Node flags.

---

## Upgrading from v1.x

v2.0.0 is a clean architectural rebuild:

1. **Delete the old proxy** — if you were running `skald-proxy.js` or had systemd/PM2 units for it, remove them.
2. **Update your startup command** — the `--import` path changed from `proxy/skald-hook.mjs` to `scripts/eternal-skald-server.mjs`.
3. **Remove the Proxy URL setting** — it no longer exists. The module has only one networking path now.

---

## License

Module code: MIT.
Ironsworn rules content paraphrased under the **Ironsworn SRD (CC-BY 4.0, Shawn Tomkin)**. Buy the official Ironsworn books to support the creator.
