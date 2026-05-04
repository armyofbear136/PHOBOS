#!/usr/bin/env node
// scripts/fetch-audio-deps.js
//
// Downloads all generative audio dependencies for local testing.
// Currently points directly at HuggingFace and GitHub sources.
// Once files are uploaded to PHOBOS-DEPS, swap PHOBOS_DEPS_BASE and
// HF_BASE for the appropriate constants and remove the per-file url overrides.
//
// Usage:
//   node scripts/fetch-audio-deps.js                        — all deps
//   node scripts/fetch-audio-deps.js --skip-models          — binaries only (no large weights)
//   node scripts/fetch-audio-deps.js --only kokoro          — single dep group
//   node scripts/fetch-audio-deps.js --only acestep-models  — just ACE-Step GGUFs
//   GITHUB_TOKEN=ghp_xxx node scripts/fetch-audio-deps.js
//
// Dep groups: kokoro | whisper | acestep | acestep-models | f5tts | stable-audio
//
// File destinations (all under PHOBOS_HOME = ~/.phobos):
//
//   services/kokoro/
//     model_quantized.onnx          ← PHOBOS-DEPS (small, ~86 MB)
//     voices.bin             ← PHOBOS-DEPS (small)
//     tokens.txt             ← PHOBOS-DEPS (small)
//
//   services/whisper/
//     whisper-cli            ← PHOBOS-DEPS (binary, build from source first)
//     ggml-large-v3.bin      ← HuggingFace (large, ~3.1 GB)
//
//   services/acestep/
//     ace-lm                 ← PHOBOS-DEPS (binary, build from source first)
//     ace-synth              ← PHOBOS-DEPS (binary, build from source first)
//     models/
//       acestep-v15-sft-Q8_0.gguf        ← HuggingFace (large)
//       vae-BF16.gguf                    ← HuggingFace (large)
//       Qwen3-Embedding-0.6B-Q8_0.gguf  ← HuggingFace (medium)
//       acestep-5Hz-lm-1.7B-Q8_0.gguf   ← HuggingFace (large)
//
//   models/audio/f5-tts/f5-tts-v1-base/F5TTS_v1_Base/
//     model_1250000.safetensors  ← HuggingFace (large, ~1.2 GB)
//     vocab.txt                  ← PHOBOS-DEPS (small)
//
//   models/audio/stable-audio/stable-audio-open-1b/
//     model.safetensors      ← HuggingFace (large, ~3.9 GB)
//     model_config.json      ← PHOBOS-DEPS (small)
//     config.json            ← PHOBOS-DEPS (small)

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import https from 'node:https';
import http  from 'node:http';
import zlib  from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Destination roots ─────────────────────────────────────────────────────────
// Swap PHOBOS_DEPS_BASE to your PHOBOS-DEPS release URL when ready.

const PHOBOS_HOME      = process.env.PHOBOS_DATA_DIR ?? path.join(os.homedir(), '.phobos');
const SERVICES_DIR     = path.join(PHOBOS_HOME, 'services');
const AUDIO_MODELS_DIR = path.join(PHOBOS_HOME, 'models', 'audio');

// ── URL bases — swap these when migrating to PHOBOS-DEPS ─────────────────────

const HF_BASE         = 'https://huggingface.co';
// const PHOBOS_DEPS_BASE = 'https://github.com/armyofbear136/PHOBOS-BUILDS/releases/download/PHOBOS-DEPS';

// ── CLI args ──────────────────────────────────────────────────────────────────

const args        = process.argv.slice(2);
const skipModels  = args.includes('--skip-models');
const onlyIdx     = args.indexOf('--only');
const onlyGroup   = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

const HF_TOKEN = process.env.HF_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
if (!HF_TOKEN) {
  console.warn('⚠  HF_TOKEN not set — HuggingFace requests are unauthenticated.');
  console.warn('   Gated repos (Stable Audio) will fail with 401. Set HF_TOKEN=hf_xxx\n');
}

