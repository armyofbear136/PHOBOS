import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  makeManagedProcess,
  spawnProcess,
  stopProcess,
  type ManagedProcess,
} from './SubprocessManager.js';

// ── Ports — permanent wire contract ──────────────────────────────────────────
export const BROADWAY_HTTP_PORT = 8080;   // broadwayd HTTP frontend → proxy through PHOBOS
export const BROADWAY_BIN_PORT  = 9090;   // broadwayd binary protocol → GTK3 apps

// ── Platform paths ────────────────────────────────────────────────────────────
const MSYS2_UCRT = 'C:/msys64/ucrt64/bin';

// MSYS2 bash shell — inherits full MSYS2 runtime environment including DLL
// search paths that GIMP depends on. Direct spawn of gimp.exe from Node.js
// misses these, causing a divide-by-zero in GDK's monitor resolution probe.
// IMPORTANT: paths inside bash commands must use MSYS2 Unix syntax (/c/... not C:/...)
const MSYS2_BASH     = 'C:/msys64/usr/bin/bash.exe';
const MSYS2_UCRT_SH  = '/c/msys64/ucrt64/bin';   // Unix-style path for inside bash commands

const PLATFORM_CONFIG = {
  win32: {
    broadwaydPath: MSYS2_BASH,
    broadwaydArgs: [
      '--noprofile', '--norc', '-c',
      // Set PATH explicitly so ucrt64 bins are found.
      // No --port flag — matches the confirmed working session 26 launch.
      `export PATH=${MSYS2_UCRT_SH}:/usr/bin:/c/msys64/usr/bin:$PATH && ${MSYS2_UCRT_SH}/broadwayd.exe`,
    ],
    // Launch GIMP through bash so the full MSYS2 runtime environment is
    // inherited — DLL search paths, locale, GTK/GDK env all set correctly.
    gimpPath:      MSYS2_BASH,
    gimpArgs:      [
      '--noprofile', '--norc', '-c',
      // No quotes around PATH value — Windows argument passing strips them.
      // Use colon-separated paths without spaces so no quoting is needed.
      `export PATH=${MSYS2_UCRT_SH}:/usr/bin:/c/msys64/usr/bin:$PATH && ${MSYS2_UCRT_SH}/gimp.exe --no-splash --no-shm`,
    ],
    // Windows PATH must include MSYS2 ucrt64 so the DLL loader finds all
    // GIMP/GTK shared libraries. Bash's internal PATH export is not enough —
    // Windows DLL loading uses the Windows PATH, not the bash environment.
    gimpEnv: {
      PATH: `C:\\msys64\\ucrt64\\bin;C:\\msys64\\usr\\bin;${process.env.PATH ?? ''}`,
      GDK_BACKEND:      'broadway',
      BROADWAY_DISPLAY: ':tcp0',
      GDK_SCALE:        '1',
      GDK_DPI_SCALE:    '1',
    },
    broadwaydEnv: {
      PATH: `C:\\msys64\\ucrt64\\bin;C:\\msys64\\usr\\bin;${process.env.PATH ?? ''}`,
      GDK_BACKEND: 'broadway',
    },
  },
  linux: {
    broadwaydPath: '/usr/bin/broadwayd',
    broadwaydArgs: [':0'],
    gimpPath:      '/usr/bin/gimp',
    gimpArgs:      ['--no-splash'],
    gimpEnv: {
      GDK_BACKEND:      'broadway',
      BROADWAY_DISPLAY: ':0',
    },
    broadwaydEnv: {} as Record<string, string>,
  },
  darwin: {
    // macOS v1 — native launch only, no Broadway
    broadwaydPath: null as string | null,
    broadwaydArgs: [] as string[],
    gimpPath:      '/Applications/GIMP.app/Contents/MacOS/gimp',
    gimpArgs:      [] as string[],
    gimpEnv:       {} as Record<string, string>,
    broadwaydEnv:  {} as Record<string, string>,
  },
} as const;

type Platform = keyof typeof PLATFORM_CONFIG;

function getPlatformConfig() {
  const p = process.platform as Platform;
  if (!(p in PLATFORM_CONFIG)) {
    throw new Error(`Unsupported platform: ${p}`);
  }
  return PLATFORM_CONFIG[p];
}

// ── Singleton state ───────────────────────────────────────────────────────────

const broadwayd: ManagedProcess = makeManagedProcess({
  cmd:             '',
  args:            [],
  port:            BROADWAY_BIN_PORT,
  readyTimeoutMs:  15_000,
});

const gimp: ManagedProcess = makeManagedProcess({
  cmd:             '',
  args:            [],
  startupDelayMs:  15_000,  // GIMP has no probe-able signal — wait 15s for full paint
  readyTimeoutMs:  45_000,
});

// ── Status shape ──────────────────────────────────────────────────────────────

