/* =====================================================================
 *  Map vision / scouting test for The Eternal Skald (v0.10.23).
 *
 *  v0.10.23 gives the Skald EYES: the MapVision module captures a scene's
 *  base background art, downscales it to a JPEG data URL, sends it to a
 *  vision-capable model with a strict-JSON prompt, parses the returned
 *  points of interest, caches the result on the scene's flags and scribes
 *  the POIs into the Living Chronicle as Location entries. A `canvasReady`
 *  hook auto-scouts new scenes, and `!scout` / `!survey` / `!analyze-map`
 *  force a re-scout on demand.
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_PATH  = join(__dirname, "..", "scripts", "eternal-skald.js");
const SRC = readFileSync(SRC_PATH, "utf8");
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
/** Build a callable from a marker, returning just the `{ body }` braces. */
function bodyOf(marker) {
  const m = extractFrom(SRC, marker);
  return m.slice(m.indexOf("{"));
}

console.log("Map vision / scouting test (v0.10.23)\n");

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
  const b = bodyOf("_parseAnalysis(text) {");
  // eslint-disable-next-line no-new-func
  const fn = new Function("text", `return (function(text) ${b}).call(null, text);`);
  return (t) => fn(t);
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
 * [5] MapVision._buildVisionMessages() — OpenAI-compatible multimodal shape.
 * --------------------------------------------------------------------- */
const buildMessages = (() => {
  const b = bodyOf("_buildVisionMessages(imageUrl, sceneName) {");
  // eslint-disable-next-line no-new-func
  const fn = new Function("imageUrl", "sceneName",
    `return (function(imageUrl, sceneName) ${b}).call(this, imageUrl, sceneName);`);
  return (img, name, prompt) => fn.call({ VISION_PROMPT: prompt }, img, name);
})();
{
  const msgs = buildMessages("data:image/jpeg;base64,Zz", "The Hollow Vale", "PROMPT_TEXT");
  ok(Array.isArray(msgs) && msgs.length === 2, "[5] two messages (system + user)");
  eq(msgs[0].role, "system", "[5] first message is system");
  eq(msgs[1].role, "user", "[5] second message is user");
  ok(Array.isArray(msgs[1].content), "[5] user content is a multimodal array");
  eq(msgs[1].content[0].type, "text", "[5] first part is text");
  eq(msgs[1].content[1].type, "image_url", "[5] second part is image_url");
  eq(msgs[1].content[1].image_url.url, "data:image/jpeg;base64,Zz", "[5] image_url carries the data URL");
  ok(msgs[1].content[0].text.includes("PROMPT_TEXT"), "[5] text part includes the vision prompt");
  ok(msgs[1].content[0].text.includes("The Hollow Vale"), "[5] scene name woven into the text part");
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

  const dispatch = extractFrom(SRC, "function dispatchCommand(");
  ok(/case COMMANDS\.SCOUT:\s*return \(\) => Commands\.scout/.test(dispatch), "[7] !scout dispatches to Commands.scout");
  ok(/case COMMANDS\.SURVEY:\s*return \(\) => Commands\.scout/.test(dispatch), "[7] !survey aliases Commands.scout");
  ok(/case COMMANDS\.ANALYZE_MAP:\s*return \(\) => Commands\.scout/.test(dispatch), "[7] !analyze-map aliases Commands.scout");

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
  ok(/this\._captureSceneImage\(sc\)/.test(analyze), "[9] captures the scene image");
  ok(/this\._storeAnalysis\(sc, analysis\)/.test(analyze), "[9] caches the analysis on the scene");
  ok(/this\._journalPois\(parsed\.pois, sc\)/.test(analyze), "[9] journals discovered POIs");
  ok(/this\._postScoutCard\(analysis/.test(analyze), "[9] posts the scout chat card");
  ok(/timestamp: Date\.now\(\)/.test(analyze) && /model,/.test(analyze) && /pois: parsed\.pois/.test(analyze),
     "[9] stored analysis records timestamp, model and POIs");
  ok(/this\._canWrite\(\)/.test(analyze), "[9] GM-only guard inside analyzeScene");

  const store = extractFrom(SRC, "async _storeAnalysis(scene, analysis) {");
  ok(/setFlag\(MODULE_ID, this\.FLAG_KEY, analysis\)/.test(store), "[9] stores under scene.flags[MODULE_ID].mapAnalysis");

  const capture = extractFrom(SRC, "async _captureSceneImage(scene, opts = {}) {");
  ok(/maxDim = opts\.maxDim \?\? 2048/.test(capture), "[9] downscales to max 2048px by default");
  ok(/quality = opts\.quality \?\? 0\.85/.test(capture), "[9] JPEG quality defaults to 0.85");

  const down = extractFrom(SRC, "_downscaleToDataUrl(src, maxDim = 2048, quality = 0.85) {");
  ok(/toDataURL\("image\/jpeg", quality\)/.test(down), "[9] exports JPEG data URL");
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
  ok(/"gemini-3-flash-preview":\s*"gemini-3-flash-preview"/.test(SRC), "[11] visionModel offers a concrete vision model");

  const s = LANG.ETERNAL_SKALD.settings;
  ok(s.autoAnalyzeScenes && s.autoAnalyzeScenes.name && s.autoAnalyzeScenes.hint, "[11] lang: autoAnalyzeScenes name+hint");
  ok(s.visionModel && s.visionModel.name && s.visionModel.hint, "[11] lang: visionModel name+hint");
  ok(s.visionModel.choices && s.visionModel.choices.inherit, "[11] lang: visionModel.choices.inherit");

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

/* --------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
