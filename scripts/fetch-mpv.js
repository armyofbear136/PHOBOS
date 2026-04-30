#!/usr/bin/env node
// scripts/fetch-mpv.js — Download the portable mpv video player binary for PHOBOS Media Hub.
//
// Installs a pinned release into ~/.phobos/services/mpv/
// No system install. No PATH modification. Spawned directly by MpvManager.
//
//   node scripts/fetch-mpv.js
//
// PHOBOS_OVERRIDE_PLATFORM=linux-x64 for cross-platform fetch.
//
// Platform → source:
//   win32-x64    — github.com/mpv-player/mpv  v0.41.0  (.zip, nested zip-in-zip)
//   darwin-arm64 — github.com/mpv-player/mpv  v0.41.0  (.zip, app bundle)
//   darwin-x64   — github.com/mpv-player/mpv  v0.41.0  (.zip, app bundle)
//   linux-x64    — github.com/stoyanovk/mpv-static v0.39.0 (.tar.gz, single binary)

import fs           from 'node:fs';
import https        from 'node:https';
import path         from 'node:path';
import os           from 'node:os';
import crypto       from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Platform → asset mapping ──────────────────────────────────────────────────

const PLATFORM_ASSETS = {
  'win32-x64': {
    url:      'https://github.com/mpv-player/mpv/releases/download/v0.41.0/mpv-v0.41.0-x86_64-w64-mingw32.zip',
    file:     'mpv-v0.41.0-x86_64-w64-mingw32.zip',
    format:   'zip',
    binary:   'mpv.exe',
    // Windows zip is flat — mpv.exe lands directly in DEST_DIR after extraction.
    // No subdirectory to flatten.
    subdir:   null,
    minBytes: 10_000_000,
  },
  'darwin-arm64': {
    url:      'https://github.com/mpv-player/mpv/releases/download/v0.41.0/mpv-v0.41.0-macos-26-arm.zip',
    file:     'mpv-v0.41.0-macos-26-arm.zip',
    format:   'zip',
    binary:   'mpv',
    // macOS zip contains mpv.app — binary is at mpv.app/Contents/MacOS/mpv
    subdir:   'mpv.app/Contents/MacOS/mpv',
    minBytes: 10_000_000,
  },
  'darwin-x64': {
    url:      'https://github.com/mpv-player/mpv/releases/download/v0.41.0/mpv-v0.41.0-macos-15-intel.zip',
    file:     'mpv-v0.41.0-macos-15-intel.zip',
    format:   'zip',
    binary:   'mpv',
    subdir:   'mpv.app/Contents/MacOS/mpv',
    minBytes: 10_000_000,
  },
  'linux-x64': {
    url:      'https://github.com/stoyanovk/mpv-static/releases/download/v0.39.0/mpv-v0.39.0-x86_64.tar.gz',
    file:     'mpv-v0.39.0-x86_64.tar.gz',
    format:   'tar.gz',
    binary:   'mpv',
    // Static build extracts as a single file named 'mpv' with no subdirectory.
    subdir:   null,
    minBytes: 10_000_000,
  },
};

// ── Destination ───────────────────────────────────────────────────────────────

const DEST_DIR = path.join(os.homedir(), '.phobos', 'services', 'mpv');

// ── Platform detection ────────────────────────────────────────────────────────

function detectPlatformKey() {
  return process.env.PHOBOS_OVERRIDE_PLATFORM ?? `${process.platform}-${process.arch}`;
}

