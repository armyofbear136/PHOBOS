import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type { SupportedRuntime } from './RuntimeResolver.js';
import { resolveRuntime } from './RuntimeResolver.js';

export interface ExecuteSpec {
  runtime: SupportedRuntime;
  entrypoint: string;       // filename only — no path separators, validated before call
  sandboxDir: string;       // absolute path to pre-created temp directory
  timeoutMs: number;
}

export interface ExecuteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

// Combined stdout+stderr cap — prevents a runaway script from blowing up context.
const OUTPUT_CAP_BYTES = 50 * 1024; // 50 KB
const TRUNCATION_MARKER = '\n... [output truncated at 50 KB]';

/**
 * Execute a script inside sandboxDir with a restricted environment.
 * Only PATH and HOME are passed — no API keys, no PHOBOS_* vars, no DB paths.
 */
export async function runInSandbox(spec: ExecuteSpec): Promise<ExecuteResult> {
  const { cmd, prefixArgs } = await resolveRuntime(spec.runtime);
  const args = [...prefixArgs, spec.entrypoint];

  const restrictedEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    // Windows needs SYSTEMROOT for basic commands (cmd, node, python)
    ...(process.platform === 'win32' && process.env.SYSTEMROOT
      ? { SYSTEMROOT: process.env.SYSTEMROOT }
      : {}),
  };

  const started = Date.now();
  let child: ChildProcess;

  try {
    child = spawn(cmd, args, {
      cwd: spec.sandboxDir,
      env: restrictedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (spawnErr) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Failed to spawn ${cmd}: ${(spawnErr as Error).message}`,
      timedOut: false,
      durationMs: Date.now() - started,
    };
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let totalBytes = 0;
  let capped = false;

  child.stdout!.on('data', (chunk: Buffer) => {
    if (capped) return;
    totalBytes += chunk.length;
    if (totalBytes > OUTPUT_CAP_BYTES) {
      const remaining = OUTPUT_CAP_BYTES - (totalBytes - chunk.length);
      if (remaining > 0) stdoutChunks.push(chunk.subarray(0, remaining));
      capped = true;
    } else {
      stdoutChunks.push(chunk);
    }
  });

  child.stderr!.on('data', (chunk: Buffer) => {
    if (capped) return;
    totalBytes += chunk.length;
    if (totalBytes > OUTPUT_CAP_BYTES) {
      const remaining = OUTPUT_CAP_BYTES - (totalBytes - chunk.length);
      if (remaining > 0) stderrChunks.push(chunk.subarray(0, remaining));
      capped = true;
    } else {
      stderrChunks.push(chunk);
    }
  });

  return new Promise<ExecuteResult>((resolve) => {
    let timedOut = false;

    const watchdog = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, spec.timeoutMs);

    child.on('close', (code) => {
      clearTimeout(watchdog);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8') + (capped ? TRUNCATION_MARKER : '');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    });

    child.on('error', (err) => {
      clearTimeout(watchdog);
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: err.message,
        timedOut: false,
        durationMs: Date.now() - started,
      });
    });
  });
}

// ── Process tree kill ─────────────────────────────────────────────────────────
// On Windows, SIGKILL does not kill child processes spawned by the script.
// taskkill /F /T kills the entire process tree rooted at the given PID.

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}
