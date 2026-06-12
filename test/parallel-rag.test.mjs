/* =====================================================================
 *  Parallel-RAG test for The Eternal Skald (P4 latency — FINAL).
 *
 *  Previously the move-resolution narration path in
 *  scripts/narrative/integration.js ran two INDEPENDENT prep steps
 *  sequentially: it first gathered the live game-state context
 *  (`this.gatherContext()` — several synchronous Foundry document reads)
 *  and only THEN awaited the async RAG memory retrieval
 *  (`RagBridge.fetchMemory()` — embedding + IndexedDB vector search).
 *  RAG latency therefore sat on the critical path in front of context
 *  building. P4 runs them concurrently via Promise.all, so the sync
 *  context gather overlaps with the async RAG round-trip. Both paths
 *  still degrade gracefully to "" and Promise.all never rejects here.
 *
 *  Two halves (mirrors request-timeout.test.mjs convention):
 *    [A] Source-text guards over integration.js — the move-narration
 *        path destructures `[memory, ctx]` from a single Promise.all
 *        whose two elements are RagBridge.fetchMemory and a deferred
 *        this.gatherContext(); the old sequential gather is gone.
 *    [B] A behavioural proof that the exact Promise.all pattern actually
 *        runs the two prep steps concurrently (total ≈ max, not sum),
 *        destructures results in order, and degrades gracefully when the
 *        context gather throws or RAG returns nothing.
 *
 *  Run: node test/parallel-rag.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTEGRATION = readFileSync(
  join(__dirname, "..", "scripts", "narrative", "integration.js"), "utf8");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }

console.log("Parallel-RAG test (P4 latency — FINAL)\n");

/* ── [A] Source-text guards over integration.js ──────────────────── */
ok(/const\s*\[\s*memory\s*,\s*ctx\s*\]\s*=\s*await\s+Promise\.all\s*\(/.test(INTEGRATION),
   "[A1] the move-narration path destructures [memory, ctx] from await Promise.all([...])");
ok(/Promise\.all\s*\(\s*\[\s*[\r\n\s]*RagBridge\.fetchMemory\s*\(/.test(INTEGRATION),
   "[A2] RAG retrieval (RagBridge.fetchMemory) is the first parallel branch");
ok(/Promise\.resolve\(\)\.then\(\s*\(\s*\)\s*=>\s*\{[\s\S]*?gatherContext\s*\(/.test(INTEGRATION),
   "[A3] context gathering (this.gatherContext) is deferred into the second parallel branch");
// The context gather inside the parallel branch must swallow its own errors so
// Promise.all cannot reject (graceful degradation to "").
ok(/=>\s*\{\s*try\s*\{\s*return\s+this\.gatherContext\(\)\s*;?\s*\}\s*catch\s*\([^)]*\)\s*\{\s*return\s*""\s*;?\s*\}/.test(INTEGRATION),
   "[A4] the parallel context branch try/catches to \"\" (Promise.all never rejects)");
// The OLD sequential pattern (gatherContext() immediately followed by the
// intent line, before any RAG await) must be gone from this path.
ok(!/const\s+ctx\s*=\s*this\.gatherContext\(\)\s*;\s*\n\s*const\s+intent\s*=/.test(INTEGRATION),
   "[A5] the old sequential 'const ctx = this.gatherContext()' before intent is removed");
// fetchMemory must no longer be awaited on its own line in this path (it now
// lives only inside the Promise.all array).
ok(!/const\s+memory\s*=\s*await\s+RagBridge\.fetchMemory\s*\(/.test(INTEGRATION),
   "[A6] RAG retrieval is no longer awaited sequentially on its own line");

/* ── [B] Behavioural: the Promise.all pattern runs both concurrently ─ */
// Reproduce the helper's EXACT control flow from integration.js.
async function prep(fetchMemory, gatherContext) {
  return Promise.all([
    fetchMemory(),
    Promise.resolve().then(() => { try { return gatherContext(); } catch (_) { return ""; } })
  ]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function behavioural() {
  // B1 — concurrency: a 120ms async RAG fetch overlaps the sync context gather.
  const events = [];
  const ragMs = 120;
  const fetchMemory = async () => { await sleep(ragMs); events.push("rag-done"); return "MEM"; };
  const gatherContext = () => { events.push("ctx-done"); return "CTX"; };
  const start = Date.now();
  const [memory, ctx] = await prep(fetchMemory, gatherContext);
  const elapsed = Date.now() - start;

  ok(events[0] === "ctx-done" && events[1] === "rag-done",
     `[B1] the sync context gather completes WHILE RAG is still in flight (order: ${events.join(",")})`);
  ok(elapsed < ragMs + 60,
     `[B2] total time ≈ the RAG latency, not RAG + context (elapsed ${elapsed}ms, RAG ${ragMs}ms)`);
  ok(memory === "MEM" && ctx === "CTX",
     `[B3] results are destructured in order [memory, ctx] (got [${memory}, ${ctx}])`);

  // B4 — graceful: a throwing context gather degrades to "" without rejecting.
  let rejected = false, res;
  try {
    res = await prep(async () => "MEM2", () => { throw new Error("scene read boom"); });
  } catch (_) { rejected = true; }
  ok(!rejected && res && res[0] === "MEM2" && res[1] === "",
     `[B4] a throwing context gather degrades to "" and Promise.all still resolves`);

  // B5 — graceful: RAG off (resolves "") still yields a usable context.
  const [m5, c5] = await prep(async () => "", () => "CTX5");
  ok(m5 === "" && c5 === "CTX5",
     `[B5] when RAG is off (memory ""), the context branch still resolves correctly`);
}

await behavioural();

/* --------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
