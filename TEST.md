# Testing — The Eternal Skald

This module ships a **framework-free regression suite** under `test/`. The tests
run in plain Node.js (v18+) with **no dependencies and no build step**, matching
the module's buildless raw-ESM architecture.

## Running the tests

Run the whole suite:

```bash
npm test
```

or equivalently:

```bash
node test/run-all.mjs
```

Run a single test file:

```bash
node test/track-integration.test.mjs
# or via the npm helper:
npm run test:file test/track-integration.test.mjs
```

## What `npm test` does

`test/run-all.mjs` discovers every `test/*.test.mjs` file, runs each one in its
own child Node process, prints a per-file `passed / failed` summary, and exits
**non-zero if any file fails** (CI-friendly).

Each test file is self-contained: it maintains its own pass/fail counters,
prints `"<n> passed, <m> failed"`, and calls `process.exit(m ? 1 : 0)`.

## How the tests work

The tests do **not** require a running Foundry VTT instance. Instead they:

- **Dynamically import** a source module (e.g. `await import("../scripts/ironsworn-controller.js")`)
  against hand-mocked Foundry globals (`game`, `CONFIG`, `ui`, `fromUuid`, …)
  defined at the top of each test, **and/or**
- **Read the source text** of `scripts/eternal-skald.js` / `lang/en.json` and
  assert on structural invariants (e.g. that a setting is registered with the
  right type/default, that the public API exposes a given member).

Because some assertions check source text, **renaming a setting key, command
string, public-API member, or hook will break the relevant test** — this is
intentional: the suite doubles as a guard for the frozen public contract during
the file-decomposition refactor.

## Current baseline

- **20 test files**, **951 assertions**, all passing.

| Area | Test file |
|------|-----------|
| Action classification / routing | `action-mapping.test.mjs` |
| Asset bonus advisory | `asset-bonus-advisory.test.mjs` |
| Asset XP tracking | `asset-xp-tracking.test.mjs` |
| Compendium content creation | `compendium-creation.test.mjs` |
| Direct (browser→LLM) fallback | `direct-llm-fallback.test.mjs` |
| Foe compendium lookup | `foe-compendium.test.mjs` |
| Full sheet awareness | `full-sheet-awareness.test.mjs` |
| Inline move suggestions | `inline-move-suggestions.test.mjs` |
| Journey + combat completion | `journey-combat-completion.test.mjs` |
| Journey tracking | `journey-tracking.test.mjs` |
| Map vision / scouting | `map-vision.test.mjs` |
| Reach-a-milestone move | `milestone.test.mjs` |
| Move declaration detection | `move-declaration.test.mjs` |
| Progress-track context | `progress-track-context.test.mjs` |
| Progress-track writes | `progress-track-writes.test.mjs` |
| Scene context | `scene-context.test.mjs` |
| Track integration (system schema) | `track-integration.test.mjs` |
| Vow completion | `vow-completion.test.mjs` |
| Vow display sync | `vow-display-sync.test.mjs` |
| XP granting | `xp-grant.test.mjs` |

## Refactor workflow expectation

During the staged file-decomposition refactor, **run `npm test` after every
step**. A step is only complete when the suite remains **20/20 files green**.
The suite is the primary safety net; a manual smoke test in a Foundry v14 +
`foundry-ironsworn` world is the secondary check for behavior that the
framework-free tests cannot cover (live narration, document writes, DOM).
