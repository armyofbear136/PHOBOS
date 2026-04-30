/**
 * test-sdcli-validate-all.ts — Comprehensive sd-cli image model validation.
 *
 * Walks every image model family that sd-cli supports, runs a 1-step generation
 * on the best available GPU, and reports a full pass/fail matrix.
 *
 * Usage:
 *   npx tsx test-sdcli-validate-all.ts                    — validate all on best GPU
 *   npx tsx test-sdcli-validate-all.ts --binary cuda      — force CUDA binary
 *   npx tsx test-sdcli-validate-all.ts --binary vulkan    — force Vulkan binary
 *   npx tsx test-sdcli-validate-all.ts --binary rocm      — force ROCm binary
 *   npx tsx test-sdcli-validate-all.ts --skip-download    — only test already-downloaded models
 *   npx tsx test-sdcli-validate-all.ts --model chroma-q4  — single model only
 */

import * as fs    from 'fs';
import * as os    from 'os';
import * as path  from 'path';
import { spawn }  from 'child_process';
import { fileURLToPath } from 'url';
import {
  detectHardware,
  getImageModelSpec,
  isImageModelDownloaded,
  fluxModelPath,
  fluxAuxPath,
  highNoiseModelPath,
  recommendT5Encoder,
  queryGpuFreeVram,
  resolveSdServerBin,
  IMAGE_MODEL_CATALOGUE,
  FLUX_VAE,
  FLUX_CLIP_L,
  FLUX_T5_Q3,
  FLUX_T5_Q4,
  FLUX2_VAE,
  ZIMAGE_LLM_Q4,
  QWEN_IMAGE_VAE,
  QWEN_IMAGE_LLM_Q4,
  WAN_VAE,
  WAN_T5_Q5,
  KONTEXT_AUX_REQUIRED,
  type ImageModelSpec,
  type FluxAuxFile,
  type HardwareProfile,
  type GpuDevice,
} from './phobos/PhobosLocalManager.js';

const _dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR  = path.resolve('./test-outputs/sdcli-validate');

// Default PHOBOS_BIN_DIR to ./dist so test scripts work without env var on Windows.
// The env var is picked up by resolveSdServerBin() in PhobosLocalManager.
if (!process.env.PHOBOS_BIN_DIR) process.env.PHOBOS_BIN_DIR = path.resolve('./dist');

// ── CLI args ────────────────────────────────────────────────────────────────

const args           = process.argv.slice(2);
const _forceBinaryRaw = args.find(a => a.startsWith('--binary='))?.split('=')[1]
                       ?? (args.includes('--binary') ? args[args.indexOf('--binary') + 1] : undefined);
const forceBinary = _forceBinaryRaw as 'cuda' | 'vulkan' | 'rocm' | 'cpu' | undefined;
const skipDownload   = args.includes('--skip-download');
const modelFilter    = args.find(a => a.startsWith('--model='))?.split('=')[1]
                    ?? (args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined);

// ── Colour helpers ──────────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',  bold:   '\x1b[1m',  dim:    '\x1b[2m',
  green:  '\x1b[32m',  yellow: '\x1b[33m',  red:    '\x1b[31m',
  cyan:   '\x1b[36m',  white:  '\x1b[37m',
};
const ok   = (s: string) => `${C.green}✓${C.reset} ${s}`;
const fail = (s: string) => `${C.red}✗${C.reset} ${s}`;
const warn = (s: string) => `${C.yellow}⚠${C.reset} ${s}`;
const hdr  = (s: string) => `${C.bold}${C.cyan}${s}${C.reset}`;
const dim  = (s: string) => `${C.dim}${s}${C.reset}`;

// ── The validation matrix ───────────────────────────────────────────────────

interface SdCliValidationEntry {
  modelId:       string;
  runner:        string;        // runner profile from catalogue
  status:        'working' | 'blocked' | 'pending';
  notes:         string;
  isVideo:       boolean;       // wan outputs .avi
  needsRefImage: boolean;       // kontext requires -r
  vramRequiredGb: number;       // minimum VRAM to run without heavy spillover
}

