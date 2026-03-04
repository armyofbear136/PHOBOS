import fs from 'fs/promises';
import path from 'path';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { ThreadWorkspace } from './ThreadWorkspace.js';

export interface ThreadSummary {
  threadId: string;
  title: string;
  projectId: string | null;
  fileCount: number;
  files: Array<{
    filename: string;
    language: string;
    note: string | null;
    size_bytes: number;
    updated_at: string;
  }>;
}

export interface CopilotSearchResult {
  threadId: string;
  threadTitle: string;
  filename: string;
  language: string;
  note: string | null;
  matchContext?: string; // snippet around the match if content search was done
}

/**
 * CopilotIndex provides the Copilot panel with cross-workspace awareness.
 *
 * The Copilot can:
 * - See all thread workspaces and their file indexes
 * - Read any file from any workspace
 * - Search across all workspace file notes and contents
 * - Get a summary of all threads grouped by project
 *
 * This is intentionally read-only for the Copilot — it observes, summarizes,
 * and guides. It does not write to workspaces directly.
 */
export class CopilotIndex {
  private workspace: ThreadWorkspace;

  constructor(private db: DatabaseManager) {
    this.workspace = new ThreadWorkspace(db);
  }

  /**
   * Get a summary of all threads with their workspace file indexes.
   * Used to give the Copilot a bird's-eye view of the whole system.
   * Grouped by project_id.
   */
  async getAllThreadSummaries(): Promise<ThreadSummary[]> {
    const threads = await this.db.query<{
      id: string;
      title: string;
      project_id: string | null;
    }>(
      `SELECT id, title, project_id FROM threads
       WHERE id != 'copilot-global'
       ORDER BY updated_at DESC`
    );

    const summaries: ThreadSummary[] = [];

    for (const thread of threads) {
      const files = await this.db.query<{
        filename: string;
        language: string;
        note: string | null;
        size_bytes: number;
        updated_at: string;
      }>(
        `SELECT filename, language, note, size_bytes, updated_at
         FROM workspace_files
         WHERE thread_id = ?
         ORDER BY updated_at DESC`,
        [thread.id]
      );

      summaries.push({
        threadId: thread.id,
        title: thread.title,
        projectId: thread.project_id,
        fileCount: files.length,
        files,
      });
    }

    return summaries;
  }

  /**
   * Read the full content of a specific file from any thread's workspace.
   * Returns null if the file doesn't exist.
   */
  async readFile(threadId: string, filename: string): Promise<string | null> {
    return this.workspace.readFile(threadId, filename);
  }

  /**
   * Search across all workspace file notes for a keyword.
   * Fast — only scans the DB, no disk I/O.
   */
  async searchNotes(query: string): Promise<CopilotSearchResult[]> {
    const lowerQuery = query.toLowerCase();

    const rows = await this.db.query<{
      thread_id: string;
      thread_title: string;
      filename: string;
      language: string;
      note: string | null;
    }>(
      `SELECT wf.thread_id, t.title as thread_title, wf.filename, wf.language, wf.note
       FROM workspace_files wf
       JOIN threads t ON t.id = wf.thread_id
       WHERE lower(wf.note) LIKE ? OR lower(wf.filename) LIKE ?
       ORDER BY wf.updated_at DESC
       LIMIT 20`,
      [`%${lowerQuery}%`, `%${lowerQuery}%`]
    );

    return rows.map((r) => ({
      threadId: r.thread_id,
      threadTitle: r.thread_title,
      filename: r.filename,
      language: r.language,
      note: r.note,
    }));
  }

  /**
   * Search file contents across all workspaces for a keyword.
   * Slower — reads files from disk. Capped at 10 results.
   */
  async searchContents(query: string): Promise<CopilotSearchResult[]> {
    const allFiles = await this.db.query<{
      thread_id: string;
      thread_title: string;
      filename: string;
      language: string;
      note: string | null;
    }>(
      `SELECT wf.thread_id, t.title as thread_title, wf.filename, wf.language, wf.note
       FROM workspace_files wf
       JOIN threads t ON t.id = wf.thread_id
       ORDER BY wf.updated_at DESC`
    );

    const results: CopilotSearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    for (const f of allFiles) {
      if (results.length >= 10) break;
      const content = await this.readFile(f.thread_id, f.filename);
      if (!content) continue;
      const idx = content.toLowerCase().indexOf(lowerQuery);
      if (idx === -1) continue;

      const start = Math.max(0, idx - 60);
      const end = Math.min(content.length, idx + query.length + 60);
      const matchContext = (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');

      results.push({
        threadId: f.thread_id,
        threadTitle: f.thread_title,
        filename: f.filename,
        language: f.language,
        note: f.note,
        matchContext,
      });
    }

    return results;
  }

  /**
   * Render a compact overview of all workspaces for injection into
   * the Copilot's system prompt. Gives it awareness of the whole system
   * without loading every file's content.
   */
  async renderSystemOverview(): Promise<string> {
    const summaries = await this.getAllThreadSummaries();

    if (summaries.length === 0) {
      return '# System Overview\nNo active threads yet.\n';
    }

    // Group by project
    const byProject = new Map<string, ThreadSummary[]>();
    for (const s of summaries) {
      const key = s.projectId ?? '(no project)';
      if (!byProject.has(key)) byProject.set(key, []);
      byProject.get(key)!.push(s);
    }

    const lines = ['# System Overview\n'];

    for (const [project, threads] of byProject) {
      lines.push(`## ${project}`);
      for (const thread of threads) {
        lines.push(`  Thread: ${thread.title} (${thread.threadId.slice(0, 8)}…)`);
        if (thread.files.length === 0) {
          lines.push('    (no files)');
        } else {
          for (const f of thread.files.slice(0, 10)) {
            const note = f.note ? ` — ${f.note}` : '';
            lines.push(`    ${f.filename} [${f.language}]${note}`);
          }
          if (thread.files.length > 10) {
            lines.push(`    … and ${thread.files.length - 10} more files`);
          }
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}
