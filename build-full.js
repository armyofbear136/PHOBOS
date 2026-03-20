#!/usr/bin/env node
// scripts/build-full.js — PHOBOS full local build for a specific platform
//
// Replicates exactly what GitHub Actions does per-platform:
//   1. Fetches llama.cpp binaries for the target platform
//   2. Fetches sd.cpp binaries for the target platform
//   3. Runs build.js to bundle + package
//
// Usage:
//   node scripts/build-full.js                    ← auto-detect current platform
//   node scripts/build-full.js --force            ← wipe bin/ and re-download everything
//   node scripts/build-full.js win32-x64          ← explicit target
//   node scripts/build-full.js darwin-arm64
//   node scripts/build-full.js linux-x64
//   node scripts/build-full.js linux-arm64        ← skips sd.cpp (no arm64 release)
//   node scripts/build-full.js darwin-x64         ← macOS Intel (builds from source if no binary)
//   node scripts/build-full.js win32-arm64        ← Windows ARM (experimental)
//
// Cross-compilation note:
//   This script CAN fetch binaries for other platforms (they're just downloaded files),
//   but the SEA binary injected in step 3 uses the CURRENT machine's node executable.
//   For true cross-platform packaging you still need GitHub Actions (npm run build:all).
//   This script is primarily useful for building on the machine you're deploying to.

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root      = path.resolve(__dirname, '..');

const run = (cmd, opts = {}) =>
  execSync(cmd, { stdio: 'inherit', cwd: root, ...opts });

// ── Detect target platform ────────────────────────────────────────────────────
const rawArgs   = process.argv.slice(2).filter(a => !a.startsWith('-'));
const flags     = process.argv.slice(2).filter(a => a.startsWith('-'));
const arg       = rawArgs[0];
const forceClean = flags.includes('--force') || flags.includes('-f');

function detectPlatform() {
  const p = process.platform;
  const a = process.arch;
  if (p === 'win32'  && a === 'x64')   return 'win32-x64';
  if (p === 'win32'  && a === 'arm64') return 'win32-arm64';
  if (p === 'darwin' && a === 'arm64') return 'darwin-arm64';
  if (p === 'darwin' && a === 'x64')   return 'darwin-x64';
  if (p === 'linux'  && a === 'x64')   return 'linux-x64';
  if (p === 'linux'  && a === 'arm64') return 'linux-arm64';
  console.error(`❌ Unrecognised platform: ${p}/${a}`);
  console.error('   Pass an explicit target: win32-x64 | darwin-arm64 | linux-x64 | linux-arm64');
  process.exit(1);
}

const target = arg ?? detectPlatform();

// ── Platform config ───────────────────────────────────────────────────────────
// Maps target string → fetch scripts + notes
const PLATFORMS = {
  'win32-x64':   { fetchLlama: 'scripts/fetch-win32-x64.js',   fetchSd: true },
  'darwin-arm64':{ fetchLlama: 'scripts/fetch-darwin-arm64.js', fetchSd: true },
  'darwin-x64':  { fetchLlama: 'scripts/fetch-darwin-x64.js',   fetchSd: true  },
  'linux-x64':   { fetchLlama: 'scripts/fetch-linux-x64.js',    fetchSd: true  },
  'linux-arm64': { fetchLlama: 'scripts/fetch-linux-arm64.js',  fetchSd: false,
                   note: 'sd.cpp skipped — no linux-arm64 release binary. Image generation unavailable on this platform.' },
  'win32-arm64': { fetchLlama: null, fetchSd: false,
                   note: 'No pre-built binaries for win32-arm64. You will need to build llama.cpp from source and place binaries in bin/ manually.' },
};

const cfg = PLATFORMS[target];
if (!cfg) {
  console.error(`❌ Unknown target: ${target}`);
  console.error(`   Known targets: ${Object.keys(PLATFORMS).join(', ')}`);
  process.exit(1);
}

console.log(`\n🚀 PHOBOS full build — target: ${target}${forceClean ? ' (--force: wiping bin/)' : ''}`);
console.log('─'.repeat(52));

// ── Optional: wipe bin/ so fetch scripts re-download everything ───────────────
if (forceClean) {
  const { default: fs } = await import('node:fs');
  const binDir = path.join(root, 'bin');
  if (fs.existsSync(binDir)) {
    fs.rmSync(binDir, { recursive: true, force: true });
    console.log('🗑️  bin/ wiped — will re-download all binaries');
  }
}

// ── Step 1: Fetch llama.cpp ───────────────────────────────────────────────────
if (cfg.fetchLlama) {
  console.log(`\n📥 [1/3] Fetching llama.cpp binaries (${target})...`);
  run(`node ${cfg.fetchLlama}`);
} else {
  console.warn(`\n⚠️  [1/3] Skipping llama.cpp fetch — ${cfg.note ?? 'no fetch script for this platform'}`);
}

// ── Step 2: Fetch sd.cpp ──────────────────────────────────────────────────────
if (cfg.fetchSd) {
  console.log(`\n📥 [2/3] Fetching sd.cpp binaries (${target})...`);
  run('node scripts/fetch-sd-cpp.js');
} else {
  console.warn(`\n⚠️  [2/3] Skipping sd.cpp fetch — ${cfg.note ?? 'no sd.cpp release for this platform'}`);
}

// ── Step 3: Build ─────────────────────────────────────────────────────────────
console.log('\n🔨 [3/3] Building...');
if (cfg.note) console.log(`   Note: ${cfg.note}`);
run('node build.js');

console.log(`\n✅ Full build complete for ${target}`);
console.log('   Output: dist/');
