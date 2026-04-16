import * as path from 'path';
import { fileURLToPath } from 'url';
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

// Resolved path to the camofox-browser bin installed as a normal npm dependency.
// `camofox-browser` is listed in package.json — bin/camofox-browser.js is the
// entry point that starts the server.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// entry point that starts the server.
const SERVER_BIN = path.resolve(
  __dirname,
  '../node_modules/camofox-browser/bin/camofox-browser.js'
);
// State ───────────────────────────────────────────────────────────────────────

let _proc: ManagedProcess = makeManagedProcess({
  cmd:            process.execPath,   // node
  args:           [SERVER_BIN],
  port:           CAMOFOX_PORT,
  readyTimeoutMs: 30_000,
  env: {
    PORT:     String(CAMOFOX_PORT),
    NODE_ENV: 'production',
    // Idle browser shutdown after 10 min — PHOBOS keeps the server running
    // perpetually but allows the Firefox process itself to sleep between tasks.
    BROWSER_IDLE_TIMEOUT_MS: '600000',
    // Generous heap — PHOBOS runs on dev-grade hardware.
    MAX_OLD_SPACE_SIZE: '512',
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
