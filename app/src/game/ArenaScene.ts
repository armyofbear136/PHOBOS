/**
 * ArenaScene — Portal arena wave combat scene.
 *
 * A self-contained Phaser scene that sleeps WorldScene, runs action-based
 * wave combat using the existing WorldCombatManager + PlayerCombatController
 * stack, then resumes WorldScene on exit.
 *
 * Layout: flat isometric arena floor, 20×20 tiles, dark tint, wall border.
 * All assets reused from WorldScene (moon-tiles spritesheet already loaded).
 *
 * Lifecycle:
 *   ArenaScene.launch(game, build, config)  — called from PhobosGame
 *   ArenaScene.onArenaExit(cb)              — called when player flees or completes all waves
 *
 * The scene key is 'ArenaScene'.
 */

import * as Phaser from 'phaser';
import { PlayerSprite }           from './PlayerSprite';
import { PlayerCombatController } from './PlayerCombatController';
import { WorldCombatManager }     from './WorldCombatManager';
import { WorldProjectilePool }    from './WorldProjectile';
import { WorldLootDrop }          from './WorldLootDrop';
import { ArenaWaveManager }       from './ArenaWaveManager';
import type { PlayerBuild }       from './PlayerClasses';
import type { HitEvent }          from './PlayerCombatController';
import { TileWorld }              from './TileWorld';
import { initCoordSystem, destroyCoordSystem, updateTransform } from './CoordSystem';
import { buildDifficultyParams }  from './DifficultyParams';
import { KeybindManager }         from './KeybindManager';
import { AllyWorldAI }            from './AllyAI';
import type { PersonaName }       from './GameStore';
import { MATERIAL_BY_ID }         from './CraftingMaterials';
import type { WeaponAssembly }    from './ItemDefinitions';

// ── Arena layout constants ────────────────────────────────────────────────────

const ARENA_TILES_W = 20;   // floor tiles wide (inner)
const ARENA_TILES_H = 20;   // floor tiles tall (inner)

// Isometric projection — same as WorldScene
const HALF_W  = 16;  // halfTileW
const HALF_H  = 8;   // halfTileH

// TileWorld origin for the arena — centre on screen
const ARENA_ORIGIN_X = ARENA_TILES_H * HALF_W;  // 320

// Arena floor tiles are centred at tx/ty 0..19,0..19
// In isometric: the diamond spans from tx=0,ty=0 to tx=19,ty=19

// Tile frame indices from moon-tiles spritesheet — reuse WorldScene floor frames
const FLOOR_FRAMES   = [0, 1, 2, 3, 4, 5, 6];    // base floor variants
const WALL_FRAME     = 21;                          // structure tile for border
const FLOOR_TINT     = 0x1a1a2e;                   // dark navy arena floor
const WALL_TINT      = 0x3a2a5a;                   // purple-dark wall

// ── Static callbacks ──────────────────────────────────────────────────────────

type ExitCallback = (fled: boolean) => void;

// ── Weapon assembly builder ───────────────────────────────────────────────────

// Default fallback assembly — used when no weapon is equipped.
const DEFAULT_WEAPON_ASSEMBLY: WeaponAssembly = {
  parts: [
    { category: 'head',  variantId: 'default', tint: '#aaaaaa' },
    { category: 'shaft', variantId: 'default', tint: '#888888' },
    { category: 'grip',  variantId: 'default', tint: '#664422' },
  ],
  compositeKey: 'weapon-composite-default',
};

function buildWeaponAssembly(item: import('./ItemDefinitions').GameItem): WeaponAssembly {
  const { headMatId, shaftMatId, gripMatId, id } = item;
  const headTint  = headMatId  ? '#' + (MATERIAL_BY_ID.get(headMatId)?.tint  ?? 0xcccccc).toString(16).padStart(6, '0') : '#aaaaaa';
  const shaftTint = shaftMatId ? '#' + (MATERIAL_BY_ID.get(shaftMatId)?.tint ?? 0x888888).toString(16).padStart(6, '0') : '#888888';
  const gripTint  = gripMatId  ? '#' + (MATERIAL_BY_ID.get(gripMatId)?.tint  ?? 0x664422).toString(16).padStart(6, '0') : '#664422';
  return {
    parts: [
      { category: 'head',  variantId: headMatId  ?? 'default', tint: headTint  },
      { category: 'shaft', variantId: shaftMatId ?? 'default', tint: shaftTint },
      { category: 'grip',  variantId: gripMatId  ?? 'default', tint: gripTint  },
    ],
    compositeKey: `weapon-composite-${id}`,
  };
}

