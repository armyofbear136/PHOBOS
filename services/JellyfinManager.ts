/**
 * JellyfinManager.ts — Lifecycle manager for the Jellyfin media server.
 *
 * Jellyfin is a headless transcoding + streaming backend. PHOBOS owns the UI
 * entirely. The user never interacts with Jellyfin's own web interface.
 *
 * Port:     18096 (permanent wire contract — avoids conflicts with user installs)
 * Binary:   ~/.phobos/services/jellyfin/jellyfin[.exe]
 * FFmpeg:   ~/.phobos/services/jellyfin/ffmpeg/ffmpeg[.exe]
 * Config:   ~/.phobos/services/jellyfin/config/  (network.xml written here pre-spawn)
 * Data:     ~/.phobos/services/jellyfin/data/
 * Cache:    ~/.phobos/services/jellyfin/cache/
 *
 * First-run wizard is automated via /Startup/* endpoints (no auth required).
 * After wizard: authenticate as 'phobos' user, cache access token for session.
 *
 * DB migration note (10.11+): first boot after upgrade migrates library.db →
 * jellyfin.db. Can take 5–30 min on large libraries. Port-wait timeout is
 * 5 minutes on first enable to accommodate this.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs   from 'fs';
import * as net  from 'net';
import * as path from 'path';
import * as os   from 'os';
import crypto    from 'crypto';

// ── Wire constants ─────────────────────────────────────────────────────────────
export const JELLYFIN_PORT    = 18096;
export const JELLYFIN_RELEASE = '10.11.8';

// Device identification header sent to Jellyfin on every API call.
const DEVICE_HEADER = 'MediaBrowser Client="PHOBOS", Device="phobos-hub", DeviceId="phobos-hub-001", Version="1.0.0"';

// On Windows, jellyfin.exe is a 197 KB launcher; jellyfin.dll is the 327 KB runtime.
// We size-probe jellyfin.dll on Windows as the real existence check.
// On Linux/macOS the single binary is both launcher and runtime.
const BINARY_SIZE_PROBE: Record<string, { file: string; minBytes: number }> = {
  'linux-x64':    { file: 'jellyfin',     minBytes: 70_000_000 },
  'linux-arm64':  { file: 'jellyfin',     minBytes: 65_000_000 },
  'win32-x64':    { file: 'jellyfin.dll', minBytes: 200_000    }, // 327 KB in 10.11.8
  'darwin-x64':   { file: 'jellyfin',     minBytes: 70_000_000 },
  'darwin-arm64': { file: 'jellyfin',     minBytes: 70_000_000 },
};

// ── Config ────────────────────────────────────────────────────────────────────

export interface JellyfinConfig {
  /** Primary media library path — added as a Movies library on first run. */
  libraryPath:     string | null;
  /** Hardware acceleration type. Empty string = CPU only. */
  hardwareAccel:   string;
}

// ── Service state ─────────────────────────────────────────────────────────────

interface ManagedService {
  config:      JellyfinConfig | null;
  process:     ChildProcess | null;
  state:       'stopped' | 'starting' | 'running' | 'error';
  error:       string | null;
  /** Jellyfin admin user ID — obtained after wizard/auth. */
  userId:      string | null;
  /** Session access token — valid until explicit logout. */
  accessToken: string | null;
}

const service: ManagedService = {
  config:      null,
  process:     null,
  state:       'stopped',
  error:       null,
  userId:      null,
  accessToken: null,
};

// ── Path helpers ──────────────────────────────────────────────────────────────

export function resolveServiceDir(): string {
  return path.join(os.homedir(), '.phobos', 'services', 'jellyfin');
}

export function resolveBinaryPath(): string {
  const exe = process.platform === 'win32' ? 'jellyfin.exe' : 'jellyfin';
  return path.join(resolveServiceDir(), exe);
}

