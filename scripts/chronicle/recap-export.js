/* =====================================================================
 *  Recap export helper for The Eternal Skald (v0.20.0, F3).
 *
 *  Turns an AI-authored session recap into a clean, portable Markdown
 *  document and hands it to the browser as a download. The Markdown
 *  assembly is a pure function (buildMarkdown) so it is unit-testable
 *  without a Foundry runtime; only download() touches the environment.
 *
 *  Optional Obsidian.md flavour (opt-in via the `recapObsidianFormat`
 *  world setting) prepends YAML frontmatter and appends a "Linked
 *  Entities" section of [[wikilinks]] for the chronicle figures/places
 *  referenced — without rewriting the AI prose (which would be fragile).
 *
 *  Pure ESM, no build step, no dependencies.
 * ===================================================================== */

import { MODULE_ID } from "../core/constants.js";

export const RecapExport = {
  /** Is the Obsidian-flavoured export enabled? (opt-in, default off) */
  obsidianEnabled() {
    try { return game.settings.get(MODULE_ID, "recapObsidianFormat") === true; }
    catch (_) { return false; }
  },

  /** A filesystem-safe slug for the download filename. */
  slugify(title) {
    const base = String(title ?? "session-recap")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return base || "session-recap";
  },

  /**
   * Assemble the final Markdown document. Pure + defensive.
   *
   * @param {object} opts
   * @param {string}   opts.title          Document heading.
   * @param {string}   opts.body            The recap prose (Markdown).
   * @param {string[]} [opts.entities]      Names to surface as wikilinks (Obsidian).
   * @param {Date}     [opts.date]          Timestamp (defaults to now).
   * @param {boolean}  [opts.obsidian]      Emit YAML frontmatter + wikilinks.
   * @returns {string}
   */
  buildMarkdown({ title, body, entities = [], date = new Date(), obsidian = false } = {}) {
    const safeTitle = String(title || "Session Recap").trim();
    const iso = (date instanceof Date && !isNaN(date) ? date : new Date()).toISOString().slice(0, 10);
    const prose = String(body || "").trim() || "_No events were recorded for this session._";
    const names = Array.isArray(entities)
      ? [...new Set(entities.map(n => String(n || "").trim()).filter(Boolean))]
      : [];

    const out = [];
    if (obsidian) {
      out.push("---");
      out.push(`title: "${safeTitle.replace(/"/g, "'")}"`);
      out.push(`date: ${iso}`);
      out.push("tags: [eternal-skald, session-recap]");
      out.push("---");
      out.push("");
    }
    out.push(`# ${safeTitle}`);
    out.push("");
    out.push(`*Chronicled ${iso} by the Eternal Skald.*`);
    out.push("");
    out.push(prose);
    if (obsidian && names.length) {
      out.push("");
      out.push("## Linked Entities");
      out.push("");
      out.push(names.map(n => `- [[${n}]]`).join("\n"));
    }
    out.push("");
    return out.join("\n");
  },

  /**
   * Trigger a browser download of the given Markdown text. Uses Foundry's
   * global saveDataToFile when present, else falls back to a Blob anchor.
   * Returns true if a download was initiated.
   *
   * @param {string} markdown
   * @param {string} filename  (without extension)
   * @returns {boolean}
   */
  download(markdown, filename) {
    const data = String(markdown ?? "");
    const name = `${this.slugify(filename)}.md`;
    try {
      if (typeof saveDataToFile === "function") {
        saveDataToFile(data, "text/markdown", name);
        return true;
      }
    } catch (_) {}
    try {
      const blob = new Blob([data], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      return true;
    } catch (_) { return false; }
  }
};
