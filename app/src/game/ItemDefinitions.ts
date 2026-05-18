/**
 * ItemDefinitions — PHOBOS item type system.
 *
 * Equipment slots (new layout):
 *   helm, body, legs  — armor (1F 1V each)
 *   melee             — weapon (1F 3V small)
 *   ranged            — weapon (1F 2V medium)
 *   abilityCrystal    — 3-slot crystal manager
 *   leftRing, rightRing — crafted rings (never break)
 *
 * Old slots (gloves, boots, accessory) removed.
 *
 * All crafted equipment uses the CraftingSystem formulas.
 * Rarity still applies to enemy-dropped pre-crafted items.
 */

import type { StatName, ElementType } from './PlayerClasses';
import type { WeaponStats, ArmorStats, WeaponProfile, ArmorStyle } from './CraftingSystem';
import type {
  VortexPhaser, FrequencyOscillator, AbilityCrystal,
  ElementalFragment, RecipeFragment, Ring,
  FragmentSize,
} from './CraftingMods';

// ─── Rarity ──────────────────────────────────────────────────────────────

export type RarityTier = 0 | 1 | 2 | 3 | 4;

export interface RarityDef {
  tier: RarityTier; name: string; color: string; tintColor: number;
  affixSlots: number; dropWeight: number;
}

export const RARITIES: Record<RarityTier, RarityDef> = {
  0: { tier: 0, name: 'Common',    color: '#808080', tintColor: 0x808080, affixSlots: 0, dropWeight: 60 },
  1: { tier: 1, name: 'Uncommon',  color: '#4ade80', tintColor: 0x4ade80, affixSlots: 1, dropWeight: 25 },
  2: { tier: 2, name: 'Rare',      color: '#3b82f6', tintColor: 0x3b82f6, affixSlots: 2, dropWeight: 10 },
  3: { tier: 3, name: 'Epic',      color: '#a855f7', tintColor: 0xa855f7, affixSlots: 3, dropWeight:  4 },
  4: { tier: 4, name: 'Legendary', color: '#f59e0b', tintColor: 0xf59e0b, affixSlots: 4, dropWeight:  1 },
};

// ─── Equipment slots ──────────────────────────────────────────────────────

export type EquipSlot =
  | 'helm' | 'body' | 'legs'
  | 'melee' | 'ranged'
  | 'abilityCrystal'
  | 'leftRing' | 'rightRing';

export const EQUIP_SLOT_NAMES: Record<EquipSlot, string> = {
  helm:           'Helm',
  body:           'Body Armor',
  legs:           'Leg Armor',
  melee:          'Melee Weapon',
  ranged:         'Ranged Weapon',
  abilityCrystal: 'Ability Crystal',
  leftRing:       'Left Ring',
  rightRing:      'Right Ring',
};

// ─── Weapon bases ─────────────────────────────────────────────────────────

export interface WeaponBase {
  id: string; name: string;
  slot: 'melee' | 'ranged';
  category: string;
  profile: WeaponProfile;
  primaryStat: StatName;
  /** Component labels [head, shaft, grip] */
  componentLabels: [string, string, string];
  /** For ranged: 2V medium. For melee: 3V small. */
  vortexLayout: 'melee_3v' | 'ranged_2v';
  /** Ultimate bonus description when all phaser pulses sum to 0 */
  ultimateBonus: string;
}

