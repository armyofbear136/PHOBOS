#!/usr/bin/env node
// scripts/build-lite.js — PHOBOS-Lite build for a specific platform
//
// Produces a ZIP archive containing:
//   phobos-lite[.exe]     — server.js compiled as a Node.js SEA binary
//   llama-server[.exe]    — pre-built from llama.cpp releases
//   [shared libs]         — .dll/.so files required by llama-server
//
// Usage:
//   node scripts/build-lite.js                    <- auto-detect platform
//   node scripts/build-lite.js win32-x64
//   node scripts/build-lite.js darwin-arm64
//   node scripts/build-lite.js linux-x64
//
// Called automatically by build-full.js after the main phobos-core build.

import fs                from 'node:fs';
import path              from 'node:path';
import { execSync }      from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const LITE_SRC  = path.join(ROOT, 'packages', 'phobos-lite', 'server.js');
const LITE_DIST = path.join(ROOT, 'dist-lite');
const BIN_DIR   = path.join(ROOT, 'bin');

// ── Version — read from the launcher's source or use phobos-core version ────
const VERSION_FILE = path.join(ROOT, 'version.ts');
let LITE_VERSION = '0.1.0';
try {
  const vSrc = fs.readFileSync(VERSION_FILE, 'utf8');
  const m = vSrc.match(/CORE_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (m) LITE_VERSION = m[1];
} catch { /* use default */ }

// ── CLI args ─────────────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2).filter(a => !a.startsWith('-'));
const target  = rawArgs[0] ?? detectPlatform();

function detectPlatform() {
  const p = process.platform, a = process.arch;
  if (p === 'win32'  && a === 'x64')   return 'win32-x64';
  if (p === 'darwin' && a === 'arm64') return 'darwin-arm64';
  if (p === 'darwin' && a === 'x64')   return 'darwin-x64';
  if (p === 'linux'  && a === 'x64')   return 'linux-x64';
  if (p === 'linux'  && a === 'arm64') return 'linux-arm64';
  console.error(`❌ Unrecognised platform: ${p}/${a}`);
  process.exit(1);
}

const isWin = target.startsWith('win32');
const isMac = target.startsWith('darwin');
const ext   = isWin ? '.exe' : '';

console.log(`\n🚀 PHOBOS-Lite build — target: ${target}, version: ${LITE_VERSION}`);
console.log('─'.repeat(56));

// ── Verify source exists ─────────────────────────────────────────────────────
if (!fs.existsSync(LITE_SRC)) {
  console.error(`❌ Source not found: ${LITE_SRC}`);
  console.error('   Copy phobos-lite/server.js from the launcher repo into packages/phobos-lite/');
  process.exit(1);
}

// ── Prepare dist directory ───────────────────────────────────────────────────
const platformDir = path.join(LITE_DIST, target);
if (fs.existsSync(platformDir)) fs.rmSync(platformDir, { recursive: true, force: true });
fs.mkdirSync(platformDir, { recursive: true });

// ── 1. Bundle server.js with esbuild ─────────────────────────────────────────
// phobos-lite uses CommonJS (require) and has zero npm dependencies.
// esbuild bundles it into a single file for SEA injection.
console.log('\n📦 [1/4] Bundling server.js...');
const bundlePath = path.join(platformDir, 'phobos-lite.cjs');

// Dynamic import esbuild (it's already a devDep of phobos-core)
const { build: esbuild } = await import('esbuild');
await esbuild({
  entryPoints: [LITE_SRC],
  bundle:      true,
  platform:    'node',
  target:      'node22',
  format:      'cjs',
  outfile:     bundlePath,
});
console.log('   ✅ Bundle complete');

// ── 2. Compile to SEA binary ─────────────────────────────────────────────────
// Same pattern as phobos-core's build.js: esbuild → SEA blob → postject
console.log('\n🔧 [2/4] Creating SEA binary...');
const blobPath   = path.join(platformDir, 'sea-prep.blob');
const configPath = path.join(platformDir, 'sea-config.json');
const exePath    = path.join(platformDir, `phobos-lite${ext}`);

fs.writeFileSync(configPath, JSON.stringify({
  main:   bundlePath,
  output: blobPath,
  disableExperimentalSEAWarning: true,
  useCodeCache: true,
}, null, 2));

execSync(`node --experimental-sea-config "${configPath}"`, { stdio: 'inherit' });

// Copy the current Node binary and inject
fs.copyFileSync(process.execPath, exePath);
if (isMac) execSync(`codesign --remove-signature "${exePath}"`);

const machoFlag = isMac ? '--macho-segment-name NODE_SEA' : '';
execSync(
  `npx postject "${exePath}" NODE_SEA_BLOB "${blobPath}" ` +
  `--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 ${machoFlag}`.trimEnd(),
  { stdio: 'inherit' }
);
if (isMac) execSync(`codesign --sign - "${exePath}"`);

// Clean up intermediate files
fs.unlinkSync(bundlePath);
fs.unlinkSync(blobPath);
fs.unlinkSync(configPath);

console.log(`   ✅ SEA binary: ${path.basename(exePath)}`);

// ── 3. (Skipped) llama-server ───────────────────────────────────────────────
// phobos-lite handles its own dep prep at first boot via ensureLlamaServer().
// No binaries are bundled at build time.
console.log('\n  ℹ️  llama-server — installed by phobos-lite DepPrep at first boot (not bundled)');

// ── 4. Create ZIP archive  (step 3 of 3 effective steps) ────────────────────────────────────────────────────
console.log('\n📦 [4/4] Creating ZIP archive...');
const zipName = `phobos-lite-${target}-v${LITE_VERSION}.zip`;
const zipPath = path.join(LITE_DIST, zipName);

// Use the archive creation from fetch-llamacpp.js pattern — pure Node zip
// For simplicity and reliability, use the system zip command (available on all
// platforms — Windows has tar which can create zip, macOS/Linux have zip).
if (isWin) {
  // Windows: use PowerShell Compress-Archive
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${platformDir}\\*' -DestinationPath '${zipPath}' -Force"`,
    { stdio: 'inherit' }
  );
} else {
  // macOS/Linux: use zip
  execSync(`cd "${platformDir}" && zip -r "${zipPath}" .`, { stdio: 'inherit' });
}

