# Changelog

All notable changes to **The Eternal Skald** are documented here.

This project adheres to [Semantic Versioning](https://semver.org/). It is currently in
the `0.x` **pre-release (alpha)** stage — see
[Versioning & Release Strategy](README.md#versioning--release-strategy) in the README.
Until `1.0.0`, treat every release as an experimental development build.

> **Note on version numbering:** Some early builds were mistakenly published under `2.x`
> (`v2.0.0`, `v2.0.1`, `v2.2.0`, `v2.2.1`). Those numbers were never appropriate for a
> pre-release project and have been retired. The history below reflects the corrected
> `0.x` lineage; the retired tags map to the equivalent `0.x` entries.

## [0.3.0] — 2026-06-03

### Added
- **Automatic combat system.** The Skald now runs Ironsworn fights end-to-end.
  When a fight begins it creates a **combat progress track per foe**; landing a
  blow marks that track **by the foe's rank** (troublesome +12 … epic +1 ticks);
  and the single **initiative** state ("in control" vs "in a bad spot") is
  tracked automatically.
- **Deterministic resolution of core combat moves.** *Enter the Fray*, *Strike*,
  and *Clash* are resolved by the client itself: Enter the Fray hit → gain
  initiative (miss → bad spot); Strike/Clash hit → mark the active foe's track,
  strong hit keeps initiative / weak hit loses it; miss → lose initiative. The AI
  is told these are already applied so it never double-marks.
- **New effect directives:** `[[EFFECT: create_combat <Foe> <rank>]]`,
  `[[EFFECT: create_vow <Name> <rank> <description>]]`,
  `[[EFFECT: initiative <gain|lose>]]`, and `[[EFFECT: end_combat <Foe>]]`.
- **`IronswornController` combat/track API:** `createProgressTrack` (combat /
  vow / journey / bond, positional or options style), `getProgressTrack`,
  `completeTrack`, `getCombatTracks`, `getActiveCombatTrack`, `hasInitiative`,
  `setInitiative`, `normalizeRank`, and `describeCombatState`.
- **Live combat context** (initiative holder, active foes + progress, recently
  ended fights) injected into the AI prompt every turn.
- **UI notifications** for combat-track creation, progress marks, and initiative
  changes.
- **New settings:** *Auto-Create Combat Tracks* (default on) and *Default Enemy
  Rank* (default Dangerous), with localization.

### Changed
- **"AI Applies Mechanical Effects" now defaults to ON**, enabling the combat
  automation out of the box. Turn it off to keep the player in full control of
  the sheet.
- System prompt now documents the combat-track syntax, rank guidance, initiative
  mechanics, and that core combat moves are auto-resolved.

## [0.2.3] — 2026-06-03

### Added
- **Configurable "Narration Delay (ms)" setting.** The wait between a roll
  resolving and the Skald narrating its outcome is now a world setting in the
  module configuration UI (default `2000ms`, range `0–5000`), instead of a
  hardcoded value. Recommended ~2000ms with Dice So Nice, ~500ms without, so
  narration lines up with the dice animation. Includes localization strings.

## [0.2.2] — 2026-06-03

### Added
- **Deep integration with the `foundry-ironsworn` rules engine.** The Skald reads your
  character's stats and meters, *suggests* the right Ironsworn move, triggers the
  system's own dice mechanics on one click, narrates the official strong-hit /
  weak-hit / miss outcome, and can optionally apply mechanical effects (momentum, harm,
  stress, supply, progress, oracles).
- **Auto-narration of Ironsworn move rolls.** After a move roll resolves, the Skald
  automatically narrates the outcome.
- `updateChatMessage` hook so rerolls, momentum burns, and resolved challenges
  re-narrate the same roll card.
- Comprehensive, opt-in debug logging at every roll-detection / parse step.

### Fixed
- **Roll detection / auto-narration that never fired.** Modern `foundry-ironsworn`
  chat messages carry no module flags, so the old flag-based detection always failed.
  Detection now parses the rendered roll-card HTML (the `data-ironswornroll` attribute /
  `ironsworn-roll` class), with the legacy flags and `message.rolls` dice as fallbacks,
  and computes the outcome (Strong Hit / Weak Hit / Miss + match) from the action die,
  stat/adds, and challenge dice — honoring replaced challenge/outcome and automatic
  outcomes.
- Narration now waits for the dice animation (~1.5s, or 2.8s with Dice So Nice) before
  posting, and respects the **Auto-Narrate Moves** setting and GM-only gating.

> Retired tag: previously published as `v2.2.0` / `v2.2.1`.

## [0.2.0] — Server-side architecture rewrite

### Changed
- Complete architectural rebuild moving all upstream LLM calls to a **stateless
  server-side hook** loaded via Node's `--import` flag (`scripts/eternal-skald-server.mjs`),
  intercepting `/skald-api/*` requests before Foundry's Express server.
- Eliminated the standalone proxy and all of its networking/CORS complexity; the module
  now has a single networking path.
- Removed the old **Proxy URL** setting.

### Notes
- A follow-up patch in this line corrected the default API endpoint and model name.

> Retired tags: previously published as `v2.0.0` (rewrite) and `v2.0.1` (endpoint/model fix).

## [0.1.x] — Initial proxy attempts

### Added
- First working versions of the module: AI storyteller, oracle interpretation, NPC
  voicing, lore generation, combat narration, and enemy control.
- Networking handled by a separate **proxy** process (`skald-proxy.js` /
  `proxy/skald-hook.mjs`) to reach the upstream LLM and work around browser CORS limits.

### Notes
- The proxy approach proved fragile to deploy (reverse proxies, systemd/PM2 units,
  relative-URL handling), which motivated the `0.2.0` server-side rewrite.

[0.3.0]: https://github.com/papicy/eternal_skald/releases/tag/v0.3.0
[0.2.3]: https://github.com/papicy/eternal_skald/releases/tag/v0.2.3
[0.2.2]: https://github.com/papicy/eternal_skald/releases/tag/v0.2.2
