/**
 * routes/services.ts — PHOBOS Media Hub API routes.
 *
 * POST   /api/services/:name/enable     — enable service (triggers binary check + spawn)
 * POST   /api/services/:name/disable    — stop service
 * GET    /api/services/:name/status     — state, port, binary present, library path
 * GET    /api/services/all              — all four services at once (for hub panel load)
 * PATCH  /api/services/:name/config     — update libraryPath and/or settings fields
 *
 * ── Meridian-specific ───────────────────────────────────────────────────────
 * POST   /api/services/meridian/scan  — trigger library reindex
 * ANY    /api/services/meridian/proxy/* — transparent reverse proxy to Meridian
 *
 * Jellyfin, Polaris, and Kavita are managed by their own managers (not in this
 * session — stubs added so the hub panel can render all four cards consistently).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { ServiceStore, type ServiceName } from '../db/ServiceStore.js';
import {
  startMeridian,
  stopMeridian,
  getMeridianStatus,
  meridianApiRequest,
  MERIDIAN_PORT,
} from '../services/MeridianManager.js';
import {
  startPolaris,
  stopPolaris,
  getPolarisStatus,
  triggerScan      as triggerPolarisScan,
  polarisApiRequest,
  isBinaryPresent  as isPolarisBinaryPresent,
  POLARIS_PORT,
} from '../services/PolarisManager.js';
import {
  startJellyfin,
  stopJellyfin,
  getJellyfinStatus,
  triggerScan      as triggerJellyfinScan,
  jellyfinApiRequest,
  isBinaryPresent  as isJellyfinBinaryPresent,
  JELLYFIN_PORT,
} from '../services/JellyfinManager.js';
import {
  getKavitaStatus,
  isBinaryPresent as isKavitaBinaryPresent,
  KAVITA_PORT,
} from '../services/KavitaManager.js';

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

    const meridianStatus   = getMeridianStatus();
    const meridianRecord   = all.meridian;

    return reply.send({
      meridian: {
        name:         'meridian',
        state:        meridianStatus.state,
        port:         meridianStatus.port,
        error:        meridianStatus.error,
        binaryPresent: true,              // first-party — always present
        libraryPath:  meridianRecord.libraryPath,
        settings:     meridianRecord.settings,
        enabled:      meridianRecord.enabled,
      },
      jellyfin: (() => {
        const s = getJellyfinStatus();
        const r = all.jellyfin;
        return {
          name:          'jellyfin',
          state:         s.state,
          port:          s.port,
          error:         s.error,
          binaryPresent: s.binaryPresent,
          ffmpegPresent: s.ffmpegPresent,
          libraryPath:   r.libraryPath,
          settings:      r.settings,
          enabled:       r.enabled,
        };
      })(),
      polaris: (() => {
        const s = getPolarisStatus();
        const r = all.polaris;
        return { name: 'polaris', state: s.state, port: s.port, error: s.error,
                 binaryPresent: s.binaryPresent, libraryPath: r.libraryPath,
                 settings: r.settings, enabled: r.enabled };
      })(),
      kavita: (() => {
        const ks = getKavitaStatus();
        return {
          name:          'kavita',
          state:         ks.state,
          port:          KAVITA_PORT,
          error:         ks.error,
          binaryPresent: ks.binaryPresent,
          libraryPath:   ks.docsPath,
          enabled:       true,  // kavita is always-on; enabled is implicit
          settings:      all.kavita.settings,
        };
      })(),
    });
  });

  // ── Per-service status ───────────────────────────────────────────────────
  fastify.get<{ Params: { name: string } }>(
    '/api/services/:name/status',
    async (req, reply) => {
      const name = req.params.name as ServiceName;
      const record = await store.get(name);

      if (name === 'meridian') {
        const s = getMeridianStatus();
        return reply.send({ ...s, settings: record.settings, enabled: record.enabled });
      }

      if (name === 'polaris') {
        const s = getPolarisStatus();
        return reply.send({ ...s, name: 'polaris', settings: record.settings, enabled: record.enabled });
      }

      if (name === 'jellyfin') {
        const s = getJellyfinStatus();
        return reply.send({ ...s, name: 'jellyfin', settings: record.settings, enabled: record.enabled });
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

      if (name === 'meridian') {
        if (!record.libraryPath) {
          return reply.status(400).send({ error: 'Set a library path before enabling Meridian.' });
        }
        // Non-blocking spawn — client polls /status.
        startMeridian({
          libraryPath:  record.libraryPath,
          idleEnabled:  Boolean(record.settings.idleClassifier ?? true),
        }).catch(err => {
          console.error('[services] Meridian start failed:', err.message);
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

      if (name === 'jellyfin') {
        if (!isJellyfinBinaryPresent()) {
          return reply.status(400).send({
            error: 'Jellyfin binary not found. Run: node scripts/fetch-jellyfin.js',
            binaryPresent: false,
          });
        }
        const adminPassword = (record.settings.adminPassword as string) || '';
        if (!adminPassword) {
          return reply.status(500).send({ error: 'No admin password in settings — check ServiceStore.' });
        }
        startJellyfin(
          {
            libraryPath:   record.libraryPath,
            hardwareAccel: (record.settings.hardwareAccel as string) || '',
          },
          adminPassword,
        ).catch(err => {
          console.error('[services] Jellyfin start failed:', err.message);
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

      if (name === 'meridian') {
        await stopMeridian();
        return reply.send({ ok: true, state: 'stopped' });
      }

      if (name === 'polaris') {
        await stopPolaris();
        return reply.send({ ok: true, state: 'stopped' });
      }

      if (name === 'jellyfin') {
        await stopJellyfin();
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

      // If Meridian is running and the library path changed, restart it.
      if (name === 'meridian' && record.enabled) {
        const status = getMeridianStatus();
        if (status.state === 'running' && record.libraryPath) {
          stopMeridian().then(() => {
            startMeridian({
              libraryPath:  record.libraryPath!,
              idleEnabled:  Boolean(record.settings.idleClassifier ?? true),
            }).catch(err => console.error('[services] Meridian restart failed:', err.message));
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

      // If Jellyfin is running and the config changed, restart it.
      if (name === 'jellyfin' && record.enabled) {
        const status = getJellyfinStatus();
        if (status.state === 'running') {
          const adminPassword = record.settings.adminPassword as string;
          stopJellyfin().then(() => {
            startJellyfin(
              {
                libraryPath:   record.libraryPath,
                hardwareAccel: (record.settings.hardwareAccel as string) || '',
              },
              adminPassword,
            ).catch(err => console.error('[services] Jellyfin restart failed:', err.message));
          });
        }
      }

      return reply.send({ ok: true, record });
    }
  );

  // ── Meridian: reindex ──────────────────────────────────────────────────
  fastify.post('/api/services/meridian/scan', async (_req, reply) => {
    try {
      // Trigger scan via Meridian's own API (gets real library ids from its DB)
      const res = await meridianApiRequest('GET', '/api/libraries');
      if (!res.ok) throw new Error(`Meridian API error: HTTP ${res.status}`);
      const { libraries } = await res.json() as { libraries: Array<{ id: string }> };
      await Promise.all(
        libraries.map(lib => meridianApiRequest('POST', `/api/libraries/${lib.id}/scan`))
      );
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(503).send({ error: (err as Error).message });
    }
  });

  // ── Meridian: reverse proxy ────────────────────────────────────────────
  // Forwards any request to the local Meridian instance. No auth token
  // injection needed — Meridian runs localhost-only.
  // in PHOBOS's default configuration.
  // Media bytes (thumbnails, full images) are streamed through to avoid
  // buffering entire files in Node.js.
  fastify.all<{
    Params: { '*': string };
    Querystring: Record<string, string>;
  }>(
    '/api/services/meridian/proxy/*',
    { config: { rawBody: false } } as any,
    async (req: FastifyRequest, reply: FastifyReply) => {
      const status = getMeridianStatus();
      if (status.state !== 'running') {
        return reply.status(503).send({ error: 'Meridian is not running' });
      }

      const wildcard = (req.params as any)['*'] as string;
      const query    = new URLSearchParams(req.query as Record<string, string>).toString();

      const upstreamRes = await meridianApiRequest(
        req.method,
        '/' + wildcard + (query ? '?' + query : ''),
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
    const execFileAsync = promisify(execFile);
    // __dirname is provided natively by the CJS bundle target (esbuild format:'cjs').
    // Do NOT use fileURLToPath(import.meta.url) — it emits an empty-import-meta
    // warning at bundle time.
    const scriptsDir = path.join(__dirname, '..', 'scripts');
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

  // ── Jellyfin: scan ────────────────────────────────────────────────────────
  fastify.post('/api/services/jellyfin/scan', async (_req, reply) => {
    try {
      await triggerJellyfinScan();
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(503).send({ error: (err as Error).message });
    }
  });

  // ── Jellyfin: stats ───────────────────────────────────────────────────────
  fastify.get('/api/services/jellyfin/stats', async (_req, reply) => {
    const { getStats } = await import('../services/JellyfinManager.js');
    try {
      const stats = await getStats();
      return reply.send(stats);
    } catch (err) {
      return reply.status(503).send({ error: (err as Error).message });
    }
  });

  // ── Jellyfin: REST API reverse proxy ──────────────────────────────────────
  // Forwards any Jellyfin API call with MediaBrowser auth header injected
  // server-side. Streams transcoded video/audio through without buffering.
  fastify.all<{
    Params: { '*': string };
    Querystring: Record<string, string>;
  }>(
    '/api/services/jellyfin/proxy/*',
    { config: { rawBody: false } } as any,
    async (req: FastifyRequest, reply: FastifyReply) => {
      const status = getJellyfinStatus();
      if (status.state !== 'running') {
        return reply.status(503).send({ error: 'Jellyfin is not running' });
      }

      const wildcard = (req.params as any)['*'] as string;
      const rawQuery = (req.raw.url ?? '').split('?')[1] ?? '';
      const endpoint = `/${wildcard}` + (rawQuery ? '?' + rawQuery : '');

      const upstreamRes = await jellyfinApiRequest(
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

  // ── Jellyfin: fetch binary (server-side download + extract) ───────────────
  // Longer timeout (15 min) — downloads both the Jellyfin server and FFmpeg.
  fastify.post('/api/services/jellyfin/fetch-binary', async (_req, reply) => {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const path = await import('path');
    const execFileAsync = promisify(execFile);
    // __dirname is provided natively by the CJS bundle target.
    const scriptsDir = path.join(__dirname, '..', 'scripts');
    try {
      await execFileAsync('node', [path.join(scriptsDir, 'fetch-jellyfin.js')], {
        env:     { ...process.env },
        timeout: 15 * 60 * 1000, // 15 min — server + ffmpeg
      });
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Jellyfin: uninstall ───────────────────────────────────────────────────
  fastify.post('/api/services/jellyfin/uninstall', async (_req, reply) => {
    const fs   = await import('fs');
    const path = await import('path');
    const os   = await import('os');
    const dir  = path.join(os.homedir(), '.phobos', 'services', 'jellyfin');
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });
}
