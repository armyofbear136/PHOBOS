/**
 * WorldScene — PHOBOS World main Phaser 3 scene.
 *
 * Isometric tilemap using kipperfalcon's space tileset.
 * Four zones (SAYON/SEREN/SYBIL/Player) + central plaza.
 * Characters driven by GameStore state each frame.
 * Coins spawned from GameStore ring buffer.
 *
 * v1: static placeholder sprites, no physics, no pathfinding.
 * The tilemap is built procedurally — no external Tiled editor needed.
 */

import * as Phaser from 'phaser';
import { gameStore, consumeNextCoin, clearChanged, type PersonaName } from './GameStore';
import { AnimatedCharacterSprite } from './AnimatedCharacterSprite';
import { PlayerSprite, type PlayerConfig } from './PlayerSprite';
import { CoinManager } from './CoinManager';
import { NebulaBackground } from './NebulaBackground';
import { EffectsManager } from './EffectsManager';
import { removeDayNightFromCamera } from './PhobosPostProcess';
import { PersonaAI } from './PersonaAI';
import { TrainingDummy } from './TrainingDummy';
import { KeybindManager } from './KeybindManager';
import { PlayerCombatController, type HitEvent } from './PlayerCombatController';
import { AllyWorldAI } from './AllyAI';
import type { EngagementMode } from './AllyAI';
import { SnowflakeGenerator } from './SnowflakeGenerator';
import { TileWorld } from './TileWorld';
import { ExplorationZoneManager, EXZONE_ENTRY_TX, EXZONE_ENTRY_TY, EXZONE_BRIDGE_HUB_TX, EXZONE_BRIDGE_HUB_TY, ZONE_DEPTH, ZONE_HALF_W, generateZoneGraph, type ZoneGraph, type RoomInstance, type CorridorSpec } from './ExplorationZoneManager';
import type { ChunkGraph, ChunkSpec, ZoneSpec } from './ExplorationZoneManager';
import { WorldCombatManager } from './WorldCombatManager';
import { buildDifficultyParams } from './DifficultyParams';
import { WorldLootDrop }      from './WorldLootDrop';
import { WorldProjectilePool } from './WorldProjectile';
import { MATERIAL_BY_ID } from './CraftingMaterials';
import { bakeWeaponComposite } from './WeaponCompositor';
import type { WeaponAssembly } from './ItemDefinitions';

import {
  PERMANENT_BUILDINGS, MACHINE_BY_ID, getFootprintTiles,
  progressToState, buildProgress,
} from './HubBuildingCatalog';
import {
  initCoordSystem, destroyCoordSystem, updateTransform,
  coordSystemReady, getTransform,
  viewportToWorld, viewportToTile, tileToViewport,
} from './CoordSystem';
import { MineralNode, MINERAL_NODE_DEFS } from './MineralNode';

// ── Constants ──────────────────────────────────────────────────────────────
const MAP_W = 40;   // tiles wide — hub only
const MAP_H = 28;   // tiles tall — hub only
// TileWorld allocation covers hub + maximum exploration island (20 cols × 14 rows northeast).
// Walkable array is 64×32 = 2048 bytes — negligible. Actual camera bounds derive from registered tiles.
const TILEWORLD_W = 64;
const TILEWORLD_H = 32;
const TILE_W = 32;  // pixel width of each tile
const TILE_H = 32;  // pixel height (source image is 32×32)
// Isometric half-tile for projection
const HALF_W = TILE_W / 2;  // 16
const HALF_H = TILE_H / 4;  // 8 (isometric height = quarter of width for a 2:1 ratio)

// Atlas layout: Moon_tileset_Atlas.png — 7 columns × 8 rows = 56 frames (224×256 px)
const ATLAS_TILE_W = 32;
const ATLAS_TILE_H = 32;
const ATLAS_TOTAL_FRAMES = 56;

// ── Asset paths (matching public/game/ directory layout) ───────────────────
// Atlas is at public/game/Atlas/Moon_tileset_Atlas.png
const MOON_ATLAS_PATH = 'game/Atlas/Moon_tileset_Atlas.png';
// Decoration images at public/game/Decorations_tiles/
const DECO_DIR = 'game/Decorations_tiles/';

// Zone tint colors — Phaser tint MULTIPLIES each channel, so use bright values
// to preserve tile detail while shifting hue. 0xffffff = no tint (original colors).
const TINT_SAYON  = 0xffa040; // warm amber
const TINT_SEREN  = 0x4080ff; // cool blue
const TINT_SYBIL  = 0x9060ff; // violet
const TINT_PLAYER = 0x808080; // neutral grey (dims slightly)
const TINT_PLAZA  = 0xa0a0a0; // light grey
const TINT_NONE   = 0x303030; // very dim for void edges

// Zone boundaries (tile coordinates)
const ZONES = {
  sybil:  { x1: 0,  y1: 0,  x2: 14, y2: 12 },
  seren:  { x1: 24, y1: 0,  x2: 39, y2: 12 },
  sayon:  { x1: 6,  y1: 16, x2: 20, y2: 27 },
  player: { x1: 24, y1: 16, x2: 38, y2: 27 },
  corridor: { x1: 18, y1: 0, x2: 20, y2: 7 },  // north approach to exploration bridge
  plaza:  { x1: 14, y1: 8,  x2: 26, y2: 18 },
};

// Idle coin collection interval (ms) — AI personas collect while idle
const AUTO_COLLECT_INTERVAL = 3000;
// Player coin collection radius (generous — design doc §5.3)
const PLAYER_COLLECT_RADIUS = 28;

// ── Zone structure footprints ─────────────────────────────────────────────────
// Same shape as PermanentBuilding. anchorTx/anchorTy calibrated via dev nudge tool.
// Rule: anchor = (stx - fw//2, sty - (fh-1)) where stx/sty is the placeStructureTile coord.
// Mutated in place by nudgeZoneFootprint() during dev sessions; copy final values here.
const ZONE_STRUCTURES: Array<{ id: string; anchorTx: number; anchorTy: number; footprintW: number; footprintH: number }> = [
  { id: 'relay_tower',     anchorTx: 12, anchorTy: 19, footprintW: 1, footprintH: 2 },
  { id: 'dispatch_desk',   anchorTx: 14, anchorTy: 22, footprintW: 1, footprintH: 1 },
  { id: 'crystal_lab',     anchorTx: 30, anchorTy:  4, footprintW: 3, footprintH: 2 },
  { id: 'thought_chamber', anchorTx: 34, anchorTy:  6, footprintW: 2, footprintH: 2 },
  { id: 'telescope',       anchorTx: 28, anchorTy:  8, footprintW: 1, footprintH: 1 },
  { id: 'archive_mound',   anchorTx:  4, anchorTy:  4, footprintW: 3, footprintH: 2 },
  { id: 'catalogue_table', anchorTx:  8, anchorTy: 10, footprintW: 1, footprintH: 1 },
  { id: 'obelisk',         anchorTx: 20, anchorTy: 13, footprintW: 1, footprintH: 1 },
  { id: 'portal',          anchorTx:  6, anchorTy: 24, footprintW: 2, footprintH: 2 },
  { id: 'battle_hall',     anchorTx: 36, anchorTy: 24, footprintW: 2, footprintH: 2 },
];

// ── EtherPickup ───────────────────────────────────────────────────────────────
// Spawned at player death position. Collected on proximity walk-over.

const ETHER_PICKUP_RADIUS = 24;

class EtherPickup {
  readonly amount: number;
  private _sprite: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, x: number, y: number, amount: number) {
    this.amount  = amount;
    this._sprite = scene.add.text(x, y, `◆${amount}`, {
      fontSize: '7px',
      fontFamily: 'monospace',
      color: '#c4b5fd',
      stroke: '#000',
      strokeThickness: 1,
      resolution: 4,
    })
      .setOrigin(0.5, 1)
      .setDepth(18)
      .setAlpha(0);

    // Fade in
    scene.tweens.add({
      targets: this._sprite,
      alpha: 1,
      y: y - 6,
      duration: 300,
      ease: 'Quad.easeOut',
    });

    // Gentle bob
    scene.tweens.add({
      targets: this._sprite,
      y: `+=${3}`,
      yoyo: true,
      repeat: -1,
      duration: 800,
      ease: 'Sine.easeInOut',
      delay: 300,
    });
  }

  get x(): number { return this._sprite.x; }
  get y(): number { return this._sprite.y; }

  /** Returns true and destroys sprite if player is within pickup radius. */
  tryCollect(playerX: number, playerY: number): boolean {
    const dx = playerX - this._sprite.x;
    const dy = playerY - this._sprite.y;
    if (Math.sqrt(dx * dx + dy * dy) > ETHER_PICKUP_RADIUS) return false;
    this._sprite.destroy();
    return true;
  }
}

// ── Supporting types ───────────────────────────────────────────────────────

/** API shape returned by GET /api/game/buildings */
interface FetchedBuilding {
  id:                string;
  building_id:       string;
  tile_x:            number;
  tile_y:            number;
  state:             'blueprint' | 'building' | 'built';
  config:            string;   // JSON: { slotId: { materialId: quantity } }
  last_collected_at: string | null;
  placed_at:         string;
}

/** Runtime record for a placed machine — sprite + interact data */
interface PlacedMachineRecord {
  recordId:    string;
  buildingId:  string;
  anchorTx:    number;
  anchorTy:    number;
  state:       'blueprint' | 'building' | 'built';
  config:      string;
  last_collected_at: string | null;
}

// ── WorldScene ────────────────────────────────────────────────────────────────

/**
 * Build a WeaponAssembly from a GameItem's material IDs.
 * Falls back to neutral grey tints for any missing material.
 * Returns null when the item has no material data at all.
 */
// Default fallback assembly — used when no weapon is equipped.
// Three neutral grey zones so the compositor always draws something visible.
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

export class WorldScene extends Phaser.Scene {
  private characters: Record<PersonaName, AnimatedCharacterSprite> = {} as Record<PersonaName, AnimatedCharacterSprite>;
  private player!: PlayerSprite;
  private coinManager!: CoinManager;
  private autoCollectTimer = 0;
  private playerCollectTimer = 0;
  private _inputEnabled = false;
  private _personaAIs: Record<string, PersonaAI> = {};
  private _allyWorldAIs: Record<string, AllyWorldAI> = {}
  private _partyMembers: Set<string> = new Set();
  private _trainingDummy: TrainingDummy | null = null;
  private _combatController: PlayerCombatController | null = null;
  get combatController(): PlayerCombatController | null { return this._combatController; }
  private _keybinds!: KeybindManager;
  private _mineralNodes: MineralNode[] = [];

  // ── Ether pickups (dropped on death) ──────────────────────────────────────
  private _etherPickups: EtherPickup[] = [];
  private _etherPickupTimer = 0;
  // Respawn tile — inside player zone, adjacent to house at (30,20)
  private static readonly RESPAWN_TILE = { tx: 22, ty: 11 } as const;

  // ── Exploration zone guard ─────────────────────────────────────────────
  private _zoneGuardTimer   = 0;
  private _countdownHud:    Phaser.GameObjects.Text | null = null;
  private _zoneLabelHud:    Phaser.GameObjects.Text | null = null;
  private _zoneEnemyHud:    Phaser.GameObjects.Text | null = null;
  private _zoneClearBanner: Phaser.GameObjects.Text | null = null;
  private _zoneExitPrompt:  Phaser.GameObjects.Text | null = null;
  private _worldCombat:     WorldCombatManager | null = null;
  private _projectiles:    WorldProjectilePool | null = null;
  private _worldLoot:       WorldLootDrop | null      = null;

  // ── Multi-chunk zone ───────────────────────────────────────────────────
  private _chunkGraph:         ChunkGraph | null                   = null;
  private _bossBarrierImage:   Phaser.GameObjects.Image | null     = null;
  private _bossBarrierGlow:    Phaser.GameObjects.Arc | null       = null;
  private _bossBarrierTile:    { tx: number; ty: number } | null   = null;
  private _dailySeed:          number                              = 0;

  // ── Interactable buildings ─────────────────────────────────────────────
  private _interactables: Array<{
    worldX: number; worldY: number; radius: number;
    label: string; onInteract: () => void;
  }> = [];
  // Direct refs to persona NPC interactable entries for dynamic label mutation
  private _npcInteractables: Partial<Record<string, { label: string }>> = {};
  private _interactPrompt: Phaser.GameObjects.Text | null = null;
  private _nearestInteractable: number = -1;  // index into _interactables, -1 = none

  // Garage sprite swaps open/closed based on player proximity
  private _garageSprite: Phaser.GameObjects.Image | null = null;

  // ── Placed machine tracking ────────────────────────────────────────────
  // Keyed by building DB record id. Cleared and rebuilt on every loadPlayerBuildings() call.
  private _placedMachineSprites = new Map<string, Phaser.GameObjects.Image>();
  private _placedMachineRecords: PlacedMachineRecord[] = [];

  constructor() {
    super({ key: 'WorldScene' });
  }

  // Keys that must be present for the scene to function.
  // A missing entry here means Phaser got a network error before the game
  // files were in place — safe to reload automatically.
  private static readonly CRITICAL_KEYS = new Set([
    'moon-tiles',
    'fighter-a-sheet', 'fighter-b-sheet',
    'tank-a-sheet',    'tank-b-sheet',
    'healer-a-sheet',  'healer-b-sheet',
    'rogue-a-sheet',   'rogue-b-sheet',
    'sayon-sheet', 'seren-sheet', 'sybil-sheet',
  ]);

