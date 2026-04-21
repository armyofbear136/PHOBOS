// ── ConversationStore ──────────────────────────────────────────────────────────
//
// Persistent VSS index over PHOBOS conversation history.
//
// Lives at ~/.phobos/conversations.duckdb — completely separate from the user's
// archive vault (~/.phobos/archive/*.duckdb). No ArchiveStore domain taxonomy,
// no ArchiveIntentClassifier routing. The only callers are:
//   - ConversationRAGClient (thread-scoped semantic search)
//   - Copilot "investigate conversation / investigate system" branch
//
// Schema:
//   conversation_turns        — one row per completed AI turn (distilled exchange)
//   conversation_turn_files   — file paths produced by a turn, linked by turn_id
//
// One DB instance held open for process lifetime (same pattern as ArchiveStore
// domain cache). All callers open/close connections; the file handle stays open.

import Database from 'duckdb-async';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { BUNDLED_EXTENSION_DIR } from './DatabaseManager.js';

// ── Constants ─────────────────────────────────────────────────────────────────

// Respect PHOBOS_DATA_DIR if set (dev mode uses project root, production uses ~/.phobos).
// Must be computed lazily so the env var set by server.ts at startup is visible.
function resolveConversationDbPath(): string {
  const dataDir = process.env.PHOBOS_DATA_DIR ?? path.join(os.homedir(), '.phobos');
  return path.join(dataDir, 'conversations.duckdb');
}

export const CONVERSATION_DB_PATH = resolveConversationDbPath();

const EMBED_DIM = 768;

// ── Schema ────────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_turns (
  id            VARCHAR   PRIMARY KEY,
  thread_id     VARCHAR   NOT NULL,
  message_id    VARCHAR   NOT NULL UNIQUE,  -- FK to messages.id (logical, not enforced)
  user_text     TEXT      NOT NULL,          -- user's typed words only, no attachments
  assistant_text TEXT     NOT NULL,          -- stripped AI response (no code blocks, no XML)
  embedding     FLOAT[${EMBED_DIM}] NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conv_turns_thread
  ON conversation_turns(thread_id);

CREATE TABLE IF NOT EXISTS conversation_turn_files (
  id        VARCHAR   PRIMARY KEY,
  turn_id   VARCHAR   NOT NULL,  -- FK to conversation_turns.id
  thread_id VARCHAR   NOT NULL,
  file_path VARCHAR   NOT NULL,  -- workspace-relative path
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conv_files_turn
  ON conversation_turn_files(turn_id);

CREATE INDEX IF NOT EXISTS idx_conv_files_thread
  ON conversation_turn_files(thread_id);
`;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConversationTurn {
  id:             string;
  threadId:       string;
  messageId:      string;
  userText:       string;
  assistantText:  string;
  score?:         number;  // populated by search results
  createdAt:      string;
}

export interface ConversationTurnFile {
  id:       string;
  turnId:   string;
  threadId: string;
  filePath: string;
}

export interface ConversationSearchResult extends ConversationTurn {
  score:     number;
  files:     string[];  // workspace-relative paths linked to this turn
}

// ── DB singleton ──────────────────────────────────────────────────────────────

let _db: Database.Database | null = null;
let _ftsAvailable = false;

async function getDb(): Promise<{ db: Database.Database; ftsAvailable: boolean }> {
  if (_db) return { db: _db, ftsAvailable: _ftsAvailable };

  const dir = path.dirname(CONVERSATION_DB_PATH);
  fs.mkdirSync(dir, { recursive: true });

  const dbConfig = BUNDLED_EXTENSION_DIR
    ? { extension_directory: BUNDLED_EXTENSION_DIR }
    : {};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _db = await Database.Database.create(CONVERSATION_DB_PATH, dbConfig as any);

  const conn = await _db.connect();
  try {
    if (BUNDLED_EXTENSION_DIR) {
      const escaped = BUNDLED_EXTENSION_DIR.replace(/\\/g, '/');
      await conn.exec(`SET extension_directory='${escaped}'`);
    }
    await conn.exec(`LOAD vss`);
    try {
      await conn.exec(`LOAD fts`);
      _ftsAvailable = true;
    } catch {
      // FTS unavailable — semantic search only
    }
    await conn.exec(SCHEMA);
  } finally {
    await conn.close();
  }

  return { db: _db, ftsAvailable: _ftsAvailable };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Write a completed turn into the conversation index.
 * Called after the assistant message is persisted in routes/messages.ts.
 * Non-blocking — caller should fire-and-forget with .catch().
 *
 * @param threadId     Thread this turn belongs to
 * @param messageId    The assistant message's DB id
 * @param userText     Clean user typed text (no attachment blobs)
 * @param assistantText Distilled AI response (code blocks and XML stripped)
 * @param embedding    768-dim vector from SYBIL over the combined exchange
 * @param filePaths    Workspace-relative paths of files produced this turn
 */
export async function writeTurn(
  threadId: string,
  messageId: string,
  userText: string,
  assistantText: string,
  embedding: number[],
  filePaths: string[] = [],
): Promise<void> {
  const { db } = await getDb();
  const turnId = randomUUID();
  const now = new Date().toISOString();

  const conn = await db.connect();
  try {
    const vec = `[${embedding.join(',')}]`;
    await conn.run(
      `INSERT INTO conversation_turns
         (id, thread_id, message_id, user_text, assistant_text, embedding, created_at)
       VALUES (?, ?, ?, ?, ?, ${vec}::FLOAT[${EMBED_DIM}], ?)`,
      [turnId, threadId, messageId, userText, assistantText, now],
    );

    for (const filePath of filePaths) {
      await conn.run(
        `INSERT INTO conversation_turn_files (id, turn_id, thread_id, file_path, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [randomUUID(), turnId, threadId, filePath, now],
      );
    }
  } finally {
    await conn.close();
  }
}

