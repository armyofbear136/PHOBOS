#!/usr/bin/env node
// scripts/fetch-jellyfin.js — Download Jellyfin server + jellyfin-ffmpeg for PHOBOS Media Hub.
//
// Downloads two things:
//   1. Jellyfin portable combined release (server + web)
//   2. jellyfin-ffmpeg (required for all transcoding)
//
// Both land in ~/.phobos/services/jellyfin/
// Run standalone or automatically during build/enable.
//
//   node scripts/fetch-jellyfin.js
//   node scripts/fetch-jellyfin.js --ffmpeg-only
//   node scripts/fetch-jellyfin.js --server-only
//
// PHOBOS_OVERRIDE_PLATFORM=linux-x64 for cross-platform fetch.

import fs           from 'node:fs';
import https        from 'node:https';
import path         from 'node:path';
import os           from 'node:os';
import crypto       from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Release versions ──────────────────────────────────────────────────────────
// MUST match JELLYFIN_RELEASE in JellyfinManager.ts (not yet written)
const JELLYFIN_VERSION = '10.11.8';
// jellyfin-ffmpeg has independent versioning
const FFMPEG_VERSION   = '7.1.3-5';
const FFMPEG_DISTRO    = 'bookworm'; // Debian Bookworm (Ubuntu 22.04/24.04 compat)

// ── Platform → asset mapping ──────────────────────────────────────────────────
// Jellyfin portable release assets
const JELLYFIN_ASSETS = {
  'linux-x64':    { file: `jellyfin_${JELLYFIN_VERSION}_linux-x64.tar.gz`,   extract: 'tar', minBytes: 75_000_000  },
  'linux-arm64':  { file: `jellyfin_${JELLYFIN_VERSION}_linux-arm64.tar.gz`, extract: 'tar', minBytes: 70_000_000  },
  'win32-x64':    { file: `jellyfin_${JELLYFIN_VERSION}_win-x64.zip`,        extract: 'zip', minBytes: 80_000_000  },
  'darwin-arm64': { file: `jellyfin_${JELLYFIN_VERSION}_macos-arm64.tar.gz`, extract: 'tar', minBytes: 75_000_000  },
  'darwin-x64':   { file: `jellyfin_${JELLYFIN_VERSION}_macos-x64.tar.gz`,   extract: 'tar', minBytes: 75_000_000  },
};

// jellyfin-ffmpeg assets (Linux only for now — macOS/Windows use system FFmpeg)
const FFMPEG_ASSETS = {
  'linux-x64':   { file: `jellyfin-ffmpeg7_${FFMPEG_VERSION}-${FFMPEG_DISTRO}_amd64.tar.gz`, extract: 'tar', minBytes: 40_000_000 },
  'linux-arm64': { file: `jellyfin-ffmpeg7_${FFMPEG_VERSION}-${FFMPEG_DISTRO}_arm64.tar.gz`, extract: 'tar', minBytes: 35_000_000 },
};

const JELLYFIN_BASE = `https://github.com/jellyfin/jellyfin/releases/download/v${JELLYFIN_VERSION}`;
const FFMPEG_BASE   = `https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v${FFMPEG_VERSION}`;

// ── Destination directory ─────────────────────────────────────────────────────
const DEST_DIR    = path.join(os.homedir(), '.phobos', 'services', 'jellyfin');
const FFMPEG_DIR  = path.join(DEST_DIR, 'ffmpeg');

// ── CLI flags ─────────────────────────────────────────────────────────────────
const args         = process.argv.slice(2);
const ffmpegOnly   = args.includes('--ffmpeg-only');
const serverOnly   = args.includes('--server-only');

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
          headers: { 'User-Agent': 'phobos-fetch-jellyfin/1.0', ...headers } },
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

async function downloadFile(url, destPath) {
  const tmpPath  = destPath + '.download';
  const existing = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
  const headers  = existing > 0 ? { Range: `bytes=${existing}-` } : {};

  if (existing > 0) {
    process.stdout.write(`   Resuming from ${(existing / 1e6).toFixed(1)} MB…\n`);
  }

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
        process.stdout.write(`\r   ${Math.round(received / totalBytes * 100)}%  ${(received / 1e6).toFixed(1)} / ${(totalBytes / 1e6).toFixed(1)} MB`);
      }
    });
    res.on('end', () => fd.end());
    fd.on('finish', () => { if (totalBytes > 0) process.stdout.write('\n'); resolve(); });
    fd.on('error', reject);
    res.on('error', reject);
  });

  fs.renameSync(tmpPath, destPath);
  return destPath;
}

async function extractTar(archivePath, destDir) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)('tar', ['-xzf', archivePath, '-C', destDir]);
}