  preload(): void {
    // If any critical asset fails to load (e.g. game files not yet on disk
    // during a first-launch race), reload the page once after a short delay.
    // This is the fallback for cases where the boot sequence hasn't already
    // triggered a reload.
    this.load.on(Phaser.Loader.Events.FILE_LOAD_ERROR, (file: Phaser.Loader.File) => {
      if (WorldScene.CRITICAL_KEYS.has(file.key)) {
        console.warn(`[WorldScene] Critical asset failed: ${file.key} — scheduling reload`);
        setTimeout(() => window.location.reload(), 1500);
      }
    });

    // Load the moon tileset atlas as a spritesheet
    this.load.spritesheet('moon-tiles', MOON_ATLAS_PATH, {
      frameWidth: ATLAS_TILE_W,
      frameHeight: ATLAS_TILE_H,
    });

    // Load decoration images
    const decorations = [
      'Big_rocks_1', 'Medium_rocks_1', 'Medium_rocks_2', 'Medium_rocks_3',
      'Small_rocks_1', 'Small_rocks_2', 'Small_rocks_3',
      'Spike_rock_1', 'Spike_rock_2',
      'Big_Crater_hit_1', 'Small_Crater_hit_1', 'Small_Crater_hit_2',
    ];
    for (const d of decorations) {
      this.load.image(d, `${DECO_DIR}${d}.png`);
    }

    // ── Character sprite sheets ───────────────────────────────────────
    // Player/NPC sheets: 633×633 px frames, 12×12 grid (7596×7596 sheet).
    // Persona action sheets: same 633×633 frame size, smaller grid.
    // Display scale: setScale(0.125) → 633 native → ~79px display.
    const SPRITE_DIR = 'game/sprites/';

    // NPC main sheets — files on disk use -move suffix for the 12×12 locomotion/combat sheet
    const personas = ['sayon', 'seren', 'sybil'];
    for (const p of personas) {
      this.load.spritesheet(`${p}-sheet`, `${SPRITE_DIR}${p}-move.png`, {
        frameWidth: 633, frameHeight: 633,
      });
      // Persona-exclusive action sheet (4×4 grid — work/think/carry/gesture)
      this.load.spritesheet(`${p}-action`, `${SPRITE_DIR}${p}-action.png`, {
        frameWidth: 633, frameHeight: 633,
      });
    }

    // Player class sprite sheets — files on disk use -move suffix
    const classes = ['fighter', 'tank', 'healer', 'rogue'];
    const bodies = ['a', 'b'];
    for (const cls of classes) {
      for (const body of bodies) {
        this.load.spritesheet(`${cls}-${body}-sheet`, `${SPRITE_DIR}${cls}-${body}-move.png`, {
          frameWidth: 633, frameHeight: 633,
        });
      }
    }

    // Coin sprite strip
    this.load.spritesheet('coin-sprite', `${SPRITE_DIR}coin.png`, {
      frameWidth: 633, frameHeight: 633,
    });

    // ── Effects sprites ───────────────────────────────────────────────
    const FX_DIR = 'game/sprites/fx/';
    this.load.image('shadow-oval',  `${FX_DIR}shadow-oval.png`);
    this.load.image('particle-dot', `${FX_DIR}particle-dot.png`);

    // ── Buildings ─────────────────────────────────────────────────────
    const BLDG_DIR = 'game/sprites/buildings/';
    this.load.image('building-house',         `${BLDG_DIR}ControlBase.png`);
    this.load.image('building-garage',        `${BLDG_DIR}StorageContainer_closed.png`);
    this.load.image('building-crafting',      `${BLDG_DIR}StorageContainer_opened.png`);
    this.load.image('building-fab',           `${BLDG_DIR}ProducerBulding_full.png`);
    this.load.image('building-shop',          `${BLDG_DIR}ProducerBuilding_Empty.png`);
    this.load.image('building-gateway',       `${BLDG_DIR}Uncharged_zone.png`);

    // ── Machines ──────────────────────────────────────────────────────
    const MACH_DIR = 'game/sprites/machines/';
    this.load.image('machine-psi',   `${MACH_DIR}Comunication_machine.png`);
    this.load.image('machine-mpa',   `${MACH_DIR}Grab_machine.png`);
    this.load.image('machine-zpr',   `${MACH_DIR}Refill_machine.png`);
    this.load.image('machine-sfg',   `${MACH_DIR}Hammer_machine.png`);
    this.load.image('machine-fcs',   `${MACH_DIR}Cool_machine.png`);
    this.load.image('machine-rcs',   `${MACH_DIR}Processor_machine_1.png`);
    this.load.image('machine-spc',   `${MACH_DIR}Big_PC_machine.png`);
    this.load.image('machine-tst-a', `${MACH_DIR}Extension_machine_1.png`);
    this.load.image('machine-tst-b', `${MACH_DIR}Extension_machine_2.png`);
    this.load.image('machine-drill', `${MACH_DIR}Drill_machine.png`);
    this.load.image('machine-oil',   `${MACH_DIR}Oil_extractor_machine.png`);
    this.load.image('machine-gen1',  `${MACH_DIR}General_machine_1.png`);
    this.load.image('machine-gen2',  `${MACH_DIR}General_machine_2.png`);
    this.load.image('machine-gen3',  `${MACH_DIR}General_machine_3.png`);
    this.load.image('machine-solar-big',    `${MACH_DIR}Big_SolarPanel_machine.png`);
    this.load.image('machine-solar-medium', `${MACH_DIR}Medium_SolarPanel_machine.png`);
    this.load.image('pillar-1', `${MACH_DIR}Pilar_1.png`);
    this.load.image('pillar-2', `${MACH_DIR}Pilar_2.png`);
    this.load.image('pillar-3', `${MACH_DIR}Pilar_3.png`);
    this.load.image('pillar-4', `${MACH_DIR}Pilar_4.png`);
    this.load.image('pillar-5', `${MACH_DIR}Pilar_5.png`);

    // ── Minerals ──────────────────────────────────────────────────────
    // Filenames from asset pack — casing matches disk exactly.
    const MIN_DIR = 'game/sprites/minerals/';
    const mineralFiles: Array<[string, string, string, string]> = [
      // [id, smallFile, mediumFile, bigFile]
      ['lumite',   'Small_Pink_Mineral',   'Medium_Pink_Mineral',   'Big_Pink_Mineral'],
      ['ferrite',  'small_red_Mineral',    'Medium_red_Mineral',    'Big_red_Mineral'],
      ['aurite',   'Small_Brown_Mineral',  'Medium_Brown_Mineral',  'Big_Brown_Mineral'],
      ['verdite',  'Small_Green_Mineral',  'Medium_Green_Mineral',  'Big_Green_Mineral'],
      ['azurite',  'Small_Blue_Mineral',   'Medium_Blue_Mineral',   'Big_Blue_Mineral'],
      ['fluxite',  'Small_Black_Mineral',  'Medium_Black_Mineral',  'Big_Black_Mineral'],
      ['solarium', 'Small_Yellow_Mineral', 'Medium_Yellow_Mineral', 'Big_Yellow_Mineral'],
    ];
    for (const [id, s, m, b] of mineralFiles) {
      this.load.image(`mineral-${id}-small`,  `${MIN_DIR}${s}.png`);
      this.load.image(`mineral-${id}-medium`, `${MIN_DIR}${m}.png`);
      this.load.image(`mineral-${id}-big`,    `${MIN_DIR}${b}.png`);
    }
  }

  create(): void {
    WorldScene._instance = this;
    this.events.once('shutdown', () => {
      WorldScene._instance = null;
      destroyCoordSystem();
      for (const node of this._mineralNodes) node.destroy();
      this._mineralNodes.length = 0;
    });

    // Fired when ArenaScene stops and game.scene.wake('WorldScene') is called.
    // Rebind KeybindManager, clear zone state, and return player to hub respawn.
    this.events.on('wake', () => {
      KeybindManager.getInstance().init(this);
      this._inputEnabled = true;

      // ArenaScene.create() calls TileWorld.init() which replaces the singleton's
      // dimensions and wipes all tile data. Restore WorldScene's coordinate space
      // and re-register all walkable tiles before the first update() runs.
      this._rebuildTileWorldData();

      // Clear zone state — player was inside the arena, not the exploration zone
      if (this._playerInExZone) {
        this._playerInExZone = false;
        this._worldCombat?.clearZone();
        this._zoneEnemyHud?.setAlpha(0).setVisible(false);
        this._zoneExitPrompt?.setAlpha(0).setVisible(false);
        for (const name in this._allyWorldAIs) {
          this._allyWorldAIs[name].destroyVisual();
        }
      }

      // Return player to hub respawn so they don't land inside the portal trigger
      const respawn = this.tileToScreen(WorldScene.RESPAWN_TILE.tx, WorldScene.RESPAWN_TILE.ty);
      this.player.setPosition(respawn.x, respawn.y);
      this._lastValidX = respawn.x;
      this._lastValidY = respawn.y;
    });
    initCoordSystem(this.game.canvas);
    // Initialise TileWorld projection constants.
    // originX = MAP_H * halfTileW = 28 * 16 = 448 (horizontal shift of the diamond).
    TileWorld.init(HALF_W, HALF_H, MAP_H * HALF_W, TILEWORLD_W, TILEWORLD_H);

    this.setZoom(2);

    // Wire mousewheel zoom
    this.setupMouseWheelZoom();

    // ── Space background (nebula + stars, baked once) ──────────────────
    NebulaBackground.getInstance().generate(this, this._highPerf);

    // ── Daily procedural snowflake texture ────────────────────────────
    SnowflakeGenerator.generate(this, 32);

    // ── Effects manager ───────────────────────────────────────────────
    EffectsManager.getInstance().init(this, this._highPerf);

    // ── Isometric tilemap ──────────────────────────────────────────────
    this.createTilemap();
    // Tilemap registration is complete — seal TileWorld and apply derived bounds.
    this._applyTileWorldBounds();

    // ── Zone decorations ───────────────────────────────────────────────
    this.createZoneDecorations();

    // ── Zone border paths ──────────────────────────────────────────
    this.createZoneBorders();

    // ── Zone structures (tileset-composed with ambient effects) ──
    this.createZoneStructures();

    // ── Characters ─────────────────────────────────────────────────────
    this.characters.sayon = new AnimatedCharacterSprite(this, 'sayon');
    this.characters.seren = new AnimatedCharacterSprite(this, 'seren');
    this.characters.sybil = new AnimatedCharacterSprite(this, 'sybil');
    // Visibility is driven by SSE state — 'offline' hides her, anything else shows her.

    // ── Player character ───────────────────────────────────────────────
    this.player = new PlayerSprite(this);
    // Position immediately — async fetchPlayerConfig never sets position,
    // so without this the player sits at (0,0) inside the house cluster
    // until the first walk input or zone-return callback fires.
    const _initSpawn = this.tileToScreen(WorldScene.RESPAWN_TILE.tx, WorldScene.RESPAWN_TILE.ty);
    this.player.setPosition(_initSpawn.x, _initSpawn.y);
    this._lastValidX = _initSpawn.x;
    this._lastValidY = _initSpawn.y;
    this.player.setWalkBounds(TileWorld.getInstance().getWalkBounds());
    this.cameras.main.startFollow(this.player, true, 0.08, 0.08);
    this.fetchPlayerConfig();
    this.loadPlayerBuildings();

    // ── Keybinds ───────────────────────────────────────────────────────────
    this._keybinds = KeybindManager.getInstance();
    this._keybinds.init(this);

    // ── Persona AI schedulers ──────────────────────────────────────────────
    // ── Persona hub-wander AI ─────────────────────────────────────────────
    const personaNames: PersonaName[] = ['sayon', 'seren', 'sybil'];
    for (const p of personaNames) {
      const ai = new PersonaAI(p);
      // Give the AI a callback that moves the sprite
      ai.setMoveCallback((x, y) => {
        this.characters[p].setHubTarget(x, y);
      });
      this._personaAIs[p] = ai;
    }

    // ── Ally world combat AI (one per persona, starts inactive) ───────────
    this._allyWorldAIs = {
      sayon: new AllyWorldAI('sayon', 'defensive'),
      seren: new AllyWorldAI('seren', 'defensive'),
      sybil: new AllyWorldAI('sybil', 'defensive'),
    };
    // Position allies at zone-centre spawns (tile-derived, matches first HUB_WANDER waypoint)
    this._allyWorldAIs['sayon'].x = 320; this._allyWorldAIs['sayon'].y = 288;  // tile (14,22)
    this._allyWorldAIs['seren'].x = 832; this._allyWorldAIs['seren'].y = 256;  // tile (28,4)
    this._allyWorldAIs['sybil'].x = 416; this._allyWorldAIs['sybil'].y = 144;  // tile (8,10)

    // ── Training dummy — placed at tile (33, 23) in player zone ───────────
    const dummyTile = this.tileToScreen(33, 23);
    this._trainingDummy = new TrainingDummy(this, dummyTile.x, dummyTile.y);

    // ── Mineral nodes ──────────────────────────────────────────────────────
    for (const def of MINERAL_NODE_DEFS) {
      this._mineralNodes.push(new MineralNode(this, def));
    }
    this._pollMineralStatus();

    // ── Coins ──────────────────────────────────────────────────────────────
    this.coinManager = new CoinManager(this);

    // ── Interact prompt (pre-allocated, repositioned each frame) ──────────
    this._interactPrompt = this.add.text(0, 0, '', {
      fontSize: '7px', fontFamily: 'monospace',
      color: '#ffffff', stroke: '#000000', strokeThickness: 2,
      backgroundColor: '#00000088', padding: { x: 4, y: 2 },
      resolution: 4,
    }).setOrigin(0.5, 1).setDepth(30).setAlpha(0);

    // ── Register interactable buildings ───────────────────────────────────
    this._registerInteractables();

    // ── Exploration zone — generate and spawn ─────────────────────────────
    this._spawnExplorationZone();

    // ── Daily reset countdown HUD (top-right, fixed to camera) ───────────
    this._countdownHud = this.add.text(0, 0, '', {
      fontSize: '6px', fontFamily: 'monospace',
      color: '#555555', stroke: '#000000', strokeThickness: 1,
      resolution: 4,
    }).setScrollFactor(0).setDepth(50).setAlpha(0.7);
    this._updateCountdownHud();

    // Enemy counter — shown only while inside the exploration zone
    this._zoneEnemyHud = this.add.text(0, 0, '', {
      fontSize: '6px', fontFamily: 'monospace',
      color: '#cc4444', stroke: '#000000', strokeThickness: 1,
      resolution: 4,
    }).setScrollFactor(0).setDepth(50).setAlpha(0).setVisible(false);

    // Zone clear banner — centred, fades in/out on zone clear
    this._zoneClearBanner = this.add.text(0, 0, 'ZONE CLEAR', {
      fontSize: '14px', fontFamily: 'monospace',
      color: '#88ffcc', stroke: '#000000', strokeThickness: 2,
      resolution: 4,
    }).setScrollFactor(0).setDepth(60).setAlpha(0).setVisible(false);

    // Exit prompt — world-space, floats above the bridge entry tile
    const bridgeEntryPos = this.tileToScreen(EXZONE_ENTRY_TX, EXZONE_ENTRY_TY);
    this._zoneExitPrompt = this.add.text(bridgeEntryPos.x, bridgeEntryPos.y - 18, '▼ Return to Hub', {
      fontSize: '7px', fontFamily: 'monospace',
      color: '#88ffcc', stroke: '#000000', strokeThickness: 2,
      backgroundColor: '#00000088', padding: { x: 4, y: 2 },
      resolution: 4,
    }).setOrigin(0.5, 1).setDepth(30).setAlpha(0).setVisible(false);

    this.setInputEnabled(this._inputEnabled);
  }

