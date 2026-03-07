import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Constants ─────────────────────────────────────────────────────────────────

export const MODELS_DIR = path.join(os.homedir(), '.phobos', 'models');

// ── Hardware detection ────────────────────────────────────────────────────────

export interface HardwareProfile {
  ramGb: number;
  cpuCores: number;
  gpuVramGb: number;
  gpuName: string | null;
  gpuBackend: 'nvidia' | 'apple' | 'none';
}

async function detectNvidiaVram(): Promise<{ vramGb: number; name: string } | null> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=name,memory.total',
      '--format=csv,noheader,nounits',
    ]);
    const line = stdout.trim().split('\n')[0];
    if (!line) return null;
    const parts = line.split(',').map(s => s.trim());
    const vramMb = parseInt(parts[1], 10);
    if (isNaN(vramMb)) return null;
    return { vramGb: Math.floor(vramMb / 1024), name: parts[0] };
  } catch {
    return null;
  }
}

async function detectAppleSilicon(): Promise<{ vramGb: number; name: string } | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync('system_profiler', ['SPHardwareDataType']);
    const memMatch  = stdout.match(/Memory:\s+(\d+)\s+GB/i);
    const chipMatch = stdout.match(/Chip:\s+(.+)/i);
    if (!memMatch) return null;
    // Unified memory — full pool is available to Metal
    return {
      vramGb: parseInt(memMatch[1], 10),
      name: chipMatch ? chipMatch[1].trim() : 'Apple Silicon',
    };
  } catch {
    return null;
  }
}

export async function detectHardware(): Promise<HardwareProfile> {
  const ramGb    = Math.floor(os.totalmem() / (1024 ** 3));
  const cpuCores = os.cpus().length;

  const nvidia = await detectNvidiaVram();
  if (nvidia) {
    return { ramGb, cpuCores, gpuVramGb: nvidia.vramGb, gpuName: nvidia.name, gpuBackend: 'nvidia' };
  }

  const apple = await detectAppleSilicon();
  if (apple) {
    return { ramGb, cpuCores, gpuVramGb: apple.vramGb, gpuName: apple.name, gpuBackend: 'apple' };
  }

  return { ramGb, cpuCores, gpuVramGb: 0, gpuName: null, gpuBackend: 'none' };
}

// ── GGUF model catalogue ──────────────────────────────────────────────────────
// HuggingFace direct HTTPS — no API key required for public repos.
// All bartowski quants — consistent quality, reliable CDN.

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
    hfRepo: 'bartowski/Qwen3-4B-GGUF',
    hfFile: 'Qwen3-4B-Q4_K_M.gguf',
    sizeBytes: 2_580_000_000,
    ramRequiredGb: 3,
    contextWindow: 40960,
  },
  {
    modelId: 'qwen3-8b-q4',
    label: 'Qwen3 8B Q4',
    hfRepo: 'bartowski/Qwen3-8B-GGUF',
    hfFile: 'Qwen3-8B-Q4_K_M.gguf',
    sizeBytes: 5_190_000_000,
    ramRequiredGb: 6,
    contextWindow: 40960,
  },
  {
    modelId: 'qwen3-14b-q4',
    label: 'Qwen3 14B Q4',
    hfRepo: 'bartowski/Qwen3-14B-GGUF',
    hfFile: 'Qwen3-14B-Q4_K_M.gguf',
    sizeBytes: 9_000_000_000,
    ramRequiredGb: 11,
    contextWindow: 40960,
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
  // If file is smaller than 90% of expected size, treat as incomplete download
  const stat = fs.statSync(p);
  return stat.size >= spec.sizeBytes * 0.9;
}

export function listDownloaded(): GGUFSpec[] {
  return GGUF_CATALOGUE.filter(isDownloaded);
}

// ── Model recommendation ──────────────────────────────────────────────────────

export interface ModelRecommendation {
  sayon: GGUFSpec;    // coordinator — always CPU
  allmind: GGUFSpec;  // engine — GPU if available, else CPU
  sayonGpuLayers: number;
  allmindGpuLayers: number;
  reasoning: string;
}

