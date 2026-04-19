/**
 * meridian/routes/libraries.ts — Library listing and manual scan trigger.
 */

import type { FastifyInstance } from 'fastify';
import type { MeridianDB, MeridianLibrary } from '../db/db.js';
import type { MeridianConfig } from '../db/config.js';
import type { Scanner } from '../scanner.js';

export async function libraryRoutes(
  fastify: FastifyInstance,
  opts: { db: MeridianDB; config: MeridianConfig; scanner: Scanner },
): Promise<void> {

  // ── GET /api/libraries ───────────────────────────────────────────────────

  fastify.get('/api/libraries', async (_req, reply) => {
    const libs = await opts.db.listLibraries(opts.config.userId);
    return reply.send({ libraries: libs });
  });

  // ── POST /api/libraries/:id/scan ─────────────────────────────────────────

  fastify.post<{ Params: { id: string } }>(
    '/api/libraries/:id/scan',
    async (req, reply) => {
      const lib = await opts.db.getLibrary(req.params.id);
      if (!lib) return reply.status(404).send({ error: 'Library not found' });
      if (!lib.enabled) return reply.status(400).send({ error: 'Library is disabled' });

      opts.scanner.scanLibrary(lib as MeridianLibrary);
      return reply.send({ ok: true, phase: opts.scanner.getState().phase });
    }
  );
}
