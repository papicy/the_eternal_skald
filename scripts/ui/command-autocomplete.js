/* =====================================================================
 *  THE ETERNAL SKALD — Inline Command Autocomplete  (U5)
 *  ---------------------------------------------------------------------
 *  When the user types "!" in the Foundry chat input, a floating dropdown
 *  of matching commands appears (token + one-line help), filtered live as
 *  they type. Arrow keys move the selection; Enter/Tab inserts the chosen
 *  command token; Escape dismisses. Built from COMMAND_REGISTRY — the same
 *  single source of truth as docs/COMMANDS.md and the !commands window.
 *
 *  UI LAYER NOTE (brief §5): presentation only. It never dispatches a
 *  command — selecting an item merely rewrites the chat-input text to the
 *  command token (plus a trailing space) and lets the user finish typing
 *  and press Enter as normal. No AI calls, no Foundry writes.
 *
 *  The pure matching helpers are unit-tested; the DOM/listener wiring is
 *  defensive and degrades to a no-op if the chat input cannot be found.
 * ===================================================================== */

import { COMMAND_REGISTRY } from "../chat/command-registry.js";
import { LOG_PREFIX } from "../core/constants.js";

const MAX_ITEMS = 8;

/**
 * PURE: extract the bare command token currently being typed, or null when
 * autocomplete should NOT show (not a "!"-message, or already past the token
 * because a space was typed).
 * @param {string} text
 * @returns {string|null} the lower-cased partial token incl. leading "!", or null
 */
export function autocompleteQuery(text) {
  if (typeof text !== "string") return null;
  if (!text.startsWith("!")) return null;
  if (/\s/.test(text)) return null;        // a space means the command is chosen
  return text.toLowerCase();
}

/**
 * PURE: commands whose token or an alias starts with the typed partial.
 * @param {string} text         current chat-input value
 * @param {object} [opts]
 * @param {boolean} [opts.includeGm=true]  include GM-only commands
 * @param {ReadonlyArray<object>} [opts.registry]
 * @returns {Array<{command:string, aliases:string[], permission:string, help:string}>}
 */
export function matchCommands(text, opts = {}) {
  const { includeGm = true, registry = COMMAND_REGISTRY } = opts;
  const q = autocompleteQuery(text);
  if (q === null) return [];
  const out = [];
  for (const d of (Array.isArray(registry) ? registry : [])) {
    const perm = d?.permission === "gm" ? "gm" : "all";
    if (perm === "gm" && !includeGm) continue;
    const tokens = [d?.command, ...(Array.isArray(d?.aliases) ? d.aliases : [])]
      .filter(Boolean).map((t) => String(t).toLowerCase());
    if (tokens.some((tok) => tok.startsWith(q))) {
      out.push({
        command: String(d.command),
        aliases: Array.isArray(d.aliases) ? d.aliases.map(String) : [],
        permission: perm,
        help: String(d?.help ?? "")
      });
    }
  }
  out.sort((a, b) => a.command.localeCompare(b.command));
  return out.slice(0, MAX_ITEMS);
}

/** Minimal HTML escaper. */
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

let _styleInjected = false;
function injectStyleOnce() {
  if (_styleInjected || typeof document === "undefined") return;
  const style = document.createElement("style");
  style.id = "eternal-skald-autocomplete-style";
  style.textContent = `
    .eternal-skald-autocomplete{position:absolute;z-index:1000;min-width:240px;max-width:420px;
      background:var(--color-bg,#1b1c22);color:var(--color-text-light-highlight,#f0f0e0);
      border:1px solid var(--color-border-dark,#000);border-radius:4px;box-shadow:0 4px 12px #0008;
      overflow:hidden;font-size:.9em;}
    .eternal-skald-autocomplete .es-ac-item{display:flex;gap:.5rem;align-items:baseline;
      padding:.25rem .5rem;cursor:pointer;white-space:nowrap;}
    .eternal-skald-autocomplete .es-ac-item.active,
    .eternal-skald-autocomplete .es-ac-item:hover{background:var(--color-control-bg-hover,#5d142b);}
    .eternal-skald-autocomplete .es-ac-cmd{font-weight:bold;}
    .eternal-skald-autocomplete .es-ac-gm{font-size:.7em;border:1px solid #0006;border-radius:3px;padding:0 .2rem;opacity:.8;}
    .eternal-skald-autocomplete .es-ac-help{opacity:.75;overflow:hidden;text-overflow:ellipsis;}
  `;
  try { document.head.appendChild(style); _styleInjected = true; } catch (_) {}
}