// ── HTTP with redirect following ─────────────────────────────────────────────

function get(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 12) { reject(new Error(`Too many redirects: ${target}`)); return; }
      let parsed;
      try { parsed = new URL(target); } catch { reject(new Error(`Bad URL: ${target}`)); return; }

      const isGh  = parsed.hostname === 'github.com' || parsed.hostname === 'api.github.com';
      const isHf  = parsed.hostname === 'huggingface.co';
      const hdrs  = {
        'User-Agent': 'phobos-fetch-audio/1.0',
        ...(isGh && HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {}),
        ...(isHf && HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {}),
        ...extraHeaders,
      };

      const proto = parsed.protocol === 'https:' ? https : http;
      proto.get(
        { hostname: parsed.hostname,
          port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path:     parsed.pathname + parsed.search,
          headers:  hdrs },
        res => {
          if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            follow(res.headers.location, hops + 1);
          } else {
            resolve(res);
          }
        }
      ).on('error', reject);
    };
    follow(url);
  });
}

// ── Byte formatter ────────────────────────────────────────────────────────────

function fmt(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}

// ── Download with resume + progress ──────────────────────────────────────────

async function download(label, url, destPath, minBytes = 0) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  if (fs.existsSync(destPath)) {
    const sz = fs.statSync(destPath).size;
    if (sz >= minBytes) {
      console.log(`  ✓  ${label} — already present (${fmt(sz)})`);
      return true;
    }
    console.log(`  ↻  ${label} — too small (${fmt(sz)} < ${fmt(minBytes)}), re-downloading`);
    fs.unlinkSync(destPath);
  }

  const tmpPath  = destPath + '.tmp';
  const existing = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
  const hdrs     = existing > 0 ? { Range: `bytes=${existing}-` } : {};

  process.stdout.write(`  ↓  ${label}`);
  if (existing > 0) process.stdout.write(` (resuming from ${fmt(existing)})`);
  process.stdout.write('\n');

  let res;
  try {
    res = await get(url, hdrs);
  } catch (err) {
    console.error(`     ✗ connection error: ${err.message}`);
    return false;
  }

  if (res.statusCode === 404) {
    res.resume();
    console.error(`     ✗ 404 — not found: ${url}`);
    return false;
  }
  if (res.statusCode !== 200 && res.statusCode !== 206) {
    res.resume();
    console.error(`     ✗ HTTP ${res.statusCode} for ${url}`);
    return false;
  }

  const fromHeader = parseInt(res.headers['content-length'] ?? '0', 10);
  const total      = res.statusCode === 206 ? existing + fromHeader : fromHeader;

  await new Promise((resolve, reject) => {
    const fd = fs.createWriteStream(tmpPath, { flags: existing > 0 ? 'a' : 'w' });
    let received = existing;
    let lastPct  = -1;

    res.on('data', chunk => {
      received += chunk.length;
      if (!fd.write(chunk)) { res.pause(); fd.once('drain', () => res.resume()); }
      if (total > 0) {
        const pct = Math.floor(received / total * 100);
        if (pct !== lastPct && pct % 5 === 0) {
          process.stdout.write(`\r     ${String(pct).padStart(3)}%  ${fmt(received)} / ${fmt(total)}  `);
          lastPct = pct;
        }
      }
    });
    res.on('end',    () => fd.end());
    fd.on('finish', () => {
      process.stdout.write(total > 0
        ? `\r     100%  ${fmt(received)} / ${fmt(total)}\n`
        : `\r     ${fmt(received)} received\n`);
      resolve();
    });
    fd.on('error', reject);
    res.on('error', reject);
  });

  fs.renameSync(tmpPath, destPath);
  console.log(`     ✓ saved to ${destPath}`);
  return true;
}

// ── tar.gz single-file extractor (for whisper binary archive) ─────────────────

