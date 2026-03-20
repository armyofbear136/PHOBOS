import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http  from 'http';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

// ESM (tsx dev) → import.meta.url is defined; CJS (SEA bundle) → use __dirname global
const _dirname: string = (() => {
  try {
    if (typeof import.meta?.url === 'string') return path.dirname(fileURLToPath(import.meta.url));
  } catch { /* CJS bundle — import.meta.url is undefined */ }
  return typeof __dirname === 'string' ? __dirname : process.cwd();
})();

// ── Constants ─────────────────────────────────────────────────────────────────

export const MODELS_DIR       = path.join(os.homedir(), '.phobos', 'models');
/** Shared encoder/aux files — used by multiple runner profiles (VAE, CLIP-L, T5, CLIP-G) */
export const IMAGE_SHARED_DIR = path.join(os.homedir(), '.phobos', 'models', 'image');
/** FLUX and Chroma model GGUFs */
export const IMAGE_FLUX_DIR   = path.join(os.homedir(), '.phobos', 'models', 'image', 'flux');
/** SDXL model GGUFs */
export const IMAGE_SDXL_DIR   = path.join(os.homedir(), '.phobos', 'models', 'image', 'sdxl');
/** FLUX Kontext, FLUX.2, Z-Image, Qwen-Image diffusion model GGUFs */
export const IMAGE_NEW_DIR    = path.join(os.homedir(), '.phobos', 'models', 'image', 'new');
/** Wan video diffusion model GGUFs */
export const IMAGE_WAN_DIR    = path.join(os.homedir(), '.phobos', 'models', 'image', 'wan');
/** LLM-as-text-encoder GGUFs (Qwen3-4B, Qwen3-8B, Qwen2.5-VL-7B) — separate from LLM server models */
export const IMAGE_LLM_DIR    = path.join(os.homedir(), '.phobos', 'models', 'image', 'llm');
/** @deprecated use IMAGE_FLUX_DIR — kept so any external references survive */
export const FLUX_MODELS_DIR  = IMAGE_FLUX_DIR;
export const UPSCALE_MODELS_DIR = path.join(os.homedir(), '.phobos', 'models', 'upscale');

// ── Hardware detection ────────────────────────────────────────────────────────

/**
 * Runner profile — computed once at detection time, stored on GpuDevice.
 * Encapsulates everything needed to spawn llama-server and sd-cli on a
 * specific GPU without any per-spawn re-derivation.
 *
 * kind:
 *   'nvidia-vulkan'  NVIDIA GPU in a Vulkan-only llama.cpp build (no ggml-cuda.dll)
 *   'nvidia-cuda'    NVIDIA GPU with native ggml-cuda.dll present
 *   'amd-discrete'   AMD discrete GPU (Vulkan)
 *   'amd-igpu'       AMD APU / iGPU — unified memory, Vulkan
 *   'intel-igpu'     Intel integrated GPU — Vulkan
 *   'apple-metal'    Apple Silicon — Metal unified memory
 *   'cpu'            No GPU or below minimum threshold
 *
 * vulkanIndex:
 *   0-based Vulkan enumeration position for this device.
 *   NVIDIA devices enumerate FIRST in Vulkan (index = nvidia-smi index).
 *   Non-NVIDIA devices follow: vulkanIndex = nvidiaCount + wmiPositionIndex.
 *   Used for GGML_VK_VISIBLE_DEVICES and --device VulkanN.
 *   After setting GGML_VK_VISIBLE_DEVICES=vulkanIndex, the device is
 *   always Vulkan0 from llama-server's filtered perspective.
 *
 * sdBinary:
 *   Which sd-cli binary to use for image generation on this device.
 *   'cuda' → sd-cuda binary (CUDA compute, NVIDIA only)
 *   'vulkan' → sd-vulkan binary (Vulkan compute, AMD / Intel)
 *   'cpu' → sd-cpu binary (no GPU)
 */
export type GpuRunnerKind =
  | 'nvidia-vulkan'   // NVIDIA, Vulkan-only llama.cpp build
  | 'nvidia-cuda'     // NVIDIA, native ggml-cuda.dll present
  | 'nvidia-legacy'   // NVIDIA Maxwell/Kepler sm<60 — no CUDA 12 Windows support
  | 'amd-discrete'
  | 'amd-igpu'
  | 'intel-igpu'
  | 'apple-metal'
  | 'cpu';

export interface GpuRunnerProfile {
  kind:        GpuRunnerKind;
  vulkanIndex: number;   // physical Vulkan enumeration index
  sdBinary:    'cuda' | 'vulkan' | 'rocm' | 'cpu';
}

export interface GpuDevice {
  /** Free VRAM in GB at detection time (undefined if unknown — non-CUDA devices) */
  freeVramGb?: number;
  /** Stable index — CUDA uses nvidia-smi index, others use 100+ offset */
  index: number;
  name: string;
  vramGb: number;
  /** Backend llama-server should use for this device */
  backend: 'cuda' | 'vulkan' | 'metal';
  /**
   * True on Apple Silicon / AMD APUs where GPU VRAM and system RAM are the
   * same physical pool. When set, VRAM should NOT be double-counted alongside
   * system RAM — the recommendation engine will budget both models from a
   * single shared pool.
   */
  unifiedMemory?: boolean;
  /**
   * Runner profile — computed by detectHardware() after all GPUs are assembled.
   * Contains everything needed to spawn llama-server and sd-cli on this device.
   * Undefined only on cpu-fallback placeholder entries.
   */
  runner?: GpuRunnerProfile;
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
      '--query-gpu=index,name,memory.total,memory.free',
      '--format=csv,noheader,nounits',
    ]);
    const gpus: GpuDevice[] = [];
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts    = line.split(',').map(s => s.trim());
      const idx      = parseInt(parts[0], 10);
      const name     = parts[1];
      const totalMb  = parseInt(parts[2], 10);
      const freeMb   = parseInt(parts[3], 10);
      if (isNaN(idx) || isNaN(totalMb)) continue;
      gpus.push({
        index:      idx,
        name,
        vramGb:     Math.floor(totalMb / 1024),
        freeVramGb: isNaN(freeMb) ? undefined : Math.floor(freeMb / 1024),
        backend:    'cuda',
      });
    }
    return gpus;
  } catch {
    return [];
  }
}

// ── AMD / Intel iGPU detection via WMI (Windows) ─────────────────────────────

async function detectNonNvidiaGpus(): Promise<GpuDevice[]> {
  if (process.platform !== 'win32') return [];
  try {
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

    const raw   = JSON.parse(stdout.trim());
    const items = Array.isArray(raw) ? raw : [raw];
    const gpus: GpuDevice[] = [];

    for (let i = 0; i < items.length; i++) {
      const item      = items[i];
      const vramBytes = Number(item.VramBytes ?? 0);
      const vramGb    = Math.round(vramBytes / (1024 ** 3));
      if (vramGb < 1) continue;
      gpus.push({ index: 100 + i, name: String(item.Name ?? 'Unknown GPU'), vramGb, backend: 'vulkan' });
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
      if (!/VGA|3D|Display/.test(line)) continue;
      if (/NVIDIA/i.test(line)) continue;
      const isAmd   = /AMD|ATI|Radeon/i.test(line);
      const isIntel = /Intel/i.test(line);
      if (!isAmd && !isIntel) continue;
      const nameMatch = line.match(/:\s+(.+?)(?:\s+\[|$)/);
      const name = nameMatch ? nameMatch[1].trim() : (isAmd ? 'AMD GPU' : 'Intel GPU');
      gpus.push({ index: idx++, name, vramGb: 0, backend: 'vulkan' });
    }
    return gpus;
  } catch {
    return [];
  }
}

// ── Apple Silicon ─────────────────────────────────────────────────────────────

async function detectAppleSilicon(): Promise<GpuDevice[]> {
  if (process.platform !== 'darwin') return [];
  try {
    const { stdout } = await execFileAsync('system_profiler', ['SPHardwareDataType']);
    const memMatch  = stdout.match(/Memory:\s+(\d+)\s+GB/i);
    const chipMatch = stdout.match(/Chip:\s+(.+)/i);
    const isAppleSilicon = chipMatch && /Apple M/i.test(chipMatch[1]);
    if (!memMatch || !isAppleSilicon) return [];
    return [{
      index: 0,
      name: chipMatch![1].trim(),
      vramGb: parseInt(memMatch[1], 10),
      backend: 'metal',
      unifiedMemory: true,
    }];
  } catch {
    return [];
  }
}

// ── ROCm detection ───────────────────────────────────────────────────────────

let _rocmChecked = false;
let _rocmPresent = false;

/**
 * Checks if AMD ROCm runtime is available on this system.
 * Windows: Adrenalin AI Bundle installs HIP SDK — check for hiprtc*.dll in PATH or sd-rocm/.
 * Linux: ROCm packages install to /opt/rocm — check for libamdhip64.so.
 * Result is cached after first call.
 */
function _isRocmAvailable(): boolean {
  if (_rocmChecked) return _rocmPresent;
  _rocmChecked = true;

  try {
    if (process.platform === 'win32') {
      // Check if the ROCm sd-cli binary exists (it bundles its own DLLs)
      const seaDir = path.dirname(process.execPath);
      const binDir = path.join(path.resolve(_dirname, '..'), 'bin');
      const rocmDirs = [path.join(seaDir, 'sd-rocm'), path.join(binDir, 'sd-rocm')];
      _rocmPresent = rocmDirs.some(d => {
        try { return fs.existsSync(path.join(d, 'sd-server-win32-x64-rocm.exe')); } catch { return false; }
      });
    } else {
      // Linux: check for ROCm runtime library
      _rocmPresent = fs.existsSync('/opt/rocm/lib/libamdhip64.so');
    }
  } catch {
    _rocmPresent = false;
  }

  if (_rocmPresent) console.log('[HW] ROCm runtime detected — AMD discrete GPUs will use ROCm for image gen');
  return _rocmPresent;
}

// ── Aggregated detection ──────────────────────────────────────────────────────

/**
 * Runs llama-server --list-devices and returns a map of
 * { normalizedName -> vulkanIndex } from the actual runtime enumeration.
 * This is the only reliable way to get the correct Vulkan index —
 * enumeration order can change after driver updates or reboots.
 *
 * Output parsed: "ggml_vulkan: N = <device name> | ..."
 * Falls back to empty map if the binary is not found or the call fails.
 */
// Cache the Vulkan enumeration result — spawning the binary is slow and the
// Vulkan device list doesn't change between model switches within a session.
let _vkMapCache: Map<string, number> | null = null;

async function enumerateVulkanDevices(): Promise<Map<string, number>> {
  if (_vkMapCache) return _vkMapCache;
  const map = new Map<string, number>();
  try {
    const bin = resolveLlamaServerBin();
    // Run with --list-devices flag (llama.cpp b3000+) which prints all Vulkan
    // devices and exits. On older builds that don't have this flag, it exits
    // with a non-zero code but still initializes backends and prints device
    // lines to stderr — the .catch captures that output either way.
    // GGML_VK_VISIBLE_DEVICES='' ensures all devices are visible (no pre-filter).
    const result = await execFileAsync(bin, ['--list-devices'], {
      timeout: 8000,
      env: { ...process.env, GGML_VK_VISIBLE_DEVICES: '' },
    }).catch((err: any) => {
      // Non-zero exit is fine — ggml still printed device lines before exiting
      return { stdout: (err as any).stdout ?? '', stderr: (err as any).stderr ?? '' };
    });

    const output = (result.stdout ?? '') + '\n' + (result.stderr ?? '');
    for (const match of output.matchAll(/ggml_vulkan:\s+(\d+)\s*=\s*([^|\n]+)/g)) {
      const idx  = parseInt(match[1], 10);
      const name = match[2].trim();
      map.set(name.toLowerCase(), idx);
      // Also index without driver annotations in parentheses e.g. "(NVIDIA)" / "(AMD proprietary driver)"
      const short = name.toLowerCase().replace(/\(.*?\)/g, '').trim();
      if (short !== name.toLowerCase()) map.set(short, idx);
    }
    if (map.size === 0) {
      console.warn('[HW] enumerateVulkanDevices: no ggml_vulkan lines found in output');
    }
  } catch (err: any) {
    console.warn(`[HW] enumerateVulkanDevices failed: ${err?.message ?? err}`);
  }
  _vkMapCache = map;
  return map;
}

/**
 * Matches a detected GPU name against the runtime Vulkan enumeration map.
 * Uses progressively looser matching:
 *   1. Exact match (normalized)
 *   2. Substring — either name contains the other
 *   3. Significant word overlap (>=2 words >2 chars in common)
 */
function matchVulkanIndex(gpuName: string, vkMap: Map<string, number>): number | undefined {
  const needle = gpuName.toLowerCase().replace(/\(.*?\)/g, '').trim();

  if (vkMap.has(needle)) return vkMap.get(needle);
  if (vkMap.has(gpuName.toLowerCase())) return vkMap.get(gpuName.toLowerCase());

  for (const [key, idx] of vkMap) {
    if (needle.includes(key) || key.includes(needle)) return idx;
  }

  const needleWords = new Set(needle.split(/\s+/).filter(w => w.length > 2));
  for (const [key, idx] of vkMap) {
    const overlap = key.split(/\s+/).filter(w => w.length > 2 && needleWords.has(w)).length;
    if (overlap >= 2) return idx;
  }

  return undefined;
}

/**
 * Assigns a GpuRunnerProfile to every detected GPU.
 * vulkanIndex is resolved by matching the GPU name against the actual
 * runtime Vulkan enumeration from llama-server --list-devices,
 * making it robust against driver/reboot enumeration order changes.
 * Falls back to computed positional index if enumeration fails.
 */
async function assignRunnerProfiles(gpus: GpuDevice[]): Promise<void> {
  const vkMap = await enumerateVulkanDevices();
  const hasRuntimeEnum = vkMap.size > 0;

  if (hasRuntimeEnum) {
    console.log(`[HW] Vulkan runtime enum: ${[...vkMap.entries()].filter(([k]) => !k.includes('(')).map(([n, i]) => `${i}=${n}`).join(', ')}`);
  } else {
    console.warn('[HW] Vulkan runtime enumeration unavailable — using positional fallback');
  }

  const nvidiaCount = gpus.filter(g => g.backend === 'cuda').length;

  for (const gpu of gpus) {
    if (gpu.backend === 'metal') {
      gpu.runner = { kind: 'apple-metal', vulkanIndex: 0, sdBinary: 'cpu' };
      continue;
    }

    if (gpu.backend === 'cuda') {
      const runtimeIdx  = hasRuntimeEnum ? matchVulkanIndex(gpu.name, vkMap) : undefined;
      const vulkanIndex = runtimeIdx ?? gpu.index;
      if (hasRuntimeEnum) {
        console.log(`[HW] ${gpu.name}: Vulkan${vulkanIndex}${runtimeIdx !== undefined ? ' (runtime)' : ' (positional fallback)'}`);
      }
      const isLegacy = /Quadro M|GTX 9[0-9][0-9]|GTX 7[0-9][0-9].*Ti|GTX 6[0-9][0-9]|Quadro K/i.test(gpu.name);
      gpu.runner = {
        kind:     isLegacy ? 'nvidia-legacy' : 'nvidia-vulkan',
        vulkanIndex,
        sdBinary: 'cuda',
      };
      continue;
    }

    // Non-NVIDIA: runtime match primary, CUDA-hidden positional fallback.
    //
    // When CUDA_VISIBLE_DEVICES=-1 is set for the seren process, NVIDIA GPUs
    // are hidden from ggml entirely. ggml Vulkan then enumerates only the
    // non-NVIDIA devices, making the first non-NVIDIA GPU always Vulkan0 in
    // that process context. GGML_VK_VISIBLE_DEVICES further filters within
    // that already-CUDA-hidden Vulkan list.
    //
    // Positional index = position among non-NVIDIA GPUs only (0-based),
    // NOT offset by nvidiaCount (those are hidden from this process).
    const nonNvidiaPosition = gpus.filter(g =>
      g.backend !== 'cuda' && g.backend !== 'metal' && g.index < gpu.index
    ).length;
    const positionalIndex = nonNvidiaPosition; // 0-based within non-NVIDIA only
    const runtimeIdx      = hasRuntimeEnum ? matchVulkanIndex(gpu.name, vkMap) : undefined;
    const vulkanIndex     = runtimeIdx ?? positionalIndex;

    console.log(`[HW] ${gpu.name}: Vulkan${vulkanIndex}${runtimeIdx !== undefined ? ' (runtime)' : ' (positional fallback, CUDA-hidden)'}`);

    const isAmd     = /AMD|Radeon|ATI/i.test(gpu.name);
    const isIntel   = /Intel/i.test(gpu.name);
    const isUnified = gpu.unifiedMemory === true;

    let kind: GpuRunnerKind;
    if (isAmd && isUnified)  kind = 'amd-igpu';
    else if (isAmd)          kind = 'amd-discrete';
    else if (isIntel)        kind = 'intel-igpu';
    else                     kind = 'amd-discrete';

    let sdBin: 'rocm' | 'vulkan' | 'cpu' = 'vulkan';
    if (isAmd && !isUnified) sdBin = _isRocmAvailable() ? 'rocm' : 'vulkan';

    gpu.runner = { kind, vulkanIndex, sdBinary: sdBin };
  }
}

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
  await assignRunnerProfiles(gpus);
  return { ramGb, cpuCores, cpuName, gpus };
}

