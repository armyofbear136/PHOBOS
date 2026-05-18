#!/usr/bin/env node
// scripts/build-app.js — Build the app/ electron frontend and stage into dist/
//
// Called by build.js (--unpacked) and build-full.js (full). Can run standalone.
//
// What it does:
//   1. npm install inside app/         (skipped if node_modules already fresh)
//   2. vite build --mode electron      (outputs to app/dist/)
//   3. electron-builder --dir          (always; fast unpacked build for dev/testing)
//   4. electron-builder --win/mac/linux (full pass; skipped with --unpacked)
//   5. Stage artifact → dist/          (only on full pass — never on --unpacked)
//
// --unpacked (npm run build, npm run build:app):
//   Runs passes 1-3 only. Produces app/electron-dist/win-unpacked/PHOBOS.exe.
//   Nothing is copied to dist/ — the unpacked dir is for local testing only.
//
// Without --unpacked (build:full, npm run build:app:win):
//   Runs all passes. Produces and stages:
//     Windows  → dist/PHOBOS-app-win-x64.exe
//     Linux    → dist/PHOBOS-app-linux-x64.AppImage
//     macOS    → dist/PHOBOS-app-macOS-arm64.dmg

import fs           from 'node:fs';
import path         from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const ROOT         = path.resolve(__dirname, '..');
const APP_DIR      = path.join(ROOT, 'app');
const DIST_DIR     = path.join(ROOT, 'dist');

const isWin        = process.platform === 'win32';
const isMac        = process.platform === 'darwin';
const unpackedOnly = process.argv.includes('--unpacked');

function log(msg) { console.log(msg); }

function run(cmd, cwd = ROOT) {
  execSync(cmd, { stdio: 'inherit', cwd });
}

// ── Guard — app/ must exist ───────────────────────────────────────────────────

if (!fs.existsSync(APP_DIR)) {
  console.error('❌  app/ directory not found.');
  console.error('   Copy phobos-frontend into app/ before running this script.');
  process.exit(1);
}
if (!fs.existsSync(path.join(APP_DIR, 'package.json'))) {
  console.error('❌  app/package.json not found — is app/ a complete copy of phobos-frontend?');
  process.exit(1);
}

log('\n📦 Building PHOBOS electron app...');
log('─'.repeat(56));
if (unpackedOnly) log('  mode: --unpacked (fast build, no dist staging)');

// ── 1. npm install ────────────────────────────────────────────────────────────

const nodeModules  = path.join(APP_DIR, 'node_modules');
const lockFile     = path.join(APP_DIR, 'package-lock.json');
const bunLock      = path.join(APP_DIR, 'bun.lock');
const sentinelPath = path.join(APP_DIR, 'node_modules', '.build-sentinel');

let needsInstall = !fs.existsSync(nodeModules);
if (!needsInstall && (fs.existsSync(lockFile) || fs.existsSync(bunLock))) {
  const lockPath    = fs.existsSync(lockFile) ? lockFile : bunLock;
  const lockMtime   = fs.statSync(lockPath).mtimeMs;
  const sentinelVal = fs.existsSync(sentinelPath)
    ? parseFloat(fs.readFileSync(sentinelPath, 'utf8').trim())
    : 0;
  needsInstall = lockMtime > sentinelVal;
}

if (needsInstall) {
  log('📥 Installing app/ dependencies...');
  run('npm install --no-audit --no-fund --loglevel=error', APP_DIR);
  fs.writeFileSync(sentinelPath, String(Date.now()));
  log('  ✅ app/node_modules/ ready');
} else {
  log('  ℹ️  app/node_modules/ up to date — skipping install');
}

// ── 2. Vite build (renderer) ──────────────────────────────────────────────────

log('🔨 Building renderer (vite --mode electron)...');

const appDist = path.join(APP_DIR, 'dist');
if (fs.existsSync(appDist)) fs.rmSync(appDist, { recursive: true, force: true });

const vite = path.join(APP_DIR, 'node_modules', '.bin', isWin ? 'vite.cmd' : 'vite');
run(`"${vite}" build --mode electron`, APP_DIR);
log('  ✅ app/dist/ built');

// ── 3. electron-builder pass 1: --dir (always) ───────────────────────────────
// Fast unpacked build — never touches winCodeSign so it never fails.
// On --unpacked this is the only electron-builder pass; we stop here.

log('📦 electron-builder pass 1: --dir (unpacked)...');

const electronBuilder = path.join(
  APP_DIR, 'node_modules', '.bin',
  isWin ? 'electron-builder.cmd' : 'electron-builder'
);
const ebEnv = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' };

const dirResult = spawnSync(electronBuilder, ['--dir'], {
  stdio: 'inherit',
  cwd:   APP_DIR,
  env:   ebEnv,
  shell: isWin,
});

const unpackedExe = path.join(APP_DIR, 'electron-dist', 'win-unpacked', 'PHOBOS.exe');
const unpackedOk  = dirResult.status === 0 || fs.existsSync(unpackedExe)
  || fs.existsSync(path.join(APP_DIR, 'electron-dist', 'linux-unpacked'))
  || fs.existsSync(path.join(APP_DIR, 'electron-dist', 'mac'));

if (!unpackedOk) {
  console.error('❌  electron-builder --dir failed — cannot continue.');
  process.exit(1);
}
log('  ✅ Pass 1 complete');

// Stop here when --unpacked. Nothing is copied to dist/.
if (unpackedOnly) {
  log('\n✅ App build complete (unpacked — no dist staging).');
  log('   app/electron-dist/win-unpacked/PHOBOS.exe  ← launch for testing');
  process.exit(0);
}

// ── 4. electron-builder pass 2: full platform artifact ───────────────────────

const platform = isWin ? '--win' : isMac ? '--mac' : '--linux';
log(`📦 electron-builder pass 2: ${platform} (single-file artifact)...`);

const fullResult = spawnSync(electronBuilder, [platform], {
  stdio: 'inherit',
  cwd:   APP_DIR,
  env:   ebEnv,
  shell: isWin,
});

const appPkg  = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
const version = appPkg.version ?? '0.0.0';

const artifactMap = {
  win32:  path.join(APP_DIR, 'electron-dist', `PHOBOS-${version}-win-x64.exe`),
  linux:  path.join(APP_DIR, 'electron-dist', `PHOBOS-${version}-linux-x64.AppImage`),
  darwin: path.join(APP_DIR, 'electron-dist', `PHOBOS-${version}-macOS-arm64.dmg`),
};
const artifact = artifactMap[process.platform];

if (!artifact || !fs.existsSync(artifact)) {
  console.error('❌  electron-builder did not produce the expected artifact.');
  if (fullResult.status !== 0) {
    console.error('   On Windows: enable Developer Mode (Settings → Developer Mode → On).');
  }
  process.exit(1);
}
log('  ✅ Pass 2 complete');

// ── 5. Stage artifact → dist/ ────────────────────────────────────────────────

log('📂 Staging electron artifact → dist/...');
fs.mkdirSync(DIST_DIR, { recursive: true });

const destNameMap = {
  win32:  'PHOBOS-app-win-x64.exe',
  linux:  'PHOBOS-app-linux-x64.AppImage',
  darwin: 'PHOBOS-app-macOS-arm64.dmg',
};
const destName = destNameMap[process.platform];
const dst      = path.join(DIST_DIR, destName);

if (fs.existsSync(dst)) fs.unlinkSync(dst);
fs.copyFileSync(artifact, dst);
if (!isWin) fs.chmodSync(dst, 0o755);

log(`\n✅ App build complete → dist/${destName}`);