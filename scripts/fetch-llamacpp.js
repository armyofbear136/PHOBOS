#!/usr/bin/env node
// scripts/fetch-llamacpp.js
// Downloads pre-built llama-server binaries from the llama.cpp GitHub releases
// into the repo's bin/ directory. Run once before building.
//
// Standalone — fetches ALL platforms:
//   node scripts/fetch-llamacpp.js
//   node scripts/fetch-llamacpp.js --version b5000
//
// Per-platform scripts import fetchBinaries() and pass a single target:
//   scripts/fetch-linux-x64.js
//   scripts/fetch-darwin-arm64.js
//   scripts/fetch-darwin-x64.js
//   scripts/fetch-win32-x64.js

import https  from 'node:https';
import fs     from 'node:fs';
import path   from 'node:path';
import zlib   from 'node:zlib';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BIN_DIR = path.resolve(__dirname, '..', 'bin');
export const TMP_DIR = path.resolve(__dirname, '..', 'bin', '.tmp');

const args    = process.argv.slice(2);
const vArg    = args.find(a => a.startsWith('--version='))?.split('=')[1]
             ?? (args[args.indexOf('--version') + 1]);

// ── Helpers ───────────────────────────────────────────────────────────────────

// Load .env from repo root if present — lets you store GITHUB_TOKEN there without
// setting it as a system env var. Never commit .env (it's in .gitignore).
(function loadDotEnv() {
  try {
    const envPath = path.resolve(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  } catch { /* silent — .env is optional */ }
})();

// Headers required for GitHub API — User-Agent mandatory, Accept ensures JSON not redirect page.
const GH_HEADERS = {
  'User-Agent': 'phobos-fetch-llamacpp/1.0',
  'Accept':     'application/vnd.github+json',
  ...(process.env.GITHUB_TOKEN ? { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

function httpsGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 10) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(target);
      // Send GitHub headers to github.com AND api.github.com — not to S3/CDN redirects.
      // github.com/releases/download redirects require Authorization when a token is set,
      // otherwise the authenticated session returns 404 for assets.
      const isGithub = parsed.hostname === 'api.github.com' || parsed.hostname === 'github.com';
      const headers  = { ...(isGithub ? GH_HEADERS : {}), ...extraHeaders };
      const opts = {
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        headers,
      };
      https.get(opts, res => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          follow(res.headers.location, hops + 1);
        } else {
          resolve(res);
        }
      }).on('error', reject);
    };
    follow(url);
  });
}

async function getLatestRelease() {
  const res  = await httpsGet('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest');
  const body = await new Promise((resolve, reject) => {
    let buf = '';
    res.on('data', d => buf += d);
    res.on('end', () => resolve(buf));
    res.on('error', reject);
  });
  if (res.statusCode !== 200) {
    throw new Error(`GitHub API returned HTTP ${res.statusCode}:\n${body.slice(0, 200)}`);
  }
  const data = JSON.parse(body);
  if (!data.tag_name) throw new Error(`Unexpected GitHub API response: ${body.slice(0, 200)}`);
  return data.tag_name; // e.g. "b5342"
}

