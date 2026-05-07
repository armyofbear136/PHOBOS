/**
 * PluginTrainer.ts — Manages phobos-trainer.py subprocess lifecycle.
 *
 * Responsibilities:
 *   - Install training-specific deps (peft, bitsandbytes, prodigyopt) into the
 *     existing inference venv via ensureTrainingDeps()
 *   - Write/read session.json in the training session directory
 *   - Spawn phobos-trainer.py, parse its stdout progress lines
 *   - Support abort (SIGTERM) and resume (resume_from checkpoint)
 *   - Package trained lora.safetensors into a signed .phobos archive via PluginStore
 *
 * One active training session at a time (module-level guard).
 * Session state is persisted to disk so it survives PHOBOS restarts.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import { execFile }  from 'child_process';
import { promisify } from 'util';
import {
  getPythonPath,
  gpuToVendor,
  type GpuVendor,
} from './PythonEnvManager.js';
import { detectHardware, IMAGE_FLUX_DIR, IMAGE_SDXL_DIR } from './PhobosLocalManager.js';
import type { PluginBaseModel, PluginCategory } from './PluginTypes.js';

const execFileAsync = promisify(execFile);

// ── Paths ─────────────────────────────────────────────────────────────────────

const TRAINING_ROOT = path.join(os.homedir(), '.phobos', 'plugin-training');
const TRAINER_SCRIPT = path.join(
  path.dirname(typeof __filename !== 'undefined' ? __filename : path.join(process.cwd(), 'x')),
  'phobos-trainer.py',
);

// ── Types ─────────────────────────────────────────────────────────────────────

export type TrainingStatus =
  | 'pending'      // session created, not yet started
  | 'installing'   // installing training deps
  | 'captioning'   // running CaptionProcessor
  | 'training'     // phobos-trainer.py active
  | 'packaging'    // assembling .phobos archive
  | 'done'         // complete — pluginId set
  | 'error'        // terminal failure
  | 'aborted';     // user-aborted

export interface TrainingSession {
  session_id:    string;
  status:        TrainingStatus;
  // Plugin metadata (from CreateDraft)
  name:          string;
  description:   string;
  author:        string;
  base_model:    PluginBaseModel;
  category:      PluginCategory;
  trigger_word:  string;
  tags:          string[];
  rank:          number;
  recommended_weight: number;
  password:      string;   // stored in session only; never logged
  add_license:   boolean;
  // Training config
  steps:         number;
  batch_size:    number;
  lr:            number;
  width:         number;
  height:        number;
  device:        string;
  vendor:        GpuVendor;
  model_path:    string;    // base model gguf/safetensors path
  // Paths
  image_dir:     string;
  caption_file:  string;
  output_dir:    string;
  session_dir:   string;
  // Progress
  current_step:  number;
  total_steps:   number;
  current_loss:  number;
  current_lr:    number;
  current_phase: string;
  resume_from:   string | null;
  // Result
  lora_path:     string | null;
  plugin_id:     string | null;
  error:         string | null;
  // Timestamps
  created_at:    string;
  started_at:    string | null;
  finished_at:   string | null;
}

export interface TrainingProgress {
  type:    'status' | 'step' | 'phase' | 'done' | 'error' | 'installing';
  session: TrainingSession;
  message?: string;
}

export interface StartTrainingOptions {
  sessionId:   string;
  name:        string;
  description: string;
  author:      string;
  baseModel:   PluginBaseModel;
  category:    PluginCategory;
  triggerWord: string;
  tags:        string[];
  rank:        number;
  recommendedWeight: number;
  password:    string;
  addLicense:  boolean;
  steps:       number;
  batchSize?:  number;
  lr?:         number;
  width?:      number;
  height?:     number;
}

// ── Module-level state ────────────────────────────────────────────────────────

let _activeProc:      ChildProcess | null = null;
let _activeSessionId: string | null       = null;

export function isTraining(): boolean       { return _activeProc !== null; }
export function activeSessionId(): string | null { return _activeSessionId; }

// ── Session disk I/O ──────────────────────────────────────────────────────────

function sessionDir(sessionId: string): string {
  return path.join(TRAINING_ROOT, sessionId);
}

function sessionFile(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'session.json');
}

export function readSession(sessionId: string): TrainingSession | null {
  const f = sessionFile(sessionId);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')) as TrainingSession; }
  catch { return null; }
}

function writeSession(s: TrainingSession): void {
  fs.mkdirSync(sessionDir(s.session_id), { recursive: true });
  fs.writeFileSync(sessionFile(s.session_id), JSON.stringify(s, null, 2));
}

function updateSession(sessionId: string, patch: Partial<TrainingSession>): TrainingSession {
  const s = readSession(sessionId);
  if (!s) throw new Error(`Session not found: ${sessionId}`);
  const updated = { ...s, ...patch };
  writeSession(updated);
  return updated;
}

export function listSessions(): TrainingSession[] {
  if (!fs.existsSync(TRAINING_ROOT)) return [];
  return fs.readdirSync(TRAINING_ROOT)
    .map(d => readSession(d))
    .filter((s): s is TrainingSession => s !== null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// ── Dep installation ──────────────────────────────────────────────────────────

const TRAINING_DEPS = [
  'peft>=0.10.0',
  'bitsandbytes>=0.43.0',
  'prodigyopt>=1.0',
  'torchvision',
  'Pillow',
  'safetensors>=0.4.0',
];

/**
 * Installs training-specific deps into the existing inference venv.
 * Idempotent — skips quickly if already installed.
 */
