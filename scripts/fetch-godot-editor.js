#!/usr/bin/env node
// scripts/fetch-godot-editor.js — Download the Godot 4.6.2 web editor for PHOBOS.
//
// Godot 4.6.2 (godotengine/godot, MIT) ships an official web editor as a
// release asset. PHOBOS downloads the upstream zip, patches telemetry calls
// out of godot.editor.js, re-zips, and uploads to armyofbear136/PHOBOS-BUILDS
// under the PHOBOS-DEPS release tag.
//
//   node scripts/fetch-godot-editor.js
//   node scripts/fetch-godot-editor.js --check   (check only, no download)
//
// Destination: ~/.phobos/editors/godot/
//              Entry point: ~/.phobos/editors/godot/godot.editor.html
//
// ── One-time patch and upload (per version bump) ──────────────────────────────
//
//   # 1. Download upstream zip:
//   curl -L -O https://github.com/godotengine/godot/releases/download/4.6.2-stable/Godot_v4.6.2-stable_web_editor.zip
//
//   # 2. Extract, patch godot.editor.js, re-zip:
//   mkdir godot-patched
//   unzip Godot_v4.6.2-stable_web_editor.zip -d godot-patched/
//   node -e "
//     const fs = require('fs');
//     const p = 'godot-patched/godot.editor.js';
//     let s = fs.readFileSync(p, 'utf8');
//     s = s.replace(/fetch\s*\(\s*[\"']https:\/\/godotengine\.org\/version\.json[\"']\s*\)[^;]*;/g, 'Promise.resolve();');
//     s = s.replace(/fetch\s*\(\s*[\"']https:\/\/godotengine\.org\/[^\"']*[\"']\s*\)[^;]*;/g, 'Promise.resolve();');
//     fs.writeFileSync(p, s);
//     console.log('patched');
//   "
//   cd godot-patched && zip -r ../godot-web-editor-4.6.2.zip . && cd ..
//
//   # 3. Upload to PHOBOS-BUILDS:
//   gh release upload PHOBOS-DEPS godot-web-editor-4.6.2.zip \
//     --repo armyofbear136/PHOBOS-BUILDS
//
// Update GODOT_VERSION below and in scripts/bin-manifest.json when bumping.
//
// ── COOP/COEP headers ─────────────────────────────────────────────────────────
//
// Godot's web editor requires SharedArrayBuffer (Wasm threads), which requires
// the page to be cross-origin isolated. ALL responses from the Fastify server —
// including PHOBOS's own frontend — must include:
//
//   Cross-Origin-Opener-Policy:  same-origin
//   Cross-Origin-Embedder-Policy: require-corp
//
// These are set globally in the server bootstrap via a Fastify onSend hook.
// The /tools/godot/ static registration in toolsRoute.ts also sets them via
// setHeaders as a belt-and-suspenders measure.
//
// Impact: COEP require-corp blocks any cross-origin resource that does not
// respond with Cross-Origin-Resource-Policy: cross-origin (or same-site).
// All current PHOBOS assets are same-origin. Audit any future external resources.

import fs    from 'node:fs';
import https from 'node:https';
import http  from 'node:http';
import path  from 'node:path';
import os    from 'node:os';
import zlib  from 'node:zlib';

// ── Release config ────────────────────────────────────────────────────────────

const GODOT_VERSION = '4.6.2';
const DEPS_BASE     = 'https://github.com/armyofbear136/PHOBOS-BUILDS/releases/download/PHOBOS-DEPS';
const ASSET_NAME    = `godot-web-editor-${GODOT_VERSION}.zip`;
const ASSET_URL     = `${DEPS_BASE}/${ASSET_NAME}`;
const MIN_BYTES     = 20_000_000; // upstream zip is ~30 MB

// ── Paths ─────────────────────────────────────────────────────────────────────

const DEST_DIR = path.join(os.homedir(), '.phobos', 'editors', 'godot');
const TMP_DIR  = path.join(os.homedir(), '.phobos', 'dep-prep-downloads');
const ZIP_PATH = path.join(TMP_DIR, ASSET_NAME);

// ── CLI ───────────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const checkOnly = args.includes('--check');

// ── Helpers ───────────────────────────────────────────────────────────────────

function isBuildPresent() {
  return fs.existsSync(path.join(DEST_DIR, 'godot.editor.html'));
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 10) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(target);
      const mod    = parsed.protocol === 'https:' ? https : http;
      const req    = mod.get(
        {
          hostname: parsed.hostname,
          port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path:     parsed.pathname + parsed.search,
          headers:  { 'User-Agent': 'phobos-fetch-godot-editor/1.0', ...headers },
        },
        res => {
          if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            follow(res.headers.location, hops + 1);
            return;
          }
          resolve(res);
        }
      );
      req.on('error', reject);
    };
    follow(url);
  });
}

