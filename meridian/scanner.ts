/**
 * meridian/scanner.ts — Library scan engine for PHOBOS Meridian.
 *
 * Walk → diff against DB → extract metadata → enqueue thumbnails.
 * Non-blocking: returns immediately, emits events, updates state in place.
 */

import fs            from 'node:fs';
import path          from 'node:path';
import crypto        from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { MeridianDB, MeridianLibrary } from './db/db.js';
import { isSupportedExt, extractMetadata, buildFileRecord } from './indexer.js';
import { ThumbQueue } from './thumbnailer.js';
import type { MeridianConfig } from './db/config.js';

// ── Scan state ─────────────────────────────────────────────────────────────────

export type ScanPhase = 'idle' | 'walking' | 'indexing' | 'thumbing' | 'done' | 'error';

export interface ScanState {
  phase:         ScanPhase;
  libraryId:     string | null;
  filesWalked:   number;
  filesIndexed:  number;
  thumbsQueued:  number;
  thumbsDone:    number;
  error:         string | null;
  startedAt:     number | null;   // unix ms
}

const IDLE_STATE: ScanState = {
  phase: 'idle', libraryId: null,
  filesWalked: 0, filesIndexed: 0,
  thumbsQueued: 0, thumbsDone: 0,
  error: null, startedAt: null,
};

// ── Scanner ───────────────────────────────────────────────────────────────────

export class Scanner extends EventEmitter {
  private state:     ScanState = { ...IDLE_STATE };
  private thumbQ:    ThumbQueue;
  private metaSem:   import('./thumbnailer.js').Semaphore | null = null;
  private activeScan: Promise<void> | null = null;

  constructor(
    private db:     MeridianDB,
    private config: MeridianConfig,
  ) {
    super();
    this.thumbQ = new ThumbQueue(2);
  }

  getState(): Readonly<ScanState> { return this.state; }

  // ── Public: trigger a full scan ────────────────────────────────────────────

  scanLibrary(lib: MeridianLibrary): void {
    // If already scanning this library, ignore
    if (this.state.phase !== 'idle' && this.state.phase !== 'done' && this.state.phase !== 'error') {
      return;
    }
    this.activeScan = this._runScan(lib).catch(err => {
      this.state.phase = 'error';
      this.state.error = (err as Error).message;
      this.emit('error', err);
      console.error('[Meridian] Scan error:', (err as Error).message);
    });
  }

  // ── Public: targeted rescan of a single path (called by watcher) ───────────

  async scanPath(filePath: string, lib: MeridianLibrary): Promise<void> {
    if (!isSupportedExt(path.extname(filePath))) return;

    const fileExists = fs.existsSync(filePath);
    const id         = this.db.fileId(filePath);

    if (!fileExists) {
      // File deleted — remove from DB
      await this.db.deleteFilesNotIn(lib.id, await this._allLibraryIds(lib.id));
      this.emit('change');
      return;
    }

    const stat  = fs.statSync(filePath);
    const mtime = stat.mtimeMs;
    const existing = await this.db.getFileMtime(id);

    if (existing && existing.mtime === mtime) return; // unchanged

    const metadata = await extractMetadata(filePath, this.config.ffmpegPath);
    const record   = buildFileRecord({
      id, filePath, mtime,
      metadata,
      userId:    this.config.userId,
      libraryId: lib.id,
    });
    await this.db.upsertFile(record);

    this.thumbQ.enqueue({
      fileId:        id,
      filePath,
      fileType:      record.type,
      takenAt:       record.takenAt,
      libraryId:     lib.id,
      thumbCacheDir: this.config.thumbCacheDir,
      ffmpegPath:    this.config.ffmpegPath,
      size:          'sm',
      onDone: async result => {
        if (result.success) await this.db.markThumbReady(id, result.destPath);
        this.emit('change');
      },
    });

    this.emit('change');
  }

  // ── Internal: full scan ────────────────────────────────────────────────────

