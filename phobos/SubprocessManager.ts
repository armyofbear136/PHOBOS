import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';

// ── SubprocessManager ─────────────────────────────────────────────────────────
// Generic managed subprocess foundation. Handles spawn, readiness detection,
// SIGTERM → SIGKILL stop sequence, and port-wait probing.
//
// This is the building block for THE LIFT process isolation. Each managed
// service (BroadwayManager, ImageServerManager, future workers) owns one or
// more ManagedProcess instances and delegates lifecycle to this module.
// ─────────────────────────────────────────────────────────────────────────────

export interface SpawnConfig {
  /** Absolute path to binary. */
  cmd: string;
  /** CLI arguments. */
  args: string[];
  /** Environment variables merged over process.env. */
  env?: Record<string, string>;
  /**
   * If set, waitForReady() polls this TCP port until it accepts connections.
   * Use for HTTP or binary protocol servers. Mutually exclusive with readyLine.
   */
  port?: number;
  /**
   * If set, waitForReady() scans stdout/stderr for this substring.
   * Use when no TCP port is available to probe. Mutually exclusive with port.
   */
  readyLine?: string;
  /** Readiness timeout in ms. Default: 30 000. */
  readyTimeoutMs?: number;
  /** ms to delay between port probe attempts. Default: 500. */
  probeIntervalMs?: number;
  /**
   * If set (and no port/readyLine), resolve after this many ms as long as the
   * process has not already exited. Use for processes with no probe-able signal.
   */
  startupDelayMs?: number;
}

export interface ManagedProcess {
  config: SpawnConfig;
  process: ChildProcess | null;
  state: 'stopped' | 'starting' | 'running' | 'error';
  error: string | null;
  /** Resolved when the process is ready (port open or readyLine seen). */
  readyPromise: Promise<void> | null;
}

export function makeManagedProcess(config: SpawnConfig): ManagedProcess {
  return { config, process: null, state: 'stopped', error: null, readyPromise: null };
}

// ── Port probe ────────────────────────────────────────────────────────────────

