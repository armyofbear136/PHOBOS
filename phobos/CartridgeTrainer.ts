/**
 * CartridgeTrainer.ts — Manages phobos-lm-trainer.py subprocess lifecycle.
 *
 * Responsibilities:
 *   - Install cartridge training deps (unsloth, llama.cpp converter) via
 *     ensureCartridgeDeps() — additive on top of the existing inference venv
 *   - Write/read session.json in the cartridge training session directory
 *   - Spawn phobos-lm-trainer.py, parse its stdout progress lines
 *   - Support abort (SIGTERM) and resume (resume_from checkpoint)
 *   - Package trained lora.safetensors + lora.gguf into a signed .cartridge
 *     archive via CartridgeStore.createCartridge()
 *
 * Training cache (HF safetensors base models) lives at:
 *   ~/.phobos/cartridge-training-cache/<trainingHfId>/
 * User owns deletion of this directory — surfaced in CartridgesPanel UI.
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
  ensureCartridgeDeps,
  type GpuVendor,
} from './PythonEnvManager.js';
import { detectHardware } from './PhobosLocalManager.js';
import { getSpec }        from './PhobosLocalManager.js';
import type { CartridgeCategory, CartridgePersona, CartridgeLicense } from './CartridgeTypes.js';
import { PHOBOS_DEFAULT_CART_PASSWORD } from './CartridgeTypes.js';

const execFileAsync = promisify(execFile);

// ── Paths ─────────────────────────────────────────────────────────────────────

const TRAINING_ROOT  = path.join(os.homedir(), '.phobos', 'cartridge-training');
const TRAINING_CACHE = path.join(os.homedir(), '.phobos', 'cartridge-training-cache');
// __filename is available in CJS (esbuild SEA build); fall back to cwd for tsx dev runs.
const TRAINER_SCRIPT = path.join(
  path.dirname(typeof __filename !== 'undefined' ? __filename : path.join(process.cwd(), 'x')),
  'phobos-lm-trainer.py',
);

// ── Types ─────────────────────────────────────────────────────────────────────

export type LmTrainingStatus =
  | 'pending'      // session created, not yet started
  | 'installing'   // installing unsloth + converter deps
  | 'preprocessing'// dataset preprocessing (chunking, pair extraction)
  | 'training'     // phobos-lm-trainer.py active
  | 'converting'   // converting lora.safetensors → lora.gguf
  | 'packaging'    // assembling .cartridge archive
  | 'done'         // complete — cartridgeId set
  | 'error'        // terminal failure
  | 'aborted';     // user-aborted

export type LmDataMode = 'document' | 'conversation' | 'mixed';

export interface LmTrainingSession {
  session_id:      string;
  status:          LmTrainingStatus;
  // Cartridge metadata
  name:            string;
  description:     string;
  author:          string;
  base_model_id:   string;   // GGUFSpec.modelId  e.g. 'qwen3.5-9b-q4'
  training_hf_id:  string;   // HF repo used for training  e.g. 'Qwen/Qwen3.5-9B-Instruct'
  target_persona:  CartridgePersona;
  category:        CartridgeCategory;
  tags:            string[];
  behavior_summary:string;
  trigger_context: string | null;
  license:         CartridgeLicense;
  password:        string;   // stored in session only; never logged
  add_license:     boolean;
  // Training config
  data_mode:       LmDataMode;
  rank:            number;
  steps:           number;
  lr:              number;
  device:          string;
  vendor:          GpuVendor;
  mixed_precision: 'bf16' | 'fp16';
  // Paths
  dataset_dir:     string;
  output_dir:      string;
  session_dir:     string;
  cache_dir:       string;   // ~/.phobos/cartridge-training-cache/<training_hf_id>/
  // Progress
  current_step:    number;
  total_steps:     number;
  current_loss:    number;
  current_phase:   string;
  resume_from:     string | null;
  // Result
  safetensors_path:string | null;
  gguf_path:       string | null;
  cartridge_id:    string | null;
  error:           string | null;
  // Timestamps
  created_at:      string;
  started_at:      string | null;
  finished_at:     string | null;
}

export interface LmTrainingProgress {
  type:    'status' | 'step' | 'phase' | 'done' | 'error' | 'installing';
  session: LmTrainingSession;
  message?: string;
}

export interface StartLmTrainingOptions {
  sessionId:      string;
  name:           string;
  description:    string;
  author:         string;
  baseModelId:    string;
  targetPersona:  CartridgePersona;
  category:       CartridgeCategory;
  tags:           string[];
  behaviorSummary:string;
  triggerContext: string | null;
  license:        CartridgeLicense;
  password:       string;
  addLicense:     boolean;
  dataMode:       LmDataMode;
  rank?:          number;
  steps?:         number;
  lr?:            number;
}

// ── Module-level state ────────────────────────────────────────────────────────

let _activeProc:      ChildProcess | null = null;
let _activeSessionId: string | null       = null;

export function isLmTraining(): boolean          { return _activeProc !== null; }
export function activeLmSessionId(): string | null { return _activeSessionId; }

// ── Session disk I/O ──────────────────────────────────────────────────────────

function sessionDir(sessionId: string): string {
  return path.join(TRAINING_ROOT, sessionId);
}

function sessionFile(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'session.json');
}

export function readLmSession(sessionId: string): LmTrainingSession | null {
  const f = sessionFile(sessionId);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf-8')) as LmTrainingSession; }
  catch { return null; }
}

function writeSession(s: LmTrainingSession): void {
  fs.mkdirSync(sessionDir(s.session_id), { recursive: true });
  fs.writeFileSync(sessionFile(s.session_id), JSON.stringify(s, null, 2));
}

function updateSession(
  sessionId: string,
  patch: Partial<LmTrainingSession>,
): LmTrainingSession {
  const s = readLmSession(sessionId);
  if (!s) throw new Error(`LM training session not found: ${sessionId}`);
  const updated = { ...s, ...patch };
  writeSession(updated);
  return updated;
}

export function listLmSessions(): LmTrainingSession[] {
  if (!fs.existsSync(TRAINING_ROOT)) return [];
  return fs.readdirSync(TRAINING_ROOT)
    .map(d => readLmSession(d))
    .filter((s): s is LmTrainingSession => s !== null)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// ── Training cache helpers ────────────────────────────────────────────────────

/**
 * Returns the local cache directory for a given HF model ID.
 * The trainer sets HF_HOME to TRAINING_CACHE so unsloth's snapshot_download
 * lands here rather than the default ~/.cache/huggingface.
 */
