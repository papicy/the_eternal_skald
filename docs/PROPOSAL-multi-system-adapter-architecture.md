# PROPOSAL — Multi-System Plugin / Adapter Architecture

> **STATUS: DESIGN PROPOSAL (no code changed).** This document is the output of an
> `INVESTIGATE` + `DOCUMENT` task. It proposes making The Eternal Skald work with
> any game system through a registrable adapter layer, with **Ironsworn** and
> **Nimble** as the first two targets. **Every implementation step below crosses an
> architectural boundary (brief §5) and therefore REQUIRES a recorded approval gate
> (brief §6) before any code is written.** Nothing here has been implemented.
>
> All claims use the mandated evidence format (brief §4). Line numbers are from the
> repo state at the time of writing.

---

## 0. Executive Summary

The module is **deeply but cleanly** coupled to Ironsworn. The good news: the
coupling is funnelled through **two singleton objects** — `IronswornController`
(`scripts/ironsworn-controller.js`) and `IronswornData` (`scripts/ironsworn-data.js`)
— that are imported by 9 modules. `IronswornController` is *already shaped like an
adapter*: it self-identifies the active system, reports a capability map, and
degrades to no-ops when the system is absent. That existing shape is the seam we
exploit.

The proposed architecture adds a thin **system registry** (`getActiveAdapter()` +
`registerSystem()`) plus a documented **`SystemAdapter` interface**. The current
`IronswornController` becomes the reference adapter for `foundry-ironsworn` with
**zero behavioural change** (for Ironsworn, the registry resolves to the very same
object). A `NullAdapter` preserves today's graceful standalone degradation. A new
`NimbleAdapter` is added behind the same interface. Consumers migrate from a hard
`import` to `getActiveAdapter()` incrementally, smallest-blast-radius first.

---

## 1. Current State Findings (evidence-based)

### 1.1 Module shape & entry points

```
CLAIM:      The Foundry client entry point is scripts/eternal-skald.js, declared in module.json esmodules.
EVIDENCE:   module.json:1-2,16  ::  "id":"the-eternal-skald", "esmodules":[...]
CONFIDENCE: HIGH
BASIS:      read lines directly
```
```
CLAIM:      The module declares foundry-ironsworn only as an OPTIONAL "recommends" relationship; it is not a hard dependency.
EVIDENCE:   module.json:29-37  ::  relationships.recommends[0].id = "foundry-ironsworn"
CONFIDENCE: HIGH
BASIS:      read lines directly — reason text: "The module also works standalone in any system".
```
```
CLAIM:      The public macro/module API is assembled once in the ready hook and already exposes the Ironsworn controller and integration layer as named members.
EVIDENCE:   scripts/hooks/foundry-hooks.js:178-199  ::  game.modules.get(MODULE_ID).api = { ... ironsworn: IronswornController, integration: Integration, IronswornData, ... }
CONFIDENCE: HIGH
BASIS:      read lines directly
```

### 1.2 Layered organisation (already enforced)

The `scripts/` tree is partitioned into owned layers governed by
`docs/repository-map.md` (core / ai / chat / chronicle / narrative / vision / hooks
/ rules-bridge / rag). Sizes (LOC): `ironsworn-controller.js` 4031,
`narrative/integration.js` 3078, `chronicle/journal-system.js` 1559,
`chat/commands.js` 1477. The two giants are 🔴 LOCKED and must be read by range only.

```
CLAIM:      Layer boundaries are documented and load-bearing, with a file-ownership table.
EVIDENCE:   docs/repository-map.md:54-92  ::  "scripts/ — Source Ownership Table (THE LAW)"
CONFIDENCE: HIGH
BASIS:      read lines directly
```

### 1.3 The Ironsworn coupling surface

