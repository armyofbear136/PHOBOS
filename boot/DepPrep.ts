import fs              from 'node:fs';
import https           from 'node:https';
import http            from 'node:http';
import path            from 'node:path';
import os              from 'node:os';
import crypto          from 'node:crypto';
import zlib            from 'node:zlib';
import { execFile }    from 'node:child_process';
import { promisify }   from 'node:util';

const execFileAsync = promisify(execFile);

// ── Release base ──────────────────────────────────────────────────────────────

const DEPS_BASE = 'https://github.com/armyofbear136/PHOBOS-BUILDS/releases/download/PHOBOS-DEPS';

// ── Install roots ─────────────────────────────────────────────────────────────

const PHOBOS_HOME   = process.env.PHOBOS_DATA_DIR ?? path.join(os.homedir(), '.phobos');
const SERVICES_DIR  = path.join(PHOBOS_HOME, 'services');

// llama-server and sd-server land alongside the phobos-core executable in SEA
// production, or in bin/ during dev.  We write them to the exe's directory so
// the existing resolveLlamaServerBin / resolveSdServerBin probes find them.
const BIN_DIR       = path.dirname(process.execPath);

// VSS extension goes into phobos/extensions/ next to the exe (same probe order
// as DatabaseManager.resolveBundledExtensionDir).
function resolveExtensionDir(): string {
  const seaDir = path.dirname(process.execPath);
  return path.join(seaDir, 'phobos', 'extensions');
}

// Sybil model goes into phobos/models/ next to the exe.
function resolveModelsDir(): string {
  return path.join(path.dirname(process.execPath), 'phobos', 'models');
}

// ── Platform helpers ──────────────────────────────────────────────────────────

type PhobosArch = 'win32-x64' | 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64';

function detectArch(): PhobosArch {
  const p = process.platform;
  const a = process.arch;
  if (p === 'win32'  && a === 'x64')   return 'win32-x64';
  if (p === 'darwin' && a === 'arm64') return 'darwin-arm64';
  if (p === 'darwin' && a === 'x64')   return 'darwin-x64';
  if (p === 'linux'  && a === 'x64')   return 'linux-x64';
  if (p === 'linux'  && a === 'arm64') return 'linux-arm64';
  throw new Error(`Unsupported platform: ${p}/${a}`);
}

// ── Event types ───────────────────────────────────────────────────────────────

export type PrepPhase =
  | 'prep_start'
  | 'dep_start'
  | 'dep_progress'
  | 'dep_done'
  | 'dep_skip'
  | 'dep_error'
  | 'extract_start'
  | 'extract_done'
  | 'prep_complete';

export interface PrepEvent {
  phase:     PrepPhase;
  dep?:      string;    // human label
  file?:     string;    // filename being fetched
  bytes?:    number;    // bytes received so far
  total?:    number;    // total bytes (0 if unknown)
  pct?:      number;    // 0-100
  error?:    string;
  depsTotal?:  number;
  depsDone?:   number;
}

type PrepListener = (evt: PrepEvent) => void;

// ── Marker file — written after successful first-run prep ─────────────────────
// Keyed to the release tag so an upgrade triggers a fresh prep automatically.

const RELEASE_TAG    = 'PHOBOS-DEPS';
// Marker is keyed to the release tag AND a hash of BIN_DIR (the install location).
// This prevents two PHOBOS installs that share the same home directory (e.g. via
// OneDrive-synced profiles or a dev machine and a laptop with the same Windows user)
// from treating each other's prep as done.
const _installHash   = crypto.createHash('sha1').update(BIN_DIR).digest('hex').slice(0, 8);
const MARKER_FILE    = path.join(PHOBOS_HOME, `.dep-prep-${RELEASE_TAG}-${_installHash}.ok`);

export function isPrepComplete(): boolean {
  if (process.env.PHOBOS_SKIP_DEP_PREP === '1') return true;
  if (!fs.existsSync(MARKER_FILE)) return false;

  // Marker exists but physically verify the two most critical binaries before
  // trusting it. A fresh npm run build wipes dist/ leaving the marker stale —
  // without this check the server fast-paths past dep prep and crashes on boot.
  const isWin = process.platform === 'win32';
  const llamaBin = path.join(
    BIN_DIR,
    `llama-server-${process.platform}-${process.arch}${isWin ? '.exe' : ''}`,
  );
  const vssExt = path.join(
    resolveExtensionDir(),
    `v1.4.4`,   // keep in sync with DUCKDB_PLATFORM map in buildDeps()
    (() => {
      const DUCKDB_PLATFORM: Record<string, string> = {
        'win32-x64':   'windows_amd64',
        'darwin-arm64':'osx_arm64',
        'darwin-x64':  'osx_amd64',
        'linux-x64':   'linux_amd64',
        'linux-arm64': 'linux_arm64',
      };
      return DUCKDB_PLATFORM[`${process.platform}-${process.arch}`] ?? 'windows_amd64';
    })(),
    'vss.duckdb_extension',
  );

  const llamaOk = (() => { try { return fs.statSync(llamaBin).size >= 500_000; } catch { return false; } })();
  const vssOk   = (() => { try { return fs.statSync(vssExt).size >= 5_000_000; } catch { return false; } })();

  if (!llamaOk || !vssOk) {
    // Stale marker — wipe it so DepPrep re-runs on next boot.
    console.warn(`[DepPrep] Marker present but binaries missing (llama=${llamaOk} vss=${vssOk}) — invalidating marker.`);
    try { fs.unlinkSync(MARKER_FILE); } catch {}
    return false;
  }

  return true;
}

