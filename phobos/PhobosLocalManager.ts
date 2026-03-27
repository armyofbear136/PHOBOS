import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
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

// ── CivitAI integration ──────────────────────────────────────────────────────
const CIVITAI_TOKEN_PATH = path.join(os.homedir(), '.phobos', 'civitai-token.txt');

/** Read the stored CivitAI API token. Returns empty string if not set. */
export function getCivitaiToken(): string {
  try { return fs.existsSync(CIVITAI_TOKEN_PATH) ? fs.readFileSync(CIVITAI_TOKEN_PATH, 'utf-8').trim() : ''; }
  catch { return ''; }
}

/** Persist a CivitAI API token. Pass empty string to clear. */
export function setCivitaiToken(token: string): void {
  fs.mkdirSync(path.dirname(CIVITAI_TOKEN_PATH), { recursive: true });
  if (token) fs.writeFileSync(CIVITAI_TOKEN_PATH, token.trim(), 'utf-8');
  else { try { fs.unlinkSync(CIVITAI_TOKEN_PATH); } catch { /* ignore */ } }
}

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
   * Raw WMI / lspci enumeration position among non-NVIDIA GPUs, 0-based, before
   * any vramGb-gate filtering. Vulkan enumerates all GPUs regardless of whether
   * we skip them for inference — so the positional Vulkan index must be computed
   * from the unfiltered WMI order, not from hw.gpus which excludes skipped entries.
   * Only set on non-NVIDIA, non-Metal devices.
   */
  wmiPosition?: number;
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
      // Return both AdapterRAM and the registry qwMemorySize separately.
      // qwMemorySize is the authoritative dedicated/UMA VRAM value written by the
      // driver at install time — present on AMD discrete, AMD APU (UMA), and
      // absent or tiny on Intel iGPU (which has no dedicated memory of its own).
      // AdapterRAM is a 32-bit WMI field capped at 4 GB; it represents the
      // "shared memory aperture" for iGPUs — a small window into system RAM that
      // Windows exposes as adapter RAM. It is NOT reliable for inference budgeting.
      //
      // HasQwMemory=true means the driver reported a real dedicated/UMA allocation.
      // HasQwMemory=false means we only have the unreliable AdapterRAM aperture value.
      `$regBase = 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'; ` +
      `$adapters = Get-CimInstance Win32_VideoController ` +
      `| Where-Object { $_.Name -notmatch 'NVIDIA' -and $_.Name -notmatch 'Microsoft' -and $_.Status -eq 'OK' } ` +
      `| Select-Object -Property Name,AdapterRAM,PNPDeviceID; ` +
      `$results = @(); ` +
      `foreach ($a in $adapters) { ` +
      `  $adapterRam = [uint64]$a.AdapterRAM; ` +
      `  $qwVram = [uint64]0; ` +
      `  $hasQw = $false; ` +
      `  $regKeys = Get-ChildItem $regBase -ErrorAction SilentlyContinue | Where-Object { ` +
      `    (Get-ItemProperty $_.PSPath -Name 'DriverDesc' -ErrorAction SilentlyContinue).DriverDesc -eq $a.Name ` +
      `  }; ` +
      `  foreach ($rk in $regKeys) { ` +
      `    $qw = (Get-ItemProperty $rk.PSPath -Name 'HardwareInformation.qwMemorySize' -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize'; ` +
      `    if ($qw -and [uint64]$qw -gt $qwVram) { $qwVram = [uint64]$qw; $hasQw = $true } ` +
      `  }; ` +
      `  $results += @{ Name = $a.Name; AdapterRamBytes = $adapterRam; QwVramBytes = $qwVram; HasQwMemory = $hasQw } ` +
      `}; ` +
      `$results | ConvertTo-Json -Compress`,
    ], { timeout: 15_000 });
    if (!stdout.trim()) return [];

    const raw   = JSON.parse(stdout.trim());
    const items = Array.isArray(raw) ? raw : [raw];
    const gpus: GpuDevice[] = [];

    // Use a separate counter for assigned index so skipped GPUs (vramGb < 1)
    // don't shift the index of valid GPUs. Without this, a virtual display
    // adapter at position 0 would make the real GPU at position 1 get
    // deviceIndex=101 instead of 100, causing GGML_VK_VISIBLE_DEVICES=1.
    let nonNvidiaIdx = 0;
    for (let i = 0; i < items.length; i++) {
      const item         = items[i];
      const name         = String(item.Name ?? 'Unknown GPU');
      const hasQwMemory  = Boolean(item.HasQwMemory);
      const qwVramBytes  = Number(item.QwVramBytes ?? 0);
      const adapterBytes = Number(item.AdapterRamBytes ?? 0);

      // qwMemorySize is present → real dedicated VRAM or real UMA allocation.
      // This covers: AMD discrete (GDDR), AMD APU/iGPU with UMA (890M, 780M, etc).
      // Not present → only the shared aperture AdapterRAM is available.
      // This covers: Intel iGPU (UHD, Iris, Arc on some systems), and any adapter
      // where the driver didn't write the registry key.
      //
      // When qwMemorySize is present, that value is authoritative and marks the
      // memory as real — usable by llama.cpp's Vulkan backend for model weights.
      // When only AdapterRAM is available, the GPU has no dedicated memory that
      // llama.cpp can reliably use; mark as sharedMemoryOnly and report 0 vramGb
      // so it falls below the ≥1 GB gate and is excluded from inference budgeting.
      //
      // Exception: AdapterRAM-only GPUs are still included if they pass the ≥1 GB
      // gate AND are Intel Arc (discrete Intel GPU with real VRAM) — detected by
      // name. Arc GPUs write qwMemorySize correctly in modern drivers, so in
      // practice this exception is rarely needed.
      const isIntelArc = /Intel.*Arc/i.test(name);

      let vramGb: number;
      let unifiedMemory: boolean | undefined;
      let sharedMemoryOnly: boolean | undefined;

      if (hasQwMemory) {
        vramGb = Math.round(qwVramBytes / (1024 ** 3));
        // AMD APU / Intel (if ever writes qwMemory) with UMA: the GPU and CPU share
        // the same physical RAM pool. Flag it so the recommendation engine budgets
        // both models from one pool rather than double-counting.
        const isAmd   = /AMD|Radeon|ATI/i.test(name);
        const isIntel = /Intel/i.test(name);
        // AMD discrete GPUs have qwMemorySize = dedicated GDDR, not shared.
        // AMD APUs share system RAM. Distinguishing heuristic: discrete AMD GPUs
        // have names like "RX 6600", "RX 7900 XTX", "Vega 64", "Navi 21" etc.
        // APU iGPUs have names like "Radeon 890M", "Radeon 780M", "Radeon Vega 8".
        // Older discrete: "Radeon (TM) 520", "Radeon 530", "Radeon R5 M430", "Radeon HD 7870".
        // Note: WMI often reports trademark markers like (TM), (R), ® in GPU names.
        // The key APU tell is an 'M' suffix on 3-digit model numbers (780M, 890M).
        const amdDiscretePattern = /\bRX\s*\d{3,4}\b|\bVega\s*\d{2}\b|\bNavi\b|\bRDNA\b|\bRadeon\s*(?:\(TM\)\s*|\(R\)\s*|®\s*)?(?:HD\s*)?\d{3,4}\b|\bR[5-9]\b|\bWX\b/i;
        const amdApuPattern = /\d{3}M\b/i; // 780M, 890M, 680M — integrated APU iGPUs
        const isAmdDiscrete = isAmd && amdDiscretePattern.test(name) && !amdApuPattern.test(name);
        if (!isAmdDiscrete && (isAmd || isIntel)) {
          unifiedMemory = true; // APU or iGPU: RAM is shared pool
        }
      } else if (isIntelArc) {
        // Intel Arc discrete — should write qwMemorySize but may not on older drivers.
        // Use AdapterRAM as a fallback; it's unreliable but better than nothing.
        vramGb = Math.round(adapterBytes / (1024 ** 3));
      } else {
        // Only AdapterRAM available — this is the shared memory aperture.
        // Not usable for LLM inference. Mark and skip via the vramGb gate below.
        vramGb = 0;
        sharedMemoryOnly = true;
      }

      // Skip GPUs with no usable memory (shared-aperture-only Intel iGPU etc).
      // These appear as Vulkan devices but cannot hold model weights.
      if (vramGb < 1) {
        if (sharedMemoryOnly) {
          console.log(`[HW] ${name}: skipped — no dedicated/UMA memory (shared aperture only)`);
        }
        continue;
      }

      // wmiPosition: the Vulkan-visible position of this GPU among non-NVIDIA devices.
      // This is NOT simply the raw WMI loop index `i` because virtual display adapters
      // (Parsec, Microsoft Remote Display Adapter, TeamViewer, etc.) appear in WMI but
      // have no Vulkan ICD — they don't appear in Vulkan enumeration at all.
      // Intel/AMD GPUs (even iGPUs with only shared memory) DO have Vulkan ICDs and
      // DO shift the Vulkan slot numbers.
      // So: count only Intel/AMD devices among items[0..i-1], not all WMI entries.
      let vulkanVisiblePosition = 0;
      for (let j = 0; j < i; j++) {
        const prev = items[j];
        const prevName = String(prev.Name ?? '');
        const prevIsRealGpu = /Intel|AMD|Radeon|ATI|NVIDIA/i.test(prevName)
          && !/Parsec|Remote|Virtual|TeamViewer|Indirect|IDD/i.test(prevName);
        if (prevIsRealGpu) vulkanVisiblePosition++;
      }

      gpus.push({
        index:         100 + nonNvidiaIdx,
        name,
        vramGb,
        backend:       'vulkan',
        unifiedMemory: unifiedMemory ?? undefined,
        wmiPosition:   vulkanVisiblePosition,
      });
      nonNvidiaIdx++;
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
    let amdSysfsIdx = 0;
    for (const line of stdout.split('\n')) {
      if (!/VGA|3D|Display/.test(line)) continue;
      if (/NVIDIA/i.test(line)) continue;
      const isAmd   = /AMD|ATI|Radeon/i.test(line);
      const isIntel = /Intel/i.test(line);
      if (!isAmd && !isIntel) continue;

      // Extract GPU name — prefer the marketing name in brackets like [Radeon RX 9060 XT]
      // lspci -nn: "... Advanced Micro Devices, Inc. [AMD/ATI] Navi 48 [Radeon RX 9060 XT] [1002:7590]"
      let name = isAmd ? 'AMD GPU' : 'Intel GPU';
      const marketingMatch = line.match(/\[(Radeon[^\]]+)\]/i)
        || line.match(/\[(Intel[^\]]+)\]/i)
        || line.match(/\[(Arc[^\]]+)\]/i);
      if (marketingMatch) {
        name = marketingMatch[1].trim();
      } else {
        const nameMatch = line.match(/:\s+(.+?)(?:\s+\[|$)/);
        if (nameMatch) name = nameMatch[1].trim();
      }

      // Read VRAM from sysfs for AMD discrete GPUs
      let vramGb = 0;
      if (isAmd) {
        try {
          const drmBase = '/sys/class/drm';
          const cards = fs.readdirSync(drmBase)
            .filter(d => /^card\d+$/.test(d))
            .sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)));
          let sysIdx = 0;
          for (const card of cards) {
            const vendorPath = path.join(drmBase, card, 'device', 'vendor');
            if (!fs.existsSync(vendorPath)) continue;
            if (fs.readFileSync(vendorPath, 'utf-8').trim() !== '0x1002') continue;
            if (sysIdx === amdSysfsIdx) {
              const totalPath = path.join(drmBase, card, 'device', 'mem_info_vram_total');
              if (fs.existsSync(totalPath)) {
                const totalBytes = parseInt(fs.readFileSync(totalPath, 'utf-8').trim(), 10);
                if (!isNaN(totalBytes) && totalBytes > 0) {
                  vramGb = Math.round(totalBytes / (1024 ** 3));
                  console.log(`[HW] ${name}: sysfs VRAM ${vramGb} GB (${card})`);
                }
              }
              break;
            }
            sysIdx++;
          }
        } catch { /* sysfs read failed — leave vramGb=0 */ }
        amdSysfsIdx++;
      }

      gpus.push({ index: idx++, name, vramGb, backend: 'vulkan' });
    }
    return gpus;
  } catch {
    // lspci not installed (common on minimal Arch installs) — fall back to pure sysfs enumeration.
    // This still finds AMD discrete GPUs and reads their VRAM + marketing name.
    return detectLinuxGpusSysfsOnly();
  }
}

