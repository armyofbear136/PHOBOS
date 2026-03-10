import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

// ESM (tsx dev) → import.meta.url is defined; CJS (SEA bundle) → use __dirname global
const _dirname: string = (() => {
  try {
    if (typeof import.meta?.url === 'string') return path.dirname(fileURLToPath(import.meta.url));
  } catch { /* CJS bundle — import.meta.url is undefined */ }
  // esbuild CJS: __dirname is injected by Node at runtime
  return typeof __dirname === 'string' ? __dirname : process.cwd();
})();

// ── Constants ─────────────────────────────────────────────────────────────────

export const MODELS_DIR = path.join(os.homedir(), '.phobos', 'models');

// ── Hardware detection ────────────────────────────────────────────────────────

export interface GpuDevice {
  /** Stable index — CUDA uses nvidia-smi index, others use 100+ offset */
  index: number;
  name: string;
  vramGb: number;
  /** Backend llama-server should use for this device */
  backend: 'cuda' | 'vulkan' | 'metal';
}

export interface HardwareProfile {
  ramGb: number;
  cpuCores: number;
  cpuName: string;
  gpus: GpuDevice[];
}

// ── NVIDIA — returns ALL CUDA GPUs via nvidia-smi ────────────────────────────

async function detectNvidiaGpus(): Promise<GpuDevice[]> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=index,name,memory.total',
      '--format=csv,noheader,nounits',
    ]);
    const gpus: GpuDevice[] = [];
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split(',').map(s => s.trim());
      const idx    = parseInt(parts[0], 10);
      const name   = parts[1];
      const vramMb = parseInt(parts[2], 10);
      if (isNaN(idx) || isNaN(vramMb)) continue;
      gpus.push({ index: idx, name, vramGb: Math.floor(vramMb / 1024), backend: 'cuda' });
    }
    return gpus;
  } catch {
    return [];
  }
}

// ── AMD / Intel iGPU detection via WMI (Windows) ─────────────────────────────
// Queries Win32_VideoController for non-NVIDIA adapters, then reads accurate
// VRAM from the registry (HardwareInformation.qwMemorySize) because WMI's
// AdapterRAM is a uint32 that caps at ~4 GB.
//
// Registry path: HKLM\SYSTEM\ControlSet001\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\000N
// Each GPU adapter gets a subkey (0000, 0001, ...) containing:
//   - DriverDesc (REG_SZ): matches Win32_VideoController.Name
//   - HardwareInformation.qwMemorySize (REG_QWORD): true VRAM in bytes, 64-bit

async function detectNonNvidiaGpus(): Promise<GpuDevice[]> {
  if (process.platform !== 'win32') return [];
  try {
    // Step 1: Get adapter names from WMI (reliable for enumeration)
    // Step 2: Read true VRAM from registry per adapter (reliable for >4 GB)
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile', '-Command',
      `$regBase = 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'; ` +
      `$adapters = Get-CimInstance Win32_VideoController ` +
      `| Where-Object { $_.Name -notmatch 'NVIDIA' -and $_.Name -notmatch 'Microsoft' -and $_.Status -eq 'OK' } ` +
      `| Select-Object -Property Name,AdapterRAM,PNPDeviceID; ` +
      `$results = @(); ` +
      `foreach ($a in $adapters) { ` +
      `  $vram = [uint64]$a.AdapterRAM; ` +
      `  $regKeys = Get-ChildItem $regBase -ErrorAction SilentlyContinue | Where-Object { ` +
      `    (Get-ItemProperty $_.PSPath -Name 'DriverDesc' -ErrorAction SilentlyContinue).DriverDesc -eq $a.Name ` +
      `  }; ` +
      `  foreach ($rk in $regKeys) { ` +
      `    $qw = (Get-ItemProperty $rk.PSPath -Name 'HardwareInformation.qwMemorySize' -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize'; ` +
      `    if ($qw -and [uint64]$qw -gt $vram) { $vram = [uint64]$qw } ` +
      `  }; ` +
      `  $results += @{ Name = $a.Name; VramBytes = $vram } ` +
      `}; ` +
      `$results | ConvertTo-Json -Compress`,
    ], { timeout: 15_000 });
    if (!stdout.trim()) return [];

    const raw = JSON.parse(stdout.trim());
    const items = Array.isArray(raw) ? raw : [raw];
    const gpus: GpuDevice[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const vramBytes = Number(item.VramBytes ?? 0);
      const vramGb    = Math.round(vramBytes / (1024 ** 3));
      if (vramGb < 1) continue;

      const name = String(item.Name ?? 'Unknown GPU');

      gpus.push({
        index: 100 + i,
        name,
        vramGb,
        backend: 'vulkan',
      });
    }
    return gpus;
  } catch {
    return [];
  }
}

