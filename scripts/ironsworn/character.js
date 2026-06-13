/* =====================================================================
 *  THE ETERNAL SKALD — Ironsworn controller submodule
 *  Character reads, sheet description & character creation.
 *
 *  Extracted verbatim from the former monolithic ironsworn-controller.js
 *  (Phase B / H2 decomposition). These methods are composed onto the single
 *  IronswornController facade via Object.assign in ironsworn-controller.js,
 *  so `this` inside every method still resolves to that one shared object —
 *  cross-method calls (this.getActiveCharacter(), this._foeIndexCache, …)
 *  and shared cache state are unchanged. No behaviour change.
 * ===================================================================== */

import {
  SYSTEM_ID, ES_SCOPE, dbg, warn, STAT_KEYS, METER_KEYS
} from "./internals.js";

export const CharacterMethods = {


  /* =================================================================
   *  READ — character, stats, meters, debilities, progress tracks
   * ================================================================= */

  /**
   * Resolve "the actor the Skald should act for" with the same priority
   * the Ironsworn dialog uses: controlled token → user's character →
   * sole owned character.
   */
  getActiveCharacter() {
    try {
      const controlled = canvas?.tokens?.controlled?.[0]?.actor;
      if (controlled) return controlled;
      if (game?.user?.character) return game.user.character;
      const owned = (game?.actors ?? []).filter(a =>
        a?.type === "character" && a.testUserPermission?.(game.user, "OWNER"));
      return owned.length === 1 ? owned[0] : null;
    } catch (e) {
      warn("getActiveCharacter failed:", e?.message ?? e);
      return null;
    }
  },

  /**
   * (v0.10.36 — Phase 2) Read the character's BONDS. foundry-ironsworn stores
   * bonds inside a single embedded Item of `type === "bondset"`, whose
   * `system.bonds` is an array of `{ name, notes }`. The character's
   * `system.legacies.bonds` ProgressTicks counter (Starforged) is reported
   * separately by {@link getExperience}; this returns the narrative bond
   * entries the player has forged. READ-ONLY, synchronous, null-guarded.
   *
   * @param {Actor} actor
   * @param {{limit?:number}} [opts]
   * @returns {Array<{name:string, notes:string}>} possibly empty, never null.
   */
  getBonds(actor, { limit = 20 } = {}) {
    if (!actor?.items) return [];
    const out = [];
    for (const item of actor.items) {
      if (item?.type !== "bondset") continue;
      const bonds = foundry.utils.getProperty(item, "system.bonds");
      if (!Array.isArray(bonds)) continue;
      for (const b of bonds) {
        const name = String(b?.name ?? "").trim();
        if (!name) continue;
        // Strip HTML from notes so the AI snapshot stays plain text.
        const notes = String(b?.notes ?? "").replace(/<[^>]*>/g, "").trim();
        out.push({ name, notes });
        if (out.length >= limit) return out;
      }
    }
    return out;
  },

  /**
   * (v0.10.25 — asset tracking) Read the character's owned ASSET Items
   * (companions, paths, combat talents, rituals, …) and summarise them in
   * an AI-friendly, token-efficient shape. READ-ONLY and synchronous, so it
   * mirrors {@link getProgressTracks} and is safe to call from the prompt
   * builder on every turn.
   *
   * The foundry-ironsworn AssetModel stores each asset as an embedded Item of
   * `type === "asset"`, whose `system` carries:
   *   • `category`   — e.g. "Companion" | "Path" | "Combat Talent" | "Ritual".
   *   • `abilities[]` — ordered list; each `{ name, enabled, description, … }`.
   *                     The count of `enabled === true` entries says how far the
   *                     asset is unlocked/upgraded.
   *   • `track`       — optional asset condition meter `{ enabled, name,
   *                     value, min, max }` (e.g. a companion's health).
   *
   * Every read is null-guarded via `foundry.utils.getProperty`, so an asset
   * authored under an older/newer schema degrades to sensible defaults rather
   * than throwing.
   *
   * @param {Actor}  actor                the actor to read (may be null).
   * @param {object} [opts]
   * @param {number} [opts.limit=12]      max assets to return (token budget).
   * @returns {Array<{id:string,name:string,category:(string|null),
   *   unlocked:number,total:number,
   *   track:({name:string,value:(number|null),max:(number|null)}|null)}>}
   *   A (possibly empty) array — never null.
   */
  getAssets(actor, { limit = 12 } = {}) {
    if (!actor?.items) return [];
    const out = [];
    for (const item of actor.items) {
      if (item?.type !== "asset") continue;
      const abilities = foundry.utils.getProperty(item, "system.abilities");
      const list = Array.isArray(abilities) ? abilities : [];
      const unlocked = list.filter(a => a?.enabled === true).length;
      // (v0.10.36 — Phase 2) Surface the TEXT of each enabled ability so the
      // AI knows what the asset actually lets the character DO, not just how
      // many boxes are ticked. HTML is stripped and each line trimmed to keep
      // the snapshot token-efficient.
      const enabledAbilities = list
        .filter(a => a?.enabled === true)
        .map(a => String(a?.description ?? "").replace(/<[^>]*>/g, "").trim())
        .filter(Boolean)
        .map(d => (d.length > 220 ? d.slice(0, 217) + "…" : d));
      const track = foundry.utils.getProperty(item, "system.track") ?? null;
      const hasTrack = track && typeof track === "object" && track.enabled === true;
      // The asset condition meter is stored as `current` in template.json;
      // older data used `value`. Accept either so both schemas read cleanly.
      const trackVal = (hasTrack && typeof track.current === "number") ? track.current
                     : (hasTrack && typeof track.value === "number")   ? track.value
                     : null;
      out.push({
        id: item.id,
        name: item.name,
        category: foundry.utils.getProperty(item, "system.category") ?? null,
        unlocked,
        total: list.length,
        abilities: enabledAbilities,
        track: hasTrack
          ? {
              name: track.name || "track",
              value: trackVal,
              max: typeof track.max === "number" ? track.max : null
            }
          : null
      });
      if (out.length >= limit) break;
    }
    return out;
  },

  /**
   * (v0.10.25 — XP tracking) Read the character's experience in a unified,
   * model-agnostic shape, covering BOTH Ironsworn rulesets:
   *   • Classic Ironsworn — a single integer counter at `system.xp`
   *     (experience earned to date).
   *   • Starforged — three legacy tracks under `system.legacies`
   *     (`quests`, `bonds`, `discoveries`), each a ProgressTicks value, with a
   *     paired `*XpSpent` counter recording XP already spent from that legacy.
   *
   * The two models are not mutually exclusive in data, so both are read and
   * returned independently; callers decide what to surface. Fully null-guarded
   * and never throws — absent fields come back as `null`.
   *
   * @param {Actor} actor   the actor to read (may be null).
   * @returns {{xp:(number|null),
   *   legacies:({quests:number,questsXpSpent:number,
   *     bonds:number,bondsXpSpent:number,
   *     discoveries:number,discoveriesXpSpent:number}|null)}}
   */
  getExperience(actor) {
    if (!actor) return { xp: null, legacies: null };
    const xpRaw = foundry.utils.getProperty(actor, "system.xp");
    const xp = typeof xpRaw === "number" ? xpRaw : null;

    const L = foundry.utils.getProperty(actor, "system.legacies");
    const num = (v) => (typeof v === "number" ? v : 0);
    const legacies = (L && typeof L === "object")
      ? {
          quests:             num(L.quests),
          questsXpSpent:      num(L.questsXpSpent),
          bonds:              num(L.bonds),
          bondsXpSpent:       num(L.bondsXpSpent),
          discoveries:        num(L.discoveries),
          discoveriesXpSpent: num(L.discoveriesXpSpent)
        }
      : null;

    return { xp, legacies };
  },

  /**
   * Detect which Ironsworn ruleset family decides HOW experience is recorded.
   * foundry-ironsworn exposes four boolean world settings (one per rules
   * package). We collapse them to two XP write models:
   *   • "classic"    — single integer counter at `system.xp` (classic, delve)
   *   • "starforged" — legacy tracks under `system.legacies` (starforged,
   *                    sundered isles)
   * Defaults to "classic" when nothing is readable — it is the safest model
   * and the field every character carries.
   *
   * @returns {"classic"|"starforged"}
   */
  getRuleset() {
    try {
      const flag = (k) => {
        try { return game?.settings?.get?.(SYSTEM_ID, k) === true; } catch (_) { return false; }
      };
      const classic = flag("ruleset-classic");
      const delve   = flag("ruleset-delve");
      const sf      = flag("ruleset-starforged");
      const si      = flag("ruleset-sundered_isles");
      // Classic/Delve take priority — `system.xp` is the simplest, universal
      // model. Only when ONLY a Starforged-family ruleset is on do we switch.
      if (classic || delve) return "classic";
      if (sf || si) return "starforged";
    } catch (_) { /* fall through */ }
    return "classic";
  },

  /** Convenience predicate — true when the active ruleset uses legacy tracks. */
  isStarforgedRuleset() {
    return this.getRuleset() === "starforged";
  },

  /**
   * Produce a compact, AI-friendly description of a character's full
   * mechanical state. Returns "" when no character is resolvable so the
   * prompt builder can omit the section cleanly.
   */
  describeCharacter(actor = this.getActiveCharacter()) {
    if (!this.isActive()) return "";
    if (!actor) return "(No active Ironsworn character could be resolved — select a token or set your player character.)";

    const lines = [`Character: ${actor.name}`];

    const stats = this.getStats(actor);
    const statStr = STAT_KEYS
      .map(s => `${s[0].toUpperCase()}${s.slice(1)} ${stats[s] ?? "?"}`)
      .join(", ");
    lines.push(`Stats: ${statStr}`);

    const meters = this.getMeters(actor);
    const meterStr = METER_KEYS
      .map(k => {
        const m = meters[k];
        if (!m) return null;
        // Show value/max so the AI respects the meter's ceiling (health/
        // spirit/supply cap at 5; momentum at its momentumMax, default 10).
        return (typeof m.max === "number") ? `${k} ${m.value}/${m.max}` : `${k} ${m.value}`;
      })
      .filter(Boolean)
      .join(", ");
    if (meterStr) lines.push(`Meters: ${meterStr}`);

    const debilities = this.getDebilities(actor);
    if (debilities.length) lines.push(`Debilities: ${debilities.join(", ")}`);

    // (v0.10.26 — Phase 1 context) Progress tracks, grouped and explicitly
    // labelled FULL / NOT YET FULL, with the ACTIVE combat and the STORY FOCUS
    // vow marked. The fullness label tells the AI plainly whether a completion
    // move (Fulfill Your Vow / End the Fight / Reach Your Destination) is even
    // available yet — preventing it from concluding a track before 10/10.
    const tracks = this.getProgressTracks(actor);
    if (tracks.length) {
      const isVow = t => t.kind === "vow" || t.subtype === "vow";
      const isCombat = t => t.kind === "combat" || t.subtype === "foe";
      const isJourney = t =>
        (t.kind === "journey") ||
        (!t.kind && !isVow(t) && !isCombat(t)
         && t.subtype !== "bond" && t.subtype !== "connection" && t.subtype !== "bondset");

      const activeCombat = this.getActiveCombat(actor);
      const focusVow     = this.identifyStoryFocusVow(actor);

      const fmt = (t, kind) => {
        const rank = t.rank ? ` [${this.normalizeRank(t.rank)}]` : "";
        return `${t.name}${rank}: ${this.fullnessLabel(t.boxes, t.completed, kind)}`;
      };

      lines.push("PROGRESS TRACKS:");

      // ACTIVE COMBAT — at most one in Ironsworn; surface it first and flagged.
      if (activeCombat) {
        lines.push(`  ⚔️ ACTIVE COMBAT — ${fmt(activeCombat, "combat")}`);
      }

      const openVows     = tracks.filter(t => !t.completed && isVow(t));
      const openJourneys = tracks.filter(t => !t.completed && !isVow(t) && isJourney(t));

      if (openVows.length) {
        lines.push("  VOWS:");
        for (const t of openVows.slice(0, 8)) {
          const focus = focusVow && focusVow.id === t.id ? "[STORY FOCUS] " : "";
          lines.push(`    📜 ${focus}${fmt(t, "vow")}`);
        }
      }
      if (openJourneys.length) {
        lines.push("  JOURNEYS:");
        for (const t of openJourneys.slice(0, 8)) {
          lines.push(`    🗺️ ${fmt(t, "journey")}`);
        }
      }

      // Any other / completed tracks (bonds, finished arcs) for completeness.
      const others = tracks.filter(t =>
        t.completed || (!isVow(t) && !isJourney(t) && !(activeCombat && t.id === activeCombat.id)));
      for (const t of others.slice(0, 6)) {
        lines.push(`    • ${fmt(t, t.kind || "vow")}`);
      }

      // Reference-by-exact-title lines (kept from prior versions) so the AI can
      // target the right named track in mark-progress / completion directives.
      const openVowTitles     = openVows.map(t => `"${t.name}"`);
      const openJourneyTitles = openJourneys.map(t => `"${t.name}"`);
      if (openVowTitles.length)     lines.push(`Open vows (reference by EXACT title): ${openVowTitles.join(", ")}`);
      if (openJourneyTitles.length) lines.push(`Open journeys (reference by EXACT title): ${openJourneyTitles.join(", ")}`);
    }

    // (v0.10.25) ASSETS — companions, paths, talents, rituals. Surfaced by
    // EXACT name plus unlock progress and any condition meter, so the AI can
    // reference what the character actually owns instead of inventing kit.
    const assets = this.getAssets(actor);
    if (assets.length) {
      lines.push("Assets:");
      for (const a of assets) {
        const cat   = a.category ? ` (${a.category})` : "";
        const prog  = a.total ? ` — ${a.unlocked}/${a.total} abilities` : "";
        const track = a.track
          ? `; ${a.track.name} ${a.track.value ?? "?"}${a.track.max != null ? `/${a.track.max}` : ""}`
          : "";
        lines.push(`  - ${a.name}${cat}${prog}${track}`);
        // (v0.10.36 — Phase 2) List the enabled ability text so the AI knows
        // the concrete capabilities this asset grants the character.
        if (Array.isArray(a.abilities)) {
          for (const ab of a.abilities) lines.push(`      • ${ab}`);
        }
      }
    }

    // (v0.10.36 — Phase 2) BONDS — the narrative connections the character has
    // forged (foundry-ironsworn "bondset" item). Surfaced so the AI can honour
    // existing relationships instead of inventing or contradicting them.
    const bonds = this.getBonds(actor);
    if (bonds.length) {
      lines.push("Bonds:");
      for (const b of bonds) {
        const note = b.notes ? ` — ${b.notes.length > 160 ? b.notes.slice(0, 157) + "…" : b.notes}` : "";
        lines.push(`  - ${b.name}${note}`);
      }
    }

    // (v0.10.25) EXPERIENCE — classic Ironsworn `xp` counter and/or the
    // Starforged legacy tracks. Either may be absent depending on ruleset, so
    // each is surfaced only when present.
    const xpInfo = this.getExperience(actor);
    if (xpInfo.xp != null) lines.push(`Experience: ${xpInfo.xp} XP earned`);
    if (xpInfo.legacies) {
      const L = xpInfo.legacies;
      lines.push(`Legacies (ticks): Quests ${L.quests}, Bonds ${L.bonds}, Discoveries ${L.discoveries}`);
    }

    return lines.join("\n");
  },

  /**
   * Create a blank PLAYER CHARACTER actor (type "character") with sensible,
   * rules-legal default stats and full meters. Optionally seed starting assets
   * by name. Returns the new actor's id.
   *
   * @param {string} name
   * @param {{stats?:object, assets?:string[], folder?:string}} [opts]
   * @returns {Promise<{ok:boolean, name?:string, actorId?:string, uuid?:string, assetsAdded?:string[], error?:string}>}
   */
  async createCharacter(name, { stats = null, assets = null, folder = null } = {}) {
    if (!this.isActive()) return { ok: false, error: "Ironsworn system not active." };
    if (!name) return { ok: false, error: "No character name given." };
    if (typeof Actor === "undefined" || typeof Actor.create !== "function") {
      return { ok: false, error: "Actor.create is unavailable." };
    }

    // Merge caller stats over the defaults, clamping each to STAT_MIN–STAT_MAX.
    const s = { ...this.DEFAULT_CHARACTER_STATS };
    if (stats && typeof stats === "object") {
      for (const k of Object.keys(this.DEFAULT_CHARACTER_STATS)) {
        const v = Number(stats[k]);
        if (Number.isFinite(v)) s[k] = Math.max(this.STAT_MIN, Math.min(this.STAT_MAX, Math.round(v)));
      }
    }
    const data = {
      name,
      type: "character",
      system: {
        edge: s.edge, heart: s.heart, iron: s.iron, shadow: s.shadow, wits: s.wits,
        health: 5, spirit: 5, supply: 5,
        momentum: 2, momentumReset: 2, momentumMax: 10
      },
      flags: { [ES_SCOPE]: { createdBy: "eternal-skald" } }
    };
    if (folder) data.folder = folder;

    let actor;
    try { actor = await Actor.create(data); }
    catch (e) { warn("createCharacter failed:", e?.message ?? e); return { ok: false, error: e?.message ?? String(e) }; }
    if (!actor) return { ok: false, error: "Actor.create returned nothing." };

    const assetsAdded = [];
    if (Array.isArray(assets) && assets.length) {
      for (const a of assets) {
        try { const r = await this.addAssetToActor(actor, a); if (r?.ok && !r.noop) assetsAdded.push(r.name); }
        catch (_) {}
      }
    }
    dbg(`createCharacter: created "${name}" (id=${actor.id})${assetsAdded.length ? `, assets: ${assetsAdded.join(", ")}` : ""}`);
    return { ok: true, name: actor.name, actorId: actor.id, uuid: actor.uuid, assetsAdded };
  }
};
