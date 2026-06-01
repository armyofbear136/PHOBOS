/**
 * WorldCombatManager — owns all world-space enemies inside the exploration zone.
 *
 * Responsibilities:
 *   - Pre-allocated ring buffer of EnemyWorldSprite slots (MAX_ENEMIES cap).
 *   - Seed a zone's enemies on enter; clear them on exit.
 *   - Update all live enemies each frame (patrol / aggro / attack AI).
 *   - Receive HitEvents from WorldScene.onHit and resolve hits against nearby enemies.
 *   - Deliver damage to PlayerCombatController when an enemy attack lands.
 *   - Emit onEnemyKilled(enemy) and onZoneClear() for loot / HUD layers.
 *   - Track and report liveCount so ZoneHUD can show enemy counter.
 *
 * Architecture note:
 *   This is a WorldScene subsystem. WorldScene creates one instance,
 *   calls seedZone() on enter, clearZone() on exit, and update() each frame.
 *   No Phaser scene coupling beyond the scene ref passed to constructor.
 */

import * as Phaser from 'phaser';
import { EnemyWorldSprite, EnemyWorldSpriteConfig, EnemySpawnOverrides } from './EnemyWorldSprite';
import { ENEMY_TEMPLATES, EnemyTemplate } from './CombatState';
import { ExplorationZoneManager, ZONE_DEPTH, ZONE_HALF_W } from './ExplorationZoneManager';
import type { ChunkSpec, ZoneGraph, SpawnMarker } from './ExplorationZoneManager';
import type { MineralNodeDef } from './MineralNode';
import { TileWorld } from './TileWorld';
import type { HitEvent } from './PlayerCombatController';
import type { PlayerCombatController } from './PlayerCombatController';
import { EffectsManager } from './EffectsManager';
import { type DifficultyParams, buildDifficultyParams } from './DifficultyParams';
import { CLASS_DEFINITIONS } from './PlayerClasses';

// ── Constants ─────────────────────────────────────────────────────────────────

const MELEE_HIT_RANGE  = 56;   // px — player melee arc radius
const RANGED_HIT_RANGE = 380;  // px — ranged shot max reach
const MELEE_ARC_HALF   = 0.57; // cos(55°) — ±55° forward arc threshold

// Proximity spawn/despawn distances (world px).
// SPAWN_RANGE  — enemy activates when player comes within this distance of its home position.
// DESPAWN_RANGE — idle enemy beyond this distance is eligible for despawn after IDLE_DESPAWN_MS.
// Both are measured home→player so zone layout doesn't matter.
const SPAWN_RANGE_PX    = 2880; // ~2 screen-lengths at zoom 1
const DESPAWN_RANGE_PX  = 2880;
const IDLE_DESPAWN_MS   = 300_000; // 5 minutes idle beyond DESPAWN_RANGE_PX → despawn

// Enemy separation — prevents stacking
const SEPARATION_RADIUS = 18;  // px — push apart when closer than this
const SEPARATION_FORCE  = 0.6; // fraction of overlap to resolve per frame

// Roll push — shoves enemies when player rolls through them
const ROLL_PUSH_RADIUS = 40;   // px — push radius around player roll position
const ROLL_PUSH_FORCE  = 7;    // px — max push at point of contact

// Enemy counts per archetype feel-tuning baseline.
// WorldCombatManager uses these as the initial seed; can be changed here.
const ZONE_ENEMY_COUNT = 7;

// Minion-archetype keys — used when extra enemies from party scaling bias toward smaller enemies.
// Any template with archetype 'minion' qualifies. Listed explicitly so no runtime ENEMY_TEMPLATES
// scan occurs on the spawn path.
const MINION_KEYS: readonly string[] = [
  'ghast', 'wraith', 'arc', 'cinder', 'shard', 'spark_wisp',
];

/** Convert DifficultyParams to the EnemySpawnOverrides shape expected by EnemyWorldSpriteConfig. */
// ── Zone AI profiles — per-flavour speed and aggro tuning ────────────────────
// speedMult and aggroRangeMult were reserved at 1.0 in DifficultyParams because
// they are per-zone properties, not per-party properties. They live here instead,
// keyed by enemyFlavour, and are multiplied on top of DifficultyParams values at
// spawn time. Add new entries as zone archetypes are tuned.
//
// Design intent:
//   scavengers  — fast, short aggro (skirmisher feel: dart in and out)
//   sentinels   — slow, long aggro (hold ground, detect from range)
//   wanderers   — slightly fast, normal aggro (roaming pressure)
//   ring-walkers — normal speed, very long aggro (persistent hunters)
//   default     — baseline

interface ZoneAIProfile {
  speedMult:      number;
  aggroRangeMult: number;
}

const ZONE_AI_PROFILES: Record<string, ZoneAIProfile> = {
  scavengers:    { speedMult: 1.30, aggroRangeMult: 0.75 },
  sentinels:     { speedMult: 0.75, aggroRangeMult: 1.50 },
  wanderers:     { speedMult: 1.15, aggroRangeMult: 1.00 },
  'ring-walkers': { speedMult: 1.00, aggroRangeMult: 1.65 },
  default:       { speedMult: 1.00, aggroRangeMult: 1.00 },
};

function toSpawnOverrides(p: DifficultyParams, flavour?: string): EnemySpawnOverrides {
  const profile = ZONE_AI_PROFILES[flavour ?? 'default'] ?? ZONE_AI_PROFILES['default'];
  return {
    hpMult:         p.hpMult,
    damageMult:     p.damageMult,
    speedMult:      p.speedMult      * profile.speedMult,
    aggroRangeMult: p.aggroRangeMult * profile.aggroRangeMult,
  };
}