const VALIDATION_MATRIX: SdCliValidationEntry[] = [
  // ── Image models ──
  {
    modelId: 'chroma-q4',           runner: 'flux',         status: 'working',
    notes: 'Chroma — FLUX arch, no CLIP-L, guidance=0.',
    isVideo: false,  needsRefImage: false,  vramRequiredGb: 8,
  },
  {
    modelId: 'sdxl-turbo-fp16',     runner: 'sdxl',         status: 'working',
    notes: 'SDXL Turbo — 4 steps, 512x512, single-file safetensors.',
    isVideo: false,  needsRefImage: false,  vramRequiredGb: 4,
  },
  {
    modelId: 'flux-schnell-q4',     runner: 'flux',         status: 'working',
    notes: 'FLUX.1-schnell — 4 steps, CLIP-L + T5 + VAE.',
    isVideo: false,  needsRefImage: false,  vramRequiredGb: 8,
  },
  {
    modelId: 'flux-dev-q4',         runner: 'flux',         status: 'working',
    notes: 'FLUX.1-dev — 20 steps, CLIP-L + T5 + VAE.',
    isVideo: false,  needsRefImage: false,  vramRequiredGb: 8,
  },
  {
    modelId: 'z-image-turbo-q4',    runner: 'z-image',      status: 'working',
    notes: 'Z-Image Turbo — uses --llm (Qwen3-4B) + FLUX VAE. --diffusion-fa required.',
    isVideo: false,  needsRefImage: false,  vramRequiredGb: 8,
  },
  {
    modelId: 'flux2-klein-4b-q4',   runner: 'flux2',        status: 'working',
    notes: 'FLUX.2 Klein 4B — uses --llm (Qwen3-4B) + FLUX2 VAE.',
    isVideo: false,  needsRefImage: false,  vramRequiredGb: 8,
  },
  {
    modelId: 'qwen-image-q4',       runner: 'qwen-image',   status: 'working',
    notes: 'Qwen-Image — uses --llm (Qwen2.5-VL-7B) + Qwen-Image VAE. Needs 16+ GB total.',
    isVideo: false,  needsRefImage: false,  vramRequiredGb: 16,
  },
  {
    modelId: 'kontext-dev-q5',      runner: 'flux1-kontext', status: 'working',
    notes: 'FLUX Kontext — requires -r (reference image). Uses test-outputs/reference.png.',
    isVideo: false,  needsRefImage: true,   vramRequiredGb: 10,
  },

  // ── Video models ──
  {
    modelId: 'wan21-t2v-1.3b-q4',   runner: 'wan',          status: 'working',
    notes: 'Wan 2.1 T2V 1.3B — video output (.avi).',
    isVideo: true,   needsRefImage: false,  vramRequiredGb: 8,
  },
  {
    modelId: 'wan22-t2v-14b-q4',    runner: 'wan',          status: 'blocked',
    notes: 'Wan 2.2 T2V 14B MoE — GGUF patch_embedding.weight dimension error in sd-cli. Upstream GGUF format issue.',
    isVideo: true,   needsRefImage: false,  vramRequiredGb: 16,
  },
];

// ── Result tracking ─────────────────────────────────────────────────────────

interface TestResult {
  modelId:  string;
  binary:   string;
  status:   'pass' | 'fail' | 'skip' | 'blocked';
  detail:   string;
  elapsedS: number;
}

const results: TestResult[] = [];

// ── Spawn helper ────────────────────────────────────────────────────────────

function runSdCli(
  bin: string, cliArgs: string[], env: NodeJS.ProcessEnv, timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];

    const proc = spawn(bin, cliArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: path.dirname(bin),
      timeout: timeoutMs,
    });

    proc.stdout?.on('data', (d: Buffer) => {
      const lines = d.toString().split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (t) {
          stdoutBuf.push(t);
          if (t.includes('/') || t.includes('loading') || t.includes('sampling')) {
            process.stdout.write(`    ${dim(t)}\r`);
          }
        }
      }
    });

    proc.stderr?.on('data', (d: Buffer) => {
      const lines = d.toString().split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (t) stderrBuf.push(t);
      }
    });

    proc.on('exit', (code) => {
      process.stdout.write('\x1b[2K\r');
      resolve({ code: code ?? 1, stdout: stdoutBuf.join('\n'), stderr: stderrBuf.join('\n') });
    });

    proc.on('error', (err) => {
      resolve({ code: 1, stdout: '', stderr: err.message });
    });
  });
}

// ── Build sd-cli args for a test run ────────────────────────────────────────