export const WEAPON_BASES: WeaponBase[] = [
  // ── Melee swords ──
  { id: 'iron_longsword',   name: 'Longsword',      slot: 'melee',  category: 'swords',  profile: 'sword',  primaryStat: 'str', componentLabels: ['Blade','Guard','Grip'],   vortexLayout: 'melee_3v', ultimateBonus: '+25% slash damage, life drain 3%' },
  { id: 'plasma_blade',     name: 'Plasma Blade',   slot: 'melee',  category: 'swords',  profile: 'sword',  primaryStat: 'str', componentLabels: ['Blade','Guard','Grip'],   vortexLayout: 'melee_3v', ultimateBonus: 'Plasma surge on every 3rd hit' },
  { id: 'moon_sabre',       name: 'Moon Sabre',     slot: 'melee',  category: 'swords',  profile: 'sword',  primaryStat: 'agi', componentLabels: ['Blade','Guard','Grip'],   vortexLayout: 'melee_3v', ultimateBonus: 'Attack speed +40%' },
  // ── Melee axes ──
  { id: 'war_axe',          name: 'War Axe',        slot: 'melee',  category: 'axes',    profile: 'axe',    primaryStat: 'str', componentLabels: ['Head','Haft','Grip'],     vortexLayout: 'melee_3v', ultimateBonus: 'Armour shred on hit for 3s' },
  { id: 'crater_cleaver',   name: 'Crater Cleaver', slot: 'melee',  category: 'axes',    profile: 'axe',    primaryStat: 'str', componentLabels: ['Head','Haft','Grip'],     vortexLayout: 'melee_3v', ultimateBonus: 'Blunt damage crits stun for 0.5s' },
  // ── Melee daggers ──
  { id: 'twin_daggers',     name: 'Twin Daggers',   slot: 'melee',  category: 'daggers', profile: 'dagger', primaryStat: 'dex', componentLabels: ['Blade','Guard','Grip'],   vortexLayout: 'melee_3v', ultimateBonus: 'Double-strike chance 25%' },
  { id: 'void_stiletto',    name: 'Void Stiletto',  slot: 'melee',  category: 'daggers', profile: 'dagger', primaryStat: 'dex', componentLabels: ['Blade','Guard','Grip'],   vortexLayout: 'melee_3v', ultimateBonus: 'Pierce ignores 30% armor' },
  // ── Melee staves ──
  { id: 'resonance_staff',  name: 'Resonance Staff',slot: 'melee',  category: 'staves',  profile: 'staff',  primaryStat: 'int', componentLabels: ['Head','Shaft','Grip'],    vortexLayout: 'melee_3v', ultimateBonus: 'Ability cooldowns reduced 20%' },
  { id: 'archive_rod',      name: 'Archive Rod',    slot: 'melee',  category: 'staves',  profile: 'staff',  primaryStat: 'int', componentLabels: ['Head','Shaft','Grip'],    vortexLayout: 'melee_3v', ultimateBonus: 'Spirit regen +2/s' },
  // ── Ranged ──
  { id: 'wrist_crossbow',   name: 'Wrist Crossbow', slot: 'ranged', category: 'ranged',  profile: 'ranged', primaryStat: 'dex', componentLabels: ['Bolt','Body','Stock'],    vortexLayout: 'ranged_2v', ultimateBonus: 'Bolt pierces through enemies' },
  { id: 'void_bolt_caster', name: 'Void Caster',    slot: 'ranged', category: 'ranged',  profile: 'ranged', primaryStat: 'int', componentLabels: ['Crystal','Body','Stock'], vortexLayout: 'ranged_2v', ultimateBonus: 'Void bolts apply Entropy on hit' },
  { id: 'arc_rifle',        name: 'Arc Rifle',      slot: 'ranged', category: 'ranged',  profile: 'ranged', primaryStat: 'dex', componentLabels: ['Tip','Body','Stock'],     vortexLayout: 'ranged_2v', ultimateBonus: 'Arc chains to 2 nearby enemies' },
];

// ─── Armor bases ──────────────────────────────────────────────────────────

export interface ArmorBase {
  id: string; name: string;
  slot: 'helm' | 'body' | 'legs';
  style: ArmorStyle;
  primaryBenefit: StatName;
  /** Two material component labels [main, backing] */
  componentLabels: [string, string];
  ultimateBonus: string;
}

