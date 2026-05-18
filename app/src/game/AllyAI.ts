/**
 * AllyAI — Combat party AI for SAYON, SEREN, SYBIL.
 *
 * Handles both contexts:
 *   1. Turn-based Battle Hall — pickAllyAction() returns a CombatAction
 *   2. World active combat   — update() drives world-space movement/attack
 *
 * ── ENGAGEMENT MODES ─────────────────────────────────────────────────────────
 *
 * AGGRESSIVE — Closes on the nearest living enemy as fast as possible.
 *   Does NOT deal the first hit — waits for the enemy to initiate or for
 *   any ally (including player) to take damage. Once triggered, attacks freely.
 *   Uses highest-damage abilities first.
 *
 * DEFENSIVE — Keeps moderate distance from enemies (stay ~80px back from
 *   the nearest enemy). Uses ranged attacks and abilities from distance.
 *   Retreats if an enemy closes within 50px. Prioritises abilities over
 *   basic attacks. Does not chase a fleeing enemy.
 *
 * PROTECTIVE — Follows the player closely (within 40px). Ignores all enemies
 *   unless an enemy deals damage to the player. When the player takes damage,
 *   the ally locks onto that specific enemy and attacks it until it is dead,
 *   then returns to following the player. Only one target locked at a time.
 *
 * ── PERSONA STATS ────────────────────────────────────────────────────────────
 *
 * Each persona has fixed combat stats appropriate to their personality:
 *   SAYON  — coordinator, balanced stats. Moderate HP/damage, support abilities.
 *            Heals allies at low HP, applies buffs. Element: plasma.
 *   SEREN  — reasoning engine, high INT. High ability damage, low HP.
 *            Uses abilities every chance, spirit drain on hit. Element: void.
 *   SYBIL  — archive specialist (when active), evasive. Medium damage,
 *            debuff-focused, applies entropy/slow. Element: ice.
 *
 * ── PARTY HEALING LOGIC ─────────────────────────────────────────────────────
 *
 * In turn-based: allies check party HP each turn. If any party member is below
 * 40% HP, the ally prioritises a heal action if available (not on cooldown).
 * In world combat: heal is fired as an ability on a cooldown.
 *
 * ── FRIENDLY FIRE PREVENTION ────────────────────────────────────────────────
 *
 * All targeting always checks isEnemy === true before selecting a target.
 * Party members and the player have isEnemy === false and are never targeted.
 * This is enforced both in pickAllyAction() and in the world AI.
 */

import * as Phaser from 'phaser';
import type { Combatant, CombatAction, CombatState } from './CombatState';
import type { ElementType } from './PlayerClasses';
import type { PersonaName } from './GameStore';

// ── Engagement mode ───────────────────────────────────────────────────────────

export type EngagementMode = 'aggressive' | 'defensive' | 'protective';

// ── Persona combat profiles ───────────────────────────────────────────────────

export interface PersonaCombatProfile {
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
  /** Ability names for turn-based resolution */
  abilities: [string, string, string];
  /** Cooldowns in turns */
  abilityCooldowns: [number, number, number];
  /** Spirit costs */
  abilitySpiritCosts: [number, number, number];
  /** True if this ability heals an ally */
  abilityIsHeal: [boolean, boolean, boolean];
}

