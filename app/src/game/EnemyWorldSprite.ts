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
import { TileWorld } from './TileWorld';
import { findPath, greedyStep } from './TileNavigation';
import { type BehaviourProfile, BEHAVIOUR_PROFILES, ARCHETYPE_INITIAL_PROFILE } from './BehaviourProfiles';
import { ExplorationZoneManager } from './ExplorationZoneManager';

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

const LEASH_MULT        = 1.5;   // lose aggro at aggroRange × leash
const ATTACK_RANGE_PX   = 44;    // px — melee contact
const STAGGER_MS        = 200;
const STUCK_MS          = 800;   // ms without tile change before replan + wander
const WAYPOINT_REACH_PX = 6;     // px — snap to waypoint when within this distance
// Zone tiles at negative ty have negative world-Y (e.g. ty=-20 → y≈-16px).
// setDepth(this.y) would put enemies behind floor tiles (depth 1).
// DEPTH_BASE ensures depth is always positive and above floor/structure tiles.
const DEPTH_BASE        = 400;   // covers zones up to ~50 tiles deep

// ── Types ─────────────────────────────────────────────────────────────────────

export type EnemyAIState = 'patrol' | 'aggro' | 'attacking' | 'hit' | 'dead';

export interface EnemySpawnOverrides {
  /** Multiplier on maxHp.     Applied at construction; hot path reads instance field. */
  hpMult:          number;
  /** Multiplier on meleeDmgMin/Max. Applied at construction; hot path reads instance fields. */
  damageMult:      number;
  /** Multiplier on walk/aggro speed. Applied at construction. */
  speedMult:       number;
  /** Multiplier on aggro detection range. Applied at construction. */
  aggroRangeMult:  number;
  /** Optional starting behaviour profile id. Defaults to archetype default if omitted. */
  initialProfile?: string;
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
  private _patrolTx: number = 0;   // patrol target in tile coords
  private _patrolTy: number = 0;
  private _patrolWaypoints:    Array<{ tx: number; ty: number }> = [];
  private _patrolWaypointIdx:  number = 0;
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
  private _attackRate:  number;   // ms between attacks (derived from attackSpeed)

  // Phaser visual
  private _rect:    Phaser.GameObjects.Rectangle;
  private _hpBar:   Phaser.GameObjects.Rectangle;
  private _hpFill:  Phaser.GameObjects.Rectangle;

  // Scratch — reused each update, no allocation
  private _dx = 0;
  private _dy = 0;

  // ── Tile navigator fields ─────────────────────────────────────────────────
  // _waypoints: current A* path as tile coords. Copied from findPath output at
  //   replan time — findPath returns a module-level buffer, so copy is required.
  // _waypointIdx: index of the next waypoint to walk toward.
  // _stuckTimer: ms since enemy tile last changed. Replan + wander if > STUCK_MS.
  // _lastTx/_lastTy: tile coords at last update — used to detect tile change.
  // _lastKnownPlayerTx/Ty: player tile at last replan — replan when it changes.
  // _lastWalkableX/Y: last confirmed walkable world position — revert target on
  //   illegal move (tile clamp).
  private _waypoints:           Array<{ tx: number; ty: number }> = [];
  private _waypointIdx:         number = 0;
  private _stuckTimer:          number = 0;
  private _lastTx:              number = 0;
  private _lastTy:              number = 0;
  private _lastKnownPlayerTx:   number = 0;
  private _lastKnownPlayerTy:   number = 0;
  private _lastWalkableX:       number = 0;
  private _lastWalkableY:       number = 0;

  // ── Phase FSM fields ──────────────────────────────────────────────────────
  // _currentProfile: active BehaviourProfile governing multipliers this phase.
  // _phaseTimer: countdown ms until next profile roll. Mutated each frame.
  // _currentSpeed/AttackRate/AggroRange: base × profileMult — live values read
  //   by the update loop. Recomputed only on phase transition, not per frame.
  // _phaseLcg: per-enemy deterministic LCG state. Seeded from spawn position
  //   XOR pool index so enemies in the same room desync naturally.
  private _currentProfile:      BehaviourProfile;
  private _phaseTimer:          number = 0;
  private _currentSpeed:        number = 0;
  private _currentAttackRate:   number = 0;
  private _currentAggroRange:   number = 0;
  private _phaseLcg:            number = 0;

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
    // attackSpeed in CombatState is attacks-per-turn — map to ms cooldown (1000ms base / rate)
    this._attackRate = Math.max(400, Math.round(1000 / Math.max(0.5, cfg.template.attackSpeed)));

