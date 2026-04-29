/**
 * GameStore — DuckDB persistence for PHOBOS World game state.
 *
 * Tables: game_player, game_inventory, game_decorations.
 * Writes only on user actions — never on hot path.
 */

import { DatabaseManager } from './DatabaseManager.js';
import crypto from 'node:crypto';

const GAME_SCHEMA = `
CREATE TABLE IF NOT EXISTS game_player (
  id              VARCHAR PRIMARY KEY DEFAULT 'local',
  name            VARCHAR,
  element         VARCHAR DEFAULT 'plasma',
  weapon          VARCHAR DEFAULT 'sword',
  laser_color     VARCHAR DEFAULT '#ffffff',
  player_class    VARCHAR DEFAULT 'fighter',
  body_type       VARCHAR DEFAULT 'a',
  phobos_coins    INTEGER DEFAULT 0,
  level           INTEGER DEFAULT 1,
  experience      INTEGER DEFAULT 0,
  unspent_points  INTEGER DEFAULT 5,
  bonus_str       INTEGER DEFAULT 0,
  bonus_dex       INTEGER DEFAULT 0,
  bonus_int       INTEGER DEFAULT 0,
  bonus_agi       INTEGER DEFAULT 0,
  bonus_vit       INTEGER DEFAULT 0,
  skill_points    INTEGER DEFAULT 1,
  unlocked_nodes  VARCHAR DEFAULT '[]',
  ether_held      INTEGER DEFAULT 0,
  ether_banked    INTEGER DEFAULT 0,
  created_at      TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_inventory (
  id          VARCHAR PRIMARY KEY,
  item_id     VARCHAR NOT NULL,
  target      VARCHAR NOT NULL,
  equipped    BOOLEAN DEFAULT false,
  acquired_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_decorations (
  id          VARCHAR PRIMARY KEY,
  item_id     VARCHAR NOT NULL,
  tile_x      INTEGER,
  tile_y      INTEGER,
  placed_at   TIMESTAMP DEFAULT now()
);
`;

/** Migrate old schema — add columns that may be missing. */
const GAME_MIGRATION = `
ALTER TABLE game_player ADD COLUMN IF NOT EXISTS player_class VARCHAR DEFAULT 'fighter';
ALTER TABLE game_player ADD COLUMN IF NOT EXISTS body_type VARCHAR DEFAULT 'a';
ALTER TABLE game_player ADD COLUMN IF NOT EXISTS unspent_points INTEGER DEFAULT 5;
ALTER TABLE game_player ADD COLUMN IF NOT EXISTS bonus_str INTEGER DEFAULT 0;
ALTER TABLE game_player ADD COLUMN IF NOT EXISTS bonus_dex INTEGER DEFAULT 0;
ALTER TABLE game_player ADD COLUMN IF NOT EXISTS bonus_int INTEGER DEFAULT 0;
ALTER TABLE game_player ADD COLUMN IF NOT EXISTS bonus_agi INTEGER DEFAULT 0;
ALTER TABLE game_player ADD COLUMN IF NOT EXISTS bonus_vit INTEGER DEFAULT 0;
ALTER TABLE game_player ADD COLUMN IF NOT EXISTS skill_points INTEGER DEFAULT 1;
ALTER TABLE game_player ADD COLUMN IF NOT EXISTS unlocked_nodes VARCHAR DEFAULT '[]';
ALTER TABLE game_player ADD COLUMN IF NOT EXISTS ether_held INTEGER DEFAULT 0;
ALTER TABLE game_player ADD COLUMN IF NOT EXISTS ether_banked INTEGER DEFAULT 0;
ALTER TABLE game_inventory ADD COLUMN IF NOT EXISTS slot VARCHAR DEFAULT '';
ALTER TABLE game_inventory ADD COLUMN IF NOT EXISTS rarity INTEGER DEFAULT 0;
ALTER TABLE game_inventory ADD COLUMN IF NOT EXISTS data VARCHAR DEFAULT '{}';
`;

/** XP required to reach a given level (cumulative total). Formula: 100 * level^1.5 per level. */
function xpRequiredForLevel(level: number): number {
  let total = 0;
  for (let l = 1; l < level; l++) {
    total += Math.round(100 * Math.pow(l, 1.5));
  }
  return total;
}

