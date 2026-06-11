# Deployment Summary — The Eternal Skald

**Status:** ✅ Successfully uploaded to GitHub and verified accessible.

## Essential URLs

| Item | URL |
|------|-----|
| **Repository** | https://github.com/papicy/the_eternal_skald |
| **Manifest (for Foundry install)** | `https://raw.githubusercontent.com/papicy/the_eternal_skald/main/module.json` |
| **Download zip** | `https://github.com/papicy/the_eternal_skald/archive/refs/heads/main.zip` |
| **Release tag** | `v0.10.38` |

## Verification Results

- **Git remote** → `skald_new` points at `https://github.com/papicy/the_eternal_skald.git` ✅
- **Working tree clean** (only the platform-protected `.abacus.donotdelete` shows, as always) ✅
- **Local `main` == remote `main`** (`e3c4a90`) ✅
- **Tag `v0.10.38` pushed** to remote ✅
- **55 files on GitHub** across all directories ✅
- **Manifest URL** returns HTTP 200, valid JSON ✅
- **Download zip** returns HTTP 200 (~450 KB) ✅
- **Test suite:** 20/20 files, 971 assertions green ✅

## Files Uploaded (55 total)

### Root
- `module.json`, `README.md`, `REFACTOR_COMPLETE.md`, `package.json`, `CHANGELOG.md`, `LICENSE`, `.gitignore`, `TEST.md`

### `scripts/` (refactored ES modules)
- `scripts/eternal-skald.js` (801-line orchestrator entry point)
- `scripts/core/` — `constants.js`, `model-catalogue.js`, `settings.js`
- `scripts/ai/` — `client.js`, `prompt-builder.js`, `providers.js`
- `scripts/chat/` — `commands.js`, `display.js`
- `scripts/chronicle/` — `entity-linking.js`, `journal-system.js`
- `scripts/vision/` — `map-vision.js`
- `scripts/narrative/` — `generators.js`, `integration.js`
- `scripts/hooks/` — `foundry-hooks.js`
- Plus: `browser-rag.js`, `ironsworn-controller.js`, `ironsworn-data.js`, `eternal-skald-server.mjs`

### `test/` (24 files)
All test files including `run-all.mjs`, `check-imports.mjs`, `load-smoke.mjs` and the 20 behavioral test suites.

### Assets
- `lang/`, `styles/`

## Foundry VTT Spec Compliance ✅

| Field | Value | Valid |
|-------|-------|-------|
| `id` | `the-eternal-skald` | ✅ |
| `title` | The Eternal Skald | ✅ |
| `version` | `0.10.38` | ✅ |
| `compatibility` | min 13, verified 14, max 14 | ✅ |
| `manifest` | raw module.json URL | ✅ |
| `download` | branch archive zip | ✅ |
| `esmodules` | `["scripts/eternal-skald.js"]` | ✅ |
| `authors` | present | ✅ |

## Quick Start — Install in Foundry VTT

1. Launch Foundry → **Add-on Modules** tab → **Install Module**.
2. Paste this into the **Manifest URL** field at the bottom:
   ```
   https://raw.githubusercontent.com/papicy/the_eternal_skald/main/module.json
   ```
3. Click **Install**. Foundry fetches the manifest and downloads the module.
4. Open your world → **Manage Modules** → enable **The Eternal Skald**.

> Note: `id` uses hyphens (`the-eternal-skald`) while the repo uses underscores (`the_eternal_skald`). This is intentional and correct — the Foundry module id is independent of the repository name.
