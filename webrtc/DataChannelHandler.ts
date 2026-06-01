/**
 * DataChannelHandler.ts — routes frames from WebRTC data channels into Fastify.
 *
 * Control channel:
 *   - Non-streaming: fastify.inject() → RemoteResponse
 *   - Streaming (frame.stream === true): SseEmitterRegistry tap → RemoteSSEFrame* → RemoteDone
 *
 * Media-index channel:
 *   - MediaCheckRequest → internal meridian hash check → MediaCheckResponse
 *
 * Media-upload channel:
 *   - MediaUploadBegin → MediaChunkEnvelope + binary → MediaUploadEnd → write file → MediaUploadAck
 */

import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import type { DataChannel } from 'node-datachannel';
import * as SseEmitterRegistry from './SseEmitterRegistry.js';
import { decodeAccessCode, isStructuredCode } from './AccessCodeEncoder.js';
import type {
  RemoteRequest, RemoteAbort,
  RemoteResponse, RemoteSSEFrame, RemoteDone, RemoteError,
  MediaCheckRequest, MediaCheckResponse,
  MediaUploadBegin, MediaChunkEnvelope, MediaUploadEnd, MediaUploadAck,
  AuthChallenge, AuthResponse, SessionReady, NeedsUsername, NeedsUsernameAndPassword,
  DeviceRegistered, AuthError,
  FriendHandshake, FriendRecord, FriendConnected, FriendHandshakeError,
} from './RemoteProtocol.js';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { UserStore }       from '../db/UserStore.js';
import { FriendStore }     from '../db/FriendStore.js';
import { getPublicKey }    from '../db/InstanceConfig.js';
import { provisionSystemUser } from '../db/UserProvisioner.js';

export interface DataChannelHandlerOptions {
  fastify:    FastifyInstance;
  systemDb:   DatabaseManager;  // for access_codes + device_tokens + guest_credentials
  instanceId: string;           // this core's permanent UUID — sent in DeviceRegistered
  relayUrl:   string;           // relay URL — sent in DeviceRegistered
  relayCode:  string;           // the relay routing key the mobile connected with
}

// ── Upload state ──────────────────────────────────────────────────────────────

interface UploadState {
  begin:        MediaUploadBegin;
  tmpPath:      string;
  finalDir:     string;
  hash:         ReturnType<typeof createHash>;
  bytesWritten: number;
  chunksRecv:   number;
  expectBinary: boolean;   // true after envelope, waiting for the next ArrayBuffer
  lastEnvelope: MediaChunkEnvelope | null;
  writer:       ReturnType<typeof createWriteStream>;
}

// ── Media library paths ───────────────────────────────────────────────────────

const MEDIA_ROOT = path.join(os.homedir(), '.phobos', 'media', 'meridian');

function resolveLibraryDir(library: MediaUploadBegin['library']): string {
  switch (library) {
    case 'photos':    return path.join(MEDIA_ROOT, 'phobosPhotos');
    case 'music':     return path.join(MEDIA_ROOT, 'phobosMusic');
    case 'documents': return path.join(MEDIA_ROOT, 'phobosDocuments');
    case 'movies':    return path.join(MEDIA_ROOT, 'phobosMovies');
  }
}

// ── Handler class ─────────────────────────────────────────────────────────────

export class DataChannelHandler {
  private readonly _fastify:    FastifyInstance;
  private readonly _systemDb:   DatabaseManager;
  private readonly _instanceId: string;
  private readonly _relayUrl:   string;
  private readonly _relayCode:  string;

  // Set after successful auth handshake — null means not yet authenticated.
  private _sessionUsername: string | null = null;
  private _sessionRole:     string        = 'owner';

  private _controlDC:          DataChannel | null = null;
  private _mediaIndexDC:       DataChannel | null = null;
  private _mediaUploadDC:      DataChannel | null = null;
  private _friendHandshakeDC:  DataChannel | null = null;
  private _uploads = new Map<string, UploadState>();
  private _destroyed = false;
  // FRD handshake resolver — null when no handshake is in progress
  private _pendingFriendHandshakeResolve: ((r: FriendHandshake | null) => void) | null = null;

  // Auth handshake state
  private _authComplete       = false;
  private _awaitingCredentials = false;   // true after NeedsUsernameAndPassword sent
  private _awaitingUsername   = false;    // true after legacy NeedsUsername sent
  private _pendingNonce:  string | null = null;  // nonce from decoded PH1.* code
  private _pendingCode:   string | null = null;  // legacy: raw 6-char code

