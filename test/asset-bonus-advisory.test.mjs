/* =====================================================================
 *  Asset Bonus Advisory test (v0.10.38 — Phase 4).
 *
 *  Locks in the PURE bonus-detection layer added to the controller, plus a
 *  faithful replica of the small gating/HTML-building logic added to the
 *  Foundry+AI layer (eternal-skald.js, not unit-testable in isolation):
 *
 *    • detectAssetBonuses — scans enabled asset ability text for roll-bonus
 *                           wording ("add +1", "+2 when…", "take +1") and
 *                           returns only bonuses that plausibly apply to the
 *                           move being made (move/stat keyword overlap).
 *    • _bonusTokens       — stopword-stripped keyword tokeniser.
 *    • _bonusSentence     — clause extraction around a bonus.
 *    • advisory gating replica — setting OFF / no actor / no hits ⇒ no post.
 *    • advisory HTML replica   — non-blocking suggestion markup.
 *
 *  detectAssetBonuses is side-effect-free (no Foundry calls), so it is
 *  exercised directly. The controller still touches `foundry.utils` at import
 *  time in other methods, so we stub the minimum globals first.
 *
 *  Run: node test/asset-bonus-advisory.test.mjs
 * ===================================================================== */

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

/* ---- Minimal Foundry globals the controller references at import ---- */
function getProperty(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setProperty(obj, path, value) {
  const keys = path.split("."); let o = obj;
  while (keys.length > 1) { const k = keys.shift(); o[k] = o[k] ?? {}; o = o[k]; }
  o[keys[0]] = value;
}
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
globalThis.foundry = { utils: { getProperty, setProperty, deepClone } };
globalThis.CONFIG = { Item: { dataModels: { "asset": {}, "progress": {}, "bondset": {} } } };

const { default: Ctrl } = await import("../scripts/ironsworn-controller.js");

/* ---- Helper to build an asset snapshot (shape of getAssets output) ---- */
function asset(name, ...abilities) { return { name, abilities }; }

/* =====================================================================
 *  _bonusTokens
 * ===================================================================== */
console.log("[1] _bonusTokens — strips stopwords + short tokens");
{
  const t = Ctrl._bonusTokens("Face Danger");
  ok(t.includes("face"), "keeps 'face'");
  ok(t.includes("danger"), "keeps 'danger'");
}
{
  const t = Ctrl._bonusTokens("When you Make a Move and roll");
  ok(!t.includes("when"), "drops stopword 'when'");
  ok(!t.includes("make"), "drops stopword 'make'");
  ok(!t.includes("roll"), "drops stopword 'roll'");
  ok(!t.includes("you"), "drops stopword 'you'");
}
{
  const t = Ctrl._bonusTokens("Aid Your Ally");
  ok(t.includes("aid"), "keeps 3-char 'aid'");
  ok(t.includes("ally"), "keeps 'ally'");
  ok(!t.includes("your"), "drops 'your'");
}

/* =====================================================================
 *  _bonusSentence
 * ===================================================================== */
console.log("[2] _bonusSentence — extracts the clause around a +N");
{
  const text = "You are wise in the wild. When you Face Danger in the wilds, add +1. Otherwise nothing.";
  const idx = text.indexOf("+1");
  const s = Ctrl._bonusSentence(text, idx);
  ok(/Face Danger in the wilds/.test(s), "captures the bonus sentence");
  ok(!/Otherwise/.test(s), "does not bleed into the next sentence");
  ok(!/wise in the wild/.test(s), "does not bleed into the previous sentence");
}

/* =====================================================================
 *  detectAssetBonuses — core
 * ===================================================================== */
console.log("[3] detect — 'add +1' in same sentence as move name (relevant)");
{
  const assets = [asset("Wayfinder", "When you Face Danger to travel, add +1.")];
  const hits = Ctrl.detectAssetBonuses(assets, "Face Danger");
  eq(hits.length, 1, "one hit");
  eq(hits[0].asset, "Wayfinder", "asset name");
  eq(hits[0].bonus, 1, "bonus value");
  ok(/Face Danger/.test(hits[0].condition), "condition carries the trigger");
  ok(hits[0].relevance >= 4, "both move tokens in clause ⇒ relevance ≥4");
}

console.log("[4] detect — '+2 when' pattern");
{
  const assets = [asset("Sword", "+2 when you Strike against a flanked foe.")];
  const hits = Ctrl.detectAssetBonuses(assets, "Strike");
  eq(hits.length, 1, "one hit");
  eq(hits[0].bonus, 2, "bonus value 2");
}

console.log("[5] detect — unrelated bonus is filtered out");
{
  // "+1 health" has no overlap with the move 'Strike' ⇒ no suggestion.
  const assets = [asset("Healer", "Your companion has +1 health when summoned.")];
  const hits = Ctrl.detectAssetBonuses(assets, "Strike");
  eq(hits.length, 0, "no spurious suggestion");
}

console.log("[6] detect — stat keyword raises relevance / enables a match");
{
  const assets = [asset("Ironclad", "Add +1 to your iron rolls in armor.")];
  // Move name 'Clash' shares no token, but the rolled stat is iron.
  const hits = Ctrl.detectAssetBonuses(assets, "Clash", { stat: "iron" });
  eq(hits.length, 1, "stat match surfaces the bonus");
  eq(hits[0].bonus, 1, "bonus 1");
}

console.log("[7] detect — only enabled-ability text passed in is scanned");
{
  // getAssets already filters to enabled abilities; detect only sees what it's given.
  const assets = [asset("Half-Asset" /* no abilities */)];
  const hits = Ctrl.detectAssetBonuses(assets, "Face Danger");
  eq(hits.length, 0, "no abilities ⇒ no hits");
}

console.log("[8] detect — HTML is stripped before matching");
{
  const assets = [asset("Scholar", "<p>When you <em>Gather Information</em>, add <strong>+1</strong>.</p>")];
  const hits = Ctrl.detectAssetBonuses(assets, "Gather Information");
  eq(hits.length, 1, "matches through HTML");
  eq(hits[0].bonus, 1, "bonus parsed");
  ok(!/[<>]/.test(hits[0].condition), "condition has no tags");
}

console.log("[9] detect — dedupe identical asset+bonus+condition");
{
  const assets = [asset("Echo", "When you Face Danger, add +1. When you Face Danger, add +1.")];
  const hits = Ctrl.detectAssetBonuses(assets, "Face Danger");
  // Two identical clauses → deduped to one.
  eq(hits.length, 1, "duplicate clause deduped");
}

console.log("[10] detect — sorted by relevance desc, capped by maxResults");
{
  const assets = [
    asset("A1", "When you Secure an Advantage, add +1."),       // 3 tokens → high
    asset("A2", "Add +2 when you act with advantage."),          // 'advantage' only → lower
    asset("A3", "When you Secure an Advantage boldly, add +1."), // 3 tokens → high
    asset("A4", "On any advantage, add +1."),                    // 'advantage' only
    asset("A5", "Secure an Advantage: add +1.")                  // 3 tokens
  ];
  const hits = Ctrl.detectAssetBonuses(assets, "Secure an Advantage", { maxResults: 3 });
  eq(hits.length, 3, "capped at maxResults=3");
  ok(hits[0].relevance >= hits[1].relevance, "sorted desc (0≥1)");
  ok(hits[1].relevance >= hits[2].relevance, "sorted desc (1≥2)");
}

console.log("[11] detect — ignores +0 and absurd values");
{
  const assets = [asset("Weird", "When you Face Danger, add +0 or +99 nonsense.")];
  const hits = Ctrl.detectAssetBonuses(assets, "Face Danger");
  eq(hits.length, 0, "+0 and +99 are not surfaced");
}

console.log("[12] detect — defensive on null / empty input");
{
  eq(Ctrl.detectAssetBonuses(null, "Strike").length, 0, "null assets ⇒ []");
  eq(Ctrl.detectAssetBonuses([], "Strike").length, 0, "empty assets ⇒ []");
  eq(Ctrl.detectAssetBonuses([asset("X", "add +1")], "").length, 0, "empty move + no stat ⇒ []");
}

console.log("[13] detect — multiple assets, multiple hits");
{
  const assets = [
    asset("Companion", "When you Face Danger to protect your ally, add +1."),
    asset("Talent", "When you Face Danger, take +2 and mark progress.")
  ];
  const hits = Ctrl.detectAssetBonuses(assets, "Face Danger");
  eq(hits.length, 2, "both assets surface");
  const names = hits.map(h => h.asset).sort();
  ok(names[0] === "Companion" && names[1] === "Talent", "both named");
}

/* =====================================================================
 *  Advisory gating + HTML replica (mirrors eternal-skald.js logic)
 * ===================================================================== */
console.log("[14] advisory gating replica — off / no actor / no hits ⇒ no post");
{
  // Faithful replica of _maybeAdviseAssetBonuses control flow.
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c])); }
  function wouldPost(settingOn, actor, assets, moveName, stat) {
    if (!settingOn) return null;
    if (!actor || !moveName) return null;
    const hits = Ctrl.detectAssetBonuses(assets, moveName, { stat: stat || "" });
    if (!hits.length) return null;
    const items = hits.map(h => `<li>💡 Your <strong>${escapeHtml(h.asset)}</strong> grants <strong>+${h.bonus}</strong>${h.condition ? ` — <em>${escapeHtml(h.condition)}</em>` : ""}</li>`).join("");
    return `<p>You may have an asset bonus for <strong>${escapeHtml(moveName)}</strong>:</p><ul class="es-asset-advisory">${items}</ul>`;
  }
  const assets = [asset("Wayfinder", "When you Face Danger to travel, add +1.")];
  eq(wouldPost(false, {}, assets, "Face Danger"), null, "setting OFF ⇒ no post");
  eq(wouldPost(true, null, assets, "Face Danger"), null, "no actor ⇒ no post");
  eq(wouldPost(true, {}, assets, ""), null, "no move ⇒ no post");
  eq(wouldPost(true, {}, [asset("Z", "+1 health")], "Strike"), null, "no hits ⇒ no post");
  const html = wouldPost(true, {}, assets, "Face Danger");
  ok(html && html.includes("es-asset-advisory"), "renders advisory list when applicable");
  ok(html.includes("Wayfinder") && html.includes("+1"), "names asset + bonus");
  ok(html.includes("💡"), "includes the advisory marker");
}

/* ---- Summary ---- */
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
