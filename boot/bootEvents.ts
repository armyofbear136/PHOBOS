// routes/bootEvents.ts
//
// GET /api/boot/events
//
// SSE stream that pushes BootState snapshots to the frontend.
// The frontend holds this connection open during the splash screen.
// On phase === 'ready', the client performs a full page reload to enter PHOBOS.
//
// This route is registered before the Fastify listen() call — it must be
// reachable even while the server is still in boot phases.

import type { FastifyInstance } from 'fastify';
import { onBootStateChange, snapshot, isReady } from '../boot/BootState.js';

export async function registerBootEventsRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/boot/events', async (req, reply) => {
    const raw = reply.raw;

    raw.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      // Allow the frontend origin unconditionally — this endpoint is hit
      // before full CORS setup has mattered.
      'Access-Control-Allow-Origin': '*',
    });

    const send = (data: object) => {
      if (raw.destroyed) return;
      raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Push current state immediately so the client never waits for the next event.
    send(snapshot());

    // If already ready, close the stream — nothing left to report.
    if (isReady()) { raw.end(); return; }

    // Subscribe to future transitions.
    const unsub = onBootStateChange((s) => {
      send(s);
      if (s.phase === 'ready') {
        // Give the client one tick to read the event before closing.
        setImmediate(() => { if (!raw.destroyed) raw.end(); });
        unsub();
      }
    });

    // Clean up on client disconnect.
    req.raw.on('close', () => { unsub(); });
    req.raw.on('error', () => { unsub(); });

    // Keep-alive ping every 25 s so proxies / load balancers don't close idle streams.
    const ping = setInterval(() => {
      if (raw.destroyed) { clearInterval(ping); return; }
      raw.write(': ping\n\n');
    }, 25_000);

    req.raw.on('close', () => clearInterval(ping));

    // Fastify must not finalise the reply — we own the raw stream.
    await new Promise<void>((resolve) => raw.on('finish', resolve));
  });
}
