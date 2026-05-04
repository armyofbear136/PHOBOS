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
    path.join(binDir, file),
    path.join(_thisDir, '..', file),
    path.join(process.cwd(), 'dist', file),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `${file} not found. Expected in dist/ alongside phobos-core.exe.\n` +
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

// ── Kokoro ONNX model ─────────────────────────────────────────────────────────

function resolveKokoroModelDir(): string {
  const binDir = resolveBinDir();
  const candidates = [
    path.join(binDir, 'kokoro'),
    path.join(_thisDir, '..', 'kokoro'),
    path.join(process.cwd(), 'dist', 'kokoro'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'model_quantized.onnx'))) return c;
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
    ?? path.join(os.homedir(), '.phobos', 'workspaces');
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
}

async function resolvePythonDevice(): Promise<AudioDevice> {
  const hw = await detectHardware();
  for (const gpu of hw.gpus) {
    const vendor = gpuToVendor(gpu);
    if (!isVendorReady(vendor)) continue;
    const pyBin = getPythonPath(vendor);
    if (!pyBin) continue;
    const deviceArg = gpu.backend === 'cuda'  ? `cuda:${gpu.index}`
                    : gpu.backend === 'metal' ? 'mps'
                    : 'cpu';
    return { pythonBin: pyBin, deviceArg };
  }
  return { pythonBin: getPythonPath('cpu') ?? 'python3', deviceArg: 'cpu' };
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
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

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
  const modelFile = path.join(modelDir, 'model_quantized.onnx');

  // If local model dir doesn't have the full set of files kokoro-js needs,
  // fall back to the HF repo ID so the library fetches + caches automatically.
  // Once we've confirmed which files are required, we'll pin them all to local.
  const useLocalPath = fs.existsSync(modelFile);
  const modelSource  = useLocalPath ? modelDir : 'onnx-community/Kokoro-82M-v1.0-ONNX';
  if (!useLocalPath) {
    console.log('[AudioServerManager] Kokoro: local model incomplete, falling back to HF cache');
  }

  let KokoroTTS: any;
  try {
    // Dynamic import — kokoro-js is an optional runtime dep, not in tsconfig paths.
    // Using Function constructor avoids the static import() type check.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const mod = await (new Function('m', 'return import(m)'))('kokoro-js');
    KokoroTTS = mod.KokoroTTS;
  } catch {
    throw new Error('kokoro-js not installed. Run: npm install kokoro-js');
  }

  const outputPath = timestampedOutputPath(opts.threadId, 'tts', opts.label ?? 'kokoro');
  const startMs    = Date.now();

  opts.onProgress?.('[INFO ] Loading Kokoro ONNX model');
  const tts = await KokoroTTS.from_pretrained(modelSource, { dtype: 'q8' });

  opts.onProgress?.('[INFO ] Synthesizing');
  const audio = await tts.generate(opts.text, {
    voice: opts.voice ?? 'af_heart',
    speed: opts.speed ?? 1.0,
  });

  audio.save(outputPath);

  if (!fs.existsSync(outputPath)) {
    throw new Error('Kokoro synthesis completed but output file not found');
  }

  opts.onProgress?.('[INFO ] Done');
  return { outputPath, elapsedMs: Date.now() - startMs };
}

// ── TTS — F5-TTS (Python subprocess) ─────────────────────────────────────────

export interface F5TtsOptions extends AudioRunOptions {
  threadId:  string;
  text:      string;
  mode?:     'tts' | 'clone';
  refAudio?: string;
  refText?:  string;
  speed?:    number;
  steps?:    number;
  label?:    string;
}

export async function generateF5Tts(opts: F5TtsOptions): Promise<AudioGenerateResult> {
  const modelId = 'f5-tts-v1-base';
  const spec    = getAudioModelSpec(modelId);
  if (!spec)        throw new Error(`Unknown model: ${modelId}`);
  if (spec.blocked) throw new Error(`Model ${modelId} is not available in this release`);
  if (!isAudioModelDownloaded(spec)) {
    throw new Error(`F5-TTS model not downloaded. Run fetch-audio-deps.js --only f5tts`);
  }

  const { pythonBin, deviceArg } = await resolvePythonDevice();
  const scriptPath = resolveF5Script();
  const outputPath = timestampedOutputPath(opts.threadId, 'tts', opts.label ?? 'f5tts');
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
  await runProcess(pythonBin, args, outputPath, opts);
  return { outputPath, elapsedMs: Date.now() - startMs };
}

// ── Music — ACE-Step (C++: ace-lm pass then ace-synth pass) ──────────────────

export interface AceStepOptions extends AudioRunOptions {
  threadId:     string;
  prompt:       string;
  lyrics?:      string;
  duration?:    number;
  steps?:       number;
  cfgStrength?: number;
  seed?:        number;
  label?:       string;
}

export async function generateAceStep(opts: AceStepOptions): Promise<AudioGenerateResult> {
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
  const codesPath  = outputPath.replace('.wav', '.codes.json');
  const startMs    = Date.now();
  const duration   = opts.duration ?? 30;
  const seed       = (opts.seed !== undefined && opts.seed >= 0)
    ? opts.seed
    : Math.floor(Math.random() * 2 ** 31);

  // Pass 1 — ace-lm: prompt + lyrics → audio codes
  // ace-lm takes a JSON request file, not inline flags.
  // Output: writes <codesPath> (request JSON enriched with audio_codes field).
  const requestObj: Record<string, unknown> = {
    task:     'text2music',
    caption:  opts.prompt,
    duration,
    seed,
  };
  if (opts.lyrics) requestObj.lyrics = opts.lyrics;
  if (opts.cfgStrength !== undefined) requestObj.lm_cfg_scale = opts.cfgStrength;

  const requestPath = outputPath.replace('.wav', '.request.json');
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
  const synthArgs = [
    '--request',   synthRequestPath,
    '--embedding', embedModel,
    '--dit',       ditModel,
    '--vae',       vaeModel,
  ];

  opts.onProgress?.('[INFO ] ACE-Step pass 2/2: synthesis');
  console.log(`[AudioServerManager] ace-synth: ${aceSynth} ${synthArgs.join(' ')}`);
  await runProcess(aceSynth, synthArgs, outputPath, opts);

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