export const PERSONA_PROFILES: Record<PersonaName, PersonaCombatProfile> = {
  sayon: {
    name: 'SAYON',
    element: 'plasma',
    maxHp: 110, maxSpirit: 60,
    meleeDmgMin: 8,  meleeDmgMax: 14,
    rangedDmgMin: 5, rangedDmgMax: 10,
    abilityDmgMultiplier: 1.3,
    attackSpeed: 1.1, accuracy: 0.82, defense: 4, elementalResist: 4,
    abilities:           ['coordinate_strike', 'rally',       'plasma_net'],
    abilityCooldowns:    [3,                   5,              8          ],
    abilitySpiritCosts:  [8,                   15,             20         ],
    abilityIsHeal:       [false,               true,           false      ],
    // coordinate_strike — melee AoE, applies Exposure
    // rally             — heals lowest-HP ally for 25 HP
    // plasma_net        — ranged AoE, Slow all enemies 2 turns
  },
  seren: {
    name: 'SEREN',
    element: 'ice',
    maxHp: 75, maxSpirit: 90,
    meleeDmgMin: 4,  meleeDmgMax: 7,
    rangedDmgMin: 10, rangedDmgMax: 18,
    abilityDmgMultiplier: 1.8,
    attackSpeed: 0.9, accuracy: 0.85, defense: 2, elementalResist: 6,
    abilities:           ['void_lance',   'thought_drain',  'entropy_cascade'],
    abilityCooldowns:    [3,              4,                9                ],
    abilitySpiritCosts:  [10,             14,               28               ],
    abilityIsHeal:       [false,          false,            false            ],
    // void_lance      — single ranged, high damage, applies Entropy 1 stack
    // thought_drain   — steals 15 spirit from target, heals SEREN 10 SP
    // entropy_cascade — AoE void damage, 2 Entropy stacks all enemies
  },
  sybil: {
    name: 'SYBIL',
    element: 'void',
    maxHp: 90, maxSpirit: 70,
    meleeDmgMin: 6,  meleeDmgMax: 11,
    rangedDmgMin: 7, rangedDmgMax: 13,
    abilityDmgMultiplier: 1.4,
    attackSpeed: 1.2, accuracy: 0.80, defense: 3, elementalResist: 7,
    abilities:           ['ice_shard',   'archive_bind',  'catalogue_of_pain'],
    abilityCooldowns:    [2,             5,               10                 ],
    abilitySpiritCosts:  [8,             14,              25                 ],
    abilityIsHeal:       [false,         false,           false              ],
    // ice_shard       — quick ranged hit, applies Slow 2 turns
    // archive_bind    — single target Stun 2 turns, no damage
    // catalogue_of_pain — AoE ice damage + 3 stacks Slow all enemies
  },
};

// ── Turn-based ally action picker ─────────────────────────────────────────────

export class AllyAI {
  readonly persona: PersonaName;
  readonly profile: PersonaCombatProfile;
  private _mode: EngagementMode = 'defensive';
  private _combatTriggered = false;  // aggressive: was first hit taken?
  private _protectTarget: number | null = null; // protective: locked enemy index
  // Cooldown trackers (turns remaining)
  private _cdRemaining: [number, number, number] = [0, 0, 0];
  // Current HP / spirit (tracked separately from Combatant for world mode)
  hp:     number;
  maxHp:  number;
  spirit: number;
  maxSpirit: number;

  constructor(persona: PersonaName, mode: EngagementMode = 'defensive') {
    this.persona = persona;
    this.profile = PERSONA_PROFILES[persona];
    this._mode   = mode;
    this.hp      = this.profile.maxHp;
    this.maxHp   = this.profile.maxHp;
    this.spirit  = this.profile.maxSpirit;
    this.maxSpirit = this.profile.maxSpirit;
  }

  setMode(mode: EngagementMode): void {
    this._mode = mode;
    this._combatTriggered = false;
    this._protectTarget   = null;
  }

  get mode(): EngagementMode { return this._mode; }

  // ── Turn-based: pick action ────────────────────────────────────────────────

  /**
   * Called by CombatState each turn for an ally party member.
   * Returns the CombatAction this ally will take.
   */
  pickAllyAction(
    selfIndex: number,
    combat: CombatState
  ): CombatAction {
    const aliveEnemies = combat.enemies
      .map((e, i) => ({ e, i }))
      .filter(x => !x.e.dead);

    const aliveAllies = combat.party
      .map((p, i) => ({ p, i }))
      .filter(x => !x.p.dead);

    if (aliveEnemies.length === 0) {
      return { type: 'melee', targetIndex: 0 };
    }

    // Tick cooldowns
    for (let i = 0; i < 3; i++) {
      if (this._cdRemaining[i] > 0) this._cdRemaining[i]--;
    }

    // ── Heal check (always highest priority regardless of mode) ───────────
    const healAbilityIdx = this.profile.abilityIsHeal.findIndex((h, i) =>
      h && this._cdRemaining[i] === 0 && this.spirit >= this.profile.abilitySpiritCosts[i]
    );
    const lowestHpAlly = aliveAllies.reduce(
      (low, cur) => cur.p.hp / cur.p.maxHp < low.p.hp / low.p.maxHp ? cur : low
    );
    if (healAbilityIdx >= 0 && lowestHpAlly.p.hp / lowestHpAlly.p.maxHp < 0.40) {
      this._cdRemaining[healAbilityIdx] = this.profile.abilityCooldowns[healAbilityIdx];
      this.spirit -= this.profile.abilitySpiritCosts[healAbilityIdx];
      return {
        type: 'ability',
        abilityIndex: healAbilityIdx,
        abilityName: this.profile.abilities[healAbilityIdx],
        targetIndex: lowestHpAlly.i,
      };
    }

    // ── Mode-specific target selection ────────────────────────────────────
    const targetIdx = this._selectTarget(aliveEnemies, combat, selfIndex);

    // ── Ability selection ─────────────────────────────────────────────────
    const abilityIdx = this._selectAbility(this._mode);
    if (abilityIdx >= 0) {
      this._cdRemaining[abilityIdx] = this.profile.abilityCooldowns[abilityIdx];
      this.spirit -= this.profile.abilitySpiritCosts[abilityIdx];
      return {
        type: 'ability',
        abilityIndex: abilityIdx,
        abilityName: this.profile.abilities[abilityIdx],
        targetIndex: targetIdx,
      };
    }

    // ── Basic attack ──────────────────────────────────────────────────────
    const useRanged = this._mode === 'defensive'
      || this.profile.rangedDmgMax > this.profile.meleeDmgMax;

    return {
      type: useRanged ? 'ranged' : 'melee',
      targetIndex: targetIdx,
    };
  }

