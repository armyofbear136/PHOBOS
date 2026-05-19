/**
 * AudioServerManager.ts — PHOBOS generative audio pipeline manager.
 *
 * Binary / script resolution strategy (matches LlamaServerManager / ImageServerManager):
 *
 *   Binaries (ace-lm, ace-synth, whisper-cli):
 *     1. PHOBOS_BIN_DIR env var   — dev/test override, points at dist/
 *     2. dirname(process.execPath) — SEA production (phobos-core.exe dir = dist/)
 *     These live in dist/ alongside phobos-core.exe and share the ggml-*.dll
 *     files already present there from llama-server.
 *
 *   Python scripts (phobos-tts-f5.py):
 *     Same seaDir / import.meta.url cascade as phobos-diffusers.py.
 *
 *   Kokoro ONNX model (model_quantized.onnx):
 *     dist/kokoro/model_quantized.onnx — shipped with the build.
 *     Individual voice .bin files fetched on first use into dist/kokoro/voices/.
 *
 *   Large models (F5-TTS safetensors, ACE-Step GGUFs):
 *     ~/.phobos/models/audio/<runnerProfile>/<modelId>/  — user data dir
 *     ACE-Step GGUFs: ~/.phobos/services/acestep/models/
 *
 * Subprocess stdout protocol (shared with phobos-diffusers.py):
 *   [INFO ] <message>   — progress, forwarded to onProgress
 *   [ERROR] <message>   — fatal, collected and re-thrown on non-zero exit
 *   exit 0              — success
 *   exit non-zero       — failure
 */

import { spawn }         from 'child_process';
import * as crypto       from 'crypto';
import * as fs           from 'fs';
import * as os           from 'os';
import * as path         from 'path';
import { fileURLToPath } from 'url';
import {
  detectHardware,
  audioModelDir,
  getAudioModelSpec,
  isAudioModelDownloaded,
}                        from './PhobosLocalManager.js';
import {
  getPythonPath,
  gpuToVendor,
  isVendorReady,
}                        from './PythonEnvManager.js';
import { userDir, getActiveUser } from '../db/DatabaseManager.js';

// ── Dir resolution (ESM dev vs CJS SEA bundle) ────────────────────────────────

function getThisDir(): string {
  try {
    if (typeof import.meta?.url === 'string') {
      return path.dirname(fileURLToPath(import.meta.url));
    }
  } catch { /* CJS bundle */ }
  return typeof __dirname === 'string' ? __dirname : process.cwd();
}

const _thisDir = getThisDir();

// ── Binary resolution ─────────────────────────────────────────────────────────

function resolveBinDir(): string {
  if (process.env.PHOBOS_BIN_DIR) return process.env.PHOBOS_BIN_DIR;
  return path.dirname(process.execPath);
}

function resolveAceBin(name: 'ace-lm' | 'ace-synth'): string {
  const ext  = process.platform === 'win32' ? '.exe' : '';
  const file = `${name}${ext}`;
  const binDir = resolveBinDir();
  const candidates = [
    path.join(binDir, 'ace-step', file),
    path.join(_thisDir, '..', 'ace-step', file),
    path.join(process.cwd(), 'dist', 'ace-step', file),
    path.join(binDir, file),
    path.join(_thisDir, '..', file),
    path.join(process.cwd(), 'dist', file),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `${file} not found. Expected in dist/ace-step/ alongside phobos-core.exe.\n` +
    `Build from: https://github.com/ace-step/acestep.cpp\n` +
    `Searched:\n  ${candidates.join('\n  ')}`,
  );
}

function resolveWhisperBin(): string {
  const ext  = process.platform === 'win32' ? '.exe' : '';
  const file = `whisper-cli${ext}`;
  const binDir = resolveBinDir();
  const candidates = [
    path.join(binDir, file),
    path.join(_thisDir, '..', file),
    path.join(process.cwd(), 'dist', file),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `${file} not found. Expected in dist/ alongside phobos-core.exe.\n` +
    `Build from: https://github.com/ggerganov/whisper.cpp\n` +
    `Searched:\n  ${candidates.join('\n  ')}`,
  );
}

function resolveF5Script(): string {
  const file    = 'phobos-tts-f5.py';
  const seaDir  = path.dirname(process.execPath);
  const candidates = [
    path.join(seaDir, file),                           // SEA production: dist/
    path.join(_thisDir, file),                         // same dir as this .ts file
    path.join(_thisDir, '..', 'phobos', file),         // one level up in built output
    path.join(process.cwd(), 'phobos', file),          // repo root dev (tsx)
    path.join(process.cwd(), 'dist', file),            // dist/ from repo root
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`${file} not found.\nSearched:\n  ${candidates.join('\n  ')}`);
}

