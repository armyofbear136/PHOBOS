import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { detectHardware, type GpuDevice } from './PhobosLocalManager.js';

const execFileAsync = promisify(execFile);

// ── Constants ────────────────────────────────────────────────────────────────

/** Root directory for all PyTorch virtual environments. */
function PYTHON_ENV_ROOT(): string {
  return path.join(os.homedir(), '.phobos', 'python-env');
}

/** Minimum Python version required for PyTorch XPU support. */
const MIN_PYTHON_MAJOR = 3;
const MIN_PYTHON_MINOR = 10;

/** Manifest file written after successful install. */
const ENV_MANIFEST = 'phobos-env.json';

/** Direct download links for users who need to install Python. */
export const PYTHON_INSTALL_LINKS = {
  windows: 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe',
  mac:     'https://www.python.org/ftp/python/3.12.10/python-3.12.10-macos11.pkg',
  linux:   'sudo apt install python3 python3-venv python3-pip',
} as const;

const PYTHON_312_WIN_URL = 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe';

/**
 * Returns true only if the detected Python is exactly 3.12.x.
 * AMD ROCm Windows wheels are cp312-only — 3.11 and 3.13 will not work.
 */
export function isPython312(det: PythonDetection): boolean {
  if (!det.found || !det.version) return false;
  const parts = det.version.split('.');
  return parseInt(parts[1], 10) === 12;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type GpuVendor = 'cuda' | 'rocm' | 'xpu' | 'apple' | 'cpu';

export interface PythonDetection {
  found: boolean;
  version: string | null;
  path: string | null;
}

export interface VendorEnvStatus {
  vendor: GpuVendor;
  /** Whether this vendor's venv exists and packages are ready */
  ready: boolean;
  /** Installed torch version, null if not ready */
  torchVersion: string | null;
  /** Whether torch can see a GPU for this vendor */
  gpuAvailable: boolean;
  /** Disk usage in bytes, 0 if not installed */
  diskBytes: number;
  /** True if the env exists but was built against an older package version — needs update */
  stale: boolean;
}

export interface PythonEnvStatus {
  /** System Python detection result */
  python: PythonDetection;
  /** Per-vendor environment status */
  vendors: VendorEnvStatus[];
}

export interface InstallProgress {
  phase: 'detect' | 'venv' | 'torch' | 'packages' | 'verify' | 'configs' | 'complete' | 'error';
  vendor: GpuVendor;
  label: string;
  /** 0.0–1.0 within current phase, -1 for indeterminate */
  progress: number;
  done: boolean;
  error?: string;
}

interface EnvManifest {
  vendor: GpuVendor;
  torchVersion: string;
  torchIndex: string;
  pythonVersion: string;
  timestamp: string;
  /** Integer version stamped at install time. Missing = 1 (pre-versioning). Compared against REQUIRED_ENV_VERSION to detect stale envs. */
  envVersion?: number;
}

// ── Required env version ──────────────────────────────────────────────────────
// Bump this integer whenever the diffusers/transformers/torch pins change in a
// way that requires users to rebuild their Python env. The installed env's
// phobos-env.json stores the version it was built with. Mismatch → stale banner.
//
// Version history:
//   1 — initial (diffusers <0.34, transformers <5.0)
//   2 — diffusers >=0.36 (ZImagePipeline), transformers <4.52 (SDXL from_pretrained)
//   3 — exact pins: diffusers==0.36.0, transformers==4.51.3, safetensors==0.4.5
//       (cascade prevention). transformers 4.51.3 wheel had bad modeling_utils.py.
//   4 — transformers==4.54.0: Qwen3 GGUF support lands in GGUF_CONFIG_MAPPING.
//       DTensor import now properly guarded — no patch needed on ROCm Windows.
const REQUIRED_ENV_VERSION = 4;

// ── Module state ─────────────────────────────────────────────────────────────

/** Cached system Python detection. Null until first check. */
let _pythonCache: PythonDetection | null = null;

/** Per-vendor install locks. Prevents concurrent installs of the same vendor. */
const _installingVendors = new Set<GpuVendor>();

// ── Python detection ─────────────────────────────────────────────────────────

/**
 * Searches for a usable Python ≥ 3.10 binary on the system.
 *
 * Priority (Windows):
 *   1. python.org standard install paths (AppData\Local\Programs\Python\...)
 *   2. python / python3 on PATH (may be conda, pyenv, etc.)
 *   Standalone python.org installs are preferred because conda/pyenv Python
 *   can have issues with venv creation and package isolation.
 *
 * Priority (Linux/macOS):
 *   1. python3 / python on PATH
 *   2. Homebrew paths (macOS)
 *
 * On all platforms, if the resolved path contains 'conda' or 'miniforge' or
 * 'miniconda' or 'anaconda', the candidate is deprioritized — we record it
 * as a fallback but keep searching for a standalone install.
 */
async function findSystemPython(): Promise<PythonDetection> {
  if (_pythonCache) return _pythonCache;

  const candidates: string[] = [];

  if (process.platform === 'win32') {
    // Check python.org install paths FIRST
    const localAppData = process.env.LOCALAPPDATA ?? '';
    if (localAppData) {
      for (let minor = 14; minor >= MIN_PYTHON_MINOR; minor--) {
        candidates.push(path.join(localAppData, 'Programs', 'Python', `Python3${minor}`, 'python.exe'));
      }
    }
    const progFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    for (let minor = 14; minor >= MIN_PYTHON_MINOR; minor--) {
      candidates.push(path.join(progFiles, `Python3${minor}`, 'python.exe'));
    }
    // Fall back to PATH-resolved commands
    candidates.push('python', 'python3');
  } else {
    candidates.push('python3', 'python');
    if (process.platform === 'darwin') {
      candidates.push('/opt/homebrew/bin/python3', '/usr/local/bin/python3');
    }
  }

  let condaFallback: PythonDetection | null = null;

  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate, ['--version'], { timeout: 5000 });
      const match = stdout.trim().match(/Python\s+(\d+)\.(\d+)\.(\d+)/);
      if (!match) continue;

      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);
      if (major < MIN_PYTHON_MAJOR) continue;
      if (major === MIN_PYTHON_MAJOR && minor < MIN_PYTHON_MINOR) continue;

      const version = `${match[1]}.${match[2]}.${match[3]}`;

      let fullPath = candidate;
      if (!path.isAbsolute(candidate)) {
        try {
          const whichCmd = process.platform === 'win32' ? 'where' : 'which';
          const { stdout: which } = await execFileAsync(whichCmd, [candidate], { timeout: 3000 });
          const first = which.trim().split('\n')[0].trim();
          if (first) fullPath = first;
        } catch { /* keep the relative candidate */ }
      }

      const isConda = /conda|miniforge|miniconda|anaconda/i.test(fullPath);
      if (isConda) {
        if (!condaFallback) {
          condaFallback = { found: true, version, path: fullPath };
          console.log(`[PythonEnvManager] Found conda Python ${version} at ${fullPath} — deprioritized`);
        }
        continue;
      }

      const result: PythonDetection = { found: true, version, path: fullPath };
      _pythonCache = result;
      return result;
    } catch {
      // Candidate not found — try next
    }
  }

  if (condaFallback) {
    console.log(`[PythonEnvManager] No standalone Python found — using conda fallback: ${condaFallback.path}`);
    _pythonCache = condaFallback;
    return condaFallback;
  }

  const result: PythonDetection = { found: false, version: null, path: null };
  _pythonCache = result;
  return result;
}

