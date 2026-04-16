/**
 * PolarisManager.ts — Lifecycle manager for the Polaris music server.
 *
 * Polaris 0.16: config is TOML for mount dirs/settings only. Users are
 * created via the REST API after first boot. No [[users]] in the TOML.
 *
 * Port:    18050 (permanent wire contract)
 * Binary:  ~/.phobos/services/polaris/polaris-cli.exe (Windows)
 *          ~/.phobos/services/polaris/polaris         (Linux/macOS)
 * Config:  ~/.phobos/services/polaris/polaris.toml    (written on every start)
 * Data:    ~/.phobos/services/polaris/data/           (playlists, index db)
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs   from 'fs';
import * as net  from 'net';
import * as path from 'path';
import * as os   from 'os';

export const POLARIS_PORT        = 18050;
export const POLARIS_ADMIN_USER  = 'phobos';
export const POLARIS_API_VERSION = '8';

const BINARY_MIN_BYTES: Record<string, number> = {
  'linux-x64':    5_000_000,
  'linux-arm64':  5_000_000,
  'win32-x64':    5_000_000,
  'darwin-x64':   5_000_000,
  'darwin-arm64': 5_000_000,
};

export interface PolarisConfig {
  adminPassword: string;
  libraryPath:   string;
  mountName:     string;
}

interface ManagedService {
  config:  PolarisConfig | null;
  process: ChildProcess | null;
  state:   'stopped' | 'starting' | 'running' | 'error';
  error:   string | null;
}

const service: ManagedService = {
  config: null, process: null, state: 'stopped', error: null,
};

export function resolveServiceDir(): string {
  return path.join(os.homedir(), '.phobos', 'services', 'polaris');
}

export function resolveBinaryPath(): string {
  const bin = process.platform === 'win32' ? 'polaris-cli.exe' : 'polaris';
  return path.join(resolveServiceDir(), bin);
}

function resolveConfigPath(): string {
  return path.join(resolveServiceDir(), 'polaris.toml');
}

function resolveDataDir(): string {
  return path.join(resolveServiceDir(), 'data');
}

export function isBinaryPresent(): boolean {
  const bin = resolveBinaryPath();
  if (!fs.existsSync(bin)) return false;
  const platformKey = `${process.platform}-${process.arch}`;
  const minBytes    = BINARY_MIN_BYTES[platformKey] ?? 5_000_000;
  return fs.statSync(bin).size >= minBytes;
}

function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt  = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) { reject(new Error(`Polaris port ${port} not ready after ${timeoutMs / 1000}s`)); return; }
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

// Polaris 0.16: users defined in TOML via initial_password field.
// No API user creation needed — Polaris hashes the password on first read.
function writeConfig(cfg: PolarisConfig): void {
  const safePath = cfg.libraryPath.replace(/\\/g, '\\\\');
  const toml = [
    `album_art_pattern = "(?i)(folder|cover|album|front)\\\\.(jpg|jpeg|png|gif|webp)"`,
    ``,
    `[[mount_dirs]]`,
    `source = "${safePath}"`,
    `name = "${cfg.mountName}"`,
    ``,
    `[[users]]`,
    `name = "${POLARIS_ADMIN_USER}"`,
    `initial_password = "${cfg.adminPassword}"`,
    `admin = true`,
    ``,
  ].join('\n');
  fs.mkdirSync(resolveServiceDir(), { recursive: true });
  fs.writeFileSync(resolveConfigPath(), toml, 'utf8');
}

function configChanged(cfg: PolarisConfig): boolean {
  if (!service.config) return true;
  return (
    service.config.adminPassword !== cfg.adminPassword ||
    service.config.libraryPath   !== cfg.libraryPath   ||
    service.config.mountName     !== cfg.mountName
  );
}

// Users are defined in polaris.toml via initial_password — no API user creation needed.

export async function startPolaris(cfg: PolarisConfig): Promise<void> {
  if ((service.state === 'running' || service.state === 'starting') && !configChanged(cfg)) return;
  if (service.state === 'running' || service.state === 'starting') await stopPolaris();

  if (!isBinaryPresent()) {
    service.state = 'error';
    service.error = 'Polaris binary not found. Run: node scripts/fetch-polaris.js';
    throw new Error(service.error);
  }

  service.config = { ...cfg };
  service.state  = 'starting';
  service.error  = null;

  try {
    writeConfig(cfg);
    fs.mkdirSync(resolveDataDir(), { recursive: true });

    const bin  = resolveBinaryPath();
    const args = ['--config', resolveConfigPath(), '--data', resolveDataDir(), '--port', String(POLARIS_PORT)];

    if (process.platform !== 'win32') { try { fs.chmodSync(bin, 0o755); } catch { /* non-fatal */ } }

    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: resolveServiceDir() });

    proc.stdout?.on('data', (d: Buffer) => { const l = d.toString().trim(); if (l) console.log(`[polaris] ${l}`); });
    proc.stderr?.on('data', (d: Buffer) => { const l = d.toString().trim(); if (l) console.log(`[polaris] ${l}`); });
    proc.on('exit', (code, signal) => {
      console.log(`[PolarisManager] exited code=${code} signal=${signal}`);
      service.process = null;
      service.state   = code === 0 || signal === 'SIGTERM' ? 'stopped' : 'error';
      if (code !== 0 && code !== null && signal == null) service.error = `Exited with code ${code}`;
    });

    service.process = proc;
    await waitForPort(POLARIS_PORT);
    await acquireToken(cfg.adminPassword);
    service.state = 'running';
    console.log(`[PolarisManager] ready on :${POLARIS_PORT}`);
  } catch (err) {
    service.state = 'error';
    service.error = (err as Error).message;
    service.process?.kill();
    service.process = null;
    throw err;
  }
}

