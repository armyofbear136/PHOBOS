/**
 * routes/webrtc.ts — WebRTC status and access code management endpoints.
 *
 * GET  /api/webrtc/code      → { code, expiresIn, connected }
 * GET  /api/webrtc/status    → full connection status object
 * POST /api/webrtc/refresh   → regenerate access code (does NOT disconnect existing session)
 * DELETE /api/webrtc/session → disconnect the active WebRTC session
 */

import type { FastifyInstance } from 'fastify';
import type { SignalingClient } from '../webrtc/SignalingClient.js';
import type { WebRTCServer }    from '../webrtc/WebRTCServer.js';

export interface WebRTCRouteContext {
  signalingClient: SignalingClient | null;
  webrtcServer:    WebRTCServer    | null;
}

// Module-level refs set by registerWebRTCRoutes — avoids circular import
let _ctx: WebRTCRouteContext = { signalingClient: null, webrtcServer: null };

export function setWebRTCContext(ctx: WebRTCRouteContext): void {
  _ctx = ctx;
}

export async function registerWebRTCRoutes(fastify: FastifyInstance): Promise<void> {

  fastify.get('/api/webrtc/code', async (_req, reply) => {
    const code = _ctx.signalingClient?.getCode() ?? null;
    const status = _ctx.webrtcServer?.getStatus();
    return reply.send({
      code,
      expiresIn:  code ? 600_000 : 0,    // relay TTL is 10 min
      connected:  status?.connected ?? false,
      relayConnected: code !== null,
    });
  });

  fastify.get('/api/webrtc/status', async (_req, reply) => {
    const status = _ctx.webrtcServer?.getStatus() ?? {
      connected:  false,
      iceState:   'closed',
      channels:   { control: false, mediaIndex: false, mediaUpload: false },
    };
    return reply.send({
      connected:      status.connected,
      iceState:       status.iceState,
      channels:       status.channels,
      relayConnected: (_ctx.signalingClient?.getCode() ?? null) !== null,
      accessCode:     _ctx.signalingClient?.getCode() ?? null,
    });
  });

  fastify.post('/api/webrtc/refresh', async (_req, reply) => {
    if (!_ctx.signalingClient) {
      return reply.status(503).send({ error: 'WebRTC not initialized' });
    }
    _ctx.signalingClient.refresh();
    // New code arrives asynchronously via the onCode callback — return immediately
    return reply.send({ ok: true, message: 'Code refresh requested' });
  });

  fastify.delete('/api/webrtc/session', async (_req, reply) => {
    if (!_ctx.webrtcServer) {
      return reply.status(503).send({ error: 'WebRTC not initialized' });
    }
    _ctx.webrtcServer.disconnect();
    return reply.send({ ok: true });
  });
}