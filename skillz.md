# ARCHITECTURE_MAP — Eternal Skald

## System Overview

```
[ Foundry VTT Core ]
        ↓
   Hooks Layer
        ↓
[ Module Entry Point ]
        ↓
+----------------------+
|  Module Subsystems   |
+----------------------+
   ↓        ↓        ↓
Settings   UI     Socket Layer
   ↓        ↓        ↓
Config   Applications  GM Sync
```

---

## 1. Entry Layer

### main.js / module entry

Responsibilities:

* Register hooks
* Register settings
* Initialize socket handlers
* Initialize API surface

Do NOT:

* Run heavy logic
* Manipulate UI directly

---

## 2. Hooks Layer

Flow:

```
init → setup → ready
            ↓
     render / update hooks
```

Rules:

* Lightweight handlers only
* No blocking operations
* No recursion loops

---

## 3. UI Layer

Components:

* Application windows
* Sheet extensions
* Chat enhancements

Rules:

* No direct data mutation
* Use Document API calls
* Avoid repeated rendering loops

---

## 4. Data Layer

Foundry Documents:

* Actor
* Item
* Scene
* Token

Rules:

* Never mutate directly
* Always use update/create/delete APIs
* Respect permissions

---

## 5. Socket Layer (GM Authority)

Flow:

```
Client → Socket Request → GM → Validation → Update → Broadcast
```

Rules:

* Minimal payloads
* Always validate
* Never trust client input

---

## 6. Settings Layer

* Registered in init phase
* Controls feature toggles
* Must remain backward compatible

---

## 7. libWrapper Layer (Overrides)

Used for:

* Extending Foundry core behavior

Rules:

* Never replace silently
* Always preserve original behavior
* Document override purpose

---

## 8. Risk Zones

HIGH RISK:

* Hook-heavy systems
* Combat interactions
* Canvas manipulation
* Socket synchronization
* Compendium writes

MEDIUM RISK:

* UI rendering
* Actor updates

LOW RISK:

* Settings
* Localization
* Static utilities

---

## 9. Safe Modification Zones

SAFE:

* UI enhancements
* Bug fixes
* Hook optimizations
* Minor refactors
* Logging improvements

REQUIRES APPROVAL:

* Architecture changes
* Data model changes
* Socket redesign
* Dependency additions

---

## 10. Golden Rule

Stability > Features > Clean Architecture > Elegance
