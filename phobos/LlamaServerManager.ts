import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { resolveLlamaServerBin, modelPath, getSpec, detectHardware, buildRecommendation } from './PhobosLocalManager.js';

// ── Ports — permanent wire contract ──────────────────────────────────────────
export const SAYON_PORT   = 52626;   // coordinator
export const ALLMIND_PORT = 52627;   // engine

export interface ServerConfig {
  modelId: string;
  port: number;
  gpuLayers: number;        // 0 = CPU only, 99 = full GPU offload
  contextSize: number;
  threads: number;
  /** GPU device index from HardwareProfile.gpus[].index */
  deviceIndex?: number;
  /** Backend for the target device — determines binary + env vars */
  gpuBackend?: 'cuda' | 'vulkan' | 'metal';
}

interface ManagedServer {
  config: ServerConfig;
  process: ChildProcess | null;
  state: 'stopped' | 'starting' | 'running' | 'error';
  error: string | null;
}

// ── Singleton manager ─────────────────────────────────────────────────────────

const servers: Record<'sayon' | 'allmind', ManagedServer> = {
  sayon:   { config: { modelId: '', port: SAYON_PORT,   gpuLayers: 0,  contextSize: 4096, threads: 4 }, process: null, state: 'stopped', error: null },
  allmind: { config: { modelId: '', port: ALLMIND_PORT, gpuLayers: 99, contextSize: 4096, threads: 4 }, process: null, state: 'stopped', error: null },
};

function waitForReady(port: number, timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      if (Date.now() > deadline) {
        reject(new Error(`Server on port ${port} not ready after ${timeoutMs}ms`));
        return;
      }
      const req = require('http').get(
        { hostname: '127.0.0.1', port, path: '/health', timeout: 2000 },
        (res: import('http').IncomingMessage) => {
          res.resume();
          if (res.statusCode === 200) { resolve(); return; }
          // 503 = model weights still loading — keep polling
          setTimeout(attempt, 1000);
        }
      );
      req.on('error', () => setTimeout(attempt, 1000));
      req.on('timeout', () => { req.destroy(); setTimeout(attempt, 1000); });
    };
    attempt();
  });
}

