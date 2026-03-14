// test-sdxl.ts — RealVisXL V5 end-to-end CLI test
// npx tsx test-sdxl.ts

import * as fs   from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  detectHardware,
  resolveSdServerBin,
  fluxModelPath,
  fluxAuxPath,
  getImageModelSpec,
  SDXL_CLIP_L,
  SDXL_CLIP_G,
  SDXL_VAE,
} from './phobos/PhobosLocalManager.js';

const PROMPT  = 'a red apple on a wooden table, studio lighting, photorealistic';
const OUT_DIR = path.resolve('./test-outputs');
const OUT     = path.join(OUT_DIR, `sdxl-test-${Date.now()}.png`);

// ── SDXL arg builder ──────────────────────────────────────────────────────────
// hum-ma GGUFs are UNet-only (quantized via llama.cpp, not sd.cpp).
// Must use --diffusion-model (not -m) + explicit --vae + --clip_l + --clip_g.
// --cfg-scale instead of --guidance. euler_a sampler preferred.

function buildSdxlArgs(
  modelPath: string,
  vaePath:   string,
  clipLPath: string,
  clipGPath: string,
  outPath:   string,
  prompt:    string,
): string[] {
  return [
    '--diffusion-model', modelPath,
    '--vae',             vaePath,
    '--clip_l',          clipLPath,
    '--clip_g',          clipGPath,
    '--prediction',      'eps',
    '--force-sdxl-vae-conv-scale',   // required for SDXL VAE in split-file mode
    '--prompt',          prompt,
    '--steps',           '25',
    '--width',           '1024',
    '--height',          '1024',
    '--seed',            '42',
    '--sampling-method', 'euler_a',
    '--cfg-scale',       '7.0',
    '--output',          outPath,
  ];
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n=== RealVisXL V5 End-to-End Test ===\n');

console.log('Step 1: Detecting hardware...');
const hw  = await detectHardware();
const backendScore = (g: typeof hw.gpus[0]): number =>
  (g.unifiedMemory || g.index >= 100) ? 0
  : g.backend === 'cuda'  ? 3
  : g.backend === 'metal' ? 2
  : 1;
const gpu = [...hw.gpus].sort((a, b) => {
  const d = backendScore(b) - backendScore(a);
  return d !== 0 ? d : b.vramGb - a.vramGb;
})[0];
console.log(`  GPU:     ${gpu?.name ?? 'none'}`);
console.log(`  VRAM:    ${gpu?.vramGb ?? 0} GB${gpu?.unifiedMemory ? ' (unified)' : ''}`);
console.log(`  Backend: ${gpu?.backend ?? 'cpu'}`);
console.log('');

console.log('Step 2: Resolving RealVisXL model and aux paths...');
const spec = getImageModelSpec('realvis-xl-v5-q4');
if (!spec) {
  console.error('FAIL: realvis-xl-v5-q4 not found in IMAGE_MODEL_CATALOGUE');
  process.exit(1);
}
const modelPath = fluxModelPath(spec);
const vaePath   = fluxAuxPath(SDXL_VAE);
const clipLPath = fluxAuxPath(SDXL_CLIP_L);
const clipGPath = fluxAuxPath(SDXL_CLIP_G);

console.log(`  Model:  ${spec.label}`);
console.log(`  Aux:    ${SDXL_VAE.label} + ${SDXL_CLIP_L.label} + ${SDXL_CLIP_G.label}`);
console.log('');

console.log('Step 3: Verifying files exist on disk...');
const required: [string, string][] = [
  ['model',  modelPath],
  ['vae',    vaePath],
  ['clip_l', clipLPath],
  ['clip_g', clipGPath],
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
  console.error('\nFAIL: Missing files. Download realvis-xl-v5-q4 and all SDXL aux files first.');
  process.exit(1);
}
console.log('');

console.log('Step 4: Generating image (sd-cli load → generate → exit)...');
console.log(`  Prompt: "${PROMPT}"`);
fs.mkdirSync(OUT_DIR, { recursive: true });

const bin = resolveSdServerBin();
if (process.platform !== 'win32') {
  try { fs.chmodSync(bin, 0o755); } catch { /* ignore */ }
}
const args = buildSdxlArgs(modelPath, vaePath, clipLPath, clipGPath, path.resolve(OUT), PROMPT);

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
