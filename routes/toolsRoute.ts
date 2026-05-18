import * as fs from 'node:fs';
import path from 'node:path';
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
  startBlockbench,
  stopBlockbench,
  getBlockbenchStatus,
  BLOCKBENCH_DIR,
} from '../services/BlockbenchManager.js';
import {
  startSculptGL,
  stopSculptGL,
  getSculptGLStatus,
  SCULPTGL_DIR,
} from '../services/SculptGLManager.js';
import {
  getGodotStatus,
  GODOT_DIR,
} from '../services/GodotManager.js';
import fastifyStatic from '@fastify/static';
import os from 'node:os';

// ── Monaco static dir ─────────────────────────────────────────────────────────
// Resolved in priority order:
//   1. PHOBOS_FRONTEND_DIST env var (set by electron main or .env)
//   2. Sibling dist/ relative to this file's compiled location (packaged layout)
//   3. CWD/dist (fallback for ts-node / dev)
function resolveMonacoDir(): string {
  if (process.env.PHOBOS_FRONTEND_DIST) {
    return path.join(process.env.PHOBOS_FRONTEND_DIST, 'monaco', 'vs');
  }
  // __dirname is dist/ in compiled output; dist/../dist = dist in packaged layout
  const sibling = path.join(__dirname, '..', 'dist', 'monaco', 'vs');
  if (fs.existsSync(sibling)) return sibling;
  return path.join(process.cwd(), 'dist', 'monaco', 'vs');
}

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
          const HOP_BY_HOP = new Set([
            'transfer-encoding', 'connection', 'keep-alive',
            'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'upgrade',
            'content-encoding',
            'content-length',
          ]);
          for (const [k, v] of Object.entries(upstream.headers)) {
            if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) {
              reply.header(k, v as string);
            }
          }
          reply.header('Cross-Origin-Opener-Policy',   'same-origin');
          reply.header('Cross-Origin-Embedder-Policy', 'require-corp');
          reply.header('Cross-Origin-Resource-Policy', 'cross-origin');

          const encoding = (upstream.headers['content-encoding'] ?? '').toLowerCase();
          const chunks: Buffer[] = [];
          upstream.on('data', (c: Buffer) => chunks.push(c));
          upstream.on('end', () => {
            const raw = Buffer.concat(chunks);
            const ct  = upstream.headers['content-type'] ?? '';

            const send = (body: Buffer) => {
              let out = body;
              if (ct.includes('html')) {
                const patched = out.toString('utf8')
                  .replace(/(href|src|action)="\/"/g, `$1="/api/tools/stirling/app/`);
                out = Buffer.from(patched, 'utf8');
              }
              reply.send(out);
              resolve();
            };

            if (encoding === 'gzip') {
              import('node:zlib').then(({ gunzip }) => {
                gunzip(raw, (err, decompressed) => {
                  if (err) { reply.status(502).send(); resolve(); return; }
                  send(decompressed);
                });
              });
            } else if (encoding === 'br') {
              import('node:zlib').then(({ brotliDecompress }) => {
                brotliDecompress(raw, (err, decompressed) => {
                  if (err) { reply.status(502).send(); resolve(); return; }
                  send(decompressed);
                });
              });
            } else if (encoding === 'deflate') {
              import('node:zlib').then(({ inflate }) => {
                inflate(raw, (err, decompressed) => {
                  if (err) { reply.status(502).send(); resolve(); return; }
                  send(decompressed);
                });
              });
            } else {
              send(raw);
            }
          });
          upstream.on('error', () => { reply.status(502).send(); resolve(); });
        }
      );
      proxy.on('error', (err) => {
        reply.status(502).send({ error: 'Stirling proxy error', detail: err.message });
        resolve();
      });
      const body = req.body;
      if (body instanceof Buffer && body.length > 0) {
        proxy.write(body);
      } else if (typeof body === 'string' && (body as string).length > 0) {
        proxy.write(body as string);
      }
      proxy.end();
    });
  });

  // ── Omniclip routes ───────────────────────────────────────────────────────
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
  // GET  /api/tools/blockbench/status → BlockbenchStatus
  // POST /api/tools/blockbench/start  → start (noop if already running via auto-start)
  // POST /api/tools/blockbench/stop   → stop
  // GET  /tools/blockbench/*          → static files from BLOCKBENCH_DIR
  //
  // Static files are served by Fastify on :3001, not Vite on :5173.
  // vite.config.ts no longer proxies /tools/blockbench — the iframe src points
  // to /tools/blockbench/ which routes directly to :3001 via the /api proxy.
  //
  // Wait — /tools/blockbench is NOT under /api. The iframe src must use the
  // Vite /tools/godot pattern: vite.config.ts proxies /tools/godot to :3001.
  // Blockbench and SculptGL use the same /tools/* prefix and are served by
  // @fastify/static on :3001 — reached via the Vite /tools/godot proxy ONLY
  // for godot. For blockbench/sculptgl the iframe src is an absolute URL:
  // http://localhost:3001/tools/blockbench/ — bypassing Vite entirely.
  // CORP: cross-origin on the response satisfies the parent page's COEP.

  fastify.get('/api/tools/blockbench/status', async (_req, reply) => {
    return reply.send(getBlockbenchStatus());
  });

  fastify.post('/api/tools/blockbench/start', async (_req, reply) => {
    const status = getBlockbenchStatus();
    if (status.state === 'running') {
      return reply.send({ ok: true, message: 'Already running', ...status });
    }
    try {
      await startBlockbench();
      return reply.send({ ok: true, ...getBlockbenchStatus() });
    } catch (err) {
      return reply.status(500).send({ ok: false, ...getBlockbenchStatus(), error: (err as Error).message });
    }
  });

  fastify.post('/api/tools/blockbench/stop', async (_req, reply) => {
    try {
      await stopBlockbench();
      return reply.send({ ok: true, ...getBlockbenchStatus() });
    } catch (err) {
      return reply.status(500).send({ ok: false, error: (err as Error).message });
    }
  });

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
  // GET  /api/tools/sculptgl/status → SculptGLStatus
  // POST /api/tools/sculptgl/start  → start
  // POST /api/tools/sculptgl/stop   → stop
  // GET  /tools/sculptgl/*          → static files from SCULPTGL_DIR

  fastify.get('/api/tools/sculptgl/status', async (_req, reply) => {
    return reply.send(getSculptGLStatus());
  });

  fastify.post('/api/tools/sculptgl/start', async (_req, reply) => {
    const status = getSculptGLStatus();
    if (status.state === 'running') {
      return reply.send({ ok: true, message: 'Already running', ...status });
    }
    try {
      await startSculptGL();
      return reply.send({ ok: true, ...getSculptGLStatus() });
    } catch (err) {
      return reply.status(500).send({ ok: false, ...getSculptGLStatus(), error: (err as Error).message });
    }
  });

  fastify.post('/api/tools/sculptgl/stop', async (_req, reply) => {
    try {
      await stopSculptGL();
      return reply.send({ ok: true, ...getSculptGLStatus() });
    } catch (err) {
      return reply.status(500).send({ ok: false, error: (err as Error).message });
    }
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

  // ── Monaco editor workers ─────────────────────────────────────────────────
  // Serves GET /monaco/vs/* from the frontend's built public/monaco/vs dir.
  // Monaco's loader.config({ paths: { vs: ENGINE_URL + '/monaco/vs' } }) in
  // MonacoPanel.tsx points here, bypassing the phobos:// custom protocol which
  // blob workers cannot importScripts() from in Electron.
  const MONACO_VS_DIR = resolveMonacoDir();
  if (fs.existsSync(MONACO_VS_DIR)) {
    await fastify.register(fastifyStatic, {
      root:          MONACO_VS_DIR,
      prefix:        '/monaco/vs/',
      decorateReply: false,
      setHeaders: (res, filePath) => {
        // Workers need correct MIME — .js files served as application/javascript
        // by default from @fastify/static, which is correct.
        // Allow cross-origin fetch from phobos:// renderer.
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      },
    });
  } else {
    fastify.log.warn(`[monaco] worker dir not found: ${MONACO_VS_DIR} — Monaco editor workers will fail`);
  }

}