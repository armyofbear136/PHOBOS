/**
 * MeridianManager.ts — Lifecycle shim for PHOBOS Meridian photo library.
 *
 * Meridian runs in-process as a second Fastify server on port 16320.
 * This module is a thin wrapper around meridian/server.ts that preserves
 * the existing manager interface so server.ts callers need minimal changes.
 *
 * No subprocess. No portable node binary. No DuckDB file-lock conflict.
 * The DatabaseManager instance from the main server is used directly.
 */

import {
  startMeridianServer,
  stopMeridianServer,
  getMeridianServerStatus,
  MERIDIAN_PORT,
  type MeridianStartOpts,
  type MeridianServerStatus,
} from '../meridian/server.js';
import { DatabaseManager } from '../db/DatabaseManager.js';

export { MERIDIAN_PORT };

export type MeridianStatus = MeridianServerStatus;

export async function startMeridian(opts: {
  libraryPath:  string;
  idleEnabled?: boolean;
  // db is optional — defaults to DatabaseManager.getInstance() (main process singleton).
  // Pass explicitly in test scripts that use an isolated database.
  db?:     DatabaseManager;
  // syncDb is the user-scoped DatabaseManager for phobos_sync_* tables.
  // Defaults to DatabaseManager.getUserDb() (active user). Pass explicitly
  // in test scripts or when switching users.
  syncDb?: DatabaseManager;
  // dbPath is used only when db is not provided, to open a specific database file.
  // Primarily for test scripts that need an isolated DuckDB.
  dbPath?: string;
}): Promise<void> {
  let dbManager: DatabaseManager;

  if (opts.db) {
    // Caller supplied an already-open instance (test scripts, future use).
    dbManager = opts.db;
  } else if (opts.dbPath) {
    // Test path: open a fresh DatabaseManager at the given path.
    dbManager = DatabaseManager.getInstance(opts.dbPath);
    await dbManager.initialize();
  } else {
    // Normal production path: use the main process singleton, already initialized.
    dbManager = DatabaseManager.getInstance();
  }

  // User-scoped DB for phobos_sync_* tables.
  const syncDbManager = opts.syncDb ?? DatabaseManager.getUserDb();

  const startOpts: MeridianStartOpts = {
    libraryPath: opts.libraryPath,
    idleEnabled: opts.idleEnabled,
  };

  await startMeridianServer(dbManager, startOpts, syncDbManager);
}

export async function stopMeridian(): Promise<void> {
  await stopMeridianServer();
}

export function getMeridianStatus(): MeridianStatus {
  return getMeridianServerStatus();
}

export async function meridianApiRequest(
  method:   string,
  endpoint: string,
  body?:    unknown,
): Promise<Response> {
  const status = getMeridianServerStatus();
  if (status.state !== 'running') throw new Error('Meridian is not running');
  return fetch(`http://127.0.0.1:${MERIDIAN_PORT}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body:    body != null ? JSON.stringify(body) : undefined,
  });
}

export async function triggerScan(libraryId: string): Promise<void> {
  const res = await meridianApiRequest('POST', `/api/libraries/${libraryId}/scan`);
  if (!res.ok) throw new Error(`Scan trigger failed: HTTP ${res.status}`);
}
