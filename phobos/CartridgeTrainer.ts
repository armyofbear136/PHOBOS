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
 *
 * Server stop/restart pattern mirrors workflows.ts exactly:
 *   1. snapshotAllServersOnDevice(targetDeviceIndex) — record what's running
 *   2. stopServer(role) per snapshot — only stop servers on the training GPU
 *   3. VRAM settle poll — queryGpuFreeVram() every 500 ms until stable (max 5 s)
 *   4. Pre-flight VRAM log — report free vs required VRAM
 *   5. Spawn phobos-lm-trainer.py
 *   6. On process exit: 3 s PyTorch settle, then startServer per snapshot
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
import { detectHardware, queryGpuFreeVram } from './PhobosLocalManager.js';
import { stopServer, startServer } from './LlamaServerManager.js';
import { snapshotAllServersOnDevice } from './ImageGenerationHandler.js';
import { getSpec } from './PhobosLocalManager.js';
import type { CartridgeCategory, CartridgePersona, CartridgeLicense } from './CartridgeTypes.js';
import { PHOBOS_DEFAULT_CART_PASSWORD } from './CartridgeTypes.js';

const execFileAsync = promisify(execFile);

// ── Paths ─────────────────────────────────────────────────────────────────────

const TRAINING_ROOT  = path.join(os.homedir(), '.phobos', 'cartridge-training');
const TRAINING_CACHE = path.join(os.homedir(), '.phobos', 'cartridge-training-cache');

function _resolveTrainerScript(): string {
  const candidates: string[] = [];
  if (typeof __filename !== 'undefined') {
    candidates.push(path.join(path.dirname(__filename), 'phobos-lm-trainer.py'));
  }
  candidates.push(path.join(process.cwd(), 'dist', 'phobos-lm-trainer.py'));
  candidates.push(path.join(path.dirname(process.execPath), 'phobos-lm-trainer.py'));
  if (process.env['PHOBOS_BIN_DIR']) {
    candidates.unshift(path.join(process.env['PHOBOS_BIN_DIR'], 'phobos-lm-trainer.py'));
  }
  return candidates.find(c => fs.existsSync(c)) ?? candidates[0];
}
const TRAINER_SCRIPT = _resolveTrainerScript();

// ── Types ─────────────────────────────────────────────────────────────────────

export type LmTrainingStatus =
  | 'pending'
  | 'installing'
  | 'preprocessing'
  | 'training'
  | 'converting'
  | 'packaging'
  | 'done'
  | 'error'
  | 'aborted';

export type LmDataMode = 'document' | 'conversation' | 'mixed';

export interface LmTrainingSession {
  session_id:       string;
  status:           LmTrainingStatus;
  name:             string;
  description:      string;
  author:           string;
  base_model_id:    string;
  training_hf_id:   string;
  target_persona:   CartridgePersona;
  category:         CartridgeCategory;
  tags:             string[];
  behavior_summary: string;
  trigger_context:  string | null;
  license:          CartridgeLicense;
  password:         string;
  add_license:      boolean;
  data_mode:        LmDataMode;
  rank:             number;
  steps:            number;
  lr:               number;
  device:           string;
  vendor:           GpuVendor;
  mixed_precision:  'bf16' | 'fp16';
  dataset_dir:      string;
  output_dir:       string;
  session_dir:      string;
  cache_dir:        string;
  current_step:     number;
  total_steps:      number;
  current_loss:     number;
  current_phase:    string;
  resume_from:      string | null;
  safetensors_path: string | null;
  gguf_path:        string | null;
  cartridge_id:     string | null;
  error:            string | null;
  created_at:       string;
  started_at:       string | null;
  finished_at:      string | null;
}

export interface StartLmTrainingOptions {
  sessionId:       string;
  name:            string;
  description:     string;
  author:          string;
  baseModelId:     string;
  targetPersona:   CartridgePersona;
  category:        CartridgeCategory;
  tags:            string[];
  behaviorSummary: string;
  triggerContext:  string | null;
  license:         CartridgeLicense;
  password:        string;
  addLicense:      boolean;
  dataMode:        LmDataMode;
  rank?:           number;
  steps?:          number;
  lr?:             number;
}

// ── Module-level state ────────────────────────────────────────────────────────

let _activeProc:      ChildProcess | null = null;
let _activeSessionId: string | null       = null;

