/**
 * PHOBOS LLM Cartridge System — API Routes
 *
 * GET    /api/cartridges                            — list all installed
 * POST   /api/cartridges/install                    — install .cartridge or raw .gguf
 * DELETE /api/cartridges/:id                        — remove + delete files
 * GET    /api/cartridges/:persona/active             — get active slot
 * POST   /api/cartridges/:persona/activate           — activate + trigger server restart
 * POST   /api/cartridges/:persona/deactivate         — clear slot + trigger restart
 * GET    /api/cartridges/:id/compatibility/:persona  — check compat without activating
 * POST   /api/cartridges/:id/check-auth              — verify credential (for protected carts)
 * GET    /api/cartridges/:id/license-unlocked        — silent local license check
 *
 * Upload pattern: raw application/octet-stream body, filename in ?filename= query param.
 * Mirrors pluginRoutes.ts exactly — no @fastify/multipart dependency.
 */

import type { FastifyInstance } from 'fastify';
import {
  activateCartridge,
  deactivateCartridge,
  getActiveBinding,
  checkCompatibility,
} from '../phobos/CartridgeManager.js';
import { CartridgeStore } from '../db/CartridgeStore.js';
import { DatabaseManager } from '../db/DatabaseManager.js';
import type { CartridgeRecord } from '../phobos/CartridgeTypes.js';

type Persona = 'sayon' | 'seren';
const VALID_PERSONAS = new Set<Persona>(['sayon', 'seren']);

function store(): CartridgeStore {
  return new CartridgeStore(DatabaseManager.getInstance());
}

function deser(r: CartridgeRecord): Omit<CartridgeRecord, 'compatible_models' | 'tags'> & { compatible_models: string[]; tags: string[] } {
  return {
    ...r,
    compatible_models: tryJson(r.compatible_models, [] as string[]),
    tags:              tryJson(r.tags, [] as string[]),
  };
}

function tryJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export async function registerCartridgeRoutes(fastify: FastifyInstance): Promise<void> {

  // ── List all ──────────────────────────────────────────────────────────────

  fastify.get('/api/cartridges', async (_req, reply) => {
    const s       = store();
    const records = await s.list();
    const [sayonSlot, serenSlot] = await Promise.all([
      s.getActiveSlot('sayon'),
      s.getActiveSlot('seren'),
    ]);

    const result = records.map(r => ({
      ...deser(r),
      isActiveSayon: sayonSlot.cartridgeId === r.id,
      isActiveSeren: serenSlot.cartridgeId === r.id,
      isActive:      sayonSlot.cartridgeId === r.id || serenSlot.cartridgeId === r.id,
    }));

    return reply.send(result);
  });

  // ── Install ───────────────────────────────────────────────────────────────

  fastify.post('/api/cartridges/install', async (req, reply) => {
    const body = req.body as Buffer | undefined;
    if (!body || !Buffer.isBuffer(body)) {
      return reply.status(400).send({ error: 'Body must be raw binary (application/octet-stream)' });
    }

    const filename = ((req.query as Record<string, string>).filename ?? '').toLowerCase();

    try {
      const s = store();
      if (filename.endsWith('.cartridge')) {
        const record = await s.installCartridgeArchive(body);
        return reply.status(201).send(deser(record));
      } else if (filename.endsWith('.gguf')) {
        const record = await s.installRawLora(body, (req.query as Record<string, string>).filename ?? 'lora.gguf');
        return reply.status(201).send(deser(record));
      } else {
        return reply.status(400).send({
          error: 'Only .cartridge archives and raw .gguf files are accepted',
        });
      }
    } catch (err) {
      const msg = (err as Error).message;
      const isUserError = /missing|invalid|signature|GGUF|schema|manifest|hmac/i.test(msg);
      return reply.status(isUserError ? 400 : 500).send({ error: msg });
    }
  });

  // ── Remove ────────────────────────────────────────────────────────────────

  fastify.delete('/api/cartridges/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s      = store();
    const record = await s.get(id);
    if (!record) return reply.status(404).send({ error: `Cartridge not found: ${id}` });

    // Deactivate from any live slot before deleting.
    for (const persona of ['sayon', 'seren'] as const) {
      if (getActiveBinding(persona)?.cartridgeId === id) {
        await deactivateCartridge(persona);
      }
    }

    await s.remove(id);
    return reply.send({ ok: true, id });
  });

  // ── Active slot — read ────────────────────────────────────────────────────

  fastify.get('/api/cartridges/:persona/active', async (req, reply) => {
    const { persona } = req.params as { persona: string };
    if (!VALID_PERSONAS.has(persona as Persona)) {
      return reply.status(400).send({ error: `Invalid persona "${persona}"` });
    }

    const s       = store();
    const slot    = await s.getActiveSlot(persona as Persona);
    const binding = getActiveBinding(persona as Persona);

    if (!slot.cartridgeId) {
      return reply.send({ active: false, cartridge: null, weight: null, loaded: false });
    }

    const record = await s.get(slot.cartridgeId);
    return reply.send({
      active:    true,
      cartridge: record ? deser(record) : null,
      weight:    slot.weight,
      // loaded = in-memory binding matches DB — server has actually restarted with this cartridge.
      loaded:    binding?.cartridgeId === slot.cartridgeId,
    });
  });

  // ── Activate ──────────────────────────────────────────────────────────────

  fastify.post('/api/cartridges/:persona/activate', async (req, reply) => {
    const { persona } = req.params as { persona: string };
    if (!VALID_PERSONAS.has(persona as Persona)) {
      return reply.status(400).send({ error: `Invalid persona "${persona}"` });
    }

    const body        = req.body as { cartridgeId?: string; weight?: number } | undefined;
    const cartridgeId = body?.cartridgeId;
    if (!cartridgeId) {
      return reply.status(400).send({ error: 'Body must include cartridgeId' });
    }

    const s      = store();
    const record = await s.get(cartridgeId);
    if (!record) return reply.status(404).send({ error: `Cartridge not found: ${cartridgeId}` });

    try {
      await activateCartridge(persona as Persona, cartridgeId, body?.weight);
      const slot = await s.getActiveSlot(persona as Persona);
      return reply.send({
        ok:      true,
        persona,
        cartridgeId,
        weight:  slot.weight,
        message: `"${record.name}" activated for ${persona}. Server restarting with --lora.`,
      });
    } catch (err) {
      const msg = (err as Error).message;
      return reply.status(msg.includes('compatibility') ? 409 : 500).send({ error: msg });
    }
  });

  // ── Deactivate ────────────────────────────────────────────────────────────

  fastify.post('/api/cartridges/:persona/deactivate', async (req, reply) => {
    const { persona } = req.params as { persona: string };
    if (!VALID_PERSONAS.has(persona as Persona)) {
      return reply.status(400).send({ error: `Invalid persona "${persona}"` });
    }

    try {
      await deactivateCartridge(persona as Persona);
      return reply.send({
        ok:      true,
        persona,
        message: `${persona} cartridge slot cleared. Server restarting with base model only.`,
      });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Compatibility check ───────────────────────────────────────────────────

  fastify.get('/api/cartridges/:id/compatibility/:persona', async (req, reply) => {
    const { id, persona } = req.params as { id: string; persona: string };
    if (!VALID_PERSONAS.has(persona as Persona)) {
      return reply.status(400).send({ error: `Invalid persona "${persona}"` });
    }

    const record = await store().get(id);
    if (!record) return reply.status(404).send({ error: `Cartridge not found: ${id}` });

    const result = await checkCompatibility(id, persona as Persona);
    return reply.send(result);
  });

  // ── Auth check (for protected cartridges) ─────────────────────────────────

  fastify.post('/api/cartridges/:id/check-auth', async (req, reply) => {
    const { id }  = req.params as { id: string };
    const s       = store();
    const record  = await s.get(id);
    if (!record) return reply.status(404).send({ error: `Cartridge not found: ${id}` });
    if (record.kind !== 'cartridge') {
      return reply.send({ ok: true, via: 'raw_lora' });
    }

    const body       = req.body as { password?: string; useLicense?: boolean } | undefined;
    const credential = body?.useLicense
      ? ({ useLicense: true } as const)
      : ({ password: body?.password ?? '' });

    const archivePath = record.install_path + '/cartridge-archive.cartridge';
    const result      = s.checkAuth(archivePath, credential);
    return reply.send(result);
  });

  // ── Silent license unlock check ───────────────────────────────────────────

  fastify.get('/api/cartridges/:id/license-unlocked', async (req, reply) => {
    const { id }  = req.params as { id: string };
    const s       = store();
    const record  = await s.get(id);
    if (!record) return reply.status(404).send({ error: `Cartridge not found: ${id}` });

    if (record.kind !== 'cartridge' || !record.is_protected) {
      return reply.send({ unlocked: true, via: 'unprotected' });
    }

    const archivePath = record.install_path + '/cartridge-archive.cartridge';
    const unlocked    = s.checkLicenseUnlock(archivePath);
    return reply.send({ unlocked, via: unlocked ? 'license' : null });
  });
}
