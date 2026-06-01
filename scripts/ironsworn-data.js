/* =====================================================================
 *  THE ETERNAL SKALD — Ironsworn Reference Data
 *  ---------------------------------------------------------------------
 *  This file exports a single frozen object containing the oracle tables,
 *  move references, asset categories, and terminology used by the module.
 *
 *  Oracle tables follow the standard Ironsworn 1d100 format. Each entry
 *  is a [min, max, result] tuple; lookups use the helper rollOracle().
 *
 *  All content paraphrased from the freely-licensed Ironsworn SRD
 *  (CC-BY 4.0, Shawn Tomkin). For full text, see the Ironsworn rulebook.
 * ===================================================================== */

/* ------------------------------------------------------------------ */
/*  ORACLE TABLES                                                      */
/* ------------------------------------------------------------------ */

const ACTION_ORACLE = [
  [1, 1, "Scheme"], [2, 2, "Clash"], [3, 3, "Weaken"], [4, 4, "Initiate"],
  [5, 5, "Create"], [6, 6, "Swear"], [7, 7, "Avenge"], [8, 8, "Guard"],
  [9, 9, "Defeat"], [10, 10, "Control"], [11, 11, "Break"], [12, 12, "Risk"],
  [13, 13, "Surrender"], [14, 14, "Inspect"], [15, 15, "Raid"], [16, 16, "Evade"],
  [17, 17, "Assault"], [18, 18, "Deflect"], [19, 19, "Threaten"], [20, 20, "Attack"],
  [21, 21, "Leave"], [22, 22, "Preserve"], [23, 23, "Manipulate"], [24, 24, "Remove"],
  [25, 25, "Eliminate"], [26, 26, "Withdraw"], [27, 27, "Abandon"], [28, 28, "Investigate"],
  [29, 29, "Hold"], [30, 30, "Focus"], [31, 31, "Uncover"], [32, 32, "Breach"],
  [33, 33, "Aid"], [34, 34, "Uphold"], [35, 35, "Falter"], [36, 36, "Suppress"],
  [37, 37, "Hunt"], [38, 38, "Share"], [39, 39, "Destroy"], [40, 40, "Avoid"],
  [41, 41, "Reject"], [42, 42, "Demand"], [43, 43, "Explore"], [44, 44, "Bolster"],
  [45, 45, "Seize"], [46, 46, "Mourn"], [47, 47, "Reveal"], [48, 48, "Gather"],
  [49, 49, "Defy"], [50, 50, "Transform"], [51, 51, "Persevere"], [52, 52, "Serve"],
  [53, 53, "Begin"], [54, 54, "Move"], [55, 55, "Coordinate"], [56, 56, "Resist"],
  [57, 57, "Await"], [58, 58, "Impress"], [59, 59, "Take"], [60, 60, "Oppose"],
  [61, 61, "Capture"], [62, 62, "Overwhelm"], [63, 63, "Challenge"], [64, 64, "Acquire"],
  [65, 65, "Protect"], [66, 66, "Finish"], [67, 67, "Strengthen"], [68, 68, "Restore"],
  [69, 69, "Advance"], [70, 70, "Command"], [71, 71, "Refuse"], [72, 72, "Find"],
  [73, 73, "Deliver"], [74, 74, "Hide"], [75, 75, "Fortify"], [76, 76, "Betray"],
  [77, 77, "Secure"], [78, 78, "Arrive"], [79, 79, "Affect"], [80, 80, "Change"],
  [81, 81, "Defend"], [82, 82, "Debate"], [83, 83, "Support"], [84, 84, "Follow"],
  [85, 85, "Construct"], [86, 86, "Locate"], [87, 87, "Endure"], [88, 88, "Release"],
  [89, 89, "Lose"], [90, 90, "Reduce"], [91, 91, "Escalate"], [92, 92, "Power"],
  [93, 93, "Suspect"], [94, 94, "Search"], [95, 95, "Communicate"], [96, 96, "Conceal"],
  [97, 97, "Travel"], [98, 98, "Journey"], [99, 99, "Rest"], [100, 100, "Risk"]
];

