import { DatabaseManager } from './DatabaseManager.js';
import { randomUUID } from 'crypto';

export interface ChatSummary {
  id: string;
  thread_id: string;
  summary: string;
  message_count_at_update: number;
  updated_at: string;
}

export class ChatSummaryStore {
  constructor(private db: DatabaseManager) {}

  async get(threadId: string): Promise<ChatSummary | null> {
    return this.db.queryOne<ChatSummary>(
      `SELECT * FROM chat_summaries WHERE thread_id = ?`,
      [threadId]
    );
  }

  /**
   * Upsert: insert on first call, update in place on all subsequent.
   * DuckDB does not support ON CONFLICT UPDATE with RETURNING, so we do
   * a delete + insert which is safe because there's a UNIQUE (thread_id).
   */
  async upsert(threadId: string, summary: string, messageCount: number): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.get(threadId);
    if (existing) {
      await this.db.run(
        `UPDATE chat_summaries
         SET summary = ?, message_count_at_update = ?, updated_at = ?
         WHERE thread_id = ?`,
        [summary, messageCount, now, threadId]
      );
    } else {
      await this.db.run(
        `INSERT INTO chat_summaries (id, thread_id, summary, message_count_at_update, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [randomUUID(), threadId, summary, messageCount, now]
      );
    }
  }

  async delete(threadId: string): Promise<void> {
    await this.db.run(`DELETE FROM chat_summaries WHERE thread_id = ?`, [threadId]);
  }
}
