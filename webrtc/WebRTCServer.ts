/**
 * WebRTCServer.ts — RTCPeerConnection lifecycle for phobos-core.
 *
 * One PeerConnection per active mobile session (E2: owner only).
 * Accepts offers from SignalingClient, generates answers, opens three data
 * channels, hands them to DataChannelHandler.
 *
 * node-datachannel is loaded via createRequire anchored to process.execPath
 * so the SEA runtime resolves it from dist/node_modules/ rather than
 * treating it as a built-in module.
 */

import { createRequire } from 'node:module';
import type { PeerConnection, DataChannel, IceServer, RelayType } from 'node-datachannel';
import type { SignalingClient } from './SignalingClient.js';
import type { SignalOffer, SignalIce } from './RemoteProtocol.js';
import { DataChannelHandler } from './DataChannelHandler.js';
import type { LocalSignalingServer } from './LocalSignalingServer.js';
import type { FastifyInstance } from 'fastify';
import { DatabaseManager } from '../db/DatabaseManager.js';

// Loaded once on first handleOffer() call — avoids SEA built-in intercept.
// Uses __filename (CJS) so the SEA runtime resolves from dist/node_modules/.
let _ndc: typeof import('node-datachannel') | null = null;

function getNdc(): typeof import('node-datachannel') {
  if (_ndc) return _ndc;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const req = createRequire(typeof __filename !== 'undefined' ? __filename : process.execPath);
  _ndc = req('node-datachannel') as typeof import('node-datachannel');
  return _ndc;
}