const THEME_ORACLE = [
  [1, 1, "Risk"], [2, 2, "Ability"], [3, 3, "Price"], [4, 4, "Ally"],
  [5, 5, "Battle"], [6, 6, "Safety"], [7, 7, "Survival"], [8, 8, "Weapon"],
  [9, 9, "Wound"], [10, 10, "Shelter"], [11, 11, "Leader"], [12, 12, "Fear"],
  [13, 13, "Time"], [14, 14, "Duty"], [15, 15, "Secret"], [16, 16, "Innocence"],
  [17, 17, "Renown"], [18, 18, "Direction"], [19, 19, "Death"], [20, 20, "Honor"],
  [21, 21, "Labor"], [22, 22, "Solution"], [23, 23, "Tool"], [24, 24, "Balance"],
  [25, 25, "Love"], [26, 26, "Barrier"], [27, 27, "Creation"], [28, 28, "Decay"],
  [29, 29, "Trade"], [30, 30, "Bond"], [31, 31, "Hope"], [32, 32, "Superstition"],
  [33, 33, "Peace"], [34, 34, "Deception"], [35, 35, "History"], [36, 36, "World"],
  [37, 37, "Vow"], [38, 38, "Protection"], [39, 39, "Nature"], [40, 40, "Opinion"],
  [41, 41, "Burden"], [42, 42, "Vengeance"], [43, 43, "Opportunity"], [44, 44, "Faction"],
  [45, 45, "Danger"], [46, 46, "Corruption"], [47, 47, "Freedom"], [48, 48, "Debt"],
  [49, 49, "Hate"], [50, 50, "Possession"], [51, 51, "Stranger"], [52, 52, "Passage"],
  [53, 53, "Land"], [54, 54, "Creature"], [55, 55, "Disease"], [56, 56, "Advantage"],
  [57, 57, "Blood"], [58, 58, "Language"], [59, 59, "Rumor"], [60, 60, "Weakness"],
  [61, 61, "Greed"], [62, 62, "Family"], [63, 63, "Resource"], [64, 64, "Structure"],
  [65, 65, "Dream"], [66, 66, "Community"], [67, 67, "War"], [68, 68, "Portent"],
  [69, 69, "Prize"], [70, 70, "Destiny"], [71, 71, "Momentum"], [72, 72, "Power"],
  [73, 73, "Memory"], [74, 74, "Ruin"], [75, 75, "Mysticism"], [76, 76, "Rival"],
  [77, 77, "Problem"], [78, 78, "Idea"], [79, 79, "Revenge"], [80, 80, "Health"],
  [81, 81, "Fellowship"], [82, 82, "Enemy"], [83, 83, "Religion"], [84, 84, "Spirit"],
  [85, 85, "Fame"], [86, 86, "Desolation"], [87, 87, "Strength"], [88, 88, "Knowledge"],
  [89, 89, "Truth"], [90, 90, "Quest"], [91, 91, "Pride"], [92, 92, "Loss"],
  [93, 93, "Suffering"], [94, 94, "Beast"], [95, 95, "Tyrant"], [96, 96, "Treachery"],
  [97, 97, "Fate"], [98, 98, "Trial"], [99, 99, "Path"], [100, 100, "Mystery"]
];

const REGION_ORACLE = [
  [1, 17, "Barrier Islands"],
  [18, 34, "Ragged Coast"],
  [35, 45, "Deep Wilds"],
  [46, 56, "Flooded Lands"],
  [57, 67, "Havens"],
  [68, 78, "Hinterlands"],
  [79, 84, "Tempest Hills"],
  [85, 89, "Veiled Mountains"],
  [90, 93, "Shattered Wastes"],
  [94, 97, "Horn of the Crescent Sea"],
  [98, 100, "Beyond the Reach (uncharted)"]
];

const LOCATION_ORACLE = [
  [1, 8, "Hideout or outpost"],
  [9, 16, "Steading or settlement"],
  [17, 22, "Battlefield (recent or ancient)"],
  [23, 28, "Cavern, tunnel, or pit"],
  [29, 34, "Ruin (delve-worthy)"],
  [35, 40, "Sacred grove or shrine"],
  [41, 46, "Crossing — bridge, ford, or pass"],
  [47, 52, "Lake, river, or coast"],
  [53, 58, "Marsh, fen, or bog"],
  [59, 64, "Hill or rocky tor"],
  [65, 70, "Forest or thicket"],
  [71, 76, "Mountain peak or cliff"],
  [77, 82, "Strange edifice — tower, monolith, or megalith"],
  [83, 88, "Lair of a beast or horror"],
  [89, 94, "Frozen waste or barren plain"],
  [95, 100, "Otherworldly site — touched by the mystic"]
];

