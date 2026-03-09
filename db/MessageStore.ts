import { DatabaseManager } from './DatabaseManager.js';
import { randomUUID } from 'crypto';
import type { ChatSummaryStore } from './ChatSummaryStore.js';

export interface Message {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant' | 'coordinator' | 'status';
  content: string;
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
  thinking_trace?: string | null;
  dispatch_id?: string | null;
  attempt_number?: number | null;
  review_score?: number | null;
}

export class MessageStore {
  constructor(private db: DatabaseManager) {}

  async getByThread(
    threadId: string,
    includeThinking = false
  ): Promise<Message[]> {
    const cols = includeThinking
      ? '*'
      : 'id, thread_id, role, content, NULL as thinking_trace, dispatch_id, attempt_number, review_score, created_at';
    return this.db.query<Message>(
      `SELECT ${cols} FROM messages WHERE thread_id = ? ORDER BY created_at ASC`,
      [threadId]
    );
  }

  async insert(input: CreateMessageInput): Promise<Message> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO messages
         (id, thread_id, role, content, thinking_trace, dispatch_id, attempt_number, review_score, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.thread_id,
        input.role,
        input.content,
        input.thinking_trace ?? null,
        input.dispatch_id ?? null,
        input.attempt_number ?? null,
        input.review_score ?? null,
        now,
      ]
    );
    return (await this.getById(id))!;
  }

  async update(id: string, fields: { content?: string; thinking_trace?: string | null }): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (fields.content !== undefined)        { sets.push('content = ?');        vals.push(fields.content); }
    if (fields.thinking_trace !== undefined) { sets.push('thinking_trace = ?'); vals.push(fields.thinking_trace); }
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
   * Returns context history for an AI dispatch.
   *
   * Strategy: summary-first hybrid
   *   1. Load the rolling chat summary if one exists.
   *   2. Take up to MAX_RECENT_MESSAGES from the tail of the raw history.
   *   3. Fit as many recent messages as possible within the char budget
   *      (leaves room for the summary + the current user message + system prompt).
   *   4. If a summary exists, prepend it as a synthetic user/assistant pair
   *      so the model sees structured prior context without blowing the window.
   *
   * Budget: coordinator context window * 4 chars/token * 0.35 safety factor,
   * capped so the summary + messages never take more than ~35% of total context.
   */
  async getContextHistory(
    threadId: string,
    summaryStore?: ChatSummaryStore,
    maxRecent?: number
  ): Promise<Array<{ role: string; content: string }>> {
    const MAX_RECENT = maxRecent != null ? Math.max(1, Math.min(20, maxRecent)) : 6;
    const CHAR_BUDGET = 24_000; // ~6k tokens at 4 chars/token, safe for any supported model

    const messages = await this.getByThread(threadId, false);
    const rawHistory = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }));

    // Take the tail, then trim to char budget
    const recent = rawHistory.slice(-MAX_RECENT);
    const fitted: Array<{ role: string; content: string }> = [];
    let used = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      const len = recent[i].content.length;
      if (used + len > CHAR_BUDGET) break;
      fitted.unshift(recent[i]);
      used += len;
    }

    // Prepend summary if available
    if (summaryStore) {
      const saved = await summaryStore.get(threadId);
      if (saved?.summary) {
        return [
          { role: 'user',      content: '<conversation_summary>' },
          { role: 'assistant', content: saved.summary + '\n</conversation_summary>' },
          ...fitted,
        ];
      }
    }

    return fitted;
  }

  async updateScore(id: string, score: number): Promise<void> {
    await this.db.run(
      `UPDATE messages SET review_score = ? WHERE id = ?`,
      [score, id]
    );
  }
}
