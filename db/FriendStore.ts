/**
 * db/FriendStore.ts — per-user friend graph operations against social.duckdb.
 *
 * Always obtain the DatabaseManager via DatabaseManager.getSocialDb(username)
 * before constructing a FriendStore. Never pass a system or user (chat) DB here.
 *
 * The schema lives in SOCIAL_SCHEMA (DatabaseManager.ts) and is applied by
 * getSocialDb() on first open — no ensureSchema() call needed at the call site.
 */

import { DatabaseManager } from './DatabaseManager.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FriendRecord {
  instance_uuid: string;
  username:      string;
  display_name:  string;
  public_key:    string;
  relay_address: string;
  avatar_token:  string | null;
  connected_at:  number;   // unix ms
  last_seen_at:  number | null;
  notes:         string | null;
}

export interface AddFriendInput {
  instance_uuid: string;
  username:      string;
  display_name:  string;
  public_key:    string;
  relay_address: string;
  avatar_token?: string;
}

// ── FriendStore ───────────────────────────────────────────────────────────────

export class FriendStore {
  constructor(private readonly db: DatabaseManager) {}

  /**
   * Write a new friend record. The composite primary key (instance_uuid, username)
   * means this is idempotent when called twice with the same pair — DuckDB will
   * throw a primary key violation, which the caller should treat as a no-op
   * (already_friends). Use isFriend() first to avoid the exception on hot paths.
   */
  async addFriend(input: AddFriendInput): Promise<void> {
    await this.db.execWithParams(
      `INSERT INTO friends
         (instance_uuid, username, display_name, public_key,
          relay_address, avatar_token, connected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.instance_uuid,
        input.username,
        input.display_name,
        input.public_key,
        input.relay_address,
        input.avatar_token ?? null,
        Date.now(),
      ],
    );
  }

  /** Return all active friends ordered by display_name ascending. */
  async getFriends(): Promise<FriendRecord[]> {
    return this.db.query<FriendRecord>(
      `SELECT instance_uuid, username, display_name, public_key,
              relay_address, avatar_token, connected_at, last_seen_at, notes
       FROM friends
       ORDER BY display_name ASC`,
    );
  }

  /** Look up a single friend by the composite key. Returns null if not found. */
  async getByKey(instance_uuid: string, username: string): Promise<FriendRecord | null> {
    return this.db.queryOne<FriendRecord>(
      `SELECT instance_uuid, username, display_name, public_key,
              relay_address, avatar_token, connected_at, last_seen_at, notes
       FROM friends
       WHERE instance_uuid = ? AND username = ?`,
      [instance_uuid, username],
    );
  }

  /**
   * Returns true if any friend row exists for this (instance_uuid, username) pair.
   * Use this before addFriend() to surface a clean already_friends error instead
   * of a DB exception.
   */
  async isFriend(instance_uuid: string, username: string): Promise<boolean> {
    const row = await this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM friends
       WHERE instance_uuid = ? AND username = ?`,
      [instance_uuid, username],
    );
    return (row?.n ?? 0) > 0;
  }

  /**
   * Returns true if any friend row exists for this instance_uuid regardless of
   * username. Used by connect-friend to detect duplicates before the handshake
   * completes and we know the remote username.
   */
  async hasFriendFromInstance(instance_uuid: string): Promise<boolean> {
    const row = await this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM friends WHERE instance_uuid = ?`,
      [instance_uuid],
    );
    return (row?.n ?? 0) > 0;
  }

  /** Update last_seen_at for a friend — called after a relay presence check. */
  async updateLastSeen(instance_uuid: string, username: string, ts: number): Promise<void> {
    await this.db.execWithParams(
      `UPDATE friends SET last_seen_at = ?
       WHERE instance_uuid = ? AND username = ?`,
      [ts, instance_uuid, username],
    );
  }

  /** Remove a friend permanently. Silent no-op if the row does not exist. */
  async removeFriend(instance_uuid: string, username: string): Promise<void> {
    await this.db.execWithParams(
      `DELETE FROM friends WHERE instance_uuid = ? AND username = ?`,
      [instance_uuid, username],
    );
  }
}