export const ARMOR_BASES: ArmorBase[] = [
  // ── Helms ──
  { id: 'hood',        name: 'Hood',         slot: 'helm', style: 'soft',  primaryBenefit: 'agi', componentLabels: ['Outer','Lining'],   ultimateBonus: 'Dodge chance +8%' },
  { id: 'visor',       name: 'Visor',        slot: 'helm', style: 'plate', primaryBenefit: 'vit', componentLabels: ['Shell','Padding'],   ultimateBonus: 'Pierce resist +20%' },
  { id: 'crown',       name: 'Crown',        slot: 'helm', style: 'scale', primaryBenefit: 'int', componentLabels: ['Plates','Backing'],  ultimateBonus: 'Ability damage +15%' },
  { id: 'mask',        name: 'Mask',         slot: 'helm', style: 'soft',  primaryBenefit: 'dex', componentLabels: ['Face','Inner'],      ultimateBonus: 'Stealth duration +2s' },
  // ── Body ──
  { id: 'tunic',       name: 'Tunic',        slot: 'body', style: 'soft',  primaryBenefit: 'agi', componentLabels: ['Shell','Lining'],    ultimateBonus: 'Movement speed +10%' },
  { id: 'plate',       name: 'Plate',        slot: 'body', style: 'plate', primaryBenefit: 'vit', componentLabels: ['Chest','Backing'],   ultimateBonus: 'Blunt resist +25%' },
  { id: 'robe',        name: 'Robe',         slot: 'body', style: 'soft',  primaryBenefit: 'int', componentLabels: ['Outer','Inner'],     ultimateBonus: 'Cast speed +20%' },
  { id: 'jacket',      name: 'Combat Jacket',slot: 'body', style: 'scale', primaryBenefit: 'dex', componentLabels: ['Shell','Underlayer'],ultimateBonus: 'Ranged damage +12%' },
  // ── Legs ──
  { id: 'greaves',     name: 'Greaves',      slot: 'legs', style: 'plate', primaryBenefit: 'vit', componentLabels: ['Plate','Padding'],   ultimateBonus: 'Knockback immunity' },
  { id: 'trousers',    name: 'Trousers',     slot: 'legs', style: 'soft',  primaryBenefit: 'agi', componentLabels: ['Outer','Liner'],     ultimateBonus: 'Sprint cooldown -30%' },
  { id: 'scale_skirt', name: 'Scale Skirt',  slot: 'legs', style: 'scale', primaryBenefit: 'str', componentLabels: ['Scales','Backing'],  ultimateBonus: 'Slash resist +20%' },
];

// ─── Tint palette (kept from original) ───────────────────────────────────

export const PART_TINT_PALETTE: string[] = [
  '#c0c0c0','#808080','#4a4a4a','#b87333','#cd7f32',
  '#ffd700','#2d1b00','#5c3a1e','#8b4513','#1a1a2e',
  '#c44','#3b82f6','#4ade80','#a855f7','#f59e0b',
  '#e0e0e0','#0f172a','#fef3c7',
];

// ─── Potion sizes ─────────────────────────────────────────────────────────

export type PotionSize = 'small' | 'medium' | 'large' | 'xl';

export interface PotionDef {
  id: string; name: string;
  type: 'hp' | 'sp';
  size: PotionSize;
  healAmount: number;
  color: string;
  spriteKey: string;
  stackMax: number;
  buyPrice: number;
}