function markPrepComplete(): void {
  fs.mkdirSync(PHOBOS_HOME, { recursive: true });
  fs.writeFileSync(MARKER_FILE, new Date().toISOString(), 'utf8');
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function downloadFile(
  url:        string,
  destPath:   string,
  minBytes:   number,
  onProgress: (bytes: number, total: number) => void,
): Promise<void> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const tmpPath  = destPath + '.tmp';
  const existing = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
  const hdrs     = existing > 0 ? { Range: `bytes=${existing}-` } : {};

  // Single request with optional Range header — follows redirects.
  const res = await new Promise<import('http').IncomingMessage>((resolve, reject) => {
    const follow = (target: string, hops = 0) => {
      if (hops > 12) { reject(new Error('Too many redirects')); return; }
      let parsed: URL;
      try { parsed = new URL(target); } catch { reject(new Error(`Bad URL: ${target}`)); return; }
      const proto = parsed.protocol === 'https:' ? https : http;
      proto.get(
        { hostname: parsed.hostname,
          port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path:     parsed.pathname + parsed.search,
          headers:  { 'User-Agent': 'phobos-dep-prep/1.0', ...hdrs } },
        r => {
          if ([301, 302, 307, 308].includes(r.statusCode ?? 0) && r.headers.location) {
            r.resume(); follow(r.headers.location, hops + 1);
          } else { resolve(r); }
        }
      ).on('error', reject);
    };
    follow(url);
  });

  if ((res.statusCode ?? 0) === 404) { res.resume(); throw new Error(`404: ${url}`); }
  if ((res.statusCode ?? 0) !== 200 && (res.statusCode ?? 0) !== 206) {
    res.resume();
    throw new Error(`HTTP ${res.statusCode}: ${url}`);
  }

  const fromHeader = parseInt(res.headers['content-length'] ?? '0', 10);
  const total      = res.statusCode === 206 ? existing + fromHeader : fromHeader;

  await new Promise<void>((resolve, reject) => {
    const fd = fs.createWriteStream(tmpPath, { flags: existing > 0 ? 'a' : 'w' });
    let received = existing;

    res.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (!fd.write(chunk)) { res.pause(); fd.once('drain', () => res.resume()); }
      onProgress(received, total);
    });
    res.on('end',   () => fd.end());
    res.on('error', reject);
    fd.on('finish', resolve);
    fd.on('error',  reject);
  });

  const finalSz = fs.statSync(tmpPath).size;
  if (finalSz < minBytes)
    throw new Error(`Downloaded file too small (${finalSz} bytes, expected ≥ ${minBytes})`);

  fs.renameSync(tmpPath, destPath);
}

// ── SHA-256 ───────────────────────────────────────────────────────────────────

async function sha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', (d: Buffer | string) => h.update(d));
    s.on('end',  () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// ── Extraction helpers ────────────────────────────────────────────────────────

async function extractZip(archive: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    await execFileAsync('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -Force -LiteralPath '${archive}' -DestinationPath '${destDir}'`,
    ], { timeout: 300_000 });
  } else {
    await execFileAsync('unzip', ['-o', '-q', archive, '-d', destDir], { timeout: 300_000 });
  }
}

async function extractTarGz(archive: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  await execFileAsync('tar', ['-xzf', archive, '-C', destDir], { timeout: 300_000 });
}

async function extractTarXz(archive: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  await execFileAsync('tar', ['-xJf', archive, '-C', destDir], { timeout: 300_000 });
}

async function extractTarAny(archive: string, destDir: string): Promise<void> {
  // Auto-detect by extension
  if (archive.endsWith('.tar.gz') || archive.endsWith('.tgz'))  return extractTarGz(archive, destDir);
  if (archive.endsWith('.tar.xz'))                               return extractTarXz(archive, destDir);
  if (archive.endsWith('.zip'))                                  return extractZip(archive, destDir);
  throw new Error(`Unknown archive format: ${archive}`);
}

// ── Sentinel check — is a service binary already installed? ──────────────────
// Uses a minimum-size probe so a corrupt partial extraction is detected.

function serviceInstalled(dir: string, probe: string, minBytes: number): boolean {
  const p = path.join(dir, probe);
  try { return fs.statSync(p).size >= minBytes; } catch { return false; }
}

// ── Dep descriptor ────────────────────────────────────────────────────────────

interface Dep {
  id:        string;
  label:     string;
  file:      string;
  url?:      string;      // override if not on PHOBOS-DEPS release
  minBytes:  number;
  isPresent: () => boolean;
  install:   (archive: string) => Promise<void>;
}

// ── Dep definitions ───────────────────────────────────────────────────────────