const COASTAL_WATERS_ORACLE = [
  [1, 12, "Calm seas under a pale sun"],
  [13, 24, "Choppy waves and salt spray"],
  [25, 36, "Fog rolling in across the swell"],
  [37, 48, "Floating wreckage or driftwood"],
  [49, 60, "A distant sail or hostile ship"],
  [61, 72, "Sea-beast surfacing in the deep"],
  [73, 84, "Sudden squall and lashing rain"],
  [85, 94, "A reef of jagged stone breaks the surface"],
  [95, 100, "Strange lights beneath the waves"]
];

const NPC_ROLE_ORACLE = [
  [1, 6, "Adventurer or wanderer"],
  [7, 12, "Artisan or crafter"],
  [13, 18, "Bandit or outlaw"],
  [19, 24, "Bard or skald"],
  [25, 30, "Caravanner or trader"],
  [31, 36, "Champion or warrior"],
  [37, 42, "Criminal or thief"],
  [43, 48, "Cultist or fanatic"],
  [49, 54, "Elder or chief"],
  [55, 60, "Farmer or herder"],
  [61, 66, "Healer or apothecary"],
  [67, 72, "Hunter or trapper"],
  [73, 78, "Mystic or seer"],
  [79, 84, "Outcast or exile"],
  [85, 90, "Raider or reaver"],
  [91, 96, "Scholar or scribe"],
  [97, 100, "Stranger from afar"]
];

const NPC_GOAL_ORACLE = [
  [1, 7, "Obtain or trade a prize"],
  [8, 14, "Find a lost person or thing"],
  [15, 21, "Take revenge on an enemy"],
  [22, 28, "Defend the helpless"],
  [29, 35, "Win the favor of a power"],
  [36, 42, "Escape a binding obligation"],
  [43, 49, "Uncover a hidden truth"],
  [50, 56, "Spread their faith or cause"],
  [57, 63, "Survive the coming hardship"],
  [64, 70, "Acquire power or station"],
  [71, 77, "Make amends for past wrongs"],
  [78, 84, "Protect kin or fellowship"],
  [85, 91, "Profit at the expense of others"],
  [92, 100, "Pursue a personal vow"]
];

const NPC_DESCRIPTOR_ORACLE = [
  [1, 5, "Stern"], [6, 10, "Curious"], [11, 15, "Cautious"], [16, 20, "Bold"],
  [21, 25, "Cruel"], [26, 30, "Kind"], [31, 35, "Greedy"], [36, 40, "Generous"],
  [41, 45, "Brooding"], [46, 50, "Loyal"], [51, 55, "Treacherous"], [56, 60, "Cunning"],
  [61, 65, "Honorable"], [66, 70, "Reckless"], [71, 75, "Wise"], [76, 80, "Foolhardy"],
  [81, 85, "Haunted"], [86, 90, "Pious"], [91, 95, "Worldly"], [96, 100, "Mysterious"]
];

const COMBAT_ACTION_ORACLE = [
  [1, 10, "Press the attack with overwhelming force"],
  [11, 20, "Strike from cover or surprise"],
  [21, 30, "Defend an ally or fall back to cover"],
  [31, 40, "Withdraw and reposition"],
  [41, 50, "Use a weapon or ability of unusual reach"],
  [51, 60, "Target the most vulnerable foe"],
  [61, 70, "Attempt to disarm or disable"],
  [71, 80, "Call for aid or signal reinforcements"],
  [81, 90, "Sacrifice position for a powerful blow"],
  [91, 100, "Do the unexpected — improvise"]
];

const MYSTIC_BACKLASH_ORACLE = [
  [1, 15, "You suffer harm — physical recoil from the ritual"],
  [16, 30, "You are shaken — endure stress as the spirits resist"],
  [31, 45, "Your gear is fouled — a tool or weapon is broken"],
  [46, 60, "A bond is strained — an ally suffers in your place"],
  [61, 75, "Unwanted attention — something hears your working"],
  [76, 90, "The cost is delayed — pay it later, with interest"],
  [91, 100, "The ritual takes — but binds you to a new vow"]
];