  private async _runScan(lib: MeridianLibrary): Promise<void> {
    const { Semaphore } = await import('./thumbnailer.js');
    this.metaSem = new Semaphore(4);

    const logId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    await this.db.insertScanLog({ id: logId, libraryId: lib.id, startedAt, finishedAt: null,
      filesAdded: 0, filesRemoved: 0, filesChanged: 0, error: null });

    this.state = {
      ...IDLE_STATE,
      phase:     'walking',
      libraryId: lib.id,
      startedAt: Date.now(),
    };
    this.emit('state', this.state);

    let filesAdded   = 0;
    let filesChanged = 0;
    const seenIds: string[] = [];

    try {
      // ── Walk ──────────────────────────────────────────────────────────────
      for await (const filePath of this._walk(lib.path)) {
        seenIds.push(this.db.fileId(filePath));
        this.state.filesWalked++;
        if (this.state.filesWalked % 100 === 0) this.emit('state', this.state);
      }

      // ── Index ─────────────────────────────────────────────────────────────
      this.state.phase = 'indexing';
      this.emit('state', this.state);

      const indexTasks: Promise<void>[] = [];

      for await (const filePath of this._walk(lib.path)) {
        const id    = this.db.fileId(filePath);
        const stat  = fs.statSync(filePath);
        const mtime = stat.mtimeMs;

        const task = this.metaSem!.run(async () => {
          const existing = await this.db.getFileMtime(id);

          if (!existing) {
            // New file
            const metadata = await extractMetadata(filePath, this.config.ffmpegPath);
            const record   = buildFileRecord({ id, filePath, mtime, metadata,
              userId: this.config.userId, libraryId: lib.id });
            await this.db.upsertFile(record);
            filesAdded++;
            this._enqueueThumb(record.id, filePath, record.type, record.takenAt, lib.id);
          } else if (existing.mtime !== mtime) {
            // Changed file
            const metadata = await extractMetadata(filePath, this.config.ffmpegPath);
            const record   = buildFileRecord({ id, filePath, mtime, metadata,
              userId: this.config.userId, libraryId: lib.id });
            await this.db.upsertFile(record);
            filesChanged++;
            this._enqueueThumb(record.id, filePath, record.type, record.takenAt, lib.id);
          }
          // else: unchanged — skip

          this.state.filesIndexed++;
          if (this.state.filesIndexed % 50 === 0) this.emit('state', this.state);
        });

        indexTasks.push(task);
      }

      await Promise.all(indexTasks);

      // ── Prune deleted files ───────────────────────────────────────────────
      const filesRemoved = await this.db.deleteFilesNotIn(lib.id, seenIds);

      // ── Update library stats ──────────────────────────────────────────────
      const fileCount = seenIds.length - filesRemoved;
      await this.db.updateLibraryScanTime(lib.id, Math.max(0, fileCount));

      // ── Wait for thumbnails ───────────────────────────────────────────────
      this.state.phase       = 'thumbing';
      this.state.thumbsQueued = this.thumbQ.pending;
      this.emit('state', this.state);

      await this._waitForThumbs();

      this.state.phase = 'done';
      this.emit('state', this.state);
      this.emit('complete', { filesAdded, filesChanged, filesRemoved });

      await this.db.updateScanLog(logId, {
        finishedAt:   new Date().toISOString(),
        filesAdded, filesChanged, filesRemoved,
      });

    } catch (err) {
      this.state.phase = 'error';
      this.state.error = (err as Error).message;
      await this.db.updateScanLog(logId, {
        finishedAt: new Date().toISOString(),
        error: (err as Error).message,
      });
      throw err;
    }
  }

  // ── Async walk generator ──────────────────────────────────────────────────

  private async *_walk(dir: string): AsyncGenerator<string> {
    if (!fs.existsSync(dir)) return;
    let entries: fs.Dir;
    try { entries = await fs.promises.opendir(dir); } catch { return; }
    for await (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden directories (e.g. .Trash, .DS_Store dirs)
        if (!entry.name.startsWith('.')) yield* this._walk(full);
      } else if (entry.isFile() && isSupportedExt(path.extname(entry.name))) {
        yield full;
      }
    }
  }

  // ── Thumb queue helper ────────────────────────────────────────────────────

  private _enqueueThumb(
    fileId:   string,
    filePath: string,
    fileType: import('./db/db.js').FileType,
    takenAt:  string | null,
    libraryId: string,
  ): void {
    this.state.thumbsQueued++;
    this.thumbQ.enqueue({
      fileId, filePath, fileType, takenAt, libraryId,
      thumbCacheDir: this.config.thumbCacheDir,
      ffmpegPath:    this.config.ffmpegPath,
      size:          'sm',
      onDone: async result => {
        if (result.success) await this.db.markThumbReady(fileId, result.destPath);
        this.state.thumbsDone++;
        this.emit('state', this.state);
      },
    });
  }

  private async _waitForThumbs(): Promise<void> {
    return new Promise(resolve => {
      const check = () => {
        if (this.thumbQ.pending === 0) { resolve(); return; }
        setTimeout(check, 200);
      };
      check();
    });
  }

  private async _allLibraryIds(libraryId: string): Promise<string[]> {
    // Used to compute the set of valid ids for deletion after a file-system event
    const { files } = await this.db.listFiles({
      userId:    this.config.userId,
      libraryId,
      limit:     1_000_000,
      offset:    0,
      orderBy:   'indexed_at',
    });
    return files.map(f => f.id);
  }
}