/** Pure sysfs fallback — no lspci needed. Enumerates /sys/class/drm/card* for AMD discrete GPUs. */
function detectLinuxGpusSysfsOnly(): GpuDevice[] {
  try {
    const drmBase = '/sys/class/drm';
    if (!fs.existsSync(drmBase)) return [];
    const cards = fs.readdirSync(drmBase)
      .filter(d => /^card\d+$/.test(d))
      .sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)));

    const gpus: GpuDevice[] = [];
    let idx = 100;
    for (const card of cards) {
      const vendorPath = path.join(drmBase, card, 'device', 'vendor');
      if (!fs.existsSync(vendorPath)) continue;
      const vendor = fs.readFileSync(vendorPath, 'utf-8').trim();
      // Skip NVIDIA (handled by detectNvidiaGpus) and unknown vendors
      if (vendor === '0x10de') continue; // NVIDIA
      const isAmd   = vendor === '0x1002';
      const isIntel = vendor === '0x8086';
      if (!isAmd && !isIntel) continue;

      // Read device marketing name from sysfs product_name or uevent
      let name = isAmd ? 'AMD GPU' : 'Intel GPU';
      try {
        const productPath = path.join(drmBase, card, 'device', 'product_name');
        if (fs.existsSync(productPath)) {
          name = fs.readFileSync(productPath, 'utf-8').trim();
        } else {
          // Fall back to uevent PCI_SLOT_NAME for identification
          const ueventPath = path.join(drmBase, card, 'device', 'uevent');
          if (fs.existsSync(ueventPath)) {
            const uevent = fs.readFileSync(ueventPath, 'utf-8');
            const devMatch = uevent.match(/PCI_ID=([0-9A-Fa-f]+):([0-9A-Fa-f]+)/);
            if (devMatch) name = isAmd ? `AMD GPU (${devMatch[1]}:${devMatch[2]})` : `Intel GPU (${devMatch[1]}:${devMatch[2]})`;
          }
        }
      } catch { /* keep default name */ }

      // Read VRAM from sysfs
      let vramGb = 0;
      if (isAmd) {
        try {
          const totalPath = path.join(drmBase, card, 'device', 'mem_info_vram_total');
          if (fs.existsSync(totalPath)) {
            const totalBytes = parseInt(fs.readFileSync(totalPath, 'utf-8').trim(), 10);
            if (!isNaN(totalBytes) && totalBytes > 0) {
              vramGb = Math.round(totalBytes / (1024 ** 3));
              console.log(`[HW] ${name}: sysfs VRAM ${vramGb} GB (${card}, fallback)`);
            }
          }
        } catch { /* leave vramGb=0 */ }
      }

      gpus.push({ index: idx++, name, vramGb, backend: 'vulkan' });
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
let _vkMapCache:       Map<string, number> | null = null;
let _vkMapCacheCudaHidden: Map<string, number> | null = null;

async function enumerateVulkanDevicesInternal(hideCuda: boolean): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const bin = resolveLlamaServerBin();
    const extraEnv: Record<string, string> = { GGML_VK_VISIBLE_DEVICES: '' };
    if (hideCuda) {
      // Simulate the environment of a non-NVIDIA spawned process.
      // NOTE: CUDA_VISIBLE_DEVICES=-1 hides NVIDIA from the CUDA backend only.
      // NVIDIA GPUs still appear in Vulkan enumeration via the NVIDIA Vulkan ICD.
      extraEnv.CUDA_VISIBLE_DEVICES = '-1';
      extraEnv.HIP_VISIBLE_DEVICES  = '-1';
    }
    const startMs = Date.now();
    const result = await execFileAsync(bin, ['--list-devices'], {
      timeout: 20000, // increased from 8s — ROCm/HIP SDK init can take 10-15s on Windows
      env: { ...process.env, ...extraEnv },
    }).catch((err: any) => {
      return { stdout: (err as any).stdout ?? '', stderr: (err as any).stderr ?? '' };
    });
    const elapsed = Date.now() - startMs;
    if (elapsed > 5000) {
      console.log(`[HW] enumerateVulkanDevices(hideCuda=${hideCuda}): took ${(elapsed / 1000).toFixed(1)}s (ROCm/HIP init overhead)`);
    }
    const output = (result.stdout ?? '') + '\n' + (result.stderr ?? '');
    for (const match of output.matchAll(/ggml_vulkan:\s+(\d+)\s*=\s*([^|\n]+)/g)) {
      const idx  = parseInt(match[1], 10);
      const name = match[2].trim();
      map.set(name.toLowerCase(), idx);
      const short = name.toLowerCase().replace(/\(.*?\)/g, '').trim();
      if (short !== name.toLowerCase()) map.set(short, idx);
    }
  } catch { /* ignore */ }
  return map;
}

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
    const startMs = Date.now();
    const result = await execFileAsync(bin, ['--list-devices'], {
      timeout: 20000, // increased from 8s — ROCm/HIP SDK init can take 10-15s on Windows
      env: { ...process.env, GGML_VK_VISIBLE_DEVICES: '' },
    }).catch((err: any) => {
      // Non-zero exit is fine — ggml still printed device lines before exiting
      return { stdout: (err as any).stdout ?? '', stderr: (err as any).stderr ?? '' };
    });
    const elapsed = Date.now() - startMs;
    if (elapsed > 5000) {
      console.log(`[HW] enumerateVulkanDevices: took ${(elapsed / 1000).toFixed(1)}s`);
    }

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
  // Also enumerate with CUDA hidden — this is what non-NVIDIA spawned processes see.
  // Needed when NVIDIA + AMD/Intel coexist: CUDA_VISIBLE_DEVICES=-1 hides CUDA
  // but the GPU may still appear as a Vulkan device, shifting non-NVIDIA indices.
  if (!_vkMapCacheCudaHidden) {
    _vkMapCacheCudaHidden = await enumerateVulkanDevicesInternal(true);
  }
  const vkMapCudaHidden = _vkMapCacheCudaHidden;
  const hasRuntimeEnum = vkMap.size > 0;
  const hasCudaHiddenEnum = vkMapCudaHidden.size > 0;

  if (hasRuntimeEnum) {
    console.log(`[HW] Vulkan runtime enum: ${[...vkMap.entries()].filter(([k]) => !k.includes('(')).map(([n, i]) => `${i}=${n}`).join(', ')}`);
  } else {
    console.warn('[HW] Vulkan runtime enumeration unavailable — using positional fallback');
  }
  if (hasCudaHiddenEnum) {
    console.log(`[HW] Vulkan (CUDA-hidden) enum: ${[...vkMapCudaHidden.entries()].filter(([k]) => !k.includes('(')).map(([n, i]) => `${i}=${n}`).join(', ')}`);
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

    // Non-NVIDIA: runtime match primary, positional fallback.
    //
    // IMPORTANT: CUDA_VISIBLE_DEVICES=-1 hides NVIDIA from the CUDA backend
    // but NOT from Vulkan. NVIDIA GPUs still appear in Vulkan enumeration via
    // the NVIDIA Vulkan ICD. So on a mixed NVIDIA+AMD system, the Vulkan device
    // list might be: [0]=RTX 3080, [1]=Radeon 890M.
    //
    // GGML_VK_VISIBLE_DEVICES operates on the FULL Vulkan device list (including
    // NVIDIA GPUs), not a CUDA-filtered subset. So we must include NVIDIA GPUs
    // in the positional index calculation.
    //
    // Positional index: use gpu.wmiPosition when available (raw WMI order).
    // On mixed systems, NVIDIA GPUs typically enumerate first in Vulkan, so
    // offset by nvidiaCount. If wmiPosition is absent, count all GPUs with
    // lower index.
    const nonNvidiaPosition = gpu.wmiPosition !== undefined
      ? gpu.wmiPosition
      : gpus.filter(g => g.backend !== 'cuda' && g.backend !== 'metal' && g.index < gpu.index).length;
    // On mixed NVIDIA+AMD/Intel systems, NVIDIA GPUs occupy the first Vulkan
    // slots. Offset by nvidiaCount so the first non-NVIDIA GPU gets the right index.
    const positionalIndex = nvidiaCount + nonNvidiaPosition;
    // Prefer the CUDA-hidden enumeration index — this matches what the spawned
    // process will see when CUDA_VISIBLE_DEVICES=-1 is set. Fall back to full
    // enumeration, then positional.
    const cudaHiddenIdx   = hasCudaHiddenEnum ? matchVulkanIndex(gpu.name, vkMapCudaHidden) : undefined;
    const runtimeIdx      = hasRuntimeEnum    ? matchVulkanIndex(gpu.name, vkMap)           : undefined;
    const vulkanIndex     = cudaHiddenIdx ?? runtimeIdx ?? positionalIndex;

    const src2 = cudaHiddenIdx !== undefined ? 'cuda-hidden enum'
               : runtimeIdx   !== undefined ? 'runtime enum'
               : 'positional fallback';
    console.log(`[HW] ${gpu.name}: Vulkan${vulkanIndex} (${src2})`);

    const isAmd     = /AMD|Radeon|ATI/i.test(gpu.name);
    const isIntel   = /Intel/i.test(gpu.name);
    const isUnified = gpu.unifiedMemory === true;

    let kind: GpuRunnerKind;
    if (isAmd && isUnified)  kind = 'amd-igpu';
    else if (isAmd)          kind = 'amd-discrete';
    else if (isIntel)        kind = 'intel-igpu';
    else                     kind = 'amd-discrete';

    let sdBin: 'rocm' | 'vulkan' | 'cpu' = 'vulkan';
    if (isAmd && !isUnified && _isRocmAvailable()) {
      // RDNA 4 (RX 9xxx / gfx1200) on Windows: ROCm HIP SDK 7.1 ships Tensile
      // kernels that crash with CUBLAS_STATUS_INTERNAL_ERROR or ILLEGAL_INSTRUCTION
      // on gfx1200. Use Vulkan until Windows HIP SDK 7.2+ ships the fix.
      // Linux ROCm 7.2+ works fine — this gate is Windows-only.
      // TODO: Remove this gate when Windows HIP SDK ≥7.2 is available.
      const isRdna4Windows = process.platform === 'win32' && /RX\s*9\d{3}/i.test(gpu.name);
      sdBin = isRdna4Windows ? 'vulkan' : 'rocm';
      if (isRdna4Windows) {
        console.log(`[HW] ${gpu.name}: ROCm gfx1200 unsupported on Windows HIP SDK <7.2 — using Vulkan`);
      }
    }

    gpu.runner = { kind, vulkanIndex, sdBinary: sdBin };
  }
}

// ── Hardware detection cache ─────────────────────────────────────────────────
// Hardware doesn't change at runtime. Cache indefinitely after first successful detection.
// Call invalidateHardwareCache() if a model switch needs fresh VRAM readings (future).
let _hwCache: HardwareProfile | null = null;
let _hwInFlight: Promise<HardwareProfile> | null = null;

export function invalidateHardwareCache(): void {
  _hwCache = null;
  _hwInFlight = null;
}

/** Synchronous read of the hardware cache. Returns null before first detectHardware() call completes. */
export function getCachedHardware(): HardwareProfile | null {
  return _hwCache;
}

export async function detectHardware(): Promise<HardwareProfile> {
  if (_hwCache) return _hwCache;
  // Deduplicate concurrent calls — all callers share one in-flight detection run.
  // Without this, two simultaneous reconcile calls both see _hwCache=null, run
  // detection in parallel, produce different gpu object instances, and the runner
  // profiles set by assignRunnerProfiles on one instance are not visible via the other.
  if (_hwInFlight) return _hwInFlight;

  _hwInFlight = (async () => {
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
    _hwCache = { ramGb, cpuCores, cpuName, gpus };
    _hwInFlight = null;
    return _hwCache;
  })();

  return _hwInFlight;
}

// ── Live VRAM query (cross-vendor) ───────────────────────────────────────────
// Returns free VRAM in MB for a specific GPU. Independent of _hwCache.
// NVIDIA: nvidia-smi per-device query.
// Windows AMD/Intel: DXGI performance counters via PowerShell.
// Linux AMD: sysfs mem_info_vram_used / mem_info_vram_total.
// macOS / unified: returns undefined (always fits, handled by offloadToCpu).

