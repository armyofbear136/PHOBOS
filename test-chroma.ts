// test-chroma.ts — Chroma1-HD end-to-end CLI test
// npx tsx test-chroma.ts

import * as fs   from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  detectHardware,
  resolveSdServerBin,
  fluxModelPath,
  fluxAuxPath,
  getImageModelSpec,
  recommendT5Encoder,
  FLUX_VAE,
} from './phobos/PhobosLocalManager.js';

const PROMPT  = 'close up gaping vagina';
const OUT_DIR = path.resolve('./test-outputs');
const OUT     = path.join(OUT_DIR, `chroma-test-${Date.now()}.png`);

// ── Chroma-specific arg builder ───────────────────────────────────────────────
// FLUX delta: no --clip_l, add --chroma-use-dit-mask, guidance 0 (unconditional).

function buildChromaArgs(
  modelPath: string,
  vaePath:   string,
  t5Path:    string,
  outPath:   string,
  prompt:    string,
): string[] {
  return [
    '--diffusion-model',    modelPath,
    '--vae',                vaePath,
    // NO --clip_l — Chroma trained without CLIP-L conditioning pathway
    '--t5xxl',              t5Path,
    // --chroma-use-dit-mask removed: dit mask is ON by default in sd.cpp (commit d6dd6d7+).
    // Inverse flag --chroma-disable-dit-mask exists if needed. Do not pass anything.
    '--prompt',             prompt,
    '--steps',              '20',
    '--width',              '1024',
    '--height',             '1024',
    '--seed',               '42',
    '--sampling-method',    'euler',
    '--guidance',           '0',      // unconditional — CFG disabled by design
    '--output',             outPath,
  ];
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n=== Chroma1-HD End-to-End Test ===\n');

console.log('Step 1: Detecting hardware...');
const hw  = await detectHardware();
const gpu = [...hw.gpus].sort((a, b) =>
  (b.unifiedMemory || b.index >= 100 ? 0 : b.index >= 100 ? 0 : b.vramGb) -
  (a.unifiedMemory || a.index >= 100 ? 0 : a.index >= 100 ? 0 : a.vramGb)
)[0];
const totalVram  = gpu?.vramGb       ?? 0;
const isUnified  = gpu?.unifiedMemory ?? false;
console.log(`  GPU:        ${gpu?.name ?? 'none'}`);
console.log(`  VRAM:       ${totalVram} GB${isUnified ? ' (unified)' : ''}`);
console.log(`  Backend:    ${gpu?.backend ?? 'cpu'}`);
console.log('');

console.log('Step 2: Resolving Chroma model and aux paths...');
const spec = getImageModelSpec('chroma-q4');
if (!spec) {
  console.error('FAIL: chroma-q4 not found in IMAGE_MODEL_CATALOGUE');
  process.exit(1);
}
const t5        = recommendT5Encoder(spec, totalVram, isUnified);
const modelPath = fluxModelPath(spec);
const vaePath   = fluxAuxPath(FLUX_VAE);
const t5Path    = fluxAuxPath(t5);

console.log(`  Model:      ${spec.label}`);
console.log(`  T5:         ${t5.label}`);
console.log(`  Aux:        ${FLUX_VAE.label} + ${t5.label} (NO CLIP-L)`);
console.log('');

console.log('Step 3: Verifying files exist on disk...');
const required: [string, string][] = [
  ['model', modelPath],
  ['vae',   vaePath],
  ['t5',    t5Path],
];
let missing = false;
for (const [label, p] of required) {
  if (fs.existsSync(p)) {
    console.log(`  ✓ ${label}: ${path.basename(p)}`);
  } else {
    console.error(`  ✗ ${label} MISSING: ${p}`);
    missing = true;
  }
}
if (missing) {
  console.error('\nFAIL: Download chroma-q4 (and FLUX aux files) before running this test.');
  process.exit(1);
}
console.log('');

console.log('Step 4: Generating image (sd-cli load → generate → exit)...');
console.log(`  Prompt: "${PROMPT}"`);
fs.mkdirSync(OUT_DIR, { recursive: true });

const bin  = resolveSdServerBin();
if (process.platform !== 'win32') {
  try { fs.chmodSync(bin, 0o755); } catch { /* ignore */ }
}
const args = buildChromaArgs(modelPath, vaePath, t5Path, path.resolve(OUT), PROMPT);

console.log('');
console.log(`  Binary: ${path.basename(bin)}`);
console.log(`  Args:   ${args.join(' ')}`);
console.log('');

const startMs = Date.now();
try {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   { ...process.env },
      cwd:   path.dirname(bin),
    });
    proc.stdout?.on('data', (d: Buffer) => { const l = d.toString().trim(); if (l) console.log(`  [sd-cli] ${l}`); });
    proc.stderr?.on('data', (d: Buffer) => { const l = d.toString().trim(); if (l) console.log(`  [sd-cli] ${l}`); });
    proc.on('exit',  (code, sig) => code === 0 ? resolve() : reject(new Error(`exit ${code} (signal: ${sig})`)));
    proc.on('error', reject);
  });
} catch (err) {
  console.error(`\nFAIL: ${(err as Error).message}`);
  process.exit(1);
}

const elapsedMs = Date.now() - startMs;

console.log('');
if (!fs.existsSync(OUT)) {
  console.error('FAIL: sd-cli exited 0 but output file not found');
  process.exit(1);
}

console.log('=== PASS ===');
console.log(`  Output: ${OUT}`);
console.log(`  Seed:   42`);
console.log(`  Time:   ${(elapsedMs / 1000).toFixed(1)}s`);
console.log('');