export async function ensureTrainingDeps(vendor: GpuVendor): Promise<void> {
  const pyBin = getPythonPath(vendor);
  if (!pyBin) throw new Error(`No Python venv for vendor '${vendor}'`);

  try {
    await execFileAsync(pyBin, ['-c', 'import peft, accelerate, safetensors; print("ok")'], { timeout: 15_000 });
    return;
  } catch { /* install needed */ }

  await execFileAsync(pyBin, [
    '-m', 'pip', 'install', '--quiet', ...TRAINING_DEPS,
  ], { timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 });
}

// ── Session creation ──────────────────────────────────────────────────────────

export async function createSession(opts: StartTrainingOptions): Promise<TrainingSession> {
  if (_activeProc) throw new Error('A training session is already active');

  const hw     = await detectHardware();
  const gpu    = hw.gpus[0];
  const vendor = gpu ? gpuToVendor(gpu) : 'cpu';
  const device = gpu
    ? (gpu.backend === 'cuda' ? 'cuda' : gpu.backend === 'metal' ? 'mps' : 'cpu')
    : 'cpu';

  // Resolve base model path from installed models
  const modelPath = _resolveModelPath(opts.baseModel);

  const dir = sessionDir(opts.sessionId);
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'output'), { recursive: true });

  const session: TrainingSession = {
    session_id:         opts.sessionId,
    status:             'pending',
    name:               opts.name,
    description:        opts.description,
    author:             opts.author,
    base_model:         opts.baseModel,
    category:           opts.category,
    trigger_word:       opts.triggerWord,
    tags:               opts.tags,
    rank:               opts.rank,
    recommended_weight: opts.recommendedWeight,
    password:           opts.password,
    add_license:        opts.addLicense,
    steps:              opts.steps,
    batch_size:         opts.batchSize  ?? 1,
    lr:                 opts.lr         ?? 1e-4,
    width:              opts.width      ?? 1024,
    height:             opts.height     ?? 1024,
    device,
    vendor,
    model_path:         modelPath,
    image_dir:          path.join(dir, 'raw'),
    caption_file:       path.join(dir, 'captions.json'),
    output_dir:         path.join(dir, 'output'),
    session_dir:        dir,
    current_step:       0,
    total_steps:        opts.steps,
    current_loss:       0,
    current_lr:         opts.lr ?? 1e-4,
    current_phase:      'pending',
    resume_from:        null,
    lora_path:          null,
    plugin_id:          null,
    error:              null,
    created_at:         new Date().toISOString(),
    started_at:         null,
    finished_at:        null,
  };

  writeSession(session);
  return session;
}

