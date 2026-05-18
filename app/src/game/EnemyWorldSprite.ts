/**
 * EnemyWorldSprite — world-space enemy: visual rectangle + per-enemy state machine.
 *
 * One instance per live enemy. Owned and pooled by WorldCombatManager.
 * Does not allocate during update — all scratch state is on the object.
 *
 * AI states:
 *   patrol   — move toward patrolTarget, detect player within aggroRange
 *   aggro    — move toward player at aggro speed, enter attacking when close
 *   attacking — fire attackCooldown, deal damage when timer expires
 *   hit      — stagger, then return to aggro
 *   dead     — skip all updates, sprite hidden
 *
 * Graphics: coloured rectangle (per element) until real spritesheet is assigned.
 * Depth matches the isometric Y sort — updated each frame.
 */

import * as Phaser from 'phaser';
import type { EnemyTemplate } from './CombatState';
import type { ElementType } from './PlayerClasses';

// ── Element tint palette (placeholder rectangles) ─────────────────────────────
const ELEMENT_TINT: Record<ElementType, number> = {
  plasma:    0xcc88ff,
  fire:      0xff6622,
  ice:       0x88ddff,
  lightning: 0xffee44,
  void:      0x9966cc,
};

// ── Archetype speed table (world px / ms) ─────────────────────────────────────
const WALK_SPEED: Record<EnemyTemplate['archetype'], number> = {
  dummy:   0,
  minion:  0.055,
  warrior: 0.040,
  leader:  0.035,
  boss:    0.025,
};

const AGGRO_SPEED_MULT = 1.4;

// ── Aggro ranges by archetype (px) ────────────────────────────────────────────
const AGGRO_RANGE: Record<EnemyTemplate['archetype'], number> = {
  dummy:   0,
  minion:  96,
  warrior: 120,
  leader:  150,
  boss:    200,
};

const LEASH_MULT       = 1.5;   // lose aggro at aggroRange × leash
const ATTACK_RANGE_PX  = 44;    // px — melee contact
const STAGGER_MS       = 200;

// ── Types ─────────────────────────────────────────────────────────────────────

export type EnemyAIState = 'patrol' | 'aggro' | 'attacking' | 'hit' | 'dead';

export interface EnemySpawnOverrides {
  /** Multiplier on maxHp.     Applied at construction; hot path reads instance field. */
  hpMult:         number;
  /** Multiplier on meleeDmgMin/Max. Applied at construction; hot path reads instance fields. */
  damageMult:     number;
  /** Multiplier on walk/aggro speed. Applied at construction. */
  speedMult:      number;
  /** Multiplier on aggro detection range. Applied at construction. */
  aggroRangeMult: number;
}

export interface EnemyWorldSpriteConfig {
  templateId: string;
  template:   EnemyTemplate;
  spawnX:     number;
  spawnY:     number;
  /** Bounding box of zone in world-px — patrol target clamped to this. */
  zoneBounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Optional per-spawn stat overrides from DifficultyParams. Omit for baseline. */
  overrides?: EnemySpawnOverrides;
}

// ── EnemyWorldSprite ──────────────────────────────────────────────────────────

export class EnemyWorldSprite {
  // Identity
  readonly templateId: string;
  readonly template:   EnemyTemplate;

  // Live state
  hp:       number;
  maxHp:    number;
  aiState:  EnemyAIState = 'patrol';

  // Position (world px)
  x: number;
  y: number;

  // Patrol
  private _patrolX:  number;
  private _patrolY:  number;
  private _zoneBounds: { minX: number; minY: number; maxX: number; maxY: number };

  // Timers (ms)
  private _attackCooldown = 0;
  private _staggerTimer   = 0;

  // Scaled damage range — set from template × damageMult at construction.
  // _rollAttackDamage reads these instead of template directly so the hot path
  // never recomputes the multiplier.
  private _dmgMin: number;
  private _dmgMax: number;

  // Cached per-template constants (no per-frame lookup)
  private _walkSpeed:   number;
  private _aggroRange:  number;
  private _leashRange:  number;
  private _attackRate:  number;   // ms between attacks (derived from attackSpeed)

