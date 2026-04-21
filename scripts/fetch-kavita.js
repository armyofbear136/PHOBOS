#!/usr/bin/env node
// scripts/fetch-kavita.js — Download the Kavita reading server binary for PHOBOS Media Hub.
//
// Downloads a pinned release from GitHub into ~/.phobos/services/kavita/
// Handles macOS Gatekeeper quarantine removal automatically.
//
//   node scripts/fetch-kavita.js
//
// PHOBOS_OVERRIDE_PLATFORM=linux-x64 for cross-platform fetch.

import fs           from 'node:fs';
import https        from 'node:https';
import path         from 'node:path';
import os           from 'node:os';
import crypto       from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Release version ───────────────────────────────────────────────────────────
// MUST match KAVITA_RELEASE in KavitaManager.ts
// Check https://github.com/Kareadita/Kavita/releases for latest
const KAVITA_VERSION = '0.8.9.1';

// ── Platform → asset mapping ──────────────────────────────────────────────────
// All Kavita releases ship as .tar.gz — including Windows.
// Kavita.exe on Windows is a 193 KB launcher stub; the real runtime is API.dll.
// We probe API.dll for the size check (same pattern as JellyfinManager for jellyfin.dll).
const PLATFORM_ASSETS = {
  'linux-x64':    { file: `kavita-linux-x64.tar.gz`,   binary: 'Kavita',     probe: null,      minBytes: 80_000_000 },
  'linux-arm64':  { file: `kavita-linux-arm64.tar.gz`, binary: 'Kavita',     probe: null,      minBytes: 75_000_000 },
  'win32-x64':    { file: `kavita-win-x64.tar.gz`,     binary: 'Kavita.exe', probe: 'API.dll', minBytes: 8_000_000  },
  'darwin-x64':   { file: `kavita-osx-x64.tar.gz`,     binary: 'Kavita',     probe: null,      minBytes: 80_000_000 },
  'darwin-arm64': { file: `kavita-osx-arm64.tar.gz`,   binary: 'Kavita',     probe: null,      minBytes: 75_000_000 },
};

const GITHUB_BASE = `https://github.com/Kareadita/Kavita/releases/download/v${KAVITA_VERSION}`;

// ── Destination directory ─────────────────────────────────────────────────────
const DEST_DIR = path.join(os.homedir(), '.phobos', 'services', 'kavita');

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
          headers: { 'User-Agent': 'phobos-fetch-kavita/1.0', ...headers } },
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

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end',  () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// All platforms use tar — Windows 10+ ships tar.exe natively and handles .tar.gz fine.
// This replaces the previous Expand-Archive approach which only handled .zip.
async function extractTar(archivePath, destDir) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)('tar', ['-xzf', archivePath, '-C', destDir]);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const platformKey = detectPlatformKey();
const asset       = PLATFORM_ASSETS[platformKey];

console.log('\n📚 Kavita Reading Server Fetch for PHOBOS Media Hub');
console.log('─'.repeat(56));
console.log(`   Platform: ${platformKey}`);
console.log(`   Version:  ${KAVITA_VERSION}`);
console.log(`   Dest:     ${DEST_DIR}`);

if (!asset) {
  console.error(`❌ No Kavita asset for platform: ${platformKey}`);
  console.error(`   Supported: ${Object.keys(PLATFORM_ASSETS).join(', ')}`);
  process.exit(1);
}

const DEST_BINARY   = path.join(DEST_DIR, asset.binary);
const PROBE_FILE    = asset.probe ? path.join(DEST_DIR, asset.probe) : DEST_BINARY;
const ARCHIVE_TMP   = path.join(DEST_DIR, asset.file + '.download');
const ARCHIVE_FINAL = path.join(DEST_DIR, asset.file);

fs.mkdirSync(DEST_DIR, { recursive: true });
// Create config directory that PHOBOS will write appsettings.json into
fs.mkdirSync(path.join(DEST_DIR, 'config'), { recursive: true });

// Fast-path: probe file already present and large enough
if (fs.existsSync(PROBE_FILE) && fs.statSync(PROBE_FILE).size >= asset.minBytes) {
  console.log(`✅ Already present (${(fs.statSync(PROBE_FILE).size / 1e6).toFixed(1)} MB) — nothing to do.`);
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
  console.error(`   Check https://github.com/Kareadita/Kavita/releases for the correct version.`);
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
  await extractTar(ARCHIVE_FINAL, DEST_DIR);
} catch (err) {
  console.error(`❌ Extraction failed: ${err.message}`);
  process.exit(1);
}

fs.unlinkSync(ARCHIVE_FINAL);

// Kavita extracts into a subdirectory (e.g. "Kavita/"). Flatten it.
if (!fs.existsSync(DEST_BINARY)) {
  const entries = fs.readdirSync(DEST_DIR).filter(e =>
    fs.statSync(path.join(DEST_DIR, e)).isDirectory() && e.toLowerCase().includes('kavita')
  );
  if (entries.length > 0) {
    const subdir = path.join(DEST_DIR, entries[0]);
    for (const entry of fs.readdirSync(subdir)) {
      const src = path.join(subdir, entry);
      const dst = path.join(DEST_DIR, entry);
      // Don't overwrite our managed config directory
      if (entry === 'config' && fs.existsSync(dst)) continue;
      fs.renameSync(src, dst);
    }
    fs.rmdirSync(subdir, { recursive: true });
  }
}

// Remove the bundled appsettings-init.json — PHOBOS writes its own appsettings.json
// with the correct port and TokenKey. The init file would override ours on first boot.
const initFile = path.join(DEST_DIR, 'config', 'appsettings-init.json');
if (fs.existsSync(initFile)) {
  fs.unlinkSync(initFile);
  console.log('   Removed appsettings-init.json (PHOBOS will write appsettings.json)');
}

if (!fs.existsSync(DEST_BINARY)) {
  console.error(`❌ Binary not found after extraction: ${DEST_BINARY}`);
  console.error(`   Archive may extract to a different directory structure.`);
  process.exit(1);
}

// Size probe: on Windows check API.dll (the real runtime), not Kavita.exe (193 KB launcher stub).
const probeSize = fs.statSync(PROBE_FILE).size;
if (probeSize < asset.minBytes) {
  console.error(`❌ ${path.basename(PROBE_FILE)} too small (${(probeSize / 1e6).toFixed(1)} MB) — extraction may be incomplete.`);
  process.exit(1);
}

// Make executable on Unix
if (process.platform !== 'win32') {
  fs.chmodSync(DEST_BINARY, 0o755);
}

// macOS: remove Gatekeeper quarantine flag
// Without this, macOS shows "unidentified developer" and blocks execution.
if (process.platform === 'darwin') {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('xattr', ['-d', 'com.apple.quarantine', DEST_BINARY]).catch(() => {});
    console.log('   Removed macOS quarantine flag (Gatekeeper bypass)');
  } catch { /* non-fatal — may already be absent */ }
}

const sha = await sha256File(DEST_BINARY);
console.log(`\n✅ ${asset.binary}`);
console.log(`   Size:   ${(fs.statSync(DEST_BINARY).size / 1e6).toFixed(1)} MB (launcher)`);
if (asset.probe) {
  console.log(`   Runtime: ${asset.probe} — ${(probeSize / 1e6).toFixed(1)} MB`);
}
console.log(`   SHA256: ${sha}`);
console.log(`   Path:   ${DEST_BINARY}`);
console.log(`\n✅ Kavita ready. PHOBOS will start it automatically on next launch.\n`);
