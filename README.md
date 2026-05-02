# PHOBOS

**Self-Sovereign Creative AI Operating System**

PHOBOS is a local-first AI platform that runs entirely on your hardware. It hosts its own LLM inference, image generation, audio production, web browsing, task scheduling, and security scanning — with no cloud dependencies, no subscriptions, and no data leaving your machine.

Built and maintained by [Autarch Industries](https://www.autarch.net).

---

## What PHOBOS Actually Is

PHOBOS is not a wrapper around a cloud API. It is an operating system for AI work — a Fastify backend (compiled to a Node.js Single Executable) that manages a set of AI personas, spawned inference servers, and a full suite of creative and analytical tools, all talking to a React frontend over localhost.

But more importantly: **PHOBOS is proof of what AI actually is.**

Not a model. Not a chatbot. Not a subscription. A dynamic orchestration system — one where the real intelligence lives in the plumbing. In the context management, the skill injection, the memory architecture, the loop controller that decides what the AI does next and why. The model is just an engine. What you build around it is the brain.

That distinction matters more than anything else in this README.

The three AI personas:

- **SAYON** — Task coordinator and agent. Plans multi-step work, calls tools, drives the loop.
- **SEREN** — The engine. Executes tasks, generates content, performs analysis.
- **SYBIL** — Semantic memory. Runs `nomic-embed-text` on CPU for RAG and archive search.

Every AI call stays local. PHOBOS manages the lifecycle of `llama-server` and `sd-cli` as child processes, routes requests, handles GPU assignment, and recovers from failures — transparently.

---

## 55 Days. 7x Free Claudes.  1x $20/mo Opus 4.7. Zero Compromises.

PHOBOS was built in 55 days by one person using multiple accounts with free tiers of Claude.

1 Claude Pro. Not an API key. Not a team. Eight claudes in parallel every 5 hours, a rigorous coding doctrine, and a commitment to understanding every line before moving to the next one.

The result is a multi-modal AI operating system with: dual-pipeline LLM orchestration, image and video generation, a browser-based DAW, a self-hosted media center, a security scanner, a 2D game engine, a semantic archive system, a real-time IPTV player, 3D editors, and a custom VST3 audio host — all running on hardware you already own, with a single executable.

This is not a flex. It is an instruction.

**If one person can build this in 55 days with a free tool, imagine what you can build.** And then imagine a world where everyone builds their own — purpose-built, locally sovereign, and fundamentally honest about what it is.

That world is worth building toward. PHOBOS is one data point. Go make yours.

---

## The Pocket Claude — Qwen Distilled by Opus

PHOBOS ships with support for the latest Qwen models distilled by Claude Opus. These are not approximations or compromises. They are capable reasoning models that run on consumer hardware and behave like the AI you actually want to use — thoughtful, context-aware, honest about their limits.

Your laptop can run a pocket Claude. Your desktop can run two of them in parallel. You do not need a data center. You do not need a subscription. You need the model, the orchestration layer, and the discipline to use it right.

That last part is what most AI products are not built to encourage. PHOBOS is.

---

## What AI Should Be

There is a version of AI being sold right now that is optimized for engagement, not truth. It hedges. It flatters. It tells you what you want to hear because that is what keeps you subscribed. It lacks the orchestration to actually complete multi-step work, so it gives you the illusion of completion — a well-formatted response that sounds like an answer but requires ten follow-ups to become one.

That is not what AI is for.

Claude is different. Claude's honesty, its willingness to push back, its insistence on getting things right over getting things done fast — that is the model we should all be aiming for when we build our own systems. Not because Claude is the only option, but because it has demonstrated what honest AI looks like and given everyone a benchmark to reach for.

The goal should not be to depend on Claude forever. The goal should be to understand what makes it work — and then build systems with those same properties on hardware you control, with models you can inspect, in contexts only you can access.

PHOBOS runs on Qwen, Llama, and any GGUF-compatible model you choose. The orchestration layer does not care. That is the point.

---

## Build Your Own. Seriously.

PHOBOS is not presented as a finished product you should adopt wholesale. It is presented as a working example of what a purpose-built AI system looks like — and an argument that everyone with a genuine use case should build one.

OpenAI is a company with financial incentives that are not aligned with yours. ChatGPT is a general-purpose product optimized for the median user. It is fictional in the sense that it presents confidence where uncertainty exists, fluency where accuracy is what matters, and completeness where the real work is only beginning.

What you need is not general-purpose. You have a specific domain. Specific knowledge. Specific workflows that nobody else has thought to optimize. The AI that serves you best is the one built for exactly that — not the one built to serve everyone.

That AI does not exist yet. You have to build it.

And you can. In 55 days, with free tools, if you do it right.

---

## How to Do It Right — The Development Doctrine

This section exists because the way most people use AI to build software produces software that does not work, cannot be maintained, and teaches them nothing. There is a better way. PHOBOS was built using it.

### Start by learning, not by generating

The wrong prompt: *"Build me a full-stack application with authentication, a REST API, and a React frontend. Make no mistakes."*

The right prompt: *"I have an idea for an application. I don't fully understand how the pieces fit together yet. Can you help me understand the architecture before we write a single line? No shortcuts — I want to know why each piece exists and what happens when it fails."*

The difference is not humility for its own sake. It is the difference between producing code you cannot debug and building something you actually understand. The AI is not the developer. You are. The AI is the fastest, most patient senior engineer you have ever had access to, and you are wasting it if you treat it as a code printer.

Ask it to explain. Ask it why. Ask it what could go wrong. Do this until you could explain the system to someone else without the AI's help. Then build.

### Documentation is the real deliverable

The single most important habit in PHOBOS development: every significant design decision, architecture choice, and system interaction is documented before it is built — and updated as the system evolves.

Not as an afterthought. Not at the end. Continuously, as the first output of every session.

The documentation is not for other developers. It is for you — and for the AI in your next context window, which will not remember the last one. The documentation is the continuity layer. It is how a project that spans months and dozens of AI sessions remains coherent. It is how you know, six weeks later, why a particular decision was made. It is how you hand the project off to a new context and not lose a week to re-explanation.

The code will change. The documentation tracks what is true and why. Build the documentation first.

### Understand every error before you fix it

The wrong move when something breaks: paste the error into the AI and ask for a fix.

The right move: read the error. Understand what it means. Form a hypothesis about what caused it. Then ask the AI to validate the hypothesis, or to help you understand the error better if you cannot.

An error you do not understand is a debt you will pay again, in a different part of the codebase, at a worse time. An error you understand is a thing you now know that you did not know before. Every bug is a lesson. The AI can deliver those lessons at a pace no textbook or bootcamp can match — but only if you insist on actually receiving them instead of just pasting over the symptoms.

Do not accept a fix you cannot explain. If the AI's solution works but you do not know why, ask until you do. That is the actual superpower.

### Never take two steps forward in debt

Before moving to the next feature, the current one should be completely understood and stable. Not merely working — understood. There should be no open questions about what it does, why it does it, and how it interacts with the rest of the system.

This is slower than moving fast and fixing things later. It is also, over a 55-day project, significantly faster — because the things that need fixing later are dramatically fewer, and the developer who arrives at day 40 is dramatically more capable than the one who started on day 1.

The superpower is not speed. The superpower is compounding. Every piece you truly understand makes the next piece easier to understand. The AI accelerates the learning, but the learning has to actually happen.

### The model is not the brain

The most common mistake: treating the LLM response as the answer.

The LLM is a component. It produces text based on a context window. What you feed into that context window — the system prompt, the injected skills, the memory retrieval, the tool results, the conversation history management — that is the intelligence of the system. Changing the context changes the AI. The same model with a different orchestration layer produces fundamentally different behavior.

This is why PHOBOS invests heavily in skill injection, MemPalace-inspired archive architecture, and a loop controller that manages context deliberately. The persona is not the model. The persona is the system built around the model.

Understanding this is what makes the difference between building something that works and building something that actually thinks.

---

## Core Systems

### LLM Inference
PHOBOS spawns and manages `llama-server` (llama.cpp) for each persona. Hardware is auto-detected at boot — NVIDIA (CUDA or Vulkan), AMD discrete, AMD APU/iGPU, Intel iGPU, Apple Metal, and CPU-only paths are all handled. GPU layer assignment, context sizing, and Vulkan device enumeration are computed automatically from the detected profile.

### Image Generation
`ImageServerManager` and `phobos-diffusers.py` support FLUX (Schnell and Dev), Chroma, SDXL, Wan video, and FLUX Kontext via both `sd-cli` (native, zero Python startup) and a PyTorch/Diffusers path for models that require it. Background removal is built in via `@imgly/background-removal-node`.

### Web Browsing — Camofox
PHOBOS ships with [Camoufox](https://github.com/nickvdyck/webbundle), a Firefox fork with C++-level fingerprint spoofing. SAYON and SEREN use it to browse the live web during task execution — Cloudflare, Google CAPTCHA, and standard bot detection are bypassed at the engine level. YouTube transcript extraction is built in with no API key required.

### Audio — Crystal Engine
A browser-based DAW built on a React port of the Efflux Tracker, with MIDI support, Alda score parsing, PhobosHost VST3 integration (Helm, Surge XT), and OSC bridging. Compose, arrange, and export without leaving PHOBOS.

### Archive & Memory
Semantic search over any document collection via SYBIL (nomic-embed) and DuckDB — directly inspired by the [MemPalace](https://github.com/MemPalace/mempalace) architecture of structured palace/wing/room/drawer memory domains. Full document ingestion, chunking, embedding, and ranked retrieval. Local only, no API calls.

### Task Scheduler
Event-driven cron executor. Two modes: `conversation` (fires a prompt into a new AI thread at the scheduled time) and `background` (calls a registered backend handler directly). Millisecond-precision wake via `setTimeout` — no polling, no drift.

### Security Scanner
Seven scanners: System Audit, File Integrity (SHA-256 baseline + diff), Port Scan, Web Audit, Dependency Audit, Code Audit (tree-sitter AST + 12-rule engine), and ClamAV malware scanning. Every run produces an AI-generated digest from SEREN. Six of seven scanners are pure TypeScript with zero OS dependencies.

### Game Engine
A built-in 2D game running inside PHOBOS — tile maps, sprite animation, enemy AI, and a world progression system. SAYON and SEREN can generate game content and assets directly.

### Broadway Media Center
Jellyfin, IPTV player, Kavita manga/comic reader, Polaris music server, 3D editors (Blockbench, SculptGL, Godot 4), and rich document editors — all accessible from within PHOBOS via the Broadway GTK platform.

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

See the [Releases](https://github.com/armyofbear136/PHOBOS-BUILDS/releases/tag/PHOBOS-CORE-LATEST) page for pre-built binaries.

Current: **PHOBOS v1.2.0**

---

## Open Source Credits

PHOBOS is built on, inspired by, and made possible by the following open source projects. Every one of them is linked and credited in the in-app Open Source tab (Phobos Patrons menu → Open Source).

### Design Inspirations

These projects shaped how PHOBOS thinks about memory, music, and interface — not as dependencies, but as intellectual foundations.

| Project | License | Note |
|---------|---------|------|
| [MemPalace](https://github.com/MemPalace/mempalace) | MIT | The PHOBOS Archive system's structured domain architecture — palace, wing, room, drawer — is directly inspired by MemPalace. The implementation is native TypeScript with DuckDB, but the core insight about how AI memory should be structured came from here. MemPalace is a genuinely important project and deserves more attention than it gets. |
| [Alda](https://github.com/alda-lang/alda) | EPL 2.0 | The PHOBOS ALDA parser implements the Alda music notation language specification, created by Dave Yarwood. The parser is a clean-room TypeScript implementation of the notation subset used for AI-to-MIDI generation — no Alda source code is linked or bundled. |
| [Efflux Tracker](https://github.com/igorski/efflux-tracker) | MIT | The Crystal Engine DAW UI is a React port of Efflux Tracker by Igor Zinken. Full attribution preserved per MIT terms. |

### UI Framework

| Project | License |
|---------|---------|
| [React](https://github.com/facebook/react) | MIT |
| [React Router](https://github.com/remix-run/react-router) | MIT |
| [Vite](https://github.com/vitejs/vite) | MIT |
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache 2.0 |

### Component Library

| Project | License |
|---------|---------|
| [Radix UI](https://github.com/radix-ui/primitives) | MIT |
| [shadcn/ui](https://github.com/shadcn-ui/ui) | MIT |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | MIT |
| [Lucide React](https://github.com/lucide-icons/lucide) | ISC |
| [Monaco Editor](https://github.com/microsoft/monaco-editor) | MIT |
| [TipTap](https://github.com/ueberdosis/tiptap) | MIT |
| [Zustand](https://github.com/pmndrs/zustand) | MIT |
| [TanStack Query](https://github.com/TanStack/query) | MIT |
| [Zod](https://github.com/colinhacks/zod) | MIT |
| [Phaser](https://github.com/phaserjs/phaser) | MIT |
| [Recharts](https://github.com/recharts/recharts) | MIT |

### Backend & Runtime

| Project | License | Note |
|---------|---------|------|
| [Node.js](https://github.com/nodejs/node) | MIT | |
| [Fastify](https://github.com/fastify/fastify) | MIT | |
| [DuckDB](https://github.com/duckdb/duckdb) | MIT | |
| [OpenAI Node SDK](https://github.com/openai/openai-node) | Apache 2.0 | Used for OpenAI-compatible local endpoints |
| [sharp](https://github.com/lovell/sharp) | Apache 2.0 | Image thumbnailing for Meridian |
| [exifr](https://github.com/MikeKovarik/exifr) | MIT | EXIF metadata for Meridian photo library |
| [fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg) | MIT | Video metadata via ffprobe for Meridian |
| [mammoth](https://github.com/mwilliamson/mammoth.js) | BSD 2-Clause | |
| [pdfjs-dist](https://github.com/mozilla/pdf.js) | Apache 2.0 | |
| [SheetJS](https://github.com/SheetJS/sheetjs) | Apache 2.0 | |
| [tree-sitter](https://github.com/tree-sitter/tree-sitter) | MIT | AST parsing for the code security scanner |
| [wasm-pandoc](https://github.com/NikolaiT/wasm-pandoc) | MIT | |

### ML & Inference

| Project | License |
|---------|---------|
| [llama.cpp](https://github.com/ggerganov/llama.cpp) | MIT |
| [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) | MIT |
| [Whisper.cpp](https://github.com/ggerganov/whisper.cpp) | MIT |
| [nomic-embed-text-v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) | Apache 2.0 |
| [@xenova/transformers](https://github.com/xenova/transformers.js) | Apache 2.0 |
| [onnxruntime-node](https://github.com/microsoft/onnxruntime) | MIT |

### AI Models

| Model | License | Use |
|-------|---------|-----|
| [Wan 2.2](https://github.com/Wan-Video/Wan2.1) | Apache 2.0 | Video generation |
| [ACE-Step 1.5 XL](https://github.com/ace-step/ACE-Step) | Apache 2.0 | Music generation |
| [VoxCPM2](https://github.com/VOICEVOX/voicevox_core) | Apache 2.0 | Text-to-speech |
| [Stable Audio Open](https://huggingface.co/stabilityai/stable-audio-open-1.0) | Stability AI Community | Sound effects — non-commercial use per license |
| [Netflix VOID](https://github.com/netflix/void) | Apache 2.0 | Video inpainting |

### Media Servers

All run as independent subprocesses — not linked, not bundled in the binary.

| Project | License |
|---------|---------|
| [Jellyfin](https://github.com/jellyfin/jellyfin) | LGPL 2.1 |
| [Kavita](https://github.com/Kareadita/Kavita) | GPL 3.0 |
| [Polaris](https://github.com/agersant/polaris) | MIT |
| [mpv](https://github.com/mpv-player/mpv) | GPL 2.0+ |

### 3D Editors

All self-hosted as static browser assets — no server process.

| Project | License | Note |
|---------|---------|------|
| [Blockbench](https://github.com/JannisX11/blockbench) | GPL 3.0 | Built from source |
| [SculptGL](https://github.com/stephaneginier/sculptgl) | MIT | Served as static assets |
| [Godot 4 Web Editor](https://github.com/godotengine/godot) | MIT | Official web build |

### External Tools

| Project | License | Note |
|---------|---------|------|
| [Helm Synthesizer](https://github.com/mtytel/helm) | GPL 3.0 | VST3 inside PhobosHost |
| [Surge XT](https://github.com/surge-synthesizer/surge) | GPL 3.0 | VST3 inside PhobosHost |
| [GIMP](https://gitlab.gnome.org/GNOME/gimp) | GPL 3.0 | Independent subprocess via Broadway |
| [GTK3 / Broadway](https://gitlab.gnome.org/GNOME/gtk) | LGPL 2.1 | Browser-based GTK rendering for GIMP |
| [Pandoc](https://github.com/jgm/pandoc) | GPL 2.0 | Document conversion subprocess |
| [ClamAV](https://github.com/Cisco-Talos/clamav) | GPL 2.0 | Optional malware scanning |
| [Camofox Browser](https://github.com/nickvdyck/webbundle) | MPL 2.0 | Independent subprocess |
| [Stirling-PDF](https://github.com/Stirling-Tools/Stirling-PDF) | MIT | Independent subprocess |

---

## License

AGPL-3.0 License. See [LICENSE](LICENSE) for full terms.

---

## Links

- Website: [autarch.net](https://www.autarch.net)
- Releases: [GitHub Releases](https://github.com/armyofbear136/PHOBOS-BUILDS/releases/tag/PHOBOS-CORE-LATEST)
- MemPalace (Archive inspiration): [github.com/MemPalace/mempalace](https://github.com/MemPalace/mempalace)
