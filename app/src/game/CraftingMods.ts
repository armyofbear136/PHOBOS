/**
 * CraftingMods — Vortex Phasers, Frequency Oscillators, Ability Crystals,
 *                Elemental Fragments, Recipe Fragments, Rings.
 *
 * ── VORTEX PHASERS ─────────────────────────────────────────────────────────
 * Rare drop 2. Each has a random pulse in range (-1, 1) exclusive.
 * Slot sizes: small (additive), medium (multiplicative), large (exponential).
 * Ultimate bonus: if the SUM of all phaser pulses on one item == 0 exactly,
 * the item's baked ultimate bonus activates.
 *
 * ── FREQUENCY OSCILLATORS ──────────────────────────────────────────────────
 * Rare drop 1. One per item slot. Same physical item, different effect by slot:
 *   melee  → lifesteal % (value * 3)
 *   ranged → team heal per hit (value * 2)
 *   armor  → hp regen /s (value * 1)
 * value is a rolled float 0.1–1.0.
 *
 * ── ABILITY CRYSTALS ───────────────────────────────────────────────────────
 * 3 sizes: small (1 slot), medium (2 slots), large (3 slots).
 * Slot capacity: 3 small OR 2 medium (uses 2/3) OR 1 large.
 * Crafted via shard randomiser: N shards of element → 1 random crystal of that size.
 * No durability damage.
 * Effects: elemental damage bonus + one inspired bonus per element.
 *
 * ── ELEMENTAL FRAGMENTS ────────────────────────────────────────────────────
 * S/M/L sizes. Drop from enemies of matching element per tier:
 *   Minion → small, Warrior → medium, Leader/Boss → large
 * Combined into crystal randomiser.
 *
 * ── RECIPE FRAGMENTS ───────────────────────────────────────────────────────
 * Part 1 drops from Minions, Part 2 from Warriors, Part 3 from Leaders.
 * Three armor recipes: helm, body, legs.
 * Bosses drop weapon recipe fragments (melee + ranged variants, 3 each).
 * Collecting all 3 parts unlocks a full recipe in the crafting book.
 *
 * ── RINGS ──────────────────────────────────────────────────────────────────
 * Two slots: leftRing, rightRing.
 * Crafted from: 20 elemental shards (any size) + 5 FreqOsc + 10 VortexPhasers.
 * Never destroyed. Give meaningful flat stat bonuses.
 */

import type { ElementType } from './PlayerClasses';
import type { StatName } from './PlayerClasses';

// ─── Slot sizes ───────────────────────────────────────────────────────────

export type SlotSize = 'small' | 'medium' | 'large';

// ─── Vortex Phaser ────────────────────────────────────────────────────────

export interface VortexPhaser {
  id:       string;         // uuid
  slotSize: SlotSize;
  pulse:    number;         // -0.999 < pulse < 0.999 (never exactly ±1 or 0 by default)
  tint:     number;         // visual colour keyed to pulse polarity
}

/** Generate a new vortex phaser with a seeded random pulse */
export function generateVortexPhaser(rng: () => number, slotSize: SlotSize): VortexPhaser {
  // pulse in (-0.999, -0.05) ∪ (0.05, 0.999) — never near zero (to make ultimate non-trivial)
  let pulse = (rng() * 1.898) - 0.949;  // rough range
  if (Math.abs(pulse) < 0.05) pulse = pulse < 0 ? -0.05 : 0.05;
  const tint = pulse > 0 ? 0x44aaff : 0xff4444;
  return { id: crypto.randomUUID(), slotSize, pulse: +pulse.toFixed(4), tint };
}

/** Pulse display string */
export function phaserPulseLabel(p: VortexPhaser): string {
  return `${p.pulse > 0 ? '+' : ''}${(p.pulse * 100).toFixed(1)}`;
}

