/**
 * CarlaManager.ts — Lifecycle manager for the Carla headless VST host.
 *
 * Binary:   ~/.phobos/services/carla/<Carla executable>
 * Project:  ~/.phobos/services/carla/phobos-rack.carxp (generated on first start)
 * Plugins:  ~/.phobos/services/carla/plugins/
 *
 * OSC control:  UDP 127.0.0.1:16331
 *
 * Lifecycle:
 *   - Lazy-start: Carla is not spawned at PHOBOS boot. ensureRunning() spawns
 *     it on the first audio API request and leaves it running.
 *   - Stopped in PHASE 3 of server.ts shutdown (after DB close).
 *
 * Hot-path guarantees:
 *   - OSC messages use the pre-allocated buffer inside OscClient (no alloc).
 *   - Preset diff is performed once and emits minimal OSC (no full resend).
 *   - No allocations inside the preset-switch loop beyond the OscClient
 *     send buffer (reused per message).
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';

import { OscClient } from './OscClient.js';
import { EffectRackStore, EffectPreset } from '../db/EffectRackStore.js';

// ── Wire constants ────────────────────────────────────────────────────────────

export const CARLA_OSC_PORT = 16331;
export const CARLA_OSC_HOST = '127.0.0.1';

export const PLUGIN_IDX_HELM    = 0;
export const PLUGIN_IDX_SURGE   = 1;
export const PLUGIN_IDX_CRYSTAL = 2;

const PLUGIN_KEY_TO_IDX: Record<string, number> = {
  helm:    PLUGIN_IDX_HELM,
  surge:   PLUGIN_IDX_SURGE,
  crystal: PLUGIN_IDX_CRYSTAL,
};

const READY_TIMEOUT_MS   = 30_000;
const READY_PROBE_MS     = 500;
const SHUTDOWN_GRACE_MS  = 5_000;

// ── Paths ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the user's home directory honoring HOME/USERPROFILE at call time.
 *
 * Node's os.homedir() caches the result from system calls made at startup
 * and does NOT re-read HOME/USERPROFILE afterwards. Test harnesses that
 * override those env vars to redirect a scratch install must therefore get
 * a function that re-reads every time. We prefer USERPROFILE on Windows
 * and HOME elsewhere, falling back to os.homedir() for production paths.
 */
function resolveHome(): string {
  if (process.platform === 'win32') {
    return process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
  }
  return process.env.HOME ?? os.homedir();
}

export function resolveServiceDir(): string {
  return path.join(resolveHome(), '.phobos', 'services', 'carla');
}

export function resolvePluginsDir(): string {
  return path.join(resolveServiceDir(), 'plugins');
}

export function resolveProjectPath(): string {
  return path.join(resolveServiceDir(), 'phobos-rack.carxp');
}

/**
 * Locate the Carla binary per platform. Scans the service directory tree
 * because Carla zip layouts differ between versions:
 *   v2.5.10 Windows: <root>/Carla-2.5.10-win64/Carla/Carla.exe
 *   older       Windows: <root>/Carla/Carla.exe
 *   macOS universal:   <root>/Carla.app/Contents/MacOS/Carla
 *   Linux tarball:     <root>/Carla/Carla  (or Carla-<ver>-linux64/Carla/Carla)
 *
 * Walks up to 6 directories deep, which is always more than enough.
 */
export function resolveBinaryPath(): string {
  const root = resolveServiceDir();
  const targetName =
    process.platform === 'win32'  ? 'Carla.exe' :
    process.platform === 'darwin' ? 'Carla'     :  // inside Carla.app/Contents/MacOS
                                    'Carla';       // Linux standalone

  const queue: string[] = [root];
  const MAX_DEPTH = 6;
  const seen = new Set<string>();

  while (queue.length > 0) {
    const dir = queue.shift()!;
    if (seen.has(dir)) continue;
    seen.add(dir);

    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }

    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.name === targetName && ent.isFile()) {
        // On macOS, require the match to live inside a Carla.app bundle.
        if (process.platform === 'darwin' && !full.includes('Carla.app')) continue;
        return full;
      }
      if (ent.isDirectory()) {
        const depth = full.slice(root.length).split(path.sep).filter(Boolean).length;
        if (depth <= MAX_DEPTH) queue.push(full);
      }
    }
  }

  // Fallback — return a predictable path for error messages even when
  // nothing was found. isBinaryPresent() will return false in that case.
  if (process.platform === 'win32')  return path.join(root, 'Carla.exe');
  if (process.platform === 'darwin') return path.join(root, 'Carla.app', 'Contents', 'MacOS', 'Carla');
  return path.join(root, 'Carla');
}

