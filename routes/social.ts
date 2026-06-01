/**
 * routes/social.ts — PHOBOS social graph, friend requests, and direct messaging.
 *
 * Route surface:
 *
 *   Discovery (Phobos ID — no credentials, static identifier):
 *     POST   /api/social/discovery                      — add a Phobos ID to known_instances
 *     GET    /api/social/discovery                      — list all known instances
 *     DELETE /api/social/discovery/:instanceUuid        — remove a known instance (and friend if friended)
 *     GET    /api/social/my-id                          — return this core's Phobos ID to display/share
 *
 *   Friend requests (relay-brokered, interactive):
 *     POST   /api/social/friend-request/:instanceUuid   — send a friend request to a known instance
 *     GET    /api/social/friend-requests/pending        — list inbound pending requests
 *     POST   /api/social/friend-requests/:id/accept     — accept an inbound request
 *     POST   /api/social/friend-requests/:id/decline    — decline an inbound request
 *
 *   Friends (confirmed):
 *     GET    /api/social/friends                        — list friends with online status
 *     DELETE /api/social/friends/:instanceUuid/:username — remove a friend
 *
 *   Direct messages:
 *     GET    /api/social/messages/:instanceUuid/:username — conversation history (paginated)
 *     POST   /api/social/messages/:instanceUuid/:username — send a direct message
 *
 * Data model:
 *   known_instances        — system DB — Phobos IDs the user has explicitly added
 *   pending_friend_requests— system DB — inbound requests awaiting response
 *   friends                — social DB (social.duckdb) — confirmed friend records
 *   direct_messages        — social DB — DM history
 *   pending_dm_queue       — social DB — offline delivery queue
 *
 * Auth:
 *   All routes require an authenticated session (owner/admin/full).
 *   Guest/read are blocked by the global preHandler allowlist in server.ts.
 *
 * Context:
 *   Call setSocialContext() after instanceId and relayUrl resolve at boot.
 *   setSocialSignalingClient() is called after the SignalingClient connects —
 *   used to send friend-request relay messages outbound.
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID }           from 'node:crypto';
import { DatabaseManager }      from '../db/DatabaseManager.js';
import { UserStore }            from '../db/UserStore.js';
import { FriendStore }          from '../db/FriendStore.js';
import { DirectMessageStore }   from '../db/DirectMessageStore.js';
import { getInstanceId, getPublicKey, getCoreName, setCoreName } from '../db/InstanceConfig.js';
import type { SignalingClient } from '../webrtc/SignalingClient.js';
import type {
  FriendRequestMessage,
  FriendRequestAck,
} from '../webrtc/RemoteProtocol.js';

// ── Module-level context ──────────────────────────────────────────────────────

interface SocialCtx {
  systemDb:        DatabaseManager | null;
  instanceId:      string;
  relayUrl:        string;
  signalingClient: SignalingClient | null;
}

const _ctx: SocialCtx = {
  systemDb:        null,
  instanceId:      '',
  relayUrl:        process.env.WEBRTC_RELAY_URL ?? 'wss://autarch.net/relay',
  signalingClient: null,
};

export function setSocialContext(
  systemDb:   DatabaseManager,
  instanceId: string,
  relayUrl:   string,
): void {
  _ctx.systemDb   = systemDb;
  _ctx.instanceId = instanceId;
  _ctx.relayUrl   = relayUrl;
}

/** Called after SignalingClient is created so social routes can send relay messages. */
export function setSocialSignalingClient(client: SignalingClient): void {
  _ctx.signalingClient = client;
}