// ── Vendor mapping ───────────────────────────────────────────────────────────

/** Maps a GpuDevice to its PyTorch vendor. */
export function gpuToVendor(gpu: GpuDevice): GpuVendor {
  if (gpu.backend === 'cuda') return 'cuda';
  if (gpu.backend === 'metal') return 'apple';

  const isAmd = /AMD|Radeon|ATI/i.test(gpu.name);
  const isIntelArc = /Intel.*Arc/i.test(gpu.name);

  // AMD iGPUs (890M, 780M) on Windows use the same ROCm path as discrete cards.
  // The AI drivers bundle installs ROCm 7.2 system-wide and the torch+rocmsdk
  // wheels bundle their own DLLs — unified memory is not a blocker.
  if (isAmd) return 'rocm';
  if (isIntelArc) return 'xpu';

  // Intel iGPU, unknown
  return 'cpu';
}

// AMD Windows ROCm 7.2 wheel base URL.
// torch version: 2.9.1+rocmsdk20260116  (Python 3.12 only)
// These are direct wheel downloads — no index URL, no pip --find-links needed.
const AMD_ROCM_WIN_BASE = 'https://repo.radeon.com/rocm/windows/rocm-rel-7.2';

/** Returns the PyTorch pip index URL for a vendor.
 *  Windows ROCm is special: wheels come from AMD direct URLs, not a pip index.
 *  That path is handled by installRocmWindowsTorch() — this function returns
 *  the Linux index URL for ROCm (used on Linux only). */
function vendorIndexUrl(vendor: GpuVendor): string {
  switch (vendor) {
    case 'cuda':  return 'https://download.pytorch.org/whl/cu121';
    case 'rocm':  return process.platform === 'win32'
                    ? AMD_ROCM_WIN_BASE  // stored in manifest for reference only
                    : 'https://download.pytorch.org/whl/rocm7.2';
    case 'xpu':   return 'https://download.pytorch.org/whl/xpu';
    case 'apple': return '';  // default PyPI — MPS built into standard wheel
    case 'cpu':   return '';  // default PyPI — CPU-only
  }
}