/**
 * Semantic + FTS search over a single thread's conversation history.
 * Returns top-k turns with their linked file paths, sorted by score descending.
 */
export async function searchThread(
  threadId: string,
  queryVec: number[],
  queryText: string,
  k = 6,
  minScore = 0.55,
): Promise<ConversationSearchResult[]> {
  const { db, ftsAvailable } = await getDb();
  const vec = `[${queryVec.join(',')}]`;

  const conn = await db.connect();
  try {
    // Semantic search within thread
    const semanticRows = await conn.all(
      `SELECT id, thread_id, message_id, user_text, assistant_text, created_at,
              array_cosine_similarity(embedding, ${vec}::FLOAT[${EMBED_DIM}]) AS score
         FROM conversation_turns
        WHERE thread_id = ?
          AND array_cosine_similarity(embedding, ${vec}::FLOAT[${EMBED_DIM}]) >= ?
        ORDER BY score DESC
        LIMIT ?`,
      [threadId, minScore, k * 2],
    ) as Array<Record<string, unknown>>;

    // FTS within thread when available
    const ftsIds = new Set<string>();
    if (ftsAvailable && queryText.trim().length > 0) {
      try {
        const ftsRows = await conn.all(
          `SELECT id FROM conversation_turns
            WHERE thread_id = ?
              AND (user_text ILIKE ? OR assistant_text ILIKE ?)
            LIMIT ?`,
          [threadId, `%${queryText}%`, `%${queryText}%`, k],
        ) as Array<{ id: string }>;
        for (const r of ftsRows) ftsIds.add(r.id);
      } catch { /* FTS failed mid-run, proceed semantic-only */ }
    }

    // Merge: FTS hit adds a small bonus
    const FTS_BONUS = 0.05;
    const merged = new Map<string, ConversationSearchResult>();
    for (const r of semanticRows) {
      const bonus = ftsIds.has(r.id as string) ? FTS_BONUS : 0;
      merged.set(r.id as string, {
        id:            r.id as string,
        threadId:      r.thread_id as string,
        messageId:     r.message_id as string,
        userText:      r.user_text as string,
        assistantText: r.assistant_text as string,
        score:         (r.score as number) + bonus,
        createdAt:     r.created_at as string,
        files:         [],
      });
    }
    // FTS-only hits at base score
    for (const ftsId of ftsIds) {
      if (!merged.has(ftsId)) {
        const row = semanticRows.find(r => r.id === ftsId);
        if (row) {
          merged.set(ftsId, {
            id:            row.id as string,
            threadId:      row.thread_id as string,
            messageId:     row.message_id as string,
            userText:      row.user_text as string,
            assistantText: row.assistant_text as string,
            score:         FTS_BONUS,
            createdAt:     row.created_at as string,
            files:         [],
          });
        }
      }
    }

    const sorted = Array.from(merged.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    if (sorted.length === 0) return [];

    // Attach file paths for each result turn
    const turnIds = sorted.map(r => `'${r.id}'`).join(',');
    const fileRows = await conn.all(
      `SELECT turn_id, file_path FROM conversation_turn_files
        WHERE turn_id IN (${turnIds})
        ORDER BY created_at ASC`,
    ) as Array<{ turn_id: string; file_path: string }>;

    for (const f of fileRows) {
      const turn = merged.get(f.turn_id);
      if (turn) turn.files.push(f.file_path);
    }

    return sorted;
  } finally {
    await conn.close();
  }
}

/**
 * Cross-thread search — used by the copilot "investigate system" branch only.
 * Searches all threads, returns top-k results with thread context.
 */
export async function searchAllThreads(
  queryVec: number[],
  queryText: string,
  k = 10,
  minScore = 0.60,
): Promise<ConversationSearchResult[]> {
  const { db } = await getDb();
  const vec = `[${queryVec.join(',')}]`;

  const conn = await db.connect();
  try {
    const rows = await conn.all(
      `SELECT id, thread_id, message_id, user_text, assistant_text, created_at,
              array_cosine_similarity(embedding, ${vec}::FLOAT[${EMBED_DIM}]) AS score
         FROM conversation_turns
        WHERE array_cosine_similarity(embedding, ${vec}::FLOAT[${EMBED_DIM}]) >= ?
        ORDER BY score DESC
        LIMIT ?`,
      [minScore, k * 2],
    ) as Array<Record<string, unknown>>;

    const results: ConversationSearchResult[] = rows
      .slice(0, k)
      .map(r => ({
        id:            r.id as string,
        threadId:      r.thread_id as string,
        messageId:     r.message_id as string,
        userText:      r.user_text as string,
        assistantText: r.assistant_text as string,
        score:         r.score as number,
        createdAt:     r.created_at as string,
        files:         [],
      }));

    if (results.length === 0) return [];

    const turnIds = results.map(r => `'${r.id}'`).join(',');
    const fileRows = await conn.all(
      `SELECT turn_id, file_path FROM conversation_turn_files
        WHERE turn_id IN (${turnIds})`,
    ) as Array<{ turn_id: string; file_path: string }>;

    const filesByTurn = new Map<string, string[]>();
    for (const f of fileRows) {
      const arr = filesByTurn.get(f.turn_id) ?? [];
      arr.push(f.file_path);
      filesByTurn.set(f.turn_id, arr);
    }
    for (const r of results) r.files = filesByTurn.get(r.id) ?? [];

    return results;
  } finally {
    await conn.close();
  }
}

/**
 * Delete all turns for a thread — used when a thread is deleted.
 */
export async function deleteThread(threadId: string): Promise<void> {
  const { db } = await getDb();
  const conn = await db.connect();
  try {
    // Delete files first (no FK cascade in DuckDB)
    await conn.run(
      `DELETE FROM conversation_turn_files WHERE thread_id = ?`,
      [threadId],
    );
    await conn.run(
      `DELETE FROM conversation_turns WHERE thread_id = ?`,
      [threadId],
    );
  } finally {
    await conn.close();
  }
}

/**
 * Returns true when any conversation turns exist.
 * Used to gate SYBIL startup requirement checks.
 */
export function hasAnyContent(): boolean {
  return _db !== null;
}
