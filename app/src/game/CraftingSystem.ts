/**
 * CraftingSystem — Derives all weapon and armor stats from material properties.
 *
 * Formulas adapted from Primal Online Crafting Compendium.
 * Simplified for PHOBOS: no skill tree system, no component volumes.
 * Instead quality (0.0–1.0) acts as the unified CC/CB modifier.
 *
 * WEAPON STAT DERIVATION
 * ─────────────────────
 * Inputs: head material, shaft material, grip material, quality 0–1
 *
 * Swing speed proxy:
 *   swingSpeed = 1.0 / sqrt((head.rho * 2 + shaft.rho) / 3)
 *   (lighter materials = faster swing, normalised around baseline rho ~0.8)
 *
 * Edge Retention Factor (from compendium §1.2):
 *   erf = hv / sqrt(cv * 100)
 *
 * Structural Integrity Factor:
 *   sif = sqrt(uts * cv) / 100
 *
 * Slash damage:
 *   slash = (head.erf * head.hv * 0.004) * swingSpeed * quality
 *
 * Pierce damage:
 *   pierce = (head.hv * 0.003 + head.uts * 0.001) * swingSpeed * quality
 *
 * Blunt damage:
 *   blunt = (head.rho * head.cv * 0.08) * swingSpeed * quality
 *
 * Combined damage output (exposed to player as dmgMin/dmgMax):
 *   base = slash * edgeProfile + pierce * pointGeometry + blunt * bluntGeometry
 *   dmgMin = base * 0.85
 *   dmgMax = base * 1.15
 *
 * Durability:
 *   durability = (head.sif * 80 + shaft.sif * 40) * quality
 *
 * Attack speed modifier (normalised, 1.0 = baseline):
 *   attackSpeed = swingSpeed
 *
 * Crit chance:
 *   crit = (head.hv / 10000 + 0.02) * quality
 *
 * ARMOR STAT DERIVATION
 * ─────────────────────
 * Inputs: main material, backing material, quality 0–1
 * Style-specific weights from Primal Compendium §8.3 adapted to 2 material slots.
 *
 * For PHOBOS we derive 3 composite resistance values:
 *   slashResist  = (main.hv * w_sh + main.cv * w_sc) * quality
 *   pierceResist = (main.hv * w_ph + main.rho * w_pd + backing.cv * 0.1) * quality
 *   bluntResist  = (main.cv * w_bt + backing.cv * w_bb) * quality
 *
 * These map to defense (averaged) and element-specific bonuses.
 *
 * VORTEX PHASER INTEGRATION
 * ─────────────────────────
 * After base stats, apply each phaser in its slot:
 *   small  (3V weapon): additive only — value added to relevant stat
 *   medium (2V weapon): multiplicative — stat *= (1 + value * 0.5)
 *   large  (1V armor) : exponential    — stat ^= (1 + value * 0.15)
 *
 * Ultimate bonus trigger: if sum of all phaser pulses on an item == 0.0 exactly
 *   → apply item's baked ultimateBonus (see CraftingRecipes)
 *
 * FREQUENCY OSCILLATOR INTEGRATION
 * ──────────────────────────────────
 * One per item slot. Effect is role-specific:
 *   melee   → lifesteal % = oscillatorValue * 3
 *   ranged  → team heal/hit = oscillatorValue * 2
 *   armor   → hp regen/s   = oscillatorValue * 1
 */

import type { MaterialProps } from './CraftingMaterials';
import type { VortexPhaser, FrequencyOscillator, SlotSize } from './CraftingMods';
import type { ElementType } from './PlayerClasses';

// ─── Weapon geometry profiles ─────────────────────────────────────────────
// Mapped to PHOBOS weapon categories

export type WeaponProfile = 'sword' | 'axe' | 'dagger' | 'staff' | 'ranged';

const WEAPON_PROFILES: Record<WeaponProfile, {
  edgeProfile: number; pointGeometry: number; bluntGeometry: number;
}> = {
  sword:  { edgeProfile: 1.0,  pointGeometry: 0.70, bluntGeometry: 0.35 },
  axe:    { edgeProfile: 0.80, pointGeometry: 0.20, bluntGeometry: 0.65 },
  dagger: { edgeProfile: 1.0,  pointGeometry: 0.85, bluntGeometry: 0.15 },
  staff:  { edgeProfile: 0.20, pointGeometry: 0.30, bluntGeometry: 0.80 },
  ranged: { edgeProfile: 0.10, pointGeometry: 1.00, bluntGeometry: 0.10 },
};

// ─── Armor style weights ──────────────────────────────────────────────────
// From Primal Compendium §8.3, condensed for our 2-material system

