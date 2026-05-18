/**
 * CoinManager — manages coin sprite pool for PHOBOS World.
 *
 * Pre-allocates MAX_COINS coin objects. Coins spawn at the active
 * persona position, tween along a bezier path to a random plaza tile,
 * then bob gently until collected or despawned.
 *
 * Design doc §5: max 40 on screen, oldest despawn if cap hit.
 */

import * as Phaser from 'phaser';
import type { PersonaName } from './GameStore';

const MAX_COINS = 40;
const PLAZA_CENTER_X = 400;
const PLAZA_CENTER_Y = 380;
const PLAZA_SCATTER = 80; // random scatter radius around plaza center
const COLLECT_RADIUS = 24; // generous collection radius
const BOB_SPEED = 0.04;
const BOB_AMP = 1.5;

// Size tiers — visual only (design doc §5.1)
const COIN_SIZES: Record<string, { radius: number; color: number }> = {
  small:  { radius: 3, color: 0xffd700 },
  medium: { radius: 4, color: 0xffb800 },
  large:  { radius: 5, color: 0xff9500 },
};

interface CoinObject {
  circle: Phaser.GameObjects.Ellipse;
  value: number;
  active: boolean;
  bobPhase: number;
  restX: number;
  restY: number;
  spawnTime: number;
}

export class CoinManager {
  private scene: Phaser.Scene;
  private pool: CoinObject[] = [];
  private activeCount = 0;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;

    // Pre-allocate coin pool
    for (let i = 0; i < MAX_COINS; i++) {
      const circle = scene.add.ellipse(0, 0, 6, 6, 0xffd700)
        .setDepth(8)
        .setVisible(false);

      this.pool[i] = {
        circle,
        value: 0,
        active: false,
        bobPhase: 0,
        restX: 0,
        restY: 0,
        spawnTime: 0,
      };
    }
  }

  /**
   * Spawn a coin at the given persona's approximate screen position.
   * The coin tweens to a random plaza tile and then bobs.
   */
  spawn(source: PersonaName, value: number, size: 'small' | 'medium' | 'large'): void {
    // Find a free slot
    let slot: CoinObject | null = null;
    for (let i = 0; i < MAX_COINS; i++) {
      if (!this.pool[i].active) {
        slot = this.pool[i];
        break;
      }
    }

    // If all slots full, despawn the oldest
    if (!slot) {
      let oldest: CoinObject | null = null;
      let oldestTime = Infinity;
      for (let i = 0; i < MAX_COINS; i++) {
        if (this.pool[i].active && this.pool[i].spawnTime < oldestTime) {
          oldestTime = this.pool[i].spawnTime;
          oldest = this.pool[i];
        }
      }
      if (oldest) {
        oldest.active = false;
        oldest.circle.setVisible(false);
        this.activeCount--;
      }
      slot = oldest;
    }

    if (!slot) return;

    // Source position (approximate persona location)
    const srcPos = this.personaPosition(source);
    const tier = COIN_SIZES[size] ?? COIN_SIZES.small;

    // Random plaza destination
    const destX = PLAZA_CENTER_X + (Math.random() - 0.5) * PLAZA_SCATTER * 2;
    const destY = PLAZA_CENTER_Y + (Math.random() - 0.5) * PLAZA_SCATTER * 2;

    // Configure the coin
    slot.circle.setPosition(srcPos.x, srcPos.y);
    slot.circle.setSize(tier.radius * 2, tier.radius * 2);
    slot.circle.setFillStyle(tier.color);
    slot.circle.setVisible(true);
    slot.circle.setAlpha(1);
    slot.value = value;
    slot.active = true;
    slot.bobPhase = Math.random() * Math.PI * 2;
    slot.restX = destX;
    slot.restY = destY;
    slot.spawnTime = Date.now();
    this.activeCount++;

    // Bezier tween to plaza
    const midX = (srcPos.x + destX) / 2 + (Math.random() - 0.5) * 60;
    const midY = Math.min(srcPos.y, destY) - 40 - Math.random() * 30;

    this.scene.tweens.addCounter({
      from: 0,
      to: 1,
      duration: 600 + Math.random() * 400,
      ease: 'Sine.easeInOut',
      onUpdate: (tween) => {
        const t = tween.getValue();
        const u = 1 - t;
        // Quadratic bezier: P = (1-t)²P0 + 2(1-t)tP1 + t²P2
        const x = u * u * srcPos.x + 2 * u * t * midX + t * t * destX;
        const y = u * u * srcPos.y + 2 * u * t * midY + t * t * destY;
        slot!.circle.setPosition(x, y);
      },
    });
  }

  /**
   * Check if any active coin is within collection radius of (px, py).
   * Returns total value collected and removes those coins.
   */
  collectAt(px: number, py: number): number {
    let total = 0;
    for (let i = 0; i < MAX_COINS; i++) {
      const c = this.pool[i];
      if (!c.active) continue;
      const dx = c.circle.x - px;
      const dy = c.circle.y - py;
      if (dx * dx + dy * dy < COLLECT_RADIUS * COLLECT_RADIUS) {
        total += c.value;
        c.active = false;
        c.circle.setVisible(false);
        this.activeCount--;
      }
    }
    return total;
  }

  /**
   * Auto-collect: AI personas collect coins when idle.
   * Returns total collected.
   */
  autoCollect(persona: PersonaName): number {
    const pos = this.personaPosition(persona);
    return this.collectAt(pos.x, pos.y);
  }

  /** Per-frame update — bob animation for resting coins. */
  update(delta: number): void {
    const dt = delta / 16.667;
    for (let i = 0; i < MAX_COINS; i++) {
      const c = this.pool[i];
      if (!c.active) continue;

      // Only bob if the tween has finished (coin is near rest position)
      const dx = c.circle.x - c.restX;
      const dy = c.circle.y - c.restY;
      if (dx * dx + dy * dy < 4) {
        c.bobPhase += BOB_SPEED * dt;
        c.circle.y = c.restY + Math.sin(c.bobPhase) * BOB_AMP;
      }
    }
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  private personaPosition(persona: PersonaName): { x: number; y: number } {
    // Approximate screen positions matching CharacterSprite zone centers
    switch (persona) {
      case 'sayon': return { x: 320, y: 520 };
      case 'seren': return { x: 640, y: 240 };
      case 'sybil': return { x: 160, y: 240 };
      default:      return { x: 400, y: 380 };
    }
  }
}
