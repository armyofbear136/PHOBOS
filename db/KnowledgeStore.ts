import { randomUUID } from 'crypto';
import type { DatabaseManager } from './DatabaseManager.js';

export interface KnowledgeEntry {
  id: string;
  query: string;
  content: string;
  source_url: string | null;
  created_at: string;
}

export class KnowledgeStore {
  constructor(private db: DatabaseManager) {}

  /**
   * Search knowledge entries by substring match on the query field.
   * Results are ordered by recency (newest first).
   */
  async search(query: string, limit = 5): Promise<KnowledgeEntry[]> {
    return this.db.query<KnowledgeEntry>(
      `SELECT id, query, content, source_url, created_at
       FROM knowledge_base
       WHERE LOWER(query) LIKE LOWER(?)
       ORDER BY created_at DESC
       LIMIT ?`,
      [`%${query}%`, limit]
    );
  }

  /**
   * Insert or update a knowledge entry. Matches on query field —
   * if a row with the same query already exists it is replaced.
   */
  async upsert(entry: Omit<KnowledgeEntry, 'id' | 'created_at'>): Promise<void> {
    // DuckDB has no ON CONFLICT UPDATE, so delete-then-insert.
    await this.db.run(
      `DELETE FROM knowledge_base WHERE LOWER(query) = LOWER(?)`,
      [entry.query]
    );
    await this.db.run(
      `INSERT INTO knowledge_base (id, query, content, source_url, created_at)
       VALUES (?, ?, ?, ?, now())`,
      [randomUUID(), entry.query, entry.content, entry.source_url ?? null]
    );
  }

  /**
   * Delete entries older than olderThanDays (default 30).
   * Returns the number of rows deleted.
   */
  async prune(olderThanDays = 30): Promise<number> {
    const before = await this.db.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM knowledge_base
       WHERE created_at < now() - INTERVAL (?) DAY`,
      [olderThanDays]
    );
    const count = before[0]?.count ?? 0;
    if (count > 0) {
      await this.db.run(
        `DELETE FROM knowledge_base
         WHERE created_at < now() - INTERVAL (?) DAY`,
        [olderThanDays]
      );
    }
    return count;
  }
}
