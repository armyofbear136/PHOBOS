// phobos-lite/server.js
// Standalone Node.js process. No PHOBOS-core dependency.
//
// Hardware detection uses the EXACT same pipeline as phobos-core
// PhobosLocalManager.ts — tested on NVIDIA, AMD discrete, AMD APU,
// Intel iGPU, Intel Arc, Apple Silicon across Windows/Linux/macOS.

'use strict';

const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { spawn, execFile } = require('child_process');

// ─── CLI / env parsing ────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));

const PORT             = parseInt(args['--port'] || process.env.PHOBOS_PORT || '52690', 10);
const MODE             = args['--mode'] || process.env.PHOBOS_MODE || 'game';
const EXCLUDE_PRIMARY  = args['--exclude-primary-gpu'] != null
                      || process.env.PHOBOS_EXCLUDE_PRIMARY === '1';
const MODELS_DIR       = process.env.PHOBOS_MODEL_DIR
                      || path.join(path.dirname(process.execPath), 'models');

const LLAMA_SERVER = resolveLlamaServer();

// ─── Model catalogue ─────────────────────────────────────────────────────────
const MODEL_CATALOGUE = [
  {
    id:            'llama-3.1-8b-instruct-q4',
    displayName:   'Llama 3.1 8B Instruct (Q4_K_M)',
    filename:      'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    hfRepo:        'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',
    hfFile:        'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    minVramMB:     5500,
    vramClass:     'primary',
    contextLength: 8192,
    ngl:           35,
  },
  {
    id:            'llama-3.2-3b-instruct-q4',
    displayName:   'Llama 3.2 3B Instruct (Q4_K_M)',
    filename:      'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    hfRepo:        'bartowski/Llama-3.2-3B-Instruct-GGUF',
    hfFile:        'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    minVramMB:     0,
    vramClass:     'fallback',
    contextLength: 8192,
    ngl:           0,
  },
];

// ─── Hardware detection ───────────────────────────────────────────────────────
// Mirrors PhobosLocalManager.ts detectHardware() exactly:
//   1. NVIDIA via nvidia-smi (CUDA devices with exact VRAM)
//   2. AMD/Intel via platform-specific queries:
//      - Windows: WMI Win32_VideoController + registry qwMemorySize
//      - Linux:   lspci + sysfs mem_info_vram_total
//      - macOS:   system_profiler (Apple Silicon / Metal)
//   3. Vulkan index mapping via llama-server --list-devices (for launch args only)
//   4. CPU always available as last resort

async function detectDevices() {
  const devices = [];

  // CPU always available
  const cpuRam = Math.floor(os.totalmem() / 1024 / 1024);
  devices.push({
    index: -1, name: `CPU (${os.cpus()[0]?.model || 'unknown'})`,
    vramMB: Math.floor(cpuRam * 0.6), backend: 'cpu', score: 0, isPrimary: false,
  });

  // ── Platform-specific GPU detection ────────────────────────────────────
  const nvidiaGpus    = await detectNvidiaGpus();
  const nonNvidiaGpus = process.platform === 'win32'  ? await detectWindowsNonNvidiaGpus()
                      : process.platform === 'linux'  ? await detectLinuxNonNvidiaGpus()
                      : process.platform === 'darwin' ? await detectAppleSilicon()
                      : [];

  // ── Vulkan index mapping (for launch args) ─────────────────────────────
  const vkMap = await enumerateVulkanDevices();
  if (vkMap.size > 0) {
    log(`Vulkan runtime enum: ${[...vkMap.entries()].map(([n, i]) => `${i}=${n}`).join(', ')}`);
  }

  // ── Assemble final device list ─────────────────────────────────────────
  const nvidiaCount = nvidiaGpus.length;

  for (const gpu of nvidiaGpus) {
    const vkIdx = matchVulkanIndex(gpu.name, vkMap) ?? gpu.index;
    devices.push({
      index: gpu.index, name: gpu.name, vramMB: gpu.vramMB,
      backend: 'cuda', score: 4, isPrimary: gpu.index === 0,
      vulkanIndex: vkIdx,
    });
  }

  for (const gpu of nonNvidiaGpus) {
    // Vulkan index: runtime match preferred, then positional fallback.
    // On mixed NVIDIA+AMD systems, NVIDIA occupies first Vulkan slots.
    const runtimeIdx    = matchVulkanIndex(gpu.name, vkMap);
    const positionalIdx = nvidiaCount + gpu.nonNvidiaPosition;
    const vkIdx         = runtimeIdx ?? positionalIdx;

    devices.push({
      index: gpu.index, name: gpu.name, vramMB: gpu.vramMB,
      backend: gpu.backend, score: gpu.isUma ? 1 : (gpu.backend === 'metal' ? 3 : 2),
      isPrimary: gpu.isPrimary ?? (vkIdx === 0),
      vulkanIndex: vkIdx, isUma: gpu.isUma,
    });
  }

  devices.sort((a, b) => b.score - a.score || b.vramMB - a.vramMB);

  log(`Detected ${devices.length} compute devices:`);
  for (const d of devices) {
    log(`  [${d.index}] ${d.name} — ${d.vramMB} MB — ${d.backend} — score ${d.score}${d.isPrimary ? ' (PRIMARY/GAME GPU — excluded)' : ''}${d.vulkanIndex !== undefined ? ` — vk${d.vulkanIndex}` : ''}`);
  }

  return devices;
}