  // Phaser visual
  private _rect:    Phaser.GameObjects.Rectangle;
  private _hpBar:   Phaser.GameObjects.Rectangle;
  private _hpFill:  Phaser.GameObjects.Rectangle;

  // Scratch — reused each update, no allocation
  private _dx = 0;
  private _dy = 0;

  constructor(scene: Phaser.Scene, cfg: EnemyWorldSpriteConfig) {
    this.templateId  = cfg.templateId;
    this.template    = cfg.template;

    const ov = cfg.overrides;
    const hpMult     = ov ? ov.hpMult     : 1.0;
    const dmgMult    = ov ? ov.damageMult : 1.0;
    const spdMult    = ov ? ov.speedMult  : 1.0;
    const aggroMult  = ov ? ov.aggroRangeMult : 1.0;

    this.maxHp       = Math.ceil(cfg.template.maxHp * hpMult);
    this.hp          = this.maxHp;
    this.x           = cfg.spawnX;
    this.y           = cfg.spawnY;
    this._zoneBounds = cfg.zoneBounds;

    this._dmgMin     = Math.ceil(cfg.template.meleeDmgMin * dmgMult);
    this._dmgMax     = Math.ceil(cfg.template.meleeDmgMax * dmgMult);

    this._walkSpeed  = WALK_SPEED[cfg.template.archetype] * spdMult;
    this._aggroRange = AGGRO_RANGE[cfg.template.archetype] * aggroMult;
    this._leashRange = this._aggroRange * LEASH_MULT;
    // attackSpeed in CombatState is attacks-per-turn — map to ms cooldown (1000ms base / rate)
    this._attackRate = Math.max(400, Math.round(1000 / Math.max(0.5, cfg.template.attackSpeed)));

    // Initial patrol target = spawn position
    this._patrolX = cfg.spawnX;
    this._patrolY = cfg.spawnY;

    // ── Visuals ───────────────────────────────────────────────────────────
    const tint = ELEMENT_TINT[cfg.template.element] ?? 0xffffff;
    const size = this._sizeForArchetype();

    this._rect = scene.add.rectangle(cfg.spawnX, cfg.spawnY, size, size, tint, 0.85)
      .setDepth(cfg.spawnY)
      .setStrokeStyle(1, 0x000000, 0.5);

    // HP bar — 2px tall, sits above the rectangle
    const barW = size + 4;
    const barY = cfg.spawnY - size / 2 - 5;
    this._hpBar  = scene.add.rectangle(cfg.spawnX, barY, barW, 2, 0x000000, 0.7).setDepth(cfg.spawnY + 0.1);
    this._hpFill = scene.add.rectangle(cfg.spawnX - barW / 2, barY, barW, 2, 0x22cc44, 1)
      .setOrigin(0, 0.5)
      .setDepth(cfg.spawnY + 0.2);
  }

  // ── Main update — called by WorldCombatManager each frame ─────────────────

  /**
   * Returns damage dealt to player this frame (0 if none).
   * playerX/Y are world-px position of the player sprite.
   */
  update(delta: number, playerX: number, playerY: number): number {
    if (this.aiState === 'dead') return 0;

    this._dx = playerX - this.x;
    this._dy = playerY - this.y;
    const distSq = this._dx * this._dx + this._dy * this._dy;
    const dist   = Math.sqrt(distSq);

    let damageToPlayer = 0;

    switch (this.aiState) {
      case 'patrol':
        this._stepPatrol(delta);
        if (dist < this._aggroRange) {
          this.aiState = 'aggro';
        }
        break;

      case 'aggro':
        this._stepToward(playerX, playerY, this._walkSpeed * AGGRO_SPEED_MULT, delta);
        if (dist < ATTACK_RANGE_PX) {
          this.aiState        = 'attacking';
          this._attackCooldown = 0;
        } else if (dist > this._leashRange) {
          this.aiState = 'patrol';
          this._pickNewPatrolTarget();
        }
        break;

      case 'attacking':
        this._attackCooldown -= delta;
        if (this._attackCooldown <= 0) {
          damageToPlayer       = this._rollAttackDamage();
          this._attackCooldown = this._attackRate;
        }
        // Chase if player steps out of contact
        if (dist > ATTACK_RANGE_PX * 1.2) {
          this.aiState = 'aggro';
        }
        break;

      case 'hit':
        this._staggerTimer -= delta;
        if (this._staggerTimer <= 0) {
          this.aiState = 'aggro';
        }
        break;
    }

    this._syncVisuals();
    return damageToPlayer;
  }

