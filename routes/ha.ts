/**
 * routes/ha.ts — Home Assistant connection and state API routes.
 *
 * POST   /api/ha/connect          — save config and connect (or reconnect)
 * POST   /api/ha/disconnect        — disconnect and disable
 * GET    /api/ha/status            — connection state, entity count, last connected
 * GET    /api/ha/states            — all cached entity states (filtered to exposed domains)
 * GET    /api/ha/states/:entity_id — single entity state
 * PATCH  /api/ha/config            — update config without reconnecting
 *
 * All writes hit getInstance() — HA config is system-level, not per user-session.
 */

import type { FastifyInstance } from 'fastify';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { HaStore, DEFAULT_EXPOSED_DOMAINS } from '../db/HaStore.js';
import { HaWatchStore } from '../db/HaWatchStore.js';
import {
  connectHa,
  disconnectHa,
  getHaStatus,
  getHaSnapshot,
  getHaEntity,
  setExposedDomains,
  callService,
} from '../services/HAManager.js';

export async function registerHaRoutes(fastify: FastifyInstance): Promise<void> {
  const db    = DatabaseManager.getInstance();
  const store = new HaStore(db);
  await store.ensureTable();

  // ── POST /api/ha/connect ──────────────────────────────────────────────────
  // Body: { ha_url, ha_token, exposed_domains? }
  // Saves config, marks enabled, initiates WebSocket connection.
  fastify.post<{
    Body: {
      ha_url:           string;
      ha_token:         string;
      exposed_domains?: string[];
    };
  }>('/api/ha/connect', async (req, reply) => {
    const { ha_url, ha_token, exposed_domains } = req.body;
    if (!ha_url || !ha_token) {
      return reply.status(400).send({ error: 'ha_url and ha_token are required' });
    }

    // Normalise URL — strip trailing slash.
    const url = ha_url.replace(/\/$/, '');

    await store.save({
      ha_url:           url,
      ha_token:         ha_token.trim(),
      enabled:          true,
      exposed_domains:  exposed_domains ?? DEFAULT_EXPOSED_DOMAINS,
    });

    // Initiate connection (non-blocking — auth and state load happen async).
    connectHa(db).catch(err => {
      console.error('[HARoutes] connectHa error:', (err as Error).message);
    });

    return reply.send({ ok: true, status: getHaStatus() });
  });

  // ── POST /api/ha/disconnect ───────────────────────────────────────────────
  fastify.post('/api/ha/disconnect', async (_req, reply) => {
    await disconnectHa(db);
    return reply.send({ ok: true, status: getHaStatus() });
  });

  // ── GET /api/ha/status ────────────────────────────────────────────────────
  fastify.get('/api/ha/status', async (_req, reply) => {
    const config = await store.get();
    return reply.send({
      ...getHaStatus(),
      exposed_domains: config?.exposed_domains ?? DEFAULT_EXPOSED_DOMAINS,
    });
  });

  // ── GET /api/ha/states ────────────────────────────────────────────────────
  // Returns the snapshot as a structured array for the frontend panel.
  fastify.get('/api/ha/states', async (_req, reply) => {
    const snapshot = getHaSnapshot();
    if (snapshot === null) {
      return reply.send({ connected: false, entities: [] });
    }
    // Parse the rendered snapshot back into structured lines for the frontend.
    const entities = snapshot.split('\n').map(line => ({ line }));
    return reply.send({ connected: true, entities });
  });

  // ── PATCH /api/ha/config ──────────────────────────────────────────────────
  // Update exposed_domains or URL without triggering a reconnect.
  fastify.patch<{
    Body: {
      exposed_domains?: string[];
      ha_url?:          string;
    };
  }>('/api/ha/config', async (req, reply) => {
    await store.save(req.body);
    if (req.body.exposed_domains !== undefined) {
      setExposedDomains(req.body.exposed_domains);
    }
    return reply.send({ ok: true, config: await store.get() });
  });

  // ── GET /api/ha/states/:entity_id ────────────────────────────────────────
  // Direct entity lookup — no domain filtering. 404 if not connected or not found.
  fastify.get<{ Params: { entity_id: string } }>('/api/ha/states/:entity_id', async (req, reply) => {
    const entity = getHaEntity(req.params.entity_id);
    if (entity === null) {
      return reply.status(404).send({ error: 'Entity not found' });
    }
    return reply.send(entity);
  });

  // ── GET /api/ha/watch/runs ────────────────────────────────────────────────
  // Returns recent watch duty runs for the HA panel history section.
  // Polled by HomeAssistantPanel on a 30s interval when connected.
  fastify.get('/api/ha/watch/runs', async (_req, reply) => {
    const watchStore = new HaWatchStore(db);
    await watchStore.ensureTable();
    const runs = await watchStore.getRecentRuns(20);
    return reply.send(runs);
  });

  // ── POST /api/ha/action ───────────────────────────────────────────────────
  // Execute a confirmed HA service call. Called by CopilotPanel after the user
  // taps Confirm on an action_pending confirmation card.
  // This is the only call site for callService() — no action fires without
  // the user explicitly confirming via the card UI.
  fastify.post<{
    Body: {
      domain:    string;
      service:   string;
      data:      Record<string, unknown>;
    };
  }>('/api/ha/action', async (req, reply) => {
    const { domain, service, data } = req.body;

    if (!domain || !service || typeof data !== 'object' || data === null) {
      return reply.status(400).send({ ok: false, error: 'domain, service, and data are required' });
    }

    try {
      const result = await callService(domain, service, data);
      return reply.send({ ok: true, result });
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[HA Action] ${domain}.${service} failed: ${msg}`);
      return reply.status(502).send({ ok: false, error: msg });
    }
  });
}