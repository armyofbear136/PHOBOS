#!/usr/bin/env node
// scripts/fetch-sybil-model.js — Download SYBIL's embedding model
//
// Downloads nomic-embed-text-v1.5.Q4_K_M.gguf from Hugging Face into
// phobos/models/ so it gets staged into dist/ on every build.
//
// Called automatically by master-sync.js and build-full.js when the model
// is missing. Can also be run standalone:
//
//   node scripts/fetch-sybil-model.js
//
// The model is ~80 MB (Q4_K_M quantization), platform-independent, and never changes.
// Note: the F16 variant is ~137 MB — this is NOT that. Q4_K_M is the correct pick.

import fs           from 'node:fs';
import https        from 'node:https';
import crypto       from 'node:crypto';
import path         from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const DEST_DIR  = path.join(ROOT, 'phobos', 'models');
const DEST_FILE = path.join(DEST_DIR, 'nomic-embed-text-v1.5.Q4_K_M.gguf');
const TMP_FILE  = DEST_FILE + '.download';

// HuggingFace CDN — resolves to the Cloudflare CDN download URL via redirect.
const HF_URL =
  'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q4_K_M.gguf';

// Expected minimum size in bytes — actual Q4_K_M is ~80 MB. Floor at 60 MB.
const EXPECTED_MIN_BYTES = 60_000_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 10) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(target);
      https.get(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search,
          headers: { 'User-Agent': 'phobos-fetch-sybil/1.0', ...headers } },
        res => {
          if ([301, 302, 307, 308].includes(res.statusCode)) {
            follow(res.headers.location, hops + 1);
            return;
          }
          resolve(res);
        }
      ).on('error', reject);
    };
    follow(url);
  });
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end',  () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────

console.log('\n🧠 SYBIL Model Fetch — nomic-embed-text-v1.5 Q4_K_M');
console.log('─'.repeat(56));

fs.mkdirSync(DEST_DIR, { recursive: true });

// Fast-path: already present and large enough
if (fs.existsSync(DEST_FILE)) {
  const size = fs.statSync(DEST_FILE).size;
  if (size >= EXPECTED_MIN_BYTES) {
    console.log(`✅ Already present (${(size / 1e6).toFixed(1)} MB) — nothing to do.`);
    process.exit(0);
  }
  console.log(`⚠️  Existing file too small (${(size / 1e6).toFixed(1)} MB) — re-downloading.`);
  fs.unlinkSync(DEST_FILE);
}

// Resume-capable download via Range header
const existingBytes = fs.existsSync(TMP_FILE) ? fs.statSync(TMP_FILE).size : 0;
const reqHeaders = existingBytes > 0
  ? { Range: `bytes=${existingBytes}-` }
  : {};

if (existingBytes > 0) {
  console.log(`📥 Resuming download from ${(existingBytes / 1e6).toFixed(1)} MB…`);
} else {
  console.log(`📥 Downloading from Hugging Face…`);
  console.log(`   ${HF_URL}`);
}

let res;
try {
  res = await httpsGet(HF_URL, reqHeaders);
} catch (err) {
  console.error(`❌ Request failed: ${err.message}`);
  process.exit(1);
}

if (res.statusCode === 404) {
  console.error('❌ 404 — model file not found at HuggingFace URL. The URL may have changed.');
  process.exit(1);
}
if (res.statusCode !== 200 && res.statusCode !== 206) {
  console.error(`❌ HTTP ${res.statusCode}`);
  process.exit(1);
}

const totalFromHeader = parseInt(res.headers['content-length'] ?? '0', 10);
const totalBytes      = res.statusCode === 206 ? existingBytes + totalFromHeader : totalFromHeader;

await new Promise((resolve, reject) => {
  const fd = fs.createWriteStream(TMP_FILE, { flags: existingBytes > 0 ? 'a' : 'w' });
  let received = existingBytes;

  res.on('data', chunk => {
    received += chunk.length;
    if (!fd.write(chunk)) { res.pause(); fd.once('drain', () => res.resume()); }
    if (totalBytes > 0) {
      const pct = Math.round(received / totalBytes * 100);
      process.stdout.write(`\r   ${pct}%  ${(received / 1e6).toFixed(1)} / ${(totalBytes / 1e6).toFixed(1)} MB`);
    }
  });

  res.on('end', () => { fd.end(); });
  fd.on('finish', () => { if (totalBytes > 0) process.stdout.write('\n'); resolve(); });
  fd.on('error', reject);
  res.on('error', reject);
});

// Verify size
const finalSize = fs.statSync(TMP_FILE).size;
if (finalSize < EXPECTED_MIN_BYTES) {
  console.error(`❌ Downloaded file too small (${(finalSize / 1e6).toFixed(1)} MB) — may be corrupt.`);
  process.exit(1);
}

// Atomically move tmp → final
fs.renameSync(TMP_FILE, DEST_FILE);

const sha = await sha256File(DEST_FILE);
console.log(`✅ nomic-embed-text-v1.5.Q4_K_M.gguf`);
console.log(`   Size:   ${(finalSize / 1e6).toFixed(1)} MB`);
console.log(`   SHA256: ${sha}`);
console.log(`   Path:   ${path.relative(ROOT, DEST_FILE)}`);
console.log('\n✅ SYBIL model ready. Run npm run build:full to bundle it into dist/.\n');
