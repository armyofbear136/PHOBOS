/**
 * KavitaManager.ts — Lifecycle manager for the Kavita reading server.
 *
 * Kavita is a core PHOBOS service — it starts unconditionally at server launch
 * (not gated on user enable/disable) as long as the binary is present.
 *
 * Port:     18000  (permanent wire contract)
 * Binary:   ~/.phobos/services/kavita/Kavita[.exe]
 * Config:   ~/.phobos/services/kavita/config/appsettings.json  (written pre-spawn)
 * Data:     ~/.phobos/services/kavita/config/kavita.db
 *
 * phobosdocs library:
 *   Default path: ~/.phobos/media/kavita/phobosdocs
 *   Created on first boot. Cannot be deleted via UI — only moved.
 *   Used as the destination for PHOBOS document-saving operations.
 *
 * Auth:
 *   v0.8.9+ uses permanent auth keys (x-api-key).  JWT is only used for the
 *   JWT is stored in memory and refreshed every 23 hours via the refresh token.
 *
 * First-run sequence:
 *   1. Write config/appsettings.json (port, localhost bind, tokenKey)
 *   2. Spawn binary
 *   3. Wait for port (120s on first enable to accommodate DB migration)
 *   4. POST /api/Account/register → catch 400 (already exists)
 *   5. POST /api/Account/login → create permanent auth key → store in ServiceStore
 *   6. POST /api/Library (phobosdocs, type=3 Books)
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs   from 'fs';
import * as net  from 'net';
import * as path from 'path';
import * as os   from 'os';

export const KAVITA_PORT         = 18000;
export const KAVITA_ADMIN_USER   = 'phobos';
export const KAVITA_RELEASE      = '0.8.9.1';
export const PHOBOSDOCS_LIB_NAME = 'phobosDocs';

// Library type codes per Kavita API
export const KAVITA_LIB_TYPE = {
  manga:       0,
  comics:      1,
  books:       3,
  images:      4,
  lightnovels: 5,
} as const;

// FileTypeGroup integer values for CreateLibraryDto.fileGroupTypes.
// LibraryFileTypeGroup is 1-based: Image=1, Archive=2, Epub=3, Pdf=4.
// Send all four so no file type is filtered out — same as selecting all in the UI.
// NOTE: 0 is not a valid value and throws ArgumentOutOfRangeException in GetRegex().
const ALL_FILE_GROUPS = [1, 2, 3, 4];

export type KavitaLibType = keyof typeof KAVITA_LIB_TYPE;

const BINARY_MIN_BYTES: Record<string, number> = {
  'linux-x64':    80_000_000,
  'linux-arm64':  75_000_000,
  'win32-x64':    8_000_000,   // probe API.dll — Kavita.exe is a 193 KB launcher stub
  'darwin-x64':   85_000_000,
  'darwin-arm64': 80_000_000,
};

// ── State ─────────────────────────────────────────────────────────────────────

interface ManagedService {
  process:      ChildProcess | null;
  state:        'stopped' | 'starting' | 'running' | 'error';
  error:        string | null;
  /** Short-lived JWT used for all API calls. Refreshed every 23 hours. */
  jwt:          string | null;
  /** Refresh token for renewing the JWT without re-login. */
  refreshToken: string | null;
  /** Timer that proactively refreshes the JWT before expiry. */
  jwtTimer:     NodeJS.Timeout | null;
  /** Path to phobosdocs library folder (may be user-moved). */
  docsPath:     string | null;
}

const service: ManagedService = {
  process: null, state: 'stopped', error: null,
  jwt: null, refreshToken: null, jwtTimer: null, docsPath: null,
};

// ── Path resolution ───────────────────────────────────────────────────────────

export function resolveServiceDir(): string {
  return path.join(os.homedir(), '.phobos', 'services', 'kavita');
}

export function resolveBinaryPath(): string {
  const exe = process.platform === 'win32' ? 'Kavita.exe' : 'Kavita';
  return path.join(resolveServiceDir(), exe);
}

export function resolveConfigDir(): string {
  return path.join(resolveServiceDir(), 'config');
}

export function resolveConfigPath(): string {
  return path.join(resolveConfigDir(), 'appsettings.json');
}