/** Slot bonus description */
export function phaserBonusDesc(p: VortexPhaser): string {
  switch (p.slotSize) {
    case 'small':  return `Additive ${phaserPulseLabel(p)}% to damage`;
    case 'medium': return `Multiplicative ${phaserPulseLabel(p)}% to damage`;
    case 'large':  return `Exponential ${phaserPulseLabel(p)}% to defense`;
  }
}

// ─── Frequency Oscillator ────────────────────────────────────────────────

export type OscillatorSlot = 'melee' | 'ranged' | 'armor';

export interface FrequencyOscillator {
  id:    string;
  value: number;           // 0.1–1.0 rolled on drop
  tint:  number;
}

export function generateFreqOscillator(rng: () => number): FrequencyOscillator {
  const value = 0.1 + rng() * 0.9;
  return { id: crypto.randomUUID(), value: +value.toFixed(3), tint: 0x00ffcc };
}

export function oscEffectDesc(fo: FrequencyOscillator, slot: OscillatorSlot): string {
  switch (slot) {
    case 'melee':  return `Lifesteal: +${(fo.value * 3).toFixed(1)}% on hit`;
    case 'ranged': return `Team heal: +${(fo.value * 2).toFixed(1)} HP/hit`;
    case 'armor':  return `HP Regen: +${fo.value.toFixed(2)}/s`;
  }
}

// ─── Elemental Fragment ───────────────────────────────────────────────────

export type FragmentSize = 'small' | 'medium' | 'large';

export interface ElementalFragment {
  id:      string;
  element: ElementType;
  size:    FragmentSize;
  qty:     number;         // stack count in inventory
}

// Shards needed per crystal size
export const CRYSTAL_SHARD_COST: Record<FragmentSize, number> = {
  small: 3, medium: 6, large: 12,
};

// ─── Ability Crystal ─────────────────────────────────────────────────────

export type CrystalSize = 'small' | 'medium' | 'large';
// Slot consumption: small=1, medium=2, large=3
export const CRYSTAL_SLOT_COST: Record<CrystalSize, number> = {
  small: 1, medium: 2, large: 3,
};
export const CRYSTAL_TOTAL_SLOTS = 3;

export interface AbilityCrystal {
  id:          string;
  element:     ElementType;
  size:        CrystalSize;
  // Elemental ability bonuses — flat values, scaled by crystal size
  dmgBonus:    number;     // added to ability damage (no status effect applied)
  inspiredBonus: AbilityInspiredBonus;
}

export type AbilityInspiredBonus =
  | { type: 'aoe_bolts';    count: number; element: ElementType }   // on contact: fire bolts in 360
  | { type: 'lifedrain';    pct: number }                           // % of ability dmg as heal
  | { type: 'speed_burst';  duration: number }                      // ms movement speed boost
  | { type: 'chain';        targets: number; element: ElementType } // chain to N targets
  | { type: 'shield';       amount: number }                        // temp shield HP
  | { type: 'cooldown_cut'; pct: number };                          // reduce next cooldown

const INSPIRED_BY_ELEMENT: Record<ElementType, (size: CrystalSize, rng: () => number) => AbilityInspiredBonus> = {
  fire:      (sz, _r) => ({ type: 'aoe_bolts',    count: sz === 'large' ? 8 : sz === 'medium' ? 6 : 4, element: 'fire' }),
  ice:       (sz, _r) => ({ type: 'aoe_bolts',    count: sz === 'large' ? 6 : 4, element: 'ice' }),
  lightning: (sz, _r) => ({ type: 'chain',        targets: sz === 'large' ? 3 : sz === 'medium' ? 2 : 1, element: 'lightning' }),
  void:      (sz, _r) => ({ type: 'lifedrain',    pct: sz === 'large' ? 0.15 : sz === 'medium' ? 0.10 : 0.05 }),
  plasma:    (sz, _r) => ({ type: 'shield',       amount: sz === 'large' ? 30 : sz === 'medium' ? 20 : 10 }),
};