export function isBinaryPresent(): boolean {
  // Size threshold is intentionally low — Carla.exe on Windows is a small
  // Qt launcher (~100–500 KB) that depends on adjacent DLLs for the heavy
  // lifting. Anything under 50 KB is a truncated download or stub.
  try { return fs.statSync(resolveBinaryPath()).size > 50_000; }
  catch { return false; }
}

// ── Service state ─────────────────────────────────────────────────────────────

export type CarlaState = 'stopped' | 'starting' | 'running' | 'preset_switching' | 'error';

interface ManagedCarla {
  state:        CarlaState;
  process:      ChildProcess | null;
  osc:          OscClient | null;
  activePreset: EffectPreset | null;
  error:        string | null;
  startedAt:    number | null;
}

const service: ManagedCarla = {
  state:        'stopped',
  process:      null,
  osc:          null,
  activePreset: null,
  error:        null,
  startedAt:    null,
};

let _store: EffectRackStore | null = null;

/**
 * Register the EffectRackStore instance the manager will use for preset
 * lookup. Called once at server startup from server.ts.
 */
export function setEffectRackStore(store: EffectRackStore): void {
  _store = store;
}

// ── Project file preparation ──────────────────────────────────────────────────

/**
 * Generate the concrete phobos-rack.carxp from the template bundled in the
 * repo, substituting __PLUGINS_DIR__ for the absolute plugins directory.
 *
 * Only written on first start; subsequent boots reuse the existing file.
 */
function ensureProjectFile(): void {
  const dest = resolveProjectPath();
  if (fs.existsSync(dest)) return;

  const template = resolveBundledTemplatePath();
  const src = fs.readFileSync(template, 'utf8');
  const withPaths = src.replace(/__PLUGINS_DIR__/g, escapeForXml(resolvePluginsDir()));

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, withPaths, 'utf8');
}

function resolveBundledTemplatePath(): string {
  // Path resolution must work in two environments:
  //   1. esbuild CJS bundle (production server) — __dirname is provided natively.
  //   2. tsx ESM dev/test    (e.g. test-audio-daw.ts) — __dirname is undefined.
  //
  // We can't write `import.meta.url` here because the CJS bundle target
  // strips it. Instead we guard __dirname access behind a typeof check; in
  // the ESM case we fall through to the cwd-relative candidates which are
  // always populated when the harness runs from the repo root.
  const candidates: string[] = [];

  // CJS-only: __dirname-relative lookup.
  // typeof guard means the reference is dead code in ESM — no eval-time error.
  if (typeof __dirname !== 'undefined') {
    candidates.push(path.resolve(__dirname, 'carla-rack', 'phobos-rack.carxp'));
  }

  candidates.push(
    path.resolve(path.dirname(process.execPath), 'phobos', 'carla-rack', 'phobos-rack.carxp'),
    path.resolve(process.cwd(), 'phobos', 'carla-rack', 'phobos-rack.carxp'),
    path.resolve(process.cwd(), 'dist', 'phobos', 'carla-rack', 'phobos-rack.carxp'),
  );

  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`Cannot locate phobos-rack.carxp template. Searched:\n${candidates.join('\n')}`);
}

function escapeForXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Readiness probe ───────────────────────────────────────────────────────────

/**
 * Carla's OSC surface is a UDP listener — there is no TCP port to connect to.
 * Instead we send a benign query message and consider Carla ready when the
 * process has been alive for a short settle period without exiting.
 */
