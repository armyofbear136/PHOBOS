import { type FastifyInstance } from 'fastify';
import * as http from 'http';
import * as net from 'net';
import {
  startBroadway,
  startBroadwayd,
  startGimp,
  stopBroadway,
  restartGimp,
  getBroadwayStatus,
  isBroadwaydPresent,
  isGimpPresent,
  BROADWAY_HTTP_PORT,
} from '../phobos/BroadwayManager.js';
import {
  startCamofox,
  stopCamofox,
  getCamofoxStatus,
} from '../phobos/CamofoxManager.js';

// ── /api/tools — GIMP / Broadway routes ──────────────────────────────────────
//
// GET  /api/tools/gimp/status                → broadwayd + GIMP state
// POST /api/tools/gimp/start                 → start broadwayd then GIMP
// POST /api/tools/gimp/stop                  → stop GIMP then broadwayd
// POST /api/tools/gimp/restart               → restart GIMP only
// ANY  /api/tools/gimp/broadway/*            → HTTP proxy to broadwayd :8080
//
// The Broadway HTML page loads broadway.js, which opens a WebSocket to
// ws://host/socket. We serve the HTML through PHOBOS and rewrite the WS URL
// in broadway.js to point back to PHOBOS (/api/tools/gimp/broadway/socket).
// PHOBOS then proxies that WS to broadwayd on port 8080 using a raw TCP
// tunnel — no external ws package needed, just Node.js net.Socket.
// ─────────────────────────────────────────────────────────────────────────────

