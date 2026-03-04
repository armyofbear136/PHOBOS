import Database from 'duckdb-async';
import path from 'path';
import fs from 'fs';

const SCHEMA = `
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
  id             VARCHAR PRIMARY KEY,
  thread_id      VARCHAR NOT NULL REFERENCES threads(id),
  role           VARCHAR NOT NULL CHECK (role IN ('user','assistant','coordinator','status')),
  content        TEXT NOT NULL,
  thinking_trace TEXT,
  dispatch_id    VARCHAR,
  attempt_number INTEGER,
  review_score   DOUBLE,
  created_at     TIMESTAMP NOT NULL DEFAULT now()
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
  doc_type   VARCHAR NOT NULL CHECK (doc_type IN ('claude_md','project_md','chat_md')),
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

-- Dispatch log (instrumentation)
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

-- Message events: persists every meaningful SSE event so history survives refresh.
-- Replayed in order on thread load to reconstruct file panels, coordinator bubbles,
-- activity logs, and thinking traces exactly as they appeared during the stream.
CREATE TABLE IF NOT EXISTS message_events (
  id           VARCHAR PRIMARY KEY,
  thread_id    VARCHAR NOT NULL REFERENCES threads(id),
  message_id   VARCHAR,              -- links to the assistant message this event belongs to
  event_type   VARCHAR NOT NULL,     -- 'file_panel' | 'coordinator' | 'thinking_complete' | 'patches_applied' | 'activity'
  payload      TEXT NOT NULL,        -- JSON blob of the full event
  seq          INTEGER NOT NULL DEFAULT 0,  -- ordering within a message
  created_at   TIMESTAMP NOT NULL DEFAULT now()
);

-- Chat summaries: rolling coordinator-generated summary per thread.
-- Updated after every completed turn. Used as primary conversation memory
-- so the coordinator doesn't need to re-read the full message history.
CREATE TABLE IF NOT EXISTS chat_summaries (
  id                      VARCHAR PRIMARY KEY,
  thread_id               VARCHAR NOT NULL REFERENCES threads(id),
  summary                 TEXT NOT NULL,
  message_count_at_update INTEGER NOT NULL DEFAULT 0,
  updated_at              TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (thread_id)
);

-- Model config: persisted endpoint + model selections.
-- Keyed by role ('coordinator' | 'engine'). Values are JSON blobs.
CREATE TABLE IF NOT EXISTS model_config (
  key        VARCHAR PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Workspace files: per-thread file index with AI-maintained notes
-- Each thread has its own working directory on disk (workspaces/<thread_id>/)
-- This table is the coordinator's index of what is in that directory.
CREATE TABLE IF NOT EXISTS workspace_files (
  id           VARCHAR PRIMARY KEY,
  thread_id    VARCHAR NOT NULL REFERENCES threads(id),
  filename     VARCHAR NOT NULL,    -- relative path within the workspace dir
  language     VARCHAR,             -- detected language/type (ts, py, gd, md, etc.)
  size_bytes   BIGINT NOT NULL DEFAULT 0,
  note         TEXT,                -- coordinator-written description of what this file is
  last_written_by VARCHAR,          -- 'user' | 'engine' | 'coordinator'
  content_hash VARCHAR,             -- sha256 of content for change detection
  created_at   TIMESTAMP NOT NULL DEFAULT now(),
  updated_at   TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE (thread_id, filename)
);

-- Seed default documents if none exist.
-- claude.md is intentionally language-agnostic — the user sets their own standards.
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

export class DatabaseManager {
  private static instance: DatabaseManager | null = null;
  private db!: Database.Database;
  private dbPath: string;

  private constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  static getInstance(dbPath = './localai.duckdb'): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager(dbPath);
    }
    return DatabaseManager.instance;
  }

  async initialize(): Promise<void> {
    this.db = await Database.Database.create(this.dbPath);
    await this.db.exec(SCHEMA);
    console.log(`[DB] Initialized at ${this.dbPath}`);
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
}
