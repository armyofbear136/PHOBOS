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
/** @deprecated use IMAGE_FLUX_DIR — kept so any external references survive */
export const FLUX_MODELS_DIR  = IMAGE_FLUX_DIR;

// ── Hardware detection ────────────────────────────────────────────────────────

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

// ── Aggregated detection ──────────────────────────────────────────────────────

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
  ramRequiredGb: number;
  contextWindow: number;
}

export const GGUF_CATALOGUE: GGUFSpec[] = [
  // ── Llama 3 family ───────────────────────────────────────────────────────────
  {
    modelId: 'llama3.2-1b-q4', label: 'Llama 3.2 1B Q4', family: 'Llama 3',
    role: 'sayon', thinkingTokens: false, jinjaTemplate: false,
    hfRepo: 'bartowski/Llama-3.2-1B-Instruct-GGUF',
    hfFile: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    sizeBytes: 770_000_000, ramRequiredGb: 1, contextWindow: 131072,
  },
  {
    modelId: 'llama3.2-3b-q4', label: 'Llama 3.2 3B Q4', family: 'Llama 3',
    role: 'sayon', thinkingTokens: false, jinjaTemplate: false,
    hfRepo: 'bartowski/Llama-3.2-3B-Instruct-GGUF',
    hfFile: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    sizeBytes: 2_020_000_000, ramRequiredGb: 3, contextWindow: 131072,
  },
  {
    modelId: 'llama3.1-8b-q4', label: 'Llama 3.1 8B Q4', family: 'Llama 3',
    role: 'sayon', thinkingTokens: false, jinjaTemplate: false,
    hfRepo: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',
    hfFile: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    sizeBytes: 4_920_000_000, ramRequiredGb: 6, contextWindow: 131072,
  },
  // ── Gemma 3 family ───────────────────────────────────────────────────────────
  {
    modelId: 'gemma3-1b-q4', label: 'Gemma 3 1B Q4', family: 'Gemma 3',
    role: 'sayon', thinkingTokens: false, jinjaTemplate: false,
    hfRepo: 'bartowski/google_gemma-3-1b-it-GGUF',
    hfFile: 'google_gemma-3-1b-it-Q4_K_M.gguf',
    sizeBytes: 694_000_000, ramRequiredGb: 1, contextWindow: 32768,
  },
  {
    modelId: 'gemma3-4b-q4', label: 'Gemma 3 4B Q4', family: 'Gemma 3',
    role: 'sayon', thinkingTokens: false, jinjaTemplate: false,
    hfRepo: 'bartowski/google_gemma-3-4b-it-GGUF',
    hfFile: 'google_gemma-3-4b-it-Q4_K_M.gguf',
    sizeBytes: 2_530_000_000, ramRequiredGb: 3, contextWindow: 131072,
  },
  {
    modelId: 'gemma3-12b-q4', label: 'Gemma 3 12B Q4', family: 'Gemma 3',
    role: 'sayon', thinkingTokens: false, jinjaTemplate: false,
    hfRepo: 'bartowski/google_gemma-3-12b-it-GGUF',
    hfFile: 'google_gemma-3-12b-it-Q4_K_M.gguf',
    sizeBytes: 7_800_000_000, ramRequiredGb: 10, contextWindow: 131072,
  },
  // ── Qwen3 family ─────────────────────────────────────────────────────────────
  {
    modelId: 'qwen3-4b-q4', label: 'Qwen3 4B Q4', family: 'Qwen3',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/Qwen_Qwen3-4B-GGUF',
    hfFile: 'Qwen_Qwen3-4B-Q4_K_M.gguf',
    sizeBytes: 2_580_000_000, ramRequiredGb: 3, contextWindow: 32768,
  },
  {
    modelId: 'qwen3-8b-q4', label: 'Qwen3 8B Q4', family: 'Qwen3',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/Qwen_Qwen3-8B-GGUF',
    hfFile: 'Qwen_Qwen3-8B-Q4_K_M.gguf',
    sizeBytes: 5_190_000_000, ramRequiredGb: 6, contextWindow: 32768,
  },
  {
    modelId: 'qwen3-14b-q4', label: 'Qwen3 14B Q4', family: 'Qwen3',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/Qwen_Qwen3-14B-GGUF',
    hfFile: 'Qwen_Qwen3-14B-Q4_K_M.gguf',
    sizeBytes: 9_000_000_000, ramRequiredGb: 11, contextWindow: 32768,
  },
  {
    modelId: 'qwen3-30b-a3b-q4', label: 'Qwen3 30B-A3B Q4', family: 'Qwen3',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/Qwen_Qwen3-30B-A3B-GGUF',
    hfFile: 'Qwen_Qwen3-30B-A3B-Q4_K_M.gguf',
    sizeBytes: 18_400_000_000, ramRequiredGb: 20, contextWindow: 32768,
  },
  {
    modelId: 'qwen3-coder-8b-q4', label: 'Qwen3 Coder 8B Q4', family: 'Qwen3',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/Qwen_Qwen3-Coder-8B-GGUF',
    hfFile: 'Qwen_Qwen3-Coder-8B-Q4_K_M.gguf',
    sizeBytes: 5_190_000_000, ramRequiredGb: 6, contextWindow: 32768,
  },
  // ── Mistral family ───────────────────────────────────────────────────────────
  {
    modelId: 'mistral-7b-q4', label: 'Mistral 7B v0.3 Q4', family: 'Mistral',
    role: 'seren', thinkingTokens: false, jinjaTemplate: false,
    hfRepo: 'bartowski/Mistral-7B-Instruct-v0.3-GGUF',
    hfFile: 'Mistral-7B-Instruct-v0.3-Q4_K_M.gguf',
    sizeBytes: 4_370_000_000, ramRequiredGb: 6, contextWindow: 32768,
  },
  {
    modelId: 'magistral-8b-q4', label: 'Magistral 8B Q4', family: 'Mistral',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/mistralai_Magistral-Small-2506-GGUF',
    hfFile: 'mistralai_Magistral-Small-2506-Q4_K_M.gguf',
    sizeBytes: 14_400_000_000, ramRequiredGb: 16, contextWindow: 131072,
  },
  // ── DeepSeek-R1 family ───────────────────────────────────────────────────────
  {
    modelId: 'deepseek-r1-8b-q4', label: 'DeepSeek-R1 8B Q4', family: 'DeepSeek-R1',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/deepseek-ai_DeepSeek-R1-0528-Qwen3-8B-GGUF',
    hfFile: 'deepseek-ai_DeepSeek-R1-0528-Qwen3-8B-Q4_K_M.gguf',
    sizeBytes: 5_190_000_000, ramRequiredGb: 6, contextWindow: 32768,
  },
  {
    modelId: 'deepseek-r1-14b-q4', label: 'DeepSeek-R1 14B Q4', family: 'DeepSeek-R1',
    role: 'seren', thinkingTokens: true, jinjaTemplate: true,
    hfRepo: 'bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF',
    hfFile: 'DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf',
    sizeBytes: 9_050_000_000, ramRequiredGb: 11, contextWindow: 65536,
  },
  {
    modelId: 'deepseek-r1-70b-q4', label: 'DeepSeek-R1 70B Q4', family: 'DeepSeek-R1',
    role: 'seren', thinkingTokens: true, jinjaTemplate: false,
    hfRepo: 'bartowski/DeepSeek-R1-Distill-Llama-70B-GGUF',
    hfFile: 'DeepSeek-R1-Distill-Llama-70B-Q4_K_M.gguf',
    sizeBytes: 42_520_000_000, ramRequiredGb: 48, contextWindow: 65536,
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
 *   flux  — --diffusion-model + --clip_l + --t5xxl + --vae
 *   sdxl  — -m (single file, VAE baked) + --clip_l + --clip_g
 */
export type ImageRunnerProfile = 'flux' | 'sdxl';

/**
 * Category tag for UI grouping. nsfw-realistic / nsfw-anime are gated behind
 * a content warning in the UI but use the same download infrastructure.
 */
export type ImageModelCategory = 'realistic' | 'anime' | 'nsfw-realistic' | 'nsfw-anime';

export interface ImageModelSpec {
  modelId: string;
  label: string;
  /** Short name shown on the card e.g. "FLUX.1-schnell" */
  displayName: string;
  runnerProfile: ImageRunnerProfile;
  category: ImageModelCategory;
  variant: 'schnell' | 'dev' | 'pony' | 'sdxl' | 'chroma';
  quantization: 'Q4_K_M' | 'Q8_0' | 'Q4_0' | 'f16';
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

// ── FLUX catalogue ────────────────────────────────────────────────────────────

export const FLUX_CATALOGUE: FluxSpec[] = [
  // ── schnell — Apache 2.0, 4-step generation ──────────────────────────────
  {
    modelId:          'flux-schnell-q4',
    label:            'FLUX.1-schnell Q4',
    displayName:      'FLUX.1-schnell',
    runnerProfile:    'flux',
    category:         'realistic',
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
    category:         'realistic',
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

/** Combined catalogue — all image models across all runner profiles */
export const IMAGE_MODEL_CATALOGUE: ImageModelSpec[] = [
  ...CHROMA_CATALOGUE,
  ...FLUX_CATALOGUE,
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
  if (spec.runnerProfile === 'sdxl') return SDXL_AUX_REQUIRED;
  // flux-profile: VAE + CLIP-L always, T5 selected lazily at download time
  return FLUX_AUX_REQUIRED;
}


// ── FLUX helper functions ─────────────────────────────────────────────────────

export function getFluxSpec(modelId: string): FluxSpec | undefined {
  return FLUX_CATALOGUE.find(s => s.modelId === modelId);
}

// ── Image model path resolution ───────────────────────────────────────────────
// Models:  flux/chroma GGUFs → IMAGE_FLUX_DIR
//          sdxl GGUFs        → IMAGE_SDXL_DIR
// Aux:     all encoders/VAE  → IMAGE_SHARED_DIR
//          (VAE, CLIP-L, T5, CLIP-G are shared across runner profiles)

export function fluxModelPath(spec: FluxSpec): string {
  const dir = spec.runnerProfile === 'sdxl' ? IMAGE_SDXL_DIR : IMAGE_FLUX_DIR;
  return path.join(dir, spec.hfFile);
}

export function fluxAuxPath(aux: FluxAuxFile): string {
  return path.join(IMAGE_SHARED_DIR, aux.hfFile);
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
  const HEADROOM_MB = 2048; // 2 GB minimum for fast inference

  // Estimate base model VRAM (diffusion + VAE + optional CLIP-L)
  const isChroma = fluxSpec.variant === 'chroma';
  // Use vramRequiredGb as a proxy for diffusion model size, convert to MB
  const diffusionMb = fluxSpec.vramRequiredGb * 1024;
  const vaeMb = 95;
  const clipMb = isChroma ? 0 : 230; // Chroma doesn't use CLIP-L
  const baseMb = diffusionMb + vaeMb + clipMb;

  const availableForT5 = totalVramMb - baseMb - HEADROOM_MB;

  // T5 sizes: Q3 ~2300 MB, Q4 ~2900 MB, Q8 ~5060 MB
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
  'llama3.1-8b-q4', 'gemma3-12b-q4', 'gemma3-4b-q4',
  'llama3.2-3b-q4', 'gemma3-1b-q4',  'llama3.2-1b-q4',
];

const SEREN_CANDIDATES = [
  'deepseek-r1-70b-q4',
  'qwen3-30b-a3b-q4',
  'magistral-8b-q4',
  'deepseek-r1-14b-q4',
  'qwen3-14b-q4',
  'qwen3-coder-8b-q4',
  'deepseek-r1-8b-q4',
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
            push({ kind: 'error', err }); reject(err); return;
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
                  push({ kind: 'error', err }); reject(err); return;
                }
              }
              push({ kind: 'done' }); resolve();
            });
          });
          res.on('error', (err) => { fd.destroy(); push({ kind: 'error', err }); reject(err); });
        },
      );
      req.on('error', (err) => { push({ kind: 'error', err }); reject(err); });
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
        throw item.err;
      }
    }
  }

  await downloadPromise;
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
            push({ kind: 'error', err }); reject(err); return;
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
                  push({ kind: 'error', err }); reject(err); return;
                }
              }
              push({ kind: 'done' }); resolve();
            });
          });
          res.on('error', (err) => { fd.destroy(); push({ kind: 'error', err }); reject(err); });
        },
      );
      req.on('error', (err) => { push({ kind: 'error', err }); reject(err); });
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
        throw item.err;
      }
    }
  }

  await downloadPromise;
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
export function resolveSdServerBin(): string {
  const platform = process.platform;
  const arch     = process.arch;
  const seaDir   = path.dirname(process.execPath);
  const binDir   = path.join(path.resolve(_dirname, '..'), 'bin');

  // Windows: each sd build lives in its own subdir to avoid DLL conflicts with llama-cpp.
  // Preference: CUDA -> Vulkan -> CPU.
  // Check both dev layout (bin/sd-cuda/) and SEA layout (dist/sd-cuda/ = seaDir/sd-cuda/).
  // Linux/macOS: single binary, flat layout.
  type Candidate = { file: string; dir: string };
  const candidates: Candidate[] = platform === 'win32'
    ? [
        // SEA build: sd-cuda/ etc live alongside the executable
        { file: `sd-server-${platform}-${arch}-cuda.exe`, dir: path.join(seaDir, 'sd-cuda')   },
        { file: `sd-server-${platform}-${arch}.exe`,      dir: path.join(seaDir, 'sd-vulkan') },
        { file: `sd-server-${platform}-${arch}-cpu.exe`,  dir: path.join(seaDir, 'sd-cpu')    },
        // Dev layout: bin/sd-cuda/ etc
        { file: `sd-server-${platform}-${arch}-cuda.exe`, dir: path.join(binDir, 'sd-cuda')   },
        { file: `sd-server-${platform}-${arch}.exe`,      dir: path.join(binDir, 'sd-vulkan') },
        { file: `sd-server-${platform}-${arch}-cpu.exe`,  dir: path.join(binDir, 'sd-cpu')    },
        // Flat fallback (legacy or custom builds)
        { file: `sd-server-${platform}-${arch}-cuda.exe`, dir: seaDir },
        { file: `sd-server-${platform}-${arch}-cuda.exe`, dir: binDir },
        { file: `sd-server-${platform}-${arch}.exe`,      dir: seaDir },
        { file: `sd-server-${platform}-${arch}.exe`,      dir: binDir },
      ]
    : [
        { file: `sd-server-${platform}-${arch}`, dir: seaDir },
        { file: `sd-server-${platform}-${arch}`, dir: binDir },
      ];

  for (const { file, dir } of candidates) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) return p;
  }

  throw new Error(
    `sd-server binary not found for ${platform}-${arch}.\n` +
    `Expected in sd-cuda/, sd-vulkan/, or sd-cpu/ (alongside executable or in bin/)\n` +
    `Run scripts/fetch-sd-cpp.js to download binaries.`
  );
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
