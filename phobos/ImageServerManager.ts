import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  resolveSdServerBin,
  fluxModelPath,
  fluxAuxPath,
  getImageModelSpec,
  isImageModelDownloaded,
  recommendFluxModel,
  recommendImageModel,
  recommendT5Encoder,
  FLUX_AUX_REQUIRED,
  CHROMA_AUX_REQUIRED,
  SDXL_AUX_REQUIRED,
  detectHardware,
  type ImageModelSpec,
  type FluxAuxFile,
} from './PhobosLocalManager.js';

export type SdModelType = 'flux' | 'chroma' | 'sdxl';

export interface SdServerConfig {
  modelType:    SdModelType;
  fluxSpec:     ImageModelSpec;  // unified — covers flux, chroma, and sdxl specs
  auxFiles:     FluxAuxFile[];
  deviceIndex?: number;
  gpuBackend?:  'cuda' | 'vulkan' | 'metal';
  freeVramGb?:  number;         // live free VRAM at config-build time (for polling/logging)
  needsPtxJit?: boolean;        // true for Blackwell+ GPUs lacking native cubins in sd-cli
  /** Which sd-cli binary to use — from GpuRunnerProfile.sdBinary */
  sdBinary?:    'cuda' | 'vulkan' | 'cpu';
  /** Pass --offload-to-cpu to sd-cli. Free on unified memory (AMD iGPU, Apple Silicon). */
  offloadToCpu?: boolean;
  steps?:       number;
  cfgScale?:    number;
  width?:       number;
  height?:      number;
}

export interface GenerateImageOptions {
  prompt:          string;
  negativePrompt?: string;
  steps?:          number;
  width?:          number;
  height?:         number;
  seed?:           number;
  sampler?:        string;
  // Workflow node extensions — img2img, inpaint, ControlNet, upscale
  initImg?:        string;   // --init-img path (img2img / inpaint source)
  strength?:       number;   // --strength (denoising, 0–1)
  maskPath?:       string;   // --mask path (inpaint mask)
  controlImage?:   string;   // --control-image path (ControlNet conditioning)
  controlScale?:   number;   // --control-strength (ControlNet guidance scale)
  upscaleInput?:    string;   // input image for upscale mode
  upscaleModel?:    string;   // --upscale-model path (ESRGAN .pth file)
  upscaleFactor?:   number;   // --upscale-repeats
  upscaleTileSize?: number;   // --upscale-tile-size (default 128)
}

export interface GenerateImageResult {
  outputPath: string;
  seed:       number;
  elapsedMs:  number;
}

// ── CLI arg builders ──────────────────────────────────────────────────────────
// ── Shared workflow CLI flags ─────────────────────────────────────────────────
// Appended to any runner's arg list when the corresponding option is present.

function appendWorkflowFlags(args: string[], opts: GenerateImageOptions): void {
  if (opts.upscaleInput) {
    // Upscale is a separate sd-cli mode — must use -M upscale + --upscale-model + -i
    // The --input flag does not exist; the correct flags are:
    //   -M upscale  —  switches sd-cli to upscale mode (no diffusion)
    //   --upscale-model <path>  —  ESRGAN model file
    //   -i / --init-img <path>  —  input image to upscale
    //   --upscale-repeats <n>   —  number of upscale passes
    args.push('-M', 'upscale');
    args.push('-i', opts.upscaleInput);
    if (opts.upscaleModel) args.push('--upscale-model', opts.upscaleModel);
    if (opts.upscaleFactor) args.push('--upscale-repeats', String(opts.upscaleFactor));
    if (opts.upscaleTileSize) args.push('--upscale-tile-size', String(opts.upscaleTileSize));
    return; // upscale mode — don't mix with img2img/mask/control flags
  }
  if (opts.initImg)      args.push('--init-img', opts.initImg);
  if (opts.strength !== undefined) args.push('--strength', String(opts.strength));
  if (opts.maskPath)     args.push('--mask', opts.maskPath);
  if (opts.controlImage) args.push('--control-image', opts.controlImage);
  if (opts.controlScale !== undefined) args.push('--control-strength', String(opts.controlScale));
}