// ── GGUF model catalogue ──────────────────────────────────────────────────────

export interface GGUFSpec {
  modelId: string;
  label: string;
  family: string;
  role: 'sayon' | 'seren' | 'both';
  thinkingTokens: boolean;
  jinjaTemplate: boolean;
  hfRepo: string;
  hfFile: string;
  sizeBytes: number;
  /**
   * KV cache memory cost in MB per 1K tokens of context, at F16 precision.
   * Used by recommendContextSize() to compute the largest safe context window
   * for the available VRAM or RAM on the target device.
   * Empirically measured from llama-server startup logs.
   */
  kvCacheMbPer1kTokens: number;
  ramRequiredGb: number;
  contextWindow: number;
  /** If true, model is shown in the Legacy section of the UI. Still downloadable/usable. */
  legacy?: boolean;
  /**
   * Nemotron architecture variant:
   * 'llama' — Llama 3.1 derivative, reasoning toggled via system prompt (4B, 9B)
   * 'mamba' — Mamba-2/MoE hybrid, reasoning toggled via chat_template_kwargs (30B-A3B)
   */
  nemotronVariant?: 'llama' | 'mamba';
}

export const GGUF_CATALOGUE: GGUFSpec[] = [
  // ── Llama 3 family ───────────────────────────────────────────────────────────
  // Llama 3 family — 3B and 8B only. Gemma 3 1B covers the 1B use case.
  {
    modelId: 'llama3.2-3b-q4', label: 'Llama 3.2 3B Q4', family: 'Llama 3',
    role: 'sayon', thinkingTokens: false, jinjaTemplate: false,
    hfRepo: 'bartowski/Llama-3.2-3B-Instruct-GGUF',
    hfFile: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    sizeBytes: 2_020_000_000, ramRequiredGb: 3, contextWindow: 131072,
    kvCacheMbPer1kTokens: 112,  // 28 layers x 8 KV heads x 128 head_dim x 2 x F16
  },
  {
    modelId: 'llama3.1-8b-q4', label: 'Llama 3.1 8B Q4', family: 'Llama 3',
    role: 'sayon', thinkingTokens: false, jinjaTemplate: false,
    hfRepo: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',
    hfFile: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    sizeBytes: 4_920_000_000, ramRequiredGb: 6, contextWindow: 131072,
    kvCacheMbPer1kTokens: 128,  // 32 layers x 8 KV heads x 128 head_dim x 2 x F16
  },
  // ── Gemma 3 family ───────────────────────────────────────────────────────────
  {
    modelId: 'gemma3-1b-q4', label: 'Gemma 3 1B Q4', family: 'Gemma 3',
    role: 'sayon', thinkingTokens: false, jinjaTemplate: false,
    hfRepo: 'bartowski/google_gemma-3-1b-it-GGUF',
    hfFile: 'google_gemma-3-1b-it-Q4_K_M.gguf',
    sizeBytes: 694_000_000, ramRequiredGb: 1, contextWindow: 32768,
    kvCacheMbPer1kTokens: 72,   // 18 layers x 4 KV heads x 256 head_dim x 2 x F16
  },
  {
    modelId: 'gemma3-4b-q4', label: 'Gemma 3 4B Q4', family: 'Gemma 3',
    role: 'sayon', thinkingTokens: false, jinjaTemplate: false,
    hfRepo: 'bartowski/google_gemma-3-4b-it-GGUF',
    hfFile: 'google_gemma-3-4b-it-Q4_K_M.gguf',
    sizeBytes: 2_530_000_000, ramRequiredGb: 3, contextWindow: 131072,
    kvCacheMbPer1kTokens: 72,   // 18 layers x 4 KV heads x 256 head_dim x 2 x F16
  },
  {
    modelId: 'gemma3-12b-q4', label: 'Gemma 3 12B Q4', family: 'Gemma 3',
    role: 'sayon', thinkingTokens: false, jinjaTemplate: false,
    hfRepo: 'bartowski/google_gemma-3-12b-it-GGUF',
    hfFile: 'google_gemma-3-12b-it-Q4_K_M.gguf',
    sizeBytes: 7_800_000_000, ramRequiredGb: 10, contextWindow: 131072,
    kvCacheMbPer1kTokens: 224,  // 28 layers x 8 KV heads x 256 head_dim x 2 x F16
  },
  // ── Qwen3.5 family (March 2026) ──────────────────────────────────────────────
  // Qwen3.5 replaces Qwen3 as the primary SEREN model family.
  // Key differences from Qwen3:
  //   - 262K native context (vs 32K)
  //   - Gated Delta Networks + MoE hybrid architecture
  //   - Native multimodal (text + image + video)
  //   - No /think /nothink soft-switch — thinking controlled via API params
  //   - 4B+ think by default; 0.8B/2B have thinking off by default
  // llama-server: --jinja --reasoning-format deepseek works (same <think> tags)
  {
    modelId: 'qwen3.5-4b-q4', label: 'Qwen3.5 4B Q4', family: 'Qwen3.5',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/Qwen_Qwen3.5-4B-GGUF',
    hfFile: 'Qwen_Qwen3.5-4B-Q4_K_M.gguf',
    sizeBytes: 2_600_000_000, ramRequiredGb: 3, contextWindow: 262144,
    kvCacheMbPer1kTokens: 112,  // hybrid attention (GDN + sparse) — effective KV cost lower than Qwen3
  },
  {
    modelId: 'qwen3.5-9b-q4', label: 'Qwen3.5 9B Q4', family: 'Qwen3.5',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/Qwen_Qwen3.5-9B-GGUF',
    hfFile: 'Qwen_Qwen3.5-9B-Q4_K_M.gguf',
    sizeBytes: 5_500_000_000, ramRequiredGb: 7, contextWindow: 262144,
    kvCacheMbPer1kTokens: 144,  // estimated from Qwen3-8B baseline, hybrid attention reduces effective cost
  },
  {
    modelId: 'qwen3.5-27b-q4', label: 'Qwen3.5 27B Q4', family: 'Qwen3.5',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/Qwen_Qwen3.5-27B-GGUF',
    hfFile: 'Qwen_Qwen3.5-27B-Q4_K_M.gguf',
    sizeBytes: 16_000_000_000, ramRequiredGb: 18, contextWindow: 262144,
    kvCacheMbPer1kTokens: 224,  // dense 27B — similar KV structure to Gemma 3 12B but more layers
  },
  {
    modelId: 'qwen3.5-35b-a3b-q4', label: 'Qwen3.5 35B-A3B Q4', family: 'Qwen3.5',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/Qwen_Qwen3.5-35B-A3B-GGUF',
    hfFile: 'Qwen_Qwen3.5-35B-A3B-Q4_K_M.gguf',
    sizeBytes: 21_000_000_000, ramRequiredGb: 23, contextWindow: 262144,
    kvCacheMbPer1kTokens: 96,   // MoE sparse — active params ~3B, KV cost similar to 4B
  },
  // ── Qwen3 family (legacy) ───────────────────────────────────────────────────
  // Superseded by Qwen3.5. Still downloadable for users who prefer them.
  {
    modelId: 'qwen3-4b-q4', label: 'Qwen3 4B Q4', family: 'Qwen3',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true, legacy: true,
    hfRepo: 'bartowski/Qwen_Qwen3-4B-GGUF',
    hfFile: 'Qwen_Qwen3-4B-Q4_K_M.gguf',
    sizeBytes: 2_580_000_000, ramRequiredGb: 3, contextWindow: 32768,
    kvCacheMbPer1kTokens: 144,
  },
  {
    modelId: 'qwen3-8b-q4', label: 'Qwen3 8B Q4', family: 'Qwen3',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true, legacy: true,
    hfRepo: 'bartowski/Qwen_Qwen3-8B-GGUF',
    hfFile: 'Qwen_Qwen3-8B-Q4_K_M.gguf',
    sizeBytes: 5_190_000_000, ramRequiredGb: 6, contextWindow: 32768,
    kvCacheMbPer1kTokens: 144,
  },
  {
    modelId: 'qwen3-14b-q4', label: 'Qwen3 14B Q4', family: 'Qwen3',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true, legacy: true,
    hfRepo: 'bartowski/Qwen_Qwen3-14B-GGUF',
    hfFile: 'Qwen_Qwen3-14B-Q4_K_M.gguf',
    sizeBytes: 9_000_000_000, ramRequiredGb: 11, contextWindow: 32768,
    kvCacheMbPer1kTokens: 160,
  },
  {
    modelId: 'qwen3-30b-a3b-q4', label: 'Qwen3 30B-A3B Q4', family: 'Qwen3',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true, legacy: true,
    hfRepo: 'bartowski/Qwen_Qwen3-30B-A3B-GGUF',
    hfFile: 'Qwen_Qwen3-30B-A3B-Q4_K_M.gguf',
    sizeBytes: 18_400_000_000, ramRequiredGb: 20, contextWindow: 32768,
    kvCacheMbPer1kTokens: 96,
  },
  // ── Mistral family ───────────────────────────────────────────────────────────
  {
    modelId: 'mistral-7b-q4', label: 'Mistral 7B v0.3 Q4', family: 'Mistral',
    role: 'seren', thinkingTokens: false, jinjaTemplate: false,
    hfRepo: 'bartowski/Mistral-7B-Instruct-v0.3-GGUF',
    hfFile: 'Mistral-7B-Instruct-v0.3-Q4_K_M.gguf',
    sizeBytes: 4_370_000_000, ramRequiredGb: 6, contextWindow: 32768,
    kvCacheMbPer1kTokens: 128,  // 32 layers x 8 KV heads x 128 head_dim x 2 x F16
  },
  {
    modelId: 'magistral-8b-q4', label: 'Magistral 24B Q4', family: 'Mistral',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/mistralai_Magistral-Small-2506-GGUF',
    hfFile: 'mistralai_Magistral-Small-2506-Q4_K_M.gguf',
    sizeBytes: 14_400_000_000, ramRequiredGb: 16, contextWindow: 131072,
    kvCacheMbPer1kTokens: 128,  // 32 layers x 8 KV heads x 128 head_dim x 2 x F16
  },
  // ── DeepSeek-R1 family ───────────────────────────────────────────────────────
  {
    modelId: 'deepseek-r1-8b-q4', label: 'DeepSeek-R1 8B Q4', family: 'DeepSeek-R1',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/deepseek-ai_DeepSeek-R1-0528-Qwen3-8B-GGUF',
    hfFile: 'deepseek-ai_DeepSeek-R1-0528-Qwen3-8B-Q4_K_M.gguf',
    sizeBytes: 5_190_000_000, ramRequiredGb: 6, contextWindow: 32768,
    kvCacheMbPer1kTokens: 144,  // 36 layers x 8 KV heads x 128 head_dim x 2 x F16
  },
  {
    modelId: 'deepseek-r1-14b-q4', label: 'DeepSeek-R1 14B Q4', family: 'DeepSeek-R1',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF',
    hfFile: 'DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf',
    sizeBytes: 9_050_000_000, ramRequiredGb: 11, contextWindow: 65536,
    kvCacheMbPer1kTokens: 192,  // 48 layers x 8 KV heads x 128 head_dim x 2 x F16
  },
  {
    modelId: 'deepseek-r1-70b-q4', label: 'DeepSeek-R1 70B Q4', family: 'DeepSeek-R1',
    role: 'seren', thinkingTokens: true, jinjaTemplate: false,
    hfRepo: 'bartowski/DeepSeek-R1-Distill-Llama-70B-GGUF',
    hfFile: 'DeepSeek-R1-Distill-Llama-70B-Q4_K_M.gguf',
    sizeBytes: 42_520_000_000, ramRequiredGb: 48, contextWindow: 65536,
    kvCacheMbPer1kTokens: 320,  // 80 layers x 8 KV heads x 128 head_dim x 2 x F16
  },
  // ── Nemotron 3 family ────────────────────────────────────────────────────────
  // Hybrid Mamba-2/MoE-Transformer architecture from NVIDIA. Requires llama.cpp b6315+
  // for the nemotron_h architecture type. Thinking tokens supported via <think> tags.
  // License: NVIDIA Open Model License (commercial-friendly open weights).
  // Knowledge cutoff: pre-training June 2025, post-training November 2025.
  {
    modelId: 'nemotron3-4b-q4', label: 'Nemotron 3 Nano 4B Q4', family: 'Nemotron 3',
    role: 'sayon', thinkingTokens: true, jinjaTemplate: true, nemotronVariant: 'llama',
    hfRepo: 'unsloth/NVIDIA-Nemotron-3-Nano-4B-GGUF',
    hfFile: 'NVIDIA-Nemotron-3-Nano-4B-Q4_K_M.gguf',
    sizeBytes: 2_600_000_000, ramRequiredGb: 4, contextWindow: 32768,
    kvCacheMbPer1kTokens: 96,   // Llama 3.1 derivative — reasoning via system prompt
  },
  {
    modelId: 'nemotron3-9b-q4', label: 'Nemotron 3 Nano 9B Q4', family: 'Nemotron 3',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true, nemotronVariant: 'llama',
    hfRepo: 'bartowski/nvidia_NVIDIA-Nemotron-Nano-9B-v2-GGUF',
    hfFile: 'nvidia_NVIDIA-Nemotron-Nano-9B-v2-Q4_K_M.gguf',
    sizeBytes: 5_700_000_000, ramRequiredGb: 7, contextWindow: 32768,
    kvCacheMbPer1kTokens: 96,   // Llama 3.1 derivative — reasoning via system prompt
  },
  {
    modelId: 'nemotron3-30b-a3b-q4', label: 'Nemotron 3 Nano 30B-A3B Q4', family: 'Nemotron 3',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true, nemotronVariant: 'mamba',
    hfRepo: 'unsloth/Nemotron-3-Nano-30B-A3B-GGUF',
    hfFile: 'Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf',
    sizeBytes: 22_800_000_000, ramRequiredGb: 25, contextWindow: 32768,
    kvCacheMbPer1kTokens: 96,   // Mamba-2/MoE hybrid — ~3B active params, reasoning via chat_template_kwargs
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
  return fs.statSync(p).size >= spec.sizeBytes * 0.9;
}

export function listDownloaded(): GGUFSpec[] {
  return GGUF_CATALOGUE.filter(isDownloaded);
}

// ── FLUX image model catalogue ────────────────────────────────────────────────
// FLUX models require three separate files:
//   1. Main diffusion weights (GGUF, quantized)
//   2. VAE — ae.safetensors (~335 MB, shared across all variants)
//   3. Text encoders — CLIP-L (~246 MB) + T5-XXL GGUF (Q4 ~2.4 GB or Q8 ~4.7 GB)
//
// sd-server CLI: --model <flux.gguf> --vae <ae.safetensors>
//                --clip_l <clip_l.safetensors> --t5xxl <t5xxl.gguf>
//
// VAE and CLIP-L are shared; T5 quantization is chosen per VRAM budget.

/**
 * Runner profile determines which sd.cpp CLI flags are used:
 *   flux          — --diffusion-model + --clip_l + --t5xxl + --vae
 *   sdxl          — -m (single file, VAE baked) + --clip_l + --clip_g
 *   flux1-kontext — --diffusion-model + --clip_l + --t5xxl + --vae + -r + --vae-decode-only false
 *   flux2         — --diffusion-model + --llm + --vae (flux2_ae) + --diffusion-fa
 *   z-image       — --diffusion-model + --llm + --vae + --diffusion-fa
 *   qwen-image    — --diffusion-model + --llm + --vae + --diffusion-fa + --flow-shift
 */
export type ImageRunnerProfile =
  | 'flux'
  | 'sdxl'
  | 'flux1-kontext'
  | 'flux2'
  | 'z-image'
  | 'qwen-image'
  | 'wan';

/**
 * Category tag for UI grouping. nsfw-realistic / nsfw-anime are gated behind
 * a content warning in the UI but use the same download infrastructure.
 * legacy = superseded models (FLUX schnell) — collapsed behind a toggle.
 */
export type ImageModelCategory = 'realistic' | 'anime' | 'nsfw-realistic' | 'nsfw-anime' | 'legacy' | 'video';

export interface ImageModelSpec {
  modelId: string;
  label: string;
  /** Short name shown on the card e.g. "FLUX.1-schnell" */
  displayName: string;
  runnerProfile: ImageRunnerProfile;
  category: ImageModelCategory;
  variant: 'schnell' | 'dev' | 'pony' | 'sdxl' | 'chroma' | 'kontext' | 'flux2' | 'z-image' | 'qwen-image' | 'wan';
  quantization: 'Q4_K_M' | 'Q8_0' | 'Q4_0' | 'Q3_K_M' | 'Q5_K_S' | 'f16';
  hfRepo: string;
  hfFile: string;
  sizeBytes: number;
  /** Minimum VRAM in GB */
  vramRequiredGb: number;
  /** Estimated generation time on CUDA (RTX 3080 class), seconds */
  estSecondsCuda: number;
  /** Estimated generation time on Vulkan (iGPU class), seconds */
  estSecondsVulkan: number;
  /** Estimated generation time on CPU, seconds */
  estSecondsCpu: number;
  license: string;
  licenseUrl: string;
}

/** Backward-compat alias — existing code that imports FluxSpec still works */
export type FluxSpec = ImageModelSpec;

export interface FluxAuxFile {
  id: string;
  label: string;
  hfRepo: string;
  hfFile: string;
  /** Local filename override — use when hfFile contains a subdirectory path.
   *  If omitted, path.basename(hfFile) is used as the local filename. */
  localFile?: string;
  sizeBytes: number;
  /** CLI flag passed to sd-server */
  cliFlag: string;
  /** SPDX licence identifier */
  license: string;
  licenseUrl: string;
}

// ── Shared aux files — downloaded once, reused by all FLUX variants ───────────

export const FLUX_VAE: FluxAuxFile = {
  id:        'flux-vae',
  label:     'FLUX VAE',
  hfRepo:    'second-state/FLUX.1-schnell-GGUF',
  hfFile:    'ae.safetensors',
  sizeBytes: 335_000_000,
  cliFlag:   '--vae',
  license:    'Apache-2.0',
  licenseUrl: 'https://huggingface.co/black-forest-labs/FLUX.1-schnell/blob/main/LICENSE.md',
};

export const FLUX_CLIP_L: FluxAuxFile = {
  id:        'flux-clip-l',
  label:     'FLUX CLIP-L encoder',
  hfRepo:    'comfyanonymous/flux_text_encoders',
  hfFile:    'clip_l.safetensors',
  sizeBytes: 246_000_000,
  cliFlag:   '--clip_l',
  license:    'MIT',
  licenseUrl: 'https://huggingface.co/comfyanonymous/flux_text_encoders/blob/main/LICENSE',
};

export const FLUX_T5_Q3: FluxAuxFile = {
  id:        'flux-t5-q3',
  label:     'T5-XXL encoder Q3_K_M (~2.3 GB)',
  hfRepo:    'city96/t5-v1_1-xxl-encoder-gguf',
  hfFile:    't5-v1_1-xxl-encoder-Q3_K_M.gguf',
  sizeBytes: 2_300_000_000,
  cliFlag:   '--t5xxl',
  license:    'Apache-2.0',
  licenseUrl: 'https://huggingface.co/google/t5-v1_1-xxl/blob/main/LICENSE',
};

export const FLUX_T5_Q4: FluxAuxFile = {
  id:        'flux-t5-q4',
  label:     'T5-XXL encoder Q4_K_M (~2.9 GB)',
  hfRepo:    'city96/t5-v1_1-xxl-encoder-gguf',
  hfFile:    't5-v1_1-xxl-encoder-Q4_K_M.gguf',
  sizeBytes: 2_900_000_000,
  cliFlag:   '--t5xxl',
  license:    'Apache-2.0',
  licenseUrl: 'https://huggingface.co/google/t5-v1_1-xxl/blob/main/LICENSE',
};

export const FLUX_T5_Q8: FluxAuxFile = {
  id:        'flux-t5-q8',
  label:     'T5-XXL encoder Q8_0 (~5.1 GB)',
  hfRepo:    'city96/t5-v1_1-xxl-encoder-gguf',
  hfFile:    't5-v1_1-xxl-encoder-Q8_0.gguf',
  sizeBytes: 5_060_000_000,
  cliFlag:   '--t5xxl',
  license:    'Apache-2.0',
  licenseUrl: 'https://huggingface.co/google/t5-v1_1-xxl/blob/main/LICENSE',
};

/** Always-required aux files (VAE + CLIP-L). T5 encoder chosen separately. */
export const FLUX_AUX_REQUIRED: FluxAuxFile[] = [FLUX_VAE, FLUX_CLIP_L];

/** Chroma aux files — VAE only, no CLIP-L (trained without CLIP-L conditioning). T5 chosen separately. */
export const CHROMA_AUX_REQUIRED: FluxAuxFile[] = [FLUX_VAE];

// ── New-family aux files ──────────────────────────────────────────────────────
// These live in IMAGE_SHARED_DIR (safetensors) or IMAGE_LLM_DIR (GGUF LLMs).
// fluxAuxPath() routes by cliFlag — '--llm' entries resolve to IMAGE_LLM_DIR.

/** FLUX.2-family VAE — different from FLUX.1 ae.safetensors, not interchangeable. */
export const FLUX2_VAE: FluxAuxFile = {
  id:         'flux2-vae',
  label:      'FLUX.2 VAE',
  hfRepo:     'Comfy-Org/flux2-dev',
  hfFile:     'split_files/vae/flux2-vae.safetensors',
  localFile:  'flux2-vae.safetensors',
  sizeBytes:  335_000_000,
  cliFlag:    '--vae',
  license:    'Apache-2.0',
  licenseUrl: 'https://huggingface.co/Comfy-Org/flux2-dev',
};

/** Qwen-Image VAE — unique to Qwen-Image, not shared with FLUX or FLUX.2. */
export const QWEN_IMAGE_VAE: FluxAuxFile = {
  id:         'qwen-image-vae',
  label:      'Qwen-Image VAE',
  hfRepo:     'Comfy-Org/Qwen-Image_ComfyUI',
  hfFile:     'split_files/vae/qwen_image_vae.safetensors',
  sizeBytes:  254_000_000,
  cliFlag:    '--vae',
  license:    'Apache-2.0',
  licenseUrl: 'https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI',
};

/**
 * Qwen3-4B GGUF used as --llm text encoder for Z-Image and FLUX.2-klein-4B.
 * Kept separate from the LLM server's Qwen3.5 4B — different instruct tuning,
 * weight compatibility with sd-cli not yet verified. Resolves to IMAGE_LLM_DIR.
 */
export const ZIMAGE_LLM_Q4: FluxAuxFile = {
  id:         'zimage-llm-qwen3-4b-q4',
  label:      'Qwen3-4B text encoder Q4 (~2.5 GB)',
  hfRepo:     'unsloth/Qwen3-4B-Instruct-2507-GGUF',
  hfFile:     'Qwen3-4B-Instruct-2507-Q4_K_M.gguf',
  sizeBytes:  2_500_000_000,
  cliFlag:    '--llm',
  license:    'Apache-2.0',
  licenseUrl: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/blob/main/LICENSE',
};

/** Qwen3-8B GGUF text encoder for FLUX.2-klein-9B. Resolves to IMAGE_LLM_DIR. */
export const FLUX2_LLM_9B_Q4: FluxAuxFile = {
  id:         'flux2-llm-qwen3-8b-q4',
  label:      'Qwen3-8B text encoder Q4 (~5 GB)',
  hfRepo:     'unsloth/Qwen3-8B-GGUF',
  hfFile:     'Qwen3-8B-Q4_K_M.gguf',
  sizeBytes:  5_190_000_000,
  cliFlag:    '--llm',
  license:    'Apache-2.0',
  licenseUrl: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/blob/main/LICENSE',
};

/** Qwen2.5-VL-7B GGUF text encoder for Qwen-Image. Resolves to IMAGE_LLM_DIR. */
export const QWEN_IMAGE_LLM_Q4: FluxAuxFile = {
  id:         'qwen-image-llm-q4',
  label:      'Qwen2.5-VL-7B text encoder Q4 (~5.2 GB)',
  hfRepo:     'unsloth/Qwen2.5-VL-7B-Instruct-GGUF',
  hfFile:     'Qwen2.5-VL-7B-Instruct-UD-Q4_K_XL.gguf',
  sizeBytes:  5_200_000_000,
  cliFlag:    '--llm',
  license:    'Apache-2.0',
  licenseUrl: 'https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct-GGUF/blob/main/LICENSE',
};

// Kontext reuses FLUX_AUX_REQUIRED (same VAE + CLIP-L + T5 pool as FLUX.1).
export const KONTEXT_AUX_REQUIRED: FluxAuxFile[]      = [FLUX_VAE, FLUX_CLIP_L];
export const FLUX2_4B_AUX_REQUIRED: FluxAuxFile[]     = [FLUX2_VAE, ZIMAGE_LLM_Q4];
export const FLUX2_9B_AUX_REQUIRED: FluxAuxFile[]     = [FLUX2_VAE, FLUX2_LLM_9B_Q4];
export const ZIMAGE_AUX_REQUIRED: FluxAuxFile[]       = [FLUX_VAE, ZIMAGE_LLM_Q4];
export const QWEN_IMAGE_AUX_REQUIRED: FluxAuxFile[]   = [QWEN_IMAGE_VAE, QWEN_IMAGE_LLM_Q4];

// ── Wan video aux files ───────────────────────────────────────────────────────
// Wan uses --t5xxl for its text encoder (UMT5-XXL, different weights from FLUX T5)
// and --vae for the Wan VAE. Both are shared across all Wan model variants.

export const WAN_VAE: FluxAuxFile = {
  id:         'wan-vae',
  label:      'Wan 2.1 VAE',
  hfRepo:     'Comfy-Org/Wan_2.1_ComfyUI_repackaged',
  hfFile:     'split_files/vae/wan_2.1_vae.safetensors',
  localFile:  'wan_2.1_vae.safetensors',
  sizeBytes:  100_000_000,
  cliFlag:    '--vae',
  license:    'Apache-2.0',
  licenseUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged',
};

/**
 * UMT5-XXL text encoder for Wan. Different weights from FLUX T5 (t5-v1_1-xxl).
 * city96 recommends Q5_K_M or larger — non-imatrix quant, lower quants degrade quality.
 * Same --t5xxl CLI flag as FLUX, but a completely separate download.
 */
export const WAN_T5_Q5: FluxAuxFile = {
  id:         'wan-umt5-q5',
  label:      'UMT5-XXL text encoder Q5_K_M (~4.2 GB)',
  hfRepo:     'city96/umt5-xxl-encoder-gguf',
  hfFile:     'umt5-xxl-encoder-Q5_K_M.gguf',
  sizeBytes:  4_150_000_000,
  cliFlag:    '--t5xxl',
  license:    'Apache-2.0',
  licenseUrl: 'https://huggingface.co/city96/umt5-xxl-encoder-gguf',
};

/** CLIP Vision encoder for I2V — only needed by I2V models, not T2V. */
export const WAN_CLIP_VISION: FluxAuxFile = {
  id:         'wan-clip-vision',
  label:      'CLIP Vision encoder (I2V, ~1.7 GB)',
  hfRepo:     'Comfy-Org/Wan_2.1_ComfyUI_repackaged',
  hfFile:     'split_files/clip_vision/clip_vision_h.safetensors',
  localFile:  'clip_vision_h.safetensors',
  sizeBytes:  1_730_000_000,
  cliFlag:    '--clip_vision',
  license:    'Apache-2.0',
  licenseUrl: 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged',
};

export const WAN_AUX_REQUIRED: FluxAuxFile[]     = [WAN_VAE, WAN_T5_Q5];
export const WAN_I2V_AUX_REQUIRED: FluxAuxFile[] = [WAN_VAE, WAN_T5_Q5, WAN_CLIP_VISION];

// ── FLUX catalogue ────────────────────────────────────────────────────────────

export const FLUX_CATALOGUE: FluxSpec[] = [
  // ── schnell — Apache 2.0, 4-step generation ──────────────────────────────
  {
    modelId:          'flux-schnell-q4',
    label:            'FLUX.1-schnell Q4',
    displayName:      'FLUX.1-schnell',
    runnerProfile:    'flux',
    category:         'legacy',
    variant:          'schnell',
    quantization:     'Q4_K_M',
    hfRepo:           'calcuis/flux1-gguf',
    hfFile:           'flux1-schnell-q4_k_m.gguf',
    sizeBytes:        6_800_000_000,
    vramRequiredGb:   8,
    estSecondsCuda:   12,
    estSecondsVulkan: 45,
    estSecondsCpu:    480,
    license:          'apache-2.0',
    licenseUrl:       'https://huggingface.co/black-forest-labs/FLUX.1-schnell/blob/main/LICENSE.md',
  },
  {
    modelId:          'flux-schnell-q8',
    label:            'FLUX.1-schnell Q8',
    displayName:      'FLUX.1-schnell',
    runnerProfile:    'flux',
    category:         'legacy',
    variant:          'schnell',
    quantization:     'Q8_0',
    hfRepo:           'city96/FLUX.1-schnell-gguf',
    hfFile:           'flux1-schnell-Q8_0.gguf',
    sizeBytes:        11_900_000_000,
    vramRequiredGb:   12,
    estSecondsCuda:   15,
    estSecondsVulkan: 60,
    estSecondsCpu:    600,
    license:          'apache-2.0',
    licenseUrl:       'https://huggingface.co/black-forest-labs/FLUX.1-schnell/blob/main/LICENSE.md',
  },
  // ── dev — non-commercial, 20-50 step generation ──────────────────────────
  {
    modelId:          'flux-dev-q4',
    label:            'FLUX.1-dev Q4',
    displayName:      'FLUX.1-dev',
    runnerProfile:    'flux',
    category:         'realistic',
    variant:          'dev',
    quantization:     'Q4_0',
    hfRepo:           'city96/FLUX.1-dev-gguf',
    hfFile:           'flux1-dev-Q4_0.gguf',
    sizeBytes:        6_790_000_000,
    vramRequiredGb:   8,
    estSecondsCuda:   90,
    estSecondsVulkan: 300,
    estSecondsCpu:    3600,
    license:          'FLUX-1-dev-Non-Commercial',
    licenseUrl:       'https://huggingface.co/black-forest-labs/FLUX.1-dev/blob/main/LICENSE.md',
  },
  {
    modelId:          'flux-dev-q8',
    label:            'FLUX.1-dev Q8',
    displayName:      'FLUX.1-dev',
    runnerProfile:    'flux',
    category:         'realistic',
    variant:          'dev',
    quantization:     'Q8_0',
    hfRepo:           'city96/FLUX.1-dev-gguf',
    hfFile:           'flux1-dev-Q8_0.gguf',
    sizeBytes:        11_900_000_000,
    vramRequiredGb:   12,
    estSecondsCuda:   110,
    estSecondsVulkan: 380,
    estSecondsCpu:    4200,
    license:          'FLUX-1-dev-Non-Commercial',
    licenseUrl:       'https://huggingface.co/black-forest-labs/FLUX.1-dev/blob/main/LICENSE.md',
  },
];

// ── Chroma (FLUX-architecture, uncensored) ────────────────────────────────────
// Same aux pool as FLUX.1-schnell (FLUX_VAE + FLUX_CLIP_L + FLUX_T5_*).
// No additional downloads if schnell is already installed.

export const CHROMA_CATALOGUE: ImageModelSpec[] = [
  // ── Chroma1-HD — FLUX-architecture, uncensored realistic ─────────────────
  // Reuses FLUX aux pool (VAE + T5). No CLIP-L needed. Apache 2.0.
  {
    modelId:          'chroma-q4',
    label:            'Chroma1-HD Q4',
    displayName:      'Chroma1-HD',
    runnerProfile:    'flux',
    category:         'realistic',
    variant:          'chroma',
    quantization:     'Q4_0',
    hfRepo:           'silveroxides/Chroma1-HD-GGUF',
    hfFile:           'Chroma1-HD-Q4_0.gguf',
    sizeBytes:        5_430_000_000,
    vramRequiredGb:   8,
    estSecondsCuda:   14,
    estSecondsVulkan: 50,
    estSecondsCpu:    500,
    license:          'Apache-2.0',
    licenseUrl:       'https://huggingface.co/lodestones/Chroma/blob/main/LICENSE',
  },
];

// ── SDXL shared aux files ─────────────────────────────────────────────────────
// Downloaded once, shared by ALL SDXL models.
// SDXL_CLIP_L re-uses the same file as FLUX — if FLUX is installed it's already present.
// VAE is baked into all GGUF models in the SDXL catalogue — no separate download needed.

export const SDXL_CLIP_L: FluxAuxFile = {
  id:        'sdxl-clip-l',
  label:     'SDXL CLIP-L encoder',
  hfRepo:    'comfyanonymous/flux_text_encoders',
  hfFile:    'clip_l.safetensors',
  sizeBytes: 246_000_000,
  cliFlag:   '--clip_l',
  license:    'MIT',
  licenseUrl: 'https://huggingface.co/comfyanonymous/flux_text_encoders/blob/main/LICENSE',
};

export const SDXL_CLIP_G: FluxAuxFile = {
  id:        'sdxl-clip-g',
  label:     'SDXL CLIP-G encoder',
  hfRepo:    'second-state/stable-diffusion-3.5-large-GGUF',
  hfFile:    'clip_g.safetensors',
  sizeBytes: 1_390_000_000,
  cliFlag:   '--clip_g',
  license:    'Apache-2.0',
  licenseUrl: 'https://huggingface.co/second-state/stable-diffusion-3.5-large-GGUF/blob/main/LICENSE',
};

export const SDXL_VAE: FluxAuxFile = {
  id:        'sdxl-vae',
  label:     'SDXL VAE (fp16 fix)',
  hfRepo:    'madebyollin/sdxl-vae-fp16-fix',
  hfFile:    'sdxl_vae.safetensors',
  sizeBytes: 335_000_000,
  cliFlag:   '--vae',
  license:    'Apache-2.0',
  licenseUrl: 'https://huggingface.co/madebyollin/sdxl-vae-fp16-fix/blob/main/LICENSE',
};

/** Always-required SDXL aux files. VAE omitted — baked into all GGUF models in catalogue. */
export const SDXL_AUX_REQUIRED: FluxAuxFile[] = [SDXL_CLIP_L, SDXL_CLIP_G];

// ── SDXL catalogue ────────────────────────────────────────────────────────────
// hum-ma GGUFs are ComfyUI-only (city96 tensor naming, incompatible with sd.cpp loader).
// SDXL infrastructure (types, paths, arg builder, aux constants) remains in place.
// Re-enable by adding ...SDXL_CATALOGUE back to IMAGE_MODEL_CATALOGUE once a
// sd.cpp-compatible GGUF source is available.

export const SDXL_CATALOGUE: ImageModelSpec[] = [
  // ── Realistic ────────────────────────────────────────────────────────────
  {
    modelId:          'realvis-xl-v5-q4',
    label:            'RealVisXL V5.0 Q4',
    displayName:      'RealVisXL V5',
    runnerProfile:    'sdxl',
    category:         'realistic',
    variant:          'sdxl',
    quantization:     'Q4_0',
    hfRepo:           'hum-ma/SDXL-models-GGUF',
    hfFile:           'RealVisXL_V5.0-Q4_0.gguf',
    sizeBytes:        1_490_000_000,
    vramRequiredGb:   4,
    estSecondsCuda:   10,
    estSecondsVulkan: 35,
    estSecondsCpu:    360,
    license:          'creativeml-openrail-m',
    licenseUrl:       'https://huggingface.co/SG161222/RealVisXL_V5.0/blob/main/LICENSE.md',
  },
  // ── Anime ─────────────────────────────────────────────────────────────────
  // nsfw-anime slot covered by Chroma1-HD in CHROMA_CATALOGUE (FLUX runner, Apache 2.0).
  // ── NSFW Realistic ────────────────────────────────────────────────────────
  {
    modelId:          'cyberrealistic-pony-q4',
    label:            'CyberRealistic Pony V12 Q4',
    displayName:      'CyberRealistic Pony',
    runnerProfile:    'sdxl',
    category:         'nsfw-realistic',
    variant:          'pony',
    quantization:     'Q4_0',
    hfRepo:           'Green-Sky/CyberRealisticPony-GGUF',
    hfFile:           'CyberRealisticPony_V12.7-vae_f16-q4_0.gguf',
    sizeBytes:        2_600_000_000,
    vramRequiredGb:   6,
    estSecondsCuda:   10,
    estSecondsVulkan: 35,
    estSecondsCpu:    360,
    license:          'creativeml-openrail-m',
    licenseUrl:       'https://huggingface.co/cyberdelia/CyberRealisticPony/blob/main/LICENSE.md',
  },
  // ── NSFW Anime ────────────────────────────────────────────────────────────
  // WAI-NSFW-Illustrious removed: requires custom Illustrious CLIP encoders
  // incompatible with standard SDXL aux files. nsfw-anime covered by Chroma.
];

// ── FLUX Kontext catalogue ────────────────────────────────────────────────────
// Prompt-based image editing — same FLUX.1 aux pool (VAE + CLIP-L + T5).
// Requires --vae-decode-only false and -r <input> at generation time.

export const KONTEXT_CATALOGUE: ImageModelSpec[] = [
  {
    modelId:          'kontext-dev-q5',
    label:            'FLUX Kontext Dev Q5',
    displayName:      'FLUX Kontext Dev',
    runnerProfile:    'flux1-kontext',
    category:         'realistic',
    variant:          'kontext',
    quantization:     'Q5_K_S',
    hfRepo:           'QuantStack/FLUX.1-Kontext-dev-GGUF',
    hfFile:           'flux1-kontext-dev-Q5_K_S.gguf',
    sizeBytes:        8_280_000_000,
    vramRequiredGb:   12,
    estSecondsCuda:   60,
    estSecondsVulkan: 240,
    estSecondsCpu:    2400,
    license:          'FLUX-1-dev-Non-Commercial',
    licenseUrl:       'https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev/blob/main/LICENSE.md',
  },
];

// ── FLUX.2 catalogue ──────────────────────────────────────────────────────────
// LLM-based text encoder (Qwen3). New VAE (flux2-vae.safetensors from Comfy-Org).
// 4B: Apache 2.0 (commercial). 9B: non-commercial.
// Text encoder: Qwen3-4B for 4B variant, Qwen3-8B for 9B variant.

export const FLUX2_CATALOGUE: ImageModelSpec[] = [
  {
    modelId:          'flux2-klein-4b-q4',
    label:            'FLUX.2-klein-4B Q4',
    displayName:      'FLUX.2-klein-4B',
    runnerProfile:    'flux2',
    category:         'realistic',
    variant:          'flux2',
    quantization:     'Q4_K_M',
    hfRepo:           'unsloth/FLUX.2-klein-4B-GGUF',
    hfFile:           'flux-2-klein-4b-Q4_K_M.gguf',
    sizeBytes:        2_280_000_000,
    vramRequiredGb:   12,
    estSecondsCuda:   12,
    estSecondsVulkan: 50,
    estSecondsCpu:    480,
    license:          'Apache-2.0',
    licenseUrl:       'https://huggingface.co/unsloth/FLUX.2-klein-4B-GGUF',
  },
  {
    modelId:          'flux2-klein-9b-q4',
    label:            'FLUX.2-klein-9B Q4',
    displayName:      'FLUX.2-klein-9B',
    runnerProfile:    'flux2',
    category:         'realistic',
    variant:          'flux2',
    quantization:     'Q4_K_M',
    hfRepo:           'unsloth/FLUX.2-klein-9B-GGUF',
    hfFile:           'flux-2-klein-9b-Q4_K_M.gguf',
    sizeBytes:        5_400_000_000,
    vramRequiredGb:   16,
    estSecondsCuda:   18,
    estSecondsVulkan: 70,
    estSecondsCpu:    660,
    license:          'FLUX-Non-Commercial',
    licenseUrl:       'https://huggingface.co/unsloth/FLUX.2-klein-9B-GGUF',
  },
];

// ── Z-Image catalogue ─────────────────────────────────────────────────────────
// Apache 2.0. Shares FLUX.1 VAE (ae.safetensors). Uses Qwen3-4B as --llm.
// Z-Image Turbo = 4-step. Z-Image base = 20-step, higher quality.

export const ZIMAGE_CATALOGUE: ImageModelSpec[] = [
  {
    modelId:          'z-image-turbo-q4',
    label:            'Z-Image Turbo Q4',
    displayName:      'Z-Image Turbo',
    runnerProfile:    'z-image',
    category:         'realistic',
    variant:          'z-image',
    quantization:     'Q4_K_M',
    hfRepo:           'leejet/Z-Image-Turbo-GGUF',
    hfFile:           'z_image_turbo-Q4_K.gguf',
    sizeBytes:        3_860_000_000,
    vramRequiredGb:   8,
    estSecondsCuda:   8,
    estSecondsVulkan: 35,
    estSecondsCpu:    320,
    license:          'Apache-2.0',
    licenseUrl:       'https://huggingface.co/leejet/Z-Image-Turbo-GGUF',
  },
  {
    modelId:          'z-image-base-q6',
    label:            'Z-Image Base Q6',
    displayName:      'Z-Image Base',
    runnerProfile:    'z-image',
    category:         'realistic',
    variant:          'z-image',
    quantization:     'Q4_K_M',   // Q6_K on disk — Q4_K_M produces black images (sd.cpp quantization bug)
    hfRepo:           'unsloth/Z-Image-GGUF',
    hfFile:           'z-image-Q6_K.gguf',
    sizeBytes:        6_100_000_000,
    vramRequiredGb:   12,
    estSecondsCuda:   35,
    estSecondsVulkan: 140,
    estSecondsCpu:    1400,
    license:          'Apache-2.0',
    licenseUrl:       'https://huggingface.co/unsloth/Z-Image-GGUF',
  },
];

// ── Qwen-Image catalogue ──────────────────────────────────────────────────────
// Apache 2.0. Unique VAE + Qwen2.5-VL-7B as --llm. Excellent text rendering.
// Qwen-Image-Edit variant uses --ref-images for editing (future: QwenEdit node).

export const QWEN_IMAGE_CATALOGUE: ImageModelSpec[] = [
  {
    modelId:          'qwen-image-q4',
    label:            'Qwen-Image Q4',
    displayName:      'Qwen-Image',
    runnerProfile:    'qwen-image',
    category:         'realistic',
    variant:          'qwen-image',
    quantization:     'Q4_K_M',
    hfRepo:           'unsloth/Qwen-Image-2512-GGUF',
    hfFile:           'qwen-image-2512-Q4_K_M.gguf',
    sizeBytes:        13_200_000_000,
    vramRequiredGb:   12,
    estSecondsCuda:   70,
    estSecondsVulkan: 280,
    estSecondsCpu:    2800,
    license:          'Apache-2.0',
    licenseUrl:       'https://huggingface.co/unsloth/Qwen-Image-2512-GGUF',
  },
];

// ── Wan video catalogue ───────────────────────────────────────────────────────
// All Apache 2.0. Shared aux: WAN_VAE + WAN_T5_Q5 (UMT5-XXL, not FLUX T5).
// I2V models require an init image (--init-img) passed at generation time.
// Note: 1.3B GGUF only exists as T2V (samuelchristlie repo). I2V 1.3B
// is available via VACE architecture — deferred. I2V uses 14B 480P GGUF.

export const WAN_CATALOGUE: ImageModelSpec[] = [
  {
    modelId:          'wan21-t2v-1.3b-q4',
    label:            'Wan 2.1 T2V 1.3B Q4',
    displayName:      'Wan 2.1 T2V 1.3B',
    runnerProfile:    'wan',
    category:         'video',
    variant:          'wan',
    quantization:     'Q4_K_M',
    hfRepo:           'samuelchristlie/Wan2.1-T2V-1.3B-GGUF',
    hfFile:           'Wan2.1-T2V-1.3B-Q4_K_M.gguf',
    sizeBytes:        983_000_000,
    vramRequiredGb:   8,
    estSecondsCuda:   30,
    estSecondsVulkan: 120,
    estSecondsCpu:    600,
    license:          'Apache-2.0',
    licenseUrl:       'https://huggingface.co/samuelchristlie/Wan2.1-T2V-1.3B-GGUF',
  },
  {
    modelId:          'wan21-t2v-14b-q4',
    label:            'Wan 2.1 T2V 14B Q4',
    displayName:      'Wan 2.1 T2V 14B',
    runnerProfile:    'wan',
    category:         'video',
    variant:          'wan',
    quantization:     'Q4_K_M',
    hfRepo:           'city96/Wan2.1-T2V-14B-gguf',
    hfFile:           'wan2.1-t2v-14b-Q4_K_M.gguf',
    sizeBytes:        10_100_000_000,
    vramRequiredGb:   16,
    estSecondsCuda:   180,
    estSecondsVulkan: 720,
    estSecondsCpu:    3600,
    license:          'Apache-2.0',
    licenseUrl:       'https://huggingface.co/city96/Wan2.1-T2V-14B-gguf',
  },
  {
    modelId:          'wan21-i2v-14b-480p-q4',
    label:            'Wan 2.1 I2V 14B 480P Q4',
    displayName:      'Wan 2.1 I2V 14B',
    runnerProfile:    'wan',
    category:         'video',
    variant:          'wan',
    quantization:     'Q4_K_M',
    hfRepo:           'city96/Wan2.1-I2V-14B-480P-gguf',
    hfFile:           'wan2.1-i2v-14b-480p-Q4_K_M.gguf',
    sizeBytes:        10_100_000_000,
    vramRequiredGb:   16,
    estSecondsCuda:   180,
    estSecondsVulkan: 720,
    estSecondsCpu:    3600,
    license:          'Apache-2.0',
    licenseUrl:       'https://huggingface.co/city96/Wan2.1-I2V-14B-480P-gguf',
  },
];

/** Combined catalogue — all image and video models across all runner profiles */
export const IMAGE_MODEL_CATALOGUE: ImageModelSpec[] = [
  ...CHROMA_CATALOGUE,
  ...ZIMAGE_CATALOGUE,
  ...FLUX2_CATALOGUE,
  ...KONTEXT_CATALOGUE,
  ...QWEN_IMAGE_CATALOGUE,
  ...WAN_CATALOGUE,
  ...FLUX_CATALOGUE,           // schnell entries are now category:'legacy'
  // SDXL_CATALOGUE omitted — hum-ma GGUFs incompatible with sd.cpp loader (city96 tensor naming)
];

export function getImageModelSpec(modelId: string): ImageModelSpec | undefined {
  return IMAGE_MODEL_CATALOGUE.find(s => s.modelId === modelId);
}

export function isImageModelDownloaded(spec: ImageModelSpec): boolean {
  const p = fluxModelPath(spec);
  if (!fs.existsSync(p)) return false;
  return fs.statSync(p).size >= spec.sizeBytes * 0.9;
}

export function getAuxFilesForModel(spec: ImageModelSpec): FluxAuxFile[] {
  switch (spec.runnerProfile) {
    case 'sdxl':          return SDXL_AUX_REQUIRED;
    case 'flux1-kontext': return KONTEXT_AUX_REQUIRED;
    case 'flux2':
      // 4B vs 9B distinguished by modelId
      return spec.modelId.includes('9b') ? FLUX2_9B_AUX_REQUIRED : FLUX2_4B_AUX_REQUIRED;
    case 'z-image':       return ZIMAGE_AUX_REQUIRED;
    case 'qwen-image':    return QWEN_IMAGE_AUX_REQUIRED;
    case 'wan':
      // I2V models need an extra CLIP Vision encoder; T2V models don't
      return spec.modelId.includes('i2v') ? WAN_I2V_AUX_REQUIRED : WAN_AUX_REQUIRED;
    default:
      // flux profile: VAE + CLIP-L always, T5 selected lazily at download time
      return FLUX_AUX_REQUIRED;
  }
}


// ── FLUX helper functions ─────────────────────────────────────────────────────

export function getFluxSpec(modelId: string): FluxSpec | undefined {
  return FLUX_CATALOGUE.find(s => s.modelId === modelId);
}

// ── Image model path resolution ───────────────────────────────────────────────
// Models:  flux/chroma/kontext/flux2/z-image/qwen-image GGUFs → IMAGE_FLUX_DIR
//          sdxl GGUFs        → IMAGE_SDXL_DIR
// Aux:     safetensors (VAE, CLIP-L, T5, CLIP-G) → IMAGE_SHARED_DIR
//          LLM GGUF encoders (--llm flag)         → IMAGE_LLM_DIR

export function fluxModelPath(spec: FluxSpec): string {
  if (spec.runnerProfile === 'sdxl') return path.join(IMAGE_SDXL_DIR, spec.hfFile);
  if (spec.runnerProfile === 'wan')  return path.join(IMAGE_WAN_DIR,  spec.hfFile);
  return path.join(IMAGE_FLUX_DIR, spec.hfFile);
}

export function fluxAuxPath(aux: FluxAuxFile): string {
  // LLM text encoders go in their own dir.
  // Wan T5 (umt5-xxl) and CLIP Vision go in IMAGE_WAN_DIR — same filename as FLUX T5
  // (umt5-xxl-encoder-Q5_K_M.gguf vs t5-v1_1-xxl-encoder-Q5_K_M.gguf actually differ,
  // but keeping them separate avoids any future collision risk).
  const dir =
    aux.cliFlag === '--llm'          ? IMAGE_LLM_DIR  :
    aux.id.startsWith('wan-')        ? IMAGE_WAN_DIR  :
    IMAGE_SHARED_DIR;
  const filename = aux.localFile ?? path.basename(aux.hfFile);
  return path.join(dir, filename);
}

export function isFluxDownloaded(spec: FluxSpec): boolean {
  const p = fluxModelPath(spec);
  if (!fs.existsSync(p)) return false;
  return fs.statSync(p).size >= spec.sizeBytes * 0.9;
}

export function isFluxAuxDownloaded(aux: FluxAuxFile): boolean {
  const p = fluxAuxPath(aux);
  if (!fs.existsSync(p)) return false;
  return fs.statSync(p).size >= aux.sizeBytes * 0.9;
}

export function listDownloadedFlux(): FluxSpec[] {
  return FLUX_CATALOGUE.filter(isFluxDownloaded);
}

/**
 * Returns the best downloaded FLUX model for the given VRAM budget.
 * Preference order: schnell Q8 → schnell Q4 → dev Q8 → dev Q4.
 * Returns null if nothing downloaded fits or VRAM < 8 GB.
 */
export function recommendFluxModel(vramGb: number): FluxSpec | null {
  const preference = ['flux-schnell-q8', 'flux-schnell-q4', 'flux-dev-q8', 'flux-dev-q4'];
  for (const id of preference) {
    const spec = getFluxSpec(id);
    if (spec && isFluxDownloaded(spec) && spec.vramRequiredGb <= vramGb) return spec;
  }
  return null;
}

/**
 * Returns the best downloaded image model across all catalogues.
 * Chroma is checked first (it is now the default); FLUX is the fallback.
 * SDXL is excluded — it requires convert.py-produced GGUFs not currently in catalogue.
 */
/**
 * Recommends the best downloaded image model for the given hardware.
 *
 * @param vramGb         Available VRAM (or total system RAM for unified memory)
 * @param isUnifiedMemory  True for AMD iGPU, Apple Silicon — RAM = VRAM (same pool).
 *                         With --offload-to-cpu, the full RAM pool is usable.
 */
export function recommendImageModel(vramGb: number, isUnifiedMemory = false): ImageModelSpec | null {
  // Preference order: Chroma (best quality/compat) → Z-Image (fast, Apache 2.0) →
  // FLUX.2 → Kontext → Qwen-Image → FLUX dev. FLUX schnell excluded (legacy category).
  const ordered = [
    ...CHROMA_CATALOGUE,
    ...ZIMAGE_CATALOGUE,
    ...FLUX2_CATALOGUE,
    ...KONTEXT_CATALOGUE,
    ...QWEN_IMAGE_CATALOGUE,
    ...FLUX_CATALOGUE.filter(m => m.variant !== 'schnell'),
  ];
  if (isUnifiedMemory) {
    // Unified memory: --offload-to-cpu uses full RAM pool. No discrete VRAM gate.
    return ordered.find(m => isImageModelDownloaded(m)) ?? null;
  }
  // Discrete GPU: only GPU VRAM available. Flux/Chroma need ≥8 GB.
  return ordered.find(m => m.vramRequiredGb <= vramGb && isImageModelDownloaded(m)) ?? null;
}


/**
 * Returns the best T5 encoder that fits with comfortable headroom.
 *
 * VRAM budget math (from sd-cli logs):
 *   Chroma Q4 diffusion: 5180 MB, VAE: 95 MB, no CLIP-L
 *   FLUX schnell Q4 diffusion: 6694 MB, VAE: 95 MB, CLIP-L: 230 MB
 *   T5 Q3: ~2300 MB, T5 Q4: ~2900 MB, T5 Q8: ~5060 MB
 *
 * We require ≥2 GB headroom for CUDA working memory (attention caches,
 * temporary allocations during T5 forward pass). Without this, the GPU
 * swaps tensors to system RAM via VMM, causing 10-100x slowdowns.
 */
export function recommendT5Encoder(fluxSpec: FluxSpec, totalVramGb: number, isUnifiedMemory = false): FluxAuxFile {
  if (isUnifiedMemory) return FLUX_T5_Q3;

  const totalVramMb = totalVramGb * 1024;
  // 1.5 GB headroom for CUDA working memory, attention caches, and OS.
  // Do NOT inflate this — Q4_0/Q4_K_M map directly to CUDA tensor core wmma
  // operations and are FASTER than Q3_K_M on CUDA despite being larger.
  // Q3_K_M requires software dequantization on the GPU (80x slower conditioning
  // on RTX 3080). Use the smallest headroom that avoids VMM paging.
  const HEADROOM_MB = 2200; // enough to exclude cuBLASLt workspace (~630MB) + T5 attention buffers

  // Use actual measured diffusion model sizes from sd-cli logs, not vramRequiredGb.
  // vramRequiredGb is the total system requirement (diffusion + all aux + headroom),
  // using it as a diffusion proxy inflates the estimate by ~3 GB and always forces Q3.
  const isChroma = fluxSpec.variant === 'chroma';
  // Chroma Q4: 5180 MB, FLUX schnell/dev Q4: ~6700 MB (approximate for other variants)
  const diffusionMb = isChroma ? 5180 : Math.round(fluxSpec.vramRequiredGb * 1024 * 0.72);
  const vaeMb = 95;
  const clipMb = isChroma ? 0 : 230; // Chroma doesn't use CLIP-L
  const baseMb = diffusionMb + vaeMb + clipMb;

  const availableForT5 = totalVramMb - baseMb - HEADROOM_MB;

  // T5 sizes: Q3 ~2300 MB, Q4 ~2900 MB, Q8 ~5060 MB
  // Prefer Q4 over Q3 on CUDA — Q4_K_M uses tensor core ops directly.
  if (availableForT5 >= 5060) return FLUX_T5_Q8;
  if (availableForT5 >= 2900) return FLUX_T5_Q4;
  return FLUX_T5_Q3;
}

export function deleteFluxModel(modelId: string): boolean {
  const spec = getFluxSpec(modelId);
  if (!spec) return false;
  const p = fluxModelPath(spec);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

/**
 * Deletes in-progress .download temp files for an image model and its aux files.
 * Called on cancel so partial downloads don't occupy disk space.
 * Silently skips files that don't exist — safe to call at any point.
 */
export function cancelImageDownload(spec: ImageModelSpec, auxFiles: FluxAuxFile[]): void {
  const mainTmp = fluxModelPath(spec) + '.download';
  try { if (fs.existsSync(mainTmp)) fs.unlinkSync(mainTmp); } catch { /* ignore */ }
  for (const aux of auxFiles) {
    const auxTmp = fluxAuxPath(aux) + '.download';
    try { if (fs.existsSync(auxTmp)) fs.unlinkSync(auxTmp); } catch { /* ignore */ }
  }
}

/**
 * Deletes in-progress .download temp files for LLM model(s).
 * modelIds may be one or both of sayon/seren.
 */
export function cancelLlmDownload(...modelIds: string[]): void {
  for (const modelId of modelIds) {
    const spec = getSpec(modelId);
    if (!spec) continue;
    const tmp = modelPath(spec) + '.download';
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ── Model recommendation ──────────────────────────────────────────────────────

export interface ModelRecommendation {
  sayon: GGUFSpec;
  seren: GGUFSpec;
  sayonDevice: 'cpu' | number;
  serenDevice: 'cpu' | number;
  sayonGpuLayers: number;
  serenGpuLayers: number;
  reasoning: string;
}

const SAYON_CANDIDATES = [
  // Nemotron 3 preferred — best reasoning quality for coordinator role
  'nemotron3-4b-q4',
  // Llama fallbacks
  'llama3.1-8b-q4', 'gemma3-12b-q4', 'gemma3-4b-q4',
  'llama3.2-3b-q4', 'gemma3-1b-q4',
];

const SEREN_CANDIDATES = [
  // Nemotron 3 preferred — strong reasoning at all sizes
  'nemotron3-30b-a3b-q4',
  'nemotron3-9b-q4',
  // Qwen3.5 — excellent reasoning, wide size range
  'qwen3.5-35b-a3b-q4',
  'qwen3.5-27b-q4',
  'qwen3.5-9b-q4',
  'qwen3.5-4b-q4',
  // DeepSeek-R1 — strong on reasoning tasks
  'deepseek-r1-70b-q4',
  'deepseek-r1-14b-q4',
  'deepseek-r1-8b-q4',
  // Mistral
  'magistral-8b-q4',
  // Legacy fallbacks
  'qwen3-30b-a3b-q4',
  'qwen3-14b-q4',
  'qwen3-8b-q4',
  'qwen3-4b-q4',
];

function pickBestFit(candidates: string[], budgetGb: number): GGUFSpec {
  for (const id of candidates) {
    const spec = GGUF_CATALOGUE.find(s => s.modelId === id);
    if (spec && spec.ramRequiredGb <= budgetGb) return spec;
  }
  return GGUF_CATALOGUE.find(s => s.modelId === candidates[candidates.length - 1])!;
}

export function buildRecommendation(hw: HardwareProfile): ModelRecommendation {
  const gpusByVram = [...hw.gpus].sort((a, b) => b.vramGb - a.vramGb);
  const bestGpu    = gpusByVram[0] ?? null;
  const secondGpu  = gpusByVram[1] ?? null;

  const hasUnifiedMemory = bestGpu?.unifiedMemory === true;
  const HEADROOM = 0.80;

  let sayon: GGUFSpec;
  let seren: GGUFSpec;
  let sayonDevice: 'cpu' | number;
  let serenDevice: 'cpu' | number;
  let sayonGpuLayers: number;
  let serenGpuLayers: number;

  if (hasUnifiedMemory && bestGpu) {
    const pool          = Math.floor(hw.ramGb * HEADROOM);
    const serenBudget = Math.floor(pool * 0.75);
    const sayonBudget   = Math.floor(pool * 0.35);
    seren          = pickBestFit(SEREN_CANDIDATES, serenBudget);
    sayon            = pickBestFit(SAYON_CANDIDATES,   sayonBudget);
    serenDevice    = bestGpu.index;
    sayonDevice      = bestGpu.index;
    serenGpuLayers = 99;
    sayonGpuLayers   = 99;

  } else if (bestGpu && bestGpu.vramGb >= 3) {
    const serenBudget = Math.floor(bestGpu.vramGb * HEADROOM);
    seren          = pickBestFit(SEREN_CANDIDATES, serenBudget);
    serenDevice    = bestGpu.index;
    serenGpuLayers = 99;

    if (secondGpu && secondGpu.vramGb >= 2 && !secondGpu.unifiedMemory) {
      sayon          = pickBestFit(SAYON_CANDIDATES, Math.floor(secondGpu.vramGb * HEADROOM));
      sayonDevice    = secondGpu.index;
      sayonGpuLayers = 99;
    } else {
      sayon          = pickBestFit(SAYON_CANDIDATES, Math.floor(hw.ramGb * HEADROOM));
      sayonDevice    = 'cpu';
      sayonGpuLayers = 0;
    }

  } else if (bestGpu && bestGpu.vramGb === 2) {
    // 2 GB GPU edge case: too small for any SEREN model (smallest needs 3 GB).
    // But gemma3-1b-q4 (1 GB) runs well on 2 GB. Put SAYON on GPU, SEREN on CPU.
    sayon          = pickBestFit(SAYON_CANDIDATES, Math.floor(bestGpu.vramGb * HEADROOM));
    sayonDevice    = bestGpu.index;
    sayonGpuLayers = 99;
    seren          = pickBestFit(SEREN_CANDIDATES, Math.floor(hw.ramGb * HEADROOM));
    serenDevice    = 'cpu';
    serenGpuLayers = 0;

  } else {
    const pool       = Math.floor(hw.ramGb * HEADROOM);
    seren          = pickBestFit(SEREN_CANDIDATES, Math.floor(pool * 0.60));
    sayon            = pickBestFit(SAYON_CANDIDATES,   Math.floor(pool * 0.40));
    serenDevice    = 'cpu';
    sayonDevice      = 'cpu';
    serenGpuLayers = 0;
    sayonGpuLayers   = 0;
  }

  const gpuLines  = hw.gpus.map(g =>
    `${g.name} (${g.vramGb} GB${g.unifiedMemory ? ', unified' : ''}, ${g.backend})`
  ).join(' · ');
  const gpuStr    = gpuLines || 'No GPU — CPU fallback';
  const deviceName = (d: 'cpu' | number) =>
    d === 'cpu' ? 'CPU' : (hw.gpus.find(g => g.index === d)?.name ?? `GPU #${d}`);

  const reasoning =
    `System: ${hw.ramGb} GB RAM · ${hw.cpuCores} cores · ${hw.cpuName}. ` +
    `GPUs: ${gpuStr}.` +
    (hasUnifiedMemory ? ` Unified memory — both models share the same ${hw.ramGb} GB pool.` : '') +
    ` SAYON → ${sayon.label} on ${deviceName(sayonDevice)} (${sayonGpuLayers > 0 ? 'GPU' : 'CPU'}).` +
    ` SEREN → ${seren.label} on ${deviceName(serenDevice)} (${serenGpuLayers > 0 ? 'GPU' : 'CPU'}).`;

  return { sayon, seren, sayonDevice, serenDevice, sayonGpuLayers, serenGpuLayers, reasoning };
}

// ── Dynamic context size recommendation ──────────────────────────────────────

/**
 * Computes the largest safe context window for a model on the target device.
 *
 * For GPU mode: availableGb = free VRAM after model weights load.
 *   KV cache lives entirely in VRAM. Hard limit — exceeding it causes OOM.
 *   Safety reserve: 300 MB for driver overhead + CUDA workspace.
 *
 * For CPU mode: availableGb = (totalRamGb - modelWeightsGb - 2 GB OS) * 0.70.
 *   KV cache lives in system RAM. 30% headroom for OS + app memory.
 *
 * Context tiers (K tokens): 4, 8, 12, 16, 24, 32, 48, 64, 128.
 * Always clamped to model's contextWindow maximum.
 * Minimum is always 4K — enough for most single-turn conversations.
 */
export function recommendContextSize(
  spec:         GGUFSpec,
  availableGb:  number,   // free VRAM (GPU) or adjusted RAM (CPU)
  isGpu:        boolean,
): number {
  const SAFETY_MB   = isGpu ? 512 : 0;  // GPU: reserve for driver/CUDA context + cuBLAS workspace
  const availableMb = availableGb * 1024 - SAFETY_MB;
  if (availableMb <= 0) return 4096;

  const maxTokensK = availableMb / spec.kvCacheMbPer1kTokens;

  // Snap down to the nearest standard tier
  const TIERS = [128, 64, 48, 32, 24, 16, 12, 8, 4] as const;
  const tierK  = TIERS.find(t => maxTokensK >= t) ?? 4;

  // Clamp to model's declared max context
  const modelMaxK  = Math.floor(spec.contextWindow / 1024);
  const chosenK    = Math.min(tierK, modelMaxK);

  return chosenK * 1024;
}

// ── GGUF download ─────────────────────────────────────────────────────────────

export interface DownloadProgress {
  modelId: string;
  phase: 'sayon' | 'seren';
  bytesReceived: number;
  bytesTotal: number;
  done: boolean;
  installing?: boolean;
  error?: string;
}

function hfUrl(spec: GGUFSpec): string {
  return `https://huggingface.co/${spec.hfRepo}/resolve/main/${spec.hfFile}`;
}

export async function* downloadModel(
  spec: GGUFSpec,
  phase: 'sayon' | 'seren',
): AsyncGenerator<DownloadProgress> {
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  const dest = modelPath(spec);
  const tmp  = dest + '.download';

  const existingBytes = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
  const reqHeaders: Record<string, string> = {};
  if (existingBytes > 0) reqHeaders['Range'] = `bytes=${existingBytes}-`;

  const url = hfUrl(spec);
  let bytesReceived = existingBytes;
  let bytesTotal    = spec.sizeBytes;

  yield { modelId: spec.modelId, phase, bytesReceived, bytesTotal, done: false };

  type QueueItem =
    | { kind: 'progress'; bytesReceived: number; bytesTotal: number }
    | { kind: 'installing' }
    | { kind: 'done' }
    | { kind: 'error'; err: Error };

  const queue: QueueItem[] = [];
  let notify: (() => void) | null = null;
  const push = (item: QueueItem) => { queue.push(item); notify?.(); };

  const THROTTLE_MS    = 250;
  const THROTTLE_BYTES = 2 * 1024 * 1024;
  let lastEmitBytes = existingBytes;
  let lastEmitTime  = Date.now();

  const downloadPromise = new Promise<void>((resolve, reject) => {
    const follow = (targetUrl: string, redirectCount = 0) => {
      if (redirectCount > 5) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(targetUrl);
      const req = https.get(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: reqHeaders },
        (res) => {
          if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
            follow(res.headers.location!, redirectCount + 1);
            return;
          }
          if (res.statusCode !== 200 && res.statusCode !== 206) {
            const err = new Error(`HTTP ${res.statusCode} for ${targetUrl}`);
            push({ kind: 'error', err }); resolve(); return;
          }
          bytesTotal = res.statusCode === 206
            ? existingBytes + parseInt(res.headers['content-length'] ?? '0', 10)
            : parseInt(res.headers['content-length'] ?? String(spec.sizeBytes), 10);

          const fd = fs.createWriteStream(tmp, { flags: existingBytes > 0 ? 'a' : 'w' });
          res.on('data', (chunk: Buffer) => {
            bytesReceived += chunk.length;
            fd.write(chunk);
            const now = Date.now();
            if (now - lastEmitTime >= THROTTLE_MS || bytesReceived - lastEmitBytes >= THROTTLE_BYTES) {
              lastEmitTime = now; lastEmitBytes = bytesReceived;
              push({ kind: 'progress', bytesReceived, bytesTotal });
            }
          });
          res.on('end', () => {
            push({ kind: 'installing' });
            fd.end(() => {
              try {
                fs.renameSync(tmp, dest);
              } catch {
                try { fs.copyFileSync(tmp, dest); fs.unlinkSync(tmp); }
                catch (copyErr) {
                  const err = new Error(`Failed to finalize download: ${copyErr}`);
                  push({ kind: 'error', err }); resolve(); return;
                }
              }
              push({ kind: 'done' }); resolve();
            });
          });
          res.on('error', (err) => { fd.destroy(); push({ kind: 'error', err }); resolve(); });
        },
      );
      req.on('error', (err) => { push({ kind: 'error', err }); resolve(); });
    };
    follow(url);
  });

  let finished = false;
  while (!finished) {
    if (queue.length === 0) {
      await new Promise<void>((res) => { notify = res; });
      notify = null;
    }
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.kind === 'progress') {
        yield { modelId: spec.modelId, phase, bytesReceived: item.bytesReceived, bytesTotal: item.bytesTotal, done: false };
      } else if (item.kind === 'installing') {
        yield { modelId: spec.modelId, phase, bytesReceived, bytesTotal, done: false, installing: true };
      } else if (item.kind === 'done') {
        finished = true;
      } else {
        yield { modelId: spec.modelId, phase, bytesReceived: 0, bytesTotal, done: true,
                error: item.err.message };
        finished = true;
      }
    }
  }

  try { await downloadPromise; } catch { /* error already emitted via queue */ }
  yield { modelId: spec.modelId, phase, bytesReceived, bytesTotal, done: true };
}