async function extractFromTarGz(archivePath, targetName, destPath) {
  return new Promise((resolve, reject) => {
    const input  = fs.createReadStream(archivePath);
    const gunzip = zlib.createGunzip();
    let outFd    = null;
    let buf      = Buffer.alloc(0);
    let state    = 'header';
    let remaining = 0;
    let dataSize  = 0;

    const fail = (err) => { outFd?.destroy(); input.destroy(); reject(err); };

    const process_ = () => {
      while (true) {
        if (state === 'header') {
          if (buf.length < 512) return;
          const header = buf.subarray(0, 512);
          buf = buf.subarray(512);
          if (header.every(b => b === 0)) continue;
          const typeFlag    = String.fromCharCode(header[156]);
          const rawName     = header.subarray(0, 100).toString('utf8').replace(/\0.*/, '');
          const fileBytes   = parseInt(header.subarray(124, 136).toString('ascii').trim(), 8) || 0;
          const paddedBytes = Math.ceil(fileBytes / 512) * 512;
          if (typeFlag !== '0' && typeFlag !== '\0') { state = 'data-skip'; remaining = paddedBytes; continue; }
          const basename = rawName.split('/').pop();
          if (basename === targetName) {
            outFd = fs.createWriteStream(destPath);
            outFd.on('error', fail);
            state = 'data-target'; dataSize = fileBytes; remaining = paddedBytes;
          } else {
            state = 'data-skip'; remaining = paddedBytes;
          }
          continue;
        }
        if (state === 'data-skip') {
          if (remaining === 0) { state = 'header'; continue; }
          const take = Math.min(remaining, buf.length);
          buf = buf.subarray(take); remaining -= take;
          if (remaining === 0) state = 'header';
          return;
        }
        if (state === 'data-target') {
          if (remaining === 0) {
            state = 'header';
            outFd.end(() => { gunzip.destroy(); input.destroy(); resolve(); });
            return;
          }
          if (buf.length === 0) return;
          const writeable = Math.min(dataSize, buf.length, remaining);
          const take      = Math.min(remaining, buf.length);
          if (writeable > 0) outFd.write(buf.subarray(0, writeable));
          dataSize -= writeable; buf = buf.subarray(take); remaining -= take;
          return;
        }
      }
    };

    gunzip.on('data', chunk => { buf = Buffer.concat([buf, chunk]); process_(); });
    gunzip.on('end',  () => { if (!outFd) reject(new Error(`"${targetName}" not found in archive`)); });
    gunzip.on('error', fail);
    input.on('error', fail);
    input.pipe(gunzip);
  });
}

// ── Dep groups ────────────────────────────────────────────────────────────────

async function fetchKokoro() {
  console.log('\n── Kokoro 82M ONNX ──────────────────────────────────────────');
  console.log('   Dest: ~/.phobos/services/kokoro/');
  console.log('   kokoro-js bundles its own tokenizer. Only the ONNX model');
  console.log('   file is needed — individual voice .bin files are fetched');
  console.log('   per-voice on first use by AudioServerManager.\n');

  const dir = path.join(SERVICES_DIR, 'kokoro');

  // ONNX model (~92 MB q8 int8) — will move to PHOBOS-DEPS
  // NOTE: repo is Kokoro-82M-v1.0-ONNX (includes v1.0 in the name)
  const HF_KOKORO = `${HF_BASE}/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main`;

  await download(
    'model_quantized.onnx',
    `${HF_KOKORO}/onnx/model_quantized.onnx`,
    path.join(dir, 'onnx', 'model_quantized.onnx'),
    85_000_000,
  );

  // Config files required by kokoro-js (small — will move to PHOBOS-DEPS)
  for (const file of ['tokenizer.json', 'tokenizer_config.json', 'config.json']) {
    await download(file, `${HF_KOKORO}/${file}`, path.join(dir, file), 100);
  }

  // Default voice — af_heart (American female, warm)
  // kokoro-js fetches individual voice .bin files on demand; pre-seeding the
  // default voice avoids a network hit on first TTS request.
  await download(
    'voices/af_heart.bin',
    `${HF_KOKORO}/voices/af_heart.bin`,
    path.join(dir, 'voices', 'af_heart.bin'),
    100_000,
  );
}