```
CLAIM:      Exactly two Ironsworn singletons carry the coupling; IronswornController is imported by 9 modules.
EVIDENCE:   grep "import .*ironsworn-controller" -> prompt-builder.js:7, chat/commands.js:17, chronicle/entity-linking.js:5, chronicle/journal-system.js:7, core/settings.js:21, eternal-skald.js:46, hooks/foundry-hooks.js:15, narrative/generators.js:8, narrative/integration.js:10
CONFIDENCE: HIGH
BASIS:      grep match across scripts/
```
```
CLAIM:      The orchestration spine (integration.js) is by far the heaviest consumer, calling IronswornController ~109 times.
EVIDENCE:   grep -c "IronswornController" scripts/narrative/integration.js  ->  109
CONFIDENCE: HIGH
BASIS:      grep count
```
```
CLAIM:      IronswornController already behaves as an adapter: it gates on the active system id, exposes an api() handle, and reports a capability map.
EVIDENCE:   scripts/ironsworn-controller.js:29 (SYSTEM_ID="foundry-ironsworn"), :279-283 isActive(), :285-289 api(), :297-304 capabilities()
CONFIDENCE: HIGH
BASIS:      read lines directly
```
```
CLAIM:      The controller is a single frozen object literal with ~140 public methods (reads, writes, moves, oracle, compendium lookups, creation).
EVIDENCE:   scripts/ironsworn-controller.js:257 (export const IronswornController = {), :4031 (export default)
CONFIDENCE: HIGH
BASIS:      read declaration + method grep (getStats, getMeters, markProgress, triggerMove, rollOracle, createFoeActor, grantVowXp, ...)
```
```
CLAIM:      IronswornData is a single frozen object of Ironsworn-only content: 1d100 oracle tables, move list, asset categories, terminology, rank→XP.
EVIDENCE:   scripts/ironsworn-data.js:461-512  ::  export const IronswornData = Object.freeze({ oracles, oracleAliases, moves, assetCategories, terminology, rankXp, rollOracle, xpForRank })
CONFIDENCE: HIGH
BASIS:      read lines directly
```

### 1.4 System-specific behaviour baked into otherwise-agnostic layers

```
CLAIM:      The system prompt hardcodes an Ironsworn rules digest, an Ironsworn persona, and an Ironsworn move list inside the ai/ layer.
EVIDENCE:   scripts/ai/prompt-builder.js:29-48 (IRONSWORN CORE RULES DIGEST), :50-57 (persona), :436-465 (buildIronswornPromptBlock / moveList)
CONFIDENCE: HIGH
BASIS:      read lines directly
```
```
CLAIM:      The AI-effect directive dispatch maps a (frozen) directive grammar to IronswornController method calls via a switch on eff.kind.
EVIDENCE:   scripts/narrative/integration.js:2548-2700  ::  applyEffects() switch (eff.kind) { case "momentum"/"harm"/"stress"/"supply"/"progress"/"oracle"/"grant_xp"/... -> IronswornController.<method> }
CONFIDENCE: HIGH
BASIS:      read lines directly
```
```
CLAIM:      System detection elsewhere is also keyed to the literal "foundry-ironsworn" id (with a flag-namespace fallback).
EVIDENCE:   scripts/narrative/integration.js:1466-1472  ::  _ironswornContext(): sysId === "foundry-ironsworn" || message.flags["foundry-ironsworn"]
CONFIDENCE: HIGH
BASIS:      read lines directly
```
```
CLAIM:      entity-linking creates Ironsworn-specific link kinds (move / oracle / asset / progress-track) and imports both Ironsworn singletons.
EVIDENCE:   scripts/chronicle/entity-linking.js:4-5 (imports IronswornData + IronswornController); usage count grep -> 11
CONFIDENCE: HIGH
BASIS:      grep match + import read
```

### 1.5 Test & safety harness (must stay green)

