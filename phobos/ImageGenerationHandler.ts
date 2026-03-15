import * as fs from 'fs';
import * as path from 'path';
import {
  generateImage,
  buildSdConfig,
  type GenerateImageOptions,
  type GenerateImageResult,
  type SdServerConfig,
} from './ImageServerManager.js';
import { stopServer, startServer, getServerStatus } from './LlamaServerManager.js';

// ── Output directory ──────────────────────────────────────────────────────────

export function imageOutputDir(threadId: string): string {
  // Images are stored under the same workspaces root that ThreadWorkspace uses,
  // keeping all thread artifacts in one place.
  // ThreadWorkspace uses process.env.WORKSPACES_ROOT ?? './workspaces' (relative to cwd).
  const workspacesRoot = process.env.WORKSPACES_ROOT
    ? path.resolve(process.env.WORKSPACES_ROOT)
    : path.resolve(process.cwd(), 'workspaces');
  return path.join(workspacesRoot, threadId, 'images');
}

export function imageOutputPath(threadId: string, filename: string): string {
  return path.join(imageOutputDir(threadId), filename);
}

// ── SSE event types ───────────────────────────────────────────────────────────

export type ImageGenPhase =
  | 'stopping_seren'
  | 'generating'
  | 'restarting_seren'
  | 'done'
  | 'error';

export interface ImageGenStatus {
  phase:       ImageGenPhase;
  message:     string;
  estSeconds?: number;
  result?:     GenerateImageResult;
  error?:      string;
}

// ── Debug logging ─────────────────────────────────────────────────────────────

const DEBUG = process.env.PHOBOS_DEBUG === '1' || process.env.PHOBOS_DEBUG === 'true';

export function debugLog(tag: string, ...args: unknown[]): void {
  if (DEBUG) console.log(`[${tag}]`, ...args);
}

// ── Server snapshot (generic — sayon OR seren, whichever is on the target GPU)

type ServerRole = 'sayon' | 'seren';

interface ServerSnapshot {
  role:        ServerRole;
  modelId:     string;
  port:        number;
  gpuLayers:   number;
  contextSize: number;
  threads:     number;
  deviceIndex?: number;
  gpuBackend?:  'cuda' | 'vulkan' | 'metal';
}

/** @deprecated Use snapshotServerOnDevice() instead */
interface SerenSnapshot extends ServerSnapshot {}

// ── Time estimates ────────────────────────────────────────────────────────────

function estimateSeconds(modelId: string, backend: string | undefined): number {
  const estimates: Record<string, Record<string, number>> = {
    'flux-schnell-q4':        { cuda: 12,  vulkan: 45,  metal: 30,  cpu: 480  },
    'flux-schnell-q8':        { cuda: 15,  vulkan: 60,  metal: 40,  cpu: 600  },
    'flux-dev-q4':            { cuda: 90,  vulkan: 300, metal: 200, cpu: 3600 },
    'flux-dev-q8':            { cuda: 110, vulkan: 380, metal: 250, cpu: 4200 },
    'chroma-q4':              { cuda: 170, vulkan: 500, metal: 350, cpu: 5000 },
    'realvis-xl-v5-q4':       { cuda: 10,  vulkan: 35,  metal: 25,  cpu: 360  },
    'cyberrealistic-pony-q4': { cuda: 10,  vulkan: 35,  metal: 25,  cpu: 360  },
  };
  const row = estimates[modelId];
  if (!row) return 60;
  return row[backend ?? 'vulkan'] ?? row['vulkan'];
}

// ── Core swap + generate ──────────────────────────────────────────────────────
//
// CLI mode swap sequence (simpler than server mode):
//   1. Stop SEREN  — frees VRAM for sd-cli
//   2. Run sd-cli    — spawns, generates, exits automatically
//   3. Restart SEREN
//
// No explicit "stop sd-server" phase — sd-cli exits on its own when done.