export interface GamePlayer {
  id: string;
  name: string | null;
  element: string;
  weapon: string;
  laser_color: string;
  player_class: string;
  body_type: string;
  phobos_coins: number;
  level: number;
  experience: number;
  unspent_points: number;
  bonus_str: number;
  bonus_dex: number;
  bonus_int: number;
  bonus_agi: number;
  bonus_vit: number;
  skill_points: number;
  unlocked_nodes: string;
  ether_held: number;
  ether_banked: number;
  created_at: string;
}

export interface GameInventoryItem {
  id: string;
  item_id: string;
  target: string;
  equipped: boolean;
  slot: string;
  rarity: number;
  data: string;
  acquired_at: string;
}

export interface GameDecoration {
  id: string;
  item_id: string;
  tile_x: number;
  tile_y: number;
  placed_at: string;
}

export class GameStore {
  private db: DatabaseManager;

  constructor(db: DatabaseManager) {
    this.db = db;
  }

  async ensureTable(): Promise<void> {
    try {
      await this.db.run(GAME_SCHEMA);
      // Migrate existing tables — add new columns if missing
      for (const stmt of GAME_MIGRATION.split(';').map(s => s.trim()).filter(Boolean)) {
        try { await this.db.run(stmt); } catch { /* column already exists */ }
      }
      console.log('[GameStore] Tables ready');
    } catch (err) {
      console.warn('[GameStore] Table creation warning:', err);
    }
  }

  // ── Player ─────────────────────────────────────────────────────────────

  async getPlayer(): Promise<GamePlayer | null> {
    const rows = await this.db.query<GamePlayer>(
      `SELECT * FROM game_player WHERE id = 'local'`
    );
    return rows.length > 0 ? rows[0] : null;
  }

  async ensurePlayer(): Promise<GamePlayer> {
    let player = await this.getPlayer();
    if (!player) {
      await this.db.run(
        `INSERT INTO game_player (id) VALUES ('local')`
      );
      player = await this.getPlayer();
    }
    return player!;
  }