async function fetchWhisper() {
  console.log('\n── Whisper large-v3 ─────────────────────────────────────────');
  console.log('   Dest: ~/.phobos/services/whisper/');
  console.log('   NOTE: whisper-cli binary must be built from source and placed');
  console.log('   at ~/.phobos/services/whisper/whisper-cli before running tests.\n');
  console.log('   Build: https://github.com/ggerganov/whisper.cpp');
  console.log('   cmake .. -DGGML_CUDA=ON && cmake --build . --config Release\n');

  if (skipModels) {
    console.log('   --skip-models set — skipping ggml-large-v3.bin (3.1 GB)');
    return;
  }

  const dir = path.join(SERVICES_DIR, 'whisper');

  // Large weight — stays on HuggingFace
  await download(
    'ggml-large-v3.bin  [3.1 GB — this will take a while]',
    `${HF_BASE}/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin`,
    path.join(dir, 'ggml-large-v3.bin'),
    3_000_000_000,
  );
}

async function fetchAceStep() {
  console.log('\n── ACE-Step v1.5 (binaries) ─────────────────────────────────');
  console.log('   Dest: ~/.phobos/services/acestep/');
  console.log('   NOTE: ace-lm and ace-synth must be built from source.');
  console.log('   Build steps:');
  console.log('     git clone --recurse-submodules https://github.com/ace-step/acestep.cpp.git');
  console.log('     cd acestep.cpp && mkdir build && cd build');
  console.log('     cmake .. -DGGML_CUDA=ON   # RTX 3080 CUDA');
  console.log('     # cmake .. -DGGML_HIP=ON  # AMD ROCm (890M)');
  console.log('     cmake --build . --config Release -j$(nproc)');
  console.log('   Then copy build/ace-lm and build/ace-synth to ~/.phobos/services/acestep/\n');
}

async function fetchAceStepModels() {
  if (skipModels) {
    console.log('\n── ACE-Step models — skipped (--skip-models)\n');
    return;
  }

  console.log('\n── ACE-Step v1.5 (GGUF models) ──────────────────────────────');
  console.log('   Dest: ~/.phobos/services/acestep/models/');
  console.log('   Source: Serveurperso/ACE-Step-1.5-GGUF on HuggingFace\n');

  const dir = path.join(SERVICES_DIR, 'acestep', 'models');

  // SFT DiT (~8.5 GB) — large, stays HF
  await download(
    'acestep-v15-sft-Q8_0.gguf  [~8.5 GB]',
    `${HF_BASE}/Serveurperso/ACE-Step-1.5-GGUF/resolve/main/acestep-v15-sft-Q8_0.gguf`,
    path.join(dir, 'acestep-v15-sft-Q8_0.gguf'),
    8_000_000_000,
  );

  // VAE (~400 MB) — stays HF for now, small enough for PHOBOS-DEPS later
  await download(
    'vae-BF16.gguf  [~400 MB]',
    `${HF_BASE}/Serveurperso/ACE-Step-1.5-GGUF/resolve/main/vae-BF16.gguf`,
    path.join(dir, 'vae-BF16.gguf'),
    300_000_000,
  );

  // Embedding model (~600 MB) — stays HF
  await download(
    'Qwen3-Embedding-0.6B-Q8_0.gguf  [~600 MB]',
    `${HF_BASE}/Serveurperso/ACE-Step-1.5-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf`,
    path.join(dir, 'Qwen3-Embedding-0.6B-Q8_0.gguf'),
    500_000_000,
  );

  // LM 1.7B (~1.7 GB) — stays HF
  await download(
    'acestep-5Hz-lm-1.7B-Q8_0.gguf  [~1.7 GB]',
    `${HF_BASE}/Serveurperso/ACE-Step-1.5-GGUF/resolve/main/acestep-5Hz-lm-1.7B-Q8_0.gguf`,
    path.join(dir, 'acestep-5Hz-lm-1.7B-Q8_0.gguf'),
    1_500_000_000,
  );
}

