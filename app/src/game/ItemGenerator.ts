/**
 * ItemGenerator — Generates GameItems from loot tables and crafting recipes.
 *
 * Enemy loot: call generateLoot(archetype, element, rng) → GameItem[]
 * Crafting:   call craftWeapon(...) / craftArmor(...) → GameItem
 * Crystal:    call generateCrystal(element, size, rng) → GameItem
 * Ring:       call craftRing(element, inventory, rng) → GameItem | null
 */

import type { GameItem, EnemyArchetype, PotionSize } from './ItemDefinitions';
import {
  LOOT_TABLES, WEAPON_BASES, ARMOR_BASES, POTIONS,
} from './ItemDefinitions';
import type { MaterialProps, MaterialLine } from './CraftingMaterials';
import { DROPPABLE_MATERIALS, MATERIAL_BY_ID, CRAFTABLE_MATERIALS,
  getMaterialsForRole, canFillRole } from './CraftingMaterials';
import type { WeaponProfile, ArmorStyle } from './CraftingSystem';
import { computeWeaponStats, computeArmorStats, rollDropQuality, rollCraftQuality } from './CraftingSystem';
import {
  generateVortexPhaser, generateFreqOscillator,
  generateAbilityCrystal, generateRing,
  type FragmentSize, type CrystalSize, type SlotSize, type RecipeTarget,
  type RecipeFragment, type ElementalFragment,
} from './CraftingMods';
import type { ElementType } from './PlayerClasses';
import { SPECIAL_MATERIALS } from './CraftingMaterials';

// ─── Seeded random helper ─────────────────────────────────────────────────

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

function roll(chance: number, rng: () => number): boolean {
  return rng() < chance;
}

// ─── Unique ID ────────────────────────────────────────────────────────────