export function trainingCacheDir(trainingHfId: string): string {
  // HF stores models at <HF_HOME>/hub/models--<org>--<name>/
  const slug = trainingHfId.replace('/', '--');
  return path.join(TRAINING_CACHE, 'hub', `models--${slug}`);
}

/** Approximate size in bytes of all files under the training cache. */
export function trainingCacheSizeBytes(): number {
  return _dirSizeBytes(TRAINING_CACHE);
}

/** Deletes specified model cache dirs. Pass null to delete the entire cache. */
export function deleteTrainingCache(trainingHfIds: string[] | null): void {
  if (!fs.existsSync(TRAINING_CACHE)) return;
  if (trainingHfIds === null) {
    fs.rmSync(TRAINING_CACHE, { recursive: true, force: true });
    return;
  }
  for (const hfId of trainingHfIds) {
    const slug = hfId.replace('/', '--');
    const dir  = path.join(TRAINING_CACHE, 'hub', `models--${slug}`);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Steps formula ─────────────────────────────────────────────────────────────

/**
 * Computes recommended training steps from dataset size.
 * Matches the formula in the cartridge spec §4.3.
 */
export function recommendSteps(datasetPairs: number, rank: number): number {
  const repeats          = Math.max(1, Math.floor(500 / datasetPairs));
  const targetEpochSteps = rank <= 16 ? 80 : 120;
  const raw              = datasetPairs * repeats * targetEpochSteps;
  return Math.max(500, Math.min(8000, raw));
}

/**
 * Rough minimum VRAM needed to train at rank 16 with 4-bit quantized base.
 * Based on unsloth's measured footprint for each model family.
 */
export function estimateLmTrainingVramGb(baseModelId: string, rank: number): number {
  const spec = getSpec(baseModelId);
  if (!spec) return 8.0;

  // Approximate: 4-bit base + LoRA optimizer states (~2× LoRA params) + activations
  const base: Record<string, number> = {
    'qwen3.5-2b-q4':  4.0,
    'gemma4-e4b-q4':  5.0,
    'qwen3.5-4b-q4':  5.5,
    'gemma3-4b-q4':   5.5,
    'llama3.2-3b-q4': 5.0,
    'llama3.1-8b-q4': 8.0,
    'deepseek-r1-8b-q4': 8.0,
    'nemotron3-9b-q4':   8.0,
    'qwen3.5-9b-q4':  9.0,
    'gemma3-12b-q4':  11.0,
    'deepseek-r1-14b-q4': 12.0,
    'qwen3.5-27b-q4': 18.0,
    'gemma4-26b-a4b-q4': 18.0,
  };
  const baseGb   = base[baseModelId] ?? (spec.activeParamsB * 0.8 + 3.0);
  const rankCost = Math.max(0, rank - 16) * 0.03;
  return parseFloat((baseGb + rankCost).toFixed(1));
}

// ── Session creation ──────────────────────────────────────────────────────────

export async function createLmSession(
  opts: StartLmTrainingOptions,
): Promise<LmTrainingSession> {
  if (_activeProc) throw new Error('An LM training session is already active');

  const spec = getSpec(opts.baseModelId);
  if (!spec) throw new Error(`Unknown base model: ${opts.baseModelId}`);

  const trainingHfId = (spec as GGUFSpec & { trainingHfId?: string }).trainingHfId;
  if (!trainingHfId) {
    throw new Error(
      `Model '${opts.baseModelId}' does not support cartridge training. ` +
      `Only dense models with a known HuggingFace training ID are supported.`,
    );
  }

  const hw     = await detectHardware();
  const gpu    = hw.gpus[0];
  const vendor = gpu ? gpuToVendor(gpu) : 'cpu';
  const device = gpu
    ? (gpu.backend === 'cuda' ? 'cuda:0' : gpu.backend === 'metal' ? 'mps' : 'cpu')
    : 'cpu';

  // bf16 requires Ampere+ (CUDA compute ≥8.0); fall back to fp16 otherwise
  const mixedPrecision: 'bf16' | 'fp16' =
    gpu?.backend === 'cuda' ? 'bf16' : 'fp16';

  const rank  = opts.rank  ?? 16;
  const steps = opts.steps ?? 0;  // 0 = auto-compute after preprocessing
  const lr    = opts.lr    ?? 2e-4;

  const dir = sessionDir(opts.sessionId);
  fs.mkdirSync(path.join(dir, 'dataset'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'output'),  { recursive: true });

  const session: LmTrainingSession = {
    session_id:       opts.sessionId,
    status:           'pending',
    name:             opts.name,
    description:      opts.description,
    author:           opts.author,
    base_model_id:    opts.baseModelId,
    training_hf_id:   trainingHfId,
    target_persona:   opts.targetPersona,
    category:         opts.category,
    tags:             opts.tags,
    behavior_summary: opts.behaviorSummary,
    trigger_context:  opts.triggerContext,
    license:          opts.license,
    password:         opts.password,
    add_license:      opts.addLicense,
    data_mode:        opts.dataMode,
    rank,
    steps,
    lr,
    device,
    vendor,
    mixed_precision:  mixedPrecision,
    dataset_dir:      path.join(dir, 'dataset'),
    output_dir:       path.join(dir, 'output'),
    session_dir:      dir,
    cache_dir:        path.join(TRAINING_CACHE, 'hub'),
    current_step:     0,
    total_steps:      steps,
    current_loss:     0,
    current_phase:    'pending',
    resume_from:      null,
    safetensors_path: null,
    gguf_path:        null,
    cartridge_id:     null,
    error:            null,
    created_at:       new Date().toISOString(),
    started_at:       null,
    finished_at:      null,
  };

  writeSession(session);
  return session;
}

// ── Checkpoint scanning ───────────────────────────────────────────────────────

export function resolveLatestLmCheckpoint(sessionId: string): string | null {
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
 * Full pipeline: dep install → train (includes HF download + preprocessing
 * inside the Python script) → package .cartridge archive.
 * Yields LmTrainingProgress events consumed by the SSE endpoint.
 */
export async function* runLmTraining(
  sessionId: string,
  cartridgeStore: import('../db/CartridgeStore.js').CartridgeStore,
): AsyncGenerator<LmTrainingProgress> {
  if (_activeProc) {
    const s = readLmSession(sessionId)!;
    yield { type: 'error', session: s, message: 'Another LM training session is active' };
    return;
  }

  let session = readLmSession(sessionId);
  if (!session) {
    yield {
      type: 'error',
      session: { session_id: sessionId } as LmTrainingSession,
      message: 'Session not found',
    };
    return;
  }

  _activeSessionId = sessionId;

  // ── Auto-resume: populate resume_from from latest checkpoint if unset ──────
  if (!session.resume_from) {
    const latestCkpt = resolveLatestLmCheckpoint(sessionId);
    if (latestCkpt) session = updateSession(sessionId, { resume_from: latestCkpt });
  }

  // ── Phase: install deps ────────────────────────────────────────────────────
  session = updateSession(sessionId, {
    status:        'installing',
    started_at:    new Date().toISOString(),
    current_phase: 'Installing unsloth and GGUF converter',
  });
  console.log(`[LM:${sessionId}] install: checking deps for vendor=${session.vendor}`);
  yield { type: 'installing', session };

  try {
    await ensureCartridgeDeps(session.vendor);
  } catch (e) {
    session = updateSession(sessionId, {
      status:      'error',
      error:       (e as Error).message,
      finished_at: new Date().toISOString(),
    });
    yield { type: 'error', session, message: session.error! };
    _activeSessionId = null;
    return;
  }

  // ── Phase: validate dataset ────────────────────────────────────────────────
  const datasetCount = _countDatasetFiles(session.dataset_dir, session.data_mode);
  if (session.data_mode === 'conversation' && datasetCount < 100) {
    const msg = `Conversation mode requires at least 100 turns (found ${datasetCount})`;
    session = updateSession(sessionId, {
      status: 'error', error: msg, finished_at: new Date().toISOString(),
    });
    yield { type: 'error', session, message: msg };
    _activeSessionId = null;
    return;
  }
  if (session.data_mode === 'document' && datasetCount < 50) {
    const msg = `Document mode requires at least 50 documents (found ${datasetCount})`;
    session = updateSession(sessionId, {
      status: 'error', error: msg, finished_at: new Date().toISOString(),
    });
    yield { type: 'error', session, message: msg };
    _activeSessionId = null;
    return;
  }

  // ── Phase: train ───────────────────────────────────────────────────────────
  session = updateSession(sessionId, {
    status:        'training',
    current_phase: 'Loading model and starting trainer',
  });
  yield { type: 'phase', session };

  const pyBin = getPythonPath(session.vendor);
  if (!pyBin || !fs.existsSync(TRAINER_SCRIPT)) {
    const msg = 'Python binary or phobos-lm-trainer.py not found';
    session = updateSession(sessionId, {
      status: 'error', error: msg, finished_at: new Date().toISOString(),
    });
    yield { type: 'error', session, message: msg };
    _activeSessionId = null;
    return;
  }

  writeSession(session);

  const env = {
    ...process.env,
    HF_HOME:                   TRAINING_CACHE,  // redirect HF cache to ~/.phobos/cartridge-training-cache
    HF_HUB_ENABLE_HF_TRANSFER: '0',             // disable hf_transfer — we want resumable standard downloads
    TOKENIZERS_PARALLELISM:    'false',
    PYTHONUTF8:                '1',             // force UTF-8 for all file I/O on Windows (trl jinja templates)
    UNSLOTH_CACHE_DIR:         path.join(os.homedir(), '.phobos', 'unsloth-cache'),
    LLAMA_CPP_DIR:             path.join(os.homedir(), '.phobos', 'llamacpp'),
  };

  console.log(`[LM:${sessionId}] start  : ${session.base_model_id}  rank=${session.rank}  steps=${session.steps || 'auto'}`);
  const proc = spawn(pyBin, [TRAINER_SCRIPT, '--session-file', sessionFile(sessionId)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
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
  proc.on('close', (_code: number | null) => { closed = true; });

  // ── Parse trainer stdout ───────────────────────────────────────────────────
  while (!closed || lines.length > 0) {
    if (lines.length === 0) { await _sleep(50); continue; }

    const line = lines.shift()!;

    if (line.startsWith('STEP ')) {
      // STEP N/TOTAL loss=X
      const m = line.match(/STEP (\d+)\/(\d+) loss=([\d.]+)/);
      if (m) {
        const [, cur, tot, loss] = m;
        // Auto-compute steps on first step if session.steps was 0
        const totalSteps = Number(tot);
        session = updateSession(sessionId, {
          current_step:  Number(cur),
          total_steps:   totalSteps,
          current_loss:  Number(loss),
          current_phase: `Training step ${cur}/${tot}`,
          steps:         totalSteps,
        });
        console.log(`[LM:${sessionId}] step   : ${cur}/${tot}  loss=${Number(loss).toFixed(4)}`);
        yield { type: 'step', session };
      }

    } else if (line.startsWith('PHASE ')) {
      const phase = line.slice(6);
      console.log(`[LM:${sessionId}] phase  : ${phase}`);
      const status: LmTrainingStatus =
        phase.startsWith('Converting') ? 'converting' : 'training';
      session = updateSession(sessionId, { current_phase: phase, status });
      yield { type: 'phase', session };

    } else if (line.startsWith('DONE ')) {
      // DONE <safetensors_path> <gguf_path>
      const parts   = line.slice(5).trim().split(' ');
      const stPath  = parts[0];
      const ggufPath = parts[1] ?? null;
      session = updateSession(sessionId, {
        safetensors_path: stPath,
        gguf_path:        ggufPath,
        current_phase:    'Training complete — packaging',
        status:           'packaging',
      });
      console.log(`[LM:${sessionId}] done   : safetensors=${stPath}  gguf=${ggufPath}`);
      yield { type: 'phase', session };
      break;

    } else if (line.startsWith('ERROR ')) {
      const msg = line.slice(6);
      console.error(`[LM:${sessionId}] error  : ${msg}`);
      session = updateSession(sessionId, {
        status: 'error', error: msg, finished_at: new Date().toISOString(),
      });
      yield { type: 'error', session, message: msg };
      proc.kill('SIGTERM');
      _activeProc      = null;
      _activeSessionId = null;
      return;
    }
  }

  _activeProc = null;

  // ── Check for abort ────────────────────────────────────────────────────────
  const fresh = readLmSession(sessionId)!;
  if (fresh.status === 'aborted') {
    _activeSessionId = null;
    yield { type: 'status', session: fresh };
    return;
  }

  if (!fresh.gguf_path || !fs.existsSync(fresh.gguf_path)) {
    const tail = errBuf.trim().split('\n').slice(-5).join(' ');
    if (tail) console.error(`[LM:${sessionId}] stderr : ${tail}`);
    session = updateSession(sessionId, {
      status:      'error',
      error:       tail || 'Trainer exited without producing lora.gguf',
      finished_at: new Date().toISOString(),
    });
    yield { type: 'error', session, message: session.error! };
    _activeSessionId = null;
    return;
  }

  session = fresh;

  // ── Phase: package ─────────────────────────────────────────────────────────
  session = updateSession(sessionId, {
    status: 'packaging', current_phase: 'Packaging .cartridge archive',
  });
  yield { type: 'phase', session };

  try {
    const record = await _packageCartridge(session, cartridgeStore);
    session = updateSession(sessionId, {
      status:       'done',
      cartridge_id: record.id,
      finished_at:  new Date().toISOString(),
      current_phase:'Complete',
    });
    yield { type: 'done', session };
  } catch (e) {
    session = updateSession(sessionId, {
      status:      'error',
      error:       (e as Error).message,
      finished_at: new Date().toISOString(),
    });
    yield { type: 'error', session, message: session.error! };
  }

  _activeSessionId = null;
}

// ── Abort ─────────────────────────────────────────────────────────────────────

export function abortLmTraining(sessionId: string): void {
  if (_activeSessionId !== sessionId) return;
  if (_activeProc) {
    _activeProc.kill('SIGTERM');
    setTimeout(() => { _activeProc?.kill('SIGKILL'); }, 3000);
    _activeProc = null;
  }
  updateSession(sessionId, {
    status: 'aborted', finished_at: new Date().toISOString(),
  });
  _activeSessionId = null;
}

// ── Packaging ─────────────────────────────────────────────────────────────────

async function _packageCartridge(
  session: LmTrainingSession,
  store: import('../db/CartridgeStore.js').CartridgeStore,
): Promise<import('./CartridgeTypes.js').CartridgeRecord> {
  const spec = getSpec(session.base_model_id);

  const manifest: import('./CartridgeTypes.js').CartridgeManifest = {
    schemaVersion:     1,
    id:                `${_slugify(session.name)}_${Date.now()}`,
    name:              session.name,
    author:            session.author || 'local',
    version:           '1.0.0',
    description:       session.description,
    baseModel:         spec?.family ?? session.base_model_id,
    compatibleModels:  ['*'],   // family-level match — uncensored variant or any size works
    targetPersona:     session.target_persona,
    rank:              session.rank,
    category:          session.category,
    tags:              session.tags,
    behaviorSummary:   session.behavior_summary,
    triggerContext:    session.trigger_context,
    trainingDocuments: _countDatasetFiles(session.dataset_dir, session.data_mode),
    trainingTurns:     session.data_mode !== 'document' ? _countConversationTurns(session.dataset_dir) : 0,
    trainingSteps:     session.current_step,
    recommendedWeight: 0.8,
    weightRange:       [0.3, 1.0],
    license:           session.license,
    createdAt:         new Date().toISOString(),
    halcyonId:         null,
  };

  // Collect sample interaction files if present
  const samplesDir   = path.join(session.output_dir, 'samples');
  const samplePaths  = fs.existsSync(samplesDir)
    ? fs.readdirSync(samplesDir)
        .filter(f => f.endsWith('.txt'))
        .slice(0, 6)
        .map(f => path.join(samplesDir, f))
    : [];

  return store.createCartridge(
    session.gguf_path!,
    manifest,
    samplePaths,
    session.password || PHOBOS_DEFAULT_CART_PASSWORD,
    session.add_license,
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const DOC_EXTS = new Set(['.md', '.txt', '.pdf', '.py', '.ts', '.js', '.json', '.html']);

function _countDatasetFiles(dir: string, mode: LmDataMode): number {
  if (!fs.existsSync(dir)) return 0;
  if (mode === 'conversation') {
    // Count lines in .jsonl files
    let turns = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const lines = fs.readFileSync(path.join(dir, f), 'utf-8')
          .split('\n').filter(l => l.trim());
        turns += lines.length;
      } catch { /* ignore */ }
    }
    return turns;
  }
  // document or mixed — count source files
  return fs.readdirSync(dir).filter(f => DOC_EXTS.has(path.extname(f).toLowerCase())).length;
}

function _countConversationTurns(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let turns = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    try {
      turns += fs.readFileSync(path.join(dir, f), 'utf-8')
        .split('\n').filter(l => l.trim()).length;
    } catch { /* ignore */ }
  }
  return turns;
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

function _slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '').slice(0, 40);
}

function _sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Re-export GGUFSpec type for internal use ──────────────────────────────────
// CartridgeTrainer needs to access trainingHfId which is added to GGUFSpec
// in the same PhobosLocalManager session.
import type { GGUFSpec } from './PhobosLocalManager.js';