/**
 * EffectsManager — Singleton orchestrator for all visual effects.
 *
 * Owns:
 *   - Weather particle emitters (rain / snow / dust)
 *   - Day/night rectangle overlay (PERF tier)
 *   - Day/night pipeline uniform updates (HIGH tier)
 *   - Hit-effect Graphics pool (slash / blunt / energy)
 *   - Projectile Graphics pool with trail ring-buffer
 *   - Ground aura pool
 *   - Ability ring pool
 *   - Void tether line map
 *   - Hazard patch pool (fire / frost / static)
 *   - Shadow sprite pool
 *   - Status indicator pool
 *
 * Performance contract:
 *   - No allocations inside update() or any per-frame path.
 *   - All pools pre-allocated in init(). Reset by mutation.
 *   - Weather emitter frequency lerped from a 1-second tick, not per-frame.
 *   - Day/night overlay updated once per minute by a Phaser timer.
 */

import * as Phaser from 'phaser';
import { getDayNightPipeline, applyDayNightToCamera, removeDayNightFromCamera, isPipelineActive } from './PhobosPostProcess';

// ── Types ─────────────────────────────────────────────────────────────────

export type WeatherType = 'none' | 'rain' | 'snow' | 'dust';
export type HitType     = 'slash' | 'blunt' | 'energy';
export type StatusType  = 'burn' | 'slow' | 'lightning' | 'entropy' | 'exposure' | 'stun';

export interface ShadowHandle  { destroy(): void; update(x: number, y: number): void; }
export interface AuraHandle    { destroy(): void; update(x: number, y: number): void; }
export interface ProjectileHandle { destroy(): void; update(x: number, y: number): void; }
export interface StatusHandle  { destroy(): void; update(x: number, y: number): void; }

// ── Constants ──────────────────────────────────────────────────────────────

const TOD_TINTS = [
  { hour:  0, color: 0x000020, alpha: 0.65 },
  { hour:  5, color: 0x100820, alpha: 0.50 },
  { hour:  6, color: 0x3a2010, alpha: 0.25 },
  { hour:  8, color: 0x000000, alpha: 0.00 },
  { hour: 17, color: 0x000000, alpha: 0.00 },
  { hour: 18, color: 0x201008, alpha: 0.15 },
  { hour: 19, color: 0x300a00, alpha: 0.30 },
  { hour: 20, color: 0x100020, alpha: 0.50 },
  { hour: 22, color: 0x000020, alpha: 0.60 },
] as const;

const WEATHER_INT_MAP: Record<WeatherType, number> = {
  none: 0, rain: 1, snow: 2, dust: 3,
};

const ELEMENT_COLORS: Record<string, number> = {
  plasma: 0xc080ff, fire: 0xff6020, ice: 0x60d0ff,
  lightning: 0xffe040, void: 0x8040c0, default: 0xffffff,
};

const STATUS_COLORS: Record<StatusType, number> = {
  burn: 0xff6020, slow: 0x60a0ff, lightning: 0xffe040,
  entropy: 0x8040c0, exposure: 0x00ffcc, stun: 0xffff40,
};

// Ramp duration for weather transitions (ms)
const WEATHER_RAMP_MS = 90_000;

// ── Seeded LCG (matches WorldScene / NebulaBackground) ────────────────────

