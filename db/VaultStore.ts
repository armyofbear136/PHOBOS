/**
 * VaultStore.ts — DuckDB config table for PHOBOS Vault.
 *
 * Stores only vault configuration: file path, lock timeout, timestamps.
 * No secrets, no passwords, no key material ever touch this table.
 *
 * Uses the USER DB (DatabaseManager.getUserDb()), so each user has their
 * own vault configuration and their own .kdbx file path. The vault_config
 * table is created by USER_SCHEMA in DatabaseManager — ensureTable() is
 * not needed and has been removed.
 *
 * Default vault path: ~/.phobos/users/{username}/vault/vault.kdbx
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
import { DatabaseManager, userDir } from './DatabaseManager.js';

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

// ── Defaults ──────────────────────────────────────────────────────────────────

function defaultDbPath(db: DatabaseManager): string {
  // Derive the vault path from the user DB path so it stays in the user's dir.
  // e.g. ~/.phobos/users/owner/phobos.duckdb → ~/.phobos/users/owner/vault/vault.kdbx
  const dbPath = (db as any)['dbPath'] as string | undefined;
  if (dbPath) {
    return path.join(path.dirname(dbPath), 'vault', 'vault.kdbx');
  }
  // Fallback: legacy path for the owner user.
  return path.join(os.homedir(), '.phobos', 'vault', 'vault.kdbx');
}

// ── Store ─────────────────────────────────────────────────────────────────────

export class VaultStore {
  private readonly db: DatabaseManager;

  constructor(db: DatabaseManager) {
    this.db = db;
  }

  // vault_config is declared in USER_SCHEMA — no ensureTable() needed.

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
      db_path:              map.get('db_path') ?? defaultDbPath(this.db),
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