function buildTestArgs(
  entry: SdCliValidationEntry,
  spec: ImageModelSpec,
  gpu: GpuDevice,
  hw: HardwareProfile,
  freeVramMb: number,
  sdBinary: 'cuda' | 'vulkan' | 'rocm' | 'cpu',
): { cliArgs: string[]; env: NodeJS.ProcessEnv; outPath: string } {
  const modelPath = fluxModelPath(spec);
  const outExt = entry.isVideo ? '.avi' : '.png';
  const outPath = path.join(OUT_DIR, `sdcli-${entry.modelId}-${sdBinary}-${Date.now()}${outExt}`);
  // For wan, sd-cli auto-appends .avi — pass stem only
  const outArg = entry.isVideo ? outPath.replace(/\.avi$/, '') : outPath;

  const steps = 1;
  const seed = 1;
  const prompt = 'a red square on white background';
  const width  = spec.profile?.defaultWidth  ?? (spec.runnerProfile === 'sdxl' ? 512 : (entry.isVideo ? 832 : 1024));
  const height = spec.profile?.defaultHeight ?? (spec.runnerProfile === 'sdxl' ? 512 : (entry.isVideo ? 480 : 1024));

  const isAmdUma = gpu.unifiedMemory === true && gpu.vramGb >= 4;
  const offload = (gpu.backend === 'metal') ||
    (gpu.backend === 'cuda' && !gpu.unifiedMemory && gpu.vramGb <= 12);

  const cliArgs: string[] = [];

  // ── Per-runner arg construction ──
  const runner = spec.runnerProfile ?? entry.runner;

  if (runner === 'sdxl') {
    const isTurbo = spec.modelId.includes('turbo');
    const cfgScale = spec.profile?.defaultCfgScale ?? (isTurbo ? 1 : 7);
    const sampler = spec.profile?.defaultSampler ?? (isTurbo ? 'euler_a' : 'euler_a');
    cliArgs.push(
      '-m',                modelPath,
      '--prompt',          prompt,
      '--steps',           String(steps),
      '--width',           String(width),
      '--height',          String(height),
      '--seed',            String(seed),
      '--sampling-method', sampler,
      '--cfg-scale',       String(cfgScale),
      '--output',          outArg,
      '--vae-tiling',
    );
  } else if (runner === 'wan') {
    // Wan video gen — requires -M vid_gen, --vae, --t5xxl, --fps, --video-frames
    const vaePath = fluxAuxPath(WAN_VAE);
    const t5Path  = fluxAuxPath(WAN_T5_Q5);
    const cfgScale = spec.profile?.defaultCfgScale ?? 5;
    cliArgs.push(
      '-M',                'vid_gen',
      '--diffusion-model', modelPath,
      '--vae',             vaePath,
      '--t5xxl',           t5Path,
      '--prompt',          prompt,
      '--steps',           String(steps),
      '--width',           String(width),
      '--height',          String(height),
      '--seed',            String(seed),
      '--sampling-method', 'euler',
      '--scheduler',       'simple',
      '--cfg-scale',       String(cfgScale),
      '--fps',             '12',
      '--video-frames',    '5',
      '--diffusion-fa',
      '--clip-on-cpu',
      '--output',          outArg,
    );
    // Wan 2.2 MoE: add high-noise expert if present
    const hnPath = highNoiseModelPath(spec);
    if (hnPath && fs.existsSync(hnPath)) {
      cliArgs.push('--high-noise-diffusion-model', hnPath);
      cliArgs.push('--high-noise-steps', String(Math.max(1, Math.round(steps * 0.8))));
      cliArgs.push('--flow-shift', '3.0');
    }
  } else if (runner === 'z-image') {
    const vaePath = fluxAuxPath(FLUX_VAE);
    const llmPath = fluxAuxPath(ZIMAGE_LLM_Q4);
    cliArgs.push(
      '--diffusion-model', modelPath,
      '--vae',             vaePath,
      '--llm',             llmPath,
      '--prompt',          prompt,
      '--steps',           String(steps),
      '--width',           String(width),
      '--height',          String(height),
      '--seed',            String(seed),
      '--sampling-method', 'euler',
      '--guidance',        '1.0',
      '--diffusion-fa',
      '--output',          outArg,
      '--vae-tiling',
    );
  } else if (runner === 'flux2') {
    const vaePath = fluxAuxPath(FLUX2_VAE);
    const llmPath = fluxAuxPath(ZIMAGE_LLM_Q4); // Klein 4B uses same Qwen3-4B
    cliArgs.push(
      '--diffusion-model', modelPath,
      '--vae',             vaePath,
      '--llm',             llmPath,
      '--prompt',          prompt,
      '--steps',           String(steps),
      '--width',           String(width),
      '--height',          String(height),
      '--seed',            String(seed),
      '--sampling-method', 'euler',
      '--guidance',        '1.0',
      '--diffusion-fa',
      '--output',          outArg,
      '--vae-tiling',
    );
  } else if (runner === 'qwen-image') {
    const vaePath = fluxAuxPath(QWEN_IMAGE_VAE);
    const llmPath = fluxAuxPath(QWEN_IMAGE_LLM_Q4);
    cliArgs.push(
      '--diffusion-model', modelPath,
      '--vae',             vaePath,
      '--llm',             llmPath,
      '--prompt',          prompt,
      '--steps',           String(steps),
      '--width',           String(width),
      '--height',          String(height),
      '--seed',            String(seed),
      '--sampling-method', 'euler',
      '--guidance',        '2.5',
      '--diffusion-fa',
      '--output',          outArg,
      '--vae-tiling',
    );
  } else if (runner === 'flux1-kontext') {
    // Kontext shares FLUX.1 aux pool: VAE + CLIP-L + T5
    // --vae-decode-only false is required to encode the input image
    // -r <ref-image> is appended by the test loop
    const vaePath  = fluxAuxPath(FLUX_VAE);
    const t5       = recommendT5Encoder(spec, freeVramMb / 1024, isAmdUma);
    const t5Path   = fluxAuxPath(t5);
    const clipPath = fluxAuxPath(FLUX_CLIP_L);
    cliArgs.push(
      '--diffusion-model', modelPath,
      '--vae',             vaePath,
      '--t5xxl',           t5Path,
      '--clip_l',          clipPath,
      '--prompt',          prompt,
      '--steps',           String(steps),
      '--width',           String(width),
      '--height',          String(height),
      '--seed',            String(seed),
      '--sampling-method', 'euler',
      '--cfg-scale',       '1.0',
      '--output',          outArg,
      '--vae-tiling',
    );
  } else {
    // FLUX (dev, schnell) and Chroma
    const vaePath  = fluxAuxPath(FLUX_VAE);
    const t5       = recommendT5Encoder(spec, freeVramMb / 1024, isAmdUma);
    const t5Path   = fluxAuxPath(t5);
    const isChroma = spec.variant === 'chroma';
    const guidance = isChroma ? '0' : '3.5';

    cliArgs.push(
      '--diffusion-model', modelPath,
      '--vae',             vaePath,
      '--t5xxl',           t5Path,
      '--prompt',          prompt,
      '--steps',           String(steps),
      '--width',           String(width),
      '--height',          String(height),
      '--seed',            String(seed),
      '--sampling-method', 'euler',
      '--guidance',        guidance,
      '--output',          outArg,
      '--vae-tiling',
    );
    // FLUX needs CLIP-L, Chroma does not
    if (!isChroma) {
      const clipPath = fluxAuxPath(FLUX_CLIP_L);
      if (fs.existsSync(clipPath)) cliArgs.push('--clip_l', clipPath);
    }
  }

  if (offload) cliArgs.push('--offload-to-cpu');

  // ── Build environment ──
  const env: NodeJS.ProcessEnv = { ...process.env };

  if (sdBinary === 'cuda') {
    env.CUDA_VISIBLE_DEVICES = String(gpu.index);
    if (/\b50[6789]0\b|\bblackwell\b/i.test(gpu.name ?? '')) {
      env.CUDA_FORCE_PTX_JIT = '1';
    }
    if (gpu.vramGb <= 12) {
      env.CUBLAS_WORKSPACE_CONFIG = ':0:0';
      env.CUBLASLT_WORKSPACE_SIZE = '0';
    }
  } else if (sdBinary === 'rocm') {
    delete env.CUDA_VISIBLE_DEVICES;
    const hipIdx = gpu.index >= 100 ? gpu.index - 100 : gpu.index;
    env.HIP_VISIBLE_DEVICES = String(hipIdx);
    if (/RX\s*6[0-9]{3}/i.test(gpu.name ?? '')) {
      env.HSA_OVERRIDE_GFX_VERSION = '10.3.0';
    }
  } else if (sdBinary === 'vulkan') {
    delete env.CUDA_VISIBLE_DEVICES;
    const vkIdx = gpu.runner?.vulkanIndex ?? (gpu.index >= 100 ? gpu.index - 100 : gpu.index);
    env.GGML_VK_VISIBLE_DEVICES = String(vkIdx);
  } else {
    // CPU
    delete env.CUDA_VISIBLE_DEVICES;
    if (process.platform !== 'win32') {
      env.VK_ICD_FILENAMES = '/dev/null';
      env.VK_DRIVER_FILES  = '/dev/null';
    }
  }

  return { cliArgs, env, outPath };
}

