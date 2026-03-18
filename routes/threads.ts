import type { FastifyInstance } from 'fastify';
import { ThreadStore } from '../db/ThreadStore.js';
import { DatabaseManager } from '../db/DatabaseManager.js';
import fs   from 'node:fs';
import path from 'node:path';

export async function threadsRoute(fastify: FastifyInstance): Promise<void> {
  const db = DatabaseManager.getInstance();
  const store = new ThreadStore(db);

  // GET /api/threads
  fastify.get('/api/threads', async (_req, reply) => {
    const threads = await store.getAll();
    const mapped = threads.map((t) => ({
      id: t.id,
      title: t.title,
      projectName: t.project_id ?? null,
      parentThreadId: t.parent_thread_id ?? undefined,
      createdAt: t.created_at,
    }));
    return reply.send(mapped);
  });

  // PATCH /api/threads/:id — update title and/or project_id
  fastify.patch<{
    Params: { id: string };
    Body: { title?: string; project_id?: string | null };
  }>('/api/threads/:id', async (req, reply) => {
    const thread = await store.getById(req.params.id);
    if (!thread) return reply.status(404).send({ error: 'Thread not found' });
    if (req.body.title) await store.updateTitle(req.params.id, req.body.title);
    if ('project_id' in req.body) await store.updateProject(req.params.id, req.body.project_id ?? null);
    const updated = await store.getById(req.params.id);
    return reply.send(updated);
  });

  // GET /api/threads/:id
  fastify.get<{ Params: { id: string } }>(
    '/api/threads/:id',
    async (req, reply) => {
      const thread = await store.getById(req.params.id);
      if (!thread) return reply.status(404).send({ error: 'Thread not found' });
      return reply.send(thread);
    }
  );

  // POST /api/threads
  fastify.post<{
    Body: {
      title?: string;
      type?: 'planning' | 'execution';
      project_id?: string;
      mode?: string;
    };
  }>('/api/threads', async (req, reply) => {
    const thread = await store.create(req.body);
    return reply.status(201).send({
      id: thread.id,
      title: thread.title,
      projectName: thread.project_id ?? null,
      parentThreadId: thread.parent_thread_id ?? undefined,
      createdAt: thread.created_at,
    });
  });

  // POST /api/threads/:id/fork
  fastify.post<{ Params: { id: string } }>(
    '/api/threads/:id/fork',
    async (req, reply) => {
      const parent = await store.getById(req.params.id);
      if (!parent) return reply.status(404).send({ error: 'Thread not found' });
      const forked = await store.fork(req.params.id);
      return reply.status(201).send(forked);
    }
  );

  // DELETE /api/threads/:id
  fastify.delete<{ Params: { id: string } }>(
    '/api/threads/:id',
    async (req, reply) => {
      try {
        await store.delete(req.params.id);
      } catch (err) {
        fastify.log.error(err, `Failed to delete thread ${req.params.id}`);
        return reply.status(500).send({ error: 'Failed to delete thread' });
      }
      // Clean up workspace directory on disk
      try {
        const workspacesRoot = process.env.WORKSPACES_ROOT
          ?? path.join(process.env.PHOBOS_DATA_DIR ?? path.join(process.env.HOME ?? '', '.phobos'), 'workspaces');
        const dir = path.join(workspacesRoot, req.params.id);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* non-fatal — DB record is gone, disk cleanup is best-effort */ }
      return reply.status(204).send();
    }
  );
}