// Each runner profile has its own builder. buildArgs() dispatches by modelType.

function buildFluxArgs(
  cfg:     SdServerConfig,
  opts:    GenerateImageOptions,
  outPath: string,
): string[] {
  const spec   = cfg.fluxSpec;
  // schnell is designed for 4 steps; dev benefits from 20-28
  const steps  = opts.steps  ?? cfg.steps  ?? (spec.variant === 'schnell' ? 4 : 20);
  const width  = opts.width  ?? cfg.width  ?? 1024;
  const height = opts.height ?? cfg.height ?? 1024;
  const seed   = opts.seed   ?? 42;

  const args: string[] = [
    '--diffusion-model', fluxModelPath(spec),
    '--vae',             fluxAuxPath(cfg.auxFiles.find(a => a.cliFlag === '--vae')!),
    '--clip_l',          fluxAuxPath(cfg.auxFiles.find(a => a.cliFlag === '--clip_l')!),
    '--t5xxl',           fluxAuxPath(cfg.auxFiles.find(a => a.cliFlag === '--t5xxl')!),
    '--prompt',          opts.prompt,
    '--steps',           String(steps),
    '--width',           String(width),
    '--height',          String(height),
    '--seed',            String(seed),
    '--sampling-method', opts.sampler ?? 'euler',
    '--guidance',        '3.5',
    '-o',                outPath,
    '--rng',    'cuda',  // GPU-side RNG — avoids CPU→GPU transfer per step
  ];

  if (opts.negativePrompt) args.push('--negative-prompt', opts.negativePrompt);
  if (cfg.offloadToCpu)    args.push('--offload-to-cpu');
  appendWorkflowFlags(args, opts);
  return args;
}

function buildChromaArgs(
  cfg:     SdServerConfig,
  opts:    GenerateImageOptions,
  outPath: string,
): string[] {
  const spec   = cfg.fluxSpec;
  // Chroma benefits from 20 steps; can go as low as 12 for speed at mild quality cost
  const steps  = opts.steps  ?? cfg.steps  ?? 20;
  const width  = opts.width  ?? cfg.width  ?? 1024;
  const height = opts.height ?? cfg.height ?? 1024;
  const seed   = opts.seed   ?? 42;

  // Chroma differences from FLUX:
  //   - no --clip_l (trained without CLIP-L conditioning pathway)
  //   - --guidance 0 (unconditional — CFG disabled by design)
  const args: string[] = [
    '--diffusion-model', fluxModelPath(spec),
    '--vae',             fluxAuxPath(cfg.auxFiles.find(a => a.cliFlag === '--vae')!),
    '--t5xxl',           fluxAuxPath(cfg.auxFiles.find(a => a.cliFlag === '--t5xxl')!),
    '--prompt',          opts.prompt,
    '--steps',           String(steps),
    '--width',           String(width),
    '--height',          String(height),
    '--seed',            String(seed),
    '--sampling-method', opts.sampler ?? 'euler',
    '--guidance',        '0',
    '-o',                outPath,
    '--rng',    'cuda',  // GPU-side RNG
  ];

  if (opts.negativePrompt) args.push('--negative-prompt', opts.negativePrompt);
  if (cfg.offloadToCpu)    args.push('--offload-to-cpu');
  appendWorkflowFlags(args, opts);
  return args;
}

