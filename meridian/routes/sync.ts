/**
 * meridian/routes/sync.ts — PHOBOS MediaSync server-side routes.
 *
 * Mounted on the Meridian Fastify instance (port 16320).
 * All routes except /api/sync/register require Authorization: Bearer <syncToken>.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import path   from 'node:path';
import os     from 'node:os';
import fs     from 'node:fs';
import type { MeridianDB }      from '../db/db.js';
import { MeridianDB as MDB }    from '../db/db.js';
import type { MeridianConfig }  from '../db/config.js';
import type { Scanner }         from '../scanner.js';
import type { UploadDispatcher } from '../staging/UploadDispatcher.js';
import type { DatabaseManager } from '../../db/DatabaseManager.js';
import { generateThumb }        from '../thumbnailer.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SyncLibrary = 'photos' | 'music' | 'documents' | 'movies';

export interface SyncDevice {
  device_id:    string;
  device_name:  string;
  platform:     'ios' | 'android';
  sync_token:   string;
  last_seen_at: string;
}

export interface SyncPolicy {
  id:          string;
  device_id:   string;
  library:     SyncLibrary;
  enabled:     boolean;
  retain_days: number | null;
  upload_mode: 'wifi_only' | 'always' | 'manual';
}

export interface SyncExclusion {
  id:         string;
  policy_id:  string;
  path:       string;
  scope:      'folder' | 'file';
  created_at: string;
}

// Default policies written on first device registration.
const DEFAULT_POLICIES: Array<Pick<SyncPolicy, 'library' | 'enabled' | 'upload_mode' | 'retain_days'>> = [
  { library: 'photos',    enabled: true,  upload_mode: 'wifi_only', retain_days: null },
  { library: 'music',     enabled: false, upload_mode: 'manual',    retain_days: null },
  { library: 'documents', enabled: false, upload_mode: 'manual',    retain_days: null },
  { library: 'movies',    enabled: false, upload_mode: 'manual',    retain_days: null },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function policyId(deviceId: string, library: string): string {
  return crypto.createHash('sha256').update(deviceId + library).digest('hex').slice(0, 16);
}

function exclusionId(polId: string, p: string): string {
  return crypto.createHash('sha256').update(polId + p).digest('hex').slice(0, 16);
}

type Row = Record<string, unknown>;

function mapPolicy(r: Row): SyncPolicy {
  return {
    id:          r.id as string,
    device_id:   r.device_id as string,
    library:     r.library as SyncLibrary,
    enabled:     Boolean(r.enabled),
    retain_days: (r.retain_days == null || Number(r.retain_days) === 0) ? null : Number(r.retain_days),
    upload_mode: r.upload_mode as 'wifi_only' | 'always' | 'manual',
  };
}

function mapExclusion(r: Row): SyncExclusion {
  return {
    id:         r.id as string,
    policy_id:  r.policy_id as string,
    path:       r.path as string,
    scope:      dbScopeToMobile(r.scope as string),
    created_at: r.created_at as string,
  };
}

function mobileScopeToDb(scope: 'folder' | 'file'): 'subtree' | 'exact' {
  return scope === 'folder' ? 'subtree' : 'exact';
}

function dbScopeToMobile(scope: string): 'folder' | 'file' {
  return scope === 'subtree' ? 'folder' : 'file';
}

function contentHashToFileId(contentHash: string): string {
  return contentHash.slice(0, 16);
}

// ── Chunked upload session accumulator ────────────────────────────────────────
//
// All uploads from mobile use the chunked protocol (LARGE_FILE_THRESHOLD = 0).
// Each upload is identified by X-Phobos-Upload-Id. Chunks arrive sequentially
// in order. The server accumulates Buffer chunks in memory and commits on the
// last chunk (identified by X-Phobos-Chunk-Index === X-Phobos-Chunk-Total - 1).
//
// Session lifetime: created on first chunk, deleted on last chunk commit or
// on stale-session sweep (CHUNK_SESSION_TTL_MS). The sweep runs every
// CHUNK_SESSION_SWEEP_MS to prevent unbounded memory growth from abandoned uploads.

interface ChunkSession {
  uploadId:   string;
  deviceId:   string;
  userId:     string;
  library:    SyncLibrary;
  filename:   string;
  albumName:  string;
  takenAt:    string | null;
  sizeBytes:  number;
  total:      number;              // totalChunks from X-Phobos-Chunk-Total
  received:   number;              // count of chunks received so far
  chunks:     Buffer[];            // indexed by chunk order of arrival
  createdAt:  number;              // Date.now() — for TTL sweep
}

const _chunkSessions = new Map<string, ChunkSession>();

const CHUNK_SESSION_TTL_MS   = 10 * 60 * 1000;   // 10 minutes
const CHUNK_SESSION_SWEEP_MS =  5 * 60 * 1000;   //  5 minutes

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of _chunkSessions) {
    if (now - session.createdAt > CHUNK_SESSION_TTL_MS) {
      _chunkSessions.delete(id);
      console.warn(`[SyncRoutes] Swept stale upload session: ${id} (${session.filename})`);
    }
  }
}, CHUNK_SESSION_SWEEP_MS).unref();   // .unref() so the timer doesn't block process exit

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function syncRoutes(
  fastify: FastifyInstance,
  opts: {
    db:               MeridianDB;
    config:           MeridianConfig;
    scanner:          Scanner;
    dispatcher:       UploadDispatcher;
    getUserDb:        (username: string) => DatabaseManager;
    /** Optional — when present, notifySync() is called after each successful upload commit. */
    signalingClient?: { notifySync(): void } | null;
  },
): Promise<void> {

  // ── Per-request MeridianDB scoped to the resolved user ────────────────────
  // Creates a lightweight MeridianDB wrapper sharing the media DB but using
  // the correct user's sync DB. Avoids mutating shared state across concurrent requests.

  function syncDbFor(userId: string): MeridianDB {
    return new MDB(opts.db.mediaDb, opts.getUserDb(userId));
  }

  // ── requireSyncToken ─────────────────────────────────────────────────────
  // Resolves deviceId and userId from the Bearer token.
  // Uses x-webrtc-user (stamped by DataChannelHandler) to select the correct
  // user DB without scanning all user DBs.

  async function requireSyncToken(
    req:   FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ deviceId: string; userId: string } | undefined> {
    const auth  = req.headers['authorization'];
    const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
    if (!token) {
      reply.status(401).send({ error: 'missing_token' });
      return undefined;
    }

    const userId = (req.headers['x-webrtc-user'] as string | undefined)?.trim() || 'owner';
    const rdb    = syncDbFor(userId);

    const rows = await rdb.rawQuery(
      'SELECT device_id FROM phobos_sync_devices WHERE sync_token = ?',
      [token],
    );
    if (rows.length === 0) {
      reply.status(401).send({ error: 'invalid_token' });
      return undefined;
    }

    rdb.rawQuery(
      'UPDATE phobos_sync_devices SET last_seen_at = now() WHERE sync_token = ?',
      [token],
    ).catch(() => {});

    return { deviceId: rows[0].device_id as string, userId };
  }

  // ── ensureUserMeridianLibrary ─────────────────────────────────────────────
  // Creates the per-user Meridian library row in the media DB on first device
  // registration. The directory already exists (created by UserProvisioner).

  async function ensureUserMeridianLibrary(userId: string): Promise<void> {
    const userPhotosPath = path.join(os.homedir(), '.phobos', 'media', 'meridian', userId, 'phobosPhotos');
    fs.mkdirSync(userPhotosPath, { recursive: true });

    const existing = await opts.db.getLibraryByPath(userPhotosPath, userId);
    if (!existing) {
      await opts.db.upsertLibrary({
        id:         crypto.createHash('sha256').update(userPhotosPath + userId).digest('hex').slice(0, 16),
        path:       userPhotosPath,
        label:      `${userId} Photos`,
        enabled:    true,
        lastScanAt: null,
        fileCount:  0,
        userId,
        createdAt:  new Date().toISOString(),
      });
      console.log(`[SyncRoutes] Created Meridian library for user ${userId} at ${userPhotosPath}`);
    }
  }

  // ── POST /api/sync/register ───────────────────────────────────────────────

  fastify.post<{
    Body: { deviceId: string; deviceName: string; platform: 'ios' | 'android' }
  }>('/api/sync/register', async (req, reply) => {
    try {
      const { deviceId, deviceName, platform } = req.body ?? {};
      if (!deviceId || !deviceName || !platform) {
        return reply.status(400).send({ error: 'deviceId, deviceName, and platform are required' });
      }
      if (platform !== 'ios' && platform !== 'android') {
        return reply.status(400).send({ error: 'platform must be ios or android' });
      }

      const userId = (req.headers['x-webrtc-user'] as string | undefined)?.trim() || 'owner';
      const rdb    = syncDbFor(userId);

      const existing = await rdb.rawQuery(
        'SELECT sync_token FROM phobos_sync_devices WHERE device_id = ?',
        [deviceId],
      );

      let syncToken: string;
      if (existing.length > 0) {
        syncToken = existing[0].sync_token as string;
        await rdb.rawQuery(
          'UPDATE phobos_sync_devices SET device_name = ?, platform = ?, last_seen_at = now() WHERE device_id = ?',
          [deviceName, platform, deviceId],
        );
      } else {
        syncToken = crypto.randomUUID();
        await rdb.rawQuery(
          'INSERT INTO phobos_sync_devices (device_id, device_name, platform, sync_token, user_id) VALUES (?, ?, ?, ?, ?)',
          [deviceId, deviceName, platform, syncToken, userId],
        );
        for (const def of DEFAULT_POLICIES) {
          const id = policyId(deviceId, def.library);
          await rdb.execQuery(
            `INSERT INTO phobos_sync_policies (id, device_id, library, enabled, retain_days, upload_mode)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO NOTHING`,
            [id, deviceId, def.library, def.enabled ? 1 : 0, def.retain_days ?? 0, def.upload_mode],
          );
        }

        // Bootstrap per-user Meridian library on first device registration.
        await ensureUserMeridianLibrary(userId);
      }

      const policyRows = await rdb.rawQuery(
        'SELECT * FROM phobos_sync_policies WHERE device_id = ? ORDER BY library',
        [deviceId],
      );

      return reply.send({ syncToken, policies: policyRows.map(mapPolicy) });
    } catch (err: unknown) {
      console.error('[SyncRoutes] /register error:', err);
      return reply.status(500).send({ error: String(err) });
    }
  });

  // ── POST /api/sync/check ─────────────────────────────────────────────────

  fastify.post<{
    Body: {
      library: SyncLibrary;
      files: Array<{ path: string; contentHash: string; sizeBytes: number; takenAt: string | null }>;
    }
  }>('/api/sync/check', async (req, reply) => {
    const resolved = await requireSyncToken(req, reply);
    if (!resolved) return;
    const { deviceId, userId } = resolved;
    const rdb = syncDbFor(userId);

    const { library, files } = req.body ?? {};
    if (!library || !Array.isArray(files)) {
      return reply.status(400).send({ error: 'library and files are required' });
    }
    if (files.length === 0) return reply.send({ upload: [], skip: [] });

    const hashes       = files.map(f => f.contentHash);
    const placeholders = hashes.map(() => '?').join(',');
    const manifestRows = await rdb.rawQuery(
      `SELECT content_hash FROM phobos_sync_manifest WHERE content_hash IN (${placeholders})`,
      hashes,
    );
    const alreadyHave = new Set(manifestRows.map(r => r.content_hash as string));

    const polId        = policyId(deviceId, library);
    const exclusionRows = await rdb.rawQuery(
      'SELECT path FROM phobos_sync_exclusions WHERE policy_id = ?',
      [polId],
    );
    const excludedPaths = new Set(exclusionRows.map(r => r.path as string));

    const upload: string[] = [];
    const skip:   string[] = [];
    for (const f of files) {
      if (alreadyHave.has(f.contentHash) || excludedPaths.has(f.path)) {
        skip.push(f.path);
      } else {
        upload.push(f.path);
      }
    }

    return reply.send({ upload, skip });
  });

  // ── POST /api/sync/upload ────────────────────────────────────────────────
  //
  // Chunked upload protocol. Mobile always sends files in 192 KB chunks
  // (LARGE_FILE_THRESHOLD = 0) identified by X-Phobos-Upload-Id.
  //
  // Headers present on every chunk:
  //   X-Phobos-Library, X-Phobos-Filename, X-Phobos-Album,
  //   X-Phobos-Taken-At, X-Phobos-Size,
  //   X-Phobos-Upload-Id, X-Phobos-Chunk-Index, X-Phobos-Chunk-Total
  //
  // Headers present on the LAST chunk only:
  //   X-Phobos-Hash   (SHA-256 of the complete assembled file)
  //
  // Non-last chunk response:  200 { ok: true }
  // Last chunk response:      200 { ok: true, destPath }
  // Already-exists response:  409 { error: 'already_exists', destPath }
  //
  // Chunks are buffered in _chunkSessions (module-level Map). The session is
  // deleted after the last chunk is committed or after CHUNK_SESSION_TTL_MS.

  fastify.post('/api/sync/upload', {
    bodyLimit: 512 * 1024,   // 512 KB — each chunk is at most 192 KB raw
  }, async (req, reply) => {
    const resolved = await requireSyncToken(req, reply);
    if (!resolved) return;
    const { deviceId, userId } = resolved;
    const rdb = syncDbFor(userId);

    // ── Read chunk-protocol headers ─────────────────────────────────────────
    const library      = req.headers['x-phobos-library']      as SyncLibrary | undefined;
    const filename     = req.headers['x-phobos-filename']     as string | undefined;
    const albumName    = (req.headers['x-phobos-album']       as string | undefined) ?? '';
    const takenAt      = (req.headers['x-phobos-taken-at']    as string | undefined) || null;
    const sizeStr      = req.headers['x-phobos-size']         as string | undefined;
    const uploadId     = req.headers['x-phobos-upload-id']    as string | undefined;
    const chunkIdxStr  = req.headers['x-phobos-chunk-index']  as string | undefined;
    const chunkTotStr  = req.headers['x-phobos-chunk-total']  as string | undefined;
    // X-Phobos-Hash is only present on the last chunk.
    const hashHdr      = req.headers['x-phobos-hash']         as string | undefined;

    if (!library || !filename || !sizeStr || !uploadId || chunkIdxStr === undefined || !chunkTotStr) {
      return reply.status(400).send({ error: 'missing_headers' });
    }
    if (!(['photos','music','documents','movies'] as string[]).includes(library)) {
      return reply.status(400).send({ error: 'invalid_library' });
    }

    const chunkIndex  = Number(chunkIdxStr);
    const chunkTotal  = Number(chunkTotStr);
    const isLastChunk = chunkIndex === chunkTotal - 1;

    const chunkBuffer = req.body as Buffer;
    if (!chunkBuffer || !Buffer.isBuffer(chunkBuffer)) {
      return reply.status(400).send({ error: 'empty_body' });
    }

    // ── Acquire or create session ───────────────────────────────────────────
    let session = _chunkSessions.get(uploadId);
    if (!session) {
      if (chunkIndex !== 0) {
        // First chunk must be index 0 — session was swept or never started.
        return reply.status(400).send({ error: 'session_not_found' });
      }
      session = {
        uploadId,
        deviceId,
        userId,
        library,
        filename,
        albumName,
        takenAt:   takenAt && takenAt !== '' ? takenAt : null,
        sizeBytes: Number(sizeStr),
        total:     chunkTotal,
        received:  0,
        chunks:    new Array<Buffer>(chunkTotal),
        createdAt: Date.now(),
      };
      _chunkSessions.set(uploadId, session);
    }

    // Guard against session/device mismatch (shouldn't happen in practice).
    if (session.deviceId !== deviceId) {
      return reply.status(400).send({ error: 'session_mismatch' });
    }

    session.chunks[chunkIndex] = chunkBuffer;
    session.received++;

    // ── Non-final chunk: acknowledge and wait for more ──────────────────────
    if (!isLastChunk) {
      return reply.send({ ok: true });
    }

    // ── Final chunk: validate, commit, clean up ─────────────────────────────
    _chunkSessions.delete(uploadId);

    if (!hashHdr) {
      return reply.status(400).send({ error: 'missing_hash_on_last_chunk' });
    }

    // Verify all chunks arrived (guards against out-of-order or missing chunks).
    for (let i = 0; i < chunkTotal; i++) {
      if (!session.chunks[i]) {
        return reply.status(400).send({ error: `missing_chunk_${i}` });
      }
    }

    // Assemble and hash.
    const assembled  = Buffer.concat(session.chunks);
    const actualHash = crypto.createHash('sha256').update(assembled).digest('hex');
    if (actualHash !== hashHdr) {
      return reply.status(400).send({ error: 'hash_mismatch' });
    }

    // Dedup: already uploaded by this device?
    const dup = await rdb.rawQuery(
      'SELECT dest_path FROM phobos_sync_manifest WHERE content_hash = ? AND device_id = ?',
      [hashHdr, deviceId],
    );
    if (dup.length > 0) {
      return reply.status(409).send({ error: 'already_exists', destPath: dup[0].dest_path });
    }

    // Resolve device name for folder path.
    const deviceRow  = await rdb.rawQuery(
      'SELECT device_name FROM phobos_sync_devices WHERE device_id = ?',
      [deviceId],
    );
    const deviceName = (deviceRow[0]?.device_name as string | undefined) ?? deviceId;

    const destPath = await opts.dispatcher.dispatch({
      library:     session.library,
      filename:    session.filename,
      albumName:   session.albumName,
      contentHash: hashHdr,
      takenAt:     session.takenAt,
      sizeBytes:   session.sizeBytes,
      deviceId,
      userId,
      deviceName,
      buffer:      assembled,
    });

    await rdb.execQuery(
      `INSERT INTO phobos_sync_manifest
         (content_hash, device_id, library, dest_path, orig_filename, file_size, taken_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (content_hash, device_id) DO NOTHING`,
      [hashHdr, deviceId, session.library, destPath, session.filename, session.sizeBytes, session.takenAt ?? null],
    );

    if (session.library === 'photos') {
      const fileId  = contentHashToFileId(hashHdr);
      setImmediate(() => {
        const thumbBase = {
          filePath:      destPath,
          fileType:      'photo' as const,
          thumbCacheDir: opts.config.thumbCacheDir,
          libraryId:     session!.library,
          fileId,
          takenAt:       session!.takenAt,
          ffmpegPath:    opts.config.ffmpegPath ?? null,
        };
        generateThumb({ ...thumbBase, size: 'xs' })
          .catch((e: unknown) => console.warn('[SyncRoutes] thumb xs failed:', e));
        generateThumb({ ...thumbBase, size: 'sm' })
          .catch((e: unknown) => console.warn('[SyncRoutes] thumb sm failed:', e));
      });
    }

    console.log(`[SyncRoutes] Upload committed: ${session.filename} → ${destPath}`);

    // Notify the mobile background service that new content is available.
    // No-op when signalingClient is absent or relay is not connected.
    opts.signalingClient?.notifySync();

    return reply.send({ ok: true, destPath });
  });

  // ── GET /api/sync/policies ───────────────────────────────────────────────

  fastify.get('/api/sync/policies', async (req, reply) => {
    const resolved = await requireSyncToken(req, reply);
    if (!resolved) return;
    const { deviceId, userId } = resolved;
    const rdb = syncDbFor(userId);

    const policyRows = await rdb.rawQuery(
      'SELECT * FROM phobos_sync_policies WHERE device_id = ? ORDER BY library',
      [deviceId],
    );
    const policies  = policyRows.map(mapPolicy);
    const policyIds = policies.map(p => p.id);

    let exclusions: SyncExclusion[] = [];
    if (policyIds.length > 0) {
      const ph     = policyIds.map(() => '?').join(',');
      const exRows = await rdb.rawQuery(
        `SELECT * FROM phobos_sync_exclusions WHERE policy_id IN (${ph})`,
        policyIds,
      );
      exclusions = exRows.map(mapExclusion);
    }

    return reply.send({ policies, exclusions });
  });

  // ── POST /api/sync/policies ──────────────────────────────────────────────

  fastify.post<{
    Body: {
      policies:   Array<{ library: SyncLibrary; enabled: boolean; retain_days: number | null; upload_mode: 'wifi_only' | 'always' | 'manual' }>;
      exclusions: Array<{ policy_id: string; path: string; scope: 'folder' | 'file' }>;
    }
  }>('/api/sync/policies', async (req, reply) => {
    try {
      const resolved = await requireSyncToken(req, reply);
      if (!resolved) return;
      const { deviceId, userId } = resolved;
      const rdb = syncDbFor(userId);

      const { policies = [], exclusions = [] } = req.body ?? {};

      for (const p of policies) {
        const id = policyId(deviceId, p.library);
        await rdb.execQuery(
          `INSERT INTO phobos_sync_policies (id, device_id, library, enabled, retain_days, upload_mode, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, now())
           ON CONFLICT (id) DO UPDATE SET
             enabled     = excluded.enabled,
             retain_days = excluded.retain_days,
             upload_mode = excluded.upload_mode,
             updated_at  = now()`,
          [id, deviceId, p.library, p.enabled ? 1 : 0, p.retain_days ?? 0, p.upload_mode],
        );
      }

      const allPolicyIds = DEFAULT_POLICIES.map(d => policyId(deviceId, d.library));
      if (allPolicyIds.length > 0) {
        const ph = allPolicyIds.map(() => '?').join(',');
        await rdb.rawQuery(
          `DELETE FROM phobos_sync_exclusions WHERE policy_id IN (${ph})`,
          allPolicyIds,
        );
      }
      for (const ex of exclusions) {
        const id = exclusionId(ex.policy_id, ex.path);
        await rdb.execQuery(
          `INSERT INTO phobos_sync_exclusions (id, policy_id, path, scope) VALUES (?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
          [id, ex.policy_id, ex.path, mobileScopeToDb(ex.scope)],
        );
      }

      return reply.send({ ok: true });
    } catch (err: unknown) {
      console.error('[SyncRoutes] /policies error:', err);
      return reply.status(500).send({ error: String(err) });
    }
  });

  // ── GET /api/sync/manifest ───────────────────────────────────────────────

  fastify.get<{
    Querystring: { library: SyncLibrary };
  }>('/api/sync/manifest', async (req, reply) => {
    const resolved = await requireSyncToken(req, reply);
    if (!resolved) return;
    const { deviceId, userId } = resolved;
    const rdb = syncDbFor(userId);

    const { library } = req.query;
    if (!library) return reply.status(400).send({ error: 'library required' });

    const rows = await rdb.rawQuery(
      `SELECT content_hash, orig_filename, file_size, taken_at, dest_path
       FROM phobos_sync_manifest
       WHERE device_id = ? AND library = ?
       ORDER BY taken_at DESC`,
      [deviceId, library],
    );

    const files = rows.map(r => ({
      contentHash: r.content_hash as string,
      filename:    r.orig_filename as string,
      sizeBytes:   Number(r.file_size),
      takenAt:     (r.taken_at as string | null) ?? null,
      destPath:    r.dest_path as string,
    }));

    return reply.send({ files });
  });

  // ── POST /api/sync/delete ────────────────────────────────────────────────

  fastify.post<{
    Body: { library: SyncLibrary; contentHash: string };
  }>('/api/sync/delete', async (req, reply) => {
    const resolved = await requireSyncToken(req, reply);
    if (!resolved) return;
    const { deviceId, userId } = resolved;
    const rdb = syncDbFor(userId);

    const { library, contentHash } = req.body ?? {};
    if (!library || !contentHash) {
      return reply.status(400).send({ error: 'library and contentHash required' });
    }

    const rows = await rdb.rawQuery(
      'SELECT dest_path FROM phobos_sync_manifest WHERE content_hash = ? AND device_id = ?',
      [contentHash, deviceId],
    );
    if (rows.length === 0) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const destPath = rows[0].dest_path as string;

    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(destPath);
    } catch (e: unknown) {
      console.warn('[SyncRoutes] delete: file not on disk:', destPath, e);
    }

    await rdb.execQuery(
      'DELETE FROM phobos_sync_manifest WHERE content_hash = ? AND device_id = ?',
      [contentHash, deviceId],
    );

    return reply.send({ ok: true });
  });

  // ── GET /api/sync/download/:contentHash ─────────────────────────────────

  fastify.get<{
    Params: { contentHash: string };
  }>('/api/sync/download/:contentHash', async (req, reply) => {
    const resolved = await requireSyncToken(req, reply);
    if (!resolved) return;
    const { deviceId, userId } = resolved;
    const rdb = syncDbFor(userId);

    const { contentHash } = req.params;

    const rows = await rdb.rawQuery(
      'SELECT dest_path, orig_filename FROM phobos_sync_manifest WHERE content_hash = ? AND device_id = ?',
      [contentHash, deviceId],
    );
    if (rows.length === 0) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const destPath = rows[0].dest_path as string;
    const filename = rows[0].orig_filename as string;

    const { existsSync, createReadStream } = await import('node:fs');
    if (!existsSync(destPath)) {
      return reply.status(404).send({ error: 'file_missing_on_disk' });
    }

    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header('Content-Type', 'application/octet-stream');
    return reply.send(createReadStream(destPath));
  });
}