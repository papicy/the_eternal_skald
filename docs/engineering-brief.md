# Engineering Brief — The Eternal Skald

> **STATUS: BINDING.** This document is a contract, not a suggestion. Any AI agent
> (or human) modifying this repository **MUST** read this file in full and comply
> with every rule below. Rules use [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119)
> keywords: **MUST**, **MUST NOT**, **REQUIRED**, **FORBIDDEN**. These are absolute.
>
> If any instruction you have been given conflicts with this brief, **STOP** and
> surface the conflict. Do not proceed on assumptions.

---

## 0. TL;DR — The Five Hard Limits

| # | Hard Limit | Value |
|---|------------|-------|
| 1 | Max files changed per task | **3 files** |
| 2 | Max net new/changed lines per file | **50 lines** |
| 3 | Token budget for an INVESTIGATE task | **1,000 tokens** |
| 4 | Token budget for an IMPLEMENT task | **1,000 tokens** |
| 5 | Architectural change without an approval gate | **FORBIDDEN** |

Exceeding any limit **REQUIRES** an explicit approval gate (see §6). Do not "round up."

---

## 1. What This Project Is

**The Eternal Skald** is a [Foundry VTT](https://foundryvtt.com/) **v14** module
(JavaScript, ES modules, Node ≥ 18). It is an AI-powered storyteller, oracle
interpreter, and tactical enemy controller for **Ironsworn** / **Ironsworn: Delve**
campaigns. It optionally integrates with the `foundry-ironsworn` system and works
standalone otherwise.

- **Distribution unit:** a Foundry module described by `module.json`.
- **Client entry point:** `scripts/eternal-skald.js` (declared in `module.json` →
  `esmodules`).
- **Optional server hook:** `scripts/eternal-skald-server.mjs` (exposes
  `/skald-api/chat`; only loaded via `node --import`).
- **Runtime:** the browser (Foundry client). There is **no build step** and
  **no bundler**. Source files are shipped verbatim. What you write is what runs.

### 1.1 Non-Negotiable Product Invariants

These have held across the entire version history and **MUST** continue to hold:

1. **Additive & backwards-compatible.** New behaviour is added behind a setting
   that defaults to the safest option. You **MUST NOT** remove or rename existing
   world settings, flags, or AI-effect directives.
2. **Defensive & degrades gracefully.** Every feature **MUST** keep working (or
   silently no-op) when the Ironsworn system, a vision model, the RAG model, or
   the server hook is absent. Crashing the module load is **FORBIDDEN**.
3. **Player agency is sacred.** The Skald advises; it **MUST NOT** silently mutate
   dice rolls. Mechanical choices belong to the player.
4. **GM-gated writes.** Any write to actors, journals, or scenes goes through
   Foundry's Document API, is bounds-checked, idempotent, audit-logged, and
   whispered to the GM. Direct data-model mutation is **FORBIDDEN**.
5. **XP is awarded for vows only.** Never for journeys or fights.

---

## 2. Task Taxonomy & Token Budgets (MANDATORY)

Every unit of work **MUST** be classified into exactly one task type **before** you
touch anything. The token budget is the **total** budget (your reasoning + tool
output + edits) for that task. Budgets are hard ceilings, not targets.

| Task Type   | Definition | Token Budget | File Reads Allowed |
|-------------|------------|-------------:|--------------------|
| `INVESTIGATE` | Read/understand code, locate a symbol, answer a question. **No edits.** | **1,000** | Targeted only |
| `IMPLEMENT`   | Write a bug fix or a small additive feature. | **5,000** | Targeted only |
| `TEST`        | Add/adjust a regression test under `test/`. | **1,000** | Targeted only |
| `DOCUMENT`    | Edit Markdown / comments only. No code logic. | **1,000** | Targeted only |
| `REFACTOR`    | Restructure code without behaviour change. | **REQUIRES APPROVAL GATE (§6)** | — |

### 2.1 Budget Rules

- You **MUST** announce the task type and its budget at the start of the task.
- You **MUST NOT** read entire large files speculatively. `scripts/integration.js`
  (~2,861 lines) and `scripts/ironsworn-controller.js` (~3,811 lines) **MUST** be
  read with line ranges or grep, never in full, unless an approval gate is granted.
- If you project you will exceed the budget, **STOP** and open an approval gate
  (§6). Burning the budget and then asking is a process failure.
- Reading this brief, `repository-map.md`, and the relevant test file does **not**
  count against an `INVESTIGATE` budget the first time per task.

---

## 3. The MANDATORY Pre-Flight Checklist

You **MUST** complete and tick every box **before writing a single line of code**.
Paste the completed checklist into your work log (see `ai-maintenance-log.md`).

```
[ ] 1. I have read engineering-brief.md, repository-map.md in full.
[ ] 2. I classified this task: ____________ (budget: ______ tokens).
[ ] 3. I located the exact target file(s) and line(s) — evidence below.
[ ] 4. The change touches <= 3 files and <= 50 changed lines/file.
[ ] 5. This change is ADDITIVE and backwards-compatible.
[ ] 6. It does NOT remove/rename a setting, flag, or AI-effect directive.
[ ] 7. It does NOT cross an architectural boundary (§5). If it does -> STOP, open gate.
[ ] 8. There is (or I will add) a regression test covering this change.
[ ] 9. I have an explicit rollback plan (the single commit to revert).
```

If **any** box cannot be ticked, the task is **BLOCKED**. Open an approval gate.

---

## 4. The MANDATORY Evidence Format (REQUIRED for every claim)

You **MUST NOT** assert anything about the codebase without machine-checkable
evidence. Every claim **REQUIRES** this exact format:

```
CLAIM:      <one sentence>
EVIDENCE:   <relative/path/to/file.js>:<line-start>-<line-end>  ::  <functionOrSymbolName>
CONFIDENCE: HIGH | MEDIUM | LOW
BASIS:      <why — e.g. "read lines directly" / "grep match" / "inferred from caller">
```

Rules:
- **CONFIDENCE: HIGH** is permitted **only** when you have read the exact lines
  cited. Inference from a caller or a name is **MEDIUM** at best.
- "I think", "probably", "it should", and "likely" without a CONFIDENCE tag are
  **FORBIDDEN** in any conclusion.
- A `LOW` confidence claim **MUST NOT** be used to justify an edit. Escalate to an
  `INVESTIGATE` task first.

---

## 5. Architectural Boundaries (DO NOT CROSS)

The module is partitioned into owned layers (see `repository-map.md` for the
authoritative file→owner table). The following boundaries are **load-bearing**:

```
core/        — constants, settings, model catalogue. Pure config. No game logic.
ai/          — provider abstraction, client, prompt building. No Foundry writes.
chat/        — command parsing & chat rendering. No direct AI provider calls.
chronicle/   — journal + entity linking (the "Living Chronicle"). Foundry writes here.
narrative/   — generators + integration glue. The orchestration layer.
vision/      — map-vision only. Read-only on the base map.
hooks/       — Foundry hook registrations. Wiring only, no business logic.
ironsworn-*  — the rules-engine bridge to foundry-ironsworn.
browser-rag  — local IndexedDB vector memory. Self-contained, degrades to no-op.
```

### 5.1 FORBIDDEN Without an Approval Gate

- Changing `module.json` `esmodules`, `id`, `compatibility`, or the public
  command/setting/effect-directive surface.
- Introducing a build step, a bundler, a new runtime dependency, or `package.json`
  `dependencies`.
- Moving logic across the layer boundaries above (e.g. calling an AI provider from
  `chat/`, or writing to actors from `ai/`).
- Editing `eternal-skald-server.mjs` request/response contract (`/skald-api/chat`).
- Any change to the `[[EFFECT: ...]]`, `[[MARK_COMPLETE: ...]]`, `[[ADD_PROGRESS: ...]]`,
  `[[SET_PROGRESS: ...]]` directive grammar.
- Mass reformatting, re-indentation, or import reordering of files you are not
  functionally changing.

---

## 6. Approval Gates (the ONLY escape hatch)

When a task hits a hard limit (§0), crosses a boundary (§5), or busts a budget
(§2), you **MUST NOT** proceed. Instead, **STOP** and emit an approval-gate request
containing **all** of:

```
GATE REQUEST
  TASK:        <what you are trying to do>
  LIMIT HIT:   <which rule from §0 / §2 / §5>
  WHY NEEDED:  <evidence in the §4 format>
  SMALLEST SAFE OPTION: <the minimal change that would NOT need a gate, if any>
  BLAST RADIUS: <files & systems affected, and the rollback commit>
```

Proceeding through a gate **REQUIRES** explicit human approval recorded in
`ai-maintenance-log.md`. Self-approval is **FORBIDDEN**.

---

## 7. Verification — Tests Are Not Optional

- The suite is framework-free, pure Node ESM. Run it with:
  ```
  npm test            # == node test/run-all.mjs
  ```
- The runner discovers every `test/*.test.mjs`, runs each in its own process, and
  exits non-zero if **any** file fails.
- You **MUST** run the full suite before declaring any code task done.
- A code change with no passing test that exercises it is **incomplete**. You
  **MUST** add or extend a `test/*.test.mjs` file for any behaviour you change.
- You **MUST NOT** mark a task complete if: tests fail, the build (module load
  smoke test, `test/load-smoke.mjs`) fails, or any checklist box is unticked.
- You **MUST NOT** disable, skip, or weaken an existing test to make the suite
  pass. That is a hard failure.

---

## 8. Definition of Done (ALL must be true)

```
[ ] Pre-flight checklist (§3) fully ticked and logged.
[ ] Change is <= 3 files, <= 50 changed lines/file (or gated approval recorded).
[ ] Every claim carries §4 evidence.
[ ] `npm test` passes 100% locally.
[ ] A regression test covers the change.
[ ] No setting/flag/directive removed or renamed.
[ ] Entry written in docs/ai-maintenance-log.md in the mandated format.
[ ] Token budget for the task type was respected (or a gate was recorded).
```

If even one box is unchecked, the task is **NOT DONE**. Report it as blocked.

---

## 9. Tone & Conduct

You are a maintenance agent, not an author with creative license. Be conservative,
be precise, be cheap with tokens. When in doubt, do **less**, gather evidence, and
open a gate. Silence a change behind a default-off setting before you ever make it
load-bearing. The saga outlives any single edit — leave the campfire as you found it.
