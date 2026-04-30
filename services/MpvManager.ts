/**
 * MpvManager.ts — Backend IPC bridge for mpv video player.
 *
 * Spawns a single mpv process in --idle mode and controls it via the
 * JSON IPC protocol over a Unix socket (Linux/macOS) or named pipe (Windows).
 * The frontend never talks to mpv directly — all control flows through
 * PHOBOS routes that call this module.
 *
 * mpv is not bundled — it must be installed on the system:
 *   Linux:   apt install mpv
 *   macOS:   brew install mpv
 *   Windows: winget install mpv  (or scoop install mpv)
 *
 * Port: none — mpv is a native OS window, not a network service.
 * IPC socket: ~/.phobos/mpv/mpv.sock (Linux/macOS)
 *             \\.\pipe\phobos-mpv    (Windows)
 *
 * Designed as a singleton — one mpv window at a time, matching the
 * PolarisPlayer floating widget pattern.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as net  from 'net';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';

// ── IPC socket path ───────────────────────────────────────────────────────────

const IPC_SOCKET = process.platform === 'win32'
  ? '\\\\.\\pipe\\phobos-mpv'
  : path.join(os.homedir(), '.phobos', 'mpv', 'mpv.sock');

// ── State ─────────────────────────────────────────────────────────────────────

interface PlayerState {
  process:  ChildProcess | null;
  socket:   net.Socket   | null;
  ready:    boolean;
  /** monotonically incrementing request ID for IPC replies */
  reqId:    number;
  /** pending reply resolvers keyed by request_id */
  pending:  Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  /** partial line buffer for IPC reads */
  lineBuf:  string;
}

const player: PlayerState = {
  process: null,
  socket:  null,
  ready:   false,
  reqId:   1,
  pending: new Map(),
  lineBuf: '',
};

// ── Types ─────────────────────────────────────────────────────────────────────

export type MpvState = 'stopped' | 'starting' | 'idle' | 'playing' | 'paused' | 'error';

export interface MpvStatus {
  state:      MpvState;
  available:  boolean;
  title:      string | null;
  duration:   number | null;
  position:   number | null;
  volume:     number | null;
  paused:     boolean;
}

let _state: MpvState   = 'stopped';
let _error: string | null = null;

// ── Portable binary resolution ────────────────────────────────────────────────
// mpv is not on the system PATH. It lives in ~/.phobos/services/mpv/ and is
// placed there by scripts/fetch-mpv.js / DepPrep at first boot.

const MPV_SERVICE_DIR = path.join(os.homedir(), '.phobos', 'services', 'mpv');

export function resolveMpvBin(): string {
  return path.join(MPV_SERVICE_DIR, process.platform === 'win32' ? 'mpv.exe' : 'mpv');
}

// ── mpv availability check ────────────────────────────────────────────────────
// Sync fs check — no process spawn. Safe to call on every status poll.

export function isMpvAvailable(): boolean {
  try {
    return fs.statSync(resolveMpvBin()).size > 1_000_000;
  } catch {
    return false;
  }
}

// ── IPC connection ────────────────────────────────────────────────────────────

function connectSocket(): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(IPC_SOCKET);

    sock.once('connect', () => {
      player.socket = sock;
      player.ready  = true;
      resolve();
    });

    sock.once('error', (err) => {
      reject(err);
    });

    sock.on('data', (chunk: Buffer) => {
      player.lineBuf += chunk.toString('utf8');
      const lines = player.lineBuf.split('\n');
      // Last element may be incomplete — keep it in the buffer.
      player.lineBuf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as Record<string, unknown>;
          if (typeof msg.request_id === 'number') {
            const entry = player.pending.get(msg.request_id);
            if (entry) {
              player.pending.delete(msg.request_id);
              if (msg.error === 'success') {
                entry.resolve(msg.data);
              } else {
                entry.reject(new Error(`mpv IPC error: ${msg.error}`));
              }
            }
          } else if (msg.event === 'property-change' && msg.name === 'core-idle') {
            // core-idle flips true when mpv finishes or fails to open a file.
            if (msg.data === true && (_state === 'playing' || _state === 'paused')) {
              _state = 'idle';
              console.log('[MpvManager] stream ended or failed to open (core-idle)');
            } else if (msg.data === false && _state === 'idle') {
              _state = 'playing';
            }
          } else if (msg.event === 'end-file') {
            if (msg.reason === 'error') {
              _state = 'idle';
              console.log(`[MpvManager] stream error: reason=${msg.reason} error=${msg.file_error ?? 'unknown'}`);
            }
          }
        } catch { /* malformed line — ignore */ }
      }
    });

    sock.on('close', () => {
      player.socket = null;
      player.ready  = false;
    });
  });
}