export function resolveFFmpegPath(): string {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
 
  // 1. Check the dedicated ffmpeg/ subdir (Linux bundled jellyfin-ffmpeg).
  const subdirPath = path.join(resolveServiceDir(), 'ffmpeg', exe);
  if (fs.existsSync(subdirPath) && fs.statSync(subdirPath).size > 1_000_000) {
    return subdirPath;
  }
 
  // 2. Windows: ffmpeg.exe ships inside the main jellyfin zip, same dir as jellyfin.exe.
  const rootPath = path.join(resolveServiceDir(), exe);
  if (fs.existsSync(rootPath)) {
    return rootPath;
  }
 
  // 3. Return the subdir path as the canonical location (even if absent — let
  //    the caller decide whether to error or fall back to system PATH).
  return subdirPath;
}

export function resolveDataDir(): string {
  return path.join(resolveServiceDir(), 'data');
}

export function resolveCacheDir(): string {
  return path.join(resolveServiceDir(), 'cache');
}

export function resolveConfigDir(): string {
  return path.join(resolveServiceDir(), 'config');
}

/** ~/.phobos/media/jellyfin/phobosVideos — the mandatory default library for user-created content. */
export function defaultMediaPath(): string {
  return path.join(os.homedir(), '.phobos', 'media', 'jellyfin', 'phobosVideos');
}

// ── Binary presence check ─────────────────────────────────────────────────────

export function isBinaryPresent(): boolean {
  const bin = resolveBinaryPath();
  if (!fs.existsSync(bin)) return false;

  const platformKey = `${process.platform}-${process.arch}`;
  const probe = BINARY_SIZE_PROBE[platformKey];
  if (!probe) return true; // unknown platform — trust that the exe exists

  const probePath = path.join(resolveServiceDir(), probe.file);
  if (!fs.existsSync(probePath)) return false;
  return fs.statSync(probePath).size >= probe.minBytes;
}

export function isFFmpegPresent(): boolean {
  const ffmpeg = resolveFFmpegPath();
  return fs.existsSync(ffmpeg) && fs.statSync(ffmpeg).size > 1_000;
  // Note: system FFmpeg on macOS/Linux is checked implicitly — if neither
  // bundled path exists, Jellyfin falls back to searching PATH at spawn time.
}

// ── Port readiness probe ──────────────────────────────────────────────────────

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt  = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error',   () => {
        sock.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Jellyfin port ${port} not ready after ${timeoutMs / 1000}s`));
          return;
        }
        setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

// ── Raw HTTP helper (no auth — used during wizard) ────────────────────────────

async function jellyfinPost(endpoint: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${JELLYFIN_PORT}${endpoint}`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': DEVICE_HEADER,
    },
    body: JSON.stringify(body),
  });
}