export const POTIONS: Record<string, PotionDef> = {
  hp_small:  { id:'hp_small',  name:'HP Potion (S)',  type:'hp', size:'small',  healAmount:30,  color:'#ef4444', spriteKey:'potion-hp-s',  stackMax:20, buyPrice:10 },
  hp_medium: { id:'hp_medium', name:'HP Potion (M)',  type:'hp', size:'medium', healAmount:80,  color:'#ef4444', spriteKey:'potion-hp-m',  stackMax:10, buyPrice:25 },
  hp_large:  { id:'hp_large',  name:'HP Potion (L)',  type:'hp', size:'large',  healAmount:180, color:'#ef4444', spriteKey:'potion-hp-l',  stackMax:5,  buyPrice:60 },
  hp_xl:     { id:'hp_xl',     name:'HP Potion (XL)', type:'hp', size:'xl',     healAmount:400, color:'#ef4444', spriteKey:'potion-hp-xl', stackMax:3,  buyPrice:150 },
  sp_small:  { id:'sp_small',  name:'SP Potion (S)',  type:'sp', size:'small',  healAmount:20,  color:'#6366f1', spriteKey:'potion-sp-s',  stackMax:20, buyPrice:12 },
  sp_medium: { id:'sp_medium', name:'SP Potion (M)',  type:'sp', size:'medium', healAmount:55,  color:'#6366f1', spriteKey:'potion-sp-m',  stackMax:10, buyPrice:30 },
  sp_large:  { id:'sp_large',  name:'SP Potion (L)',  type:'sp', size:'large',  healAmount:120, color:'#6366f1', spriteKey:'potion-sp-l',  stackMax:5,  buyPrice:70 },
  sp_xl:     { id:'sp_xl',     name:'SP Potion (XL)', type:'sp', size:'xl',     healAmount:280, color:'#6366f1', spriteKey:'potion-sp-xl', stackMax:3,  buyPrice:180 },
};

// ─── GameItem (unified type) ──────────────────────────────────────────────

export type GameItemType =
  | 'weapon' | 'armor' | 'potion'
  | 'vortex_phaser' | 'freq_oscillator'
  | 'elemental_fragment' | 'ability_crystal'
  | 'recipe_fragment' | 'ring'
  | 'crafting_material' | 'ether';

export interface GameItem {
  id:       string;     // UUID
  type:     GameItemType;
  name:     string;
  slot:     EquipSlot | null;  // null for non-equipment
  rarity:   RarityTier;
  quantity: number;
  equipped: boolean;

  // ── Weapon fields (type === 'weapon') ─────────────────────────────
  weaponBaseId?: string;
  weaponProfile?: WeaponProfile;
  weaponStats?:  WeaponStats;
  headMatId?:    string;
  shaftMatId?:   string;
  gripMatId?:    string;
  element?:      ElementType | null;
  // Durability (broken item refunds all mods)
  durability?:   number;
  durabilityMax?: number;

  // ── Armor fields (type === 'armor') ───────────────────────────────
  armorBaseId?:  string;
  armorStyle?:   ArmorStyle;
  armorStats?:   ArmorStats;
  mainMatId?:    string;
  backingMatId?: string;

  // ── Mod fields ────────────────────────────────────────────────────
  vortexPhaser?:       VortexPhaser;        // for type vortex_phaser
  freqOscillator?:     FrequencyOscillator; // for type freq_oscillator
  abilityCrystal?:     AbilityCrystal;      // for type ability_crystal
  elementalFragment?:  ElementalFragment;   // for type elemental_fragment
  recipeFragment?:     RecipeFragment;      // for type recipe_fragment
  ring?:               Ring;               // for type ring

  // ── Crafting material ─────────────────────────────────────────────
  materialId?:   string;  // CraftingMaterials id

  // ── Ether (hard currency) ─────────────────────────────────────────
  // quantity field holds ether amount when type === 'ether'

  // ── Visual ───────────────────────────────────────────────────────
  spriteKey?:    string;
  tint?:         number;
}

// ─── Enemy loot tables ────────────────────────────────────────────────────

export type EnemyArchetype = 'training_dummy' | 'minion' | 'warrior' | 'leader' | 'boss';

export interface LootTable {
  archetype:          EnemyArchetype;
  dropChance:         number;  // chance to drop anything at all
  etherMin:           number;  // ether currency drop range
  etherMax:           number;
  etherChance:        number;
  potionChance:       number;
  potionSizes:        PotionSize[];  // which sizes this tier can drop
  materialChance:     number;        // chance to drop a tier-1 crafting material
  materialLines:      string[];      // which lines (by line key from CraftingMaterials)
  fragChance:         number;        // recipe fragment drop chance
  fragPart:           1 | 2 | 3 | null;  // which part; null = boss (drops all weapon frags)
  elemFragChance:     number;
  elemFragSize:       FragmentSize;
  vortexChance:       number;
  freqOscChance:      number;
  weaponDropChance:   number;  // chance for a full pre-built weapon drop
  maxRarity:          RarityTier;
  // Very rare: special material head weapon
  specialWeaponChance: number;
}

