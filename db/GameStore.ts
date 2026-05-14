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

CREATE TABLE IF NOT EXISTS game_buildings (
  id          VARCHAR PRIMARY KEY,
  building_id VARCHAR NOT NULL,
  tile_x      INTEGER NOT NULL,
  tile_y      INTEGER NOT NULL,
  state       VARCHAR DEFAULT 'placed',
  placed_at   TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_minerals (
  node_id       VARCHAR PRIMARY KEY,  -- stable seeded id, e.g. 'lumite_0'
  harvested_at  TIMESTAMP             -- NULL = available to harvest
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
ALTER TABLE game_buildings ADD COLUMN IF NOT EXISTS config VARCHAR DEFAULT '{}';
ALTER TABLE game_buildings ADD COLUMN IF NOT EXISTS last_collected_at TIMESTAMP;
ALTER TABLE game_buildings ADD COLUMN IF NOT EXISTS state VARCHAR DEFAULT 'blueprint';
CREATE TABLE IF NOT EXISTS game_minerals (node_id VARCHAR PRIMARY KEY, harvested_at TIMESTAMP);
ALTER TABLE game_player ADD COLUMN IF NOT EXISTS current_hp REAL DEFAULT NULL;
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
  /** Persisted HP between sessions. NULL means full HP (use hpMax from build). */
  current_hp: number | null;
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

export interface GameBuilding {
  id:                 string;
  building_id:        string;
  tile_x:             number;
  tile_y:             number;
  // 'blueprint' = placed, no materials supplied yet
  // 'building'  = partially supplied
  // 'built'     = all material slots fulfilled
  state:              'blueprint' | 'building' | 'built';
  // JSON: { slotId: { materialId: quantity } }
  // e.g. { "frame": { "heartwood_t2": 3 }, "core": {} }
  config:             string;
  // ISO timestamp of last RCS collection. Null until first collect.
  last_collected_at:  string | null;
  placed_at:          string;
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
    'skill_points' | 'unlocked_nodes' | 'ether_held' | 'ether_banked' | 'current_hp'
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

  /**
   * Patch the weaponStats.durability field inside an item's data blob.
   * Reads current data, merges only the durability field into weaponStats,
   * and writes back — all other item fields are preserved.
   * No-ops silently if the item doesn't exist or has no weaponStats.
   */
  async updateWeaponDurability(id: string, durability: number): Promise<void> {
    const rows = await this.db.query<{ data: string }>(
      `SELECT data FROM game_inventory WHERE id = ? AND target = 'player'`, [id]
    );
    if (!rows.length) return;
    let item: Record<string, unknown> = {};
    try { item = JSON.parse(rows[0].data); } catch { return; }
    if (!item.weaponStats) return;
    const ws = item.weaponStats as Record<string, unknown>;
    ws.durability = durability;
    await this.db.run(
      `UPDATE game_inventory SET data = ? WHERE id = ?`,
      [JSON.stringify(item), id]
    );
  }

  /**
   * Remove up to `quantity` inventory items matching a material_id stored
   * in the item data JSON. Returns the number actually removed.
   *
   * Items are matched by data->>'$.materialId' = material_id.
   * Removes oldest first (lowest rowid). Safe if fewer than quantity exist.
   */
  async consumeItems(materialId: string, quantity: number): Promise<number> {
    // Fetch candidate item UUIDs — match by data JSON field materialId
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM game_inventory
       WHERE json_extract(data, '$.materialId') = ?
         AND target = 'player'
       ORDER BY rowid ASC
       LIMIT ?`,
      [materialId, quantity]
    );
    for (const row of rows) {
      await this.db.run(`DELETE FROM game_inventory WHERE id = ?`, [row.id]);
    }
    return rows.length;
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

  // ── Buildings ──────────────────────────────────────────────────────────────

  async getBuildings(): Promise<GameBuilding[]> {
    return this.db.query<GameBuilding>(
      `SELECT * FROM game_buildings ORDER BY placed_at ASC`
    );
  }

    async placeBuilding(buildingId: string, tileX: number, tileY: number): Promise<GameBuilding> {
    const id = crypto.randomUUID();
    await this.db.run(
      `INSERT INTO game_buildings (id, building_id, tile_x, tile_y, state, config)
       VALUES (?, ?, ?, ?, 'blueprint', '{}')`,
      [id, buildingId, tileX, tileY]
    );
    const rows = await this.db.query<GameBuilding>(
      `SELECT * FROM game_buildings WHERE id = ?`, [id]
    );
    return rows[0];
  }
 
  async removeBuilding(id: string): Promise<void> {
    await this.db.run(`DELETE FROM game_buildings WHERE id = ?`, [id]);
  }
 
  /** Move a building to a new tile (relocate flow). */
  async updateBuildingPosition(id: string, tileX: number, tileY: number): Promise<GameBuilding> {
    await this.db.run(
      `UPDATE game_buildings SET tile_x = ?, tile_y = ? WHERE id = ?`,
      [tileX, tileY, id]
    );
    const rows = await this.db.query<GameBuilding>(
      `SELECT * FROM game_buildings WHERE id = ?`, [id]
    );
    return rows[0];
  }

    /**
   * Persist material supply progress and derive the new state.
   * config: full JSON string — { slotId: { materialId: quantity } }
   * state:  caller computes via progressToState() from HubBuildingCatalog.
   */
  async updateBuildingConfig(
    id: string,
    config: string,
    state: 'blueprint' | 'building' | 'built',
  ): Promise<GameBuilding> {
    await this.db.run(
      `UPDATE game_buildings SET config = ?, state = ? WHERE id = ?`,
      [config, state, id]
    );
    const rows = await this.db.query<GameBuilding>(
      `SELECT * FROM game_buildings WHERE id = ?`, [id]
    );
    return rows[0];
  }
 
  /**
   * Collect accumulated RCS output.
   * Returns the number of units collected and resets the timestamp.
   * Caller computes units via rcsAccumulatedUnits() from HubBuildingCatalog.
   */
  async collectRcsOutput(id: string): Promise<{ units: number; building: GameBuilding }> {
    // Read current record to compute units
    const rows = await this.db.query<GameBuilding>(
      `SELECT * FROM game_buildings WHERE id = ?`, [id]
    );
    if (!rows[0]) throw new Error(`Building ${id} not found`);
    const building = rows[0];
 
    // Import is intentionally dynamic to keep this file free of catalog coupling.
    // The route layer can also pass units directly — see routes/game.ts.
    const since = building.last_collected_at ?? building.placed_at;
    const elapsedMs = Date.now() - new Date(since).getTime();
    const units = Math.min(
      Math.floor(elapsedMs / (10 * 60 * 1000)), // 10 min per unit
      144,                                        // RCS_MAX_STORED
    );
 
    await this.db.run(
      `UPDATE game_buildings SET last_collected_at = now() WHERE id = ?`,
      [id]
    );
 
    const updated = await this.db.query<GameBuilding>(
      `SELECT * FROM game_buildings WHERE id = ?`, [id]
    );
    return { units, building: updated[0] };
  }

  // ── Minerals ─────────────────────────────────────────────────────────────

  /** Returns harvested_at for all nodes that have a record (NULL rows not stored). */
  async getMineralStatus(nodeIds: string[]): Promise<Record<string, string | null>> {
    if (nodeIds.length === 0) return {};
    const placeholders = nodeIds.map(() => '?').join(', ');
    const rows = await this.db.query<{ node_id: string; harvested_at: string | null }>(
      `SELECT node_id, harvested_at FROM game_minerals WHERE node_id IN (${placeholders})`,
      nodeIds
    );
    const result: Record<string, string | null> = {};
    for (const row of rows) result[row.node_id] = row.harvested_at;
    return result;
  }

  /**
   * Record a harvest. Returns { ok: false } if the node was harvested within
   * the last hour (respawn not ready). Returns { ok: true, harvested_at } on success.
   */
  async harvestMineral(nodeId: string): Promise<{ ok: boolean; harvested_at?: string }> {
    const RESPAWN_MS = 60 * 60 * 1000; // 1 hour
    const rows = await this.db.query<{ harvested_at: string | null }>(
      `SELECT harvested_at FROM game_minerals WHERE node_id = ?`, [nodeId]
    );
    if (rows.length > 0 && rows[0].harvested_at !== null) {
      const elapsed = Date.now() - new Date(rows[0].harvested_at).getTime();
      if (elapsed < RESPAWN_MS) return { ok: false };
    }
    await this.db.run(`DELETE FROM game_minerals WHERE node_id = ?`, [nodeId]);
    await this.db.run(
      `INSERT INTO game_minerals (node_id, harvested_at) VALUES (?, now())`,
      [nodeId]
    );
    const updated = await this.db.query<{ harvested_at: string }>(
      `SELECT harvested_at FROM game_minerals WHERE node_id = ?`, [nodeId]
    );
    return { ok: true, harvested_at: updated[0].harvested_at };
  }

  
}