/**
 * ArenaWaveManager — wave definitions and spawn sequencer for the Portal Arena.
 *
 * Owns the list of arena waves (distinct from BATTLE_WAVES — those are
 * turn-based). Each wave is a sequence of enemy keys drawn from ENEMY_TEMPLATES.
 * Enemies spawn at random positions within the arena bounds at the start of
 * each wave, with a short stagger between each spawn.
 *
 * Usage:
 *   const mgr = new ArenaWaveManager(combat, arenaBounds);
 *   mgr.onWaveStart  = (waveNum, total) => { ... };
 *   mgr.onWaveComplete = () => { ... };
 *   mgr.onAllWavesComplete = () => { ... };
 *   mgr.startNextWave();
 *   mgr.update(delta);  // call every frame
 */

import { ENEMY_TEMPLATES } from './CombatState';
import type { WorldCombatManager } from './WorldCombatManager';
import type { EnemySpawnOverrides } from './EnemyWorldSprite';
import { type DifficultyParams, buildDifficultyParams } from './DifficultyParams';

// ── Arena wave definitions ─────────────────────────────────────────────────────
// Each entry is the list of enemy template keys to spawn.
// Difficulty escalates linearly — tier 1–2 minions → mixed archetypes → boss final.

export interface ArenaWave {
  label:   string;          // shown in HUD
  enemies: string[];        // ENEMY_TEMPLATES keys
}

export const ARENA_WAVES: ArenaWave[] = [
  { label: 'Wave 1',  enemies: ['wraith', 'wraith', 'wraith'] },
  { label: 'Wave 2',  enemies: ['cinder', 'cinder', 'ghast'] },
  { label: 'Wave 3',  enemies: ['shard', 'shard', 'arc', 'arc'] },
  { label: 'Wave 4',  enemies: ['justicar', 'void_weaver', 'ghast', 'ghast'] },
  { label: 'Wave 5',  enemies: ['permafrost_sentinel', 'voltbreaker', 'cinder', 'wraith', 'wraith'] },
  { label: 'Wave 6',  enemies: ['ember_witch', 'storm_herald', 'shard', 'arc'] },
  { label: 'Wave 7',  enemies: ['glacial_warden', 'void_weaver', 'crater_golem', 'spark_wisp'] },
  { label: 'Wave 8',  enemies: ['frost_sentinel', 'justicar', 'voltbreaker', 'ember_witch', 'arc'] },
  { label: 'Wave 9',  enemies: ['crater_golem', 'glacial_warden', 'storm_herald', 'void_weaver', 'permafrost_sentinel'] },
  { label: 'Wave 10 — BOSS', enemies: ['apex_herald'] },
];

// ── Spawn stagger ─────────────────────────────────────────────────────────────

const SPAWN_STAGGER_MS = 300;  // delay between each enemy spawn within a wave

// ── ArenaWaveManager ──────────────────────────────────────────────────────────

export class ArenaWaveManager {
  // Callbacks
  onWaveStart:        ((waveNum: number, totalWaves: number, label: string) => void) | null = null;
  onWaveComplete:     (() => void) | null                                                   = null;
  onAllWavesComplete: (() => void) | null                                                   = null;

  private _combat:   WorldCombatManager;
  private _bounds:   { minX: number; minY: number; maxX: number; maxY: number };
  private _difficulty: DifficultyParams;
  private _overrides:  EnemySpawnOverrides;

  private _currentWaveIdx   = -1;
  private _spawnQueue:      string[] = [];
  private _spawnTimer       = 0;
  private _waitingForClear  = false;
  private _done             = false;

  // LCG seed for spawn positions — reset per wave for reproducibility
  private _seed = Date.now() & 0x7fffffff;

  constructor(
    combat:     WorldCombatManager,
    bounds:     { minX: number; minY: number; maxX: number; maxY: number },
    difficulty: DifficultyParams = buildDifficultyParams(0),
  ) {
    this._combat     = combat;
    this._bounds     = bounds;
    this._difficulty = difficulty;
    this._overrides  = {
      hpMult:         difficulty.hpMult,
      damageMult:     difficulty.damageMult,
      speedMult:      difficulty.speedMult,
      aggroRangeMult: difficulty.aggroRangeMult,
    };

    this._combat.onZoneClear = () => {
      this._waitingForClear = false;
      this.onWaveComplete?.();
    };
  }

  get currentWaveIndex(): number { return this._currentWaveIdx; }
  get totalWaves(): number       { return ARENA_WAVES.length; }
  get isDone(): boolean          { return this._done; }

  /** Start the next wave. Safe to call before the first wave. */
  startNextWave(): void {
    if (this._done) return;
    this._currentWaveIdx++;
    if (this._currentWaveIdx >= ARENA_WAVES.length) {
      this._done = true;
      this.onAllWavesComplete?.();
      return;
    }

    const wave = ARENA_WAVES[this._currentWaveIdx];

    // Scale enemy count by difficulty: add floor(extraEnemyCount) extra enemies per wave,
    // with the fractional part spawned probabilistically (same logic as seedChunk extras).
    const base         = wave.enemies.slice();
    const extra        = this._difficulty.extraEnemyCount;
    const extraCount   = Math.floor(extra) + (Math.random() < (extra - Math.floor(extra)) ? 1 : 0);
    // Extra arena enemies repeat the last minion-archetype entry in the wave so
    // extras fit the wave tier. Fall back to first entry if none found.
    let repeatKey = base[0];
    for (let i = base.length - 1; i >= 0; i--) {
      if (ENEMY_TEMPLATES[base[i]]?.archetype === 'minion') { repeatKey = base[i]; break; }
    }
    for (let i = 0; i < extraCount; i++) base.push(repeatKey);

    this._spawnQueue     = base;
    this._spawnTimer     = 0;
    this._waitingForClear = false;
    // Reseed per wave so positions differ each wave
    this._seed = (this._seed * 16807 + this._currentWaveIdx * 0x9e3779b9) >>> 0;

    this.onWaveStart?.(
      this._currentWaveIdx + 1,
      ARENA_WAVES.length,
      wave.label,
    );
  }

  /** Call every frame from ArenaScene.update(). */
  update(delta: number): void {
    if (this._done || this._waitingForClear) return;
    if (this._spawnQueue.length === 0) {
      // All spawned — wait for combat to call onZoneClear
      this._waitingForClear = true;
      return;
    }

    this._spawnTimer += delta;
    if (this._spawnTimer < SPAWN_STAGGER_MS) return;
    this._spawnTimer = 0;

    const key = this._spawnQueue.shift()!;
    const template = ENEMY_TEMPLATES[key];
    if (!template) return;

    const inset = 24; // px from bounds edge
    const rng = this._lcg.bind(this);
    const x = this._bounds.minX + inset + rng() * (this._bounds.maxX - this._bounds.minX - inset * 2);
    const y = this._bounds.minY + inset + rng() * (this._bounds.maxY - this._bounds.minY - inset * 2);

    this._combat.spawnForArena(key, template, x, y, this._bounds, this._overrides);
  }

  private _lcg(): number {
    this._seed = (this._seed * 16807) % 2147483647;
    return this._seed / 2147483647;
  }
}
