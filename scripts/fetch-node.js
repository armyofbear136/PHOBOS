#!/usr/bin/env node
// scripts/fetch-node.js — downloads the portable Node.js runtime binary for
// each target platform into bin/.  CamofoxManager and MeridianManager use this
// binary to spawn their child processes in production, where process.execPath
// is the PHOBOS SEA binary and cannot execute arbitrary .js scripts.
//
// The binary version matches the esbuild target (node22 LTS) to avoid ABI
// mismatches between the SEA host and the child Node process.
//
// Output filenames (permanent wire contract — referenced by both managers):
//   bin/node-win32-x64.exe
//   bin/node-darwin-arm64
//   bin/node-darwin-x64
//   bin/node-linux-x64
//   bin/node-linux-arm64
//
// Usage:
//   node scripts/fetch-node.js                  ← current platform only
//   node scripts/fetch-node.js --all            ← all five platforms
//   node scripts/fetch-node.js --version=22.14.0

import https             from 'node:https';
import fs                from 'node:fs';
import path              from 'node:path';
import zlib              from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR   = path.resolve(__dirname, '..', 'bin');

// ── CLI ───────────────────────────────────────────────────────────────────────

const args     = process.argv.slice(2);
const fetchAll = args.includes('--all');
const vArg     = args.find(a => a.startsWith('--version='))?.split('=')[1] ?? null;

// ── Platform map ──────────────────────────────────────────────────────────────
// Windows: download node.exe directly — no archive, no extraction.
//   nodejs.org/dist/vX.Y.Z/node.exe is the official standalone binary.
// Unix: download .tar.gz and extract bin/node with a streaming tar parser.

const PLATFORMS = {
  'win32-x64': {
    url:     (v) => `https://nodejs.org/dist/v${v}/win-x64/node.exe`,
    outName: 'node-win32-x64.exe',
    format:  'direct',
  },
  'darwin-arm64': {
    url:         (v) => `https://nodejs.org/dist/v${v}/node-v${v}-darwin-arm64.tar.gz`,
    binInArchive:(v) => `node-v${v}-darwin-arm64/bin/node`,
    outName:     'node-darwin-arm64',
    format:      'tgz',
  },
  'darwin-x64': {
    url:         (v) => `https://nodejs.org/dist/v${v}/node-v${v}-darwin-x64.tar.gz`,
    binInArchive:(v) => `node-v${v}-darwin-x64/bin/node`,
    outName:     'node-darwin-x64',
    format:      'tgz',
  },
  'linux-x64': {
    url:         (v) => `https://nodejs.org/dist/v${v}/node-v${v}-linux-x64.tar.gz`,
    binInArchive:(v) => `node-v${v}-linux-x64/bin/node`,
    outName:     'node-linux-x64',
    format:      'tgz',
  },
  'linux-arm64': {
    url:         (v) => `https://nodejs.org/dist/v${v}/node-v${v}-linux-arm64.tar.gz`,
    binInArchive:(v) => `node-v${v}-linux-arm64/bin/node`,
    outName:     'node-linux-arm64',
    format:      'tgz',
  },
};

// ── HTTP ──────────────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 10) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(target);
      https.get({ hostname: parsed.hostname, path: parsed.pathname + parsed.search }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location, hops + 1);
        } else {
          resolve(res);
        }
      }).on('error', reject);
    };
    follow(url);
  });
}

async function getLatestLtsVersion() {
  console.log('  Querying nodejs.org for latest v22 LTS version...');
  const res = await httpsGet('https://nodejs.org/dist/index.json');
  const chunks = [];
  await new Promise((resolve, reject) => {
    res.on('data', c => chunks.push(c));
    res.on('end', resolve);
    res.on('error', reject);
  });
  const releases = JSON.parse(Buffer.concat(chunks).toString());
  const v22 = releases.find(r => r.version.startsWith('v22.') && r.lts);
  if (!v22) throw new Error('Could not find a v22 LTS release on nodejs.org');
  return v22.version.replace(/^v/, '');
}

// ── Download with progress ────────────────────────────────────────────────────

