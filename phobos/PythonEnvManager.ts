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
  /** True if SageAttention ≥2.1.1 is installed and importable in this vendor's venv */
  sageReady: boolean;
}

export interface PythonEnvStatus {
  /** System Python detection result */
  python: PythonDetection;
  /** Per-vendor environment status */
  vendors: VendorEnvStatus[];
}

export interface InstallProgress {
  phase: 'detect' | 'venv' | 'torch' | 'packages' | 'sage' | 'verify' | 'configs' | 'complete' | 'error';
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
//   5 — CUDA index bumped from cu121 (torch ~2.6) to cu128 (torch 2.7.0 stable).
//       SageAttention post4 ABI3 wheel now installs automatically on CUDA.
//       triton-windows added to CUDA install on Windows (was missing, only Linux CUDA
//       wheels bundle triton).
//  6 - incrementing during testing
const REQUIRED_ENV_VERSION = 21; // v21: diffusers 0.37.1, ftfy (WanPipeline dep), torchao (BF16 native quantization path)

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
    case 'cuda':  return 'https://download.pytorch.org/whl/cu128';
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

    const sageReady = ready ? await checkSageReady(vendor) : false;
    vendors.push({ vendor, ready, torchVersion, gpuAvailable, diskBytes, stale: isEnvStale(vendor), sageReady });
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
    // Always wipe and recreate — never attempt to install into an existing
    // directory. A partial or aborted previous install leaves the venv in an
    // indeterminate state: pip, torch, or diffusers may be half-written,
    // .dist-info directories may be inconsistent, and `python -m venv` on an
    // existing directory silently skips recreation. Wiping first guarantees a
    // clean slate regardless of how the previous attempt ended.
    const dir = vendorDir(vendor);
    const pyBin = vendorPython(vendor);

    yield { phase: 'venv', vendor, label: 'Creating virtual environment…', progress: 0, done: false };