export async function queryGpuFreeVram(gpu: GpuDevice): Promise<number | undefined> {
  if (gpu.unifiedMemory) return undefined;   // unified memory — no discrete VRAM gate
  if (gpu.backend === 'metal') return undefined;

  // ── NVIDIA — nvidia-smi per-device query ──────────────────────────────────
  if (gpu.backend === 'cuda') {
    try {
      const { stdout } = await execFileAsync('nvidia-smi', [
        '--query-gpu=memory.free',
        '--format=csv,noheader,nounits',
        '-i', String(gpu.index),
      ], { timeout: 3000 });
      const freeMb = parseInt(stdout.trim(), 10);
      if (!isNaN(freeMb)) return freeMb;
    } catch { /* fall through */ }
    return undefined;
  }

  // ── Windows non-NVIDIA — DXGI GPU performance counters via WMI ─────────
  // Two-step approach: query adapter list (with names + LUIDs) and memory
  // counters (with DedicatedUsage + LUIDs). Cross-reference by LUID to match
  // the correct adapter's memory usage to our GPU name.
  //
  // WMI adapter memory Name format: "luid_0xHIGH_0xLOW_phys_N" — no adapter name.
  // So we extract the LUID prefix and match it against adapters queried separately.
  if (process.platform === 'win32') {
    try {
      // Single PowerShell call: get both adapters (with LUID) and memory counters.
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile', '-Command',
        // Get adapter names with their LUID from PnP GPU instance paths.
        // The GPU Adapter Memory counter Name starts with "luid_0xHIGH_0xLOW_".
        // Win32_VideoController gives us the adapter name. We match via DeviceID index.
        //
        // Simpler approach: just get all GPU adapter memory entries and pick by position.
        // The order matches WMI adapter enumeration order, which is how wmiPosition was computed.
        `Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory ` +
        `| Select-Object Name, DedicatedUsage, SharedUsage | ConvertTo-Json -Compress`,
      ], { timeout: 8000 });
      if (stdout.trim()) {
        const raw = JSON.parse(stdout.trim());
        const items = Array.isArray(raw) ? raw : [raw];

        // Deduplicate by LUID — multiple entries per adapter (different phys nodes).
        // Keep the one with highest DedicatedUsage per unique LUID prefix.
        const byLuid = new Map<string, number>();
        for (const item of items) {
          const name = String(item.Name ?? '');
          // Extract LUID: "luid_0xHIGH_0xLOW_phys_N" → "luid_0xHIGH_0xLOW"
          const luidMatch = name.match(/^(luid_0x[0-9a-f]+_0x[0-9a-f]+)/i);
          if (!luidMatch) continue;
          const luid  = luidMatch[1].toLowerCase();
          const usage = Number(item.DedicatedUsage ?? 0);
          const prev  = byLuid.get(luid) ?? -1;
          if (usage > prev) byLuid.set(luid, usage);
        }

        // Convert to ordered array — WMI enumeration order matches adapter order.
        const adapters = [...byLuid.entries()]; // [[luid, usage], ...]

        // Match by position: gpu.wmiPosition is the non-NVIDIA adapter index
        // from WMI enumeration during detectHardware(). The DXGI adapter order
        // should match. For NVIDIA GPUs (which hit the nvidia-smi path above),
        // they still appear in the DXGI list, so we need to skip them.
        //
        // Strategy: if we have wmiPosition, use it directly as index into the
        // non-NVIDIA DXGI adapters. If not, fall back to first adapter with
        // non-zero dedicated usage.
        //
        // Actually simpler: gpu.wmiPosition counts non-NVIDIA WMI adapters.
        // But DXGI includes ALL adapters (NVIDIA too). So we can't index directly.
        // Instead: try name-based match first (some Windows versions include names),
        // then fall back to LUID positional match excluding NVIDIA LUIDs.
        //
        // Simplest reliable approach: since this function is only called for
        // non-NVIDIA GPUs (NVIDIA hits nvidia-smi above), and the 9060 XT system
        // has only one discrete GPU, just pick the LUID with the highest
        // DedicatedUsage (the discrete GPU, not the iGPU).
        // On multi-AMD systems, use wmiPosition to index.
        let usageBytes = -1;
        if (adapters.length === 1) {
          usageBytes = adapters[0][1];
        } else if (gpu.wmiPosition !== undefined && gpu.wmiPosition < adapters.length) {
          usageBytes = adapters[gpu.wmiPosition][1];
        } else {
          // Fallback: pick adapter with highest dedicated usage (likely the discrete GPU)
          for (const [, usage] of adapters) {
            if (usage > usageBytes) usageBytes = usage;
          }
        }

        if (usageBytes >= 0) {
          const totalMb = gpu.vramGb * 1024;
          const usedMb  = Math.round(usageBytes / (1024 * 1024));
          const freeMb  = Math.max(0, totalMb - usedMb);
          console.log(`[HW] DXGI VRAM for ${gpu.name}: ${usedMb} MB used / ${totalMb} MB total → ${freeMb} MB free (${adapters.length} adapters)`);
          return freeMb;
        }
        console.warn(`[HW] DXGI VRAM: no adapters found in performance counters`);
      }
    } catch (err) {
      console.warn(`[HW] DXGI VRAM query failed for ${gpu.name}: ${(err as Error).message}`);
    }
    return undefined;
  }

  // ── Linux AMD — sysfs ─────────────────────────────────────────────────────
  // Enumerate /sys/class/drm/card*/device/ to find AMD GPUs (vendor 0x1002).
  // Match by order among AMD cards — gpu.index offset 100+ maps to drm card order.
  if (process.platform === 'linux') {
    try {
      const drmBase = '/sys/class/drm';
      const cards = fs.readdirSync(drmBase)
        .filter(d => /^card\d+$/.test(d))
        .sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)));

      let amdIdx = 0;
      for (const card of cards) {
        const vendorPath = path.join(drmBase, card, 'device', 'vendor');
        const totalPath  = path.join(drmBase, card, 'device', 'mem_info_vram_total');
        const usedPath   = path.join(drmBase, card, 'device', 'mem_info_vram_used');
        if (!fs.existsSync(vendorPath)) continue;
        const vendor = fs.readFileSync(vendorPath, 'utf-8').trim();
        if (vendor !== '0x1002') continue; // AMD vendor ID
        // gpu.index is 100+N where N is the non-NVIDIA GPU index from detection.
        // Match by counting AMD sysfs cards in order.
        if (100 + amdIdx === gpu.index) {
          if (fs.existsSync(totalPath) && fs.existsSync(usedPath)) {
            const totalBytes = parseInt(fs.readFileSync(totalPath, 'utf-8').trim(), 10);
            const usedBytes  = parseInt(fs.readFileSync(usedPath, 'utf-8').trim(), 10);
            if (!isNaN(totalBytes) && !isNaN(usedBytes)) {
              const freeMb = Math.round((totalBytes - usedBytes) / (1024 * 1024));
              console.log(`[HW] sysfs VRAM for ${gpu.name} (${card}): ${freeMb} MB free`);
              return Math.max(0, freeMb);
            }
          }
        }
        amdIdx++;
      }
    } catch (err) {
      console.warn(`[HW] sysfs VRAM query failed for ${gpu.name}: ${(err as Error).message}`);
    }
    return undefined;
  }

  return undefined;
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
   * Nemotron architecture variant. All current Nemotron models are Mamba-2 hybrids.
   * 'mamba' — Nemotron-H Mamba-2/MoE hybrid (4B, 9B v2, 30B-A3B)
   *           <think> token ID 12, </think> token ID 13 — special tokens, not parsed
   *           by llama-server's reasoning_format:deepseek. Must use tag-path parsing.
   *
   * The 'llama' variant is reserved for future Llama-derived Nemotron models if any are added.
   */
  nemotronVariant?: 'llama' | 'mamba';
  /**
   * Active parameters in billions. For dense models = total params.
   * For MoE/sparse: only the params active per token (e.g. 3.2 for Nemotron 30B-A3B).
   * Drives throughput estimation — lower active params = faster tok/s on same hardware.
   */
  activeParamsB: number;
  /**
   * Quality tier 1–5 for EACH role this model can serve.
   * SAYON quality = coordination/classification ability.
   * SEREN quality = deep reasoning/code generation ability.
   * Models with role='sayon' only need sayonQuality.
   * Models with role='seren' only need serenQuality.
   * Models with role='both' need both.
   */
  sayonQuality?: number;
  serenQuality?: number;
  /**
   * Rough throughput bucket at Q4 quantization.
   * 'fast'   = ≤4B active params, 30+ tok/s on mid-range GPU
   * 'medium' = 5–12B active params, 15–30 tok/s
   * 'slow'   = 13B+ active params, <15 tok/s
   */
  speedClass: 'fast' | 'medium' | 'slow';
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
    activeParamsB: 3.0, sayonQuality: 2, speedClass: 'fast',
  },
  {
    modelId: 'llama3.1-8b-q4', label: 'Llama 3.1 8B Q4', family: 'Llama 3',
    role: 'sayon', thinkingTokens: false, jinjaTemplate: false,
    hfRepo: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',
    hfFile: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    sizeBytes: 4_920_000_000, ramRequiredGb: 6, contextWindow: 131072,
    kvCacheMbPer1kTokens: 128,  // 32 layers x 8 KV heads x 128 head_dim x 2 x F16
    activeParamsB: 8.0, sayonQuality: 3, speedClass: 'medium',
  },
  // ── Gemma 3 family ───────────────────────────────────────────────────────────
  {
    modelId: 'gemma3-1b-q4', label: 'Gemma 3 1B Q4', family: 'Gemma 3',
    role: 'sayon', thinkingTokens: false, jinjaTemplate: false,
    hfRepo: 'bartowski/google_gemma-3-1b-it-GGUF',
    hfFile: 'google_gemma-3-1b-it-Q4_K_M.gguf',
    sizeBytes: 694_000_000, ramRequiredGb: 1, contextWindow: 32768,
    kvCacheMbPer1kTokens: 72,   // 18 layers x 4 KV heads x 256 head_dim x 2 x F16
    activeParamsB: 1.0, sayonQuality: 1, speedClass: 'fast',
  },
  {
    modelId: 'gemma3-4b-q4', label: 'Gemma 3 4B Q4', family: 'Gemma 3',
    role: 'sayon', thinkingTokens: false, jinjaTemplate: false,
    hfRepo: 'bartowski/google_gemma-3-4b-it-GGUF',
    hfFile: 'google_gemma-3-4b-it-Q4_K_M.gguf',
    sizeBytes: 2_530_000_000, ramRequiredGb: 3, contextWindow: 131072,
    kvCacheMbPer1kTokens: 72,   // 18 layers x 4 KV heads x 256 head_dim x 2 x F16
    activeParamsB: 4.0, sayonQuality: 3, speedClass: 'fast',
  },
  {
    modelId: 'gemma3-12b-q4', label: 'Gemma 3 12B Q4', family: 'Gemma 3',
    role: 'sayon', thinkingTokens: false, jinjaTemplate: false,
    hfRepo: 'bartowski/google_gemma-3-12b-it-GGUF',
    hfFile: 'google_gemma-3-12b-it-Q4_K_M.gguf',
    sizeBytes: 7_800_000_000, ramRequiredGb: 10, contextWindow: 131072,
    kvCacheMbPer1kTokens: 224,  // 28 layers x 8 KV heads x 256 head_dim x 2 x F16
    activeParamsB: 12.0, sayonQuality: 4, speedClass: 'medium',
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
    activeParamsB: 5.0, serenQuality: 2, speedClass: 'fast',  // GDN+sparse adds ~25% overhead vs Qwen3
  },
  {
    modelId: 'qwen3.5-9b-q4', label: 'Qwen3.5 9B Q4', family: 'Qwen3.5',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/Qwen_Qwen3.5-9B-GGUF',
    hfFile: 'Qwen_Qwen3.5-9B-Q4_K_M.gguf',
    sizeBytes: 5_500_000_000, ramRequiredGb: 7, contextWindow: 262144,
    kvCacheMbPer1kTokens: 144,  // estimated from Qwen3-8B baseline, hybrid attention reduces effective cost
    activeParamsB: 11.0, serenQuality: 4, speedClass: 'medium',  // GDN+sparse adds ~25% overhead vs Qwen3
  },
  {
    modelId: 'qwen3.5-27b-q4', label: 'Qwen3.5 27B Q4', family: 'Qwen3.5',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/Qwen_Qwen3.5-27B-GGUF',
    hfFile: 'Qwen_Qwen3.5-27B-Q4_K_M.gguf',
    sizeBytes: 16_000_000_000, ramRequiredGb: 18, contextWindow: 262144,
    kvCacheMbPer1kTokens: 224,  // dense 27B — similar KV structure to Gemma 3 12B but more layers
    activeParamsB: 34.0, serenQuality: 5, speedClass: 'slow',  // GDN+sparse adds ~25% overhead vs dense
  },
  {
    modelId: 'qwen3.5-35b-a3b-q4', label: 'Qwen3.5 35B-A3B Q4', family: 'Qwen3.5',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/Qwen_Qwen3.5-35B-A3B-GGUF',
    hfFile: 'Qwen_Qwen3.5-35B-A3B-Q4_K_M.gguf',
    sizeBytes: 21_000_000_000, ramRequiredGb: 23, contextWindow: 262144,
    kvCacheMbPer1kTokens: 96,   // MoE sparse — active params ~3B, KV cost similar to 4B
    activeParamsB: 3.8, serenQuality: 4, speedClass: 'fast',  // MoE 3B active + GDN overhead
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
    activeParamsB: 4.0, serenQuality: 2, speedClass: 'fast',  // standard attention — faster than Qwen3.5 on weak hardware
  },
  {
    modelId: 'qwen3-8b-q4', label: 'Qwen3 8B Q4', family: 'Qwen3',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true, legacy: true,
    hfRepo: 'bartowski/Qwen_Qwen3-8B-GGUF',
    hfFile: 'Qwen_Qwen3-8B-Q4_K_M.gguf',
    sizeBytes: 5_190_000_000, ramRequiredGb: 6, contextWindow: 32768,
    kvCacheMbPer1kTokens: 144,
    activeParamsB: 8.0, serenQuality: 3, speedClass: 'medium',
  },
  {
    modelId: 'qwen3-14b-q4', label: 'Qwen3 14B Q4', family: 'Qwen3',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true, legacy: true,
    hfRepo: 'bartowski/Qwen_Qwen3-14B-GGUF',
    hfFile: 'Qwen_Qwen3-14B-Q4_K_M.gguf',
    sizeBytes: 9_000_000_000, ramRequiredGb: 11, contextWindow: 32768,
    kvCacheMbPer1kTokens: 160,
    activeParamsB: 14.0, serenQuality: 3, speedClass: 'slow',
  },
  {
    modelId: 'qwen3-30b-a3b-q4', label: 'Qwen3 30B-A3B Q4', family: 'Qwen3',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true, legacy: true,
    hfRepo: 'bartowski/Qwen_Qwen3-30B-A3B-GGUF',
    hfFile: 'Qwen_Qwen3-30B-A3B-Q4_K_M.gguf',
    sizeBytes: 18_400_000_000, ramRequiredGb: 20, contextWindow: 32768,
    kvCacheMbPer1kTokens: 96,
    activeParamsB: 3.0, serenQuality: 3, speedClass: 'fast',
  },
  // ── Mistral family ───────────────────────────────────────────────────────────
  {
    modelId: 'mistral-7b-q4', label: 'Mistral 7B v0.3 Q4', family: 'Mistral',
    role: 'sayon', thinkingTokens: false, jinjaTemplate: false,
    hfRepo: 'bartowski/Mistral-7B-Instruct-v0.3-GGUF',
    hfFile: 'Mistral-7B-Instruct-v0.3-Q4_K_M.gguf',
    sizeBytes: 4_370_000_000, ramRequiredGb: 6, contextWindow: 32768,
    kvCacheMbPer1kTokens: 128,  // 32 layers x 8 KV heads x 128 head_dim x 2 x F16
    activeParamsB: 7.0, sayonQuality: 3, speedClass: 'medium',
  },
  {
    modelId: 'magistral-8b-q4', label: 'Magistral 24B Q4', family: 'Mistral',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/mistralai_Magistral-Small-2506-GGUF',
    hfFile: 'mistralai_Magistral-Small-2506-Q4_K_M.gguf',
    sizeBytes: 14_400_000_000, ramRequiredGb: 16, contextWindow: 131072,
    kvCacheMbPer1kTokens: 128,  // 32 layers x 8 KV heads x 128 head_dim x 2 x F16
    activeParamsB: 24.0, serenQuality: 5, speedClass: 'slow',
  },
  // ── DeepSeek-R1 family ───────────────────────────────────────────────────────
  {
    modelId: 'deepseek-r1-8b-q4', label: 'DeepSeek-R1 8B Q4', family: 'DeepSeek-R1',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/deepseek-ai_DeepSeek-R1-0528-Qwen3-8B-GGUF',
    hfFile: 'deepseek-ai_DeepSeek-R1-0528-Qwen3-8B-Q4_K_M.gguf',
    sizeBytes: 5_190_000_000, ramRequiredGb: 6, contextWindow: 32768,
    kvCacheMbPer1kTokens: 144,  // 36 layers x 8 KV heads x 128 head_dim x 2 x F16
    activeParamsB: 8.0, serenQuality: 3, speedClass: 'medium',
  },
  {
    modelId: 'deepseek-r1-14b-q4', label: 'DeepSeek-R1 14B Q4', family: 'DeepSeek-R1',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF',
    hfFile: 'DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf',
    sizeBytes: 9_050_000_000, ramRequiredGb: 11, contextWindow: 65536,
    kvCacheMbPer1kTokens: 192,  // 48 layers x 8 KV heads x 128 head_dim x 2 x F16
    activeParamsB: 14.0, serenQuality: 4, speedClass: 'slow',
  },
  {
    modelId: 'deepseek-r1-70b-q4', label: 'DeepSeek-R1 70B Q4', family: 'DeepSeek-R1',
    role: 'seren', thinkingTokens: true, jinjaTemplate: false,
    hfRepo: 'bartowski/DeepSeek-R1-Distill-Llama-70B-GGUF',
    hfFile: 'DeepSeek-R1-Distill-Llama-70B-Q4_K_M.gguf',
    sizeBytes: 42_520_000_000, ramRequiredGb: 48, contextWindow: 65536,
    kvCacheMbPer1kTokens: 320,  // 80 layers x 8 KV heads x 128 head_dim x 2 x F16
    activeParamsB: 70.0, serenQuality: 5, speedClass: 'slow',
  },
  // ── Nemotron 3 family ────────────────────────────────────────────────────────
  // Hybrid Mamba-2/MoE-Transformer architecture from NVIDIA. Requires llama.cpp b6315+
  // for the nemotron_h architecture type. Thinking tokens supported via <think> tags.
  // License: NVIDIA Open Model License (commercial-friendly open weights).
  // Knowledge cutoff: pre-training June 2025, post-training November 2025.
  {
    modelId: 'nemotron3-4b-q4', label: 'Nemotron 3 Nano 4B Q4', family: 'Nemotron 3',
    role: 'sayon', thinkingTokens: true, jinjaTemplate: true, nemotronVariant: 'mamba',
    hfRepo: 'unsloth/NVIDIA-Nemotron-3-Nano-4B-GGUF',
    hfFile: 'NVIDIA-Nemotron-3-Nano-4B-Q4_K_M.gguf',
    sizeBytes: 2_600_000_000, ramRequiredGb: 4, contextWindow: 32768,
    kvCacheMbPer1kTokens: 96,   // Mamba-2 hybrid (21 Mamba, 4 attn, 17 MLP layers) — pruned from 9B v2
    activeParamsB: 4.0, sayonQuality: 4, speedClass: 'fast',
  },
  {
    modelId: 'nemotron3-9b-q4', label: 'Nemotron 3 Nano 9B Q4', family: 'Nemotron 3',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true, nemotronVariant: 'mamba',
    hfRepo: 'bartowski/nvidia_NVIDIA-Nemotron-Nano-9B-v2-GGUF',
    hfFile: 'nvidia_NVIDIA-Nemotron-Nano-9B-v2-Q4_K_M.gguf',
    sizeBytes: 5_700_000_000, ramRequiredGb: 6, contextWindow: 32768,
    kvCacheMbPer1kTokens: 96,   // Nemotron-H Mamba-2 hybrid (Mamba-2 + 4 attn layers) — Nemotron Nano 2
    activeParamsB: 9.0, serenQuality: 3, speedClass: 'medium',
  },
  {
    modelId: 'nemotron3-30b-a3b-q4', label: 'Nemotron 3 Nano 30B-A3B Q4', family: 'Nemotron 3',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true, nemotronVariant: 'mamba',
    hfRepo: 'unsloth/Nemotron-3-Nano-30B-A3B-GGUF',
    hfFile: 'Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf',
    sizeBytes: 22_800_000_000, ramRequiredGb: 25, contextWindow: 32768,
    kvCacheMbPer1kTokens: 96,   // Mamba-2/MoE hybrid — ~3B active params, reasoning via chat_template_kwargs
    activeParamsB: 3.2, serenQuality: 4, speedClass: 'fast',
  },
  // ── Nanbeige4.1 family ──────────────────────────────────────────────────────
  // Qwen2.5-based architecture (standard attention, no GDN overhead).
  // Claims to outperform Qwen3-32B on Arena-Hard despite 3B params.
  // Thinking via <think> tags, ChatML template. Apache 2.0.
  // --jinja --reasoning-format deepseek works (field path, same as Qwen3).
  {
    modelId: 'nanbeige4.1-3b-q4', label: 'Nanbeige4.1 3B Q4', family: 'Nanbeige',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'mradermacher/Nanbeige4.1-3B-GGUF',
    hfFile: 'Nanbeige4.1-3B.Q4_K_M.gguf',
    sizeBytes: 2_440_000_000, ramRequiredGb: 3, contextWindow: 32768,
    kvCacheMbPer1kTokens: 112,  // Qwen2.5 architecture — 28 layers, standard GQA
    activeParamsB: 3.0, serenQuality: 3, speedClass: 'fast',  // standard attn = fast on weak hardware
  },
  // ── SmolLM3 family ──────────────────────────────────────────────────────────
  // HuggingFace's fully open 3B model. GQA + NoPE architecture (standard attention).
  // Trained on 11.2T tokens. Thinking via /think /no_think in system prompt.
  // --jinja --reasoning-format deepseek works. 128K context with YaRN. Apache 2.0.
  // Tool calling supported natively.
  {
    modelId: 'smollm3-3b-q4', label: 'SmolLM3 3B Q4', family: 'SmolLM3',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/HuggingFaceTB_SmolLM3-3B-GGUF',
    hfFile: 'HuggingFaceTB_SmolLM3-3B-Q4_K_M.gguf',
    sizeBytes: 1_920_000_000, ramRequiredGb: 3, contextWindow: 131072,
    kvCacheMbPer1kTokens: 96,   // GQA + NoPE — lightweight KV cache
    activeParamsB: 3.0, serenQuality: 3, speedClass: 'fast',  // standard attn, competitive with 4B models
  },
  // ── Phi-4 mini reasoning family ─────────────────────────────────────────────
  // Microsoft's reasoning distill from DeepSeek-R1. 3.8B params.
  // Uses phi4 template. Always produces <think> tags (R1 distill).
  // jinjaTemplate: true so LlamaServerManager passes --jinja.
  // ThinkingTokenRouter uses tag path — reasoning_format:none per-request keeps
  // <think> tags in delta.content where our tag parser extracts them.
  {
    modelId: 'phi4-mini-reasoning-q4', label: 'Phi-4 Mini Reasoning Q4', family: 'Phi-4',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/microsoft_Phi-4-mini-reasoning-GGUF',
    hfFile: 'microsoft_Phi-4-mini-reasoning-Q4_K_M.gguf',
    sizeBytes: 2_390_000_000, ramRequiredGb: 3, contextWindow: 131072,
    kvCacheMbPer1kTokens: 96,   // Phi-4 architecture — efficient KV heads
    activeParamsB: 3.8, serenQuality: 3, speedClass: 'fast',  // R1 distill quality at 3.8B
  },
  // ── Ministral 3 Reasoning family ─────────────────────────────────────────────
  // Mistral's smallest reasoning model. 3B params. Trained for chain-of-thought.
  // Mistral v7 template. Produces <think> tags when reasoning. Apache 2.0.
  // Smallest RAM footprint in catalogue — fits in 2 GB GPU.
  {
    modelId: 'ministral-3b-q4', label: 'Ministral 3B Reasoning Q4', family: 'Ministral',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/mistralai_Ministral-3-3B-Reasoning-2512-GGUF',
    hfFile: 'mistralai_Ministral-3-3B-Reasoning-2512-Q4_K_M.gguf',
    sizeBytes: 1_830_000_000, ramRequiredGb: 2, contextWindow: 131072,
    kvCacheMbPer1kTokens: 64,   // Mistral GQA — very efficient KV heads
    activeParamsB: 3.0, serenQuality: 2, speedClass: 'fast',  // smallest viable SEREN
  },
  // ── Qwen3.5 sub-4B family ──────────────────────────────────────────────────
  // Qwen3.5 2B — ultra-constrained SEREN option. Thinking can be unstable.
  // GDN + sparse attention overhead applies (inflated activeParamsB).
  {
    modelId: 'qwen3.5-2b-q4', label: 'Qwen3.5 2B Q4', family: 'Qwen3.5',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/Qwen_Qwen3.5-2B-GGUF',
    hfFile: 'Qwen_Qwen3.5-2B-Q4_K_M.gguf',
    sizeBytes: 1_520_000_000, ramRequiredGb: 2, contextWindow: 262144,
    kvCacheMbPer1kTokens: 80,   // GDN hybrid — lower layers than 4B variant
    activeParamsB: 2.5, serenQuality: 1, speedClass: 'fast',  // GDN overhead + unstable thinking at 2B
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
export type ImageModelCategory = 'realistic' | 'nsfw-artistic' | 'anime' | 'nsfw-realistic' | 'nsfw-anime' | 'civitai' | 'legacy' | 'video' | 'kontext';

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
  /** MoE dual-model: second diffusion GGUF path within hfRepo (e.g. Wan 2.2 HighNoise expert).
   *  When present, hfFile is the LowNoise/primary expert and this is the HighNoise expert.
   *  sd-cli: --diffusion-model <hfFile> --high-noise-diffusion-model <highNoiseHfFile> */
  highNoiseHfFile?: string;
  /** Byte size of the highNoise GGUF — used for download progress and disk checks. */
  highNoiseSizeBytes?: number;
  /** Minimum VRAM in GB — kept for backward compat / sorting. Use diffusionMb+encoderMb+vaeMb for precise checks. */
  vramRequiredGb: number;
  /** Diffusion model weights in VRAM (MB). From sd-cli "diffusion_model" log. */
  diffusionMb: number;
  /** Built-in encoder weights in VRAM (MB). For models with LLM encoder (Z-Image, Klein, Qwen-Image).
   *  0 for models that use external T5/CLIP (FLUX, Chroma) or have everything baked in (SDXL). */
  encoderMb: number;
  /** VAE weights in VRAM (MB). ~95 for FLUX/Chroma ae.safetensors, ~164 for FLUX.2 vae, 0 for SDXL (baked in). */
  vaeMb: number;
  /** Estimated generation time on CUDA (RTX 3080 class), seconds */
  estSecondsCuda: number;
  /** Estimated generation time on Vulkan (iGPU class), seconds */
  estSecondsVulkan: number;
  /** Estimated generation time on CPU, seconds */
  estSecondsCpu: number;
  license: string;
  licenseUrl: string;
  /** Per-model generation profile — drives defaults, UI, and SAYON prompt engineering */
  profile?: ImageModelProfile;
  /** If true, model is hidden from download/selection UI. Used for models that require
   *  pipeline features not yet implemented (e.g. Wan 2.2 dual HighNoise/LowNoise GGUF). */
  blocked?: boolean;
  /** CivitAI model version ID for download. When present, hfRepo/hfFile are ignored and
   *  the model is downloaded from https://civitai.com/api/download/models/{civitaiVersionId}.
   *  Requires a CivitAI API token stored at ~/.phobos/civitai-token.txt. */
  civitaiVersionId?: number;
  /** Local filename for CivitAI downloads (since the URL doesn't contain the filename). */
  civitaiFilename?: string;
}