// ── NVIDIA — nvidia-smi ──────────────────────────────────────────────────────

async function detectNvidiaGpus() {
  try {
    const { stdout } = await execFileP('nvidia-smi', [
      '--query-gpu=index,name,memory.total',
      '--format=csv,noheader,nounits',
    ]);
    const gpus = [];
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts  = line.split(',').map(s => s.trim());
      const idx    = parseInt(parts[0], 10);
      const name   = parts[1];
      const vramMB = parseInt(parts[2], 10);
      if (isNaN(idx) || isNaN(vramMB)) continue;
      gpus.push({ index: idx, name, vramMB });
    }
    return gpus;
  } catch { return []; }
}

// ── Windows: AMD / Intel via WMI + registry qwMemorySize ─────────────────────
// Mirrors PhobosLocalManager.detectNonNvidiaGpus() exactly.
// qwMemorySize is the authoritative VRAM value written by the driver.
// AdapterRAM is a 32-bit WMI field capped at 4 GB — unreliable for inference.

async function detectWindowsNonNvidiaGpus() {
  try {
    const { stdout } = await execFileP('powershell', ['-NoProfile', '-Command',
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
    ], { timeout: 15000 });
    if (!stdout.trim()) return [];

    const raw   = JSON.parse(stdout.trim());
    const items = Array.isArray(raw) ? raw : [raw];
    const gpus  = [];
    let nonNvidiaIdx = 0;

    for (let i = 0; i < items.length; i++) {
      const item        = items[i];
      const name        = String(item.Name || 'Unknown GPU');
      const hasQwMemory = Boolean(item.HasQwMemory);
      const qwVramBytes = Number(item.QwVramBytes || 0);
      const adapterBytes = Number(item.AdapterRamBytes || 0);

      const isIntelArc = /Intel.*Arc/i.test(name);
      let vramMB = 0;
      let isUma  = false;

      if (hasQwMemory) {
        vramMB = Math.round(qwVramBytes / (1024 * 1024));
        // AMD APU iGPUs: names like "Radeon 890M", "Radeon 780M" — 3-digit + M suffix
        const isAmd = /AMD|Radeon|ATI/i.test(name);
        const amdApuPattern = /\d{3}M\b/i;
        const amdDiscretePattern = /\bRX\s*\d{3,4}\b|\bVega\s*\d{2}\b|\bNavi\b/i;
        const isAmdDiscrete = isAmd && amdDiscretePattern.test(name) && !amdApuPattern.test(name);
        if (!isAmdDiscrete) isUma = true;
      } else if (isIntelArc) {
        vramMB = Math.round(adapterBytes / (1024 * 1024));
      } else {
        // Shared memory aperture only — not usable for inference
        log(`  ${name}: skipped — no dedicated/UMA memory (shared aperture only)`);
        continue;
      }

      if (vramMB < 1024) {
        log(`  ${name}: skipped — ${vramMB} MB below minimum`);
        continue;
      }

      // Count Vulkan-visible position (skip virtual adapters)
      let vulkanVisiblePosition = 0;
      for (let j = 0; j < i; j++) {
        const prevName = String(items[j].Name || '');
        const isReal = /Intel|AMD|Radeon|ATI/i.test(prevName)
          && !/Parsec|Remote|Virtual|TeamViewer|Indirect|IDD/i.test(prevName);
        if (isReal) vulkanVisiblePosition++;
      }

      gpus.push({
        index: 100 + nonNvidiaIdx, name, vramMB,
        backend: 'vulkan', isUma,
        nonNvidiaPosition: vulkanVisiblePosition,
      });
      nonNvidiaIdx++;
    }
    return gpus;
  } catch (err) {
    log(`WMI GPU detection failed: ${err.message}`);
    return [];
  }
}

