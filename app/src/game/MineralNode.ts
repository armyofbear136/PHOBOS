/**
 * MineralNode — harvestable crystal mineral node in the hub world.
 *
 * Rendered as a Phaser sprite at a fixed world position.
 * Player walks within HARVEST_RADIUS and presses E to harvest.
 * After harvest: sprite hides, respawn timer shows (1 hour real-time).
 * On respawn: sprite reappears with a brief sparkle tween.
 *
 * Respawn state is persisted via /api/game/minerals/harvest and
 * /api/game/minerals/status. All instances are polled once on init
 * via a single batched status request.
 */

import * as Phaser from 'phaser';
import { tileToViewport } from './CoordSystem';

export interface MineralNodeDef {
  /** Stable id — persisted to DB. e.g. 'lumite_0' */
  nodeId:    string;
  /** Phaser texture key — e.g. 'mineral-lumite-medium' */
  spriteKey: string;
  /** Crystal bar item_id sent to harvest endpoint — e.g. 'lumite_bar' */
  barItemId: string;
  /** Display name shown in prompt */
  barName:   string;
  /** Tile coordinate */
  tx: number;
  ty: number;
}

const HARVEST_RADIUS = 52;       // world pixels — generous to account for iso perspective
const RESPAWN_MS     = 60 * 60 * 1000;  // 1 hour, matches server
const ENGINE_URL     = () =>
  (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

export class MineralNode {
  readonly nodeId:    string;
  readonly barItemId: string;
  readonly barName:   string;
  readonly worldX:    number;
  readonly worldY:    number;

  private _sprite:       Phaser.GameObjects.Image;
  private _timerText:    Phaser.GameObjects.Text;
  private _harvested     = false;
  private _harvestedAt:  number | null = null;   // epoch ms
  private _scene:        Phaser.Scene;

  constructor(scene: Phaser.Scene, def: MineralNodeDef) {
    this._scene    = scene;
    this.nodeId    = def.nodeId;
    this.barItemId = def.barItemId;
    this.barName   = def.barName;

    const world = MineralNode.tileToWorld(def.tx, def.ty);
    this.worldX = world.x;
    this.worldY = world.y;

    this._sprite = scene.add.image(world.x, world.y, def.spriteKey)
      .setOrigin(0.5, 1)
      .setDepth(9)
      .setScale(1);

    this._timerText = scene.add.text(world.x, world.y - 28, '', {
      fontSize: '6px', fontFamily: 'monospace',
      color: '#aaaaaa', stroke: '#000', strokeThickness: 2, resolution: 4,
    }).setOrigin(0.5, 1).setDepth(12).setVisible(false);
  }

  // ── Static helpers ──────────────────────────────────────────────────────

  private static tileToWorld(tx: number, ty: number): { x: number; y: number } {
    // Mirrors TileWorld.tileToWorld — HALF_W=16, HALF_H=8, ORIGIN_X=448
    const HALF_W = 16, HALF_H = 8, ORIGIN_X = 448;
    return {
      x: (tx - ty) * HALF_W + ORIGIN_X,
      y: (tx + ty) * HALF_H,
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Apply persisted harvested_at from batch status response. */
  applyStatus(harvestedAt: string | null): void {
    if (!harvestedAt) return;
    const ts = new Date(harvestedAt).getTime();
    if (Date.now() - ts < RESPAWN_MS) {
      this._harvested   = true;
      this._harvestedAt = ts;
      this._sprite.setVisible(false);
      this._timerText.setVisible(true);
    }
  }

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
   * Attempt harvest. Calls backend, adds item to inventory on success.
   * onResult(success, barName) called when response arrives.
   */
  harvest(onResult: (success: boolean, barName: string) => void): void {
    if (this._harvested) { onResult(false, this.barName); return; }

    fetch(`${ENGINE_URL()}/api/game/minerals/harvest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_id: this.nodeId, bar_item_id: this.barItemId }),
    })
      .then(r => r.json())
      .then((data: { ok?: boolean; error?: string }) => {
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
}

// ── Node definitions ────────────────────────────────────────────────────────
// Tile positions are seeded deterministically. Each mineral type gets 2–3 nodes
// spread across the hub (avoid player zone so nodes are exploration rewards).
// Solarium is rare — 1 node only, in a less-travelled spot.

export const MINERAL_NODE_DEFS: MineralNodeDef[] = [
  // Lumite (pink) — sayon zone + corridor
  { nodeId: 'lumite_0', spriteKey: 'mineral-lumite-medium',  barItemId: 'lumite_bar',  barName: 'Lumite Bar',  tx:  8, ty: 20 },
  { nodeId: 'lumite_1', spriteKey: 'mineral-lumite-small',   barItemId: 'lumite_bar',  barName: 'Lumite Bar',  tx: 12, ty:  4 },
  // Ferrite (red) — sybil zone
  { nodeId: 'ferrite_0', spriteKey: 'mineral-ferrite-medium', barItemId: 'ferrite_bar', barName: 'Ferrite Bar', tx:  4, ty:  8 },
  { nodeId: 'ferrite_1', spriteKey: 'mineral-ferrite-small',  barItemId: 'ferrite_bar', barName: 'Ferrite Bar', tx:  9, ty:  2 },
  // Aurite (brown) — corridor + plaza edge
  { nodeId: 'aurite_0', spriteKey: 'mineral-aurite-medium',  barItemId: 'aurite_bar',  barName: 'Aurite Bar',  tx: 18, ty:  5 },
  { nodeId: 'aurite_1', spriteKey: 'mineral-aurite-small',   barItemId: 'aurite_bar',  barName: 'Aurite Bar',  tx: 15, ty: 18 },
  // Verdite (green) — seren zone
  { nodeId: 'verdite_0', spriteKey: 'mineral-verdite-medium', barItemId: 'verdite_bar', barName: 'Verdite Bar', tx: 28, ty:  2 },
  { nodeId: 'verdite_1', spriteKey: 'mineral-verdite-small',  barItemId: 'verdite_bar', barName: 'Verdite Bar', tx: 35, ty:  6 },
  // Azurite (blue) — seren zone + plaza
  { nodeId: 'azurite_0', spriteKey: 'mineral-azurite-medium', barItemId: 'azurite_bar', barName: 'Azurite Bar', tx: 32, ty: 10 },
  { nodeId: 'azurite_1', spriteKey: 'mineral-azurite-small',  barItemId: 'azurite_bar', barName: 'Azurite Bar', tx: 22, ty: 14 },
  // Fluxite (black) — far corners, harder to reach
  { nodeId: 'fluxite_0', spriteKey: 'mineral-fluxite-medium', barItemId: 'fluxite_bar', barName: 'Fluxite Bar', tx:  2, ty:  2 },
  { nodeId: 'fluxite_1', spriteKey: 'mineral-fluxite-small',  barItemId: 'fluxite_bar', barName: 'Fluxite Bar', tx: 38, ty:  2 },
  // Solarium (yellow) — rare, plaza centre
  { nodeId: 'solarium_0', spriteKey: 'mineral-solarium-big', barItemId: 'solarium_bar', barName: 'Solarium Bar', tx: 20, ty: 10 },
];