export async function* generateWithFlux(
  threadId:    string,
  prompt:      string,
  opts:        Omit<GenerateImageOptions, 'prompt'>,
  /** @deprecated pass null and let generateWithFlux detect the server automatically */
  _legacySnap: ServerSnapshot | null = null,
  sdCfg:       SdServerConfig | null = null,
): AsyncGenerator<ImageGenStatus> {

  // ── Preliminary config — device targeting only ─────────────────────────────
  // We need to know which GPU to target before we stop the server.
  // T5 encoder selection happens AFTER the stop so free VRAM is accurate.
  let sdCfgPrelim = sdCfg;
  if (!sdCfgPrelim) {
    sdCfgPrelim = await buildSdConfig();
    if (!sdCfgPrelim) {
      yield {
        phase:   'error',
        message: 'No image model is downloaded. Please download a model from the Image Models panel.',
        error:   'NO_IMAGE_MODEL',
      };
      return;
    }
  }

  // ── Detect ALL servers occupying the target device and stop them ──────────
  // Both sayon and seren may be on the same GPU in single-GPU configs.
  // Stopping only one leaves the other holding VRAM, causing stalls at step 12.
  const targetDevice = sdCfgPrelim.deviceIndex;
  const snaps = snapshotAllServersOnDevice(targetDevice);
  const roleLabel = snaps.length > 0 ? snaps.map(s => s.role.toUpperCase()).join(' + ') : 'LLM server';

  yield { phase: 'stopping_seren', message: `Pausing ${roleLabel}…` };
  for (const snap of snaps) {
    try {
      await stopServer(snap.role);
      debugLog('ImageGenerationHandler', `stopped ${snap.role} on device ${targetDevice ?? 'cpu'}`);
    } catch (err) {
      console.warn(`[ImageGenerationHandler] stopServer(${snap.role}) warning: ${(err as Error).message}`);
    }
  }
  if (snaps.length === 0) {
    debugLog('ImageGenerationHandler', 'no servers running on target device — skipping stop');
  }

  // ── Re-query VRAM now that the LLM has freed its memory ───────────────────
  // nvidia-smi reports stale numbers immediately after a process dies — the GPU
  // driver takes up to ~2s to reclaim and update accounting.
  // Strategy: poll until free VRAM stops rising (two consecutive equal readings),
  // which means the driver has finished reclaiming. Fall back to 5s max timeout.
  // We do NOT use an absolute threshold — on machines where a CPU-only llama-server
  // holds a CUDA context (typically ~1-2 GB overhead on Windows), the theoretical
  // peak free VRAM is permanently reduced and an absolute threshold may never fire.
  if (!sdCfg) {
    const SETTLE_POLL_MS = 500;
    const SETTLE_MAX_MS  = 5000;
    const SETTLE_START   = Date.now();
    let lastFreeGb       = sdCfgPrelim.freeVramGb ?? 0;

    while (true) {
      await new Promise(r => setTimeout(r, SETTLE_POLL_MS));
      const candidate = await buildSdConfig();
      if (candidate) {
        sdCfg = candidate;
        const free    = candidate.freeVramGb ?? 0;
        const elapsed = Date.now() - SETTLE_START;
        console.log(`[ImageGenerationHandler] Post-stop VRAM: ${free.toFixed(1)} GB free (${elapsed}ms elapsed)`);
        // Stable = free VRAM has not risen since last poll — driver is done reclaiming
        const stable = free <= lastFreeGb;
        lastFreeGb = free;
        if (stable || elapsed >= SETTLE_MAX_MS) break;
      } else if (Date.now() - SETTLE_START >= SETTLE_MAX_MS) {
        break;
      }
    }

    if (!sdCfg) {
      yield { phase: 'error', message: 'Hardware config lost after server stop.', error: 'NO_IMAGE_MODEL' };
      return;
    }
  }

  const modelId      = sdCfg.fluxSpec.modelId;
  const backend      = sdCfg.gpuBackend;
  const estSecs      = estimateSeconds(modelId, backend);
  const backendLabel = backend === 'cuda'   ? 'CUDA'
                     : backend === 'metal'  ? 'Metal'
                     : backend === 'vulkan' ? 'Vulkan'
                     : 'CPU';

  let generationResult: GenerateImageResult | null = null;
  let generationError:  string | null = null;

  try {
    // ── Generate ──────────────────────────────────────────────────────────────
    yield {
      phase:      'generating',
      message:    `Generating on ${backendLabel} · ${sdCfg.fluxSpec.label} · est. ~${estSecs}s`,
      estSeconds: estSecs,
    };

    const timestamp = Date.now();
    const filename  = `image-${timestamp}.png`;
    const outPath   = imageOutputPath(threadId, filename);

    generationResult = await generateImage(outPath, sdCfg, { prompt, ...opts });

  } catch (err) {
    generationError = (err as Error).message;
    console.error(`[ImageGenerationHandler] Generation failed: ${generationError}`);
  } finally {
    // ── Restart all servers we stopped (always) ────────────────────────────
    if (snaps.length > 0) {
      yield { phase: 'restarting_seren', message: `Reloading ${roleLabel}…` };
      for (const snap of snaps) {
        try {
          await startServer(snap.role, {
            modelId:     snap.modelId,
            port:        snap.port,
            gpuLayers:   snap.gpuLayers,
            contextSize: snap.contextSize,
            threads:     snap.threads,
            deviceIndex: snap.deviceIndex,
            gpuBackend:  snap.gpuBackend,
          });
          debugLog('ImageGenerationHandler', `restarted ${snap.role}`);
        } catch (err) {
          console.error(`[ImageGenerationHandler] ${snap.role} restart failed: ${(err as Error).message}`);
        }
      }
    } else {
      debugLog('ImageGenerationHandler', 'no servers to restart — skipping');
    }
  }

  // ── Done or error ──────────────────────────────────────────────────────────
  if (generationError) {
    yield {
      phase:   'error',
      message: `Image generation failed: ${generationError}`,
      error:   generationError,
    };
  } else {
    yield {
      phase:   'done',
      message: 'Image ready',
      result:  generationResult!,
    };
  }
}

