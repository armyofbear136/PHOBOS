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
  | 'stopping_allmind'
  | 'generating'
  | 'restarting_allmind'
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

// ── Server snapshot (generic — sayon OR allmind, whichever is on the target GPU)

type ServerRole = 'sayon' | 'allmind';

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
interface AllmindSnapshot extends ServerSnapshot {}

// ── Time estimates ────────────────────────────────────────────────────────────

function estimateSeconds(modelId: string, backend: string | undefined): number {
  const estimates: Record<string, Record<string, number>> = {
    'flux-schnell-q4': { cuda: 12,  vulkan: 45,  metal: 30,  cpu: 480  },
    'flux-schnell-q8': { cuda: 15,  vulkan: 60,  metal: 40,  cpu: 600  },
    'flux-dev-q4':     { cuda: 90,  vulkan: 300, metal: 200, cpu: 3600 },
    'flux-dev-q8':     { cuda: 110, vulkan: 380, metal: 250, cpu: 4200 },
  };
  const row = estimates[modelId];
  if (!row) return 60;
  return row[backend ?? 'vulkan'] ?? row['vulkan'];
}

// ── Core swap + generate ──────────────────────────────────────────────────────
//
// CLI mode swap sequence (simpler than server mode):
//   1. Stop ALLMIND  — frees VRAM for sd-cli
//   2. Run sd-cli    — spawns, generates, exits automatically
//   3. Restart ALLMIND
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
        message: 'No FLUX model is downloaded. Please download a model from the Image Models panel.',
        error:   'NO_FLUX_MODEL',
      };
      return;
    }
  }

  // ── Detect which server (sayon or allmind) is occupying the target device ──
  const targetDevice = sdCfgPrelim.deviceIndex;
  const snap = snapshotServerOnDevice(targetDevice);
  const roleLabel = snap ? snap.role.toUpperCase() : 'LLM server';

  // ── Stop the server occupying our GPU ──────────────────────────────────────
  yield { phase: 'stopping_allmind', message: `Pausing ${roleLabel}…` };
  if (snap) {
    try {
      await stopServer(snap.role);
      debugLog('ImageGenerationHandler', `stopped ${snap.role} on device ${targetDevice ?? 'cpu'}`);
    } catch (err) {
      console.warn(`[ImageGenerationHandler] stopServer(${snap.role}) warning: ${(err as Error).message}`);
    }
  } else {
    debugLog('ImageGenerationHandler', 'no server running on target device — skipping stop');
  }

  // ── Re-query VRAM now that the LLM has freed its memory ───────────────────
  // nvidia-smi reports stale numbers immediately after a process dies — the GPU
  // driver takes up to ~2s to reclaim and update accounting. We poll until free
  // VRAM rises above the LLM's footprint (~2.5 GB for sayon), giving the driver
  // up to 5 seconds to settle before giving up and using whatever we got.
  if (!sdCfg) {
    const SETTLE_POLL_MS = 500;
    const SETTLE_MAX_MS  = 5000;
    const SETTLE_START   = Date.now();
    // sayon (llama3.2-3b-q4) holds ~2.5 GB; once free VRAM clears this we know
    // the driver has reclaimed the memory. Use 5 GB as a conservative threshold
    // — well above background noise, well below the full 10 GB.
    const FREE_VRAM_THRESHOLD_GB = 5;

    while (true) {
      await new Promise(r => setTimeout(r, SETTLE_POLL_MS));
      const candidate = await buildSdConfig();
      if (candidate) {
        sdCfg = candidate;
        const free = candidate.freeVramGb ?? 0;
        const elapsed = Date.now() - SETTLE_START;
        console.log(`[ImageGenerationHandler] Post-stop VRAM: ${free.toFixed(1)} GB free (${elapsed}ms elapsed)`);
        if (free >= FREE_VRAM_THRESHOLD_GB || elapsed >= SETTLE_MAX_MS) break;
      } else if (Date.now() - SETTLE_START >= SETTLE_MAX_MS) {
        break;
      }
    }

    if (!sdCfg) {
      yield { phase: 'error', message: 'Hardware config lost after server stop.', error: 'NO_FLUX_MODEL' };
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
    // ── Restart whichever server we stopped (always) ───────────────────────
    if (snap?.modelId) {
      yield { phase: 'restarting_allmind', message: `Reloading ${roleLabel}…` };
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
    } else {
      debugLog('ImageGenerationHandler', 'no server to restart — skipping');
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
 * Returns a snapshot of whichever server (sayon or allmind) is currently
 * running on the given device index.  If deviceIndex is undefined (CPU),
 * we fall back to checking allmind then sayon.
 * Returns null if no server is running on that device.
 */
export function snapshotServerOnDevice(deviceIndex?: number): ServerSnapshot | null {
  const status = getServerStatus();
  const roles: ServerRole[] = ['allmind', 'sayon'];

  for (const role of roles) {
    const s = status[role];
    if (s.state !== 'running' || !s.modelId) continue;

    // Match by device index when both are defined
    if (deviceIndex !== undefined && s.deviceIndex !== undefined) {
      if (s.deviceIndex !== deviceIndex) continue;
    }
    // CPU path: accept any running server when no device specified
    return {
      role,
      modelId:     s.modelId,
      port:        s.port,
      gpuLayers:   99,
      contextSize: 32768,
      threads:     0,
      deviceIndex: s.deviceIndex as number | undefined,
      gpuBackend:  s.gpuBackend as ServerSnapshot['gpuBackend'],
    };
  }
  return null;
}

/** @deprecated Use snapshotServerOnDevice() instead */
export function snapshotAllmind(): ServerSnapshot | null {
  const status = getServerStatus();
  const s = status.allmind;
  if (s.state !== 'running' || !s.modelId) return null;
  return {
    role:        'allmind',
    modelId:     s.modelId,
    port:        s.port,
    gpuLayers:   99,
    contextSize: 32768,
    threads:     0,
    deviceIndex: s.deviceIndex as number | undefined,
    gpuBackend:  s.gpuBackend as ServerSnapshot['gpuBackend'],
  };
}
