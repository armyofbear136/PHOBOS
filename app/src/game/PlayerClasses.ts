/**
 * PlayerClasses — class definitions, stat model, and derived calculations.
 *
 * 4 classes × 2 body types. Each class has base stat allocations.
 * Players distribute bonus points on top of class base.
 * All combat values derived from 5 core stats + equipped gear.
 *
 * Stats:
 *   STR — melee damage multiplier
 *   DEX — ranged damage multiplier
 *   INT — ability damage multiplier
 *   AGI — speed, cooldown, attack speed, accuracy
 *   VIT — HP, spirit gauge, elemental resistance
 *
 * Defense is always 0 at base, only increased by gear.
 * Spirit gauge = poise + mana hybrid. Taking hits drains it,
 * landing hits restores it. At 0 → stun. Charged attacks cost spirit.
 */

// ── Types ──────────────────────────────────────────────────────────────

export type ClassName = 'fighter' | 'tank' | 'healer' | 'rogue';
export type BodyType = 'a' | 'b';  // a = slim/agile, b = sturdy/heavy
export type ElementType = 'plasma' | 'fire' | 'ice' | 'lightning' | 'void';
export type StatName = 'str' | 'dex' | 'int' | 'agi' | 'vit';

import { getSkillNode } from './SkillTreeData';
import type { GameItem } from './ItemDefinitions';

// ── Equipment snapshot ─────────────────────────────────────────────────
// Carried on PlayerBuild so derivedStats() can see what's equipped
// without any extra function arguments. All fields optional — unequipped
// slots simply don't contribute. Rings and abilityCrystal are never
// destroyed (no durability). Weapon and armor items carry durability
// inside their weaponStats / armorStats sub-objects.
export interface EquippedGear {
  melee?:          GameItem;
  ranged?:         GameItem;
  helm?:           GameItem;
  body?:           GameItem;
  legs?:           GameItem;
  leftRing?:       GameItem;
  rightRing?:      GameItem;
  abilityCrystal?: GameItem;
}

export interface StatBlock {
  str: number;
  dex: number;
  int: number;
  agi: number;
  vit: number;
}

export interface WeaponData {
  name: string;
  type: 'melee' | 'ranged';
  baseDmgMin: number;
  baseDmgMax: number;
}

export interface AbilityData {
  name: string;
  baseDmg: number;
  spiritCost: number;
  cooldown: number;       // seconds (before AGI reduction)
  description: string;
}

export interface ClassDefinition {
  id: ClassName;
  name: string;
  title: string;          // flavor title
  description: string;
  baseStats: StatBlock;
  startingMelee: WeaponData;
  startingRanged: WeaponData;
  abilities: AbilityData[];
  spritePrefix: string;   // for sprite sheet loading: `${prefix}-${body}-move`
}

export interface PlayerBuild {
  name: string;
  class: ClassName;
  body: BodyType;
  element: ElementType;
  level: number;
  xp: number;
  bonusPoints: StatBlock;  // points allocated by player on top of class base
  unspentPoints: number;
  skillPoints: number;       // unspent skill points for ability/passive/aura unlocks
  unlockedNodes: string[];   // ordered list of unlocked SkillTreeData node IDs
  equipment?: EquippedGear;  // currently equipped items; absent = nothing equipped
}

export interface DerivedStats {
  maxHp: number;
  maxSpirit: number;
  meleeDmgMin: number;
  meleeDmgMax: number;
  rangedDmgMin: number;
  rangedDmgMax: number;
  abilityDmgMultiplier: number;
  abilityDmgBonus: number;   // flat bonus from ability crystals, added after multiplier
  attackSpeed: number;       // attacks per second base
  cooldownReduction: number; // 0-1 fraction
  moveSpeed: number;         // pixels per frame
  accuracy: number;          // 0-1 for turn-based hit chance
  elementalResist: number;   // flat damage reduction
  defense: number;           // gear + skill nodes
  regenFlat: number;         // HP/s regen from passive nodes + armor freq osc
  lifestealPct: number;      // 0-1; melee freq osc on equipped melee weapon
  teamHealFlat: number;      // HP per ranged hit; ranged freq osc
}

// ── Constants ──────────────────────────────────────────────────────────

export const STAT_NAMES: Record<StatName, string> = {
  str: 'Strength',
  dex: 'Dexterity',
  int: 'Intelligence',
  agi: 'Agility',
  vit: 'Vitality',
};

