/**
 * trainingRoutes.ts — Artist Plugin Training API
 *
 * POST /api/phobos/training/sessions         — create session from CreateDraft
 * GET  /api/phobos/training/sessions         — list all sessions
 * GET  /api/phobos/training/sessions/:id     — get one session
 * POST /api/phobos/training/sessions/:id/run — start training (SSE stream)
 * POST /api/phobos/training/sessions/:id/abort — abort active training
 * DELETE /api/phobos/training/sessions/:id   — delete session record + files
 *
 * Register via: await registerTrainingRoutes(fastify) in server.ts
 */

import type { FastifyInstance } from 'fastify';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { PluginStore }     from '../db/PluginStore.js';
import {
  createSession,
  readSession,
  listSessions,
  runTraining,
  abortTraining,
  isTraining,
  activeSessionId,
  resolveLatestCheckpoint,
  estimateTrainingVramGb,
  type StartTrainingOptions,
} from '../phobos/PluginTrainer.js';
import { detectHardware, queryGpuFreeVram } from '../phobos/PhobosLocalManager.js';
import type { PluginBaseModel, PluginCategory } from '../phobos/PluginTypes.js';

const TRAINING_ROOT = path.join(os.homedir(), '.phobos', 'plugin-training');

export async function registerTrainingRoutes(fastify: FastifyInstance): Promise<void> {
  const db    = DatabaseManager.getInstance();
  const store = new PluginStore(db);
  await store.ensureTable();

  // ── Create session ─────────────────────────────────────────────────────────

  fastify.post<{ Body: Record<string, unknown> }>(
    '/api/phobos/training/sessions',
    async (req, reply) => {
      if (isTraining()) {
        return reply.status(409).send({ error: 'A training session is already active' });
      }

      const b = req.body;
      const sessionId = `session_${Date.now()}`;

      const required: (keyof typeof b)[] = ['name', 'baseModel', 'category', 'triggerWord', 'password'];
      for (const field of required) {
        if (!b[field]) return reply.status(400).send({ error: `Missing field: ${field}` });
      }

      try {
        const opts: StartTrainingOptions = {
          sessionId,
          name:               String(b.name),
          description:        String(b.description ?? ''),
          author:             String(b.author       ?? 'local'),
          baseModel:          b.baseModel  as PluginBaseModel,
          category:           b.category   as PluginCategory,
          triggerWord:        String(b.triggerWord),
          tags:               Array.isArray(b.tags) ? (b.tags as string[]) : [],
          rank:               Number(b.rank              ?? 16),
          recommendedWeight:  Number(b.recommendedWeight ?? 0.75),
          password:           String(b.password),
          addLicense:         Boolean(b.addLicense ?? false),
          steps:              Number(b.steps       ?? 1000),
          batchSize:          Number(b.batchSize   ?? 1),
          lr:                 Number(b.lr          ?? 1e-4),
          width:              Number(b.width        ?? 1024),
          height:             Number(b.height       ?? 1024),
        };

        const session = await createSession(opts);
        return reply.status(201).send(session);
      } catch (e) {
        return reply.status(500).send({ error: (e as Error).message });
      }
    },
  );

  // ── List sessions ──────────────────────────────────────────────────────────

  fastify.get('/api/phobos/training/sessions', async (_req, reply) => {
    return reply.send(listSessions());
  });

  // ── Get session ────────────────────────────────────────────────────────────

  fastify.get<{ Params: { id: string } }>(
    '/api/phobos/training/sessions/:id',
    async (req, reply) => {
      const s = readSession(req.params.id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      return reply.send(s);
    },
  );

  // ── Run training (SSE) ─────────────────────────────────────────────────────
  // Streams TrainingProgress events as newline-delimited JSON (NDJSON).
  // The frontend reads via EventSource or fetch + ReadableStream.
  // event: step     → { type, session }
  // event: done     → { type, session }
  // event: error    → { type, session, message }

  fastify.post<{ Params: { id: string } }>(
    '/api/phobos/training/sessions/:id/run',
    async (req, reply) => {
      const sessionId = req.params.id;
      const s         = readSession(sessionId);
      if (!s) return reply.status(404).send({ error: 'Session not found' });

      if (isTraining() && activeSessionId() !== sessionId) {
        return reply.status(409).send({ error: `Another session is active: ${activeSessionId()}` });
      }

      // Check image count before starting
      const imageCount = _countImages(s.image_dir);
      if (imageCount < 5) {
        return reply.status(400).send({ error: `At least 5 training images required (found ${imageCount})` });
      }

      // SSE headers
      reply.raw.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const send = (ev: object) => {
        if (!reply.raw.destroyed) {
          reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
        }
      };

      // Keep-alive ping every 15s
      const pingInterval = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(': ping\n\n');
      }, 15_000);

      req.raw.on('close', () => {
        clearInterval(pingInterval);
        // Client disconnect during training — abort
        if (isTraining() && activeSessionId() === sessionId) {
          abortTraining(sessionId);
        }
      });

      try {
        for await (const progress of runTraining(sessionId, store)) {
          send(progress);
          if (progress.type === 'done' || progress.type === 'error') break;
        }
      } catch (e) {
        send({ type: 'error', message: (e as Error).message });
      } finally {
        clearInterval(pingInterval);
        if (!reply.raw.destroyed) reply.raw.end();
      }
    },
  );

  // ── Abort ──────────────────────────────────────────────────────────────────

  fastify.post<{ Params: { id: string } }>(
    '/api/phobos/training/sessions/:id/abort',
    async (req, reply) => {
      const { id } = req.params;
      const s = readSession(id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      abortTraining(id);
      return reply.send({ ok: true });
    },
  );

  // ── Delete ─────────────────────────────────────────────────────────────────

  fastify.delete<{ Params: { id: string } }>(
    '/api/phobos/training/sessions/:id',
    async (req, reply) => {
      const { id } = req.params;
      const s = readSession(id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      if (isTraining() && activeSessionId() === id) {
        return reply.status(409).send({ error: 'Cannot delete an active training session' });
      }
      // Remove session directory
      try {
        fs.rmSync(s.session_dir, { recursive: true, force: true });
      } catch { /* ignore */ }
      return reply.send({ ok: true, deleted: id });
    },
  );

  // ── Training status summary ────────────────────────────────────────────────

  fastify.get('/api/phobos/training/status', async (_req, reply) => {
    return reply.send({
      active:    isTraining(),
      sessionId: activeSessionId(),
    });
  });

  // ── VRAM check ─────────────────────────────────────────────────────────────
  // Queries live free VRAM on the primary GPU and checks it against the
  // estimated requirement for the given base model + rank.
  // Called by the CreateWizard before allowing Start Training.

  fastify.get<{ Querystring: { baseModel?: string; rank?: string } }>(
    '/api/phobos/training/vram-check',
    async (req, reply) => {
      const baseModel = (req.query.baseModel ?? 'flux-dev') as PluginBaseModel;
      const rank      = Math.max(4, Math.min(64, parseInt(req.query.rank ?? '16', 10)));
      const required  = estimateTrainingVramGb(baseModel, rank);

      try {
        const hw  = await detectHardware();
        const gpu = hw.gpus.find(g => g.vramGb >= 4) ?? hw.gpus[0];
        if (!gpu) {
          return reply.send({ ok: false, requiredGb: required, freeGb: 0, totalGb: 0,
            vendor: 'cpu', device: 'CPU only', message: 'No GPU detected — training requires a GPU with at least 6 GB VRAM.' });
        }

        const freeMb  = await queryGpuFreeVram(gpu);
        const freeGb  = freeMb !== undefined ? parseFloat((freeMb / 1024).toFixed(1)) : gpu.vramGb;
        const totalGb = gpu.vramGb;
        const ok      = freeGb >= required;
        const message = ok
          ? `${freeGb} GB free on ${gpu.name} — ready to train.`
          : `Need ${required} GB, only ${freeGb} GB free on ${gpu.name}. Close other applications and try again.`;

        return reply.send({ ok, requiredGb: required, freeGb, totalGb, vendor: gpu.backend, device: gpu.name, message });
      } catch (e) {
        return reply.status(500).send({ error: (e as Error).message });
      }
    },
  );

  // ── Latest checkpoint ──────────────────────────────────────────────────────
  // Returns the path to the latest accelerate checkpoint dir for a session,
  // or null if none exist. Used by TrainingPanel to surface resume options.

  fastify.get<{ Params: { id: string } }>(
    '/api/phobos/training/sessions/:id/checkpoint',
    async (req, reply) => {
      const s = readSession(req.params.id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      const ckpt = resolveLatestCheckpoint(req.params.id);
      return reply.send({ checkpoint: ckpt });
    },
  );

  // ── Generate previews (stub) ───────────────────────────────────────────────
  // Post-training preview generation is not yet implemented.
  // The output/previews/ dir is checked at packaging time — place images there
  // manually or wait for the non-interactive generation pipeline (Phase D+).

  fastify.post<{ Params: { id: string } }>(
    '/api/phobos/training/sessions/:id/generate-previews',
    async (req, reply) => {
      const s = readSession(req.params.id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      if (s.status !== 'done') return reply.status(409).send({ error: 'Training must be complete before generating previews' });
      const previewDir = path.join(os.homedir(), '.phobos', 'plugin-training', s.session_id, 'output', 'previews');
      // TODO: wire to non-interactive image gen pipeline (scheduling system Phase D)
      return reply.status(501).send({
        ok: false,
        message: 'Automatic preview generation is coming soon. You can manually place images in the output/previews/ folder inside your training session directory and they will be embedded in your plugin.',
        previewDir,
      });
    },
  );

  // ── List preview images ────────────────────────────────────────────────────
  // Returns base64 data URLs for any images in output/previews/ so the
  // frontend DoneView can display them without a separate static file server.

  fastify.get<{ Params: { id: string } }>(
    '/api/phobos/training/sessions/:id/previews',
    async (req, reply) => {
      const s = readSession(req.params.id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      const previewDir = path.join(s.session_dir, 'output', 'previews');
      if (!fs.existsSync(previewDir)) return reply.send({ images: [] });
      const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
      const images: string[] = [];
      try {
        for (const f of fs.readdirSync(previewDir).slice(0, 6)) {
          if (!IMAGE_EXTS.has(path.extname(f).toLowerCase())) continue;
          const buf  = fs.readFileSync(path.join(previewDir, f));
          const ext  = path.extname(f).slice(1).replace('jpg', 'jpeg');
          images.push(`data:image/${ext};base64,${buf.toString('base64')}`);
        }
      } catch { /* ignore */ }
      return reply.send({ images });
    },
  );
}

// ── Helper ────────────────────────────────────────────────────────────────────

function _countImages(dir: string): number {
  const EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tiff', '.bmp']);
  try {
    return fs.readdirSync(dir).filter(f => EXTS.has(path.extname(f).toLowerCase())).length;
  } catch { return 0; }
}
