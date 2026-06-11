# INVESTIGATION — "Discover a Site" & "Locate Your Objective" fail to resolve

> **Task type:** `INVESTIGATE` (budget 10,000 tokens). **No code changed.**
> Brief + repository-map read in full first (per §3). All claims carry §4 evidence.
> Repo: `papicy/the_eternal_skald` @ `2c2cdde`.

---

## 1. Findings (evidence from code inspection)

The exact user-facing error lives in the rules bridge and is produced as the **final
fall-through** of `triggerMove()`:

```
CLAIM:      The verbatim error the user sees is emitted by triggerMove() as its last resort.
EVIDENCE:   scripts/ironsworn-controller.js:1384-1389 :: triggerMove
CONFIDENCE: HIGH
BASIS:      read the lines directly — `Could not trigger "${...}" automatically (no dialog and no rollable stat). Resolve it manually on the sheet.`
```
```
CLAIM:      That error string is wrapped as "The dice would not answer: …" when surfaced to chat.
EVIDENCE:   scripts/narrative/integration.js:681 and :839 :: (chat render of res.error)
CONFIDENCE: HIGH
BASIS:      read both lines — they interpolate `res?.error` into "<strong>The dice would not answer:</strong>".
```

`triggerMove()` routes a move through four gates, in order:

```
CLAIM:      triggerMove tries, in order: (0) progress-move route, (0b) milestone route,
            (1) system pre-roll dialog, (2) manual stat action-roll, (3) the error.
EVIDENCE:   scripts/ironsworn-controller.js:1341-1390 :: triggerMove
CONFIDENCE: HIGH
BASIS:      read the function body in full.
```

The progress-move gate uses a **hard-coded whitelist of exactly three moves**:

```
CLAIM:      _isProgressMove() only recognises fulfill_your_vow, reach_your_destination, end_the_fight.
EVIDENCE:   scripts/ironsworn-controller.js:2034-2039 :: _isProgressMove
CONFIDENCE: HIGH
BASIS:      read it — regex `/(fulfill_your_vow|reach_your_destination|end_the_fight)$/` plus the same three names.
```

The milestone gate only matches `reach_a_milestone`:

```
CLAIM:      _isMilestoneMove() only recognises reach_a_milestone.
EVIDENCE:   scripts/ironsworn-controller.js:2045-2050 :: _isMilestoneMove
CONFIDENCE: HIGH
BASIS:      read it — regex `/reach_a_milestone$/` plus name "reach a milestone".
```

The manual action-roll fallback explicitly **excludes** `progress` (and `supply`) stats:

```
CLAIM:      Gate 2 only fires when the move has a real stat — it skips stat==="progress" and "" (empty).
EVIDENCE:   scripts/ironsworn-controller.js:1379-1382 :: triggerMove
CONFIDENCE: HIGH
BASIS:      read it — `const stat = (opts.stat || move?.stats?.[0] || "").toLowerCase();`
            then `if (stat && stat !== "progress" && stat !== "supply") return this.manualMoveRoll(...)`.
```

The move catalog defines the two failing moves precisely as a no-roll move and a progress move:

```
CLAIM:      "Discover a Site" has stats:[] (no rollable stat); "Locate Your Objective" has stats:["progress"].
EVIDENCE:   scripts/ironsworn-controller.js:126 and :130 :: MOVE catalog
CONFIDENCE: HIGH
BASIS:      read both rows directly.
```
```
CLAIM:      The data layer corroborates: Discover a Site stat "—", Locate Your Objective is a progress-vs-challenge roll.
EVIDENCE:   scripts/ironsworn-data.js:335-349 :: move summaries
CONFIDENCE: HIGH
BASIS:      read both entries — Discover a Site stat "—"; Locate Your Objective "roll progress vs. challenge dice".
```

---

## 2. Root Cause (verified, not speculation)

Both moves dead-end at the `triggerMove()` final error because **neither has a stat to roll
and neither is recognised by the progress/milestone routers**:

