#!/usr/bin/env node
// scripts/master-sync.js — PHOBOS bin-master/ sync and manifest management
//
// Maintains a local bin-master/ directory containing pinned binaries for ALL
// platforms. bin-master/ is in .gitignore — only bin-manifest.json is committed.
// The manifest records pinned versions + sha256 checksums so any machine can
// reproduce the exact same binaries from the same source releases.
//
// Usage:
//   node scripts/master-sync.js               ← sync all platforms using pinned manifest versions
//   node scripts/master-sync.js --update      ← fetch latest for all platforms, update manifest
//   node scripts/master-sync.js --update win32-x64   ← update one platform only
//   node scripts/master-sync.js --check       ← validate bin-master/ against manifest, no downloads
//   node scripts/master-sync.js --platform win32-x64 ← sync one platform only
//
// npm scripts:
//   master:sync    → node scripts/master-sync.js
//   master:update  → node scripts/master-sync.js --update
//   master:check   → node scripts/master-sync.js --check

import fs       from 'node:fs';
import path     from 'node:path';
import crypto   from 'node:crypto';
import https    from 'node:https';
import { execSync }      from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const ROOT         = path.resolve(__dirname, '..');
const MASTER_DIR   = path.join(ROOT, 'bin-master');
const MANIFEST     = path.join(__dirname, 'bin-manifest.json');
const TMP_DIR      = path.join(ROOT, 'bin', '.tmp');

const args          = process.argv.slice(2);
const MODE_UPDATE   = args.includes('--update');
const MODE_CHECK    = args.includes('--check');
const platformArg   = args.find(a => !a.startsWith('-'));
const PLATFORMS     = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];
const targets       = platformArg ? [platformArg] : PLATFORMS;

