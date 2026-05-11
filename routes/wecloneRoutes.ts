/**
 * PHOBOS WeClone — API Routes
 *
 * GET    /api/weclone/status           — profile + cartridge state summary
 * GET    /api/weclone/profile          — raw profile row
 * POST   /api/weclone/profile          — upsert profile
 * DELETE /api/weclone/profile          — delete profile
 * POST   /api/weclone/ingest/messages  — accept message batch from mobile (stub)
 *
 * All profile routes use the user DB (getUserDb()) — per-user data.
 * Cartridge state is read from the system DB via CartridgeStore.
 */

import type { FastifyInstance } from 'fastify';
import { WecloneStore }         from '../db/WecloneStore.js';
import { CartridgeStore }       from '../db/CartridgeStore.js';
import { DatabaseManager, getActiveUser } from '../db/DatabaseManager.js';

function wecloneStore(): WecloneStore {
  const db = DatabaseManager.getUserDb(getActiveUser());
  return new WecloneStore(db);
}

function cartridgeStore(): CartridgeStore {
  return new CartridgeStore(DatabaseManager.getInstance());
}

export async function registerWecloneRoutes(fastify: FastifyInstance): Promise<void> {

  // ── Status — composite view used by WeclonePanel on mount ─────────────────

  fastify.get('/api/weclone/status', async (_req, reply) => {
    const ws      = wecloneStore();
    await ws.ensureTable();
    const profile = await ws.getProfile();

    if (!profile) {
      return reply.send({
        hasProfile:      false,
        hasCartridge:    false,
        cartridgeActive: false,
        slot:            null,
        profile:         null,
        cartridgeName:   null,
        trainedAt:       null,
        turnCount:       0,
      });
    }

    let cartridgeName: string | null = null;
    let trainedAt:     string | null = null;
    let turnCount                    = 0;
    let cartridgeActive              = false;

    if (profile.cartridge_id) {
      const cs     = cartridgeStore();
      const record = await cs.get(profile.cartridge_id);
      if (record) {
        cartridgeName   = record.name;
        trainedAt       = record.installed_at;
        turnCount       = record.training_turns;
        const slot      = await cs.getActiveSlot(profile.slot as 'sayon' | 'seren');
        cartridgeActive = slot.cartridgeId === profile.cartridge_id;
      }
    }

    return reply.send({
      hasProfile:      true,
      hasCartridge:    !!profile.cartridge_id,
      cartridgeActive,
      slot:            profile.slot,
      profile,
      cartridgeName,
      trainedAt,
      turnCount,
    });
  });

  // ── Profile — raw read ─────────────────────────────────────────────────────

  fastify.get('/api/weclone/profile', async (_req, reply) => {
    const ws      = wecloneStore();
    await ws.ensureTable();
    const profile = await ws.getProfile();
    if (!profile) return reply.status(404).send({ error: 'No clone profile found' });
    return reply.send(profile);
  });

  // ── Profile — upsert ──────────────────────────────────────────────────────

  fastify.post('/api/weclone/profile', async (req, reply) => {
    const body = req.body as {
      cartridgeId?:        string;
      slot?:               'sayon' | 'seren';
      displayName?:        string;
      pronouns?:           string;
      communicationStyle?: string;
      loveTopics?:         string;
      avoidTopics?:        string;
      humorStyle?:         string;
      responseLength?:     number;
      formality?:          number;
      firstPerson?:        boolean;
      contextSummary?:     string;
      limitsSummary?:      string;
      temperature?:        number;
      topP?:               number;
      contextWindow?:      number;
      systemPrompt?:       string;
      published?:          boolean;
    } | undefined;

    if (!body) return reply.status(400).send({ error: 'Body required' });

    if (body.slot && body.slot !== 'sayon' && body.slot !== 'seren') {
      return reply.status(400).send({ error: 'slot must be "sayon" or "seren"' });
    }

    try {
      const ws      = wecloneStore();
      await ws.ensureTable();
      const profile = await ws.upsertProfile(body);
      return reply.send(profile);
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Profile — delete ──────────────────────────────────────────────────────

  fastify.delete('/api/weclone/profile', async (_req, reply) => {
    try {
      const ws = wecloneStore();
      await ws.ensureTable();
      await ws.deleteProfile();
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Ingest — mobile message batch (stub until mobile sync is ready) ────────

  fastify.post('/api/weclone/ingest/messages', async (_req, reply) => {
    // Stub: accepts the request, returns ok with zero turns processed.
    // Full implementation lands when the mobile message sync payload is defined.
    return reply.send({ ok: true, turns: 0, queued: 0 });
  });
}