async function fetchF5tts() {
  console.log('\n── F5-TTS v1 Base ───────────────────────────────────────────');
  console.log('   Dest: ~/.phobos/models/audio/f5-tts/f5-tts-v1-base/F5TTS_v1_Base/\n');

  const dir = path.join(AUDIO_MODELS_DIR, 'f5-tts', 'f5-tts-v1-base', 'F5TTS_v1_Base');

  // vocab.txt (~15 KB) — will go to PHOBOS-DEPS
  await download(
    'vocab.txt',
    `${HF_BASE}/SWivid/F5-TTS/raw/main/F5TTS_v1_Base/vocab.txt`,
    path.join(dir, 'vocab.txt'),
    1_000,
  );

  if (skipModels) {
    console.log('  --skip-models set — skipping model_1250000.safetensors (1.2 GB)');
    return;
  }

  // Large weight — stays HF
  await download(
    'model_1250000.safetensors  [~1.2 GB]',
    `${HF_BASE}/SWivid/F5-TTS/resolve/main/F5TTS_v1_Base/model_1250000.safetensors`,
    path.join(dir, 'model_1250000.safetensors'),
    1_100_000_000,
  );
}

async function fetchStableAudio() {
  // Stable Audio Open 1.0 — BLOCKED.
  // The Stability AI Community License prohibits redistribution of weights.
  // Cannot be hosted on PHOBOS-DEPS. Model is marked blocked:true in the catalogue.
  // Users who need SFX generation must source this model themselves via:
  //   https://huggingface.co/stabilityai/stable-audio-open-1.0
  // (requires accepting the license and an HF token with granted access)
  console.log('\n── Stable Audio Open — skipped (non-redistributable license)');
}
// ── Main ──────────────────────────────────────────────────────────────────────

const ALL_GROUPS = ['kokoro', 'whisper', 'acestep', 'acestep-models', 'f5tts'];

async function main() {
  console.log('PHOBOS Audio Dep Fetcher');
  console.log(`PHOBOS_HOME: ${PHOBOS_HOME}`);
  if (onlyGroup) {
    if (!ALL_GROUPS.includes(onlyGroup)) {
      console.error(`Unknown group: ${onlyGroup}. Valid: ${ALL_GROUPS.join(', ')}`);
      process.exit(1);
    }
    console.log(`Running group: ${onlyGroup}\n`);
  }
  if (skipModels) console.log('--skip-models: large weight files will be skipped\n');

  const run = (group) => !onlyGroup || onlyGroup === group;

  if (run('kokoro'))         await fetchKokoro();
  if (run('whisper'))        await fetchWhisper();
  if (run('acestep'))        await fetchAceStep();
  if (run('acestep-models')) await fetchAceStepModels();
  if (run('f5tts'))          await fetchF5tts();
  // stable-audio: blocked — Stability AI Community License prohibits redistribution.

  console.log('\n── Build reminders ──────────────────────────────────────────');
  console.log('  Before running tests, build and place these binaries manually:');
  console.log('');
  console.log('  whisper-cli  → ~/.phobos/services/whisper/whisper-cli');
  console.log('    https://github.com/ggerganov/whisper.cpp');
  console.log('    cmake .. -DGGML_CUDA=ON && cmake --build . -j$(nproc)');
  console.log('');
  console.log('  ace-lm, ace-synth → ~/.phobos/services/acestep/');
  console.log('    https://github.com/ace-step/acestep.cpp');
  console.log('    cmake .. -DGGML_CUDA=ON && cmake --build . -j$(nproc)');
  console.log('');
  console.log('  kokoro-js npm package:');
  console.log('    npm install kokoro-js');
  console.log('');
  console.log('Done.\n');
}

main().catch(err => { console.error(err.message); process.exit(1); });