// Rewrite broadway.js on-the-fly so the WS connects back to PHOBOS.
// Broadway's JS opens: new WebSocket("ws://" + location.host + "/socket")
// When served through PHOBOS at /api/tools/gimp/broadway/, location.host is
// localhost:3001 and the path resolves to /socket — which Fastify doesn't handle.
// We patch the script to use the full PHOBOS proxy path instead.
function rewriteBroadwayJs(js: string): string {
  // The Broadway 2.0 client opens: new WebSocket("ws://" + host + "/socket")
  // Rewrite to: new WebSocket("ws://" + host + "/api/tools/gimp/broadway/socket")
  return js
    .replace(/new WebSocket\s*\(\s*["\'](ws:\/\/.*)\["\']\/socket["\']/g, (m) => {
      return m; // handled by path rewrite below
    })
    .replace(
      /(\/socket["'`])/g,
      '/api/tools/gimp/broadway/socket$1'.replace(/\/socket["'`]/g, (_) => _)
    )
    // More targeted: replace "/socket" string literals in WS constructor
    .replace(/["']\/socket["\']/g, '"/api/tools/gimp/broadway/socket"');
}

export async function registerToolsRoutes(fastify: FastifyInstance): Promise<void> {

  // ── Status ────────────────────────────────────────────────────────────────
  fastify.get('/api/tools/gimp/status', async (_req, reply) => {
    const status = getBroadwayStatus();
    reply.send({
      ...status,
      // iframeUrl points at our proxy route — same origin as PHOBOS, no CORS block
      iframeUrl: status.broadwayd.state === 'running'
        ? `/api/tools/gimp/broadway/`
        : null,
      binaryPresent: {
        broadwayd: isBroadwaydPresent(),
        gimp:      isGimpPresent(),
      },
    });
  });

  // ── Start ─────────────────────────────────────────────────────────────────
  fastify.post('/api/tools/gimp/start', async (_req, reply) => {
    const status = getBroadwayStatus();
    if (status.broadwayd.state === 'running' && status.gimp.state === 'running') {
      return reply.send({ ok: true, message: 'Already running', ...status });
    }
    try {
      await startBroadway();
      reply.send({ ok: true, ...getBroadwayStatus() });
    } catch (err) {
      reply.status(500).send({ ok: false, error: (err as Error).message });
    }
  });

  // ── Start broadwayd only ─────────────────────────────────────────────────
  fastify.post('/api/tools/gimp/start-broadwayd', async (_req, reply) => {
    try {
      await startBroadwayd();
      reply.send({ ok: true, ...getBroadwayStatus() });
    } catch (err) {
      reply.status(500).send({ ok: false, error: (err as Error).message });
    }
  });

  // ── Start GIMP ────────────────────────────────────────────────────────────
  fastify.post('/api/tools/gimp/start-gimp', async (_req, reply) => {
    try {
      await startGimp();
      reply.send({ ok: true, ...getBroadwayStatus() });
    } catch (err) {
      reply.status(500).send({ ok: false, error: (err as Error).message });
    }
  });

  // ── Stop ──────────────────────────────────────────────────────────────────
  fastify.post('/api/tools/gimp/stop', async (_req, reply) => {
    try {
      await stopBroadway();
      reply.send({ ok: true, ...getBroadwayStatus() });
    } catch (err) {
      reply.status(500).send({ ok: false, error: (err as Error).message });
    }
  });

  // ── Restart GIMP ──────────────────────────────────────────────────────────
  fastify.post('/api/tools/gimp/restart', async (_req, reply) => {
    try {
      await restartGimp();
      reply.send({ ok: true, ...getBroadwayStatus() });
    } catch (err) {
      reply.status(500).send({ ok: false, error: (err as Error).message });
    }
  });

  // ── WebSocket tunnel: /api/tools/gimp/broadway/socket ────────────────────
  // Broadway's JS client opens a WebSocket to /socket. We intercept the HTTP
  // Upgrade at the raw server level and tunnel it to broadwayd:8080/socket.
  // This runs once after Fastify's server is ready.
  fastify.server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/api/tools/gimp/broadway/')) return;

    // Rewrite the upstream path: strip our prefix, restore /socket
    const upstreamPath = req.url.replace('/api/tools/gimp/broadway', '') || '/';

    // Open a raw TCP connection to broadwayd's HTTP port and forward the upgrade
    const upstream = net.connect(BROADWAY_HTTP_PORT, '127.0.0.1', () => {
      // Forward the original upgrade request with the rewritten path
      const headers = [
        `${req.method ?? 'GET'} ${upstreamPath} HTTP/1.1`,
        `Host: 127.0.0.1:${BROADWAY_HTTP_PORT}`,
        ...Object.entries(req.headers)
          .filter(([k]) => k !== 'host')
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v ?? ''}`),
        '',
        '',
      ].join('\r\n');

      upstream.write(headers);
      if (head?.length) upstream.write(head);

      // Bidirectional pipe: browser socket ↔ broadwayd
      upstream.pipe(socket);
      socket.pipe(upstream);
    });

    upstream.on('error', (err) => {
      console.warn('[Broadway WS tunnel] upstream error:', err.message);
      socket.destroy();
    });

    socket.on('error', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });

  // ── Broadway HTTP proxy ───────────────────────────────────────────────────
  // Proxies HTML, JS, images from broadwayd through PHOBOS.
  // broadway.js is rewritten so its WebSocket URL points back to PHOBOS.
  fastify.all('/api/tools/gimp/broadway/*', async (req, reply) => {
    const wildcard  = (req.params as Record<string, string>)['*'] ?? '';
    const qs        = req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '';
    const upstreamPath = `/${wildcard}${qs}` || '/';

    return new Promise<void>((resolve) => {
      const options: http.RequestOptions = {
        hostname: '127.0.0.1',
        port:     BROADWAY_HTTP_PORT,
        path:     upstreamPath,
        method:   req.method,
        headers:  { ...req.headers, host: `127.0.0.1:${BROADWAY_HTTP_PORT}` },
      };

      const proxy = http.request(options, (upstream) => {
        reply.status(upstream.statusCode ?? 200);

        // Forward headers, skip hop-by-hop
        const skip = new Set(['content-encoding', 'transfer-encoding', 'connection', 'keep-alive']);
        for (const [k, v] of Object.entries(upstream.headers)) {
          if (!skip.has(k.toLowerCase()) && v !== undefined) reply.header(k, v as string);
        }

        const chunks: Buffer[] = [];
        upstream.on('data', (c: Buffer) => chunks.push(c));
        upstream.on('end', () => {
          let body = Buffer.concat(chunks);
          const ct = (upstream.headers['content-type'] ?? '') as string;

          // Rewrite broadway.js so WebSocket connects back through PHOBOS
          if (ct.includes('javascript') || wildcard.endsWith('.js')) {
            const patched = body.toString('utf8').replace(
              /"\/socket"/g,
              '"/api/tools/gimp/broadway/socket"'
            );
            body = Buffer.from(patched, 'utf8');
            reply.header('content-length', body.length);
          }

          // Rewrite HTML so relative paths work under our proxy prefix
          if (ct.includes('html') || wildcard === '' || wildcard === 'index.html') {
            const patched = body.toString('utf8')
              .replace(/src="\/broadway\.js"/g, 'src="/api/tools/gimp/broadway/broadway.js"')
              .replace(/href="\/([^"]+)"/g, 'href="/api/tools/gimp/broadway/$1"');
            body = Buffer.from(patched, 'utf8');
            reply.header('content-length', body.length);
          }

          reply.send(body);
          resolve();
        });
        upstream.on('error', () => { reply.status(502).send(); resolve(); });
      });

      proxy.on('error', (err) => {
        reply.status(502).send({ error: 'Broadway proxy error', detail: err.message });
        resolve();
      });

      proxy.end();
    });
  });

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
}