async function jellyfinGet(endpoint: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${JELLYFIN_PORT}${endpoint}`, {
    headers: { 'Authorization': DEVICE_HEADER },
  });
}

// ── First-run wizard automation ───────────────────────────────────────────────
// /Startup/* endpoints require no auth. Must be completed before the server
// is usable. Called only when GET /System/Info/Public returns StartupWizardCompleted: false.
//
// Wizard sequence for 10.11:
//   1. POST /Startup/Configuration  — sets locale/metadata; seeds the initial user record
//   2. GET  /Startup/User           — retrieve the seeded user (poll until it exists)
//   3. POST /Startup/User           — set name + password on the seeded user
//   4. POST /Startup/RemoteAccess   — disable remote access
//   5. POST /Startup/Complete       — finalise wizard
//
// IMPORTANT: In 10.11, /Startup/Configuration seeds the initial user asynchronously.
// /Startup/User (POST) calls .First() on that user list — it throws "Sequence contains
// no elements" if called before the seed completes. We poll GET /Startup/User until
// it returns 200 to confirm the user record exists before patching it.

async function pollStartupUser(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await jellyfinGet('/Startup/User');
      if (r.ok) return; // user record is ready
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Timed out waiting for Jellyfin startup user record to be seeded');
}

async function runWizard(adminPassword: string): Promise<void> {
  console.log('[JellyfinManager] Running first-run wizard…');

  // Step 1: locale + metadata config; triggers async user seed in 10.11.
  let res = await jellyfinPost('/Startup/Configuration', {
    UICulture:                 'en-US',
    MetadataCountryCode:       'US',
    PreferredMetadataLanguage: 'en',
  });
  if (!res.ok) throw new Error(`Wizard /Startup/Configuration failed: HTTP ${res.status}`);

  // Step 2: wait for the seeded user record to exist before patching it.
  console.log('[JellyfinManager] Waiting for startup user seed…');
  await pollStartupUser();

  // Step 3: set the admin username and password.
  res = await jellyfinPost('/Startup/User', {
    Name:     'phobos',
    Password: adminPassword,
  });
  if (!res.ok) throw new Error(`Wizard /Startup/User failed: HTTP ${res.status}`);

  // Step 4: disable remote access — PHOBOS manages all external access.
  res = await jellyfinPost('/Startup/RemoteAccess', {
    EnableRemoteAccess:         false,
    EnableAutomaticPortMapping: false,
  });
  if (!res.ok) throw new Error(`Wizard /Startup/RemoteAccess failed: HTTP ${res.status}`);

  // Step 5: finalise — Jellyfin restarts its auth middleware after this.
  res = await jellyfinPost('/Startup/Complete', {});
  if (!res.ok) throw new Error(`Wizard /Startup/Complete failed: HTTP ${res.status}`);

  console.log('[JellyfinManager] Wizard complete.');
}

// ── Session authentication ────────────────────────────────────────────────────

async function authenticate(adminPassword: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${JELLYFIN_PORT}/Users/AuthenticateByName`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': DEVICE_HEADER,
    },
    body: JSON.stringify({ Username: 'phobos', Pw: adminPassword }),
  });
  if (!res.ok) {
    const detail = res.status === 401
      ? 'wrong password — the stored credential in ServiceStore may not match the running instance'
      : `HTTP ${res.status}`;
    throw new Error(`Jellyfin auth failed: ${detail}`);
  }

  const data = await res.json() as { AccessToken: string; User: { Id: string } };
  service.accessToken = data.AccessToken;
  service.userId      = data.User.Id;
  console.log(`[JellyfinManager] Authenticated. UserId=${service.userId}`);
}

// ── Detect wizard state and authenticate ──────────────────────────────────────
// The port opens before the configuration subsystem is fully ready — Jellyfin's
// setup wizard HTTP server starts first. Poll /System/Info/Public until it
// responds with a valid JSON body (not a 500 config-not-found error).

