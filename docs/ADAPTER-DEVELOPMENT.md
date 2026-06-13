# Writing a System Adapter for The Eternal Skald

> **Audience:** developers who want to teach the Skald to drive a Foundry VTT
> game system other than Ironsworn (e.g. D&D 5e, Pathfinder 2e, Savage Worlds).
>
> This is the **tutorial** companion to [`SYSTEMS.md`](./SYSTEMS.md) (the
> reference) and [`PROPOSAL-multi-system-adapter-architecture.md`](./PROPOSAL-multi-system-adapter-architecture.md)
> (the design rationale). Read this when you want a step-by-step, copy-paste
> starting point.

---

## 1. The big picture

The Skald never talks to a game system directly. Instead it asks a **System
Adapter** — a plain object that satisfies a uniform contract — for everything
system-specific: "who is the active character?", "what are their stats?", "mark
two progress boxes", "roll this oracle". This indirection is what lets one
codebase narrate Ironsworn *and* Nimble *and* (with your help) any other system.

```
┌────────────┐     getActiveAdapter()      ┌──────────────────┐
│  Skald     │ ─────────────────────────▶ │  SystemRegistry  │
│  (AI / UI) │                             └──────────────────┘
└────────────┘                                      │ resolves by game.system.id
       │ calls contract methods                     ▼
       │                                   ┌──────────────────┐
       └──────────────────────────────────▶│  YourAdapter     │──▶ actor.system.*
                                            │  (this guide)    │    canvas, compendia…
                                            └──────────────────┘
                                                    │ when nothing registered
                                                    ▼
                                            ┌──────────────────┐
                                            │  NullAdapter     │  (safe no-op)
                                            └──────────────────┘
```

The three files you need to know:

| File | Role |
| --- | --- |
| [`scripts/systems/adapter-interface.js`](../scripts/systems/adapter-interface.js) | The **contract** — capability keys, result helpers, the `SystemAdapter` typedef, and `isValidAdapter()`. |
| [`scripts/systems/registry.js`](../scripts/systems/registry.js) | The **registry** — `registerSystem(id, adapter)` and `getActiveAdapter()`. |
| [`scripts/systems/null-adapter.js`](../scripts/systems/null-adapter.js) | The **fallback** — what every unsupported method should behave like. |

Existing adapters to read as worked examples:

- **Ironsworn** — `scripts/ironsworn-controller.js` (the full-featured reference; oracles, progress tracks, vows, momentum, foes, assets).
- **Nimble** — `scripts/systems/nimble-adapter.js` (a **read-only** adapter: character reads + a rules digest, no oracles/tracks/vows).
- **Null** — `scripts/systems/null-adapter.js` (every method reports `unsupported()`).

---

## 2. The contract in one screen

An adapter is a plain object (or class instance). **Only four members are
required** — everything else is optional and every caller feature-detects it
(`typeof adapter.markProgress === "function"`) and/or checks `capabilities()`
first.

```js
// REQUIRED — identity & capability
id            // string  — the Foundry game.system.id this adapter serves ("dnd5e")
label         // string  — human-readable ("Dungeons & Dragons 5e")
isActive()    // boolean — true iff game.system.id === this.id
capabilities()// object  — { capabilityKey: boolean, … } drawn from SYSTEM_CAPABILITIES
```

Three non-negotiable design rules (copied from the Ironsworn controller, and
enforced by code review):

1. **Reads MUST NOT throw.** Return `null` / `[]` / `{}` on any failure so the
   AI context builder can simply omit missing data.
2. **Writes MUST be GM-gated, bounds-checked and idempotent**, and MUST return a
   result object — use `makeResult({...})` for success and `unsupported(reason)`
   for "this system can't do that".
3. **Every optional method is opt-in.** If your system has no oracles, don't
   implement `rollOracle` (or return `unsupported()`); set `oracles: false` in
   `capabilities()` and the Skald silently hides oracle features.

### 2.1 Capability keys