// ── Linux: non-NVIDIA via lspci + sysfs ──────────────────────────────────────

async function detectLinuxNonNvidiaGpus() {
  let lspciOutput = '';
  try {
    const { stdout } = await execFileP('lspci', ['-nn']);
    lspciOutput = stdout;
  } catch {
    // lspci not installed — fall back to pure sysfs
    return detectLinuxGpusSysfsOnly();
  }

  const gpus = [];
  let idx = 100;
  let amdSysfsIdx = 0;

  for (const line of lspciOutput.split('\n')) {
    if (!/VGA|3D|Display/.test(line)) continue;
    if (/NVIDIA/i.test(line)) continue;
    const isAmd   = /AMD|ATI|Radeon/i.test(line);
    const isIntel = /Intel/i.test(line);
    if (!isAmd && !isIntel) continue;

    let name = isAmd ? 'AMD GPU' : 'Intel GPU';
    const marketingMatch = line.match(/\[(Radeon[^\]]+)\]/i)
      || line.match(/\[(Intel[^\]]+)\]/i)
      || line.match(/\[(Arc[^\]]+)\]/i);
    if (marketingMatch) name = marketingMatch[1].trim();

    let vramMB = 0;
    if (isAmd) {
      try {
        const cards = fs.readdirSync('/sys/class/drm')
          .filter(d => /^card\d+$/.test(d))
          .sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)));
        let sysIdx = 0;
        for (const card of cards) {
          const vendorPath = path.join('/sys/class/drm', card, 'device', 'vendor');
          if (!fs.existsSync(vendorPath)) continue;
          if (fs.readFileSync(vendorPath, 'utf-8').trim() !== '0x1002') continue;
          if (sysIdx === amdSysfsIdx) {
            const totalPath = path.join('/sys/class/drm', card, 'device', 'mem_info_vram_total');
            if (fs.existsSync(totalPath)) {
              const totalBytes = parseInt(fs.readFileSync(totalPath, 'utf-8').trim(), 10);
              if (!isNaN(totalBytes) && totalBytes > 0) {
                vramMB = Math.round(totalBytes / (1024 * 1024));
                log(`  ${name}: sysfs VRAM ${vramMB} MB (${card})`);
              }
            }
            break;
          }
          sysIdx++;
        }
      } catch { /* sysfs read failed */ }
      amdSysfsIdx++;
    }

    gpus.push({
      index: idx++, name, vramMB,
      backend: 'vulkan', isUma: false,
      nonNvidiaPosition: gpus.length,
    });
  }
  return gpus;
}

function detectLinuxGpusSysfsOnly() {
  try {
    const drmBase = '/sys/class/drm';
    if (!fs.existsSync(drmBase)) return [];
    const cards = fs.readdirSync(drmBase)
      .filter(d => /^card\d+$/.test(d))
      .sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)));

    const gpus = [];
    let idx = 100;
    for (const card of cards) {
      const vendorPath = path.join(drmBase, card, 'device', 'vendor');
      if (!fs.existsSync(vendorPath)) continue;
      const vendor = fs.readFileSync(vendorPath, 'utf-8').trim();
      if (vendor === '0x10de') continue; // NVIDIA — handled by nvidia-smi
      const isAmd = vendor === '0x1002';
      if (!isAmd) continue;

      let name = 'AMD GPU';
      try {
        const productPath = path.join(drmBase, card, 'device', 'product_name');
        if (fs.existsSync(productPath)) name = fs.readFileSync(productPath, 'utf-8').trim();
      } catch {}

      let vramMB = 0;
      try {
        const totalPath = path.join(drmBase, card, 'device', 'mem_info_vram_total');
        if (fs.existsSync(totalPath)) {
          const totalBytes = parseInt(fs.readFileSync(totalPath, 'utf-8').trim(), 10);
          if (!isNaN(totalBytes)) vramMB = Math.round(totalBytes / (1024 * 1024));
        }
      } catch {}

      gpus.push({
        index: idx++, name, vramMB,
        backend: 'vulkan', isUma: false,
        nonNvidiaPosition: gpus.length,
      });
    }
    return gpus;
  } catch { return []; }
}

