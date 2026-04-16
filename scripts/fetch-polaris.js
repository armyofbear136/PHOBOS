#!/usr/bin/env node
// scripts/fetch-polaris.js — Download Polaris and extract the CLI binary for PHOBOS Media Hub.
//
// Windows: downloads the MSI, extracts polaris-cli.exe via msiexec /a (no install).
// Linux:   downloads the source tarball and builds with cargo (Rust required).
// macOS:   same as Linux.
//
//   node scripts/fetch-polaris.js

import fs           from 'node:fs';
import https        from 'node:https';
import path         from 'node:path';
import os           from 'node:os';
import crypto       from 'node:crypto';
import { execFile, exec } from 'node:child_process';
import { promisify }      from 'node:util';
import { fileURLToPath }  from 'node:url';

const execFileAsync = promisify(execFile);
const execAsync     = promisify(exec);
const __dirname     = path.dirname(fileURLToPath(import.meta.url));

const POLARIS_VERSION = '0.16.0';
const MSI_URL         = `https://github.com/agersant/polaris/releases/download/${POLARIS_VERSION}/Polaris_${POLARIS_VERSION}.msi`;
const SOURCE_URL      = `https://github.com/agersant/polaris/releases/download/${POLARIS_VERSION}/Polaris_${POLARIS_VERSION}.tar.gz`;

const PLATFORM_ASSETS = {
  'win32-x64':    { url: MSI_URL,    file: `Polaris_${POLARIS_VERSION}.msi`,    method: 'msi',   binary: 'polaris-cli.exe', minBytes: 5_000_000 },
  'linux-x64':    { url: SOURCE_URL, file: `Polaris_${POLARIS_VERSION}.tar.gz`, method: 'cargo', binary: 'polaris',         minBytes: 5_000_000 },
  'linux-arm64':  { url: SOURCE_URL, file: `Polaris_${POLARIS_VERSION}.tar.gz`, method: 'cargo', binary: 'polaris',         minBytes: 5_000_000 },
  'darwin-x64':   { url: SOURCE_URL, file: `Polaris_${POLARIS_VERSION}.tar.gz`, method: 'cargo', binary: 'polaris',         minBytes: 5_000_000 },
  'darwin-arm64': { url: SOURCE_URL, file: `Polaris_${POLARIS_VERSION}.tar.gz`, method: 'cargo', binary: 'polaris',         minBytes: 5_000_000 },
};

const DEST_DIR = path.join(os.homedir(), '.phobos', 'services', 'polaris');

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
          headers: { 'User-Agent': 'phobos-fetch-polaris/2.0', ...headers } },
        res => {
          if ([301, 302, 307, 308].includes(res.statusCode)) { follow(res.headers.location, hops + 1); return; }
          resolve(res);
        }
      ).on('error', reject);
    };
    follow(url);
  });
}

async function download(url, destPath) {
  const existingBytes = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
  const reqHeaders    = existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {};

  if (existingBytes > 0) {
    console.log(`\n📥 Resuming from ${(existingBytes / 1e6).toFixed(1)} MB…`);
  } else {
    console.log(`\n📥 Downloading…\n   ${url}`);
  }

  const res = await httpsGet(url, reqHeaders);
  if (res.statusCode === 404) throw new Error(`404 — Asset not found at ${url}`);
  if (res.statusCode !== 200 && res.statusCode !== 206) throw new Error(`HTTP ${res.statusCode}`);

  const totalFromHeader = parseInt(res.headers['content-length'] ?? '0', 10);
  const totalBytes      = res.statusCode === 206 ? existingBytes + totalFromHeader : totalFromHeader;

  await new Promise((resolve, reject) => {
    const tmpPath = destPath + '.download';
    const fd      = fs.createWriteStream(tmpPath, { flags: existingBytes > 0 ? 'a' : 'w' });
    let received  = existingBytes;
    res.on('data', chunk => {
      received += chunk.length;
      if (!fd.write(chunk)) { res.pause(); fd.once('drain', () => res.resume()); }
      if (totalBytes > 0) process.stdout.write(`\r   ${Math.round(received / totalBytes * 100)}%  ${(received / 1e6).toFixed(1)} / ${(totalBytes / 1e6).toFixed(1)} MB`);
    });
    res.on('end', () => fd.end());
    fd.on('finish', () => { if (totalBytes > 0) process.stdout.write('\n'); fs.renameSync(tmpPath, destPath); resolve(); });
    fd.on('error', reject);
    res.on('error', reject);
  });
}

