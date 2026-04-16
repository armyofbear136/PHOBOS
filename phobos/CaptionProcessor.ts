/**
 * CaptionProcessor.ts — Manages phobos-caption.py subprocess.
 *
 * Installs Florence-2 deps into the existing inference venv if needed,
 * spawns the captioner, and yields progress events consumed by trainingRoutes.ts.
 */

import { spawn }      from 'child_process';
import * as fs        from 'fs';
import * as path      from 'path';
import * as os        from 'os';
import { execFile }   from 'child_process';
import { promisify }  from 'util';
import {
  getPythonPath,
  gpuToVendor,
  type GpuVendor,
} from './PythonEnvManager.js';
import { detectHardware } from './PhobosLocalManager.js';

const execFileAsync = promisify(execFile);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CaptionProgress {
  type:       'progress' | 'caption' | 'done' | 'error' | 'installing';
  /** 0–1 for progress events */
  ratio?:     number;
  /** filename for caption events */
  filename?:  string;
  /** caption text for caption events */
  caption?:   string;
  /** error message */
  message?:   string;
  /** output path for done event */
  outputFile?: string;
}

export interface CaptionOptions {
  imageDir:    string;
  outputFile:  string;
  triggerWord: string;
  device?:     string;   // defaults to 'auto'
  vendor?:     GpuVendor;
}

const CAPTION_DEPS = [
  'timm',
  'einops',
  // Florence-2 pulls flash-attn optionally; we skip it — cpu fallback works
];

// ── Dep install ───────────────────────────────────────────────────────────────

/** Installs Florence-2 extra deps into the active inference venv. Non-fatal if already present. */
export async function ensureCaptionDeps(vendor: GpuVendor): Promise<void> {
  const pyBin = getPythonPath(vendor);
  if (!pyBin) throw new Error(`No Python venv for vendor '${vendor}' — install PyTorch first`);

  // Quick check: can we import transformers already?
  try {
    await execFileAsync(pyBin, ['-c', 'import transformers, timm, einops; print("ok")'], { timeout: 15_000 });
    return; // already installed
  } catch { /* fall through to install */ }

  await execFileAsync(pyBin, [
    '-m', 'pip', 'install', '--quiet',
    'timm', 'einops', 'Pillow', 'torchvision',
  ], { timeout: 5 * 60 * 1000 });
}

// ── Main captioner ────────────────────────────────────────────────────────────

/**
 * Captions all images in imageDir using Florence-2.
 * Yields CaptionProgress events; resolves when the caption file is written.
 */
export async function* caption(opts: CaptionOptions): AsyncGenerator<CaptionProgress> {
  const { imageDir, outputFile, triggerWord, device = 'auto' } = opts;

  if (!fs.existsSync(imageDir)) {
    yield { type: 'error', message: `Image directory not found: ${imageDir}` };
    return;
  }

  // Resolve vendor from hardware if not provided
  let vendor = opts.vendor;
  if (!vendor) {
    const hw    = await detectHardware();
    const gpu   = hw.gpus[0];
    vendor = gpu ? gpuToVendor(gpu) : 'cpu';
  }

  const pyBin = getPythonPath(vendor);
  if (!pyBin) {
    yield { type: 'error', message: `PyTorch not installed for vendor '${vendor}'` };
    return;
  }

  // Ensure caption deps
  yield { type: 'installing', message: 'Checking Florence-2 dependencies…' };
  try {
    await ensureCaptionDeps(vendor);
  } catch (e) {
    yield { type: 'error', message: `Dep install failed: ${(e as Error).message}` };
    return;
  }

  const scriptPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'phobos-caption.py');
  if (!fs.existsSync(scriptPath)) {
    yield { type: 'error', message: `Caption script not found: ${scriptPath}` };
    return;
  }

  const args = [
    scriptPath,
    '--image-dir',    imageDir,
    '--output-file',  outputFile,
    '--trigger-word', triggerWord,
    '--device',       device,
  ];

  yield* _runCaption(pyBin, args);
}

async function* _runCaption(pyBin: string, args: string[]): AsyncGenerator<CaptionProgress> {
  const proc = spawn(pyBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let errBuf  = '';
  let lineBuf = '';
  let total   = 0;

  proc.stderr.on('data', (c: Buffer) => { errBuf += c.toString(); });

  const lines: string[]  = [];
  let   closed = false;

  proc.stdout.on('data', (chunk: Buffer) => {
    const parts = (lineBuf + chunk.toString()).split('\n');
    lineBuf     = parts.pop() ?? '';
    for (const l of parts) if (l.trim()) lines.push(l.trim());
  });

  proc.on('close', () => { closed = true; });

  // Poll lines until process closes
  while (!closed || lines.length > 0) {
    if (lines.length === 0) {
      await _sleep(50);
      continue;
    }

    const line = lines.shift()!;

    if (line.startsWith('PROGRESS ')) {
      const [cur, tot] = line.slice(9).split('/').map(Number);
      if (!total && tot) total = tot;
      yield { type: 'progress', ratio: total > 0 ? cur / total : 0 };

    } else if (line.startsWith('CAPTION ')) {
      const rest  = line.slice(8);
      const sep   = rest.indexOf('|||');
      const fname = sep >= 0 ? rest.slice(0, sep)   : rest;
      const cap   = sep >= 0 ? rest.slice(sep + 3)  : '';
      yield { type: 'caption', filename: fname, caption: cap };

    } else if (line === 'DONE') {
      yield { type: 'done', outputFile: args[args.indexOf('--output-file') + 1] };
      return;

    } else if (line.startsWith('ERROR ')) {
      yield { type: 'error', message: line.slice(6) };
      proc.kill('SIGTERM');
      return;

    } else if (line.startsWith('WARN ')) {
      // Non-fatal — log only
    }
  }

  // Process closed without DONE
  const exitErr = errBuf.trim().split('\n').slice(-5).join(' ');
  yield { type: 'error', message: exitErr || 'Caption process exited unexpectedly' };
}

function _sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