/**
 * Per-model generation profile. Consumed by:
 *   - buildSdxlArgs / buildChromaArgs / etc (generation defaults)
 *   - WorkflowPanel (UI defaults when creating a new workflow node)
 *   - SAYON (prompt engineering context via sayonBrief)
 *
 * When profile is undefined, the arg builder falls back to runner-level defaults.
 */
export interface ImageModelProfile {
  // ── Generation defaults ─────────────────────────────────
  defaultSteps:      number;
  defaultCfgScale:   number;
  defaultWidth:      number;
  defaultHeight:     number;
  defaultSampler:    string;
  defaultScheduler?: string;        // 'discrete' | 'karras' | 'simple' — omit for sd-cli default
  defaultNegative:   string;        // recommended negative prompt — empty string if model doesn't benefit

  // ── Prompt style ────────────────────────────────────────
  /** How SAYON should format prompts for this model:
   *   natural: prose sentences — "a bear walking through misty woods at dawn"
   *   tags:    comma-separated descriptors — "photorealistic, 8k, detailed, sharp focus"
   *   booru:   danbooru-style tags — "score_9, score_8_up, 1girl, masterpiece"
   */
  promptStyle:       'natural' | 'tags' | 'booru';

  // ── SAYON brief ─────────────────────────────────────────
  /** Injected into SAYON's system prompt when this model is active.
   *  Tells SAYON how to write effective prompts for this specific model.
   *  Should be concise (2-4 sentences) and actionable. */
  sayonBrief:        string;

  // ── Capabilities ────────────────────────────────────────
  supportsNegative:  boolean;        // false for guidance-free distilled models (turbo cfg=0)
  supportsLoRA:      boolean;        // true for all SDXL, false for FLUX/Chroma in sd-cli
  maxDimension:      number;         // hard cap before quality degrades severely
  nativeDimension:   number;         // trained resolution — best quality at this size
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
    diffusionMb:      6525,
    encoderMb:        0,
    vaeMb:            95,
    estSecondsCuda:   12,
    estSecondsVulkan: 45,
    estSecondsCpu:    480,
    license:          'apache-2.0',
    licenseUrl:       'https://huggingface.co/black-forest-labs/FLUX.1-schnell/blob/main/LICENSE.md',
    profile: {
      defaultSteps: 4, defaultCfgScale: 1, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'euler', defaultNegative: '',
      promptStyle: 'natural',
      sayonBrief: 'FLUX.1-schnell is a 4-step distilled model from Black Forest Labs. Write natural prose prompts describing the scene. Negative prompts have no effect (guidance=3.5 is baked in). Keep prompts descriptive but not excessively long. This model is fast but superseded by Chroma and FLUX.2 for quality.',
      supportsNegative: false, supportsLoRA: false, maxDimension: 2048, nativeDimension: 1024,
    },
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
    diffusionMb:      12400,
    encoderMb:        0,
    vaeMb:            95,
    estSecondsCuda:   15,
    estSecondsVulkan: 60,
    estSecondsCpu:    600,
    license:          'apache-2.0',
    licenseUrl:       'https://huggingface.co/black-forest-labs/FLUX.1-schnell/blob/main/LICENSE.md',
    profile: {
      defaultSteps: 4, defaultCfgScale: 1, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'euler', defaultNegative: '',
      promptStyle: 'natural',
      sayonBrief: 'FLUX.1-schnell Q8 is the higher-quality quantization of the 4-step distilled model. Write natural prose prompts. Negative prompts have no effect. Higher fidelity than Q4 but requires more VRAM.',
      supportsNegative: false, supportsLoRA: false, maxDimension: 2048, nativeDimension: 1024,
    },
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
    diffusionMb:      6525,
    encoderMb:        0,
    vaeMb:            95,
    estSecondsCuda:   90,
    estSecondsVulkan: 300,
    estSecondsCpu:    3600,
    license:          'FLUX-1-dev-Non-Commercial',
    licenseUrl:       'https://huggingface.co/black-forest-labs/FLUX.1-dev/blob/main/LICENSE.md',
    profile: {
      defaultSteps: 20, defaultCfgScale: 3.5, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'euler', defaultNegative: '',
      promptStyle: 'natural',
      sayonBrief: 'FLUX.1-dev is a high-quality 12B parameter model from Black Forest Labs. Use guidance=3.5 with 20-28 steps. Write detailed natural prose prompts — describe the subject, scene composition, lighting, and atmosphere in full sentences. Negative prompts are not effective. This model excels at text rendering and complex compositions.',
      supportsNegative: false, supportsLoRA: false, maxDimension: 2048, nativeDimension: 1024,
    },
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
    diffusionMb:      12400,
    encoderMb:        0,
    vaeMb:            95,
    estSecondsCuda:   110,
    estSecondsVulkan: 380,
    estSecondsCpu:    4200,
    license:          'FLUX-1-dev-Non-Commercial',
    licenseUrl:       'https://huggingface.co/black-forest-labs/FLUX.1-dev/blob/main/LICENSE.md',
    profile: {
      defaultSteps: 20, defaultCfgScale: 3.5, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'euler', defaultNegative: '',
      promptStyle: 'natural',
      sayonBrief: 'FLUX.1-dev Q8 is the highest fidelity FLUX.1 variant. Use guidance=3.5 with 20-28 steps. Write rich natural prose prompts. Best quality among FLUX.1 variants but requires 12+ GB VRAM and is slow. Ideal for final production renders.',
      supportsNegative: false, supportsLoRA: false, maxDimension: 2048, nativeDimension: 1024,
    },
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
    category:         'nsfw-artistic',
    variant:          'chroma',
    quantization:     'Q4_0',
    hfRepo:           'silveroxides/Chroma1-HD-GGUF',
    hfFile:           'Chroma1-HD-Q4_0.gguf',
    sizeBytes:        5_430_000_000,
    vramRequiredGb:   8,
    diffusionMb:      5225,
    encoderMb:        0,
    vaeMb:            95,
    estSecondsCuda:   14,
    estSecondsVulkan: 50,
    estSecondsCpu:    500,
    license:          'Apache-2.0',
    licenseUrl:       'https://huggingface.co/lodestones/Chroma/blob/main/LICENSE',
    profile: {
      defaultSteps: 20, defaultCfgScale: 0, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'euler', defaultNegative: '',
      promptStyle: 'natural',
      sayonBrief: 'Chroma is a FLUX-architecture model that uses guidance=0 (unconditional). Write natural prose prompts with vivid scene descriptions. Detail lighting, atmosphere, and composition. Negative prompts have no effect. Chroma excels at photorealism and cinematic scenes.',
      supportsNegative: false, supportsLoRA: false, maxDimension: 2048, nativeDimension: 1024,
    },
  },
];

