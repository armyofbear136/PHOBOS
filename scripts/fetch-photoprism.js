#!/usr/bin/env node
// scripts/fetch-photoprism.js — Prepare PhotoPrism for PHOBOS Media Hub.
//
// Linux / macOS:  Downloads the native binary + assets/ from dl.photoprism.app CDN.
//
// Windows:        PhotoPrism has no native Windows binary. This script installs
//                 WSL2 (Windows Subsystem for Linux) if needed, then downloads
//                 the Linux binary into the WSL2 environment. PhotoPrismManager
//                 spawns it via `wsl.exe` at runtime. Port 16320 is available
//                 on localhost automatically via WSL2 port forwarding.
//
//                 WSL2 install requires admin privileges and one reboot.
//                 This script re-launches itself elevated if needed, runs
//                 `wsl --install --no-launch -d Ubuntu`, then exits with a
//                 clear reboot instruction. Run again after reboot to finish.
//
// Usage:
//   node scripts/fetch-photoprism.js
//   node scripts/fetch-photoprism.js --force   (re-download binary even if present)
//
// Cross-platform staging:
//   PHOBOS_OVERRIDE_PLATFORM=linux-x64 node scripts/fetch-photoprism.js

import fs            from 'node:fs';
import https         from 'node:https';
import path          from 'node:path';
import os            from 'node:os';
import crypto        from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify }  from 'node:util';
import { fileURLToPath } from 'node:url';

const exec      = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FORCE     = process.argv.includes('--force');

// ── Pinned release ─────────────────────────────────────────────────────────────
// Must match PHOTOPRISM_RELEASE_TAG in PhotoPrismManager.ts.
export const RELEASE_TAG = '260305-fad9d5395';

// Path on Windows where PhotoPrismManager.ts will look for the ready marker.
const DEST_DIR_WIN = path.join(os.homedir(), '.phobos', 'services', 'photoprism');

// Absolute path inside WSL2 where the binary will live.
// /root/.phobos mirrors the Windows user's ~/.phobos inside the WSL2 root user home.
const WSL_PHOBOS_DIR   = '/root/.phobos/services/photoprism';
const WSL_BINARY_PATH  = `${WSL_PHOBOS_DIR}/photoprism`;
const WSL_ASSETS_PATH  = `${WSL_PHOBOS_DIR}/assets`;
const WSL_DISTRO       = 'Ubuntu';

// ── Platform asset registry ───────────────────────────────────────────────────
const CDN_BASE    = 'https://dl.photoprism.app/pkg';
const GITHUB_BASE = `https://github.com/photoprism/photoprism/releases/download/${RELEASE_TAG}`;

const BINARY_ASSETS = {
  'linux-x64': {
    url:      `${CDN_BASE}/linux/photoprism_${RELEASE_TAG}-linux-amd64.tar.gz`,
    archive:  `photoprism_${RELEASE_TAG}-linux-amd64.tar.gz`,
    binary:   'photoprism',
    minBytes: 40_000_000,
  },
  'linux-arm64': {
    url:      `${CDN_BASE}/linux/photoprism_${RELEASE_TAG}-linux-arm64.tar.gz`,
    archive:  `photoprism_${RELEASE_TAG}-linux-arm64.tar.gz`,
    binary:   'photoprism',
    minBytes: 40_000_000,
  },
  'darwin-arm64': {
    url:      `${GITHUB_BASE}/photoprism_${RELEASE_TAG}-darwin-arm64.tar.gz`,
    archive:  `photoprism_${RELEASE_TAG}-darwin-arm64.tar.gz`,
    binary:   'photoprism',
    minBytes: 40_000_000,
  },
  'darwin-x64': {
    url:      `${GITHUB_BASE}/photoprism_${RELEASE_TAG}-darwin-amd64.tar.gz`,
    archive:  `photoprism_${RELEASE_TAG}-darwin-amd64.tar.gz`,
    binary:   'photoprism',
    minBytes: 40_000_000,
  },
  // Windows uses the Linux amd64 binary inside WSL2
  'win32-x64': {
    url:      `${CDN_BASE}/linux/photoprism_${RELEASE_TAG}-linux-amd64.tar.gz`,
    archive:  `photoprism_${RELEASE_TAG}-linux-amd64.tar.gz`,
    binary:   'photoprism',
    minBytes: 40_000_000,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 12) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(target);
      https.get(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search,
          headers: { 'User-Agent': 'phobos-fetch-photoprism/3.0', ...headers } },
        res => {
          if ([301, 302, 307, 308].includes(res.statusCode)) { follow(res.headers.location, hops + 1); return; }
          resolve(res);
        }
      ).on('error', reject);
    };
    follow(url);
  });
}

