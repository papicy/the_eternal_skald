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

### [2026-06-11 18:10 EEST] — Investigate "Discover a Site" / "Locate Your Objective" trigger failure
AGENT:        Abacus AI maintenance agent
TASK TYPE:    INVESTIGATE
TOKEN BUDGET: 10,000  |  USED: within budget  |  WITHIN BUDGET: YES

PRE-FLIGHT CHECKLIST (brief §3):
  [x] read engineering-brief.md + repository-map.md
  [x] task classified — INVESTIGATE (no edits to code)
  [x] target file(s)+line(s) located (evidence below)
  [x] <= 3 files / <= 50 changed lines per file — N/A: no code changed; only docs/ added/append
  [x] additive & backwards-compatible — only new docs/ report + this append-only log entry
  [x] no setting/flag/directive/i18n key removed or renamed
  [x] no architectural boundary crossed — LOCKED files read with ranges only, not edited
  [x] regression test added/extended — N/A: investigation only, no behaviour change
  [x] rollback plan defined

PROBLEM:      "Discover a Site" and "Locate Your Objective" fail with
              "Could not trigger … (no dialog and no rollable stat)."

EVIDENCE (brief §4 format):
  CLAIM:      The error is triggerMove()'s final fall-through.
  EVIDENCE:   scripts/ironsworn-controller.js:1384-1389 :: triggerMove
  CONFIDENCE: HIGH
  BASIS:      read the lines directly.

  CLAIM:      _isProgressMove() whitelists only fulfill_your_vow/reach_your_destination/end_the_fight,
              omitting the Delve progress move locate_your_objective (and escape_the_depths).
  EVIDENCE:   scripts/ironsworn-controller.js:2034-2039 :: _isProgressMove  (vs catalog :130, :131)
  CONFIDENCE: HIGH
  BASIS:      read the regex/name set and compared to catalog rows.

  CLAIM:      Manual-roll fallback skips stat==="progress" and ""; Discover a Site has stats:[], Locate has ["progress"].
  EVIDENCE:   scripts/ironsworn-controller.js:1379-1382 :: triggerMove  (catalog :126, :130)
  CONFIDENCE: HIGH
  BASIS:      read the guard and both catalog rows.

CHANGE:       No code changed. Authored docs/INVESTIGATION-discover-locate-moves.md
              (findings, root cause, execution path, comparison, minimal plan, risks).
FILES TOUCHED (<= 3):
  - docs/INVESTIGATION-discover-locate-moves.md   (+~150 / -0, new)
  - docs/ai-maintenance-log.md                    (+~45 / -0, append-only)
TESTS:        N/A — investigation only, no executable behaviour changed.
SUITE:        NOT RUN — no code changed (INVESTIGATE task, brief §2).
GATE:         none — no LOCKED/contract file edited; controller read with ranges only.
ROLLBACK:     git revert <this commit-sha>
RESIDUAL RISK: none identified — additive Markdown only. Any actual fix to
              ironsworn-controller.js (LOCKED) will REQUIRE an approval gate.

### [2026-06-11 20:23 EEST] — Implement AI "Discover a Site" generator (Ironsworn: Delve)
AGENT:        Abacus AI maintenance agent
TASK TYPE:    IMPLEMENT
TOKEN BUDGET: 20,000  |  USED: within budget  |  WITHIN BUDGET: YES

PRE-FLIGHT CHECKLIST (brief §3):
  [x] read engineering-brief.md + repository-map.md
  [x] task classified — IMPLEMENT (new feature; LOCKED file edited)
  [x] target file(s)+line(s) located (evidence below)
  [~] <= 3 files / <= 50 changed lines per file — EXCEEDED; gated approval recorded (see GATE)
  [x] additive & backwards-compatible — new behaviour only on the previously-dead
      "Discover a Site" path; no existing path altered
  [x] no setting/flag/directive/i18n key removed or renamed (no settings added either —
      feature reuses the existing `aiMode` gate and degrades gracefully)
  [~] architectural boundary crossed — new AI layer + LOCKED controller edit; APPROVED
  [x] regression test added — test/site-generator.test.mjs (55 assertions)
  [x] rollback plan defined

