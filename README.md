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
5. **Set up the network helper** — pick **Option A** (recommended) or **Option B**. See [Networking Setup](#networking-setup) below.
6. In chat, type `!skald-help` to see the full command list.

### Manual install
If you prefer to install manually, download the release zip:
`https://github.com/papicy/eternal_skald/releases/latest`

Unzip into your Foundry `Data/modules/` directory (so that `Data/modules/the-eternal-skald/module.json` exists) and restart Foundry.

---

## Networking Setup

### Why does the Skald need a network helper?

Foundry VTT runs in your browser. Browsers block cross-origin requests to `api.abacus.ai` from a Foundry origin (e.g. `https://your-foundry.example`, `http://localhost:30000`, or whatever LAN address Foundry is served on) because Abacus AI does not return CORS headers. Without a helper, every chat call fails with **`CORS Missing Allow Origin`** in DevTools and no Skald reply ever arrives.

Additionally, **if your Foundry runs on HTTPS** (e.g. behind a Cloudflare Tunnel, a Caddy / Nginx reverse proxy, or anything serving `https://...`), the browser blocks insecure `http://localhost:3001` calls as **Mixed Content** — so the standalone proxy alone is not enough.

To solve this universally, v1.0.9 ships **two** options. Pick the one that fits your setup:

| Option | When to use | Where requests come from |
|---|---|---|
| **A — Server Hook (recommended)** | Anyone running their own Foundry server (HTTPS or HTTP, with or without reverse proxy). Works for remote browsers. | Foundry's own port. Same-origin. No CORS, no Mixed Content. |
| **B — Standalone Proxy (fallback)** | Local-only setups where the browser and Foundry run on the **same machine**, and you can't or don't want to modify the Foundry startup command. | A second process on `localhost:3001`. |

The Skald client tries **A** first (`/skald-api/chat` on the same origin as Foundry). If that returns 404 it automatically falls back to **B** (the configured **Proxy URL**). So once one is set up, the module just works.

---

### Reverse Proxy Users (Nginx, Caddy, Apache, Cloudflare Tunnel, etc.)

**No extra configuration is needed.** If you use Option A (server hook), the Skald works automatically behind any reverse proxy — no additional proxy rules, location blocks, or header rewrites required.

This works because the Skald client uses a **relative URL** (`/skald-api/chat`) rather than an absolute one. The browser resolves it against whatever origin Foundry is served from:

- `http://192.168.1.45:30000` → `http://192.168.1.45:30000/skald-api/chat` ✅
- `https://foundry.example.com` → `https://foundry.example.com/skald-api/chat` ✅
- `https://play.mydomain.net:8443` → `https://play.mydomain.net:8443/skald-api/chat` ✅
- `http://localhost:30000` → `http://localhost:30000/skald-api/chat` ✅

Same origin = **no CORS**, **no Mixed Content**, works on HTTP/HTTPS, IP addresses, domain names — everything. As long as your reverse proxy forwards unknown paths to Foundry (the standard default), `/skald-api/*` passes through transparently.

---

### Option A — Server Hook (recommended)

The hook is a single ESM file (`proxy/skald-hook.mjs`) that patches Foundry's HTTP server at startup and exposes `/skald-api/*` on Foundry's own port. Same origin = no CORS, no Mixed Content, **no extra port to open or proxy through.**

#### Setup

1. **Locate your Foundry data directory** (the one that contains `Data/modules/the-eternal-skald/`).
2. **Stop Foundry** if it is currently running.
3. **Start Foundry with the `--import` flag** pointing at the bundled hook:

   **Linux / macOS (native install):**
   ```bash
   node \
     --import ./Data/modules/the-eternal-skald/proxy/skald-hook.mjs \
     resources/app/main.mjs \
     --dataPath=<your-foundry-data-path>
   ```

   **PM2 (recommended for a server install):**
   ```bash
   pm2 start /opt/foundry/resources/app/main.mjs \
     --name foundry \
     --node-args="--import /opt/foundry/Data/modules/the-eternal-skald/proxy/skald-hook.mjs" \
     -- --dataPath=/opt/foundry
   pm2 save
   ```

   **systemd unit (one-time):** add `--import` to the `ExecStart=` line of your Foundry service. See [`proxy/SETUP.md`](proxy/SETUP.md) for a full template.

   **Windows (with Node.js installed directly):**
   ```cmd
   node --import "./Data/modules/the-eternal-skald/proxy/skald-hook.mjs" resources/app/main.mjs --dataPath=...
   ```

   **Forge / hosted Foundry:** Forge runs the Foundry binary you don't control; use **Option B** instead.

4. **Restart Foundry.** Open Foundry's console output and you should see one of:
   ```
   [Skald Hook] Active. /skald-api/* routes are now available on this server.
   ```

#### Verifying it works

Open this URL in any browser that can reach your Foundry instance (replace with your own host/port):

```
https://your-foundry.example/skald-api/health
```

You should see:
```json
{"status":"ok","service":"The Eternal Skald Hook","version":"1.0.9"}
```

If the response is 404 or "Cannot GET /skald-api/health", the hook is not loaded — re-check the `--import` argument and that Foundry was fully restarted.

---

### Option B — Standalone Proxy (fallback)

If you can't modify Foundry's startup (e.g. Forge hosting, or you don't want to touch the service definition), launch the bundled proxy in a separate terminal. **Only works when your browser and Foundry are on the same machine.**

```bash
cd <your-foundry-data>/Data/modules/the-eternal-skald
node proxy/skald-proxy.js
```

Leave that terminal open while you play. You should see:
```
⚔️  The Eternal Skald Proxy running on http://localhost:3001
```

#### Requirements

- **Node.js 18 or newer** (uses only built-in modules — `http`, `https`, `url` — no `npm install` needed).
- Must run on the **same machine** that opens Foundry in the browser. If your browser is on machine A and Foundry's web server is on machine B, the proxy belongs on **A**.
- **Will NOT work** when Foundry is served over HTTPS to the browser — the browser blocks `http://localhost:3001` as Mixed Content. Use **Option A** instead.

#### Optional configuration

Environment variables (set them before `node proxy/skald-proxy.js`):

| Variable | Default | Effect |
|---|---|---|
| `SKALD_PROXY_PORT` | `3001` | Port the proxy listens on |
| `SKALD_PROXY_HOST` | `0.0.0.0` | Bind address. The default binds on all interfaces so the proxy works whether your browser talks to it via `localhost` or via the LAN IP your Foundry server is on. Set to `localhost` / `127.0.0.1` to restrict to loopback only. |

If you change the port, update **Configure Settings → The Eternal Skald → Proxy URL** (e.g. `http://localhost:4444/api/chat`).

#### Running it in the background

See [`proxy/SETUP.md`](proxy/SETUP.md) for **systemd**, **PM2**, **NSSM** (Windows), **launchd** (macOS), and **Docker / docker-compose** templates.

#### Verifying it works

```bash
curl http://localhost:3001/
```

You should get `{"status":"ok","service":"The Eternal Skald Proxy","version":"1.0.9"}`.

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
- **Proxy URL (fallback)** — Defaults to `http://localhost:3001/api/chat`. Used only if the same-origin hook (Option A) is **not** available — see [Networking Setup](#networking-setup).
- **Skald Intensity** — 1 (terse) to 10 (full saga-singer operatic).
- **Auto-Narrate Combat** — Short flavour line at the start of each combatant's turn.
- **AI Controls Enemies** — When ON, the Skald takes the full turn for any non-player combatant: decides action, moves the token, rolls the Ironsworn attack, applies harm, then advances the turn.
- **Conversation Memory** — Rolling buffer length for the Skald's short-term memory.

---

## Public API

For macros and other modules:

```js
const skald = game.modules.get('the-eternal-skald').api;

// Direct ChatLLM call (auto-detects whichever network helper is active)
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

**`The Skald has no network route. Activate either the server hook or the standalone proxy.`**
Neither the same-origin hook nor the configured proxy URL responded. Set up either [Option A](#option-a--server-hook-recommended) or [Option B](#option-b--standalone-proxy-fallback) and reload Foundry. The console log shows which route the Skald is trying.

**DevTools shows `CORS Missing Allow Origin` for `api.abacus.ai`**
Your Skald is calling Abacus AI **directly**. That's never the right thing — always route through the hook (`/skald-api/chat`) or the proxy (`/api/chat`). Double-check the **Proxy URL** setting and reload.

**DevTools shows `Mixed Content … blocked` for `http://localhost:3001`**
Your Foundry is on HTTPS but you're trying to use Option B (`http://localhost:3001`). Browsers block this. **Switch to Option A.**

**No log lines in DevTools when launching a world**
The module file never loaded. Confirm the install was successful and that the module is activated for the world. As of v1.0.9 the module logs `=== The Eternal Skald v1.0.9 — module file loaded ===` to the console as soon as it begins executing.

**`Cannot read properties of undefined (reading 'turnCount')`**
That was a v1.0.7 bug triggered when the API call failed during NPC turn auto-play (so the session record wasn't saved). Update to **v1.0.9 or newer** — fixed.

**"DOCTYPE error" / install fails**
The release zip must be installed via the manifest URL above. Older versions used GitHub's auto-generated archive zip which wrapped everything in a subfolder; the published release asset (`the-eternal-skald.zip`) has files at the zip root.

---

## License

Module code: MIT.  
Ironsworn rules content paraphrased under the **Ironsworn SRD (CC-BY 4.0, Shawn Tomkin)**. Buy the official Ironsworn books to support the creator.