// ── Server snapshot helpers ───────────────────────────────────────────────────

/**
 * Returns a snapshot of whichever server (sayon or seren) is currently
 * running on the given device index.  If deviceIndex is undefined (CPU),
 * we fall back to checking seren then sayon.
 * Returns null if no server is running on that device.
 */
/**
 * Returns ALL running servers on the target device.
 * When both sayon and seren are on the same GPU (e.g. one-GPU configs where
 * sayon is manually pinned to the same device as seren), stopping only one
 * leaves the other holding VRAM throughout generation. Both must be stopped.
 */
export function snapshotAllServersOnDevice(deviceIndex?: number): ServerSnapshot[] {
  const status = getServerStatus();
  const roles: ServerRole[] = ['seren', 'sayon'];
  const snaps: ServerSnapshot[] = [];

  for (const role of roles) {
    const s = status[role];
    if (s.state !== 'running' || !s.modelId) continue;

    // Only stop a server if it is actually occupying the target GPU:
    //   1. gpuLayers must be > 0 — ngl=0 means CPU-only, holds no VRAM, never stop it.
    //   2. deviceIndex must match the target device when both are defined.
    // A server on CPU (ngl=0 or deviceIndex=undefined) is never a VRAM competitor.
    if (s.gpuLayers === 0) continue;

    if (deviceIndex !== undefined && s.deviceIndex !== undefined) {
      if (s.deviceIndex !== deviceIndex) continue;
    }
    snaps.push({
      role,
      modelId:     s.modelId,
      port:        s.port,
      gpuLayers:   s.gpuLayers,
      contextSize: 32768,
      threads:     0,
      deviceIndex: s.deviceIndex as number | undefined,
      gpuBackend:  s.gpuBackend as ServerSnapshot['gpuBackend'],
    });
  }
  return snaps;
}

/** @deprecated Use snapshotAllServersOnDevice() instead */
export function snapshotServerOnDevice(deviceIndex?: number): ServerSnapshot | null {
  return snapshotAllServersOnDevice(deviceIndex)[0] ?? null;
}

/** @deprecated Use snapshotServerOnDevice() instead */
export function snapshotSeren(): ServerSnapshot | null {
  const status = getServerStatus();
  const s = status.seren;
  if (s.state !== 'running' || !s.modelId) return null;
  return {
    role:        'seren',
    modelId:     s.modelId,
    port:        s.port,
    gpuLayers:   99,
    contextSize: 32768,
    threads:     0,
    deviceIndex: s.deviceIndex as number | undefined,
    gpuBackend:  s.gpuBackend as ServerSnapshot['gpuBackend'],
  };
}
