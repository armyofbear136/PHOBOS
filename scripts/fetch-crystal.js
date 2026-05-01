#!/usr/bin/env node
// scripts/fetch-crystal.js — Download + extract the PhobosCrystal VST3 from
// the Autarch GitHub release.
//
// Crystal is an Autarch-proprietary VST3 effect distributed as a release
// artifact (not committed to git — the unpacked bundle is ~120 MB). The
// release URL is a fixed redirect; bumping the Crystal version is done by
// re-tagging on the PHOBOS-BUILDS side, this script always fetches LATEST.
//
// Layout:
//   download:   PhobosCrystal.vst3.zip                     (compressed bundle)
//   extracts to:  ~/.phobos/services/carla/plugins/PhobosCrystal.vst3/   (full VST3 bundle)
//
// Idempotent via a small marker file recording the URL's last-modified
// header. If the marker matches the current upstream marker, no work is done.
// Forcing a refresh: delete the marker file, or pass --force.

import fs           from 'node:fs';
import https        from 'node:https';
import path         from 'node:path';
import os           from 'node:os';
import { execFile, exec } from 'node:child_process';
import { promisify }      from 'node:util';
import { fileURLToPath }  from 'node:url';

const execFileAsync = promisify(execFile);
const execAsync     = promisify(exec);
const __dirname     = path.dirname(fileURLToPath(import.meta.url));

const CRYSTAL_URL = 'https://github.com/armyofbear136/PHOBOS-BUILDS/releases/download/PHOBOS-DEPS/PhobosCrystal.vst3.zip';

// Crystal lives in PhobosHost's plugins dir — the host's PluginScanner
// discovers VST3 bundles here on first scan. (Legacy carla path retired
// in Session 6 with the PhobosHost migration.)
const PLUGINS_DIR  = path.join(os.homedir(), '.phobos', 'services', 'phobos-host', 'plugins');
const DEST_BUNDLE  = path.join(PLUGINS_DIR, 'PhobosCrystal.vst3');
const TMP_DIR      = path.join(PLUGINS_DIR, '.tmp-crystal');
const ZIP_PATH     = path.join(TMP_DIR, 'PhobosCrystal.vst3.zip');
const MARKER_FILE  = path.join(PLUGINS_DIR, '.phobos-crystal-marker');

// ── HTTP helpers (mirrors fetch-carla.js conventions) ───────────────────────

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 10) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(target);
      https.get(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search,
          headers: { 'User-Agent': 'phobos-fetch-crystal/1.0', ...headers } },
        res => {
          if ([301, 302, 307, 308].includes(res.statusCode)) {
            follow(res.headers.location, hops + 1);
            return;
          }
          resolve(res);
        }
      ).on('error', reject);
    };
    follow(url);
  });
}

/** HEAD-equivalent: fetch and discard body, returning headers. Used for marker check. */
async function fetchHeaders(url) {
  const res = await httpsGet(url);
  res.resume();                                   // discard body
  return { status: res.statusCode, headers: res.headers };
}

async function download(url, destPath) {
  const existing = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
  const headers  = existing > 0 ? { Range: `bytes=${existing}-` } : {};

  if (existing > 0) console.log(`📥 Resuming Crystal from ${(existing / 1e6).toFixed(1)} MB…`);
  else              console.log(`📥 Downloading Crystal from ${url}`);

  const res = await httpsGet(url, headers);
  if (res.statusCode === 404) throw new Error(`404 — Crystal release not found.\n   ${url}`);
  if (res.statusCode !== 200 && res.statusCode !== 206) throw new Error(`HTTP ${res.statusCode}`);

  const contentLen = parseInt(res.headers['content-length'] ?? '0', 10);
  const totalBytes = res.statusCode === 206 ? existing + contentLen : contentLen;

  await new Promise((resolve, reject) => {
    const tmpPath = destPath + '.download';
    const fd      = fs.createWriteStream(tmpPath, { flags: existing > 0 ? 'a' : 'w' });
    let received  = existing;
    res.on('data', chunk => {
      received += chunk.length;
      if (totalBytes > 0) {
        const pct = (received / totalBytes * 100).toFixed(1);
        process.stdout.write(`\r   ${pct}%  (${(received / 1e6).toFixed(1)} / ${(totalBytes / 1e6).toFixed(1)} MB)`);
      }
    });
    res.pipe(fd);
    fd.on('finish', () => {
      fd.close();
      fs.renameSync(tmpPath, destPath);
      process.stdout.write('\n');
      resolve();
    });
    fd.on('error', reject);
  });
}