// ── Main ────────────────────────────────────────────────────────────────────

console.log(`\n${hdr('═══ PHOBOS sd-cli IMAGE MODEL VALIDATION ═══')}\n`);

const hw = await detectHardware();
console.log(`CPU: ${hw.cpuName} (${hw.cpuCores} cores)`);
for (const gpu of hw.gpus) {
  console.log(`GPU[${gpu.index}]: ${gpu.name} — ${gpu.vramGb} GB ${gpu.backend.toUpperCase()}`);
}

if (hw.gpus.length === 0) {
  console.error(fail('No GPU detected'));
  process.exit(1);
}

// ── GPU selection strategy ──────────────────────────────────────────────────
// Mirrors production buildSdConfig: prefer fastest compute (CUDA > Metal > Vulkan),
// but fall back to higher-VRAM GPU when the model doesn't fit the fast GPU.
// On the dev laptop: 3080 (10 GB CUDA, fast) vs 890M (48 GB Vulkan/ROCm, slow).
// Models ≤10 GB total footprint → 3080. Models >10 GB → 890M.

const gpusByCompute = [...hw.gpus].sort((a, b) => {
  const score = (g: typeof hw.gpus[0]) => {
    if (g.backend === 'cuda') return 4;
    if (g.backend === 'metal') return 3;
    if (g.runner?.kind === 'amd-discrete') return 2;
    return 1;
  };
  return score(b) - score(a);
});

