import { type FastifyInstance } from 'fastify';
import * as http from 'http';
import {
  startCamofox,
  stopCamofox,
  getCamofoxStatus,
} from '../phobos/CamofoxManager.js';
import {
  startStirling,
  stopStirling,
  getStirlingStatus,
  STIRLING_PORT,
} from '../services/StirlingManager.js';
import {
  startOmniclip,
  stopOmniclip,
  getOmniclipStatus,
} from '../services/OmniclipManager.js';
import {
  getBlockbenchStatus,
  isBuildPresent,
  BLOCKBENCH_DIR,
} from '../services/BlockbenchManager.js';
import fastifyStatic from '@fastify/static';

export async function registerToolsRoutes(fastify: FastifyInstance): Promise<void> {

  // ── Camofox web browser routes ────────────────────────────────────────────
  // GET  /api/tools/camofox/status  → state, port, pid, error
  // POST /api/tools/camofox/start   → start the browser server
  // POST /api/tools/camofox/stop    → graceful stop

  fastify.get('/api/tools/camofox/status', async (_req, reply) => {
    reply.send(getCamofoxStatus());
  });

  fastify.post('/api/tools/camofox/start', async (_req, reply) => {
    const before = getCamofoxStatus();
    if (before.state === 'running') {
      return reply.send({ ok: true, message: 'Already running', ...before });
    }
    try {
      await startCamofox();
      reply.send({ ok: true, ...getCamofoxStatus() });
    } catch (err) {
      reply.status(500).send({ ok: false, error: (err as Error).message });
    }
  });

  fastify.post('/api/tools/camofox/stop', async (_req, reply) => {
    try {
      await stopCamofox();
      reply.send({ ok: true, ...getCamofoxStatus() });
    } catch (err) {
      reply.status(500).send({ ok: false, error: (err as Error).message });
    }
  });

  // ── Stirling PDF routes ───────────────────────────────────────────────────
  // GET  /api/tools/stirling/status   → state, port, binaryPresent
  // POST /api/tools/stirling/start    → start the Spring Boot process
  // POST /api/tools/stirling/stop     → graceful stop
  // ANY  /api/tools/stirling/app/*    → transparent proxy to :16346

  fastify.get('/api/tools/stirling/status', async (_req, reply) => {
    reply.send(getStirlingStatus());
  });

  fastify.post('/api/tools/stirling/start', async (_req, reply) => {
    if (getStirlingStatus().state === 'running') {
      return reply.send({ ok: true, message: 'Already running', ...getStirlingStatus() });
    }
    try {
      await startStirling();
      reply.send({ ok: true, ...getStirlingStatus() });
    } catch (err) {
      reply.status(500).send({ ok: false, error: (err as Error).message });
    }
  });

  fastify.post('/api/tools/stirling/stop', async (_req, reply) => {
    try {
      await stopStirling();
      reply.send({ ok: true, ...getStirlingStatus() });
    } catch (err) {
      reply.status(500).send({ ok: false, error: (err as Error).message });
    }
  });

  // Transparent proxy to Stirling PDF's Spring Boot UI.
  // Stirling serves a full SPA — forward everything including file uploads.
  // We use req.body (Buffer for binary/multipart, string for text) since Fastify
  // may have consumed req.raw by the time the handler runs. GET requests and
  // browser navigation have no body — proxy.end() with nothing is correct for those.
  fastify.all('/api/tools/stirling/app/*', async (req, reply) => {
    const wildcard = (req.params as Record<string, string>)['*'] ?? '';
    const upstreamPath = `/${wildcard}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`;

    return new Promise<void>((resolve) => {
      const proxy = http.request(
        { host: '127.0.0.1', port: STIRLING_PORT, path: upstreamPath, method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${STIRLING_PORT}` } },
        (upstream) => {
          reply.status(upstream.statusCode ?? 200);
          // Hop-by-hop headers must not be forwarded — they are connection-specific
          // and cause issues when Fastify re-encodes the response body.
          const HOP_BY_HOP = new Set([
            'transfer-encoding', 'connection', 'keep-alive',
            'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'upgrade',
          ]);
          for (const [k, v] of Object.entries(upstream.headers)) {
            if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) {
              reply.header(k, v as string);
            }
          }
          const chunks: Buffer[] = [];
          upstream.on('data', (c: Buffer) => chunks.push(c));
          upstream.on('end', () => {
            let body = Buffer.concat(chunks);
            const ct = (upstream.headers['content-type'] ?? '');

            // Rewrite absolute paths in HTML so the SPA works under our prefix
            if (ct.includes('html')) {
              const patched = body.toString('utf8')
                .replace(/(href|src|action)="\//g, `$1="/api/tools/stirling/app/`);
              body = Buffer.from(patched, 'utf8');
              reply.header('content-length', body.length);
            }

            reply.send(body);
            resolve();
          });
          upstream.on('error', () => { reply.status(502).send(); resolve(); });
        }
      );
      proxy.on('error', (err) => {
        reply.status(502).send({ error: 'Stirling proxy error', detail: err.message });
        resolve();
      });
      // Fastify may have consumed req.raw for parsed content types (JSON).
      // For multipart/binary uploads req.body is a Buffer from the global parser.
      // Write whatever we have and end — Stirling handles both cases.
      const body = req.body;
      if (body instanceof Buffer && body.length > 0) {
        proxy.write(body);
      } else if (typeof body === 'string' && (body as string).length > 0) {
        proxy.write(body as string);
      }
      proxy.end();
    });
  });

  // GET  /api/tools/omniclip/status   → OmniclipStatus
  // POST /api/tools/omniclip/start    → start static server
  // POST /api/tools/omniclip/stop     → stop static server
 
  fastify.get('/api/tools/omniclip/status', async (_req, reply) => {
    return reply.send(getOmniclipStatus());
  });
 
  fastify.post('/api/tools/omniclip/start', async (_req, reply) => {
    const status = getOmniclipStatus();
    if (status.state === 'running') {
      return reply.send({ ok: true, message: 'Already running', ...status });
    }
    try {
      await startOmniclip();
      return reply.send({ ok: true, ...getOmniclipStatus() });
    } catch (err) {
      return reply.status(500).send({ ok: false, ...getOmniclipStatus(), error: (err as Error).message });
    }
  });
 
  fastify.post('/api/tools/omniclip/stop', async (_req, reply) => {
    try {
      await stopOmniclip();
      return reply.send({ ok: true, ...getOmniclipStatus() });
    } catch (err) {
      return reply.status(500).send({ ok: false, error: (err as Error).message });
    }
  });
  
  // ── Blockbench static serving ─────────────────────────────────────────────
  // GET /api/tools/blockbench/status → BlockbenchStatus
  // GET /tools/blockbench/*          → static files from BLOCKBENCH_DIR
 
  fastify.get('/api/tools/blockbench/status', async (_req, reply) => {
    return reply.send(getBlockbenchStatus());
  });
 
  // Only register the static route when the build is present. If it isn't,
  // the status endpoint above tells the frontend, which shows the install prompt.
  if (isBuildPresent()) {
    await fastify.register(fastifyStatic, {
      root:       BLOCKBENCH_DIR,
      prefix:     '/tools/blockbench/',
      decorateReply: false,  // avoid conflicts with other static registrations
    });
  }

 


}