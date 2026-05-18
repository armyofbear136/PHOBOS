/**
 * PlayerCombatController — World-mode combat input and state machine.
 *
 * Handles all player combat in the hub world (NOT the turn-based Battle Hall —
 * that's CombatState + BattleOverlay). This is the real-time layer.
 *
 * ── INPUT RULES ─────────────────────────────────────────────────────────────
 *
 * Weapon modes:
 *   Q           — switch to MELEE mode
 *   E           — switch to RANGED mode
 *
 * Combat readiness (RMB hold):
 *   Hold RMB    — enter READY stance: move speed ×0.40
 *   LMB click   — execute attack (melee swing or ranged shot)
 *   LMB hold    — charge attack: starts charging after 250ms hold
 *                 while charging: move speed ×0.10 (total ×0.04 of base if readying + charging)
 *
 * Attack direction:
 *   Always tracks mouse world position. The angle to mouse determines
 *   which animation row plays (S, SE, E, NE, N and flipped mirrors).
 *
 * Restrictions:
 *   - While attacking (swing/shot executing): movement disabled, inputs ignored
 *   - While ability executing: movement disabled
 *   - While rolling: movement passed to PlayerSprite but attack inputs ignored
 *   - In midair: movement disabled, attack inputs accepted
 *   - Can't roll or jump while: attacking, taking damage, using ability
 *
 * Roll (Shift):
 *   Requires FREE movement state. Triggers roll animation on PlayerSprite.
 *   Movement locked for roll duration (350ms). Brief invincibility window.
 *
 * Jump (Space):
 *   Requires FREE movement state. Parabolic arc, 500ms airtime.
 *   Attack inputs accepted in midair. No movement control in midair.
 *
 * Abilities (1 / 2 / 3):
 *   Execute immediately. Lock movement for abilityLockMs.
 *   Spirit cost deducted. Cooldown starts from CLASS_DEFINITIONS.
 *   Cooldown reduced by cooldownReduction from derivedStats.
 *
 * ── STAT INTEGRATION ────────────────────────────────────────────────────────
 *
 * derivedStats() provides: meleeDmgMin/Max, rangedDmgMin/Max, moveSpeed,
 * abilityDmgMultiplier, attackSpeed, cooldownReduction.
 *
 * Attack damage rolls within [dmgMin, dmgMax], ×1.5 on crit (8% chance base).
 *
 * ── OUTPUT ──────────────────────────────────────────────────────────────────
 *
 * Hit events emitted via onHit callback. WorldScene subscribes and passes to
 * TrainingDummy.takeDamage() or enemy systems.
 */

import * as Phaser from 'phaser';
import { KeybindManager } from './KeybindManager';
import type { PlayerSprite } from './PlayerSprite';
import type { PlayerBuild, ElementType } from './PlayerClasses';
import { derivedStats, CLASS_DEFINITIONS } from './PlayerClasses';
import { localToWorld, coordSystemReady } from './CoordSystem';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CombatMode = 'melee' | 'ranged';

export type MovementState =
  | 'free'        // normal movement
  | 'ready'       // Alt held — slowed, aim locked
  | 'charging'    // LMB held past threshold — further slowed, charge building
  | 'attacking'   // swing/shot executing — no movement
  | 'rolling'     // roll animation — locked direction dash
  | 'airborne'    // jump arc — no directional input
  | 'ability'     // ability executing — locked
  | 'blocking'    // RMB held — guard stance, damage reduced
  | 'parrying'    // parry window active — brief counter-attack window
  | 'hit';        // receiving damage — brief lock

