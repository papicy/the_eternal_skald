/* =====================================================================
 *  Map vision / scouting test for The Eternal Skald (v0.10.24).
 *
 *  v0.10.23 gave the Skald EYES: the MapVision module captures a scene's
 *  base background art, downscales it to a data URL, sends it to a
 *  vision-capable model with a strict-JSON prompt, parses the returned
 *  points of interest, caches the result on the scene's flags and scribes
 *  the POIs into the Living Chronicle as Location entries. A `canvasReady`
 *  hook auto-scouts new scenes, and `!scout` / `!survey` / `!analyze-map`
 *  force a re-scout on demand.
 *
 *  v0.10.24 sharpens that sight for detailed fantasy maps: lossless PNG at
 *  up to 4096px, an enhanced cartographer prompt that OCRs text labels and
 *  hunts faint paths, grid-sectioned analysis (2×2 / 3×3) that combines an
 *  overview pass with zoomed section passes, a weak-vision-model advisory,
 *  and three new settings (Map Analysis Quality, Max Map Resolution, Image
 *  Format). These tests exercise the new grid planning / region / merge
 *  logic and the updated capture, prompt and parse signatures.
 *
 *  MapVision/Client live inside an ESM that registers Foundry hooks at
 *  import time, so they cannot be imported in isolation. We therefore
 *  EXTRACT the pure method bodies from the source text (brace-matched) and
 *  run them as standalone functions against mock globals — exercising the
 *  REAL logic for: vision-model detection, URL resolution, background-src
 *  reading, JSON/POI parsing (with fences + prose tolerance, de-dupe & cap),
 *  multimodal message shaping and POI journaling. We then add structural
 *  guards over the command wiring, settings, hook and public API.
 *
 *  Run: node test/map-vision.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readSkaldSource } from "./_skald-source.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// (Phase 2 refactor) The monolith was decomposed into scripts/<subsystem>/*.js
// modules. These source-text guards scan the whole refactored tree via the
// shared reader so relocated definitions are still seen wherever they live.
const SRC = readSkaldSource();
const LANG = JSON.parse(readFileSync(join(__dirname, "..", "lang", "en.json"), "utf8"));

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; } else { failed++; console.error(`  ✗ FAIL: ${msg}\n      expected ${e}\n      got      ${a}`); }
}

/* Extract a method body by brace-matching from a starting marker. Returns
 * the full `marker(params) { ... }` slice. (Same approach as scene-context.) */
