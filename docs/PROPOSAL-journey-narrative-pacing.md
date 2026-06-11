# Proposal — Narrative Pacing Guidance for *Undertake a Journey*

**Module:** The Eternal Skald (`the-eternal-skald`) · **Target version:** v0.12.x → v0.12.1 (additive)
**Author:** Repository review (foundry-repository-steward)
**Status:** Awaiting approval — patches are written and ready to apply.

---

## 1. Current State — where the journey mechanics live

The journey system is spread across four well-separated layers. The table below
is the result of tracing every `journey` / `Reach Your Destination` reference in
`scripts/`.

| Concern (from the brief) | File | Symbol / lines | What it does today |
|---|---|---|---|
| **1. Journey rolls made/displayed** | `scripts/ironsworn-controller.js` | `MOVE_CATALOGUE` rows L94–95; `MOVE_SUMMARIES` L161–162; `rollProgressMove()` L2246+ | `Undertake a Journey` (+wits) opens the system roll dialog; `Reach Your Destination` rolls the **progress score** (filled boxes) via `IronswornPrerollDialog.showForProgress`. |
| **1b. Auto-narration of a resolved roll** | `scripts/narrative/integration.js` | `_narrateOutcome()` L1542–1626 | Builds the post-roll prompt. The key seam is `autoLine` (L1566–1568): the deterministic mechanical summary is fed to the AI as *"Mechanical effects ALREADY applied…"*. **This is the highest-leverage injection point.** |
| **2. Progress tracked** | `scripts/narrative/integration.js` | `_autoJourneyFlow()` L2142–2209 | On `Undertake a Journey`: opens a journey track if none open, and on a **hit** marks progress by rank, auto-completing at 10/10. **On a miss it does nothing** (no note, no guidance). |
| | `scripts/ironsworn-controller.js` | `markProgressByRank()` L1757; `setProgress()` L1776; progress gate L2342–2365 | Marks progress; gates `Reach Your Destination` behind `journeyMinProgressBoxes` (default 4). Returns `{ ok, track, boxes, current }`. |
| **3. Result descriptions shown** | `scripts/narrative/integration.js` | `_autoCompletionFlow()` L1728–1792 | `Reach Your Destination`: **strong** = auto-complete; **weak/miss** = returns a guidance note and *keeps the track open* (L1762–1768). |
| | `scripts/ai/prompt-builder.js` | "PROGRESS MOVES" block L327–345; journey automation note L538–542 | Static system-prompt guidance the AI follows when narrating. |
| | `scripts/ironsworn-data.js` | `Undertake a Journey` L237–241; `Reach Your Destination` L242–246 | Player-facing move summaries (the in-module reference). |
| **4. Progress-% opportunities (UI)** | `scripts/chat/commands.js` | `!progress` `listOpenJourneys()` L222–245; mark-result card L286–290 | Lists open journeys as `X/10 boxes`. No percentage, no pacing hint. |
| | `scripts/narrative/integration.js` | `_notifyProgress()` L1175–1177 | Toast: `progress on <track> — X/10 boxes`. |

### Data available at every seam
`markProgressByRank()` returns `boxes` (0–10 filled). **Progress % = `boxes * 10`.**
This single number is all that is needed to drive contextual pacing guidance, and
it is already in scope at every location we want to patch — **no new data model,
no new API, no new dependency.**

---

## 2. Issue / Opportunity

**Problem:** The fiction reaches the destination before the progress track fills
(arriving at 2/10). Root cause is *narrative*, not mechanical: nothing tells the
AI/GM how far along the track is, so it narrates arrival whenever the prose feels
ready. The mechanics are already RAW-correct (progress by rank, progress-roll
gate, `Reach Your Destination` rolls the score).

**Opportunity:** The module already funnels a deterministic *"effects already
applied"* note into the narration prompt (`autoLine`). By appending **progress-%-
aware pacing guidance** to that note — and by handling the **miss** case that is
currently silent — we keep the fiction aligned with the track **without changing
a single rule**. All proposed changes are additive guidance strings.