async function extractFromMsi(msiPath, extractDir) {
  console.log('\n📦 Extracting polaris-cli.exe from MSI (no install)…');
  fs.mkdirSync(extractDir, { recursive: true });
  await execAsync(`msiexec /a "${msiPath}" /qn TARGETDIR="${extractDir}"`, { windowsHide: true });

  function findBinary(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = findBinary(full); if (found) return found; }
      else if (entry.name.toLowerCase() === 'polaris-cli.exe') return full;
    }
    return null;
  }

  const found = findBinary(extractDir);
  if (!found) {
    const listing = [];
    function listAll(dir, depth = 0) {
      if (depth > 4) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        listing.push('  '.repeat(depth) + e.name);
        if (e.isDirectory()) listAll(path.join(dir, e.name), depth + 1);
      }
    }
    listAll(extractDir);
    throw new Error(`polaris-cli.exe not found after MSI extraction.\nContents:\n${listing.join('\n')}`);
  }
  return found;
}

async function buildFromSource(tarPath, buildDir) {
  console.log('\n🔧 Building Polaris from source (requires Rust)…');
  try { await execFileAsync('cargo', ['--version']); }
  catch { throw new Error('cargo not found. Install Rust: https://rustup.rs\nThen re-run: node scripts/fetch-polaris.js'); }

  const srcDir = path.join(buildDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  console.log('   Extracting source…');
  await execFileAsync('tar', ['-xzf', tarPath, '-C', srcDir, '--strip-components=1']);
  console.log('   Running cargo build --release (this will take a few minutes)…');
  await execAsync('cargo build --release --bin polaris', {
    cwd: srcDir, env: { ...process.env, CARGO_TERM_COLOR: 'always' }, timeout: 20 * 60 * 1000,
  });
  const built = path.join(srcDir, 'target', 'release', 'polaris');
  if (!fs.existsSync(built)) throw new Error(`Build completed but binary not found at ${built}`);
  return built;
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const s    = fs.createReadStream(filePath);
    s.on('data', d => hash.update(d));
    s.on('end',  () => resolve(hash.digest('hex')));
    s.on('error', reject);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

const platformKey = detectPlatformKey();
const asset       = PLATFORM_ASSETS[platformKey];

console.log('\n🎵 Polaris Fetch for PHOBOS Media Hub');
console.log('─'.repeat(50));
console.log(`   Platform: ${platformKey}`);
console.log(`   Version:  ${POLARIS_VERSION}`);
console.log(`   Method:   ${asset?.method ?? 'unsupported'}`);
console.log(`   Dest:     ${DEST_DIR}`);

if (!asset) {
  console.error(`\n❌ No Polaris asset for platform: ${platformKey}`);
  console.error(`   Supported: ${Object.keys(PLATFORM_ASSETS).join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(DEST_DIR, { recursive: true });

const DEST_BINARY  = path.join(DEST_DIR, asset.binary);
const ARCHIVE_PATH = path.join(DEST_DIR, asset.file);

if (fs.existsSync(DEST_BINARY) && fs.statSync(DEST_BINARY).size >= asset.minBytes) {
  console.log(`\n✅ Already present (${(fs.statSync(DEST_BINARY).size / 1e6).toFixed(1)} MB) — nothing to do.`);
  process.exit(0);
}

try { await download(asset.url, ARCHIVE_PATH); }
catch (err) { console.error(`\n❌ Download failed: ${err.message}`); process.exit(1); }

let builtBinaryPath;
try {
  if (asset.method === 'msi') {
    builtBinaryPath = await extractFromMsi(ARCHIVE_PATH, path.join(DEST_DIR, '_msi_extract'));
  } else {
    builtBinaryPath = await buildFromSource(ARCHIVE_PATH, path.join(DEST_DIR, '_build'));
  }
} catch (err) { console.error(`\n❌ ${err.message}`); process.exit(1); }

fs.copyFileSync(builtBinaryPath, DEST_BINARY);
if (process.platform !== 'win32') fs.chmodSync(DEST_BINARY, 0o755);
if (process.platform === 'darwin') {
  try { await execFileAsync('xattr', ['-d', 'com.apple.quarantine', DEST_BINARY]).catch(() => {}); } catch { /* non-fatal */ }
}

const finalSize = fs.statSync(DEST_BINARY).size;
if (finalSize < asset.minBytes) { console.error(`\n❌ Binary too small (${(finalSize / 1e6).toFixed(1)} MB)`); process.exit(1); }

const sha = await sha256File(DEST_BINARY);
console.log(`\n✅ ${asset.binary}`);
console.log(`   Size:   ${(finalSize / 1e6).toFixed(1)} MB`);
console.log(`   SHA256: ${sha}`);
console.log(`   Path:   ${DEST_BINARY}`);
console.log(`\n✅ Polaris ready. Enable it in PHOBOS → Media Hub → Music.\n`);