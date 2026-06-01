/**
 * RemoteProtocol.ts — wire frame types for the PHOBOS WebRTC data channels.
 *
 * THIS FILE IS A SHARED CONTRACT.
 * It must be identical in phobos-mobile and phobos-core.
 * Any change to a frame shape requires updating both repos simultaneously.
 *
 * Three channels, three namespaces:
 *   phobos-control      — all API traffic (fetch + streamPost equivalents)
 *   phobos-media-index  — hash batch checks during sync
 *   phobos-media-upload — binary asset chunks during sync
 *
 * All messages are JSON strings except MediaChunkEnvelope's binary follow-up,
 * which is a raw ArrayBuffer sent as the immediately subsequent DC message.
 */

// ── Control channel — mobile → core ──────────────────────────────────────────

/** Replaces a fetch() or streamPost() call over the data channel. */
export interface RemoteRequest {
  kind:    'req';
  id:      string;                      // crypto.randomUUID() — unique per request
  method:  string;                      // 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path:    string;                      // e.g. '/api/messages'
  headers: Record<string, string>;
  body?:   string;                      // JSON string; omit for GET
  stream?: boolean;                     // true when caller wants SSE frames back
}

/** Cancels an in-flight streaming request before it completes. */
export interface RemoteAbort {
  kind: 'abort';
  id:   string;                         // matches the RemoteRequest id to cancel
}

// ── Control channel — core → mobile ──────────────────────────────────────────

/** Response to a non-streaming RemoteRequest. */
export interface RemoteResponse {
  kind:    'res';
  id:      string;                      // matches RemoteRequest id
  status:  number;                      // HTTP status code
  headers: Record<string, string>;
  body:    string;                      // JSON string
}

/** One SSE event forwarded from a streaming request. */
export interface RemoteSSEFrame {
  kind: 'sse';
  id:   string;                         // matches RemoteRequest id
  type: string;                         // SSE event type, e.g. 'output_token'
  data: unknown;                        // parsed JSON payload
}

/** Signals the end of a streaming request. */
export interface RemoteDone {
  kind:   'done';
  id:     string;                       // matches RemoteRequest id
  status: number;                       // final HTTP status
}

/** Signals an error on a streaming or non-streaming request. */
export interface RemoteError {
  kind:    'error';
  id:      string;
  message: string;
}

// ── Media index channel — mobile → core ──────────────────────────────────────

/** Batch hash check — sent during sync to find which assets are missing on host. */
export interface MediaCheckRequest {
  kind:   'check';
  id:     string;
  hashes: string[];                     // SHA-256 hex digests, up to 500 per message
}

// ── Media index channel — core → mobile ──────────────────────────────────────

/** Which of the submitted hashes are not present on the host. */
export interface MediaCheckResponse {
  kind:    'check-res';
  id:      string;                      // matches MediaCheckRequest id
  missing: string[];                    // subset of input hashes not found on host
}

// ── Media upload channel — mobile → core ─────────────────────────────────────

/** Opens an upload session. Sent before any chunks. */
export interface MediaUploadBegin {
  kind:        'upload-begin';
  uploadId:    string;                  // uuid — identifies this upload session
  filename:    string;
  library:     'photos' | 'music' | 'documents' | 'movies';
  sizeBytes:   number;
  totalChunks: number;
  takenAt:     string | null;
  syncToken?:  string;
}

/**
 * Envelope for one binary chunk. The raw ArrayBuffer follows as the
 * immediately subsequent message on the same data channel.
 *
 * Pattern on the wire:
 *   DC message N:   JSON string — MediaChunkEnvelope
 *   DC message N+1: ArrayBuffer — raw chunk bytes (up to 256 KB)
 */
export interface MediaChunkEnvelope {
  kind:       'chunk';
  uploadId:   string;
  chunkIndex: number;                   // 0-based
}

/** Sent after all chunks. Triggers integrity check and file commit on core. */
export interface MediaUploadEnd {
  kind:        'upload-end';
  uploadId:    string;
  contentHash: string;                  // SHA-256 hex of the complete assembled file
}

// ── Media upload channel — core → mobile ─────────────────────────────────────

/** Core confirmation after receiving and committing the full file. */
export interface MediaUploadAck {
  kind:      'upload-ack';
  uploadId:  string;
  ok:        boolean;
  destPath?: string;                    // server-side path; present when ok: true
  error?:    string;                    // reason; present when ok: false
}

// ── Union types for exhaustive dispatch ──────────────────────────────────────

export type ControlFrameOutbound =
  | RemoteRequest
  | RemoteAbort;

