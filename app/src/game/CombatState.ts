/**
 * CombatState — turn-based combat state machine for PHOBOS World.
 *
 * v2: Full status effect system, all 21 enemy templates, ability resolution,
 *     bond buff application, and leader-death frenzy notification.
 *
 * Status effects stored on each Combatant, ticked each turn in _tickStatuses().
 * Named abilities resolved in _resolveAbility() with a full switch block.
 * Bond buffs checked live in _getBondDamageMultiplier().
 */

import { derivedStats, type PlayerBuild, type ElementType } from './PlayerClasses';
import { generateLoot } from './ItemGenerator';
import { createEnemyAI, wireBondMechanics, type EnemyAIBase } from './EnemyAI';
import { buildAllyCombatant, resolveAllyAbility } from './AllyAI';
import type { GameItem, EnemyArchetype } from './ItemDefinitions';
import type { PersonaName } from './GameStore';

// ── Phase ─────────────────────────────────────────────────────────────────────

export type CombatPhase = 'idle' | 'player_turn' | 'enemy_turn' | 'animating' | 'victory' | 'defeat';

// ── Status Effects ────────────────────────────────────────────────────────────

export type StatusType = 'burn' | 'slow' | 'stun' | 'entropy' | 'exposure' | 'freeze';

export interface StatusEffect {
  type:      StatusType;
  remaining: number;  // turns left
  /** Magnitude: burn/exposure = dmg per turn, entropy = stacks (each -3% all stats) */
  magnitude: number;
  sourceElement: ElementType;
}

/** Apply or refresh a status on a combatant. Stacks entropy, refreshes others. */
function applyStatus(target: StatusEffect[], type: StatusType, turns: number, mag: number, el: ElementType): void {
  const existing = target.find(s => s.type === type);
  if (type === 'entropy') {
    if (existing) existing.magnitude = Math.min(existing.magnitude + mag, 10); // max 10 stacks
    else target.push({ type, remaining: turns, magnitude: mag, sourceElement: el });
    return;
  }
  if (existing) { existing.remaining = Math.max(existing.remaining, turns); return; }
  target.push({ type, remaining: turns, magnitude: mag, sourceElement: el });
}

// ── Action / Result ───────────────────────────────────────────────────────────

export interface CombatAction {
  type: 'melee' | 'ranged' | 'ability' | 'potion';
  abilityIndex?: number;
  targetIndex: number;
  potionType?: 'healing_potion' | 'spirit_potion';
  /** Set by EnemyAI — resolved in _resolveAbility() */
  abilityName?: string;
  /** Set by EntropyStalkerAI after shadow step */
  guaranteedCrit?: boolean;
}

export interface ActionResult {
  attackerIndex:  number;
  targetIndex:    number;
  damage:         number;
  missed:         boolean;
  critical:       boolean;
  killed:         boolean;
  healAmount:     number;
  actionType:     CombatAction['type'];
  abilityName?:   string;
  /** Status effects applied this action */
  statusesApplied: StatusType[];
  /** AoE: extra targets hit (indices into enemies[] or party[]) */
  aoeTargets:     number[];
  /** Flavour text shown in battle log */
  flavorText?:    string;
}

// ── Combatant ─────────────────────────────────────────────────────────────────

export interface Combatant {
  name:                string;
  isPlayer:            boolean;
  isEnemy:             boolean;
  hp:                  number;
  maxHp:               number;
  spirit:              number;
  maxSpirit:           number;
  element:             ElementType;
  attackSpeed:         number;
  meleeDmgMin:         number;
  meleeDmgMax:         number;
  rangedDmgMin:        number;
  rangedDmgMax:        number;
  abilityDmgMultiplier:number;
  accuracy:            number;
  defense:             number;
  elementalResist:     number;
  cooldowns:           number[];
  dead:                boolean;
  /** Active status effects */
  statuses:            StatusEffect[];
  /** Temporary shield HP (APEX HERALD herald_surge, PERMAFROST glacial_shield) */
  shieldHp:            number;
  /** Stun skips this combatant's next action */
  stunned:             boolean;
}

// ── Enemy Template ────────────────────────────────────────────────────────────

export interface EnemyTemplate {
  name:                 string;
  element:              ElementType;
  maxHp:                number;
  maxSpirit:            number;
  meleeDmgMin:          number;
  meleeDmgMax:          number;
  rangedDmgMin:         number;
  rangedDmgMax:         number;
  abilityDmgMultiplier: number;
  attackSpeed:          number;
  accuracy:             number;
  defense:              number;
  elementalResist:      number;
  /** Damage reflected back to melee attacker (FORGE KNIGHT molten armor) */
  meleeDmgReflect:      number;
  xpReward:             number;
  coinReward:           number;
  archetype:            'dummy' | 'minion' | 'warrior' | 'leader' | 'boss';
}

// ── All 21 Enemy Templates ────────────────────────────────────────────────────
// Stats scale by archetype:
//   minion  — low HP, moderate damage, fast
//   warrior — medium HP, higher damage, tankier
//   leader  — medium HP, ranged focus, buffs
//   boss    — high HP, high damage, multi-phase

