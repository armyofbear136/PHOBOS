/**
 * test-pytorch-convert.ts — Convert image models to diffusers format via phobos-convert.py
 *
 * Usage:
 *   npx tsx test-pytorch-convert.ts --model chroma-q4
 *   npx tsx test-pytorch-convert.ts --model flux-dev-q4 --vendor cuda
 *   npx tsx test-pytorch-convert.ts --model wan21-t2v-14b-q4 --dtype float16
 *   npx tsx test-pytorch-convert.ts --list
 *   npx tsx test-pytorch-convert.ts --model chroma-q4 --force   # re-convert even if present
 */

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { spawn }          from 'child_process';
import { fileURLToPath }  from 'url';
import {
  getImageModelSpec,
  fluxModelPath,
  IMAGE_FLUX_DIR,
  IMAGE_WAN_DIR,
} from './phobos/PhobosLocalManager.js';
import { getPythonPath }        from './phobos/PythonEnvManager.js';
import { getPytorchVariantDir } from './phobos/ImageServerManager.js';

const _dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Convert type mapping ─────────────────────────────────────────────────────
// Maps modelId prefix / variant to the --model-type arg phobos-convert.py accepts.

const CONVERT_TYPE_MAP: Record<string, string> = {
  'flux-schnell-q4':        'flux',
  'flux-schnell-q8':        'flux',
  'flux-dev-q4':            'flux',
  'flux-dev-q8':            'flux',
  'chroma-q4':              'chroma',
  'kontext-dev-q5':         'kontext',
  'flux2-klein-4b-q4':      'flux',
  'flux2-klein-9b-q4':      'flux',
  'z-image-turbo-q4':       'z-image',
  'z-image-base-q6':        'z-image',
  'qwen-image-q4':          'qwen-image',
  'wan21-t2v-1.3b-q4':      'wan',
  'wan21-t2v-14b-q4':       'wan',
  'wan21-i2v-14b-480p-q4':  'wan',
  'wan22-t2v-14b-q4':       'wan',
  'wan22-i2v-14b-q4':       'wan',
};

// GGUF file paths for models that don't go through fluxModelPath
// (Wan and others live in different dirs)
function resolveModelPath(modelId: string): string | null {
  const spec = getImageModelSpec(modelId);
  if (!spec) return null;

  // flux / chroma / kontext / z-image / qwen-image all use IMAGE_FLUX_DIR
  const fluxVariants = ['flux', 'chroma', 'kontext', 'z-image', 'qwen-image',
                        'flux2', 'qwen-image'];
  const convertType = CONVERT_TYPE_MAP[modelId];
  if (convertType && ['flux','chroma','kontext','z-image','qwen-image'].includes(convertType)) {
    return fluxModelPath(spec as any);
  }
  if (convertType === 'wan') {
    return path.join(IMAGE_WAN_DIR(), spec.hfFile);
  }
  return fluxModelPath(spec as any);
}

function resolveConvertScript(): string {
  const candidates = [
    path.join(_dirname, 'phobos', 'phobos-convert.py'),
    path.join(_dirname, 'dist', 'phobos-convert.py'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('phobos-convert.py not found. Searched:\n  ' + candidates.join('\n  '));
}

function pytorchVariantRoot(): string {
  return path.join(os.homedir(), '.phobos', 'models', 'image', 'pytorch');
}

// ── CLI args ─────────────────────────────────────────────────────────────────

let modelId: string | null  = null;
let vendor  = 'cuda';
let dtype   = 'bfloat16';
let force   = false;
let listOnly = false;

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--list') {
    listOnly = true;
  } else if (arg === '--force') {
    force = true;
  } else if (arg === '--model' || arg === '--model-id') {
    modelId = process.argv[++i];
  } else if (arg === '--vendor') {
    vendor = process.argv[++i];
  } else if (arg === '--dtype') {
    dtype = process.argv[++i];
  } else if (!arg.startsWith('--') && !modelId) {
    modelId = arg;
  }
}

// ── --list ───────────────────────────────────────────────────────────────────

if (listOnly) {
  console.log('\nConvertible image models:\n');
  const outRoot = pytorchVariantRoot();
  const colW = 26;
  console.log(`  ${'Model ID'.padEnd(colW)}  ${'Type'.padEnd(12)}  ${'Converted?'}`);
  console.log('  ' + '─'.repeat(colW + 28));
  for (const [mid, ctype] of Object.entries(CONVERT_TYPE_MAP)) {
    const spec = getImageModelSpec(mid);
    if (!spec) continue;
    const variantDir = getPytorchVariantDir(mid);
    const status = variantDir ? `✅  ${variantDir}` : '—';
    console.log(`  ${mid.padEnd(colW)}  ${ctype.padEnd(12)}  ${status}`);
  }
  console.log('');
  process.exit(0);
}