export interface HitEvent {
  damage:        number;
  isCrit:        boolean;
  element:       ElementType;
  type:          'melee' | 'ranged' | 'ability';
  abilityIndex?: number;
  /** Player world position at the moment of the attack. */
  originX:       number;
  originY:       number;
  /** Aim direction in radians at the moment of the attack. */
  aimAngle:      number;
  /** Aim-projected contact point (legacy — kept for TrainingDummy compat). */
  worldX:        number;
  worldY:        number;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const CHARGE_THRESHOLD_MS  = 250;   // hold LMB this long to start charging
const CHARGE_MAX_MS        = 1500;  // full charge at this duration
const ATTACK_LOCK_MS       = 350;   // movement locked during melee swing
const RANGED_BASE_MS       = 1000 / 6;  // 166.667 ms — 6 shots/sec base fire rate
const ABILITY_LOCK_MS      = 600;   // movement locked during ability
const ROLL_DURATION_MS     = 350;
const HIT_STAGGER_MS       = 200;
const PARRY_WINDOW_MS      = 200;   // first 200ms of RMB hold is the parry window
const BLOCK_DMG_REDUCTION  = 0.70;  // 70% damage absorbed while blocking
const PARRY_LOCK_MS        = 400;   // counter-attack lock duration after a parry

const READY_SPEED_MULT     = 0.40;  // move speed during Alt hold
const CHARGE_SPEED_MULT    = 0.10;  // move speed while charging
const ROLL_SPEED_MULT      = 2.20;  // move speed during roll
const BLOCK_SPEED_MULT     = 0.25;  // move speed while blocking

const BASE_CRIT_CHANCE     = 0.08;
const CHARGED_CRIT_BONUS   = 0.25;  // extra crit chance at full charge
const CHARGED_DMG_MULT_MAX = 2.0;   // max damage multiplier at full charge

const INTERACT_RANGE       = 48;    // pixels

// ── Controller ────────────────────────────────────────────────────────────────

export class PlayerCombatController {
  // Injected
  private _scene:    Phaser.Scene;
  private _player:   PlayerSprite;
  private _build:    PlayerBuild;
  private _kb:       KeybindManager;

  // State
  combatMode: CombatMode   = 'melee';
  moveState: MovementState = 'free';
  combatEnabled            = false;  // set true by WorldScene when player is in exploration zone

  // Timers
  private _attackTimer        = 0;
  private _rangedCooldown     = 0;   // ms until next ranged shot allowed
  private _chargeTimer        = 0;
  private _rollTimer          = 0;
  private _jumpTimer          = 0;
  private _abilityTimer       = 0;
  private _hitTimer           = 0;
  private _parryTimer         = 0;   // counts up from RMB press; parry window while < PARRY_WINDOW_MS
  private _parryLockTimer     = 0;   // ms remaining in post-parry counter lock
  private _lmbHeld            = false;
  private _lmbWasDown         = false;
  private _rmbHeld            = false;
  private _rmbWasDown         = false; // for parry window edge detection
  private _charged            = false;
  // Roll direction — locked at roll start, ignored during roll
  private _rollDirX           = 0;
  private _rollDirY           = 0;
  // Durability flush debounce
  private _durabilityDirty:        'melee' | 'ranged' | null = null;
  private _durabilityFlushTimer    = 0;

  // Optional combat manager reference — used for roll push
  combat: import('./WorldCombatManager').WorldCombatManager | null = null;

  // Jump arc
  private _jumpVelocityY = 0;
  private _jumpOffsetY   = 0;   // accumulated visual Y lift — negative = airborne

  // Ability cooldowns (seconds remaining, real-time)
  abilityCooldowns: [number, number, number] = [0, 0, 0];
  spiritCurrent  = 0;
  spiritMax      = 0;
  hpCurrent      = 0;
  hpMax          = 0;

  // ── Temporary power-up buffs ─────────────────────────────────────────────
  // Each buff is a flat multiplier applied on top of normal stat computation.
  // remainingMs counts down in update(); when it hits 0 the mult resets to 1.
  private _damageBuff  = { mult: 1.0, remainingMs: 0 };
  private _resistBuff  = { mult: 1.0, remainingMs: 0 };

  /** Active buff state — read by HUD / UI to display remaining duration. */
  get damageBuff():  { mult: number; remainingMs: number } { return this._damageBuff;  }
  get resistBuff():  { mult: number; remainingMs: number } { return this._resistBuff;  }

  // Mouse aim
  private _aimAngle = 0; // radians, from player to mouse

