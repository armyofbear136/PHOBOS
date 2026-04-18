/**
 * PiGalleryManager.ts — Lifecycle manager for the PiGallery2 photo library service.
 *
 * PiGallery2 is a Node.js application. It runs natively on all platforms with no
 * virtualisation, no Docker, and no WSL2. PHOBOS writes config.json before each
 * start — PiGallery2 reads it only at startup, so a library path change requires
 * a full stop/start cycle.
 *
 * Port:    16320 (permanent wire contract — same port previously held by PhotoPrism)
 * Entry:   node dist/backend/server.js
 * Install: ~/.phobos/services/pigallery2/   (release zip extracted + npm install)
 * Config:  ~/.phobos/services/pigallery2/config/config.json  (written by this manager)
 * DB:      ~/.phobos/services/pigallery2/data/pigallery2.db  (SQLite, PiGallery2 internal)
 */

import { spawn, type ChildProcess } from 'child_process';
import { promisify }                from 'util';
import { execFile }                 from 'child_process';
import * as fs                      from 'fs';
import * as net                     from 'net';
import * as path                    from 'path';
import * as os                      from 'os';

const execFileAsync = promisify(execFile);

// ── Wire constants ─────────────────────────────────────────────────────────────

export const PIGALLERY_PORT = 16320;

// ── Config ────────────────────────────────────────────────────────────────────

export interface PiGalleryConfig {
  libraryPath: string;
}

// ── Service state ─────────────────────────────────────────────────────────────

interface ManagedService {
  config:  PiGalleryConfig | null;
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
  return path.join(os.homedir(), '.phobos', 'services', 'pigallery2');
}

export function resolveEntryPoint(): string {
  return path.join(resolveServiceDir(), 'dist', 'backend', 'server.js');
}

export function resolveConfigPath(): string {
  return path.join(resolveServiceDir(), 'config', 'config.json');
}

export function resolveDataDir(): string {
  return path.join(resolveServiceDir(), 'data');
}

export function resolveTempDir(): string {
  return path.join(resolveServiceDir(), 'tmp');
}

// ── Readiness check ───────────────────────────────────────────────────────────

export function isBinaryPresent(): boolean {
  const entry = resolveEntryPoint();
  if (!fs.existsSync(entry)) return false;
  if (fs.statSync(entry).size === 0) return false;
  return fs.existsSync(path.join(resolveServiceDir(), 'node_modules'));
}

// ── Installed version ─────────────────────────────────────────────────────────

