/**
 * InstanceConfig.ts — persistent UUID identity for this PHOBOS installation.
 *
 * getInstanceId() reads from instance_config on first call, generates and
 * persists a UUID v4 if none exists. Result is cached in module scope for
 * the lifetime of the process — DB is only touched once per boot.
 */

import { randomUUID } from 'node:crypto';
import { DatabaseManager } from './DatabaseManager.js';

let _cachedId: string | null = null;

export async function getInstanceId(systemDb: DatabaseManager): Promise<string> {
  if (_cachedId) return _cachedId;

  const rows = await systemDb.query<{ value: string }>(
    `SELECT value FROM instance_config WHERE key = 'instance_id'`,
    [],
  );

  if (rows.length > 0) {
    _cachedId = rows[0].value;
    return _cachedId;
  }

  // First boot — generate and persist.
  const id = randomUUID();
  await systemDb.execWithParams(
    `INSERT INTO instance_config (key, value) VALUES ('instance_id', ?)`,
    [id],
  );
  _cachedId = id;
  console.log(`[InstanceConfig] Generated instance ID: ${id}`);
  return id;
}