function waitForSocket(timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt  = () => {
      connectSocket()
        .then(resolve)
        .catch(() => {
          if (Date.now() > deadline) {
            reject(new Error(`mpv IPC socket not ready after ${timeoutMs}ms`));
            return;
          }
          setTimeout(attempt, 200);
        });
    };
    attempt();
  });
}

// ── IPC command ───────────────────────────────────────────────────────────────

function sendCommand(command: unknown[], timeoutMs = 5_000): Promise<unknown> {
  if (!player.socket || !player.ready) {
    return Promise.reject(new Error('mpv IPC not connected'));
  }

  const id  = player.reqId++;
  const msg = JSON.stringify({ command, request_id: id }) + '\n';

  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      player.pending.delete(id);
      reject(new Error(`mpv command timed out: ${JSON.stringify(command)}`));
    }, timeoutMs);

    player.pending.set(id, {
      resolve: (v) => { clearTimeout(t); resolve(v); },
      reject:  (e) => { clearTimeout(t); reject(e); },
    });

    player.socket!.write(msg);
  });
}

async function getProperty(prop: string): Promise<unknown> {
  return sendCommand(['get_property', prop]);
}

async function setProperty(prop: string, value: unknown): Promise<void> {
  await sendCommand(['set_property', prop, value]);
}

// ── Start / Stop ──────────────────────────────────────────────────────────────

export async function startMpv(): Promise<void> {
  if (_state === 'idle' || _state === 'playing' || _state === 'paused') return;
  if (_state === 'starting') return;

  if (!isMpvAvailable()) {
    _state = 'error';
    _error = `mpv binary not found at ${resolveMpvBin()}. Run: node scripts/fetch-mpv.js`;
    throw new Error(_error);
  }

  _state = 'starting';
  _error = null;

  // Ensure socket directory exists.
  if (process.platform !== 'win32') {
    fs.mkdirSync(path.dirname(IPC_SOCKET), { recursive: true });
    // Remove stale socket from a previous crash.
    try { fs.unlinkSync(IPC_SOCKET); } catch { /* non-existent — fine */ }
  }

  const ipcArg = process.platform === 'win32'
    ? `--input-ipc-server=${IPC_SOCKET}`
    : `--input-ipc-server=${IPC_SOCKET}`;

  const args = [
    '--idle',
    '--no-terminal',
    '--keep-open=yes',           // stay open after file ends
    '--force-window=yes',        // always open a window — audio-only streams won't silently vanish
    '--osd-level=1',
    '--load-unsafe-playlists',   // allow HLS/m3u8 playlists loaded via IPC (blocked by default)
    ipcArg,
  ];

  const proc = spawn(resolveMpvBin(), args, {
    stdio:       ['ignore', 'pipe', 'pipe'],
    cwd:         MPV_SERVICE_DIR,  // mpv must run from its own dir to resolve DLLs
    detached:    false,
    windowsHide: false,            // mpv renders its own window — must be visible
  });

  proc.stdout?.on('data', (d: Buffer) => {
    const l = d.toString().trim();
    if (l) console.log(`[mpv] ${l}`);
  });
  proc.stderr?.on('data', (d: Buffer) => {
    const l = d.toString().trim();
    if (l) console.log(`[mpv] ${l}`);
  });
  proc.on('exit', (code, signal) => {
    console.log(`[MpvManager] exited code=${code} signal=${signal}`);
    player.process = null;
    player.socket  = null;
    player.ready   = false;
    player.pending.clear();
    _state = code === 0 || signal === 'SIGTERM' ? 'stopped' : 'error';
    if (code !== 0 && code !== null && signal == null) {
      _error = `mpv exited with code ${code}`;
    }
  });

  player.process = proc;

  try {
    await waitForSocket(15_000);
    _state = 'idle';
    // Subscribe to playback events so _state tracks reality, not optimism.
    await sendCommand(['observe_property', 1, 'core-idle']);
    await sendCommand(['enable_event', 'end-file']);
    console.log('[MpvManager] IPC ready.');
  } catch (err) {
    _state = 'error';
    _error = (err as Error).message;
    proc.kill();
    player.process = null;
    throw err;
  }
}

