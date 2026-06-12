/* =====================================================================
 *  Token Control regression test — The Eternal Skald (v0.16.0).
 *
 *  Exercises scripts/narrative/token-control.js end-to-end with a minimal
 *  Foundry mock: pure parsing/geometry helpers, the feature/GM gates, the
 *  animated move (absolute + relative), removal with the player-token
 *  confirmation hook, and the 10-step undo (move-restore + removal-recreate).
 *
 *  Pure node, no real Foundry — globals are stubbed before import.
 *
 *  Run: node test/token-control.test.mjs
 * ===================================================================== */

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

/* ----------------------- Minimal Foundry mock ----------------------- */
const settingsStore = {
  tokenControlEnabled: true,
  tokenControlAiTriggers: true,
  tokenMoveDuration: 1000
};

let confirmAnswer = true;          // what the player-removal dialog resolves to
let lastWhisper = null;

function makeTokenDoc(id, name, x, y, { playerOwner = false } = {}) {
  const doc = {
    id, x, y,
    ownership: playerOwner ? { player1: 3 } : { gm1: 3 },
    actor: { hasPlayerOwner: playerOwner },
    async update(changes) { Object.assign(this, changes); return this; },
    async delete() { scene._removeToken(id); return true; },
    toObject() { return { _id: id, name, x: this.x, y: this.y }; }
  };
  return doc;
}

function makeToken(id, name, x, y, opts) {
  const document = makeTokenDoc(id, name, x, y, opts);
  return { id, name, document, actor: document.actor };
}

const scene = {
  id: "scene1",
  grid: { size: 100, distance: 5 },          // 100px per square, 5 ft per square
  dimensions: { width: 4000, height: 4000 },
  _tokens: [],
  tokens: { get: (id) => scene._tokens.find(t => t.document.id === id)?.document ?? null },
  _removeToken(id) { scene._tokens = scene._tokens.filter(t => t.document.id !== id); },
  _created: [],
  async createEmbeddedDocuments(type, arr) { scene._created.push(...arr); return arr; }
};

globalThis.game = {
  user: { isGM: true, targets: new Set() },
  users: { get: (uid) => ({ id: uid, isGM: uid.startsWith("gm") }) },
  scenes: { active: scene, get: (id) => (id === scene.id ? scene : null) },
  settings: { get: (_mod, key) => settingsStore[key] },
  i18n: { localize: (k) => k }
};
globalThis.canvas = {
  scene,
  tokens: { placeables: scene._tokens, controlled: [] }
};
globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
globalThis.ChatMessage = {
  getSpeaker: () => ({}),
  async create(data) { lastWhisper = data; return data; }
};
globalThis.foundry = {
  utils: { getProperty: (o, p) => p.split(".").reduce((a, k) => a?.[k], o), setProperty: () => {} },
  applications: { api: { DialogV2: { confirm: async () => confirmAnswer } } }
};
// The import chain pulls in modules that register Foundry hooks / read config
// at module-eval. Stub just enough to let them load cleanly (none run here).
globalThis.Hooks = { on() {}, once() {}, off() {}, call() {}, callAll() {} };
globalThis.CONFIG = { Item: { dataModels: {} }, Canvas: {} };
globalThis.CONST = {};
game.modules = { get: () => ({ active: false, api: {} }) };
game.system = { id: "foundry-ironsworn" };

const { TokenControl } = await import("../scripts/narrative/token-control.js");

function reset() {
  scene._tokens = [
    makeToken("t1", "Goblin", 200, 200),
    makeToken("t2", "Bjorn", 1000, 1000, { playerOwner: true })
  ];
  canvas.tokens.placeables = scene._tokens;
  canvas.tokens.controlled = [];
  scene._created = [];
  settingsStore.tokenControlEnabled = true;
  settingsStore.tokenControlAiTriggers = true;
  confirmAnswer = true;
}

/* ===================================================================== */
console.log("[1] pure parsing & geometry helpers");
{
  eq(JSON.stringify(TokenControl.parseCoords("500,300")), JSON.stringify({ x: 500, y: 300 }), "parseCoords comma");
  eq(JSON.stringify(TokenControl.parseCoords("500, 300")), JSON.stringify({ x: 500, y: 300 }), "parseCoords comma+space");
  eq(TokenControl.parseCoords("notcoords"), null, "parseCoords rejects garbage");

  eq(JSON.stringify(TokenControl.directionVector("north")), JSON.stringify({ ux: 0, uy: -1 }), "north vector");
  eq(JSON.stringify(TokenControl.directionVector("se")), JSON.stringify({ ux: 1, uy: 1 }), "se vector");
  eq(TokenControl.directionVector("nowhere"), null, "bad direction → null");

  const rel = TokenControl.parseRelative("5 feet north");
  eq(rel.distance, 5, "parseRelative distance");
  eq(rel.direction, "north", "parseRelative direction");
  const rel2 = TokenControl.parseRelative("north 3 squares");
  eq(rel2.distance, 3, "parseRelative dir-first distance");
  eq(rel2.direction, "north", "parseRelative dir-first direction");

  // 5 feet north with 5ft/square @100px = exactly one square up = -100px.
  const px = TokenControl.relativePixels({ distance: 5, unit: "feet", direction: "north" }, 100, 5);
  eq(px.dx, 0, "5ft north dx");
  eq(px.dy, -100, "5ft north dy");
  // 2 squares east = +200px.
  const px2 = TokenControl.relativePixels({ distance: 2, unit: "squares", direction: "east" }, 100, 5);
  eq(px2.dx, 200, "2 squares east dx");
}

