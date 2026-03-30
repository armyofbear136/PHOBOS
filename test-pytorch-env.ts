/**
 * test-pytorch-env.ts — Standalone test for PythonEnvManager (multi-venv).
 *
 * Usage:
 *   npx tsx test-pytorch-env.ts status              — show Python + all vendor readiness
 *   npx tsx test-pytorch-env.ts install cuda         — install CUDA PyTorch environment
 *   npx tsx test-pytorch-env.ts install rocm         — install ROCm PyTorch environment
 *   npx tsx test-pytorch-env.ts install xpu          — install Intel XPU environment
 *   npx tsx test-pytorch-env.ts install apple        — install Apple Metal environment
 *   npx tsx test-pytorch-env.ts uninstall cuda       — remove CUDA environment
 *   npx tsx test-pytorch-env.ts uninstall all        — remove all environments
 *   npx tsx test-pytorch-env.ts check cuda           — verify torch import + GPU for a vendor
 */

import {
  getStatus,
  getVendorReadiness,
  install,
  uninstallVendor,
  uninstallAll,
  isVendorReady,
  getPythonPath,
  getEnvRoot,
  getDiskUsage,
  detectPython,
  invalidatePythonCache,
  vendorLabel,
  gpuToVendor,
  PYTHON_INSTALL_LINKS,
  type GpuVendor,
} from './phobos/PythonEnvManager.js';
import { detectHardware } from './phobos/PhobosLocalManager.js';

const command = process.argv[2] ?? 'status';
const arg     = process.argv[3] ?? '';

function isVendor(s: string): s is GpuVendor {
  return ['cuda', 'rocm', 'xpu', 'apple', 'cpu'].includes(s);
}

async function showStatus(): Promise<void> {
  console.log('\n── PythonEnvManager Status ──────────────────────────────\n');
  console.log(`  envRoot: ${getEnvRoot()}`);

  invalidatePythonCache();
  const py = await detectPython();
  console.log(`\n  System Python:`);
  console.log(`    found:   ${py.found}`);
  console.log(`    version: ${py.version ?? '—'}`);
  console.log(`    path:    ${py.path ?? '—'}`);

  if (!py.found) {
    console.log(`\n  Install Python:`);
    console.log(`    Windows: ${PYTHON_INSTALL_LINKS.windows}`);
    console.log(`    macOS:   ${PYTHON_INSTALL_LINKS.mac}`);
    console.log(`    Linux:   ${PYTHON_INSTALL_LINKS.linux}`);
  }

  console.log('\n  Detected GPUs + Vendor Mapping:');
  const hw = await detectHardware();
  for (const gpu of hw.gpus) {
    const vendor = gpuToVendor(gpu);
    const ready = isVendorReady(vendor);
    console.log(`    [${gpu.index}] ${gpu.name} (${gpu.backend}, ${gpu.vramGb} GB) → ${vendorLabel(vendor)} ${ready ? '✓ READY' : '○ not installed'}`);
  }

  console.log('\n  Vendor Environments:');
  const readiness = await getVendorReadiness();
  if (readiness.length === 0) {
    console.log('    (no PyTorch-capable GPUs detected)');
  }
  for (const r of readiness) {
    const usage = r.ready ? await getDiskUsage(r.vendor) : 0;
    const usageStr = usage > 0 ? ` (${(usage / (1024 ** 3)).toFixed(2)} GB)` : '';
    const pyPath = getPythonPath(r.vendor);
    console.log(`    ${r.vendor}: ${r.ready ? '✓ READY' : '○ NOT INSTALLED'}${usageStr}`);
    console.log(`      GPU:    ${r.gpuName}`);
    if (pyPath) console.log(`      Python: ${pyPath}`);
  }

  console.log('');
}

async function runInstall(vendor: string): Promise<void> {
  if (!isVendor(vendor)) {
    console.log(`\n  Unknown vendor: ${vendor}`);
    console.log('  Valid vendors: cuda, rocm, xpu, apple\n');
    process.exit(1);
  }

  console.log(`\n── Installing ${vendorLabel(vendor)} PyTorch Environment ──\n`);

  for await (const p of install(vendor)) {
    const pct = p.progress >= 0 ? ` (${Math.round(p.progress * 100)}%)` : '';
    const prefix = p.done ? (p.error ? '✗' : '✓') : '…';
    console.log(`  ${prefix} [${p.phase}]${pct} ${p.label}`);

    if (p.error) {
      console.error(`\n  ERROR: ${p.error}\n`);
      process.exit(1);
    }
  }

  console.log('\n  Install complete.\n');
  await showStatus();
}