// ── SDXL catalogue ────────────────────────────────────────────────────────────
// SDXL single-file safetensors: VAE, CLIP-L, CLIP-G all baked in. No aux files.
// sd-cli uses -m (auto-detects SDXL architecture from the safetensors).
// Each entry has a full profile: generation defaults, prompt style, SAYON brief, capabilities.

/** SDXL single-file models need NO aux files — empty array. */
export const SDXL_AUX_REQUIRED: FluxAuxFile[] = [];

export const SDXL_CATALOGUE: ImageModelSpec[] = [
  // ── Fast / Turbo (1-6 steps) ────────────────────────────────────────────
  {
    modelId:          'sdxl-turbo-fp16',
    label:            'SDXL Turbo FP16',
    displayName:      'SDXL Turbo',
    runnerProfile:    'sdxl',
    category:         'realistic',
    variant:          'sdxl',
    quantization:     'f16',
    hfRepo:           'stabilityai/sdxl-turbo',
    hfFile:           'sd_xl_turbo_1.0_fp16.safetensors',
    sizeBytes:        6_940_000_000,
    vramRequiredGb:   6,
    diffusionMb:      3400,
    encoderMb:        0,
    vaeMb:            0,
    estSecondsCuda:   3,
    estSecondsVulkan: 12,
    estSecondsCpu:    60,
    license:          'sai-nc-community',
    licenseUrl:       'https://huggingface.co/stabilityai/sdxl-turbo/blob/main/LICENSE.md',
    profile: {
      defaultSteps: 4, defaultCfgScale: 1, defaultWidth: 512, defaultHeight: 512,
      defaultSampler: 'euler_a', defaultNegative: '',
      promptStyle: 'natural',
      sayonBrief: 'SDXL Turbo is a distilled model that generates in 1-4 steps. Use cfg-scale=1. Write short, clear natural language prompts. Negative prompts have minimal effect. Best at 512×512. Keep prompts concise — detail terms like "8k" add noise at low step counts.',
      supportsNegative: false, supportsLoRA: true, maxDimension: 1024, nativeDimension: 512,
    },
  },
  {
    modelId:          'dreamshaper-xl-turbo-v2',
    label:            'DreamShaper XL Turbo V2.1',
    displayName:      'DreamShaper XL Turbo',
    runnerProfile:    'sdxl',
    category:         'realistic',
    variant:          'sdxl',
    quantization:     'f16',
    hfRepo:           'Lykon/dreamshaper-xl-v2-turbo',
    hfFile:           'DreamShaperXL_Turbo_v2_1.safetensors',
    sizeBytes:        6_940_000_000,
    vramRequiredGb:   6,
    diffusionMb:      3400,
    encoderMb:        0,
    vaeMb:            0,
    estSecondsCuda:   4,
    estSecondsVulkan: 15,
    estSecondsCpu:    90,
    license:          'openrail++',
    licenseUrl:       'https://huggingface.co/Lykon/dreamshaper-xl-v2-turbo',
    profile: {
      defaultSteps: 6, defaultCfgScale: 2, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'dpm++2m', defaultNegative: '',
      promptStyle: 'natural',
      sayonBrief: 'DreamShaper XL Turbo is a fast artistic general-purpose model. Use cfg-scale=2 with 4-6 steps and DPM++ 2M sampler. Write natural language prompts. Good at both photorealism and stylized art. Negative prompts have minimal effect at low cfg. Works well at 1024×1024.',
      supportsNegative: false, supportsLoRA: true, maxDimension: 2048, nativeDimension: 1024,
    },
  },
  {
    modelId:          'realvisxl-v5-lightning',
    label:            'RealVisXL V5.0 Lightning FP16',
    displayName:      'RealVisXL V5 Lightning',
    runnerProfile:    'sdxl',
    category:         'realistic',
    variant:          'sdxl',
    quantization:     'f16',
    hfRepo:           'SG161222/RealVisXL_V5.0_Lightning',
    hfFile:           'RealVisXL_V5.0_Lightning_fp16.safetensors',
    sizeBytes:        6_940_000_000,
    vramRequiredGb:   6,
    diffusionMb:      3400,
    encoderMb:        0,
    vaeMb:            0,
    estSecondsCuda:   4,
    estSecondsVulkan: 15,
    estSecondsCpu:    90,
    license:          'openrail++',
    licenseUrl:       'https://huggingface.co/SG161222/RealVisXL_V5.0_Lightning',
    profile: {
      defaultSteps: 6, defaultCfgScale: 2, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'dpm++2m', defaultNegative: 'blurry, low quality, deformed, watermark',
      promptStyle: 'tags',
      sayonBrief: 'RealVisXL V5 Lightning is a photorealistic distilled model. Use cfg-scale=1.5-2.0 with 4-8 steps. Write comma-separated descriptive tags: subject, setting, lighting, quality terms (photorealistic, detailed, 8k). Use negative prompt for quality control. Excellent for portraits and product photography.',
      supportsNegative: true, supportsLoRA: true, maxDimension: 2048, nativeDimension: 1024,
    },
  },
  {
    modelId:          'juggernaut-xl-v9-lightning',
    label:            'Juggernaut XL V9 Lightning FP16',
    displayName:      'Juggernaut XL Lightning',
    runnerProfile:    'sdxl',
    category:         'realistic',
    variant:          'sdxl',
    quantization:     'f16',
    hfRepo:           'AiWise/Juggernaut-XL-V9-GE-RDPhoto2-Lightning_4S',
    hfFile:           'juggernautXL_v9Rdphoto2Lightning.safetensors',
    sizeBytes:        7_110_000_000,
    vramRequiredGb:   6,
    diffusionMb:      3500,
    encoderMb:        0,
    vaeMb:            0,
    estSecondsCuda:   4,
    estSecondsVulkan: 15,
    estSecondsCpu:    90,
    license:          'openrail++',
    licenseUrl:       'https://huggingface.co/RunDiffusion/Juggernaut-XL-v9',
    profile: {
      defaultSteps: 6, defaultCfgScale: 2, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'dpm++2m', defaultNegative: 'blurry, ugly, deformed, watermark',
      promptStyle: 'tags',
      sayonBrief: 'Juggernaut XL Lightning is a fast photorealistic model with strong skin detail and lighting. Use cfg-scale=1.5-2.0 with 4-6 steps. Write tag-style prompts: subject first, then environment, lighting, and quality modifiers. Excellent at human subjects, portraits, and cinematic scenes. Keep negative prompt short.',
      supportsNegative: true, supportsLoRA: true, maxDimension: 2048, nativeDimension: 1024,
    },
  },
  // ── Full quality (20-30 steps) ──────────────────────────────────────────
  {
    modelId:          'sdxl-base-fp16',
    label:            'SDXL Base 1.0 FP16',
    displayName:      'SDXL Base',
    runnerProfile:    'sdxl',
    category:         'realistic',
    variant:          'sdxl',
    quantization:     'f16',
    hfRepo:           'stabilityai/stable-diffusion-xl-base-1.0',
    hfFile:           'sd_xl_base_1.0.safetensors',
    sizeBytes:        6_940_000_000,
    vramRequiredGb:   8,
    diffusionMb:      3400,
    encoderMb:        0,
    vaeMb:            0,
    estSecondsCuda:   15,
    estSecondsVulkan: 60,
    estSecondsCpu:    600,
    license:          'openrail++',
    licenseUrl:       'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md',
    profile: {
      defaultSteps: 25, defaultCfgScale: 7, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'euler_a', defaultNegative: 'blurry, low quality, bad anatomy, watermark, text',
      promptStyle: 'tags',
      sayonBrief: 'SDXL Base is the official Stability AI foundation model. Use cfg-scale=7 with 20-30 steps. Write tag-style prompts: start with the subject, add style terms (photorealistic, digital art, anime), then quality terms (8k, detailed, sharp focus, studio lighting). Negative prompt is important — include quality defects and unwanted elements. Native resolution is 1024×1024.',
      supportsNegative: true, supportsLoRA: true, maxDimension: 2048, nativeDimension: 1024,
    },
  },
  {
    modelId:          'realvisxl-v5-fp16',
    label:            'RealVisXL V5.0 FP16',
    displayName:      'RealVisXL V5',
    runnerProfile:    'sdxl',
    category:         'realistic',
    variant:          'sdxl',
    quantization:     'f16',
    hfRepo:           'SG161222/RealVisXL_V5.0',
    hfFile:           'RealVisXL_V5.0_fp16.safetensors',
    sizeBytes:        6_940_000_000,
    vramRequiredGb:   8,
    diffusionMb:      3400,
    encoderMb:        0,
    vaeMb:            0,
    estSecondsCuda:   15,
    estSecondsVulkan: 60,
    estSecondsCpu:    600,
    license:          'openrail++',
    licenseUrl:       'https://huggingface.co/SG161222/RealVisXL_V5.0',
    profile: {
      defaultSteps: 25, defaultCfgScale: 7, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'dpm++2m', defaultScheduler: 'karras',
      defaultNegative: '(face asymmetry, eyes asymmetry, deformed eyes, open mouth), blurry, low quality, watermark',
      promptStyle: 'tags',
      sayonBrief: 'RealVisXL V5 is a top-tier photorealistic model. Use cfg-scale=7 with 25+ steps and DPM++ 2M Karras sampler. Write tag-style prompts focused on subject, lighting, and atmosphere. This model excels at human faces and skin — add detail terms like "detailed skin texture, pores, subsurface scattering". Negative prompt matters — include face/anatomy defects.',
      supportsNegative: true, supportsLoRA: true, maxDimension: 2048, nativeDimension: 1024,
    },
  },
  {
    modelId:          'juggernaut-xl-v9-fp16',
    label:            'Juggernaut XL V9 RunDiffusion FP16',
    displayName:      'Juggernaut XL V9',
    runnerProfile:    'sdxl',
    category:         'realistic',
    variant:          'sdxl',
    quantization:     'f16',
    hfRepo:           'RunDiffusion/Juggernaut-XL-v9',
    hfFile:           'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors',
    sizeBytes:        7_110_000_000,
    vramRequiredGb:   8,
    diffusionMb:      3500,
    encoderMb:        0,
    vaeMb:            0,
    estSecondsCuda:   15,
    estSecondsVulkan: 60,
    estSecondsCpu:    600,
    license:          'openrail++',
    licenseUrl:       'https://huggingface.co/RunDiffusion/Juggernaut-XL-v9',
    profile: {
      defaultSteps: 25, defaultCfgScale: 7, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'dpm++2m', defaultScheduler: 'karras',
      defaultNegative: 'blurry, ugly, deformed, bad anatomy, watermark, text, extra fingers',
      promptStyle: 'tags',
      sayonBrief: 'Juggernaut XL V9 is a premium photorealistic model with RunDiffusion Photo V2 enhancement. Use cfg-scale=5-7 with 25-30 steps. Write tag-style prompts: describe the subject clearly, then add environment and lighting. Start with no negative prompt, then add specifics for things you do not want. Strong at photographic scenes, portraits, and cinematic compositions.',
      supportsNegative: true, supportsLoRA: true, maxDimension: 2048, nativeDimension: 1024,
    },
  },
  {
    modelId:          'dreamshaper-xl-lightning',
    label:            'DreamShaper XL Lightning FP16',
    displayName:      'DreamShaper XL Lightning',
    runnerProfile:    'sdxl',
    category:         'realistic',
    variant:          'sdxl',
    quantization:     'f16',
    hfRepo:           'Lykon/dreamshaper-xl-v2-turbo',
    hfFile:           'DreamShaperXL_Turbo_V2-SFW.safetensors',
    sizeBytes:        6_940_000_000,
    vramRequiredGb:   8,
    diffusionMb:      3400,
    encoderMb:        0,
    vaeMb:            0,
    estSecondsCuda:   8,
    estSecondsVulkan: 30,
    estSecondsCpu:    300,
    license:          'openrail++',
    licenseUrl:       'https://huggingface.co/Lykon/dreamshaper-xl-v2-turbo',
    profile: {
      defaultSteps: 6, defaultCfgScale: 2, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'dpm++2m', defaultScheduler: 'karras',
      defaultNegative: 'blurry, low quality, watermark',
      promptStyle: 'natural',
      sayonBrief: 'DreamShaper XL Lightning is a versatile artistic model distilled for speed. Use cfg-scale=2 with 3-6 steps and DPM++ SDE Karras sampler. Write natural prose prompts. This model is a strong general-purpose generator — equally good at photos, art, anime, and fantasy. Short negative prompts are sufficient.',
      supportsNegative: true, supportsLoRA: true, maxDimension: 2048, nativeDimension: 1024,
    },
  },
  // ── Anime / Stylized (NSFW-capable) ─────────────────────────────────────
  {
    modelId:          'pony-diffusion-v6-xl',
    label:            'Pony Diffusion V6 XL FP16',
    displayName:      'Pony Diffusion V6 XL',
    runnerProfile:    'sdxl',
    category:         'nsfw-anime',
    variant:          'sdxl',
    quantization:     'f16',
    hfRepo:           'LyliaEngine/Pony_Diffusion_V6_XL',
    hfFile:           'ponyDiffusionV6XL_v6StartWithThisOne.safetensors',
    sizeBytes:        6_460_000_000,
    vramRequiredGb:   8,
    diffusionMb:      3200,
    encoderMb:        0,
    vaeMb:            0,
    estSecondsCuda:   15,
    estSecondsVulkan: 60,
    estSecondsCpu:    600,
    license:          'openrail++',
    licenseUrl:       'https://civitai.com/models/257749/pony-diffusion-v6-xl',
    profile: {
      defaultSteps: 25, defaultCfgScale: 7, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'euler_a',
      defaultNegative: 'score_4, score_3, score_2, score_1, blurry, low quality, watermark, text',
      promptStyle: 'booru',
      sayonBrief: 'Pony Diffusion V6 XL uses booru-style tags (danbooru format). Always start prompts with quality tags: "score_9, score_8_up, score_7_up". Then add subject tags, style tags, and content tags separated by commas. Use underscores within multi-word tags (e.g. "long_hair" not "long hair"). Negative prompt should include low quality score tags. This model is trained on western art and anime — specify "source_anime" or "source_cartoon" for style control.',
      supportsNegative: true, supportsLoRA: true, maxDimension: 2048, nativeDimension: 1024,
    },
  },
  // ── NSFW Realistic ─────────────────────────────────────────────────────
  {
    modelId:          'pony-realism-v21',
    label:            'Pony Realism V2.1 FP16',
    displayName:      'Pony Realism V2.1',
    runnerProfile:    'sdxl',
    category:         'nsfw-realistic',
    variant:          'pony',
    quantization:     'f16',
    hfRepo:           'LyliaEngine/ponyRealism_v21MainVAE',
    hfFile:           'ponyRealism_v21MainVAE.safetensors',
    sizeBytes:        7_110_000_000,
    vramRequiredGb:   8,
    diffusionMb:      3500,
    encoderMb:        0,
    vaeMb:            0,
    estSecondsCuda:   15,
    estSecondsVulkan: 60,
    estSecondsCpu:    600,
    license:          'cdla-permissive-2.0',
    licenseUrl:       'https://civitai.com/models/372465/pony-realism',
    profile: {
      defaultSteps: 25, defaultCfgScale: 7, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'dpm++2m', defaultScheduler: 'karras',
      defaultNegative: 'score_4, score_3, score_2, score_1, blurry, low quality, watermark, text, 3d, cartoon, anime',
      promptStyle: 'booru',
      sayonBrief: 'Pony Realism V2.1 is a photorealistic model built on the Pony Diffusion V6 XL base. Uses booru-style tags. Start with quality tags: "score_9, score_8_up, score_7_up". Add subject description, lighting, and camera tags. Use DPM++ 2M Karras sampler at cfg-scale 7 for best results. Excellent skin detail, lighting, and anatomical accuracy. Negative prompts should include low score tags plus "3d, cartoon, anime" for photorealism.',
      supportsNegative: true, supportsLoRA: true, maxDimension: 2048, nativeDimension: 1024,
    },
  },
  // ── CivitAI NSFW Realistic (requires CivitAI API token) ────────────────
  {
    modelId:          'lustify-v6-olt',
    label:            'Lustify V6 OLT (Fixed Textures)',
    displayName:      'Lustify V6 OLT',
    runnerProfile:    'sdxl',
    category:         'civitai',
    variant:          'sdxl',
    quantization:     'f16',
    hfRepo:           '',
    hfFile:           '',
    sizeBytes:        6_460_000_000,
    civitaiVersionId: 1569593,
    civitaiFilename:  'lustifySDXLNSFW_oltFIXEDTEXTURES.safetensors',
    vramRequiredGb:   8,
    diffusionMb:      3400,
    encoderMb:        0,
    vaeMb:            0,
    estSecondsCuda:   15,
    estSecondsVulkan: 60,
    estSecondsCpu:    600,
    license:          'CDLA-Permissive-2.0',
    licenseUrl:       'https://civitai.com/models/573152?modelVersionId=1569593',
    profile: {
      defaultSteps: 25, defaultCfgScale: 7, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'dpm++2m', defaultScheduler: 'karras',
      defaultNegative: 'low quality, blurry, bad anatomy, extra fingers, ugly, deformed, watermark, text, 3d, cartoon',
      promptStyle: 'natural',
      sayonBrief: 'Lustify V6 OLT is a top-tier photorealistic NSFW SDXL checkpoint. Supports both natural language and booru tags. Camera type tags have strong impact: "shot on Canon EOS 5D", "shot on Polaroid SX-70". Lighting tags: "cinematic lighting", "warm golden hour lighting". Style tags: "glamour photography", "amateur photo". Use DPM++ 2M Karras at cfg-scale 7. This model has a strong NSFW bias — use "amateur photo" or remove it for SFW.',
      supportsNegative: true, supportsLoRA: true, maxDimension: 2048, nativeDimension: 1024,
    },
  },
  {
    modelId:          'bigasp-v2',
    label:            'BigASP V2 FP16',
    displayName:      'BigASP V2',
    runnerProfile:    'sdxl',
    category:         'civitai',
    variant:          'sdxl',
    quantization:     'f16',
    hfRepo:           '',
    hfFile:           '',
    sizeBytes:        6_940_000_000,
    civitaiVersionId: 991916,
    civitaiFilename:  'bigASP_v2.safetensors',
    vramRequiredGb:   8,
    diffusionMb:      3400,
    encoderMb:        0,
    vaeMb:            0,
    estSecondsCuda:   15,
    estSecondsVulkan: 60,
    estSecondsCpu:    600,
    license:          'Apache-2.0',
    licenseUrl:       'https://civitai.com/models/502468?modelVersionId=991916',
    profile: {
      defaultSteps: 25, defaultCfgScale: 7, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'euler_a', defaultNegative: 'low quality, worst quality, blurry, bad anatomy, watermark, text',
      promptStyle: 'natural',
      sayonBrief: 'BigASP V2 is a photorealistic SDXL model trained on 6+ million high-quality captioned photos. Understands both short and detailed natural language prompts. Excellent broad concept coverage. Strong anatomy and lighting. Use Euler A or DPM++ 2M at cfg-scale 7. Very flexible — works well with both simple and detailed prompts.',
      supportsNegative: true, supportsLoRA: true, maxDimension: 2048, nativeDimension: 1024,
    },
  },
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
    category:         'kontext',
    variant:          'kontext',
    quantization:     'Q5_K_S',
    hfRepo:           'QuantStack/FLUX.1-Kontext-dev-GGUF',
    hfFile:           'flux1-kontext-dev-Q5_K_S.gguf',
    sizeBytes:        8_280_000_000,
    vramRequiredGb:   12,
    diffusionMb:      7900,
    encoderMb:        0,
    vaeMb:            95,
    estSecondsCuda:   60,
    estSecondsVulkan: 240,
    estSecondsCpu:    2400,
    license:          'FLUX-1-dev-Non-Commercial',
    licenseUrl:       'https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev/blob/main/LICENSE.md',
    profile: {
      defaultSteps: 28, defaultCfgScale: 1, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'euler', defaultNegative: '',
      promptStyle: 'natural',
      sayonBrief: 'FLUX Kontext is a prompt-based image editor. It takes a reference image and applies edits described in the prompt. Write editing instructions as natural prose: "make the cat blue", "change the background to a beach", "add sunglasses to the person". Be specific about what to change and what to preserve. This model does NOT generate from scratch — it always needs a reference image.',
      supportsNegative: false, supportsLoRA: false, maxDimension: 2048, nativeDimension: 1024,
    },
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
    vramRequiredGb:   7,
    diffusionMb:      2484,
    encoderMb:        3555,
    vaeMb:            164,
    estSecondsCuda:   12,
    estSecondsVulkan: 50,
    estSecondsCpu:    480,
    license:          'Apache-2.0',
    licenseUrl:       'https://huggingface.co/unsloth/FLUX.2-klein-4B-GGUF',
    profile: {
      defaultSteps: 4, defaultCfgScale: 1, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'euler', defaultNegative: '',
      promptStyle: 'natural',
      sayonBrief: 'FLUX.2-klein-4B is a fast 4-step model using an LLM text encoder (Qwen3-4B). Write natural prose prompts — the LLM encoder understands complex instructions better than CLIP. Good at text rendering and instruction following. Apache 2.0 license (commercial use OK). Flash attention enabled for speed.',
      supportsNegative: false, supportsLoRA: false, maxDimension: 2048, nativeDimension: 1024,
    },
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
    diffusionMb:      4800,
    encoderMb:        5200,
    vaeMb:            164,
    estSecondsCuda:   18,
    estSecondsVulkan: 70,
    estSecondsCpu:    660,
    license:          'FLUX-Non-Commercial',
    licenseUrl:       'https://huggingface.co/unsloth/FLUX.2-klein-9B-GGUF',
    profile: {
      defaultSteps: 4, defaultCfgScale: 1, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'euler', defaultNegative: '',
      promptStyle: 'natural',
      sayonBrief: 'FLUX.2-klein-9B is the higher-quality FLUX.2 variant with Qwen3-8B text encoder. Write detailed natural prose prompts — the larger LLM encoder handles nuanced instructions exceptionally well. Superior text rendering and composition compared to the 4B variant. Requires 16+ GB VRAM.',
      supportsNegative: false, supportsLoRA: false, maxDimension: 2048, nativeDimension: 1024,
    },
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
    diffusionMb:      3685,
    encoderMb:        3555,
    vaeMb:            95,
    estSecondsCuda:   8,
    estSecondsVulkan: 35,
    estSecondsCpu:    320,
    license:          'Apache-2.0',
    licenseUrl:       'https://huggingface.co/leejet/Z-Image-Turbo-GGUF',
    profile: {
      defaultSteps: 4, defaultCfgScale: 1, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'euler', defaultScheduler: 'discrete', defaultNegative: '',
      promptStyle: 'natural',
      sayonBrief: 'Z-Image Turbo is a fast 4-step Apache 2.0 model using Qwen3-4B as text encoder. Write natural prose prompts — the LLM encoder understands detailed descriptions well. Very fast generation with good quality. Negative prompts are not effective at low cfg. Commercial use permitted.',
      supportsNegative: false, supportsLoRA: false, maxDimension: 2048, nativeDimension: 1024,
    },
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
    diffusionMb:      5500,
    encoderMb:        3555,
    vaeMb:            95,
    estSecondsCuda:   35,
    estSecondsVulkan: 140,
    estSecondsCpu:    1400,
    license:          'Apache-2.0',
    licenseUrl:       'https://huggingface.co/unsloth/Z-Image-GGUF',
    profile: {
      defaultSteps: 20, defaultCfgScale: 1, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'euler', defaultScheduler: 'discrete', defaultNegative: '',
      promptStyle: 'natural',
      sayonBrief: 'Z-Image Base is a high-quality 20-step model using Qwen3-4B text encoder. Write detailed natural prose prompts — describe subject, composition, lighting, and mood. Longer prompts work well with the LLM encoder. Higher quality than Turbo variant but significantly slower. Apache 2.0 (commercial OK).',
      supportsNegative: false, supportsLoRA: false, maxDimension: 2048, nativeDimension: 1024,
    },
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
    diffusionMb:      2200,
    encoderMb:        4700,
    vaeMb:            164,
    estSecondsCuda:   70,
    estSecondsVulkan: 280,
    estSecondsCpu:    2800,
    license:          'Apache-2.0',
    licenseUrl:       'https://huggingface.co/unsloth/Qwen-Image-2512-GGUF',
    profile: {
      defaultSteps: 20, defaultCfgScale: 2.5, defaultWidth: 1024, defaultHeight: 1024,
      defaultSampler: 'euler', defaultNegative: '',
      promptStyle: 'natural',
      sayonBrief: 'Qwen-Image uses Qwen2.5-VL-7B as its text encoder — the best text rendering of any local model. Write detailed natural prose prompts. This model excels at generating images with readable text, signs, labels, and typography. Use --flow-shift 3 for optimal results. Also supports image editing via reference images (Qwen-Image-Edit variant).',
      supportsNegative: false, supportsLoRA: false, maxDimension: 2048, nativeDimension: 1024,
    },
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
    diffusionMb:      900,
    encoderMb:        0,
    vaeMb:            160,
    estSecondsCuda:   30,
    estSecondsVulkan: 120,
    estSecondsCpu:    600,
    license:          'Apache-2.0',
    licenseUrl:       'https://huggingface.co/samuelchristlie/Wan2.1-T2V-1.3B-GGUF',
    profile: {
      defaultSteps: 20, defaultCfgScale: 5, defaultWidth: 832, defaultHeight: 480,
      defaultSampler: 'euler', defaultScheduler: 'simple', defaultNegative: '',
      promptStyle: 'natural',
      sayonBrief: 'Wan 2.1 T2V 1.3B is a lightweight text-to-video model. Write natural prose describing the scene and motion: "a cat jumping from a table to the floor, slow motion". Describe what moves and how. Default resolution is 832×480 (landscape 480P). This is the fastest Wan model — good for quick video drafts. 49 frames at 12fps = 4 seconds of video.',
      supportsNegative: false, supportsLoRA: false, maxDimension: 1280, nativeDimension: 480,
    },
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
    diffusionMb:      9600,
    encoderMb:        0,
    vaeMb:            160,
    estSecondsCuda:   180,
    estSecondsVulkan: 720,
    estSecondsCpu:    3600,
    license:          'Apache-2.0',
    licenseUrl:       'https://huggingface.co/city96/Wan2.1-T2V-14B-gguf',
    profile: {
      defaultSteps: 20, defaultCfgScale: 5, defaultWidth: 832, defaultHeight: 480,
      defaultSampler: 'euler', defaultScheduler: 'simple', defaultNegative: '',
      promptStyle: 'natural',
      sayonBrief: 'Wan 2.1 T2V 14B is a high-quality text-to-video model. Write detailed natural prose describing the scene, camera movement, and subject motion: "drone shot flying over a coastal city at sunset, waves crashing on rocks below". Be specific about motion dynamics. Produces 49 frames at 12fps (4 seconds). Higher quality than 1.3B but requires 16+ GB VRAM and takes several minutes.',
      supportsNegative: false, supportsLoRA: false, maxDimension: 1280, nativeDimension: 480,
    },
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
    diffusionMb:      9600,
    encoderMb:        0,
    vaeMb:            160,
    estSecondsCuda:   180,
    estSecondsVulkan: 720,
    estSecondsCpu:    3600,
    license:          'Apache-2.0',
    licenseUrl:       'https://huggingface.co/city96/Wan2.1-I2V-14B-480P-gguf',
    profile: {
      defaultSteps: 20, defaultCfgScale: 5, defaultWidth: 832, defaultHeight: 480,
      defaultSampler: 'euler', defaultScheduler: 'simple', defaultNegative: '',
      promptStyle: 'natural',
      sayonBrief: 'Wan 2.1 I2V (image-to-video) animates a still image into video. Write a prompt describing the desired motion: "the woman turns her head and smiles", "the waterfall begins to flow". The input image provides the visual content — the prompt controls only the motion and animation. Keep prompts focused on action and movement, not appearance.',
      supportsNegative: false, supportsLoRA: false, maxDimension: 1280, nativeDimension: 480,
    },
  },
  // ── Wan 2.2 ───────────────────────────────────────────────────────────────
  // Same architecture and aux files as 2.1 (WAN_VAE + WAN_T5_Q5 + same runner).
  // Improved motion quality and prompt adherence over 2.1. Apache 2.0.
  {
    modelId:          'wan22-t2v-14b-q4',
    label:            'Wan 2.2 T2V 14B Q4',
    displayName:      'Wan 2.2 T2V 14B',
    runnerProfile:    'wan',
    category:         'video',
    variant:          'wan',
    quantization:     'Q4_K_M',
    hfRepo:           'QuantStack/Wan2.2-T2V-A14B-GGUF',
    hfFile:           'LowNoise/Wan2.2-T2V-A14B-LowNoise-Q4_K_M.gguf',
    sizeBytes:        9_650_000_000,
    highNoiseHfFile:  'HighNoise/Wan2.2-T2V-A14B-HighNoise-Q4_K_M.gguf',
    highNoiseSizeBytes: 9_650_000_000,
    vramRequiredGb:   16,
    diffusionMb:      9600,
    encoderMb:        0,
    vaeMb:            160,
    estSecondsCuda:   180,
    estSecondsVulkan: 720,
    estSecondsCpu:    3600,
    license:          'Apache-2.0',
    licenseUrl:       'https://huggingface.co/QuantStack/Wan2.2-T2V-A14B-GGUF',
    profile: {
      defaultSteps: 10, defaultCfgScale: 3.5, defaultWidth: 832, defaultHeight: 480,
      defaultSampler: 'euler', defaultScheduler: 'simple', defaultNegative: '',
      promptStyle: 'natural',
      sayonBrief: 'Wan 2.2 T2V 14B is the latest text-to-video model with improved motion quality and prompt adherence over Wan 2.1. Write detailed natural prose describing scene dynamics and camera work. This version handles complex multi-subject motion better. Same VRAM requirements and resolution as 2.1 (832×480, 49 frames). Prefer this over 2.1 when available.',
      supportsNegative: true, supportsLoRA: false, maxDimension: 1280, nativeDimension: 480,
    },
  },
  // ── Wan 2.2 I2V (image-to-video) ───────────────────────────────────────
  // Same MoE architecture as T2V. Extra aux file: CLIP Vision encoder for I2V.
  // Input image via --init-img, prompt describes desired motion only.
  {
    modelId:          'wan22-i2v-14b-q4',
    label:            'Wan 2.2 I2V 14B Q4',
    displayName:      'Wan 2.2 I2V 14B',
    runnerProfile:    'wan',
    category:         'video',
    variant:          'wan',
    quantization:     'Q4_K_M',
    hfRepo:           'QuantStack/Wan2.2-I2V-A14B-GGUF',
    hfFile:           'LowNoise/Wan2.2-I2V-A14B-LowNoise-Q4_K_M.gguf',
    sizeBytes:        9_650_000_000,
    highNoiseHfFile:  'HighNoise/Wan2.2-I2V-A14B-HighNoise-Q4_K_M.gguf',
    highNoiseSizeBytes: 9_650_000_000,
    vramRequiredGb:   16,
    diffusionMb:      9600,
    encoderMb:        0,
    vaeMb:            160,
    estSecondsCuda:   180,
    estSecondsVulkan: 720,
    estSecondsCpu:    3600,
    license:          'Apache-2.0',
    licenseUrl:       'https://huggingface.co/QuantStack/Wan2.2-I2V-A14B-GGUF',
    profile: {
      defaultSteps: 10, defaultCfgScale: 3.5, defaultWidth: 832, defaultHeight: 480,
      defaultSampler: 'euler', defaultScheduler: 'simple', defaultNegative: '',
      promptStyle: 'natural',
      sayonBrief: 'Wan 2.2 I2V (image-to-video) animates a still image into video using MoE architecture. Write a prompt describing the desired motion only — the input image provides visual content. Examples: "the woman turns her head and smiles", "the waterfall begins to flow, camera slowly zooms in". Keep prompts focused on action and movement, not appearance. Same resolution (832×480) and frame count (49 frames) as T2V.',
      supportsNegative: true, supportsLoRA: false, maxDimension: 1280, nativeDimension: 480,
    },
  },
];