// ── FLUX download ─────────────────────────────────────────────────────────────
// Same push-queue + async generator pattern as downloadModel().
// Downloads the main FLUX model then all required aux files sequentially.

export type FluxDownloadPhase = 'flux-main' | 'flux-aux';

export interface FluxDownloadProgress {
  fileId: string;
  phase: FluxDownloadPhase;
  label: string;
  bytesReceived: number;
  bytesTotal: number;
  done: boolean;
  installing?: boolean;
  error?: string;
}

function hfFluxUrl(hfRepo: string, hfFile: string): string {
  return `https://huggingface.co/${hfRepo}/resolve/main/${hfFile}`;
}

async function* downloadFluxFileGen(
  hfRepo: string,
  hfFile: string,
  destPath: string,
  sizeBytes: number,
  fileId: string,
  label: string,
  phase: FluxDownloadPhase,
): AsyncGenerator<FluxDownloadProgress> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const tmp           = destPath + '.download';
  const existingBytes = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
  const reqHeaders: Record<string, string> = {};
  if (existingBytes > 0) reqHeaders['Range'] = `bytes=${existingBytes}-`;

  const url           = hfFluxUrl(hfRepo, hfFile);
  let bytesReceived   = existingBytes;
  let bytesTotal      = sizeBytes;

  yield { fileId, phase, label, bytesReceived, bytesTotal, done: false };

  type QItem =
    | { kind: 'progress'; bytesReceived: number; bytesTotal: number }
    | { kind: 'installing' }
    | { kind: 'done' }
    | { kind: 'error'; err: Error };

  const queue: QItem[] = [];
  let notify: (() => void) | null = null;
  const push = (item: QItem) => { queue.push(item); notify?.(); };

  const THROTTLE_MS    = 250;
  const THROTTLE_BYTES = 2 * 1024 * 1024;
  let lastEmitBytes = existingBytes;
  let lastEmitTime  = Date.now();

  const downloadPromise = new Promise<void>((resolve, reject) => {
    const follow = (targetUrl: string, hops = 0) => {
      if (hops > 10) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(targetUrl);
      const req = https.get(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: reqHeaders },
        (res) => {
          if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
            follow(res.headers.location!, hops + 1); return;
          }
          if (res.statusCode !== 200 && res.statusCode !== 206) {
            const err = new Error(`HTTP ${res.statusCode} for ${targetUrl}`);
            // push error to queue then RESOLVE (not reject) — the error is already
            // communicated via the queue. Calling reject() here causes an unhandled
            // rejection race if the generator's await hasn't been reached yet.
            push({ kind: 'error', err }); resolve(); return;
          }
          bytesTotal = res.statusCode === 206
            ? existingBytes + parseInt(res.headers['content-length'] ?? '0', 10)
            : parseInt(res.headers['content-length'] ?? String(sizeBytes), 10);

          const fd = fs.createWriteStream(tmp, { flags: existingBytes > 0 ? 'a' : 'w' });
          res.on('data', (chunk: Buffer) => {
            bytesReceived += chunk.length;
            fd.write(chunk);
            const now = Date.now();
            if (now - lastEmitTime >= THROTTLE_MS || bytesReceived - lastEmitBytes >= THROTTLE_BYTES) {
              lastEmitTime = now; lastEmitBytes = bytesReceived;
              push({ kind: 'progress', bytesReceived, bytesTotal });
            }
          });
          res.on('end', () => {
            push({ kind: 'installing' });
            fd.end(() => {
              try {
                fs.renameSync(tmp, destPath);
              } catch {
                try { fs.copyFileSync(tmp, destPath); fs.unlinkSync(tmp); }
                catch (copyErr) {
                  const err = new Error(`Failed to finalize: ${copyErr}`);
                  push({ kind: 'error', err }); resolve(); return;
                }
              }
              push({ kind: 'done' }); resolve();
            });
          });
          res.on('error', (err) => { fd.destroy(); push({ kind: 'error', err }); resolve(); });
        },
      );
      req.on('error', (err) => { push({ kind: 'error', err }); resolve(); });
    };
    follow(url);
  });

  let finished = false;
  while (!finished) {
    if (queue.length === 0) {
      await new Promise<void>((res) => { notify = res; });
      notify = null;
    }
    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.kind === 'progress') {
        yield { fileId, phase, label, bytesReceived: item.bytesReceived, bytesTotal: item.bytesTotal, done: false };
      } else if (item.kind === 'installing') {
        yield { fileId, phase, label, bytesReceived, bytesTotal, done: false, installing: true };
      } else if (item.kind === 'done') {
        finished = true;
      } else {
        // Yield the error as a stream event rather than throwing. A throw from
        // an async generator propagates to the caller's for-await and becomes
        // an unhandled promise rejection if not caught — crashing the process.
        // The route handler's safeDownloadFile wrapper also catches throws, but
        // the await downloadPromise below fires after the loop and its rejection
        // can still escape on some Node.js versions. Belt-and-suspenders: never throw.
        yield { fileId, phase, label, bytesReceived: 0, bytesTotal, done: true,
                error: item.err.message };
        finished = true;
      }
    }
  }

  try { await downloadPromise; } catch { /* rejection already surfaced via queue */ }
  yield { fileId, phase, label, bytesReceived, bytesTotal, done: true };
}