// ── ArenaScene ────────────────────────────────────────────────────────────────

export class ArenaScene extends Phaser.Scene {
  private static _onExit: ExitCallback | null = null;

  // Set by launch() before the scene starts
  private static _pendingBuild:          PlayerBuild | null = null;
  private static _pendingPartySize:      number             = 0;
  private static _pendingPartyMembers:   string[]           = [];

  // Exposed so PhobosGame can poll HP/mode/cooldowns for the React HUD
  private static _activeController: PlayerCombatController | null = null;
  static getController(): PlayerCombatController | null { return ArenaScene._activeController; }

  static onArenaExit(cb: ExitCallback): void { ArenaScene._onExit = cb; }

  /** Mirror WorldScene.setInputEnabled — called by PhobosGame on UI mode toggle. */
  setInputEnabled(enabled: boolean): void {
    this._paused = !enabled;
    if (this.input?.keyboard) {
      this.input.keyboard.enabled = enabled;
      if (enabled) {
        this.input.keyboard.enableGlobalCapture();
      } else {
        this.input.keyboard.disableGlobalCapture();
      }
    }
  }

  /**
   * Called from PhobosGame to start the arena. Sleeps WorldScene first.
   */
  static launch(
    game:          Phaser.Game,
    build:         PlayerBuild,
    partySize:     number   = 0,
    partyMembers:  string[] = [],
  ): void {
    ArenaScene._pendingBuild        = build;
    ArenaScene._pendingPartySize    = Math.max(0, Math.min(partySize, 3));
    ArenaScene._pendingPartyMembers = partyMembers.slice();
    game.scene.sleep('WorldScene');
    game.scene.start('ArenaScene');
  }

  /**
   * Called from ArenaScene internally to exit back to the world.
   */
  static exit(game: Phaser.Game, fled: boolean): void {
    ArenaScene._activeController = null;
    game.scene.stop('ArenaScene');
    game.scene.wake('WorldScene');
    ArenaScene._onExit?.(fled);
  }

  // ── Instance ──────────────────────────────────────────────────────────────

  private _player!:     PlayerSprite;
  private _controller!: PlayerCombatController;
  private _combat!:     WorldCombatManager;
  private _projectiles!: WorldProjectilePool;
  private _loot!:       WorldLootDrop;
  private _waveManager!: ArenaWaveManager;
  private _build!:      PlayerBuild;

  // Ally AI instances for party members — empty when no allies in party
  private _allyAIs: AllyWorldAI[] = [];

  // Arena world-px bounds — computed from tile layout, used for enemy positions
  private _arenaBounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  // Pause / escape menu state
  private _paused         = false;
  private _escapeOverlay: Phaser.GameObjects.Container | null = null;

  // Inter-wave countdown (ms) before spawning next wave
  private _nextWaveTimer  = 0;
  private _awaitingNext   = false;
  private static readonly INTER_WAVE_MS = 3000;

  // HUD text objects — updated in update()
  private _hudWaveText!:  Phaser.GameObjects.Text;
  private _hudEnemyText!: Phaser.GameObjects.Text;
  private _hudFleeText!:  Phaser.GameObjects.Text;
  private _waveAnnounce!: Phaser.GameObjects.Text;
  private _announceTimer  = 0;
  static readonly ANNOUNCE_MS = 2000;

  constructor() {
    super({ key: 'ArenaScene' });
  }

  // ── Phaser lifecycle ──────────────────────────────────────────────────────

  create(): void {
    this._build = ArenaScene._pendingBuild!;

    // Rebind KeybindManager to this scene — it's a singleton last bound to WorldScene.
    // Without this all key reads return nothing and the player cannot move.
    KeybindManager.getInstance().init(this);

    // Coord system — ArenaScene gets its own TileWorld instance
    initCoordSystem(this.game.canvas);
    TileWorld.init(HALF_W, HALF_H, ARENA_ORIGIN_X, ARENA_TILES_W * 2, ARENA_TILES_H * 2);

    this._buildArenaTilemap();
    this._computeArenaBounds();
    this._spawnPlayer();
    this._setupCombat();
    this._buildHUD();
    this._startFirstWave();

    this.events.once('shutdown', () => {
      destroyCoordSystem();
      this._combat.clearZone();
      this._projectiles.destroy();
      this._loot.clearZone();
      for (const ally of this._allyAIs) ally.destroyVisual();
      this._allyAIs.length = 0;
    });
  }

