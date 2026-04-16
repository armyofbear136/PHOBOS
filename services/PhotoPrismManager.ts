/**
 * PhotoPrismManager.ts — Lifecycle manager for the PhotoPrism photo library service.
 *
 * Platform strategy:
 *   Linux / macOS — native binary spawn from ~/.phobos/services/photoprism/
 *   Windows       — binary lives inside WSL2; spawned via `wsl.exe -u root -d Ubuntu`
 *
 * The interface is identical on all platforms: same port (16320), same PhotoPrism
 * REST API, same session token logic. WSL2 port forwarding makes localhost:16320
 * reachable from Windows automatically — no extra proxy needed.
 *
 * Port:    16320 (permanent wire contract)
 * Binary:  ~/.phobos/services/photoprism/photoprism          (Linux/macOS)
 *          /root/.phobos/services/photoprism/photoprism      (inside WSL2 on Windows)
 * Marker:  ~/.phobos/services/photoprism/wsl2-ready.json     (Windows readiness check)
 * Storage: ~/.phobos/services/photoprism/storage/            (Linux/macOS)
 *          /root/.phobos/services/photoprism/storage/        (inside WSL2 on Windows)
 */

import { spawn, execFile, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as fs   from 'fs';
import * as net  from 'net';
import * as path from 'path';
import * as os   from 'os';

const exec = promisify(execFile);

// ── Wire constants ─────────────────────────────────────────────────────────────
export const PHOTOPRISM_PORT        = 16320;
export const PHOTOPRISM_RELEASE_TAG = '260305-fad9d5395';

// WSL2 configuration (Windows only)
const WSL_DISTRO      = 'Ubuntu';
const WSL_PHOBOS_DIR  = '/root/.phobos/services/photoprism';
const WSL_BINARY_PATH = `${WSL_PHOBOS_DIR}/photoprism`;
const WSL_STORAGE_DIR = `${WSL_PHOBOS_DIR}/storage`;

// Minimum binary size for corruption check (Linux/macOS only)
const BINARY_MIN_BYTES: Record<string, number> = {
  'linux-x64':    40_000_000,
  'linux-arm64':  40_000_000,
  'darwin-arm64': 40_000_000,
  'darwin-x64':   40_000_000,
};

// ── Config ────────────────────────────────────────────────────────────────────

export interface PhotoPrismConfig {
  originalsPath:         string;
  adminPassword:         string;
  disableFaces:          boolean;
  disableClassification: boolean;
  workers:               number;
}

// ── Service state ─────────────────────────────────────────────────────────────

interface ManagedService {
  config:  PhotoPrismConfig | null;
  process: ChildProcess | null;
  state:   'stopped' | 'starting' | 'running' | 'error';
  error:   string | null;
}

const service: ManagedService = {
  config:  null,
  process: null,
  state:   'stopped',
  error:   null,
};

// ── Path helpers ──────────────────────────────────────────────────────────────

export function resolveServiceDir(): string {
  return path.join(os.homedir(), '.phobos', 'services', 'photoprism');
}

export function resolveBinaryPath(): string {
  // Native binary path (Linux/macOS). On Windows this returns the Windows-side
  // path which is only used for the marker file check — the actual binary is in WSL2.
  const ext = process.platform === 'win32' ? '' : '';
  return path.join(resolveServiceDir(), 'photoprism');
}

export function resolveStorageDir(): string {
  return process.platform === 'win32'
    ? WSL_STORAGE_DIR                                            // path inside WSL2
    : path.join(resolveServiceDir(), 'storage');                 // native path
}

export function resolveAssetsDir(): string {
  return process.platform === 'win32'
    ? `${WSL_PHOBOS_DIR}/assets`
    : path.join(resolveServiceDir(), 'assets');
}

// ── Readiness check ───────────────────────────────────────────────────────────
// On Windows: checks for wsl2-ready.json written by fetch-photoprism.js.
// On Linux/macOS: checks binary + assets/ size.

export function isBinaryPresent(): boolean {
  if (process.platform === 'win32') {
    return fs.existsSync(path.join(resolveServiceDir(), 'wsl2-ready.json'));
  }
  const bin = path.join(resolveServiceDir(), 'photoprism');
  if (!fs.existsSync(bin)) return false;
  const platformKey = `${process.platform}-${process.arch}`;
  const minBytes    = BINARY_MIN_BYTES[platformKey] ?? 20_000_000;
  if (fs.statSync(bin).size < minBytes) return false;
  return fs.existsSync(path.join(resolveServiceDir(), 'assets'));
}

// ── Port readiness probe ──────────────────────────────────────────────────────

function waitForPort(port: number, timeoutMs = 180_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt  = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error',   () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`PhotoPrism port ${port} not ready after ${timeoutMs / 1000}s`));
          return;
        }
        setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

// ── Env vars (same on all platforms — PhotoPrism config is identical) ─────────

function buildEnvRecord(cfg: PhotoPrismConfig, originalsInContainer: string, storageInContainer: string): Record<string, string> {
  const cpuCount = Math.max(1, Math.floor(os.cpus().length / 2));
  const workers  = cfg.workers > 0 ? cfg.workers : cpuCount;
  return {
    PHOTOPRISM_ORIGINALS_PATH:         originalsInContainer,
    PHOTOPRISM_STORAGE_PATH:           storageInContainer,
    PHOTOPRISM_HTTP_HOST:              '127.0.0.1',
    PHOTOPRISM_HTTP_PORT:              String(PHOTOPRISM_PORT),
    PHOTOPRISM_ADMIN_USER:             'phobos',
    PHOTOPRISM_ADMIN_PASSWORD:         cfg.adminPassword,
    PHOTOPRISM_AUTH_MODE:              'password',
    PHOTOPRISM_DISABLE_FRONTEND:       'true',
    PHOTOPRISM_WORKERS:                String(workers),
    PHOTOPRISM_DISABLE_FACES:          cfg.disableFaces          ? 'true' : 'false',
    PHOTOPRISM_DISABLE_CLASSIFICATION: cfg.disableClassification ? 'true' : 'false',
    PHOTOPRISM_SPONSOR:                'false',
  };
}

// ── Config-change detection ───────────────────────────────────────────────────

function configChanged(cfg: PhotoPrismConfig): boolean {
  if (!service.config) return true;
  return (
    service.config.originalsPath          !== cfg.originalsPath          ||
    service.config.adminPassword          !== cfg.adminPassword          ||
    service.config.disableFaces           !== cfg.disableFaces           ||
    service.config.disableClassification  !== cfg.disableClassification  ||
    service.config.workers                !== cfg.workers
  );
}

// ── Convert a Windows path to its WSL2 mount path (/mnt/c/...) ───────────────

async function toWslPath(winPath: string): Promise<string> {
  const { stdout } = await exec('wsl.exe', ['-u', 'root', '-d', WSL_DISTRO, '--', 'wslpath', winPath.replace(/\\/g, '/')]);
  return stdout.trim();
}

// ── Start: Windows (WSL2) ─────────────────────────────────────────────────────

async function startWSL2(cfg: PhotoPrismConfig): Promise<void> {
  // PhotoPrism's originals path is a Windows path (e.g. C:\Users\...\Pictures).
  // Convert it to a WSL2 mount path so the binary can access it.
  const wslOriginals = await toWslPath(cfg.originalsPath);

  // Build env as a single bash export string for the WSL2 invocation.
  const envRecord = buildEnvRecord(cfg, wslOriginals, WSL_STORAGE_DIR);
  const envExports = Object.entries(envRecord)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join('; ');

  // Ensure storage dir exists inside WSL2.
  await exec('wsl.exe', ['-u', 'root', '-d', WSL_DISTRO, '--', 'bash', '-c',
    `mkdir -p "${WSL_STORAGE_DIR}"`]);

  // Build the full command: set env vars, then run photoprism start.
  const wslCmd = `${envExports}; "${WSL_BINARY_PATH}" start --http-port ${PHOTOPRISM_PORT}`;

  console.log(`[PhotoPrismManager] Starting via WSL2 (${WSL_DISTRO})`);

  const proc = spawn('wsl.exe', ['-u', 'root', '-d', WSL_DISTRO, '--', 'bash', '-c', wslCmd], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout?.on('data', (d: Buffer) => { const l = d.toString().trim(); if (l) console.log(`[photoprism] ${l}`); });
  proc.stderr?.on('data', (d: Buffer) => { const l = d.toString().trim(); if (l) console.log(`[photoprism] ${l}`); });
  proc.on('exit', (code, signal) => {
    console.log(`[PhotoPrismManager] WSL2 process exited code=${code} signal=${signal}`);
    service.process = null;
    service.state   = code === 0 || signal === 'SIGTERM' ? 'stopped' : 'error';
    if (code !== 0 && code !== null && signal == null) service.error = `Exited with code ${code}`;
  });

  service.process = proc;
}

// ── Start: Linux/macOS (native binary) ───────────────────────────────────────

function startNative(cfg: PhotoPrismConfig): void {
  const serviceDir = resolveServiceDir();
  const bin        = path.join(serviceDir, 'photoprism');
  const storageDir = path.join(serviceDir, 'storage');

  try { fs.chmodSync(bin, 0o755); } catch { /* ignore */ }
  fs.mkdirSync(storageDir,        { recursive: true });
  fs.mkdirSync(cfg.originalsPath, { recursive: true });

  const envRecord  = buildEnvRecord(cfg, cfg.originalsPath, storageDir);
  const env: NodeJS.ProcessEnv = { ...process.env, ...envRecord };

  const proc = spawn(bin, ['start', '--http-port', String(PHOTOPRISM_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    cwd:  serviceDir,
  });

  proc.stdout?.on('data', (d: Buffer) => { const l = d.toString().trim(); if (l) console.log(`[photoprism] ${l}`); });
  proc.stderr?.on('data', (d: Buffer) => { const l = d.toString().trim(); if (l) console.log(`[photoprism] ${l}`); });
  proc.on('exit', (code, signal) => {
    console.log(`[PhotoPrismManager] exited code=${code} signal=${signal}`);
    service.process = null;
    service.state   = code === 0 || signal === 'SIGTERM' ? 'stopped' : 'error';
    if (code !== 0 && code !== null && signal == null) service.error = `Exited with code ${code}`;
  });

  service.process = proc;
}

// ── Start (public) ────────────────────────────────────────────────────────────

export async function startPhotoprism(cfg: PhotoPrismConfig): Promise<void> {
  if ((service.state === 'running' || service.state === 'starting') && !configChanged(cfg)) return;
  if (service.state === 'running' || service.state === 'starting') await stopPhotoprism();

  if (!isBinaryPresent()) {
    service.state = 'error';
    service.error = process.platform === 'win32'
      ? 'WSL2 setup not complete. Run: node scripts/fetch-photoprism.js'
      : 'PhotoPrism binary or assets/ not found. Run: node scripts/fetch-photoprism.js';
    throw new Error(service.error);
  }

  service.config = { ...cfg };
  service.state  = 'starting';
  service.error  = null;

  try {
    if (process.platform === 'win32') {
      await startWSL2(cfg);
    } else {
      startNative(cfg);
    }
    // 180s covers first-run DB migration + CNN model init on the 260305 release.
    await waitForPort(PHOTOPRISM_PORT, 180_000);
    service.state = 'running';
    console.log(`[PhotoPrismManager] ready on :${PHOTOPRISM_PORT}`);
  } catch (err) {
    service.state = 'error';
    service.error = (err as Error).message;
    service.process?.kill();
    service.process = null;
    throw err;
  }
}

// ── Stop ──────────────────────────────────────────────────────────────────────

export async function stopPhotoprism(): Promise<void> {
  if (service.state === 'stopped' && !service.process) return;

  if (service.process) {
    // On Windows, kill the entire process tree — plain SIGTERM only kills the
    // direct child, leaving grandchildren (the actual binary) as orphans.
    if (process.platform === 'win32' && service.process.pid !== undefined) {
      const { spawn: spawnRaw } = await import('child_process');
      await new Promise<void>(resolve => {
        const tk = spawnRaw('taskkill', ['/F', '/T', '/PID', String(service.process!.pid!)],
          { stdio: 'ignore', windowsHide: true });
        tk.on('close', () => resolve());
        tk.on('error', () => resolve());
      });
      service.process = null;
      return;
    }
    service.process.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const t = setTimeout(() => { service.process?.kill('SIGKILL'); resolve(); }, 8_000);
      service.process!.once('exit', () => { clearTimeout(t); resolve(); });
    });
    service.process = null;
  }

  // On Windows: also kill any orphaned photoprism process inside WSL2.
  if (process.platform === 'win32') {
    try {
      await exec('wsl.exe', ['-u', 'root', '-d', WSL_DISTRO, '--', 'bash', '-c',
        `pkill -f 'photoprism start' 2>/dev/null; true`]);
    } catch { /* non-fatal */ }
  }

  service.state = 'stopped';
  _sessionToken  = null;
  _sessionExpiry = 0;
}

// ── Status ────────────────────────────────────────────────────────────────────

export interface PhotoPrismStatus {
  state:         'stopped' | 'starting' | 'running' | 'error';
  port:          number;
  error:         string | null;
  binaryPresent: boolean;
  originalsPath: string | null;
  storageDir:    string;
  mode:          'native' | 'wsl2';
}

export function getPhotoPrismStatus(): PhotoPrismStatus {
  return {
    state:         service.state,
    port:          PHOTOPRISM_PORT,
    error:         service.error,
    binaryPresent: isBinaryPresent(),
    originalsPath: service.config?.originalsPath ?? null,
    storageDir:    resolveStorageDir(),
    mode:          process.platform === 'win32' ? 'wsl2' : 'native',
  };
}

// ── Library scan ──────────────────────────────────────────────────────────────

export async function triggerLibraryScan(rescan = false): Promise<void> {
  if (service.state !== 'running') throw new Error('PhotoPrism is not running');
  const res = await photoPrismApiRequest('POST', '/api/v1/index', { Action: 'index', Rescan: rescan });
  if (!res.ok) throw new Error(`Index trigger failed: HTTP ${res.status}`);
}

// ── Session token ─────────────────────────────────────────────────────────────

let _sessionToken:  string | null = null;
let _sessionExpiry: number        = 0;

export async function getApiToken(): Promise<string> {
  const now = Date.now();
  if (_sessionToken && now < _sessionExpiry) return _sessionToken;
  if (!service.config) throw new Error('PhotoPrism not configured');

  const res = await fetch(`http://127.0.0.1:${PHOTOPRISM_PORT}/api/v1/session`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ username: 'phobos', password: service.config.adminPassword }),
  });
  if (!res.ok) throw new Error(`PhotoPrism session acquire failed: HTTP ${res.status}`);

  const data     = await res.json() as { id: string };
  _sessionToken  = data.id;
  _sessionExpiry = now + 23 * 60 * 60 * 1000;
  return _sessionToken;
}

// ── Proxy helper ──────────────────────────────────────────────────────────────

export async function photoPrismApiRequest(
  method:   string,
  endpoint: string,
  body?:    unknown,
): Promise<Response> {
  if (service.state !== 'running') throw new Error('PhotoPrism is not running');
  const token = await getApiToken();
  return fetch(`http://127.0.0.1:${PHOTOPRISM_PORT}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
    body:    body != null ? JSON.stringify(body) : undefined,
  });
}