/** Used by SocialRelayHandler to access the SignalingClient for handshake initiation. */
export function _getSocialSignalingClient(): SignalingClient | null {
  return _ctx.signalingClient;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const FRIEND_REQUEST_TTL_DAYS = 7;
const PRESENCE_TIMEOUT_MS     = 3_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Best-effort relay presence check for a list of instance UUIDs. */
async function checkPresence(instanceIds: string[], relayUrl: string): Promise<Set<string>> {
  if (instanceIds.length === 0) return new Set();
  try {
    const relayHttp = relayUrl.replace(/^wss?:\/\//, 'https://').replace(/\/relay$/, '');
    const url = `${relayHttp}/relay/presence?ids=${encodeURIComponent(instanceIds.join(','))}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(PRESENCE_TIMEOUT_MS) });
    if (res.ok) {
      const data = (await res.json()) as { online: string[] };
      return new Set(data.online);
    }
  } catch {
    // Presence is best-effort — offline if relay unreachable.
  }
  return new Set();
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerSocialRoutes(fastify: FastifyInstance): Promise<void> {
  const systemDb = _ctx.systemDb ?? DatabaseManager.getInstance();

  // ── GET /api/social/my-id ──────────────────────────────────────────────────
  //
  // Returns this core's Phobos ID — the static identifier the user shares with
  // friends so they can add it to their known_instances. Contains no credentials.

  fastify.get('/api/social/my-id', async (_req, reply) => {
    const instanceId = _ctx.instanceId || await getInstanceId(systemDb);
    const coreName   = await getCoreName(systemDb);
    return reply.status(200).send({
      instanceId,
      relayAddress: _ctx.relayUrl,
      coreName,
    });
  });

  // ── GET /api/social/core-name ──────────────────────────────────────────────
  // ── POST /api/social/core-name ─────────────────────────────────────────────
  //
  // Read and set the human display name for this core.
  // The name is included in Phobos ID shares so the recipient sees it.

  fastify.get('/api/social/core-name', async (_req, reply) => {
    const name = await getCoreName(systemDb);
    return reply.status(200).send({ coreName: name });
  });

  fastify.post('/api/social/core-name', async (req, reply) => {
    const { name } = req.body as { name?: string };
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.status(400).send({ error: 'name required' });
    }
    await setCoreName(systemDb, name);
    return reply.status(200).send({ coreName: name.trim().slice(0, 40) });
  });

  // ── GET /api/social/users/:instanceUuid ───────────────────────────────────
  //
  // Fetch the public user list from a known remote PHOBOS instance.
  // The remote core exposes GET /api/social/public-users — this route proxies
  // that request via an HTTP fetch to the relay's HTTP address.
  // Returns { users: [{ username, displayName }] } or error if unreachable.

  fastify.get('/api/social/users/:instanceUuid', async (req, reply) => {
    const { instanceUuid } = req.params as { instanceUuid: string };

    interface KnownRow { relay_address: string; friended: boolean; }
    const rows = await systemDb.query<KnownRow>(
      `SELECT relay_address, friended FROM known_instances WHERE instance_uuid = ?`,
      [instanceUuid],
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'unknown_instance' });

    const relayHttp = rows[0].relay_address
      .replace(/^wss?:\/\//, 'https://')
      .replace(/\/relay$/, '');

    try {
      const res = await fetch(
        `${relayHttp}/api/social/public-users`,
        { signal: AbortSignal.timeout(5_000) },
      );
      if (!res.ok) return reply.status(502).send({ error: 'remote_error', status: res.status });
      const data = await res.json() as { users: { username: string; displayName: string }[] };
      return reply.status(200).send({ users: data.users, friended: rows[0].friended });
    } catch (err) {
      return reply.status(503).send({ error: 'unreachable', message: (err as Error).message });
    }
  });

  // ── GET /api/social/public-users ──────────────────────────────────────────
  //
  // Public endpoint — no auth required. Returns the owner's username and
  // display name so a remote core can show them in the friend-request UI.
  // Only exposes what a friend needs to send a request; no private data.

  fastify.get('/api/social/public-users', async (_req, reply) => {
    const userStore = new UserStore(systemDb);
    const ownerRow  = await userStore.getByUsername('owner');
    const coreName  = await getCoreName(systemDb);
    return reply.status(200).send({
      coreName,
      users: ownerRow
        ? [{ username: ownerRow.username, displayName: ownerRow.display_name }]
        : [],
    });
  });
  //
  // Add a Phobos ID (instanceUuid + relayAddress) to known_instances.
  // This is a local write — the remote core is not contacted.
  // Once added, connections from this instance can proceed through the handshake.
  // An optional label can be set as a human nickname before or after friending.

  fastify.post('/api/social/discovery', async (req, reply) => {
    const { instanceUuid, relayAddress, label } =
      req.body as { instanceUuid?: string; relayAddress?: string; label?: string };

    if (!instanceUuid || typeof instanceUuid !== 'string') {
      return reply.status(400).send({ error: 'instanceUuid required' });
    }
    if (!relayAddress || typeof relayAddress !== 'string') {
      return reply.status(400).send({ error: 'relayAddress required' });
    }

    const ownInstanceId = _ctx.instanceId || await getInstanceId(systemDb);
    if (instanceUuid === ownInstanceId) {
      return reply.status(400).send({ error: 'cannot_add_self' });
    }

    // Upsert — re-adding an existing ID updates relayAddress and label.
    await systemDb.execWithParams(
      `INSERT INTO known_instances (instance_uuid, relay_address, label, friended, added_at)
       VALUES (?, ?, ?, false, ?)
       ON CONFLICT (instance_uuid) DO UPDATE SET
         relay_address = excluded.relay_address,
         label         = COALESCE(excluded.label, known_instances.label)`,
      [instanceUuid, relayAddress, label ?? null, Date.now()],
    );

    return reply.status(200).send({ ok: true, instanceUuid });
  });

  // ── GET /api/social/discovery ──────────────────────────────────────────────
  //
  // List all known instances with friended status and online presence.

  fastify.get('/api/social/discovery', async (_req, reply) => {
    interface KnownRow {
      instance_uuid: string;
      relay_address: string;
      label:         string | null;
      friended:      boolean;
      added_at:      number;
    }
    const rows = await systemDb.query<KnownRow>(
      `SELECT instance_uuid, relay_address, label, friended, added_at
       FROM known_instances ORDER BY added_at DESC`,
      [],
    );

    const onlineSet = await checkPresence(rows.map(r => r.instance_uuid), _ctx.relayUrl);

    return reply.status(200).send({
      instances: rows.map(r => ({
        instanceUuid: r.instance_uuid,
        relayAddress: r.relay_address,
        label:        r.label ?? null,
        friended:     r.friended,
        addedAt:      r.added_at,
        online:       onlineSet.has(r.instance_uuid),
      })),
    });
  });

  // ── DELETE /api/social/discovery/:instanceUuid ────────────────────────────
  //
  // Remove a known instance. If friended, also removes from social.duckdb friends.
  // Does not affect DM history.

  fastify.delete('/api/social/discovery/:instanceUuid', async (req, reply) => {
    const { instanceUuid } = req.params as { instanceUuid: string };
    if (!instanceUuid) return reply.status(400).send({ error: 'instanceUuid required' });

    interface FriendedRow { friended: boolean; }
    const rows = await systemDb.query<FriendedRow>(
      `SELECT friended FROM known_instances WHERE instance_uuid = ?`,
      [instanceUuid],
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'not_found' });

    // If this instance is friended, clean up social.duckdb too.
    if (rows[0].friended) {
      try {
        const socialDb    = await DatabaseManager.getSocialDb(req.phobosUser);
        const friendStore = new FriendStore(socialDb);
        // Remove all friend entries for this instance (could be multiple usernames).
        const friends = await friendStore.getFriends();
        for (const f of friends.filter(f => f.instance_uuid === instanceUuid)) {
          await friendStore.removeFriend(f.instance_uuid, f.username);
        }
      } catch (err) {
        console.warn('[social] friend cleanup on discovery delete failed (non-fatal):', err);
      }
    }

    await systemDb.execWithParams(
      `DELETE FROM known_instances WHERE instance_uuid = ?`,
      [instanceUuid],
    );

    // Also clean up any pending requests from this instance.
    await systemDb.execWithParams(
      `DELETE FROM pending_friend_requests WHERE from_instance_id = ?`,
      [instanceUuid],
    );

    return reply.status(204).send();
  });

  // ── POST /api/social/friend-request/:instanceUuid ─────────────────────────
  //
  // Send a friend request to a known instance via the relay.
  // If the target is online the relay delivers it immediately.
  // If offline, the core retries on a timer (handled by SignalingClient on reconnect).
  // The request is persisted in pending_outbound_requests (system DB) until acked.

  fastify.post('/api/social/friend-request/:instanceUuid', async (req, reply) => {
    const { instanceUuid } = req.params as { instanceUuid: string };
    if (!instanceUuid) return reply.status(400).send({ error: 'instanceUuid required' });

    // Must be a known instance.
    interface KnownRow { instance_uuid: string; friended: boolean; }
    const rows = await systemDb.query<KnownRow>(
      `SELECT instance_uuid, friended FROM known_instances WHERE instance_uuid = ?`,
      [instanceUuid],
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'unknown_instance' });
    if (rows[0].friended) return reply.status(409).send({ error: 'already_friends' });

    const instanceId  = _ctx.instanceId || await getInstanceId(systemDb);
    const publicKey   = await getPublicKey(systemDb);
    const userStore   = new UserStore(systemDb);
    const ownerRow    = await userStore.getByUsername('owner');
    const username    = ownerRow?.username    ?? 'owner';
    const displayName = ownerRow?.display_name ?? 'owner';

    const requestId = randomUUID();
    const sentAt    = Date.now();
    const expiresAt = sentAt + FRIEND_REQUEST_TTL_DAYS * 24 * 60 * 60 * 1_000;

    const message: FriendRequestMessage = {
      type:             'friend-request',
      fromInstanceId:   instanceId,
      fromUsername:     username,
      fromDisplayName:  displayName,
      fromPublicKey:    publicKey,
      fromRelayAddress: _ctx.relayUrl,
      requestId,
      sentAt,
      expiresAt,
    };

    // Persist outbound request for retry on reconnect.
    await systemDb.execWithParams(
      `INSERT INTO pending_outbound_requests
         (id, to_instance_id, payload, sent_at, expires_at, retry_count)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT (to_instance_id) DO UPDATE SET
         id         = excluded.id,
         payload    = excluded.payload,
         sent_at    = excluded.sent_at,
         expires_at = excluded.expires_at,
         retry_count = 0`,
      [requestId, instanceUuid, JSON.stringify(message), sentAt, expiresAt],
    );

    // Attempt immediate delivery via relay if connected.
    const delivered = _ctx.signalingClient?.sendSocialMessage(instanceUuid, message) ?? false;

    return reply.status(200).send({ requestId, delivered });
  });

  // ── GET /api/social/friend-requests/pending ───────────────────────────────
  //
  // List inbound friend requests waiting for the user to accept or decline.

  fastify.get('/api/social/friend-requests/pending', async (_req, reply) => {
    interface PendingRow {
      id:                string;
      from_instance_id:  string;
      from_username:     string;
      from_display_name: string;
      received_at:       number;
      expires_at:        number;
    }
    const rows = await systemDb.query<PendingRow>(
      `SELECT id, from_instance_id, from_username, from_display_name,
              received_at, expires_at
       FROM pending_friend_requests
       WHERE status = 'pending' AND expires_at > ?
       ORDER BY received_at DESC`,
      [Date.now()],
    );
    return reply.status(200).send({ requests: rows });
  });

  // ── POST /api/social/friend-requests/:id/accept ───────────────────────────
  //
  // Accept an inbound friend request. Marks it accepted in the DB, sends
  // FriendRequestAck via relay. The WebRTC friend handshake is initiated
  // by FriendConnectionHandler (separate session — stubbed here).

  fastify.post('/api/social/friend-requests/:id/accept', async (req, reply) => {
    const { id } = req.params as { id: string };

    interface PendingRow {
      from_instance_id:  string;
      from_username:     string;
      from_display_name: string;
      status:            string;
      expires_at:        number;
    }
    const rows = await systemDb.query<PendingRow>(
      `SELECT from_instance_id, from_username, from_display_name, status, expires_at
       FROM pending_friend_requests WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'not_found' });
    if (rows[0].status !== 'pending') return reply.status(409).send({ error: 'already_responded' });
    if (rows[0].expires_at < Date.now()) return reply.status(410).send({ error: 'expired' });

    const request = rows[0];

    await systemDb.execWithParams(
      `UPDATE pending_friend_requests
       SET status = 'accepted', responded_at = ?
       WHERE id = ?`,
      [Date.now(), id],
    );

    // Also add them to known_instances if not already there.
    await systemDb.execWithParams(
      `INSERT INTO known_instances (instance_uuid, relay_address, label, friended, added_at)
       VALUES (?, ?, ?, false, ?)
       ON CONFLICT (instance_uuid) DO NOTHING`,
      [request.from_instance_id, '', request.from_display_name, Date.now()],
    );

    // Send ack via relay.
    const instanceId = _ctx.instanceId || await getInstanceId(systemDb);
    const ack: FriendRequestAck = {
      type:           'friend-request-ack',
      requestId:      id,
      decision:       'accepted',
      fromInstanceId: instanceId,
    };
    _ctx.signalingClient?.sendSocialMessage(request.from_instance_id, ack);

    // Initiate the WebRTC friend handshake now that both sides have consented.
    const relayRows = await systemDb.query<{ relay_address: string }>(
      `SELECT relay_address FROM known_instances WHERE instance_uuid = ?`,
      [request.from_instance_id],
    );
    const targetRelayUrl = relayRows[0]?.relay_address ?? '';

    if (targetRelayUrl && _ctx.signalingClient) {
      const { initiateOutboundFriendHandshake } = await import('../webrtc/FriendConnectionHandler.js');
      const { getInstanceId: getInstId }        = await import('../db/InstanceConfig.js');
      const myInstanceId = _ctx.instanceId || await getInstId(systemDb);

      void initiateOutboundFriendHandshake({
        systemDb,
        instanceId:       myInstanceId,
        relayUrl:         _ctx.relayUrl,
        signalingClient:  _ctx.signalingClient,
        targetInstanceId: request.from_instance_id,
        targetRelayUrl,
      }).then((ok) => {
        if (!ok) console.warn(`[social] Handshake with ${request.from_instance_id} failed after accept`);
      });
    } else {
      console.warn('[social] Cannot initiate handshake — missing relay address or signalingClient');
    }

    return reply.status(200).send({ ok: true, pendingHandshake: !targetRelayUrl || !_ctx.signalingClient });
  });

  // ── POST /api/social/friend-requests/:id/decline ──────────────────────────
  //
  // Decline an inbound friend request. Sends FriendRequestAck with declined.

  fastify.post('/api/social/friend-requests/:id/decline', async (req, reply) => {
    const { id } = req.params as { id: string };

    interface PendingRow { from_instance_id: string; status: string; }
    const rows = await systemDb.query<PendingRow>(
      `SELECT from_instance_id, status FROM pending_friend_requests WHERE id = ?`,
      [id],
    );
    if (rows.length === 0) return reply.status(404).send({ error: 'not_found' });
    if (rows[0].status !== 'pending') return reply.status(409).send({ error: 'already_responded' });

    await systemDb.execWithParams(
      `UPDATE pending_friend_requests
       SET status = 'declined', responded_at = ?
       WHERE id = ?`,
      [Date.now(), id],
    );

    const instanceId = _ctx.instanceId || await getInstanceId(systemDb);
    const ack: FriendRequestAck = {
      type:           'friend-request-ack',
      requestId:      id,
      decision:       'declined',
      fromInstanceId: instanceId,
    };
    _ctx.signalingClient?.sendSocialMessage(rows[0].from_instance_id, ack);

    return reply.status(200).send({ ok: true });
  });

  // ── GET /api/social/friends ────────────────────────────────────────────────
  //
  // Confirmed friends from social.duckdb with live online status.

  fastify.get('/api/social/friends', async (req, reply) => {
    const socialDb    = await DatabaseManager.getSocialDb(req.phobosUser);
    const friendStore = new FriendStore(socialDb);
    const friends     = await friendStore.getFriends();
    const onlineSet   = await checkPresence(friends.map(f => f.instance_uuid), _ctx.relayUrl);

    return reply.status(200).send({
      friends: friends.map(f => ({
        instanceUuid: f.instance_uuid,
        username:     f.username,
        displayName:  f.display_name,
        relayAddress: f.relay_address,
        avatarToken:  f.avatar_token ?? null,
        connectedAt:  f.connected_at,
        lastSeenAt:   f.last_seen_at ?? null,
        online:       onlineSet.has(f.instance_uuid),
      })),
    });
  });

  // ── DELETE /api/social/friends/:instanceUuid/:username ────────────────────
  //
  // Remove a friend. Also resets friended=false on known_instances.

  fastify.delete('/api/social/friends/:instanceUuid/:username', async (req, reply) => {
    const { instanceUuid, username: friendUsername } =
      req.params as { instanceUuid: string; username: string };

    const socialDb    = await DatabaseManager.getSocialDb(req.phobosUser);
    const friendStore = new FriendStore(socialDb);
    const exists      = await friendStore.isFriend(instanceUuid, friendUsername);
    if (!exists) return reply.status(404).send({ error: 'not_found' });

    await friendStore.removeFriend(instanceUuid, friendUsername);

    // Reset friended flag — they remain a known instance but not a friend.
    await systemDb.execWithParams(
      `UPDATE known_instances SET friended = false WHERE instance_uuid = ?`,
      [instanceUuid],
    );

    return reply.status(204).send();
  });

  // ── GET /api/social/messages/:instanceUuid/:username ──────────────────────
  //
  // Conversation history, newest-first. Marks received messages as read.

  fastify.get('/api/social/messages/:instanceUuid/:username', async (req, reply) => {
    const { instanceUuid, username: friendUsername } =
      req.params as { instanceUuid: string; username: string };
    const { limit: limitStr, before: beforeStr } =
      req.query as { limit?: string; before?: string };

    const limit    = Math.min(parseInt(limitStr ?? '50', 10) || 50, 200);
    const beforeTs = beforeStr ? parseInt(beforeStr, 10) : undefined;

    const socialDb  = await DatabaseManager.getSocialDb(req.phobosUser);
    const dmStore   = new DirectMessageStore(socialDb);
    const messages  = await dmStore.getConversation(instanceUuid, friendUsername, limit, beforeTs);

    const now = Date.now();
    await Promise.all(
      messages
        .filter(m => m.direction === 'received' && m.read_at === null)
        .map(m => dmStore.markRead(m.message_id, now)),
    );

    return reply.status(200).send({ messages });
  });

  // ── POST /api/social/messages/:instanceUuid/:username ─────────────────────
  //
  // Send a direct message. Persists immediately. Queued for delivery when
  // FriendConnectionHandler live delivery is implemented.

  fastify.post('/api/social/messages/:instanceUuid/:username', async (req, reply) => {
    const { instanceUuid, username: friendUsername } =
      req.params as { instanceUuid: string; username: string };
    const { text } = req.body as { text?: string };

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return reply.status(400).send({ error: 'text_required' });
    }

    const socialDb    = await DatabaseManager.getSocialDb(req.phobosUser);
    const friendStore = new FriendStore(socialDb);
    const friend      = await friendStore.getByKey(instanceUuid, friendUsername);
    if (!friend) return reply.status(404).send({ error: 'friend_not_found' });

    const messageId = randomUUID();
    const sentAt    = Date.now();
    const dmStore   = new DirectMessageStore(socialDb);

    await dmStore.persistSent({
      message_id:      messageId,
      friend_uuid:     instanceUuid,
      friend_username: friendUsername,
      content_text:    text.trim(),
      sent_at:         sentAt,
    });

    const instanceId = _ctx.instanceId || await getInstanceId(systemDb);
    await dmStore.enqueuePending({
      target_uuid:     instanceUuid,
      target_username: friendUsername,
      message_id:      messageId,
      payload:         JSON.stringify({
        kind:         'direct-message',
        messageId,
        fromUuid:     instanceId,
        fromUsername: req.phobosUser,
        toUsername:   friendUsername,
        contentText:  text.trim(),
        sentAt,
      }),
    });

    return reply.status(200).send({ messageId, delivered: false });
  });
}