export const STAT_DESCRIPTIONS: Record<StatName, string> = {
  str: 'Melee damage multiplier',
  dex: 'Ranged damage multiplier',
  int: 'Ability damage multiplier',
  agi: 'Speed, cooldowns, attack speed, accuracy',
  vit: 'Health, spirit gauge, elemental resistance',
};

export const ELEMENT_COLORS: Record<ElementType, { hex: string; tint: number }> = {
  plasma:    { hex: '#e0e0e0', tint: 0xe0e0e0 },
  fire:      { hex: '#f59e0b', tint: 0xf59e0b },
  ice:       { hex: '#3b82f6', tint: 0x3b82f6 },
  lightning: { hex: '#8b5cf6', tint: 0x8b5cf6 },
  void:      { hex: '#6366f1', tint: 0x6366f1 },
};

export const ELEMENT_INFO: Record<ElementType, { name: string; description: string; reaction: string }> = {
  plasma: {
    name: 'Plasma',
    description: 'Adaptive energy. Deals reduced base damage but absorbs enemy elemental states for bonus damage of that type.',
    reaction: 'Applies Exposure — enemies take up to 5% more damage per stack. Best against elementally-charged targets.',
  },
  fire: {
    name: 'Fire',
    description: 'Raw thermal damage. Burns enemies over time.',
    reaction: 'Fire + Ice = Shatter (burst damage). Fire + Lightning = Overload (AoE explosion).',
  },
  ice: {
    name: 'Ice',
    description: 'Crystalline cold. Slows enemy movement and attack speed.',
    reaction: 'Ice + Fire = Shatter (burst damage). Ice + Lightning = Superconduct (defense reduction).',
  },
  lightning: {
    name: 'Lightning',
    description: 'High-voltage strikes. Chains between nearby enemies.',
    reaction: 'Lightning + Fire = Overload (AoE explosion). Lightning + Ice = Superconduct (defense reduction).',
  },
  void: {
    name: 'Void',
    description: 'Entropic force. Consumes enemy elemental states for bonus raw damage. Strongest against unaspected targets.',
    reaction: 'Applies Entropy — enemies lose up to 5% speed per stack. Best against elementally-neutral targets.',
  },
};

/** Bonus stat points given per level. */
const POINTS_PER_LEVEL = 3;
/** Starting bonus points at level 1. */
const STARTING_BONUS_POINTS = 5;
/** Skill points earned per level (for ability/passive/aura unlocks). */
export const SKILL_POINTS_PER_LEVEL = 1;
/** Starting skill points at level 1. */
const STARTING_SKILL_POINTS = 1;

// ── Derivation constants ───────────────────────────────────────────────

const BASE_HP = 100;
const HP_PER_VIT = 12;
const BASE_SPIRIT = 50;
const SPIRIT_PER_VIT = 6;
const STR_DMG_MULT = 0.08;       // +8% melee per STR point
const DEX_DMG_MULT = 0.08;       // +8% ranged per DEX point
const INT_DMG_MULT = 0.10;       // +10% ability per INT point
const BASE_ATTACK_SPEED = 1.0;   // attacks/sec
const AGI_SPEED_MULT = 0.03;     // +3% attack speed per AGI
const AGI_CDR_MULT = 0.02;       // +2% cooldown reduction per AGI (capped at 0.5)
const BASE_MOVE_SPEED = 2.5;     // pixels per frame
const AGI_MOVE_MULT = 0.04;      // +4% move speed per AGI
const BASE_ACCURACY = 0.75;      // 75% hit chance base
const AGI_ACC_MULT = 0.015;      // +1.5% accuracy per AGI (capped at 0.98)
const VIT_RESIST_MULT = 1.5;     // +1.5 flat resist per VIT

// ── Class definitions ──────────────────────────────────────────────────