  update(_time: number, delta: number): void {
    // ── Sync camera transform (CoordSystem reads this every frame) ─────
    const _cam = this.cameras.main;
    updateTransform(_cam.scrollX, _cam.scrollY, _cam.zoom, _cam.x, _cam.y);

    // ── Process persona state changes ──────────────────────────────────
    const personas: PersonaName[] = ['sayon', 'seren', 'sybil'];
    for (const p of personas) {
      const gs = gameStore[p];
      if (gs.changed) {
        this.characters[p].setState(gs.state);

        // SYBIL visibility — skip when she's in the party (inviteAlly owns visibility)
        if (p === 'sybil' && !this._partyMembers.has('sybil')) {
          this.characters.sybil.setVisible(gs.state !== 'offline');
        }

        // SEREN thought chamber glow intensity
        if (p === 'seren' && this._thoughtGlow) {
          const isThinking = gs.state === 'deep_thinking' || gs.state === 'extended_thinking';
          this._thoughtGlow.setFillStyle(0x3b82f6, isThinking ? 0.35 : 0.08);
        }

        // Sync to PersonaAI
        this._personaAIs[p]?.setState(gs.state);
        clearChanged(p);
      }
      // AllyWorldAI owns the char sprite while the persona is in the party.
      // Hub-mode ally block below calls char.update() after setHubTarget.
      if (!this._partyMembers.has(p)) {
        this.characters[p].update(delta);
      }
    }

    // ── Player movement ────────────────────────────────────────────────
    // During a roll the controller locks direction — suppress normal input
    // and drive the player directly along _rollDirX/Y at roll speed.
    const rollDir = this._combatController?.getRollDir?.() ?? null;
    if (rollDir) {
      const MOVE_SPEED = 120; // px/sec — must match PlayerSprite.MOVE_SPEED
      const speedMult  = this._combatController!.getSpeedMultiplier();
      const dt = delta / 1000;
      this.player.setPosition(
        this.player.x + rollDir.x * MOVE_SPEED * speedMult * dt,
        this.player.y + rollDir.y * MOVE_SPEED * speedMult * dt,
      );
      this.player.update(delta, false); // false = suppress input during roll
    } else {
      this.player.update(delta, this._inputEnabled);
    }

    // ── Player coin collection ─────────────────────────────────────────
    if (this._inputEnabled) {
      this.playerCollectTimer += delta;
      if (this.playerCollectTimer > 100) { // check 10× per second
        this.playerCollectTimer = 0;
        const collected = this.coinManager.collectAt(this.player.x, this.player.y);
        if (collected > 0) {
          this.spawnFloatText(this.player.x, this.player.y, `+${collected}`, 0xffd700);
          this.postCoinCollection(collected);
        }
      }
    }

    // ── Process pending coins ──────────────────────────────────────────
    let coin = consumeNextCoin();
    while (coin) {
      this.coinManager.spawn(coin.source, coin.value, coin.size);
      coin.consumed = true;
      coin = consumeNextCoin();
    }

    // ── Coin bob animation ─────────────────────────────────────────────
    this.coinManager.update(delta);

    // ── Auto-collect (idle personas pick up nearby coins) ──────────────
    this.autoCollectTimer += delta;
    if (this.autoCollectTimer > AUTO_COLLECT_INTERVAL) {
      this.autoCollectTimer = 0;
      for (const p of personas) {
        if (gameStore[p].state === 'idle') {
          const collected = this.coinManager.autoCollect(p);
          if (collected > 0) {
            this.postCoinCollection(collected);
          }
        }
      }
    }

    // ── Effects: void tether redraws ───────────────────────────────────
    EffectsManager.getInstance().updateTethers(delta);

    // ── Persona hub-wander AI ────────────────────────────────────────────
    for (const p of personas) {
      const ai = this._personaAIs[p];
      if (!ai || ai.frozen) continue;  // skip personas in party
      ai.update(delta);
      // Signal arrival when sprite reaches its hub target
      if (ai.mode === 'wandering' && this.characters[p].atTarget) {
        ai.onArrived();
      }
    }

    // ── Party panel toggle (P) ───────────────────────────────────────────
    if (this._inputEnabled && this._keybinds.isJustDown('party')) {
      WorldScene._onOpenParty?.();
    }

    // ── Building proximity + interact ─────────────────────────────────────
    if (this._inputEnabled && this._interactPrompt) {
      let nearest = -1;
      let nearestDist = Infinity;
      for (let i = 0; i < this._interactables.length; i++) {
        const b = this._interactables[i];
        const dx = b.worldX - this.player.x;
        const dy = b.worldY - this.player.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < b.radius && dist < nearestDist) {
          nearestDist = dist;
          nearest = i;
        }
      }
      if (nearest !== this._nearestInteractable) {
        this._nearestInteractable = nearest;
        if (nearest >= 0) {
          const b = this._interactables[nearest];
          this._interactPrompt.setText(`${this._keybinds.getKeyName('interact')} — ${b.label}`);
          this._interactPrompt.setAlpha(1);
        } else {
          this._interactPrompt.setAlpha(0);
        }
      }
      if (nearest >= 0) {
        const b = this._interactables[nearest];
        this._interactPrompt.x = b.worldX;
        this._interactPrompt.y = b.worldY - 20;
        if (this._keybinds.isJustDown('interact')) {
          b.onInteract();
        }
      }
    } else if (this._interactPrompt && this._interactPrompt.alpha > 0) {
      this._interactPrompt.setAlpha(0);
      this._nearestInteractable = -1;
    }

    // ── Garage sprite proximity swap ───────────────────────────────────────
    if (this._garageSprite) {
      const gp = this._interactables.find(b => b.label === 'GARAGE');
      if (gp) {
        const dx = gp.worldX - this.player.x;
        const dy = gp.worldY - this.player.y;
        const near = Math.sqrt(dx * dx + dy * dy) < gp.radius;
        this._garageSprite.setTexture(near ? 'building-crafting' : 'building-garage');
      }
    }

    // ── Training dummy update ─────────────────────────────────────────────
    if (this._trainingDummy) {
      this._trainingDummy.update(delta);

      // Proximity hint
      const dx = this._trainingDummy.x - this.player.x;
      const dy = this._trainingDummy.y - this.player.y;
      const distToDummy = Math.sqrt(dx * dx + dy * dy);
      this._trainingDummy.setPlayerNearby(distToDummy < 48 && this._inputEnabled);

      // R key interact — cycle element
      if (this._inputEnabled && this._keybinds.isJustDown('interact') && distToDummy < 48) {
        this._trainingDummy.cycleElement();
      }
    }

    // ── Mineral nodes update ───────────────────────────────────────────────
    if (this._inputEnabled) {
      for (const node of this._mineralNodes) {
        node.update(this.player.x, this.player.y);
        if (node.isInRange(this.player.x, this.player.y) &&
            this._keybinds.isJustDown('interact')) {
          node.harvest((success, barName) => {
            if (success) this._showHarvestToast(barName);
          });
        }
      }
    }

    // ── Combat controller update ──────────────────────────────────────────
    if (this._combatController && this._inputEnabled) {
      this._combatController.combatEnabled = this._playerInExZone;
      this._combatController.update(delta);
    }

    // ── World combat manager update ───────────────────────────────────────
    if (this._worldCombat && this._playerInExZone) {
      this._worldCombat.update(delta, this.player.x, this.player.y);
    }

    // ── Projectile update ────────────────────────────────────────────────
    if (this._projectiles) {
      this._projectiles.update(delta, (x, y) =>
        this._worldCombat ? this._worldCombat.isEnemyAtPosition(x, y, 22) : false
      );
    }

    // ── Ally world AI update ──────────────────────────────────────────────
    if (this._playerInExZone && this._worldCombat) {
      // Zone mode: full enemy-aware update
      const nearest  = this._worldCombat.getNearestLiveEnemy(this.player.x, this.player.y);
      const enemyHit = this._worldCombat.enemyHitPlayerThisFrame;

      for (const name in this._allyWorldAIs) {
        const ally = this._allyWorldAIs[name];
        if (ally.worldState === 'idle') continue;

        const result = ally.update(
          delta,
          this.player.x,  this.player.y,
          nearest ? nearest.x   : null,
          nearest ? nearest.y   : null,
          nearest ? nearest.idx : null,
          enemyHit,
        );

        if (result !== null) {
          if (result.ability !== null) {
            const ab = result.ability;
            // AoE ability — apply damage and status to all live enemies
            if (ab.aoeAll) {
              this._worldCombat.applyAllyAoeHit(result.damage, ab.statusName, ab.statusTurns, ab.statusMagnitude);
            } else {
              const died = this._worldCombat.applyAllyHit(result.targetIdx, result.damage);
              if (nearest && ab.statusName) {
                this._worldCombat.applyStatusToEnemy(result.targetIdx, ab.statusName, ab.statusTurns, ab.statusMagnitude);
              }
              if (died) {
                for (const n in this._allyWorldAIs) {
                  this._allyWorldAIs[n].notifyEnemyDead(result.targetIdx);
                }
              }
            }
            // Heal — restore player HP
            if (ab.healAmount > 0 && this._combatController) {
              this._combatController.hpCurrent = Math.min(
                this._combatController.hpMax,
                this._combatController.hpCurrent + ab.healAmount,
              );
            }
            if (nearest) this.spawnFloatText(nearest.x, nearest.y - 10, ab.flavorText, 0xcc88ff);
            if (nearest && result.damage > 0) {
              this.spawnFloatText(nearest.x, nearest.y, String(result.damage), result.isCrit ? 0xffd700 : 0x88ddff);
            }
          } else {
            const died = this._worldCombat.applyAllyHit(result.targetIdx, result.damage);
            if (nearest) this.spawnFloatText(nearest.x, nearest.y, String(result.damage), result.isCrit ? 0xffd700 : 0x88ddff);
            if (died) {
              for (const n in this._allyWorldAIs) {
                this._allyWorldAIs[n].notifyEnemyDead(result.targetIdx);
              }
            }
          }
        }
      }

      if (enemyHit && nearest) {
        for (const name in this._allyWorldAIs) {
          this._allyWorldAIs[name].notifyPlayerHit(nearest.idx);
        }
      }
    } else {
      // Hub mode: party members follow the player using their AnimatedCharacterSprite
      for (const name in this._allyWorldAIs) {
        if (!this._partyMembers.has(name)) continue;
        const ally = this._allyWorldAIs[name];
        ally.update(delta, this.player.x, this.player.y, null, null, null, false);
        // Drive the char sprite toward the ally's computed follow position,
        // then let the sprite self-animate (walk/idle) via its own update().
        const char = this.characters[name as keyof typeof this.characters];
        if (char) {
          char.setVisible(true);
          char.setHubTarget(ally.x, ally.y);
          char.update(delta);
        }
      }
    }

    // ── World loot pickup scan ────────────────────────────────────────────
    if (this._worldLoot) {
      this._worldLoot.update(delta, this.player.x, this.player.y);
    }

    // ── Zone exit prompt — show near bridge entry when zone is clear ──────
    if (this._zoneExitPrompt && this._playerInExZone) {
      this._tickZoneExitPrompt();
    }

    // ── Camera move callback — notify BuildingPlacementOverlay ────────────
    const cam = this.cameras.main;
    if (cam.scrollX !== this._lastScrollX || cam.scrollY !== this._lastScrollY) {
      this._lastScrollX = cam.scrollX;
      this._lastScrollY = cam.scrollY;
      WorldScene._onCameraMove?.(cam.scrollX, cam.scrollY);
    }

    // ── Ether pickup collection ───────────────────────────────────────────
    this._tickEtherPickups(delta);

