# The Eternal Skald

An AI-powered storyteller, oracle interpreter, and tactical enemy controller for **Ironsworn** and **Ironsworn: Delve** campaigns in Foundry Virtual Tabletop v14. The Eternal Skald is a wise, dramatic norse narrator who serves as the GM at your table — interpreting oracle rolls, voicing NPCs, generating lore, narrating combat, and even taking control of enemy combatants on their turn.

Powered by the **Abacus AI ChatLLM** platform (Gemini 3.0 Flash by default).

---

## Installation

This module is currently distributed as a local-install package (no public manifest URL). Install it by copying the folder directly into your Foundry data directory:

1. Locate your Foundry VTT data directory:
   - **Windows:** `%appdata%\FoundryVTT\Data\modules\`
   - **macOS:** `~/Library/Application Support/FoundryVTT/Data/modules/`
   - **Linux:** `~/.local/share/FoundryVTT/Data/modules/`
2. Copy the entire `the-eternal-skald/` folder into the `modules/` directory.
3. Restart Foundry VTT.
4. In your world, open **Game Settings → Manage Modules** and enable **The Eternal Skald**.
5. Open **Configure Settings → The Eternal Skald** and enter your **Abacus AI API Key**.
6. In chat, type `/skald-help` to see the available commands.

> **Note on "DOCTYPE error on import":** This module ships without a public `manifest`/`download` URL because it's a private/local build. If you try to install it via Foundry's "Install Module → Manifest URL" dialog using a placeholder URL, Foundry receives an HTML 404 page and reports a "DOCTYPE error" while trying to parse it as JSON. Use the local-install method above instead.

---

## Commands

| Command | Description |
|---|---|
| `/skald-help` | Show the command list. |
| `/skald <prompt>` | Talk to The Eternal Skald freely — rules questions, narration, ideas. |
| `/oracle <name>` | Roll an Ironsworn oracle and have the Skald interpret. e.g. `/oracle action`, `/oracle theme`, `/oracle npc`, `/oracle price`. |
| `/npc <name or descriptor>` | Conjure (or continue) an NPC. The Skald rolls an oracle persona on first contact, then stays in character on subsequent calls. |
| `/scene <subject>` | Generate a vivid scene description, factoring in your current canvas scene. |
| `/lore <topic>` | Write world-building lore. A JournalEntry is created in the **Skald's Chronicles** folder. |
| `/combat <note?>` | Get tactical narration and a concrete Ironsworn-move suggestion for the current fight. |

### Available oracles
`action`, `theme`, `region`, `location`, `coastal`, `npc` (role), `npc-goal`, `npc-descriptor`, `combat`, `mystic`, `price`.

---

## Settings

All settings live under **Configure Settings → The Eternal Skald** (world-scoped, GM-only):

- **Abacus AI API Key** — Required. Get this from your Abacus AI account.
- **AI Model** — Defaults to `gemini-3.0-flash`. Any model exposed by your Abacus AI deployment works.
- **API Endpoint** — Defaults to `https://api.abacus.ai/v1/chat/completions`. Override if you proxy through a custom backend.
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

## License

Module code: MIT.  
Ironsworn rules content paraphrased under the **Ironsworn SRD (CC-BY 4.0, Shawn Tomkin)**. Buy the official Ironsworn books to support the creator.