export type ControlFrameInbound =
  | RemoteResponse
  | RemoteSSEFrame
  | RemoteDone
  | RemoteError;

export type MediaIndexFrameOutbound = MediaCheckRequest;
export type MediaIndexFrameInbound  = MediaCheckResponse;

export type MediaUploadFrameOutbound =
  | MediaUploadBegin
  | MediaChunkEnvelope
  | MediaUploadEnd;

export type MediaUploadFrameInbound = MediaUploadAck;

// ── Signaling message shapes (relay ↔ core WebSocket) ────────────────────────

/** Core → relay: register this instance and request a code. */
export interface SignalRegister {
  type:        'register';
  instanceId?: string;                  // permanent instance UUID — optional for backward compat
  activeUser:  string;                  // 'owner' for E2
}

/** relay → core: code issued, ICE servers provided. */
export interface SignalRegistered {
  type:       'registered';
  code:       string;                   // 6-char A-Z2-9
  iceServers: RTCIceServer[];
  expiresIn:  number;                   // ms until code expires
}

/** relay → core: mobile has posted an offer for this code. */
export interface SignalOffer {
  type:       'offer';
  code:       string;
  sdp:        string;
  activeUser: string;
  candidates?: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }[];
}

/** Core → relay: answer to mobile's offer. */
export interface SignalAnswer {
  type: 'answer';
  code: string;
  sdp:  string;
}

/** Either direction: trickle ICE candidate. */
export interface SignalIce {
  type:          'ice';
  code:          string;
  candidate:     string;
  sdpMid:        string | null;
  sdpMLineIndex: number | null;
}

/** relay → core: code consumed — mobile is connecting. */
export interface SignalConsumed {
  type: 'consumed';
  code: string;
}

/** core → relay: push a sync-dirty notification to the registered background service. */
export interface SyncNotify {
  type:       'notify';
  instanceId: string;
  event:      'sync_dirty';
}

export type RelayInbound  = SignalRegistered | SignalOffer | SignalIce | SignalConsumed
                          | FriendRequestMessage | FriendRequestAck;
export type RelayOutbound = SignalRegister | SignalAnswer | SignalIce | SyncNotify;

// ── Auth handshake — control channel, immediately after DC open ───────────────
//
// Phase 6 flow (three paths):
//   Path A — first-time device registration:
//     core → mobile : AuthChallenge
//     mobile → core : AuthResponse { accessCode: 'PH1.*' }
//     core → mobile : NeedsUsernameAndPassword  (GST codes only)
//     mobile → core : AuthResponse { username, password }
//     core → mobile : DeviceRegistered { token, instanceId, relayUrl }
//     core → mobile : SessionReady
//
//   Path B — returning device:
//     core → mobile : AuthChallenge
//     mobile → core : AuthResponse { deviceToken, deviceId, username, password? }
//     core → mobile : SessionReady
//
//   Legacy (Phase 5 format — kept for backward compat during transition):
//     core → mobile : AuthChallenge
//     mobile → core : AuthResponse { code: '6CHAR' }
//     core → mobile : SessionReady | NeedsUsername | AuthError

/** core → mobile: sent immediately when control DC opens. */
export interface AuthChallenge {
  kind: 'auth-challenge';
}

/**
 * mobile → core: present credentials.
 * Exactly one of accessCode (Path A) or deviceToken (Path B) or code (legacy)
 * should be set. deviceId should always be present in Phase 6 clients.
 */
export interface AuthResponse {
  kind:               'auth-response';
  // Path A — first-time structured access code
  accessCode?:        string;    // full PH1.* encoded string
  // Path B — returning device
  deviceToken?:       string;    // UUID from a prior DeviceRegistered frame
  // Both Phase 6 paths
  deviceId?:          string;    // Capacitor Device.getId() — binds token to hardware
  username?:          string;    // returning guest, or chosen during guest registration
  password?:          string;    // returning guest credential or new guest password
  passwordConfirm?:   string;    // guest first registration confirmation (client validates)
  // Legacy — Phase 5 format kept for backward compat during transition
  code?:              string;    // bare 6-char relay code or nonce
  requestedUsername?: string;    // Phase 5 guest username submission
}

/** core → mobile: auth accepted, session is live under this username. */
export interface SessionReady {
  kind:     'session-ready';
  username: string;
  role:     'owner' | 'admin' | 'full' | 'guest' | 'read';
}

/** core → mobile: Phase 5 legacy — code valid but no username bound yet. */
export interface NeedsUsername {
  kind: 'needs-username';
}

