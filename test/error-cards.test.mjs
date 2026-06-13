/* =====================================================================
 *  Error-cards-to-chat regression test for The Eternal Skald (H3).
 *
 *  Goal: AI / API / command failures should surface as a persistent,
 *  GM-whispered ERROR card (Chat.postError) instead of dying silently in
 *  the console. This guards:
 *    • the postError utility in scripts/chat/display.js (variant, GM-whisper
 *      default, HTML-escaping, fail-soft contract);
 *    • the central command dispatcher wiring in scripts/chat/commands.js;
 *    • the .es-variant-error styling in styles/eternal-skald.css.
 *
 *  Follows the project's "source-text structural guards + a behavioural
 *  model" convention (see streaming-autoscroll.test.mjs), because importing
 *  display.js at runtime pulls in the full Foundry-coupled module graph.
 *
 *  Run: node test/error-cards.test.mjs
 * ===================================================================== */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readSkaldSource } from "./_skald-source.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SRC = readSkaldSource();
const CSS = readFileSync(join(ROOT, "styles", "eternal-skald.css"), "utf8");

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", msg); } }
function eq(a, b, msg) { ok(a === b, `${msg} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }

console.log("Error-cards-to-chat test\n");

/* --------------------------------------------------------------------- *
 * [1] The postError utility exists and posts an ERROR-variant card.
 * --------------------------------------------------------------------- */
ok(/async\s+postError\s*\(/.test(SRC), "[1] Chat.postError is defined");
ok(/postError[\s\S]{0,400}variant:\s*["']error["']/.test(SRC),
   "[1] postError posts a variant: \"error\" card");

/* --------------------------------------------------------------------- *
 * [2] It whispers to GMs BY DEFAULT (opt out with gmWhisper:false).
 * --------------------------------------------------------------------- */
ok(/async\s+postError[\s\S]{0,700}gmWhisper:\s*opts\.gmWhisper\s*!==\s*false/.test(SRC),
   "[2] postError whispers to GMs by default");

/* --------------------------------------------------------------------- *
 * [3] User/error text is HTML-escaped (no injection from error messages).
 * --------------------------------------------------------------------- */
ok(/async\s+postError[\s\S]{0,700}escapeHtml\(headline\)/.test(SRC),
   "[3] the headline is escaped");
ok(/async\s+postError[\s\S]{0,700}escapeHtml\(opts\.detail\)/.test(SRC),
   "[3] the detail is escaped");

/* --------------------------------------------------------------------- *
 * [4] Fail-soft: postError is wrapped so it never throws into the caller.
 * --------------------------------------------------------------------- */
ok(/async\s+postError[\s\S]{0,700}try\s*\{[\s\S]*?catch[\s\S]*?return null/.test(SRC),
   "[4] postError is try/catch wrapped and returns null on failure");

/* --------------------------------------------------------------------- *
 * [5] The central command dispatcher surfaces failures via an error card.
 * --------------------------------------------------------------------- */
ok(/\.catch\(err =>[\s\S]{0,400}Chat\.postError\(/.test(SRC),
   "[5] the command dispatcher's catch posts Chat.postError");

/* --------------------------------------------------------------------- *
 * [6] The error-card variant is styled distinctly in the stylesheet.
 * --------------------------------------------------------------------- */
ok(/\.eternal-skald-card\.es-variant-error\s*\{/.test(CSS),
   "[6] .es-variant-error card styling exists");
ok(/\.es-error-hint/.test(CSS) && /\.es-error-detail/.test(CSS),
   "[6] error detail + hint sub-elements are styled");

/* --------------------------------------------------------------------- *
 * [7] Behavioural model: replicate postError's body builder exactly and
 *     verify the rendered HTML escapes injected markup and includes the
 *     headline, detail and hint in the expected wrappers.
 * --------------------------------------------------------------------- */
{
  // Mirror of escapeHtml in display.js.
  const escapeHtml = (str) => String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");

  // Mirror of postError's body construction.
  const buildBody = (headline, opts = {}) => {
    const detail = opts.detail
      ? `<p class="es-error-detail">${escapeHtml(opts.detail)}</p>` : "";
    const hint = opts.hint
      ? `<p class="es-error-hint">💡 ${escapeHtml(opts.hint)}</p>` : "";
    return `<p class="es-error"><strong>${escapeHtml(headline)}</strong></p>${detail}${hint}`;
  };

  const body = buildBody("AI call failed", {
    detail: "<script>alert(1)</script> 401 Unauthorized",
    hint: "Check your API Key."
  });

  ok(body.includes("<strong>AI call failed</strong>"), "[7] headline rendered");
  ok(body.includes("es-error-detail") && body.includes("401 Unauthorized"),
     "[7] detail rendered in its wrapper");
  ok(body.includes("es-error-hint") && body.includes("Check your API Key."),
     "[7] hint rendered in its wrapper");
  ok(!body.includes("<script>") && body.includes("&lt;script&gt;"),
     "[7] injected markup in the detail is escaped");

  // Detail/hint are omitted cleanly when not supplied.
  const bare = buildBody("Something broke");
  eq(bare, '<p class="es-error"><strong>Something broke</strong></p>',
     "[7] bare error renders headline only (no empty detail/hint nodes)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