  /** Called by WorldCombatManager when a player attack lands on this enemy. */
  receiveHit(damage: number): void {
    if (this.aiState === 'dead') return;
    this.hp -= damage;
    if (this.hp <= 0) {
      this.hp      = 0;
      this.aiState = 'dead';
      this._rect.setVisible(false);
      this._hpBar.setVisible(false);
      this._hpFill.setVisible(false);
    } else {
      this.aiState       = 'hit';
      this._staggerTimer = STAGGER_MS;
    }
  }

  /** Permanently remove from scene. Call before discarding the instance. */
  destroy(): void {
    this._rect.destroy();
    this._hpBar.destroy();
    this._hpFill.destroy();
  }

  /**
   * Push the enemy by (dx, dy) world-px. Clamps to zone bounds.
   * Used by roll-push and enemy separation passes. No-ops if dead.
   */
  nudge(dx: number, dy: number): void {
    if (this.aiState === 'dead') return;
    const b = this._zoneBounds;
    this.x = Math.max(b.minX, Math.min(b.maxX, this.x + dx));
    this.y = Math.max(b.minY, Math.min(b.maxY, this.y + dy));
    this._syncVisuals();
  }

  get isDead(): boolean { return this.aiState === 'dead'; }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _stepPatrol(delta: number): void {
    const dx   = this._patrolX - this.x;
    const dy   = this._patrolY - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 4) {
      this._pickNewPatrolTarget();
      return;
    }
    const speed = this._walkSpeed * delta;
    this.x += (dx / dist) * speed;
    this.y += (dy / dist) * speed;
  }

  private _stepToward(tx: number, ty: number, speed: number, delta: number): void {
    const dx   = tx - this.x;
    const dy   = ty - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return;
    const step = speed * delta;
    this.x += (dx / dist) * step;
    this.y += (dy / dist) * step;
  }

  private _pickNewPatrolTarget(): void {
    const b    = this._zoneBounds;
    const span = 48; // max patrol wander radius in px
    this._patrolX = Math.max(b.minX, Math.min(b.maxX, this.x + (Math.random() - 0.5) * span * 2));
    this._patrolY = Math.max(b.minY, Math.min(b.maxY, this.y + (Math.random() - 0.5) * span * 2));
  }

  private _rollAttackDamage(): number {
    const base = this._dmgMin + Math.floor(Math.random() * (this._dmgMax - this._dmgMin + 1));
    return Math.max(1, base);
  }

  private _syncVisuals(): void {
    this._rect.setPosition(this.x, this.y);
    this._rect.setDepth(this.y);

    const size = this._sizeForArchetype();
    const barW = size + 4;
    const barY = this.y - size / 2 - 5;
    this._hpBar.setPosition(this.x, barY).setDepth(this.y + 0.1);
    this._hpFill.setPosition(this.x - barW / 2, barY).setDepth(this.y + 0.2);

    // Mutate width — no new object
    const fillW = Math.max(0, (this.hp / this.maxHp) * barW);
    this._hpFill.width = fillW;

    // HP bar color: green → yellow → red
    const ratio = this.hp / this.maxHp;
    this._hpFill.fillColor = ratio > 0.5 ? 0x22cc44 : ratio > 0.25 ? 0xeeaa11 : 0xee2222;
  }

  private _sizeForArchetype(): number {
    switch (this.template.archetype) {
      case 'minion':  return 10;
      case 'warrior': return 14;
      case 'leader':  return 13;
      case 'boss':    return 20;
      default:        return 10;
    }
  }
}