function buildDeps(arch: PhobosArch): Dep[] {
  const isWin = arch.startsWith('win32');
  const isMac = arch.startsWith('darwin');
  const isLinux = arch.startsWith('linux');
  const duckdbVersion = '1.4.4'; // keep in sync with package.json

  // DuckDB platform string
  const DUCKDB_PLATFORM: Record<PhobosArch, string> = {
    'win32-x64':   'windows_amd64',
    'darwin-arm64':'osx_arm64',
    'darwin-x64':  'osx_amd64',
    'linux-x64':   'linux_amd64',
    'linux-arm64': 'linux_arm64',
  };
  const duckdbPlatform = DUCKDB_PLATFORM[arch];

  // VSS extension install path — mirrors DatabaseManager.resolveBundledExtensionDir
  const extDir  = path.join(resolveExtensionDir(), `v${duckdbVersion}`, duckdbPlatform);
  const extFile = path.join(extDir, 'vss.duckdb_extension');

  // Sybil model
  const sybilFile = path.join(resolveModelsDir(), 'nomic-embed-text-v1.5.Q4_K_M.gguf');

  // llama-server binary name — mirrors resolveLlamaServerBin
  const llamaName     = `llama-server-${process.platform}-${process.arch}${isWin ? '.exe' : ''}`;
  const llamaDest     = path.join(BIN_DIR, llamaName);

  // Companion DLLs for llama on Windows
  const LLAMA_WIN_DLLS = [
    'ggml.dll', 'ggml-base.dll', 'ggml-rpc.dll', 'llama.dll',
    'ggml-vulkan.dll',
    // CUDA — optional; absent on pure Vulkan builds
  ];

  // ── LLAMA archive filenames per platform ──────────────────────────────────
  function llamaArchive(): string {
    if (isWin) return `llama-b8940-bin-win-vulkan-x64.zip`;   // vulkan build has all companion .dlls
    if (isMac && arch === 'darwin-arm64') return `llama-b8940-bin-macos-arm64.tar.gz`;
    if (isMac) return `llama-b8940-bin-macos-x64.tar.gz`;
    if (arch === 'linux-arm64') return `llama-b8940-bin-ubuntu-vulkan-x64.tar.gz`; // best available
    return `llama-b8940-bin-ubuntu-vulkan-x64.tar.gz`;
  }

  // ── Version constants ──────────────────────────────────────────────────────
  const JELLYFIN_VERSION = '10.11.8';
  const V = { JELLYFIN: JELLYFIN_VERSION };

  // ── Service dirs ──────────────────────────────────────────────────────────
  const jellyfinDir = path.join(SERVICES_DIR, 'jellyfin');
  const kavitaDir   = path.join(SERVICES_DIR, 'kavita');
  const polarisDir  = path.join(SERVICES_DIR, 'polaris');
  const stirlingDir = path.join(SERVICES_DIR, 'stirling');
  const phobosHostDir = path.join(SERVICES_DIR, 'phobos-host');

  // ── Jellyfin archive + probe per platform ─────────────────────────────────
  function jellyfinDep(): Dep {
    if (isWin) return {
      id: 'jellyfin', label: 'Jellyfin Media Server',
      file: `jellyfin_${V.JELLYFIN}-amd64.zip`, minBytes: 120_000_000,
      isPresent: () => serviceInstalled(jellyfinDir, 'jellyfin.exe', 10_000_000),
      install: async (arc) => {
        await extractZip(arc, jellyfinDir);
        const sub = path.join(jellyfinDir, `jellyfin_${V.JELLYFIN}`);
        if (fs.existsSync(sub)) {
          for (const f of fs.readdirSync(sub)) {
            fs.renameSync(path.join(sub, f), path.join(jellyfinDir, f));
          }
          fs.rmdirSync(sub);
        }
      },
    };
    if (isMac) return {
      id: 'jellyfin', label: 'Jellyfin Media Server',
      file: arch === 'darwin-arm64'
        ? `jellyfin_${V.JELLYFIN}-macos-arm64.tar.xz`
        : `jellyfin_${V.JELLYFIN}-macos-x64.tar.xz`,
      minBytes: 60_000_000,
      isPresent: () => serviceInstalled(jellyfinDir, 'jellyfin', 5_000_000),
      install: async (arc) => extractTarXz(arc, jellyfinDir),
    };
    return {
      id: 'jellyfin', label: 'Jellyfin Media Server',
      file: arch === 'linux-arm64'
        ? `jellyfin_${V.JELLYFIN}-linux-arm64.tar.gz`
        : `jellyfin_${V.JELLYFIN}-linux-x64.tar.gz`,
      minBytes: 80_000_000,
      isPresent: () => serviceInstalled(jellyfinDir, 'jellyfin', 5_000_000),
      install: async (arc) => extractTarGz(arc, jellyfinDir),
    };
  }

  // ── Kavita probe per platform ─────────────────────────────────────────────
  function kavitaProbe(): string {
    if (isWin) return 'API.dll';   // Kavita.exe is a tiny launcher stub
    return 'Kavita';
  }

  function kavitaDep(): Dep {
    const fileMap: Record<PhobosArch, string> = {
      'win32-x64':   'kavita-win-x64.tar.gz',
      'darwin-arm64':'kavita-osx-arm64.tar.gz',
      'darwin-x64':  'kavita-osx-x64.tar.gz',
      'linux-x64':   'kavita-linux-x64.tar.gz',
      'linux-arm64': 'kavita-linux-arm64.tar.gz',
    };
    return {
      id: 'kavita', label: 'Kavita Reading Server',
      file: fileMap[arch], minBytes: 70_000_000,
      isPresent: () => serviceInstalled(kavitaDir, kavitaProbe(), 50_000),
      install: async (arc) => extractTarGz(arc, kavitaDir),
    };
  }

  // ── Polaris binary per platform ───────────────────────────────────────────
  function polarisDep(): Dep | null {
    if (isWin) return {
      id: 'polaris', label: 'Polaris Music Server',
      file: 'Polaris_0.16.0.msi', minBytes: 5_000_000,
      isPresent: () => serviceInstalled(polarisDir, 'polaris-cli.exe', 1_000_000),
      install: async (arc) => {
        // msiexec /a extracts without installing system-wide.
        fs.mkdirSync(polarisDir, { recursive: true });
        await execFileAsync('msiexec', [
          '/a', arc, '/qn', `TARGETDIR=${polarisDir}`,
        ], { timeout: 120_000 });
        // The CLI binary ends up at <polarisDir>/polaris-cli.exe — already correct.
      },
    };
    // Linux / macOS: pre-built binary uploaded by you
    const binName = arch === 'darwin-arm64' ? 'polaris-darwin-arm64'
                  : arch === 'darwin-x64'   ? 'polaris-darwin-x64'
                  :                           'polaris-linux-x64';
    const binDest = path.join(polarisDir, 'polaris');
    return {
      id: 'polaris', label: 'Polaris Music Server',
      file: binName, minBytes: 1_000_000,
      isPresent: () => {
        try { return fs.statSync(binDest).size >= 1_000_000; } catch { return false; }
      },
      install: async (arc) => {
        fs.mkdirSync(polarisDir, { recursive: true });
        fs.copyFileSync(arc, binDest);
        fs.chmodSync(binDest, 0o755);
      },
    };
  }

  // ── PhobosHost ─────────────────────────────────────────────────────────────
  // Single-executable JUCE-based VST3 host (replaces Carla). Distributed as
  // a per-platform zip in the standard PHOBOS-DEPS release alongside the
  // other third-party deps. Asset names follow the underscore-arch
  // convention used by the existing release (`PhobosHost-<platform>_<arch>.zip`).
  function phobosHostDep(): Dep {
    if (isWin) return {
      id: 'phobos-host', label: 'PhobosHost VST3 host',
      file: 'PhobosHost-win_x64.zip',
      minBytes: 1_000_000,
      isPresent: () => serviceInstalled(phobosHostDir, 'PhobosHost.exe', 500_000),
      install: async (arc) => extractZip(arc, phobosHostDir),
    };
    if (isMac) return {
      id: 'phobos-host', label: 'PhobosHost VST3 host',
      file: arch === 'darwin-arm64' ? 'PhobosHost-darwin_arm64.zip' : 'PhobosHost-darwin_x64.zip',
      minBytes: 1_000_000,
      isPresent: () => serviceInstalled(phobosHostDir, 'PhobosHost', 500_000),
      install: async (arc) => {
        await extractZip(arc, phobosHostDir);
        // macOS: ensure the binary is executable. Some zips lose +x.
        try { fs.chmodSync(path.join(phobosHostDir, 'PhobosHost'), 0o755); } catch { /* non-fatal */ }
      },
    };
    return {
      id: 'phobos-host', label: 'PhobosHost VST3 host',
      file: arch === 'linux-arm64' ? 'PhobosHost-linux_arm64.zip' : 'PhobosHost-linux_x64.zip',
      minBytes: 1_000_000,
      isPresent: () => serviceInstalled(phobosHostDir, 'PhobosHost', 500_000),
      install: async (arc) => {
        await extractZip(arc, phobosHostDir);
        try { fs.chmodSync(path.join(phobosHostDir, 'PhobosHost'), 0o755); } catch { /* non-fatal */ }
      },
    };
  }

  // ── Stirling PDF ──────────────────────────────────────────────────────────
  const stirlingDep: Dep = {
    id: 'stirling', label: 'Stirling PDF',
    file: 'Stirling-PDF-2.9.2.jar', minBytes: 100_000_000,
    isPresent: () => serviceInstalled(stirlingDir, 'Stirling-PDF.jar', 10_000_000),
    install: async (arc) => {
      fs.mkdirSync(stirlingDir, { recursive: true });
      fs.copyFileSync(arc, path.join(stirlingDir, 'Stirling-PDF.jar'));
    },
  };

  // ── VSS Extension ─────────────────────────────────────────────────────────
  const vssDep: Dep = {
    id: 'vss', label: 'DuckDB VSS Extension',
    file: `vss-${duckdbPlatform}-v${duckdbVersion}.duckdb_extension`,
    minBytes: 5_000_000,
    isPresent: () => { try { return fs.statSync(extFile).size >= 5_000_000; } catch { return false; } },
    install: async (arc) => {
      fs.mkdirSync(extDir, { recursive: true });
      fs.copyFileSync(arc, extFile);
    },
  };

  // ── Sybil model ───────────────────────────────────────────────────────────
  const sybilDep: Dep = {
    id: 'sybil-model', label: 'SYBIL Embedding Model',
    file: 'nomic-embed-text-v1.5.Q4_K_M.gguf',
    minBytes: 60_000_000,
    isPresent: () => { try { return fs.statSync(sybilFile).size >= 60_000_000; } catch { return false; } },
    install: async (arc) => {
      fs.mkdirSync(path.dirname(sybilFile), { recursive: true });
      fs.copyFileSync(arc, sybilFile);
    },
  };

  // ── llama-server ──────────────────────────────────────────────────────────
  const llamaDep: Dep = {
    id: 'llama-server', label: 'LLM Server (llama.cpp)',
    file: llamaArchive(), minBytes: 5_000_000,
    isPresent: () => { try { return fs.statSync(llamaDest).size >= 500_000; } catch { return false; } },
    install: async (arc) => {
      const tmp = arc + '-extract';
      fs.mkdirSync(tmp, { recursive: true });
      await extractTarAny(arc, tmp);

      // Find the llama-server binary anywhere in the extracted tree
      const serverBin = isWin ? 'llama-server.exe' : 'llama-server';
      const found = findFile(tmp, serverBin);
      if (!found) throw new Error(`llama-server binary not found in ${arc}`);

      fs.copyFileSync(found, llamaDest);
      if (!isWin) fs.chmodSync(llamaDest, 0o755);

      // On Windows, copy all companion DLLs from the same directory
      if (isWin) {
        const srcDir = path.dirname(found);
        for (const dll of fs.readdirSync(srcDir)) {
          if (dll.endsWith('.dll')) {
            fs.copyFileSync(path.join(srcDir, dll), path.join(BIN_DIR, dll));
          }
        }
      }

      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };

  // Windows also needs the CUDA runtime DLLs for the CUDA build path.
  // We install the vulkan build above for the binary, but stage the CUDA DLLs
  // alongside it so users with NVIDIA GPUs get hardware acceleration.
  const llamaCudaRtDep: Dep | null = isWin ? {
    id: 'llama-cudart', label: 'LLM CUDA Runtime DLLs',
    file: 'cudart-llama-bin-win-cuda-12.4-x64.zip', minBytes: 50_000_000,
    isPresent: () => fs.existsSync(path.join(BIN_DIR, 'cudart64_12.dll')),
    install: async (arc) => {
      const tmp = arc + '-extract';
      fs.mkdirSync(tmp, { recursive: true });
      await extractZip(arc, tmp);
      for (const dll of fs.readdirSync(tmp, { recursive: true }) as string[]) {
        if (typeof dll === 'string' && dll.endsWith('.dll')) {
          const src  = path.join(tmp, dll);
          const dest = path.join(BIN_DIR, path.basename(dll));
          if (fs.statSync(src).isFile()) fs.copyFileSync(src, dest);
        }
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  } : null;

  // ── sd-server — all GPU variants ─────────────────────────────────────────
  // Windows needs four separate subdirectory installs (cuda/rocm/vulkan/cpu).
  // Linux/macOS: one vulkan binary + one ROCm binary (isolated subdir).
  // Binary names must exactly match what resolveSdServerBin() probes.

  const SD_HASH = 'c97702e';

  function sdArchiveForVariant(variant: 'vulkan' | 'cuda' | 'rocm' | 'cpu'): string {
    if (isWin) {
      if (variant === 'cpu') return `sd-master-${SD_HASH}-bin-win-avx2-x64.zip`;
      return `sd-master-${SD_HASH}-bin-win-${variant === 'cuda' ? 'cuda12' : variant}-x64.zip`;
    }
    if (isMac && arch === 'darwin-arm64') return `sd-master-${SD_HASH}-bin-Darwin-macOS-15.7.4-arm64.zip`;
    if (variant === 'rocm') return `sd-master-${SD_HASH}-bin-Linux-Ubuntu-24.04-x86_64-rocm.zip`;
    return `sd-master-${SD_HASH}-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip`;
  }

  // Windows: exact binary name per variant (must match resolveSdServerBin candidates)
  function sdWinBinName(variant: 'vulkan' | 'cuda' | 'rocm' | 'cpu'): string {
    if (variant === 'vulkan') return 'sd-server-win32-x64.exe';         // no suffix for vulkan
    return `sd-server-win32-x64-${variant}.exe`;
  }

  function makeSdDep(variant: 'vulkan' | 'cuda' | 'rocm' | 'cpu'): Dep {
    const label = `Image Generation Server (${variant})`;
    const file  = sdArchiveForVariant(variant);

    if (isWin) {
      const subdir  = path.join(BIN_DIR, `sd-${variant}`);
      const binName = sdWinBinName(variant);
      const binPath = path.join(subdir, binName);
      return {
        id: `sd-server-${variant}`, label, file,
        minBytes: variant === 'rocm' ? 200_000_000 : 5_000_000,
        isPresent: () => { try { return fs.statSync(binPath).size >= 500_000; } catch { return false; } },
        install: async (arc) => {
          const tmp = arc + `-${variant}-extract`;
          fs.mkdirSync(tmp, { recursive: true });
          await extractTarAny(arc, tmp);
          const srcBin = findFile(tmp, 'sd.exe') ?? findFile(tmp, 'sd-server.exe');
          if (!srcBin) throw new Error(`sd binary not found in ${arc}`);
          fs.mkdirSync(subdir, { recursive: true });
          fs.copyFileSync(srcBin, binPath);
          // Copy all companion DLLs from the same source directory
          for (const dll of fs.readdirSync(path.dirname(srcBin))) {
            if (dll.endsWith('.dll')) {
              fs.copyFileSync(path.join(path.dirname(srcBin), dll), path.join(subdir, dll));
            }
          }
          fs.rmSync(tmp, { recursive: true, force: true });
        },
      };
    }

    // Linux/macOS: vulkan is the universal binary; ROCm goes in sd-rocm/ subdir
    if (variant === 'rocm' && isLinux) {
      const subdir  = path.join(BIN_DIR, 'sd-rocm');
      const binPath = path.join(subdir, `sd-server-linux-x64-rocm`);
      return {
        id: 'sd-server-rocm', label, file, minBytes: 200_000_000,
        isPresent: () => { try { return fs.statSync(binPath).size >= 500_000; } catch { return false; } },
        install: async (arc) => {
          const tmp = arc + '-rocm-extract';
          fs.mkdirSync(tmp, { recursive: true });
          await extractTarAny(arc, tmp);
          const srcBin = findFile(tmp, 'sd') ?? findFile(tmp, 'sd-server');
          if (!srcBin) throw new Error(`sd binary not found in ${arc}`);
          fs.mkdirSync(subdir, { recursive: true });
          fs.copyFileSync(srcBin, binPath);
          fs.chmodSync(binPath, 0o755);
          fs.rmSync(tmp, { recursive: true, force: true });
        },
      };
    }

    // vulkan universal (linux + mac)
    const binPath = path.join(BIN_DIR, `sd-server-${process.platform}-${process.arch}`);
    return {
      id: 'sd-server-vulkan', label, file, minBytes: 5_000_000,
      isPresent: () => { try { return fs.statSync(binPath).size >= 500_000; } catch { return false; } },
      install: async (arc) => {
        const tmp = arc + '-extract';
        fs.mkdirSync(tmp, { recursive: true });
        await extractTarAny(arc, tmp);
        const srcBin = findFile(tmp, 'sd') ?? findFile(tmp, 'sd-server');
        if (!srcBin) throw new Error(`sd binary not found in ${arc}`);
        fs.copyFileSync(srcBin, binPath);
        fs.chmodSync(binPath, 0o755);
        fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  }

  // Also stage the CUDA runtime DLLs alongside the cuda binary on Windows
  const sdCudaRtDep: Dep | null = isWin ? {
    id: 'sd-cudart', label: 'Image Generation CUDA Runtime DLLs',
    file: 'cudart-sd-bin-win-cu12-x64.zip', minBytes: 50_000_000,
    isPresent: () => fs.existsSync(path.join(BIN_DIR, 'sd-cuda', 'cudart64_12.dll')),
    install: async (arc) => {
      const tmp = arc + '-extract';
      fs.mkdirSync(tmp, { recursive: true });
      await extractZip(arc, tmp);
      const destDir = path.join(BIN_DIR, 'sd-cuda');
      fs.mkdirSync(destDir, { recursive: true });
      for (const dll of (fs.readdirSync(tmp, { recursive: true }) as string[])) {
        if (typeof dll === 'string' && dll.endsWith('.dll')) {
          const src = path.join(tmp, dll);
          if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(destDir, path.basename(dll)));
        }
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  } : null;

  // ── mpv video player ──────────────────────────────────────────────────────
  function mpvDep(): Dep | null {
    const mpvDir  = path.join(SERVICES_DIR, 'mpv');
    const binName = isWin ? 'mpv.exe' : 'mpv';
    const binPath = path.join(mpvDir, binName);

    if (arch === 'linux-arm64') return null; // no static binary available

    const fileMap: Partial<Record<PhobosArch, { file: string; minBytes: number }>> = {
      'win32-x64':    { file: 'mpv-v0.41.0-x86_64-w64-mingw32.zip',   minBytes: 15_000_000 },
      'darwin-arm64': { file: 'mpv-v0.41.0-macos-26-arm.zip',          minBytes: 10_000_000 },
      'darwin-x64':   { file: 'mpv-v0.41.0-macos-15-intel.zip',        minBytes: 10_000_000 },
      'linux-x64':    { file: 'mpv-v0.39.0-x86_64.tar.gz',             minBytes: 25_000_000 },
    };
    const entry = fileMap[arch];
    if (!entry) return null;

    return {
      id: 'mpv', label: 'mpv Video Player',
      file: entry.file, minBytes: entry.minBytes,
      isPresent: () => { try { return fs.statSync(binPath).size >= entry.minBytes; } catch { return false; } },
      install: async (arc) => {
        const tmp = arc + '-extract';
        fs.mkdirSync(tmp, { recursive: true });
        await extractTarAny(arc, tmp);
        fs.mkdirSync(mpvDir, { recursive: true });

        if (isWin) {
          // Outer zip contains exactly one inner zip (dated, e.g. mpv-git-2025-12-21-...-x86_64.zip).
          // The inner zip extracts to a flat directory of files (mpv.exe + DLLs).
          // We must extract the outer, find the inner zip, extract it, then copy everything to mpvDir.
          const innerZipName = fs.readdirSync(tmp).find(f => f.endsWith('.zip') && f.startsWith('mpv'));
          if (!innerZipName) throw new Error(`Expected inner mpv zip not found in ${arc}`);
          const innerZip = path.join(tmp, innerZipName);
          const innerTmp = tmp + '-inner';
          fs.mkdirSync(innerTmp, { recursive: true });
          await extractZip(innerZip, innerTmp);
          // Inner zip extracts to a flat directory — find where mpv.exe landed
          const mpvExe = findFile(innerTmp, 'mpv.exe');
          if (!mpvExe) throw new Error(`mpv.exe not found after inner extraction`);
          const srcDir = path.dirname(mpvExe);
          // Copy mpv.exe and all sibling DLLs into mpvDir
          for (const f of fs.readdirSync(srcDir)) {
            fs.copyFileSync(path.join(srcDir, f), path.join(mpvDir, f));
          }
          fs.rmSync(innerTmp, { recursive: true, force: true });
        } else if (isMac) {
          // macOS: mpv.app/Contents/MacOS/mpv
          const macBin = findFile(tmp, 'mpv');
          if (!macBin) throw new Error('mpv binary not found in app bundle');
          fs.copyFileSync(macBin, binPath);
          fs.chmodSync(binPath, 0o755);
          try { await execFileAsync('xattr', ['-d', 'com.apple.quarantine', binPath]); } catch {}
          // Clean up the app bundle
          const appBundle = path.join(tmp, 'mpv.app');
          if (fs.existsSync(appBundle)) fs.rmSync(appBundle, { recursive: true, force: true });
        } else {
          // Linux: single static binary
          const linBin = findFile(tmp, 'mpv');
          if (!linBin) throw new Error('mpv binary not found in archive');
          fs.copyFileSync(linBin, binPath);
          fs.chmodSync(binPath, 0o755);
        }
        fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  }

  // ── Helm VST3 synth ───────────────────────────────────────────────────────
  function helmDep(): Dep | null {
    const helmDir = path.join(SERVICES_DIR, 'helm');
    if (isWin) return {
      id: 'helm', label: 'Helm VST3 Synth',
      file: 'Helm_64bit_v0_9_0_r.msi', minBytes: 4_000_000,
      isPresent: () => serviceInstalled(helmDir, 'Helm.vst3', 100_000),
      install: async (arc) => {
        fs.mkdirSync(helmDir, { recursive: true });
        // Extract MSI silently to the helm service dir
        await execFileAsync('msiexec', [
          '/a', arc, '/qn', `TARGETDIR=${helmDir}`,
        ], { timeout: 120_000 });
      },
    };
    if (isMac) return {
      id: 'helm', label: 'Helm VST3 Synth',
      file: 'Helm_v0_9_0_r.pkg', minBytes: 4_000_000,
      isPresent: () => serviceInstalled(helmDir, 'Helm.vst3', 100_000),
      install: async (arc) => {
        fs.mkdirSync(helmDir, { recursive: true });
        await execFileAsync('installer', ['-pkg', arc, '-target', helmDir], { timeout: 120_000 });
      },
    };
    // Linux — deb package; extract without system install
    return {
      id: 'helm', label: 'Helm VST3 Synth',
      file: 'helm_0.9.0_amd64_r.deb', minBytes: 2_000_000,
      isPresent: () => serviceInstalled(helmDir, 'helm.vst3', 100_000),
      install: async (arc) => {
        fs.mkdirSync(helmDir, { recursive: true });
        // dpkg-deb -x extracts without system registration
        await execFileAsync('dpkg-deb', ['-x', arc, helmDir], { timeout: 120_000 });
      },
    };
  }

  // ── Node.js portable runtime — for CamofoxManager + MeridianManager ─────
  // In production, process.execPath is the phobos-core SEA binary.
  // These managers need a real node binary to spawn JS subprocesses.
  // node-win32-x64.exe etc. are staged by the build process from bin/,
  // but on a fresh install they may be missing. DepPrep ensures they're present.
  function nodeDep(): Dep {
    const nodeFilenames: Record<PhobosArch, string> = {
      'win32-x64':   'node-win32-x64.exe',
      'darwin-arm64':'node-v22.14.0-darwin-arm64.tar.gz',
      'darwin-x64':  'node-v22.14.0-darwin-x64.tar.gz',
      'linux-x64':   'node-v22.14.0-linux-x64.tar.gz',
      'linux-arm64': 'node-v22.14.0-linux-arm64.tar.gz',
    };
    const file     = nodeFilenames[arch];
    const destName = isWin ? 'node-win32-x64.exe' : `node-${process.platform}-${process.arch}`;
    const destPath = path.join(BIN_DIR, destName);

    return {
      id: 'node-runtime', label: 'Node.js Runtime',
      file, minBytes: 20_000_000,
      isPresent: () => { try { return fs.statSync(destPath).size >= 20_000_000; } catch { return false; } },
      install: async (arc) => {
        if (isWin) {
          // Windows: raw .exe download — just copy it into BIN_DIR
          fs.copyFileSync(arc, destPath);
        } else {
          // Unix: tar.gz containing node-v22.14.0-{platform}-{arch}/bin/node
          const tmp = arc + '-extract';
          fs.mkdirSync(tmp, { recursive: true });
          await extractTarGz(arc, tmp);
          const nodeBin = findFile(tmp, 'node');
          if (!nodeBin) throw new Error(`node binary not found in ${arc}`);
          fs.copyFileSync(nodeBin, destPath);
          fs.chmodSync(destPath, 0o755);
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      },
    };
  }

  // ── Pandoc document converter ─────────────────────────────────────────────
  function pandocDep(): Dep {
    const PANDOC_VERSION = '3.6.4';
    const pandocBin  = path.join(BIN_DIR, isWin ? 'pandoc.exe' : 'pandoc');
    const fileMap: Record<PhobosArch, { file: string; minBytes: number }> = {
      'win32-x64':    { file: `pandoc-${PANDOC_VERSION}-windows-x86_64.zip`,   minBytes: 20_000_000 },
      'darwin-arm64': { file: `pandoc-${PANDOC_VERSION}-arm64-macOS.zip`,       minBytes: 18_000_000 },
      'darwin-x64':   { file: `pandoc-${PANDOC_VERSION}-x86_64-macOS.zip`,     minBytes: 20_000_000 },
      'linux-x64':    { file: `pandoc-${PANDOC_VERSION}-linux-amd64.tar.gz`,   minBytes: 20_000_000 },
      'linux-arm64':  { file: `pandoc-${PANDOC_VERSION}-linux-arm64.tar.gz`,   minBytes: 18_000_000 },
    };
    const { file, minBytes } = fileMap[arch];
    return {
      id: 'pandoc', label: 'Pandoc Document Converter',
      file,
      minBytes,
      isPresent: () => { try { return fs.statSync(pandocBin).size >= 18_000_000; } catch { return false; } },
      install: async (arc) => {
        const tmp = arc + '-extract';
        fs.mkdirSync(tmp, { recursive: true });
        await extractTarAny(arc, tmp);
        const binName = isWin ? 'pandoc.exe' : 'pandoc';
        const found   = findFile(tmp, binName);
        if (!found) throw new Error(`pandoc binary not found in ${arc}`);
        fs.mkdirSync(BIN_DIR, { recursive: true });
        fs.copyFileSync(found, pandocBin);
        if (!isWin) {
          fs.chmodSync(pandocBin, 0o755);
          // macOS: strip Gatekeeper quarantine
          if (isMac) {
            try { await execFileAsync('xattr', ['-d', 'com.apple.quarantine', pandocBin]); } catch {}
          }
        }
        fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  }

  // Build final list — null entries are platform-not-applicable
  const deps: Dep[] = [
    vssDep,
    sybilDep,
    nodeDep(),
    llamaDep,
    llamaCudaRtDep,
    // SD variants: all four on Windows, vulkan + ROCm on Linux, vulkan only on mac
    makeSdDep('vulkan'),
    ...(isWin ? [makeSdDep('cuda'), makeSdDep('rocm'), makeSdDep('cpu'), sdCudaRtDep] : []),
    ...(isLinux ? [makeSdDep('rocm')] : []),
    jellyfinDep(),
    kavitaDep(),
    polarisDep(),
    stirlingDep,
    phobosHostDep(),
    helmDep(),
    pandocDep(),
    mpvDep(),
  ].filter((d): d is Dep => d !== null);

  return deps;
}

// ── File tree search ──────────────────────────────────────────────────────────

function findFile(dir: string, name: string): string | null {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isFile() && ent.name === name) return full;
    if (ent.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    }
  }
  return null;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run the dependency prep phase.
 *
 * Emits PrepEvents to the provided listener so the server can forward progress
 * to the launcher via IPC and to the frontend via SSE.
 *
 * Returns when all deps are present.  Throws only on unrecoverable errors.
 */
export async function runDepPrep(onEvent: PrepListener): Promise<void> {
  if (isPrepComplete()) return; // fast-path — already done

  const arch = detectArch();
  const deps = buildDeps(arch);
  const tmp  = path.join(PHOBOS_HOME, 'dep-prep-downloads');
  fs.mkdirSync(tmp, { recursive: true });

  onEvent({ phase: 'prep_start', depsTotal: deps.length, depsDone: 0 });

  let done = 0;
  for (const dep of deps) {
    if (dep.isPresent()) {
      onEvent({ phase: 'dep_skip', dep: dep.label, depsDone: ++done, depsTotal: deps.length });
      continue;
    }

    onEvent({ phase: 'dep_start', dep: dep.label, file: dep.file, depsDone: done, depsTotal: deps.length });

    const archivePath = path.join(tmp, dep.file);

    // Download if not already in the temp dir
    if (!fs.existsSync(archivePath) || fs.statSync(archivePath).size < dep.minBytes) {
      const url = dep.url ?? `${DEPS_BASE}/${dep.file}`;
      try {
        await downloadFile(url, archivePath, dep.minBytes, (bytes, total) => {
          const pct = total > 0 ? Math.floor(bytes / total * 100) : 0;
          onEvent({ phase: 'dep_progress', dep: dep.label, file: dep.file, bytes, total, pct });
        });
      } catch (err) {
        const msg = (err as Error).message;
        console.error(`[DepPrep] Download failed for ${dep.id}: ${msg}`);
        onEvent({ phase: 'dep_error', dep: dep.label, file: dep.file, error: msg });
        // Non-fatal — skip this dep and continue.  The service manager's
        // isBinaryPresent() check will gate the service off at boot.
        continue;
      }
    }

    // Extract / install
    onEvent({ phase: 'extract_start', dep: dep.label, file: dep.file });
    try {
      await dep.install(archivePath);
      onEvent({ phase: 'extract_done', dep: dep.label });
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[DepPrep] Install failed for ${dep.id}: ${msg}`);
      onEvent({ phase: 'dep_error', dep: dep.label, file: dep.file, error: msg });
      continue;
    }

    onEvent({ phase: 'dep_done', dep: dep.label, depsDone: ++done, depsTotal: deps.length });
  }

  // Clean up temp downloads — they've all been extracted
  fs.rmSync(tmp, { recursive: true, force: true });

  markPrepComplete();
  onEvent({ phase: 'prep_complete' });
}