    if (fs.existsSync(dir)) {
      try {
        await fsPromises.rm(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[PythonEnvManager] Could not remove existing dir ${dir}: ${err}`);
      }
    }

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

    const pkgResult = await installDiffusersStack(pyBin, indexUrl);
    if (!pkgResult.ok) {
      yield { phase: 'error', vendor, label: pkgResult.error!, progress: -1, done: true, error: pkgResult.error! };
      return;
    }
    yield { phase: 'packages', vendor, label: 'Diffusers stack installed', progress: 1.0, done: false };

    // ── Phase: sage ────────────────────────────────────────────────────────
    // CUDA only. Fully isolated try/catch — any failure (pip error, DLL load
    // issue, network timeout, SSE socket drop during the long compile) must
    // never propagate out of this block. Manifest write happens after this.
    if (vendor === 'cuda') {
      yield { phase: 'sage', vendor, label: 'Installing SageAttention…', progress: -1, done: false };
      try {
        const sageResult = await installSageAttention(pyBin, vendor);
        if (sageResult.skipped) {
          yield { phase: 'sage', vendor, label: 'SageAttention: skipped (not applicable for this platform)', progress: 1.0, done: false };
        } else if (!sageResult.ok) {
          console.warn(`[PythonEnvManager] SageAttention install failed (non-fatal): ${sageResult.error}`);
          yield { phase: 'sage', vendor, label: `SageAttention: install failed — ${sageResult.error ?? 'unknown error'} (generation will still work)`, progress: 1.0, done: false };
        } else {
          yield { phase: 'sage', vendor, label: 'SageAttention ready', progress: 1.0, done: false };
        }
      } catch (sageErr) {
        console.warn(`[PythonEnvManager] SageAttention phase threw (non-fatal): ${(sageErr as Error).message}`);
        yield { phase: 'sage', vendor, label: 'SageAttention: skipped (unexpected error — generation will still work)', progress: 1.0, done: false };
      }
    }

    // ── Phase: patch ───────────────────────────────────────────────────────
    // Apply torchaudio/_torchcodec.py soundfile fallback LAST — after all pip
    // installs (including sage) complete. Any pip install that touches torchaudio
    // resets the file to the original. Running here ensures the patch is always
    // the final write to that file before the venv is used.
    // Resolve patch source — works in dev (tsx) and prod (compiled exe).
    // build.js stages _torchcodec.py to dist/ root so it lands next to the exe.
    const patchCandidates: string[] = [
      path.join(process.cwd(), 'phobos', '_torchcodec.py'),
      path.join(process.cwd(), 'dist', '_torchcodec.py'),
      path.join(process.cwd(), '_torchcodec.py'),
      path.join(process.execPath.replace(/[\/][^\/]+$/, ''), '_torchcodec.py'),
    ];
    if (typeof __filename !== 'undefined') {
      patchCandidates.unshift(path.join(path.dirname(__filename), 'phobos', '_torchcodec.py'));
      patchCandidates.unshift(path.join(path.dirname(__filename), '_torchcodec.py'));
    }
    if (process.env['PHOBOS_BIN_DIR']) {
      patchCandidates.unshift(path.join(process.env['PHOBOS_BIN_DIR'], '_torchcodec.py'));
    }
    const patchSrc = patchCandidates.find(p => fs.existsSync(p)) ?? '';
    const torchaudioPkg = path.join(path.dirname(pyBin), '..', 'Lib', 'site-packages', 'torchaudio');
    const patchDest = path.join(torchaudioPkg, '_torchcodec.py');
    if (patchSrc && fs.existsSync(torchaudioPkg)) {
      fs.copyFileSync(patchSrc, patchDest);
      console.log('[PythonEnvManager] Applied torchaudio/_torchcodec.py patch from', patchSrc);
    } else {
      console.warn('[PythonEnvManager] _torchcodec.py patch source not found — F5-TTS may fail without FFmpeg');
    }

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
  ]);
  if (!torchResult.ok) return { ok: false, error: `torch install failed: ${torchResult.error}` };

  // torchvision: the AMD-provided 0.24.1+rocmsdk wheel is ABI-incompatible with
  // torch 2.9.1 on Windows and causes `import diffusers` to fail at runtime
  // (CLIPTextModel and other pipeline classes become unreachable). Install the
  // CPU stub from PyPI instead — diffusers only uses torchvision for PIL image
  // transforms which work identically without the ROCm C extension.
  const tvResult = await runPip(pyBin, ['-m', 'pip', 'install', '--no-cache-dir', 'torchvision']);
  if (!tvResult.ok) {
    console.warn(`[PythonEnvManager] torchvision CPU stub install failed (non-fatal): ${tvResult.error}`);
  }

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
      // On Linux, triton is bundled with the CUDA torch wheel — nothing to do.
      // On Windows, triton is not bundled; install triton-windows from PyPI.
      // triton-windows bundles its own CUDA toolchain (≥3.2.0.post11) and TinyCC
      // (≥3.2.0.post13) — no VS Build Tools or CUDA Toolkit required on the host.
      if (process.platform !== 'win32') return { ok: true };
      return runPip(pyBin, ['-m', 'pip', 'install', 'triton-windows']);
    case 'rocm':
      return runPip(pyBin, ['-m', 'pip', 'install', 'pytorch-triton-rocm', '--index-url', indexUrl]);
    case 'xpu':
      return runPip(pyBin, ['-m', 'pip', 'install', 'triton-xpu', '--extra-index-url', indexUrl]);
    default:
      return { ok: true };
  }
}

async function installDiffusersStack(
  pyBin: string,
  indexUrl: string,
): Promise<{ ok: boolean; error?: string }> {
  // ── Pass 1: core image-gen stack with pinned versions ─────────────────────
  // All pins must be in one invocation so pip's resolver sees the full constraint
  // graph simultaneously. Installing separately allows later calls to override pins.
  //
  // diffusers 0.36.0: first version with ZImagePipeline.
  // transformers 4.54.0: first version with Qwen3 GGUF support. f5-tts pulls
  //   transformers>=5.x. It is installed in Pass 2 and transformers is immediately
  //   force-repinned to 4.54.0 after.
  // safetensors 0.4.5: compatible with diffusers 0.36 and transformers 4.54.
  // torchvision/timm/einops are NOT included here — torchvision must come from
  //   the vendor index (cu128/rocm) not PyPI or it installs a CPU-only wheel.
  //   timm and einops are Florence-2 caption deps, not needed for image gen.
  const pipResult = await runPip(pyBin, [
    '-m', 'pip', 'install',
    'diffusers==0.37.1',
    'transformers==4.54.0',
    'safetensors==0.4.5',
    'accelerate>=0.20.0',
    'gguf>=0.10.0',
    'sentencepiece',
    'protobuf',
    'peft>=0.10.0',
    'bitsandbytes>=0.43.0',
    'prodigyopt>=1.0',
    'Pillow',
    'einops',
    // soundfile: audio I/O used by the torchcodec fallback patch and directly
    // by audio processing paths. Declared here to ensure it is present regardless
    // of f5-tts install order.
    'soundfile',
    // hf_xet: Xet storage accelerator for HuggingFace downloads. Optional but
    // eliminates the warning on model downloads. Pure Python, no conflicts.
    'hf_xet',
    // ftfy: text normalization required by WanPipeline.__call__ at inference time.
    // diffusers does not declare it as a dependency. Pure Python, no conflicts.
    'ftfy',
    // torchao: PyTorch-native quantization library. Enables int4/int8 weight-only
    // quantization on Ampere, FP8 on Ada+, NVFP4 on Blackwell — hardware-detected
    // at load time in phobos-diffusers.py. ~3x faster model loads via native BF16
    // from_pretrained vs GGUF from_single_file. No interaction with training path.
    'torchao',
    // tokenizers must be pinned alongside transformers. transformers==4.54.0
    // requires tokenizers>=0.21,<0.22. f5-tts/trl/datasets install 0.22.x which
    // makes transformers unimportable. Pin it here so the resolver sees the
    // constraint in the same pass as transformers==4.54.0.
    'tokenizers>=0.21,<0.22',
  ]);
  if (!pipResult.ok) return pipResult;

  // ── Pass 2: F5-TTS install under constraints ──────────────────────────
  // After Pass 1 succeeds, freeze the entire env into a temp constraints file.
  // pip's -c flag treats every line as a hard ceiling — f5-tts can declare
  // transformers>=5.x in its metadata all it wants; pip will refuse to upgrade
  // anything already pinned in the constraints file. No re-pin needed.
  //
  // The constraints file is written to the venv's temp dir and deleted after
  // install. It is never shipped — it is generated fresh on each env build.
  const constraintsPath = path.join(path.dirname(pyBin), '..', 'phobos-constraints.txt');
  let constraintsWritten = false;
  try {
    const { stdout: freezeOut } = await execFileAsync(
      pyBin, ['-m', 'pip', 'freeze'],
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
    );
    fs.writeFileSync(constraintsPath, freezeOut, 'utf-8');
    constraintsWritten = true;
  } catch (freezeErr) {
    console.warn(`[PythonEnvManager] pip freeze failed — f5-tts will install without constraints: ${freezeErr}`);
  }

  const f5Args = ['-m', 'pip', 'install', 'f5-tts'];
  if (constraintsWritten) f5Args.push('-c', constraintsPath);
  const f5Result = await runPip(pyBin, f5Args);
  if (!f5Result.ok) {
    console.warn(`[PythonEnvManager] f5-tts install failed (non-fatal): ${f5Result.error}`);
  }

  // Clean up constraints file — it's env-specific and must not persist across rebuilds.
  if (constraintsWritten) {
    try { fs.unlinkSync(constraintsPath); } catch { /* non-fatal */ }
  }

  return { ok: true };
}

// ── SageAttention wheel index ─────────────────────────────────────────────────
// woct0rdho/SageAttention v2.2.0-windows.post4 ships two universal ABI3 wheels:
//   - cu128: for torch built against CUDA 12.x (covers torch ≥2.7 in practice)
//   - cu130: for torch built against CUDA 13.x (Blackwell sm_120)
//
// The "torch2.9.0andhigher" label in the filename is the maintainer's strict
// guarantee. In practice both wheels work with torch 2.7+ due to libtorch
// stable ABI — confirmed by Wan2GP, DazzleML installer, and the woct0rdho README.
//
// Post4 dropped per-torch-minor wheels entirely. No cu121/cu124/cu126 wheels
// exist in this release — hence the CUDA index bump to cu128.
//
// Cannot be published to PyPI because PyPI disallows per-torch-version variants.
// Update SAGE_WHEEL_RELEASE tag and entries when woct0rdho publishes a new release.
const SAGE_WHEEL_RELEASE = 'v2.2.0-windows.post4';
const SAGE_WHEEL_BASE = `https://github.com/woct0rdho/SageAttention/releases/download/${SAGE_WHEEL_RELEASE}`;
const SAGE_WHEEL_INDEX: Record<string, { win: string; linux: string }> = {
  // CUDA 12.x builds (cu126, cu128, cu129 — all resolve to this wheel)
  'cu128': {
    win:   `${SAGE_WHEEL_BASE}/sageattention-2.2.0%2Bcu128torch2.9.0andhigher.post4-cp39-abi3-win_amd64.whl`,
    linux: `${SAGE_WHEEL_BASE}/sageattention-2.2.0%2Bcu128torch2.9.0andhigher.post4-cp39-abi3-linux_x86_64.whl`,
  },
  // CUDA 13.x builds (cu130 — Blackwell sm_120, RTX 50-series)
  'cu130': {
    win:   `${SAGE_WHEEL_BASE}/sageattention-2.2.0%2Bcu130torch2.9.0andhigher.post4-cp39-abi3-win_amd64.whl`,
    linux: `${SAGE_WHEEL_BASE}/sageattention-2.2.0%2Bcu130torch2.9.0andhigher.post4-cp39-abi3-linux_x86_64.whl`,
  },
};

/**
 * Selects the SageAttention wheel key from the installed torch version string.
 * torch.__version__ looks like '2.7.0+cu128' — we extract the cu1XX suffix.
 * Defaults to 'cu128' (CUDA 12.x) for any unrecognised suffix.
 */
function sageWheelKey(torchVersion: string): string {
  const match = torchVersion.match(/\+(cu\d+)/);
  if (!match) return 'cu128'; // no CUDA suffix — shouldn't happen for CUDA vendor
  const suffix = match[1]; // e.g. 'cu128', 'cu129', 'cu130'
  return suffix in SAGE_WHEEL_INDEX ? suffix : 'cu128';
}

/**
 * Installs SageAttention 2.x into the vendor venv using a prebuilt ABI3 wheel.
 * Non-fatal: returns { ok: true, skipped: true } on non-CUDA vendors or macOS.
 * No system build tools required — the wheel is precompiled.
 */
async function installSageAttention(
  pyBin: string,
  vendor: GpuVendor,
): Promise<{ ok: boolean; skipped: boolean; error?: string }> {
  // SageAttention prebuilt wheels are CUDA-only.
  if (vendor !== 'cuda') return { ok: true, skipped: true };

  // macOS has no Metal backend in SageAttention.
  if (process.platform === 'darwin') return { ok: true, skipped: true };

  // Read the installed torch version string to determine the CUDA build suffix.
  // On Windows, NTFS metadata and Defender scans can cause a brief window where
  // newly written .dist-info directories are not yet visible to the import system
  // immediately after pip exits. Retry up to 3 times with a 1s delay.
  let torchVersion = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1_000));
    try {
      const { stdout } = await execFileAsync(
        pyBin,
        ['-c', 'import torch; print(torch.__version__)'],
        { timeout: 15_000 },
      );
      torchVersion = stdout.trim(); // e.g. '2.11.0+cu128'
      break;
    } catch (err) {
      if (attempt === 3) {
        console.warn(`[PythonEnvManager] SageAttention: could not read torch version after ${attempt} attempts — skipping: ${err}`);
        return { ok: true, skipped: true };
      }
      console.warn(`[PythonEnvManager] SageAttention: torch version read attempt ${attempt} failed, retrying…`);
    }
  }

  const key = sageWheelKey(torchVersion);
  const platform = process.platform === 'win32' ? 'win' : 'linux';
  const wheelUrl = SAGE_WHEEL_INDEX[key][platform];

  console.log(`[PythonEnvManager] Installing SageAttention (${key}, ${platform}, torch ${torchVersion})…`);

  const result = await runPip(pyBin, ['-m', 'pip', 'install', wheelUrl]);
  if (!result.ok) {
    return { ok: false, skipped: false, error: result.error };
  }

  return { ok: true, skipped: false };
}

/**
 * Returns true if SageAttention ≥2.1.1 is installed and importable in the venv.
 * Used by getStatus() to populate VendorEnvStatus.sageReady.
 */
export async function checkSageReady(vendor: GpuVendor): Promise<boolean> {
  if (vendor !== 'cuda') return false;
  // Some sageattention wheel builds omit __version__. Treat a successful import
  // as sufficient — if it imports, it's installed. Only gate on version when the
  // attribute is present (it will be ≥2.1.1 since that's what we install).
  const script = [
    'import sageattention',
    'from packaging.version import Version',
    'v = getattr(sageattention, "__version__", None)',
    'ok = v is None or Version(v) >= Version("2.1.1")',
    'print("ok" if ok else "old")',
  ].join('; ');
  return (await runVenvCheck(vendor, script, 15_000)) === 'ok';
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

// ── Cartridge training deps ───────────────────────────────────────────────────

// Non-torch deps installed first (no build-time torch dependency).
const CARTRIDGE_BASE_DEPS = [
  // tokenizers must stay pinned to <0.22 — transformers==4.54.0 requires it.
  // ensureCartridgeDeps installs trl/datasets which want 0.22.x; this pin
  // prevents them from upgrading it and breaking the transformers import.
  'tokenizers>=0.21,<0.22',
  // All cartridge training deps installed with --no-deps to prevent any of
  // them from upgrading torch, transformers, or tokenizers.
  // trl must be exactly 1.3.0 — chat_template_utils.py removed in later versions.
  'trl==1.3.0',
  'datasets>=2.18.0',
  'huggingface_hub>=0.23.0',
  'sentencepiece>=0.2.0',
  'protobuf>=3.20.0',
  'pypdf>=4.0.0',
  'markdown-it-py>=3.0',
];

// Unsloth installed separately without the [cu124-torch250] extras bracket.
// The extras bracket causes pip to pull xformers which tries to build from
// source and fails because torch is not present in the pip build environment
// (even though it is in the venv). Torch is already installed by the main
// PyTorch setup step — unsloth will detect and use it automatically.
const UNSLOTH_DEP = 'unsloth>=2025.3.0';

/**
 * Installs unsloth + cartridge training deps into the existing inference venv.
 * Idempotent: does a fast import check first, installs only if needed.
 * Called by CartridgeTrainer.ts before spawning phobos-lm-trainer.py.
 *
 * Install order matters:
 *   1. Base deps (trl, datasets, etc.) — no torch build dependency
 *   2. unsloth (no extras) — torch already present from PyTorch setup step
 */
export async function ensureCartridgeDeps(vendor: GpuVendor): Promise<void> {
  const pyBin = getPythonPath(vendor);
  if (!pyBin) throw new Error(`No Python venv for vendor '${vendor}' — run PyTorch setup first`);

  // Unsloth patches torch internals at import time — takes ~20s on first run.
  // PYTHONUTF8=1 required: trl reads Jinja templates with no encoding arg,
  // which defaults to cp1252 on Windows and fails on non-ASCII characters.
  //
  // ROCm extra env vars (Windows + gfx1150 / 890M):
  //   HIP_VISIBLE_DEVICES=0   — without this, hipGetDeviceCount() returns 0 on
  //                             unsupported architectures (gfx1150) causing
  //                             torch.cuda.is_available() = False. Unsloth's
  //                             import_fixes.py detects _ROCM_ENV_HINT_KEYS
  //                             (which includes HIP_VISIBLE_DEVICES) and then
  //                             raises "no usable HIP accelerator" → triggers a
  //                             pip reinstall subprocess that always fails for
  //                             AMD Windows SDK torch (repo.radeon.com wheels are
  //                             not on download.pytorch.org/whl/rocm7.2).
  //   HSA_OVERRIDE_GFX_VERSION=11.5.0 — tells the ROCm runtime to use gfx1100
  //                             (RDNA 3.0) kernels for gfx1150 (RDNA 3.5). The
  //                             890M's gfx1150 is not in the ROCm kernel library;
  //                             without this override some kernels may fail to
  //                             dispatch. AMD's Windows SDK may handle this
  //                             internally, but setting it explicitly is safe and
  //                             matches community-confirmed best practice for
  //                             RDNA 3.5 iGPUs.
  const importEnv = {
    ...process.env,
    PYTHONUTF8: '1',
    ...(vendor === 'rocm' ? {
      HIP_VISIBLE_DEVICES:       '0',
      HSA_OVERRIDE_GFX_VERSION:  '11.5.0',
    } : {}),
  };

  try {
    await execFileAsync(
      pyBin,
      ['-c', 'import unsloth, trl, safetensors, huggingface_hub; print("ok")'],
      { timeout: 180_000, env: importEnv },
    );
    return; // already installed
  } catch { /* install needed */ }

  // Step 0: torchvision from vendor index — unsloth requires it at import time.
  // Must come from the vendor-specific index or pip installs a CPU-only wheel
  // that unsloth rejects at import time.
  if (vendor === 'cuda') {
    await execFileAsync(
      pyBin,
      ['-m', 'pip', 'install', '--quiet', '--no-deps',
       'torchvision', '--index-url', 'https://download.pytorch.org/whl/cu128'],
      { timeout: 5 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 },
    );
  } else if (vendor === 'rocm') {
    // Windows ROCm: torchvision wheel is already bundled in installRocmWindowsTorch().
    // Linux ROCm: install from the pytorch.org rocm index.
    if (process.platform !== 'win32') {
      await execFileAsync(
        pyBin,
        ['-m', 'pip', 'install', '--quiet', '--no-deps',
         'torchvision', '--index-url', 'https://download.pytorch.org/whl/rocm7.2'],
        { timeout: 5 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 },
      );
    }
  } else if (vendor === 'xpu') {
    await execFileAsync(
      pyBin,
      ['-m', 'pip', 'install', '--quiet', '--no-deps',
       'torchvision', '--index-url', 'https://download.pytorch.org/whl/xpu'],
      { timeout: 5 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 },
    );
  }

  // Step 1a: base deps with --no-deps. trl==1.3.0 wants tokenizers<0.22 and
  // huggingface_hub>=0.23.0 wants tokenizers with no upper bound — pip's resolver
  // rejects them together. --no-deps bypasses the check; packages work at runtime.
  await execFileAsync(
    pyBin,
    ['-m', 'pip', 'install', '--quiet', '--no-deps', ...CARTRIDGE_BASE_DEPS],
    { timeout: 10 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 },
  );

  // Step 1b: mistral_common separately — prevents unsloth's internal pip call
  // during save_pretrained_merged from failing on locked numpy DLLs on Windows.
  await execFileAsync(
    pyBin,
    ['-m', 'pip', 'install', '--quiet', '--no-deps', 'mistral_common'],
    { timeout: 5 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 },
  );

  // Step 2: unsloth without extras bracket and --no-deps so it cannot
  // downgrade torch or upgrade tokenizers/transformers.
  await execFileAsync(
    pyBin,
    ['-m', 'pip', 'install', '--quiet', '--no-deps', UNSLOTH_DEP],
    { timeout: 10 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 },
  );

  // Step 2b: unsloth_zoo — required by unsloth at import time, also --no-deps
  await execFileAsync(
    pyBin,
    ['-m', 'pip', 'install', '--quiet', '--no-deps', 'unsloth_zoo'],
    { timeout: 5 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 },
  );

  // Step 2c (ROCm only): copy patched unsloth_zoo/utils.py from phobos/unsloth_zoo_utils.py.
  // unsloth_zoo/utils.py line 125 does module-level attribute lookups on torch.distributed
  // (is_initialized, is_torchelastic_launched, get_rank) that crash on ROCm Windows because
  // the HIP compat layer doesn't populate those attributes until init_process_group() is called.
  // The patched file uses getattr(..., lambda: False/0) safe fallbacks — same pattern as
  // torchaudio/_torchcodec.py. Source lives at phobos/unsloth_zoo_utils.py in the repo.
  if (vendor === 'rocm') {
    const unslothZooPatchCandidates: string[] = [
      // process.cwd()-based paths work in dev (npx tsx) where __filename is unavailable (ESM)
      path.join(process.cwd(), 'phobos', 'unsloth_zoo_utils.py'),
      path.join(process.cwd(), 'dist', 'unsloth_zoo_utils.py'),
      path.join(process.cwd(), 'unsloth_zoo_utils.py'),
      // process.execPath root covers compiled SEA release
      path.join(process.execPath.replace(/[\/][^\/]+$/, ''), 'unsloth_zoo_utils.py'),
    ];
    if (typeof __filename !== 'undefined') {
      unslothZooPatchCandidates.unshift(path.join(path.dirname(__filename), 'phobos', 'unsloth_zoo_utils.py'));
      unslothZooPatchCandidates.unshift(path.join(path.dirname(__filename), 'unsloth_zoo_utils.py'));
    }
    if (process.env['PHOBOS_BIN_DIR']) {
      unslothZooPatchCandidates.unshift(path.join(process.env['PHOBOS_BIN_DIR'], 'unsloth_zoo_utils.py'));
    }
    const unslothZooPatchSrc = unslothZooPatchCandidates.find(p => fs.existsSync(p)) ?? '';
    const unslothZooPkg = path.join(path.dirname(pyBin), '..', 'Lib', 'site-packages', 'unsloth_zoo');
    const unslothZooPatchDest = path.join(unslothZooPkg, 'utils.py');
    if (unslothZooPatchSrc && fs.existsSync(unslothZooPkg)) {
      fs.copyFileSync(unslothZooPatchSrc, unslothZooPatchDest);
      console.log('[PythonEnvManager] Applied unsloth_zoo/utils.py patch from', unslothZooPatchSrc);
    } else if (!unslothZooPatchSrc) {
      console.warn('[PythonEnvManager] unsloth_zoo_utils.py patch source not found — ROCm LM training will fail at import');
    }
  }

  // // Step 3: patch trl/chat_template_utils.py — read_text() calls use the system
  // // codepage on Windows (cp1252) which cannot decode the DeepSeek v3 Jinja template
  // // (contains byte 0x81). Replace all read_text() calls with read_text(encoding="utf-8").
  // const trlChatUtils = path.join(
  //   path.dirname(pyBin), '..', 'Lib', 'site-packages', 'trl', 'chat_template_utils.py',
  // );
  // if (fs.existsSync(trlChatUtils)) {
  //   const src = fs.readFileSync(trlChatUtils, 'utf-8');
  //   const patched = src.replaceAll('.read_text()', '.read_text(encoding="utf-8")');
  //   if (patched !== src) fs.writeFileSync(trlChatUtils, patched, 'utf-8');
  // }

  // Step 3 (ROCm only): patch trl torch.distributed.is_initialized calls.
  // AMD's Windows ROCm torch build ships a stripped torch.distributed — is_initialized()
  // is not in the module namespace until init_process_group() has been called.
  // trl calls torch.distributed.is_initialized() at import time without a hasattr guard,
  // causing AttributeError on every import.
  //
  // NOTE: there is no trl/utils.py at the package root. The calls live in:
  //   trl/trainer/utils.py   (51 KB — the main location)
  //   trl/experimental/utils.py  (29 KB — secondary)
  // Both are patched here. The patch is idempotent.
  if (vendor === 'rocm') {
    const sitePackages = process.platform === 'win32'
      ? path.join(path.dirname(pyBin), '..', 'Lib', 'site-packages')
      : path.join(path.dirname(pyBin), '..', 'lib',
          fs.readdirSync(path.join(path.dirname(pyBin), '..', 'lib')).find(d => d.startsWith('python')) ?? 'python3',
          'site-packages');
    const trlUtilsTargets = [
      path.join(sitePackages, 'trl', 'trainer', 'utils.py'),
      path.join(sitePackages, 'trl', 'experimental', 'utils.py'),
    ];
    for (const trlUtils of trlUtilsTargets) {
      if (fs.existsSync(trlUtils)) {
        const src = fs.readFileSync(trlUtils, 'utf-8');
        const patched = src.replaceAll(
          'torch.distributed.is_initialized()',
          'hasattr(torch.distributed, "is_initialized") and torch.distributed.is_initialized()',
        );
        if (patched !== src) {
          fs.writeFileSync(trlUtils, patched, 'utf-8');
          console.log(`[PythonEnvManager] Patched ${path.relative(sitePackages, trlUtils)} — guarded torch.distributed.is_initialized (ROCm fix)`);
        }
      }
    }
  }
}