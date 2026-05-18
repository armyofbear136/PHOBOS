/**
 * SignalingClient.ts — persistent WebSocket to the autarch.net signaling relay.
 *
 * Responsibilities:
 *   - Connect to wss://autarch.net/relay on boot (non-fatal if unreachable)
 *   - Send { type: 'register', activeUser: 'owner' } → receive { type: 'registered', code, iceServers }
 *   - Hold the code and iceServers; expose them via getCode() / getIceServers()
 *   - When an offer arrives, call onOffer()
 *   - Relay trickle ICE candidates both ways
 *   - Reconnect with exponential backoff on drop; re-register on reconnect
 *   - Write relay connectivity into WebRTCServer so /api/webrtc/status is accurate
 */

import { WebSocket } from 'ws';
import type { RelayInbound, RelayOutbound, SignalOffer, SignalIce } from './RemoteProtocol.js';

export interface SignalingClientOptions {
  relayUrl:        string;
  activeUser:      string;
  instanceId:      string;
  onOffer:         (offer: SignalOffer) => void;
  onIce:           (candidate: SignalIce) => void;
  onCode:          (code: string, iceServers: RTCIceServer[]) => void;
  onRelayConnect:  () => void;
  onRelayDisconnect: () => void;
}

const BACKOFF_INIT_MS    = 1_000;
const BACKOFF_MAX_MS     = 30_000;
// On first connect, wait up to this long for the relay to wake (render.com cold start).
const STARTUP_GRACE_MS   = 5 * 60 * 1_000;   // 5 minutes

export class SignalingClient {
  private _ws:             WebSocket | null = null;
  private _code:           string | null    = null;
  private _iceServers:     RTCIceServer[]   = [];
  private _backoffMs:      number           = BACKOFF_INIT_MS;
  private _destroyed:      boolean          = false;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _pingTimer:      ReturnType<typeof setInterval> | null = null;
  // Deadline for first successful registration — relay gets STARTUP_GRACE_MS to wake up.
  private _startupDeadline: number          = Date.now() + STARTUP_GRACE_MS;
  private _registered:      boolean         = false;

  constructor(private readonly opts: SignalingClientOptions) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  getCode(): string | null        { return this._code; }
  getRelayUrl(): string           { return this.opts.relayUrl; }
  getIceServers(): RTCIceServer[] { return this._iceServers; }

  connect(): void {
    if (this._destroyed) return;
    this._open();
  }

  /** Send an answer SDP back to the relay for forwarding to mobile. */
  sendAnswer(code: string, sdp: string): void {
    this._send({ type: 'answer', code, sdp });
  }

  /** Send a trickle ICE candidate to the relay. */
  sendIce(code: string, candidate: string, sdpMid: string | null, sdpMLineIndex: number | null): void {
    this._send({ type: 'ice', code, candidate, sdpMid, sdpMLineIndex });
  }

  /** Refresh the access code — close current registration and re-register. */
  refresh(): void {
    this._code = null;
    this._iceServers = [];
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._register();
    }
  }

  destroy(): void {
    this._destroyed = true;
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._pingTimer !== null) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    this._ws?.close();
    this._ws = null;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private _open(): void {
    if (this._destroyed) return;

    try {
      this._ws = new WebSocket(this.opts.relayUrl);
    } catch (err) {
      console.warn('[SignalingClient] Failed to create WebSocket:', (err as Error).message);
      this._scheduleReconnect();
      return;
    }

    this._ws.on('open', () => {
      console.log('[SignalingClient] Connected to relay');
      this._backoffMs = BACKOFF_INIT_MS;
      this.opts.onRelayConnect();
      this._register();
      // Keep the WebSocket alive through hosting-provider idle timeouts (typically 60s).
      this._pingTimer = setInterval(() => {
        if (this._ws?.readyState === WebSocket.OPEN) {
          this._ws.ping();
        }
      }, 20_000);
    });

    this._ws.on('message', (raw: Buffer | string) => {
      let msg: RelayInbound;
      try {
        msg = JSON.parse(raw.toString()) as RelayInbound;
      } catch {
        return;
      }
      this._handle(msg);
    });

    this._ws.on('close', () => {
      console.warn('[SignalingClient] Relay WebSocket closed');
      this.opts.onRelayDisconnect();
      if (this._pingTimer !== null) { clearInterval(this._pingTimer); this._pingTimer = null; }
      this._ws = null;
      this._scheduleReconnect();
    });

    this._ws.on('error', (err) => {
      console.warn('[SignalingClient] Relay WebSocket error:', err.message);
      // 'close' fires after 'error' — reconnect is handled there
    });
  }

  private _register(): void {
    const msg: RelayOutbound = { type: 'register', instanceId: this.opts.instanceId, activeUser: this.opts.activeUser };
    this._send(msg);
  }

  private _handle(msg: RelayInbound): void {
    switch (msg.type) {
      case 'registered':
        this._code       = msg.code;
        this._iceServers = msg.iceServers;
        this._registered = true;
        console.log(`[SignalingClient] Registered instanceId: ${msg.code}${msg.expiresIn ? ` (expires in ${msg.expiresIn / 1000}s)` : ' (permanent)'}`);
        this.opts.onCode(msg.code, msg.iceServers);
        break;

      case 'offer':
        console.log(`[SignalingClient] Offer received for code ${msg.code}`);
        this.opts.onOffer(msg);
        break;

      case 'ice':
        this.opts.onIce(msg);
        break;

      case 'consumed':
        // Code was consumed — relay will issue a new one automatically after ICE STABLE
        console.log(`[SignalingClient] Code ${msg.code} consumed`);
        break;
    }
  }

  private _send(msg: RelayOutbound): void {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    }
  }

  private _scheduleReconnect(): void {
    if (this._destroyed) return;
    const delay = this._backoffMs;
    this._backoffMs = Math.min(this._backoffMs * 2, BACKOFF_MAX_MS);

    const withinGrace = !this._registered && Date.now() < this._startupDeadline;
    const remaining   = Math.round((this._startupDeadline - Date.now()) / 1000);
    if (withinGrace) {
      console.log(`[SignalingClient] Relay not yet reachable — retrying in ${delay / 1000}s (grace window: ${remaining}s remaining)`);
    } else {
      console.log(`[SignalingClient] Reconnecting in ${delay / 1000}s`);
    }

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._open();
    }, delay);
  }
}