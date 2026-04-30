#!/usr/bin/env node
// fetch-phobos-release-deps.js
//
// Downloads every file that needs to be hosted on your PHOBOS-BUILDS GitHub
// release into ./test-outputs/fetch/{filename}.
//
// Run from anywhere:
//   node fetch-phobos-release-deps.js
//   node fetch-phobos-release-deps.js --github-token=ghp_xxx
//   GITHUB_TOKEN=ghp_xxx node fetch-phobos-release-deps.js
//
// Files that need manual build (Polaris Linux/macOS) are printed at the end
// with exact build instructions.
//
// Resume-safe: already-present files that pass a size check are skipped.
// Parallel where safe (independent files), sequential within groups that
// share a rate-limit domain.

import fs    from 'node:fs';
import https from 'node:https';
import http  from 'node:http';
import path  from 'node:path';
import zlib  from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR   = path.resolve(__dirname, 'test-outputs', 'fetch');

// ── CLI / env ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const TOKEN =
  args.find(a => a.startsWith('--github-token='))?.split('=').slice(1).join('=') ??
  process.env.GITHUB_TOKEN ??
  '';

if (!TOKEN) {
  console.warn('⚠  GITHUB_TOKEN not set — GitHub API calls are rate-limited to 60/hr.');
  console.warn('   Pass --github-token=ghp_xxx or set GITHUB_TOKEN env var.\n');
}

// ── Versions ──────────────────────────────────────────────────────────────────
// Keep in sync with your fetch-*.js scripts.

const V = {
  LLAMA_CPP:       'b8940',           // bin-manifest.json: llama field (all platforms)
  SD_CPP:          'master-586-c97702e', // bin-manifest.json: sd field
  DUCKDB:          '1.4.4',           // package.json: duckdb dependency
  JELLYFIN:        '10.11.8',
  JELLYFIN_FFMPEG: '7.1.3-5',
  JELLYFIN_DISTRO: 'bookworm',
  KAVITA:          '0.8.9.1',
  HELM:            '0.9.0',
  STIRLING:        '2.9.2',
  POLARIS:         '0.16.0',
  NODE:            '22.14.0',         // v22 LTS — update when Node drops a new v22 LTS
};

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const GH_HEADERS = {
  'User-Agent': 'phobos-dep-fetcher/1.0',
  'Accept':     'application/vnd.github+json',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

function get(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 12) { reject(new Error(`Too many redirects: ${target}`)); return; }
      let parsed;
      try { parsed = new URL(target); } catch { reject(new Error(`Bad URL: ${target}`)); return; }
      const isGh  = parsed.hostname === 'github.com' || parsed.hostname === 'api.github.com';
      const hdrs  = { ...(isGh ? GH_HEADERS : {}), ...extraHeaders };
      const proto = parsed.protocol === 'https:' ? https : http;
      proto.get(
        { hostname: parsed.hostname,
          port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path:     parsed.pathname + parsed.search,
          headers:  hdrs },
        res => {
          if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            follow(res.headers.location, hops + 1);
          } else {
            resolve(res);
          }
        }
      ).on('error', reject);
    };
    follow(url);
  });
}

// ── Download with progress bar ────────────────────────────────────────────────