/** Human-readable label for a vendor. */
export function vendorLabel(vendor: GpuVendor): string {
  switch (vendor) {
    case 'cuda':  return 'NVIDIA CUDA';
    case 'rocm':  return 'AMD ROCm';
    case 'xpu':   return 'Intel XPU';
    case 'apple': return 'Apple Metal';
    case 'cpu':   return 'CPU';
  }
}

// ── Per-vendor venv paths ────────────────────────────────────────────────────

/** Returns the venv directory for a vendor. */
function vendorDir(vendor: GpuVendor): string {
  return path.join(PYTHON_ENV_ROOT(), vendor);
}

/** Returns the Python binary path inside a vendor's venv. */
function vendorPython(vendor: GpuVendor): string {
  const dir = vendorDir(vendor);
  return process.platform === 'win32'
    ? path.join(dir, 'Scripts', 'python.exe')
    : path.join(dir, 'bin', 'python3');
}

/** Returns the configs directory path (shared across all vendors). */
export function getConfigDir(): string {
  return path.join(PYTHON_ENV_ROOT(), 'configs');
}

// ── Manifest ─────────────────────────────────────────────────────────────────

function readManifest(vendor: GpuVendor): EnvManifest | null {
  const p = path.join(vendorDir(vendor), ENV_MANIFEST);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!raw.vendor || !raw.torchVersion || !raw.timestamp) return null;
    return raw as EnvManifest;
  } catch {
    return null;
  }
}

function writeManifest(vendor: GpuVendor, manifest: EnvManifest): void {
  const p = path.join(vendorDir(vendor), ENV_MANIFEST);
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2));
}

// ── Health checks ────────────────────────────────────────────────────────────

