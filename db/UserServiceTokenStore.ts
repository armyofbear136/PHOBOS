/**
 * UserServiceTokenStore.ts — Per-user external service credentials.
 *
 * Reads and writes the user_service_tokens table in a user's user DB.
 * Constructed with DatabaseManager.getUserDb(username) — never getInstance().
 *
 * Table: user_service_tokens  (defined in USER_SCHEMA)
 *   service    VARCHAR NOT NULL   — 'jellyfin' | 'kavita'
 *   key        VARCHAR NOT NULL   — credential field name
 *   value      TEXT    NOT NULL   — credential value (plaintext)
 *   updated_at TIMESTAMP          — auto-updated
 *   PRIMARY KEY (service, key)
 *
 * Jellyfin keys:  user_id, access_token
 * Kavita keys:    user_id, jwt, refresh_token, api_key
 */

import { DatabaseManager } from './DatabaseManager.js';

export type ServiceName = 'jellyfin' | 'kavita';

export interface JellyfinTokens {
  user_id:      string;
  access_token: string;
}

export interface KavitaTokens {
  user_id:      string;
  jwt:          string;
  refresh_token: string;
  api_key:      string;
}

export class UserServiceTokenStore {
  private readonly db: DatabaseManager;

  constructor(db: DatabaseManager) {
    this.db = db;
  }

  async get(service: ServiceName, key: string): Promise<string | null> {
    const rows = await this.db.query<{ value: string }>(
      `SELECT value FROM user_service_tokens WHERE service = ? AND key = ?`,
      [service, key],
    );
    return rows[0]?.value ?? null;
  }

  async set(service: ServiceName, key: string, value: string): Promise<void> {
    await this.db.execWithParams(
      `INSERT INTO user_service_tokens (service, key, value, updated_at)
       VALUES (?, ?, ?, now())
       ON CONFLICT (service, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [service, key, value],
    );
  }

  async getJellyfin(): Promise<JellyfinTokens | null> {
    const rows = await this.db.query<{ key: string; value: string }>(
      `SELECT key, value FROM user_service_tokens WHERE service = 'jellyfin'`,
    );
    const m = new Map(rows.map(r => [r.key, r.value]));
    if (!m.has('user_id') || !m.has('access_token')) return null;
    return {
      user_id:      m.get('user_id')!,
      access_token: m.get('access_token')!,
    };
  }

  async setJellyfin(tokens: JellyfinTokens): Promise<void> {
    await this.set('jellyfin', 'user_id',      tokens.user_id);
    await this.set('jellyfin', 'access_token', tokens.access_token);
  }

  async getKavita(): Promise<KavitaTokens | null> {
    const rows = await this.db.query<{ key: string; value: string }>(
      `SELECT key, value FROM user_service_tokens WHERE service = 'kavita'`,
    );
    const m = new Map(rows.map(r => [r.key, r.value]));
    if (!m.has('user_id') || !m.has('jwt')) return null;
    return {
      user_id:       m.get('user_id')!,
      jwt:           m.get('jwt')!,
      refresh_token: m.get('refresh_token') ?? '',
      api_key:       m.get('api_key') ?? '',
    };
  }

  async setKavita(tokens: KavitaTokens): Promise<void> {
    await this.set('kavita', 'user_id',       tokens.user_id);
    await this.set('kavita', 'jwt',           tokens.jwt);
    await this.set('kavita', 'refresh_token', tokens.refresh_token);
    await this.set('kavita', 'api_key',       tokens.api_key);
  }

  async clear(service: ServiceName): Promise<void> {
    await this.db.execWithParams(
      `DELETE FROM user_service_tokens WHERE service = ?`,
      [service],
    );
  }
}
