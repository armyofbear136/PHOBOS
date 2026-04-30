#!/usr/bin/env node
// scripts/build-full.js — PHOBOS full local build for a specific platform
//
// Decision order for binaries:
//   1. bin-master/{platform}/ exists and checksums match manifest → use directly (fastest, offline-safe)
//   2. bin-master/ present but stale/incomplete → warn, copy what we have, fetch the rest
//   3. No bin-master/ → fetch from upstream
//   4. --force → wipe bin/, fetch latest from upstream regardless
//
// At the end prints a full status report: build result, upstream version comparison,
// and bin-master/ health for ALL platforms.
//
// Usage:
//   node scripts/build-full.js                    <- auto-detect platform
//   node scripts/build-full.js --force            <- wipe bin/, fetch latest
//   node scripts/build-full.js win32-x64
//   node scripts/build-full.js darwin-arm64
//   node scripts/build-full.js linux-x64
//   node scripts/build-full.js linux-arm64
//   node scripts/build-full.js darwin-x64

import { execSync }      from 'node:child_process';
import fs                from 'node:fs';
import path              from 'node:path';
import crypto            from 'node:crypto';
import https             from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const root       = path.resolve(__dirname, '..');
const MASTER_DIR = path.join(root, 'bin-master');
const MANIFEST   = path.join(__dirname, 'bin-manifest.json');
const BIN_DIR    = path.join(root, 'bin');

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
const rawArgs    = process.argv.slice(2).filter(a => !a.startsWith('-'));
const flags      = process.argv.slice(2).filter(a => a.startsWith('-'));
const arg        = rawArgs[0];
const forceClean = flags.includes('--force') || flags.includes('-f');
const fetchOnly  = flags.includes('--fetch-only'); // internal flag used by master-sync

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

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', d => hash.update(d));
    s.on('end', () => resolve(hash.digest('hex')));
    s.on('error', reject);
  });
}

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