function resolveKokoroScript(): string {
  const file    = 'phobos-kokoro.mjs';
  const seaDir  = path.dirname(process.execPath);
  const candidates = [
    path.join(seaDir, file),                           // SEA production: dist/
    path.join(_thisDir, file),                         // same dir as this .ts file (dev)
    path.join(_thisDir, '..', 'phobos', file),         // one level up in built output
    path.join(process.cwd(), 'phobos', file),          // repo root dev (tsx)
    path.join(process.cwd(), 'dist', file),            // dist/ from repo root
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`${file} not found.\nSearched:\n  ${candidates.join('\n  ')}`);
}

function resolveAceStepScript(): string {
  const file    = 'phobos-music-acestep.py';
  const seaDir  = path.dirname(process.execPath);
  const candidates = [
    path.join(seaDir, file),
    path.join(_thisDir, file),
    path.join(_thisDir, '..', 'phobos', file),
    path.join(process.cwd(), 'phobos', file),
    path.join(process.cwd(), 'dist', file),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`${file} not found.\nSearched:\n  ${candidates.join('\n  ')}`);
}

// ── Portable Node binary ───────────────────────────────────────────────────────
// In production, process.execPath is phobos.exe (SEA) — a sealed binary that
// cannot execute .mjs scripts. A portable node binary is staged alongside it
// by build.js. In dev, process.execPath IS a real Node binary.
function resolveNodeBin(): string {
  const nodeName = process.platform === 'win32'
    ? `node-${process.platform}-${process.arch}.exe`
    : `node-${process.platform}-${process.arch}`;
  const stagedNode = path.join(path.dirname(process.execPath), nodeName);
  if (fs.existsSync(stagedNode)) return stagedNode;
  return process.execPath; // dev fallback — already a real Node binary
}


// ── Kokoro daemon — persistent warm process ───────────────────────────────────
//
// Instead of spawning a fresh Node process per TTS segment (which reloads the
// ONNX model every time, ~10s), we keep one long-running daemon alive.
// The daemon loads the model once, signals [READY], then accepts JSON jobs on
// stdin and responds with [DONE] / [ERROR] lines on stdout.
//
// Lifecycle:
//   - First generateKokoro() call: daemon not running → spawn it.
//   - While model loads: first job is queued and sent as soon as [READY] arrives.
//   - Subsequent calls: job sent immediately (model already warm, ~1-2s inference).
//   - Daemon crash: cleared, next call restarts it transparently.

interface KokoroPendingJob {
  id:      string;
  resolve: (outputPath: string) => void;
  reject:  (err: Error) => void;
}

interface KokoroDaemon {
  proc:    import('child_process').ChildProcess;
  ready:   boolean;                       // true once [READY] received
  pending: Map<string, KokoroPendingJob>; // jobs waiting for [DONE]/[ERROR]
  queue:   Array<string>;                 // raw JSON lines queued before ready
}

let _kokoroDaemon: KokoroDaemon | null = null;

