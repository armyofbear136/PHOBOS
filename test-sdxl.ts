// test-sdxl.ts — SDXL Turbo end-to-end test via PhobosLocalManager
// npx tsx test-sdxl.ts

import * as fs   from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  detectHardware,
  resolveSdServerBin,
  fluxModelPath,
  getImageModelSpec,
  IMAGE_SDXL_DIR,
} from './phobos/PhobosLocalManager.js';

// ── Configuration ─────────────────────────────────────────────────────────────
const MODEL_ID = process.env.SDXL_MODEL_ID ?? 'sdxl-turbo-fp16';
const PROMPT   = 'a red apple on a wooden table, studio lighting, photorealistic';
const NEG      = 'blurry, low quality, watermark, text';
const OUT_DIR  = path.resolve('./test-outputs');
const OUT      = path.join(OUT_DIR, `sdxl-${MODEL_ID}-${Date.now()}.png`);

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n=== SDXL Test: ${MODEL_ID} ===\n`);

// Step 1: Hardware
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
console.log(`  Backend: ${gpu?.backend ?? 'cpu'}\n`);

// Step 2: Resolve model from catalogue
console.log('Step 2: Looking up model in catalogue...');
const spec = getImageModelSpec(MODEL_ID);
if (!spec) {
  console.error(`  ✗ Model ID "${MODEL_ID}" not found in IMAGE_MODEL_CATALOGUE`);
  console.error('    Available SDXL models:');
  const { IMAGE_MODEL_CATALOGUE } = await import('./phobos/PhobosLocalManager.js');
  for (const m of IMAGE_MODEL_CATALOGUE.filter((s: any) => s.runnerProfile === 'sdxl')) {
    console.error(`      ${m.modelId} — ${m.label}`);
  }
  process.exit(1);
}
console.log(`  Model:   ${spec.label} (${spec.runnerProfile} runner)`);
console.log(`  File:    ${spec.hfFile}`);
console.log(`  Size:    ${(spec.sizeBytes / (1024 ** 3)).toFixed(1)} GB`);
console.log(`  VRAM:    ${spec.vramRequiredGb} GB required\n`);

// Step 3: Check file exists
console.log('Step 3: Checking model file on disk...');
const modelPath = fluxModelPath(spec);
if (!fs.existsSync(modelPath)) {
  console.error(`  ✗ Model file not found: ${modelPath}`);
  console.error(`\n  Download it:`);
  console.error(`    https://huggingface.co/${spec.hfRepo}/resolve/main/${spec.hfFile}`);
  console.error(`\n  Place it in: ${IMAGE_SDXL_DIR}/`);
  process.exit(1);
}
const fileSizeMb = (fs.statSync(modelPath).size / (1024 ** 2)).toFixed(0);
console.log(`  ✓ ${path.basename(modelPath)} (${fileSizeMb} MB)\n`);

// Step 4: Resolve binary
console.log('Step 4: Resolving sd-cli binary...');
const bin = resolveSdServerBin();
if (process.platform !== 'win32') {
  try { fs.chmodSync(bin, 0o755); } catch { /* ignore */ }
}
console.log(`  Binary:  ${path.relative('.', bin)}\n`);

// Step 5: Build args — matches the new buildSdxlArgs in ImageServerManager
const isTurbo = spec.modelId.includes('turbo');
const args = [
  '-m',                modelPath,
  '--prompt',          PROMPT,
  '--negative-prompt', NEG,
  '--steps',           String(isTurbo ? 4 : 25),
  '--width',           String(isTurbo ? 512 : 1024),
  '--height',          String(isTurbo ? 512 : 1024),
  '--seed',            '42',
  '--sampling-method', 'euler_a',
  '--cfg-scale',       String(isTurbo ? 0 : 7.0),
  '--vae-tiling',
  '--output',          path.resolve(OUT),
  '-v',
  // Live preview — sd-cli flag is 'proj' (lightweight linear projection, no VAE decode)
  '--preview',          'proj',
  '--preview-interval', '1',
  '--preview-path',     path.join(OUT_DIR, 'preview.png'),
];

console.log('Step 5: Generating image...');
console.log(`  Prompt:  "${PROMPT}"`);
console.log(`  Steps:   ${isTurbo ? 4 : 25} (${isTurbo ? 'Turbo' : 'Base'})`);
console.log(`  Size:    ${isTurbo ? '512×512' : '1024×1024'}`);
console.log(`  CFG:     ${isTurbo ? 0 : 7.0}`);
console.log(`  Preview: proj (writing to ${OUT_DIR}/preview.png)\n`);

fs.mkdirSync(OUT_DIR, { recursive: true });

const startMs = Date.now();
try {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   { ...process.env },
      cwd:   path.dirname(bin),
    });
    proc.stdout?.on('data', (d: Buffer) => {
      for (const l of d.toString().split('\n')) {
        const t = l.trim();
        if (t) console.log(`  [sd-cli] ${t}`);
      }
    });
    proc.stderr?.on('data', (d: Buffer) => {
      for (const l of d.toString().split('\n')) {
        const t = l.trim();
        if (t) console.log(`  [sd-cli] ${t}`);
      }
    });
    proc.on('exit', (code, sig) => {
      if (code === 0) resolve();
      else reject(new Error(`sd-cli exited with code ${code} (signal: ${sig})`));
    });
    proc.on('error', reject);
  });
} catch (err) {
  console.error(`\nFAIL: ${(err as Error).message}`);
  process.exit(1);
}

const elapsedMs = Date.now() - startMs;

if (!fs.existsSync(OUT)) {
  console.error('\nFAIL: sd-cli exited 0 but output file not found');
  process.exit(1);
}

const outKb = (fs.statSync(OUT).size / 1024).toFixed(0);
const previewExists = fs.existsSync(path.join(OUT_DIR, 'preview.png'));

console.log('\n=== PASS ===');
console.log(`  Output:   ${OUT} (${outKb} KB)`);
console.log(`  Seed:     42`);
console.log(`  Time:     ${(elapsedMs / 1000).toFixed(1)}s`);
console.log(`  Preview:  ${previewExists ? '✓ preview.png was written' : '✗ no preview file'}`);
console.log('');