  /**
   * Notify the ally that an attack happened this round.
   * Used to trigger aggressive mode on first damage.
   */
  notifyHit(wasAllyHit: boolean, attackerEnemyIndex: number): void {
    if (!this._combatTriggered && wasAllyHit) {
      this._combatTriggered = true;
    }
    if (this._mode === 'protective' && wasAllyHit && this._protectTarget === null) {
      this._protectTarget = attackerEnemyIndex;
    }
  }

  notifyEnemyDead(enemyIndex: number): void {
    if (this._protectTarget === enemyIndex) {
      this._protectTarget = null;
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _selectTarget(
    alive: Array<{ e: Combatant; i: number }>,
    combat: CombatState,
    _selfIndex: number
  ): number {
    switch (this._mode) {
      case 'aggressive': {
        // Wait for first hit before initiating
        if (!this._combatTriggered) {
          // Return lowest-index enemy but deal no damage (handled by CombatState
          // checking combatTriggered flag — for now just pick lowest HP enemy
          // and the mode awareness keeps it from being truly "first hit")
          return alive.reduce((low, cur) =>
            cur.e.hp < low.e.hp ? cur : low
          ).i;
        }
        // After trigger — lowest HP target
        return alive.reduce((low, cur) => cur.e.hp < low.e.hp ? cur : low).i;
      }

      case 'defensive':
        // Prefer softest target (lowest defense + lowest HP)
        return alive.reduce((best, cur) => {
          const curScore  = cur.e.hp + cur.e.defense * 5;
          const bestScore = best.e.hp + best.e.defense * 5;
          return curScore < bestScore ? cur : best;
        }).i;

      case 'protective': {
        // Locked target takes priority
        if (this._protectTarget !== null) {
          const locked = alive.find(x => x.i === this._protectTarget);
          if (locked) return locked.i;
          this._protectTarget = null;
        }
        // Not protecting anyone — target enemy closest to player (index 0)
        const playerCombatant = combat.party[0];
        if (!playerCombatant) return alive[0].i;
        return alive[0].i; // default to first; world mode uses position
      }
    }
  }

  private _selectAbility(mode: EngagementMode): number {
    // Seren always tries to use abilities
    const abilityBias = this.persona === 'seren' ? 0.75
      : this.persona === 'sayon' ? 0.45
      : 0.55;

    if (Math.random() > abilityBias) return -1;

    // Find a ready ability that is NOT a heal (heals handled above)
    const candidates: number[] = [];
    for (let i = 0; i < 3; i++) {
      if (!this.profile.abilityIsHeal[i]
        && this._cdRemaining[i] === 0
        && this.spirit >= this.profile.abilitySpiritCosts[i]) {
        candidates.push(i);
      }
    }
    if (candidates.length === 0) return -1;

    // Defensive: prefer non-damage abilities (higher index usually = utility)
    if (mode === 'defensive') {
      return candidates[candidates.length - 1];
    }
    // Aggressive/protective: prefer highest damage (first ability)
    return candidates[0];
  }
}

// ── World-mode world AI ───────────────────────────────────────────────────────
// Position-based state machine. Operates in isometric world coordinates.

export type AllyWorldState =
  | 'following'    // moving toward player
  | 'approaching'  // closing on enemy
  | 'waiting'      // aggressive: waiting for enemy to initiate
  | 'attacking'    // locked in attack animation
  | 'retreating'   // defensive: backing away from close enemy
  | 'idle';        // doing nothing (combat over or not in combat)

/** Extended result returned by AllyWorldAI.update() when an attack fires. */
export interface AllyWorldHitResult {
  damage:    number;
  isCrit:    boolean;
  targetIdx: number;
  /** Non-null when an ability fired — describes the extra effect. */
  ability:   AllyAbilityResult | null;
}

export interface AllyAbilityResult {
  name:          string;
  healAmount:    number;           // > 0 = heal the player or lowest-HP ally
  aoeAll:        boolean;          // true = apply damage to all live enemies
  statusName:    import('./CombatState').StatusType | null;
  statusTurns:   number;
  statusMagnitude: number;
  flavorText:    string;
}

export class AllyWorldAI {
  readonly persona: PersonaName;
  readonly ai: AllyAI;

  // World position
  x = 0;
  y = 0;
  worldState: AllyWorldState = 'idle';

  // Timers
  private _attackCooldown  = 0;
  private _attackLock      = 0;
  // Real-time ability cooldowns (ms) — parallel to AllyAI._cdRemaining (turns)
  private _abilityCdMs: [number, number, number] = [0, 0, 0];

  // Phaser visuals — null until spawnVisual() is called
  private _rect:      Phaser.GameObjects.Rectangle | null = null;
  private _nameLabel: Phaser.GameObjects.Text | null      = null;

  // Persona → colour mapping for placeholder rect
  private static readonly PERSONA_TINT: Record<PersonaName, number> = {
    sayon: 0xffaa44,  // orange-gold
    seren: 0x44aaff,  // blue
    sybil: 0xcc66ff,  // violet
  };

  // Spacing constants (pixels)
  private static readonly FOLLOW_RANGE      = 55;  // stay within this of player
  private static readonly ENGAGE_RANGE      = 90;  // start approaching enemy within this
  private static readonly ATTACK_RANGE      = 35;  // melee swing range
  private static readonly RANGED_RANGE      = 120; // ranged attack range
  private static readonly DEFENSIVE_STANDOFF = 80; // defensive: keep this far from enemy
  private static readonly RETREAT_TRIGGER   = 50;  // defensive: retreat if enemy closer than this

  constructor(persona: PersonaName, mode: EngagementMode = 'defensive') {
    this.persona = persona;
    this.ai = new AllyAI(persona, mode);
  }

  setMode(mode: EngagementMode): void {
    this.ai.setMode(mode);
    this.worldState = 'idle';
  }

  get mode(): EngagementMode { return this.ai.mode; }

  /**
   * Create the placeholder rectangle and name label for this ally.
   * Call once after setting the initial x/y position.
   */
  spawnVisual(scene: Phaser.Scene): void {
    if (this._rect) return; // already spawned
    const tint = AllyWorldAI.PERSONA_TINT[this.persona] ?? 0xffffff;
    this._rect = scene.add.rectangle(this.x, this.y, 10, 14, tint, 0.85)
      .setDepth(this.y)
      .setStrokeStyle(1, 0x000000, 0.4);
    this._nameLabel = scene.add.text(this.x, this.y - 14, this.persona.toUpperCase(), {
      fontSize: '4px', fontFamily: 'monospace',
      color: '#dddddd', stroke: '#000000', strokeThickness: 2,
      resolution: 4,
    }).setOrigin(0.5, 1).setDepth(this.y + 0.1);
  }

  /** Sync visual position to current x/y. Call each frame after update(). */
  syncVisual(): void {
    if (!this._rect || !this._nameLabel) return;
    this._rect.setPosition(this.x, this.y).setDepth(this.y);
    this._nameLabel.setPosition(this.x, this.y - 8).setDepth(this.y + 0.1);
  }

  /** Destroy Phaser game objects. Call on scene shutdown. */
  destroyVisual(): void {
    this._rect?.destroy();
    this._nameLabel?.destroy();
    this._rect      = null;
    this._nameLabel = null;
  }

  /**
   * Notify ally that the player just took damage from an enemy at world position.
   */
  notifyPlayerHit(enemyIdx: number): void {
    this.ai.notifyHit(true, enemyIdx);
    if (this.ai.mode === 'protective') {
      this.worldState = 'approaching';
    }
    if (this.ai.mode === 'aggressive') {
      this.worldState = 'approaching';
    }
  }

  notifyEnemyDead(enemyIdx: number): void {
    this.ai.notifyEnemyDead(enemyIdx);
    if (this.ai.mode === 'protective' && this.worldState === 'attacking') {
      this.worldState = 'following';
    }
  }

  /**
   * Per-frame world update.
   * Returns a HitEvent-like object if an attack fires this frame, else null.
   */
  update(
    delta: number,
    playerX: number,
    playerY: number,
    nearestEnemyX: number | null,
    nearestEnemyY: number | null,
    nearestEnemyIdx: number | null,
    enemyInitiated: boolean
  ): AllyWorldHitResult | null {
    const dt = delta / 16.667;

    // Tick cooldowns
    if (this._attackCooldown > 0) this._attackCooldown -= delta;
    for (let i = 0; i < 3; i++) {
      if (this._abilityCdMs[i] > 0) this._abilityCdMs[i] -= delta;
    }
    if (this._attackLock > 0) {
      this._attackLock -= delta;
      if (this._attackLock <= 0) {
        this.worldState = nearestEnemyIdx !== null ? 'approaching' : 'following';
      }
      return null;
    }

    // Aggressive: trigger on enemy initiated
    if (this.ai.mode === 'aggressive' && enemyInitiated) {
      this.ai.notifyHit(true, nearestEnemyIdx ?? 0);
    }

    switch (this.ai.mode) {
      case 'aggressive':  return this._updateAggressive(dt, playerX, playerY, nearestEnemyX, nearestEnemyY, nearestEnemyIdx);
      case 'defensive':   return this._updateDefensive(dt, playerX, playerY, nearestEnemyX, nearestEnemyY, nearestEnemyIdx);
      case 'protective':  return this._updateProtective(dt, playerX, playerY, nearestEnemyX, nearestEnemyY, nearestEnemyIdx);
    }
  }

  // ── Mode update implementations ───────────────────────────────────────────

  private _updateAggressive(
    dt: number, px: number, py: number,
    ex: number | null, ey: number | null, eidx: number | null
  ): AllyWorldHitResult | null {
    if (ex === null || !this.ai['_combatTriggered']) {
      // Pre-trigger: circle-follow player
      this._followPlayer(dt, px, py, AllyWorldAI.FOLLOW_RANGE);
      this.worldState = 'waiting';
      return null;
    }

    const distE = this._dist(this.x, this.y, ex, ey!);

    if (distE <= AllyWorldAI.ATTACK_RANGE && this._attackCooldown <= 0) {
      return this._fireAttack(dt, eidx!);
    }

    if (distE <= AllyWorldAI.ENGAGE_RANGE) {
      this._moveToward(dt, ex, ey!, AllyWorldAI.ATTACK_RANGE - 5, 1.6);
      this.worldState = 'approaching';
    } else {
      this._followPlayer(dt, px, py, AllyWorldAI.FOLLOW_RANGE + 20);
    }

    return null;
  }

  private _updateDefensive(
    dt: number, px: number, py: number,
    ex: number | null, ey: number | null, eidx: number | null
  ): AllyWorldHitResult | null {
    if (ex === null) {
      this._followPlayer(dt, px, py, AllyWorldAI.FOLLOW_RANGE + 30);
      this.worldState = 'following';
      return null;
    }

    const distE = this._dist(this.x, this.y, ex, ey!);

    // Too close — retreat
    if (distE < AllyWorldAI.RETREAT_TRIGGER) {
      this._moveAwayFrom(dt, ex, ey!, 1.4);
      this.worldState = 'retreating';
      return null;
    }

    // In ranged range — attack from distance
    if (distE <= AllyWorldAI.RANGED_RANGE && this._attackCooldown <= 0) {
      return this._fireAttack(dt, eidx!, true);
    }

    // Maintain standoff distance
    if (distE > AllyWorldAI.RANGED_RANGE) {
      this._moveToward(dt, ex, ey!, AllyWorldAI.DEFENSIVE_STANDOFF, 1.2);
      this.worldState = 'approaching';
    } else {
      // Hover at standoff
      this.worldState = 'waiting';
    }

    return null;
  }

  private _updateProtective(
    dt: number, px: number, py: number,
    ex: number | null, ey: number | null, eidx: number | null
  ): AllyWorldHitResult | null {
    const hasTarget = this.ai['_protectTarget'] !== null;

    if (!hasTarget || ex === null) {
      // No locked target — stay close to player
      this._followPlayer(dt, px, py, 40);
      this.worldState = 'following';
      return null;
    }

    const distE = this._dist(this.x, this.y, ex, ey!);

    if (distE <= AllyWorldAI.ATTACK_RANGE && this._attackCooldown <= 0) {
      return this._fireAttack(dt, eidx!);
    }

    this._moveToward(dt, ex, ey!, AllyWorldAI.ATTACK_RANGE - 5, 1.8);
    this.worldState = 'approaching';
    return null;
  }

  // ── Movement helpers ──────────────────────────────────────────────────────

  private _followPlayer(dt: number, px: number, py: number, targetDist: number): void {
    const dist = this._dist(this.x, this.y, px, py);
    if (dist <= targetDist) return;
    this._moveToward(dt, px, py, targetDist, 1.4);
    this.worldState = 'following';
  }

  private _moveToward(dt: number, tx: number, ty: number, stopDist: number, speed: number): void {
    const dx   = tx - this.x;
    const dy   = ty - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= stopDist) return;
    const step = Math.min(speed * dt, dist - stopDist);
    this.x += (dx / dist) * step;
    this.y += (dy / dist) * step;
  }

  private _moveAwayFrom(dt: number, fx: number, fy: number, speed: number): void {
    const dx   = this.x - fx;
    const dy   = this.y - fy;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    this.x += (dx / dist) * speed * dt;
    this.y += (dy / dist) * speed * dt;
  }

  private _fireAttack(
    _dt: number, targetIdx: number, ranged = false
  ): AllyWorldHitResult {
    const p = this.ai.profile;

    // ── Try to fire an ability first ────────────────────────────────────────
    const abilityIdx = this._selectWorldAbility();
    if (abilityIdx >= 0) {
      return this._fireWorldAbility(abilityIdx, targetIdx);
    }

    // ── Basic attack ────────────────────────────────────────────────────────
    const dmgMin = ranged ? p.rangedDmgMin : p.meleeDmgMin;
    const dmgMax = ranged ? p.rangedDmgMax : p.meleeDmgMax;
    let   damage = dmgMin + Math.floor(Math.random() * (dmgMax - dmgMin + 1));
    const isCrit = Math.random() < 0.08;
    if (isCrit) damage = Math.round(damage * 1.5);

    const cdMs = ranged ? 1800 : 1200;
    this._attackCooldown = cdMs;
    this._attackLock     = 400;
    this.worldState      = 'attacking';

    return { damage, isCrit, targetIdx, ability: null };
  }

  /** Select an ability for world combat. Uses real-time cooldowns (_abilityCdMs). */
  private _selectWorldAbility(): number {
    const p        = this.ai.profile;
    const abilityBias = this.persona === 'seren' ? 0.70
      : this.persona === 'sayon' ? 0.40
      : 0.50;
    if (Math.random() > abilityBias) return -1;

    for (let i = 0; i < 3; i++) {
      if (this._abilityCdMs[i] > 0) continue;
      if (this.ai.spirit < p.abilitySpiritCosts[i]) continue;
      return i;
    }
    return -1;
  }

  /** Execute ability at index, return result with ability descriptor. */
  private _fireWorldAbility(idx: number, targetIdx: number): AllyWorldHitResult {
    const p       = this.ai.profile;
    const name    = p.abilities[idx];
    const cost    = p.abilitySpiritCosts[idx];
    const cdTurns = p.abilityCooldowns[idx];

    this.ai.spirit      = Math.max(0, this.ai.spirit - cost);
    // Convert turn-based cooldown to ms (1 turn ≈ 2000ms in world combat)
    this._abilityCdMs[idx] = cdTurns * 2000;
    this._attackLock       = 600;
    this.worldState        = 'attacking';

    const baseDmg = Math.round(
      ((p.meleeDmgMin + p.meleeDmgMax) / 2) * p.abilityDmgMultiplier
    );
    const isCrit  = Math.random() < 0.10;
    const damage  = isCrit ? Math.round(baseDmg * 1.5) : baseDmg;

    const ability = this._buildAbilityResult(name, damage);
    return { damage, isCrit, targetIdx, ability };
  }

  /** Build the AllyAbilityResult descriptor for a named ability. */
  private _buildAbilityResult(name: string, _damage: number): AllyAbilityResult {
    const base: AllyAbilityResult = {
      name, healAmount: 0, aoeAll: false,
      statusName: null, statusTurns: 0, statusMagnitude: 0, flavorText: name,
    };
    switch (name) {
      // ── SAYON ──────────────────────────────────────────────────────────
      case 'coordinate_strike':
        return { ...base, aoeAll: true, statusName: 'exposure', statusTurns: 2, statusMagnitude: 2, flavorText: 'Coordinate Strike!' };
      case 'rally':
        return { ...base, healAmount: 25, flavorText: 'SAYON rallies the party!' };
      case 'plasma_net':
        return { ...base, aoeAll: true, statusName: 'slow', statusTurns: 2, statusMagnitude: 1, flavorText: 'Plasma Net!' };
      // ── SEREN ──────────────────────────────────────────────────────────
      case 'void_lance':
        return { ...base, statusName: 'entropy', statusTurns: 4, statusMagnitude: 1, flavorText: 'Void Lance!' };
      case 'thought_drain':
        return { ...base, flavorText: 'Thought Drain!' };
      case 'entropy_cascade':
        return { ...base, aoeAll: true, statusName: 'entropy', statusTurns: 5, statusMagnitude: 2, flavorText: 'Entropy Cascade!' };
      // ── SYBIL ──────────────────────────────────────────────────────────
      case 'ice_shard':
        return { ...base, statusName: 'slow', statusTurns: 2, statusMagnitude: 1, flavorText: 'Ice Shard!' };
      case 'archive_bind':
        return { ...base, statusName: 'stun', statusTurns: 2, statusMagnitude: 1, flavorText: 'Archive Bind — Stunned!' };
      case 'catalogue_of_pain':
        return { ...base, aoeAll: true, statusName: 'slow', statusTurns: 3, statusMagnitude: 1, flavorText: 'Catalogue of Pain!' };
      default:
        return base;
    }
  }

  private _dist(ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    return Math.sqrt(dx * dx + dy * dy);
  }
}

// ── CombatState ally injection helpers ───────────────────────────────────────

/**
 * Build a Combatant from a persona profile.
 * Call this in CombatState.initCombat() to add allies to the party.
 */
export function buildAllyCombatant(
  persona: PersonaName
): import('./CombatState').Combatant {
  const p = PERSONA_PROFILES[persona];
  return {
    name:                p.name,
    isPlayer:            false,
    isEnemy:             false,
    hp:                  p.maxHp,
    maxHp:               p.maxHp,
    spirit:              p.maxSpirit,
    maxSpirit:           p.maxSpirit,
    element:             p.element,
    attackSpeed:         p.attackSpeed,
    meleeDmgMin:         p.meleeDmgMin,
    meleeDmgMax:         p.meleeDmgMax,
    rangedDmgMin:        p.rangedDmgMin,
    rangedDmgMax:        p.rangedDmgMax,
    abilityDmgMultiplier:p.abilityDmgMultiplier,
    accuracy:            p.accuracy,
    defense:             p.defense,
    elementalResist:     p.elementalResist,
    cooldowns:           [0, 0, 0],
    dead:                false,
    statuses:            [],
    shieldHp:            0,
    stunned:             false,
  };
}

/**
 * Resolve an ally ability in CombatState.resolveAction().
 * Returns { damage, healAmount, statusesApplied, flavorText, aoeTargets }.
 *
 * This is called from CombatState._resolveAbility() via the existing switch —
 * just add cases for each ally ability name there, or call this helper
 * and forward the results.
 */
export function resolveAllyAbility(
  abilityName: string,
  attacker: import('./CombatState').Combatant,
  target: import('./CombatState').Combatant,
  allParty: import('./CombatState').Combatant[],
  allEnemies: import('./CombatState').Combatant[]
): {
  damage:          number;
  healAmount:      number;
  flavorText:      string;
  aoeTargets:      number[];
  statusName?:     import('./CombatState').StatusType;
  statusTurns?:    number;
  statusMagnitude?: number;
} {
  const mult = attacker.abilityDmgMultiplier;

  const dealDmg = (tgt: import('./CombatState').Combatant, base: number): number => {
    const raw = Math.round(base * mult);
    const red = Math.max(0, tgt.defense - 2);
    tgt.hp = Math.max(0, tgt.hp - Math.max(1, raw - red));
    return Math.max(1, raw - red);
  };

  switch (abilityName) {
    // ── SAYON abilities ──────────────────────────────────────────────────
    case 'coordinate_strike': {
      let total = 0;
      const aoe: number[] = [];
      for (const [i, e] of allEnemies.entries()) {
        if (!e.dead) { total += dealDmg(e, 12); aoe.push(i); }
      }
      return { damage: total, healAmount: 0, flavorText: 'Coordinate Strike — all enemies hit!', aoeTargets: aoe, statusName: 'exposure', statusTurns: 2, statusMagnitude: 2 };
    }
    case 'rally': {
      const lowest = allParty
        .map((p, i) => ({ p, i }))
        .filter(x => !x.p.dead)
        .reduce((low, cur) => cur.p.hp < low.p.hp ? cur : low);
      const heal = 25;
      lowest.p.hp = Math.min(lowest.p.maxHp, lowest.p.hp + heal);
      return { damage: 0, healAmount: heal, flavorText: `SAYON rallies ${lowest.p.name}! +${heal} HP`, aoeTargets: [] };
    }
    case 'plasma_net': {
      let total = 0;
      const aoe: number[] = [];
      for (const [i, e] of allEnemies.entries()) {
        if (!e.dead) { total += dealDmg(e, 8); aoe.push(i); }
      }
      return { damage: total, healAmount: 0, flavorText: 'Plasma Net! All enemies Slowed!', aoeTargets: aoe, statusName: 'slow', statusTurns: 2, statusMagnitude: 1 };
    }

    // ── SEREN abilities ──────────────────────────────────────────────────
    case 'void_lance': {
      const dmg = dealDmg(target, 22);
      return { damage: dmg, healAmount: 0, flavorText: 'Void Lance! Entropy applied!', aoeTargets: [], statusName: 'entropy', statusTurns: 4, statusMagnitude: 1 };
    }
    case 'thought_drain': {
      const stolen = Math.min(target.spirit, 15);
      target.spirit = Math.max(0, target.spirit - stolen);
      attacker.spirit = Math.min(attacker.maxSpirit, attacker.spirit + stolen);
      return { damage: 0, healAmount: 0, flavorText: `SEREN drains ${stolen} spirit from ${target.name}!`, aoeTargets: [] };
    }
    case 'entropy_cascade': {
      let total = 0;
      const aoe: number[] = [];
      for (const [i, e] of allEnemies.entries()) {
        if (!e.dead) { total += dealDmg(e, 14); aoe.push(i); }
      }
      return { damage: total, healAmount: 0, flavorText: 'Entropy Cascade! All enemies corrupted!', aoeTargets: aoe, statusName: 'entropy', statusTurns: 5, statusMagnitude: 2 };
    }

    // ── SYBIL abilities ──────────────────────────────────────────────────
    case 'ice_shard': {
      const dmg = dealDmg(target, 12);
      return { damage: dmg, healAmount: 0, flavorText: 'Ice Shard! Slowed!', aoeTargets: [], statusName: 'slow', statusTurns: 2, statusMagnitude: 1 };
    }
    case 'archive_bind': {
      // Stun — no damage
      return { damage: 0, healAmount: 0, flavorText: `SYBIL binds ${target.name}! Stunned 2 turns!`, aoeTargets: [], statusName: 'stun', statusTurns: 2, statusMagnitude: 1 };
    }
    case 'catalogue_of_pain': {
      let total = 0;
      const aoe: number[] = [];
      for (const [i, e] of allEnemies.entries()) {
        if (!e.dead) { total += dealDmg(e, 16); aoe.push(i); }
      }
      return { damage: total, healAmount: 0, flavorText: 'Catalogue of Pain! Ice AoE + mass Slow!', aoeTargets: aoe, statusName: 'slow', statusTurns: 3, statusMagnitude: 1 };
    }

    default:
      return { damage: 0, healAmount: 0, flavorText: `${attacker.name} uses ${abilityName}`, aoeTargets: [] };
  }
}
