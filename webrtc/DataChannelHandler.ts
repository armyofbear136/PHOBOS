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
import type { FastifyInstance } from 'fastify';
import type { DataChannel } from 'node-datachannel';
import * as SseEmitterRegistry from './SseEmitterRegistry.js';
import type {
  RemoteRequest, RemoteAbort,
  RemoteResponse, RemoteSSEFrame, RemoteDone, RemoteError,
  MediaCheckRequest, MediaCheckResponse,
  MediaUploadBegin, MediaChunkEnvelope, MediaUploadEnd, MediaUploadAck,
} from './RemoteProtocol.js';
import { DatabaseManager } from '../db/DatabaseManager.js';

export interface DataChannelHandlerOptions {
  fastify:    FastifyInstance;
  activeUser: string;
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
  private readonly _activeUser: string;
  private _controlDC:     DataChannel | null = null;
  private _mediaIndexDC:  DataChannel | null = null;
  private _mediaUploadDC: DataChannel | null = null;
  private _uploads = new Map<string, UploadState>();
  private _destroyed = false;

  constructor(opts: DataChannelHandlerOptions) {
    this._fastify    = opts.fastify;
    this._activeUser = opts.activeUser;
  }

  // ── Channel attachment ──────────────────────────────────────────────────────

  attachControlChannel(dc: DataChannel): void {
    this._controlDC = dc;
    dc.onMessage((data) => {
      if (typeof data === 'string') {
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

  destroy(): void {
    this._destroyed = true;
    // Abort any in-progress uploads
    for (const [id, state] of this._uploads) {
      state.writer.destroy();
      try { unlinkSync(state.tmpPath); } catch { /* ignore */ }
      this._uploads.delete(id);
    }
    this._controlDC     = null;
    this._mediaIndexDC  = null;
    this._mediaUploadDC = null;
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
      result = await this._fastify.inject({
        method:  frame.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        url:     frame.path,
        headers: {
          ...frame.headers,
          'x-webrtc-user':       this._activeUser,
          'x-webrtc-request-id': frame.id,
        },
        payload: frame.body,
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
          'x-webrtc-user':       this._activeUser,
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
