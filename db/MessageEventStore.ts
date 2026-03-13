import { DatabaseManager } from './DatabaseManager.js';
import { randomUUID } from 'crypto';

export type PersistedEventType =
  | 'file_panel'
  | 'coordinator'
  | 'thinking_complete'
  | 'think_chunk'
  | 'output_chunk'
  | 'patches_applied'
  | 'activity'
  | 'agent_state'
  | 'image_complete';

export interface MessageEvent {
  id: string;
  thread_id: string;
  message_id: string | null;
  event_type: PersistedEventType;
  payload: string;  // JSON
  seq: number;
  created_at: string;
}

/**
 * Persists meaningful SSE events so that chat history survives browser refresh.
 *
 * Only events that affect visible UI state are stored:
 *   file_panel        — engine-produced file content (re-applyable)
 *   coordinator       — coordinator summary bubble
 *   thinking_complete — full thinking trace for a message
 *   patches_applied   — count + file list for the activity log
 *   activity          — final activity bubble event list
 *
 * Ephemeral events (status, think_token, output_token, build_result) are NOT
 * persisted — they're only meaningful during the live stream.
 */
export class MessageEventStore {
  private seqCounters = new Map<string, number>(); // messageId → seq

  constructor(private db: DatabaseManager) {}

  private nextSeq(messageId: string): number {
    const n = (this.seqCounters.get(messageId) ?? 0) + 1;
    this.seqCounters.set(messageId, n);
    return n;
  }

  async insert(
    threadId: string,
    eventType: PersistedEventType,
    payload: object,
    messageId?: string
  ): Promise<void> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const mid = messageId ?? null;
    const seq = this.nextSeq(mid ?? threadId);
    await this.db.run(
      `INSERT INTO message_events (id, thread_id, message_id, event_type, payload, seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, threadId, mid, eventType, JSON.stringify(payload), seq, now]
    );
  }

  /**
   * Returns all events for a thread in creation order.
   * The frontend replays these to reconstruct the full visible history.
   */
  async getByThread(threadId: string): Promise<MessageEvent[]> {
    return this.db.query<MessageEvent>(
      `SELECT * FROM message_events WHERE thread_id = ?
       ORDER BY created_at ASC, seq ASC`,
      [threadId]
    );
  }

  /**
   * Returns events for a specific message (e.g. to re-fetch file panels).
   */
  async getByMessage(messageId: string): Promise<MessageEvent[]> {
    return this.db.query<MessageEvent>(
      `SELECT * FROM message_events WHERE message_id = ?
       ORDER BY seq ASC`,
      [messageId]
    );
  }

  async deleteByThread(threadId: string): Promise<void> {
    await this.db.run(`DELETE FROM message_events WHERE thread_id = ?`, [threadId]);
  }

  /** Remove transient chunk records once canonical thinking_complete/output is written */
  async deleteChunksForMessage(messageId: string): Promise<void> {
    await this.db.run(
      `DELETE FROM message_events WHERE message_id = ? AND event_type IN ('think_chunk', 'output_chunk')`,
      [messageId]
    );
  }
}