function buildSdxlArgs(
  cfg:     SdServerConfig,
  opts:    GenerateImageOptions,
  outPath: string,
): string[] {
  const steps  = opts.steps  ?? cfg.steps  ?? 25;
  const width  = opts.width  ?? cfg.width  ?? 1024;
  const height = opts.height ?? cfg.height ?? 1024;
  const seed   = opts.seed   ?? 42;

  // SDXL differences from FLUX:
  //   - -m instead of --diffusion-model (single-file format, VAE baked in)
  //   - --clip_l + --clip_g (no --t5xxl, no --vae)
  //   - --cfg-scale instead of --guidance
  //   - euler_a sampler preferred
  const args: string[] = [
    '-m',                fluxModelPath(cfg.fluxSpec),
    '--clip_l',          fluxAuxPath(cfg.auxFiles.find(a => a.cliFlag === '--clip_l')!),
    '--clip_g',          fluxAuxPath(cfg.auxFiles.find(a => a.cliFlag === '--clip_g')!),
    '--prompt',          opts.prompt,
    '--steps',           String(steps),
    '--width',           String(width),
    '--height',          String(height),
    '--seed',            String(seed),
    '--sampling-method', opts.sampler ?? 'euler_a',
    '--cfg-scale',       String(cfg.cfgScale ?? 7.0),
    '-o',                outPath,
    '--rng',    'cuda',  // GPU-side RNG
  ];

  if (opts.negativePrompt) args.push('--negative-prompt', opts.negativePrompt);
  appendWorkflowFlags(args, opts);
  return args;
}

function buildArgs(
  cfg:     SdServerConfig,
  opts:    GenerateImageOptions,
  outPath: string,
): string[] {
  if (cfg.modelType === 'chroma') return buildChromaArgs(cfg, opts, outPath);
  if (cfg.modelType === 'sdxl')   return buildSdxlArgs(cfg, opts, outPath);
  return buildFluxArgs(cfg, opts, outPath);
}

// ── GPU device selection notes ────────────────────────────────────────────────
// sd-cli does not have a --device flag like llama-server.
// GPU compute is selected by which binary is run:
//   sd-server-win32-x64-cuda.exe   → CUDA compute (NVIDIA)
//   sd-server-win32-x64.exe        → Vulkan compute (any GPU)
//   sd-server-win32-x64-cpu.exe    → CPU only
//
// For CUDA binary: CUDA_VISIBLE_DEVICES env var selects which NVIDIA GPU.
// For Vulkan binary: no reliable single-device env var — uses first Vulkan device.
// resolveSdServerBin() already picks the best binary (CUDA > Vulkan > CPU).

function buildEnv(cfg: SdServerConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };

  if (cfg.gpuBackend === 'metal') {
    return env; // macOS Metal — binary handles this automatically
  }

  if (cfg.gpuBackend === 'cuda') {
    // Always set explicitly. An inherited CUDA_VISIBLE_DEVICES="" from the parent
    // process (e.g. set by llama-server) will override a missing assignment and
    // tell the CUDA runtime no GPUs are visible, silently forcing CPU execution.
    env.CUDA_VISIBLE_DEVICES =
      cfg.deviceIndex !== undefined && cfg.deviceIndex < 100
        ? String(cfg.deviceIndex)
        : '0'; // default to first device if index somehow missing

    // Force PTX JIT compilation ONLY on Blackwell+ GPUs (sm_120, RTX 5080/5090).
    // The sd.cpp cuda12 release binary was compiled before CUDA 12.8 and contains
    // no sm_120 native cubin. Without this flag the CUDA runtime finds no matching
    // code and silently falls back to CPU. With it, PTX is JIT-compiled at startup.
    //
    // CRITICAL: Do NOT set this unconditionally. On GPUs that already have native
    // cubins (e.g. sm_86 for RTX 3080), CUDA_FORCE_PTX_JIT=1 forces the JIT
    // compiler to re-compile ALL PTX kernels anyway. The JIT compiler allocates
    // GPU workspace memory for compilation, and on tight-VRAM cards (10 GB) this
    // pushes total usage past the limit, causing cublasCreate_v2 to fail with
    // "CUDA error: the resource allocation failed" during model init.
    if (cfg.needsPtxJit) {
      env.CUDA_FORCE_PTX_JIT = '1';
    }

    return env;
  }

  // Vulkan — remove CUDA_VISIBLE_DEVICES entirely so an inherited value
  // does not confuse drivers that check it even in non-CUDA paths.
  delete env.CUDA_VISIBLE_DEVICES;
  // On multi-GPU Windows systems, point sd-cli's Vulkan backend at the right device.
  // Non-NVIDIA devices have index >= 100; WMI position = index - 100 = Vulkan position
  // (when no NVIDIA GPU is present, which is always true if we're on Vulkan binary).
  if (cfg.deviceIndex !== undefined && cfg.deviceIndex >= 100) {
    env.GGML_VK_VISIBLE_DEVICES = String(cfg.deviceIndex - 100);
  }
  return env;
}

