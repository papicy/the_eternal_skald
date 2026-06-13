import { LOG_PREFIX, MODULE_ID, SKALD_NAME } from "../core/constants.js";
import { Settings } from "../core/settings.js";
import { Client } from "../ai/client.js";
import { buildSystemPrompt, buildJournalPromptBlock } from "../ai/prompt-builder.js";
import { Chat, Memory, escapeHtml, formatMarkdown, parseMetadata } from "../chat/display.js";
import { EntityLinker } from "./entity-linking.js";
import { IronswornController } from "../ironsworn-controller.js";
// Call-time cross-imports (safe cycle): ContradictionDetector, RagBridge and
// Integration (-> narrative step 9) still live in eternal-skald.js.
import { ContradictionDetector, RagBridge } from "../eternal-skald.js";
import { Integration } from "../narrative/integration.js";
import { Integrations } from "../narrative/integrations.js";

/**
 * A tiny, dependency-free background work queue.
 *
 * Journal writes touch the Foundry document database and can conflict if
 * fired concurrently (e.g. two replies both trying to create the same
 * folder, or append to the same rolling journal). {@link JournalQueue}
 * serialises them: jobs are processed strictly one-at-a-time, in order, on
 * a microtask drain loop so the caller never blocks. A failing job logs and
 * is skipped — it never stalls the queue or surfaces an error to the player.
 */
export class JournalQueue {
  /** @param {(job:any)=>Promise<void>} processor */
  constructor(processor) {
    this._jobs = [];
    this._busy = false;
    this._processor = processor;
  }

  /** Add a job and kick the drain loop (non-blocking). */
  enqueue(job) {
    this._jobs.push(job);
    // Fire-and-forget: never await from the caller's path.
    this._drain().catch(e => console.warn(LOG_PREFIX, "JournalQueue drain crashed:", e?.message || e));
    return this;
  }

  /** Number of jobs still waiting (excludes the one in flight). */
  get size() { return this._jobs.length; }

  /** Process jobs sequentially until the queue empties. */
  async _drain() {
    if (this._busy) return;
    this._busy = true;
    try {
      while (this._jobs.length) {
        const job = this._jobs.shift();
        try {
          await this._processor(job);
        } catch (e) {
          console.warn(LOG_PREFIX, "JournalQueue job failed:", e?.message || e, job?.kind ?? "");
        }
      }
    } finally {
      this._busy = false;
    }
  }
}

/**
 * The auto-journaling brain (v0.4.0).
 *
 * Parses the chronicle metadata the AI appends to its replies (see
 * {@link buildJournalPromptBlock}) and turns it into Foundry Journal
 * Entries, organised into a tidy folder tree, with optional minimal toast
 * notifications. World Facts and Story Threads are tracked SILENTLY in
 * rolling journals; NPCs / Locations / Discoveries get individual entries
 * and a small toast. Session Chronicles are generated on demand from an
 * in-memory activity log.
 *
 * All writes go through {@link JournalQueue} so they never block narration.
 */