// ── Load .env ────────────────────────────────────────────────────────────────
(function loadDotEnv() {
  try {
    const p = path.join(ROOT, '.env');
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {}
})();

const GH_HEADERS = {
  'User-Agent': 'phobos-master-sync/1.0',
  'Accept':     'application/vnd.github+json',
  ...(process.env.GITHUB_TOKEN ? { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 10) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(target);
      const isGithub = parsed.hostname === 'api.github.com' || parsed.hostname === 'github.com';
      const headers  = isGithub ? GH_HEADERS : {};
      https.get({ hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers },
        res => {
          if ([301,302,307,308].includes(res.statusCode)) { follow(res.headers.location, hops+1); return; }
          resolve(res);
        }).on('error', reject);
    };
    follow(url);
  });
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function downloadFile(url, dest) {
  const res = await httpsGet(url);
  if (res.statusCode === 404) return { status: 404 };
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode} for ${url}`);
  return new Promise((resolve, reject) => {
    const fd = fs.createWriteStream(dest);
    let received = 0;
    const total = parseInt(res.headers['content-length'] ?? '0', 10);
    res.on('data', chunk => {
      received += chunk.length;
      if (!fd.write(chunk)) { res.pause(); fd.once('drain', () => res.resume()); }
      if (total) process.stdout.write(`\r   ${Math.round(received/total*100)}%  ${(received/1e6).toFixed(1)} MB`);
    });
    res.on('end', () => { fd.end(); });
    fd.on('finish', () => { if (total) process.stdout.write('\n'); resolve({ status: 200 }); });
    fd.on('error', reject);
    res.on('error', reject);
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
  const releases = JSON.parse(body);
  for (const rel of releases) {
    if (rel.assets?.length >= 6) return rel.tag_name;
  }
  return releases[0]?.tag_name;
}

async function getLlamaReleases(n = 20) {
  const res  = await httpsGet(`https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=${n}`);
  const body = await new Promise((r,j) => { let b=''; res.on('data',d=>b+=d); res.on('end',()=>r(b)); res.on('error',j); });
  return JSON.parse(body).map(r => r.tag_name);
}

function readManifest() {
  if (!fs.existsSync(MANIFEST)) return {};
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return {}; }
}

function writeManifest(data) {
  data._updated = new Date().toISOString();
  fs.writeFileSync(MANIFEST, JSON.stringify(data, null, 2) + '\n');
}

// ── Per-platform file lists ───────────────────────────────────────────────────
// These are the CRITICAL files we track. ggml-cpu-*.dll etc are supplementary
// (always present alongside llama-server) but not individually tracked.

const PLATFORM_CRITICAL = {
  'win32-x64': [
    // llama-server + core DLLs
    'llama-server-win32-x64.exe',
    'ggml-vulkan.dll',
    'ggml-cuda.dll',
    'cudart64_12.dll',
    'cublas64_12.dll',
    'cublasLt64_12.dll',
    'ggml.dll',
    'ggml-base.dll',
    'ggml-rpc.dll',
    'llama.dll',
    // sd.cpp — Windows uses subdirectories (DLL isolation)
    path.join('sd-vulkan', 'sd-server-win32-x64.exe'),
    path.join('sd-cuda',   'sd-server-win32-x64-cuda.exe'),
    path.join('sd-cpu',    'sd-server-win32-x64-cpu.exe'),
    path.join('sd-rocm',   'sd-server-win32-x64-rocm.exe'),
  ],
  'darwin-arm64': [
    'llama-server-darwin-arm64',
    'sd-server-darwin-arm64',       // flat in bin/ — no subdirectory on macOS
  ],
  'darwin-x64': [
    'llama-server-darwin-x64',
    // No sd.cpp release for macOS Intel (arm64 only) — llama-server is sufficient
  ],
  'linux-x64': [
    'llama-server-linux-x64',
    'sd-server-linux-x64',              // flat in bin/ — fetch-sd-cpp puts it here
    path.join('sd-rocm', 'sd-server-linux-x64-rocm'),  // ROCm uses subdirectory
  ],
  'linux-arm64': [
    // llama-server-linux-arm64 — CI-build only, built from source in GitHub Actions
    // No pre-built release asset available from llama.cpp
  ],
};

// ── Fetch helpers per platform ────────────────────────────────────────────────

async function syncPlatform(platform, manifest, updateMode) {
  const masterPlatDir = path.join(MASTER_DIR, platform);
  fs.mkdirSync(masterPlatDir, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const entry = manifest[platform] ?? {};
  const results = { platform, added: [], updated: [], missing: [], unchanged: [], checksumFail: [] };

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${platform}`);
  console.log(`${'─'.repeat(60)}`);

  // Fetch from upstream when: explicit --update, OR missing files detected
  const needsFetch = updateMode || (() => {
    const critical = PLATFORM_CRITICAL[platform] ?? [];
    return critical.some(f => {
      if (platform === 'linux-arm64' && f === 'llama-server-linux-arm64') return false;
      return !fs.existsSync(path.join(masterPlatDir, f));
    });
  })();

  if (needsFetch) {
    if (updateMode) {
      console.log(`  📥 Fetching latest binaries for ${platform}...`);
    } else {
      const missing = (PLATFORM_CRITICAL[platform] ?? [])
        .filter(f => !(platform === 'linux-arm64' && f === 'llama-server-linux-arm64'))
        .filter(f => !fs.existsSync(path.join(masterPlatDir, f)));
      console.log(`  📥 Fetching missing files for ${platform}: ${missing.join(', ')}`);
    }
    // Fetch scripts map per platform
    const FETCH_LLAMA = {
      'win32-x64':   'scripts/fetch-win32-x64.js',
      'darwin-arm64':'scripts/fetch-darwin-arm64.js',
      'darwin-x64':  'scripts/fetch-darwin-x64.js',
      'linux-x64':   'scripts/fetch-linux-x64.js',
      'linux-arm64': 'scripts/fetch-linux-arm64.js',
    };
    const HAS_SD = { 'win32-x64':true, 'darwin-arm64':true, 'darwin-x64':false, 'linux-x64':true, 'linux-arm64':false };
    const fetchEnv = { ...process.env, PHOBOS_TARGET_PLATFORM: platform };

    // Resolve upstream release tags BEFORE fetching so we can record them.
    // On --update we always want latest. On initial sync we also want latest
    // (there's no pinned version yet if we're here — bin-master was empty).
    let llamaTag = null;
    let sdTag    = null;
    try {
      llamaTag = await getLatestLlama();
      console.log(`  📌 llama.cpp: ${llamaTag}`);
    } catch (err) {
      console.warn(`  ⚠️  Could not resolve llama.cpp tag: ${err.message}`);
    }
    try {
      if (HAS_SD[platform]) {
        sdTag = await getLatestSd();
        console.log(`  📌 sd.cpp: ${sdTag}`);
      }
    } catch (err) {
      console.warn(`  ⚠️  Could not resolve sd.cpp tag: ${err.message}`);
    }

    try {
      // Step A: wipe bin/ to prevent cross-platform contamination between fetches
      const binDir = path.join(ROOT, 'bin');
      if (fs.existsSync(binDir)) {
        fs.rmSync(binDir, { recursive: true, force: true });
        console.log(`  🗑️  bin/ wiped before fetch`);
      }

      // Step B: fetch llama.cpp binaries into bin/ — pinned to the resolved tag
      const llamaScript = FETCH_LLAMA[platform];
      if (llamaScript) {
        const versionArg = llamaTag ? ` --version ${llamaTag}` : '';
        execSync(`node ${llamaScript}${versionArg}`, { stdio: 'inherit', cwd: ROOT, env: fetchEnv });
      }
      // Step C: fetch sd.cpp binaries into bin/ with platform override — pinned to resolved tag
      if (HAS_SD[platform]) {
        const versionArg = sdTag ? ` --version ${sdTag}` : '';
        execSync(`node scripts/fetch-sd-cpp.js${versionArg}`, { stdio: 'inherit', cwd: ROOT, env: fetchEnv });
      }
      // Step D: copy bin/ → bin-master/{platform}/
      if (fs.existsSync(binDir)) {
        const copyDir = (s, d) => {
          fs.mkdirSync(d, { recursive: true });
          for (const e of fs.readdirSync(s, { withFileTypes: true })) {
            if (e.name === '.tmp') continue;
            const [ss,dd] = [path.join(s,e.name), path.join(d,e.name)];
            e.isDirectory() ? copyDir(ss,dd) : fs.copyFileSync(ss,dd);
          }
        };
        copyDir(binDir, masterPlatDir);
        console.log(`  ✅ Copied bin/ → bin-master/${platform}/`);
      }

      // Record the release tags we actually fetched
      if (llamaTag) entry.llama = llamaTag;
      if (sdTag)    entry.sd    = sdTag;
    } catch (err) {
      console.warn(`  ⚠️  Fetch failed for ${platform} — keeping existing files`);
      console.warn(`     ${err.message?.split('\n')[0] ?? err}`);
    }
  }

  // Validate and checksum all critical files
  const critical = PLATFORM_CRITICAL[platform] ?? [];
  const newFiles = {};

  for (const relFile of critical) {
    const fullPath = path.join(masterPlatDir, relFile);
    const key      = relFile.replace(/\\/g, '/'); // normalize to forward slashes in manifest

    if (!fs.existsSync(fullPath)) {
      results.missing.push(key);
      continue;
    }

    const size   = fs.statSync(fullPath).size;
    const sha256 = await sha256File(fullPath);
    const prev   = entry.files?.[key];

    newFiles[key] = { sha256, size, source: prev?.source ?? 'unknown' };

    if (!prev) {
      results.added.push(key);
    } else if (prev.sha256 !== sha256) {
      results.updated.push(key);
      newFiles[key].source = prev.source; // keep source until explicitly updated
    } else {
      results.unchanged.push(key);
    }
  }

  // Update manifest entry
  manifest[platform] = {
    ...entry,
    files: newFiles,
  };

  return results;
}

