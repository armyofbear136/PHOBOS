/**
 * WebRTCServer.ts — RTCPeerConnection lifecycle for phobos-core.
 *
 * One PeerConnection per active mobile session (E2: owner only).
 * Accepts offers from SignalingClient, generates answers, opens three data
 * channels, hands them to DataChannelHandler.
 *
 * node-datachannel is used for Node.js RTCPeerConnection support.
 * Install: npm install node-datachannel
 */

import * as NodeDataChannel from 'node-datachannel';
import type { PeerConnection, DataChannel, IceServer } from 'node-datachannel';
import { DescriptionType } from 'node-datachannel';
import type { SignalingClient } from './SignalingClient.js';
import type { SignalOffer, SignalIce } from './RemoteProtocol.js';
import { DataChannelHandler } from './DataChannelHandler.js';
import type { FastifyInstance } from 'fastify';
import { DatabaseManager } from '../db/DatabaseManager.js';

export interface WebRTCServerOptions {
  fastify:          FastifyInstance;
  signalingClient:  SignalingClient;
  systemDb:         DatabaseManager;
  onConnected:      () => void;
  onDisconnected:   () => void;
}

interface SessionState {
  pc:              PeerConnection;
  handler:         DataChannelHandler;
  controlDC:       DataChannel | null;
  mediaIndexDC:    DataChannel | null;
  mediaUploadDC:   DataChannel | null;
  openCount:       number;
  code:            string;
}

export class WebRTCServer {
  private _session: SessionState | null = null;
  private _pendingIce: SignalIce[]      = [];

  constructor(private readonly opts: WebRTCServerOptions) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  getStatus(): {
    connected:    boolean;
    iceState:     string;
    channels:     { control: boolean; mediaIndex: boolean; mediaUpload: boolean };
  } {
    if (!this._session) {
      return { connected: false, iceState: 'closed',
               channels: { control: false, mediaIndex: false, mediaUpload: false } };
    }
    const s = this._session;
    return {
      connected:  s.openCount === 3,
      iceState:   s.pc.state(),
      channels: {
        control:     s.controlDC   !== null,
        mediaIndex:  s.mediaIndexDC  !== null,
        mediaUpload: s.mediaUploadDC !== null,
      },
    };
  }

  /** Called by SignalingClient when mobile sends an offer. */
  async handleOffer(offer: SignalOffer): Promise<void> {
    // Tear down any existing session first
    this._teardown();

    const iceServers = this.opts.signalingClient.getIceServers()
      .flatMap(s => (Array.isArray(s.urls) ? s.urls : [s.urls])
        .map(url => ({
          hostname: new URL(url).hostname,
          port:     parseInt(new URL(url).port || '3478', 10),
          username: s.username ?? '',
          password: (s as { credential?: string }).credential ?? '',
          relayType: url.startsWith('turn') ? 'TurnTls' : undefined,
        }))) as IceServer[];

    const pc = new NodeDataChannel.PeerConnection(`phobos-host-${offer.code}`, {
      iceServers,
    });

    const handler = new DataChannelHandler({
      fastify:   this.opts.fastify,
      systemDb:  this.opts.systemDb,
      relayCode: offer.code,
    });

    const session: SessionState = {
      pc, handler,
      controlDC:    null,
      mediaIndexDC: null,
      mediaUploadDC: null,
      openCount:    0,
      code:         offer.code,
    };
    this._session = session;

    // Wire ICE candidate emission
    pc.onLocalCandidate((candidate: string, mid: string) => {
      this.opts.signalingClient.sendIce(offer.code, candidate, mid, null);
    });

    pc.onStateChange((state: string) => {
      console.log(`[WebRTCServer] PeerConnection state: ${state}`);
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this._teardown();
        this.opts.onDisconnected();
      }
    });

    // Core is answerer — data channels are created by mobile (offerer)
    // and arrive here via onDataChannel
    pc.onDataChannel((dc: DataChannel) => {
      this._acceptDataChannel(session, dc);
    });

    // Set remote description and generate answer
    pc.setRemoteDescription(offer.sdp, DescriptionType.Offer);
    const answerSdp = pc.localDescription()?.sdp;
    if (!answerSdp) {
      console.error('[WebRTCServer] Failed to generate answer SDP');
      this._teardown();
      return;
    }

    this.opts.signalingClient.sendAnswer(offer.code, answerSdp);

    // Drain any ICE candidates that arrived before the session was ready
    for (const ice of this._pendingIce) {
      if (ice.code === offer.code) {
        pc.addRemoteCandidate(ice.candidate, ice.sdpMid ?? '');
      }
    }
    this._pendingIce = [];
  }

  /** Called by SignalingClient when relay forwards a trickle ICE candidate. */
  addIceCandidate(ice: SignalIce): void {
    if (this._session && this._session.code === ice.code) {
      this._session.pc.addRemoteCandidate(ice.candidate, ice.sdpMid ?? '');
    } else {
      // Offer may not have been processed yet — buffer
      this._pendingIce.push(ice);
    }
  }

  /** Gracefully disconnect the current session. */
  disconnect(): void {
    this._teardown();
    this.opts.onDisconnected();
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private _acceptDataChannel(session: SessionState, dc: DataChannel): void {
    const label = dc.getLabel();
    console.log(`[WebRTCServer] Data channel opened: ${label}`);

    switch (label) {
      case 'phobos-control':
        session.controlDC = dc;
        session.handler.attachControlChannel(dc);
        break;
      case 'phobos-media-index':
        session.mediaIndexDC = dc;
        session.handler.attachMediaIndexChannel(dc);
        break;
      case 'phobos-media-upload':
        session.mediaUploadDC = dc;
        session.handler.attachMediaUploadChannel(dc);
        break;
      default:
        console.warn(`[WebRTCServer] Unknown data channel: ${label}`);
        return;
    }

    dc.onOpen(() => {
      session.openCount++;
      if (session.openCount === 3) {
        console.log('[WebRTCServer] All channels open — session CONNECTED');
        this.opts.onConnected();
      }
    });

    dc.onClosed(() => {
      session.openCount = Math.max(0, session.openCount - 1);
    });

    dc.onError((err) => {
      console.error(`[WebRTCServer] ${label} channel error:`, err);
    });
  }

  private _teardown(): void {
    if (!this._session) return;
    const s = this._session;
    this._session = null;
    s.handler.destroy();
    try { s.controlDC?.close();    } catch { /* ignore */ }
    try { s.mediaIndexDC?.close(); } catch { /* ignore */ }
    try { s.mediaUploadDC?.close(); } catch { /* ignore */ }
    try { s.pc.close();            } catch { /* ignore */ }
  }
}