export function resolveWwwRootDir(): string {
  return path.join(resolveServiceDir(), 'wwwroot');
}

export function writeAutoLoginPage(): void {
    const wwwroot = resolveWwwRootDir();
    fs.mkdirSync(wwwroot, { recursive: true });
    fs.writeFileSync(path.join(wwwroot, 'autologin.html'), `<!DOCTYPE html>
  <html><head><meta charset="utf-8"></head><body><script>
  (function () {
    var p = new URLSearchParams(location.search);
    var token = p.get('token');
    var username = p.get('username') || 'phobos';
    var dest = p.get('dest') || '/';
    if (token) {
      localStorage.setItem('kavita-user', JSON.stringify({ username: username, token: token, refreshToken: '' }));
    }
    location.replace(dest);
  })();
  </script></body></html>`, 'utf8');
  }

export function defaultDocsPath(): string {
  return path.join(os.homedir(), '.phobos', 'media', 'kavita', 'phobosdocs');
}

export function isBinaryPresent(): boolean {
  const bin = resolveBinaryPath();
  if (!fs.existsSync(bin)) return false;
  // On Windows, Kavita.exe is a 193 KB launcher stub — the real runtime is API.dll.
  // Probe API.dll so the size check actually confirms extraction completed.
  const probeFile   = process.platform === 'win32'
    ? path.join(resolveServiceDir(), 'API.dll')
    : bin;
  if (!fs.existsSync(probeFile)) return false;
  const platformKey = `${process.platform}-${process.arch}`;
  const minBytes    = BINARY_MIN_BYTES[platformKey] ?? 75_000_000;
  return fs.statSync(probeFile).size >= minBytes;
}

// ── Port wait ─────────────────────────────────────────────────────────────────

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt  = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Kavita port ${port} not ready after ${timeoutMs / 1000}s`));
          return;
        }
        setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

// ── Config write ──────────────────────────────────────────────────────────────

function writeConfig(tokenKey: string): void {
  fs.mkdirSync(resolveConfigDir(), { recursive: true });
  const config = {
    TokenKey:         tokenKey,
    Port:             KAVITA_PORT,
    IpAddresses:      '127.0.0.1',
    AllowIpAddresses: '',
  };
  fs.writeFileSync(resolveConfigPath(), JSON.stringify(config, null, 2), 'utf8');
}

// ── API helpers ───────────────────────────────────────────────────────────────

const BASE = `http://127.0.0.1:${KAVITA_PORT}/api`;