function _resolveModelPath(baseModel: PluginBaseModel): string {
  // Mirror PhobosLocalManager's directory layout:
  //   flux/chroma/kontext/flux2/z-image/qwen-image → IMAGE_FLUX_DIR() = image/flux/
  //   sdxl → IMAGE_SDXL_DIR() = image/sdxl/
  const searchDir = baseModel === 'sdxl' ? IMAGE_SDXL_DIR() : IMAGE_FLUX_DIR();

  const modelMap: Record<string, string[]> = {
    'flux-dev':    ['flux-dev', 'flux.1-dev', 'flux1-dev'],
    'flux-schnell':['flux-schnell', 'flux.1-schnell', 'flux1-schnell'],
    'chroma':      ['chroma'],
    'sdxl':        ['sdxl', 'sd_xl'],
    'flux2-klein': ['flux2-klein', 'klein'],
  };

  const patterns = modelMap[baseModel] ?? [];
  try {
    if (!fs.existsSync(searchDir)) return '';
    const files = fs.readdirSync(searchDir);
    for (const pat of patterns) {
      const match = files.find(f =>
        f.toLowerCase().includes(pat) &&
        (f.endsWith('.gguf') || f.endsWith('.safetensors'))
      );
      if (match) return path.join(searchDir, match);
    }
  } catch { /* ignore */ }
  return '';
}

// ── VRAM estimation ───────────────────────────────────────────────────────────

/**
 * Rough minimum VRAM needed to train a LoRA for the given base model + rank.
 * Transformer weights (Q4) + optimizer states (AdamW8bit ~2×weights) + activations.
 * These are conservative lower bounds — actual usage is higher with full text encoders.
 * The trainer skips text encoders to save VRAM, so these are the observed minimums.
 */
export function estimateTrainingVramGb(baseModel: PluginBaseModel, rank: number): number {
  const base: Record<string, number> = {
    'flux-dev':     9.5,
    'flux-schnell': 9.5,
    'flux2-klein':  6.5,
    'chroma':       9.0,
    'sdxl':         5.5,
    '*':            6.0,
  };
  const baseGb   = base[baseModel] ?? 6.0;
  // Each rank unit adds ~0.02 GB for optimizer states (empirical)
  const rankCost = Math.max(0, rank - 16) * 0.02;
  return parseFloat((baseGb + rankCost).toFixed(1));
}

// ── Checkpoint scanning ───────────────────────────────────────────────────────

/**
 * Scans the session output dir for accelerate checkpoint dirs (checkpoint-N).
 * Returns the path to the highest-step checkpoint, or null if none exist.
 */
export function resolveLatestCheckpoint(sessionId: string): string | null {
  const outputDir = path.join(sessionDir(sessionId), 'output');
  if (!fs.existsSync(outputDir)) return null;
  let bestStep = -1;
  let bestPath: string | null = null;
  try {
    for (const entry of fs.readdirSync(outputDir)) {
      const m = entry.match(/^checkpoint-(\d+)$/);
      if (!m) continue;
      const ckptPath = path.join(outputDir, entry);
      if (!fs.statSync(ckptPath).isDirectory()) continue;
      const step = parseInt(m[1], 10);
      if (step > bestStep) { bestStep = step; bestPath = ckptPath; }
    }
  } catch { /* ignore */ }
  return bestPath;
}

// ── Run training (full pipeline) ──────────────────────────────────────────────

/**
 * Runs the full training pipeline: dep install → caption → train → package.
 * Yields TrainingProgress events consumed by the SSE endpoint in trainingRoutes.ts.
 * The caller owns writing to the SSE stream.
 */
