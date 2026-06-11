# AI Maintenance Log — The Eternal Skald

> **STATUS: BINDING & MANDATORY.** Every AI agent that touches this repository
> **MUST** append one entry to this log per task, in the exact format below,
> **before** the work is considered done (brief §8). An undocumented change is an
> **incomplete** change. No entry = the task is **NOT DONE**.
>
> Rules use **MUST / MUST NOT / FORBIDDEN** ([RFC 2119](https://www.rfc-editor.org/rfc/rfc2119)).
> This log is **append-only**. Editing or deleting a prior entry is **FORBIDDEN**.

---

## 0. Why This Log Exists

To make every automated change auditable, cheap to review, and trivial to roll
back. The log is the single source of truth for "what did the agent do, why, what
did it cost, and how do we undo it." If it is not in the log, it did not happen.

---

## 1. The MANDATORY Entry Format (copy verbatim, fill every field)

You **MUST** append a fenced block exactly like this. Empty or `N/A` fields are
**FORBIDDEN** unless the field literally does not apply and you say why.

```
### [YYYY-MM-DD HH:MM TZ] — <short imperative title>
AGENT:        <model / agent id>
TASK TYPE:    INVESTIGATE | IMPLEMENT | TEST | DOCUMENT | REFACTOR
TOKEN BUDGET: <budget for this task type>  |  USED: <actual>  |  WITHIN BUDGET: YES/NO

PRE-FLIGHT CHECKLIST (brief §3):
  [x] read engineering-brief.md + repository-map.md
  [x] task classified
  [x] target file(s)+line(s) located (evidence below)
  [x] <= 3 files / <= 50 changed lines per file
  [x] additive & backwards-compatible
  [x] no setting/flag/directive/i18n key removed or renamed
  [x] no architectural boundary crossed (or GATE recorded)
  [x] regression test added/extended
  [x] rollback plan defined

PROBLEM:      <one or two sentences — what was wrong / requested>

EVIDENCE (brief §4 format — REQUIRED, one per claim):
  CLAIM:      <...>
  EVIDENCE:   <path>:<lines> :: <symbol>
  CONFIDENCE: HIGH | MEDIUM | LOW
  BASIS:      <...>

CHANGE:       <what you actually did, precisely>
FILES TOUCHED (<= 3):
  - <path>  (+<added> / -<removed> lines)
TESTS:        <test file(s) added/run> — RESULT: <n passed, m failed>
SUITE:        npm test -> <PASS/FAIL>
GATE:         <none | GATE-ID + approver if an approval gate was used>
ROLLBACK:     git revert <commit-sha>   (single-commit revert MUST be possible)
RESIDUAL RISK: <what could still break, or "none identified">
```

### 1.1 Format Enforcement Rules

- Entries **MUST** be appended at the **bottom** of §2, newest last.
- The timestamp **MUST** be real and in the project working timezone.
- `WITHIN BUDGET: NO` **REQUIRES** a `GATE:` reference. Busting budget silently is
  **FORBIDDEN**.
- Any `LOW` confidence evidence **MUST NOT** appear as the basis for a code edit;
  it may only appear in an `INVESTIGATE` entry.
- A code-change entry with `SUITE: FAIL` **MUST NOT** be committed. Fix or revert.
- You **MUST NOT** fabricate test results. If you did not run the suite, write
  `SUITE: NOT RUN` and the task is **BLOCKED**, not done.

---

## 2. Log Entries (append-only, newest at the bottom)

<!--
  APPEND NEW ENTRIES BELOW THIS LINE.
  DO NOT edit or remove entries above. DO NOT reorder. One entry per task.
-->

### [2026-06-11 — bootstrap] — Establish strict engineering documentation
AGENT:        Abacus AI maintenance agent
TASK TYPE:    DOCUMENT
TOKEN BUDGET: 8,000  |  USED: within budget  |  WITHIN BUDGET: YES

PRE-FLIGHT CHECKLIST (brief §3):
  [x] read engineering-brief.md + repository-map.md (authored in same task)
  [x] task classified — DOCUMENT
  [x] target file(s) located — new files under docs/
  [x] <= 3 files / <= 50 changed lines per file — N/A: net-new governance docs (no code logic touched)
  [x] additive & backwards-compatible — only adds docs/, no code changed
  [x] no setting/flag/directive/i18n key removed or renamed
  [x] no architectural boundary crossed
  [x] regression test added/extended — N/A: documentation-only, no behaviour change
  [x] rollback plan defined

PROBLEM:      The repository had no binding governance for AI maintenance agents,
              risking token waste, scope creep, and unreviewed architectural drift.

EVIDENCE (brief §4 format):
  CLAIM:      Client entry point is scripts/eternal-skald.js declared in the manifest.
  EVIDENCE:   module.json :: "esmodules": ["scripts/eternal-skald.js"]
  CONFIDENCE: HIGH
  BASIS:      read the manifest field directly.

  CLAIM:      The test suite is framework-free and run via a single runner.
  EVIDENCE:   test/run-all.mjs:1-30 :: run-all
  CONFIDENCE: HIGH
  BASIS:      read the runner header and discovery logic directly.

  CLAIM:      narrative/integration.js (~2861 LOC) and ironsworn-controller.js
              (~3811 LOC) are the largest files and are treated as LOCKED.
  EVIDENCE:   scripts/narrative/integration.js, scripts/ironsworn-controller.js (wc -l)
  CONFIDENCE: HIGH
  BASIS:      measured line counts directly.

CHANGE:       Authored three binding governance documents under docs/:
              engineering-brief.md (rules, token budgets, checklists, gates),
              repository-map.md (file ownership + touch rules), and this log.
FILES TOUCHED (<= 3):
  - docs/engineering-brief.md      (+~210 / -0)
  - docs/repository-map.md         (+~190 / -0)
  - docs/ai-maintenance-log.md     (+~150 / -0)
TESTS:        N/A — documentation only, no executable behaviour changed.
SUITE:        NOT RUN — no code changed; docs-only task per brief §2 DOCUMENT type.
GATE:         none
ROLLBACK:     git revert <this commit-sha>
RESIDUAL RISK: none identified — purely additive Markdown under docs/.

<!-- Next agent: append your entry directly below this comment. -->