function selectSayon(ramGb: number): GGUFSpec {
  // Coordinator must be lightweight and fast. Always CPU.
  if (ramGb >= 16) return GGUF_CATALOGUE.find(s => s.modelId === 'llama3.1-8b-q4')!;
  if (ramGb >= 8)  return GGUF_CATALOGUE.find(s => s.modelId === 'llama3.2-3b-q4')!;
  return GGUF_CATALOGUE.find(s => s.modelId === 'llama3.2-1b-q4')!;
}

function selectAllmind(vramGb: number, hasGpu: boolean, ramGb: number): { spec: GGUFSpec; gpuLayers: number } {
  if (hasGpu) {
    if (vramGb >= 16) return { spec: GGUF_CATALOGUE.find(s => s.modelId === 'qwen3-14b-q4')!, gpuLayers: 99 };
    if (vramGb >= 8)  return { spec: GGUF_CATALOGUE.find(s => s.modelId === 'qwen3-8b-q4')!,  gpuLayers: 99 };
    if (vramGb >= 4)  return { spec: GGUF_CATALOGUE.find(s => s.modelId === 'qwen3-4b-q4')!,  gpuLayers: 99 };
  }
  // CPU fallback — fit alongside SAYON
  if (ramGb >= 32) return { spec: GGUF_CATALOGUE.find(s => s.modelId === 'qwen3-8b-q4')!,  gpuLayers: 0 };
  if (ramGb >= 16) return { spec: GGUF_CATALOGUE.find(s => s.modelId === 'qwen3-4b-q4')!,  gpuLayers: 0 };
  return { spec: GGUF_CATALOGUE.find(s => s.modelId === 'llama3.2-3b-q4')!, gpuLayers: 0 };
}

export function buildRecommendation(hw: HardwareProfile): ModelRecommendation {
  const sayon = selectSayon(hw.ramGb);
  const { spec: allmind, gpuLayers: allmindGpuLayers } = selectAllmind(
    hw.gpuVramGb,
    hw.gpuBackend !== 'none',
    hw.ramGb,
  );

  const gpuLine = hw.gpuBackend !== 'none'
    ? `${hw.gpuName} (${hw.gpuVramGb} GB VRAM)`
    : 'No GPU — CPU fallback';

  const reasoning =
    `System: ${hw.ramGb} GB RAM · ${hw.cpuCores} cores · ${gpuLine}. ` +
    `SAYON: ${sayon.label} on CPU (${sayon.ramRequiredGb} GB). ` +
    `ALLMIND: ${allmind.label} ${allmindGpuLayers > 0 ? 'GPU offloaded' : 'CPU'} (${allmind.ramRequiredGb} GB).`;

  return { sayon, allmind, sayonGpuLayers: 0, allmindGpuLayers, reasoning };
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
            fd.close(() => {
              fs.renameSync(tmp, dest);
              resolve();
            });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
    };
    follow(url);
  });

  yield { modelId: spec.modelId, phase, bytesReceived, bytesTotal: spec.sizeBytes, done: true };
}

// ── llama-server binary resolution ───────────────────────────────────────────
// When running as SEA:   binary lives next to phobos-core in dist/
// When running via tsx:  binary lives in repo/bin/

export function resolveLlamaServerBin(): string {
  const platform = process.platform; // 'win32' | 'darwin' | 'linux'
  const arch     = process.arch;     // 'x64' | 'arm64'
  const ext      = platform === 'win32' ? '.exe' : '';
  const name     = `llama-server-${platform}-${arch}${ext}`;

  // SEA path: same directory as the running executable
  const seaDir  = path.dirname(process.execPath);
  const seaPath = path.join(seaDir, name);
  if (fs.existsSync(seaPath)) return seaPath;

  // Dev path: repo/bin/
  const repoRoot = path.resolve(__dirname, '..', '..');
  const devPath  = path.join(repoRoot, 'bin', name);
  if (fs.existsSync(devPath)) return devPath;

  throw new Error(
    `llama-server binary not found.\n` +
    `Expected at:\n  ${seaPath}\n  ${devPath}\n` +
    `Run scripts/fetch-llamacpp.js to download binaries.`
  );
}