const fastGpu = gpusByCompute[0];
const bigGpu  = [...hw.gpus].sort((a, b) => b.vramGb - a.vramGb)[0];

function selectGpuForModel(entry: SdCliValidationEntry): GpuDevice {
  if (forceBinary) {
    // User forced a binary — find matching GPU
    if (forceBinary === 'cuda') return hw.gpus.find(g => g.backend === 'cuda') ?? fastGpu;
    if (forceBinary === 'rocm') return hw.gpus.find(g => /AMD|Radeon/i.test(g.name)) ?? bigGpu;
    return bigGpu;
  }
  // Auto-select: if the model fits the fast GPU (with offload headroom), use it.
  // Otherwise fall back to the biggest VRAM GPU.
  // sd-cli with --offload-to-cpu only needs the largest single component in VRAM,
  // but models with large LLM encoders still consume significant shared memory.
  // For clean test validation, prefer the GPU that can actually hold the model.
  if (entry.vramRequiredGb <= fastGpu.vramGb) {
    return fastGpu;
  }
  return bigGpu;
}

function binaryForGpu(gpu: GpuDevice): 'cuda' | 'vulkan' | 'rocm' | 'cpu' {
  if (forceBinary) return forceBinary;
  const candidate = (gpu.runner?.sdBinary as any) ?? (gpu.backend === 'cuda' ? 'cuda' : 'vulkan');
  // sd-cli ROCm is broken on 890M (gfx1150, RDNA 3.5) — STATUS_STACK_BUFFER_OVERRUN.
  // The HIP SDK 7.1 Wave32 bug prevents ROCm sd-cli from running on this GPU.
  // Override to Vulkan for sd-cli. PyTorch ROCm works fine (different runtime).
  if (candidate === 'rocm' && gpu.unifiedMemory === true) {
    return 'vulkan';
  }
  return candidate;
}

// Kontext reference image — use test-outputs/reference.png
const KONTEXT_REF_IMAGE = path.resolve('./test-outputs/reference.png');

// Filter entries
let entriesToTest = modelFilter
  ? VALIDATION_MATRIX.filter(e => e.modelId === modelFilter)
  : VALIDATION_MATRIX;

