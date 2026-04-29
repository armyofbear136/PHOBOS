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
const MARKER_FILE    = path.join(PHOBOS_HOME, `.dep-prep-${RELEASE_TAG}.ok`);

export function isPrepComplete(): boolean {
  return fs.existsSync(MARKER_FILE);
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
    s.on('data', (d: Buffer) => h.update(d));
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
  id:        string;        // unique key
  label:     string;        // display name
  file:      string;        // filename on the PHOBOS-DEPS release
  minBytes:  number;
  /** Return true if the dep is already installed — skip download AND extract. */
  isPresent: () => boolean;
  /** Perform post-download work (extraction, chmod, placement). */
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

  // sd-server binary — sd-server is placed in subdirectories per GPU backend on Windows
  function sdDest(variant: string): string {
    if (isWin) return path.join(BIN_DIR, `sd-${variant}`, `sd-server-win32-x64-${variant}.exe`);
    return path.join(BIN_DIR, `sd-server-${process.platform}-${process.arch}${variant === 'rocm' ? '-rocm' : ''}`);
  }

  // ── LLAMA archive filenames per platform ──────────────────────────────────
  function llamaArchive(): string {
    if (isWin) return `llama-b8940-bin-win-vulkan-x64.zip`;   // vulkan build has all companion .dlls
    if (isMac && arch === 'darwin-arm64') return `llama-b8940-bin-macos-arm64.tar.gz`;
    if (isMac) return `llama-b8940-bin-macos-x64.tar.gz`;
    if (arch === 'linux-arm64') return `llama-b8940-bin-ubuntu-vulkan-x64.tar.gz`; // best available
    return `llama-b8940-bin-ubuntu-vulkan-x64.tar.gz`;
  }

  // ── SD archive filenames ──────────────────────────────────────────────────
  function sdVulkanArchive(): string {
    if (isWin)  return `sd-master-c97702e-bin-win-vulkan-x64.zip`;
    if (isMac && arch === 'darwin-arm64') return `sd-master-c97702e-bin-Darwin-macOS-15.7.4-arm64.zip`;
    return `sd-master-c97702e-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip`;
  }

  // ── Service dirs ──────────────────────────────────────────────────────────
  const jellyfinDir = path.join(SERVICES_DIR, 'jellyfin');
  const kavitaDir   = path.join(SERVICES_DIR, 'kavita');
  const polarisDir  = path.join(SERVICES_DIR, 'polaris');
  const stirlingDir = path.join(SERVICES_DIR, 'stirling');
  const carlaDir    = path.join(SERVICES_DIR, 'carla');

  // ── Jellyfin archive + probe per platform ─────────────────────────────────
  function jellyfinDep(): Dep {
    if (isWin) return {
      id: 'jellyfin', label: 'Jellyfin Media Server',
      file: 'jellyfin_10.11.8-amd64.zip', minBytes: 120_000_000,
      isPresent: () => serviceInstalled(jellyfinDir, 'jellyfin.exe', 10_000_000),
      install: async (arc) => {
        await extractZip(arc, jellyfinDir);
        // jellyfin win zip extracts to jellyfin_10.11.8/ subdir — flatten one level
        const sub = path.join(jellyfinDir, 'jellyfin_10.11.8');
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
        ? 'jellyfin_10.11.8-macos-arm64.tar.xz'
        : 'jellyfin_10.11.8-macos-x64.tar.xz',
      minBytes: 60_000_000,
      isPresent: () => serviceInstalled(jellyfinDir, 'jellyfin', 5_000_000),
      install: async (arc) => extractTarXz(arc, jellyfinDir),
    };
    return {
      id: 'jellyfin', label: 'Jellyfin Media Server',
      file: arch === 'linux-arm64'
        ? 'jellyfin_10.11.8-linux-arm64.tar.gz'
        : 'jellyfin_10.11.8-linux-x64.tar.gz',
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

  // ── Carla ─────────────────────────────────────────────────────────────────
  function carlaDep(): Dep | null {
    if (isWin) return {
      id: 'carla', label: 'Carla DAW Host',
      file: 'Carla-2.5.10-win64.zip', minBytes: 150_000_000,
      isPresent: () => serviceInstalled(carlaDir, 'Carla/Carla.exe', 50_000),
      install: async (arc) => extractZip(arc, carlaDir),
    };
    if (isMac) return {
      id: 'carla', label: 'Carla DAW Host',
      file: 'Carla-2.5.10-macos-universal.dmg', minBytes: 200_000_000,
      isPresent: () => serviceInstalled(carlaDir, 'Carla.app/Contents/MacOS/Carla', 50_000),
      install: async (arc) => {
        // hdiutil attach → copy .app → detach
        const mount  = `/Volumes/Carla-prep-${Date.now()}`;
        await execFileAsync('hdiutil', ['attach', '-mountpoint', mount, '-nobrowse', '-quiet', arc], { timeout: 120_000 });
        try {
          await execFileAsync('cp', ['-R', `${mount}/Carla.app`, carlaDir], { timeout: 120_000 });
        } finally {
          await execFileAsync('hdiutil', ['detach', mount, '-quiet']).catch(() => {});
        }
      },
    };
    // Linux — Carla_2.2.0-linux64.tar.xz (last version with Linux binaries)
    return {
      id: 'carla', label: 'Carla DAW Host',
      file: 'Carla_2.2.0-linux64.tar.xz', minBytes: 80_000_000,
      isPresent: () => serviceInstalled(carlaDir, 'Carla/Carla', 50_000),
      install: async (arc) => extractTarXz(arc, carlaDir),
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

  // ── sd-server (vulkan / universal build) ──────────────────────────────────
  const sdBinName = isWin
    ? path.join(BIN_DIR, 'sd-vulkan', 'sd-server-win32-x64-vulkan.exe')
    : `sd-server-${process.platform}-${process.arch}`;
  const sdDest = isWin ? sdBinName : path.join(BIN_DIR, sdBinName);

  const sdDep: Dep = {
    id: 'sd-server', label: 'Image Generation Server',
    file: sdVulkanArchive(), minBytes: 5_000_000,
    isPresent: () => { try { return fs.statSync(sdDest).size >= 500_000; } catch { return false; } },
    install: async (arc) => {
      const tmp = arc + '-extract';
      fs.mkdirSync(tmp, { recursive: true });
      await extractTarAny(arc, tmp);

      if (isWin) {
        const serverBin = findFile(tmp, 'sd.exe') ?? findFile(tmp, 'sd-server.exe');
        if (!serverBin) throw new Error(`sd binary not found in ${arc}`);
        const destDir = path.join(BIN_DIR, 'sd-vulkan');
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(serverBin, path.join(destDir, 'sd-server-win32-x64-vulkan.exe'));
        // Copy companion DLLs
        for (const dll of fs.readdirSync(path.dirname(serverBin))) {
          if (dll.endsWith('.dll')) {
            fs.copyFileSync(path.join(path.dirname(serverBin), dll), path.join(destDir, dll));
          }
        }
      } else {
        const serverBin = findFile(tmp, 'sd') ?? findFile(tmp, 'sd-server');
        if (!serverBin) throw new Error(`sd binary not found in ${arc}`);
        fs.copyFileSync(serverBin, sdDest);
        fs.chmodSync(sdDest, 0o755);
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };

  // Build final list — null entries are platform-not-applicable
  const deps: Dep[] = [
    vssDep,
    sybilDep,
    llamaDep,
    llamaCudaRtDep,
    sdDep,
    jellyfinDep(),
    kavitaDep(),
    polarisDep(),
    stirlingDep,
    carlaDep(),
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
      const url = `${DEPS_BASE}/${dep.file}`;
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
