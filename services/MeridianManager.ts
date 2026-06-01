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
  setSignalingClient as setMeridianServerSignalingClient,
  repairAllUserLibraries as repairMeridianUserLibraries,
  MERIDIAN_PORT,
  type MeridianStartOpts,
  type MeridianServerStatus,
} from '../meridian/server.js';
import { DatabaseManager } from '../db/DatabaseManager.js';

export { MERIDIAN_PORT };
export { repairMeridianUserLibraries as repairAllUserLibraries };

export type MeridianStatus = MeridianServerStatus;

export async function startMeridian(opts: {
  libraryPath:  string;
  idleEnabled?: boolean;
  db?:          DatabaseManager;
  syncDb?:      DatabaseManager;
  dbPath?:      string;
  getUserDb?:   (username: string) => DatabaseManager;
}): Promise<void> {
  let dbManager: DatabaseManager;

  if (opts.db) {
    dbManager = opts.db;
  } else if (opts.dbPath) {
    dbManager = DatabaseManager.getInstance(opts.dbPath);
    await dbManager.initialize();
  } else {
    dbManager = DatabaseManager.getInstance();
  }

  const syncDbManager = opts.syncDb ?? DatabaseManager.getUserDb();

  const startOpts: MeridianStartOpts = {
    libraryPath: opts.libraryPath,
    idleEnabled: opts.idleEnabled,
    getUserDb:   opts.getUserDb ?? ((username: string) => DatabaseManager.getUserDb(username)),
  };

  await startMeridianServer(dbManager, startOpts, syncDbManager);
}

export async function stopMeridian(): Promise<void> {
  await stopMeridianServer();
}

/**
 * Wire the SignalingClient into the running Meridian sync routes after WebRTC
 * initializes. Called from server.ts once webrtcSignalingClient is constructed,
 * which happens after startMeridian() due to boot-sequence ordering.
 */
export function setMeridianSignalingClient(client: { notifySync(): void } | null): void {
  setMeridianServerSignalingClient(client);
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