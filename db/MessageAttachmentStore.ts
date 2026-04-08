import fs from 'fs/promises';
import path from 'path';
import { DatabaseManager } from './DatabaseManager.js';
import { randomUUID } from 'crypto';

export interface MessageAttachment {
  id: string;
  message_id: string;
  thread_id: string;
  filename: string;
  /** Absolute path on disk — under <WORKSPACES_ROOT>/<threadId>/attachments/ */
  disk_path: string;
  mime_type: string;
  size_bytes: number;
  is_image: boolean;
  created_at: string;
}

/**
 * Stores files attached to user messages.
 *
 * Design principles:
 * - Files live at <WORKSPACES_ROOT>/<threadId>/attachments/<id>-<filename>
 *   entirely separate from the AI-editable workspace root. The AI never sees
 *   this directory in its workspace index.
 * - The DB record links file → message via message_id.
 * - Content is never stored in the DB — the disk file is the source of truth.
 * - On message reload, attachments are fetched by message_id and returned
 *   alongside the message so the frontend can render chips + open the viewer.
 *
 * Lifetime: attachments persist indefinitely with their thread. No GC.
 */
export class MessageAttachmentStore {
  private static get WORKSPACES_ROOT() {
    return process.env.WORKSPACES_ROOT ?? './workspaces';
  }

  constructor(private db: DatabaseManager) {}

  async ensureTable(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS message_attachments (
        id          VARCHAR PRIMARY KEY,
        message_id  VARCHAR NOT NULL,
        thread_id   VARCHAR NOT NULL,
        filename    VARCHAR NOT NULL,
        disk_path   VARCHAR NOT NULL,
        mime_type   VARCHAR NOT NULL DEFAULT 'application/octet-stream',
        size_bytes  BIGINT  NOT NULL DEFAULT 0,
        is_image    BOOLEAN NOT NULL DEFAULT false,
        created_at  TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
    await this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_msg_attachments_message
        ON message_attachments(message_id)
    `);
    await this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_msg_attachments_thread
        ON message_attachments(thread_id)
    `);
  }

  /** Attachment directory for a thread — never inside the AI workspace root */
  private attachmentDir(threadId: string): string {
    return path.resolve(MessageAttachmentStore.WORKSPACES_ROOT, threadId, 'attachments');
  }

  /**
   * Save a file to disk and record it in the DB.
   * message_id may be empty string if the message hasn't been inserted yet;
   * call linkToMessage() immediately after the message is created.
   *
   * For image attachments, `content` must be a base64-encoded string — the frontend
   * sends images as base64 so they survive the JSON transport. The store detects
   * is_image and decodes to binary before writing. Text files are written as UTF-8.
   */
  async save(
    threadId: string,
    filename: string,
    content: Buffer | string,
    mimeType: string,
    messageId: string
  ): Promise<MessageAttachment> {
    const id = randomUUID();
    const dir = this.attachmentDir(threadId);
    await fs.mkdir(dir, { recursive: true });

    // Prefix with ID to avoid filename collisions across messages
    const safeName = filename.replace(/[^a-zA-Z0-9._\-]/g, '_');
    const diskPath = path.join(dir, `${id}-${safeName}`);

    const isImage = mimeType.startsWith('image/') ||
      /\.(png|jpg|jpeg|gif|webp|bmp|svg|tiff?|avif)$/i.test(filename);

    let buf: Buffer;
    if (typeof content === 'string') {
      // Images arrive as base64 from the frontend — decode to binary.
      // Text files arrive as UTF-8 plain string.
      buf = isImage ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf-8');
    } else {
      buf = content;
    }
    await fs.writeFile(diskPath, buf);

    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO message_attachments
         (id, message_id, thread_id, filename, disk_path, mime_type, size_bytes, is_image, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, messageId, threadId, filename, diskPath, mimeType, buf.length, isImage, now]
    );

    return { id, message_id: messageId, thread_id: threadId, filename, disk_path: diskPath,
             mime_type: mimeType, size_bytes: buf.length, is_image: isImage, created_at: now };
  }

  /** Read file content from disk */
  async readContent(attachment: MessageAttachment): Promise<string> {
    const buf = await fs.readFile(attachment.disk_path);
    return buf.toString('utf-8');
  }

  /** Get all attachments for a message */
  async getByMessage(messageId: string): Promise<MessageAttachment[]> {
    return this.db.query<MessageAttachment>(
      `SELECT * FROM message_attachments WHERE message_id = ? ORDER BY created_at ASC`,
      [messageId]
    );
  }

  /** Get all attachments for a thread (for bulk reload) */
  async getByThread(threadId: string): Promise<MessageAttachment[]> {
    return this.db.query<MessageAttachment>(
      `SELECT * FROM message_attachments WHERE thread_id = ? ORDER BY created_at ASC`,
      [threadId]
    );
  }

  /** Get a single attachment by ID */
  async getById(id: string): Promise<MessageAttachment | null> {
    return this.db.queryOne<MessageAttachment>(
      `SELECT * FROM message_attachments WHERE id = ?`,
      [id]
    );
  }
}