export type ArmorStyle = 'soft' | 'scale' | 'plate';

const ARMOR_WEIGHTS: Record<ArmorStyle, {
  w_sh: number; w_sc: number;  // slash: hv weight, cv weight
  w_ph: number; w_pd: number;  // pierce: hv weight, density weight
  w_bt: number; w_bb: number;  // blunt: main cv weight, backing cv weight
}> = {
  soft:  { w_sh: 0.10, w_sc: 0.60, w_ph: 0.10, w_pd: 0.20, w_bt: 0.40, w_bb: 0.60 },
  scale: { w_sh: 0.50, w_sc: 0.25, w_ph: 0.30, w_pd: 0.30, w_bt: 0.20, w_bb: 0.50 },
  plate: { w_sh: 0.70, w_sc: 0.20, w_ph: 0.50, w_pd: 0.35, w_bt: 0.20, w_bb: 0.30 },
};

// ─── Derived weapon stats ─────────────────────────────────────────────────

export interface WeaponStats {
  dmgMin:        number;
  dmgMax:        number;
  attackSpeed:   number; // 1.0 = baseline
  critChance:    number; // 0–1
  durability:    number;
  durabilityMax: number;
  weight:        number; // kg proxy
  // Mod sockets
  vortexSlots:   SlotSize[];   // e.g. ['small','small','small'] for melee
  freqSlot:      true;
  // Applied mods (null if empty)
  vortexPhasers: (VortexPhaser | null)[];
  frequencyOscillator: FrequencyOscillator | null;
  // If all phaser pulses sum to 0 → true (ultimate bonus active)
  ultimateActive: boolean;
  // Mod-adjusted final stats (computed from apply*)
  lifestealPct:  number; // melee freq osc
  teamHealFlat:  number; // ranged freq osc
  hpRegenFlat:   number; // armor freq osc
}

export interface ArmorStats {
  defense:       number;
  slashResist:   number;
  pierceResist:  number;
  bluntResist:   number;
  durability:    number;
  durabilityMax: number;
  weight:        number;
  vortexSlot:    SlotSize;      // always 'large' for armor
  freqSlot:      true;
  vortexPhaser:  VortexPhaser | null;
  frequencyOscillator: FrequencyOscillator | null;
  ultimateActive: boolean;
  hpRegenFlat:   number;
}

// ─── Crafting computation ─────────────────────────────────────────────────

const BASE_SWING_RHO = 0.80; // normalisation constant

function swingSpeed(head: MaterialProps, shaft: MaterialProps): number {
  const avgRho = (head.rho * 2 + shaft.rho) / 3;
  return Math.sqrt(BASE_SWING_RHO / Math.max(avgRho, 0.10));
}

export function computeWeaponStats(
  head:    MaterialProps,
  shaft:   MaterialProps,
  grip:    MaterialProps,
  profile: WeaponProfile,
  quality: number, // 0.0–1.0
  element: ElementType | null,
  existingMods?: {
    vortexPhasers: (VortexPhaser | null)[];
    frequencyOscillator: FrequencyOscillator | null;
  }
): WeaponStats {
  const q   = Math.max(0.1, Math.min(1.0, quality));
  const ss  = swingSpeed(head, shaft);
  const geo = WEAPON_PROFILES[profile];

  // Base damage components
  const slash  = head.erf  * head.hv * 0.004  * ss * q;
  const pierce = (head.hv * 0.003 + head.uts * 0.001) * ss * q;
  const blunt  = head.rho  * head.cv * 0.08   * ss * q;

  const base = slash * geo.edgeProfile
             + pierce * geo.pointGeometry
             + blunt  * geo.bluntGeometry;

  // Grip adds minor handling bonus
  const gripBonus = 1.0 + (grip.cv / 1000) * 0.1;

  const rawDmg = base * gripBonus;

  // Vortex slots — melee 3 small, ranged 2 medium
  const isRanged    = profile === 'ranged';
  const vortexSlots: SlotSize[] = isRanged ? ['medium','medium'] : ['small','small','small'];
  const vortexPhasers = existingMods?.vortexPhasers
    ?? vortexSlots.map(() => null);

  // Apply phaser bonuses
  let dmgMult = 1.0;
  const pulseSum = vortexPhasers.reduce<number>((acc, p) => acc + (p?.pulse ?? 0), 0);
  for (const p of vortexPhasers) {
    if (!p) continue;
    if (p.slotSize === 'small')  dmgMult += p.pulse * 0.08;   // additive ±8%
    if (p.slotSize === 'medium') dmgMult *= 1 + p.pulse * 0.12; // multiplicative ±12%
  }

  // Ultimate bonus — pulse sum exactly 0
  const ultimateActive = Math.abs(pulseSum) < 0.0001
    && vortexPhasers.some(p => p !== null);
  if (ultimateActive) dmgMult *= 1.25;

  const finalDmg = rawDmg * dmgMult;

  // Frequency oscillator
  const fo = existingMods?.frequencyOscillator ?? null;
  const lifestealPct = (!isRanged && fo) ? fo.value * 3   : 0;
  const teamHealFlat = (isRanged  && fo) ? fo.value * 2   : 0;

  // Durability
  const baseDur = (head.sif * 80 + shaft.sif * 40) * q;

  return {
    dmgMin:        Math.max(1, Math.round(finalDmg * 0.85)),
    dmgMax:        Math.max(2, Math.round(finalDmg * 1.15)),
    attackSpeed:   +ss.toFixed(3),
    critChance:    +(head.hv / 10000 + 0.02) * q,
    durability:    Math.round(baseDur),
    durabilityMax: Math.round(baseDur),
    weight:        +((head.rho + shaft.rho * 0.5 + grip.rho * 0.2) * 0.5).toFixed(2),
    vortexSlots,
    freqSlot: true,
    vortexPhasers,
    frequencyOscillator: fo,
    ultimateActive,
    lifestealPct:  +lifestealPct.toFixed(2),
    teamHealFlat:  +teamHealFlat.toFixed(2),
    hpRegenFlat:   0,
  };
}