async function downloadFile(url, dest) {
  const res = await httpsGet(url);
  if (res.statusCode === 404) {
    // Log the actual response to help diagnose rate limiting vs genuine 404
    process.stdout.write(`   [HTTP 404 — ${res.headers['x-ratelimit-remaining'] !== undefined ? `rate limit remaining: ${res.headers['x-ratelimit-remaining']}` : 'no rate-limit headers'}]\n`);
    return { status: 404 };
  }
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode} for ${url}`);
  return new Promise((resolve, reject) => {
    const fd = fs.createWriteStream(dest);
    let received = 0;
    const total  = parseInt(res.headers['content-length'] ?? '0', 10);

    fd.on('error', reject);

    res.on('data', chunk => {
      received += chunk.length;
      if (!fd.write(chunk)) {
        // Respect backpressure
        res.pause();
        fd.once('drain', () => res.resume());
      }
      if (total) {
        process.stdout.write(`\r  ${Math.round(received / total * 100)}%  ${(received / 1e6).toFixed(1)} MB`);
      }
    });

    res.on('end', () => {
      process.stdout.write('\n');
      // fd.end() flushes internal buffers and closes the file handle cleanly.
      // Only resolve once 'finish' fires — guarantees the OS has released the lock.
      fd.end(() => resolve({ status: 200 }));
    });

    res.on('error', (err) => {
      fd.destroy();
      reject(err);
    });
  });
}

// ── Pure-Node archive extraction ──────────────────────────────────────────────
// No shell, no tar, no PowerShell. Streams the archive in-process, writes only
// the one binary we want. Works identically on Windows, macOS, Linux.

/**
 * Extract a single file by name from a .tar.gz archive.
 * Pure Node.js — no shell, no tar binary needed.
 */
async function extractFromTarGz(archivePath, targetName, destPath) {
  return new Promise((resolve, reject) => {
    const input  = fs.createReadStream(archivePath);
    const gunzip = zlib.createGunzip();
    let outFd    = null;
    let buf      = Buffer.alloc(0);

    // State machine: 'header' | 'data-target' | 'data-skip'
    let state     = 'header';
    let remaining = 0;  // bytes left in current entry (always a multiple of 512 after rounding up)
    let dataSize  = 0;  // actual file size (for writing — not the padded size)

    const fail = (err) => { outFd?.destroy(); input.destroy(); reject(err); };

    const processBuffer = () => {
      while (true) {
        if (state === 'header') {
          if (buf.length < 512) return;  // wait for more data
          const header = buf.subarray(0, 512);
          buf = buf.subarray(512);

          if (header.every(b => b === 0)) continue;  // zero block — end of archive padding

          const typeFlag  = String.fromCharCode(header[156]);
          const rawName   = header.subarray(0, 100).toString('utf8').replace(/\0.*/, '');
          const fileBytes = parseInt(header.subarray(124, 136).toString('ascii').trim(), 8) || 0;
          // Tar pads each entry's data to a multiple of 512
          const paddedBytes = Math.ceil(fileBytes / 512) * 512;

          if (typeFlag !== '0' && typeFlag !== '\0') {
            // Not a regular file (dir, symlink, GNU long-name block, etc.) — skip data
            state     = 'data-skip';
            remaining = paddedBytes;
            continue;
          }

          const basename = rawName.split('/').pop();
          if (basename === targetName) {
            outFd    = fs.createWriteStream(destPath);
            outFd.on('error', fail);
            state     = 'data-target';
            dataSize  = fileBytes;
            remaining = paddedBytes;
          } else {
            state     = 'data-skip';
            remaining = paddedBytes;
          }
          continue;
        }

        if (state === 'data-skip') {
          if (remaining === 0) { state = 'header'; continue; }
          const take = Math.min(remaining, buf.length);
          buf       = buf.subarray(take);
          remaining -= take;
          if (remaining === 0) { state = 'header'; }
          return;  // need more data if take < remaining
        }

        if (state === 'data-target') {
          if (remaining === 0) {
            // Done writing
            state = 'header';
            outFd.end(() => {
              gunzip.destroy();
              input.destroy();
              resolve();
            });
            return;
          }
          if (buf.length === 0) return;  // wait for more data
          // Write only the real file bytes (not the tar padding)
          const writeable = Math.min(dataSize, buf.length, remaining);
          const take      = Math.min(remaining, buf.length);
          if (writeable > 0) outFd.write(buf.subarray(0, writeable));
          dataSize  -= writeable;
          buf        = buf.subarray(take);
          remaining -= take;
          return;
        }
      }
    };

    gunzip.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      processBuffer();
    });

    gunzip.on('end', () => {
      if (!outFd) {
        reject(new Error(`"${targetName}" not found in tar.gz archive`));
      }
    });
    gunzip.on('error', fail);
    input.on('error', fail);
    input.pipe(gunzip);
  });
}

/**
 * Extract a single file by name from a .zip archive.
 * Reads the central directory from the end of the file, locates the target entry,
 * seeks to its local header, decompresses (deflate or stored) directly to destPath.
 */
async function extractFromZip(archivePath, targetName, destPath) {
  const fd       = fs.openSync(archivePath, 'r');
  const fileSize = fs.fstatSync(fd).size;

  // Read the last 64KB to find the End of Central Directory record
  const eocdBufSize = Math.min(65536 + 22, fileSize);
  const eocdBuf     = Buffer.alloc(eocdBufSize);
  fs.readSync(fd, eocdBuf, 0, eocdBufSize, fileSize - eocdBufSize);

  // Signature: 0x06054b50
  let eocdOffset = -1;
  for (let i = eocdBuf.length - 22; i >= 0; i--) {
    if (eocdBuf[i] === 0x50 && eocdBuf[i+1] === 0x4b && eocdBuf[i+2] === 0x05 && eocdBuf[i+3] === 0x06) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) { fs.closeSync(fd); throw new Error('ZIP: End of Central Directory not found'); }

  const cdCount  = eocdBuf.readUInt16LE(eocdOffset + 10);
  const cdSize   = eocdBuf.readUInt32LE(eocdOffset + 12);
  const cdStart  = eocdBuf.readUInt32LE(eocdOffset + 16);

  // Read the entire Central Directory
  const cdBuf = Buffer.alloc(cdSize);
  fs.readSync(fd, cdBuf, 0, cdSize, cdStart);

  // Walk Central Directory entries to find targetName
  let cdPos = 0;
  let found = null;
  while (cdPos < cdBuf.length) {
    if (cdBuf.readUInt32LE(cdPos) !== 0x02014b50) break; // CD entry signature
    const compMethod   = cdBuf.readUInt16LE(cdPos + 10);
    const compSize     = cdBuf.readUInt32LE(cdPos + 20);
    const uncompSize   = cdBuf.readUInt32LE(cdPos + 24);
    const fnLen        = cdBuf.readUInt16LE(cdPos + 28);
    const extraLen     = cdBuf.readUInt16LE(cdPos + 30);
    const commentLen   = cdBuf.readUInt16LE(cdPos + 32);
    const localOffset  = cdBuf.readUInt32LE(cdPos + 42);
    const entryName    = cdBuf.subarray(cdPos + 46, cdPos + 46 + fnLen).toString('utf8');
    const basename     = entryName.split('/').pop();
    if (basename === targetName) {
      found = { compMethod, compSize, uncompSize, localOffset, entryName };
      break;
    }
    cdPos += 46 + fnLen + extraLen + commentLen;
  }

  fs.closeSync(fd);
  if (!found) throw new Error(`"${targetName}" not found in zip archive`);

  // Read local file header to find actual data offset
  const lhBuf = Buffer.alloc(30);
  const lhFd  = fs.openSync(archivePath, 'r');
  fs.readSync(lhFd, lhBuf, 0, 30, found.localOffset);
  const lhFnLen    = lhBuf.readUInt16LE(26);
  const lhExtraLen = lhBuf.readUInt16LE(28);
  const dataOffset = found.localOffset + 30 + lhFnLen + lhExtraLen;

  // Stream the compressed data and decompress
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(archivePath, {
      start: dataOffset,
      end:   dataOffset + found.compSize - 1,
    });
    const outFd = fs.createWriteStream(destPath);
    const fail  = (err) => { outFd.destroy(); reject(err); };

    outFd.on('finish', () => { fs.closeSync(lhFd); resolve(); });
    outFd.on('error', fail);
    input.on('error', fail);

    if (found.compMethod === 0) {
      // Stored — no compression
      input.pipe(outFd);
    } else if (found.compMethod === 8) {
      // Deflate
      const inflate = zlib.createInflateRaw();
      inflate.on('error', fail);
      input.pipe(inflate).pipe(outFd);
    } else {
      reject(new Error(`Unsupported zip compression method: ${found.compMethod}`));
    }
  });
}

async function extractSingleFile(archivePath, targetName, destPath) {
  if (archivePath.endsWith('.tar.gz')) {
    await extractFromTarGz(archivePath, targetName, destPath);
  } else {
    await extractFromZip(archivePath, targetName, destPath);
  }
  const size = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
  if (size < 1000) throw new Error(`Extracted file suspiciously small (${size} bytes)`);
}

/**
 * Extract ALL regular files from a .tar.gz archive into destDir.
 * Skips directories and zero-byte entries. Only extracts binaries and shared
 * libraries (no extension filter — macOS dylibs, Linux .so, etc. all pass through).
 */
async function extractAllFilesFromTarGz(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    const input  = fs.createReadStream(archivePath);
    const gunzip = zlib.createGunzip();
    const extracted = [];
    let buf = Buffer.alloc(0);

    let state     = 'header';
    let remaining = 0;
    let dataSize  = 0;
    let outFd     = null;
    let outName   = null;

    const fail = (err) => { outFd?.destroy(); input.destroy(); reject(err); };

    const processBuffer = () => {
      while (true) {
        if (state === 'header') {
          if (buf.length < 512) return;
          const header = buf.subarray(0, 512);
          buf = buf.subarray(512);
          if (header.every(b => b === 0)) continue;

          const typeFlag    = String.fromCharCode(header[156]);
          const rawName     = header.subarray(0, 100).toString('utf8').replace(/\0.*/, '');
          const fileBytes   = parseInt(header.subarray(124, 136).toString('ascii').trim(), 8) || 0;
          const paddedBytes = Math.ceil(fileBytes / 512) * 512;

          // Symlink — linkname is in bytes 157-256 of the header
          if (typeFlag === '2') {
            const linkTarget = header.subarray(157, 257).toString('utf8').replace(/\0.*/, '');
            const basename   = rawName.split('/').pop();
            const destPath   = path.join(destDir, basename);
            try {
              if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
              fs.symlinkSync(linkTarget, destPath);
              extracted.push(basename);
            } catch { /* ignore symlink errors — file may not exist yet, dyld resolves at runtime */ }
            state = 'data-skip'; remaining = paddedBytes; continue;
          }

          if (typeFlag !== '0' && typeFlag !== '\0') {
            state = 'data-skip'; remaining = paddedBytes; continue;
          }
          if (fileBytes === 0) {
            state = 'data-skip'; remaining = 0; continue;
          }

          const basename = rawName.split('/').pop();
          const destPath = path.join(destDir, basename);
          outFd   = fs.createWriteStream(destPath);
          outFd.on('error', fail);
          outName   = basename;
          state     = 'data-target';
          dataSize  = fileBytes;
          remaining = paddedBytes;
          continue;
        }

        if (state === 'data-skip') {
          if (remaining === 0) { state = 'header'; continue; }
          const take = Math.min(remaining, buf.length);
          buf = buf.subarray(take);
          remaining -= take;
          if (remaining === 0) state = 'header';
          return;
        }

        if (state === 'data-target') {
          if (remaining === 0) {
            state = 'header';
            const name   = outName;
            const fd     = outFd;
            outFd = null; outName = null;
            fd.end(() => {
              extracted.push(name);
              processBuffer();
            });
            return;
          }
          if (buf.length === 0) return;
          const writeable = Math.min(dataSize, buf.length, remaining);
          const take      = Math.min(remaining, buf.length);
          if (writeable > 0) outFd.write(buf.subarray(0, writeable));
          dataSize  -= writeable;
          buf        = buf.subarray(take);
          remaining -= take;
          if (remaining === 0) {
            // Entry fully consumed — close and re-enter from header state
            state = 'header';
            const name   = outName;
            const fd     = outFd;
            outFd = null; outName = null;
            fd.end(() => {
              extracted.push(name);
              processBuffer();
            });
          }
          return;
        }
      }
    };

    gunzip.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); processBuffer(); });
    gunzip.on('end', () => {
      // If a file write is still in flight (fd.end not yet called back), wait for it.
      if (outFd) {
        const name = outName;
        const fd   = outFd;
        outFd = null; outName = null;
        fd.end(() => { extracted.push(name); resolve(extracted); });
      } else {
        resolve(extracted);
      }
    });
    gunzip.on('error', fail);
    input.on('error', fail);
    input.pipe(gunzip);
  });
}

// ── Platform targets ──────────────────────────────────────────────────────────
// Each target lists suffix+ext pairs to try in order.
// suffix: the part after "llama-bNNNN-bin-" in the filename
// ext:    ".tar.gz" for linux/mac, ".zip" for windows

const TARGETS = [
  {
    platform:   'linux',
    arch:       'x64',
    variants: [
      { suffix: 'ubuntu-x64',        ext: '.tar.gz' },
      { suffix: 'ubuntu-vulkan-x64', ext: '.tar.gz' },
    ],
    binInZip:   'llama-server',
    outName:    'llama-server-linux-x64',
    extractAll: true,
  },
  // linux-arm64: llama.cpp does not ship a prebuilt arm64 binary in GitHub releases.
  // Linux arm64 users (e.g. Raspberry Pi, Jetson) must build from source.
  // Leaving this entry out avoids a guaranteed 404 on every fetch run.
  {
    platform:   'darwin',
    arch:       'arm64',
    variants: [
      { suffix: 'macos-arm64', ext: '.tar.gz' },
    ],
    binInZip:   'llama-server',
    outName:    'llama-server-darwin-arm64',
    extractAll: true,
  },
  {
    platform:   'darwin',
    arch:       'x64',
    variants: [
      { suffix: 'macos-x64', ext: '.tar.gz' },
    ],
    binInZip:   'llama-server',
    outName:    'llama-server-darwin-x64',
    extractAll: true,
  },
  // Windows — Vulkan build (includes ggml-vulkan.dll, ggml-cpu-*.dll, ggml-rpc.dll etc.)
  // llama.cpp has changed release naming across versions:
  //   b4xxx-b6xxx: win-vulkan-x64
  //   b7xxx+:      win-vulkan-avx2-x64  (or win-avx2-x64 which includes vulkan backend)
  // We try all known variants in order; extractAll=true stages all DLLs alongside the binary.
  {
    platform:   'win32',
    arch:       'x64',
    variants: [
      { suffix: 'win-vulkan-x64',      ext: '.zip' },
      { suffix: 'win-vulkan-avx2-x64', ext: '.zip' },
      { suffix: 'win-avx2-x64',        ext: '.zip' },
      { suffix: 'win-avx-x64',         ext: '.zip' },
      { suffix: 'win-cpu-x64',         ext: '.zip' },
    ],
    binInZip:   'llama-server.exe',
    outName:    'llama-server-win32-x64.exe',
    extractAll: true,
  },
];

// Windows CUDA backend DLL — extracted separately from the CUDA release archive.
// llama-server.exe loads this dynamically at runtime if it exists in the same directory.
// CUDA runtime variants shared by ggml-cuda.dll and the cudart runtime entries
const CUDA_VARIANTS = [
  { suffix: 'win-cuda-12.4-x64', ext: '.zip' },
  { suffix: 'win-cuda-12.8-x64', ext: '.zip' },
  { suffix: 'win-cuda-12.2-x64', ext: '.zip' },
  { suffix: 'win-cuda-12.6-x64', ext: '.zip' },
];

const CUDA_DLL_TARGETS = [
  // ggml-cuda.dll — the CUDA compute backend for llama-server
  {
    variants: CUDA_VARIANTS,
    dllInZip: 'ggml-cuda.dll',
    outName:  'ggml-cuda.dll',
  },

  // CUDA runtime DLLs — required by ggml-cuda.dll at load time.
  // ggml-cuda.dll depends on cudart64_12.dll, cublas64_12.dll, cublasLt64_12.dll.
  // These are NOT included in the NVIDIA display driver — only the CUDA Toolkit.
  // Without them ggml-cuda.dll silently fails to load and llama-server falls to CPU.
  // Fetched from the separate cudart-llama release zip in llama.cpp CI.
  {
    variants:     CUDA_VARIANTS,
    dllInZip:     'cudart64_12.dll',
    outName:      'cudart64_12.dll',
    cudartPrefix: 'cudart-llama',
  },
  {
    variants:     CUDA_VARIANTS,
    dllInZip:     'cublas64_12.dll',
    outName:      'cublas64_12.dll',
    cudartPrefix: 'cudart-llama',
  },
  {
    variants:     CUDA_VARIANTS,
    dllInZip:     'cublasLt64_12.dll',
    outName:      'cublasLt64_12.dll',
    cudartPrefix: 'cudart-llama',
  },
];

/**
 * Extract ALL files from a .zip archive into destDir.
 * Skips directories and zero-byte files. Overwrites existing files.
 */
async function extractAllFilesFromZip(archivePath, destDir) {
  const fd       = fs.openSync(archivePath, 'r');
  const fileSize = fs.fstatSync(fd).size;

  // Find End of Central Directory
  const eocdBufSize = Math.min(65536 + 22, fileSize);
  const eocdBuf     = Buffer.alloc(eocdBufSize);
  fs.readSync(fd, eocdBuf, 0, eocdBufSize, fileSize - eocdBufSize);

  let eocdOffset = -1;
  for (let i = eocdBuf.length - 22; i >= 0; i--) {
    if (eocdBuf[i] === 0x50 && eocdBuf[i+1] === 0x4b && eocdBuf[i+2] === 0x05 && eocdBuf[i+3] === 0x06) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) { fs.closeSync(fd); throw new Error('ZIP: EOCD not found'); }

  const cdSize  = eocdBuf.readUInt32LE(eocdOffset + 12);
  const cdStart = eocdBuf.readUInt32LE(eocdOffset + 16);

  const cdBuf = Buffer.alloc(cdSize);
  fs.readSync(fd, cdBuf, 0, cdSize, cdStart);
  fs.closeSync(fd);

  // Walk Central Directory and extract each regular file
  let cdPos = 0;
  const extracted = [];
  while (cdPos < cdBuf.length) {
    if (cdBuf.readUInt32LE(cdPos) !== 0x02014b50) break;
    const compMethod  = cdBuf.readUInt16LE(cdPos + 10);
    const compSize    = cdBuf.readUInt32LE(cdPos + 20);
    const uncompSize  = cdBuf.readUInt32LE(cdPos + 24);
    const fnLen       = cdBuf.readUInt16LE(cdPos + 28);
    const extraLen    = cdBuf.readUInt16LE(cdPos + 30);
    const commentLen  = cdBuf.readUInt16LE(cdPos + 32);
    const localOffset = cdBuf.readUInt32LE(cdPos + 42);
    const entryName   = cdBuf.subarray(cdPos + 46, cdPos + 46 + fnLen).toString('utf8');
    cdPos += 46 + fnLen + extraLen + commentLen;

    // Skip directories and zero-byte files
    if (entryName.endsWith('/') || uncompSize === 0) continue;
    // Only extract .exe and .dll files (skip docs, etc.)
    const basename = entryName.split('/').pop();
    if (!basename.endsWith('.exe') && !basename.endsWith('.dll')) continue;

    const destPath = path.join(destDir, basename);

    // Read local file header to find data offset
    const lhBuf = Buffer.alloc(30);
    const lhFd  = fs.openSync(archivePath, 'r');
    fs.readSync(lhFd, lhBuf, 0, 30, localOffset);
    const lhFnLen    = lhBuf.readUInt16LE(26);
    const lhExtraLen = lhBuf.readUInt16LE(28);
    const dataOffset = localOffset + 30 + lhFnLen + lhExtraLen;

    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(archivePath, {
        start: dataOffset,
        end:   dataOffset + compSize - 1,
      });
      const outFd = fs.createWriteStream(destPath);
      const fail = (err) => { outFd.destroy(); reject(err); };
      outFd.on('finish', () => { fs.closeSync(lhFd); resolve(); });
      outFd.on('error', fail);
      input.on('error', fail);

      if (compMethod === 0) {
        input.pipe(outFd);
      } else if (compMethod === 8) {
        const inflate = zlib.createInflateRaw();
        inflate.on('error', fail);
        input.pipe(inflate).pipe(outFd);
      } else {
        reject(new Error(`Unsupported zip method: ${compMethod}`));
      }
    });

    extracted.push(basename);
  }

  return extracted;
}

// ── Main ──────────────────────────────────────────────────────────────────────

// ── Core fetch logic (exported for per-platform scripts) ─────────────────────

export async function fetchBinaries(targets, cudaTargets = []) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const version = vArg ?? await getLatestRelease();
  console.log(`\nFetching llama-server binaries from llama.cpp release: ${version}`);
  if (!process.env.GITHUB_TOKEN) {
    console.log('⚠️  GITHUB_TOKEN not set — unauthenticated requests (60/hr limit). If downloads 404, set GITHUB_TOKEN and retry.');
  }
  console.log('');

  for (const target of targets) {
    const outPath = path.join(BIN_DIR, target.outName);

    if (fs.existsSync(outPath)) {
      console.log(`✓  ${target.outName} (already present)`);
      continue;
    }

    console.log(`↓  ${target.outName}`);

    let downloaded = false;
    for (const { suffix, ext } of target.variants) {
      const archiveName = `llama-${version}-bin-${suffix}${ext}`;
      const url         = `https://github.com/ggml-org/llama.cpp/releases/download/${version}/${archiveName}`;
      const archiveDest = path.join(TMP_DIR, archiveName);

      console.log(`   trying: ${url}`);

      let result;
      try {
        result = await downloadFile(url, archiveDest);
      } catch (err) {
        console.error(`   ✗ Download error: ${err.message}`);
        continue;
      }

      if (result.status === 404) {
        console.log(`   ✗ 404 — trying next variant...`);
        continue;
      }

      try {
        if (target.extractAll) {
          const files = archiveDest.endsWith('.tar.gz')
            ? await extractAllFilesFromTarGz(archiveDest, BIN_DIR)
            : await extractAllFilesFromZip(archiveDest, BIN_DIR);
          console.log(`   extracted ${files.length} files: ${files.join(', ')}`);
          // Rename the server binary to our canonical name if needed
          const serverInBin = path.join(BIN_DIR, target.binInZip);
          if (fs.existsSync(serverInBin) && target.binInZip !== target.outName) {
            fs.renameSync(serverInBin, outPath);
          }
        } else {
          await extractSingleFile(archiveDest, target.binInZip, outPath);
        }
      } catch (err) {
        console.error(`   ✗ Extract failed: ${err.message}`);
        if (fs.existsSync(archiveDest)) fs.unlinkSync(archiveDest);
        if (fs.existsSync(outPath))     fs.unlinkSync(outPath);
        continue;
      }

      if (target.platform !== 'win32') {
        // chmod all extracted files — dylibs and the server binary all need execute/read
        for (const entry of fs.readdirSync(BIN_DIR)) {
          const p = path.join(BIN_DIR, entry);
          if (fs.statSync(p).isFile()) fs.chmodSync(p, 0o755);
        }
      }
      fs.unlinkSync(archiveDest);

      console.log(`   ✓  ${target.outName}`);
      downloaded = true;

      // ── Vulkan DLL recovery ────────────────────────────────────────────────
      // Some llama.cpp releases drop the Windows Vulkan build (e.g. b8457).
      // If ggml-vulkan.dll is missing after extractAll, walk back through
      // recent releases until we find one that has the vulkan zip.
      if (target.platform === 'win32' && target.extractAll) {
        const vulkanDll = path.join(BIN_DIR, 'ggml-vulkan.dll');
        if (!fs.existsSync(vulkanDll)) {
          console.log('   ⚠️  ggml-vulkan.dll not in this release — searching recent releases for Vulkan build...');
          const releasesRes  = await httpsGet('https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20');
          const releasesBody = await new Promise((res, rej) => { let b=''; releasesRes.on('data',d=>b+=d); releasesRes.on('end',()=>res(b)); releasesRes.on('error',rej); });
          const releases     = JSON.parse(releasesBody);
          let found = false;
          for (const rel of releases) {
            const tag = rel.tag_name;
            if (tag === version) continue; // already tried
            const vulkanUrl  = `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/llama-${tag}-bin-win-vulkan-x64.zip`;
            const vulkanDest = path.join(TMP_DIR, `llama-${tag}-bin-win-vulkan-x64.zip`);
            console.log(`   trying: ${vulkanUrl}`);
            let vResult;
            try { vResult = await downloadFile(vulkanUrl, vulkanDest); } catch { continue; }
            if (vResult.status === 404) { console.log(`   ✗ 404`); continue; }
            try {
              const files = await extractAllFilesFromZip(vulkanDest, BIN_DIR);
              const hasVulkan = files.includes('ggml-vulkan.dll');
              fs.unlinkSync(vulkanDest);
              if (hasVulkan) {
                console.log(`   ✓  ggml-vulkan.dll (from ${tag})`);
                found = true;
                break;
              }
            } catch { if (fs.existsSync(vulkanDest)) fs.unlinkSync(vulkanDest); }
          }
          if (!found) console.warn('   ⚠️  Could not find ggml-vulkan.dll in any recent release — Vulkan backend unavailable');
        }
      }

      break;
    }

    if (!downloaded) {
      console.error(`   ✗ All suffixes failed for ${target.outName}`);
    }
  }

  // ── CUDA backend DLL (Windows only) ─────────────────────────────────────────
  for (const cudaTarget of cudaTargets) {
    const outPath = path.join(BIN_DIR, cudaTarget.outName);

    if (fs.existsSync(outPath)) {
      console.log(`✓  ${cudaTarget.outName} (already present)`);
      continue;
    }

    console.log(`↓  ${cudaTarget.outName} (CUDA backend DLL)`);

    let downloaded = false;
    for (const { suffix, ext } of cudaTarget.variants) {
      // cudartPrefix targets use 'cudart-llama-bin-...' naming, not 'llama-...-bin-...'
      const prefix      = cudaTarget.cudartPrefix ? `${cudaTarget.cudartPrefix}-bin` : `llama-${version}-bin`;
      const archiveName = `${prefix}-${suffix}${ext}`;
      const url         = `https://github.com/ggml-org/llama.cpp/releases/download/${version}/${archiveName}`;
      const archiveDest = path.join(TMP_DIR, archiveName);

      // Reuse cached archive if a previous entry already downloaded it (avoids re-fetching
      // the 391 MB cudart zip for each of the three runtime DLLs it contains).
      if (!fs.existsSync(archiveDest)) {
        console.log(`   trying: ${url}`);
        let result;
        try {
          result = await downloadFile(url, archiveDest);
        } catch (err) {
          console.error(`   ✗ Download error: ${err.message}`);
          continue;
        }
        if (result.status === 404) {
          console.log(`   ✗ 404 — trying next variant...`);
          continue;
        }
      } else {
        console.log(`   reusing cached: ${archiveName}`);
      }

      try {
        await extractSingleFile(archiveDest, cudaTarget.dllInZip, outPath);
      } catch (err) {
        console.error(`   ✗ Extract failed: ${err.message}`);
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
        continue;
      }

      // Do NOT delete archiveDest here — other cudaTargets may reuse the same zip.
      // TMP_DIR is wiped at the end of fetchBinaries().
      console.log(`   ✓  ${cudaTarget.outName}`);
      downloaded = true;
      break;
    }

    if (!downloaded) {
      console.log(`   ⚠️  CUDA DLL not found — NVIDIA GPU offload will use Vulkan fallback`);
    }
  }

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log('\nDone. Binaries are in bin/');
}

// ── Standalone: fetch all platforms ─────────────────────────────────────────
// Only runs when this file is executed directly, not when imported.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  fetchBinaries(TARGETS, CUDA_DLL_TARGETS)
    .catch(err => { console.error(err.message); process.exit(1); });
}