  // Callbacks
  onHit:          ((e: HitEvent) => void)          | null = null;
  onInteract:     ((x: number, y: number) => void) | null = null;
  onModeChange:   ((mode: CombatMode) => void)     | null = null;
  onSpiritChange: ((current: number, max: number) => void) | null = null;
  onDeath:        (() => void)                     | null = null;
  onWeaponBreak:  ((slot: 'melee' | 'ranged') => void) | null = null;

  /**
   * Apply a temporary power-up buff to the player.
   * Stacks durationMs if the same buff is already active (adds time, keeps current mult).
   * type: 'damage' — outgoing damage multiplier
   *       'resist' — incoming damage reduction (mult applied to damage received)
   */
  applyPowerUp(type: 'damage' | 'resist', mult: number, durationMs: number): void {
    if (type === 'damage') {
      this._damageBuff.mult        = mult;
      this._damageBuff.remainingMs = Math.max(this._damageBuff.remainingMs, 0) + durationMs;
    } else {
      this._resistBuff.mult        = mult;
      this._resistBuff.remainingMs = Math.max(this._resistBuff.remainingMs, 0) + durationMs;
    }
  }

  constructor(scene: Phaser.Scene, player: PlayerSprite, build: PlayerBuild) {
    this._scene  = scene;
    this._player = player;
    this._build  = build;
    this._kb     = KeybindManager.getInstance();

    const d = derivedStats(build);
    this.spiritCurrent = d.maxSpirit;
    this.spiritMax     = d.maxSpirit;
    this.hpMax         = d.maxHp;
    this.hpCurrent     = d.maxHp;

    this._setupMouseListeners();
  }

  updateBuild(build: PlayerBuild): void {
    this._build = build;
    const d = derivedStats(build);
    this.spiritMax     = d.maxSpirit;
    this.spiritCurrent = Math.min(this.spiritCurrent, this.spiritMax);
    this.hpMax         = d.maxHp;
    this.hpCurrent     = Math.min(this.hpCurrent, this.hpMax);
  }

  // ── Main update — called from WorldScene.update() ─────────────────────────

  update(delta: number): void {
    const dt = delta / 1000; // seconds

    // Update aim angle from mouse world position via CoordSystem.
    // pointer.x/y are canvas-local CSS px (Phaser subtracts the canvas offset
    // internally) — localToWorld applies scroll and zoom correctly.
    if (coordSystemReady()) {
      const pointer  = this._scene.input.activePointer;
      const cursor   = localToWorld(pointer.x, pointer.y);
      this._aimAngle = Math.atan2(
        cursor.y - this._player.y,
        cursor.x - this._player.x,
      );
    }

    // Tick ability cooldowns
    for (let i = 0; i < 3; i++) {
      if (this.abilityCooldowns[i] > 0) {
        this.abilityCooldowns[i] = Math.max(0, this.abilityCooldowns[i] - dt);
      }
    }

    // Tick power-up buff timers
    if (this._damageBuff.remainingMs > 0) {
      this._damageBuff.remainingMs -= delta;
      if (this._damageBuff.remainingMs <= 0) {
        this._damageBuff.remainingMs = 0;
        this._damageBuff.mult        = 1.0;
      }
    }
    if (this._resistBuff.remainingMs > 0) {
      this._resistBuff.remainingMs -= delta;
      if (this._resistBuff.remainingMs <= 0) {
        this._resistBuff.remainingMs = 0;
        this._resistBuff.mult        = 1.0;
      }
    }

    // Tick ranged fire-rate cooldown (ms)
    if (this._rangedCooldown > 0) {
      this._rangedCooldown = Math.max(0, this._rangedCooldown - delta);
    }

    // Debounced durability flush — POST once 800 ms after last decrement
    if (this._durabilityDirty !== null) {
      this._durabilityFlushTimer -= delta;
      if (this._durabilityFlushTimer <= 0) {
        this._flushDurability(this._durabilityDirty);
        this._durabilityDirty      = null;
        this._durabilityFlushTimer = 0;
      }
    }

    // Sync aim angle and mode to PlayerSprite for weapon indicator
    // Guard with optional chaining — PlayerSprite may not have these methods
    // if the output file hasn't been deployed yet.
    this._player.setAimAngle?.(this._aimAngle);
    this._player.setCombatMode?.(this.combatMode);

    // Spirit regen — slow passive
    if (this.spiritCurrent < this.spiritMax) {
      this.spiritCurrent = Math.min(this.spiritMax, this.spiritCurrent + 2 * dt);
      this.onSpiritChange?.(this.spiritCurrent, this.spiritMax);
    }

    // State-specific tick
    switch (this.moveState) {
      case 'attacking': this._tickAttacking(delta); break;
      case 'rolling':   this._tickRolling(delta);   break;
      case 'airborne':  this._tickAirborne(delta);  break;
      case 'ability':   this._tickAbility(delta);   break;
      case 'hit':       this._tickHit(delta);        break;
      case 'blocking':  this._tickBlocking(delta);   break;
      case 'parrying':  this._tickParrying(delta);   break;
      default:          this._tickFreeOrReady(delta); break;
    }
  }