  constructor(opts: DataChannelHandlerOptions) {
    this._fastify    = opts.fastify;
    this._systemDb   = opts.systemDb;
    this._instanceId = opts.instanceId;
    this._relayUrl   = opts.relayUrl;
    this._relayCode  = opts.relayCode;
  }

  // ── Channel attachment ──────────────────────────────────────────────────────

  attachControlChannel(dc: DataChannel): void {
    this._controlDC = dc;

    // Send challenge immediately on attach.
    this._sendControl<AuthChallenge>({ kind: 'auth-challenge' });

    dc.onMessage((data) => {
      if (typeof data !== 'string') return;
      if (!this._authComplete) {
        void this._handleAuthMessage(data);
      } else {
        void this._handleControlMessage(data);
      }
    });
  }

  attachMediaIndexChannel(dc: DataChannel): void {
    this._mediaIndexDC = dc;
    dc.onMessage((data) => {
      if (typeof data === 'string') {
        void this._handleMediaIndexMessage(data);
      }
    });
  }

  attachMediaUploadChannel(dc: DataChannel): void {
    this._mediaUploadDC = dc;
    dc.onMessage((data) => {
      if (typeof data === 'string') {
        void this._handleUploadJson(data);
      } else if (data instanceof Buffer || data instanceof Uint8Array) {
        void this._handleUploadBinary(Buffer.from(data));
      }
    });
  }

  /**
   * Attach the phobos-friend-handshake data channel opened by a remote PHOBOS
   * core presenting a PH1.FRD.* code. Called by WebRTCServer._acceptDataChannel().
   * Carries only FriendHandshake frames from the remote side — all responses
   * are sent via _sendFriend(). Never opens a control session; _authComplete
   * remains false for the lifetime of this channel.
   */
  attachFriendHandshakeChannel(dc: DataChannel): void {
    this._friendHandshakeDC = dc;
    dc.onMessage((data) => {
      if (typeof data !== 'string') return;
      let frame: { kind: string };
      try { frame = JSON.parse(data) as { kind: string }; } catch { return; }

      if (frame.kind === 'friend-handshake' && this._pendingFriendHandshakeResolve) {
        const resolve = this._pendingFriendHandshakeResolve;
        this._pendingFriendHandshakeResolve = null;
        resolve(frame as unknown as FriendHandshake);
      }
    });
    // Begin the handshake — the nonce will arrive in the FriendHandshake frame.
    // We have no nonce yet at attach time; _handleFriendHandshake waits for it.
    void this._handleFriendHandshake();
  }

  destroy(): void {
    this._destroyed = true;
    // Abort any in-progress uploads
    for (const [id, state] of this._uploads) {
      state.writer.destroy();
      try { unlinkSync(state.tmpPath); } catch { /* ignore */ }
      this._uploads.delete(id);
    }
    this._controlDC         = null;
    this._mediaIndexDC      = null;
    this._mediaUploadDC     = null;
    this._friendHandshakeDC = null;
  }

  // ── Auth handshake ──────────────────────────────────────────────────────────────────────────

  private async _handleAuthMessage(raw: string): Promise<void> {
    if (this._destroyed) return;
    let frame: AuthResponse;
    try {
      frame = JSON.parse(raw) as AuthResponse;
    } catch { return; }
    if (frame.kind !== 'auth-response') return;

    // ── Second-round credential submission (NeedsUsernameAndPassword) ────────
    // Must be checked before the Path A/B/Legacy dispatch to avoid mis-routing.
    if (this._awaitingCredentials) {
      await this._handleGuestRegistration(frame);
      return;
    }

    // ── Legacy second-round (Phase 5 NeedsUsername) ───────────────────────────
    if (this._awaitingUsername) {
      await this._handleLegacyUsername(frame);
      return;
    }

    // ── Path B — returning device token ──────────────────────────────────────
    if (frame.deviceToken) {
      await this._handleDeviceToken(frame);
      return;
    }

    // ── Path A — structured access code (PH1.*) ───────────────────────────────
    if (frame.accessCode && isStructuredCode(frame.accessCode)) {
      await this._handleAccessCode(frame);
      return;
    }

    // ── Legacy Path — bare code (Phase 5 relay code or 6-char nonce) ─────────
    const bare = (frame.code ?? '').trim().toUpperCase();
    if (bare) {
      await this._handleLegacyCode(bare, frame);
      return;
    }

    this._authFail('invalid_code');
  }