async function downloadToFile(url, dest) {
  const res = await httpsGet(url);
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode} fetching ${url}`);
  const total  = parseInt(res.headers['content-length'] ?? '0', 10);
  let received = 0;
  const out    = fs.createWriteStream(dest);
  await new Promise((resolve, reject) => {
    res.on('data', chunk => {
      received += chunk.length;
      out.write(chunk);
      if (total > 0) {
        const pct = Math.round((received / total) * 100);
        process.stdout.write(`\r    ${pct}% (${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB)  `);
      }
    });
    res.on('end', () => { out.end(); process.stdout.write('\n'); resolve(); });
    res.on('error', reject);
    out.on('error', reject);
  });
}

// ── TGZ extraction (streaming, pure Node, no external deps) ──────────────────

async function extractFromTgz(archivePath, memberPath, destPath) {
  return new Promise((resolve, reject) => {
    const inp    = fs.createReadStream(archivePath);
    const gunzip = zlib.createGunzip();
    let pending  = Buffer.alloc(0);
    let found    = false;
    let done     = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      inp.destroy();
      if (err) reject(err);
      else     resolve();
    };

    gunzip.on('error', finish);
    inp.on('error', finish);

    gunzip.on('data', chunk => {
      if (found || done) return;
      pending = Buffer.concat([pending, chunk]);
      while (!found && pending.length >= 512) {
        const header = pending.slice(0, 512);
        if (header.every(b => b === 0)) { finish(new Error(`Member not found: ${memberPath}`)); return; }
        const nameRaw  = header.slice(0, 100).toString('utf8').replace(/\0.*$/, '');
        const prefix   = header.slice(345, 500).toString('utf8').replace(/\0.*$/, '');
        const name     = prefix ? `${prefix}/${nameRaw}` : nameRaw;
        const size     = parseInt(header.slice(124, 136).toString('utf8').trim(), 8) || 0;
        const typeFlag = String.fromCharCode(header[156]);
        const blocks   = Math.ceil(size / 512) * 512;
        if (pending.length < 512 + blocks) break;
        const data = pending.slice(512, 512 + size);
        pending    = pending.slice(512 + blocks);
        if ((typeFlag === '0' || typeFlag === '\0' || typeFlag === '') && name === memberPath) {
          found = true;
          const out = fs.createWriteStream(destPath);
          out.write(data);
          out.end();
          out.on('finish', () => finish(null));
          out.on('error', finish);
          return;
        }
      }
    });
    gunzip.on('end', () => { if (!found && !done) finish(new Error(`Member not found: ${memberPath}`)); });
    inp.pipe(gunzip);
  });
}

// ── Per-platform fetch ────────────────────────────────────────────────────────

async function fetchPlatform(platformKey, version) {
  const spec = PLATFORMS[platformKey];
  if (!spec) throw new Error(`Unknown platform key: ${platformKey}`);

  const outPath = path.join(BIN_DIR, spec.outName);
  if (fs.existsSync(outPath)) {
    console.log(`  ✅ ${spec.outName} — already present, skipping`);
    return;
  }

  const url = spec.url(version);
  console.log(`  ⬇  ${spec.outName} ← ${url.split('/').pop()}`);

  if (spec.format === 'direct') {
    // Windows: download node.exe directly — no archive to extract.
    await downloadToFile(url, outPath);
  } else {
    // Unix: download .tar.gz then stream-extract the single binary.
    const archiveName = url.split('/').pop();
    const tmpPath     = path.join(BIN_DIR, `.tmp-${archiveName}`);
    await downloadToFile(url, tmpPath);
    console.log(`  📦 Extracting ${spec.binInArchive(version)}...`);
    try {
      await extractFromTgz(tmpPath, spec.binInArchive(version), outPath);
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
    fs.chmodSync(outPath, 0o755);
  }

  const sizeMb = (fs.statSync(outPath).size / 1e6).toFixed(1);
  console.log(`  ✅ ${spec.outName} (${sizeMb} MB)`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true });

  const version = vArg ?? await getLatestLtsVersion();
  console.log(`\nNode.js v${version} — target platforms:\n`);

  let targets;
  if (fetchAll) {
    targets = Object.keys(PLATFORMS);
  } else {
    const key = `${process.platform}-${process.arch}`;
    if (!PLATFORMS[key]) {
      console.error(`Unsupported platform: ${key}. Use --all to fetch all platforms.`);
      process.exit(1);
    }
    targets = [key];
  }

  for (const t of targets) {
    await fetchPlatform(t, version);
  }

  console.log('\n✅ Done. Node binaries are in bin/.\n');
  console.log('   build.js will stage them into dist/ automatically.');
  console.log('   CamofoxManager and MeridianManager will use the staged binary at runtime.\n');
}

main().catch(err => {
  console.error('\n❌ fetch-node failed:', err.message);
  process.exit(1);
});