export interface WebRTCServerOptions {
  fastify:           FastifyInstance;
  signalingClient:   SignalingClient;
  localSignaling?:   LocalSignalingServer;   // set when LAN signaling is active
  systemDb:          DatabaseManager;
  instanceId:        string;
  relayUrl:          string;
  onConnected:       () => void;
  onDisconnected:    () => void;
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
  private _session:    SessionState | null = null;
  private _pendingIce: SignalIce[]         = [];
  private _isLanSession = false;

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
    this._isLanSession = false;
    await this._handleOfferInternal(offer);
  }

  /**
   * Called by POST /api/webrtc/offer (LAN path).
   * Synthesizes a SignalOffer with a fixed code so the rest of the logic is identical.
   */
  async handleLanOffer(sdp: string): Promise<void> {
    this._isLanSession = true;
    await this._handleOfferInternal({ type: 'offer', activeUser: 'owner', code: 'lan-local', sdp, candidates: [] });
  }

  /** Called by SignalingClient when mobile sends an offer. */
  private async _handleOfferInternal(offer: SignalOffer): Promise<void> {
    // Tear down any existing session first
    this._teardown();

    // node-datachannel accepts ICE servers as plain URL strings (for STUN) or
    // IceServer objects (for TURN). Passing STUN as an object with hostname/port
    // is silently ignored by libdatachannel — it must be a string.
    function parseIceUrl(url: string): { hostname: string; port: number } {
      const withoutScheme = url.replace(/^(stun|stuns|turn|turns):\/?\/?/, '');
      const withoutParams = withoutScheme.split('?')[0];
      const lastColon     = withoutParams.lastIndexOf(':');
      if (lastColon !== -1 && !withoutParams.startsWith('[')) {
        return {
          hostname: withoutParams.slice(0, lastColon),
          port:     parseInt(withoutParams.slice(lastColon + 1), 10) || 3478,
        };
      }
      return { hostname: withoutParams, port: url.startsWith('stuns:') ? 5349 : 3478 };
    }

    const iceServers = this.opts.signalingClient.getIceServers()
      .flatMap(s => (Array.isArray(s.urls) ? s.urls : [s.urls])
        .map((url): string | IceServer => {
          if (url.startsWith('stun:') || url.startsWith('stuns:')) {
            return url; // STUN must be passed as a plain string
          }
          const { hostname, port } = parseIceUrl(url);
          return {
            hostname,
            port,
            username: s.username ?? '',
            password: (s as { credential?: string }).credential ?? '',
            relayType: (url.startsWith('turns:') ? 'TurnTls'
                     : url.includes('transport=tcp') ? 'TurnTcp'
                     : 'TurnUdp') as RelayType,
          };
        }));

    const ndc = getNdc();
    const pc = new ndc.PeerConnection(`phobos-host-${offer.code}`, {
      iceServers,
      enableIceTcp: true,
    });

    const handler = new DataChannelHandler({
      fastify:    this.opts.fastify,
      systemDb:   this.opts.systemDb,
      instanceId: this.opts.instanceId,
      relayUrl:   this.opts.relayUrl,
      relayCode:  offer.code,
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
      const bare = candidate.startsWith('a=') ? candidate.slice(2) : candidate;
      const sdpMid         = mid || null;
      const sdpMLineIndex  = mid ? null : 0;
      console.log(`[WebRTCServer] Local ICE mid=${mid || '(empty)'}: ${bare.substring(0, 80)}`);
      if (this._isLanSession) {
        this.opts.localSignaling?.submitLocalIce({
          candidate:     bare,
          sdpMid,
          sdpMLineIndex,
        });
      } else {
        this.opts.signalingClient.sendIce(offer.code, bare, sdpMid, sdpMLineIndex);
      }
    });

    // Signal done when ICE gathering finishes (for LAN path)
    pc.onGatheringStateChange?.((state: string) => {
      if (state === 'complete' && this._isLanSession) {
        this.opts.localSignaling?.signalDone();
      }
    });

    const thisPC = pc;  // capture for closure
    pc.onStateChange((state: string) => {
      console.log(`[WebRTCServer] PeerConnection state: ${state}`);
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        // Only tear down if this PC is still the active session's PC.
        // If handleOffer() was called again, _session.pc is already the new one —
        // don't tear it down when the old PC's close event fires.
        if (this._session?.pc === thisPC) {
          this._teardown();
          this.opts.onDisconnected();
        }
      }
    });

    // Core is answerer — data channels are created by mobile (offerer)
    // and arrive here via onDataChannel
    pc.onDataChannel((dc: DataChannel) => {
      this._acceptDataChannel(session, dc);
    });

    // node-datachannel generates the answer SDP asynchronously after
    // setRemoteDescription. onLocalDescription fires with type 'answer'
    // once ready — send it then drain pending ICE.
    pc.onLocalDescription((sdp: string, type: string) => {
      if (type !== 'answer') return;
      console.log('[WebRTCServer] Answer SDP ready — sending to ' + (this._isLanSession ? 'LAN client' : 'relay'));
      if (this._isLanSession) {
        this.opts.localSignaling?.submitAnswer(sdp);
      } else {
        this.opts.signalingClient.sendAnswer(offer.code, sdp);
      }

      // Drain any ICE candidates that arrived before the answer was sent
      for (const ice of this._pendingIce) {
        if (ice.code === offer.code) {
          console.log(`[WebRTCServer] Remote ICE (drained): ${ice.candidate.substring(0, 80)}`);
          pc.addRemoteCandidate(ice.candidate, ice.sdpMid ?? '');
        }
      }
      this._pendingIce = [];
    });

    // Trigger async SDP negotiation — answer fires via onLocalDescription above
    pc.setRemoteDescription(offer.sdp, ndc.DescriptionType.Offer);
  }

  /** Called by SignalingClient when relay forwards a trickle ICE candidate. */
  addIceCandidate(ice: SignalIce): void {
    if (this._session && this._session.code === ice.code) {
      console.log(`[WebRTCServer] Remote ICE: ${ice.candidate.substring(0, 80)}`);
      this._session.pc.addRemoteCandidate(ice.candidate, ice.sdpMid ?? '');
    } else {
      this._pendingIce.push(ice);
    }
  }

  /** Called by POST /api/webrtc/ice (LAN path). */
  addLanIceCandidate(candidate: string, sdpMid: string | null): void {
    if (!this._session || !this._isLanSession) return;
    console.log(`[WebRTCServer] LAN remote ICE: ${candidate.substring(0, 80)}`);
    this._session.pc.addRemoteCandidate(candidate, sdpMid ?? '');
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
        dc.onOpen(() => {
          session.openCount++;
          session.handler.attachControlChannel(dc);
          if (session.openCount === 3) {
            console.log('[WebRTCServer] All channels open — session CONNECTED');
            this.opts.onConnected();
          }
        });
        break;
      case 'phobos-media-index':
        session.mediaIndexDC = dc;
        session.handler.attachMediaIndexChannel(dc);
        break;
      case 'phobos-media-upload':
        session.mediaUploadDC = dc;
        session.handler.attachMediaUploadChannel(dc);
        break;
      case 'phobos-friend-handshake':
        // One-shot channel from a remote PHOBOS core presenting a PH1.FRD.* code.
        // Runs the bilateral friend handshake then closes. Not counted toward the
        // three-channel openCount — this is not a normal session channel.
        dc.onOpen(() => {
          session.handler.attachFriendHandshakeChannel(dc);
        });
        break;
      default:
        console.warn(`[WebRTCServer] Unknown data channel: ${label}`);
        return;
    }

    if (label !== 'phobos-control') {
      dc.onOpen(() => {
        session.openCount++;
        if (session.openCount === 3) {
          console.log('[WebRTCServer] All channels open — session CONNECTED');
          this.opts.onConnected();
        }
      });
    }

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