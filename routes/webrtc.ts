/**
 * routes/webrtc.ts — WebRTC status and access code management endpoints.
 *
 * GET  /api/webrtc/code      → { instanceId, relayUrl, connected, relayConnected }
 * GET  /api/webrtc/status    → full connection status object
 * POST /api/webrtc/refresh   → re-register with relay (same instanceId, new WS)
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
    // instanceId is the permanent relay routing key — same as what was registered.
    // getCode() echoes back whatever the relay confirmed in the 'registered' message.
    const instanceId = _ctx.signalingClient?.getCode() ?? null;
    const relayUrl   = _ctx.signalingClient?.getRelayUrl() ?? null;
    const status     = _ctx.webrtcServer?.getStatus();
    return reply.send({
      instanceId,
      relayUrl,
      connected:      status?.connected ?? false,
      relayConnected: instanceId !== null,
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
      instanceId:     _ctx.signalingClient?.getCode() ?? null,
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