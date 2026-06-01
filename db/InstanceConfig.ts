/**
 * InstanceConfig.ts — persistent identity and keypair for this PHOBOS installation.
 *
 * getInstanceId()  — stable UUID v4, generated on first boot and cached.
 * getPublicKey()   — ed25519 public key hex, generated on first call and cached.
 *
 * Both values live in instance_config (system DB) and are cached in module
 * scope for the lifetime of the process — DB is touched at most once per value
 * per boot.
 *
 * Security note: the private key is stored in instance_config in plaintext.
 * This is acceptable for Phase 1 — the system DB is never exposed externally
 * and the key is used only for future social post signing, not authentication.
 * Hardware-backed key storage is a Phase 3 concern.
 */

import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { DatabaseManager } from './DatabaseManager.js';

// ── Module-level cache ────────────────────────────────────────────────────────

let _cachedId:         string | null = null;
let _cachedPublicKey:  string | null = null;

// ── Instance ID ───────────────────────────────────────────────────────────────

export async function getInstanceId(systemDb: DatabaseManager): Promise<string> {
  if (_cachedId) return _cachedId;

  const row = await systemDb.queryOne<{ value: string }>(
    `SELECT value FROM instance_config WHERE key = 'instance_id'`,
    [],
  );

  if (row) {
    _cachedId = row.value;
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

// ── ed25519 Keypair ───────────────────────────────────────────────────────────

/**
 * Return the hex-encoded ed25519 public key for this instance.
 *
 * On first call, checks instance_config for an existing keypair.
 * If absent (first boot, or fresh install), generates a new keypair,
 * persists both halves, and returns the public key.
 *
 * The private key is stored under key='private_key' and is never returned
 * by this function. It will be read by the post-signing layer in Phase 2.
 */
export async function getPublicKey(systemDb: DatabaseManager): Promise<string> {
  if (_cachedPublicKey) return _cachedPublicKey;

  const row = await systemDb.queryOne<{ value: string }>(
    `SELECT value FROM instance_config WHERE key = 'public_key'`,
    [],
  );

  if (row) {
    _cachedPublicKey = row.value;
    return _cachedPublicKey;
  }

  // First call — generate a fresh ed25519 keypair and persist both halves.
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding:  { type: 'spki',  format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  const pubHex  = publicKey.toString('hex');
  const privHex = privateKey.toString('hex');

  // Write both atomically in the same connection window. execWithParams
  // is safe for concurrent callers — DuckDB PRIMARY KEY enforcement means
  // a duplicate INSERT on a race is a no-op error caught silently below.
  try {
    await systemDb.execWithParams(
      `INSERT INTO instance_config (key, value) VALUES ('public_key',  ?)`,
      [pubHex],
    );
    await systemDb.execWithParams(
      `INSERT INTO instance_config (key, value) VALUES ('private_key', ?)`,
      [privHex],
    );
    console.log('[InstanceConfig] Generated ed25519 keypair');
  } catch (err) {
    // A concurrent boot may have inserted between our SELECT and INSERT.
    // Re-read to get the winner's public key.
    const winner = await systemDb.queryOne<{ value: string }>(
      `SELECT value FROM instance_config WHERE key = 'public_key'`,
      [],
    );
    if (!winner) throw err; // genuine error, not a race
    _cachedPublicKey = winner.value;
    return _cachedPublicKey;
  }

  _cachedPublicKey = pubHex;
  return _cachedPublicKey;
}

// ── Core name ─────────────────────────────────────────────────────────────────

/**
 * Return the user-assigned display name for this core, or null if not set.
 * Shown in Phobos ID shares so the recipient sees a human name alongside the UUID.
 */
export async function getCoreName(systemDb: DatabaseManager): Promise<string | null> {
  const row = await systemDb.queryOne<{ value: string }>(
    `SELECT value FROM instance_config WHERE key = 'core_name'`,
    [],
  );
  return row?.value ?? null;
}

/**
 * Set the display name for this core. Trims whitespace. Max 40 chars.
 * Overwrites any existing value.
 */
export async function setCoreName(systemDb: DatabaseManager, name: string): Promise<void> {
  const trimmed = name.trim().slice(0, 40);
  await systemDb.execWithParams(
    `INSERT INTO instance_config (key, value) VALUES ('core_name', ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [trimmed],
  );
}
