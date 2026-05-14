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
 *   PATCH  /api/phobos/training/lm/sessions/:id/config    — update rank/steps/lr/license
 *   POST   /api/phobos/training/lm/sessions/:id/run       — start training (fire-and-forget)
 *   GET    /api/phobos/training/lm/sessions/:id/run-status — poll training status
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
import { execFile }  from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
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
  updateSession,
  listLmSessions,
  startLmTraining,
  abortLmTraining,
  isLmTraining,
  activeLmSessionId,
  getLmTrainingStatus,
  resolveLatestLmCheckpoint,
  estimateLmTrainingVramGb,
  trainingCacheSizeBytes,
  deleteTrainingCache,
  type StartLmTrainingOptions,
  type LmTrainingSession,
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

      req.raw.socket?.on('close', () => {
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

  // PATCH /config — updates rank/steps/lr/license/password on a pending session.
  // Called by the wizard when the user advances past the Config step.
  fastify.patch<{ Params: { id: string }; Body: Partial<LmTrainingSession> }>(
    '/api/phobos/training/lm/sessions/:id/config',
    async (req, reply) => {
      const s = readLmSession(req.params.id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      const { rank, steps, lr, license, password, add_license } = req.body as {
        rank?: number; steps?: number; lr?: number;
        license?: string; password?: string;
        addLicense?: boolean; add_license?: boolean;
      };
      const patch: Partial<LmTrainingSession> = {};
      if (rank       !== undefined) patch.rank       = rank;
      if (steps      !== undefined) patch.steps      = steps;
      if (lr         !== undefined) patch.lr         = lr;
      if (license    !== undefined) patch.license    = license as LmTrainingSession['license'];
      if (password   !== undefined) patch.password   = password;
      // wizard sends addLicense (camelCase); session stores add_license (snake_case)
      const al = (req.body as { addLicense?: boolean }).addLicense ?? add_license;
      if (al !== undefined) patch.add_license = al;
      const updated = updateSession(req.params.id, patch);
      return reply.send(updated);
    },
  );

  // POST /run — starts training in the background and returns immediately.
  // Frontend polls /run-status for updates (mirrors WorkflowPanel pattern).
  fastify.post<{ Params: { id: string } }>(
    '/api/phobos/training/lm/sessions/:id/run',
    async (req, reply) => {
      const sessionId = req.params.id;
      const s         = readLmSession(sessionId);
      if (!s) return reply.status(404).send({ error: 'Session not found' });

      if (isLmTraining() && activeLmSessionId() !== sessionId) {
        return reply.status(409).send({ error: `Another LM session is active: ${activeLmSessionId()}` });
      }

      const result = startLmTraining(sessionId, cartridgeStore);
      if (!result.ok) {
        return reply.status(409).send({ error: result.error });
      }

      return reply.send({ ok: true, training: true });
    },
  );

  // GET /run-status — polled by the frontend every ~1500 ms.
  // Returns the current in-memory training state. Connection lifecycle is
  // completely decoupled from the training process.
  fastify.get<{ Params: { id: string } }>(
    '/api/phobos/training/lm/sessions/:id/run-status',
    async (req, reply) => {
      const { id } = req.params;
      const st = getLmTrainingStatus();
      if (st.sessionId !== id) {
        // No active run for this session — read final state from disk
        const s = readLmSession(id);
        return reply.send({ training: false, session: s });
      }
      // If completed more than 5 s ago, fall through to disk state
      if (st.completedAt && Date.now() - st.completedAt > 5000) {
        const s = readLmSession(id);
        return reply.send({ training: false, session: s });
      }
      return reply.send({ training: st.training, session: st.session });
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

  // Extensions phobos-lm-trainer.py handles natively (see DOC_EXTS in trainer).
  // Any file copied into dataset_dir whose extension is NOT in this set gets
  // renamed to .txt — the content is plain text, only the extension differs.
  const TRAINER_NATIVE_EXTS = new Set([
    '.md', '.txt', '.py', '.ts', '.js', '.json', '.html', '.pdf', '.jsonl',
  ]);

  function trainerDest(dir: string, originalName: string): string {
    const ext  = path.extname(originalName).toLowerCase();
    const base = path.basename(originalName, path.extname(originalName));
    const finalExt = TRAINER_NATIVE_EXTS.has(ext) ? ext : '.txt';
    // Avoid collisions: if renaming ext, append original ext slug to base
    const finalBase = finalExt !== ext ? `${base}_${ext.slice(1)}` : base;
    return path.join(dir, finalBase + finalExt);
  }

  // POST /pick-files — opens native OS multi-select file dialog, copies chosen
  // files into the session dataset_dir on the server side (no HTTP upload).
  // Returns the full updated file list.
  fastify.post<{ Params: { id: string } }>(
    '/api/phobos/training/lm/sessions/:id/dataset/pick-files',
    async (req, reply) => {
      const s = readLmSession(req.params.id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      fs.mkdirSync(s.dataset_dir, { recursive: true });

      const FILTER = 'Training files|*.md;*.txt;*.pdf;*.py;*.ts;*.js;*.json;*.html;*.htm;*.ahk;*.sh;*.bash;*.ps1;*.bat;*.cmd;*.lua;*.rb;*.go;*.rs;*.c;*.cpp;*.h;*.cs;*.java;*.kt;*.php;*.sql;*.yaml;*.yml;*.toml;*.ini;*.cfg;*.conf;*.env;*.log;*.csv;*.xml;*.rst;*.tex;*.org;*.adoc;*.jsonl|All files (*.*)|*.*';
      let selectedPaths: string[] = [];

      try {
        if (process.platform === 'win32') {
          const tmpPs1 = path.join(os.tmpdir(), `phobos-lm-pick-${Date.now()}.ps1`);
          const ps1 = [
            'Add-Type -AssemblyName System.Windows.Forms',
            '[System.Windows.Forms.Application]::EnableVisualStyles()',
            '$f = New-Object System.Windows.Forms.Form',
            '$f.TopMost = $true; $f.ShowInTaskbar = $false',
            '$f.WindowState = [System.Windows.Forms.FormWindowState]::Minimized',
            '$f.Show(); $f.Hide()',
            '$d = New-Object System.Windows.Forms.OpenFileDialog',
            `$d.Filter = "${FILTER}"`,
            '$d.Title = "Select training files"',
            '$d.Multiselect = $true',
            'if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileNames | ForEach-Object { Write-Output $_ } }',
            '$f.Dispose()',
          ].join('\r\n');
          try {
            fs.writeFileSync(tmpPs1, ps1, 'utf-8');
            const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1]);
            selectedPaths = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
          } finally { try { fs.unlinkSync(tmpPs1); } catch { /* ignore */ } }

        } else if (process.platform === 'darwin') {
          const { stdout } = await execFileAsync('osascript', [
            '-e', 'POSIX paths of (choose file with prompt "Select training files" with multiple selections allowed)',
          ]);
          selectedPaths = stdout.trim().split(', ').map(p => p.trim()).filter(Boolean);

        } else {
          const { stdout } = await execFileAsync('zenity', [
            '--file-selection', '--title=Select training files', '--multiple', '--separator=\n',
          ]);
          selectedPaths = stdout.split('\n').map(l => l.trim()).filter(Boolean);
        }
      } catch { /* user cancelled — selectedPaths stays empty */ }

      let copied = 0;
      for (const src of selectedPaths) {
        if (!fs.existsSync(src)) continue;
        const dest = trainerDest(s.dataset_dir, path.basename(src));
        try { fs.copyFileSync(src, dest); copied++; } catch { /* skip unreadable */ }
      }

      const files = fs.readdirSync(s.dataset_dir)
        .filter(f => !f.startsWith('.'))
        .map(f => { const stat = fs.statSync(path.join(s.dataset_dir, f)); return { name: f, sizeBytes: stat.size }; });
      return reply.send({ ok: true, copied, files });
    },
  );

  // POST /pick-folder — opens native OS folder dialog, copies all training-
  // compatible files from the chosen folder into dataset_dir on the server.
  // Returns the full updated file list.
  fastify.post<{ Params: { id: string } }>(
    '/api/phobos/training/lm/sessions/:id/dataset/pick-folder',
    async (req, reply) => {
      const s = readLmSession(req.params.id);
      if (!s) return reply.status(404).send({ error: 'Session not found' });
      fs.mkdirSync(s.dataset_dir, { recursive: true });

      const VALID_EXTS = new Set([
        '.md','.txt','.pdf','.py','.ts','.js','.json','.html','.htm',
        '.ahk','.sh','.bash','.zsh','.fish','.ps1','.bat','.cmd',
        '.lua','.rb','.go','.rs','.c','.cpp','.h','.hpp','.cs','.java',
        '.kt','.swift','.r','.m','.pl','.pm','.php','.sql',
        '.yaml','.yml','.toml','.ini','.cfg','.conf','.env','.log',
        '.csv','.xml','.rst','.tex','.org','.wiki','.adoc',
        '.nfo','.me','.readme','.license','.jsonl',
      ]);
      let folderPath = '';

      try {
        if (process.platform === 'win32') {
          const tmpPs1 = path.join(os.tmpdir(), `phobos-lm-folder-${Date.now()}.ps1`);
          const ps1 = [
            'Add-Type -AssemblyName System.Windows.Forms',
            '[System.Windows.Forms.Application]::EnableVisualStyles()',
            '$src = @"',
            'using System; using System.Runtime.InteropServices; using System.Windows.Forms;',
            '[ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")] class FileOpenDialogCOM {}',
            'public class FolderPicker2 {',
            '  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern int SHCreateItemFromParsingName(string p, IntPtr b, ref Guid r, out IShellItem i);',
            '  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IShellItem { void BindToHandler(IntPtr p, ref Guid b, ref Guid r, out IntPtr o); void GetParent(out IShellItem i); void GetDisplayName(uint s, out string n); void GetAttributes(uint m, out uint a); void Compare(IShellItem i, uint h, out int o); }',
            '  [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IFileOpenDialog { [PreserveSig] int Show(IntPtr h); void SetFileTypes(uint c, IntPtr t); void SetFileTypeIndex(uint i); void GetFileTypeIndex(out uint i); void Advise(IntPtr e, out uint c); void Unadvise(uint c); void SetOptions(uint f); void GetOptions(out uint f); void SetDefaultFolder(IShellItem i); void SetFolder(IShellItem i); void GetFolder(out IShellItem i); void GetCurrentSelection(out IShellItem i); void SetFileName(string n); void GetFileName(out string n); void SetTitle(string t); void SetOkButtonLabel(string t); void SetFileNameLabel(string t); void GetResult(out IShellItem i); void AddPlace(IShellItem i, int a); void SetDefaultExtension(string e); void Close(int r); void SetClientGuid(ref Guid g); void ClearClientData(); void SetFilter(IntPtr f); void GetResults(out IntPtr e); void GetSelectedItems(out IntPtr e); }',
            '  public static string Pick(string title) {',
            '    var dlg = (IFileOpenDialog)new FileOpenDialogCOM();',
            '    dlg.SetOptions(0x00000020 | 0x00000800);',
            '    dlg.SetTitle(title);',
            '    var hr = dlg.Show(IntPtr.Zero);',
            '    if (hr != 0) return "";',
            '    IShellItem item; dlg.GetResult(out item);',
            '    string p; item.GetDisplayName(0x80058000, out p); return p ?? "";',
            '  }',
            '}',
            '"@',
            'Add-Type -TypeDefinition $src -Language CSharp',
            '$result = [FolderPicker2]::Pick("Select folder containing training files")',
            'if ($result) { Write-Output $result }',
          ].join('\r\n');
          try {
            fs.writeFileSync(tmpPs1, ps1, 'utf-8');
            const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1]);
            folderPath = stdout.trim();
          } finally { try { fs.unlinkSync(tmpPs1); } catch { /* ignore */ } }

        } else if (process.platform === 'darwin') {
          const { stdout } = await execFileAsync('osascript', [
            '-e', 'POSIX path of (choose folder with prompt "Select folder containing training files")',
          ]);
          folderPath = stdout.trim();

        } else {
          const { stdout } = await execFileAsync('zenity', ['--file-selection', '--directory', '--title=Select training folder']);
          folderPath = stdout.trim();
        }
      } catch { /* cancelled */ }

      let copied = 0;
      if (folderPath && fs.existsSync(folderPath)) {
        for (const name of fs.readdirSync(folderPath)) {
          if (!VALID_EXTS.has(path.extname(name).toLowerCase())) continue;
          const src  = path.join(folderPath, name);
          const dest = trainerDest(s.dataset_dir, name);
          try {
            if (fs.statSync(src).isFile()) { fs.copyFileSync(src, dest); copied++; }
          } catch { /* skip unreadable */ }
        }
      }

      const files = fs.readdirSync(s.dataset_dir)
        .filter(f => !f.startsWith('.'))
        .map(f => { const stat = fs.statSync(path.join(s.dataset_dir, f)); return { name: f, sizeBytes: stat.size }; });
      return reply.send({ ok: true, copied, folderPath: folderPath || null, files });
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