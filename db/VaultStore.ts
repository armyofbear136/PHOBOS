/**
 * VaultStore.ts — DuckDB config table for PHOBOS Vault.
 *
 * Stores only vault configuration: file path, lock timeout, timestamps.
 * No secrets, no passwords, no key material ever touch this table.
 *
 * Uses the system DB (DatabaseManager.getInstance()), consistent with
 * SecurityStore, CartridgeStore, and other system-level stores.
 *
 * Table: vault_config
 *   key   VARCHAR PRIMARY KEY
 *   value VARCHAR
 *
 * Keys:
 *   db_path               — absolute path to the .kdbx file
 *   lock_timeout_seconds  — idle auto-lock (0 = never)
 *   last_opened_at        — ISO timestamp of last successful unlock
 *   created_at            — ISO timestamp of first setup (written once)
 */

import * as os   from 'node:os';
import * as path from 'node:path';
import { DatabaseManager } from './DatabaseManager.js';

// ── Config key types ───────────────────────────────────────────────────────────

export type VaultConfigKey =
  | 'db_path'
  | 'lock_timeout_seconds'
  | 'last_opened_at'
  | 'created_at';

export interface VaultConfig {
  db_path:              string;
  lock_timeout_seconds: number;
  last_opened_at:       string | null;
  created_at:           string | null;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

function defaultDbPath(): string {
  return path.join(os.homedir(), '.phobos', 'vault', 'vault.kdbx');
}

// ── Store ─────────────────────────────────────────────────────────────────────

export class VaultStore {
  private readonly db: DatabaseManager;

  constructor(db: DatabaseManager) {
    this.db = db;
  }

  async ensureTable(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS vault_config (
        key   VARCHAR PRIMARY KEY,
        value VARCHAR
      )
    `);
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  async get(key: VaultConfigKey): Promise<string | null> {
    const rows = await this.db.query<{ value: string }>(
      `SELECT value FROM vault_config WHERE key = ?`,
      [key],
    );
    return rows[0]?.value ?? null;
  }

  async getAll(): Promise<VaultConfig> {
    const rows = await this.db.query<{ key: string; value: string }>(
      `SELECT key, value FROM vault_config`,
    );
    const map = new Map(rows.map(r => [r.key, r.value]));

    const rawTimeout = map.get('lock_timeout_seconds') ?? '900';
    const timeout    = parseInt(rawTimeout, 10);

    return {
      db_path:              map.get('db_path') ?? defaultDbPath(),
      lock_timeout_seconds: Number.isFinite(timeout) ? timeout : 900,
      last_opened_at:       map.get('last_opened_at') ?? null,
      created_at:           map.get('created_at')     ?? null,
    };
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  async set(key: VaultConfigKey, value: string): Promise<void> {
    // execWithParams bypasses the prepare-path binder bug on ON CONFLICT DML
    await this.db.execWithParams(
      `INSERT INTO vault_config (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }

  async setDbPath(dbPath: string): Promise<void> {
    await this.set('db_path', dbPath);
  }

  async setLockTimeout(seconds: number): Promise<void> {
    await this.set('lock_timeout_seconds', String(seconds));
  }

  async stampLastOpened(): Promise<void> {
    const now = new Date().toISOString();
    await this.set('last_opened_at', now);
    const existing = await this.get('created_at');
    if (!existing) await this.set('created_at', now);
  }

  async patch(fields: Partial<Pick<VaultConfig, 'db_path' | 'lock_timeout_seconds'>>): Promise<void> {
    if (fields.db_path !== undefined) {
      await this.setDbPath(fields.db_path);
    }
    if (fields.lock_timeout_seconds !== undefined) {
      await this.setLockTimeout(fields.lock_timeout_seconds);
    }
  }
}