// Re-export for external consumers (e.g. debug tooling, future UI).
export type { BehaviourProfile } from './BehaviourProfiles';
export { BEHAVIOUR_PROFILES } from './BehaviourProfiles';

// ── Enemy flavour → template key mapping ─────────────────────────────────────
// Each zone archetype has an enemyFlavour string from ExplorationZoneManager.
// We map that to a weighted pool of template keys from CombatState.

type FlavourPool = Array<{ key: string; weight: number }>;

const FLAVOUR_POOLS: Record<string, FlavourPool> = {
  scavengers:  [
    { key: 'ghast',      weight: 5 },
    { key: 'wraith',     weight: 3 },
    { key: 'arc',        weight: 2 },
  ],
  sentinels: [
    { key: 'justicar',    weight: 3 },
    { key: 'voltbreaker', weight: 2 },
    { key: 'forge_knight', weight: 1 },
  ],
  wanderers: [
    { key: 'shard',  weight: 4 },
    { key: 'cinder', weight: 4 },
    { key: 'arc',    weight: 2 },
  ],
  'ring-walkers': [
    { key: 'entropy_stalker', weight: 3 },
    { key: 'justicar',        weight: 3 },
    { key: 'ghast',           weight: 2 },
  ],
  // Default fallback for future archetypes
  default: [
    { key: 'ghast',   weight: 3 },
    { key: 'cinder',  weight: 3 },
    { key: 'arc',     weight: 2 },
    { key: 'shard',   weight: 2 },
  ],
};

// ── Seeded weighted sampler ───────────────────────────────────────────────────

function weightedSample(pool: FlavourPool, rng: () => number): string {
  let total = 0;
  for (const entry of pool) total += entry.weight;
  let r = rng() * total;
  for (const entry of pool) {
    r -= entry.weight;
    if (r <= 0) return entry.key;
  }
  return pool[pool.length - 1].key;
}

// ── WorldCombatManager ────────────────────────────────────────────────────────

// Pending spawn descriptor — stored at seedZoneGraph time, activated on proximity.
interface PendingSpawn {
  templateKey: string;
  template:    EnemyTemplate;
  homeX:       number;
  homeY:       number;
  bounds:      { minX: number; minY: number; maxX: number; maxY: number };
  overrides:   EnemySpawnOverrides | undefined;
}

export class WorldCombatManager {
  // Live enemies — dynamic, no cap. Key = monotonic id assigned at activation.
  private _live    = new Map<number, EnemyWorldSprite>();
  private _nextId  = 0;

  // Pending spawns — populated by seedZoneGraph, drained by proximity check in update().
  // Pre-allocated as a plain array; grows only at seedZoneGraph call (once per zone entry).
  private _pending: PendingSpawn[] = [];

  // Callbacks
  onEnemyKilled:  ((enemy: EnemyWorldSprite) => void) | null                             = null;
  onZoneClear:    (() => void) | null                                                    = null;
  /** Called once per mineral SpawnMarker during seedZoneGraph. WorldScene wires this to spawn MineralNodes. */
  onMineralMarker: ((def: MineralNodeDef) => void) | null                               = null;
  onHitLanded:    ((x: number, y: number, damage: number, isCrit: boolean) => void) | null = null;

  // Dependencies injected at construction — never fetched inside update
  private readonly _scene:      Phaser.Scene;
  private _controller: PlayerCombatController | null = null;

  // Scratch — no allocation in hot path
  private _dx  = 0;
  private _dy  = 0;

  // Ally-support state — written each update(), read by WorldScene for ally tick
  private _nearestEnemyIdx: number | null = null;
  private _nearestEnemyDist = Infinity;
  private _enemyHitPlayerThisFrame = false;

  constructor(scene: Phaser.Scene) {
    this._scene = scene;
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  setController(cc: PlayerCombatController): void {
    this._controller = cc;
  }

  // ── Zone lifecycle ────────────────────────────────────────────────────────

  /**
   * Seed enemies for the current daily zone. Called by WorldScene._onZoneEnter.
   * Uses the zone's daily seed so the layout is deterministic per day.
   */
  seedZone(): void {
    const spec   = ExplorationZoneManager.getInstance().getDailyZone();
    const tw     = TileWorld.getInstance();
    const bounds = this._computeZoneBounds(spec.tiles, tw);

    const pool     = FLAVOUR_POOLS[spec.enemyFlavour] ?? FLAVOUR_POOLS['default'];
    const overrides = toSpawnOverrides(buildDifficultyParams(0), spec.enemyFlavour);

    // LCG seeded from zone seed — same enemies every visit within a day
    let s = spec.seed;
    const rng = (): number => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };

    for (let i = 0; i < ZONE_ENEMY_COUNT; i++) {
      const key      = weightedSample(pool, rng);
      const template = ENEMY_TEMPLATES[key];
      if (!template) continue;

      const spawnPos = this._randomZoneTilePos(rng, TileWorld.getInstance());
      this._activatePending({ templateKey: key, template, homeX: spawnPos.x, homeY: spawnPos.y, bounds, overrides });
    }
  }