// Write version file alongside the zip
fs.writeFileSync(path.join(LITE_DIST, 'version.txt'), LITE_VERSION);

// Write latest.json manifest
const manifest = {
  version: LITE_VERSION,
  platforms: {},
};
// Scan dist-lite/ for all zips to build the full manifest
for (const entry of fs.readdirSync(LITE_DIST)) {
  const m = entry.match(/^phobos-lite-([\w-]+)-v[\d.]+\.zip$/);
  if (m) {
    const plat = m[1];
    // Convert win32-x64 → win32-x64, darwin-arm64 → darwin-arm64 etc
    manifest.platforms[plat] = `phobos-lite-${plat}-v${LITE_VERSION}.zip`;
  }
}
fs.writeFileSync(path.join(LITE_DIST, 'latest.json'), JSON.stringify(manifest, null, 2));

// ── Report ───────────────────────────────────────────────────────────────────
const zipSize = fs.statSync(zipPath).size;
const exeSize = fs.statSync(exePath).size;

console.log(`\n╔${'═'.repeat(56)}╗`);
console.log(`║  ${'PHOBOS-LITE BUILD COMPLETE'.padEnd(54)}║`);
console.log(`╠${'═'.repeat(56)}╣`);
console.log(`║  ${'Target:'.padEnd(14)} ${target.padEnd(40)}║`);
console.log(`║  ${'Version:'.padEnd(14)} ${LITE_VERSION.padEnd(40)}║`);
console.log(`║  ${'Binary:'.padEnd(14)} ${(Math.round(exeSize / 1e6) + ' MB').padEnd(40)}║`);
console.log(`║  ${'Archive:'.padEnd(14)} ${zipName.padEnd(40)}║`);
console.log(`║  ${'Size:'.padEnd(14)} ${(Math.round(zipSize / 1e6) + ' MB').padEnd(40)}║`);
console.log(`║  ${'Output:'.padEnd(14)} ${'dist-lite/'.padEnd(40)}║`);
console.log(`╚${'═'.repeat(56)}╝`);