function waitForReadiness(proc: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let settled = false;

    proc.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Carla exited before ready: code=${code} signal=${signal}`));
    });

    const check = () => {
      if (settled) return;
      if (!proc.pid) {
        setTimeout(check, READY_PROBE_MS);
        return;
      }
      // Small settle — Carla takes 1–3s to initialize its audio engine on most
      // platforms. After 2s of the process being alive, we trust it.
      const settleMs = 2_000;
      setTimeout(() => {
        if (settled) return;
        if (!proc.exitCode && proc.pid) {
          settled = true;
          resolve();
        } else if (Date.now() > deadline) {
          settled = true;
          reject(new Error(`Carla readiness timeout after ${timeoutMs}ms`));
        } else {
          setTimeout(check, READY_PROBE_MS);
        }
      }, settleMs);
    };

    check();
  });
}

// ── Spawn / stop ──────────────────────────────────────────────────────────────

interface StartOptions {
  /** Force the 'Dummy' engine — no audio output. Used by test-audio-daw.ts. */
  silent?: boolean;
  /** Audio driver override: 'DirectSound' | 'WASAPI' | 'ASIO' | 'CoreAudio' | 'ALSA' | 'Dummy'. */
  driver?: string;
}

export async function ensureRunning(opts: StartOptions = {}): Promise<void> {
  if (service.state === 'running' || service.state === 'preset_switching') return;
  if (service.state === 'starting') {
    // Another caller is already starting. Poll until state settles.
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (service.state === 'running') return resolve();
        if (service.state === 'error')   return reject(new Error(service.error ?? 'Carla start failed'));
        if (Date.now() - t0 > READY_TIMEOUT_MS) return reject(new Error('Timeout waiting for Carla start'));
        setTimeout(tick, 200);
      };
      tick();
    });
    return;
  }

  if (!isBinaryPresent()) {
    service.state = 'error';
    service.error = 'Carla binary not found. Run: node scripts/fetch-carla.js';
    throw new Error(service.error);
  }

  service.state = 'starting';
  service.error = null;

  try {
    ensureProjectFile();

    const bin  = resolveBinaryPath();
    const proj = resolveProjectPath();
    const args: string[] = [];

    if (opts.silent) {
      // Use Carla's dummy engine for silent validation runs.
      args.push('--engine=Dummy');
    } else if (opts.driver) {
      args.push(`--engine=${opts.driver}`);
    }
    args.push(proj);

    const env = { ...process.env };
    // Make sure Carla can find plugins. VST3_PATH is the standard env var.
    const pluginsDir = resolvePluginsDir();
    env['VST3_PATH'] = env['VST3_PATH'] ? `${pluginsDir}${path.delimiter}${env['VST3_PATH']}` : pluginsDir;

    if (process.platform !== 'win32') {
      try { fs.chmodSync(bin, 0o755); } catch { /* non-fatal */ }
    }

    const proc = spawn(bin, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false,
      cwd: resolveServiceDir(),
    });

    proc.stdout?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log(`[carla] ${line}`);
    });
    proc.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) console.log(`[carla] ${line}`);
    });
    proc.on('exit', (code, signal) => {
      console.log(`[CarlaManager] exited code=${code} signal=${signal}`);
      service.process     = null;
      service.osc?.close();
      service.osc          = null;
      service.activePreset = null;
      service.startedAt    = null;
      service.state        = (code === 0 || signal === 'SIGTERM') ? 'stopped' : 'error';
      if (code !== 0 && code !== null && signal == null) {
        service.error = `Carla exited with code ${code}`;
      }
    });

    service.process = proc;

    await waitForReadiness(proc, READY_TIMEOUT_MS);

    service.osc       = new OscClient({ host: CARLA_OSC_HOST, port: CARLA_OSC_PORT });
    service.state     = 'running';
    service.startedAt = Date.now();
    console.log(`[CarlaManager] ready — OSC 127.0.0.1:${CARLA_OSC_PORT}`);
  } catch (err) {
    service.state = 'error';
    service.error = (err as Error).message;
    if (service.process) {
      try { service.process.kill('SIGKILL'); } catch { /* ignore */ }
      service.process = null;
    }
    throw err;
  }
}

export async function stopCarla(): Promise<void> {
  if (service.state === 'stopped' && !service.process) return;

  const proc = service.process;
  if (proc) {
    // Windows: kill the whole tree. Unix: SIGTERM then SIGKILL.
    if (process.platform === 'win32' && proc.pid !== undefined) {
      await killWindowsTree(proc.pid);
    } else {
      proc.kill('SIGTERM');
      await new Promise<void>(resolve => {
        const t = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, SHUTDOWN_GRACE_MS);
        proc.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
  }

  service.process      = null;
  service.osc?.close();
  service.osc          = null;
  service.activePreset = null;
  service.state        = 'stopped';
  service.error        = null;
  service.startedAt    = null;
}

function killWindowsTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const tk = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
    tk.on('close', () => resolve());
    tk.on('error', () => resolve());
  });
}

// ── OSC operations ────────────────────────────────────────────────────────────

function requireOsc(): OscClient {
  if (!service.osc || service.state !== 'running') {
    throw new Error(`Carla is not running (state=${service.state})`);
  }
  return service.osc;
}

/**
 * Set a plugin parameter directly by Carla plugin index + Carla parameter id.
 */
export function setParam(pluginIdx: number, paramId: number, value: number): void {
  requireOsc().setParam(pluginIdx, paramId, value);
}

export function noteOn(pluginIdx: number, channel: number, note: number, velocity: number): void {
  requireOsc().noteOn(pluginIdx, channel, note, velocity);
}

export function noteOff(pluginIdx: number, channel: number, note: number): void {
  requireOsc().noteOff(pluginIdx, channel, note);
}

export function setProgram(pluginIdx: number, programIdx: number): void {
  requireOsc().setProgram(pluginIdx, programIdx);
}

/**
 * Show or hide the plugin's native custom UI. Carla opens the plugin's editor
 * window as a separate OS-level window. Only meaningful for plugins that
 * expose a custom UI (Crystal, Surge XT do; Helm does).
 */
export function showPluginUi(pluginIdx: number, show: boolean): void {
  requireOsc().showCustomUi(pluginIdx, show);
}

/**
 * Bypass/activate a plugin in the rack. When active = false the plugin is
 * bypassed (audio passes through untouched); when true it processes audio.
 */
export function setPluginActive(pluginIdx: number, active: boolean): void {
  requireOsc().setActive(pluginIdx, active);
}

/**
 * Activate an effect preset by id. Diffs against the currently-active preset
 * and sends OSC only for changed parameters. Stores the activated preset as
 * the new baseline.
 */
export async function activatePreset(id: string): Promise<void> {
  if (!_store) throw new Error('EffectRackStore not registered. Call setEffectRackStore() at startup.');
  if (service.state !== 'running' && service.state !== 'preset_switching') {
    await ensureRunning();
  }

  const next = await _store.get(id);
  if (!next) throw new Error(`No preset with id "${id}"`);

  const prev = service.activePreset;
  service.state = 'preset_switching';

  try {
    const changes = EffectRackStore.diff(prev, next);
    const osc = requireOsc();
    for (const c of changes) {
      const pluginIdx = PLUGIN_KEY_TO_IDX[c.pluginKey];
      if (pluginIdx === undefined) continue;                   // unknown plugin key — skip
      const paramId = parseInt(c.paramId, 10);
      if (Number.isNaN(paramId)) continue;
      osc.setParam(pluginIdx, paramId, c.value);
    }
    service.activePreset = next;
  } finally {
    service.state = 'running';
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

export interface CarlaStatus {
  state:          CarlaState;
  pid:            number | null;
  port:           number;
  uptimeMs:       number | null;
  activePresetId: string | null;
  error:          string | null;
  binaryPresent:  boolean;
}

export function getStatus(): CarlaStatus {
  return {
    state:          service.state,
    pid:            service.process?.pid ?? null,
    port:           CARLA_OSC_PORT,
    uptimeMs:       service.startedAt ? Date.now() - service.startedAt : null,
    activePresetId: service.activePreset?.id ?? null,
    error:          service.error,
    binaryPresent:  isBinaryPresent(),
  };
}