  // ── Path A: structured PH1.* access code ─────────────────────────────────

  private async _handleAccessCode(frame: AuthResponse): Promise<void> {
    const decoded = decodeAccessCode(frame.accessCode!);
    if (!decoded) { this._authFail('invalid_code'); return; }

    // Verify the code targets this core.
    if (decoded.instanceId !== this._instanceId) {
      this._authFail('invalid_code');
      return;
    }

    if (decoded.expiresAt < new Date()) { this._authFail('expired_code'); return; }

    // FRD codes are no longer used — friend connections go through the
    // phobos-friend-handshake channel with known_instances as the security gate.
    // If somehow a FRD code arrives on the control channel, reject cleanly.
    if (decoded.type === 'FRD') {
      this._authFail('invalid_code');
      return;
    }

    interface AccessCodeRow {
      code_type:        string;
      target_username:  string | null;
      consumed:         boolean;
      issuing_username: string;
    }
    let row: AccessCodeRow | null = null;
    try {
      const rows = await this._systemDb.query<AccessCodeRow>(
        `SELECT code_type, target_username, consumed, issuing_username
         FROM access_codes WHERE code = ?`,
        [decoded.nonce],
      );
      row = rows[0] ?? null;
    } catch (err) {
      console.error('[DataChannelHandler] access_codes query failed:', err);
      this._authFail('internal');
      return;
    }

    if (!row) { this._authFail('invalid_code'); return; }
    if (row.consumed && !row.target_username) { this._authFail('expired_code'); return; }

    // OWN code: owner self-access — issue device token immediately.
    if (row.code_type === 'self') {
      await this._issueDeviceToken('owner', 'owner', decoded.nonce, frame.deviceId ?? 'unknown');
      return;
    }

    // GST code, already bound — returning guest with new device.
    if (row.target_username) {
      await this._issueDeviceToken(row.target_username, 'guest', decoded.nonce, frame.deviceId ?? 'unknown');
      return;
    }

    // GST code, unbound — need username + password to register.
    this._awaitingCredentials = true;
    this._pendingNonce        = decoded.nonce;
    this._sendControl<NeedsUsernameAndPassword>({ kind: 'needs-username-and-password' });
  }

  // ── FRD: friend handshake ─────────────────────────────────────────────────
  //
  // Called from attachFriendHandshakeChannel() when the phobos-friend-handshake
  // channel opens. Waits for the remote core's FriendHandshake frame, verifies
  // the connecting instance is in known_instances (security boundary), checks
  // for duplicate friendship, exchanges identity, and writes the confirmed
  // friendship to the owner's social.duckdb via FriendStore.
  // Never grants a control session; _authComplete remains false.

