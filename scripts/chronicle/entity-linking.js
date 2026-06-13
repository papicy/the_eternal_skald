import { LOG_PREFIX, MODULE_ID } from "../core/constants.js";
import { Settings } from "../core/settings.js";
import { escapeHtml, formatMarkdown } from "../chat/display.js";
import { IronswornData } from "../ironsworn-data.js";
// Phase 2: move / progress-track / asset entity recognition is resolved
// through the active system adapter instead of a hard Ironsworn import. For an
// Ironsworn world `getActiveAdapter()` returns the same IronswornController
// (identical behaviour); on any other / no system it returns the NullAdapter,
// whose isActive() is false, so these system-specific link kinds are skipped.
import { getActiveAdapter } from "../systems/registry.js";
import { JournalSystem } from "./journal-system.js";
// Call-time cross-imports (safe cycle): Integration (-> narrative step 9) and
// OracleInterpreter (-> narrative step 8) still live in eternal-skald.js.
import { Integration } from "../narrative/integration.js";
import { OracleInterpreter } from "../narrative/generators.js";

/**
 * Turns plain entity names the Skald narrates into clickable links.
 *
 * Several sources are cross-referenced:
 *   1. The Living Chronicle — auto-scribed NPC / location / discovery
 *      Journal Entries. Matches become Foundry content links
 *      (`@UUID[JournalEntry.id]{Name}`) which Foundry auto-enriches in the
 *      chat log into clickable links that open the entry.
 *   2. The Ironsworn move catalog. Matches become a custom in-chat link
 *      that, when clicked, offers a one-click roll (wired by
 *      {@link Integration.wireSuggestionCard}). Move matching is
 *      case-SENSITIVE so ordinary verbs ("you strike the wolf") are never
 *      mistaken for the move ("make a Strike").
 *   3. The Ironsworn oracle tables (IronswornData.oracles). Oracle labels
 *      ("Action Oracle", "Pay the Price Oracle", …) become links that roll
 *      the oracle via {@link OracleInterpreter}. Case-SENSITIVE to avoid
 *      matching common words like "action"/"region".
 *   4. Progress tracks on the active character (vows, journeys, bonds,
 *      combat tracks). Matches become links that show the track's status
 *      and offer to mark progress. Case-insensitive (proper-noun-ish names).
 *   5. Assets from the system's compendia (Companions, Paths, Rituals, …),
 *      read from an async-built, cached index on {@link IronswornController}.
 *      Matches become links that open the asset's card. Case-insensitive.
 *
 * The index is built lazily and cached, and invalidated whenever a journal
 * entry is created / updated / deleted or the world reloads. The whole
 * feature is additive and wrapped in try/catch: if anything goes wrong the
 * original (already-formatted) HTML is returned untouched, so narration is
 * never broken by linking.
 */