export function computeArmorStats(
  main:    MaterialProps,
  backing: MaterialProps,
  style:   ArmorStyle,
  quality: number,
  existingMods?: {
    vortexPhaser: VortexPhaser | null;
    frequencyOscillator: FrequencyOscillator | null;
  }
): ArmorStats {
  const q = Math.max(0.1, Math.min(1.0, quality));
  const w = ARMOR_WEIGHTS[style];

  let slash  = (main.hv * w.w_sh    + main.cv  * w.w_sc) * q * 0.01;
  let pierce = (main.hv * w.w_ph    + main.rho * w.w_pd * 10 + backing.cv * 0.1) * q * 0.01;
  let blunt  = (main.cv * w.w_bt    + backing.cv * w.w_bb) * q * 0.1;

  // Vortex phaser — armor always large slot (exponential bonus)
  const vp = existingMods?.vortexPhaser ?? null;
  const pulseSum = vp?.pulse ?? 0;
  const ultimateActive = vp !== null && Math.abs(pulseSum) < 0.0001;

  if (vp) {
    const exp = 1 + vp.pulse * 0.15;
    slash  = Math.pow(Math.max(0.1, slash),  exp);
    pierce = Math.pow(Math.max(0.1, pierce), exp);
    blunt  = Math.pow(Math.max(0.1, blunt),  exp);
  }
  if (ultimateActive) {
    slash *= 1.20; pierce *= 1.20; blunt *= 1.20;
  }

  const defense = (slash + pierce + blunt) / 3;

  // Frequency oscillator — armor gives hp regen
  const fo = existingMods?.frequencyOscillator ?? null;
  const hpRegen = fo ? fo.value * 1.0 : 0;

  // Durability
  const baseDur = (main.sif * 60 + backing.sif * 30) * q;

  return {
    defense:       +defense.toFixed(2),
    slashResist:   +slash.toFixed(2),
    pierceResist:  +pierce.toFixed(2),
    bluntResist:   +blunt.toFixed(2),
    durability:    Math.round(baseDur),
    durabilityMax: Math.round(baseDur),
    weight:        +((main.rho + backing.rho) * 0.3).toFixed(2),
    vortexSlot:    'large',
    freqSlot:      true,
    vortexPhaser:  vp,
    frequencyOscillator: fo,
    ultimateActive,
    hpRegenFlat:   +hpRegen.toFixed(2),
  };
}

/** Quality string display */
export function qualityLabel(q: number): string {
  if (q >= 0.90) return 'Masterwork';
  if (q >= 0.75) return 'Superior';
  if (q >= 0.55) return 'Standard';
  if (q >= 0.35) return 'Rough';
  return 'Poor';
}

/** Pick a quality value for an enemy-dropped item (skews poor) */
export function rollDropQuality(rng: () => number): number {
  // Beta-like distribution skewed low: most drops are poor-standard
  const r = rng();
  return Math.pow(r, 2.5) * 0.85 + 0.05; // range ~0.05–0.90
}

/** Pick a quality for a crafted item (skews toward standard-superior) */
export function rollCraftQuality(rng: () => number): number {
  const r = rng();
  return Math.pow(r, 1.2) * 0.70 + 0.25; // range ~0.25–0.95
}