/** core → mobile: Phase 6 — GST code valid, need username + password to register. */
export interface NeedsUsernameAndPassword {
  kind: 'needs-username-and-password';
}

/**
 * core → mobile: issued after successful first-time auth (Path A).
 * Mobile persists token + instanceId + relayUrl in ServerEntry for reconnects.
 */
export interface DeviceRegistered {
  kind:       'device-registered';
  token:      string;    // device token UUID — store in Preferences
  instanceId: string;    // core's permanent instance UUID = relay routing key
  relayUrl:   string;    // wss://autarch.net/relay (or future relay)
  username:   string;    // confirmed username
  role:       'owner' | 'admin' | 'full' | 'guest' | 'read';
}

/** core → mobile: auth failed — DC will be closed immediately after. */
export interface AuthError {
  kind:   'auth-error';
  reason: 'invalid_code' | 'expired_code' | 'username_taken' | 'username_invalid' | 'internal';
}

export type AuthFrame =
  | AuthChallenge
  | AuthResponse
  | SessionReady
  | NeedsUsername
  | NeedsUsernameAndPassword
  | DeviceRegistered
  | AuthError;
// ── Friend handshake — phobos-friend-handshake channel ───────────────────────
//
// THIS FILE IS A SHARED CONTRACT — must be identical in phobos-mobile.
//
// Flow for inbound FRD code (remote core connects with a PH1.FRD.* code):
//   remote → local  : FriendHandshake  (remote sends its identity + the nonce)
//   local  → remote : FriendRecord     (local sends back its identity)
//   local  → remote : FriendConnected  (local confirms, closes channel)
//
// On error at any point:
//   local  → remote : FriendHandshakeError  (local sends reason, closes channel)

/** remote → local: identity frame sent by the initiating core on channel open. */
export interface FriendHandshake {
  kind:         'friend-handshake';
  instanceId:   string;   // permanent UUID of the remote PHOBOS instance
  username:     string;   // username on the remote instance
  displayName:  string;
  publicKey:    string;   // hex-encoded ed25519 public key
  relayAddress: string;   // wss:// relay the remote core is reachable on
  avatarToken?: string;
}

/** local → remote: local identity sent in response to a valid FriendHandshake. */
export interface FriendRecord {
  kind:         'friend-record';
  instanceId:   string;
  username:     string;
  displayName:  string;
  publicKey:    string;
  relayAddress: string;
  avatarToken?: string;
}

/** local → remote: handshake complete — both sides have written the friendship. */
export interface FriendConnected {
  kind:    'friend-connected';
  success: true;
}

/** local → remote: handshake failed — channel will be closed immediately after. */
export interface FriendHandshakeError {
  kind:   'friend-error';
  reason: 'unknown_instance' | 'already_friends' | 'internal';
}

export type FriendHandshakeFrame =
  | FriendHandshake
  | FriendRecord
  | FriendConnected
  | FriendHandshakeError;

// ── Friend request — relay-brokered, core ↔ core ─────────────────────────────
//
// THIS FILE IS A SHARED CONTRACT — must be identical in phobos-mobile.
//
// Flow (both cores must have each other in known_instances):
//
//   Initiating core → relay → target core : FriendRequestMessage
//     Target may be offline — initiating core retries via pending_outbound_requests
//     timer until target acks or TTL expires.
//
//   Target core → relay → initiating core : FriendRequestAck (accepted | declined)
//     On 'accepted': both cores run the phobos-friend-handshake WebRTC channel.
//     On 'declined': initiating core deletes the pending entry, notifies its UI.
//
// These messages travel over the relay WebSocket as JSON strings, not WebRTC
// data channels. The relay routes them by instanceId.

/** Initiating core → relay → target core: I want to be friends. */
export interface FriendRequestMessage {
  type:            'friend-request';
  fromInstanceId:  string;
  fromUsername:    string;
  fromDisplayName: string;
  fromPublicKey:   string;
  fromRelayAddress: string;
  requestId:       string;   // UUID — used to match ack back to pending entry
  sentAt:          number;   // unix ms
  expiresAt:       number;   // unix ms — initiating core stops retrying after this
}

/** Target core → relay → initiating core: accept or decline. */
export interface FriendRequestAck {
  type:        'friend-request-ack';
  requestId:   string;   // matches FriendRequestMessage.requestId
  decision:    'accepted' | 'declined';
  fromInstanceId: string;  // target's instanceId — so initiating core knows who acked
}

export type SocialRelayMessage = FriendRequestMessage | FriendRequestAck;