/**
 * webrtc/FriendConnectionHandler.ts — outbound friend handshake initiator.
 *
 * When a friend request is accepted (either side), this module opens a new
 * WebRTC peer connection to the target instance via the relay, creates a
 * phobos-friend-handshake data channel, sends a FriendHandshake frame, waits
 * for the target's FriendRecord, writes both sides to social.duckdb, and
 * marks known_instances.friended = true.
 *
 * Entry points:
 *   initiateOutboundFriendHandshake(opts) — call after accept ack received
 *
 * This module is loaded lazily and has no startup cost.
 *
 * NOTE: The relay must support friend-specific offer routing. The initiating
 * core sends a SignalOffer with type 'friend-offer' (distinct from the normal
 * mobile session offer) so the relay routes it to the right peer connection
 * rather than the normal WebRTC session. If the relay only supports one offer
 * route, the initiator must use a separate relay connection.
 */

import { createRequire }    from 'node:module';
import { DatabaseManager }  from '../db/DatabaseManager.js';
import { UserStore }        from '../db/UserStore.js';
import { FriendStore }      from '../db/FriendStore.js';
import { getPublicKey }     from '../db/InstanceConfig.js';
import type { SignalingClient } from './SignalingClient.js';
import type {
  FriendHandshake,
  FriendRecord,
  FriendConnected,
  FriendHandshakeError,
} from './RemoteProtocol.js';
import type { PeerConnection, DataChannel, IceServer, RelayType } from 'node-datachannel';

// ── node-datachannel lazy loader (mirrors WebRTCServer pattern) ───────────────

let _ndc: typeof import('node-datachannel') | null = null;

