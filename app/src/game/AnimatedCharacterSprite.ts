/**
 * AnimatedCharacterSprite — NPC persona sprite with full 12×12 animation grid.
 *
 * Sheet format: 633×633 px frames, 12 columns × 12 rows (7596×7596 px sheet).
 * Display scale: setScale(0.125) → 633 native ≈ 79px on screen.
 *
 * Frame index map (row * 12 + col, 0-indexed):
 *   Row  0 (  0– 11): walk_s[0-3]    | jump_s[4-7]     | roll_s[8-11]
 *   Row  1 ( 12– 23): walk_se[12-15] | jump_se[16-19]  | roll_se[20-23]
 *   Row  2 ( 24– 35): walk_e[24-27]  | jump_e[28-31]   | roll_e[32-35]
 *   Row  3 ( 36– 47): walk_ne[36-39] | jump_ne[40-43]  | roll_ne[44-47]
 *   Row  4 ( 48– 59): walk_n[48-51]  | jump_n[52-55]   | roll_n[56-59]
 *   Row  5 ( 60– 71): melee_s[60-63] | range_s[64-67]  | abil_s[68-71]
 *   Row  6 ( 72– 83): melee_se[72-75]| range_se[76-79] | abil_se[80-83]
 *   Row  7 ( 84– 95): melee_e[84-87] | range_e[88-91]  | abil_e[92-95]
 *   Row  8 ( 96–107): melee_ne[96-99]| range_ne[100-103]|abil_ne[104-107]
 *   Row  9 (108–119): melee_n[108-111]|range_n[112-115] |abil_n[116-119]
 *   Row 10 (120–131): idle_s[120-123]| idle_e[124-127] | sit[128-131]
 *   Row 11 (132–143): par_s=132 par_se=133 par_e=134 par_ne=135 par_n=136
 *                     dmg_s=137 dmg_se=138 dmg_e=139 dmg_ne=140 dmg_n=141
 *                     spare=142,143
 *
 * NPC-exclusive action sheet (4×4 grid, 633×633 frames):
 *   Frames 0-3:   work1 (intense concentration)
 *   Frames 4-7:   work2 (general activity)
 *   Frames 8-11:  work3 (reviewing/triaging)
 *   Frames 12-15: carry (2 frames per cardinal for carry-walk)
 */

import * as Phaser from 'phaser';
import type { PersonaName } from './GameStore';

// ── Frame index constants (12-column grid) ───────────────────────────────────

const F = {
  walk_s:   [0,  1,  2,  3],   jump_s:  [4,  5,  6,  7],   roll_s:  [8,  9,  10, 11],
  walk_se:  [12, 13, 14, 15],  jump_se: [16, 17, 18, 19],  roll_se: [20, 21, 22, 23],
  walk_e:   [24, 25, 26, 27],  jump_e:  [28, 29, 30, 31],  roll_e:  [32, 33, 34, 35],
  walk_ne:  [36, 37, 38, 39],  jump_ne: [40, 41, 42, 43],  roll_ne: [44, 45, 46, 47],
  walk_n:   [48, 49, 50, 51],  jump_n:  [52, 53, 54, 55],  roll_n:  [56, 57, 58, 59],
  melee_s:  [60, 61, 62, 63],  range_s: [64, 65, 66, 67],  abil_s:  [68, 69, 70, 71],
  melee_se: [72, 73, 74, 75],  range_se:[76, 77, 78, 79],  abil_se: [80, 81, 82, 83],
  melee_e:  [84, 85, 86, 87],  range_e: [88, 89, 90, 91],  abil_e:  [92, 93, 94, 95],
  melee_ne: [96, 97, 98, 99],  range_ne:[100,101,102,103], abil_ne: [104,105,106,107],
  melee_n:  [108,109,110,111], range_n: [112,113,114,115], abil_n:  [116,117,118,119],
  idle_s:   [120,121,122,123], idle_e:  [124,125,126,127], sit:     [128,129,130,131],
  // Single-frame entries
  par_s: 132, par_se: 133, par_e: 134, par_ne: 135, par_n: 136,
  dmg_s: 137, dmg_se: 138, dmg_e: 139, dmg_ne: 140, dmg_n: 141,
} as const;

// Action sheet (4-column grid)
const FA = {
  work1: [0,  1,  2,  3],
  work2: [4,  5,  6,  7],
  work3: [8,  9,  10, 11],
  carry: [12, 13, 14, 15],
} as const;

// ── Zone/waypoint data ───────────────────────────────────────────────────────

