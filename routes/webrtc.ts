/**
 * routes/webrtc.ts — WebRTC status, access code management, and LAN signaling.
 *
 * Relay routes:
 *   GET    /api/webrtc/code           → { instanceId, relayUrl, connected, relayConnected }
 *   GET    /api/webrtc/status         → full connection status object
 *   POST   /api/webrtc/refresh        → re-register with relay
 *   DELETE /api/webrtc/session        → disconnect the active WebRTC session
 *   POST   /api/webrtc/relay/enable   → connect to relay and persist preference
 *   POST   /api/webrtc/relay/disable  → disconnect from relay and persist preference
 *
 * LAN signaling routes:
 *   GET    /api/webrtc/ping           → { ok, instanceId }  — reachability probe, no auth
 *   POST   /api/webrtc/offer          → accepts { deviceToken, sdp, candidates[] } from mobile
 *   GET    /api/webrtc/signal         → SSE stream: answer SDP + trickle ICE → mobile
 *   POST   /api/webrtc/ice            → mobile trickle ICE → core PeerConnection
 */

import type { FastifyInstance } from 'fastify';
import type { SignalingClient }       from '../webrtc/SignalingClient.js';
import type { WebRTCServer }          from '../webrtc/WebRTCServer.js';
import type { LocalSignalingServer }  from '../webrtc/LocalSignalingServer.js';
import type { DatabaseManager }       from '../db/DatabaseManager.js';

export interface WebRTCRouteContext {
  signalingClient:  SignalingClient       | null;
  webrtcServer:     WebRTCServer          | null;
  localSignaling:   LocalSignalingServer  | null;
  instanceId:       string                | null;
  systemDb:         DatabaseManager       | null;
}

let _ctx: WebRTCRouteContext = {
  signalingClient: null,
  webrtcServer:    null,
  localSignaling:  null,
  instanceId:      null,
  systemDb:        null,
};

export function setWebRTCContext(ctx: WebRTCRouteContext): void {
  _ctx = ctx;
}

