/**
 * test-pytorch-validate-all.ts — Comprehensive PyTorch image model validation.
 *
 * Walks every image model family that phobos-diffusers.py supports, downloads
 * any missing models, runs a 1-step generation on each available GPU, and
 * reports a full pass/fail matrix. Optionally tests SageAttention and Triton.
 *
 * Usage:
 *   npx tsx test-pytorch-validate-all.ts                    — validate all on default GPU
 *   npx tsx test-pytorch-validate-all.ts --vendor rocm      — validate all on 890M
 *   npx tsx test-pytorch-validate-all.ts --vendor cuda      — validate all on RTX 3080
 *   npx tsx test-pytorch-validate-all.ts --all-gpus         — validate on every available GPU
 *   npx tsx test-pytorch-validate-all.ts --sage             — include SageAttention tests
 *   npx tsx test-pytorch-validate-all.ts --triton           — include torch.compile/Triton tests
 *   npx tsx test-pytorch-validate-all.ts --skip-download    — only test already-downloaded models
 *   npx tsx test-pytorch-validate-all.ts --model chroma-q4  — single model only
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
  recommendT5Encoder,
  queryGpuFreeVram,
  IMAGE_MODEL_CATALOGUE,
  FLUX_VAE,
  FLUX_CLIP_L,
  FLUX_T5_Q3,
  FLUX_T5_Q4,
  ZIMAGE_LLM_Q4,
  QWEN_IMAGE_LLM_Q4,
  QWEN_IMAGE_VAE,
  type ImageModelSpec,
  type HardwareProfile,
  type GpuDevice,
} from './phobos/PhobosLocalManager.js';
import { getPythonPath, gpuToVendor, isVendorReady, type GpuVendor } from './phobos/PythonEnvManager.js';

const _dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT   = path.join(_dirname, 'phobos', 'phobos-diffusers.py');
const OUT_DIR  = path.resolve('./test-outputs/validate');

// ── CLI args ────────────────────────────────────────────────────────────────

const args          = process.argv.slice(2);
const forceVendor   = args.find(a => a.startsWith('--vendor='))?.split('=')[1]
                   ?? (args.includes('--vendor') ? args[args.indexOf('--vendor') + 1] : undefined);
const allGpus       = args.includes('--all-gpus');
const testSage      = args.includes('--sage');
const testTriton    = args.includes('--triton');
const skipDownload  = args.includes('--skip-download');
const modelFilter   = args.find(a => a.startsWith('--model='))?.split('=')[1]
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
//
// One representative model per unique pipeline path. This is the minimum set
// that exercises every code path in phobos-diffusers.py. Testing all quant
// variants of the same architecture is redundant — one Q4 is enough.
//
// Models are listed in order of priority: most important first.

interface ValidationEntry {
  modelId:       string;        // ID from IMAGE_MODEL_CATALOGUE
  modelTypeArg:  string;        // --model-type value for phobos-diffusers.py
  pipelinePath:  string;        // which code path in load_pipeline()
  pytorchStatus: 'working' | 'load-only' | 'blocked' | 'pending';
  needsAux:      boolean;       // needs VAE/T5/CLIP aux files
  notes:         string;
  sageCompatible: boolean;      // safe to test with SageAttention
  tritonCompatible: boolean;    // safe to test with torch.compile
  vramRequiredGb: number;       // minimum VRAM to run without heavy spillover
}

const VALIDATION_MATRIX: ValidationEntry[] = [
  // ── Fully working — full generation test ──
  {
    modelId: 'chroma-q4',          modelTypeArg: 'chroma',  pipelinePath: 'GGUF ChromaPipeline',
    pytorchStatus: 'working',      needsAux: true,
    notes: 'Primary test model. FLUX arch, no CLIP-L. Apache 2.0.',
    sageCompatible: true,          tritonCompatible: true,   vramRequiredGb: 8,
  },
  {
    modelId: 'sdxl-turbo-fp16',    modelTypeArg: 'sdxl',    pipelinePath: 'SDXL from_single_file',
    pytorchStatus: 'working',      needsAux: false,
    notes: 'SDXL Turbo. 4 steps, 512x512. No aux files. Safetensors (not GGUF).',
    sageCompatible: true,          tritonCompatible: true,   vramRequiredGb: 4,
  },
  {
    modelId: 'flux-schnell-q4',    modelTypeArg: 'flux',    pipelinePath: 'GGUF FluxPipeline (schnell config)',
    pytorchStatus: 'working',      needsAux: true,
    notes: 'FLUX.1-schnell. 4 steps, bundled schnell config. Needs CLIP-L + T5 + VAE.',
    sageCompatible: true,          tritonCompatible: true,   vramRequiredGb: 8,
  },
  {
    modelId: 'flux-dev-q4',        modelTypeArg: 'flux',    pipelinePath: 'GGUF FluxPipeline',
    pytorchStatus: 'working',      needsAux: true,
    notes: 'FLUX.1-dev. 20 steps, needs CLIP-L + T5 + VAE. Gated repo — needs bundled config.',
    sageCompatible: true,          tritonCompatible: true,   vramRequiredGb: 8,
  },

  // ── Newly added pipelines — verify generation ──
  {
    modelId: 'z-image-turbo-q4',   modelTypeArg: 'z-image', pipelinePath: 'ZImagePipeline (Diffusers 0.37.0)',
    pytorchStatus: 'blocked',      needsAux: true,
    notes: 'ZImagePipeline.from_single_file GGUF loading broken in Diffusers 0.37.1 (model_loading_utils KeyError). Blocked until upstream fix.',
    sageCompatible: false,         tritonCompatible: false,  vramRequiredGb: 8,
  },
  {
    modelId: 'qwen-image-q4',      modelTypeArg: 'qwen-image', pipelinePath: 'QwenImagePipeline',
    pytorchStatus: 'working',      needsAux: true,
    notes: 'Qwen-Image via from_pretrained (not from_single_file — GGUF quant_type KeyError on CUDA). Works on 890M (48 GB, no offload). CUDA ≤12 GB needs investigation.',
    sageCompatible: true,          tritonCompatible: true,   vramRequiredGb: 16,
  },
  {
    modelId: 'wan21-t2v-1.3b-q4',  modelTypeArg: 'wan',     pipelinePath: 'WanPipeline GGUF (video)',
    pytorchStatus: 'working',      needsAux: false,
    notes: 'Wan 2.1 T2V 1.3B. WanTransformer3DModel GGUF + AutoencoderKLWan. Video output (.mp4). VAE from pretrained.',
    sageCompatible: false,         tritonCompatible: true,   vramRequiredGb: 8,
  },
  {
    modelId: 'wan22-t2v-14b-q4',   modelTypeArg: 'wan',     pipelinePath: 'WanPipeline GGUF (video, MoE)',
    pytorchStatus: 'pending',      needsAux: false,
    notes: 'Wan 2.2 T2V 14B MoE. Same WanPipeline but dual-expert (HighNoise/LowNoise). Needs 16+ GB VRAM. Dual-expert routing not in phobos-diffusers.py yet.',
    sageCompatible: false,         tritonCompatible: true,   vramRequiredGb: 16,
  },

  // ── Blocked or pending ──
  {
    modelId: 'flux2-klein-4b-q4',  modelTypeArg: 'flux2',   pipelinePath: 'BLOCKED',
    pytorchStatus: 'blocked',      needsAux: true,
    notes: 'Heterogeneous layer widths — Flux2Transformer2DModel assumes uniform dimensions.',
    sageCompatible: false,         tritonCompatible: false,  vramRequiredGb: 8,
  },
  {
    modelId: 'kontext-dev-q5',     modelTypeArg: 'kontext', pipelinePath: 'FluxKontextPipeline',
    pytorchStatus: 'pending',      needsAux: true,
    notes: 'FluxKontextPipeline implemented but gated config (black-forest-labs/FLUX.1-Kontext-dev). Needs bundled config or HF token.',
    sageCompatible: true,          tritonCompatible: true,   vramRequiredGb: 10,
  },
];

// ── Result tracking ─────────────────────────────────────────────────────────

interface TestResult {
  modelId:    string;
  gpu:        string;
  vendor:     GpuVendor;
  status:     'pass' | 'fail' | 'skip' | 'blocked' | 'download-fail';
  detail:     string;
  loadMs:     number;
  genMs:      number;
  sage?:      'pass' | 'fail' | 'skip';
  triton?:    'pass' | 'fail' | 'skip';
}

const results: TestResult[] = [];

// ── Spawn helper ────────────────────────────────────────────────────────────

function runPython(
  pyPath: string, scriptArgs: string[], env: NodeJS.ProcessEnv, timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const stdoutBuf: string[] = [];
    const stderrBuf: string[] = [];

    const proc = spawn(pyPath, scriptArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      timeout: timeoutMs,
    });

    proc.stdout?.on('data', (d: Buffer) => {
      const lines = d.toString().split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (t) {
          stdoutBuf.push(t);
          // Print progress inline
          if (t.includes('step ') || t.includes('loading ') || t.includes('INFO')) {
            process.stdout.write(`    ${dim(t)}\r`);
          }
        }
      }
    });

    proc.stderr?.on('data', (d: Buffer) => {
      const lines = d.toString().split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (t && !t.includes('UserWarning') && !t.includes('FutureWarning') && !t.includes('deprecat')) {
          stderrBuf.push(t);
        }
      }
    });

    proc.on('exit', (code) => {
      process.stdout.write('\x1b[2K\r'); // clear progress line
      resolve({ code: code ?? 1, stdout: stdoutBuf.join('\n'), stderr: stderrBuf.join('\n') });
    });

    proc.on('error', (err) => {
      resolve({ code: 1, stdout: '', stderr: err.message });
    });
  });
}

// ── Build args for a single test ────────────────────────────────────────────

function buildTestArgs(
  entry: ValidationEntry,
  spec: ImageModelSpec,
  gpu: GpuDevice,
  vendor: GpuVendor,
  hw: HardwareProfile,
  freeVramMb: number,
  sageMode: boolean,
  tritonMode: boolean,
): { scriptArgs: string[]; env: NodeJS.ProcessEnv; offload: boolean; t5Label: string } {
  const modelFilePath = fluxModelPath(spec);
  const isVideo = entry.modelTypeArg === 'wan';
  const outExt = isVideo ? '.mp4' : '.png';
  const outPath = path.join(OUT_DIR, `validate-${entry.modelId}-${vendor}-${Date.now()}${outExt}`);

  const useSteps = spec.profile?.defaultSteps ?? 1;
  // Use 1 step for validation — we just need to confirm the pipeline runs, not quality.
  const steps = 1;
  const width  = spec.profile?.defaultWidth  ?? (entry.modelTypeArg === 'sdxl' ? 512 : (isVideo ? 832 : 1024));
  const height = spec.profile?.defaultHeight ?? (entry.modelTypeArg === 'sdxl' ? 512 : (isVideo ? 480 : 1024));
  const cfg    = spec.profile?.defaultCfgScale ?? (entry.modelTypeArg === 'chroma' ? 0 : 3.5);

  // Device string
  let deviceStr: string;
  switch (vendor) {
    case 'cuda':  deviceStr = `cuda:${gpu.index}`; break;
    case 'rocm':  deviceStr = 'cuda:0'; break;
    case 'xpu':   deviceStr = 'xpu:0'; break;
    case 'apple': deviceStr = 'mps'; break;
    default:      deviceStr = 'cpu'; break;
  }

  const scriptArgs: string[] = [
    SCRIPT,
    '--model-path', modelFilePath,
    '--model-type', entry.modelTypeArg,
    '--prompt', 'a red square on white background',
    '--steps', String(steps),
    '--width', String(width),
    '--height', String(height),
    '--cfg-scale', String(cfg),
    '--seed', '1',
    '--device', deviceStr,
    '--dtype', 'bfloat16',
    '--output', outPath,
  ];

  // Wan video-specific args — minimal frames for validation
  if (isVideo) {
    scriptArgs.push('--num-frames', '5');   // minimum viable — 5 frames
    scriptArgs.push('--fps', '12');
    scriptArgs.push('--flow-shift', '3.0');
  }

  // Offload decision — same logic as test-pytorch-gen.ts
  const isApple = vendor === 'apple';
  const isAmdUma = gpu.unifiedMemory === true && vendor === 'rocm';
  const workingMb = vendor === 'cuda' ? 512 : 256;

  let offload = false;
  let t5Label = '(none)';

  // ── Hard rule: always offload on ≤12 GB discrete CUDA and Apple Silicon ──
  const alwaysOffload = (vendor === 'cuda' && !gpu.unifiedMemory && gpu.vramGb <= 12)
                     || isApple;
  if (alwaysOffload) offload = true;

  // Only flux/chroma pipelines need external T5/CLIP/VAE aux files.
  // Wan, Z-Image, Qwen-Image load their own components from pretrained or from_single_file.
  const needsFluxAux = entry.needsAux && (spec.runnerProfile === 'flux' || spec.variant === 'chroma'
    || entry.modelTypeArg === 'kontext');

  if (needsFluxAux) {
    const t5Pick = recommendT5Encoder(spec, freeVramMb / 1024, isAmdUma);
    t5Label = t5Pick.label;
    const t5Mb = Math.ceil(t5Pick.sizeBytes / (1024 * 1024));
    const clipMb = spec.variant === 'chroma' ? 0 : 230;
    const totalMb = spec.diffusionMb + t5Mb + clipMb + spec.vaeMb + workingMb;

    if (!offload && totalMb > freeVramMb) {
      // Walk down T5 tiers
      const tiers = [t5Pick, FLUX_T5_Q4, FLUX_T5_Q3];
      let fitted = false;
      for (const cand of tiers) {
        const candMb = Math.ceil(cand.sizeBytes / (1024 * 1024));
        const candTotal = spec.diffusionMb + candMb + clipMb + spec.vaeMb + workingMb;
        if (candTotal <= freeVramMb) {
          t5Label = cand.label;
          fitted = true;
          break;
        }
      }
      if (!fitted) offload = true;
    }

    // Add aux files
    const vaePath = fluxAuxPath(FLUX_VAE);
    if (fs.existsSync(vaePath)) scriptArgs.push('--vae-path', vaePath);

    const t5Final = recommendT5Encoder(spec, offload ? freeVramMb / 1024 : freeVramMb / 1024, isAmdUma);
    const t5Path = fluxAuxPath(t5Final);
    if (fs.existsSync(t5Path)) {
      scriptArgs.push('--t5-path', t5Path);
      t5Label = t5Final.label;
    }

    if (spec.variant !== 'chroma') {
      const clipPath = fluxAuxPath(FLUX_CLIP_L);
      if (fs.existsSync(clipPath)) scriptArgs.push('--clip-path', clipPath);
    }
  }

  // Z-Image needs LLM encoder (Qwen3-4B) + VAE
  if (entry.modelTypeArg === 'z-image') {
    const llmPath = fluxAuxPath(ZIMAGE_LLM_Q4);
    if (fs.existsSync(llmPath)) {
      scriptArgs.push('--llm-path', llmPath);
    } else {
      console.log(`    ${warn('Z-Image LLM encoder not downloaded — test may fail')}`);
    }
    const vaePath = fluxAuxPath(FLUX_VAE);
    if (fs.existsSync(vaePath)) scriptArgs.push('--vae-path', vaePath);
  }

  // Qwen-Image needs LLM encoder (Qwen2.5-VL-7B) + VAE
  if (entry.modelTypeArg === 'qwen-image') {
    const llmPath = fluxAuxPath(QWEN_IMAGE_LLM_Q4);
    if (fs.existsSync(llmPath)) {
      scriptArgs.push('--llm-path', llmPath);
    } else {
      console.log(`    ${warn('Qwen-Image LLM encoder not downloaded — test may fail')}`);
    }
    const vaePath = fluxAuxPath(QWEN_IMAGE_VAE);
    if (fs.existsSync(vaePath)) scriptArgs.push('--vae-path', vaePath);
  }

  if (offload) scriptArgs.push('--offload-cpu');

  // Build env
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (vendor === 'cuda') {
    env.CUDA_VISIBLE_DEVICES = String(gpu.index);
  } else if (vendor === 'rocm') {
    const hipIdx = gpu.index >= 100 ? gpu.index - 100 : gpu.index;
    env.HIP_VISIBLE_DEVICES = String(hipIdx);
    if (/RX\s*6[0-9]{3}/i.test(gpu.name)) {
      env.HSA_OVERRIDE_GFX_VERSION = '10.3.0';
    }
  }

  // SageAttention
  if (sageMode) {
    env.DIFFUSERS_ATTN_BACKEND = 'sage_attn';
  }
  // Z-Image: force-disable SageAttention regardless — produces black images
  if (entry.modelTypeArg === 'z-image') {
    delete env.DIFFUSERS_ATTN_BACKEND;
  }

  // Triton / torch.compile — would need phobos-diffusers.py support (--compile flag)
  // For now this is a placeholder — torch.compile is not yet wired into the script.

  return { scriptArgs, env, offload, t5Label };
}

// ── Main ────────────────────────────────────────────────────────────────────

console.log(`\n${hdr('═══ PHOBOS PyTorch IMAGE MODEL VALIDATION ═══')}\n`);

// Detect hardware
const hw = await detectHardware();
console.log(`CPU: ${hw.cpuName} (${hw.cpuCores} cores)`);
for (const gpu of hw.gpus) {
  console.log(`GPU[${gpu.index}]: ${gpu.name} — ${gpu.vramGb} GB ${gpu.backend.toUpperCase()}`);
}

// ── GPU selection strategy ──────────────────────────────────────────────────
// Mirrors production: prefer fastest compute (CUDA), fall back to higher-VRAM
// GPU when the model doesn't fit. On the dev laptop: 3080 (10 GB CUDA, fast)
// vs 890M (48 GB ROCm, slow). Models ≤10 GB → 3080. Models >10 GB → 890M.

const gpusByCompute = [...hw.gpus].sort((a, b) => {
  const score = (g: typeof hw.gpus[0]) => {
    if (g.backend === 'cuda') return 4;
    if (g.backend === 'metal') return 3;
    return 1;
  };
  return score(b) - score(a);
});
const fastGpu = gpusByCompute[0];
const bigGpu  = [...hw.gpus].sort((a, b) => b.vramGb - a.vramGb)[0];

function selectGpuForModel(entry: ValidationEntry): GpuDevice {
  if (forceVendor) {
    const match = hw.gpus.find(g => gpuToVendor(g) === forceVendor);
    return match ?? fastGpu;
  }
  if (allGpus) return fastGpu; // allGpus mode handled separately below
  // Auto-select: if the model fits the fast GPU, use it. Otherwise use the big GPU.
  if (entry.vramRequiredGb <= fastGpu.vramGb) return fastGpu;
  return bigGpu;
}

// Filter validation entries
let entriesToTest = modelFilter
  ? VALIDATION_MATRIX.filter(e => e.modelId === modelFilter)
  : VALIDATION_MATRIX;

if (entriesToTest.length === 0) {
  console.error(fail(`No matching model: ${modelFilter}`));
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Run tests ───────────────────────────────────────────────────────────────

// In --all-gpus mode, run every model on every GPU (original behavior).
// Otherwise, use per-model auto-select.
const gpuSets: { gpu: GpuDevice; entries: ValidationEntry[] }[] = [];

if (allGpus) {
  const testGpus = hw.gpus.filter(g => g.backend !== 'cpu');
  for (const gpu of testGpus) {
    gpuSets.push({ gpu, entries: entriesToTest });
  }
} else {
  // Group entries by their auto-selected GPU
  const byGpu = new Map<number, { gpu: GpuDevice; entries: ValidationEntry[] }>();
  for (const entry of entriesToTest) {
    const gpu = selectGpuForModel(entry);
    if (!byGpu.has(gpu.index)) byGpu.set(gpu.index, { gpu, entries: [] });
    byGpu.get(gpu.index)!.entries.push(entry);
  }
  gpuSets.push(...byGpu.values());
}

for (const { gpu, entries } of gpuSets) {
  const vendor = gpuToVendor(gpu);
  console.log(`\n${hdr(`── GPU: ${gpu.name} (${vendor}) ──`)}`);

  // Check PyTorch env
  if (!isVendorReady(vendor)) {
    console.log(warn(`PyTorch ${vendor} environment not installed — skipping this GPU`));
    for (const entry of entries) {
      results.push({
        modelId: entry.modelId, gpu: gpu.name, vendor,
        status: 'skip', detail: `No ${vendor} venv`, loadMs: 0, genMs: 0,
      });
    }
    continue;
  }

  const pyPath = getPythonPath(vendor);
  if (!pyPath) {
    console.log(fail(`Python binary not found for ${vendor}`));
    continue;
  }

  // Query free VRAM once per GPU
  const isAmdUma = gpu.unifiedMemory === true && vendor === 'rocm';
  let freeVramMb: number;
  if (vendor === 'apple') {
    freeVramMb = hw.ramGb * 1024;
  } else if (isAmdUma) {
    freeVramMb = gpu.vramGb * 1024;
  } else {
    freeVramMb = (await queryGpuFreeVram(gpu)) ?? (gpu.vramGb * 1024 - 1536);
  }
  console.log(`  Free VRAM: ${freeVramMb} MB`);

  for (const entry of entries) {
    console.log(`\n  ${hdr(`▶ ${entry.modelId}`)} ${dim(`[${entry.pipelinePath}]`)}`);

    // Skip blocked/pending models
    if (entry.pytorchStatus === 'blocked') {
      console.log(`    ${warn(`BLOCKED: ${entry.notes}`)}`);
      results.push({
        modelId: entry.modelId, gpu: gpu.name, vendor,
        status: 'blocked', detail: entry.notes, loadMs: 0, genMs: 0,
      });
      continue;
    }
    if (entry.pytorchStatus === 'pending') {
      console.log(`    ${warn(`PENDING: ${entry.notes}`)}`);
      results.push({
        modelId: entry.modelId, gpu: gpu.name, vendor,
        status: 'skip', detail: `Pending implementation: ${entry.notes}`, loadMs: 0, genMs: 0,
      });
      continue;
    }

    // Check/download model
    const spec = getImageModelSpec(entry.modelId);
    if (!spec) {
      console.log(`    ${fail(`Model ${entry.modelId} not in catalogue`)}`);
      results.push({
        modelId: entry.modelId, gpu: gpu.name, vendor,
        status: 'fail', detail: 'Not in catalogue', loadMs: 0, genMs: 0,
      });
      continue;
    }

    if (!isImageModelDownloaded(spec)) {
      if (skipDownload) {
        console.log(`    ${dim('Not downloaded — skipping (--skip-download)')}`);
        results.push({
          modelId: entry.modelId, gpu: gpu.name, vendor,
          status: 'skip', detail: 'Not downloaded', loadMs: 0, genMs: 0,
        });
        continue;
      }
      console.log(`    ${warn('Not downloaded — download not implemented in test script. Use PHOBOS UI.')}`);
      results.push({
        modelId: entry.modelId, gpu: gpu.name, vendor,
        status: 'skip', detail: 'Not downloaded, no auto-download', loadMs: 0, genMs: 0,
      });
      continue;
    }

    // Build args and run
    const { scriptArgs, env, offload, t5Label } = buildTestArgs(
      entry, spec, gpu, vendor, hw, freeVramMb, false, false
    );
    console.log(`    ${dim(`offload=${offload}  T5=${t5Label}`)}`);

    const startMs = Date.now();
    const result = await runPython(pyPath, scriptArgs, env, 30 * 60 * 1000); // 30 min timeout
    const totalMs = Date.now() - startMs;

    // Parse load and gen times from output
    const loadMatch = result.stdout.match(/Model loaded in ([\d.]+)s/);
    const genMatch  = result.stdout.match(/taking ([\d.]+)s/);
    const loadMs = loadMatch ? Math.round(parseFloat(loadMatch[1]) * 1000) : 0;
    const genMs  = genMatch  ? Math.round(parseFloat(genMatch[1]) * 1000)  : 0;

    if (result.code === 0) {
      console.log(`    ${ok(`PASS — load ${(loadMs/1000).toFixed(1)}s, gen ${(genMs/1000).toFixed(1)}s, total ${(totalMs/1000).toFixed(1)}s`)}`);
      results.push({
        modelId: entry.modelId, gpu: gpu.name, vendor,
        status: 'pass', detail: `load=${loadMs}ms gen=${genMs}ms`, loadMs, genMs,
      });
    } else {
      const errTail = result.stderr.split('\n').slice(-3).join(' ').slice(0, 120);
      console.log(`    ${fail(`FAIL (exit ${result.code}): ${errTail}`)}`);
      results.push({
        modelId: entry.modelId, gpu: gpu.name, vendor,
        status: 'fail', detail: errTail, loadMs, genMs,
      });
    }

    // ── SageAttention test (same model, if requested) ──
    if (testSage && entry.sageCompatible && result.code === 0) {
      process.stdout.write(`    SageAttention... `);
      const { scriptArgs: sageArgs, env: sageEnv } = buildTestArgs(
        entry, spec, gpu, vendor, hw, freeVramMb, true, false
      );
      const sageResult = await runPython(pyPath, sageArgs, sageEnv, 15 * 60 * 1000);
      const r = results[results.length - 1];
      if (sageResult.code === 0) {
        r.sage = 'pass';
        console.log(ok('PASS'));
      } else {
        const sageErr = sageResult.stderr.includes('black') ? 'black image (known issue)'
          : sageResult.stderr.split('\n').slice(-1)[0]?.slice(0, 80) ?? 'unknown error';
        r.sage = 'fail';
        console.log(fail(sageErr));
      }
    }

    // ── Triton/torch.compile test (placeholder) ──
    if (testTriton && entry.tritonCompatible && result.code === 0) {
      const r = results[results.length - 1];
      r.triton = 'skip';
      console.log(`    ${dim('Triton: skipped — --compile flag not yet in phobos-diffusers.py')}`);
    }
  }
}

// ── Summary table ───────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(90)}`);
console.log(hdr('VALIDATION SUMMARY'));
console.log('═'.repeat(90));

const pad = (s: string, w: number) => s.padEnd(w).slice(0, w);

console.log(
  `${C.bold}` +
  pad('Model', 25) +
  pad('GPU', 20) +
  pad('Status', 12) +
  pad('Load', 8) +
  pad('Gen', 8) +
  pad('Sage', 8) +
  pad('Triton', 8) +
  C.reset
);
console.log('─'.repeat(90));

let failures = 0;
let passes = 0;
for (const r of results) {
  const statusStr = r.status === 'pass' ? `${C.green}PASS${C.reset}`
    : r.status === 'fail' ? `${C.red}FAIL${C.reset}`
    : r.status === 'blocked' ? `${C.yellow}BLOCK${C.reset}`
    : `${C.dim}skip${C.reset}`;

  const sageStr = r.sage === 'pass' ? `${C.green}PASS${C.reset}`
    : r.sage === 'fail' ? `${C.red}FAIL${C.reset}`
    : `${C.dim}-${C.reset}`;

  const tritonStr = r.triton === 'pass' ? `${C.green}PASS${C.reset}`
    : r.triton === 'fail' ? `${C.red}FAIL${C.reset}`
    : `${C.dim}-${C.reset}`;

  const loadStr = r.loadMs > 0 ? `${(r.loadMs / 1000).toFixed(1)}s` : '-';
  const genStr  = r.genMs > 0  ? `${(r.genMs / 1000).toFixed(1)}s`  : '-';

  console.log(
    pad(r.modelId, 25) +
    pad(r.gpu.slice(0, 19), 20) +
    statusStr.padEnd(22) +  // +10 for ANSI
    pad(loadStr, 8) +
    pad(genStr, 8) +
    sageStr.padEnd(18) +
    tritonStr.padEnd(18)
  );

  if (r.status === 'fail') {
    console.log(`  ${C.dim}${r.detail.slice(0, 100)}${C.reset}`);
    failures++;
  }
  if (r.status === 'pass') passes++;
}

console.log('═'.repeat(90));
const total = results.length;
const skips = results.filter(r => r.status === 'skip' || r.status === 'blocked').length;
if (failures === 0) {
  console.log(`${C.green}${C.bold}${passes} PASSED, ${skips} skipped, 0 failures${C.reset}`);
} else {
  console.log(`${C.red}${C.bold}${failures} FAILURES, ${passes} passed, ${skips} skipped${C.reset}`);
}
console.log('');

process.exit(failures > 0 ? 1 : 0);
