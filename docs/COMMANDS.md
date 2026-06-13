# The Eternal Skald — Command Reference

> Every command is typed into the **Foundry chat box**. The Skald listens for
> messages beginning with `!`. Type `!skald-help` in game for the quick card, or
> open the **interactive, searchable reference** with `!commands` (see
> [U5/Doc1](#in-game-interactive-reference) below).
>
> **Shorthand:** any message that starts with `!` *without* a recognised command
> token is treated as `!skald <your words>` — i.e. `!What do I see?` is the same
> as `!skald What do I see?`.

## Legend

- **Permission** — `all` = any player may use it; `gm` = dispatch-gated to the
  GM (the Skald refuses it for non-GMs). Some `all` commands still self-gate
  individual *actions* internally (e.g. world writes).
- `<required>` argument · `[optional]` argument · `a | b` choices.

---

## AI narration & storytelling

| Command | Syntax | Perm | Description |
| --- | --- | --- | --- |
| `!skald` | `!skald <words>` | all | Speak with the Skald — freeform narration, questions, GM help. The default for any `!`-prefixed message. |
| `!oracle` | `!oracle [question]` | all | Roll an Ironsworn oracle and have the Skald interpret the result in fiction. |
| `!npc` | `!npc [name\|description]` | all | Conjure a new NPC (name, demeanour, hook) or recall a known one. |
| `!roleplay` | `!roleplay <name> \| off` | all | Enter in-character mode: the Skald speaks first-person *as* that NPC until you `!roleplay off`. |
| `!scene` | `!scene [prompt]` | all | Generate a vivid scene / location description for the current moment. |
| `!lore` | `!lore [topic]` | all | Generate world-building lore (history, factions, myths). |
| `!combat` | `!combat [prompt]` | all | Tactical narration and advice for the current fight. |

**Examples**

```
!skald The door creaks open — what waits beyond?
!oracle Is the bridge guarded?
!npc a wary ferrywoman who knows the marsh roads
!roleplay Br15
!roleplay off
!scene the ruined watchtower at dusk
```

---

## Journeys, progress & XP

| Command | Syntax | Perm | Description |
| --- | --- | --- | --- |
| `!progress` | `!progress [track] [+n]` | all | Review or advance a journey / objective progress track. |

**Examples**

```
!progress                  (list active tracks)
!progress Reach the Spire  (show one track)
!progress Reach the Spire +1
```

---

## Campaign journal & chronicle

| Command | Syntax | Perm | Description |
| --- | --- | --- | --- |
| `!journal` / `!journals` | `!journal [name]` | all | List the campaign journals, or open a specific one. |
| `!mysteries` | `!mysteries` | all | List unresolved mysteries and open threads. |
| `!remind` | `!remind [topic]` | all | Recall what has happened so far (memory recap). |
| `!end-session` | `!end-session` | all | Wrap up and summarise the current session into the chronicle. |
| `!session-recap` | `!session-recap [n]` | all | Generate a recap of the last `n` chronicle entries (default 8) and **download it as Markdown** (Obsidian-flavoured if enabled). Read-only. |
| `!timeline` | `!timeline` | all | Show / edit the campaign timeline of events. |
| `!relationships` / `!map` | `!relationships` | all | Show the entity relationship map. |
| `!template` | `!template [name]` | all | Manage journal templates. |
| `!journal-rewrite` | `!journal-rewrite <name>` | all | Rewrite an existing journal entry with the AI. |
| `!journal-amend` | `!journal-amend <name>` | all | Amend / append to an existing journal entry. |

**Examples**

```
!journals
!journal The Marsh Road
!remind the cult of the drowned god
!session-recap 12
!journal-amend The Marsh Road
```

---

## AI memory (RAG)

| Command | Syntax | Perm | Description |
| --- | --- | --- | --- |
| `!reindex` | `!reindex` | all | Rebuild the AI memory (RAG) index from the campaign journals. |
| `!reindex-compendiums` | `!reindex-compendiums` | **gm** | Embed installed compendium packs into AI memory. GM only. |
| `!rag-status` | `!rag-status` | all | Show AI memory (RAG) status — indexed entry count, model, settings. |

---

## Map vision / scouting

| Command | Syntax | Perm | Description |
| --- | --- | --- | --- |
| `!scout` / `!survey` / `!analyze-map` | `!scout [prompt]` | all | Analyse the current map / scene with the vision model. |

---

## Configuration & maintenance

| Command | Syntax | Perm | Description |
| --- | --- | --- | --- |
| `!skald-help` | `!skald-help` | all | Show the quick command help card in chat. |
| `!commands` | `!commands` | all | Open the **interactive, searchable command reference** window. |
| `!link-style` | `!link-style [...]` | all | Configure entity-link styling. |
| `!skald-reset` / `!skald-wipe` | `!skald-reset` | all | Reset / wipe Skald data. Prompts for confirmation; self-gates destructive actions. |

---

## In-game interactive reference

`!commands` opens a searchable, filterable window (an `ApplicationV2` panel)
listing every command above with its syntax, permission and description. Type to
filter; click **Try it** on any row to pre-fill the chat input with that
command's syntax so you can fill in the arguments and send. The window is built
from the same single source of truth as this document
(`scripts/chat/command-registry.js`), so it can never drift out of date.

---

## Notes

- **Permissions.** `gm`-marked commands are refused for non-GM players at
  dispatch. Commands that *write to the world* (journals, sheet effects) may also
  require the relevant Foundry permission or a module setting to be enabled.
- **AI Mode.** If **AI Mode** is off (module settings, or the `Alt+Shift+A`
  keybinding), `!`-messages pass through as ordinary chat and the Skald stays
  silent. Turn it on to wake the Skald.
- **Single source of truth.** This list is generated from the command registry
  in `scripts/chat/command-registry.js`. If you add a command there, update this
  file and the in-game reference picks it up automatically.
