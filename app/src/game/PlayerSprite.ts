/**
 * PlayerSprite — user-controlled character for PHOBOS World.
 *
 * WASD / arrow key movement in World mode. Collects coins by proximity.
 * Uses sprite sheet when available (class-body-sheet), rectangle fallback.
 * Element tinting via setTint() on the sprite.
 *
 * Sheet format: 633×633 px frames, 12 columns × 12 rows.
 * Display scale: setScale(0.125) → 633 native ≈ 79px on screen.
 * Full frame map is identical to AnimatedCharacterSprite — see that file.
 *
 * Player walk uses the 8-way walk rows (rows 0–4).
 * Player idle uses row 10: idle_s[120-123] / idle_e[124-127].
 */

import * as Phaser from 'phaser';
import { TileWorld } from './TileWorld';
import { bakeWeaponComposite, WEAPON_GRIP_X } from './WeaponCompositor';
import type { WeaponAssembly } from './ItemDefinitions';

// ── Frame index constants (12-column grid) ───────────────────────────────────
const F = {
  walk_s:  [0,  1,  2,  3],
  walk_se: [12, 13, 14, 15],
  walk_e:  [24, 25, 26, 27],
  walk_ne: [36, 37, 38, 39],
  walk_n:  [48, 49, 50, 51],
  idle_s:  [120, 121, 122, 123],
  idle_e:  [124, 125, 126, 127],
  die:     [128, 129],
  // Combat rows (4 frames each: anticipation, windup, contact/hold, recovery)
  melee_s:  [60, 61, 62, 63],  melee_se: [72, 73, 74, 75],  melee_e:  [84, 85, 86, 87],
  melee_ne: [96, 97, 98, 99],  melee_n:  [108,109,110,111],
  range_s:  [64, 65, 66, 67],  range_se: [76, 77, 78, 79],  range_e:  [88, 89, 90, 91],
  range_ne: [100,101,102,103], range_n:  [112,113,114,115],
  abil_s:   [68, 69, 70, 71],  abil_se:  [80, 81, 82, 83],  abil_e:   [92, 93, 94, 95],
  abil_ne:  [104,105,106,107], abil_n:   [116,117,118,119],
} as const;

// ── Animation timing rules ────────────────────────────────────────────────────
// Melee:  frames 0,1,2 loop while attacking; frame 3 (recovery) plays once on release
// Ranged: frame 0 (aim), then frames 1,2 loop while holding fire; frame 3 plays on release
// Ability: all 4 frames play once, no loop
const ANIM_FPS_COMBAT = 12;

// ── Player zone center ───────────────────────────────────────────────────────
const HOME_X = 640;  // tile (30,18) — upper player zone, near SHOP
const HOME_Y = 384;

// ── Movement constants ───────────────────────────────────────────────────────
const MOVE_SPEED = 2.5;

// ── Animation frame rates ────────────────────────────────────────────────────
const ANIM_FPS_IDLE = 4;
const ANIM_FPS_WALK = 8;

// 633px native → 0.125 scale ≈ 79px display
const SPRITE_SCALE = 0.125;

// ── Element tint colors ──────────────────────────────────────────────────────
const ELEMENT_TINTS: Record<string, number> = {
  plasma:    0xe0e0e0,
  fire:      0xf59e0b,
  ice:       0x3b82f6,
  lightning: 0x8b5cf6,
  void:      0x6366f1,
};

export interface PlayerConfig {
  name: string;
  element: string;
  weapon: string;
  laserColor: string;
  playerClass?: string;
  bodyType?: string;
  weaponAssembly?: WeaponAssembly;
}

export class PlayerSprite {
  private _scene: Phaser.Scene;
  private _sprite: Phaser.GameObjects.Sprite | null = null;
  private _rect: Phaser.GameObjects.Rectangle | null = null;
  private _useSprite = false;
  readonly nameText: Phaser.GameObjects.Text;
  readonly labelText: Phaser.GameObjects.Text;
  laserColor = '#ffffff';   // updated via configure()
  private _dead = false;    // true while death anim is playing; blocks other anim updates

  // Weapon indicator — visible in ranged mode, aims at cursor, flashes on fire
  private _weaponGfx:       Phaser.GameObjects.Graphics | null = null;
  private _weaponFlashTimer = 0;   // ms > 0 while muzzle flash is active
  private static readonly WEAPON_FLASH_MS = 60;
  private _aimAngle         = 0;   // radians, set each frame by controller
  private _combatMode: 'melee' | 'ranged' = 'melee';

