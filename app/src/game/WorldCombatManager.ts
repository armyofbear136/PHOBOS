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
import type { ChunkSpec } from './ExplorationZoneManager';
import { TileWorld } from './TileWorld';
import type { HitEvent } from './PlayerCombatController';
import type { PlayerCombatController } from './PlayerCombatController';
import { EffectsManager } from './EffectsManager';
import { type DifficultyParams, buildDifficultyParams } from './DifficultyParams';
import { CLASS_DEFINITIONS } from './PlayerClasses';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_ENEMIES      = 32;
const MELEE_HIT_RANGE  = 56;   // px — player melee arc radius
const RANGED_HIT_RANGE = 380;  // px — ranged shot max reach
const MELEE_ARC_HALF   = 0.57; // cos(55°) — ±55° forward arc threshold

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

export class WorldCombatManager {
  // Fixed-size enemy slots — allocated once, reused across zone visits
  private readonly _slots: Array<EnemyWorldSprite | null>;
  private _liveCount = 0;

  // Callbacks
  onEnemyKilled:  ((enemy: EnemyWorldSprite) => void) | null                             = null;
  onZoneClear:    (() => void) | null                                                    = null;
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
    this._slots = new Array(MAX_ENEMIES).fill(null);
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

      const spawnPos = this._randomZonePos(bounds, rng);
      this._spawnEnemy(key, template, spawnPos.x, spawnPos.y, bounds, overrides);
    }
  }

  /** Destroy all live enemies and reset the pool. Called on zone exit. */
  clearZone(): void {
    for (let i = 0; i < MAX_ENEMIES; i++) {
      if (this._slots[i]) {
        this._slots[i]!.destroy();
        this._slots[i] = null;
      }
    }
    this._liveCount = 0;
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

    // Select flavour from daily zone spec (chunks share the zone's flavour)
    const spec = ExplorationZoneManager.getInstance().getDailyZone();
    const pool = FLAVOUR_POOLS[spec.enemyFlavour] ?? FLAVOUR_POOLS['default'];

    // LCG seed: mix daily seed with chunk index so each chunk has unique but stable spawns
    let s = (dailySeed ^ (chunkIdx * 0x9e3779b9)) >>> 0;
    const rng = (): number => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };

    const overrides = toSpawnOverrides(difficulty, spec.enemyFlavour);

    if (chunk.isBossChunk) {
      this._spawnBossForChunk(chunk, bounds, rng, overrides);
      const fillCount = Math.max(0, Math.round(ZONE_ENEMY_COUNT * chunk.enemyDensity) - 1);
      for (let i = 0; i < fillCount; i++) {
        const key      = weightedSample(pool, rng);
        const template = ENEMY_TEMPLATES[key];
        if (!template) continue;
        const spawnPos = this._randomZonePos(bounds, rng);
        this._spawnEnemy(key, template, spawnPos.x, spawnPos.y, bounds, overrides);
      }
      this._spawnExtraEnemies(pool, bounds, rng, difficulty, overrides);
      return;
    }

    const count = Math.round(ZONE_ENEMY_COUNT * chunk.enemyDensity);
    for (let i = 0; i < count; i++) {
      const key      = weightedSample(pool, rng);
      const template = ENEMY_TEMPLATES[key];
      if (!template) continue;
      const spawnPos = this._randomZonePos(bounds, rng);
      this._spawnEnemy(key, template, spawnPos.x, spawnPos.y, bounds, overrides);
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

    this._spawnEnemy(bossKey, bossTemplate, spawnX, spawnY, bounds, overrides);
  }

  // ── Per-frame update ──────────────────────────────────────────────────────

  update(delta: number, playerX: number, playerY: number): void {
    if (this._liveCount === 0) return;

    this._nearestEnemyIdx    = null;
    this._nearestEnemyDist   = Infinity;
    this._enemyHitPlayerThisFrame = false;

    let justDied = false;

    for (let i = 0; i < MAX_ENEMIES; i++) {
      const e = this._slots[i];
      if (!e) continue;

      const prevDead = e.isDead;
      const dmg = e.update(delta, playerX, playerY);

      // Track nearest live enemy for ally AI
      if (!e.isDead) {
        this._dx = e.x - playerX;
        this._dy = e.y - playerY;
        const d = this._dx * this._dx + this._dy * this._dy;
        if (d < this._nearestEnemyDist) {
          this._nearestEnemyDist = d;
          this._nearestEnemyIdx  = i;
        }
      }

      if (dmg > 0 && this._controller) {
        this._controller.receiveHit(dmg);
        this._enemyHitPlayerThisFrame = true;
      }

      if (!prevDead && e.isDead) {
        this._liveCount--;
        this.onEnemyKilled?.(e);
        justDied = true;
      }
    }

    if (justDied && this._liveCount === 0) {
      this.onZoneClear?.();
    }

    // Separation pass — push overlapping enemies apart so they don't stack.
    // O(n²) over MAX_ENEMIES slots but n is small (≤32) so ~512 pair checks max.
    for (let i = 0; i < MAX_ENEMIES - 1; i++) {
      const a = this._slots[i];
      if (!a || a.isDead) continue;
      for (let j = i + 1; j < MAX_ENEMIES; j++) {
        const b = this._slots[j];
        if (!b || b.isDead) continue;
        const dx   = b.x - a.x;
        const dy   = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < SEPARATION_RADIUS && dist > 0) {
          const overlap = (SEPARATION_RADIUS - dist) * SEPARATION_FORCE;
          const nx = dx / dist;
          const ny = dy / dist;
          a.nudge(-nx * overlap * 0.5, -ny * overlap * 0.5);
          b.nudge( nx * overlap * 0.5,  ny * overlap * 0.5);
        }
      }
    }
  }

  // ── Hit resolution (called from WorldScene.onHit) ─────────────────────────

  /**
   * Resolve a HitEvent from the player against all nearby enemies.
   * Melee: arc check. Ranged: closest enemy along aim vector.
   * Returns total damage dealt across all targets (for HUD feedback).
   */
  resolveHit(event: HitEvent): number {
    if (this._liveCount === 0) return 0;

    // ── Player ability dispatch ───────────────────────────────────────────────
    // Abilities with special world effects are handled here before the generic
    // arc sweep. Returns early for self-effects (heals, buffs, zero-damage).
    if (event.type === 'ability' && event.abilityIndex !== undefined) {
      return this._resolvePlayerAbility(event);
    }

    const fx = Math.cos(event.aimAngle);
    const fy = Math.sin(event.aimAngle);
    let totalDmg = 0;
    let justDied = false;

    if (event.type === 'melee') {
      // Arc sweep — all enemies within radius and ±55° of aim angle
      for (let i = 0; i < MAX_ENEMIES; i++) {
        const e = this._slots[i];
        if (!e || e.isDead) continue;

        this._dx = e.x - event.originX;
        this._dy = e.y - event.originY;
        const dist = Math.sqrt(this._dx * this._dx + this._dy * this._dy);
        if (dist > MELEE_HIT_RANGE) continue;

        // Arc check via dot product
        const dot = (this._dx / dist) * fx + (this._dy / dist) * fy;
        if (dot < MELEE_ARC_HALF) continue;

        e.receiveHit(event.damage);
        EffectsManager.getInstance().spawnHitEffect(e.x, e.y, 'slash', 0xffffff);
        this.onHitLanded?.(e.x, e.y, event.damage, event.isCrit);
        totalDmg += event.damage;
        if (e.isDead) {
          this._liveCount--;
          this.onEnemyKilled?.(e);
          justDied = true;
        }
      }
    } else {
      // Ranged — find closest enemy intersecting the aim ray
      let bestDist = RANGED_HIT_RANGE;
      let bestIdx  = -1;

      for (let i = 0; i < MAX_ENEMIES; i++) {
        const e = this._slots[i];
        if (!e || e.isDead) continue;

        this._dx = e.x - event.originX;
        this._dy = e.y - event.originY;

        // Project onto aim ray; reject enemies behind the shot
        const along = this._dx * fx + this._dy * fy;
        if (along < 0 || along > RANGED_HIT_RANGE) continue;

        // Perpendicular distance to ray
        const perpX = this._dx - along * fx;
        const perpY = this._dy - along * fy;
        const perp  = Math.sqrt(perpX * perpX + perpY * perpY);
        if (perp > 24) continue; // px radius — matches enemy visual size (~24px wide)

        if (along < bestDist) {
          bestDist = along;
          bestIdx  = i;
        }
      }

      if (bestIdx >= 0) {
        const e = this._slots[bestIdx]!;
        e.receiveHit(event.damage);
        EffectsManager.getInstance().spawnHitEffect(e.x, e.y, 'energy', 0xffffff);
        this.onHitLanded?.(e.x, e.y, event.damage, event.isCrit);
        totalDmg += event.damage;
        if (e.isDead) {
          this._liveCount--;
          this.onEnemyKilled?.(e);
          justDied = true;
        }
      }
    }

    if (justDied && this._liveCount === 0) {
      this.onZoneClear?.();
    }

    return totalDmg;
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  get liveCount(): number { return this._liveCount; }

  /**
   * Returns position + slot index of the nearest live enemy to (px, py).
   * Returns null if no live enemies. Called by WorldScene to feed ally AI.
   */
  getNearestLiveEnemy(px: number, py: number): { x: number; y: number; idx: number } | null {
    if (this._nearestEnemyIdx === null) return null;
    // Nearest is already tracked in _nearestEnemyIdx from this frame's update()
    // If called before update() runs (shouldn't happen), fall back to linear scan
    const e = this._slots[this._nearestEnemyIdx];
    if (e && !e.isDead) return { x: e.x, y: e.y, idx: this._nearestEnemyIdx };

    // Fallback linear scan (first-frame edge case only)
    let bestDistSq = Infinity;
    let bestIdx    = -1;
    for (let i = 0; i < MAX_ENEMIES; i++) {
      const s = this._slots[i];
      if (!s || s.isDead) continue;
      const dx = s.x - px;
      const dy = s.y - py;
      const dsq = dx * dx + dy * dy;
      if (dsq < bestDistSq) { bestDistSq = dsq; bestIdx = i; }
    }
    if (bestIdx < 0) return null;
    return { x: this._slots[bestIdx]!.x, y: this._slots[bestIdx]!.y, idx: bestIdx };
  }

  /** Current live enemy count — read by ArenaScene HUD and zone HUD. */
  get liveEnemyCount(): number { return this._liveCount; }

  /**
   * Returns true if any live enemy occupies a circle of `radius` px around (px, py).
   * Used by WorldProjectilePool to trigger hit flash on projectile contact.
   */
  isEnemyAtPosition(px: number, py: number, radius: number): boolean {
    const rSq = radius * radius;
    for (let i = 0; i < MAX_ENEMIES; i++) {
      const s = this._slots[i];
      if (!s || s.isDead) continue;
      const dx = s.x - px;
      const dy = s.y - py;
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
    const e = this._slots[slotIdx];
    if (!e || e.isDead) return false;
    e.receiveHit(damage);
    if (e.isDead) {
      this._liveCount--;
      this.onEnemyKilled?.(e);
      if (this._liveCount === 0) this.onZoneClear?.();
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
    for (let i = 0; i < MAX_ENEMIES; i++) {
      const e = this._slots[i];
      if (!e || e.isDead) continue;
      // Status adds a flat damage bonus (magnitude × 2) for world mode
      const bonusDmg = statusName ? statusMagnitude * 2 : 0;
      e.receiveHit(damage + bonusDmg);
      this.onHitLanded?.(e.x, e.y, damage + bonusDmg, false);
      if (e.isDead) {
        this._liveCount--;
        this.onEnemyKilled?.(e);
        if (this._liveCount === 0) this.onZoneClear?.();
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
    const e = this._slots[slotIdx];
    if (!e || e.isDead) return;
    const multiplier: Record<string, number> = {
      stun: 4, entropy: 3, burn: 3, freeze: 3, slow: 2, exposure: 2,
    };
    const bonus = magnitude * (multiplier[statusName] ?? 2);
    e.receiveHit(bonus);
    this.onHitLanded?.(e.x, e.y, bonus, false);
    if (e.isDead) {
      this._liveCount--;
      this.onEnemyKilled?.(e);
      if (this._liveCount === 0) this.onZoneClear?.();
    }
  }

  /**
   * Push all live enemies within radius px away from (cx, cy).
   * Force scales linearly from ROLL_PUSH_FORCE at contact to 0 at radius edge.
   * Called each frame of a player roll to physically displace enemies.
   */
  pushEnemiesFromPoint(cx: number, cy: number): void {
    for (let i = 0; i < MAX_ENEMIES; i++) {
      const e = this._slots[i];
      if (!e || e.isDead) continue;
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
    this._spawnEnemy(key, template, x, y, bounds, overrides);
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
    for (let i = 0; i < MAX_ENEMIES; i++) {
      const e = this._slots[i];
      if (!e || e.isDead) continue;
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
      if (e.isDead) {
        this._liveCount--;
        this.onEnemyKilled?.(e);
        justDied = true;
      }
    }
    if (justDied && this._liveCount === 0) this.onZoneClear?.();
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
    for (let i = 0; i < MAX_ENEMIES; i++) {
      const e = this._slots[i];
      if (!e || e.isDead) continue;
      this._dx = e.x - event.originX;
      this._dy = e.y - event.originY;
      const dist = Math.sqrt(this._dx * this._dx + this._dy * this._dy);
      if (dist > radius) continue;
      const bonusDmg = status ? statusMag * 2 : 0;
      e.receiveHit(dmg + bonusDmg);
      EffectsManager.getInstance().spawnHitEffect(e.x, e.y, 'energy', 0xcc88ff);
      this.onHitLanded?.(e.x, e.y, dmg + bonusDmg, event.isCrit);
      total += dmg + bonusDmg;
      if (e.isDead) {
        this._liveCount--;
        this.onEnemyKilled?.(e);
        justDied = true;
      }
    }
    if (justDied && this._liveCount === 0) this.onZoneClear?.();
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
    let bestDist = maxRange;
    let bestIdx  = -1;
    for (let i = 0; i < MAX_ENEMIES; i++) {
      const e = this._slots[i];
      if (!e || e.isDead) continue;
      this._dx = e.x - event.originX;
      this._dy = e.y - event.originY;
      const along = this._dx * fx + this._dy * fy;
      if (along < 0 || along > maxRange) continue;
      const perpX = this._dx - along * fx;
      const perpY = this._dy - along * fy;
      if (Math.sqrt(perpX * perpX + perpY * perpY) > 24) continue;
      if (along < bestDist) { bestDist = along; bestIdx = i; }
    }
    if (bestIdx < 0) return 0;
    const e = this._slots[bestIdx]!;
    const bonusDmg = status ? statusMag * 2 : 0;
    e.receiveHit(dmg + bonusDmg);
    EffectsManager.getInstance().spawnHitEffect(e.x, e.y, 'energy', 0x88ccff);
    this.onHitLanded?.(e.x, e.y, dmg + bonusDmg, event.isCrit);
    if (e.isDead) {
      this._liveCount--;
      this.onEnemyKilled?.(e);
      if (this._liveCount === 0) this.onZoneClear?.();
    }
    return dmg + bonusDmg;
  }

  private _spawnEnemy(
    key:       string,
    template:  EnemyTemplate,
    x:         number,
    y:         number,
    bounds:    { minX: number; minY: number; maxX: number; maxY: number },
    overrides: EnemySpawnOverrides | undefined = undefined,
  ): void {
    // Find a free slot
    for (let i = 0; i < MAX_ENEMIES; i++) {
      if (this._slots[i] !== null) continue;

      const cfg: EnemyWorldSpriteConfig = {
        templateId: key, template, spawnX: x, spawnY: y, zoneBounds: bounds, overrides,
      };
      this._slots[i] = new EnemyWorldSprite(this._scene, cfg);
      this._liveCount++;
      return;
    }
    // Pool exhausted — silently skip (MAX_ENEMIES cap is the design limit)
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
      const pos = this._randomZonePos(bounds, rng);
      this._spawnEnemy(key, template, pos.x, pos.y, bounds, overrides);
    }
  }

  private _randomZonePos(
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    rng:    () => number,
  ): { x: number; y: number } {
    // Keep enemies away from zone edges (12px inset) so they don't spawn in walls
    const inset = 12;
    return {
      x: bounds.minX + inset + rng() * (bounds.maxX - bounds.minX - inset * 2),
      y: bounds.minY + inset + rng() * (bounds.maxY - bounds.minY - inset * 2),
    };
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