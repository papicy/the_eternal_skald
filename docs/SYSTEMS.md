# Adding a Game-System Adapter

*Developer guide for The Eternal Skald's multi-system architecture (v0.17.0+).*

The Eternal Skald drives any Foundry game system through a thin **system-adapter**
layer. The agnostic core — chronicle, semantic memory/RAG, map vision, chat
commands and narration — never touches a system's data model directly; it talks
only to the **active adapter**. This guide explains the contract and walks you
through adding support for a new system.

> Background & rationale: [PROPOSAL-multi-system-adapter-architecture.md](PROPOSAL-multi-system-adapter-architecture.md).

---

## The big picture

```
            ┌─────────────────────────────────────────────┐
   active   │  SystemRegistry  (scripts/systems/registry.js)│
   system ─►│  id → adapter      getActive() → adapter      │
            └───────────────┬─────────────────────────────┘
                            │ getActiveAdapter()  (never null)
                            ▼
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │ IronswornCtrl│   │ NimbleAdapter│   │  NullAdapter │
   │  (full)      │   │  (read-only) │   │  (fallback)  │
   └──────────────┘   └──────────────┘   └──────────────┘
        ▲ every consumer calls adapter.capabilities() and
          feature-detects optional methods before using them.
```

- **One contract, many adapters.** Each adapter implements the
  `SystemAdapter` shape defined in
  [`scripts/systems/adapter-interface.js`](../scripts/systems/adapter-interface.js).
- **The registry is the lookup.**
  [`scripts/systems/registry.js`](../scripts/systems/registry.js) maps a Foundry
  `game.system.id` to an adapter and resolves the active one.
- **`getActiveAdapter()` never returns `null`.** When no adapter is registered
  for the active system, the registry returns the **`NullAdapter`** so callers
  can always invoke the contract methods without a null check.

---

## The `SystemAdapter` contract

An adapter is a **plain object (or class instance)** — `IronswornController` and
`NimbleAdapter` are both fine. Only **two methods are required**; everything else
is optional and feature-detected by callers.

### Required (identity & capability)

| Member | Type | Purpose |
|---|---|---|
| `id` | `string` | The Foundry `game.system.id` this adapter serves (e.g. `"nimble"`). |
| `label` | `string` | Human-readable system name. |
| `isActive()` | `() => boolean` | `true` iff this adapter's system is the active game system. |
| `capabilities()` | `() => Record<string, boolean>` | A capability map (see below). |

The registry rejects anything that doesn't at least provide `isActive()` and
`capabilities()` (see `isValidAdapter()` in `adapter-interface.js`).

### Capabilities

`capabilities()` returns an object whose keys are drawn from the frozen
`SYSTEM_CAPABILITIES` set and whose values are booleans. Start from
`emptyCapabilities()` (every key present, all `false`) and flip on what you
support — this guarantees every key is always present.

```js
import { emptyCapabilities } from "./adapter-interface.js";

capabilities() {
  const caps = emptyCapabilities(false);
  caps.systemActive   = this.isActive();
  caps.characterReads = true;   // I can read stats / meters
  caps.mapVision      = true;   // core, system-independent Skald feature
  return caps;
}
```

The available keys (from `SYSTEM_CAPABILITIES`):

`systemActive`, `characterReads`, `sheetWrites`, `progressTracks`, `vows`,
`oracles`, `momentum`, `impacts`, `moves`, `moveDialogs`, `xp`,
`compendiumFoes`, `compendiumAssets`, `createCharacter`, `mapVision`.

Consumers gate every system-specific feature on these flags, so a system that
lacks a concept (Nimble has no oracles, vows or progress tracks) simply leaves
the flag `false` and the feature is silently omitted — no errors, no empty UI.

### Optional methods

Everything below is optional. **Callers must feature-detect**
(`typeof adapter.fn === "function"`) and/or consult `capabilities()` before
invoking. Implement only what your system genuinely supports.

| Group | Methods |
|---|---|
| Character & state reads | `getActiveCharacter()`, `getStats(actor)`, `getMeters(actor)`, `describeCharacter(actor)` |
| Prompt profile (AI flavour) | `getPromptProfile()` → `{ persona, rulesDigest, moveList, terminology, oracleGuidance }` |
| Mechanical writes | `adjustResource(a, key, delta)`, `applyHarm(a, n)`, `applyStress(a, n)`, `setStat(a, stat, v)`, `setImpact(a, cond, on)` |
| Progress / objectives | `markProgress`, `setProgress`, `createProgressTrack`, `completeTrack`, `grantXp` |
| Moves / oracles | `triggerMove(ref, opts)` → `Promise`, `rollOracle(name)` |
| Compendium creation | `createFoeActor`, `addAssetToActor`, `createCharacter` |

### Three iron rules

1. **Reads MUST NOT throw.** Return `null` / `[]` / `{}` / `""` on failure so the
   AI context builder can simply omit missing data. Systems publish no stable
   developer API, so probe `actor.system.*` defensively.