if (entriesToTest.length === 0) {
  console.error(fail(`No matching model: ${modelFilter}`));
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Run tests ───────────────────────────────────────────────────────────────

for (const entry of entriesToTest) {
  console.log(`\n  ${hdr(`▶ ${entry.modelId}`)} ${dim(`[${entry.runner}]`)}`);

  if (entry.status === 'blocked') {
    console.log(`    ${warn(`BLOCKED: ${entry.notes}`)}`);
    results.push({ modelId: entry.modelId, binary: '-', status: 'blocked', detail: entry.notes, elapsedS: 0 });
    continue;
  }

  if (entry.status === 'pending') {
    console.log(`    ${warn(`PENDING: ${entry.notes}`)}`);
    results.push({ modelId: entry.modelId, binary: '-', status: 'skip', detail: entry.notes, elapsedS: 0 });
    continue;
  }

  // Kontext ref image check
  if (entry.needsRefImage && !fs.existsSync(KONTEXT_REF_IMAGE)) {
    console.log(`    ${warn(`Reference image not found at ${KONTEXT_REF_IMAGE} — skipping`)}`);
    results.push({ modelId: entry.modelId, binary: '-', status: 'skip', detail: 'No reference image', elapsedS: 0 });
    continue;
  }

  // Check model downloaded
  const spec = getImageModelSpec(entry.modelId);
  if (!spec) {
    console.log(`    ${fail(`Model ${entry.modelId} not in catalogue`)}`);
    results.push({ modelId: entry.modelId, binary: '-', status: 'fail', detail: 'Not in catalogue', elapsedS: 0 });
    continue;
  }

  if (!isImageModelDownloaded(spec)) {
    if (skipDownload) {
      console.log(`    ${dim('Not downloaded — skipping (--skip-download)')}`);
      results.push({ modelId: entry.modelId, binary: '-', status: 'skip', detail: 'Not downloaded', elapsedS: 0 });
      continue;
    }
    console.log(`    ${warn('Not downloaded — use PHOBOS UI to download first')}`);
    results.push({ modelId: entry.modelId, binary: '-', status: 'skip', detail: 'Not downloaded', elapsedS: 0 });
    continue;
  }

  // ── Per-model GPU selection ──
  const gpu = selectGpuForModel(entry);
  const sdBinary = binaryForGpu(gpu);

  let bin: string;
  try {
    bin = resolveSdServerBin(sdBinary);
  } catch {
    console.log(`    ${fail(`sd-cli binary not found for ${sdBinary}`)}`);
    results.push({ modelId: entry.modelId, binary: sdBinary, status: 'fail', detail: `No ${sdBinary} binary`, elapsedS: 0 });
    continue;
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(bin, 0o755); } catch { /* ignore */ }
  }

  console.log(`    ${dim(`GPU: [${gpu.index}] ${gpu.name} (${sdBinary})`)}`);

  // Query free VRAM for this GPU
  const isAmdUma = gpu.unifiedMemory === true && gpu.vramGb >= 4;
  let freeVramMb: number;
  if (gpu.backend === 'metal') {
    freeVramMb = hw.ramGb * 1024;
  } else if (isAmdUma) {
    freeVramMb = gpu.vramGb * 1024;
  } else {
    freeVramMb = (await queryGpuFreeVram(gpu)) ?? (gpu.vramGb * 1024 - 1536);
  }

  // Check aux files exist
  let auxMissing = false;
  if (['flux', 'flux1-kontext'].includes(entry.runner) && spec.runnerProfile !== 'sdxl') {
    if (!fs.existsSync(fluxAuxPath(FLUX_VAE))) { console.log(`    ${fail('FLUX VAE not downloaded')}`); auxMissing = true; }
  }
  if (entry.runner === 'wan') {
    if (!fs.existsSync(fluxAuxPath(WAN_VAE))) { console.log(`    ${fail('Wan VAE not downloaded')}`); auxMissing = true; }
    if (!fs.existsSync(fluxAuxPath(WAN_T5_Q5))) { console.log(`    ${fail('Wan T5 not downloaded')}`); auxMissing = true; }
  }
  if (entry.runner === 'z-image') {
    if (!fs.existsSync(fluxAuxPath(ZIMAGE_LLM_Q4))) { console.log(`    ${fail('Z-Image LLM not downloaded')}`); auxMissing = true; }
  }
  if (entry.runner === 'flux2') {
    if (!fs.existsSync(fluxAuxPath(ZIMAGE_LLM_Q4))) { console.log(`    ${fail('FLUX.2 LLM not downloaded')}`); auxMissing = true; }
  }
  if (entry.runner === 'qwen-image') {
    if (!fs.existsSync(fluxAuxPath(QWEN_IMAGE_LLM_Q4))) { console.log(`    ${fail('Qwen-Image LLM not downloaded')}`); auxMissing = true; }
    if (!fs.existsSync(fluxAuxPath(QWEN_IMAGE_VAE))) { console.log(`    ${fail('Qwen-Image VAE not downloaded')}`); auxMissing = true; }
  }
  if (auxMissing) {
    results.push({ modelId: entry.modelId, binary: sdBinary, status: 'skip', detail: 'Aux files missing', elapsedS: 0 });
    continue;
  }

  // Build args and run
  const { cliArgs, env, outPath } = buildTestArgs(entry, spec, gpu, hw, freeVramMb, sdBinary);

  // Kontext: append -r ref image
  if (entry.needsRefImage) {
    cliArgs.push('-r', KONTEXT_REF_IMAGE);
  }

  const startMs = Date.now();
  const result = await runSdCli(bin, cliArgs, env, 30 * 60 * 1000);
  const elapsedS = (Date.now() - startMs) / 1000;

  // Check output exists
  let outputExists = fs.existsSync(outPath);
  if (!outputExists && entry.isVideo) {
    const aviPath = outPath.endsWith('.avi') ? outPath : outPath + '.avi';
    outputExists = fs.existsSync(aviPath);
  }

  if (result.code === 0 && outputExists) {
    console.log(`    ${ok(`PASS — ${elapsedS.toFixed(1)}s`)}`);
    results.push({ modelId: entry.modelId, binary: sdBinary, status: 'pass', detail: `${elapsedS.toFixed(1)}s`, elapsedS });
  } else if (result.code === 0 && !outputExists) {
    console.log(`    ${fail(`sd-cli exited 0 but no output file at ${outPath}`)}`);
    results.push({ modelId: entry.modelId, binary: sdBinary, status: 'fail', detail: 'No output file', elapsedS });
  } else {
    const errTail = (result.stderr || result.stdout).split('\n').slice(-3).join(' ').slice(0, 120);
    console.log(`    ${fail(`FAIL (exit ${result.code}): ${errTail}`)}`);
    results.push({ modelId: entry.modelId, binary: sdBinary, status: 'fail', detail: errTail, elapsedS });
  }
}

