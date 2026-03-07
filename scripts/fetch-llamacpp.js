#!/usr/bin/env node
// scripts/fetch-llamacpp.js
// Downloads pre-built llama-server binaries from the llama.cpp GitHub releases
// into the repo's bin/ directory. Run once before building.
//
//   node scripts/fetch-llamacpp.js
//   node scripts/fetch-llamacpp.js --version b5000   (pin a specific release tag)
//
// Platforms fetched:
//   linux-x64       llama-b{N}-bin-ubuntu-x64.zip       → llama-server-linux-x64
//   darwin-arm64    llama-b{N}-bin-macos-arm64.zip       → llama-server-darwin-arm64
//   darwin-x64      llama-b{N}-bin-macos-x64.zip         → llama-server-darwin-x64
//   win32-x64       llama-b{N}-bin-win-vulkan-x64.zip    → llama-server-win32-x64.exe
//
// Requires: curl and unzip (standard on macOS/Linux). On Windows, uses PowerShell.

import https  from 'node:https';
import fs     from 'node:fs';
import path   from 'node:path';
import zlib   from 'node:zlib';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR   = path.resolve(__dirname, '..', 'bin');
const TMP_DIR   = path.resolve(__dirname, '..', 'bin', '.tmp');

const args    = process.argv.slice(2);
const vArg    = args.find(a => a.startsWith('--version='))?.split('=')[1]
             ?? (args[args.indexOf('--version') + 1]);

// ── Helpers ───────────────────────────────────────────────────────────────────

// Headers required for GitHub API — User-Agent mandatory, Accept ensures JSON not redirect page.
const GH_HEADERS = {
  'User-Agent': 'phobos-fetch-llamacpp/1.0',
  'Accept':     'application/vnd.github+json',
};

function httpsGet(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 10) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(target);
      // Only send GitHub headers to api.github.com — not to S3/CDN redirects
      const isGithubApi = parsed.hostname === 'api.github.com';
      const headers = { ...(isGithubApi ? GH_HEADERS : {}), ...extraHeaders };
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
  if (res.statusCode === 404) return { status: 404 };
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
      if (state !== 'header' && !outFd) {
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

// ── Platform targets ──────────────────────────────────────────────────────────
// Each target lists suffix+ext pairs to try in order.
// suffix: the part after "llama-bNNNN-bin-" in the filename
// ext:    ".tar.gz" for linux/mac, ".zip" for windows

const TARGETS = [
  {
    platform: 'linux',
    arch:     'x64',
    variants: [
      { suffix: 'ubuntu-x64',        ext: '.tar.gz' },  // CPU — current naming
      { suffix: 'ubuntu-vulkan-x64', ext: '.tar.gz' },  // GPU/Vulkan variant
    ],
    binInZip: 'llama-server',
    outName:  'llama-server-linux-x64',
  },
  {
    platform: 'darwin',
    arch:     'arm64',
    variants: [
      { suffix: 'macos-arm64', ext: '.tar.gz' },
    ],
    binInZip: 'llama-server',
    outName:  'llama-server-darwin-arm64',
  },
  {
    platform: 'darwin',
    arch:     'x64',
    variants: [
      { suffix: 'macos-x64', ext: '.tar.gz' },
    ],
    binInZip: 'llama-server',
    outName:  'llama-server-darwin-x64',
  },
  {
    platform: 'win32',
    arch:     'x64',
    variants: [
      { suffix: 'win-vulkan-x64', ext: '.zip' },   // Vulkan — GPU capable, no extra DLLs needed
      { suffix: 'win-cpu-x64',    ext: '.zip' },   // CPU-only fallback
    ],
    binInZip: 'llama-server.exe',
    outName:  'llama-server-win32-x64.exe',
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(BIN_DIR,  { recursive: true });
  fs.mkdirSync(TMP_DIR,  { recursive: true });

  const version = vArg ?? await getLatestRelease();
  console.log(`\nFetching llama-server binaries from llama.cpp release: ${version}\n`);

  for (const target of TARGETS) {
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
        await extractSingleFile(archiveDest, target.binInZip, outPath);
      } catch (err) {
        console.error(`   ✗ Extract failed: ${err.message}`);
        if (fs.existsSync(archiveDest)) fs.unlinkSync(archiveDest);
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
        continue;
      }

      if (target.platform !== 'win32') fs.chmodSync(outPath, 0o755);
      fs.unlinkSync(archiveDest);

      console.log(`   ✓  ${target.outName}`);
      downloaded = true;
      break;
    }

    if (!downloaded) {
      console.error(`   ✗ All suffixes failed for ${target.outName}`);
    }
  }

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log('\nDone. Binaries are in bin/');
  console.log('Commit bin/ to your repo, or add it to your CI pre-build step.');
}

main().catch(err => { console.error(err.message); process.exit(1); });
