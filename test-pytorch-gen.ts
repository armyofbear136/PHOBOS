/**
 * test-pytorch-gen.ts — End-to-end PyTorch image generation test.
 *
 * Spawns phobos-diffusers.py through the vendor-specific venv Python, using
 * existing downloaded models. Exercises the full TypeScript → Python → GPU path.
 *
 * Usage:
 *   npx tsx test-pytorch-gen.ts                          — Chroma on default GPU (CUDA preferred)
 *   npx tsx test-pytorch-gen.ts --vendor rocm            — Chroma on AMD ROCm GPU
 *   npx tsx test-pytorch-gen.ts --gpu 100                — Chroma on GPU index 100
 *   npx tsx test-pytorch-gen.ts sdxl                     — first downloaded SDXL
 *   npx tsx test-pytorch-gen.ts flux                     — first downloaded FLUX.1
 *   npx tsx test-pytorch-gen.ts kontext --ref-image ./test-outputs/reference.png
 *   npx tsx test-pytorch-gen.ts flux2                    — FLUX.2-klein-4B
 *   npx tsx test-pytorch-gen.ts z-image                  — Z-Image Turbo
 *   npx tsx test-pytorch-gen.ts qwen-image               — Qwen-Image
 *   npx tsx test-pytorch-gen.ts wan                      — Wan 2.1 T2V 1.3B (fastest)
 *   npx tsx test-pytorch-gen.ts --prompt "a cat"         — custom prompt
 *   npx tsx test-pytorch-gen.ts --no-offload             — skip offload even on small VRAM cards
 *   npx tsx test-pytorch-gen.ts --sage-attention         — enable SageAttention backend
 *   npx tsx test-pytorch-gen.ts --torch-compile          — enable torch.compile
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
  queryGpuFreeVram,
  FLUX_VAE,
  FLUX_CLIP_L,
  FLUX_T5_Q3,
  FLUX_T5_Q4,
  FLUX2_VAE,
  ZIMAGE_LLM_Q4,
  FLUX2_LLM_9B_Q4,
  QWEN_IMAGE_VAE,
  QWEN_IMAGE_LLM_Q4,
  WAN_VAE,
  WAN_T5_Q5,
  WAN_CLIP_VISION,
  IMAGE_MODEL_CATALOGUE,
} from './phobos/PhobosLocalManager.js';
import { getPythonPath, gpuToVendor, isVendorReady } from './phobos/PythonEnvManager.js';

const _dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT   = path.join(_dirname, 'phobos', 'phobos-diffusers.py');
const OUT_DIR  = path.resolve('./test-outputs');

// ── Parse args ───────────────────────────────────────────────────────────────

let modelType = 'chroma';
let customPrompt: string | null = null;
let forceVendor: string | null = null;
let forceGpuIdx: number | null = null;
let noOffload = false;
let sageAttention = false;
let torchCompile = false;
let refImage: string | null = null;

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--prompt' && process.argv[i + 1]) {
    customPrompt = process.argv[++i];
  } else if (arg === '--vendor' && process.argv[i + 1]) {
    forceVendor = process.argv[++i];
  } else if (arg === '--gpu' && process.argv[i + 1]) {
    forceGpuIdx = Number(process.argv[++i]);
  } else if (arg === '--no-offload') {
    noOffload = true;
  } else if (arg === '--sage-attention') {
    sageAttention = true;
  } else if (arg === '--torch-compile') {
    torchCompile = true;
  } else if (arg === '--ref-image' && process.argv[i + 1]) {
    refImage = process.argv[++i];
  } else if (!arg.startsWith('--')) {
    modelType = arg;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log('\n=== PyTorch Image Generation Test ===\n');

// Step 1: Hardware
console.log('Step 1: Detecting hardware…');
const hw = await detectHardware();

// GPU selection: --gpu N overrides, otherwise pick by vendor preference.
// For ROCm testing on the 890M, use --gpu 100 or --vendor rocm.
let bestGpu: typeof hw.gpus[0] | undefined;
if (forceGpuIdx !== null) {
  bestGpu = hw.gpus.find(g => g.index === forceGpuIdx);
  if (!bestGpu) {
    console.error(`FAIL: No GPU at index ${forceGpuIdx}. Available: ${hw.gpus.map(g => `[${g.index}] ${g.name}`).join(', ')}`);
    process.exit(1);
  }
} else if (forceVendor) {
  bestGpu = hw.gpus.find(g => gpuToVendor(g) === forceVendor);
  if (!bestGpu) {
    console.error(`FAIL: No GPU for vendor '${forceVendor}'. Available: ${hw.gpus.map(g => `[${g.index}] ${g.name} (${gpuToVendor(g)})`).join(', ')}`);
    process.exit(1);
  }
} else {
  // Default: prefer CUDA, then any GPU
  const cudaGpus = hw.gpus.filter(g => g.backend === 'cuda');
  bestGpu = cudaGpus[0] ?? hw.gpus[0];
}

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
    const sdxl = IMAGE_MODEL_CATALOGUE.filter(m =>
      m.runnerProfile === 'sdxl' && isImageModelDownloaded(m)
    );
    return sdxl[0] ?? null;
  }
  if (modelType === 'flux') {
    const flux = IMAGE_MODEL_CATALOGUE.filter(m =>
      m.runnerProfile === 'flux' && m.variant !== 'chroma' && isImageModelDownloaded(m)
    );
    return flux[0] ?? null;
  }
  if (modelType === 'kontext') {
    const k = IMAGE_MODEL_CATALOGUE.filter(m =>
      m.runnerProfile === 'flux1-kontext' && isImageModelDownloaded(m)
    );
    return k[0] ?? null;
  }
  if (modelType === 'flux2') {
    const f2 = IMAGE_MODEL_CATALOGUE.filter(m =>
      m.runnerProfile === 'flux2' && isImageModelDownloaded(m)
    );
    return f2[0] ?? null;
  }
  if (modelType === 'z-image') {
    const zi = IMAGE_MODEL_CATALOGUE.filter(m =>
      m.runnerProfile === 'z-image' && isImageModelDownloaded(m)
    );
    return zi[0] ?? null;
  }
  if (modelType === 'qwen-image') {
    const qi = IMAGE_MODEL_CATALOGUE.filter(m =>
      m.runnerProfile === 'qwen-image' && isImageModelDownloaded(m)
    );
    return qi[0] ?? null;
  }
  if (modelType === 'wan') {
    // Prefer 1.3B for quick testing, fall back to whatever is downloaded
    return getImageModelSpec('wan21-t2v-1.3b-q4') ??
      IMAGE_MODEL_CATALOGUE.filter(m =>
        m.runnerProfile === 'wan' && isImageModelDownloaded(m)
      )[0] ?? null;
  }
  // Direct model ID fallback
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
const isVideoRunner = spec.runnerProfile === 'wan';
const outExt = isVideoRunner ? '.avi' : '.png';
const outPath = path.join(OUT_DIR, `pytorch-${modelType}-${timestamp}${outExt}`);
fs.mkdirSync(OUT_DIR, { recursive: true });

const prompt = customPrompt ?? 'a majestic bear walking through a misty forest at dawn, golden light, photorealistic';

// ── model-type mapping ────────────────────────────────────────────────────────
const diffusersModelType = (() => {
  switch (spec.runnerProfile) {
    case 'flux':          return spec.variant === 'chroma' ? 'chroma' : 'flux';
    case 'flux1-kontext': return 'kontext';
    case 'flux2':         return 'flux2';
    case 'z-image':       return 'z-image';
    case 'qwen-image':    return 'qwen-image';
    case 'wan':           return 'wan';
    case 'sdxl':          return 'sdxl';
    default:              return 'flux';
  }
})();

const args: string[] = [
  SCRIPT,
  '--model-path', modelPath,
  '--model-type', diffusersModelType,
  '--prompt', prompt,
  '--steps', String(spec.profile?.defaultSteps ?? 20),
  '--width', String(spec.profile?.defaultWidth ?? 1024),
  '--height', String(spec.profile?.defaultHeight ?? 1024),
  '--cfg-scale', String(spec.profile?.defaultCfgScale ?? 3.5),
  '--seed', '42',
  '--dtype', 'bfloat16',
  '--output', outPath,
];

// Device selection: ROCm uses cuda:0 (HIP masquerade), XPU uses xpu:0, Metal uses mps.
// CUDA uses cuda:N where N is the nvidia-smi index.
let deviceStr: string;
switch (vendor) {
  case 'cuda':  deviceStr = `cuda:${bestGpu.index}`; break;
  case 'rocm':  deviceStr = 'cuda:0'; break;  // HIP masquerades as CUDA — always device 0 after HIP_VISIBLE_DEVICES
  case 'xpu':   deviceStr = 'xpu:0'; break;
  case 'apple': deviceStr = 'mps'; break;
  default:      deviceStr = 'cpu'; break;
}
args.push('--device', deviceStr);
console.log(`  Device:  ${deviceStr}`);

// CPU offload decision — mirrors ImageServerManager pre-flight VRAM check.
// Query LIVE free VRAM at this moment, compute total model footprint INCLUDING
// the T5 encoder, and decide: load everything (fast) or offload (safe).
//
// Per PHOBOS-Hardware-Reference.md:
//   Apple Silicon: offload is free (genuinely shared memory, zero-copy). Always offload.
//   AMD UMA (890M): offload is wasteful (real LPDDR5 copy). Only offload if model
//     actually exceeds the 48 GB partition — which it never will for current models.
//   Discrete GPUs: offload when total footprint exceeds live free VRAM.
const isApple = vendor === 'apple';
const isAmdUma = bestGpu.unifiedMemory === true && vendor === 'rocm';
const workingMb = vendor === 'cuda' ? 512 : 256; // CUDA context + attention buffers

// Query live free VRAM — nvidia-smi for CUDA, DXGI for AMD/Intel.
// queryGpuFreeVram returns undefined for unified memory GPUs, so for AMD UMA
// we use the full partition size as the budget (no live query needed — the
// partition is dedicated and not shared with other processes).
let freeVramMb: number;
if (isApple) {
  freeVramMb = hw.ramGb * 1024; // Apple: full system RAM
} else if (isAmdUma) {
  freeVramMb = bestGpu.vramGb * 1024; // 890M: full partition (48 GB)
} else {
  const liveFree = await queryGpuFreeVram(bestGpu);
  freeVramMb = liveFree ?? (bestGpu.vramGb * 1024 - 1536); // fallback: total minus 1.5 GB reserve
}
console.log(`  Free VRAM: ${freeVramMb} MB${isAmdUma ? ' (UMA partition)' : ''}`);

let useOffload = false;
let t5Pick: ReturnType<typeof recommendT5Encoder> | null = null;

// ── Hard rule: always offload on ≤12 GB discrete CUDA cards ──
// PyTorch's memory allocator, CUDA context, cuBLASLt workspace, T5 GGUF
// dequantization temp buffers, and diffusion attention caches collectively
// consume 1.5-2 GB beyond the model weights. On 10 GB cards this pushes
// total usage past physical VRAM into WDDM shared paging, which is 10-50x
// slower. The only reliable path is offload — load one component at a time.
// This matches sd-cli's cuBLASLt workspace suppression threshold (≤12 GB).
const alwaysOffload = !noOffload && (
  (vendor === 'cuda' && !bestGpu.unifiedMemory && bestGpu.vramGb <= 12) || isApple
);

if (alwaysOffload) {
  useOffload = true;
  const reason = isApple ? 'Apple Silicon — free' : `≤12 GB discrete CUDA (${bestGpu.vramGb} GB)`;
  console.log(`  Offload: yes (${reason} — always offload)`);
}

if (spec.runnerProfile === 'flux' || spec.variant === 'chroma') {
  // ── Step 1: Pick T5 tier first — its size affects the offload decision ──
  // When offload is forced (≤12 GB or Apple), T5 loads alone so pick the best tier.
  // When not forced, pick based on what fits with everything simultaneously.
  t5Pick = recommendT5Encoder(spec, useOffload ? freeVramMb / 1024 : freeVramMb / 1024, isAmdUma);
  const t5Mb = Math.ceil(t5Pick.sizeBytes / (1024 * 1024));

  // CLIP-L size (only for non-Chroma FLUX)
  const clipMb = spec.variant === 'chroma' ? 0 : 230;

  if (useOffload) {
    // Already forced — just log the budget breakdown
    const totalAllMb = spec.diffusionMb + t5Mb + clipMb + spec.vaeMb + workingMb;
    console.log(
      `  VRAM budget: diffusion ${spec.diffusionMb} + T5 ${t5Mb} + CLIP ${clipMb} ` +
      `+ VAE ${spec.vaeMb} + working ${workingMb} = ${totalAllMb} MB total (offload forced)`
    );
  } else {
    // ── Not forced — check if everything fits simultaneously ──
    const totalAllMb = spec.diffusionMb + t5Mb + clipMb + spec.vaeMb + workingMb;
    console.log(
      `  VRAM budget: diffusion ${spec.diffusionMb} + T5 ${t5Mb} + CLIP ${clipMb} ` +
      `+ VAE ${spec.vaeMb} + working ${workingMb} = ${totalAllMb} MB total`
    );

    if (totalAllMb <= freeVramMb) {
      console.log(`  Offload: no (${(totalAllMb / 1024).toFixed(1)} GB fits in ${(freeVramMb / 1024).toFixed(1)} GB free)`);
    } else {
      // Doesn't fit — try walking down T5 tiers before enabling offload.
      const t5Tiers = [t5Pick, FLUX_T5_Q4, FLUX_T5_Q3];
      let fitted = false;

      for (const candidate of t5Tiers) {
        const candMb = Math.ceil(candidate.sizeBytes / (1024 * 1024));
        const candTotal = spec.diffusionMb + candMb + clipMb + spec.vaeMb + workingMb;
        if (candTotal <= freeVramMb) {
          t5Pick = candidate;
          fitted = true;
          console.log(
            `  Offload: no (walked down to ${candidate.label} — ` +
            `${(candTotal / 1024).toFixed(1)} GB fits in ${(freeVramMb / 1024).toFixed(1)} GB free)`
          );
          break;
        }
      }

      if (!fitted) {
        useOffload = true;
        const peakMb = Math.max(spec.diffusionMb, t5Mb, spec.vaeMb);
        if (peakMb + workingMb > freeVramMb) {
          console.error(
            `FAIL: Even with offload, peak component ${(peakMb / 1024).toFixed(1)} GB ` +
            `+ working ${(workingMb / 1024).toFixed(1)} GB exceeds ` +
            `${(freeVramMb / 1024).toFixed(1)} GB free VRAM`
          );
          process.exit(1);
        }
        t5Pick = recommendT5Encoder(spec, freeVramMb / 1024, isAmdUma);
        console.log(
          `  Offload: yes (${(totalAllMb / 1024).toFixed(1)} GB > ${(freeVramMb / 1024).toFixed(1)} GB free ` +
          `— peak component ${(peakMb / 1024).toFixed(1)} GB fits with offload)`
        );
      }
    }
  }
} else {
  // SDXL / non-FLUX: simpler — no T5, just check model fits
  const totalMb = spec.diffusionMb + spec.vaeMb + workingMb;
  if (totalMb > freeVramMb) {
    useOffload = true;
    console.log(`  Offload: yes (model ${(totalMb / 1024).toFixed(1)} GB > ${(freeVramMb / 1024).toFixed(1)} GB free)`);
  } else {
    console.log(`  Offload: no (model ${(totalMb / 1024).toFixed(1)} GB fits in ${(freeVramMb / 1024).toFixed(1)} GB free)`);
  }
}

if (useOffload) {
  args.push('--offload-cpu');
}

// ── Aux files by runner ───────────────────────────────────────────────────────

if (spec.runnerProfile === 'flux' || spec.runnerProfile === 'flux1-kontext') {
  // FLUX.1 and Kontext: VAE + T5 + CLIP-L (Chroma skips CLIP-L)
  const vaePath = fluxAuxPath(FLUX_VAE);
  if (fs.existsSync(vaePath)) {
    args.push('--vae-path', vaePath);
    console.log(`  VAE:     ${path.basename(vaePath)}`);
  }

  if (t5Pick) {
    const t5Path = fluxAuxPath(t5Pick);
    if (fs.existsSync(t5Path)) {
      args.push('--t5-path', t5Path);
      console.log(`  T5:      ${t5Pick.label}`);
    } else {
      console.warn(`  T5:      ${t5Pick.label} — NOT DOWNLOADED, skipping`);
    }
  }

  if (spec.variant !== 'chroma') {
    const clipPath = fluxAuxPath(FLUX_CLIP_L);
    if (fs.existsSync(clipPath)) {
      args.push('--clip-path', clipPath);
      console.log(`  CLIP-L:  ${path.basename(clipPath)}`);
    }
  }

  // Kontext requires a reference image for editing
  if (spec.runnerProfile === 'flux1-kontext') {
    if (!refImage) {
      console.error('FAIL: kontext requires --ref-image <path>');
      console.error('  Example: npx tsx test-pytorch-gen.ts kontext --ref-image ./test-outputs/reference.png');
      process.exit(1);
    }
    if (!fs.existsSync(refImage)) {
      console.error(`FAIL: ref-image not found: ${refImage}`);
      process.exit(1);
    }
    args.push('--ref-image', refImage);
    console.log(`  Ref:     ${refImage}`);
  }

} else if (spec.runnerProfile === 'flux2') {
  // FLUX.2: flux2-vae + LLM encoder (Qwen3-4B for 4B, Qwen3-8B for 9B)
  const vaePath = fluxAuxPath(FLUX2_VAE);
  if (fs.existsSync(vaePath)) {
    args.push('--vae-path', vaePath);
    console.log(`  VAE:     ${path.basename(vaePath)}`);
  }
  const llmAux = spec.modelId.includes('9b') ? FLUX2_LLM_9B_Q4 : ZIMAGE_LLM_Q4;
  const llmPath = fluxAuxPath(llmAux);
  if (fs.existsSync(llmPath)) {
    args.push('--llm-path', llmPath);
    console.log(`  LLM:     ${llmAux.label}`);
  } else {
    console.warn(`  LLM:     ${llmAux.label} — NOT DOWNLOADED`);
  }

} else if (spec.runnerProfile === 'z-image') {
  // Z-Image: FLUX.1 VAE + Qwen3-4B LLM
  const vaePath = fluxAuxPath(FLUX_VAE);
  if (fs.existsSync(vaePath)) {
    args.push('--vae-path', vaePath);
    console.log(`  VAE:     ${path.basename(vaePath)}`);
  }
  const llmPath = fluxAuxPath(ZIMAGE_LLM_Q4);
  if (fs.existsSync(llmPath)) {
    args.push('--llm-path', llmPath);
    console.log(`  LLM:     ${ZIMAGE_LLM_Q4.label}`);
  } else {
    console.warn(`  LLM:     ${ZIMAGE_LLM_Q4.label} — NOT DOWNLOADED`);
  }

} else if (spec.runnerProfile === 'qwen-image') {
  // Qwen-Image: unique VAE + Qwen2.5-VL-7B LLM
  const vaePath = fluxAuxPath(QWEN_IMAGE_VAE);
  if (fs.existsSync(vaePath)) {
    args.push('--vae-path', vaePath);
    console.log(`  VAE:     ${path.basename(vaePath)}`);
  }
  const llmPath = fluxAuxPath(QWEN_IMAGE_LLM_Q4);
  if (fs.existsSync(llmPath)) {
    args.push('--llm-path', llmPath);
    console.log(`  LLM:     ${QWEN_IMAGE_LLM_Q4.label}`);
  } else {
    console.warn(`  LLM:     ${QWEN_IMAGE_LLM_Q4.label} — NOT DOWNLOADED`);
  }
  // flow-shift default for Qwen-Image
  args.push('--flow-shift', '3');

} else if (spec.runnerProfile === 'wan') {
  // Wan: WAN_VAE + WAN_T5 (UMT5-XXL, not FLUX T5) + optional CLIP Vision for I2V
  const vaePath = fluxAuxPath(WAN_VAE);
  if (fs.existsSync(vaePath)) {
    args.push('--vae-path', vaePath);
    console.log(`  VAE:     ${path.basename(vaePath)}`);
  }
  const t5Path = fluxAuxPath(WAN_T5_Q5);
  if (fs.existsSync(t5Path)) {
    args.push('--t5-path', t5Path);
    console.log(`  T5:      ${WAN_T5_Q5.label}`);
  } else {
    console.warn(`  T5:      ${WAN_T5_Q5.label} — NOT DOWNLOADED`);
  }
  // I2V models need CLIP Vision — skip if not downloaded, log a note
  if (spec.modelId.includes('i2v')) {
    const clipVisionPath = fluxAuxPath(WAN_CLIP_VISION);
    if (fs.existsSync(clipVisionPath)) {
      args.push('--clip-path', clipVisionPath);
      console.log(`  CLIP-V:  ${path.basename(clipVisionPath)}`);
    } else {
      console.warn(`  CLIP-V:  ${WAN_CLIP_VISION.label} — NOT DOWNLOADED (I2V will fail)`);
    }
  }
  // Wan-specific generation flags
  args.push('--num-frames', '49');
  args.push('--fps', '12');
  // Wan 2.2 MoE dual-expert needs flow-shift
  if (spec.modelId.startsWith('wan22')) {
    args.push('--flow-shift', '3.0');
  }
  console.log(`  Frames:  49 @ 12fps (4s)`);
}

console.log(`  Prompt:  "${prompt}"`);
console.log(`  Output:  ${outPath}`);

// Performance flags
if (sageAttention) { args.push('--sage-attention'); console.log('  Sage:    enabled'); }
if (torchCompile)  { args.push('--torch-compile');  console.log('  Compile: enabled'); }

// Step 5: Spawn
console.log('\nStep 5: Generating image (PyTorch)…\n');

// Build spawn environment with GPU targeting env vars
const spawnEnv: NodeJS.ProcessEnv = { ...process.env };
if (vendor === 'cuda') {
  spawnEnv.CUDA_VISIBLE_DEVICES = String(bestGpu.index);
} else if (vendor === 'rocm') {
  // PyTorch ROCm uses HIP_VISIBLE_DEVICES. On a system with only one AMD GPU
  // this is 0. On multi-AMD systems, compute from the device index.
  const hipIdx = bestGpu.index >= 100 ? bestGpu.index - 100 : bestGpu.index;
  spawnEnv.HIP_VISIBLE_DEVICES = String(hipIdx);
  // RDNA 2 compat override
  if (/RX\s*6[0-9]{3}/i.test(bestGpu.name)) {
    spawnEnv.HSA_OVERRIDE_GFX_VERSION = '10.3.0';
  }
}

const startMs = Date.now();

try {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(pyPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: spawnEnv,
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
// Wan outputs .avi which may be transcoded to .mp4, or falls back to PNG frames
let finalOutput = outPath;
if (isVideoRunner && !fs.existsSync(outPath)) {
  const mp4 = outPath.replace('.avi', '.mp4');
  const png = outPath.replace('.avi', '-frame0000.png');
  if (fs.existsSync(mp4))      finalOutput = mp4;
  else if (fs.existsSync(png)) finalOutput = png;
}

if (!fs.existsSync(finalOutput)) {
  console.error('FAIL: Process exited 0 but output file not found');
  process.exit(1);
}

const sizeKb = Math.round(fs.statSync(finalOutput).size / 1024);
console.log('=== PASS ===');
console.log(`  Output: ${finalOutput} (${sizeKb} KB)`);
console.log(`  Seed:   42`);
console.log(`  Time:   ${(elapsedMs / 1000).toFixed(1)}s`);
console.log('');
