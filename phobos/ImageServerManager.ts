import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  resolveSdServerBin,
  fluxModelPath,
  highNoiseModelPath,
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
  queryGpuFreeVram,
  type GpuDevice,
  type ImageModelSpec,
  type FluxAuxFile,
} from './PhobosLocalManager.js';

export type SdModelType = 'flux' | 'chroma' | 'sdxl' | 'kontext' | 'flux2' | 'z-image' | 'qwen-image' | 'wan';

export interface SdServerConfig {
  modelType:    SdModelType;
  fluxSpec:     ImageModelSpec;  // unified — covers flux, chroma, and sdxl specs
  auxFiles:     FluxAuxFile[];
  deviceIndex?: number;
  vulkanIndex?: number;          // physical Vulkan enumeration index (from GpuRunnerProfile)
  gpuBackend?:  'cuda' | 'vulkan' | 'metal';
  freeVramGb?:  number;         // live free VRAM at config-build time (for polling/logging)
  needsPtxJit?: boolean;        // true for Blackwell+ GPUs lacking native cubins in sd-cli
  gpuName?:     string;         // GPU name string for architecture-specific env vars
  /** Which sd-cli binary to use — from GpuRunnerProfile.sdBinary */
  sdBinary?:    'cuda' | 'vulkan' | 'rocm' | 'cpu';
  /** Pass --offload-to-cpu to sd-cli. Free on unified memory (AMD iGPU, Apple Silicon). */
  offloadToCpu?: boolean;
  /** Absolute path to the HighNoise expert GGUF (Wan 2.2 MoE). Passed as --high-noise-diffusion-model. */
  highNoiseDiffusionModel?: string;
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
  // Wan 2.2 MoE dual-expert
  highNoiseCfgScale?:      number;   // --high-noise-cfg-scale (default: same as cfgScale)
  highNoiseSamplingMethod?: string;  // --high-noise-sampling-method (default: same as sampler)
  highNoiseSteps?:          number;  // --high-noise-steps (default: ~80% of steps)
  flowShiftWan?:            number;  // --flow-shift for Wan 2.2 (default 3.0)
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
  // VAE decode needs ~2.5 GB working memory at 1024×1024. After loading the
  // diffusion model + T5 encoder (~10 GB for Flux), there's rarely enough free
  // VRAM for the full decode buffer. --vae-tiling splits it into 512×512 tiles,
  // dropping peak to ~176 MB with negligible quality/speed cost.
  args.push('--vae-tiling');
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
  // Always tile VAE — Chroma + T5 Q8 leaves only ~4.5 GB free on 16 GB cards,
  // nowhere near the ~8.5 GB needed for a full 1024×1024 VAE decode buffer.
  args.push('--vae-tiling');
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
  args.push('--vae-tiling');
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
  args.push('--vae-tiling');
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
  // Always tile VAE — safe at all VRAM levels, prevents OOM on decode.
  args.push('--vae-tiling');
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
  args.push('--vae-tiling');
  return args;
}

