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
  KONTEXT_AUX_REQUIRED,
  FLUX2_4B_AUX_REQUIRED,
  FLUX2_9B_AUX_REQUIRED,
  ZIMAGE_AUX_REQUIRED,
  QWEN_IMAGE_AUX_REQUIRED,
  WAN_AUX_REQUIRED,
  WAN_I2V_AUX_REQUIRED,
  detectHardware,
  type ImageModelSpec,
  type FluxAuxFile,
} from './PhobosLocalManager.js';

export type SdModelType = 'flux' | 'chroma' | 'sdxl' | 'kontext' | 'flux2' | 'z-image' | 'qwen-image' | 'wan';

export interface SdServerConfig {
  modelType:    SdModelType;
  fluxSpec:     ImageModelSpec;  // unified — covers flux, chroma, and sdxl specs
  auxFiles:     FluxAuxFile[];
  deviceIndex?: number;
  gpuBackend?:  'cuda' | 'vulkan' | 'metal';
  freeVramGb?:  number;         // live free VRAM at config-build time (for polling/logging)
  needsPtxJit?: boolean;        // true for Blackwell+ GPUs lacking native cubins in sd-cli
  gpuName?:     string;         // GPU name string for architecture-specific env vars
  /** Which sd-cli binary to use — from GpuRunnerProfile.sdBinary */
  sdBinary?:    'cuda' | 'vulkan' | 'rocm' | 'cpu';
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
  // New-family runner extensions
  refImage?:        string;   // -r path (FLUX Kontext / FLUX.2 / Qwen-Image editing)
  flowShift?:       number;   // --flow-shift (Qwen-Image, default 3)
  // Video generation (Wan)
  videoFrames?:     number;   // --video-frames (total frames to generate)
  fps?:             number;   // --fps (frames per second, default 12)
}

export interface GenerateImageResult {
  outputPath: string;
  seed:       number;
  elapsedMs:  number;
}

/** Returns the output file extension for a given model type. Wan outputs .avi; all others .png. */
export function nodeOutputExt(modelType: SdModelType): '.png' | '.avi' {
  return modelType === 'wan' ? '.avi' : '.png';
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
  if (opts.refImage)     args.push('-r', opts.refImage);
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
  // VAE decode needs ~2.5 GB working memory. On tight-VRAM cards (≤10 GB)
  // this OOMs after diffusion completes. --vae-tiling drops it to ~176 MB.
  if (cfg.freeVramGb !== undefined && cfg.freeVramGb <= 10) args.push('--vae-tiling');
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
  // VAE decode needs ~2.5 GB working memory. On tight-VRAM cards (≤10 GB)
  // this OOMs after diffusion completes. --vae-tiling drops it to ~176 MB.
  if (cfg.freeVramGb !== undefined && cfg.freeVramGb <= 10) args.push('--vae-tiling');
  appendWorkflowFlags(args, opts);
  return args;
}