async function runVenvCheck(vendor: GpuVendor, script: string, timeoutMs = 30_000): Promise<string | null> {
  const pyBin = vendorPython(vendor);
  if (!fs.existsSync(pyBin)) return null;
  try {
    const { stdout } = await execFileAsync(pyBin, ['-c', script], { timeout: timeoutMs });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function checkTorchVersion(vendor: GpuVendor, timeoutMs = 30_000): Promise<string | null> {
  return runVenvCheck(vendor, 'import torch; print(torch.__version__)', timeoutMs);
}

async function checkGpuAvailable(vendor: GpuVendor): Promise<boolean> {
  let script: string;
  switch (vendor) {
    case 'cuda':
    case 'rocm':
      script = 'import torch; print(torch.cuda.is_available())';
      break;
    case 'xpu':
      script = 'import torch; print(hasattr(torch, "xpu") and torch.xpu.is_available())';
      break;
    case 'apple':
      script = 'import torch; print(hasattr(torch.backends, "mps") and torch.backends.mps.is_available())';
      break;
    default:
      return false;
  }
  return (await runVenvCheck(vendor, script)) === 'True';
}

async function checkPackagesReady(vendor: GpuVendor, timeoutMs = 30_000): Promise<boolean> {
  const script = 'import torch; import diffusers; import transformers; import accelerate; import safetensors; print("ok")';
  return (await runVenvCheck(vendor, script, timeoutMs)) === 'ok';
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Returns true if the vendor's env exists but was built against an older package version set. */
export function isEnvStale(vendor: GpuVendor): boolean {
  if (vendor === 'cpu') {
    for (const v of ['cuda', 'rocm', 'xpu', 'apple'] as const) {
      if (isVendorReady(v)) return isEnvStale(v);
    }
    return false;
  }
  const manifest = readManifest(vendor);
  if (!manifest) return false; // not installed — not stale
  return (manifest.envVersion ?? 1) < REQUIRED_ENV_VERSION;
}

/** Synchronous check: is a vendor's venv ready? Reads manifest file only — no subprocess. */
export function isVendorReady(vendor: GpuVendor): boolean {
  // CPU reuses any available GPU vendor venv — torch CPU works from all builds.
  if (vendor === 'cpu') {
    for (const v of ['cuda', 'rocm', 'xpu', 'apple'] as const) {
      if (isVendorReady(v)) return true;
    }
    return false;
  }
  const manifestPath = path.join(vendorDir(vendor), ENV_MANIFEST);
  try {
    return fs.existsSync(manifestPath) && fs.existsSync(vendorPython(vendor));
  } catch {
    return false;
  }
}

/** Synchronous check: given a GpuDevice, is PyTorch ready for it? */
export function isReadyForGpu(gpu: GpuDevice): boolean {
  return isVendorReady(gpuToVendor(gpu));
}

/** Returns the Python binary path for a vendor's venv, or null if not installed. */
export function getPythonPath(vendor: GpuVendor): string | null {
  // CPU fallback: find any installed vendor venv
  if (vendor === 'cpu') {
    for (const v of ['cuda', 'rocm', 'xpu', 'apple'] as const) {
      const p = getPythonPath(v);
      if (p) return p;
    }
    return null;
  }
  const p = vendorPython(vendor);
  return fs.existsSync(p) ? p : null;
}

/** Returns the Python binary path for a specific GPU device. */
export function getPythonPathForGpu(gpu: GpuDevice): string | null {
  return getPythonPath(gpuToVendor(gpu));
}

/** Returns true if an install is in progress for any vendor. */
export function isInstalling(): boolean {
  return _installingVendors.size > 0;
}

/** Returns true if an install is in progress for a specific vendor. */
export function isInstallingVendor(vendor: GpuVendor): boolean {
  return _installingVendors.has(vendor);
}

/** Returns system Python detection result. */
export async function detectPython(): Promise<PythonDetection> {
  return findSystemPython();
}

/** Invalidates cached Python detection (call if user installs Python). */
export function invalidatePythonCache(): void {
  _pythonCache = null;
}

/**
 * Returns full status: system Python + per-vendor environment readiness.
 * Only checks vendors for GPUs that are actually present on the system.
 */
export async function getStatus(): Promise<PythonEnvStatus> {
  const python = await findSystemPython();

  // Determine which vendors are relevant based on detected hardware
  const hw = await detectHardware();
  const relevantVendors = new Set<GpuVendor>();
  for (const gpu of hw.gpus) {
    relevantVendors.add(gpuToVendor(gpu));
  }

  const vendors: VendorEnvStatus[] = [];
  for (const vendor of relevantVendors) {
    if (vendor === 'cpu') continue; // CPU reuses GPU venvs

    const ready = isVendorReady(vendor);
    let torchVersion: string | null = null;
    let gpuAvailable = false;
    let diskBytes = 0;

    if (ready) {
      torchVersion = await checkTorchVersion(vendor);
      gpuAvailable = await checkGpuAvailable(vendor);
      try {
        diskBytes = await getDiskUsage(vendor);
      } catch { /* ignore */ }
    }

    vendors.push({ vendor, ready, torchVersion, gpuAvailable, diskBytes, stale: isEnvStale(vendor) });
  }

  return { python, vendors };
}

/**
 * Returns all GPU vendors detected on the system with their PyTorch readiness.
 * Lightweight — uses manifest checks only, no subprocess calls.
 */
export async function getVendorReadiness(): Promise<Array<{ vendor: GpuVendor; label: string; ready: boolean; gpuName: string; stale: boolean }>> {
  const hw = await detectHardware();
  const seen = new Map<GpuVendor, string>(); // vendor → first GPU name

  for (const gpu of hw.gpus) {
    const vendor = gpuToVendor(gpu);
    if (vendor === 'cpu') continue;
    if (!seen.has(vendor)) seen.set(vendor, gpu.name);
  }

  return [...seen.entries()].map(([vendor, gpuName]) => ({
    vendor,
    label: vendorLabel(vendor),
    ready: isVendorReady(vendor),
    gpuName,
    stale: isEnvStale(vendor),
  }));
}

// ── Install ──────────────────────────────────────────────────────────────────

/**
 * Creates the venv and installs PyTorch + Diffusers for a specific vendor.
 * Yields progress events. Idempotent — skips quickly if already installed.
 */
export async function* install(vendor: GpuVendor): AsyncGenerator<InstallProgress> {
  if (_installingVendors.has(vendor)) {
    yield { phase: 'error', vendor, label: `Install for ${vendorLabel(vendor)} already in progress`, progress: -1, done: true, error: 'Already installing' };
    return;
  }
  _installingVendors.add(vendor);

  try {
    // ── Phase: detect ──────────────────────────────────────────────────────
    yield { phase: 'detect', vendor, label: 'Detecting Python…', progress: 0, done: false };

    const sysPy = await findSystemPython();
    if (!sysPy.found || !sysPy.path) {
      const msg = `Python ≥ ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR} not found. ` +
        (process.platform === 'win32'
          ? `Install from ${PYTHON_INSTALL_LINKS.windows} — check "Add Python to PATH".`
          : process.platform === 'darwin'
            ? `Install from ${PYTHON_INSTALL_LINKS.mac}`
            : `Run: ${PYTHON_INSTALL_LINKS.linux}`);
      yield { phase: 'error', vendor, label: msg, progress: -1, done: true, error: msg };
      return;
    }

    console.log(`[PythonEnvManager] Python ${sysPy.version} at ${sysPy.path} — installing ${vendorLabel(vendor)} environment`);
    yield { phase: 'detect', vendor, label: `Python ${sysPy.version} — ${vendorLabel(vendor)}`, progress: 1.0, done: false };

    // ── Phase: venv ────────────────────────────────────────────────────────
    const dir = vendorDir(vendor);
    const pyBin = vendorPython(vendor);

    if (!fs.existsSync(pyBin)) {
      yield { phase: 'venv', vendor, label: 'Creating virtual environment…', progress: 0, done: false };
      fs.mkdirSync(dir, { recursive: true });

      try {
        await execFileAsync(sysPy.path, ['-m', 'venv', dir], { timeout: 60_000 });
      } catch (err) {
        const msg = `Failed to create venv: ${(err as Error).message}. ` +
          (process.platform === 'linux'
            ? 'You may need: sudo apt install python3-venv'
            : 'Check that your Python installation includes the venv module.');
        yield { phase: 'error', vendor, label: msg, progress: -1, done: true, error: msg };
        return;
      }

      if (!fs.existsSync(pyBin)) {
        const msg = 'venv created but Python binary not found';
        yield { phase: 'error', vendor, label: msg, progress: -1, done: true, error: msg };
        return;
      }

      console.log(`[PythonEnvManager] venv created at ${dir}`);
      yield { phase: 'venv', vendor, label: 'Virtual environment created', progress: 1.0, done: false };
    } else {
      yield { phase: 'venv', vendor, label: 'Virtual environment exists', progress: 1.0, done: false };
    }

    // Upgrade pip
    try {
      await execFileAsync(pyBin, ['-m', 'pip', 'install', '--upgrade', 'pip'], { timeout: 120_000 });
    } catch {
      console.warn('[PythonEnvManager] pip upgrade failed — continuing');
    }

    // ── Phase: torch ───────────────────────────────────────────────────────
    yield { phase: 'torch', vendor, label: `Installing PyTorch (${vendorLabel(vendor)})…`, progress: -1, done: false };

    const indexUrl = vendorIndexUrl(vendor);
    const torchResult = await installTorchPackages(pyBin, vendor, indexUrl);
    if (!torchResult.ok) {
      yield { phase: 'error', vendor, label: torchResult.error!, progress: -1, done: true, error: torchResult.error! };
      return;
    }
    yield { phase: 'torch', vendor, label: 'PyTorch installed', progress: 1.0, done: false };

    // ── Phase: packages ────────────────────────────────────────────────────
    yield { phase: 'packages', vendor, label: 'Installing diffusers stack…', progress: -1, done: false };

    const pkgResult = await installDiffusersStack(pyBin);
    if (!pkgResult.ok) {
      yield { phase: 'error', vendor, label: pkgResult.error!, progress: -1, done: true, error: pkgResult.error! };
      return;
    }
    yield { phase: 'packages', vendor, label: 'Diffusers stack installed', progress: 1.0, done: false };

    // ── Phase: verify ──────────────────────────────────────────────────────
    yield { phase: 'verify', vendor, label: 'Verifying…', progress: 0, done: false };

    // XPU first-run import initialises Intel OneAPI/SYCL device stack which can
    // take 60-120s on a freshly-installed driver. Use a longer timeout.
    const verifyTimeoutMs = vendor === 'xpu' ? 180_000 : 30_000;

    const torchVer = await checkTorchVersion(vendor, verifyTimeoutMs);
    if (!torchVer) {
      const msg = 'torch installed but fails to import — check driver installation';
      yield { phase: 'error', vendor, label: msg, progress: -1, done: true, error: msg };
      return;
    }

    const packagesOk = await checkPackagesReady(vendor, verifyTimeoutMs);
    if (!packagesOk) {
      const msg = 'Some required packages fail to import — check driver installation';
      yield { phase: 'error', vendor, label: msg, progress: -1, done: true, error: msg };
      return;
    }

    const gpuOk = vendor !== 'cpu' ? await checkGpuAvailable(vendor) : false;
    console.log(`[PythonEnvManager] Verified ${vendorLabel(vendor)}: torch=${torchVer}, gpu=${gpuOk ? 'yes' : 'no'}`);
    // gpuOk=false is non-fatal — packages are installed; GPU may need a reboot or
    // BIOS setting (e.g. Resizable BAR for Intel Arc). Manifest is written regardless.
    yield { phase: 'verify', vendor, label: `torch ${torchVer} — GPU ${gpuOk ? 'available' : 'not detected (reboot may be required)'}`, progress: 1.0, done: false };

    // ── Phase: configs ─────────────────────────────────────────────────────
    yield { phase: 'configs', vendor, label: 'Model configs…', progress: 0, done: false };
    fs.mkdirSync(getConfigDir(), { recursive: true });
    yield { phase: 'configs', vendor, label: 'Ready', progress: 1.0, done: false };

    // ── Write manifest ─────────────────────────────────────────────────────
    writeManifest(vendor, {
      vendor,
      torchVersion: torchVer,
      torchIndex: indexUrl,
      pythonVersion: sysPy.version!,
      timestamp: new Date().toISOString(),
      envVersion: REQUIRED_ENV_VERSION,
    });

    yield { phase: 'complete', vendor, label: `${vendorLabel(vendor)} environment ready`, progress: 1.0, done: true };
  } catch (err) {
    const msg = `Unexpected error: ${(err as Error).message}`;
    yield { phase: 'error', vendor, label: msg, progress: -1, done: true, error: msg };
  } finally {
    _installingVendors.delete(vendor);
  }
}

// ── Package installation helpers ─────────────────────────────────────────────

async function installTorchPackages(
  pyBin: string,
  vendor: GpuVendor,
  indexUrl: string,
): Promise<{ ok: boolean; error?: string }> {
  // Windows ROCm uses AMD's direct wheel URLs — completely different from the
  // Linux pytorch.org/whl/rocmX.X index (which is Linux-only).
  // AMD publishes torch 2.9.1+rocmsdk for Windows at repo.radeon.com.
  // Step 1: install the four ROCm SDK wheels that set up HIP/rocBLAS inside the venv.
  // Step 2: install torch/torchvision/torchaudio from the same channel.
  if (vendor === 'rocm' && process.platform === 'win32') {
    return installRocmWindowsTorch(pyBin);
  }

  const args = ['-m', 'pip', 'install', 'torch', 'torchvision', 'torchaudio'];
  if (indexUrl) args.push('--index-url', indexUrl);

  const result = await runPip(pyBin, args);
  if (!result.ok) return result;

  // Triton — optional, non-fatal
  const tritonResult = await installTriton(pyBin, vendor, indexUrl);
  if (!tritonResult.ok) {
    console.warn(`[PythonEnvManager] Triton install failed (non-fatal): ${tritonResult.error}`);
  }

  return { ok: true };
}

async function installRocmWindowsTorch(pyBin: string): Promise<{ ok: boolean; error?: string }> {
  // Step 1 — ROCm SDK runtime wheels (bundles amdhip64, rocblas, MIOpen etc into the venv).
  // These are architecture-independent (py3-none-win_amd64) so they work for all AMD GPUs.
  console.log('[PythonEnvManager] Installing AMD ROCm 7.2 SDK wheels for Windows…');
  const sdkResult = await runPip(pyBin, [
    '-m', 'pip', 'install', '--no-cache-dir',
    `${AMD_ROCM_WIN_BASE}/rocm_sdk_core-7.2.0.dev0-py3-none-win_amd64.whl`,
    `${AMD_ROCM_WIN_BASE}/rocm_sdk_devel-7.2.0.dev0-py3-none-win_amd64.whl`,
    `${AMD_ROCM_WIN_BASE}/rocm_sdk_libraries_custom-7.2.0.dev0-py3-none-win_amd64.whl`,
    `${AMD_ROCM_WIN_BASE}/rocm-7.2.0.dev0.tar.gz`,
  ]);
  if (!sdkResult.ok) return { ok: false, error: `ROCm SDK install failed: ${sdkResult.error}` };

  // Step 2 — torch/torchvision/torchaudio (cp312 only — AMD requires Python 3.12).
  console.log('[PythonEnvManager] Installing torch 2.9.1+rocmsdk for Windows…');
  const torchResult = await runPip(pyBin, [
    '-m', 'pip', 'install', '--no-cache-dir',
    `${AMD_ROCM_WIN_BASE}/torch-2.9.1%2Brocmsdk20260116-cp312-cp312-win_amd64.whl`,
    `${AMD_ROCM_WIN_BASE}/torchaudio-2.9.1%2Brocmsdk20260116-cp312-cp312-win_amd64.whl`,
    `${AMD_ROCM_WIN_BASE}/torchvision-0.24.1%2Brocmsdk20260116-cp312-cp312-win_amd64.whl`,
  ]);
  if (!torchResult.ok) return { ok: false, error: `torch install failed: ${torchResult.error}` };

  return { ok: true };
}

async function installTriton(
  pyBin: string,
  vendor: GpuVendor,
  indexUrl: string,
): Promise<{ ok: boolean; error?: string }> {
  // Windows ROCm: Triton is not separately required — skip silently.
  if (vendor === 'rocm' && process.platform === 'win32') return { ok: true };

  switch (vendor) {
    case 'cuda':
      return { ok: true }; // ships with CUDA wheels
    case 'rocm':
      return runPip(pyBin, ['-m', 'pip', 'install', 'pytorch-triton-rocm', '--index-url', indexUrl]);
    case 'xpu':
      return runPip(pyBin, ['-m', 'pip', 'install', 'triton-xpu', '--extra-index-url', indexUrl]);
    default:
      return { ok: true };
  }
}

async function installDiffusersStack(pyBin: string): Promise<{ ok: boolean; error?: string }> {
  const pipResult = await runPip(pyBin, [
    '-m', 'pip', 'install',
    // All three must be installed together in a single pip invocation so the
    // resolver sees the full constraint graph and can't cascade-upgrade one
    // package's files while leaving another's metadata stale.
    //
    // diffusers 0.36.0: first version with ZImagePipeline. 0.37+ requires
    //   safetensors>=0.8.0-rc.0 which cascades into newer transformers files.
    // transformers 4.54.0: first version with Qwen3 GGUF support in GGUF_CONFIG_MAPPING.
    //   Earlier versions (4.51.3–4.53) don't have qwen3 in the GGUF loader, causing
    //   "GGUF model with architecture qwen3 is not supported yet" for Z-Image/Qwen-Image.
    //   In 4.54.0 the bare `import torch.distributed.tensor` is gone — the DTensor import
    //   is now guarded by `if _is_dtensor_available:` which evaluates False on ROCm Windows
    //   (torch.distributed.is_available() returns False). No patch needed, no crash.
    //   Qwen3 model files themselves have zero torch.distributed imports.
    // safetensors 0.4.5: compatible with diffusers 0.36 and transformers 4.54.
    'diffusers==0.36.0',
    'transformers==4.54.0',
    'safetensors==0.4.5',
    // huggingface-hub: let pip resolve within diffusers 0.36.0's declared range (>=0.34.0).
    'accelerate>=0.20.0',
    'gguf>=0.10.0',
    'sentencepiece',
    'protobuf',
    // Training deps — installed here so the venv is training-ready from setup.
    'peft>=0.10.0',
    'bitsandbytes>=0.43.0',
    'prodigyopt>=1.0',
    'torchvision',
    'Pillow',
    // Caption deps — Florence-2 requires timm and einops.
    'timm',
    'einops',
  ]);
  if (!pipResult.ok) return pipResult;

  return { ok: true };
}

/**
 * Kept for reference — was needed when the transformers 4.51.3 PyPI wheel shipped
 * a broken modeling_utils.py with a bare `import torch.distributed.tensor` on line 41
 * despite the version tag. In 4.54.0 this is properly guarded and no longer needed.
 * Do not delete — may be useful if a future wheel regression occurs.
 */
function _patchTransformersModelingUtils_UNUSED(pyBin: string): void {
  try {
    // Resolve site-packages from the python binary path
    const sitePackages = path.join(path.dirname(pyBin), '..', 'Lib', 'site-packages');
    const targetFile = path.join(sitePackages, 'transformers', 'modeling_utils.py');
    if (!fs.existsSync(targetFile)) return;

    const original = fs.readFileSync(targetFile, 'utf-8');
    const patched = original
      .split('\n')
      .filter(line => line.trim() !== 'import torch.distributed.tensor')
      .join('\n');

    if (patched === original) {
      console.log('[PythonEnvManager] modeling_utils.py already clean — no patch needed');
      return;
    }

    fs.writeFileSync(targetFile, patched, 'utf-8');
    console.log('[PythonEnvManager] Patched transformers/modeling_utils.py — removed torch.distributed.tensor import');
  } catch (err) {
    // Non-fatal — log and continue. Generation will fail at runtime if the import
    // is still present, but the install itself should not be blocked.
    console.warn(`[PythonEnvManager] Could not patch modeling_utils.py: ${err}`);
  }
}

async function runPip(pyBin: string, args: string[]): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync(pyBin, args, {
      timeout: 30 * 60 * 1000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return { ok: true };
  } catch (err) {
    const error = (err as { stderr?: string; message?: string });
    const msg = error.stderr?.trim().split('\n').slice(-5).join('\n') || error.message || 'pip install failed';
    return { ok: false, error: msg };
  }
}

// ── Uninstall ────────────────────────────────────────────────────────────────

/** Removes a single vendor's environment. */
export async function uninstallVendor(vendor: GpuVendor): Promise<void> {
  const dir = vendorDir(vendor);
  if (fs.existsSync(dir)) {
    await fsPromises.rm(dir, { recursive: true, force: true });
    console.log(`[PythonEnvManager] Removed ${vendorLabel(vendor)} environment: ${dir}`);
  }
}

/** Removes all vendor environments. */
export async function uninstallAll(): Promise<void> {
  const root = PYTHON_ENV_ROOT();
  if (fs.existsSync(root)) {
    await fsPromises.rm(root, { recursive: true, force: true });
    console.log(`[PythonEnvManager] Removed all Python environments: ${root}`);
  }
}

/** Returns disk usage for a vendor's venv in bytes. */
export async function getDiskUsage(vendor: GpuVendor): Promise<number> {
  const dir = vendorDir(vendor);
  if (!fs.existsSync(dir)) return 0;

  let totalBytes = 0;
  async function walk(d: string): Promise<void> {
    const entries = await fsPromises.readdir(d, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        try {
          const stat = await fsPromises.stat(full);
          totalBytes += stat.size;
        } catch { /* skip */ }
      }
    }
  }
  await walk(dir);
  return totalBytes;
}

/** Returns the venv root directory. */
export function getEnvRoot(): string {
  return PYTHON_ENV_ROOT();
}

// ── Automated Python installer (Windows) ─────────────────────────────────────

export interface PythonInstallProgress {
  phase: 'download' | 'install' | 'complete' | 'error';
  label: string;
  /** 0.0–1.0, or -1 for indeterminate */
  progress?: number;
  done: boolean;
  error?: string;
}

/**
 * Downloads the Python 3.12.10 Windows installer to a temp file and launches
 * it with /passive + PrependPath=1 + InstallAllUsers=0 (no UAC required).
 * Invalidates the Python detection cache on completion.
 *
 * Windows only. Yields SSE-compatible progress events.
 *
 * If the automated installer fails for any reason (group policy, network
 * failure, permissions) the error event includes manual install instructions.
 */
export async function* downloadAndInstallPython(): AsyncGenerator<PythonInstallProgress> {
  if (process.platform !== 'win32') {
    yield {
      phase: 'error',
      label: 'Automated Python install is only supported on Windows.',
      done: true,
      error: 'not-windows',
    };
    return;
  }

  const tmpDir       = os.tmpdir();
  const installerPath = path.join(tmpDir, 'python-3.12.10-amd64.exe');

  // ── Download ───────────────────────────────────────────────────────────────
  yield { phase: 'download', label: 'Downloading Python 3.12.10 (~28 MB)…', progress: 0, done: false };

  try {
    const https = await import('https');
    await new Promise<void>((resolve, reject) => {
      const file = fs.createWriteStream(installerPath);

      function handleResponse(res: import('http').IncomingMessage): void {
        // Follow a single redirect — python.org uses one
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          https.get(res.headers.location, handleResponse).on('error', reject);
          return;
        }
        res.pipe(file);
        res.on('end', () => file.close(() => resolve()));
        res.on('error', reject);
        file.on('error', reject);
      }

      https.get(PYTHON_312_WIN_URL, handleResponse).on('error', reject);
    });
  } catch (err) {
    try { fs.unlinkSync(installerPath); } catch { /* ignore */ }
    yield {
      phase: 'error',
      label: `Download failed: ${(err as Error).message}. Please install Python 3.12 manually: ${PYTHON_INSTALL_LINKS.windows} — check "Add Python to PATH" during install.`,
      done: true,
      error: (err as Error).message,
    };
    return;
  }

  yield { phase: 'download', label: 'Python 3.12.10 downloaded', progress: 1.0, done: false };

  // ── Install ────────────────────────────────────────────────────────────────
  yield {
    phase: 'install',
    label: 'Installing Python 3.12.10 — this takes about 60 seconds…',
    progress: -1,
    done: false,
  };

  try {
    // /passive        — minimal progress window, no user clicks required
    // PrependPath=1   — equivalent of "Add Python to PATH" checkbox
    // InstallAllUsers=0 — per-user install, no UAC elevation required
    await execFileAsync(
      installerPath,
      ['/passive', 'PrependPath=1', 'InstallAllUsers=0'],
      { timeout: 5 * 60 * 1000 },
    );
  } catch (err) {
    yield {
      phase: 'error',
      label: [
        `Automated install failed: ${(err as Error).message}.`,
        "This can happen if your organisation's Group Policy blocks software installs,",
        'or if an antivirus tool interrupted the process.',
        `Please install Python 3.12 manually: ${PYTHON_INSTALL_LINKS.windows}`,
        '— check "Add Python to PATH" during install, then restart PHOBOS and try again.',
      ].join(' '),
      done: true,
      error: (err as Error).message,
    };
    return;
  } finally {
    try { await fsPromises.unlink(installerPath); } catch { /* ignore */ }
  }

  // Bust the cache so the next detectPython() re-scans PATH
  _pythonCache = null;

  // Confirm we can find it now
  const det = await findSystemPython();
  if (!det.found) {
    yield {
      phase: 'error',
      label: [
        'Installer completed but Python was not found on PATH.',
        'This sometimes requires restarting PHOBOS after a new PATH entry is added.',
        'Close and reopen PHOBOS, then click "Set up PyTorch" again.',
        `If the problem persists, install manually: ${PYTHON_INSTALL_LINKS.windows}`,
      ].join(' '),
      done: true,
      error: 'post-install-not-found',
    };
    return;
  }

  yield {
    phase: 'complete',
    label: `Python ${det.version} installed and detected`,
    progress: 1.0,
    done: true,
  };
}
