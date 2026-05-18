/**
 * routes/syncProxy.ts — Transparent proxy for /api/sync/* to Meridian (port 16320).
 *
 * Why this file exists instead of using the existing /api/services/meridian/proxy/*:
 *   The generic proxy calls meridianApiRequest(), which hardcodes
 *   Content-Type: application/json and JSON.stringifies the body. That breaks
 *   POST /api/sync/upload, which sends raw binary (application/octet-stream)
 *   with metadata in headers and a body limit of 2 GB.
 *
 * This proxy:
 *   - Forwards all headers from the client (Authorization, X-Phobos-*, Content-Type)
 *   - Streams the raw request body directly to Meridian — no buffering, no parsing
 *   - Streams the Meridian response body directly back — no buffering
 *   - Handles CORS preflight (OPTIONS) inline
 *
 * Routes forwarded (all methods):
 *   /api/sync/register
 *   /api/sync/check
 *   /api/sync/upload
 *   /api/sync/policies
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getMeridianServerStatus } from '../meridian/server.js';
import { MERIDIAN_PORT }           from '../services/MeridianManager.js';
import http                        from 'node:http';
import { Readable }                from 'node:stream';

// Headers the proxy must NOT forward upstream (hop-by-hop or already set).
const SKIP_REQ_HEADERS = new Set([
  'host', 'connection', 'transfer-encoding', 'te',
  'trailer', 'upgrade', 'keep-alive', 'proxy-authorization',
]);

// Headers from the upstream response that the proxy must NOT forward downstream.
const SKIP_RES_HEADERS = new Set([
  'connection', 'transfer-encoding', 'keep-alive',
  'upgrade', 'trailer', 'te',
]);

export async function registerSyncProxyRoutes(fastify: FastifyInstance): Promise<void> {

  // ── CORS preflight ──────────────────────────────────────────────────────────
  // The main server's CORS plugin doesn't reach hijacked responses, so we
  // handle OPTIONS for the sync prefix explicitly.
  fastify.options('/api/sync/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const origin = req.headers.origin ?? '*';
    reply
      .header('Access-Control-Allow-Origin',  origin)
      .header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
      .header('Access-Control-Allow-Headers',
        'Content-Type, Authorization, ' +
        'X-Phobos-Library, X-Phobos-Filename, X-Phobos-Hash, ' +
        'X-Phobos-Taken-At, X-Phobos-Size, ' +
        'X-Phobos-Upload-Id, X-Phobos-Chunk-Index, X-Phobos-Chunk-Total')
      .header('Access-Control-Max-Age', '86400')
      .status(204)
      .send();
  });

  // ── All other methods ───────────────────────────────────────────────────────
  // Use addContentTypeParser to prevent Fastify from buffering the upload body.
  // Fastify's default application/octet-stream parser is already registered in
  // server.ts with a 256 MB limit — the sync/upload route on Meridian sets its
  // own 2 GB limit, so we must bypass Fastify's parser here and stream raw.
  //
  // Strategy: register the proxy handler for every HTTP method. Fastify does
  // not buffer if we access req.raw directly.

  const proxyHandler = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const status = getMeridianServerStatus();
    if (status.state !== 'running') {
      return reply.status(503).send({ error: 'Meridian is not running' });
    }

    // Strip the leading /api from the path — Meridian serves at /api/sync/*.
    const upstreamPath = req.url; // already includes /api/sync/...

    // Build upstream request headers, forwarding everything except hop-by-hop.
    const upstreamHeaders: Record<string, string> = {};
    for (const [key, val] of Object.entries(req.headers)) {
      if (SKIP_REQ_HEADERS.has(key.toLowerCase())) continue;
      if (val === undefined) continue;
      upstreamHeaders[key] = Array.isArray(val) ? val.join(', ') : val;
    }
    // Override host so Meridian's Fastify accepts the request.
    upstreamHeaders['host'] = `127.0.0.1:${MERIDIAN_PORT}`;

    // Determine body to forward.
    // JSON routes (register, check, policies): Fastify has already parsed req.body.
    //   We re-serialize it so Meridian receives valid JSON.
    // Binary upload route (upload): req.body is a Buffer from the octet-stream parser.
    //   We forward it directly.
    // GET / no-body methods: no body.
    const contentType = (req.headers['content-type'] ?? '').toLowerCase();
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';

    let bodyBuffer: Buffer | null = null;
    if (hasBody) {
      const raw = req.body;
      if (Buffer.isBuffer(raw)) {
        // Binary upload — forward as-is.
        bodyBuffer = raw;
      } else if (raw !== undefined && raw !== null) {
        // JSON body already parsed by Fastify — re-serialize.
        const serialized = JSON.stringify(raw);
        bodyBuffer = Buffer.from(serialized, 'utf8');
        upstreamHeaders['content-type']   = 'application/json';
        upstreamHeaders['content-length'] = String(bodyBuffer.byteLength);
      }
    }

    // Make the upstream request to Meridian.
    await new Promise<void>((resolve, reject) => {
      const options: http.RequestOptions = {
        hostname: '127.0.0.1',
        port:     MERIDIAN_PORT,
        path:     upstreamPath,
        method:   req.method,
        headers:  upstreamHeaders,
      };

      const upstream = http.request(options, (res) => {
        // Forward response status and headers downstream.
        // For WebRTC inject() paths, reply.raw is writable synchronously.
        // For real HTTP connections, hijack() is needed to bypass Fastify.
        const isRealConnection = !!(req.raw as any).socket;
        if (isRealConnection) reply.hijack();

        const origin = req.headers.origin ?? '*';
        const resHeaders: Record<string, string | string[]> = {
          'Access-Control-Allow-Origin': origin,
        };
        for (const [key, val] of Object.entries(res.headers)) {
          if (SKIP_RES_HEADERS.has(key.toLowerCase())) continue;
          if (val === undefined) continue;
          resHeaders[key] = val as string | string[];
        }

        reply.raw.writeHead(res.statusCode ?? 200, resHeaders);

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          reply.raw.end(body);
          resolve();
        });
        res.on('error', (err) => { reply.raw.end(); reject(err); });
      });

      upstream.on('error', reject);

      if (bodyBuffer) {
        upstream.end(bodyBuffer);
      } else {
        upstream.end();
      }
    });
  };

  // Register for every method. We never read req.body — proxyHandler streams
  // req.raw directly to Meridian, so no body-parser options are needed.
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    fastify[method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](
      '/api/sync/*',
      proxyHandler,
    );
  }
}