function buildSdxlArgs(
  cfg:     SdServerConfig,
  opts:    GenerateImageOptions,
  outPath: string,
): string[] {
  const spec    = cfg.fluxSpec;
  const profile = spec.profile;
  const id      = spec.modelId;

  // Profile-driven defaults when available, otherwise fall back to tier detection:
  //   Turbo:     cfg=1, 4 steps, 512×512 (distilled — cfg must be 1, not 0, or prompt is ignored)
  //   Lightning: cfg=2, 6 steps, 1024×1024 (distilled but cfg-guided, trained at 1024)
  //   Base:      cfg=7, 25 steps, 1024×1024 (full denoising schedule)
  const isTurbo     = id.includes('turbo');
  const isLightning = id.includes('lightning');

  const steps    = opts.steps    ?? cfg.steps    ?? profile?.defaultSteps    ?? (isTurbo ? 4 : isLightning ? 6 : 25);
  const width    = opts.width    ?? cfg.width    ?? profile?.defaultWidth    ?? (isTurbo ? 512 : 1024);
  const height   = opts.height   ?? cfg.height   ?? profile?.defaultHeight   ?? (isTurbo ? 512 : 1024);
  const seed     = opts.seed     ?? 42;
  const cfgScale = cfg.cfgScale  ?? profile?.defaultCfgScale  ?? (isTurbo ? 1 : isLightning ? 2 : 7.0);
  const sampler  = opts.sampler  ?? profile?.defaultSampler   ?? (isLightning ? 'dpm++2m' : 'euler_a');

  // SDXL single-file safetensors: -m auto-detects architecture, no aux files.
  // All encoders (CLIP-L, CLIP-G) and VAE are baked into the safetensors.
  const args: string[] = [
    '-m',                fluxModelPath(spec),
    '--prompt',          opts.prompt,
    '--steps',           String(steps),
    '--width',           String(width),
    '--height',          String(height),
    '--seed',            String(seed),
    '--sampling-method', sampler,
    '--cfg-scale',       String(cfgScale),
    '-o',                outPath,
    '--vae-tiling',      // safe for all VRAM levels, prevents OOM on VAE decode
  ];

  // Scheduler override from profile (e.g. 'karras' for RealVisXL, DreamShaper Lightning)
  if (profile?.defaultScheduler) args.push('--scheduler', profile.defaultScheduler);

  // Negative prompt: use explicit user override, or profile default, or nothing
  const neg = opts.negativePrompt ?? (profile?.defaultNegative || undefined);
  if (neg) args.push('--negative-prompt', neg);

  if (cfg.offloadToCpu) args.push('--offload-to-cpu');
  appendWorkflowFlags(args, opts);
  return args;
}

function buildKontextArgs(
  cfg:     SdServerConfig,
  opts:    GenerateImageOptions,
  outPath: string,
): string[] {
  if (!opts.refImage) throw new Error('KontextEdit node requires a refImage (upstream output path)');
  const spec   = cfg.fluxSpec;
  const steps  = opts.steps ?? cfg.steps ?? 28;
  const width  = opts.width  ?? cfg.width  ?? 1024;
  const height = opts.height ?? cfg.height ?? 1024;
  const seed   = opts.seed   ?? 42;

  // Kontext shares aux files with FLUX.1 (VAE + CLIP-L + T5).
  // --vae-decode-only false is required so sd-cli encodes the input image into latent space.
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
    '--cfg-scale',       '1.0',
    '--vae-decode-only', 'false',
    '-r',                opts.refImage,
    '-o',                outPath,
  ];

  if (opts.negativePrompt) args.push('--negative-prompt', opts.negativePrompt);
  if (cfg.offloadToCpu)    args.push('--offload-to-cpu');
  if (cfg.freeVramGb !== undefined && cfg.freeVramGb <= 10) args.push('--vae-tiling');
  return args;
}

function buildFlux2Args(
  cfg:     SdServerConfig,
  opts:    GenerateImageOptions,
  outPath: string,
): string[] {
  const spec   = cfg.fluxSpec;
  // FLUX.2-klein default is 4-step schnell-style generation
  const steps  = opts.steps ?? cfg.steps ?? 4;
  const width  = opts.width  ?? cfg.width  ?? 1024;
  const height = opts.height ?? cfg.height ?? 1024;
  const seed   = opts.seed   ?? 42;

  // FLUX.2 uses --llm instead of --clip_l + --t5xxl.
  // --diffusion-fa: safe for LLM-encoder architectures. Only Chroma and FLUX.1 (--fa path) are known bad.
  const args: string[] = [
    '--diffusion-model', fluxModelPath(spec),
    '--vae',             fluxAuxPath(cfg.auxFiles.find(a => a.cliFlag === '--vae')!),
    '--llm',             fluxAuxPath(cfg.auxFiles.find(a => a.cliFlag === '--llm')!),
    '--prompt',          opts.prompt,
    '--steps',           String(steps),
    '--width',           String(width),
    '--height',          String(height),
    '--seed',            String(seed),
    '--sampling-method', opts.sampler ?? 'euler',
    '--cfg-scale',       '1.0',
    '--diffusion-fa',
    '-o',                outPath,
  ];

  if (opts.negativePrompt) args.push('--negative-prompt', opts.negativePrompt);
  if (opts.initImg)        args.push('--init-img', opts.initImg);
  if (opts.strength != null) args.push('--strength', String(opts.strength));
  if (opts.refImage)       args.push('-r', opts.refImage);
  if (cfg.offloadToCpu)    args.push('--offload-to-cpu');
  return args;
}