async function extractZip(archivePath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  if (process.platform === 'win32') {
    // PowerShell Expand-Archive is bundled on Windows 10+.
    await execAsync(`powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${outDir}' -Force"`);
  } else {
    await execFileAsync('unzip', ['-oq', archivePath, '-d', outDir]);
  }
}

// ── Filesystem helpers ──────────────────────────────────────────────────────

function rmrf(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
}

/**
 * Read the upstream "marker" — etag preferred, falling back to last-modified,
 * falling back to content-length. Any of these change → re-deploy.
 */
function buildMarker(headers) {
  return [
    headers['etag']           ?? '',
    headers['last-modified']  ?? '',
    headers['content-length'] ?? '',
  ].join('|');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const force = process.argv.includes('--force');

  fs.mkdirSync(PLUGINS_DIR, { recursive: true });

  // Idempotency check via upstream marker.
  if (!force && fs.existsSync(DEST_BUNDLE) && fs.existsSync(MARKER_FILE)) {
    try {
      const { headers, status } = await fetchHeaders(CRYSTAL_URL);
      if (status === 200 || status === 206) {
        const upstream = buildMarker(headers);
        const cached   = fs.readFileSync(MARKER_FILE, 'utf8').trim();
        if (upstream === cached) {
          console.log(`[fetch-crystal] Crystal already up-to-date (marker match)`);
          return;
        }
        console.log(`[fetch-crystal] Upstream changed — redeploying`);
      }
    } catch (err) {
      console.log(`[fetch-crystal] Marker check failed (${err.message}) — proceeding with fresh download`);
    }
  }

  // Download to a tmp dir then extract.
  fs.mkdirSync(TMP_DIR, { recursive: true });
  await download(CRYSTAL_URL, ZIP_PATH);

  // Replace the existing bundle atomically: extract to tmp/extracted, then
  // swap. Avoids a window where DEST_BUNDLE is partially populated.
  const STAGING = path.join(TMP_DIR, 'extracted');
  rmrf(STAGING);
  fs.mkdirSync(STAGING, { recursive: true });
  console.log(`📦 Extracting Crystal VST3…`);
  await extractZip(ZIP_PATH, STAGING);

  // Zip layout: STAGING/PhobosCrystal.vst3/Contents/...
  const extractedBundle = path.join(STAGING, 'PhobosCrystal.vst3');
  if (!fs.existsSync(extractedBundle)) {
    throw new Error(`Expected PhobosCrystal.vst3 inside zip, not found at ${extractedBundle}`);
  }

  rmrf(DEST_BUNDLE);
  fs.renameSync(extractedBundle, DEST_BUNDLE);

  // Save the marker so subsequent runs are no-ops.
  try {
    const { headers } = await fetchHeaders(CRYSTAL_URL);
    fs.writeFileSync(MARKER_FILE, buildMarker(headers));
  } catch {
    // Marker write is best-effort — if upstream HEAD fails after a successful
    // download we just won't be idempotent next run.
  }

  // Cleanup tmp.
  rmrf(TMP_DIR);

  console.log(`✅ Crystal deployed → ${DEST_BUNDLE}`);
}

main().catch((err) => {
  console.error(`[fetch-crystal] FAILED:`, err.message);
  process.exitCode = 1;
});