const ZONE_CENTERS: Record<PersonaName | 'player', { x: number; y: number }> = {
  sayon:  { x: 320, y: 272 },  // tile (13,21) — sayon zone centre
  seren:  { x: 848, y: 296 },  // tile (31,6)  — seren zone centre
  sybil:  { x: 464, y: 104 },  // tile (7,6)   — sybil zone centre
  player: { x: 608, y: 416 },  // tile (31,21) — player zone centre
};

const WAYPOINTS: Record<PersonaName, Array<{ x: number; y: number; label: string }>> = {
  sayon: [
    { x: 320, y: 288, label: 'dispatch_desk'  },  // 0 — tile (14,22) idle home
    { x: 336, y: 248, label: 'relay_tower'    },  // 1 — tile (12,19)
    { x: 384, y: 288, label: 'message_board'  },  // 2 — tile (16,20)
    { x: 448, y: 288, label: 'plaza_edge'     },  // 3 — tile (18,18) plaza approach
    { x: 192, y: 256, label: 'west_patrol'    },  // 4 — tile (8,24)
  ],
  seren: [
    { x: 832, y: 256, label: 'desk'           },  // 0 — tile (28,4)  idle home / most work
    { x: 896, y: 320, label: 'thought_chamber'},  // 1 — tile (34,6)  deep thinking
    { x: 768, y: 288, label: 'telescope'      },  // 2 — tile (28,8)  composing / error
    { x: 864, y: 368, label: 'plaza_edge'     },  // 3 — tile (36,10) safe fallback
  ],
  sybil: [
    { x: 416, y: 144, label: 'catalogue_table'},  // 0 — tile (8,10)  idle home / writing
    { x: 448, y:  64, label: 'archive_mound'  },  // 1 — tile (4,4)   startup
    { x: 512, y: 160, label: 'scroll_rack'    },  // 2 — tile (12,8)  retrieving_memory
    { x: 352, y: 112, label: 'index_node'     },  // 3 — tile (4,10)  embedding / searching
    { x: 576, y: 128, label: 'east_archive'   },  // 4 — tile (12,4)  safe fallback
  ],
};

const STATE_TARGETS: Record<string, Record<string, number>> = {
  sayon: {
    idle: 0, classifying_intent: 2, triaging_files: 0, assembling_context: 4,
    coordinating: 1, reviewing_output: 0, delivering_result: 3, copilot_active: 2, error_state: 1,
  },
  seren: {
    idle: 0, decomposing_tasks: 0, deep_thinking: 1, writing_code: 0,
    validating_output: 0, composing_delivery: 0, copilot_active: 0, extended_thinking: 1, error_state: 2,
  },
  sybil: {
    idle: 0, embedding: 3, searching: 3, retrieving_memory: 2,
    writing_memory: 0, startup: 1, offline: 0,
  },
};

// States that drive action-sheet animations instead of idle
const ACTION_STATES: Record<string, string> = {
  reviewing_output:  'work2',
  writing_code:      'work1',
  composing_delivery:'work2',
  copilot_active:    'work2',
  deep_thinking:     'sit',
  extended_thinking: 'sit',
  embedding:         'work3',
  writing_memory:    'work1',
  searching:         'work3',
  retrieving_memory: 'work2',
};

const ACCENT_COLORS: Record<PersonaName, number> = {
  sayon: 0xf59e0b,
  seren: 0x3b82f6,
  sybil: 0x8b5cf6,
};

// 633px native → 0.125 scale ≈ 79px display
const SPRITE_SCALE = 0.125;

const ANIM_FPS_IDLE_DEFAULT = 4;
const ANIM_FPS_IDLE: Record<string, number> = { sayon: 0.5, seren: 0.5, sybil: 0.5 };
const ANIM_FPS_WALK = 8;
const ANIM_FPS_WORK = 6;

export class AnimatedCharacterSprite {
  readonly persona: PersonaName;
  readonly nameText: Phaser.GameObjects.Text;
  readonly stateText: Phaser.GameObjects.Text;

  private _sprite: Phaser.GameObjects.Sprite | null = null;
  private _rect: Phaser.GameObjects.Rectangle | null = null;
  private _useSprite = false;

  private _currentState = 'idle';
  private _currentAnim = '';
  private _targetX: number;
  private _targetY: number;
  private _moveSpeed = 1.5;
  private _idleBobPhase = 0;
  private _baseY: number;
  private _facingLeft = false;

  // Hysteresis thresholds — prevents walk↔idle flicker when the hub target
  // moves slowly (e.g. ally AI drifting toward player each frame).
  private _isWalking = false;
  private static readonly WALK_START_DIST = 3.5;  // px — idle→walk
  private static readonly WALK_STOP_DIST  = 1.0;  // px — walk→idle

