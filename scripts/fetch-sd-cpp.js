#!/usr/bin/env node
// scripts/fetch-sd-cpp.js
// Downloads pre-built sd-cli binaries from the stable-diffusion.cpp GitHub releases
// into the repo's bin/ directory. Run once before building.
//
// Standalone:
//   node scripts/fetch-sd-cpp.js
//   node scripts/fetch-sd-cpp.js --all    (fetch all platforms, not just current)
//
// Confirmed asset names from release master-525-d6dd6d7:
//
//   sd-master-<HASH>-bin-win-vulkan-x64.zip          Windows Vulkan GPU (primary)
//   sd-master-<HASH>-bin-win-cuda12-x64.zip          Windows CUDA GPU
//   sd-master-<HASH>-bin-win-avx2-x64.zip            Windows CPU fallback
//   cudart-sd-bin-win-cu12-x64.zip                   CUDA runtime DLLs only (no binary)
//   sd-master-<HASH>-bin-Linux-Ubuntu-24.04-x86_64.zip           Linux x64 CPU
//   sd-master-<HASH>-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip    Linux x64 Vulkan
//   sd-master-<HASH>-bin-Linux-Ubuntu-24.04-x86_64-rocm.zip      Linux x64 ROCm
//   sd-master-<HASH>-bin-Darwin-macOS-<VER>-arm64.zip            macOS arm64
//
//   Binary name inside archives: sd-cli.exe (Windows) or sd-cli (Linux/mac).
//   Legacy sd.exe / sd also tried as fallback.

import https  from 'node:https';
import fs     from 'node:fs';
import path   from 'node:path';
import zlib   from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BIN_DIR = path.resolve(__dirname, '..', 'bin');
export const TMP_DIR = path.resolve(__dirname, '..', 'bin', '.tmp');

const args = process.argv.slice(2);
const vArg = args.find(a => a.startsWith('--version='))?.split('=')[1]
          ?? args[args.indexOf('--version') + 1];

// ── GitHub API helpers ────────────────────────────────────────────────────────

const GH_HEADERS = {
  'User-Agent': 'phobos-fetch-sd-cpp/1.0',
  'Accept':     'application/vnd.github+json',
  ...(process.env.GITHUB_TOKEN ? { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 10) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(target);
      https.get({
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        headers:  parsed.hostname === 'api.github.com' ? GH_HEADERS : {},
      }, res => {
        if ([301, 302, 307, 308].includes(res.statusCode)) follow(res.headers.location, hops + 1);
        else resolve(res);
      }).on('error', reject);
    };
    follow(url);
  });
}

async function getLatestRelease() {
  const res  = await httpsGet('https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest');
  const body = await new Promise((resolve, reject) => {
    let buf = '';
    res.on('data', d => buf += d);
    res.on('end', () => resolve(buf));
    res.on('error', reject);
  });
  if (res.statusCode !== 200) throw new Error(`GitHub API HTTP ${res.statusCode}:\n${body.slice(0, 300)}`);
  const data = JSON.parse(body);
  if (!data.tag_name) throw new Error('No tag_name in response');
  // Tag format: "master-525-d6dd6d7" — filenames use only the 7-char hash at the end
  const shortHash = data.tag_name.split('-').pop();
  const assets    = (data.assets ?? []).map(a => a.name);
  return { tag: data.tag_name, shortHash, assets };
}