async function kavitaFetch(
  endpoint: string,
  opts: { method?: string; body?: unknown; jwt?: string },
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Use explicit jwt override (bootstrap calls), otherwise use in-memory session JWT.
  const token = opts.jwt ?? service.jwt;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${endpoint}`, {
    method:  opts.method ?? 'GET',
    headers,
    body:    opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  let data: unknown;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// ── Bootstrap sequence ────────────────────────────────────────────────────────

/**
 * Run after port opens. Idempotent — safe to call on every restart.
 * Logs in with username/password, stores JWT + refresh token in memory,
 * and schedules proactive JWT refresh every 23 hours.
 *
 * Kavita JWTs expire after 24-48 hours. We refresh at 23 h to stay well
 * within that window without hammering the server. The refresh token has
 * a longer lifetime (typically 7 days).
 *
 * Returns the refresh token so server.ts can persist it across restarts
 * (avoids re-login if the refresh token is still valid).
 */
async function bootstrap(adminPassword: string, storedRefreshToken: string): Promise<string> {
  // Try to renew via refresh token first (avoids password re-auth on restarts).
  if (storedRefreshToken && service.jwt) {
    const renewed = await tryRefreshJwt(storedRefreshToken);
    if (renewed) {
      console.log('[KavitaManager] JWT renewed via refresh token.');
      scheduleJwtRefresh(adminPassword);
      return service.refreshToken!;
    }
  }

  // Register admin account (only works before any account exists).
  // 200 = created, 400 = already exists — both are fine.
  const reg = await kavitaFetch('/Account/register', {
    method: 'POST',
    body: {
      username: KAVITA_ADMIN_USER,
      password: adminPassword,
      email:    'phobos@localhost',
    },
  });
  if (!reg.ok && reg.status !== 400) {
    throw new Error(`Kavita account registration failed: HTTP ${reg.status}`);
  }

  // Login to get JWT + refresh token.
  return await loginAndStore(adminPassword);
}

async function loginAndStore(adminPassword: string): Promise<string> {
  const login = await kavitaFetch('/Account/login', {
    method: 'POST',
    body: { username: KAVITA_ADMIN_USER, password: adminPassword },
  });

  if (login.status === 401) {
    // 401 means the account doesn't exist or the password is wrong.
    // This happens when kavita.db was wiped (e.g. after running test-kavita.ts
    // which creates its own account with TEST_PASSWORD). Attempt re-registration
    // with the stored password — if the DB is fresh, this will create the account.
    console.log('[KavitaManager] Login returned 401 — attempting account re-registration (DB may have been reset).');
    const reg = await kavitaFetch('/Account/register', {
      method: 'POST',
      body: { username: KAVITA_ADMIN_USER, password: adminPassword, email: 'phobos@localhost' },
    });
    if (!reg.ok && reg.status !== 400) {
      throw new Error(`Kavita login failed (401) and re-registration failed (HTTP ${reg.status}). Delete kavita.db and restart.`);
    }
    // Retry login with the same password.
    const retry = await kavitaFetch('/Account/login', {
      method: 'POST',
      body: { username: KAVITA_ADMIN_USER, password: adminPassword },
    });
    if (!retry.ok) {
      throw new Error(`Kavita login failed after re-registration: HTTP ${retry.status}. Delete ~/.phobos/services/kavita/config/kavita.db and restart.`);
    }
    const retryResp = retry.data as Record<string, string>;
    if (!retryResp.token) throw new Error('Kavita re-registration login response missing token field');
    service.jwt          = retryResp.token;
    service.refreshToken = retryResp.refreshToken ?? null;
    scheduleJwtRefresh(adminPassword);
    return service.refreshToken ?? '';
  }

  if (!login.ok) throw new Error(`Kavita login failed: HTTP ${login.status}`);

  const resp = login.data as Record<string, string>;
  if (!resp.token) throw new Error('Kavita login response missing token field');

  service.jwt          = resp.token;
  service.refreshToken = resp.refreshToken ?? null;
  scheduleJwtRefresh(adminPassword);
  return service.refreshToken ?? '';
}

async function tryRefreshJwt(refreshToken: string): Promise<boolean> {
  try {
    // service.jwt must be set for kavitaFetch to include the Authorization header.
    const res = await kavitaFetch('/Account/refresh-token', {
      method: 'POST',
      body: { token: service.jwt, refreshToken },
    });
    if (!res.ok) return false;
    const resp = res.data as Record<string, string>;
    if (!resp.token) return false;
    service.jwt          = resp.token;
    service.refreshToken = resp.refreshToken ?? refreshToken;
    return true;
  } catch {
    return false;
  }
}

function scheduleJwtRefresh(adminPassword: string): void {
  if (service.jwtTimer) clearTimeout(service.jwtTimer);
  // Refresh 23 hours from now — well before the 24-48h JWT expiry.
  service.jwtTimer = setTimeout(async () => {
    if (service.state !== 'running') return;
    console.log('[KavitaManager] Proactive JWT refresh...');
    try {
      if (service.refreshToken) {
        const ok = await tryRefreshJwt(service.refreshToken);
        if (ok) { scheduleJwtRefresh(adminPassword); return; }
      }
      await loginAndStore(adminPassword);
      console.log('[KavitaManager] JWT refreshed via re-login.');
    } catch (err) {
      console.warn('[KavitaManager] JWT refresh failed (non-fatal):', (err as Error).message);
      scheduleJwtRefresh(adminPassword);
    }
  }, 23 * 60 * 60 * 1000);
  // Allow Node to exit even if the timer is pending.
  service.jwtTimer.unref();
}

/**
 * Ensure the phobosdocs library exists in Kavita.
 * Creates it if absent; silently succeeds if present.
 */
async function ensurePhobosDocsLibrary(docsPath: string): Promise<void> {
  fs.mkdirSync(docsPath, { recursive: true });

  const listRes = await kavitaFetch('/Library/libraries', {});
  if (!listRes.ok) return;

  const libs = Array.isArray(listRes.data) ? listRes.data as Array<{ name: string }> : [];
  if (libs.some(l => l.name === PHOBOSDOCS_LIB_NAME)) return;

  const createRes = await kavitaFetch('/Library/create', {
    method: 'POST',
    body: {
      name:                       PHOBOSDOCS_LIB_NAME,
      type:                       KAVITA_LIB_TYPE.books,
      folders:                    [docsPath],
      fileGroupTypes:             ALL_FILE_GROUPS,
      excludePatterns:            [],
      folderWatching:             true,
      includeInDashboard:         true,
      includeInRecommended:       true,
      manageCollections:          true,
      collapseSeriesRelationships: false,
    },
  });

  if (createRes.ok) {
    console.log(`[KavitaManager] phobosDocs library created at ${docsPath}`);
  } else if (createRes.status === 400) {
    // 400 = name already taken or validation error — either way library likely exists.
    console.log(`[KavitaManager] phobosDocs create returned 400 (may already exist): ${JSON.stringify(createRes.data)}`);
  } else {
    console.warn(`[KavitaManager] phobosDocs library create failed: HTTP ${createRes.status}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface KavitaStartConfig {
  tokenKey:         string;
  adminPassword:    string;
  /** Stored refresh token from previous session — empty on first boot. */
  refreshToken:     string;
  docsPath:         string;    // ~/.phobos/media/kavita/phobosdocs (or user-moved path)
  firstBoot:        boolean;   // true = extend port-wait timeout for DB migration
}

export async function startKavita(cfg: KavitaStartConfig): Promise<{ refreshToken: string }> {
  if (service.state === 'running' || service.state === 'starting') return { refreshToken: service.refreshToken ?? '' };
  if (!isBinaryPresent()) {
    service.state = 'error';
    service.error = 'Kavita binary not found. Run: node scripts/fetch-kavita.js';
    throw new Error(service.error);
  }

  service.state   = 'starting';
  service.error   = null;
  service.docsPath = cfg.docsPath;

  try {
    writeConfig(cfg.tokenKey);
    writeAutoLoginPage();

    const bin = resolveBinaryPath();
    if (process.platform !== 'win32') {
      try { fs.chmodSync(bin, 0o755); } catch { /* non-fatal */ }
    }

    const proc = spawn(bin, ['--config', resolveConfigDir()], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd:   resolveServiceDir(),
    });

    proc.stdout?.on('data', (d: Buffer) => { const l = d.toString().trim(); if (l) console.log(`[kavita] ${l}`); });
    proc.stderr?.on('data', (d: Buffer) => { const l = d.toString().trim(); if (l) console.log(`[kavita] ${l}`); });
    proc.on('exit', (code, signal) => {
      console.log(`[KavitaManager] exited code=${code} signal=${signal}`);
      service.process = null;
      service.state   = code === 0 || signal === 'SIGTERM' ? 'stopped' : 'error';
      if (code !== 0 && code !== null && signal == null) service.error = `Exited with code ${code}`;
    });

    service.process = proc;

    // First boot includes DB migration — allow up to 120s.
    const portTimeout = cfg.firstBoot ? 120_000 : 30_000;
    await waitForPort(KAVITA_PORT, portTimeout);

    const refreshToken = await bootstrap(cfg.adminPassword, cfg.refreshToken);
    service.refreshToken = refreshToken;

    await ensurePhobosDocsLibrary(cfg.docsPath);

    service.state = 'running';
    console.log(`[KavitaManager] ready on :${KAVITA_PORT}`);
    return { refreshToken };
  } catch (err) {
    service.state = 'error';
    service.error = (err as Error).message;
    service.process?.kill();
    service.process = null;
    throw err;
  }
}