async function waitForSystemReady(timeoutMs = 120_000): Promise<{ StartupWizardCompleted: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let lastError  = 'timeout';

  while (Date.now() < deadline) {
    try {
      const res = await jellyfinGet('/System/Info/Public');
      if (res.ok) {
        const info = await res.json() as { StartupWizardCompleted: boolean };
        // A 200 with a valid boolean means the config subsystem is up.
        if (typeof info.StartupWizardCompleted === 'boolean') {
          return info;
        }
      }
      // 500 = config not ready yet (ResourceNotFoundException). Keep polling.
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
    await new Promise(r => setTimeout(r, 1_000));
  }

  throw new Error(`Jellyfin config subsystem not ready after ${timeoutMs / 1000}s (last error: ${lastError})`);
}

async function setupAfterBoot(adminPassword: string): Promise<void> {
  console.log('[JellyfinManager] Waiting for config subsystem…');
  const info = await waitForSystemReady();
  console.log(`[JellyfinManager] System ready. WizardCompleted=${info.StartupWizardCompleted}`);

  if (!info.StartupWizardCompleted) {
    await runWizard(adminPassword);
    // Jellyfin restarts its auth middleware after wizard completion.
    // Wait for it to come back up before authenticating.
    await new Promise(r => setTimeout(r, 2_000));
  }

  await authenticate(adminPassword);
}

// ── Config-change detection ───────────────────────────────────────────────────

function configChanged(cfg: JellyfinConfig): boolean {
  if (!service.config) return true;
  return (
    service.config.libraryPath   !== cfg.libraryPath   ||
    service.config.hardwareAccel !== cfg.hardwareAccel
  );
}

// ── Spawn ─────────────────────────────────────────────────────────────────────

function writeNetworkConfig(): void {
  const configDir = resolveConfigDir();
  fs.mkdirSync(configDir, { recursive: true });
  const networkXmlPath = path.join(configDir, 'network.xml');

  // Write network.xml to set port before first boot.
  // Jellyfin 10.9+ uses InternalHttpPort (not the old HttpServerPortNumber).
  // --port is not a valid CLI argument in 10.11.x.
  // This file is safe to overwrite on every spawn — Jellyfin reads it at start.
  const xml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<NetworkConfiguration xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">`,
    `  <InternalHttpPort>${JELLYFIN_PORT}</InternalHttpPort>`,
    `  <InternalHttpsPort>18920</InternalHttpsPort>`,
    `  <PublicHttpPort>${JELLYFIN_PORT}</PublicHttpPort>`,
    `  <PublicHttpsPort>18920</PublicHttpsPort>`,
    `  <EnableHttps>false</EnableHttps>`,
    `  <RequireHttps>false</RequireHttps>`,
    `  <EnableRemoteAccess>false</EnableRemoteAccess>`,
    `  <EnableUPnP>false</EnableUPnP>`,
    `  <AutoDiscovery>false</AutoDiscovery>`,
    `  <EnableIPv4>true</EnableIPv4>`,
    `  <EnableIPv6>false</EnableIPv6>`,
    `  <BaseUrl />`,
    `</NetworkConfiguration>`,
  ].join('\n');

  fs.writeFileSync(networkXmlPath, xml, 'utf8');
}

function spawnJellyfin(): void {
  const bin       = resolveBinaryPath();
  const dataDir   = resolveDataDir();
  const cacheDir  = resolveCacheDir();
  const configDir = resolveConfigDir();

  fs.mkdirSync(dataDir,   { recursive: true });
  fs.mkdirSync(cacheDir,  { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });

  // Write network.xml BEFORE spawning so the port is locked in on first boot.
  writeNetworkConfig();

  if (process.platform !== 'win32') {
    try { fs.chmodSync(bin, 0o755); } catch { /* non-fatal */ }
  }

  // Valid CLI args in 10.11.x: --datadir, --cachedir, --configdir, --logdir,
  // --ffmpeg, --nowebclient, --webdir, --published-server-url.
  // NOTE: --port does NOT exist — port is set exclusively via network.xml.
  const args = [
    '--nowebclient',
    '--datadir',    dataDir,
    '--cachedir',   cacheDir,
    '--configdir',  configDir,
  ];

  // Append ffmpeg only when the bundled binary is confirmed present.
  const ffmpegPath = resolveFFmpegPath();
  if (fs.existsSync(ffmpegPath)) {
    args.push('--ffmpeg', ffmpegPath);
  }

  const proc = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd:   resolveServiceDir(),
  });

  proc.stdout?.on('data', (d: Buffer) => {
    const l = d.toString().trim();
    if (l) console.log(`[jellyfin] ${l}`);
  });
  proc.stderr?.on('data', (d: Buffer) => {
    const l = d.toString().trim();
    if (l) console.log(`[jellyfin] ${l}`);
  });
  proc.on('exit', (code, signal) => {
    console.log(`[JellyfinManager] exited code=${code} signal=${signal}`);
    service.process     = null;
    service.accessToken = null;
    service.userId      = null;
    service.state       = code === 0 || signal === 'SIGTERM' ? 'stopped' : 'error';
    if (code !== 0 && code !== null && signal == null) {
      service.error = `Exited with code ${code}`;
    }
  });

  service.process = proc;
}

// ── Start (public) ────────────────────────────────────────────────────────────

