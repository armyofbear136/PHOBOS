/**
 * meridian/routes/sync.ts — WebRTC sync hook architecture stubs.
 *
 * v1: returns 501 with the expected response shape so clients can be written
 * against this contract now. Implementation deferred to v2.
 *
 * Contract documented in PHOBOS-Meridian-Design-Spec.md §10.
 */

import type { FastifyInstance } from 'fastify';

export async function syncRoutes(fastify: FastifyInstance): Promise<void> {

  fastify.post('/api/sync/register', async (_req, reply) => {
    return reply.status(501).send({
      error:     'sync_not_implemented',
      hookReady: true,
      message:   'WebRTC sync is planned for v2. The API contract is stable — build against it now.',
      expected: {
        deviceId:   'string',
        deviceName: 'string',
        platform:   'ios | android | desktop',
      },
      returns: {
        syncToken:  'string',
        libraryId:  'string',
      },
    });
  });

  fastify.post('/api/sync/check', async (_req, reply) => {
    return reply.status(501).send({
      error:     'sync_not_implemented',
      hookReady: true,
      message:   'WebRTC sync is planned for v2.',
      expected: {
        syncToken: 'string',
        files: 'Array<{ path: string, size: number, mtime: number, contentHash?: string }>',
      },
      returns: {
        upload:   'string[]  — paths to send to server',
        skip:     'string[]  — paths already in sync',
        conflict: 'string[]  — paths that need manual resolution',
      },
    });
  });
}