PROBLEM:      The Ironsworn: Delve "Discover a Site" move (stats:[], no roll) had no
              handler and dead-ended at triggerMove()'s "no dialog and no rollable
              stat" error (investigated in the prior log entry / docs/INVESTIGATION-…).

APPROACH (hybrid, approved Option B):
  Roll a random Theme + Domain (preserve Delve probability structure / "Delve DNA"),
  gather campaign context, ask the Skald LLM to enrich it into a MYSTERIOUS site
  returned as strict JSON, realise it as a Foundry progress-track Item (+ optional
  journal page), present it to the players, and fall back to a manual-oracle site
  when the AI is disabled/unreachable. AI adds flavour only — it never replaces the
  random roll and never resolves the players' choices.

EVIDENCE (brief §4 format):
  CLAIM:      Dead-end was triggerMove()'s final fall-through; a new no-roll branch
              fixes it without touching existing branches.
  EVIDENCE:   scripts/ironsworn-controller.js:1367-1378 :: triggerMove (new 0c branch)
  CONFIDENCE: HIGH
  BASIS:      mirrors the adjacent _isMilestoneMove branch (1363-1365); suite green.
  CLAIM:      Delve DNA preserved — 10 themes / 12 domains drawn uniformly like cards;
              prompt encodes Delve's Features (domain-led) structure + mystery directives.
  EVIDENCE:   scripts/narrative/site-oracle.js :: DELVE_THEMES/DELVE_DOMAINS/buildSitePrompt
  CONFIDENCE: HIGH
  BASIS:      unit tests [1]-[3]; theme/domain lists verified against Delve SRD (CC BY 4.0).
  CLAIM:      Graceful degradation — no AI key/unreachable/garbage JSON → manual fallback,
              never crashes module load.
  EVIDENCE:   scripts/narrative/generators.js :: SiteGenerator.discover (try/catch → buildFallbackSite)
  CONFIDENCE: HIGH
  BASIS:      unit tests [4],[6]; load-smoke + check-imports pass.

CHANGE:
  - NEW scripts/narrative/site-oracle.js — pure, Foundry-free core: Delve theme/domain
    decks, rollThemeAndDomain (Delve DNA), buildSitePrompt (embeds the four mandated
    "mystery, not explanation" directives), parseSiteResponse (tolerant JSON + coercion),
    buildFallbackSite, normalizeSiteRank. Importable → unit-testable.
  - EDIT scripts/narrative/generators.js (🟢 OPEN) — add SiteGenerator orchestration
    (context gather → Client.chat → parse → IronswornController.createProgressTrack
    (trackType "delve" → subtype "progress", tagged trackKind:"delve") → chat card →
    journal). Permission-gated (isGM / ITEM_CREATE / JOURNAL_CREATE).
  - EDIT scripts/ironsworn-controller.js (🔴 LOCKED) — add _isDiscoverSiteMove classifier
    + a no-roll branch in triggerMove that dynamic-imports SiteGenerator (keeps the
    no-top-level-imports invariant). Returns {ok:true, method:"discover-site"} so
    integration narration stays on the happy path (no "dice would not answer" whisper,
    no milestone narration, no spurious roll card).
FILES TOUCHED:
  - scripts/narrative/site-oracle.js              (+204 / -0, new pure module)
  - scripts/narrative/generators.js              (+138 / -0, OPEN — exceeds 50-line cap)
  - scripts/ironsworn-controller.js              (+25 / -0, LOCKED)
  - test/site-generator.test.mjs                  (+155 / -0, new test)
  - docs/ai-maintenance-log.md                    (append-only)
TESTS:        ADDED test/site-generator.test.mjs — 55 passed, 0 failed
              (Delve DNA, mystery directives, JSON parse/coerce/fallback, rank clamp,
               + source-text guards on the orchestration & LOCKED-controller wiring).
SUITE:        GREEN — `npm test` = 21 files / all passed, 0 failed.
              Plus check-imports: PASS, load-smoke: PASS.
GATE:         APPROVED (recorded). The user granted explicit approval for: (1) editing the
              🔴 LOCKED scripts/ironsworn-controller.js, (2) the architecture change (new AI
              site-generation layer), and (3) the new-feature scope incl. new files under
              scripts/narrative/ and exceeding the 3-file / 50-line-per-file budget. LOCKED
              edit kept minimal (+25 lines, dynamic import only). No settings/flags/i18n
              keys removed or renamed; no existing behaviour altered.