export async function startJellyfin(cfg: JellyfinConfig, adminPassword: string): Promise<void> {
  if ((service.state === 'running' || service.state === 'starting') && !configChanged(cfg)) return;
  if (service.state === 'running' || service.state === 'starting') await stopJellyfin();

  if (!isBinaryPresent()) {
    service.state = 'error';
    service.error = 'Jellyfin binary not found. Run: node scripts/fetch-jellyfin.js';
    throw new Error(service.error);
  }

  service.config = { ...cfg };
  service.state  = 'starting';
  service.error  = null;

  try {
    spawnJellyfin();

    // 5-minute timeout covers first-run DB migration (library.db → jellyfin.db).
    // Subsequent boots are fast (~10–30s) but this timeout is constant — it is
    // a ceiling, not a delay.
    await waitForPort(JELLYFIN_PORT, 5 * 60 * 1000);
    await setupAfterBoot(adminPassword);

    if (cfg.hardwareAccel) {
      await applyHardwareAccel(cfg.hardwareAccel).catch(err =>
        console.warn('[JellyfinManager] HW accel config failed (non-fatal):', err.message)
      );
    }

    service.state = 'running';
    console.log(`[JellyfinManager] ready on :${JELLYFIN_PORT}`);

    // ensurePhobosLibrary runs after state = 'running' so the addLibrary guard passes.
    // Non-fatal — a library creation failure must not prevent Jellyfin from being usable.
    await ensurePhobosLibrary().catch(err =>
      console.warn('[JellyfinManager] ensurePhobosLibrary failed (non-fatal):', err.message)
    );
  } catch (err) {
    service.state = 'error';
    service.error = (err as Error).message;
    service.process?.kill();
    service.process = null;
    throw err;
  }
}

// ── Stop ──────────────────────────────────────────────────────────────────────

export async function stopJellyfin(): Promise<void> {
  if (service.state === 'stopped' && !service.process) return;

  if (service.process) {
    service.process.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const t = setTimeout(() => { service.process?.kill('SIGKILL'); resolve(); }, 10_000);
      service.process!.once('exit', () => { clearTimeout(t); resolve(); });
    });
    service.process = null;
  }

  service.state       = 'stopped';
  service.accessToken = null;
  service.userId      = null;
}

// ── Status ────────────────────────────────────────────────────────────────────

export interface JellyfinStatus {
  state:          'stopped' | 'starting' | 'running' | 'error';
  port:           number;
  error:          string | null;
  binaryPresent:  boolean;
  ffmpegPresent:  boolean;
  libraryPath:    string | null;
}

export function getJellyfinStatus(): JellyfinStatus {
  return {
    state:         service.state,
    port:          JELLYFIN_PORT,
    error:         service.error,
    binaryPresent: isBinaryPresent(),
    ffmpegPresent: isFFmpegPresent(),
    libraryPath:   service.config?.libraryPath ?? null,
  };
}

// ── Authenticated API request ─────────────────────────────────────────────────