/**
 * Downloads a FLUX model + all required aux files sequentially.
 * auxFiles should be [FLUX_VAE, FLUX_CLIP_L, FLUX_T5_Q4 | FLUX_T5_Q8].
 * Already-downloaded files emit a single done:true event immediately.
 * Each file is individually guarded — a 404 on one file emits an error
 * event for that file and continues to the next rather than crashing the stream.
 */
export async function* downloadFluxModel(
  spec: FluxSpec,
  auxFiles: FluxAuxFile[],
): AsyncGenerator<FluxDownloadProgress> {
  // ── Helper: wrap a single file generator with per-file error handling ───────
  async function* safeDownloadFile(
    gen: AsyncGenerator<FluxDownloadProgress>,
    fileId: string,
    label: string,
    phase: FluxDownloadPhase,
    sizeBytes: number,
  ): AsyncGenerator<FluxDownloadProgress> {
    try {
      yield* gen;
    } catch (err) {
      yield {
        fileId,
        phase,
        label,
        bytesReceived: 0,
        bytesTotal:    sizeBytes,
        done:          true,
        error:         err instanceof Error ? err.message : String(err),
      };
    }
  }

  // 1. Main model
  if (!isFluxDownloaded(spec)) {
    yield* safeDownloadFile(
      downloadFluxFileGen(spec.hfRepo, spec.hfFile, fluxModelPath(spec), spec.sizeBytes, spec.modelId, spec.label, 'flux-main'),
      spec.modelId, spec.label, 'flux-main', spec.sizeBytes,
    );
  } else {
    yield { fileId: spec.modelId, phase: 'flux-main', label: spec.label,
            bytesReceived: spec.sizeBytes, bytesTotal: spec.sizeBytes, done: true };
  }

  // 2. Aux files
  for (const aux of auxFiles) {
    if (!isFluxAuxDownloaded(aux)) {
      yield* safeDownloadFile(
        downloadFluxFileGen(aux.hfRepo, aux.hfFile, fluxAuxPath(aux), aux.sizeBytes, aux.id, aux.label, 'flux-aux'),
        aux.id, aux.label, 'flux-aux', aux.sizeBytes,
      );
    } else {
      yield { fileId: aux.id, phase: 'flux-aux', label: aux.label,
              bytesReceived: aux.sizeBytes, bytesTotal: aux.sizeBytes, done: true };
    }
  }
}