`capabilities()` returns a map whose keys are drawn from `SYSTEM_CAPABILITIES`
(`adapter-interface.js`). Start from `emptyCapabilities()` (every key `false`)
and flip on only what you implement:

| Key | Meaning | "What your users see" |
| --- | --- | --- |
| `systemActive` | this system is the active one | the Skald engages at all |
| `characterReads` | can read stats / meters / sheet | AI knows the PC's name, stats, HP |
| `sheetWrites` | can write to the character sheet | `[[EFFECT:...]]` directives apply harm/stress |
| `progressTracks` | supports progress-track objectives | `!progress`, journey tracking |
| `vows` | Ironsworn-style vows | vow XP, swear-a-vow flows |
| `oracles` | oracle tables | `!oracle`, AI oracle interpretation |
| `momentum` | a momentum-style resource | momentum burns/resets in narration |
| `impacts` | conditions / impacts / debilities | condition tracking in AI context |
| `moves` | named moves / actions | move detection, `!skald` move advice |
| `moveDialogs` | can open the system's roll dialog | move declarations open the real dialog |
| `xp` | awarding experience | XP awards on milestones |
| `compendiumFoes` | create foes from compendia | AI can spawn statted enemies |
| `compendiumAssets` | grant assets/items from compendia | AI can grant gear/assets |
| `createCharacter` | create a player character | guided character creation |
| `mapVision` | map scouting | `!scout` (usually leave `true` — it's system-agnostic) |

> **Rule of thumb:** a brand-new adapter that only feeds the AI character
> context needs just `systemActive`, `characterReads`, and `mapVision`. That
> alone unlocks rich, system-aware narration. Add write capabilities later.

---

## 3. Step-by-step: a D&D 5e adapter skeleton

This worked example builds a **read-only** `dnd5e` adapter — enough for the
Skald to narrate with full awareness of the character. It mirrors the structure
of `nimble-adapter.js`, so once it works you can grow it the same way.

### Step 1 — Create the file

Create `scripts/systems/dnd5e-adapter.js`:

```js
/* The Eternal Skald — D&D 5e System Adapter (read-only starter) */
import { LOG_PREFIX as BASE_PREFIX } from "../core/constants.js";
import { emptyCapabilities, unsupported, makeResult } from "./adapter-interface.js";

const SYSTEM_ID  = "dnd5e";
const LOG_PREFIX = `${BASE_PREFIX} D&D5e |`;

/** Safe numeric read: returns the number at `path`, or `fallback`. */
function num(obj, path, fallback = null) {
  try {
    const v = foundry.utils.getProperty(obj, path);
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  } catch (_) { return fallback; }
}

export const Dnd5eAdapter = Object.freeze({
  /* --- REQUIRED identity & capability --- */
  id: SYSTEM_ID,
  label: "Dungeons & Dragons 5e",

  isActive() {
    try { return game?.system?.id === SYSTEM_ID; } catch (_) { return false; }
  },

  capabilities() {
    const caps = emptyCapabilities();         // every key starts false
    caps.systemActive    = this.isActive();
    caps.characterReads  = true;              // implemented below
    caps.mapVision       = true;              // system-agnostic Skald feature
    // caps.sheetWrites = true;               // ← enable once you add writes
    return caps;
  },

  /* --- OPTIONAL character reads (normalised for the AI) --- */
  getActiveCharacter() {
    try {
      return game.user?.character
        ?? canvas?.tokens?.controlled?.[0]?.actor
        ?? null;
    } catch (_) { return null; }
  },

  getStats(actor) {
    if (!actor) return {};
    const out = {};
    for (const key of ["str", "dex", "con", "int", "wis", "cha"]) {
      const v = num(actor, `system.abilities.${key}.value`);
      if (v != null) out[key.toUpperCase()] = v;
    }
    return out;                                // {} when unsupported
  },

  getMeters(actor) {
    if (!actor) return {};
    const hp = num(actor, "system.attributes.hp.value");
    const max = num(actor, "system.attributes.hp.max");
    return (hp != null) ? { hp: { value: hp, max } } : {};
  },

  describeCharacter(actor) {
    if (!actor) return "";
    const s = this.getStats(actor);
    const m = this.getMeters(actor);
    const stats = Object.entries(s).map(([k, v]) => `${k} ${v}`).join(", ");
    const hp = m.hp ? ` — HP ${m.hp.value}/${m.hp.max ?? "?"}` : "";
    return `${actor.name} (D&D 5e): ${stats}${hp}`.trim();
  },

  /* --- OPTIONAL prompt flavour for the AI --- */
  getPromptProfile() {
    return {
      persona: "a Dungeon Master narrating a 5th-edition Dungeons & Dragons game",
      rulesDigest: "d20 + ability modifier vs. DC; advantage/disadvantage; HP and hit dice.",
      terminology: { meter: "hit points", check: "ability check" }
    };
  }

  /* --- writes intentionally omitted in the starter — see Step 4 --- */
});
```

### Step 2 — Register it

Adapters self-register on Foundry's `ready` hook. The Skald already does this
for Ironsworn and Nimble in [`scripts/hooks/foundry-hooks.js`](../scripts/hooks/foundry-hooks.js).
Add yours alongside them:

```js
import { registerSystem } from "../systems/registry.js";
import { Dnd5eAdapter }   from "../systems/dnd5e-adapter.js";

Hooks.once("ready", () => {
  try { registerSystem(Dnd5eAdapter.id, Dnd5eAdapter); }
  catch (e) { console.warn("Skald | dnd5e adapter registration failed:", e); }
});
```

`registerSystem` runs `isValidAdapter()` and rejects anything missing the four
required members (logging a warning) — so a malformed adapter fails safe rather
than corrupting the registry.

### Step 3 — Verify it resolves

In Foundry's console, with a 5e world active:

```js
game.modules.get("the_eternal_skald"); // module present
// from the module's own code path:
getActiveAdapter().label;              // "Dungeons & Dragons 5e"
getActiveAdapter().capabilities();     // { characterReads: true, mapVision: true, … }
```

At this point the Skald narrates with full character awareness. Type `!skald`
and the AI knows your fighter's name, ability scores and current HP.

### Step 4 — Grow into writes (optional)

When you're ready for the AI to *change* the sheet, implement write methods.
Every write **must** be GM-gated and return a result object:

```js
applyHarm(actor, amount) {
  if (!game.user?.isGM) return unsupported("GM only");
  const n = Math.max(0, Number(amount) || 0);
  const hp = num(actor, "system.attributes.hp.value");
  if (hp == null) return unsupported("no hp meter");
  const next = Math.max(0, hp - n);
  return actor.update({ "system.attributes.hp.value": next })
    .then(() => makeResult({ applied: n, hp: next }))
    .catch(e => unsupported(e?.message ?? "update failed"));
}
```

Then flip `caps.sheetWrites = true` in `capabilities()`. The Skald's effect
pipeline (the `[[EFFECT:harm:2]]` directive grammar) will now route through it.

---

## 4. Capability-by-capability implementation guide

Implement these **in priority order** — each one unlocks more Skald features.

1. **`characterReads` (start here).** `getActiveCharacter`, `getStats`,
   `getMeters`, `describeCharacter`. Pure reads; cannot break a world. This is
   ~80% of the perceived value because it makes narration character-aware.
2. **`getPromptProfile`.** Not a capability flag but high-leverage: it injects
   your system's voice, terminology and a one-paragraph rules digest into the AI
   system prompt. Cheap, big quality win.
3. **`mapVision`.** Usually just leave `true` — `!scout` is system-agnostic.
4. **`sheetWrites` (`applyHarm`/`applyStress`/`setStat`/`adjustResource`).**
   The first writes. GM-gate, bounds-check, return results.
5. **`moves` / `moveDialogs` (`triggerMove`).** If your system has named
   actions and a roll dialog, wire them so move declarations open the real UI.
6. **`progressTracks` / `vows` / `xp`.** Ironsworn-flavoured; most non-PbtA
   systems leave these `false`.
7. **`oracles` (`rollOracle`).** Return `null` (not throw) when a named oracle
   doesn't exist.
8. **`compendiumFoes` / `compendiumAssets` (`createFoeActor`/`addAssetToActor`).**
   Async, GM-gated content creation from compendia.

See the `SystemAdapter` typedef at the bottom of `adapter-interface.js` for the
exact signature of every optional method.

---

## 5. Testing checklist

The repo's test suite is framework-free pure-Node ESM (`npm test` runs
`node test/run-all.mjs`, which discovers every `test/*.test.mjs`). Add a
`test/dnd5e-adapter.test.mjs` and cover:

