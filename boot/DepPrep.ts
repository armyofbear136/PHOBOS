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

// ── Manifest-based version tracking ──────────────────────────────────────────
//
// bin-manifest.json defines the authoritative version for every dep.
// DepPrep compares it against an installed-deps manifest written to ~/.phobos/
// after each successful install. Only stale or missing deps are re-downloaded.

const _installHash = crypto.createHash('sha1').update(BIN_DIR).digest('hex').slice(0, 8);
const INSTALLED_MANIFEST_PATH = path.join(PHOBOS_HOME, `installed-deps-${_installHash}.json`);

function loadBinManifest(): Record<string, unknown> {
  const candidates = [
    path.join(path.dirname(process.execPath), 'bin-manifest.json'),
    path.join(path.dirname(process.execPath), 'scripts', 'bin-manifest.json'),
    path.join(__dirname, '..', 'scripts', 'bin-manifest.json'),
    path.join(__dirname, 'bin-manifest.json'),
  ];
  for (const c of candidates) {
    try { return JSON.parse(fs.readFileSync(c, 'utf8')); } catch {}
  }
  return {};
}

const _binManifest = loadBinManifest();

function loadInstalledManifest(): Record<string, { version: string; installedAt: string }> {
  try { return JSON.parse(fs.readFileSync(INSTALLED_MANIFEST_PATH, 'utf8')); } catch { return {}; }
}