const PAY_THE_PRICE_ORACLE = [
  [1, 5, "Roll twice more on this table; both results apply"],
  [6, 15, "It inflicts harm"],
  [16, 25, "It inflicts stress"],
  [26, 35, "You face a new danger"],
  [36, 45, "You lose advantage"],
  [46, 55, "A friend, companion, or ally is put in harm's way"],
  [56, 65, "Something of value is lost or destroyed"],
  [66, 75, "An objective is no longer in reach"],
  [76, 85, "You are separated from something or someone"],
  [86, 95, "Your action has an unintended effect"],
  [96, 100, "It is a grave cost — Skald, choose or invent"]
];

/* ------------------------------------------------------------------ */
/*  MOVE REFERENCES                                                    */
/* ------------------------------------------------------------------ */

const MOVES = {
  // Adventure moves
  "Face Danger": {
    category: "Adventure",
    stat: "Edge / Heart / Iron / Shadow / Wits",
    summary: "When you attempt something risky or react to an imminent threat, roll +the most appropriate stat. Strong hit: you do it. Weak hit: you succeed at a cost. Miss: pay the price."
  },
  "Secure an Advantage": {
    category: "Adventure",
    stat: "Edge / Heart / Iron / Shadow / Wits",
    summary: "When you assess, gather info, or prepare for action, roll +stat. Strong hit: take +2 momentum. Weak hit: take +1. Miss: the situation worsens."
  },
  "Gather Information": {
    category: "Adventure",
    stat: "Wits",
    summary: "When you search a place, study a situation, or interrogate, roll +wits. Strong hit: gain insight and +2 momentum. Weak hit: insight at a cost. Miss: pay the price."
  },
  "Heal": {
    category: "Adventure",
    stat: "Iron / Wits",
    summary: "When you treat injuries, roll +iron or +wits (whichever is lower). Strong hit: restore +health. Weak hit: a complication. Miss: condition worsens."
  },
  "Resupply": {
    category: "Adventure",
    stat: "Wits",
    summary: "When you forage, scavenge, or hunt, roll +wits. Strong hit: restore +supply. Weak hit: hunt was hard. Miss: pay the price."
  },
  "Make Camp": {
    category: "Adventure",
    stat: "—",
    summary: "When you rest at a fire, choose two: recuperate, partake, relax, prepare, plan. Each option has its own roll or effect."
  },
  "Undertake a Journey": {
    category: "Adventure",
    stat: "Wits",
    summary: "When you travel through hostile or unfamiliar lands, set the rank, then roll +wits at waypoints. Strong hit: mark progress. Weak hit: mark progress, pay a cost. Miss: trouble ahead."
  },

  // Combat moves
  "Enter the Fray": {
    category: "Combat",
    stat: "Heart / Shadow / Wits",
    summary: "When you initiate combat or are forced into it, roll +stat. Strong hit: take initiative, gain momentum. Weak hit: choose: initiative OR momentum. Miss: react under threat — no initiative."
  },
  "Strike": {
    category: "Combat",
    stat: "Iron / Edge",
    summary: "When you have initiative and attack in close combat (iron) or at range (edge), roll. Strong hit: inflict harm, keep initiative. Weak hit: harm, but lose initiative. Miss: pay the price, lose initiative."
  },
  "Clash": {
    category: "Combat",
    stat: "Iron / Edge",
    summary: "When you don't have initiative and you fight back, roll +iron or +edge. Strong hit: inflict harm AND take initiative. Weak hit: trade blows, harm on both sides. Miss: foe presses, pay the price."
  },
  "Battle": {
    category: "Combat",
    stat: "Edge / Heart / Iron / Shadow / Wits",
    summary: "When you fight a battle and let the dice decide the outcome, roll +stat reflecting your approach. Strong hit: prevail and choose a boon. Weak hit: prevail at cost. Miss: it ends badly."
  },
  "Endure Harm": {
    category: "Suffer",
    stat: "Iron",
    summary: "When you suffer physical harm, suffer -health equal to harm. Then, if -health or below 0, roll +health. Strong hit: shake it off. Weak hit: press on, +1 momentum. Miss: face a worse fate."
  },
  "Endure Stress": {
    category: "Suffer",
    stat: "Heart",
    summary: "When you face mental anguish, suffer -spirit. If 0 or below, roll +spirit. Strong hit: shake it off. Weak hit: press on. Miss: face a worse fate."
  },
  "Companion Endure Harm": {
    category: "Suffer",
    stat: "Heart",
    summary: "When a companion suffers harm, suffer -health on the companion. If 0, roll +heart to see if they survive."
  },

  // Quest moves
  "Swear an Iron Vow": {
    category: "Quest",
    stat: "Heart",
    summary: "When you commit to a quest, roll +heart. Strong hit: bolstered, +2 momentum. Weak hit: it weighs heavy, +1 momentum. Miss: doubts assail you."
  },
  "Reach a Milestone": {
    category: "Quest",
    stat: "—",
    summary: "When you make significant progress on a quest, mark progress on its track."
  },
  "Fulfill Your Vow": {
    category: "Quest",
    stat: "—",
    summary: "When you complete a vow, roll progress. Match against challenge dice. Strong hit: completed. Weak hit: complete, but unforeseen consequence. Miss: betrayal or failure."
  },
  "Forsake Your Vow": {
    category: "Quest",
    stat: "—",
    summary: "When you abandon a vow, suffer -spirit and -momentum equal to its rank. The Skald may impose lasting consequence."
  },

  // Connection / fellowship
  "Compel": {
    category: "Connection",
    stat: "Heart / Iron / Shadow",
    summary: "When you try to influence an NPC, roll +stat (heart=charm, iron=force, shadow=lie). Strong hit: they comply. Weak hit: at a cost. Miss: it backfires."
  },
  "Sojourn": {
    category: "Connection",
    stat: "Heart",
    summary: "When you spend time in a community, roll +heart. Strong hit: choose multiple recoveries. Weak hit: choose fewer. Miss: trouble in the haven."
  },
  "Forge a Bond": {
    category: "Connection",
    stat: "Heart",
    summary: "When you build a lasting bond, roll +heart. Strong hit: bond is forged. Weak hit: a complication. Miss: misplaced trust."
  },
  "Test Your Bond": {
    category: "Connection",
    stat: "Heart",
    summary: "When the bond is tested, roll +heart. Strong hit: confirmed. Weak hit: shaken. Miss: bond is broken."
  },

  // Delve / site moves
  "Discover a Site": {
    category: "Delve",
    stat: "—",
    summary: "When you find an undertaking site, set a rank and theme/domain. Begin a progress track."
  },
  "Delve the Depths": {
    category: "Delve",
    stat: "Edge / Shadow / Wits",
    summary: "When you delve a site, choose an approach and roll. Strong hit: progress + discover an opportunity. Weak hit: progress, pay a price. Miss: dangerous setback."
  },
  "Locate Your Objective": {
    category: "Delve",
    stat: "Wits",
    summary: "When you seek the site's objective, roll progress vs. challenge dice. Outcome guides discovery."
  },
  "Escape the Depths": {
    category: "Delve",
    stat: "Edge / Shadow / Wits",
    summary: "When you flee a delve site, roll progress vs. challenge. Outcome decides what you carry out."
  },

  // Mystic
  "Face a Setback": {
    category: "Suffer",
    stat: "Heart / Iron / Shadow / Wits",
    summary: "When you face a setback that threatens your progress, suffer -progress as the situation dictates."
  },
  "Ritual": {
    category: "Mystic",
    stat: "Wits",
    summary: "When you draw on the unseen, set a rank and roll +wits. Strong hit: ritual succeeds. Weak hit: success at a cost — risk mystic backlash. Miss: backlash."
  }
};

