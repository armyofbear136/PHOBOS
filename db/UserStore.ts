/**
 * UserStore.ts — System DB store for the users table.
 *
 * The users table lives in ~/.phobos/phobos.duckdb (system DB) and was
 * created by E1 migration. Each row is the logical anchor for a user's
 * per-user directory at ~/.phobos/users/{username}/.
 *
 * Role values (enforced by CHECK constraint in SYSTEM_SCHEMA):
 *   'admin'  — full access + user management panel
 *   'full'   — full app access, no management
 *   'guest'  — chat + game only
 *   'read'   — chat history read-only
 *
 * Uses DatabaseManager.getInstance() (system DB). Never touches getUserDb().
 */

import { DatabaseManager } from './DatabaseManager.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export type UserRole = 'admin' | 'full' | 'guest' | 'read';

export interface UserRecord {
  username:     string;
  display_name: string;
  role:         UserRole;
  created_at:   string;
  last_active:  string | null;
}

export interface CreateUserInput {
  username:     string;
  display_name: string;
  role:         UserRole;
}

export interface UpdateUserInput {
  display_name?: string;
  role?:         UserRole;
}

// ── Store ──────────────────────────────────────────────────────────────────────

export class UserStore {
  private readonly db: DatabaseManager;

  constructor(db: DatabaseManager) {
    this.db = db;
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  async list(): Promise<UserRecord[]> {
    return this.db.query<UserRecord>(
      `SELECT username, display_name, role, created_at::VARCHAR AS created_at,
              last_active::VARCHAR AS last_active
       FROM users
       ORDER BY created_at ASC`,
    );
  }

  async getByUsername(username: string): Promise<UserRecord | null> {
    return this.db.queryOne<UserRecord>(
      `SELECT username, display_name, role, created_at::VARCHAR AS created_at,
              last_active::VARCHAR AS last_active
       FROM users WHERE username = ?`,
      [username],
    );
  }

  async exists(username: string): Promise<boolean> {
    const row = await this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM users WHERE username = ?`,
      [username],
    );
    return (row?.n ?? 0) > 0;
  }

  async count(): Promise<number> {
    const row = await this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM users`,
    );
    return row?.n ?? 0;
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  async create(input: CreateUserInput): Promise<void> {
    // execWithParams bypasses the DuckDB 1.4.x prepare-path binder bug on
    // ON CONFLICT DML. WHERE NOT EXISTS is the safe alternative here since
    // we want a clean error on duplicate rather than silent ignore.
    const exists = await this.exists(input.username);
    if (exists) throw new Error(`User '${input.username}' already exists`);

    await this.db.execWithParams(
      `INSERT INTO users (username, display_name, role, created_at)
       VALUES (?, ?, ?, ?)`,
      [input.username, input.display_name, input.role, new Date().toISOString()],
    );
  }

  async update(username: string, input: UpdateUserInput): Promise<void> {
    if (input.display_name !== undefined) {
      await this.db.execWithParams(
        `UPDATE users SET display_name = ? WHERE username = ?`,
        [input.display_name, username],
      );
    }
    if (input.role !== undefined) {
      await this.db.execWithParams(
        `UPDATE users SET role = ? WHERE username = ?`,
        [input.role, username],
      );
    }
  }

  async delete(username: string): Promise<void> {
    await this.db.execWithParams(
      `DELETE FROM users WHERE username = ?`,
      [username],
    );
  }

  async stampLastActive(username: string): Promise<void> {
    await this.db.execWithParams(
      `UPDATE users SET last_active = ? WHERE username = ?`,
      [new Date().toISOString(), username],
    );
  }
}