function markDepInstalled(depId: string, version: string): void {
  fs.mkdirSync(PHOBOS_HOME, { recursive: true });
  const manifest = loadInstalledManifest();
  manifest[depId] = { version, installedAt: new Date().toISOString() };
  fs.writeFileSync(INSTALLED_MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
}

function getInstalledVersion(depId: string): string | null {
  return loadInstalledManifest()[depId]?.version ?? null;
}

function getExpectedVersion(depId: string, platKey: string): string | null {
  const m = _binManifest as Record<string, unknown>;
  const deps = m['deps'] as Record<string, { version: string }> | undefined;
  if (deps?.[depId]?.version) return deps[depId].version;
  const platData = m[platKey] as Record<string, string> | undefined;
  if (depId === 'llama-server' || depId === 'llama-cudart') return platData?.['llama'] ?? null;
  if (depId.startsWith('sd-server') || depId === 'sd-cudart') return platData?.['sd'] ?? null;
  return null;
}

// isPrepComplete is intentionally always false — runDepPrep handles the fast-path
// internally by comparing installed versions against bin-manifest.json.
// Only deps that are missing or at a stale version are re-downloaded.
export function isPrepComplete(): boolean {
  return process.env.PHOBOS_SKIP_DEP_PREP === '1';
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

  // Version constants from bin-manifest.json — bump the manifest to trigger re-downloads.
  const _platKey  = `${process.platform}-${process.arch}`;
  const _bm       = _binManifest as Record<string, Record<string, string>>;
  const _platVers = _bm[_platKey] ?? _bm['win32-x64'] ?? {};
  const LLAMA_VER = _platVers['llama'] ?? 'b8989';
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
    if (isWin) return `llama-${LLAMA_VER}-bin-win-vulkan-x64.zip`;
    if (isMac && arch === 'darwin-arm64') return `llama-${LLAMA_VER}-bin-macos-arm64.tar.gz`;
    if (isMac) return `llama-${LLAMA_VER}-bin-macos-x64.tar.gz`;
    if (arch === 'linux-arm64') return `llama-${LLAMA_VER}-linux-arm64.tar.gz`;
    return `llama-${LLAMA_VER}-bin-ubuntu-vulkan-x64.tar.gz`;
  }

  // ── Version constants from bin-manifest.json ────────────────────────────
  const platKey  = `${process.platform}-${process.arch}` as string;
  const _m       = _binManifest as Record<string, Record<string, string>>;
  const _pd      = _m[platKey] ?? _m['win32-x64'] ?? {};
  const SD_VER   = _pd['sd'] ?? 'master-3d6064b';
  const SD_HASH  = SD_VER.split('-').pop() ?? '3d6064b';

  function sdArchiveForVariant2(variant: 'vulkan' | 'cuda' | 'rocm' | 'cpu'): string {
    if (isWin) {
      if (variant === 'cpu') return `sd-master-${SD_HASH}-bin-win-avx2-x64.zip`;
      return `sd-master-${SD_HASH}-bin-win-${variant === 'cuda' ? 'cuda12' : variant}-x64.zip`;
    }
    if (isMac && arch === 'darwin-arm64') return `sd-master-${SD_HASH}-bin-Darwin-macOS-15.7.4-arm64.zip`;
    if (variant === 'rocm') return `sd-master-${SD_HASH}-bin-Linux-Ubuntu-24.04-x86_64-rocm.zip`;
    return `sd-master-${SD_HASH}-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip`;
  }

  // ── Service dirs ──────────────────────────────────────────────────────────
  const jellyfinDir = path.join(SERVICES_DIR, 'jellyfin');
  const kavitaDir   = path.join(SERVICES_DIR, 'kavita');
  const polarisDir  = path.join(SERVICES_DIR, 'polaris');
  const stirlingDir = path.join(SERVICES_DIR, 'stirling');

  // ── Jellyfin archive + probe per platform ─────────────────────────────────
  function jellyfinDep(): Dep {
    if (isWin) return {
      id: 'jellyfin', label: 'Jellyfin Media Server',
      file: 'jellyfin_10.11.8-amd64.zip', minBytes: 120_000_000,
      isPresent: () => serviceInstalled(jellyfinDir, 'jellyfin.dll', 100_000),
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

      // On Linux arm64, the archive ships shared libs (.so.*) that llama-server
      // links against at runtime. Copy them into BIN_DIR alongside the binary.
      if (isLinux) {
        const srcDir = path.dirname(found);
        for (const name of fs.readdirSync(srcDir)) {
          if (name.endsWith('.so') || name.includes('.so.')) {
            const src = path.join(srcDir, name);
            if (fs.statSync(src).isFile()) {
              fs.copyFileSync(src, path.join(BIN_DIR, name));
            }
          }
        }
      }

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

  // ── sd-server variants ────────────────────────────────────────────────────
  //
  // Stable Diffusion ships as four distinct binaries on Windows, each isolated
  // in its own subdir to keep ggml DLL versions from colliding. PhobosLocal's
  // sd-server resolver looks for them in:
  //
  //   bin/sd-vulkan/sd-server-win32-x64.exe       — Vulkan (any GPU)
  //   bin/sd-cuda/sd-server-win32-x64-cuda.exe    — NVIDIA CUDA
  //   bin/sd-cpu/sd-server-win32-x64-cpu.exe      — CPU AVX2 fallback
  //   bin/sd-rocm/sd-server-win32-x64-rocm.exe    — AMD ROCm
  //
  // The release archive's binary is named `sd-cli.exe` (preferred) with
  // legacy fallbacks to `sd.exe` and `sd-server.exe` — same precedence as
  // scripts/fetch-sd-cpp.js. All `.dll` files in the archive are copied
  // alongside the renamed binary so ggml-vulkan.dll / ggml-hip.dll etc. are
  // adjacent to the .exe that loads them.
  //
  // Linux/macOS use a single binary (Linux gets vulkan, macOS gets the arm64
  // build); we don't proliferate variants there. ROCm on Linux is reserved
  // for a future addition.

  type SdVariant = 'vulkan' | 'cuda' | 'cpu' | 'rocm';

  /** Where each Windows variant's renamed binary lands. */
  const sdWinBinPath = (variant: SdVariant): string => {
    const subdir = `sd-${variant}`;
    const exe    = variant === 'vulkan'
      ? 'sd-server-win32-x64.exe'                  // bare name — matches PhobosLocal Vulkan probe
      : `sd-server-win32-x64-${variant}.exe`;
    return path.join(BIN_DIR, subdir, exe);
  };

  /** Build a Dep for one Windows variant. */
  function sdWindowsVariantDep(variant: SdVariant): Dep {
    const destDir   = path.join(BIN_DIR, `sd-${variant}`);
    const finalExe  = sdWinBinPath(variant);
    const archive   = sdArchiveForVariant2(variant);

    return {
      id: `sd-server-${variant}`, label: `Image Generation Server (${variant})`,
      file: archive, minBytes: 5_000_000,
      isPresent: () => { try { return fs.statSync(finalExe).size >= 500_000; } catch { return false; } },
      install: async (arc) => {
        const tmp = arc + '-extract';
        fs.mkdirSync(tmp, { recursive: true });
        await extractTarAny(arc, tmp);

        const serverBin = findFile(tmp, 'sd-cli.exe')
                       ?? findFile(tmp, 'sd.exe')
                       ?? findFile(tmp, 'sd-server.exe');
        if (!serverBin) throw new Error(`sd binary not found in ${archive}`);

        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(serverBin, finalExe);

        // Copy every .dll sitting next to the binary into the variant dir.
        // Each variant carries its own ggml-*.dll set and must NOT mix with
        // the other variants' DLLs (different ggml versions, would crash).
        for (const dll of fs.readdirSync(path.dirname(serverBin))) {
          if (!dll.toLowerCase().endsWith('.dll')) continue;
          const src = path.join(path.dirname(serverBin), dll);
          if (fs.statSync(src).isFile()) {
            fs.copyFileSync(src, path.join(destDir, dll));
          }
        }

        fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  }

  /** CUDA runtime DLLs (cudart/cublas/cublasLt) for the SD CUDA variant. */
  const sdCudaRtDep: Dep | null = isWin ? {
    id: 'sd-cudart', label: 'SD CUDA Runtime DLLs',
    file: 'cudart-sd-bin-win-cu12-x64.zip', minBytes: 50_000_000,
    isPresent: () => fs.existsSync(path.join(BIN_DIR, 'sd-cuda', 'cublas64_12.dll')),
    install: async (arc) => {
      const destDir = path.join(BIN_DIR, 'sd-cuda');
      fs.mkdirSync(destDir, { recursive: true });
      const tmp = arc + '-extract';
      fs.mkdirSync(tmp, { recursive: true });
      await extractZip(arc, tmp);

      // Only the three runtime DLLs land here — sd-cli links cublas at runtime,
      // and cublasLt is a transitive dep of cublas (without it the loader
      // returns STATUS_DLL_NOT_FOUND / 0xC0000135).
      const required = ['cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll'];
      for (const fname of fs.readdirSync(tmp, { recursive: true }) as string[]) {
        if (typeof fname !== 'string') continue;
        const base = path.basename(fname);
        if (!required.includes(base)) continue;
        const src = path.join(tmp, fname);
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, path.join(destDir, base));
        }
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  } : null;

  /** Linux/macOS single-binary install — Vulkan on Linux, arm64 universal on macOS. */
  const sdUnixDep: Dep | null = !isWin ? (() => {
    const sdBinPath = path.join(BIN_DIR, `sd-server-${process.platform}-${process.arch}`);
    return {
      id: 'sd-server', label: 'Image Generation Server',
      file: sdArchiveForVariant2('vulkan'), minBytes: 1_000_000,
      isPresent: () => { try { return fs.statSync(sdBinPath).size >= 500_000; } catch { return false; } },
      install: async (arc) => {
        const tmp = arc + '-extract';
        fs.mkdirSync(tmp, { recursive: true });
        await extractTarAny(arc, tmp);

        const serverBin = findFile(tmp, 'sd-cli')
                       ?? findFile(tmp, 'sd')
                       ?? findFile(tmp, 'sd-server');
        if (!serverBin) throw new Error(`sd binary not found in ${arc}`);
        fs.copyFileSync(serverBin, sdBinPath);
        fs.chmodSync(sdBinPath, 0o755);

        fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  })() : null;

  // The four Windows variants resolve as separate Deps so the manifest can
  // track each one's installed version independently — bumping the SD hash
  // re-fetches all four (they share the same upstream tag).
  const sdWinDeps: Dep[] = isWin
    ? [
        sdWindowsVariantDep('vulkan'),
        sdWindowsVariantDep('cuda'),
        sdWindowsVariantDep('cpu'),
        sdWindowsVariantDep('rocm'),
      ]
    : [];

  // ── PhobosHost — in-house JUCE-based VST3 host (replaces Carla) ─────────
  //
  // Ships per-platform: win-x64 as flat .zip with PhobosHost.exe at root;
  // mac/linux as .tar.gz with PhobosHost binary at root. Lives at
  // ~/.phobos/services/phobos-host/ where PhobosHostManager looks for it.
  //
  // The win-x64 zip is current; mac/linux tarballs are reserved names —
  // upload them to the PHOBOS-DEPS release with these exact filenames when
  // ready and they'll start fetching automatically on next boot.
  function phobosHostDep(): Dep | null {
    const hostDir   = path.join(SERVICES_DIR, 'phobos-host');
    const exeName   = isWin ? 'PhobosHost.exe' : 'PhobosHost';
    const exePath   = path.join(hostDir, exeName);

    const filenames: Record<PhobosArch, string> = {
      'win32-x64':    'PhobosHost-win-x64.zip',
      'darwin-arm64': 'PhobosHost-darwin-arm64.tar.gz',
      'darwin-x64':   'PhobosHost-darwin-x64.tar.gz',
      'linux-x64':    'PhobosHost-linux-x64.tar.gz',
      'linux-arm64':  'PhobosHost-linux-arm64.tar.gz',
    };
    const file = filenames[arch];
    if (!file) return null;

    return {
      id: 'phobos-host', label: 'PhobosHost VST3 Host',
      file, minBytes: 1_000_000,
      isPresent: () => {
        try { return fs.statSync(exePath).size >= 500_000; } catch { return false; }
      },
      install: async (arc) => {
        fs.mkdirSync(hostDir, { recursive: true });
        const tmp = arc + '-extract';
        fs.mkdirSync(tmp, { recursive: true });
        // extractTarAny handles .zip and .tar.gz transparently.
        await extractTarAny(arc, tmp);

        const found = findFile(tmp, exeName);
        if (!found) throw new Error(`${exeName} not found in ${file}`);
        fs.copyFileSync(found, exePath);
        if (!isWin) fs.chmodSync(exePath, 0o755);

        // Stage any side-by-side runtime files (DLLs on Win, .so on Linux,
        // .dylib on Mac) next to the binary so the OS loader can find them.
        const srcDir = path.dirname(found);
        for (const name of fs.readdirSync(srcDir)) {
          if (name === exeName) continue;
          if (/\.(dll|so|dylib)$/i.test(name)) {
            const src = path.join(srcDir, name);
            if (fs.statSync(src).isFile()) {
              fs.copyFileSync(src, path.join(hostDir, name));
            }
          }
        }

        fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  }

  // ── PhobosCrystal — in-house global FX VST3 ─────────────────────────────
  //
  // Crystal is a VST3 bundle (cross-platform layout). The win-x64 zip
  // contains PhobosCrystal.vst3/Contents/x86_64-win/PhobosCrystal.vst3
  // (the inner one is the actual DLL on Windows). On other platforms the
  // bundle contains MacOS/PhobosCrystal or x86_64-linux/PhobosCrystal.so
  // respectively. We extract the whole bundle into the plugins dir and let
  // PhobosHost discover it via its plugin scanner.
  function phobosCrystalDep(): Dep {
    const pluginsDir = path.join(SERVICES_DIR, 'phobos-host', 'plugins');
    const bundleDir  = path.join(pluginsDir, 'PhobosCrystal.vst3');

    return {
      id: 'phobos-crystal', label: 'PhobosCrystal VST3',
      file: 'PhobosCrystal.vst3.zip', minBytes: 100_000,
      isPresent: () => {
        try { return fs.statSync(bundleDir).isDirectory(); } catch { return false; }
      },
      install: async (arc) => {
        fs.mkdirSync(pluginsDir, { recursive: true });
        // The zip already contains a PhobosCrystal.vst3/ folder at root —
        // extract directly into pluginsDir and the bundle drops in place.
        // Remove any existing bundle first so we don't merge old + new files.
        if (fs.existsSync(bundleDir)) fs.rmSync(bundleDir, { recursive: true, force: true });
        await extractZip(arc, pluginsDir);
        if (!fs.existsSync(bundleDir)) {
          throw new Error('PhobosCrystal.vst3/ folder not present after extracting PhobosCrystal.vst3.zip');
        }
      },
    };
  }

  // ── Helm VST3 synth ───────────────────────────────────────────────────────
  function helmDep(): Dep | null {
    const helmDir = path.join(SERVICES_DIR, 'helm');
    if (isWin) return {
      id: 'helm', label: 'Helm VST3 Synth',
      file: 'Helm_64bit_v0_9_0_r.msi', minBytes: 4_000_000,
      isPresent: () => serviceInstalled(helmDir, 'VST3/Helm/helm64.vst3', 1_000_000),
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
      isPresent: () => serviceInstalled(helmDir, 'Helm.vst3/Contents/MacOS/Helm', 100_000),
      install: async (arc) => {
        fs.mkdirSync(helmDir, { recursive: true });
        await execFileAsync('installer', ['-pkg', arc, '-target', helmDir], { timeout: 120_000 });
      },
    };
    // Linux — deb package; extract without system install
    return {
      id: 'helm', label: 'Helm VST3 Synth',
      file: 'helm_0.9.0_amd64_r.deb', minBytes: 2_000_000,
      isPresent: () => serviceInstalled(helmDir, 'helm.vst3/Contents/x86_64-linux/helm.so', 100_000),
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
    ...sdWinDeps,           // 4 deps on Windows, 0 elsewhere
    sdCudaRtDep,            // CUDA runtime DLLs for sd-cuda/ (Windows only)
    sdUnixDep,              // single-binary install for Linux/macOS
    jellyfinDep(),
    kavitaDep(),
    polarisDep(),
    stirlingDep,
    helmDep(),
    phobosHostDep(),
    phobosCrystalDep(),
    pandocDep(),
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
  if (process.env.PHOBOS_SKIP_DEP_PREP === '1') return;

  const arch    = detectArch();
  const platKey = `${process.platform}-${process.arch}`;
  const deps    = buildDeps(arch);
  const tmp     = path.join(PHOBOS_HOME, 'dep-prep-downloads');
  fs.mkdirSync(tmp, { recursive: true });

  // Determine which deps actually need work: missing binary OR version mismatch.
  const needsWork = deps.filter(dep => {
    if (!dep.isPresent()) return true;                          // binary missing
    const expected = getExpectedVersion(dep.id, platKey);
    if (!expected) return false;                                // no version tracked — presence check only
    const installed = getInstalledVersion(dep.id);
    if (installed === null) {
      // Binary is present but was installed before the manifest system existed.
      // Adopt the current expected version so future bumps are detected correctly.
      markDepInstalled(dep.id, expected);
      return false;
    }
    if (installed !== expected) {
      console.log(`[DepPrep] ${dep.id}: installed=${installed} expected=${expected} — will update`);
      return true;
    }
    return false;
  });

  if (needsWork.length === 0) {
    // Everything is present and at correct versions — fast path
    onEvent({ phase: 'prep_complete' });
    return;
  }

  onEvent({ phase: 'prep_start', depsTotal: needsWork.length, depsDone: 0 });

  let done = 0;
  for (const dep of needsWork) {
    onEvent({ phase: 'dep_start', dep: dep.label, file: dep.file, depsDone: done, depsTotal: needsWork.length });

    const archivePath = path.join(tmp, dep.file);

    // Download if not already in the temp dir at the right size
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
        continue;
      }
    }

    // Extract / install
    onEvent({ phase: 'extract_start', dep: dep.label, file: dep.file });
    try {
      await dep.install(archivePath);
      // Record installed version so future boots can detect staleness
      const version = getExpectedVersion(dep.id, platKey);
      if (version) markDepInstalled(dep.id, version);
      onEvent({ phase: 'extract_done', dep: dep.label });
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[DepPrep] Install failed for ${dep.id}: ${msg}`);
      onEvent({ phase: 'dep_error', dep: dep.label, file: dep.file, error: msg });
      continue;
    }

    onEvent({ phase: 'dep_done', dep: dep.label, depsDone: ++done, depsTotal: needsWork.length });
  }

  // Clean up temp downloads
  fs.rmSync(tmp, { recursive: true, force: true });

  onEvent({ phase: 'prep_complete' });
}