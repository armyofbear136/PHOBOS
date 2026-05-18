/**
 * SkillTreeData — ability path trees, class passives, and aura trees.
 *
 * Structure:
 *   Each ability has 5 tiers. Tier 1 is the base (free, unlocked at start).
 *   Tiers 2–5 unlock at levels 20 / 40 / 60 / 80 / 100 respectively.
 *   At each tier (2–5) the player picks ONE of THREE paths.
 *   Once a path is chosen at tier N it gates which paths are available at tier N+1.
 *   Paths are NOT mutually exclusive between abilities — only within one ability's own tree.
 *
 *   Passives: flat list, each costs 1 skill point, no dependencies.
 *
 *   Aura: same 3-path × 5-tier structure as abilities, but it's a single aura tree per class.
 *
 * Node ID format:
 *   Ability:  `${class}.ability.${abilityIndex}.t${tier}.${pathId}`   e.g. "fighter.ability.0.t1.base"
 *   Passive:  `${class}.passive.${passiveKey}`                         e.g. "fighter.passive.iron_skin"
 *   Aura:     `${class}.aura.t${tier}.${pathId}`                       e.g. "fighter.aura.t1.base"
 *
 * Tier 1 of each ability and the aura always has pathId "base" — automatically unlocked at start.
 */

import type { ClassName } from './PlayerClasses';

// ── Types ────────────────────────────────────────────────────────────────────

export type NodeId = string; // opaque string per format above

/** A single node in an ability or aura path tree. */
export interface SkillNode {
  id:          NodeId;
  name:        string;
  description: string;
  cost:        number;          // skill points to unlock
  tier:        1 | 2 | 3 | 4 | 5;
  pathId:      string;          // 'base' | 'a' | 'b' | 'c'
  /** Which parent path(s) at the previous tier allow this node.
   *  Empty = no parent required (tier 1 base). */
  requiresPath: string[];
  /** Minimum player level to unlock this tier. */
  levelReq:    number;
  /** Mechanical effect tags used by the combat system. */
  effects:     SkillEffect[];
}

/** A passive bonus node — flat list, no path dependencies. */
export interface PassiveNode {
  id:          NodeId;
  name:        string;
  description: string;
  cost:        number;
  effects:     SkillEffect[];
}

/** Effect payload — interpreted by derivedStats / combat system. */
export interface SkillEffect {
  type:  SkillEffectType;
  value: number;        // magnitude (flat or fractional depending on type)
  label?: string;       // display label for UI (optional)
}

export type SkillEffectType =
  | 'dmg_flat'          // +N to ability base damage
  | 'dmg_pct'           // +N% to ability damage (0.15 = +15%)
  | 'cooldown_pct'      // -N% cooldown (0.10 = -10%)
  | 'spirit_cost_flat'  // -N spirit cost
  | 'aoe_radius'        // +N px AoE radius
  | 'target_count'      // +N additional targets
  | 'dot_dmg'           // +N damage per tick (burn/bleed/etc)
  | 'dot_duration'      // +N ticks added
  | 'lifesteal_pct'     // +N% lifesteal on ability hit
  | 'stun_chance'       // +N% stun on hit
  | 'slow_pct'          // +N% slow on hit
  | 'crit_chance'       // +N% crit chance for this ability
  | 'crit_dmg'          // +N% crit multiplier
  | 'shield_flat'       // +N temporary shield HP
  | 'heal_flat'         // +N HP healed
  | 'stat_str'          // +N STR
  | 'stat_dex'          // +N DEX
  | 'stat_int'          // +N INT
  | 'stat_agi'          // +N AGI
  | 'stat_vit'          // +N VIT
  | 'move_speed_pct'    // +N% move speed
  | 'attack_speed_pct'  // +N% attack speed
  | 'defense_flat'      // +N defense
  | 'resist_flat'       // +N elemental resist
  | 'regen_flat'        // +N HP/s regen
  | 'aura_radius'       // +N px aura radius
  | 'aura_dmg_pct'      // +N% bonus to aura damage component
  | 'aura_effect';      // special aura effect tag (label describes it)

/** Full skill tree for one class. */
export interface ClassSkillTree {
  classId:     ClassName;
  /** 3 ability trees, indexed 0–2 matching CLASS_DEFINITIONS[cls].abilities */
  abilities:   AbilityTree[];
  passives:    PassiveNode[];
  aura:        AuraTree;
}

export interface AbilityTree {
  abilityIndex: number;   // 0 | 1 | 2
  nodes:        SkillNode[];
}

export interface AuraTree {
  name:         string;
  description:  string;   // base aura description
  nodes:        SkillNode[];
}

// ── Level gates per tier ─────────────────────────────────────────────────────

export const TIER_LEVEL_REQ: Record<1 | 2 | 3 | 4 | 5, number> = {
  1: 1,
  2: 20,
  3: 40,
  4: 60,
  5: 80,
};

// ── Skill points ─────────────────────────────────────────────────────────────

/** Player earns 1 skill point per level (separate from stat bonus points). */
export const SKILL_POINTS_PER_LEVEL = 1;

// ── Helper ───────────────────────────────────────────────────────────────────

function abilityNode(
  cls: ClassName,
  ai: number,
  tier: 1 | 2 | 3 | 4 | 5,
  pathId: string,
  requiresPath: string[],
  name: string,
  description: string,
  cost: number,
  effects: SkillEffect[],
): SkillNode {
  return {
    id:          `${cls}.ability.${ai}.t${tier}.${pathId}`,
    name, description, cost, tier, pathId, requiresPath,
    levelReq:    TIER_LEVEL_REQ[tier],
    effects,
  };
}

function auraNode(
  cls: ClassName,
  tier: 1 | 2 | 3 | 4 | 5,
  pathId: string,
  requiresPath: string[],
  name: string,
  description: string,
  cost: number,
  effects: SkillEffect[],
): SkillNode {
  return {
    id:          `${cls}.aura.t${tier}.${pathId}`,
    name, description, cost, tier, pathId, requiresPath,
    levelReq:    TIER_LEVEL_REQ[tier],
    effects,
  };
}

function passive(
  cls: ClassName,
  key: string,
  name: string,
  description: string,
  cost: number,
  effects: SkillEffect[],
): PassiveNode {
  return { id: `${cls}.passive.${key}`, name, description, cost, effects };
}

// ─────────────────────────────────────────────────────────────────────────────
// FIGHTER — Blade Dancer
// Abilities: Cleave (0) · Lunge (1) · Blade Storm (2)
// Aura: Battle Aura — passive damage boost while moving
// ─────────────────────────────────────────────────────────────────────────────