  async updatePlayer(fields: Partial<Pick<GamePlayer,
    'name' | 'element' | 'weapon' | 'laser_color' | 'player_class' | 'body_type' |
    'phobos_coins' | 'level' | 'experience' | 'unspent_points' |
    'bonus_str' | 'bonus_dex' | 'bonus_int' | 'bonus_agi' | 'bonus_vit' |
    'skill_points' | 'unlocked_nodes' | 'ether_held' | 'ether_banked'
  >>): Promise<GamePlayer> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(v);
      }
    }
    if (sets.length > 0) {
      await this.db.run(
        `UPDATE game_player SET ${sets.join(', ')} WHERE id = 'local'`,
        vals
      );
    }
    return (await this.getPlayer())!;
  }

  /**
   * Add XP to the player, computing level-ups.
   * Returns the updated level and total XP. Level is capped at 100.
   */
  async addXp(amount: number): Promise<{ level: number; xp: number }> {
    const player = await this.ensurePlayer();
    const newXp = player.experience + amount;
    let newLevel = player.level;

    while (newLevel < 100 && newXp >= xpRequiredForLevel(newLevel + 1)) {
      newLevel++;
    }

    await this.db.run(
      `UPDATE game_player SET experience = ?, level = ? WHERE id = 'local'`,
      [newXp, newLevel]
    );

    return { level: newLevel, xp: newXp };
  }

  async addCoins(amount: number): Promise<number> {
    await this.db.run(
      `UPDATE game_player SET phobos_coins = phobos_coins + ? WHERE id = 'local'`,
      [amount]
    );
    const p = await this.getPlayer();
    return p?.phobos_coins ?? 0;
  }

  async spendCoins(amount: number): Promise<{ ok: boolean; remaining: number }> {
    const p = await this.getPlayer();
    if (!p || p.phobos_coins < amount) return { ok: false, remaining: p?.phobos_coins ?? 0 };
    await this.db.run(
      `UPDATE game_player SET phobos_coins = phobos_coins - ? WHERE id = 'local'`,
      [amount]
    );
    const updated = await this.getPlayer();
    return { ok: true, remaining: updated?.phobos_coins ?? 0 };
  }

  // ── Ether ──────────────────────────────────────────────────────────────

  async depositEther(amount: number): Promise<{ ether_held: number; ether_banked: number }> {
    const p = await this.ensurePlayer();
    const deposit = Math.min(amount, p.ether_held);
    if (deposit <= 0) return { ether_held: p.ether_held, ether_banked: p.ether_banked };
    await this.db.run(
      `UPDATE game_player SET ether_held = ether_held - ?, ether_banked = ether_banked + ? WHERE id = 'local'`,
      [deposit, deposit]
    );
    const updated = await this.getPlayer();
    return { ether_held: updated!.ether_held, ether_banked: updated!.ether_banked };
  }

  async withdrawEther(amount: number): Promise<{ ether_held: number; ether_banked: number }> {
    const p = await this.ensurePlayer();
    const withdraw = Math.min(amount, p.ether_banked);
    if (withdraw <= 0) return { ether_held: p.ether_held, ether_banked: p.ether_banked };
    await this.db.run(
      `UPDATE game_player SET ether_held = ether_held + ?, ether_banked = ether_banked - ? WHERE id = 'local'`,
      [withdraw, withdraw]
    );
    const updated = await this.getPlayer();
    return { ether_held: updated!.ether_held, ether_banked: updated!.ether_banked };
  }

  // ── Inventory ──────────────────────────────────────────────────────────

  async getInventory(target?: string): Promise<GameInventoryItem[]> {
    if (target) {
      return this.db.query<GameInventoryItem>(
        `SELECT * FROM game_inventory WHERE target = ? ORDER BY acquired_at DESC`, [target]
      );
    }
    return this.db.query<GameInventoryItem>(
      `SELECT * FROM game_inventory ORDER BY acquired_at DESC`
    );
  }

  async getEquippedItems(): Promise<GameInventoryItem[]> {
    return this.db.query<GameInventoryItem>(
      `SELECT * FROM game_inventory WHERE equipped = true`
    );
  }

  async addItem(itemId: string, target: string, slot = '', rarity = 0, data = '{}'): Promise<GameInventoryItem> {
    const id = crypto.randomUUID();
    await this.db.run(
      `INSERT INTO game_inventory (id, item_id, target, slot, rarity, data) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, itemId, target, slot, rarity, data]
    );
    const rows = await this.db.query<GameInventoryItem>(
      `SELECT * FROM game_inventory WHERE id = ?`, [id]
    );
    return rows[0];
  }

  async equipItem(id: string): Promise<void> {
    const rows = await this.db.query<GameInventoryItem>(
      `SELECT * FROM game_inventory WHERE id = ?`, [id]
    );
    if (rows.length === 0) return;
    const item = rows[0];
    // Unequip existing item in the same slot
    if (item.slot) {
      await this.db.run(
        `UPDATE game_inventory SET equipped = false WHERE slot = ? AND equipped = true`,
        [item.slot]
      );
    }
    await this.db.run(
      `UPDATE game_inventory SET equipped = true WHERE id = ?`,
      [id]
    );
  }

  async unequipItem(id: string): Promise<void> {
    await this.db.run(
      `UPDATE game_inventory SET equipped = false WHERE id = ?`,
      [id]
    );
  }

  async removeItem(id: string): Promise<void> {
    await this.db.run(
      `DELETE FROM game_inventory WHERE id = ?`, [id]
    );
  }

  // ── Decorations ────────────────────────────────────────────────────────

  async getDecorations(): Promise<GameDecoration[]> {
    return this.db.query<GameDecoration>(
      `SELECT * FROM game_decorations ORDER BY placed_at DESC`
    );
  }

  async placeDecoration(itemId: string, tileX: number, tileY: number): Promise<GameDecoration> {
    const id = crypto.randomUUID();
    await this.db.run(
      `INSERT INTO game_decorations (id, item_id, tile_x, tile_y) VALUES (?, ?, ?, ?)`,
      [id, itemId, tileX, tileY]
    );
    const rows = await this.db.query<GameDecoration>(
      `SELECT * FROM game_decorations WHERE id = ?`, [id]
    );
    return rows[0];
  }

  async removeDecoration(id: string): Promise<void> {
    await this.db.run(`DELETE FROM game_decorations WHERE id = ?`, [id]);
  }
}