function buildZImageArgs(
  cfg:     SdServerConfig,
  opts:    GenerateImageOptions,
  outPath: string,
): string[] {
  const spec   = cfg.fluxSpec;
  // Z-Image Turbo = 4-step; Z-Image Base = 20-step
  const steps  = opts.steps ?? cfg.steps ?? (spec.modelId.includes('turbo') ? 4 : 20);
  const width  = opts.width  ?? cfg.width  ?? 1024;
  const height = opts.height ?? cfg.height ?? 1024;
  const seed   = opts.seed   ?? 42;

  const args: string[] = [
    '--diffusion-model', fluxModelPath(spec),
    '--vae',             fluxAuxPath(cfg.auxFiles.find(a => a.cliFlag === '--vae')!),
    '--llm',             fluxAuxPath(cfg.auxFiles.find(a => a.cliFlag === '--llm')!),
    '--prompt',          opts.prompt,
    '--steps',           String(steps),
    '--width',           String(width),
    '--height',          String(height),
    '--seed',            String(seed),
    '--sampling-method', opts.sampler ?? 'euler',
    '--scheduler',       'discrete',
    '--cfg-scale',       '1.0',
    '--diffusion-fa',
    '-o',                outPath,
  ];

  if (opts.negativePrompt) args.push('--negative-prompt', opts.negativePrompt);
  if (opts.initImg)        args.push('--init-img', opts.initImg);
  if (opts.strength != null) args.push('--strength', String(opts.strength));
  if (opts.refImage)       args.push('-r', opts.refImage);
  if (cfg.offloadToCpu)    args.push('--offload-to-cpu');
  // VAE decode of a full-res latent exceeds 8 GB VRAM budget without tiling.
  // --vae-tiling splits the decode into 512x512 tiles, reducing peak to ~176 MB.
  if (cfg.freeVramGb !== undefined && cfg.freeVramGb <= 10) args.push('--vae-tiling');
  return args;
}

function buildQwenImageArgs(
  cfg:     SdServerConfig,
  opts:    GenerateImageOptions,
  outPath: string,
): string[] {
  const spec   = cfg.fluxSpec;
  const steps  = opts.steps ?? cfg.steps ?? 20;
  const width  = opts.width  ?? cfg.width  ?? 1024;
  const height = opts.height ?? cfg.height ?? 1024;
  const seed   = opts.seed   ?? 42;
  const flowShift = opts.flowShift ?? 3;

  const args: string[] = [
    '--diffusion-model', fluxModelPath(spec),
    '--vae',             fluxAuxPath(cfg.auxFiles.find(a => a.cliFlag === '--vae')!),
    '--llm',             fluxAuxPath(cfg.auxFiles.find(a => a.cliFlag === '--llm')!),
    '--prompt',          opts.prompt,
    '--steps',           String(steps),
    '--width',           String(width),
    '--height',          String(height),
    '--seed',            String(seed),
    '--sampling-method', opts.sampler ?? 'euler',
    '--cfg-scale',       '2.5',
    '--flow-shift',      String(flowShift),
    '--diffusion-fa',
    '-o',                outPath,
  ];

  if (opts.negativePrompt) args.push('--negative-prompt', opts.negativePrompt);
  if (opts.initImg)        args.push('--init-img', opts.initImg);
  if (opts.refImage)       args.push('--ref-images', opts.refImage);
  if (cfg.offloadToCpu)    args.push('--offload-to-cpu');
  return args;
}

