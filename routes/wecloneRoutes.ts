/**
 * PHOBOS WeClone — API Routes
 *
 * Clone management (multi-clone):
 *   GET    /api/weclone/clones              — list all clones
 *   POST   /api/weclone/clones              — create new clone
 *   GET    /api/weclone/clones/:id          — get single clone + resolved detail
 *   PATCH  /api/weclone/clones/:id          — update clone fields
 *   DELETE /api/weclone/clones/:id          — delete clone
 *   PATCH  /api/weclone/clones/:id/voice    — link / unlink voice profile
 *
 * User profile (# YOU ARE TALKING TO):
 *   GET    /api/weclone/user-profile        — get owner self-description
 *   POST   /api/weclone/user-profile        — upsert owner self-description
 *
 * Legacy single-clone routes (kept for backward compat):
 *   GET    /api/weclone/status
 *   GET    /api/weclone/profile
 *   POST   /api/weclone/profile
 *   DELETE /api/weclone/profile
 *   PATCH  /api/weclone/profile/voice
 *   POST   /api/weclone/ingest/messages
 */

import type { FastifyInstance } from 'fastify';
import { WecloneStore }         from '../db/WecloneStore.js';
import { UserProfileStore }     from '../db/UserProfileStore.js';
import { CartridgeStore }       from '../db/CartridgeStore.js';
import { WecloneExporter }      from '../db/WecloneExporter.js';
import { WecloneImporter }      from '../db/WecloneImporter.js';
import { DatabaseManager, getActiveUser } from '../db/DatabaseManager.js';
import { listVoiceProfiles }    from '../phobos/AudioServerManager.js';
import { activateClone, deactivateClone, getActive } from '../phobos/WecloneSlotManager.js';
import { WecloneActivationStore } from '../db/WecloneActivationStore.js';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';

function wecloneStore(username: string): WecloneStore {
  const db = DatabaseManager.getUserDb(username);
  return new WecloneStore(db);
}

function userProfileStore(): UserProfileStore {
  return new UserProfileStore(DatabaseManager.getInstance());
}

function cartridgeStore(): CartridgeStore {
  return new CartridgeStore(DatabaseManager.getInstance());
}

// Resolve cartridge + voice metadata onto a raw clone row.
async function resolveCloneDetail(
  username: string,
  clone: Awaited<ReturnType<WecloneStore['getProfile']>>,
) {
  if (!clone) return null;
  let cartridgeName:    string | null = null;
  let trainedAt:        string | null = null;
  let turnCount                       = 0;
  let cartridgeActive                 = false;
  let hasVoiceProfile                 = false;
  let voiceProfileName: string | null = null;

  if (clone.cartridge_id) {
    const cs     = cartridgeStore();
    const record = await cs.get(clone.cartridge_id);
    if (record) {
      cartridgeName   = record.name;
      trainedAt       = record.installed_at;
      turnCount       = record.training_turns;
      const slot      = await cs.getActiveSlot(clone.slot as 'sayon' | 'seren');
      cartridgeActive = slot.cartridgeId === clone.cartridge_id;
    }
  }

  if (clone.voice_profile_id) {
    const vp = listVoiceProfiles(username).find(p => p.id === clone.voice_profile_id);
    if (vp) { hasVoiceProfile = true; voiceProfileName = vp.name; }
  }

  return { ...clone, cartridgeName, trainedAt, turnCount, cartridgeActive, hasVoiceProfile, voiceProfileName };
}

