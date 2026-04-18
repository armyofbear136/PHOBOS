#!/usr/bin/env node
// scripts/fetch-jellyfin.js — Download Jellyfin server + jellyfin-ffmpeg for PHOBOS Media Hub.
//
// Downloads two things:
//   1. Jellyfin portable combined release (server + web)
//   2. jellyfin-ffmpeg (required for transcoding, Linux only)
//
// Both land in ~/.phobos/services/jellyfin/
//
//   node scripts/fetch-jellyfin.js
//   node scripts/fetch-jellyfin.js --ffmpeg-only
//   node scripts/fetch-jellyfin.js --server-only
//
// PHOBOS_OVERRIDE_PLATFORM=linux-x64 for cross-platform fetch.

import fs           from 'node:fs';
import https        from 'node:https';
import http         from 'node:http';
import path         from 'node:path';
import os           from 'node:os';
import crypto       from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Release versions ──────────────────────────────────────────────────────────
// MUST match JELLYFIN_RELEASE in JellyfinManager.ts
const JELLYFIN_VERSION = '10.11.8';
const FFMPEG_VERSION   = '7.1.3-5';
const FFMPEG_DISTRO    = 'bookworm';

// ── URL base per platform ─────────────────────────────────────────────────────
// Windows uses the Jellyfin repo (repo.jellyfin.org).
// Linux/macOS use GitHub releases.
// The repo.jellyfin.org path for Windows stable amd64:
//   https://repo.jellyfin.org/files/server/windows/latest-stable/amd64/
// The exact filename at that path is:
//   jellyfin_10.11.8-amd64.zip  (contains jellyfin_10.11.8-amd64/jellyfin/*)
const JELLYFIN_REPO_WIN  = `https://repo.jellyfin.org/files/server/windows/latest-stable/amd64`;
const JELLYFIN_BASE_GH   = `https://github.com/jellyfin/jellyfin/releases/download/v${JELLYFIN_VERSION}`;
const FFMPEG_BASE        = `https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v${FFMPEG_VERSION}`;

// ── Platform → asset mapping ──────────────────────────────────────────────────
// execName: the binary that PHOBOS spawns (must exist after flatten).
// On Windows, jellyfin.exe is a 197 KB launcher that invokes jellyfin.dll.
// The size gate checks jellyfin.dll (327 KB) instead — it must exist for the
// install to be valid. The spawnable is still jellyfin.exe.
const JELLYFIN_ASSETS = {
  'linux-x64':    {
    file:      `jellyfin_${JELLYFIN_VERSION}_linux-x64.tar.gz`,
    url:       `${JELLYFIN_BASE_GH}/jellyfin_${JELLYFIN_VERSION}_linux-x64.tar.gz`,
    extract:   'tar',
    execName:  'jellyfin',
    sizeProbe: 'jellyfin',        // binary to size-check
    minBytes:  75_000_000,
  },
  'linux-arm64':  {
    file:      `jellyfin_${JELLYFIN_VERSION}_linux-arm64.tar.gz`,
    url:       `${JELLYFIN_BASE_GH}/jellyfin_${JELLYFIN_VERSION}_linux-arm64.tar.gz`,
    extract:   'tar',
    execName:  'jellyfin',
    sizeProbe: 'jellyfin',
    minBytes:  70_000_000,
  },
  'win32-x64':    {
    file:      `jellyfin_${JELLYFIN_VERSION}-amd64.zip`,
    url:       `${JELLYFIN_REPO_WIN}/jellyfin_${JELLYFIN_VERSION}-amd64.zip`,
    extract:   'zip',
    execName:  'jellyfin.exe',
    // jellyfin.exe is a 197 KB launcher. jellyfin.dll is the 327 KB runtime.
    // Check jellyfin.dll to confirm a valid install, not the launcher.
    sizeProbe: 'jellyfin.dll',
    minBytes:  200_000,           // jellyfin.dll is ~327 KB; 200 KB is a safe floor
  },
  'darwin-arm64': {
    file:      `jellyfin_${JELLYFIN_VERSION}_macos-arm64.tar.gz`,
    url:       `${JELLYFIN_BASE_GH}/jellyfin_${JELLYFIN_VERSION}_macos-arm64.tar.gz`,
    extract:   'tar',
    execName:  'jellyfin',
    sizeProbe: 'jellyfin',
    minBytes:  75_000_000,
  },
  'darwin-x64':   {
    file:      `jellyfin_${JELLYFIN_VERSION}_macos-x64.tar.gz`,
    url:       `${JELLYFIN_BASE_GH}/jellyfin_${JELLYFIN_VERSION}_macos-x64.tar.gz`,
    extract:   'tar',
    execName:  'jellyfin',
    sizeProbe: 'jellyfin',
    minBytes:  75_000_000,
  },
};

