import { DatabaseManager } from './DatabaseManager.js';
import { randomUUID } from 'crypto';

/**
 * thinking_segments table schema (appended to DatabaseManager.ts SCHEMA string):
 *
 *   CREATE TABLE IF NOT EXISTS thinking_segments (
 *     id           VARCHAR PRIMARY KEY,
 *     thread_id    VARCHAR NOT NULL,
 *     message_id   VARCHAR NOT NULL,
 *     phase        VARCHAR NOT NULL,   -- 'coordinator' | 'engine'
 *     content      TEXT    NOT NULL DEFAULT '',
 *     token_count  INTEGER NOT NULL DEFAULT 0,
 *     seq          INTEGER NOT NULL,   -- order within the message
 *     started_at   VARCHAR NOT NULL,   -- ISO timestamp
 *     completed_at VARCHAR,            -- NULL while streaming
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_thinking_segments_thread
 *     ON thinking_segments(thread_id, started_at ASC);
 *   CREATE INDEX IF NOT EXISTS idx_thinking_segments_message
 *     ON thinking_segments(message_id, seq ASC);
 */

export interface ThinkingSegment {
  id: string;
  thread_id: string;
  message_id: string;
  phase: 'coordinator' | 'engine';
  content: string;
  token_count: number;
  seq: number;
  started_at: string;
  completed_at: string | null;
}

/** Front-end wire shape — matches ThinkingSegment interface in ThinkingPanel */
export interface ThinkingSegmentView {
  id: string;
  phase: 'coordinator' | 'engine';
  content: string;
  tokenCount: number;
  startedAt: string;
  completedAt: string | null;
  live: boolean;  // true when completed_at is null (segment still being written); false once closed
}

export class ThinkingSegmentStore {
  // Per-message seq counters — reset between requests
  private seqCounters = new Map<string, number>();

  constructor(private db: DatabaseManager) {}

  private nextSeq(messageId: string): number {
    const n = (this.seqCounters.get(messageId) ?? 0) + 1;
    this.seqCounters.set(messageId, n);
    return n;
  }

  /**
   * Open a new segment for streaming. Returns the segment ID.
   * Call this at the start of each coordinator or engine thinking phase.
   */
  async openSegment(
    threadId: string,
    messageId: string,
    phase: 'coordinator' | 'engine',
  ): Promise<string> {
    const id  = randomUUID();
    const seq = this.nextSeq(messageId);
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO thinking_segments
         (id, thread_id, message_id, phase, content, token_count, seq, started_at, completed_at)
       VALUES (?, ?, ?, ?, '', 0, ?, ?, NULL)`,
      [id, threadId, messageId, phase, seq, now]
    );
    return id;
  }

  /**
   * Append a token to an open segment.
   * Called on every think_token — writes directly to DB so no data is lost on crash.
   * token_count is incremented by 1 per call (caller passes raw token string).
   */
  async appendToken(segmentId: string, token: string): Promise<void> {
    await this.db.run(
      `UPDATE thinking_segments
       SET content     = content || ?,
           token_count = token_count + 1
       WHERE id = ?`,
      [token, segmentId]
    );
  }

  /**
   * Mark a segment complete. Sets completed_at to now.
   * Call this when the phase ends (thinking_complete event or phase boundary).
   */
  async closeSegment(segmentId: string): Promise<void> {
    await this.db.run(
      `UPDATE thinking_segments SET completed_at = ? WHERE id = ?`,
      [new Date().toISOString(), segmentId]
    );
  }

  /**
   * Returns all segments for a thread, ordered by started_at then seq.
   * Used by the /api/threads/:id/thinking endpoint.
   */
  async getByThread(threadId: string): Promise<ThinkingSegmentView[]> {
    const rows = await this.db.query<ThinkingSegment>(
      `SELECT * FROM thinking_segments
       WHERE thread_id = ?
       ORDER BY started_at ASC, seq ASC`,
      [threadId]
    );
    return rows.map(r => ({
      id:           r.id,
      phase:        r.phase,
      content:      r.content,
      tokenCount:   r.token_count,
      startedAt:    r.started_at,
      completedAt:  r.completed_at,
      live:         r.completed_at === null,
    }));
  }

  /**
   * Returns all segments for a specific message.
   */
  async getByMessage(messageId: string): Promise<ThinkingSegmentView[]> {
    const rows = await this.db.query<ThinkingSegment>(
      `SELECT * FROM thinking_segments
       WHERE message_id = ?
       ORDER BY seq ASC`,
      [messageId]
    );
    return rows.map(r => ({
      id:           r.id,
      phase:        r.phase,
      content:      r.content,
      tokenCount:   r.token_count,
      startedAt:    r.started_at,
      completedAt:  r.completed_at,
      live:         r.completed_at === null,
    }));
  }

  /** Delete all segments for a thread (used when deleting a thread). */
  async deleteByThread(threadId: string): Promise<void> {
    await this.db.run(
      `DELETE FROM thinking_segments WHERE thread_id = ?`,
      [threadId]
    );
  }

  /**
   * Close the most recent open segment for a given message + phase.
   * Used by LoopController which doesn't carry segment IDs across callbacks.
   */
  async closeLatestSegment(messageId: string, phase: 'coordinator' | 'engine'): Promise<void> {
    const row = await this.db.queryOne<{ id: string }>(
      `SELECT id FROM thinking_segments
       WHERE message_id = ? AND phase = ? AND completed_at IS NULL
       ORDER BY seq DESC LIMIT 1`,
      [messageId, phase]
    );
    if (!row) return;
    await this.db.run(
      `UPDATE thinking_segments SET completed_at = ? WHERE id = ?`,
      [new Date().toISOString(), row.id]
    );
  }
}