// ── Generate ──────────────────────────────────────────────────────────────────

/**
 * Spawns sd-cli, waits for it to complete, returns the output file path.
 * sd-cli is a one-shot CLI tool — no persistent process, no HTTP.
 */
export async function generateImage(
  outputPath: string,
  cfg:        SdServerConfig,
  opts:       GenerateImageOptions,
  onProgress?: (line: string) => void,
  onAbortRegister?: (killFn: () => void) => void,
): Promise<GenerateImageResult> {
  // Register an abort function immediately so the caller can cancel us even
  // before sd-cli spawns (e.g. during the VRAM settle poll loop).
  let aborted = false;
  let killProc: (() => void) | null = null;
  if (onAbortRegister) {
    onAbortRegister(() => {
      aborted = true;
      killProc?.();
    });
  }
  const spec = getImageModelSpec(cfg.fluxSpec.modelId);
  if (!spec) throw new Error(`Unknown image model ID: ${cfg.fluxSpec.modelId}`);

  // Verify all files exist before spawning
  const missing: string[] = [];
  if (!fs.existsSync(fluxModelPath(spec))) missing.push(`model: ${spec.hfFile}`);
  for (const aux of cfg.auxFiles) {
    if (!fs.existsSync(fluxAuxPath(aux))) missing.push(`aux: ${aux.hfFile}`);
  }
  if (missing.length > 0) {
    throw new Error(`sd-cli cannot run — missing files:\n  ${missing.join('\n  ')}`);
  }

  outputPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // ── Pre-flight VRAM check ──────────────────────────────────────────────────
  // Estimate total model footprint and compare against available VRAM.
  // Applies to discrete GPU paths (CUDA + Vulkan discrete).
  // Skipped for: CPU binary (no VRAM), unified memory (offload uses RAM pool).
  const isDiscreteGpuPath = (cfg.gpuBackend === 'cuda' || cfg.gpuBackend === 'vulkan')
    && !cfg.offloadToCpu
    && cfg.sdBinary !== 'cpu';
  if (isDiscreteGpuPath && cfg.freeVramGb !== undefined && cfg.freeVramGb > 0) {
    const diffusionMb = Math.ceil(spec.sizeBytes / (1024 * 1024));
    const t5Aux       = cfg.auxFiles.find(a => a.cliFlag === '--t5xxl');
    const t5Mb        = t5Aux ? Math.ceil(t5Aux.sizeBytes / (1024 * 1024)) : 0;
    const vaeMb       = 160;
    const clipAux     = cfg.auxFiles.find(a => a.cliFlag === '--clip_l');
    const clipMb      = clipAux ? Math.ceil(clipAux.sizeBytes / (1024 * 1024)) : 0;
    const workingMb   = cfg.gpuBackend === 'cuda' ? 512 : 256;
    const totalNeeded = diffusionMb + t5Mb + vaeMb + clipMb + workingMb;
    const freeMb      = Math.round(cfg.freeVramGb * 1024);

    console.log(
      `[ImageServerManager] Pre-flight VRAM (${cfg.gpuBackend}): need ~${totalNeeded} MB ` +
      `(diffusion ${diffusionMb} + T5 ${t5Mb} + VAE ${vaeMb} + CLIP ${clipMb} + working ${workingMb}), ` +
      `have ${freeMb} MB free`
    );

    if (totalNeeded > freeMb) {
      throw new Error(
        `Not enough VRAM for GPU generation: model needs ~${(totalNeeded / 1024).toFixed(1)} GB ` +
        `but only ${cfg.freeVramGb.toFixed(1)} GB is free. ` +
        `Flux and Chroma require at least 8 GB discrete VRAM.`
      );
    }
  }

  const bin = resolveSdServerBin(cfg.sdBinary ?? (cfg.gpuBackend === 'cuda' ? 'cuda' : cfg.gpuBackend === 'vulkan' ? 'vulkan' : 'cpu'));
  if (process.platform !== 'win32') {
    try { fs.chmodSync(bin, 0o755); } catch { /* ignore */ }
  }

  // Wait for CUDA driver to reclaim VRAM from any previous sd-cli process.
  // The cuBLASLt workspace (~630 MB) can remain held for 10-30s after process
  // exit. nvidia-smi reports stale numbers during this window, making the
  // pre-flight check pass while the actual available VRAM is lower.
  // Poll until free VRAM is stable AND above the threshold needed by this run,
  // or fall back after 30s max.
  if (cfg.gpuBackend === 'cuda' && cfg.sdBinary !== 'cpu' && cfg.freeVramGb !== undefined) {
    const diffusionMb = Math.ceil(spec.sizeBytes / (1024 * 1024));
    const t5Aux       = cfg.auxFiles.find(a => a.cliFlag === '--t5xxl');
    const t5Mb        = t5Aux ? Math.ceil(t5Aux.sizeBytes / (1024 * 1024)) : 0;
    const minFreeMb   = diffusionMb + t5Mb + 500; // model + 500 MB safety margin
    const minFreeGb   = minFreeMb / 1024;
    const POLL_MS     = 1000;
    const MAX_WAIT_MS = 30000;
    const waitStart   = Date.now();
    let lastFreeGb    = cfg.freeVramGb;

    while (Date.now() - waitStart < MAX_WAIT_MS) {
      await new Promise(r => setTimeout(r, POLL_MS));
      if (aborted) return { outputPath, seed: -1, elapsedMs: 0 }; // abort during VRAM settle
      try {
        const hw  = await detectHardware();
        const gpu = hw.gpus.find(g => g.index === (cfg.deviceIndex ?? 0));
        if (!gpu) break;
        const freeGb = gpu.freeVramGb ?? 0;
        if (freeGb >= minFreeGb && freeGb <= lastFreeGb + 0.1) break; // stable and sufficient
        lastFreeGb = freeGb;
      } catch { break; }
    }
  }

  if (aborted) return { outputPath, seed: -1, elapsedMs: 0 }; // abort before spawn

  const seed = opts.seed ?? 42;
  const args = buildArgs(cfg, { ...opts, seed }, outputPath);
  const env  = buildEnv(cfg);

  console.log(`[ImageServerManager] Spawning sd-cli — ${spec.label} (${cfg.modelType})`);
  console.log(`[ImageServerManager] ${bin} ${args.join(' ')}`);

  const startMs = Date.now();

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: path.dirname(bin), // so companion DLLs are found
    });
    // Register proc kill — onAbortRegister was already called above with the pre-spawn abort
    killProc = () => { try { proc.kill('SIGTERM'); } catch { /* already gone */ } };
    if (aborted) { killProc(); } // abort was pressed between poll and spawn

    proc.stdout?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) {
        console.log(`[sd-cli] ${line}`);
        onProgress?.(line);
      }
    });
    proc.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log(`[sd-cli] ${line}`);
    });

    proc.on('exit', (code, signal) => {
      if (code === 0 || signal === 'SIGTERM' || signal === 'SIGKILL') resolve();
      else reject(new Error(`sd-cli exited with code ${code} (signal: ${signal})`));
    });

    proc.on('error', reject);
  });

  const elapsedMs = Date.now() - startMs;

  if (!fs.existsSync(outputPath)) {
    throw new Error(`sd-cli exited successfully but output file not found: ${outputPath}`);
  }

  console.log(`[ImageServerManager] Done — ${path.basename(outputPath)} in ${(elapsedMs / 1000).toFixed(1)}s`);

  return { outputPath, seed, elapsedMs };
}