---

## 3. Risk Assessment

| Change | Risk | Mitigation |
|---|---|---|
| Append pacing text to `autoSummary` (Patch 1) | **Very low** — adds words to an existing prompt note; no mechanical effect | Pure string; behind no new branch that can throw (guarded) |
| Add miss-branch note in `_autoJourneyFlow` (Patch 2) | **Very low** — currently the miss path returns only the "opened" note; we add a string | No progress is marked (RAW: a miss marks none) — unchanged |
| Static prompt guidance (Patch 3) | **Very low** — additive lines in system prompt | Wording only; AI already reads this block |
| `!progress` % + hint, toast % (Patch 4) | **Very low** — presentation only | Clamped, defensive |
| **Reach-Your-Destination weak/miss framing (Patch 5)** | **Low–Medium — behavioural nuance** | **Flagged separately; see §6. Requires approval — it changes how arrival is described.** |

No approval-gate items are triggered by Patches 1–4 (no deps, no schema, no
sockets, no public-API change). Patch 5 is called out separately because it
touches result *framing* and is the one item that benefits from a deliberate
decision.

---

## 4. Proposed Solution — concrete patches (Patches 1–4, minimal & additive)

### Patch 1 + 2 — `scripts/narrative/integration.js` · `_autoJourneyFlow()`

Add one small helper and wire pacing guidance into both the **hit** and the
(currently silent) **miss** path. This is the core fix.

**1a. Add the helper** (place it just above `_autoJourneyFlow`, near L2141):

```js
  /**
   * (v0.12.1 — narrative pacing) Build progress-%-aware pacing guidance for the
   * journey narration prompt. Keeps the fiction aligned with the track so the
   * Skald never describes ARRIVING before the journey is nearly charted. Pure
   * advisory text — no mechanical effect. RAW-faithful: arrival is resolved only
   * by the "Reach Your Destination" progress roll.
   * @param {number} boxes filled progress boxes (0–10)
   * @returns {string} a guidance clause for the autoSummary
   */
  _journeyPacingNote(boxes) {
    const b   = Math.max(0, Math.min(10, Number(boxes) || 0));
    const pct = b * 10;
    const at  = `(${b}/10, ${pct}%)`;
    if (b <= 3) {
      return `PACING ${at}: the journey has only just begun — narrate an early leg or first complication. ` +
             `Treat this waypoint as a DRAMATIC BEAT (a hardship, choice, or discovery), NOT a geographic milestone. ` +
             `Do NOT describe arriving at — or even sighting — the destination yet.`;
    }
    if (b <= 6) {
      return `PACING ${at}: the journey is well underway — escalate the stakes mid-trek. ` +
             `This waypoint is a dramatic complication, not the destination. ` +
             `The party is still far from arrival; do NOT describe reaching the destination.`;
    }
    if (b <= 8) {
      return `PACING ${at}: the journey nears its end — you MAY foreshadow the destination on the horizon, ` +
             `but the party has NOT arrived. Arrival is resolved only by the "Reach Your Destination" roll.`;
    }
    return `PACING ${at}: the journey is all but charted — the destination is in sight. ` +
           `Do NOT auto-narrate the arrival; instead prompt the player to roll "Reach Your Destination" ` +
           `to resolve HOW the arrival goes.`;
  },
```

**1b. Wire it into the hit path** — replace the `if (track && hit) { … }` block
(L2196–2207) with one that appends the pacing note and adds an explicit miss
branch:

```js
    // On a hit, mark progress on the (now open) journey by its rank.
    if (track && hit) {
      const pr = await IronswornController.markProgressByRank(actor, track.id);
      if (pr?.ok) {
        this._notifyProgress(pr.track, pr.boxes);
        notes.push(`advanced ${pr.track} (now ${pr.boxes}/10 boxes)`);
        // (v0.12.1) Progress-aware narrative pacing so the fiction stays aligned
        // with the track and never "arrives" before the journey is nearly full.
        notes.push(this._journeyPacingNote(pr.boxes));
        // (fix — journey completion) A journey at full progress (10/10) is
        // finished; close it deterministically so later journeys don't reuse it.
        const done = await this._autoCompleteIfFull(actor, track.id, "journey");
        if (done) notes.push(`reached destination “${pr.track}” (10/10 — auto-completed)`);
      }
    } else if (track && !hit) {
      // (v0.12.1) MISS on "Undertake a Journey" — RAW: mark NO progress. The
      // party is stuck until an obstacle is resolved. Steer the narration to a
      // complication that must be overcome (a side-challenge, Pay the Price, or
      // a fresh Face Danger) rather than quietly advancing toward the goal.
      const cur   = Number(foundry.utils.getProperty(track, "system.current") ?? 0);
      const boxes = Math.max(0, Math.min(10, Math.floor(cur / 4)));
      notes.push(
        `MISS on the journey "${track.name}" (${boxes}/10, ${boxes * 10}%) — NO progress marked. ` +
        `The party is HALTED by an obstacle; narrate a complication or cost they must resolve ` +
        `(e.g. Pay the Price, Face Danger, or a short side-challenge) before they can travel on. ` +
        `Do NOT advance toward the destination this turn.`
      );
    }
    return notes.join("; ");
```

*Effect:* every journey turn now feeds the AI a clear, progress-anchored
instruction. The note flows through `autoSummary` → `autoLine` (L1566) into the
narration prompt automatically — no other plumbing required.

---

### Patch 3 — `scripts/ai/prompt-builder.js` · PROGRESS MOVES block (after L338)

Add a short, permanent RAW-pacing doctrine so the guidance holds even on turns
where no auto-note is present (e.g. manual narration):

```text
• JOURNEY PACING (keep the fiction aligned with the progress track):
  – A journey's waypoints are DRAMATIC BEATS — hardships, choices, discoveries —
    NOT evenly-spaced geographic milestones. Each "Undertake a Journey" roll is
    one such beat.
  – Do NOT describe ARRIVING at (or sighting) the destination until the journey's
    progress is high (roughly ≥ 7/10 boxes). Arrival itself is resolved ONLY by
    the "Reach Your Destination" progress roll — never narrate arrival on an
    "Undertake a Journey" result.
  – Strong hit = a segment passes smoothly (mark progress). Weak hit = progress,
    but at a cost/complication. Miss = the party is stuck until an obstacle is
    resolved — mark NO progress and narrate the obstacle.
  – "Reach Your Destination" decides HOW the arrival goes, not WHETHER you arrive.
```

---

### Patch 4 — UI progress-% surfacing

**4a. `scripts/chat/commands.js` · `listOpenJourneys()` (L234–238)** — show a
percentage and a one-line pacing hint per journey:

```js
      const rows = journeys.map(j => {
        const boxes = Math.max(0, Math.min(10, Number(j.boxes) || 0));
        const pct   = boxes * 10;
        const rank  = j.rank ? ` <em>(${escapeHtml(String(j.rank))})</em>` : "";
        const hint  = boxes >= 7
          ? "destination near — ready to <code>!Reach Your Destination</code>"
          : boxes >= 4
            ? "well underway"
            : "just begun — waypoints are dramatic beats, not the destination";
        return `<tr><td>${escapeHtml(j.name || "The Journey")}${rank}</td>` +
               `<td>${boxes}/10 (${pct}%)</td><td class="es-help-aside">${hint}</td></tr>`;
      }).join("");
```

**4b. `scripts/narrative/integration.js` · `_notifyProgress()` (L1175–1177)** —
include the percentage in the toast (presentation only):