export const ENEMY_TEMPLATES: Record<string, EnemyTemplate> = {

  // ── Legacy / training ─────────────────────────────────────────────────────
  training_dummy: {
    name: 'Training Dummy', element: 'plasma', archetype: 'dummy',
    maxHp: 60,  maxSpirit: 0,  meleeDmgMin: 0, meleeDmgMax: 0,
    rangedDmgMin: 0, rangedDmgMax: 0, abilityDmgMultiplier: 0,
    attackSpeed: 0, accuracy: 0, defense: 0, elementalResist: 0,
    meleeDmgReflect: 0, xpReward: 10, coinReward: 5,
  },

  // ── Plasma ────────────────────────────────────────────────────────────────
  ghast: {
    name: 'Ghast', element: 'plasma', archetype: 'minion',
    maxHp: 55,  maxSpirit: 30, meleeDmgMin: 5,  meleeDmgMax: 9,
    rangedDmgMin: 3, rangedDmgMax: 6, abilityDmgMultiplier: 1.3,
    attackSpeed: 1.2, accuracy: 0.74, defense: 2, elementalResist: 3,
    meleeDmgReflect: 0, xpReward: 18, coinReward: 8,
  },
  justicar: {
    name: 'Justicar', element: 'plasma', archetype: 'warrior',
    maxHp: 130, maxSpirit: 40, meleeDmgMin: 9,  meleeDmgMax: 16,
    rangedDmgMin: 5, rangedDmgMax: 10, abilityDmgMultiplier: 1.2,
    attackSpeed: 0.9, accuracy: 0.78, defense: 7, elementalResist: 5,
    meleeDmgReflect: 0, xpReward: 35, coinReward: 16,
  },
  mystic: {
    name: 'Mystic', element: 'plasma', archetype: 'leader',
    maxHp: 100, maxSpirit: 60, meleeDmgMin: 6,  meleeDmgMax: 11,
    rangedDmgMin: 8, rangedDmgMax: 14, abilityDmgMultiplier: 1.5,
    attackSpeed: 1.0, accuracy: 0.80, defense: 4, elementalResist: 6,
    meleeDmgReflect: 0, xpReward: 42, coinReward: 22,
  },
  apex_herald: {
    name: 'Apex Herald', element: 'plasma', archetype: 'boss',
    maxHp: 420, maxSpirit: 100, meleeDmgMin: 14, meleeDmgMax: 22,
    rangedDmgMin: 10, rangedDmgMax: 18, abilityDmgMultiplier: 1.8,
    attackSpeed: 1.1, accuracy: 0.85, defense: 10, elementalResist: 8,
    meleeDmgReflect: 0, xpReward: 180, coinReward: 90,
  },

  // ── Fire ──────────────────────────────────────────────────────────────────
  cinder: {
    name: 'Cinder', element: 'fire', archetype: 'minion',
    maxHp: 50,  maxSpirit: 25, meleeDmgMin: 6,  meleeDmgMax: 10,
    rangedDmgMin: 0, rangedDmgMax: 0, abilityDmgMultiplier: 1.2,
    attackSpeed: 1.3, accuracy: 0.72, defense: 1, elementalResist: 4,
    meleeDmgReflect: 0, xpReward: 16, coinReward: 7,
  },
  forge_knight: {
    name: 'Forge Knight', element: 'fire', archetype: 'warrior',
    maxHp: 160, maxSpirit: 30, meleeDmgMin: 11, meleeDmgMax: 18,
    rangedDmgMin: 0, rangedDmgMax: 0, abilityDmgMultiplier: 1.3,
    attackSpeed: 0.7, accuracy: 0.70, defense: 10, elementalResist: 7,
    meleeDmgReflect: 3, // Molten Armor — reflects 3 dmg on melee hit
    xpReward: 40, coinReward: 18,
  },
  ember_witch: {
    name: 'Ember Witch', element: 'fire', archetype: 'leader',
    maxHp: 90,  maxSpirit: 70, meleeDmgMin: 4,  meleeDmgMax: 8,
    rangedDmgMin: 9, rangedDmgMax: 16, abilityDmgMultiplier: 1.6,
    attackSpeed: 1.0, accuracy: 0.82, defense: 3, elementalResist: 8,
    meleeDmgReflect: 0, xpReward: 45, coinReward: 24,
  },
  molten_sovereign: {
    name: 'Molten Sovereign', element: 'fire', archetype: 'boss',
    maxHp: 460, maxSpirit: 80, meleeDmgMin: 18, meleeDmgMax: 28,
    rangedDmgMin: 0, rangedDmgMax: 0, abilityDmgMultiplier: 2.0,
    attackSpeed: 0.8, accuracy: 0.80, defense: 14, elementalResist: 12,
    meleeDmgReflect: 5, xpReward: 200, coinReward: 100,
  },

  // ── Ice ───────────────────────────────────────────────────────────────────
  shard: {
    name: 'Shard', element: 'ice', archetype: 'minion',
    maxHp: 45,  maxSpirit: 20, meleeDmgMin: 4,  meleeDmgMax: 7,
    rangedDmgMin: 3, rangedDmgMax: 6, abilityDmgMultiplier: 1.1,
    attackSpeed: 1.1, accuracy: 0.71, defense: 2, elementalResist: 5,
    meleeDmgReflect: 0, xpReward: 14, coinReward: 6,
  },
  permafrost_sentinel: {
    name: 'Permafrost Sentinel', element: 'ice', archetype: 'warrior',
    maxHp: 145, maxSpirit: 35, meleeDmgMin: 8,  meleeDmgMax: 14,
    rangedDmgMin: 0, rangedDmgMax: 0, abilityDmgMultiplier: 1.1,
    attackSpeed: 0.75, accuracy: 0.72, defense: 9, elementalResist: 10,
    meleeDmgReflect: 0, xpReward: 38, coinReward: 17,
  },
  glacial_warden: {
    name: 'Glacial Warden', element: 'ice', archetype: 'leader',
    maxHp: 110, maxSpirit: 55, meleeDmgMin: 5,  meleeDmgMax: 9,
    rangedDmgMin: 7, rangedDmgMax: 13, abilityDmgMultiplier: 1.4,
    attackSpeed: 0.95, accuracy: 0.76, defense: 6, elementalResist: 12,
    meleeDmgReflect: 0, xpReward: 44, coinReward: 23,
  },
  cryolith: {
    name: 'Cryolith', element: 'ice', archetype: 'boss',
    maxHp: 480, maxSpirit: 90, meleeDmgMin: 12, meleeDmgMax: 20,
    rangedDmgMin: 8, rangedDmgMax: 15, abilityDmgMultiplier: 1.9,
    attackSpeed: 0.85, accuracy: 0.82, defense: 12, elementalResist: 15,
    meleeDmgReflect: 0, xpReward: 210, coinReward: 105,
  },

  // ── Lightning ─────────────────────────────────────────────────────────────
  arc: {
    name: 'Arc', element: 'lightning', archetype: 'minion',
    maxHp: 40,  maxSpirit: 35, meleeDmgMin: 3,  meleeDmgMax: 6,
    rangedDmgMin: 5, rangedDmgMax: 9, abilityDmgMultiplier: 1.2,
    attackSpeed: 1.5, accuracy: 0.76, defense: 0, elementalResist: 6,
    meleeDmgReflect: 0, xpReward: 15, coinReward: 7,
  },
  voltbreaker: {
    name: 'Voltbreaker', element: 'lightning', archetype: 'warrior',
    maxHp: 120, maxSpirit: 50, meleeDmgMin: 7,  meleeDmgMax: 13,
    rangedDmgMin: 8, rangedDmgMax: 15, abilityDmgMultiplier: 1.5,
    attackSpeed: 1.1, accuracy: 0.79, defense: 4, elementalResist: 8,
    meleeDmgReflect: 0, xpReward: 36, coinReward: 16,
  },
  storm_herald: {
    name: 'Storm Herald', element: 'lightning', archetype: 'leader',
    maxHp: 95,  maxSpirit: 65, meleeDmgMin: 4,  meleeDmgMax: 7,
    rangedDmgMin: 9, rangedDmgMax: 16, abilityDmgMultiplier: 1.5,
    attackSpeed: 1.2, accuracy: 0.83, defense: 3, elementalResist: 9,
    meleeDmgReflect: 0, xpReward: 46, coinReward: 25,
  },
  tempest_core: {
    name: 'Tempest Core', element: 'lightning', archetype: 'boss',
    maxHp: 400, maxSpirit: 120, meleeDmgMin: 16, meleeDmgMax: 24,
    rangedDmgMin: 10, rangedDmgMax: 18, abilityDmgMultiplier: 2.2,
    attackSpeed: 1.0, accuracy: 0.86, defense: 8, elementalResist: 14,
    meleeDmgReflect: 0, xpReward: 190, coinReward: 95,
  },

  // ── Void ──────────────────────────────────────────────────────────────────
  wraith: {
    name: 'Wraith', element: 'void', archetype: 'minion',
    maxHp: 55,  maxSpirit: 40, meleeDmgMin: 5,  meleeDmgMax: 9,
    rangedDmgMin: 3, rangedDmgMax: 7, abilityDmgMultiplier: 1.4,
    attackSpeed: 1.3, accuracy: 0.78, defense: 1, elementalResist: 5,
    meleeDmgReflect: 0, xpReward: 20, coinReward: 9,
  },
  entropy_stalker: {
    name: 'Entropy Stalker', element: 'void', archetype: 'warrior',
    maxHp: 115, maxSpirit: 45, meleeDmgMin: 9,  meleeDmgMax: 16,
    rangedDmgMin: 6, rangedDmgMax: 11, abilityDmgMultiplier: 1.4,
    attackSpeed: 1.2, accuracy: 0.81, defense: 5, elementalResist: 7,
    meleeDmgReflect: 0, xpReward: 37, coinReward: 17,
  },
  void_weaver: {
    name: 'Void Weaver', element: 'void', archetype: 'leader',
    maxHp: 100, maxSpirit: 75, meleeDmgMin: 4,  meleeDmgMax: 8,
    rangedDmgMin: 8, rangedDmgMax: 15, abilityDmgMultiplier: 1.6,
    attackSpeed: 0.9, accuracy: 0.80, defense: 4, elementalResist: 8,
    meleeDmgReflect: 0, xpReward: 48, coinReward: 26,
  },
  null_sovereign: {
    name: 'Null Sovereign', element: 'void', archetype: 'boss',
    maxHp: 500, maxSpirit: 110, meleeDmgMin: 14, meleeDmgMax: 22,
    rangedDmgMin: 9, rangedDmgMax: 16, abilityDmgMultiplier: 2.1,
    attackSpeed: 0.9, accuracy: 0.84, defense: 11, elementalResist: 13,
    meleeDmgReflect: 0, xpReward: 220, coinReward: 110,
  },

  // ── Legacy keys (mapped to nearest equivalent) ────────────────────────────
  moon_wraith:    { name: 'Moon Wraith',    element: 'void',      archetype: 'minion',
    maxHp: 80,  maxSpirit: 30, meleeDmgMin: 5, meleeDmgMax: 10,
    rangedDmgMin: 4, rangedDmgMax: 8, abilityDmgMultiplier: 1.2,
    attackSpeed: 1.1, accuracy: 0.72, defense: 2, elementalResist: 3,
    meleeDmgReflect: 0, xpReward: 25, coinReward: 12 },
  crater_golem:   { name: 'Crater Golem',   element: 'fire',      archetype: 'warrior',
    maxHp: 150, maxSpirit: 15, meleeDmgMin: 8, meleeDmgMax: 16,
    rangedDmgMin: 0, rangedDmgMax: 0, abilityDmgMultiplier: 1.0,
    attackSpeed: 0.5, accuracy: 0.65, defense: 8, elementalResist: 5,
    meleeDmgReflect: 3, xpReward: 40, coinReward: 20 },
  spark_wisp:     { name: 'Spark Wisp',     element: 'lightning', archetype: 'minion',
    maxHp: 40,  maxSpirit: 50, meleeDmgMin: 2, meleeDmgMax: 5,
    rangedDmgMin: 6, rangedDmgMax: 12, abilityDmgMultiplier: 1.4,
    attackSpeed: 1.5, accuracy: 0.80, defense: 0, elementalResist: 8,
    meleeDmgReflect: 0, xpReward: 20, coinReward: 10 },
  frost_sentinel: { name: 'Frost Sentinel', element: 'ice',       archetype: 'warrior',
    maxHp: 120, maxSpirit: 25, meleeDmgMin: 6, meleeDmgMax: 12,
    rangedDmgMin: 3, rangedDmgMax: 7, abilityDmgMultiplier: 1.1,
    attackSpeed: 0.7, accuracy: 0.70, defense: 5, elementalResist: 10,
    meleeDmgReflect: 0, xpReward: 35, coinReward: 15 },
};

