#!/usr/bin/env node
// scripts/fetch-pigallery2.js — Download and install PiGallery2 for PHOBOS Media Hub.
//
// Downloads the latest release zip from GitHub (bpatrik/pigallery2), extracts it to
// ~/.phobos/services/pigallery2/, and runs npm install --omit=dev.
//
//   node scripts/fetch-pigallery2.js
//
// The release zip contains a pre-built dist/ directory — no build step required.
// npm install is needed to restore runtime node_modules after extraction.

import fs           from 'node:fs';
import https        from 'node:https';
import path         from 'node:path';
import os           from 'node:os';
import crypto       from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── Destination ───────────────────────────────────────────────────────────────

const DEST_DIR   = path.join(os.homedir(), '.phobos', 'services', 'pigallery2');
const ENTRY_POINT = path.join(DEST_DIR, 'dist', 'backend', 'server.js');
const GITHUB_REPO = 'bpatrik/pigallery2';

// ── Helpers ───────────────────────────────────────────────────────────────────

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 10) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(target);
      https.get(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search,
          headers: { 'User-Agent': 'phobos-fetch-pigallery2/1.0', ...headers } },
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

async function getLatestReleaseTag(repo) {
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await httpsGet(apiUrl, {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  });
  return new Promise((resolve, reject) => {
    let body = '';
    res.on('data', d => { body += d; });
    res.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.tag_name) throw new Error(`No tag_name in response: ${body.slice(0, 200)}`);
        resolve(data.tag_name);
      } catch (err) {
        reject(new Error(`Failed to parse release JSON: ${err.message}`));
      }
    });
    res.on('error', reject);
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

async function extractZipNode(archivePath, destDir) {
  // Use unzip on Unix, PowerShell on Windows.
  if (process.platform === 'win32') {
    await execFileAsync('powershell', [
      '-Command',
      `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`,
    ]);
  } else {
    await execFileAsync('unzip', ['-q', '-o', archivePath, '-d', destDir]);
  }
}

async function npmInstall(cwd) {
  console.log('   Running npm install --omit=dev…');
  // Use --omit=dev to skip devDependencies (build tools not needed at runtime).
  await execFileAsync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--omit=dev', '--no-audit', '--no-fund'],
    { cwd, stdio: 'pipe' },
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n🖼️  PiGallery2 Fetch for PHOBOS Media Hub');
console.log('─'.repeat(50));
console.log(`   Repo: ${GITHUB_REPO}`);
console.log(`   Dest: ${DEST_DIR}`);

// Fast-path: already installed.
if (fs.existsSync(ENTRY_POINT) && fs.statSync(ENTRY_POINT).size > 0
    && fs.existsSync(path.join(DEST_DIR, 'node_modules'))) {
  const pkg = fs.existsSync(path.join(DEST_DIR, 'package.json'))
    ? JSON.parse(fs.readFileSync(path.join(DEST_DIR, 'package.json'), 'utf8'))
    : {};
  console.log(`✅ Already installed (v${pkg.version ?? 'unknown'}) — nothing to do.`);
  process.exit(0);
}

// Fetch latest release tag.
console.log('\n🔍 Fetching latest release tag…');
let latestTag;
try {
  latestTag = await getLatestReleaseTag(GITHUB_REPO);
} catch (err) {
  console.error(`❌ Failed to fetch release info: ${err.message}`);
  process.exit(1);
}
console.log(`   Latest: ${latestTag}`);

// PiGallery2 release zip is named pigallery2-release.zip on all platforms.
const zipName    = 'pigallery2-release.zip';
const downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/${latestTag}/${zipName}`;
const archiveTmp  = path.join(os.tmpdir(), `pigallery2-${latestTag}.zip.download`);
const archiveFinal = path.join(os.tmpdir(), `pigallery2-${latestTag}.zip`);

fs.mkdirSync(DEST_DIR, { recursive: true });

// Resume-capable download.
const existingBytes = fs.existsSync(archiveTmp) ? fs.statSync(archiveTmp).size : 0;
const reqHeaders    = existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {};

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
  console.error(`❌ 404 — Release zip not found for ${latestTag}.`);
  console.error(`   Check https://github.com/${GITHUB_REPO}/releases`);
  process.exit(1);
}
if (res.statusCode !== 200 && res.statusCode !== 206) {
  console.error(`❌ HTTP ${res.statusCode}`);
  process.exit(1);
}

const totalFromHeader = parseInt(res.headers['content-length'] ?? '0', 10);
const totalBytes      = res.statusCode === 206 ? existingBytes + totalFromHeader : totalFromHeader;

await new Promise((resolve, reject) => {
  const fd     = fs.createWriteStream(archiveTmp, { flags: existingBytes > 0 ? 'a' : 'w' });
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

fs.renameSync(archiveTmp, archiveFinal);

console.log('\n📦 Extracting…');
try {
  await extractZipNode(archiveFinal, DEST_DIR);
} catch (err) {
  console.error(`❌ Extraction failed: ${err.message}`);
  process.exit(1);
}

fs.unlinkSync(archiveFinal);

// PiGallery2's release zip may extract into a subdirectory. Flatten if needed.
if (!fs.existsSync(ENTRY_POINT)) {
  const entries = fs.readdirSync(DEST_DIR).filter(e => {
    const full = path.join(DEST_DIR, e);
    return fs.statSync(full).isDirectory()
      && fs.existsSync(path.join(full, 'dist', 'backend', 'server.js'));
  });
  if (entries.length > 0) {
    const subdir = path.join(DEST_DIR, entries[0]);
    for (const entry of fs.readdirSync(subdir)) {
      fs.renameSync(path.join(subdir, entry), path.join(DEST_DIR, entry));
    }
    fs.rmdirSync(subdir, { recursive: true });
  }
}

if (!fs.existsSync(ENTRY_POINT)) {
  console.error(`❌ Entry point not found after extraction: ${ENTRY_POINT}`);
  console.error(`   The release zip may have an unexpected layout.`);
  process.exit(1);
}

// Install runtime dependencies.
try {
  await npmInstall(DEST_DIR);
} catch (err) {
  console.error(`❌ npm install failed: ${err.message}`);
  process.exit(1);
}

// Validate node_modules.
const nmDir = path.join(DEST_DIR, 'node_modules');
if (!fs.existsSync(nmDir) || fs.readdirSync(nmDir).length === 0) {
  console.error(`❌ node_modules missing or empty after npm install.`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(DEST_DIR, 'package.json'), 'utf8'));
const sha  = await sha256File(ENTRY_POINT);

console.log(`\n✅ PiGallery2 v${pkg.version ?? latestTag}`);
console.log(`   Entry:  ${ENTRY_POINT}`);
console.log(`   SHA256: ${sha}`);
console.log(`\n✅ PiGallery2 ready. Enable it in PHOBOS → Media Hub → Photos.\n`);
