// phobos-lite/server.js
// Standalone Node.js process. No PHOBOS-core dependency.
//
// Hardware detection uses the EXACT same pipeline as phobos-core
// PhobosLocalManager.ts — tested on NVIDIA, AMD discrete, AMD APU,
// Intel iGPU, Intel Arc, Apple Silicon across Windows/Linux/macOS.
//
// LLM launching mirrors LlamaServerManager.ts exactly:
//   - --device CUDA0 for NVIDIA CUDA path
//   - --device Vulkan0 for non-NVIDIA Vulkan (prevents split-loading)
//   - --device none for ngl=0 CPU-only
//   - CUDA_FORCE_PTX_JIT=1 for Blackwell (RTX 50xx)
//   - CUBLASLT_WORKSPACE_SIZE=0 for ≤12 GB CUDA cards
//   - Tag-path vs field-path reasoning routing per model family
//   - Empty-string env suppression (not '-1') for CPU-only to avoid Maxwell crashes

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

// ─── Model catalogue ──────────────────────────────────────────────────────────
//
// Three tiers, selected by device score:
//
//   score ≥ 2 (discrete GPU — CUDA, discrete Vulkan, Metal):
//     Gemma 4 E4B Q4_K_M — 2.6 GB, 4B effective MoE, ~4 GB VRAM needed.
//     Best quality available in a small footprint. Jinja + deepseek reasoning.
//     Thinking can be toggled via chat_template_kwargs (enable_thinking).
//
//   score 1 (UMA/iGPU — AMD APU, Intel iGPU):
//     Llama 3.1 8B Instruct Q4_K_M — 5.5 GB, loads into shared system RAM.
//     Validated good experience on 890M-class hardware.
//
//   score 0 (CPU):
//     Llama 3.2 3B Instruct Q4_K_M — 2 GB, CPU-only, 4096 ctx hardcoded.
//     Smallest viable model for CPU inference.
//
// Selection in pickModel(): device.score drives which tier is considered.
// minScore gates entry — higher-tier models are skipped on weaker devices.
//
// Reasoning routing — two paths (mirrors LlamaServerManager.ts):
//
//   Field-path models (reasoningFormat: 'deepseek'):
//     llama-server's --reasoning-format deepseek parses <think>...</think> into
//     the reasoning_content field in the streaming delta. Works for Qwen3, Qwen3.5,
//     Gemma 4, Magistral, DeepSeek-R1 Qwen distills, Nanbeige, etc.
//
//   Tag-path models (reasoningFormat: 'none'):
//     <think> tags stay in delta.content for client-side extraction.
//     Used for: Nemotron 3 (special token IDs 12/13), Phi-4 mini reasoning
//     (phi-4 template), Ministral 3 Reasoning (Mistral v7 template), SmolLM3.
//
//   alwaysThink: only for R1-distill models that ALWAYS produce <think> tags
//     and have no off-switch (Phi-4 mini, Ministral 3, SmolLM3). Sets --reasoning on.
//     NOT set for Gemma 4 / Qwen3 — it overrides enable_thinking:false and causes
//     thinking bleed on coordinator (no-think) calls.
const MODEL_CATALOGUE = [
  {
    id:            'gemma4-e4b-q4',
    displayName:   'Gemma 4 E4B Q4_K_M',
    filename:      'google_gemma-4-E4B-it-Q4_K_M.gguf',
    hfRepo:        'bartowski/google_gemma-4-E4B-it-GGUF',
    hfFile:        'google_gemma-4-E4B-it-Q4_K_M.gguf',
    minScore:      2,      // discrete GPU only (CUDA=4, Metal=3, discrete Vulkan=2)
    contextLength: 8192,
    ngl:           99,
    jinjaTemplate:    true,
    reasoningFormat:  'deepseek',  // field-path: <think> parsed into reasoning_content
    alwaysThink:      false,       // has enable_thinking toggle — do NOT force --reasoning on
    extraBodyNoThink: { reasoning_format: 'none', chat_template_kwargs: { enable_thinking: false } },
  },
  {
    id:            'llama-3.1-8b-instruct-q4',
    displayName:   'Llama 3.1 8B Instruct (Q4_K_M)',
    filename:      'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    hfRepo:        'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',
    hfFile:        'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf',
    minScore:      1,      // iGPU/UMA (score=1) and above
    contextLength: 8192,
    ngl:           99,
    jinjaTemplate:    false,
    reasoningFormat:  null,
    alwaysThink:      false,
    extraBodyNoThink: {},
  },
  {
    id:            'llama-3.2-3b-instruct-q4',
    displayName:   'Llama 3.2 3B Instruct (Q4_K_M)',
    filename:      'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    hfRepo:        'bartowski/Llama-3.2-3B-Instruct-GGUF',
    hfFile:        'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    minScore:      0,      // CPU fallback (score=0)
    contextLength: 4096,
    ngl:           0,
    jinjaTemplate:    false,
    reasoningFormat:  null,
    alwaysThink:      false,
    extraBodyNoThink: {},
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
  } else {
    log('Vulkan runtime enumeration unavailable — using positional fallback');
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
    // NOTE: vulkanIndex can be 0 (falsy) — always use explicit undefined check.
    const vkIdx         = runtimeIdx !== undefined ? runtimeIdx : positionalIdx;

    devices.push({
      index: gpu.index, name: gpu.name, vramMB: gpu.vramMB,
      backend: gpu.backend, score: gpu.isUma ? 1 : (gpu.backend === 'metal' ? 3 : 2),
      isPrimary: gpu.isPrimary ?? (vkIdx === 0),
      vulkanIndex: vkIdx, isUma: gpu.isUma, isIntelArc: gpu.isIntelArc,
    });
  }

  devices.sort((a, b) => b.score - a.score || b.vramMB - a.vramMB);

  log(`Detected ${devices.length} compute devices:`);
  for (const d of devices) {
    log(`  [${d.index}] ${d.name} — ${d.vramMB} MB — ${d.backend} — score ${d.score}${d.isPrimary ? ' (PRIMARY/GAME GPU — excluded)' : ''}${d.vulkanIndex !== undefined ? ` — vk${d.vulkanIndex}` : ''}${d.isUma ? ' (UMA)' : ''}${d.isIntelArc ? ' (Arc discrete)' : ''}`);
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
//
// unifiedMemory classification (Session 18 fix):
//   AMD APU (890M, 780M, 680M): unifiedMemory=true — BIOS-partitioned UMA
//   Intel iGPU (UHD, Iris — NOT Arc): unifiedMemory=true — shares system RAM
//   Intel Arc (A750, A770, etc.): unifiedMemory=false — discrete GDDR6
//   AMD discrete (RX series, Vega, Navi): unifiedMemory=false — dedicated GDDR

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
      const isAmd   = /AMD|Radeon|ATI/i.test(name);
      const isIntel = /Intel/i.test(name);
      let vramMB = 0;
      let isUma  = false;

      if (hasQwMemory) {
        vramMB = Math.round(qwVramBytes / (1024 * 1024));
        // AMD discrete vs APU classification:
        // Discrete: RX 6600, RX 7900 XTX, RX 9060 XT, Vega 64, Navi, WX series
        // APU iGPU: Radeon 890M, 780M, 680M (3-digit + M suffix)
        const amdDiscretePattern = /\bRX\s*\d{3,4}\b|\bVega\s*\d{2}\b|\bNavi\b|\bRDNA\b|\bRadeon\s*(?:\(TM\)\s*|\(R\)\s*|®\s*)?(?:HD\s*)?\d{3,4}\b|\bR[5-9]\b|\bWX\b/i;
        const amdApuPattern = /\d{3}M\b/i;
        const isAmdDiscrete = isAmd && amdDiscretePattern.test(name) && !amdApuPattern.test(name);

        // Session 18 fix: split AMD APU vs Intel iGPU vs Intel Arc.
        // Intel Arc has dedicated GDDR6 — it is discrete, NOT unified memory.
        // The old code `if (!isAmdDiscrete && (isAmd || isIntel))` incorrectly
        // tagged Arc as unified, preventing VRAM offload rules from firing.
        if (!isAmdDiscrete && isAmd) {
          isUma = true;  // AMD APU (890M, 780M): BIOS-partitioned UMA
        } else if (isIntel && !isIntelArc) {
          isUma = true;  // Intel iGPU (UHD, Iris): shares system RAM. Arc excluded.
        }
      } else if (isIntelArc) {
        // Intel Arc discrete — should write qwMemorySize but may not on older drivers.
        // Use AdapterRAM as fallback; unreliable but better than nothing.
        vramMB = Math.round(adapterBytes / (1024 * 1024));
      } else {
        log(`  ${name}: skipped — no dedicated/UMA memory (shared aperture only)`);
        continue;
      }

      if (vramMB < 1024) {
        log(`  ${name}: skipped — ${vramMB} MB below minimum`);
        continue;
      }

      // Count Vulkan-visible position (skip virtual adapters).
      // Intel/AMD GPUs (even iGPUs with only shared memory) DO have Vulkan ICDs
      // and DO shift the Vulkan slot numbers. Virtual display adapters (Parsec,
      // TeamViewer, etc.) do NOT.
      let vulkanVisiblePosition = 0;
      for (let j = 0; j < i; j++) {
        const prevName = String(items[j].Name || '');
        const isReal = /Intel|AMD|Radeon|ATI/i.test(prevName)
          && !/Parsec|Remote|Virtual|TeamViewer|Indirect|IDD/i.test(prevName);
        if (isReal) vulkanVisiblePosition++;
      }

      gpus.push({
        index: 100 + nonNvidiaIdx, name, vramMB,
        backend: 'vulkan', isUma, isIntelArc,
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

    // Intel Arc detection — discrete GPU with dedicated GDDR6.
    // NOT unified memory. Must not be tagged as UMA.
    const isIntelArc = isIntel && /Arc/i.test(name);

    let vramMB = 0;
    let isUma = false;

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

      // Unified memory classification for AMD on Linux.
      // APU iGPUs: match ###M pattern (890M, 780M, 680M).
      const amdDiscretePattern = /\bRX\s*\d{3,4}\b|\bVega\s*\d{2}\b|\bNavi\b/i;
      const amdApuPattern = /\d{3}M\b/i;
      const isAmdDiscrete = amdDiscretePattern.test(name) && !amdApuPattern.test(name);
      if (!isAmdDiscrete) isUma = true;
    } else if (isIntel) {
      // Intel on Linux: read VRAM from sysfs for Arc, otherwise estimate.
      try {
        const cards = fs.readdirSync('/sys/class/drm')
          .filter(d => /^card\d+$/.test(d))
          .sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)));
        for (const card of cards) {
          const vendorPath = path.join('/sys/class/drm', card, 'device', 'vendor');
          if (!fs.existsSync(vendorPath)) continue;
          if (fs.readFileSync(vendorPath, 'utf-8').trim() !== '0x8086') continue;
          // Intel Arc has lmem_total_bytes in sysfs (dedicated VRAM)
          const lmemPath = path.join('/sys/class/drm', card, 'device', 'lmem_total_bytes');
          if (fs.existsSync(lmemPath)) {
            const totalBytes = parseInt(fs.readFileSync(lmemPath, 'utf-8').trim(), 10);
            if (!isNaN(totalBytes) && totalBytes > 0) {
              vramMB = Math.round(totalBytes / (1024 * 1024));
              log(`  ${name}: sysfs lmem ${vramMB} MB (${card})`);
            }
          }
          break;
        }
      } catch { /* sysfs read failed */ }

      // Intel iGPU (UHD, Iris) is unified. Intel Arc is discrete.
      if (!isIntelArc) isUma = true;
    }

    gpus.push({
      index: idx++, name, vramMB,
      backend: 'vulkan', isUma, isIntelArc,
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

      const isAmd   = vendor === '0x1002';
      const isIntel = vendor === '0x8086';
      if (!isAmd && !isIntel) continue;

      let name = isAmd ? 'AMD GPU' : 'Intel GPU';
      try {
        const productPath = path.join(drmBase, card, 'device', 'product_name');
        if (fs.existsSync(productPath)) name = fs.readFileSync(productPath, 'utf-8').trim();
      } catch {}

      const isIntelArc = isIntel && /Arc/i.test(name);

      let vramMB = 0;
      if (isAmd) {
        try {
          const totalPath = path.join(drmBase, card, 'device', 'mem_info_vram_total');
          if (fs.existsSync(totalPath)) {
            const totalBytes = parseInt(fs.readFileSync(totalPath, 'utf-8').trim(), 10);
            if (!isNaN(totalBytes)) vramMB = Math.round(totalBytes / (1024 * 1024));
          }
        } catch {}
      } else if (isIntel) {
        try {
          const lmemPath = path.join(drmBase, card, 'device', 'lmem_total_bytes');
          if (fs.existsSync(lmemPath)) {
            const totalBytes = parseInt(fs.readFileSync(lmemPath, 'utf-8').trim(), 10);
            if (!isNaN(totalBytes)) vramMB = Math.round(totalBytes / (1024 * 1024));
          }
        } catch {}
      }

      // Unified memory: AMD non-discrete = UMA, Intel non-Arc = UMA
      const amdDiscretePattern = /\bRX\s*\d{3,4}\b|\bVega\s*\d{2}\b|\bNavi\b/i;
      const amdApuPattern = /\d{3}M\b/i;
      const isAmdDiscrete = isAmd && amdDiscretePattern.test(name) && !amdApuPattern.test(name);
      const isUma = (isAmd && !isAmdDiscrete) || (isIntel && !isIntelArc);

      gpus.push({
        index: idx++, name, vramMB,
        backend: 'vulkan', isUma, isIntelArc,
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
      isIntelArc: false,
    }];
  } catch { return []; }
}

