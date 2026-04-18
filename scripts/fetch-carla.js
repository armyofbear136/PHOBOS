#!/usr/bin/env node
// scripts/fetch-carla.js — Download Carla headless VST host for PHOBOS DAW stack.
//
// Windows: downloads the 64-bit standalone zip, extracts to ~/.phobos/services/carla/.
// macOS:   downloads the universal DMG, mounts it, copies Carla.app contents.
// Linux:   downloads the tarball and extracts.
//
//   node scripts/fetch-carla.js

import fs           from 'node:fs';
import https        from 'node:https';
import path         from 'node:path';
import os           from 'node:os';
import { execFile, exec } from 'node:child_process';
import { promisify }      from 'node:util';
import { fileURLToPath }  from 'node:url';

const execFileAsync = promisify(execFile);
const execAsync     = promisify(exec);
const __dirname     = path.dirname(fileURLToPath(import.meta.url));

const CARLA_VERSION = '2.5.10';
const CARLA_LINUX_VERSION = '2.2.0';  // falkTX stopped shipping Linux binaries after v2.2.0;
                                       //   Linux users normally install via distro packages.

// Per KXStudio (https://kx.studio/Applications:Carla), the canonical download URLs.
// VERIFIED 2026-04 against https://kx.studio/Applications:Carla which is maintained
// by falkTX (Carla's author) and spells out every URL explicitly:
//
//   Linux 32/64:   github.com/falkTX/Carla/releases/download/v2.2.0/Carla_2.2.0-linux{32,64}.tar.xz
//   macOS univ:    github.com/falkTX/Carla/releases/download/v2.5.10/Carla-2.5.10-macos-universal.dmg
//   Windows 32/64: github.com/falkTX/Carla/releases/download/v2.5.10/Carla-2.5.10-win{32,64}.zip
//
// The v2.5.10 assets use HYPHENS (`Carla-2.5.10-win64.zip`).
// The v2.2.0 Linux assets use UNDERSCORES (`Carla_2.2.0-linux64.tar.xz`). Both are current.
const WIN_MAC_BASE = `https://github.com/falkTX/Carla/releases/download/v${CARLA_VERSION}`;
const LINUX_BASE   = `https://github.com/falkTX/Carla/releases/download/v${CARLA_LINUX_VERSION}`;

const PLATFORM_ASSETS = {
  'win32-x64':    { url: `${WIN_MAC_BASE}/Carla-${CARLA_VERSION}-win64.zip`,                   file: `Carla-${CARLA_VERSION}-win64.zip`,           method: 'zip',  minBytes: 30_000_000 },
  'linux-x64':    { url: `${LINUX_BASE}/Carla_${CARLA_LINUX_VERSION}-linux64.tar.xz`,          file: `Carla_${CARLA_LINUX_VERSION}-linux64.tar.xz`, method: 'txz',  minBytes: 20_000_000 },
  'linux-arm64':  { url: `${LINUX_BASE}/Carla_${CARLA_LINUX_VERSION}-linux64.tar.xz`,          file: `Carla_${CARLA_LINUX_VERSION}-linux64.tar.xz`, method: 'txz',  minBytes: 20_000_000 },
  'darwin-x64':   { url: `${WIN_MAC_BASE}/Carla-${CARLA_VERSION}-macos-universal.dmg`,         file: `Carla-${CARLA_VERSION}-macos-universal.dmg`, method: 'dmg',  minBytes: 30_000_000 },
  'darwin-arm64': { url: `${WIN_MAC_BASE}/Carla-${CARLA_VERSION}-macos-universal.dmg`,         file: `Carla-${CARLA_VERSION}-macos-universal.dmg`, method: 'dmg',  minBytes: 30_000_000 },
};

const DEST_DIR = path.join(os.homedir(), '.phobos', 'services', 'carla');
const TMP_DIR  = path.join(DEST_DIR, '.tmp');

function detectPlatformKey() {
  return process.env.PHOBOS_OVERRIDE_PLATFORM ?? `${process.platform}-${process.arch}`;
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 10) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(target);
      https.get(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search,
          headers: { 'User-Agent': 'phobos-fetch-carla/1.0', ...headers } },
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

async function download(url, destPath) {
  const existing = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
  const headers  = existing > 0 ? { Range: `bytes=${existing}-` } : {};

  if (existing > 0) console.log(`\n📥 Resuming Carla from ${(existing / 1e6).toFixed(1)} MB…`);
  else              console.log(`\n📥 Downloading Carla…\n   ${url}`);

  const res = await httpsGet(url, headers);
  if (res.statusCode === 404) throw new Error(`404 — ${url}\n   Try a different CARLA_VERSION or check https://github.com/falkTX/Carla/releases`);
  if (res.statusCode !== 200 && res.statusCode !== 206) throw new Error(`HTTP ${res.statusCode}`);

  const contentLen = parseInt(res.headers['content-length'] ?? '0', 10);
  const totalBytes = res.statusCode === 206 ? existing + contentLen : contentLen;

  await new Promise((resolve, reject) => {
    const tmpPath = destPath + '.download';
    const fd      = fs.createWriteStream(tmpPath, { flags: existing > 0 ? 'a' : 'w' });
    let received  = existing;
    res.on('data', chunk => {
      received += chunk.length;
      if (totalBytes > 0) {
        const pct = (received / totalBytes * 100).toFixed(1);
        process.stdout.write(`\r   ${pct}%  (${(received / 1e6).toFixed(1)} / ${(totalBytes / 1e6).toFixed(1)} MB)`);
      }
    });
    res.pipe(fd);
    fd.on('finish', () => {
      fd.close();
      fs.renameSync(tmpPath, destPath);
      process.stdout.write('\n');
      resolve();
    });
    fd.on('error', reject);
  });
}