- [ ] **Contract.** `isValidAdapter(Dnd5eAdapter) === true` (id, label, isActive, capabilities all present).
- [ ] **Capabilities shape.** Every key returned by `capabilities()` is a known `SYSTEM_CAPABILITIES` key, and every value is a boolean. Start from `emptyCapabilities()` so no key is ever missing.
- [ ] **Reads never throw.** `getStats(null)`, `getMeters(null)`, `describeCharacter(null)` all return safe empties (`{}` / `""`), never throw.
- [ ] **`isActive()` is honest.** It checks `game.system.id` and returns `false` when the global is absent (tests run without a Foundry global).
- [ ] **Writes are GM-gated.** With `game.user.isGM` falsy, every write returns `unsupported(...)` and performs no mutation.
- [ ] **Writes are bounds-checked & idempotent.** Negative/NaN inputs clamp; re-applying the same write is safe.
- [ ] **Registration.** `registerSystem(id, adapter)` returns `true`; `getActiveAdapter()` resolves to your adapter when the system is active and to `NullAdapter` otherwise.

Because the suite has no Foundry runtime, stub the globals you touch. A minimal
pattern (see existing adapter tests for the full version):

```js
// at the top of the test, before importing the adapter
globalThis.foundry = { utils: { getProperty: (o, p) => p.split(".").reduce((a, k) => a?.[k], o) } };
globalThis.game = { system: { id: "dnd5e" }, user: { isGM: false } };
```

