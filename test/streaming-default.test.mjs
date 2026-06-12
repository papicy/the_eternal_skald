/* =====================================================================
 *  Streaming-by-default regression test for The Eternal Skald (v0.14.3).
 *
 *  P1 latency optimisation: Client.chat() now routes through the existing
 *  SSE streaming transport (chatStream) BY DEFAULT, so the upstream LLM
 *  begins emitting tokens immediately → lower time-to-first-token. The
 *  behaviour stays fully backwards-compatible:
 *
 *    • Gated on the existing world setting `streamingEnabled` (default true).
 *      When a world sets it to false, chat() uses the original buffered path.
 *    • A per-call escape hatch (opts.buffered === true) forces buffered mode.
 *    • chatStream() returns the full reply text when no render handlers are
 *      supplied, and `_consumeStreamingResponse` transparently degrades to
 *      buffered JSON if the server returns a non-SSE response — so callers
 *      always get a usable Promise<string>.
 *    • chatStream() now honours a per-call pinned model (opts.model), matching
 *      chat(), so delegated vision calls keep their multimodal model.
 *
 *  The Client object lives inside an ESM that registers Foundry hooks at
 *  import time, so it can't be imported in isolation. Following the project
 *  convention (see direct-llm-fallback.test.mjs), we assert on the source
 *  text via the shared corpus reader, plus a small behavioural model of the
 *  default-transport decision.
 *
 *  Run: node test/streaming-default.test.mjs
 * ===================================================================== */

import { readSkaldSource } from "./_skald-source.mjs";

const SRC = readSkaldSource();

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }

/** Extract a function body by marker, brace-matching the body (same as
 *  direct-llm-fallback.test.mjs). */
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

console.log("Streaming-by-default structural test (v0.14.3)\n");

/* --------------------------------------------------------------------- *
 * [1] The streamingEnabled setting still exists and defaults to true.
 * --------------------------------------------------------------------- */
ok(/register\(MODULE_ID,\s*"streamingEnabled"/.test(SRC),
   "[1] streamingEnabled setting is still registered (not removed/renamed)");
ok(/register\(MODULE_ID, "streamingEnabled"[\s\S]*?default:\s*true/.test(SRC),
   "[1] streamingEnabled still defaults to true");

/* --------------------------------------------------------------------- *
 * [2] chat() delegates to the SSE streaming path by default.
 * --------------------------------------------------------------------- */
const chat = extractFrom(SRC, "async chat(messages");
ok(/streamingEnabled["']?\)\s*!==\s*false/.test(chat),
   "[2] chat() gates the default transport on streamingEnabled !== false");
ok(/return this\.chatStream\(messages, opts, \{\}\)/.test(chat),
   "[2] chat() delegates to this.chatStream(messages, opts, {}) by default");

/* --------------------------------------------------------------------- *
 * [3] Backwards-compat: buffered path is still reachable.
 * --------------------------------------------------------------------- */
ok(/opts\.buffered\s*!==\s*true/.test(chat),
   "[3] chat() honours opts.buffered === true as an explicit buffered opt-out");
ok(/stream:\s*false/.test(chat),
   "[3] the original buffered payload (stream:false) is still present in chat()");
// The delegation must come BEFORE the buffered payload is built, otherwise the
// streaming short-circuit would be dead code.
ok(chat.indexOf("this.chatStream(messages, opts, {})") < chat.indexOf("stream: false"),
   "[3] streaming delegation precedes the buffered payload build");

/* --------------------------------------------------------------------- *
 * [4] chatStream() honours a per-call pinned model (opts.model).
 * --------------------------------------------------------------------- */
const cstream = extractFrom(SRC, "async chatStream(messages");
ok(/const model\s*=\s*opts\.model\s*\|\|\s*Settings\.get\("modelName"\)/.test(cstream),
   "[4] chatStream() resolves model as opts.model || Settings modelName || default");

/* --------------------------------------------------------------------- *
 * [5] Graceful degradation: the SSE consumer still falls back to buffered
 *     JSON when the response is not an event-stream.
 * --------------------------------------------------------------------- */
const consume = extractFrom(SRC, "async _consumeStreamingResponse(");
ok(/text\/event-stream/.test(consume) && /response\.json\(\)/.test(consume),
   "[5] _consumeStreamingResponse degrades to buffered JSON for non-SSE responses");

/* --------------------------------------------------------------------- *
 * [6] Behavioural model of the default-transport decision in chat().
 * --------------------------------------------------------------------- */
function pickTransport({ streamingEnabled = true, buffered = false } = {}) {
  // Mirrors chat(): stream unless the world disabled it or the caller opts out.
  return (streamingEnabled !== false && buffered !== true) ? "stream" : "buffered";
}
ok(pickTransport() === "stream",
   "[6] default (no opts) → streaming transport");
ok(pickTransport({ streamingEnabled: false }) === "buffered",
   "[6] streamingEnabled=false → buffered transport (backwards compatible)");
ok(pickTransport({ buffered: true }) === "buffered",
   "[6] opts.buffered=true → buffered transport (per-call opt-out)");
ok(pickTransport({ streamingEnabled: true, buffered: false }) === "stream",
   "[6] explicit defaults → streaming transport");

/* --------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