  // Melee weapon sprite — baked from WeaponCompositor, parked at rest or swung on attack
  private _meleeSprite:     Phaser.GameObjects.Image | null = null;
  private _meleeSwingTimer  = 0;   // ms counting down during swing (0 = resting)
  private static readonly MELEE_SWING_MS    = 350;  // matches ACTION_RELEASE_MS
  private static readonly COMPOSITE_SIZE    = 316;
  private static readonly WEAPON_DISPLAY_SCALE = 0.095; // 316 * 0.095 ≈ 30px apparent length
  // Origin X as fraction of composite width — grip anchor sits at player hand
  private static readonly WEAPON_ORIGIN_X   = WEAPON_GRIP_X / 316;

  private _keys: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
    w: Phaser.Input.Keyboard.Key;
    a: Phaser.Input.Keyboard.Key;
    s: Phaser.Input.Keyboard.Key;
    d: Phaser.Input.Keyboard.Key;
  };

  private _idleBobPhase = 0;
  private _baseY: number;
  private _moving = false;
  private _jumpOffsetY  = 0;   // visual Y lift during jump — applied to display and attachments
  private _shadowGfx:   Phaser.GameObjects.Graphics | null = null; // ground shadow while airborne
  private _facingLeft = false;
  private _currentAnim = '';
  private _animPrefix = 'player-';

  // Walk clamp — set by WorldScene after TileWorld is sealed
  private _walkBounds = { minX: 0, maxX: 2000, minY: 0, maxY: 1000 };

  // ── Combat animation state ────────────────────────────────────────────────
  // actionType: null = normal movement mode, else locked into combat animation
  private _actionType: 'melee' | 'ranged' | 'ability' | 'block' | null = null;
  private _actionHolding = false;      // true while key/button is held
  private _actionReleaseTimer = 0;     // ms until recovery frame clears
  private static readonly ACTION_RELEASE_MS = 350; // time to show recovery frame
  private _blockGfx: Phaser.GameObjects.Graphics | null = null; // guard shield indicator

  constructor(scene: Phaser.Scene, config?: PlayerConfig) {
    this._scene = scene;
    const tint = ELEMENT_TINTS[config?.element ?? 'plasma'] ?? 0xcccccc;
    const name = config?.name ?? 'PLAYER';
    const cls  = config?.playerClass ?? 'fighter';
    const body = config?.bodyType ?? 'a';
    const sheetKey = `${cls}-${body}-sheet`;

    if (scene.textures.exists(sheetKey)) {
      this._useSprite = true;
      this._sprite = scene.add.sprite(HOME_X, HOME_Y, sheetKey, F.idle_s[0])
        .setDepth(10)
        .setOrigin(0.5, 1)
        .setScale(SPRITE_SCALE)
        .setTint(tint);
      this._createAnimations(sheetKey);
    } else {
      this._rect = scene.add.rectangle(HOME_X, HOME_Y, 24, 32, tint)
        .setDepth(10)
        .setOrigin(0.5, 1);
    }

    this.nameText = scene.add.text(HOME_X, HOME_Y - 20, name, {
      fontSize: '8px', fontFamily: 'monospace',
      color: '#ffffff', stroke: '#000000', strokeThickness: 2, resolution: 4,
    }).setOrigin(0.5, 1).setDepth(11);

    this.labelText = scene.add.text(HOME_X, HOME_Y + 4, 'you', {
      fontSize: '6px', fontFamily: 'monospace',
      color: '#aaaaaa', resolution: 4,
    }).setOrigin(0.5, 0).setDepth(11);

    // Weapon indicator — a short bar drawn each frame in aim direction.
    // Hidden in melee mode; visible in ranged mode. Placeholder until real weapon sprites.
    this._weaponGfx = scene.add.graphics().setDepth(12).setVisible(false);
    // Block/parry shield indicator — visible only while blocking. Depth above player.
    this._blockGfx  = scene.add.graphics().setDepth(13).setVisible(false);
    // Jump shadow — ground-level ellipse visible only while airborne.
    this._shadowGfx = scene.add.graphics().setDepth(9).setVisible(false);

    this._baseY = HOME_Y;

    const kb = scene.input.keyboard!;
    this._keys = {
      up:    kb.addKey(Phaser.Input.Keyboard.KeyCodes.UP, false),
      down:  kb.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN, false),
      left:  kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT, false),
      right: kb.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT, false),
      w: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W, false),
      a: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A, false),
      s: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S, false),
      d: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D, false),
    };
  }

  private _createAnimations(sheetKey: string): void {
    const p = this._animPrefix;
    const scene = this._scene;
    if (scene.anims.exists(`${p}idle-s`)) return;

    const make = (key: string, frames: readonly number[], fps: number): void => {
      scene.anims.create({
        key,
        frames: frames.map(f => ({ key: sheetKey, frame: f })),
        frameRate: fps,
        repeat: -1,
      });
    };

    make(`${p}idle-s`,  F.idle_s,  ANIM_FPS_IDLE);
    make(`${p}idle-e`,  F.idle_e,  ANIM_FPS_IDLE);

    // Death — 2 frames, plays once, holds on final frame
    scene.anims.create({
      key:       `${p}die`,
      frames:    F.die.map(f => ({ key: sheetKey, frame: f })),
      frameRate: 6,
      repeat:    0,
    });
    make(`${p}walk-s`,  F.walk_s,  ANIM_FPS_WALK);
    make(`${p}walk-se`, F.walk_se, ANIM_FPS_WALK);
    make(`${p}walk-e`,  F.walk_e,  ANIM_FPS_WALK);
    make(`${p}walk-ne`, F.walk_ne, ANIM_FPS_WALK);
    make(`${p}walk-n`,  F.walk_n,  ANIM_FPS_WALK);

    // Combat animations — direction suffix matches walk directions
    const dirs = ['s','se','e','ne','n'] as const;
    for (const dir of dirs) {
      const mf = F[`melee_${dir}` as keyof typeof F] as readonly number[];
      const rf = F[`range_${dir}` as keyof typeof F] as readonly number[];
      const af = F[`abil_${dir}`  as keyof typeof F] as readonly number[];
      // Melee loop: frames 0-2 only (frame 3 is recovery, played separately)
      scene.anims.create({ key: `${p}melee-loop-${dir}`, frames: mf.slice(0,3).map(f=>({key:sheetKey,frame:f})), frameRate: ANIM_FPS_COMBAT, repeat: -1 });
      // Melee recovery: frame 3 once
      scene.anims.create({ key: `${p}melee-end-${dir}`,  frames: [{key:sheetKey,frame:mf[3]}], frameRate: ANIM_FPS_COMBAT, repeat: 0 });
      // Ranged aim: frame 0 once
      scene.anims.create({ key: `${p}range-aim-${dir}`,  frames: [{key:sheetKey,frame:rf[0]}], frameRate: ANIM_FPS_COMBAT, repeat: 0 });
      // Ranged loop: frames 1-2 while holding
      scene.anims.create({ key: `${p}range-loop-${dir}`, frames: rf.slice(1,3).map(f=>({key:sheetKey,frame:f})), frameRate: ANIM_FPS_COMBAT, repeat: -1 });
      // Ranged recovery: frame 3 once
      scene.anims.create({ key: `${p}range-end-${dir}`,  frames: [{key:sheetKey,frame:rf[3]}], frameRate: ANIM_FPS_COMBAT, repeat: 0 });
      // Ability: all 4 frames once
      scene.anims.create({ key: `${p}abil-${dir}`,       frames: af.map(f=>({key:sheetKey,frame:f})), frameRate: ANIM_FPS_COMBAT, repeat: 0 });
    }
  }

  private get _display(): Phaser.GameObjects.Sprite | Phaser.GameObjects.Rectangle {
    return (this._useSprite ? this._sprite : this._rect)!;
  }

  /**
   * Begin a combat action animation. Call from BattleOverlay/combat system.
   * holding=true means the button is held (ranged loops frames 1-2).
   * Call releaseAction() when button released.
   */
  startAction(type: 'melee' | 'ranged' | 'ability' | 'block'): void {
    if (this._dead) return;
    this._actionType = type;
    this._actionHolding = true;
    this._actionReleaseTimer = 0;
    // Trigger muzzle flash on ranged fire
    if (type === 'ranged') {
      this._weaponFlashTimer = PlayerSprite.WEAPON_FLASH_MS;
    }
    // Reset swing timer so each melee strike starts its arc from the beginning
    if (type === 'melee') {
      this._meleeSwingTimer = 0;
    }
    // Block: show shield indicator, suppress movement lock (handled externally)
    if (type === 'block') {
      this._blockGfx?.setVisible(true);
      return; // no sprite animation for block yet
    }
    if (!this._useSprite || !this._sprite) return;
    const dir = this._facingLeft ? 'e' : 's'; // simplified: use last walk direction
    const p = this._animPrefix;
    if (type === 'melee') {
      this._sprite.play(`${p}melee-loop-${dir}`, true);
      this._currentAnim = `${p}melee-loop-${dir}`;
    } else if (type === 'ranged') {
      this._sprite.play(`${p}range-aim-${dir}`, true);
      this._currentAnim = `${p}range-aim-${dir}`;
      // Transition to loop after aim frame completes
      this._sprite.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => {
        if (this._actionHolding && this._actionType === 'ranged' && this._sprite) {
          this._sprite.play(`${p}range-loop-${dir}`, true);
          this._currentAnim = `${p}range-loop-${dir}`;
        }
      });
    } else {
      this._sprite.play(`${p}abil-${dir}`, true);
      this._currentAnim = `${p}abil-${dir}`;
      this._sprite.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => {
        this._actionType = null;
      });
    }
  }

  /**
   * Release a held combat action. Shows recovery frame, then returns to idle.
   */
  releaseAction(): void {
    if (!this._actionType || this._actionType === 'ability') return;
    if (this._actionType === 'block') {
      // Block is held externally — stopBlock() handles cleanup
      return;
    }
    this._actionHolding = false;
    this._actionReleaseTimer = PlayerSprite.ACTION_RELEASE_MS;
    if (!this._useSprite || !this._sprite) return;
    const dir = this._facingLeft ? 'e' : 's';
    const p = this._animPrefix;
    const endAnim = `${p}${this._actionType}-end-${dir}`;
    if (this._scene.anims.exists(endAnim)) {
      this._sprite.play(endAnim, true);
      this._currentAnim = endAnim;
    }
  }

  /** Call when RMB is released to clear the block state and hide the shield. */
  stopBlock(): void {
    if (this._actionType !== 'block') return;
    this._actionType    = null;
    this._actionHolding = false;
    this._blockGfx?.setVisible(false);
  }

  update(delta: number, inputEnabled: boolean): void {
    if (this._dead) return; // hold on death frame; position locked by WorldScene
    const dt = delta / 16.667;
    const display = this._display;

    // Tick release timer — clears action lock after recovery frame
    if (!this._actionHolding && this._actionReleaseTimer > 0) {
      this._actionReleaseTimer -= delta;
      if (this._actionReleaseTimer <= 0) {
        this._actionType = null;
        this._actionReleaseTimer = 0;
      }
    }

    // Block/parry shield indicator — arc drawn in front of player while blocking
    if (this._blockGfx && this._actionType === 'block') {
      const shieldSide = this._facingLeft ? -1 : 1;
      const ox = display.x + shieldSide * 10;
      const oy = display.y - 6;
      this._blockGfx
        .clear()
        .setPosition(0, 0)
        .setVisible(true)
        .lineStyle(3, 0x88ccff, 0.85)
        .beginPath()
        .arc(ox, oy, 12, -Math.PI * 0.6, Math.PI * 0.6, false)
        .strokePath();
    }

    // Weapon indicator — drawn every frame in ranged mode
    if (this._weaponGfx && this._combatMode === 'ranged') {
      if (this._weaponFlashTimer > 0) this._weaponFlashTimer -= delta;
      const flashing = this._weaponFlashTimer > 0;
      const baseColor = Phaser.Display.Color.HexStringToColor(this.laserColor).color;
      const barColor  = flashing ? 0xffffff : baseColor;
      const alpha     = flashing ? 1.0 : 0.75;
      // Short stock bar close to body, then a longer barrel
      const ox = display.x;
      const oy = display.y - 10; // offset up to waist height
      const cos = Math.cos(this._aimAngle);
      const sin = Math.sin(this._aimAngle);
      this._weaponGfx
        .clear()
        .setDepth(display.depth + 2)
        // Barrel: 14px long, 2px wide
        .lineStyle(2, barColor, alpha)
        .beginPath()
        .moveTo(ox + cos * 4,  oy + sin * 4)
        .lineTo(ox + cos * 18, oy + sin * 18)
        .strokePath()
        // Muzzle dot
        .fillStyle(flashing ? 0xffffff : baseColor, alpha)
        .fillCircle(ox + cos * 18, oy + sin * 18, flashing ? 3.5 : 1.5);
    }

    // Melee weapon sprite — position sync + swing arc
    if (this._meleeSprite && this._combatMode === 'melee') {
      const wx = display.x;
      const wy = display.y - 8; // hold at waist height

      if (this._actionType === 'melee') {
        // Swing arc: progress from 0→1 over MELEE_SWING_MS, angle sweeps -1.2 → +1.2 rad
        this._meleeSwingTimer += delta;
        const progress = Math.min(this._meleeSwingTimer / PlayerSprite.MELEE_SWING_MS, 1);
        // Ease in-out for snap feel: sin curve through arc
        const arc = Math.sin(progress * Math.PI);
        // Face direction: right = positive angles, left = negative base
        const baseAngle = this._facingLeft ? Math.PI : 0;
        const swingOffset = (this._facingLeft ? -1 : 1) * (arc * 2.4 - 1.2);
        this._meleeSprite
          .setPosition(wx, wy)
          .setAngle((baseAngle + swingOffset) * (180 / Math.PI))
          .setDepth(display.depth + 1)
          .setAlpha(1);
      } else {
        // Rest pose: weapon held at dominant side, slightly angled downward
        this._meleeSwingTimer = 0;
        const restAngle = this._facingLeft ? 200 : -20; // degrees: tilted away from body
        this._meleeSprite
          .setPosition(wx, wy)
          .setAngle(restAngle)
          .setDepth(display.depth + 1)
          .setAlpha(0.9);
      }
    }

    // While in action animation, suppress movement input but update position labels
    if (this._actionType) {
      this.nameText.x = display.x;
      this.nameText.y = display.y - 20;
      this.labelText.x = display.x;
      this.labelText.y = display.y + 4;
      return;
    }

    let dx = 0;
    let dy = 0;
    if (inputEnabled) {
      if (this._keys.left.isDown  || this._keys.a.isDown) dx -= 1;
      if (this._keys.right.isDown || this._keys.d.isDown) dx += 1;
      if (this._keys.up.isDown    || this._keys.w.isDown) dy -= 1;
      if (this._keys.down.isDown  || this._keys.s.isDown) dy += 1;
    }

    this._moving = dx !== 0 || dy !== 0;

    if (this._moving) {
      const len  = Math.sqrt(dx * dx + dy * dy);
      const step = MOVE_SPEED * dt;
      const prevX = display.x;
      const prevY = display.y;
      display.x += (dx / len) * step;
      display.y += (dy / len) * step;
      display.x = Math.max(this._walkBounds.minX, Math.min(this._walkBounds.maxX, display.x));
      display.y = Math.max(this._walkBounds.minY, Math.min(this._walkBounds.maxY, display.y));
      // Reject move if it lands on a void tile — try axis-separated fallback
      // before fully blocking (allows sliding along zone edges).
      if (!TileWorld.getInstance().isWalkable(display.x, display.y)) {
        // Try X only
        display.x = prevX + (dx / len) * step;
        display.x = Math.max(this._walkBounds.minX, Math.min(this._walkBounds.maxX, display.x));
        display.y = prevY;
        if (!TileWorld.getInstance().isWalkable(display.x, display.y)) {
          // Try Y only
          display.x = prevX;
          display.y = prevY + (dy / len) * step;
          display.y = Math.max(this._walkBounds.minY, Math.min(this._walkBounds.maxY, display.y));
          if (!TileWorld.getInstance().isWalkable(display.x, display.y)) {
            // Fully blocked — restore
            display.x = prevX;
            display.y = prevY;
          }
        }
      }
      this._baseY = display.y;
      if (this._useSprite && this._sprite) this._pickWalkAnim(dx, dy);
    } else {
      if (this._useSprite && this._sprite) {
        this._pickIdleAnim();
      } else {
        this._idleBobPhase += 0.03 * dt;
        display.y = this._baseY + Math.sin(this._idleBobPhase) * 1.5;
      }
    }

    this.nameText.x  = display.x;
    this.nameText.y  = this._baseY - 20 + this._jumpOffsetY;
    this.labelText.x = display.x;
    this.labelText.y = this._baseY + 4  + this._jumpOffsetY;

    // Apply jump visual offset — absolute from _baseY so it never drifts.
    // Suppresses idle bob while airborne.
    if (this._jumpOffsetY !== 0) {
      display.setY(this._baseY + this._jumpOffsetY);
      if (this._meleeSprite) this._meleeSprite.setY(this._baseY + this._jumpOffsetY - 8);
      // Shadow stays at ground level and shrinks as height increases
      if (this._shadowGfx) {
        const lift  = Math.abs(this._jumpOffsetY);
        const scale = Math.max(0.3, 1 - lift / 40); // shrinks to 0.3 at peak (~40px)
        this._shadowGfx
          .clear()
          .setVisible(true)
          .setPosition(display.x, this._baseY)
          .fillStyle(0x000000, 0.25 * scale)
          .fillEllipse(0, 0, 18 * scale, 8 * scale);
      }
    } else if (this._shadowGfx?.visible) {
      this._shadowGfx.setVisible(false);
    }
  }

  private _pickWalkAnim(dx: number, dy: number): void {
    const sprite = this._sprite!;
    const p = this._animPrefix;
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    let anim: string;
    let flip = false;

    if      (angle > 157.5 || angle <= -157.5) { anim = `${p}walk-e`;  flip = true;  }
    else if (angle > 112.5)                     { anim = `${p}walk-ne`; flip = true;  }
    else if (angle > 67.5)                      { anim = `${p}walk-s`;  flip = false; }
    else if (angle > 22.5)                      { anim = `${p}walk-se`; flip = false; }
    else if (angle > -22.5)                     { anim = `${p}walk-e`;  flip = false; }
    else if (angle > -67.5)                     { anim = `${p}walk-ne`; flip = false; }
    else if (angle > -112.5)                    { anim = `${p}walk-n`;  flip = false; }
    else                                        { anim = `${p}walk-ne`; flip = true;  }

    this._facingLeft = flip;
    sprite.setFlipX(flip);
    if (this._currentAnim !== anim) {
      this._currentAnim = anim;
      sprite.play(anim, true);
    }
  }

  private _pickIdleAnim(): void {
    const sprite = this._sprite!;
    const p = this._animPrefix;
    const anim = this._facingLeft ? `${p}idle-e` : `${p}idle-s`;
    sprite.setFlipX(this._facingLeft);
    if (this._currentAnim !== anim) {
      this._currentAnim = anim;
      sprite.play(anim, true);
    }
  }

  get x(): number { return this._display.x; }
  get y(): number { return this._display.y; }

  /** The underlying Phaser display object — used for camera.startFollow(). */
  get displayObject(): Phaser.GameObjects.Sprite | Phaser.GameObjects.Rectangle {
    return this._display;
  }

  setAlpha(value: number): void {
    this._display.setAlpha(value);
  }

  setPosition(x: number, y: number): void {
    this._display.setPosition(x, y);
    this.nameText.x  = x;
    this.nameText.y  = y - 20;
    this.labelText.x = x;
    this.labelText.y = y + 4;
  }

  /** Called by WorldScene after TileWorld is sealed. Replaces hardcoded clamp. */
  setWalkBounds(b: { minX: number; maxX: number; minY: number; maxY: number }): void {
    this._walkBounds.minX = b.minX;
    this._walkBounds.maxX = b.maxX;
    this._walkBounds.minY = b.minY;
    this._walkBounds.maxY = b.maxY;
  }

  /**
   * Set the visual Y lift for the jump arc (negative = up in screen space).
   * The display and all attachments shift by this amount each frame.
   * Pass 0 when grounded.
   */
  setJumpOffset(dy: number): void {
    this._jumpOffsetY = dy;
  }

  /**
   * so the weapon indicator renders correctly without the controller needing
   * to reach into PlayerSprite's internals.
   */
  setAimAngle(angle: number): void { this._aimAngle = angle; }
  setCombatMode(mode: 'melee' | 'ranged'): void {
    this._combatMode = mode;
    if (this._weaponGfx) {
      this._weaponGfx.setVisible(mode === 'ranged');
    }
    if (this._meleeSprite) {
      this._meleeSprite.setVisible(mode === 'melee');
    }
  }

  /**
   * Hot-swap the melee weapon sprite without a full configure() call.
   * Called by the scene when equipment changes. Pass null to remove the sprite.
   */
  setWeaponAssembly(assembly: WeaponAssembly | null): void {
    if (this._meleeSprite) {
      this._meleeSprite.destroy();
      this._meleeSprite = null;
    }
    if (assembly) {
      const texKey = bakeWeaponComposite(this._scene, assembly);
      const display = this._display;
      this._meleeSprite = this._scene.add.image(display.x, display.y, texKey)
        .setOrigin(PlayerSprite.WEAPON_ORIGIN_X, 0.5)
        .setScale(PlayerSprite.WEAPON_DISPLAY_SCALE)
        .setDepth(display.depth + 1)
        .setVisible(this._combatMode === 'melee');
    }
  }

  configure(config: PlayerConfig): void {
    const tint = ELEMENT_TINTS[config.element] ?? 0xcccccc;
    this.nameText.setText(config.name || 'PLAYER');
    this.laserColor = config.laserColor;
    if (this._useSprite && this._sprite) {
      this._sprite.setTint(tint);
    } else if (this._rect) {
      this._rect.setFillStyle(tint);
    }

    // Bake and attach melee weapon sprite. Always creates one — uses provided
    // assembly or falls back to a neutral grey placeholder so the weapon is
    // always visible regardless of equipment state.
    if (this._meleeSprite) {
      this._meleeSprite.destroy();
      this._meleeSprite = null;
    }
    const assembly = config.weaponAssembly ?? {
      parts: [
        { category: 'head',  variantId: 'default', tint: '#aaaaaa' },
        { category: 'shaft', variantId: 'default', tint: '#888888' },
        { category: 'grip',  variantId: 'default', tint: '#664422' },
      ],
      compositeKey: 'weapon-composite-default',
    };
    const texKey = bakeWeaponComposite(this._scene, assembly);
    const display = this._display;
    this._meleeSprite = this._scene.add.image(display.x, display.y, texKey)
      .setOrigin(PlayerSprite.WEAPON_ORIGIN_X, 0.5)
      .setScale(PlayerSprite.WEAPON_DISPLAY_SCALE)
      .setDepth(display.depth + 1)
      .setVisible(this._combatMode === 'melee');
  }

  /**
   * Lock the sprite into the death animation. Blocks all further anim/movement
   * updates until resetFromDeath() is called. Safe to call on rect fallback —
   * plays a fade tween instead.
   */
  playDie(): void {
    if (this._dead) return;
    this._dead = true;
    if (this._useSprite && this._sprite) {
      this._sprite.play(`${this._animPrefix}die`);
    } else if (this._rect) {
      // Rect fallback: tween to half alpha to signal death
      this._scene.tweens.add({
        targets: this._rect, alpha: 0.3, duration: 300, ease: 'Quad.easeOut',
      });
    }
  }

  /**
   * Clear the dead flag and restore full alpha after respawn teleport.
   * Caller is responsible for repositioning before calling this.
   */
  resetFromDeath(): void {
    this._dead = false;
    if (this._useSprite && this._sprite) {
      this._sprite.play(`${this._animPrefix}idle-s`);
    } else if (this._rect) {
      this._rect.setAlpha(1);
    }
  }

  swapSpriteSheet(cls: string, body: string, element: string): void {
    const sheetKey = `${cls}-${body}-sheet`;
    const tint = ELEMENT_TINTS[element] ?? 0xcccccc;
    if (!this._scene.textures.exists(sheetKey)) return;

    const p = this._animPrefix;
    const dirs = ['s', 'se', 'e', 'ne', 'n'] as const;
    const animKeys: string[] = [
      'idle-s', 'idle-e', 'walk-s', 'walk-se', 'walk-e', 'walk-ne', 'walk-n', 'die',
    ];
    for (const dir of dirs) {
      for (const pfx of ['melee-loop-', 'melee-end-', 'range-aim-', 'range-loop-', 'range-end-', 'abil-']) {
        animKeys.push(`${pfx}${dir}`);
      }
    }
    for (const k of animKeys) {
      const key = `${p}${k}`;
      if (this._scene.anims.exists(key)) this._scene.anims.remove(key);
    }

    if (!this._useSprite) {
      if (this._rect) {
        const rx = this._rect.x;
        const ry = this._rect.y;
        this._rect.destroy();
        this._rect = null;
        this._sprite = this._scene.add.sprite(rx, ry, sheetKey, F.idle_s[0])
          .setDepth(10)
          .setOrigin(0.5, 1)
          .setScale(SPRITE_SCALE)
          .setTint(tint);
      }
      this._useSprite = true;
    } else if (this._sprite) {
      this._sprite.setTexture(sheetKey, F.idle_s[0]);
      this._sprite.setTint(tint);
    }

    this._currentAnim = '';
    this._createAnimations(sheetKey);
  }
}
