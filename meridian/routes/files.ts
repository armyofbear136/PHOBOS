/**
 * meridian/routes/files.ts — File listing, metadata, raw serving, thumbnails.
 */

import fs   from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { MeridianDB } from '../db/db.js';
import type { MeridianConfig } from '../db/config.js';
import { generateThumb, thumbPath, type ThumbSize, ThumbQueue } from '../thumbnailer.js';

const THUMB_SIZES = new Set<ThumbSize>(['xs', 'sm', 'md', 'lg']);

// Shared on-demand queue for md/lg sizes (concurrency 2 — same as scan queue)
const onDemandQueue = new ThumbQueue(2);

export async function fileRoutes(
  fastify: FastifyInstance,
  opts: { db: MeridianDB; config: MeridianConfig },
): Promise<void> {

  // ── GET /api/files — paginated file list ─────────────────────────────────

  fastify.get('/api/files', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as Record<string, string>;
    const limit  = Math.min(parseInt(q.limit  ?? '100', 10), 500);
    const offset = Math.max(parseInt(q.offset ?? '0',   10), 0);
    const order  = (['taken_at', 'indexed_at', 'filename'] as const)
      .includes(q.orderBy as 'taken_at') ? q.orderBy as 'taken_at' : 'taken_at';
    const type   = q.type as import('../db/db.js').FileType | undefined;

    const { files, total } = await opts.db.listFiles({
      userId:    opts.config.userId,
      libraryId: q.libraryId,
      limit, offset,
      orderBy:   order,
      type,
    });

    return reply.send({ files: files.map(toApiFile), total, limit, offset });
  });

  // ── GET /api/files/:id — single file metadata ────────────────────────────

  fastify.get<{ Params: { id: string } }>('/api/files/:id', async (req, reply) => {
    const file = await opts.db.getFile(req.params.id);
    if (!file) return reply.status(404).send({ error: 'Not found' });
    return reply.send(toApiFileDetail(file));
  });

  // ── GET /api/files/:id/raw — serve original file ─────────────────────────

  fastify.get<{ Params: { id: string } }>('/api/files/:id/raw', async (req, reply) => {
    const file = await opts.db.getFile(req.params.id);
    if (!file) return reply.status(404).send({ error: 'Not found' });
    if (!fs.existsSync(file.path)) return reply.status(410).send({ error: 'File no longer on disk' });

    const ext      = path.extname(file.path).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
      '.heic': 'image/heic', '.heif': 'image/heif',
      '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
      '.mkv': 'video/x-matroska', '.webm': 'video/webm',
    };
    const mime = mimeMap[ext] ?? 'application/octet-stream';
    const stat = fs.statSync(file.path);

    // Range-aware streaming for video
    const rangeHeader = (req.headers as Record<string, string>).range;
    if (rangeHeader && file.type === 'video') {
      const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
      const start = parseInt(startStr, 10);
      const end   = endStr ? parseInt(endStr, 10) : stat.size - 1;
      const chunkSize = end - start + 1;

      reply.raw.writeHead(206, {
        'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges':  'bytes',
        'Content-Length': chunkSize,
        'Content-Type':   mime,
        'Cache-Control':  'no-store',
      });
      fs.createReadStream(file.path, { start, end }).pipe(reply.raw);
      return reply;
    }

    reply.header('Content-Type', mime);
    reply.header('Content-Length', stat.size);
    reply.header('Cache-Control', 'no-store');
    reply.header('Accept-Ranges', 'bytes');
    return reply.send(fs.createReadStream(file.path));
  });

  // ── GET /api/files/:id/thumb/:size — serve thumbnail ────────────────────

  fastify.get<{ Params: { id: string; size: string } }>(
    '/api/files/:id/thumb/:size',
    async (req, reply) => {
      const size = req.params.size as ThumbSize;
      if (!THUMB_SIZES.has(size)) return reply.status(400).send({ error: 'Invalid size' });

      const file = await opts.db.getFile(req.params.id);
      if (!file) return reply.status(404).send({ error: 'Not found' });

      const dest = thumbPath({
        thumbCacheDir: opts.config.thumbCacheDir,
        libraryId:     file.libraryId,
        takenAt:       file.takenAt,
        fileId:        file.id,
        size,
      });

      if (fs.existsSync(dest)) {
        return serveThumb(reply, dest);
      }

      // Not yet generated — generate synchronously for sm, queue for others
      if (size === 'sm' || size === 'xs') {
        const result = await generateThumb({
          fileId:       file.id,
          filePath:     file.path,
          fileType:     file.type,
          takenAt:      file.takenAt,
          libraryId:    file.libraryId,
          thumbCacheDir: opts.config.thumbCacheDir,
          ffmpegPath:   opts.config.ffmpegPath,
          size,
        });
        if (result.success && fs.existsSync(dest)) return serveThumb(reply, dest);
        return reply.status(202).send({ generating: true });
      }

      // md / lg — enqueue and return 202
      onDemandQueue.enqueue({
        fileId:       file.id,
        filePath:     file.path,
        fileType:     file.type,
        takenAt:      file.takenAt,
        libraryId:    file.libraryId,
        thumbCacheDir: opts.config.thumbCacheDir,
        ffmpegPath:   opts.config.ffmpegPath,
        size,
        onDone: async result => {
          if (result.success) await opts.db.markThumbReady(file.id, result.destPath);
        },
      });
      return reply.status(202).send({ generating: true, queueDepth: onDemandQueue.pending });
    }
  );
}

// ── Serve helper ──────────────────────────────────────────────────────────────

function serveThumb(reply: FastifyReply, thumbFilePath: string): FastifyReply {
  reply.header('Content-Type', 'image/jpeg');
  reply.header('Cache-Control', 'max-age=31536000, immutable');
  return reply.send(fs.createReadStream(thumbFilePath));
}

// ── API serialisers ───────────────────────────────────────────────────────────

function toApiFile(f: import('../db/db.js').MeridianFile) {
  return {
    id:         f.id,
    filename:   f.filename,
    ext:        f.ext,
    type:       f.type,
    width:      f.width,
    height:     f.height,
    durationMs: f.durationMs,
    takenAt:    f.takenAt,
    sizeBytes:  f.sizeBytes,
    thumbReady: f.thumbReady,
    albumIds:   f.albumIds,
    libraryId:  f.libraryId,
  };
}

function toApiFileDetail(f: import('../db/db.js').MeridianFile) {
  return {
    ...toApiFile(f),
    path:       f.path,
    exif:       f.exifJson,
    labels:     f.labelsJson,
    indexedAt:  f.indexedAt,
  };
}