/* ===================================================================== */
console.log("[2] gates: disabled / non-GM are safe no-ops");
{
  reset();
  settingsStore.tokenControlEnabled = false;
  let r = await TokenControl.moveTokenTo("Goblin", 500, 500);
  ok(r.ok === false, "move blocked when feature disabled");
  r = await TokenControl.removeToken("Goblin");
  ok(r.ok === false, "remove blocked when feature disabled");

  reset();
  game.user.isGM = false;
  r = await TokenControl.moveTokenTo("Goblin", 500, 500);
  ok(r.ok === false, "move blocked for non-GM");
  game.user.isGM = true;
}

/* ===================================================================== */
console.log("[3] absolute & relative move (animated) + undo");
{
  reset();
  const r = await TokenControl.moveTokenTo("Goblin", 500, 600);
  ok(r.ok, "absolute move succeeds");
  const g = scene._tokens.find(t => t.name === "Goblin").document;
  eq(g.x, 500, "goblin x updated"); eq(g.y, 600, "goblin y updated");
  eq(TokenControl.undoDepth(), 1, "undo stack has 1 entry");

  // Relative: 5 feet north from (500,600) → (500,500)
  const r2 = await TokenControl.moveTokenRelative("Goblin", { distance: 5, unit: "feet", direction: "north" });
  ok(r2.ok, "relative move succeeds");
  eq(g.y, 500, "goblin moved one square north");

  // Undo the relative move → back to 600.
  const u = await TokenControl.undo();
  ok(u.ok && u.type === "move", "undo restores a move");
  eq(g.y, 600, "goblin y restored after undo");
}

/* ===================================================================== */
console.log("[4] removal: non-player vs player (confirmation) + undo recreate");
{
  reset();
  // Non-player token: removed without confirmation.
  let r = await TokenControl.removeToken("Goblin");
  ok(r.ok && !r.playerOwned, "non-player token removed");
  ok(!scene._tokens.some(t => t.name === "Goblin"), "goblin gone from scene");

  // Player token: confirmation REQUIRED. Deny first.
  confirmAnswer = false;
  r = await TokenControl.removeToken("Bjorn");
  ok(r.ok === false && r.cancelled === true, "player token removal cancelled when GM declines");
  ok(scene._tokens.some(t => t.name === "Bjorn"), "bjorn still present after cancel");

  // Approve.
  confirmAnswer = true;
  r = await TokenControl.removeToken("Bjorn");
  ok(r.ok && r.playerOwned, "player token removed after confirmation");

  // Undo the player removal → recreated via createEmbeddedDocuments.
  const u = await TokenControl.undo();
  ok(u.ok && u.type === "remove", "undo recreates a removed token");
  ok(scene._created.some(d => d.name === "Bjorn"), "bjorn recreated on scene");

  // force:true bypasses the confirmation (typed `confirm` path).
  reset();
  confirmAnswer = false;          // dialog would say no, but force skips it
  r = await TokenControl.removeToken("Bjorn", { force: true });
  ok(r.ok, "force removal bypasses confirmation");
}

/* ===================================================================== */
console.log("[5] undo stack is capped at 10");
{
  reset();
  // Push 12 moves; only the last 10 should be retained.
  for (let i = 0; i < 12; i++) await TokenControl.moveTokenTo("Goblin", 100 + i, 100 + i);
  eq(TokenControl.undoDepth(), 10, "undo stack capped at 10");
  // Drain it; the 11th undo must report nothing left.
  for (let i = 0; i < 10; i++) await TokenControl.undo();
  const u = await TokenControl.undo();
  ok(u.ok === false, "undo on empty stack is a safe failure");
}

/* ===================================================================== */
console.log("[6] AI directive routing (runFromDirective) honours its gate");
{
  reset();
  let r = await TokenControl.runFromDirective("move_token Goblin to 700,800");
  ok(r.ok, "directive absolute move applies when AI triggers enabled");
  const g = scene._tokens.find(t => t.name === "Goblin").document;
  eq(g.x, 700, "directive moved goblin x");

  r = await TokenControl.runFromDirective("remove_token Goblin");
  ok(r.ok, "directive removal applies");

  // Gate off → no-op.
  reset();
  settingsStore.tokenControlAiTriggers = false;
  r = await TokenControl.runFromDirective("move_token Goblin to 700,800");
  ok(r.ok === false, "directive blocked when AI triggers disabled");
}

/* ===================================================================== */
console.log("[7] chat subcommand front door");
{
  reset();
  // "move Goblin to 300,400"
  let handled = await TokenControl.handleChatSubcommand("move Goblin to 300,400");
  ok(handled === true, "move subcommand handled");
  const g = scene._tokens.find(t => t.name === "Goblin").document;
  eq(g.x, 300, "subcommand moved goblin");

  // "undo"
  handled = await TokenControl.handleChatSubcommand("undo");
  ok(handled === true, "undo subcommand handled");

  // A non-token line is NOT handled (lets narration proceed).
  handled = await TokenControl.handleChatSubcommand("tell me a tale of the north");
  ok(handled === false, "non-token line passes through to narration");

  // Disabled feature → never handled.
  settingsStore.tokenControlEnabled = false;
  handled = await TokenControl.handleChatSubcommand("move Goblin to 1,1");
  ok(handled === false, "subcommand inert when feature disabled");
}

/* ===================================================================== */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
