/**
 * meridian/routes/albums.ts — Album CRUD and file membership routes.
 */

import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { MeridianDB } from '../db/db.js';
import type { MeridianConfig } from '../db/config.js';

export async function albumRoutes(
  fastify: FastifyInstance,
  opts: { db: MeridianDB; config: MeridianConfig },
): Promise<void> {

  // ── GET /api/albums ──────────────────────────────────────────────────────

  fastify.get('/api/albums', async (_req, reply) => {
    const albums = await opts.db.listAlbums(opts.config.userId);
    return reply.send({ albums });
  });

  // ── POST /api/albums ─────────────────────────────────────────────────────

  fastify.post<{ Body: { name: string; description?: string; libraryId?: string } }>(
    '/api/albums',
    async (req, reply) => {
      const { name, description, libraryId } = req.body;
      if (!name?.trim()) return reply.status(400).send({ error: 'name is required' });

      const album = {
        id:          crypto.randomUUID(),
        name:        name.trim(),
        description: description?.trim() ?? null,
        coverFileId: null,
        createdAt:   new Date().toISOString(),
        updatedAt:   new Date().toISOString(),
        userId:      opts.config.userId,
        libraryId:   libraryId ?? 'default',
        autoRule:    null,
      };
      await opts.db.createAlbum(album);
      return reply.status(201).send({ album });
    }
  );

  // ── GET /api/albums/:id ──────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>('/api/albums/:id', async (req, reply) => {
    const album = await opts.db.getAlbum(req.params.id);
    if (!album) return reply.status(404).send({ error: 'Not found' });
    const files = await opts.db.getAlbumFiles(req.params.id, opts.config.userId);
    return reply.send({ album, files: files.map(f => ({
      id: f.id, filename: f.filename, ext: f.ext, type: f.type,
      width: f.width, height: f.height, takenAt: f.takenAt, thumbReady: f.thumbReady,
    }))});
  });

  // ── PATCH /api/albums/:id ────────────────────────────────────────────────

  fastify.patch<{
    Params: { id: string };
    Body: { name?: string; description?: string; coverFileId?: string | null };
  }>('/api/albums/:id', async (req, reply) => {
    const album = await opts.db.getAlbum(req.params.id);
    if (!album) return reply.status(404).send({ error: 'Not found' });
    await opts.db.updateAlbum(req.params.id, {
      name:        req.body.name?.trim(),
      description: req.body.description?.trim(),
      coverFileId: req.body.coverFileId,
    });
    return reply.send({ ok: true });
  });

  // ── DELETE /api/albums/:id ───────────────────────────────────────────────

  fastify.delete<{ Params: { id: string } }>('/api/albums/:id', async (req, reply) => {
    const album = await opts.db.getAlbum(req.params.id);
    if (!album) return reply.status(404).send({ error: 'Not found' });
    await opts.db.deleteAlbum(req.params.id);
    return reply.send({ ok: true });
  });

  // ── POST /api/albums/:id/files ───────────────────────────────────────────

  fastify.post<{
    Params: { id: string };
    Body: { fileIds: string[] };
  }>('/api/albums/:id/files', async (req, reply) => {
    const album = await opts.db.getAlbum(req.params.id);
    if (!album) return reply.status(404).send({ error: 'Not found' });
    const { fileIds } = req.body;
    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      return reply.status(400).send({ error: 'fileIds must be a non-empty array' });
    }
    await Promise.all(fileIds.map(fid => opts.db.addFileToAlbum(fid, req.params.id)));
    return reply.send({ ok: true, added: fileIds.length });
  });

  // ── DELETE /api/albums/:id/files/:fileId ─────────────────────────────────

  fastify.delete<{ Params: { id: string; fileId: string } }>(
    '/api/albums/:id/files/:fileId',
    async (req, reply) => {
      await opts.db.removeFileFromAlbum(req.params.fileId, req.params.id);
      return reply.send({ ok: true });
    }
  );
}