function getNdc(): typeof import('node-datachannel') {
  if (_ndc) return _ndc;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const req = createRequire(typeof __filename !== 'undefined' ? __filename : process.execPath);
  _ndc = req('node-datachannel') as typeof import('node-datachannel');
  return _ndc;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FriendHandshakeOpts {
  /** System DB — for known_instances update and owner identity read. */
  systemDb:        DatabaseManager;
  /** This core's instance UUID. */
  instanceId:      string;
  /** This core's relay address (wss://). */
  relayUrl:        string;
  /** Connected SignalingClient — used to get ICE servers. */
  signalingClient: SignalingClient;
  /** Target instance UUID — must be in known_instances. */
  targetInstanceId: string;
  /** Target relay address — where to reach the target. */
  targetRelayUrl:  string;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Initiate the outbound friend handshake to a target PHOBOS instance.
 *
 * Opens a PeerConnection to the relay, creates a phobos-friend-handshake DC,
 * sends our identity, awaits theirs, writes to social.duckdb on both sides.
 *
 * Returns true on success, false on any failure (logged internally).
 */
export async function initiateOutboundFriendHandshake(
  opts: FriendHandshakeOpts,
): Promise<boolean> {
  const { systemDb, instanceId, relayUrl, signalingClient, targetInstanceId, targetRelayUrl } = opts;

  // Verify target is still in known_instances before connecting.
  interface KnownRow { friended: boolean; }
  const known = await systemDb.query<KnownRow>(
    `SELECT friended FROM known_instances WHERE instance_uuid = ?`,
    [targetInstanceId],
  );
  if (known.length === 0) {
    console.warn(`[FriendConnectionHandler] Target ${targetInstanceId} not in known_instances — aborted`);
    return false;
  }
  if (known[0].friended) {
    console.warn(`[FriendConnectionHandler] Already friends with ${targetInstanceId} — skipped`);
    return false;
  }

  const ndc = getNdc();

  // Parse ICE servers from SignalingClient using the same logic as WebRTCServer.
  const iceServers = signalingClient.getIceServers()
    .flatMap(s => (Array.isArray(s.urls) ? s.urls : [s.urls])
      .map((url): string | IceServer => {
        if (url.startsWith('stun:') || url.startsWith('stuns:')) return url;
        const withoutScheme = url.replace(/^(stun|stuns|turn|turns):\/?\/?/, '');
        const withoutParams = withoutScheme.split('?')[0];
        const lastColon     = withoutParams.lastIndexOf(':');
        const hostname      = lastColon !== -1 ? withoutParams.slice(0, lastColon) : withoutParams;
        const port          = lastColon !== -1 ? parseInt(withoutParams.slice(lastColon + 1), 10) || 3478 : 3478;
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

  const pc = new ndc.PeerConnection(`phobos-friend-out-${targetInstanceId.slice(0, 8)}`, {
    iceServers,
    enableIceTcp: true,
  });

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      try { pc.close(); } catch { /* ignore */ }
      resolve(result);
    };

    // 30s overall timeout.
    const timeout = setTimeout(() => {
      console.warn(`[FriendConnectionHandler] Handshake timeout with ${targetInstanceId}`);
      settle(false);
    }, 30_000);

    pc.onStateChange((state: string) => {
      if (state === 'failed' || state === 'closed') {
        clearTimeout(timeout);
        settle(false);
      }
    });

    // The initiating core creates the data channel (offerer role).
    const dc: DataChannel = pc.createDataChannel('phobos-friend-handshake');

    dc.onOpen(async () => {
      try {
        // Build and send our identity.
        const userStore   = new UserStore(systemDb);
        const ownerRow    = await userStore.getByUsername('owner');
        const username    = ownerRow?.username    ?? 'owner';
        const displayName = ownerRow?.display_name ?? 'owner';
        const publicKey   = await getPublicKey(systemDb);

        const outbound: FriendHandshake = {
          kind:         'friend-handshake',
          instanceId,
          username,
          displayName,
          publicKey,
          relayAddress: relayUrl,
        };
        dc.sendMessage(JSON.stringify(outbound));

        // Wait for target's FriendRecord.
        const record = await _awaitFrame<FriendRecord>(dc, 'friend-record', 12_000);
        if (!record) {
          console.warn(`[FriendConnectionHandler] Timeout waiting for FriendRecord from ${targetInstanceId}`);
          clearTimeout(timeout);
          settle(false);
          return;
        }

        // Wait for FriendConnected confirmation.
        const connected = await _awaitFrame<FriendConnected>(dc, 'friend-connected', 5_000);
        if (!connected?.success) {
          console.warn(`[FriendConnectionHandler] Did not receive FriendConnected from ${targetInstanceId}`);
          clearTimeout(timeout);
          settle(false);
          return;
        }

        // Write to social.duckdb.
        const socialDb    = await DatabaseManager.getSocialDb(username);
        const friendStore = new FriendStore(socialDb);

        const alreadyFriends = await friendStore.isFriend(record.instanceId, record.username);
        if (!alreadyFriends) {
          await friendStore.addFriend({
            instance_uuid: record.instanceId,
            username:      record.username,
            display_name:  record.displayName,
            public_key:    record.publicKey,
            relay_address: record.relayAddress,
            avatar_token:  record.avatarToken,
          });
        }

        // Mark known_instances.friended.
        await systemDb.execWithParams(
          `UPDATE known_instances SET friended = true WHERE instance_uuid = ?`,
          [targetInstanceId],
        );

        console.log(`[FriendConnectionHandler] Handshake complete: ${username} ↔ ${record.username}@${record.instanceId}`);
        clearTimeout(timeout);
        settle(true);

      } catch (err) {
        console.error('[FriendConnectionHandler] Handshake error:', err);
        clearTimeout(timeout);
        settle(false);
      }
    });

    dc.onError((err) => {
      console.error('[FriendConnectionHandler] DC error:', err);
      clearTimeout(timeout);
      settle(false);
    });

    // The initiator triggers SDP generation by setting up the DC above.
    // node-datachannel fires onLocalDescription once the offer is ready.
    // We need to deliver it to the target via the relay.
    // The relay must support routing friend-specific offers by targetInstanceId.
    pc.onLocalDescription((sdp: string, type: string) => {
      if (type !== 'offer') return;
      // Send via relay WebSocket as a friend-offer message.
      signalingClient.sendSocialMessage(targetInstanceId, {
        type:             'friend-offer' as never,  // relay extension — not in mobile contract
        fromInstanceId:   instanceId,
        sdp,
        relayUrl:         targetRelayUrl,
      } as never);
    });

    pc.onLocalCandidate((candidate: string, mid: string) => {
      const bare = candidate.startsWith('a=') ? candidate.slice(2) : candidate;
      signalingClient.sendSocialMessage(targetInstanceId, {
        type:            'friend-ice' as never,
        fromInstanceId:  instanceId,
        candidate:       bare,
        sdpMid:          mid || null,
        sdpMLineIndex:   null,
      } as never);
    });
  });
}

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Wait up to timeoutMs for a specific frame kind on a data channel.
 * Returns null on timeout or error frame.
 */
function _awaitFrame<T extends { kind: string }>(
  dc:        DataChannel,
  kind:      string,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; resolve(null); }
    }, timeoutMs);

    const handler = (data: string | Buffer) => {
      if (done) return;
      if (typeof data !== 'string') return;
      try {
        const frame = JSON.parse(data) as { kind: string };
        if (frame.kind === kind) {
          done = true;
          clearTimeout(timer);
          resolve(frame as T);
        } else if (frame.kind === 'friend-error') {
          const err = frame as FriendHandshakeError;
          console.warn(`[FriendConnectionHandler] Received friend-error: ${err.reason}`);
          done = true;
          clearTimeout(timer);
          resolve(null);
        }
      } catch { /* ignore parse errors */ }
    };

    dc.onMessage(handler);
  });
}