const FIGHTER_TREE: ClassSkillTree = {
  classId: 'fighter',

  abilities: [
    // ── Ability 0: Cleave ────────────────────────────────────────────────────
    {
      abilityIndex: 0,
      nodes: [
        // Tier 1 — base (free)
        abilityNode('fighter',0,1,'base',[],
          'Cleave','Wide slash hitting all adjacent enemies.',0,
          [{ type:'dmg_flat', value:0 }]),

        // Tier 2 — 3 paths (requires base)
        abilityNode('fighter',0,2,'a',['base'],
          'Deep Cleave','Increases Cleave damage by 20%.',1,
          [{ type:'dmg_pct', value:0.20, label:'+20% damage' }]),
        abilityNode('fighter',0,2,'b',['base'],
          'Sweeping Arc','Widens the arc — hits 2 additional flanking targets.',1,
          [{ type:'target_count', value:2, label:'+2 targets' }]),
        abilityNode('fighter',0,2,'c',['base'],
          'Stunning Edge','10% chance to stun each target hit.',1,
          [{ type:'stun_chance', value:0.10, label:'10% stun' }]),

        // Tier 3 — paths gated by T2 choice
        abilityNode('fighter',0,3,'a',['a'],
          'Brutal Cleave','Cleave now crits on the primary target.',2,
          [{ type:'crit_chance', value:1.0, label:'guaranteed crit on primary' }]),
        abilityNode('fighter',0,3,'b',['b'],
          'Whirlwind Step','Leap forward before Cleave, extending range by 60px.',2,
          [{ type:'aoe_radius', value:60, label:'+60px range' }]),
        abilityNode('fighter',0,3,'c',['c'],
          'Concussion Wave','Stun chance rises to 25% and stunned targets take +15% damage.',2,
          [{ type:'stun_chance', value:0.25 }, { type:'dmg_pct', value:0.15, label:'+15% vs stunned' }]),

        // Tier 4
        abilityNode('fighter',0,4,'a',['a'],
          'Executioner','Cleave deals double damage to targets below 25% HP.',2,
          [{ type:'dmg_pct', value:1.0, label:'×2 vs <25% HP' }]),
        abilityNode('fighter',0,4,'b',['b'],
          'Cyclone','Cleave becomes a full 360° spin hitting all nearby enemies.',2,
          [{ type:'aoe_radius', value:32, label:'360° AoE' }]),
        abilityNode('fighter',0,4,'c',['c'],
          'Shatter Strike','Stunned enemies take 30% bonus damage from all sources for 3s.',2,
          [{ type:'dmg_pct', value:0.30, label:'+30% dmg vs stunned' }]),

        // Tier 5
        abilityNode('fighter',0,5,'a',['a'],
          'Reaping Blade','Cleave kills restore 10 HP and reset cooldown on crit.',3,
          [{ type:'heal_flat', value:10 }, { type:'cooldown_pct', value:1.0, label:'reset on kill-crit' }]),
        abilityNode('fighter',0,5,'b',['b'],
          'Storm of Blades','Cleave hits 3 times in rapid succession at 60% damage each.',3,
          [{ type:'dmg_pct', value:-0.40 }, { type:'target_count', value:2, label:'3 hits' }]),
        abilityNode('fighter',0,5,'c',['c'],
          'Judgment','Cleave against stunned targets deals 50% of their missing HP as bonus damage.',3,
          [{ type:'dmg_pct', value:0.50, label:'% missing HP bonus' }]),
      ],
    },

    // ── Ability 1: Lunge ─────────────────────────────────────────────────────
    {
      abilityIndex: 1,
      nodes: [
        abilityNode('fighter',1,1,'base',[],
          'Lunge','Dash forward with a piercing thrust.',0,
          [{ type:'dmg_flat', value:0 }]),

        abilityNode('fighter',1,2,'a',['base'],
          'Iron Thrust','Lunge damage increased by 25%.',1,
          [{ type:'dmg_pct', value:0.25 }]),
        abilityNode('fighter',1,2,'b',['base'],
          'Blinding Tip','Lunge reduces the target\'s accuracy by 30% for 4s.',1,
          [{ type:'slow_pct', value:0.30, label:'-30% accuracy' }]),
        abilityNode('fighter',1,2,'c',['base'],
          'Sprint Lunge','Lunge distance doubled. Can pass through enemies.',1,
          [{ type:'aoe_radius', value:80, label:'×2 range, piercing' }]),

        abilityNode('fighter',1,3,'a',['a'],
          'Vital Strike','Lunge has 20% crit chance and crits ignore 50% defense.',2,
          [{ type:'crit_chance', value:0.20 }, { type:'defense_flat', value:-999, label:'50% defense bypass' }]),
        abilityNode('fighter',1,3,'b',['b'],
          'Expose','Blinded targets take +20% damage from all sources.',2,
          [{ type:'dmg_pct', value:0.20, label:'+20% vs blinded' }]),
        abilityNode('fighter',1,3,'c',['c'],
          'Skewer','Pass-through hits now all deal full damage.',2,
          [{ type:'dmg_pct', value:0.60, label:'pass-through full dmg' }]),

        abilityNode('fighter',1,4,'a',['a'],
          'Puncture','Lunge leaves a bleed dealing 5 damage/s for 5s.',2,
          [{ type:'dot_dmg', value:5 }, { type:'dot_duration', value:5 }]),
        abilityNode('fighter',1,4,'b',['b'],
          'Disorienting Drive','Blind now also slows movement by 40%.',2,
          [{ type:'slow_pct', value:0.40, label:'+40% slow' }]),
        abilityNode('fighter',1,4,'c',['c'],
          'Freight Train','Lunge knocks back all pierced enemies 80px.',2,
          [{ type:'aoe_radius', value:80, label:'+80px knockback' }]),

        abilityNode('fighter',1,5,'a',['a'],
          'Death Mark','Bleed target is marked — all your attacks deal +15% damage to it.',3,
          [{ type:'dmg_pct', value:0.15, label:'+15% on bleed target' }]),
        abilityNode('fighter',1,5,'b',['b'],
          'Predator','Lunge against blinded targets is an instant kill below 20% HP.',3,
          [{ type:'dmg_pct', value:9.0, label:'execute <20% HP' }]),
        abilityNode('fighter',1,5,'c',['c'],
          'Unstoppable Force','Lunge deals 200% damage to the first enemy hit and chains to the next.',3,
          [{ type:'dmg_pct', value:1.0 }, { type:'target_count', value:1, label:'chain' }]),
      ],
    },

    // ── Ability 2: Blade Storm ────────────────────────────────────────────────
    {
      abilityIndex: 2,
      nodes: [
        abilityNode('fighter',2,1,'base',[],
          'Blade Storm','Spinning attack hitting everything nearby.',0,
          [{ type:'dmg_flat', value:0 }]),

        abilityNode('fighter',2,2,'a',['base'],
          'Furious Storm','Blade Storm damage +30%.',1,
          [{ type:'dmg_pct', value:0.30 }]),
        abilityNode('fighter',2,2,'b',['base'],
          'Extended Gale','AoE radius increased by 40px.',1,
          [{ type:'aoe_radius', value:40 }]),
        abilityNode('fighter',2,2,'c',['base'],
          'Life Drain','Blade Storm heals 5% of damage dealt.',1,
          [{ type:'lifesteal_pct', value:0.05 }]),

        abilityNode('fighter',2,3,'a',['a'],
          'Overclock','Blade Storm cooldown reduced by 25%.',2,
          [{ type:'cooldown_pct', value:0.25 }]),
        abilityNode('fighter',2,3,'b',['b'],
          'Hurricane','Enemies in the AoE are knocked outward 60px.',2,
          [{ type:'aoe_radius', value:60, label:'knockback' }]),
        abilityNode('fighter',2,3,'c',['c'],
          'Vampiric Tempest','Lifesteal rises to 12% and also restores spirit.',2,
          [{ type:'lifesteal_pct', value:0.12 }, { type:'heal_flat', value:5, label:'+5 spirit' }]),

        abilityNode('fighter',2,4,'a',['a'],
          'Eye of the Storm','At max charge, Blade Storm hits a second time for 50% damage.',2,
          [{ type:'dmg_pct', value:0.50, label:'double hit' }]),
        abilityNode('fighter',2,4,'b',['b'],
          'Shockwave','Knockback enemies are stunned for 1s on landing.',2,
          [{ type:'stun_chance', value:1.0, label:'stun on knockback' }]),
        abilityNode('fighter',2,4,'c',['c'],
          'Eternal Hunger','Every kill during Blade Storm extends its duration by 0.5s.',2,
          [{ type:'dot_duration', value:1, label:'+0.5s per kill' }]),

        abilityNode('fighter',2,5,'a',['a'],
          'Apex Dancer','Blade Storm resets its cooldown if it kills 3+ enemies.',3,
          [{ type:'cooldown_pct', value:1.0, label:'reset on 3-kill' }]),
        abilityNode('fighter',2,5,'b',['b'],
          'Gravity Well','Enemies are pulled in before knockback — guaranteed to hit all nearby.',3,
          [{ type:'target_count', value:4, label:'guaranteed pull' }]),
        abilityNode('fighter',2,5,'c',['c'],
          'Undying Dance','While Blade Storm is active you cannot be killed (floor at 1 HP).',3,
          [{ type:'heal_flat', value:9999, label:'death prevention' }]),
      ],
    },
  ],

  passives: [
    passive('fighter','iron_skin',   'Iron Skin',    '+8 base defense.',                                  1,[{ type:'defense_flat', value:8 }]),
    passive('fighter','keen_edge',   'Keen Edge',    '+5% crit chance on all attacks.',                   1,[{ type:'crit_chance',  value:0.05 }]),
    passive('fighter','battle_rush', 'Battle Rush',  '+10% move speed for 3s after landing a melee hit.',1,[{ type:'move_speed_pct', value:0.10 }]),
    passive('fighter','endurance',   'Endurance',    '+15 max HP.',                                       1,[{ type:'stat_vit', value:1 }]),
    passive('fighter','swift_hands', 'Swift Hands',  '+8% attack speed.',                                 1,[{ type:'attack_speed_pct', value:0.08 }]),
    passive('fighter','open_wounds', 'Open Wounds',  'Critical hits cause the target to bleed 3 dmg/s for 4s.', 2,[{ type:'dot_dmg', value:3 }, { type:'dot_duration', value:4 }]),
    passive('fighter','adrenaline',  'Adrenaline',   'When HP drops below 30%, gain +20% damage for 5s.',2,[{ type:'dmg_pct', value:0.20, label:'low HP bonus' }]),
    passive('fighter','warlord',     'Warlord',      '+3 STR, +2 AGI.',                                   2,[{ type:'stat_str', value:3 }, { type:'stat_agi', value:2 }]),
  ],

  aura: {
    name: 'Battle Aura',
    description: 'Emanates a fierce energy field — passively boosts nearby allies and deals minor damage to adjacent enemies each second.',
    nodes: [
      auraNode('fighter',1,'base',[],'Battle Aura','Aura active: +5% damage while you are moving. Passive.',0,
        [{ type:'aura_effect', value:1, label:'active' }]),

      auraNode('fighter',2,'a',['base'],'War Presence','Aura radius +40px. Nearby allies gain +5% damage.',1,
        [{ type:'aura_radius', value:40 }, { type:'aura_dmg_pct', value:0.05 }]),
      auraNode('fighter',2,'b',['base'],'Bladewall','Aura pulses every 2s dealing 4 damage to adjacent enemies.',1,
        [{ type:'aura_dmg_pct', value:0.04, label:'4 dmg/2s pulse' }]),
      auraNode('fighter',2,'c',['base'],'Iron Will','Aura grants +6 defense to self while in combat.',1,
        [{ type:'defense_flat', value:6 }]),

      auraNode('fighter',3,'a',['a'],'Commander\'s Cry','Ally damage bonus rises to +12%.',2,
        [{ type:'aura_dmg_pct', value:0.12 }]),
      auraNode('fighter',3,'b',['b'],'Blade Cyclone','Pulse frequency 1s, damage rises to 8.',2,
        [{ type:'aura_dmg_pct', value:0.08 }]),
      auraNode('fighter',3,'c',['c'],'Fortress','Defense bonus rises to +14 and extends to nearby allies.',2,
        [{ type:'defense_flat', value:14 }]),

      auraNode('fighter',4,'a',['a'],'Rallying Banner','Ally bonus also increases attack speed by 10%.',2,
        [{ type:'attack_speed_pct', value:0.10 }]),
      auraNode('fighter',4,'b',['b'],'Storm Halo','Each pulse has 15% chance to stun targets for 0.5s.',2,
        [{ type:'stun_chance', value:0.15 }]),
      auraNode('fighter',4,'c',['c'],'Unbroken','While aura is active, incoming damage is capped at 20% max HP per hit.',2,
        [{ type:'aura_effect', value:1, label:'dmg cap 20%' }]),

      auraNode('fighter',5,'a',['a'],'Apex Warlord','Ally bonus rises to +20%. You deal +10% damage per ally within radius.',3,
        [{ type:'aura_dmg_pct', value:0.20 }]),
      auraNode('fighter',5,'b',['b'],'God of War','Pulse deals 20 damage and slows enemies 30% for 1s.',3,
        [{ type:'aura_dmg_pct', value:0.20 }, { type:'slow_pct', value:0.30 }]),
      auraNode('fighter',5,'c',['c'],'Absolute Defense','Incoming damage that would kill you is absorbed by the aura once per 60s.',3,
        [{ type:'aura_effect', value:1, label:'death prevention once/60s' }]),
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// TANK — Ironwarden
// Abilities: Shield Slam (0) · Fortify (1) · Earthquake (2)
// Aura: Guardian Aura
// ─────────────────────────────────────────────────────────────────────────────

const TANK_TREE: ClassSkillTree = {
  classId: 'tank',
  abilities: [
    {
      abilityIndex: 0,
      nodes: [
        abilityNode('tank',0,1,'base',[],'Shield Slam','Bash with shield, chance to stun.',0,[{ type:'dmg_flat', value:0 }]),

        abilityNode('tank',0,2,'a',['base'],'Heavy Slam','Shield Slam damage +25%.',1,[{ type:'dmg_pct', value:0.25 }]),
        abilityNode('tank',0,2,'b',['base'],'Shieldwall','After Shield Slam, gain +10 defense for 3s.',1,[{ type:'defense_flat', value:10 }]),
        abilityNode('tank',0,2,'c',['base'],'Staggering Blow','Stun chance rises to 30%.',1,[{ type:'stun_chance', value:0.30 }]),

        abilityNode('tank',0,3,'a',['a'],'Crushing Force','Shield Slam ignores 40% of target defense.',2,[{ type:'defense_flat', value:-999, label:'40% bypass' }]),
        abilityNode('tank',0,3,'b',['b'],'Impenetrable','Defense bonus rises to 20 and lasts 5s.',2,[{ type:'defense_flat', value:20 }]),
        abilityNode('tank',0,3,'c',['c'],'Concussive','Stunned targets take 20% more damage from all sources.',2,[{ type:'dmg_pct', value:0.20, label:'+20% vs stunned' }]),

        abilityNode('tank',0,4,'a',['a'],'Thunderclap','Shield Slam now hits all enemies in a 96px cone.',2,[{ type:'aoe_radius', value:96 }]),
        abilityNode('tank',0,4,'b',['b'],'Bulwark','Absorb first hit taken in the defense window.',2,[{ type:'shield_flat', value:30 }]),
        abilityNode('tank',0,4,'c',['c'],'Daze','Stunned enemies are also disarmed — deal 0 damage for 2s.',2,[{ type:'aura_effect', value:1, label:'disarm' }]),

        abilityNode('tank',0,5,'a',['a'],'Titan Slam','Cone expands to 180°. Targets are launched upward.',3,[{ type:'aoe_radius', value:64, label:'180° cone + launch' }]),
        abilityNode('tank',0,5,'b',['b'],'Immortal Guard','Defense buff absorbs up to 50 damage per hit while active.',3,[{ type:'shield_flat', value:50 }]),
        abilityNode('tank',0,5,'c',['c'],'Total Incapacitation','Stun duration doubles and disarm extends to 4s.',3,[{ type:'stun_chance', value:1.0, label:'2× stun + 4s disarm' }]),
      ],
    },
    {
      abilityIndex: 1,
      nodes: [
        abilityNode('tank',1,1,'base',[],'Fortify','Restore spirit and boost defense temporarily.',0,[{ type:'heal_flat', value:0 }]),

        abilityNode('tank',1,2,'a',['base'],'Iron Reserves','+20 spirit restored on use.',1,[{ type:'heal_flat', value:20 }]),
        abilityNode('tank',1,2,'b',['base'],'Fortress Stance','Defense boost doubles (+20 for 5s).',1,[{ type:'defense_flat', value:20 }]),
        abilityNode('tank',1,2,'c',['base'],'Shared Strength','Fortify also grants +8 defense to nearby allies.',1,[{ type:'aura_effect', value:1, label:'ally defense' }]),

        abilityNode('tank',1,3,'a',['a'],'Deep Reserves','+40 HP also restored.',2,[{ type:'heal_flat', value:40 }]),
        abilityNode('tank',1,3,'b',['b'],'Ironclad','Fortify now makes you immune to stun during its duration.',2,[{ type:'aura_effect', value:1, label:'stun immune' }]),
        abilityNode('tank',1,3,'c',['c'],'Rally','Ally defense bonus rises to +16 for 6s.',2,[{ type:'defense_flat', value:16 }]),

        abilityNode('tank',1,4,'a',['a'],'Emergency Protocol','Fortify auto-triggers at 15% HP (once per 60s).',2,[{ type:'aura_effect', value:1, label:'auto at 15% HP' }]),
        abilityNode('tank',1,4,'b',['b'],'Stone Skin','Damage reduction 15% during Fortify window.',2,[{ type:'resist_flat', value:15 }]),
        abilityNode('tank',1,4,'c',['c'],'Unbreakable Wall','While Fortify is active, allies within 80px cannot be killed.',2,[{ type:'aura_effect', value:1, label:'ally death prevention' }]),

        abilityNode('tank',1,5,'a',['a'],'Second Wind','Emergency trigger now also fully restores HP.',3,[{ type:'heal_flat', value:9999, label:'full HP on trigger' }]),
        abilityNode('tank',1,5,'b',['b'],'Petrified','During Fortify window, immune to all damage.',3,[{ type:'aura_effect', value:1, label:'full immunity' }]),
        abilityNode('tank',1,5,'c',['c'],'Immortal Shield','Allies under Unbreakable Wall also gain +20% damage.',3,[{ type:'aura_dmg_pct', value:0.20 }]),
      ],
    },
    {
      abilityIndex: 2,
      nodes: [
        abilityNode('tank',2,1,'base',[],'Earthquake','Ground slam that staggers all nearby enemies.',0,[{ type:'dmg_flat', value:0 }]),

        abilityNode('tank',2,2,'a',['base'],'Seismic Force','Earthquake damage +30%.',1,[{ type:'dmg_pct', value:0.30 }]),
        abilityNode('tank',2,2,'b',['base'],'Aftershock','A second smaller quake triggers 1s later at 50% damage.',1,[{ type:'dmg_pct', value:0.50, label:'aftershock' }]),
        abilityNode('tank',2,2,'c',['base'],'Tectonic Rift','Enemies are slowed 40% for 4s.',1,[{ type:'slow_pct', value:0.40 }]),

        abilityNode('tank',2,3,'a',['a'],'Magnitude','AoE radius +64px.',2,[{ type:'aoe_radius', value:64 }]),
        abilityNode('tank',2,3,'b',['b'],'Chain Quake','Third quake at 25% damage. Chains up to 3.',2,[{ type:'target_count', value:1, label:'3-chain quake' }]),
        abilityNode('tank',2,3,'c',['c'],'Deep Fissure','Slowed enemies are rooted for 2s.',2,[{ type:'stun_chance', value:1.0, label:'root 2s' }]),

        abilityNode('tank',2,4,'a',['a'],'Tectonic Titan','Earthquake also knocks enemies up, delaying their next action 2s.',2,[{ type:'stun_chance', value:1.0, label:'2s launch' }]),
        abilityNode('tank',2,4,'b',['b'],'Cascade','Aftershock chain scales: 70/50/30% damage per step.',2,[{ type:'dmg_pct', value:0.20, label:'cascade' }]),
        abilityNode('tank',2,4,'c',['c'],'Quicksand','Rooted enemies take +25% damage from all sources.',2,[{ type:'dmg_pct', value:0.25, label:'+25% vs rooted' }]),

        abilityNode('tank',2,5,'a',['a'],'World Breaker','Earthquake launches and stuns. Cooldown reduced by 5s.',3,[{ type:'cooldown_pct', value:0.40 }]),
        abilityNode('tank',2,5,'b',['b'],'Endless Tremor','Cascade never ends — hits 6 times scaling down to 10%.',3,[{ type:'target_count', value:3 }]),
        abilityNode('tank',2,5,'c',['c'],'Fissure','Rooted enemies shatter — they take 50% of max HP as bonus damage.',3,[{ type:'dmg_pct', value:0.50, label:'HP% on root' }]),
      ],
    },
  ],
  passives: [
    passive('tank','granite_skin', 'Granite Skin',   '+12 base defense.',                          1,[{ type:'defense_flat', value:12 }]),
    passive('tank','colossus',     'Colossus',        '+20 max HP.',                                1,[{ type:'stat_vit', value:1 }]),
    passive('tank','retribution',  'Retribution',     'Reflect 10% of damage taken to attacker.',  1,[{ type:'aura_effect', value:1, label:'10% reflect' }]),
    passive('tank','endure',       'Endure',          'Survive fatal hits at 1 HP once per 30s.',  2,[{ type:'aura_effect', value:1, label:'death prevention 30s' }]),
    passive('tank','taunt',        'Taunt',           'Enemies within 80px are forced to target you.',1,[{ type:'aura_effect', value:1, label:'taunt' }]),
    passive('tank','shield_bash',  'Shield Expert',   '+2 DEX, +4 VIT.',                           1,[{ type:'stat_dex', value:2 }, { type:'stat_vit', value:4 }]),
    passive('tank','elemental_ward','Elemental Ward', '+10 elemental resist.',                      1,[{ type:'resist_flat', value:10 }]),
    passive('tank','colossus_2',   'Iron Giant',      '+5 STR, +3 VIT.',                           2,[{ type:'stat_str', value:5 }, { type:'stat_vit', value:3 }]),
  ],
  aura: {
    name: 'Guardian Aura',
    description: 'Projects a field of protective force — nearby allies take reduced damage.',
    nodes: [
      auraNode('tank',1,'base',[],'Guardian Aura','Allies within 96px take 5% less damage.',0,[{ type:'aura_effect', value:1, label:'active' }]),

      auraNode('tank',2,'a',['base'],'Iron Veil','Damage reduction rises to 10%.',1,[{ type:'resist_flat', value:10 }]),
      auraNode('tank',2,'b',['base'],'Thorns','Attackers of protected allies take 4 reflected damage.',1,[{ type:'aura_dmg_pct', value:0.04 }]),
      auraNode('tank',2,'c',['base'],'Sanctum','Aura radius expands to +48px.',1,[{ type:'aura_radius', value:48 }]),

      auraNode('tank',3,'a',['a'],'Bulwark',  'Damage reduction 18%.',2,[{ type:'resist_flat', value:18 }]),
      auraNode('tank',3,'b',['b'],'Vengeance','Reflected damage rises to 10.',2,[{ type:'aura_dmg_pct', value:0.10 }]),
      auraNode('tank',3,'c',['c'],'Citadel',  'Aura grants +8 defense to allies.',2,[{ type:'defense_flat', value:8 }]),

      auraNode('tank',4,'a',['a'],'Absolute Veil','Allies below 30% HP take 30% less damage.',2,[{ type:'resist_flat', value:30 }]),
      auraNode('tank',4,'b',['b'],'Mirror Ward','20% of all damage to allies is redirected to you.',2,[{ type:'aura_effect', value:1, label:'20% redirect' }]),
      auraNode('tank',4,'c',['c'],'Fortress','Defense bonus doubles to +16.',2,[{ type:'defense_flat', value:16 }]),

      auraNode('tank',5,'a',['a'],'Divine Shield','Once per 90s the aura absorbs all damage for 3s.',3,[{ type:'aura_effect', value:1, label:'3s immunity' }]),
      auraNode('tank',5,'b',['b'],'Wrath Mirror','Reflected damage = 50% of all ally hits taken.',3,[{ type:'aura_dmg_pct', value:0.50 }]),
      auraNode('tank',5,'c',['c'],'Impregnable','All allies within aura become immune to stun and slow.',3,[{ type:'aura_effect', value:1, label:'CC immune' }]),
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// HEALER — Void Mender
// Abilities: Mend (0) · Spirit Lance (1) · Void Nova (2)
// Aura: Renewal Aura
// ─────────────────────────────────────────────────────────────────────────────

const HEALER_TREE: ClassSkillTree = {
  classId: 'healer',
  abilities: [
    {
      abilityIndex: 0,
      nodes: [
        abilityNode('healer',0,1,'base',[],'Mend','Restore HP to self or ally.',0,[{ type:'heal_flat', value:0 }]),

        abilityNode('healer',0,2,'a',['base'],'Empowered Mend','+30% HP restored.',1,[{ type:'heal_flat', value:15 }]),
        abilityNode('healer',0,2,'b',['base'],'Chain Mend','Heal jumps to 1 additional nearby ally.',1,[{ type:'target_count', value:1 }]),
        abilityNode('healer',0,2,'c',['base'],'Void Infusion','Mend also restores 15 spirit.',1,[{ type:'heal_flat', value:15, label:'+15 spirit' }]),

        abilityNode('healer',0,3,'a',['a'],'Greater Mend','+60% total heal bonus.',2,[{ type:'heal_flat', value:20 }]),
        abilityNode('healer',0,3,'b',['b'],'Cascade Heal','Chain jumps to 2 allies.',2,[{ type:'target_count', value:1 }]),
        abilityNode('healer',0,3,'c',['c'],'Rejuvenation','Also applies HoT: 5 HP/s for 5s.',2,[{ type:'regen_flat', value:5 }]),

        abilityNode('healer',0,4,'a',['a'],'Mass Heal','Heals all allies simultaneously for 50% of normal.',2,[{ type:'target_count', value:4 }]),
        abilityNode('healer',0,4,'b',['b'],'Surge','Next hit on healed ally deals +20% damage.',2,[{ type:'dmg_pct', value:0.20 }]),
        abilityNode('healer',0,4,'c',['c'],'Overcharge','HoT stacks up to 3×.',2,[{ type:'regen_flat', value:10 }]),

        abilityNode('healer',0,5,'a',['a'],'Divine Surge','Mass Heal critically heals — double HP restored on each target.',3,[{ type:'crit_dmg', value:1.0 }]),
        abilityNode('healer',0,5,'b',['b'],'Echo','Surge buff transfers to next 2 allies hit.',3,[{ type:'target_count', value:2 }]),
        abilityNode('healer',0,5,'c',['c'],'Lifeweave','HoT stacks generate 2 spirit per tick.',3,[{ type:'heal_flat', value:6, label:'+2 spirit/tick' }]),
      ],
    },
    {
      abilityIndex: 1,
      nodes: [
        abilityNode('healer',1,1,'base',[],'Spirit Lance','Piercing energy bolt that drains enemy spirit.',0,[{ type:'dmg_flat', value:0 }]),

        abilityNode('healer',1,2,'a',['base'],'Piercing Lance','+20% damage.',1,[{ type:'dmg_pct', value:0.20 }]),
        abilityNode('healer',1,2,'b',['base'],'Spirit Drain','Spirit drained +15.',1,[{ type:'heal_flat', value:15, label:'+15 spirit drain' }]),
        abilityNode('healer',1,2,'c',['base'],'Void Channel','Spirit Lance pierces through enemies, hitting up to 3.',1,[{ type:'target_count', value:2 }]),

        abilityNode('healer',1,3,'a',['a'],'Lance Mastery','+40% total damage bonus.',2,[{ type:'dmg_pct', value:0.20 }]),
        abilityNode('healer',1,3,'b',['b'],'Total Drain','All drained spirit is converted to HP for you.',2,[{ type:'lifesteal_pct', value:1.0, label:'drain→HP' }]),
        abilityNode('healer',1,3,'c',['c'],'Ghost Pierce','Chain ignores 50% defense on each target.',2,[{ type:'defense_flat', value:-999, label:'50% bypass' }]),

        abilityNode('healer',1,4,'a',['a'],'Killing Lance','Lance crits for 2× damage.',2,[{ type:'crit_chance', value:0.30 }]),
        abilityNode('healer',1,4,'b',['b'],'Siphon','Drain also heals one random ally for 50% of the amount.',2,[{ type:'heal_flat', value:10, label:'50% ally heal' }]),
        abilityNode('healer',1,4,'c',['c'],'Void Rift','Ghost Pierce now bounces — hits 5 targets total.',2,[{ type:'target_count', value:2 }]),

        abilityNode('healer',1,5,'a',['a'],'Annihilator','Lance one-shots targets below 20% HP.',3,[{ type:'dmg_pct', value:9.0, label:'execute <20%' }]),
        abilityNode('healer',1,5,'b',['b'],'Total Conversion','Full spirit bar drained. You gain 3 HP per drained point.',3,[{ type:'lifesteal_pct', value:3.0 }]),
        abilityNode('healer',1,5,'c',['c'],'Void Storm','Bounce chain explodes on final target for 3× damage.',3,[{ type:'dmg_pct', value:2.0, label:'final 3× explosion' }]),
      ],
    },
    {
      abilityIndex: 2,
      nodes: [
        abilityNode('healer',2,1,'base',[],'Void Nova','Massive AoE that damages enemies and restores ally spirit.',0,[{ type:'dmg_flat', value:0 }]),

        abilityNode('healer',2,2,'a',['base'],'Expanded Nova','+40px AoE radius.',1,[{ type:'aoe_radius', value:40 }]),
        abilityNode('healer',2,2,'b',['base'],'Void Feedback','Each enemy hit restores 5 spirit to nearest ally.',1,[{ type:'heal_flat', value:5, label:'5 spirit/enemy' }]),
        abilityNode('healer',2,2,'c',['base'],'Entropic Nova','Nova applies Entropy stacks to all hit enemies.',1,[{ type:'dot_dmg', value:3 }, { type:'dot_duration', value:3 }]),

        abilityNode('healer',2,3,'a',['a'],'Supernova','AoE +80px total. Enemies in inner 40px take 2× damage.',2,[{ type:'aoe_radius', value:40 }]),
        abilityNode('healer',2,3,'b',['b'],'Spirit Surge','Spirit restored per enemy hit rises to 10.',2,[{ type:'heal_flat', value:10 }]),
        abilityNode('healer',2,3,'c',['c'],'Void Cascade','Entropy stacks max at 15 instead of 10.',2,[{ type:'dot_duration', value:5, label:'+5 entropy cap' }]),

        abilityNode('healer',2,4,'a',['a'],'Black Hole','Pull all enemies toward centre before detonation.',2,[{ type:'aoe_radius', value:32, label:'pull then explode' }]),
        abilityNode('healer',2,4,'b',['b'],'Full Restore','Nova fully restores spirit of all allies in radius.',2,[{ type:'heal_flat', value:9999, label:'full spirit restore' }]),
        abilityNode('healer',2,4,'c',['c'],'Entropy Bomb','Enemies at max entropy stacks explode for 30 AoE damage.',2,[{ type:'aura_dmg_pct', value:0.30 }]),

        abilityNode('healer',2,5,'a',['a'],'Singularity','Black Hole pulls 2× range and deals 3× damage at centre.',3,[{ type:'dmg_pct', value:2.0 }]),
        abilityNode('healer',2,5,'b',['b'],'Ascension','Full Restore also removes all debuffs from allies.',3,[{ type:'aura_effect', value:1, label:'cleanse' }]),
        abilityNode('healer',2,5,'c',['c'],'Void Collapse','Entropy Bomb chains — each explosion triggers another on nearest enemy.',3,[{ type:'target_count', value:3 }]),
      ],
    },
  ],
  passives: [
    passive('healer','arcane_flow',  'Arcane Flow',    '+10% ability damage.',                   1,[{ type:'dmg_pct', value:0.10 }]),
    passive('healer','void_shield',  'Void Shield',    'On cast: gain 8 HP shield for 3s.',      1,[{ type:'shield_flat', value:8 }]),
    passive('healer','spirit_tap',   'Spirit Tap',     'Kills restore 8 spirit.',                1,[{ type:'heal_flat', value:8, label:'+8 spirit on kill' }]),
    passive('healer','channel_mind', 'Channel Mind',   '-10% ability cooldowns.',                 1,[{ type:'cooldown_pct', value:0.10 }]),
    passive('healer','void_armor',   'Void Armor',     '+6 defense, +8 elemental resist.',        1,[{ type:'defense_flat', value:6 }, { type:'resist_flat', value:8 }]),
    passive('healer','insight',      'Insight',        '+4 INT, +2 VIT.',                         1,[{ type:'stat_int', value:4 }, { type:'stat_vit', value:2 }]),
    passive('healer','mending_pulse','Mending Pulse',  'HP regen +1.5/s.',                        2,[{ type:'regen_flat', value:1.5 }]),
    passive('healer','transcend',    'Transcendence',  'At 0 spirit: ignore spirit cost for 5s once per 30s.', 2,[{ type:'aura_effect', value:1, label:'spirit immunity 5s' }]),
  ],
  aura: {
    name: 'Renewal Aura',
    description: 'Emanates restorative void energy — allies within range slowly regenerate HP.',
    nodes: [
      auraNode('healer',1,'base',[],'Renewal Aura','Allies within 80px regenerate 1 HP/s.',0,[{ type:'regen_flat', value:1 }]),

      auraNode('healer',2,'a',['base'],'Deep Renewal','Regen rises to 2 HP/s.',1,[{ type:'regen_flat', value:1 }]),
      auraNode('healer',2,'b',['base'],'Void Touch','Regen also restores 0.5 spirit/s to allies.',1,[{ type:'heal_flat', value:1, label:'+0.5 spirit/s' }]),
      auraNode('healer',2,'c',['base'],'Healing Radius','Aura radius +40px.',1,[{ type:'aura_radius', value:40 }]),

      auraNode('healer',3,'a',['a'],'Vital Surge','Regen pulses — 6 HP every 3s instead of 2/s.',2,[{ type:'regen_flat', value:2 }]),
      auraNode('healer',3,'b',['b'],'Spirit Flood','Spirit regen rises to 1.5/s.',2,[{ type:'heal_flat', value:2, label:'1.5 spirit/s' }]),
      auraNode('healer',3,'c',['c'],'Far Reach','Radius +80px total.',2,[{ type:'aura_radius', value:40 }]),

      auraNode('healer',4,'a',['a'],'Pulse of Life','On ally kill, Renewal pulses for 20 HP across all allies.',2,[{ type:'heal_flat', value:20, label:'20 HP on kill' }]),
      auraNode('healer',4,'b',['b'],'Fullness','Spirit regen doubles when ally below 30% spirit.',2,[{ type:'heal_flat', value:3, label:'2× at low spirit' }]),
      auraNode('healer',4,'c',['c'],'Sanctuary','Allies in radius take 10% less damage.',2,[{ type:'resist_flat', value:10 }]),

      auraNode('healer',5,'a',['a'],'Immortal Spring','Allies below 20% HP are instantly healed to 30% when entering radius.',3,[{ type:'heal_flat', value:9999, label:'floor 30%' }]),
      auraNode('healer',5,'b',['b'],'Overflow','When ally spirit is full, excess regen becomes HP.',3,[{ type:'regen_flat', value:3 }]),
      auraNode('healer',5,'c',['c'],'Void Sanctuary','Allies in radius are immune to DoT effects.',3,[{ type:'aura_effect', value:1, label:'DoT immune' }]),
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ROGUE — Shadow Runner
// Abilities: Backstab (0) · Smoke Bomb (1) · Death Blossom (2)
// Aura: Shadow Aura
// ─────────────────────────────────────────────────────────────────────────────

const ROGUE_TREE: ClassSkillTree = {
  classId: 'rogue',
  abilities: [
    {
      abilityIndex: 0,
      nodes: [
        abilityNode('rogue',0,1,'base',[],'Backstab','High damage from behind, bonus if undetected.',0,[{ type:'dmg_flat', value:0 }]),

        abilityNode('rogue',0,2,'a',['base'],'Assassin\'s Edge','+30% damage.',1,[{ type:'dmg_pct', value:0.30 }]),
        abilityNode('rogue',0,2,'b',['base'],'Shadow Step','Teleport behind target before striking.',1,[{ type:'aura_effect', value:1, label:'teleport' }]),
        abilityNode('rogue',0,2,'c',['base'],'Poison Blade','Backstab applies poison: 4 dmg/s for 5s.',1,[{ type:'dot_dmg', value:4 }, { type:'dot_duration', value:5 }]),

        abilityNode('rogue',0,3,'a',['a'],'Lethal Precision','Guaranteed crit when striking from behind.',2,[{ type:'crit_chance', value:1.0 }]),
        abilityNode('rogue',0,3,'b',['b'],'Void Step','Teleport ignores obstacles and can cross any terrain.',2,[{ type:'aura_effect', value:1, label:'terrain ignore' }]),
        abilityNode('rogue',0,3,'c',['c'],'Venom Stack','Poison stacks up to 3× on same target.',2,[{ type:'dot_dmg', value:4 }, { type:'target_count', value:2, label:'3 stacks' }]),

        abilityNode('rogue',0,4,'a',['a'],'Shadow Execution','Crit damage +60%.',2,[{ type:'crit_dmg', value:0.60 }]),
        abilityNode('rogue',0,4,'b',['b'],'Ghost','Void Step grants 1s invincibility.',2,[{ type:'aura_effect', value:1, label:'1s invincible' }]),
        abilityNode('rogue',0,4,'c',['c'],'Necrotic Venom','Poison also reduces healing received by 50%.',2,[{ type:'aura_effect', value:1, label:'-50% healing' }]),

        abilityNode('rogue',0,5,'a',['a'],'Oblivion','Backstab crits for 3× damage (up from 1.5×).',3,[{ type:'crit_dmg', value:1.0, label:'3× crit' }]),
        abilityNode('rogue',0,5,'b',['b'],'Phase Killer','Invincibility extends to 2s and attack resets if target dies.',3,[{ type:'cooldown_pct', value:1.0, label:'reset on kill' }]),
        abilityNode('rogue',0,5,'c',['c'],'Lethal Dose','Poison ticks now deal 15 damage and last 8s.',3,[{ type:'dot_dmg', value:15 }, { type:'dot_duration', value:8 }]),
      ],
    },
    {
      abilityIndex: 1,
      nodes: [
        abilityNode('rogue',1,1,'base',[],'Smoke Bomb','Blind nearby enemies, restoring stealth.',0,[{ type:'slow_pct', value:0.30 }]),

        abilityNode('rogue',1,2,'a',['base'],'Dense Smoke','Blind duration +2s.',1,[{ type:'dot_duration', value:2 }]),
        abilityNode('rogue',1,2,'b',['base'],'Flash Bang','Smoke Bomb stuns enemies for 1s on detonation.',1,[{ type:'stun_chance', value:1.0 }]),
        abilityNode('rogue',1,2,'c',['base'],'Toxic Cloud','Smoke deals 3 damage/s to enemies within it.',1,[{ type:'dot_dmg', value:3 }]),

        abilityNode('rogue',1,3,'a',['a'],'Blinding Cloud','Blinded enemies deal 0% damage.',2,[{ type:'aura_effect', value:1, label:'full blind' }]),
        abilityNode('rogue',1,3,'b',['b'],'Concussive Bang','Stun duration rises to 2s.',2,[{ type:'stun_chance', value:1.0, label:'2s stun' }]),
        abilityNode('rogue',1,3,'c',['c'],'Nerve Agent','Toxic damage rises to 8/s.',2,[{ type:'dot_dmg', value:8 }]),

        abilityNode('rogue',1,4,'a',['a'],'Fear Gas','Blinded enemies flee for 3s.',2,[{ type:'aura_effect', value:1, label:'fear 3s' }]),
        abilityNode('rogue',1,4,'b',['b'],'Cluster Bang','Smoke Bomb throws 3 charges.',2,[{ type:'target_count', value:2 }]),
        abilityNode('rogue',1,4,'c',['c'],'Plague Cloud','Toxic now stacks per second of exposure — max 5 stacks.',2,[{ type:'dot_dmg', value:5, label:'5-stack' }]),

        abilityNode('rogue',1,5,'a',['a'],'Panic','Feared enemies take +30% damage from all sources.',3,[{ type:'dmg_pct', value:0.30 }]),
        abilityNode('rogue',1,5,'b',['b'],'Bombardier','Each charge also stuns. 3 simultaneous stun zones.',3,[{ type:'stun_chance', value:1.0, label:'3× stun zones' }]),
        abilityNode('rogue',1,5,'c',['c'],'Biological Weapon','At max stacks, target takes 50 instant damage and is rooted.',3,[{ type:'dmg_flat', value:50 }, { type:'stun_chance', value:1.0, label:'root' }]),
      ],
    },
    {
      abilityIndex: 2,
      nodes: [
        abilityNode('rogue',2,1,'base',[],'Death Blossom','Rapid flurry of strikes on all adjacent targets.',0,[{ type:'dmg_flat', value:0 }]),

        abilityNode('rogue',2,2,'a',['base'],'Razor Flurry','+25% damage per hit.',1,[{ type:'dmg_pct', value:0.25 }]),
        abilityNode('rogue',2,2,'b',['base'],'Wider Arc','AoE radius +40px.',1,[{ type:'aoe_radius', value:40 }]),
        abilityNode('rogue',2,2,'c',['base'],'Bleed','Each hit applies 2 dmg/s bleed for 4s.',1,[{ type:'dot_dmg', value:2 }, { type:'dot_duration', value:4 }]),

        abilityNode('rogue',2,3,'a',['a'],'Serrated','Crit chance on each hit +15%.',2,[{ type:'crit_chance', value:0.15 }]),
        abilityNode('rogue',2,3,'b',['b'],'Reaping','Death Blossom hits 2× as many times.',2,[{ type:'target_count', value:2, label:'2× hits' }]),
        abilityNode('rogue',2,3,'c',['c'],'Hemorrhage','Bleed stacks up to 5× on each target.',2,[{ type:'dot_dmg', value:3 }]),

        abilityNode('rogue',2,4,'a',['a'],'Eviscerate','Crits during Blossom deal 2× their normal crit damage.',2,[{ type:'crit_dmg', value:1.0 }]),
        abilityNode('rogue',2,4,'b',['b'],'Infinite Blossom','No hit cap — continues until no targets in range.',2,[{ type:'target_count', value:4 }]),
        abilityNode('rogue',2,4,'c',['c'],'Arterial Cut','Max-stack bleed erupts — 25 instant AoE damage.',2,[{ type:'dmg_flat', value:25 }]),

        abilityNode('rogue',2,5,'a',['a'],'Thousand Cuts','Each hit below 20% HP of target is a guaranteed crit.',3,[{ type:'crit_chance', value:1.0, label:'crit <20%' }]),
        abilityNode('rogue',2,5,'b',['b'],'Maelstrom','Death Blossom triggers twice simultaneously.',3,[{ type:'dmg_pct', value:1.0, label:'double trigger' }]),
        abilityNode('rogue',2,5,'c',['c'],'Bloodbath','AoE eruption heals you for 5% of eruption damage.',3,[{ type:'lifesteal_pct', value:0.05 }]),
      ],
    },
  ],
  passives: [
    passive('rogue','shadow_veil',  'Shadow Veil',   '+12% evasion chance.',                      1,[{ type:'aura_effect', value:1, label:'12% evade' }]),
    passive('rogue','quick_fingers','Quick Fingers', '+12% attack speed.',                         1,[{ type:'attack_speed_pct', value:0.12 }]),
    passive('rogue','acrobatics',   'Acrobatics',    '+15% move speed.',                           1,[{ type:'move_speed_pct', value:0.15 }]),
    passive('rogue','opportunist',  'Opportunist',   '+20% damage to blinded/stunned enemies.',    1,[{ type:'dmg_pct', value:0.20, label:'+20% vs CC' }]),
    passive('rogue','lethality',    'Lethality',     'Crit damage multiplier +25%.',               1,[{ type:'crit_dmg', value:0.25 }]),
    passive('rogue','knife_expert', 'Knife Expert',  '+3 DEX, +3 AGI.',                            1,[{ type:'stat_dex', value:3 }, { type:'stat_agi', value:3 }]),
    passive('rogue','hemorrhage',   'Hemorrhage',    'Bleeds deal +50% damage.',                   2,[{ type:'dot_dmg', value:2 }]),
    passive('rogue','vanishing_act','Vanishing Act', 'After rolling, gain stealth for 2s.',        2,[{ type:'aura_effect', value:1, label:'stealth post-roll' }]),
  ],
  aura: {
    name: 'Shadow Aura',
    description: 'Wraps the Rogue in a dark shroud — reduces enemy detection range and increases critical strike chance.',
    nodes: [
      auraNode('rogue',1,'base',[],'Shadow Aura','+5% crit chance while in aura range.',0,[{ type:'crit_chance', value:0.05 }]),

      auraNode('rogue',2,'a',['base'],'Dark Shroud','+10% crit chance.',1,[{ type:'crit_chance', value:0.05 }]),
      auraNode('rogue',2,'b',['base'],'Umbra','Enemies within radius have -20% accuracy.',1,[{ type:'aura_effect', value:1, label:'-20% enemy acc' }]),
      auraNode('rogue',2,'c',['base'],'Shadow Step Aura','Cooldown on Shadow Step reduced by 30%.',1,[{ type:'cooldown_pct', value:0.30 }]),

      auraNode('rogue',3,'a',['a'],'Eclipse','+18% crit chance.',2,[{ type:'crit_chance', value:0.08 }]),
      auraNode('rogue',3,'b',['b'],'Blind Spot','Enemies in radius cannot detect you unless you attack.',2,[{ type:'aura_effect', value:1, label:'stealth in aura' }]),
      auraNode('rogue',3,'c',['c'],'Phase Walk','Shadow Step leaves an afterimage that distracts enemies 2s.',2,[{ type:'aura_effect', value:1, label:'decoy 2s' }]),

      auraNode('rogue',4,'a',['a'],'Predatory Shadow','Crit hits trigger a 1s +40% damage buff.',2,[{ type:'dmg_pct', value:0.40, label:'post-crit buff' }]),
      auraNode('rogue',4,'b',['b'],'Total Darkness','Enemies in radius take +15% damage from you.',2,[{ type:'dmg_pct', value:0.15 }]),
      auraNode('rogue',4,'c',['c'],'Ghost Walk','After teleport: 1.5s where you take 0 damage.',2,[{ type:'aura_effect', value:1, label:'1.5s immune post-tp' }]),

      auraNode('rogue',5,'a',['a'],'Death Shadow','While crit buff active, all attacks are guaranteed crits.',3,[{ type:'crit_chance', value:1.0, label:'guaranteed crits in buff' }]),
      auraNode('rogue',5,'b',['b'],'Nightmare Field','Enemies in radius are feared and take +25% damage.',3,[{ type:'dmg_pct', value:0.25 }]),
      auraNode('rogue',5,'c',['c'],'Untouchable','Ghost Walk extends to 3s and applies to all shadow teleports.',3,[{ type:'aura_effect', value:1, label:'3s immune per tp' }]),
    ],
  },
};

// ── Registry ─────────────────────────────────────────────────────────────────

export const SKILL_TREES: Record<ClassName, ClassSkillTree> = {
  fighter: FIGHTER_TREE,
  tank:    TANK_TREE,
  healer:  HEALER_TREE,
  rogue:   ROGUE_TREE,
};

/** Resolve a single node by ID across all trees. */
export function getSkillNode(nodeId: NodeId): SkillNode | PassiveNode | null {
  for (const tree of Object.values(SKILL_TREES)) {
    // Ability nodes
    for (const ab of tree.abilities) {
      const n = ab.nodes.find(n => n.id === nodeId);
      if (n) return n;
    }
    // Aura nodes
    const an = tree.aura.nodes.find(n => n.id === nodeId);
    if (an) return an;
    // Passives
    const pn = tree.passives.find(p => p.id === nodeId);
    if (pn) return pn;
  }
  return null;
}

/** Check whether a given node can be unlocked given current unlocked set + level. */
export function canUnlockNode(
  nodeId: NodeId,
  unlockedNodes: NodeId[],
  playerLevel: number,
  skillPoints: number,
): { ok: boolean; reason?: string } {
  const node = getSkillNode(nodeId);
  if (!node) return { ok: false, reason: 'Unknown node' };
  if (unlockedNodes.includes(nodeId)) return { ok: false, reason: 'Already unlocked' };

  if (skillPoints < node.cost) return { ok: false, reason: `Need ${node.cost} skill point(s)` };

  // Passive nodes have no tier/level gate
  if (!('tier' in node)) return { ok: true };

  if (playerLevel < node.levelReq) {
    return { ok: false, reason: `Requires level ${node.levelReq}` };
  }

  // Tier 1 base is always available if level is met
  if (node.tier === 1) return { ok: true };

  // Tier 2+ require a parent path to be unlocked
  if (node.requiresPath.length === 0) return { ok: true };
  const parentTier = (node.tier - 1) as 1 | 2 | 3 | 4;
  // Parent node IDs for the required paths
  const parentIds = node.requiresPath.map(pathId => {
    // Reconstruct parent ID from this node's ID
    const parts = nodeId.split('.');
    // replace t${tier} with t${tier-1} and pathId with the required one
    parts[parts.length - 2] = `t${parentTier}`;
    parts[parts.length - 1] = pathId;
    return parts.join('.');
  });
  const hasParent = parentIds.some(pid => unlockedNodes.includes(pid));
  if (!hasParent) return { ok: false, reason: 'Must unlock a previous tier node first' };

  // Enforce single-path: can't take two different paths at same tier for same ability/aura
  const prefix = nodeId.split('.').slice(0, -1).join('.'); // everything except pathId
  const sameTierSibling = unlockedNodes.find(uid => uid.startsWith(prefix + '.') && uid !== nodeId);
  if (sameTierSibling) return { ok: false, reason: 'A different path is already chosen for this tier' };

  return { ok: true };
}