// ── Check mode — validate only, no downloads ─────────────────────────────────

async function checkPlatform(platform, manifest) {
  const masterPlatDir = path.join(MASTER_DIR, platform);
  const entry         = manifest[platform] ?? {};
  const critical      = PLATFORM_CRITICAL[platform] ?? [];
  const results       = { platform, ok: [], missing: [], checksumFail: [], notInManifest: [] };

  for (const relFile of critical) {
    const fullPath = path.join(masterPlatDir, relFile);
    const key      = relFile.replace(/\\/g, '/');
    const expected = entry.files?.[key];

    if (!fs.existsSync(fullPath)) {
      results.missing.push(key);
      continue;
    }

    if (!expected) {
      results.notInManifest.push(key);
      continue;
    }

    const sha256 = await sha256File(fullPath);
    if (sha256 !== expected.sha256) {
      results.checksumFail.push({ file: key, expected: expected.sha256.slice(0,12), got: sha256.slice(0,12) });
    } else {
      results.ok.push(key);
    }
  }

  return results;
}

// ── Upstream version check ────────────────────────────────────────────────────

async function checkUpstreamVersions(manifest) {
  console.log('\n📡 Checking upstream for newer releases...');
  const rows = [];

  try {
    const [latestLlama, latestSd] = await Promise.all([getLatestLlama(), getLatestSd()]);

    for (const plat of PLATFORMS) {
      const entry    = manifest[plat] ?? {};
      const pinnedL  = entry.llama ?? '—';
      const pinnedS  = entry.sd    ?? '—';
      const llamaNew = pinnedL !== latestLlama && pinnedL !== '—' ? `→ ${latestLlama}` : '';
      const sdNew    = pinnedS !== latestSd    && pinnedS !== '—' ? `→ ${latestSd}`    : '';

      rows.push({ plat, pinnedL, llamaNew, pinnedS, sdNew });
    }

    return { latestLlama, latestSd, rows };
  } catch (err) {
    console.warn(`  ⚠️  Could not check upstream: ${err.message}`);
    return null;
  }
}

// ── Summary report ────────────────────────────────────────────────────────────

