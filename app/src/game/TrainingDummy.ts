/**
 * TrainingDummy — Permanent interactive training target in the hub.
 *
 * Placed at tile (33, 23) in the player zone — a clear open spot visible
 * from the player home position. Uses the moon-tileset tile frames to build
 * the dummy visually (post + base shape from existing atlas).
 *
 * Interactions:
 *   R key (when player within 40px) — cycle element type
 *   Receives damage from PlayerCombatController.attack()
 *
 * Displays:
 *   - Health bar above the dummy (always visible)
 *   - Damage numbers via spawnFloatText-style tweens
 *   - Element label showing current element
 *   - Auto-resets HP to max after 3 seconds of no damage
 *
 * Element cycling changes the tint and the elemental resist of the dummy,
 * making it useful for testing element-specific builds.
 */

import * as Phaser from 'phaser';
import type { ElementType } from './PlayerClasses';

// Element tints matching the game palette
const ELEMENT_TINTS: Record<ElementType, number> = {
  plasma:    0xc080ff,
  fire:      0xff6020,
  ice:       0x60d0ff,
  lightning: 0xffe040,
  void:      0x8040c0,
};

const ELEMENT_ORDER: ElementType[] = ['plasma', 'fire', 'ice', 'lightning', 'void'];

const MAX_HP = 200;
const RESET_DELAY_MS = 3000;

export class TrainingDummy {
  private _scene: Phaser.Scene;
  private _x: number;
  private _y: number;

  // Visual objects
  private _base:     Phaser.GameObjects.Image;
  private _post:     Phaser.GameObjects.Image;
  private _face:     Phaser.GameObjects.Arc;
  private _barBg:    Phaser.GameObjects.Rectangle;
  private _barFill:  Phaser.GameObjects.Rectangle;
  private _label:    Phaser.GameObjects.Text;
  private _elemText: Phaser.GameObjects.Text;
  private _interactHint: Phaser.GameObjects.Text;

  // State
  private _hp = MAX_HP;
  private _elementIdx = 0;
  private _resetTimer = 0;
  private _takingDamage = false;
  private _shakeTween: Phaser.Tweens.Tween | null = null;