// ── Linux: non-NVIDIA GPUs via lspci + sysfs ─────────────────────────────────

async function detectLinuxNonNvidiaGpus(): Promise<GpuDevice[]> {
  if (process.platform !== 'linux') return [];
  try {
    const { stdout } = await execFileAsync('lspci', ['-nn']);
    const gpus: GpuDevice[] = [];
    let idx = 100;
    for (const line of stdout.split('\n')) {
      // Match VGA/3D controllers that are AMD or Intel
      if (!/VGA|3D|Display/.test(line)) continue;
      if (/NVIDIA/i.test(line)) continue; // already handled by nvidia-smi

      const isAmd   = /AMD|ATI|Radeon/i.test(line);
      const isIntel = /Intel/i.test(line);
      if (!isAmd && !isIntel) continue;

      // Extract a rough name
      const nameMatch = line.match(/:\s+(.+?)(?:\s+\[|$)/);
      const name = nameMatch ? nameMatch[1].trim() : (isAmd ? 'AMD GPU' : 'Intel GPU');

      // On Linux, shared memory for iGPUs is hard to query without root.
      // Report 0 and let the user see it as "shared memory — configure in BIOS".
      gpus.push({ index: idx++, name, vramGb: 0, backend: 'vulkan' });
    }
    return gpus;
  } catch {
    return [];
  }
}

// ── Apple Silicon ────────────────────────────────────────────────────────────

async function detectAppleSilicon(): Promise<GpuDevice[]> {
  if (process.platform !== 'darwin') return [];
  try {
    const { stdout } = await execFileAsync('system_profiler', ['SPHardwareDataType']);
    const memMatch  = stdout.match(/Memory:\s+(\d+)\s+GB/i);
    const chipMatch = stdout.match(/Chip:\s+(.+)/i);
    if (!memMatch) return [];
    return [{
      index: 0,
      name: chipMatch ? chipMatch[1].trim() : 'Apple Silicon',
      vramGb: parseInt(memMatch[1], 10),
      backend: 'metal',
    }];
  } catch {
    return [];
  }
}

// ── Aggregated detection ─────────────────────────────────────────────────────

export async function detectHardware(): Promise<HardwareProfile> {
  const ramGb    = Math.floor(os.totalmem() / (1024 ** 3));
  const cpuCores = os.cpus().length;
  const cpuName  = os.cpus()[0]?.model?.trim() ?? 'Unknown CPU';

  const [nvidiaGpus, nonNvidiaWin, nonNvidiaLinux, appleGpus] = await Promise.all([
    detectNvidiaGpus(),
    detectNonNvidiaGpus(),
    detectLinuxNonNvidiaGpus(),
    detectAppleSilicon(),
  ]);

  const gpus = [...nvidiaGpus, ...nonNvidiaWin, ...nonNvidiaLinux, ...appleGpus];

  return { ramGb, cpuCores, cpuName, gpus };
}

// ── GGUF model catalogue ──────────────────────────────────────────────────────
// HuggingFace direct HTTPS — no API key required for public repos.
// All bartowski quants — consistent quality, reliable CDN.
//
// IMPORTANT: bartowski Qwen3 repos use "Qwen_Qwen3-" prefix in both
// the repo name and the filename.

export interface GGUFSpec {
  /** Logical model name used as phobos provider model ID */
  modelId: string;
  label: string;
  /** HuggingFace repo: "owner/repo" */
  hfRepo: string;
  /** Exact filename within the repo */
  hfFile: string;
  /** Expected size in bytes — used for progress display */
  sizeBytes: number;
  ramRequiredGb: number;
  contextWindow: number;
}

export const GGUF_CATALOGUE: GGUFSpec[] = [
  {
    modelId: 'llama3.2-1b-q4',
    label: 'Llama 3.2 1B Q4',
    hfRepo: 'bartowski/Llama-3.2-1B-Instruct-GGUF',
    hfFile: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    sizeBytes: 770_000_000,
    ramRequiredGb: 1,
    contextWindow: 131072,
  },
  {
    modelId: 'llama3.2-3b-q4',
    label: 'Llama 3.2 3B Q4',
    hfRepo: 'bartowski/Llama-3.2-3B-Instruct-GGUF',
    hfFile: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    sizeBytes: 2_020_000_000,
    ramRequiredGb: 3,
    contextWindow: 131072,
  },
  {
    modelId: 'llama3.1-8b-q4',
    label: 'Llama 3.1 8B Q4',
    hfRepo: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',
    hfFile: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    sizeBytes: 4_920_000_000,
    ramRequiredGb: 6,
    contextWindow: 131072,
  },
  {
    modelId: 'qwen3-4b-q4',
    label: 'Qwen3 4B Q4',
    hfRepo: 'bartowski/Qwen_Qwen3-4B-GGUF',
    hfFile: 'Qwen_Qwen3-4B-Q4_K_M.gguf',
    sizeBytes: 2_580_000_000,
    ramRequiredGb: 3,
    contextWindow: 32768,
  },
  {
    modelId: 'qwen3-8b-q4',
    label: 'Qwen3 8B Q4',
    hfRepo: 'bartowski/Qwen_Qwen3-8B-GGUF',
    hfFile: 'Qwen_Qwen3-8B-Q4_K_M.gguf',
    sizeBytes: 5_190_000_000,
    ramRequiredGb: 6,
    contextWindow: 32768,
  },
  {
    modelId: 'qwen3-14b-q4',
    label: 'Qwen3 14B Q4',
    hfRepo: 'bartowski/Qwen_Qwen3-14B-GGUF',
    hfFile: 'Qwen_Qwen3-14B-Q4_K_M.gguf',
    sizeBytes: 9_000_000_000,
    ramRequiredGb: 11,
    contextWindow: 32768,
  },
  {
    modelId: 'qwen3-30b-a3b-q4',
    label: 'Qwen3 30B-A3B Q4',
    hfRepo: 'bartowski/Qwen_Qwen3-30B-A3B-GGUF',
    hfFile: 'Qwen_Qwen3-30B-A3B-Q4_K_M.gguf',
    sizeBytes: 18_400_000_000,
    ramRequiredGb: 20,
    contextWindow: 32768,
  },
];

export function getSpec(modelId: string): GGUFSpec | undefined {
  return GGUF_CATALOGUE.find(s => s.modelId === modelId);
}

export function modelPath(spec: GGUFSpec): string {
  return path.join(MODELS_DIR, spec.hfFile);
}

export function isDownloaded(spec: GGUFSpec): boolean {
  const p = modelPath(spec);
  if (!fs.existsSync(p)) return false;
  const stat = fs.statSync(p);
  return stat.size >= spec.sizeBytes * 0.9;
}

export function listDownloaded(): GGUFSpec[] {
  return GGUF_CATALOGUE.filter(isDownloaded);
}

// ── Model recommendation ──────────────────────────────────────────────────────

export interface ModelRecommendation {
  sayon: GGUFSpec;
  allmind: GGUFSpec;
  /** 'cpu' or a GpuDevice.index */
  sayonDevice: 'cpu' | number;
  allmindDevice: 'cpu' | number;
  sayonGpuLayers: number;
  allmindGpuLayers: number;
  reasoning: string;
}

function selectSayon(ramGb: number): GGUFSpec {
  if (ramGb >= 16) return GGUF_CATALOGUE.find(s => s.modelId === 'llama3.1-8b-q4')!;
  if (ramGb >= 8)  return GGUF_CATALOGUE.find(s => s.modelId === 'llama3.2-3b-q4')!;
  return GGUF_CATALOGUE.find(s => s.modelId === 'llama3.2-1b-q4')!;
}

function selectAllmindSpec(vramGb: number): GGUFSpec {
  if (vramGb >= 20) return GGUF_CATALOGUE.find(s => s.modelId === 'qwen3-30b-a3b-q4')!;
  if (vramGb >= 16) return GGUF_CATALOGUE.find(s => s.modelId === 'qwen3-14b-q4')!;
  if (vramGb >= 8)  return GGUF_CATALOGUE.find(s => s.modelId === 'qwen3-8b-q4')!;
  if (vramGb >= 4)  return GGUF_CATALOGUE.find(s => s.modelId === 'qwen3-4b-q4')!;
  return GGUF_CATALOGUE.find(s => s.modelId === 'qwen3-4b-q4')!;
}

export function buildRecommendation(hw: HardwareProfile): ModelRecommendation {
  const sayon = selectSayon(hw.ramGb);

  // Sort GPUs by VRAM descending — largest first
  const gpusByVram = [...hw.gpus].sort((a, b) => b.vramGb - a.vramGb);
  const bestGpu    = gpusByVram[0] ?? null;
  const secondGpu  = gpusByVram[1] ?? null;

  // ALLMIND: biggest GPU, or CPU fallback
  let allmind: GGUFSpec;
  let allmindDevice: 'cpu' | number;
  let allmindGpuLayers: number;

  if (bestGpu && bestGpu.vramGb >= 4) {
    allmind          = selectAllmindSpec(bestGpu.vramGb);
    allmindDevice    = bestGpu.index;
    allmindGpuLayers = 99;
  } else {
    // CPU fallback
    if (hw.ramGb >= 32) allmind = GGUF_CATALOGUE.find(s => s.modelId === 'qwen3-8b-q4')!;
    else if (hw.ramGb >= 16) allmind = GGUF_CATALOGUE.find(s => s.modelId === 'qwen3-4b-q4')!;
    else allmind = GGUF_CATALOGUE.find(s => s.modelId === 'llama3.2-3b-q4')!;
    allmindDevice    = 'cpu';
    allmindGpuLayers = 0;
  }

  // SAYON: second GPU if available (e.g. iGPU), else CPU
  let sayonDevice: 'cpu' | number = 'cpu';
  let sayonGpuLayers = 0;
  if (secondGpu && secondGpu.vramGb >= 2) {
    sayonDevice    = secondGpu.index;
    sayonGpuLayers = 99;
  }

  // Build reasoning string
  const gpuLines = hw.gpus.map(g => `${g.name} (${g.vramGb} GB, ${g.backend})`).join(' · ');
  const gpuStr   = gpuLines || 'No GPU — CPU fallback';

  const deviceName = (d: 'cpu' | number) =>
    d === 'cpu' ? 'CPU' : (hw.gpus.find(g => g.index === d)?.name ?? `GPU #${d}`);

  const reasoning =
    `System: ${hw.ramGb} GB RAM · ${hw.cpuCores} cores · ${hw.cpuName}. ` +
    `GPUs: ${gpuStr}. ` +
    `SAYON → ${sayon.label} on ${deviceName(sayonDevice)} (${sayonGpuLayers > 0 ? 'GPU offloaded' : 'CPU'}). ` +
    `ALLMIND → ${allmind.label} on ${deviceName(allmindDevice)} (${allmindGpuLayers > 0 ? 'GPU offloaded' : 'CPU'}).`;

  return { sayon, allmind, sayonDevice, allmindDevice, sayonGpuLayers, allmindGpuLayers, reasoning };
}

// ── GGUF download ─────────────────────────────────────────────────────────────

export interface DownloadProgress {
  modelId: string;
  phase: 'sayon' | 'allmind';
  bytesReceived: number;
  bytesTotal: number;
  done: boolean;
  error?: string;
}

function hfUrl(spec: GGUFSpec): string {
  return `https://huggingface.co/${spec.hfRepo}/resolve/main/${spec.hfFile}`;
}

export async function* downloadModel(
  spec: GGUFSpec,
  phase: 'sayon' | 'allmind',
): AsyncGenerator<DownloadProgress> {
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  const dest = modelPath(spec);
  const tmp  = dest + '.download';

  // Resume partial download
  const existingBytes = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
  const headers: Record<string, string> = {};
  if (existingBytes > 0) headers['Range'] = `bytes=${existingBytes}-`;

  const url = hfUrl(spec);
  let bytesReceived = existingBytes;

  yield { modelId: spec.modelId, phase, bytesReceived, bytesTotal: spec.sizeBytes, done: false };

  await new Promise<void>((resolve, reject) => {
    const follow = (targetUrl: string, redirectCount = 0) => {
      if (redirectCount > 5) { reject(new Error('Too many redirects')); return; }

      const parsed = new URL(targetUrl);
      const req = https.get(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers },
        (res) => {
          if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
            follow(res.headers.location!, redirectCount + 1);
            return;
          }
          if (res.statusCode !== 200 && res.statusCode !== 206) {
            reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
            return;
          }

          const total = res.statusCode === 206
            ? existingBytes + parseInt(res.headers['content-length'] ?? '0', 10)
            : parseInt(res.headers['content-length'] ?? String(spec.sizeBytes), 10);

          const fd = fs.createWriteStream(tmp, { flags: existingBytes > 0 ? 'a' : 'w' });

          res.on('data', (chunk: Buffer) => {
            bytesReceived += chunk.length;
            fd.write(chunk);
          });

          res.on('end', () => {
            // fd.end() guarantees flush+close before callback fires
            fd.end(() => {
              try {
                fs.renameSync(tmp, dest);
              } catch {
                // Windows OneDrive or cross-drive: fallback to copy + delete
                try {
                  fs.copyFileSync(tmp, dest);
                  fs.unlinkSync(tmp);
                } catch (copyErr) {
                  reject(new Error(`Failed to finalize download: ${copyErr}`));
                  return;
                }
              }
              resolve();
            });
          });

          res.on('error', (err) => {
            fd.destroy();
            reject(err);
          });
        },
      );
      req.on('error', reject);
    };
    follow(url);
  });

  yield { modelId: spec.modelId, phase, bytesReceived, bytesTotal: spec.sizeBytes, done: true };
}