// ── macOS: Apple Silicon ─────────────────────────────────────────────────────

async function detectAppleSilicon() {
  try {
    const { stdout } = await execFileP('system_profiler', ['SPHardwareDataType']);
    const memMatch  = stdout.match(/Memory:\s+(\d+)\s+GB/i);
    const chipMatch = stdout.match(/Chip:\s+(.+)/i);
    if (!memMatch || !chipMatch || !/Apple M/i.test(chipMatch[1])) return [];
    const totalGB = parseInt(memMatch[1], 10);
    return [{
      index: 0, name: chipMatch[1].trim(), vramMB: totalGB * 1024,
      backend: 'metal', isUma: true, isPrimary: true, nonNvidiaPosition: 0,
    }];
  } catch { return []; }
}

// ── Vulkan index mapping via --list-devices ──────────────────────────────────
// This is ONLY for resolving the correct Vulkan device index for launch args.
// Device DISCOVERY happens via nvidia-smi / WMI / lspci / sysfs above.

async function enumerateVulkanDevices() {
  const map = new Map();
  if (!fs.existsSync(LLAMA_SERVER)) return map;

  const output = await new Promise((resolve) => {
    let out = '';
    const proc = spawn(LLAMA_SERVER, ['--list-devices'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GGML_VK_VISIBLE_DEVICES: '' },
    });
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { out += c; });
    proc.on('close', () => resolve(out));
    proc.on('error', () => resolve(out));
    setTimeout(() => { try { proc.kill(); } catch {} }, 20000);
  });

  for (const match of output.matchAll(/ggml_vulkan:\s+(\d+)\s*=\s*([^|\n]+)/g)) {
    const idx  = parseInt(match[1], 10);
    const name = match[2].trim().toLowerCase();
    map.set(name, idx);
    const short = name.replace(/\(.*?\)/g, '').trim();
    if (short !== name) map.set(short, idx);
  }
  return map;
}

function matchVulkanIndex(gpuName, vkMap) {
  if (vkMap.size === 0) return undefined;
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

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else { resolve({ stdout: stdout || '', stderr: stderr || '' }); }
    });
  });
}

// ─── Device selection ─────────────────────────────────────────────────────────

function selectDeviceAndModel(devices) {
  const candidates = devices.filter(d => !(EXCLUDE_PRIMARY && d.isPrimary));

  if (candidates.length === 0) {
    log('No non-primary devices found — falling back to CPU');
    const cpu = devices.find(d => d.backend === 'cpu');
    return cpu ? pickModel(cpu) : null;
  }

  for (const device of candidates) {
    const result = pickModel(device);
    if (result) return result;
  }

  const cpu = devices.find(d => d.backend === 'cpu');
  return cpu ? pickModel(cpu) : null;
}

function pickModel(device) {
  for (const model of MODEL_CATALOGUE) {
    if (device.vramMB >= model.minVramMB || device.backend === 'cpu') {
      return { device, model };
    }
  }
  return null;
}

// ─── Model download ───────────────────────────────────────────────────────────

async function ensureModel(model) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const dest = path.join(MODELS_DIR, model.filename);
  if (fs.existsSync(dest)) { log(`Model already present: ${model.filename}`); return dest; }

  const url = `https://huggingface.co/${model.hfRepo}/resolve/main/${model.hfFile}`;
  log(`Downloading model: ${model.displayName}`);
  log(`  from: ${url}`);
  log(`  to:   ${dest}`);

  downloadState.phase    = 'downloading';
  downloadState.modelName = model.id;
  downloadState.progress = 0;

  await downloadFile(url, dest + '.tmp', (pct, receivedBytes, totalBytes, speedBps) => {
    downloadState.progress = pct;
    downloadState.totalMB  = totalBytes  ? +(totalBytes  / 1024 / 1024).toFixed(1) : 0;
    downloadState.speedMBs = speedBps    ? +(speedBps    / 1024 / 1024).toFixed(2) : 0;
    downloadState.etaSecs  = (speedBps > 0 && totalBytes > 0)
      ? Math.round((totalBytes - receivedBytes) / speedBps)
      : 0;
    process.stdout.write(`\r  ${pct}%  ${downloadState.speedMBs} MB/s  ETA ${downloadState.etaSecs}s   `);
  });

  fs.renameSync(dest + '.tmp', dest);
  process.stdout.write('\n');
  log(`Model download complete: ${model.filename}`);
  downloadState.progress = 100;
  return dest;
}