    // Initial patrol target = spawn position
    this._patrolX = cfg.spawnX;
    this._patrolY = cfg.spawnY;

    // Seed navigator — last walkable position is the spawn tile
    const tw = TileWorld.getInstance();
    const spawnTile      = tw.worldToTile(cfg.spawnX, cfg.spawnY);
    this._lastTx         = spawnTile.tx;
    this._lastTy         = spawnTile.ty;
    this._lastWalkableX  = cfg.spawnX;
    this._lastWalkableY  = cfg.spawnY;
    this._patrolTx       = spawnTile.tx;
    this._patrolTy       = spawnTile.ty;

    // Seed phase FSM — LCG seeded from spawn coords for per-enemy desync
    this._phaseLcg = ((cfg.spawnX * 73856093) ^ (cfg.spawnY * 19349663)) >>> 0;

    const initialProfileId = cfg.overrides?.initialProfile
      ?? ARCHETYPE_INITIAL_PROFILE[cfg.template.archetype]
      ?? 'alert';
    this._currentProfile = BEHAVIOUR_PROFILES[initialProfileId] ?? BEHAVIOUR_PROFILES['alert'];
    this._applyProfile(this._currentProfile);
    // Stagger phase timer using LCG so enemies don't all transition simultaneously
    this._phaseTimer = this._currentProfile.phaseDurationMs + this._lcgJitter();

    // ── Visuals ───────────────────────────────────────────────────────────
    const tint = ELEMENT_TINT[cfg.template.element] ?? 0xffffff;
    const size = this._sizeForArchetype();

    this._rect = scene.add.rectangle(cfg.spawnX, cfg.spawnY, size, size, tint, 0.85)
      .setDepth(cfg.spawnY + DEPTH_BASE)
      .setStrokeStyle(1, 0x000000, 0.5);