// ── Android / Termux detection ────────────────────────────────────────────────
// On Termux, process.platform is 'linux' — we distinguish Android by checking
// for environment markers that are always present in the Termux runtime.
// ANDROID_ROOT  (/system)  — set by Android for all processes
// TERMUX_VERSION            — set by Termux's bootstrap environment
// /system/build.prop        — always present on Android, never on Linux

function isAndroid(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.ANDROID_ROOT || process.env.TERMUX_VERSION) return true;
  try { fs.accessSync('/system/build.prop'); return true; } catch { return false; }
}

// ── llama-server binary resolution ───────────────────────────────────────────
// Resolution order for each platform:
//   android-arm64  → llama-server-android-arm64   (NDK static build, Bionic libc)
//   linux-arm64    → llama-server-linux-arm64      (glibc build, Ubuntu layer)
//   win32-x64      → llama-server-win32-x64[-cuda|-vulkan].exe
//   darwin-arm64   → llama-server-darwin-arm64
//   linux-x64      → llama-server-linux-x64
// Falls back to generic llama-server-{platform}-{arch}{ext} if specific not found.

export function resolveLlamaServerBin(): string {
  const platform = process.platform;
  const arch     = process.arch;
  const ext      = platform === 'win32' ? '.exe' : '';

  // On Android/Termux, override platform to use the NDK-built static binary
  const effectivePlatform = (platform === 'linux' && arch === 'arm64' && isAndroid())
    ? 'android'
    : platform;

  const name = `llama-server-${effectivePlatform}-${arch}${ext}`;

  const seaDir   = path.dirname(process.execPath);
  const repoRoot = path.resolve(_dirname, '..', '..');

  const seaPath = path.join(seaDir, name);
  if (fs.existsSync(seaPath)) return seaPath;
  const devPath = path.join(repoRoot, 'bin', name);
  if (fs.existsSync(devPath)) return devPath;

  // On Android, fall back to the linux-arm64 glibc build if android binary absent
  if (effectivePlatform === 'android') {
    const fallbackName = `llama-server-linux-arm64`;
    const fallbackSea  = path.join(seaDir, fallbackName);
    if (fs.existsSync(fallbackSea)) return fallbackSea;
    const fallbackDev  = path.join(repoRoot, 'bin', fallbackName);
    if (fs.existsSync(fallbackDev)) return fallbackDev;
  }

  throw new Error(
    `llama-server binary not found.\n` +
    `Expected at:\n  ${seaPath}\n  ${devPath}\n` +
    `Run scripts/fetch-llamacpp.js to download binaries.`
  );
}

/**
 * Deletes a downloaded GGUF file from disk.
 */
export function deleteModel(modelId: string): boolean {
  const spec = getSpec(modelId);
  if (!spec) throw new Error(`Unknown model ID: ${modelId}`);
  const p = modelPath(spec);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  const tmp = p + '.download';
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  return true;
}
