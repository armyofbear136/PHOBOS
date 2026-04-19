/**
 * meridian/thumbnailer.ts — Thumbnail generation pipeline for PHOBOS Meridian.
 *
 * Generates JPEG thumbnails in four sizes from photos, RAW files, and videos.
 * All variants are stored under thumbCacheDir/{libraryId}/{YYYY}/{MM}/{fileId}-{size}.jpg
 *
 * Size contracts (permanent — encoded in cache paths and API URLs):
 *   xs  120×120 crop   JPEG Q70   grid dense
 *   sm  320×320 fit    JPEG Q75   grid default (generated during scan)
 *   md  800×600 fit    JPEG Q80   lightbox preview (on demand)
 *   lg  1920×1440 fit  JPEG Q85   full screen (on demand)
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import type { FileType } from './db/db.js';

// ── Size definitions ──────────────────────────────────────────────────────────

export type ThumbSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZES: Record<ThumbSize, { w: number; h: number; quality: number; fit: 'cover' | 'inside' }> = {
  xs: { w: 120,  h: 120,  quality: 70, fit: 'cover'  },
  sm: { w: 320,  h: 320,  quality: 75, fit: 'inside' },
  md: { w: 800,  h: 600,  quality: 80, fit: 'inside' },
  lg: { w: 1920, h: 1440, quality: 85, fit: 'inside' },
};

// ── Path resolution ───────────────────────────────────────────────────────────

export function thumbPath(opts: {
  thumbCacheDir: string;
  libraryId:     string;
  takenAt:       string | null;
  fileId:        string;
  size:          ThumbSize;
}): string {
  const date  = opts.takenAt ? new Date(opts.takenAt) : new Date(0);
  const yyyy  = date.getFullYear().toString();
  const mm    = String(date.getMonth() + 1).padStart(2, '0');
  return path.join(opts.thumbCacheDir, opts.libraryId, yyyy, mm, `${opts.fileId}-${opts.size}.jpg`);
}

// ── Sharp pipeline ────────────────────────────────────────────────────────────

async function generatePhotoThumb(
  sourcePath: string,
  destPath:   string,
  size:       ThumbSize,
): Promise<void> {
  const s = SIZES[size];
  const sharp = (await import('sharp')).default;

  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  await sharp(sourcePath)
    .rotate()                                   // auto-rotate from EXIF orientation
    .resize(s.w, s.h, {
      fit:                s.fit,
      withoutEnlargement: true,
      position:           size === 'xs' ? 'attention' : 'centre',
    })
    .jpeg({ quality: s.quality, mozjpeg: true })
    .toFile(destPath);
}

// ── Video frame extraction ────────────────────────────────────────────────────

async function generateVideoThumb(
  sourcePath:  string,
  destPath:    string,
  size:        ThumbSize,
  ffmpegPath:  string | null,
): Promise<void> {
  const s       = SIZES[size];
  const tmpPath = path.join(os.tmpdir(), `meridian-vthumb-${Date.now()}.png`);

  await new Promise<void>((resolve, reject) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ffmpeg = require('fluent-ffmpeg') as typeof import('fluent-ffmpeg');
      if (ffmpegPath) {
        ffmpeg.setFfmpegPath(ffmpegPath);
        ffmpeg.setFfprobePath(ffmpegPath.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'));
      }
      ffmpeg(sourcePath)
        .seekInput(0)
        .frames(1)
        .output(tmpPath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .run();
    } catch (err) {
      reject(err);
    }
  });

  // Process the raw frame through Sharp for resizing and JPEG conversion
  const sharp = (await import('sharp')).default;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  await sharp(tmpPath)
    .resize(s.w, s.h, { fit: s.fit, withoutEnlargement: true })
    .jpeg({ quality: s.quality, mozjpeg: true })
    .toFile(destPath);

  try { fs.unlinkSync(tmpPath); } catch { /* non-fatal */ }
}

// ── Placeholder for unsupported files ─────────────────────────────────────────

async function generatePlaceholder(destPath: string, size: ThumbSize): Promise<void> {
  const s = SIZES[size];
  const sharp = (await import('sharp')).default;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  // Dark grey square with a simple file icon implied by colour
  await sharp({
    create: {
      width:      s.w,
      height:     s.fit === 'cover' ? s.h : Math.round(s.h * 0.75),
      channels:   3,
      background: { r: 22, g: 26, b: 32 },
    },
  })
    .jpeg({ quality: 60 })
    .toFile(destPath);
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ThumbRequest {
  fileId:       string;
  filePath:     string;
  fileType:     FileType;
  takenAt:      string | null;
  libraryId:    string;
  thumbCacheDir: string;
  ffmpegPath:   string | null;
  size:         ThumbSize;
}

export interface ThumbResult {
  destPath: string;
  success:  boolean;
  error:    string | null;
}

export async function generateThumb(req: ThumbRequest): Promise<ThumbResult> {
  const dest = thumbPath({
    thumbCacheDir: req.thumbCacheDir,
    libraryId:     req.libraryId,
    takenAt:       req.takenAt,
    fileId:        req.fileId,
    size:          req.size,
  });

  // Already exists — skip
  if (fs.existsSync(dest)) return { destPath: dest, success: true, error: null };

  try {
    if (req.fileType === 'video') {
      await generateVideoThumb(req.filePath, dest, req.size, req.ffmpegPath);
    } else if (req.fileType === 'photo' || req.fileType === 'raw') {
      await generatePhotoThumb(req.filePath, dest, req.size);
    } else {
      await generatePlaceholder(dest, req.size);
    }
    return { destPath: dest, success: true, error: null };
  } catch (err) {
    // Fall back to placeholder so the grid always has something to show
    try {
      await generatePlaceholder(dest, req.size);
      return { destPath: dest, success: true, error: null };
    } catch {
      return { destPath: dest, success: false, error: (err as Error).message };
    }
  }
}

// ── Semaphore for concurrency control ─────────────────────────────────────────

export class Semaphore {
  private count:   number;
  private queue:   Array<() => void> = [];

  constructor(concurrency: number) {
    this.count = concurrency;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) { this.count--; return; }
    return new Promise(resolve => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) { next(); } else { this.count++; }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try   { return await fn(); }
    finally { this.release(); }
  }
}

// ── Thumb queue ───────────────────────────────────────────────────────────────

export interface QueuedThumb extends ThumbRequest {
  onDone?: (result: ThumbResult) => void;
}

export class ThumbQueue {
  private queue:     QueuedThumb[] = [];
  private sem:       Semaphore;
  private running:   boolean = false;
  private _pending:  number  = 0;

  constructor(concurrency = 2) {
    this.sem = new Semaphore(concurrency);
  }

  get pending(): number { return this._pending; }

  enqueue(item: QueuedThumb): void {
    this.queue.push(item);
    this._pending++;
    if (!this.running) this._drain();
  }

  private async _drain(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      await this.sem.run(async () => {
        const result = await generateThumb(item);
        this._pending = Math.max(0, this._pending - 1);
        item.onDone?.(result);
      });
    }
    this.running = false;
  }
}
