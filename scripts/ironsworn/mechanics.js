/* =====================================================================
 *  THE ETERNAL SKALD — Ironsworn controller submodule
 *  System lifecycle, compendium context & item/asset creation.
 *
 *  Extracted verbatim from the former monolithic ironsworn-controller.js
 *  (Phase B / H2 decomposition). These methods are composed onto the single
 *  IronswornController facade via Object.assign in ironsworn-controller.js,
 *  so `this` inside every method still resolves to that one shared object —
 *  cross-method calls (this.getActiveCharacter(), this._foeIndexCache, …)
 *  and shared cache state are unchanged. No behaviour change.
 * ===================================================================== */

import {
  SYSTEM_ID, dbg, warn
} from "./internals.js";

export const MechanicsMethods = {


  /* ---------------- Detection & probing ---------------- */

  /** True iff the active game system is foundry-ironsworn. */
  isActive() {
    try { return game?.system?.id === SYSTEM_ID; }
    catch (_) { return false; }
  },

  /** The CONFIG.IRONSWORN namespace, or null. */
  api() {
    if (!this.isActive()) return null;
    return globalThis.CONFIG?.IRONSWORN ?? null;
  },

  /** True iff the official move pre-roll dialog is available. */
  hasPrerollDialog() {
    const api = this.api();
    return typeof api?.applications?.IronswornPrerollDialog?.showForOfficialMove === "function";
  },

  /**
   * Capability map for the multi-system adapter contract (see
   * systems/adapter-interface.js → SYSTEM_CAPABILITIES). Consumers gate
   * features on these canonical boolean keys: the AI tool registry only
   * offers `updateProgress`/`rollMove`/`queryOracle` when the matching key
   * is true, and `!progress` checks `capabilities().progressTracks`.
   *
   * Ironsworn is the module's native system, so it lights up the full
   * mechanical surface. The keys are inlined (not imported) to keep the
   * rules-bridge layer self-contained. The legacy diagnostic fields
   * (prerollDialog/characterSheet/activeCharacter) are retained additively
   * so existing diagnostics that read them keep working.
   */
  capabilities() {
    return {
      // --- canonical SYSTEM_CAPABILITIES keys ---
      systemActive:     this.isActive(),
      characterReads:   true,
      sheetWrites:      true,
      progressTracks:   true,
      vows:             true,
      oracles:          true,
      momentum:         true,
      impacts:          true,
      moves:            true,
      moveDialogs:      true,
      xp:               true,
      compendiumFoes:   true,
      compendiumAssets: true,
      createCharacter:  true,
      mapVision:        true,
      // --- legacy diagnostic fields (retained for backwards compatibility) ---
      prerollDialog:    this.hasPrerollDialog(),
      characterSheet:   !!this.api()?.applications?.SFCharacterMoveSheet,
      activeCharacter:  !!this.getActiveCharacter()
    };
  },

  /** Drop the cached context index (e.g. after toggling a category). */
  clearContextCache() { this._contextIndexCache = null; dbg("clearContextCache: cleared"); },

  /** Find a loaded pack by its mapped id, tolerant of the bare segment. */
  _findPackById(packId) {
    const want = String(packId ?? "").toLowerCase();
    const seg = want.split(".").pop();
    for (const pack of (game?.packs ?? [])) {
      const id = String(pack.metadata?.id ?? pack.collection ?? "").toLowerCase();
      if (id === want || id.split(".").pop() === seg) return pack;
    }
    return null;
  },

  /**
   * Build (and cache) name lists for every category in CONTEXT_PACK_MAP.
   * Fully defensive: a missing pack logs a warning and is skipped, so the
   * rest of the catalogue still loads. De-duplicated and name-sorted.
   *
   * @returns {Promise<Object<string,string[]>>}
   */
  async _buildContextIndex() {
    if (this._contextIndexCache && typeof this._contextIndexCache === "object") return this._contextIndexCache;
    const out = {};
    for (const [category, packId] of Object.entries(this.CONTEXT_PACK_MAP)) {
      const pack = this._findPackById(packId);
      if (!pack) { warn(`_buildContextIndex: pack "${packId}" not found — skipping ${category}`); out[category] = []; continue; }
      try {
        const index = await pack.getIndex();
        const seen = new Set();
        const names = [];
        for (const e of index) {
          const name = String(e?.name ?? "").trim();
          const key = name.toLowerCase();
          if (!name || seen.has(key)) continue;
          seen.add(key);
          names.push(name);
        }
        names.sort((a, b) => a.localeCompare(b));
        out[category] = names;
      } catch (e) {
        warn(`_buildContextIndex: failed to index "${packId}":`, e?.message ?? e);
        out[category] = [];
      }
    }
    this._contextIndexCache = out;
    dbg(`_buildContextIndex: indexed ${Object.values(out).reduce((n, a) => n + a.length, 0)} entries across ${Object.keys(out).length} categories`);
    return out;
  },

  /**
   * Synchronous read of a cached category's names. Returns [] until
   * {@link _buildContextIndex} has primed the cache (on `ready`), so the
   * prompt builder degrades gracefully.
   *
   * @param {string} category one of CONTEXT_PACK_MAP's keys
   * @returns {string[]}
   */
  getCompendiumContextNames(category) {
    const c = this._contextIndexCache;
    if (!c || typeof c !== "object") return [];
    const list = c[category];
    return Array.isArray(list) ? list.slice() : [];
  },

  /** Drop the cached asset index (e.g. after enabling an asset module). */
  clearAssetCache() {
    this._assetIndexCache = null;
    dbg("clearAssetCache: asset index cache cleared");
  },

  /**
   * Item compendium packs that look like asset catalogs. Covers Ironsworn,
   * Delve, Starforged and Sundered Isles asset packs, plus any third-party
   * pack whose id/label mentions assets.
   */
  _assetPacks() {
    const out = [];
    for (const pack of (game?.packs ?? [])) {
      try {
        if (pack.documentName !== "Item") continue;
        const id = String(pack.metadata?.id ?? pack.collection ?? "");
        const label = String(pack.metadata?.label ?? pack.title ?? "");
        if (/asset/i.test(id) || /asset/i.test(label)) out.push(pack);
      } catch (_) {}
    }
    return out;
  },

  /**
   * Build (and cache) a flat index of every asset across the asset packs:
   * [{ name, lc, uuid, packId, _id }]. Returns the cached array on repeat
   * calls. Never throws — returns [] on failure.
   *
   * @returns {Promise<Array<{name:string, lc:string, uuid:string, packId:string, _id:string}>>}
   */
  async _buildAssetIndex() {
    if (Array.isArray(this._assetIndexCache)) return this._assetIndexCache;
    const entries = [];
    for (const pack of this._assetPacks()) {
      try {
        const index = await pack.getIndex();
        const packId = String(pack.metadata?.id ?? pack.collection ?? "");
        for (const e of (index?.contents ?? index ?? [])) {
          const name = (e?.name ?? "").trim();
          if (!name) continue;
          entries.push({
            name,
            lc: name.toLowerCase(),
            uuid: e.uuid ?? `Compendium.${packId}.${e._id}`,
            packId,
            _id: e._id
          });
        }
      } catch (e) {
        warn(`_buildAssetIndex: failed to index "${pack?.metadata?.id}":`, e?.message ?? e);
      }
    }
    this._assetIndexCache = entries;
    dbg(`_buildAssetIndex: indexed ${entries.length} asset(s) from ${this._assetPacks().length} pack(s)`);
    return entries;
  },

  /**
   * Synchronous read of the cached asset names (for the EntityLinker, whose
   * index build is synchronous). Returns [] until {@link _buildAssetIndex}
   * has populated the cache (primed on `ready`). Never triggers a build.
   *
   * @returns {Array<{name:string, uuid:string}>}
   */
  getAssetNames() {
    return Array.isArray(this._assetIndexCache)
      ? this._assetIndexCache.map(a => ({ name: a.name, uuid: a.uuid }))
      : [];
  },

  /**
   * Look up an asset by name in the asset compendia. Matching, best → worst:
   * exact (case-insensitive) → normalised-equal → substring → token overlap
   * → close edit-distance. Reuses the foe-matcher's helpers.
   *
   * @param {string} assetName
   * @returns {Promise<{found:boolean, name:string|null, uuid?:string, packId?:string, match?:string, suggestion?:string}>}
   */
  async lookupAssetInCompendium(assetName) {
    const result = { found: false, name: assetName ?? null };
    if (!assetName || !this.isActive()) return result;
    let index;
    try { index = await this._buildAssetIndex(); }
    catch (e) { warn("lookupAssetInCompendium failed:", e?.message ?? e); return result; }
    if (!index.length) return result;

    const lc = String(assetName).toLowerCase().trim();
    const norm = this._normName(assetName);

    let hit = index.find(e => e.lc === lc);
    let match = hit ? "exact" : null;

    if (!hit) { hit = index.find(e => this._normName(e.name) === norm); if (hit) match = "normalized"; }

    if (!hit && norm) {
      const subs = index.filter(e => {
        const en = this._normName(e.name);
        return en && (en.includes(norm) || norm.includes(en));
      });
      if (subs.length) {
        subs.sort((a, b) => Math.abs(this._normName(a.name).length - norm.length)
                          - Math.abs(this._normName(b.name).length - norm.length));
        hit = subs[0]; match = "substring";
      }
    }

    if (!hit && norm) {
      const qTokens = new Set(norm.split(" ").filter(t => t.length >= 3));
      let best = null, bestScore = 0;
      for (const e of index) {
        const eTokens = this._normName(e.name).split(" ").filter(t => t.length >= 3);
        const overlap = eTokens.filter(t => qTokens.has(t)).length;
        if (overlap > bestScore) { bestScore = overlap; best = e; }
      }
      if (best && bestScore > 0) { hit = best; match = "token"; }
    }

    if (!hit && norm.length >= 4) {
      let best = null, bestDist = Infinity;
      for (const e of index) {
        const d = this._editDistance(norm, this._normName(e.name));
        if (d < bestDist) { bestDist = d; best = e; }
      }
      const tol = Math.min(3, Math.max(2, Math.floor(norm.length * 0.25)));
      if (best && bestDist <= tol) { hit = best; match = "fuzzy"; }
      else if (best && bestDist <= tol + 2) result.suggestion = best.name;
    }

    if (hit) {
      dbg(`lookupAssetInCompendium: "${assetName}" → "${hit.name}" via ${match} (${hit.packId})`);
      return { found: true, name: hit.name, uuid: hit.uuid, packId: hit.packId, match };
    }
    return result;
  },

  /**
   * Open / display an asset card. Resolves a UUID (preferred) or a name to
   * the asset Document and renders its sheet. Falls back to a chat card with
   * the asset's description when no sheet is available. Fully defensive.
   *
   * @param {string} ref  asset UUID (Compendium.…) or asset name
   * @returns {Promise<{ok:boolean, method:string, error?:string}>}
   */
  async showAsset(ref) {
    try {
      if (!this.isActive()) return { ok: false, method: "none", error: "Ironsworn system not active." };
      if (!ref) return { ok: false, method: "none", error: "No asset reference." };

      let doc = null;
      // 1) Direct UUID resolution (works for Compendium.* and world Items).
      if (/^(Compendium|Item|Actor)\./.test(String(ref))) {
        try { doc = await fromUuid(ref); } catch (_) { /* fall through to name lookup */ }
      }
      // 2) Name lookup via the compendium index.
      if (!doc) {
        const found = await this.lookupAssetInCompendium(ref);
        if (found.found && found.uuid) {
          try { doc = await fromUuid(found.uuid); } catch (_) {}
        }
      }
      if (!doc) return { ok: false, method: "none", error: `Asset "${ref}" not found.` };

      if (doc.sheet?.render) {
        doc.sheet.render(true);
        return { ok: true, method: "sheet" };
      }
      return { ok: false, method: "none", error: "Asset has no renderable sheet." };
    } catch (e) {
      warn(`showAsset("${ref}") failed:`, e?.message ?? e);
      return { ok: false, method: "sheet", error: e?.message ?? String(e) };
    }
  },

  /**
   * Clone a compendium Document's data into a plain object suitable for
   * creation, stripping identity/ownership fields so the new copy gets a
   * fresh id and sane defaults. Never throws.
   */
  _cleanForCreate(doc) {
    let data;
    try { data = typeof doc?.toObject === "function" ? doc.toObject() : foundry.utils.deepClone(doc); }
    catch (_) { data = {}; }
    for (const k of ["_id", "_stats", "_key", "ownership", "folder", "sort"]) {
      try { delete data[k]; } catch (_) {}
    }
    // Embedded items (e.g. a foe actor's progress track) also carry _ids
    // that must be dropped so they are re-created cleanly.
    if (Array.isArray(data.items)) {
      data.items = data.items.map(it => {
        const c = { ...it };
        for (const k of ["_id", "_stats", "_key", "ownership", "folder"]) { try { delete c[k]; } catch (_) {} }
        return c;
      });
    }
    return data;
  },

  /** Case-insensitive: does `actor` already own an Item of this name (+ optional type)? */
  _actorHasItemNamed(actor, name, type = null) {
    const lc = String(name ?? "").toLowerCase().trim();
    if (!lc || !actor?.items) return false;
    for (const it of actor.items) {
      if (type && it?.type !== type) continue;
      if (String(it?.name ?? "").toLowerCase().trim() === lc) return true;
    }
    return false;
  },

  /**
   * Add an ASSET from the asset compendia to the active character. Looks the
   * asset up by name (fuzzy), then creates a copy of it as an embedded Item
   * on the actor via the Document API. Idempotent: if the actor already owns
   * an asset of that name it is a no-op (unless `allowDuplicate`).
   *
   * @param {Actor}  actor
   * @param {string} assetName
   * @param {{allowDuplicate?:boolean}} [opts]
   * @returns {Promise<{ok:boolean, name?:string, matchedName?:string, uuid?:string, match?:string, id?:string, noop?:boolean, suggestion?:string, error?:string}>}
   */
  async addAssetToActor(actor, assetName, { allowDuplicate = false } = {}) {
    if (!actor) return { ok: false, error: "No active character." };
    if (!this.isActive()) return { ok: false, error: "Ironsworn system not active." };
    if (!assetName) return { ok: false, error: "No asset name given." };

    let lookup;
    try { lookup = await this.lookupAssetInCompendium(assetName); }
    catch (e) { return { ok: false, error: e?.message ?? String(e) }; }
    if (!lookup?.found || !lookup.uuid) {
      return { ok: false, error: `Asset "${assetName}" not found in the compendia.`, suggestion: lookup?.suggestion };
    }

    if (!allowDuplicate && this._actorHasItemNamed(actor, lookup.name, "asset")) {
      dbg(`addAssetToActor: "${lookup.name}" already owned — no-op`);
      return { ok: true, noop: true, name: lookup.name, matchedName: lookup.name, uuid: lookup.uuid, match: lookup.match };
    }

    let doc;
    try { doc = await fromUuid(lookup.uuid); }
    catch (e) { return { ok: false, error: `Could not load asset "${lookup.name}": ${e?.message ?? e}` }; }
    if (!doc) return { ok: false, error: `Could not load asset "${lookup.name}".` };

    const data = this._cleanForCreate(doc);
    try {
      const [created] = await actor.createEmbeddedDocuments("Item", [data]);
      dbg(`addAssetToActor: added "${lookup.name}" to "${actor.name}" (id=${created?.id})`);
      return { ok: true, name: created?.name ?? lookup.name, matchedName: lookup.name, uuid: lookup.uuid, match: lookup.match, id: created?.id };
    } catch (e) {
      warn("addAssetToActor failed:", e?.message ?? e);
      return { ok: false, error: e?.message ?? String(e) };
    }
  },

  /**
   * Add an arbitrary compendium ITEM (asset, move, delve theme/domain, …) to
   * a character by name. Searches every Item compendium pack (newest-style
   * `documentName === "Item"`), excluding the foe/encounter packs (those are
   * NPC catalogue entries, not character items). Idempotent by name.
   *
   * @param {Actor}  actor
   * @param {string} itemName
   * @param {{allowDuplicate?:boolean, types?:string[]}} [opts]  optional Item-type filter
   * @returns {Promise<{ok:boolean, name?:string, matchedName?:string, type?:string, packId?:string, match?:string, id?:string, noop?:boolean, suggestion?:string, error?:string}>}
   */
  async addItemToActor(actor, itemName, { allowDuplicate = false, types = null } = {}) {
    if (!actor) return { ok: false, error: "No active character." };
    if (!this.isActive()) return { ok: false, error: "Ironsworn system not active." };
    if (!itemName) return { ok: false, error: "No item name given." };

    // Build a candidate list across Item packs (excluding foe/encounter packs).
    const lc = String(itemName).toLowerCase().trim();
    const norm = this._normName(itemName);
    const typeSet = Array.isArray(types) && types.length ? new Set(types) : null;
    let exact = null, normHit = null, sub = null, suggestion = null, bestDist = Infinity;

    for (const pack of (game?.packs ?? [])) {
      try {
        if (pack.documentName !== "Item") continue;
        const id = String(pack.metadata?.id ?? pack.collection ?? "");
        const label = String(pack.metadata?.label ?? pack.title ?? "");
        if (/foe|encounter|bestiar|monster/i.test(id) || /foe|encounter|bestiar|monster/i.test(label)) continue;
        const index = await pack.getIndex({ fields: ["type"] });
        for (const e of (index?.contents ?? index ?? [])) {
          const name = (e?.name ?? "").trim();
          if (!name) continue;
          if (typeSet && e.type && !typeSet.has(e.type)) continue;
          const eLc = name.toLowerCase();
          const eNorm = this._normName(name);
          const cand = { name, type: e.type, uuid: e.uuid ?? `Compendium.${id}.${e._id}`, packId: id, _id: e._id };
          if (eLc === lc && !exact) exact = cand;
          if (eNorm === norm && !normHit) normHit = cand;
          if (!sub && norm && eNorm && (eNorm.includes(norm) || norm.includes(eNorm))) sub = cand;
          if (norm.length >= 4) {
            const d = this._editDistance(norm, eNorm);
            if (d < bestDist) { bestDist = d; suggestion = name; }
          }
        }
      } catch (e) { warn(`addItemToActor: index "${pack?.metadata?.id}" failed:`, e?.message ?? e); }
      if (exact) break;   // exact wins immediately
    }

    const hit = exact || normHit || sub;
    if (!hit) {
      const tol = Math.min(3, Math.max(2, Math.floor(norm.length * 0.25)));
      return { ok: false, error: `Item "${itemName}" not found in the compendia.`, suggestion: (bestDist <= tol + 2 ? suggestion : undefined) };
    }

    if (!allowDuplicate && this._actorHasItemNamed(actor, hit.name)) {
      dbg(`addItemToActor: "${hit.name}" already owned — no-op`);
      return { ok: true, noop: true, name: hit.name, matchedName: hit.name, type: hit.type, packId: hit.packId };
    }

    let doc;
    try { doc = await fromUuid(hit.uuid); }
    catch (e) { return { ok: false, error: `Could not load item "${hit.name}": ${e?.message ?? e}` }; }
    if (!doc) return { ok: false, error: `Could not load item "${hit.name}".` };

    const data = this._cleanForCreate(doc);
    try {
      const [created] = await actor.createEmbeddedDocuments("Item", [data]);
      dbg(`addItemToActor: added "${hit.name}" (${hit.type}) to "${actor.name}" (id=${created?.id})`);
      return { ok: true, name: created?.name ?? hit.name, matchedName: hit.name, type: created?.type ?? hit.type, packId: hit.packId, id: created?.id };
    } catch (e) {
      warn("addItemToActor failed:", e?.message ?? e);
      return { ok: false, error: e?.message ?? String(e) };
    }
  }
};
