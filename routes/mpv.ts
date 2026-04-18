/**
 * routes/mpv.ts — PHOBOS mpv player API routes.
 *
 * All playback control flows through these routes. The frontend never
 * communicates with mpv directly — state lives in MpvManager.
 *
 * POST  /api/mpv/load          { url: string }         — load file or stream URL
 * POST  /api/mpv/play                                   — resume playback
 * POST  /api/mpv/pause                                  — pause
 * POST  /api/mpv/toggle-pause                           — toggle pause state
 * POST  /api/mpv/stop                                   — stop (clear loaded file)
 * POST  /api/mpv/seek          { seconds: number }      — seek to absolute position
 * POST  /api/mpv/volume        { level: number }        — set volume 0–130
 * POST  /api/mpv/fullscreen    { enable: boolean }      — set fullscreen
 * POST  /api/mpv/quit                                   — kill mpv process entirely
 * GET   /api/mpv/status                                 — current player state
 *
 * Register with: fastify.register(mpvRoutes)
 * or: import { registerMpvRoutes } from './routes/mpv.js'; registerMpvRoutes(fastify);
 */

import type { FastifyInstance } from 'fastify';
import {
  startMpv,
  stopMpv,
  loadFile,
  play,
  pause,
  togglePause,
  seek,
  setVolume,
  fullscreen,
  stop,
  getMpvStatus,
  isMpvAvailable,
} from '../services/MpvManager.js';

export async function registerMpvRoutes(fastify: FastifyInstance): Promise<void> {

  // ── Status ────────────────────────────────────────────────────────────────
  fastify.get('/api/mpv/status', async (_req, reply) => {
    try {
      const status = await getMpvStatus();
      return reply.send(status);
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Load ──────────────────────────────────────────────────────────────────
  fastify.post<{ Body: { url: string } }>('/api/mpv/load', async (req, reply) => {
    const { url } = req.body;
    if (!url || typeof url !== 'string') {
      return reply.status(400).send({ error: 'url required' });
    }
    try {
      await loadFile(url);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Play ──────────────────────────────────────────────────────────────────
  fastify.post('/api/mpv/play', async (_req, reply) => {
    try {
      await play();
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Pause ─────────────────────────────────────────────────────────────────
  fastify.post('/api/mpv/pause', async (_req, reply) => {
    try {
      await pause();
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Toggle pause ──────────────────────────────────────────────────────────
  fastify.post('/api/mpv/toggle-pause', async (_req, reply) => {
    try {
      await togglePause();
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Stop ──────────────────────────────────────────────────────────────────
  fastify.post('/api/mpv/stop', async (_req, reply) => {
    try {
      await stop();
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Seek ──────────────────────────────────────────────────────────────────
  fastify.post<{ Body: { seconds: number } }>('/api/mpv/seek', async (req, reply) => {
    const { seconds } = req.body;
    if (typeof seconds !== 'number') {
      return reply.status(400).send({ error: 'seconds (number) required' });
    }
    try {
      await seek(seconds);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Volume ────────────────────────────────────────────────────────────────
  fastify.post<{ Body: { level: number } }>('/api/mpv/volume', async (req, reply) => {
    const { level } = req.body;
    if (typeof level !== 'number') {
      return reply.status(400).send({ error: 'level (number 0–130) required' });
    }
    try {
      await setVolume(level);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Fullscreen ────────────────────────────────────────────────────────────
  fastify.post<{ Body: { enable: boolean } }>('/api/mpv/fullscreen', async (req, reply) => {
    const { enable } = req.body;
    try {
      await fullscreen(Boolean(enable));
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Quit mpv ──────────────────────────────────────────────────────────────
  fastify.post('/api/mpv/quit', async (_req, reply) => {
    try {
      await stopMpv();
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });
}