  constructor(scene: Phaser.Scene, worldX: number, worldY: number) {
    this._scene = scene;
    this._x = worldX;
    this._y = worldY;

    // ── Visual construction ────────────────────────────────────────────────
    // Base — wide flat tile
    this._base = scene.add.image(worldX, worldY + 4, 'moon-tiles', 7)
      .setDepth(9)
      .setOrigin(0.5, 0.5)
      .setTint(0x888888)
      .setScale(0.9);

    // Post body — vertical tile
    this._post = scene.add.image(worldX, worldY - 4, 'moon-tiles', 28)
      .setDepth(10)
      .setOrigin(0.5, 0.5)
      .setTint(0xa0a0a0)
      .setScale(0.7);

    // Face — coloured circle indicating element
    this._face = scene.add.arc(worldX, worldY - 14, 6, 0, 360, false, 0xc080ff, 1)
      .setDepth(11);

    // Health bar background
    this._barBg = scene.add.rectangle(worldX, worldY - 26, 32, 4, 0x000000, 0.7)
      .setDepth(12)
      .setOrigin(0.5, 0.5);

    // Health bar fill
    this._barFill = scene.add.rectangle(worldX - 16, worldY - 26, 32, 4, 0x44ff44, 1)
      .setDepth(13)
      .setOrigin(0, 0.5);

    // Name label
    this._label = scene.add.text(worldX, worldY - 32, 'TRAINING DUMMY', {
      fontSize: '5px', fontFamily: 'monospace',
      color: '#cccccc', stroke: '#000000', strokeThickness: 1, resolution: 4,
    }).setOrigin(0.5, 1).setDepth(12);

    // Element indicator
    this._elemText = scene.add.text(worldX, worldY - 20, 'PLASMA', {
      fontSize: '4px', fontFamily: 'monospace',
      color: '#c080ff', stroke: '#000000', strokeThickness: 1, resolution: 4,
    }).setOrigin(0.5, 0.5).setDepth(12);

    // Interact hint (shown when player is nearby)
    this._interactHint = scene.add.text(worldX, worldY - 40, '[R] CHANGE ELEMENT', {
      fontSize: '4px', fontFamily: 'monospace',
      color: '#ffffff', stroke: '#000000', strokeThickness: 1, resolution: 4,
    }).setOrigin(0.5, 1).setDepth(12).setAlpha(0);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  get x(): number { return this._x; }
  get y(): number { return this._y; }
  get element(): ElementType { return ELEMENT_ORDER[this._elementIdx]; }

  /**
   * Apply damage to the dummy. Spawns a floating damage number.
   * Returns the element for hit-effect colour lookup.
   */
  takeDamage(amount: number, isCrit = false): ElementType {
    this._hp = Math.max(0, this._hp - amount);
    this._resetTimer = 0;
    this._takingDamage = true;

    this._updateHealthBar();
    this._spawnDamageNumber(amount, isCrit);
    this._shakePost();

    if (this._hp === 0) {
      // Flash and start reset cycle
      this._scene.tweens.add({
        targets: [this._post, this._face],
        alpha: { from: 0.3, to: 1.0 },
        duration: 150,
        yoyo: true,
        repeat: 2,
      });
    }

    return this.element;
  }

  /**
   * Cycle to the next element. Called on R-key interact.
   */
  cycleElement(): void {
    this._elementIdx = (this._elementIdx + 1) % ELEMENT_ORDER.length;
    const el = this.element;
    const tint = ELEMENT_TINTS[el];

    this._face.setFillStyle(tint);
    this._elemText.setStyle({ color: '#' + tint.toString(16).padStart(6, '0') });
    this._elemText.setText(el.toUpperCase());

    // Bounce animation
    this._scene.tweens.add({
      targets: this._face,
      scaleX: { from: 1.5, to: 1.0 },
      scaleY: { from: 1.5, to: 1.0 },
      duration: 200,
      ease: 'Back.easeOut',
    });

    // Float text showing new element
    this._spawnLabel(el.toUpperCase(), tint);
  }

  /**
   * Show/hide the interact hint based on player proximity.
   */
  setPlayerNearby(nearby: boolean): void {
    this._scene.tweens.add({
      targets: this._interactHint,
      alpha: nearby ? 0.85 : 0,
      duration: 200,
    });
  }

  /**
   * Called from WorldScene.update() each frame.
   */
  update(delta: number): void {
    if (this._takingDamage) {
      this._resetTimer += delta;
      if (this._resetTimer >= RESET_DELAY_MS) {
        this._takingDamage = false;
        this._resetTimer = 0;
        this._resetHp();
      }
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _updateHealthBar(): void {
    const pct = this._hp / MAX_HP;
    const fullW = 32;
    this._barFill.setSize(fullW * pct, 4);
    const col = pct > 0.5 ? 0x44ff44 : pct > 0.25 ? 0xffaa00 : 0xff3333;
    this._barFill.setFillStyle(col);
  }

  private _resetHp(): void {
    this._hp = MAX_HP;
    this._updateHealthBar();
    // Gentle flash on reset
    this._scene.tweens.add({
      targets: [this._post, this._face],
      alpha: { from: 0.5, to: 1.0 },
      duration: 400,
      ease: 'Quad.easeOut',
    });
    this._spawnLabel('RESET', 0x44ff44);
  }

  private _spawnDamageNumber(amount: number, isCrit: boolean): void {
    const offsetX = (Math.random() - 0.5) * 16;
    const color = isCrit ? '#ff4444' : '#ffffff';
    const size = isCrit ? '10px' : '7px';
    const text = isCrit ? `${amount}!` : `${amount}`;

    const t = this._scene.add.text(
      this._x + offsetX,
      this._y - 20,
      text,
      {
        fontSize: size,
        fontFamily: 'monospace',
        color,
        stroke: '#000000',
        strokeThickness: isCrit ? 2 : 1,
        resolution: 4,
      }
    ).setOrigin(0.5, 1).setDepth(20);

    this._scene.tweens.add({
      targets: t,
      y: this._y - 44,
      alpha: { from: 1, to: 0 },
      duration: isCrit ? 900 : 650,
      ease: 'Quad.easeOut',
      onComplete: () => t.destroy(),
    });
  }

  private _spawnLabel(text: string, color: number): void {
    const hex = '#' + color.toString(16).padStart(6, '0');
    const t = this._scene.add.text(this._x, this._y - 44, text, {
      fontSize: '6px', fontFamily: 'monospace',
      color: hex, stroke: '#000000', strokeThickness: 1, resolution: 4,
    }).setOrigin(0.5, 1).setDepth(20);

    this._scene.tweens.add({
      targets: t,
      y: this._y - 62,
      alpha: { from: 1, to: 0 },
      duration: 800,
      ease: 'Quad.easeOut',
      onComplete: () => t.destroy(),
    });
  }

  private _shakePost(): void {
    if (this._shakeTween?.isPlaying()) return;
    this._shakeTween = this._scene.tweens.add({
      targets: this._post,
      x: { from: this._x - 2, to: this._x + 2 },
      duration: 50,
      yoyo: true,
      repeat: 2,
      onComplete: () => { this._post.x = this._x; },
    });
  }
}
