/**
 * db/HaStore.ts — DuckDB persistence for the Home Assistant connection.
 *
 * One table: `ha_config`
 *   Single-row store (upserted under the key 'default').
 *   Holds the user's HA instance URL, long-lived token, and preferences.
 *
 * Token is stored as plain text — same threat model as ModelConfigStore apiKey
 * (user-local DuckDB in ~/.phobos, not network-accessible).
 *
 * Domain filtering: `exposed_domains` limits which entity domains are pulled
 * into the live snapshot. Keeps the context block lean.
 */

import { DatabaseManager } from './DatabaseManager.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HaConfig {
  /** Base URL of the HA instance, e.g. "http://homeassistant.local:8123" */
  ha_url:           string;
  /** Long-lived access token generated from HA profile page */
  ha_token:         string;
  /** Whether the connection is enabled */
  enabled:          boolean;
  /**
   * HA entity domains to include in the live snapshot.
   * Empty array = all domains (not recommended for large installs).
   */
  exposed_domains:  string[];
  /** ISO timestamp of last successful connection */
  last_connected_at: string | null;
  updated_at:       string;
}

// Default domains that give the AI useful home awareness without flooding context.
export const DEFAULT_EXPOSED_DOMAINS = [
  'light',
  'switch',
  'climate',
  'cover',
  'lock',
  'sensor',
  'binary_sensor',
  'media_player',
  'alarm_control_panel',
  'person',
  'device_tracker',
  'input_boolean',
  'automation',
  'scene',
];

const ROW_KEY = 'default';

// ── Store ─────────────────────────────────────────────────────────────────────

export class HaStore {
  constructor(private db: DatabaseManager) {}

  async ensureTable(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS ha_config (
        row_key          VARCHAR PRIMARY KEY,
        ha_url           VARCHAR NOT NULL DEFAULT '',
        ha_token         VARCHAR NOT NULL DEFAULT '',
        enabled          BOOLEAN NOT NULL DEFAULT false,
        exposed_domains  JSON    NOT NULL DEFAULT '[]',
        last_connected_at TIMESTAMP,
        updated_at       TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
  }

  async get(): Promise<HaConfig | null> {
    const rows = await this.db.query<{
      ha_url:            string;
      ha_token:          string;
      enabled:           boolean;
      exposed_domains:   string;   // JSON column comes back as string
      last_connected_at: string | null;
      updated_at:        string;
    }>(`SELECT * FROM ha_config WHERE row_key = ?`, [ROW_KEY]);

    if (!rows[0]) return null;
    const r = rows[0];
    return {
      ha_url:            r.ha_url,
      ha_token:          r.ha_token,
      enabled:           r.enabled,
      exposed_domains:   this._parseDomains(r.exposed_domains),
      last_connected_at: r.last_connected_at,
      updated_at:        r.updated_at,
    };
  }

  async save(fields: Partial<Omit<HaConfig, 'updated_at'>>): Promise<HaConfig> {
    const existing = await this.get();
    const now = new Date().toISOString();

    const ha_url          = fields.ha_url          ?? existing?.ha_url          ?? '';
    const ha_token        = fields.ha_token        ?? existing?.ha_token        ?? '';
    const enabled         = fields.enabled         !== undefined ? fields.enabled  : (existing?.enabled ?? false);
    const exposed_domains = fields.exposed_domains ?? existing?.exposed_domains ?? DEFAULT_EXPOSED_DOMAINS;
    const last_connected_at = fields.last_connected_at !== undefined
      ? fields.last_connected_at
      : (existing?.last_connected_at ?? null);

    await this.db.run(
      `INSERT INTO ha_config
         (row_key, ha_url, ha_token, enabled, exposed_domains, last_connected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (row_key) DO UPDATE SET
         ha_url            = excluded.ha_url,
         ha_token          = excluded.ha_token,
         enabled           = excluded.enabled,
         exposed_domains   = excluded.exposed_domains,
         last_connected_at = excluded.last_connected_at,
         updated_at        = excluded.updated_at`,
      [
        ROW_KEY, ha_url, ha_token, enabled,
        JSON.stringify(exposed_domains),
        last_connected_at, now,
      ]
    );

    return (await this.get())!;
  }

  async markConnected(): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE ha_config SET last_connected_at = ?, updated_at = ? WHERE row_key = ?`,
      [now, now, ROW_KEY]
    );
  }

  async disable(): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE ha_config SET enabled = false, updated_at = ? WHERE row_key = ?`,
      [now, ROW_KEY]
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private _parseDomains(raw: string | string[]): string[] {
    if (Array.isArray(raw)) return raw;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : DEFAULT_EXPOSED_DOMAINS;
    } catch {
      return DEFAULT_EXPOSED_DOMAINS;
    }
  }
}
