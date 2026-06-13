# Troubleshooting — The Eternal Skald

A quick reference for the most common issues, with the cause and the fix.
The Skald is designed to **fail soft**: when something is misconfigured it
should degrade gracefully (narration still works even if memory or the server
hook is unavailable) rather than break play. Most problems below are
configuration, environment (HTTP vs HTTPS), or stale-cache issues.

> **First two things to try for almost anything**
> 1. **Hard-refresh** the browser (`Ctrl+Shift+R` / `Cmd+Shift+R`) or restart
>    Foundry — a surprising number of "errors" are a stale cached copy of an
>    older script (see #10).
> 2. Open the browser **developer console** (`F12`) and read the actual error.
>    Errors prefixed with the module name tell you exactly what failed.

All settings below are under **Game Settings → Configure Settings → Module
Settings → The Eternal Skald** unless noted. Settings names are quoted exactly
as they appear in the UI.

---

## 1. "The Skald doesn't respond at all"

**Symptoms:** You type `!something` and nothing happens — no card, no error.

**Checks & fixes:**
- **Is AI Mode on?** Check the **"AI Mode"** setting. When it is off, the Skald
  stays silent by design. Turn it on (or use the in-chat toggle if present).
- **Are you using the trigger correctly?** Type `!` followed by your words
  (e.g. `!the wind howls`), or `!skald-help` to list every command.
- **Is the module enabled?** Confirm *The Eternal Skald* is enabled for the
  world (**Manage Modules**) and that you reloaded after enabling it.
- Open the console (`F12`) — if you see a JavaScript load error, see #10.

---

## 2. API key / authentication errors (401 / 403 / "invalid API key")

**Symptoms:** A whispered error mentioning `401`, `403`, "unauthorized",
"invalid api key", or "authentication".

**Cause:** The Skald talks to an OpenAI-compatible AI endpoint and needs **your
own API key** for the selected provider.

**Fixes:**
- Set **"API Key"** to a valid key for the provider you chose in **"AI
  Provider"**. A key from one provider will not work against another.
- Confirm **"API Provider"** and **"API Endpoint"** match the key. Picking a
  provider auto-fills its endpoint; if you hand-edited the endpoint, reset it by
  re-selecting the provider.
- Confirm **"AI Model"** is a model your key/account can actually call. A valid
  key with a model you lack access to also returns 401/403.
- Keys are stored per-world; re-enter the key if you copied a world.

---

## 3. `404 (Not Found)` on `/skald-api/...` (server hook not loaded)

**Symptoms:** Console shows `/skald-api/chat 404 (Not Found)` (or `/skald-api/health`).
Common on **hosted / managed Foundry** (e.g. Foundry on Abacus) where you can't
launch Foundry with the server-side `--import` flag.

**Cause:** The optional server hook (`scripts/eternal-skald-server.mjs`) is not
loaded, so the `/skald-api/*` routes don't exist.

**Fixes:**
- **Easiest:** set **"Connection Mode"** to **Auto** (the default) or **Direct
  browser→AI**. In Auto the Skald automatically falls back to calling the AI
  directly from your browser when the hook isn't present — it just works without
  the server hook.
- If you *want* the server hook (self-hosted only), start Foundry with the
  documented `--import` flag so the hook module is loaded, then check
  `GET /skald-api/health` returns the current version.
- Only **"Server hook only"** mode will surface this as a hard failure — that
  mode deliberately does not fall back.

---

## 4. `502 / 503 / 504 Bad Gateway` on hosted Foundry, or `!scout` hangs

**Symptoms:** `MapVision 502 Bad Gateway`, a wall of HTML in chat, or `!scout`
appearing to stall/repeat slowly.

**Cause:** On hosted Foundry the reverse proxy answers the missing `/skald-api`
route with `502/503/504` (or `413` for an oversized body) instead of `404`.

**Fixes:**
- Set **"Connection Mode"** to **Auto** — the Skald treats `502/503/504/413` as
  "hook unreachable" and transparently retries the call directly. After the
  first probe it remembers the hook is down for the rest of the session, so
  later passes are fast (no repeated proxy timeouts).
- If you previously pinned **"Server hook only"**, switch back to **Auto**.

---

## 5. AI memory (RAG) won't index / "Browser cache is not available"

**Symptoms:** `!rag-status` shows nothing indexed, or you see
"Browser cache is not available"; semantic recall and `!remind` feel empty.

**Cause:** The in-browser embedding cache requires a **secure context**
(HTTPS or `localhost`). On plain-HTTP LAN/remote Foundry the persistent cache is
unavailable.

**Fixes:**
- Serve Foundry over **HTTPS**, or access it via `http://localhost` on the same
  machine — then the cache works and embeddings persist.
- On plain HTTP the Skald falls back to **in-memory** embeddings: memory still
  works for the session but is not persisted across reloads. This is expected,
  not a hard failure.
- Run `!reindex` to rebuild memory after adding many journals, then `!rag-status`
  to confirm. The small embedding model downloads once and is cached.
- Narration works fully even when memory can't load — RAG is additive.

---

## 6. Ironsworn features missing / "not detected"

**Symptoms:** Moves, vows, journeys, combat tracks or sheet-reading don't work;
the Skald narrates but ignores mechanics.

**Cause:** Ironsworn-specific mechanics only activate when the
**foundry-ironsworn** game system is the active world system.

**Fixes:**
- Confirm the world's **game system** is *Ironsworn* (or *Ironsworn: Delve*),
  and that the `foundry-ironsworn` system is installed and up to date.
- Check **"Ironsworn Rules Integration"** is enabled.
- Make sure you have an **active character** assigned — vow/journey/sheet
  features read from the selected actor.
- On any other system the Skald uses a system adapter (e.g. read-only **Nimble**)
  or a safe **null adapter**; the agnostic chronicle/memory/narration core still
  works. See `docs/SYSTEMS.md`.

---

## 7. `!scout` / map vision fails or returns poor results

**Symptoms:** `!scout` errors, returns raw JSON, or misses obvious map labels.

**Cause:** Map vision needs a **vision-capable** model; lightweight models miss
fine detail, and some models can't see images at all.

**Fixes:**
- Set **"Vision Model"** to a strong vision model (e.g. `gpt-4o`,
  `claude-3-5-sonnet`, `gemini-2.0-flash`, `gemini-2.5-pro`), or leave it on
  *Inherit* only if your narration model can see images.
- If the model can't see images, the Skald skips analysis with a GM notice
  rather than wasting a call — switch to a vision model.
- For dense fantasy maps, raise the **"Map Analysis Quality"** setting
  (*Balanced* / *Thorough*) for grid-sectioned detail passes.
- Truncated/garbled cards usually mean the reply hit the token limit — the
  parser salvages readable fields, but a stronger model helps.

---

## 8. Connection Mode confusion (when to use which)

**"Connection Mode"** controls how the browser reaches the AI:

| Mode | Use when |
| --- | --- |
| **Auto** (default) | Almost always. Tries the server hook, falls back to direct browser→AI on 404/502/503/504/413. |
| **Direct browser→AI** | Hosted/managed Foundry where you can't load the server hook. Forces the direct path. |
| **Server hook only** | Self-hosted with the `--import` server hook loaded and you want all traffic via the server (no fallback; genuine errors surface). |

If anything network-related misbehaves, set it back to **Auto** first.

---

## 9. CORS / "blocked by CORS policy" on a custom endpoint

**Symptoms:** Console shows a CORS error when calling the AI directly from the
browser (common with **Direct browser→AI** mode and a custom provider).

**Cause:** The browser→AI request is cross-origin; your endpoint must allow it.
The default Abacus AI endpoint allows the cross-origin request, so no setup is
needed there.

**Fixes:**
- Use the default **Abacus AI** provider/endpoint (CORS-friendly out of the box).
- If you must use a custom endpoint, ensure it returns permissive CORS headers
  for browser requests, or run the **server hook** and use **Server hook only**
  mode so the request is server-side (no browser CORS).

---

## 10. Syntax error on load / "missing ) after argument list" / stale cache

**Symptoms:** The module fails to load with a JavaScript error (historically
*"missing ) after argument list"* around a specific line), even after updating.

**Cause:** Your browser or Foundry is running a **cached copy of an old script**.
The shipped scripts are validated in strict ES-module mode.

**Fixes:**
- **Hard-refresh** (`Ctrl+Shift+R` / `Cmd+Shift+R`) or **restart Foundry** to
  force a fresh download.
- Fully update the module to the current version first, then hard-refresh.
- Confirm the loaded version: the load banner reads the version from the
  manifest (`game.modules.get("the-eternal-skald").version`). If it doesn't show
  the version you installed, it's still cached.

---

## Still stuck?

- Open the console (`F12`) and copy the **exact** error text (with the module
  prefix) — it names the failing subsystem.
- Note your environment: Foundry version, game system + version, HTTP vs HTTPS,
  hosted vs self-hosted, and your **"Connection Mode"** / **"AI Provider"**.
- Try **AI Mode off then on**, a hard refresh, and `!rag-status` to capture
  memory state.
- File an issue with the above details at the project repository (see the
  `url` in `module.json`).