function _startKokoroDaemon(
  nodeBin:     string,
  scriptPath:  string,
  modelDir:    string,
  cwd:         string,
): KokoroDaemon {
  const proc = spawn(nodeBin, [
    scriptPath,
    '--model-dir', modelDir,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    env: process.env,
  });

  const daemon: KokoroDaemon = {
    proc,
    ready:   false,
    pending: new Map(),
    queue:   [],
  };

  proc.stdout?.on('data', (chunk: Buffer) => {
    for (const raw of chunk.toString().split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      console.log(`[kokoro] ${line}`);

      if (line === '[READY]') {
        daemon.ready = true;
        for (const queued of daemon.queue) {
          proc.stdin?.write(queued + '\n');
        }
        daemon.queue.length = 0;
        return;
      }

      // [DONE ] <id> <outputPath>
      if (line.startsWith('[DONE ]')) {
        const rest = line.slice('[DONE ]'.length).trimStart();
        const spaceIdx = rest.indexOf(' ');
        const id = spaceIdx >= 0 ? rest.slice(0, spaceIdx) : rest;
        const outPath = spaceIdx >= 0 ? rest.slice(spaceIdx + 1).trim() : '';
        const job = daemon.pending.get(id);
        if (job) {
          daemon.pending.delete(id);
          job.resolve(outPath);
        }
        return;
      }

      // [ERROR] <id> <message>
      if (line.startsWith('[ERROR]')) {
        const rest = line.slice('[ERROR]'.length).trimStart();
        const spaceIdx = rest.indexOf(' ');
        const id = spaceIdx >= 0 ? rest.slice(0, spaceIdx) : rest;
        const msg = spaceIdx >= 0 ? rest.slice(spaceIdx + 1).trim() : 'unknown error';
        const job = daemon.pending.get(id);
        if (job) {
          daemon.pending.delete(id);
          job.reject(new Error(msg));
        }
        return;
      }

      // [FATAL] — daemon is about to exit
      if (line.startsWith('[FATAL]')) {
        const msg = line.slice('[FATAL]'.length).trim();
        for (const job of daemon.pending.values()) {
          job.reject(new Error(`Kokoro daemon fatal: ${msg}`));
        }
        daemon.pending.clear();
      }
    }
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) console.log(`[kokoro:err] ${line.trim()}`);
    }
  });

  proc.on('exit', (code, signal) => {
    console.log(`[kokoro] daemon exited (code=${code}, signal=${signal})`);
    for (const job of daemon.pending.values()) {
      job.reject(new Error(`Kokoro daemon exited unexpectedly (code=${code})`));
    }
    daemon.pending.clear();
    if (_kokoroDaemon === daemon) _kokoroDaemon = null;
  });

  proc.on('error', (err: Error) => {
    console.log(`[kokoro] daemon spawn error: ${err.message}`);
    for (const job of daemon.pending.values()) {
      job.reject(new Error(`Kokoro daemon spawn error: ${err.message}`));
    }
    daemon.pending.clear();
    if (_kokoroDaemon === daemon) _kokoroDaemon = null;
  });

  _kokoroDaemon = daemon;
  return daemon;
}

function _getOrStartKokoroDaemon(
  nodeBin:    string,
  scriptPath: string,
  modelDir:   string,
  cwd:        string,
): KokoroDaemon {
  if (_kokoroDaemon && !_kokoroDaemon.proc.exitCode && !(_kokoroDaemon.proc as any).killed) {
    return _kokoroDaemon;
  }
  return _startKokoroDaemon(nodeBin, scriptPath, modelDir, cwd);
}

/** Shutdown the warm kokoro daemon cleanly (called on server shutdown). */
export function shutdownKokoroDaemon(): void {
  if (_kokoroDaemon) {
    try { _kokoroDaemon.proc.stdin?.end(); } catch { /**/ }
    _kokoroDaemon = null;
  }
}

function resolveKokoroCwd(): string {
  const seaDir = path.dirname(process.execPath);
  if (fs.existsSync(path.join(seaDir, 'node_modules', 'kokoro-js'))) return seaDir;
  const repoRoot = process.cwd();
  if (fs.existsSync(path.join(repoRoot, 'node_modules', 'kokoro-js'))) return repoRoot;
  return repoRoot;
}

function resolveKokoroModelDir(): string {
  const binDir = resolveBinDir();
  const candidates = [
    path.join(binDir, 'kokoro'),
    path.join(_thisDir, '..', 'kokoro'),
    path.join(process.cwd(), 'dist', 'kokoro'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'onnx', 'model_quantized.onnx'))) return c;
  }
  return path.join(binDir, 'kokoro'); // return primary even if absent — caller checks
}

// ── Whisper model ─────────────────────────────────────────────────────────────

function resolveWhisperModelPath(): string {
  return path.join(
    os.homedir(), '.phobos', 'models', 'audio',
    'whisper', 'whisper-large-v3', 'ggml-large-v3.bin',
  );
}

// ── Workspace output paths ────────────────────────────────────────────────────

function audioWorkspaceDir(threadId: string, category: 'tts' | 'music' | 'sfx'): string {
  const root = process.env.WORKSPACES_ROOT
    ?? path.join(userDir(getActiveUser()), 'workspaces');
  return path.join(root, threadId, 'audio', category);
}

export function timestampedOutputPath(
  threadId: string,
  category: 'tts' | 'music' | 'sfx',
  label:    string,
  ext:      string = '.wav',
): string {
  const dir  = audioWorkspaceDir(threadId, category);
  fs.mkdirSync(dir, { recursive: true });
  const ts   = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  return path.join(dir, `${ts}-${slug}${ext}`);
}

