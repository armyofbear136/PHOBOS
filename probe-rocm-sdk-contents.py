#!/usr/bin/env python3
"""
probe-rocm-sdk-contents.py — Inventory the ROCm 7.1 SDK install on Windows.

Finds Python, torch, hiprtc, rocblas, and any pip channels bundled.
"""

import os
import subprocess
from pathlib import Path

SEP = "─" * 60

def section(title):
    print(f"\n{SEP}\n  {title}\n{SEP}")

def ok(label, value=""):
    print(f"  ✓  {label:<40} {value}")

def warn(label, value=""):
    print(f"  ⚠  {label:<40} {value}")

ROCM_BASE = Path("C:/Program Files/AMD/ROCm/7.1")

# ── 1. ROCm 7.1 directory tree ────────────────────────────────────────────────

section("ROCm 7.1 SDK — Top-Level Contents")

if ROCM_BASE.exists():
    for item in sorted(ROCM_BASE.iterdir()):
        size_str = ""
        if item.is_dir():
            try:
                count = sum(1 for _ in item.rglob("*") if _.is_file())
                size_str = f"({count} files)"
            except:
                size_str = "(dir)"
        print(f"  ·  {item.name:<20} {size_str}")
else:
    print(f"  NOT FOUND: {ROCM_BASE}")

# ── 2. Key DLLs inside the SDK ────────────────────────────────────────────────

section("ROCm 7.1 SDK — Key Libraries")

key_libs = [
    "bin/amdhip64.dll",
    "bin/hiprtc.dll",
    "bin/rocblas.dll",
    "bin/MIOpen.dll",
    "bin/hipconfig.exe",
    "bin/rocminfo.exe",
    "bin/hiprtcbuildins.dll",
]

for lib in key_libs:
    p = ROCM_BASE / lib
    if p.exists():
        kb = p.stat().st_size // 1024
        ok(lib, f"{kb} KB")
    else:
        print(f"  ·  {lib:<40} not found")

# ── 3. hipconfig version ──────────────────────────────────────────────────────

section("HIP Version (hipconfig from SDK)")

hipconfig = ROCM_BASE / "bin" / "hipconfig.exe"
if hipconfig.exists():
    try:
        r = subprocess.run([str(hipconfig), "--version"],
                          capture_output=True, text=True, timeout=10)
        print(f"  hipconfig --version: {r.stdout.strip() or r.stderr.strip()}")
    except Exception as e:
        print(f"  failed: {e}")

    try:
        r = subprocess.run([str(hipconfig), "--full"],
                          capture_output=True, text=True, timeout=10)
        for line in r.stdout.splitlines()[:20]:
            print(f"  · {line}")
    except Exception as e:
        print(f"  --full failed: {e}")
else:
    print(f"  hipconfig.exe not found in SDK bin/")

# ── 4. Python inside SDK ──────────────────────────────────────────────────────

section("Python Inside ROCm SDK")

py_candidates = list(ROCM_BASE.rglob("python.exe"))
if py_candidates:
    for p in py_candidates:
        ok(str(p))
        try:
            r = subprocess.run([str(p), "--version"], capture_output=True, text=True, timeout=5)
            print(f"       version: {r.stdout.strip()}")
        except:
            pass
        # Check if torch is installed
        try:
            r = subprocess.run([str(p), "-c", "import torch; print(torch.__version__, torch.version.hip)"],
                              capture_output=True, text=True, timeout=30)
            if r.returncode == 0:
                ok("torch in SDK Python", r.stdout.strip())
            else:
                print(f"       torch: not installed")
        except:
            pass
else:
    print("  No python.exe found inside ROCm SDK")

# ── 5. rocblas Tensile library ────────────────────────────────────────────────

section("rocBLAS Tensile Library (needed for PyTorch)")

tensile_paths = [
    ROCM_BASE / "bin" / "rocblas" / "library",
    ROCM_BASE / "lib" / "rocblas" / "library",
    ROCM_BASE / "bin" / "library",
]

for p in tensile_paths:
    if p.exists():
        files = list(p.glob("*.dat"))
        ok(str(p), f"{len(files)} .dat files")
        for f in sorted(files)[:5]:
            print(f"       {f.name}")
        if len(files) > 5:
            print(f"       ... and {len(files) - 5} more")
    else:
        print(f"  ·  {p}  — not found")

# ── 6. AMD ROCm Windows PyTorch — what actually works ─────────────────────────

section("AMD ROCm Windows PyTorch — Known Working Approaches")

print("""
  FINDING: pytorch.org/whl/rocmX.X indices are Linux-ONLY.
  No public pip channel ships Windows ROCm PyTorch wheels.

  What actually works on Windows for AMD GPU PyTorch:

  A) DirectML (torch-directml) — works TODAY, ships via PyPI:
       pip install torch-directml
       device = "privateuseone"  (or torch_directml.device())
     ✓ Works on any DX12 GPU including 890M
     ✓ No ROCm SDK required
     ✗ Slower than native ROCm, less model coverage
     ✗ Not compatible with HIP/CUDA device API

  B) ZLUDA — HIP-to-CUDA translation layer:
       Intercepts CUDA calls, routes to HIP/ROCm
       Requires manual setup, not pip-installable
     ✓ Full PyTorch CUDA API compatibility
     ✗ Experimental, setup complexity

  C) WSL2 with ROCm (Linux ROCm inside Windows):
       Run Linux PyTorch ROCm inside WSL2
       AMD GPUs pass through to WSL2 via Mesa/AMDGPU-Pro
     ✓ Full ROCm support, pip install works
     ✗ Performance overhead, setup complexity

  D) Wait for AMD Windows ROCm PyTorch:
       AMD has confirmed Windows ROCm PyTorch is in progress
       No public timeline as of early 2026
       The 'rocmsdk' wheels (PyTorch 2.9.1+rocmsdk) are
       workstation GPU only (W7900 etc), not consumer Radeon

  FOR PHOBOS: torch-directml is the viable path for Windows AMD.
""")

# ── 7. Check if torch-directml is already installed ──────────────────────────

section("torch-directml (Current Python)")

try:
    import torch_directml  # type: ignore
    import torch
    ok("torch-directml", torch_directml.__version__)
    ok("torch", torch.__version__)
    dml_device = torch_directml.device()
    ok("device", str(dml_device))
    n = torch_directml.device_count()
    ok("device count", str(n))
    for i in range(n):
        name = torch_directml.device_name(i)
        print(f"  ·  device {i}: {name}")
except ImportError:
    warn("torch-directml", "not installed")
    print("  Install with: pip install torch-directml")
except Exception as e:
    warn("torch-directml", f"error: {e}")

# ── 8. DirectML — what it can do for image gen ────────────────────────────────

section("DirectML for PHOBOS Image Generation")

print("""
  DirectML device API for Diffusers:

    import torch_directml
    device = torch_directml.device(torch_directml.default_device())
    pipe = pipe.to(device)

  Known limitations with Diffusers + DirectML:
  - No torch.compile support
  - No SageAttention / FlashAttention
  - Some ops may fall back to CPU silently
  - GGUF loading (GGUFQuantizationConfig) may have issues
    — needs testing

  VRAM management: DirectML uses system RAM as GPU memory
  (same as the 890M's unified memory model), so the 18 GB
  DXGI misreport issue doesn't apply — DirectML allocates
  what it needs from available system RAM.

  For PHOBOS vendor mapping:
    gpuToVendor() → new 'directml' vendor
    vendorIndexUrl('directml') → '' (torch-directml is on PyPI, no index needed)
    device in phobos-diffusers.py → 'privateuseone:0'
""")