```
CLAIM:      A framework-free Node-ESM regression suite of ~36 *.test.mjs files plus a load smoke test and import guard governs correctness.
EVIDENCE:   test/ listing (run-all.mjs, load-smoke.mjs, check-imports.mjs, *.test.mjs); docs/repository-map.md:95-118
CONFIDENCE: HIGH
BASIS:      directory read + doc read
```
```
CLAIM:      Source-text guard tests concatenate every *.js under a subdirectory of scripts/, so a new scripts/<layer>/ folder is automatically swept into the corpus.
EVIDENCE:   test/_skald-source.mjs:31-45  ::  collectSubmodules() recurses subdirectories of scripts/
CONFIDENCE: HIGH
BASIS:      read lines directly — implication: a new scripts/systems/ folder is auto-included in text guards.
```

### 1.6 No prior multi-system work exists

```
CLAIM:      There is no existing adapter/plugin/multi-system/Nimble abstraction anywhere in source or docs.
EVIDENCE:   grep -ni "nimble|system-agnostic|multi-system|adapter|pluggable" across CODEBASE_ANALYSIS.md, README.md, CHANGELOG.md, docs/, scripts/  ->  no matches
CONFIDENCE: HIGH
BASIS:      grep produced zero hits
```

---

## 2. System-Agnostic vs. System-Specific Classification

| Area / file | Classification | Why (evidence) |
|---|---|---|
| `ai/providers.js`, `ai/client.js` | **Agnostic** | Talk to AI models only; no game logic (repo-map: ai/ "never writes to Foundry documents"). |
| `ai/prompt-builder.js` | **Mixed** | Assembly skeleton is agnostic; the digest/persona/move blocks are Ironsworn (prompt-builder.js:29-57, 436-465). |
| `chat/commands.js`, `chat/display.js` | **Mixed** | Command parsing/rendering is agnostic; some commands (`!oracle`, move/vow handling) call Ironsworn singletons (imports at commands.js:16-17). |
| `chronicle/journal-system.js` | **Mostly agnostic** | Journals/timeline/relationships are system-neutral; minor Ironsworn touchpoints (import at :7, 3 uses). |
| `chronicle/entity-linking.js` | **Mixed** | Generic NPC/location links are agnostic; move/oracle/asset/track links are Ironsworn (entity-linking.js:4-5). |
| `vision/map-vision.js` | **Agnostic** | Read-only map scouting; no rules dependency. |
| `browser-rag.js` | **Agnostic** | Local IndexedDB memory; degrades to no-op. |
| `core/constants.js`, `core/model-catalogue.js` | **Agnostic** | Config/model catalogue only. |
| `core/settings.js` | **Mostly agnostic** | Settings registry; imports controller (:21) only for capability-aware UI hints. |
| `narrative/generators.js` | **Mixed** | Generic narration helpers + Ironsworn move/data usage (imports :7-8). |
| `narrative/site-oracle.js` | **Specific** | Ironsworn: Delve "Discover a Site" oracles. |
| `narrative/token-control.js` | **Agnostic** | Foundry token ops (move/remove); no rules. |
| `narrative/integration.js` | **Mixed (spine)** | Orchestration is agnostic in principle, but `applyEffects` dispatch and move/progress flow call the controller 109× (integration.js:2548-2700). |
| `hooks/foundry-hooks.js` | **Mixed** | Wiring is agnostic; binds Ironsworn singletons into the API (:178-199). |
| `ironsworn-controller.js`, `ironsworn-data.js` | **Specific (100%)** | The rules bridge + reference data. **These become the Ironsworn adapter.** |

**Agnostic core that should "just work" on any system:** AI narration pipeline,
Living Chronicle journaling, RAG memory, map vision/scouting, entity linking for
NPCs/locations, timeline/relationships, token control, and chat commands that don't
touch rules (`!skald`, `!journals`, `!mysteries`, `!timeline`, `!relationships`,
`!scout`, `!end-session`, `!skald-reset`, link styling).

**System-specific (must be supplied by an adapter):** stats/meters schema, progress
tracks & vows, momentum/harm/stress/supply, impacts/conditions, moves & their roll
dialogs, oracles, XP rules, compendium foe/asset/character creation, and the
rules-digest/persona/move blocks fed to the prompt.