// ── Binary resolution ─────────────────────────────────────────────────────────

export function resolveLlamaServerBin(): string {
  const platform = process.platform;
  const arch     = process.arch;
  const ext      = platform === 'win32' ? '.exe' : '';
  const name     = `llama-server-${platform}-${arch}${ext}`;

  const seaDir   = path.dirname(process.execPath);
  const repoRoot = path.resolve(_dirname, '..');

  const seaPath = path.join(seaDir, name);
  if (fs.existsSync(seaPath)) return seaPath;
  const devPath = path.join(repoRoot, 'bin', name);
  if (fs.existsSync(devPath)) return devPath;

  throw new Error(
    `llama-server binary not found.\nExpected at:\n  ${seaPath}\n  ${devPath}\n` +
    `Run scripts/fetch-llamacpp.js to download binaries.`
  );
}

/**
 * Resolves the sd-server binary for the current platform.
 * Windows preference: CUDA (best) -> Vulkan (primary GPU) -> CPU AVX2 (last resort)
 * Linux/macOS: single binary, fetched as Vulkan/Metal build by fetch-sd-cpp.js
 */
/**
 * Resolves the sd-cli binary path based on the runner profile's sdBinary field.
 *
 * sdBinary routing (Windows):
 *   'cuda'   → sd-cuda/   binary — NVIDIA CUDA compute. NEVER use on non-NVIDIA.
 *   'vulkan' → sd-vulkan/ binary — Vulkan compute (AMD/Intel). No CUDA DLLs.
 *   'cpu'    → sd-cpu/    binary — CPU-only fallback.
 *
 * This prevents the critical failure mode where sd-cuda is selected on a
 * non-NVIDIA system and hangs indefinitely trying to init a CUDA runtime.
 *
 * Linux/macOS: single binary handles all backends via env vars.
 */