ROLLBACK:     git revert <this commit-sha> (single feature branch feat/ai-discover-a-site;
              deleting site-oracle.js + reverting the two edits fully removes the feature —
              the move simply returns to its prior error state).
RESIDUAL RISK: LOW. Behaviour is gated to the previously-dead Discover-a-Site path and to
              `aiMode`; degrades to a manual-oracle site with no AI. A "delve" track stores
              as subtype "progress" tagged trackKind:"delve" (consistent with how journeys/
              combat are stored), so no schema risk. Foundry runtime not exercised headlessly
              (no Foundry in CI) — verified via pure unit tests + load-smoke + source guards.

### [2026-06-11 20:34 EEST] — Implement "Locate Your Objective" / "Escape the Depths" (Delve site progress moves)
AGENT:        Abacus AI maintenance agent
TASK TYPE:    IMPLEMENT
TOKEN BUDGET: 20,000  |  USED: within budget  |  WITHIN BUDGET: YES

PRE-FLIGHT CHECKLIST (brief §3):
  [x] read engineering-brief.md + repository-map.md (prior context this session)
  [x] task classified — IMPLEMENT (LOCKED file edited)
  [x] target file(s)+line(s) located (evidence below)
  [~] <= 3 files / <= 50 changed lines per file — EXCEEDED in the LOCKED controller
      (+112 net); gated approval recorded (see GATE)
  [x] additive & backwards-compatible — new behaviour only on the two previously-dead
      Delve progress moves; vow/journey/combat resolution unchanged (regression test [9])
  [x] no setting/flag/directive/i18n key removed or renamed (none added either)
  [~] architectural boundary crossed — LOCKED edit; APPROVED (Option B)
  [x] regression test added — test/locate-objective.test.mjs (42 assertions)
  [x] rollback plan defined

PROBLEM:      The Ironsworn: Delve progress moves "Locate Your Objective" and
              "Escape the Depths" (both stats:["progress"]) had no track to roll
              against and dead-ended at triggerMove()'s "no dialog and no rollable
              stat" error (see prior INVESTIGATE entry / docs/INVESTIGATION-…).

APPROACH (Option B, approved):
  Whitelist both moves as PROGRESS moves and resolve the SITE track they roll
  against, in order: explicit trackRef (sheet roll button) → exactly one open
  site → auto; several open sites → a selection dialog (player chooses, never
  auto-decided); no open site → a clear, actionable error. A site is a progress
  Item tagged flags.<scope>.trackKind="delve" (created by SiteGenerator).

EVIDENCE (brief §4 format):
  CLAIM:      Both moves are progress rolls; adding them to the whitelist routes
              them through rollProgressMove instead of the error fall-through.
  EVIDENCE:   scripts/ironsworn-controller.js:2047-2057 :: _isProgressMove
              (catalog rows :130 locate, :131 escape — both stats:["progress"])
  CONFIDENCE: HIGH
  BASIS:      read the catalog + guard; unit test [1] + [8]; suite green.
  CLAIM:      Site resolution honours player agency — 0→error, 1→auto, many→dialog,
              cancel→abort (never auto-picks); vow/journey/combat unaffected.
  EVIDENCE:   scripts/ironsworn-controller.js:2214-2231 :: rollProgressMove
              + _openSiteTracks (2090) + _showSiteSelectionDialog (2114)
  CONFIDENCE: HIGH
  BASIS:      unit tests [3]-[7] (auto/dialog/cancel/sheet) + [9] regression.
  CLAIM:      "Delve the Depths" (an action roll, stats edge/shadow/wits) is NOT
              swept into the progress path.
  EVIDENCE:   unit test [1] asserts !_isProgressMove("Delve the Depths").
  CONFIDENCE: HIGH
  BASIS:      catalog row :127; explicit negative test.

CHANGE:       scripts/ironsworn-controller.js (🔴 LOCKED, approved):
  - _isProgressMove — whitelist locate_your_objective + escape_the_depths (dsid + name).
  - rollProgressMove — new kind "site"; site-track resolution block (auto / dialog /
    error); site-aware "no open track" message; excluded site from the generic
    newest-open-track fallback so resolution stays explicit.
  - NEW _openSiteTracks(actor) — open trackKind:"delve" tracks, newest first.
  - NEW _showSiteSelectionDialog(sites, moveName) — DialogV2 (v13+) with classic
    Dialog fallback; returns the chosen Item or null on cancel/close. HTML-escaped.
