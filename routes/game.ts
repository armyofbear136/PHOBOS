/**
 * routes/game.ts — PHOBOS World game API routes.
 *
 * GET  /api/game/stream       — SSE stream (persona states, coins, world state)
 * GET  /api/game/player       — Read player record
 * POST /api/game/player       — Create / update player
 * POST /api/game/collect      — Coin collection
 * GET  /api/game/inventory    — Player inventory
 * POST /api/game/decorations  — Place decoration
 * GET  /api/game/decorations  — List decorations
 * DELETE /api/game/decorations/:id — Remove decoration
 */

import type { FastifyInstance } from 'fastify';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { GameStore } from '../db/GameStore.js';
import { gsm } from '../game/GameStateManager.js';

export async function registerGameRoutes(fastify: FastifyInstance): Promise<void> {
  const db = DatabaseManager.getInstance();
  const store = new GameStore(db);

  // ── SSE Stream ─────────────────────────────────────────────────────────
  fastify.get('/api/game/stream', async (req, reply) => {
    const origin = req.headers.origin ?? '*';
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
    });

    const write = (data: string): boolean => {
      try {
        return reply.raw.write(data);
      } catch {
        return false;
      }
    };

    const clientId = gsm.addClient(write, () => {
      gsm.removeClient(clientId);
    });

    // Client disconnect cleanup
    req.raw.on('close', () => {
      gsm.removeClient(clientId);
    });

    // Keep the connection open — Fastify will close it when the client disconnects
  });

  // ── Player ─────────────────────────────────────────────────────────────
  fastify.get('/api/game/player', async (_req, reply) => {
    const player = await store.ensurePlayer();
    return reply.send(player);
  });

  fastify.post<{
    Body: {
      name?: string;
      element?: string;
      weapon?: string;
      laser_color?: string;
      player_class?: string;
      body_type?: string;
      level?: number;
      xp?: number;
      bonus_str?: number;
      bonus_dex?: number;
      bonus_int?: number;
      bonus_agi?: number;
      bonus_vit?: number;
      unspent_points?: number;
    };
  }>('/api/game/player', async (req, reply) => {
    await store.ensurePlayer();
    const { xp, ...rest } = req.body;
    const fields: Record<string, unknown> = { ...rest };
    if (xp !== undefined) fields.experience = xp;
    const updated = await store.updatePlayer(fields as any);
    return reply.send(updated);
  });

  // ── Coin Collection ────────────────────────────────────────────────────
  fastify.post<{
    Body: { amount: number };
  }>('/api/game/collect', async (req, reply) => {
    const amount = Math.max(0, Math.floor(req.body.amount ?? 0));
    if (amount === 0) return reply.send({ ok: true, phobos_coins: 0 });
    const total = await store.addCoins(amount);
    return reply.send({ ok: true, phobos_coins: total });
  });

  // ── Inventory ──────────────────────────────────────────────────────────
  fastify.get<{
    Querystring: { target?: string };
  }>('/api/game/inventory', async (req, reply) => {
    const items = await store.getInventory(req.query.target);
    return reply.send(items);
  });

  fastify.get('/api/game/inventory/equipped', async (_req, reply) => {
    const items = await store.getEquippedItems();
    return reply.send(items);
  });

  fastify.post<{
    Body: { item_id: string; target: string; slot?: string; rarity?: number; data?: string };
  }>('/api/game/inventory/add', async (req, reply) => {
    const { item_id, target, slot, rarity, data } = req.body;
    const item = await store.addItem(item_id, target, slot ?? '', rarity ?? 0, data ?? '{}');
    return reply.send(item);
  });

  fastify.post<{
    Body: { id: string };
  }>('/api/game/inventory/equip', async (req, reply) => {
    await store.equipItem(req.body.id);
    const equipped = await store.getEquippedItems();
    return reply.send({ ok: true, equipped });
  });

  fastify.post<{
    Body: { id: string };
  }>('/api/game/inventory/unequip', async (req, reply) => {
    await store.unequipItem(req.body.id);
    return reply.send({ ok: true });
  });

  fastify.post<{
    Body: { id: string; sellPrice?: number };
  }>('/api/game/inventory/sell', async (req, reply) => {
    const price = Math.max(0, req.body.sellPrice ?? 0);
    await store.removeItem(req.body.id);
    let coins = 0;
    if (price > 0) {
      coins = await store.addCoins(price);
    }
    return reply.send({ ok: true, phobos_coins: coins });
  });

  fastify.post<{
    Body: { amount: number };
  }>('/api/game/coins/spend', async (req, reply) => {
    const result = await store.spendCoins(Math.max(0, req.body.amount ?? 0));
    return reply.send(result);
  });

  // ── Decorations ────────────────────────────────────────────────────────
  fastify.get('/api/game/decorations', async (_req, reply) => {
    const decs = await store.getDecorations();
    return reply.send(decs);
  });

  fastify.post<{
    Body: { item_id: string; tile_x: number; tile_y: number };
  }>('/api/game/decorations', async (req, reply) => {
    const dec = await store.placeDecoration(req.body.item_id, req.body.tile_x, req.body.tile_y);
    return reply.send(dec);
  });

  fastify.delete<{
    Params: { id: string };
  }>('/api/game/decorations/:id', async (req, reply) => {
    await store.removeDecoration(req.params.id);
    return reply.send({ ok: true });
  });
}
