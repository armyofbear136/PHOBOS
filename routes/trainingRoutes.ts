/**
 * trainingRoutes.ts — Unified Training API
 *
 * Handles image plugin training (existing) and LLM cartridge training (new).
 * All routes share the same URL schema. The session type is encoded in the
 * session body and dispatched at the run endpoint.
 *
 * Image training routes (existing):
 *   POST   /api/phobos/training/sessions                  — create image session
 *   GET    /api/phobos/training/sessions                  — list image sessions
 *   GET    /api/phobos/training/sessions/:id              — get image session
 *   POST   /api/phobos/training/sessions/:id/run          — run (SSE)
 *   POST   /api/phobos/training/sessions/:id/abort        — abort
 *   DELETE /api/phobos/training/sessions/:id              — delete
 *   GET    /api/phobos/training/status                    — active status
 *   GET    /api/phobos/training/vram-check                — VRAM check (image)
 *   GET    /api/phobos/training/sessions/:id/checkpoint   — latest checkpoint
 *   POST   /api/phobos/training/sessions/:id/generate-previews
 *   GET    /api/phobos/training/sessions/:id/previews
 *
 * LLM cartridge training routes (new):
 *   POST   /api/phobos/training/lm/sessions               — create LM session
 *   GET    /api/phobos/training/lm/sessions               — list LM sessions
 *   GET    /api/phobos/training/lm/sessions/:id           — get LM session
 *   POST   /api/phobos/training/lm/sessions/:id/run       — run (SSE)
 *   POST   /api/phobos/training/lm/sessions/:id/abort     — abort
 *   DELETE /api/phobos/training/lm/sessions/:id           — delete
 *   GET    /api/phobos/training/lm/status                 — active LM status
 *   GET    /api/phobos/training/lm/vram-check             — VRAM check (LM)
 *   GET    /api/phobos/training/lm/sessions/:id/checkpoint
 *   GET    /api/phobos/training/cache                     — cache size
 *   DELETE /api/phobos/training/cache                     — delete cache entries
 *
 * Audio training routes (stub — 501 until implemented):
 *   POST   /api/phobos/training/audio/sessions
 */

import type { FastifyInstance } from 'fastify';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { PluginStore }     from '../db/PluginStore.js';
import { CartridgeStore }  from '../db/CartridgeStore.js';
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
import {
  createLmSession,
  readLmSession,
  listLmSessions,
  runLmTraining,
  abortLmTraining,
  isLmTraining,
  activeLmSessionId,
  resolveLatestLmCheckpoint,
  estimateLmTrainingVramGb,
  trainingCacheSizeBytes,
  deleteTrainingCache,
  type StartLmTrainingOptions,
} from '../phobos/CartridgeTrainer.js';
import { detectHardware, queryGpuFreeVram } from '../phobos/PhobosLocalManager.js';
import type { PluginBaseModel, PluginCategory } from '../phobos/PluginTypes.js';
import type { CartridgeCategory, CartridgePersona, CartridgeLicense } from '../phobos/CartridgeTypes.js';

const IMAGE_TRAINING_ROOT = path.join(os.homedir(), '.phobos', 'plugin-training');

