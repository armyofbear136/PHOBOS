import type { FastifyInstance } from 'fastify';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { randomUUID } from 'crypto';

interface Project {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export async function projectsRoute(fastify: FastifyInstance): Promise<void> {
  const db = DatabaseManager.getInstance();

  // GET /api/projects
  fastify.get('/api/projects', async (_req, reply) => {
    const projects = await db.query<Project>(
      `SELECT id, name, created_at, updated_at FROM projects ORDER BY name ASC`
    );
    return reply.send(projects);
  });

  // POST /api/projects — create a named project (no root_path required from UI)
  fastify.post<{ Body: { name: string } }>(
    '/api/projects',
    async (req, reply) => {
      const name = req.body.name?.trim();
      if (!name) return reply.status(400).send({ error: 'name is required' });

      const id = randomUUID();
      const now = new Date().toISOString();
      await db.run(
        `INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        [id, name, '', now, now]
      );
      const project = await db.queryOne<Project>(
        `SELECT id, name, created_at, updated_at FROM projects WHERE id = ?`,
        [id]
      );
      return reply.status(201).send(project);
    }
  );

  // DELETE /api/projects/:id — remove project; threads retain project_id (they just become ungrouped)
  fastify.delete<{ Params: { id: string } }>(
    '/api/projects/:id',
    async (req, reply) => {
      await db.run(`DELETE FROM projects WHERE id = ?`, [req.params.id]);
      return reply.status(204).send();
    }
  );
}
