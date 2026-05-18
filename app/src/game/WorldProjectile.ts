/**
 * WorldProjectile — pooled laser-beam visual for ranged player attacks.
 *
 * One Graphics object per projectile. Travels from origin in aimAngle direction
 * at SPEED px/ms, drawing a tapered beam each frame. Expires after LIFETIME_MS
 * or when triggerHit() is called (at that point it briefly flashes and vanishes).
 *
 * Pool management: WorldProjectilePool owns a fixed array. Fire() activates one;
 * update() deactivates it when done. Zero per-frame allocations after warm-up.
 */

import * as Phaser from 'phaser';

// ── Constants ─────────────────────────────────────────────────────────────────

const SPEED         = 0.55;   // world px per ms
const LIFETIME_MS   = 420;    // ms before auto-expire
const BEAM_LENGTH   = 22;     // px — trailing beam draw length
const BEAM_WIDTH    = 3;      // px — beam tip width
const HIT_FLASH_MS  = 80;     // ms — hit flash duration before vanish
const DEPTH_OFFSET  = 50;     // render above most world objects

// ── WorldProjectile ───────────────────────────────────────────────────────────

export class WorldProjectile {
  private _gfx:       Phaser.GameObjects.Graphics;
  active              = false;

  // Mutable per-fire state — reset in fire(), mutated in update()
  private _x          = 0;
  private _y          = 0;
  private _vx         = 0;
  private _vy         = 0;
  private _color      = 0xffffff;
  private _age        = 0;
  private _hitFlash   = false;
  private _hitTimer   = 0;

  constructor(scene: Phaser.Scene) {
    this._gfx = scene.add.graphics().setDepth(DEPTH_OFFSET).setVisible(false);
  }

  /**
   * Activate this projectile. Call from WorldProjectilePool.fire().
   */
  fire(
    x: number, y: number,
    aimAngle: number,
    colorHex: string,
  ): void {
    this._x       = x;
    this._y       = y;
    this._vx      = Math.cos(aimAngle) * SPEED;
    this._vy      = Math.sin(aimAngle) * SPEED;
    this._color   = Phaser.Display.Color.HexStringToColor(colorHex).color;
    this._age     = 0;
    this._hitFlash  = false;
    this._hitTimer  = 0;
    this.active   = true;
    this._gfx.setVisible(true);
  }

  /**
   * Call when WorldCombatManager confirms a hit at this projectile's position.
   * Freezes the projectile and plays a brief flash before vanishing.
   */
  triggerHit(): void {
    if (!this.active || this._hitFlash) return;
    this._hitFlash = true;
    this._hitTimer = 0;
    this._vx = 0;
    this._vy = 0;
  }

  /**
   * Per-frame update. Returns true while still active.
   * delta is ms since last frame.
   */
  update(delta: number): boolean {
    if (!this.active) return false;

    this._age += delta;

    if (this._hitFlash) {
      this._hitTimer += delta;
      if (this._hitTimer >= HIT_FLASH_MS) {
        this._deactivate();
        return false;
      }
      // Flash: bright expanding ring
      const t = this._hitTimer / HIT_FLASH_MS;
      const r = 4 + t * 8;
      this._gfx.clear()
        .fillStyle(this._color, 1 - t)
        .fillCircle(this._x, this._y, r);
      return true;
    }

    if (this._age >= LIFETIME_MS) {
      this._deactivate();
      return false;
    }

    // Advance position
    this._x += this._vx * delta;
    this._y += this._vy * delta;

    // Draw tapered beam: bright tip → faded tail
    const tailX = this._x - this._vx * (BEAM_LENGTH / SPEED);
    const tailY  = this._y - this._vy * (BEAM_LENGTH / SPEED);
    const alpha  = 0.45 + 0.55 * (1 - this._age / LIFETIME_MS);

    this._gfx.clear()
      .setDepth(this._y + DEPTH_OFFSET);

    // Glowing core — bright centre line
    this._gfx.lineStyle(BEAM_WIDTH, this._color, alpha);
    this._gfx.beginPath();
    this._gfx.moveTo(tailX, tailY);
    this._gfx.lineTo(this._x, this._y);
    this._gfx.strokePath();

    // Soft outer glow — wider, more transparent
    this._gfx.lineStyle(BEAM_WIDTH + 3, this._color, alpha * 0.25);
    this._gfx.beginPath();
    this._gfx.moveTo(tailX, tailY);
    this._gfx.lineTo(this._x, this._y);
    this._gfx.strokePath();

    // Bright tip dot
    this._gfx.fillStyle(0xffffff, alpha * 0.9)
      .fillCircle(this._x, this._y, 1.5);

    return true;
  }

  /** Current world position — used by WorldProjectilePool to check hit proximity */
  get x(): number { return this._x; }
  get y(): number { return this._y; }

  destroy(): void {
    this._gfx.destroy();
  }

  private _deactivate(): void {
    this.active = false;
    this._gfx.clear().setVisible(false);
  }
}

// ── WorldProjectilePool ───────────────────────────────────────────────────────

const POOL_SIZE = 24; // max simultaneous player projectiles

export class WorldProjectilePool {
  private _pool: WorldProjectile[];

  constructor(scene: Phaser.Scene) {
    this._pool = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      this._pool.push(new WorldProjectile(scene));
    }
  }

  /**
   * Fire a laser from (x, y) in aimAngle direction.
   * Recycles the oldest inactive slot; silently drops if all slots are live
   * (never happens in practice — player fire rate is gated by attackTimer).
   */
  fire(x: number, y: number, aimAngle: number, colorHex: string): WorldProjectile | null {
    for (let i = 0; i < this._pool.length; i++) {
      if (!this._pool[i].active) {
        this._pool[i].fire(x, y, aimAngle, colorHex);
        return this._pool[i];
      }
    }
    return null;
  }

  /**
   * Update all active projectiles. For each live projectile, check proximity
   * to enemy positions using the provided callback — callback returns true if
   * a hit was confirmed (projectile should flash and vanish).
   */
  update(
    delta: number,
    checkHit: (px: number, py: number) => boolean,
  ): void {
    for (let i = 0; i < this._pool.length; i++) {
      const p = this._pool[i];
      if (!p.active) continue;
      if (checkHit(p.x, p.y)) {
        p.triggerHit();
      }
      p.update(delta);
    }
  }

  destroy(): void {
    for (let i = 0; i < this._pool.length; i++) {
      this._pool[i].destroy();
    }
  }
}