function buildWanArgs(
  cfg:     SdServerConfig,
  opts:    GenerateImageOptions,
  outPath: string,
): string[] {
  const spec        = cfg.fluxSpec;
  const steps       = opts.steps       ?? cfg.steps  ?? 20;
  const seed        = opts.seed        ?? 42;
  const fps         = opts.fps         ?? 12;
  // Safe defaults by model size: 1.3B → 49 frames (4s), 14B → 49 frames (4s at 12fps).
  // User can increase via videoFrames param in the panel.
  const videoFrames = opts.videoFrames ?? 49;
  // Wan video output dimensions: 480P is 832×480 for widescreen, 480×832 for portrait.
  // Default to landscape 480P — fits all VRAM budgets.
  const width  = opts.width  ?? cfg.width  ?? 832;
  const height = opts.height ?? cfg.height ?? 480;

  // sd-cli vid_gen mode appends .avi to the output path automatically.
  // Pass the stem (no extension) so the result is output.avi not output.avi.avi.
  const outStem = outPath.endsWith('.avi') ? outPath.slice(0, -4) : outPath;

  const args: string[] = [
    '-M',                'vid_gen',
    '--diffusion-model', fluxModelPath(spec),
    '--vae',             fluxAuxPath(cfg.auxFiles.find(a => a.cliFlag === '--vae')!),
    '--t5xxl',           fluxAuxPath(cfg.auxFiles.find(a => a.cliFlag === '--t5xxl')!),
    '--prompt',          opts.prompt,
    '--steps',           String(steps),
    '--width',           String(width),
    '--height',          String(height),
    '--seed',            String(seed),
    '--sampling-method', opts.sampler ?? 'euler',
    '--scheduler',       'simple',
    '--cfg-scale',       '5',
    '--fps',             String(fps),
    '--video-frames',    String(videoFrames),
    // --diffusion-fa required for Wan — black images without it (confirmed sd.cpp issue tracker)
    '--diffusion-fa',
    // Keep T5/text encoder on CPU to preserve GPU VRAM for diffusion — Wan T5 is 4+ GB
    '--clip-on-cpu',
    '-o',                outStem,
  ];

  if (opts.negativePrompt) args.push('--negative-prompt', opts.negativePrompt);
  // I2V: pass the input image as --init-img (same field reused from img2img)
  if (opts.initImg)        args.push('--init-img', opts.initImg);
  if (cfg.offloadToCpu)    args.push('--offload-to-cpu');
  return args;
}