async function extractZip(archivePath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  if (process.platform === 'win32') {
    // PowerShell Expand-Archive is bundled on Windows 10+
    await execAsync(`powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${outDir}' -Force"`);
  } else {
    await execFileAsync('unzip', ['-oq', archivePath, '-d', outDir]);
  }
}

async function extractTarXz(archivePath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  await execFileAsync('tar', ['-xJf', archivePath, '-C', outDir]);
}

async function extractDmg(dmgPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  // hdiutil attach returns a mount point. Parse for the mount path.
  // v2.5.10 DMG volume name is "Carla-2.5.10" (hyphen). Match both old and
  // new forms so future version bumps don't silently break detection.
  await execFileAsync('hdiutil', ['attach', '-nobrowse', '-plist', dmgPath]);
  const { stdout: mountList } = await execFileAsync('mount');
  const match = mountList.match(/\/Volumes\/Carla[-_ ][^\s]+/);
  if (!match) throw new Error('Failed to locate Carla DMG mount point');
  const mountPoint = match[0];

  try {
    // Copy everything from the DMG into the destination
    await execAsync(`cp -R "${mountPoint}/"* "${outDir}/"`);
  } finally {
    await execFileAsync('hdiutil', ['detach', mountPoint]).catch(() => {});
  }
}

function locateCarlaBinary(rootDir, platformKey) {
  // Zip layouts vary between Carla versions. v2.5.10 extracts to
  //   <rootDir>/Carla-2.5.10-win64/Carla/Carla.exe
  // while older releases used <rootDir>/Carla/Carla.exe directly. Rather
  // than enumerate every possible shape, do a bounded recursive walk for
  // the binary name and return the first hit.
  const targetName =
    platformKey === 'win32-x64'      ? 'Carla.exe' :
    platformKey.startsWith('darwin-') ? 'Carla'      :  // inside Carla.app/Contents/MacOS
                                        'Carla';       // Linux standalone

  const queue = [rootDir];
  const MAX_DEPTH = 6;  // plenty — real depth is 2 or 3
  const seen = new Set();

  while (queue.length) {
    const dir = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }

    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.name === targetName && ent.isFile()) {
        // Sanity: on macOS we want the one inside .app/Contents/MacOS, not
        // an arbitrary file named "Carla". The path contains "Carla.app"
        // for the correct match.
        if (platformKey.startsWith('darwin-') && !full.includes('Carla.app')) continue;
        return full;
      }
      if (ent.isDirectory()) {
        // Depth check — count separators beyond the rootDir base.
        const depth = full.slice(rootDir.length).split(path.sep).filter(Boolean).length;
        if (depth <= MAX_DEPTH) queue.push(full);
      }
    }
  }
  return null;
}

async function main() {
  const platformKey = detectPlatformKey();
  const asset       = PLATFORM_ASSETS[platformKey];
  if (!asset) throw new Error(`No Carla asset configured for platform ${platformKey}`);

  fs.mkdirSync(DEST_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR,  { recursive: true });

  const archivePath = path.join(TMP_DIR, asset.file);
  const url         = asset.url;

  // Skip if a valid binary is already present
  const existingBin = locateCarlaBinary(DEST_DIR, platformKey);
  if (existingBin) {
    console.log(`✅ Carla already installed at ${existingBin}`);
    return;
  }

  if (!fs.existsSync(archivePath) || fs.statSync(archivePath).size < asset.minBytes) {
    await download(url, archivePath);
  } else {
    console.log(`✔ Archive already present at ${archivePath}`);
  }

  if (fs.statSync(archivePath).size < asset.minBytes) {
    throw new Error(`Downloaded archive below minimum size (${fs.statSync(archivePath).size} < ${asset.minBytes}). Corrupt download.`);
  }

  console.log(`\n📦 Extracting Carla…`);
  if      (asset.method === 'zip') await extractZip  (archivePath, DEST_DIR);
  else if (asset.method === 'txz') await extractTarXz(archivePath, DEST_DIR);
  else if (asset.method === 'dmg') await extractDmg  (archivePath, DEST_DIR);
  else throw new Error(`Unknown extract method: ${asset.method}`);

  const binPath = locateCarlaBinary(DEST_DIR, platformKey);
  if (!binPath) throw new Error(`Could not locate Carla binary after extract under ${DEST_DIR}`);

  if (process.platform !== 'win32') {
    try { fs.chmodSync(binPath, 0o755); } catch { /* non-fatal */ }
  }

  // Clean up archive once we've confirmed the binary landed
  try { fs.unlinkSync(archivePath); } catch { /* non-fatal */ }

  console.log(`\n✅ Carla installed.\n   Binary: ${binPath}`);
}

main().catch(err => { console.error(`\n❌ fetch-carla failed: ${err.message}`); process.exit(1); });
