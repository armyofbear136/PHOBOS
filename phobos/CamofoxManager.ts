import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import {
  makeManagedProcess,
  spawnProcess,
  stopProcess,
  waitForPort,
  type ManagedProcess,
} from './SubprocessManager.js';

// ── Port — permanent wire contract ───────────────────────────────────────────
// 9377 is camofox-browser's fixed default. Not remappable without forking the
// package. Same exception class as Broadway 8080/9090 — outside PHOBOS managed
// range (16313–16399) but treated as a known permanent fixture.
export const CAMOFOX_PORT = 9377;

// ── Node binary resolution ────────────────────────────────────────────────────
// In production, process.execPath is phobos.exe (Node SEA) — a sealed binary
// that cannot execute arbitrary .js scripts. We stage a portable node binary
// alongside the exe (scripts/fetch-node.js → build.js → dist/).
// In dev, process.execPath is already a real Node binary.
function resolveNodeBin(): string {
  const nodeName = process.platform === 'win32'
    ? `node-${process.platform}-${process.arch}.exe`
    : `node-${process.platform}-${process.arch}`;

  const stagedNode = path.join(path.dirname(process.execPath), nodeName);
  if (fs.existsSync(stagedNode)) return stagedNode;

  return process.execPath; // dev fallback
}

// ── camofox-browser entry point ───────────────────────────────────────────────
// esbuild outputs CJS — __dirname is always defined. Keep the cwd fallback for
// tsx ESM dev runs where __dirname may be undefined.
function resolveServerBin(): string {
  if (typeof __dirname !== 'undefined') {
    // In the CJS/SEA build __dirname is the dist/ folder.
    // build.js stages camofox-browser into dist/node_modules/ (same dir).
    return path.resolve(__dirname, './node_modules/camofox-browser/bin/camofox-browser.js');
  }
  return path.resolve(process.cwd(), 'node_modules/camofox-browser/bin/camofox-browser.js');
}

const SERVER_BIN = resolveServerBin();

// ── State ─────────────────────────────────────────────────────────────────────
// cmd is set to a placeholder here; resolveNodeBin() is called at start time
// so a first-run fetch that places the binary after module load is handled.

let _proc: ManagedProcess = makeManagedProcess({
  cmd:            process.execPath, // overwritten in startCamofox()
  args:           [SERVER_BIN],
  port:           CAMOFOX_PORT,
  readyTimeoutMs: 90_000,  // Firefox profile init can take 60s+ on first/cold start
  env: {
    PORT:     String(CAMOFOX_PORT),
    NODE_ENV: 'production',
    BROWSER_IDLE_TIMEOUT_MS: '600000',
    MAX_OLD_SPACE_SIZE: '512',
    // deps are self-contained in node_modules/camofox-browser/node_modules/
    // via npm install run by build.js at staging time — no NODE_PATH needed.
  },
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export function isCamofoxInstalled(): boolean {
  return fs.existsSync(SERVER_BIN);
}

export async function startCamofox(): Promise<void> {
  if (_proc.state === 'running' || _proc.state === 'starting') return;

  if (!isCamofoxInstalled()) {
    _proc.state = 'error';
    _proc.error = 'camofox-browser not found in node_modules. Run: npm install';
    console.error('[CamofoxManager]', _proc.error);
    return;
  }

  // Resolve at call time — handles first-run fetch placing the binary after module load.
  _proc.config.cmd = resolveNodeBin();

  // On Windows, kill any orphaned camofox node processes from a prior crash.
  // SIGKILL does not traverse the Windows process tree — use taskkill.
  if (process.platform === 'win32') {
    try {
      execSync(
        `taskkill /F /FI "WINDOWTITLE eq camofox*" /FI "IMAGENAME eq node.exe"`,
        { stdio: 'ignore' }
      );
    } catch { /* no orphan — expected */ }
  }

  console.log('[CamofoxManager] Starting...');
  _proc.state = 'starting';
  await spawnProcess(_proc, _proc.config, '[Camofox]');

  if ((_proc.state as string) === 'running') {
    console.log(`[CamofoxManager] Running on :${CAMOFOX_PORT}`);
  } else {
    console.error('[CamofoxManager] Failed to start:', _proc.error);
  }
}

export async function stopCamofox(): Promise<void> {
  if (_proc.state === 'stopped') return;

  // POST /stop in the redf0x1 fork requires CAMOFOX_API_KEY auth even when no
  // key is configured — skip the HTTP route and go straight to process kill.

  // On Windows, SubprocessManager.killWindowsTree uses require() which is not
  // available in ESM modules. Kill the process tree directly with execSync here.
  if (process.platform === 'win32' && _proc.process?.pid !== undefined) {
    try {
      execSync(`taskkill /F /T /PID ${_proc.process.pid}`, { stdio: 'ignore' });
    } catch { /* process already gone */ }
    _proc.process = null;
    _proc.state   = 'stopped';
    _proc.error   = null;
    return;
  }

  await stopProcess(_proc, '[CamofoxManager]');
}

export interface CamofoxStatus {
  state: 'stopped' | 'starting' | 'running' | 'error';
  port:  number;
  error: string | null;
  pid:   number | null;
}

export function getCamofoxStatus(): CamofoxStatus {
  return {
    state: _proc.state,
    port:  CAMOFOX_PORT,
    error: _proc.error,
    pid:   _proc.process?.pid ?? null,
  };
}

// Re-export for test scripts that need to probe the port directly.
export { waitForPort };