async function headCheck(url) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 12) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(target);
      const req = https.request(
        { method: 'HEAD', hostname: parsed.hostname, path: parsed.pathname + parsed.search,
          headers: { 'User-Agent': 'phobos-fetch-photoprism/3.0' } },
        res => {
          if ([301, 302, 307, 308].includes(res.statusCode)) { follow(res.headers.location, hops + 1); return; }
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on('error', reject);
      req.end();
    };
    follow(url);
  });
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', d => h.update(d));
    s.on('end',  () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

function fmtMiB(bytes) { return (bytes / (1024 * 1024)).toFixed(1) + ' MiB'; }

// Run a command inside WSL2 as root, return stdout.
async function wslRun(cmd) {
  const { stdout } = await exec('wsl.exe', ['-u', 'root', '-d', WSL_DISTRO, '--', 'bash', '-c', cmd]);
  return stdout.trim();
}

// ── Windows: WSL2 setup ───────────────────────────────────────────────────────

async function setupWindows() {
  console.log('\n📷  PhotoPrism — Windows Setup via WSL2');
  console.log('─'.repeat(56));
  console.log('    PhotoPrism has no native Windows binary.');
  console.log('    PHOBOS runs it inside WSL2 (Windows Subsystem for Linux).');
  console.log('    Port 16320 is forwarded to localhost automatically.\n');

  fs.mkdirSync(DEST_DIR_WIN, { recursive: true });

  // ── Phase 1: WSL2 availability check ──────────────────────────────────────
  let wslReady = false;
  try {
    const { stdout } = await exec('wsl.exe', ['--status']);
    // `wsl --status` exits 0 and prints version info when WSL2 is installed.
    // It exits non-zero or prints "not installed" when absent.
    if (stdout.includes('Default Version') || stdout.includes('Kernel version')) {
      wslReady = true;
    }
  } catch { /* wsl.exe absent or WSL not installed */ }

  if (!wslReady) {
    await installWSL2();
    // installWSL2() exits the process with reboot instructions — never returns.
  }

  // ── Phase 2: Ubuntu distro available ──────────────────────────────────────
  console.log('🔍  Checking WSL2 Ubuntu distro...');
  let ubuntuReady = false;
  try {
    const { stdout } = await exec('wsl.exe', ['-l', '-q']);
    // -q outputs bare distro names, one per line (UTF-16LE on Windows — strip nulls)
    const distros = stdout.replace(/\0/g, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    ubuntuReady = distros.some(d => d.toLowerCase().startsWith('ubuntu'));
    if (ubuntuReady) console.log(`    Ubuntu distro found ✓`);
  } catch { /* wsl -l failed */ }

  if (!ubuntuReady) {
    await installUbuntuDistro();
    // exits with reboot/re-run instructions — never returns.
  }

  // ── Phase 3: Verify WSL2 can execute commands ──────────────────────────────
  console.log('🔍  Testing WSL2 execution...');
  try {
    const result = await wslRun('echo ok');
    if (result !== 'ok') throw new Error(`unexpected output: ${result}`);
    console.log('    WSL2 execution working ✓');
  } catch (err) {
    console.error(`\n❌  WSL2 execution test failed: ${err.message}`);
    console.error('    Try opening Ubuntu from the Start menu once to complete first-run setup.');
    console.error('    Then re-run: node scripts/fetch-photoprism.js');
    process.exit(1);
  }

  // ── Phase 4: Binary present inside WSL2? ──────────────────────────────────
  if (!FORCE) {
    try {
      const sizeStr = await wslRun(`stat -c%s "${WSL_BINARY_PATH}" 2>/dev/null || echo 0`);
      const size    = parseInt(sizeStr, 10);
      const hasAssets = (await wslRun(`[ -d "${WSL_ASSETS_PATH}" ] && echo yes || echo no`)) === 'yes';
      if (size >= 40_000_000 && hasAssets) {
        console.log(`\n✅  PhotoPrism binary already present in WSL2 (${fmtMiB(size)})`);
        console.log('    Run with --force to re-download.\n');
        await writeReadyMarker('wsl2');
        return;
      }
    } catch { /* proceed to download */ }
  }

  // ── Phase 5: Download and extract into WSL2 ───────────────────────────────
  await downloadBinaryIntoWSL2();
  await writeReadyMarker('wsl2');
}

async function installWSL2() {
  console.log('⚙️   WSL2 is not installed. Installing now...');
  console.log('    This requires administrator privileges.');
  console.log('    A UAC prompt will appear — click Yes.\n');

  // Re-launch this script elevated via PowerShell if we're not already admin.
  // The elevated process will run wsl --install, then exit.
  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'fetch-photoprism.js');
  const psCmd = [
    `Start-Process -Wait -Verb RunAs -FilePath 'wsl.exe'`,
    `-ArgumentList '--install', '--no-launch', '-d', 'Ubuntu'`,
  ].join(' ');

  try {
    // Attempt elevated wsl --install via PowerShell RunAs.
    await new Promise((resolve, reject) => {
      const proc = spawn('powershell.exe', ['-Command', psCmd], { stdio: 'inherit' });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)));
      proc.on('error', reject);
    });
  } catch (err) {
    console.error(`\n❌  WSL2 installation failed: ${err.message}`);
    console.error('    Try running PowerShell as Administrator and running:');
    console.error('      wsl.exe --install --no-launch -d Ubuntu');
    console.error('    Then reboot and re-run: node scripts/fetch-photoprism.js');
    process.exit(1);
  }

  console.log('\n✅  WSL2 and Ubuntu installed.');
  console.log('═'.repeat(56));
  console.log('  ⚠️   A REBOOT IS REQUIRED before WSL2 is active.');
  console.log('');
  console.log('  After rebooting, run this script again to finish:');
  console.log('    node scripts/fetch-photoprism.js');
  console.log('═'.repeat(56) + '\n');
  process.exit(0);
}

