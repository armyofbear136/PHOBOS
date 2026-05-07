import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { DatabaseManager } from '../db/DatabaseManager.js';

export interface WorkspaceFile {
  filename: string;      // relative path within workspace
  language: string;
  size_bytes: number;
  note: string | null;   // coordinator-written description
  last_written_by: string;
  content_hash: string;
  updated_at: string;
}

export interface WorkspaceIndex {
  threadId: string;
  workspaceDir: string;
  files: WorkspaceFile[];
  renderedAt: string;
}

/**
 * ThreadWorkspace manages the per-thread working directory on disk.
 *
 * Every thread owns a directory at:
 *   <WORKSPACES_ROOT>/<threadId>/
 *
 * The workspace is the "pool of files" for a chat — both the user and the AI
 * read and write here. The coordinator maintains notes about each file in the
 * workspace_files DB table so that the index it sends to the engine is always
 * annotated with what each file is for.
 *
 * The index is cached in memory and only regenerated when files change on disk
 * (detected via content_hash comparison). This eliminates the per-request
 * filesystem walk that was causing latency.
 */
export class ThreadWorkspace {
  private static get WORKSPACES_ROOT() { return process.env.WORKSPACES_ROOT ?? './workspaces'; }

  // In-memory cache: threadId → { index, lastScanned }
  private static cache = new Map<string, { index: WorkspaceIndex; lastScanned: number }>();
  private static CACHE_TTL_MS = 2_000; // Re-scan if >2s since last check — keeps manual edits near-instant

