/**
 * meridian/routes/status.ts — Health and scan state endpoint.
 */

import type { FastifyInstance } from 'fastify';
import type { Scanner } from '../scanner.js';
import type { MeridianDB } from '../db/db.js';
import type { MeridianConfig } from '../db/config.js';

export async function statusRoutes(
  fastify: FastifyInstance,
  opts: { scanner: Scanner; db: MeridianDB; config: MeridianConfig },
): Promise<void> {
  fastify.get('/api/status', async (_req, reply) => {
    const scan   = opts.scanner.getState();
    const libs   = await opts.db.listLibraries(opts.config.userId);
    const counts = libs.reduce((sum, l) => sum + l.fileCount, 0);

    return reply.send({
      ok:           true,
      port:         opts.config.port,
      scanPhase:    scan.phase,
      filesWalked:  scan.filesWalked,
      filesIndexed: scan.filesIndexed,
      thumbsQueued: scan.thumbsQueued,
      thumbsDone:   scan.thumbsDone,
      scanError:    scan.error,
      totalFiles:   counts,
      libraries:    libs.map(l => ({
        id:         l.id,
        path:       l.path,
        label:      l.label,
        enabled:    l.enabled,
        fileCount:  l.fileCount,
        lastScanAt: l.lastScanAt,
      })),
    });
  });
}