export async function stopPolaris(): Promise<void> {
  if (service.state === 'stopped' && !service.process) return;
  if (service.process) {
    service.process.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const t = setTimeout(() => { service.process?.kill('SIGKILL'); resolve(); }, 5_000);
      service.process!.once('exit', () => { clearTimeout(t); resolve(); });
    });
    service.process = null;
  }
  service.state = 'stopped';
  _token        = null;
}

export interface PolarisStatus {
  state:         'stopped' | 'starting' | 'running' | 'error';
  port:          number;
  error:         string | null;
  binaryPresent: boolean;
  libraryPath:   string | null;
}

export function getPolarisStatus(): PolarisStatus {
  return { state: service.state, port: POLARIS_PORT, error: service.error,
           binaryPresent: isBinaryPresent(), libraryPath: service.config?.libraryPath ?? null };
}

let _token: string | null = null;

async function acquireToken(password: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${POLARIS_PORT}/api/auth`, {
    method:'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Version': POLARIS_API_VERSION },
    body: JSON.stringify({ username: String(POLARIS_ADMIN_USER), password: String(password) }),
  });
  if (!res.ok) throw new Error(`Polaris auth failed: HTTP ${res.status}`);
  const data = await res.json() as { token: string };
  _token = data.token;
  return _token;
}

export async function getApiToken(): Promise<string> {
  if (_token) return _token;
  if (!service.config) throw new Error('Polaris not configured');
  return acquireToken(service.config.adminPassword);
}

export async function polarisApiRequest(method: string, endpoint: string, body?: unknown): Promise<Response> {
  if (service.state !== 'running') throw new Error('Polaris is not running');
  const token = await getApiToken();
  return fetch(`http://127.0.0.1:${POLARIS_PORT}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Accept-Version': POLARIS_API_VERSION },
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

export async function triggerScan(): Promise<void> {
  if (service.state !== 'running') throw new Error('Polaris is not running');
  // 0.16 auto-triggers on config change; manual trigger endpoint may vary.
  // Try common variants — a 405 is non-fatal since scans run automatically.
  const res = await polarisApiRequest('POST', '/api/trigger/index');
  if (!res.ok && res.status !== 405 && res.status !== 404) {
    throw new Error(`Polaris scan trigger failed: HTTP ${res.status}`);
  }
}

export async function getIndexStatus(): Promise<{ status: string; progress?: number }> {
  if (service.state !== 'running') throw new Error('Polaris is not running');
  try {
    const res = await polarisApiRequest('GET', '/api/index_status');
    if (!res.ok) return { status: 'unknown' };
    return res.json() as Promise<{ status: string; progress?: number }>;
  } catch {
    return { status: 'unknown' };
  }
}
