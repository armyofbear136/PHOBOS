import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
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

function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) { reject(new Error(`Port ${port} not ready after ${timeoutMs}ms`)); return; }
        setTimeout(attempt, 500);
      });
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

  // ── Build environment for GPU device targeting ──────────────────────────
  const env = { ...process.env };

  if (cfg.gpuLayers > 0 && cfg.deviceIndex !== undefined) {
    if (cfg.gpuBackend === 'cuda') {
      // CUDA: make only the target GPU visible as device 0
      env.CUDA_VISIBLE_DEVICES = String(cfg.deviceIndex);
    } else if (cfg.gpuBackend === 'vulkan') {
      // Vulkan: select device via --gpu-device flag
      // Device indices 100+ are our offset for non-NVIDIA GPUs.
      // When running a Vulkan-only build, the iGPU is typically device 0.
      // If NVIDIA GPUs are hidden (no CUDA env), Vulkan sees only the iGPU.
      //
      // Hide NVIDIA from this Vulkan instance so iGPU becomes device 0
      if (cfg.deviceIndex >= 100) {
        env.CUDA_VISIBLE_DEVICES = '-1';
        // AMD iGPU: set HSA compat version for ROCm/Vulkan
        env.HSA_OVERRIDE_GFX_VERSION = '11.0.0';
        args.push('--gpu-device', '0');
      } else {
        // Vulkan targeting a discrete GPU — use its native Vulkan index
        args.push('--gpu-device', String(cfg.deviceIndex));
      }
    }
    // Metal (Apple): single unified GPU, no env needed
  }

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
    await waitForPort(cfg.port, 60_000);
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
