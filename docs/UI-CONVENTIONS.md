# UI Conventions — ApplicationV2 Adoption (U1)

The Eternal Skald targets Foundry VTT **v12+**, where `ApplicationV2` (and its
dialog helper `DialogV2`) replaces the deprecated `Application` / `FormApplication`
classes. This document records the conventions every UI surface in the module
follows, so new contributions stay consistent and future-proof for Foundry v15+.

## 1. New windows: lazy `ApplicationV2` subclass

All bespoke windows are built on `foundry.applications.api.ApplicationV2`. Because
the module's test suite imports every script under plain Node (no Foundry global —
see `test/load-smoke.mjs`), a top-level `class X extends foundry...ApplicationV2`
would throw at import time. We therefore define the subclass **lazily** inside a
factory that returns `null` when the Foundry global is absent:

```js
let _Cls = null;
export function getMyWindowClass() {
  if (_Cls) return _Cls;
  const AppV2 = foundry?.applications?.api?.ApplicationV2;
  if (!AppV2) return null;                 // plain-Node import → no throw
  _Cls = class MyWindow extends AppV2 {
    static DEFAULT_OPTIONS = {
      id: "my-window", tag: "form",
      window: { title: "…", icon: "fas fa-…", resizable: true },
      position: { width: 560, height: 560 },
      form: { handler: MyWindow._onSubmit, closeOnSubmit: true }
    };
    async _renderHTML(ctx, opts) { /* return an HTMLElement */ }
    _replaceHTML(result, content, opts) { content.replaceChildren(result); }
    _onRender(ctx, opts) { /* wire listeners */ }
    static async _onSubmit(event, form, formData) { /* formData.object = values */ }
  };
  return _Cls;
}
```

All presentation/validation helpers (HTML builders, escaping, step logic, etc.)
stay **pure and exported at top level** so they are unit-testable without Foundry.
The lazy factory is the only Foundry-coupled part.

**Examples in the codebase:**
- `scripts/ui/settings-panel.js` — `getSettingsPanelClass()` (S1)
- `scripts/ui/first-run-wizard.js` — `getWizardClass()` (U4)
- `scripts/ui/command-reference.js` — `getReferenceAppClass()` (Doc1)

Register them in the Settings UI with `game.settings.registerMenu(...)` from the
wiring layer (`scripts/hooks/foundry-hooks.js`), never from `scripts/core/settings.js`,
which stays pure registration.

## 2. Prompts / confirmations: `DialogV2` first, classic `Dialog` fallback

Quick confirm / select prompts use `foundry.applications.api.DialogV2` when
available and fall back to the classic `Dialog` only on older cores, so behaviour
degrades gracefully:

```js
const DV2 = foundry?.applications?.api?.DialogV2;
if (DV2?.confirm) { /* preferred modern path */ }
else { new Dialog({ /* classic fallback */ }).render(true); }
```

Every `new Dialog(...)` in the module is a guarded fallback of this kind — see
`scripts/chat/commands.js`, `scripts/narrative/integration.js`,
`scripts/narrative/token-control.js`, `scripts/ironsworn/progress.js`.

## 3. Hard rules (enforced by `test/ui-conventions.test.mjs`)

1. **No `extends FormApplication` and no `extends Application`** anywhere in
   `scripts/` — the deprecated v1 base classes are forbidden.
2. **Every `new Dialog(` must be a fallback** — the same file must also reference
   `DialogV2` (the modern path it falls back from).
3. **Every `scripts/ui/*.js` window module** must build its `ApplicationV2`
   subclass through a lazy factory (so plain-Node import never throws).

These rules keep the module aligned with Foundry's modern application framework
and protect the load-smoke contract.