const DMG_BY_SIZE: Record<CrystalSize, number> = { small: 8, medium: 18, large: 35 };

export function generateAbilityCrystal(
  element: ElementType,
  size: CrystalSize,
  rng: () => number
): AbilityCrystal {
  return {
    id: crypto.randomUUID(),
    element, size,
    dmgBonus:      DMG_BY_SIZE[size] + Math.floor(rng() * 8),
    inspiredBonus: INSPIRED_BY_ELEMENT[element](size, rng),
  };
}

/** Crystal slot capacity helper */
export class CrystalSlotManager {
  private slots: (AbilityCrystal | null)[] = [null, null, null];

  canInsert(crystal: AbilityCrystal): boolean {
    const cost = CRYSTAL_SLOT_COST[crystal.size];
    let free = 0;
    for (const s of this.slots) if (s === null) free++;
    return free >= cost;
  }

  insert(crystal: AbilityCrystal): boolean {
    if (!this.canInsert(crystal)) return false;
    const cost = CRYSTAL_SLOT_COST[crystal.size];
    let filled = 0;
    for (let i = 0; i < this.slots.length && filled < cost; i++) {
      if (this.slots[i] === null) { this.slots[i] = crystal; filled++; }
    }
    return true;
  }

  removeAt(slotIndex: number): AbilityCrystal | null {
    const c = this.slots[slotIndex];
    if (!c) return null;
    // Remove all slots occupied by this crystal instance
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i] === c) this.slots[i] = null;
    }
    return c;
  }

  getSlots(): readonly (AbilityCrystal | null)[] { return this.slots; }
  getUnique(): AbilityCrystal[] {
    return [...new Set(this.slots.filter((s): s is AbilityCrystal => s !== null))];
  }
}

// ─── Recipe Fragments ────────────────────────────────────────────────────

export type RecipeTarget =
  | 'helm' | 'body' | 'legs'          // armor — parts from minion/warrior/leader
  | 'melee_recipe' | 'ranged_recipe';  // weapons — all 3 parts from boss

export interface RecipeFragment {
  id:     string;
  target: RecipeTarget;
  part:   1 | 2 | 3;
  qty:    number;
}

export function isRecipeComplete(
  frags: RecipeFragment[],
  target: RecipeTarget
): boolean {
  const parts = new Set(frags.filter(f => f.target === target).map(f => f.part));
  return parts.has(1) && parts.has(2) && parts.has(3);
}

// ─── Rings ────────────────────────────────────────────────────────────────

export interface Ring {
  id:      string;
  element: ElementType;
  stat1:   StatName; bonus1: number;
  stat2:   StatName; bonus2: number;
  special: string;   // short description of the ring's passive
}

// Ring stat bonuses by element
const RING_STATS: Record<ElementType, { s1: StatName; s2: StatName; special: string }> = {
  plasma:    { s1: 'str', s2: 'vit', special: 'Plasma bolts deal +12% damage' },
  fire:      { s1: 'str', s2: 'agi', special: 'Burn ticks deal +15% damage' },
  ice:       { s1: 'int', s2: 'vit', special: 'Slow duration +1s' },
  lightning: { s1: 'dex', s2: 'agi', special: 'Lightning arc range +25%' },
  void:      { s1: 'int', s2: 'dex', special: 'Entropy stacks apply 10% faster' },
};

export function generateRing(element: ElementType, rng: () => number): Ring {
  const def = RING_STATS[element];
  const roll = (min: number, max: number) => Math.round(min + rng() * (max - min));
  return {
    id: crypto.randomUUID(), element,
    stat1: def.s1, bonus1: roll(4, 8),
    stat2: def.s2, bonus2: roll(3, 6),
    special: def.special,
  };
}

// Ring craft cost constants
export const RING_CRAFT_COST = {
  shards:   20,
  freqOsc:   5,
  vortex:   10,
};
