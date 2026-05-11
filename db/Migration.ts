/**
 * db/Migration.ts — E1 single-DB → multi-user migration.
 *
 * On the first boot after E1 lands, this script:
 *   1. Detects the old single-DB layout (~/.phobos/phobos.duckdb without users table).
 *   2. Renames it aside to phobos.duckdb.pre-e1.backup.
 *   3. Opens the backup as read-only source.
 *   4. Creates ~/.phobos/users/owner/.in-progress/phobos.duckdb with USER_SCHEMA,
 *      copies all per-user-table rows from the backup.
 *   5. Creates ~/.phobos/.in-progress/phobos.duckdb with SYSTEM_SCHEMA,
 *      copies all system-table rows from the backup.
 *   6. Atomic-renames in-progress files into final locations.
 *   7. Moves conversations.duckdb → users/owner/conversations.duckdb (if exists).
 *   8. Moves workspaces/ → users/owner/workspaces/ (if exists).
 *   9. Moves license.key → users/owner/license.key (if exists).
 *  10. Moves civitai-token.txt → users/owner/civitai-token.txt (if exists).
 *  11. Moves user/skills/ → users/owner/skills/ and user/_registry.json
 *      → users/owner/skills/_registry.json (if either exists).
 *  12. Inserts {username:'owner', display_name:'Owner', role:'admin'} into users table.
 *  13. Touches ~/.phobos/.e1-migration-complete to mark done.
 *
 * Failure semantics:
 *   - Any required step that fails throws MigrationFatalError. The caller
 *     (server.ts main()) halts boot before any subsequent DB init runs, so
 *     the partial state cannot be cemented by stores creating empty schemas.
 *   - The backup file (phobos.duckdb.pre-e1.backup) is intact across failures.
 *   - The .in-progress/ dir is cleaned up before throwing.
 *   - Best-effort steps (lazy-table copy, system-table copy) collect warnings
 *     in the report but do not abort.
 *   - The sentinel file is only written on full success. A half-migrated state
 *     (backup present, sentinel absent) is detected on next boot and triggers
 *     a clean restart from the backup with stale partial outputs wiped.
 *
 * Idempotent: detects if migration is already complete and exits cleanly.
 *
 * Windows-specific: every DuckDB open and every ATTACH is wrapped in
 * openWithRetry() to absorb the OS's delayed file-handle release after close().
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'duckdb-async';

const dataDir = (): string => process.env.PHOBOS_DATA_DIR ?? path.join(os.homedir(), '.phobos');

const MIGRATION_FLAG_FILENAME = '.e1-migration-complete';
const BACKUP_FILENAME         = 'phobos.duckdb.pre-e1.backup';

// ── Windows file-handle release tolerance ─────────────────────────────────────
//
// On Windows, closing a DuckDB handle releases the JS-visible lock immediately
// but the OS can keep the underlying NTFS handle alive for tens of milliseconds
// after the close() promise resolves. A subsequent open() on the same path may
// see EBUSY/sharing-violation. We absorb this by retrying with exponential
// backoff. Linux/macOS unlock synchronously, so retries are typically no-ops.
//
// The migration is the only place this matters in normal operation: it opens
// and closes several DuckDB handles in sequence on the same files (probe,
// in-progress build, ATTACH for copy). Slow disks and antivirus scanners can
// extend the release window. Caps prevent unbounded waits if the lock is real.

const RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800, 1600] as const;

function isLockError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message || '';
  // DuckDB surfaces these via its IO error path on Windows.
  return /being used by another process|sharing violation|EBUSY|EACCES|locked/i.test(msg);
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Yield to the Node.js event loop multiple times. Each setImmediate tick
 * allows libuv's I/O thread pool to drain pending callbacks — including
 * the native DuckDB handle-release finalizers that run after db.close()
 * resolves in JS but before the OS actually frees the file lock on Windows.
 * More ticks = more time for the native finalizers to complete.
 */
async function yieldToEventLoop(ticks = 10): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

// Rename-specific retry ladder: much longer than the open ladder.
// The in-progress user DB rename is the most lock-sensitive operation:
// it happens right after DuckDB closes a large file it was writing to,
// and Windows' NTFS finalizer can hold the lock for several seconds on
// slow disks or under antivirus. Total budget: ~30 seconds.
const RENAME_RETRY_DELAYS_MS = [100, 200, 400, 800, 1600, 3200, 5000, 5000, 5000, 5000] as const;

async function fsRenameWithRetry(label: string, src: string, dest: string): Promise<void> {
  for (let i = 0; i <= RENAME_RETRY_DELAYS_MS.length; i++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      if (!isLockError(err) || i === RENAME_RETRY_DELAYS_MS.length) throw err;
      const delay = RENAME_RETRY_DELAYS_MS[i];
      console.warn(`[Migration:E1] ${label} blocked by file lock — retrying in ${delay}ms (attempt ${i + 1}/${RENAME_RETRY_DELAYS_MS.length})`);
      await yieldToEventLoop(20);
      await sleep(delay);
    }
  }
}

/**
 * Open a DuckDB instance with retry-on-lock. The opener is invoked fresh on
 * each attempt. Re-throws the last error if all retries exhaust or the error
 * is not a transient lock.
 */
