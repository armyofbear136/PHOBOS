/**
 * LocalSignalingServer.ts — in-process WebRTC signaling for LAN connections.
 *
 * Replaces the autarch.net relay when mobile and core are on the same network.
 * Three HTTP endpoints drive it:
 *   POST /api/webrtc/offer   — mobile submits offer SDP + bundled ICE candidates
 *   GET  /api/webrtc/signal  — SSE stream; core pushes answer + trickle ICE
 *   POST /api/webrtc/ice     — mobile trickle ICE → core PeerConnection
 *
 * One LAN session at a time (same constraint as the relay path).
 */

import { EventEmitter } from 'node:events';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LanOffer {
  deviceToken: string;
  sdp:         string;
  candidates:  RTCIceCandidateInit[];
}

export type SignalEvent =
  | { event: 'answer'; data: { sdp: string } }
  | { event: 'ice';    data: RTCIceCandidateInit }
  | { event: 'done';   data: Record<string, never> };

// RTCIceCandidateInit is a browser type — redeclare minimally for Node
interface RTCIceCandidateInit {
  candidate:     string;
  sdpMid:        string | null;
  sdpMLineIndex: number | null;
}

// ── LocalSignalingServer ──────────────────────────────────────────────────────

export class LocalSignalingServer extends EventEmitter {
  // Active device token — set when POST /api/webrtc/offer is received
  private _activeToken:  string | null        = null;
  private _pendingOffer: LanOffer | null       = null;

  // Queued events for the SSE stream — if the stream opens after answer fires
  private _queue:        SignalEvent[]         = [];
  private _streamActive  = false;
  private _streamEmitter = new EventEmitter();

  // ── Called by POST /api/webrtc/offer ───────────────────────────────────────

  submitOffer(deviceToken: string, sdp: string, candidates: RTCIceCandidateInit[]): void {
    // Cancel any prior session
    this._reset();
    this._activeToken  = deviceToken;
    this._pendingOffer = { deviceToken, sdp, candidates };
    this.emit('offer', this._pendingOffer);
    console.log('[LocalSignal] Offer received — waiting for WebRTCServer answer');
  }

  /** Returns the pending offer and clears it (consumed once). */
  consumeOffer(): LanOffer | null {
    const o = this._pendingOffer;
    this._pendingOffer = null;
    return o;
  }

  /** Returns the active device token so the route can validate it. */
  getActiveToken(): string | null {
    return this._activeToken;
  }

  // ── Called by WebRTCServer ─────────────────────────────────────────────────

  submitAnswer(sdp: string): void {
    console.log('[LocalSignal] Answer ready — pushing to SSE stream');
    this._pushEvent({ event: 'answer', data: { sdp } });
  }

  submitLocalIce(candidate: RTCIceCandidateInit): void {
    this._pushEvent({ event: 'ice', data: candidate });
  }

  signalDone(): void {
    console.log('[LocalSignal] ICE gathering complete — sending done');
    this._pushEvent({ event: 'done', data: {} });
    this._activeToken = null;
  }

  // ── Called by POST /api/webrtc/ice ────────────────────────────────────────

  submitRemoteIce(candidate: RTCIceCandidateInit): void {
    this.emit('remoteIce', candidate);
  }

  // ── Called by GET /api/webrtc/signal — returns async generator ────────────

  async *getEventStream(deviceToken: string): AsyncGenerator<SignalEvent> {
    if (deviceToken !== this._activeToken) {
      console.warn('[LocalSignal] SSE stream request with wrong token — rejected');
      return;
    }
    this._streamActive = true;

    // Drain anything already queued before the stream opened
    for (const ev of this._queue) {
      yield ev;
      if (ev.event === 'done') { this._streamActive = false; return; }
    }
    this._queue = [];

    // Then yield live events as they arrive
    while (true) {
      const ev: SignalEvent = await new Promise(res => {
        this._streamEmitter.once('event', res);
      });
      yield ev;
      if (ev.event === 'done') break;
    }
    this._streamActive = false;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _pushEvent(ev: SignalEvent): void {
    if (this._streamActive) {
      this._streamEmitter.emit('event', ev);
    } else {
      this._queue.push(ev);
    }
  }

  private _reset(): void {
    this._activeToken  = null;
    this._pendingOffer = null;
    this._queue        = [];
    this._streamActive = false;
    // Drain any waiting stream listener with a done event to unblock it
    this._streamEmitter.emit('event', { event: 'done', data: {} } satisfies SignalEvent);
    this._streamEmitter.removeAllListeners();
    this._streamEmitter = new EventEmitter();
  }
}
