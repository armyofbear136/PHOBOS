/**
 * WorldLootDrop — world-space item pickups dropped on enemy kills.
 *
 * Pool: fixed ring buffer of MAX_DROPS slots. Slots reuse Phaser GameObjects —
 * only position and tint change on activation; no new objects after warm-up.
 *
 * Lifecycle:
 *   spawnFromKill(enemy)  — generate loot for the killed enemy, activate slots
 *   update(delta, px, py) — proximity scan; collect on contact; POST to server
 *   clearZone()           — deactivate all live pickups (no network call)
 *
 * Visual: small diamond (rectangle rotated 45°) tinted by item rarity,
 * with a matching pulsing glow circle beneath it.
 *
 * Network: fire-and-forget POST per collected item. No retry — dropped items
 * are convenience rewards; a missed POST is acceptable. Errors go to console only.
 */

import * as Phaser from 'phaser';
import { generateLoot }                  from './ItemGenerator';
import { RARITIES }                      from './ItemDefinitions';
import type { GameItem, EnemyArchetype } from './ItemDefinitions';
import { ENGINE_URL }                    from '../lib/engineUrl';
import type { PlayerCombatController }   from './PlayerCombatController';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_DROPS        = 48;   // hard cap — ring wraps if exceeded (oldest evicted)
const COLLECT_RADIUS   = 20;   // px — auto-collect range
const COLLECT_RADIUS_SQ = COLLECT_RADIUS * COLLECT_RADIUS;
const DIAMOND_SIZE     = 6;    // px half-extent of pickup diamond
const GLOW_RADIUS      = 9;    // px
const FLOAT_AMPLITUDE  = 2;    // px vertical float
const FLOAT_SPEED      = 0.003; // radians per ms

// ── Power-up constants ────────────────────────────────────────────────────────

const POWERUP_DROP_CHANCE    = 0.20;  // 20% chance per kill
const POWERUP_DURATION_MS    = 10000; // 10 seconds

const POWERUP_DAMAGE_MULT    = 1.50;  // +50% damage
const POWERUP_RESIST_MULT    = 0.50;  // −50% damage received

// Visual colours for power-up pickups
const POWERUP_DAMAGE_COLOR   = 0xff6622;  // orange — aggressive
const POWERUP_RESIST_COLOR   = 0x44aaff;  // blue — defensive

// Power-up pickups use a slightly larger star shape
const POWERUP_DIAMOND_SIZE   = 9;
const POWERUP_GLOW_RADIUS    = 14;

// ── Archetype mapping ─────────────────────────────────────────────────────────
// EnemyTemplate.archetype is 'dummy'|'minion'|'warrior'|'leader'|'boss'
// generateLoot expects EnemyArchetype: 'training_dummy'|'minion'|'warrior'|'leader'|'boss'

function toEnemyArchetype(arch: string): EnemyArchetype {
  return arch === 'dummy' ? 'training_dummy' : arch as EnemyArchetype;
}

// ── Seeded LCG (no Math.random in loot gen — reproducibility) ─────────────────

function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = Math.imul(s, 16807) >>> 0;
    s = (s + 1) >>> 0;
    return s / 0x100000000;
  };
}

// ── Slot shape ────────────────────────────────────────────────────────────────

interface DropSlot {
  active:    boolean;
  item:      GameItem | null;
  /** Non-null when this slot holds a power-up instead of an inventory item. */
  powerup:   'damage' | 'resist' | null;
  x:         number;
  y:         number;
  baseY:     number;
  phase:     number;   // float animation phase (radians)
  diamond:   Phaser.GameObjects.Rectangle;
  glow:      Phaser.GameObjects.Arc;
}

// ── WorldLootDrop ─────────────────────────────────────────────────────────────

export class WorldLootDrop {
  private readonly _slots: DropSlot[];
  private _head  = 0;   // ring write cursor
  private _dx    = 0;   // scratch
  private _dy    = 0;

  /** Set after construction — used to apply power-up buffs on collect. */
  controller: PlayerCombatController | null = null;

  constructor(scene: Phaser.Scene) {
    this._slots = new Array(MAX_DROPS);
    for (let i = 0; i < MAX_DROPS; i++) {
      const glow    = scene.add.circle(0, 0, GLOW_RADIUS, 0xffffff, 0).setDepth(2).setVisible(false);
      const diamond = scene.add.rectangle(0, 0, DIAMOND_SIZE, DIAMOND_SIZE, 0xffffff, 1)
        .setDepth(3).setAngle(45).setVisible(false);

      this._slots[i] = {
        active: false, item: null, powerup: null,
        x: 0, y: 0, baseY: 0, phase: i * 0.42,
        diamond, glow,
      };
    }
  }

  // ── Enemy kill → spawn loot ───────────────────────────────────────────────