  /**
   * Seed enemies and minerals for a fully assembled ZoneGraph.
   * Replaces seedChunk for the three-tier zone path.
   *
   * For each RoomInstance in the graph, iterates spawn_markers:
   *   'enemy'   — spawns at the authored world position using the region flavour pool.
   *              Boss rooms spawn one boss-archetype enemy + fill enemies.
   *   'mineral' — fires onMineralMarker callback so WorldScene can create a MineralNode.
   *              marker.tag carries the mineral type (e.g. 'lumite'); defaults to 'lumite'.
   *   'loot'    — reserved; skipped until in-zone pre-placed loot is implemented.
   *
   * Seed: daily seed XOR'd with the room's position so each room's spawns are
   * independent but stable — same enemies every visit on the same day.
   */
  seedZoneGraph(
    graph:      ZoneGraph,
    dailySeed:  number,
    difficulty: DifficultyParams = buildDifficultyParams(0),
  ): void {
    const tw      = TileWorld.getInstance();
    const tiles   = ExplorationZoneManager.getInstance().getZoneTiles();
    const bounds  = tiles.length > 0
      ? this._computeZoneBounds(tiles, tw)
      : { minX: -9999, minY: -9999, maxX: 9999, maxY: 9999 };

    const flavour   = ExplorationZoneManager.getInstance().getDailyFlavour();
    const pool      = FLAVOUR_POOLS[flavour] ?? FLAVOUR_POOLS['default'];
    const overrides = toSpawnOverrides(difficulty, flavour);

    let mineralIdx = 0;

    for (const region of graph.regions) {
      for (const room of region.rooms) {
        let s = (dailySeed ^ ((room.worldOffsetTx * 73856093) ^ (room.worldOffsetTy * 19349663))) >>> 0;
        const rng = (): number => {
          s = (s * 16807) % 2147483647;
          return s / 2147483647;
        };

        const isBossRoom   = room.def.type === 'boss';
        const enemyMarkers = room.def.spawn_markers.filter((m: SpawnMarker) => m.type === 'enemy');

        if (isBossRoom && enemyMarkers.length > 0) {
          const bossKeys: string[] = [];
          for (const [k, t] of Object.entries(ENEMY_TEMPLATES)) {
            if (t.archetype === 'boss') bossKeys.push(k);
          }
          if (bossKeys.length > 0) {
            const bossKey  = bossKeys[Math.floor(rng() * bossKeys.length)];
            const bossTmpl = ENEMY_TEMPLATES[bossKey];
            if (bossTmpl) {
              const m     = enemyMarkers[0];
              const world = tw.tileToWorld(room.worldOffsetTx + m.tx, room.worldOffsetTy + m.ty);
              this._pending.push({ templateKey: bossKey, template: bossTmpl, homeX: world.x, homeY: world.y, bounds, overrides });
            }
          }
          for (let i = 1; i < enemyMarkers.length; i++) {
            const key  = weightedSample(pool, rng);
            const tmpl = ENEMY_TEMPLATES[key];
            if (!tmpl) continue;
            const m     = enemyMarkers[i];
            const world = tw.tileToWorld(room.worldOffsetTx + m.tx, room.worldOffsetTy + m.ty);
            this._pending.push({ templateKey: key, template: tmpl, homeX: world.x, homeY: world.y, bounds, overrides });
          }
        } else {
          for (const m of enemyMarkers) {
            const key  = weightedSample(pool, rng);
            const tmpl = ENEMY_TEMPLATES[key];
            if (!tmpl) continue;
            const world = tw.tileToWorld(room.worldOffsetTx + m.tx, room.worldOffsetTy + m.ty);
            this._pending.push({ templateKey: key, template: tmpl, homeX: world.x, homeY: world.y, bounds, overrides });
          }
        }

        if (this.onMineralMarker) {
          for (const m of room.def.spawn_markers.filter((mk: SpawnMarker) => mk.type === 'mineral')) {
            const mineralType = m.tag ?? 'lumite';
            const sizeVariant = mineralIdx % 3 === 0 ? 'medium' : 'small';
            const nodeDef: MineralNodeDef = {
              nodeId:    `zone_${mineralType}_${dailySeed % 10000}_${mineralIdx}`,
              spriteKey: `mineral-${mineralType}-${sizeVariant}`,
              barItemId: `${mineralType}_bar`,
              barName:   `${mineralType.charAt(0).toUpperCase()}${mineralType.slice(1)} Bar`,
              tx:        room.worldOffsetTx + m.tx,
              ty:        room.worldOffsetTy + m.ty,
            };
            this.onMineralMarker(nodeDef);
            mineralIdx++;
          }
        }
      }
    }
  }

  /** Destroy all live enemies and discard pending spawns. Called on zone exit. */
  clearZone(): void {
    for (const e of this._live.values()) e.destroy();
    this._live.clear();
    this._pending.length = 0;
    this._nextId = 0;
  }

