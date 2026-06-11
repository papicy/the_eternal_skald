# Repository Map & File Ownership — The Eternal Skald

> **STATUS: BINDING.** This is the authoritative map of every source area, its
> owner layer, and the rules governing whether you may touch it. Read it with
> `engineering-brief.md`. Rules use **MUST / MUST NOT / FORBIDDEN** in the
> [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) sense. They are absolute.
>
> **Before editing ANY file you MUST:** (1) locate it in the ownership table
> below, (2) read its "Touch Rule", (3) confirm the change respects the layer
> boundary, and (4) cite evidence in the §4 format from the brief.

---

## 0. Touch-Rule Legend

| Rule | Meaning |
|------|---------|
| 🟢 `OPEN` | May be edited under a normal `IMPLEMENT`/`TEST` task within the §0 hard limits. |
| 🟡 `GUARDED` | Edits permitted **only** with extra care; a regression test is **REQUIRED**; read the whole owner section first. |
| 🔴 `LOCKED` | **FORBIDDEN** to edit without a recorded approval gate (brief §6). |
| 🧊 `GENERATED/CONTRACT` | Manifest/contract surface. Editing changes the public API. **LOCKED.** |

---

## 1. Top-Level Layout (authoritative)

```
the_eternal_skald/
├── module.json                 🧊 CONTRACT — Foundry manifest. LOCKED.
├── package.json                🔴 LOCKED — scripts/engines only; no deps.
├── README.md                   🟡 GUARDED — user-facing; keep in sync, no churn.
├── CHANGELOG.md                🟡 GUARDED — append-only; never rewrite history.
├── DEPLOYMENT.md               🟡 GUARDED.
├── LICENSE                     🔴 LOCKED.
├── .gitignore                  🟡 GUARDED.
├── lang/en.json                🟡 GUARDED — i18n keys are a contract (see §4).
├── styles/eternal-skald.css    🟢 OPEN (presentation only).
├── scripts/                    (see §2 — the code)
├── test/                       🟢 OPEN — regression suite (see §3).
└── docs/                       🟢 OPEN — these governance docs.
```

You **MUST NOT** create new top-level files or directories without an approval gate.

---

## 2. `scripts/` — Source Ownership Table (THE LAW)

Layer boundaries are load-bearing (brief §5). The "May Call" / "MUST NOT Call"
columns are enforced. Crossing them is **FORBIDDEN** without a gate.

| Path | ~LOC | Owner Layer | Touch Rule | May Call | MUST NOT Call |
|------|-----:|-------------|:----------:|----------|---------------|
| `eternal-skald.js` | 801 | **bootstrap/entry** | 🔴 LOCKED | wires all layers | — (orchestration only; no new logic) |
| `eternal-skald-server.mjs` | 486 | **server hook** | 🔴 LOCKED | Node/Foundry HTTP | client modules |
| `core/constants.js` | 365 | core | 🟡 GUARDED | nothing | any game/Foundry logic |
| `core/settings.js` | 852 | core | 🟡 GUARDED | core only | AI providers, Foundry writes |
| `core/model-catalogue.js` | 272 | core | 🟢 OPEN | core only | — |
| `ai/providers.js` | 120 | ai | 🟡 GUARDED | core | chat/, chronicle/ |
| `ai/client.js` | 622 | ai | 🟡 GUARDED | core, providers | Foundry Document writes |
| `ai/prompt-builder.js` | 694 | ai | 🟡 GUARDED | core | Foundry Document writes |
| `chat/commands.js` | 1301 | chat | 🟡 GUARDED | narrative/, core | AI provider directly |
| `chat/display.js` | 332 | chat | 🟢 OPEN | core | AI provider directly |
| `chronicle/entity-linking.js` | 594 | chronicle | 🟡 GUARDED | Foundry Document API | ai/ providers |
| `chronicle/journal-system.js` | 1155 | chronicle | 🟡 GUARDED | Foundry Document API | ai/ providers |
| `narrative/generators.js` | 339 | narrative | 🟢 OPEN | ai/, chronicle/ | core internals |
| `narrative/integration.js` | 2861 | narrative | 🔴 LOCKED | all lower layers | — (read with ranges only) |
| `vision/map-vision.js` | 824 | vision | 🟡 GUARDED | ai/client | scene WRITES (read-only!) |
| `hooks/foundry-hooks.js` | 650 | hooks | 🟡 GUARDED | narrative/, chat/ | new business logic |
| `ironsworn-controller.js` | 3811 | rules bridge | 🔴 LOCKED | Foundry + ironsworn | — (read with ranges only) |
| `ironsworn-data.js` | 514 | rules bridge | 🟡 GUARDED | ironsworn system | — |
| `browser-rag.js` | 636 | rag | 🟡 GUARDED | IndexedDB/transformers | Foundry game logic |

