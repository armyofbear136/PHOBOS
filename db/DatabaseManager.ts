import Database from 'duckdb-async';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ── Resolve bundled DuckDB extension directory ─────────────────────────────────
// DuckDB looks for extensions at: {extension_directory}/v{version}/{platform}/
// We bundle vss.duckdb_extension in phobos/extensions/ staged alongside the exe.
function resolveBundledExtensionDir(): string | null {
  const seaDir  = path.dirname(process.execPath);
  const repoDir = path.resolve(path.dirname(
    typeof __filename !== 'undefined' ? __filename : process.cwd()
  ), '..');

  const candidates = [
    path.join(seaDir, 'phobos', 'extensions'),
    path.join(repoDir, 'phobos', 'extensions'),
    path.join(repoDir, 'dist', 'phobos', 'extensions'),
    path.join(process.cwd(), 'phobos', 'extensions'),
  ];

  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

export const BUNDLED_EXTENSION_DIR = resolveBundledExtensionDir();

// ── Active user resolution (E1: hardcoded; E2: per-request) ───────────────────
//
// The active user is the identity whose data the current operation reads/writes.
// E1 has only one real user ('owner'). The env var lets test/dev override.
// E2 will replace these reads with per-request resolution from the auth context.

export const DEFAULT_USERNAME = 'owner';

export function getActiveUser(): string {
  return process.env.PHOBOS_ACTIVE_USER || DEFAULT_USERNAME;
}

// ── Path resolution ───────────────────────────────────────────────────────────

function dataDir(): string {
  return process.env.PHOBOS_DATA_DIR ?? path.join(os.homedir(), '.phobos');
}

export function systemDbPath(): string {
  return path.join(dataDir(), 'phobos.duckdb');
}

export function userDir(username: string): string {
  return path.join(dataDir(), 'users', username);
}

export function userDbPath(username: string): string {
  return path.join(userDir(username), 'phobos.duckdb');
}

// ── Schemas ───────────────────────────────────────────────────────────────────
//
// SYSTEM_SCHEMA: tables that live in ~/.phobos/phobos.duckdb. Shared across
// all users — model selections, media services, cartridges, plugins, the
// users master list itself.
//
// USER_SCHEMA: tables that live in ~/.phobos/users/{username}/phobos.duckdb.
// Each user has their own copy. Threads, messages, prompt logs, workspaces,
// memory, copilot relationships, game state, etc.
//
// Cross-DB foreign keys are not enforced (DuckDB doesn't support them across
// files anyway). The `users(username)` row is the logical anchor for every
// per-user DB. Deleting a user means deleting their directory.

export const SYSTEM_SCHEMA = `
-- Master list of users on this PHOBOS instance.
-- Each row corresponds to ~/.phobos/users/<username>/.
CREATE TABLE IF NOT EXISTS users (
  username    VARCHAR PRIMARY KEY,
  display_name VARCHAR NOT NULL,
  role        VARCHAR NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','full','guest','read')),
  created_at  TIMESTAMP NOT NULL DEFAULT now(),
  last_active TIMESTAMP
);

-- Model config: persisted endpoint + model selections (system-wide).
CREATE TABLE IF NOT EXISTS model_config (
  key        VARCHAR PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
`;

export const USER_SCHEMA = `
-- Threads
CREATE TABLE IF NOT EXISTS threads (
  id          VARCHAR PRIMARY KEY,
  title       VARCHAR NOT NULL DEFAULT 'New conversation',
  type        VARCHAR NOT NULL DEFAULT 'execution' CHECK (type IN ('planning','execution')),
  project_id  VARCHAR,
  parent_thread_id VARCHAR,
  mode        VARCHAR NOT NULL DEFAULT 'code',
  created_at  TIMESTAMP NOT NULL DEFAULT now(),
  updated_at  TIMESTAMP NOT NULL DEFAULT now()
);

-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id         VARCHAR PRIMARY KEY,
  name       VARCHAR NOT NULL,
  root_path  VARCHAR NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Messages
CREATE TABLE IF NOT EXISTS messages (
  id                VARCHAR PRIMARY KEY,
  thread_id         VARCHAR NOT NULL REFERENCES threads(id),
  role              VARCHAR NOT NULL CHECK (role IN ('user','assistant','coordinator','status')),
  content           TEXT NOT NULL,
  distilled_content TEXT,
  thinking_trace    TEXT,
  dispatch_id       VARCHAR,
  attempt_number    INTEGER,
  review_score      DOUBLE,
  created_at        TIMESTAMP NOT NULL DEFAULT now()
);

-- Files (uploaded attachments, not workspace files)
CREATE TABLE IF NOT EXISTS files (
  id           VARCHAR PRIMARY KEY,
  thread_id    VARCHAR NOT NULL REFERENCES threads(id),
  filename     VARCHAR NOT NULL,
  path         VARCHAR,
  preview      TEXT,
  size         BIGINT,
  mime_type    VARCHAR,
  created_at   TIMESTAMP NOT NULL DEFAULT now()
);

-- Documents (versioned claude.md / project.md / chat.md)
CREATE TABLE IF NOT EXISTS documents (
  id         VARCHAR PRIMARY KEY,
  doc_type   VARCHAR NOT NULL CHECK (doc_type IN ('claude_md','project_md','chat_md','phobos_directives','user_directives')),
  project_id VARCHAR,
  content    TEXT NOT NULL DEFAULT '',
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Memory (key-value store for AI-written context)
CREATE TABLE IF NOT EXISTS memory (
  key        VARCHAR NOT NULL,
  value      TEXT NOT NULL,
  project_id VARCHAR NOT NULL DEFAULT 'global',
  written_by VARCHAR NOT NULL DEFAULT 'user',
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (key, project_id)
);

-- Dispatch log (instrumentation, per-user since it's tied to that user's tasks)
CREATE TABLE IF NOT EXISTS dispatch_log (
  id             VARCHAR PRIMARY KEY,
  message_id     VARCHAR,
  model          VARCHAR NOT NULL,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  think_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  latency_ms     INTEGER NOT NULL DEFAULT 0,
  attempt_number INTEGER NOT NULL DEFAULT 1,
  review_score   DOUBLE,
  task_type      VARCHAR,
  result         VARCHAR CHECK (result IN ('APPROVE','REJECT','ERROR','PENDING')),
  created_at     TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message_events (
  id           VARCHAR PRIMARY KEY,
  thread_id    VARCHAR NOT NULL REFERENCES threads(id),
  message_id   VARCHAR,
  event_type   VARCHAR NOT NULL,
  payload      TEXT NOT NULL,
  seq          INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_summaries (
  id                      VARCHAR PRIMARY KEY,
  thread_id               VARCHAR NOT NULL REFERENCES threads(id),
  summary                 TEXT NOT NULL,
  message_count_at_update INTEGER NOT NULL DEFAULT 0,
  updated_at              TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (thread_id)
);

CREATE TABLE IF NOT EXISTS knowledge_base (
  id         VARCHAR PRIMARY KEY,
  query      VARCHAR NOT NULL,
  content    TEXT NOT NULL,
  source_url VARCHAR,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_query ON knowledge_base(query);

CREATE TABLE IF NOT EXISTS workspace_files (
  id           VARCHAR PRIMARY KEY,
  thread_id    VARCHAR NOT NULL REFERENCES threads(id),
  filename     VARCHAR NOT NULL,
  language     VARCHAR,
  size_bytes   BIGINT NOT NULL DEFAULT 0,
  note         TEXT,
  last_written_by VARCHAR,
  content_hash VARCHAR,
  created_at   TIMESTAMP NOT NULL DEFAULT now(),
  updated_at   TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (thread_id, filename)
);

CREATE TABLE IF NOT EXISTS thinking_segments (
  id           VARCHAR PRIMARY KEY,
  thread_id    VARCHAR NOT NULL,
  message_id   VARCHAR NOT NULL,
  phase        VARCHAR NOT NULL,
  content      TEXT    NOT NULL DEFAULT '',
  token_count  INTEGER NOT NULL DEFAULT 0,
  seq          INTEGER NOT NULL,
  started_at   VARCHAR NOT NULL,
  completed_at VARCHAR
);
CREATE INDEX IF NOT EXISTS idx_thinking_segments_thread
  ON thinking_segments(thread_id, started_at ASC);
CREATE INDEX IF NOT EXISTS idx_thinking_segments_message
  ON thinking_segments(message_id, seq ASC);

CREATE TABLE IF NOT EXISTS prompt_log (
  id          VARCHAR PRIMARY KEY,
  thread_id   VARCHAR NOT NULL REFERENCES threads(id),
  message_id  VARCHAR,
  role        VARCHAR NOT NULL,
  stage       VARCHAR NOT NULL,
  model       VARCHAR NOT NULL,
  prompt      TEXT    NOT NULL,
  response    TEXT    NOT NULL,
  latency_ms  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prompt_log_thread
  ON prompt_log(thread_id, created_at ASC);

-- User-uploaded skills are per-user; system-level skills come from the bundled set on disk.
CREATE TABLE IF NOT EXISTS skills (
  id           VARCHAR PRIMARY KEY,
  name         VARCHAR NOT NULL,
  scope        VARCHAR NOT NULL,
  category     VARCHAR NOT NULL,
  trigger      VARCHAR,
  runner       VARCHAR,
  installed_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Seed default documents if none exist (per-user — each user has their own).
INSERT OR IGNORE INTO documents (id, doc_type, content, version)
VALUES
  ('doc-claude-md', 'claude_md',
'# AI Constitution

You are a senior software engineer. Adapt to whatever language, stack, and conventions the project uses.

## Edit Format
Output code changes ONLY as SEARCH/REPLACE blocks. Never rewrite entire files unless explicitly asked.

## Behavior
- Ask a QUESTION: in your thinking if you are genuinely unsure about scope or intent
- Be precise about file paths — always use the path exactly as provided in the workspace index
- Prefer surgical edits over large rewrites
- Explain what you changed and why in a brief summary after your edit blocks', 1),

  ('doc-project-md', 'project_md',
'# Project

Describe your project here. The AI will read this before every task.', 1);
`;

// ── DatabaseManager ───────────────────────────────────────────────────────────
//
// Multi-instance manager keyed by (kind, identifier).
//   kind='system'  → ~/.phobos/phobos.duckdb (one)
//   kind='user'    → ~/.phobos/users/{username}/phobos.duckdb (one per user)
//
// Stores choose which DB they live in by calling getInstance() (system) or
// getUserDb() (user, defaults to active user). Routes that touch system data
// (model_config, cartridges, plugins, media services) keep getInstance().
// Routes that touch per-user data (threads, messages, etc.) use getUserDb().

type Kind = 'system' | 'user';

export class DatabaseManager {
  private static instances = new Map<string, DatabaseManager>();
  private db!: Database.Database;
  private dbPath: string;
  private kind: Kind;

  private constructor(kind: Kind, dbPath: string) {
    this.kind = kind;
    this.dbPath = dbPath;
  }

  /**
   * System-scoped DatabaseManager. Returns the singleton for ~/.phobos/phobos.duckdb.
   *
   * The `dbPath` argument is preserved for backward compatibility with existing
   * callers that pass a path explicitly (typically server.ts at boot, and tests
   * that construct an isolated DB). When unspecified, the canonical system path
   * is used. Tests that pass a custom path get an isolated instance keyed by
   * that path.
   */
  static getInstance(dbPath?: string): DatabaseManager {
    const resolvedPath = dbPath ?? systemDbPath();
    const key = `system:${resolvedPath}`;
    let inst = DatabaseManager.instances.get(key);
    if (!inst) {
      inst = new DatabaseManager('system', resolvedPath);
      DatabaseManager.instances.set(key, inst);
    }
    return inst;
  }

  /**
   * User-scoped DatabaseManager. Returns the singleton for the given user's
   * ~/.phobos/users/{username}/phobos.duckdb. When no username is given, the
   * active user (from getActiveUser()) is used.
   *
   * E1: getActiveUser() always returns 'owner' unless PHOBOS_ACTIVE_USER is set.
   * E2: getActiveUser() will read from per-request session context.
   */
  static getUserDb(username?: string): DatabaseManager {
    const user = username ?? getActiveUser();
    const resolvedPath = userDbPath(user);
    const key = `user:${user}:${resolvedPath}`;
    let inst = DatabaseManager.instances.get(key);
    if (!inst) {
      inst = new DatabaseManager('user', resolvedPath);
      DatabaseManager.instances.set(key, inst);
    }
    return inst;
  }

  /**
   * Used only by Migration.ts to build DBs at arbitrary paths during the E1
   * split. Bypasses the singleton cache. Do not use elsewhere.
   */
  static createForMigration(kind: Kind, dbPath: string): DatabaseManager {
    return new DatabaseManager(kind, dbPath);
  }

  /**
   * Wrap an already-open Database.Database instance as a DatabaseManager.
   * Used by Migration.ts so that schema-pre-creation calls (ensureSchema,
   * ensureTable) share the same native handle as the copy phase, avoiding
   * the double-open file-lock race on Windows.
   * Do not use elsewhere.
   */
  static wrapExisting(kind: Kind, dbPath: string, db: Database.Database): DatabaseManager {
    const inst = new DatabaseManager(kind, dbPath);
    inst.db = db;
    return inst;
  }

  async initialize(): Promise<void> {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    const dbConfig = BUNDLED_EXTENSION_DIR
      ? { extension_directory: BUNDLED_EXTENSION_DIR }
      : {};

    this.db = await Database.Database.create(this.dbPath, dbConfig as any);
    const schema = this.kind === 'system' ? SYSTEM_SCHEMA : USER_SCHEMA;
    await this.db.exec(schema);
    if (this.kind === 'user') {
      await this.migrateDocuments();
      await this.ensureDistilledColumn();
    }
    if (BUNDLED_EXTENSION_DIR && this.kind === 'system') {
      console.log(`[DB] Extension dir: ${BUNDLED_EXTENSION_DIR}`);
    }
    console.log(`[DB] Initialized ${this.kind} at ${this.dbPath}`);
  }

  private async ensureDistilledColumn(): Promise<void> {
    try {
      await this.db!.exec(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS distilled_content TEXT`);
    } catch {
      try {
        await this.db!.exec(`SELECT distilled_content FROM messages LIMIT 0`);
      } catch {
        try {
          await this.db!.exec(`ALTER TABLE messages ADD COLUMN distilled_content TEXT`);
        } catch (err) {
          console.warn('[DB] ensureDistilledColumn failed (non-fatal):', err);
        }
      }
    }
  }

  private async migrateDocuments(): Promise<void> {
    try {
      const conn = await this.db.connect();
      try {
        await conn.exec(`INSERT INTO documents (id, doc_type, content, version)
          VALUES ('__probe__', 'user_directives', '', 0)`);
        await conn.exec(`DELETE FROM documents WHERE id = '__probe__'`);
      } catch {
        await conn.exec(`
          ALTER TABLE documents RENAME TO documents_old;
          CREATE TABLE documents (
            id         VARCHAR PRIMARY KEY,
            doc_type   VARCHAR NOT NULL CHECK (doc_type IN ('claude_md','project_md','chat_md','phobos_directives','user_directives')),
            project_id VARCHAR,
            content    TEXT NOT NULL DEFAULT '',
            version    INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMP NOT NULL DEFAULT now(),
            updated_at TIMESTAMP NOT NULL DEFAULT now()
          );
          INSERT INTO documents SELECT * FROM documents_old;
          DROP TABLE documents_old;
        `);
        console.log('[DB] Migrated documents table: expanded doc_type CHECK constraint');
      } finally {
        await conn.close();
      }
    } catch (err) {
      console.warn('[DB] migrateDocuments skipped:', err);
    }
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    const conn = await this.db.connect();
    try {
      const stmt = await conn.prepare(sql);
      const rows = await stmt.all(...params);
      await stmt.finalize();
      return (rows as T[]).map((row) => {
        const coerced: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row as object)) {
          coerced[k] = typeof v === 'bigint' ? Number(v) : v;
        }
        return coerced as T;
      });
    } finally {
      await conn.close();
    }
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    const conn = await this.db.connect();
    try {
      const stmt = await conn.prepare(sql);
      await stmt.run(...params);
      await stmt.finalize();
    } finally {
      await conn.close();
    }
  }

  /** Execute a SQL statement directly without going through prepare().
   *  Use when DuckDB's binder fails on the prepare phase for valid SQL
   *  (e.g. ON CONFLICT (col) DO NOTHING on PRIMARY KEY columns in 1.4). */
  async exec(sql: string): Promise<void> {
    const conn = await this.db.connect();
    try {
      await conn.exec(sql);
    } finally {
      await conn.close();
    }
  }

  /**
   * Execute SQL with positional params via conn.exec() — bypasses prepare().
   * Use for ON CONFLICT DML that hits DuckDB 1.4.x's prepare-path binder bug.
   * Params are inlined as SQL literals using safe type serialisation:
   *   null/undefined → NULL, number/boolean → bare literal,
   *   string → single-quoted with internal quotes doubled.
   */
  async execWithParams(sql: string, params: unknown[]): Promise<void> {
    let i = 0;
    const inlined = sql.replace(/\?/g, () => {
      const v = params[i++];
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      return `'${String(v).replace(/'/g, "''")}'`;
    });
    const conn = await this.db.connect();
    try {
      await conn.exec(inlined);
    } finally {
      await conn.close();
    }
  }

  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  /**
   * Force a WAL checkpoint — flushes all WAL entries into the main .duckdb file.
   * After this call, the .wal file can be deleted without data loss.
   */
  async checkpoint(): Promise<void> {
    const conn = await this.db.connect();
    try {
      await conn.exec('CHECKPOINT');
    } finally {
      await conn.close();
    }
  }
}