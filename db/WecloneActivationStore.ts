/**
 * WecloneActivationStore — system-DB store for WeClone slot activation state.
 *
 * Operates exclusively on the system DB (phobos.duckdb), not per-user DBs.
 * The weclone_active_slots table has two permanent rows, one per hardware slot.
 *
 * holding_snapshot persists the ServerSnapshot of whatever was running on the
 * slot before activation so deactivation can restore it exactly.  A non-null
 * holding_snapshot is the authoritative flag that a clone is active on that slot.
 *
 * This store is pure DB I/O.  Actual model start/stop lives in WecloneSlotManager.
 */

import { DatabaseManager } from './DatabaseManager.js';

export type SlotName = 'sayon' | 'seren';

// Mirrors the internal ServerSnapshot shape from LlamaServerManager /
// ImageGenerationHandler.  Must stay in sync with ServerConfig fields.
export interface SlotSnapshot {
  role:         SlotName;
  modelId:      string;
  port:         number;
  gpuLayers:    number;
  contextSize:  number;
  threads:      number;
  deviceIndex?: number;
  gpuBackend?:  'cuda' | 'vulkan' | 'metal';
}

export interface ActiveSlotRow {
  slot:             SlotName;
  clone_id:         string | null;
  username:         string | null;
  holding_snapshot: string | null;   // JSON-serialised SlotSnapshot | null
}

export interface ActiveSlotInfo {
  cloneId:         string;
  username:        string;
  holdingSnapshot: SlotSnapshot;
}

export class WecloneActivationStore {
  constructor(private db: DatabaseManager) {}

  // ── Read ──────────────────────────────────────────────────────────────────

  async getActiveSlot(slot: SlotName): Promise<ActiveSlotInfo | null> {
    const row = await this.db.queryOne<ActiveSlotRow>(
      `SELECT * FROM weclone_active_slots WHERE slot = ?`, [slot],
    );
    if (!row || !row.clone_id || !row.username || !row.holding_snapshot) return null;
    let snapshot: SlotSnapshot;
    try {
      snapshot = JSON.parse(row.holding_snapshot) as SlotSnapshot;
    } catch {
      return null;
    }
    return { cloneId: row.clone_id, username: row.username, holdingSnapshot: snapshot };
  }

  async getBothSlots(): Promise<{ sayon: ActiveSlotInfo | null; seren: ActiveSlotInfo | null }> {
    const [sayon, seren] = await Promise.all([
      this.getActiveSlot('sayon'),
      this.getActiveSlot('seren'),
    ]);
    return { sayon, seren };
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  async setActiveSlot(
    slot:            SlotName,
    cloneId:         string,
    username:        string,
    holdingSnapshot: SlotSnapshot,
  ): Promise<void> {
    await this.db.run(
      `UPDATE weclone_active_slots
          SET clone_id = ?, username = ?, holding_snapshot = ?
        WHERE slot = ?`,
      [cloneId, username, JSON.stringify(holdingSnapshot), slot],
    );
  }

  async clearActiveSlot(slot: SlotName): Promise<void> {
    await this.db.run(
      `UPDATE weclone_active_slots
          SET clone_id = NULL, username = NULL, holding_snapshot = NULL
        WHERE slot = ?`,
      [slot],
    );
  }
}
