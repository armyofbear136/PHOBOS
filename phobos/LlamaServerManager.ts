import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { resolveLlamaServerBin, modelPath, getSpec, detectHardware, buildRecommendation } from './PhobosLocalManager.js';

// ── Ports — permanent wire contract ──────────────────────────────────────────
export const SAYON_PORT   = 52626;   // coordinator
export const SEREN_PORT = 52627;   // engine

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
  /**
   * Physical Vulkan enumeration index from GpuRunnerProfile.vulkanIndex.
   * NVIDIA = nvidia-smi index. Non-NVIDIA = nvidiaCount + wmiPosition.
   * Used for GGML_VK_VISIBLE_DEVICES. After filtering, device is always Vulkan0.
   */
  vulkanIndex?: number;
  /** Runner kind from GpuRunnerProfile — used for diagnostic logging */
  runnerKind?: string;
}

interface ManagedServer {
  config: ServerConfig;
  process: ChildProcess | null;
  state: 'stopped' | 'starting' | 'running' | 'error';
  error: string | null;
}

// ── Singleton manager ─────────────────────────────────────────────────────────

const servers: Record<'sayon' | 'seren', ManagedServer> = {
  sayon:   { config: { modelId: '', port: SAYON_PORT,   gpuLayers: 0,  contextSize: 4096, threads: 4 }, process: null, state: 'stopped', error: null },
  seren: { config: { modelId: '', port: SEREN_PORT, gpuLayers: 99, contextSize: 4096, threads: 4 }, process: null, state: 'stopped', error: null },
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

export async function startServer(role: 'sayon' | 'seren', cfg: ServerConfig): Promise<void> {
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

  // Ensure the binary is executable — tar extraction on some systems (Termux, WinRAR)
  // strips execute permissions. chmod is a no-op if already set.
  if (process.platform !== 'win32') {
    try { fs.chmodSync(bin, 0o755); } catch { /* ignore — may lack permissions on some fs */ }
  }

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

  // Jinja chat template + reasoning-format routing for all Qwen3-architecture models.
  // Covers: Qwen3 family, Magistral, DeepSeek-R1 Qwen3 distills (8B, 14B).
  // Not applied to Llama-architecture models (Llama 3, Gemma 3, DeepSeek-R1 70B)
  // which use tag-based thinking or no thinking at all.
  if (role === 'seren' && spec.jinjaTemplate) {
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
    if (cfg.gpuBackend === 'metal') {
      // Metal on macOS — llama-server auto-selects the only GPU via Metal.
      // Do NOT pass --device VulkanN — the macos-arm64 binary has no Vulkan backend.

    } else if (cfg.gpuBackend === 'cuda' && cfg.deviceIndex < 100) {
      // NVIDIA GPU targeting.
      //
      // Path A — ggml-cuda.dll present (native CUDA build):
      //   Use CUDA_VISIBLE_DEVICES. Works on all CUDA-capable NVIDIA GPUs.
      //   Suppress Vulkan to prevent the iGPU from stealing the Vulkan slot.
      //
      // Path B — Vulkan-only build (no ggml-cuda.dll):
      //   Standard: RTX 3080/5080 etc. — appear as Vulkan devices, use GGML_VK_VISIBLE_DEVICES.
      //   Legacy: Maxwell/Kepler (Quadro M*, GTX 9xx) — may not have Vulkan ICD registered.
      //     CUDA 12 Windows prebuilt requires sm_60+ on Windows, so no CUDA option either.
      //     We still attempt Vulkan targeting; if the Vulkan ICD is registered it will work.
      //     If not, llama-server will exit code 1 and the server falls back to CPU.
      const binDir      = path.dirname(bin);
      const cudaDll     = path.join(binDir, 'ggml-cuda.dll');
      const cudartDll   = path.join(binDir, 'cudart64_12.dll');
      // CUDA backend requires both ggml-cuda.dll AND the CUDA runtime (cudart64_12.dll).
      // ggml-cuda.dll depends on cudart64_12.dll, cublas64_12.dll, cublasLt64_12.dll.
      // Without the runtime DLLs, ggml-cuda.dll silently fails to load and llama-server
      // falls back to CPU with no error. We detect this by checking for cudart64_12.dll
      // (the primary runtime dep) alongside ggml-cuda.dll.
      // Runtime DLLs are fetched by fetch-win32-x64.js from the cudart-llama release zip.
      const hasCudaDll    = process.platform === 'win32' && fs.existsSync(cudaDll);
      const hasCudaRuntime = process.platform === 'win32' && fs.existsSync(cudartDll);
      const hasCuda       = hasCudaDll && hasCudaRuntime;

      if (hasCuda) {
        // Native CUDA path — ggml-cuda.dll + cudart runtime both present
        env.CUDA_VISIBLE_DEVICES    = String(cfg.deviceIndex);
        env.GGML_VK_VISIBLE_DEVICES = ''; // suppress Vulkan iGPU interference
        console.log(`[LlamaServerManager] ${role}: NVIDIA CUDA path (ggml-cuda.dll + cudart runtime found)`);
      } else {
        // Vulkan path for NVIDIA — either no CUDA DLLs, or missing cudart runtime.
        if (hasCudaDll && !hasCudaRuntime) {
          console.warn(`[LlamaServerManager] ${role}: ggml-cuda.dll found but cudart64_12.dll missing — CUDA runtime not installed. Falling back to Vulkan. Run fetch-win32-x64.js to fetch runtime DLLs.`);
        }
        const vkIdx = cfg.vulkanIndex ?? cfg.deviceIndex;
        env.GGML_VK_VISIBLE_DEVICES = String(vkIdx);
        args.push('--device', 'Vulkan0');
        if ((cfg as any).runnerKind === 'nvidia-legacy') {
          console.log(`[LlamaServerManager] ${role}: NVIDIA legacy GPU — attempting Vulkan${vkIdx}. If ICD not registered, will fall to CPU.`);
        }
      }

    } else {
      // Non-NVIDIA Vulkan GPU (AMD discrete, AMD iGPU, Intel iGPU).
      // GGML_VK_VISIBLE_DEVICES filters to one device; it becomes Vulkan0.
      const vkIdx = cfg.vulkanIndex ??
        (cfg.deviceIndex >= 100 ? (cfg.deviceIndex - 100) : cfg.deviceIndex);

      env.CUDA_VISIBLE_DEVICES    = '-1'; // hide CUDA — no NVIDIA context overhead
      env.HIP_VISIBLE_DEVICES     = '-1'; // hide ROCm
      env.GGML_VK_VISIBLE_DEVICES = String(vkIdx);
      args.push('--device', 'Vulkan0');
    }
  } else if (cfg.gpuLayers > 0) {
    // No specific device — let llama-server auto-select
  } else {
    // ngl=0 — CPU-only execution. Suppress all GPU backends so no VRAM is reserved.
    //
    // Without this, llama-server loads ggml-cuda.dll and ggml-vulkan.dll at startup
    // regardless of ngl=0. Each backend initialises its runtime and allocates device
    // memory for context structures / shader caches. On a 10 GB card this permanently
    // reduces the VRAM ceiling available for image generation.
    //
    // CUDA:   CUDA_VISIBLE_DEVICES=-1 hides all CUDA devices from the runtime.
    // Vulkan: GGML_VK_VISIBLE_DEVICES='' hides all devices from ggml Vulkan backend.
    //         VK_ICD_FILENAMES='' prevents the Vulkan loader finding any ICD at all —
    //         deepest available suppression, covers all Vulkan code paths.
    // ROCm:   HIP/ROCR equivalents for AMD GPU machines.
    env.CUDA_VISIBLE_DEVICES    = '-1';
    env.HIP_VISIBLE_DEVICES     = '-1';
    env.ROCR_VISIBLE_DEVICES    = '-1';
    env.GGML_VK_VISIBLE_DEVICES = '';
    env.VK_ICD_FILENAMES        = '';
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

    // GPU device not found (exit code 1 during startup, before port was ready) —
    // auto-retry as CPU. Handles GPUs that have neither CUDA dll nor Vulkan ICD
    // (e.g. Quadro M2000 on a system without ggml-cuda.dll).
    if (code === 1 && cfg.gpuLayers > 0 && managed.state === 'error') {
      console.warn(`[LlamaServerManager] ${role} failed to start on GPU — retrying as CPU`);
      managed.state = 'stopped';
      startServer(role, {
        ...cfg,
        gpuLayers:   0,
        deviceIndex: undefined,
        gpuBackend:  undefined,
      }).catch(err => {
        console.error(`[LlamaServerManager] ${role} CPU fallback also failed: ${err.message}`);
      });
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

export async function stopServer(role: 'sayon' | 'seren'): Promise<void> {
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

export function getServerStatus(): Record<'sayon' | 'seren', {
  state: string;
  modelId: string;
  port: number;
  error: string | null;
  deviceIndex?: number;
  gpuBackend?: string;
  gpuLayers: number;
}> {
  return {
    sayon: {
      state:       servers.sayon.state,
      modelId:     servers.sayon.config.modelId,
      port:        SAYON_PORT,
      error:       servers.sayon.error,
      deviceIndex: servers.sayon.config.deviceIndex,
      gpuBackend:  servers.sayon.config.gpuBackend,
      gpuLayers:   servers.sayon.config.gpuLayers,
    },
    seren: {
      state:       servers.seren.state,
      modelId:     servers.seren.config.modelId,
      port:        SEREN_PORT,
      error:       servers.seren.error,
      deviceIndex: servers.seren.config.deviceIndex,
      gpuBackend:  servers.seren.config.gpuBackend,
      gpuLayers:   servers.seren.config.gpuLayers,
    },
  };
}

export async function stopAllServers(): Promise<void> {
  await Promise.all([stopServer('sayon'), stopServer('seren')]);
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
    // deviceIndex === -1: user explicitly chose CPU — skip auto-detect entirely.
    // deviceIndex === undefined: not yet configured — fall through to recommendation.
    const explicitCpuSayon = config.coordinator.deviceIndex === -1;
    const deviceIndex = explicitCpuSayon ? undefined
      : config.coordinator.deviceIndex ?? (rec ? (rec.sayonDevice === 'cpu' ? undefined : rec.sayonDevice) : undefined);
    const gpuBackend  = explicitCpuSayon ? undefined
      : config.coordinator.gpuBackend ?? (deviceIndex !== undefined && hw ? hw.gpus.find(g => g.index === deviceIndex)?.backend : undefined);
    const gpuLayers   = explicitCpuSayon ? 0
      : config.coordinator.gpuLayers ?? (deviceIndex !== undefined ? 99 : 0);

    tasks.push(
      startServer('sayon', {
        modelId:     config.coordinator.model,
        port:        SAYON_PORT,
        gpuLayers,
        contextSize: 4096,
        threads:     0,
        deviceIndex,
        gpuBackend:  gpuBackend as ServerConfig['gpuBackend'],
        vulkanIndex: deviceIndex !== undefined && hw ? hw.gpus.find(g => g.index === deviceIndex)?.runner?.vulkanIndex : undefined,
        runnerKind:  deviceIndex !== undefined && hw ? hw.gpus.find(g => g.index === deviceIndex)?.runner?.kind : undefined,
      }).catch(err => {
        console.error(`[reconcile] sayon start failed: ${err.message}`);
      })
    );
  } else if (servers.sayon.state === 'running') {
    tasks.push(stopServer('sayon'));
  }

  if (config.engine.provider === 'phobos') {
    // deviceIndex === -1: user explicitly chose CPU — skip auto-detect entirely.
    const explicitCpuSeren = config.engine.deviceIndex === -1;
    const deviceIndex = explicitCpuSeren ? undefined
      : config.engine.deviceIndex ?? (rec ? (rec.serenDevice === 'cpu' ? undefined : rec.serenDevice) : undefined);
    const gpuBackend  = explicitCpuSeren ? undefined
      : config.engine.gpuBackend ?? (deviceIndex !== undefined && hw ? hw.gpus.find(g => g.index === deviceIndex)?.backend : undefined);
    const gpuLayers   = explicitCpuSeren ? 0
      : config.engine.gpuLayers ?? (deviceIndex !== undefined ? 99 : 0);

    tasks.push(
      startServer('seren', {
        modelId:     config.engine.model,
        port:        SEREN_PORT,
        gpuLayers,
        contextSize: 4096,
        threads:     0,
        deviceIndex,
        gpuBackend:  gpuBackend as ServerConfig['gpuBackend'],
        vulkanIndex: deviceIndex !== undefined && hw ? hw.gpus.find(g => g.index === deviceIndex)?.runner?.vulkanIndex : undefined,
        runnerKind:  deviceIndex !== undefined && hw ? hw.gpus.find(g => g.index === deviceIndex)?.runner?.kind : undefined,
      }).catch(err => {
        console.error(`[reconcile] seren start failed: ${err.message}`);
      })
    );
  } else if (servers.seren.state === 'running') {
    tasks.push(stopServer('seren'));
  }

  await Promise.all(tasks);
}