export async function registerWecloneRoutes(fastify: FastifyInstance): Promise<void> {

  // ── Clone list ─────────────────────────────────────────────────────────────

  fastify.get('/api/weclone/clones', async (req, reply) => {
    const ws = wecloneStore(req.phobosUser);
    await ws.ensureTable();
    const clones = await ws.listProfiles();
    return reply.send({ clones });
  });

  // ── Clone create ───────────────────────────────────────────────────────────

  fastify.post('/api/weclone/clones', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body) return reply.status(400).send({ error: 'Body required' });
    try {
      const ws    = wecloneStore(req.phobosUser);
      await ws.ensureTable();
      const clone = await ws.createProfile(body as any);
      return reply.status(201).send(clone);
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Clone get ──────────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>('/api/weclone/clones/:id', async (req, reply) => {
    const ws    = wecloneStore(req.phobosUser);
    await ws.ensureTable();
    const clone = await ws.getProfile(req.params.id);
    if (!clone) return reply.status(404).send({ error: 'Clone not found' });
    return reply.send(await resolveCloneDetail(req.phobosUser, clone));
  });

  // ── Clone update ───────────────────────────────────────────────────────────

  fastify.patch<{ Params: { id: string } }>('/api/weclone/clones/:id', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body) return reply.status(400).send({ error: 'Body required' });
    try {
      const ws    = wecloneStore(req.phobosUser);
      await ws.ensureTable();
      const clone = await ws.getProfile(req.params.id);
      if (!clone) return reply.status(404).send({ error: 'Clone not found' });
      const updated = await ws.updateProfile(req.params.id, body as any);
      return reply.send(updated);
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Clone delete ───────────────────────────────────────────────────────────

  fastify.delete<{ Params: { id: string } }>('/api/weclone/clones/:id', async (req, reply) => {
    try {
      const ws = wecloneStore(req.phobosUser);
      await ws.ensureTable();
      await ws.deleteProfile(req.params.id);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Clone voice link / unlink ─────────────────────────────────────────────

  fastify.patch<{ Params: { id: string } }>('/api/weclone/clones/:id/voice', async (req, reply) => {
    const body = req.body as { voiceProfileId?: string | null } | undefined;
    if (!body || !('voiceProfileId' in body)) {
      return reply.status(400).send({ error: 'voiceProfileId required (string or null)' });
    }
    try {
      const ws    = wecloneStore(req.phobosUser);
      await ws.ensureTable();
      const clone = await ws.getProfile(req.params.id);
      if (!clone) return reply.status(404).send({ error: 'Clone not found' });
      await ws.setVoiceProfile(req.params.id, body.voiceProfileId ?? null);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── User profile — get ────────────────────────────────────────────────────

  fastify.get('/api/weclone/user-profile', async (_req, reply) => {
    const ups = userProfileStore();
    await ups.ensureTable();
    const profile = await ups.getProfile();
    return reply.send({ profile: profile ?? null });
  });

  // ── User profile — upsert ─────────────────────────────────────────────────

  fastify.post('/api/weclone/user-profile', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body) return reply.status(400).send({ error: 'Body required' });
    try {
      const ups     = userProfileStore();
      await ups.ensureTable();
      const profile = await ups.upsertProfile(body as any);
      return reply.send(profile);
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Legacy: status ────────────────────────────────────────────────────────

  fastify.get('/api/weclone/status', async (req, reply) => {
    const ws     = wecloneStore(req.phobosUser);
    await ws.ensureTable();
    const clones = await ws.listProfiles();
    const clone  = clones[0] ?? null;

    if (!clone) {
      return reply.send({
        hasProfile: false, hasCartridge: false, cartridgeActive: false,
        hasVoiceProfile: false, voiceProfileName: null,
        slot: null, profile: null, cartridgeName: null, trainedAt: null, turnCount: 0,
      });
    }

    const detail = await resolveCloneDetail(req.phobosUser, clone);
    return reply.send({
      hasProfile:       true,
      hasCartridge:     !!clone.cartridge_id,
      cartridgeActive:  detail!.cartridgeActive,
      hasVoiceProfile:  detail!.hasVoiceProfile,
      voiceProfileName: detail!.voiceProfileName,
      slot:             clone.slot,
      profile:          clone,
      cartridgeName:    detail!.cartridgeName,
      trainedAt:        detail!.trainedAt,
      turnCount:        detail!.turnCount,
    });
  });

  // ── Legacy: profile raw read ───────────────────────────────────────────────

  fastify.get('/api/weclone/profile', async (req, reply) => {
    const ws     = wecloneStore(req.phobosUser);
    await ws.ensureTable();
    const clones = await ws.listProfiles();
    if (!clones[0]) return reply.status(404).send({ error: 'No clone profile found' });
    return reply.send(clones[0]);
  });

  // ── Legacy: profile upsert ────────────────────────────────────────────────

  fastify.post('/api/weclone/profile', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body) return reply.status(400).send({ error: 'Body required' });
    try {
      const ws     = wecloneStore(req.phobosUser);
      await ws.ensureTable();
      const clones = await ws.listProfiles();
      const result = clones[0]
        ? await ws.updateProfile(clones[0].id, body as any)
        : await ws.createProfile(body as any);
      return reply.send(result);
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Legacy: profile delete ────────────────────────────────────────────────

  fastify.delete('/api/weclone/profile', async (req, reply) => {
    try {
      const ws     = wecloneStore(req.phobosUser);
      await ws.ensureTable();
      const clones = await ws.listProfiles();
      if (clones[0]) await ws.deleteProfile(clones[0].id);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Legacy: voice link / unlink ───────────────────────────────────────────

  fastify.patch('/api/weclone/profile/voice', async (req, reply) => {
    const body = req.body as { voiceProfileId?: string | null } | undefined;
    if (!body || !('voiceProfileId' in body)) {
      return reply.status(400).send({ error: 'voiceProfileId required (string or null)' });
    }
    try {
      const ws     = wecloneStore(req.phobosUser);
      await ws.ensureTable();
      const clones = await ws.listProfiles();
      if (!clones[0]) return reply.status(404).send({ error: 'No clone profile found' });
      await ws.setVoiceProfile(clones[0].id, body.voiceProfileId ?? null);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Ingest — mobile message batch (stub) ──────────────────────────────────

  fastify.post('/api/weclone/ingest/messages', async (_req, reply) => {
    return reply.send({ ok: true, turns: 0, queued: 0 });
  });

  // ── WeClone slot activation ────────────────────────────────────────────────

  /**
   * POST /api/weclone/activate
   * Body: { cloneId: string }
   *
   * Activates a clone on its designated hardware slot.  Snapshots the current
   * model, stops the server, starts the clone's base_model + LoRA, persists
   * the holding snapshot.  The slot is determined by the clone's own `slot`
   * field — callers don't specify it.
   */
  fastify.post('/api/weclone/activate', async (req, reply) => {
    const { cloneId } = (req.body ?? {}) as { cloneId?: string };
    if (!cloneId) return reply.status(400).send({ error: 'cloneId required' });
    try {
      const username = req.phobosUser ?? getActiveUser();
      await activateClone(cloneId, username);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  /**
   * DELETE /api/weclone/activate/:slot
   *
   * Deactivates the active clone on the given slot and restores the previous
   * model.  No-op if no clone is active on that slot.
   */
  fastify.delete('/api/weclone/activate/:slot', async (req, reply) => {
    const { slot } = req.params as { slot: string };
    if (slot !== 'sayon' && slot !== 'seren') {
      return reply.status(400).send({ error: 'slot must be sayon or seren' });
    }
    try {
      await deactivateClone(slot);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  /**
   * GET /api/weclone/active
   *
   * Returns the current activation state for both slots.  Resolves display
   * names and voice profile IDs from the user DB so the frontend needs only
   * one call to render the clone tab state.
   *
   * Response shape:
   * {
   *   sayon: { cloneId, displayName, voiceProfileId } | null,
   *   seren: { cloneId, displayName, voiceProfileId } | null,
   * }
   */
  fastify.get('/api/weclone/active', async (req, reply) => {
    try {
      const resolve = async (slot: 'sayon' | 'seren') => {
        const info = getActive(slot);
        if (!info) return null;
        const ws    = wecloneStore(info.username);
        await ws.ensureTable();
        const clone = await ws.getProfile(info.cloneId);
        if (!clone) return null;
        return {
          cloneId:        info.cloneId,
          displayName:    clone.display_name,
          voiceProfileId: clone.voice_profile_id ?? null,
          slot,
        };
      };
      const [sayon, seren] = await Promise.all([resolve('sayon'), resolve('seren')]);
      return reply.send({ sayon, seren });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Export ─────────────────────────────────────────────────────────────────

  /**
   * POST /api/weclone/export
   *
   * Packages the requesting user's weclone data into a .weclone archive and
   * returns it as a binary download. The archive is written to a temp file
   * and streamed to the client, then deleted.
   */
  fastify.post('/api/weclone/export', async (req, reply) => {
    const username  = req.phobosUser ?? getActiveUser();
    const tmpDir    = path.join(os.tmpdir(), 'phobos-weclone-export');
    const outputPath = path.join(tmpDir, `${username}.weclone`);

    try {
      const exporter = new WecloneExporter(DatabaseManager.getInstance());
      const result   = await exporter.export(username, outputPath);

      if (!result.success || !result.outputPath) {
        return reply.status(400).send({ error: result.reason ?? 'No weclone data to export' });
      }

      const fileBuffer = fs.readFileSync(result.outputPath);
      try { fs.unlinkSync(result.outputPath); } catch { /* non-fatal */ }

      return reply
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${username}.weclone"`)
        .send(fileBuffer);

    } catch (err) {
      try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch { /* non-fatal */ }
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Import ─────────────────────────────────────────────────────────────────

  /**
   * POST /api/weclone/import
   *
   * Accepts a raw binary .weclone archive body and installs it for the
   * requesting user. Returns a summary of what was restored.
   *
   * Query param: ?filename=<name>.weclone (optional, for content-type hint)
   */
  fastify.post('/api/weclone/import', async (req, reply) => {
    const username = req.phobosUser ?? getActiveUser();
    const data     = req.body as Buffer | undefined;

    if (!data || !Buffer.isBuffer(data) || data.length === 0) {
      return reply.status(400).send({ error: 'Body must be raw binary (.weclone archive)' });
    }

    // Write to a temp file so WecloneImporter can use AdmZip with a path.
    const tmpDir  = path.join(os.tmpdir(), 'phobos-weclone-import');
    const tmpPath = path.join(tmpDir, `${username}-import-${Date.now()}.weclone`);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(tmpPath, data);

    try {
      const importer = new WecloneImporter(DatabaseManager.getInstance());
      const result   = await importer.import(tmpPath, username);
      return reply.send(result);
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* non-fatal */ }
    }
  });
}