FILES TOUCHED:
  - scripts/ironsworn-controller.js               (+112 / -5, LOCKED — exceeds 50-line cap)
  - test/locate-objective.test.mjs                (+247 / -0, new test)
  - docs/ai-maintenance-log.md                    (append-only)
TESTS:        ADDED test/locate-objective.test.mjs — 42 passed, 0 failed
              (whitelist, _openSiteTracks filtering/order, no-site error, single-site
               auto, multi-site dialog choose + cancel, sheet trackRef path, triggerMove
               routing, vow/journey/combat regression). End-to-end simulated with a mocked
               system progress dialog (CONFIG.IRONSWORN…showForProgress).
SUITE:        GREEN — `npm test` = 22 files / all passed, 0 failed.
              Plus check-imports: PASS, load-smoke: PASS.
GATE:         APPROVED (recorded). User selected Option B and approved editing the 🔴 LOCKED
              scripts/ironsworn-controller.js, incl. exceeding the 50-line-per-file cap (+112
              net) for the resolution logic + selection dialog. Continuation of the
              feat/ai-discover-a-site branch. No settings/flags/i18n keys removed or renamed;
              all existing progress-move behaviour preserved.
ROLLBACK:     git revert <this commit-sha> — reverts the controller hunk and removes the test;
              the two moves return to their prior error state. No data migration involved.
RESIDUAL RISK: LOW. New behaviour fires only for the two named Delve moves. Site tracks reuse
              the existing trackKind:"delve" tag (no schema change). The dialog degrades
              DialogV2 → classic Dialog → null (clean abort). Foundry runtime not exercised
              headlessly (no Foundry in CI) — verified via the mocked-dialog unit suite +
              load-smoke + import check.



### [2026-06-11 20:55 EEST] — Fix RAG "Browser cache is not available" failure over HTTP
AGENT:        Abacus AI maintenance agent
TASK TYPE:    IMPLEMENT (bug fix)
TOKEN BUDGET: 10,000  |  USED: within budget  |  WITHIN BUDGET: YES

PRE-FLIGHT CHECKLIST (brief §3):
  [x] read engineering-brief.md + repository-map.md (prior context this session)
  [x] task classified — IMPLEMENT (Option A, user-approved)
  [x] target file(s)+line(s) located (evidence below)
  [x] <= 3 files / <= 50 changed lines per file — YES (1 code file, +13 net; 1 doc append)
  [x] additive & backwards-compatible — only relaxes an over-aggressive setting
  [x] no setting/flag/directive/i18n key removed or renamed
  [x] no architectural boundary crossed — change confined to browser-rag.js init()
  [x] regression test added/extended — full suite re-run (see TESTS); no new behaviour testable headlessly (browser-only `caches` global)
  [x] rollback plan defined

PROBLEM:      RAG semantic memory hard-fails on first use with
              "Browser cache is not available in this environment" when Foundry
              is served over plain HTTP on a non-localhost host. RAG then stays
              disabled for the whole session (_initFailed sticky).

EVIDENCE (brief §4 format):
  CLAIM:      browser-rag.js unconditionally opted into the Cache Storage API.
  EVIDENCE:   scripts/browser-rag.js:259 (pre-fix) :: init() set
              transformers.env.useBrowserCache = true with no guard.
  CONFIDENCE: HIGH
  BASIS:      read the line directly.

  CLAIM:      The Cache Storage API (`caches`) only exists in a secure context
              (HTTPS or localhost); over HTTP on a LAN/remote host it is
              undefined and transformers.js throws the observed error from
              within pipeline(), surfaced by the catch at line ~282.
  EVIDENCE:   scripts/browser-rag.js:264 (pipeline) → catch at :281-282.
  CONFIDENCE: HIGH
  BASIS:      MDN secure-context requirement for CacheStorage; matches the
              exact thrown message text.