export async function stopMpv(): Promise<void> {
  if (!player.process) return;

  if (player.socket) {
    try { await sendCommand(['quit']); } catch { /* mpv may already be closing */ }
    player.socket.destroy();
    player.socket = null;
    player.ready  = false;
  }

  await new Promise<void>(resolve => {
    const t = setTimeout(() => { player.process?.kill('SIGKILL'); resolve(); }, 5_000);
    player.process!.once('exit', () => { clearTimeout(t); resolve(); });
  });
  player.process = null;
  _state = 'stopped';
}

// ── Playback control ──────────────────────────────────────────────────────────

// Default UA — accepted by most CDNs that block empty or curl-like user agents.
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface LoadOptions {
  userAgent: string | null;
  referrer:  string | null;
}

/**
 * Load a file or URL. Starts mpv if not already running.
 * url can be a filesystem path or any URL mpv supports (HLS, HTTP, etc.)
 *
 * user-agent and referrer are passed as per-file options in the loadfile
 * IPC command (4th arg) so they apply to HLS segment fetches, not just
 * the manifest request.
 */
export async function loadFile(url: string, opts: LoadOptions = { userAgent: null, referrer: null }): Promise<void> {
  if (_state === 'stopped' || _state === 'error') await startMpv();

  const ua = opts.userAgent ?? DEFAULT_UA;
  const perFileOpts: Record<string, string> = { 'user-agent': ua };
  if (opts.referrer) perFileOpts['referrer'] = opts.referrer;

  // loadfile signature (mpv ≥ 0.38): [url, flags, index, {options}]
  // index = -1 means "don't use insert-at, just replace" — required placeholder
  // when passing per-file options as the 4th argument.
  await sendCommand(['loadfile', url, 'replace', -1, perFileOpts]);
  _state = 'playing';
}

export async function play(): Promise<void> {
  if (!player.ready) throw new Error('mpv not running');
  await setProperty('pause', false);
  _state = 'playing';
}

export async function pause(): Promise<void> {
  if (!player.ready) throw new Error('mpv not running');
  await setProperty('pause', true);
  _state = 'paused';
}

export async function togglePause(): Promise<void> {
  if (!player.ready) throw new Error('mpv not running');
  await sendCommand(['cycle', 'pause']);
}

export async function seek(seconds: number): Promise<void> {
  if (!player.ready) throw new Error('mpv not running');
  await sendCommand(['seek', seconds, 'absolute']);
}

export async function setVolume(level: number): Promise<void> {
  if (!player.ready) throw new Error('mpv not running');
  // mpv volume is 0–100 by default, can go to 130.
  await setProperty('volume', Math.max(0, Math.min(130, level)));
}

export async function fullscreen(enable: boolean): Promise<void> {
  if (!player.ready) throw new Error('mpv not running');
  await setProperty('fullscreen', enable);
}

export async function stop(): Promise<void> {
  if (!player.ready) return;
  await sendCommand(['stop']);
  _state = 'idle';
}

// ── Status query ──────────────────────────────────────────────────────────────

export async function getMpvStatus(): Promise<MpvStatus> {
  const available = isMpvAvailable();

  if (!player.ready) {
    return { state: _state, available, title: null, duration: null, position: null, volume: null, paused: false };
  }

  try {
    const [title, duration, position, volume, paused] = await Promise.all([
      getProperty('media-title').catch(() => null),
      getProperty('duration').catch(() => null),
      getProperty('time-pos').catch(() => null),
      getProperty('volume').catch(() => null),
      getProperty('pause').catch(() => false),
    ]);

    const isPaused = Boolean(paused);
    if (_state === 'playing' && isPaused) _state = 'paused';
    if (_state === 'paused'  && !isPaused) _state = 'playing';

    return {
      state:    _state,
      available,
      title:    typeof title    === 'string' ? title    : null,
      duration: typeof duration === 'number' ? duration : null,
      position: typeof position === 'number' ? position : null,
      volume:   typeof volume   === 'number' ? volume   : null,
      paused:   isPaused,
    };
  } catch {
    return { state: _state, available, title: null, duration: null, position: null, volume: null, paused: false };
  }
}