  /** Return the speed multiplier to apply to PlayerSprite movement. */
  getSpeedMultiplier(): number {
    switch (this.moveState) {
      case 'ready':     return READY_SPEED_MULT;
      case 'charging':  return READY_SPEED_MULT * CHARGE_SPEED_MULT;
      case 'attacking': return 0;
      case 'rolling':   return ROLL_SPEED_MULT;
      case 'airborne':  return 0;
      case 'ability':   return 0;
      case 'hit':       return 0;
      case 'blocking':  return BLOCK_SPEED_MULT;
      case 'parrying':  return 0;
      default:          return 1.0;
    }
  }

  /** Called by WorldScene when player takes damage from a world hit. */
  receiveHit(damage: number): void {
    if (this.moveState === 'rolling') return; // invincibility window

    // Parry window — counter-attack instead of taking damage
    if (this.moveState === 'blocking' && this._parryTimer < PARRY_WINDOW_MS) {
      this.moveState      = 'parrying';
      this._parryLockTimer = PARRY_LOCK_MS;
      this._player.stopBlock?.();
      this._fireAttack(true); // free charged counter-attack
      return;
    }

    // Block — reduce damage
    if (this.moveState === 'blocking') {
      damage = Math.round(damage * (1 - BLOCK_DMG_REDUCTION));
    }
    // Power-up resist buff
    if (this._resistBuff.remainingMs > 0) {
      damage = Math.round(damage * this._resistBuff.mult);
    }

    this.hpCurrent  = Math.max(0, this.hpCurrent - damage);
    this.moveState  = 'hit';
    this._hitTimer  = 0;
    this._lmbHeld   = false;
    this._chargeTimer = 0;
    this._charged   = false;
    this._rmbHeld   = false;
    this._jumpOffsetY   = 0;
    this._jumpVelocityY = 0;
    this._player.setJumpOffset?.(0);
    this._player.stopBlock?.();
    this._player.releaseAction();
    if (this.hpCurrent === 0) {
      this.onDeath?.();
    }
  }

  /** Called by WorldScene when R key is pressed — returns true if consumed */
  tryInteract(nearbyX: number, nearbyY: number): boolean {
    if (this.moveState !== 'free') return false;
    const dx = nearbyX - this._player.x;
    const dy = nearbyY - this._player.y;
    if (Math.sqrt(dx * dx + dy * dy) <= INTERACT_RANGE) {
      this.onInteract?.(nearbyX, nearbyY);
      return true;
    }
    return false;
  }

  get aimAngle(): number { return this._aimAngle; }

  // ── Tick handlers ──────────────────────────────────────────────────────────

