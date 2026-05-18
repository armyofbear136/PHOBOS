import { DatabaseManager } from './DatabaseManager.js';
import { randomUUID } from 'crypto';
import type { ChatSummaryStore } from './ChatSummaryStore.js';

export interface Message {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant' | 'coordinator' | 'status';
  content: string;
  distilled_content: string | null;  // stripped prose; null until backfilled
  thinking_trace: string | null;
  dispatch_id: string | null;
  attempt_number: number | null;
  review_score: number | null;
  created_at: string;
}

export interface CreateMessageInput {
  thread_id: string;
  role: Message['role'];
  content: string;
  distilled_content?: string | null;
  thinking_trace?: string | null;
  dispatch_id?: string | null;
  attempt_number?: number | null;
  review_score?: number | null;
}

/**
 * Result of getContextHistory.
 * ctxMessageCount is the number of full distilled prior-turn pairs that fit —
 * sent back to the client as a ctx_computed SSE event so the CTX pill
 * always reflects what actually made it into the window.
 */
export interface ContextHistoryResult {
  history: Array<{ role: string; content: string }>;
  /** Number of complete user→assistant pairs that fit the context budget */
  ctxMessageCount: number;
}

export class MessageStore {
  constructor(private db: DatabaseManager) {}

  /**
   * Ensure the distilled_content column exists on an existing messages table.
   * Called once at startup — safe to call multiple times.
   */
  async ensureDistilledColumn(): Promise<void> {
    try {
      await this.db.run(
        `ALTER TABLE messages ADD COLUMN IF NOT EXISTS distilled_content TEXT`
      );
    } catch {
      // Older DuckDB without IF NOT EXISTS — verify existence before re-throwing.
      try {
        await this.db.run(`SELECT distilled_content FROM messages LIMIT 0`);
      } catch {
        await this.db.run(`ALTER TABLE messages ADD COLUMN distilled_content TEXT`);
      }
    }
  }

  async getByThread(
    threadId: string,
    includeThinking = false
  ): Promise<Message[]> {
    const cols = includeThinking
      ? '*'
      : 'id, thread_id, role, content, distilled_content, NULL as thinking_trace, dispatch_id, attempt_number, review_score, created_at';
    return this.db.query<Message>(
      `SELECT ${cols} FROM messages WHERE thread_id = ? ORDER BY created_at ASC`,
      [threadId]
    );
  }

  /**
   * Fetch the most recent `limit` messages in a thread, optionally paging
   * backward via `beforeCreatedAt` (exclusive — the created_at of the oldest
   * message the caller already has). Returns messages in chronological order.
   */
  async getRecentByThread(
    threadId: string,
    limit: number,
    beforeCreatedAt?: string,
  ): Promise<Message[]> {
    const cols = 'id, thread_id, role, content, distilled_content, NULL as thinking_trace, dispatch_id, attempt_number, review_score, created_at';
    let rows: Message[];
    if (beforeCreatedAt) {
      rows = await this.db.query<Message>(
        `SELECT ${cols} FROM messages
         WHERE thread_id = ? AND created_at < ?
         ORDER BY created_at DESC LIMIT ?`,
        [threadId, beforeCreatedAt, limit],
      );
    } else {
      rows = await this.db.query<Message>(
        `SELECT ${cols} FROM messages
         WHERE thread_id = ?
         ORDER BY created_at DESC LIMIT ?`,
        [threadId, limit],
      );
    }
    // Return in chronological order so callers don't need to reverse.
    return rows.reverse();
  }

  async insert(input: CreateMessageInput): Promise<Message> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO messages
         (id, thread_id, role, content, distilled_content, thinking_trace, dispatch_id, attempt_number, review_score, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.thread_id,
        input.role,
        input.content,
        input.distilled_content ?? null,
        input.thinking_trace ?? null,
        input.dispatch_id ?? null,
        input.attempt_number ?? null,
        input.review_score ?? null,
        now,
      ]
    );
    return (await this.getById(id))!;
  }

  async update(id: string, fields: {
    content?: string;
    distilled_content?: string | null;
    thinking_trace?: string | null;
  }): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (fields.content !== undefined)           { sets.push('content = ?');           vals.push(fields.content); }
    if (fields.distilled_content !== undefined) { sets.push('distilled_content = ?'); vals.push(fields.distilled_content); }
    if (fields.thinking_trace !== undefined)    { sets.push('thinking_trace = ?');    vals.push(fields.thinking_trace); }
    if (sets.length === 0) return;
    vals.push(id);
    await this.db.run(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`, vals);
  }

  async getById(id: string): Promise<Message | null> {
    return this.db.queryOne<Message>(
      `SELECT * FROM messages WHERE id = ?`,
      [id]
    );
  }

  /**
   * Returns context history for an AI dispatch, plus the AUTO-computed
   * message count so the frontend CTX display stays accurate.
   *
   * AUTO mode (maxRecent absent):
   *   - Packs as many full distilled pairs as fit CHAR_BUDGET, up to AUTO_MAX.
   *   - ctxMessageCount tells the client how many pairs made it in.
   *
   * Manual override (maxRecent set by user):
   *   - Behaves as before — takes up to maxRecent, trims to budget.
   *   - ctxMessageCount still reflects actual fitted count.
   *
   * Assistant rows use distilled_content when available, falling back to
   * content for rows predating this column. User rows use content as-is
   * (already clean — attachment blobs are never persisted there).
   *
   * CHAR_BUDGET = 35% of 32k-token context at 4 chars/token, leaving
   * headroom for system prompt + current message + file context + RAG block.
   */
  async getContextHistory(
    threadId: string,
    summaryStore?: ChatSummaryStore,
    maxRecent?: number
  ): Promise<ContextHistoryResult> {
    const AUTO_MAX   = 20;
    const CHAR_BUDGET = 24_000;

    const messages = await this.getByThread(threadId, false);

    const rawHistory = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role:    m.role as string,
        // User content is already clean; assistant uses distilled when present
        content: m.role === 'assistant'
          ? (m.distilled_content ?? m.content)
          : m.content,
      }));

    const candidateMax = maxRecent != null
      ? Math.max(1, Math.min(20, maxRecent))
      : AUTO_MAX;

    const recent = rawHistory.slice(-candidateMax);

    // Walk backward fitting messages into the char budget
    const fitted: Array<{ role: string; content: string }> = [];
    let used = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      const len = recent[i].content.length;
      if (used + len > CHAR_BUDGET) break;
      fitted.unshift(recent[i]);
      used += len;
    }

    // Count full pairs (user turns) that fit — drives CTX pill display
    const ctxMessageCount = fitted.filter(m => m.role === 'user').length;

    if (summaryStore) {
      const saved = await summaryStore.get(threadId);
      if (saved?.summary) {
        return {
          history: [
            { role: 'user',      content: '<conversation_summary>' },
            { role: 'assistant', content: saved.summary + '\n</conversation_summary>' },
            ...fitted,
          ],
          ctxMessageCount,
        };
      }
    }

    return { history: fitted, ctxMessageCount };
  }

  async updateScore(id: string, score: number): Promise<void> {
    await this.db.run(
      `UPDATE messages SET review_score = ? WHERE id = ?`,
      [score, id]
    );
  }
}