export function waitForPort(
  port: number,
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Port ${port} not ready after ${timeoutMs}ms`));
          return;
        }
        setTimeout(attempt, intervalMs);
      });
    };
    attempt();
  });
}

// ── Spawn ─────────────────────────────────────────────────────────────────────

/**
 * Spawn the process described by `cfg` and attach it to `managed`.
 * Returns a Promise that resolves when the process is ready (port open or
 * readyLine seen). Rejects on timeout or immediate exit with non-zero code.
 *
 * Caller is responsible for setting managed.state before calling — typically
 * to 'starting'. This function updates state to 'running' or 'error'.
 */
export function spawnProcess(
  managed: ManagedProcess,
  cfg: SpawnConfig,
  label: string,
): Promise<void> {
  const env = { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>;

  const child = spawn(cfg.cmd, cfg.args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // detached:false (default) keeps the child in the same Windows Job Object
    // as the parent process. When the parent dies, the Job Object is destroyed
    // and all children are automatically killed — prevents orphaned processes
    // on hard crash (power loss, Task Manager kill, console X button).
    detached: false,
  });

  managed.process = child;
  managed.config  = cfg;

  // Collect output for readyLine scanning and error reporting
  let stdoutBuf = '';
  let stderrBuf = '';

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stderrBuf += text;
    // Forward stderr live — critical for bash set -x debugging and GDK warnings
    process.stderr.write(`[${label}] ${text}`);
  });

  child.on('error', (err) => {
    console.error(`[${label}] spawn error: ${err.message}`);
    managed.state = 'error';
    managed.error = err.message;
  });

  child.on('exit', (code, signal) => {
    // SIGTERM / SIGKILL are intentional stops — not errors
    const intentional = signal === 'SIGTERM' || signal === 'SIGKILL' || code === 0;
    if (!intentional) {
      const tail = (stdoutBuf + stderrBuf).slice(-800);
      console.error(`[${label}] exited unexpectedly (code=${code} signal=${signal})\n${tail}`);
      managed.state = 'error';
      managed.error = `Exited with code ${code}`;
    } else {
      managed.state = 'stopped';
    }
    managed.process = null;
  });

  // ── Readiness detection ───────────────────────────────────────────────────
  const timeoutMs  = cfg.readyTimeoutMs  ?? 30_000;
  const intervalMs = cfg.probeIntervalMs ?? 500;

  if (cfg.port !== undefined) {
    // Port probe — most reliable for network services
    const p = waitForPort(cfg.port, timeoutMs, intervalMs).then(() => {
      managed.state = 'running';
      managed.error = null;
      console.log(`[${label}] ready on :${cfg.port}`);
    }).catch((err: Error) => {
      managed.state = 'error';
      managed.error = err.message;
      throw err;
    });
    managed.readyPromise = p;
    return p;
  }

  if (cfg.readyLine !== undefined) {
    // stdout/stderr line scan
    const needle = cfg.readyLine;
    const p = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(new Error(`[${label}] readyLine "${needle}" not seen after ${timeoutMs}ms`));
      }, timeoutMs);

      const check = (chunk: Buffer) => {
        if (chunk.toString().includes(needle)) {
          clearTimeout(deadline);
          managed.state = 'running';
          managed.error = null;
          console.log(`[${label}] ready (readyLine matched)`);
          resolve();
        }
      };

      child.stdout?.on('data', check);
      child.stderr?.on('data', check);

      child.once('exit', (code) => {
        clearTimeout(deadline);
        if (managed.state !== 'running') {
          reject(new Error(`[${label}] exited (code=${code}) before readyLine seen`));
        }
      });
    });
    managed.readyPromise = p;
    return p;
  }

  if (cfg.startupDelayMs !== undefined) {
    // Fixed startup delay — resolve after N ms if process is still alive.
    // Use for processes with no port or log signal (e.g. GIMP on Broadway).
    const delay = cfg.startupDelayMs;
    const p = new Promise<void>((resolve, reject) => {
      let settled = false;

      // If process exits before delay completes, reject immediately
      child.once('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        const intentional = signal === 'SIGTERM' || signal === 'SIGKILL' || code === 0;
        if (!intentional) {
          reject(new Error(`[${label}] exited (code=${code}) before startup delay`));
        }
      });

      setTimeout(() => {
        if (settled) return;
        settled = true;
        if (managed.process) {
          managed.state = 'running';
          managed.error = null;
          console.log(`[${label}] ready (startup delay ${delay}ms)`);
          resolve();
        } else {
          reject(new Error(`[${label}] process died during startup delay`));
        }
      }, delay);
    });
    managed.readyPromise = p;
    return p;
  }

  // No readiness signal — resolve immediately after spawn
  managed.state = 'running';
  managed.readyPromise = Promise.resolve();
  return managed.readyPromise;
}

// ── Stop ──────────────────────────────────────────────────────────────────────

/**
 * Kill an entire Windows process tree rooted at `pid` using taskkill.
 * Required when the managed process is a bash.exe shell that spawned children
 * (broadwayd, gimp) — SIGTERM only kills bash, leaving children as orphans.
 */
function killWindowsTree(pid: number, label: string): Promise<void> {
  return new Promise((resolve) => {
    const { spawn: spawnRaw } = require('child_process') as typeof import('child_process');
    const tk = spawnRaw('taskkill', ['/F', '/T', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
    tk.on('close', (code) => {
      if (code !== 0) {
        console.warn(`[${label}] taskkill exited ${code} — process may already be gone`);
      }
      resolve();
    });
    tk.on('error', () => resolve()); // taskkill not found — non-fatal
  });
}

/**
 * Stop a managed process. On Windows, uses taskkill /F /T to kill the entire
 * process tree (bash shell + all children). On Unix, sends SIGTERM then SIGKILL.
 */
export function stopProcess(
  managed: ManagedProcess,
  label: string,
  gracePeriodMs = 5_000,
): Promise<void> {
  const child = managed.process;
  if (!child) {
    managed.state = 'stopped';
    return Promise.resolve();
  }

  const cleanup = () => {
    managed.process = null;
    managed.state   = 'stopped';
    managed.error   = null;
  };

  if (process.platform === 'win32' && child.pid !== undefined) {
    // On Windows, SIGTERM to bash.exe does not propagate to its children.
    // taskkill /F /T kills the entire process tree rooted at the bash PID.
    return killWindowsTree(child.pid, label).then(() => {
      cleanup();
      console.log(`[${label}] process tree killed`);
    });
  }

  // Unix: SIGTERM → wait → SIGKILL
  return new Promise((resolve) => {
    const killer = setTimeout(() => {
      console.warn(`[${label}] SIGTERM timeout — sending SIGKILL`);
      child.kill('SIGKILL');
    }, gracePeriodMs);

    child.once('exit', () => {
      clearTimeout(killer);
      cleanup();
      resolve();
    });

    child.kill('SIGTERM');
  });
}