  private _tickFreeOrReady(delta: number): void {
    const kb      = this._kb;
    const pointer = this._scene.input.activePointer;

    // ── Mode switches ───────────────────────────────────────────────────────
    if (kb.isJustDown('melee_mode'))  { this.combatMode = 'melee';  this.onModeChange?.('melee'); }
    if (kb.isJustDown('ranged_mode')) { this.combatMode = 'ranged'; this.onModeChange?.('ranged'); }

    // ── Interact ────────────────────────────────────────────────────────────
    if (kb.isJustDown('interact')) {
      this.onInteract?.(this._player.x, this._player.y);
    }

    // ── Roll — locks movement direction at start, invincibility window ──────
    if (this.moveState === 'free' && kb.isJustDown('roll')) {
      // Capture facing direction for the locked dash
      const facingLeft = (this._player as any)._facingLeft as boolean;
      this._rollDirX  = facingLeft ? -1 : 1;
      this._rollDirY  = 0;
      this.moveState  = 'rolling';
      this._rollTimer = 0;
      this._player.startAction('melee'); // roll uses melee anim rows until dedicated anim
      return;
    }

    // ── Jump ────────────────────────────────────────────────────────────────
    if (this.moveState === 'free' && kb.isJustDown('jump')) {
      this.moveState      = 'airborne';
      this._jumpTimer     = 0;
      this._jumpOffsetY   = 0;
      this._jumpVelocityY = -1.2; // px/ms — 40px peak with gravity 0.018, ~133ms air time
      return;
    }

    // ── Alt — ready stance (reduced speed, no other effect yet) ─────────────
    if (kb.isDown('ready')) {
      this.moveState = 'ready';
    } else if (this.moveState === 'ready') {
      this.moveState = 'free';
    }

    // ── RMB — enter block/parry from free or ready ──────────────────────────
    this._rmbWasDown = this._rmbHeld;
    this._rmbHeld    = pointer.rightButtonDown();
    if (this._rmbHeld && !this._rmbWasDown) {
      // RMB just pressed — enter blocking, reset parry window timer
      this._parryTimer = 0;
      this.moveState   = 'blocking';
      this._player.startAction('block');
      return;
    }

    // ── Combat actions — only inside exploration/arena zone ─────────────────
    if (!this.combatEnabled) return;

    this._checkAbilityInput();

    // ── Unified LMB attack (melee + ranged) ──────────────────────────────────
    // LMB down: accumulate charge timer.
    // LMB release: fire — charged if held past threshold.
    // Ranged quick-fires are gated by _rangedCooldown; melee always fires on release.
    this._lmbWasDown = this._lmbHeld;
    this._lmbHeld    = pointer.leftButtonDown();

    if (this._lmbHeld) {
      this._chargeTimer += delta;
      if (this._chargeTimer >= CHARGE_THRESHOLD_MS && !this._charged) {
        this._charged = true;
        // Show charge wind-up animation / weapon pose
        this._player.startAction?.(this.combatMode);
        if (this.combatMode === 'melee') {
          this.moveState = 'charging';
        }
      }
    } else if (this._lmbWasDown) {
      // Button released — fire
      const wasCharged  = this._charged;
      this._charged     = false;
      if (this.moveState === 'charging') this.moveState = 'free';
      this._chargeTimer = 0;

      if (this.combatMode === 'ranged') {
        if (this._rangedCooldown <= 0) {
          this._fireAttack(wasCharged);
        }
      } else {
        this._fireAttack(wasCharged);
      }
    }
  }

  private _tickAttacking(delta: number): void {
    this._attackTimer += delta;
    if (this._attackTimer >= ATTACK_LOCK_MS) {
      this._attackTimer = 0;
      this._player.releaseAction();
      this.moveState = 'free';
    }
  }

  private _tickRolling(delta: number): void {
    // Push enemies away from the roll position each frame — physical displacement
    if (this.combat) {
      this.combat.pushEnemiesFromPoint(this._player.x, this._player.y);
    }
    this._rollTimer += delta;
    if (this._rollTimer >= ROLL_DURATION_MS) {
      this._rollTimer = 0;
      this._player.releaseAction();
      this.moveState = 'free';
    }
  }

