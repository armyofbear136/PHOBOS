# PHOBOS

**Self-Sovereign Creative AI Operating System**

PHOBOS is a local-first AI platform that runs entirely on your hardware. It hosts its own LLM inference, image generation, audio production, web browsing, task scheduling, and security scanning — with no cloud dependencies, no subscriptions, and no data leaving your machine.

Built and maintained by [Autarch Industries](https://www.autarch.net).

---

## What It Is

PHOBOS is not a wrapper around a cloud API. It is an operating system for AI work — a Fastify backend (compiled to a Node.js Single Executable) that manages a set of AI personas, spawned inference servers, and a full suite of creative and analytical tools, all talking to a React frontend over localhost.

The three AI personas are:

- **SAYON** — Task coordinator and agent. Plans multi-step work, calls tools, drives the loop.
- **SEREN** — The engine. Executes tasks, generates content, performs analysis.
- **SYBIL** — Semantic memory. Runs `nomic-embed-text` on CPU for RAG and archive search.

Every AI call stays local. PHOBOS manages the lifecycle of `llama-server` and `sd-cli` as child processes, routes requests, handles GPU assignment, and recovers from failures — transparently.

---

## Core Systems

### LLM Inference
PHOBOS spawns and manages `llama-server` (llama.cpp) for each persona. Hardware is auto-detected at boot — NVIDIA (CUDA or Vulkan), AMD discrete, AMD APU/iGPU, Intel iGPU, Apple Metal, and CPU-only paths are all handled. GPU layer assignment, context sizing, and Vulkan device enumeration are computed automatically from the detected profile.

### Image Generation
`ImageServerManager` and `phobos-diffusers.py` support FLUX (Schnell and Dev), Chroma, SDXL, Wan video, and FLUX Kontext via both `sd-cli` (native, zero Python startup) and a PyTorch/Diffusers path for models that require it. Background removal is built in via `@imgly/background-removal-node`.

### Web Browsing — Camofox
PHOBOS ships with [Camoufox](https://github.com/redf0x1/camofox-browser), a Firefox fork with C++-level fingerprint spoofing. SAYON and SEREN use it to browse the live web during task execution — Cloudflare, Google CAPTCHA, and standard bot detection are bypassed at the engine level. YouTube transcript extraction is built in with no API key required.

### Audio — Crystal Engine
A browser-based DAW panel (Efflux-derived) with MIDI support, Alda score parsing, Carla rack integration (VST/LV2 plugins via JACK), and OSC bridging. Compose, arrange, and export without leaving PHOBOS.

### Task Scheduler
Event-driven cron executor. Two modes: `conversation` (fires a prompt into a new AI thread at the scheduled time) and `background` (calls a registered backend handler directly). Millisecond-precision wake via `setTimeout` — no polling, no drift.

### Security Scanner
Seven scanners: System Audit, File Integrity (SHA-256 baseline + diff), Port Scan, Web Audit, Dependency Audit, Code Audit (tree-sitter AST + 12-rule engine), and ClamAV malware scanning. Every run produces an AI-generated digest from SEREN. Six of seven scanners are pure TypeScript with zero OS dependencies.

### Archive & Memory
Semantic search over any document collection via SYBIL (nomic-embed) and DuckDB. Full document ingestion, chunking, embedding, and ranked retrieval — local only.

### Game Engine
A built-in 2D game running inside PHOBOS — tile maps, sprite animation, enemy AI, and a world progression system. SAYON and SEREN can generate game content and assets directly.

### Broadway Media Center
Jellyfin integration, IPTV player, Kavita manga/comic reader, Polaris music server, 3D model viewer, and rich document editors — all accessible from within PHOBOS via the Broadway platform.

---

## Build & Distribution

PHOBOS ships as a platform-specific package: a Node.js SEA binary (`phobos-core`) paired with the appropriate `llama-server` and `sd-cli` binaries.

### Supported Platforms

| Platform | Architecture | llama-server Source |
|----------|-------------|-------------------|
| Windows | x64 | llama.cpp GitHub releases |
| macOS | Apple Silicon (arm64) | llama.cpp GitHub releases |
| macOS | Intel (x64) | llama.cpp GitHub releases |
| Linux | x64 | llama.cpp GitHub releases |
| Linux | arm64 | Built from source on ARM runner |

### Local Build

```bash
# First time — fetch all binaries and bundle
npm run build:full

# Dev mode — bundle only (uses whatever is already in bin/)
npm run build

# Explicit platform builds
npm run build:full:win
npm run build:full:mac
npm run build:full:linux
```

Binary versions are pinned in `scripts/bin-manifest.json` (committed to git). CI reads the same manifest, so local and CI builds use identical binaries.

For detailed build documentation including the `bin-master/` reproducibility system, version pinning, and CUDA version constraints, see [`PHOBOS-build-instructions.md`](docs/PHOBOS-build-instructions.md).

### Environment Setup

Copy `.env.example` to `.env` and configure:

```
# Required for GitHub binary downloads (avoids rate limiting)
GITHUB_TOKEN=github_pat_xxxxxxxxxxxx

# Required for Patron Certificate validation (server-side only)
PHOBOS_LICENSE_SEED=
WHITELIST_SECRET=
```

`.env` is gitignored. Never commit it.

---

## Hardware Requirements

**Minimum:** Any machine with 8 GB RAM can run PHOBOS in CPU-only mode with small models (7B quantized).

**Recommended:** NVIDIA GPU (8 GB+ VRAM) for real-time LLM inference and image generation.

**Tested configurations:**
- NVIDIA RTX 3080 (10 GB) — CUDA and Vulkan paths
- AMD Radeon 890M (48 GB UMA, RDNA 3.5) — Vulkan and ROCm paths
- Apple Silicon M-series — Metal unified memory
- CPU-only — all platforms

PHOBOS auto-detects your hardware at boot and configures GPU layers, context size, and binary selection automatically.

---

## Patron System

PHOBOS is free and open source. The Patron Certificate is an optional one-time purchase ($19.99+) that grants a permanent cryptographic license key and a custom display name in the PHOBOS header. Certificates do not gate any functionality — they are flair and a way to support continued development.

Certificates are machine-local (stored at `~/.phobos/license.key`), deterministically regenerable from the original Transaction ID, and recorded permanently in the encrypted Patron registry.

Purchase and activate at [autarch.net/pricing](https://www.autarch.net/pricing).

---

## Releases

See the [Releases](../../releases) page for pre-built binaries.

Current: **PHOBOS v1.0.4**

---

## License

AGPL-3.0 License. See [LICENSE](LICENSE) for full terms.

---

## Links

- Website: [autarch.net](https://www.autarch.net)
- Releases: [GitHub Releases](../../releases)