export function resolveSdServerBin(sdBinary: 'cuda' | 'vulkan' | 'rocm' | 'cpu' = 'cuda'): string {
  const platform = process.platform;
  const arch     = process.arch;
  const seaDir   = path.dirname(process.execPath);
  const binDir   = path.join(path.resolve(_dirname, '..'), 'bin');

  // Linux/macOS: single binary, flat layout (Vulkan/Metal)
  // ROCm on Linux uses an isolated subdirectory (sd-rocm/) to avoid .so conflicts.
  if (platform !== 'win32') {
    if (sdBinary === 'rocm') {
      for (const dir of [seaDir, binDir]) {
        const p = path.join(dir, 'sd-rocm', `sd-server-${platform}-${arch}-rocm`);
        if (fs.existsSync(p)) return p;
      }
      // Also check flat layout (dev builds)
      for (const dir of [seaDir, binDir]) {
        const p = path.join(dir, `sd-server-${platform}-${arch}-rocm`);
        if (fs.existsSync(p)) return p;
      }
      // ROCm binary not present — fall through to Vulkan
      console.warn('[resolveSdServerBin] ROCm binary not found, falling back to Vulkan');
    }
    for (const dir of [seaDir, binDir]) {
      const p = path.join(dir, `sd-server-${platform}-${arch}`);
      if (fs.existsSync(p)) return p;
    }
    throw new Error(`sd-server binary not found for ${platform}-${arch}. Run scripts/fetch-sd-cpp.js.`);
  }

  // Windows: strict binary routing — no cross-backend fallback
  type Candidate = { file: string; dir: string };
  const byCandidates = (dirs: string[], file: string): Candidate[] =>
    dirs.map(dir => ({ file, dir }));

  const searchDirs = [seaDir, binDir];
  const cudaCandidates: Candidate[] = [
    ...byCandidates(searchDirs.map(d => path.join(d, 'sd-cuda')), `sd-server-${platform}-${arch}-cuda.exe`),
    ...byCandidates(searchDirs, `sd-server-${platform}-${arch}-cuda.exe`), // flat fallback
  ];
  const rocmCandidates: Candidate[] = [
    ...byCandidates(searchDirs.map(d => path.join(d, 'sd-rocm')), `sd-server-${platform}-${arch}-rocm.exe`),
    ...byCandidates(searchDirs, `sd-server-${platform}-${arch}-rocm.exe`),
  ];
  const vulkanCandidates: Candidate[] = [
    ...byCandidates(searchDirs.map(d => path.join(d, 'sd-vulkan')), `sd-server-${platform}-${arch}.exe`),
    ...byCandidates(searchDirs, `sd-server-${platform}-${arch}.exe`),
  ];
  const cpuCandidates: Candidate[] = [
    ...byCandidates(searchDirs.map(d => path.join(d, 'sd-cpu')), `sd-server-${platform}-${arch}-cpu.exe`),
    ...byCandidates(searchDirs, `sd-server-${platform}-${arch}-cpu.exe`),
  ];

  // Try the requested binary type first, then fallback chain
  const preferred = sdBinary === 'cuda'   ? cudaCandidates
    : sdBinary === 'rocm'                 ? rocmCandidates
    : sdBinary === 'vulkan'               ? vulkanCandidates
    : cpuCandidates;

  for (const { file, dir } of preferred) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) return p;
  }
  // ROCm falls back to Vulkan (same GPU, different backend)
  if (sdBinary === 'rocm') {
    for (const { file, dir } of vulkanCandidates) {
      const p = path.join(dir, file);
      if (fs.existsSync(p)) return p;
    }
  }
  // CPU is always the safe fallback if preferred binary not installed
  if (sdBinary !== 'cpu') {
    for (const { file, dir } of cpuCandidates) {
      const p = path.join(dir, file);
      if (fs.existsSync(p)) return p;
    }
  }

  throw new Error(
    `sd-server binary not found for ${platform}-${arch} (sdBinary: ${sdBinary}).\n` +
    `Expected in sd-cuda/, sd-vulkan/, sd-rocm/, or sd-cpu/ (alongside executable or in bin/)\n` +
    `Run scripts/fetch-sd-cpp.js to download binaries.`
  );
}