export async function stopKavita(): Promise<void> {
  if (service.state === 'stopped' && !service.process) return;
  if (service.process) {
    service.process.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const t = setTimeout(() => { service.process?.kill('SIGKILL'); resolve(); }, 10_000);
      service.process!.once('exit', () => { clearTimeout(t); resolve(); });
    });
    service.process = null;
  }
  service.state        = 'stopped';
  service.jwt          = null;
  service.refreshToken = null;
  if (service.jwtTimer) { clearTimeout(service.jwtTimer); service.jwtTimer = null; }
}

export interface KavitaStatus {
  state:         'stopped' | 'starting' | 'running' | 'error';
  port:          number;
  error:         string | null;
  binaryPresent: boolean;
  docsPath:      string | null;
}

export function getKavitaStatus(): KavitaStatus {
  return {
    state:         service.state,
    port:          KAVITA_PORT,
    error:         service.error,
    binaryPresent: isBinaryPresent(),
    docsPath:      service.docsPath,
  };
}

/** Returns the current session JWT, or null if Kavita is not running / not yet authenticated. */
export function getKavitaJwt(): string | null {
  return service.jwt;
}

/** @deprecated Use getKavitaJwt() — kept for route compatibility */
export function getKavitaAuthKey(): string | null {
  return service.jwt;
}

