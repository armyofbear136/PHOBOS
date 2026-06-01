/**
 * webrtc/SocialRelayHandler.ts — inbound social relay message processing.
 *
 * Called from server.ts onSocialMessage callback whenever the SignalingClient
 * receives a 'friend-request' or 'friend-request-ack' relay message.
 *
 * friend-request    — a known instance wants to be friends. Store in
 *                     pending_friend_requests for the UI to surface.
 *                     Unknown instances are silently rejected.
 *
 * friend-request-ack — our outbound request was accepted or declined.
 *                      On accepted: stub for FriendConnectionHandler handshake.
 *                      On declined: remove from pending_outbound_requests.
 *
 * This module is loaded lazily (dynamic import in server.ts) so it doesn't
 * block the boot path and doesn't need to be in scope before the relay connects.
 */

import { randomUUID }          from 'node:crypto';
import { DatabaseManager }     from '../db/DatabaseManager.js';
import type { SocialRelayMessage } from './RemoteProtocol.js';

const FRIEND_REQUEST_TTL_DAYS = 7;

export async function handleInboundSocialMessage(
  systemDb: DatabaseManager,
  msg:      SocialRelayMessage,
): Promise<void> {
  try {
    if (msg.type === 'friend-request') {
      await _handleFriendRequest(systemDb, msg);
    } else if (msg.type === 'friend-request-ack') {
      await _handleFriendRequestAck(systemDb, msg);
    }
  } catch (err) {
    console.error('[SocialRelayHandler] Unhandled error:', err);
  }
}

// ── Inbound friend request ────────────────────────────────────────────────────

async function _handleFriendRequest(
  systemDb: DatabaseManager,
  msg:      import('./RemoteProtocol.js').FriendRequestMessage,
): Promise<void> {
  // Security boundary: only accept requests from known instances.
  interface KnownRow { instance_uuid: string; friended: boolean; }
  const rows = await systemDb.query<KnownRow>(
    `SELECT instance_uuid, friended FROM known_instances WHERE instance_uuid = ?`,
    [msg.fromInstanceId],
  );

  if (rows.length === 0) {
    console.warn(`[SocialRelayHandler] friend-request from unknown instance ${msg.fromInstanceId} — rejected`);
    return;
  }

  if (rows[0].friended) {
    // Already friends — ignore duplicate requests silently.
    return;
  }

  const now       = Date.now();
  const expiresAt = Math.min(msg.expiresAt, now + FRIEND_REQUEST_TTL_DAYS * 24 * 60 * 60 * 1_000);

  if (expiresAt < now) {
    console.warn(`[SocialRelayHandler] Expired friend-request from ${msg.fromInstanceId} — ignored`);
    return;
  }

  // Upsert — if a request from this instance already exists, replace it with
  // the freshest one (sender may have re-sent after no response).
  await systemDb.execWithParams(
    `INSERT INTO pending_friend_requests
       (id, from_instance_id, from_username, from_display_name, received_at, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')
     ON CONFLICT (from_instance_id) DO UPDATE SET
       id               = excluded.id,
       from_username    = excluded.from_username,
       from_display_name= excluded.from_display_name,
       received_at      = excluded.received_at,
       expires_at       = excluded.expires_at,
       status           = 'pending',
       responded_at     = NULL`,
    [
      msg.requestId,
      msg.fromInstanceId,
      msg.fromUsername,
      msg.fromDisplayName,
      now,
      expiresAt,
    ],
  );

  // Update known_instances with the sender's relay address in case it changed.
  await systemDb.execWithParams(
    `UPDATE known_instances SET relay_address = ? WHERE instance_uuid = ?`,
    [msg.fromRelayAddress, msg.fromInstanceId],
  );

  console.log(`[SocialRelayHandler] Friend request stored from ${msg.fromUsername}@${msg.fromInstanceId}`);
}

// ── Inbound friend request ack ────────────────────────────────────────────────

async function _handleFriendRequestAck(
  systemDb: DatabaseManager,
  msg:      import('./RemoteProtocol.js').FriendRequestAck,
): Promise<void> {
  interface OutboundRow {
    id:             string;
    to_instance_id: string;
    payload:        string;
  }
  const rows = await systemDb.query<OutboundRow>(
    `SELECT id, to_instance_id, payload FROM pending_outbound_requests
     WHERE id = ?`,
    [msg.requestId],
  );

  if (rows.length === 0) {
    // May have already been cleaned up — safe to ignore.
    console.warn(`[SocialRelayHandler] Ack for unknown requestId ${msg.requestId} — ignored`);
    return;
  }

  const outbound = rows[0];

  if (msg.decision === 'declined') {
    await systemDb.execWithParams(
      `DELETE FROM pending_outbound_requests WHERE id = ?`,
      [msg.requestId],
    );
    console.log(`[SocialRelayHandler] Friend request ${msg.requestId} declined by ${msg.fromInstanceId}`);
    return;
  }

  // Accepted — remove the pending entry.
  await systemDb.execWithParams(
    `DELETE FROM pending_outbound_requests WHERE id = ?`,
    [msg.requestId],
  );

  console.log(`[SocialRelayHandler] Friend request ${msg.requestId} accepted by ${msg.fromInstanceId} — initiating handshake`);

  // Look up the target's relay address from known_instances.
  interface RelayRow { relay_address: string; }
  const relayRows = await systemDb.query<RelayRow>(
    `SELECT relay_address FROM known_instances WHERE instance_uuid = ?`,
    [msg.fromInstanceId],
  );
  const targetRelayUrl = relayRows[0]?.relay_address ?? '';

  if (!targetRelayUrl) {
    console.warn(`[SocialRelayHandler] No relay address for ${msg.fromInstanceId} — cannot initiate handshake`);
    return;
  }

  // Lazy-import to avoid circular dependencies at module load time.
  const { initiateOutboundFriendHandshake } = await import('./FriendConnectionHandler.js');
  const { getInstanceId } = await import('../db/InstanceConfig.js');

  // signalingClient is accessed via the social context set in server.ts.
  // We import it lazily here to avoid a hard circular dependency.
  const { _getSocialSignalingClient } = await import('../routes/social.js');
  const signalingClient = _getSocialSignalingClient();

  if (!signalingClient) {
    console.warn('[SocialRelayHandler] No SignalingClient available — cannot initiate handshake');
    return;
  }

  const instanceId = await getInstanceId(systemDb);
  const relayUrl   = signalingClient.getRelayUrl();

  void initiateOutboundFriendHandshake({
    systemDb,
    instanceId,
    relayUrl,
    signalingClient,
    targetInstanceId: msg.fromInstanceId,
    targetRelayUrl,
  }).then((ok) => {
    if (!ok) console.warn(`[SocialRelayHandler] Handshake with ${msg.fromInstanceId} failed`);
  });
}
