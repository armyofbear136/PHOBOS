#!/usr/bin/env python3
"""
probe-rocm-wheel-index.py — Find actual Windows-compatible PyTorch ROCm wheels.

Run with system Python. Checks multiple potential sources for Windows ROCm wheels.
"""

import urllib.request
import re
import sys

SEP = "─" * 60

def section(title):
    print(f"\n{SEP}\n  {title}\n{SEP}")

def fetch(url, timeout=10):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", errors="replace")
    except Exception as e:
        return None

# ── 1. Check rocm7.x indices for Windows wheels ──────────────────────────────

section("PyTorch ROCm Wheel Index — Windows Availability")

for rocm_ver in ["rocm7.2", "rocm7.1", "rocm7.0", "rocm6.4", "rocm6.3", "rocm6.2"]:
    url = f"https://download.pytorch.org/whl/{rocm_ver}/"
    html = fetch(url)
    if not html:
        print(f"  ✗  {rocm_ver:<12} index fetch failed")
        continue

    # Find torch wheels — look specifically for win_amd64
    win_wheels = re.findall(r'torch-[^\'"<>]+win_amd64[^\'"<>]*\.whl', html)
    all_torch = re.findall(r'torch-[^\'"<>]+\.whl', html)

    if win_wheels:
        print(f"  ✓  {rocm_ver:<12} {len(win_wheels)} Windows wheels found")
        for w in win_wheels[:3]:
            print(f"       {w}")
        if len(win_wheels) > 3:
            print(f"       ... and {len(win_wheels) - 3} more")
    elif all_torch:
        # Show what platforms ARE there
        platforms = set()
        for w in all_torch:
            m = re.search(r'(linux|win|macos|cp\d+)[^\-]*', w.split('-')[-1])
            if m:
                platforms.add(m.group(1))
        print(f"  ⚠  {rocm_ver:<12} {len(all_torch)} torch wheels but NO Windows — platforms: {', '.join(sorted(platforms))}")
    else:
        print(f"  ✗  {rocm_ver:<12} no torch wheels found in index")

# ── 2. AMD's own PyTorch channel ─────────────────────────────────────────────

section("AMD Official PyTorch Channel (rocm.github.io)")

# AMD maintains their own pip index for Windows ROCm wheels
amd_urls = [
    "https://repo.radeon.com/rocm/manylinux/rocm-rel-6.4/",
    "https://repo.radeon.com/rocm/manylinux/rocm-rel-7.2/",
    "https://rocm.github.io/ai-developer-hub/",
]

for url in amd_urls:
    html = fetch(url)
    if html:
        win_wheels = re.findall(r'torch-[^\'"<>]+win_amd64[^\'"<>]*\.whl', html)
        print(f"  {'✓' if win_wheels else '·'}  {url}")
        if win_wheels:
            for w in win_wheels[:3]:
                print(f"       {w}")
    else:
        print(f"  ✗  {url}  (unreachable)")

# ── 3. Check PyPI for torch+rocm Windows wheels ──────────────────────────────

section("PyPI — torch ROCm Windows Wheels")

# PyPI JSON API
html = fetch("https://pypi.org/pypi/torch/json", timeout=15)
if html:
    import json
    try:
        data = json.loads(html)
        latest = data.get("info", {}).get("version", "unknown")
        print(f"  Latest torch on PyPI: {latest}")

        releases = data.get("releases", {})
        # Check recent versions for rocm windows wheels
        recent = sorted(releases.keys(), reverse=True)[:10]
        for ver in recent:
            files = releases[ver]
            win_rocm = [f for f in files if "win" in f.get("filename","") and "rocm" in f.get("filename","").lower()]
            if win_rocm:
                print(f"  ✓  {ver}: {len(win_rocm)} Windows ROCm wheels")
                for f in win_rocm[:2]:
                    print(f"       {f['filename']}")
            elif any("win" in f.get("filename","") for f in files):
                print(f"  ·  {ver}: Windows wheels exist but no ROCm variant")
    except Exception as e:
        print(f"  parse error: {e}")
else:
    print("  fetch failed")

# ── 4. AMD AI Bundle / Adrenalin installer ───────────────────────────────────

section("AMD AI Installer / rocm-sdk Approach")

print("""  AMD's Windows ROCm PyTorch approach as of 2025-2026:

  Option A — AMD's own pip channel (via rocmsdk wheels):
    pip install torch --index-url https://repo.radeon.com/rocm/manylinux/rocm-rel-X.X/

  Option B — Pre-installed with Adrenalin AI bundle:
    The AI drivers bundle includes a Python environment with torch+rocm already
    installed at a path like:
    C:\\Program Files\\AMD\\ROCm\\X.X\\bin\\python.exe
    or similar. Check if this exists.

  Option C — torchvision separate index:
    pip install torch torchvision --extra-index-url https://repo.radeon.com/rocm/...

  Checking known AMD install paths on Windows...""")

import os
from pathlib import Path

amd_paths = [
    Path("C:/Program Files/AMD/ROCm"),
    Path("C:/Program Files (x86)/AMD/ROCm"),
    Path(os.environ.get("PROGRAMFILES", "C:/Program Files")) / "AMD" / "ROCm",
    Path("C:/AMD"),
    Path(os.environ.get("ROCM_PATH", "C:/nonexistent")),
]

for p in amd_paths:
    if p.exists():
        print(f"\n  ✓  Found: {p}")
        # List contents
        try:
            for item in sorted(p.iterdir())[:10]:
                print(f"       {item.name}/")
        except Exception:
            pass

        # Look for Python
        for py in p.rglob("python.exe"):
            print(f"       Python: {py}")

        # Look for torch
        for t in p.rglob("torch"):
            if t.is_dir():
                print(f"       torch: {t}")
                break
    else:
        print(f"  ·  Not found: {p}")

# ── 5. Recommendation ─────────────────────────────────────────────────────────

section("Recommendation")

print("""  The pytorch.org/whl/rocmX.X indices are Linux-only.
  For Windows ROCm PyTorch, the options are:

  1. AMD's repo.radeon.com pip index (if it has Windows wheels for 7.2)
  2. The Adrenalin AI bundle's bundled Python environment
  3. Building from source (not practical for end users)

  PythonEnvManager.ts needs to use AMD's channel for Windows ROCm installs,
  NOT the pytorch.org/whl/rocmX.X index which is Linux-only.
""")