async function extractZip(archivePath, destDir) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)('powershell', [
    '-Command', `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
  ]);
}

async function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// ── Download and extract a service ───────────────────────────────────────────
async function fetchComponent(label, url, archiveFile, destDir, extractFn, minBytes, execName) {
  const archivePath = path.join(destDir, archiveFile);
  const execPath    = path.join(destDir, execName);

  // Fast-path: already present
  if (fs.existsSync(execPath) && fs.statSync(execPath).size >= minBytes * 0.4) {
    console.log(`✅ ${label} already present (${(fs.statSync(execPath).size / 1e6).toFixed(1)} MB)`);
    return;
  }

  console.log(`\n📥 Downloading ${label}…`);
  console.log(`   ${url}`);
  await downloadFile(url, archivePath);

  console.log(`📦 Extracting…`);
  await extractFn(archivePath, destDir);
  fs.unlinkSync(archivePath); // clean up archive

  if (!fs.existsSync(execPath)) {
    // Jellyfin extracts into a subdirectory — find and flatten
    const entries = fs.readdirSync(destDir);
    const subdir  = entries.find(e => fs.statSync(path.join(destDir, e)).isDirectory() && e.includes('jellyfin'));
    if (subdir) {
      // Move contents of subdir to destDir
      const subdirPath = path.join(destDir, subdir);
      for (const entry of fs.readdirSync(subdirPath)) {
        fs.renameSync(path.join(subdirPath, entry), path.join(destDir, entry));
      }
      fs.rmdirSync(subdirPath);
    }
  }

  if (!fs.existsSync(execPath)) {
    throw new Error(`Executable not found after extraction: ${execPath}\nArchive may use a different path.`);
  }

  const finalSize = fs.statSync(execPath).size;
  if (finalSize < minBytes * 0.4) {
    throw new Error(`Executable too small (${(finalSize / 1e6).toFixed(1)} MB) — may be corrupt.`);
  }

  if (process.platform !== 'win32') {
    fs.chmodSync(execPath, 0o755);
  }
  // macOS: remove quarantine
  if (process.platform === 'darwin') {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      await promisify(execFile)('xattr', ['-d', 'com.apple.quarantine', execPath]).catch(() => {});
    } catch { /* non-fatal */ }
  }

  const sha = await sha256(execPath);
  console.log(`✅ ${label}`);
  console.log(`   Size:   ${(finalSize / 1e6).toFixed(1)} MB`);
  console.log(`   SHA256: ${sha}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const platformKey = detectPlatformKey();
const jellyfinAsset = JELLYFIN_ASSETS[platformKey];
const ffmpegAsset   = FFMPEG_ASSETS[platformKey]; // undefined on macOS/Windows

console.log('\n📺 Jellyfin + FFmpeg Fetch for PHOBOS Media Hub');
console.log('─'.repeat(56));
console.log(`   Platform:        ${platformKey}`);
console.log(`   Jellyfin:        ${JELLYFIN_VERSION}`);
console.log(`   jellyfin-ffmpeg: ${FFMPEG_VERSION} (Linux only)`);
console.log(`   Destination:     ${DEST_DIR}`);

if (!jellyfinAsset) {
  console.error(`❌ No Jellyfin asset for platform: ${platformKey}`);
  console.error(`   Supported: ${Object.keys(JELLYFIN_ASSETS).join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(DEST_DIR,   { recursive: true });
fs.mkdirSync(FFMPEG_DIR, { recursive: true });

const jellyfinExec = process.platform === 'win32' ? 'jellyfin.exe' : 'jellyfin';
const ffmpegExec   = process.platform === 'win32' ? 'ffmpeg.exe'   : 'ffmpeg';

// ── Jellyfin server ───────────────────────────────────────────────────────────
if (!ffmpegOnly) {
  await fetchComponent(
    `Jellyfin ${JELLYFIN_VERSION}`,
    `${JELLYFIN_BASE}/${jellyfinAsset.file}`,
    jellyfinAsset.file,
    DEST_DIR,
    jellyfinAsset.extract === 'zip' ? extractZip : extractTar,
    jellyfinAsset.minBytes,
    jellyfinExec,
  );
}

// ── jellyfin-ffmpeg (Linux only) ──────────────────────────────────────────────
if (!serverOnly && ffmpegAsset) {
  await fetchComponent(
    `jellyfin-ffmpeg ${FFMPEG_VERSION}`,
    `${FFMPEG_BASE}/${ffmpegAsset.file}`,
    ffmpegAsset.file,
    FFMPEG_DIR,
    extractTar,
    ffmpegAsset.minBytes,
    ffmpegExec,
  );
} else if (!serverOnly && !ffmpegAsset) {
  console.log(`\nℹ️  jellyfin-ffmpeg not available for ${platformKey}.`);
  if (process.platform === 'win32') {
    console.log(`   Windows: Download FFmpeg from https://www.gyan.dev/ffmpeg/builds/`);
    console.log(`   Place ffmpeg.exe at: ${path.join(FFMPEG_DIR, 'ffmpeg.exe')}`);
  } else if (process.platform === 'darwin') {
    console.log(`   macOS: brew install ffmpeg`);
    console.log(`   PHOBOS will detect system FFmpeg automatically.`);
  }
}

console.log(`\n✅ Jellyfin ready. Enable it in PHOBOS → Media Hub → Video.\n`);