export function isLmTraining(): boolean            { return _activeProc !== null || _activeSessionId !== null; }
export function activeLmSessionId(): string | null { return _activeSessionId; }

// ── In-memory run status (polled by GET /run-status — no SSE) ────────────────

export interface LmRunStatus {
  training:    boolean;
  sessionId:   string | null;
  session:     LmTrainingSession | null;
  completedAt: number | null;
}

let _lmRunStatus: LmRunStatus = {
  training:    false,
  sessionId:   null,
  session:     null,
  completedAt: null,
};

export function getLmTrainingStatus(): LmRunStatus { return _lmRunStatus; }

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

export function updateSession(
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

export function trainingCacheDir(trainingHfId: string): string {
  const slug = trainingHfId.replace('/', '--');
  return path.join(TRAINING_CACHE, 'hub', `models--${slug}`);
}

export function trainingCacheSizeBytes(): number {
  return _dirSizeBytes(TRAINING_CACHE);
}

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

export function recommendSteps(datasetPairs: number, rank: number): number {
  const repeats          = Math.max(1, Math.floor(500 / datasetPairs));
  const targetEpochSteps = rank <= 16 ? 80 : 120;
  const raw              = datasetPairs * repeats * targetEpochSteps;
  return Math.max(500, Math.min(8000, raw));
}

export function estimateLmTrainingVramGb(baseModelId: string, rank: number): number {
  const spec = getSpec(baseModelId);
  if (!spec) return 8.0;

  const base: Record<string, number> = {
    'qwen3.5-2b-q4':      4.0,
    'gemma4-e4b-q4':      5.0,
    'qwen3.5-4b-q4':      5.5,
    'gemma3-4b-q4':       5.5,
    'llama3.2-3b-q4':     5.0,
    'llama3.1-8b-q4':     8.0,
    'deepseek-r1-8b-q4':  8.0,
    'nemotron3-9b-q4':    8.0,
    'qwen3.5-9b-q4':      9.0,
    'gemma3-12b-q4':      11.0,
    'deepseek-r1-14b-q4': 12.0,
    'qwen3.5-27b-q4':     18.0,
    'gemma4-26b-a4b-q4':  18.0,
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

  const mixedPrecision: 'bf16' | 'fp16' =
    gpu?.backend === 'cuda' ? 'bf16' : 'fp16';

  const rank  = opts.rank  ?? 16;
  const steps = opts.steps ?? 0;
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

// ── startLmTraining — fire-and-forget background pipeline ────────────────────
//
// Returns { ok: true } immediately. All work runs in a background IIFE.
// Progress is written to _lmRunStatus; GET /run-status polls it.
// No SSE stream — connection lifecycle cannot affect training.

export function startLmTraining(
  sessionId: string,
  cartridgeStore: import('../db/CartridgeStore.js').CartridgeStore,
): { ok: true } | { ok: false; error: string } {
  if (_activeProc || _activeSessionId) {
    return { ok: false, error: 'Another LM training session is active' };
  }

  let session = readLmSession(sessionId);
  if (!session) return { ok: false, error: 'Session not found' };

  // Arm status before going async — first poll always sees training=true
  _activeSessionId = sessionId;
  _lmRunStatus = { training: true, sessionId, session, completedAt: null };

  (async () => {
    // Snapshot captured before stop — used to restart servers identically after
    // training completes. Mirrors: snaps = snapshotAllServersOnDevice(targetDevice)
    let snaps: ReturnType<typeof snapshotAllServersOnDevice> = [];

    const _finish = (s: LmTrainingSession) => {
      _lmRunStatus = { training: false, sessionId, session: s, completedAt: Date.now() };
      _activeSessionId = null;
    };

    try {
      // ── Auto-resume ──────────────────────────────────────────────────────
      if (!session!.resume_from) {
        const ckpt = resolveLatestLmCheckpoint(sessionId);
        if (ckpt) session = updateSession(sessionId, { resume_from: ckpt });
      }

      // ── Phase: install deps ──────────────────────────────────────────────
      session = updateSession(sessionId, {
        status:        'installing',
        started_at:    new Date().toISOString(),
        current_phase: 'Installing unsloth and GGUF converter',
      });
      _lmRunStatus.session = session;

      // ── Detect training device ───────────────────────────────────────────
      // Training targets the first CUDA GPU (device 0).
      // On mixed CUDA+Vulkan machines, CUDA is always device 0.
      const hw       = await detectHardware();
      const trainGpu = hw.gpus.find(g => g.backend === 'cuda') ?? hw.gpus[0];
      const deviceIdx = trainGpu?.index;   // undefined = CPU-only path

      // ── Stop only servers on the training GPU (mirrors workflows.ts) ─────
      // snapshotAllServersOnDevice records exact role + config for restart.
      // We only stop servers on deviceIdx — not all servers.
      // On CPU-only paths deviceIdx is undefined; snapshot handles that case.
      snaps = snapshotAllServersOnDevice(deviceIdx);

      if (snaps.length > 0) {
        console.log(`[LM:${sessionId}] unload : stopping ${snaps.map(s => s.role).join(' + ')} for CUDA training`);
        for (const snap of snaps) {
          try { await stopServer(snap.role); } catch { /* already stopped — non-fatal */ }
        }
      }

      // ── VRAM settle poll (mirrors workflows.ts exactly) ──────────────────
      // Poll queryGpuFreeVram() every 500 ms until free VRAM stops rising.
      // This waits for the driver to finish reclaiming pages from the
      // stopped llama-server processes before Python tries to allocate.
      // Max wait: 5 s. Skipped on CPU-only paths.
      const isDiscreteGpu = trainGpu && (trainGpu.backend === 'cuda' || trainGpu.backend === 'vulkan');
      let lastFreeMb = 0;

      if (isDiscreteGpu && trainGpu) {
        const SETTLE_POLL_MS = 500;
        const SETTLE_MAX_MS  = 5000;
        const SETTLE_START   = Date.now();

        while (true) {
          await _sleep(SETTLE_POLL_MS);
          const freeMb  = await queryGpuFreeVram(trainGpu) ?? 0;
          const elapsed = Date.now() - SETTLE_START;
          // Stable = VRAM has been released (freeMb > 0) and stopped rising.
          // When freeMb is still 0 the driver hasn't reclaimed yet — keep polling.
          const stable  = freeMb > 0 && freeMb <= lastFreeMb;
          lastFreeMb    = freeMb;
          if (stable || elapsed >= SETTLE_MAX_MS) break;
        }

        // ── Pre-flight VRAM log ────────────────────────────────────────────
        const freeGb     = lastFreeMb / 1024;
        const requiredGb = estimateLmTrainingVramGb(session!.base_model_id, session!.rank);
        const reqMb      = Math.round(requiredGb * 1024);
        const totalMb    = Math.round((trainGpu.vramGb ?? 0) * 1024);
        console.log(`[LM:${sessionId}] vram   : need ~${reqMb} MB  free ${lastFreeMb} MB  total ${totalMb} MB`);
        if (freeGb < requiredGb) {
          console.warn(`[LM:${sessionId}] vram   : ⚠ need ${requiredGb} GB, have ${freeGb.toFixed(1)} GB free — training may OOM`);
        }
      }

      console.log(`[LM:${sessionId}] install: checking deps for vendor=${session!.vendor}`);

      try {
        await ensureCartridgeDeps(session!.vendor);
      } catch (e) {
        session = updateSession(sessionId, {
          status: 'error', error: (e as Error).message, finished_at: new Date().toISOString(),
        });
        _finish(session);
        // Dep install failed before Python ran — no VRAM held, no settle needed
        await _restartServers(snaps, false);
        return;
      }

      // ── Phase: validate dataset ──────────────────────────────────────────
      const datasetCount = _countDatasetFiles(session!.dataset_dir, session!.data_mode);
      if (session!.data_mode === 'conversation' && datasetCount < 100) {
        const msg = `Conversation mode requires at least 100 turns (found ${datasetCount})`;
        session = updateSession(sessionId, { status: 'error', error: msg, finished_at: new Date().toISOString() });
        _finish(session);
        await _restartServers(snaps, false);
        return;
      }
      if (session!.data_mode === 'document' && datasetCount < 50) {
        const msg = `Document mode requires at least 50 documents (found ${datasetCount})`;
        session = updateSession(sessionId, { status: 'error', error: msg, finished_at: new Date().toISOString() });
        _finish(session);
        await _restartServers(snaps, false);
        return;
      }

      // ── Phase: train ─────────────────────────────────────────────────────
      session = updateSession(sessionId, {
        status: 'training', current_phase: 'Loading model and starting trainer',
      });
      _lmRunStatus.session = session;

      const pyBin = getPythonPath(session!.vendor);
      if (!pyBin || !fs.existsSync(TRAINER_SCRIPT)) {
        const msg = 'Python binary or phobos-lm-trainer.py not found';
        session = updateSession(sessionId, { status: 'error', error: msg, finished_at: new Date().toISOString() });
        _finish(session);
        await _restartServers(snaps, false);
        return;
      }

      writeSession(session!);

      const env = {
        ...process.env,
        HF_HOME:                   TRAINING_CACHE,
        HF_HUB_ENABLE_HF_TRANSFER: '0',
        TOKENIZERS_PARALLELISM:    'false',
        PYTHONUTF8:                '1',
        UNSLOTH_CACHE_DIR:         path.join(os.homedir(), '.phobos', 'unsloth-cache'),
        LLAMA_CPP_DIR:             path.join(os.homedir(), '.phobos', 'llamacpp'),
      };

      console.log(`[LM:${sessionId}] start  : ${session!.base_model_id}  rank=${session!.rank}  steps=${session!.steps || 'auto'}`);
      const proc = spawn(pyBin, [TRAINER_SCRIPT, '--session-file', sessionFile(sessionId)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
      _activeProc = proc;

      let lineBuf     = '';
      let errBuf      = '';
      let closed      = false;
      let trainingDone = false;
      const lines: string[] = [];

      proc.stdout.on('data', (chunk: Buffer) => {
        const parts = (lineBuf + chunk.toString()).split('\n');
        lineBuf     = parts.pop() ?? '';
        for (const l of parts) if (l.trim()) lines.push(l.trim());
      });
      proc.stderr.on('data', (c: Buffer) => { errBuf += c.toString(); });
      proc.on('close', () => { closed = true; });

      // ── Parse trainer stdout ─────────────────────────────────────────────
      while (!closed || lines.length > 0) {
        if (lines.length === 0) { await _sleep(50); continue; }

        const line = lines.shift()!;

        if (line.startsWith('STEP ')) {
          const m = line.match(/STEP (\d+)\/(\d+) loss=([\d.]+)/);
          if (m) {
            const [, cur, tot, loss] = m;
            const totalSteps = Number(tot);
            session = updateSession(sessionId, {
              current_step:  Number(cur),
              total_steps:   totalSteps,
              current_loss:  Number(loss),
              current_phase: `Training step ${cur}/${tot}`,
              steps:         totalSteps,
            });
            _lmRunStatus.session = session;
            console.log(`[LM:${sessionId}] step   : ${cur}/${tot}  loss=${Number(loss).toFixed(4)}`);
          }

        } else if (line.startsWith('PHASE ')) {
          const phase = line.slice(6);
          console.log(`[LM:${sessionId}] phase  : ${phase}`);
          const st: LmTrainingStatus = phase.startsWith('Converting') ? 'converting' : 'training';
          session = updateSession(sessionId, { current_phase: phase, status: st });
          _lmRunStatus.session = session;

        } else if (line.startsWith('DONE ')) {
          const parts    = line.slice(5).trim().split(' ');
          const stPath   = parts[0];
          const ggufPath = parts[1] ?? null;
          session = updateSession(sessionId, {
            safetensors_path: stPath,
            gguf_path:        ggufPath,
            current_phase:    'Training complete — packaging',
            status:           'packaging',
          });
          _lmRunStatus.session = session;
          console.log(`[LM:${sessionId}] done   : safetensors=${stPath}  gguf=${ggufPath}`);
          trainingDone = true;
          break;

        } else if (line.startsWith('ERROR ')) {
          const msg = line.slice(6);
          console.error(`[LM:${sessionId}] error  : ${msg}`);
          session = updateSession(sessionId, { status: 'error', error: msg, finished_at: new Date().toISOString() });
          proc.kill('SIGTERM');
          _activeProc = null;
          _finish(session);
          // Python ran and used CUDA — apply PyTorch settle before restart
          await _restartServers(snaps, true);
          return;
        }
      }

      _activeProc = null;

      // ── Check for abort ──────────────────────────────────────────────────
      const fresh = readLmSession(sessionId)!;
      if (fresh.status === 'aborted') {
        _finish(fresh);
        await _restartServers(snaps, true);
        return;
      }

      if (!trainingDone || !fresh.gguf_path || !fs.existsSync(fresh.gguf_path)) {
        const tail = errBuf.trim().split('\n').slice(-5).join(' ');
        if (tail) console.error(`[LM:${sessionId}] stderr : ${tail}`);
        session = updateSession(sessionId, {
          status: 'error', error: tail || 'Trainer exited without producing lora.gguf', finished_at: new Date().toISOString(),
        });
        _finish(session);
        await _restartServers(snaps, true);
        return;
      }

      session = fresh;

      // ── Restart LLM servers — packaging is CPU-only, VRAM is now free ────
      // Fire restart concurrently with packaging (non-blocking to the user).
      // Mirrors workflows.ts finally block: generating=false first, restart after.
      // PyTorch settle applies: training used CUDA unsloth.
      _restartServers(snaps, true).catch(e => {
        console.warn(`[LM:${sessionId}] restart warning: ${(e as Error).message}`);
      });

      // ── Phase: package ───────────────────────────────────────────────────
      session = updateSession(sessionId, { status: 'packaging', current_phase: 'Packaging .cartridge archive' });
      _lmRunStatus.session = session;

      try {
        const record = await _packageCartridge(session, cartridgeStore);
        session = updateSession(sessionId, {
          status:        'done',
          cartridge_id:  record.id,
          finished_at:   new Date().toISOString(),
          current_phase: 'Complete',
        });
        _finish(session);
      } catch (e) {
        session = updateSession(sessionId, {
          status: 'error', error: (e as Error).message, finished_at: new Date().toISOString(),
        });
        _finish(session);
      }

    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[LM:${sessionId}] fatal  : ${msg}`);
      try {
        const s = updateSession(sessionId, { status: 'error', error: msg, finished_at: new Date().toISOString() });
        _finish(s);
      } catch {
        _finish({ session_id: sessionId, status: 'error', error: msg } as LmTrainingSession);
      }
      if (_activeProc) { _activeProc.kill('SIGTERM'); _activeProc = null; }
      await _restartServers(snaps, true);
    }
  })();

  return { ok: true };
}

// ── Server restart helper ─────────────────────────────────────────────────────
//
// Mirrors the finally block in workflows.ts POST /run exactly.
//
// applySettle=true  → Python actually ran and used CUDA; wait 3 s for the
//   driver to reclaim VRAM pages before restarting llama-server (avoids OOM).
//   Matches: const postGenSettleMs = isXpu ? 12_000 : 3_000 in workflows.ts.
//   Training is always CUDA (never XPU), so 3 s is correct.
//
// applySettle=false → Python never spawned (dep/dataset/path error);
//   no VRAM was held — restart immediately.

async function _restartServers(
  snaps: ReturnType<typeof snapshotAllServersOnDevice>,
  applySettle: boolean,
): Promise<void> {
  if (snaps.length === 0) return;

  if (applySettle) {
    await _sleep(3000);
  }

  for (const snap of snaps) {
    try {
      await startServer(snap.role, {
        modelId:     snap.modelId,
        port:        snap.port,
        gpuLayers:   snap.gpuLayers,
        contextSize: snap.contextSize,
        threads:     snap.threads,
        deviceIndex: snap.deviceIndex,
        gpuBackend:  snap.gpuBackend,
      });
      console.log(`[LM] restart: ${snap.role} → ${snap.modelId}`);
    } catch (e) {
      console.warn(`[LM] restart failed for ${snap.role}: ${(e as Error).message}`);
    }
  }
}

// ── Abort ─────────────────────────────────────────────────────────────────────

export function abortLmTraining(sessionId: string): void {
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
    compatibleModels:  ['*'],
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

  const samplesDir  = path.join(session.output_dir, 'samples');
  const samplePaths = fs.existsSync(samplesDir)
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

const DOC_EXTS = new Set([
  '.md','.txt','.pdf','.py','.ts','.js','.json','.html','.htm',
  '.ahk','.sh','.bash','.zsh','.fish','.ps1','.bat','.cmd',
  '.lua','.rb','.go','.rs','.c','.cpp','.h','.hpp','.cs','.java',
  '.kt','.swift','.r','.m','.pl','.pm','.php','.sql',
  '.yaml','.yml','.toml','.ini','.cfg','.conf','.env','.log',
  '.csv','.xml','.rst','.tex','.org','.wiki','.adoc',
  '.nfo','.me','.readme','.license',
]);

function _countDatasetFiles(dir: string, mode: LmDataMode): number {
  if (!fs.existsSync(dir)) return 0;
  if (mode === 'conversation') {
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
import type { GGUFSpec } from './PhobosLocalManager.js';