function printSummary(allResults, upstreamInfo, manifest) {
  console.log('\n');
  console.log('╔' + '═'.repeat(70) + '╗');
  console.log('║  PHOBOS bin-master/ STATUS REPORT' + ' '.repeat(35) + '║');
  console.log('╠' + '═'.repeat(70) + '╣');

  for (const r of allResults) {
    const total   = (r.ok?.length ?? 0) + r.unchanged?.length ?? 0;
    const hasIssues = (r.missing?.length > 0) || (r.checksumFail?.length > 0);
    const icon    = hasIssues ? '⚠️ ' : '✅';

    console.log(`║  ${icon} ${r.platform.padEnd(16)}` +
      `  ok:${(r.ok?.length ?? r.unchanged?.length ?? 0).toString().padStart(3)}` +
      `  added:${(r.added?.length ?? 0).toString().padStart(2)}` +
      `  changed:${(r.updated?.length ?? 0).toString().padStart(2)}` +
      `  missing:${(r.missing?.length ?? 0).toString().padStart(2)}` +
      '  ║');

    if (r.missing?.length) {
      for (const f of r.missing) console.log(`║    ❌ MISSING: ${f.padEnd(52)}║`);
    }
    if (r.checksumFail?.length) {
      for (const f of r.checksumFail) console.log(`║    ⚠️  CHECKSUM MISMATCH: ${f.file.slice(0,44).padEnd(44)}║`);
    }
  }

  if (upstreamInfo) {
    console.log('╠' + '═'.repeat(70) + '╣');
    console.log('║  UPSTREAM VERSION STATUS' + ' '.repeat(45) + '║');
    console.log('╠' + '═'.repeat(70) + '╣');
    for (const { plat, pinnedL, llamaNew, pinnedS, sdNew } of upstreamInfo.rows) {
      const llamaCol = llamaNew ? `${pinnedL} ${llamaNew}` : pinnedL;
      const sdCol    = sdNew    ? `${pinnedS} ${sdNew}`    : pinnedS;
      const hasUpdate = llamaNew || sdNew;
      const icon = hasUpdate ? '🔄' : '  ';
      console.log(`║  ${icon} ${plat.padEnd(14)}  llama: ${llamaCol.padEnd(22)}  sd: ${sdCol.padEnd(16)}║`);
    }
    if (upstreamInfo.rows.some(r => r.llamaNew || r.sdNew)) {
      console.log('╠' + '═'.repeat(70) + '╣');
      console.log('║  ℹ️  Updates available. Run: npm run master:update              ║');
    }
  }

  console.log('╠' + '═'.repeat(70) + '╣');
  const manifestPath = path.relative(ROOT, MANIFEST);
  console.log(`║  Manifest: ${manifestPath.padEnd(58)}║`);
  console.log(`║  Updated:  ${(manifest._updated ?? 'never').padEnd(58)}║`);
  console.log('╚' + '═'.repeat(70) + '╝');
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n🗂️  PHOBOS master-sync' + (MODE_UPDATE ? ' (--update mode)' : MODE_CHECK ? ' (--check mode)' : ''));
console.log(`   Targets: ${targets.join(', ')}`);

if (!process.env.GITHUB_TOKEN) {
  console.warn('   ⚠️  GITHUB_TOKEN not set — upstream version check may fail\n');
}

const manifest   = readManifest();
const allResults = [];

const effectiveUpdate = MODE_UPDATE;

if (MODE_CHECK) {
  // ── Check mode: validate checksums only ────────────────────────────────────
  for (const plat of targets) {
    const r = await checkPlatform(plat, manifest);
    allResults.push(r);

    const icon = (r.missing.length + r.checksumFail.length) === 0 ? '✅' : '⚠️ ';
    console.log(`\n${icon} ${plat}`);
    if (r.ok.length)           console.log(`   ${r.ok.length} files verified`);
    if (r.missing.length)      r.missing.forEach(f => console.log(`   ❌ MISSING: ${f}`));
    if (r.checksumFail.length) r.checksumFail.forEach(f => console.log(`   ⚠️  MISMATCH: ${f.file} (expected ${f.expected}… got ${f.got}…)`));
    if (r.notInManifest.length) r.notInManifest.forEach(f => console.log(`   ℹ️  Not in manifest: ${f}`));
  }
} else {
  // ── Sync/update mode ───────────────────────────────────────────────────────
  for (const plat of targets) {
    const r = await syncPlatform(plat, manifest, effectiveUpdate);
    allResults.push(r);
  }

  // Always write manifest after sync/update — records checksums and timestamps
  writeManifest(manifest);
  console.log(`\n✅ Manifest written → ${path.relative(ROOT, MANIFEST)}`);
  console.log('   Commit this file to pin these versions for all machines.');
}

// ── Upstream check (always runs, informational only) ─────────────────────────
const upstreamInfo = await checkUpstreamVersions(manifest).catch(() => null);

// ── Final report ──────────────────────────────────────────────────────────────
printSummary(allResults, upstreamInfo, manifest);