---

## 3. Minimal Plugin / Adapter Architecture

### 3.1 Core idea

Replace **direct singleton imports** with **resolution through a registry**. Because
`IronswornController` already self-identifies and capability-reports, for Ironsworn
the registry returns *the same object* — so the Ironsworn path is byte-for-byte
unchanged. Other systems register their own adapter; unknown systems get a
`NullAdapter` that no-ops (preserving today's standalone behaviour).

```
                       ┌─────────────────────────────────────┐
   consumers           │  scripts/systems/registry.js        │
   (integration, ai,   │                                     │
    chat, chronicle) ──┼─► getActiveAdapter()  ──────────────┼──► resolves by game.system.id
                       │   registerSystem(id, factory)       │
                       └───────────────┬─────────────────────┘
                                       │
        ┌──────────────────────────────┼───────────────────────────────┐
        ▼                              ▼                                ▼
  foundry-ironsworn              nimble                            (no match)
  IronswornController        NimbleAdapter (new)                  NullAdapter
  (existing object,          implements SystemAdapter             every method
   re-registered as-is)      interface §5                         a safe no-op
```

### 3.2 New layer (additive only)

A new owned layer `scripts/systems/` (auto-swept into the test corpus per
`_skald-source.mjs:31-45`):

- `scripts/systems/registry.js` — `registerSystem(id, adapter)`, `getActiveAdapter()`,
  `getAdapter(id)`, and the exported `NullAdapter`. Pure resolution; no game logic.
- `scripts/systems/adapter-interface.js` — JSDoc `@typedef` for `SystemAdapter`,
  plus `CAPABILITIES` string constants (the capability keys in §5). Documentation /
  contract only; no behaviour.
- `scripts/systems/ironsworn-adapter.js` — a 3-line shim:
  `registerSystem("foundry-ironsworn", IronswornController)`. (Optionally a thin
  `getPromptProfile()` wrapper returning the existing digest/persona/move strings so
  prompt-builder can stop hardcoding them — see Phase 2.)
- `scripts/systems/nimble-adapter.js` — the Nimble implementation (§5.3).

### 3.3 Design rules honoured

- **Additive & backwards-compatible** (brief §1.1): for `foundry-ironsworn`,
  `getActiveAdapter() === IronswornController`. No setting/command/directive/i18n key
  is removed or renamed. The frozen directive grammar (`[[EFFECT:…]]` etc.) is
  untouched — only its *dispatch target* becomes "the active adapter" instead of "the
  Ironsworn controller", and the method names already match.
- **Degrades gracefully** (brief §1.2): `NullAdapter` makes every mechanical call a
  no-op so the agnostic core (chronicle, RAG, vision, narration) runs on any/no
  system, exactly as the standalone path does today.
- **Capability-gated** (brief §1.2): consumers check `adapter.capabilities()` (the
  existing pattern, controller.js:297-304) before invoking system-specific features,
  so Nimble (no oracles/vows/momentum) silently omits them.
- **Layer boundaries** (repo-map §2): `systems/` sits beside the rules bridge; it
  may be called by `narrative/`, `ai/`, `chat/`, `chronicle/`, `hooks/`. It calls
  only adapters. No new runtime dependency, no build step, no bundler.

---

## 4. Implementation Plan — smallest safe changes

Each phase is independently revertible and **must pass `npm test` 100%** before the
next. **Phases 1–4 are architectural and each REQUIRES its own approval gate
(brief §6)** — they create a new layer and migrate consumers, which §5 forbids
without a gate. Recommended gate ordering, smallest blast radius first:

**Phase 0 — Design (this doc).** `DOCUMENT` task. No code. ✅ done.

**Phase 1 — Add the registry (no consumer touched).** New files only:
`systems/registry.js`, `systems/adapter-interface.js`, `systems/ironsworn-adapter.js`
(register the existing controller verbatim). Add `test/systems-registry.test.mjs`
asserting: Ironsworn id resolves to the controller; unknown id resolves to a
no-op NullAdapter whose methods return `{ok:false}`/`null`. **Blast radius:** zero
existing behaviour; rollback = delete the new files. *Gate reason: new layer/dir.*

**Phase 2 — Migrate the leaf consumers (one small gated task each).** In priority
order of lowest risk: (a) `ai/prompt-builder.js` — move the Ironsworn digest/persona/
move strings into `ironsworn-adapter.getPromptProfile()` and have the builder call
`getActiveAdapter().getPromptProfile?.()` with the current strings as the fallback;
(b) `chronicle/entity-linking.js` — gate move/oracle/asset/track link kinds behind
`capabilities()`. Each is ≤3 files / ≤50 changed lines, additive, Ironsworn output
identical. A regression test pins the produced prompt/links unchanged for Ironsworn.

**Phase 3 — Migrate the spine (dedicated gate).** `narrative/integration.js` is 🔴
LOCKED and the 109-call hotspot. Introduce a single module-local
`const sys = () => getActiveAdapter();` and mechanically replace
`IronswornController.` with `sys().` in `applyEffects` and the move/progress paths.
Behaviour for Ironsworn is identical (same object). This is the largest change and
**must** be its own gate with a full-suite diff and the existing track/vow/journey
tests as the regression net.

**Phase 4 — Add Nimble + advertise it.** New file `systems/nimble-adapter.js`
(register id `"nimble"`, §5.3) + `test/nimble-adapter.test.mjs`. Then, additively,
add a `nimble` entry to `module.json` `relationships.recommends` and a README note.
`module.json` is 🧊 CONTRACT — additive-only change, its own gate.

**Net effect:** existing Ironsworn users see no change; developers add a new system
by dropping one file that implements the interface and calling `registerSystem`.

---

## 5. `SystemAdapter` Interface Specification

> Every method is OPTIONAL except `id`, `label`, `isActive`, and `capabilities`.
> Missing methods are treated as "unsupported" by callers (capability-gated).
> All writes MUST be GM-gated, bounds-checked, idempotent, and return a result
> object `{ ok:boolean, noop?:boolean, unsupported?:boolean, error?:string, ... }`
> (brief §1.4). Reads MUST NOT throw — return `null`/`[]` on failure.

### 5.1 Interface contract

```js
/**
 * @typedef {Object} SystemAdapter
 *
 * --- Identity & capability (REQUIRED) ---
 * @property {string}  id        Foundry game system id, e.g. "foundry-ironsworn" | "nimble".
 * @property {string}  label     Human label, e.g. "Ironsworn".
 * @property {() => boolean} isActive            True iff game.system.id === this.id.
 * @property {() => Object}  capabilities        Feature map; keys from CAPABILITIES.
 *
 * --- Character & state reads (system shapes normalised by the adapter) ---
 * @property {() => Actor|null}        getActiveCharacter
 * @property {(a:Actor) => Object}     getStats        // {} when unsupported
 * @property {(a:Actor) => Object}     getMeters       // {key:{value,max}}
 * @property {(a:Actor) => string}     describeCharacter// prompt-ready summary
 *
 * --- Prompt profile (system flavour for the AI) ---
 * @property {() => {persona:string, rulesDigest:string, moveList:string,
 *                   terminology?:Object, oracleGuidance?:string}} getPromptProfile
 *
 * --- Mechanical writes (all gated; capability-flagged) ---
 * @property {(a,delta)=>Result}  adjustResource   // generic meter delta
 * @property {(a,amt)=>Result}    applyHarm
 * @property {(a,amt)=>Result}    applyStress
 * @property {(a,stat,val)=>Result} setStat
 * @property {(a,cond,on)=>Result}  setImpact        // condition toggle
 *
 * --- Progress / objectives (progress-track systems only) ---
 * @property {(a,ref,n)=>Result}    markProgress
 * @property {(a,ref,boxes)=>Result} setProgress
 * @property {(a,opts)=>Result}      createProgressTrack
 * @property {(a,ref)=>Result}       completeTrack
 * @property {(a,amt,opts)=>Result}  grantXp
 *
 * --- Moves / actions / oracles ---
 * @property {(ref,opts)=>Promise<Result>} triggerMove
 * @property {(name)=>any}                  rollOracle    // null when unsupported
 *
 * --- Compendium content creation (gated) ---
 * @property {(name,opts)=>Promise<Result>} createFoeActor
 * @property {(a,name,opts)=>Promise<Result>} addAssetToActor
 * @property {(name,opts)=>Promise<Result>}  createCharacter
 */

// CAPABILITIES keys (string constants in adapter-interface.js):
//  systemActive, characterReads, sheetWrites, progressTracks, vows, oracles,
//  momentum, impacts, moves, moveDialogs, xp, compendiumFoes, compendiumAssets,
//  createCharacter, mapVision(=always true, core feature)
```

### 5.2 Ironsworn adapter (reference — already implemented as `IronswornController`)

```
CLAIM:      Every interface method above already exists on IronswornController; registration is a re-export, not a rewrite.
EVIDENCE:   ironsworn-controller.js — isActive:279, capabilities:297, getActiveCharacter:315, getStats:337,
            getMeters:369, describeCharacter:1189, applyHarm:1591, applyStress:1600, setStat:1651,
            setImpact:1682, markProgress:1717, setProgress:1777, createProgressTrack:1809,
            completeTrack:1928, grantXp:629, triggerMove:1342, rollOracle:2952, createFoeActor:3456,
            addAssetToActor:3243, createCharacter:3526
CONFIDENCE: HIGH
BASIS:      method grep over the controller object
```

Ironsworn capability map (already returned, controller.js:297-304, extended with the
new keys): `{ systemActive, characterReads:true, sheetWrites:true,
progressTracks:true, vows:true, oracles:true, momentum:true, impacts:true,
moves:true, moveDialogs: hasPrerollDialog(), xp:true, compendiumFoes:true,
compendiumAssets:true, createCharacter:true }`. `getPromptProfile()` returns the
strings currently at prompt-builder.js:29-57 & 436-465 (moved, not changed).
`adjustResource(actor,"momentum",d)` maps to the existing `adjustMomentum`
(controller.js:1572); `adjustResource(actor,"supply",d)` to `adjustSupply` (:1609).

### 5.3 Nimble adapter (new — to be implemented)

System facts (from research — to be confirmed against the live system at
implementation time): id `"nimble"` (Foundry package `nimble`, repo
`Nimble-Co/FoundryVTT-Nimble`, TypeScript/Svelte, `DataModel`-based). Attributes
**STR / DEX / INT / WIL**; resources **HP, wounds, mana, hit dice**, action economy
(3 heroic actions), **armor as a "Defend" reaction**. Combat is **subtractive**: no
attack/to-hit roll — roll the weapon damage die; **1 = miss**, **max = crit
(exploding)**; attributes add flat damage. **No oracles, no vows/progress tracks, no
momentum.**

```
CLAIM:      Nimble's model differs fundamentally from Ironsworn — it has no oracles, vows, progress tracks or momentum, so those capabilities are false.
EVIDENCE:   web research — github.com/Nimble-Co/FoundryVTT-Nimble; goonhammer.com/what-i-love-about-nimble-rpg-the-flow; sessionzero.games/system/nimble.html
CONFIDENCE: MEDIUM
BASIS:      external docs, not yet verified against an installed system instance — MUST be confirmed before coding the adapter.
```

Nimble capability map:
`{ systemActive, characterReads:true, sheetWrites:true, progressTracks:false,
vows:false, oracles:false, momentum:false, impacts:true /*conditions*/, moves:true
/*as actions/abilities*/, moveDialogs:false, xp:true /*levels*/, compendiumFoes:true,
compendiumAssets:false, createCharacter:true }`.

Method mapping for Nimble:
- `getStats` → STR/DEX/INT/WIL from `actor.system`; `getMeters` → HP, wounds, mana,
  hit dice (`{value,max}` each).
- `applyHarm` → reduce HP (and apply a wound at 0, per system rules);
  `adjustResource(a,"mana"|"hitDice", d)` → the corresponding pool.
- `setImpact` → toggle a Nimble condition; `setStat` → set an attribute (clamped to
  the system's cap, +5 per research).
- `triggerMove(ref)` → roll a damage/action die with the **1=miss / max=crit
  exploding** rule; weave the attribute flat bonus. Returns the normalised outcome
  the narration layer already consumes.
- `rollOracle`, `markProgress`, `setProgress`, `createProgressTrack`,
  `completeTrack`, `grantVowXp` → return `{ ok:false, unsupported:true }` (the AI
  prompt for Nimble simply won't emit those directives, gated by capabilities).
- `getPromptProfile()` → a Nimble rules digest (subtractive combat, heroic actions,
  defend reaction, exploding crits), a system-neutral-but-Nimble-flavoured persona,
  and the Nimble action/spell list. **The Skald persona at prompt-builder.js:50-57
  is currently Ironsworn-flavoured ("Ironsworn before you") — Nimble supplies its own
  via the profile so the agnostic builder stays clean.**
- `createFoeActor(name,opts)` → create a Nimble monster actor; `createCharacter` →
  a rules-legal Nimble PC.

### 5.4 NullAdapter (unknown / standalone systems)

`id:"", label:"(none)", isActive:()=>true-when-no-known-system,
capabilities:()=>all-false-except-mapVision`. Every read returns `null`/`[]`; every
write returns `{ ok:false, unsupported:true }`. `getPromptProfile()` returns a
generic GM persona + empty digest/move list. This is what keeps the agnostic core
(chronicle, RAG, vision, narration) fully functional on a system nobody wrote an
adapter for — i.e. exactly today's "works standalone" promise (module.json:34).

---

## 6. Risks, Boundaries & Backward Compatibility

- **Architectural gate (brief §5/§6):** introducing `scripts/systems/` and migrating
  consumers crosses layer boundaries and adds a directory — **forbidden without a
  recorded approval gate.** This proposal is the pre-gate evidence package.
- **The two LOCKED giants** (`integration.js`, `ironsworn-controller.js`) are touched
  only in Phase 3, mechanically (`IronswornController.` → `sys().`), behind its own
  gate, with the existing track/vow/journey/XP tests as the safety net.
- **Frozen contracts preserved:** directive grammar, world-setting names, chat
  commands, i18n keys, `/skald-api/chat`, and `module.json` id/esmodules are **not**
  changed. The only `module.json` edit (Phase 4) is an *additive* `recommends` entry
  for `nimble`.
- **Backward compatibility guarantee:** for an Ironsworn world, `getActiveAdapter()`
  returns the identical `IronswornController` object, so every Ironsworn feature
  behaves exactly as before. `game.modules.get(id).api.ironsworn` stays; a new
  `api.systems` (the registry) is added alongside it.
- **Nimble accuracy caveat:** §5.3 capability/method details are MEDIUM confidence
  (external docs). Before coding the Nimble adapter, its data model MUST be verified
  against an installed `nimble` system instance.

---

## 7. Definition of Done for the eventual implementation (per brief §8)

Each phase: pre-flight checklist ticked & logged; ≤3 files / ≤50 lines or a recorded
gate; every claim carries §4 evidence; `npm test` 100% green; a new/extended
`*.test.mjs` covers the change; no setting/flag/directive/i18n removed or renamed;
`docs/ai-maintenance-log.md` entry written; token budget respected or gated.