async function openWithRetry<T>(
  label: string,
  open: () => Promise<T>,
  delays: readonly number[] = RETRY_DELAYS_MS,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= delays.length; i++) {
    try {
      return await open();
    } catch (err) {
      lastErr = err;
      if (!isLockError(err) || i === delays.length) throw err;
      const delay = delays[i];
      console.warn(`[Migration:E1] ${label} blocked by file lock — retrying in ${delay}ms (attempt ${i + 1}/${delays.length})`);
      await sleep(delay);
    }
  }
  // Unreachable — the loop either returns or throws.
  throw lastErr;
}

/**
 * Run a synchronous filesystem op with retry-on-lock. Used for renameSync,
 * unlinkSync, and rmSync calls that can race with delayed Windows handle
 * release after a DuckDB close.
 */
async function fsOpWithRetry(label: string, op: () => void): Promise<void> {
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    try {
      op();
      return;
    } catch (err) {
      if (!isLockError(err) || i === RETRY_DELAYS_MS.length) throw err;
      const delay = RETRY_DELAYS_MS[i];
      console.warn(`[Migration:E1] ${label} blocked by file lock — retrying in ${delay}ms (attempt ${i + 1}/${RETRY_DELAYS_MS.length})`);
      await sleep(delay);
    }
  }
}

// Tables that move into users/<owner>/phobos.duckdb.
// Preserve insertion order so cross-table dependencies copy cleanly: parents first.
const USER_TABLES_IN_ORDER = [
  'projects',
  'threads',
  'messages',
  'files',
  'documents',
  'memory',
  'dispatch_log',
  'message_events',
  'chat_summaries',
  'knowledge_base',
  'workspace_files',
  'thinking_segments',
  'prompt_log',
  'skills',
];

// Tables that stay in the new ~/.phobos/phobos.duckdb (system DB).
// Cartridges, plugins, model_path_settings, security tables, scheduled_tasks, etc.
// are all created by their own stores' ensureTable() at runtime — we only need
// to copy the ones the canonical SCHEMA created at boot.
//
// model_config is the only system-schema-canonical table; everything else
// (cartridges, plugins, audio_effect_presets, daw_projects, copilot_*,
//  game_player, security_scan_runs, scheduled_tasks, media_services,
//  meridian_*, phobos_sync_*) is created lazily by its store and persists
// in-place because the new system DB is at the same path the old one was at.
//
// IMPORTANT: We do NOT copy these — we leave them in the renamed backup and
// preserve them by NOT renaming until after the new system DB is built, then
// we copy ALL non-user tables from backup to the new system DB.
const SYSTEM_TABLES_TO_DETECT = [
  'cartridges',
  'plugins',
  'model_path_settings',
  'audio_effect_presets',
  'daw_projects',
  'copilot_memories',
  'copilot_relationship',
  'game_player',
  'security_scan_runs',
  'security_scan_findings',
  'scheduled_tasks',
  'media_services',
  'archive_chunks',  // would only exist if archive was somehow in main DB
  'memory_embeddings',
  'message_attachments',
  'phobos_sync_devices',
  'phobos_sync_policies',
  'phobos_sync_exclusions',
  'phobos_sync_manifest',
  'meridian_files',
  'meridian_albums',
  'meridian_libraries',
  'meridian_scan_log',
];

// Wait — re-think.
//
// copilot_memories, copilot_relationship, audio_effect_presets, daw_projects,
// game_player, security_scan_runs, scheduled_tasks, message_attachments,
// memory_embeddings, archive_chunks (if ever in main) — these are USER-scoped
// per the agreed design.
//
// media_services, cartridges, plugins, model_path_settings, meridian_*,
// phobos_sync_* — these are SYSTEM-scoped.
//
// Since we move user data to users/owner/ and leave system data in place,
// the simplest and safest approach is:
//   1. Rename old DB to backup.
//   2. Build new user DB, copy USER tables from backup.
//   3. Build new system DB, copy ALL tables from backup that exist and are
//      NOT in USER_TABLES_TO_MOVE (i.e. system-scoped ones get re-created by
//      schema and re-populated).
//
// But model_config is the only one in SYSTEM_SCHEMA — everything else is
// created lazily by its own store. So when the runtime store opens the new
// system DB and runs ensureTable(), it gets an empty new table — but the
// data needs to come from the backup.
//
// Therefore: the system migration needs to copy each system-scoped table
// that exists in the backup.

const USER_SCOPED_TABLES = new Set([
  'projects', 'threads', 'messages', 'files', 'documents', 'memory',
  'dispatch_log', 'message_events', 'chat_summaries', 'knowledge_base',
  'workspace_files', 'thinking_segments', 'prompt_log', 'skills',
  'message_attachments',
  'memory_embeddings',
  'audio_effect_presets', 'daw_projects',
  'copilot_memories', 'copilot_relationship',
  'game_player',
  'scheduled_tasks', 'scheduled_task_runs',
  'game_inventory', 'game_buildings', 'game_decorations', 'game_minerals',
]);

export interface MigrationReport {
  performed: boolean;
  backupPath?: string;
  userDbPath?: string;
  newSystemDbPath?: string;
  filesMoved: { from: string; to: string }[];
  rowCountsByTable: Record<string, number>;
  errors: string[];
}

/**
 * Thrown when the migration cannot complete safely. Boot must halt: leaving
 * the system half-migrated would split data between the backup and a
 * partially-populated new layout.
 *
 * The backup file (phobos.duckdb.pre-e1.backup) remains intact on disk.
 * Subsequent boots will retry the migration from the backup, since the
 * sentinel file (.e1-migration-complete) is only written on full success.
 */
