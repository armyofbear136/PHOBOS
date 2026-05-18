/**
 * WorldMineralNode — harvestable mineral node seeded inside exploration zone chunks.
 *
 * Mirrors the hub MineralNode class but:
 *   - Positions are derived from chunk tile coordinates (chunk-local, converted to world-px)
 *   - Node IDs encode the daily seed + chunk index + node slot for stable daily identity
 *   - Respawn is per daily reset (matches server-side 1-hour window)
 *   - Destroyed on zone exit; re-seeded fresh on next zone enter
 *
 * Static factory seedForChunk() deterministically places NODES_PER_CHUNK nodes
 * per chunk, spread across the chunk bounds using the same LCG used elsewhere.
 * Node mineral type cycles through a fixed pool weighted by chunk materialDensity.
 */

import * as Phaser from 'phaser';
import { TileWorld } from './TileWorld';
import type { ChunkSpec } from './ExplorationZoneManager';
import { ZONE_DEPTH, ZONE_HALF_W } from './ExplorationZoneManager';

// ── Constants ─────────────────────────────────────────────────────────────────

const HARVEST_RADIUS = 52;            // world px — same as hub nodes
const RESPAWN_MS     = 60 * 60 * 1000; // 1 hour
const NODES_PER_CHUNK = 3;            // mineral nodes per chunk