- **"Locate Your Objective"** (`move:delve/delve/locate_your_objective`, `stats:["progress"]`)
  is a genuine **progress roll** (roll the site's progress score vs. the challenge dice).
  But `_isProgressMove()` (controller:2034-2039) whitelists only `fulfill_your_vow`,
  `reach_your_destination`, and `end_the_fight` — so the progress route at controller:1355-1357
  is **never taken** for it. It then falls past the milestone gate, the system dialog (which
  rejects a progress move that has no rollable stat — see §3), and the manual-roll gate
  (skipped because `stat === "progress"`, controller:1380), landing on the error.

- **"Discover a Site"** (`move:delve/delve/discover_a_site`, `stats:[]`) is a **no-roll move**
  (choose theme/domain from the oracle and assign a rank). It is not a progress move, not a
  milestone move, and has no stat (`stats[0]` is `undefined` → `stat === ""`, falsy at
  controller:1380), so every gate is skipped and it falls straight to the error.

**In one sentence:** the Delve progress move *Locate Your Objective* (and, by the same logic,
*Escape the Depths*, controller:131) is **missing from the `_isProgressMove` whitelist**, and the
no-roll move *Discover a Site* has **no dedicated handler at all** — so both fall through
`triggerMove()` to the catch-all "no dialog and no rollable stat" error.

```
CLAIM:      "Escape the Depths" (stats:["progress"]) shares the identical defect and would hit the same error.
EVIDENCE:   scripts/ironsworn-controller.js:131 :: MOVE catalog (stats:["progress"]) vs 2034-2039 (whitelist excludes it)
CONFIDENCE: HIGH
BASIS:      compared the catalog row against the whitelist regex/name set directly.
```

### 2a. Secondary gap (relevant to any future fix)
Even if `_isProgressMove` were widened to include these moves, `rollProgressMove()` would still
fail them, because its `kind` resolver only understands `journey | vow | combat`:

```
CLAIM:      rollProgressMove() only derives kind for reach_your_destination/fulfill_your_vow/end_the_fight;
            anything else yields kind=null and, absent an explicit trackRef, errors with "No open … track".
EVIDENCE:   scripts/ironsworn-controller.js:2156-2192 :: rollProgressMove
CONFIDENCE: HIGH
BASIS:      read the kind ternary (2165-2168) and the `if (!track) … error` branch (2183-2192).
```
A Delve site progress roll is against the **site's** progress track (a "site"/delve kind),
which this function has no concept of. So a complete fix touches **both** the router and the
track-kind resolution — not just the whitelist.

---

## 3. Execution Path (where the failure occurs)

```
AI/inline link or doTriggerMove()
  → triggerMove(moveRef)                                   controller:1341
      → _resolveMove → dataswornId                          controller:1342-1343
      → _isProgressMove(dsid,name)?  ── NO (not in whitelist) controller:1355  (2034-2039)
      → _isMilestoneMove(dsid,name)? ── NO                   controller:1363  (2045-2050)
      → hasPrerollDialog() && dataswornId?
            → IronswornPrerollDialog.showForOfficialMove(id) controller:1368-1370
              ↳ system REJECTS: progress move / no rollable stat → catch + warn → fall through  controller:1372-1374
      → manual action roll?  stat = move.stats[0]
            Locate Your Objective: stat="progress" → guard false → SKIP   controller:1380
            Discover a Site:       stat=""         → guard false → SKIP   controller:1380
  → return { ok:false, method:"none", error:"…no dialog and no rollable stat…" }   controller:1384-1389
  → integration.js renders "The dice would not answer: …"   integration.js:681 / 839
```

---

## 4. Comparison — why working moves (Strike / Clash) succeed

```
CLAIM:      Strike and Clash carry real stats (iron/edge), so the manual action-roll gate fires.
EVIDENCE:   scripts/ironsworn-controller.js:98-99 :: MOVE catalog (Strike/Clash stats:["iron","edge"])
CONFIDENCE: HIGH
BASIS:      read both rows.
```

| Aspect | Strike / Clash (work) | Locate Your Objective (fails) | Discover a Site (fails) |
|---|---|---|---|
| Catalog `stats` | `["iron","edge"]` | `["progress"]` | `[]` |
| Move nature | Action roll vs. stat | Progress roll vs. site track | No roll (oracle pick + rank) |
| `_isProgressMove`? | no (doesn't need it) | **no — but should be yes** | no (correct) |
| System dialog | succeeds (rollable stat) | rejects (no rollable stat) | rejects (no options) |
| Manual-roll gate (1380) | **fires** (`stat="iron"`) | skipped (`stat="progress"`) | skipped (`stat=""`) |
| Outcome | Rolls, posts chat card ✅ | Falls to error ❌ | Falls to error ❌ |

For Strike/Clash the path is: progress?no → milestone?no → dialog (succeeds) **or** manual
roll with `iron`/`edge` → chat card. The single thing the failing moves lack is a route that
does **not** depend on a rollable character stat.

---

## 5. Minimal Plan — smallest safe fix (OUTLINE ONLY, not implemented)

Goal: give the two Delve moves a correct route without touching action-roll behaviour. This
is conceptual only; both target functions live in a 🔴 **LOCKED** file
(`ironsworn-controller.js`), so any actual edit **REQUIRES an approval gate** (brief §6,
repository-map §5). Options, smallest first:

1. **Locate Your Objective / Escape the Depths (progress moves):**
   - Extend the progress-move classifier to recognise the Delve progress moves
     (add `locate_your_objective` / `escape_the_depths` IDs + names to
     `_isProgressMove`, controller:2034-2039), **and**
   - Teach `rollProgressMove()` a `"site"`/delve kind so it can resolve the **site's** progress
     track (controller:2162-2192), rather than only vow/journey/combat. Without the second
     change the move would only move the error from "no rollable stat" to "no open … track".

2. **Discover a Site (no-roll move):**
   - Add a no-roll handler (sibling to `_isMilestoneMove`/`_executeMilestone`,
     controller:2045-2056) that, instead of attempting a roll, posts the move text / prompts
     the player to choose theme + domain from the oracle and set a rank — i.e. resolve it
     narratively rather than mechanically. Returning `{ok:true, method:"manual"}` here avoids
     the misleading "dice would not answer" framing for a move that legitimately has no dice.

3. **Cheapest stop-gap (if a full fix is gated):** replace the generic catch-all error text at
   controller:1384-1389 with move-aware guidance (e.g. "This is a progress/oracle move — resolve
   it from the site sheet"), so the user is directed correctly even before the routing is fixed.

All three are **additive** and behind existing routing; none removes a setting, command, or
directive. Per brief §3/§8 each would also need a regression test under `test/*.test.mjs`.

---

## 6. Risks — what could break with a change here

- **🔴 LOCKED file.** `ironsworn-controller.js` is LOCKED (repository-map §2); even a one-line
  edit needs a recorded approval gate. Read-with-ranges was honoured here; editing is not
  permitted under an INVESTIGATE task.
- **Track-context ambiguity.** A Delve progress roll needs the *correct* site progress track.
  If `rollProgressMove` guesses the wrong track (it currently falls back to "newest open track
  of kind", controller:2182), the player could roll against the wrong progress — a silent
  correctness bug. The fix must define how the active site/track is resolved and handle the
  "no site track" case explicitly.
- **`_lastProgressTrack` side-effect.** `rollProgressMove` records `_lastProgressTrack`
  (controller:2198-2204), which feeds `completeTrackSmart`/`resolveCompletionTrack`
  (controller:2003-2025). Routing new move types through it could mis-point later completion
  directives at a site track. Audit that interaction.
- **Player-agency invariant (brief §1.1 #3).** Discover a Site must not auto-pick theme/domain
  or auto-assign rank; the handler must *prompt*, not decide, or it violates "player agency is
  sacred."
- **Journey progress gate.** `rollProgressMove` enforces a minimum-progress gate for journeys
  (controller:2210-2230). Adding a "site" kind must decide whether that gate applies; applying
  it unintentionally would block legitimate site rolls.
- **Regression-test requirement (brief §7/§8).** Any change is "incomplete" without a
  `test/*.test.mjs` exercising it and a 100%-green `npm test`.
```