export class MigrationFatalError extends Error {
  constructor(stage: string, cause: Error) {
    super(`E1 migration aborted at ${stage}: ${cause.message}`);
    this.name = 'MigrationFatalError';
    // Preserve the original error chain.
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

function migrationFlagPath(): string {
  return path.join(dataDir(), MIGRATION_FLAG_FILENAME);
}

export function isMigrationComplete(): boolean {
  return fs.existsSync(migrationFlagPath());
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`unsafe table identifier: ${name}`);
  }
  return `"${name}"`;
}

async function listTables(db: Database.Database): Promise<string[]> {
  const conn = await db.connect();
  try {
    const stmt = await conn.prepare(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'main' AND table_type = 'BASE TABLE'`,
    );
    const rows = await stmt.all() as Array<{ table_name: string }>;
    await stmt.finalize();
    return rows.map(r => r.table_name);
  } finally {
    await conn.close();
  }
}

/**
 * Introspect column names and types from both dest (schema 'main') and source
 * (schema 'src') for a given table. Returns a SQL SELECT expression list and
 * a matching INSERT column list so that:
 *
 *   - Matching types: bare column reference.
 *   - Mismatched types: TRY_CAST(src_col AS dest_type). TRY_CAST returns NULL
 *     on failure rather than throwing — preserves rows when source data is
 *     malformed or was stored under a now-corrected type (e.g. TIMESTAMP
 *     written where DOUBLE was intended).
 *   - Column exists in dest only (new column added after DB was created):
 *     NULL AS "col". The dest INSERT will store the column's DEFAULT or NULL.
 *   - Column exists in source only (dropped in current schema): omitted from
 *     both lists. INSERT does not reference it.
 *
 * This is intentionally generic so that any future schema drift (any table,
 * any column, any type change) is handled without touching this function.
 */
async function buildSelectList(
  conn: Database.Connection,
  table: string,
): Promise<{ selectExprs: string[]; insertCols: string[] }> {
  const q = quoteIdent(table);

  // Dest columns — pragma_table_info works on the current (dest) connection's
  // catalog without needing schema-qualified access. Returns {name, type, ...}.
  type PragmaRow = { name: string; type: string };
  const destStmt = await conn.prepare(`SELECT name, type FROM pragma_table_info(?)`);
  const destRows = await destStmt.all(table) as PragmaRow[];
  await destStmt.finalize();

  // Source columns — duckdb_columns() is a meta-function that spans all
  // attached databases and can be filtered by database_name. 'src' is the
  // alias used when ATTACHing the backup. column_index preserves declaration order.
  // NOTE: information_schema is NOT accessible via 'src.information_schema'
  // for ATTACHed databases in DuckDB; duckdb_columns() is the correct API.
  type DuckColRow = { column_name: string; data_type: string };
  const srcStmt = await conn.prepare(
    `SELECT column_name, data_type FROM duckdb_columns()
     WHERE database_name = 'src' AND table_name = ?
     ORDER BY column_index`,
  );
  const srcRows = await srcStmt.all(table) as DuckColRow[];
  await srcStmt.finalize();

  const srcMap = new Map(srcRows.map(r => [r.column_name, r.data_type]));

  const selectExprs: string[] = [];
  const insertCols: string[] = [];

  for (const { name: column_name, type: destType } of destRows) {
    const qc = quoteIdent(column_name);
    insertCols.push(qc);
    const srcType = srcMap.get(column_name);
    if (srcType === undefined) {
      // Column was added to the schema after this DB was created.
      selectExprs.push(`NULL AS ${qc}`);
    } else if (srcType.toUpperCase() === destType.toUpperCase()) {
      selectExprs.push(`src.${q}.${qc}`);
    } else {
      // Type mismatch — was stored under a different type in the old DB.
      // TRY_CAST preserves the row with NULL on unconvertible values rather
      // than aborting the entire copy.
      selectExprs.push(`TRY_CAST(src.${q}.${qc} AS ${destType}) AS ${qc}`);
      console.warn(
        `[Migration:E1]   schema drift on ${table}.${column_name}: ` +
        `source=${srcType} dest=${destType} — using TRY_CAST`,
      );
    }
  }

  return { selectExprs, insertCols };
}

/**
 * Copy a table whose schema already exists in dest (created by USER_SCHEMA
 * or SYSTEM_SCHEMA). Caller is responsible for opening dest and ATTACHing
 * source as `src`. This function only runs the INSERT and counts rows.
 *
 * Why no per-call open/close: Windows holds the underlying NTFS handle for
 * tens of milliseconds after `await close()` resolves. Opening dest fresh
 * per table races with that release. We hold a single dest open across the
 * whole copy phase instead.
 *
 * Uses buildSelectList to handle schema drift (added/removed/retyped columns)
 * between the backup and the current schema without aborting the copy.
 */
async function copyTableInto(
  conn: Database.Connection,
  table: string,
): Promise<number> {
  const q = quoteIdent(table);
  const { selectExprs, insertCols } = await buildSelectList(conn, table);
  // ON CONFLICT DO NOTHING: skip rows whose primary key already exists in dest
  // (e.g. seeded documents 'doc-claude-md' / 'doc-project-md').
  // DuckDB does not support INSERT OR IGNORE; ON CONFLICT DO NOTHING is the
  // correct equivalent for tables with a primary key constraint.
  await conn.exec(
    `INSERT INTO ${q} (${insertCols.join(', ')}) ` +
    `SELECT ${selectExprs.join(', ')} FROM src.${q} ` +
    `ON CONFLICT DO NOTHING`,
  );
  const countRows = await (await conn.prepare(`SELECT COUNT(*) AS n FROM ${q}`)).all() as Array<{ n: number | bigint }>;
  const n = countRows[0]?.n ?? 0;
  return typeof n === 'bigint' ? Number(n) : Number(n);
}

/**
 * Copy a table whose schema does not yet exist in dest. Used for lazy-
 * created tables (per-user stores that build their tables on first use)
 * and for system tables that aren't part of SYSTEM_SCHEMA. Caller opens dest
 * and ATTACHes source as `src`.
 */
async function copyLazyTableInto(
  conn: Database.Connection,
  table: string,
): Promise<number> {
  const q = quoteIdent(table);
  // If the table doesn't exist yet, create it from the source schema.
  await conn.exec(`CREATE TABLE IF NOT EXISTS ${q} AS SELECT * FROM src.${q} LIMIT 0`);
  // Use buildSelectList (TRY_CAST for type mismatches) so corrupted/retyped
  // fields don't abort the copy. Also handles tables pre-seeded by ensureTable.
  // ON CONFLICT DO NOTHING skips rows that conflict with seeded defaults.
  const { selectExprs, insertCols } = await buildSelectList(conn, table);
  await conn.exec(
    `INSERT INTO ${q} (${insertCols.join(', ')}) ` +
    `SELECT ${selectExprs.join(', ')} FROM src.${q} ` +
    `ON CONFLICT DO NOTHING`,
  );
  const countRows = await (await conn.prepare(`SELECT COUNT(*) AS n FROM ${q}`)).all() as Array<{ n: number | bigint }>;
  const n = countRows[0]?.n ?? 0;
  return typeof n === 'bigint' ? Number(n) : Number(n);
}

function moveIfExists(from: string, to: string, report: MigrationReport): void {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  report.filesMoved.push({ from, to });
}

export async function runE1Migration(): Promise<MigrationReport> {
  const report: MigrationReport = {
    performed: false,
    filesMoved: [],
    rowCountsByTable: {},
    errors: [],
  };

  if (isMigrationComplete()) return report;

  const root             = dataDir();
  const oldDbPath        = path.join(root, 'phobos.duckdb');
  const backupPath       = path.join(root, BACKUP_FILENAME);
  const ownerDir         = path.join(root, 'users', 'owner');
  const inProgressDir    = path.join(ownerDir, '.in-progress');
  const inProgressUserDb = path.join(inProgressDir, 'phobos.duckdb');
  const finalUserDb      = path.join(ownerDir, 'phobos.duckdb');

  // Detect what state we're in:
  //   (A) Fresh install            — no pre-E1 file, no users/owner/ dir, no backup.
  //   (B) Already-split layout     — backup absent, users/owner/phobos.duckdb populated.
  //                                  Sentinel may or may not exist (pre-sentinel installs).
  //   (C) Pre-E1 single-DB layout  — phobos.duckdb exists, no backup, no users/.
  //                                  Normal first-run migration.
  //   (D) Partial / half-migrated  — backup EXISTS, sentinel ABSENT. A prior boot
  //                                  started the migration and aborted. Stale empty
  //                                  outputs may have been created by post-abort
  //                                  initialize() calls. Restart from the backup.

  const sentinelExists = isMigrationComplete();
  const backupExists   = fs.existsSync(backupPath);

  if (backupExists && !sentinelExists) {
    // Case (D) — half-migrated state. Wipe any stale partial outputs and
    // re-run from the backup. The backup itself is left untouched.
    console.warn('[Migration:E1] Detected half-migrated state — backup present, sentinel absent. Restarting from backup.');
    if (fs.existsSync(oldDbPath))         { try { fs.unlinkSync(oldDbPath); }         catch { /* best-effort */ } }
    if (fs.existsSync(oldDbPath + '.wal')){ try { fs.unlinkSync(oldDbPath + '.wal'); } catch { /* best-effort */ } }
    if (fs.existsSync(finalUserDb))       { try { fs.unlinkSync(finalUserDb); }       catch { /* best-effort */ } }
    if (fs.existsSync(finalUserDb + '.wal')){ try { fs.unlinkSync(finalUserDb + '.wal'); } catch { /* best-effort */ } }
    if (fs.existsSync(inProgressDir)) {
      await fsOpWithRetry(
        'remove stale in-progress dir',
        () => fs.rmSync(inProgressDir, { recursive: true, force: true }),
      );
    }
    // Also remove stale workspaces/ and skills/ dirs that a prior partial run
    // may have created under users/owner/ — the move guards check !fs.existsSync
    // and will silently skip if these dirs already exist.
    const staleWs = path.join(ownerDir, 'workspaces');
    const staleSkills = path.join(ownerDir, 'skills');
    if (fs.existsSync(staleWs)) { try { fs.rmSync(staleWs, { recursive: true, force: true }); } catch { /* best-effort */ } }
    if (fs.existsSync(staleSkills)) { try { fs.rmSync(staleSkills, { recursive: true, force: true }); } catch { /* best-effort */ } }
    // Fall through to the migration body. Step 1 will detect the existing
    // backup and skip the rename.
  } else if (!fs.existsSync(oldDbPath) && !backupExists) {
    // Case (A) or (B) — nothing to migrate. Mark complete (idempotent) and exit.
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(migrationFlagPath(), new Date().toISOString());
    return report;
  } else if (fs.existsSync(finalUserDb) && !backupExists) {
    // Case (B) — already split, no backup remaining. Mark complete and exit.
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(migrationFlagPath(), new Date().toISOString());
    return report;
  }
  // Otherwise: case (C) — pre-E1 layout, oldDbPath has real data. Proceed.

  console.log('[Migration:E1] Splitting single-DB layout into per-user structure');
  report.performed   = true;
  report.backupPath  = backupPath;
  report.userDbPath  = finalUserDb;
  report.newSystemDbPath = oldDbPath;

  fs.mkdirSync(ownerDir, { recursive: true });
  // Clean any stale in-progress dir from a prior aborted run.
  if (fs.existsSync(inProgressDir)) {
    await fsOpWithRetry(
      'remove stale in-progress dir',
      () => fs.rmSync(inProgressDir, { recursive: true, force: true }),
    );
  }
  fs.mkdirSync(inProgressDir, { recursive: true });

  // Step 1: rename the old DB aside. From this point on, the old data lives
  // at backupPath. The original path is empty until we build the new system DB.
  // If the backup already exists (case D — restarting from a half-migrated state),
  // skip the rename: the backup is what we want to read from.
  if (!fs.existsSync(backupPath)) {
    console.log(`[Migration:E1] Renaming ${oldDbPath} → ${backupPath}`);
    fs.renameSync(oldDbPath, backupPath);
    // Also clean up the WAL file if any — it's now stale relative to the renamed
    // DB and DuckDB will recreate WAL alongside whichever file it opens next.
    const walPath = oldDbPath + '.wal';
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
  } else {
    console.log(`[Migration:E1] Reusing existing backup at ${backupPath}`);
  }

  // Step 2: enumerate which tables actually exist in the backup.
  // Open READ_ONLY so DuckDB does not create a WAL or hold a write lock — both
  // would race with the subsequent ATTACH inside copyTable on Windows.
  let backupTables: Set<string>;
  try {
    const probeDb: Database.Database = await openWithRetry(
      'open backup probe',
      () => Database.Database.create(backupPath, { access_mode: 'READ_ONLY' }),
    );
    try {
      backupTables = new Set(await listTables(probeDb));
    } finally {
      await probeDb.close();
    }
  } catch (err) {
    // Could not even open the backup — abort migration. The renamed backup
    // remains intact at backupPath; on next boot we'll retry from it.
    try {
      await fsOpWithRetry(
        'remove in-progress dir after probe failure',
        () => fs.rmSync(inProgressDir, { recursive: true, force: true }),
      );
    } catch (cleanupErr) {
      console.warn('[Migration:E1] cleanup of in-progress dir failed:', (cleanupErr as Error).message);
    }
    console.error('[Migration:E1] FATAL — could not open backup; aborting');
    throw new MigrationFatalError('open backup probe', err as Error);
  }

  // Steps 3+4 combined: build the user DB and copy all user-scoped tables in
  // a SINGLE open/close — same pattern as the merged system Steps 5+6.
  // Pre-creating lazy-table schemas via wrapExisting() preserves their PRIMARY
  // KEY constraints so copyLazyTableInto's ON CONFLICT DO NOTHING works.
  console.log(`[Migration:E1] Building user DB at ${inProgressUserDb}`);
  let userCopyDb: Database.Database | null = null;
  let userCopyConn: Database.Connection | null = null;
  let userAttached = false;
  try {
    const { DatabaseManager, USER_SCHEMA, BUNDLED_EXTENSION_DIR } = await import('./DatabaseManager.js');
    fs.mkdirSync(path.dirname(inProgressUserDb), { recursive: true });
    const dbConfig = BUNDLED_EXTENSION_DIR ? { extension_directory: BUNDLED_EXTENSION_DIR } : {};

    userCopyDb = await openWithRetry(
      'create user DB',
      () => Database.Database.create(inProgressUserDb, dbConfig as Record<string, string>),
    );
    userCopyConn = await userCopyDb.connect();
    console.log(`[DB] Initialized user at ${inProgressUserDb}`);

    // Apply USER_SCHEMA (core user tables with their PKs).
    await userCopyConn.exec(USER_SCHEMA);

    // Pre-create user lazy-table schemas on the same handle so PKs survive copy.
    const userDbMgr = DatabaseManager.wrapExisting('user', inProgressUserDb, userCopyDb);
    try {
      const { EffectRackStore } = await import('./EffectRackStore.js');
      await new EffectRackStore(userDbMgr).ensureTable();
    } catch (e) { /* non-fatal */ }
    try {
      const { GameStore } = await import('./GameStore.js');
      await new GameStore(userDbMgr).ensureTable();
    } catch (e) { /* non-fatal */ }
    try {
      const { CopilotMemoryStore } = await import('./CopilotMemoryStore.js');
      await new CopilotMemoryStore(userDbMgr).ensureTable();
    } catch (e) { /* non-fatal */ }
    try {
      const { CopilotRelationshipStore } = await import('./CopilotRelationshipStore.js');
      await new CopilotRelationshipStore(userDbMgr).ensureTable();
    } catch (e) { /* non-fatal */ }
    try {
      const { DawProjectStore } = await import('./DawProjectStore.js');
      await new DawProjectStore(userDbMgr).ensureTable();
    } catch (e) { /* non-fatal */ }
    try {
      const { MemoryStore } = await import('./MemoryStore.js');
      await new MemoryStore(userDbMgr).ensureTable();
    } catch (e) { /* non-fatal */ }
    try {
      const { MessageAttachmentStore } = await import('./MessageAttachmentStore.js');
      await new MessageAttachmentStore(userDbMgr).ensureTable();
    } catch (e) { /* non-fatal */ }
    try {
      const { ScheduledTaskStore } = await import('./ScheduledTaskStore.js');
      await new ScheduledTaskStore(userDbMgr).ensureTable();
    } catch (e) { /* non-fatal */ }

    // ATTACH backup and copy all user-scoped tables on the same handle.
    const escapedSource = backupPath.replace(/'/g, "''");
    await openWithRetry(
      'attach backup for user copy phase',
      () => userCopyConn!.exec(`ATTACH '${escapedSource}' AS src (READ_ONLY)`),
    );
    userAttached = true;

    // Step 4: schema-defined tables.
    for (const tbl of USER_TABLES_IN_ORDER) {
      if (!backupTables.has(tbl)) continue;
      try {
        const n = await copyTableInto(userCopyConn, tbl);
        report.rowCountsByTable[tbl] = n;
        console.log(`[Migration:E1]   user.${tbl}: ${n} rows`);
      } catch (err) {
        // Tear down the held handle before throwing so the rmSync below succeeds.
        try { if (userAttached) await userCopyConn.exec(`DETACH src`); } catch { /* best-effort */ }
        try { await userCopyConn.close(); } catch { /* best-effort */ }
        try { await userCopyDb.close(); } catch { /* best-effort */ }
        userCopyConn = null;
        userCopyDb = null;
        await sleep(50);
        try {
          await fsOpWithRetry(
            'remove in-progress dir after table copy failure',
            () => fs.rmSync(inProgressDir, { recursive: true, force: true }),
          );
        } catch (cleanupErr) {
          console.warn('[Migration:E1] cleanup of in-progress dir failed:', (cleanupErr as Error).message);
        }
        console.error(`[Migration:E1] FATAL — failed to copy ${tbl}; aborting`);
        throw new MigrationFatalError(`copy table ${tbl}`, err as Error);
      }
    }

    // Lazy-created user tables (from stores that build their schema on first use).
    for (const tbl of backupTables) {
      if (!USER_SCOPED_TABLES.has(tbl)) continue;
      if (USER_TABLES_IN_ORDER.includes(tbl)) continue;
      try {
        const n = await copyLazyTableInto(userCopyConn, tbl);
        report.rowCountsByTable[tbl] = n;
        console.log(`[Migration:E1]   user.${tbl}: ${n} rows (lazy schema)`);
      } catch (err) {
        // Lazy table copy is best-effort. Log and continue. Stores will recreate empty.
        report.errors.push(`Soft-failed lazy copy of ${tbl}: ${(err as Error).message}`);
        console.warn(`[Migration:E1]   user.${tbl}: copy failed, store will start empty`);
      }
    }
  } finally {
    // Always tear down — even on success — so the file handle releases before
    // the rename in Step 7.
    if (userCopyConn) {
      try { if (userAttached) await userCopyConn.exec(`DETACH src`); } catch { /* best-effort */ }
      try { await userCopyConn.close(); } catch { /* best-effort */ }
    }
    if (userCopyDb) {
      try { await userCopyDb.close(); } catch { /* best-effort */ }
    }
  }
  // Let Windows release the user DB handle before the rename in Step 7.
  await sleep(50);

  // Steps 5+6 combined: build the system DB and copy all system-scoped tables
  // in a SINGLE open/close. This eliminates the Step 5-close → Step 6-reopen
  // race that caused Windows to hold the NTFS handle indefinitely between the
  // two opens on the same file.
  //
  // Why one handle matters:
  //   - DatabaseManager.initialize() (Step 5) used to close the DB after schema
  //     apply, then Step 6 immediately tried to reopen the same file. On Windows,
  //     the native DuckDB finalizer runs on a libuv worker thread — the NTFS
  //     handle may stay alive for seconds after close() resolves in JS. Retrying
  //     the open from the JS event loop starves the libuv worker thread (it never
  //     gets CPU to run the finalizer), so the lock never releases no matter how
  //     long we wait.
  //   - With a single handle we open once, do everything, and close once. No
  //     reopen, no starvation, no race.
  //
  // Schema pre-creation is critical for tables with ON CONFLICT DML at runtime:
  //   copyLazyTableInto uses CREATE TABLE IF NOT EXISTS ... AS SELECT * LIMIT 0,
  //   which strips PRIMARY KEY constraints. Pre-creating the table schemas here
  //   (with real PKs) makes the CTAS a no-op, preserving constraints through copy.
  console.log(`[Migration:E1] Building system DB at ${oldDbPath}`);
  {
    let sysDb: Database.Database | null = null;
    let sysConn: Database.Connection | null = null;
    let sysAttached = false;
    try {
      const { BUNDLED_EXTENSION_DIR, SYSTEM_SCHEMA } = await import('./DatabaseManager.js');
      fs.mkdirSync(path.dirname(oldDbPath), { recursive: true });
      const dbConfig = BUNDLED_EXTENSION_DIR ? { extension_directory: BUNDLED_EXTENSION_DIR } : {};
      if (BUNDLED_EXTENSION_DIR) console.log(`[DB] Extension dir: ${BUNDLED_EXTENSION_DIR}`);

      sysDb = await openWithRetry(
        'create system DB',
        () => Database.Database.create(oldDbPath, dbConfig as Record<string, string>),
      );
      sysConn = await sysDb.connect();
      console.log(`[DB] Initialized system at ${oldDbPath}`);

      // Apply SYSTEM_SCHEMA (users + model_config tables).
      await sysConn.exec(SYSTEM_SCHEMA);

      // Pre-create system-scoped lazy-table schemas WITH their PKs, so that
      // copyLazyTableInto's CTAS is a no-op and PKs are preserved through copy.
      // wrapExisting() shares sysDb — no second Database.Database open on this file.
      const { DatabaseManager } = await import('./DatabaseManager.js');
      const sysDbMgr = DatabaseManager.wrapExisting('system', oldDbPath, sysDb);

      try {
        const { MeridianDB } = await import('../meridian/db/db.js');
        await new MeridianDB(sysDbMgr).ensureSchema();
        console.log('[Migration:E1]   pre-created Meridian schema (PKs preserved)');
      } catch (e) { console.warn('[Migration:E1]   Meridian schema pre-create failed (non-fatal):', (e as Error).message); }
      try {
        const { CartridgeStore } = await import('./CartridgeStore.js');
        await new CartridgeStore(sysDbMgr).ensureTable();
        console.log('[Migration:E1]   pre-created CartridgeStore schema');
      } catch (e) { console.warn('[Migration:E1]   CartridgeStore schema pre-create failed (non-fatal):', (e as Error).message); }
      try {
        const { PluginStore } = await import('./PluginStore.js');
        await new PluginStore(sysDbMgr).ensureTable();
        console.log('[Migration:E1]   pre-created PluginStore schema');
      } catch (e) { console.warn('[Migration:E1]   PluginStore schema pre-create failed (non-fatal):', (e as Error).message); }
      try {
        const { ServiceStore } = await import('./ServiceStore.js');
        await new ServiceStore(sysDbMgr).ensureTable();
        console.log('[Migration:E1]   pre-created ServiceStore schema');
      } catch (e) { console.warn('[Migration:E1]   ServiceStore schema pre-create failed (non-fatal):', (e as Error).message); }
      try {
        const { SecurityStore } = await import('./SecurityStore.js');
        await new SecurityStore(sysDbMgr).ensureTable();
        console.log('[Migration:E1]   pre-created SecurityStore schema');
      } catch (e) { console.warn('[Migration:E1]   SecurityStore schema pre-create failed (non-fatal):', (e as Error).message); }
      try {
        const { PluginScanner } = await import('../phobos/PluginScanner.js');
        await new PluginScanner(sysDbMgr).ensureTable();
        console.log('[Migration:E1]   pre-created PluginScanner schema');
      } catch (e) { console.warn('[Migration:E1]   PluginScanner schema pre-create failed (non-fatal):', (e as Error).message); }

      // ATTACH backup and copy all system-scoped tables on the same handle.
      const systemTables = Array.from(backupTables).filter(t => !USER_SCOPED_TABLES.has(t) && t !== 'users');
      if (systemTables.length > 0) {
        const escapedSource = backupPath.replace(/'/g, "''");
        await openWithRetry(
          'attach backup for system copy phase',
          () => sysConn!.exec(`ATTACH '${escapedSource}' AS src (READ_ONLY)`),
        );
        sysAttached = true;

        for (const tbl of systemTables) {
          try {
            const n = await copyLazyTableInto(sysConn, tbl);
            report.rowCountsByTable[tbl] = n;
            console.log(`[Migration:E1]   system.${tbl}: ${n} rows`);
          } catch (err) {
            report.errors.push(`Failed to copy system table ${tbl}: ${(err as Error).message}`);
            console.warn(`[Migration:E1]   system.${tbl}: copy failed (non-fatal)`);
          }
        }
      }
    } catch (err) {
      if (!(err instanceof MigrationFatalError)) {
        try {
          await fsOpWithRetry(
            'remove in-progress dir after system build failure',
            () => fs.rmSync(inProgressDir, { recursive: true, force: true }),
          );
        } catch (cleanupErr) {
          console.warn('[Migration:E1] cleanup of in-progress dir failed:', (cleanupErr as Error).message);
        }
        if (fs.existsSync(oldDbPath)) { try { fs.unlinkSync(oldDbPath); } catch { /* best-effort */ } }
        if (fs.existsSync(oldDbPath + '.wal')) { try { fs.unlinkSync(oldDbPath + '.wal'); } catch { /* best-effort */ } }
        console.error('[Migration:E1] FATAL — system DB build failed; aborting');
        throw new MigrationFatalError('build system DB', err as Error);
      }
      throw err;
    } finally {
      if (sysConn) {
        try { if (sysAttached) await sysConn.exec(`DETACH src`); } catch { /* best-effort */ }
        try { await sysConn.exec(`CHECKPOINT`); } catch { /* best-effort */ }
        try { await sysConn.close(); } catch { /* best-effort */ }
      }
      if (sysDb) {
        try { await sysDb.close(); } catch { /* best-effort */ }
      }
    }
  }
  await sleep(50);

  // Step 7: rename in-progress user DB into final location.
  // The user DB was closed at the end of the copy phase, but DuckDB's native
  // handle release on Windows is async relative to the JS close() promise.
  // Yield the event loop many times to let libuv drain native finalizers,
  // then use a long-budget rename retry ladder specifically for this step.
  await yieldToEventLoop(50);
  await sleep(200);
  // Clean any stale WAL alongside the in-progress DB before rename.
  const inProgressWal = inProgressUserDb + '.wal';
  if (fs.existsSync(inProgressWal)) {
    try { fs.unlinkSync(inProgressWal); } catch { /* best-effort */ }
  }
  await fsRenameWithRetry('rename in-progress user DB into place', inProgressUserDb, finalUserDb);
  // Remove the now-empty in-progress dir. Best-effort: failure here does not
  // affect correctness; the half-migrated detector only looks at the sentinel
  // and backup, not the in-progress dir's existence.
  try {
    await fsOpWithRetry(
      'remove in-progress dir',
      () => fs.rmSync(inProgressDir, { recursive: true, force: true }),
    );
  } catch {
    console.warn('[Migration:E1] Could not remove .in-progress dir — harmless, will be cleaned on next boot.');
  }

  // Step 8: move conversations.duckdb, workspaces/, license.key, civitai-token.txt
  const oldConv  = path.join(root, 'conversations.duckdb');
  const newConv  = path.join(ownerDir, 'conversations.duckdb');
  moveIfExists(oldConv, newConv, report);
  // Also pick up any WAL alongside conversations.duckdb
  if (fs.existsSync(oldConv + '.wal')) {
    moveIfExists(oldConv + '.wal', newConv + '.wal', report);
  }

  const oldWs    = path.join(root, 'workspaces');
  const newWs    = path.join(ownerDir, 'workspaces');
  if (fs.existsSync(oldWs) && !fs.existsSync(newWs)) {
    fs.mkdirSync(path.dirname(newWs), { recursive: true });
    fs.renameSync(oldWs, newWs);
    report.filesMoved.push({ from: oldWs, to: newWs });
    console.log(`[Migration:E1] Moved workspaces directory`);
  }

  moveIfExists(path.join(root, 'license.key'), path.join(ownerDir, 'license.key'), report);
  moveIfExists(path.join(root, 'civitai-token.txt'), path.join(ownerDir, 'civitai-token.txt'), report);

  // Move user skills tree. Pre-E1 layout was:
  //   ~/.phobos/user/skills/<id>/
  //   ~/.phobos/user/_registry.json
  // Post-E1 layout is:
  //   ~/.phobos/users/owner/skills/<id>/
  //   ~/.phobos/users/owner/skills/_registry.json   (relocated INTO skills dir)
  const oldUserDir   = path.join(root, 'user');
  const oldSkillsDir = path.join(oldUserDir, 'skills');
  const newSkillsDir = path.join(ownerDir, 'skills');
  if (fs.existsSync(oldSkillsDir) && !fs.existsSync(newSkillsDir)) {
    fs.mkdirSync(path.dirname(newSkillsDir), { recursive: true });
    fs.renameSync(oldSkillsDir, newSkillsDir);
    report.filesMoved.push({ from: oldSkillsDir, to: newSkillsDir });
    console.log(`[Migration:E1] Moved user skills directory`);
  }
  // Old registry sat parallel to skills/; new registry sits inside skills/.
  moveIfExists(
    path.join(oldUserDir, '_registry.json'),
    path.join(newSkillsDir, '_registry.json'),
    report,
  );
  // Best-effort cleanup of the now-empty pre-E1 parent dir.
  try {
    if (fs.existsSync(oldUserDir) && fs.readdirSync(oldUserDir).length === 0) {
      fs.rmdirSync(oldUserDir);
    }
  } catch { /* non-fatal — leftover dir is harmless */ }

  // Step 9 (owner row insert) is handled by server.ts after it opens the
  // system DB for its own use. Doing it here would require a third open/close
  // of phobos.duckdb in quick succession, which races with Windows' delayed
  // NTFS handle release and causes the server's subsequent open to fail.

  // Step 10: mark migration complete.
  fs.writeFileSync(migrationFlagPath(), new Date().toISOString());
  console.log('[Migration:E1] Migration complete.');
  console.log(`[Migration:E1]   backup at: ${backupPath}`);
  console.log(`[Migration:E1]   user DB:   ${finalUserDb}`);
  console.log(`[Migration:E1]   system DB: ${oldDbPath}`);
  if (report.errors.length > 0) {
    console.warn(`[Migration:E1]   ${report.errors.length} non-fatal warnings`);
  }

  // Give Windows time to release the system DB native handle before server.ts
  // opens the same file. sysCopyDb.close() resolves in JS but the NTFS handle
  // release is async. Steps 7+8 above are fast synchronous renames — not enough
  // wall-clock time for libuv's finalizer thread to drain. Yielding here ensures
  // server.ts never races with the lingering handle.
  await yieldToEventLoop(50);
  await sleep(500);

  return report;
}