#!/usr/bin/env node
// scripts/fetch-audio-deps.js
//
// Downloads all generative audio dependencies for local testing.
//
// Usage:
//   node scripts/fetch-audio-deps.js                       -- all groups
//   node scripts/fetch-audio-deps.js --skip-models         -- skip large weights
//   node scripts/fetch-audio-deps.js --only kokoro
//   node scripts/fetch-audio-deps.js --only whisper
//   node scripts/fetch-audio-deps.js --only acestep-models
//   node scripts/fetch-audio-deps.js --only f5tts
//   HF_TOKEN=hf_xxx node scripts/fetch-audio-deps.js
//
// Exact file destinations:
//
//   dist/kokoro/
//     onnx/model_quantized.onnx
//     tokenizer.json
//     tokenizer_config.json
//     config.json
//     voices/af_heart.bin
//
//   ~/.phobos/models/audio/whisper/whisper-large-v3/
//     ggml-large-v3.bin
//
//   ~/.phobos/models/audio/acestep/
//     acestep-5Hz-lm-1.7B-Q8_0.gguf
//     acestep-v15-sft-Q8_0.gguf
//     vae-BF16.gguf
//     Qwen3-Embedding-0.6B-Q8_0.gguf
//
//   ~/.phobos/models/audio/f5-tts/f5-tts-v1-base/F5TTS_v1_Base/
//     vocab.txt
//     model_1250000.safetensors
//
// Binaries go in dist/ -- build from source:
//   whisper-cli.exe  whisper.dll  ggml-*.dll  -- from whisper.cpp
//   ace-lm.exe  ace-synth.exe  ggml-*.dll     -- from acestep.cpp

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import https from 'node:https';
import http  from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Destination roots ------------------------------------------------------

const PHOBOS_HOME      = process.env.PHOBOS_DATA_DIR ?? path.join(os.homedir(), '.phobos');
const AUDIO_MODELS_DIR = path.join(PHOBOS_HOME, 'models', 'audio');
// scripts/ is a sibling of dist/ -- one level up is repo root
const DIST_DIR         = path.join(__dirname, '..', 'dist');

const HF_BASE = 'https://huggingface.co';

// ---- CLI args ----------------------------------------------------------------

const args       = process.argv.slice(2);
const skipModels = args.includes('--skip-models');
const onlyIdx    = args.indexOf('--only');
const onlyGroup  = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

const HF_TOKEN = process.env.HF_TOKEN ?? process.env.GITHUB_TOKEN ?? '';
if (!HF_TOKEN) {
  console.warn('WARNING: HF_TOKEN not set -- unauthenticated. Gated repos will 401.\n');
}

// ---- HTTP with redirect following -------------------------------------------

function get(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 12) { reject(new Error('Too many redirects: ' + target)); return; }
      let parsed;
      try { parsed = new URL(target); } catch { reject(new Error('Bad URL: ' + target)); return; }
      const isHf = parsed.hostname === 'huggingface.co';
      const hdrs = {
        'User-Agent': 'phobos-fetch-audio/1.0',
        ...(isHf && HF_TOKEN ? { Authorization: 'Bearer ' + HF_TOKEN } : {}),
        ...extraHeaders,
      };
      const proto = parsed.protocol === 'https:' ? https : http;
      proto.get(
        { hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + parsed.search,
          headers: hdrs },
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

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  return (n / 1e3).toFixed(0) + ' KB';
}

// ---- Download with resume + progress ----------------------------------------

async function download(label, url, destPath, minBytes = 0) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  if (fs.existsSync(destPath)) {
    const sz = fs.statSync(destPath).size;
    if (sz >= minBytes) {
      console.log('  OK  ' + label + ' -- already present (' + fmt(sz) + ')');
      return true;
    }
    console.log('  !!  ' + label + ' -- too small, re-downloading');
    fs.unlinkSync(destPath);
  }

  const tmpPath  = destPath + '.tmp';
  const existing = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
  const hdrs     = existing > 0 ? { Range: 'bytes=' + existing + '-' } : {};

  process.stdout.write('  ->  ' + label + (existing > 0 ? ' (resuming from ' + fmt(existing) + ')' : '') + '\n');

  let res;
  try { res = await get(url, hdrs); }
  catch (err) { console.error('      FAIL connection error: ' + err.message); return false; }

  if (res.statusCode === 404) {
    res.resume();
    console.error('      FAIL 404 not found: ' + url);
    return false;
  }
  if (res.statusCode !== 200 && res.statusCode !== 206) {
    res.resume();
    console.error('      FAIL HTTP ' + res.statusCode + ' for ' + url);
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
          process.stdout.write('\r      ' + String(pct).padStart(3) + '%  ' + fmt(received) + ' / ' + fmt(total) + '  ');
          lastPct = pct;
        }
      }
    });
    res.on('end', () => fd.end());
    fd.on('finish', () => {
      process.stdout.write(total > 0
        ? '\r      100%  ' + fmt(received) + ' / ' + fmt(total) + '\n'
        : '\r      ' + fmt(received) + ' received\n');
      resolve();
    });
    fd.on('error', reject);
    res.on('error', reject);
  });

  fs.renameSync(tmpPath, destPath);
  console.log('      saved to ' + destPath);
  return true;
}

// ---- Dep groups -------------------------------------------------------------

