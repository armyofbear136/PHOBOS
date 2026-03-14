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
  upscaleInput?:   string;   // input image for upscale (--input)
  upscaleFactor?:  number;   // --upscale-repeats (factor)
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
    // Upscale is a separate mode — --input overrides normal generation
    args.push('--input', opts.upscaleInput);
    if (opts.upscaleFactor) args.push('--upscale-repeats', String(opts.upscaleFactor));
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
    if (cfg.deviceIndex !== undefined && cfg.deviceIndex < 100) {
      env.CUDA_VISIBLE_DEVICES = String(cfg.deviceIndex);
    }
    return env;
  }

  // Vulkan — do NOT touch CUDA_VISIBLE_DEVICES
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
): Promise<GenerateImageResult> {
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

  const bin = resolveSdServerBin();
  if (process.platform !== 'win32') {
    try { fs.chmodSync(bin, 0o755); } catch { /* ignore */ }
  }

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
      if (code === 0) resolve();
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

  try {
    const hw = await detectHardware();
    const backendScore = (g: typeof hw.gpus[0]): number =>
      (g.unifiedMemory || g.index >= 100) ? 0
      : g.backend === 'cuda'   ? 3
      : g.backend === 'metal'  ? 2
      : 1;
    const gpusByPriority = [...hw.gpus].sort((a, b) => {
      const scoreDiff = backendScore(b) - backendScore(a);
      return scoreDiff !== 0 ? scoreDiff : b.vramGb - a.vramGb;
    });
    const bestGpu = gpusByPriority[0];
    if (bestGpu) {
      totalVramGb     = bestGpu.vramGb;
      deviceIndex     = bestGpu.index;
      gpuBackend      = bestGpu.backend;
      isUnifiedMemory = bestGpu.unifiedMemory === true || bestGpu.index >= 100;
      freeVramGb      = bestGpu.freeVramGb ?? Math.max(0, totalVramGb - 1.5);

      console.log(
        `[ImageServerManager] VRAM budget: ${freeVramGb.toFixed(1)} GB free` +
        (bestGpu.freeVramGb !== undefined
          ? ` (live, total ${totalVramGb} GB)`
          : ` (estimated: total ${totalVramGb} GB − 1.5 GB reserve)`)
      );
    }
  } catch (err) {
    console.warn(`[ImageServerManager] Hardware detect failed: ${(err as Error).message}`);
  }

  // If a specific modelId was requested, look it up directly instead of auto-recommending
  let spec: ImageModelSpec | null = null;
  if (overrides.modelId) {
    spec = getImageModelSpec(overrides.modelId) ?? null;
    if (spec && !isImageModelDownloaded(spec)) {
      console.warn(`[ImageServerManager] Requested model ${overrides.modelId} is not downloaded`);
      spec = null;
    }
  }
  if (!spec) {
    spec = recommendFluxModel(totalVramGb);
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
    const t5 = recommendT5Encoder(spec, totalVramGb, isUnifiedMemory);
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
    ...overrides,
  };
}