export function ensureAudioWorkspace(threadId: string): void {
  for (const cat of ['tts', 'music', 'sfx'] as const) {
    fs.mkdirSync(audioWorkspaceDir(threadId, cat), { recursive: true });
  }
}

// ── GPU / Python resolution ───────────────────────────────────────────────────

interface AudioDevice {
  pythonBin: string;
  deviceArg: string;
  vendor:    string;
}

async function resolvePythonDevice(overrideVendor?: string, overrideIndex?: number): Promise<AudioDevice> {
  const hw = await detectHardware();
  for (const gpu of hw.gpus) {
    const vendor = gpuToVendor(gpu);
    if (overrideVendor && vendor !== overrideVendor) continue;
    if (overrideIndex !== undefined && gpu.index !== overrideIndex) continue;
    if (!isVendorReady(vendor)) continue;
    const pyBin = getPythonPath(vendor);
    if (!pyBin) continue;
    // ROCm Windows uses HIP-as-CUDA compat path — device string is 'cuda:N'.
    // XPU (Intel Arc) uses 'xpu:N'.
    // Metal uses 'mps' (no index — MPS has one logical device).
    const deviceArg = vendor === 'cuda'  ? `cuda:${gpu.index}`
                    : vendor === 'rocm'  ? `cuda:${gpu.index}`
                    : vendor === 'xpu'   ? `xpu:${gpu.index}`
                    : vendor === 'apple' ? 'mps'
                    : 'cpu';
    return { pythonBin: pyBin, deviceArg, vendor };
  }
  return { pythonBin: getPythonPath('cpu') ?? 'python3', deviceArg: 'cpu', vendor: 'cpu' };
}

// ── Generic subprocess runner ─────────────────────────────────────────────────

export interface AudioRunOptions {
  onProgress?: (line: string) => void;
  signal?:     AbortSignal;
}

function runProcess(
  bin:        string,
  args:       string[],
  outputPath: string,
  opts:       AudioRunOptions = {},
  extraEnv?:  Record<string, string>,
  cwd?:       string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const spawnEnv = extraEnv
      ? { ...process.env, ...extraEnv }
      : process.env;
    const spawnOpts: import('child_process').SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   spawnEnv,
    };
    if (cwd) spawnOpts.cwd = cwd;
    const proc = spawn(bin, args, spawnOpts);

    if (opts.signal) {
      const abort = () => { try { proc.kill('SIGTERM'); } catch { /**/ } };
      opts.signal.addEventListener('abort', abort, { once: true });
      proc.on('exit', () => opts.signal!.removeEventListener('abort', abort));
    }

    const errorLines: string[] = [];

    proc.stdout?.on('data', (chunk: Buffer) => {
      for (const raw of chunk.toString().split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        console.log(`[audio] ${line}`);
        if (line.startsWith('[ERROR]')) errorLines.push(line);
        opts.onProgress?.(line);
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      for (const raw of chunk.toString().split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (/UserWarning|FutureWarning|deprecat/i.test(line)) continue;
        console.log(`[audio:err] ${line}`);
      }
    });

    proc.on('exit', (code: number | null, signal: string | null) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        reject(new Error('Audio generation cancelled'));
        return;
      }
      if (code === 0) {
        if (!fs.existsSync(outputPath)) {
          reject(new Error(`Process exited 0 but output missing: ${outputPath}`));
        } else {
          resolve(outputPath);
        }
        return;
      }
      const detail = errorLines.length > 0
        ? errorLines[errorLines.length - 1].replace('[ERROR]', '').trim()
        : `exited with code ${code}`;
      reject(new Error(`Audio generation failed: ${detail}`));
    });

    proc.on('error', (err: Error) => {
      reject(new Error(`Failed to spawn process: ${err.message}`));
    });
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface AudioGenerateResult {
  outputPath: string;
  elapsedMs:  number;
}

// ── TTS — Kokoro (in-process via kokoro-js) ───────────────────────────────────

export interface KokoroOptions extends AudioRunOptions {
  threadId: string;
  text:     string;
  voice?:   string;
  speed?:   number;
  label?:   string;
}