async function fetchKokoro() {
  const dir = path.join(DIST_DIR, 'kokoro');
  console.log('\n---- Kokoro 82M ONNX');
  console.log('     Dest: ' + dir + '\n');

  const RESOLVE = HF_BASE + '/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main';
  const RAW     = HF_BASE + '/onnx-community/Kokoro-82M-v1.0-ONNX/raw/main';

  await download('onnx/model_quantized.onnx', RESOLVE + '/onnx/model_quantized.onnx',
    path.join(dir, 'onnx', 'model_quantized.onnx'), 85_000_000);

  // Small JSON files must use /raw/ to bypass HF XET cache redirect
  for (const file of ['tokenizer.json', 'tokenizer_config.json', 'config.json']) {
    await download(file, RAW + '/' + file, path.join(dir, file), 100);
  }

  await download('voices/af_heart.bin', RESOLVE + '/voices/af_heart.bin',
    path.join(dir, 'voices', 'af_heart.bin'), 100_000);
}

async function fetchWhisper() {
  const dir = path.join(AUDIO_MODELS_DIR, 'whisper', 'whisper-large-v3');
  console.log('\n---- Whisper large-v3 model');
  console.log('     Dest: ' + dir);
  console.log('     Binary (whisper-cli.exe) goes in dist/ -- already built\n');

  if (skipModels) { console.log('     --skip-models: skipping ggml-large-v3.bin'); return; }

  await download('ggml-large-v3.bin [3.1 GB]',
    HF_BASE + '/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin',
    path.join(dir, 'ggml-large-v3.bin'), 3_000_000_000);
}

async function fetchAceStepModels() {
  const dir = path.join(AUDIO_MODELS_DIR, 'acestep');
  console.log('\n---- ACE-Step v1.5 GGUF models');
  console.log('     Dest: ' + dir);
  console.log('     Binaries (ace-lm.exe, ace-synth.exe) go in dist/ -- already built\n');

  if (skipModels) { console.log('     --skip-models: skipping GGUFs'); return; }

  const HF_GGUF = HF_BASE + '/Serveurperso/ACE-Step-1.5-GGUF/resolve/main';

  await download('acestep-5Hz-lm-1.7B-Q8_0.gguf [~2 GB]',
    HF_GGUF + '/acestep-5Hz-lm-1.7B-Q8_0.gguf',
    path.join(dir, 'acestep-5Hz-lm-1.7B-Q8_0.gguf'), 1_500_000_000);

  await download('acestep-v15-sft-Q8_0.gguf [~2.5 GB]',
    HF_GGUF + '/acestep-v15-sft-Q8_0.gguf',
    path.join(dir, 'acestep-v15-sft-Q8_0.gguf'), 2_000_000_000);

  await download('vae-BF16.gguf [~337 MB]',
    HF_GGUF + '/vae-BF16.gguf',
    path.join(dir, 'vae-BF16.gguf'), 300_000_000);

  await download('Qwen3-Embedding-0.6B-Q8_0.gguf [~784 MB]',
    HF_GGUF + '/Qwen3-Embedding-0.6B-Q8_0.gguf',
    path.join(dir, 'Qwen3-Embedding-0.6B-Q8_0.gguf'), 500_000_000);
}

async function fetchF5tts() {
  const dir = path.join(AUDIO_MODELS_DIR, 'f5-tts', 'f5-tts-v1-base', 'F5TTS_v1_Base');
  console.log('\n---- F5-TTS v1 Base');
  console.log('     Dest: ' + dir + '\n');

  // vocab.txt is small text -- use /raw/ to bypass XET redirect
  await download('vocab.txt',
    HF_BASE + '/SWivid/F5-TTS/raw/main/F5TTS_v1_Base/vocab.txt',
    path.join(dir, 'vocab.txt'), 1_000);

  if (skipModels) { console.log('     --skip-models: skipping model_1250000.safetensors'); return; }

  await download('model_1250000.safetensors [~1.2 GB]',
    HF_BASE + '/SWivid/F5-TTS/resolve/main/F5TTS_v1_Base/model_1250000.safetensors',
    path.join(dir, 'model_1250000.safetensors'), 1_100_000_000);
}

// ---- Main -------------------------------------------------------------------

const ALL_GROUPS = ['kokoro', 'whisper', 'acestep-models', 'f5tts'];

async function main() {
  console.log('PHOBOS Audio Dep Fetcher');
  console.log('PHOBOS_HOME : ' + PHOBOS_HOME);
  console.log('DIST_DIR    : ' + DIST_DIR);

  if (onlyGroup) {
    if (!ALL_GROUPS.includes(onlyGroup)) {
      console.error('Unknown group: "' + onlyGroup + '". Valid: ' + ALL_GROUPS.join(', '));
      process.exit(1);
    }
    console.log('Running group: ' + onlyGroup + '\n');
  }
  if (skipModels) console.log('--skip-models active\n');

  const run = (g) => !onlyGroup || onlyGroup === g;

  if (run('kokoro'))         await fetchKokoro();
  if (run('whisper'))        await fetchWhisper();
  if (run('acestep-models')) await fetchAceStepModels();
  if (run('f5tts'))          await fetchF5tts();

  console.log('\nDone.');
}

main().catch(err => { console.error(err.message); process.exit(1); });