export async function registerWebRTCRoutes(fastify: FastifyInstance): Promise<void> {

  // ── Relay status routes ────────────────────────────────────────────────────

  fastify.get('/api/webrtc/code', async (_req, reply) => {
    const instanceId = _ctx.signalingClient?.getCode() ?? null;
    const relayUrl   = _ctx.signalingClient?.getRelayUrl() ?? null;
    const status     = _ctx.webrtcServer?.getStatus();
    return reply.send({
      instanceId,
      relayUrl,
      connected:      status?.connected ?? false,
      relayConnected: _ctx.signalingClient?.isRelayConnected() ?? false,
    });
  });

  fastify.get('/api/webrtc/status', async (_req, reply) => {
    const status = _ctx.webrtcServer?.getStatus() ?? {
      connected:  false,
      iceState:   'closed',
      channels:   { control: false, mediaIndex: false, mediaUpload: false },
    };

    let relayEnabled = true;
    if (_ctx.systemDb) {
      try {
        const rows = await _ctx.systemDb.query<{ value: string }>(
          `SELECT value FROM instance_config WHERE key = 'relay_enabled'`, [],
        );
        relayEnabled = rows.length === 0 || rows[0].value !== 'false';
      } catch { /* non-fatal — default to true */ }
    }

    return reply.send({
      connected:      status.connected,
      iceState:       status.iceState,
      channels:       status.channels,
      relayConnected: _ctx.signalingClient?.isRelayConnected() ?? false,
      relayEnabled,
      instanceId:     _ctx.instanceId ?? null,
    });
  });

  fastify.post('/api/webrtc/refresh', async (_req, reply) => {
    if (!_ctx.signalingClient) {
      return reply.status(503).send({ error: 'WebRTC not initialized' });
    }
    _ctx.signalingClient.refresh();
    return reply.send({ ok: true, message: 'Code refresh requested' });
  });

  fastify.delete('/api/webrtc/session', async (_req, reply) => {
    if (!_ctx.webrtcServer) {
      return reply.status(503).send({ error: 'WebRTC not initialized' });
    }
    _ctx.webrtcServer.disconnect();
    return reply.send({ ok: true });
  });

  // ── Relay toggle ───────────────────────────────────────────────────────────
  //
  // These routes connect or disconnect the relay WebSocket at runtime and
  // persist the preference to instance_config so it survives restarts.
  // The relay_enabled key is read in continueBootSequence before calling
  // signalingClient.connect().

  fastify.post('/api/webrtc/relay/enable', async (_req, reply) => {
    if (!_ctx.signalingClient) {
      return reply.status(503).send({ error: 'WebRTC not initialized' });
    }
    if (_ctx.systemDb) {
      await _ctx.systemDb.execWithParams(
        `INSERT INTO instance_config (key, value) VALUES ('relay_enabled', 'true')
         ON CONFLICT (key) DO UPDATE SET value = 'true'`,
        [],
      );
    }
    _ctx.signalingClient.connect();
    return reply.send({ ok: true, relayEnabled: true });
  });

  fastify.post('/api/webrtc/relay/disable', async (_req, reply) => {
    if (!_ctx.signalingClient) {
      return reply.status(503).send({ error: 'WebRTC not initialized' });
    }
    if (_ctx.systemDb) {
      await _ctx.systemDb.execWithParams(
        `INSERT INTO instance_config (key, value) VALUES ('relay_enabled', 'false')
         ON CONFLICT (key) DO UPDATE SET value = 'false'`,
        [],
      );
    }
    _ctx.signalingClient.destroy();
    return reply.send({ ok: true, relayEnabled: false });
  });

  // ── LAN signaling routes ───────────────────────────────────────────────────

  fastify.get('/api/webrtc/ping', async (_req, reply) => {
    return reply.send({ ok: true, instanceId: _ctx.instanceId ?? null });
  });

  fastify.post('/api/webrtc/offer', async (req, reply) => {
    if (!_ctx.webrtcServer || !_ctx.localSignaling) {
      return reply.status(503).send({ error: 'WebRTC not initialized' });
    }

    const body = req.body as {
      deviceToken: string;
      sdp:         string;
      candidates:  { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }[];
    };

    if (!body?.deviceToken || !body?.sdp) {
      return reply.status(400).send({ error: 'deviceToken and sdp required' });
    }

    _ctx.localSignaling.submitOffer(body.deviceToken, body.sdp, body.candidates ?? []);
    void _ctx.webrtcServer.handleLanOffer(body.sdp);

    for (const c of (body.candidates ?? [])) {
      _ctx.webrtcServer.addLanIceCandidate(c.candidate, c.sdpMid);
    }

    return reply.status(202).send({ ok: true });
  });

  fastify.get('/api/webrtc/signal', async (req, reply) => {
    if (!_ctx.localSignaling) {
      return reply.status(503).send({ error: 'LAN signaling not initialized' });
    }

    const token = (req.query as { token?: string }).token ?? '';
    if (!token) {
      return reply.status(400).send({ error: 'token query param required' });
    }

    const origin = req.headers.origin;
    if (origin) reply.raw.setHeader('Access-Control-Allow-Origin', origin);
    reply.raw.setHeader('Content-Type',  'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection',    'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders();

    for await (const ev of _ctx.localSignaling.getEventStream(token)) {
      reply.raw.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
      if (ev.event === 'done') break;
    }

    reply.raw.end();
  });

  fastify.post('/api/webrtc/ice', async (req, reply) => {
    if (!_ctx.webrtcServer) {
      return reply.status(503).send({ error: 'WebRTC not initialized' });
    }

    const body = req.body as {
      token:         string;
      candidate:     string;
      sdpMid:        string | null;
      sdpMLineIndex: number | null;
    };

    if (!body?.candidate) {
      return reply.status(400).send({ error: 'candidate required' });
    }

    _ctx.webrtcServer.addLanIceCandidate(body.candidate, body.sdpMid ?? null);
    return reply.send({ ok: true });
  });
}