function readManifest() {
  try { return fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {}; }
  catch { return {}; }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const [s,d] = [path.join(src, e.name), path.join(dst, e.name)];
    e.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

// ── Critical files per platform ───────────────────────────────────────────────
// These must exist for the build to be considered valid.
const CRITICAL = {
  'win32-x64':   ['llama-server-win32-x64.exe', 'ggml-vulkan.dll', 'ggml-cuda.dll'],
  'darwin-arm64':['llama-server-darwin-arm64'],
  'darwin-x64':  ['llama-server-darwin-x64'],
  'linux-x64':   ['llama-server-linux-x64'],
  'linux-arm64': ['llama-server-linux-arm64'],
};

// ── Platform config ───────────────────────────────────────────────────────────
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

const PLATFORM_CFG = {
  'win32-x64':   { fetchLlama: 'scripts/fetch-win32-x64.js',   fetchSd: true },
  'darwin-arm64':{ fetchLlama: 'scripts/fetch-darwin-arm64.js', fetchSd: true },
  'darwin-x64':  { fetchLlama: 'scripts/fetch-darwin-x64.js',   fetchSd: true },
  'linux-x64':   { fetchLlama: 'scripts/fetch-linux-x64.js',    fetchSd: true },
  'linux-arm64': { fetchLlama: 'scripts/fetch-linux-arm64.js',  fetchSd: false,
                   note: 'sd.cpp skipped — no linux-arm64 release binary.' },
  'win32-arm64': { fetchLlama: null, fetchSd: false,
                   note: 'No pre-built binaries for win32-arm64.' },
};

const cfg = PLATFORM_CFG[target];
if (!cfg) { console.error(`❌ Unknown target: ${target}`); process.exit(1); }

// ── Status tracking ───────────────────────────────────────────────────────────
const report = {
  target,
  masterUsed:       false,
  masterFallback:   [],
  fetched:          false,
  upstreamLlama:    null,
  upstreamSd:       null,
  pinnedLlama:      null,
  pinnedSd:         null,
  newLlama:         false,
  newSd:            false,
  missingFromMaster:[],
  buildOk:          false,
  liteOk:           null,    // true = built, false = failed, null = skipped
};

console.log(`\n🚀 PHOBOS build:full — target: ${target}${forceClean ? ' (--force)' : ''}`);
console.log('─'.repeat(56));

// ── Wipe bin/ if --force ──────────────────────────────────────────────────────
if (forceClean && fs.existsSync(BIN_DIR)) {
  fs.rmSync(BIN_DIR, { recursive: true, force: true });
  console.log('🗑️  bin/ wiped');
}

// ── Check bin-master/ ─────────────────────────────────────────────────────────
const manifest      = readManifest();
const masterPlatDir = path.join(MASTER_DIR, target);
const masterEntry   = manifest[target] ?? {};
report.pinnedLlama  = masterEntry.llama ?? null;
report.pinnedSd     = masterEntry.sd    ?? null;

const hasMaster = fs.existsSync(masterPlatDir);
let   usedMaster = false;

if (hasMaster && !forceClean) {
  const critical      = CRITICAL[target] ?? [];
  const manifestFiles = masterEntry.files ?? {};
  let allOk = critical.length > 0;

  for (const f of critical) {
    const fp       = path.join(masterPlatDir, f);
    const expected = manifestFiles[f.replace(/\\/g, '/')];
    if (!fs.existsSync(fp)) { allOk = false; report.missingFromMaster.push(f); continue; }
    if (expected) {
      const actual = await sha256File(fp);
      if (actual !== expected.sha256) { allOk = false; }
    }
  }

  if (allOk && critical.length > 0) {
    console.log(`\n✅ [1/3] bin-master/${target}/ verified — copying to bin/`);
    // Wipe bin/ first to ensure no stale files from other platforms remain
    if (fs.existsSync(BIN_DIR)) fs.rmSync(BIN_DIR, { recursive: true, force: true });
    copyDir(masterPlatDir, BIN_DIR);
    usedMaster = true;
    report.masterUsed = true;
  } else {
    console.log(`\n⚠️  [1/3] bin-master/${target}/ incomplete — will fetch missing files`);
    if (report.missingFromMaster.length) {
      console.log(`   Missing: ${report.missingFromMaster.join(', ')}`);
    }
  }
}

// ── Fetch if needed ───────────────────────────────────────────────────────────
if (!usedMaster) {
  if (cfg.fetchLlama) {
    const pinnedVer = report.pinnedLlama ? ` --version ${report.pinnedLlama}` : '';
    if (report.pinnedLlama) {
      console.log(`\n📥 [2/3] Fetching llama.cpp binaries (${target}) — pinned to ${report.pinnedLlama}...`);
    } else {
      console.log(`\n📥 [2/3] Fetching llama.cpp binaries (${target}) — ⚠️  NO PINNED VERSION, using latest...`);
    }
    run(`node ${cfg.fetchLlama}${pinnedVer}`);
  } else {
    console.warn(`\n⚠️  [2/3] ${cfg.note ?? 'No fetch script'}`);
  }
  if (cfg.fetchSd) {
    const pinnedSdVer = report.pinnedSd ? ` --version ${report.pinnedSd}` : '';
    if (report.pinnedSd) {
      console.log(`\n📥 Fetching sd.cpp binaries — pinned to ${report.pinnedSd}...`);
    } else {
      console.log('\n📥 Fetching sd.cpp binaries — ⚠️  NO PINNED VERSION, using latest...');
    }
    run(`node scripts/fetch-sd-cpp.js${pinnedSdVer}`);
  } else if (cfg.note) {
    console.warn(`   ${cfg.note}`);
  }
  report.fetched = true;

  // Note: node runtime binary is staged by build.js if present in bin/.
  // On production installs, DepPrep downloads it from PHOBOS-DEPS at first boot.
  // To pre-populate for dev: download node-{platform}-{arch}[.exe] from the
  // PHOBOS-DEPS release and place it in bin/.

  // Fallback: copy any missing critical files from bin-master/ if available
  if (hasMaster) {
    const critical = CRITICAL[target] ?? [];
    for (const f of critical) {
      const binPath    = path.join(BIN_DIR, f);
      const masterPath = path.join(masterPlatDir, f);
      if (!fs.existsSync(binPath) && fs.existsSync(masterPath)) {
        fs.mkdirSync(path.dirname(binPath), { recursive: true });
        fs.copyFileSync(masterPath, binPath);
        report.masterFallback.push(f);
        console.log(`   ↩️  Fallback: ${f} from bin-master/`);
      }
    }
  }
}

// ── Build ─────────────────────────────────────────────────────────────────────
if (!fetchOnly) {
  console.log('\n🔨 [3/3] Building phobos-core...');
  run('node build.js');
  report.buildOk = true;

  // ── PHOBOS-Lite — always built alongside core ──────────────────────────
  // Produces dist-lite/<target>/phobos-lite[.exe] + llama-server + shared libs
  // zipped into dist-lite/phobos-lite-<target>-v<version>.zip
  const skipLite = flags.includes('--no-lite');
  if (!skipLite) {
    console.log('\n🔨 Building phobos-lite...');
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
}

// ── Upstream version check ────────────────────────────────────────────────────
console.log('\n📡 Checking upstream versions...');
try {
  const [latestLlama, latestSd] = await Promise.all([
    getLatestLlama().catch(() => null),
    getLatestSd().catch(() => null),
  ]);
  report.upstreamLlama = latestLlama;
  report.upstreamSd    = latestSd;
  report.newLlama = !!(latestLlama && report.pinnedLlama && latestLlama !== report.pinnedLlama);
  report.newSd    = !!(latestSd    && report.pinnedSd    && latestSd    !== report.pinnedSd);
} catch { /* non-fatal */ }

// ── Scan ALL platforms in bin-master/ ────────────────────────────────────────
const ALL_PLATFORMS  = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];
const masterStatus   = [];
for (const plat of ALL_PLATFORMS) {
  const platDir   = path.join(MASTER_DIR, plat);
  const platEntry = manifest[plat] ?? {};
  const critical  = CRITICAL[plat] ?? [];
  const present   = critical.filter(f => fs.existsSync(path.join(platDir, f)));
  masterStatus.push({
    plat,
    ok:        present.length === critical.length && critical.length > 0,
    present:   present.length,
    total:     critical.length,
    pinned:    platEntry.llama ?? '—',
    isCurrent: plat === target,
  });
}

// ── Final report ──────────────────────────────────────────────────────────────
const W   = 68;
const pad = (s, n) => String(s).slice(0, n).padEnd(n);

console.log(`\n╔${'═'.repeat(W)}╗`);
console.log(`║  ${'PHOBOS BUILD REPORT'.padEnd(W-2)}║`);
console.log(`╠${'═'.repeat(W)}╣`);

// Build result line
const buildLine = report.buildOk      ? `✅ Build complete → dist/phobos-core`
                : fetchOnly           ? `📥 Fetch complete (build skipped)`
                :                       `⚠️  Build did not run`;
console.log(`║  ${pad(buildLine, W-2)}║`);
console.log(`║  ${pad(`Source: ${report.masterUsed ? `bin-master/${target}/ (verified)` : 'fetched from upstream'}`, W-2)}║`);

// Lite build status
if (report.liteOk === true) {
  console.log(`║  ${pad('✅ PHOBOS-Lite built → dist-lite/', W-2)}║`);
} else if (report.liteOk === false) {
  console.log(`║  ${pad('⚠️  PHOBOS-Lite build failed (non-fatal)', W-2)}║`);
} else if (report.liteOk === null) {
  console.log(`║  ${pad('⏭️  PHOBOS-Lite skipped (--no-lite)', W-2)}║`);
}

// Fallback files
if (report.masterFallback.length) {
  console.log(`╠${'═'.repeat(W)}╣`);
  console.log(`║  ⚠️  ${pad('Fallback files used from bin-master/:', W-5)}║`);
  for (const f of report.masterFallback) console.log(`║     ${pad('↩ '+f, W-5)}║`);
}

// Files missing from master (had to fetch)
if (report.missingFromMaster.length) {
  console.log(`╠${'═'.repeat(W)}╣`);
  console.log(`║  ⚠️  ${pad('Missing from bin-master/ — fetched from upstream:', W-5)}║`);
  for (const f of report.missingFromMaster) console.log(`║     ${pad('✗ '+f, W-5)}║`);
  console.log(`║     ${pad('Run: npm run master:update  to refresh bin-master/', W-5)}║`);
}

// Upstream version table
console.log(`╠${'═'.repeat(W)}╣`);
console.log(`║  ${'UPSTREAM VERSIONS'.padEnd(W-2)}║`);
console.log(`╠${'═'.repeat(W)}╣`);
console.log(`║  ${'Package'.padEnd(12)} ${'Pinned'.padEnd(20)} ${'Latest'.padEnd(20)} ${''.padEnd(10)}║`);

for (const [label, pinned, latest, isNew] of [
  ['llama.cpp', report.pinnedLlama, report.upstreamLlama, report.newLlama],
  ['sd.cpp',    report.pinnedSd,    report.upstreamSd,    report.newSd],
]) {
  const pin = pinned ?? '—';
  const lat = latest ?? 'unknown';
  const st  = !latest ? '(offline)' : isNew ? '🔄 update avail' : '✅ current';
  console.log(`║  ${pad(label, 12)} ${pad(pin, 20)} ${pad(lat, 20)} ${pad(st, 10)}║`);
}

if (report.newLlama || report.newSd) {
  console.log(`╠${'═'.repeat(W)}╣`);
  console.log(`║  ℹ️  ${pad('To update pinned versions: npm run master:update', W-5)}║`);
}

// bin-master health for all platforms
console.log(`╠${'═'.repeat(W)}╣`);
console.log(`║  ${'BIN-MASTER/ HEALTH'.padEnd(W-2)}║`);
console.log(`╠${'═'.repeat(W)}╣`);
for (const s of masterStatus) {
  const arrow  = s.isCurrent ? '▶' : ' ';
  const status = s.total === 0 ? pad('○ no master yet', 22)
               : !s.ok         ? pad(`⚠️  ${s.present}/${s.total} critical files`, 22)
               :                  pad(`✅ ${s.present}/${s.total} files ok`, 22);
  const pin    = s.pinned !== '—' ? `pinned: ${s.pinned}` : 'not pinned';
  console.log(`║  ${arrow} ${pad(s.plat, 14)} ${status} ${pad(pin, 24)}║`);
}

const anyEmpty = masterStatus.some(s => s.total > 0 && s.present === 0);
if (anyEmpty) {
  console.log(`╠${'═'.repeat(W)}╣`);
  console.log(`║  ℹ️  ${pad('Populate all platforms: npm run master:sync', W-5)}║`);
}

console.log(`╚${'═'.repeat(W)}╝`);