  update(_time: number, delta: number): void {
    if (!this.scene.isActive('ArenaScene')) return;
    if (this._paused) return;

    // Sync camera transform so CoordSystem.localToWorld() is accurate for aim angle
    const _cam = this.cameras.main;
    updateTransform(_cam.scrollX, _cam.scrollY, _cam.zoom, _cam.x, _cam.y);

    const px = this._player.x;
    const py = this._player.y;

    // During a roll the controller locks direction — drive player directly
    const rollDir = this._controller?.getRollDir?.() ?? null;
    if (rollDir) {
      const MOVE_SPEED = 120;
      const speedMult  = this._controller.getSpeedMultiplier();
      const dt = delta / 1000;
      this._player.setPosition(
        this._player.x + rollDir.x * MOVE_SPEED * speedMult * dt,
        this._player.y + rollDir.y * MOVE_SPEED * speedMult * dt,
      );
      this._player.update(delta, false);
    } else {
      this._player.update(delta, true);
    }
    this._controller.update(delta);
    this._combat.update(delta, px, py);
    this._projectiles.update(delta, (x, y) => this._combat.isEnemyAtPosition(x, y, 22));
    this._loot.update(delta, px, py);

    // Ally AI update — mirrors WorldScene zone-mode block
    if (this._allyAIs.length > 0) {
      const nearest   = this._combat.getNearestLiveEnemy(px, py);
      const enemyHit  = this._combat.enemyHitPlayerThisFrame;

      for (const ally of this._allyAIs) {
        const result = ally.update(
          delta,
          px,                              py,
          nearest ? nearest.x   : null,
          nearest ? nearest.y   : null,
          nearest ? nearest.idx : null,
          enemyHit,
        );

        ally.syncVisual();

        if (result !== null) {
          if (result.ability !== null) {
            const ab = result.ability;
            if (ab.aoeAll) {
              this._combat.applyAllyAoeHit(result.damage, ab.statusName, ab.statusTurns, ab.statusMagnitude);
            } else {
              const died = this._combat.applyAllyHit(result.targetIdx, result.damage);
              if (nearest && ab.statusName) {
                this._combat.applyStatusToEnemy(result.targetIdx, ab.statusName, ab.statusTurns, ab.statusMagnitude);
              }
              if (died) {
                for (const a of this._allyAIs) a.notifyEnemyDead(result.targetIdx);
              }
            }
            if (ab.healAmount > 0) {
              this._controller.hpCurrent = Math.min(
                this._controller.hpMax,
                this._controller.hpCurrent + ab.healAmount,
              );
            }
            if (nearest) this._spawnFloatText(nearest.x, nearest.y - 10, ab.flavorText, 0xcc88ff);
            if (nearest && result.damage > 0) {
              this._spawnFloatText(nearest.x, nearest.y, String(result.damage), result.isCrit ? 0xffd700 : 0x88ddff);
            }
          } else {
            const died = this._combat.applyAllyHit(result.targetIdx, result.damage);
            if (nearest) {
              this._spawnFloatText(nearest.x, nearest.y, String(result.damage), result.isCrit ? 0xffd700 : 0x88ddff);
            }
            if (died) {
              for (const a of this._allyAIs) a.notifyEnemyDead(result.targetIdx);
            }
          }
        }
      }

      if (enemyHit && nearest) {
        for (const ally of this._allyAIs) ally.notifyPlayerHit(nearest.idx);
      }
    }

    // Inter-wave countdown
    if (this._awaitingNext) {
      this._nextWaveTimer -= delta;
      if (this._nextWaveTimer <= 0) {
        this._awaitingNext = false;
        this._waveManager.startNextWave();
      }
    } else {
      this._waveManager.update(delta);
    }

    // Wave announce fade
    if (this._announceTimer > 0) {
      this._announceTimer -= delta;
      const t = Math.max(0, this._announceTimer / ArenaScene.ANNOUNCE_MS);
      this._waveAnnounce.setAlpha(t);
      if (this._announceTimer <= 0) this._waveAnnounce.setVisible(false);
    }

    // HUD enemy count
    const liveCount = this._combat.liveEnemyCount;
    this._hudEnemyText.setText(`ENEMIES: ${liveCount}`);
  }

