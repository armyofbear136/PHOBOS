/**
 * meridian/indexer.ts — File metadata extraction for PHOBOS Meridian.
 *
 * Extracts EXIF, dimensions, duration, and type for a single file.
 * Pure function — no DB access. The scanner calls this and writes results.
 */

import fs   from 'node:fs';
import path from 'node:path';
import type { MeridianFile, FileType } from './db/db.js';

// ── File type detection ───────────────────────────────────────────────────────

const PHOTO_EXTS = new Set(['jpg','jpeg','png','webp','avif','gif','tiff','tif','heic','heif']);
const RAW_EXTS   = new Set(['raw','arw','cr2','cr3','nef','orf','rw2','dng','raf']);
const VIDEO_EXTS = new Set(['mp4','mov','avi','mkv','webm','m4v','3gp']);

export function classifyExt(ext: string): FileType {
  const e = ext.toLowerCase().replace(/^\./, '');
  if (PHOTO_EXTS.has(e)) return 'photo';
  if (RAW_EXTS.has(e))   return 'raw';
  if (VIDEO_EXTS.has(e)) return 'video';
  return 'unknown';
}

export function isSupportedExt(ext: string): boolean {
  return classifyExt(ext) !== 'unknown';
}

// ── Metadata result ───────────────────────────────────────────────────────────

export interface FileMetadata {
  type:       FileType;
  sizeBytes:  number;
  width:      number | null;
  height:     number | null;
  durationMs: number | null;
  takenAt:    string | null;
  exifJson:   Record<string, unknown> | null;
}

// ── EXIF extraction ───────────────────────────────────────────────────────────

async function extractExif(filePath: string): Promise<{
  takenAt: string | null;
  width:   number | null;
  height:  number | null;
  exif:    Record<string, unknown> | null;
}> {
  try {
    // Dynamic import — exifr is ESM
    const exifr = await import('exifr');
    const parsed = await exifr.default.parse(filePath, {
      tiff:  true,
      exif:  true,
      gps:   true,
      icc:   false,
      iptc:  false,
      xmp:   false,
      pick:  [
        'DateTimeOriginal', 'CreateDate', 'ModifyDate',
        'ImageWidth', 'ImageHeight', 'ExifImageWidth', 'ExifImageHeight',
        'Make', 'Model', 'LensModel', 'FocalLength',
        'ISO', 'FNumber', 'ExposureTime', 'Flash',
        'GPSLatitude', 'GPSLongitude', 'GPSAltitude',
        'Orientation',
      ],
    });

    if (!parsed) return { takenAt: null, width: null, height: null, exif: null };

    // Date: prefer DateTimeOriginal > CreateDate
    let takenAt: string | null = null;
    const rawDate = parsed.DateTimeOriginal ?? parsed.CreateDate ?? parsed.ModifyDate;
    if (rawDate instanceof Date && !isNaN(rawDate.getTime())) {
      takenAt = rawDate.toISOString();
    }

    const width  = (parsed.ImageWidth  ?? parsed.ExifImageWidth  ?? null) as number | null;
    const height = (parsed.ImageHeight ?? parsed.ExifImageHeight ?? null) as number | null;

    return { takenAt, width, height, exif: parsed as Record<string, unknown> };
  } catch {
    return { takenAt: null, width: null, height: null, exif: null };
  }
}

// ── Sharp dimensions ──────────────────────────────────────────────────────────

async function sharpDimensions(filePath: string): Promise<{ width: number | null; height: number | null }> {
  try {
    const sharp = (await import('sharp')).default;
    const meta  = await sharp(filePath).metadata();
    return { width: meta.width ?? null, height: meta.height ?? null };
  } catch {
    return { width: null, height: null };
  }
}

// ── Video probe ───────────────────────────────────────────────────────────────

async function probeVideo(
  filePath: string,
  ffmpegPath: string | null,
): Promise<{ width: number | null; height: number | null; durationMs: number | null }> {
  return new Promise(resolve => {
    try {
      // Inline require — fluent-ffmpeg is a CommonJS module
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ffmpeg = require('fluent-ffmpeg') as typeof import('fluent-ffmpeg');
      if (ffmpegPath) ffmpeg.setFfprobePath(ffmpegPath);

      ffmpeg.ffprobe(filePath, (err, data) => {
        if (err || !data) { resolve({ width: null, height: null, durationMs: null }); return; }
        const vs = data.streams?.find(s => s.codec_type === 'video');
        resolve({
          width:      vs?.width  ?? null,
          height:     vs?.height ?? null,
          durationMs: data.format?.duration ? Math.round(data.format.duration * 1000) : null,
        });
      });
    } catch {
      resolve({ width: null, height: null, durationMs: null });
    }
  });
}

// ── Main extractor ────────────────────────────────────────────────────────────

export async function extractMetadata(
  filePath: string,
  ffmpegPath: string | null,
): Promise<FileMetadata> {
  const ext      = path.extname(filePath);
  const type     = classifyExt(ext);
  const stat     = fs.statSync(filePath);
  const sizeBytes = stat.size;

  if (type === 'video') {
    const { width, height, durationMs } = await probeVideo(filePath, ffmpegPath);
    return { type, sizeBytes, width, height, durationMs, takenAt: null, exifJson: null };
  }

  if (type === 'photo' || type === 'raw') {
    // Try EXIF first — it has orientation-aware dimensions
    const { takenAt, width: exifW, height: exifH, exif } = await extractExif(filePath);

    // If EXIF didn't give us dimensions, fall back to Sharp
    let width  = exifW;
    let height = exifH;
    if (width == null || height == null) {
      const sharp = await sharpDimensions(filePath);
      width  = sharp.width;
      height = sharp.height;
    }

    // Swap dimensions if EXIF orientation is portrait (90° or 270° rotated)
    const orientation = (exif?.Orientation as number | undefined) ?? 1;
    if ([5, 6, 7, 8].includes(orientation) && width != null && height != null) {
      [width, height] = [height, width];
    }

    return { type, sizeBytes, width, height, durationMs: null, takenAt, exifJson: exif };
  }

  return { type: 'unknown', sizeBytes, width: null, height: null, durationMs: null, takenAt: null, exifJson: null };
}

// ── Build MeridianFile from path + metadata ───────────────────────────────────

export function buildFileRecord(opts: {
  id:        string;
  filePath:  string;
  mtime:     number;
  metadata:  FileMetadata;
  userId:    string;
  libraryId: string;
}): MeridianFile {
  return {
    id:          opts.id,
    path:        opts.filePath,
    filename:    path.basename(opts.filePath),
    ext:         path.extname(opts.filePath).toLowerCase().replace(/^\./, ''),
    type:        opts.metadata.type,
    sizeBytes:   opts.metadata.sizeBytes,
    width:       opts.metadata.width,
    height:      opts.metadata.height,
    durationMs:  opts.metadata.durationMs,
    takenAt:     opts.metadata.takenAt,
    indexedAt:   new Date().toISOString(),
    mtime:       opts.mtime,
    thumbReady:  false,
    thumbPath:   null,
    exifJson:    opts.metadata.exifJson,
    embedVec:    null,
    labelsJson:  null,
    albumIds:    [],
    userId:      opts.userId,
    libraryId:   opts.libraryId,
  };
}