> **MUST NOT** weaken or skip existing tests, and **MUST** add a regression test
> for any behaviour you add (engineering brief §7). Run the **full** suite before
> opening a PR — a green adapter test with a red suite is not done.

---

## 6. "What your users will see" — capability → feature map

| You implement… | …and players get |
| --- | --- |
| `characterReads` + `getPromptProfile` | narration that knows the PC's name, stats, HP, and speaks in your system's voice |
| `sheetWrites` | the AI can apply damage/healing/conditions via `[[EFFECT:]]` directives |
| `moves` + `moveDialogs` | typing a move declaration opens your system's real roll dialog |
| `progressTracks` | `!progress`, journeys, and objective tracking light up |
| `oracles` | `!oracle` rolls and AI-interpreted oracle results |
| `compendiumFoes` / `compendiumAssets` | the AI can spawn statted enemies and grant gear from your compendia |
| `mapVision` | `!scout` analyses the current scene/map (works for any system) |

---

## 7. Submitting your adapter

1. One adapter per file under `scripts/systems/<system-id>-adapter.js`.
2. Register it in `scripts/hooks/foundry-hooks.js` (a single `ready`-hook block).
3. Add `test/<system-id>-adapter.test.mjs` and make the full suite green.
4. Update [`SYSTEMS.md`](./SYSTEMS.md) with a one-line entry for your system.
5. Append a maintenance-log entry (see [`ai-maintenance-log.md`](./ai-maintenance-log.md))
   and open a PR. Keep the change additive and backwards-compatible — registering
   a new adapter never alters another system's behaviour (the registry is keyed
   by `game.system.id`).

Welcome aboard, and may your saga be ever-narrated. ᛁ