// ─── llama-server management ──────────────────────────────────────────────────
let llamaProc = null;

async function startLlama(device, model, modelPath) {
  stopLlama();
  const serverPort = PORT + 1;
  const cliArgs = buildLlamaArgs(device, model, modelPath, serverPort);
  log(`Starting llama-server: ${LLAMA_SERVER}`);
  log(`  args: ${cliArgs.join(' ')}`);

  llamaProc = spawn(LLAMA_SERVER, cliArgs, {
    env: buildLlamaEnv(device), cwd: path.dirname(LLAMA_SERVER),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  llamaProc.stdout.on('data', (c) => process.stdout.write(c));
  llamaProc.stderr.on('data', (c) => process.stderr.write(c));
  llamaProc.on('exit', (code) => { log(`llama-server exited: ${code}`); llamaProc = null; });
  llamaProc.on('error', (err) => { log(`llama-server error: ${err.message}`); });

  await waitForReady(serverPort);
  return serverPort;
}

function buildLlamaArgs(device, model, modelPath, serverPort) {
  const ngl = device.backend === 'cpu' ? 0 : model.ngl;
  const a = [
    '--model', modelPath, '--port', String(serverPort), '--host', '127.0.0.1',
    '--ctx-size', String(model.contextLength),
    '--n-gpu-layers', String(ngl),
    '--threads', String(Math.min(os.cpus().length, 8)),
    '--log-disable',
  ];

  if (device.backend === 'cuda') {
    // CUDA: --device CUDA0 targets the first visible CUDA device.
    // CUDA_VISIBLE_DEVICES in env restricts which GPU that is.
    a.push('--device', 'CUDA0');
  } else if (device.backend === 'metal') {
    // Metal: no device flag needed, limit layers for shared GPU
    const safeLayers = Math.min(ngl, 20);
    const nglIdx = a.indexOf(String(ngl));
    if (nglIdx !== -1) a[nglIdx] = String(safeLayers);
  }
  // Vulkan: NO --device flag. GGML_VK_VISIBLE_DEVICES in env filters to one
  // device which becomes Vulkan0 automatically. Newer llama.cpp builds
  // reject --device VulkanN style args.
  // CPU: NO --device flag either. GPU backends are suppressed via env vars.

  return a;
}

function buildLlamaEnv(device) {
  const env = { ...process.env };

  if (device.backend === 'cuda') {
    // Show only the target CUDA GPU. Suppress Vulkan iGPU interference.
    env.CUDA_VISIBLE_DEVICES    = String(device.index);
    env.GGML_VK_VISIBLE_DEVICES = '';
  } else if (device.backend === 'vulkan') {
    // Filter Vulkan to the target device only — it becomes Vulkan0 in the
    // filtered set. Hide CUDA and ROCm to prevent context overhead.
    const vkIdx = device.vulkanIndex !== undefined ? device.vulkanIndex : 0;
    env.GGML_VK_VISIBLE_DEVICES = String(vkIdx);
    env.CUDA_VISIBLE_DEVICES    = '-1';
    env.HIP_VISIBLE_DEVICES     = '-1';
  } else if (device.backend === 'cpu') {
    // CPU-only: suppress ALL GPU backends so no VRAM is reserved and no
    // GPU driver initialization happens at all.
    env.CUDA_VISIBLE_DEVICES    = '-1';
    env.HIP_VISIBLE_DEVICES     = '-1';
    env.GGML_VK_VISIBLE_DEVICES = '-1';
  }

  // Linux: llama-server needs its own directory in LD_LIBRARY_PATH for shared libs
  if (process.platform === 'linux') {
    const ld = process.env.LD_LIBRARY_PATH || '';
    env.LD_LIBRARY_PATH = [path.dirname(LLAMA_SERVER), ld].filter(Boolean).join(':');
  }

  return env;
}

async function waitForReady(port) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try { await httpGet(`http://127.0.0.1:${port}/health`); log('llama-server is ready'); return; }
    catch { await sleep(800); }
  }
  throw new Error('llama-server failed to start within 60 seconds');
}