function seededLCG(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ── Interpolation helpers ──────────────────────────────────────────────────

function lerpNum(a: number, b: number, t: number): number { return a + (b - a) * t; }

function hexToRgb(hex: number): { r: number; g: number; b: number } {
  return { r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff };
}

function lerpColor(a: number, b: number, t: number): number {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const r = Math.round(lerpNum(ca.r, cb.r, t));
  const g = Math.round(lerpNum(ca.g, cb.g, t));
  const bl = Math.round(lerpNum(ca.b, cb.b, t));
  return (r << 16) | (g << 8) | bl;
}

// ── EffectsManager ────────────────────────────────────────────────────────

export class EffectsManager {
  private static _inst: EffectsManager | null = null;
  static getInstance(): EffectsManager {
    if (!EffectsManager._inst) EffectsManager._inst = new EffectsManager();
    return EffectsManager._inst;
  }

  // Injected by init()
  private _scene!:    Phaser.Scene;
  private _highPerf!: boolean;
  private _W!: number;
  private _H!: number;
  private _onResize:  (() => void) | null = null;

  // ── Day/night ────────────────────────────────────────────────────────────
  private _tod_overlay!:  Phaser.GameObjects.Rectangle;
  private _hourTimer!:    Phaser.Time.TimerEvent;
  private _currentHour    = 12.0;

  // ── Weather ───────────────────────────────────────────────────────────────
  private _weatherType:   WeatherType = 'none';
  private _weatherInt     = 0.0;        // target 0–1
  private _weatherProg    = 0.0;        // current transition progress
  private _weatherTimer   = 0.0;        // ms elapsed in current ramp
  private _weatherRamping = false;
  private _weatherTick!:  Phaser.Time.TimerEvent;

  // Emitters — created lazily on first weather activation
  private _rainEmitter:  Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private _rainSplat:    Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private _snowEmitter:  Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private _snowHeavy:    Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private _dustEmitter:  Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private _dustFall:     Phaser.GameObjects.Particles.ParticleEmitter | null = null;

  // ── Hit effect pools ─────────────────────────────────────────────────────
  private _slashPool:   Phaser.GameObjects.Graphics[] = [];
  private _bluntPool:   Phaser.GameObjects.Graphics[] = [];
  private _energyPool:  Phaser.GameObjects.Graphics[] = [];

  // ── Projectile pool ───────────────────────────────────────────────────────
  private _projPool: Array<{
    g: Phaser.GameObjects.Graphics;
    trail: Array<{ x: number; y: number }>;
    active: boolean;
    color: number;
  }> = [];

  // ── Ability ring pool ─────────────────────────────────────────────────────
  private _ringPool: Phaser.GameObjects.Graphics[] = [];

  // ── Ground aura pool ─────────────────────────────────────────────────────
  private _auraPool: Array<{
    outer: Phaser.GameObjects.Ellipse;
    inner: Phaser.GameObjects.Ellipse | null;
    tween: Phaser.Tweens.Tween | null;
    active: boolean;
  }> = [];

  // ── Void tether map ───────────────────────────────────────────────────────
  private _tetherGraphics!: Phaser.GameObjects.Graphics;
  private _tethers: Map<number, { wx: number; wy: number; rx: number; ry: number }> = new Map();
  private _dashOffset = 0.0;

  // ── Hazard patches ────────────────────────────────────────────────────────
  private _patchPool: Array<{
    outer: Phaser.GameObjects.Ellipse;
    inner: Phaser.GameObjects.Ellipse | null;
    tween: Phaser.Tweens.Tween | null;
    type:  'fire' | 'frost' | 'static' | null;
    active: boolean;
  }> = [];

  // ── Status indicators ─────────────────────────────────────────────────────
  private _statusPool: Array<{
    g:    Phaser.GameObjects.Graphics;
    type: StatusType | null;
    active: boolean;
    phase: number;
  }> = [];

  // ── Shadow pool ───────────────────────────────────────────────────────────
  private _shadowPool: Array<{
    img: Phaser.GameObjects.Image;
    active: boolean;
  }> = [];

  // ─────────────────────────────────────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────────────────────────────────────

  init(scene: Phaser.Scene, highPerf: boolean): void {
    // Destroy all existing Phaser objects and timers before re-init
    // to prevent layering effects when switching perf modes.
    this._teardown();

    this._scene    = scene;
    this._highPerf = highPerf;
    this._W        = scene.scale.width  || 1280;
    this._H        = scene.scale.height || 720;

    // Keep _W/_H current for the lifetime of this init — Scale.RESIZE can
    // change dimensions at any time. The TOD overlay rectangle must track
    // the true canvas size; weather emitters use scrollFactor(0) so their
    // particle spawn ranges are also in screen space and must be rebuilt
    // when the canvas grows significantly. A full re-init on resize is the
    // safest approach; _teardown() is cheap and idempotent.
    scene.scale.off('resize', this._onResize, this);
    this._onResize = () => {
      if (!this._scene) return;
      this.init(this._scene, this._highPerf);
    };
    scene.scale.on('resize', this._onResize, this);

    this._initDayNight();
    this._initWeatherEmitters();
    this._initPools();
    this._initTethers();
    this._scheduleWeather();

    if (highPerf && scene.sys.game.renderer.type === Phaser.WEBGL) {
      const attached = applyDayNightToCamera(scene.cameras.main);
      if (!attached) {
        // Pipeline unavailable — keep PERF overlay visible as fallback
        if (this._tod_overlay) this._tod_overlay.setAlpha(1);
      } else {
        // Pipeline active — hide overlay (pipeline handles the grade)
        if (this._tod_overlay) this._tod_overlay.setAlpha(0);
      }
    }

    // 1-second weather tick
    this._weatherTick = scene.time.addEvent({
      delay: 1000,
      callback: this._onWeatherTick,
      callbackScope: this,
      loop: true,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────────────────────────────────

  setWeather(type: WeatherType, intensity: number): void {
    if (this._weatherType === type) return;
    this._weatherType  = type;
    this._weatherInt   = Math.max(0, Math.min(1, intensity));
    this._weatherTimer = 0.0;
    this._weatherRamping = true;
    this._weatherProg  = 0.0;

    // Immediately stop all emitters; ramp-in resumes as progress builds
    this._stopAllEmitters();
  }

  lightningFlash(): void {
    if (this._highPerf) {
      const pipeline = getDayNightPipeline(this._scene.cameras.main);
      if (pipeline) {
        pipeline.setLightning(1.0);
        this._scene.tweens.add({
          targets: { v: 1.0 },
          v: 0.0,
          duration: 120,
          onUpdate: (_tween, target) => pipeline.setLightning((target as { v: number }).v),
          ease: 'Quad.easeOut',
        });
        return;
      }
    }
    // PERF fallback — bump overlay alpha
    const orig = this._tod_overlay.alpha;
    this._tod_overlay.setAlpha(Math.min(1.0, orig + 0.4));
    this._scene.tweens.add({
      targets: this._tod_overlay,
      alpha: orig,
      duration: 120,
      ease: 'Quad.easeOut',
    });
  }

  spawnHitEffect(x: number, y: number, type: HitType, elementColor = 0xffffff): void {
    switch (type) {
      case 'slash':  this._spawnSlash(x, y); break;
      case 'blunt':  this._spawnBlunt(x, y); break;
      case 'energy': this._spawnEnergy(x, y, elementColor); break;
    }
  }

  spawnAbilityRing(x: number, y: number, elementColor = 0xffffff): void {
    const g = this._acquirePool(this._ringPool);
    if (!g) return;
    g.clear();

    let radius = 4;
    const targetRadius = 60;
    const duration = this._highPerf ? 450 : 400;

    const drawRing = (): void => {
      g.clear();
      g.lineStyle(2, elementColor, 0.7 * (1 - radius / targetRadius));
      g.strokeCircle(x, y, radius);
      if (this._highPerf) {
        g.lineStyle(1.5, elementColor, 0.35 * (1 - radius / targetRadius));
        g.strokeCircle(x, y, radius * 0.6);
      }
    };

    this._scene.tweens.add({
      targets: { r: 4 },
      r: targetRadius,
      duration,
      ease: 'Quad.easeOut',
      onUpdate: (_t, tgt) => { radius = (tgt as { r: number }).r; drawRing(); },
      onComplete: () => { g.clear(); this._releasePool(this._ringPool, g); },
    });
  }

  spawnGroundAura(x: number, y: number, radius: number, elementColor = 0xffffff): AuraHandle {
    const slot = this._acquireAuraSlot();
    slot.outer.setPosition(x, y)
      .setSize(radius * 2, radius * 0.6)
      .setFillStyle(elementColor, 0.25)
      .setActive(true)
      .setVisible(true);
    slot.active = true;

    if (this._highPerf && slot.inner) {
      slot.inner.setPosition(x, y)
        .setSize(radius, radius * 0.3)
        .setFillStyle(elementColor, 0.35)
        .setActive(true).setVisible(true);
    }

    const targets: Phaser.GameObjects.Ellipse[] = slot.inner
      ? [slot.outer, slot.inner]
      : [slot.outer];

    slot.tween = this._scene.tweens.add({
      targets,
      alpha: { from: 0.3, to: 0.15 },
      duration: 1500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    return {
      update: (nx: number, ny: number) => {
        slot.outer.setPosition(nx, ny);
        if (slot.inner) slot.inner.setPosition(nx, ny);
      },
      destroy: () => {
        slot.tween?.stop();
        slot.outer.setVisible(false).setActive(false);
        if (slot.inner) slot.inner.setVisible(false).setActive(false);
        slot.active = false;
      },
    };
  }

  spawnProjectile(
    fromX: number, fromY: number,
    toX: number,   toY: number,
    elementColor = 0xffffff,
    onComplete?: () => void
  ): ProjectileHandle {
    const slot = this._acquireProjSlot(elementColor);
    const duration = 400;

    const pos = { x: fromX, y: fromY };
    this._scene.tweens.add({
      targets: pos,
      x: toX, y: toY,
      duration,
      ease: 'Linear',
      onUpdate: () => {
        this._drawProjectile(slot, pos.x, pos.y);
        slot.trail.unshift({ x: pos.x, y: pos.y });
        if (slot.trail.length > 6) slot.trail.length = 6;
      },
      onComplete: () => {
        slot.g.clear();
        slot.trail.length = 0;
        slot.active = false;
        onComplete?.();
      },
    });

    return {
      update: (nx, ny) => this._drawProjectile(slot, nx, ny),
      destroy: () => {
        slot.g.clear();
        slot.trail.length = 0;
        slot.active = false;
      },
    };
  }

  attachShadow(entity: Phaser.GameObjects.Sprite, scale = 0.5): ShadowHandle {
    const slot = this._acquireShadowSlot();
    slot.img.setScale(scale).setVisible(true).setActive(true);
    return {
      update: (x: number, y: number) => { slot.img.x = x; slot.img.y = y + 6; },
      destroy: () => { slot.img.setVisible(false).setActive(false); slot.active = false; },
    };
  }

  setVoidTether(wx: number, wy: number, rx: number, ry: number, id: number): void {
    this._tethers.set(id, { wx, wy, rx, ry });
  }

  removeVoidTether(id: number): void {
    this._tethers.delete(id);
  }

  spawnStatusIndicator(type: StatusType): StatusHandle {
    const slot = this._acquireStatusSlot(type);
    return {
      update: (x: number, y: number) => this._drawStatus(slot, x, y),
      destroy: () => { slot.g.clear(); slot.active = false; slot.type = null; },
    };
  }

  spawnHazardPatch(
    x: number, y: number,
    type: 'fire' | 'frost' | 'static'
  ): AuraHandle {
    const colorMap = { fire: 0xff4010, frost: 0x40a0ff, static: 0xffe040 };
    const col = colorMap[type];
    const slot = this._acquirePatchSlot(type);

    slot.outer.setPosition(x, y).setSize(48, 20).setFillStyle(col, 0.35)
      .setActive(true).setVisible(true);

    if (this._highPerf && slot.inner) {
      slot.inner.setPosition(x, y).setSize(24, 10).setFillStyle(col, 0.5)
        .setActive(true).setVisible(true);
      slot.tween = this._scene.tweens.add({
        targets: slot.inner, alpha: { from: 0.5, to: 0.1 },
        duration: 1000, yoyo: true, repeat: -1,
      });
    }

    return {
      update: (nx, ny) => {
        slot.outer.setPosition(nx, ny);
        if (slot.inner) slot.inner.setPosition(nx, ny);
      },
      destroy: () => {
        slot.tween?.stop();
        slot.outer.setVisible(false).setActive(false);
        if (slot.inner) slot.inner.setVisible(false).setActive(false);
        slot.active = false; slot.type = null;
      },
    };
  }

  /** Called from WorldScene.update() */
  updateTethers(delta: number): void {
    if (this._tethers.size === 0) return;
    this._dashOffset = (this._dashOffset + delta * 0.03) % 12;
    const g = this._tetherGraphics;
    g.clear();
    g.lineStyle(1, 0x8040c0, 0.3);

    for (const { wx, wy, rx, ry } of this._tethers.values()) {
      if (this._highPerf) {
        this._drawDashedLine(g, wx, wy, rx, ry);
      } else {
        g.lineBetween(wx, wy, rx, ry);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE — INIT
  // ─────────────────────────────────────────────────────────────────────────

  private _teardown(): void {
    // Destroy overlay and timers if they exist from a prior init() call.
    // Called at the start of every init() to prevent object stacking.
    // Remove resize listener before re-init so it doesn't stack.
    try {
      if (this._onResize && this._scene) {
        this._scene.scale.off('resize', this._onResize, this);
      }
    } catch { /* first init */ }
    try { this._tod_overlay?.destroy();   } catch { /* first init */ }
    try { this._hourTimer?.remove(false); } catch { /* first init */ }
    try { this._weatherTick?.remove(false); } catch { /* first init */ }

    // Destroy weather emitters
    const emitters = [
      '_rainEmitter', '_rainSplat', '_snowEmitter', '_snowHeavy',
      '_dustEmitter', '_dustFall',
    ] as const;
    for (const key of emitters) {
      try { (this as any)[key]?.destroy(); (this as any)[key] = null; } catch { /* ok */ }
    }

    // Destroy pools (shadow sprites, hit pools, tether lines, etc.)
    try {
      for (const slot of (this as any)._shadowPool ?? []) {
        try { slot.sprite?.destroy(); } catch { /* ok */ }
      }
      (this as any)._shadowPool = [];
    } catch { /* first init */ }

    // Destroy tether Graphics objects
    try {
      for (const t of (this as any)._tethers ?? []) {
        try { t.gfx?.destroy(); } catch { /* ok */ }
      }
      (this as any)._tethers = [];
    } catch { /* first init */ }
  }

  private _initDayNight(): void {
    const hour = this._getRealHour();
    this._currentHour = hour;

    // PERF overlay — always created; hidden when pipeline active
    this._tod_overlay = this._scene.add.rectangle(
      this._W / 2, this._H / 2, this._W, this._H, 0x000000, 0
    ).setDepth(500).setScrollFactor(0).setOrigin(0.5);

    this._applyTOD(hour);

    // Update once per minute
    this._hourTimer = this._scene.time.addEvent({
      delay: 60_000,
      callback: () => {
        const h = this._getRealHour();
        this._currentHour = h;
        this._applyTOD(h);
        if (this._highPerf) {
          getDayNightPipeline(this._scene.cameras.main)?.setHour(h);
        }
      },
      loop: true,
    });

    // Set pipeline initial hour if HIGH
    if (this._highPerf) {
      this._scene.time.delayedCall(100, () => {
        getDayNightPipeline(this._scene.cameras.main)?.setHour(hour);
      });
    }
  }

  private _initWeatherEmitters(): void {
    // All emitters created here but stopped (on: false).
    // Activated by setWeather() + transition tick.
    const W = this._W;
    const H = this._H;
    const scene = this._scene;

    // ── Rain ────────────────────────────────────────────────────────────────
    this._rainEmitter = scene.add.particles(0, 0, 'particle-dot', {
      x: { min: 0, max: W },
      y: { min: -20, max: 0 },
      lifespan: 900,
      speedY: { min: 420, max: 580 },
      speedX: { min: -20, max: -5 },
      scaleX: 0.06,
      scaleY: { min: 1.8, max: 2.8 },
      alpha: { start: 0.5, end: 0.0 },
      tint: 0xa0b8cc,
      quantity: 1,
      frequency: 18,
      maxParticles: 50,
    }).setDepth(490).setScrollFactor(0);
    this._rainEmitter.stop();

    if (this._highPerf) {
      this._rainSplat = scene.add.particles(0, H - 40, 'particle-dot', {
        x: { min: 0, max: W },
        y: 0,
        lifespan: 300,
        speedY: { min: -30, max: -10 },
        speedX: { min: -10, max: 10 },
        scale: { start: 0.8, end: 2.5 },
        alpha: { start: 0.4, end: 0.0 },
        tint: 0xc0d8e8,
        quantity: 1,
        frequency: 300,
        maxParticles: 20,
      }).setDepth(491).setScrollFactor(0);
      this._rainSplat.stop();
    }

    // ── Snow ────────────────────────────────────────────────────────────────
    this._snowEmitter = scene.add.particles(0, 0, 'particle-dot', {
      x: { min: 0, max: W },
      y: -10,
      lifespan: { min: 3000, max: 5000 },
      speedY: { min: 30, max: 70 },
      speedX: { min: -20, max: 20 },
      scale: { min: 0.3, max: 0.7 },
      alpha: { start: 0.7, end: 0.0 },
      tint: 0xe8f0ff,
      quantity: 1,
      frequency: 80,
      rotate: { min: 0, max: 360 },
      maxParticles: 50,
    }).setDepth(490).setScrollFactor(0);
    this._snowEmitter.stop();

    if (this._highPerf) {
      this._snowHeavy = scene.add.particles(0, 0, 'snow-flake', {
        x: { min: 0, max: W },
        y: -20,
        lifespan: { min: 5000, max: 8000 },
        speedY: { min: 15, max: 35 },
        speedX: { min: -15, max: 15 },
        // 128px source texture — scale to ~14-22px on screen
        scale: { min: 0.11, max: 0.17 },
        alpha: { start: 0.5, end: 0.0 },
        tint: 0xf0f4ff,
        quantity: 1,
        frequency: 400,
        rotate: { min: 0, max: 360 },
        maxParticles: 30,
      }).setDepth(489).setScrollFactor(0);
      this._snowHeavy.stop();
    }

    // ── Dust ────────────────────────────────────────────────────────────────
    this._dustEmitter = scene.add.particles(0, 0, 'particle-dot', {
      x: -20,
      y: { min: H * 0.4, max: H },
      lifespan: { min: 2000, max: 4000 },
      speedX: { min: 60, max: 150 },
      speedY: { min: -8, max: 8 },
      scale: { min: 0.4, max: 1.2 },
      alpha: { start: 0.0, end: 0.0 },
      tint: [0xc8a060, 0xa88040, 0xd4b070],
      quantity: 1,
      frequency: 120,
      maxParticles: 30,
    }).setDepth(490).setScrollFactor(0);
    this._dustEmitter.stop();

    if (this._highPerf) {
      this._dustFall = scene.add.particles(0, 0, 'particle-dot', {
        x: { min: 0, max: W },
        y: -10,
        lifespan: { min: 3000, max: 5000 },
        speedY: { min: 10, max: 30 },
        speedX: { min: -5, max: 5 },
        scale: { min: 0.5, max: 1.5 },
        alpha: { start: 0.15, end: 0.0 },
        tint: [0xc8a060, 0xa88040],
        quantity: 1,
        frequency: 200,
        maxParticles: 20,
      }).setDepth(489).setScrollFactor(0);
      this._dustFall.stop();
    }
  }

  private _initPools(): void {
    const scene = this._scene;

    // Hit pools
    for (let i = 0; i < 8; i++) {
      this._slashPool.push(scene.add.graphics().setDepth(50));
    }
    for (let i = 0; i < 6; i++) {
      this._bluntPool.push(scene.add.graphics().setDepth(50));
    }
    for (let i = 0; i < 8; i++) {
      this._energyPool.push(scene.add.graphics().setDepth(50));
    }

    // Projectile pool
    for (let i = 0; i < 12; i++) {
      this._projPool.push({
        g: scene.add.graphics().setDepth(50),
        trail: [],
        active: false,
        color: 0xffffff,
      });
    }

    // Ring pool
    for (let i = 0; i < 8; i++) {
      this._ringPool.push(scene.add.graphics().setDepth(50));
    }

    // Aura pool
    for (let i = 0; i < 6; i++) {
      const outer = scene.add.ellipse(0, 0, 80, 24, 0xffffff, 0.25).setDepth(8).setVisible(false);
      const inner = this._highPerf
        ? scene.add.ellipse(0, 0, 40, 12, 0xffffff, 0.35).setDepth(8).setVisible(false)
        : null;
      this._auraPool.push({ outer, inner, tween: null, active: false });
    }

    // Patch pool
    for (let i = 0; i < 8; i++) {
      const outer = scene.add.ellipse(0, 0, 48, 20, 0xffffff, 0.35).setDepth(8).setVisible(false);
      const inner = this._highPerf
        ? scene.add.ellipse(0, 0, 24, 10, 0xffffff, 0.5).setDepth(8).setVisible(false)
        : null;
      this._patchPool.push({ outer, inner, tween: null, type: null, active: false });
    }

    // Shadow pool
    for (let i = 0; i < 16; i++) {
      const img = scene.add.image(0, 0, 'shadow-oval')
        .setDepth(9).setAlpha(0.45).setVisible(false);
      this._shadowPool.push({ img, active: false });
    }

    // Status pool
    for (let i = 0; i < 16; i++) {
      this._statusPool.push({
        g: scene.add.graphics().setDepth(52),
        type: null,
        active: false,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  private _initTethers(): void {
    this._tetherGraphics = this._scene.add.graphics().setDepth(48);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE — DAY/NIGHT
  // ─────────────────────────────────────────────────────────────────────────

  private _getRealHour(): number {
    const now = new Date();
    return now.getHours() + now.getMinutes() / 60;
  }

  private _applyTOD(hour: number): void {
    // Explicit type so 'as const' literal types don't narrow prev/next
    // to the specific element type (which would be incompatible on assignment)
    type TodEntry = { readonly hour: number; readonly color: number; readonly alpha: number };
    let prev: TodEntry = TOD_TINTS[TOD_TINTS.length - 1];
    let next: TodEntry = TOD_TINTS[0];
    for (let i = 0; i < TOD_TINTS.length - 1; i++) {
      if (hour >= TOD_TINTS[i].hour && hour < TOD_TINTS[i + 1].hour) {
        prev = TOD_TINTS[i];
        next = TOD_TINTS[i + 1];
        break;
      }
    }
    const range = next.hour - prev.hour;
    const t = range > 0 ? (hour - prev.hour) / range : 0;
    const color = lerpColor(prev.color, next.color, t);
    const alpha = lerpNum(prev.alpha, next.alpha, t);

    this._tod_overlay.setFillStyle(color, alpha);

    // In HIGH mode we hide the overlay ONLY if the pipeline successfully attached.
    // If pipeline failed (fallback), overlay stays visible as the only grade.
    if (this._highPerf && isPipelineActive()) {
      this._tod_overlay.setAlpha(0);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE — WEATHER
  // ─────────────────────────────────────────────────────────────────────────

  private _scheduleWeather(): void {
    const daySeed = Math.floor(Date.now() / 86_400_000);
    const rng = seededLCG(daySeed);
    const roll = rng();

    if (roll < 0.15)       this.setWeather('snow', rng() * 0.7 + 0.3);
    else if (roll < 0.45)  this.setWeather('rain', rng() * 0.8 + 0.2);
    else if (roll < 0.50)  this.setWeather('dust', rng() * 0.5 + 0.2);
    // else: stays clear
  }

  private _onWeatherTick(): void {
    if (!this._weatherRamping) return;
    this._weatherTimer += 1000;
    const t = Math.min(this._weatherTimer / WEATHER_RAMP_MS, 1.0);
    // Cubic ease-in-out — mirrors Ilithria's parabolic transition
    const prog = t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;
    this._weatherProg = prog;

    if (t >= 1.0) this._weatherRamping = false;

    this._applyWeatherProgress(prog);

    // Update pipeline weather uniforms
    if (this._highPerf) {
      const pipe = getDayNightPipeline(this._scene.cameras.main);
      if (pipe) {
        pipe.setWeather(WEATHER_INT_MAP[this._weatherType], prog * this._weatherInt);
      }
    }
  }

  private _applyWeatherProgress(prog: number): void {
    const active = prog > 0.02;

    const setEmitter = (
      em: Phaser.GameObjects.Particles.ParticleEmitter | null,
      baseFreq: number,
      peakFreq: number
    ): void => {
      if (!em) return;
      if (active) {
        em.start();
        const freq = Math.round(lerpNum(baseFreq, peakFreq, prog));
        em.setFrequency(freq);
      } else {
        em.stop();
      }
    };

    // Stop all first, then start relevant ones
    this._stopAllEmitters();

    switch (this._weatherType) {
      case 'rain':
        setEmitter(this._rainEmitter, 200, 25);
        if (this._highPerf) setEmitter(this._rainSplat, 2000, 300);
        break;
      case 'snow':
        setEmitter(this._snowEmitter, 500, 80);
        if (this._highPerf) setEmitter(this._snowHeavy, 2000, 400);
        break;
      case 'dust':
        setEmitter(this._dustEmitter, 800, 120);
        if (this._highPerf) setEmitter(this._dustFall, 2000, 200);
        break;
    }
  }

  private _stopAllEmitters(): void {
    this._rainEmitter?.stop();
    this._rainSplat?.stop();
    this._snowEmitter?.stop();
    this._snowHeavy?.stop();
    this._dustEmitter?.stop();
    this._dustFall?.stop();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE — HIT EFFECTS
  // ─────────────────────────────────────────────────────────────────────────

  private _spawnSlash(x: number, y: number): void {
    const g = this._acquirePool(this._slashPool);
    if (!g) return;
    const angle = Math.random() * Math.PI * 2;
    const r = 10;
    g.clear();
    g.lineStyle(2, 0xffffff, 0.8);
    g.beginPath();
    g.arc(x, y, r, angle, angle + 1.4);
    g.strokePath();
    let scale = 1.0;
    this._scene.tweens.add({
      targets: { s: 1.0, a: 0.8 },
      s: 1.6, a: 0.0,
      duration: 180,
      ease: 'Quad.easeOut',
      onUpdate: (_tw, tgt) => {
        const t = tgt as { s: number; a: number };
        scale = t.s;
        g.clear();
        g.lineStyle(2, 0xffffff, t.a);
        g.beginPath();
        g.arc(x, y, r * scale, angle, angle + 1.4);
        g.strokePath();
      },
      onComplete: () => { g.clear(); this._releasePool(this._slashPool, g); },
    });
  }

  private _spawnBlunt(x: number, y: number): void {
    const g = this._acquirePool(this._bluntPool);
    if (!g) return;
    let s = 1.0;
    this._scene.tweens.add({
      targets: { s: 1.0, a: 0.7 },
      s: 0.5, a: 0.0,
      duration: 200,
      ease: 'Quad.easeIn',
      onUpdate: (_tw, tgt) => {
        const t = tgt as { s: number; a: number };
        g.clear();
        [[4, t.a], [8, t.a * 0.55], [12, t.a * 0.25]].forEach(([r, al]) => {
          g.fillStyle(0xffffff, al as number);
          g.fillCircle(x, y, (r as number) * t.s);
        });
      },
      onComplete: () => { g.clear(); this._releasePool(this._bluntPool, g); },
    });
    void s; // suppress unused warning
  }

  private _spawnEnergy(x: number, y: number, col: number): void {
    const g = this._acquirePool(this._energyPool);
    if (!g) return;
    this._scene.tweens.add({
      targets: { a: 0.8 },
      a: 0.0,
      duration: 150,
      ease: 'Quad.easeOut',
      onUpdate: (_tw, tgt) => {
        const t = tgt as { a: number };
        g.clear();
        g.fillStyle(col, t.a);
        g.fillCircle(x, y, 5);
        g.fillStyle(col, t.a * 0.3);
        g.fillCircle(x, y, 10);
      },
      onComplete: () => { g.clear(); this._releasePool(this._energyPool, g); },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE — PROJECTILE
  // ─────────────────────────────────────────────────────────────────────────

  private _drawProjectile(
    slot: { g: Phaser.GameObjects.Graphics; trail: Array<{ x: number; y: number }>; color: number },
    x: number, y: number
  ): void {
    const g = slot.g;
    g.clear();

    if (this._highPerf) {
      const alphas  = [0.70, 0.55, 0.40, 0.28, 0.15, 0.05];
      const radii   = [3.0, 2.5, 2.0, 1.5, 1.0, 0.5];
      slot.trail.forEach((pt, i) => {
        g.fillStyle(slot.color, alphas[i]);
        g.fillCircle(pt.x, pt.y, radii[i]);
      });
    }

    g.fillStyle(slot.color, 0.9);
    g.fillCircle(x, y, 3);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE — STATUS INDICATORS
  // ─────────────────────────────────────────────────────────────────────────

  private _drawStatus(
    slot: { g: Phaser.GameObjects.Graphics; type: StatusType | null; phase: number },
    x: number, y: number
  ): void {
    const type = slot.type;
    if (!type) return;
    const col = STATUS_COLORS[type];
    const g = slot.g;
    g.clear();
    slot.phase += 0.05;
    const pulse = 0.6 + 0.4 * Math.sin(slot.phase);

    if (type === 'stun') {
      // Three orbiting circles
      for (let i = 0; i < 3; i++) {
        const a = slot.phase + (i * Math.PI * 2) / 3;
        const sx = x + Math.cos(a) * 16;
        const sy = y - 20 + Math.sin(a) * 6;
        g.fillStyle(col, 0.8);
        g.fillCircle(sx, sy, 3);
      }
    } else {
      g.fillStyle(col, pulse * 0.8);
      g.fillCircle(x, y - 20, 5);
      if (this._highPerf) {
        g.lineStyle(1, col, pulse * 0.3);
        g.strokeCircle(x, y - 20, 8);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE — VOID TETHERS
  // ─────────────────────────────────────────────────────────────────────────

  private _drawDashedLine(
    g: Phaser.GameObjects.Graphics,
    x1: number, y1: number,
    x2: number, y2: number
  ): void {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return;
    const ux = dx / len;
    const uy = dy / len;
    const segLen = 12;
    let drawn = this._dashOffset % (segLen * 2);
    let drawing = drawn < segLen;

    g.beginPath();
    let cur = 0;
    while (cur < len) {
      const px = x1 + ux * cur;
      const py = y1 + uy * cur;
      if (drawing) g.moveTo(px, py); else g.lineTo(px, py);
      cur += segLen - drawn;
      drawn = 0;
      drawing = !drawing;
    }
    g.strokePath();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE — POOL HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  private _acquirePool(pool: Phaser.GameObjects.Graphics[]): Phaser.GameObjects.Graphics | null {
    for (const g of pool) {
      if (!g.active) { g.setActive(true); return g; }
    }
    return null; // pool exhausted — silently skip
  }

  private _releasePool(pool: Phaser.GameObjects.Graphics[], g: Phaser.GameObjects.Graphics): void {
    g.clear();
    g.setActive(false);
  }

  private _acquireAuraSlot(): typeof this._auraPool[number] {
    return this._auraPool.find(s => !s.active) ?? this._auraPool[0];
  }

  private _acquirePatchSlot(type: 'fire' | 'frost' | 'static'): typeof this._patchPool[number] {
    const s = this._patchPool.find(p => !p.active) ?? this._patchPool[0];
    s.type = type;
    return s;
  }

  private _acquireProjSlot(color: number): typeof this._projPool[number] {
    const s = this._projPool.find(p => !p.active) ?? this._projPool[0];
    s.active = true;
    s.color  = color;
    s.trail.length = 0;
    return s;
  }

  private _acquireShadowSlot(): typeof this._shadowPool[number] {
    return this._shadowPool.find(s => !s.active) ?? this._shadowPool[0];
  }

  private _acquireStatusSlot(type: StatusType): typeof this._statusPool[number] {
    const s = this._statusPool.find(p => !p.active) ?? this._statusPool[0];
    s.active = true;
    s.type = type;
    return s;
  }
}