// ── Summary table ───────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(80)}`);
console.log(hdr('sd-cli VALIDATION SUMMARY'));
console.log('═'.repeat(80));

const pad = (s: string, w: number) => s.padEnd(w).slice(0, w);

console.log(
  `${C.bold}` +
  pad('Model', 25) +
  pad('Binary', 10) +
  pad('Status', 12) +
  pad('Time', 10) +
  C.reset
);
console.log('─'.repeat(80));

let failures = 0;
let passes = 0;
for (const r of results) {
  const statusStr = r.status === 'pass' ? `${C.green}PASS${C.reset}`
    : r.status === 'fail' ? `${C.red}FAIL${C.reset}`
    : r.status === 'blocked' ? `${C.yellow}BLOCK${C.reset}`
    : `${C.dim}skip${C.reset}`;

  const timeStr = r.elapsedS > 0 ? `${r.elapsedS.toFixed(1)}s` : '-';

  console.log(
    pad(r.modelId, 25) +
    pad(r.binary, 10) +
    statusStr.padEnd(22) +
    pad(timeStr, 10)
  );

  if (r.status === 'fail') {
    console.log(`  ${C.dim}${r.detail.slice(0, 100)}${C.reset}`);
    failures++;
  }
  if (r.status === 'pass') passes++;
}

console.log('═'.repeat(80));
const total = results.length;
const skips = results.filter(r => r.status === 'skip' || r.status === 'blocked').length;
if (failures === 0) {
  console.log(`${C.green}${C.bold}${passes} PASSED, ${skips} skipped, 0 failures${C.reset}`);
} else {
  console.log(`${C.red}${C.bold}${failures} FAILURES, ${passes} passed, ${skips} skipped${C.reset}`);
}
console.log('');

process.exit(failures > 0 ? 1 : 0);