// ── Library management (called from routes) ───────────────────────────────────

export interface KavitaLibrary {
  id:           number;
  name:         string;
  type:         number;
  folders:      string[];
  /** Returned as seriesCount in newer Kavita responses; may also appear as series. */
  seriesCount?: number;
  series?:      number;
}

export async function listLibraries(): Promise<KavitaLibrary[]> {
  if (!service.jwt) throw new Error('Kavita not running');
  const res = await kavitaFetch('/Library/libraries', {});
  if (!res.ok) throw new Error(`Kavita library list failed: HTTP ${res.status}`);
  return Array.isArray(res.data) ? res.data as KavitaLibrary[] : [];
}

export async function createLibrary(
  name: string,
  type: number,
  folders: string[],
): Promise<KavitaLibrary> {
  if (!service.jwt) throw new Error('Kavita not running');
  for (const f of folders) fs.mkdirSync(f, { recursive: true });
  const res = await kavitaFetch('/Library/create', {
    method: 'POST',
    body: {
      name,
      type,
      folders,
      fileGroupTypes:              ALL_FILE_GROUPS,
      excludePatterns:             [],
      folderWatching:              true,
      includeInDashboard:          true,
      includeInRecommended:        true,
      manageCollections:           true,
      collapseSeriesRelationships: false,
    },
  });
  if (!res.ok) {
    const detail = typeof res.data === 'object' && res.data !== null
      ? JSON.stringify(res.data) : String(res.data);
    throw new Error(`Kavita library create failed: HTTP ${res.status} — ${detail}`);
  }
  // POST /api/library/create returns 200 with null body in 0.8.9.x.
  // Re-fetch the library list and find the one we just created.
  const all = await listLibraries();
  const created = all.find(l => l.name === name);
  if (!created) throw new Error(`Kavita library created but not found in list: ${name}`);
  return created;
}

export async function updateLibraryFolders(
  id: number,
  name: string,
  type: number,
  folders: string[],
): Promise<void> {
  if (!service.jwt) throw new Error('Kavita not running');
  for (const f of folders) fs.mkdirSync(f, { recursive: true });
  const res = await kavitaFetch('/Library/update', {
    method: 'POST',
    body: {
      id,
      name,
      type,
      folders,
      fileGroupTypes:              [1, 2, 3, 4],
      excludePatterns:             [],
      folderWatching:              true,
      includeInDashboard:          true,
      includeInRecommended:        true,
      manageCollections:           true,
      collapseSeriesRelationships: false,
    },
  });
  if (!res.ok) throw new Error(`Kavita library update failed: HTTP ${res.status}`);
}

export async function triggerScan(): Promise<void> {
  if (!service.jwt) throw new Error('Kavita not running');
  await kavitaFetch('/Library/scan-all', { method: 'POST' });
}

export async function getStats(): Promise<{ totalSeries: number; libraryCount: number }> {
  const libs = await listLibraries();
  const totalSeries  = libs.reduce((n, l) => n + (l.seriesCount ?? l.series ?? 0), 0);
  return { totalSeries, libraryCount: libs.length };
}
