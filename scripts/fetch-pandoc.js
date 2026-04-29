#!/usr/bin/env node
// scripts/fetch-pandoc.js — Download the pandoc document converter for PHOBOS.
//
// Downloads a pinned release from GitHub into ~/.phobos/services/pandoc/
// Handles macOS Gatekeeper quarantine removal automatically.
//
//   node scripts/fetch-pandoc.js
//
// PHOBOS_OVERRIDE_PLATFORM=linux-x64 for cross-platform fetch.

import fs    from 'node:fs';
import https from 'node:https';
import path  from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Release version ───────────────────────────────────────────────────────────
// Check https://github.com/jgm/pandoc/releases for latest.
// MUST match PANDOC_VERSION in resolvePandocBinary() if we ever add a version check.
const PANDOC_VERSION = '3.6.4';

// ── Platform → asset mapping ──────────────────────────────────────────────────
// Pandoc ships as:
//   Linux:   .tar.gz  — extracts to pandoc-<version>/bin/pandoc
//   Windows: .zip     — extracts to pandoc-<version>/pandoc.exe
//   macOS:   .pkg     — not suitable for headless install; use the .tar.gz arm64/x86_64
//
// For macOS we use the GitHub "pandoc-<ver>-arm64-macOS.zip" / "x86_64-macOS.zip" assets
// which extract directly to pandoc (no subdirectory).
const PLATFORM_ASSETS = {
  'linux-x64':    { file: `pandoc-${PANDOC_VERSION}-linux-amd64.tar.gz`,  extract: 'tar', binary: 'pandoc', minBytes: 20_000_000 },
  'linux-arm64':  { file: `pandoc-${PANDOC_VERSION}-linux-arm64.tar.gz`,  extract: 'tar', binary: 'pandoc', minBytes: 18_000_000 },
  'win32-x64':    { file: `pandoc-${PANDOC_VERSION}-windows-x86_64.zip`,  extract: 'zip', binary: 'pandoc.exe', minBytes: 20_000_000 },
  'darwin-x64':   { file: `pandoc-${PANDOC_VERSION}-x86_64-macOS.zip`,    extract: 'zip', binary: 'pandoc', minBytes: 20_000_000 },
  'darwin-arm64': { file: `pandoc-${PANDOC_VERSION}-arm64-macOS.zip`,     extract: 'zip', binary: 'pandoc', minBytes: 18_000_000 },
};

const GITHUB_BASE = `https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}`;

// ── Destination directory ─────────────────────────────────────────────────────
// Pandoc lives in dist/ alongside phobos-core.exe — same flat layout as llama, sd-cpp, etc.
const DEST_DIR = path.join(__dirname, '..', 'bin');

// ── Platform detection ────────────────────────────────────────────────────────
function detectPlatformKey() {
  const override = process.env.PHOBOS_OVERRIDE_PLATFORM;
  if (override) return override;
  return `${process.platform}-${process.arch}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 10) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(target);
      https.get(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search,
          headers: { 'User-Agent': 'phobos-fetch-pandoc/1.0', ...headers } },
        res => {
          if ([301, 302, 307, 308].includes(res.statusCode)) {
            follow(res.headers.location, hops + 1); return;
          }
          resolve(res);
        }
      ).on('error', reject);
    };
    follow(url);
  });
}

async function extractTar(archivePath, destDir) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)('tar', ['-xzf', archivePath, '-C', destDir]);
}

async function extractZip(archivePath, destDir) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  if (process.platform === 'win32') {
    // Windows 10+ ships tar.exe which handles .zip
    await promisify(execFile)('tar', ['-xf', archivePath, '-C', destDir]);
  } else {
    await promisify(execFile)('unzip', ['-o', archivePath, '-d', destDir]);
  }
}

// Flatten any single-subdirectory extraction into destDir.
// Pandoc tars extract to pandoc-<version>/ — we want the contents directly in destDir.
function flattenSingleSubdir(destDir, binaryName) {
  if (fs.existsSync(path.join(destDir, binaryName))) return; // already flat
  
  const entries = fs.readdirSync(destDir)
    .filter(e => fs.statSync(path.join(destDir, e)).isDirectory() && e.startsWith('pandoc-'));
    
  for (const entry of entries) {
    const subdir = path.join(destDir, entry);
    const binSubdir = path.join(subdir, 'bin');
    
    const possiblePaths = [
      path.join(binSubdir, binaryName), // Linux tarball structure
      path.join(subdir, binaryName)     // Windows zip structure
    ];
    
    for (const targetPath of possiblePaths) {
      if (fs.existsSync(targetPath)) {
        fs.renameSync(targetPath, path.join(destDir, binaryName));
        fs.rmSync(subdir, { recursive: true, force: true });
        return;
      }
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const platformKey = detectPlatformKey();
const asset       = PLATFORM_ASSETS[platformKey];

console.log('\n📄 Pandoc Document Converter Fetch for PHOBOS');
console.log('─'.repeat(50));
console.log(`   Platform: ${platformKey}`);
console.log(`   Version:  ${PANDOC_VERSION}`);
console.log(`   Dest:     ${DEST_DIR}`);

if (!asset) {
  console.error(`❌ No pandoc asset for platform: ${platformKey}`);
  console.error(`   Supported: ${Object.keys(PLATFORM_ASSETS).join(', ')}`);
  process.exit(1);
}

const DEST_BINARY   = path.join(DEST_DIR, asset.binary);
const ARCHIVE_TMP   = path.join(DEST_DIR, asset.file + '.download');
const ARCHIVE_FINAL = path.join(DEST_DIR, asset.file);

fs.mkdirSync(DEST_DIR, { recursive: true });

// Fast-path: binary already present and large enough
if (fs.existsSync(DEST_BINARY) && fs.statSync(DEST_BINARY).size >= asset.minBytes) {
  console.log(`✅ Already present (${(fs.statSync(DEST_BINARY).size / 1e6).toFixed(1)} MB) — nothing to do.`);
  process.exit(0);
}

// Resume-capable download
const existingBytes = fs.existsSync(ARCHIVE_TMP) ? fs.statSync(ARCHIVE_TMP).size : 0;
const reqHeaders    = existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {};
const downloadUrl   = `${GITHUB_BASE}/${asset.file}`;

if (existingBytes > 0) {
  console.log(`\n📥 Resuming from ${(existingBytes / 1e6).toFixed(1)} MB…`);
} else {
  console.log(`\n📥 Downloading…`);
  console.log(`   ${downloadUrl}`);
}

let res;
try {
  res = await httpsGet(downloadUrl, reqHeaders);
} catch (err) {
  console.error(`❌ Request failed: ${err.message}`);
  process.exit(1);
}

if (res.statusCode === 404) {
  console.error(`❌ 404 — Asset not found.`);
  console.error(`   Check https://github.com/jgm/pandoc/releases for the correct version.`);
  process.exit(1);
}
if (res.statusCode !== 200 && res.statusCode !== 206) {
  console.error(`❌ HTTP ${res.statusCode}`);
  process.exit(1);
}