  /**
   * Seed enemies for one chunk in a ChunkGraph.
   * Uses chunkIdx mixed into the daily seed for independent-but-deterministic spawns.
   * Respects chunk.enemyDensity as a multiplier on ZONE_ENEMY_COUNT.
   * difficulty scales HP, damage, speed, aggro range, and extra enemy count by party size.
   */
  seedChunk(
    chunk:      ChunkSpec,
    chunkIdx:   number,
    dailySeed:  number,
    difficulty: DifficultyParams = buildDifficultyParams(0),
  ): void {
    const tw = TileWorld.getInstance();

    // Compute world-space pixel bounds from the chunk's 4 isometric corners.
    // The tile area is a parallelogram in world space — using only 2 corners
    // gives a correct X range but misses the full Y range (which spans all 4 corners).
    const txMin = chunk.offsetTx;
    const txMax = chunk.offsetTx + ZONE_HALF_W * 2;
    const tyMin = chunk.offsetTy - ZONE_DEPTH;
    const tyMax = chunk.offsetTy;

    const sw = tw.tileToWorld(txMin, tyMax);  // south-west: x-min, y-max
    const ne = tw.tileToWorld(txMax, tyMin);  // north-east: x-max, y-min
    const nw = tw.tileToWorld(txMin, tyMin);  // north-west: y-min
    const se = tw.tileToWorld(txMax, tyMax);  // south-east: y-max

    const bounds = {
      minX: sw.x,
      maxX: ne.x,
      minY: Math.min(nw.y, ne.y),
      maxY: Math.max(sw.y, se.y),
    };

    // Select flavour from daily zone — getDailyFlavour() does NOT touch _tileSet.
    const flavour = ExplorationZoneManager.getInstance().getDailyFlavour();
    const pool = FLAVOUR_POOLS[flavour] ?? FLAVOUR_POOLS['default'];

    // LCG seed: mix daily seed with chunk index so each chunk has unique but stable spawns
    let s = (dailySeed ^ (chunkIdx * 0x9e3779b9)) >>> 0;
    const rng = (): number => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };

    const overrides = toSpawnOverrides(difficulty, flavour);

    if (chunk.isBossChunk) {
      this._spawnBossForChunk(chunk, bounds, rng, overrides);
      const fillCount = Math.max(0, Math.round(ZONE_ENEMY_COUNT * chunk.enemyDensity) - 1);
      for (let i = 0; i < fillCount; i++) {
        const key      = weightedSample(pool, rng);
        const template = ENEMY_TEMPLATES[key];
        if (!template) continue;
        const spawnPos = this._randomZoneTilePos(rng, TileWorld.getInstance());
        this._activatePending({ templateKey: key, template, homeX: spawnPos.x, homeY: spawnPos.y, bounds, overrides });
      }
      this._spawnExtraEnemies(pool, bounds, rng, difficulty, overrides);
      return;
    }