export const LOOT_TABLES: Record<EnemyArchetype, LootTable> = {
  training_dummy: {
    archetype: 'training_dummy',
    dropChance: 0.30, etherMin: 1, etherMax: 5,   etherChance: 0.40,
    potionChance: 0.25, potionSizes: ['small'],
    materialChance: 0.20, materialLines: ['cloth','pelt','palewood'],
    fragChance: 0.05, fragPart: 1,
    elemFragChance: 0.10, elemFragSize: 'small',
    vortexChance: 0.02, freqOscChance: 0.01,
    weaponDropChance: 0.05, maxRarity: 1, specialWeaponChance: 0,
  },
  minion: {
    archetype: 'minion',
    dropChance: 0.55, etherMin: 3, etherMax: 12,  etherChance: 0.55,
    potionChance: 0.30, potionSizes: ['small','medium'],
    materialChance: 0.45, materialLines: ['cloth','pelt','slough','lightstone','roughstone','palewood','heartwood'],
    fragChance: 0.12, fragPart: 1,
    elemFragChance: 0.25, elemFragSize: 'small',
    vortexChance: 0.04, freqOscChance: 0.02,
    weaponDropChance: 0.08, maxRarity: 2, specialWeaponChance: 0.001,
  },
  warrior: {
    archetype: 'warrior',
    dropChance: 0.65, etherMin: 8, etherMax: 25,  etherChance: 0.65,
    potionChance: 0.35, potionSizes: ['small','medium','large'],
    materialChance: 0.55, materialLines: ['pelt','slough','roughstone','darkstone','heartwood','deepwood'],
    fragChance: 0.15, fragPart: 2,
    elemFragChance: 0.30, elemFragSize: 'medium',
    vortexChance: 0.06, freqOscChance: 0.04,
    weaponDropChance: 0.10, maxRarity: 3, specialWeaponChance: 0.003,
  },
  leader: {
    archetype: 'leader',
    dropChance: 0.80, etherMin: 20, etherMax: 60, etherChance: 0.80,
    potionChance: 0.50, potionSizes: ['medium','large','xl'],
    materialChance: 0.70, materialLines: ['slough','lightstone','roughstone','darkstone','heartwood','deepwood'],
    fragChance: 0.20, fragPart: 3,
    elemFragChance: 0.45, elemFragSize: 'large',
    vortexChance: 0.10, freqOscChance: 0.07,
    weaponDropChance: 0.15, maxRarity: 3, specialWeaponChance: 0.008,
  },
  boss: {
    archetype: 'boss',
    dropChance: 1.00, etherMin: 60, etherMax: 200, etherChance: 1.00,
    potionChance: 0.80, potionSizes: ['large','xl'],
    materialChance: 0.90, materialLines: ['darkstone','lightstone','roughstone','slough','deepwood'],
    fragChance: 1.00, fragPart: null,  // drops all 3 weapon recipe frags
    elemFragChance: 0.85, elemFragSize: 'large',
    vortexChance: 0.25, freqOscChance: 0.20,
    weaponDropChance: 0.40, maxRarity: 4, specialWeaponChance: 0.04,
  },
};

// ─── WeaponAssembly (visual compositor data — kept for WeaponCompositor) ─

export interface WeaponAssembly {
  parts: Array<{
    category: string;   // 'blade', 'guard', 'grip' etc.
    variantId: string;  // 'blade-01'
    tint: string;       // hex color
  }>;
  compositeKey: string; // unique texture key for the baked sprite
}

export interface ArmorDye {
  primary: string;
  accent:  string;
}
