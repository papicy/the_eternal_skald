/* =====================================================================
 *  HTTP keep-alive forwarder test for The Eternal Skald (P0 latency).
 *
 *  The server hook (scripts/eternal-skald-server.mjs) forwards every chat
 *  request to the upstream LLM. Previously each forward()/forwardStream()
 *  call used Node's default global agent (keepAlive=false), paying a fresh
 *  TCP/TLS handshake (~50-150ms) per request. P0 adds module-scoped
 *  keep-alive http/https Agents and wires them into both forwarders.
 *
 *  This file has two halves:
 *    [A] Source-text guards over eternal-skald-server.mjs asserting the
 *        agents exist and are wired into BOTH upstream opts blocks. The hook
 *        patches http on import, so (per the suite's convention, see
 *        direct-llm-fallback.test.mjs) we assert on the source text.
 *    [B] A behavioural proof that a keepAlive Agent actually reuses one
 *        socket across sequential requests — the latency win we are buying.
 *
 *  Run: node test/keepalive-agent.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRV_PATH = join(__dirname, "..", "scripts", "eternal-skald-server.mjs");
const SRC = readFileSync(SRV_PATH, "utf8");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }

console.log("HTTP keep-alive forwarder test (P0 latency)\n");

/* ── [A] Source-text guards ──────────────────────────────────────── */
ok(/new\s+http\.Agent\s*\(\s*KEEPALIVE_OPTS\s*\)/.test(SRC),
   "[A1] an http.Agent is constructed from KEEPALIVE_OPTS");
ok(/new\s+https\.Agent\s*\(\s*KEEPALIVE_OPTS\s*\)/.test(SRC),
   "[A2] an https.Agent is constructed from KEEPALIVE_OPTS");
ok(/keepAlive:\s*true/.test(SRC),
   "[A3] keep-alive is enabled on the shared agent options");
ok(/agentFor\s*=\s*\(url\)\s*=>/.test(SRC),
   "[A4] agentFor(url) selects the protocol-appropriate agent");
// Both upstream forwarders (buffered forward + forwardStream) must pass the agent.
const agentWired = SRC.match(/agent:\s*agentFor\(url\)/g) || [];
ok(agentWired.length >= 2,
   `[A5] both forwarder opts blocks set agent: agentFor(url) (found ${agentWired.length}, want >= 2)`);

/* ── [B] Behavioural: keepAlive reuses one socket ────────────────── */
async function behavioural() {
  const seen = new Set();
  const server = http.createServer((req, res) => {
    seen.add(req.socket); // track distinct underlying sockets
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

  const once = () => new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/", agent }, (res) => {
      res.on("data", () => {});
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end();
  });

  await once();
  await once();
  await once();

  ok(seen.size === 1,
     `[B1] keepAlive reuses a single socket across 3 sequential requests (distinct sockets: ${seen.size}, want 1)`);

  agent.destroy();
  await new Promise((r) => server.close(r));
}

await behavioural();

/* --------------------------------------------------------------------- */
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