const ENGINE_URL = (): string =>
  (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// ── Mineral type pool ─────────────────────────────────────────────────────────
// Each entry: [barItemId, barName, spriteKey]
type MineralEntry = { barItemId: string; barName: string; spriteKey: string };

const ZONE_MINERAL_POOL: MineralEntry[] = [
  { barItemId: 'lumite_bar',   barName: 'Lumite Bar',   spriteKey: 'mineral-lumite-small'   },
  { barItemId: 'ferrite_bar',  barName: 'Ferrite Bar',  spriteKey: 'mineral-ferrite-small'  },
  { barItemId: 'aurite_bar',   barName: 'Aurite Bar',   spriteKey: 'mineral-aurite-small'   },
  { barItemId: 'verdite_bar',  barName: 'Verdite Bar',  spriteKey: 'mineral-verdite-small'  },
  { barItemId: 'azurite_bar',  barName: 'Azurite Bar',  spriteKey: 'mineral-azurite-small'  },
  { barItemId: 'fluxite_bar',  barName: 'Fluxite Bar',  spriteKey: 'mineral-fluxite-small'  },
];

// ── WorldMineralNode ──────────────────────────────────────────────────────────

export class WorldMineralNode {
  readonly nodeId:    string;
  readonly barItemId: string;
  readonly barName:   string;
  readonly worldX:    number;
  readonly worldY:    number;

  private _sprite:      Phaser.GameObjects.Image;
  private _timerText:   Phaser.GameObjects.Text;
  private _harvested    = false;
  private _harvestedAt: number | null = null;
  private _scene:       Phaser.Scene;

  constructor(
    scene:     Phaser.Scene,
    nodeId:    string,
    barItemId: string,
    barName:   string,
    spriteKey: string,
    worldX:    number,
    worldY:    number,
  ) {
    this._scene   = scene;
    this.nodeId   = nodeId;
    this.barItemId = barItemId;
    this.barName  = barName;
    this.worldX   = worldX;
    this.worldY   = worldY;

    this._sprite = scene.add.image(worldX, worldY, spriteKey)
      .setOrigin(0.5, 1)
      .setDepth(9)
      .setScale(1);

    this._timerText = scene.add.text(worldX, worldY - 28, '', {
      fontSize: '6px', fontFamily: 'monospace',
      color: '#aaaaaa', stroke: '#000', strokeThickness: 2, resolution: 4,
    }).setOrigin(0.5, 1).setDepth(12).setVisible(false);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Call from WorldScene.update() — pass player world coords. */
  update(_playerX: number, _playerY: number): void {
    if (this._harvested && this._harvestedAt !== null) {
      const elapsed   = Date.now() - this._harvestedAt;
      const remaining = Math.max(0, RESPAWN_MS - elapsed);
      if (remaining === 0) {
        this._respawn();
      } else {
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        this._timerText.setText(`${mins}m ${secs}s`);
      }
    }
  }

  /** Returns true if the player is close enough to harvest. */
  isInRange(playerX: number, playerY: number): boolean {
    if (this._harvested) return false;
    const dx = playerX - this.worldX;
    const dy = playerY - this.worldY;
    return Math.sqrt(dx * dx + dy * dy) <= HARVEST_RADIUS;
  }

  /**
   * Attempt harvest. Calls backend, triggers onResult(success, barName).
   */
  harvest(onResult: (success: boolean, barName: string) => void): void {
    if (this._harvested) { onResult(false, this.barName); return; }

    fetch(`${ENGINE_URL()}/api/game/minerals/harvest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_id: this.nodeId, bar_item_id: this.barItemId }),
    })
      .then(r => r.json())
      .then((data: { ok?: boolean }) => {
        if (data.ok) {
          this._harvested   = true;
          this._harvestedAt = Date.now();
          this._sprite.setVisible(false);
          this._timerText.setVisible(true);
          onResult(true, this.barName);
        } else {
          onResult(false, this.barName);
        }
      })
      .catch(() => onResult(false, this.barName));
  }

  destroy(): void {
    this._sprite.destroy();
    this._timerText.destroy();
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private _respawn(): void {
    this._harvested   = false;
    this._harvestedAt = null;
    this._timerText.setVisible(false);
    this._sprite.setVisible(true).setAlpha(0);
    this._scene.tweens.add({
      targets:  this._sprite,
      alpha:    1,
      duration: 600,
      ease:     'Quad.easeOut',
    });
  }

  // ── Static factory ───────────────────────────────────────────────────────

  /**
   * Deterministically seed NODES_PER_CHUNK mineral nodes for one chunk.
   * Node positions are scattered across the chunk's walkable tile area.
   * Node IDs encode dailySeed + chunkIdx + slot for stable server persistence.
   * Returns the created nodes (already added to the scene).
   */
  static seedForChunk(
    chunk:      ChunkSpec,
    chunkIdx:   number,
    dailySeed:  number,
    scene:      Phaser.Scene,
  ): WorldMineralNode[] {
    const tw = TileWorld.getInstance();

    // Chunk pixel bounds (mirrors WorldCombatManager.seedChunk geometry)
    const minWorld = tw.tileToWorld(chunk.offsetTx,                   chunk.offsetTy);
    const maxWorld = tw.tileToWorld(chunk.offsetTx + ZONE_HALF_W * 2, chunk.offsetTy - ZONE_DEPTH);
    const boundsMinX = minWorld.x;
    const boundsMinY = maxWorld.y;
    const boundsMaxX = maxWorld.x;
    const boundsMaxY = minWorld.y;

    // LCG — mix daily seed with chunk index and a mineral-specific salt
    let s = (dailySeed ^ (chunkIdx * 0x9e3779b9) ^ 0x4d455241) >>> 0;
    const rng = (): number => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };

    // Scale node count by materialDensity (0.5–1.5 → typically 1–4 nodes)
    const count = Math.max(1, Math.round(NODES_PER_CHUNK * chunk.materialDensity));
    const nodes: WorldMineralNode[] = [];

    const inset = 16; // px — keep nodes away from chunk edges

    for (let i = 0; i < count; i++) {
      // Pick mineral type
      const entry = ZONE_MINERAL_POOL[Math.floor(rng() * ZONE_MINERAL_POOL.length)];

      // Random position within inset bounds
      const x = boundsMinX + inset + rng() * (boundsMaxX - boundsMinX - inset * 2);
      const y = boundsMinY + inset + rng() * (boundsMaxY - boundsMinY - inset * 2);

      // Stable node ID: encodes daily seed + chunk + slot (server uses this for dedup)
      const nodeId = `zone_${dailySeed}_c${chunkIdx}_n${i}`;

      nodes.push(new WorldMineralNode(
        scene, nodeId, entry.barItemId, entry.barName, entry.spriteKey, x, y,
      ));
    }

    return nodes;
  }
}
