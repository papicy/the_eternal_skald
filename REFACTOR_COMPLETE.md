# Phase 2 Refactor — File Decomposition Complete

**Branch:** `refactor/phase2-file-decomposition`
**Goal:** Decompose the ~11k-line `scripts/eternal-skald.js` monolith into focused ES-modules under
`scripts/{core,ai,chat,chronicle,vision,narrative,hooks}/` — **buildless raw ESM, zero behavioral change.**
All code was moved **verbatim**; only `export`/`import` wiring was added.

**Module entry point is unchanged:** `module.json` still loads `scripts/eternal-skald.js` as the single
`esmodules` entry. That file now eagerly imports every submodule (and finally
`./hooks/foundry-hooks.js`, whose import is what registers all Foundry hooks as a side-effect).

---

## Result at a glance

| Metric | Before | After |
| --- | ---: | ---: |
| `scripts/eternal-skald.js` line count | ~11,048 | **801** |
| Number of module files under `scripts/` | 4 | 18 |
| Test files passing | 20 / 20 | **20 / 20** |
| Assertions passing | 971 | **971** |

No test was modified to make it pass; the 5 source-text guard tests now read a **shared source corpus**
(`test/_skald-source.mjs` → `readSkaldSource()`) that recursively concatenates every `.js` under the
`scripts/` subdirectories, so they remain valid no matter where code lives.

---

## Final file structure & line counts

```
scripts/
├── eternal-skald.js            801   (orchestrator: RagBridge, ContradictionDetector, RagProgress,
│                                      runConversation, CombatController, SceneContext + imports +
│                                      side-effect import of hooks)
├── core/
│   ├── constants.js            363
│   ├── model-catalogue.js      272
│   └── settings.js             811
├── ai/
│   ├── client.js               622   (Client, API_PATH, STREAM_PATH)
│   ├── providers.js            120   (refreshModelDropdowns, populateSelect, migrateLegacyAbacusEndpoint)
│   └── prompt-builder.js       686   (buildSystemPrompt, buildContextSuggestionBlock,
│                                      buildJournalPromptBlock, buildFoeGuidance, buildIronswornPromptBlock)
├── chat/
│   ├── display.js              332   (Memory, Chat, escapeHtml, formatMarkdown,
│   │                                  stripDirectivesForDisplay, parseMetadata, callSkaldStreaming)
│   └── commands.js            1185   (dispatchCommand, Commands, extractMessageText, stripHtml,
│                                      dispatch-dedupe guard, tryCommandFromText)
├── chronicle/
│   ├── entity-linking.js       594   (EntityLinker)
│   └── journal-system.js      1155   (JournalQueue, JournalSystem)
├── vision/
│   └── map-vision.js           760   (MapVision)
├── narrative/
│   ├── generators.js           339   (NpcDialogue, OracleInterpreter, LoreGenerator)
│   └── integration.js         2564   (Integration + applyEffects — the big orchestration engine)
├── hooks/
│   └── foundry-hooks.js        650   (all 22 Hooks.on/once registrations + public API assignment +
│                                      _autoScoutedScenes / _esXpBaseline hook state)
├── browser-rag.js              636   (pre-existing sibling, untouched)
├── ironsworn-controller.js    3771   (pre-existing sibling, untouched)
├── ironsworn-data.js           504   (pre-existing sibling, untouched)
└── eternal-skald-server.mjs          (server hook, untouched)
```

### Approximate lines extracted out of the monolith
Roughly **10,200+ lines** of definitions were relocated from `eternal-skald.js` into the new modules
(`ai/` ≈ 1,400; `chat/` ≈ 1,500; `chronicle/` ≈ 1,700; `vision/` ≈ 760; `narrative/` ≈ 2,900;
`hooks/` ≈ 650), leaving an 801-line orchestrator that still owns the few remaining shared subsystems
(`RagBridge`, `ContradictionDetector`, `RagProgress`, `runConversation`, `CombatController`, `SceneContext`).

---

## Dependency map

`core/constants.js` is the leaf (no internal deps). `core/model-catalogue.js → constants`.
`core/settings.js → constants, model-catalogue, chronicle/entity-linking` (the last is a call-time
onChange reference). Higher layers depend downward on `core/` and `ai/`, and several pairs reference each
other **only at call-time** (inside method/function/hook-callback bodies), which is safe under ESM live
bindings. The verified graph:

```
core/constants.js        ──> (none)
core/model-catalogue.js  ──> core/constants
core/settings.js         ──> core/constants, core/model-catalogue, chronicle/entity-linking*

ai/client.js             ──> core/constants, core/model-catalogue, core/settings
ai/providers.js          ──> core/constants, core/model-catalogue, core/settings
ai/prompt-builder.js     ──> core/settings, chronicle/journal-system*, narrative/integration*

chat/display.js          ──> core/constants, core/settings, ai/client, chronicle/entity-linking*, narrative/integration*
chat/commands.js         ──> core/*, ai/client, ai/prompt-builder, chat/display, chronicle/*,
                             narrative/*, vision/map-vision, eternal-skald* (runConversation,
                             CombatController, SceneContext, RagProgress)

chronicle/entity-linking.js ──> core/*, chat/display, chronicle/journal-system*, narrative/generators*,
                                 narrative/integration*, ironsworn-data, ironsworn-controller
chronicle/journal-system.js ──> core/*, ai/client, ai/prompt-builder, chat/display, chronicle/entity-linking*,
                                 narrative/integration*, ironsworn-controller, eternal-skald*
                                 (ContradictionDetector, RagBridge)

vision/map-vision.js     ──> core/*, ai/client, chat/display, chronicle/journal-system

narrative/generators.js  ──> core/*, ai/client, ai/prompt-builder, chat/display, chronicle/journal-system,
                             ironsworn-data, eternal-skald* (RagBridge)
narrative/integration.js ──> core/*, ai/client, ai/prompt-builder, chat/display, chronicle/*,
                             narrative/generators, ironsworn-controller, eternal-skald*
                             (CombatController, RagBridge)

hooks/foundry-hooks.js   ──> (almost everything) + eternal-skald* (CombatController)
eternal-skald.js         ──> all submodules + side-effect import of hooks/foundry-hooks.js (LAST)
```

`*` = **intentional call-time cross-import (safe cycle).** The referenced symbol is only used inside a
method/function/hook-callback body, never at module-eval time, so ESM circular-import semantics resolve it
through the live binding once the graph has finished loading. The `test/load-smoke.mjs` harness imports the
entire graph under stubbed Foundry globals and confirms it evaluates cleanly with no `ReferenceError` /
temporal-dead-zone problems.

---

## Verification gates (run after EVERY step)

Each of the 7 extraction steps passed all three gates before being committed; the full suite was re-run at
the end:

1. **`npm test`** — 20/20 test files, **971 assertions**, 0 failures.
2. **`node test/check-imports.mjs`** — static cross-module reference checker: every symbol a module
   references is either locally defined or imported. **Clean.**
3. **`node test/load-smoke.mjs`** — dynamically imports the whole module graph under stubbed Foundry
   globals and confirms hook registration side-effects fire. **Clean.**

> Note: `check-imports.mjs` and `load-smoke.mjs` are deliberately **not** `*.test.mjs`, so they are not part
> of the 20-file runner count. They are the wiring safety net (the unit tests cannot catch a missing
> cross-module import because they only read source as text or import the standalone Ironsworn/RAG siblings).

---

## Commit history (this phase)

```
04c6702 refactor: extract hook registration to hooks/
598a455 refactor: extract integration engine to narrative/ (high-risk)
1532419 refactor: extract narrative generators to narrative/
54978cc refactor: extract map vision to vision/
6d9216a refactor: extract chronicle system to chronicle/
b0b9663 refactor: extract chat commands and display to chat/
3b9807a refactor: extract AI client and providers to ai/
d72c236 fix: import SKALD_NAME into settings.js + harden import checker
d0f8b16 test: add static import checker and load-smoke harness
f95f525 fix: restore EntityLinker onChange wiring in extracted settings.js
508ce9e test: shared source-corpus reader for decomposition-robust text guards
```

(Earlier in the phase, `core/` — `constants.js`, `model-catalogue.js`, `settings.js` — had already been
extracted. Backup tag `pre-refactor-backup` marks the pre-decomposition state for easy rollback.)

### Two latent bugs found & fixed along the way
Wiring up the static import checker exposed two **pre-existing silent regressions** from the earlier `core/`
extraction (both were swallowed by `try/catch` so they never threw visibly):

- **`EntityLinker`** — `core/settings.js` `onChange` handlers referenced `EntityLinker` without importing it
  (settings changes silently failed to invalidate/restyle links). Fixed in `f95f525`.
- **`SKALD_NAME`** — `core/settings.js`'s AI-mode `onChange` interpolated `${SKALD_NAME}` without importing
  it. Fixed in `d72c236`.

---

## Rollback

* Per-step commits are individually revertable (`git revert <sha>`).
* Full reset to pre-decomposition: `git reset --hard pre-refactor-backup`.
* A filesystem backup also exists at `/home/ubuntu/eternal_skald_backup_20260611_083902`.