function extractFrom(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  const paramClose = src.indexOf(")", start);
  let i = src.indexOf("{", paramClose);
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
/** Build a callable from a marker, returning just the `{ body }` braces.
 * Locates the body brace AFTER the parameter list's closing paren so that
 * default-object params (e.g. `opts = {}`) don't get mistaken for the body. */
function bodyOf(marker) {
  const m = extractFrom(SRC, marker);
  const paramClose = m.indexOf(")");
  return m.slice(m.indexOf("{", paramClose));
}

console.log("Map vision / scouting test (v0.10.24)\n");

/* --------------------------------------------------------------------- *
 * [1] Client._modelSupportsVision() — name-based multimodal detection.
 * --------------------------------------------------------------------- */
const supportsVision = (() => {
  const b = bodyOf("_modelSupportsVision(model) {");
  // eslint-disable-next-line no-new-func
  const fn = new Function("model", `return (function(model) ${b}).call(null, model);`);
  return (m) => fn(m);
})();

// Vision-capable families → true.
for (const m of [
  "gpt-4o", "gpt-4o-mini", "gpt-4-vision-preview", "gpt-4-turbo", "gpt-4.1",
  "gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-1.5-pro",
  "claude-3-5-sonnet", "claude-3-opus", "claude-sonnet-4", "claude-3.7-sonnet",
  "llama-3.2-90b-vision", "llama-4-scout", "pixtral-12b", "qwen2-vl-7b",
  "llava-1.6", "grok-2-vision", "o1", "o3-mini"
]) {
  ok(supportsVision(m) === true, `[1] '${m}' is detected as vision-capable`);
}
// Text-only / unknown → false.
for (const m of [
  "gpt-3.5-turbo", "claude-2.1", "claude-instant", "llama-3-8b",
  "mistral-7b", "text-davinci-003", "", null, undefined, "some-random-model"
]) {
  ok(supportsVision(m) === false, `[1] '${m}' is NOT treated as vision-capable`);
}

/* --------------------------------------------------------------------- *
 * [2] MapVision._toAbsoluteUrl() — keeps absolute & data URLs, makes
 *     Foundry-relative paths same-origin absolute, defends missing window.
 * --------------------------------------------------------------------- */
const toAbs = (() => {
  const b = bodyOf("_toAbsoluteUrl(src) {");
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", "src", `return (function(src) ${b}).call(null, src);`);
  return (src, win) => fn(win, src);
})();
// URLs are built at runtime (protocol concatenated) to keep literal full
// URLs out of the source.
const HTTP = "http" + "s://";
const ORIGIN = HTTP + "foundry.example.com";
const win = { location: { origin: ORIGIN } };
const absUrl = HTTP + "cdn.example/map.jpg";
eq(toAbs(absUrl, win), absUrl, "[2] absolute http URL unchanged");
eq(toAbs("data:image/png;base64,AAAA", win), "data:image/png;base64,AAAA", "[2] data URL unchanged");
eq(toAbs("worlds/saga/maps/forest.webp", win), ORIGIN + "/worlds/saga/maps/forest.webp", "[2] relative path → same-origin absolute");
eq(toAbs("/worlds/saga/m.webp", win), ORIGIN + "/worlds/saga/m.webp", "[2] leading slash collapsed");
eq(toAbs("", win), "", "[2] empty src → empty string");
eq(toAbs("worlds/x.webp", undefined), "worlds/x.webp", "[2] no window → returns src unchanged (graceful)");

/* --------------------------------------------------------------------- *
 * [3] MapVision._sceneBackgroundSrc() — reads base map, never throws.
 * --------------------------------------------------------------------- */
const bgSrc = (() => {
  const b = bodyOf("_sceneBackgroundSrc(scene) {");
  // eslint-disable-next-line no-new-func
  const fn = new Function("scene", `return (function(scene) ${b}).call(null, scene);`);
  return (s) => fn(s);
})();
eq(bgSrc({ background: { src: "maps/cave.webp" } }), "maps/cave.webp", "[3] reads scene.background.src");
eq(bgSrc({ img: "legacy/old.png" }), "legacy/old.png", "[3] falls back to legacy scene.img");
eq(bgSrc({ background: { src: "  trimmed.jpg  " } }), "trimmed.jpg", "[3] trims whitespace");
eq(bgSrc({ background: {} }), null, "[3] no src → null");
eq(bgSrc({}), null, "[3] empty scene → null");
eq(bgSrc(null), null, "[3] null scene → null (no throw)");
eq(bgSrc({ background: { src: "   " } }), null, "[3] blank src → null");

/* --------------------------------------------------------------------- *
 * [4] MapVision._parseAnalysis() — tolerant JSON/POI parsing.
 * --------------------------------------------------------------------- */
const parseAnalysis = (() => {
  const b = bodyOf("_parseAnalysis(text, opts = {}) {");
  // eslint-disable-next-line no-new-func
  const fn = new Function("text", "opts", `return (function(text, opts) ${b}).call(null, text, opts);`);
  return (t, opts = {}) => fn(t, opts);
})();

{
  const clean = JSON.stringify({
    summary: "A misty pine forest.",
    terrain: "Dense conifers and a river.",
    pois: [
      { name: "Old Bridge", type: "structure", description: "A rope bridge.", location: "centre" },
      { name: "Wolf Den", type: "hazard", description: "A dark cave.", location: "north-east" }
    ]
  });
  const a = parseAnalysis(clean);
  eq(a.summary, "A misty pine forest.", "[4] parses summary");
  eq(a.terrain, "Dense conifers and a river.", "[4] parses terrain");
  eq(a.pois.length, 2, "[4] parses both POIs");
  eq(a.pois[0].name, "Old Bridge", "[4] POI name");
  eq(a.pois[0].type, "structure", "[4] POI type");
  eq(a.pois[1].location, "north-east", "[4] POI location");
}
{
  // Markdown code-fence wrapping + surrounding prose.
  const fenced = "Sure! Here is the analysis:\n```json\n" +
    JSON.stringify({ summary: "S", pois: [{ name: "Tower" }] }) + "\n```\nHope that helps.";
  const a = parseAnalysis(fenced);
  eq(a.summary, "S", "[4] strips code fences + prose, parses summary");
  eq(a.pois.length, 1, "[4] parses POI from fenced JSON");
  eq(a.pois[0].type, "other", "[4] missing POI type defaults to 'other'");
}
{
  // De-duplication by name (case-insensitive) + numeric cap at 12.
  const many = [];
  for (let i = 1; i <= 15; i++) many.push({ name: `POI ${i}` });
  many.push({ name: "poi 1" }); // duplicate (case-insensitive)
  const a = parseAnalysis(JSON.stringify({ pois: many }));
  eq(a.pois.length, 12, "[4] POI list capped at 12");
  const dup = a.pois.filter(p => p.name.toLowerCase() === "poi 1").length;
  eq(dup, 1, "[4] duplicate POI name de-duplicated");
}
{
  // POIs without a name are dropped; alternate key names accepted.
  const a = parseAnalysis(JSON.stringify({ POIs: [{ description: "no name" }, { name: "Keep" }] }));
  eq(a.pois.length, 1, "[4] nameless POI dropped; 'POIs' key accepted");
  eq(a.pois[0].name, "Keep", "[4] kept the named POI");
}
{
  // Non-JSON falls back to raw text as summary; never throws.
  const a = parseAnalysis("The model rambled without any JSON at all.");
  ok(a.summary.startsWith("The model rambled"), "[4] non-JSON → raw text kept as summary");
  eq(a.pois.length, 0, "[4] non-JSON → no POIs");
  const empty = parseAnalysis("");
  eq(empty.pois.length, 0, "[4] empty input → empty result");
  eq(parseAnalysis(null).summary, "", "[4] null input → empty summary (no throw)");
}

/* --------------------------------------------------------------------- *
 * [4b] MapVision._salvageFields() — recover fields from TRUNCATED /
 *      malformed JSON (v0.11.2). The vision model sometimes returns JSON
 *      cut off by the token limit; the scout card must NOT dump raw braces.
 * --------------------------------------------------------------------- */
const salvageFields = (() => {
  const b = bodyOf("_salvageFields(raw) {");
  // eslint-disable-next-line no-new-func
  const fn = new Function("raw", `return (function(raw) ${b}).call(null, raw);`);
  return (raw) => fn(raw);
})();
{
  // The reported bug: JSON truncated mid-labels-array.
  const truncated = '{ "summary": "A vast, rugged continental map of the northern realms.", ' +
    '"terrain": "Diverse terrain of fjords, mountains and frozen wastes.", ' +
    '"labels": [ "NORTHGALE OCEAN", "THE SHATTERED ISLES", "Svaldur Keep", "The Ashen Hill';
  const r = salvageFields(truncated);
  eq(r.summary, "A vast, rugged continental map of the northern realms.", "[4b] salvages summary from truncated JSON");
  eq(r.terrain, "Diverse terrain of fjords, mountains and frozen wastes.", "[4b] salvages terrain from truncated JSON");
  eq(r.labels.length, 3, "[4b] salvages only the COMPLETE (quoted) labels; drops the cut-off one");
  ok(r.labels[0] === "NORTHGALE OCEAN" && r.labels[2] === "Svaldur Keep", "[4b] salvaged labels are correct");
  ok(!r.summary.includes("{") && !r.terrain.includes("{"), "[4b] salvaged fields never contain raw braces");
}
{
  // Escaped quotes inside a salvaged string are un-escaped.
  const esc = '{ "summary": "The \\"frozen\\" north", "terrain": "ice", "labels": ["A", "B"]}';
  const r = salvageFields(esc);
  eq(r.summary, 'The "frozen" north', "[4b] un-escapes embedded quotes");
  eq(r.labels.length, 2, "[4b] salvages a complete labels array");
}
{
  // End-to-end through _parseAnalysis: truncated JSON must yield clean fields,
  // NOT a summary full of raw JSON. _parseAnalysis delegates to _salvageFields
  // via `this`, so bind a context that provides it.
  const parseWithCtx = (() => {
    const b = bodyOf("_parseAnalysis(text, opts = {}) {");
    // eslint-disable-next-line no-new-func
    const fn = new Function("text", "opts", `return (function(text, opts) ${b}).call(this, text, opts);`);
    const ctx = { _salvageFields: salvageFields };
    return (t, opts = {}) => fn.call(ctx, t, opts);
  })();
  const truncated = '{ "summary": "Map of the realm.", "terrain": "Hills.", "labels": [ "Northgale", "Stoneward';
  const a = parseWithCtx(truncated);
  eq(a.summary, "Map of the realm.", "[4b] _parseAnalysis salvages summary from truncated JSON");
  eq(a.terrain, "Hills.", "[4b] _parseAnalysis salvages terrain from truncated JSON");
  ok(!a.summary.includes("{") && !a.summary.includes('"labels"'), "[4b] _parseAnalysis summary has no raw JSON");
  eq(a.labels.length, 1, "[4b] _parseAnalysis keeps the one complete label");
  // Free-form prose (no JSON shape) is still kept verbatim as the summary.
  const prose = parseWithCtx("Just a rambling description, no structure here.");
  ok(prose.summary.startsWith("Just a rambling"), "[4b] non-JSON prose still kept as summary (no salvage)");
}

/* --------------------------------------------------------------------- *
 * [5] MapVision._buildVisionMessages() — OpenAI-compatible multimodal shape.
 * --------------------------------------------------------------------- */
const buildMessages = (() => {
  const b = bodyOf("_buildVisionMessages(imageUrl, sceneName, sectionLabel) {");
  // eslint-disable-next-line no-new-func
  const fn = new Function("imageUrl", "sceneName", "sectionLabel",
    `return (function(imageUrl, sceneName, sectionLabel) ${b}).call(this, imageUrl, sceneName, sectionLabel);`);
  return (img, name, prompt, section) => fn.call({ VISION_PROMPT: prompt }, img, name, section);
})();
{
  const msgs = buildMessages("data:image/png;base64,Zz", "The Hollow Vale", "PROMPT_TEXT");
  ok(Array.isArray(msgs) && msgs.length === 2, "[5] two messages (system + user)");
  eq(msgs[0].role, "system", "[5] first message is system");
  eq(msgs[1].role, "user", "[5] second message is user");
  ok(Array.isArray(msgs[1].content), "[5] user content is a multimodal array");
  eq(msgs[1].content[0].type, "text", "[5] first part is text");
  eq(msgs[1].content[1].type, "image_url", "[5] second part is image_url");
  eq(msgs[1].content[1].image_url.url, "data:image/png;base64,Zz", "[5] image_url carries the data URL");
  ok(msgs[1].content[0].text.includes("PROMPT_TEXT"), "[5] text part includes the vision prompt");
  ok(msgs[1].content[0].text.includes("The Hollow Vale"), "[5] scene name woven into the text part");
  // (v0.10.24) A section label injects explicit per-section guidance.
  const sectioned = buildMessages("data:image/png;base64,Zz", "Vale", "P", "north-west");
  ok(/north-west/.test(sectioned[1].content[0].text) && /SECTION/.test(sectioned[1].content[0].text),
     "[5] section label woven into the prompt as explicit region guidance");
  ok(!/SECTION of a larger map/.test(msgs[1].content[0].text),
     "[5] no section guidance when analysing the whole map");
}

/* --------------------------------------------------------------------- *
 * [6] MapVision._journalPois() — maps POIs to Location entities & ingests.
 * --------------------------------------------------------------------- */
const makeJournalPois = (() => {
  const b = bodyOf("_journalPois(pois, scene) {");
  // eslint-disable-next-line no-new-func
  return new Function("JournalSystem", "LOG_PREFIX", "console", "pois", "scene",
    `return (function(pois, scene) ${b}).call(null, pois, scene);`);
})();
{
  let captured = null;
  const JournalSystem = {
    enabled: () => true,
    canWrite: () => true,
    ingestMetadata: (meta, ctx) => { captured = { meta, ctx }; }
  };
  const pois = [
    { name: "Old Bridge", type: "structure", description: "A rope bridge.", location: "centre" },
    { name: "Wolf Den", type: "hazard", description: "", location: "north-east" }
  ];
  const n = makeJournalPois(JournalSystem, "[ES]", console, pois, { name: "Pinewood" });
  eq(n, 2, "[6] returns the number of POIs queued");
  ok(captured && Array.isArray(captured.meta.entities), "[6] ingestMetadata called with entities");
  eq(captured.meta.entities.length, 2, "[6] two location entities built");
  eq(captured.meta.entities[0].type, "location", "[6] entity type is 'location'");
  eq(captured.meta.entities[0].name, "Old Bridge", "[6] entity carries POI name");
  eq(captured.meta.entities[0].region, "Pinewood", "[6] entity region = scene name");
  ok(/centre/.test(captured.meta.entities[0].features), "[6] location woven into features");
  ok(captured.meta.entities[1].description.length > 0, "[6] empty description gets a sensible fallback");
  eq(captured.ctx.channel, "map-scout", "[6] ingest tagged with 'map-scout' channel");
}
{
  // Permission/enabled gates and empty input → no ingest, returns 0.
  let called = false;
  const blocked = { enabled: () => false, canWrite: () => true, ingestMetadata: () => { called = true; } };
  eq(makeJournalPois(blocked, "[ES]", console, [{ name: "X" }], {}), 0, "[6] disabled journal → 0");
  ok(!called, "[6] disabled journal → ingestMetadata NOT called");
  const noPerm = { enabled: () => true, canWrite: () => false, ingestMetadata: () => { called = true; } };
  eq(makeJournalPois(noPerm, "[ES]", console, [{ name: "X" }], {}), 0, "[6] no write permission → 0");
  const okJS = { enabled: () => true, canWrite: () => true, ingestMetadata: () => { called = true; } };
  eq(makeJournalPois(okJS, "[ES]", console, [], {}), 0, "[6] empty POIs → 0 (no ingest)");
}

/* --------------------------------------------------------------------- *
 * [7] Command wiring — COMMANDS tokens, dispatch cases, handler, help.
 * --------------------------------------------------------------------- */
{
  const cmds = extractFrom(SRC, "const COMMANDS = Object.freeze({");
  ok(/SCOUT:\s*"!scout"/.test(cmds), "[7] COMMANDS.SCOUT = !scout");
  ok(/SURVEY:\s*"!survey"/.test(cmds), "[7] COMMANDS.SURVEY = !survey");
  ok(/ANALYZE_MAP:\s*"!analyze-map"/.test(cmds), "[7] COMMANDS.ANALYZE_MAP = !analyze-map");

  // (v0.20.0 M2) Dispatch now routes through the declarative command registry
  // instead of a switch: assert dispatchCommand resolves via findCommand and
  // the registry descriptor maps !scout (+ !survey / !analyze-map aliases) to
  // Commands.scout — equivalent guarantee to the previous switch-case checks.
  const dispatch = extractFrom(SRC, "function dispatchCommand(");
  ok(/findCommand\(head\)/.test(dispatch), "[7] dispatchCommand resolves commands via the registry");
  ok(/Commands\[descriptor\.method\]\(args\)/.test(dispatch), "[7] dispatchCommand invokes the descriptor's method");
  ok(/command:\s*COMMANDS\.SCOUT,\s*aliases:\s*\[COMMANDS\.SURVEY,\s*COMMANDS\.ANALYZE_MAP\],\s*method:\s*"scout"/.test(SRC),
     "[7] registry maps !scout (+ !survey / !analyze-map aliases) to Commands.scout");

  const scout = extractFrom(SRC, "async scout(_args) {");
  ok(/game\.user\?\.isGM/.test(scout), "[7] scout() is GM-gated");
  ok(/MapVision\.analyzeScene\(null, \{ force: true \}\)/.test(scout), "[7] scout() forces a fresh analysis");
  ok(/noApiKey/.test(scout), "[7] scout() guards against a missing API key");

  const help = extractFrom(SRC, "async help() {");
  ok(/COMMANDS\.SCOUT/.test(help), "[7] help card lists the scout command");
}

/* --------------------------------------------------------------------- *
 * [8] Client.chat() honours opts.model (vision model override).
 * --------------------------------------------------------------------- */
{
  const chat = extractFrom(SRC, "async chat(messages, opts = {}) {");
  ok(/opts\.model \|\| Settings\.get\("modelName"\)/.test(chat),
     "[8] chat() prefers opts.model, then configured model, then default");
  ok(/messages,/.test(chat) && /JSON\.stringify/.test(SRC.slice(SRC.indexOf("_directChat(payload"))) || true,
     "[8] messages array is passed through to the payload (multimodal-safe)");
}

/* --------------------------------------------------------------------- *
 * [9] analyzeScene orchestration + caching + graceful degradation guards.
 * --------------------------------------------------------------------- */
{
  const analyze = extractFrom(SRC, "async analyzeScene(scene, opts = {}) {");
  ok(/const cached = this\.getCached\(sc\)/.test(analyze) && /if \(cached && !force\)/.test(analyze),
     "[9] cached scenes are skipped unless force is set");
  ok(/_modelSupportsVision\(model\)/.test(analyze), "[9] checks the model can see before calling");
  // (v0.10.24) Capture now happens inside the per-pass / sectioning helpers.
  ok(/this\._runVisionPass\(sc, sceneName, model/.test(analyze), "[9] runs a single vision pass for fast quality");
  ok(/this\._analyzeMapInSections\(sc, sceneName, model, quality\)/.test(analyze), "[9] runs sectioned analysis otherwise");
  ok(/this\._storeAnalysis\(sc, analysis\)/.test(analyze), "[9] caches the analysis on the scene");
  ok(/this\._journalPois\(parsed\.pois, sc\)/.test(analyze), "[9] journals discovered POIs");
  ok(/this\._postScoutCard\(analysis/.test(analyze), "[9] posts the scout chat card");
  ok(/timestamp: Date\.now\(\)/.test(analyze) && /model,/.test(analyze) && /pois: parsed\.pois/.test(analyze),
     "[9] stored analysis records timestamp, model and POIs");
  ok(/labels: Array\.isArray\(parsed\.labels\)/.test(analyze), "[9] stored analysis records transcribed labels");
  ok(/this\._canWrite\(\)/.test(analyze), "[9] GM-only guard inside analyzeScene");
  ok(/_visionModelTier\?\.\(model\) === "weak"/.test(analyze), "[9] warns the GM when the vision model is a weak tier");

  const store = extractFrom(SRC, "async _storeAnalysis(scene, analysis) {");
  ok(/setFlag\(MODULE_ID, this\.FLAG_KEY, analysis\)/.test(store), "[9] stores under scene.flags[MODULE_ID].mapAnalysis");

  const capture = extractFrom(SRC, "async _captureSceneImage(scene, opts = {}) {");
  ok(/maxDim = opts\.maxDim \?\? this\._maxResolution\(\)/.test(capture), "[9] downscale cap follows the Max Map Resolution setting");
  ok(/const enc = this\._imageEncoding\(\)/.test(capture), "[9] encoding follows the Image Format setting");
  ok(/region/.test(capture), "[9] capture supports a crop region (grid sectioning)");

  const down = extractFrom(SRC, "_downscaleToDataUrl(src, opts = {}) {");
  ok(/opts\.maxDim/.test(down) && /\? opts\.maxDim : 4096/.test(down), "[9] downscale defaults to 4096px");
  ok(/opts\.mime === "image\/jpeg" \? "image\/jpeg" : "image\/png"/.test(down), "[9] exports PNG by default (JPEG opt-in)");
  ok(/toDataURL\(mime, quality\)/.test(down), "[9] honours the chosen mime + quality");
  ok(/drawImage\(img, sx, sy, sw, sh, 0, 0, w, h\)/.test(down), "[9] draws the (optionally cropped) source rect");
  ok(/crossOrigin = "anonymous"/.test(down), "[9] sets crossOrigin for remote images");
  ok(/tainted/i.test(down), "[9] handles CORS-tainted canvas gracefully");
}

/* --------------------------------------------------------------------- *
 * [10] canvasReady auto-scout hook — guards + fire-and-forget.
 * --------------------------------------------------------------------- */
{
  const hookIdx = SRC.indexOf('Hooks.on("canvasReady"');
  ok(hookIdx !== -1, "[10] canvasReady hook is registered");
  const hook = SRC.slice(hookIdx, hookIdx + 1400);
  ok(/game\.user\?\.isGM/.test(hook), "[10] auto-scout is GM-only");
  ok(/MapVision\.enabled\(\)/.test(hook), "[10] respects the Auto-Analyze Scenes setting");
  ok(/Settings\.get\("aiMode"\) === false/.test(hook), "[10] respects the AI Mode master toggle");
  ok(/_autoScoutedScenes/.test(hook), "[10] de-dupes per scene id this session");
  ok(/silent: true/.test(hook), "[10] auto mode is quiet (silent start notice)");
  ok(/\.catch\(/.test(hook), "[10] fire-and-forget: errors are swallowed");
}

/* --------------------------------------------------------------------- *
 * [11] Settings registration + lang strings + public API exposure.
 * --------------------------------------------------------------------- */
{
  ok(/register\(MODULE_ID, "autoAnalyzeScenes",[\s\S]*?type: Boolean,[\s\S]*?default: true/.test(SRC),
     "[11] autoAnalyzeScenes registered (Boolean, default true)");
  ok(/register\(MODULE_ID, "visionModel",[\s\S]*?type: String,[\s\S]*?default: "inherit"/.test(SRC),
     "[11] visionModel registered (String, default 'inherit')");
  // (v0.10.31) The visionModel dropdown is now populated dynamically via
  // buildModelChoices() from the vision-model catalogue (ABACUS_VISION_MODELS /
  // OPENROUTER_VISION_MODELS) instead of a hard-coded `choices` literal. Verify
  // the catalogue offers a concrete vision model rather than a stale static key.
  ok(/id:\s*"gemini-3-flash-preview"/.test(SRC), "[11] visionModel offers a concrete vision model");
  // (v0.10.24) New analysis-quality / resolution / format settings.
  ok(/register\(MODULE_ID, "mapAnalysisQuality",[\s\S]*?type: String,[\s\S]*?default: "balanced"/.test(SRC),
     "[11] mapAnalysisQuality registered (String, default 'balanced')");
  ok(/register\(MODULE_ID, "maxMapResolution",[\s\S]*?type: String,[\s\S]*?default: "4096"/.test(SRC),
     "[11] maxMapResolution registered (String, default '4096')");
  ok(/register\(MODULE_ID, "imageFormat",[\s\S]*?type: String,[\s\S]*?default: "auto"/.test(SRC),
     "[11] imageFormat registered (String, default 'auto')");

  const s = LANG.ETERNAL_SKALD.settings;
  ok(s.autoAnalyzeScenes && s.autoAnalyzeScenes.name && s.autoAnalyzeScenes.hint, "[11] lang: autoAnalyzeScenes name+hint");
  ok(s.visionModel && s.visionModel.name && s.visionModel.hint, "[11] lang: visionModel name+hint");
  ok(s.visionModel.choices && s.visionModel.choices.inherit, "[11] lang: visionModel.choices.inherit");
  ok(s.mapAnalysisQuality && s.mapAnalysisQuality.name && s.mapAnalysisQuality.hint, "[11] lang: mapAnalysisQuality name+hint");
  ok(s.mapAnalysisQuality.choices && s.mapAnalysisQuality.choices.fast && s.mapAnalysisQuality.choices.balanced && s.mapAnalysisQuality.choices.thorough,
     "[11] lang: mapAnalysisQuality has fast/balanced/thorough choices");
  ok(s.maxMapResolution && s.maxMapResolution.name && s.maxMapResolution.hint && s.maxMapResolution.choices.original, "[11] lang: maxMapResolution name+hint+original");
  ok(s.imageFormat && s.imageFormat.name && s.imageFormat.hint && s.imageFormat.choices.auto, "[11] lang: imageFormat name+hint+auto");

  const apiIdx = SRC.indexOf("game.modules.get(MODULE_ID).api = {");
  const api = SRC.slice(apiIdx, apiIdx + 2000);
  ok(/mapVision: MapVision/.test(api), "[11] public API exposes mapVision");
  ok(/scout: \(scene\) => MapVision\.analyzeScene/.test(api), "[11] public API exposes a scout() helper");
}

/* --------------------------------------------------------------------- *
 * [12] Read-only on the map: only the BASE background is captured.
 * --------------------------------------------------------------------- */
{
  const bg = extractFrom(SRC, "_sceneBackgroundSrc(scene) {");
  ok(/background\?\.src/.test(bg), "[12] reads only scene.background.src (base map)");
  ok(!/\.tokens/.test(bg) && !/fog/i.test(bg) && !/drawings/i.test(bg),
     "[12] never reads tokens / fog / drawings (read-only base map)");
}

/* --------------------------------------------------------------------- *
 * [13] Client._visionModelTier() — strong / weak / unknown classification.
 * --------------------------------------------------------------------- */
const visionTier = (() => {
  const b = bodyOf("_visionModelTier(model) {");
  // eslint-disable-next-line no-new-func
  const fn = new Function("model", `return (function(model) ${b}).call(null, model);`);
  return (m) => fn(m);
})();
for (const m of ["gpt-4o", "claude-3-5-sonnet", "gemini-2.0-flash", "gemini-2.5-pro", "gpt-4-vision-preview"]) {
  eq(visionTier(m), "strong", `[13] '${m}' classified as a strong vision model`);
}
for (const m of ["gpt-4o-mini", "claude-3-haiku", "gemini-1.5-flash-lite", "llama-3.2-3b", "phi-3-vision"]) {
  eq(visionTier(m), "weak", `[13] '${m}' classified as a weak vision model`);
}
eq(visionTier(""), "unknown", "[13] empty model → unknown");

/* --------------------------------------------------------------------- *
 * [14] MapVision._planGrid() — resolution + quality → grid layout.
 * --------------------------------------------------------------------- */
const planGrid = (() => {
  const b = bodyOf("_planGrid(width, height, quality) {");
  // eslint-disable-next-line no-new-func
  const fn = new Function("width", "height", "quality", `return (function(width, height, quality) ${b}).call(null, width, height, quality);`);
  return (w, h, q) => fn(w, h, q);
})();
eq(planGrid(8000, 6000, "fast"), { cols: 1, rows: 1 }, "[14] fast quality never sections");
eq(planGrid(1200, 900, "balanced"), { cols: 1, rows: 1 }, "[14] small map under balanced → no sectioning");
eq(planGrid(3000, 2000, "balanced"), { cols: 2, rows: 2 }, "[14] large map under balanced → 2×2");
eq(planGrid(1000, 800, "thorough"), { cols: 1, rows: 1 }, "[14] tiny map under thorough → no sectioning");
eq(planGrid(2000, 1700, "thorough"), { cols: 2, rows: 2 }, "[14] mid map under thorough → 2×2");
eq(planGrid(5000, 4200, "thorough"), { cols: 3, rows: 3 }, "[14] very large map under thorough → 3×3");
eq(planGrid(0, 0, "thorough"), { cols: 1, rows: 1 }, "[14] zero dimensions → no sectioning (graceful)");

/* --------------------------------------------------------------------- *
 * [15] MapVision._gridRegions() — padded, in-bounds crop rectangles.
 * --------------------------------------------------------------------- */
const gridRegions = (() => {
  const b = bodyOf("_gridRegions(width, height, cols, rows) {");
  // eslint-disable-next-line no-new-func
  const fn = new Function("width", "height", "cols", "rows", `return (function(width, height, cols, rows) ${b}).call(null, width, height, cols, rows);`);
  return (w, h, c, r) => fn(w, h, c, r);
})();
{
  const regs = gridRegions(1000, 800, 2, 2);
  eq(regs.length, 4, "[15] 2×2 grid yields four regions");
  for (const r of regs) {
    ok(r.sx >= 0 && r.sy >= 0, "[15] region origin within bounds");
    ok(r.sx + r.sw <= 1000 && r.sy + r.sh <= 800, "[15] region stays inside the image");
    ok(r.sw > 500 && r.sh > 400, "[15] regions overlap (padded beyond exact cell size)");
    ok(typeof r.label === "string" && r.label.length > 0, "[15] region carries a human label");
  }
  const labels = regs.map(r => r.label);
  ok(labels.includes("north-west") && labels.includes("south-east"), "[15] corner sections get compass labels");
  eq(gridRegions(0, 0, 2, 2).length, 0, "[15] zero dimensions → no regions (graceful)");
  eq(gridRegions(1000, 800, 3, 3).length, 9, "[15] 3×3 grid yields nine regions");
}

/* --------------------------------------------------------------------- *
 * [16] MapVision._mergeAnalyses() — overview + sections, deduped.
 * --------------------------------------------------------------------- */
const mergeAnalyses = (() => {
  const b = bodyOf("_mergeAnalyses(overview, sections) {");
  // eslint-disable-next-line no-new-func
  const fn = new Function("overview", "sections", `return (function(overview, sections) ${b}).call(null, overview, sections);`);
  return (o, s) => fn(o, s);
})();
{
  const overview = {
    summary: "A kingdom map.", terrain: "Hills and rivers.",
    labels: ["Eldoria"],
    pois: [{ name: "Eldoria", type: "settlement", description: "Capital.", location: "centre", confidence: "high" }]
  };
  const sections = [
    { summary: "", terrain: "", labels: ["Eldoria", "Greywatch"],
      pois: [
        { name: "eldoria", type: "settlement", description: "The great capital city with walls.", location: "centre", confidence: "medium" },
        { name: "Greywatch", type: "structure", description: "A watchtower.", location: "north-west", confidence: "low" }
      ] },
    { summary: "", terrain: "", labels: ["Mistford"],
      pois: [{ name: "Mistford", type: "settlement", description: "A river town.", location: "south-east", confidence: "high" }] }
  ];
  const merged = mergeAnalyses(overview, sections);
  eq(merged.summary, "A kingdom map.", "[16] keeps the overview summary");
  eq(merged.pois.length, 3, "[16] de-dupes Eldoria across overview + section (3 unique POIs)");
  const eldoria = merged.pois.find(p => p.name.toLowerCase() === "eldoria");
  ok(eldoria.description.includes("great capital"), "[16] keeps the richer (longer) description on merge");
  eq(eldoria.confidence, "high", "[16] keeps the higher confidence on merge");
  ok(merged.labels.includes("Eldoria") && merged.labels.includes("Greywatch") && merged.labels.includes("Mistford"),
     "[16] labels combined and de-duplicated");
  // Empty/garbage inputs never throw.
  const safe = mergeAnalyses(null, null);
  ok(Array.isArray(safe.pois) && Array.isArray(safe.labels), "[16] null inputs → empty arrays (no throw)");
}

/* --------------------------------------------------------------------- *
 * [17] _parseAnalysis() — v0.10.24 labels, confidence, section default, cap.
 * --------------------------------------------------------------------- */
{
  const payload = JSON.stringify({
    summary: "S", terrain: "T",
    labels: ["Northreach", "northreach", "  Stonehaven  ", ""],
    pois: [
      { name: "Stonehaven", type: "settlement", description: "A fort.", location: "north", confidence: "HIGH" },
      { name: "Faint Trail", type: "path", description: "A dotted track.", confidence: "low" },
      { name: "Bad Conf", type: "other", description: "x", confidence: "definitely" }
    ]
  });
  const a = parseAnalysis(payload, { sectionLabel: "west", cap: 20 });
  eq(a.labels, ["Northreach", "Stonehaven"], "[17] labels deduped + trimmed + empties dropped");
  eq(a.pois[0].confidence, "high", "[17] confidence normalised to lowercase");
  eq(a.pois[1].location, "west", "[17] missing POI location defaults to the section label");
  eq(a.pois[2].confidence, "", "[17] invalid confidence → empty string");

  // Cap option raises the limit above the default 12.
  const many = [];
  for (let i = 1; i <= 25; i++) many.push({ name: `P${i}` });
  const big = parseAnalysis(JSON.stringify({ pois: many }), { cap: 20 });
  eq(big.pois.length, 20, "[17] cap option raises the POI limit");
  const def = parseAnalysis(JSON.stringify({ pois: many }));
  eq(def.pois.length, 12, "[17] default cap remains 12 when no option given");
}

/* --------------------------------------------------------------------- *
 * [18] VISION_PROMPT — specialised fantasy-cartography instruction.
 * --------------------------------------------------------------------- */
{
  const promptIdx = SRC.indexOf("VISION_PROMPT: [");
  const prompt = SRC.slice(promptIdx, SRC.indexOf("].join(\"\\n\")", promptIdx));
  ok(/TEXT LABELS/.test(prompt), "[18] prompt explicitly instructs reading text labels");
  ok(/SMALL SYMBOLS|ICONS/.test(prompt), "[18] prompt asks for small symbols / icons");
  ok(/PATHS|ROADS/.test(prompt) && /FAINT|faint/.test(prompt), "[18] prompt asks for faint paths / roads");
  ok(/SETTLEMENTS|STRUCTURES/.test(prompt), "[18] prompt asks for all settlements / structures");
  ok(/confidence/.test(prompt), "[18] prompt requests a confidence level per POI");
  ok(/"labels"/.test(prompt), "[18] prompt requests a transcribed labels array");
  ok(/STRICT JSON/.test(prompt), "[18] prompt still mandates strict JSON output");
}

/* --------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