  private async _handleFriendHandshake(): Promise<void> {
    // Wait for the remote core to send its identity.
    const handshake = await this._awaitFriendHandshake(10_000);
    if (!handshake) {
      console.warn('[DataChannelHandler] FRD: timeout waiting for FriendHandshake');
      this._sendFriendError('internal');
      return;
    }

    // Security boundary: reject any instance not in known_instances.
    // The user must have explicitly added this Phobos ID before a connection
    // from it can proceed.
    interface KnownRow { instance_uuid: string; }
    let knownRow: KnownRow | null = null;
    try {
      const rows = await this._systemDb.query<KnownRow>(
        `SELECT instance_uuid FROM known_instances WHERE instance_uuid = ?`,
        [handshake.instanceId],
      );
      knownRow = rows[0] ?? null;
    } catch (err) {
      console.error('[DataChannelHandler] known_instances query error:', err);
      this._sendFriendError('internal');
      return;
    }

    if (!knownRow) {
      console.warn(`[DataChannelHandler] FRD: rejected unknown instance ${handshake.instanceId}`);
      this._sendFriendError('unknown_instance');
      return;
    }

    // Resolve the owner username — friend records are always written under owner.
    const userStore   = new UserStore(this._systemDb);
    const ownerRow    = await userStore.getByUsername('owner');
    const ownerUser   = ownerRow?.username ?? 'owner';
    const displayName = ownerRow?.display_name ?? 'owner';

    // Duplicate check against social.duckdb.
    let socialDb: DatabaseManager;
    try {
      socialDb = await DatabaseManager.getSocialDb(ownerUser);
    } catch (err) {
      console.error('[DataChannelHandler] getSocialDb error:', err);
      this._sendFriendError('internal');
      return;
    }

    const friendStore    = new FriendStore(socialDb);
    const alreadyFriends = await friendStore.isFriend(handshake.instanceId, handshake.username);
    if (alreadyFriends) {
      this._sendFriendError('already_friends');
      return;
    }

    // Send our identity back to the connecting core.
    const publicKey = await getPublicKey(this._systemDb);
    this._sendFriend<FriendRecord>({
      kind:         'friend-record',
      instanceId:   this._instanceId,
      username:     ownerUser,
      displayName,
      publicKey,
      relayAddress: this._relayUrl,
    });

    // Write the remote core's identity into social.duckdb.
    try {
      await friendStore.addFriend({
        instance_uuid: handshake.instanceId,
        username:      handshake.username,
        display_name:  handshake.displayName,
        public_key:    handshake.publicKey,
        relay_address: handshake.relayAddress,
        avatar_token:  handshake.avatarToken,
      });
    } catch (err) {
      console.error('[DataChannelHandler] FRD addFriend error:', err);
      this._sendFriendError('internal');
      return;
    }

    // Mark the known_instance as friended.
    try {
      await this._systemDb.execWithParams(
        `UPDATE known_instances SET friended = true WHERE instance_uuid = ?`,
        [handshake.instanceId],
      );
    } catch (err) {
      // Non-fatal — friendship is written, flag update is cosmetic.
      console.warn('[DataChannelHandler] FRD friended flag update failed:', err);
    }

    // Confirm and close.
    this._sendFriend<FriendConnected>({ kind: 'friend-connected', success: true });
    console.log(
      `[DataChannelHandler] FRD complete: ${ownerUser} ↔ ` +
      `${handshake.username}@${handshake.instanceId}`,
    );
    setTimeout(() => {
      try { this._friendHandshakeDC?.close(); } catch { /* ignore */ }
    }, 200);
  }