export async function* runTraining(
  sessionId: string,
  pluginStore: import('../db/PluginStore.js').PluginStore,
): AsyncGenerator<TrainingProgress> {
  if (_activeProc) {
    const s = readSession(sessionId)!;
    yield { type: 'error', session: s, message: 'Another training session is active' };
    return;
  }

  let session = readSession(sessionId);
  if (!session) {
    // Minimal stub for error emit
    yield { type: 'error', session: { session_id: sessionId } as TrainingSession, message: 'Session not found' };
    return;
  }

  _activeSessionId = sessionId;

  // ── Auto-resume: populate resume_from from latest checkpoint if unset ──────
  if (!session.resume_from) {
    const latestCkpt = resolveLatestCheckpoint(sessionId);
    if (latestCkpt) {
      session = updateSession(sessionId, { resume_from: latestCkpt });
    }
  }

  // ── Phase: install deps ────────────────────────────────────────────────────
  session = updateSession(sessionId, { status: 'installing', started_at: new Date().toISOString(), current_phase: 'Installing training dependencies' });
  yield { type: 'installing', session };

  try {
    await ensureTrainingDeps(session.vendor);
  } catch (e) {
    session = updateSession(sessionId, { status: 'error', error: (e as Error).message, finished_at: new Date().toISOString() });
    yield { type: 'error', session, message: session.error! };
    _activeSessionId = null;
    return;
  }

  // ── Phase: caption ─────────────────────────────────────────────────────────
  session = updateSession(sessionId, { status: 'captioning', current_phase: 'Captioning images' });
  yield { type: 'phase', session };

  // Check if captions already exist (resume path)
  if (!fs.existsSync(session.caption_file)) {
    const { caption } = await import('./CaptionProcessor.js');
    for await (const ev of caption({
      imageDir:    session.image_dir,
      outputFile:  session.caption_file,
      triggerWord: session.trigger_word,
      device:      session.device,
      vendor:      session.vendor,
    })) {
      if (ev.type === 'error') {
        session = updateSession(sessionId, { status: 'error', error: ev.message, finished_at: new Date().toISOString() });
        yield { type: 'error', session, message: ev.message };
        _activeSessionId = null;
        return;
      }
      if (ev.type === 'done') break;
      // Other events (progress, caption) — just keep session updated
    }
  }

  // Check image count
  const imageCount = _countImages(session.image_dir);
  if (imageCount < 1) {
    session = updateSession(sessionId, { status: 'error', error: 'No images found in training directory', finished_at: new Date().toISOString() });
    yield { type: 'error', session, message: session.error! };
    _activeSessionId = null;
    return;
  }

  // ── Phase: train ───────────────────────────────────────────────────────────
  session = updateSession(sessionId, { status: 'training', current_phase: 'Starting trainer' });
  yield { type: 'phase', session };

  const scriptPath = path.resolve(path.dirname(TRAINER_SCRIPT), 'phobos-trainer.py');
  const pyBin      = getPythonPath(session.vendor);

  if (!pyBin || !fs.existsSync(scriptPath)) {
    session = updateSession(sessionId, { status: 'error', error: 'Python or trainer script not found', finished_at: new Date().toISOString() });
    yield { type: 'error', session, message: session.error! };
    _activeSessionId = null;
    return;
  }

  // Write session.json that phobos-trainer.py reads
  writeSession(session);

  const proc = spawn(pyBin, [scriptPath, '--session-file', sessionFile(sessionId)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  _activeProc = proc;

  let lineBuf = '';
  let errBuf  = '';
  let closed  = false;
  const lines: string[] = [];

  proc.stdout.on('data', (chunk: Buffer) => {
    const parts = (lineBuf + chunk.toString()).split('\n');
    lineBuf     = parts.pop() ?? '';
    for (const l of parts) if (l.trim()) lines.push(l.trim());
  });
  proc.stderr.on('data', (c: Buffer) => { errBuf += c.toString(); });
  proc.on('close', () => { closed = true; });

  while (!closed || lines.length > 0) {
    if (lines.length === 0) { await _sleep(50); continue; }

    const line = lines.shift()!;

    if (line.startsWith('STEP ')) {
      // STEP N/TOTAL loss=X lr=X
      const stepMatch = line.match(/STEP (\d+)\/(\d+) loss=([\d.]+) lr=([\d.e+\-]+)/);
      if (stepMatch) {
        const [, cur, tot, loss, lr] = stepMatch;
        session = updateSession(sessionId, {
          current_step: Number(cur),
          total_steps:  Number(tot),
          current_loss: Number(loss),
          current_lr:   Number(lr),
          current_phase: `Training step ${cur}/${tot}`,
        });
        yield { type: 'step', session };
      }

    } else if (line.startsWith('PHASE ')) {
      const phase = line.slice(6);
      session = updateSession(sessionId, { current_phase: phase });
      yield { type: 'phase', session };

    } else if (line.startsWith('DONE ')) {
      const loraPath = line.slice(5).trim();
      session = updateSession(sessionId, { lora_path: loraPath, current_phase: 'Training complete — packaging' });
      yield { type: 'phase', session };
      break;

    } else if (line.startsWith('ERROR ')) {
      const msg = line.slice(6);
      session = updateSession(sessionId, { status: 'error', error: msg, finished_at: new Date().toISOString() });
      yield { type: 'error', session, message: msg };
      proc.kill('SIGTERM');
      _activeProc      = null;
      _activeSessionId = null;
      return;
    }
  }

  _activeProc = null;

  // ── Check for abort ────────────────────────────────────────────────────────
  const fresh = readSession(sessionId)!;
  if (fresh.status === 'aborted') {
    _activeSessionId = null;
    yield { type: 'status', session: fresh };
    return;
  }

  if (!fresh.lora_path || !fs.existsSync(fresh.lora_path)) {
    const tail = errBuf.trim().split('\n').slice(-5).join(' ');
    session = updateSession(sessionId, { status: 'error', error: tail || 'Trainer exited without output', finished_at: new Date().toISOString() });
    yield { type: 'error', session, message: session.error! };
    _activeSessionId = null;
    return;
  }

  session = fresh;

  // ── Phase: package ─────────────────────────────────────────────────────────
  session = updateSession(sessionId, { status: 'packaging', current_phase: 'Packaging .phobos archive' });
  yield { type: 'phase', session };

  try {
    const record = await _packagePlugin(session, pluginStore);
    session = updateSession(sessionId, {
      status:      'done',
      plugin_id:   record.id,
      finished_at: new Date().toISOString(),
      current_phase: 'Complete',
    });
    yield { type: 'done', session };
  } catch (e) {
    session = updateSession(sessionId, { status: 'error', error: (e as Error).message, finished_at: new Date().toISOString() });
    yield { type: 'error', session, message: session.error! };
  }

  _activeSessionId = null;
}

// ── Abort ─────────────────────────────────────────────────────────────────────

export function abortTraining(sessionId: string): void {
  if (_activeSessionId !== sessionId) return;
  if (_activeProc) {
    _activeProc.kill('SIGTERM');
    setTimeout(() => { _activeProc?.kill('SIGKILL'); }, 3000);
    _activeProc = null;
  }
  updateSession(sessionId, { status: 'aborted', finished_at: new Date().toISOString() });
  _activeSessionId = null;
}

// ── Packaging ─────────────────────────────────────────────────────────────────

async function _packagePlugin(
  session: TrainingSession,
  pluginStore: import('../db/PluginStore.js').PluginStore,
): Promise<import('../phobos/PluginTypes.js').PluginRecord> {
  const manifest: import('../phobos/PluginTypes.js').PluginManifest = {
    schemaVersion:     1,
    id:                `${_slugify(session.name)}_${Date.now()}`,
    name:              session.name,
    author:            session.author || 'local',
    version:           '1.0.0',
    description:       session.description,
    baseModel:         session.base_model,
    compatibleModels:  [session.base_model],
    triggerWords:      session.trigger_word ? [session.trigger_word] : [],
    category:          session.category,
    tags:              session.tags,
    recommendedWeight: session.recommended_weight,
    weightRange:       [0.1, 1.0],
    rank:              session.rank,
    trainingImages:    _countImages(session.image_dir),
    trainingSteps:     session.current_step,
    createdAt:         new Date().toISOString(),
  };

  // Collect preview images from output dir (generated separately, or skip)
  const previewDir   = path.join(session.output_dir, 'previews');
  const previewPaths = fs.existsSync(previewDir)
    ? fs.readdirSync(previewDir)
        .filter(f => /\.(png|jpg|webp)$/i.test(f))
        .slice(0, 8)
        .map(f => path.join(previewDir, f))
    : [];

  return pluginStore.createPlugin(
    session.lora_path!,
    manifest,
    previewPaths,
    session.password,
    session.add_license,
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _countImages(dir: string): number {
  const EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tiff', '.bmp']);
  try {
    return fs.readdirSync(dir).filter(f => EXTS.has(path.extname(f).toLowerCase())).length;
  } catch { return 0; }
}

function _slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
}

function _sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}