export async function startServer(role: 'sayon' | 'allmind', cfg: ServerConfig): Promise<void> {
  const managed = servers[role];

  // Stop existing process if model or device changed
  if (managed.process && (
    managed.config.modelId !== cfg.modelId ||
    managed.config.deviceIndex !== cfg.deviceIndex ||
    managed.config.gpuBackend !== cfg.gpuBackend
  )) {
    await stopServer(role);
  }

  if (managed.state === 'running' && managed.config.modelId === cfg.modelId) return;

  const spec = getSpec(cfg.modelId);
  if (!spec) throw new Error(`Unknown model ID: ${cfg.modelId}`);

  const ggufPath = modelPath(spec);

  // Resolve the llama-server binary (single binary, loads backend DLLs dynamically)
  const bin = resolveLlamaServerBin();

  managed.config = { ...cfg };
  managed.state  = 'starting';
  managed.error  = null;

  const cpuCount  = Math.max(1, Math.floor(require('os').cpus().length / 2));
  const threads   = cfg.threads > 0 ? cfg.threads : cpuCount;

  const args = [
    '--model',        ggufPath,
    '--port',         String(cfg.port),
    '--host',         '127.0.0.1',
    '--ctx-size',     String(cfg.contextSize),
    '--threads',      String(threads),
    '--n-gpu-layers', String(cfg.gpuLayers),
    '--log-disable',
  ];

  // Qwen3 thinking support: --jinja enables the Jinja chat template required
  // for thinking mode; --reasoning-format deepseek routes <think> blocks into
  // delta.reasoning_content instead of leaving them raw in delta.content.
  // Applied to allmind only — sayon runs Llama which uses tag-based thinking.
  if (role === 'allmind' && spec.modelId.startsWith('qwen3')) {
    args.push('--jinja', '--reasoning-format', 'deepseek');
  }

  // ── Build environment for GPU device targeting ──────────────────────────
  // llama.cpp Vulkan device selection:
  //   GGML_VK_VISIBLE_DEVICES=N   (env var, like CUDA_VISIBLE_DEVICES but for Vulkan)
  //   --device VulkanN             (CLI flag, selects backend device by name)
  //
  // On your system Vulkan enumerates:
  //   Vulkan0 = NVIDIA GeForce RTX 3080
  //   Vulkan1 = AMD Radeon(TM) 890M Graphics
  //
  // Our internal device indices: NVIDIA GPUs use nvidia-smi index (0, 1, ...),
  // non-NVIDIA GPUs use 100+ offset (100, 101, ...).
  // We map these to Vulkan device indices at runtime.
  const env = { ...process.env };

  if (cfg.gpuLayers > 0 && cfg.deviceIndex !== undefined) {
    if (cfg.deviceIndex >= 100) {
      // AMD iGPU as primary — match Ollama's multi-GPU approach:
      // Ollama sees both Vulkan devices and auto-splits layers across them.
      // CUDA_VISIBLE_DEVICES=-1 hides the CUDA backend but NOT the Vulkan
      // view of the NVIDIA GPU, so both GPUs remain available for layer splitting.
      // HSA_OVERRIDE_GFX_VERSION for AMD RDNA 3.5 iGPU compat.
      // --device Vulkan1 sets the 890M as the main/primary GPU.
      env.CUDA_VISIBLE_DEVICES = '-1';
      env.HSA_OVERRIDE_GFX_VERSION = '11.0.0';
      // Do NOT set GGML_VK_VISIBLE_DEVICES — let llama-server see all Vulkan
      // devices so it can split layers across 890M + 3080 like Ollama does.
      args.push('--device', 'Vulkan1');
    } else {
      // NVIDIA discrete GPU as primary
      env.GGML_VK_VISIBLE_DEVICES = String(cfg.deviceIndex);
      args.push('--device', 'Vulkan0');
    }
  } else if (cfg.gpuLayers > 0) {
    // No specific device — let llama-server auto-select
  }
  // ngl=0 means CPU-only — no device targeting needed

  console.log(`[LlamaServerManager] Starting ${role} on :${cfg.port} — ${spec.label} (ngl=${cfg.gpuLayers}, device=${cfg.deviceIndex ?? 'auto'}, backend=${cfg.gpuBackend ?? 'auto'})`);

  // Set cwd to the directory containing the binary so companion DLLs
  // (ggml-vulkan.dll, ggml-cpu-*.dll, ggml-rpc.dll, ggml-cuda.dll) are found.
  const binDir = path.dirname(bin);

  const proc = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    cwd: binDir,
  });

  proc.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[llama-server:${role}] ${line}`);
  });

  proc.on('exit', (code, signal) => {
    console.log(`[LlamaServerManager] ${role} exited code=${code} signal=${signal}`);
    managed.process = null;
    managed.state   = code === 0 ? 'stopped' : 'error';
    if (code !== 0 && code !== null) {
      managed.error = `Exited with code ${code}`;
    }
  });

  managed.process = proc;

  try {
    await waitForReady(cfg.port, 120_000);
    managed.state = 'running';
    console.log(`[LlamaServerManager] ${role} ready on :${cfg.port}`);
  } catch (err) {
    managed.state = 'error';
    managed.error = (err as Error).message;
    proc.kill();
    throw err;
  }
}

export async function stopServer(role: 'sayon' | 'allmind'): Promise<void> {
  const managed = servers[role];
  if (!managed.process) return;
  managed.process.kill('SIGTERM');
  await new Promise<void>(resolve => {
    const t = setTimeout(() => { managed.process?.kill('SIGKILL'); resolve(); }, 5000);
    managed.process!.once('exit', () => { clearTimeout(t); resolve(); });
  });
  managed.process = null;
  managed.state   = 'stopped';
}

export function getServerStatus(): Record<'sayon' | 'allmind', {
  state: string;
  modelId: string;
  port: number;
  error: string | null;
  deviceIndex?: number;
  gpuBackend?: string;
}> {
  return {
    sayon: {
      state:       servers.sayon.state,
      modelId:     servers.sayon.config.modelId,
      port:        SAYON_PORT,
      error:       servers.sayon.error,
      deviceIndex: servers.sayon.config.deviceIndex,
      gpuBackend:  servers.sayon.config.gpuBackend,
    },
    allmind: {
      state:       servers.allmind.state,
      modelId:     servers.allmind.config.modelId,
      port:        ALLMIND_PORT,
      error:       servers.allmind.error,
      deviceIndex: servers.allmind.config.deviceIndex,
      gpuBackend:  servers.allmind.config.gpuBackend,
    },
  };
}

export async function stopAllServers(): Promise<void> {
  await Promise.all([stopServer('sayon'), stopServer('allmind')]);
}

/**
 * Called by reconfigureClients() whenever model config changes.
 * If deviceIndex is not explicitly set, auto-detects hardware and applies
 * the recommendation for optimal GPU assignment.
 */
export async function reconcilePhobosServers(config: {
  coordinator: { provider: string; model: string; deviceIndex?: number; gpuBackend?: string; gpuLayers?: number };
  engine:      { provider: string; model: string; deviceIndex?: number; gpuBackend?: string; gpuLayers?: number };
}): Promise<void> {
  const tasks: Promise<void>[] = [];

  // Auto-detect hardware for device assignment when not explicitly configured
  const needsAutoDetect =
    (config.coordinator.provider === 'phobos' && config.coordinator.deviceIndex === undefined) ||
    (config.engine.provider === 'phobos' && config.engine.deviceIndex === undefined);

  let rec: Awaited<ReturnType<typeof buildRecommendation>> | null = null;
  let hw: Awaited<ReturnType<typeof detectHardware>> | null = null;
  if (needsAutoDetect) {
    try {
      hw = await detectHardware();
      rec = buildRecommendation(hw);
      console.log(`[reconcile] Auto-detected hardware: ${hw.gpus.map(g => `${g.name} (${g.vramGb}GB, ${g.backend})`).join(', ') || 'CPU only'}`);
    } catch (err) {
      console.error(`[reconcile] Hardware auto-detect failed: ${(err as Error).message}`);
    }
  }

  if (config.coordinator.provider === 'phobos') {
    const deviceIndex = config.coordinator.deviceIndex ?? (rec ? (rec.sayonDevice === 'cpu' ? undefined : rec.sayonDevice) : undefined);
    const gpuBackend  = config.coordinator.gpuBackend ?? (deviceIndex !== undefined && hw ? hw.gpus.find(g => g.index === deviceIndex)?.backend : undefined);
    const gpuLayers   = config.coordinator.gpuLayers ?? (deviceIndex !== undefined ? 99 : 0);

    tasks.push(
      startServer('sayon', {
        modelId:     config.coordinator.model,
        port:        SAYON_PORT,
        gpuLayers,
        contextSize: 4096,
        threads:     0,
        deviceIndex,
        gpuBackend:  gpuBackend as ServerConfig['gpuBackend'],
      }).catch(err => {
        console.error(`[reconcile] sayon start failed: ${err.message}`);
      })
    );
  } else if (servers.sayon.state === 'running') {
    tasks.push(stopServer('sayon'));
  }

  if (config.engine.provider === 'phobos') {
    const deviceIndex = config.engine.deviceIndex ?? (rec ? (rec.allmindDevice === 'cpu' ? undefined : rec.allmindDevice) : undefined);
    const gpuBackend  = config.engine.gpuBackend ?? (deviceIndex !== undefined && hw ? hw.gpus.find(g => g.index === deviceIndex)?.backend : undefined);
    const gpuLayers   = config.engine.gpuLayers ?? (deviceIndex !== undefined ? 99 : 0);

    tasks.push(
      startServer('allmind', {
        modelId:     config.engine.model,
        port:        ALLMIND_PORT,
        gpuLayers,
        contextSize: 4096,
        threads:     0,
        deviceIndex,
        gpuBackend:  gpuBackend as ServerConfig['gpuBackend'],
      }).catch(err => {
        console.error(`[reconcile] allmind start failed: ${err.message}`);
      })
    );
  } else if (servers.allmind.state === 'running') {
    tasks.push(stopServer('allmind'));
  }

  await Promise.all(tasks);
}