/**
 * routes/audio.ts — PHOBOS audio subsystem REST endpoints.
 *
 * This file covers the DAW (authoring) pipeline — see PHOBOS-Audio-Subsystem-Spec.md §4.
 * Generative audio endpoints (/tts, /music, /sfx) will be added in a later session.
 *
 * ── Carla lifecycle ──────────────────────────────────────────────────────────
 * POST /api/audio/carla/start                    — force-start Carla (diagnostics)
 * POST /api/audio/carla/stop                     — stop Carla (diagnostics)
 * GET  /api/audio/carla/status                   — {state, pid, uptime, activePreset}
 * POST /api/audio/carla/param                    — set a single plugin parameter
 * POST /api/audio/carla/note                     — send note on/off
 *
 * ── Effect rack ──────────────────────────────────────────────────────────────
 * GET    /api/audio/effect-rack/presets          — list all presets
 * POST   /api/audio/effect-rack/presets          — create/update a preset
 * POST   /api/audio/effect-rack/activate         — activate preset by id
 * DELETE /api/audio/effect-rack/presets/:id      — delete non-factory preset
 *
 * ── DAW projects ─────────────────────────────────────────────────────────────
 * GET  /api/audio/daw/projects                   — list projects
 * GET  /api/audio/daw/projects/:id               — get project XTK + metadata
 * POST /api/audio/daw/projects                   — save (upsert) project
 *
 * ── ALDA ─────────────────────────────────────────────────────────────────────
 * POST /api/audio/alda/compile                   — compile ALDA text → MIDI events
 */

import type { FastifyInstance } from 'fastify';

import { DatabaseManager } from '../db/DatabaseManager.js';
import { EffectRackStore, EffectPreset, EffectContext } from '../db/EffectRackStore.js';
import { DawProjectStore } from '../db/DawProjectStore.js';
import {
  ensureRunning as ensureCarlaRunning,
  stopCarla,
  getStatus as getCarlaStatus,
  setParam as carlaSetParam,
  noteOn as carlaNoteOn,
  noteOff as carlaNoteOff,
  activatePreset as carlaActivatePreset,
  setEffectRackStore,
} from '../phobos/CarlaManager.js';
import { aldaToMidi } from '../phobos/alda-parser/index.js';

// ── Route registration ────────────────────────────────────────────────────────

export async function registerAudioRoutes(fastify: FastifyInstance): Promise<void> {
  const db             = DatabaseManager.getInstance();
  const effectRack     = new EffectRackStore(db);
  const dawProjects    = new DawProjectStore(db);
  await effectRack.ensureTable();
  await dawProjects.ensureTable();

  // Register the store with CarlaManager so it can resolve preset ids.
  setEffectRackStore(effectRack);

  // ── Carla ────────────────────────────────────────────────────────────────

  fastify.post('/api/audio/carla/start', async (_req, reply) => {
    try {
      await ensureCarlaRunning();
      return reply.send({ ok: true, status: getCarlaStatus() });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.post('/api/audio/carla/stop', async (_req, reply) => {
    await stopCarla();
    return reply.send({ ok: true, status: getCarlaStatus() });
  });

  fastify.get('/api/audio/carla/status', async (_req, reply) => {
    return reply.send(getCarlaStatus());
  });

  fastify.post<{
    Body: { pluginIdx: number; paramId: number; value: number };
  }>('/api/audio/carla/param', async (req, reply) => {
    try {
      const { pluginIdx, paramId, value } = req.body;
      if (typeof pluginIdx !== 'number' || typeof paramId !== 'number' || typeof value !== 'number') {
        return reply.status(400).send({ error: 'pluginIdx, paramId, and value must be numbers' });
      }
      await ensureCarlaRunning();
      carlaSetParam(pluginIdx, paramId, value);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  fastify.post<{
    Body: { pluginIdx: number; type: 'on' | 'off'; note: number; velocity?: number; channel?: number };
  }>('/api/audio/carla/note', async (req, reply) => {
    try {
      const { pluginIdx, type, note } = req.body;
      const velocity = req.body.velocity ?? 100;
      const channel  = req.body.channel  ?? 0;
      if (typeof pluginIdx !== 'number' || typeof note !== 'number' || (type !== 'on' && type !== 'off')) {
        return reply.status(400).send({ error: 'Bad payload' });
      }
      await ensureCarlaRunning();
      if (type === 'on') carlaNoteOn(pluginIdx, channel, note, velocity);
      else               carlaNoteOff(pluginIdx, channel, note);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Effect rack ──────────────────────────────────────────────────────────

  fastify.get<{
    Querystring: { context?: string };
  }>('/api/audio/effect-rack/presets', async (req, reply) => {
    const context = req.query.context as EffectContext | undefined;
    const rows    = await effectRack.list(context);
    return reply.send({ presets: rows });
  });

  fastify.post<{
    Body: Omit<EffectPreset, 'created_at' | 'updated_at'>;
  }>('/api/audio/effect-rack/presets', async (req, reply) => {
    try {
      const saved = await effectRack.upsert(req.body);
      return reply.send({ ok: true, preset: saved });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  fastify.post<{
    Body: { id: string };
  }>('/api/audio/effect-rack/activate', async (req, reply) => {
    try {
      await carlaActivatePreset(req.body.id);
      return reply.send({ ok: true, activePresetId: req.body.id });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  fastify.delete<{
    Params: { id: string };
  }>('/api/audio/effect-rack/presets/:id', async (req, reply) => {
    const ok = await effectRack.delete(req.params.id);
    if (!ok) return reply.status(409).send({ error: 'Preset not found or is a factory preset' });
    return reply.send({ ok: true });
  });

  // ── DAW projects ─────────────────────────────────────────────────────────

  fastify.get<{
    Querystring: { thread_id?: string };
  }>('/api/audio/daw/projects', async (req, reply) => {
    const threadId = req.query.thread_id ?? undefined;
    const rows = await dawProjects.list(threadId);
    return reply.send({ projects: rows });
  });

  fastify.get<{
    Params: { id: string };
  }>('/api/audio/daw/projects/:id', async (req, reply) => {
    const p = await dawProjects.get(req.params.id);
    if (!p) return reply.status(404).send({ error: 'Project not found' });
    return reply.send(p);
  });

  fastify.post<{
    Body: { id: string; name: string; xtk: unknown; thread_id?: string | null };
  }>('/api/audio/daw/projects', async (req, reply) => {
    const { id, name, xtk } = req.body;
    const threadId = req.body.thread_id ?? null;
    if (!id || !name || xtk == null) {
      return reply.status(400).send({ error: 'id, name, and xtk are required' });
    }
    const xtkJson = typeof xtk === 'string' ? xtk : JSON.stringify(xtk);
    const saved = await dawProjects.save(id, name, xtkJson, threadId);
    return reply.send({ ok: true, project: saved });
  });

  // ── ALDA ─────────────────────────────────────────────────────────────────

  fastify.post<{
    Body: { source: string };
  }>('/api/audio/alda/compile', async (req, reply) => {
    try {
      const result = aldaToMidi(req.body.source);
      return reply.send({
        ok:            true,
        ticksPerBeat:  result.ticksPerBeat,
        tempoBpm:      result.tempoBpm,
        eventCount:    result.events.length,
        events:        result.events,
      });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });
}
