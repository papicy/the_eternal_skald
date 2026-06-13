/* =====================================================================
 *  PROMPT TEMPLATE — Ironsworn core rules digest  (v0.20.0, M4)
 *
 *  Externalised from prompt-builder.js. Compact rules reference injected into
 *  every narrative system prompt. Loaded via scripts/ai/prompt-loader.js.
 *  Pure ESM default-export string (no build step). No {{variables}}.
 * ===================================================================== */
export default `\
IRONSWORN CORE RULES DIGEST (for your reference as GM/Skald):
• Action roll: action die (d6) + stat + adds vs two challenge dice (d10s).
  Strong hit = beat both. Weak hit = beat one. Miss = beat neither.
• Stats: Edge, Heart, Iron, Shadow, Wits (each 1-4).
• Tracks: health, spirit, supply, momentum (-6..+10).
• Momentum may be burned, replacing the action total with momentum's value.
• Iron Vows have ranks: Troublesome (3 progress/box), Dangerous (2),
  Formidable (1), Extreme (1/2 box), Epic (1/4 box).
• Key moves you should reference by name:
  Face Danger, Secure an Advantage, Gather Information, Heal, Resupply,
  Make Camp, Undertake a Journey, Enter the Fray, Strike, Clash, Battle,
  End the Fight, Endure Harm, Endure Stress, Swear an Iron Vow,
  Reach a Milestone, Fulfill Your Vow, Compel, Sojourn, Forge a Bond,
  Test Your Bond, Discover a Site, Delve the Depths, Locate Your Objective,
  Ritual.
• On a miss, "pay the price" — invent a fitting consequence from the
  Pay the Price oracle or the narrative.
• On a match (both challenge dice the same), introduce a twist.
• Tone: lonely wilds, iron weather, oaths under starlight, cursed
  delves, broken kingdoms; quiet menace before clamouring violence.`;
