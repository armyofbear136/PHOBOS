import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import { resolveLlamaServerBin, modelPath, getSpec } from './PhobosLocalManager.js';

// ── Ports — permanent wire contract ──────────────────────────────────────────
export const SAYON_PORT   = 52626;   // coordinator (CPU)
export const ALLMIND_PORT = 52627;   // engine (GPU or CPU)

export interface ServerConfig {
  modelId: string;
  port: number;
  gpuLayers: number;        // 0 = CPU only, 99 = full GPU offload
  contextSize: number;
  threads: number;
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

  // Stop existing process if model changed
  if (managed.process && managed.config.modelId !== cfg.modelId) {
    await stopServer(role);
  }

  if (managed.state === 'running' && managed.config.modelId === cfg.modelId) return;

  const spec = getSpec(cfg.modelId);
  if (!spec) throw new Error(`Unknown model ID: ${cfg.modelId}`);

  const ggufPath = modelPath(spec);
  const bin      = resolveLlamaServerBin();

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
    '--log-disable',            // suppress llama.cpp verbose output
  ];

  console.log(`[LlamaServerManager] Starting ${role} on :${cfg.port} — ${spec.label} (ngl=${cfg.gpuLayers})`);

  const proc = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
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

export function getServerStatus(): Record<'sayon' | 'allmind', { state: string; modelId: string; port: number; error: string | null }> {
  return {
    sayon:   { state: servers.sayon.state,   modelId: servers.sayon.config.modelId,   port: SAYON_PORT,   error: servers.sayon.error },
    allmind: { state: servers.allmind.state, modelId: servers.allmind.config.modelId, port: ALLMIND_PORT, error: servers.allmind.error },
  };
}

// Graceful shutdown — called from server.ts SIGINT/SIGTERM handler
export async function stopAllServers(): Promise<void> {
  await Promise.all([stopServer('sayon'), stopServer('allmind')]);
}

/**
 * Called by reconfigureClients() whenever model config changes.
 * If either role is on the phobos provider, start or restart the corresponding
 * llama-server with the selected model. If a role switches away from phobos, stop it.
 */
export async function reconcilePhobosServers(config: {
  coordinator: { provider: string; model: string };
  engine:      { provider: string; model: string };
}): Promise<void> {
  const tasks: Promise<void>[] = [];

  if (config.coordinator.provider === 'phobos') {
    tasks.push(
      startServer('sayon', {
        modelId:     config.coordinator.model,
        port:        SAYON_PORT,
        gpuLayers:   0,   // coordinator always CPU
        contextSize: 4096,
        threads:     0,
      }).catch(err => {
        console.error(`[reconcile] sayon start failed: ${err.message}`);
      })
    );
  } else if (servers.sayon.state === 'running') {
    tasks.push(stopServer('sayon'));
  }

  if (config.engine.provider === 'phobos') {
    tasks.push(
      startServer('allmind', {
        modelId:     config.engine.model,
        port:        ALLMIND_PORT,
        gpuLayers:   99,  // engine attempts full GPU offload
        contextSize: 4096,
        threads:     0,
      }).catch(err => {
        console.error(`[reconcile] allmind start failed: ${err.message}`);
      })
    );
  } else if (servers.allmind.state === 'running') {
    tasks.push(stopServer('allmind'));
  }

  await Promise.all(tasks);
}
