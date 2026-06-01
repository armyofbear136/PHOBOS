/**
 * db/DirectMessageStore.ts — direct message persistence against social.duckdb.
 *
 * Covers direct_messages (conversation history) and pending_dm_queue (offline
 * delivery queue). Both tables live in the same social.duckdb file as friends.
 *
 * Obtain the DatabaseManager via DatabaseManager.getSocialDb(username).
 */

import { randomUUID } from 'node:crypto';
import { DatabaseManager } from './DatabaseManager.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StoredMessage {
  message_id:      string;
  friend_uuid:     string;
  friend_username: string;
  direction:       'sent' | 'received';
  content_text:    string;
  sent_at:         number;   // unix ms
  received_at:     number;   // unix ms
  delivered:       number;   // 0 or 1
  read_at:         number | null;
}

export interface PendingDmEntry {
  queue_id:        string;
  target_uuid:     string;
  target_username: string;
  message_id:      string;
  payload:         string;   // JSON DirectMessageFrame
  created_at:      number;   // unix ms
  retry_count:     number;
  last_attempt_at: number | null;
}

// ── DirectMessageStore ────────────────────────────────────────────────────────

export class DirectMessageStore {
  constructor(private readonly db: DatabaseManager) {}

  // ── Conversation history ──────────────────────────────────────────────────

  /** Persist a message we sent. delivered starts at 0 until we get an ack. */
  async persistSent(opts: {
    message_id:      string;
    friend_uuid:     string;
    friend_username: string;
    content_text:    string;
    sent_at:         number;
  }): Promise<void> {
    await this.db.execWithParams(
      `INSERT INTO direct_messages
         (message_id, friend_uuid, friend_username,
          direction, content_text, sent_at, received_at, delivered)
       VALUES (?, ?, ?, 'sent', ?, ?, ?, 0)`,
      [
        opts.message_id,
        opts.friend_uuid,
        opts.friend_username,
        opts.content_text,
        opts.sent_at,
        Date.now(),
      ],
    );
  }

  /** Persist a message we received from a friend. */
  async persistReceived(opts: {
    message_id:      string;
    friend_uuid:     string;
    friend_username: string;
    content_text:    string;
    sent_at:         number;
    received_at:     number;
  }): Promise<void> {
    await this.db.execWithParams(
      `INSERT OR IGNORE INTO direct_messages
         (message_id, friend_uuid, friend_username,
          direction, content_text, sent_at, received_at, delivered)
       VALUES (?, ?, ?, 'received', ?, ?, ?, 1)`,
      [
        opts.message_id,
        opts.friend_uuid,
        opts.friend_username,
        opts.content_text,
        opts.sent_at,
        opts.received_at,
      ],
    );
  }

  /** Mark a sent message as delivered after receiving a DirectMessageAck. */
  async markDelivered(message_id: string): Promise<void> {
    await this.db.execWithParams(
      `UPDATE direct_messages SET delivered = 1 WHERE message_id = ?`,
      [message_id],
    );
  }

  /** Mark a received message as read. */
  async markRead(message_id: string, read_at: number): Promise<void> {
    await this.db.execWithParams(
      `UPDATE direct_messages SET read_at = ? WHERE message_id = ?`,
      [read_at, message_id],
    );
  }

  /**
   * Return up to `limit` messages in a conversation, newest first.
   * Pass `before_ts` (unix ms) to paginate backward through history.
   */
  async getConversation(
    friend_uuid:     string,
    friend_username: string,
    limit           = 50,
    before_ts?:      number,
  ): Promise<StoredMessage[]> {
    if (before_ts !== undefined) {
      return this.db.query<StoredMessage>(
        `SELECT message_id, friend_uuid, friend_username, direction,
                content_text, sent_at, received_at, delivered, read_at
         FROM direct_messages
         WHERE friend_uuid = ? AND friend_username = ? AND sent_at < ?
         ORDER BY sent_at DESC
         LIMIT ?`,
        [friend_uuid, friend_username, before_ts, limit],
      );
    }
    return this.db.query<StoredMessage>(
      `SELECT message_id, friend_uuid, friend_username, direction,
              content_text, sent_at, received_at, delivered, read_at
       FROM direct_messages
       WHERE friend_uuid = ? AND friend_username = ?
       ORDER BY sent_at DESC
       LIMIT ?`,
      [friend_uuid, friend_username, limit],
    );
  }

  /** Count unread received messages in a conversation. */
  async getUnreadCount(friend_uuid: string, friend_username: string): Promise<number> {
    const row = await this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM direct_messages
       WHERE friend_uuid = ? AND friend_username = ?
         AND direction = 'received' AND read_at IS NULL`,
      [friend_uuid, friend_username],
    );
    return row?.n ?? 0;
  }

  // ── Pending delivery queue ────────────────────────────────────────────────

  /** Enqueue an outbound message for delivery when the friend's core is next reachable. */
  async enqueuePending(opts: {
    target_uuid:     string;
    target_username: string;
    message_id:      string;
    payload:         string;
  }): Promise<void> {
    await this.db.execWithParams(
      `INSERT INTO pending_dm_queue
         (queue_id, target_uuid, target_username,
          message_id, payload, created_at, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [
        randomUUID(),
        opts.target_uuid,
        opts.target_username,
        opts.message_id,
        opts.payload,
        Date.now(),
      ],
    );
  }

  /** Return all pending entries for a given target instance. */
  async getPending(target_uuid: string): Promise<PendingDmEntry[]> {
    return this.db.query<PendingDmEntry>(
      `SELECT queue_id, target_uuid, target_username, message_id,
              payload, created_at, retry_count, last_attempt_at
       FROM pending_dm_queue
       WHERE target_uuid = ?
       ORDER BY created_at ASC`,
      [target_uuid],
    );
  }

  /** Remove a delivered or permanently-failed pending entry. */
  async removePending(queue_id: string): Promise<void> {
    await this.db.execWithParams(
      `DELETE FROM pending_dm_queue WHERE queue_id = ?`,
      [queue_id],
    );
  }

  /**
   * Increment retry_count and update last_attempt_at.
   * Entries with retry_count >= 10 after this call should be removed by the
   * caller — they are considered undeliverable and will not be retried.
   */
  async incrementRetry(queue_id: string): Promise<void> {
    await this.db.execWithParams(
      `UPDATE pending_dm_queue
       SET retry_count = retry_count + 1, last_attempt_at = ?
       WHERE queue_id = ?`,
      [Date.now(), queue_id],
    );
  }
}