const FFMPEG_ASSETS = {
  'linux-x64':   {
    file:      `jellyfin-ffmpeg7_${FFMPEG_VERSION}-${FFMPEG_DISTRO}_amd64.tar.gz`,
    url:       `${FFMPEG_BASE}/jellyfin-ffmpeg7_${FFMPEG_VERSION}-${FFMPEG_DISTRO}_amd64.tar.gz`,
    extract:   'tar',
    execName:  'ffmpeg',
    sizeProbe: 'ffmpeg',
    minBytes:  40_000_000,
  },
  'linux-arm64': {
    file:      `jellyfin-ffmpeg7_${FFMPEG_VERSION}-${FFMPEG_DISTRO}_arm64.tar.gz`,
    url:       `${FFMPEG_BASE}/jellyfin-ffmpeg7_${FFMPEG_VERSION}-${FFMPEG_DISTRO}_arm64.tar.gz`,
    extract:   'tar',
    execName:  'ffmpeg',
    sizeProbe: 'ffmpeg',
    minBytes:  35_000_000,
  },
};

// ── Destination directories ───────────────────────────────────────────────────
const DEST_DIR   = path.join(os.homedir(), '.phobos', 'services', 'jellyfin');
const FFMPEG_DIR = path.join(DEST_DIR, 'ffmpeg');

// ── CLI flags ─────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const ffmpegOnly = args.includes('--ffmpeg-only');
const serverOnly = args.includes('--server-only');

// ── Platform detection ────────────────────────────────────────────────────────
function detectPlatformKey() {
  const override = process.env.PHOBOS_OVERRIDE_PLATFORM;
  if (override) return override;
  return `${process.platform}-${process.arch}`;
}

