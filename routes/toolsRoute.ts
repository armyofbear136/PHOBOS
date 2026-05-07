import * as fs from 'node:fs';
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
  BLOCKBENCH_DIR,
} from '../services/BlockbenchManager.js';
import {
  getSculptGLStatus,
  SCULPTGL_DIR,
} from '../services/SculptGLManager.js';
import {
  getGodotStatus,
  GODOT_DIR,
} from '../services/GodotManager.js';
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
          // CORP: cross-origin lets the Vite parent (different port = different
          // origin) embed Stirling resources. Spring Boot doesn't set this header.
          reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
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
 
  // Registered unconditionally — the directory always exists after DepPrep runs.
  // The status endpoint tells the frontend when the build isn't present yet.
  // Gating on isBuildPresent() caused the route to never register when DepPrep
  // ran its install after registerToolsRoutes had already executed at startup.
  fs.mkdirSync(BLOCKBENCH_DIR, { recursive: true });
  await fastify.register(fastifyStatic, {
    root:          BLOCKBENCH_DIR,
    prefix:        '/tools/blockbench/',
    decorateReply: false,
    setHeaders: (res) => {
      // CORP: cross-origin required — Vite parent is :5173, this serves from
      // :3001. Different port = different origin. Parent COEP: require-corp
      // blocks any cross-origin resource that doesn't declare CORP.
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  });

  // ── SculptGL static serving ───────────────────────────────────────────────
  // GET /api/tools/sculptgl/status → SculptGLStatus
  // GET /tools/sculptgl/*          → static files from SCULPTGL_DIR

  fastify.get('/api/tools/sculptgl/status', async (_req, reply) => {
    return reply.send(getSculptGLStatus());
  });

  fs.mkdirSync(SCULPTGL_DIR, { recursive: true });
  await fastify.register(fastifyStatic, {
    root:          SCULPTGL_DIR,
    prefix:        '/tools/sculptgl/',
    decorateReply: false,
    setHeaders: (res) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  });

  // ── Godot 4.6.2 Web Editor ────────────────────────────────────────────────
  // GET /api/tools/godot/status → GodotStatus
  // GET /tools/godot/*          → static files from GODOT_DIR
  //
  // Godot requires SharedArrayBuffer (Wasm threads), which requires the page to
  // be cross-origin isolated. COOP/COEP headers are applied globally in the
  // server bootstrap so the PHOBOS parent page is also cross-origin isolated.
  // The setHeaders hook here is belt-and-suspenders for the /tools/godot/ prefix.

  fastify.get('/api/tools/godot/status', async (_req, reply) => {
    return reply.send(getGodotStatus());
  });

  fs.mkdirSync(GODOT_DIR, { recursive: true });

  // Intercept Godot's service worker BEFORE @fastify/static serves the real file.
  // Godot ships service.worker.js to add COOP/COEP headers to its own fetches.
  // Under the Vite proxy with COEP: require-corp already set globally, the SW's
  // internal fetch() calls fail (COEP rejects opaque SW responses), producing
  // "FetchEvent resulted in a network error" and crashing the godot iframe.
  // A no-op SW installs immediately, does nothing, and lets the browser's normal
  // fetch pipeline (which already has the right headers from the server) handle all
  // requests. Cache-Control: no-store prevents any stale copy from persisting.
  fastify.get('/tools/godot/service.worker.js', async (_req, reply) => {
    reply
      .header('Content-Type',              'text/javascript; charset=utf-8')
      .header('Cache-Control',             'no-store')
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .send('// no-op: COOP/COEP headers are already set by the Fastify static server.\n');
  });

  await fastify.register(fastifyStatic, {
    root:          GODOT_DIR,
    prefix:        '/tools/godot/',
    decorateReply: false,
    setHeaders: (res) => {
      res.setHeader('Cross-Origin-Opener-Policy',   'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  });

}