  // ── Arena floor ───────────────────────────────────────────────────────────

  private _buildArenaTilemap(): void {
    const tw = TileWorld.getInstance();

    // Outer wall border: tx = -1..W, ty = -1..H edges
    for (let tx = -1; tx <= ARENA_TILES_W; tx++) {
      for (let ty = -1; ty <= ARENA_TILES_H; ty++) {
        const isWall = tx === -1 || tx === ARENA_TILES_W
                    || ty === -1 || ty === ARENA_TILES_H;
        if (!isWall) continue;
        const { x, y } = tw.tileToWorld(tx, ty);
        this.add.image(x, y, 'moon-tiles', WALL_FRAME)
          .setOrigin(0.5, 0.5).setDepth(1).setTint(WALL_TINT);
      }
    }

    // Inner floor — 20×20, varied frame by position hash
    for (let tx = 0; tx < ARENA_TILES_W; tx++) {
      for (let ty = 0; ty < ARENA_TILES_H; ty++) {
        const frame = FLOOR_FRAMES[(tx * 3 + ty * 7) % FLOOR_FRAMES.length];
        const { x, y } = tw.tileToWorld(tx, ty);
        this.add.image(x, y, 'moon-tiles', frame)
          .setOrigin(0.5, 0.5).setDepth(0).setTint(FLOOR_TINT);
        // Register every floor tile as walkable
        tw.registerTile(tx, ty);
      }
    }

    // Seal so isWalkable() works — all floor tiles are now traversable
    tw.seal();
  }