CHANGE:       Gated `useBrowserCache` on `typeof caches !== "undefined"`,
              mirroring the module's existing IndexedDB guard
              (VectorStore.supported()). When the cache exists → enable it and
              log an info line; when absent → set it false and warn that RAG is
              using an in-memory fallback (model re-downloads each session) with
              a hint to serve over HTTPS/localhost for persistence. RAG now
              works in all contexts instead of hard-failing on HTTP.
FILES TOUCHED (<= 3):
  - scripts/browser-rag.js          (+13 / -1, init() cache guard + logging)
  - docs/ai-maintenance-log.md      (append-only)
TESTS:        No new test file — the trigger is the browser-only `caches`
              global, which is not present in the framework-free Node runner
              (Node has no `caches`, so the fallback branch is what executes
              under test; the secure-context branch cannot be exercised
              headlessly without a browser). Verified instead via:
SUITE:        GREEN — `npm test` = 22 files / all passed, 0 failed.
              node --check scripts/browser-rag.js: PASS.
              check-imports: PASS.  load-smoke: PASS (browser-rag.js imports cleanly).
GATE:         None required — single non-LOCKED file, +13 net (under the 50-line
              cap), additive and backwards-compatible. Option A approved by user.
ROLLBACK:     git revert <this commit-sha> — restores the unconditional
              useBrowserCache = true. No data/schema migration involved.
RESIDUAL RISK: LOW. The change only relaxes an over-aggressive setting: the
              HTTPS/localhost path is unchanged (caches exists → still true). In
              insecure contexts the ~90 MB model re-downloads per session
              (slower first query, more bandwidth) but RAG functions instead of
              failing. Does not address unrelated load failures (CDN blocked by
              CSP/offline) — those remain graceful soft-fails by design.



### [2026-06-11 21:10 EEST] — Release: bump version to 0.12.0
AGENT:        Abacus AI maintenance agent
TASK TYPE:    CHORE (version bump / release)
TOKEN BUDGET: 10,000  |  USED: within budget  |  WITHIN BUDGET: YES

PRE-FLIGHT CHECKLIST (brief §3):
  [x] task classified — CHORE (metadata/release only; no behaviour change)
  [x] target file(s) located (module.json, package.json, CHANGELOG.md)
  [x] <= 3 code/config files changed — YES (module.json, package.json, CHANGELOG.md; + this log)
  [x] additive & backwards-compatible — version metadata only
  [x] no setting/flag/directive/i18n key removed or renamed
  [x] no architectural boundary crossed — no LOCKED source edited
  [x] regression test — N/A (no executable behaviour changed); full suite re-run anyway
  [x] rollback plan defined

REASON:       The feat/ai-discover-a-site branch added two new features and one
              fix that were never versioned. MINOR bump per SemVer (new features,
              backwards-compatible): 0.11.3 -> 0.12.0.

CHANGE:
  - module.json:  version 0.11.3 -> 0.12.0; prepended a v0.12.0 changelog
                  paragraph to the (HTML) description.
  - package.json: version 0.10.38 -> 0.12.0 (was lagging; now in sync with
                  module.json, the authoritative Foundry version).
  - CHANGELOG.md: added a Keep-a-Changelog [0.12.0] entry (Added: Discover a
                  Site + Locate Your Objective / Escape the Depths; Fixed: RAG
                  browser-cache guard) plus a link reference.
  - download/manifest URLs unchanged (they target the `main` branch, not a
    version-pinned path, so no edit needed).

FILES TOUCHED (<= 3 + log):
  - module.json                     (version + description)
  - package.json                    (version)
  - CHANGELOG.md                    (0.12.0 entry + link ref)
  - docs/ai-maintenance-log.md      (append-only)
SUITE:        GREEN — `npm test` = 22 files / all passed, 0 failed.
              module.json + package.json validated as well-formed JSON; versions
              confirmed in sync (0.12.0).
GATE:         None required — release metadata only, no LOCKED source touched,
              no behaviour change.
RELEASE:      Tagged v0.12.0 (annotated) and pushed with the commit to
              origin/feat/ai-discover-a-site.
ROLLBACK:     git revert <this commit-sha> and delete tag v0.12.0
              (git tag -d v0.12.0 && git push origin :refs/tags/v0.12.0).
RESIDUAL RISK: NONE for behaviour. Note: package.json jumped 0.10.38 -> 0.12.0 to
              re-sync with module.json; the gap reflects that package.json had
              not been bumped in step with recent module.json releases.