// ── Wave presets ──────────────────────────────────────────────────────────────

export interface WavePreset {
  name: string;
  enemies: string[];
  tier: number;
}

export const BATTLE_WAVES: WavePreset[] = [
  { name: 'Training Bout',       enemies: ['training_dummy'],                                   tier: 1 },
  { name: 'Wraith Ambush',       enemies: ['wraith', 'wraith'],                                 tier: 1 },
  { name: 'Ember Pack',          enemies: ['cinder', 'cinder', 'cinder'],                       tier: 1 },
  { name: 'Plasma Patrol',       enemies: ['ghast', 'ghast', 'justicar'],                       tier: 2 },
  { name: 'Frost Watch',         enemies: ['shard', 'shard', 'permafrost_sentinel'],            tier: 2 },
  { name: 'Voltswarm',           enemies: ['arc', 'arc', 'arc', 'voltbreaker'],                 tier: 2 },
  { name: 'Void Council',        enemies: ['wraith', 'wraith', 'void_weaver'],                  tier: 3 },
  { name: 'Fire Court',          enemies: ['cinder', 'cinder', 'ember_witch'],                  tier: 3 },
  { name: 'Storm Collective',    enemies: ['arc', 'arc', 'storm_herald'],                       tier: 3 },
  { name: 'Ice Convergence',     enemies: ['shard', 'glacial_warden'],                          tier: 3 },
  { name: 'Trial of Elements',   enemies: ['crater_golem', 'spark_wisp', 'frost_sentinel'],     tier: 3 },
  { name: 'Boss — Apex Herald',  enemies: ['apex_herald'],                                      tier: 4 },
  { name: 'Boss — Cryolith',     enemies: ['cryolith'],                                         tier: 4 },
  { name: 'Boss — Tempest Core', enemies: ['tempest_core'],                                     tier: 4 },
  { name: 'Boss — Null Sovereign',enemies: ['null_sovereign'],                                  tier: 4 },
];

// ── Combat State ──────────────────────────────────────────────────────────────

export class CombatState {
  phase: CombatPhase = 'idle';
  party: Combatant[] = [];
  enemies: Combatant[] = [];
  turnOrder: number[] = [];
  currentTurnIndex = 0;
  turnNumber = 0;
  results: ActionResult[] = [];
  totalXp = 0;
  totalCoins = 0;
  droppedItems: GameItem[] = [];

  _enemyAIs: (EnemyAIBase | undefined)[] = [];

  private _result: ActionResult = {
    attackerIndex: 0, targetIndex: 0, damage: 0,
    missed: false, critical: false, killed: false,
    healAmount: 0, actionType: 'melee',
    statusesApplied: [], aoeTargets: [],
  };