export async function jellyfinApiRequest(
  method:   string,
  endpoint: string,
  body?:    unknown,
): Promise<Response> {
  if (service.state !== 'running') throw new Error('Jellyfin is not running');
  if (!service.accessToken)        throw new Error('Jellyfin not authenticated');

  return fetch(`http://127.0.0.1:${JELLYFIN_PORT}${endpoint}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `${DEVICE_HEADER}, Token="${service.accessToken}"`,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

// ── Library operations ────────────────────────────────────────────────────────

export async function triggerScan(): Promise<void> {
  if (service.state !== 'running') throw new Error('Jellyfin is not running');
  const res = await jellyfinApiRequest('POST', '/Library/Refresh');
  // 204 No Content is success; scan runs async.
  if (!res.ok) throw new Error(`Library scan trigger failed: HTTP ${res.status}`);
}

export interface JellyfinStats {
  movieCount:   number;
  seriesCount:  number;
  episodeCount: number;
  songCount:    number;
}

export async function getStats(): Promise<JellyfinStats> {
  if (service.state !== 'running') throw new Error('Jellyfin is not running');
  if (!service.userId)             throw new Error('Jellyfin not authenticated');

  const res = await jellyfinApiRequest('GET', `/Items/Counts?userId=${service.userId}`);
  if (!res.ok) throw new Error(`GET /Items/Counts failed: HTTP ${res.status}`);

  const data = await res.json() as {
    MovieCount?:   number;
    SeriesCount?:  number;
    EpisodeCount?: number;
    SongCount?:    number;
  };
  return {
    movieCount:   data.MovieCount   ?? 0,
    seriesCount:  data.SeriesCount  ?? 0,
    episodeCount: data.EpisodeCount ?? 0,
    songCount:    data.SongCount    ?? 0,
  };
}

// ── List libraries ────────────────────────────────────────────────────────────

export interface JellyfinLibrary {
  Name:           string;
  CollectionType: string;
  Locations:      string[];
  ItemId:         string;
}

export async function listLibraries(): Promise<JellyfinLibrary[]> {
  // Uses a direct fetch so it can be called during startup (state = 'starting')
  // as well as at runtime (state = 'running').
  if (!service.accessToken) throw new Error('Jellyfin not authenticated');
  const res = await fetch(`http://127.0.0.1:${JELLYFIN_PORT}/Library/VirtualFolders`, {
    headers: { 'Authorization': `${DEVICE_HEADER}, Token="${service.accessToken}"` },
  });
  if (!res.ok) throw new Error(`List libraries failed: HTTP ${res.status}`);
  return res.json() as Promise<JellyfinLibrary[]>;
}

// ── Ensure default Phobos library ─────────────────────────────────────────────
// Creates ~/.phobos/media/jellyfin/phobos/ as a 'homevideos' library named
// 'Phobos' if it does not already exist. This is the mandatory local storage
// directory for user-created content — always required, never removed.

async function ensurePhobosLibrary(): Promise<void> {
  const mediaPath = defaultMediaPath();
  fs.mkdirSync(mediaPath, { recursive: true });

  const libs = await listLibraries().catch(() => [] as JellyfinLibrary[]);
  const exists = libs.some(l => l.Locations.includes(mediaPath));
  if (exists) return;

  await addLibrary('Phobos', mediaPath, 'homevideos');
  console.log(`[JellyfinManager] Phobos library created at ${mediaPath}`);
}

/**
 * Add a virtual folder (library) to Jellyfin.
 * collectionType: 'movies' | 'tvshows' | 'music' | 'books' | 'homevideos' | 'photos' | 'mixed'
 */
export async function addLibrary(
  name:           string,
  folderPath:     string,
  collectionType: string,
): Promise<void> {
  if (service.state !== 'running') throw new Error('Jellyfin is not running');

  const res = await jellyfinApiRequest(
    'POST',
    `/Library/VirtualFolders?name=${encodeURIComponent(name)}&collectionType=${collectionType}`,
    {
      LibraryOptions: {
        PathInfos:             [{ Path: folderPath }],
        EnableRealtimeMonitor: true,
        MetadataSavers:        ['Nfo'],
      },
    },
  );
  if (!res.ok && res.status !== 204) {
    throw new Error(`Add library failed: HTTP ${res.status}`);
  }
}

// ── Hardware acceleration ─────────────────────────────────────────────────────
// VRAM is shared with LLM servers — only applied when explicitly configured.

async function applyHardwareAccel(accelType: string): Promise<void> {
  const res = await jellyfinApiRequest('POST', '/System/Configuration/Partial', {
    HardwareAccelerationEnabled: accelType !== '',
    HardwareAccelerationType:    accelType,
  });
  if (!res.ok) throw new Error(`HW accel config failed: HTTP ${res.status}`);
}

// ── Credential generation (used by ServiceStore on first creation) ─────────────

export function generateAdminPassword(): string {
  return crypto.randomBytes(24).toString('base64url');
}
