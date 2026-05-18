#!/usr/bin/env node
// scripts/build-full.js — PHOBOS full local build for the current platform
//
// This is the release-quality build. It differs from npm run build in two ways:
//   1. The electron app is built with both passes — produces the single-file
//      portable PHOBOS-app-win-x64.exe (or AppImage/DMG on mac/linux).
//   2. dist-deps-backup/ is NOT copied — build.js runs a complete clean build
//      with full native dep staging from source every time.
//
// Usage:
//   node scripts/build-full.js                    ← auto-detect platform
//   node scripts/build-full.js win32-x64
//   node scripts/build-full.js darwin-arm64
//   node scripts/build-full.js linux-x64
//   node scripts/build-full.js linux-arm64
//   node scripts/build-full.js darwin-x64
//   node scripts/build-full.js --no-lite          ← skip PHOBOS-Lite step

import { execSync }      from 'node:child_process';
import fs                from 'node:fs';
import path              from 'node:path';
import https             from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root      = path.resolve(__dirname, '..');

// ── Load .env ─────────────────────────────────────────────────────────────────
(function loadDotEnv() {
  try {
    const p = path.join(root, '.env');
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {}
})();

const GH_HEADERS = {
  'User-Agent': 'phobos-build-full/1.0',
  'Accept':     'application/vnd.github+json',
  ...(process.env.GITHUB_TOKEN ? { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

// ── CLI args ──────────────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2).filter(a => !a.startsWith('-'));
const flags   = process.argv.slice(2).filter(a => a.startsWith('-'));
const arg     = rawArgs[0];

// ── Helpers ───────────────────────────────────────────────────────────────────
const run = (cmd, opts = {}) => {
  try {
    execSync(cmd, { stdio: 'inherit', cwd: root, ...opts });
  } catch (err) {
    const msg = err?.message ?? String(err);
    if (msg.includes('EBUSY') || msg.includes('resource busy') || msg.includes('locked')) {
      console.error('\n❌ Build failed: dist/ is locked by a running process.');
      console.error('   Close phobos-core (and any open terminals inside dist/) then try again.');
    }
    throw err;
  }
};

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 10) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(target);
      const isGH = parsed.hostname === 'api.github.com' || parsed.hostname === 'github.com';
      https.get(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: isGH ? GH_HEADERS : {} },
        res => {
          if ([301,302,307,308].includes(res.statusCode)) { follow(res.headers.location, hops+1); return; }
          resolve(res);
        }
      ).on('error', reject);
    };
    follow(url);
  });
}

async function getLatestLlama() {
  const res  = await httpsGet('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest');
  const body = await new Promise((r,j) => { let b=''; res.on('data',d=>b+=d); res.on('end',()=>r(b)); res.on('error',j); });
  return JSON.parse(body).tag_name;
}

async function getLatestSd() {
  const res  = await httpsGet('https://api.github.com/repos/leejet/stable-diffusion.cpp/releases?per_page=10');
  const body = await new Promise((r,j) => { let b=''; res.on('data',d=>b+=d); res.on('end',()=>r(b)); res.on('error',j); });
  const rels = JSON.parse(body);
  for (const r of rels) { if (r.assets?.length >= 6) return r.tag_name; }
  return rels[0]?.tag_name;
}

// ── Platform detection ────────────────────────────────────────────────────────
function detectPlatform() {
  const p = process.platform, a = process.arch;
  if (p === 'win32'  && a === 'x64')   return 'win32-x64';
  if (p === 'win32'  && a === 'arm64') return 'win32-arm64';
  if (p === 'darwin' && a === 'arm64') return 'darwin-arm64';
  if (p === 'darwin' && a === 'x64')   return 'darwin-x64';
  if (p === 'linux'  && a === 'x64')   return 'linux-x64';
  if (p === 'linux'  && a === 'arm64') return 'linux-arm64';
  console.error(`❌ Unrecognised platform: ${p}/${a}`);
  process.exit(1);
}

