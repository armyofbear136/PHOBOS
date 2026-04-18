import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';

const execFileAsync = promisify(execFile);

export type SupportedRuntime = 'node' | 'python' | 'bash';

export interface ResolvedRuntime {
  cmd: string;
  /** Extra args prepended before the entrypoint (e.g. tsx needs none; node --no-warnings) */
  prefixArgs: string[];
}

// ── tsx availability — detected once at module load, cached ──────────────────
let _tsxPath: string | null | 'pending' = 'pending';

async function detectTsx(): Promise<string | null> {
  if (_tsxPath !== 'pending') return _tsxPath;
  try {
    const { stdout } = await execFileAsync(
      process.platform === 'win32' ? 'where' : 'which',
      ['tsx'],
      { timeout: 3_000 }
    );
    _tsxPath = stdout.trim().split('\n')[0] ?? null;
  } catch {
    _tsxPath = null;
  }
  return _tsxPath;
}

// Warm up on import — non-blocking, result cached for all later calls.
detectTsx().catch(() => { _tsxPath = null; });

// ── Resolve ───────────────────────────────────────────────────────────────────

/**
 * Maps a runtime name to the command and prefix args needed to execute a script.
 *
 * Resolution order:
 *   node    → tsx (if on PATH, handles TypeScript directly) → node
 *   python  → PHOBOS venv Python (getPythonPath) → system python3
 *   bash    → bash (linux/mac) | cmd.exe /c (windows)
 */
export async function resolveRuntime(runtime: SupportedRuntime): Promise<ResolvedRuntime> {
  switch (runtime) {
    case 'node': {
      const tsx = await detectTsx();
      if (tsx) return { cmd: tsx, prefixArgs: [] };
      // process.execPath is the absolute path to the current Node binary —
      // guaranteed to work inside the sandbox's restricted environment.
      return { cmd: process.execPath, prefixArgs: ['--no-warnings'] };
    }

    case 'python': {
      // Prefer the PHOBOS venv Python so scripts can use installed packages.
      // getPythonPath is synchronous and reads from disk — safe to call here.
      let venvPython: string | null = null;
      try {
        const { getPythonPath } = await import('../phobos/PythonEnvManager.js');
        for (const vendor of ['cuda', 'rocm', 'xpu', 'apple', 'cpu'] as const) {
          const p = getPythonPath(vendor);
          if (p && fs.existsSync(p)) { venvPython = p; break; }
        }
      } catch { /* PythonEnvManager may not be present in all build targets */ }
      if (venvPython) return { cmd: venvPython, prefixArgs: [] };
      // System fallback
      const sysPython = process.platform === 'win32' ? 'python' : 'python3';
      return { cmd: sysPython, prefixArgs: [] };
    }

    case 'bash': {
      if (process.platform === 'win32') return { cmd: 'cmd.exe', prefixArgs: ['/c'] };
      return { cmd: 'bash', prefixArgs: [] };
    }
  }
}