// ── Status (kept for API compatibility with Phase 3+) ─────────────────────────

export function getSdServerStatus(): {
  state:     'idle';
  modelId:   null;
  error:     null;
} {
  // CLI mode — no persistent server, always idle between generations
  return { state: 'idle', modelId: null, error: null };
}

// ── Auto-configure from hardware ──────────────────────────────────────────────

export async function buildSdConfig(
  overrides: Partial<SdServerConfig> & { modelId?: string } = {},
): Promise<SdServerConfig | null> {
  let totalVramGb     = 0;
  let freeVramGb      = 0;
  let deviceIndex: number | undefined;
  let gpuBackend: SdServerConfig['gpuBackend'] | undefined;
  let isUnifiedMemory = false;
  let needsPtxJit     = false;
  let offloadToCpu    = false;
  let sdBinaryChoice: 'cuda' | 'vulkan' | 'cpu' = 'cuda';

  try {
    const hw = await detectHardware();
    const backendScore = (g: typeof hw.gpus[0]): number => {
      const kind = g.runner?.kind;
      if (kind === 'apple-metal')   return 4;
      if (kind === 'nvidia-cuda' || kind === 'nvidia-vulkan') return 3;
      if (kind === 'nvidia-legacy' || kind === 'amd-discrete') return 2;
      if (kind === 'amd-igpu' || kind === 'intel-igpu') return 1;
      // Unclassified fallback
      if (g.backend === 'metal')  return 4;
      if (g.backend === 'cuda')   return 3;
      return g.unifiedMemory ? 1 : 2;
    };
    const gpusByPriority = [...hw.gpus].sort((a, b) => {
      const scoreDiff = backendScore(b) - backendScore(a);
      return scoreDiff !== 0 ? scoreDiff : b.vramGb - a.vramGb;
    });
    const bestGpu = gpusByPriority[0];
    if (bestGpu) {
      totalVramGb     = bestGpu.vramGb;
      deviceIndex     = bestGpu.index;
      gpuBackend      = bestGpu.backend;
      isUnifiedMemory = bestGpu.unifiedMemory === true; // index>=100 is non-NVIDIA, not necessarily unified
      sdBinaryChoice  = bestGpu.runner?.sdBinary ?? (bestGpu.backend === 'cuda' ? 'cuda' : bestGpu.backend === 'vulkan' ? 'vulkan' : 'cpu');
      freeVramGb      = bestGpu.freeVramGb ?? Math.max(0, totalVramGb - 1.5);

      // Blackwell GPUs (RTX 5060/5070/5080/5090) need PTX JIT because
      // sd.cpp release binaries lack native sm_120 cubins.
      // DO NOT enable on Ampere/Ada — the JIT compiler workspace allocation
      // consumes VRAM and causes OOM on tight cards like the RTX 3080.
      needsPtxJit = bestGpu.backend === 'cuda' &&
        /\b50[6789]0\b|\bblackwell\b/i.test(bestGpu.name ?? '');
      offloadToCpu = isUnifiedMemory; // unified = RAM is VRAM, offload is free

      console.log(
        `[ImageServerManager] VRAM budget: ${freeVramGb.toFixed(1)} GB free` +
        (bestGpu.freeVramGb !== undefined
          ? ` (live, total ${totalVramGb} GB)`
          : ` (estimated: total ${totalVramGb} GB − 1.5 GB reserve)`) +
        (needsPtxJit ? ' [Blackwell — PTX JIT enabled]' : '')
      );
    }
  } catch (err) {
    console.warn(`[ImageServerManager] Hardware detect failed: ${(err as Error).message}`);
  }

  // If a specific modelId was requested, look it up directly instead of auto-recommending.
  // Still validate that the current GPU can actually run it — if not, clear spec so the
  // VRAM-aware selection and CPU fallback below can take over.
  let spec: ImageModelSpec | null = null;
  if (overrides.modelId) {
    spec = getImageModelSpec(overrides.modelId) ?? null;
    if (spec && !isImageModelDownloaded(spec)) {
      console.warn(`[ImageServerManager] Requested model ${overrides.modelId} is not downloaded`);
      spec = null;
    }
    // VRAM gate: if we have a discrete GPU with known VRAM that can't fit this model,
    // clear spec so the fallback block routes to CPU instead of failing at pre-flight.
    if (spec && !isUnifiedMemory && totalVramGb > 0 && spec.vramRequiredGb > totalVramGb) {
      console.warn(
        `[ImageServerManager] Requested model ${overrides.modelId} needs ${spec.vramRequiredGb} GB VRAM ` +
        `but only ${totalVramGb} GB available — will route to CPU`
      );
      spec = null;
    }
  }
  if (!spec) {
    if (isUnifiedMemory) {
      // Unified memory: use full system RAM pool (--offload-to-cpu, no PCIe cost)
      const os = await import('os');
      const ramGb = Math.floor(os.default.totalmem() / (1024 ** 3));
      spec = recommendImageModel(ramGb, true);
      if (spec) console.log(`[ImageServerManager] Unified memory system — using RAM pool (${ramGb} GB) for model selection`);
    } else {
      spec = recommendImageModel(totalVramGb, false);
    }
  }

  // If no model fits GPU VRAM, fall back to CPU generation.
  // CPU uses the sd-cpu binary which has no VRAM requirement — it uses system RAM.
  // This handles: Radeon 520 (2GB discrete), Quadro M2000 (4GB, Chroma needs 8GB), etc.
  if (!spec) {
    const os = await import('os');
    const ramGb = Math.floor(os.default.totalmem() / (1024 ** 3));
    spec = recommendImageModel(ramGb, true); // treat RAM as budget for CPU mode
    if (spec) {
      console.log(`[ImageServerManager] GPU VRAM insufficient for image gen — routing to CPU (${ramGb} GB RAM)`);
      sdBinaryChoice  = 'cpu';
      gpuBackend      = undefined;
      deviceIndex     = undefined;
      offloadToCpu    = false; // CPU binary doesn't use --offload-to-cpu
      totalVramGb     = 0;
      freeVramGb      = 0;
    }
  }

  if (!spec) {
    console.warn('[ImageServerManager] No image model available — cannot build config');
    return null;
  }

  // Aux selection by runner profile
  let auxFiles: FluxAuxFile[];
  if (spec.runnerProfile === 'sdxl') {
    auxFiles = [...SDXL_AUX_REQUIRED];
    console.log(`[ImageServerManager] Selected model: ${spec.label} (SDXL runner)`);
  } else {
    // flux and chroma both use T5 — chroma skips CLIP-L
    // Use freeVramGb (live reading after SAYON is stopped) when available —
    // totalVramGb ignores driver overhead, Windows display VRAM, and
    // persistent CUDA contexts that permanently reduce usable capacity.
    // On a 10 GB card this overhead is 1-2 GB and makes the difference
    // between fitting and OOM on cublas workspace allocation.
    const t5VramBudget = freeVramGb > 0 ? freeVramGb : totalVramGb;
    const t5 = recommendT5Encoder(spec, t5VramBudget, isUnifiedMemory);
    const baseAux = spec.variant === 'chroma' ? CHROMA_AUX_REQUIRED : FLUX_AUX_REQUIRED;
    auxFiles  = [...baseAux, t5];
    console.log(`[ImageServerManager] Selected model: ${spec.label} (${spec.runnerProfile} runner) · T5: ${t5.label}`);
  }

  const modelType: SdModelType =
    spec.runnerProfile === 'sdxl'  ? 'sdxl'
    : spec.variant    === 'chroma' ? 'chroma'
    : 'flux';

  return {
    modelType,
    fluxSpec: spec,
    auxFiles,
    deviceIndex,
    gpuBackend,
    freeVramGb,
    needsPtxJit,
    offloadToCpu,
    sdBinary: sdBinaryChoice,
    ...overrides,
  };
}