    const count = Math.round(ZONE_ENEMY_COUNT * chunk.enemyDensity);
    for (let i = 0; i < count; i++) {
      const key      = weightedSample(pool, rng);
      const template = ENEMY_TEMPLATES[key];
      if (!template) continue;
      const spawnPos = this._randomZoneTilePos(rng, TileWorld.getInstance());
      this._activatePending({ templateKey: key, template, homeX: spawnPos.x, homeY: spawnPos.y, bounds, overrides });
    }
    this._spawnExtraEnemies(pool, bounds, rng, difficulty, overrides);
  }

  /**
   * Deterministically select and place one boss-archetype enemy at the chunk's
   * endpointTile. Boss key is drawn from ENEMY_TEMPLATES filtered to archetype
   * === 'boss', selected by the seeded rng — same boss every visit same day.
   */
  private _spawnBossForChunk(
    chunk:     ChunkSpec,
    bounds:    { minX: number; minY: number; maxX: number; maxY: number },
    rng:       () => number,
    overrides: EnemySpawnOverrides,
  ): void {
    const bossKeys: string[] = [];
    for (const [k, t] of Object.entries(ENEMY_TEMPLATES)) {
      if (t.archetype === 'boss') bossKeys.push(k);
    }
    if (bossKeys.length === 0) return;

    const bossKey      = bossKeys[Math.floor(rng() * bossKeys.length)];
    const bossTemplate = ENEMY_TEMPLATES[bossKey];
    if (!bossTemplate) return;

    let spawnX: number;
    let spawnY: number;
    if (chunk.endpointTile) {
      const world = TileWorld.getInstance().tileToWorld(chunk.endpointTile.tx, chunk.endpointTile.ty);
      spawnX = world.x;
      spawnY = world.y;
    } else {
      spawnX = (bounds.minX + bounds.maxX) / 2;
      spawnY = (bounds.minY + bounds.maxY) / 2;
    }

    this._activatePending({ templateKey: bossKey, template: bossTemplate, homeX: spawnX, homeY: spawnY, bounds, overrides });
  }

  // ── Per-frame update ──────────────────────────────────────────────────────

  update(delta: number, playerX: number, playerY: number): void {
    this._nearestEnemyIdx         = null;
    this._nearestEnemyDist        = Infinity;
    this._enemyHitPlayerThisFrame = false;

    const tw = TileWorld.getInstance();
    const { tx: playerTx, ty: playerTy } = tw.worldToTile(playerX, playerY);

    // Proximity activation — drain pending spawns within SPAWN_RANGE_PX of their home.
    // Iterate backward so splice(i,1) is safe; entries are zone-ordered so nearby
    // spawns cluster toward the front after the player has advanced into the zone.
    for (let i = this._pending.length - 1; i >= 0; i--) {
      const p  = this._pending[i];
      const dx = p.homeX - playerX;
      const dy = p.homeY - playerY;
      if (dx * dx + dy * dy <= SPAWN_RANGE_PX * SPAWN_RANGE_PX) {
        this._activatePending(p);
        this._pending.splice(i, 1);
      }
    }

    if (this._live.size === 0) return;

    const spawnRangeSq   = SPAWN_RANGE_PX   * SPAWN_RANGE_PX;
    const despawnRangeSq = DESPAWN_RANGE_PX * DESPAWN_RANGE_PX;

    let justDied = false;
    const toRemove: number[] = [];

    for (const [id, e] of this._live) {
      const prevDead = e.isDead;
      const dmg      = e.update(delta, playerX, playerY, playerTx, playerTy);

      if (!e.isDead) {
        this._dx = e.x - playerX;
        this._dy = e.y - playerY;
        const d  = this._dx * this._dx + this._dy * this._dy;
        if (d < this._nearestEnemyDist) {
          this._nearestEnemyDist = d;
          this._nearestEnemyIdx  = id;
        }

        // Reset idle timer when player is within spawn range of home
        const hx = e.homeX - playerX;
        const hy = e.homeY - playerY;
        if (hx * hx + hy * hy <= spawnRangeSq) {
          e.resetIdle();
        }

        // Idle despawn — patrol state, home far from player, timer expired
        if (
          e.aiState === 'patrol' &&
          e._idleTimer >= IDLE_DESPAWN_MS &&
          hx * hx + hy * hy > despawnRangeSq
        ) {
          toRemove.push(id);
        }
      }

      if (dmg > 0 && this._controller) {
        this._controller.receiveHit(dmg);
        this._enemyHitPlayerThisFrame = true;
      }

      if (!prevDead && e.isDead) {
        this.onEnemyKilled?.(e);
        justDied = true;
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this._live.get(id)?.destroy();
      this._live.delete(id);
    }

    if (justDied && this._live.size === 0 && this._pending.length === 0) {
      this.onZoneClear?.();
    }

    // Separation pass — O(n²) over live enemies only; no fixed cap
    const liveArr = Array.from(this._live.values());
    for (let i = 0; i < liveArr.length - 1; i++) {
      const a = liveArr[i];
      if (a.isDead) continue;
      for (let j = i + 1; j < liveArr.length; j++) {
        const b = liveArr[j];
        if (b.isDead) continue;
        const dx     = b.x - a.x;
        const dy     = b.y - a.y;
        const dist   = Math.sqrt(dx * dx + dy * dy);
        const radius = SEPARATION_RADIUS * (a.separationMult + b.separationMult) * 0.5;
        if (dist < radius && dist > 0) {
          const overlap = (radius - dist) * SEPARATION_FORCE;
          const nx = dx / dist;
          const ny = dy / dist;
          a.nudge(-nx * overlap * 0.5, -ny * overlap * 0.5);
          b.nudge( nx * overlap * 0.5,  ny * overlap * 0.5);
        }
      }
    }
  }

  /** Activate a pending spawn descriptor — create EnemyWorldSprite and register in _live. */
  private _activatePending(p: PendingSpawn): void {
    const cfg: EnemyWorldSpriteConfig = {
      templateId: p.templateKey,
      template:   p.template,
      spawnX:     p.homeX,
      spawnY:     p.homeY,
      zoneBounds: p.bounds,
      overrides:  p.overrides,
    };
    this._live.set(this._nextId++, new EnemyWorldSprite(this._scene, cfg));
  }

    // ── Hit resolution (called from WorldScene.onHit) ─────────────────────────

  /**
   * Resolve a HitEvent from the player against all nearby enemies.
   * Melee: arc check. Ranged: closest enemy along aim vector.
   * Returns total damage dealt across all targets (for HUD feedback).
   */
  resolveHit(event: HitEvent): number {
    if (this._live.size === 0) return 0;

    if (event.type === 'ability' && event.abilityIndex !== undefined) {
      return this._resolvePlayerAbility(event);
    }

    const fx = Math.cos(event.aimAngle);
    const fy = Math.sin(event.aimAngle);
    let totalDmg = 0;
    let justDied = false;

    if (event.type === 'melee') {
      for (const e of this._live.values()) {
        if (e.isDead) continue;
        this._dx = e.x - event.originX;
        this._dy = e.y - event.originY;
        const dist = Math.sqrt(this._dx * this._dx + this._dy * this._dy);
        if (dist > MELEE_HIT_RANGE) continue;
        const dot = (this._dx / dist) * fx + (this._dy / dist) * fy;
        if (dot < MELEE_ARC_HALF) continue;
        e.receiveHit(event.damage);
        EffectsManager.getInstance().spawnHitEffect(e.x, e.y, 'slash', 0xffffff);
        this.onHitLanded?.(e.x, e.y, event.damage, event.isCrit);
        totalDmg += event.damage;
        if (e.isDead) { this.onEnemyKilled?.(e); justDied = true; }
      }
    } else {
      let bestDist = RANGED_HIT_RANGE;
      let bestEnemy: EnemyWorldSprite | null = null;
      for (const e of this._live.values()) {
        if (e.isDead) continue;
        this._dx = e.x - event.originX;
        this._dy = e.y - event.originY;
        const along = this._dx * fx + this._dy * fy;
        if (along < 0 || along > RANGED_HIT_RANGE) continue;
        const perpX = this._dx - along * fx;
        const perpY = this._dy - along * fy;
        const perp  = Math.sqrt(perpX * perpX + perpY * perpY);
        if (perp > 24) continue;
        if (along < bestDist) { bestDist = along; bestEnemy = e; }
      }
      if (bestEnemy) {
        bestEnemy.receiveHit(event.damage);
        EffectsManager.getInstance().spawnHitEffect(bestEnemy.x, bestEnemy.y, 'energy', 0xffffff);
        this.onHitLanded?.(bestEnemy.x, bestEnemy.y, event.damage, event.isCrit);
        totalDmg += event.damage;
        if (bestEnemy.isDead) { this.onEnemyKilled?.(bestEnemy); justDied = true; }
      }
    }

    if (justDied && this._live.size === 0 && this._pending.length === 0) {
      this.onZoneClear?.();
    }

    return totalDmg;
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  get liveCount(): number { return this._live.size; }

  /**
   * Returns position + slot index of the nearest live enemy to (px, py).
   * Returns null if no live enemies. Called by WorldScene to feed ally AI.
   */
  getNearestLiveEnemy(px: number, py: number): { x: number; y: number; idx: number } | null {
    if (this._nearestEnemyIdx === null) return null;
    const e = this._live.get(this._nearestEnemyIdx);
    if (e && !e.isDead) return { x: e.x, y: e.y, idx: this._nearestEnemyIdx };
    // Fallback linear scan
    let bestDistSq = Infinity;
    let bestId     = -1;
    for (const [id, s] of this._live) {
      if (s.isDead) continue;
      const dx = s.x - px; const dy = s.y - py;
      const dsq = dx * dx + dy * dy;
      if (dsq < bestDistSq) { bestDistSq = dsq; bestId = id; }
    }
    if (bestId < 0) return null;
    const best = this._live.get(bestId)!;
    return { x: best.x, y: best.y, idx: bestId };
  }

  /** Current live enemy count — read by ArenaScene HUD and zone HUD. */
  get liveEnemyCount(): number { return this._live.size; }

  /**
   * Returns true if any live enemy occupies a circle of `radius` px around (px, py).
   * Used by WorldProjectilePool to trigger hit flash on projectile contact.
   */
  isEnemyAtPosition(px: number, py: number, radius: number): boolean {
    const rSq = radius * radius;
    for (const s of this._live.values()) {
      if (s.isDead) continue;
      const dx = s.x - px; const dy = s.y - py;
      if (dx * dx + dy * dy <= rSq) return true;
    }
    return false;
  }

  /** True if any enemy dealt damage to the player during this frame's update(). */
  get enemyHitPlayerThisFrame(): boolean { return this._enemyHitPlayerThisFrame; }

  /**
   * Apply damage from an ally hit to the enemy at the given slot index.
   * Returns true if the enemy died from this hit. No-ops silently if slot
   * is empty or enemy already dead.
   */
  applyAllyHit(slotIdx: number, damage: number): boolean {
    const e = this._live.get(slotIdx);
    if (!e || e.isDead) return false;
    e.receiveHit(damage);
    if (e.isDead) {
      this.onEnemyKilled?.(e);
      if (this._live.size === 0 && this._pending.length === 0) this.onZoneClear?.();
    }
    return e.isDead;
  }

  /**
   * Apply ally AoE ability damage to all live enemies.
   * Optional status tag produces a damage-on-tick burst on each enemy hit
   * (status debuffs are visual only in world mode — no turn tracker on enemies).
   * Returns true if any enemy died.
   */
  applyAllyAoeHit(
    damage:    number,
    statusName: import('./CombatState').StatusType | null,
    _statusTurns:    number,
    statusMagnitude: number,
  ): boolean {
    let anyDied = false;
    for (const e of this._live.values()) {
      if (e.isDead) continue;
      const bonusDmg = statusName ? statusMagnitude * 2 : 0;
      e.receiveHit(damage + bonusDmg);
      this.onHitLanded?.(e.x, e.y, damage + bonusDmg, false);
      if (e.isDead) {
        this.onEnemyKilled?.(e);
        if (this._live.size === 0 && this._pending.length === 0) this.onZoneClear?.();
        anyDied = true;
      }
    }
    return anyDied;
  }

  /**
   * Apply a status burst to a single enemy (world mode: flat bonus damage tick).
   * stun    — deals magnitude × 4 bonus damage
   * slow    — deals magnitude × 2 bonus damage
   * entropy — deals magnitude × 3 bonus damage
   * exposure — deals magnitude × 2 bonus damage
   * Other types: magnitude × 2 fallback
   */
  applyStatusToEnemy(
    slotIdx:    number,
    statusName: import('./CombatState').StatusType,
    _turns:     number,
    magnitude:  number,
  ): void {
    const e = this._live.get(slotIdx);
    if (!e || e.isDead) return;
    const multiplier: Record<string, number> = {
      stun: 4, entropy: 3, burn: 3, freeze: 3, slow: 2, exposure: 2,
    };
    const bonus = magnitude * (multiplier[statusName] ?? 2);
    e.receiveHit(bonus);
    this.onHitLanded?.(e.x, e.y, bonus, false);
    if (e.isDead) {
      this.onEnemyKilled?.(e);
      if (this._live.size === 0 && this._pending.length === 0) this.onZoneClear?.();
    }
  }

  /**
   * Push all live enemies within radius px away from (cx, cy).
   * Force scales linearly from ROLL_PUSH_FORCE at contact to 0 at radius edge.
   * Called each frame of a player roll to physically displace enemies.
   */
  pushEnemiesFromPoint(cx: number, cy: number): void {
    for (const e of this._live.values()) {
      if (e.isDead) continue;
      const dx   = e.x - cx;
      const dy   = e.y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= ROLL_PUSH_RADIUS || dist === 0) continue;
      const strength = ROLL_PUSH_FORCE * (1 - dist / ROLL_PUSH_RADIUS);
      e.nudge((dx / dist) * strength, (dy / dist) * strength);
    }
  }

  /**
   * Spawn a single enemy at the given world position within bounds.
   * Called by ArenaWaveManager instead of seedChunk for arena mode.
   */
  spawnForArena(
    key:       string,
    template:  EnemyTemplate,
    x:         number,
    y:         number,
    bounds:    { minX: number; minY: number; maxX: number; maxY: number },
    overrides: EnemySpawnOverrides | undefined = undefined,
  ): void {
    this._activatePending({ templateKey: key, template, homeX: x, homeY: y, bounds, overrides });
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Dispatch player ability effects in world combat.
   *
   * Each ability by class and index has a defined world behaviour:
   *   AoE       — hit all enemies in origin radius (larger than melee arc)
   *   Piercing  — hit first enemy on aim ray, status applied
   *   Self-heal — restore HP to player via controller ref, no enemy hit
   *   Self-buff — apply power-up buff via controller, no enemy hit
   *   Utility   — zero-damage but status burst or area stagger
   *
   * Abilities with no special classification fall through to the default
   * melee arc sweep at the bottom.
   */
  private _resolvePlayerAbility(event: HitEvent): number {
    const cls  = this._controller?.['_build']?.class;
    const idx  = event.abilityIndex!;
    const ab   = cls ? CLASS_DEFINITIONS[cls]?.abilities[idx] : null;
    if (!ab) return 0;

    const dmg = event.damage;
    let totalDmg = 0;

    switch (`${cls}.${idx}`) {
      // ── Fighter ────────────────────────────────────────────────────────────
      // 0: Cleave — AoE arc 70px
      case 'fighter.0': {
        totalDmg = this._aoeArc(event, 70, dmg, 'exposure', 2, 1);
        break;
      }
      // 1: Lunge — piercing single target, longer range
      case 'fighter.1': {
        totalDmg = this._piercingShot(event, 200, dmg);
        break;
      }
      // 2: Blade Storm — 360° AoE, full radius
      case 'fighter.2': {
        totalDmg = this._aoeCircle(event, 80, dmg, 'slow', 2, 1);
        break;
      }

      // ── Guardian ──────────────────────────────────────────────────────────
      // 0: Shield Slam — short arc + stun bonus
      case 'guardian.0': {
        totalDmg = this._aoeArc(event, 50, dmg, 'stun', 1, 1);
        break;
      }
      // 1: Fortify — self buff: +40% resist for 8s, zero damage
      case 'guardian.1': {
        this._controller?.applyPowerUp('resist', 0.60, 8000);
        this.onHitLanded?.(event.originX, event.originY, 0, false);
        break;
      }
      // 2: Earthquake — 360° AoE + slow
      case 'guardian.2': {
        totalDmg = this._aoeCircle(event, 90, dmg, 'slow', 3, 1);
        break;
      }

      // ── Channeler ─────────────────────────────────────────────────────────
      // 0: Mend — self heal, zero damage
      case 'channeler.0': {
        if (this._controller) {
          const heal = ab.baseDmg; // reuse baseDmg as heal amount for Mend
          this._controller.hpCurrent = Math.min(
            this._controller.hpMax,
            this._controller.hpCurrent + heal,
          );
          this.onHitLanded?.(event.originX, event.originY, 0, false);
        }
        break;
      }
      // 1: Spirit Lance — piercing + entropy
      case 'channeler.1': {
        totalDmg = this._piercingShot(event, 320, dmg, 'entropy', 4, 1);
        break;
      }
      // 2: Void Nova — large 360° AoE + entropy
      case 'channeler.2': {
        totalDmg = this._aoeCircle(event, 110, dmg, 'entropy', 5, 2);
        break;
      }

      // ── Phantom ───────────────────────────────────────────────────────────
      // 0: Backstab — single target, large damage (standard resolveHit handles arc)
      case 'phantom.0': {
        totalDmg = this._aoeArc(event, MELEE_HIT_RANGE, dmg, null, 0, 0);
        break;
      }
      // 1: Smoke Bomb — 360° stagger, zero damage, apply slow to all nearby
      case 'phantom.1': {
        totalDmg = this._aoeCircle(event, 80, 0, 'slow', 3, 2);
        break;
      }
      // 2: Death Blossom — wide 360° AoE
      case 'phantom.2': {
        totalDmg = this._aoeCircle(event, 75, dmg, 'exposure', 2, 1);
        break;
      }

      default: {
        // Fallback: standard melee arc sweep
        totalDmg = this._aoeArc(event, MELEE_HIT_RANGE, dmg, null, 0, 0);
      }
    }

    return totalDmg;
  }

  /** AoE within arc (same geometry as melee but configurable radius + optional status). */
  private _aoeArc(
    event: HitEvent, radius: number, dmg: number,
    status: import('./CombatState').StatusType | null,
    statusTurns: number, statusMag: number,
  ): number {
    const fx = Math.cos(event.aimAngle);
    const fy = Math.sin(event.aimAngle);
    let total = 0;
    let justDied = false;
    for (const e of this._live.values()) {
      if (e.isDead) continue;
      this._dx = e.x - event.originX;
      this._dy = e.y - event.originY;
      const dist = Math.sqrt(this._dx * this._dx + this._dy * this._dy);
      if (dist > radius) continue;
      const dot = (this._dx / dist) * fx + (this._dy / dist) * fy;
      if (dot < MELEE_ARC_HALF) continue;
      const bonusDmg = status ? statusMag * 2 : 0;
      e.receiveHit(dmg + bonusDmg);
      EffectsManager.getInstance().spawnHitEffect(e.x, e.y, 'slash', 0xffffff);
      this.onHitLanded?.(e.x, e.y, dmg + bonusDmg, event.isCrit);
      total += dmg + bonusDmg;
      if (e.isDead) { this.onEnemyKilled?.(e); justDied = true; }
    }
    if (justDied && this._live.size === 0 && this._pending.length === 0) this.onZoneClear?.();
    return total;
  }

  /** 360° circle AoE at origin. */
  private _aoeCircle(
    event: HitEvent, radius: number, dmg: number,
    status: import('./CombatState').StatusType | null,
    statusTurns: number, statusMag: number,
  ): number {
    let total = 0;
    let justDied = false;
    for (const e of this._live.values()) {
      if (e.isDead) continue;
      this._dx = e.x - event.originX;
      this._dy = e.y - event.originY;
      const dist = Math.sqrt(this._dx * this._dx + this._dy * this._dy);
      if (dist > radius) continue;
      const bonusDmg = status ? statusMag * 2 : 0;
      e.receiveHit(dmg + bonusDmg);
      EffectsManager.getInstance().spawnHitEffect(e.x, e.y, 'energy', 0xcc88ff);
      this.onHitLanded?.(e.x, e.y, dmg + bonusDmg, event.isCrit);
      total += dmg + bonusDmg;
      if (e.isDead) { this.onEnemyKilled?.(e); justDied = true; }
    }
    if (justDied && this._live.size === 0 && this._pending.length === 0) this.onZoneClear?.();
    return total;
  }

  /** Piercing shot: first enemy intersecting aim ray up to maxRange. */
  private _piercingShot(
    event: HitEvent, maxRange: number, dmg: number,
    status: import('./CombatState').StatusType | null = null,
    statusTurns = 0, statusMag = 0,
  ): number {
    const fx = Math.cos(event.aimAngle);
    const fy = Math.sin(event.aimAngle);
    let bestDist  = maxRange;
    let bestEnemy: EnemyWorldSprite | null = null;
    for (const e of this._live.values()) {
      if (e.isDead) continue;
      this._dx = e.x - event.originX;
      this._dy = e.y - event.originY;
      const along = this._dx * fx + this._dy * fy;
      if (along < 0 || along > maxRange) continue;
      const perpX = this._dx - along * fx;
      const perpY = this._dy - along * fy;
      if (Math.sqrt(perpX * perpX + perpY * perpY) > 24) continue;
      if (along < bestDist) { bestDist = along; bestEnemy = e; }
    }
    if (!bestEnemy) return 0;
    const bonusDmg = status ? statusMag * 2 : 0;
    bestEnemy.receiveHit(dmg + bonusDmg);
    EffectsManager.getInstance().spawnHitEffect(bestEnemy.x, bestEnemy.y, 'energy', 0x88ccff);
    this.onHitLanded?.(bestEnemy.x, bestEnemy.y, dmg + bonusDmg, event.isCrit);
    if (bestEnemy.isDead) {
      this.onEnemyKilled?.(bestEnemy);
      if (this._live.size === 0 && this._pending.length === 0) this.onZoneClear?.();
    }
    return dmg + bonusDmg;
  }



  /**
   * Spawn the fractional extra enemies granted by party difficulty scaling.
   * extraEnemyCount may be fractional (e.g. 0.75 for 3 allies × 0.25).
   * The integer portion is always spawned; the fractional part is spawned
   * probabilistically so the expected value equals extraEnemyCount exactly.
   * Extras are drawn from the minion-biased pool to keep them feeling small.
   */
  private _spawnExtraEnemies(
    pool:      FlavourPool,
    bounds:    { minX: number; minY: number; maxX: number; maxY: number },
    rng:       () => number,
    difficulty: DifficultyParams,
    overrides:  EnemySpawnOverrides,
  ): void {
    const extra = difficulty.extraEnemyCount;
    if (extra <= 0) return;

    const count    = Math.floor(extra);
    const fraction = extra - count;
    const total    = count + (rng() < fraction ? 1 : 0);
    if (total === 0) return;

    // Build a minion-biased pool: blend base pool with flat minion weights.
    // extraMinionBias 0.75 → 75% of effective weight comes from MINION_KEYS equally.
    const bias        = difficulty.extraMinionBias;
    const biasPool: FlavourPool = [];
    const minionW = bias > 0 && MINION_KEYS.length > 0
      ? (bias / MINION_KEYS.length) * 100
      : 0;
    for (const k of MINION_KEYS) {
      biasPool.push({ key: k, weight: minionW });
    }
    for (const entry of pool) {
      biasPool.push({ key: entry.key, weight: entry.weight * (1 - bias) });
    }

    for (let i = 0; i < total; i++) {
      const key      = weightedSample(biasPool, rng);
      const template = ENEMY_TEMPLATES[key];
      if (!template) continue;
      const pos = this._randomZoneTilePos(rng, TileWorld.getInstance());
      this._activatePending({ templateKey: key, template, homeX: pos.x, homeY: pos.y, bounds, overrides });
    }
  }

  private _randomZoneTilePos(
    rng: () => number,
    tw:  TileWorld,
  ): { x: number; y: number } {
    const tiles = ExplorationZoneManager.getInstance().getZoneTiles();
    if (tiles.length === 0) {
      // Fallback: return hub centre if zone has no tiles yet
      return tw.tileToWorld(22, 11);
    }
    const t = tiles[Math.floor(rng() * tiles.length)];
    return tw.tileToWorld(t.tx, t.ty);
  }

  /**
   * Derive world-px bounds from the zone's tile list.
   * Iterates once — no allocation after the single return object.
   */
  private _computeZoneBounds(
    tiles: Array<{ tx: number; ty: number }>,
    tw:    TileWorld,
  ): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const t of tiles) {
      const { x, y } = tw.tileToWorld(t.tx, t.ty);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }
}