/* =====================================================================
 *  THE ETERNAL SKALD — Interactive Command Reference  (Doc1 / U1)
 *  ---------------------------------------------------------------------
 *  A searchable, filterable in-game window listing every "!"-command. It
 *  is the visual counterpart to docs/COMMANDS.md and is built from the
 *  SAME single source of truth — COMMAND_REGISTRY (chat/command-registry.js)
 *  — so it can never drift out of date.
 *
 *  UI LAYER NOTE (brief §5): this module lives in the new scripts/ui/ layer
 *  and owns presentation only. It performs NO Foundry writes, no AI calls,
 *  and no command dispatch — "Try it" merely pre-fills the chat input. The
 *  command is wired in chat/commands.js (the chat layer) exactly like every
 *  other handler.
 *
 *  ApplicationV2 (U1): the window is built on
 *  `foundry.applications.api.ApplicationV2` with a manual render (no
 *  Handlebars template files, matching the repo's inline-HTML convention).
 *  The class is defined LAZILY inside a factory so that importing this file
 *  under plain Node (the load-smoke test) never evaluates
 *  `extends foundry…` when the Foundry global is absent.
 * ===================================================================== */

import { COMMAND_REGISTRY } from "../chat/command-registry.js";
import { LOG_PREFIX, SKALD_NAME } from "../core/constants.js";

/** Minimal HTML escaper (the registry text is author-controlled, but escape
 *  defensively so a future entry with `<`/`&` can never break the markup). */
export function escapeRefHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * PURE: normalise COMMAND_REGISTRY into display rows, sorted by command.
 * @param {ReadonlyArray<object>} [registry]
 * @returns {Array<{command:string, aliases:string[], permission:string, help:string}>}
 */
export function buildCommandEntries(registry = COMMAND_REGISTRY) {
  const rows = (Array.isArray(registry) ? registry : []).map((d) => ({
    command:    String(d?.command ?? ""),
    aliases:    Array.isArray(d?.aliases) ? d.aliases.map(String) : [],
    permission: d?.permission === "gm" ? "gm" : "all",
    help:       String(d?.help ?? "")
  })).filter((r) => r.command);
  rows.sort((a, b) => a.command.localeCompare(b.command));
  return rows;
}

/**
 * PURE: filter entries by a free-text query (matches command, aliases, help).
 * @param {Array<object>} entries
 * @param {string} query
 */
export function filterCommandEntries(entries, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) =>
    e.command.toLowerCase().includes(q)
    || e.help.toLowerCase().includes(q)
    || e.aliases.some((a) => a.toLowerCase().includes(q))
  );
}

/** PURE: render one entry to a list-row string. */
function rowHtml(e) {
  const aliases = e.aliases.length
    ? ` <span class="es-cmd-aliases">(${e.aliases.map(escapeRefHtml).join(", ")})</span>`
    : "";
  const badge = e.permission === "gm"
    ? ` <span class="es-cmd-badge es-cmd-gm">GM</span>`
    : "";
  return `<li class="es-cmd-row" data-command="${escapeRefHtml(e.command)}" data-text="${escapeRefHtml((e.command + " " + e.aliases.join(" ") + " " + e.help).toLowerCase())}">
    <div class="es-cmd-head"><code class="es-cmd-token">${escapeRefHtml(e.command)}</code>${aliases}${badge}
      <button type="button" class="es-cmd-try" data-command="${escapeRefHtml(e.command)}" title="Pre-fill the chat input"><i class="fas fa-pen"></i> Try it</button>
    </div>
    <div class="es-cmd-help">${escapeRefHtml(e.help)}</div>
  </li>`;
}