export const CLASS_DEFINITIONS: Record<ClassName, ClassDefinition> = {
  fighter: {
    id: 'fighter',
    name: 'Fighter',
    title: 'Blade Dancer',
    description: 'Balanced warrior. Strong melee with decent ranged capability. High burst damage, moderate survivability.',
    baseStats: { str: 8, dex: 5, int: 2, agi: 6, vit: 4 },
    startingMelee: { name: 'Iron Longsword', type: 'melee', baseDmgMin: 8, baseDmgMax: 14 },
    startingRanged: { name: 'Throwing Knives', type: 'ranged', baseDmgMin: 4, baseDmgMax: 8 },
    abilities: [
      { name: 'Cleave', baseDmg: 18, spiritCost: 12, cooldown: 4, description: 'Wide slash hitting all adjacent enemies' },
      { name: 'Lunge', baseDmg: 22, spiritCost: 8, cooldown: 3, description: 'Dash forward with a piercing thrust' },
      { name: 'Blade Storm', baseDmg: 35, spiritCost: 25, cooldown: 10, description: 'Spinning attack hitting everything nearby' },
    ],
    spritePrefix: 'fighter',
  },
  tank: {
    id: 'tank',
    name: 'Tank',
    title: 'Ironwarden',
    description: 'Immovable defender. Highest survivability, crowd control, and threat generation. Slow but devastating.',
    baseStats: { str: 6, dex: 2, int: 2, agi: 3, vit: 12 },
    startingMelee: { name: 'War Mace', type: 'melee', baseDmgMin: 6, baseDmgMax: 12 },
    startingRanged: { name: 'Shield Toss', type: 'ranged', baseDmgMin: 3, baseDmgMax: 6 },
    abilities: [
      { name: 'Shield Slam', baseDmg: 14, spiritCost: 8, cooldown: 3, description: 'Bash with shield, chance to stun' },
      { name: 'Fortify', baseDmg: 0, spiritCost: 15, cooldown: 8, description: 'Restore spirit and boost defense temporarily' },
      { name: 'Earthquake', baseDmg: 28, spiritCost: 30, cooldown: 12, description: 'Ground slam that staggers all nearby enemies' },
    ],
    spritePrefix: 'tank',
  },
  healer: {
    id: 'healer',
    name: 'Healer',
    title: 'Void Mender',
    description: 'Mystic channeler. Strongest abilities, spirit manipulation, and support. Fragile in direct combat.',
    baseStats: { str: 2, dex: 3, int: 10, agi: 4, vit: 6 },
    startingMelee: { name: 'Crystal Scepter', type: 'melee', baseDmgMin: 4, baseDmgMax: 8 },
    startingRanged: { name: 'Void Bolt', type: 'ranged', baseDmgMin: 6, baseDmgMax: 10 },
    abilities: [
      { name: 'Mend', baseDmg: 0, spiritCost: 10, cooldown: 3, description: 'Restore HP to self or ally' },
      { name: 'Spirit Lance', baseDmg: 24, spiritCost: 14, cooldown: 4, description: 'Piercing energy bolt that drains enemy spirit' },
      { name: 'Void Nova', baseDmg: 40, spiritCost: 35, cooldown: 14, description: 'Massive AoE that damages enemies and restores ally spirit' },
    ],
    spritePrefix: 'healer',
  },
  rogue: {
    id: 'rogue',
    name: 'Rogue',
    title: 'Shadow Runner',
    description: 'Swift assassin. Highest speed and critical potential. Dual daggers, evasion, and precision strikes.',
    baseStats: { str: 4, dex: 8, int: 2, agi: 9, vit: 2 },
    startingMelee: { name: 'Twin Daggers', type: 'melee', baseDmgMin: 5, baseDmgMax: 10 },
    startingRanged: { name: 'Wrist Crossbow', type: 'ranged', baseDmgMin: 6, baseDmgMax: 12 },
    abilities: [
      { name: 'Backstab', baseDmg: 28, spiritCost: 10, cooldown: 3, description: 'High damage from behind, bonus if undetected' },
      { name: 'Smoke Bomb', baseDmg: 0, spiritCost: 12, cooldown: 6, description: 'Blind nearby enemies, restoring stealth' },
      { name: 'Death Blossom', baseDmg: 32, spiritCost: 28, cooldown: 10, description: 'Rapid flurry of strikes on all adjacent targets' },
    ],
    spritePrefix: 'rogue',
  },
};

// ── Derived stat calculation ───────────────────────────────────────────

/** Get total stats = class base + player bonus allocations. */
export function getTotalStats(build: PlayerBuild): StatBlock {
  const base = CLASS_DEFINITIONS[build.class].baseStats;
  return {
    str: base.str + build.bonusPoints.str,
    dex: base.dex + build.bonusPoints.dex,
    int: base.int + build.bonusPoints.int,
    agi: base.agi + build.bonusPoints.agi,
    vit: base.vit + build.bonusPoints.vit,
  };
}