  private _computeArenaBounds(): void {
    const tw = TileWorld.getInstance();
    // Inner floor world extents — inset 1 tile from edge
    const corners = [
      tw.tileToWorld(1, 1),
      tw.tileToWorld(ARENA_TILES_W - 2, 1),
      tw.tileToWorld(1, ARENA_TILES_H - 2),
      tw.tileToWorld(ARENA_TILES_W - 2, ARENA_TILES_H - 2),
    ];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of corners) {
      if (c.x < minX) minX = c.x;
      if (c.y < minY) minY = c.y;
      if (c.x > maxX) maxX = c.x;
      if (c.y > maxY) maxY = c.y;
    }
    this._arenaBounds = { minX, minY, maxX, maxY };
  }

  // ── Player & combat setup ─────────────────────────────────────────────────

  private _spawnPlayer(): void {
    const tw = TileWorld.getInstance();
    const centre = tw.tileToWorld(
      Math.floor(ARENA_TILES_W / 2),
      Math.floor(ARENA_TILES_H / 2),
    );

    this._player = new PlayerSprite(this);
    this._player.setPosition(centre.x, centre.y);
    // Apply arena walk bounds so the player can't clip through walls.
    // TileWorld.seal() computed these from the registered tiles.
    this._player.setWalkBounds(tw.getWalkBounds());
    const meleeAssembly = this._build.equipment?.melee
      ? buildWeaponAssembly(this._build.equipment.melee)
      : DEFAULT_WEAPON_ASSEMBLY;
    this._player.configure({
      name: this._build.name,
      element: this._build.element,
      weapon: '',
      laserColor: '#ffffff',
      weaponAssembly: meleeAssembly,
    });

    // Camera follows player
    this.cameras.main.startFollow(this._player.displayObject, true, 0.12, 0.12);
    this.cameras.main.setZoom(2);
  }

  private _setupCombat(): void {
    this._combat      = new WorldCombatManager(this);
    this._projectiles = new WorldProjectilePool(this);
    this._loot        = new WorldLootDrop(this);

    this._controller = new PlayerCombatController(this, this._player, this._build);
    this._controller.combatEnabled = true;
    this._controller.combat = this._combat;
    this._combat.setController(this._controller);

    // Wire controller so arena power-up pickups apply buffs
    this._loot.controller = this._controller;

    // Expose controller so PhobosGame's poll loop can update the React HUD
    ArenaScene._activeController = this._controller;

    // Ranged projectile on hit
    this._controller.onHit = (event: HitEvent) => {
      if (event.type === 'ranged' && this._projectiles) {
        this._projectiles.fire(
          event.originX, event.originY,
          event.aimAngle,
          this._player.laserColor,
        );
      }
      this._combat.resolveHit(event);
    };

    // Player death → flee
    this._controller.onDeath = () => {
      this.time.delayedCall(900, () => {
        ArenaScene.exit(this.game, true);
      });
    };

    this._controller.onWeaponBreak = (slot) => {
      this._spawnFloatText(this._player.x, this._player.y - 14, 'WEAPON BROKEN', 0xff4444);
      if (slot === 'melee') this._player.setWeaponAssembly(null);
    };

    this._combat.onEnemyKilled = (enemy) => {
      this._loot.spawnFromKill(
        enemy.x, enemy.y,
        enemy.template.archetype,
        enemy.template.element,
        (Math.round(enemy.x * 100) ^ Math.round(enemy.y * 100)) >>> 0,
      );
    };

    // Spawn ally AIs for each party member — staggered near player start
    const tw = TileWorld.getInstance();
    const centre = tw.tileToWorld(
      Math.floor(ARENA_TILES_W / 2),
      Math.floor(ARENA_TILES_H / 2),
    );
    // Fixed offsets so allies don't stack on each other or the player
    const ALLY_OFFSETS: Array<{ dx: number; dy: number }> = [
      { dx: -28, dy:  10 },
      { dx:  28, dy:  10 },
      { dx:   0, dy:  22 },
    ];
    ArenaScene._pendingPartyMembers.forEach((name, i) => {
      const ally = new AllyWorldAI(name as PersonaName);
      const off  = ALLY_OFFSETS[i] ?? ALLY_OFFSETS[0];
      ally.x = centre.x + off.dx;
      ally.y = centre.y + off.dy;
      ally.worldState = 'following';
      ally.spawnVisual(this);
      this._allyAIs.push(ally);
    });

    // Wave manager
    const difficulty = buildDifficultyParams(ArenaScene._pendingPartySize);
    this._waveManager = new ArenaWaveManager(this._combat, this._arenaBounds, difficulty);

    this._waveManager.onWaveStart = (num, total, label) => {
      this._hudWaveText.setText(`${label.toUpperCase()}  /  ${total}`);
      this._showAnnounce(label.toUpperCase());
    };

    this._waveManager.onWaveComplete = () => {
      if (this._waveManager.isDone) return;
      // Queue the next wave after a pause
      this._awaitingNext  = true;
      this._nextWaveTimer = ArenaScene.INTER_WAVE_MS;
      this._showAnnounce('WAVE CLEAR');
    };

    this._waveManager.onAllWavesComplete = () => {
      this._showAnnounce('ALL WAVES COMPLETE');
      this.time.delayedCall(3000, () => {
        ArenaScene.exit(this.game, false);
      });
    };
  }

  // ── HUD ───────────────────────────────────────────────────────────────────

  private _buildHUD(): void {
    const style: Phaser.Types.GameObjects.Text.TextStyle = {
      fontSize: '7px', fontFamily: 'monospace',
      color: '#cccccc', stroke: '#000000', strokeThickness: 3,
      resolution: 4,
    };

    // Fixed to camera — use setScrollFactor(0)
    this._hudWaveText = this.add.text(8, 8, 'WAVE 1 / 10', style)
      .setScrollFactor(0).setDepth(100);

    this._hudEnemyText = this.add.text(8, 18, 'ENEMIES: 0', style)
      .setScrollFactor(0).setDepth(100);

    this._hudFleeText = this.add.text(8, 28, '[ESC] MENU', {
      ...style, color: '#ff9966',
    }).setScrollFactor(0).setDepth(100);

    // ESC key opens the pause/abandon menu
    this.input.keyboard!.on('keydown-ESC', () => {
      this._toggleEscapeMenu();
    });

    // Centre announce
    const w = this.cameras.main.width;
    const h = this.cameras.main.height;
    this._waveAnnounce = this.add.text(w / 2, h * 0.28, '', {
      fontSize: '14px', fontFamily: 'monospace',
      color: '#ffffff', stroke: '#000000', strokeThickness: 4,
      resolution: 4,
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(200).setAlpha(0).setVisible(false);
  }

  private _toggleEscapeMenu(): void {
    if (this._escapeOverlay) {
      this._destroyEscapeOverlay();
    } else {
      this._buildEscapeOverlay();
    }
  }

  private _buildEscapeOverlay(): void {
    this._paused = true;
    const cam    = this.cameras.main;
    const cw     = cam.width;
    const ch     = cam.height;

    // Dark backdrop
    const bg = this.add.rectangle(0, 0, cw, ch, 0x000000, 0.72)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(300).setInteractive();

    // Panel
    const panelW = 160;
    const panelH = 90;
    const px     = (cw - panelW) / 2;
    const py     = (ch - panelH) / 2;

    const panel = this.add.rectangle(px, py, panelW, panelH, 0x0a0a0e, 0.98)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(301);
    const border = this.add.rectangle(px, py, panelW, panelH)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(302)
      .setFillStyle(0x000000, 0).setStrokeStyle(1, 0x333344, 1);

    const baseStyle: Phaser.Types.GameObjects.Text.TextStyle = {
      fontSize: '6px', fontFamily: 'monospace', resolution: 4,
    };

    const title = this.add.text(px + panelW / 2, py + 14, 'PAUSED', {
      ...baseStyle, fontSize: '9px', color: '#cccccc',
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(303);

    // RESUME button
    const resumeBtn = this.add.text(px + panelW / 2, py + 36, '[ RESUME ]', {
      ...baseStyle, color: '#44ff88',
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(303)
      .setInteractive({ useHandCursor: true });
    resumeBtn.on('pointerover',  () => resumeBtn.setColor('#88ffaa'));
    resumeBtn.on('pointerout',   () => resumeBtn.setColor('#44ff88'));
    resumeBtn.on('pointerdown',  () => this._destroyEscapeOverlay());

    // ABANDON button
    const abandonBtn = this.add.text(px + panelW / 2, py + 54, '[ ABANDON ARENA ]', {
      ...baseStyle, color: '#ff6655',
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(303)
      .setInteractive({ useHandCursor: true });
    abandonBtn.on('pointerover',  () => abandonBtn.setColor('#ff9988'));
    abandonBtn.on('pointerout',   () => abandonBtn.setColor('#ff6655'));
    abandonBtn.on('pointerdown',  () => {
      this._destroyEscapeOverlay();
      ArenaScene.exit(this.game, true);
    });

    const hint = this.add.text(px + panelW / 2, py + 75, 'ESC — CLOSE', {
      ...baseStyle, color: '#333344',
    }).setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(303);

    this._escapeOverlay = this.add.container(0, 0, [bg, panel, border, title, resumeBtn, abandonBtn, hint]);
    this._escapeOverlay.setScrollFactor(0).setDepth(300);
  }

  private _destroyEscapeOverlay(): void {
    if (this._escapeOverlay) {
      this._escapeOverlay.destroy(true);
      this._escapeOverlay = null;
    }
    this._paused = false;
  }

  private _spawnFloatText(x: number, y: number, text: string, color: number): void {
    const hex = '#' + color.toString(16).padStart(6, '0');
    const t = this.add.text(x, y - 8, text, {
      fontSize: '8px', fontFamily: 'monospace',
      color: hex, stroke: '#000000', strokeThickness: 1, resolution: 4,
    }).setOrigin(0.5, 1).setDepth(20);
    this.tweens.add({
      targets: t,
      y: y - 28,
      alpha: { from: 1, to: 0 },
      duration: 600,
      ease: 'Quad.easeOut',
      onComplete: () => t.destroy(),
    });
  }

  private _showAnnounce(text: string): void {
    this._waveAnnounce
      .setText(text)
      .setAlpha(1)
      .setVisible(true);
    this._announceTimer = ArenaScene.ANNOUNCE_MS;
  }

  // ── Wave start ────────────────────────────────────────────────────────────

  private _startFirstWave(): void {
    // Small delay before first wave so player can orient
    this._awaitingNext  = true;
    this._nextWaveTimer = 1500;
    this._showAnnounce('GET READY');
  }
}
