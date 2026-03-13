import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  resolveSdServerBin,
  fluxModelPath,
  fluxAuxPath,
  getFluxSpec,
  recommendFluxModel,
  recommendT5Encoder,
  FLUX_AUX_REQUIRED,
  detectHardware,
  type FluxSpec,
  type FluxAuxFile,
} from './PhobosLocalManager.js';

export type SdModelType = 'flux'; // 'sdxl' added in Phase 8 (Pony)

export interface SdServerConfig {
  modelType:    SdModelType;
  fluxSpec:     FluxSpec;
  auxFiles:     FluxAuxFile[];  // [VAE, CLIP-L, T5]
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
}

export interface GenerateImageResult {
  outputPath: string;
  seed:       number;
  elapsedMs:  number;
}

// ── Build CLI args ────────────────────────────────────────────────────────────
// sd-cli generates directly to a file — no server, no HTTP.
// Full arg reference confirmed from --help output.

function buildArgs(
  cfg:      SdServerConfig,
  opts:     GenerateImageOptions,
  outPath:  string,
): string[] {
  const spec   = cfg.fluxSpec;
  const steps  = opts.steps  ?? cfg.steps  ?? (spec.variant === 'schnell' ? 4 : 20);
  const width  = opts.width  ?? cfg.width  ?? 1024;
  const height = opts.height ?? cfg.height ?? 1024;
  const seed   = opts.seed   ?? 42;

  const args: string[] = [
    // Model files
    '--diffusion-model', fluxModelPath(spec),
    '--vae',             fluxAuxPath(cfg.auxFiles.find(a => a.cliFlag === '--vae')!),
    '--clip_l',          fluxAuxPath(cfg.auxFiles.find(a => a.cliFlag === '--clip_l')!),
    '--t5xxl',           fluxAuxPath(cfg.auxFiles.find(a => a.cliFlag === '--t5xxl')!),

    // Generation params
    '--prompt',          opts.prompt,
    '--steps',           String(steps),
    '--width',           String(width),
    '--height',          String(height),
    '--seed',            String(seed),
    '--sampling-method', opts.sampler ?? 'euler',

    // FLUX ignores cfg-scale internally but we pass guidance instead
    '--guidance',        '3.5',

    // Output
    '--output',          outPath,
  ];

  if (opts.negativePrompt) {
    args.push('--negative-prompt', opts.negativePrompt);
  }

  return args;
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
// The --rng flag only affects the noise RNG source, not the compute device.

// ── Build environment for GPU targeting ───────────────────────────────────────
// Mirrors LlamaServerManager env construction exactly.

function buildEnv(cfg: SdServerConfig): NodeJS.ProcessEnv {
  const env = { ...process.env };

  if (cfg.gpuBackend === 'metal') {
    // macOS Metal — binary handles this automatically, no env vars needed
    return env;
  }

  if (cfg.gpuBackend === 'cuda') {
    // NVIDIA CUDA — select specific GPU via env var
    if (cfg.deviceIndex !== undefined && cfg.deviceIndex < 100) {
      env.CUDA_VISIBLE_DEVICES = String(cfg.deviceIndex);
    }
    // Do NOT set CUDA_VISIBLE_DEVICES=-1 — that disables CUDA entirely
    return env;
  }

  // Vulkan (AMD iGPU, index >= 100) — do NOT touch CUDA_VISIBLE_DEVICES.
  // The CUDA binary will fall back to Vulkan/CPU if CUDA is unavailable on the device.
  // HSA vars only apply to ROCm builds, not CUDA builds.
  return env;
}

// ── Generate ──────────────────────────────────────────────────────────────────

/**
 * Spawns sd-cli, waits for it to complete, returns the output file path.
 * sd-cli is a one-shot CLI tool — no persistent process, no HTTP.
 * Each call spawns a fresh process and exits when the image is written.
 */
export async function generateImage(
  outputPath: string,
  cfg:        SdServerConfig,
  opts:       GenerateImageOptions,
): Promise<GenerateImageResult> {
  const spec = getFluxSpec(cfg.fluxSpec.modelId);
  if (!spec) throw new Error(`Unknown FLUX model ID: ${cfg.fluxSpec.modelId}`);

  // Verify all files exist before spawning
  const missing: string[] = [];
  if (!fs.existsSync(fluxModelPath(spec))) missing.push(`model: ${spec.hfFile}`);
  for (const aux of cfg.auxFiles) {
    if (!fs.existsSync(fluxAuxPath(aux))) missing.push(`aux: ${aux.hfFile}`);
  }
  if (missing.length > 0) {
    throw new Error(`sd-cli cannot run — missing files:\n  ${missing.join('\n  ')}`);
  }

  // Resolve to absolute path — sd-cli resolves relative paths from its own cwd (bin/)
  outputPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const bin  = resolveSdServerBin();
  if (process.platform !== 'win32') {
    try { fs.chmodSync(bin, 0o755); } catch { /* ignore */ }
  }

  const seed = opts.seed ?? 42;
  const args = buildArgs(cfg, { ...opts, seed }, outputPath);
  const env  = buildEnv(cfg);

  console.log(`[ImageServerManager] Spawning sd-cli — ${spec.label}`);
  console.log(`[ImageServerManager] ${bin} ${args.join(' ')}`);

  const startMs = Date.now();

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: path.dirname(bin), // so companion DLLs (stable-diffusion.dll etc.) are found
    });

    proc.stdout?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log(`[sd-cli] ${line}`);
    });
    proc.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log(`[sd-cli] ${line}`);
    });

    proc.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`sd-cli exited with code ${code} (signal: ${signal})`));
      }
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
  overrides: Partial<SdServerConfig> = {},
): Promise<SdServerConfig | null> {
  let totalVramGb     = 0;
  let freeVramGb      = 0;
  let deviceIndex: number | undefined;
  let gpuBackend: SdServerConfig['gpuBackend'] | undefined;
  let isUnifiedMemory = false;

  try {
    const hw = await detectHardware();
    // Sort priority: discrete CUDA/Metal > discrete Vulkan > UMA/unified.
    // UMA devices (index >= 100 or unifiedMemory=true) report shared system RAM as VRAM
    // which makes them sort above real discrete GPUs when sorted by raw VRAM alone.
    const backendScore = (g: typeof hw.gpus[0]): number =>
      (g.unifiedMemory || g.index >= 100) ? 0
      : g.backend === 'cuda'   ? 3
      : g.backend === 'metal'  ? 2
      : 1; // vulkan discrete
    const gpusByVram = [...hw.gpus].sort((a, b) => {
      const scoreDiff = backendScore(b) - backendScore(a);
      return scoreDiff !== 0 ? scoreDiff : b.vramGb - a.vramGb;
    });
    const bestGpu = gpusByVram[0];
    if (bestGpu) {
      totalVramGb     = bestGpu.vramGb;
      deviceIndex     = bestGpu.index;
      gpuBackend      = bestGpu.backend;
      isUnifiedMemory = bestGpu.unifiedMemory === true || bestGpu.index >= 100;

      // Use live free VRAM for encoder budgeting if available (CUDA only via nvidia-smi).
      // For non-CUDA devices or if the query failed, fall back to total minus a 1.5 GB
      // reserve for background GPU processes (browser, Discord, ALLMIND Vulkan context,
      // OS compositor, etc.) that consume VRAM invisibly from our perspective.
      freeVramGb = bestGpu.freeVramGb ?? Math.max(0, totalVramGb - 1.5);

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

  // Model selection uses total VRAM — the model must physically fit.
  const fluxSpec = recommendFluxModel(totalVramGb);
  if (!fluxSpec) {
    console.warn('[ImageServerManager] No FLUX model downloaded — cannot build config');
    return null;
  }

  // T5 encoder selection uses TOTAL VRAM — on CUDA VMM devices, free VRAM from
  // nvidia-smi underreports what CUDA can actually access. Total card capacity
  // is the reliable signal for whether a model tier will fit.
  const t5       = recommendT5Encoder(fluxSpec, totalVramGb, isUnifiedMemory);
  const auxFiles = [...FLUX_AUX_REQUIRED, t5];

  console.log(`[ImageServerManager] Selected T5: ${t5.label} (total VRAM: ${totalVramGb} GB, free: ${freeVramGb.toFixed(1)} GB)`);

  return {
    modelType: 'flux',
    fluxSpec,
    auxFiles,
    deviceIndex,
    gpuBackend,
    freeVramGb,
    ...overrides,
  };
}
