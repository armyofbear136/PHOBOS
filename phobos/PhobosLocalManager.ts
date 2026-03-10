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
  /**
   * True on Apple Silicon / AMD APUs where GPU VRAM and system RAM are the
   * same physical pool. When set, VRAM should NOT be double-counted alongside
   * system RAM — the recommendation engine will budget both models from a
   * single shared pool.
   */
  unifiedMemory?: boolean;
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
    // Only flag as Apple Silicon if it's actually an ARM chip (M-series)
    const isAppleSilicon = chipMatch && /Apple M/i.test(chipMatch[1]);
    if (!memMatch || !isAppleSilicon) return [];
    return [{
      index: 0,
      name: chipMatch![1].trim(),
      vramGb: parseInt(memMatch[1], 10),
      backend: 'metal',
      unifiedMemory: true,   // GPU VRAM == system RAM — same physical pool
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
  /** Model family group for UI display */
  family: string;
  /** Primary role this model is suited for */
  role: 'sayon' | 'allmind' | 'both';
  /** Whether this model emits thinking/reasoning tokens */
  thinkingTokens: boolean;
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
  // ── Llama 3 family — no thinking tokens, great for SAYON coordinator ────────
  {
    modelId: 'llama3.2-1b-q4',
    label: 'Llama 3.2 1B Q4',
    family: 'Llama 3',
    role: 'sayon',
    thinkingTokens: false,
    hfRepo: 'bartowski/Llama-3.2-1B-Instruct-GGUF',
    hfFile: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    sizeBytes: 770_000_000,
    ramRequiredGb: 1,
    contextWindow: 131072,
  },
  {
    modelId: 'llama3.2-3b-q4',
    label: 'Llama 3.2 3B Q4',
    family: 'Llama 3',
    role: 'sayon',
    thinkingTokens: false,
    hfRepo: 'bartowski/Llama-3.2-3B-Instruct-GGUF',
    hfFile: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    sizeBytes: 2_020_000_000,
    ramRequiredGb: 3,
    contextWindow: 131072,
  },
  {
    modelId: 'llama3.1-8b-q4',
    label: 'Llama 3.1 8B Q4',
    family: 'Llama 3',
    role: 'sayon',
    thinkingTokens: false,
    hfRepo: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',
    hfFile: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    sizeBytes: 4_920_000_000,
    ramRequiredGb: 6,
    contextWindow: 131072,
  },
  // ── Gemma 3 family — no thinking tokens, strong SAYON alternative ──────────
  {
    modelId: 'gemma3-1b-q4',
    label: 'Gemma 3 1B Q4',
    family: 'Gemma 3',
    role: 'sayon',
    thinkingTokens: false,
    hfRepo: 'bartowski/google_gemma-3-1b-it-GGUF',
    hfFile: 'google_gemma-3-1b-it-Q4_K_M.gguf',
    sizeBytes: 694_000_000,
    ramRequiredGb: 1,
    contextWindow: 32768,
  },
  {
    modelId: 'gemma3-4b-q4',
    label: 'Gemma 3 4B Q4',
    family: 'Gemma 3',
    role: 'sayon',
    thinkingTokens: false,
    hfRepo: 'bartowski/google_gemma-3-4b-it-GGUF',
    hfFile: 'google_gemma-3-4b-it-Q4_K_M.gguf',
    sizeBytes: 2_530_000_000,
    ramRequiredGb: 3,
    contextWindow: 131072,
  },
  {
    modelId: 'gemma3-12b-q4',
    label: 'Gemma 3 12B Q4',
    family: 'Gemma 3',
    role: 'sayon',
    thinkingTokens: false,
    hfRepo: 'bartowski/google_gemma-3-12b-it-GGUF',
    hfFile: 'google_gemma-3-12b-it-Q4_K_M.gguf',
    sizeBytes: 7_800_000_000,
    ramRequiredGb: 10,
    contextWindow: 131072,
  },
  // ── Qwen3 family — thinking tokens, ideal ALLMIND reasoning engine ──────────
  {
    modelId: 'qwen3-4b-q4',
    label: 'Qwen3 4B Q4',
    family: 'Qwen3',
    role: 'allmind',
    thinkingTokens: true,
    hfRepo: 'bartowski/Qwen_Qwen3-4B-GGUF',
    hfFile: 'Qwen_Qwen3-4B-Q4_K_M.gguf',
    sizeBytes: 2_580_000_000,
    ramRequiredGb: 3,
    contextWindow: 32768,
  },
  {
    modelId: 'qwen3-8b-q4',
    label: 'Qwen3 8B Q4',
    family: 'Qwen3',
    role: 'allmind',
    thinkingTokens: true,
    hfRepo: 'bartowski/Qwen_Qwen3-8B-GGUF',
    hfFile: 'Qwen_Qwen3-8B-Q4_K_M.gguf',
    sizeBytes: 5_190_000_000,
    ramRequiredGb: 6,
    contextWindow: 32768,
  },
  {
    modelId: 'qwen3-14b-q4',
    label: 'Qwen3 14B Q4',
    family: 'Qwen3',
    role: 'allmind',
    thinkingTokens: true,
    hfRepo: 'bartowski/Qwen_Qwen3-14B-GGUF',
    hfFile: 'Qwen_Qwen3-14B-Q4_K_M.gguf',
    sizeBytes: 9_000_000_000,
    ramRequiredGb: 11,
    contextWindow: 32768,
  },
  {
    modelId: 'qwen3-30b-a3b-q4',
    label: 'Qwen3 30B-A3B Q4',
    family: 'Qwen3',
    role: 'allmind',
    thinkingTokens: true,
    hfRepo: 'bartowski/Qwen_Qwen3-30B-A3B-GGUF',
    hfFile: 'Qwen_Qwen3-30B-A3B-Q4_K_M.gguf',
    sizeBytes: 18_400_000_000,
    ramRequiredGb: 20,
    contextWindow: 32768,
  },
  {
    modelId: 'qwen3-coder-8b-q4',
    label: 'Qwen3 Coder 8B Q4',
    family: 'Qwen3',
    role: 'allmind',
    thinkingTokens: true,
    hfRepo: 'bartowski/Qwen_Qwen3-Coder-8B-GGUF',
    hfFile: 'Qwen_Qwen3-Coder-8B-Q4_K_M.gguf',
    sizeBytes: 5_190_000_000,
    ramRequiredGb: 6,
    contextWindow: 32768,
  },
  // ── Mistral family — thinking tokens via Magistral, ALLMIND-class ──────────
  {
    modelId: 'mistral-7b-q4',
    label: 'Mistral 7B v0.3 Q4',
    family: 'Mistral',
    role: 'allmind',
    thinkingTokens: false,
    hfRepo: 'bartowski/Mistral-7B-Instruct-v0.3-GGUF',
    hfFile: 'Mistral-7B-Instruct-v0.3-Q4_K_M.gguf',
    sizeBytes: 4_370_000_000,
    ramRequiredGb: 6,
    contextWindow: 32768,
  },
  {
    modelId: 'magistral-8b-q4',
    label: 'Magistral 8B Q4',
    family: 'Mistral',
    role: 'allmind',
    thinkingTokens: true,
    hfRepo: 'bartowski/Magistral-Small-2506-GGUF',
    hfFile: 'Magistral-Small-2506-Q4_K_M.gguf',
    sizeBytes: 14_400_000_000,
    ramRequiredGb: 16,
    contextWindow: 131072,
  },
  // ── DeepSeek-R1 family — strong reasoning, ALLMIND-class ───────────────────
  {
    modelId: 'deepseek-r1-8b-q4',
    label: 'DeepSeek-R1 8B Q4',
    family: 'DeepSeek-R1',
    role: 'allmind',
    thinkingTokens: true,
    hfRepo: 'bartowski/DeepSeek-R1-0528-Qwen3-8B-GGUF',
    hfFile: 'DeepSeek-R1-0528-Qwen3-8B-Q4_K_M.gguf',
    sizeBytes: 5_190_000_000,
    ramRequiredGb: 6,
    contextWindow: 32768,
  },
  {
    modelId: 'deepseek-r1-14b-q4',
    label: 'DeepSeek-R1 14B Q4',
    family: 'DeepSeek-R1',
    role: 'allmind',
    thinkingTokens: true,
    hfRepo: 'bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF',
    hfFile: 'DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf',
    sizeBytes: 9_050_000_000,
    ramRequiredGb: 11,
    contextWindow: 65536,
  },
  {
    modelId: 'deepseek-r1-70b-q4',
    label: 'DeepSeek-R1 70B Q4',
    family: 'DeepSeek-R1',
    role: 'allmind',
    thinkingTokens: true,
    hfRepo: 'bartowski/DeepSeek-R1-Distill-Llama-70B-GGUF',
    hfFile: 'DeepSeek-R1-Distill-Llama-70B-Q4_K_M.gguf',
    sizeBytes: 42_520_000_000,
    ramRequiredGb: 48,
    contextWindow: 65536,
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

/** SAYON candidates: no thinking tokens, ≤15B params, ordered by preference */
const SAYON_CANDIDATES = ['llama3.1-8b-q4', 'gemma3-12b-q4', 'gemma3-4b-q4', 'llama3.2-3b-q4', 'gemma3-1b-q4', 'llama3.2-1b-q4'];

/** ALLMIND candidates: reasoning/thinking models, ordered by quality */
const ALLMIND_CANDIDATES = [
  'deepseek-r1-70b-q4',   // 48 GB — only viable on high-VRAM systems
  'qwen3-30b-a3b-q4',     // 20 GB — MoE, efficient
  'magistral-8b-q4',      // 16 GB
  'deepseek-r1-14b-q4',   // 11 GB
  'qwen3-14b-q4',         // 11 GB
  'qwen3-coder-8b-q4',    //  6 GB
  'deepseek-r1-8b-q4',    //  6 GB
  'qwen3-8b-q4',          //  6 GB
  'qwen3-4b-q4',          //  3 GB — minimum useful reasoning model
];

function pickBestFit(candidates: string[], budgetGb: number): GGUFSpec {
  for (const id of candidates) {
    const spec = GGUF_CATALOGUE.find(s => s.modelId === id);
    if (spec && spec.ramRequiredGb <= budgetGb) return spec;
  }
  // Absolute fallback — smallest available
  return GGUF_CATALOGUE.find(s => s.modelId === candidates[candidates.length - 1])!;
}

export function buildRecommendation(hw: HardwareProfile): ModelRecommendation {
  // Sort GPUs by VRAM descending
  const gpusByVram = [...hw.gpus].sort((a, b) => b.vramGb - a.vramGb);
  const bestGpu    = gpusByVram[0] ?? null;
  const secondGpu  = gpusByVram[1] ?? null;

  // ── Unified memory detection ───────────────────────────────────────────────
  // Apple Silicon and AMD APUs report system RAM as VRAM. On these devices the
  // "VRAM" of the GPU is the same physical pool as system RAM, so we must
  // budget BOTH models from a single shared pool — not independently.
  const hasUnifiedMemory = bestGpu?.unifiedMemory === true;

  // Usable memory pool: leave ~20% headroom for OS + KV cache
  const HEADROOM = 0.80;

  let sayon: GGUFSpec;
  let allmind: GGUFSpec;
  let sayonDevice: 'cpu' | number;
  let allmindDevice: 'cpu' | number;
  let sayonGpuLayers: number;
  let allmindGpuLayers: number;

  if (hasUnifiedMemory && bestGpu) {
    // ── Apple Silicon / unified memory path ───────────────────────────────
    // Total usable pool = system RAM (== VRAM on these devices)
    const pool = Math.floor(hw.ramGb * HEADROOM);

    // Give ALLMIND the larger share (up to 75%), SAYON gets the remainder
    const allmindBudget = Math.floor(pool * 0.75);
    const sayonBudget   = Math.floor(pool * 0.35);  // overlapping is fine — sequential inference

    allmind          = pickBestFit(ALLMIND_CANDIDATES, allmindBudget);
    sayon            = pickBestFit(SAYON_CANDIDATES,   sayonBudget);
    allmindDevice    = bestGpu.index;
    sayonDevice      = bestGpu.index;  // same device — Metal handles scheduling
    allmindGpuLayers = 99;
    sayonGpuLayers   = 99;

  } else if (bestGpu && bestGpu.vramGb >= 3) {
    // ── Discrete / dedicated GPU path ─────────────────────────────────────
    // ALLMIND gets the biggest GPU
    const allmindBudget = Math.floor(bestGpu.vramGb * HEADROOM);
    allmind          = pickBestFit(ALLMIND_CANDIDATES, allmindBudget);
    allmindDevice    = bestGpu.index;
    allmindGpuLayers = 99;

    // SAYON: second GPU if useful, else CPU from system RAM
    if (secondGpu && secondGpu.vramGb >= 2 && !secondGpu.unifiedMemory) {
      const sayonBudget = Math.floor(secondGpu.vramGb * HEADROOM);
      sayon            = pickBestFit(SAYON_CANDIDATES, sayonBudget);
      sayonDevice      = secondGpu.index;
      sayonGpuLayers   = 99;
    } else {
      sayon            = pickBestFit(SAYON_CANDIDATES, Math.floor(hw.ramGb * HEADROOM));
      sayonDevice      = 'cpu';
      sayonGpuLayers   = 0;
    }

  } else {
    // ── CPU-only path ─────────────────────────────────────────────────────
    const pool = Math.floor(hw.ramGb * HEADROOM);
    // Split roughly 60/40 ALLMIND/SAYON for CPU-only — they share system RAM
    allmind          = pickBestFit(ALLMIND_CANDIDATES, Math.floor(pool * 0.60));
    sayon            = pickBestFit(SAYON_CANDIDATES,   Math.floor(pool * 0.40));
    allmindDevice    = 'cpu';
    sayonDevice      = 'cpu';
    allmindGpuLayers = 0;
    sayonGpuLayers   = 0;
  }

  // ── Reasoning string ───────────────────────────────────────────────────────
  const gpuLines = hw.gpus.map(g =>
    `${g.name} (${g.vramGb} GB${g.unifiedMemory ? ', unified' : ''}, ${g.backend})`
  ).join(' · ');
  const gpuStr = gpuLines || 'No GPU — CPU fallback';

  const deviceName = (d: 'cpu' | number) =>
    d === 'cpu' ? 'CPU' : (hw.gpus.find(g => g.index === d)?.name ?? `GPU #${d}`);

  const reasoning =
    `System: ${hw.ramGb} GB RAM · ${hw.cpuCores} cores · ${hw.cpuName}. ` +
    `GPUs: ${gpuStr}.` +
    (hasUnifiedMemory ? ` Unified memory — both models share the same ${hw.ramGb} GB pool.` : '') +
    ` SAYON → ${sayon.label} on ${deviceName(sayonDevice)} (${sayonGpuLayers > 0 ? 'GPU' : 'CPU'}).` +
    ` ALLMIND → ${allmind.label} on ${deviceName(allmindDevice)} (${allmindGpuLayers > 0 ? 'GPU' : 'CPU'}).`;

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
