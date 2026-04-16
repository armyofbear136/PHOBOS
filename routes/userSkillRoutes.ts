/**
 * PHOBOS User Skills — API Routes
 *
 * GET    /api/user-skills                      — list all user skills
 * GET    /api/user-skills/:id                  — get one
 * POST   /api/user-skills                      — create
 * PUT    /api/user-skills/:id                  — full update
 * PATCH  /api/user-skills/:id/toggle           — toggle enabled
 * DELETE /api/user-skills/:id                  — delete skill + all files
 *
 * POST   /api/user-skills/import               — import from zip (octet-stream)
 * GET    /api/user-skills/:id/export           — export skill as zip download
 *
 * POST   /api/user-skills/:id/deps             — upload a dep file (?filename=)
 * DELETE /api/user-skills/:id/deps/:filename   — remove a dep file
 */

import type { FastifyInstance } from 'fastify';
import * as UserSkillManager from '../db/UserSkillManager.js';
import type { UserSkillCreateInput } from '../db/UserSkillManager.js';

export async function registerUserSkillRoutes(fastify: FastifyInstance): Promise<void> {

  // ── List ────────────────────────────────────────────────────────────────────

  fastify.get('/api/user-skills', async (_req, reply) => {
    const skills = await UserSkillManager.listUserSkills();
    return reply.send(skills);
  });

  // ── Get one ─────────────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>('/api/user-skills/:id', async (req, reply) => {
    const skill = await UserSkillManager.getUserSkill(req.params.id);
    if (!skill) return reply.status(404).send({ error: 'Skill not found' });
    return reply.send(skill);
  });

  // ── Create ──────────────────────────────────────────────────────────────────

  fastify.post('/api/user-skills', async (req, reply) => {
    const body = req.body as UserSkillCreateInput;
    try {
      const skill = await UserSkillManager.createUserSkill(body);
      return reply.status(201).send(skill);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // ── Update ──────────────────────────────────────────────────────────────────

  fastify.put<{ Params: { id: string } }>('/api/user-skills/:id', async (req, reply) => {
    const body = req.body as Partial<UserSkillCreateInput>;
    try {
      const skill = await UserSkillManager.updateUserSkill(req.params.id, body);
      return reply.send(skill);
    } catch (err) {
      const msg = (err as Error).message;
      return reply.status(msg.includes('not found') ? 404 : 400).send({ error: msg });
    }
  });

  // ── Toggle ──────────────────────────────────────────────────────────────────

  fastify.patch<{ Params: { id: string } }>('/api/user-skills/:id/toggle', async (req, reply) => {
    try {
      const skill = await UserSkillManager.toggleUserSkill(req.params.id);
      return reply.send(skill);
    } catch (err) {
      return reply.status(404).send({ error: (err as Error).message });
    }
  });

  // ── Delete ──────────────────────────────────────────────────────────────────

  fastify.delete<{ Params: { id: string } }>('/api/user-skills/:id', async (req, reply) => {
    try {
      await UserSkillManager.deleteUserSkill(req.params.id);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(404).send({ error: (err as Error).message });
    }
  });

  // ── ZIP import ──────────────────────────────────────────────────────────────
  // POST /api/user-skills/import
  // Body: raw zip binary (application/octet-stream)
  // The existing octet-stream content parser in server.ts handles this.

  fastify.post<{ Querystring: { isMd?: string; filename?: string } }>(
    '/api/user-skills/import',
    async (req, reply) => {
      const buf = req.body as Buffer;
      if (!buf || buf.length === 0) {
        return reply.status(400).send({ error: 'Empty body' });
      }
      try {
        let skill: UserSkillManager.UserSkillRecord;
        if (req.query.isMd === '1') {
          // Bare SKILL.md posted directly — wrap into a minimal zip for the importer
          const AdmZip = (await import('adm-zip')).default;
          const zip = new AdmZip();
          zip.addFile('SKILL.md', buf);
          skill = await UserSkillManager.importSkillFromZip(zip.toBuffer());
        } else {
          skill = await UserSkillManager.importSkillFromZip(buf);
        }
        return reply.status(201).send(skill);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  // ── ZIP export ──────────────────────────────────────────────────────────────
  // GET /api/user-skills/:id/export
  // Returns the skill packaged as a downloadable zip.

  fastify.get<{ Params: { id: string } }>('/api/user-skills/:id/export', async (req, reply) => {
    try {
      const buf = await UserSkillManager.exportSkillToZip(req.params.id);
      const filename = `${req.params.id}.zip`;
      return reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(buf);
    } catch (err) {
      const msg = (err as Error).message;
      return reply.status(msg.includes('not found') ? 404 : 500).send({ error: msg });
    }
  });

  // ── Dep upload ──────────────────────────────────────────────────────────────
  // POST /api/user-skills/:id/deps?filename=my-binary.exe
  // Body: raw file binary (application/octet-stream)

  fastify.post<{ Params: { id: string }; Querystring: { filename?: string } }>(
    '/api/user-skills/:id/deps',
    async (req, reply) => {
      const buf = req.body as Buffer;
      const filename = req.query.filename ?? 'upload';
      try {
        const dep = await UserSkillManager.installDepFile(req.params.id, filename, buf);
        return reply.send({ ok: true, dep });
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  // ── Dep delete ──────────────────────────────────────────────────────────────

  fastify.delete<{ Params: { id: string; filename: string } }>(
    '/api/user-skills/:id/deps/:filename',
    async (req, reply) => {
      try {
        await UserSkillManager.deleteDepFile(req.params.id, req.params.filename);
        return reply.send({ ok: true });
      } catch (err) {
        return reply.status(404).send({ error: (err as Error).message });
      }
    },
  );
}