```js
  _notifyProgress(trackName, boxes) {
    const b = Math.max(0, Math.min(10, Number(boxes) || 0));
    try { ui.notifications?.info(`${SKALD_NAME}: progress on ${trackName} — ${b}/10 boxes (${b * 10}%).`); } catch (_) {}
    this._dbg(`notify: progress on ${trackName} → ${b}/10 (${b * 10}%)`);
  }
```

---

## 5. Optional polish — progress-gate message (low priority)

`scripts/ironsworn-controller.js` L2356–2364 already blocks a premature
`Reach Your Destination` and explains why. One added sentence reinforces the
pacing model (purely the error string — no logic change):

```js
               `Mark more progress (e.g. "Undertake a Journey" or !progress <boxes>) first, ` +
               `then make the progress roll once you arrive. Treat each leg as a dramatic beat — ` +
               `the destination should not be described until the track is nearly full.`
```

---

## 6. Separate decision — *Reach Your Destination* weak/miss framing (needs approval)

**Current behaviour** (`_autoCompletionFlow`, L1762–1768): on a **weak hit or
miss** the journey track is **kept open** and narrated as *"not yet finished."*

**RAW nuance:** In Ironsworn, `Reach Your Destination` resolves HOW the arrival
goes — on a **strong** and **weak** hit you *do* arrive (weak = with a
complication); a **miss** is the only ambiguous outcome (arrive to an unwelcome
surprise, or Pay the Price). The current "weak hit keeps the track open" wording
can read as "you didn't arrive," which is the inverse of the stated problem.

**Recommendation (for approval, not bundled into Patches 1–4):** keep the track
*open* behaviour as-is (it is the module's established lifecycle and changing
completion is a behavioural change per the steward approval gate), but **adjust
only the guidance string** so the AI frames a weak hit as *"you arrive, but…"*
rather than *"you have not arrived":*

```js
    if (!strong) {
      const label = kind === "combat" ? "fight" : kind;
      const name  = target?.name ? ` “${target.name}”` : "";
      if (kind === "journey") {
        return weak
          ? `journey${name}: you ARRIVE, but at a cost — narrate the arrival AND an unforeseen ` +
            `hardship/complication that greets you; the track stays open for the GM to resolve the cost`
          : `journey${name}: the arrival goes badly — narrate reaching the destination INTO an ` +
            `unwelcome surprise (or Pay the Price); the track stays open to resolve the fallout`;
      }
      return weak
        ? `${label}${name} NOT yet finished (weak hit) — narrate partial success at a cost; the track stays open`
        : `${label}${name} NOT finished (miss) — narrate a serious setback/complication; the track stays open`;
    }
```

This is the single item where I recommend an explicit yes/no before applying.

---

## 7. Testing Strategy

The repo has a `test/` harness (regression tests referenced throughout the
CHANGELOG). Proposed coverage:

1. **`_journeyPacingNote(boxes)` unit test** — assert the four bands
   (0–3 / 4–6 / 7–8 / 9–10) each emit the expected keyword (`only just begun`,
   `well underway`, `nears its end`, `all but charted`) and the correct `%`.
2. **`_autoJourneyFlow` integration test** —
   - strong/weak hit at low boxes → `autoSummary` contains a `PACING` clause and
     "do NOT describe arriving";
   - **miss** → `autoSummary` contains `MISS … NO progress marked` and no progress
     was written to the track (`system.current` unchanged).
3. **Prompt assembly test** — `buildSystemPrompt` output contains the new
   "JOURNEY PACING" doctrine lines.
4. **Manual Foundry smoke test** — roll `Undertake a Journey` from 0→10 and
   confirm the toast shows `%`, `!progress` lists `%` + hint, and the narration
   no longer announces arrival before ~7/10.

## 8. Migration Path

None required. All of Patches 1–4 are **purely additive** (new helper, new
guidance strings, richer presentation). No settings, flags, data model, or saved
data change; existing worlds and in-flight journeys are unaffected. Patch 6 (if
approved) only edits guidance text, not lifecycle.