function buildWanArgs(
  cfg:     SdServerConfig,
  opts:    GenerateImageOptions,
  outPath: string,
): string[] {
  const spec        = cfg.fluxSpec;
  const steps       = opts.steps       ?? cfg.steps  ?? (spec.highNoiseHfFile ? 10 : 20);
  const seed        = opts.seed        ?? 42;
  const fps         = opts.fps         ?? 12;
  // Safe defaults by model size: 1.3B → 49 frames (4s), 14B → 49 frames (4s at 12fps).
  // User can increase via videoFrames param in the panel.
  const videoFrames = opts.videoFrames ?? 49;
  // Wan video output dimensions: 480P is 832×480 for widescreen, 480×832 for portrait.
  // Default to landscape 480P — fits all VRAM budgets.
  const width  = opts.width  ?? cfg.width  ?? 832;
  const height = opts.height ?? cfg.height ?? 480;
  const cfgScale = spec.profile?.defaultCfgScale ?? 5;

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
    '--cfg-scale',       String(cfgScale),
    '--fps',             String(fps),
    '--video-frames',    String(videoFrames),
    // --diffusion-fa required for Wan — black images without it (confirmed sd.cpp issue tracker)
    '--diffusion-fa',
    // Keep T5/text encoder on CPU to preserve GPU VRAM for diffusion — Wan T5 is 4+ GB
    '--clip-on-cpu',
    '-o',                outStem,
  ];

  // ── Wan 2.2 MoE dual-expert flags ──────────────────────────────────────────
  // --diffusion-model is the LowNoise expert (primary).
  // --high-noise-diffusion-model is the HighNoise expert (early denoising).
  // sd-cli switches between experts based on SNR threshold internally.
  if (cfg.highNoiseDiffusionModel) {
    args.push('--high-noise-diffusion-model', cfg.highNoiseDiffusionModel);
    // Per sd-cli docs: HighNoise expert can have independent sampling params.
    // Default HighNoise steps to ~80% of total (good balance per sd.cpp examples).
    const hnSteps  = opts.highNoiseSteps ?? Math.max(1, Math.round(steps * 0.8));
    const hnCfg    = opts.highNoiseCfgScale ?? cfgScale;
    const hnSampler = opts.highNoiseSamplingMethod ?? opts.sampler ?? 'euler';
    args.push('--high-noise-steps', String(hnSteps));
    args.push('--high-noise-cfg-scale', String(hnCfg));
    args.push('--high-noise-sampling-method', hnSampler);
    // --flow-shift recommended at 3.0 for Wan 2.2 (per sd.cpp wan.md docs)
    args.push('--flow-shift', String(opts.flowShiftWan ?? 3.0));
  }

  if (opts.negativePrompt) args.push('--negative-prompt', opts.negativePrompt);
  // I2V: pass the input image as --init-img (same field reused from img2img)
  if (opts.initImg)        args.push('--init-img', opts.initImg);
  if (cfg.offloadToCpu)    args.push('--offload-to-cpu');
  args.push('--vae-tiling');
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
  // On multi-GPU systems, point sd-cli's Vulkan backend at the correct device.
  // Use the resolved vulkanIndex from the GPU runner profile (accounts for
  // NVIDIA GPUs occupying Vulkan slots ahead of AMD/Intel GPUs).
  // Fall back to deviceIndex - 100 only as a last resort.
  if (cfg.vulkanIndex !== undefined) {
    env.GGML_VK_VISIBLE_DEVICES = String(cfg.vulkanIndex);
  } else if (cfg.deviceIndex !== undefined && cfg.deviceIndex >= 100) {
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
  // MoE dual-model: verify HighNoise expert GGUF
  if (cfg.highNoiseDiffusionModel && !fs.existsSync(cfg.highNoiseDiffusionModel)) {
    missing.push(`high-noise model: ${spec.highNoiseHfFile ?? cfg.highNoiseDiffusionModel}`);
  }
  for (const aux of cfg.auxFiles) {
    if (!fs.existsSync(fluxAuxPath(aux))) missing.push(`aux: ${aux.hfFile}`);
  }
  if (missing.length > 0) {
    throw new Error(`sd-cli cannot run — missing files:\n  ${missing.join('\n  ')}`);
  }

  outputPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // ── Pre-flight VRAM check with retry ────────────────────────────────────────
  // Computes exact VRAM needed from model component sizes, then polls LIVE free
  // VRAM up to 10 times (3s apart = 30s max). Uses queryGpuFreeVram() which
  // calls nvidia-smi (NVIDIA), DXGI counters (Windows AMD/Intel), or sysfs (Linux AMD)
  // — never the cached hardware profile.
  // Skipped for: CPU binary (no VRAM), unified memory (RAM pool, no discrete gate).
  const isDiscreteGpuPath = (cfg.gpuBackend === 'cuda' || cfg.gpuBackend === 'vulkan')
    && cfg.sdBinary !== 'cpu'
    && !(cfg.offloadToCpu);  // unified memory with offload → skip VRAM gate

  if (isDiscreteGpuPath) {
    const diffMb    = spec.diffusionMb ?? Math.ceil(spec.sizeBytes / (1024 * 1024));
    // Built-in encoder (Z-Image, Klein, Qwen-Image) or external T5
    let encMb       = spec.encoderMb ?? 0;
    if (encMb === 0 && spec.runnerProfile !== 'sdxl') {
      const t5Aux   = cfg.auxFiles.find(a => a.cliFlag === '--t5xxl');
      encMb         = t5Aux ? Math.ceil(t5Aux.sizeBytes / (1024 * 1024)) : 0;
    }
    const vaeMb     = spec.vaeMb ?? 160;
    const workingMb = cfg.gpuBackend === 'cuda' ? 512 : 256;
    // With --offload-to-cpu, only the largest single component is in VRAM at once.
    // Without offload, all components must fit simultaneously.
    const modelMb   = cfg.offloadToCpu
      ? Math.max(diffMb, encMb, vaeMb)
      : diffMb + encMb + vaeMb;
    const requiredMb = modelMb + workingMb;

    console.log(
      `[ImageServerManager] Pre-flight VRAM (${cfg.gpuBackend}${cfg.offloadToCpu ? ', offload' : ''}): need ~${requiredMb} MB ` +
      `(${cfg.offloadToCpu ? 'peak component' : 'total'}: diffusion ${diffMb}, encoder ${encMb}, VAE ${vaeMb} + working ${workingMb})`
    );

    // Resolve target GPU object once — used for all live queries in the loop.
    const hw = await detectHardware();
    const targetGpu = hw.gpus.find(g => g.index === (cfg.deviceIndex ?? 0));

    const MAX_ATTEMPTS = 10;
    const WAIT_MS      = 3000;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (aborted) return { outputPath, seed: -1, elapsedMs: 0 };
      try {
        const freeMb = targetGpu ? (await queryGpuFreeVram(targetGpu) ?? 0) : 0;

        console.log(`[ImageServerManager] VRAM check ${attempt + 1}/${MAX_ATTEMPTS}: need ${requiredMb} MB, have ${freeMb} MB free`);

        if (freeMb >= requiredMb) break; // enough VRAM, proceed

        if (attempt === MAX_ATTEMPTS - 1) {
          const shortGb = ((requiredMb - freeMb) / 1024).toFixed(1);
          throw new Error(
            `Not enough free VRAM: model needs ~${(requiredMb / 1024).toFixed(1)} GB ` +
            `but only ${(freeMb / 1024).toFixed(1)} GB is available (${shortGb} GB short). ` +
            `Close other GPU applications and try again, or select a smaller model.`
          );
        }
      } catch (err) {
        if ((err as Error).message?.includes('Not enough free VRAM')) throw err;
        // Live query failed — continue trying
      }
      await new Promise(r => setTimeout(r, WAIT_MS));
    }
  }

  if (aborted) return { outputPath, seed: -1, elapsedMs: 0 }; // abort before spawn

  const bin = resolveSdServerBin(cfg.sdBinary ?? (cfg.gpuBackend === 'cuda' ? 'cuda' : cfg.gpuBackend === 'vulkan' ? 'vulkan' : 'cpu'));
  if (process.platform !== 'win32') {
    try { fs.chmodSync(bin, 0o755); } catch { /* ignore */ }
  }

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

  // ── ROCm crash detection ─────────────────────────────────────────────────
  // Windows NTSTATUS codes that indicate the ROCm/HIP runtime is incompatible
  // with the current GPU (e.g. gfx1200/RDNA 4 on HIP SDK 7.1).
  // 0xC000001D = STATUS_ILLEGAL_INSTRUCTION — GPU kernel has unsupported instructions
  // 0xC0000135 = STATUS_DLL_NOT_FOUND       — missing HIP runtime DLL
  // When these occur with the ROCm binary, we retry once with Vulkan.
  const ROCM_CRASH_CODES = new Set([
    3221225501,  // 0xC000001D — ILLEGAL_INSTRUCTION
    3221225781,  // 0xC0000135 — DLL_NOT_FOUND
  ]);
  let rocmCrashCode: number | null = null;

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

    let sawRocmError = false;

    proc.stdout?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) {
        console.log(`[sd-cli] ${line}`);
        onProgress?.(line);
      }
    });
    proc.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) {
        console.log(`[sd-cli] ${line}`);
        // Detect ROCm/HIP runtime errors in stderr — these indicate the GPU
        // arch is unsupported by the bundled Tensile kernels or hipBLAS.
        if (/CUBLAS_STATUS_INTERNAL_ERROR|hipblasSetStream|Cannot read TensileLibrary/i.test(line)) {
          sawRocmError = true;
        }
      }
    });

    proc.on('exit', (code, signal) => {
      if (previewWatcher) { clearInterval(previewWatcher); previewWatcher = null; }
      if (code === 0 || signal === 'SIGTERM' || signal === 'SIGKILL') resolve();
      else if (cfg.sdBinary === 'rocm' && code !== null && ROCM_CRASH_CODES.has(code)) {
        // ROCm binary crashed with a known incompatibility code — flag for Vulkan retry
        rocmCrashCode = code;
        resolve(); // resolve (not reject) so the fallback below runs
      }
      else if (cfg.sdBinary === 'rocm' && sawRocmError && code !== 0) {
        // ROCm error detected in stderr with a non-zero exit — treat as ROCm crash
        rocmCrashCode = code ?? -1;
        resolve();
      }
      else reject(new Error(`sd-cli exited with code ${code} (signal: ${signal})`));
    });

    proc.on('error', (err) => {
      if (previewWatcher) { clearInterval(previewWatcher); previewWatcher = null; }
      reject(err);
    });
  });

  // ── ROCm → Vulkan automatic fallback ───────────────────────────────────────
  // If the ROCm binary crashed with an incompatible-GPU code, retry the exact
  // same generation using the Vulkan binary. This happens on RDNA 4 (gfx1200)
  // because HIP SDK 7.1's Tensile kernels emit instructions the GPU doesn't
  // support. ROCm 7.2+ fixes this, but until the Windows HIP SDK ships 7.2,
  // Vulkan is the reliable fallback path.
  if (rocmCrashCode !== null) {
    const hex = '0x' + (rocmCrashCode >>> 0).toString(16).toUpperCase();
    console.warn(
      `[ImageServerManager] ROCm binary crashed (${hex}) — ` +
      `AMD HIP runtime incompatible with this GPU (likely gfx1200/RDNA 4 on HIP SDK <7.2). ` +
      `Retrying with Vulkan backend…`
    );
    onProgress?.(`ROCm unavailable — switching to Vulkan backend…`);

    // Mutate cfg to use Vulkan for this retry (and any subsequent calls in the
    // same workflow run will inherit the Vulkan path via the same cfg object).
    cfg.sdBinary = 'vulkan';
    return generateImage(outputPath, cfg, opts, onProgress, onAbortRegister);
  }

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
  overrides: Partial<SdServerConfig> & { modelId?: string; targetGpuIndex?: number } = {},
): Promise<SdServerConfig | null> {
  let totalVramGb     = 0;
  let freeVramGb      = 0;
  let deviceIndex: number | undefined;
  let vulkanIndex: number | undefined;
  let gpuBackend: SdServerConfig['gpuBackend'] | undefined;
  let isUnifiedMemory = false;
  let needsPtxJit     = false;
  let offloadToCpu    = false;
  let gpuName         = '';
  let sdBinaryChoice: 'cuda' | 'vulkan' | 'rocm' | 'cpu' = 'cuda';

  // ── CPU override: targetGpuIndex === -1 means user explicitly selected CPU ──
  if (overrides.targetGpuIndex === -1) {
    const os = await import('os');
    const ramGb = Math.floor(os.default.totalmem() / (1024 ** 3));
    console.log(`[ImageServerManager] CPU selected by user — using system RAM (${ramGb} GB)`);

    let spec: ImageModelSpec | null = null;
    if (overrides.modelId) {
      spec = getImageModelSpec(overrides.modelId) ?? null;
      if (spec && !isImageModelDownloaded(spec)) spec = null;
    }
    if (!spec) spec = recommendImageModel(ramGb, true, 'cpu');
    if (!spec) {
      console.warn('[ImageServerManager] No image model available for CPU');
      return null;
    }

    let auxFiles: FluxAuxFile[];
    switch (spec.runnerProfile) {
      case 'sdxl':  auxFiles = [...SDXL_AUX_REQUIRED]; break;
      case 'flux1-kontext': {
        const t5 = recommendT5Encoder(spec, ramGb, true);
        auxFiles = [...KONTEXT_AUX_REQUIRED, t5]; break;
      }
      case 'flux2':  auxFiles = spec.modelId.includes('9b') ? [...FLUX2_9B_AUX_REQUIRED] : [...FLUX2_4B_AUX_REQUIRED]; break;
      case 'z-image': auxFiles = [...ZIMAGE_AUX_REQUIRED]; break;
      case 'qwen-image': auxFiles = [...QWEN_IMAGE_AUX_REQUIRED]; break;
      case 'wan': auxFiles = [...WAN_AUX_REQUIRED]; break;
      default: {
        const t5 = recommendT5Encoder(spec, ramGb, true);
        auxFiles = spec.variant === 'chroma' ? [...CHROMA_AUX_REQUIRED, t5] : [...FLUX_AUX_REQUIRED, t5];
      }
    }
    console.log(`[ImageServerManager] Selected model: ${spec.label} (CPU)`);
    return {
      modelType: spec.runnerProfile === 'sdxl' ? 'sdxl' : (spec.runnerProfile ?? 'flux') as SdModelType,
      fluxSpec: spec,
      auxFiles,
      deviceIndex: undefined,
      vulkanIndex: undefined,
      gpuBackend: undefined,
      sdBinary: 'cpu',
      freeVramGb: 0,
      gpuName: 'CPU',
      highNoiseDiffusionModel: highNoiseModelPath(spec) ?? undefined,
    };
  }

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

    // If a specific GPU was requested (from workflow panel dropdown), use that.
    // Otherwise fall through to the auto-detected best GPU.
    const bestGpu = overrides.targetGpuIndex !== undefined
      ? hw.gpus.find(g => g.index === overrides.targetGpuIndex) ?? gpusByPriority[0]
      : gpusByPriority[0];
    if (bestGpu) {
      totalVramGb     = bestGpu.vramGb;
      deviceIndex     = bestGpu.index;
      vulkanIndex     = bestGpu.runner?.vulkanIndex;
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
  //
  // VRAM gate uses the largest single component (max of diffusion, encoder, VAE) because
  // --offload-to-cpu loads only the active component into VRAM at any given time.
  // sd-cli's offload: text_encoder → VRAM → run → free, diffusion → VRAM → denoise → free,
  // VAE → VRAM → decode → free. Peak VRAM = largest single component, not the sum.
  // Confirmed working on 4 GB GPUs per leejet/stable-diffusion.cpp wiki.
  let spec: ImageModelSpec | null = null;
  if (overrides.modelId) {
    spec = getImageModelSpec(overrides.modelId) ?? null;
    if (spec && !isImageModelDownloaded(spec)) {
      console.warn(`[ImageServerManager] Requested model ${overrides.modelId} is not downloaded`);
      spec = null;
    }
    // VRAM gate: compare peak single-component VRAM against total GPU VRAM.
    // With --offload-to-cpu, only the largest component needs to fit at once.
    if (spec && !isUnifiedMemory && totalVramGb > 0) {
      const peakMb = Math.max(spec.diffusionMb, spec.encoderMb, spec.vaeMb);
      const peakGb = peakMb / 1024;
      if (peakGb > totalVramGb) {
        console.warn(
          `[ImageServerManager] Requested model ${overrides.modelId} largest component ${peakGb.toFixed(1)} GB ` +
          `exceeds ${totalVramGb} GB VRAM — will route to CPU`
        );
        spec = null;
      }
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
      spec = recommendImageModel(ramGb, true, sdBinaryChoice);
      if (spec) console.log(`[ImageServerManager] Unified memory system — using RAM pool (${ramGb} GB) for model selection`);
    } else {
      spec = recommendImageModel(totalVramGb, false, sdBinaryChoice);
    }
  }

  // If no model fits GPU VRAM, fall back to CPU generation.
  // CPU uses the sd-cpu binary which has no VRAM requirement — it uses system RAM.
  // This handles: Radeon 520 (2GB discrete), Quadro M2000 (4GB, Chroma needs 8GB), etc.
  if (!spec) {
    const os = await import('os');
    const ramGb = Math.floor(os.default.totalmem() / (1024 ** 3));
    spec = recommendImageModel(ramGb, true, 'cpu'); // CPU mode — no Vulkan buffer limits
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

  // ── Tight-VRAM: enable --offload-to-cpu when needed ─────────────────────────
  // With --offload-to-cpu, sd-cli loads only the active component (encoder,
  // diffusion, VAE) into VRAM one at a time. Peak VRAM = largest single component.
  // This enables 4 GB GPUs to run models whose total footprint exceeds VRAM.
  // Confirmed working on 4 GB GPUs per leejet/stable-diffusion.cpp wiki.
  //
  // Enable offload on discrete GPUs when total model footprint exceeds VRAM.
  // Already enabled for unified memory (set earlier).
  if (!offloadToCpu && spec && totalVramGb > 0) {
    const totalModelMb = spec.diffusionMb + spec.encoderMb + spec.vaeMb;
    const totalModelGb = totalModelMb / 1024;
    if (totalModelGb > totalVramGb) {
      offloadToCpu = true;
      console.log(
        `[ImageServerManager] Model total ${totalModelGb.toFixed(1)} GB exceeds ${totalVramGb} GB VRAM ` +
        `— enabling --offload-to-cpu (peak component ${(Math.max(spec.diffusionMb, spec.encoderMb, spec.vaeMb) / 1024).toFixed(1)} GB fits)`
      );
    }
  }

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
    vulkanIndex,
    gpuBackend,
    freeVramGb,
    needsPtxJit,
    gpuName,
    offloadToCpu,
    sdBinary: sdBinaryChoice,
    // MoE dual-model: resolve HighNoise expert path if spec defines one
    highNoiseDiffusionModel: highNoiseModelPath(spec) ?? undefined,
    ...overrides,
  };
}