  private _tickAirborne(delta: number): void {
    const GRAVITY = 0.018; // px/ms² — tunable

    // Parabolic arc — integrate velocity each frame
    this._jumpVelocityY += GRAVITY * delta;
    this._jumpOffsetY   += this._jumpVelocityY * delta;

    // Clamp at ground (offset ≥ 0 means below start — land)
    if (this._jumpOffsetY >= 0) {
      this._jumpOffsetY = 0;
      this._jumpVelocityY = 0;
      this._jumpTimer = 0;
      this.moveState = 'free';
      this._player.setJumpOffset?.(0);
      return;
    }

    // Push negative offset to PlayerSprite (negative = up in screen space)
    this._player.setJumpOffset?.(this._jumpOffsetY);

    // LMB fires in midair — same as ground, no stance required
    if (this.combatEnabled) {
      this._checkAbilityInput();
      const pointer = this._scene.input.activePointer;
      this._lmbWasDown = this._lmbHeld;
      this._lmbHeld    = pointer.leftButtonDown();
      if (this._lmbWasDown && !this._lmbHeld) {
        if (this.combatMode === 'ranged') {
          if (this._rangedCooldown <= 0) this._fireAttack(false);
        } else {
          this._fireAttack(false);
        }
      }
    }
  }

  private _tickBlocking(delta: number): void {
    this._parryTimer += delta;
    const pointer = this._scene.input.activePointer;
    this._rmbHeld = pointer.rightButtonDown();
    if (!this._rmbHeld) {
      // RMB released — exit block
      this.moveState = 'free';
      this._player.stopBlock?.();
      this._parryTimer = 0;
      return;
    }
    // LMB while blocking — break block into quick attack
    if (pointer.leftButtonDown() && this.combatEnabled) {
      this.moveState = 'free';
      this._player.stopBlock?.();
      this._parryTimer = 0;
      this._fireAttack(false);
    }
  }

  private _tickParrying(delta: number): void {
    // Brief lock after a successful parry counter-attack
    this._parryLockTimer -= delta;
    if (this._parryLockTimer <= 0) {
      this._parryLockTimer = 0;
      this.moveState = 'free';
    }
  }

  private _tickAbility(delta: number): void {
    this._abilityTimer += delta;
    if (this._abilityTimer >= ABILITY_LOCK_MS) {
      this._abilityTimer = 0;
      this._player.releaseAction();
      this.moveState = 'free';
    }
  }

  private _tickHit(delta: number): void {
    this._hitTimer += delta;
    if (this._hitTimer >= HIT_STAGGER_MS) {
      this._hitTimer = 0;
      this.moveState = 'free';
    }
  }

  // ── Attack execution ───────────────────────────────────────────────────────

  private _fireAttack(charged: boolean): void {
    // Ranged: gate on fire-rate cooldown
    if (this.combatMode === 'ranged' && this._rangedCooldown > 0) return;

    const d = derivedStats(this._build);
    const chargeRatio = charged
      ? Math.min(this._chargeTimer / CHARGE_MAX_MS, 1.0)
      : 0;

    const dmgMult    = 1.0 + chargeRatio * (CHARGED_DMG_MULT_MAX - 1.0);
    const critChance = BASE_CRIT_CHANCE + chargeRatio * CHARGED_CRIT_BONUS;
    const isCrit     = Math.random() < critChance;

    const dmgMin = this.combatMode === 'melee' ? d.meleeDmgMin : d.rangedDmgMin;
    const dmgMax = this.combatMode === 'melee' ? d.meleeDmgMax : d.rangedDmgMax;

    let damage = dmgMin + Math.floor(Math.random() * (dmgMax - dmgMin + 1));
    damage = Math.round(damage * dmgMult);
    if (isCrit) damage = Math.round(damage * 1.5);
    // Power-up damage buff
    if (this._damageBuff.remainingMs > 0) {
      damage = Math.round(damage * this._damageBuff.mult);
    }

    const event: HitEvent = {
      damage, isCrit,
      element:  this._build.element,
      type:     this.combatMode,
      originX:  this._player.x,
      originY:  this._player.y,
      aimAngle: this._aimAngle,
      worldX:   this._player.x + Math.cos(this._aimAngle) * 30,
      worldY:   this._player.y + Math.sin(this._aimAngle) * 30,
    };
    this.onHit?.(event);

    if (this.combatMode === 'ranged') {
      // Trigger muzzle flash on PlayerSprite without entering the action lock.
      // startAction would set _actionType and block movement for 350ms — wrong for ranged.
      // The weapon indicator flash handles the visual; movement stays completely free.
      this._player.startAction?.('ranged');
      (this._player as any).releaseAction?.();
      this._rangedCooldown = RANGED_BASE_MS / Math.max(0.1, d.attackSpeed);
    } else {
      // Melee: full movement lock for swing duration
      this._player.startAction('melee');
      this.moveState    = 'attacking';
      this._attackTimer = 0;
    }

    this._decrementDurability(this.combatMode);
  }

