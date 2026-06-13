<div align="center">

# ⚔️ The Eternal Skald

**AI Storyteller, Oracle & Tactical Controller for Foundry VTT**

[![Foundry VTT](https://img.shields.io/badge/Foundry_VTT-v14-crimson?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyTDIgN2wxMCA1IDEwLTV6TTIgMTdsOSA1IDktNVY3bC05IDV6Ii8+PC9zdmc+&labelColor=1a1a1a)](https://foundryvtt.com)
[![Version](https://img.shields.io/badge/version-0.23.0_alpha-gold?style=for-the-badge&labelColor=1a1a1a)](https://github.com/papicy/the_eternal_skald/releases)
[![System](https://img.shields.io/badge/System-Ironsworn-4a7fa5?style=for-the-badge&labelColor=1a1a1a)](https://foundryvtt.com/packages/foundry-ironsworn)
[![System](https://img.shields.io/badge/System-Nimble2-4a7fa5?style=for-the-badge&labelColor=1a1a1a)](https://foundryvtt.com/packages/foundry-ironsworn)
[![System](https://img.shields.io/badge/System-DnD5e-4a7fa5?style=for-the-badge&labelColor=1a1a1a)](https://foundryvtt.com/packages/foundry-ironsworn)
[![System](https://img.shields.io/badge/System-PF2-4a7fa5?style=for-the-badge&labelColor=1a1a1a)](https://foundryvtt.com/packages/foundry-ironsworn)
[![OpenAI](https://img.shields.io/badge/OpenAI-GPT-412991?style=for-the-badge&logo=openai&logoColor=white&labelColor=1a1a1a)](https://platform.openai.com)
[![Google Gemini](https://img.shields.io/badge/Google-Gemini-4285F4?style=for-the-badge&logo=google&logoColor=white&labelColor=1a1a1a)](https://aistudio.google.com)
[![OpenRouter](https://img.shields.io/badge/OpenRouter-Multi--Model-6366f1?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiIGZpbGw9IndoaXRlIi8+PC9zdmc+&logoColor=white&labelColor=1a1a1a)](https://openrouter.ai)
[![Abacus AI](https://img.shields.io/badge/Abacus.AI-Multi--Model-7b2cbf?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAyTDIgN2wxMCA1IDEwLTV6TTIgMTdsOSA1IDktNVY3bC05IDV6Ii8+PC9zdmc+&logoColor=white&labelColor=1a1a1a)](https://abacus.ai)
[![Ollama](https://img.shields.io/badge/Ollama-Local_LLM-333333?style=for-the-badge&logo=ollama&logoColor=white&labelColor=1a1a1a)](https://ollama.com)
[![License](https://img.shields.io/badge/License-CC_BY--SA_4.0-3a7a5a?style=for-the-badge&labelColor=1a1a1a)](http://creativecommons.org/licenses/by-sa/4.0/)
[![Buy me a coffee](https://img.shields.io/badge/Buy_me_a_coffee-Support_%E2%98%95-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=000&labelColor=1a1a1a)](https://buymeacoffee.com/YOUR_NAME)
[![Patreon](https://img.shields.io/badge/Patreon-Become_a_patron-FF424D?style=for-the-badge&logo=patreon&logoColor=fff&labelColor=1a1a1a)](https://patreon.com/YOUR_NAME)

---

*"A wise, dramatic Norse narrator who serves as the GM at your table — interpreting oracle rolls, voicing NPCs, and taking control of enemy combatants."*

[Setup](#setup) • [Ironsworn Integration](#ironsworn-integration) • [Combat](#combat-system) • [Living Chronicle](#the-living-chronicle) • [Map Vision](#map-vision) • [AI Memory](#ai-memory-rag) • [Commands](#commands) • [Public API](#public-api)

</div>

---

> [!WARNING]
> **Alpha / Development Version (v0.23.0)** — Experimental pre-release software under active development. Expect rough edges and breaking changes between versions. **Please back up your world before use.**

---

<a id="core-capabilities"></a>
### 🛡️ Core Capabilities

| Feature | Description |
| :--- | :--- |
| **Ironsworn Rules Engine** | Reads character stats/meters, suggests the right move, triggers dice mechanics, and narrates outcomes. |
| **Living Chronicle** | Auto-scribes NPCs, locations, and events into Foundry Journal entries. |
| **AI Memory (RAG)** | Browser-based semantic memory. The Skald remembers your saga across sessions. |
| **Map Vision** | True image analysis — the Skald "sees" your scene background and describes terrain and POIs. |
| **Combat Brain** | Manages foe tracks, initiative, and tactical narration automatically. |
| **Story-Arc Awareness** | Remembers the focus vow and active fight via actor flags; advances or concludes tracks from the fiction. |

---

<a id="setup"></a>
### 🚀 Setup

**1. Install the Module**

Paste this manifest URL into Foundry's *Install Module* dialog:

```text
https://raw.githubusercontent.com/papicy/the_eternal_skald/main/module.json
```

**2. Configure your API Key**

Navigate to `Configure Settings → The Eternal Skald` and enter your **Abacus AI API Key**.

**3. (Optional) Server-Side Connection**

If self-hosting, add the following to your Foundry startup flags:

```text
--import ./Data/modules/the-eternal-skald/scripts/eternal-skald-server.mjs
```

> [!NOTE]
> If you were previously running `skald-proxy.js` or had systemd/PM2 units for it, remove them. The old *Proxy URL* setting no longer exists.

---

<a id="ironsworn-integration"></a>
### 🏔️ Ironsworn Integration

As of **v0.3.0**, the Skald integrates directly with [foundry-ironsworn](https://foundryvtt.com/packages/foundry-ironsworn). It reads your character's stats and meters, suggests the right move, triggers the system's own dice mechanics on one click, and narrates the official strong-hit / weak-hit / miss outcome.

The module still works **standalone in any system** — Ironsworn features simply activate when the system is present.

---

<a id="combat-system"></a>
### ⚔️ Combat System

The Skald manages enemy combatants on their turn with full tactical narration.

- **Foe tracks** render with proper rank/progress labels (fixed in v0.10.27).
- An idempotent legacy-repair pass migrates any old `"foe"`-subtype tracks already on your sheet.
- **Strong Hit** on *End the Fight* auto-completes the matching track. A weak hit or miss never does.
- Write directives available from the fiction: `[[MARK_COMPLETE:…]]`, `[[ADD_PROGRESS:…]]`, `[[SET_PROGRESS:…]]`

---

<a id="the-living-chronicle"></a>
### 📖 The Living Chronicle

The Skald automatically scribes your saga into Foundry Journal entries.

- **NPCs** — personality, goal, and relationship to the player.
- **Locations** — terrain, atmosphere, and notable features.
- **Discoveries** — lore, secrets, and oracle interpretations.
- **Session Recaps** — end-of-session saga-styled summaries via `!end-session`.

---

<a id="map-vision"></a>
### 🗺️ Map Vision (Image Analysis)

The Skald can look at your background map using vision-capable models and describe terrain, points of interest, and atmosphere.

| Model | Vision | Strength | Cost |
| :--- | :---: | :--- | :--- |
| **Gemini 3 Flash** | ✅ | ★★★ Strong | 💲 Low |
| **GPT-4o** | ✅ | ★★★ Strong | 💲💲 Medium |
| **Claude 3.5 Sonnet** | ✅ | ★★★ Strong | 💲💲 Medium |
| **GPT-4o-Mini** | ✅ | ★☆☆ Weak | 💲 Low |

**Map Quality Modes**

| Mode | Method | Best For |
| :--- | :--- | :--- |
| `Fast` | Single-pass, full image | Quick overviews, simple maps |
| `Balanced` | Moderate crop + resize | Most use cases *(default)* |
| `Detailed` | High-res grid tiles | Complex, dense battle maps |

---

<a id="ai-memory-rag"></a>
### 🧠 AI Memory (RAG)

Browser-based semantic memory powered by vector embeddings — no server required.

- Automatically indexes Chronicle journal entries.
- Retrieves relevant context before each Skald response.
- Use `!remind <topic>` to manually query memory.
- Memory persists across sessions in `localStorage`.

---

<a id="commands"></a>
### 💬 Commands

Use the `!` prefix in the Foundry chat (**AI Mode must be ON**).

| Command | Action |
| :--- | :--- |
| `!skald <prompt>` | Talk to the Skald freely for narration or rules help. |
| `!oracle <name>` | Roll and interpret an Ironsworn oracle (e.g. `!oracle action`). |
| `!npc <name>` | Conjure a new NPC with a personality and goal. |
| `!scout` | Force a vision analysis of the current scene map. |
| `!remind <topic>` | Query semantic memory for relevant chronicle entries. |
| `!end-session` | Generate a saga-styled recap of the day's events. |
| `!help` | List all available commands. |

---

<a id="settings"></a>
### ⚙️ Settings

| Setting | Default | Effect |
| :--- | :---: | :--- |
| **API Key** | *(required)* | Your Abacus AI API key. |
| **AI Model** | `Gemini 3 Flash` | The LLM used for narration and oracle interpretation. |
| **Skald Intensity** | `6` | 1 (Terse) → 10 (Full Operatic Saga). |
| **Auto-Journaling** | `On` | Automatically create NPC / Location / Discovery journals. |
| **Semantic Memory** | `On` | Enable RAG context retrieval for long-term consistency. |
| **Map Vision** | `On` | Allow the Skald to analyze scene background images. |
| **Map Quality** | `Balanced` | Single-pass vs. high-res grid tile analysis. |

---

<a id="multi-system-support"></a>
### 🔌 Multi-System Support

The Skald is built for Ironsworn but degrades gracefully in other systems.

| System | Support Level | Notes |
| :--- | :--- | :--- |
| **foundry-ironsworn** | ✅ Full | Stats, moves, dice, oracle, progress tracks. |
| **Starforged** | ✅ Full | Same integration as Ironsworn. |
| **Any other system** | ⚠️ Partial | Narration, oracle, chronicle, and vision work. Move triggers disabled. |

---

<a id="public-api"></a>
### 🛠️ Public API

The module exposes a global API for macros and other modules:

```javascript
const skald = game.modules.get('the-eternal-skald').api;

// Trigger an Ironsworn move programmatically
await skald.ironsworn.triggerMove('Face Danger', { stat: 'iron' });

// Create a combat progress track
await skald.ironsworn.createProgressTrack(actor, 'Frost Wolf', 'combat', 'dangerous');

// Query semantic memory
const memories = await skald.memory.query('the iron keep');

// Force a map vision analysis
await skald.vision.analyzeCurrentScene();
```

---

<a id="architecture"></a>
### 🏗️ Architecture

The module was refactored in **v0.10.x** from a single ~11,000-line monolith into focused ES modules with **zero behavioral change**.

```
scripts/
├── eternal-skald.js      ← Entry point (801 lines)
├── core/                 ← Settings, constants, state
├── ai/                   ← AI client, prompt assembly, model calls
├── chat/                 ← Chat handling, command parsing
├── chronicle/            ← Journal persistence and rendering
├── vision/               ← Image / vision features
├── narrative/            ← Story logic and generation
└── hooks/                ← Foundry hook registration
```

> **Quality gates:** 20/20 test files pass · 971 assertions green.

---

<a id="changelog-highlights"></a>
### 📋 Changelog Highlights

| Version | Highlights |
| :--- | :--- |
| **v0.10.27** | Foe track rank labels fixed; story-arc awareness; write directives from fiction; 55-assertion test suite. |
| **v0.10.26** | Track fullness labels; Skald will not offer to close a track until 10/10 boxes filled. |
| **v0.10.25** | Observe-only asset & XP tracking (no sheet mutations). |
| **v0.10.22** | Map Vision — the Skald can now see your scene background. |
| **v0.3.0** | Full foundry-ironsworn integration (stats, moves, dice, oracles). |

---

<a id="versioning"></a>
### 📦 Versioning

```
0 . MINOR . PATCH
│     │       └─ Bug fixes, small tweaks, polish
│     └───────── Major new features or significant changes
└─────────────── 1.0.0 = first production-ready release
```

**Maintainers — bumping the version:**

```bash
npm run version:bump 0.16.0             # update manifests + create commit
npm run version:bump 0.16.0 --no-commit # update files only
```

---

<a id="license-attribution"></a>
### ⚖️ License & Attribution

#### The Eternal Skald (Module Code & Original Content)

This project is licensed under **Creative Commons Attribution–ShareAlike 4.0 International (CC BY‑SA 4.0)**.

- **License text:** [CC BY-SA 4.0](http://creativecommons.org/licenses/by-sa/4.0/)
- **You may:** share, adapt, remix, and build upon this work (including commercially).
- **You must:**
  - **Attribute** the original author(s).
  - **ShareAlike** — distribute contributions under the same license.

> [!NOTE]
> If you reuse or modify this repository, include attribution in your fork/readme/release notes and keep the license notice intact.

#### Ironsworn / Starforged Attribution

**The Eternal Skald** is an unofficial, fan-made Foundry VTT module based on works by **Shawn Tomkin** — including *Ironsworn*, *Ironsworn: Delve*, *Ironsworn: Starforged*, and *Sundered Isles* — which are licensed under **CC BY‑NC‑SA 4.0**.

- **Tomkin Press licensing:** [tomkinpress.com/pages/licensing](https://tomkinpress.com/pages/licensing)
- Please support the creator by buying the official books at [tomkinpress.com](https://tomkinpress.com/).

#### Foundry System Attribution

This module also builds on the **Ironsworn & Starforged system for Foundry VTT** by Ben and contributors:

- [github.com/ben/foundry-ironsworn](https://github.com/ben/foundry-ironsworn)

#### Disclaimer

> This is an independent, unofficial project and is **not affiliated with, endorsed by, or sponsored by** Shawn Tomkin, Tomkin Press, or Foundry Gaming LLC. All trademarks are the property of their respective owners.


---

<div align="center">

*Forged in the Ironlands. <br> Powered by [Abacus AI](https://abacus.ai) & Fried Chicken*

⚔️

</div>
