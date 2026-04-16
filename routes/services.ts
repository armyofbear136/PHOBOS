/**
 * routes/services.ts — PHOBOS Media Hub API routes.
 *
 * POST   /api/services/:name/enable     — enable service (triggers binary check + spawn)
 * POST   /api/services/:name/disable    — stop service
 * GET    /api/services/:name/status     — state, port, binary present, library path
 * GET    /api/services/all              — all four services at once (for hub panel load)
 * PATCH  /api/services/:name/config     — update libraryPath and/or settings fields
 *
 * ── PhotoPrism-specific ──────────────────────────────────────────────────────
 * POST   /api/services/photoprism/scan  — trigger library index pass
 * ANY    /api/services/photoprism/proxy/* — transparent reverse proxy to PhotoPrism
 *                                          REST API (auth token injected server-side)
 *
 * Jellyfin, Polaris, and Kavita are managed by their own managers (not in this
 * session — stubs added so the hub panel can render all four cards consistently).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { ServiceStore, type ServiceName } from '../db/ServiceStore.js';
import {
  startPhotoprism,
  stopPhotoprism,
  getPhotoPrismStatus,
  triggerLibraryScan,
  photoPrismApiRequest,
  isBinaryPresent as isPhotoPrismBinaryPresent,
  PHOTOPRISM_PORT,
} from '../services/PhotoPrismManager.js';
import {
  startPolaris,
  stopPolaris,
  getPolarisStatus,
  triggerScan      as triggerPolarisScan,
  polarisApiRequest,
  isBinaryPresent  as isPolarisBinaryPresent,
  POLARIS_PORT,
} from '../services/PolarisManager.js';

// ── Stub status shape for services whose managers aren't implemented yet ──────
// Jellyfin, Polaris, and Kavita managers follow in a later session.
// The frontend hub panel reads the same shape from all four, so stubs are needed.
function stubStatus(name: ServiceName, record: { enabled: boolean; libraryPath: string | null }) {
  return {
    name,
    state:        record.enabled ? 'stopped' : 'stopped', // will be 'running' once managers land
    port:         name === 'jellyfin' ? 18096 : name === 'polaris' ? 18050 : 18000,
    error:        null,
    binaryPresent: false,  // managers will populate this
    libraryPath:  record.libraryPath,
    enabled:      record.enabled,
  };
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerServiceRoutes(fastify: FastifyInstance): Promise<void> {
  const db    = DatabaseManager.getInstance();
  const store = new ServiceStore(db);
  await store.ensureTable();

  // Ensure all four rows exist in DB on startup.
  await store.getAll();

  // ── All services status ──────────────────────────────────────────────────
  fastify.get('/api/services/all', async (_req, reply) => {
    const all = await store.getAll();

    const ppStatus   = getPhotoPrismStatus();
    const ppRecord   = all.photoprism;

    return reply.send({
      photoprism: {
        name:          'photoprism',
        state:         ppStatus.state,
        port:          ppStatus.port,
        error:         ppStatus.error,
        binaryPresent: ppStatus.binaryPresent,
        libraryPath:   ppRecord.libraryPath,
        settings:      ppRecord.settings,
        enabled:       ppRecord.enabled,
      },
      jellyfin: stubStatus('jellyfin', all.jellyfin),
      polaris: (() => {
        const s = getPolarisStatus();
        const r = all.polaris;
        return { name: 'polaris', state: s.state, port: s.port, error: s.error,
                 binaryPresent: s.binaryPresent, libraryPath: r.libraryPath,
                 settings: r.settings, enabled: r.enabled };
      })(),
      kavita:   stubStatus('kavita',   all.kavita),
    });
  });

  // ── Per-service status ───────────────────────────────────────────────────
  fastify.get<{ Params: { name: string } }>(
    '/api/services/:name/status',
    async (req, reply) => {
      const name = req.params.name as ServiceName;
      const record = await store.get(name);

      if (name === 'photoprism') {
        const s = getPhotoPrismStatus();
        return reply.send({ ...s, settings: record.settings, enabled: record.enabled });
      }

      if (name === 'polaris') {
        const s = getPolarisStatus();
        return reply.send({ ...s, name: 'polaris', settings: record.settings, enabled: record.enabled });
      }

      return reply.send({ ...stubStatus(name, record), settings: record.settings });
    }
  );

  // ── Enable ───────────────────────────────────────────────────────────────
  fastify.post<{ Params: { name: string } }>(
    '/api/services/:name/enable',
    async (req, reply) => {
      const name = req.params.name as ServiceName;
      const record = await store.setEnabled(name, true);

      if (name === 'photoprism') {
        if (!isPhotoPrismBinaryPresent()) {
          return reply.status(400).send({
            error: 'PhotoPrism binary not found. Run: node scripts/fetch-photoprism.js',
            binaryPresent: false,
          });
        }
        if (!record.libraryPath) {
          return reply.status(400).send({ error: 'Set a library path before enabling PhotoPrism.' });
        }
        const adminPassword = (record.settings.adminPassword as string) || '';
        if (!adminPassword) {
          return reply.status(500).send({ error: 'No admin password in settings — check ServiceStore.' });
        }
        // Non-blocking spawn — client polls /status.
        startPhotoprism({
          originalsPath:         record.libraryPath,
          adminPassword,
          disableFaces:          Boolean(record.settings.disableFaces),
          disableClassification: Boolean(record.settings.disableClassification),
          workers:               Number(record.settings.workers ?? 0),
        }).catch(err => {
          console.error('[services] PhotoPrism start failed:', err.message);
        });
        return reply.send({ ok: true, state: 'starting' });
      }

      if (name === 'polaris') {
        if (!isPolarisBinaryPresent()) {
          return reply.status(400).send({
            error: 'Polaris binary not found. Run: node scripts/fetch-polaris.js',
            binaryPresent: false,
          });
        }
        if (!record.libraryPath) {
          return reply.status(400).send({ error: 'Set a library path before enabling Polaris.' });
        }
        const adminPassword = (record.settings.adminPassword as string) || '';
        if (!adminPassword) {
          return reply.status(500).send({ error: 'No admin password in settings — check ServiceStore.' });
        }
        startPolaris({
          adminPassword,
          libraryPath: record.libraryPath,
          mountName:   (record.settings.mountName as string) || 'Music',
        }).catch(err => {
          console.error('[services] Polaris start failed:', err.message);
        });
        return reply.send({ ok: true, state: 'starting' });
      }

      // Jellyfin / Kavita — managers not yet implemented.
      return reply.status(501).send({ error: `${name} manager not yet implemented.` });
    }
  );

  // ── Disable ──────────────────────────────────────────────────────────────
  fastify.post<{ Params: { name: string } }>(
    '/api/services/:name/disable',
    async (req, reply) => {
      const name = req.params.name as ServiceName;
      await store.setEnabled(name, false);

      if (name === 'photoprism') {
        await stopPhotoprism();
        return reply.send({ ok: true, state: 'stopped' });
      }

      if (name === 'polaris') {
        await stopPolaris();
        return reply.send({ ok: true, state: 'stopped' });
      }

      return reply.send({ ok: true, state: 'stopped' });
    }
  );

  // ── Config patch ─────────────────────────────────────────────────────────
  fastify.patch<{
    Params: { name: string };
    Body: { libraryPath?: string | null; settings?: Record<string, unknown> };
  }>(
    '/api/services/:name/config',
    async (req, reply) => {
      const name   = req.params.name as ServiceName;
      let   record = await store.get(name);

      if (req.body.libraryPath !== undefined) {
        record = await store.setLibraryPath(name, req.body.libraryPath ?? null);
      }
      if (req.body.settings) {
        // Block writing adminPassword through the config patch — it is set only
        // on first creation and rotated via a dedicated endpoint (future).
        const safePatch = { ...req.body.settings };
        delete safePatch['adminPassword'];
        record = await store.patchSettings(name, safePatch);
      }

      // If PhotoPrism is running and the config changed, restart it.
      if (name === 'photoprism' && record.enabled) {
        const status = getPhotoPrismStatus();
        if (status.state === 'running' && record.libraryPath) {
          stopPhotoprism().then(() => {
            startPhotoprism({
              originalsPath:         record.libraryPath!,
              adminPassword:         record.settings.adminPassword as string,
              disableFaces:          Boolean(record.settings.disableFaces),
              disableClassification: Boolean(record.settings.disableClassification),
              workers:               Number(record.settings.workers ?? 0),
            }).catch(err => console.error('[services] PhotoPrism restart failed:', err.message));
          });
        }
      }

      // If Polaris is running and the config changed, restart it.
      if (name === 'polaris' && record.enabled) {
        const status = getPolarisStatus();
        if (status.state === 'running' && record.libraryPath) {
          stopPolaris().then(() => {
            startPolaris({
              adminPassword: record.settings.adminPassword as string,
              libraryPath:   record.libraryPath!,
              mountName:     (record.settings.mountName as string) || 'Music',
            }).catch(err => console.error('[services] Polaris restart failed:', err.message));
          });
        }
      }

      return reply.send({ ok: true, record });
    }
  );

  // ── PhotoPrism: scan ─────────────────────────────────────────────────────
  fastify.post<{ Body?: { rescan?: boolean } }>('/api/services/photoprism/scan', async (req, reply) => {
    try {
      await triggerLibraryScan(Boolean(req.body?.rescan));
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(503).send({ error: (err as Error).message });
    }
  });

  // ── PhotoPrism: REST API reverse proxy ───────────────────────────────────
  // Forwards any /api/v1/* call to the local PhotoPrism instance with the
  // admin session token injected. The frontend never holds credentials.
  // Media bytes (thumbnails, full images) are streamed through to avoid
  // buffering entire files in Node.js.
  fastify.all<{
    Params: { '*': string };
    Querystring: Record<string, string>;
  }>(
    '/api/services/photoprism/proxy/*',
    { config: { rawBody: false } } as any,
    async (req: FastifyRequest, reply: FastifyReply) => {
      const status = getPhotoPrismStatus();
      if (status.state !== 'running') {
        return reply.status(503).send({ error: 'PhotoPrism is not running' });
      }

      const wildcard   = (req.params as any)['*'] as string;
      const upstream   = `/api/v1/${wildcard}`;
      const query      = new URLSearchParams(req.query as Record<string, string>).toString();

      // Stream the upstream response directly to the client without buffering.
      const upstreamRes = await photoPrismApiRequest(
        req.method,
        upstream + (query ? '?' + query : ''),
        req.method !== 'GET' && req.method !== 'HEAD' ? (req.body ?? undefined) : undefined,
      );

      reply.raw.writeHead(upstreamRes.status, {
        'Content-Type': upstreamRes.headers.get('content-type') ?? 'application/json',
      });

      // If the body is binary (image/jpeg, image/webp etc.) pipe it through.
      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
        const pump = async (): Promise<void> => {
          const { done, value } = await reader.read();
          if (done) { reply.raw.end(); return; }
          if (!reply.raw.write(value)) {
            await new Promise(r => reply.raw.once('drain', r));
          }
          return pump();
        };
        await pump();
      } else {
        reply.raw.end();
      }
    }
  );

  // ── Polaris: scan ─────────────────────────────────────────────────────────
  fastify.post('/api/services/polaris/scan', async (_req, reply) => {
    try {
      await triggerPolarisScan();
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(503).send({ error: (err as Error).message });
    }
  });

  // ── Polaris: REST API reverse proxy ───────────────────────────────────────
  // Forwards any Polaris API call with the Bearer token injected server-side.
  // Audio files stream through without buffering.
  fastify.all<{
    Params: { '*': string };
    Querystring: Record<string, string>;
  }>(
    '/api/services/polaris/proxy/*',
    { config: { rawBody: false } } as any,
    async (req: FastifyRequest, reply: FastifyReply) => {
      const status = getPolarisStatus();
      if (status.state !== 'running') {
        return reply.status(503).send({ error: 'Polaris is not running' });
      }

      const wildcard = (req.params as any)['*'] as string;
      // Preserve raw query string to support repeated params like ?paths=a&paths=b
      const rawQuery = (req.raw.url ?? '').split('?')[1] ?? '';
      const endpoint = `/${wildcard}` + (rawQuery ? '?' + rawQuery : '');

      const upstreamRes = await polarisApiRequest(
        req.method,
        endpoint,
        req.method !== 'GET' && req.method !== 'HEAD' ? (req.body ?? undefined) : undefined,
      );

      reply.raw.writeHead(upstreamRes.status, {
        'Content-Type': upstreamRes.headers.get('content-type') ?? 'application/json',
      });

      if (upstreamRes.body) {
        const reader = upstreamRes.body.getReader();
        const pump = async (): Promise<void> => {
          const { done, value } = await reader.read();
          if (done) { reply.raw.end(); return; }
          if (!reply.raw.write(value)) {
            await new Promise(r => reply.raw.once('drain', r));
          }
          return pump();
        };
        await pump();
      } else {
        reply.raw.end();
      }
    }
  );

  // ── Polaris: fetch binary (server-side download + extract) ────────────────
  // Called by the MediaHub first-time setup flow. Runs fetch-polaris.js as a
  // child process and streams progress back. For now returns 200 when done.
  fastify.post('/api/services/polaris/fetch-binary', async (_req, reply) => {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const execFileAsync = promisify(execFile);
    const _dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
    const scriptsDir = path.join(_dirname, '..', 'scripts');
    try {
      await execFileAsync('node', [path.join(scriptsDir, 'fetch-polaris.js')], {
        env: { ...process.env },
        timeout: 10 * 60 * 1000, // 10 min
      });
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Polaris: uninstall ─────────────────────────────────────────────────────
  fastify.post('/api/services/polaris/uninstall', async (_req, reply) => {
    const fs   = await import('fs');
    const path = await import('path');
    const os   = await import('os');
    const dir  = path.join(os.homedir(), '.phobos', 'services', 'polaris');
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });
}
