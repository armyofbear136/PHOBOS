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
  type:       'register';
  activeUser: string;                   // 'owner' for E2
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

export type RelayInbound  = SignalRegistered | SignalOffer | SignalIce | SignalConsumed;
export type RelayOutbound = SignalRegister   | SignalAnswer | SignalIce;