export async function generateKokoro(opts: KokoroOptions): Promise<AudioGenerateResult> {
  const modelDir  = resolveKokoroModelDir();
  const modelFile = path.join(modelDir, 'onnx', 'model_quantized.onnx');

  if (!fs.existsSync(modelFile)) {
    throw new Error(
      'Kokoro model not found. Download it from Phobos settings → Audio → Kokoro TTS.\n' +
      `Expected: ${modelFile}`,
    );
  }

  const nodeBin    = resolveNodeBin();
  const scriptPath = resolveKokoroScript();
  const cwd        = resolveKokoroCwd();
  const outputPath = path.join(os.tmpdir(), `phobos-tts-${crypto.randomUUID()}.wav`);
  const startMs    = Date.now();
  const jobId      = crypto.randomUUID();

  // Get or start the warm daemon. If this is the first call, the daemon spawns
  // and begins loading the model. The job is queued and sent as soon as [READY]
  // fires — so the model load overlaps with the LLM's time-to-first-token.
  const daemon = _getOrStartKokoroDaemon(nodeBin, scriptPath, modelDir, cwd);

  const job = JSON.stringify({
    id:     jobId,
    text:   opts.text,
    output: outputPath,
    voice:  opts.voice  ?? 'af_heart',
    speed:  opts.speed  ?? 1.0,
  });

  await new Promise<void>((resolve, reject) => {
    daemon.pending.set(jobId, {
      id:      jobId,
      resolve: (outPath: string) => {
        opts.onProgress?.(`[INFO ] Done — ${outPath}`);
        resolve();
      },
      reject,
    });

    if (opts.signal) {
      const onAbort = () => {
        if (daemon.pending.has(jobId)) {
          daemon.pending.delete(jobId);
          reject(new Error('Audio generation cancelled'));
        }
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    if (daemon.ready) {
      daemon.proc.stdin?.write(job + '\n');
    } else {
      daemon.queue.push(job);
    }
  });

  return { outputPath, elapsedMs: Date.now() - startMs };
}

// ── TTS — F5-TTS (Python subprocess) ─────────────────────────────────────────

export interface F5TtsOptions extends AudioRunOptions {
  threadId:            string;
  text:                string;
  mode?:               'tts' | 'clone';
  refAudio?:           string;
  refText?:            string;
  speed?:              number;
  steps?:              number;
  label?:              string;
  /** Force a specific PyTorch vendor venv (for testing). */
  overrideVendor?:     string;
  /** Force a specific GPU device index (for testing). */
  overrideDeviceIndex?: number;
}

export async function generateF5Tts(opts: F5TtsOptions): Promise<AudioGenerateResult> {
  const modelId = 'f5-tts-v1-base';
  const spec    = getAudioModelSpec(modelId);
  if (!spec)        throw new Error(`Unknown model: ${modelId}`);
  if (spec.blocked) throw new Error(`Model ${modelId} is not available in this release`);
  if (!isAudioModelDownloaded(spec)) {
    throw new Error(`F5-TTS model not downloaded. Run fetch-audio-deps.js --only f5tts`);
  }

  const { pythonBin, deviceArg, vendor } = await resolvePythonDevice(opts.overrideVendor, opts.overrideDeviceIndex);
  const scriptPath = resolveF5Script();
  const outputPath = path.join(os.tmpdir(), `phobos-tts-${crypto.randomUUID()}.wav`);
  const startMs    = Date.now();

  const modelDirectory = audioModelDir(spec);
  const modelFile      = path.join(modelDirectory, spec.hfFile);
  const vocabFile      = path.join(path.dirname(modelFile), 'vocab.txt');

  const args = [
    scriptPath,
    '--model-path', modelFile,
    '--vocab-path', vocabFile,
    '--text',       opts.text,
    '--output',     outputPath,
    '--mode',       opts.mode ?? 'tts',
    '--speed',      String(opts.speed ?? 1.0),
    '--steps',      String(opts.steps ?? 32),
    '--device',     deviceArg,
  ];
  if (opts.refAudio) args.push('--ref-audio', opts.refAudio);
  if (opts.refText)  args.push('--ref-text',  opts.refText);

  console.log(`[AudioServerManager] F5-TTS: ${pythonBin} ${args.join(' ')}`);
  // Prepend Jellyfin's ffmpeg to PATH so torchcodec can load its DLLs.
  // torchcodec (required by f5-tts for audio loading) needs ffmpeg DLLs at runtime.
  const jellyfinDir = path.join(os.homedir(), '.phobos', 'services', 'jellyfin');
  const pathSep     = process.platform === 'win32' ? ';' : ':';
  const ffmpegPath  = fs.existsSync(path.join(jellyfinDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'))
    ? `${jellyfinDir}${pathSep}${process.env.PATH ?? ''}`
    : (process.env.PATH ?? '');
  const extraEnv: Record<string, string> = { PATH: ffmpegPath };
  // ROCm Windows: HIP device visibility and gfx1150 (890M RDNA3.5) kernel override.
  if (vendor === 'rocm' && process.platform === 'win32') {
    extraEnv['HIP_VISIBLE_DEVICES']      = deviceArg.replace('cuda:', '') || '0';
    extraEnv['HSA_OVERRIDE_GFX_VERSION'] = '11.5.0';
  }
  // XPU (Intel Arc): SYCL immediate command lists, disable XMX for gen12 compatibility.
  if (vendor === 'xpu') {
    extraEnv['SYCL_PI_LEVEL_ZERO_USE_IMMEDIATE_COMMANDLISTS'] = '1';
    extraEnv['BIGDL_LLM_XMX_DISABLED']                       = '1';
  }

  await runProcess(pythonBin, args, outputPath, opts, extraEnv);
  return { outputPath, elapsedMs: Date.now() - startMs };
}

// ── Music — ACE-Step (C++: ace-lm pass then ace-synth pass) ──────────────────

export interface AceStepOptions extends AudioRunOptions {
  threadId:            string;
  prompt:              string;
  lyrics?:             string;
  duration?:           number;
  steps?:              number;
  cfgStrength?:        number;
  seed?:               number;
  label?:              string;
  /** 'gpu' = Python ACEStepPipeline, 'cpu' = C++ binaries, 'auto' = GPU if available */
  audioBackend?:       'auto' | 'gpu' | 'cpu';
  /** Force a specific PyTorch vendor venv (for testing). */
  overrideVendor?:     string;
  /** Force a specific GPU device index (for testing). */
  overrideDeviceIndex?: number;
}

export async function generateAceStep(opts: AceStepOptions): Promise<AudioGenerateResult> {
  // ── Route selection: GPU (Python) vs CPU (C++ GGUF binaries) ─────────────
  // GPU route: Python ACEStepPipeline via phobos-music-acestep.py.
  //   Requires: PyTorch venv installed + full HF snapshot at ace-step/ace-step-v1.5/
  // CPU route: ace-lm + ace-synth C++ binaries with GGUF models.
  //   Requires: dist/ace-step/ binaries + ~/.phobos/models/audio/acestep/*.gguf
  //
  // Selection follows the same pattern as imageGen selectBackend():
  //   'gpu'  → use GPU if available, throw if not
  //   'cpu'  → always use C++ binaries
  //   'auto' → GPU if available, CPU otherwise (default)

  const gpuVendors = ['cuda', 'rocm', 'apple'] as const;
  const gpuVenvReady = gpuVendors.some(v => isVendorReady(v));

  const spec = getAudioModelSpec('ace-step-v1.5');
  const snapshotReady = spec
    ? fs.existsSync(path.join(audioModelDir(spec), 'acestep-v15-turbo'))
    : false;

  const gpuAvailable = gpuVenvReady && snapshotReady;

  const requested = opts.audioBackend ?? 'auto';
  const useGpu    = requested === 'gpu'  ? gpuAvailable
                  : requested === 'cpu'  ? false
                  : gpuAvailable; // 'auto'

  if (requested === 'gpu' && !gpuAvailable) {
    const why = !gpuVenvReady
      ? 'no PyTorch GPU environment is installed'
      : 'ACE-Step snapshot not found at ' + (spec ? audioModelDir(spec) : 'unknown');
    throw new Error(`ACE-Step GPU route requested but unavailable: ${why}`);
  }

  if (useGpu) {
    opts.onProgress?.('[INFO ] ACE-Step: GPU route (Python ACEStepPipeline)');
    const { pythonBin, deviceArg, vendor } = await resolvePythonDevice(opts.overrideVendor, opts.overrideDeviceIndex);
    const scriptPath    = resolveAceStepScript();
    const outputPath    = path.join(os.tmpdir(), `phobos-music-${crypto.randomUUID()}.wav`);
    const startMs       = Date.now();
    const args: string[] = [
      scriptPath,
      '--checkpoint-path', audioModelDir(spec!),
      '--prompt',          opts.prompt,
      '--lyrics',          opts.lyrics ?? '[Instrumental]',
      '--duration',        String(opts.duration   ?? 30),
      '--steps',           String(opts.steps      ?? 60),
      '--cfg',             String(opts.cfgStrength ?? 15),
      '--seed',            String(opts.seed        ?? -1),
      '--device',          deviceArg,
      '--output',          outputPath,
    ];
    const aceEnv: Record<string, string> = {};
    // ROCm Windows: HIP device visibility and gfx1150 (890M RDNA3.5) kernel override.
    if (vendor === 'rocm' && process.platform === 'win32') {
      aceEnv['HIP_VISIBLE_DEVICES']      = deviceArg.replace('cuda:', '') || '0';
      aceEnv['HSA_OVERRIDE_GFX_VERSION'] = '11.5.0';
    }
    // XPU (Intel Arc): SYCL immediate command lists, disable XMX for gen12 compatibility.
    if (vendor === 'xpu') {
      aceEnv['SYCL_PI_LEVEL_ZERO_USE_IMMEDIATE_COMMANDLISTS'] = '1';
      aceEnv['BIGDL_LLM_XMX_DISABLED']                       = '1';
    }
    console.log(`[AudioServerManager] acestep (gpu): ${pythonBin} ${args.join(' ')}`);
    await runProcess(pythonBin, args, outputPath, opts, Object.keys(aceEnv).length ? aceEnv : undefined);
    return { outputPath, elapsedMs: Date.now() - startMs };
  }

  // ── CPU route ─────────────────────────────────────────────────────────────
  opts.onProgress?.('[INFO ] ACE-Step: CPU route (C++ GGUF binaries)');
  const modelsDir  = path.join(os.homedir(), '.phobos', 'models', 'audio', 'acestep');
  const lmModel    = path.join(modelsDir, 'acestep-5Hz-lm-1.7B-Q8_0.gguf');
  const ditModel   = path.join(modelsDir, 'acestep-v15-sft-Q8_0.gguf');
  const vaeModel   = path.join(modelsDir, 'vae-BF16.gguf');
  const embedModel = path.join(modelsDir, 'Qwen3-Embedding-0.6B-Q8_0.gguf');

  for (const [label, p] of [
    ['LM model',        lmModel],
    ['DiT model',       ditModel],
    ['VAE model',       vaeModel],
    ['Embedding model', embedModel],
  ] as const) {
    if (!fs.existsSync(p)) {
      throw new Error(
        `ACE-Step ${label} not found: ${p}\n` +
        `Run: node scripts/fetch-audio-deps.js --only acestep-models (dest: ~/.phobos/models/audio/acestep/)`,
      );
    }
  }

  const aceLm    = resolveAceBin('ace-lm');
  const aceSynth = resolveAceBin('ace-synth');

  const outputPath = timestampedOutputPath(opts.threadId, 'music', opts.label ?? 'acestep');
  const startMs    = Date.now();
  const duration   = opts.duration ?? 30;
  const seed       = (opts.seed !== undefined && opts.seed >= 0)
    ? opts.seed
    : Math.floor(Math.random() * 2 ** 31);

  // Pass 1 — ace-lm: prompt + lyrics → audio codes
  // ace-lm takes a JSON request file, not inline flags.
  // Temp files go to os.tmpdir() — NOT alongside outputPath in the workspace —
  // so the workspace file index never picks them up.
  const tempId  = crypto.randomUUID();
  const requestObj: Record<string, unknown> = {
    task:     'text2music',
    caption:  opts.prompt,
    duration,
    seed,
  };
  if (opts.lyrics) requestObj.lyrics = opts.lyrics;
  if (opts.cfgStrength !== undefined) requestObj.lm_cfg_scale = opts.cfgStrength;

  const requestPath = path.join(os.tmpdir(), `phobos-acestep-${tempId}.request.json`);
  fs.writeFileSync(requestPath, JSON.stringify(requestObj, null, 2));

  const lmArgs = [
    '--request', requestPath,
    '--lm',      lmModel,
  ];

  opts.onProgress?.('[INFO ] ACE-Step pass 1/2: language model');
  console.log(`[AudioServerManager] ace-lm: ${aceLm} ${lmArgs.join(' ')}`);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(aceLm, lmArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (opts.signal) {
      const abort = () => { try { proc.kill('SIGTERM'); } catch { /**/ } };
      opts.signal.addEventListener('abort', abort, { once: true });
      proc.on('exit', () => opts.signal!.removeEventListener('abort', abort));
    }
    proc.stdout?.on('data', (c: Buffer) => {
      for (const l of c.toString().split('\n')) {
        const line = l.trim();
        if (line) { console.log(`[ace-lm] ${line}`); opts.onProgress?.(line); }
      }
    });
    proc.stderr?.on('data', (c: Buffer) => {
      for (const l of c.toString().split('\n')) {
        const line = l.trim(); if (line) console.log(`[ace-lm:err] ${line}`);
      }
    });
    proc.on('exit', (code: number | null) => {
      code === 0 ? resolve() : reject(new Error(`ace-lm exited with code ${code}`));
    });
    proc.on('error', (err: Error) => reject(new Error(`ace-lm spawn failed: ${err.message}`)));
  });

  // ace-lm writes its enriched output JSON alongside the request file
  // as request0.json (first track index). This is the input to ace-synth.
  const lmOutputPath = requestPath.replace('.request.json', '.request0.json');
  if (!fs.existsSync(lmOutputPath)) {
    // Fallback: some builds write to <requestName>0.json pattern
    const altPath = requestPath.replace(/\.json$/, '0.json');
    if (!fs.existsSync(altPath)) {
      throw new Error(
        `ace-lm completed but output JSON not found.
Expected: ${lmOutputPath}
or: ${altPath}`
      );
    }
  }
  const synthRequestPath = fs.existsSync(lmOutputPath) ? lmOutputPath
    : requestPath.replace(/\.json$/, '0.json');

  // Pass 2 — ace-synth: audio codes → WAV
  // ace-synth defaults to MP3; --wav forces WAV output.
  // Output filename is derived from the request JSON name: request0.json -> request0.wav
  const synthArgs = [
    '--request',   synthRequestPath,
    '--embedding', embedModel,
    '--dit',       ditModel,
    '--vae',       vaeModel,
    '--wav',
  ];

  // ace-synth writes output alongside the request JSON, named <requestBasename>.wav
  // e.g. 20260504-test-acestep.request0.json -> 20260504-test-acestep.request0.wav
  // ace-synth appends a track index '0' before the extension: request0.json -> request00.wav
  const synthOutputPath = synthRequestPath.replace(/\.json$/, '0.wav');

  opts.onProgress?.('[INFO ] ACE-Step pass 2/2: synthesis');
  console.log(`[AudioServerManager] ace-synth: ${aceSynth} ${synthArgs.join(' ')}`);
  await runProcess(aceSynth, synthArgs, synthOutputPath, opts);

  // Move the generated WAV to the canonical timestamped output path
  fs.renameSync(synthOutputPath, outputPath);

  // Clean up temp request files
  for (const p of [requestPath, synthRequestPath]) {
    try { fs.unlinkSync(p); } catch { /* best-effort */ }
  }

  return { outputPath, elapsedMs: Date.now() - startMs };
}

// ── STT — Whisper (C++ one-shot) ──────────────────────────────────────────────

export interface TranscribeOptions extends AudioRunOptions {
  audioPath: string;
  language?: string;
}

export async function transcribe(opts: TranscribeOptions): Promise<string> {
  const binPath   = resolveWhisperBin();
  const modelPath = resolveWhisperModelPath();

  if (!fs.existsSync(modelPath)) {
    throw new Error(
      `Whisper model not found: ${modelPath}\n` +
      `Run: node scripts/fetch-audio-deps.js --only whisper`,
    );
  }
  if (!fs.existsSync(opts.audioPath)) {
    throw new Error(`Input audio not found: ${opts.audioPath}`);
  }

  const args = [
    '--model',       modelPath,
    '--file',        opts.audioPath,
    '--output-txt',
    '--no-timestamps',
  ];
  if (opts.language) args.push('--language', opts.language);

  console.log(`[AudioServerManager] whisper: ${binPath} ${args.join(' ')}`);

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    if (opts.signal) {
      const abort = () => { try { proc.kill('SIGTERM'); } catch { /**/ } };
      opts.signal.addEventListener('abort', abort, { once: true });
      proc.on('exit', () => opts.signal!.removeEventListener('abort', abort));
    }

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
    proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });

    proc.on('exit', (code: number | null, signal: string | null) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        reject(new Error('Transcription cancelled'));
        return;
      }
      if (code !== 0) {
        reject(new Error(`whisper-cli exited ${code}: ${stderr.trim().slice(0, 300)}`));
        return;
      }
      const txtPath = opts.audioPath + '.txt';
      if (fs.existsSync(txtPath)) {
        const text = fs.readFileSync(txtPath, 'utf8').trim();
        try { fs.unlinkSync(txtPath); } catch { /* best-effort */ }
        resolve(text);
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on('error', (err: Error) => {
      reject(new Error(`Failed to spawn whisper-cli: ${err.message}`));
    });
  });
}