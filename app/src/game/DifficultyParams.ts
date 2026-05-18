/**
 * DifficultyParams — scaling knobs passed into every spawn call.
 *
 * Built once per combat session from party size; consumed by
 * WorldCombatManager (seedChunk) and ArenaWaveManager (spawnForArena).
 * Add new fields here as AI/zone complexity grows — call sites receive
 * the full struct and can ignore fields they don't yet use.
 *
 * All multipliers are in (0, ∞) where 1.0 = baseline (solo, no party).
 */

export interface DifficultyParams {
  /** Multiplier on enemy maxHp.  Party: +0.60 per member.  */
  hpMult:          number;
  /** Multiplier on enemy meleeDmgMin/Max.  Party: +0.25 per member. */
  damageMult:      number;
  /** Multiplier on enemy walk/aggro speed.  Reserved — 1.0 until AI tuning pass. */
  speedMult:       number;
  /** Multiplier on enemy aggro detection range.  Reserved — 1.0 until AI tuning pass. */
  aggroRangeMult:  number;
  /** Extra enemies added per chunk (fractional — accumulated then floored per chunk). Party: +0.25 per member. */
  extraEnemyCount: number;
  /**
   * Fraction of extra enemies that should be minion-archetype.
   * 1.0 = all extras are minions; 0.0 = normal pool distribution.
   * Minion bias applied only to the extra count, not base count.
   */
  extraMinionBias: number;
  /** Party size that produced these params (0 = solo). Informational — not used in math. */
  partySize:       number;
}

/** Baseline — solo player, no modifiers. */
const BASELINE: DifficultyParams = {
  hpMult:          1.0,
  damageMult:      1.0,
  speedMult:       1.0,
  aggroRangeMult:  1.0,
  extraEnemyCount: 0,
  extraMinionBias: 0.75,
  partySize:       0,
};

// Per-ally increments
const HP_PER_ALLY          = 0.60;
const DAMAGE_PER_ALLY      = 0.25;
const EXTRA_ENEMIES_PER_ALLY = 0.25;   // fractional; floored at spawn time

/**
 * Pure function — derive DifficultyParams from party size.
 * partySize is the number of AI allies currently in the party (0–3).
 */
export function buildDifficultyParams(partySize: number): DifficultyParams {
  if (partySize <= 0) return { ...BASELINE };
  const n = Math.max(0, Math.min(partySize, 3));
  return {
    hpMult:          1.0 + n * HP_PER_ALLY,
    damageMult:      1.0 + n * DAMAGE_PER_ALLY,
    speedMult:       1.0,
    aggroRangeMult:  1.0,
    extraEnemyCount: n * EXTRA_ENEMIES_PER_ALLY,
    extraMinionBias: BASELINE.extraMinionBias,
    partySize:       n,
  };
}