// ── HTTPS/HTTP fetch with redirect following ──────────────────────────────────
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 10) { reject(new Error('Too many redirects')); return; }
      const parsed  = new URL(target);
      const mod     = parsed.protocol === 'https:' ? https : http;
      const req = mod.get(
        {
          hostname: parsed.hostname,
          port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path:     parsed.pathname + parsed.search,
          headers:  { 'User-Agent': 'phobos-fetch-jellyfin/1.0', ...headers },
        },
        res => {
          if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume(); // drain response
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

  if (existing > 0) {
    process.stdout.write(`   Resuming from ${(existing / 1e6).toFixed(1)} MB…\n`);
  }

  const res = await httpsGet(url, headers);
  if (res.statusCode === 404) throw new Error(`404 — Asset not found: ${url}`);
  if (res.statusCode !== 200 && res.statusCode !== 206) {
    throw new Error(`HTTP ${res.statusCode} for ${url}`);
  }

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
    '-Command',
    `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
  ]);
}

async function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', d => h.update(d));
    s.on('end',  () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// ── Recursive directory flattening ────────────────────────────────────────────
// Jellyfin's Windows zip extracts to a two-level path:
//   jellyfin_10.11.8-amd64/
//     jellyfin/
//       jellyfin.exe  ← actual files live here
//       jellyfin.dll
//       ...
//
// Linux tarballs extract to one level:
//   jellyfin/
//     jellyfin
//     ...
//
// This function walks into the single subdirectory until it finds the target
// executable, then moves all contents from that directory to destDir.
function flattenToDir(destDir, execName) {
  // BFS — find the directory that contains execName
  const queue = [destDir];
  while (queue.length) {
    const dir = queue.shift();
    const entries = fs.readdirSync(dir);
    if (entries.includes(execName)) {
      // Found the right level. If it's not destDir already, move everything up.
      if (dir !== destDir) {
        for (const entry of entries) {
          const src  = path.join(dir, entry);
          const dest = path.join(destDir, entry);
          if (!fs.existsSync(dest)) {
            fs.renameSync(src, dest);
          }
        }
        // Remove the now-empty intermediate directories.
        cleanupEmptyDirs(destDir);
      }
      return true;
    }
    // Queue subdirectories for the next level.
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) queue.push(full);
    }
  }
  return false; // execName not found anywhere
}

// Remove directories that are now empty (or contain only empty dirs) after flatten.
function cleanupEmptyDirs(baseDir) {
  for (const entry of fs.readdirSync(baseDir)) {
    const full = path.join(baseDir, entry);
    if (!fs.statSync(full).isDirectory()) continue;
    // Recurse first, then try to remove if empty.
    cleanupEmptyDirs(full);
    try { fs.rmdirSync(full); } catch { /* not empty — fine */ }
  }
}

// ── Download and install a component ─────────────────────────────────────────
async function fetchComponent(label, url, archiveFile, destDir, extractFn, asset) {
  const { execName, sizeProbe, minBytes } = asset;
  const execPath  = path.join(destDir, execName);
  const probePath = path.join(destDir, sizeProbe);

  // Fast-path: already present and valid size.
  if (fs.existsSync(probePath) && fs.statSync(probePath).size >= minBytes) {
    console.log(`✅ ${label} already present (${(fs.statSync(probePath).size / 1e6).toFixed(1)} MB)`);
    return;
  }

  console.log(`\n📥 Downloading ${label}…`);
  console.log(`   ${url}`);

  const archivePath = path.join(destDir, archiveFile);
  await downloadFile(url, archivePath);

  console.log(`📦 Extracting…`);
  await extractFn(archivePath, destDir);
  fs.unlinkSync(archivePath);

  // Flatten nested directories if needed.
  if (!fs.existsSync(execPath)) {
    const found = flattenToDir(destDir, execName);
    if (!found) {
      throw new Error(
        `Executable not found after extraction: ${execPath}\n` +
        `Archive layout may have changed. Check: ${destDir}`
      );
    }
  }

  // Verify the size-probe file.
  if (!fs.existsSync(probePath)) {
    throw new Error(`Size probe file missing after install: ${probePath}`);
  }
  const finalSize = fs.statSync(probePath).size;
  if (finalSize < minBytes) {
    throw new Error(
      `${sizeProbe} too small (${(finalSize / 1e6).toFixed(1)} MB < ${(minBytes / 1e6).toFixed(1)} MB) — may be corrupt.`
    );
  }

  if (process.platform !== 'win32') {
    try { fs.chmodSync(execPath, 0o755); } catch { /* non-fatal */ }
  }
  // macOS: strip quarantine attribute.
  if (process.platform === 'darwin') {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      await promisify(execFile)('xattr', ['-d', 'com.apple.quarantine', execPath]).catch(() => {});
    } catch { /* non-fatal */ }
  }

  const sha = await sha256(probePath);
  console.log(`✅ ${label}`);
  console.log(`   ${sizeProbe}: ${(finalSize / 1e6).toFixed(1)} MB`);
  console.log(`   SHA256: ${sha}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const platformKey    = detectPlatformKey();
const jellyfinAsset  = JELLYFIN_ASSETS[platformKey];
const ffmpegAsset    = FFMPEG_ASSETS[platformKey]; // undefined on macOS/Windows

console.log('\n📺 Jellyfin + FFmpeg Fetch for PHOBOS Media Hub');
console.log('─'.repeat(56));
console.log(`   Platform:        ${platformKey}`);
console.log(`   Jellyfin:        ${JELLYFIN_VERSION}`);
console.log(`   jellyfin-ffmpeg: ${FFMPEG_VERSION} (Linux only)`);
console.log(`   Destination:     ${DEST_DIR}`);

if (!jellyfinAsset) {
  console.error(`❌ No Jellyfin asset configured for platform: ${platformKey}`);
  console.error(`   Supported: ${Object.keys(JELLYFIN_ASSETS).join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(DEST_DIR,   { recursive: true });
fs.mkdirSync(FFMPEG_DIR, { recursive: true });

// ── Jellyfin server ───────────────────────────────────────────────────────────
if (!ffmpegOnly) {
  await fetchComponent(
    `Jellyfin ${JELLYFIN_VERSION}`,
    jellyfinAsset.url,
    jellyfinAsset.file,
    DEST_DIR,
    jellyfinAsset.extract === 'zip' ? extractZip : extractTar,
    jellyfinAsset,
  );
}

// ── jellyfin-ffmpeg (Linux only) ──────────────────────────────────────────────
if (!serverOnly && ffmpegAsset) {
  await fetchComponent(
    `jellyfin-ffmpeg ${FFMPEG_VERSION}`,
    ffmpegAsset.url,
    ffmpegAsset.file,
    FFMPEG_DIR,
    extractTar,
    ffmpegAsset,
  );
} else if (!serverOnly && !ffmpegAsset) {
  console.log(`\nℹ️  jellyfin-ffmpeg not bundled for ${platformKey}.`);
  if (process.platform === 'win32') {
    // The Windows zip already ships ffmpeg.exe and ffprobe.exe inside the
    // jellyfin directory (shown in the directory listing from 10.11.8-amd64).
    // PHOBOS will detect it via isFFmpegPresent() pointing at the bundled copy.
    console.log(`   Windows: ffmpeg.exe is bundled inside the Jellyfin zip — no separate download needed.`);
    console.log(`   Expected at: ${path.join(DEST_DIR, 'ffmpeg.exe')}`);
  } else if (process.platform === 'darwin') {
    console.log(`   macOS: brew install ffmpeg`);
    console.log(`   PHOBOS will detect system FFmpeg automatically.`);
  }
}

console.log(`\n✅ Jellyfin ready. Enable it in PHOBOS → Media Hub → Video.\n`);
