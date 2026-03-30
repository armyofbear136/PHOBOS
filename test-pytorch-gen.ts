/**
 * test-pytorch-gen.ts — End-to-end PyTorch image generation test.
 *
 * Spawns phobos-diffusers.py through the CUDA venv Python, using
 * existing downloaded models. Exercises the full TypeScript → Python → GPU path.
 *
 * Usage:
 *   npx tsx test-pytorch-gen.ts                   — generate with Chroma (default)
 *   npx tsx test-pytorch-gen.ts chroma             — generate with Chroma GGUF
 *   npx tsx test-pytorch-gen.ts sdxl               — generate with first downloaded SDXL
 *   npx tsx test-pytorch-gen.ts --prompt "a cat"   — custom prompt
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import {
  detectHardware,
  getImageModelSpec,
  isImageModelDownloaded,
  fluxModelPath,
  fluxAuxPath,
  recommendT5Encoder,
  FLUX_VAE,
  FLUX_CLIP_L,
  IMAGE_MODEL_CATALOGUE,
} from './phobos/PhobosLocalManager.js';
import { getPythonPath, gpuToVendor, isVendorReady } from './phobos/PythonEnvManager.js';

const _dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT   = path.join(_dirname, 'phobos', 'phobos-diffusers.py');
const OUT_DIR  = path.resolve('./test-outputs');

// ── Parse args ───────────────────────────────────────────────────────────────

let modelType = 'chroma';
let customPrompt: string | null = null;

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--prompt' && process.argv[i + 1]) {
    customPrompt = process.argv[++i];
  } else if (!arg.startsWith('--')) {
    modelType = arg;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log('\n=== PyTorch Image Generation Test ===\n');

// Step 1: Hardware
console.log('Step 1: Detecting hardware…');
const hw = await detectHardware();
const cudaGpus = hw.gpus.filter(g => g.backend === 'cuda');
const bestGpu = cudaGpus[0] ?? hw.gpus[0];

if (!bestGpu) {
  console.error('FAIL: No GPU detected');
  process.exit(1);
}

const vendor = gpuToVendor(bestGpu);
console.log(`  GPU:     ${bestGpu.name} (${bestGpu.backend}, ${bestGpu.vramGb} GB)`);
console.log(`  Vendor:  ${vendor}`);

// Step 2: PyTorch environment
console.log('\nStep 2: Checking PyTorch environment…');
if (!isVendorReady(vendor)) {
  console.error(`FAIL: PyTorch ${vendor} environment not installed.`);
  console.error(`Run: npx tsx test-pytorch-env.ts install ${vendor}`);
  process.exit(1);
}

const pyPath = getPythonPath(vendor);
if (!pyPath) {
  console.error('FAIL: Python binary not found for vendor');
  process.exit(1);
}
console.log(`  Python:  ${pyPath}`);
console.log(`  Script:  ${SCRIPT}`);

// Step 3: Find model
console.log('\nStep 3: Resolving model…');

let spec = (() => {
  if (modelType === 'chroma') {
    return getImageModelSpec('chroma-q4');
  }
  if (modelType === 'sdxl') {
    // Find first downloaded SDXL
    const sdxl = IMAGE_MODEL_CATALOGUE.filter(m =>
      m.runnerProfile === 'sdxl' && isImageModelDownloaded(m)
    );
    return sdxl[0] ?? null;
  }
  // Try direct modelId
  return getImageModelSpec(modelType) ?? null;
})();

if (!spec) {
  console.error(`FAIL: No downloaded model found for type '${modelType}'`);
  process.exit(1);
}

if (!isImageModelDownloaded(spec)) {
  console.error(`FAIL: ${spec.label} not downloaded`);
  process.exit(1);
}

const modelPath = fluxModelPath(spec);
console.log(`  Model:   ${spec.label} (${spec.runnerProfile})`);
console.log(`  Path:    ${modelPath}`);

// Step 4: Build CLI args
console.log('\nStep 4: Building args…');

const timestamp = Date.now();
const outPath = path.join(OUT_DIR, `pytorch-${modelType}-${timestamp}.png`);
fs.mkdirSync(OUT_DIR, { recursive: true });

const prompt = customPrompt ?? 'a majestic bear walking through a misty forest at dawn, golden light, photorealistic';

const args: string[] = [
  SCRIPT,
  '--model-path', modelPath,
  '--model-type', spec.variant === 'chroma' ? 'chroma' : spec.runnerProfile === 'sdxl' ? 'sdxl' : 'flux',
  '--prompt', prompt,
  '--steps', String(spec.profile?.defaultSteps ?? 20),
  '--width', String(spec.profile?.defaultWidth ?? 1024),
  '--height', String(spec.profile?.defaultHeight ?? 1024),
  '--cfg-scale', String(spec.profile?.defaultCfgScale ?? 3.5),
  '--seed', '42',
  '--device', `cuda:0`,
  '--dtype', 'bfloat16',
  '--output', outPath,
  '--offload-cpu', // safe for all VRAM levels
];

// Aux files for FLUX/Chroma
if (spec.runnerProfile === 'flux' || spec.variant === 'chroma') {
  const vaePath = fluxAuxPath(FLUX_VAE);
  const t5 = recommendT5Encoder(spec, bestGpu.vramGb, false);
  const t5Path = fluxAuxPath(t5);

  if (fs.existsSync(vaePath)) {
    args.push('--vae-path', vaePath);
    console.log(`  VAE:     ${path.basename(vaePath)}`);
  }

  if (fs.existsSync(t5Path)) {
    args.push('--t5-path', t5Path);
    console.log(`  T5:      ${t5.label}`);
  }

  // CLIP-L — only for non-Chroma FLUX
  if (spec.variant !== 'chroma') {
    const clipPath = fluxAuxPath(FLUX_CLIP_L);
    if (fs.existsSync(clipPath)) {
      args.push('--clip-path', clipPath);
      console.log(`  CLIP-L:  ${path.basename(clipPath)}`);
    }
  }
}

console.log(`  Prompt:  "${prompt}"`);
console.log(`  Output:  ${outPath}`);

// Step 5: Spawn
console.log('\nStep 5: Generating image (PyTorch)…\n');

const startMs = Date.now();

try {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(pyPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    proc.stdout?.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        const trimmed = line.trim();
        if (trimmed) console.log(`  [pytorch] ${trimmed}`);
      }
    });

    proc.stderr?.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        const trimmed = line.trim();
        // Filter out torch warnings that aren't errors
        if (trimmed && !trimmed.includes('UserWarning') && !trimmed.includes('FutureWarning')) {
          console.log(`  [pytorch:err] ${trimmed}`);
        }
      }
    });

    proc.on('exit', (code, signal) => {
      if (code === 0 || signal === 'SIGTERM') resolve();
      else reject(new Error(`phobos-diffusers.py exited with code ${code} (signal: ${signal})`));
    });

    proc.on('error', reject);
  });
} catch (err) {
  console.error(`\nFAIL: ${(err as Error).message}`);
  process.exit(1);
}

const elapsedMs = Date.now() - startMs;

console.log('');
if (!fs.existsSync(outPath)) {
  console.error('FAIL: Process exited 0 but output file not found');
  process.exit(1);
}

const fileSizeKb = Math.round(fs.statSync(outPath).size / 1024);

console.log('=== PASS ===');
console.log(`  Output: ${outPath} (${fileSizeKb} KB)`);
console.log(`  Seed:   42`);
console.log(`  Time:   ${(elapsedMs / 1000).toFixed(1)}s`);
console.log('');