/* ------------------------------------------------------------------ */
/*  ASSET CATEGORIES                                                   */
/* ------------------------------------------------------------------ */

const ASSET_CATEGORIES = {
  "Companion": "A loyal ally — animal, hireling, or kindred — who fights and travels with you. Has its own health track.",
  "Path": "A vocational identity — Skald, Sword-Master, Wayfinder, Veteran — granting unique moves and narrative reach.",
  "Combat Talent": "A combat-focused ability — Shield-Bearer, Berserker, Archer, Brawler — that reshapes how you fight.",
  "Ritual": "An esoteric ritual — Communion, Bind, Foresight — used through the Ritual move with mystical backlash.",
  "Delve Talent (Ironsworn: Delve)": "A delve-focused ability — Cartographer, Spelunker, Tomb-Touched — useful within undertaking sites.",
  "Cursed (Ironsworn: Delve)": "A dark legacy — Cursed By the Pale, Doomed, Bound to a Spirit — that grants power at a terrible cost."
};

/* ------------------------------------------------------------------ */
/*  TERMINOLOGY                                                        */
/* ------------------------------------------------------------------ */

const TERMINOLOGY = {
  "Iron Vow": "A solemn, named commitment. Each vow has a rank (Troublesome, Dangerous, Formidable, Extreme, Epic) and its own progress track.",
  "Momentum": "Narrative resource (-6 to +10) representing your favor with fate. Can be 'burned' by replacing an action die with momentum's value on rolls.",
  "Harm": "Physical damage. Reduces health track. Suffer the Endure Harm move when it strikes.",
  "Stress": "Mental damage. Reduces spirit track. Suffer the Endure Stress move.",
  "Supply": "Material resources for travel and combat (0-5). Lost on miss results during journeys and resupply.",
  "Progress Track": "A 10-box track filled in increments based on rank. Used for vows, journeys, fights, and delves.",
  "Challenge Dice": "Two d10s rolled against your progress or action die total. Compared individually for strong/weak/miss.",
  "Action Die": "A d6 added to a relevant stat. Compared against the two challenge dice.",
  "Strong Hit": "Action total beats both challenge dice — best outcome.",
  "Weak Hit": "Action total beats one challenge die — success with a cost.",
  "Miss": "Action total beats neither challenge die — pay the price.",
  "Match": "When both challenge dice show the same value — Skald introduces a twist or critical outcome.",
  "Rank": "Difficulty tier: Troublesome (3 progress/box), Dangerous (2), Formidable (1), Extreme (1/2), Epic (1/4)."
};