function uid(): string {
  return typeof crypto !== 'undefined'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

// ─── LOOT GENERATION ─────────────────────────────────────────────────────

/**
 * Generate the full loot drop for an enemy kill.
 * Returns an array of GameItems (may be empty if nothing drops).
 */
export function generateLoot(
  archetype: EnemyArchetype,
  enemyElement: ElementType,
  rng: () => number
): GameItem[] {
  const table = LOOT_TABLES[archetype];
  const drops: GameItem[] = [];

  if (!roll(table.dropChance, rng)) return drops;

  // ── Ether ────────────────────────────────────────────────────────────
  if (roll(table.etherChance, rng)) {
    const amount = Math.round(
      table.etherMin + rng() * (table.etherMax - table.etherMin)
    );
    drops.push({
      id: uid(), type: 'ether', name: `${amount} Ether`,
      slot: null, rarity: 0, quantity: amount, equipped: false,
      tint: 0xffdd44,
    });
  }

  // ── Potion ───────────────────────────────────────────────────────────
  if (roll(table.potionChance, rng)) {
    const size: PotionSize = pick(table.potionSizes, rng);
    const isHp = rng() > 0.4;
    const key  = `${isHp ? 'hp' : 'sp'}_${size}`;
    const def  = POTIONS[key];
    if (def) {
      drops.push({
        id: uid(), type: 'potion', name: def.name,
        slot: null, rarity: 0, quantity: 1, equipped: false,
        spriteKey: def.spriteKey, tint: isHp ? 0xef4444 : 0x6366f1,
      });
    }
  }

  // ── Crafting material ────────────────────────────────────────────────
  if (roll(table.materialChance, rng)) {
    const eligibleLines = DROPPABLE_MATERIALS.filter(
      m => table.materialLines.includes(m.line)
    );
    if (eligibleLines.length > 0) {
      const mat = pick(eligibleLines, rng);
      drops.push({
        id: uid(), type: 'crafting_material', name: mat.dropName,
        slot: null, rarity: 0, quantity: 1, equipped: false,
        materialId: mat.id, tint: mat.tint,
      });
    }
  }

  // ── Elemental fragment ───────────────────────────────────────────────
  if (roll(table.elemFragChance, rng)) {
    const frag: ElementalFragment = {
      id: uid(), element: enemyElement,
      size: table.elemFragSize, qty: 1,
    };
    drops.push({
      id: uid(), type: 'elemental_fragment',
      name: `${enemyElement} Fragment (${table.elemFragSize})`,
      slot: null, rarity: 1, quantity: 1, equipped: false,
      elementalFragment: frag,
      tint: elementTint(enemyElement),
    });
  }

  // ── Recipe fragment ───────────────────────────────────────────────────
  if (roll(table.fragChance, rng)) {
    if (archetype === 'boss') {
      // Boss drops all 3 weapon recipe fragment parts
      for (const part of [1, 2, 3] as const) {
        const target = rng() > 0.5 ? 'melee_recipe' : 'ranged_recipe';
        const frag: RecipeFragment = { id: uid(), target, part, qty: 1 };
        drops.push({
          id: uid(), type: 'recipe_fragment',
          name: `${target === 'melee_recipe' ? 'Melee' : 'Ranged'} Recipe Fragment (${part}/3)`,
          slot: null, rarity: 2, quantity: 1, equipped: false,
          recipeFragment: frag, tint: 0xf59e0b,
        });
      }
    } else if (table.fragPart !== null) {
      const armorTargets: RecipeTarget[] = ['helm', 'body', 'legs'];
      const target = pick(armorTargets, rng);
      const frag: RecipeFragment = { id: uid(), target, part: table.fragPart, qty: 1 };
      drops.push({
        id: uid(), type: 'recipe_fragment',
        name: `${target} Recipe Fragment (${table.fragPart}/3)`,
        slot: null, rarity: 1, quantity: 1, equipped: false,
        recipeFragment: frag, tint: 0xf59e0b,
      });
    }
  }

  // ── Vortex phaser ─────────────────────────────────────────────────────
  if (roll(table.vortexChance, rng)) {
    const sizePool: SlotSize[] = archetype === 'boss'
      ? ['small','medium','large']
      : archetype === 'leader'
      ? ['small','medium']
      : ['small'];
    const phaser = generateVortexPhaser(rng, pick(sizePool, rng));
    drops.push({
      id: uid(), type: 'vortex_phaser',
      name: `Vortex Phaser (${phaser.slotSize})`,
      slot: null, rarity: 2, quantity: 1, equipped: false,
      vortexPhaser: phaser, tint: phaser.tint,
    });
  }

  // ── Frequency oscillator ──────────────────────────────────────────────
  if (roll(table.freqOscChance, rng)) {
    const fo = generateFreqOscillator(rng);
    drops.push({
      id: uid(), type: 'freq_oscillator',
      name: 'Frequency Oscillator',
      slot: null, rarity: 2, quantity: 1, equipped: false,
      freqOscillator: fo, tint: 0x00ffcc,
    });
  }

  // ── Pre-crafted weapon drop ────────────────────────────────────────────
  if (roll(table.weaponDropChance, rng)) {
    // Occasionally use a special material head
    const useSpecial = roll(table.specialWeaponChance / table.weaponDropChance, rng)
      && SPECIAL_MATERIALS.length > 0;
    const weapon = generateDroppedWeapon(enemyElement, rng, useSpecial);
    if (weapon) drops.push(weapon);
  }

  return drops;
}

// ─── WEAPON GENERATION ───────────────────────────────────────────────────

/**
 * Generate a pre-crafted weapon as an enemy drop.
 * Quality skews poor unless specialHead is true.
 */
export function generateDroppedWeapon(
  element: ElementType,
  rng: () => number,
  useSpecialHead = false
): GameItem | null {
  const base = pick(WEAPON_BASES, rng);
  const profile = base.profile;
  const quality = useSpecialHead
    ? 0.60 + rng() * 0.35      // special: 0.60–0.95
    : rollDropQuality(rng);

  // Head material
  const headRole = 'head';
  let headMat: MaterialProps;
  if (useSpecialHead) {
    headMat = pick(SPECIAL_MATERIALS, rng);
  } else {
    const heads = getMaterialsForRole(headRole);
    headMat = heads.length > 0 ? pick(heads, rng) : CRAFTABLE_MATERIALS[0];
  }

  // Shaft
  const shaftMats = getMaterialsForRole('shaft');
  const shaftMat  = shaftMats.length > 0 ? pick(shaftMats, rng) : CRAFTABLE_MATERIALS[0];

  // Grip
  const gripMats = getMaterialsForRole('grip');
  const gripMat  = gripMats.length > 0 ? pick(gripMats, rng) : CRAFTABLE_MATERIALS[0];

  const stats = computeWeaponStats(headMat, shaftMat, gripMat, profile, quality, element);

  const rarity: 0|1|2|3|4 = useSpecialHead ? 3
    : quality >= 0.80 ? 2
    : quality >= 0.50 ? 1
    : 0;

  return {
    id: uid(), type: 'weapon', name: buildWeaponName(headMat, base.name, rarity),
    slot: base.slot, rarity, quantity: 1, equipped: false,
    weaponBaseId: base.id, weaponProfile: profile,
    weaponStats: stats,
    headMatId:  headMat.id,
    shaftMatId: shaftMat.id,
    gripMatId:  gripMat.id,
    element, durability: stats.durability, durabilityMax: stats.durabilityMax,
    tint: headMat.tint,
  };
}

/**
 * Craft a weapon from chosen materials. Returns the GameItem.
 */
export function craftWeapon(
  baseId:    string,
  headMatId: string,
  shaftMatId: string,
  gripMatId:  string,
  element:   ElementType,
  rng:       () => number
): GameItem | null {
  const base     = WEAPON_BASES.find(w => w.id === baseId);
  const headMat  = MATERIAL_BY_ID.get(headMatId);
  const shaftMat = MATERIAL_BY_ID.get(shaftMatId);
  const gripMat  = MATERIAL_BY_ID.get(gripMatId);
  if (!base || !headMat || !shaftMat || !gripMat) return null;

  // Validate roles
  if (!canFillRole(headMat, 'head'))  return null;
  if (!canFillRole(shaftMat, 'shaft') && !canFillRole(shaftMat, 'hilt')) return null;
  if (!canFillRole(gripMat, 'grip'))  return null;

  const quality = rollCraftQuality(rng);
  const stats   = computeWeaponStats(headMat, shaftMat, gripMat, base.profile, quality, element);
  const rarity: 0|1|2|3|4 = quality >= 0.90 ? 3 : quality >= 0.70 ? 2 : quality >= 0.45 ? 1 : 0;

  return {
    id: uid(), type: 'weapon', name: buildWeaponName(headMat, base.name, rarity),
    slot: base.slot, rarity, quantity: 1, equipped: false,
    weaponBaseId: base.id, weaponProfile: base.profile,
    weaponStats: stats,
    headMatId, shaftMatId, gripMatId,
    element, durability: stats.durability, durabilityMax: stats.durabilityMax,
    tint: headMat.tint,
  };
}

/**
 * Craft an armor piece.
 */
export function craftArmor(
  baseId:     string,
  mainMatId:  string,
  backingMatId: string,
  rng:        () => number
): GameItem | null {
  const base       = ARMOR_BASES.find(a => a.id === baseId);
  const mainMat    = MATERIAL_BY_ID.get(mainMatId);
  const backingMat = MATERIAL_BY_ID.get(backingMatId);
  if (!base || !mainMat || !backingMat) return null;

  if (!canFillRole(mainMat, 'armor_main'))    return null;
  if (!canFillRole(backingMat, 'armor_backing') && !canFillRole(backingMat, 'armor_main')) return null;

  const quality = rollCraftQuality(rng);
  const stats   = computeArmorStats(mainMat, backingMat, base.style, quality);
  const rarity: 0|1|2|3|4 = quality >= 0.90 ? 3 : quality >= 0.70 ? 2 : quality >= 0.45 ? 1 : 0;

  return {
    id: uid(), type: 'armor', name: `${mainMat.name} ${base.name}`,
    slot: base.slot, rarity, quantity: 1, equipped: false,
    armorBaseId: base.id, armorStyle: base.style,
    armorStats: stats,
    mainMatId, backingMatId,
    durability: stats.durability, durabilityMax: stats.durabilityMax,
    tint: mainMat.tint,
  };
}

// ─── CRYSTAL GENERATION ──────────────────────────────────────────────────

export function generateCrystal(
  element: ElementType,
  size: CrystalSize,
  rng: () => number
): GameItem {
  const crystal = generateAbilityCrystal(element, size, rng);
  return {
    id: uid(), type: 'ability_crystal',
    name: `${element} Crystal (${size})`,
    slot: 'abilityCrystal', rarity: 2, quantity: 1, equipped: false,
    abilityCrystal: crystal, tint: elementTint(element),
  };
}

// ─── RING CRAFTING ────────────────────────────────────────────────────────

/**
 * Attempt to craft a ring. Returns the ring item or null if not enough materials.
 * Caller is responsible for consuming materials from inventory on success.
 */
export function craftRing(
  element: ElementType,
  inventory: GameItem[],
  rng: () => number
): GameItem | null {
  // Count shards
  const shards = inventory.filter(
    i => i.type === 'elemental_fragment' && i.elementalFragment?.element === element
  );
  const totalShards = shards.reduce((a, i) => a + i.quantity, 0);

  const freqCount = inventory.filter(i => i.type === 'freq_oscillator').length;
  const vortexCount = inventory.filter(i => i.type === 'vortex_phaser').length;

  if (totalShards < 20 || freqCount < 5 || vortexCount < 10) return null;

  const ring = generateRing(element, rng);
  return {
    id: uid(), type: 'ring',
    name: `${element} Ring`,
    slot: null, rarity: 3, quantity: 1, equipped: false,
    ring, tint: elementTint(element),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function buildWeaponName(head: MaterialProps, baseName: string, rarity: number): string {
  const prefixes: Record<number, string> = { 0: '', 1: 'Refined', 2: 'Superior', 3: 'Exalted', 4: 'Legendary' };
  const prefix = prefixes[rarity] ?? '';
  return `${prefix} ${head.name} ${baseName}`.trim().replace(/  +/g, ' ');
}

function elementTint(el: ElementType): number {
  const map: Record<ElementType, number> = {
    plasma: 0xc080ff, fire: 0xff6020, ice: 0x60d0ff,
    lightning: 0xffe040, void: 0x8040c0,
  };
  return map[el] ?? 0xffffff;
}