  constructor(scene: Phaser.Scene, persona: PersonaName) {
    this.persona = persona;
    const center = ZONE_CENTERS[persona];
    const color = ACCENT_COLORS[persona];
    const sheetKey = `${persona}-sheet`;

    if (scene.textures.exists(sheetKey)) {
      this._sprite = scene.add.sprite(center.x, center.y, sheetKey, F.idle_s[0])
        .setDepth(10)
        .setOrigin(0.5, 1)
        .setScale(SPRITE_SCALE);
      this._useSprite = true;
      this._createAnimations(scene, persona);
    } else {
      this._rect = scene.add.rectangle(center.x, center.y, 24, 32, color)
        .setDepth(10)
        .setOrigin(0.5, 1);
    }

    this.nameText = scene.add.text(center.x, center.y - 20, persona.toUpperCase(), {
      fontSize: '8px', fontFamily: 'monospace',
      color: '#ffffff', stroke: '#000000', strokeThickness: 2, resolution: 4,
    }).setOrigin(0.5, 1).setDepth(11);

    this.stateText = scene.add.text(center.x, center.y + 4, '', {
      fontSize: '6px', fontFamily: 'monospace',
      color: '#aaaaaa', resolution: 4,
    }).setOrigin(0.5, 0).setDepth(11);

    this._targetX = center.x;
    this._targetY = center.y;
    this._baseY = center.y;
  }

  private _createAnimations(scene: Phaser.Scene, persona: PersonaName): void {
    const sk = `${persona}-sheet`;
    const ak = `${persona}-action`;
    const p  = `${persona}-`;

    const make = (key: string, texKey: string, frames: readonly number[], fps: number): void => {
      if (scene.anims.exists(key)) return;
      scene.anims.create({
        key,
        frames: frames.map(f => ({ key: texKey, frame: f })),
        frameRate: fps,
        repeat: -1,
      });
    };

    make(`${p}walk-s`,  sk, F.walk_s,  ANIM_FPS_WALK);
    make(`${p}walk-se`, sk, F.walk_se, ANIM_FPS_WALK);
    make(`${p}walk-e`,  sk, F.walk_e,  ANIM_FPS_WALK);
    make(`${p}walk-ne`, sk, F.walk_ne, ANIM_FPS_WALK);
    make(`${p}walk-n`,  sk, F.walk_n,  ANIM_FPS_WALK);
    const idleFps = ANIM_FPS_IDLE[persona] ?? ANIM_FPS_IDLE_DEFAULT;
    make(`${p}idle-s`,  sk, F.idle_s,  idleFps);
    make(`${p}idle-e`,  sk, F.idle_e,  idleFps);
    make(`${p}sit`,     sk, F.sit,     idleFps);

    if (scene.textures.exists(ak)) {
      make(`${p}work1`, ak, FA.work1, ANIM_FPS_WORK);
      make(`${p}work2`, ak, FA.work2, ANIM_FPS_WORK);
      make(`${p}work3`, ak, FA.work3, ANIM_FPS_WORK);
      make(`${p}carry`, ak, FA.carry, ANIM_FPS_WALK);
    }
  }

  private get _display(): Phaser.GameObjects.Rectangle | Phaser.GameObjects.Sprite {
    return (this._useSprite ? this._sprite : this._rect)!;
  }

  setState(state: string): void {
    if (state === this._currentState) return;
    this._currentState = state;
    const wpIdx = STATE_TARGETS[this.persona]?.[state] ?? 0;
    const wps = WAYPOINTS[this.persona];
    const wp = wps[Math.min(wpIdx, wps.length - 1)];
    this._targetX = wp.x;
    this._targetY = wp.y;
    this._baseY   = wp.y;
    this.stateText.setText(state.replace(/_/g, ' '));
    this._moveSpeed = 2.0;
  }

  update(delta: number): void {
    const dt = delta / 16.667;
    const display = this._display;
    const dx = this._targetX - display.x;
    const dy = this._targetY - display.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Hysteresis: start walking only when dist exceeds WALK_START_DIST,
    // stop walking only when dist drops below WALK_STOP_DIST.
    if (!this._isWalking && dist > AnimatedCharacterSprite.WALK_START_DIST) {
      this._isWalking = true;
    } else if (this._isWalking && dist < AnimatedCharacterSprite.WALK_STOP_DIST) {
      this._isWalking = false;
    }

    if (this._isWalking) {
      const ratio = Math.min((this._moveSpeed * dt) / dist, 1);
      display.x += dx * ratio;
      display.y += dy * ratio;
      if (this._useSprite) this._pickWalkAnim(dx, dy);
    } else {
      if (!this._useSprite) {
        this._idleBobPhase += 0.03 * dt;
        display.y = this._baseY + Math.sin(this._idleBobPhase) * 1.5;
      } else {
        this._pickIdleAnim();
      }
    }

    this.nameText.x = display.x;
    this.nameText.y = display.y - 20;
    this.stateText.x = display.x;
    this.stateText.y = display.y + 4;
  }

