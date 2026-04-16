import * as os   from 'os';
import * as path from 'path';
import { DatabaseManager } from './DatabaseManager.js';

// ── Key names in the existing model_config table ─────────────────────────────
const KEY_BASE_PATH = 'models_base_path';
const KEY_OVERRIDES = 'model_path_overrides';

// ── Namespace prefixes — prevent LLM/image modelId collisions in the map ─────
export type ModelNamespace = 'llm' | 'img';

export function overrideKey(ns: ModelNamespace, modelId: string): string {
  return `${ns}:${modelId}`;
}

// ── Default base path — computed lazily at call time, never at import time ────
// This fixes the macOS SEA bug where os.homedir() returns '' when module
// constants are evaluated before the process home dir is established
// (reproducible when the binary is launched via double-click from Finder).
function defaultBasePath(): string {
  return path.join(os.homedir(), '.phobos', 'models');
}

// ── In-process cache ──────────────────────────────────────────────────────────
// ModelPathStore is read on every modelPath() / fluxModelPath() call — these
// are synchronous hot paths. We keep a module-level cache so DB reads only
// happen once (at loadSync startup) and on explicit writes.

let _basePath: string | null = null;
const _overrides = new Map<string, string>(); // overrideKey(ns, id) → absolute path
let _loaded = false;

// ── Public synchronous accessors (used by PhobosLocalManager path functions) ──

export function getBasePath(): string {
  if (_basePath === null) {
    // Called before loadSync — fall back to default. This path is only hit if
    // something calls modelPath() before the DB is initialised (e.g., during
    // unit tests or early static analysis). At runtime loadSync() fires first.
    return defaultBasePath();
  }
  return _basePath;
}

export function getOverride(ns: ModelNamespace, modelId: string): string | null {
  return _overrides.get(overrideKey(ns, modelId)) ?? null;
}

export function getAllOverrides(): ReadonlyMap<string, string> {
  return _overrides;
}

export function isLoaded(): boolean {
  return _loaded;
}

// ── Sync loader — call once at server startup after DB is ready ───────────────
// ModelConfigStore uses async getRaw(), but we need the cache populated
// synchronously before any modelPath() calls. We read raw DuckDB rows via
// the same query pattern but settle them here via a blocking-compatible
// approach: the caller awaits loadAsync() during server init.

export async function loadAsync(db: DatabaseManager): Promise<void> {
  const [baseRow, overridesRow] = await Promise.all([
    db.queryOne<{ value: string }>(`SELECT value FROM model_config WHERE key = ?`, [KEY_BASE_PATH]),
    db.queryOne<{ value: string }>(`SELECT value FROM model_config WHERE key = ?`, [KEY_OVERRIDES]),
  ]);

  _basePath  = baseRow?.value ?? defaultBasePath();
  _overrides.clear();

  if (overridesRow?.value) {
    try {
      const parsed = JSON.parse(overridesRow.value) as Record<string, string>;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') _overrides.set(k, v);
      }
    } catch { /* corrupt entry — start clean */ }
  }

  _loaded = true;
}

// ── Async writers — update cache then persist ─────────────────────────────────

export async function setBasePath(db: DatabaseManager, absPath: string): Promise<void> {
  _basePath = absPath;
  await upsert(db, KEY_BASE_PATH, absPath);
}

export async function setOverride(
  db: DatabaseManager,
  ns: ModelNamespace,
  modelId: string,
  absPath: string,
): Promise<void> {
  _overrides.set(overrideKey(ns, modelId), absPath);
  await persistOverrides(db);
}

export async function clearOverride(
  db: DatabaseManager,
  ns: ModelNamespace,
  modelId: string,
): Promise<void> {
  _overrides.delete(overrideKey(ns, modelId));
  await persistOverrides(db);
}

export async function clearAllOverrides(db: DatabaseManager): Promise<void> {
  _overrides.clear();
  await persistOverrides(db);
}

// ── Private helpers ───────────────────────────────────────────────────────────

async function upsert(db: DatabaseManager, key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  const existing = await db.queryOne<{ value: string }>(
    `SELECT value FROM model_config WHERE key = ?`, [key]
  );
  if (existing !== null) {
    await db.run(`UPDATE model_config SET value = ?, updated_at = ? WHERE key = ?`, [value, now, key]);
  } else {
    await db.run(`INSERT INTO model_config (key, value, updated_at) VALUES (?, ?, ?)`, [key, value, now]);
  }
}

async function persistOverrides(db: DatabaseManager): Promise<void> {
  const obj: Record<string, string> = {};
  for (const [k, v] of _overrides) obj[k] = v;
  await upsert(db, KEY_OVERRIDES, JSON.stringify(obj));
}

// ── Sandbox Executor feature flag ─────────────────────────────────────────────
// Persisted in the existing model_config key-value table.
const KEY_SANDBOX_EXECUTOR = 'feature_sandbox_executor_enabled';

export async function getSandboxExecutorEnabled(db: DatabaseManager): Promise<boolean> {
  const row = await db.queryOne<{ value: string }>(
    `SELECT value FROM model_config WHERE key = ?`, [KEY_SANDBOX_EXECUTOR]
  );
  return row?.value === 'true';
}

export async function setSandboxExecutorEnabled(db: DatabaseManager, enabled: boolean): Promise<void> {
  const now = new Date().toISOString();
  const existing = await db.queryOne<{ value: string }>(
    `SELECT value FROM model_config WHERE key = ?`, [KEY_SANDBOX_EXECUTOR]
  );
  if (existing !== null) {
    await db.run(`UPDATE model_config SET value = ?, updated_at = ? WHERE key = ?`,
      [String(enabled), now, KEY_SANDBOX_EXECUTOR]);
  } else {
    await db.run(`INSERT INTO model_config (key, value, updated_at) VALUES (?, ?, ?)`,
      [KEY_SANDBOX_EXECUTOR, String(enabled), now]);
  }
}