async function installUbuntuDistro() {
  console.log('\n⚙️   Installing Ubuntu distro into WSL2...');
  try {
    await new Promise((resolve, reject) => {
      // --no-launch prevents the distro from opening an interactive terminal.
      const proc = spawn('wsl.exe', ['--install', '--no-launch', '-d', 'Ubuntu'], { stdio: 'inherit' });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)));
      proc.on('error', reject);
    });
  } catch (err) {
    console.error(`\n❌  Ubuntu install failed: ${err.message}`);
    console.error('    Try: wsl.exe --install --no-launch -d Ubuntu');
    process.exit(1);
  }

  console.log('\n✅  Ubuntu installed.');
  console.log('═'.repeat(56));
  console.log('  ⚠️   A REBOOT IS REQUIRED to activate the new distro.');
  console.log('');
  console.log('  After rebooting, run this script again to finish:');
  console.log('    node scripts/fetch-photoprism.js');
  console.log('═'.repeat(56) + '\n');
  process.exit(0);
}

async function downloadBinaryIntoWSL2() {
  const asset = BINARY_ASSETS['win32-x64'];

  console.log(`\n📥  Downloading PhotoPrism Linux binary into WSL2...`);
  console.log(`    Release : ${RELEASE_TAG}`);
  console.log(`    Source  : ${asset.url}`);
  console.log(`    Dest    : ${WSL_BINARY_PATH}`);

  // HEAD probe first.
  console.log('\n🔍  Probing URL...');
  let probeStatus;
  try { probeStatus = await headCheck(asset.url); }
  catch (err) { console.error(`❌  HEAD probe failed: ${err.message}`); process.exit(1); }
  if (probeStatus !== 200 && probeStatus !== 206) {
    console.error(`❌  HTTP ${probeStatus} from CDN`); process.exit(1);
  }
  console.log(`    HTTP ${probeStatus} ✓`);

  // Download to a Windows temp path, then move into WSL2 via cp.
  // Downloading inside WSL2 requires curl/wget in the distro — we can't
  // guarantee they're configured yet. Downloading from Node on the Windows
  // side is reliable and uses the existing httpsGet infrastructure.
  const tmpArchive = path.join(DEST_DIR_WIN, asset.archive + '.download');
  const finalArchive = path.join(DEST_DIR_WIN, asset.archive);

  const existingBytes = fs.existsSync(tmpArchive) ? fs.statSync(tmpArchive).size : 0;
  const reqHeaders    = existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {};
  console.log(existingBytes > 0
    ? `\n📥  Resuming from ${fmtMiB(existingBytes)}...`
    : `\n📥  Downloading...`);

  let res;
  try { res = await httpsGet(asset.url, reqHeaders); }
  catch (err) { console.error(`❌  Download failed: ${err.message}`); process.exit(1); }
  if (res.statusCode !== 200 && res.statusCode !== 206) {
    console.error(`❌  HTTP ${res.statusCode}`); process.exit(1);
  }

  const totalFromHeader = parseInt(res.headers['content-length'] ?? '0', 10);
  const totalBytes      = res.statusCode === 206 ? existingBytes + totalFromHeader : totalFromHeader;

  await new Promise((resolve, reject) => {
    const fd     = fs.createWriteStream(tmpArchive, { flags: existingBytes > 0 ? 'a' : 'w' });
    let received = existingBytes;
    res.on('data', chunk => {
      received += chunk.length;
      if (!fd.write(chunk)) { res.pause(); fd.once('drain', () => res.resume()); }
      if (totalBytes > 0)
        process.stdout.write(`\r    ${Math.round(received / totalBytes * 100)}%  ${fmtMiB(received)} / ${fmtMiB(totalBytes)}`);
    });
    res.on('end',   () => fd.end());
    fd.on('finish', () => { if (totalBytes > 0) process.stdout.write('\n'); resolve(); });
    fd.on('error', reject);
    res.on('error', reject);
  });

  fs.renameSync(tmpArchive, finalArchive);
  console.log('\n📦  Extracting into WSL2...');

  // Convert the Windows path of the archive to a WSL2 path (/mnt/c/Users/...)
  // wslpath does this conversion reliably.
  const wslArchivePath = (await exec('wsl.exe', ['-u', 'root', '-d', WSL_DISTRO,
    '--', 'wslpath', finalArchive.replace(/\\/g, '/')])).stdout.trim();

  // Create dest dir and extract inside WSL2.
  await wslRun(`mkdir -p "${WSL_PHOBOS_DIR}"`);
  await wslRun(`tar -xzf "${wslArchivePath}" -C "${WSL_PHOBOS_DIR}"`);
  await wslRun(`chmod +x "${WSL_BINARY_PATH}"`);

  // Clean up the Windows-side archive — it's now inside WSL2.
  fs.unlinkSync(finalArchive);

  // Verify binary and assets/ inside WSL2.
  const sizeStr = await wslRun(`stat -c%s "${WSL_BINARY_PATH}" 2>/dev/null || echo 0`);
  const size    = parseInt(sizeStr, 10);
  if (size < asset.minBytes) {
    console.error(`❌  Binary too small inside WSL2 (${fmtMiB(size)}) — corrupt?`);
    process.exit(1);
  }

  const hasAssets = (await wslRun(`[ -d "${WSL_ASSETS_PATH}" ] && echo yes || echo no`)) === 'yes';
  if (!hasAssets) {
    console.error(`❌  assets/ directory missing in WSL2 at: ${WSL_ASSETS_PATH}`);
    console.error('    PhotoPrism requires assets/ co-located with the binary.');
    process.exit(1);
  }

  console.log(`\n✅  PhotoPrism binary in WSL2`);
  console.log(`    Size     : ${fmtMiB(size)}`);
  console.log(`    Binary   : ${WSL_BINARY_PATH}`);
  console.log(`    assets/  : ${WSL_ASSETS_PATH}`);
  console.log(`\n✅  PhotoPrism ready. Enable it in PHOBOS → Media Hub.\n`);
}