2. **Writes MUST be GM-gated, bounds-checked and idempotent**, and MUST return a
   **result object**. Use the helpers from `adapter-interface.js`:
   - `makeResult({ ...extra })` → `{ ok: true, ...extra }` on success.
   - `unsupported(reason)` → `{ ok: false, unsupported: true, error }` for an
     operation your system doesn't have. Callers treat it as a soft skip.
3. **Capability-gate, don't guess.** If a concept doesn't exist in your system,
   leave its capability `false` and return `unsupported()` rather than emulating
   it.

---

## Reference adapters

| Adapter | File | Style |
|---|---|---|
| `IronswornController` | `scripts/ironsworn-controller.js` | **Full** — reads, moves, oracles, progress tracks, mechanical writes, compendium foes. The canonical "everything on" example. |
| `NimbleAdapter` | `scripts/systems/nimble-adapter.js` | **Read-only** — reads STR/DEX/INT/WIL + HP/Wounds/Mana/Hit Dice; `characterReads` + `mapVision` only; all writes `unsupported()`. The best template for a new read-focused adapter. |
| `NullAdapter` | `scripts/systems/null-adapter.js` | **No-op fallback** — every read empty, every write `unsupported()`, only `mapVision` on. Shows the minimum safe shape. |

If you want the Skald to *read* characters on a new system, copy
`NimbleAdapter` and adjust the data paths. If you also want it to *drive*
mechanics, study `IronswornController` for the write/gating patterns.

---

## Step-by-step: add a new adapter

### 1. Create the adapter file

`scripts/systems/<your-system>-adapter.js`:

```js
import { emptyCapabilities, makeResult, unsupported } from "./adapter-interface.js";

const SYSTEM_ID = "my-system";   // your Foundry game.system.id

export const MySystemAdapter = Object.freeze({
  id: SYSTEM_ID,
  label: "My System",

  isActive() {
    try { return game?.system?.id === SYSTEM_ID; } catch (_) { return false; }
  },

  capabilities() {
    const caps = emptyCapabilities(false);
    caps.systemActive   = this.isActive();
    caps.characterReads = true;
    caps.mapVision      = true;
    return caps;
  },

  getActiveCharacter() {
    try {
      return canvas?.tokens?.controlled?.[0]?.actor
          ?? game?.user?.character
          ?? null;
    } catch (_) { return null; }
  },

  describeCharacter(actor) {
    const a = actor ?? this.getActiveCharacter();
    if (!a) return "";
    // Build a prompt-ready summary from a.system.* — never throw.
    return `…`;
  }

  // Add optional write methods only if your system supports them;
  // return makeResult({...}) on success or unsupported("reason") otherwise.
});

export default MySystemAdapter;
```

The adapter has **no Foundry imports of its own** — it uses the runtime globals
`game`, `canvas`, and `foundry.utils`, exactly like the existing adapters.

### 2. Register it in the `ready` hook

In [`scripts/hooks/foundry-hooks.js`](../scripts/hooks/foundry-hooks.js), inside
the registry-init block (next to the Ironsworn and Nimble registrations):

```js
import { MySystemAdapter } from "../systems/my-system-adapter.js";
// …
registerSystem("my-system", MySystemAdapter);
```

`registerSystem(id, adapter)` is idempotent — re-running the ready hook replaces
the prior registration with a warning rather than corrupting the table.

### 3. (Optional) consume it from a macro / module

`game.modules.get('the-eternal-skald').api.systems` is the `SystemRegistry`:

```js
const skald   = game.modules.get('the-eternal-skald').api;
const adapter = skald.systems.getActive();        // never null
adapter.capabilities();                            // gate your feature on this
skald.systems.get('my-system');                    // look up by id (or null)
skald.systems.list();                              // → registered system ids
skald.systems.register('my-system', MySystemAdapter);
```

### 4. Add a test

Tests are plain Node ESM scripts under `test/`, with their own pass/fail
counters and a non-zero exit on failure — the suite has **no test framework**.
Follow `test/nimble-adapter.test.mjs`:

```js
// test/my-system-adapter.test.mjs
let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { failed++; console.error("  ✗", msg); } };

// … import the adapter and assert its contract / reads …

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
```

Run the whole suite with `npm test`. Keep it 100% green.

---

## Checklist

- [ ] Adapter provides `id`, `label`, `isActive()`, `capabilities()`.
- [ ] `capabilities()` starts from `emptyCapabilities()` and only flips on real features.
- [ ] Every read returns `null` / `[]` / `{}` / `""` on failure and never throws.
- [ ] Every write is GM-gated and returns `makeResult(...)` or `unsupported(...)`.
- [ ] Registered in the `ready` hook via `registerSystem(id, adapter)`.
- [ ] A `test/<name>.test.mjs` covers the contract and passes under `npm test`.
- [ ] Existing systems are untouched — the change is purely additive.