// ── Vulkan index mapping via --list-devices ──────────────────────────────────
// ONLY for resolving the correct Vulkan device index for launch args.
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
  // Catalogue is ordered best→worst. Pick the first model whose minScore
  // the device meets. CPU (score=0) always matches the last entry.
  for (const model of MODEL_CATALOGUE) {
    if (device.score >= model.minScore) {
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

  const env = buildLlamaEnv(device);
  log(`  env: ${Object.entries(env).filter(([k]) => /CUDA|HIP|GGML|VK_ICD|ROCR|CUBLAS|LD_LIBRARY/.test(k)).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`);

  llamaProc = spawn(LLAMA_SERVER, cliArgs, {
    env, cwd: path.dirname(LLAMA_SERVER),
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

  // Cap Metal layers — Apple Silicon shared memory, conservative to leave headroom.
  const effectiveNgl = device.backend === 'metal' ? Math.min(ngl, 20) : ngl;

  const a = [
    '--model', modelPath, '--port', String(serverPort), '--host', '127.0.0.1',
    '--ctx-size', String(device.backend === 'cpu' ? 4096 : model.contextLength),
    '--n-gpu-layers', String(effectiveNgl),
    '--threads', String(Math.min(os.cpus().length, 8)),
    '--log-disable',
  ];

  // ── Device targeting ──────────────────────────────────────────────────────
  //
  // ngl=0: suppress all GPU backends — prevents VRAM reservation on the game GPU.
  // Without --device none, llama.cpp still offloads some matmuls even at ngl=0.
  if (effectiveNgl === 0) {
    a.push('--device', 'none');
  } else if (device.backend === 'cuda') {
    // --device CUDA0: required in newer llama.cpp builds alongside CUDA_VISIBLE_DEVICES.
    // env var alone is no longer sufficient for explicit device selection.
    a.push('--device', 'CUDA0');
  } else if (device.backend === 'vulkan') {
    // --device Vulkan0: GGML_VK_VISIBLE_DEVICES filters to one device, which becomes
    // Vulkan0 in the filtered set. --device Vulkan0 explicitly pins all tensor allocation
    // to that device, preventing the Vulkan backend from split-loading layers between
    // device VRAM and system RAM (the 890M symptom: model half in VRAM, half in RAM).
    // Confirmed working on b8665 — test-model-parse.ts passes all 12 models with it.
    a.push('--device', 'Vulkan0');
  }
  // Metal: no --device flag. Metal auto-selects the only GPU.

  // ── Jinja chat template + reasoning-format routing ──────────────────────────
  //
  // Tag-path vs field-path reasoning routing (mirrors LlamaServerManager.ts):
  //
  //   Field-path (--reasoning-format deepseek):
  //     llama-server parses <think>...</think> into reasoning_content in the
  //     streaming delta. Standard for Qwen3, Qwen3.5, Gemma 4, Magistral,
  //     DeepSeek-R1, Nanbeige.
  //
  //   Tag-path (--reasoning-format none):
  //     <think> tags stay in delta.content for client-side extraction.
  //     Used for models where deepseek parsing fails or mismatches:
  //     • Nemotron 3 — special token IDs 12/13, deepseek parsing silently fails
  //     • Phi-4 mini reasoning — phi-4 template format, deepseek doesn't match
  //     • Ministral 3 Reasoning — Mistral v7 template, confirmed working tag-path
  //     • SmolLM3 — HuggingFace template, confirmed working tag-path
  //
  //   --reasoning on: only for models that ALWAYS think with no off-switch
  //     (R1-distill models: Phi-4 mini, Ministral 3, SmolLM3).
  //     NOT set for Gemma 4 / Qwen3 — it overrides enable_thinking:false
  //     and causes thinking bleed on coordinator (no-think) calls.
  if (model.jinjaTemplate) {
    const rf = model.reasoningFormat || 'deepseek';
    a.push('--jinja', '--reasoning-format', rf);
    if (model.alwaysThink) {
      a.push('--reasoning', 'on');
    }
  }

  return a;
}

// ── Build environment for GPU device targeting ────────────────────────────────
// Mirrors LlamaServerManager.ts startServer() env construction exactly.

function buildLlamaEnv(device) {
  const env = { ...process.env };

  if (device.backend === 'cuda') {
    // CUDA_VISIBLE_DEVICES=N: filter to target GPU — it becomes CUDA0.
    // Suppress Vulkan to prevent iGPU interference.
    env.CUDA_VISIBLE_DEVICES    = String(device.index);
    env.GGML_VK_VISIBLE_DEVICES = '';

    // Blackwell GPUs (RTX 5060/5070/5080/5090, sm_120): sd-cli and llama-server
    // release binaries lack native sm_120 cubins. Without PTX JIT the CUDA runtime
    // finds no matching binary and fails. First invocation has 5-10s JIT delay.
    // CRITICAL: must NOT be set on pre-Blackwell — causes OOM on RTX 3080 from
    // JIT workspace allocation consuming VRAM.
    const isBlackwell = /\b50[6789]0\b|\bblackwell\b/i.test(device.name);
    if (isBlackwell) {
      env.CUDA_FORCE_PTX_JIT = '1';
      log(`[lite] Blackwell GPU detected (${device.name}) — PTX JIT enabled`);
    }

    // ≤12 GB CUDA: suppress cuBLASLt workspace allocation to preserve VRAM.
    // cuBLASLt pre-allocates a large workspace (up to ~512 MB) for matmul.
    // On cards with 8-12 GB this leaves insufficient memory for KV cache.
    if (device.vramMB <= 12288) {
      env.CUBLAS_WORKSPACE_CONFIG = ':0:0';
      env.CUBLASLT_WORKSPACE_SIZE = '0';
    }
  } else if (device.backend === 'vulkan') {
    // GGML_VK_VISIBLE_DEVICES=N: filter Vulkan to the target device —
    // it becomes Vulkan0 in the filtered set. Hide CUDA and ROCm.
    //
    // CRITICAL: use device.vulkanIndex, NOT device.index.
    // device.index is our internal index (100+ for non-NVIDIA).
    // device.vulkanIndex is what the Vulkan runtime assigned (0, 1, 2...).
    // On a mixed NVIDIA+AMD system:
    //   device.index=100 → 890M → vulkanIndex=1 (NVIDIA holds Vulkan0).
    // Passing GGML_VK_VISIBLE_DEVICES=100 would select a non-existent device
    // and fall back to Vulkan0 (the NVIDIA card) — wrong GPU.
    const vkIdx = device.vulkanIndex !== undefined ? device.vulkanIndex : 0;
    env.GGML_VK_VISIBLE_DEVICES = String(vkIdx);
    env.CUDA_VISIBLE_DEVICES    = '-1';
    env.HIP_VISIBLE_DEVICES     = '-1';
    log(`[lite] Vulkan device: index=${device.index} -> GGML_VK_VISIBLE_DEVICES=${vkIdx}`);
  } else if (device.backend === 'metal') {
    // Metal on macOS — no env vars needed. Metal auto-selects the only GPU.
    // Do NOT suppress CUDA or Vulkan — they aren't present on macOS ARM.
  } else if (device.backend === 'cpu') {
    // CPU-only: suppress ALL GPU backends so no VRAM is reserved and no
    // GPU driver initialization happens at all.
    //
    // Use empty strings ('') instead of '-1' for CUDA_VISIBLE_DEVICES:
    // some older Maxwell-era drivers (Quadro M2000, compute 5.2) crash on -1
    // as it's not part of the CUDA spec. Empty string is the documented way
    // to hide all devices.
    env.CUDA_VISIBLE_DEVICES    = '';
    env.HIP_VISIBLE_DEVICES     = '';
    env.ROCR_VISIBLE_DEVICES    = '';
    env.GGML_VK_VISIBLE_DEVICES = '';
    // VK_ICD_FILENAMES='' prevents the Vulkan loader finding any ICD at all —
    // deepest available suppression, covers all Vulkan code paths.
    env.VK_ICD_FILENAMES        = '';
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

  const resolvedModelPath = await ensureModel(model);

  downloadState.phase = 'loading';
  llamaPort = await startLlama(device, model, resolvedModelPath);
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