  private static LANGUAGE_MAP: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript',
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript',
    '.py': 'python', '.pyi': 'python',
    '.gd': 'gdscript', '.tscn': 'godot-scene', '.tres': 'godot-resource',
    '.rs': 'rust', '.go': 'go', '.rb': 'ruby', '.php': 'php',
    '.cs': 'csharp', '.java': 'java', '.cpp': 'cpp', '.c': 'c', '.h': 'c',
    '.md': 'markdown', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
    '.toml': 'toml', '.env': 'env', '.sh': 'shell', '.bash': 'shell',
    '.html': 'html', '.css': 'css', '.scss': 'scss', '.sql': 'sql',
  };

  private static IGNORE_PATTERNS = [
    'node_modules', '.git', '__pycache__', '.venv', 'venv',
    'dist', 'build', '.next', 'coverage', '.DS_Store',
    'attachments',     // user-uploaded attachments — referenced by message, not indexed in workspace
    'images',          // media files are tracked separately via addMediaFile
    'videos',          // video generation output — tracked separately via workspace-media
    'workflows',       // workflow engine cache — managed by WorkflowEngine, not workspace index
    'vision-scratch',  // temporary VisionProcessor artifacts — cleaned after each workflow run
  ];

  constructor(private db: DatabaseManager) {}

  /** Absolute path to a thread's workspace directory */
  workspaceDir(threadId: string): string {
    return path.resolve(ThreadWorkspace.WORKSPACES_ROOT, threadId);
  }

  /** Absolute path to a file within a thread's workspace */
  filePath(threadId: string, filename: string): string {
    const dir = this.workspaceDir(threadId);
    // Prevent path traversal
    const resolved = path.resolve(dir, filename);
    if (!resolved.startsWith(dir)) {
      throw new Error(`Path traversal attempt blocked: ${filename}`);
    }
    return resolved;
  }

  /**
   * Bust the in-memory cache for a thread so the next getIndex/renderIndex call
   * performs a fresh disk scan. Called at message-send time to ensure SAYON
   * always sees files the user just uploaded.
   */
  bustCache(threadId: string): void {
    ThreadWorkspace.cache.delete(threadId);
  }

  /** Ensure the workspace directory exists. Called when a thread is created. */
  async ensureWorkspace(threadId: string): Promise<string> {
    const dir = this.workspaceDir(threadId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Write a file into the workspace and update the DB index.
   * Called by PatchApplicator after applying patches.
   */
  async writeFile(
    threadId: string,
    filename: string,
    content: string,
    writtenBy: 'user' | 'engine' | 'coordinator' = 'engine'
  ): Promise<void> {
    const absPath = this.filePath(threadId, filename);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf-8');
    await this.indexFile(threadId, filename, content, writtenBy);
  }

  /**
   * Read a file from the workspace.
   * Returns null if the file does not exist.
   */
  async readFile(threadId: string, filename: string): Promise<string | null> {
    try {
      return await fs.readFile(this.filePath(threadId, filename), 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * List all files in the workspace as a flat array of relative paths.
   */
  async listFiles(threadId: string): Promise<string[]> {
    const dir = this.workspaceDir(threadId);
    try {
      return await this.walkDirectory(dir, dir);
    } catch {
      return [];
    }
  }

  /**
   * Get the cached workspace index for a thread.
   * Scans disk and refreshes DB records only when files have changed.
   * Returns a compact object ready for injection into AI context.
   */
  async getIndex(threadId: string): Promise<WorkspaceIndex> {
    const cached = ThreadWorkspace.cache.get(threadId);
    const now = Date.now();

    if (cached && now - cached.lastScanned < ThreadWorkspace.CACHE_TTL_MS) {
      return cached.index;
    }

    const dir = await this.ensureWorkspace(threadId);
    const diskFiles = await this.walkDirectory(dir, dir);

    // Sync DB records with disk reality
    await this.syncIndex(threadId, dir, diskFiles);

    // Load annotated index from DB
    // DuckDB returns BIGINT as JavaScript BigInt — coerce to Number at query boundary
    const rawFiles = await this.db.query<Record<string, unknown>>(
      `SELECT filename, language, size_bytes, note, last_written_by, content_hash, updated_at
      FROM workspace_files
      WHERE thread_id = ?
      ORDER BY updated_at DESC`,
      [threadId]
    );

    const dbFiles: WorkspaceFile[] = rawFiles.map((f) => ({
      filename:        String(f.filename ?? ''),
      language:        String(f.language ?? 'text'),
      size_bytes:      Number(f.size_bytes ?? 0),   // BigInt → Number
      note:            f.note != null ? String(f.note) : null,
      last_written_by: String(f.last_written_by ?? 'user'),
      content_hash:    String(f.content_hash ?? ''),
      updated_at:      String(f.updated_at ?? ''),
    }));
    const index: WorkspaceIndex = {
      threadId,
      workspaceDir: dir,
      files: dbFiles,
      renderedAt: new Date().toISOString(),
    };

    ThreadWorkspace.cache.set(threadId, { index, lastScanned: now });
    return index;
  }

  /**
   * Render the workspace index as a compact string for injection into AI context.
   * Format is intentionally terse — this is Layer 1 context (always present).
   *
   * Example output:
   *   # Workspace — thread abc123
   *   camera.gd  [gdscript, 2.1KB] — Free-look camera with mouse capture and velocity scaling
   *   utils.ts   [typescript, 0.8KB] — Date formatting helpers
   */
  async renderIndex(threadId: string): Promise<string> {
    const index = await this.getIndex(threadId);

    if (index.files.length === 0) {
      return '';  // Empty string — no workspace section injected at all
    }

    // Flat list — NO section header. Any header text risks the engine treating
    // it as a directory prefix (e.g. "# Chat Files" → "Chat Files/test.txt")
    return index.files
      .map((f) => {
        const sizeKb = (Number(f.size_bytes) / 1024).toFixed(1);
        const note = f.note ? ` — ${f.note}` : '';
        const writer = f.last_written_by !== 'user' ? ` [by ${f.last_written_by}]` : '';
        return `${f.filename}  [${f.language}, ${sizeKb}KB]${writer}${note}`;
      })
      .join('\n');
  }

  /**
   * Update the coordinator's note for a file.
   * The coordinator calls this after reviewing engine output to annotate
   * what each file is for, so future dispatches have context without loading
   * full file contents.
   */
  async updateFileNote(
    threadId: string,
    filename: string,
    note: string
  ): Promise<void> {
    await this.db.run(
      `UPDATE workspace_files SET note = ?, updated_at = ? WHERE thread_id = ? AND filename = ?`,
      [note, new Date().toISOString(), threadId, filename]
    );
    // Invalidate cache
    ThreadWorkspace.cache.delete(threadId);
  }

  /**
   * Update file notes for multiple files at once.
   * Called by the coordinator after a successful engine dispatch.
   */
  async updateFileNotes(
    threadId: string,
    notes: Array<{ filename: string; note: string }>
  ): Promise<void> {
    for (const { filename, note } of notes) {
      await this.updateFileNote(threadId, filename, note);
    }
  }

  /**
   * Delete a file from the workspace (disk + DB index).
   */
  async deleteFile(threadId: string, filename: string): Promise<void> {
    try {
      await fs.unlink(this.filePath(threadId, filename));
    } catch {
      // File may not exist on disk
    }
    await this.db.run(
      `DELETE FROM workspace_files WHERE thread_id = ? AND filename = ?`,
      [threadId, filename]
    );
    ThreadWorkspace.cache.delete(threadId);
  }

  /**
   * Copy files from one thread's workspace to another (for forks).
   */
  async forkWorkspace(sourceThreadId: string, targetThreadId: string): Promise<void> {
    const sourceDir = this.workspaceDir(sourceThreadId);
    const targetDir = await this.ensureWorkspace(targetThreadId);

    try {
      await fs.cp(sourceDir, targetDir, { recursive: true });
    } catch {
      // Source may be empty — that's fine
      return;
    }

    // Copy DB records
    const sourceFiles = await this.db.query<WorkspaceFile>(
      `SELECT filename, language, size_bytes, note, last_written_by, content_hash
       FROM workspace_files WHERE thread_id = ?`,
      [sourceThreadId]
    );

    for (const f of sourceFiles) {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await this.db.run(
        `INSERT OR IGNORE INTO workspace_files
           (id, thread_id, filename, language, size_bytes, note, last_written_by, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, targetThreadId, f.filename, f.language, f.size_bytes, f.note,
         f.last_written_by, f.content_hash, now, now]
      );
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Sync the DB workspace_files records with what's actually on disk.
   * Adds new files, updates changed files, removes deleted files.
   */
  private async syncIndex(
    threadId: string,
    workspaceDir: string,
    diskFiles: string[]
  ): Promise<void> {
    const existing = await this.db.query<{ filename: string; content_hash: string }>(
      `SELECT filename, content_hash FROM workspace_files WHERE thread_id = ?`,
      [threadId]
    );
    const existingMap = new Map(existing.map((r) => [r.filename, r.content_hash]));

    // Add/update files that exist on disk
    for (const filename of diskFiles) {
      const absPath = path.join(workspaceDir, filename);
      try {
        const content = await fs.readFile(absPath, 'utf-8');
        const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
        const stat = await fs.stat(absPath);
        const lang = ThreadWorkspace.LANGUAGE_MAP[path.extname(filename)] ?? 'text';

        if (existingMap.get(filename) === hash) continue; // unchanged

        const id = crypto.randomUUID();
        const now = new Date().toISOString();

        if (existingMap.has(filename)) {
          // Update existing record (preserve note, update hash/size/lang)
          await this.db.run(
            `UPDATE workspace_files
             SET content_hash = ?, size_bytes = ?, language = ?, updated_at = ?
             WHERE thread_id = ? AND filename = ?`,
            [hash, stat.size, lang, now, threadId, filename]
          );
        } else {
          // Insert new record
          await this.db.run(
            `INSERT INTO workspace_files
               (id, thread_id, filename, language, size_bytes, last_written_by, content_hash, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, threadId, filename, lang, stat.size, 'user', hash, now, now]
          );
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Remove DB records for files deleted from disk
    const diskSet = new Set(diskFiles);
    for (const filename of existingMap.keys()) {
      if (!diskSet.has(filename)) {
        await this.db.run(
          `DELETE FROM workspace_files WHERE thread_id = ? AND filename = ?`,
          [threadId, filename]
        );
      }
    }
  }

  private async indexFile(
    threadId: string,
    filename: string,
    content: string,
    writtenBy: string
  ): Promise<void> {
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
    const lang = ThreadWorkspace.LANGUAGE_MAP[path.extname(filename)] ?? 'text';
    const now = new Date().toISOString();

    const existing = await this.db.queryOne(
      `SELECT id FROM workspace_files WHERE thread_id = ? AND filename = ?`,
      [threadId, filename]
    );

    if (existing) {
      await this.db.run(
        `UPDATE workspace_files
         SET content_hash = ?, size_bytes = ?, language = ?, last_written_by = ?, updated_at = ?
         WHERE thread_id = ? AND filename = ?`,
        [hash, content.length, lang, writtenBy, now, threadId, filename]
      );
    } else {
      await this.db.run(
        `INSERT INTO workspace_files
           (id, thread_id, filename, language, size_bytes, last_written_by, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), threadId, filename, lang, content.length, writtenBy, hash, now, now]
      );
    }

    ThreadWorkspace.cache.delete(threadId);
  }

  private async walkDirectory(dir: string, root: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (ThreadWorkspace.IGNORE_PATTERNS.includes(entry.name)) continue;
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...(await this.walkDirectory(fullPath, root)));
        } else {
          results.push(path.relative(root, fullPath));
        }
      }
    } catch {
      // Ignore permission errors
    }
    return results;
  }
}