export interface BroadwayStatus {
  broadwayd: {
    state:     ManagedProcess['state'];
    httpPort:  number;
    binPort:   number;
    error:     string | null;
  };
  gimp: {
    state: ManagedProcess['state'];
    error: string | null;
  };
  platform:  string;
  iframeUrl: string | null;
}

export function getBroadwayStatus(): BroadwayStatus {
  return {
    broadwayd: {
      state:    broadwayd.state,
      httpPort: BROADWAY_HTTP_PORT,
      binPort:  BROADWAY_BIN_PORT,
      error:    broadwayd.error,
    },
    gimp: {
      state: gimp.state,
      error: gimp.error,
    },
    platform:  process.platform,
    iframeUrl: broadwayd.state === 'running'
      ? `http://127.0.0.1:${BROADWAY_HTTP_PORT}`
      : null,
  };
}

// ── Availability checks ───────────────────────────────────────────────────────

export function isBroadwaydPresent(): boolean {
  if (process.platform === 'win32') {
    // On Windows we launch via bash.exe — check both the shell and broadwayd binary
    return fs.existsSync(MSYS2_BASH) && fs.existsSync(path.join(MSYS2_UCRT, 'broadwayd.exe'));
  }
  const cfg = getPlatformConfig();
  if (!cfg.broadwaydPath) return false;
  return fs.existsSync(cfg.broadwaydPath);
}