export const EntityLinker = {
  /** @type {{regex: RegExp, byName: Map<string, object>}|null} */
  _cache: null,
  _dirty: true,

  /**
   * (v0.9.0) Memoised journal sub-index. Scanning every JournalEntry (and
   * extracting its aliases) is by far the most expensive part of a rebuild,
   * and for large campaigns (100+ entries) it dominates. We cache the parsed
   * result keyed by {@link JournalSystem.journalGeneration}, so it is only
   * re-scanned when a chronicle entry is actually created / renamed / deleted
   * — NOT on the far more frequent item/actor/token changes that merely
   * affect the (cheap) move/track/asset portions of the index.
   * @type {{gen: number, list: Array<[string, object]>}|null}
   */
  _journalCache: null,

  /**
   * Mark the cached index stale; it rebuilds (lazily) on next use. The
   * journal sub-index is preserved unless the journal generation changed,
   * so frequent non-journal invalidations stay cheap (v0.9.0).
   */
  invalidate() { this._dirty = true; this._cache = null; },

  /**
   * (v0.9.0) Drop ALL caches including the journal sub-index. Used when the
   * journal collection itself changes so the next rebuild re-scans journals.
   */
  invalidateJournal() {
    this._dirty = true;
    this._cache = null;
    this._journalCache = null;
  },

  /**
   * (v0.9.0) Build (or reuse) the journal entity sub-index: an array of
   * `[lowercaseKey, descriptor]` pairs for every chronicle NPC / location /
   * discovery and its aliases. Cached against the journal generation counter
   * so repeated narrations within a stable journal state pay the scan cost
   * only once. Defensive: any failure yields an empty list (links degrade
   * gracefully, narration is never broken).
   * @returns {Array<[string, object]>}
   */
  _journalSubindex() {
    let gen = 0;
    try {
      gen = (typeof JournalSystem !== "undefined" && typeof JournalSystem.journalGeneration === "function")
        ? JournalSystem.journalGeneration() : 0;
    } catch (_) { gen = 0; }

    if (this._journalCache && this._journalCache.gen === gen) {
      return this._journalCache.list;
    }

    const list = [];
    const seenKeys = new Set();
    try {
      if (typeof JournalSystem !== "undefined" && typeof JournalSystem.listEntries === "function") {
        // Single pass over the journal collection (vs. one scan per type) —
        // we filter to the three linkable chronicle types in-loop.
        const linkable = new Set(["npc", "location", "discovery"]);
        for (const j of JournalSystem.listEntries()) {
          let type = "";
          try { type = String(j?.getFlag?.(MODULE_ID, "type") || "").toLowerCase(); } catch (_) {}
          if (!linkable.has(type)) continue;

          const name = (j?.name ?? "").trim();
          if (name.length < 3) continue;
          const key = name.toLowerCase();
          if (seenKeys.has(key)) continue; // first definition wins
          const uuid = j.uuid ?? `JournalEntry.${j.id}`;
          seenKeys.add(key);
          list.push([key, {
            key: `journal:${key}`,
            name,
            kind: "journal",
            uuid,
            caseSensitive: false
          }]);

          // (v0.8.0) Smart entity detection: register the entry's aliases so
          // narration variations ("the captain", "Reeves") resolve to the
          // same journal entity. Aliases never clobber an existing name.
          try {
            const aliases = (typeof JournalSystem._entryAliases === "function")
              ? JournalSystem._entryAliases(j) : [];
            for (const alias of aliases) {
              const a = String(alias ?? "").trim();
              if (a.length < 3) continue;
              const akey = a.toLowerCase();
              if (seenKeys.has(akey)) continue;
              seenKeys.add(akey);
              list.push([akey, {
                key: `journal:${akey}`,
                name,            // canonical label keeps the real entity name
                kind: "journal",
                uuid,
                caseSensitive: false,
                alias: true
              }]);
            }
          } catch (_) { /* alias indexing is best-effort */ }
        }
      }
    } catch (_) { /* journal not ready — skip */ }

    this._journalCache = { gen, list };
    return list;
  },

  /** True iff the feature is switched on (defaults ON). */
  enabled() { return Settings.get("entityLinking") !== false; },

  /** Escape a literal string for safe inclusion in a RegExp. */
  _escapeRe(str) { return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); },

  /**
   * Human-readable label for an oracle key (mirrors
   * {@link OracleInterpreter._labelFor} but kept self-contained so the index
   * can build before that object is referenced). Unknown keys fall back to a
   * title-cased version of the key plus an "Oracle" suffix.
   */
  _oracleLabel(key) {
    const map = {
      action: "Action Oracle",
      theme: "Theme Oracle",
      region: "Region Oracle",
      location: "Location Oracle",
      coastal: "Coastal Waters Oracle",
      npcRole: "NPC Role Oracle",
      npcGoal: "NPC Goal Oracle",
      npcDescriptor: "NPC Descriptor Oracle",
      combatAction: "Combat Action Oracle",
      mysticBacklash: "Mystic Backlash Oracle",
      payThePrice: "Pay the Price Oracle"
    };
    if (map[key]) return map[key];
    // Fallback: "someKey" → "Some Key Oracle".
    const words = String(key ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
    if (!words) return "";
    return `${words.charAt(0).toUpperCase()}${words.slice(1)} Oracle`;
  },

  /**
   * (Re)build the name → entry index and the combined matcher regex.
   * Returns the cache object (possibly with an empty index).
   */
  _build() {
    // (v0.9.0) Optional timing for large-campaign performance tuning. Only
    // computes timestamps when a debug flag is on, so it costs nothing in
    // normal play.
    const _t0 = this._perfEnabled() ? (performance?.now?.() ?? Date.now()) : 0;
    const byName = new Map();

    // --- 1) Chronicle journal entities (proper nouns; case-insensitive) ---
    //   Reuse the memoised journal sub-index (v0.9.0). This is the heavy part
    //   for large campaigns and is only re-scanned when the journal generation
    //   changes, not on every rebuild.
    try {
      for (const [key, descriptor] of this._journalSubindex()) {
        if (byName.has(key)) continue; // first definition wins
        byName.set(key, descriptor);
      }
    } catch (_) { /* journal not ready — skip */ }

    // --- 2) Ironsworn moves (case-SENSITIVE to avoid verb false-positives) ---
    try {
      const adapter = getActiveAdapter();
      if (adapter.isActive?.() && Array.isArray(adapter.moves)) {
        for (const m of adapter.moves) {
          const name = (m?.name ?? "").trim();
          if (name.length < 3) continue;
          const key = name.toLowerCase();
          if (byName.has(key)) continue; // don't clobber a journal entity
          byName.set(key, {
            key: `move:${key}`,
            name,
            kind: "move",
            moveName: name,
            // Datasworn ID (e.g. "move:classic/combat/strike") — lets the
            // click handler open the *system's* official move directly.
            moveDsId: (typeof m?.id === "string" && m.id.startsWith("move:")) ? m.id : "",
            caseSensitive: true
          });
        }
      }
    } catch (_) { /* controller not ready — skip */ }

    // --- 3) Ironsworn oracles (case-SENSITIVE labels to avoid common-word
    //        false-positives like "action"/"region"). Clicking an oracle
    //        link rolls it through the OracleInterpreter. ------------------
    try {
      if (typeof IronswornData !== "undefined" && IronswornData?.oracles) {
        for (const oracleKey of Object.keys(IronswornData.oracles)) {
          const label = this._oracleLabel(oracleKey); // e.g. "Action Oracle"
          if (!label || label.length < 3) continue;
          const key = label.toLowerCase();
          if (byName.has(key)) continue; // don't clobber an earlier entity
          byName.set(key, {
            key: `oracle:${oracleKey}`,
            name: label,
            kind: "oracle",
            oracleAlias: oracleKey,
            caseSensitive: true
          });
        }
      }
    } catch (_) { /* oracle data not ready — skip */ }

    // --- 4) Progress tracks on the active character (vows, journeys, bonds,
    //        combat tracks). Proper-noun-ish names; case-insensitive like
    //        journal entities. Clicking shows / marks the track. -----------
    try {
      const adapter = getActiveAdapter();
      if (adapter.isActive?.() && typeof adapter.getProgressTracks === "function") {
        const actor = adapter.getActiveCharacter?.();
        if (actor) {
          for (const track of adapter.getProgressTracks(actor)) {
            const name = (track?.name ?? "").trim();
            if (name.length < 3) continue;
            // Never turn a GENERIC track noun ("vow", "journey", "bond", ...)
            // into a clickable link: the bare word is not a player-chosen
            // proper name, and linking it produces a phantom card disconnected
            // from the real vow on the sheet. Such words are resolved to the
            // actual current track only when explicitly acted on, not linked.
            if (adapter.isGenericTrackWord?.(name)) continue;
            const key = name.toLowerCase();
            if (byName.has(key)) continue; // first definition wins
            byName.set(key, {
              key: `track:${key}`,
              name,
              kind: "track",
              trackName: name,
              caseSensitive: false
            });
          }
        }
      }
    } catch (_) { /* controller / actor not ready — skip */ }

    // --- 5) Assets from the compendium (Companions, Paths, Rituals, …).
    //        Read from IronswornController's async-built, cached index
    //        (primed on `ready`; empty until then — degrades gracefully).
    //        Case-insensitive; asset names are distinctive proper nouns. ---
    try {
      const adapter = getActiveAdapter();
      if (adapter.isActive?.() && typeof adapter.getAssetNames === "function") {
        for (const asset of adapter.getAssetNames()) {
          const name = (asset?.name ?? "").trim();
          if (name.length < 3) continue;
          const key = name.toLowerCase();
          if (byName.has(key)) continue; // don't clobber a more-specific entity
          byName.set(key, {
            key: `asset:${key}`,
            name,
            kind: "asset",
            assetName: name,
            assetUuid: asset.uuid ?? "",
            caseSensitive: false
          });
        }
      }
    } catch (_) { /* asset index not ready — skip */ }

    let regex = null;
    if (byName.size) {
      // Longest names first so multi-word entities win over substrings.
      const alts = [...byName.values()]
        .map(e => e.name)
        .sort((a, b) => b.length - a.length)
        .map(n => this._escapeRe(n));
      // Unicode-aware word boundaries via lookarounds so we don't match
      // inside a longer word and so apostrophes/digits count as "word".
      try {
        regex = new RegExp(`(?<![\\p{L}\\p{N}'’])(?:${alts.join("|")})(?![\\p{L}\\p{N}'’])`, "giu");
      } catch (_) {
        // Engines without lookbehind: fall back to plain \b boundaries.
        regex = new RegExp(`\\b(?:${alts.join("|")})\\b`, "gi");
      }
    }

    this._cache = { regex, byName };
    this._dirty = false;

    // (v0.9.0) Emit a one-line timing report when performance debugging is on.
    if (_t0) {
      try {
        const ms = ((performance?.now?.() ?? Date.now()) - _t0).toFixed(1);
        console.log(`${LOG_PREFIX} [perf] EntityLinker index rebuilt: ${byName.size} names in ${ms}ms (journal entries cached).`);
      } catch (_) { /* timing is best-effort */ }
    }
    return this._cache;
  },

  /** (v0.9.0) True when performance/debug logging is requested. */
  _perfEnabled() {
    try { return Settings.get("debugLogging") === true || Settings.get("ragDebugMode") === true; }
    catch (_) { return false; }
  },

  /* ---------------- customisable link styles (v0.9.0) ---------------- */

  /**
   * Built-in per-kind link palette (colour + FontAwesome icon class). Mirrors
   * the defaults baked into eternal-skald.css so the rendered markup and the
   * stylesheet agree when no custom style is set. (v0.9.0)
   * @type {Object<string,{color:string,icon:string}>}
   */
  LINK_DEFAULTS: Object.freeze({
    journal: { color: "#d6a85a", icon: "fa-book-open" },
    move:    { color: "#e8c178", icon: "fa-dice-d6" },
    oracle:  { color: "#c4a6e8", icon: "fa-dice-d20" },
    track:   { color: "#9ec99a", icon: "fa-list-check" },
    asset:   { color: "#8fb8d6", icon: "fa-id-card" }
  }),

  /** The kinds a user may customise. */
  STYLE_KINDS: Object.freeze(["journal", "move", "oracle", "track", "asset"]),

  /** True iff the user has opted into custom link styles. */
  customStylesEnabled() {
    try { return Settings.get("customLinkStyles") === true; }
    catch (_) { return false; }
  },

  /** The raw user override object (always an object). */
  _userStyles() {
    try {
      const s = Settings.get("linkStyles");
      return (s && typeof s === "object") ? s : {};
    } catch (_) { return {}; }
  },

  /**
   * Resolve the effective {color, icon} for a link kind: the built-in default
   * merged with any user override (only when custom styles are enabled).
   * Always returns a complete, sanitised object. (v0.9.0)
   * @param {string} kind
   * @returns {{color:string,icon:string}}
   */
  _styleFor(kind) {
    const def = this.LINK_DEFAULTS[kind] || this.LINK_DEFAULTS.move;
    if (!this.customStylesEnabled()) return { color: def.color, icon: def.icon };
    const ov = this._userStyles()[kind] || {};
    const color = (typeof ov.color === "string" && this._isSafeColor(ov.color)) ? ov.color : def.color;
    const icon  = (typeof ov.icon === "string" && this._isSafeIcon(ov.icon)) ? ov.icon : def.icon;
    return { color, icon };
  },

  /** Accept #rgb / #rrggbb / #rrggbbaa hex or a short CSS colour keyword. */
  _isSafeColor(s) {
    const v = String(s || "").trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return true;
    return /^[a-z]{3,20}$/i.test(v); // simple named colour, no parentheses/escapes
  },

  /** Accept a FontAwesome glyph class like "fa-dragon" (letters/digits/dashes). */
  _isSafeIcon(s) {
    return /^fa-[a-z0-9-]{1,40}$/i.test(String(s || "").trim());
  },

  /**
   * Inject / refresh / remove the live override stylesheet that recolours the
   * inline entity links according to the user's preferences. Driven entirely
   * by CSS so it also covers the Foundry-enriched journal content-links (whose
   * markup we don't author). No-ops gracefully in headless contexts. (v0.9.0)
   */
  applyCustomStyles() {
    try {
      if (typeof document === "undefined" || !document?.head) return;
      const ID = "es-custom-link-styles";
      let el = document.getElementById(ID);

      // Disabled → remove any previously-injected overrides and bail.
      if (!this.customStylesEnabled()) {
        if (el) el.remove();
        return;
      }

      const rules = [];
      for (const kind of this.STYLE_KINDS) {
        const { color } = this._styleFor(kind);
        if (kind === "journal") {
          // Foundry renders @UUID links as <a class="content-link"> inside our
          // message; tint those (and their leading icon) within our cards only.
          rules.push(`.eternal-skald-msg a.content-link { color: ${color}; }`);
          rules.push(`.eternal-skald-msg a.content-link > i { color: ${color}; }`);
        } else {
          rules.push(`.es-entity-link.es-${kind}-link { color: ${color}; }`);
          rules.push(`.es-entity-link.es-${kind}-link:hover { color: ${color}; border-bottom-color: ${color}; }`);
        }
      }

      if (!el) {
        el = document.createElement("style");
        el.id = ID;
        document.head.appendChild(el);
      }
      el.textContent = `/* The Eternal Skald — custom link styles (v0.9.0) */\n${rules.join("\n")}`;
    } catch (_) { /* cosmetic only — never throw */ }
  },

  /**
   * Persist a colour/icon override for a link kind and enable custom styles.
   * Validates input; returns the resolved style or null on bad input. World
   * setting writes are GM-gated by Foundry, so the caller should be GM. (v0.9.0)
   * @param {string} kind  one of STYLE_KINDS
   * @param {{color?:string, icon?:string}} patch
   * @returns {Promise<{color:string,icon:string}|null>}
   */
  async setStyle(kind, patch = {}) {
    if (!this.STYLE_KINDS.includes(kind)) return null;
    const next = { ...this._userStyles() };
    const cur = { ...(next[kind] || {}) };
    if (typeof patch.color === "string" && patch.color.trim()) {
      if (!this._isSafeColor(patch.color)) return null;
      cur.color = patch.color.trim();
    }
    if (typeof patch.icon === "string" && patch.icon.trim()) {
      let ic = patch.icon.trim();
      if (!/^fa-/i.test(ic)) ic = `fa-${ic}`; // tolerate "dragon" → "fa-dragon"
      if (!this._isSafeIcon(ic)) return null;
      cur.icon = ic;
    }
    next[kind] = cur;
    try {
      await game.settings.set(MODULE_ID, "linkStyles", next);
      if (!this.customStylesEnabled()) await game.settings.set(MODULE_ID, "customLinkStyles", true);
    } catch (_) { return null; }
    // onChange handlers refresh CSS + index; refresh eagerly too.
    this.applyCustomStyles();
    this.invalidate();
    return this._styleFor(kind);
  },

  /** Clear all user overrides (keeps customLinkStyles toggle as-is). (v0.9.0) */
  async resetStyles() {
    try { await game.settings.set(MODULE_ID, "linkStyles", {}); } catch (_) {}
    this.applyCustomStyles();
    this.invalidate();
  },

  _index() {
    if (this._dirty || !this._cache) return this._build();
    return this._cache;
  },

  /** Build the replacement HTML for a single matched entity. */
  _renderLink(entry, matchedText) {
    if (entry.kind === "journal") {
      // Content-link TEXT — Foundry enriches this into a clickable link in
      // the chat log (same mechanism the !journals command relies on).
      // Strip braces from the label defensively so the syntax can't break.
      const label = matchedText.replace(/[{}]/g, "");
      return `@UUID[${entry.uuid}]{${label}}`;
    }
    if (entry.kind === "oracle") {
      // Oracle — clicking rolls the oracle and the Skald interprets it.
      const alias = escapeHtml(entry.oracleAlias ?? "");
      const label = escapeHtml(entry.name);
      const icon = escapeHtml(this._styleFor("oracle").icon); // (v0.9.0) customisable
      return `<a class="es-entity-link es-oracle-link" data-skald-action="link-oracle" ` +
        `data-es-kind="oracle" data-oracle="${alias}" ` +
        `data-tooltip="Ironsworn oracle: ${label} — click to roll">` +
        `<i class="fa-solid ${icon}"></i>${escapeHtml(matchedText)}</a>`;
    }
    if (entry.kind === "track") {
      // Progress track — clicking shows the track and offers to mark it.
      const tname = escapeHtml(entry.trackName ?? entry.name);
      const icon = escapeHtml(this._styleFor("track").icon); // (v0.9.0) customisable
      return `<a class="es-entity-link es-track-link" data-skald-action="link-track" ` +
        `data-es-kind="track" data-track="${tname}" ` +
        `data-tooltip="Progress track: ${tname} — click to view / mark">` +
        `<i class="fa-solid ${icon}"></i>${escapeHtml(matchedText)}</a>`;
    }
    if (entry.kind === "asset") {
      // Asset — clicking opens the asset card from the compendium.
      const aname = escapeHtml(entry.assetName ?? entry.name);
      const auuid = escapeHtml(entry.assetUuid ?? "");
      const icon = escapeHtml(this._styleFor("asset").icon); // (v0.9.0) customisable
      return `<a class="es-entity-link es-asset-link" data-skald-action="link-asset" ` +
        `data-es-kind="asset" data-asset="${aname}" data-asset-uuid="${auuid}" ` +
        `data-tooltip="Ironsworn asset: ${aname} — click to view">` +
        `<i class="fa-solid ${icon}"></i>${escapeHtml(matchedText)}</a>`;
    }
    // Move — custom link wired by Integration.wireSuggestionCard. We carry
    // the Datasworn ID so the click handler can open the *system's* official
    // move dialog/sheet directly (no intermediate card).
    const move = escapeHtml(entry.moveName);
    const dsid = escapeHtml(entry.moveDsId ?? "");
    const icon = escapeHtml(this._styleFor("move").icon); // (v0.9.0) customisable
    return `<a class="es-entity-link es-move-link" data-skald-action="link-move" ` +
      `data-es-kind="move" data-move="${move}" data-move-dsid="${dsid}" ` +
      `data-tooltip="Ironsworn move: ${move} — click to roll">` +
      `<i class="fa-solid ${icon}"></i>${escapeHtml(matchedText)}</a>`;
  },

  /**
   * Link entities inside an already-formatted (safe) HTML fragment.
   * Only text *between* tags is rewritten — never tag names/attributes,
   * never the contents of <code> or existing <a> elements. Each distinct
   * entity is linked at most once (its first mention) to avoid noise.
   *
   * @param {string} html  HTML produced by {@link formatMarkdown}
   * @returns {string}
   */
  link(html) {
    if (typeof html !== "string" || !html) return html;
    if (!this.enabled()) return html;

    let idx;
    try { idx = this._index(); } catch (_) { return html; }
    if (!idx?.regex || !idx.byName?.size) return html;

    try {
      const seen = new Set();
      // Split into tags vs. text, keeping the delimiters.
      const parts = html.split(/(<[^>]+>)/);
      let inCode = 0;
      let inAnchor = 0;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part) continue;

        if (part[0] === "<") {
          // It's a tag — track contexts we must not touch.
          const tag = part.toLowerCase();
          if (/^<code[\s>]/.test(tag)) inCode++;
          else if (/^<\/code>/.test(tag)) inCode = Math.max(0, inCode - 1);
          else if (/^<a[\s>]/.test(tag)) inAnchor++;
          else if (/^<\/a>/.test(tag)) inAnchor = Math.max(0, inAnchor - 1);
          continue; // never rewrite tags themselves
        }

        if (inCode || inAnchor) continue; // leave code / existing links alone

        idx.regex.lastIndex = 0;
        parts[i] = part.replace(idx.regex, (m) => {
          const entry = idx.byName.get(m.toLowerCase());
          if (!entry) return m;
          // Moves only link when the canonical capitalization matches.
          if (entry.caseSensitive && m !== entry.name) return m;
          if (seen.has(entry.key)) return m; // first mention only
          seen.add(entry.key);
          return this._renderLink(entry, m);
        });
      }

      return parts.join("");
    } catch (e) {
      console.warn(LOG_PREFIX, "entity linking failed:", e?.message || e);
      return html; // graceful: never break narration
    }
  }
};