/** Attach the autocomplete behaviour to a chat-input <textarea>. Idempotent. */
export function attachAutocomplete(input) {
  if (!input || input.dataset?.esAutocomplete === "1") return false;
  try { input.dataset.esAutocomplete = "1"; } catch (_) { return false; }
  injectStyleOnce();

  let box = null;
  let items = [];
  let active = -1;

  const close = () => {
    if (box) { try { box.remove(); } catch (_) {} box = null; }
    items = []; active = -1;
  };

  const accept = (i) => {
    const chosen = items[i];
    if (!chosen) return;
    input.value = `${chosen.command} `;
    close();
    try { input.focus(); } catch (_) {}
  };

  const render = () => {
    if (!box) {
      box = document.createElement("div");
      box.className = "eternal-skald-autocomplete";
      document.body.appendChild(box);
    }
    box.innerHTML = items.map((c, i) => {
      const gm = c.permission === "gm" ? `<span class="es-ac-gm">GM</span>` : "";
      return `<div class="es-ac-item ${i === active ? "active" : ""}" data-i="${i}">
        <span class="es-ac-cmd">${esc(c.command)}</span>${gm}
        <span class="es-ac-help">${esc(c.help)}</span></div>`;
    }).join("");
    // Position just above the input.
    try {
      const r = input.getBoundingClientRect();
      box.style.left = `${Math.round(r.left)}px`;
      box.style.width = `${Math.round(r.width)}px`;
      box.style.top = `${Math.round(r.top - box.offsetHeight - 4)}px`;
    } catch (_) {}
    box.querySelectorAll(".es-ac-item").forEach((el) => {
      el.addEventListener("mousedown", (ev) => { ev.preventDefault(); accept(Number(el.dataset.i)); });
    });
  };

  const refresh = () => {
    const includeGm = (typeof game !== "undefined") ? !!game.user?.isGM : true;
    items = matchCommands(input.value, { includeGm });
    if (!items.length) { close(); return; }
    active = 0;
    render();
  };

  input.addEventListener("input", refresh);
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", (ev) => {
    if (!box || !items.length) return;
    if (ev.key === "ArrowDown") { ev.preventDefault(); active = (active + 1) % items.length; render(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
    else if (ev.key === "Enter" || ev.key === "Tab") { ev.preventDefault(); ev.stopPropagation(); accept(active); }
    else if (ev.key === "Escape") { ev.preventDefault(); close(); }
  });
  return true;
}

/** Find the Foundry chat input within a root (or the document) and attach. */
export function installChatAutocomplete(root) {
  const selectors = ["textarea#chat-message", "#chat-message", "#chat-form textarea", "textarea[name='chat-message']"];
  let scope = root;
  // Foundry may hand us a jQuery object or a raw element.
  if (scope && scope[0] && typeof scope[0] === "object") scope = scope[0];
  if (!scope || typeof scope.querySelector !== "function") scope = (typeof document !== "undefined") ? document : null;
  if (!scope) return false;
  for (const sel of selectors) {
    const el = scope.querySelector(sel);
    if (el) { try { return attachAutocomplete(el); } catch (e) { console.warn(LOG_PREFIX, "autocomplete attach failed:", e?.message ?? e); return false; } }
  }
  return false;
}