function stopLlama() {
  if (llamaProc) { try { llamaProc.kill('SIGTERM'); } catch {} llamaProc = null; }
}

// ─── Proxy server ─────────────────────────────────────────────────────────────
let activeModel = null, llamaPort = null, isReady = false, activeDevice = null;

// Download progress — updated by ensureModel, read by /health
let downloadState = {
  phase:     'idle',       // 'idle' | 'detecting' | 'downloading' | 'loading' | 'ready'
  progress:  0,            // 0-100
  totalMB:   0,
  speedMBs:  0,
  etaSecs:   0,
  modelName: null,
};

function startProxyServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const status = isReady ? 'ok'
        : downloadState.phase === 'downloading' ? 'downloading'
        : 'starting';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status,
        phase:     downloadState.phase,
        progress:  downloadState.progress,
        totalMB:   downloadState.totalMB,
        speedMBs:  downloadState.speedMBs,
        etaSecs:   downloadState.etaSecs,
        modelName: downloadState.modelName,
        model:     activeModel?.id   || downloadState.modelName || null,
        device:    activeDevice?.name || null,
      }));
      return;
    }
    if (!isReady) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'AI engine is still starting' })); return; }
    proxyToLlama(req, res);
  });
  server.listen(PORT, '127.0.0.1', () => { log(`PHOBOS-Lite proxy listening on port ${PORT}`); });
}

function proxyToLlama(req, res) {
  const proxy = http.request({ hostname: '127.0.0.1', port: llamaPort, path: req.url, method: req.method, headers: req.headers },
    (llamaRes) => { res.writeHead(llamaRes.statusCode, llamaRes.headers); llamaRes.pipe(res); });
  proxy.on('error', (err) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); });
  req.pipe(proxy);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  log(`PHOBOS-Lite starting — mode=${MODE}, port=${PORT}, excludePrimary=${EXCLUDE_PRIMARY}`);
  log(`Models dir: ${MODELS_DIR}`);
  log(`llama-server: ${LLAMA_SERVER}`);
  startProxyServer();

  downloadState.phase = 'detecting';
  const devices   = await detectDevices();
  const selection = selectDeviceAndModel(devices);
  if (!selection) { log('ERROR: No viable device/model combination found.'); downloadState.phase = 'idle'; return; }

  const { device, model } = selection;
  activeDevice = device;
  activeModel  = model;
  downloadState.modelName = model.id;
  log(`Selected device: ${device.name} (${device.backend}, ${device.vramMB} MB)`);
  log(`Selected model:  ${model.displayName}`);

  const modelPath = await ensureModel(model);

  downloadState.phase = 'loading';
  llamaPort = await startLlama(device, model, modelPath);
  isReady = true;
  downloadState.phase = 'ready';
  log(`PHOBOS-Lite ready — model=${model.id}, device=${device.name}`);
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────
process.on('SIGTERM', () => { stopLlama(); process.exit(0); });
process.on('SIGINT',  () => { stopLlama(); process.exit(0); });
process.on('exit',    () => { stopLlama(); });

// ─── Utilities ────────────────────────────────────────────────────────────────
function log(msg) { console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`); }

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { out[argv[i]] = argv[i + 1]?.startsWith('--') ? true : argv[++i] ?? true; }
  }
  return out;
}

function resolveLlamaServer() {
  const dir = path.dirname(process.execPath || __filename);
  return path.join(dir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d)); }).on('error', reject);
  });
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const doGet = (u) => {
      mod.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) return doGet(res.headers.location);
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));

        const total    = parseInt(res.headers['content-length'] || '0', 10);
        let received   = 0;
        let lastBytes  = 0;
        let lastTime   = Date.now();
        const out      = fs.createWriteStream(dest);

        res.on('data', (chunk) => {
          received += chunk.length;
          const now     = Date.now();
          const elapsed = (now - lastTime) / 1000;
          if (elapsed >= 0.75 || received === total) {
            const speed = elapsed > 0 ? (received - lastBytes) / elapsed : 0;
            lastBytes   = received;
            lastTime    = now;
            const pct   = total > 0 ? Math.round(received / total * 100) : 0;
            if (onProgress) onProgress(pct, received, total, speed);
          }
        });

        res.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
      }).on('error', reject);
    };
    doGet(url);
  });
}

// ─── Go ───────────────────────────────────────────────────────────────────────
boot().catch((err) => { log(`FATAL: ${err.message}`); process.exit(1); });