const totalFromHeader = parseInt(res.headers['content-length'] ?? '0', 10);
const totalBytes      = res.statusCode === 206 ? existingBytes + totalFromHeader : totalFromHeader;

await new Promise((resolve, reject) => {
  const fd     = fs.createWriteStream(ARCHIVE_TMP, { flags: existingBytes > 0 ? 'a' : 'w' });
  let received = existingBytes;
  res.on('data', chunk => {
    received += chunk.length;
    if (!fd.write(chunk)) { res.pause(); fd.once('drain', () => res.resume()); }
    if (totalBytes > 0) {
      const pct = Math.round(received / totalBytes * 100);
      process.stdout.write(`\r   ${pct}%  ${(received / 1e6).toFixed(1)} / ${(totalBytes / 1e6).toFixed(1)} MB`);
    }
  });
  res.on('end',   () => fd.end());
  fd.on('finish', () => { if (totalBytes > 0) process.stdout.write('\n'); resolve(); });
  fd.on('error', reject);
  res.on('error', reject);
});

fs.renameSync(ARCHIVE_TMP, ARCHIVE_FINAL);
console.log('\n📦 Extracting…');

try {
  if (asset.extract === 'tar') {
    await extractTar(ARCHIVE_FINAL, DEST_DIR);
  } else {
    await extractZip(ARCHIVE_FINAL, DEST_DIR);
  }
} catch (err) {
  console.error(`❌ Extraction failed: ${err.message}`);
  process.exit(1);
}

fs.unlinkSync(ARCHIVE_FINAL);
flattenSingleSubdir(DEST_DIR, asset.binary);

if (!fs.existsSync(DEST_BINARY)) {
  console.error(`❌ Binary not found after extraction: ${DEST_BINARY}`);
  console.error(`   Archive may extract to a different directory structure.`);
  process.exit(1);
}

const binarySize = fs.statSync(DEST_BINARY).size;
if (binarySize < asset.minBytes) {
  console.error(`❌ Binary too small (${(binarySize / 1e6).toFixed(1)} MB) — extraction may be incomplete.`);
  process.exit(1);
}

// Make executable on Unix
if (process.platform !== 'win32') {
  fs.chmodSync(DEST_BINARY, 0o755);
}

// macOS: remove Gatekeeper quarantine flag
if (process.platform === 'darwin') {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('xattr', ['-d', 'com.apple.quarantine', DEST_BINARY]).catch(() => {});
    console.log('   Removed macOS quarantine flag (Gatekeeper bypass)');
  } catch { /* non-fatal */ }
}

console.log(`\n✅ ${asset.binary}`);
console.log(`   Size:   ${(binarySize / 1e6).toFixed(1)} MB`);
console.log(`   Path:   ${DEST_BINARY}`);
console.log(`\n✅ pandoc ready. PHOBOS document conversion will use this binary.\n`);