  initCombat(playerBuild: PlayerBuild, enemyKeys: string[]): void {
    this.turnNumber = 1;
    this.currentTurnIndex = 0;
    this.results.length = 0;
    this.totalXp = 0;
    this.totalCoins = 0;
    this.droppedItems.length = 0;

    const d = derivedStats(playerBuild);
    this.party.length = 0;
    this.party.push({
      name: playerBuild.name || 'Player',
      isPlayer: true, isEnemy: false,
      hp: d.maxHp, maxHp: d.maxHp,
      spirit: d.maxSpirit, maxSpirit: d.maxSpirit,
      element: playerBuild.element,
      attackSpeed: d.attackSpeed,
      meleeDmgMin: d.meleeDmgMin, meleeDmgMax: d.meleeDmgMax,
      rangedDmgMin: d.rangedDmgMin, rangedDmgMax: d.rangedDmgMax,
      abilityDmgMultiplier: d.abilityDmgMultiplier,
      accuracy: d.accuracy, defense: d.defense,
      elementalResist: d.elementalResist,
      cooldowns: [0, 0, 0],
      dead: false, statuses: [], shieldHp: 0, stunned: false,
    });

    this.enemies.length = 0;
    for (const key of enemyKeys) {
      const t = ENEMY_TEMPLATES[key];
      if (!t) continue;
      this.enemies.push({
        name: t.name, isPlayer: false, isEnemy: true,
        hp: t.maxHp, maxHp: t.maxHp,
        spirit: t.maxSpirit, maxSpirit: t.maxSpirit,
        element: t.element, attackSpeed: t.attackSpeed,
        meleeDmgMin: t.meleeDmgMin, meleeDmgMax: t.meleeDmgMax,
        rangedDmgMin: t.rangedDmgMin, rangedDmgMax: t.rangedDmgMax,
        abilityDmgMultiplier: t.abilityDmgMultiplier,
        accuracy: t.accuracy, defense: t.defense,
        elementalResist: t.elementalResist,
        cooldowns: [0, 0, 0],
        dead: false, statuses: [], shieldHp: 0, stunned: false,
      });
    }

    this._buildTurnOrder();

    this._enemyAIs = this.enemies.map((e) => {
      const key = Object.entries(ENEMY_TEMPLATES).find(([, t]) => t.name === e.name)?.[0] ?? 'training_dummy';
      return createEnemyAI(key, e.maxHp);
    });
    wireBondMechanics(
      this.enemies.map((e, i) => {
        const key = Object.entries(ENEMY_TEMPLATES).find(([, t]) => t.name === e.name)?.[0] ?? 'training_dummy';
        return { key, ai: this._enemyAIs[i]! };
      })
    );
    this.phase = this.isPlayerTurn() ? 'player_turn' : 'enemy_turn';
  }

  private _buildTurnOrder(): void {
    const all: Array<{ speed: number; idx: number; isEnemy: boolean }> = [];
    for (let i = 0; i < this.party.length; i++)   if (!this.party[i].dead)   all.push({ speed: this.party[i].attackSpeed,   idx: i, isEnemy: false });
    for (let i = 0; i < this.enemies.length; i++) if (!this.enemies[i].dead) all.push({ speed: this.enemies[i].attackSpeed, idx: i, isEnemy: true  });
    all.sort((a, b) => b.speed - a.speed);
    this.turnOrder.length = 0;
    for (const e of all) this.turnOrder.push(e.isEnemy ? -(e.idx + 1) : e.idx);
    this.currentTurnIndex = 0;
  }

  getActiveCombatant(): Combatant | null {
    if (this.phase === 'victory' || this.phase === 'defeat' || this.phase === 'idle') return null;
    if (this.currentTurnIndex >= this.turnOrder.length) return null;
    const enc = this.turnOrder[this.currentTurnIndex];
    return enc >= 0 ? this.party[enc] : this.enemies[-(enc + 1)];
  }

