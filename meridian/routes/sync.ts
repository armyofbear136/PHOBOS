/**
 * meridian/routes/sync.ts — PHOBOS MediaSync server-side routes.
 *
 * Mounted on the Meridian Fastify instance (port 16320).
 * All routes except /api/sync/register require Authorization: Bearer <syncToken>.
 *
 * Stage 1: register + syncToken middleware
 * Stage 2: check, upload, policies (GET + POST)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import type { MeridianDB } from '../db/db.js';
import type { MeridianConfig } from '../db/config.js';
import type { Scanner } from '../scanner.js';
import type { UploadDispatcher } from '../staging/UploadDispatcher.js';

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
  upload_mode: 'auto' | 'manual';
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
  { library: 'photos',    enabled: true, upload_mode: 'auto',   retain_days: null },
  { library: 'music',     enabled: true, upload_mode: 'manual', retain_days: null },
  { library: 'documents', enabled: true, upload_mode: 'manual', retain_days: null },
  { library: 'movies',    enabled: true, upload_mode: 'manual', retain_days: null },
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
    retain_days: r.retain_days != null ? Number(r.retain_days) : null,
    upload_mode: r.upload_mode as 'auto' | 'manual',
  };
}

function mapExclusion(r: Row): SyncExclusion {
  return {
    id:         r.id as string,
    policy_id:  r.policy_id as string,
    path:       r.path as string,
    scope:      r.scope as 'folder' | 'file',
    created_at: r.created_at as string,
  };
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function syncRoutes(
  fastify: FastifyInstance,
  opts: { db: MeridianDB; config: MeridianConfig; scanner: Scanner; dispatcher: UploadDispatcher },
): Promise<void> {
  const { db } = opts;

  // ── syncToken middleware (called explicitly by protected routes) ──────────

  async function requireSyncToken(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<string | undefined> {
    const auth  = req.headers['authorization'];
    const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
    if (!token) {
      reply.status(401).send({ error: 'missing_token' });
      return undefined;
    }
    const rows = await db.rawQuery(
      'SELECT device_id FROM phobos_sync_devices WHERE sync_token = ?',
      [token],
    );
    if (rows.length === 0) {
      reply.status(401).send({ error: 'invalid_token' });
      return undefined;
    }
    db.rawQuery(
      'UPDATE phobos_sync_devices SET last_seen_at = now() WHERE sync_token = ?',
      [token],
    ).catch(() => {});
    return rows[0].device_id as string;
  }

  // ── POST /api/sync/register ───────────────────────────────────────────────

  fastify.post<{
    Body: { deviceId: string; deviceName: string; platform: 'ios' | 'android' }
  }>('/api/sync/register', async (req, reply) => {
    const { deviceId, deviceName, platform } = req.body ?? {};
    if (!deviceId || !deviceName || !platform) {
      return reply.status(400).send({ error: 'deviceId, deviceName, and platform are required' });
    }
    if (platform !== 'ios' && platform !== 'android') {
      return reply.status(400).send({ error: 'platform must be ios or android' });
    }

    const existing = await db.rawQuery(
      'SELECT sync_token FROM phobos_sync_devices WHERE device_id = ?',
      [deviceId],
    );

    let syncToken: string;
    if (existing.length > 0) {
      syncToken = existing[0].sync_token as string;
      await db.rawQuery(
        'UPDATE phobos_sync_devices SET device_name = ?, platform = ?, last_seen_at = now() WHERE device_id = ?',
        [deviceName, platform, deviceId],
      );
    } else {
      syncToken = crypto.randomUUID();
      await db.rawQuery(
        'INSERT INTO phobos_sync_devices (device_id, device_name, platform, sync_token) VALUES (?, ?, ?, ?)',
        [deviceId, deviceName, platform, syncToken],
      );
      for (const def of DEFAULT_POLICIES) {
        const id = policyId(deviceId, def.library);
        await db.rawQuery(
          `INSERT INTO phobos_sync_policies (id, device_id, library, enabled, retain_days, upload_mode)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO NOTHING`,
          [id, deviceId, def.library, def.enabled ? 1 : 0, def.retain_days ?? null, def.upload_mode],
        );
      }
    }

    const policyRows = await db.rawQuery(
      'SELECT * FROM phobos_sync_policies WHERE device_id = ? ORDER BY library',
      [deviceId],
    );

    return reply.send({ syncToken, policies: policyRows.map(mapPolicy) });
  });

  // ── POST /api/sync/check ─────────────────────────────────────────────────

  fastify.post<{
    Body: {
      library: SyncLibrary;
      files: Array<{ path: string; contentHash: string; sizeBytes: number; takenAt: string | null }>;
    }
  }>('/api/sync/check', async (req, reply) => {
    const deviceId = await requireSyncToken(req, reply);
    if (!deviceId) return;

    const { library, files } = req.body ?? {};
    if (!library || !Array.isArray(files)) {
      return reply.status(400).send({ error: 'library and files are required' });
    }
    if (files.length === 0) return reply.send({ upload: [], skip: [] });

    const hashes       = files.map(f => f.contentHash);
    const placeholders = hashes.map(() => '?').join(',');
    const manifestRows = await db.rawQuery(
      `SELECT content_hash FROM phobos_sync_manifest WHERE content_hash IN (${placeholders})`,
      hashes,
    );
    const alreadyHave = new Set(manifestRows.map(r => r.content_hash as string));

    const polId        = policyId(deviceId, library);
    const exclusionRows = await db.rawQuery(
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

  fastify.post('/api/sync/upload', {
    bodyLimit: 2 * 1024 * 1024 * 1024,
  }, async (req, reply) => {
    const deviceId = await requireSyncToken(req, reply);
    if (!deviceId) return;

    const library  = req.headers['x-phobos-library']  as SyncLibrary | undefined;
    const filename = req.headers['x-phobos-filename'] as string | undefined;
    const hashHdr  = req.headers['x-phobos-hash']     as string | undefined;
    const takenAt  = (req.headers['x-phobos-taken-at'] as string | undefined) || null;
    const sizeStr  = req.headers['x-phobos-size']     as string | undefined;

    if (!library || !filename || !hashHdr || !sizeStr) {
      return reply.status(400).send({ error: 'missing_headers' });
    }
    if (!(['photos','music','documents','movies'] as string[]).includes(library)) {
      return reply.status(400).send({ error: 'invalid_library' });
    }

    const buffer = req.body as Buffer;
    if (!buffer || !Buffer.isBuffer(buffer)) {
      return reply.status(400).send({ error: 'empty_body' });
    }

    const actualHash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (actualHash !== hashHdr) {
      return reply.status(400).send({ error: 'hash_mismatch' });
    }

    const dup = await db.rawQuery(
      'SELECT dest_path FROM phobos_sync_manifest WHERE content_hash = ?',
      [hashHdr],
    );
    if (dup.length > 0) {
      return reply.status(409).send({ error: 'already_exists', destPath: dup[0].dest_path });
    }

    const destPath = await opts.dispatcher.dispatch({
      library,
      filename,
      contentHash: hashHdr,
      takenAt:     takenAt && takenAt !== '' ? takenAt : null,
      sizeBytes:   Number(sizeStr),
      deviceId,
      buffer,
    });

    return reply.send({ ok: true, destPath });
  });

  // ── GET /api/sync/policies ───────────────────────────────────────────────

  fastify.get('/api/sync/policies', async (req, reply) => {
    const deviceId = await requireSyncToken(req, reply);
    if (!deviceId) return;

    const policyRows = await db.rawQuery(
      'SELECT * FROM phobos_sync_policies WHERE device_id = ? ORDER BY library',
      [deviceId],
    );
    const policies   = policyRows.map(mapPolicy);
    const policyIds  = policies.map(p => p.id);

    let exclusions: SyncExclusion[] = [];
    if (policyIds.length > 0) {
      const ph      = policyIds.map(() => '?').join(',');
      const exRows  = await db.rawQuery(
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
      policies:   Array<{ library: SyncLibrary; enabled: boolean; retain_days: number | null; upload_mode: 'auto' | 'manual' }>;
      exclusions: Array<{ policy_id: string; path: string; scope: 'folder' | 'file' }>;
    }
  }>('/api/sync/policies', async (req, reply) => {
    const deviceId = await requireSyncToken(req, reply);
    if (!deviceId) return;

    const { policies = [], exclusions = [] } = req.body ?? {};

    for (const p of policies) {
      const id = policyId(deviceId, p.library);
      await db.rawQuery(
        `INSERT INTO phobos_sync_policies (id, device_id, library, enabled, retain_days, upload_mode, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, now())
         ON CONFLICT (id) DO UPDATE SET
           enabled     = excluded.enabled,
           retain_days = excluded.retain_days,
           upload_mode = excluded.upload_mode,
           updated_at  = now()`,
        [id, deviceId, p.library, p.enabled ? 1 : 0, p.retain_days ?? null, p.upload_mode],
      );
    }

    // Full replace of exclusions for this device: delete all, re-insert.
    const allPolicyIds = DEFAULT_POLICIES.map(d => policyId(deviceId, d.library));
    if (allPolicyIds.length > 0) {
      const ph = allPolicyIds.map(() => '?').join(',');
      await db.rawQuery(
        `DELETE FROM phobos_sync_exclusions WHERE policy_id IN (${ph})`,
        allPolicyIds,
      );
    }
    for (const ex of exclusions) {
      const id = exclusionId(ex.policy_id, ex.path);
      await db.rawQuery(
        `INSERT INTO phobos_sync_exclusions (id, policy_id, path, scope) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
        [id, ex.policy_id, ex.path, ex.scope],
      );
    }

    return reply.send({ ok: true });
  });
}
