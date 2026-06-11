import { LOG_PREFIX, MODULE_ID, SKALD_NAME, DEFAULT_MODEL } from "../core/constants.js";
import { Settings } from "../core/settings.js";
import { Client } from "../ai/client.js";
import { Chat, escapeHtml } from "../chat/display.js";
import { JournalSystem } from "../chronicle/journal-system.js";

/**
 * The Eternal Skald can SEE the map. Given the active scene's background
 * artwork, a vision-capable (multimodal) AI model is asked to scout the
 * terrain, landmarks, paths, hazards and points of interest, and the result
 * is:
 *   • cached on the scene's flags so it is never re-analysed automatically;
 *   • posted to chat as a styled "Scouting" card;
 *   • scribed into the Living Chronicle as Location journal entries.
 *
 * Everything here is GM-only, read-only on the map itself (we only read the
 * BASE background image — never tokens, drawings or fog), and degrades
 * gracefully: missing background, a non-vision model, a tainted canvas or a
 * failed AI call all resolve to a quiet GM notice rather than an exception.
 *
 * Token efficiency: the image is downscaled to a max dimension and exported
 * as JPEG (quality 0.85) before upload, the prompt requests strict JSON, and
 * a scene is analysed at most once unless the GM forces a re-scout (!scout).
 */