/** PURE: render the full window body (search box + list). */
export function renderReferenceHtml(entries) {
  const list = entries.map(rowHtml).join("\n");
  return `<style>
    .eternal-skald-command-reference{display:flex;flex-direction:column;height:100%;gap:.5rem;padding:.5rem;}
    .eternal-skald-command-reference .es-cmd-search{width:100%;box-sizing:border-box;}
    .eternal-skald-command-reference .es-cmd-list{list-style:none;margin:0;padding:0;overflow:auto;flex:1;}
    .eternal-skald-command-reference .es-cmd-row{padding:.4rem .25rem;border-bottom:1px solid var(--color-border-light-tertiary,#0002);}
    .eternal-skald-command-reference .es-cmd-head{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;}
    .eternal-skald-command-reference .es-cmd-token{font-weight:bold;}
    .eternal-skald-command-reference .es-cmd-aliases{opacity:.7;font-size:.85em;}
    .eternal-skald-command-reference .es-cmd-badge{font-size:.7em;border:1px solid #0004;border-radius:3px;padding:0 .25rem;}
    .eternal-skald-command-reference .es-cmd-gm{background:#7a2;color:#fff;border-color:#5a1;}
    .eternal-skald-command-reference .es-cmd-try{margin-left:auto;font-size:.8em;padding:0 .4rem;cursor:pointer;}
    .eternal-skald-command-reference .es-cmd-help{font-size:.9em;opacity:.85;margin-top:.15rem;}
    .eternal-skald-command-reference .es-cmd-empty{padding:1rem;text-align:center;opacity:.7;}
  </style>
  <input type="search" class="es-cmd-search" placeholder="Filter commands… (e.g. journal, oracle, gm)" autocomplete="off" />
  <ul class="es-cmd-list">${list}</ul>
  <div class="es-cmd-empty" style="display:none;">No commands match your filter.</div>`;
}

/** Pre-fill the Foundry chat input with a command token (no dispatch). */
export function prefillChatInput(text) {
  const selectors = ["#chat-message", "textarea#chat-message", "#chat-form textarea", "textarea[name='chat-message']"];
  for (const sel of selectors) {
    const el = (typeof document !== "undefined") ? document.querySelector(sel) : null;
    if (el) {
      el.value = `${text} `;
      try { el.focus(); } catch (_) {}
      return true;
    }
  }
  try { ui?.notifications?.warn(`${SKALD_NAME}: could not find the chat input.`); } catch (_) {}
  return false;
}

/** Wire the live search filter + "Try it" buttons inside a rendered root. */
function wireReference(root) {
  if (!root || typeof root.querySelector !== "function") return;
  const search = root.querySelector(".es-cmd-search");
  const rows = Array.from(root.querySelectorAll(".es-cmd-row"));
  const empty = root.querySelector(".es-cmd-empty");
  const applyFilter = () => {
    const q = String(search?.value ?? "").trim().toLowerCase();
    let shown = 0;
    for (const li of rows) {
      const hit = !q || (li.dataset.text || "").includes(q);
      li.style.display = hit ? "" : "none";
      if (hit) shown++;
    }
    if (empty) empty.style.display = shown ? "none" : "";
  };
  search?.addEventListener("input", applyFilter);
  root.addEventListener("click", (ev) => {
    const btn = ev.target?.closest?.(".es-cmd-try");
    if (!btn) return;
    ev.preventDefault();
    prefillChatInput(btn.dataset.command || "");
  });
}

/* --- Lazy ApplicationV2 subclass ----------------------------------- */
let _RefAppClass = null;

function getReferenceAppClass() {
  if (_RefAppClass) return _RefAppClass;
  const AppV2 = foundry?.applications?.api?.ApplicationV2;
  if (!AppV2) return null;
  _RefAppClass = class SkaldCommandReference extends AppV2 {
    static DEFAULT_OPTIONS = {
      id: "eternal-skald-command-reference",
      tag: "div",
      window: { title: "The Eternal Skald — Commands", icon: "fas fa-scroll", resizable: true },
      position: { width: 560, height: 640 }
    };
    async _renderHTML(_context, _options) {
      const el = document.createElement("div");
      el.className = "eternal-skald-command-reference";
      el.innerHTML = renderReferenceHtml(buildCommandEntries());
      return el;
    }
    _replaceHTML(result, content, _options) {
      content.replaceChildren(result);
    }
    _onRender(_context, _options) {
      try { wireReference(this.element); } catch (e) {
        console.warn(LOG_PREFIX, "command-reference wiring failed:", e?.message ?? e);
      }
    }
  };
  return _RefAppClass;
}

/**
 * Open the interactive command reference window. Returns true if shown.
 * Falls back gracefully (returns false) when ApplicationV2 is unavailable —
 * the caller (commands.js) then posts the classic !skald-help card instead.
 */
export function openCommandReference() {
  const Cls = getReferenceAppClass();
  if (!Cls) return false;
  try {
    new Cls().render(true);
    return true;
  } catch (e) {
    console.warn(LOG_PREFIX, "openCommandReference failed:", e?.message ?? e);
    return false;
  }
}