  private _decrementDurability(slot: 'melee' | 'ranged'): void {
    const ws = this._build.equipment?.[slot]?.weaponStats;
    if (!ws || ws.durability <= 0) return;
    ws.durability -= 1;
    if (ws.durability === 0) this.onWeaponBreak?.(slot);
    this._durabilityDirty      = slot;
    this._durabilityFlushTimer = 800;
  }

  private _flushDurability(slot: 'melee' | 'ranged'): void {
    const item = this._build.equipment?.[slot];
    if (!item?.id || !item.weaponStats) return;
    const ENGINE = ((import.meta as any).env?.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
    fetch(`${ENGINE}/api/game/inventory/durability`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ id: item.id, durability: item.weaponStats.durability }),
    }).catch(() => {});
  }

  private _checkAbilityInput(): void {
    const kb = this._kb;
    const d  = derivedStats(this._build);
    const cls = CLASS_DEFINITIONS[this._build.class];
    const cdr = d.cooldownReduction;

    for (let i = 0; i < 3; i++) {
      const actionKey = (['ability_1', 'ability_2', 'ability_3'] as const)[i];
      if (!kb.isJustDown(actionKey)) continue;
      if (this.abilityCooldowns[i] > 0) continue;

      const ab = cls.abilities[i];
      if (!ab) continue;
      if (this.spiritCurrent < ab.spiritCost) continue;

      // Deduct spirit
      this.spiritCurrent = Math.max(0, this.spiritCurrent - ab.spiritCost);
      this.onSpiritChange?.(this.spiritCurrent, this.spiritMax);

      // Start cooldown (reduced by CDR)
      this.abilityCooldowns[i] = ab.cooldown * (1 - cdr);

      // Compute damage
      const damage = Math.round(ab.baseDmg * d.abilityDmgMultiplier);
      const isCrit = Math.random() < BASE_CRIT_CHANCE;

      const event: HitEvent = {
        damage: isCrit ? Math.round(damage * 1.5) : damage,
        isCrit,
        element:     this._build.element,
        type:        'ability',
        abilityIndex: i,
        originX:     this._player.x,
        originY:     this._player.y,
        aimAngle:    this._aimAngle,
        worldX:      this._player.x + Math.cos(this._aimAngle) * 40,
        worldY:      this._player.y + Math.sin(this._aimAngle) * 40,
      };
      this.onHit?.(event);

      this._player.startAction('ability');
      this.moveState     = 'ability';
      this._abilityTimer = 0;
      break; // only one ability per frame
    }
  }

  // ── Mouse listeners ────────────────────────────────────────────────────────

  private _setupMouseListeners(): void {
    // Mouse button state is polled each frame via Phaser pointer — no
    // event listeners needed. All handled in update().
  }

  // ── Getters for HUD ───────────────────────────────────────────────────────

  get jumpProgress(): number {
    // Progress 0→1 based on how high we are relative to ~40px peak.
    return this.moveState === 'airborne' ? Math.min(Math.abs(this._jumpOffsetY) / 40, 1) : 0;
  }

  get chargeProgress(): number {
    if (this.moveState !== 'charging') return 0;
    return Math.min(this._chargeTimer / CHARGE_MAX_MS, 1.0);
  }

  get isInCombatReadiness(): boolean {
    return this.moveState === 'ready' || this.moveState === 'charging';
  }

  /**
   * During a roll, returns the locked dash direction unit vector.
   * Returns null when not rolling — callers use normal input otherwise.
   */
  getRollDir(): { x: number; y: number } | null {
    if (this.moveState !== 'rolling') return null;
    return { x: this._rollDirX, y: this._rollDirY };
  }
}
