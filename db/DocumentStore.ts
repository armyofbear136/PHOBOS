import { DatabaseManager } from './DatabaseManager.js';
import { randomUUID } from 'crypto';

export type DocType = 'claude_md' | 'project_md' | 'chat_md' | 'phobos_directives';

export interface Document {
  id: string;
  doc_type: DocType;
  project_id: string | null;
  content: string;
  version: number;
  created_at: string;
}

export class DocumentStore {
  constructor(private db: DatabaseManager) {}

  /** Get the latest version of a document */
  async getLatest(
    docType: DocType,
    projectId?: string | null
  ): Promise<Document | null> {
    if (projectId) {
      return this.db.queryOne<Document>(
        `SELECT * FROM documents WHERE doc_type = ? AND project_id = ?
         ORDER BY version DESC LIMIT 1`,
        [docType, projectId]
      );
    }
    return this.db.queryOne<Document>(
      `SELECT * FROM documents WHERE doc_type = ? AND project_id IS NULL
       ORDER BY version DESC LIMIT 1`,
      [docType]
    );
  }

  /** Write a new version (always appends, never mutates) */
  async write(
    docType: DocType,
    content: string,
    projectId?: string | null
  ): Promise<Document> {
    const current = await this.getLatest(docType, projectId);
    const nextVersion = (current?.version ?? 0) + 1;
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO documents (id, doc_type, project_id, content, version, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, docType, projectId ?? null, content, nextVersion, now]
    );
    return (await this.db.queryOne<Document>(
      `SELECT * FROM documents WHERE id = ?`,
      [id]
    ))!;
  }

  /** Get full version history */
  async getHistory(
    docType: DocType,
    projectId?: string | null
  ): Promise<Document[]> {
    if (projectId) {
      return this.db.query<Document>(
        `SELECT * FROM documents WHERE doc_type = ? AND project_id = ?
         ORDER BY version DESC`,
        [docType, projectId]
      );
    }
    return this.db.query<Document>(
      `SELECT * FROM documents WHERE doc_type = ? AND project_id IS NULL
       ORDER BY version DESC`,
      [docType]
    );
  }

  /**
   * Load the three-layer context bundle for a given project/chat.
   * Priority: chat.md > project.md > claude.md
   */
  async loadContextBundle(
    projectId?: string | null,
    chatThreadId?: string | null
  ): Promise<{ claudeMd: string; projectMd: string; chatMd: string }> {
    const claudeDoc = await this.getLatest('claude_md');
    const projectDoc = projectId
      ? await this.getLatest('project_md', projectId)
      : null;
    const chatDoc = chatThreadId
      ? await this.getLatest('chat_md', chatThreadId)
      : null;

    return {
      claudeMd: claudeDoc?.content ?? '',
      projectMd: projectDoc?.content ?? '',
      chatMd: chatDoc?.content ?? '',
    };
  }
}