async function downloadFile(url, dest) {
  const res = await httpsGet(url);
  if (res.statusCode === 404) { res.resume(); return { status: 404 }; }
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode} for ${url}`);
  return new Promise((resolve, reject) => {
    const fd     = fs.createWriteStream(dest);
    let received = 0;
    const total  = parseInt(res.headers['content-length'] ?? '0', 10);
    fd.on('error', reject);
    res.on('data', chunk => {
      received += chunk.length;
      if (!fd.write(chunk)) { res.pause(); fd.once('drain', () => res.resume()); }
      if (total) process.stdout.write(`\r  ${Math.round(received / total * 100)}%  ${(received / 1e6).toFixed(1)} MB`);
    });
    res.on('end',   () => { process.stdout.write('\n'); fd.end(() => resolve({ status: 200 })); });
    res.on('error', err => { fd.destroy(); reject(err); });
  });
}

// ── ZIP helpers ───────────────────────────────────────────────────────────────

function readZipCd(archivePath) {
  const fd   = fs.openSync(archivePath, 'r');
  const size = fs.fstatSync(fd).size;
  const buf  = Buffer.alloc(Math.min(65558, size));
  fs.readSync(fd, buf, 0, buf.length, size - buf.length);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i+1] === 0x4b && buf[i+2] === 0x05 && buf[i+3] === 0x06) { eocd = i; break; }
  }
  if (eocd === -1) { fs.closeSync(fd); throw new Error('ZIP: EOCD not found'); }
  const cdSize = buf.readUInt32LE(eocd + 12), cdStart = buf.readUInt32LE(eocd + 16);
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdStart);
  fs.closeSync(fd);
  return cd;
}

function* walkCd(cd) {
  let pos = 0;
  while (pos < cd.length) {
    if (cd.readUInt32LE(pos) !== 0x02014b50) break;
    const compMethod = cd.readUInt16LE(pos + 10), compSize = cd.readUInt32LE(pos + 20);
    const uncompSize = cd.readUInt32LE(pos + 24), fnLen    = cd.readUInt16LE(pos + 28);
    const extraLen   = cd.readUInt16LE(pos + 30), cmtLen   = cd.readUInt16LE(pos + 32);
    const localOff   = cd.readUInt32LE(pos + 42);
    const name       = cd.subarray(pos + 46, pos + 46 + fnLen).toString('utf8');
    pos += 46 + fnLen + extraLen + cmtLen;
    yield { name, compMethod, compSize, uncompSize, localOff };
  }
}

async function extractEntry(archivePath, entry, destPath) {
  const lh  = Buffer.alloc(30);
  const lfd = fs.openSync(archivePath, 'r');
  fs.readSync(lfd, lh, 0, 30, entry.localOff);
  const dataOff = entry.localOff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(archivePath, { start: dataOff, end: dataOff + entry.compSize - 1 });
    const out   = fs.createWriteStream(destPath);
    const fail  = err => { out.destroy(); reject(err); };
    out.on('finish', () => { fs.closeSync(lfd); resolve(); });
    out.on('error', fail); input.on('error', fail);
    if      (entry.compMethod === 0) { input.pipe(out); }
    else if (entry.compMethod === 8) { const inf = zlib.createInflateRaw(); inf.on('error', fail); input.pipe(inf).pipe(out); }
    else reject(new Error(`Unsupported zip method: ${entry.compMethod}`));
  });
}

async function extractAllFromZip(archivePath, destDir, filter = () => true) {
  const cd = readZipCd(archivePath);
  const extracted = [];
  for (const entry of walkCd(cd)) {
    if (entry.name.endsWith('/') || entry.uncompSize === 0) continue;
    const base = entry.name.split('/').pop();
    if (!filter(base)) continue;
    await extractEntry(archivePath, entry, path.join(destDir, base));
    extracted.push(base);
  }
  return extracted;
}

// ── tar.gz extraction ─────────────────────────────────────────────────────────

async function extractAllFromTarGz(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(archivePath);
    const gz    = zlib.createGunzip();
    const out   = [];
    let buf = Buffer.alloc(0), state = 'header', rem = 0, dsz = 0, fd = null, fname = null;
    const fail = err => { fd?.destroy(); input.destroy(); reject(err); };
    const proc = () => {
      while (true) {
        if (state === 'header') {
          if (buf.length < 512) return;
          const h = buf.subarray(0, 512); buf = buf.subarray(512);
          if (h.every(b => b === 0)) continue;
          const type = String.fromCharCode(h[156]);
          const name = h.subarray(0, 100).toString('utf8').replace(/\0.*/, '');
          const size = parseInt(h.subarray(124, 136).toString('ascii').trim(), 8) || 0;
          const pad  = Math.ceil(size / 512) * 512;
          if (type !== '0' && type !== '\0') { state = 'skip'; rem = pad; continue; }
          if (size === 0) { state = 'skip'; rem = 0; continue; }
          const base = name.split('/').pop();
          fd = fs.createWriteStream(path.join(destDir, base)); fd.on('error', fail);
          fname = base; state = 'write'; dsz = size; rem = pad; continue;
        }
        if (state === 'skip') {
          if (rem === 0) { state = 'header'; continue; }
          const t = Math.min(rem, buf.length); buf = buf.subarray(t); rem -= t;
          if (rem === 0) state = 'header'; return;
        }
        if (state === 'write') {
          if (rem === 0) {
            state = 'header';
            const n = fname, f = fd; fd = null; fname = null;
            f.end(() => { out.push(n); proc(); }); return;
          }
          if (buf.length === 0) return;
          const w = Math.min(dsz, buf.length, rem), t = Math.min(rem, buf.length);
          if (w > 0) fd.write(buf.subarray(0, w));
          dsz -= w; buf = buf.subarray(t); rem -= t;
          if (rem === 0) {
            state = 'header';
            const n = fname, f = fd; fd = null; fname = null;
            f.end(() => { out.push(n); proc(); });
          }
          return;
        }
      }
    };
    gz.on('data', chunk => { buf = Buffer.concat([buf, chunk]); proc(); });
    gz.on('end', () => {
      if (fd) { const n = fname, f = fd; fd = null; fname = null; f.end(() => { out.push(n); resolve(out); }); }
      else resolve(out);
    });
    gz.on('error', fail); input.on('error', fail); input.pipe(gz);
  });
}

// ── Rename helper ─────────────────────────────────────────────────────────────

function renameFirstMatch(dir, candidates, outPath) {
  for (const c of candidates) {
    const p = path.join(dir, c);
    if (fs.existsSync(p)) { fs.renameSync(p, outPath); return c; }
  }
  return null;
}

// ── Core fetch function ───────────────────────────────────────────────────────

async function fetchAsset(label, url, archiveDest, outPath, extractFn, renameCandidates) {
  if (fs.existsSync(outPath)) { console.log(`✓  ${label} (already present)`); return true; }
  console.log(`↓  ${label}`);
  console.log(`   ${url}`);
  let result;
  try { result = await downloadFile(url, archiveDest); }
  catch (err) { console.error(`   ✗ Download error: ${err.message}`); return false; }
  if (result.status === 404) { console.error(`   ✗ 404 — asset not found`); return false; }
  try {
    const files = await extractFn(archiveDest);
    if (files.length) console.log(`   extracted: ${files.join(', ')}`);
    if (renameCandidates) {
      const renamed = renameFirstMatch(path.dirname(outPath), renameCandidates, outPath);
      if (!renamed) console.warn(`   ⚠️  Binary rename failed — none of [${renameCandidates.join(', ')}] found`);
    }
    if (fs.existsSync(archiveDest)) fs.unlinkSync(archiveDest);
    console.log(`   ✓  ${label}`);
    return true;
  } catch (err) {
    console.error(`   ✗ Extract failed: ${err.message}`);
    if (fs.existsSync(archiveDest)) fs.unlinkSync(archiveDest);
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function fetchSdBinaries({ all = false } = {}) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  let tag, shortHash, assets;
  if (vArg) {
    tag = vArg; shortHash = vArg.split('-').pop(); assets = [];
    console.log(`\nUsing specified version: ${tag} (short hash: ${shortHash})\n`);
  } else {
    ({ tag, shortHash, assets } = await getLatestRelease());
    console.log(`\nLatest release: ${tag} (short hash: ${shortHash})`);
    if (assets.length) console.log(`Assets: ${assets.join(', ')}`);
    console.log('');
  }

  const dl  = (fn) => `https://github.com/leejet/stable-diffusion.cpp/releases/download/${tag}/${fn}`;
  const tmp = (fn) => path.join(TMP_DIR, fn);
  const bin = (fn) => path.join(BIN_DIR, fn);
  const p = process.platform, a = process.arch;

  // ── Linux x64 ───────────────────────────────────────────────────────────────
  // Prefer Vulkan build (GPU support); fall back to plain CPU build.
  if (all || (p === 'linux' && a === 'x64')) {
    const chmodAll = async (archive) => {
      const files = await extractAllFromZip(archive, BIN_DIR);
      for (const e of fs.readdirSync(BIN_DIR)) {
        const ep = path.join(BIN_DIR, e);
        if (fs.statSync(ep).isFile()) fs.chmodSync(ep, 0o755);
      }
      return files;
    };

    // Try Vulkan first, fall back to plain
    const vulkanFn = `sd-master-${shortHash}-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip`;
    const plainFn  = `sd-master-${shortHash}-bin-Linux-Ubuntu-24.04-x86_64.zip`;
    const outPath  = bin('sd-server-linux-x64');

    if (!fs.existsSync(outPath)) {
      // Check which assets are available and prefer Vulkan
      const preferVulkan = assets.length === 0 || assets.includes(vulkanFn);
      const fn = preferVulkan ? vulkanFn : plainFn;
      const ok = await fetchAsset(
        'sd-server-linux-x64 (Vulkan)',
        dl(fn), tmp(fn), outPath,
        chmodAll, ['sd-cli', 'sd'],
      );
      // If Vulkan 404'd, try plain CPU build
      if (!ok && fn === vulkanFn) {
        await fetchAsset(
          'sd-server-linux-x64 (CPU fallback)',
          dl(plainFn), tmp(plainFn), outPath,
          chmodAll, ['sd-cli', 'sd'],
        );
      }
    } else {
      console.log(`✓  sd-server-linux-x64 (already present)`);
    }
  }

  // ── Linux arm64 ─────────────────────────────────────────────────────────────
  // NOTE: arm64 assets not confirmed in the current release asset list.
  // Attempt with best-guess naming; will 404 gracefully if not published.
  if (all || (p === 'linux' && a === 'arm64')) {
    const fn      = `sd-master-${shortHash}-bin-Linux-Ubuntu-24.04-aarch64.zip`;
    const outPath = bin('sd-server-linux-arm64');
    await fetchAsset(
      'sd-server-linux-arm64',
      dl(fn), tmp(fn), outPath,
      async (archive) => {
        const files = await extractAllFromZip(archive, BIN_DIR);
        for (const e of fs.readdirSync(BIN_DIR)) {
          const ep = path.join(BIN_DIR, e);
          if (fs.statSync(ep).isFile()) fs.chmodSync(ep, 0o755);
        }
        return files;
      },
      ['sd-cli', 'sd'],
    );
  }

  // ── macOS arm64 ─────────────────────────────────────────────────────────────
  // The macOS asset includes the macOS version in the filename (e.g. macOS-15.7.4).
  // Discover exact name from API assets list; fall back to trying common versions.
  if (all || (p === 'darwin' && a === 'arm64')) {
    const outPath = bin('sd-server-darwin-arm64');
    if (fs.existsSync(outPath)) {
      console.log(`✓  sd-server-darwin-arm64 (already present)`);
    } else {
      let fn = assets.find(n => n.includes('Darwin') && n.includes('arm64'));
      if (!fn) {
        const macVersions = ['15.7.4', '15.7.3', '15.7.2', '15.7', '15.4', '14.7', '14.6'];
        fn = `sd-master-${shortHash}-bin-Darwin-macOS-${macVersions[0]}-arm64.zip`;
        console.log(`   Note: macOS asset version varies per release. Set GITHUB_TOKEN env for exact discovery.`);
      }
      await fetchAsset(
        'sd-server-darwin-arm64',
        dl(fn), tmp(fn), outPath,
        async (archive) => {
          const files = await extractAllFromZip(archive, BIN_DIR, n => !n.includes('.') || n.endsWith('.dylib'));
          for (const e of fs.readdirSync(BIN_DIR)) {
            const ep = path.join(BIN_DIR, e);
            if (fs.statSync(ep).isFile()) fs.chmodSync(ep, 0o755);
          }
          return files;
        },
        ['sd-cli', 'sd'],
      );
    }
  }

  // ── Windows x64 ─────────────────────────────────────────────────────────────
  // IMPORTANT: sd-cli DLLs must NOT be mixed with llama-cpp DLLs in bin/ — they
  // are built against different ggml versions and will conflict, causing sd-cli to
  // fall back to CPU even when a CUDA/Vulkan binary is used.
  // Each sd build gets its own subdirectory with its own companion DLLs:
  //   bin/sd-vulkan/   — Vulkan GPU build
  //   bin/sd-cuda/     — CUDA GPU build + CUDA runtime DLLs
  //   bin/sd-cpu/      — CPU AVX2 fallback
  // resolveSdServerBin() returns the .exe inside the subdir; cwd is set to that subdir.
  if (all || p === 'win32') {
    const sdFilter = n => n.endsWith('.exe') || n.endsWith('.dll');

    const SD_VULKAN_DIR = path.join(BIN_DIR, 'sd-vulkan');
    const SD_CUDA_DIR   = path.join(BIN_DIR, 'sd-cuda');
    const SD_CPU_DIR    = path.join(BIN_DIR, 'sd-cpu');
    fs.mkdirSync(SD_VULKAN_DIR, { recursive: true });
    fs.mkdirSync(SD_CUDA_DIR,   { recursive: true });
    fs.mkdirSync(SD_CPU_DIR,    { recursive: true });

    const extractTo = dir => archive => extractAllFromZip(archive, dir, sdFilter);

    // Primary: Vulkan GPU build
    const vulkanFn = `sd-master-${shortHash}-bin-win-vulkan-x64.zip`;
    await fetchAsset(
      'sd-server-win32-x64.exe (Vulkan GPU)',
      dl(vulkanFn), tmp(vulkanFn), path.join(SD_VULKAN_DIR, 'sd-server-win32-x64.exe'),
      extractTo(SD_VULKAN_DIR), ['sd-cli.exe', 'sd.exe'],
    );

    // CUDA GPU build — binary + its own ggml-cuda.dll isolated in sd-cuda/
    const cudaFn = `sd-master-${shortHash}-bin-win-cuda12-x64.zip`;
    await fetchAsset(
      'sd-server-win32-x64-cuda.exe (CUDA GPU)',
      dl(cudaFn), tmp(cudaFn), path.join(SD_CUDA_DIR, 'sd-server-win32-x64-cuda.exe'),
      extractTo(SD_CUDA_DIR), ['sd-cli.exe', 'sd.exe'],
    );

    // CUDA runtime DLLs — must live alongside the CUDA binary in sd-cuda/
    const cudaRtFn   = 'cudart-sd-bin-win-cu12-x64.zip';
    const cudaRtPath = path.join(SD_CUDA_DIR, 'cudart64_12.dll');
    if (fs.existsSync(cudaRtPath)) {
      console.log(`✓  CUDA runtime DLLs in sd-cuda/ (already present)`);
    } else {
      await fetchAsset(
        'CUDA runtime DLLs',
        dl(cudaRtFn), tmp(cudaRtFn), cudaRtPath,
        archive => extractAllFromZip(archive, SD_CUDA_DIR, n => n.endsWith('.dll')),
        null,
      );
    }

    // CPU AVX2 fallback
    const avx2Fn = `sd-master-${shortHash}-bin-win-avx2-x64.zip`;
    await fetchAsset(
      'sd-server-win32-x64-cpu.exe (AVX2 CPU fallback)',
      dl(avx2Fn), tmp(avx2Fn), path.join(SD_CPU_DIR, 'sd-server-win32-x64-cpu.exe'),
      extractTo(SD_CPU_DIR), ['sd-cli.exe', 'sd.exe'],
    );
  }

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log('\nDone. sd-server binaries are in bin/');
}

// ── Standalone ────────────────────────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fetchSdBinaries({ all: args.includes('--all') })
    .catch(err => { console.error(err.message); process.exit(1); });
}