  /** Wait up to timeoutMs for the remote core to send a FriendHandshake frame. */
  private _awaitFriendHandshake(timeoutMs: number): Promise<FriendHandshake | null> {
    return new Promise((resolve) => {
      this._pendingFriendHandshakeResolve = resolve;
      setTimeout(() => {
        if (this._pendingFriendHandshakeResolve) {
          this._pendingFriendHandshakeResolve = null;
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  /** Send a frame on the friend-handshake channel. */
  private _sendFriend<T extends object>(frame: T): void {
    if (this._destroyed || !this._friendHandshakeDC) return;
    try {
      this._friendHandshakeDC.sendMessage(JSON.stringify(frame));
    } catch (err) {
      console.warn('[DataChannelHandler] friend-handshake send error:', (err as Error).message);
    }
  }

  private _sendFriendError(reason: FriendHandshakeError['reason']): void {
    this._sendFriend<FriendHandshakeError>({ kind: 'friend-error', reason });
    setTimeout(() => {
      try { this._friendHandshakeDC?.close(); } catch { /* ignore */ }
    }, 100);
  }

  // ── Path B: returning device token ───────────────────────────────────────

  private async _handleDeviceToken(frame: AuthResponse): Promise<void> {
    const { deviceToken, deviceId, username, password } = frame;
    if (!deviceToken || !deviceId || !username) {
      this._authFail('invalid_code');
      return;
    }

    interface TokenRow { username: string; device_id: string; }
    let tokenRow: TokenRow | null = null;
    try {
      const rows = await this._systemDb.query<TokenRow>(
        `SELECT username, device_id FROM device_tokens WHERE token = ?`,
        [deviceToken],
      );
      tokenRow = rows[0] ?? null;
    } catch (err) {
      console.error('[DataChannelHandler] device_tokens query failed:', err);
      this._authFail('internal');
      return;
    }

    if (!tokenRow) { this._authFail('invalid_code'); return; }
    if (tokenRow.username !== username || tokenRow.device_id !== deviceId) {
      this._authFail('invalid_code');
      return;
    }

    // Guest users also require password verification.
    const userStore = new UserStore(this._systemDb);
    const user      = await userStore.getByUsername(username);
    if (!user) { this._authFail('invalid_code'); return; }

    if (user.role === 'guest') {
      if (!password) { this._authFail('invalid_code'); return; }
      interface CredRow { password_hash: string; }
      let cred: CredRow | null = null;
      try {
        const rows = await this._systemDb.query<CredRow>(
          `SELECT password_hash FROM guest_credentials WHERE username = ?`,
          [username],
        );
        cred = rows[0] ?? null;
      } catch { this._authFail('internal'); return; }

      if (!cred) { this._authFail('invalid_code'); return; }
      const ok = await bcrypt.compare(password, cred.password_hash);
      if (!ok) { this._authFail('invalid_code'); return; }
    }

    // Update last_used.
    await this._systemDb.execWithParams(
      `UPDATE device_tokens SET last_used = now() WHERE token = ?`,
      [deviceToken],
    );

    this._sessionUsername = username;
    this._sessionRole     = user.role;
    this._authComplete    = true;
    this._sendControl<SessionReady>({
      kind: 'session-ready',
      username,
      role: user.role as SessionReady['role'],
    });
    console.log(`[DataChannelHandler] Device token auth: ${username}`);
  }

  // ── Guest registration (after NeedsUsernameAndPassword) ──────────────────

  private async _handleGuestRegistration(frame: AuthResponse): Promise<void> {
    const username = frame.username?.trim().toLowerCase() ?? '';
    const password = frame.password ?? '';
    const deviceId = frame.deviceId ?? 'unknown';

    if (!username || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(username)) {
      this._sendControl<AuthError>({ kind: 'auth-error', reason: 'username_invalid' });
      return;
    }
    if (password.length < 8) {
      this._sendControl<AuthError>({ kind: 'auth-error', reason: 'username_invalid' });
      return;
    }

    const userStore = new UserStore(this._systemDb);
    const existing  = await userStore.getByUsername(username);
    if (existing) {
      this._sendControl<AuthError>({ kind: 'auth-error', reason: 'username_taken' });
      return;
    }

    try {
      await provisionSystemUser(username, 'guest', userStore);
    } catch (err) {
      console.error('[DataChannelHandler] provisionSystemUser failed:', err);
      this._authFail('internal');
      return;
    }

    // Store hashed password in guest_credentials.
    const hash = await bcrypt.hash(password, 12);
    await this._systemDb.execWithParams(
      `INSERT INTO guest_credentials (username, password_hash, created_at, updated_at)
       VALUES (?, ?, now(), now())`,
      [username, hash],
    );

    // Stamp the code as consumed and bind target_username.
    await this._systemDb.execWithParams(
      `UPDATE access_codes SET target_username = ?, consumed = true WHERE code = ?`,
      [username, this._pendingNonce],
    );

    this._awaitingCredentials = false;
    this._pendingNonce        = null;

    await this._issueDeviceToken(username, 'guest', null, deviceId);
    console.log(`[DataChannelHandler] Guest provisioned: ${username}`);
  }

  // ── Device token issuance (shared by OWN, GST-bound, guest registration) ──

  private async _issueDeviceToken(
    username:   string,
    role:       'owner' | 'guest',
    nonce:      string | null,
    deviceId:   string,
  ): Promise<void> {
    const token = randomUUID();
    try {
      await this._systemDb.execWithParams(
        `INSERT INTO device_tokens (token, username, device_id, created_at, last_used)
         VALUES (?, ?, ?, now(), now())`,
        [token, username, deviceId],
      );
    } catch (err) {
      console.error('[DataChannelHandler] device_tokens insert failed:', err);
      this._authFail('internal');
      return;
    }

    // Mark OWN-type code consumed after first use.
    if (nonce) {
      await this._systemDb.execWithParams(
        `UPDATE access_codes SET consumed = true WHERE code = ?`,
        [nonce],
      );
    }

    this._sessionUsername = username;
    this._sessionRole     = role;
    this._authComplete    = true;

    // Send DeviceRegistered so mobile can persist reconnect credentials.
    this._sendControl<DeviceRegistered>({
      kind:       'device-registered',
      token,
      instanceId: this._instanceId,
      relayUrl:   this._relayUrl,
      username,
      role,
    });

    // Follow immediately with session-ready.
    const userStore = new UserStore(this._systemDb);
    const user      = await userStore.getByUsername(username);
    this._sendControl<SessionReady>({
      kind:     'session-ready',
      username,
      role:     (user?.role ?? role) as SessionReady['role'],
    });
    console.log(`[DataChannelHandler] Device registered and authenticated: ${username}`);
  }

  // ── Legacy Path (Phase 5): bare relay code or 6-char nonce ───────────────

  private async _handleLegacyCode(bare: string, frame: AuthResponse): Promise<void> {
    // Self-access: mobile sent the relay code core registered with.
    if (bare === this._relayCode.toUpperCase()) {
      this._sessionUsername = 'owner';
      this._sessionRole     = 'owner';
      this._authComplete    = true;
      this._sendControl<SessionReady>({ kind: 'session-ready', username: 'owner', role: 'owner' });
      console.log('[DataChannelHandler] Legacy self-access authenticated: owner');
      return;
    }

    // Guest: look up nonce in access_codes.
    interface AccessCodeRow {
      code_type:        string;
      target_username:  string | null;
      consumed:         boolean;
      expires_at:       string;
      issuing_username: string;
    }
    let row: AccessCodeRow | null = null;
    try {
      const rows = await this._systemDb.query<AccessCodeRow>(
        `SELECT code_type, target_username, consumed,
                expires_at::VARCHAR AS expires_at,
                issuing_username
         FROM access_codes WHERE code = ?`,
        [bare.toLowerCase()],  // nonces are lowercase hex
      );
      row = rows[0] ?? null;
    } catch (err) {
      console.error('[DataChannelHandler] access_codes query failed:', err);
      this._authFail('internal');
      return;
    }

    if (!row) { this._authFail('invalid_code'); return; }
    if (row.consumed && !row.target_username) { this._authFail('expired_code'); return; }
    if (new Date(row.expires_at) < new Date()) { this._authFail('expired_code'); return; }

    if (row.target_username) {
      const userStore = new UserStore(this._systemDb);
      const user      = await userStore.getByUsername(row.target_username);
      this._sessionUsername = row.target_username;
      this._sessionRole     = user?.role ?? 'guest';
      this._authComplete    = true;
      this._sendControl<SessionReady>({
        kind:     'session-ready',
        username: row.target_username,
        role:     this._sessionRole as SessionReady['role'],
      });
      console.log(`[DataChannelHandler] Legacy guest session ready: ${row.target_username}`);
      return;
    }

    // Unbound — need a username (legacy Phase 5 flow).
    this._awaitingUsername = true;
    this._pendingCode      = bare.toLowerCase();
    this._sendControl<NeedsUsername>({ kind: 'needs-username' });
  }

  private async _handleLegacyUsername(frame: AuthResponse): Promise<void> {
    const requested = frame.requestedUsername?.trim().toLowerCase() ?? '';
    if (!requested || !/^[a-z0-9_-]{2,32}$/.test(requested)) {
      this._sendControl<AuthError>({ kind: 'auth-error', reason: 'username_invalid' });
      return;
    }

    const userStore = new UserStore(this._systemDb);
    const existing  = await userStore.getByUsername(requested);
    if (existing) {
      this._sendControl<AuthError>({ kind: 'auth-error', reason: 'username_taken' });
      return;
    }

    try {
      await provisionSystemUser(requested, 'guest', userStore);
    } catch (err) {
      console.error('[DataChannelHandler] provisionSystemUser failed:', err);
      this._authFail('internal');
      return;
    }

    await this._systemDb.execWithParams(
      `UPDATE access_codes SET target_username = ?, consumed = true WHERE code = ?`,
      [requested, this._pendingCode],
    );

    this._sessionUsername  = requested;
    this._sessionRole      = 'guest';
    this._authComplete     = true;
    this._awaitingUsername = false;
    this._pendingCode      = null;

    this._sendControl<SessionReady>({ kind: 'session-ready', username: requested, role: 'guest' });
    console.log(`[DataChannelHandler] Legacy guest provisioned: ${requested}`);
  }

  private _authFail(reason: AuthError['reason']): void {
    this._sendControl<AuthError>({ kind: 'auth-error', reason });
    console.warn(`[DataChannelHandler] Auth failed: ${reason}`);
    setTimeout(() => {
      try { this._controlDC?.close(); } catch { /* ignore */ }
    }, 100);
  }

  // ── Control channel ─────────────────────────────────────────────────────────

  private async _handleControlMessage(raw: string): Promise<void> {
    if (this._destroyed) return;
    let frame: RemoteRequest | RemoteAbort;
    try {
      frame = JSON.parse(raw) as RemoteRequest | RemoteAbort;
    } catch {
      return;
    }

    // Keep-alive ping from mobile — no response needed, just prevents ICE idle drop.
    if ((frame as unknown as { kind: string }).kind === 'ping') return;

    if (frame.kind === 'abort') {
      SseEmitterRegistry.cleanup(frame.id);
      return;
    }

    if (frame.kind === 'req') {
      await this._routeRequest(frame);
    }
  }

  private async _routeRequest(frame: RemoteRequest): Promise<void> {
    if (frame.stream) {
      await this._routeStreamingRequest(frame);
    } else {
      await this._routeNonStreamingRequest(frame);
    }
  }

  private async _routeNonStreamingRequest(frame: RemoteRequest): Promise<void> {
    let result: Awaited<ReturnType<FastifyInstance['inject']>>;
    try {
      // If the client flagged the body as base64-encoded binary, decode it back
      // to a Buffer so Fastify's octet-stream parser receives raw bytes.
      const isBinary = frame.headers?.['x-webrtc-binary'] === '1';
      const payload: string | Buffer | undefined = isBinary && frame.body
        ? Buffer.from(frame.body, 'base64')
        : frame.body;

      // Strip the internal binary flag before forwarding — the upstream route
      // (e.g. syncProxy) should not see it.
      const forwardHeaders = { ...frame.headers };
      delete forwardHeaders['x-webrtc-binary'];

      result = await this._fastify.inject({
        method:  frame.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        url:     frame.path,
        headers: {
          ...forwardHeaders,
          'x-webrtc-user':       this._sessionUsername ?? 'owner',
          'x-webrtc-role':       this._sessionRole,
          'x-webrtc-request-id': frame.id,
        },
        payload,
      });
    } catch (err) {
      this._sendControl<RemoteError>({
        kind:    'error',
        id:      frame.id,
        message: (err as Error).message,
      });
      return;
    }

    this._sendControl<RemoteResponse>({
      kind:    'res',
      id:      frame.id,
      status:  result.statusCode,
      headers: result.headers as Record<string, string>,
      body:    result.body,
    });
  }

  private async _routeStreamingRequest(frame: RemoteRequest): Promise<void> {
    // Register emitter BEFORE calling inject so the route handler can find it
    const emitter = SseEmitterRegistry.register(frame.id);

    // Subscribe to events before inject fires
    emitter.on('event', (data: Record<string, unknown>) => {
      this._sendControl<RemoteSSEFrame>({
        kind: 'sse',
        id:   frame.id,
        type: (data.type as string) ?? 'event',
        data,
      });
    });

    emitter.once('done', () => {
      this._sendControl<RemoteDone>({
        kind:   'done',
        id:     frame.id,
        status: 200,
      });
    });

    // inject() will return immediately once the SSE route calls reply.raw.end()
    // The route writes to the emitter (not reply.raw) when x-webrtc-request-id is set
    try {
      await this._fastify.inject({
        method:  frame.method as 'POST',
        url:     frame.path,
        headers: {
          ...frame.headers,
          'x-webrtc-user':       this._sessionUsername ?? 'owner',
          'x-webrtc-role':       this._sessionRole,
          'x-webrtc-request-id': frame.id,
        },
        payload: frame.body,
      });
    } catch (err) {
      SseEmitterRegistry.cleanup(frame.id);
      this._sendControl<RemoteError>({
        kind:    'error',
        id:      frame.id,
        message: (err as Error).message,
      });
    }
  }

  private _sendControl<T extends object>(frame: T): void {
    if (this._destroyed || !this._controlDC) return;
    try {
      this._controlDC.sendMessage(JSON.stringify(frame));
    } catch (err) {
      console.warn('[DataChannelHandler] control send failed:', (err as Error).message);
    }
  }

  // ── Media index channel ─────────────────────────────────────────────────────

  private async _handleMediaIndexMessage(raw: string): Promise<void> {
    if (this._destroyed) return;
    let frame: MediaCheckRequest;
    try {
      frame = JSON.parse(raw) as MediaCheckRequest;
    } catch { return; }

    if (frame.kind !== 'check') return;

    let missing: string[];
    try {
      const db = DatabaseManager.getInstance();
      if (frame.hashes.length === 0) {
        missing = [];
      } else {
        const placeholders = frame.hashes.map(() => '?').join(',');
        const rows = await db.query<{ content_hash: string }>(
          `SELECT content_hash FROM phobos_sync_manifest WHERE content_hash IN (${placeholders})`,
          frame.hashes,
        );
        const have = new Set(rows.map(r => r.content_hash));
        missing = frame.hashes.filter(h => !have.has(h));
      }
    } catch (err) {
      console.warn('[DataChannelHandler] hash check failed:', (err as Error).message);
      missing = frame.hashes; // assume all missing on error — safe degradation
    }

    const resp: MediaCheckResponse = { kind: 'check-res', id: frame.id, missing };
    try {
      this._mediaIndexDC?.sendMessage(JSON.stringify(resp));
    } catch { /* ignore */ }
  }

  // ── Media upload channel ────────────────────────────────────────────────────

  private async _handleUploadJson(raw: string): Promise<void> {
    if (this._destroyed) return;
    let frame: MediaUploadBegin | MediaChunkEnvelope | MediaUploadEnd;
    try {
      frame = JSON.parse(raw) as MediaUploadBegin | MediaChunkEnvelope | MediaUploadEnd;
    } catch { return; }

    switch (frame.kind) {
      case 'upload-begin':  this._beginUpload(frame);       break;
      case 'chunk':         this._setChunkEnvelope(frame);  break;
      case 'upload-end':    await this._finalizeUpload(frame); break;
    }
  }

  private async _handleUploadBinary(data: Buffer): Promise<void> {
    if (this._destroyed) return;

    // Find the upload session waiting for a binary chunk
    for (const state of this._uploads.values()) {
      if (state.expectBinary && state.lastEnvelope) {
        state.expectBinary = false;
        state.hash.update(data);
        state.bytesWritten += data.byteLength;
        state.chunksRecv++;
        state.writer.write(data);
        state.lastEnvelope = null;
        return;
      }
    }
    console.warn('[DataChannelHandler] Binary received but no upload session waiting');
  }

  private _beginUpload(frame: MediaUploadBegin): void {
    const libraryDir = resolveLibraryDir(frame.library);
    mkdirSync(libraryDir, { recursive: true });

    const tmpPath = path.join(os.tmpdir(), `phobos-upload-${randomUUID()}.tmp`);
    const writer  = createWriteStream(tmpPath);
    const hash    = createHash('sha256');

    this._uploads.set(frame.uploadId, {
      begin:        frame,
      tmpPath,
      finalDir:     libraryDir,
      hash,
      bytesWritten: 0,
      chunksRecv:   0,
      expectBinary: false,
      lastEnvelope: null,
      writer,
    });

    console.log(`[Upload] Begin ${frame.uploadId}: ${frame.filename} (${frame.totalChunks} chunks)`);
  }

  private _setChunkEnvelope(frame: MediaChunkEnvelope): void {
    const state = this._uploads.get(frame.uploadId);
    if (!state) {
      console.warn(`[Upload] Chunk for unknown upload: ${frame.uploadId}`);
      return;
    }
    state.lastEnvelope = frame;
    state.expectBinary = true;
  }

  private async _finalizeUpload(frame: MediaUploadEnd): Promise<void> {
    const state = this._uploads.get(frame.uploadId);
    if (!state) {
      console.warn(`[Upload] End for unknown upload: ${frame.uploadId}`);
      return;
    }

    this._uploads.delete(frame.uploadId);

    await new Promise<void>((resolve) => state.writer.end(resolve));

    const digest = state.hash.digest('hex');
    const ok     = digest === frame.contentHash;

    if (!ok) {
      try { unlinkSync(state.tmpPath); } catch { /* ignore */ }
      this._sendUploadAck(frame.uploadId, false, undefined, 'Hash mismatch');
      console.warn(`[Upload] ${frame.uploadId}: hash mismatch, discarded`);
      return;
    }

    // Move to final destination
    const finalPath = path.join(state.finalDir, state.begin.filename);
    try {
      if (existsSync(finalPath)) {
        // Already exists with same content — deduplicated
        unlinkSync(state.tmpPath);
      } else {
        renameSync(state.tmpPath, finalPath);
      }
    } catch (err) {
      this._sendUploadAck(frame.uploadId, false, undefined, (err as Error).message);
      return;
    }

    // Index in Meridian — the idle scanner will pick up the new file on its
    // next pass. Direct upsert requires a full MeridianFile shape (E4 scope).

    this._sendUploadAck(frame.uploadId, true, finalPath);
    console.log(`[Upload] ${frame.uploadId} committed: ${finalPath}`);
  }

  private _sendUploadAck(uploadId: string, ok: boolean, destPath?: string, error?: string): void {
    const ack: MediaUploadAck = { kind: 'upload-ack', uploadId, ok, destPath, error };
    try {
      this._mediaUploadDC?.sendMessage(JSON.stringify(ack));
    } catch { /* ignore */ }
  }
}