/* ------------------------------------------------------------------ */
/*  HELPERS                                                            */
/* ------------------------------------------------------------------ */

/**
 * Roll a 1d100 result against an oracle table.
 * @param {Array} table - array of [min, max, result] tuples
 * @param {number} [forcedRoll] - optional fixed roll for testing
 * @returns {{roll: number, result: string}}
 */
function rollOracle(table, forcedRoll = null) {
  const r = forcedRoll ?? (Math.floor(Math.random() * 100) + 1);
  const entry = table.find(([min, max]) => r >= min && r <= max);
  return { roll: r, result: entry ? entry[2] : "—" };
}

/* ------------------------------------------------------------------ */
/*  EXPORT                                                             */
/* ------------------------------------------------------------------ */

export const IronswornData = Object.freeze({
  oracles: Object.freeze({
    action: ACTION_ORACLE,
    theme: THEME_ORACLE,
    region: REGION_ORACLE,
    location: LOCATION_ORACLE,
    coastal: COASTAL_WATERS_ORACLE,
    npcRole: NPC_ROLE_ORACLE,
    npcGoal: NPC_GOAL_ORACLE,
    npcDescriptor: NPC_DESCRIPTOR_ORACLE,
    combatAction: COMBAT_ACTION_ORACLE,
    mysticBacklash: MYSTIC_BACKLASH_ORACLE,
    payThePrice: PAY_THE_PRICE_ORACLE
  }),

  /** Lookup by lowercase alias to support /oracle <name> commands. */
  oracleAliases: Object.freeze({
    "action": "action",
    "act": "action",
    "theme": "theme",
    "region": "region",
    "location": "location",
    "place": "location",
    "coastal": "coastal",
    "coastal-waters": "coastal",
    "sea": "coastal",
    "npc": "npcRole",
    "npc-role": "npcRole",
    "role": "npcRole",
    "npc-goal": "npcGoal",
    "goal": "npcGoal",
    "npc-descriptor": "npcDescriptor",
    "descriptor": "npcDescriptor",
    "combat": "combatAction",
    "combat-action": "combatAction",
    "mystic": "mysticBacklash",
    "mystic-backlash": "mysticBacklash",
    "backlash": "mysticBacklash",
    "price": "payThePrice",
    "pay-the-price": "payThePrice"
  }),

  moves: MOVES,
  assetCategories: ASSET_CATEGORIES,
  terminology: TERMINOLOGY,
  rollOracle
});

export default IronswornData;