// ── ESRGAN upscale model catalogue ───────────────────────────────────────────

export interface EsrganSpec {
  id:        string;
  label:     string;
  filename:  string;   // .pth filename placed in UPSCALE_MODELS_DIR
  url:       string;   // direct download URL (GitHub releases)
  sizeBytes: number;
}

export const ESRGAN_MODELS: EsrganSpec[] = [
  {
    id:        'realesrgan-x4plus',
    label:     'RealESRGAN x4+ (general, ~67 MB)',
    filename:  'RealESRGAN_x4plus.pth',
    url:       'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth',
    sizeBytes: 67_040_989,
  },
  {
    id:        'realesrgan-x4plus-anime',
    label:     'RealESRGAN x4+ Anime (~17 MB)',
    filename:  'RealESRGAN_x4plus_anime_6B.pth',
    url:       'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth',
    sizeBytes: 17_938_799,
  },
  {
    id:        'realesrgan-x2plus',
    label:     'RealESRGAN x2+ (general, ~67 MB)',
    filename:  'RealESRGAN_x2plus.pth',
    url:       'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth',
    sizeBytes: 67_040_989,
  },
];

export function esrganModelPath(spec: EsrganSpec): string {
  return path.join(UPSCALE_MODELS_DIR, spec.filename);
}

