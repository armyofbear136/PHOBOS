/**
 * BehaviourProfiles — Phase FSM data for EnemyWorldSprite.
 *
 * Extracted from WorldCombatManager to avoid a circular import between
 * WorldCombatManager (imports EnemyWorldSprite) and EnemyWorldSprite
 * (needs BehaviourProfile + BEHAVIOUR_PROFILES).
 *
 * Both WorldCombatManager and EnemyWorldSprite import from here.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BehaviourProfile {
  id:              string;
  /** × _walkSpeed base */
  moveSpeedMult:   number;
  /** × _attackRate base — lower means attacks faster */
  attackRateMult:  number;
  /** × _aggroRange base */
  aggroRangeMult:  number;
  /** × STUCK_MS — lower means replans more eagerly */
  replanRateMult:  number;
  /** Base ms before next profile roll. ±500ms jitter applied at roll time. */
  phaseDurationMs: number;
  /** Weighted transition table. Weights need not sum to 1 — normalised at roll time. */
  nextProfiles:    Array<{ id: string; weight: number }>;
  /** Brief visual on the enemy rect to signal phase change. */
  visualCue:       'none' | 'pulse' | 'flash' | 'grow';
}

// ── Profile table ─────────────────────────────────────────────────────────────

export const BEHAVIOUR_PROFILES: Record<string, BehaviourProfile> = {

  // Shambling, rarely attacks — transitions into aggressive surge
  passive: {
    id:              'passive',
    moveSpeedMult:   0.45,
    attackRateMult:  1.8,
    aggroRangeMult:  0.75,
    replanRateMult:  1.5,
    phaseDurationMs: 4000,
    nextProfiles:    [{ id: 'aggressive', weight: 0.6 }, { id: 'alert', weight: 0.4 }],
    visualCue:       'none',
  },

  // Baseline — standard aggro behaviour
  alert: {
    id:              'alert',
    moveSpeedMult:   1.0,
    attackRateMult:  1.0,
    aggroRangeMult:  1.0,
    replanRateMult:  1.0,
    phaseDurationMs: 3000,
    nextProfiles:    [{ id: 'alert', weight: 0.5 }, { id: 'berserk', weight: 0.3 }, { id: 'wary', weight: 0.2 }],
    visualCue:       'none',
  },

  // Sprint + rapid attacks — brief window, pulses to warn player
  aggressive: {
    id:              'aggressive',
    moveSpeedMult:   1.6,
    attackRateMult:  0.65,
    aggroRangeMult:  1.1,
    replanRateMult:  0.7,
    phaseDurationMs: 1800,
    nextProfiles:    [{ id: 'passive', weight: 0.7 }, { id: 'alert', weight: 0.3 }],
    visualCue:       'pulse',
  },

  // Maximum speed and attack rate — very short burst, flashes white
  berserk: {
    id:              'berserk',
    moveSpeedMult:   1.85,
    attackRateMult:  0.5,
    aggroRangeMult:  1.5,
    replanRateMult:  0.5,
    phaseDurationMs: 1000,
    nextProfiles:    [{ id: 'alert', weight: 0.85 }, { id: 'passive', weight: 0.15 }],
    visualCue:       'flash',
  },

  // Backing off, reduced threat — scale pulse signals retreat
  wary: {
    id:              'wary',
    moveSpeedMult:   0.7,
    attackRateMult:  2.0,
    aggroRangeMult:  0.65,
    replanRateMult:  2.0,
    phaseDurationMs: 2500,
    nextProfiles:    [{ id: 'alert', weight: 0.8 }, { id: 'aggressive', weight: 0.2 }],
    visualCue:       'grow',
  },
};

// ── Per-archetype starting profile ────────────────────────────────────────────
// Used when EnemySpawnOverrides.initialProfile is not specified.

export const ARCHETYPE_INITIAL_PROFILE: Record<string, string> = {
  minion:  'passive',
  warrior: 'alert',
  leader:  'alert',
  boss:    'alert',
  dummy:   'passive',
};