export async function registerTrainingRoutes(fastify: FastifyInstance): Promise<void> {
  const db             = DatabaseManager.getInstance();
  const pluginStore    = new PluginStore(db);
  const cartridgeStore = new CartridgeStore(db);
  await pluginStore.ensureTable();
  await cartridgeStore.ensureTable();

  // ═══════════════════════════════════════════════════════════════════════════
  // IMAGE TRAINING (existing — unchanged logic)
  // ═══════════════════════════════════════════════════════════════════════════

  fastify.post<{ Body: Record<string, unknown> }>(
    '/api/phobos/training/sessions',
    async (req, reply) => {
      if (isTraining()) {
        return reply.status(409).send({ error: 'A training session is already active' });
      }

      const b         = req.body;
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

  fastify.get('/api/phobos/training/sessions', async (_req, reply) => {
    return reply.send(listSessions());
  });

  fastify.get<{ Params: { id: string } }>(
    '/api/phobos/training/sessions/:id',
    async (req, reply) => {
      const s = readSession(req.params.id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      return reply.send(s);
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/api/phobos/training/sessions/:id/run',
    async (req, reply) => {
      const sessionId = req.params.id;
      const s         = readSession(sessionId);
      if (!s) return reply.status(404).send({ error: 'Session not found' });

      if (isTraining() && activeSessionId() !== sessionId) {
        return reply.status(409).send({ error: `Another session is active: ${activeSessionId()}` });
      }

      const imageCount = _countImages(s.image_dir);
      if (imageCount < 5) {
        return reply.status(400).send({ error: `At least 5 training images required (found ${imageCount})` });
      }

      reply.raw.writeHead(200, {
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const send        = (ev: object) => { if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`); };
      const pingInterval = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': ping\n\n'); }, 15_000);

      req.raw.on('close', () => {
        clearInterval(pingInterval);
        if (isTraining() && activeSessionId() === sessionId) abortTraining(sessionId);
      });

      try {
        for await (const progress of runTraining(sessionId, pluginStore)) {
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

  fastify.post<{ Params: { id: string } }>(
    '/api/phobos/training/sessions/:id/abort',
    async (req, reply) => {
      const s = readSession(req.params.id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      abortTraining(req.params.id);
      return reply.send({ ok: true });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/api/phobos/training/sessions/:id',
    async (req, reply) => {
      const { id } = req.params;
      const s = readSession(id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      if (isTraining() && activeSessionId() === id) {
        return reply.status(409).send({ error: 'Cannot delete an active training session' });
      }
      try { fs.rmSync(s.session_dir, { recursive: true, force: true }); } catch { /* ignore */ }
      return reply.send({ ok: true, deleted: id });
    },
  );

  fastify.get('/api/phobos/training/status', async (_req, reply) => {
    return reply.send({ active: isTraining(), sessionId: activeSessionId() });
  });

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
        const ok      = freeGb >= required;
        const message = ok
          ? `${freeGb} GB free on ${gpu.name} — ready to train.`
          : `Need ${required} GB, only ${freeGb} GB free on ${gpu.name}. Close other applications and try again.`;
        return reply.send({ ok, requiredGb: required, freeGb, totalGb: gpu.vramGb, vendor: gpu.backend, device: gpu.name, message });
      } catch (e) {
        return reply.status(500).send({ error: (e as Error).message });
      }
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/api/phobos/training/sessions/:id/checkpoint',
    async (req, reply) => {
      const s = readSession(req.params.id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      return reply.send({ checkpoint: resolveLatestCheckpoint(req.params.id) });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/api/phobos/training/sessions/:id/generate-previews',
    async (req, reply) => {
      const s = readSession(req.params.id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      if (s.status !== 'done') return reply.status(409).send({ error: 'Training must be complete before generating previews' });
      const previewDir = path.join(IMAGE_TRAINING_ROOT, s.session_id, 'output', 'previews');
      return reply.status(501).send({
        ok: false,
        message: 'Automatic preview generation is coming soon. You can manually place images in the output/previews/ folder inside your training session directory.',
        previewDir,
      });
    },
  );

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
          const buf = fs.readFileSync(path.join(previewDir, f));
          const ext = path.extname(f).slice(1).replace('jpg', 'jpeg');
          images.push(`data:image/${ext};base64,${buf.toString('base64')}`);
        }
      } catch { /* ignore */ }
      return reply.send({ images });
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // LLM CARTRIDGE TRAINING
  // ═══════════════════════════════════════════════════════════════════════════

  fastify.post<{ Body: Record<string, unknown> }>(
    '/api/phobos/training/lm/sessions',
    async (req, reply) => {
      if (isLmTraining()) {
        return reply.status(409).send({ error: 'An LM training session is already active' });
      }

      const b = req.body;
      const required: (keyof typeof b)[] = [
        'name', 'baseModelId', 'targetPersona', 'category', 'behaviorSummary',
      ];
      for (const field of required) {
        if (!b[field]) return reply.status(400).send({ error: `Missing field: ${field}` });
      }

      try {
        const opts: StartLmTrainingOptions = {
          sessionId:       `lm_${Date.now()}`,
          name:            String(b.name),
          description:     String(b.description     ?? ''),
          author:          String(b.author           ?? 'local'),
          baseModelId:     String(b.baseModelId),
          targetPersona:   b.targetPersona   as CartridgePersona,
          category:        b.category        as CartridgeCategory,
          tags:            Array.isArray(b.tags) ? (b.tags as string[]) : [],
          behaviorSummary: String(b.behaviorSummary),
          triggerContext:  b.triggerContext != null ? String(b.triggerContext) : null,
          license:         (b.license ?? 'phobos-community') as CartridgeLicense,
          password:        String(b.password),
          addLicense:      Boolean(b.addLicense ?? false),
          dataMode:        (b.dataMode ?? 'document') as 'document' | 'conversation' | 'mixed',
          rank:            b.rank  != null ? Number(b.rank)  : undefined,
          steps:           b.steps != null ? Number(b.steps) : undefined,
          lr:              b.lr    != null ? Number(b.lr)    : undefined,
        };
        const session = await createLmSession(opts);
        return reply.status(201).send(session);
      } catch (e) {
        return reply.status(500).send({ error: (e as Error).message });
      }
    },
  );

  fastify.get('/api/phobos/training/lm/sessions', async (_req, reply) => {
    return reply.send(listLmSessions());
  });

  fastify.get<{ Params: { id: string } }>(
    '/api/phobos/training/lm/sessions/:id',
    async (req, reply) => {
      const s = readLmSession(req.params.id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      return reply.send(s);
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/api/phobos/training/lm/sessions/:id/run',
    async (req, reply) => {
      const sessionId = req.params.id;
      const s         = readLmSession(sessionId);
      if (!s) return reply.status(404).send({ error: 'Session not found' });

      if (isLmTraining() && activeLmSessionId() !== sessionId) {
        return reply.status(409).send({ error: `Another LM session is active: ${activeLmSessionId()}` });
      }

      reply.raw.writeHead(200, {
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache',
        'Connection':        'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const send         = (ev: object) => { if (!reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`); };
      const pingInterval = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': ping\n\n'); }, 15_000);

      req.raw.on('close', () => {
        clearInterval(pingInterval);
        if (isLmTraining() && activeLmSessionId() === sessionId) abortLmTraining(sessionId);
      });

      try {
        for await (const progress of runLmTraining(sessionId, cartridgeStore)) {
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

  fastify.post<{ Params: { id: string } }>(
    '/api/phobos/training/lm/sessions/:id/abort',
    async (req, reply) => {
      const s = readLmSession(req.params.id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      abortLmTraining(req.params.id);
      return reply.send({ ok: true });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/api/phobos/training/lm/sessions/:id',
    async (req, reply) => {
      const { id } = req.params;
      const s = readLmSession(id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      if (isLmTraining() && activeLmSessionId() === id) {
        return reply.status(409).send({ error: 'Cannot delete an active training session' });
      }
      try { fs.rmSync(s.session_dir, { recursive: true, force: true }); } catch { /* ignore */ }
      return reply.send({ ok: true, deleted: id });
    },
  );

  // ── LM Dataset file management ───────────────────────────────────────────────
  // Raw binary upload: POST /api/phobos/training/lm/sessions/:id/dataset?filename=foo.txt
  // Body: raw file bytes (application/octet-stream)
  fastify.post<{ Params: { id: string }; Querystring: { filename?: string } }>(
    '/api/phobos/training/lm/sessions/:id/dataset',
    { config: { rawBody: true } },
    async (req, reply) => {
      const s = readLmSession(req.params.id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      const filename = req.query.filename ?? 'file.txt';
      const safe     = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!safe) return reply.status(400).send({ error: 'Invalid filename' });
      const data = req.body as Buffer;
      if (!data || data.length === 0) return reply.status(400).send({ error: 'Empty body' });
      fs.mkdirSync(s.dataset_dir, { recursive: true });
      fs.writeFileSync(path.join(s.dataset_dir, safe), data);
      const files = fs.readdirSync(s.dataset_dir).filter(f => !f.startsWith('.'));
      return reply.send({ ok: true, filename: safe, count: files.length });
    },
  );

  // GET list of uploaded dataset files
  fastify.get<{ Params: { id: string } }>(
    '/api/phobos/training/lm/sessions/:id/dataset',
    async (req, reply) => {
      const s = readLmSession(req.params.id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      if (!fs.existsSync(s.dataset_dir)) return reply.send({ files: [] });
      const files = fs.readdirSync(s.dataset_dir)
        .filter(f => !f.startsWith('.'))
        .map(f => {
          const stat = fs.statSync(path.join(s.dataset_dir, f));
          return { name: f, sizeBytes: stat.size };
        });
      return reply.send({ files });
    },
  );

  // DELETE a single dataset file
  fastify.delete<{ Params: { id: string; filename: string } }>(
    '/api/phobos/training/lm/sessions/:id/dataset/:filename',
    async (req, reply) => {
      const s = readLmSession(req.params.id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      const safe = path.basename(req.params.filename);
      const fp   = path.join(s.dataset_dir, safe);
      if (!fs.existsSync(fp)) return reply.status(404).send({ error: 'File not found' });
      fs.rmSync(fp);
      const files = fs.readdirSync(s.dataset_dir).filter(f => !f.startsWith('.'));
      return reply.send({ ok: true, deleted: safe, count: files.length });
    },
  );

  fastify.get('/api/phobos/training/lm/status', async (_req, reply) => {
    return reply.send({ active: isLmTraining(), sessionId: activeLmSessionId() });
  });

  fastify.get<{ Querystring: { baseModelId?: string; rank?: string } }>(
    '/api/phobos/training/lm/vram-check',
    async (req, reply) => {
      const baseModelId = req.query.baseModelId ?? 'qwen3.5-9b-q4';
      const rank        = Math.max(4, Math.min(64, parseInt(req.query.rank ?? '16', 10)));
      const required    = estimateLmTrainingVramGb(baseModelId, rank);
      try {
        const hw  = await detectHardware();
        const gpu = hw.gpus.find(g => g.vramGb >= 4) ?? hw.gpus[0];
        if (!gpu) {
          return reply.send({ ok: false, requiredGb: required, freeGb: 0, totalGb: 0,
            vendor: 'cpu', device: 'CPU only', message: 'No GPU detected — LM training requires a CUDA GPU.' });
        }
        const freeMb  = await queryGpuFreeVram(gpu);
        const freeGb  = freeMb !== undefined ? parseFloat((freeMb / 1024).toFixed(1)) : gpu.vramGb;
        const totalGb = parseFloat(gpu.vramGb.toFixed(1));
        // Use totalGb for ok — the active model will be unloaded before training starts.
        const ok      = totalGb >= required;
        const message = ok
          ? `${gpu.name} has ${totalGb} GB VRAM — sufficient for this model (${required} GB required).`
          : `${gpu.name} has ${totalGb} GB VRAM — insufficient for ${baseModelId} (${required} GB required).`;
        return reply.send({ ok, requiredGb: required, freeGb, totalGb, vendor: gpu.backend, device: gpu.name, message });
      } catch (e) {
        return reply.status(500).send({ error: (e as Error).message });
      }
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/api/phobos/training/lm/sessions/:id/checkpoint',
    async (req, reply) => {
      const s = readLmSession(req.params.id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      return reply.send({ checkpoint: resolveLatestLmCheckpoint(req.params.id) });
    },
  );

  // ── Training cache management ──────────────────────────────────────────────
  // GET returns total cache size in bytes plus per-model breakdown so the
  // CartridgesPanel can display "Delete Training Cache (18 GB)" per model.

  fastify.get('/api/phobos/training/cache', async (_req, reply) => {
    const totalBytes = trainingCacheSizeBytes();
    // Collect per-model info by scanning sessions for unique training_hf_ids
    const sessions   = listLmSessions();
    const seen       = new Set<string>();
    const models: Array<{ trainingHfId: string; baseModelId: string; sizeBytes: number }> = [];
    for (const s of sessions) {
      if (seen.has(s.training_hf_id)) continue;
      seen.add(s.training_hf_id);
      const { trainingCacheDir } = await import('../phobos/CartridgeTrainer.js');
      const dir       = trainingCacheDir(s.training_hf_id);
      const sizeBytes = _dirSizeBytes(dir);
      if (sizeBytes > 0) {
        models.push({ trainingHfId: s.training_hf_id, baseModelId: s.base_model_id, sizeBytes });
      }
    }
    return reply.send({ totalBytes, models });
  });

  fastify.delete<{ Body: { trainingHfIds?: string[] } }>(
    '/api/phobos/training/cache',
    async (req, reply) => {
      const ids = req.body?.trainingHfIds ?? null;
      deleteTrainingCache(ids);
      return reply.send({ ok: true, deleted: ids ?? 'all' });
    },
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // AUDIO TRAINING — stub (not yet implemented)
  // ═══════════════════════════════════════════════════════════════════════════

  fastify.post<{ Body: Record<string, unknown> }>(
    '/api/phobos/training/audio/sessions',
    async (_req, reply) => {
      return reply.status(501).send({
        error: 'Audio cartridge training is not yet implemented.',
      });
    },
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _countImages(dir: string): number {
  const EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tiff', '.bmp']);
  try {
    return fs.readdirSync(dir).filter(f => EXTS.has(path.extname(f).toLowerCase())).length;
  } catch { return 0; }
}

function _dirSizeBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  function walk(d: string): void {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else try { total += fs.statSync(p).size; } catch { /* ignore */ }
    }
  }
  walk(dir);
  return total;
}