/** Combined catalogue — all image and video models across all runner profiles */
export const IMAGE_MODEL_CATALOGUE: ImageModelSpec[] = [
  ...CHROMA_CATALOGUE,
  ...ZIMAGE_CATALOGUE,
  ...SDXL_CATALOGUE,
  ...FLUX2_CATALOGUE,
  ...KONTEXT_CATALOGUE,
  ...QWEN_IMAGE_CATALOGUE,
  ...WAN_CATALOGUE,
  ...FLUX_CATALOGUE,           // schnell entries are now category:'legacy'
];

export function getImageModelSpec(modelId: string): ImageModelSpec | undefined {
  return IMAGE_MODEL_CATALOGUE.find(s => s.modelId === modelId);
}

export function isImageModelDownloaded(spec: ImageModelSpec): boolean {
  const p = fluxModelPath(spec);
  if (!fs.existsSync(p)) return false;
  if (fs.statSync(p).size < spec.sizeBytes * 0.9) return false;
  // MoE dual-model: both GGUFs must be present
  if (spec.highNoiseHfFile) {
    const hp = highNoiseModelPath(spec);
    if (!hp || !fs.existsSync(hp)) return false;
    if (fs.statSync(hp).size < (spec.highNoiseSizeBytes ?? spec.sizeBytes) * 0.9) return false;
  }
  return true;
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
  // CivitAI models use civitaiFilename in SDXL dir (all CivitAI models are SDXL safetensors)
  if (spec.civitaiVersionId && spec.civitaiFilename) return path.join(IMAGE_SDXL_DIR, spec.civitaiFilename);
  if (spec.runnerProfile === 'sdxl') return path.join(IMAGE_SDXL_DIR, spec.hfFile);
  if (spec.runnerProfile === 'wan')  return path.join(IMAGE_WAN_DIR,  spec.hfFile);
  return path.join(IMAGE_FLUX_DIR, spec.hfFile);
}

