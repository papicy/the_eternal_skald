# The Eternal Skald — Network Helper Setup Guide

This document gives copy-paste templates for keeping either the **server hook** (Option A) or the **standalone proxy** (Option B) running across reboots.

> **Which do I need?** See the [main README](../README.md#networking-setup) for the comparison. TL;DR — if your Foundry is on HTTPS or remote, you want **Option A**.

---

## Reverse Proxy Users (Nginx, Caddy, Apache, Cloudflare Tunnel, etc.)

**No extra configuration is needed.** The server hook (Option A) works automatically behind any reverse proxy.

The Skald client uses a **relative URL** (`/skald-api/chat`) for the hook endpoint — it never constructs an absolute URL with a specific protocol, host, or port. The browser resolves the relative path against whatever origin it loaded Foundry from:

| How you access Foundry | What the browser fetches |
|---|---|
| `http://192.168.1.45:30000` | `http://192.168.1.45:30000/skald-api/chat` |
| `https://foundry.example.com` | `https://foundry.example.com/skald-api/chat` |
| `https://foundry.example.com:8443` | `https://foundry.example.com:8443/skald-api/chat` |
| `http://localhost:30000` | `http://localhost:30000/skald-api/chat` |

Because the request is always same-origin, there are **no CORS headers**, **no Mixed Content blocks**, and **no additional proxy rules** to add. As long as your reverse proxy forwards unknown paths to Foundry (which is the standard default), `/skald-api/*` passes through transparently.

> **Tip:** If you use Cloudflare with strict WAF rules or path-based routing, make sure `/skald-api/*` is not blocked by a firewall rule. Most default configurations pass it through without issue.

---

## Table of contents

- [Reverse Proxy Users](#reverse-proxy-users-nginx-caddy-apache-cloudflare-tunnel-etc)
- [Option A — Server Hook](#option-a--server-hook)
  - [systemd (Linux)](#systemd-linux--option-a)
  - [PM2 (Linux / macOS / Windows)](#pm2--option-a)
  - [Docker / docker-compose](#docker--docker-compose--option-a)
  - [Windows service via NSSM](#windows-nssm--option-a)
- [Option B — Standalone Proxy](#option-b--standalone-proxy)
  - [systemd (Linux)](#systemd-linux--option-b)
  - [PM2 (Linux / macOS / Windows)](#pm2--option-b)
  - [Docker / docker-compose](#docker--docker-compose--option-b)
  - [launchd (macOS)](#launchd-macos--option-b)
  - [Windows service via NSSM](#windows-nssm--option-b)
- [Verifying it works](#verifying-it-works)
- [Troubleshooting](#troubleshooting)

---

## Option A — Server Hook

Substitute these paths everywhere below:

- `FOUNDRY_DIR` — where Foundry's `resources/app/main.mjs` lives (the place you unzipped Foundry into).
- `FOUNDRY_DATA` — where your `Data/modules/the-eternal-skald/` lives.

In most installs `FOUNDRY_DATA` is a sibling of `FOUNDRY_DIR` (e.g. `/opt/foundry/`) but they can be anywhere.

### systemd (Linux) — Option A

Create `/etc/systemd/system/foundry.service`:

```ini
[Unit]
Description=Foundry VTT (with The Eternal Skald hook)
After=network.target

[Service]
Type=simple
User=foundry
WorkingDirectory=/opt/foundry
ExecStart=/usr/bin/node \
  --import /opt/foundry/Data/modules/the-eternal-skald/proxy/skald-hook.mjs \
  /opt/foundry/resources/app/main.mjs \
  --dataPath=/opt/foundry
Restart=on-failure
RestartSec=5
# Optional hardening:
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/foundry

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now foundry
sudo systemctl status foundry
```

> The `--import` flag MUST appear **before** the `resources/app/main.mjs` argument. Node treats anything after the script as positional arguments for Foundry.

### PM2 — Option A

```bash
pm2 start /opt/foundry/resources/app/main.mjs \
  --name foundry \
  --node-args="--import /opt/foundry/Data/modules/the-eternal-skald/proxy/skald-hook.mjs" \
  -- --dataPath=/opt/foundry
pm2 save
pm2 startup   # follow the printed instructions to enable on boot
```

To check logs:
```bash
pm2 logs foundry --lines 50
```

### Docker / docker-compose — Option A

If you run Foundry in Docker (e.g. `felddy/foundryvtt`), override the entrypoint to add the `--import` flag. Example `docker-compose.override.yml`:

```yaml
services:
  foundry:
    environment:
      FOUNDRY_NODE_ARGS: "--import /data/Data/modules/the-eternal-skald/proxy/skald-hook.mjs"
    # OR, if the image doesn't honour that env var, override the entrypoint:
    # entrypoint: ["node", "--import", "/data/Data/modules/the-eternal-skald/proxy/skald-hook.mjs", "/home/foundry/resources/app/main.mjs"]
    # command: ["--dataPath=/data"]
```

> Check the specific image's docs for the right environment variable / entrypoint shape. The principle is: **wherever `node main.mjs` is invoked, add `--import <absolute path to skald-hook.mjs>` between `node` and `main.mjs`.**

### Windows NSSM — Option A

If you installed Foundry as a Windows service via [NSSM](https://nssm.cc/):

```cmd
nssm edit FoundryVTT
```

Set:
- **Path:** `C:\Program Files\nodejs\node.exe`
- **Arguments:** `--import "C:\foundry-data\Data\modules\the-eternal-skald\proxy\skald-hook.mjs" "C:\foundry\resources\app\main.mjs" --dataPath="C:\foundry-data"`
- **Startup directory:** `C:\foundry`

Save and restart the service.

---

## Option B — Standalone Proxy

The proxy is `proxy/skald-proxy.js`. It's a tiny Node script with zero npm dependencies. Anywhere below, substitute:

- `SKALD_DIR` — absolute path to `Data/modules/the-eternal-skald/`.

### systemd (Linux) — Option B

Create `/etc/systemd/system/skald-proxy.service`:

```ini
[Unit]
Description=The Eternal Skald Proxy
After=network.target

[Service]
Type=simple
User=foundry
Environment=SKALD_PROXY_PORT=3001
Environment=SKALD_PROXY_HOST=0.0.0.0
WorkingDirectory=/opt/foundry/Data/modules/the-eternal-skald
ExecStart=/usr/bin/node proxy/skald-proxy.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now skald-proxy
sudo systemctl status skald-proxy
```

### PM2 — Option B

```bash
cd /opt/foundry/Data/modules/the-eternal-skald
pm2 start proxy/skald-proxy.js --name skald-proxy
pm2 save
pm2 startup
```

Alternative — `ecosystem.config.js` in the module folder:

```js
module.exports = {
  apps: [{
    name: 'skald-proxy',
    script: 'proxy/skald-proxy.js',
    env: {
      SKALD_PROXY_PORT: 3001,
      SKALD_PROXY_HOST: '0.0.0.0'
    },
    autorestart: true,
    max_restarts: 10
  }]
};
```

```bash
pm2 start ecosystem.config.js
pm2 save
```

### Docker / docker-compose — Option B

`Dockerfile`:

```dockerfile
FROM node:20-alpine
WORKDIR /skald
COPY proxy/skald-proxy.js ./skald-proxy.js
ENV SKALD_PROXY_HOST=0.0.0.0
ENV SKALD_PROXY_PORT=3001
EXPOSE 3001
CMD ["node", "skald-proxy.js"]
```

`docker-compose.yml`:

```yaml
services:
  skald-proxy:
    build: .
    container_name: skald-proxy
    restart: unless-stopped
    ports:
      - "3001:3001"
    environment:
      SKALD_PROXY_HOST: 0.0.0.0
      SKALD_PROXY_PORT: 3001
```

```bash
docker compose up -d
```

### launchd (macOS) — Option B

Create `~/Library/LaunchAgents/com.eternalskald.proxy.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.eternalskald.proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/youruser/foundry-data/Data/modules/the-eternal-skald/proxy/skald-proxy.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/skald-proxy.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/skald-proxy.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SKALD_PROXY_PORT</key>
    <string>3001</string>
  </dict>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.eternalskald.proxy.plist
launchctl start com.eternalskald.proxy
```

### Windows NSSM — Option B

```cmd
nssm install SkaldProxy "C:\Program Files\nodejs\node.exe" "C:\foundry-data\Data\modules\the-eternal-skald\proxy\skald-proxy.js"
nssm set    SkaldProxy AppDirectory "C:\foundry-data\Data\modules\the-eternal-skald"
nssm set    SkaldProxy AppEnvironmentExtra SKALD_PROXY_PORT=3001
nssm start  SkaldProxy
```

---

## Verifying it works

**Option A:**
```bash
curl https://your-foundry.example/skald-api/health
# → {"status":"ok","service":"The Eternal Skald Hook","version":"1.0.8"}
```

**Option B:**
```bash
curl http://localhost:3001/
# → {"status":"ok","service":"The Eternal Skald Proxy","version":"1.0.8"}
```

Then in Foundry's chat, type `!skald hello` — you should get a Skald response within ~5 seconds.

---

## Troubleshooting

**Foundry won't start after adding `--import`**
- Double-check the absolute path to `skald-hook.mjs`. The flag must come **before** `main.mjs`.
- Run the same command from a terminal so you can see the stderr — the hook prints `[Skald Hook] Active.` once it patches `http.createServer`. If you don't see that line, the path is wrong.

**`curl` to `/skald-api/health` returns Foundry's HTML 404 page**
- The hook didn't load. Check Foundry's stdout for `[Skald Hook]` log lines.
- Make sure your reverse proxy is forwarding `/skald-api/*` to Foundry. Most are configured to forward `/` already, so this should "just work" — but some Cloudflare rules will block unknown paths.

**`Bind: EADDRINUSE` from skald-proxy**
- Port 3001 is already taken. Set `SKALD_PROXY_PORT=4444` (or any free port) **and** update the module's **Proxy URL** setting to match (e.g. `http://localhost:4444/api/chat`).

**Skald says "no network route"**
- Both Option A and Option B failed to respond. Check the verification curl commands above. Fix whichever you're using and reload Foundry.

**Hook can't see `process.env.SKALD_PROXY_*` variables**
- That's fine — those are for the standalone proxy only. The hook doesn't read environment variables; it uses Foundry's own listener.