  isPlayerTurn(): boolean {
    if (this.currentTurnIndex >= this.turnOrder.length) return false;
    return this.turnOrder[this.currentTurnIndex] >= 0;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RESOLVE ACTION
  // ─────────────────────────────────────────────────────────────────────────

  resolveAction(action: CombatAction): ActionResult {
    const r = this._result;
    r.damage = 0; r.missed = false; r.critical = false; r.killed = false;
    r.healAmount = 0; r.actionType = action.type; r.abilityName = undefined;
    r.statusesApplied = []; r.aoeTargets = []; r.flavorText = undefined;

    const enc = this.turnOrder[this.currentTurnIndex];
    const isEnemy = enc < 0;
    const attacker = isEnemy ? this.enemies[-(enc + 1)] : this.party[enc];
    r.attackerIndex = isEnemy ? -(enc + 1) : enc;

    // Stunned — skip turn
    if (attacker.stunned) {
      attacker.stunned = false;
      r.flavorText = `${attacker.name} is stunned!`;
      this._advanceTurn();
      return { ...r };
    }

    // Determine target
    let target: Combatant;
    if (isEnemy) {
      const alive = this.party.filter(p => !p.dead);
      target = alive.length > 0 ? alive[Math.floor(Math.random() * alive.length)] : this.party[0];
      r.targetIndex = this.party.indexOf(target);
    } else {
      target = this.enemies[action.targetIndex] ?? this.enemies[0];
      r.targetIndex = action.targetIndex;
    }

    // Ability resolution — delegates to named handler
    if (action.type === 'ability') {
      this._resolveAbility(action, attacker, target, r, isEnemy);
      this._finishAction(attacker, target, r, isEnemy);
      return { ...r };
    }

    // Potion
    if (action.type === 'potion') {
      const healAmt = action.potionType === 'healing_potion' ? 40 : 25;
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + healAmt);
      r.healAmount = healAmt;
      r.flavorText = `Used ${action.potionType === 'healing_potion' ? 'HP' : 'Spirit'} potion (+${healAmt})`;
      this._advanceTurn();
      return { ...r };
    }

    // Accuracy check
    if (Math.random() > attacker.accuracy) {
      r.missed = true;
      this._advanceTurn();
      return { ...r };
    }

    // Base melee/ranged damage
    let dmgMin = action.type === 'melee' ? attacker.meleeDmgMin : attacker.rangedDmgMin;
    let dmgMax = action.type === 'melee' ? attacker.meleeDmgMax : attacker.rangedDmgMax;

    // Bond buff — leader alive boosts minion damage
    const bondMult = this._getBondDamageMultiplier(attacker, isEnemy);
    dmgMin = Math.round(dmgMin * bondMult);
    dmgMax = Math.round(dmgMax * bondMult);

    let rawDmg = dmgMin + Math.floor(Math.random() * (dmgMax - dmgMin + 1));

    // Guaranteed crit (ENTROPY STALKER shadow step)
    if (action.guaranteedCrit || Math.random() < 0.10) {
      rawDmg = Math.round(rawDmg * 1.5);
      r.critical = true;
    }

    // Apply shield first
    rawDmg = this._applyShield(target, rawDmg);
    const reduction = Math.max(0, target.defense + target.elementalResist - this._getExposureReduction(target));
    r.damage = Math.max(1, rawDmg - reduction);
    target.hp = Math.max(0, target.hp - r.damage);

    // Melee reflect (Forge Knight / Crater Golem)
    if (action.type === 'melee') {
      const key = Object.entries(ENEMY_TEMPLATES).find(([, t]) => t.name === target.name)?.[0];
      if (key) {
        const tmpl = ENEMY_TEMPLATES[key];
        if (tmpl.meleeDmgReflect > 0) {
          attacker.hp = Math.max(0, attacker.hp - tmpl.meleeDmgReflect);
          r.flavorText = `${target.name}'s molten armor reflects ${tmpl.meleeDmgReflect} damage!`;
        }
      }
    }

    // Elemental status on basic hit — slight chance per element
    this._maybeApplyElementalStatus(attacker.element, target, r, 0.15);

    attacker.spirit = Math.min(attacker.maxSpirit, attacker.spirit + 3);
    target.spirit   = Math.max(0, target.spirit - 2);

    this._finishAction(attacker, target, r, isEnemy);
    return { ...r };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // NAMED ABILITY RESOLUTION
  // ─────────────────────────────────────────────────────────────────────────

  private _resolveAbility(
    action:   CombatAction,
    attacker: Combatant,
    target:   Combatant,
    r:        ActionResult,
    isEnemy:  boolean
  ): void {
    r.abilityName = action.abilityName ?? `ability_${action.abilityIndex ?? 0}`;
    const mult = attacker.abilityDmgMultiplier;
    const bondMult = this._getBondDamageMultiplier(attacker, isEnemy);

    // Helper: deal ability damage to one target
    const dealDmg = (tgt: Combatant, base: number): number => {
      let raw = Math.round(base * mult * bondMult);
      if (Math.random() < 0.08) { raw = Math.round(raw * 1.5); r.critical = true; }
      raw = this._applyShield(tgt, raw);
      const red = Math.max(0, tgt.defense - this._getExposureReduction(tgt));
      const final = Math.max(1, raw - red);
      tgt.hp = Math.max(0, tgt.hp - final);
      return final;
    };

    // Helper: get all alive party indices
    const alivePartyIdx = () => this.party.map((p, i) => ({ p, i })).filter(x => !x.p.dead).map(x => x.i);
    const aliveEnemyIdx = () => this.enemies.map((e, i) => ({ e, i })).filter(x => !x.e.dead).map(x => x.i);

    switch (r.abilityName) {
      // ── GHAST ──────────────────────────────────────────────────────────────
      case 'v_beam':
      case 'v_beam_charged': {
        // High damage ranged, applies Exposure (defence reduction for 3 turns)
        r.damage = dealDmg(target, 18);
        applyStatus(target.statuses, 'exposure', 3, 2, 'plasma');
        r.statusesApplied.push('exposure');
        r.flavorText = `V-Beam! ${target.name} is Exposed!`;
        break;
      }

      // ── JUSTICAR ────────────────────────────────────────────────────────────
      case 'sentinel_stance': {
        // Self: temporary shield for 20 HP
        attacker.shieldHp += 20;
        r.healAmount = 20;
        r.flavorText = `${attacker.name} raises a Plasma Aegis! (+20 shield)`;
        break;
      }

      // ── MYSTIC ──────────────────────────────────────────────────────────────
      case 'plasma_aegis': {
        attacker.shieldHp += 20;
        r.flavorText = `${attacker.name} conjures Plasma Aegis!`;
        break;
      }
      case 'plasma_burst': {
        // AoE — hits all alive party
        const targets = alivePartyIdx();
        let total = 0;
        for (const ti of targets) { total += dealDmg(this.party[ti], 12); }
        r.damage = total; r.aoeTargets = targets;
        r.flavorText = `Plasma Burst hits all party members!`;
        break;
      }

      // ── APEX HERALD ─────────────────────────────────────────────────────────
      case 'judgment_beam': {
        r.damage = dealDmg(target, 28);
        applyStatus(target.statuses, 'exposure', 4, 3, 'plasma');
        r.statusesApplied.push('exposure');
        r.flavorText = `Judgment Beam! ${target.name} is severely Exposed!`;
        break;
      }
      case 'heralds_cascade': {
        const targets = alivePartyIdx();
        let total = 0;
        for (const ti of targets) total += dealDmg(this.party[ti], 16);
        r.damage = total; r.aoeTargets = targets;
        r.flavorText = `Herald's Cascade rains plasma on the party!`;
        break;
      }
      case 'herald_surge': {
        // AoE + self-heal
        const targets = alivePartyIdx();
        let total = 0;
        for (const ti of targets) total += dealDmg(this.party[ti], 14);
        const healAmt = 60;
        attacker.hp = Math.min(attacker.maxHp, attacker.hp + healAmt);
        attacker.shieldHp += 20;
        r.damage = total; r.aoeTargets = targets; r.healAmount = healAmt;
        r.flavorText = `Herald Surge — Phase 2 begins! Apex Herald heals for ${healAmt}!`;
        break;
      }

      // ── CINDER ──────────────────────────────────────────────────────────────
      case 'ember_burst': {
        r.damage = dealDmg(target, 10);
        applyStatus(target.statuses, 'burn', 3, 4, 'fire');
        r.statusesApplied.push('burn');
        r.flavorText = `Ember Burst! ${target.name} is Burning!`;
        break;
      }

      // ── FORGE KNIGHT ────────────────────────────────────────────────────────
      case 'forge_slam': {
        r.damage = dealDmg(target, 20);
        // Ground fire patch — represented as a Burn status for 2 turns
        applyStatus(target.statuses, 'burn', 2, 5, 'fire');
        r.statusesApplied.push('burn');
        r.flavorText = `Forge Slam — fire erupts! ${target.name} is Burning!`;
        break;
      }

      // ── EMBER WITCH ─────────────────────────────────────────────────────────
      case 'hex_flame': {
        r.damage = dealDmg(target, 22);
        applyStatus(target.statuses, 'burn', 3, 5, 'fire');
        r.statusesApplied.push('burn');
        r.flavorText = `Hex Flame! ${target.name} is Burning!`;
        break;
      }
      case 'conflagration': {
        const targets = alivePartyIdx();
        let total = 0;
        for (const ti of targets) {
          total += dealDmg(this.party[ti], 15);
          applyStatus(this.party[ti].statuses, 'burn', 2, 3, 'fire');
          r.statusesApplied.push('burn');
        }
        r.damage = total; r.aoeTargets = targets;
        r.flavorText = `Conflagration! The whole party is on fire!`;
        break;
      }

      // ── MOLTEN SOVEREIGN ────────────────────────────────────────────────────
      case 'lava_crush': {
        r.damage = dealDmg(target, 25);
        // Shockwave — hits adjacent (simulate with AoE)
        const otherIdx = alivePartyIdx().filter(i => i !== r.targetIndex);
        for (const oi of otherIdx.slice(0, 1)) { dealDmg(this.party[oi], 10); r.aoeTargets.push(oi); }
        applyStatus(target.statuses, 'burn', 2, 6, 'fire');
        r.statusesApplied.push('burn');
        r.flavorText = `Lava Crush shakes the ground!`;
        break;
      }
      case 'eruption': {
        const targets = alivePartyIdx();
        let total = 0;
        for (const ti of targets) {
          total += dealDmg(this.party[ti], 18);
          applyStatus(this.party[ti].statuses, 'burn', 3, 6, 'fire');
          r.statusesApplied.push('burn');
        }
        r.damage = total; r.aoeTargets = targets;
        r.flavorText = `ERUPTION! Fire rains down!`;
        break;
      }
      case 'magma_form': {
        attacker.abilityDmgMultiplier *= 2;
        attacker.meleeDmgMin = Math.round(attacker.meleeDmgMin * 2);
        attacker.meleeDmgMax = Math.round(attacker.meleeDmgMax * 2);
        r.flavorText = `${attacker.name} enters MAGMA FORM! Damage doubled for 3 turns!`;
        break;
      }

      // ── SHARD ───────────────────────────────────────────────────────────────
      case 'ice_shatter': {
        r.damage = dealDmg(target, 9);
        applyStatus(target.statuses, 'slow', 3, 1, 'ice');
        r.statusesApplied.push('slow');
        r.flavorText = `Ice Shatter! ${target.name} is Slowed!`;
        break;
      }

      // ── PERMAFROST SENTINEL ─────────────────────────────────────────────────
      case 'glacial_shield': {
        attacker.shieldHp += 30;
        r.flavorText = `${attacker.name} raises a Glacial Shield! (+30 shield)`;
        break;
      }
      case 'frost_cleave': {
        r.damage = dealDmg(target, 12);
        if (Math.random() < 0.40) {
          applyStatus(target.statuses, 'slow', 2, 1, 'ice');
          r.statusesApplied.push('slow');
        }
        r.flavorText = `Frost Cleave!${r.statusesApplied.length ? ` ${target.name} Slowed!` : ''}`;
        break;
      }

      // ── GLACIAL WARDEN ──────────────────────────────────────────────────────
      case 'frost_nova': {
        const targets = alivePartyIdx();
        for (const ti of targets) {
          applyStatus(this.party[ti].statuses, 'slow', 2, 1, 'ice');
          r.statusesApplied.push('slow');
        }
        r.aoeTargets = targets;
        r.flavorText = `Frost Nova! All party members Slowed!`;
        break;
      }
      case 'ice_prison': {
        r.damage = dealDmg(target, 14);
        applyStatus(target.statuses, 'stun', 2, 1, 'ice');
        r.statusesApplied.push('stun');
        r.flavorText = `Ice Prison! ${target.name} is Stunned for 2 turns!`;
        break;
      }

      // ── CRYOLITH ────────────────────────────────────────────────────────────
      case 'crystalline_burst': {
        const targets = alivePartyIdx();
        let total = 0;
        for (const ti of targets) {
          total += dealDmg(this.party[ti], 14);
          if (Math.random() < 0.35) {
            applyStatus(this.party[ti].statuses, 'slow', 2, 1, 'ice');
            r.statusesApplied.push('slow');
          }
        }
        r.damage = total; r.aoeTargets = targets;
        r.flavorText = `Crystalline Burst!`;
        break;
      }
      case 'absolute_zero': {
        const targets = alivePartyIdx();
        let total = 0;
        for (const ti of targets) {
          total += dealDmg(this.party[ti], 20);
          applyStatus(this.party[ti].statuses, 'slow', 3, 1, 'ice');
          applyStatus(this.party[ti].statuses, 'stun', 1, 1, 'ice');
          r.statusesApplied.push('slow', 'stun');
        }
        r.damage = total; r.aoeTargets = targets;
        r.flavorText = `ABSOLUTE ZERO! All party Slowed and Stunned!`;
        break;
      }
      case 'glacial_convergence': {
        const targets = alivePartyIdx();
        let total = 0;
        for (const ti of targets) {
          total += dealDmg(this.party[ti], 18);
          applyStatus(this.party[ti].statuses, 'stun', 2, 1, 'ice');
          r.statusesApplied.push('stun');
        }
        r.damage = total; r.aoeTargets = targets;
        r.flavorText = `Glacial Convergence — pulled to the Cryolith and Stunned!`;
        break;
      }

      // ── ARC ─────────────────────────────────────────────────────────────────
      case 'chain_bolt': {
        r.damage = dealDmg(target, 10);
        // Chain — hits one more target
        const chainIdx = alivePartyIdx().find(i => i !== r.targetIndex);
        if (chainIdx !== undefined) {
          dealDmg(this.party[chainIdx], 6);
          r.aoeTargets.push(chainIdx);
        }
        r.flavorText = `Chain Bolt!${chainIdx !== undefined ? ' Chains to another target!' : ''}`;
        break;
      }

      // ── VOLTBREAKER ─────────────────────────────────────────────────────────
      case 'overcharge': {
        // Self buff handled by AI state; no damage this turn
        r.flavorText = `${attacker.name} overcharges! Next attack will be devastating!`;
        break;
      }
      case 'lightning_surge': {
        r.damage = dealDmg(target, 16);
        r.flavorText = `Lightning Surge!`;
        break;
      }
      case 'lightning_surge_charged': {
        // 2× damage + stun
        r.damage = dealDmg(target, 32);
        applyStatus(target.statuses, 'stun', 1, 1, 'lightning');
        r.statusesApplied.push('stun');
        r.critical = true;
        r.flavorText = `OVERCHARGED Lightning Surge! ${target.name} Stunned!`;
        break;
      }

      // ── STORM HERALD ────────────────────────────────────────────────────────
      case 'thunderclap': {
        const targets = alivePartyIdx();
        let total = 0;
        for (const ti of targets) {
          total += dealDmg(this.party[ti], 12);
          applyStatus(this.party[ti].statuses, 'stun', 1, 1, 'lightning');
          r.statusesApplied.push('stun');
        }
        r.damage = total; r.aoeTargets = targets;
        r.flavorText = `THUNDERCLAP! All party Stunned!`;
        break;
      }
      case 'static_field_tick': {
        // Passive — 2 lightning dmg to all party each turn (called by resolveAction for Storm Herald)
        const targets = alivePartyIdx();
        let total = 0;
        for (const ti of targets) { this.party[ti].hp = Math.max(0, this.party[ti].hp - 2); total += 2; }
        r.damage = total; r.aoeTargets = targets;
        r.flavorText = `Static Field crackles — 2 lightning damage to all!`;
        break;
      }

      // ── TEMPEST CORE ────────────────────────────────────────────────────────
      case 'chain_discharge': {
        const targets = alivePartyIdx();
        let total = 0;
        for (const ti of targets) {
          total += dealDmg(this.party[ti], 14);
          if (Math.random() < 0.30) { applyStatus(this.party[ti].statuses, 'stun', 1, 1, 'lightning'); r.statusesApplied.push('stun'); }
        }
        r.damage = total; r.aoeTargets = targets;
        r.flavorText = `Chain Discharge arcs through all targets!`;
        break;
      }
      case 'overload_discharge': {
        const targets = alivePartyIdx();
        let total = 0;
        for (const ti of targets) {
          total += dealDmg(this.party[ti], 28);
          applyStatus(this.party[ti].statuses, 'stun', 2, 1, 'lightning');
          r.statusesApplied.push('stun');
        }
        r.damage = total; r.aoeTargets = targets;
        r.flavorText = `OVERLOAD DISCHARGE! Massive lightning AoE!`;
        break;
      }
      case 'conductor_supercharge': {
        attacker.abilityDmgMultiplier *= 2;
        attacker.meleeDmgMin = Math.round(attacker.meleeDmgMin * 2);
        attacker.meleeDmgMax = Math.round(attacker.meleeDmgMax * 2);
        r.flavorText = `CONDUCTOR SUPERCHARGE! Tempest Core's power doubles!`;
        break;
      }

      // ── WRAITH ──────────────────────────────────────────────────────────────
      case 'phase_strike_resolve': {
        // Unblockable — bypass shield and defense entirely
        const baseDmg = Math.round((attacker.meleeDmgMin + attacker.meleeDmgMax) / 2 * mult * 1.6);
        const final = Math.max(1, baseDmg - Math.floor(target.elementalResist * 0.5));
        target.hp = Math.max(0, target.hp - final);
        r.damage = final; r.critical = true;
        r.flavorText = `Phase Strike — unblockable!`;
        break;
      }
      case 'void_pull': {
        // No damage — reduces target defence for 2 turns
        applyStatus(target.statuses, 'exposure', 2, 3, 'void');
        r.statusesApplied.push('exposure');
        r.flavorText = `Void Pull! ${target.name} defence reduced!`;
        break;
      }
      case 'drain_touch': {
        r.damage = dealDmg(target, 12);
        const healed = Math.floor(r.damage * 0.5);
        attacker.hp = Math.min(attacker.maxHp, attacker.hp + healed);
        r.healAmount = healed;
        r.flavorText = `Drain Touch! ${attacker.name} absorbs ${healed} HP!`;
        break;
      }
      case 'tether_death_refund': {
        // WRAITH dies — WEAVER heals
        const weaver = this.enemies.find(e => e.name === 'Void Weaver' && !e.dead);
        if (weaver) { weaver.hp = Math.min(weaver.maxHp, weaver.hp + 20); r.healAmount = 20; }
        r.flavorText = `Tether breaks — Void Weaver absorbs ${r.healAmount} HP!`;
        break;
      }

      // ── ENTROPY STALKER ─────────────────────────────────────────────────────
      case 'shadow_step': {
        // Self — guaranteed crit next attack (set in AI, no damage here)
        r.flavorText = `${attacker.name} shadow-steps! Next strike is guaranteed critical!`;
        break;
      }
      case 'entropy_surge': {
        r.damage = dealDmg(target, 11);
        applyStatus(target.statuses, 'entropy', 5, 1, 'void');
        r.statusesApplied.push('entropy');
        r.flavorText = `Entropy Surge! ${target.name} gains an Entropy stack (−3% all stats)!`;
        break;
      }

      // ── VOID WEAVER ─────────────────────────────────────────────────────────
      case 'void_tether_cast': {
        // Re-tether wraiths — handled by AI; no damage
        r.flavorText = `${attacker.name} reweaves the void tethers!`;
        break;
      }
      case 'dark_pull': {
        const targets = alivePartyIdx();
        for (const ti of targets) {
          applyStatus(this.party[ti].statuses, 'exposure', 2, 2, 'void');
          r.statusesApplied.push('exposure');
        }
        r.aoeTargets = targets;
        r.flavorText = `Dark Pull! All party members' defences reduced!`;
        break;
      }

      // ── NULL SOVEREIGN ──────────────────────────────────────────────────────
      case 'tendril_strike': {
        // Multi-hit: 2 strikes
        r.damage  = dealDmg(target, 12);
        r.damage += dealDmg(target, 10);
        applyStatus(target.statuses, 'entropy', 3, 1, 'void');
        r.statusesApplied.push('entropy');
        r.flavorText = `Tendril Strike — double hit! Entropy applied!`;
        break;
      }
      case 'void_barrage': {
        const targets = alivePartyIdx();
        let total = 0;
        for (const ti of targets) {
          total += dealDmg(this.party[ti], 12);
          applyStatus(this.party[ti].statuses, 'entropy', 3, 1, 'void');
          r.statusesApplied.push('entropy');
        }
        r.damage = total; r.aoeTargets = targets;
        r.flavorText = `Void Bolt Barrage! Entropy spreads!`;
        break;
      }
      case 'void_collapse': {
        const targets = alivePartyIdx();
        let total = 0;
        for (const ti of targets) {
          total += dealDmg(this.party[ti], 22);
          applyStatus(this.party[ti].statuses, 'entropy', 5, 2, 'void');
          r.statusesApplied.push('entropy');
        }
        r.damage = total; r.aoeTargets = targets;
        r.flavorText = `VOID COLLAPSE! Massive entropy pull!`;
        break;
      }
      case 'singularity_pull_tick': {
        const targets = alivePartyIdx();
        let total = 0;
        for (const ti of targets) {
          total += dealDmg(this.party[ti], 16);
          applyStatus(this.party[ti].statuses, 'stun', 1, 1, 'void');
          r.statusesApplied.push('stun');
        }
        r.damage = total; r.aoeTargets = targets;
        r.flavorText = `SINGULARITY PULL! All targets drawn in and Stunned!`;
        break;
      }

      // ── Fallback ─────────────────────────────────────────────────────────────
      // ── Ally ability forwarding ──────────────────────────────────────────
      case 'coordinate_strike': case 'rally': case 'plasma_net':
      case 'void_lance': case 'thought_drain': case 'entropy_cascade':
      case 'ice_shard': case 'archive_bind': case 'catalogue_of_pain': {
        const result = resolveAllyAbility(
          r.abilityName!, attacker, target, this.party, this.enemies
        );
        r.damage     = result.damage;
        r.healAmount = result.healAmount;
        r.flavorText = result.flavorText;
        r.aoeTargets = result.aoeTargets;
        if (result.statusName) {
          const applyTargets = result.aoeTargets.length > 0
            ? result.aoeTargets.map(i => this.enemies[i]).filter(Boolean)
            : [target];
          for (const t of applyTargets) {
            if (!t) continue;
            applyStatus(t.statuses, result.statusName, result.statusTurns ?? 2, result.statusMagnitude ?? 1, attacker.element);
          }
        }
        break;
      }

      default: {
        // Unknown ability name — use generic scaled attack
        const base = (attacker.meleeDmgMin + attacker.meleeDmgMax) / 2;
        r.damage = dealDmg(target, base);
        r.flavorText = `${attacker.name} uses ${r.abilityName}!`;
        break;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  /** Absorb damage into shield first, returns remaining damage. */
  private _applyShield(target: Combatant, rawDmg: number): number {
    if (target.shieldHp <= 0) return rawDmg;
    const absorbed = Math.min(target.shieldHp, rawDmg);
    target.shieldHp -= absorbed;
    return rawDmg - absorbed;
  }

  /** Exposure stacks reduce defence — each stack = -2 defence for combat. */
  private _getExposureReduction(target: Combatant): number {
    const exp = target.statuses.find(s => s.type === 'exposure');
    return exp ? exp.magnitude * 2 : 0;
  }

  /**
   * Minion–leader bond damage bonus.
   * Leader alive: minion attacks deal 15% more damage.
   */
  private _getBondDamageMultiplier(attacker: Combatant, isEnemy: boolean): number {
    if (!isEnemy || !attacker.isEnemy) return 1.0;
    // Find attacker's template archetype
    const key = Object.entries(ENEMY_TEMPLATES).find(([, t]) => t.name === attacker.name)?.[0];
    if (!key) return 1.0;
    const tmpl = ENEMY_TEMPLATES[key];
    if (tmpl.archetype !== 'minion') return 1.0;
    // Check if leader of same element is alive
    const leaderAlive = this.enemies.some(e => {
      if (e.dead) return false;
      const ek = Object.entries(ENEMY_TEMPLATES).find(([, t]) => t.name === e.name)?.[0];
      if (!ek) return false;
      const et = ENEMY_TEMPLATES[ek];
      return et.element === tmpl.element && et.archetype === 'leader';
    });
    return leaderAlive ? 1.15 : 1.0;
  }

  /** Small chance to apply the attacker's elemental status on a basic hit. */
  private _maybeApplyElementalStatus(
    element: ElementType, target: Combatant, r: ActionResult, chance: number
  ): void {
    if (Math.random() > chance) return;
    switch (element) {
      case 'fire':      applyStatus(target.statuses, 'burn',    2, 3, element); r.statusesApplied.push('burn');    break;
      case 'ice':       applyStatus(target.statuses, 'slow',    2, 1, element); r.statusesApplied.push('slow');    break;
      case 'lightning': applyStatus(target.statuses, 'stun',    1, 1, element); r.statusesApplied.push('stun');    break;
      case 'void':      applyStatus(target.statuses, 'entropy', 3, 1, element); r.statusesApplied.push('entropy'); break;
    }
  }

  /** After any action: check death, notify bonds, advance turn. */
  private _finishAction(
    attacker: Combatant, target: Combatant, r: ActionResult, isEnemy: boolean
  ): void {
    attacker.spirit = Math.min(attacker.maxSpirit, attacker.spirit + 3);
    target.spirit   = Math.max(0, target.spirit - 2);

    if (target.hp <= 0) {
      target.dead = true;
      r.killed = true;

      if (target.isEnemy) {
        const key = Object.entries(ENEMY_TEMPLATES).find(([, t]) => t.name === target.name)?.[0];
        if (key) {
          const tmpl = ENEMY_TEMPLATES[key];
          this.totalXp    += tmpl.xpReward;
          this.totalCoins += tmpl.coinReward;
          const loot = generateLoot(key as EnemyArchetype, target.element, Math.random);
          for (const item of loot) this.droppedItems.push(item);

          // Notify bond — if a leader died, frenzy its minions
          if (tmpl.archetype === 'leader') {
            this.enemies.forEach((e, i) => {
              if (e.dead) return;
              const ek = Object.entries(ENEMY_TEMPLATES).find(([, t]) => t.name === e.name)?.[0];
              if (!ek) return;
              const et = ENEMY_TEMPLATES[ek];
              if (et.archetype === 'minion' && et.element === tmpl.element) {
                this._enemyAIs[i]?.notifyBondBroken();
              }
            });
          }

          // Wraith tether death refund
          if (tmpl.archetype === 'minion' && tmpl.element === 'void') {
            const weaverIdx = this.enemies.findIndex(e => e.name === 'Void Weaver' && !e.dead);
            if (weaverIdx >= 0) {
              this.enemies[weaverIdx].hp = Math.min(
                this.enemies[weaverIdx].maxHp,
                this.enemies[weaverIdx].hp + 20
              );
            }
          }
        }
      }
    }

    // AoE kill check — mark dead before victory evaluation
    for (const ti of r.aoeTargets) {
      const aoeTarget = isEnemy ? this.party[ti] : this.enemies[ti];
      if (aoeTarget && aoeTarget.hp <= 0) aoeTarget.dead = true;
    }

    if (this.enemies.every(e => e.dead)) {
      this.phase = 'victory';
    } else if (this.party.every(p => p.dead)) {
      this.phase = 'defeat';
    } else {
      this._advanceTurn();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TURN MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────

  pickEnemyAction(): CombatAction {
    const enc = this.turnOrder[this.currentTurnIndex];
    if (enc >= 0) return { type: 'melee', targetIndex: 0 };
    const enemyIdx = -(enc + 1);
    const ai = this._enemyAIs[enemyIdx];
    if (!ai) return { type: 'melee', targetIndex: 0 };

    const ctx: import('./EnemyAI').CombatContext = {
      party:   this.party.map((c, i) => ({ combatant: c, index: i })),
      enemies: this.enemies.map((c, i) => ({ combatant: c, index: i, ai: this._enemyAIs[i]! })),
      turn:      this.turnNumber,
      selfIndex: enemyIdx,
    };
    return ai.selectAction(ctx);
  }

  private _advanceTurn(): void {
    // Tick statuses on the combatant whose turn just ended
    const current = this.getActiveCombatant();
    if (current) {
      this._tickStatuses(current);
      for (let i = 0; i < current.cooldowns.length; i++) {
        if (current.cooldowns[i] > 0) current.cooldowns[i]--;
      }
    }

    let attempts = 0;
    do {
      this.currentTurnIndex++;
      if (this.currentTurnIndex >= this.turnOrder.length) {
        this.currentTurnIndex = 0;
        this.turnNumber++;
        this._buildTurnOrder();
      }
      attempts++;
    } while (attempts < this.turnOrder.length * 2 && this._isCurrentDead());

    this.phase = this.isPlayerTurn() ? 'player_turn' : 'enemy_turn';
  }

  /**
   * Tick all active status effects on a combatant, applying per-turn damage.
   * Called at the END of each combatant's turn.
   */
  private _tickStatuses(c: Combatant): void {
    const toRemove: number[] = [];
    for (let i = 0; i < c.statuses.length; i++) {
      const s = c.statuses[i];
      switch (s.type) {
        case 'burn':
          c.hp = Math.max(0, c.hp - s.magnitude);
          if (c.hp <= 0) c.dead = true;
          break;
        case 'exposure':
          // Purely stat reduction — no per-turn damage. Just tick down.
          break;
        case 'entropy':
          // Each stack = permanent stat drain (already factored via _getExposureReduction)
          break;
        case 'slow':
          // Handled by attackSpeed reduction — halve attackSpeed while active
          // (we set it on apply and restore on removal)
          break;
        case 'stun':
          c.stunned = true;
          break;
        case 'freeze':
          c.hp = Math.max(0, c.hp - s.magnitude);
          c.stunned = true;
          if (c.hp <= 0) c.dead = true;
          break;
      }
      s.remaining--;
      if (s.remaining <= 0) toRemove.push(i);
    }
    // Remove expired statuses in reverse order
    for (let i = toRemove.length - 1; i >= 0; i--) {
      c.statuses.splice(toRemove[i], 1);
    }
  }

  private _isCurrentDead(): boolean {
    const enc = this.turnOrder[this.currentTurnIndex];
    if (enc >= 0) return this.party[enc]?.dead ?? true;
    return this.enemies[-(enc + 1)]?.dead ?? true;
  }

  getStatusDisplay(c: Combatant): string {
    if (!c.statuses.length && !c.shieldHp) return '';
    const parts: string[] = [];
    if (c.shieldHp > 0) parts.push(`🛡${c.shieldHp}`);
    for (const s of c.statuses) {
      switch (s.type) {
        case 'burn':    parts.push(`🔥${s.remaining}`);  break;
        case 'slow':    parts.push(`❄${s.remaining}`);  break;
        case 'stun':    parts.push(`⚡${s.remaining}`);  break;
        case 'entropy': parts.push(`🌀×${s.magnitude}`); break;
        case 'exposure':parts.push(`💔${s.remaining}`);  break;
        case 'freeze':  parts.push(`🧊${s.remaining}`);  break;
      }
    }
    return parts.join(' ');
  }

  /**
   * Add persona allies to the party before/after initCombat.
   * Pass the personas that should join (player is always index 0).
   * AllyAI instances drive their turns via pickAllyAction().
   */
  addAllyPartyMembers(personas: PersonaName[]): void {
    for (const p of personas) {
      // Avoid duplicates
      if (this.party.some(c => c.name === p.toUpperCase())) continue;
      this.party.push(buildAllyCombatant(p));
    }
    // Rebuild turn order to include new members
    this._buildTurnOrder();
  }

  reset(): void {
    this.phase = 'idle';
    this.party.length = 0;
    this.enemies.length = 0;
    this.turnOrder.length = 0;
    this.results.length = 0;
    this.droppedItems.length = 0;
    this._enemyAIs.length = 0;
    this.currentTurnIndex = 0;
    this.turnNumber = 0;
    this.totalXp = 0;
    this.totalCoins = 0;
  }
}