    // HP bar — 2px tall, sits above the rectangle
    const barW = size + 4;
    const barY = cfg.spawnY - size / 2 - 5;
    this._hpBar  = scene.add.rectangle(cfg.spawnX, barY, barW, 2, 0x000000, 0.7).setDepth(cfg.spawnY + DEPTH_BASE + 0.1);
    this._hpFill = scene.add.rectangle(cfg.spawnX - barW / 2, barY, barW, 2, 0x22cc44, 1)
      .setOrigin(0, 0.5)
      .setDepth(cfg.spawnY + DEPTH_BASE + 0.2);
  }

  // ── Main update — called by WorldCombatManager each frame ─────────────────

  /**
   * Returns damage dealt to player this frame (0 if none).
   * playerX/Y are world-px position of the player sprite.
   * playerTx/Ty are the player's current tile coords — computed once by
   * WorldCombatManager and passed in to avoid redundant worldToTile calls.
   */
  update(delta: number, playerX: number, playerY: number, playerTx: number, playerTy: number): number {
    if (this.aiState === 'dead') return 0;

    this._dx = playerX - this.x;
    this._dy = playerY - this.y;
    const distSq = this._dx * this._dx + this._dy * this._dy;
    const dist   = Math.sqrt(distSq);

    let damageToPlayer = 0;

    // Tick phase FSM every frame — cheap countdown, transition only on expiry
    this._tickPhase(delta);

    switch (this.aiState) {
      case 'patrol':
        this._stepPatrol(delta);
        if (dist < this._currentAggroRange) {
          this.aiState = 'aggro';
          this._waypoints.length = 0;       // clear aggro path
          this._patrolWaypoints.length = 0; // clear patrol path
        }
        break;

      case 'aggro':
        this._maybeReplan(playerTx, playerTy, delta);
        this._stepWaypoint(delta);
        if (dist < ATTACK_RANGE_PX) {
          this.aiState         = 'attacking';
          this._attackCooldown = 0;
        } else if (dist > this._currentAggroRange * LEASH_MULT) {
          this.aiState = 'patrol';
          this._waypoints.length = 0;       // clear aggro path
          this._patrolWaypoints.length = 0; // force patrol replan toward a new target
          this._pickNewPatrolTarget();
        }
        break;

      case 'attacking':
        this._attackCooldown -= delta;
        if (this._attackCooldown <= 0) {
          damageToPlayer       = this._rollAttackDamage();
          this._attackCooldown = this._currentAttackRate;
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

    // Tile clamp — final wall-escape safety net regardless of which state moved.
    // isWalkable takes world-px. On success, advance _lastWalkable; on failure,
    // revert position. The hit state doesn't move so skip it.
    if (this.aiState !== 'hit') {
      const tw = TileWorld.getInstance();
      if (tw.isWalkable(this.x, this.y)) {
        this._lastWalkableX = this.x;
        this._lastWalkableY = this.y;
      } else {
        this.x = this._lastWalkableX;
        this.y = this._lastWalkableY;
      }
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

  /**
   * Separation radius multiplier derived from current behaviour profile.
   * aggressive/berserk — tighter clustering (0.7×): enemies swarm together.
   * wary              — wider spread (1.4×): enemies encircle and pressure.
   * Others            — baseline (1.0×).
   * Read by WorldCombatManager separation pass each frame.
   */
  get separationMult(): number {
    switch (this._currentProfile.id) {
      case 'aggressive': return 0.75;
      case 'berserk':    return 0.60;
      case 'wary':       return 1.40;
      default:           return 1.00;
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _stepToward(tx: number, ty: number, speed: number, delta: number): void {
    const dx   = tx - this.x;
    const dy   = ty - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1) return;
    const step = speed * delta;
    this.x += (dx / dist) * step;
    this.y += (dy / dist) * step;
  }

  /**
   * Move toward the current waypoint at aggro speed.
   * Advances _waypointIdx when within WAYPOINT_REACH_PX of the waypoint centre.
   * No-ops if the waypoint list is empty.
   */
  private _stepWaypoint(delta: number): void {
    if (this._waypoints.length === 0) return;
    const wp = this._waypoints[this._waypointIdx];
    if (!wp) return;

    const tw = TileWorld.getInstance();
    const { x: wpX, y: wpY } = tw.tileToWorld(wp.tx, wp.ty);

    const dx   = wpX - this.x;
    const dy   = wpY - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = this._currentSpeed * AGGRO_SPEED_MULT * delta;

    if (dist <= step + WAYPOINT_REACH_PX) {
      // Snap to waypoint centre and advance
      this.x = wpX;
      this.y = wpY;
      if (this._waypointIdx < this._waypoints.length - 1) {
        this._waypointIdx++;
      }
    } else {
      this.x += (dx / dist) * step;
      this.y += (dy / dist) * step;
    }
  }

  /**
   * Decide whether to replan the A* path toward the player.
   * Replans when:
   *   - player moved to a new tile
   *   - enemy reached a new tile (path consumed)
   *   - stuck timer exceeded STUCK_MS (enemy hasn't changed tile in a while)
   *   - waypoint list is empty (first aggro frame)
   * Falls back to greedy lookahead if A* returns null (player unreachable).
   * On stuck: wanders to a random adjacent walkable tile before resuming chase.
   */
  private _maybeReplan(playerTx: number, playerTy: number, delta: number): void {
    const tw = TileWorld.getInstance();
    const { tx, ty } = tw.worldToTile(this.x, this.y);

    const tileChanged   = tx !== this._lastTx || ty !== this._lastTy;
    const playerMoved   = playerTx !== this._lastKnownPlayerTx || playerTy !== this._lastKnownPlayerTy;
    const noPath        = this._waypoints.length === 0;

    // Advance stuck timer — reset if we changed tile
    if (tileChanged) {
      this._stuckTimer = 0;
    } else {
      this._stuckTimer += delta;
    }

    const stuck = this._stuckTimer > STUCK_MS;

    if (!playerMoved && !tileChanged && !noPath && !stuck) {
      this._lastTx = tx;
      this._lastTy = ty;
      return; // nothing changed — keep current path
    }

    if (stuck) {
      // Wander to a random adjacent walkable tile to escape local minimum
      const dirs = [[-1,0],[1,0],[0,-1],[0,1]] as const;
      for (const [dtx, dty] of dirs) {
        if (tw.isWalkableTile(tx + dtx, ty + dty)) {
          const wander = tw.tileToWorld(tx + dtx, ty + dty);
          this._waypoints    = [{ tx: tx + dtx, ty: ty + dty }];
          this._waypointIdx  = 0;
          // After wander target is set, step toward it next frame — reset stuck
          this._stuckTimer   = 0;
          this._lastWalkableX = wander.x;
          this._lastWalkableY = wander.y;
          break;
        }
      }
      this._lastTx = tx;
      this._lastTy = ty;
      return;
    }

    // Run A* toward the player tile
    const path = findPath(tx, ty, playerTx, playerTy, tw);

    if (path && path.length > 1) {
      // Copy — findPath returns a reference to a module-level buffer
      this._waypoints.length = 0;
      for (let i = 0; i < path.length; i++) this._waypoints.push(path[i]);
      this._waypointIdx = 1; // index 0 is current tile — start at next
    } else {
      // A* failed (unreachable or blocked) — greedy single-step fallback
      const step = greedyStep(tx, ty, playerTx, playerTy, tw);
      if (step) {
        this._waypoints    = [step];
        this._waypointIdx  = 0;
      }
      // If greedy also fails (fully blocked) — hold position, path stays empty
    }

    this._lastKnownPlayerTx = playerTx;
    this._lastKnownPlayerTy = playerTy;
    this._lastTx = tx;
    this._lastTy = ty;
  }

  private _stepPatrol(delta: number): void {
    // If no patrol waypoints, try to plan a path to the current patrol target.
    if (this._patrolWaypoints.length === 0) {
      const tw = TileWorld.getInstance();
      const { tx, ty } = tw.worldToTile(this.x, this.y);
      const path = findPath(tx, ty, this._patrolTx, this._patrolTy, tw);
      if (path && path.length > 1) {
        this._patrolWaypoints.length = 0;
        for (let i = 0; i < path.length; i++) this._patrolWaypoints.push(path[i]);
        this._patrolWaypointIdx = 1; // 0 is current tile
      } else {
        // A* failed (target unreachable) — pick a new target immediately
        this._pickNewPatrolTarget();
        return;
      }
    }

    const wp = this._patrolWaypoints[this._patrolWaypointIdx];
    if (!wp) {
      // Reached end of path — pick next patrol target
      this._patrolWaypoints.length = 0;
      this._pickNewPatrolTarget();
      return;
    }

    const tw = TileWorld.getInstance();
    const { x: wpX, y: wpY } = tw.tileToWorld(wp.tx, wp.ty);
    const dx   = wpX - this.x;
    const dy   = wpY - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const step = this._currentSpeed * delta;

    if (dist <= step + WAYPOINT_REACH_PX) {
      this.x = wpX;
      this.y = wpY;
      if (this._patrolWaypointIdx < this._patrolWaypoints.length - 1) {
        this._patrolWaypointIdx++;
      } else {
        // Finished this path — pick next patrol target
        this._patrolWaypoints.length = 0;
        this._pickNewPatrolTarget();
      }
    } else {
      this.x += (dx / dist) * step;
      this.y += (dy / dist) * step;
    }
  }

  /**
   * Pick a new patrol target tile sampled from the live zone tile set.
   * Falls back to a nearby world-space offset if no zone tiles are registered
   * (e.g. before the zone has fully loaded).
   */
  private _pickNewPatrolTarget(): void {
    const tiles = ExplorationZoneManager.getInstance().getZoneTiles();
    if (tiles.length > 0) {
      // Use LCG for deterministic patrol target selection
      const idx = this._lcgNext() % tiles.length;
      const t   = tiles[idx];
      this._patrolTx = t.tx;
      this._patrolTy = t.ty;
      // _patrolX/Y kept in sync for any legacy reads
      const tw = TileWorld.getInstance();
      const { x, y } = tw.tileToWorld(t.tx, t.ty);
      this._patrolX = x;
      this._patrolY = y;
    } else {
      // Fallback: wander nearby using bounding box (pre-zone-load only)
      const b    = this._zoneBounds;
      const span = 48;
      this._patrolX = Math.max(b.minX, Math.min(b.maxX, this.x + (Math.random() - 0.5) * span * 2));
      this._patrolY = Math.max(b.minY, Math.min(b.maxY, this.y + (Math.random() - 0.5) * span * 2));
      const tw = TileWorld.getInstance();
      const t  = tw.worldToTile(this._patrolX, this._patrolY);
      this._patrolTx = t.tx;
      this._patrolTy = t.ty;
    }
    // Clear stale patrol path — will be replanned in _stepPatrol
    this._patrolWaypoints.length = 0;
  }

  // ── Phase FSM ─────────────────────────────────────────────────────────────

  /**
   * Decrement phase timer. On expiry: roll next profile using the weighted
   * transition table and the per-enemy LCG, apply multipliers, fire visual cue.
   * Called every frame — only the countdown costs anything; transition is rare.
   */
  private _tickPhase(delta: number): void {
    this._phaseTimer -= delta;
    if (this._phaseTimer > 0) return;

    // Roll next profile from weighted transition table using per-enemy LCG
    const transitions = this._currentProfile.nextProfiles;
    let totalWeight = 0;
    for (let i = 0; i < transitions.length; i++) totalWeight += transitions[i].weight;

    const roll = (this._lcgNext() / 0xffffffff) * totalWeight;
    let accumulated = 0;
    let nextId = transitions[transitions.length - 1].id; // default to last
    for (let i = 0; i < transitions.length; i++) {
      accumulated += transitions[i].weight;
      if (roll < accumulated) { nextId = transitions[i].id; break; }
    }

    const nextProfile = BEHAVIOUR_PROFILES[nextId] ?? BEHAVIOUR_PROFILES['alert'];
    this._currentProfile = nextProfile;
    this._applyProfile(nextProfile);
    this._fireVisualCue(nextProfile.visualCue);

    // Reset timer with ±500ms jitter to prevent room-wide synchronisation
    this._phaseTimer = nextProfile.phaseDurationMs + this._lcgJitter();
  }

  /** Apply profile multipliers to the three live values. No allocation. */
  private _applyProfile(p: BehaviourProfile): void {
    this._currentSpeed       = this._walkSpeed      * p.moveSpeedMult;
    this._currentAttackRate  = this._attackRate     * p.attackRateMult;
    this._currentAggroRange  = this._aggroRange     * p.aggroRangeMult;
  }

  /** LCG step — returns next 32-bit unsigned integer. Mutates _phaseLcg. */
  private _lcgNext(): number {
    // Numerical Recipes LCG: fast, sufficient entropy for phase rolls.
    this._phaseLcg = (Math.imul(this._phaseLcg, 1664525) + 1013904223) >>> 0;
    return this._phaseLcg;
  }

  /** Return a jitter value in range [-500, +500] ms using the LCG. */
  private _lcgJitter(): number {
    return ((this._lcgNext() / 0xffffffff) - 0.5) * 1000;
  }

  /**
   * Fire a brief visual cue on the enemy rect to signal a phase transition.
   * All tweens mutate existing properties — no new Phaser objects created.
   * 'none' is a no-op.
   */
  private _fireVisualCue(cue: BehaviourProfile['visualCue']): void {
    if (cue === 'none') return;
    const scene = this._rect.scene;
    if (!scene?.tweens) return;

    switch (cue) {
      case 'pulse':
        // Alpha flicker: 1 → 0.25 → 1 over 220ms — warns player of speed surge
        scene.tweens.add({
          targets: this._rect,
          alpha: { from: 1, to: 0.25 },
          duration: 110,
          yoyo: true,
          ease: 'Sine.easeInOut',
        });
        break;

      case 'flash':
        // Tint to white for 120ms then restore — signals berserk activation
        this._rect.setFillStyle(0xffffff, 1);
        scene.time.delayedCall(120, () => {
          if (!this.isDead) {
            this._rect.setFillStyle(ELEMENT_TINT[this.template.element] ?? 0xffffff, 0.85);
          }
        });
        break;

      case 'grow':
        // Brief scale surge: 1.0 → 1.35 → 1.0 over 180ms — signals wary backing-off
        scene.tweens.add({
          targets: this._rect,
          scaleX: { from: 1, to: 1.35 },
          scaleY: { from: 1, to: 1.35 },
          duration: 90,
          yoyo: true,
          ease: 'Back.easeOut',
        });
        break;
    }
  }

  private _rollAttackDamage(): number {
    const base = this._dmgMin + Math.floor(Math.random() * (this._dmgMax - this._dmgMin + 1));
    return Math.max(1, base);
  }

  private _syncVisuals(): void {
    this._rect.setPosition(this.x, this.y);
    this._rect.setDepth(this.y + DEPTH_BASE);

    const size = this._sizeForArchetype();
    const barW = size + 4;
    const barY = this.y - size / 2 - 5;
    this._hpBar.setPosition(this.x, barY).setDepth(this.y + DEPTH_BASE + 0.1);
    this._hpFill.setPosition(this.x - barW / 2, barY).setDepth(this.y + DEPTH_BASE + 0.2);

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