async function downloadFile(url, destPath) {
  const tmpPath  = destPath + '.download';
  const existing = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
  const headers  = existing > 0 ? { Range: `bytes=${existing}-` } : {};

  if (existing > 0) process.stdout.write(`   Resuming from ${(existing / 1e6).toFixed(1)} MB…\n`);

  const res = await httpsGet(url, headers);
  if (res.statusCode === 404) throw new Error(`404 — Asset not found: ${url}`);
  if (res.statusCode !== 200 && res.statusCode !== 206) throw new Error(`HTTP ${res.statusCode}`);

  const totalFromHeader = parseInt(res.headers['content-length'] ?? '0', 10);
  const totalBytes      = res.statusCode === 206 ? existing + totalFromHeader : totalFromHeader;

  await new Promise((resolve, reject) => {
    const fd     = fs.createWriteStream(tmpPath, { flags: existing > 0 ? 'a' : 'w' });
    let received = existing;
    res.on('data', chunk => {
      received += chunk.length;
      if (!fd.write(chunk)) { res.pause(); fd.once('drain', () => res.resume()); }
      if (totalBytes > 0) {
        process.stdout.write(
          `\r   ${Math.round(received / totalBytes * 100)}%  ${(received / 1e6).toFixed(1)} / ${(totalBytes / 1e6).toFixed(1)} MB`
        );
      }
    });
    res.on('end',   () => fd.end());
    fd.on('finish', () => { if (totalBytes > 0) process.stdout.write('\n'); resolve(); });
    fd.on('error',  reject);
    res.on('error', reject);
  });

  fs.renameSync(tmpPath, destPath);
}

// Minimal ZIP extractor — same implementation as fetch-blockbench / fetch-sculptgl.
async function extractZip(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);

  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error('Invalid zip: EOCD not found');

  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const cdCount  = buf.readUInt16LE(eocdOffset + 10);

  let cdPos = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(cdPos) !== 0x02014b50) throw new Error('Invalid central directory entry');

    const compMethod  = buf.readUInt16LE(cdPos + 10);
    const compSize    = buf.readUInt32LE(cdPos + 20);
    const uncompSize  = buf.readUInt32LE(cdPos + 24);
    const nameLen     = buf.readUInt16LE(cdPos + 28);
    const extraLen    = buf.readUInt16LE(cdPos + 30);
    const commentLen  = buf.readUInt16LE(cdPos + 32);
    const localOffset = buf.readUInt32LE(cdPos + 42);
    const entryName   = buf.subarray(cdPos + 46, cdPos + 46 + nameLen).toString('utf8');

    cdPos += 46 + nameLen + extraLen + commentLen;

    if (entryName.endsWith('/')) {
      fs.mkdirSync(path.join(destDir, entryName), { recursive: true });
      continue;
    }

    const localNameLen  = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataOffset    = localOffset + 30 + localNameLen + localExtraLen;
    const compData      = buf.subarray(dataOffset, dataOffset + compSize);

    const outPath = path.join(destDir, entryName);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    if (compMethod === 0) {
      fs.writeFileSync(outPath, compData);
    } else if (compMethod === 8) {
      const inflated = zlib.inflateRawSync(compData);
      if (inflated.length !== uncompSize) {
        throw new Error(`Size mismatch for ${entryName}: expected ${uncompSize}, got ${inflated.length}`);
      }
      fs.writeFileSync(outPath, inflated);
    } else {
      throw new Error(`Unsupported compression method ${compMethod} for ${entryName}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n🎮 Godot Web Editor for PHOBOS');
console.log('─'.repeat(52));
console.log(`   Version:     ${GODOT_VERSION}`);
console.log(`   Destination: ${DEST_DIR}`);

if (checkOnly) {
  if (isBuildPresent()) {
    console.log(`\n✅ Godot ${GODOT_VERSION} web editor present.`);
  } else {
    console.log(`\n❌ Godot web editor not found.`);
    console.log(`   Run: node scripts/fetch-godot-editor.js`);
  }
  process.exit(isBuildPresent() ? 0 : 1);
}

if (isBuildPresent()) {
  console.log(`\n✅ Godot web editor already present.`);
  console.log(`   Enable in PHOBOS → CREATE → 3D.\n`);
  process.exit(0);
}

fs.mkdirSync(TMP_DIR,  { recursive: true });
fs.mkdirSync(DEST_DIR, { recursive: true });

console.log(`\n📥 Downloading Godot ${GODOT_VERSION} web editor…`);
console.log(`   ${ASSET_URL}`);

try {
  await downloadFile(ASSET_URL, ZIP_PATH);
} catch (err) {
  console.error(`\n❌ Download failed: ${err.message}`);
  process.exit(1);
}

const zipSize = fs.statSync(ZIP_PATH).size;
if (zipSize < MIN_BYTES) {
  console.error(`❌ Downloaded file too small (${(zipSize / 1e6).toFixed(1)} MB) — may be corrupt.`);
  process.exit(1);
}

console.log(`\n📦 Extracting…`);
try {
  await extractZip(ZIP_PATH, DEST_DIR);
} catch (err) {
  console.error(`\n❌ Extraction failed: ${err.message}`);
  process.exit(1);
}

if (!isBuildPresent()) {
  console.error(`\n❌ Extraction completed but godot.editor.html not found in ${DEST_DIR}.`);
  console.error(`   The release zip structure may have changed — check asset contents.`);
  process.exit(1);
}

try { fs.rmSync(ZIP_PATH); } catch { /* non-fatal */ }

console.log(`\n✅ Godot ${GODOT_VERSION} web editor ready.`);
console.log(`   Enable in PHOBOS → CREATE → 3D.\n`);