async function runUninstall(target: string): Promise<void> {
  if (target === 'all') {
    console.log('\n  Removing all Python environments…');
    await uninstallAll();
    console.log('  Done.\n');
    return;
  }
  if (!isVendor(target)) {
    console.log(`\n  Unknown vendor: ${target}. Use a vendor name or 'all'.\n`);
    process.exit(1);
  }
  console.log(`\n  Removing ${vendorLabel(target)} environment…`);
  await uninstallVendor(target);
  console.log('  Done.\n');
}

async function runCheck(vendor: string): Promise<void> {
  if (!isVendor(vendor)) {
    console.log(`\n  Unknown vendor: ${vendor}\n`);
    process.exit(1);
  }

  console.log(`\n── ${vendorLabel(vendor)} Environment Check ──\n`);

  const pyPath = getPythonPath(vendor);
  if (!pyPath) {
    console.log(`  Not installed. Run: npx tsx test-pytorch-env.ts install ${vendor}\n`);
    process.exit(1);
  }

  console.log(`  Python: ${pyPath}`);

  const { execFile: ef } = await import('child_process');
  const { promisify: p } = await import('util');
  const exec = p(ef);

  const checkScript = `
import sys, json
r = {"python": sys.version, "torch": None, "cuda_available": False, "cuda_device": None,
     "xpu_available": False, "xpu_device": None, "mps_available": False,
     "diffusers": None, "transformers": None, "gguf": None}
try:
    import torch
    r["torch"] = torch.__version__
    r["cuda_available"] = torch.cuda.is_available()
    if r["cuda_available"]: r["cuda_device"] = torch.cuda.get_device_name(0)
    r["xpu_available"] = hasattr(torch, "xpu") and torch.xpu.is_available()
    if r["xpu_available"]: r["xpu_device"] = torch.xpu.get_device_name(0)
    r["mps_available"] = hasattr(torch.backends, "mps") and torch.backends.mps.is_available()
except Exception as e: r["torch_error"] = str(e)
try:
    import diffusers; r["diffusers"] = diffusers.__version__
except Exception as e: r["diffusers_error"] = str(e)
try:
    import transformers; r["transformers"] = transformers.__version__
except Exception as e: r["transformers_error"] = str(e)
try:
    import gguf; r["gguf"] = getattr(gguf, "__version__", "installed")
except Exception as e: r["gguf_error"] = str(e)
print(json.dumps(r, indent=2))
`;

  try {
    const { stdout } = await exec(pyPath, ['-c', checkScript], { timeout: 60_000 });
    const d = JSON.parse(stdout);
    console.log(`  Python:       ${d.python}`);
    console.log(`  torch:        ${d.torch ?? `ERROR: ${d.torch_error}`}`);
    console.log(`  CUDA:         ${d.cuda_available ? `yes — ${d.cuda_device}` : 'no'}`);
    console.log(`  XPU:          ${d.xpu_available ? `yes — ${d.xpu_device}` : 'no'}`);
    console.log(`  MPS:          ${d.mps_available ? 'yes' : 'no'}`);
    console.log(`  diffusers:    ${d.diffusers ?? `ERROR: ${d.diffusers_error}`}`);
    console.log(`  transformers: ${d.transformers ?? `ERROR: ${d.transformers_error}`}`);
    console.log(`  gguf:         ${d.gguf ?? `ERROR: ${d.gguf_error}`}`);
  } catch (err) {
    console.error(`  Check failed: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log('');
}

// ── Main ─────────────────────────────────────────────────────────────────────

switch (command) {
  case 'status':    showStatus().catch(console.error); break;
  case 'install':   runInstall(arg).catch(console.error); break;
  case 'uninstall': runUninstall(arg).catch(console.error); break;
  case 'check':     runCheck(arg).catch(console.error); break;
  default:
    console.log(`Unknown command: ${command}`);
    console.log('Usage: npx tsx test-pytorch-env.ts [status|install <vendor>|uninstall <vendor|all>|check <vendor>]');
    process.exit(1);
}