export const JournalSystem = {
  ROOT_FOLDER: SKALD_NAME,            // "The Eternal Skald"
  _folderColor: "#8c6a2f",

  /**
   * type-key → spec. Each individual-entry type (npc / location / discovery)
   * now carries a `fields` template (v0.8.0): an ordered list of structured
   * fields the AI is asked to fill, the !template dialog renders as inputs,
   * and {@link _renderEntityHtml} displays. Each field is
   * `{ key, label, area?, choices? }`:
   *   • key     — the metadata/flag property name
   *   • label   — human-readable label for prompts, dialogs and rendering
   *   • area    — render as a multi-line <textarea> in the !template dialog
   *   • choices — optional fixed value list (rendered as a <select>)
   * The template is purely additive: legacy entries that lack a field simply
   * omit it, and unknown fields on an entity are ignored.
   */
  TYPES: {
    npc: {
      folder: "NPCs", label: "NPC", emoji: "👤", rolling: false,
      fields: [
        { key: "description",   label: "Description",   area: true },
        { key: "rank",          label: "Rank",          choices: ["troublesome", "dangerous", "formidable", "extreme", "epic"] },
        { key: "harm",          label: "Harm / Status" },
        { key: "motivations",   label: "Motivations",   area: true },
        { key: "goals",         label: "Goals",         area: true },
        { key: "relationships", label: "Relationships", area: true }
      ]
    },
    location: {
      folder: "Locations", label: "Location", emoji: "🗺️", rolling: false,
      fields: [
        { key: "description", label: "Description",      area: true },
        { key: "region",      label: "Region" },
        { key: "features",    label: "Notable features", area: true },
        { key: "dangers",     label: "Dangers",          area: true },
        { key: "resources",   label: "Resources",        area: true }
      ]
    },
    discovery: {
      folder: "Discoveries", label: "Discovery", emoji: "🔍", rolling: false,
      fields: [
        { key: "description",  label: "Description",  area: true },
        { key: "significance", label: "Significance", area: true },
        { key: "connectedTo",  label: "Connected to" }
      ]
    },
    worldFact:   { folder: "World Facts",        label: "World Fact",   emoji: "📜", rolling: true, journalName: "Established Facts" },
    storyThread: { folder: "Story Threads",      label: "Story Thread", emoji: "🧵", rolling: true, journalName: "Threads & Mysteries" },
    session:     { folder: "Session Chronicles", label: "Session",      emoji: "📖", rolling: false }
  },

  /** All structured field keys across the templated types (for update/context). */
  _allFieldKeys() {
    const keys = new Set();
    for (const t of ["npc", "location", "discovery"]) {
      for (const f of (this.TYPES[t]?.fields ?? [])) keys.add(f.key);
    }
    return [...keys];
  },

  /** Cache of resolved Folder documents keyed by folder name (per session). */
  _folderCache: new Map(),

  /** Background work queue (initialised lazily on first use). */
  _queue: null,

  /** Rolling in-memory log of session activity, drained by !end-session. */
  _sessionLog: [],

  /**
   * (v0.9.0) Monotonic "journal generation" counter. Bumped whenever a
   * chronicle JournalEntry is created, renamed, or deleted. Consumers that
   * cache an expensive scan of `game.journal` (notably {@link EntityLinker})
   * can compare against this cheap integer to know whether their cache is
   * still valid — avoiding a full re-scan of every journal on each rebuild.
   * This is the key optimisation for large campaigns (100+ journals), where
   * the per-narration entity-index rebuild previously re-walked the entire
   * journal collection (×3, once per entity type) every time.
   * @type {number}
   */
  _journalGen: 0,

  /** (v0.9.0) Handle for the idle auto-summary timer (or null). */
  _idleTimer: null,

  /** (v0.9.0) Guards against re-entrant / overlapping auto-summary runs. */
  _autoSummaryRunning: false,

  /** (v0.9.0) Current journal generation token (see {@link _journalGen}). */
  journalGeneration() { return this._journalGen; },

  /**
   * (v0.9.0) Invalidate cached journal scans by advancing the generation
   * counter. Cheap, defensive, and safe to call from hooks at high frequency.
   */
  bumpJournalGeneration() {
    this._journalGen = (this._journalGen + 1) | 0;
    if (this._journalGen < 0) this._journalGen = 0; // wrap defensively
  },

  /* ---------------- gating / accessors ---------------- */

  enabled()       { return Settings.get("autoJournaling") !== false; },
  notifyLevel()   { return Settings.get("journalNotifications") || "minimal"; },
  permission()    { return Settings.get("journalPermissions") || "gm-only"; },
  sessionAuto()   { return Settings.get("sessionAutoSummary") !== false; },

  /**
   * (v0.9.0) Idle minutes after which an automatic Session Chronicle is
   * woven if the session has unsaved activity. 0 disables the idle timer
   * (manual !end-session still works). Clamped to a sane range.
   */
  sessionAutoMinutes() {
    const n = Number(Settings.get("sessionAutoMinutes"));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(240, Math.max(1, Math.round(n)));
  },

  /* ---------------- idle auto session-summary (v0.9.0) ---------------- */

  /**
   * Is THIS client the one responsible for writing the automatic chronicle?
   * Only the active GM runs the idle timer, so a multi-client table never
   * generates duplicate session chronicles. (v0.9.0)
   */
  _isAutoSummaryHost() {
    try {
      if (!game.user?.isGM) return false;
      // Prefer the canonical "active GM" when Foundry exposes it.
      const activeGM = game.users?.activeGM;
      if (activeGM && activeGM.id !== game.user.id) return false;
      return this.sessionAuto() && this.sessionAutoMinutes() > 0;
    } catch (_) { return false; }
  },

  /** Cancel any pending idle auto-summary timer. (v0.9.0) */
  _clearIdleTimer() {
    try { if (this._idleTimer) { clearTimeout(this._idleTimer); } } catch (_) {}
    this._idleTimer = null;
  },

  /**
   * (Re)arm the inactivity timer. Called whenever the chronicle records new
   * activity. After `sessionAutoMinutes` of silence, an automatic Session
   * Chronicle is woven. Fully defensive — never throws into the ingest path.
   * (v0.9.0)
   */
  _resetIdleTimer() {
    try {
      this._clearIdleTimer();
      if (!this._isAutoSummaryHost()) return;
      const mins = this.sessionAutoMinutes();
      if (!mins) return;
      const ms = mins * 60 * 1000;
      this._idleTimer = setTimeout(() => {
        this._idleTimer = null;
        this._runAutoSummary().catch(e =>
          console.warn(LOG_PREFIX, "auto session-summary failed:", e?.message || e));
      }, ms);
    } catch (e) {
      console.warn(LOG_PREFIX, "_resetIdleTimer failed:", e?.message || e);
    }
  },

  /**
   * Weave an automatic Session Chronicle if there is unsaved activity. Guarded
   * so it never runs concurrently with itself or a manual !end-session.
   * (v0.9.0)
   */
  async _runAutoSummary() {
    if (this._autoSummaryRunning) return null;
    // Re-check conditions at fire time (settings may have changed; the log may
    // have been drained by a manual !end-session in the meantime).
    if (!this._isAutoSummaryHost()) return null;
    if (!Array.isArray(this._sessionLog) || !this._sessionLog.length) return null;
    this._autoSummaryRunning = true;
    try {
      await Chat.postSystem(
        `<em>${SKALD_NAME} senses a lull and gathers the session's threads…</em>`,
        { gmWhisper: true }
      );
      return await this.generateSessionChronicle({ announce: true, auto: true });
    } finally {
      this._autoSummaryRunning = false;
    }
  },

  /** Only GMs (or users with journal-create rights) write journals. */
  canWrite() {
    try { return game.user?.isGM || game.user?.can?.("JOURNAL_CREATE"); }
    catch (_) { return false; }
  },

  /** Current journal edit mode: "manual" | "propose" | "auto". Defensive. */
  editMode() {
    const m = String(Settings.get("journalEditMode") || "manual").toLowerCase();
    return ["manual", "propose", "auto"].includes(m) ? m : "manual";
  },

  /**
   * True only on the single client that should perform auto-applied writes,
   * to avoid duplicate mutations in multiplayer. Mirrors the existing
   * active-GM host pattern used by the idle auto-summary (_isAutoSummaryHost).
   */
  _isAutoApplyHost() {
    try {
      const activeGM = game.users?.activeGM;
      if (activeGM) return game.user?.id === activeGM.id;
      // Fallback: lowest-id connected GM acts as host.
      const gms = game.users?.filter?.(u => u.isGM && u.active) ?? [];
      gms.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      return gms.length ? gms[0].id === game.user?.id : !!game.user?.isGM;
    } catch (_) { return !!game.user?.isGM; }
  },

  /**
   * (v0.14.0) Backfill extractor. When a narration arrived with no usable
   * [[SKALD_META]] block, ask the model — in a tiny, cheap, low-temperature
   * call — to emit ONLY a metadata block describing the just-finished
   * exchange, then feed it back through the normal ingest pipeline.
   *
   * Honors journaling density so the extractor records as much as the GM asked
   * for. Fully defensive; never throws.
   *
   * @param {string} reply   the narration that lacked metadata
   * @param {object} ctx     ingest context ({ channel, sourceVow })
   */
  async _runBackfill(reply, ctx = {}) {
    if (!this.enabled() || !this.canWrite()) return null;
    if (Settings.get("metadataBackfill") === false) return null;

    // Gather the recent exchange as context. The rolling Memory buffer already
    // holds the user/assistant turns for this channel; fall back to just the
    // reply if it is empty.
    let exchange = "";
    try {
      const turns = Memory.get?.(ctx.channel ?? "skald") ?? [];
      exchange = turns.slice(-6)
        .map(t => `${t.role === "user" ? "Player" : "Skald"}: ${t.content}`)
        .join("\n\n");
    } catch (_) { /* defensive */ }
    if (!exchange) exchange = `Skald: ${String(reply || "").slice(0, 6000)}`;

    const density = String(Settings.get("journalingDensity") || "standard").toLowerCase();
    const richness = (density === "exhaustive" || density === "high")
      ? "Capture EVERYTHING worth remembering as atomic Who/What/Where/When/How/Why facts — names, places, time, injuries, supplies, world-state shifts, lore, decisions, mysteries."
      : "Capture the key continuity anchors: names, places, decisions, facts, mysteries, and any world-state change.";

    // The extractor reuses the canonical metadata protocol so the JSON shape is
    // guaranteed to match what ingestMetadata() already understands.
    const protocol = (() => {
      try { return buildJournalPromptBlock(); } catch (_) { return ""; }
    })();

    const system = `You are a chronicle scribe. Read the exchange and output ONLY a single
[[SKALD_META]] ... [[/SKALD_META]] block of valid single-line JSON describing
what is worth remembering. Output NOTHING else — no narration, no commentary,
no code fences. ${richness}

${protocol}`;

    const messages = [
      { role: "system", content: system },
      { role: "user", content: `EXCHANGE TO CHRONICLE:\n\n${exchange}` }
    ];

    let extractorReply = "";
    try {
      // Low temperature + small budget → fast, deterministic, cheap.
      extractorReply = await Client.chat(messages, { temperature: 0.2, maxTokens: 600 });
    } catch (e) {
      console.warn(LOG_PREFIX, "backfill extractor call failed:", e?.message || e);
      return null;
    }

    const { metadata } = parseMetadata(extractorReply);
    if (!metadata || typeof metadata !== "object") {
      console.log(`${LOG_PREFIX} [backfill] extractor produced no usable metadata — skipping.`);
      return null;
    }
    // IMPORTANT: route straight to ingestMetadata (NOT ingestReply) to avoid any
    // chance of a backfill loop.
    this.ingestMetadata(metadata, { ...ctx, backfilled: true });
    console.log(`${LOG_PREFIX} [backfill] chronicle populated from extractor pass.`);
    return metadata;
  },

  queue() {
    if (!this._queue) this._queue = new JournalQueue((job) => this._process(job));
    return this._queue;
  },

  /* ---------------- public entry point ---------------- */

  /**
   * Ingest a COMPLETE AI reply: parse its chronicle metadata (if any),
   * record it to the session log, and enqueue background journal writes.
   * Non-blocking, swallows all errors — journaling must never break play.
   *
   * @param {string} reply
   * @param {object} [ctx]
   * @param {string} [ctx.channel] - conversation channel (for the log)
   * @param {string} [ctx.sourceVow] - vow id for context flags
   * @returns {object|null} the parsed metadata (or null)
   */
  ingestReply(reply, ctx = {}) {
    try {
      if (!this.enabled() || !this.canWrite()) return null;
      const { metadata } = parseMetadata(reply);
      if (!metadata || typeof metadata !== "object") {
        // (v0.14.0) No usable metadata. If backfill is enabled, fire a second
        // lightweight extractor pass over the finished exchange. Fire-and-forget
        // — failures are swallowed and never reach the player.
        if (Settings.get("metadataBackfill") !== false) {
          this._runBackfill(reply, ctx)
            .catch(e => console.warn(LOG_PREFIX, "metadata backfill failed:", e?.message || e));
        }
        return null;
      }
      this.ingestMetadata(metadata, ctx);
      return metadata;
    } catch (e) {
      console.warn(LOG_PREFIX, "ingestReply failed:", e?.message || e);
      return null;
    }
  },

  /**
   * Process an already-parsed metadata object. Records to the session log
   * and enqueues a background job per actionable item.
   */
  ingestMetadata(metadata, ctx = {}) {
    if (!metadata || typeof metadata !== "object") return;
    const sourceVow = ctx.sourceVow ?? this._currentVowId();

    // 1) Record to the session log for the eventual chronicle.
    this._sessionLog.push({
      t: Date.now(),
      channel: ctx.channel ?? "general",
      entities: Array.isArray(metadata.entities) ? metadata.entities.map(e => ({ type: e?.type, name: e?.name })) : [],
      facts: Array.isArray(metadata.facts) ? metadata.facts.slice() : [],
      mysteries: Array.isArray(metadata.mysteries) ? metadata.mysteries.slice() : [],
      decisions: Array.isArray(metadata.decisions) ? metadata.decisions.slice() : [],
      worldState: (metadata.worldState && typeof metadata.worldState === "object") ? { ...metadata.worldState } : {}
    });
    // Keep the log from growing without bound during marathon sessions.
    if (this._sessionLog.length > 500) this._sessionLog.splice(0, this._sessionLog.length - 500);

    // (v0.9.0) Fresh activity — (re)arm the idle auto-summary timer so a
    // lull eventually weaves a Session Chronicle on its own. Fully defensive.
    try { this._resetIdleTimer(); } catch (_) { /* never break ingest */ }

    // 1b) (v0.8.0) Persist a compact, permanent timeline event so `!timeline`
    // can render the full campaign history across reloads/sessions. This is
    // GM-only (world setting write) and fire-and-forget — never block or break
    // narration if persistence fails.
    try { this._recordTimelineEvent(metadata, ctx); } catch (_) { /* non-fatal */ }

    // 1c) (v0.9.0) Contradiction detection — compare freshly narrated facts
    // against established lore and surface a gentle GM-only advisory if the
    // saga seems to be tripping over itself. Fire-and-forget and fully
    // defensive: a detector hiccup must never interrupt the chronicle.
    try { ContradictionDetector.check(metadata); } catch (_) { /* never break ingest */ }

    const q = this.queue();

    // 2) Entities → individual NPC / Location / Discovery journals.
    if (Array.isArray(metadata.entities)) {
      for (const ent of metadata.entities) {
        if (!ent || typeof ent !== "object") continue;
        const type = String(ent.type || "").toLowerCase();
        if (!["npc", "location", "discovery"].includes(type)) continue;
        if (!ent.name || typeof ent.name !== "string") continue;
        q.enqueue({ kind: "entity", type, entity: ent, sourceVow });
      }
    }

    // 3) Silent rolling trackers.
    const facts = Array.isArray(metadata.facts) ? metadata.facts.filter(s => typeof s === "string" && s.trim()) : [];
    if (facts.length) q.enqueue({ kind: "facts", facts, sourceVow });

    const mysteries = Array.isArray(metadata.mysteries) ? metadata.mysteries.filter(s => typeof s === "string" && s.trim()) : [];
    const decisions = Array.isArray(metadata.decisions) ? metadata.decisions.filter(s => typeof s === "string" && s.trim()) : [];
    const worldState = (metadata.worldState && typeof metadata.worldState === "object") ? metadata.worldState : null;
    if (mysteries.length || decisions.length || (worldState && Object.keys(worldState).length)) {
      q.enqueue({ kind: "thread", mysteries, decisions, worldState, sourceVow });
    }

    // 4) (v0.14.0) Edit proposals — only honored when edit mode allows it.
    if (Array.isArray(metadata.proposals) && metadata.proposals.length) {
      try { this._handleProposals(metadata.proposals, ctx); }
      catch (e) { console.warn(LOG_PREFIX, "proposal handling failed:", e?.message || e); }
    }
  },

  /* ---------------- timeline (v0.8.0) ---------------- */

  /**
   * (v0.8.0) Append a compact, permanent event to the world-scoped timeline.
   * Only the GM (a client that `canWrite()`) persists events, avoiding races
   * from multiple clients. Each event is small (names + short summaries) so the
   * log stays lightweight even across long campaigns; capped at 1000 entries.
   *
   * @param {object} metadata  Parsed SKALD metadata.
   * @param {object} ctx        Ingestion context ({ channel, sourceVow }).
   */
  _recordTimelineEvent(metadata, ctx = {}) {
    if (!this.canWrite()) return;
    if (!metadata || typeof metadata !== "object") return;

    const entities = Array.isArray(metadata.entities)
      ? metadata.entities
          .filter(e => e && typeof e === "object" && typeof e.name === "string" && e.name.trim())
          .map(e => ({ type: String(e.type || "").toLowerCase(), name: e.name.trim() }))
      : [];
    const facts = Array.isArray(metadata.facts)
      ? metadata.facts.filter(s => typeof s === "string" && s.trim()).map(s => s.trim()) : [];
    const mysteries = Array.isArray(metadata.mysteries)
      ? metadata.mysteries.filter(s => typeof s === "string" && s.trim()).map(s => s.trim()) : [];
    const decisions = Array.isArray(metadata.decisions)
      ? metadata.decisions.filter(s => typeof s === "string" && s.trim()).map(s => s.trim()) : [];

    // Skip empty pulses — nothing worth remembering happened.
    if (!entities.length && !facts.length && !mysteries.length && !decisions.length) return;

    const event = {
      id: `tl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      t: Date.now(),
      channel: ctx.channel ?? "general",
      entities,
      facts,
      mysteries,
      decisions
    };

    // (v0.22.0 / §6.2) When Simple Calendar is present, stamp the in-game
    // date/time alongside the real-world timestamp. Additive + fail-soft:
    // omitted entirely when the module is absent, so existing events and the
    // !timeline reader are unaffected.
    try {
      const igDate = Integrations.getInGameDate();
      if (igDate) event.igDate = igDate;
    } catch (_) { /* non-fatal: in-game date is best-effort */ }

    // Read → push → cap → write. Fire-and-forget; persistence must never throw
    // into the narration path.
    Promise.resolve()
      .then(() => {
        let log = [];
        try { log = Settings.get("timelineEvents") || []; } catch (_) { log = []; }
        if (!Array.isArray(log)) log = [];
        log.push(event);
        if (log.length > 1000) log.splice(0, log.length - 1000);
        return game.settings.set(MODULE_ID, "timelineEvents", log);
      })
      .catch(() => { /* non-fatal: timeline persistence is best-effort */ });
  },

  /**
   * (v0.8.0) Return the persisted timeline events (oldest → newest), optionally
   * filtered by a free-text query matching entity names, facts, mysteries,
   * decisions, or channel.
   *
   * @param {string} [query]  Optional case-insensitive search string.
   * @returns {Array<object>} Matching timeline events.
   */
  getTimeline(query = "") {
    let log = [];
    try { log = Settings.get("timelineEvents") || []; } catch (_) { log = []; }
    if (!Array.isArray(log)) log = [];
    const q = String(query || "").trim().toLowerCase();
    if (!q) return log.slice();
    return log.filter(ev => {
      try {
        const hay = [
          ev.channel,
          ...(ev.entities || []).map(e => e?.name),
          ...(ev.facts || []),
          ...(ev.mysteries || []),
          ...(ev.decisions || [])
        ].filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q);
      } catch (_) { return false; }
    });
  },

  /** (v0.8.0) Wipe the persistent timeline (GM-only). */
  async clearTimeline() {
    if (!this.canWrite()) return false;
    try { await game.settings.set(MODULE_ID, "timelineEvents", []); return true; }
    catch (_) { return false; }
  },

  /* ---------------- queue processor ---------------- */

  async _process(job) {
    if (!job || !this.canWrite()) return;
    switch (job.kind) {
      case "entity":  return this._processEntity(job);
      case "facts":   return this._processFacts(job);
      case "thread":  return this._processThread(job);
      case "rewrite": return this._processRewrite(job);   // (v0.14.0)
      default: return;
    }
  },

  async _processEntity(job) {
    const { type, entity, sourceVow } = job;
    // Dedupe by name (now alias- and fuzzy-aware, v0.8.0): if an entry already
    // exists for this name OR any of its aliases/synonyms, augment it instead
    // of making a twin.
    const aliases = this._extractAliases(entity);
    const existing = this._findEntry(type, entity.name, aliases);
    if (existing) return this._updateEntity(existing, type, entity, sourceVow);
    return this._createEntity(type, entity, sourceVow);
  },

  async _createEntity(type, entity, sourceVow, opts = {}) {
    const folder = await this.getOrCreateFolder(type);
    const name = String(entity.name).slice(0, 100);
    const html = this._renderEntityHtml(type, entity);
    const aliases = this._extractAliases(entity);
    const entry = await JournalEntry.create({
      name,
      folder: folder?.id ?? null,
      ownership: this._ownership(),
      pages: [{
        name,
        type: "text",
        text: { content: html, format: 1 /* HTML */ }
      }],
      flags: {
        [MODULE_ID]: {
          type,
          createdBy: opts.createdBy ?? "ai",
          lastUpdated: Date.now(),
          relatedEntities: [],
          aliases,
          sourceVow: sourceVow ?? null,
          aiContext: this._entityContext(entity)
        }
      }
    });
    if (entry) {
      this._toast(name, type);
      // Resolve & persist any AI-declared relationships, both directions (v0.8.0).
      try { await this._syncRelationships(entry, entity); }
      catch (e) { console.warn(LOG_PREFIX, "relationship sync failed:", e?.message || e); }
      // Embed into semantic memory (v0.5.0) — fire-and-forget.
      RagBridge.indexEntry(entry);
      // A new linkable entity exists — refresh the narration link index.
      try { EntityLinker.invalidate(); } catch (_) {}
    }
    return entry;
  },

  async _updateEntity(entry, type, entity, sourceVow) {
    try {
      const page = entry.pages?.contents?.[0] ?? entry.pages?.find?.(() => true);
      const prev = page?.text?.content ?? "";
      const addition = this._renderEntityUpdateHtml(entity);
      const merged = `${prev}\n<hr class="es-journal-sep"/>\n${addition}`;
      if (page) {
        await page.update({ "text.content": merged });
      }
      const existingCtx = entry.getFlag?.(MODULE_ID, "aiContext") || "";
      // Merge any newly-supplied aliases with the ones already stored.
      const mergedAliases = this._mergeAliases(
        this._entryAliases(entry), this._extractAliases(entity)
      );
      await entry.update({
        flags: {
          [MODULE_ID]: {
            type,
            lastUpdated: Date.now(),
            aliases: mergedAliases,
            sourceVow: sourceVow ?? entry.getFlag?.(MODULE_ID, "sourceVow") ?? null,
            aiContext: `${existingCtx}\n${this._entityContext(entity)}`.trim().slice(0, 4000)
          }
        }
      });
      // Resolve & persist any AI-declared relationships, both directions (v0.8.0).
      try { await this._syncRelationships(entry, entity); }
      catch (e) { console.warn(LOG_PREFIX, "relationship sync failed:", e?.message || e); }
      // Updates are quieter than creates — only toast in "detailed" mode.
      if (this.notifyLevel() === "detailed") this._toast(entry.name, type, "Updated");
      // Re-embed the updated entry so memory reflects the new content (v0.5.0).
      RagBridge.indexEntry(entry);
      try { EntityLinker.invalidate(); } catch (_) {}
      return entry;
    } catch (e) {
      console.warn(LOG_PREFIX, "_updateEntity failed:", e?.message || e);
      return null;
    }
  },

  /* ---------------- archive-safe mutators (v0.14.0) ---------------- */

  /**
   * Append a structured update to an existing entry (history-safe by nature —
   * it only adds). This is the engine behind `!journal-amend`. Reuses the
   * existing append-only _updateEntity path so behavior matches auto-updates.
   *
   * @param {JournalEntry} entry  resolved via _findEntry()
   * @param {string} type         "npc" | "location" | "discovery"
   * @param {object} entity       entities[]-shaped object (description + fields)
   * @returns {Promise<JournalEntry|null>}
   */
  async amendEntity(entry, type, entity) {
    if (!entry || !this.canWrite()) return null;
    try {
      return await this._updateEntity(entry, type, entity, null);
    } catch (e) {
      console.warn(LOG_PREFIX, "amendEntity failed:", e?.message || e);
      return null;
    }
  },

  /**
   * Rewrite an entry's canonical body, ARCHIVING the prior content first so
   * nothing is ever lost. The old body is moved into a collapsible
   * "Archived — <timestamp>" <details> block placed BELOW the new content.
   *
   * @param {JournalEntry} entry  resolved via _findEntry()
   * @param {string} type         "npc" | "location" | "discovery"
   * @param {object|string} body  an entities[]-shaped object (rendered via
   *                              _renderEntityHtml) OR a ready HTML string.
   * @param {object} [opts]
   * @param {string} [opts.reason] short note recorded in the archive header.
   * @returns {Promise<JournalEntry|null>}
   */
  async rewriteEntity(entry, type, body, opts = {}) {
    if (!entry || !this.canWrite()) return null;
    try {
      const page = entry.pages?.contents?.[0] ?? entry.pages?.find?.(() => true);
      const prev = page?.text?.content ?? "";

      // Build the new canonical HTML. Accept either a structured entity object
      // or a raw HTML string (the AI/command may supply either).
      let newHtml;
      if (typeof body === "string") {
        newHtml = body;
      } else if (body && typeof body === "object") {
        // Ensure the rewrite carries the entry's current title if none given.
        const ent = { name: entry.name, ...body };
        newHtml = this._renderEntityHtml(type, ent);
      } else {
        newHtml = prev; // nothing usable supplied — no-op rewrite
      }

      // ARCHIVE prior content (never destroy). Skip if there was none.
      const archived = prev.trim() ? this._archiveBody(prev, opts.reason) : "";
      const merged = `${newHtml}${archived}`;

      if (page) await page.update({ "text.content": merged });

      // Refresh flags + memory + links, exactly like _updateEntity does.
      const aiCtx = (body && typeof body === "object") ? this._entityContext({ name: entry.name, ...body }) : "";
      await entry.update({
        flags: {
          [MODULE_ID]: {
            type,
            lastUpdated: Date.now(),
            aiContext: aiCtx
              ? `${(entry.getFlag?.(MODULE_ID, "aiContext") || "")}\n${aiCtx}`.trim().slice(0, 4000)
              : (entry.getFlag?.(MODULE_ID, "aiContext") || "")
          }
        }
      });

      if (this.notifyLevel() !== "none") this._toast(entry.name, type, "Rewrote");
      RagBridge.indexEntry(entry);
      try { EntityLinker.invalidate(); } catch (_) {}
      return entry;
    } catch (e) {
      console.warn(LOG_PREFIX, "rewriteEntity failed:", e?.message || e);
      return null;
    }
  },

  /**
   * Wrap prior page content in a collapsible, clearly-labelled archive block so
   * a rewrite never loses history. Returns an HTML fragment to append after the
   * new canonical body.
   */
  _archiveBody(prevHtml, reason = "") {
    const stamp = new Date().toLocaleString();
    const why = reason ? ` — ${escapeHtml(String(reason).slice(0, 200))}` : "";
    return `\n<hr class="es-journal-sep"/>\n` +
      `<details class="es-journal-archive">` +
      `<summary><em>Archived — ${escapeHtml(stamp)}${why}</em></summary>\n` +
      `${prevHtml}\n` +
      `</details>`;
  },

  /**
   * Queue worker for a rewrite/amend/rename/merge job. Resolves the target via
   * the existing fuzzy _findEntry() matcher and dispatches to the archive-safe
   * mutators. Used by GM commands and accepted proposals.
   *
   * job = { kind:"rewrite", op, type, target, aliases?, body?, newName?,
   *         mergeWith?, reason? }
   */
  async _processRewrite(job) {
    const { op = "rewrite", type, target, aliases = [], body, newName, mergeWith, reason } = job;
    const entry = this._findEntry(type, target, aliases);
    if (!entry) {
      console.warn(LOG_PREFIX, `[rewrite] no entry found for "${target}" (${type})`);
      try { Chat.postSystem(`<em>No chronicle entry found for “${escapeHtml(String(target))}”.</em>`, { gmWhisper: true }); } catch (_) {}
      return null;
    }
    switch (op) {
      case "amend":  return this.amendEntity(entry, type, body || {});
      case "rewrite":return this.rewriteEntity(entry, type, body, { reason });
      case "rename": return this._renameEntity(entry, type, newName, { reason });
      case "merge":  return this._mergeEntities(entry, type, mergeWith, { reason });
      default:       return this.rewriteEntity(entry, type, body, { reason });
    }
  },

  /** Retitle an entry and fold its old name into aliases (history-safe). */
  async _renameEntity(entry, type, newName, opts = {}) {
    if (!entry || !newName || !this.canWrite()) return null;
    try {
      const oldName = entry.name;
      const mergedAliases = this._mergeAliases(this._entryAliases(entry), [oldName]);
      await entry.update({
        name: String(newName).slice(0, 100),
        flags: { [MODULE_ID]: { type, lastUpdated: Date.now(), aliases: mergedAliases } }
      });
      try {
        const page = entry.pages?.contents?.[0];
        if (page) await page.update({ name: String(newName).slice(0, 100) });
      } catch (_) {}
      if (this.notifyLevel() !== "none") this._toast(newName, type, "Renamed");
      RagBridge.indexEntry(entry);
      try { EntityLinker.invalidate(); } catch (_) {}
      return entry;
    } catch (e) {
      console.warn(LOG_PREFIX, "_renameEntity failed:", e?.message || e);
      return null;
    }
  },

  /**
   * Merge a duplicate into the canonical entry: archive the duplicate's body
   * into the keeper, absorb its aliases, then delete the duplicate. The
   * duplicate's content is preserved inside the keeper's archive block.
   */
  async _mergeEntities(keeper, type, dupName, opts = {}) {
    if (!keeper || !dupName || !this.canWrite()) return null;
    try {
      const dup = this._findEntry(type, dupName, []);
      if (!dup || dup.id === keeper.id) return keeper;
      const dupPage = dup.pages?.contents?.[0];
      const dupBody = dupPage?.text?.content ?? "";
      const keepPage = keeper.pages?.contents?.[0];
      const keepBody = keepPage?.text?.content ?? "";
      const merged = `${keepBody}${this._archiveBody(dupBody, `Merged from “${dup.name}”${opts.reason ? ` — ${opts.reason}` : ""}`)}`;
      if (keepPage) await keepPage.update({ "text.content": merged });
      const mergedAliases = this._mergeAliases(
        this._entryAliases(keeper), [dup.name, ...this._entryAliases(dup)]
      );
      await keeper.update({ flags: { [MODULE_ID]: { type, lastUpdated: Date.now(), aliases: mergedAliases } } });
      try { await dup.delete(); } catch (_) {}
      if (this.notifyLevel() !== "none") this._toast(keeper.name, type, "Merged");
      RagBridge.indexEntry(keeper);
      try { EntityLinker.invalidate(); } catch (_) {}
      return keeper;
    } catch (e) {
      console.warn(LOG_PREFIX, "_mergeEntities failed:", e?.message || e);
      return null;
    }
  },

  /* ---------------- AI edit proposals (v0.14.0) ---------------- */

  /**
   * Sanitise + route AI-emitted edit proposals according to journalEditMode.
   * - manual : drop (defensive; the protocol block isn't even sent in manual).
   * - propose: post ONE GM-only Accept/Reject card per valid proposal.
   * - auto   : enqueue the rewrite directly — active-GM client only.
   *
   * @param {Array<object>} proposals
   * @param {object} ctx
   */
  _handleProposals(proposals, ctx = {}) {
    const mode = this.editMode();
    if (mode === "manual") return;
    if (!this.canWrite()) return;

    for (const p of proposals) {
      const clean = this._sanitizeProposal(p);
      if (!clean) continue;

      if (mode === "auto") {
        // Apply automatically, but only on the one host client to avoid dupes.
        if (!this._isAutoApplyHost()) continue;
        this.queue().enqueue({ kind: "rewrite", ...clean });
      } else {
        // propose → GM-only review card (only the active host posts it, so a
        // table with several GMs doesn't get duplicate cards).
        if (!this._isAutoApplyHost()) continue;
        this._postProposalCard(clean);
      }
    }
  },

  /** Validate + normalise one proposal object. Returns a queue-ready job or null. */
  _sanitizeProposal(p) {
    if (!p || typeof p !== "object") return null;
    const op = String(p.op || "").toLowerCase();
    if (!["rewrite", "merge", "rename", "amend"].includes(op)) return null;
    const type = String(p.type || "").toLowerCase();
    if (!["npc", "location", "discovery"].includes(type)) return null;
    const target = String(p.target || "").trim();
    if (!target) return null;

    const job = { op, type, target, aliases: [], reason: String(p.reason || "").slice(0, 240) };
    if (op === "rewrite" || op === "amend") {
      // body may be a structured entity object OR an HTML string.
      job.body = (typeof p.body === "string") ? p.body
        : (p.body && typeof p.body === "object") ? p.body : {};
    }
    if (op === "rename") {
      job.newName = String(p.newName || "").trim().slice(0, 100);
      if (!job.newName) return null;
    }
    if (op === "merge") {
      job.mergeWith = String(p.mergeWith || "").trim();
      if (!job.mergeWith) return null;
    }
    return job;
  },

  /**
   * Post a GM-only chat card describing a proposed edit with Accept / Reject
   * buttons. The full job payload is stashed in the message flags so the
   * button handler (Integration.wireSuggestionCard) can enqueue it verbatim on
   * Accept — no re-derivation, no drift.
   */
  async _postProposalCard(job) {
    const opLabel = { rewrite: "Rewrite", amend: "Amend", rename: "Rename", merge: "Merge" }[job.op] || "Edit";
    const detail = (() => {
      if (job.op === "rename") return `→ rename to <strong>${escapeHtml(job.newName)}</strong>`;
      if (job.op === "merge")  return `→ merge with <strong>${escapeHtml(job.mergeWith)}</strong>`;
      return "";
    })();
    const reason = job.reason ? `<p class="es-proposal-reason"><em>${escapeHtml(job.reason)}</em></p>` : "";
    const content =
      `<p class="es-proposal-head">📜 The Skald proposes to <strong>${escapeHtml(opLabel)}</strong> ` +
      `the chronicle entry <strong>${escapeHtml(job.target)}</strong> ${detail}</p>` +
      reason +
      `<div class="es-proposal-actions">` +
      `<button type="button" class="es-action-move-btn es-proposal-accept" data-skald-action="journal-accept">Accept</button>` +
      `<button type="button" class="es-action-move-btn es-proposal-reject" data-skald-action="journal-reject">Reject</button>` +
      `</div>`;

    try {
      // Chat.postSkald spreads opts.flags DIRECTLY into flags[MODULE_ID], so the
      // bare key lands at flags[MODULE_ID].journalProposal and is read back via
      // msg.getFlag(MODULE_ID, "journalProposal"). NO change to postSkald needed.
      return await Chat.postSkald(content, {
        variant: "lore",
        title: "Chronicle Proposal",
        gmWhisper: true,
        flags: { journalProposal: job }
      });
    } catch (e) {
      console.warn(LOG_PREFIX, "_postProposalCard failed:", e?.message || e);
      return null;
    }
  },

  /**
   * Enqueue an accepted proposal (called by the Accept button handler). Reads
   * the stashed job from the message flag and routes it through the serial,
   * archive-safe rewrite queue.
   */
  acceptProposal(job) {
    if (!job || !this.canWrite()) return false;
    try {
      this.queue().enqueue({ kind: "rewrite", ...job });
      return true;
    } catch (e) {
      console.warn(LOG_PREFIX, "acceptProposal failed:", e?.message || e);
      return false;
    }
  },

  /* ---------------- aliases & relationships (v0.8.0) ---------------- */

  /** Sanitise the AI-supplied `aliases` array into clean, de-duped strings. */
  _extractAliases(entity) {
    const raw = entity?.aliases;
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const a of raw) {
      const s = String(a ?? "").trim().slice(0, 80);
      if (!s) continue;
      const k = s.toLowerCase();
      // Don't store an "alias" that merely repeats the entity's own name.
      if (k === String(entity?.name ?? "").toLowerCase().trim()) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
    return out.slice(0, 12);
  },

  /** Union two alias lists, de-duped case-insensitively, capped. */
  _mergeAliases(existing, incoming) {
    const out = [];
    const seen = new Set();
    for (const a of [...(existing || []), ...(incoming || [])]) {
      const s = String(a ?? "").trim();
      if (!s) continue;
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
    return out.slice(0, 16);
  },

  /** Sanitise the AI-supplied `related` array into [{name, rel}] tuples. */
  _extractRelated(entity) {
    const raw = entity?.related ?? entity?.relatedEntities;
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const r of raw) {
      if (!r) continue;
      let name, rel;
      if (typeof r === "string") { name = r; rel = "related"; }
      else if (typeof r === "object") {
        name = r.name ?? r.entity ?? r.target;
        rel = r.rel ?? r.relationship ?? r.relation ?? "related";
      }
      name = String(name ?? "").trim().slice(0, 100);
      rel = String(rel ?? "related").trim().slice(0, 80) || "related";
      if (name) out.push({ name, rel });
    }
    return out.slice(0, 24);
  },

  /** Find any individual (npc/location/discovery) entry by name/alias. */
  _findAnyEntry(name) {
    for (const t of ["npc", "location", "discovery"]) {
      const hit = this._findEntry(t, name);
      if (hit) return hit;
    }
    return null;
  },

  /** Read the relatedEntities array off an entry (always an array). */
  _entryRelated(entry) {
    try {
      const r = entry?.getFlag?.(MODULE_ID, "relatedEntities");
      return Array.isArray(r) ? r.slice() : [];
    } catch (_) { return []; }
  },

  /** Merge a relationship into a relatedEntities list, de-duped by uuid. */
  _mergeRelated(list, rec) {
    const out = (list || []).filter(x => x && x.uuid !== rec.uuid);
    out.push(rec);
    return out.slice(0, 50);
  },

  /**
   * Resolve an entity's declared `related` connections to existing chronicle
   * entries and persist them as UUIDs in the `relatedEntities` flag — on BOTH
   * sides (bidirectional, v0.8.0). Targets that don't yet have an entry are
   * skipped silently (they'll link the next time either side is mentioned).
   */
  async _syncRelationships(entry, entity) {
    const related = this._extractRelated(entity);
    if (!related.length || !entry) return;
    const selfUuid = entry.uuid ?? `JournalEntry.${entry.id}`;
    let myList = this._entryRelated(entry);
    const touched = new Set(); // target entries whose connections block needs refresh

    for (const { name, rel } of related) {
      const target = this._findAnyEntry(name);
      // Skip self-references and unresolved targets.
      if (!target) continue;
      const tUuid = target.uuid ?? `JournalEntry.${target.id}`;
      if (tUuid === selfUuid) continue;

      // Forward: me → target.
      myList = this._mergeRelated(myList, { uuid: tUuid, name: target.name, rel });

      // Reciprocal: target → me (only if not already present with this uuid).
      try {
        const tList = this._mergeRelated(this._entryRelated(target),
          { uuid: selfUuid, name: entry.name, rel });
        await target.update({ flags: { [MODULE_ID]: { relatedEntities: tList } } });
        await this._refreshConnectionsBlock(target, tList);
        touched.add(tUuid);
      } catch (e) {
        console.warn(LOG_PREFIX, "reciprocal relationship write failed:", e?.message || e);
      }
    }

    try {
      await entry.update({ flags: { [MODULE_ID]: { relatedEntities: myList } } });
      await this._refreshConnectionsBlock(entry, myList);
    } catch (e) {
      console.warn(LOG_PREFIX, "relationship write failed:", e?.message || e);
    }
  },

  /** Build the HTML for an entry's Connections section (content links). */
  _renderConnectionsBlock(list) {
    if (!Array.isArray(list) || !list.length) return "";
    const items = list.map(r => {
      const label = escapeHtml(String(r.name ?? "").replace(/[{}]/g, "")) || "(unknown)";
      const link = r.uuid ? `@UUID[${r.uuid}]{${label}}` : label;
      const rel = r.rel && r.rel !== "related" ? ` — <em>${escapeHtml(String(r.rel))}</em>` : "";
      return `<li>${link}${rel}</li>`;
    }).join("");
    return `<div class="es-connections" data-es-connections="1">` +
      `<hr class="es-journal-sep"/>` +
      `<p class="es-connections-head"><strong>🔗 Connections</strong></p>` +
      `<ul class="es-connections-list">${items}</ul></div>`;
  },

  /**
   * Rewrite (idempotently) the Connections block at the end of an entry's
   * first page so the relationship list is visible inside the journal too.
   * Strips any previous block first, keyed by the data-es-connections marker.
   */
  async _refreshConnectionsBlock(entry, list) {
    try {
      const page = entry.pages?.contents?.[0] ?? entry.pages?.find?.(() => true);
      if (!page) return;
      let content = page.text?.content ?? "";
      // Remove a previously-injected connections block, if any.
      content = content.replace(/<div class="es-connections"[\s\S]*?<\/div>\s*$/i, "").trimEnd();
      const block = this._renderConnectionsBlock(list);
      if (block) content = `${content}\n${block}`;
      await page.update({ "text.content": content });
    } catch (e) {
      console.warn(LOG_PREFIX, "connections block refresh failed:", e?.message || e);
    }
  },

  async _processFacts(job) {
    const items = job.facts.map(f => `<li>${escapeHtml(f)}</li>`).join("");
    const stamp = new Date().toLocaleString();
    const block = `<p class="es-journal-stamp"><em>${escapeHtml(stamp)}</em></p><ul>${items}</ul>`;
    await this._appendRolling("worldFact", block, job.facts.join(" · "), job.sourceVow);
    // World Facts are silent by design — no toast.
  },

  async _processThread(job) {
    const parts = [];
    if (job.mysteries?.length) {
      parts.push(`<p><strong>🧵 Mysteries</strong></p><ul>${job.mysteries.map(m => `<li>${escapeHtml(m)}</li>`).join("")}</ul>`);
    }
    if (job.decisions?.length) {
      parts.push(`<p><strong>⚖️ Decisions</strong></p><ul>${job.decisions.map(d => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`);
    }
    if (job.worldState && Object.keys(job.worldState).length) {
      const rows = Object.entries(job.worldState)
        .map(([k, v]) => `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(String(v))}</li>`).join("");
      parts.push(`<p><strong>🌍 World State</strong></p><ul>${rows}</ul>`);
    }
    if (!parts.length) return;
    const stamp = new Date().toLocaleString();
    const block = `<p class="es-journal-stamp"><em>${escapeHtml(stamp)}</em></p>${parts.join("")}`;
    const ctx = [
      ...(job.mysteries || []),
      ...(job.decisions || []),
      ...Object.entries(job.worldState || {}).map(([k, v]) => `${k}: ${v}`)
    ].join(" · ");
    await this._appendRolling("storyThread", block, ctx, job.sourceVow);
    // Story Threads are silent by design — no toast.
  },

  /* ---------------- rolling-journal helper ---------------- */

  /**
   * Append an HTML block to the single rolling journal for a silent type
   * (World Facts / Story Threads), creating it on first use.
   */
  async _appendRolling(typeKey, html, contextLine, sourceVow) {
    const spec = this.TYPES[typeKey];
    if (!spec) return null;
    const folder = await this.getOrCreateFolder(typeKey);
    let entry = this._findRolling(typeKey, spec.journalName);

    if (!entry) {
      entry = await JournalEntry.create({
        name: spec.journalName,
        folder: folder?.id ?? null,
        ownership: this._ownership(),
        pages: [{
          name: spec.journalName,
          type: "text",
          text: { content: `<h2>${spec.emoji} ${escapeHtml(spec.journalName)}</h2>${html}`, format: 1 }
        }],
        flags: {
          [MODULE_ID]: {
            type: typeKey,
            createdBy: "ai",
            lastUpdated: Date.now(),
            relatedEntities: [],
            sourceVow: sourceVow ?? null,
            aiContext: contextLine || ""
          }
        }
      });
      // Embed the freshly-created rolling journal (v0.5.0).
      RagBridge.indexEntry(entry);
      return entry;
    }

    const page = entry.pages?.contents?.[0] ?? entry.pages?.find?.(() => true);
    if (page) {
      const prev = page.text?.content ?? "";
      await page.update({ "text.content": `${prev}\n${html}` });
    }
    const existingCtx = entry.getFlag?.(MODULE_ID, "aiContext") || "";
    await entry.update({
      flags: {
        [MODULE_ID]: {
          type: typeKey,
          createdBy: "ai",
          lastUpdated: Date.now(),
          sourceVow: sourceVow ?? entry.getFlag?.(MODULE_ID, "sourceVow") ?? null,
          aiContext: `${existingCtx}\n${contextLine || ""}`.trim().slice(0, 6000)
        }
      }
    });
    // Re-embed the appended rolling journal (v0.5.0).
    RagBridge.indexEntry(entry);
    return entry;
  },

  /* ---------------- entry rendering ---------------- */

  /**
   * Render the full HTML body for a new templated entry (v0.8.0). Driven by
   * the type's `fields` template: the `description` field becomes the lead
   * paragraph; every other populated field becomes a labelled row. Unknown /
   * empty fields are skipped, so legacy and partial entities render fine.
   */
  _renderEntityHtml(type, e) {
    const spec = this.TYPES[type];
    const fields = spec?.fields ?? [{ key: "description", label: "Description", area: true }];
    const desc = e.description ? `<p class="es-entity-desc">${escapeHtml(e.description)}</p>` : "";
    const rows = [];
    for (const f of fields) {
      if (f.key === "description") continue; // rendered above
      const v = e[f.key];
      if (v == null || String(v).trim() === "") continue;
      rows.push([f.label, v]);
    }
    const list = rows.length
      ? `<ul class="es-entity-fields">${rows.map(([k, v]) => `<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(String(v))}</li>`).join("")}</ul>`
      : "";
    return `<h2>${spec?.emoji ?? ""} ${escapeHtml(e.name)}</h2>${desc}${list}` +
           `<p class="es-journal-foot"><em>Recorded by The Eternal Skald.</em></p>`;
  },

  _renderEntityUpdateHtml(e) {
    const stamp = new Date().toLocaleString();
    const desc = e.description ? `<p>${escapeHtml(e.description)}</p>` : "";
    const extras = [];
    // Iterate every templated field key so new fields (rank/harm/goals/
    // region/resources) are picked up on updates too.
    for (const k of this._allFieldKeys()) {
      if (k === "description") continue;
      if (e[k] != null && String(e[k]).trim() !== "") {
        extras.push(`<li><strong>${escapeHtml(k)}:</strong> ${escapeHtml(String(e[k]))}</li>`);
      }
    }
    const list = extras.length ? `<ul>${extras.join("")}</ul>` : "";
    return `<p class="es-journal-stamp"><em>Update — ${escapeHtml(stamp)}</em></p>${desc}${list}`;
  },

  _entityContext(e) {
    const bits = [e.name, ...this._allFieldKeys().map(k => e[k])]
      .filter(Boolean).join(" | ");
    return bits.slice(0, 2000);
  },

  /* ---------------- folder management ---------------- */

  async _getRootFolder() {
    const cacheKey = `__root__`;
    if (this._folderCache.has(cacheKey)) return this._folderCache.get(cacheKey);
    let root = game.folders?.find(f => f.type === "JournalEntry" && f.name === this.ROOT_FOLDER && !f.folder);
    if (!root) {
      try {
        root = await Folder.create({ name: this.ROOT_FOLDER, type: "JournalEntry", color: this._folderColor });
      } catch (e) { console.warn(LOG_PREFIX, "root folder create failed", e); root = null; }
    }
    this._folderCache.set(cacheKey, root);
    return root;
  },

  /** Get or create the typed sub-folder under the root, on first use. */
  async getOrCreateFolder(typeKey) {
    const spec = this.TYPES[typeKey];
    if (!spec) return null;
    if (this._folderCache.has(typeKey)) return this._folderCache.get(typeKey);

    const root = await this._getRootFolder();
    let folder = game.folders?.find(f =>
      f.type === "JournalEntry" && f.name === spec.folder &&
      (f.folder?.id ?? f.folder) === (root?.id ?? null)
    );
    if (!folder) {
      try {
        folder = await Folder.create({
          name: spec.folder,
          type: "JournalEntry",
          folder: root?.id ?? null,
          color: this._folderColor
        });
      } catch (e) { console.warn(LOG_PREFIX, `folder '${spec.folder}' create failed`, e); folder = root; }
    }
    this._folderCache.set(typeKey, folder);
    return folder;
  },

  /* ---------------- lookups ---------------- */

  /** All journal entries this module created, optionally filtered by type. */
  listEntries(typeFilter = null) {
    try {
      return (game.journal?.contents ?? []).filter(j => {
        const t = j.getFlag?.(MODULE_ID, "type");
        const by = j.getFlag?.(MODULE_ID, "createdBy");
        // Accept both AI-scribed and manually-templated (v0.8.0) entries.
        if (!t || (by !== "ai" && by !== "manual")) return false;
        return typeFilter ? t === typeFilter : true;
      });
    } catch (_) { return []; }
  },

  /* ---------------- fuzzy name matching (v0.8.0) ---------------- */

  /** Strip punctuation/articles and collapse whitespace for fuzzy compares. */
  _normName(s) {
    return String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\b(the|a|an|of|some)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  },

  /** Damerau-Levenshtein distance (small strings) for typo tolerance. */
  _editDistance(a, b) {
    a = String(a); b = String(b);
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) d[i][0] = i;
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[m][n];
  },

  /** Read the stored alias array off an entry (always an array). */
  _entryAliases(entry) {
    try {
      const a = entry?.getFlag?.(MODULE_ID, "aliases");
      return Array.isArray(a) ? a.filter(s => typeof s === "string" && s.trim()) : [];
    } catch (_) { return []; }
  },

  /**
   * Find an existing individual entry of a type by name. Tries, best → worst:
   * exact (case-insensitive) → stored-alias match → normalised-equal →
   * close edit-distance. This lets later mentions ("the captain", "Reeves",
   * "Capt. Reeves") resolve to the same "Captain Reeves" entry instead of
   * spawning a duplicate. Returns null when no confident match is found.
   *
   * @param {string} type   entity type ("npc"|"location"|"discovery")
   * @param {string} name   the name to resolve
   * @param {string[]} [aliases]  extra alias candidates to also match on
   */
  _findEntry(type, name, aliases = []) {
    const list = this.listEntries(type);
    if (!list.length) return null;
    const lc = String(name).toLowerCase().trim();

    // 1. Exact (case-insensitive) title match.
    let hit = list.find(j => j.name?.toLowerCase().trim() === lc);
    if (hit) return hit;

    // Candidate set of names we're trying to resolve (the name + any aliases
    // the AI supplied for this mention).
    const candidates = [lc, ...aliases.map(a => String(a).toLowerCase().trim())]
      .filter(Boolean);
    const candNorms = [...new Set(candidates.map(c => this._normName(c)).filter(Boolean))];

    // 2. Match against each entry's stored title OR its stored aliases.
    for (const j of list) {
      const names = [j.name, ...this._entryAliases(j)].filter(Boolean);
      for (const nm of names) {
        const nmLc = String(nm).toLowerCase().trim();
        if (candidates.includes(nmLc)) return j;
        const nmNorm = this._normName(nm);
        if (nmNorm && candNorms.includes(nmNorm)) return j;
      }
    }

    // 3. Fuzzy edit-distance on the normalised primary name (typo tolerance).
    const norm = this._normName(name);
    if (norm.length >= 4) {
      let best = null, bestDist = Infinity;
      for (const j of list) {
        const names = [j.name, ...this._entryAliases(j)];
        for (const nm of names) {
          const d = this._editDistance(norm, this._normName(nm));
          if (d < bestDist) { bestDist = d; best = j; }
        }
      }
      const tol = Math.min(3, Math.max(2, Math.floor(norm.length * 0.25)));
      if (best && bestDist <= tol) return best;
    }
    return null;
  },

  /** Find the single rolling journal for a silent type. */
  _findRolling(typeKey, journalName) {
    const lc = String(journalName).toLowerCase();
    return this.listEntries(typeKey).find(j => j.name?.toLowerCase() === lc) ?? null;
  },

  /* ---------------- ownership / vow ---------------- */

  _ownership() {
    const lvls = (typeof CONST !== "undefined" && CONST.DOCUMENT_OWNERSHIP_LEVELS) || {};
    if (this.permission() === "shared") {
      return { default: lvls.OBSERVER ?? 2 };
    }
    return { default: lvls.NONE ?? 0 };   // gm-only (default)
  },

  /** Best-effort id of the active character's first incomplete vow. */
  _currentVowId() {
    try {
      if (!Integration.active()) return null;
      const actor = IronswornController.getActiveCharacter?.();
      if (!actor) return null;
      const tracks = IronswornController.getProgressTracks?.(actor) ?? [];
      // Modern foundry-ironsworn stores a vow as a `progress` Item with
      // system.subtype === "vow" (older revisions used type "vow"), so match
      // either. Prefer the first still-open vow; fall back to any vow.
      const isVow = t => String(t.subtype || t.type || "").toLowerCase() === "vow";
      const vow = tracks.find(t => isVow(t) && !t.completed) ?? tracks.find(isVow);
      return vow?.id ?? null;
    } catch (_) { return null; }
  },

  /* ---------------- notifications ---------------- */

  /**
   * Minimal bottom-right toast: "📝 Added [name] to [type] journal".
   * Respects the journalNotifications setting ("none" silences everything).
   */
  _toast(name, typeKey, verb = "Added") {
    const level = this.notifyLevel();
    if (level === "none") return;
    const spec = this.TYPES[typeKey] || { label: typeKey, emoji: "📝" };
    const label = spec.label || typeKey;
    try {
      let host = document.getElementById("es-journal-toasts");
      if (!host) {
        host = document.createElement("div");
        host.id = "es-journal-toasts";
        document.body.appendChild(host);
      }
      const el = document.createElement("div");
      el.className = "es-journal-toast";
      el.innerHTML = `<span class="es-jt-icon">📝</span><span class="es-jt-text">${verb} <strong>${escapeHtml(name)}</strong> to ${escapeHtml(label)} journal</span>`;
      host.appendChild(el);
      // Trigger fade-in, then auto-remove after ~2s.
      requestAnimationFrame(() => el.classList.add("es-jt-show"));
      setTimeout(() => {
        el.classList.remove("es-jt-show");
        setTimeout(() => { try { el.remove(); } catch (_) {} }, 400);
      }, 2000);
    } catch (e) {
      // DOM not available (e.g. headless) — fall back to a quiet console note.
      console.log(LOG_PREFIX, `${verb} ${name} to ${label} journal`);
    }
  },

  /* ---------------- session chronicle ---------------- */

  /**
   * Generate a Session Chronicle from the in-memory activity log. Asks the
   * AI to weave a saga-styled recap, then writes it as a dated journal and
   * clears the log. Triggered by !end-session.
   */
  async generateSessionChronicle({ announce = true, auto = false } = {}) {
    // (v0.9.0) Whether triggered manually (!end-session) or automatically by
    // the idle timer, cancel any pending idle timer so we don't double-fire.
    try { this._clearIdleTimer(); } catch (_) {}

    if (!this.canWrite()) {
      ui.notifications?.warn(`${SKALD_NAME}: only the GM can close a session chronicle.`);
      return null;
    }
    const log = this._sessionLog.slice();
    if (!log.length) {
      await Chat.postSystem(`<em>The chronicle is bare — nothing notable was recorded this session.</em>`, { gmWhisper: true });
      return null;
    }

    // Build a compact digest for the AI from the log.
    const allFacts     = [...new Set(log.flatMap(e => e.facts))];
    const allMysteries = [...new Set(log.flatMap(e => e.mysteries))];
    const allDecisions = [...new Set(log.flatMap(e => e.decisions))];
    const allEntities  = [...new Map(log.flatMap(e => e.entities).filter(x => x?.name).map(x => [x.name, x])).values()];
    const worldState   = Object.assign({}, ...log.map(e => e.worldState || {}));

    const digest = [
      allEntities.length  ? `Notable figures & places: ${allEntities.map(e => `${e.name} (${e.type})`).join(", ")}` : "",
      allDecisions.length ? `Key decisions: ${allDecisions.join("; ")}` : "",
      allFacts.length     ? `Established facts: ${allFacts.join("; ")}` : "",
      allMysteries.length ? `Open mysteries: ${allMysteries.join("; ")}` : "",
      Object.keys(worldState).length ? `World state: ${Object.entries(worldState).map(([k, v]) => `${k}=${v}`).join(", ")}` : ""
    ].filter(Boolean).join("\n");

    const task = `Compose a SESSION CHRONICLE — a saga-styled recap of the session just ended, in your Skald voice. Use these recorded facts (do NOT invent beyond them; weave what is given):\n${digest}\n\nStructure it with short headed sections using **bold** headers: **What Happened**, **Decisions**, **Consequences**, **Unresolved Threads**. Keep it tight and evocative (4-8 short paragraphs total). Do NOT append any metadata block.`;

    let recap;
    try {
      recap = await Client.chat([
        { role: "system", content: buildSystemPrompt({ task }) },
        { role: "user", content: "Close the chronicle for this session." }
      ], { temperature: 0.8, maxTokens: 1200 });
    } catch (e) {
      console.warn(LOG_PREFIX, "session chronicle AI call failed:", e?.message || e);
      // Degrade: write a plain digest if the AI is unreachable.
      recap = `**What Happened**\n${digest || "(no details)"}`;
    }

    const folder = await this.getOrCreateFolder("session");
    // (v0.9.0) Mark auto-generated chronicles so the GM can tell them apart.
    const title = `Session Chronicle — ${new Date().toLocaleDateString()}${auto ? " (auto)" : ""}`;
    // Stored in a JournalEntry — keep plain (move links have no handler there).
    const html = `<h2>📖 ${escapeHtml(title)}</h2>${formatMarkdown(recap, { link: false })}`;
    const entry = await JournalEntry.create({
      name: title,
      folder: folder?.id ?? null,
      ownership: this._ownership(),
      pages: [{ name: title, type: "text", text: { content: html, format: 1 } }],
      flags: {
        [MODULE_ID]: {
          type: "session",
          createdBy: "ai",
          lastUpdated: Date.now(),
          relatedEntities: [],
          sourceVow: this._currentVowId(),
          aiContext: digest.slice(0, 6000),
          auto: !!auto // (v0.9.0) idle-timer-generated vs manual !end-session
        }
      }
    });

    if (entry) {
      // Embed the session chronicle into semantic memory (v0.5.0).
      RagBridge.indexEntry(entry);
      if (announce) {
        const intro = auto
          ? `<p class="es-help-aside"><em>Auto-woven after a lull. Type <code>!end-session</code> any time to close one yourself.</em></p>`
          : "";
        await Chat.postSkald(intro + formatMarkdown(recap), { variant: "lore", title });
        this._toast(title, "session");
      }
    }
    // Clear the log — a new session begins.
    this._sessionLog = [];
    return entry;
  }
};