/** Calculate all derived combat values from total stats + equipped gear. */
export function derivedStats(build: PlayerBuild): DerivedStats {
  const s   = getTotalStats(build);
  const cls = CLASS_DEFINITIONS[build.class];
  const eq  = build.equipment ?? {};

  // ── Accumulate passive effects from unlocked skill nodes ──────────────
  let nodeStr = 0, nodeDex = 0, nodeInt = 0, nodeAgi = 0, nodeVit = 0;
  let nodeDefense = 0, nodeResist = 0, nodeRegen = 0;
  let nodeAttackSpeedPct = 0, nodeMoveSpeedPct = 0;

  for (const nodeId of build.unlockedNodes) {
    const node = getSkillNode(nodeId);
    if (!node) continue;
    for (const fx of node.effects) {
      switch (fx.type) {
        case 'stat_str':         nodeStr            += fx.value; break;
        case 'stat_dex':         nodeDex            += fx.value; break;
        case 'stat_int':         nodeInt            += fx.value; break;
        case 'stat_agi':         nodeAgi            += fx.value; break;
        case 'stat_vit':         nodeVit            += fx.value; break;
        case 'defense_flat':     nodeDefense        += fx.value; break;
        case 'resist_flat':      nodeResist         += fx.value; break;
        case 'regen_flat':       nodeRegen          += fx.value; break;
        case 'attack_speed_pct': nodeAttackSpeedPct += fx.value; break;
        case 'move_speed_pct':   nodeMoveSpeedPct   += fx.value; break;
      }
    }
  }

  // ── Ring stat bonuses (flat, applied before multipliers) ──────────────
  // Both rings contribute independently. Rings are never destroyed.
  let ringStr = 0, ringDex = 0, ringInt = 0, ringAgi = 0, ringVit = 0;
  for (const ring of [eq.leftRing, eq.rightRing]) {
    const r = ring?.ring;
    if (!r) continue;
    const add = (stat: string, val: number) => {
      if (stat === 'str') ringStr += val;
      else if (stat === 'dex') ringDex += val;
      else if (stat === 'int') ringInt += val;
      else if (stat === 'agi') ringAgi += val;
      else if (stat === 'vit') ringVit += val;
    };
    add(r.stat1, r.bonus1);
    add(r.stat2, r.bonus2);
  }

  // Merge all additive stat bonuses before computing multipliers
  const es = {
    str: s.str + nodeStr + ringStr,
    dex: s.dex + nodeDex + ringDex,
    int: s.int + nodeInt + ringInt,
    agi: s.agi + nodeAgi + ringAgi,
    vit: s.vit + nodeVit + ringVit,
  };

  const strMult = 1 + es.str * STR_DMG_MULT;
  const dexMult = 1 + es.dex * DEX_DMG_MULT;
  const agiCdr  = Math.min(es.agi * AGI_CDR_MULT, 0.5);
  const agiAcc  = Math.min(BASE_ACCURACY + es.agi * AGI_ACC_MULT, 0.98);

  // ── Weapon damage: equipped weapon overrides class starting weapon ─────
  // A broken weapon (durability === 0) falls back to class starting values.
  const meleeWs  = eq.melee?.weaponStats;
  const rangedWs = eq.ranged?.weaponStats;
  const meleeBroken  = meleeWs  ? meleeWs.durability  <= 0 : false;
  const rangedBroken = rangedWs ? rangedWs.durability <= 0 : false;

  const meleeDmgMin = meleeWs && !meleeBroken
    ? Math.round(meleeWs.dmgMin * strMult)
    : Math.round(cls.startingMelee.baseDmgMin * strMult);
  const meleeDmgMax = meleeWs && !meleeBroken
    ? Math.round(meleeWs.dmgMax * strMult)
    : Math.round(cls.startingMelee.baseDmgMax * strMult);

  const rangedDmgMin = rangedWs && !rangedBroken
    ? Math.round(rangedWs.dmgMin * dexMult)
    : Math.round(cls.startingRanged.baseDmgMin * dexMult);
  const rangedDmgMax = rangedWs && !rangedBroken
    ? Math.round(rangedWs.dmgMax * dexMult)
    : Math.round(cls.startingRanged.baseDmgMax * dexMult);

  // ── Attack speed: weapon modifier stacks multiplicatively with AGI ─────
  const weaponSpeedMult = (meleeWs && !meleeBroken) ? meleeWs.attackSpeed : 1.0;
  const attackSpeed = BASE_ATTACK_SPEED
    * weaponSpeedMult
    * (1 + es.agi * AGI_SPEED_MULT)
    * (1 + nodeAttackSpeedPct);

  // ── Armor: sum defense from all three armor slots ──────────────────────
  const armorDefense =
    (eq.helm?.armorStats?.defense  ?? 0) +
    (eq.body?.armorStats?.defense  ?? 0) +
    (eq.legs?.armorStats?.defense  ?? 0);

  // ── Ability crystal: flat damage bonus (sum unique crystals in the slot) ─
  // The GameItem at abilityCrystal slot carries the crystals in the slot manager
  // as a serialised array; at minimum we use the item's own abilityCrystal.dmgBonus.
  // Full CrystalSlotManager inspection would require deserialization — for now
  // we use the single top-level crystal's dmgBonus. If the slot holds multiple
  // crystals they each exist as separate equipped items sharing the slot key
  // (future: query all with slot === 'abilityCrystal').
  const crystalDmgBonus = eq.abilityCrystal?.abilityCrystal?.dmgBonus ?? 0;

  // ── Frequency oscillator passives ─────────────────────────────────────
  // Melee weapon FO: lifesteal % per hit
  const lifestealPct = (meleeWs && !meleeBroken)
    ? (meleeWs.lifestealPct ?? 0) : 0;
  // Ranged weapon FO: team heal per hit
  const teamHealFlat = (rangedWs && !rangedBroken)
    ? (rangedWs.teamHealFlat ?? 0) : 0;
  // Armor FO: HP regen per second (sum all three slots)
  const armorRegen =
    (eq.helm?.armorStats?.hpRegenFlat ?? 0) +
    (eq.body?.armorStats?.hpRegenFlat ?? 0) +
    (eq.legs?.armorStats?.hpRegenFlat ?? 0);

  return {
    maxHp:               BASE_HP + es.vit * HP_PER_VIT,
    maxSpirit:           BASE_SPIRIT + es.vit * SPIRIT_PER_VIT,
    meleeDmgMin,
    meleeDmgMax,
    rangedDmgMin,
    rangedDmgMax,
    abilityDmgMultiplier: 1 + es.int * INT_DMG_MULT,
    abilityDmgBonus:      crystalDmgBonus,
    attackSpeed,
    cooldownReduction:   agiCdr,
    moveSpeed:           BASE_MOVE_SPEED * (1 + es.agi * AGI_MOVE_MULT) * (1 + nodeMoveSpeedPct),
    accuracy:            agiAcc,
    elementalResist:     Math.round(es.vit * VIT_RESIST_MULT) + nodeResist,
    defense:             armorDefense + nodeDefense,
    regenFlat:           nodeRegen + armorRegen,
    lifestealPct,
    teamHealFlat,
  };
}

/** Total bonus points available at a given level. */
export function totalBonusPoints(level: number): number {
  return STARTING_BONUS_POINTS + (level - 1) * POINTS_PER_LEVEL;
}

/** Points currently spent in a build's bonus allocation. */
export function spentPoints(build: PlayerBuild): number {
  const b = build.bonusPoints;
  return b.str + b.dex + b.int + b.agi + b.vit;
}

/** Create a fresh build at level 1 with no bonus points allocated. */
export function createDefaultBuild(
  name: string,
  cls: ClassName,
  body: BodyType,
  element: ElementType,
): PlayerBuild {
  // Tier-1 base nodes for all 3 abilities + aura are unlocked by default.
  const baseNodes = [
    `${cls}.ability.0.t1.base`,
    `${cls}.ability.1.t1.base`,
    `${cls}.ability.2.t1.base`,
    `${cls}.aura.t1.base`,
  ];
  return {
    name,
    class: cls,
    body,
    element,
    level: 1,
    xp: 0,
    bonusPoints: { str: 0, dex: 0, int: 0, agi: 0, vit: 0 },
    unspentPoints: STARTING_BONUS_POINTS,
    skillPoints: STARTING_SKILL_POINTS,
    unlockedNodes: baseNodes,
  };
}