export function getInstalledVersion(): string | null {
  const pkgPath = path.join(resolveServiceDir(), 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

// ── ffmpeg resolution ─────────────────────────────────────────────────────────

function resolveJellyfinFfmpegPath(): string {
  return path.join(os.homedir(), '.phobos', 'services', 'jellyfin', 'ffmpeg',
    process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

async function buildEnvWithFfmpeg(): Promise<NodeJS.ProcessEnv> {
  const env = { ...process.env };

  // Check system PATH first.
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    await execFileAsync(cmd, ['ffmpeg']);
    return env; // ffmpeg found on PATH — nothing to inject
  } catch {
    // Not on PATH — try Jellyfin's bundled ffmpeg.
  }

  const jellyfinFfmpeg = resolveJellyfinFfmpegPath();
  if (fs.existsSync(jellyfinFfmpeg)) {
    const ffmpegDir = path.dirname(jellyfinFfmpeg);
    env.PATH = `${ffmpegDir}${path.delimiter}${process.env.PATH ?? ''}`;
    console.log(`[PiGalleryManager] ffmpeg not on PATH — using Jellyfin's: ${jellyfinFfmpeg}`);
    return env;
  }

  console.warn('[PiGalleryManager] ffmpeg not found — video thumbnails will be unavailable');
  return env;
}

// ── Config file writer ────────────────────────────────────────────────────────

function writeConfigJson(cfg: PiGalleryConfig): void {
  const configPath = resolveConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(resolveDataDir(),          { recursive: true });
  fs.mkdirSync(resolveTempDir(),          { recursive: true });

  const config = {
    Server: {
      port: PIGALLERY_PORT,
      host: '127.0.0.1',
    },
    Media: {
      folder:     cfg.libraryPath,
      tempFolder: resolveTempDir(),
    },
    Database: {
      type:   'sqlite3',
      sqlite: {
        storage: path.join(resolveDataDir(), 'pigallery2.db'),
      },
    },
    Jobs: {
      indexing: {
        enabled:               true,
        reIndexingSensitivity: 0,
      },
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

// ── Port readiness probe ──────────────────────────────────────────────────────

function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt  = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`PiGallery2 port ${port} not ready after ${timeoutMs / 1000}s`));
          return;
        }
        setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

// ── Config-change detection ───────────────────────────────────────────────────

function configChanged(cfg: PiGalleryConfig): boolean {
  if (!service.config) return true;
  return service.config.libraryPath !== cfg.libraryPath;
}

// ── Start ─────────────────────────────────────────────────────────────────────

export async function startPiGallery(cfg: PiGalleryConfig): Promise<void> {
  if ((service.state === 'running' || service.state === 'starting') && !configChanged(cfg)) return;
  if (service.state === 'running' || service.state === 'starting') await stopPiGallery();

  if (!isBinaryPresent()) {
    service.state = 'error';
    service.error = 'PiGallery2 not installed. Run: node scripts/fetch-pigallery2.js';
    throw new Error(service.error);
  }

  service.config = { ...cfg };
  service.state  = 'starting';
  service.error  = null;

  writeConfigJson(cfg);

  const env     = await buildEnvWithFfmpeg();
  const entry   = resolveEntryPoint();
  const svcDir  = resolveServiceDir();

  const proc = spawn(process.execPath, [entry], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    cwd:  svcDir,
  });

  proc.stdout?.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) console.log(`[pigallery2] ${line}`);
  });
  proc.stderr?.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) console.log(`[pigallery2] ${line}`);
  });
  proc.on('exit', (code, signal) => {
    console.log(`[PiGalleryManager] exited code=${code} signal=${signal}`);
    service.process = null;
    if (service.state !== 'stopped') {
      service.state = code === 0 || signal === 'SIGTERM' ? 'stopped' : 'error';
      if (code !== 0 && code !== null && signal == null) {
        service.error = `PiGallery2 exited with code ${code}`;
        console.error('[PiGalleryManager] unexpected exit:', code);
      }
    }
  });

  service.process = proc;

  try {
    await waitForPort(PIGALLERY_PORT, 30_000);
    service.state = 'running';
    console.log(`[PiGalleryManager] ready on :${PIGALLERY_PORT}`);
  } catch (err) {
    service.state = 'error';
    service.error = (err as Error).message;
    service.process?.kill();
    service.process = null;
    throw err;
  }
}

// ── Stop ──────────────────────────────────────────────────────────────────────

export async function stopPiGallery(): Promise<void> {
  if (service.state === 'stopped' && !service.process) return;

  service.state = 'stopped';

  if (service.process) {
    if (process.platform === 'win32' && service.process.pid !== undefined) {
      const { spawn: spawnRaw } = await import('child_process');
      await new Promise<void>(resolve => {
        const tk = spawnRaw(
          'taskkill',
          ['/F', '/T', '/PID', String(service.process!.pid!)],
          { stdio: 'ignore', windowsHide: true },
        );
        tk.on('close', () => resolve());
        tk.on('error', () => resolve());
      });
    } else {
      service.process.kill('SIGTERM');
      await new Promise<void>(resolve => {
        const t = setTimeout(() => { service.process?.kill('SIGKILL'); resolve(); }, 5_000);
        service.process!.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
    service.process = null;
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

export interface PiGalleryStatus {
  state:            'stopped' | 'starting' | 'running' | 'error';
  port:             number;
  error:            string | null;
  binaryPresent:    boolean;
  libraryPath:      string | null;
  installedVersion: string | null;
}

export function getPiGalleryStatus(): PiGalleryStatus {
  return {
    state:            service.state,
    port:             PIGALLERY_PORT,
    error:            service.error,
    binaryPresent:    isBinaryPresent(),
    libraryPath:      service.config?.libraryPath ?? null,
    installedVersion: getInstalledVersion(),
  };
}

// ── Indexing trigger ──────────────────────────────────────────────────────────

export async function triggerIndexing(): Promise<void> {
  if (service.state !== 'running') throw new Error('PiGallery2 is not running');
  const res = await piGalleryApiRequest('POST', '/api/admin/jobs/indexing/start');
  if (!res.ok) throw new Error(`Indexing trigger failed: HTTP ${res.status}`);
}

// ── Proxy helper ──────────────────────────────────────────────────────────────

export async function piGalleryApiRequest(
  method:   string,
  endpoint: string,
  body?:    unknown,
): Promise<Response> {
  if (service.state !== 'running') throw new Error('PiGallery2 is not running');
  return fetch(`http://127.0.0.1:${PIGALLERY_PORT}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body:    body != null ? JSON.stringify(body) : undefined,
  });
}
