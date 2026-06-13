# Settings live-reload audit (M5)

**Scope:** the settings consumed by the adapter-migration touchpoints (H1) —
`scripts/chat/commands.js`, `scripts/narrative/integration.js` and
`scripts/ai/prompt-builder.js` — plus the bootstrap reads in
`scripts/hooks/foundry-hooks.js` / `scripts/eternal-skald.js` that gate those
same flows.

**Question:** when a GM changes one of these settings mid-session, does the new
value take effect immediately, or does Foundry need a reload?

---

## TL;DR

**Every setting touched by the H1 consumers is read *live* (call-time) and takes
effect on the next command / interaction — no reload required.** There are no
`requiresReload: true` flags anywhere in `settings.js`, and no H1 consumer caches
a setting value in a module-level variable at init.

No code change was needed for the H1 touchpoints: they were already fully live.
This document records the audit so the property is intentional and checkable.

---

## Why these settings are live

`Settings.get(key)` is a thin pass-through to Foundry's own live store:

```js
// scripts/core/settings.js
get(key) {
  try { return game.settings.get(MODULE_ID, key); }
  catch (e) { return undefined; }
}
```

`game.settings.get()` always returns the *current* persisted value. The H1
consumers call `Settings.get(...)` **inline, at the moment a command runs**, e.g.:

| Consumer | Setting(s) read | Where |
| --- | --- | --- |
| `commands.js` (`!progress`) | `ironswornIntegration` (via `Integration.active()`) | per command |
| `commands.js` (narration) | `interceptMoveDeclarations` | per message |
| `integration.js` (`active()`) | `ironswornIntegration` | per call |
| `integration.js` | `suggestMoves`, `autoNarrateMoves`, `intelligentMoveDetection`, `intelligentMoveConfirm`, `assetBonusAdvisory`, `autoNarrateXp`, `weakHitHalfXp`, `narrationDelay`, `autoCreate/CloseCombatTracks`, `defaultEnemyRank`, `aiJourneyNaming`, … | per call |
| `prompt-builder.js` | `intensity`, `contextFoes`, `contextSuggestions`, `aiAppliesEffects`, `aiModifiesSheet`, `aiCreatesContent` | per prompt build |
| `eternal-skald.js` | `streamingEnabled`, `aiMode` | per message |
| `foundry-hooks.js` | `aiMode` | per hook fire (closures, not cached) |

Because none of these are read once and stored, the *next* command/message after
a settings change already sees the new value. **Live, no reload.**

## Settings that also self-apply an immediate side-effect

A handful of settings must do more than be re-read next time — they have an
observable side-effect that should fire the instant the value changes. Those
already register an `onChange` handler, so they are live in the strongest sense:

| Setting | `onChange` effect |
| --- | --- |
| `aiMode` | re-renders the chat AI toggle / mode indicator |
| `providerPreset` | re-points the API endpoint (`applyProviderPreset`) |
| `debugLogging` | `IronswornController.setDebug(...)` toggles verbose logging |
| `entityLinking` | rebuilds the entity-link index |
| `customLinkStyles` / `linkStyles` | re-applies narration link colours/icons |

## Settings that genuinely require a reload

**None among the H1 touchpoints.** No setting in `settings.js` declares
`requiresReload: true`, and none of the migrated consumers depend on init-time-only
wiring (hook registration, etc.) driven by a setting value. If a future setting
ever gates hook registration at `init`/`ready` only, it must either (a) be tagged
"(requires reload)" in its description, or (b) gain an `onChange` that re-wires the
behaviour live.

---

## Verdict

- **Reload-required H1 settings:** none.
- **Live-on-next-read H1 settings:** all of them (table above).
- **Live-with-immediate-side-effect:** `aiMode`, `providerPreset`, `debugLogging`,
  `entityLinking`, `customLinkStyles`, `linkStyles` (via `onChange`).
- **Action taken:** documentation only — the H1 touchpoints were already live, so
  implementing live-reload "where safe" required no code change.