export const MapVision = {
  /** Scene flag key under MODULE_ID that stores the cached analysis. */
  FLAG_KEY: "mapAnalysis",

  /**
   * (v0.10.24) The vision instruction, rewritten as a specialised fantasy-map
   * reading prompt. It explicitly directs the model to OCR text labels, spot
   * small symbols/icons, trace faint paths and roads, and catalogue every
   * settlement/structure — the things weaker prompts and models routinely
   * miss. Strict-JSON output keeps parsing reliable and bounds token cost. We
   * never ask the model to invent lore — only to report what is visibly
   * depicted (including the literal text printed on the map).
   */
  VISION_PROMPT: [
    "You are an expert fantasy cartographer scouting a tabletop RPG map image for a Game Master.",
    "Read this map with extreme care and high attention to small detail. Maps often contain:",
    "  • TEXT LABELS — place names, region names, titles, legends and captions. READ THEM LETTER BY LETTER and transcribe the exact wording. Do not skip small or stylised text.",
    "  • SMALL SYMBOLS & ICONS — towns (dots/houses), castles, towers, ruins, mountains, trees/forests, bridges, mines, caves, ports, temples. Note even tiny ones.",
    "  • PATHS & ROADS — trails, roads, rivers, borders and routes, EVEN IF FAINT, dotted or partially hidden. Describe where they run.",
    "  • STRUCTURES & SETTLEMENTS — every city, town, village, keep, fort, outpost or landmark, however small.",
    "Be thorough: prefer listing a faint or uncertain feature (with lower confidence) over omitting it.",
    "Respond with STRICT JSON only — no prose, no markdown fences — in exactly this shape:",
    "{",
    '  "summary": "<2-3 sentence overview of the terrain and atmosphere>",',
    '  "terrain": "<dominant terrain and notable natural features>",',
    '  "labels": ["<each distinct text label / name you can read, transcribed exactly>"],',
    '  "pois": [',
    '    { "name": "<the label text if readable, else a short 2-4 word name>", "type": "<landmark|path|road|hazard|structure|settlement|water|forest|mountain|ruin|natural|other>", "description": "<one concise sentence of what is depicted>", "location": "<approximate position, e.g. north-west, centre, lower edge>", "confidence": "<high|medium|low>" }',
    "  ]",
    "}",
    "List as many genuinely distinct POIs as you can find (aim for completeness, typically 5-20 on a detailed map). Transcribe label text verbatim. Describe ONLY what is visibly depicted; do not invent character names or backstory."
  ].join("\n"),

  /** True iff automatic scene analysis is enabled (defaults to ON). */
  enabled() { return Settings.get("autoAnalyzeScenes") !== false; },

  /** Only the GM may scout (it writes scene flags and journal entries). */
  _canWrite() {
    try { return !!(game?.user?.isGM); } catch (_) { return false; }
  },

  /** Resolve which model should perform vision (honouring "inherit"). */
  _visionModel() {
    const sel = Settings.get("visionModel") || "inherit";
    if (sel && sel !== "inherit") return sel;
    return Settings.get("modelName") || DEFAULT_MODEL;
  },

  /**
   * (v0.10.24) The longest-edge pixel cap for captured maps. Reads the
   * "maxMapResolution" setting; "original" → Infinity (no downscaling). Falls
   * back to 4096 when the setting is missing or invalid.
   * @returns {number}
   */
  _maxResolution() {
    try {
      const v = Settings.get("maxMapResolution");
      if (v === "original") return Infinity;
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? n : 4096;
    } catch (_) { return 4096; }
  },

  /**
   * (v0.10.24) The image MIME type to encode captures as. "auto" → PNG, which
   * keeps map text crisp (lossless) at the cost of a larger payload than JPEG.
   * @returns {{ mime: "image/png"|"image/jpeg", quality: number }}
   */
  _imageEncoding() {
    let fmt = "auto";
    try { fmt = Settings.get("imageFormat") || "auto"; } catch (_) { fmt = "auto"; }
    if (fmt === "jpeg") return { mime: "image/jpeg", quality: 0.92 };
    // "auto" and "png" both encode lossless PNG for maximum text clarity.
    return { mime: "image/png", quality: 1 };
  },

  /**
   * (v0.10.24) The configured analysis quality: "fast" | "balanced" |
   * "thorough". Defaults to "balanced".
   * @returns {"fast"|"balanced"|"thorough"}
   */
  _analysisQuality() {
    try {
      const v = String(Settings.get("mapAnalysisQuality") || "balanced").toLowerCase();
      return (v === "fast" || v === "thorough") ? v : "balanced";
    } catch (_) { return "balanced"; }
  },

  /** Resolve a scene argument to a concrete Scene (active/canvas fallback). */
  _resolveScene(scene) {
    if (scene && typeof scene === "object") return scene;
    try { return game?.scenes?.active ?? canvas?.scene ?? null; }
    catch (_) { return null; }
  },

  /**
   * The BASE background image source for a scene. Foundry v10+ stores it at
   * `scene.background.src`; very old data used `scene.img`. Tokens, tiles,
   * drawings and fog are intentionally NOT read — only the base map.
   */
  _sceneBackgroundSrc(scene) {
    try {
      const s = scene?.background?.src ?? scene?.img ?? null;
      return (typeof s === "string" && s.trim()) ? s.trim() : null;
    } catch (_) { return null; }
  },

  /** Read the cached analysis flag for a scene (or null). */
  getCached(scene) {
    try { return scene?.getFlag?.(MODULE_ID, this.FLAG_KEY) ?? null; }
    catch (_) { return null; }
  },

  /** Persist the analysis onto the scene's flags (GM-only, non-fatal). */
  async _storeAnalysis(scene, analysis) {
    try {
      if (!scene?.setFlag) return false;
      await scene.setFlag(MODULE_ID, this.FLAG_KEY, analysis);
      return true;
    } catch (e) {
      console.warn(LOG_PREFIX, "MapVision: could not store analysis flag:", e?.message || e);
      return false;
    }
  },

  /**
   * Turn a possibly-relative Foundry path (e.g. "worlds/x/maps/forest.webp")
   * into a same-origin absolute URL. Absolute http(s) and data: URLs are
   * returned unchanged. Used both for loading the image and for the
   * remote-URL pass-through fallback when canvas export is blocked by CORS.
   */
  _toAbsoluteUrl(src) {
    const s = String(src || "");
    if (!s) return "";
    if (/^(https?:|data:)/i.test(s)) return s;
    try {
      const origin = (typeof window !== "undefined" && window.location && window.location.origin)
        ? window.location.origin : "";
      if (!origin) return s;
      return `${origin}/${s.replace(/^\/+/, "")}`;
    } catch (_) { return s; }
  },

  /**
   * Load `src` into an <img>, draw it (optionally a cropped sub-region) onto an
   * offscreen <canvas> downscaled to `maxDim` (preserving aspect ratio) and
   * export as a data URL.
   *
   * (v0.10.24) Defaults raised to 4096 px and lossless PNG for crisp map text.
   * Options:
   *   • maxDim  {number}  longest-edge cap of the OUTPUT (default 4096; Infinity = no cap)
   *   • mime    {string}  "image/png" (default) or "image/jpeg"
   *   • quality {number}  encoder quality for lossy formats (default 1)
   *   • region  {object}  optional source crop {sx, sy, sw, sh} in image pixels
   *                       (used by the grid-sectioning analysis pass)
   *
   * Resolves to null (rather than rejecting) on any failure — missing DOM
   * APIs, a load error, or a CORS-tainted canvas that cannot be exported — so
   * the caller can fall back to passing a remote URL straight to the model.
   *
   * @returns {Promise<string|null>} a `data:image/…;base64,…` URL or null
   */
  _downscaleToDataUrl(src, opts = {}) {
    const maxDim = (typeof opts.maxDim === "number" && opts.maxDim > 0) ? opts.maxDim : 4096;
    const mime = opts.mime === "image/jpeg" ? "image/jpeg" : "image/png";
    const quality = typeof opts.quality === "number" ? opts.quality : 1;
    const region = (opts.region && typeof opts.region === "object") ? opts.region : null;
    return new Promise((resolve) => {
      try {
        if (typeof Image === "undefined" || typeof document === "undefined") { resolve(null); return; }
        const img = new Image();
        // crossOrigin only matters for remote http(s); data: URLs are same-origin.
        if (/^https?:/i.test(src)) img.crossOrigin = "anonymous";
        img.onload = () => {
          try {
            const fullW = img.naturalWidth || img.width;
            const fullH = img.naturalHeight || img.height;
            if (!fullW || !fullH) { resolve(null); return; }
            // Source rectangle: full image, or the requested crop region.
            let sx = 0, sy = 0, sw = fullW, sh = fullH;
            if (region) {
              sx = Math.max(0, Math.min(fullW - 1, Math.round(region.sx || 0)));
              sy = Math.max(0, Math.min(fullH - 1, Math.round(region.sy || 0)));
              sw = Math.max(1, Math.min(fullW - sx, Math.round(region.sw || fullW)));
              sh = Math.max(1, Math.min(fullH - sy, Math.round(region.sh || fullH)));
            }
            // Output size: downscale the source rect so its longest edge ≤ maxDim.
            let w = sw, h = sh;
            const longest = Math.max(w, h);
            if (Number.isFinite(maxDim) && longest > maxDim) {
              const scale = maxDim / longest;
              w = Math.max(1, Math.round(w * scale));
              h = Math.max(1, Math.round(h * scale));
            }
            const canvas = document.createElement("canvas");
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext("2d");
            if (!ctx) { resolve(null); return; }
            // High-quality resampling helps keep small labels legible.
            try { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; } catch (_) {}
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
            let url = null;
            try { url = canvas.toDataURL(mime, quality); }
            catch (taintErr) {
              console.warn(LOG_PREFIX, "MapVision: canvas tainted (CORS) — cannot export:", taintErr?.message || taintErr);
              url = null;
            }
            resolve((typeof url === "string" && url.startsWith("data:")) ? url : null);
          } catch (_) { resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = this._toAbsoluteUrl(src);
      } catch (_) { resolve(null); }
    });
  },

  /**
   * (v0.10.24) Probe the natural pixel dimensions of an image source without
   * exporting it. Used to choose the grid size for sectioned analysis.
   * Resolves to null on any failure (missing DOM, load error).
   * @returns {Promise<{width:number,height:number}|null>}
   */
  _imageDimensions(src) {
    return new Promise((resolve) => {
      try {
        if (typeof Image === "undefined") { resolve(null); return; }
        const img = new Image();
        if (/^https?:/i.test(src)) img.crossOrigin = "anonymous";
        img.onload = () => {
          const width = img.naturalWidth || img.width;
          const height = img.naturalHeight || img.height;
          resolve((width && height) ? { width, height } : null);
        };
        img.onerror = () => resolve(null);
        img.src = this._toAbsoluteUrl(src);
      } catch (_) { resolve(null); }
    });
  },

  /**
   * Capture the scene's base map as an image reference suitable for the
   * OpenAI-compatible `image_url` content part. Prefers a downscaled data URL
   * (token-efficient, CORS-safe); falls back to an absolute remote URL when
   * canvas export is unavailable. Returns null when there is no map.
   *
   * (v0.10.24) Resolution and format now follow the "Max Map Resolution" and
   * "Image Format" settings (default 4096 px / lossless PNG for crisp text).
   * An optional crop `region` ({sx,sy,sw,sh}) captures a single grid section.
   *
   * @returns {Promise<string|null>}
   */
  async _captureSceneImage(scene, opts = {}) {
    const maxDim = opts.maxDim ?? this._maxResolution();
    const enc = this._imageEncoding();
    const mime = opts.mime ?? enc.mime;
    const quality = opts.quality ?? enc.quality;
    const region = opts.region ?? null;
    try {
      const src = this._sceneBackgroundSrc(scene);
      if (!src) return null;
      const dataUrl = await this._downscaleToDataUrl(src, { maxDim, mime, quality, region });
      if (dataUrl) return dataUrl;
      // Fallback: a publicly-reachable URL can be sent to the model directly.
      // (Remote-URL fallback can only deliver the whole map, never a crop.)
      if (region) return null;
      const abs = this._toAbsoluteUrl(src);
      return /^https?:/i.test(abs) ? abs : null;
    } catch (e) {
      console.warn(LOG_PREFIX, "MapVision._captureSceneImage failed:", e?.message || e);
      return null;
    }
  },

  /**
   * (v0.10.24) Decide the grid layout for a sectioned analysis pass from the
   * map's pixel dimensions. Small maps need no sectioning; large/very large
   * maps get a 2×2 or 3×3 grid so each section is sent at higher effective
   * resolution (better small-text and icon recall).
   *
   * @param {number} width
   * @param {number} height
   * @param {"fast"|"balanced"|"thorough"} quality
   * @returns {{cols:number, rows:number}} 1×1 means "no sectioning needed"
   */
  _planGrid(width, height, quality) {
    const longest = Math.max(Number(width) || 0, Number(height) || 0);
    if (quality === "fast") return { cols: 1, rows: 1 };
    if (!longest) return { cols: 1, rows: 1 };
    if (quality === "thorough") {
      if (longest >= 4096) return { cols: 3, rows: 3 };
      if (longest >= 1600) return { cols: 2, rows: 2 };
      return { cols: 1, rows: 1 };
    }
    // "balanced": only section genuinely large maps, and never beyond 2×2.
    if (longest >= 2600) return { cols: 2, rows: 2 };
    return { cols: 1, rows: 1 };
  },

  /**
   * (v0.10.24) Compute the source-pixel crop rectangles for a cols×rows grid,
   * each padded by ~8% overlap so features straddling a seam are seen whole by
   * at least one section. Returns a flat list with a human label per cell.
   *
   * @returns {Array<{sx:number,sy:number,sw:number,sh:number,label:string,col:number,row:number}>}
   */
  _gridRegions(width, height, cols, rows) {
    const out = [];
    const w = Number(width) || 0, h = Number(height) || 0;
    if (!w || !h || cols < 1 || rows < 1) return out;
    const cellW = w / cols, cellH = h / rows;
    const padX = cellW * 0.08, padY = cellH * 0.08;
    const colNames = cols === 1 ? ["centre"] : (cols === 2 ? ["west", "east"] : ["west", "centre", "east"]);
    const rowNames = rows === 1 ? ["centre"] : (rows === 2 ? ["north", "south"] : ["north", "centre", "south"]);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const sx = Math.max(0, Math.round(c * cellW - padX));
        const sy = Math.max(0, Math.round(r * cellH - padY));
        const ex = Math.min(w, Math.round((c + 1) * cellW + padX));
        const ey = Math.min(h, Math.round((r + 1) * cellH + padY));
        const rowLabel = rowNames[r] || `row ${r + 1}`;
        const colLabel = colNames[c] || `col ${c + 1}`;
        const label = (rowLabel === "centre" && colLabel === "centre")
          ? "centre"
          : `${rowLabel}${rowLabel && colLabel ? "-" : ""}${colLabel}`.replace(/^centre-|-centre$/g, "");
        out.push({ sx, sy, sw: ex - sx, sh: ey - sy, label, col: c, row: r });
      }
    }
    return out;
  },

  /** Build the multimodal (text + image) message array for the vision call. */
  _buildVisionMessages(imageUrl, sceneName, sectionLabel) {
    const intro = sceneName ? `\n\nThis map is for the scene titled "${sceneName}".` : "";
    // (v0.10.24) When analysing one section of a larger map, tell the model
    // exactly which region of the whole map this crop represents so its
    // location fields stay meaningful after the sections are recombined.
    const section = sectionLabel
      ? `\n\nIMPORTANT: This image is only the ${sectionLabel} SECTION of a larger map, shown zoomed-in for detail. Report every feature, label and path visible in THIS section. Use "${sectionLabel}" as the location context for what you find.`
      : "";
    return [
      { role: "system", content: "You are a precise visual cartographer with excellent eyesight for small text and faint detail. When asked for JSON you output only valid JSON." },
      {
        role: "user",
        content: [
          { type: "text", text: `${this.VISION_PROMPT}${intro}${section}` },
          { type: "image_url", image_url: { url: imageUrl } }
        ]
      }
    ];
  },

  /**
   * (v0.11.2) Best-effort field recovery from malformed or TRUNCATED JSON.
   * The vision model occasionally returns JSON that the token limit cut off
   * mid-array, so JSON.parse and the balanced-brace fallback both fail. Rather
   * than dumping the raw braces into the Scouting card, pull out the readable
   * string fields (summary, terrain, labels) with tolerant regexes. The labels
   * regex deliberately accepts an UNTERMINATED array so a cut-off list still
   * yields whatever labels were captured. Never throws.
   *
   * @returns {{summary:string, terrain:string, labels:string[]}}
   */
  _salvageFields(raw) {
    const result = { summary: "", terrain: "", labels: [] };
    const text = String(raw ?? "");
    const unescape = (s) => {
      try { return JSON.parse(`"${s}"`); }
      catch (_) {
        return String(s)
          .replace(/\\"/g, '"')
          .replace(/\\n/g, " ")
          .replace(/\\t/g, " ")
          .replace(/\\\\/g, "\\")
          .trim();
      }
    };
    const strField = (key) => {
      const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "i"));
      return m ? unescape(m[1]).trim() : "";
    };
    result.summary = strField("summary");
    result.terrain = strField("terrain");
    // Tolerate an unterminated array (truncated output): match up to "]" OR EOL.
    const lm = text.match(/"labels"\s*:\s*\[([\s\S]*?)(?:\]|$)/i);
    if (lm) {
      const seen = new Set();
      const re = /"((?:[^"\\]|\\.)*)"/g;
      let mm;
      while ((mm = re.exec(lm[1])) !== null) {
        const s = unescape(mm[1]).trim();
        if (!s) continue;
        const k = s.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        result.labels.push(s.slice(0, 80));
        if (result.labels.length >= 40) break;
      }
    }
    return result;
  },

  /**
   * Parse the model's reply into `{ summary, terrain, labels[], pois[] }`.
   * Tolerant of markdown code fences and surrounding prose; never throws.
   * Falls back to salvaging individual fields (or, for non-JSON prose, the raw
   * text as the summary) when no complete JSON can be recovered.
   *
   * (v0.10.24) Also captures the transcribed `labels` array and a per-POI
   * `confidence` level, and accepts options:
   *   • sectionLabel {string} default location when the model omits one (grid)
   *   • cap          {number} max POIs to keep (default 12; grid passes raise it)
   */
  _parseAnalysis(text, opts = {}) {
    const cap = (typeof opts.cap === "number" && opts.cap > 0) ? opts.cap : 12;
    const sectionLabel = typeof opts.sectionLabel === "string" ? opts.sectionLabel : "";
    const out = { summary: "", terrain: "", labels: [], pois: [] };
    if (typeof text !== "string" || !text.trim()) return out;
    let raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    let obj = null;
    try { obj = JSON.parse(raw); }
    catch (_) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) { try { obj = JSON.parse(m[0]); } catch (_) { obj = null; } }
    }
    if (!obj || typeof obj !== "object") {
      // (v0.11.2) The model returned malformed or TRUNCATED JSON — e.g. the
      // token limit cut it off mid-array, so both JSON.parse and the
      // balanced-brace fallback fail. Rather than dumping the raw braces into
      // the Scouting card (which surfaced as a wall of raw JSON in chat),
      // salvage the individual string fields so the card still renders cleanly.
      const looksLikeJson = /"\s*(summary|terrain|labels|pois)\s*"\s*:/i.test(raw);
      if (looksLikeJson) {
        const recovered = this._salvageFields(raw);
        out.summary = recovered.summary;
        out.terrain = recovered.terrain;
        out.labels = recovered.labels.slice(0, 40);
        return out;
      }
      // Genuinely free-form prose (no JSON shape) — safe to show as the summary.
      out.summary = raw.slice(0, 600);
      return out;
    }
    out.summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
    out.terrain = typeof obj.terrain === "string" ? obj.terrain.trim() : "";
    // Transcribed text labels (deduped, trimmed, bounded).
    const rawLabels = Array.isArray(obj.labels) ? obj.labels : [];
    const seenLabels = new Set();
    for (const l of rawLabels) {
      const s = String(l ?? "").trim();
      if (!s) continue;
      const k = s.toLowerCase();
      if (seenLabels.has(k)) continue;
      seenLabels.add(k);
      out.labels.push(s.slice(0, 80));
      if (out.labels.length >= 40) break;
    }
    const rawPois = Array.isArray(obj.pois) ? obj.pois
                  : (Array.isArray(obj.POIs) ? obj.POIs
                  : (Array.isArray(obj.points_of_interest) ? obj.points_of_interest : []));
    const seen = new Set();
    const normConf = (c) => {
      const v = String(c ?? "").trim().toLowerCase();
      return (v === "high" || v === "medium" || v === "low") ? v : "";
    };
    for (const p of rawPois) {
      if (!p || typeof p !== "object") continue;
      const name = String(p.name ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.pois.push({
        name: name.slice(0, 80),
        type: (String(p.type ?? "other").trim().toLowerCase().slice(0, 30)) || "other",
        description: String(p.description ?? "").trim().slice(0, 400),
        location: (String(p.location ?? "").trim() || sectionLabel).slice(0, 80),
        confidence: normConf(p.confidence)
      });
      if (out.pois.length >= cap) break;
    }
    return out;
  },

  /**
   * (v0.10.24) Merge several per-section analyses into one combined result,
   * de-duplicating POIs and labels by case-insensitive name. When the same POI
   * appears in more than one section we keep the richer record (longest
   * description, highest confidence). Section findings supplement the overview
   * pass rather than replacing it.
   *
   * @param {object} overview  - the full-map overview analysis (may be empty)
   * @param {object[]} sections - per-section parsed analyses
   * @returns {{summary:string, terrain:string, labels:string[], pois:object[]}}
   */
  _mergeAnalyses(overview, sections) {
    const base = overview && typeof overview === "object" ? overview : {};
    const out = {
      summary: typeof base.summary === "string" ? base.summary : "",
      terrain: typeof base.terrain === "string" ? base.terrain : "",
      labels: Array.isArray(base.labels) ? base.labels.slice() : [],
      pois: []
    };
    const confRank = { high: 3, medium: 2, low: 1, "": 0 };
    const poiByKey = new Map();
    const labelSet = new Set(out.labels.map(l => l.toLowerCase()));
    const addPoi = (p) => {
      if (!p || typeof p !== "object") return;
      const name = String(p.name ?? "").trim();
      if (!name) return;
      const key = name.toLowerCase();
      const existing = poiByKey.get(key);
      if (!existing) { poiByKey.set(key, { ...p, name: name.slice(0, 80) }); return; }
      // Merge: keep the longer description and the higher confidence.
      if ((p.description || "").length > (existing.description || "").length) existing.description = p.description;
      if ((confRank[p.confidence] || 0) > (confRank[existing.confidence] || 0)) existing.confidence = p.confidence;
      if (!existing.location && p.location) existing.location = p.location;
    };
    const addLabels = (labels) => {
      if (!Array.isArray(labels)) return;
      for (const l of labels) {
        const s = String(l ?? "").trim();
        if (!s) continue;
        const k = s.toLowerCase();
        if (labelSet.has(k)) continue;
        labelSet.add(k);
        out.labels.push(s.slice(0, 80));
      }
    };
    for (const p of (Array.isArray(base.pois) ? base.pois : [])) addPoi(p);
    for (const sec of (Array.isArray(sections) ? sections : [])) {
      if (!sec || typeof sec !== "object") continue;
      addLabels(sec.labels);
      for (const p of (Array.isArray(sec.pois) ? sec.pois : [])) addPoi(p);
      // If the overview produced no prose, borrow the first section's.
      if (!out.summary && sec.summary) out.summary = sec.summary;
      if (!out.terrain && sec.terrain) out.terrain = sec.terrain;
    }
    out.pois = Array.from(poiByKey.values()).slice(0, 30);
    out.labels = out.labels.slice(0, 60);
    return out;
  },

  /**
   * Scribe discovered POIs into the Living Chronicle as Location entries,
   * reusing the existing journaling pipeline (dedupe, toasts, RAG indexing).
   * Fully guarded by the journal system's own enabled/permission checks.
   */
  _journalPois(pois, scene) {
    try {
      if (!Array.isArray(pois) || !pois.length) return 0;
      if (!JournalSystem.enabled?.() || !JournalSystem.canWrite?.()) return 0;
      const sceneName = String(scene?.navName || scene?.name || "").trim();
      const entities = pois.map(p => {
        const ent = {
          type: "location",
          name: p.name,
          description: p.description || `A ${p.type || "point of interest"} observed on the map.`
        };
        if (sceneName) ent.region = sceneName;
        const feats = [];
        if (p.type) feats.push(`Type: ${p.type}.`);
        if (p.location) feats.push(`Located at the ${p.location} of the map.`);
        if (p.confidence === "low") feats.push("Observed with low confidence.");
        if (feats.length) ent.features = feats.join(" ");
        return ent;
      });
      JournalSystem.ingestMetadata({ entities }, { channel: "map-scout" });
      return entities.length;
    } catch (e) {
      console.warn(LOG_PREFIX, "MapVision._journalPois failed:", e?.message || e);
      return 0;
    }
  },

  /** Post the public "Scouting" card and a GM-only chronicle footnote. */
  async _postScoutCard(analysis, journaledCount = 0) {
    try {
      const pois = Array.isArray(analysis.pois) ? analysis.pois : [];
      const parts = [];
      if (analysis.summary) parts.push(`<p>${escapeHtml(analysis.summary)}</p>`);
      if (analysis.terrain) parts.push(`<p><strong>Terrain:</strong> ${escapeHtml(analysis.terrain)}</p>`);
      if (pois.length) {
        const items = pois.map(p => {
          const loc = p.location ? ` <span class="es-poi-loc">(${escapeHtml(p.location)})</span>` : "";
          const typ = p.type ? `<em>${escapeHtml(p.type)}</em> — ` : "";
          // (v0.10.24) Flag low-confidence sightings so the GM can verify them.
          const conf = p.confidence === "low" ? ` <span class="es-poi-conf">[uncertain]</span>` : "";
          return `<li><strong>${escapeHtml(p.name)}</strong>${loc}${conf}<br/>${typ}${escapeHtml(p.description || "")}</li>`;
        }).join("");
        parts.push(`<p><strong>Points of Interest:</strong></p><ul class="es-poi-list">${items}</ul>`);
      }
      // (v0.10.24) Surface any transcribed map text labels the model read.
      const labels = Array.isArray(analysis.labels) ? analysis.labels : [];
      if (labels.length) {
        const tags = labels.slice(0, 24).map(l => `<span class="es-map-label">${escapeHtml(l)}</span>`).join(" ");
        parts.push(`<p><strong>Map labels read:</strong> ${tags}</p>`);
      }
      if (!parts.length) parts.push(`<p><em>The map yields no clear landmarks to my eye.</em></p>`);
      const title = analysis.scene ? `Scouting: ${analysis.scene}` : "Scouting the Map";
      await Chat.postSkald(parts.join(""), { variant: "scene", title });
      if (journaledCount > 0) {
        const sectionNote = (analysis.sections && analysis.sections > 1)
          ? ` (read across ${analysis.sections} map sections)` : "";
        await Chat.postSystem(
          `<em>${journaledCount} location${journaledCount === 1 ? "" : "s"} scribed to the chronicle from the map` +
          `${analysis.scene ? ` of <strong>${escapeHtml(analysis.scene)}</strong>` : ""}${sectionNote}. ` +
          `Scouted with <code>${escapeHtml(analysis.model)}</code>.</em>`,
          { gmWhisper: true }
        );
      }
    } catch (e) {
      console.warn(LOG_PREFIX, "MapVision._postScoutCard failed:", e?.message || e);
    }
  },

  /**
   * (v0.10.24) Run a single vision pass on a captured image and return the
   * parsed analysis (or null on capture/call failure). A `region` crops the
   * source map to one grid section; `sectionLabel` is woven into the prompt and
   * used as the default POI location.
   *
   * @returns {Promise<object|null>}
   */
  async _runVisionPass(scene, sceneName, model, { region = null, sectionLabel = "", cap = 12 } = {}) {
    const imageUrl = await this._captureSceneImage(scene, region ? { region } : {});
    if (!imageUrl) return null;
    const messages = this._buildVisionMessages(imageUrl, sceneName, sectionLabel);
    let reply = "";
    try {
      reply = await Client.chat(messages, { model, temperature: 0.3, maxTokens: 1100 });
    } catch (e) {
      console.warn(LOG_PREFIX, "MapVision: vision pass failed:", e?.message || e);
      throw e;
    }
    return this._parseAnalysis(reply, { sectionLabel, cap });
  },

  /**
   * (v0.10.24) Grid-sectioned analysis. Probes the map's dimensions, plans a
   * grid (1×1 / 2×2 / 3×3) from resolution and the quality setting, then:
   *   1. runs a full-map overview pass (cheap context + catches global features)
   *   2. runs one detailed pass per section, cropped and zoomed for small text
   *   3. merges everything into a single de-duplicated analysis.
   *
   * Returns `{ analysis, sectionCount }`. Falls back to a single full-map pass
   * when sectioning isn't warranted or dimensions can't be probed.
   *
   * @returns {Promise<{analysis:object, sectionCount:number}|null>}
   */
  async _analyzeMapInSections(scene, sceneName, model, quality) {
    const src = this._sceneBackgroundSrc(scene);
    if (!src) return null;

    // 1) Always run a full-map overview pass first.
    let overview = null;
    try { overview = await this._runVisionPass(scene, sceneName, model, { cap: 16 }); }
    catch (e) { throw e; }
    if (!overview) return null;

    // Decide whether to section, based on real pixel dimensions.
    const dims = await this._imageDimensions(src);
    const grid = dims ? this._planGrid(dims.width, dims.height, quality) : { cols: 1, rows: 1 };
    const cells = (grid.cols > 1 || grid.rows > 1)
      ? this._gridRegions(dims.width, dims.height, grid.cols, grid.rows)
      : [];

    if (!cells.length) {
      return { analysis: this._mergeAnalyses(overview, []), sectionCount: 1 };
    }

    // 2) Detailed per-section passes. A failed section is skipped, not fatal.
    const sectionResults = [];
    for (const cell of cells) {
      try {
        const res = await this._runVisionPass(scene, sceneName, model, {
          region: { sx: cell.sx, sy: cell.sy, sw: cell.sw, sh: cell.sh },
          sectionLabel: cell.label,
          cap: 12
        });
        if (res) sectionResults.push(res);
      } catch (e) {
        console.warn(LOG_PREFIX, `MapVision: section "${cell.label}" failed:`, e?.message || e);
      }
    }

    // 3) Combine overview + sections.
    const merged = this._mergeAnalyses(overview, sectionResults);
    return { analysis: merged, sectionCount: 1 + sectionResults.length };
  },

  /**
   * Scout a scene's map: capture → vision call(s) → parse → cache → journal →
   * post. Returns the stored analysis object, or null on any graceful exit.
   *
   * (v0.10.24) Honours the "Map Analysis Quality" setting: "fast" runs a single
   * full-map pass, while "balanced"/"thorough" add grid-sectioned detail passes
   * for far better small-text and POI recall. Warns the GM when the chosen
   * vision model is a lightweight ("mini"/"lite") tier that tends to miss
   * fine map detail.
   *
   * @param {Scene} [scene] - target scene (defaults to active/canvas scene)
   * @param {object} [opts]
   * @param {boolean} [opts.force]  - re-analyse even if a cached result exists
   * @param {boolean} [opts.silent] - suppress the "surveys…" start notice (auto mode)
   */
  async analyzeScene(scene, opts = {}) {
    const force = !!opts.force;
    try {
      const sc = this._resolveScene(scene);
      if (!sc) {
        if (force) await Chat.postSystem(`<em>${SKALD_NAME} finds no active scene to scout.</em>`, { gmWhisper: true });
        return null;
      }
      if (!this._canWrite()) return null;

      // Skip already-scouted scenes unless explicitly forced.
      const cached = this.getCached(sc);
      if (cached && !force) {
        console.log(LOG_PREFIX, "MapVision: scene already scouted — skipping (use !scout to force).");
        return cached;
      }

      const src = this._sceneBackgroundSrc(sc);
      if (!src) {
        if (force) await Chat.postSystem(`<em>${SKALD_NAME} peers about, but this scene has no map to scout.</em>`, { gmWhisper: true });
        return null;
      }

      const model = this._visionModel();
      if (!Client._modelSupportsVision(model)) {
        await Chat.postSystem(
          `<em>${SKALD_NAME} cannot scout the map: <code>${escapeHtml(model)}</code> has no eyes for images. ` +
          `Choose a vision-capable model under <em>Settings → Vision Model</em>.</em>`,
          { gmWhisper: true }
        );
        return null;
      }

      // (v0.10.24) Advise — but never block — when the model is a weak tier.
      if (force && Client._visionModelTier?.(model) === "weak") {
        await Chat.postSystem(
          `<em>Heed this, GM: <code>${escapeHtml(model)}</code> is a lightweight vision model and often misses small ` +
          `labels and faint paths on detailed maps. For sharper scouting choose a flagship model such as ` +
          `<code>gpt-4o</code>, <code>claude-3-5-sonnet</code> or <code>gemini-2.0-flash</code> under ` +
          `<em>Settings → Vision Model</em>.</em>`,
          { gmWhisper: true }
        );
      }

      const quality = this._analysisQuality();
      const sceneName = String(sc.navName || sc.name || "").trim();
      if (!opts.silent) {
        await Chat.postSystem(
          `<em>${SKALD_NAME} surveys ${sceneName ? `<strong>${escapeHtml(sceneName)}</strong>` : "the map"}…</em>`,
          { gmWhisper: true }
        );
      }

      // Run the analysis. "fast" → one full-map pass; otherwise grid sectioning.
      let parsed = null;
      let sectionCount = 1;
      try {
        if (quality === "fast") {
          parsed = await this._runVisionPass(sc, sceneName, model, { cap: 16 });
        } else {
          const result = await this._analyzeMapInSections(sc, sceneName, model, quality);
          if (result) { parsed = result.analysis; sectionCount = result.sectionCount; }
        }
      } catch (e) {
        await Chat.postSystem(`<em>${SKALD_NAME}'s scrying of the map failed: ${escapeHtml(e?.message || String(e))}</em>`, { gmWhisper: true });
        return null;
      }

      if (!parsed) {
        await Chat.postSystem(`<em>${SKALD_NAME} could not capture the map image to scout it.</em>`, { gmWhisper: true });
        return null;
      }

      const analysis = {
        timestamp: Date.now(),
        model,
        scene: sceneName,
        quality,
        sections: sectionCount,
        summary: parsed.summary,
        terrain: parsed.terrain,
        labels: Array.isArray(parsed.labels) ? parsed.labels : [],
        pois: parsed.pois
      };

      await this._storeAnalysis(sc, analysis);
      const journaled = this._journalPois(parsed.pois, sc);
      await this._postScoutCard(analysis, journaled);
      return analysis;
    } catch (e) {
      console.error(LOG_PREFIX, "MapVision.analyzeScene failed:", e);
      return null;
    }
  }
};