async function download(label, url, destPath, minBytes = 0) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  // Fast-path: already present and large enough.
  if (fs.existsSync(destPath)) {
    const sz = fs.statSync(destPath).size;
    if (sz >= minBytes) {
      console.log(`  ✓  ${label} — already present (${fmt(sz)})`);
      return { skipped: true, size: sz };
    }
    console.log(`  ↻  ${label} — file present but too small (${fmt(sz)} < ${fmt(minBytes)}), re-downloading`);
    fs.unlinkSync(destPath);
  }

  const tmpPath = destPath + '.tmp';
  // Resume from partial download if the .tmp file exists.
  const existing = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
  const hdrs     = existing > 0 ? { Range: `bytes=${existing}-` } : {};

  process.stdout.write(`  ↓  ${label}`);
  if (existing > 0) process.stdout.write(` (resuming from ${fmt(existing)})`);
  process.stdout.write('\n');

  let res;
  try {
    res = await get(url, hdrs);
  } catch (err) {
    console.error(`     ✗ connection error: ${err.message}`);
    return { error: err.message };
  }

  if (res.statusCode === 404) {
    res.resume();
    console.error(`     ✗ 404 — asset not found: ${url}`);
    return { error: '404' };
  }
  if (res.statusCode !== 200 && res.statusCode !== 206) {
    res.resume();
    console.error(`     ✗ HTTP ${res.statusCode}`);
    return { error: `HTTP ${res.statusCode}` };
  }

  const fromHeader = parseInt(res.headers['content-length'] ?? '0', 10);
  const total      = res.statusCode === 206 ? existing + fromHeader : fromHeader;

  await new Promise((resolve, reject) => {
    const fd = fs.createWriteStream(tmpPath, { flags: existing > 0 ? 'a' : 'w' });
    let received = existing;
    let lastPct  = -1;

    res.on('data', chunk => {
      received += chunk.length;
      if (!fd.write(chunk)) { res.pause(); fd.once('drain', () => res.resume()); }
      if (total > 0) {
        const pct = Math.floor(received / total * 100);
        if (pct !== lastPct && pct % 5 === 0) {
          process.stdout.write(`\r     ${String(pct).padStart(3)}%  ${fmt(received)} / ${fmt(total)}  `);
          lastPct = pct;
        }
      }
    });
    res.on('end',    () => fd.end());
    fd.on('finish', () => {
      if (total > 0) process.stdout.write(`\r     100%  ${fmt(received)} / ${fmt(total)}\n`);
      else            process.stdout.write(`\r     ${fmt(received)} received\n`);
      resolve();
    });
    fd.on('error', reject);
    res.on('error', reject);
  });

  fs.renameSync(tmpPath, destPath);
  const finalSz = fs.statSync(destPath).size;
  const sha     = await sha256(destPath);
  console.log(`     ✓ ${fmt(finalSz)}  sha256: ${sha.slice(0, 16)}…`);
  return { size: finalSz, sha256: sha };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(1)} KB`;
}

async function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', d => h.update(d));
    s.on('end',  () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

function out(filename) { return path.join(OUT_DIR, filename); }

// ── GitHub API: resolve latest llama.cpp release ──────────────────────────────

async function resolveGithubTag(repo, tagHint) {
  // If tagHint looks like a concrete tag/commit (not 'latest'), use it directly.
  if (tagHint && tagHint !== 'latest') return tagHint;
  try {
    const res  = await get(`https://api.github.com/repos/${repo}/releases/latest`);
    const body = await new Promise((res2, rej) => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => res2(b));
      res.on('error', rej);
    });
    const data = JSON.parse(body);
    return data.tag_name ?? tagHint;
  } catch {
    return tagHint;
  }
}

// ── GitHub API: find sd.cpp release assets ────────────────────────────────────