/** Resolve the HighNoise expert GGUF path for MoE models. Returns null for non-MoE specs. */
export function highNoiseModelPath(spec: FluxSpec): string | null {
  if (!spec.highNoiseHfFile) return null;
  if (spec.runnerProfile === 'wan') return path.join(IMAGE_WAN_DIR, spec.highNoiseHfFile);
  return path.join(IMAGE_FLUX_DIR, spec.highNoiseHfFile);
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

// ── VRAM tolerance ──────────────────────────────────────────────────────────
// GPUs report physical VRAM but ~1 GB is consumed by the driver and OS.
// e.g. RTX 5080: 16 GB physical → ~15 GB usable. sd-cli manages memory
// mapping and can run models whose vramRequiredGb slightly exceeds usable VRAM.
// This tolerance prevents recommendation functions from excluding models
// that genuinely run fine on the hardware.
const IMAGE_VRAM_TOLERANCE_GB = 1;

/**
 * Returns the best downloaded FLUX model for the given VRAM budget.
 * Preference order: schnell Q8 → schnell Q4 → dev Q8 → dev Q4.
 * Returns null if nothing downloaded fits or VRAM < 8 GB.
 */
export function recommendFluxModel(vramGb: number): FluxSpec | null {
  const preference = ['flux-schnell-q8', 'flux-schnell-q4', 'flux-dev-q8', 'flux-dev-q4'];
  for (const id of preference) {
    const spec = getFluxSpec(id);
    if (spec && isFluxDownloaded(spec) && spec.vramRequiredGb <= vramGb + IMAGE_VRAM_TOLERANCE_GB) return spec;
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
export function recommendImageModel(
  vramGb: number,
  isUnifiedMemory = false,
  sdBinary: 'cuda' | 'vulkan' | 'rocm' | 'cpu' = 'vulkan',
): ImageModelSpec | null {
  // Preference order: FLUX.2 Klein 4B (best default — fast, high quality, works everywhere) →
  // Z-Image Turbo (fastest) → Chroma (best quality, slow) → SDXL → rest.
  // FLUX.2 Klein 9B and Qwen-Image are deprioritized because their large LLM
  // encoders (Qwen3-8B, Qwen2.5-VL-7B) exceed Vulkan's per-buffer allocation
  // limit on many AMD and Intel GPUs, causing OOM even with plenty of total VRAM.
  const ordered = [
    ...FLUX2_CATALOGUE.filter(m => m.modelId.includes('4b')),
    ...ZIMAGE_CATALOGUE.filter(m => m.modelId.includes('turbo')),
    ...CHROMA_CATALOGUE,
    ...ZIMAGE_CATALOGUE.filter(m => !m.modelId.includes('turbo')),
    ...SDXL_CATALOGUE,
    ...FLUX2_CATALOGUE.filter(m => m.modelId.includes('9b')),
    ...KONTEXT_CATALOGUE,
    ...QWEN_IMAGE_CATALOGUE,
    ...FLUX_CATALOGUE.filter(m => m.variant !== 'schnell'),
  ];

  // Vulkan per-buffer allocation limit: AMD/Intel Vulkan drivers often cap
  // individual buffer allocations at ~2 GB even if total VRAM is 16+ GB.
  // Models with LLM encoders >2 GB (FLUX.2 Klein 9B, Qwen-Image) silently
  // fail to allocate on Vulkan. Skip them unless on CUDA/ROCm.
  const vulkanLargeEncoderModels = new Set([
    'flux2-klein-9b-q4',   // Qwen3-8B encoder: 2.49 GB single buffer
    'qwen-image-q4',       // Qwen2.5-VL-7B encoder: 2.18 GB single buffer
  ]);
  const isVulkan = sdBinary === 'vulkan';

  if (isUnifiedMemory) {
    return ordered.find(m => {
      if (isVulkan && vulkanLargeEncoderModels.has(m.modelId)) return false;
      return isImageModelDownloaded(m);
    }) ?? null;
  }
  // With --offload-to-cpu, only the largest single component needs to fit in VRAM
  // at any given time: text_encoder → run → free, diffusion → run → free, VAE → run → free.
  // Use max(diffusionMb, encoderMb, vaeMb) converted to GB as the VRAM requirement.
  return ordered.find(m => {
    if (isVulkan && vulkanLargeEncoderModels.has(m.modelId)) return false;
    const peakGb = Math.max(m.diffusionMb, m.encoderMb, m.vaeMb) / 1024;
    return peakGb <= vramGb + IMAGE_VRAM_TOLERANCE_GB && isImageModelDownloaded(m);
  }) ?? null;
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
  // Unified memory (AMD APU, Apple Silicon): RAM IS VRAM. The T5 encoder
  // lives in the same pool regardless of --offload-to-cpu, so we can use
  // the largest tier that fits. Only fall back to Q3 if total RAM is very low.
  if (isUnifiedMemory) {
    if (totalVramGb >= 16) return FLUX_T5_Q8;  // 16+ GB unified → Q8
    return FLUX_T5_Q3;                          // <16 GB → Q3 (tight budget)
  }

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

/**
 * Returns the set of T5 encoders needed across ALL GPUs in the system.
 *
 * Different GPUs have different VRAM budgets, so different T5 quant levels
 * may be optimal for each. This function returns ALL distinct T5 files that
 * any GPU in the system could use for the given model, deduplicated by id.
 *
 * Used by the download system to ensure all necessary T5 files are present
 * regardless of which GPU is targeted at generation time.
 */
export function recommendT5EncodersForAllGpus(
  fluxSpec: FluxSpec,
  gpus: Array<{ vramGb: number; unifiedMemory?: boolean; backend?: string }>,
): FluxAuxFile[] {
  if (gpus.length === 0) return [FLUX_T5_Q3]; // no GPU info — download smallest

  const seen = new Set<string>();
  const result: FluxAuxFile[] = [];

  for (const gpu of gpus) {
    const isUnified = gpu.unifiedMemory === true;
    const t5 = recommendT5Encoder(fluxSpec, gpu.vramGb, isUnified);
    if (!seen.has(t5.id)) {
      seen.add(t5.id);
      result.push(t5);
    }
  }

  return result;
}

export function deleteFluxModel(modelId: string): boolean {
  const spec = getFluxSpec(modelId);
  if (!spec) return false;
  const p = fluxModelPath(spec);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  // MoE dual-model: also delete the HighNoise expert
  const hn = highNoiseModelPath(spec);
  if (hn && fs.existsSync(hn)) { try { fs.unlinkSync(hn); } catch { /* ignore */ } }
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
  // MoE HighNoise temp file
  const hn = highNoiseModelPath(spec);
  if (hn) { const hnTmp = hn + '.download'; try { if (fs.existsSync(hnTmp)) fs.unlinkSync(hnTmp); } catch { /* ignore */ } }
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

// ── Model recommendation — scoring-based ─────────────────────────────────────

export interface ModelRecommendation {
  sayon: GGUFSpec;
  seren: GGUFSpec;
  sayonDevice: 'cpu' | number;
  serenDevice: 'cpu' | number;
  sayonGpuLayers: number;
  serenGpuLayers: number;
  /** Recommended image model (null = no image models in catalogue fit) */
  imageModel: ImageModelSpec | null;
  /** Recommended video model (null = no video models fit) */
  videoModel: ImageModelSpec | null;
  /** True if ESRGAN x4plus is recommended (always true when any image model is recommended) */
  upscaleRecommended: boolean;
  reasoning: string;
  /** Scoring details for debugging / frontend display */
  sayonScore: number;
  serenScore: number;
}

/**
 * Estimated tok/s for a model on a given compute class.
 * Derived from activeParamsB — smaller active params = faster inference.
 *
 * Compute classes:
 *   'cuda-high'  — CUDA discrete ≥8 GB (RTX 3080+)
 *   'cuda-low'   — CUDA discrete <8 GB (GTX 1070, Quadro M2000)
 *   'vulkan'     — AMD/Intel Vulkan discrete
 *   'metal'      — Apple Silicon Metal
 *   'cpu'        — CPU-only
 *
 * The constants are rough empirical baselines from llama-server benchmarks.
 * The formula: baseTokS / (activeParamsB / baseParamsB)
 * where baseTokS is the measured tok/s for a 4B dense model on that compute class.
 */
type ComputeClass = 'cuda-high' | 'cuda-low' | 'vulkan' | 'metal' | 'cpu';

const BASE_TOKS: Record<ComputeClass, number> = {
  'cuda-high': 60,   // ~60 tok/s for 4B Q4 on RTX 3080
  'cuda-low':  35,   // ~35 tok/s for 4B Q4 on GTX 1070
  'vulkan':    25,   // ~25 tok/s for 4B Q4 on AMD discrete Vulkan
  'metal':     45,   // ~45 tok/s for 4B Q4 on M4 Pro Metal
  'cpu':       8,    // ~8 tok/s for 4B Q4 on CPU (16-core)
};
const BASE_PARAMS_B = 4.0;

function estimateTokS(activeParamsB: number, compute: ComputeClass): number {
  return BASE_TOKS[compute] * (BASE_PARAMS_B / activeParamsB);
}

function computeClassFromDevice(gpu: GpuDevice | null, isGpu: boolean): ComputeClass {
  if (!isGpu || !gpu) return 'cpu';
  if (gpu.backend === 'metal') return 'metal';
  if (gpu.backend === 'cuda') return gpu.vramGb >= 8 ? 'cuda-high' : 'cuda-low';
  return 'vulkan';
}

// Target tok/s thresholds — models scoring below these are penalized.
// SAYON needs to be snappy (coordinator); SEREN can be slower (deep reasoning).
const SAYON_TARGET_TOKS = 15;
const SEREN_TARGET_TOKS = 8;

/**
 * Score a model for a specific role on a specific device.
 *
 *   score = qualityTier × min(1.0, estimatedTokS / targetTokS)
 *
 * Higher score = better fit. A quality-5 model that can't meet the speed target
 * gets penalized proportionally. A quality-3 model that exceeds the target
 * doesn't get bonus — quality is the ceiling once speed is met.
 */
function scoreLlm(
  spec: GGUFSpec,
  role: 'sayon' | 'seren',
  compute: ComputeClass,
): number {
  const quality = role === 'sayon' ? (spec.sayonQuality ?? 0) : (spec.serenQuality ?? 0);
  if (quality === 0) return 0; // model has no quality rating for this role

  const targetTokS = role === 'sayon' ? SAYON_TARGET_TOKS : SEREN_TARGET_TOKS;
  const estTokS    = estimateTokS(spec.activeParamsB, compute);
  const speedFactor = Math.min(1.0, estTokS / targetTokS);

  return quality * speedFactor;
}

/**
 * Pick the best model for a role from a candidate pool within a memory budget.
 * Returns null if no candidate fits.
 */
function pickBestScored(
  candidates: GGUFSpec[],
  role: 'sayon' | 'seren',
  budgetGb: number,
  compute: ComputeClass,
): { spec: GGUFSpec; score: number } | null {
  let best: { spec: GGUFSpec; score: number } | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const spec = candidates[i];
    if (spec.ramRequiredGb > budgetGb) continue;
    // SEREN must support thinking tokens
    if (role === 'seren' && !spec.thinkingTokens) continue;
    const score = scoreLlm(spec, role, compute);
    if (score === 0) continue;
    if (!best || score > best.score ||
        (score === best.score && spec.sizeBytes > best.spec.sizeBytes)) {
      // Tiebreaker: equal score → prefer larger model (more total knowledge).
      // Nemotron 30B-A3B (22.8 GB, 3.2B active) beats Qwen3.5 9B (5.5 GB, 9B active)
      // when both score identically — the 30B model has far more knowledge despite
      // similar throughput from its MoE architecture.
      best = { spec, score };
    }
  }
  return best;
}

/**
 * Recommend the best image model for the hardware.
 * Prefers fastest generation (lowest estSecondsCuda) among downloaded models.
 * If no models are downloaded, recommends the best from the full catalogue for auto-config.
 */
function recommendOptionalImageModel(
  vramGb: number,
  isUnifiedMemory: boolean,
  downloadedOnly: boolean,
): ImageModelSpec | null {
  // Speed-ordered preference: z-image-turbo → flux2-klein-4b → chroma → z-image-base → others
  // Exclude video, legacy, and kontext (editing-only) from primary recommendation
  const pool = IMAGE_MODEL_CATALOGUE.filter(m =>
    m.category !== 'video' && m.category !== 'legacy' && m.category !== 'kontext'
  );
  const candidates = downloadedOnly ? pool.filter(isImageModelDownloaded) : pool;
  if (candidates.length === 0) return null;

  // Filter by VRAM (unified memory can offload, so no VRAM gate)
  const fitting = isUnifiedMemory
    ? candidates
    : candidates.filter(m => m.vramRequiredGb <= vramGb + IMAGE_VRAM_TOLERANCE_GB);
  if (fitting.length === 0) return null;

  // Sort by estimated CUDA speed (fastest first), then by VRAM requirement (smallest first)
  fitting.sort((a, b) => a.estSecondsCuda - b.estSecondsCuda || a.vramRequiredGb - b.vramRequiredGb);
  return fitting[0];
}

/**
 * Recommend the best video model for the hardware.
 */
function recommendOptionalVideoModel(
  vramGb: number,
  isUnifiedMemory: boolean,
  downloadedOnly: boolean,
): ImageModelSpec | null {
  const pool = IMAGE_MODEL_CATALOGUE.filter(m => m.category === 'video');
  const candidates = downloadedOnly ? pool.filter(isImageModelDownloaded) : pool;
  if (candidates.length === 0) return null;

  const fitting = isUnifiedMemory
    ? candidates
    : candidates.filter(m => m.vramRequiredGb <= vramGb + IMAGE_VRAM_TOLERANCE_GB);
  if (fitting.length === 0) return null;

  // Prefer smallest (fastest) video model
  fitting.sort((a, b) => a.estSecondsCuda - b.estSecondsCuda || a.vramRequiredGb - b.vramRequiredGb);
  return fitting[0];
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
  let sayonScore = 0;
  let serenScore = 0;

  // Determine VRAM available for image generation (max GPU, after LLM servers stop)
  let imageVramGb = bestGpu?.vramGb ?? 0;

  if (hasUnifiedMemory && bestGpu) {
    // ── Unified memory: both models share one pool ──
    const pool        = Math.floor(hw.ramGb * HEADROOM);
    const serenBudget = Math.floor(pool * 0.75);
    const sayonBudget = Math.floor(pool * 0.35);
    const compute     = computeClassFromDevice(bestGpu, true);

    const serenPick = pickBestScored(GGUF_CATALOGUE, 'seren', serenBudget, compute);
    const sayonPick = pickBestScored(GGUF_CATALOGUE, 'sayon', sayonBudget, compute);

    seren          = serenPick?.spec ?? GGUF_CATALOGUE.find(s => s.thinkingTokens)!;
    sayon          = sayonPick?.spec ?? GGUF_CATALOGUE[0];
    serenScore     = serenPick?.score ?? 0;
    sayonScore     = sayonPick?.score ?? 0;
    serenDevice    = bestGpu.index;
    sayonDevice    = bestGpu.index;
    serenGpuLayers = 99;
    sayonGpuLayers = 99;
    imageVramGb    = hw.ramGb;  // unified memory: full RAM pool for image gen

  } else if (bestGpu && bestGpu.vramGb >= 3) {
    // ── Discrete GPU with ≥3 GB ──
    const discreteHeadroom = (bestGpu.vramGb >= 8 && !bestGpu.unifiedMemory) ? 0.90 : HEADROOM;
    const serenBudget = Math.floor(bestGpu.vramGb * discreteHeadroom);
    const serenCompute = computeClassFromDevice(bestGpu, true);

    const serenPick = pickBestScored(GGUF_CATALOGUE, 'seren', serenBudget, serenCompute);
    seren          = serenPick?.spec ?? GGUF_CATALOGUE.find(s => s.thinkingTokens)!;
    serenScore     = serenPick?.score ?? 0;
    serenDevice    = bestGpu.index;
    serenGpuLayers = 99;

    if (secondGpu && secondGpu.vramGb >= 2 && !secondGpu.unifiedMemory) {
      const sayonCompute = computeClassFromDevice(secondGpu, true);
      const sayonPick = pickBestScored(GGUF_CATALOGUE, 'sayon', Math.floor(secondGpu.vramGb * HEADROOM), sayonCompute);
      sayon          = sayonPick?.spec ?? GGUF_CATALOGUE[0];
      sayonScore     = sayonPick?.score ?? 0;
      sayonDevice    = secondGpu.index;
      sayonGpuLayers = 99;
    } else {
      const sayonPick = pickBestScored(GGUF_CATALOGUE, 'sayon', Math.floor(hw.ramGb * HEADROOM), 'cpu');
      sayon          = sayonPick?.spec ?? GGUF_CATALOGUE[0];
      sayonScore     = sayonPick?.score ?? 0;
      sayonDevice    = 'cpu';
      sayonGpuLayers = 0;
    }

  } else if (bestGpu && bestGpu.vramGb === 2) {
    // ── 2 GB edge case: SAYON on GPU, SEREN on CPU ──
    const sayonCompute = computeClassFromDevice(bestGpu, true);
    const sayonPick = pickBestScored(GGUF_CATALOGUE, 'sayon', Math.floor(bestGpu.vramGb * HEADROOM), sayonCompute);
    sayon          = sayonPick?.spec ?? GGUF_CATALOGUE[0];
    sayonScore     = sayonPick?.score ?? 0;
    sayonDevice    = bestGpu.index;
    sayonGpuLayers = 99;

    const serenPick = pickBestScored(GGUF_CATALOGUE, 'seren', Math.floor(hw.ramGb * HEADROOM), 'cpu');
    seren          = serenPick?.spec ?? GGUF_CATALOGUE.find(s => s.thinkingTokens)!;
    serenScore     = serenPick?.score ?? 0;
    serenDevice    = 'cpu';
    serenGpuLayers = 0;

  } else {
    // ── CPU-only ──
    // Pick SEREN first (higher priority), then give SAYON the remainder.
    // This avoids the fixed 60/40 split which can exclude viable SAYON models
    // on tight systems (e.g. 8 GB RAM: Qwen3 4B=3GB + Llama 3.2 3B=3GB = 6GB fits).
    const pool = Math.floor(hw.ramGb * HEADROOM);
    const serenPick = pickBestScored(GGUF_CATALOGUE, 'seren', Math.floor(pool * 0.70), 'cpu');
    seren          = serenPick?.spec ?? GGUF_CATALOGUE.find(s => s.thinkingTokens)!;
    serenScore     = serenPick?.score ?? 0;
    const serenCost = seren.ramRequiredGb;
    const sayonBudget = pool - serenCost;  // remainder after SEREN
    const sayonPick = pickBestScored(GGUF_CATALOGUE, 'sayon', sayonBudget, 'cpu');
    sayon          = sayonPick?.spec ?? GGUF_CATALOGUE[0];
    sayonScore     = sayonPick?.score ?? 0;
    serenDevice    = 'cpu';
    sayonDevice    = 'cpu';
    serenGpuLayers = 0;
    sayonGpuLayers = 0;
  }

  // ── Optional model recommendations ──
  // Image/video models use the GPU after LLM servers stop — full VRAM available.
  const imageModel  = recommendOptionalImageModel(imageVramGb, hasUnifiedMemory, false);
  const videoModel  = recommendOptionalVideoModel(imageVramGb, hasUnifiedMemory, false);
  const upscaleRecommended = imageModel !== null; // always recommend ESRGAN if any image model fits

  // ── Reasoning string ──
  const gpuLines = hw.gpus.map(g =>
    `${g.name} (${g.vramGb} GB${g.unifiedMemory ? ', unified' : ''}, ${g.backend})`
  ).join(' · ');
  const gpuStr    = gpuLines || 'No GPU — CPU fallback';
  const deviceName = (d: 'cpu' | number) =>
    d === 'cpu' ? 'CPU' : (hw.gpus.find(g => g.index === d)?.name ?? `GPU #${d}`);

  const reasoning =
    `System: ${hw.ramGb} GB RAM · ${hw.cpuCores} cores · ${hw.cpuName}. ` +
    `GPUs: ${gpuStr}.` +
    (hasUnifiedMemory ? ` Unified memory — both models share the same ${hw.ramGb} GB pool.` : '') +
    ` SAYON → ${sayon.label} on ${deviceName(sayonDevice)} (${sayonGpuLayers > 0 ? 'GPU' : 'CPU'}, score ${sayonScore.toFixed(1)}).` +
    ` SEREN → ${seren.label} on ${deviceName(serenDevice)} (${serenGpuLayers > 0 ? 'GPU' : 'CPU'}, score ${serenScore.toFixed(1)}).` +
    (imageModel ? ` IMG → ${imageModel.displayName}.` : '') +
    (videoModel ? ` VID → ${videoModel.displayName}.` : '');

  return {
    sayon, seren, sayonDevice, serenDevice, sayonGpuLayers, serenGpuLayers,
    imageModel, videoModel, upscaleRecommended,
    reasoning, sayonScore, serenScore,
  };
}

/**
 * Compare the currently running config against the optimal recommendation.
 * Returns true if current config matches the recommendation.
 */
export function isConfigOptimal(
  currentSayon: string | undefined,
  currentSeren: string | undefined,
  hw: HardwareProfile,
): { optimal: boolean; recommendedSayon: string; recommendedSeren: string } {
  const rec = buildRecommendation(hw);
  const optimal = currentSayon === rec.sayon.modelId && currentSeren === rec.seren.modelId;
  return { optimal, recommendedSayon: rec.sayon.modelId, recommendedSeren: rec.seren.modelId };
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

  // Skip if already downloaded and valid — prevents duplicate downloads
  // when the frontend sends the same model for both sayon and seren phases.
  if (isDownloaded(spec)) {
    yield { modelId: spec.modelId, phase, bytesReceived: spec.sizeBytes, bytesTotal: spec.sizeBytes, done: true };
    return;
  }

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
            fd.end(async () => {
              try {
                await fsPromises.rename(tmp, dest);
              } catch {
                try { await fsPromises.copyFile(tmp, dest); await fsPromises.unlink(tmp); }
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
  overrideUrl?: string,
): AsyncGenerator<FluxDownloadProgress> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const tmp           = destPath + '.download';
  const existingBytes = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
  const reqHeaders: Record<string, string> = {};
  if (existingBytes > 0) reqHeaders['Range'] = `bytes=${existingBytes}-`;

  const url           = overrideUrl ?? hfFluxUrl(hfRepo, hfFile);
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

  // 1. Main model (LowNoise expert for MoE, or single model for non-MoE)
  if (!isFluxDownloaded(spec)) {
    // CivitAI models: download via CivitAI API URL instead of HuggingFace
    const civitaiUrl = spec.civitaiVersionId
      ? `https://civitai.com/api/download/models/${spec.civitaiVersionId}?token=${getCivitaiToken()}`
      : undefined;
    yield* safeDownloadFile(
      downloadFluxFileGen(spec.hfRepo, spec.hfFile, fluxModelPath(spec), spec.sizeBytes, spec.modelId, spec.label, 'flux-main', civitaiUrl),
      spec.modelId, spec.label, 'flux-main', spec.sizeBytes,
    );
  } else {
    yield { fileId: spec.modelId, phase: 'flux-main', label: spec.label,
            bytesReceived: spec.sizeBytes, bytesTotal: spec.sizeBytes, done: true };
  }

  // 1b. MoE HighNoise expert (Wan 2.2 dual-model)
  if (spec.highNoiseHfFile) {
    const hnPath = highNoiseModelPath(spec)!;
    const hnSize = spec.highNoiseSizeBytes ?? spec.sizeBytes;
    const hnId   = `${spec.modelId}-high-noise`;
    const hnLabel = `${spec.label} (HighNoise)`;
    const hnExists = fs.existsSync(hnPath) && fs.statSync(hnPath).size >= hnSize * 0.9;
    if (!hnExists) {
      yield* safeDownloadFile(
        downloadFluxFileGen(spec.hfRepo, spec.highNoiseHfFile, hnPath, hnSize, hnId, hnLabel, 'flux-main'),
        hnId, hnLabel, 'flux-main', hnSize,
      );
    } else {
      yield { fileId: hnId, phase: 'flux-main' as FluxDownloadPhase, label: hnLabel,
              bytesReceived: hnSize, bytesTotal: hnSize, done: true };
    }
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
