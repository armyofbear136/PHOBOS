/**
 * ServiceStore.ts — DuckDB persistence for PHOBOS Media Hub services.
 *
 * One table: `media_services`
 *   Stores enabled state, library paths, and simplified settings
 *   for each service. One row per service — upsert on change.
 *
 * Schema is intentionally flat. Settings are a jsonb blob so adding
 * per-service fields never requires a migration.
 */

import { DatabaseManager } from './DatabaseManager.js';
import crypto from 'node:crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ServiceName = 'jellyfin' | 'polaris' | 'kavita' | 'pigallery2';

export interface ServiceRecord {
  name:          ServiceName;
  enabled:       boolean;
  /** Primary library / originals path set by the user. */
  libraryPath:   string | null;
  /** Service-specific simplified settings as a JSON blob. */
  settings:      Record<string, unknown>;
  /** ISO timestamp of last update. */
  updatedAt:     string;
}

// Per-service defaults applied when a row is first created.
const SERVICE_DEFAULTS: Record<ServiceName, Record<string, unknown>> = {
  jellyfin: {
    hardwareAccel: '',       // empty string = CPU only; else 'vaapi' | 'qsv' | 'nvenc' | 'videotoolbox'
    remoteAccess:  false,
    adminPassword: '',       // generated on first creation
  },
  polaris: {
    authEnabled:   true,
  },
  kavita: {
    port: 5000,
  },
  pigallery2: {},
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS media_services (
  name         VARCHAR PRIMARY KEY,
  enabled      BOOLEAN  NOT NULL DEFAULT false,
  library_path VARCHAR,
  settings     JSON     NOT NULL DEFAULT '{}',
  updated_at   TIMESTAMP NOT NULL DEFAULT now()
);
`;

// ── Store ─────────────────────────────────────────────────────────────────────

export class ServiceStore {
  constructor(private db: DatabaseManager) {}

  async ensureTable(): Promise<void> {
    await this.db.run(SCHEMA);
    // One-time migration: rename legacy photoprism row to pigallery2.
    await this.db.run(
      `UPDATE media_services SET name = 'pigallery2' WHERE name = 'photoprism'`
    );
  }

  /** Returns the record for a service, creating it with defaults if absent. */
  async get(name: ServiceName): Promise<ServiceRecord> {
    const rows = await this.db.query<{
      name: string;
      enabled: boolean;
      library_path: string | null;
      settings: string;
      updated_at: string;
    }>('SELECT * FROM media_services WHERE name = ?', [name]);

    if (rows.length > 0) {
      return this._row(rows[0]);
    }

    // First-time creation — insert defaults.
    const defaults = { ...SERVICE_DEFAULTS[name] };

    if (name === 'jellyfin' && !defaults.adminPassword) {
      defaults.adminPassword = crypto.randomBytes(24).toString('base64url');
    }

    await this.db.run(
      `INSERT INTO media_services (name, enabled, library_path, settings, updated_at)
       VALUES (?, false, NULL, ?, now())`,
      [name, JSON.stringify(defaults)]
    );

    return {
      name,
      enabled:     false,
      libraryPath: null,
      settings:    defaults,
      updatedAt:   new Date().toISOString(),
    };
  }

  /** Enable or disable a service. */
  async setEnabled(name: ServiceName, enabled: boolean): Promise<ServiceRecord> {
    await this.db.run(
      `UPDATE media_services SET enabled = ?, updated_at = now() WHERE name = ?`,
      [enabled, name]
    );
    return this.get(name);
  }

  /** Update the library path. */
  async setLibraryPath(name: ServiceName, libraryPath: string | null): Promise<ServiceRecord> {
    await this.db.run(
      `UPDATE media_services SET library_path = ?, updated_at = now() WHERE name = ?`,
      [libraryPath, name]
    );
    return this.get(name);
  }

  /**
   * Merge-update the settings blob. Only provided keys are changed.
   * Existing keys not in the patch are preserved.
   */
  async patchSettings(name: ServiceName, patch: Record<string, unknown>): Promise<ServiceRecord> {
    const current = await this.get(name);
    const merged  = { ...current.settings, ...patch };
    await this.db.run(
      `UPDATE media_services SET settings = ?, updated_at = now() WHERE name = ?`,
      [JSON.stringify(merged), name]
    );
    return this.get(name);
  }

  /** Returns all four service records, creating defaults for any not yet persisted. */
  async getAll(): Promise<Record<ServiceName, ServiceRecord>> {
    const names: ServiceName[] = ['jellyfin', 'polaris', 'kavita', 'pigallery2'];
    const records = await Promise.all(names.map(n => this.get(n)));
    return Object.fromEntries(records.map(r => [r.name, r])) as Record<ServiceName, ServiceRecord>;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private _row(row: {
    name: string;
    enabled: boolean;
    library_path: string | null;
    settings: string;
    updated_at: string;
  }): ServiceRecord {
    let settings: Record<string, unknown>;
    try {
      settings = typeof row.settings === 'string'
        ? JSON.parse(row.settings)
        : (row.settings as Record<string, unknown>) ?? {};
    } catch {
      settings = {};
    }
    return {
      name:        row.name as ServiceName,
      enabled:     Boolean(row.enabled),
      libraryPath: row.library_path ?? null,
      settings,
      updatedAt:   row.updated_at,
    };
  }
}
