import Database from 'duckdb-async';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ── Resolve bundled DuckDB extension directory ─────────────────────────────────
// DuckDB looks for extensions at: {extension_directory}/v{version}/{platform}/
// We bundle vss.duckdb_extension in phobos/extensions/ staged alongside the exe.
function resolveBundledExtensionDir(): string | null {
  const seaDir = path.dirname(process.execPath);

  const candidates = [
    path.join(seaDir,        'phobos', 'extensions'),  // compiled SEA: exe sits in dist/
    path.join(process.cwd(), 'dist', 'phobos', 'extensions'),  // tsx from repo root
    path.join(process.cwd(), 'phobos', 'extensions'),          // tsx from dist/
  ];

  // In the CJS bundle __dirname is defined by esbuild and points to the bundle
  // output directory — same as seaDir, already covered above. In tsx (ESM) it
  // is undefined, so we fall through to the process.cwd() candidates which
  // correctly resolve to dist/phobos/extensions when run from the repo root.
  if (typeof __dirname !== 'undefined') {
    const repoRoot = path.resolve(__dirname, '..', '..');
    candidates.splice(1, 0,
      path.join(repoRoot, 'dist', 'phobos', 'extensions'),
      path.join(repoRoot, 'phobos', 'extensions'),
    );
  }

  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

export const BUNDLED_EXTENSION_DIR = resolveBundledExtensionDir();

// ── Active user resolution ─────────────────────────────────────────────────────
//
// Priority order:
//   1. PHOBOS_ACTIVE_USER env var (dev/test override)
//   2. ~/.phobos/active-user.json written by POST /api/admin/switch-user
//   3. Hard default: 'owner'
//
// The JSON file is written atomically (tmp → rename) by the switch-user route.
// readFileSync is used because getActiveUser() is called at module evaluation
// time (e.g. WORKSPACES_ROOT constants in server.ts). Async is not possible
// at that point. This is not a hot path.

export const DEFAULT_USERNAME = 'owner';

const ACTIVE_USER_FILE = path.join(
  process.env.PHOBOS_DATA_DIR ?? path.join(os.homedir(), '.phobos'),
  'active-user.json',
);
const ACTIVE_USER_TMP = ACTIVE_USER_FILE + '.tmp';

export function getActiveUser(): string {
  if (process.env.PHOBOS_ACTIVE_USER) return process.env.PHOBOS_ACTIVE_USER;
  try {
    const raw    = fs.readFileSync(ACTIVE_USER_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { username?: unknown };
    if (typeof parsed.username === 'string' && parsed.username.length > 0) {
      return parsed.username;
    }
  } catch {
    // File absent or malformed — fall through to default.
  }
  return DEFAULT_USERNAME;
}

/** Write the active user atomically. Called by POST /api/admin/switch-user. */
export function writeActiveUser(username: string): void {
  fs.mkdirSync(path.dirname(ACTIVE_USER_FILE), { recursive: true });
  fs.writeFileSync(ACTIVE_USER_TMP, JSON.stringify({ username }, null, 2), 'utf8');
  fs.renameSync(ACTIVE_USER_TMP, ACTIVE_USER_FILE);
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

export function socialDbPath(username: string): string {
  return path.join(userDir(username), 'social.duckdb');
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

-- Access codes for guest and self-remote access.
-- Issued per system user; validated by WebRTC handler before session open.
-- target_username is NULL for unbound codes — a guest user is provisioned on
-- first connect and the column is backfilled.
CREATE TABLE IF NOT EXISTS access_codes (
  code              VARCHAR PRIMARY KEY,
  issuing_username  VARCHAR NOT NULL,
  target_username   VARCHAR,
  code_type         VARCHAR NOT NULL DEFAULT 'guest'
                    CHECK (code_type IN ('guest', 'self')),
  single_use        BOOLEAN NOT NULL DEFAULT true,
  consumed          BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  expires_at        TIMESTAMP NOT NULL
);

-- Permanent instance identity and configuration.
-- Known keys:
--   instance_id   — UUID v4, generated on first boot
--   public_key    — hex ed25519 public key
--   private_key   — hex ed25519 private key (never transmitted)
--   relay_enabled — 'true' | 'false', default true
--   core_name     — user-assigned display name for this instance
CREATE TABLE IF NOT EXISTS instance_config (
  key    VARCHAR PRIMARY KEY,
  value  VARCHAR NOT NULL
);

-- Device tokens issued to registered mobile clients.
-- All three of (token, device_id, username) must match on reconnect.
CREATE TABLE IF NOT EXISTS device_tokens (
  token       VARCHAR PRIMARY KEY,
  username    VARCHAR NOT NULL,
  device_id   VARCHAR NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT now(),
  last_used   TIMESTAMP NOT NULL DEFAULT now()
);

-- Hashed credentials for guest users. bcryptjs cost 12.
-- Verified as second factor alongside device_token on guest reconnect.
CREATE TABLE IF NOT EXISTS guest_credentials (
  username      VARCHAR PRIMARY KEY,
  password_hash VARCHAR NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT now(),
  updated_at    TIMESTAMP NOT NULL DEFAULT now()
);

-- Known remote PHOBOS instances. A Phobos ID (instance_uuid + relay_address)
-- must be present here before any connection from that instance is accepted.
-- This is the security boundary for all social features — unknown instances
-- are rejected in DataChannelHandler before any session is opened.
-- label is a user-assigned nickname, set before or after friending.
-- friended=true once the full friend handshake completes.
CREATE TABLE IF NOT EXISTS known_instances (
  instance_uuid   VARCHAR PRIMARY KEY,
  relay_address   VARCHAR NOT NULL,
  label           VARCHAR,
  friended        BOOLEAN NOT NULL DEFAULT false,
  added_at        BIGINT NOT NULL
);

-- Inbound friend requests received from known instances while the user's
-- UI was not present to respond interactively. The requesting core retries
-- delivery on a timer; this table holds the latest request per sender so
-- the UI can surface it on next open.
-- status: 'pending' -> 'accepted' | 'declined'
-- responded_at is set when the user acts; the requesting core is notified
-- via a FriendRequestAck relay message and the row is deleted after ack.
CREATE TABLE IF NOT EXISTS pending_friend_requests (
  id                VARCHAR PRIMARY KEY,
  from_instance_id  VARCHAR NOT NULL UNIQUE,
  from_username     VARCHAR NOT NULL,
  from_display_name VARCHAR NOT NULL,
  received_at       BIGINT NOT NULL,
  expires_at        BIGINT NOT NULL,
  status            VARCHAR NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'declined')),
  responded_at      BIGINT
);

-- Outbound friend requests sent to known instances, persisted for retry until
-- the target acks or TTL expires. One row per target instance — re-sending
-- overwrites the previous entry so the target always sees the freshest request.
-- retry_count is incremented by SignalingClient on each send attempt.
CREATE TABLE IF NOT EXISTS pending_outbound_requests (
  id               VARCHAR PRIMARY KEY,
  to_instance_id   VARCHAR NOT NULL UNIQUE,
  payload          TEXT NOT NULL,
  sent_at          BIGINT NOT NULL,
  expires_at       BIGINT NOT NULL,
  retry_count      INTEGER NOT NULL DEFAULT 0,
  last_attempt_at  BIGINT
);

-- WeClone activation state — one row per hardware slot.
-- clone_id / username are NULL when no clone is active on that slot.
-- holding_snapshot is a JSON-serialised ServerSnapshot captured at activation
-- time so deactivation can restore the exact previous model + config.
-- Non-empty holding_snapshot is the authoritative flag that a clone is active.
CREATE TABLE IF NOT EXISTS weclone_active_slots (
  slot              VARCHAR PRIMARY KEY CHECK (slot IN ('sayon','seren')),
  clone_id          VARCHAR,
  username          VARCHAR,
  holding_snapshot  TEXT
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

-- Per-user credentials for external services (Jellyfin, Kavita, etc.).
-- Replaces the system-wide media_services.settings approach for per-user accounts.
-- Populated by provisionSystemUser() when a new system user is created.
CREATE TABLE IF NOT EXISTS user_service_tokens (
  service     VARCHAR NOT NULL,
  key         VARCHAR NOT NULL,
  value       TEXT    NOT NULL,
  updated_at  TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (service, key)
);

-- Social graph: friends of this user.
-- Friends are identities in the communications layer only — no local provisioning.
-- instance_url is their PHOBOS relay address for future peer connections.
CREATE TABLE IF NOT EXISTS user_friends (
  id            VARCHAR PRIMARY KEY,
  friend_handle VARCHAR NOT NULL,
  display_name  VARCHAR NOT NULL,
  instance_url  VARCHAR,
  status        VARCHAR NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'active', 'blocked')),
  added_at      TIMESTAMP NOT NULL DEFAULT now()
);

-- Vault configuration: file path, lock timeout, and open timestamps.
-- Per-user so each user has their own .kdbx file at their own path.
-- No secrets, no passwords, no key material ever touch this table.
CREATE TABLE IF NOT EXISTS vault_config (
  key   VARCHAR PRIMARY KEY,
  value VARCHAR
);

-- Owner self-description — the "# YOU ARE TALKING TO" context injected into
-- clone sessions and copilot context when clone mode is active.
CREATE TABLE IF NOT EXISTS user_profiles (
  id                 VARCHAR PRIMARY KEY,
  display_name       VARCHAR NOT NULL DEFAULT '',
  age                VARCHAR NOT NULL DEFAULT '',
  gender             VARCHAR NOT NULL DEFAULT '',
  pronouns           VARCHAR NOT NULL DEFAULT '',
  appearance         TEXT    NOT NULL DEFAULT '',
  personality        TEXT    NOT NULL DEFAULT '',
  background         TEXT    NOT NULL DEFAULT '',
  interests          TEXT    NOT NULL DEFAULT '',
  dislikes           TEXT    NOT NULL DEFAULT '',
  hobbies            TEXT    NOT NULL DEFAULT '',
  goals              TEXT    NOT NULL DEFAULT '',
  fears              TEXT    NOT NULL DEFAULT '',
  values             TEXT    NOT NULL DEFAULT '',
  speech_style       TEXT    NOT NULL DEFAULT '',
  humor_style        VARCHAR NOT NULL DEFAULT '',
  expertise          TEXT    NOT NULL DEFAULT '',
  relationship_style TEXT    NOT NULL DEFAULT '',
  love_language      VARCHAR NOT NULL DEFAULT '',
  dealbreakers       TEXT    NOT NULL DEFAULT '',
  updated_at         TIMESTAMP NOT NULL DEFAULT now()
);

-- Sync devices and policies: per-user so each user's mobile devices
-- sync only to their own Meridian library.
CREATE TABLE IF NOT EXISTS phobos_sync_devices (
  device_id     VARCHAR PRIMARY KEY,
  device_name   VARCHAR NOT NULL,
  platform      VARCHAR NOT NULL DEFAULT 'unknown',
  sync_token    VARCHAR NOT NULL UNIQUE,
  user_id       VARCHAR NOT NULL DEFAULT 'owner',
  registered_at TIMESTAMP NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMP
);

CREATE TABLE IF NOT EXISTS phobos_sync_policies (
  id          VARCHAR PRIMARY KEY,
  device_id   VARCHAR NOT NULL REFERENCES phobos_sync_devices(device_id),
  library     VARCHAR NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  retain_days INTEGER          DEFAULT NULL,
  upload_mode VARCHAR NOT NULL DEFAULT 'wifi_only'
              CHECK (upload_mode IN ('wifi_only', 'always', 'manual')),
  updated_at  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS phobos_sync_exclusions (
  id        VARCHAR PRIMARY KEY,
  policy_id VARCHAR NOT NULL REFERENCES phobos_sync_policies(id),
  path      VARCHAR NOT NULL,
  scope     VARCHAR NOT NULL DEFAULT 'subtree'
            CHECK (scope IN ('subtree', 'exact'))
);

CREATE INDEX IF NOT EXISTS idx_sync_exclusions_policy
  ON phobos_sync_exclusions (policy_id);

CREATE TABLE IF NOT EXISTS phobos_sync_manifest (
  content_hash  VARCHAR NOT NULL,
  device_id     VARCHAR NOT NULL,
  library       VARCHAR NOT NULL,
  orig_filename VARCHAR NOT NULL,
  dest_path     VARCHAR NOT NULL,
  file_size     BIGINT,
  taken_at      TIMESTAMP WITH TIME ZONE,
  synced_at     TIMESTAMP WITH TIME ZONE DEFAULT now(),
  PRIMARY KEY (content_hash, device_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_manifest_device
  ON phobos_sync_manifest (device_id);
CREATE INDEX IF NOT EXISTS idx_sync_manifest_taken
  ON phobos_sync_manifest (taken_at);
`;

// ── SOCIAL_SCHEMA ─────────────────────────────────────────────────────────────
//
// Tables that live in ~/.phobos/users/{username}/social.duckdb.
// Separated from phobos.duckdb so the social graph can be exported, wiped,
// or migrated independently of chat and workspace data.
//
// Opened via DatabaseManager.getSocialDb(username). Created on first call.

export const SOCIAL_SCHEMA = `
-- Confirmed friends. Composite PK prevents duplicates for the same remote user
-- even if they share a PHOBOS instance with others.
-- public_key is stored for Phase 2 post signing; Phase 1 exchanges it but
-- does not yet verify signatures on incoming data.
CREATE TABLE IF NOT EXISTS friends (
  instance_uuid   TEXT NOT NULL,
  username        TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  public_key      TEXT NOT NULL,
  relay_address   TEXT NOT NULL,
  avatar_token    TEXT,
  connected_at    BIGINT NOT NULL,
  last_seen_at    BIGINT,
  notes           TEXT,
  PRIMARY KEY (instance_uuid, username)
);

-- Direct messages — sent and received — for all friend conversations.
-- direction='sent'     means we originated this message.
-- direction='received' means it arrived from a friend's core.
-- sent_at is unix-ms set by the sender; received_at is when we persisted locally.
-- delivered=1 for sent messages means we received a DirectMessageAck from peer.
-- read_at is populated for received messages when the user opens the conversation.
CREATE TABLE IF NOT EXISTS direct_messages (
  message_id      TEXT PRIMARY KEY,
  friend_uuid     TEXT NOT NULL,
  friend_username TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('sent', 'received')),
  content_text    TEXT NOT NULL,
  sent_at         BIGINT NOT NULL,
  received_at     BIGINT NOT NULL,
  delivered       INTEGER NOT NULL DEFAULT 0,
  read_at         BIGINT
);

CREATE INDEX IF NOT EXISTS idx_dm_conversation
  ON direct_messages (friend_uuid, friend_username, sent_at DESC);

-- Outbound messages that could not be delivered because the friend's core was
-- unreachable. Delivered on next successful connection.
-- retry_count is capped at 10 by the caller; stale entries are pruned silently.
-- payload is the full JSON DirectMessageFrame, ready to re-send without rebuilding.
CREATE TABLE IF NOT EXISTS pending_dm_queue (
  queue_id        TEXT PRIMARY KEY,
  target_uuid     TEXT NOT NULL,
  target_username TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  payload         TEXT NOT NULL,
  created_at      BIGINT NOT NULL,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  last_attempt_at BIGINT
);
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

type Kind = 'system' | 'user' | 'social';

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
   * Close and evict a user's DB instance from the singleton cache.
   * Must be called before deleting the user's filesystem directory so DuckDB
   * releases its file handle and WAL before the rmSync.
   * Safe to call even if the user never had an open connection.
   */
  static async evictUser(username: string): Promise<void> {
    const resolvedPath = userDbPath(username);
    const key = `user:${username}:${resolvedPath}`;
    const inst = DatabaseManager.instances.get(key);
    if (inst) {
      DatabaseManager.instances.delete(key);
      try {
        await inst.close();
      } catch {
        // Already closed or never opened — safe to ignore.
      }
    }
  }

  /**
   * Social-scoped DatabaseManager for ~/.phobos/users/{username}/social.duckdb.
   * Singleton per user — created on first call with SOCIAL_SCHEMA applied.
   * Always pass an explicit username; never falls back to getActiveUser() to
   * prevent cross-user data contamination.
   */
  static async getSocialDb(username: string): Promise<DatabaseManager> {
    const resolvedPath = socialDbPath(username);
    const key = `social:${username}:${resolvedPath}`;
    const existing = DatabaseManager.instances.get(key);
    if (existing) return existing;

    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    const inst = new DatabaseManager('social', resolvedPath);
    // Register before initialize() so concurrent callers do not create a second instance.
    DatabaseManager.instances.set(key, inst);
    try {
      await inst.initialize();
    } catch (err) {
      DatabaseManager.instances.delete(key);
      throw err;
    }
    return inst;
  }

  /**
   * Close and evict a user's social DB from the singleton cache.
   * Call before deleting the user's directory so DuckDB releases the file
   * handle before rmSync. Safe to call if social DB was never opened.
   */
  static async evictSocialDb(username: string): Promise<void> {
    const resolvedPath = socialDbPath(username);
    const key = `social:${username}:${resolvedPath}`;
    const inst = DatabaseManager.instances.get(key);
    if (inst) {
      DatabaseManager.instances.delete(key);
      try {
        await inst.close();
      } catch {
        // Already closed or never opened — safe to ignore.
      }
    }
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

  private _initPromise: Promise<void> | null = null;

  /** Idempotent: calls initialize() once and caches the promise so concurrent
   *  callers all await the same initialization. Safe to call from any store's
   *  ensureTable() — no-op if already initialized. */
  async ensureReady(): Promise<void> {
    if (this.db) return; // already initialized
    if (!this._initPromise) this._initPromise = this.initialize();
    return this._initPromise;
  }

  async initialize(): Promise<void> {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    const dbConfig = BUNDLED_EXTENSION_DIR
      ? { extension_directory: BUNDLED_EXTENSION_DIR }
      : {};

    this.db = await Database.Database.create(this.dbPath, dbConfig as any);
    const schema = this.kind === 'system' ? SYSTEM_SCHEMA
                 : this.kind === 'user'   ? USER_SCHEMA
                 : SOCIAL_SCHEMA;
    await this.db.exec(schema);
    if (this.kind === 'system') {
      // Seed the two permanent weclone slot rows.  INSERT OR IGNORE so existing
      // rows (with live clone_id / holding_snapshot) are never overwritten.
      await this.db.exec(`
        INSERT OR IGNORE INTO weclone_active_slots (slot, clone_id, username, holding_snapshot)
          VALUES ('sayon', NULL, NULL, NULL);
        INSERT OR IGNORE INTO weclone_active_slots (slot, clone_id, username, holding_snapshot)
          VALUES ('seren', NULL, NULL, NULL);
      `);
    }
    if (this.kind === 'user') {
      await this.migrateDocuments();
      await this.ensureDistilledColumn();
      await this.migrateSyncPoliciesRetainDays();
      await this.migrateSyncDevicesUserId();
      await this.migrateSyncManifest();
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

  /** Drop NOT NULL from phobos_sync_policies.retain_days so NULL means "keep forever".
   *  Safe to run on any DB version — DuckDB throws if the constraint is already gone,
   *  and we catch that silently. Non-fatal either way. */
  private async migrateSyncPoliciesRetainDays(): Promise<void> {
    try {
      await this.db!.exec(
        `ALTER TABLE phobos_sync_policies ALTER COLUMN retain_days DROP NOT NULL`,
      );
    } catch {
      // Either the table doesn't exist yet (fresh install — schema will create it
      // correctly) or the constraint is already gone. Both are fine.
    }
  }

  /** Add user_id to phobos_sync_devices if missing. */
  private async migrateSyncDevicesUserId(): Promise<void> {
    try {
      await this.db!.exec(
        `ALTER TABLE phobos_sync_devices ADD COLUMN IF NOT EXISTS user_id VARCHAR NOT NULL DEFAULT 'owner'`,
      );
    } catch { /* already exists or table not yet created */ }
  }

  /** Fix phobos_sync_manifest: rename columns and correct the PRIMARY KEY.
   *  The old schema had a single-column PK (content_hash) and wrong column names.
   *  Because DuckDB cannot ALTER a PRIMARY KEY, we drop and recreate the table
   *  when the old schema is detected. Any existing rows are lost — acceptable
   *  since test data is stale and re-upload is the recovery path. */
  private async migrateSyncManifest(): Promise<void> {
    try {
      // Detect old schema by checking for the original_name column.
      const cols = await this.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'phobos_sync_manifest' AND column_name = 'original_name'`,
      );
      if (cols && cols.length > 0) {
        // Old schema detected — drop and let CREATE TABLE IF NOT EXISTS rebuild it.
        await this.db!.exec(`DROP TABLE IF EXISTS phobos_sync_manifest`);
        await this.db!.exec(`
          CREATE TABLE IF NOT EXISTS phobos_sync_manifest (
            content_hash  VARCHAR NOT NULL,
            device_id     VARCHAR NOT NULL,
            library       VARCHAR NOT NULL,
            orig_filename VARCHAR NOT NULL,
            dest_path     VARCHAR NOT NULL,
            file_size     BIGINT,
            taken_at      TIMESTAMP WITH TIME ZONE,
            synced_at     TIMESTAMP WITH TIME ZONE DEFAULT now(),
            PRIMARY KEY (content_hash, device_id)
          )
        `);
        await this.db!.exec(`
          CREATE INDEX IF NOT EXISTS idx_sync_manifest_device ON phobos_sync_manifest (device_id)
        `);
        await this.db!.exec(`
          CREATE INDEX IF NOT EXISTS idx_sync_manifest_taken ON phobos_sync_manifest (taken_at)
        `);
        console.log('[DB] Migrated phobos_sync_manifest to corrected schema.');
      }
    } catch (err) {
      console.warn('[DB] migrateSyncManifest skipped (non-fatal):', err);
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
    this.checkpointSoon();
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
    this.checkpointSoon();
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
  private _checkpointTimer: ReturnType<typeof setTimeout> | null = null;

  /** Debounced checkpoint — flushes WAL to disk 1 second after the last write.
   *  Ensures data survives process exit even if the periodic timer hasn't fired.
   *  Multiple rapid writes coalesce into a single checkpoint. */
  private checkpointSoon(): void {
    if (this._checkpointTimer) clearTimeout(this._checkpointTimer);
    this._checkpointTimer = setTimeout(() => {
      this._checkpointTimer = null;
      this.checkpoint().catch((err: unknown) =>
        console.warn('[DB] Post-write checkpoint failed (non-fatal):', err),
      );
    }, 1000);
  }

  async checkpoint(): Promise<void> {
    const conn = await this.db.connect();
    try {
      await conn.exec('CHECKPOINT');
    } finally {
      await conn.close();
    }
  }
}