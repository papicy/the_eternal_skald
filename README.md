# The Eternal Skald

An AI-powered storyteller, oracle interpreter, and tactical enemy controller for **Ironsworn** and **Ironsworn: Delve** campaigns in Foundry Virtual Tabletop v14. The Eternal Skald is a wise, dramatic norse narrator who serves as the GM at your table — interpreting oracle rolls, voicing NPCs, generating lore, narrating combat, and even taking control of enemy combatants on their turn.

Powered by the **Abacus AI ChatLLM** platform (Gemini 3.0 Flash by default).

---

## Installation (recommended)

1. In Foundry VTT, open **Setup → Add-on Modules → Install Module**.
2. Paste this **Manifest URL** into the bottom field and click **Install**:
   ```
   https://raw.githubusercontent.com/papicy/eternal_skald/main/module.json
   ```
3. Activate **The Eternal Skald** in your world and open **Configure Settings → The Eternal Skald**.
4. Enter your **Abacus AI API Key** and save.
5. **Start the local proxy** (one-time setup — see [Proxy Setup](#proxy-setup) below).
6. In chat, type `!skald-help` to see the full command list.

### Manual install
If you prefer to install manually, download the release zip:
`https://github.com/papicy/eternal_skald/releases/latest`

Unzip into your Foundry `Data/modules/` directory (so that `Data/modules/the-eternal-skald/module.json` exists) and restart Foundry.

---

## Proxy Setup

**TL;DR — before using the Skald you must launch the bundled proxy.** Open a terminal on the machine where your Foundry browser runs and execute:

```bash
cd <your-foundry-data>/modules/the-eternal-skald
node proxy/skald-proxy.js
```

Leave that terminal open while you play. You should see:

```
⚔️  The Eternal Skald Proxy running on http://localhost:3001
```

### Why a proxy?

Foundry VTT runs in your browser. Browsers block cross-origin requests to `api.abacus.ai` from a Foundry origin (e.g. `http://localhost:30000`, or whatever LAN address Foundry is served on) because Abacus AI does not return CORS headers. Without the proxy, every chat call fails with **`CORS Missing Allow Origin`** in DevTools and no Skald reply ever arrives.

The proxy is a tiny Node.js HTTP server (`proxy/skald-proxy.js`) bundled with the module. It listens on `localhost:3001`, forwards your request to the configured Abacus AI endpoint with your API key, and returns the upstream response with the right `Access-Control-Allow-Origin` headers attached. **The proxy never persists or logs your API key** — it just passes it through.

### Requirements

- **Node.js 18 or newer** (uses only built-in modules — `http`, `https`, `url` — no `npm install` needed).
- Must run on the **same machine** that opens Foundry in the browser. If your browser is on machine A and Foundry's web server is on machine B, the proxy belongs on **A**.

### Optional configuration

Environment variables (set them before `node proxy/skald-proxy.js`):

| Variable | Default | Effect |
|---|---|---|
| `SKALD_PROXY_PORT` | `3001` | Port the proxy listens on |
| `SKALD_PROXY_HOST` | `0.0.0.0` | Bind address. The default binds on all interfaces so the proxy works whether your browser talks to it via `localhost` or via the LAN IP your Foundry server is on. Set to `localhost` / `127.0.0.1` to restrict to loopback only. |

If you change the port, update **Configure Settings → The Eternal Skald → Proxy URL** to match (e.g. `http://localhost:4444/api/chat`).

### Running it in the background

To keep the proxy alive across reboots, use your favourite process manager — `systemd` on Linux, `launchd` on macOS, **NSSM** or Task Scheduler on Windows, or simply `pm2 start proxy/skald-proxy.js --name skald` if you have PM2.

### Verifying it works

In a second terminal:

```bash
curl http://localhost:3001/
```

You should get `{"status":"ok","service":"The Eternal Skald Proxy","version":"1.0.7"}`.

---

## Commands

> All commands use the **`!`** prefix (not `/`). Foundry VTT v14 rejects unknown `/` slash commands before our module ever sees them, so we use `!` to bypass that internal validation.

| Command | Description |
|---|---|
| `!skald-help` | Show the command list. |
| `!skald <prompt>` | Talk to The Eternal Skald freely — rules questions, narration, ideas. |
| `!oracle <name>` | Roll an Ironsworn oracle and have the Skald interpret. e.g. `!oracle action`, `!oracle theme`, `!oracle npc`, `!oracle price`. |
| `!npc <name or descriptor>` | Conjure (or continue) an NPC. The Skald rolls an oracle persona on first contact, then stays in character on subsequent calls. |
| `!scene <subject>` | Generate a vivid scene description, factoring in your current canvas scene. |
| `!lore <topic>` | Write world-building lore. A JournalEntry is created in the **Skald's Chronicles** folder. |
| `!combat <note?>` | Get tactical narration and a concrete Ironsworn-move suggestion for the current fight. |

### Available oracles
`action`, `theme`, `region`, `location`, `coastal`, `npc` (role), `npc-goal`, `npc-descriptor`, `combat`, `mystic`, `price`.

---

## Settings

All settings live under **Configure Settings → The Eternal Skald** (world-scoped, GM-only):

- **Abacus AI API Key** — Required. Get this from your Abacus AI account.
- **AI Model** — Defaults to `gemini-3.0-flash`. Any model exposed by your Abacus AI deployment works.
- **API Endpoint** — Defaults to `https://api.abacus.ai/v1/chat/completions`. Override if you proxy through a custom backend.
- **Proxy URL** — Defaults to `http://localhost:3001/api/chat`. The Skald talks to the local proxy at this URL; the proxy then forwards to **API Endpoint**. See [Proxy Setup](#proxy-setup).
- **Skald Intensity** — 1 (terse) to 10 (full saga-singer operatic).
- **Auto-Narrate Combat** — Short flavour line at the start of each combatant's turn.
- **AI Controls Enemies** — When ON, the Skald takes the full turn for any non-player combatant: decides action, moves the token, rolls the Ironsworn attack, applies harm, then advances the turn.
- **Conversation Memory** — Rolling buffer length for the Skald's short-term memory.

---

## Public API

For macros and other modules:

```js
const skald = game.modules.get('the-eternal-skald').api;

// Direct ChatLLM call
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

**`/skald-help` says "not a valid chat command — no packages detected"**
That's expected — use `!skald-help` (exclamation mark, not slash). See the explanation above the command table.

**`The Skald's proxy is not running. Start it with: node proxy/skald-proxy.js`**
The local CORS proxy is not running. Open a terminal on the same machine as your Foundry browser, `cd` into the module's folder (`<foundry-data>/Data/modules/the-eternal-skald`) and run `node proxy/skald-proxy.js`. Keep that terminal open. See [Proxy Setup](#proxy-setup) for the full story.

**DevTools shows `CORS Missing Allow Origin` for `api.abacus.ai`**
You skipped the proxy. From v1.0.6 onward all Skald requests must go through the bundled proxy on `http://localhost:3001`. Browsers refuse to call Abacus AI directly because Abacus doesn't return CORS headers. Start the proxy, refresh Foundry, try again.

**No log lines in DevTools when launching a world**
The module file never loaded. Confirm the install was successful and that the module is activated for the world. As of v1.0.7 the module logs `=== The Eternal Skald v1.0.7 — module file loaded ===` to the console as soon as it begins executing.

**"DOCTYPE error" / install fails**
The release zip must be installed via the manifest URL above. Older versions used GitHub's auto-generated archive zip which wrapped everything in a subfolder; the published release asset (`the-eternal-skald.zip`) has files at the zip root.

---

## License

Module code: MIT.  
Ironsworn rules content paraphrased under the **Ironsworn SRD (CC-BY 4.0, Shawn Tomkin)**. Buy the official Ironsworn books to support the creator.