function buildArgs(
  cfg:     SdServerConfig,
  opts:    GenerateImageOptions,
  outPath: string,
): string[] {
  switch (cfg.modelType) {
    case 'chroma':     return buildChromaArgs(cfg, opts, outPath);
    case 'sdxl':       return buildSdxlArgs(cfg, opts, outPath);
    case 'kontext':    return buildKontextArgs(cfg, opts, outPath);
    case 'flux2':      return buildFlux2Args(cfg, opts, outPath);
    case 'z-image':    return buildZImageArgs(cfg, opts, outPath);
    case 'qwen-image': return buildQwenImageArgs(cfg, opts, outPath);
    case 'wan':        return buildWanArgs(cfg, opts, outPath);
    default:           return buildFluxArgs(cfg, opts, outPath);
  }
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
    return env; // macOS Metal — DYLD_LIBRARY_PATH set at spawn site
  }

  // CPU-only routing: on Linux/macOS the "cpu" and "vulkan" sd-cli binaries are
  // the same file. sd.cpp auto-detects Vulkan devices and uses them, which OOMs
  // on Intel iGPUs with 0 GB dedicated VRAM. Hide all Vulkan devices so sd.cpp
  // falls back to pure CPU execution.
  if (cfg.sdBinary === 'cpu' || cfg.gpuBackend === undefined) {
    delete env.CUDA_VISIBLE_DEVICES;
    if (process.platform !== 'win32') {
      // Point the Vulkan ICD loader at a nonexistent path — it reports 0 devices,
      // forcing sd.cpp to use the CPU backend without any Vulkan allocation attempts.
      env.VK_ICD_FILENAMES = '/dev/null';
      env.VK_DRIVER_FILES  = '/dev/null'; // newer Vulkan loader uses this instead
    }
    return env;
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

    // Suppress cuBLASLt autotuning workspace on tight-VRAM cards.
    // cublasLt64_12.dll pre-allocates ~500-674 MB on load for autotuning.
    // On ≤12 GB cards this is the difference between fitting and OOM.
    if (cfg.freeVramGb !== undefined && cfg.freeVramGb <= 12) {
      env.CUBLAS_WORKSPACE_CONFIG = ':0:0';
      env.CUBLASLT_WORKSPACE_SIZE = '0';
    }

    return env;
  }

  // ROCm (AMD HIP) — used for AMD discrete GPUs when ROCm runtime is available.
  // HIP_VISIBLE_DEVICES selects which AMD GPU to use (similar to CUDA_VISIBLE_DEVICES).
  if (cfg.sdBinary === 'rocm') {
    delete env.CUDA_VISIBLE_DEVICES;
    // AMD device index: our index scheme uses 100+ for non-NVIDIA.
    // HIP_VISIBLE_DEVICES uses 0-based HIP enumeration (just the AMD GPUs).
    if (cfg.deviceIndex !== undefined && cfg.deviceIndex >= 100) {
      env.HIP_VISIBLE_DEVICES = String(cfg.deviceIndex - 100);
    } else {
      env.HIP_VISIBLE_DEVICES = '0';
    }

    // RDNA 2 (RX 6600/6700/6800/6900) uses gfx1031/gfx1032 but ROCm only ships
    // precompiled kernels for gfx1030. HSA_OVERRIDE_GFX_VERSION tells the runtime
    // to treat the GPU as gfx1030, which is instruction-compatible.
    // This is a no-op on GPUs that are already gfx1030 (RX 6800 XT, 6900 XT)
    // and unnecessary on RDNA 3/4 (gfx1100+).
    if (/RX\s*6[0-9]{3}/i.test(cfg.gpuName ?? '')) {
      env.HSA_OVERRIDE_GFX_VERSION = '10.3.0';
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
  // Applies to discrete GPU paths (CUDA + Vulkan).
  // Skipped for: CPU binary (no VRAM), unified memory (RAM pool, no discrete gate).
  const isDiscreteGpuPath = (cfg.gpuBackend === 'cuda' || cfg.gpuBackend === 'vulkan')
    && cfg.sdBinary !== 'cpu';
  if (isDiscreteGpuPath && cfg.freeVramGb !== undefined && cfg.freeVramGb > 0) {
    const diffusionMb = Math.ceil(spec.sizeBytes / (1024 * 1024));
    // When offloading to CPU, T5 lives in system RAM — exclude from VRAM budget.
    const t5Aux       = cfg.auxFiles.find(a => a.cliFlag === '--t5xxl');
    const t5Mb        = (cfg.offloadToCpu || false) ? 0 : (t5Aux ? Math.ceil(t5Aux.sizeBytes / (1024 * 1024)) : 0);
    const vaeMb       = 160;
    const clipAux     = cfg.auxFiles.find(a => a.cliFlag === '--clip_l');
    const clipMb      = clipAux ? Math.ceil(clipAux.sizeBytes / (1024 * 1024)) : 0;
    const workingMb   = cfg.gpuBackend === 'cuda' ? 512 : 256;
    const totalNeeded = diffusionMb + t5Mb + vaeMb + clipMb + workingMb;
    const freeMb      = Math.round(cfg.freeVramGb * 1024);

    console.log(
      `[ImageServerManager] Pre-flight VRAM (${cfg.gpuBackend}${cfg.offloadToCpu ? ', T5 offloaded' : ''}): need ~${totalNeeded} MB ` +
      `(diffusion ${diffusionMb}${t5Mb > 0 ? ` + T5 ${t5Mb}` : ''} + VAE ${vaeMb} + CLIP ${clipMb} + working ${workingMb}), ` +
      `have ${freeMb} MB free`
    );

    if (totalNeeded > freeMb) {
      const shortfallMb = totalNeeded - freeMb;
      const SOFT_LIMIT_MB = 1536; // 1.5 GB — sd.cpp VMM can spill this to system RAM

      if (shortfallMb > SOFT_LIMIT_MB) {
        throw new Error(
          `Not enough VRAM for GPU generation: model needs ~${(totalNeeded / 1024).toFixed(1)} GB ` +
          `but only ${cfg.freeVramGb.toFixed(1)} GB is free (${(shortfallMb / 1024).toFixed(1)} GB short). ` +
          `Flux and Chroma require at least 8 GB discrete VRAM.`
        );
      }
      // Within soft limit — warn and let sd.cpp handle the spill via CUDA VMM.
      // This covers 8 GB cards with ~7 GB free (shortfall ~0.9 GB for Chroma Q4).
      console.warn(
        `[ImageServerManager] Pre-flight VRAM tight: ~${(shortfallMb / 1024).toFixed(1)} GB short — ` +
        `proceeding anyway (sd.cpp CUDA VMM will spill to system RAM if needed)`
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
    const t5Mb        = (cfg.offloadToCpu) ? 0 : (t5Aux ? Math.ceil(t5Aux.sizeBytes / (1024 * 1024)) : 0);
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

  // ── Live preview setup ──────────────────────────────────────────────────────
  // sd-cli writes a latent-decoded preview image to disk at each step interval.
  // We watch the file and push base64 updates through onProgress as special
  // __PREVIEW__ lines that the WorkflowEngine parses and forwards to the frontend.
  const previewDir = path.join(path.dirname(outputPath), '..', 'vision-scratch');
  fs.mkdirSync(previewDir, { recursive: true });
  const previewPath = path.join(previewDir, 'preview.png');
  // Clean up stale preview from previous run
  try { if (fs.existsSync(previewPath)) fs.unlinkSync(previewPath); } catch { /* ignore */ }

  // Append preview flags — proj preview is near-free (linear projection, no VAE decode)
  args.push('--preview', 'proj', '--preview-interval', '1', '--preview-path', previewPath);

  let previewWatcher: ReturnType<typeof setInterval> | null = null;
  let lastPreviewMtime = 0;

  // macOS: the CI-built sd-cli binary has @rpath baked to the GitHub runner's
  // build directory, which doesn't exist on user machines. DYLD_LIBRARY_PATH
  // tells dyld to also search the binary's own directory for companion dylibs
  // (libstable-diffusion.dylib). Harmless no-op on Linux/Windows.
  const binDir = path.dirname(bin);
  if (process.platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = binDir + (env.DYLD_LIBRARY_PATH ? `:${env.DYLD_LIBRARY_PATH}` : '');
  }

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

    // Start preview file watcher — polls every 500ms for file changes
    previewWatcher = setInterval(() => {
      try {
        if (!fs.existsSync(previewPath)) return;
        const stat = fs.statSync(previewPath);
        const mtime = stat.mtimeMs;
        if (mtime <= lastPreviewMtime || stat.size < 100) return; // unchanged or too small
        lastPreviewMtime = mtime;
        const data = fs.readFileSync(previewPath);
        const b64 = data.toString('base64');
        onProgress?.(`__PREVIEW__${b64}`);
      } catch { /* file may be mid-write — skip this tick */ }
    }, 500);

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
      if (previewWatcher) { clearInterval(previewWatcher); previewWatcher = null; }
      if (code === 0 || signal === 'SIGTERM' || signal === 'SIGKILL') resolve();
      else reject(new Error(`sd-cli exited with code ${code} (signal: ${signal})`));
    });

    proc.on('error', (err) => {
      if (previewWatcher) { clearInterval(previewWatcher); previewWatcher = null; }
      reject(err);
    });
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
  let gpuName         = '';
  let sdBinaryChoice: 'cuda' | 'vulkan' | 'rocm' | 'cpu' = 'cuda';

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
      gpuName         = bestGpu.name ?? '';

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
    // Unified memory fast path: Apple Metal and AMD APUs with real shared VRAM.
    // Intel iGPUs report unifiedMemory=true but Vulkan can't allocate large
    // device buffers (OOMs at 1 GB on HD 5500). Only trust unified memory
    // for image gen on Metal or when reported VRAM is ≥4 GB.
    const viableUnified = isUnifiedMemory && (gpuBackend === 'metal' || totalVramGb >= 4);
    if (viableUnified) {
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

  // ── Tight-VRAM: no offload needed, just VAE tiling ─────────────────────────
  // On 8 GB cards Windows eats 1+ GB for display/driver, leaving ~7 GB free.
  // Chroma Q4 (5.18 GB) + T5 Q3 (2.3 GB) + VAE (0.09 GB) = 7.5 GB — fits via
  // CUDA VMM which spills ~0.4 GB to system RAM during model load.
  // Diffusion steps run fine, but VAE decode needs ~2.5 GB working memory and
  // OOMs. --vae-tiling drops VAE working memory from ~2560 MB to ~176 MB.
  //
  // --offload-to-cpu was tried but crashes on Pascal (GTX 1070, sm_61) with
  // access violation during split-backend tensor allocation. Not viable.
  //
  // offloadToCpu remains enabled for unified memory (set earlier, line ~492).

  // Aux selection by runner profile
  let auxFiles: FluxAuxFile[];

  switch (spec.runnerProfile) {
    case 'sdxl':
      auxFiles = [...SDXL_AUX_REQUIRED];
      console.log(`[ImageServerManager] Selected model: ${spec.label} (SDXL runner)`);
      break;

    case 'flux1-kontext':
      // Kontext shares the FLUX.1 aux pool — VAE + CLIP-L + T5 (tiered by VRAM).
      // The -r flag and --vae-decode-only false are added at arg-build time.
      {
        const t5VramBudget = freeVramGb > 0 ? freeVramGb : totalVramGb;
        const t5 = recommendT5Encoder(spec, t5VramBudget, isUnifiedMemory || offloadToCpu);
        auxFiles = [...KONTEXT_AUX_REQUIRED, t5];
        console.log(`[ImageServerManager] Selected model: ${spec.label} (flux1-kontext runner) · T5: ${t5.label}`);
      }
      break;

    case 'flux2':
      // Fixed aux: new VAE + LLM encoder. No T5 selection needed.
      auxFiles = spec.modelId.includes('9b') ? [...FLUX2_9B_AUX_REQUIRED] : [...FLUX2_4B_AUX_REQUIRED];
      console.log(`[ImageServerManager] Selected model: ${spec.label} (flux2 runner)${offloadToCpu ? ' (CPU offload)' : ''}`);
      break;

    case 'z-image':
      auxFiles = [...ZIMAGE_AUX_REQUIRED];
      console.log(`[ImageServerManager] Selected model: ${spec.label} (z-image runner)${offloadToCpu ? ' (CPU offload)' : ''}`);
      break;

    case 'qwen-image':
      auxFiles = [...QWEN_IMAGE_AUX_REQUIRED];
      console.log(`[ImageServerManager] Selected model: ${spec.label} (qwen-image runner)${offloadToCpu ? ' (CPU offload)' : ''}`);
      break;

    case 'wan':
      // Wan uses fixed aux: WAE VAE + UMT5 T5 encoder (no T5 tier selection — one size fits all).
      auxFiles = [...WAN_AUX_REQUIRED];
      console.log(`[ImageServerManager] Selected model: ${spec.label} (wan runner)${offloadToCpu ? ' (CPU offload)' : ''}`);
      break;

    default: {
      // flux and chroma — T5 tiered by VRAM, chroma skips CLIP-L.
      // Use freeVramGb (live reading after SAYON is stopped) when available —
      // totalVramGb ignores driver overhead, Windows display VRAM, and
      // persistent CUDA contexts that permanently reduce usable capacity.
      const t5VramBudget = freeVramGb > 0 ? freeVramGb : totalVramGb;
      const t5 = recommendT5Encoder(spec, t5VramBudget, isUnifiedMemory || offloadToCpu);
      const baseAux = spec.variant === 'chroma' ? CHROMA_AUX_REQUIRED : FLUX_AUX_REQUIRED;
      auxFiles = [...baseAux, t5];
      console.log(`[ImageServerManager] Selected model: ${spec.label} (${spec.runnerProfile} runner) · T5: ${t5.label}${offloadToCpu ? ' (CPU offload)' : ''}`);
    }
  }

  const modelType: SdModelType = (() => {
    switch (spec.runnerProfile) {
      case 'sdxl':          return 'sdxl';
      case 'flux1-kontext': return 'kontext';
      case 'flux2':         return 'flux2';
      case 'z-image':       return 'z-image';
      case 'qwen-image':    return 'qwen-image';
      case 'wan':           return 'wan';
      default:              return spec.variant === 'chroma' ? 'chroma' : 'flux';
    }
  })();

  return {
    modelType,
    fluxSpec: spec,
    auxFiles,
    deviceIndex,
    gpuBackend,
    freeVramGb,
    needsPtxJit,
    gpuName,
    offloadToCpu,
    sdBinary: sdBinaryChoice,
    ...overrides,
  };
}