    // ── Exploration zone guard ────────────────────────────────────────────
    this._tickZoneGuard(delta);
  }

  /** Seed the combat controller with a persisted HP value from the last session. */
  restoreHp(hp: number): void {
    if (!this._combatController) return;
    this._combatController.hpCurrent = Math.min(hp, this._combatController.hpMax);
  }

  // ── Input control (called by PhobosGame on focus toggle) ──────────
  setInputEnabled(enabled: boolean): void {
    this._inputEnabled = enabled;
    
    if (this.input?.keyboard) {
      // 1. Toggle the scene's ability to process keys
      this.input.keyboard.enabled = enabled;
      
      // 2. THE FIX: Toggle the global browser event interception
      if (enabled) {
        // Game focused: Intercept keys so they don't trigger browser defaults
        this.input.keyboard.enableGlobalCapture();
      } else {
        // UI focused: Stop intercepting, let React/DOM inputs receive WASD
        this.input.keyboard.disableGlobalCapture();
      }
    }
  }

  // ── Zoom system ──────────────────────────────────────────────────────
  private _zoom = 2;
  private _integerZoom = false;
  private _zoomMin = 1;
  private _zoomMax = 5;

  /** Set zoom level. Snaps to integer if integer mode enabled. */
  setZoom(level: number): void {
    let z = Math.max(this._zoomMin, Math.min(this._zoomMax, level));
    if (this._integerZoom) z = Math.round(z);
    this._zoom = z;
    this.cameras.main.setZoom(z);
    // Re-center after zoom change. Guard: tile loop may not have run yet on
    // the initial setZoom(2) call that fires before createTilemap().
    // Camera follow repositions automatically after zoom.
  }

  /** Toggle integer-only zoom. Snaps current zoom to nearest integer. */
  setIntegerZoom(enabled: boolean): void {
    this._integerZoom = enabled;
    if (enabled) {
      this._zoom = Math.round(this._zoom);
      this.cameras.main.setZoom(this._zoom);
      // Camera follow repositions automatically after zoom.
    }
  }

  getZoom(): number { return this._zoom; }
  getIntegerZoom(): boolean { return this._integerZoom; }

  /** Called by PhobosGame to wire mousewheel zoom. */
  setupMouseWheelZoom(): void {
    this.input.on('wheel', (_pointer: Phaser.Input.Pointer, _gos: Phaser.GameObjects.GameObject[], _dx: number, dy: number) => {
      if (!this._inputEnabled) return;
      const step = this._integerZoom ? 1 : 0.25;
      const dir = dy < 0 ? step : -step;
      this.setZoom(this._zoom + dir);
      // Notify external listener
      if (WorldScene._onZoomChanged) WorldScene._onZoomChanged(this._zoom);
    });
  }

  // External zoom change callback
  private static _instance: WorldScene | null = null;
  private static _onZoomChanged: ((zoom: number) => void) | null = null;
  static onZoomChanged(cb: (zoom: number) => void): void {
    WorldScene._onZoomChanged = cb;
  }

  private static _onCameraMove: ((scrollX: number, scrollY: number) => void) | null = null;
  static onCameraMove(cb: (scrollX: number, scrollY: number) => void): void {
    WorldScene._onCameraMove = cb;
  }
  private _lastScrollX = 0;
  private _lastScrollY = 0;

  // Zone threshold callbacks — fired when player crosses hub ↔ exploration boundary
  private static _onZoneEnter: (() => void) | null = null;
  private static _onZoneExit:  (() => void) | null = null;
  static onZoneEnter(cb: () => void): void { WorldScene._onZoneEnter = cb; }
  static onZoneExit(cb:  () => void): void { WorldScene._onZoneExit  = cb; }

  // Combat state — set by PhobosGame so the zone guard can block hub re-entry
  private static _combatActive = false;
  static setCombatActive(active: boolean): void { WorldScene._combatActive = active; }

  private _playerInExZone = false;
  private _lastValidX     = 0;
  private _lastValidY     = 0;

  // ── High performance mode ─────────────────────────────────────────
  private _highPerf = false;
  // ── High performance mode ──────────────────────────────────────────
  // Old per-scene shadow/star-tween system removed — EffectsManager owns
  // shadows and weather now. setHighPerformance() just records the flag;
  // EffectsManager was already init'd with the initial flag in create().
  // Toggling mid-session restarts the EffectsManager with the new tier.

  setHighPerformance(enabled: boolean): void {
    if (enabled === this._highPerf) return;
    this._highPerf = enabled;

    // When disabling HIGH, remove the pipeline cleanly before re-init
    // so the camera is never left in a broken state.
    if (!enabled) {
      removeDayNightFromCamera(this.cameras.main);
    }

    EffectsManager.getInstance().init(this, enabled);
  }


  // ── Player config from backend ───────────────────────────────────────
  private async _pollMineralStatus(): Promise<void> {
    const ENGINE = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
    const ids = this._mineralNodes.map(n => n.nodeId).join(',');
    try {
      const resp = await fetch(`${ENGINE}/api/game/minerals/status?nodes=${ids}`);
      if (!resp.ok) return;
      const status: Record<string, string | null> = await resp.json();
      for (const node of this._mineralNodes) {
        node.applyStatus(status[node.nodeId] ?? null);
      }
    } catch { /* silent — nodes default to available */ }
  }

  private _showHarvestToast(barName: string): void {
    const text = this.add.text(
      this.player.x, this.player.y - 32,
      `+1 ${barName}`,
      { fontSize: '7px', fontFamily: 'monospace', color: '#e0d060', stroke: '#000', strokeThickness: 2, resolution: 4 }
    ).setOrigin(0.5, 1).setDepth(20);

    this.tweens.add({
      targets:  text,
      y:        text.y - 20,
      alpha:    0,
      duration: 1200,
      ease:     'Quad.easeIn',
      onComplete: () => text.destroy(),
    });
  }

  private async fetchPlayerConfig(): Promise<void> {
    try {
      const url = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
      const resp = await fetch(`${url}/api/game/player`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.name) {
        const cls     = data.player_class ?? 'fighter';
        const body    = data.body_type    ?? 'a';
        const element = data.element      ?? 'plasma';
        this.player.swapSpriteSheet(cls, body, element);
        this.player.configure({
          name: data.name,
          element,
          weapon: data.weapon ?? 'sword',
          laserColor: data.laser_color ?? '#ffffff',
          playerClass: cls,
          bodyType: body,
          weaponAssembly: DEFAULT_WEAPON_ASSEMBLY,
        });
        // Create combat controller with full build data
        const build: import('./PlayerClasses').PlayerBuild = {
          name: data.name,
          class: cls as import('./PlayerClasses').ClassName,
          body: body as import('./PlayerClasses').BodyType,
          element: element as import('./PlayerClasses').ElementType,
          level: data.level ?? 1,
          xp: data.experience ?? 0,
          bonusPoints: {
            str: data.bonus_str ?? 0, dex: data.bonus_dex ?? 0,
            int: data.bonus_int ?? 0, agi: data.bonus_agi ?? 0,
            vit: data.bonus_vit ?? 0,
          },
          unspentPoints:  data.unspent_points ?? 5,
          skillPoints:    data.skill_points   ?? 1,
          unlockedNodes: (() => {
            try { return JSON.parse(data.unlocked_nodes ?? '[]'); }
            catch { return []; }
          })(),
        };
        this._setupCombatController(build);
      }
    } catch { /* silent — player uses defaults */ }
  }

  /** Fetch placed buildings from API, render sprites, register collision, wire interacts. */
  loadPlayerBuildings(): void {
    const ENGINE = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
    const tw = TileWorld.getInstance();

    // Tear down previous sprites and blocked tiles
    for (const sprite of this._placedMachineSprites.values()) {
      sprite.destroy();
    }
    this._placedMachineSprites.clear();

    // Unregister previously blocked footprint tiles for all placed machines
    for (const rec of this._placedMachineRecords) {
      const entry = MACHINE_BY_ID.get(rec.buildingId);
      if (!entry) continue;
      for (const { tx, ty } of getFootprintTiles(rec.anchorTx, rec.anchorTy, entry.footprintW, entry.footprintH)) {
        tw.unregisterBlocked(tx, ty);
      }
    }
    this._placedMachineRecords = [];

    // Remove previously registered machine interactables (keep permanent ones)
    this._reregisterPermanentInteractables();

    fetch(`${ENGINE}/api/game/buildings`)
      .then(r => r.json() as Promise<FetchedBuilding[]>)
      .then(buildings => {
        for (const b of buildings) {
          this._spawnPlacedBuilding(b);
        }
      })
      .catch(() => { /* silent — buildings simply don't render */ });
  }

  private _spawnPlacedBuilding(b: FetchedBuilding): void {
    const entry = MACHINE_BY_ID.get(b.building_id);
    if (!entry) return;

    const tw  = TileWorld.getInstance();
    const pos = this.tileToScreen(b.tile_x, b.tile_y);
    const SURFACE_Y = HALF_H;

    // ── Visual state ───────────────────────────────────────────────────────
    // blueprint: blue tint, 50% alpha
    // building:  desaturated, alpha scales 50%→90% with fulfillment
    // built:     full color, full alpha
    const config = this._parseConfig(b.config);
    const progress = entry.slots.length > 0 ? buildProgress(entry, config) : 1;
    const visualState = progressToState(progress);

    let alpha = 1.0;
    let tint  = 0xffffff;

    if (visualState === 'blueprint') {
      alpha = 0.5;
      tint  = 0x44aaff;
    } else if (visualState === 'building') {
      // 50% at 0 progress → 90% at 99% progress
      alpha = 0.5 + progress * 0.4;
      // Desaturate by blending toward grey (0x888888) — lerp tint channels
      const grey = 0x88;
      const r = Math.round(grey + (0xff - grey) * progress);
      tint = (r << 16) | (grey << 8) | grey;
    }

    const sprite = this.add.image(pos.x, pos.y - SURFACE_Y, entry.spriteKey)
      .setScale(1.0).setDepth(6).setOrigin(0.5, 1)
      .setAlpha(alpha).setTint(tint);

    // TST has a second sprite placed one tile to the right
    if (entry.spriteKeyB) {
      const posB = this.tileToScreen(b.tile_x + 1, b.tile_y);
      this.add.image(posB.x, posB.y - SURFACE_Y, entry.spriteKeyB)
        .setScale(1.0).setDepth(6).setOrigin(0.5, 1)
        .setAlpha(alpha).setTint(tint);
      // Note: spriteKeyB stored separately — teardown handled via _placedMachineSprites
      // only cleans the primary. Secondary is rebuilt on next loadPlayerBuildings() call.
      // Acceptable: full rebuild is always called after any placement change.
    }

    // Label only when built
    if (visualState === 'built') {
      const sourceH = this.textures.get(entry.spriteKey)?.source[0]?.height ?? 64;
      this.add.text(pos.x, pos.y - SURFACE_Y - sourceH - 2, entry.label, {
        fontSize: '6px', fontFamily: 'monospace',
        color: '#ffffff', stroke: '#000000', strokeThickness: 1, resolution: 4,
      }).setOrigin(0.5, 1).setDepth(7).setAlpha(0.85);
    }

    this._placedMachineSprites.set(b.id, sprite);

    // ── Register footprint collision ────────────────────────────────────────
    for (const { tx, ty } of getFootprintTiles(b.tile_x, b.tile_y, entry.footprintW, entry.footprintH)) {
      tw.registerBlocked(tx, ty);
    }

    // ── Track record for teardown ───────────────────────────────────────────
    this._placedMachineRecords.push({
      recordId:          b.id,
      buildingId:        b.building_id,
      anchorTx:          b.tile_x,
      anchorTy:          b.tile_y,
      state:             b.state,
      config:            b.config,
      last_collected_at: b.last_collected_at,
    });

    // ── Wire interact ───────────────────────────────────────────────────────
    // blueprint/building → supply menu via onOpenMachine
    // built building-fab → fab shop via onOpenFabShop
    // built everything else → machine menu via onOpenMachine
    this._interactables.push({
      worldX:    pos.x,
      worldY:    pos.y,
      radius:    40,
      label:     entry.label,
      onInteract: () => {
        if (b.building_id === 'building-fab' && b.state === 'built') {
          WorldScene._onOpenFabShop?.();
        } else {
          WorldScene._onOpenMachine?.({
            recordId:          b.id,
            buildingId:        b.building_id,
            anchorTx:          b.tile_x,
            anchorTy:          b.tile_y,
            state:             b.state,
            config:            b.config,
            last_collected_at: b.last_collected_at,
          });
        }
      },
    });
  }

  /** Parse config JSON safely, returning empty object on failure. */
  private _parseConfig(configJson: string): Record<string, Record<string, number>> {
    try { return JSON.parse(configJson) as Record<string, Record<string, number>>; }
    catch { return {}; }
  }

  /**
   * Remove all machine interactables and re-add only the permanent ones.
   * Called at the start of loadPlayerBuildings() to avoid stale entries.
   */
  private _reregisterPermanentInteractables(): void {
    this._registerInteractables();
  }

  /**
   * Unregister all footprint tiles for a single building by record id.
   * Used by dismantle and relocate flows before calling loadPlayerBuildings().
   */
  unregisterBlockedFootprint(recordId: string): void {
    const rec = this._placedMachineRecords.find(r => r.recordId === recordId);
    if (!rec) return;
    const entry = MACHINE_BY_ID.get(rec.buildingId);
    if (!entry) return;
    const tw = TileWorld.getInstance();
    for (const { tx, ty } of getFootprintTiles(rec.anchorTx, rec.anchorTy, entry.footprintW, entry.footprintH)) {
      tw.unregisterBlocked(tx, ty);
    }
  }

  private _setupCombatController(build: import('./PlayerClasses').PlayerBuild): void {
    this._combatController = new PlayerCombatController(this, this.player, build);

    // Initialise world combat manager (once per scene — safe to re-init on build swap)
    if (!this._worldCombat) {
      this._worldCombat = new WorldCombatManager(this);
      this._worldLoot   = new WorldLootDrop(this);
      this._projectiles = new WorldProjectilePool(this);

      // Wire controller so power-up pickups apply buffs directly
      this._worldLoot.controller = this._combatController;

      this._worldCombat.onEnemyKilled = (enemy) => {
        this._worldLoot!.spawnFromKill(
          enemy.x, enemy.y,
          enemy.template.archetype,
          enemy.template.element,
          (Math.round(enemy.x * 100) ^ Math.round(enemy.y * 100)) >>> 0,
        );
        this._updateZoneEnemyHud();

        // Boss death — remove the barrier blocking the exit passage
        if (
          (enemy.template.archetype === 'boss' || enemy.template.archetype === 'leader') &&
          this._bossBarrierTile !== null
        ) {
          this._removeBossBarrier();
          this.spawnFloatText(enemy.x, enemy.y - 12, 'PATH CLEAR', 0xff6060);
        }
      };

      this._worldCombat.onZoneClear = () => {
        this._showZoneClearBanner();
      };

      WorldScene.onZoneEnter(() => {
        // Seed enemies for every chunk in the graph
        if (this._chunkGraph) {
          const difficulty = buildDifficultyParams(this._partyMembers.size);
          for (let c = 0; c < this._chunkGraph.chunks.length; c++) {
            this._worldCombat!.seedChunk(this._chunkGraph.chunks[c], c, this._dailySeed, difficulty);
          }
        } else {
          // Fallback: single-chunk mode (should not occur with ChunkGraph active)
          this._worldCombat!.seedZone();
        }
        this._updateZoneEnemyHud();
        this._zoneEnemyHud?.setVisible(true);
        this._updateCountdownHud();
        // Hide hub sprites and spawn rect zone visuals for party members
        for (const name of this._partyMembers) {
          const ally = this._allyWorldAIs[name];
          if (ally) {
            ally.worldState = 'following';
            // Teleport rect to current sprite position before spawning
            const char = this.characters[name as keyof typeof this.characters];
            if (char) {
              ally.x = char.x;
              ally.y = char.y;
              char.setVisible(false);
            }
            ally.spawnVisual(this);
          }
        }
      });
      WorldScene.onZoneExit(() => {
        this._worldCombat!.clearZone();
        this._zoneEnemyHud?.setAlpha(0).setVisible(false);
        this._zoneExitPrompt?.setAlpha(0).setVisible(false);
        // Destroy zone rects; restore hub sprites for party members.
        for (const name in this._allyWorldAIs) {
          const ally = this._allyWorldAIs[name];
          if (!this._partyMembers.has(name)) {
            ally.destroyVisual();
            ally.worldState = 'idle';
          } else {
            ally.destroyVisual();
            ally.worldState = 'following';
            // Restore AnimatedCharacterSprite for hub following
            const char = this.characters[name as keyof typeof this.characters];
            if (char) char.setVisible(true);
          }
        }
      });
    }
    this._worldCombat.setController(this._combatController);
    this._combatController.combat = this._worldCombat;

    this._combatController.onHit = (event: HitEvent) => {
      // Fire ranged projectile visual for any ranged attack
      if (event.type === 'ranged' && this._projectiles) {
        this._projectiles.fire(
          event.originX, event.originY,
          event.aimAngle,
          this.player.laserColor,
        );
      }
      // Training dummy — always active outside zone
      if (this._trainingDummy) {
        const dx = event.worldX - this._trainingDummy.x;
        const dy = event.worldY - this._trainingDummy.y;
        if (Math.sqrt(dx * dx + dy * dy) < 60) {
          this._trainingDummy.takeDamage(event.damage, event.isCrit);
          EffectsManager.getInstance().spawnHitEffect(
            event.worldX, event.worldY,
            event.type === 'melee' ? 'slash' : 'energy',
            0xc080ff,
          );
        }
      }
      // Zone enemies — only while player is inside the exploration zone
      if (this._playerInExZone && this._worldCombat) {
        this._worldCombat.resolveHit(event);
      }
    };

    this._worldCombat.onHitLanded = (x, y, damage, isCrit) => {
      this.spawnFloatText(x, y, String(damage), isCrit ? 0xffd700 : 0xffffff);
    };

    this._combatController.onInteract = () => {
      if (!this._trainingDummy) return;
      const dx = this._trainingDummy.x - this.player.x;
      const dy = this._trainingDummy.y - this.player.y;
      if (Math.sqrt(dx * dx + dy * dy) < 48) {
        this._trainingDummy.cycleElement();
      }
    };

    this._combatController.onDeath = () => {
      this._handlePlayerDeath();
    };

    this._combatController.onWeaponBreak = (slot) => {
      this.spawnFloatText(this.player.x, this.player.y - 14, 'WEAPON BROKEN', 0xff4444);
      if (slot === 'melee') this.player.setWeaponAssembly(null);
    };
  }

  configurePlayer(config: PlayerConfig, build?: import('./PlayerClasses').PlayerBuild): void {
    if (config.playerClass && config.bodyType) {
      this.player.swapSpriteSheet(config.playerClass, config.bodyType, config.element);
    }
    // Always attach an assembly — falls back to default grey if no melee equipped
    const assembly = build?.equipment?.melee
      ? buildWeaponAssembly(build.equipment.melee)
      : DEFAULT_WEAPON_ASSEMBLY;
    this.player.configure({ ...config, weaponAssembly: assembly });
    if (build) this._setupCombatController(build);
  }

  /** Hot-swap the melee weapon sprite when equipment changes mid-session. */
  updateWeaponSprite(meleeItem: import('./ItemDefinitions').GameItem | undefined): void {
    const assembly = meleeItem ? buildWeaponAssembly(meleeItem) : DEFAULT_WEAPON_ASSEMBLY;
    this.player.setWeaponAssembly(assembly);
  }

  // ── Exploration zone guard ─────────────────────────────────────────────

  private _tickZoneGuard(delta: number): void {
    if (!this._inputEnabled) return;
    this._zoneGuardTimer += delta;
    if (this._zoneGuardTimer < 1000) return;
    this._zoneGuardTimer = 0;

    this._updateCountdownHud();

    const { tx, ty } = TileWorld.getInstance().worldToTile(this.player.x, this.player.y);
    const zone     = this.getZone(tx, ty);
    const hubZones = new Set(['player', 'plaza', 'corridor', 'sayon', 'seren', 'sybil']);
    const inExZone = ExplorationZoneManager.getInstance().isTileInZone(tx, ty);

    // Bridge tiles: registered as exploration tiles but not in zone _tileSet
    const onBridge = ty < 0 && ty > EXZONE_ENTRY_TY
      && tx >= EXZONE_BRIDGE_HUB_TX - 1
      && tx <= EXZONE_BRIDGE_HUB_TX + 1;

    const onValidTile = hubZones.has(zone) || inExZone || onBridge;

    if (onValidTile) {
      // Record last known good position for OOB recovery
      this._lastValidX = this.player.x;
      this._lastValidY = this.player.y;
    } else {
      // OOB — nudge back to last valid position, never teleport
      this.player.setPosition(this._lastValidX, this._lastValidY);
      return;
    }

    // Zone threshold — fire callbacks on state change only
    if (inExZone && !this._playerInExZone) {
      this._playerInExZone = true;
      WorldScene._onZoneEnter?.();
    } else if (!inExZone && !onBridge && this._playerInExZone) {
      if (WorldScene._combatActive) {
        const bridge = this.tileToScreen(EXZONE_ENTRY_TX, EXZONE_ENTRY_TY);
        this.player.setPosition(bridge.x, bridge.y);
        this.spawnFloatText(bridge.x, bridge.y, 'FINISH COMBAT FIRST', 0xff6060);
        return;
      }
      this._playerInExZone = false;
      WorldScene._onZoneExit?.();
    }
  }

  private _teleportToRespawn(): void {
    const respawn = this.tileToScreen(WorldScene.RESPAWN_TILE.tx, WorldScene.RESPAWN_TILE.ty);
    this.player.setPosition(respawn.x, respawn.y);
    this._lastValidX = respawn.x;
    this._lastValidY = respawn.y;
  }

  private _updateCountdownHud(): void {
    if (!this._countdownHud) return;
    const now  = new Date();
    const msUntilMidnight =
      (23 - now.getHours()) * 3600000 +
      (59 - now.getMinutes()) * 60000 +
      (59 - now.getSeconds()) * 1000;
    const h = Math.floor(msUntilMidnight / 3600000);
    const m = Math.floor((msUntilMidnight % 3600000) / 60000);
    const s = Math.floor((msUntilMidnight % 60000) / 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    this._countdownHud.setText(`RESET ${pad(h)}:${pad(m)}:${pad(s)}`);
    // Position top-right, 8px from edges — recalculate each tick in case of resize
    const cam = this.cameras.main;
    this._countdownHud.setPosition(
      cam.width  - this._countdownHud.width  - 8,
      8,
    );
    if (this._zoneLabelHud) {
      this._zoneLabelHud.setPosition(
        cam.width - this._zoneLabelHud.width - 8,
        8 + (this._countdownHud.height ?? 8) + 2,
      );
    }
    if (this._zoneEnemyHud && this._zoneEnemyHud.visible) {
      const labelBottom = 8
        + (this._countdownHud.height ?? 8) + 2
        + (this._zoneLabelHud?.height ?? 8) + 2;
      this._zoneEnemyHud.setPosition(
        cam.width - this._zoneEnemyHud.width - 8,
        labelBottom,
      );
    }
  }

  private _updateZoneEnemyHud(): void {
    if (!this._zoneEnemyHud || !this._worldCombat) return;
    const count = this._worldCombat.liveCount;
    this._zoneEnemyHud.setText(`ENEMIES: ${count}`);
    this._zoneEnemyHud.setAlpha(count > 0 ? 0.8 : 0.4);
    this._updateCountdownHud(); // reflow position
  }

  private _showZoneClearBanner(): void {
    this._updateZoneEnemyHud();
    const banner = this._zoneClearBanner;
    if (!banner) return;
    const cam = this.cameras.main;
    banner
      .setPosition(
        (cam.width  - banner.width)  / 2,
        (cam.height - banner.height) / 2 - 20,
      )
      .setAlpha(0)
      .setVisible(true);

    this.tweens.add({
      targets:  banner,
      alpha:    { from: 0, to: 1 },
      duration: 400,
      ease:     'Sine.easeOut',
      onComplete: () => {
        this.tweens.add({
          targets:  banner,
          alpha:    { from: 1, to: 0 },
          duration: 600,
          delay:    1800,
          ease:     'Sine.easeIn',
          onComplete: () => { banner.setVisible(false); },
        });
      },
    });
  }

  private _tickZoneExitPrompt(): void {
    const prompt = this._zoneExitPrompt;
    if (!prompt) return;

    const zoneClear = (this._worldCombat?.liveCount ?? 1) === 0;
    if (!zoneClear) {
      // Zone not clear — keep hidden, no need to check proximity
      if (prompt.visible) prompt.setAlpha(0).setVisible(false);
      return;
    }

    // Zone is clear — fade in when player is within 3 tiles of bridge entry
    const bridgePos = this.tileToScreen(EXZONE_ENTRY_TX, EXZONE_ENTRY_TY);
    const dx = this.player.x - bridgePos.x;
    const dy = this.player.y - bridgePos.y;
    const distSq = dx * dx + dy * dy;
    const PROMPT_RANGE_SQ = (48 * 3) * (48 * 3); // 3-tile radius in world px

    if (distSq < PROMPT_RANGE_SQ) {
      if (!prompt.visible) {
        prompt.setVisible(true);
        this.tweens.add({
          targets: prompt, alpha: { from: 0, to: 1 },
          duration: 300, ease: 'Sine.easeOut',
        });
      }
    } else {
      if (prompt.visible && prompt.alpha > 0) {
        this.tweens.add({
          targets: prompt, alpha: { from: prompt.alpha, to: 0 },
          duration: 200, ease: 'Sine.easeIn',
          onComplete: () => { prompt.setVisible(false); },
        });
      }
    }
  }

  // ── Death + respawn ───────────────────────────────────────────────────────

  private _tickEtherPickups(delta: number): void {
    if (this._etherPickups.length === 0) return;
    this._etherPickupTimer += delta;
    if (this._etherPickupTimer < 120) return; // check ~8× per second
    this._etherPickupTimer = 0;
    for (let i = this._etherPickups.length - 1; i >= 0; i--) {
      const p = this._etherPickups[i];
      if (p.tryCollect(this.player.x, this.player.y)) {
        this.spawnFloatText(this.player.x, this.player.y, `◆+${p.amount}`, 0xc4b5fd);
        this._persistEtherPickup(p.amount);
        this._etherPickups.splice(i, 1);
      }
    }
  }

  private async _handlePlayerDeath(): Promise<void> {
    // Lock input immediately — no actions while dead
    this._inputEnabled = false;

    const ENGINE = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

    // Clear persisted HP — respawn always starts at full
    fetch(`${ENGINE}/api/game/player/hp`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ hp: null }),
    }).catch(() => {});

    // Fetch current held ether
    let etherHeld = 0;
    try {
      const r = await fetch(`${ENGINE}/api/game/ether/bank`);
      const d = await r.json();
      etherHeld = d.ether_held ?? 0;
    } catch { /* proceed with 0 */ }

    // Drop 10–30% of held ether as a world pickup at death position
    if (etherHeld > 0) {
      const pct    = 0.10 + Math.random() * 0.20;
      const drop   = Math.max(1, Math.round(etherHeld * pct));
      const remain = etherHeld - drop;

      // Write reduced held amount back immediately
      try {
        await fetch(`${ENGINE}/api/game/player`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ether_held: remain }),
        });
      } catch { /* best-effort */ }

      // Spawn pickup at death tile
      const pickup = new EtherPickup(this, this.player.x, this.player.y, drop);
      this._etherPickups.push(pickup);
    }

    // Play death animation — locks sprite until resetFromDeath()
    this.player.playDie();

    // Respawn at house tile after short delay
    const respawn = this.tileToScreen(
      WorldScene.RESPAWN_TILE.tx,
      WorldScene.RESPAWN_TILE.ty,
    );
    this._lastValidX = respawn.x;
    this._lastValidY = respawn.y;
    this.time.delayedCall(900, () => {
      this.player.setPosition(respawn.x, respawn.y);
      this.player.resetFromDeath();
      if (this._combatController) {
        this._combatController.hpCurrent = this._combatController.hpMax;
        this._combatController.moveState = 'free';
      }
      this._inputEnabled = true;
    });
  }

  /** Re-adds collected pickup ether to player's held pool. */
  private async _persistEtherPickup(amount: number): Promise<void> {
    const ENGINE = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
    try {
      const r = await fetch(`${ENGINE}/api/game/ether/bank`);
      const d = await r.json();
      const newHeld = (d.ether_held ?? 0) + amount;
      await fetch(`${ENGINE}/api/game/player`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ether_held: newHeld }),
      });
    } catch { /* best-effort */ }
  }

  // ── Tilemap construction ─────────────────────────────────────────────

  /**
   * Reinitialise TileWorld to WorldScene's coordinate space and re-register all
   * hub walkable tiles. Does NOT create any Phaser images — tiles already exist.
   * Call this on scene wake after ArenaScene has clobbered the TileWorld singleton.
   */
  private _rebuildTileWorldData(): void {
    TileWorld.getInstance().reinit(HALF_W, HALF_H, MAP_H * HALF_W, TILEWORLD_W, TILEWORLD_H);
    const tw = TileWorld.getInstance();
    for (let ty = 0; ty < MAP_H; ty++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        if (this.getZone(tx, ty) !== 'void') tw.registerTile(tx, ty);
      }
    }
    // Re-register the north corridor tiles (mirrors createTilemap corridor block)
    for (let ty = 0; ty <= 7; ty++) {
      for (let tx = 18; tx <= 20; tx++) {
        tw.registerTile(tx, ty);
      }
    }
    tw.seal();
    this._applyTileWorldBounds();
  }

  private createTilemap(): void {
    const rng = this.createSeededRandom(42);

    for (let ty = 0; ty < MAP_H; ty++) {
      for (let tx = 0; tx < MAP_W; tx++) {
        const zone = this.getZone(tx, ty);

        // Void tiles are not placed and not walkable — skip entirely.
        if (zone === 'void') continue;

        const { x, y } = this.tileToScreen(tx, ty);
        const frameIndex = this.pickTileFrame(tx, ty, rng);

        const tile = this.add.image(x, y, 'moon-tiles', frameIndex)
          .setDepth(1)
          .setOrigin(0.5, 0.5);

        tile.setTint(this.getZoneTint(tx, ty));
        TileWorld.getInstance().registerTile(tx, ty);
      }
    }
    // ── North corridor — permanent hub tiles connecting plaza to exploration bridge ──
    // Plaza north edge is ty=8. Bridge (exploration, registered separately) starts at ty=-1.
    // Columns tx=18–20 are void in all zone definitions; fill ty=0–7 as hub tiles.
    // Tint graduates from TINT_PLAZA at ty=7 (blends into plaza) to bridge dark at ty=0.
    const CORRIDOR_CX   = 19;
    const CORRIDOR_TINTS: Record<number, number> = {
      7: TINT_PLAZA,   // flush with plaza — same grey
      6: 0x888888,
      5: 0x707070,
      4: 0x585858,
      3: 0x404040,
      2: 0x303048,
      1: 0x252538,
      0: 0x1e1e2e,     // matches bridge tint at handoff
    };
    for (let ty = 0; ty <= 7; ty++) {
      for (let tx = CORRIDOR_CX - 1; tx <= CORRIDOR_CX + 1; tx++) {
        const { x, y } = this.tileToScreen(tx, ty);
        const frameIndex = this.pickTileFrame(tx, ty, rng);
        this.add.image(x, y, 'moon-tiles', frameIndex)
          .setDepth(1).setOrigin(0.5, 0.5).setTint(CORRIDOR_TINTS[ty]);
        TileWorld.getInstance().registerTile(tx, ty);
      }
    }

    TileWorld.getInstance().seal();
  }

  private pickTileFrame(_tx: number, _ty: number, rng: () => number): number {
    // 7 cols × 8 rows = 56 frames. Row 0: frames 0-6, Row 1: 7-13, etc.
    // Use ground tiles from first two rows (0-13) with occasional variation
    const groundTiles = [0, 1, 2, 3, 7, 8, 9, 10];
    const r = rng();
    if (r < 0.7) {
      return groundTiles[Math.floor(rng() * groundTiles.length)];
    } else if (r < 0.9) {
      return groundTiles[Math.floor(rng() * 4)]; // first 4 variants
    } else {
      // Occasional detailed tile from rows 3-4 (frames 21-34)
      return 21 + Math.floor(rng() * 14);
    }
  }

  private getZone(tx: number, ty: number): string {
    if (tx >= ZONES.corridor.x1 && tx <= ZONES.corridor.x2 && ty >= ZONES.corridor.y1 && ty <= ZONES.corridor.y2) return 'corridor';
    if (tx >= ZONES.plaza.x1 && tx <= ZONES.plaza.x2 && ty >= ZONES.plaza.y1 && ty <= ZONES.plaza.y2) return 'plaza';
    if (tx >= ZONES.sybil.x1 && tx <= ZONES.sybil.x2 && ty >= ZONES.sybil.y1 && ty <= ZONES.sybil.y2) return 'sybil';
    if (tx >= ZONES.seren.x1 && tx <= ZONES.seren.x2 && ty >= ZONES.seren.y1 && ty <= ZONES.seren.y2) return 'seren';
    if (tx >= ZONES.sayon.x1 && tx <= ZONES.sayon.x2 && ty >= ZONES.sayon.y1 && ty <= ZONES.sayon.y2) return 'sayon';
    if (tx >= ZONES.player.x1 && tx <= ZONES.player.x2 && ty >= ZONES.player.y1 && ty <= ZONES.player.y2) return 'player';
    return 'void';
  }

  private getZoneTint(tx: number, ty: number): number {
    switch (this.getZone(tx, ty)) {
      case 'sayon':  return TINT_SAYON;
      case 'seren':  return TINT_SEREN;
      case 'sybil':  return TINT_SYBIL;
      case 'player': return TINT_PLAYER;
      case 'plaza':  return TINT_PLAZA;
      default:       return TINT_NONE;
    }
  }

  // ── Isometric projection ─────────────────────────────────────────────

  private tileToScreen(tx: number, ty: number): { x: number; y: number } {
    return TileWorld.getInstance().tileToWorld(tx, ty);
  }

  /**
   * Apply camera bounds and map center derived from the sealed TileWorld.
   * Called once after createTilemap(), and wires the resize listener.
   */
  private _applyTileWorldBounds(): void {
    const tw = TileWorld.getInstance();
    const cb = tw.getCameraBounds();
    this.cameras.main.setBounds(cb.x, cb.y, cb.width, cb.height);
    // Walk bounds expand with each reseal — player must receive the updated
    // bounds or movement clamps at the stale boundary and the camera appears frozen.
    if (this.player) {
      this.player.setWalkBounds(tw.getWalkBounds());
    }
  }

  // ── Exploration zone ──────────────────────────────────────────────────────

  private _spawnExplorationZone(): void {
    const tw  = TileWorld.getInstance();
    this._dailySeed = Math.floor(Date.now() / 86400000);

    // ── Three-tier zone graph ─────────────────────────────────────────────
    const zoneGraph = generateZoneGraph(this._dailySeed);
    this._spawnZoneGraph(zoneGraph);
    // Note: _spawnZoneGraph calls tw.reseal() + _applyTileWorldBounds() internally.

    // Legacy chunk graph — retained for WorldCombatManager.seedChunk() until
    // enemy seeding is migrated to SpawnMarker-based placement in Phase B.
    const ezm = ExplorationZoneManager.getInstance();
    this._chunkGraph = ezm.getDailyChunkGraph();

    // Hub entry bridge — 3-wide tile strip from hub edge (ty=-1) to zone entry
    const BRIDGE_CX   = EXZONE_ENTRY_TX;
    const BRIDGE_TINT = 0x1a1a2e;
    for (let by = -1; by >= EXZONE_ENTRY_TY; by--) {
      for (let bx = BRIDGE_CX - 1; bx <= BRIDGE_CX + 1; bx++) {
        const { x, y } = this.tileToScreen(bx, by);
        this.add.image(x, y, 'moon-tiles', 7)
          .setDepth(3).setOrigin(0.5, 0.5).setTint(BRIDGE_TINT);
        tw.registerExplorationTile(bx, by);
      }
    }
    for (let by = -1; by >= EXZONE_ENTRY_TY; by--) {
      for (const bx of [BRIDGE_CX - 1, BRIDGE_CX + 1]) {
        const { x, y } = this.tileToScreen(bx, by);
        const rail = this.add.rectangle(x, y - 2, 6, 2, 0x22c5c5, 0.5).setDepth(4);
        this.tweens.add({
          targets: rail,
          alpha: { from: 0.2, to: 0.7 },
          duration: 1400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
          delay: by * -200,
        });
      }
    }

    // Reseal again to include the bridge tiles registered above
    tw.reseal();
    this._applyTileWorldBounds();

    // Portal sprites at hub entrance
    const firstTint = zoneGraph.def.tint;
    const portalPos = this.tileToScreen(EXZONE_BRIDGE_HUB_TX, EXZONE_BRIDGE_HUB_TY);
    this.placeStructureTile(EXZONE_BRIDGE_HUB_TX,     EXZONE_BRIDGE_HUB_TY,     35, firstTint, 5);
    this.placeStructureTile(EXZONE_BRIDGE_HUB_TX + 1, EXZONE_BRIDGE_HUB_TY,     36, firstTint, 5);
    this.placeStructureTile(EXZONE_BRIDGE_HUB_TX,     EXZONE_BRIDGE_HUB_TY + 1, 42, firstTint, 5);
    this.placeStructureTile(EXZONE_BRIDGE_HUB_TX + 1, EXZONE_BRIDGE_HUB_TY + 1, 43, firstTint, 5);
    const portalGlow = this.add.circle(
      portalPos.x + 8, portalPos.y + 4, 14, firstTint, 0.2,
    ).setDepth(4);
    this.tweens.add({
      targets: portalGlow,
      alpha: { from: 0.08, to: 0.35 },
      scaleX: { from: 1.0, to: 1.3 }, scaleY: { from: 1.0, to: 1.3 },
      duration: 2000, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });

    // Zone label HUD
    this._zoneLabelHud = this.add.text(0, 0, `ZONE: ${zoneGraph.def.label}`, {
      fontSize: '6px', fontFamily: 'monospace',
      color: '#555555', stroke: '#000000', strokeThickness: 1,
      resolution: 4,
    }).setScrollFactor(0).setDepth(50).setAlpha(0.7);
  }

  /**
   * Render one chunk: ground tiles, structures, glows.
   * Tiles are offset by the chunk's world position relative to the single-chunk origin.
   */
  private _spawnChunk(chunk: ChunkSpec, chunkSeed: number): ZoneSpec {
    const ezm = ExplorationZoneManager.getInstance();
    const tw  = TileWorld.getInstance();

    // Generate this chunk's visual spec without clobbering the manager's tile set
    const spec = ezm.generateSpecOnly(chunkSeed);

    // Offset from single-chunk coordinate origin to this chunk's world position
    const dTx = chunk.offsetTx - EXZONE_ENTRY_TX + ZONE_HALF_W;
    const dTy = chunk.offsetTy - EXZONE_ENTRY_TY;

    const worldTiles: Array<{ tx: number; ty: number }> = [];
    for (const t of spec.tiles) {
      const wtx = t.tx + dTx;
      const wty = t.ty + dTy;
      const { x, y } = this.tileToScreen(wtx, wty);
      this.add.image(x, y, 'moon-tiles', t.frame)
        .setDepth(1).setOrigin(0.5, 0.5).setTint(spec.tint);
      tw.registerExplorationTile(wtx, wty);
      worldTiles.push({ tx: wtx, ty: wty });
    }
    ezm.registerChunkTiles(worldTiles);

    for (const s of spec.structures) {
      this.placeStructureTile(s.tx + dTx, s.ty + dTy, s.frame, s.tint, s.depth);
    }

    for (const g of spec.glows) {
      const { x, y } = this.tileToScreen(g.tx + dTx, g.ty + dTy);
      const glow = this.add.circle(x, y, g.radius, g.color, g.alpha).setDepth(4);
      this.tweens.add({
        targets: glow,
        alpha:   { from: g.alpha * 0.4, to: g.alpha },
        scaleX:  { from: 1.0, to: 1.2 }, scaleY: { from: 1.0, to: 1.2 },
        duration: 2500, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      });
    }

    return spec;
  }

  /**
   * Render a 3-wide corridor connecting two chunks vertically.
   * Spans from fromTy to toTy, centred on bridgeTx.
   */
  private _spawnInterChunkCorridor(
    bridgeTx: number, fromTy: number, toTy: number, tint: number,
  ): void {
    const tw    = TileWorld.getInstance();
    const minTy = Math.min(fromTy, toTy);
    const maxTy = Math.max(fromTy, toTy);
    for (let by = minTy; by <= maxTy; by++) {
      for (let bx = bridgeTx - 1; bx <= bridgeTx + 1; bx++) {
        const { x, y } = this.tileToScreen(bx, by);
        this.add.image(x, y, 'moon-tiles', 7)
          .setDepth(3).setOrigin(0.5, 0.5).setTint(tint);
        tw.registerExplorationTile(bx, by);
      }
      for (const bx of [bridgeTx - 1, bridgeTx + 1]) {
        const { x, y } = this.tileToScreen(bx, by);
        const rail = this.add.rectangle(x, y - 2, 6, 2, 0x22c5c5, 0.4).setDepth(4);
        this.tweens.add({
          targets: rail,
          alpha: { from: 0.15, to: 0.6 },
          duration: 1600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
          delay: by * -150,
        });
      }
    }
  }


  // ── Three-Tier Room Renderer ──────────────────────────────────────────────

  /**
   * Render a placed RoomInstance: ground tiles, structure tiles, glow rails on
   * corridor-frame tiles. Registers all ground tiles as exploration tiles in
   * TileWorld and registers blocked structures.
   *
   * All coordinates are LOCAL to the room; worldOffsetTx/Ty translates them
   * to world tile space before any Phaser or TileWorld call.
   */
  private _spawnRoom(room: RoomInstance): void {
    const tw   = TileWorld.getInstance();
    const ezm  = ExplorationZoneManager.getInstance();
    const tint = room.def.zone_act === 2 ? 0x141414 : 0x111122;

    // Ground tiles
    const worldTiles: Array<{ tx: number; ty: number }> = [];
    for (const t of room.def.tiles) {
      const wtx = t.tx + room.worldOffsetTx;
      const wty = t.ty + room.worldOffsetTy;
      const { x, y } = this.tileToScreen(wtx, wty);
      this.add.image(x, y, 'moon-tiles', t.frame)
        .setDepth(1).setOrigin(0.5, 0.5).setTint(tint);
      tw.registerExplorationTile(wtx, wty);
      worldTiles.push({ tx: wtx, ty: wty });
    }
    ezm.registerChunkTiles(worldTiles);

    // Structure tiles
    for (const s of room.def.structures) {
      const wtx = s.tx + room.worldOffsetTx;
      const wty = s.ty + room.worldOffsetTy;
      this.placeStructureTile(wtx, wty, s.frame, s.tint, s.depth);
      if (s.blocked) {
        tw.registerBlocked(wtx, wty);
      }
    }
  }

  /**
   * Render a CorridorSpec: 3-wide tile strip with glow rails on each edge column.
   * Registers all corridor tiles as exploration tiles.
   */
  private _spawnRoomCorridor(corridor: CorridorSpec): void {
    const tw  = TileWorld.getInstance();
    const ezm = ExplorationZoneManager.getInstance();

    const worldTiles: Array<{ tx: number; ty: number }> = [];
    for (const t of corridor.tiles) {
      const { x, y } = this.tileToScreen(t.tx, t.ty);
      this.add.image(x, y, 'moon-tiles', t.frame)
        .setDepth(3).setOrigin(0.5, 0.5).setTint(corridor.tint);
      tw.registerExplorationTile(t.tx, t.ty);
      worldTiles.push({ tx: t.tx, ty: t.ty });
    }
    ezm.registerChunkTiles(worldTiles);

    // Glow rails: edge columns of the corridor strip
    // Find the unique edge tx values for a vertical corridor (min and max tx in tile set)
    let minTx = Infinity, maxTx = -Infinity;
    for (const t of corridor.tiles) {
      if (t.tx < minTx) minTx = t.tx;
      if (t.tx > maxTx) maxTx = t.tx;
    }
    const edgeTxSet = new Set([minTx, maxTx]);
    for (const t of corridor.tiles) {
      if (!edgeTxSet.has(t.tx)) continue;
      const { x, y } = this.tileToScreen(t.tx, t.ty);
      const rail = this.add.rectangle(x, y - 2, 6, 2, 0x22c5c5, 0.4).setDepth(4);
      this.tweens.add({
        targets: rail,
        alpha: { from: 0.15, to: 0.6 },
        duration: 1600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
        delay: t.ty * -150,
      });
    }
  }

  /**
   * Spawn a fully assembled ZoneGraph: all regions → rooms → corridors.
   * Replaces _spawnChunk/_spawnInterChunkCorridor for the three-tier path.
   * Boss barrier is placed at ZoneGraph.bossTile after all tiles are registered.
   */
  private _spawnZoneGraph(graph: ZoneGraph): void {
    const tw = TileWorld.getInstance();

    for (const region of graph.regions) {
      for (const room of region.rooms) {
        this._spawnRoom(room);
      }
      for (const corridor of region.corridors) {
        this._spawnRoomCorridor(corridor);
      }
    }

    // Boss barrier — placed at the north edge of the last boss room
    if (graph.bossTile) {
      this._bossBarrierTile = graph.bossTile;
      this._spawnBossBarrier(graph.bossTile.tx, graph.bossTile.ty);
    }

    // Reseal camera and walk bounds to include all new tiles
    tw.reseal();
    this._applyTileWorldBounds();
  }

  /**
   * Spawn the boss barrier at the given tile.
   * Blocks passage northward until _removeBossBarrier() is called on boss death.
   */
  private _spawnBossBarrier(tx: number, ty: number): void {
    const { x, y } = this.tileToScreen(tx, ty);
    this._bossBarrierImage = this.placeStructureTile(tx, ty, 14, 0x3a0000, 6);
    this._bossBarrierGlow  = this.add.circle(x, y, 20, 0xff2020, 0.25).setDepth(5);
    this.tweens.add({
      targets:  this._bossBarrierGlow,
      alpha:    { from: 0.1, to: 0.4 },
      scaleX:   { from: 0.9, to: 1.2 }, scaleY: { from: 0.9, to: 1.2 },
      duration: 1200, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });
    TileWorld.getInstance().registerBlocked(tx, ty);
  }

  /** Called on boss death — removes the barrier and unblocks the tile. */
  private _removeBossBarrier(): void {
    if (this._bossBarrierImage) { this._bossBarrierImage.destroy(); this._bossBarrierImage = null; }
    if (this._bossBarrierGlow)  { this._bossBarrierGlow.destroy();  this._bossBarrierGlow  = null; }
    if (this._bossBarrierTile)  {
      TileWorld.getInstance().unregisterBlocked(this._bossBarrierTile.tx, this._bossBarrierTile.ty);
      this._bossBarrierTile = null;
    }
  }

  // ── Zone structures ───────────────────────────────────────────────────

  private createZoneStructures(): void {
    // ── SAYON zone ────────────────────────────────────────────────────────
    // Relay Tower — 2 tileset tiles, amber blink
    this.placeStructureTile(12, 20, 21, TINT_SAYON, 5);
    this.placeStructureTile(12, 19, 28, TINT_SAYON, 6);
    const relayPos = this.tileToScreen(12, 19);
    const relayDot = this.add.circle(relayPos.x, relayPos.y - 14, 2, 0xf59e0b, 0.2).setDepth(7);
    this.tweens.add({ targets: relayDot, alpha: { from: 0.2, to: 1.0 }, duration: 1500, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });

    // Dispatch Desk
    this.placeStructureTile(14, 22, 7, TINT_SAYON, 5);
    this.placeLabel(14, 22, 'DESK', 4);

    // ── SEREN zone ────────────────────────────────────────────────────────
    // Crystal Lab (3×2)
    this.placeStructureTile(30, 4, 21, TINT_SEREN, 5);
    this.placeStructureTile(31, 4, 22, TINT_SEREN, 5);
    this.placeStructureTile(32, 4, 21, TINT_SEREN, 5);
    this.placeStructureTile(30, 5, 14, TINT_SEREN, 5);
    this.placeStructureTile(31, 5, 15, TINT_SEREN, 5);
    this.placeStructureTile(32, 5, 14, TINT_SEREN, 5);

    // Thought Chamber (2×2, pulsing glow)
    this.placeStructureTile(34, 6, 28, TINT_SEREN, 5);
    this.placeStructureTile(35, 6, 29, TINT_SEREN, 5);
    this.placeStructureTile(34, 7, 35, TINT_SEREN, 5);
    this.placeStructureTile(35, 7, 36, TINT_SEREN, 5);
    const chamberPos = this.tileToScreen(34, 6);
    this._thoughtGlow = this.add.circle(chamberPos.x + 8, chamberPos.y - 4, 18, 0x3b82f6, 0.08).setDepth(4);
    this.tweens.add({ targets: this._thoughtGlow, alpha: { from: 0.08, to: 0.25 }, duration: 3000, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });

    // Telescope
    this.placeStructureTile(28, 8, 42, TINT_SEREN, 5);
    const scopePos = this.tileToScreen(28, 8);
    const scopeLine = this.add.rectangle(scopePos.x, scopePos.y - 6, 16, 1, 0x60a5fa, 0.5).setDepth(6).setOrigin(0, 0.5);
    this.tweens.add({ targets: scopeLine, angle: 360, duration: 20000, repeat: -1 });

    // ── SYBIL zone ────────────────────────────────────────────────────────
    // Archive Mound (3×2, violet glow)
    this.placeStructureTile(4, 4, 35, TINT_SYBIL, 5);
    this.placeStructureTile(5, 4, 28, TINT_SYBIL, 5);
    this.placeStructureTile(6, 4, 36, TINT_SYBIL, 5);
    this.placeStructureTile(4, 5, 14, TINT_SYBIL, 5);
    this.placeStructureTile(5, 5, 21, TINT_SYBIL, 6);
    this.placeStructureTile(6, 5, 15, TINT_SYBIL, 5);
    const moundPos = this.tileToScreen(5, 5);
    const moundGlow = this.add.ellipse(moundPos.x, moundPos.y + 4, 40, 10, 0x8b5cf6, 0.12).setDepth(4);
    this.tweens.add({ targets: moundGlow, alpha: { from: 0.06, to: 0.18 }, duration: 2500, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });

    // Catalogue Table
    this.placeStructureTile(8, 10, 7, TINT_SYBIL, 5);
    this.placeLabel(8, 10, 'CATALOGUE', 4);

    // ── Plaza — Obelisk ───────────────────────────────────────────────────
    this.placeStructureTile(20, 13, 28, TINT_PLAZA, 5);
    const obeliskPos = this.tileToScreen(20, 13);
    const obeliskTop = this.add.image(obeliskPos.x, obeliskPos.y - 20, 'moon-tiles', 42).setDepth(6).setTint(0xd0d0d0).setAlpha(0.7);
    this.tweens.add({ targets: obeliskTop, alpha: { from: 0.3, to: 0.7 }, duration: 4000, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });

    // ── Sayon zone — Portal ───────────────────────────────────────────────
    // Placed at (6–7, 24–25) — inside sayon zone (x1:6, y1:16, x2:20, y2:27)
    this.placeStructureTile(6, 24, 35, 0x6030c0, 5);
    this.placeStructureTile(7, 24, 36, 0x6030c0, 5);
    this.placeStructureTile(6, 25, 42, 0x6030c0, 5);
    this.placeStructureTile(7, 25, 43, 0x6030c0, 5);
    const portalPos = this.tileToScreen(6, 24);
    const portalGlow = this.add.circle(portalPos.x + 8, portalPos.y + 4, 14, 0x9060ff, 0.15).setDepth(4);
    this.tweens.add({ targets: portalGlow, alpha: { from: 0.08, to: 0.3 }, scaleX: { from: 1.0, to: 1.3 }, scaleY: { from: 1.0, to: 1.3 }, duration: 2000, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    this.placeLabel(6, 24, 'PORTAL', 8);

    // ── Plaza — Battle Hall ───────────────────────────────────────────────
    this.placeStructureTile(36, 24, 21, 0xa03030, 5);
    this.placeStructureTile(37, 24, 22, 0xa03030, 5);
    this.placeStructureTile(36, 25, 28, 0xa03030, 5);
    this.placeStructureTile(37, 25, 29, 0xa03030, 5);
    this.placeLabel(36, 24, 'BATTLE HALL', 8);

    // ── Zone structure collision ───────────────────────────────────────────
    // Driven by ZONE_STRUCTURES table — nudgeable from dev panel.
    const tw = TileWorld.getInstance();
    for (const s of ZONE_STRUCTURES) {
      for (const { tx, ty } of getFootprintTiles(s.anchorTx, s.anchorTy, s.footprintW, s.footprintH)) {
        tw.registerBlocked(tx, ty);
      }
    }

    // ── Player zone — buildings (real PNG sprites) ────────────────────────
    // Source dimensions (KipperFalcon isometric pack, measured):
    //   ControlBase: 64×64   ProducerBuilding_Empty/Full: 80×80
    //   StorageContainer: 80×64   Uncharged_zone: 112×80
    // tileToScreen() returns the tile diamond centre. The iso tile top face sits
    // at y - HALF_H (y - 8). All building PNGs fill to the bottom pixel,
    // so origin(0.5, 1) + Y = tileY - 8 seats the building base on the tile top.
    // Scale targets: buildings ≈ 1× their natural pixel width (~2 tile-widths at 32px/tile).
    const TILE_SURFACE_Y = HALF_H;  // 8px — lift above tile centre to hit top face

    // ControlBase 64×64 → display at 1.0× = 64px wide (2 tile-widths)
    const housePos = this.tileToScreen(30, 20);
    this.placeBuildingSprite('building-house', housePos.x, housePos.y - TILE_SURFACE_Y, 1.0, 'HOUSE', 6);

    // StorageContainer 80×64 → display at 1.0× = 80px wide
    const garagePos = this.tileToScreen(33, 20);
    this._garageSprite = this.add.image(garagePos.x, garagePos.y - TILE_SURFACE_Y, 'building-garage')
      .setScale(1.0).setDepth(6).setOrigin(0.5, 1);
    this.placeLabel(33, 20, 'GARAGE', 24);

    // StorageContainer_opened 80×64
    const craftPos = this.tileToScreen(30, 23);
    this.placeBuildingSprite('building-crafting', craftPos.x, craftPos.y - TILE_SURFACE_Y, 1.0, 'CRAFTING', 6);

    // ProducerBuilding_Empty 80×80 → slightly scaled down to not crowd plaza
    const shopPos = this.tileToScreen(19, 14);
    this.placeBuildingSprite('building-shop', shopPos.x, shopPos.y - TILE_SURFACE_Y, 0.9, 'SHOP', 6);

    // NOTE: Frictionless Fab is player-placed — not spawned here.
    // Tile (36,20)–(37,21) is open player zone space.

    // Uncharged_zone 112×80 — wide landing pad, scale to 0.8 to fit plaza edge
    const gatewayPos = this.tileToScreen(21, 16);
    this.placeBuildingSprite('building-gateway', gatewayPos.x, gatewayPos.y - TILE_SURFACE_Y, 0.8, 'SPACE GATEWAY', 6);
    const gatewayGlow = this.add.ellipse(gatewayPos.x, gatewayPos.y + 2, 56, 14, 0x60a5fa, 0.12).setDepth(4);
    this.tweens.add({ targets: gatewayGlow, alpha: { from: 0.06, to: 0.22 }, scaleX: { from: 1.0, to: 1.15 }, duration: 3500, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });

    // ── Register permanent building footprint collision ────────────────────
    // Must run after tile map is sealed. Uses PERMANENT_BUILDINGS from catalog.
    for (const perm of PERMANENT_BUILDINGS) {
      for (const { tx, ty } of getFootprintTiles(perm.anchorTx, perm.anchorTy, perm.footprintW, perm.footprintH)) {
        tw.registerBlocked(tx, ty);
      }
    }

    // ── Player zone — pillars (permanent zone markers) ─────────────────────
    const MACH_Y = TILE_SURFACE_Y;
    // Pillars (Pilar_1: 32×32)
    const pillarPositions = [
      { tx: 24, ty: 16, key: 'pillar-1' },
      { tx: 38, ty: 16, key: 'pillar-2' },
      { tx: 24, ty: 27, key: 'pillar-3' },
      { tx: 38, ty: 27, key: 'pillar-4' },
    ];
    for (const { tx, ty, key } of pillarPositions) {
      const pos = this.tileToScreen(tx, ty);
      this.add.image(pos.x, pos.y - MACH_Y, key)
        .setScale(1.0).setDepth(5).setOrigin(0.5, 1).setAlpha(0.7);
    }
  }

  /** Place a building PNG sprite with a depth-sorted origin at the tile base. */
  private placeBuildingSprite(key: string, x: number, y: number, scale: number, label: string, depth: number): Phaser.GameObjects.Image {
    const img = this.add.image(x, y, key)
      .setScale(scale).setDepth(depth).setOrigin(0.5, 1);
    if (label) {
      // Use actual texture height so label clears the top of the sprite.
      const sourceH = this.textures.get(key)?.source[0]?.height ?? 64;
      const displayH = sourceH * scale;
      this.add.text(x, y - displayH - 2, label, {
        fontSize: '6px', fontFamily: 'monospace',
        color: '#ffffff', stroke: '#000000', strokeThickness: 1, resolution: 4,
      }).setOrigin(0.5, 1).setDepth(depth + 1).setAlpha(0.85);
    }
    return img;
  }

  /** Place a machine PNG sprite with small label below. */
  private placeMachineSprite(key: string, x: number, y: number, scale: number, label: string): Phaser.GameObjects.Image {
    const img = this.add.image(x, y, key)
      .setScale(scale).setDepth(6).setOrigin(0.5, 1).setAlpha(0.85);
    if (label) {
      this.add.text(x, y + 2, label, {
        fontSize: '5px', fontFamily: 'monospace',
        color: '#888888', stroke: '#000000', strokeThickness: 1, resolution: 4,
      }).setOrigin(0.5, 0).setDepth(7).setAlpha(0.6);
    }
    return img;
  }

  /** Register all interactable buildings. Called once after createZoneStructures(). */
  private _registerInteractables(): void {
    this._interactables.length = 0;

    // Helper — convert tile pos to world pos
    const tw = (tx: number, ty: number) => this.tileToScreen(tx, ty);

    const housePos    = tw(30, 20);
    const garagePos   = tw(33, 20);
    const craftPos    = tw(30, 23);
    const shopPos     = tw(19, 14);
    const battlePos   = tw(36, 24);
    const portalInteractPos = tw(6, 24);

    this._interactables.push({
      worldX: housePos.x, worldY: housePos.y,
      radius: 40, label: 'HOUSE',
      onInteract: () => {
        WorldScene._onOpenHouse?.();
        if (this._combatController && this._combatController.hpCurrent < this._combatController.hpMax) {
          this._combatController.hpCurrent = this._combatController.hpMax;
          const ENGINE = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
          fetch(`${ENGINE}/api/game/player/hp`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ hp: null }),
          }).catch(() => {});
          this.spawnFloatText(housePos.x, housePos.y - 20, 'HP RESTORED', 0x44ff88);
        }
      },
    });
    this._interactables.push({
      worldX: garagePos.x, worldY: garagePos.y,
      radius: 40, label: 'GARAGE',
      onInteract: () => WorldScene._onOpenGarage?.(),
    });
    this._interactables.push({
      worldX: craftPos.x, worldY: craftPos.y,
      radius: 40, label: 'CRAFTING AREA',
      onInteract: () => WorldScene._onOpenCrafting?.(),
    });
    this._interactables.push({
      worldX: shopPos.x, worldY: shopPos.y,
      radius: 40, label: 'SHOP',
      onInteract: () => WorldScene._onOpenShop?.(),
    });
    this._interactables.push({
      worldX: battlePos.x, worldY: battlePos.y,
      radius: 48, label: 'BATTLE HALL',
      onInteract: () => WorldScene._onOpenBattle?.(),
    });
    this._interactables.push({
      worldX: portalInteractPos.x, worldY: portalInteractPos.y,
      radius: 48, label: 'PORTAL — WAVE ARENA',
      onInteract: () => WorldScene._onOpenArena?.(),
    });

    // ── Persona NPC invite interactables ─────────────────────────────────
    // Positions match WAYPOINTS[persona][0] (their idle home tile).
    // Labels are mutated by inviteAlly() / releaseAlly() so the prompt
    // always reflects current party state when the player walks into range.
    const sayonNpcPos = tw(14, 22);
    const serenNpcPos = tw(28, 4);
    const sybilNpcPos = tw(8, 10);

    const sayonEntry = { worldX: sayonNpcPos.x, worldY: sayonNpcPos.y, radius: 40, label: 'INVITE SAYON', onInteract: () => this._toggleAllyParty('sayon') };
    const serenEntry = { worldX: serenNpcPos.x, worldY: serenNpcPos.y, radius: 40, label: 'INVITE SEREN', onInteract: () => this._toggleAllyParty('seren') };
    const sybilEntry = { worldX: sybilNpcPos.x, worldY: sybilNpcPos.y, radius: 40, label: 'INVITE SYBIL', onInteract: () => this._toggleAllyParty('sybil') };

    this._interactables.push(sayonEntry);
    this._interactables.push(serenEntry);
    this._interactables.push(sybilEntry);

    this._npcInteractables['sayon'] = sayonEntry;
    this._npcInteractables['seren'] = serenEntry;
    this._npcInteractables['sybil'] = sybilEntry;
  }

  /** Place a single tileset tile at a tile coordinate as a structure element. */
  private placeStructureTile(tx: number, ty: number, frame: number, tint: number, depth: number): Phaser.GameObjects.Image {
    const { x, y } = this.tileToScreen(tx, ty);
    return this.add.image(x, y, 'moon-tiles', frame)
      .setDepth(depth)
      .setOrigin(0.5, 0.5)
      .setTint(tint);
  }

  /** Place a small label above a structure tile. */
  private placeLabel(tx: number, ty: number, label: string, yOff: number): void {
    const { x, y } = this.tileToScreen(tx, ty);
    this.add.text(x, y - yOff, label, {
      fontSize: '6px',
      fontFamily: 'monospace',
      color: '#ffffff',
      align: 'center',
      stroke: '#000000',
      strokeThickness: 1,
      resolution: 4,
    }).setOrigin(0.5, 1).setDepth(7).setAlpha(0.6);
  }

  // ── Thought chamber glow ref (for state-driven brightness) ────
  private _thoughtGlow: Phaser.GameObjects.Arc | null = null;

  // ── Zone border paths ─────────────────────────────────────────

  private createZoneBorders(): void {
    const rng = this.createSeededRandom(99);
    const borderFrames = [14, 15, 21, 22];

    const drawBorder = (x1: number, y1: number, x2: number, y2: number, tint: number, axis: 'x' | 'y'): void => {
      if (axis === 'x') {
        for (let x = x1; x <= x2; x++) {
          if (rng() < 0.6) {
            this.placeStructureTile(x, y1, borderFrames[Math.floor(rng() * borderFrames.length)], tint, 2).setAlpha(0.3);
          }
        }
      } else {
        for (let y = y1; y <= y2; y++) {
          if (rng() < 0.6) {
            this.placeStructureTile(x1, y, borderFrames[Math.floor(rng() * borderFrames.length)], tint, 2).setAlpha(0.3);
          }
        }
      }
    };

    // Zone edge borders
    drawBorder(ZONES.sybil.x1, ZONES.sybil.y2, ZONES.sybil.x2, ZONES.sybil.y2, TINT_SYBIL, 'x');
    drawBorder(ZONES.sybil.x2, ZONES.sybil.y1, ZONES.sybil.x2, ZONES.sybil.y2, TINT_SYBIL, 'y');
    drawBorder(ZONES.seren.x1, ZONES.seren.y2, ZONES.seren.x2, ZONES.seren.y2, TINT_SEREN, 'x');
    drawBorder(ZONES.seren.x1, ZONES.seren.y1, ZONES.seren.x1, ZONES.seren.y2, TINT_SEREN, 'y');
    drawBorder(ZONES.sayon.x1, ZONES.sayon.y1, ZONES.sayon.x2, ZONES.sayon.y1, TINT_SAYON, 'x');
    drawBorder(ZONES.sayon.x2, ZONES.sayon.y1, ZONES.sayon.x2, ZONES.sayon.y2, TINT_SAYON, 'y');
    drawBorder(ZONES.player.x1, ZONES.player.y1, ZONES.player.x2, ZONES.player.y1, TINT_PLAYER, 'x');
    drawBorder(ZONES.player.x1, ZONES.player.y1, ZONES.player.x1, ZONES.player.y2, TINT_PLAYER, 'y');

    // Lighter path tiles connecting zones to plaza
    const pathTint = 0xc0c0c0;
    for (let i = 0; i < 4; i++) {
      this.placeStructureTile(ZONES.sybil.x2 + 1 + i, ZONES.sybil.y2 - 2 + i, 0, pathTint, 1).setAlpha(0.4);
    }
    for (let i = 0; i < 4; i++) {
      this.placeStructureTile(ZONES.seren.x1 - 1 - i, ZONES.seren.y2 - 2 + i, 0, pathTint, 1).setAlpha(0.4);
    }
    for (let i = 0; i < 3; i++) {
      this.placeStructureTile(ZONES.sayon.x2 + 1 + i, ZONES.sayon.y1 - 1 - i, 0, pathTint, 1).setAlpha(0.4);
    }
    for (let i = 0; i < 3; i++) {
      this.placeStructureTile(ZONES.player.x1 - 1 - i, ZONES.player.y1 - 1 - i, 0, pathTint, 1).setAlpha(0.4);
    }
  }

  // ── Zone decorations ─────────────────────────────────────────────────

  private createZoneDecorations(): void {
    const rng = this.createSeededRandom(7);
    const rockKeys = ['Small_rocks_1', 'Small_rocks_2', 'Small_rocks_3',
                      'Medium_rocks_1', 'Medium_rocks_2', 'Medium_rocks_3'];

    // Scatter rocks across all zones
    for (let i = 0; i < 30; i++) {
      const tx = Math.floor(rng() * MAP_W);
      const ty = Math.floor(rng() * MAP_H);
      const zone = this.getZone(tx, ty);
      if (zone === 'void') continue;

      const { x, y } = this.tileToScreen(tx, ty);
      const key = rockKeys[Math.floor(rng() * rockKeys.length)];

      try {
        this.add.image(x + (rng() - 0.5) * 8, y + (rng() - 0.5) * 4, key)
          .setDepth(3)
          .setScale(0.8 + rng() * 0.4)
          .setTint(this.getZoneTint(tx, ty));
      } catch {
        // texture not loaded — skip silently
      }
    }

    // SYBIL zone — index nodes (glowing dots representing HNSW vector index)
    for (let i = 0; i < 6; i++) {
      const tx = ZONES.sybil.x1 + 2 + Math.floor(rng() * 10);
      const ty = ZONES.sybil.y1 + 2 + Math.floor(rng() * 8);
      const { x, y } = this.tileToScreen(tx, ty);
      const node = this.add.circle(x, y, 2, 0x8b5cf6, 0.8).setDepth(4);
      this.tweens.add({
        targets: node,
        alpha: { from: 0.3, to: 0.9 },
        duration: 1500 + rng() * 1000,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    }

    // SEREN zone — ice formations (blue ellipses)
    for (let i = 0; i < 5; i++) {
      const tx = ZONES.seren.x1 + 1 + Math.floor(rng() * 12);
      const ty = ZONES.seren.y1 + 1 + Math.floor(rng() * 9);
      const { x, y } = this.tileToScreen(tx, ty);
      this.add.ellipse(x, y, 4 + rng() * 6, 3 + rng() * 4, 0x93c5fd, 0.4).setDepth(3);
    }

    // SAYON zone — cable lines
    for (let i = 0; i < 4; i++) {
      const tx = ZONES.sayon.x1 + 4 + Math.floor(rng() * 10);
      const ty = ZONES.sayon.y1 + Math.floor(rng() * 10);
      const { x, y } = this.tileToScreen(tx, ty);
      this.add.rectangle(x, y, 20 + rng() * 30, 1, 0xf59e0b, 0.3)
        .setDepth(2)
        .setAngle(-30 + rng() * 60);
    }
  }

  // ── Star background ──────────────────────────────────────────────────

  private createStars(count: number): void {
    // Stars must cover the world coordinate space (map spans ~16-1072 X, 0-528 Y)
    // Add generous padding for camera movement
    const minX = -200;
    const maxX = 1300;
    const minY = -200;
    const maxY = 700;
    for (let i = 0; i < count; i++) {
      const x = minX + Math.random() * (maxX - minX);
      const y = minY + Math.random() * (maxY - minY);
      const alpha = 0.2 + Math.random() * 0.6;
      const size = Math.random() < 0.1 ? 2 : 1;
      this.add.circle(x, y, size, 0xffffff, alpha).setDepth(0);
    }
  }

  // ── Utility ──────────────────────────────────────────────────────────

  private createSeededRandom(seed: number): () => number {
    let s = seed;
    return (): number => {
      s = (s * 16807 + 0) % 2147483647;
      return s / 2147483647;
    };
  }

  private async postCoinCollection(amount: number): Promise<void> {
    try {
      const url = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
      const resp = await fetch(`${url}/api/game/collect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      });
      const data = await resp.json();
      // Notify external listeners (PhobosGame coin counter)
      if (WorldScene._onCoinCollected && data.phobos_coins != null) {
        WorldScene._onCoinCollected(data.phobos_coins);
      }
    } catch {
      // silent — coin persistence is best-effort
    }
  }

  // ── Float text ("+N" on coin pickup) ─────────────────────────────────

  private spawnFloatText(x: number, y: number, text: string, color: number): void {
    const hex = '#' + color.toString(16).padStart(6, '0');
    const t = this.add.text(x, y - 8, text, {
      fontSize: '8px',
      fontFamily: 'monospace',
      color: hex,
      stroke: '#000000',
      strokeThickness: 1,
      resolution: 4,
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

  // ── External coin callback registration ──────────────────────────────

  private static _onCoinCollected: ((total: number) => void) | null = null;

  static onCoinCollected(cb: (total: number) => void): void {
    WorldScene._onCoinCollected = cb;
  }

  // ── Panel-open callbacks (wired from PhobosGame) ──────────────────────

  private static _onOpenParty:   (() => void) | null = null;
  private static _onAllyInvite:  ((persona: string) => void) | null = null;
  private static _onAllyRelease: ((persona: string) => void) | null = null;
  private static _onOpenHouse:    (() => void) | null = null;
  private static _onOpenGarage:   (() => void) | null = null;
  private static _onOpenCrafting: (() => void) | null = null;
  private static _onOpenShop:     (() => void) | null = null;
  private static _onOpenBattle:   (() => void) | null = null;
  private static _onOpenArena:    (() => void) | null = null;

  // Receives the full machine record so the panel knows state + config
  private static _onOpenMachine: ((rec: PlacedMachineRecord) => void) | null = null;
  private static _onOpenFabShop: (() => void) | null = null;

  static onOpenHouse   (cb: () => void): void { WorldScene._onOpenHouse    = cb; }
  static onOpenGarage  (cb: () => void): void { WorldScene._onOpenGarage   = cb; }
  static onOpenCrafting(cb: () => void): void { WorldScene._onOpenCrafting = cb; }
  static onOpenShop    (cb: () => void): void { WorldScene._onOpenShop     = cb; }
  static onOpenBattle(cb: () => void): void { WorldScene._onOpenBattle = cb; }
  static onOpenArena (cb: () => void): void { WorldScene._onOpenArena  = cb; }
  static onOpenMachine (cb: (rec: PlacedMachineRecord) => void): void { WorldScene._onOpenMachine = cb; }
  static onOpenFabShop (cb: () => void): void { WorldScene._onOpenFabShop  = cb; }
  static onOpenParty  (cb: () => void): void { WorldScene._onOpenParty  = cb; }
  static onAllyInvite (cb: (persona: string) => void): void { WorldScene._onAllyInvite  = cb; }
  static onAllyRelease(cb: (persona: string) => void): void { WorldScene._onAllyRelease = cb; }

  /** Returns the number of AI allies currently in the player's party (0–3). */
  static getPartySize(): number { return WorldScene._instance?._partyMembers.size ?? 0; }

  /** Returns the persona names of all allies currently in the player's party. */
  static getPartyMembers(): string[] {
    return WorldScene._instance ? [...WorldScene._instance._partyMembers] : [];
  }

  /**
   * Debug: returns a string showing screen → world → tile for a given screen position.
   * Call from console: WorldScene.debugCoords(e.clientX, e.clientY)
   */
  static debugCoords(screenX: number, screenY: number): string {
    if (!coordSystemReady()) return 'scene not ready';
    const t     = getTransform();
    const world = viewportToWorld(screenX, screenY);
    const tile  = TileWorld.getInstance().worldToTile(world.x, world.y);
    return `screen(${Math.round(screenX)},${Math.round(screenY)}) → world(${Math.round(world.x)},${Math.round(world.y)}) → tile(${tile.tx},${tile.ty}) | zoom=${t.zoom} scroll=(${Math.round(t.scrollX)},${Math.round(t.scrollY)}) rect=(${Math.round(t.rectLeft)},${Math.round(t.rectTop)})`;
  }

  // ── Mouse debug — feeds live data to React overlay via callback ─────────
  private static _debugCb: ((data: WorldScene.DebugData) => void) | null = null;
  private static _debugMoveHandler: ((e: MouseEvent) => void) | null = null;
  private _blockedOverlay: Phaser.GameObjects.Graphics | null = null;

  /** Toggle the blocked-tile debug overlay. Red diamonds = blocked tiles. */
  static setBlockedOverlay(on: boolean): void {
    const scene = WorldScene._instance;
    if (!scene) return;
    if (!on) {
      scene._blockedOverlay?.destroy();
      scene._blockedOverlay = null;
      return;
    }
    WorldScene._redrawBlockedOverlay(scene);
  }

  private static _redrawBlockedOverlay(scene: WorldScene): void {
    scene._blockedOverlay?.destroy();
    scene._blockedOverlay = null;
    const tw = TileWorld.getInstance();
    const tiles = tw.getBlockedTiles();
    const g = scene.add.graphics().setDepth(999);
    g.lineStyle(1, 0xff2222, 0.85);
    const hw = tw.halfTileW;
    const hh = tw.halfTileH;
    for (const { tx, ty } of tiles) {
      const { x, y } = tw.tileToWorld(tx, ty);
      g.moveTo(x,      y - hh);
      g.lineTo(x + hw, y      );
      g.lineTo(x,      y + hh );
      g.lineTo(x - hw, y      );
      g.lineTo(x,      y - hh );
      g.strokePath();
    }
    scene._blockedOverlay = g;
  }

  /**
   * Nudge a permanent building's footprint anchor by (dTx, dTy), re-register
   * blocked tiles, and redraw the overlay. Call from DevInventoryPanel.
   * Prints final anchor coords to console so values can be copied to catalog.
   */
  static nudgePermanentFootprint(id: string, dTx: number, dTy: number): void {
    const scene = WorldScene._instance;
    if (!scene) return;
    const tw = TileWorld.getInstance();
    const bld = PERMANENT_BUILDINGS.find(b => b.id === id);
    if (!bld) return;

    // Unregister current footprint
    for (const { tx, ty } of getFootprintTiles(bld.anchorTx, bld.anchorTy, bld.footprintW, bld.footprintH)) {
      tw.unregisterBlocked(tx, ty);
    }
    // Apply nudge (mutate in place — runtime only, catalog unchanged)
    bld.anchorTx += dTx;
    bld.anchorTy += dTy;
    // Re-register
    for (const { tx, ty } of getFootprintTiles(bld.anchorTx, bld.anchorTy, bld.footprintW, bld.footprintH)) {
      tw.registerBlocked(tx, ty);
    }
    // Redraw overlay if visible
    if (scene._blockedOverlay) {
      WorldScene._redrawBlockedOverlay(scene);
    }
    // Log final values for copy-paste back into catalog
    console.log(
      `[footprint] ${id}: anchorTx=${bld.anchorTx} anchorTy=${bld.anchorTy}` +
      ` fw=${bld.footprintW} fh=${bld.footprintH}`,
    );
  }

  /** Same as nudgePermanentFootprint but for ZONE_STRUCTURES entries. */
  static nudgeZoneFootprint(id: string, dTx: number, dTy: number): void {
    const scene = WorldScene._instance;
    if (!scene) return;
    const tw = TileWorld.getInstance();
    const s = ZONE_STRUCTURES.find(z => z.id === id);
    if (!s) return;
    for (const { tx, ty } of getFootprintTiles(s.anchorTx, s.anchorTy, s.footprintW, s.footprintH)) {
      tw.unregisterBlocked(tx, ty);
    }
    s.anchorTx += dTx;
    s.anchorTy += dTy;
    for (const { tx, ty } of getFootprintTiles(s.anchorTx, s.anchorTy, s.footprintW, s.footprintH)) {
      tw.registerBlocked(tx, ty);
    }
    if (scene._blockedOverlay) {
      WorldScene._redrawBlockedOverlay(scene);
    }
    console.log(`[zone-footprint] ${id}: anchorTx=${s.anchorTx} anchorTy=${s.anchorTy} fw=${s.footprintW} fh=${s.footprintH}`);
  }

  static onMouseDebug(cb: ((data: WorldScene.DebugData) => void) | null): void {
    if (WorldScene._debugMoveHandler) {
      window.removeEventListener('mousemove', WorldScene._debugMoveHandler);
      WorldScene._debugMoveHandler = null;
    }
    WorldScene._debugCb = cb;
    if (!cb) return;
    WorldScene._debugMoveHandler = (e: MouseEvent) => {
      if (!coordSystemReady()) return;
      const t     = getTransform();
      const world = viewportToWorld(e.clientX, e.clientY);
      const tile  = TileWorld.getInstance().worldToTile(world.x, world.y);
      const back  = tileToViewport(tile.tx, tile.ty);
      const shop  = tileToViewport(19, 14);  // known SHOP tile — ground truth check
      const tw_       = TileWorld.getInstance();
      const blocked_  = tw_.isBlockedTile(tile.tx, tile.ty);
      const walkable_ = tw_.isWalkable(world.x, world.y);
      WorldScene._debugCb?.({
        screenX: Math.round(e.clientX), screenY: Math.round(e.clientY),
        worldX:  Math.round(world.x),   worldY:  Math.round(world.y),
        tileX:   tile.tx,               tileY:   tile.ty,
        backX:   Math.round(back.x),    backY:   Math.round(back.y),
        zoom:    t.zoom,
        scrollX: Math.round(t.scrollX), scrollY: Math.round(t.scrollY),
        camX:    Math.round(t.rectLeft), camY:   Math.round(t.rectTop),
        vpX:     Math.round(t.camX),    vpY:     Math.round(t.camY),
        shopX:   Math.round(shop.x),    shopY:   Math.round(shop.y),
        isBlocked: blocked_,
        walkable:  walkable_,
      });
    };
    window.addEventListener('mousemove', WorldScene._debugMoveHandler, { passive: true });
  }

  /** Returns native pixel dimensions of a loaded texture. Used by ghost sizing in overlay. */
  static getSpriteSize(key: string): { w: number; h: number } | null {
    const scene = WorldScene._instance;
    if (!scene) return null;
    const src = scene.textures.get(key)?.source[0];
    if (!src) return null;
    return { w: src.width, h: src.height };
  }

  static screenToWorld(screenX: number, screenY: number): { x: number; y: number } | null {
    if (!coordSystemReady()) return null;
    return viewportToWorld(screenX, screenY);
  }

  /**
   * Convert a viewport pixel position directly to a tile coordinate.
   * Returns null if scene not ready.
   */
  static screenToTile(screenX: number, screenY: number): { tx: number; ty: number } | null {
    if (!coordSystemReady()) return null;
    return viewportToTile(screenX, screenY);
  }

  /** Convert a tile coordinate to a viewport pixel position (clientX/Y space). */
  static tileToScreen(tx: number, ty: number): { x: number; y: number } | null {
    if (!coordSystemReady()) return null;
    return tileToViewport(tx, ty);
  }

  // ── Public ally API (called by PhobosGame / AllyHUD) ─────────────────────

  /**
   * Add a persona to the player's party.
   * - Freezes their PersonaAI so SSE events don't move the hub sprite.
   * - Hides the AnimatedCharacterSprite hub NPC.
   * - Spawns the AllyWorldAI visual at the player's current position.
   * - Sets worldState to 'following' so the ally update loop picks them up.
   */
  inviteAlly(persona: string): void {
    if (this._partyMembers.has(persona)) return;
    this._partyMembers.add(persona);

    // Freeze hub NPC AI — SSE state changes are swallowed until unfreeze
    this._personaAIs[persona]?.freeze();

    // Hide the hub sprite so there's no ghost NPC standing around
    const char = this.characters[persona as keyof typeof this.characters];
    if (char) char.setVisible(false);

    // Position ally near player — no rect visual in hub (AnimatedCharacterSprite handles it)
    const ally = this._allyWorldAIs[persona];
    if (ally) {
      ally.x = this.player.x + (Math.random() - 0.5) * 30;
      ally.y = this.player.y + (Math.random() - 0.5) * 20;
      ally.worldState = 'following';
    }

    // Show the AnimatedCharacterSprite and snap it to the ally start position
    // so it doesn't walk in from its waypoint on the first frame.
    if (char && ally) {
      char.setVisible(true);
      char.setHubTarget(ally.x, ally.y);
      char.snapTo(ally.x, ally.y);
    }

    // Update prompt label so next approach shows DISMISS
    const npcEntry = this._npcInteractables[persona];
    if (npcEntry) npcEntry.label = `RELEASE ${persona.toUpperCase()}`;

    WorldScene._onAllyInvite?.(persona);
  }

  /**
   * Remove a persona from the player's party.
   * - Unfreezes their PersonaAI — re-applies last known GameStore state.
   * - Shows the AnimatedCharacterSprite hub NPC again.
   * - Destroys the AllyWorldAI visual (unless we're inside the zone — zone
   *   exit will handle that).
   * - Sets worldState back to 'idle'.
   */
  releaseAlly(persona: string): void {
    if (!this._partyMembers.has(persona)) return;
    this._partyMembers.delete(persona);

    // Destroy zone rect visual if in zone; in hub there is no rect to destroy
    const ally = this._allyWorldAIs[persona];
    if (ally) {
      if (this._playerInExZone) ally.destroyVisual();
      ally.worldState = 'idle';
    }

    // Restore hub NPC wander AI — unfreeze re-applies last SSE state
    this._personaAIs[persona]?.unfreeze();

    // Return the char sprite to hub-NPC control: make visible and let
    // PersonaAI/setState drive it back to its home waypoint.
    const char = this.characters[persona as keyof typeof this.characters];
    if (char) char.setVisible(true);

    // Update prompt label so next approach shows INVITE
    const npcEntry = this._npcInteractables[persona];
    if (npcEntry) npcEntry.label = `INVITE ${persona.toUpperCase()}`;

    WorldScene._onAllyRelease?.(persona);
  }

  setAllyMode(persona: string, mode: EngagementMode): void {
    this._allyWorldAIs[persona]?.setMode(mode);
  }

  /** Toggle invite/release for a persona NPC. Called by NPC interactables. */
  private _toggleAllyParty(persona: string): void {
    if (this._partyMembers.has(persona)) {
      this.releaseAlly(persona);
    } else {
      this.inviteAlly(persona);
    }
  }

  getAllyState(persona: string): { hp: number; maxHp: number; spirit: number; offline: boolean; mode: EngagementMode } | null {
    const ai = this._allyWorldAIs[persona];
    if (!ai) return null;
    // SYBIL is offline when her persona state is 'offline'
    const personaAI = this._personaAIs[persona];
    const offline = persona === 'sybil' && personaAI?.aiState === 'offline';
    return {
      hp:      ai.ai.hp,
      maxHp:   ai.ai.maxHp,
      spirit:  ai.ai.spirit,
      offline,
      mode:    ai.mode,
    };
  }
}

// ── WorldScene namespace — shared types ───────────────────────────────────
export namespace WorldScene {
  export interface DebugData {
    screenX: number; screenY: number;
    worldX:  number; worldY:  number;
    tileX:   number; tileY:   number;
    backX:   number; backY:   number;
    zoom:    number;
    scrollX: number; scrollY: number;
    camX:    number; camY:    number;   // canvas rect left/top (from ResizeObserver)
    vpX:     number; vpY:     number;   // Phaser cam.x / cam.y (viewport offset in canvas)
    shopX:   number; shopY:   number;   // projected viewport coords of tile (19,14) = SHOP
    isBlocked: boolean;                 // whether the hovered tile is in the blocked set
    walkable:  boolean;                 // full isWalkable result for the hovered tile
  }
}