export function isGimpPresent(): boolean {
  if (process.platform === 'win32') {
    return fs.existsSync(MSYS2_BASH) && fs.existsSync(path.join(MSYS2_UCRT, 'gimp.exe'));
  }
  const cfg = getPlatformConfig();
  return fs.existsSync(cfg.gimpPath);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Establish a phantom WebSocket connection to broadwayd so it allocates a
 * real display canvas with non-zero dimensions before GIMP starts.
 *
 * Broadway's display dimensions are set when the first WebSocket client
 * connects and sends a size message. Without this, broadwayd reports 0×0,
 * GIMP's icon scaling receives width=0, and gdk_pixbuf asserts and crashes.
 *
 * The phantom connection stays open for the lifetime of the GIMP process,
 * keeping the display alive even when no real browser is connected.
 */
let phantomSocket: import('net').Socket | null = null;

async function connectPhantomBrowser(width = 1920, height = 1080): Promise<void> {
  console.log('[BroadwayManager] connecting phantom browser to Broadway...');

  // Broadway uses a raw WebSocket (not HTTP upgrade). We connect to the binary
  // protocol port (9090) directly with the Broadway handshake.
  // The Broadway 2.0 protocol: client sends a size message immediately on connect.
  // Message format (binary, big-endian):
  //   byte 0:   'S' (0x53) — size message type
  //   bytes 1-4: width  (uint32 big-endian)
  //   bytes 5-8: height (uint32 big-endian)

  return new Promise((resolve) => {
    const net = require('net') as typeof import('net');

    const sock = net.connect(BROADWAY_BIN_PORT, '127.0.0.1', () => {
      // Send Broadway size message: 'S' + width (4 bytes BE) + height (4 bytes BE)
      const msg = Buffer.alloc(9);
      msg.writeUInt8(0x53, 0);                   // 'S'
      msg.writeUInt32BE(width,  1);
      msg.writeUInt32BE(height, 5);
      sock.write(msg);
      console.log(`[BroadwayManager] phantom browser connected — display set to ${width}×${height}`);
      phantomSocket = sock;
      resolve();
    });

    sock.once('error', (err) => {
      console.warn(`[BroadwayManager] phantom browser error: ${err.message}`);
      phantomSocket = null;
      resolve(); // non-fatal — continue anyway
    });

    sock.on('close', () => {
      phantomSocket = null;
      // If broadwayd is still running, reconnect the phantom so broadwayd
      // doesn't lose its only client and crash with the assertion error.
      if (broadwayd.state === 'running') {
        setTimeout(() => {
          if (broadwayd.state === 'running' && !phantomSocket) {
            console.log('[BroadwayManager] phantom browser reconnecting...');
            connectPhantomBrowser().catch(() => {});
          }
        }, 500);
      }
    });

    // Swallow all incoming Broadway events — we don't process them
    sock.on('data', () => {});
  });
}

function disconnectPhantomBrowser(): void {
  if (phantomSocket) {
    phantomSocket.destroy();
    phantomSocket = null;
  }
}

/**
 * Phase 1: Start broadwayd only and return immediately.
 * The caller (GimpPanel) renders the iframe to establish a real browser
 * connection, then calls startGimp() once the iframe has loaded.
 */
export async function startBroadwayd(): Promise<void> {
  if (process.platform === 'darwin') return; // no broadwayd on macOS

  const cfg = getPlatformConfig() as typeof PLATFORM_CONFIG['win32'] | typeof PLATFORM_CONFIG['linux'];

  if (!isBroadwaydPresent()) {
    throw new Error(`broadwayd not found — install via MSYS2: pacman -S mingw-w64-ucrt-x86_64-gtk3`);
  }

  if (broadwayd.state === 'running' || broadwayd.state === 'starting') {
    console.log('[BroadwayManager] broadwayd already running — skipping');
    return;
  }

  // Kill any orphaned processes from a previous session before starting fresh.
  // On Windows these survive across restarts if taskkill wasn't called cleanly.
  if (process.platform === 'win32') {
    const { spawn: spawnRaw } = require('child_process') as typeof import('child_process');
    await new Promise<void>(resolve => {
      const tk = spawnRaw('taskkill', ['/F', '/IM', 'broadwayd.exe', '/T'],
        { stdio: 'ignore', windowsHide: true });
      tk.on('close', () => resolve());
      tk.on('error', () => resolve());
    });
    await new Promise<void>(resolve => {
      const tk = spawnRaw('taskkill', ['/F', '/IM', 'gimp.exe', '/T'],
        { stdio: 'ignore', windowsHide: true });
      tk.on('close', () => resolve());
      tk.on('error', () => resolve());
    });
    // Brief wait for ports to release after kill
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  broadwayd.state = 'starting';
  console.log('[BroadwayManager] starting broadwayd...');
  await spawnProcess(
    broadwayd,
    {
      cmd:            cfg.broadwaydPath,
      args:           [...cfg.broadwaydArgs],
      env:            { ...cfg.broadwaydEnv },
      port:           BROADWAY_BIN_PORT,
      readyTimeoutMs: 15_000,
    },
    'broadwayd',
  );
  console.log(`[BroadwayManager] broadwayd ready — binary :${BROADWAY_BIN_PORT}, HTTP :${BROADWAY_HTTP_PORT}`);
}

/**
 * Phase 2: Start GIMP after the browser iframe has connected to broadwayd.
 * Must only be called after the frontend has loaded the Broadway iframe —
 * broadwayd needs a real browser connection with non-zero canvas dimensions
 * before GIMP renders its UI, otherwise icon scaling crashes with width=0.
 */
export async function startGimp(): Promise<void> {
  if (process.platform === 'darwin') {
    await startGimpNative();
    return;
  }

  const cfg = getPlatformConfig() as typeof PLATFORM_CONFIG['win32'] | typeof PLATFORM_CONFIG['linux'];

  if (!isGimpPresent()) {
    throw new Error(`GIMP not found — install via MSYS2: pacman -S mingw-w64-ucrt-x86_64-gimp`);
  }

  if (broadwayd.state !== 'running') {
    throw new Error('broadwayd is not running — call startBroadwayd() first');
  }

  if (gimp.state === 'running' || gimp.state === 'starting') {
    console.log('[BroadwayManager] GIMP already running — skipping');
    return;
  }

  // Connect phantom browser to give broadwayd a real display with dimensions.
  // This must happen before GIMP starts — it sets the canvas size that GIMP
  // reads when loading its icon set. Without it the display is 0×0 and GIMP crashes.
  await connectPhantomBrowser();

  gimp.state = 'starting';
  console.log('[BroadwayManager] starting GIMP...');

  await spawnProcess(
    gimp,
    {
      cmd:            cfg.gimpPath,
      args:           [...cfg.gimpArgs],
      env:            { ...cfg.gimpEnv },
      startupDelayMs: 15_000,
      readyTimeoutMs: 45_000,
    },
    'gimp',
  );
  console.log('[BroadwayManager] GIMP ready — rendering in browser');
}

/** Convenience: start both in sequence (for CLI/script use only). */
export async function startBroadway(): Promise<void> {
  await startBroadwayd();
  await startGimp();  // phantom browser connect happens inside startGimp
}

/** Stop GIMP first, then broadwayd. */
export async function stopBroadway(): Promise<void> {
  await stopProcess(gimp,      'gimp',      5_000);
  disconnectPhantomBrowser();
  await stopProcess(broadwayd, 'broadwayd', 5_000);
}

/** Restart GIMP only — broadwayd stays up. */
export async function restartGimp(): Promise<void> {
  await stopProcess(gimp, 'gimp', 5_000);
  await startGimp();
}

// ── macOS native fallback ─────────────────────────────────────────────────────

async function startGimpNative(): Promise<void> {
  const cfg = PLATFORM_CONFIG.darwin;
  if (!fs.existsSync(cfg.gimpPath)) {
    throw new Error(`GIMP not found: ${cfg.gimpPath}`);
  }
  gimp.state = 'starting';
  await spawnProcess(
    gimp,
    { cmd: cfg.gimpPath, args: [...cfg.gimpArgs] },
    'gimp-native',
  );
}
