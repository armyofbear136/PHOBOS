#!/usr/bin/env python3
"""
probe-pytorch-rocm-890m.py — PyTorch ROCm smoke test for 890M / gfx1150.

Run from the rocm venv Python AFTER installing via:
    npx tsx test-pytorch-env.ts install rocm

Then run this with the venv Python directly:
    %USERPROFILE%\.phobos\python-env\rocm\Scripts\python.exe probe-pytorch-rocm-890m.py

Or let test-pytorch-env.ts check do it:
    npx tsx test-pytorch-env.ts check rocm

This script goes further — it allocates tensors, runs a small matmul,
and reports VRAM as PyTorch sees it.
"""

import sys
import time

SEP = "─" * 60

def section(title):
    print(f"\n{SEP}\n  {title}\n{SEP}")

def ok(label, value):
    print(f"  ✓  {label:<35} {value}")

def warn(label, value):
    print(f"  ⚠  {label:<35} {value}")

def fail(label, value):
    print(f"  ✗  {label:<35} {value}")

# ── 1. Import torch ───────────────────────────────────────────────────────────

section("PyTorch Import")

try:
    import torch
    ok("torch version", torch.__version__)
except ImportError as e:
    fail("torch import", str(e))
    print("\n  Run from the rocm venv Python, not system Python.")
    print(f"  Expected: %USERPROFILE%\\.phobos\\python-env\\rocm\\Scripts\\python.exe")
    sys.exit(1)

# ── 2. HIP / CUDA detection ───────────────────────────────────────────────────

section("HIP / ROCm Detection")

hip_ver = getattr(torch.version, "hip", None)
cuda_avail = torch.cuda.is_available()

ok("torch.version.hip", hip_ver if hip_ver else "None — NOT a ROCm build")
ok("torch.cuda.is_available()", str(cuda_avail))

if not cuda_avail:
    fail("GPU access", "torch.cuda.is_available() returned False")
    print("\n  Possible causes:")
    print("  1. Wrong wheel installed — need rocm7.2 not cu12x")
    print("  2. amdhip64.dll not loadable at runtime")
    print("  3. HIP_VISIBLE_DEVICES set to -1 or invalid")
    print("\n  Check torch.__version__ contains '+rocm' suffix:")
    print(f"  {torch.__version__}")
    sys.exit(1)

# ── 3. Device enumeration ─────────────────────────────────────────────────────

section("Device Enumeration")

n = torch.cuda.device_count()
ok("device count", str(n))

if n == 0:
    fail("devices", "device_count() = 0 despite is_available() = True")
    sys.exit(1)

for i in range(n):
    name = torch.cuda.get_device_name(i)
    props = torch.cuda.get_device_properties(i)
    free, total = torch.cuda.mem_get_info(i)
    ok(f"device {i} name", name)
    ok(f"device {i} total VRAM", f"{total // 1024**2} MB ({total / 1024**3:.1f} GB)")
    ok(f"device {i} free VRAM", f"{free // 1024**2} MB")
    ok(f"device {i} compute cap", f"{props.major}.{props.minor}")

# The primary GPU for this test
device = "cuda:0"
name0 = torch.cuda.get_device_name(0)
free0, total0 = torch.cuda.mem_get_info(0)
free0_gb = free0 / 1024**3
total0_gb = total0 / 1024**3

print(f"\n  Using device: {device} ({name0})")
print(f"  VRAM: {free0_gb:.1f} GB free / {total0_gb:.1f} GB total")

# ── 4. Tensor allocation test ─────────────────────────────────────────────────

section("Tensor Allocation")

dtypes_to_test = [
    ("bfloat16", torch.bfloat16),
    ("float16",  torch.float16),
    ("float32",  torch.float32),
]

for name, dt in dtypes_to_test:
    try:
        t = torch.zeros(1024, 1024, dtype=dt, device=device)
        size_mb = t.element_size() * t.nelement() / 1024**2
        del t
        torch.cuda.synchronize()
        ok(f"zeros 1024×1024 {name}", f"{size_mb:.1f} MB — OK")
    except Exception as e:
        fail(f"zeros 1024×1024 {name}", str(e))

# ── 5. Small matmul benchmark ─────────────────────────────────────────────────

section("Matmul Benchmark (bfloat16)")

try:
    a = torch.randn(2048, 2048, dtype=torch.bfloat16, device=device)
    b = torch.randn(2048, 2048, dtype=torch.bfloat16, device=device)

    # Warmup
    _ = torch.matmul(a, b)
    torch.cuda.synchronize()

    # Timed run
    N = 5
    t0 = time.perf_counter()
    for _ in range(N):
        c = torch.matmul(a, b)
    torch.cuda.synchronize()
    elapsed = (time.perf_counter() - t0) / N * 1000

    del a, b, c
    torch.cuda.synchronize()
    ok("2048×2048 bfloat16 matmul", f"{elapsed:.1f} ms/op")

    # Rough TFLOPS estimate
    flops = 2 * 2048**3
    tflops = flops / (elapsed / 1000) / 1e12
    ok("estimated throughput", f"{tflops:.2f} TFLOPS (bfloat16)")

except Exception as e:
    fail("matmul", str(e))

# ── 6. VRAM allocation ceiling ────────────────────────────────────────────────

section("VRAM Allocation Ceiling")

print("  Testing how much VRAM PyTorch can actually allocate…")
print("  (This reveals if the 18 GB DXGI cap bug is present)")

step_gb = 1.0
last_ok = 0.0

try:
    # Try to allocate increasing chunks
    for target_gb in [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 32]:
        try:
            numel = int(target_gb * 1024**3 / 2)  # bfloat16 = 2 bytes
            t = torch.zeros(numel, dtype=torch.bfloat16, device=device)
            last_ok = target_gb
            del t
            torch.cuda.synchronize()
            print(f"    {target_gb:>3} GB — OK")
        except RuntimeError as e:
            if "out of memory" in str(e).lower():
                print(f"    {target_gb:>3} GB — OOM (ceiling ~{last_ok:.0f} GB)")
            else:
                print(f"    {target_gb:>3} GB — ERROR: {e}")
            break
except Exception as e:
    fail("ceiling test", str(e))

# ── 7. Diffusers import ───────────────────────────────────────────────────────

section("Diffusers Stack")

packages = [
    ("diffusers",     "diffusers"),
    ("transformers",  "transformers"),
    ("accelerate",    "accelerate"),
    ("safetensors",   "safetensors"),
    ("gguf",          "gguf"),
]

all_ok = True
for label, pkg in packages:
    try:
        m = __import__(pkg)
        ver = getattr(m, "__version__", "installed")
        ok(label, ver)
    except ImportError as e:
        fail(label, str(e))
        all_ok = False

# ── 8. Summary ────────────────────────────────────────────────────────────────

section("Summary")

ok("ROCm build",  f"{'YES — ' + hip_ver if hip_ver else 'NO'}")
ok("890M visible", f"{'YES' if cuda_avail and n > 0 else 'NO'}")
ok("VRAM ceiling", f"~{last_ok:.0f} GB usable")
ok("Diffusers stack", "OK" if all_ok else "INCOMPLETE — check failures above")

if total0_gb > 16:
    warn("DXGI VRAM cap", f"PyTorch sees {total0_gb:.0f} GB — DXGI over-reports shared RAM as VRAM")
    print("         enable_model_cpu_offload() required for generation")
    print("         OR limit generation to models that fit within ~8 GB")

print()
print("  Next step: run a generation test")
print("  npx tsx test-pytorch-gen.ts chroma")
print()