async function getSdCppAssets(tag) {
  try {
    const res  = await get(`https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/tags/${tag}`);
    const body = await new Promise((r, rej) => {
      let b = '';
      res.on('data', d => b += d);
      res.on('end', () => r(b));
      res.on('error', rej);
    });
    const data = JSON.parse(body);
    return (data.assets ?? []).map(a => a.name);
  } catch {
    return [];
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

fs.mkdirSync(OUT_DIR, { recursive: true });

const results  = [];   // { label, file, status, size, sha256 }
const manual   = [];   // files that need manual build

function record(label, file, result) {
  results.push({ label, file, ...result });
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  PHOBOS Release Dependency Fetch');
console.log(`  Output: ${OUT_DIR}`);
console.log('══════════════════════════════════════════════════════════════\n');

// ─────────────────────────────────────────────────────────────────────────────
// 1. SYBIL EMBEDDING MODEL  (single file, platform-independent)
// ─────────────────────────────────────────────────────────────────────────────

console.log('── SYBIL Embedding Model ──────────────────────────────────────');

{
  const file = 'nomic-embed-text-v1.5.Q4_K_M.gguf';
  const url  = 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q4_K_M.gguf';
  record(file, file, await download(file, url, out(file), 60_000_000));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. DUCKDB VSS EXTENSION  (per platform)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── DuckDB VSS Extension ───────────────────────────────────────');
console.log(`   duckdb version: ${V.DUCKDB}`);

// Platform strings expected by the DuckDB extension CDN
const VSS_PLATFORMS = [
  { platform: 'windows_amd64', outName: `vss-windows_amd64-v${V.DUCKDB}.duckdb_extension` },
  { platform: 'osx_arm64',     outName: `vss-osx_arm64-v${V.DUCKDB}.duckdb_extension` },
  { platform: 'osx_amd64',     outName: `vss-osx_amd64-v${V.DUCKDB}.duckdb_extension` },
  { platform: 'linux_amd64',   outName: `vss-linux_amd64-v${V.DUCKDB}.duckdb_extension` },
  { platform: 'linux_arm64',   outName: `vss-linux_arm64-v${V.DUCKDB}.duckdb_extension` },
];

// Community extensions CDN, with gz fallback and core CDN fallback.
// Try each candidate in order for each platform.
for (const { platform, outName } of VSS_PLATFORMS) {
  const COMMUNITY = `https://community-extensions.duckdb.org/v${V.DUCKDB}/${platform}`;
  const CORE      = `https://extensions.duckdb.org/v${V.DUCKDB}/${platform}`;
  const candidates = [
    { url: `${COMMUNITY}/vss.duckdb_extension`,    gz: false },
    { url: `${COMMUNITY}/vss.duckdb_extension.gz`, gz: true  },
    { url: `${CORE}/vss.duckdb_extension`,          gz: false },
    { url: `${CORE}/vss.duckdb_extension.gz`,       gz: true  },
  ];

  const destPath = out(outName);
  if (fs.existsSync(destPath) && fs.statSync(destPath).size >= 500_000) {
    console.log(`  ✓  ${outName} — already present`);
    record(outName, outName, { skipped: true });
    continue;
  }

  let succeeded = false;
  for (const { url, gz } of candidates) {
    process.stdout.write(`  ↓  ${outName} — trying ${gz ? '(gz) ' : ''}${url.split('/').slice(-2).join('/')}\n`);
    let res;
    try { res = await get(url); } catch (err) { console.log(`     ✗ ${err.message}`); continue; }
    if (res.statusCode === 404) { res.resume(); console.log(`     ✗ 404`); continue; }
    if (res.statusCode !== 200) { res.resume(); console.log(`     ✗ HTTP ${res.statusCode}`); continue; }

    const tmpPath = destPath + '.tmp';
    const total   = parseInt(res.headers['content-length'] ?? '0', 10);
    try {
      await new Promise((resolve, reject) => {
        const fd  = fs.createWriteStream(tmpPath, { flags: 'w' });
        const src = gz ? res.pipe(zlib.createGunzip()) : res;
        let received = 0;
        src.on('data', chunk => {
          received += chunk.length;
          if (!fd.write(chunk)) { src.pause?.(); fd.once('drain', () => src.resume?.()); }
          if (total > 0 && !gz) process.stdout.write(`\r     ${Math.floor(received/total*100)}%  ${fmt(received)} / ${fmt(total)}  `);
          else                   process.stdout.write(`\r     ${fmt(received)} received  `);
        });
        src.on('end',    () => fd.end());
        src.on('error',  reject);
        fd.on('finish', () => { process.stdout.write('\n'); resolve(); });
        fd.on('error',  reject);
      });
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      console.log(`     ✗ download error: ${err.message}`);
      continue;
    }

    const finalSz = fs.statSync(tmpPath).size;
    if (finalSz < 500_000) {
      fs.unlinkSync(tmpPath);
      console.log(`     ✗ file too small (${fmt(finalSz)}) — wrong format`);
      continue;
    }
    fs.renameSync(tmpPath, destPath);
    succeeded = true;
    record(outName, outName, { size: finalSz });
    console.log(`     ✓ ${fmt(finalSz)}`);
    break;
  }

  if (!succeeded) {
    console.error(`     ✗ ALL candidates failed for ${outName}`);
    record(outName, outName, { error: 'all candidates failed' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. LLAMA.CPP BINARIES  (pinned to bin-manifest versions)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── llama.cpp Binaries ─────────────────────────────────────────');
console.log(`   version: ${V.LLAMA_CPP}`);

// The bin-manifest already pins the exact versions we want.
// We download the original release archives directly — the .exe/.so/.dylib
// files will be extracted by the new boot-time setup runner, NOT here.
// Here we grab the raw archives for you to upload to PHOBOS-BUILDS.

const LLAMA_GH = `https://github.com/ggml-org/llama.cpp/releases/download/${V.LLAMA_CPP}`;

// Windows: vulkan build (includes all companion DLLs)
const LLAMA_WIN_ARCHIVES = [
  { name: `llama-${V.LLAMA_CPP}-bin-win-vulkan-x64.zip`,      minBytes: 50_000_000 },
  { name: `llama-${V.LLAMA_CPP}-bin-win-cuda-12.4-x64.zip`,   minBytes: 100_000_000 },  // ggml-cuda.dll
  { name: `cudart-llama-bin-win-cuda-12.4-x64.zip`,            minBytes: 1_000_000 },    // cuda runtime DLLs
];

for (const { name, minBytes } of LLAMA_WIN_ARCHIVES) {
  record(name, name, await download(name, `${LLAMA_GH}/${name}`, out(name), minBytes));
}

// macOS arm64
const LLAMA_MAC_ARM = `llama-${V.LLAMA_CPP}-bin-macos-arm64.tar.gz`;
record(LLAMA_MAC_ARM, LLAMA_MAC_ARM, await download(LLAMA_MAC_ARM, `${LLAMA_GH}/${LLAMA_MAC_ARM}`, out(LLAMA_MAC_ARM), 5_000_000));

// macOS x64
const LLAMA_MAC_X64 = `llama-${V.LLAMA_CPP}-bin-macos-x64.tar.gz`;
record(LLAMA_MAC_X64, LLAMA_MAC_X64, await download(LLAMA_MAC_X64, `${LLAMA_GH}/${LLAMA_MAC_X64}`, out(LLAMA_MAC_X64), 5_000_000));

// Linux x64: try vulkan first, fall back to plain ubuntu
{
  const name    = `llama-${V.LLAMA_CPP}-bin-ubuntu-x64.tar.gz`;
  const vulkan  = `llama-${V.LLAMA_CPP}-bin-ubuntu-vulkan-x64.tar.gz`;
  let r = await download(`${vulkan} (linux-x64 vulkan)`, `${LLAMA_GH}/${vulkan}`, out(vulkan), 5_000_000);
  if (!r.error) {
    record(vulkan, vulkan, r);
  } else {
    console.log('     → falling back to plain ubuntu-x64 build');
    record(name, name, await download(`${name} (linux-x64 plain)`, `${LLAMA_GH}/${name}`, out(name), 5_000_000));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. STABLE-DIFFUSION.CPP BINARIES
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── stable-diffusion.cpp Binaries ──────────────────────────────');
console.log(`   version: ${V.SD_CPP}`);

// Discover exact asset names from the GitHub API first.
const sdAssets = await getSdCppAssets(V.SD_CPP);
console.log(`   discovered ${sdAssets.length} assets from GitHub API`);

const SD_GH   = `https://github.com/leejet/stable-diffusion.cpp/releases/download/${V.SD_CPP}`;
const sdHash  = V.SD_CPP.split('-').pop(); // e.g. 'c97702e'

function findSdAsset(constructed, ...patterns) {
  if (sdAssets.length === 0)                  return constructed;
  if (sdAssets.includes(constructed))         return constructed;
  for (const pat of patterns) {
    const hit = sdAssets.find(a => pat.test(a));
    if (hit) return hit;
  }
  return constructed;  // fall through; may 404
}

// Windows variants
const sdWinVulkan = findSdAsset(`sd-master-${sdHash}-bin-win-vulkan-x64.zip`, /win.*vulkan.*x64\.zip$/i);
const sdWinCuda   = findSdAsset(`sd-master-${sdHash}-bin-win-cuda12-x64.zip`, /win.*cuda12.*x64\.zip$/i);
const sdWinCpu    = findSdAsset(`sd-master-${sdHash}-bin-win-avx2-x64.zip`,   /win.*avx2.*x64\.zip$/i);
const sdWinRocm   = findSdAsset(`sd-master-${sdHash}-bin-win-rocm-x64.zip`,   /win.*rocm.*x64\.zip$/i);
const sdCudaRt    = 'cudart-sd-bin-win-cu12-x64.zip';   // Fixed name in sd.cpp CI

for (const [label, name] of [
  ['sd-cpp win32 vulkan', sdWinVulkan],
  ['sd-cpp win32 cuda',   sdWinCuda],
  ['sd-cpp win32 cpu',    sdWinCpu],
  ['sd-cpp win32 rocm',   sdWinRocm],
  ['sd-cpp cudart dlls',  sdCudaRt],
]) {
  record(name, name, await download(label, `${SD_GH}/${name}`, out(name), 500_000));
}

// Linux x64 — vulkan preferred, plain fallback
{
  const vulkanGuess = `sd-master-${sdHash}-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip`;
  const plainGuess  = `sd-master-${sdHash}-bin-Linux-Ubuntu-24.04-x86_64.zip`;
  const rocmGuess   = `sd-master-${sdHash}-bin-Linux-Ubuntu-24.04-x86_64-rocm.zip`;
  const vulkanFn    = findSdAsset(vulkanGuess, /Linux.*x86_64.*vulkan\.zip$/i);
  const plainFn     = findSdAsset(plainGuess,  /Linux.*x86_64\.zip$/i, a => !a.includes('vulkan') && !a.includes('rocm'));
  const rocmFn      = findSdAsset(rocmGuess,   /Linux.*x86_64.*rocm\.zip$/i);

  let r = await download(`sd-cpp linux-x64 vulkan`, `${SD_GH}/${vulkanFn}`, out(vulkanFn), 500_000);
  if (r.error) {
    console.log('     → falling back to plain linux-x64 build');
    r = await download(`sd-cpp linux-x64 plain`, `${SD_GH}/${plainFn}`, out(plainFn), 500_000);
    record(plainFn, plainFn, r);
  } else {
    record(vulkanFn, vulkanFn, r);
  }
  // ROCm is independent
  record(rocmFn, rocmFn, await download(`sd-cpp linux-x64 rocm`, `${SD_GH}/${rocmFn}`, out(rocmFn), 500_000));
}

// macOS arm64
{
  // Asset name includes macOS version in the filename — discover from API or try common versions.
  let macFn = sdAssets.find(a => a.includes('Darwin') && a.includes('arm64'));
  if (!macFn) {
    // Try the most common macOS versions; first 200 match wins at download time
    const macVers = ['15.7.4', '15.7.3', '15.7.2', '15.7', '15.4', '14.7'];
    macFn = `sd-master-${sdHash}-bin-Darwin-macOS-${macVers[0]}-arm64.zip`;
    console.log(`  ⚠  macOS arm64 asset not in API results — guessing: ${macFn}`);
    console.log(`     If this 404s, check https://github.com/leejet/stable-diffusion.cpp/releases/${V.SD_CPP}`);
  }
  record(macFn, macFn, await download(`sd-cpp darwin-arm64`, `${SD_GH}/${macFn}`, out(macFn), 500_000));
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. JELLYFIN SERVER + FFMPEG
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Jellyfin ───────────────────────────────────────────────────');
console.log(`   jellyfin: ${V.JELLYFIN}   ffmpeg: ${V.JELLYFIN_FFMPEG}`);

const JF_REPO_LIN_X64   = `https://repo.jellyfin.org/files/server/linux/latest-stable/amd64`;
const JF_REPO_LIN_ARM64 = `https://repo.jellyfin.org/files/server/linux/latest-stable/arm64`;
const JF_REPO_MAC_X64   = `https://repo.jellyfin.org/files/server/macos/latest-stable/amd64`;
const JF_REPO_MAC_ARM64 = `https://repo.jellyfin.org/files/server/macos/latest-stable/arm64`;
const JF_WIN             = `https://repo.jellyfin.org/files/server/windows/latest-stable/amd64`;
const FFMP_REPO_X64     = `https://repo.jellyfin.org/files/ffmpeg/linux/latest-7.x/amd64`;
const FFMP_REPO_ARM64   = `https://repo.jellyfin.org/files/ffmpeg/linux/latest-7.x/arm64`;
const FFMP_V             = V.JELLYFIN_FFMPEG;

const jellyfinFiles = [
  // Linux — repo.jellyfin.org, filename without underscore-version suffix
  { label: 'jellyfin linux-x64',    name: `jellyfin_${V.JELLYFIN}-linux-x64.tar.gz`,   url: `${JF_REPO_LIN_X64}/jellyfin_${V.JELLYFIN}-amd64.tar.gz`,   min: 80_000_000 },
  { label: 'jellyfin linux-arm64',  name: `jellyfin_${V.JELLYFIN}-linux-arm64.tar.gz`, url: `${JF_REPO_LIN_ARM64}/jellyfin_${V.JELLYFIN}-arm64.tar.gz`, min: 75_000_000 },
  // Windows — repo.jellyfin.org
  { label: 'jellyfin win32-x64',    name: `jellyfin_${V.JELLYFIN}-amd64.zip`,          url: `${JF_WIN}/jellyfin_${V.JELLYFIN}-amd64.zip`,               min: 60_000_000 },
  // macOS — repo.jellyfin.org, .tar.xz
  { label: 'jellyfin darwin-arm64', name: `jellyfin_${V.JELLYFIN}-macos-arm64.tar.xz`, url: `${JF_REPO_MAC_ARM64}/jellyfin_${V.JELLYFIN}-arm64.tar.xz`, min: 60_000_000 },
  { label: 'jellyfin darwin-x64',   name: `jellyfin_${V.JELLYFIN}-macos-x64.tar.xz`,  url: `${JF_REPO_MAC_X64}/jellyfin_${V.JELLYFIN}-amd64.tar.xz`,  min: 55_000_000 },
  // jellyfin-ffmpeg — Linux only, repo.jellyfin.org portable builds
  { label: 'jellyfin-ffmpeg linux-x64',   name: `jellyfin-ffmpeg_${FFMP_V}-linux-x64.tar.xz`,   url: `${FFMP_REPO_X64}/jellyfin-ffmpeg_${FFMP_V}_portable_linux64-gpl.tar.xz`,   min: 35_000_000 },
  { label: 'jellyfin-ffmpeg linux-arm64', name: `jellyfin-ffmpeg_${FFMP_V}-linux-arm64.tar.xz`,  url: `${FFMP_REPO_ARM64}/jellyfin-ffmpeg_${FFMP_V}_portable_linuxarm64-gpl.tar.xz`, min: 30_000_000 },
];

for (const f of jellyfinFiles) {
  record(f.label, f.name, await download(f.label, f.url, out(f.name), f.min));
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. KAVITA
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Kavita ─────────────────────────────────────────────────────');
console.log(`   version: ${V.KAVITA}`);

const KV_GH = `https://github.com/Kareadita/Kavita/releases/download/v${V.KAVITA}`;

const kavitaFiles = [
  { label: 'kavita linux-x64',    name: `kavita-linux-x64.tar.gz`,   url: `${KV_GH}/kavita-linux-x64.tar.gz`,   min: 75_000_000 },
  { label: 'kavita linux-arm64',  name: `kavita-linux-arm64.tar.gz`, url: `${KV_GH}/kavita-linux-arm64.tar.gz`, min: 70_000_000 },
  { label: 'kavita win32-x64',    name: `kavita-win-x64.tar.gz`,     url: `${KV_GH}/kavita-win-x64.tar.gz`,     min: 8_000_000  },
  { label: 'kavita darwin-x64',   name: `kavita-osx-x64.tar.gz`,     url: `${KV_GH}/kavita-osx-x64.tar.gz`,    min: 75_000_000 },
  { label: 'kavita darwin-arm64', name: `kavita-osx-arm64.tar.gz`,   url: `${KV_GH}/kavita-osx-arm64.tar.gz`,  min: 70_000_000 },
];

for (const f of kavitaFiles) {
  record(f.label, f.name, await download(f.label, f.url, out(f.name), f.min));
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. HELM VST3  (DAW synth plugin)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Helm ───────────────────────────────────────────────────────');
console.log(`   version: ${V.HELM}`);

const HELM_BASE = 'https://tytel.org/static/dist';

const helmFiles = [
  { label: 'helm win32-x64',   name: `Helm_64bit_v${V.HELM.replace(/\./g,'_')}_r.msi`,  url: `${HELM_BASE}/Helm_64bit_v0_9_0_r.msi`,  min: 4_000_000 },
  { label: 'helm darwin',      name: `Helm_v${V.HELM.replace(/\./g,'_')}_r.pkg`,        url: `${HELM_BASE}/Helm_v0_9_0_r.pkg`,        min: 4_000_000 },
  { label: 'helm linux-amd64', name: `helm_${V.HELM}_amd64_r.deb`,                       url: `${HELM_BASE}/helm_0.9.0_amd64_r.deb`,   min: 2_000_000 },
];

for (const f of helmFiles) {
  record(f.label, f.name, await download(f.label, f.url, out(f.name), f.min));
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. STIRLING-PDF  (cross-platform jar)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Stirling PDF ───────────────────────────────────────────────');
console.log(`   version: ${V.STIRLING}`);

{
  const name = `Stirling-PDF-${V.STIRLING}.jar`;
  const url  = `https://github.com/Stirling-Tools/Stirling-PDF/releases/download/v${V.STIRLING}/Stirling-PDF.jar`;
  // Keep as Stirling-PDF.jar on disk — your fetch-stirling.js expects this exact name.
  // We add the version into the hosted filename so you can diff releases on PHOBOS-BUILDS.
  record(name, name, await download(`Stirling-PDF ${V.STIRLING}`, url, out(name), 50_000_000));
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. POLARIS  (music server)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Polaris ────────────────────────────────────────────────────');
console.log(`   version: ${V.POLARIS}`);

// Windows: MSI — extract polaris-cli.exe via msiexec /a on your Windows machine
// and upload the extracted binary, OR upload the raw MSI and extract at boot.
// We download the MSI here so you have it ready.
{
  const name = `Polaris_${V.POLARIS}.msi`;
  const url  = `https://github.com/agersant/polaris/releases/download/${V.POLARIS}/Polaris_${V.POLARIS}.msi`;
  record(name, name, await download(`Polaris ${V.POLARIS} win32 MSI`, url, out(name), 5_000_000));
}

// Linux and macOS: need to build from source. Record these as manual tasks.
manual.push({
  target:  'polaris linux-x64',
  outFile: `polaris-linux-x64`,
  instructions: [
    `# On your Linux machine:`,
    `curl -L https://github.com/agersant/polaris/releases/download/${V.POLARIS}/Polaris_${V.POLARIS}.tar.gz | tar -xz`,
    `cd Polaris_${V.POLARIS}`,
    `cargo build --release --bin polaris`,
    `# Binary will be at: target/release/polaris`,
    `# Upload as: polaris-linux-x64  to PHOBOS-BUILDS release`,
  ],
});
manual.push({
  target:  'polaris darwin-arm64',
  outFile: `polaris-darwin-arm64`,
  instructions: [
    `# On your macOS (Apple Silicon) machine:`,
    `curl -L https://github.com/agersant/polaris/releases/download/${V.POLARIS}/Polaris_${V.POLARIS}.tar.gz | tar -xz`,
    `cd Polaris_${V.POLARIS}`,
    `cargo build --release --bin polaris`,
    `# Binary will be at: target/release/polaris`,
    `# Upload as: polaris-darwin-arm64  to PHOBOS-BUILDS release`,
  ],
});
manual.push({
  target:  'polaris darwin-x64',
  outFile: `polaris-darwin-x64`,
  instructions: [
    `# On your macOS (Intel) machine (or via cross-compile on Apple Silicon):`,
    `curl -L https://github.com/agersant/polaris/releases/download/${V.POLARIS}/Polaris_${V.POLARIS}.tar.gz | tar -xz`,
    `cd Polaris_${V.POLARIS}`,
    `cargo build --release --bin polaris`,
    `# Binary will be at: target/release/polaris`,
    `# Upload as: polaris-darwin-x64  to PHOBOS-BUILDS release`,
  ],
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. NODE.JS v22 LTS  (runtime for CamofoxManager + MeridianManager)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Node.js v22 LTS ────────────────────────────────────────────');
console.log(`   version: ${V.NODE}`);

const NODE_BASE = `https://nodejs.org/dist/v${V.NODE}`;

const nodeFiles = [
  { label: 'node win32-x64',    name: `node-${V.NODE}-win32-x64.exe`,           url: `${NODE_BASE}/win-x64/node.exe`,                                min: 20_000_000, rename: `node-win32-x64.exe` },
  { label: 'node darwin-arm64', name: `node-v${V.NODE}-darwin-arm64.tar.gz`,    url: `${NODE_BASE}/node-v${V.NODE}-darwin-arm64.tar.gz`,             min: 20_000_000 },
  { label: 'node darwin-x64',   name: `node-v${V.NODE}-darwin-x64.tar.gz`,     url: `${NODE_BASE}/node-v${V.NODE}-darwin-x64.tar.gz`,              min: 20_000_000 },
  { label: 'node linux-x64',    name: `node-v${V.NODE}-linux-x64.tar.gz`,      url: `${NODE_BASE}/node-v${V.NODE}-linux-x64.tar.gz`,               min: 20_000_000 },
  { label: 'node linux-arm64',  name: `node-v${V.NODE}-linux-arm64.tar.gz`,    url: `${NODE_BASE}/node-v${V.NODE}-linux-arm64.tar.gz`,             min: 20_000_000 },
];

for (const f of nodeFiles) {
  const destName = f.rename ?? f.name;
  record(f.label, destName, await download(f.label, f.url, out(destName), f.min));
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. PANDOC  (document converter — backend only)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Pandoc ─────────────────────────────────────────────────────');

const PANDOC_VERSION = '3.6.4';
const PANDOC_GH = `https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}`;

const pandocFiles = [
  { label: 'pandoc win32-x64',    name: `pandoc-${PANDOC_VERSION}-windows-x86_64.zip`,  url: `${PANDOC_GH}/pandoc-${PANDOC_VERSION}-windows-x86_64.zip`,  min: 20_000_000 },
  { label: 'pandoc darwin-arm64', name: `pandoc-${PANDOC_VERSION}-arm64-macOS.zip`,      url: `${PANDOC_GH}/pandoc-${PANDOC_VERSION}-arm64-macOS.zip`,      min: 18_000_000 },
  { label: 'pandoc darwin-x64',   name: `pandoc-${PANDOC_VERSION}-x86_64-macOS.zip`,    url: `${PANDOC_GH}/pandoc-${PANDOC_VERSION}-x86_64-macOS.zip`,    min: 20_000_000 },
  { label: 'pandoc linux-x64',    name: `pandoc-${PANDOC_VERSION}-linux-amd64.tar.gz`,  url: `${PANDOC_GH}/pandoc-${PANDOC_VERSION}-linux-amd64.tar.gz`,  min: 20_000_000 },
  { label: 'pandoc linux-arm64',  name: `pandoc-${PANDOC_VERSION}-linux-arm64.tar.gz`,  url: `${PANDOC_GH}/pandoc-${PANDOC_VERSION}-linux-arm64.tar.gz`,  min: 18_000_000 },
];

for (const f of pandocFiles) {
  record(f.label, f.name, await download(f.label, f.url, out(f.name), f.min));
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. MPV  (video player for Media Hub)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── mpv ────────────────────────────────────────────────────────');

const MPV_GH = 'https://github.com/mpv-player/mpv/releases/download/v0.41.0';

const mpvFiles = [
  { label: 'mpv win32-x64',    name: 'mpv-v0.41.0-x86_64-w64-mingw32.zip',  url: `${MPV_GH}/mpv-v0.41.0-x86_64-w64-mingw32.zip`,    min: 30_000_000 },
  { label: 'mpv darwin-arm64', name: 'mpv-v0.41.0-macos-26-arm.zip',          url: `${MPV_GH}/mpv-v0.41.0-macos-26-arm.zip`,           min: 5_000_000  },
  { label: 'mpv darwin-x64',   name: 'mpv-v0.41.0-macos-15-intel.zip',        url: `${MPV_GH}/mpv-v0.41.0-macos-15-intel.zip`,         min: 5_000_000  },
];

for (const f of mpvFiles) {
  record(f.label, f.name, await download(f.label, f.url, out(f.name), f.min));
}

// mpv linux-x64: no official static binary from mpv project.
// Install via package manager on your Linux machine and upload the binary manually:
//   which mpv  OR  apt show mpv  OR  flatpak run io.mpv.Mpv
//   Upload the binary as: mpv-linux-x64  to PHOBOS-DEPS release
manual.push({
  target:  'mpv linux-x64',
  outFile: 'mpv-linux-x64',
  instructions: [
    '# On your Linux machine (static build via package manager):',
    '# Option A — system mpv (if statically linked or appimage):',
    '#   cp $(which mpv) ./mpv-linux-x64',
    '# Option B — download AppImage and extract:',
    '#   wget https://github.com/zhongfly/mpv-packaging/releases/latest/download/mpv-x86_64.AppImage',
    '#   chmod +x mpv-x86_64.AppImage && ./mpv-x86_64.AppImage --appimage-extract',
    '#   cp squashfs-root/usr/bin/mpv ./mpv-linux-x64',
    '# Upload as: mpv-linux-x64  to PHOBOS-DEPS release',
  ],
});
// mpv linux-arm64: same situation — no static binary available.
manual.push({
  target:  'mpv linux-arm64',
  outFile: 'mpv-linux-arm64',
  instructions: [
    '# On your Linux ARM64 machine:',
    '#   cp $(which mpv) ./mpv-linux-arm64',
    '# Upload as: mpv-linux-arm64  to PHOBOS-DEPS release',
  ],
});

// ─────────────────────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  SUMMARY');
console.log('══════════════════════════════════════════════════════════════\n');

const succeeded = results.filter(r => !r.error);
const failed    = results.filter(r =>  r.error);
const skipped   = results.filter(r =>  r.skipped);

if (succeeded.length) {
  console.log(`✅ Downloaded (${succeeded.length}):`);
  for (const r of succeeded) {
    const sz = r.size ? ` — ${fmt(r.size)}` : r.skipped ? ' — already present' : '';
    console.log(`   ${r.file}${sz}`);
  }
}

if (failed.length) {
  console.log(`\n❌ Failed (${failed.length}):`);
  for (const r of failed) {
    console.log(`   ${r.file} — ${r.error}`);
  }
}

console.log(`\n⚙️  Needs manual build (${manual.length}):`);
for (const m of manual) {
  console.log(`\n   ── ${m.target} → ${m.outFile} ──`);
  for (const line of m.instructions) console.log(`   ${line}`);
}

console.log('\n──────────────────────────────────────────────────────────────');
console.log('  Upload checklist for PHOBOS-BUILDS release PHOBOS-CORE-LATEST');
console.log('──────────────────────────────────────────────────────────────');
console.log(`  Output directory: ${OUT_DIR}\n`);

const allExpected = [
  // SYBIL
  'nomic-embed-text-v1.5.Q4_K_M.gguf',
  // VSS (5 platforms)
  ...VSS_PLATFORMS.map(p => p.outName),
  // Already on release (don't re-upload unless changed)
  'PhobosCrystal.vst3.zip           ← already on PHOBOS-BUILDS',
  'rocm-libs-win64-v7.1.zip         ← already on PHOBOS-BUILDS',
  // Polaris manual
  'polaris-linux-x64                ← manual build required',
  'polaris-darwin-arm64             ← manual build required',
  'polaris-darwin-x64               ← manual build required',
];

for (const name of allExpected) {
  const note = name.includes('←') ? name : '';
  const filename = name.split('←')[0].trim();
  const exists = fs.existsSync(out(filename));
  console.log(`  ${exists ? '✅' : note ? '📋' : '❌'}  ${name}`);
}

// List everything actually downloaded
const downloadedFiles = fs.readdirSync(OUT_DIR).sort();
console.log(`\n  Files in ${OUT_DIR}:`);
let totalSize = 0;
for (const f of downloadedFiles) {
  const sz = fs.statSync(path.join(OUT_DIR, f)).size;
  totalSize += sz;
  console.log(`    ${fmt(sz).padStart(9)}  ${f}`);
}
console.log(`\n  Total: ${fmt(totalSize)}`);
console.log('\n  Upload all files in the output directory to your GitHub release.');
console.log('  Then run the boot-sequence refactor to replace all individual fetch scripts.');
console.log('══════════════════════════════════════════════════════════════\n');