// ── HTTPS helper (redirect-following, resume-capable) ─────────────────────────

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 10) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(target);
      https.get(
        {
          hostname: parsed.hostname,
          path:     parsed.pathname + parsed.search,
          headers:  { 'User-Agent': 'phobos-fetch-mpv/1.0', ...headers },
        },
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

// ── SHA-256 ───────────────────────────────────────────────────────────────────

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data',  d  => hash.update(d));
    stream.on('end',   () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ── Extraction helpers ────────────────────────────────────────────────────────

async function extractZip(archivePath, destDir) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  if (process.platform === 'win32') {
    // PowerShell Expand-Archive is available on all supported Windows versions.
    await promisify(execFile)('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${destDir}'`,
    ], { timeout: 120_000 });
  } else {
    // macOS and Linux ship unzip.
    await promisify(execFile)('unzip', ['-o', '-q', archivePath, '-d', destDir], { timeout: 120_000 });
  }
}

async function extractTarGz(archivePath, destDir) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  // tar is available on all supported platforms (Windows 10+ ships it natively).
  await promisify(execFile)('tar', ['-xzf', archivePath, '-C', destDir], { timeout: 120_000 });
}

// ── Main ──────────────────────────────────────────────────────────────────────

const platformKey = detectPlatformKey();
const asset       = PLATFORM_ASSETS[platformKey];

console.log('\n🎬 mpv Video Player Fetch for PHOBOS Media Hub');
console.log('─'.repeat(52));
console.log(`   Platform: ${platformKey}`);
console.log(`   Dest:     ${DEST_DIR}`);

if (!asset) {
  console.error(`❌ No mpv asset configured for platform: ${platformKey}`);
  if (platformKey === 'linux-arm64') {
    console.error('   linux-arm64: no pre-built static binary available.');
    console.error('   Install mpv via your package manager and symlink to:');
    console.error(`   ${path.join(DEST_DIR, 'mpv')}`);
  } else {
    console.error(`   Supported: ${Object.keys(PLATFORM_ASSETS).join(', ')}`);
  }
  process.exit(1);
}

const DEST_BINARY   = path.join(DEST_DIR, asset.binary);
const ARCHIVE_TMP   = path.join(DEST_DIR, asset.file + '.download');
const ARCHIVE_FINAL = path.join(DEST_DIR, asset.file);

fs.mkdirSync(DEST_DIR, { recursive: true });

// ── Fast-path: already present ────────────────────────────────────────────────

if (fs.existsSync(DEST_BINARY) && fs.statSync(DEST_BINARY).size >= asset.minBytes) {
  console.log(`✅ Already present (${(fs.statSync(DEST_BINARY).size / 1e6).toFixed(1)} MB) — nothing to do.`);
  process.exit(0);
}

// ── Download (resume-capable) ─────────────────────────────────────────────────

const existingBytes = fs.existsSync(ARCHIVE_TMP) ? fs.statSync(ARCHIVE_TMP).size : 0;
const reqHeaders    = existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {};

if (existingBytes > 0) {
  console.log(`\n📥 Resuming from ${(existingBytes / 1e6).toFixed(1)} MB…`);
} else {
  console.log(`\n📥 Downloading…`);
  console.log(`   ${asset.url}`);
}

let res;
try {
  res = await httpsGet(asset.url, reqHeaders);
} catch (err) {
  console.error(`❌ Request failed: ${err.message}`);
  process.exit(1);
}

if (res.statusCode === 404) {
  console.error(`❌ 404 — Asset not found at: ${asset.url}`);
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
  res.on('end',    () => fd.end());
  fd.on('finish',  () => { if (totalBytes > 0) process.stdout.write('\n'); resolve(); });
  fd.on('error',  reject);
  res.on('error', reject);
});

fs.renameSync(ARCHIVE_TMP, ARCHIVE_FINAL);

// ── Extract ───────────────────────────────────────────────────────────────────

console.log('\n📦 Extracting…');

try {
  if (asset.format === 'zip') {
    await extractZip(ARCHIVE_FINAL, DEST_DIR);
  } else {
    await extractTarGz(ARCHIVE_FINAL, DEST_DIR);
  }
} catch (err) {
  console.error(`❌ Extraction failed: ${err.message}`);
  process.exit(1);
}

fs.unlinkSync(ARCHIVE_FINAL);

// ── Platform-specific post-extraction ────────────────────────────────────────

if (platformKey === 'win32-x64') {
  // The outer zip contains a single inner zip with a date-stamped name,
  // e.g. mpv-git-2025-12-21-41f6a64-x86_64.zip — must extract that too.
  if (!fs.existsSync(DEST_BINARY)) {
    const innerZips = fs.readdirSync(DEST_DIR).filter(e =>
      e.toLowerCase().endsWith('.zip') && e.toLowerCase().startsWith('mpv')
    );
    if (innerZips.length === 0) {
      console.error('\u274c Expected inner mpv zip not found after outer extraction.');
      console.error(`   Contents of ${DEST_DIR}:`);
      for (const e of fs.readdirSync(DEST_DIR)) console.error(`     ${e}`);
      process.exit(1);
    }
    const innerZip = path.join(DEST_DIR, innerZips[0]);
    console.log(`   Extracting inner archive: ${innerZips[0]}`);
    try {
      await extractZip(innerZip, DEST_DIR);
    } catch (err) {
      console.error(`\u274c Inner zip extraction failed: ${err.message}`);
      process.exit(1);
    }
    fs.unlinkSync(innerZip);
  }
}

if (platformKey === 'darwin-arm64' || platformKey === 'darwin-x64') {
  // macOS zip extracts mpv.app bundle. Pull the binary out and discard the bundle.
  const bundledBin = path.join(DEST_DIR, asset.subdir);
  if (!fs.existsSync(DEST_BINARY)) {
    if (!fs.existsSync(bundledBin)) {
      console.error(`❌ Expected binary not found inside app bundle: ${bundledBin}`);
      console.error('   The zip structure may have changed. Inspect manually.');
      process.exit(1);
    }
    fs.copyFileSync(bundledBin, DEST_BINARY);
  }
  // Remove the app bundle — we only need the bare binary.
  const appBundle = path.join(DEST_DIR, 'mpv.app');
  if (fs.existsSync(appBundle)) {
    fs.rmSync(appBundle, { recursive: true, force: true });
  }
}

// ── Validate ──────────────────────────────────────────────────────────────────

if (!fs.existsSync(DEST_BINARY)) {
  console.error(`❌ Binary not found after extraction: ${DEST_BINARY}`);
  console.error('   The archive structure may have changed. Inspect the download manually.');
  process.exit(1);
}

const finalSize = fs.statSync(DEST_BINARY).size;
if (finalSize < asset.minBytes) {
  console.error(`❌ ${asset.binary} too small (${(finalSize / 1e6).toFixed(1)} MB) — extraction may be incomplete.`);
  process.exit(1);
}

// ── Unix: set executable bit ──────────────────────────────────────────────────

if (process.platform !== 'win32') {
  fs.chmodSync(DEST_BINARY, 0o755);
}

// ── macOS: strip Gatekeeper quarantine ───────────────────────────────────────

if (process.platform === 'darwin') {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('xattr', ['-d', 'com.apple.quarantine', DEST_BINARY]).catch(() => {});
    console.log('   Removed macOS quarantine flag (Gatekeeper bypass).');
  } catch { /* non-fatal */ }
}

// ── Done ──────────────────────────────────────────────────────────────────────

const sha = await sha256File(DEST_BINARY);
console.log(`\n✅ ${asset.binary}`);
console.log(`   Size:   ${(finalSize / 1e6).toFixed(1)} MB`);
console.log(`   SHA256: ${sha}`);
console.log(`   Path:   ${DEST_BINARY}`);
console.log(`\n✅ mpv ready. PHOBOS will use it automatically on next launch.\n`);