async function writeReadyMarker(mode) {
  fs.mkdirSync(DEST_DIR_WIN, { recursive: true });
  fs.writeFileSync(
    path.join(DEST_DIR_WIN, 'wsl2-ready.json'),
    JSON.stringify({
      mode,
      wslDistro:   WSL_DISTRO,
      binaryPath:  WSL_BINARY_PATH,
      assetsPath:  WSL_ASSETS_PATH,
      releaseTag:  RELEASE_TAG,
      preparedAt:  new Date().toISOString(),
    }, null, 2)
  );
}

// ── Linux / macOS: native binary ──────────────────────────────────────────────

async function setupBinary(platformKey) {
  const asset = BINARY_ASSETS[platformKey];
  if (!asset) {
    console.error(`❌  No binary asset for platform: ${platformKey}`);
    console.error(`    Supported: ${Object.keys(BINARY_ASSETS).join(', ')}`);
    process.exit(1);
  }

  const DEST_DIR    = path.join(os.homedir(), '.phobos', 'services', 'photoprism');
  const DEST_BINARY = path.join(DEST_DIR, asset.binary);
  const ARCHIVE_TMP = path.join(DEST_DIR, asset.archive + '.download');
  const ARCHIVE_FIN = path.join(DEST_DIR, asset.archive);
  const assetsDir   = path.join(DEST_DIR, 'assets');

  console.log('\n📷  PhotoPrism Fetch');
  console.log('─'.repeat(56));
  console.log(`    Platform : ${platformKey}`);
  console.log(`    Release  : ${RELEASE_TAG}`);
  console.log(`    Dest     : ${DEST_DIR}`);

  fs.mkdirSync(DEST_DIR, { recursive: true });

  if (!FORCE && fs.existsSync(DEST_BINARY) && fs.statSync(DEST_BINARY).size >= asset.minBytes && fs.existsSync(assetsDir)) {
    console.log(`\n✅  Binary already present (${fmtMiB(fs.statSync(DEST_BINARY).size)}) — nothing to do.`);
    console.log('    Run with --force to re-download.\n');
    process.exit(0);
  }

  console.log('\n🔍  Probing URL...');
  let probe;
  try { probe = await headCheck(asset.url); }
  catch (err) { console.error(`❌  ${err.message}`); process.exit(1); }
  if (probe === 404) { console.error(`❌  404 — ${asset.url}`); process.exit(1); }
  if (probe !== 200 && probe !== 206) { console.error(`❌  HTTP ${probe}`); process.exit(1); }
  console.log(`    HTTP ${probe} ✓`);

  const existingBytes = fs.existsSync(ARCHIVE_TMP) ? fs.statSync(ARCHIVE_TMP).size : 0;
  const reqHeaders    = existingBytes > 0 ? { Range: `bytes=${existingBytes}-` } : {};
  console.log(existingBytes > 0 ? `\n📥  Resuming from ${fmtMiB(existingBytes)}...` : `\n📥  Downloading...\n    ${asset.url}`);

  let res;
  try { res = await httpsGet(asset.url, reqHeaders); }
  catch (err) { console.error(`❌  ${err.message}`); process.exit(1); }
  if (res.statusCode !== 200 && res.statusCode !== 206) { console.error(`❌  HTTP ${res.statusCode}`); process.exit(1); }

  const totalFromHeader = parseInt(res.headers['content-length'] ?? '0', 10);
  const totalBytes      = res.statusCode === 206 ? existingBytes + totalFromHeader : totalFromHeader;

  await new Promise((resolve, reject) => {
    const fd     = fs.createWriteStream(ARCHIVE_TMP, { flags: existingBytes > 0 ? 'a' : 'w' });
    let received = existingBytes;
    res.on('data', chunk => {
      received += chunk.length;
      if (!fd.write(chunk)) { res.pause(); fd.once('drain', () => res.resume()); }
      if (totalBytes > 0)
        process.stdout.write(`\r    ${Math.round(received / totalBytes * 100)}%  ${fmtMiB(received)} / ${fmtMiB(totalBytes)}`);
    });
    res.on('end',   () => fd.end());
    fd.on('finish', () => { if (totalBytes > 0) process.stdout.write('\n'); resolve(); });
    fd.on('error', reject);
    res.on('error', reject);
  });

  fs.renameSync(ARCHIVE_TMP, ARCHIVE_FIN);
  console.log('\n📦  Extracting full archive (binary + assets/)...');

  try { await exec('tar', ['-xzf', ARCHIVE_FIN, '-C', DEST_DIR]); }
  catch (err) { console.error(`❌  tar failed: ${err.message}`); process.exit(1); }
  fs.unlinkSync(ARCHIVE_FIN);

  if (!fs.existsSync(DEST_BINARY)) { console.error(`❌  Binary missing after extract`); process.exit(1); }
  if (fs.statSync(DEST_BINARY).size < asset.minBytes) { console.error(`❌  Binary too small`); process.exit(1); }
  if (!fs.existsSync(assetsDir)) { console.error(`❌  assets/ missing after extract`); process.exit(1); }

  fs.chmodSync(DEST_BINARY, 0o755);
  if (process.platform === 'darwin') {
    try { await exec('xattr', ['-d', 'com.apple.quarantine', DEST_BINARY]); } catch { /* non-fatal */ }
  }

  const sha = await sha256File(DEST_BINARY);
  console.log(`\n✅  ${asset.binary}`);
  console.log(`    Size   : ${fmtMiB(fs.statSync(DEST_BINARY).size)}`);
  console.log(`    SHA256 : ${sha}`);
  console.log(`    Path   : ${DEST_BINARY}`);
  console.log(`\n✅  PhotoPrism ready. Enable it in PHOBOS → Media Hub.\n`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

const override    = process.env.PHOBOS_OVERRIDE_PLATFORM;
const platformKey = override ?? `${process.platform}-${process.arch}`;

if (platformKey.startsWith('win32')) {
  await setupWindows();
} else {
  await setupBinary(platformKey);
}
