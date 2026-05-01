#!/usr/bin/env node
// scripts/fetch-phobos-host.js — Download + install the PhobosHost binary
// from the Autarch GitHub release.
//
// PhobosHost is the in-house VST3 host that replaces Carla. Distributed as
// a single executable per platform (no DLLs — JUCE is statically linked).
//
// **NOTE:** This file exists as a REFERENCE shape for DepPrep integration.
// The active deps system (DepPrep) is under live development; once it is
// ready, the logic here will fold into DepPrep proper. Don't wire this into
// boot directly — it's a template, not a runtime dependency.
//
// Layout:
//   download:   PhobosHost-<platform>.zip
//   extracts to:  ~/.phobos/services/host/PhobosHost(.exe)
//
// Idempotent via a marker file recording the upstream etag/last-modified.
// Force a refresh: delete the marker, or pass --force.

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

// Per-platform release artifact. The release-side is responsible for naming
// these exactly. Update in lockstep with the publish step.
//
// win-x64 ships as a flat .zip. Mac/Linux ship as .tar.gz to preserve
// executable bit + symlinks (matching how every other platform-specific dep
// in DepPrep is packaged).
const PLATFORM_ASSET = {
  win32:  'PhobosHost-win-x64.zip',
  darwin: process.arch === 'arm64'
    ? 'PhobosHost-darwin-arm64.tar.gz'
    : 'PhobosHost-darwin-x64.tar.gz',
  linux:  process.arch === 'arm64'
    ? 'PhobosHost-linux-arm64.tar.gz'
    : 'PhobosHost-linux-x64.tar.gz',
};

const RELEASE_TAG  = 'PHOBOS-DEPS';
const ASSET_NAME   = PLATFORM_ASSET[process.platform];
if (!ASSET_NAME) {
  console.error(`[fetch-phobos-host] unsupported platform: ${process.platform}`);
  process.exit(1);
}

const HOST_URL    = `https://github.com/armyofbear136/PHOBOS-BUILDS/releases/download/${RELEASE_TAG}/${ASSET_NAME}`;

const HOST_DIR = path.join(os.homedir(), '.phobos', 'services', 'phobos-host');
const TMP_DIR      = path.join(HOST_DIR, '.tmp-host');
const ZIP_PATH     = path.join(TMP_DIR, ASSET_NAME);
const MARKER_FILE  = path.join(HOST_DIR, '.phobos-host-marker');

const BINARY_NAME  = process.platform === 'win32' ? 'PhobosHost.exe' : 'PhobosHost';
const BINARY_DEST  = path.join(HOST_DIR, BINARY_NAME);

// ── HTTP helpers (mirrors fetch-crystal.js) ─────────────────────────────────

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 10) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(target);
      https.get(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search,
          headers: { 'User-Agent': 'phobos-fetch-host/1.0', ...headers } },
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

async function fetchHeaders(url) {
  const res = await httpsGet(url);
  res.resume();
  return { status: res.statusCode, headers: res.headers };
}

async function download(url, destPath) {
  const existing = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
  const headers  = existing > 0 ? { Range: `bytes=${existing}-` } : {};

  if (existing > 0) console.log(`📥 Resuming PhobosHost from ${(existing / 1e6).toFixed(1)} MB…`);
  else              console.log(`📥 Downloading PhobosHost from ${url}`);

  const res = await httpsGet(url, headers);
  if (res.statusCode === 404) throw new Error(`404 — PhobosHost release not found.\n   ${url}`);
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

  fs.mkdirSync(HOST_DIR, { recursive: true });

  if (!force && fs.existsSync(BINARY_DEST) && fs.existsSync(MARKER_FILE)) {
    try {
      const { headers, status } = await fetchHeaders(HOST_URL);
      if (status === 200 || status === 206) {
        const upstream = buildMarker(headers);
        const cached   = fs.readFileSync(MARKER_FILE, 'utf8').trim();
        if (upstream === cached) {
          console.log(`[fetch-phobos-host] PhobosHost already up-to-date (marker match)`);
          return;
        }
        console.log(`[fetch-phobos-host] Upstream changed — redeploying`);
      }
    } catch (err) {
      console.log(`[fetch-phobos-host] Marker check failed (${err.message}) — proceeding with fresh download`);
    }
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });
  await download(HOST_URL, ZIP_PATH);

  const STAGING = path.join(TMP_DIR, 'extracted');
  rmrf(STAGING);
  fs.mkdirSync(STAGING, { recursive: true });
  console.log(`📦 Extracting PhobosHost…`);
  await extractZip(ZIP_PATH, STAGING);

  const extractedBinary = path.join(STAGING, BINARY_NAME);
  if (!fs.existsSync(extractedBinary)) {
    throw new Error(`Expected ${BINARY_NAME} inside zip, not found at ${extractedBinary}`);
  }

  rmrf(BINARY_DEST);
  fs.renameSync(extractedBinary, BINARY_DEST);

  // Unix: ensure executable bit. Windows handles this via the .exe extension.
  if (process.platform !== 'win32') {
    fs.chmodSync(BINARY_DEST, 0o755);
  }

  try {
    const { headers } = await fetchHeaders(HOST_URL);
    fs.writeFileSync(MARKER_FILE, buildMarker(headers));
  } catch {
    // Best-effort marker write.
  }

  rmrf(TMP_DIR);

  console.log(`✅ PhobosHost deployed → ${BINARY_DEST}`);
}

main().catch((err) => {
  console.error(`[fetch-phobos-host] FAILED:`, err.message);
  process.exitCode = 1;
});