  spawnFromKill(
    worldX:   number,
    worldY:   number,
    archetype: string,
    element:   import('./PlayerClasses').ElementType,
    killSeed:  number,
  ): void {
    const rng   = makeLcg(killSeed);
    const items = generateLoot(toEnemyArchetype(archetype), element, rng);

    for (const item of items) {
      this._activateSlot(item, worldX, worldY);
    }

    // 20% chance to drop a power-up — type determined by rng, not by archetype
    if (rng() < POWERUP_DROP_CHANCE) {
      const type: 'damage' | 'resist' = rng() < 0.5 ? 'damage' : 'resist';
      this._activatePowerUp(type, worldX, worldY);
    }
  }

  /** Deactivate all live pickups. Called on zone exit or arena shutdown. */
  clearZone(): void {
    for (let i = 0; i < MAX_DROPS; i++) {
      if (this._slots[i].active) this._deactivate(this._slots[i]);
    }
  }

  // ── Per-frame update ──────────────────────────────────────────────────────

  update(delta: number, playerX: number, playerY: number): void {
    for (let i = 0; i < MAX_DROPS; i++) {
      const s = this._slots[i];
      if (!s.active) continue;

      // Float animation — mutate baseY projection only, no new object
      s.phase += FLOAT_SPEED * delta;
      const floatY = s.baseY + Math.sin(s.phase) * FLOAT_AMPLITUDE;
      s.y = floatY;
      s.diamond.setPosition(s.x, floatY);
      s.glow.setPosition(s.x, s.baseY);

      // Proximity collect
      this._dx = playerX - s.x;
      this._dy = playerY - s.y;
      if (this._dx * this._dx + this._dy * this._dy < COLLECT_RADIUS_SQ) {
        this._collect(s, i);
      }
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _activatePowerUp(type: 'damage' | 'resist', x: number, y: number): void {
    const idx = this._head;
    this._head = (this._head + 1) % MAX_DROPS;

    const s = this._slots[idx];
    if (s.active) this._deactivate(s);

    const color   = type === 'damage' ? POWERUP_DAMAGE_COLOR : POWERUP_RESIST_COLOR;
    const scatter = (Math.random() - 0.5) * 20;

    s.active  = true;
    s.item    = null;
    s.powerup = type;
    s.x       = x + scatter;
    s.baseY   = y + (Math.random() - 0.5) * 14;
    s.y       = s.baseY;
    s.phase   = Math.random() * Math.PI * 2;

    // Larger diamond and glow than item pickups — visually distinct
    s.diamond
      .setSize(POWERUP_DIAMOND_SIZE, POWERUP_DIAMOND_SIZE)
      .setPosition(s.x, s.baseY)
      .setFillStyle(color, 1)
      .setVisible(true);
    s.glow
      .setRadius(POWERUP_GLOW_RADIUS)
      .setPosition(s.x, s.baseY)
      .setFillStyle(color, 0.30)
      .setVisible(true);
  }

  private _activateSlot(item: GameItem, x: number, y: number): void {
    // Evict oldest slot if pool is exhausted
    const idx = this._head;
    this._head = (this._head + 1) % MAX_DROPS;

    const s = this._slots[idx];
    if (s.active) {
      // Slot was live — silently evict (oldest drop, player hasn't collected it)
      this._deactivate(s);
    }

    const rarityColor = RARITIES[item.rarity]?.tintColor ?? 0x808080;
    const scatter     = (Math.random() - 0.5) * 16; // light scatter on drop

    s.active  = true;
    s.item    = item;
    s.powerup = null;
    s.x       = x + scatter;
    s.baseY   = y + (Math.random() - 0.5) * 12;
    s.y       = s.baseY;
    s.phase   = Math.random() * Math.PI * 2;

    // Reset to item pickup size in case this slot was previously a power-up
    s.diamond
      .setSize(DIAMOND_SIZE, DIAMOND_SIZE)
      .setPosition(s.x, s.baseY)
      .setFillStyle(rarityColor, 1)
      .setVisible(true);
    s.glow
      .setRadius(GLOW_RADIUS)
      .setPosition(s.x, s.baseY)
      .setFillStyle(rarityColor, 0.22)
      .setVisible(true);
  }

  private _collect(s: DropSlot, _idx: number): void {
    if (s.powerup !== null) {
      // Power-up — apply buff to controller, no network call
      const type = s.powerup;
      this._deactivate(s);
      if (this.controller) {
        const mult = type === 'damage' ? POWERUP_DAMAGE_MULT : POWERUP_RESIST_MULT;
        this.controller.applyPowerUp(type, mult, POWERUP_DURATION_MS);
      }
    } else {
      const item = s.item!;
      this._deactivate(s);
      this._postItem(item);
    }
  }

  private _deactivate(s: DropSlot): void {
    s.active  = false;
    s.item    = null;
    s.powerup = null;
    s.diamond.setVisible(false);
    s.glow.setVisible(false);
  }

  /** Fire-and-forget. A missed POST is acceptable; no retry. */
  private _postItem(item: GameItem): void {
    fetch(`${ENGINE_URL}/api/game/inventory/add`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item_id: item.id,
        target:  'player',
        slot:    item.slot ?? '',
        rarity:  item.rarity,
        data:    JSON.stringify(item),
      }),
    }).catch((err: unknown) => {
      console.error('[WorldLootDrop] inventory/add failed:', err);
    });
  }
}