const target = arg ?? detectPlatform();

// ── Status tracking ───────────────────────────────────────────────────────────
const report = {
  target,
  upstreamLlama: null,
  upstreamSd:    null,
  buildOk:       false,
  liteOk:        null,   // true = built, false = failed, null = skipped
};

console.log(`\n🚀 PHOBOS build:full — target: ${target}`);
console.log('─'.repeat(56));

// ── Build phobos-core + electron app ─────────────────────────────────────────
// build.js handles:
//   - SEA binary (phobos-core[.exe])
//   - full native dep staging (duckdb, tree-sitter, onnx, sharp, etc.)
//   - electron app build via scripts/build-app.js (two-pass, no --unpacked)
//     producing dist/PHOBOS-app-win-x64.exe on Windows
//
// Note: build.js is NOT passed --no-app here. build:full always builds both.
// Note: dist-deps-backup/ is NOT copied. build:full does a complete clean build.
console.log('\n🔨 [1/2] Building phobos-core + electron app...');
run('node build.js --full-app --no-deps-backup');
report.buildOk = true;

// ── PHOBOS-Lite ───────────────────────────────────────────────────────────────
const skipLite = flags.includes('--no-lite');
if (!skipLite) {
  console.log('\n🔨 [2/2] Building phobos-lite...');
  try {
    run(`node scripts/build-lite.js ${target}`);
    report.liteOk = true;
  } catch (err) {
    console.warn(`⚠️  PHOBOS-Lite build failed (non-fatal): ${err.message}`);
    report.liteOk = false;
  }
} else {
  console.log('\n⏭️  PHOBOS-Lite skipped (--no-lite)');
  report.liteOk = null;
}

// ── Upstream version check ────────────────────────────────────────────────────
console.log('\n📡 Checking upstream versions...');
let upstreamLlama = null, upstreamSd = null;
try {
  [upstreamLlama, upstreamSd] = await Promise.all([
    getLatestLlama().catch(() => null),
    getLatestSd().catch(() => null),
  ]);
  report.upstreamLlama = upstreamLlama;
  report.upstreamSd    = upstreamSd;
} catch { /* non-fatal */ }

// ── Final report ──────────────────────────────────────────────────────────────
const W   = 68;
const pad = (s, n) => String(s).slice(0, n).padEnd(n);

console.log(`\n╔${'═'.repeat(W)}╗`);
console.log(`║  ${'PHOBOS BUILD REPORT'.padEnd(W-2)}║`);
console.log(`╠${'═'.repeat(W)}╣`);

const buildLine = report.buildOk ? '✅ Build complete → dist/phobos-core' : '⚠️  Build did not run';
console.log(`║  ${pad(buildLine, W-2)}║`);

if (report.liteOk === true) {
  console.log(`║  ${pad('✅ PHOBOS-Lite built → dist-lite/', W-2)}║`);
} else if (report.liteOk === false) {
  console.log(`║  ${pad('⚠️  PHOBOS-Lite build failed (non-fatal)', W-2)}║`);
} else {
  console.log(`║  ${pad('⏭️  PHOBOS-Lite skipped (--no-lite)', W-2)}║`);
}

console.log(`╠${'═'.repeat(W)}╣`);
console.log(`║  ${'UPSTREAM VERSIONS'.padEnd(W-2)}║`);
console.log(`╠${'═'.repeat(W)}╣`);
console.log(`║  ${'Package'.padEnd(14)} ${'Latest'.padEnd(26)} ${'Status'.padEnd(22)}║`);

for (const [label, latest] of [
  ['llama.cpp', upstreamLlama],
  ['sd.cpp',    upstreamSd],
]) {
  const lat = latest ?? 'unknown';
  const st  = !latest ? '(offline)' : '✅ fetched';
  console.log(`║  ${pad(label, 14)} ${pad(lat, 26)} ${pad(st, 22)}║`);
}

console.log(`╚${'═'.repeat(W)}╝`);