// ── Validate args ─────────────────────────────────────────────────────────────

if (!modelId) {
  console.error('Usage: npx tsx test-pytorch-convert.ts --model <model-id> [--vendor cuda|rocm] [--dtype bfloat16|float16] [--force]');
  console.error('       npx tsx test-pytorch-convert.ts --list');
  process.exit(1);
}

const convertType = CONVERT_TYPE_MAP[modelId];
if (!convertType) {
  console.error(`Unknown model ID: ${modelId}`);
  console.error(`Known IDs: ${Object.keys(CONVERT_TYPE_MAP).join(', ')}`);
  process.exit(1);
}

const spec = getImageModelSpec(modelId);
if (!spec) {
  console.error(`Model not in catalogue: ${modelId}`);
  process.exit(1);
}

const modelPath = resolveModelPath(modelId);
if (!modelPath) {
  console.error(`Could not resolve model path for: ${modelId}`);
  process.exit(1);
}

const outDir    = pytorchVariantRoot();
const variantDir = path.join(outDir, modelId);

// ── Header ───────────────────────────────────────────────────────────────────

console.log('\n=== PHOBOS PyTorch Model Conversion ===\n');
console.log(`  Model ID   : ${modelId}`);
console.log(`  Label      : ${spec.label}`);
console.log(`  Type       : ${convertType}`);
console.log(`  Source     : ${modelPath}`);
console.log(`  Output     : ${variantDir}`);
console.log(`  Dtype      : ${dtype}`);
console.log(`  Vendor     : ${vendor}`);
console.log('');

// ── Pre-flight checks ─────────────────────────────────────────────────────────

if (!fs.existsSync(modelPath)) {
  console.error(`FAIL: source GGUF not found: ${modelPath}`);
  console.error('      Download the model first before converting.');
  process.exit(1);
}

const pyBin = getPythonPath(vendor as any);
if (!pyBin || !fs.existsSync(pyBin)) {
  console.error(`FAIL: Python env for vendor '${vendor}' not found.`);
  console.error('      Run the app once to install the Python environment.');
  process.exit(1);
}

const convertScript = (() => {
  try { return resolveConvertScript(); }
  catch (e) { console.error(`FAIL: ${(e as Error).message}`); process.exit(1); }
})()!;

const alreadyDone = getPytorchVariantDir(modelId);
if (alreadyDone && !force) {
  console.log(`Already converted: ${alreadyDone}`);
  console.log('Pass --force to re-convert.');
  process.exit(0);
}

if (alreadyDone && force) {
  console.log(`--force set — removing existing conversion at ${alreadyDone}`);
  fs.rmSync(alreadyDone, { recursive: true, force: true });
}

// ── Spawn phobos-convert.py ───────────────────────────────────────────────────

const args = [
  convertScript,
  '--model-path', modelPath,
  '--model-type', convertType,
  '--model-id',   modelId,
  '--output-dir', outDir,
  '--dtype',      dtype,
];

console.log(`Running: ${pyBin} ${args.join(' ')}\n`);

const t0   = Date.now();
const proc = spawn(pyBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

// phobos-convert.py emits JSON lines on stdout: { event, pct, label }
proc.stdout.on('data', (chunk: Buffer) => {
  for (const line of chunk.toString().split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed) as { event: string; pct: number; label: string };
      const pct = `${Math.round((msg.pct ?? 0) * 100)}%`.padStart(4);
      console.log(`  [${msg.event ?? '?'}] ${pct}  ${msg.label ?? ''}`);
    } catch {
      console.log(`  ${trimmed}`);
    }
  }
});

proc.stderr.on('data', (chunk: Buffer) => {
  process.stderr.write(chunk);
});

proc.on('close', (code) => {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('');
  if (code !== 0) {
    console.error(`FAIL: phobos-convert.py exited with code ${code} (${elapsed}s)`);
    process.exit(1);
  }
  const result = getPytorchVariantDir(modelId!);
  if (!result) {
    console.error(`FAIL: conversion reported success but variant dir not found at ${variantDir}`);
    process.exit(1);
  }
  console.log(`OK — converted in ${elapsed}s`);
  console.log(`   Output: ${result}`);
  process.exit(0);
});