  private _pickWalkAnim(dx: number, dy: number): void {
    if (!this._sprite) return;
    const p = `${this.persona}-`;
    const sk = `${this.persona}-sheet`;
    if (this._sprite.texture.key !== sk) this._sprite.setTexture(sk);

    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    let anim: string;
    let flip = false;

    if      (angle > 157.5 || angle <= -157.5) { anim = `${p}walk-e`;  flip = true;  } // W   → mirror E
    else if (angle > 112.5)                     { anim = `${p}walk-se`; flip = true;  } // SW  → mirror SE
    else if (angle > 67.5)                      { anim = `${p}walk-s`;  flip = false; } // S
    else if (angle > 22.5)                      { anim = `${p}walk-se`; flip = false; } // SE
    else if (angle > -22.5)                     { anim = `${p}walk-e`;  flip = false; } // E
    else if (angle > -67.5)                     { anim = `${p}walk-ne`; flip = false; } // NE
    else if (angle > -112.5)                    { anim = `${p}walk-n`;  flip = false; } // N
    else                                        { anim = `${p}walk-ne`; flip = true;  } // NW  → mirror NE

    this._facingLeft = flip;
    this._sprite.setFlipX(flip);
    // Guard against both the cached string and the actual playing key — they can
    // diverge after a texture swap, anim interrupt, or idle→walk transition.
    if (this._currentAnim !== anim || this._sprite.anims.currentAnim?.key !== anim) {
      this._currentAnim = anim;
      this._sprite.play(anim, true);
    }
  }

  private _pickIdleAnim(): void {
    if (!this._sprite) return;
    const p = `${this.persona}-`;
    const actionKey = ACTION_STATES[this._currentState];

    if (actionKey) {
      const fullKey = `${p}${actionKey}`;
      if (this._sprite.scene.anims.exists(fullKey)) {
        // sit lives on main sheet; work* lives on action sheet
        const targetTex = (actionKey === 'sit')
          ? `${this.persona}-sheet`
          : `${this.persona}-action`;
        if (this._sprite.texture.key !== targetTex
            && this._sprite.scene.textures.exists(targetTex)) {
          this._sprite.setTexture(targetTex);
        }
        if (this._currentAnim !== fullKey || this._sprite.anims.currentAnim?.key !== fullKey) {
          this._currentAnim = fullKey;
          this._sprite.play(fullKey, true);
        }
        return;
      }
    }

    const sk = `${this.persona}-sheet`;
    if (this._sprite.texture.key !== sk) this._sprite.setTexture(sk);
    const anim = this._facingLeft ? `${p}idle-e` : `${p}idle-s`;
    this._sprite.setFlipX(this._facingLeft);
    if (this._currentAnim !== anim || this._sprite.anims.currentAnim?.key !== anim) {
      this._currentAnim = anim;
      this._sprite.play(anim, true);
    }
  }

  setVisible(visible: boolean): void {
    this._display.setVisible(visible);
    this.nameText.setVisible(visible);
    this.stateText.setVisible(visible);
  }

  /**
   * Override the state-driven target with an explicit hub-wander target.
   * Used by PersonaAI when the persona is idle.
   */
  setHubTarget(x: number, y: number): void {
    this._targetX = x;
    this._targetY = y;
    this._baseY   = y;
  }

  /**
   * Instantly move the display object to a position without animation.
   * Used on party-invite to prevent the sprite walking in from its waypoint.
   */
  snapTo(x: number, y: number): void {
    this._display.x    = x;
    this._display.y    = y;
    this._targetX      = x;
    this._targetY      = y;
    this._baseY        = y;
    this._isWalking    = false;
    this.nameText.x    = x;
    this.nameText.y    = y - 20;
    this.stateText.x   = x;
    this.stateText.y   = y + 4;
  }

  /** Current display position — read by WorldScene for proximity checks. */
  get x(): number { return this._display.x; }
  get y(): number { return this._display.y; }

  /** True when the sprite is within 4px of its current target. */
  get atTarget(): boolean {
    const dx = this._targetX - this._display.x;
    const dy = this._targetY - this._display.y;
    return Math.sqrt(dx * dx + dy * dy) < 4;
  }
}