### 2.1 Hard File-Read Rules

- The two 🔴 LOCKED giants — `narrative/integration.js` (2,861 LOC) and
  `ironsworn-controller.js` (3,811 LOC) — **MUST** be read with `grep` + line
  ranges. Reading either in full is **FORBIDDEN** (it alone blows an `INVESTIGATE`
  budget). Cite `file:line` evidence (brief §4) for everything you assert about them.
- You **MUST NOT** edit a 🔴 LOCKED file without an approval gate, even for a
  one-line change.

---

## 3. `test/` — The Regression Suite (🟢 OPEN, but REQUIRED)

```
test/run-all.mjs          — discovers & runs every *.test.mjs in its own process.
test/load-smoke.mjs       — module load smoke test (MUST stay green).
test/check-imports.mjs    — import-integrity guard.
test/_skald-source.mjs    — shared source harness. 🟡 GUARDED.
test/*.test.mjs           — 20 framework-free regression files.
```

Rules:
- Tests are framework-free, pure Node ESM (Node ≥ 18). No test runner dependency
  may be added.
- Run with `npm test`. The suite **MUST** be 100% green before any task is "done".
- Every behavioural change **REQUIRES** a new or extended `*.test.mjs`.
- You **MUST NOT** delete, skip, or weaken an existing test to go green.
- New test files **MUST** follow the existing convention: maintain their own
  pass/fail counters, print `"<n> passed, <m> failed"`, and
  `process.exit(m ? 1 : 0)`.

---

## 4. Contract Surfaces (🧊 — change = public API break)

The following are **public contracts**. Touching them is **LOCKED** behind an
approval gate, and changes **MUST** be additive only:

1. **`module.json`** — `id`, `esmodules`, `compatibility`, `relationships`,
   `manifest`/`download` URLs.
2. **World settings** registered in `core/settings.js` — names and types are a
   migration contract. **MUST NOT** rename or remove. New settings default to the
   safest option.
3. **Chat commands** (the `!...` surface, defined via `core/constants.js` →
   `COMMANDS` and handled in `chat/commands.js`).
4. **AI-effect directives** — `[[EFFECT: ...]]`, `[[MARK_COMPLETE: ...]]`,
   `[[ADD_PROGRESS: ...]]`, `[[SET_PROGRESS: ...]]`. The grammar is frozen.
5. **i18n keys** in `lang/en.json` — keys are referenced by code; renaming a key
   is a break. Add keys, do not repurpose them.
6. **`/skald-api/chat`** request/response shape in `eternal-skald-server.mjs`.

---

## 5. The MANDATORY "May I Touch It?" Decision Gate

Run this **before** editing any file. If any answer pushes you right, **STOP**.

```
1. Is the file 🔴 LOCKED or 🧊 CONTRACT?            yes -> OPEN APPROVAL GATE.
2. Does the change cross a layer boundary (§2)?     yes -> OPEN APPROVAL GATE.
3. Will it exceed 3 files OR 50 changed lines/file? yes -> OPEN APPROVAL GATE.
4. Does it remove/rename a setting/command/directive/i18n key? yes -> FORBIDDEN.
5. Is it purely additive + behind a safe default?   no  -> reconsider; likely gate.
6. Do I have file:line evidence (brief §4)?         no  -> do INVESTIGATE first.
```

Only when every answer keeps you left of a gate may you proceed under a normal
`IMPLEMENT`/`TEST`/`DOCUMENT` task.

---

## 6. Ownership Summary (one line each)

- **core/** owns configuration truth. It knows nothing about game state.
- **ai/** owns talking to models. It never writes to Foundry documents.
- **chat/** owns parsing input and rendering output. It never calls a provider directly.
- **chronicle/** owns the Living Chronicle (journals, entity links). It writes via the Document API.
- **narrative/** orchestrates everything. `integration.js` is the spine — treat it as load-bearing and LOCKED.
- **vision/** is read-only on the base map. It **MUST NOT** mutate scenes.
- **hooks/** is wiring. Put logic in the owning layer, not here.
- **ironsworn-*** is the rules bridge. Mirror the system's data model exactly; never invent schema fields.
- **browser-rag** is a self-contained local memory that always degrades to a no-op.

When two areas seem to both "own" a change, the change is probably an architectural
one — **STOP** and open an approval gate.