export function isEsrganDownloaded(spec: EsrganSpec): boolean {
  return fs.existsSync(esrganModelPath(spec));
}

export function listDownloadedEsrgan(): EsrganSpec[] {
  return ESRGAN_MODELS.filter(isEsrganDownloaded);
}

export interface EsrganDownloadProgress {
  id:            string;
  bytesReceived: number;
  bytesTotal:    number;
  done:          boolean;
  error?:        string;
}

export async function* downloadEsrgan(
  spec: EsrganSpec,
): AsyncGenerator<EsrganDownloadProgress> {
  fs.mkdirSync(UPSCALE_MODELS_DIR, { recursive: true });

  const dest = esrganModelPath(spec);
  const tmp  = dest + '.download';

  const existingBytes = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
  let bytesReceived   = existingBytes;
  let bytesTotal      = spec.sizeBytes;

  yield { id: spec.id, bytesReceived, bytesTotal, done: false };

  type QItem =
    | { kind: 'progress'; bytesReceived: number; bytesTotal: number }
    | { kind: 'done' }
    | { kind: 'error'; err: Error };

  const queue: QItem[] = [];
  let notify: (() => void) | null = null;
  const push = (item: QItem) => { queue.push(item); notify?.(); };

  const THROTTLE_MS    = 250;
  const THROTTLE_BYTES = 1 * 1024 * 1024;
  let lastEmitBytes = existingBytes;
  let lastEmitTime  = Date.now();

  const reqHeaders: Record<string, string> = {};
  if (existingBytes > 0) reqHeaders['Range'] = `bytes=${existingBytes}-`;

  const downloadPromise = new Promise<void>((resolve, reject) => {
    const follow = (targetUrl: string, redirectCount = 0) => {
      if (redirectCount > 5) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(targetUrl);
      const isHttps = parsed.protocol === 'https:';
      const mod = isHttps ? https : http;
      const req = (mod as typeof https).get(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: reqHeaders },
        (res) => {
          if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
            follow(res.headers.location!, redirectCount + 1);
            return;
          }
          if (res.statusCode !== 200 && res.statusCode !== 206) {
            const err = new Error(`HTTP ${res.statusCode} for ${targetUrl}`);
            push({ kind: 'error', err }); resolve(); return;
          }
          const contentLength = res.headers['content-length'];
          if (contentLength) bytesTotal = existingBytes + parseInt(contentLength, 10);
          const writeStream = fs.createWriteStream(tmp, { flags: existingBytes > 0 ? 'a' : 'w' });
          res.on('data', (chunk: Buffer) => {
            bytesReceived += chunk.length;
            const now = Date.now();
            if (bytesReceived - lastEmitBytes >= THROTTLE_BYTES || now - lastEmitTime >= THROTTLE_MS) {
              push({ kind: 'progress', bytesReceived, bytesTotal });
              lastEmitBytes = bytesReceived; lastEmitTime = now;
            }
          });
          res.pipe(writeStream);
          writeStream.on('finish', () => { push({ kind: 'done' }); resolve(); });
          writeStream.on('error', (err) => { push({ kind: 'error', err }); resolve(); });
        }
      );
      req.on('error', (err) => { push({ kind: 'error', err }); resolve(); });
    };
    follow(spec.url);
  });

  while (true) {
    if (queue.length > 0) {
      const item = queue.shift()!;
      if (item.kind === 'progress') {
        yield { id: spec.id, bytesReceived: item.bytesReceived, bytesTotal: item.bytesTotal, done: false };
      } else if (item.kind === 'done') {
        break;
      } else {
        yield { id: spec.id, bytesReceived, bytesTotal, done: false, error: item.err.message };
        return;
      }
    } else {
      await new Promise<void>(r => { notify = r; });
      notify = null;
    }
  }

  try { await downloadPromise; } catch { /* already yielded error */ }
  fs.renameSync(tmp, dest);
  yield { id: spec.id, bytesReceived: bytesTotal, bytesTotal, done: true };
}

// ── Model deletion ────────────────────────────────────────────────────────────

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
