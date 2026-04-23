#!/usr/bin/env node
// scripts/fetch-stirling.js — Download Stirling PDF server jar for PHOBOS.
//
// Downloads Stirling-PDF-server.jar — the headless Spring Boot server that
// PHOBOS embeds via iframe. The server jar runs on all platforms (Windows,
// Linux, macOS) with Java 21+ on PATH.
//
// The platform-native desktop apps (.msi, .dmg) are NOT used here — they
// are Tauri GUI applications that open a window, not a web server.
//
//   node scripts/fetch-stirling.js
//   node scripts/fetch-stirling.js --check   (check only, no download)
//
// Requires: Java 21+ on PATH (https://adoptium.net)
// Destination: ~/.phobos/services/stirling/Stirling-PDF-server.jar

import fs    from 'node:fs';
import https from 'node:https';
import http  from 'node:http';
import path  from 'node:path';
import os    from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

// ── Release version ───────────────────────────────────────────────────────────
// Keep in sync with StirlingManager.ts isBinaryPresent() size gate.
const STIRLING_VERSION = '2.9.2';
const GH_BASE = `https://github.com/Stirling-Tools/Stirling-PDF/releases/download/v${STIRLING_VERSION}`;

// ── Asset ─────────────────────────────────────────────────────────────────────
// Stirling-PDF-server.jar — headless Spring Boot server, works on all platforms.
// ~100 MB. Requires Java 21+.
const SERVER_JAR_URL  = `${GH_BASE}/Stirling-PDF-server.jar`;
const SERVER_JAR_FILE = 'Stirling-PDF-server.jar';
const SERVER_JAR_MIN_BYTES = 50_000_000; // sanity floor; real jar is ~100 MB

// ── Destination ───────────────────────────────────────────────────────────────
const DEST_DIR  = path.join(os.homedir(), '.phobos', 'services', 'stirling');
const DEST_PATH = path.join(DEST_DIR, SERVER_JAR_FILE);

// ── CLI flags ─────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const checkOnly = args.includes('--check');

// ── Java version check ────────────────────────────────────────────────────────

async function checkJava() {
  try {
    const { stderr } = await execFileAsync('java', ['-version'], { timeout: 5_000 });
    const line  = (stderr ?? '').split('\n')[0] ?? '';
    const match = line.match(/version "(\d+)/);
    const major = match ? parseInt(match[1], 10) : 0;
    return { ok: major >= 21, version: line.trim(), major };
  } catch {
    return { ok: false, version: '', major: 0 };
  }
}

// ── HTTPS/HTTP fetch with redirect following ──────────────────────────────────

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 10) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(target);
      const mod    = parsed.protocol === 'https:' ? https : http;
      const req    = mod.get(
        {
          hostname: parsed.hostname,
          port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path:     parsed.pathname + parsed.search,
          headers:  { 'User-Agent': 'phobos-fetch-stirling/1.0', ...headers },
        },
        res => {
          if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            follow(res.headers.location, hops + 1);
            return;
          }
          resolve(res);
        }
      );
      req.on('error', reject);
    };
    follow(url);
  });
}

async function downloadFile(url, destPath) {
  const tmpPath  = destPath + '.download';
  const existing = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
  const headers  = existing > 0 ? { Range: `bytes=${existing}-` } : {};

  if (existing > 0) {
    process.stdout.write(`   Resuming from ${(existing / 1e6).toFixed(1)} MB…\n`);
  }

  const res = await httpsGet(url, headers);
  if (res.statusCode === 404) throw new Error(`404 — Asset not found: ${url}`);
  if (res.statusCode !== 200 && res.statusCode !== 206) {
    throw new Error(`HTTP ${res.statusCode} for ${url}`);
  }

  const totalFromHeader = parseInt(res.headers['content-length'] ?? '0', 10);
  const totalBytes      = res.statusCode === 206 ? existing + totalFromHeader : totalFromHeader;

  await new Promise((resolve, reject) => {
    const fd     = fs.createWriteStream(tmpPath, { flags: existing > 0 ? 'a' : 'w' });
    let received = existing;
    res.on('data', chunk => {
      received += chunk.length;
      if (!fd.write(chunk)) { res.pause(); fd.once('drain', () => res.resume()); }
      if (totalBytes > 0) {
        process.stdout.write(
          `\r   ${Math.round(received / totalBytes * 100)}%  ${(received / 1e6).toFixed(1)} / ${(totalBytes / 1e6).toFixed(1)} MB`
        );
      }
    });
    res.on('end',   () => fd.end());
    fd.on('finish', () => { if (totalBytes > 0) process.stdout.write('\n'); resolve(); });
    fd.on('error',  reject);
    res.on('error', reject);
  });

  fs.renameSync(tmpPath, destPath);
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

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n📄 Stirling PDF Fetch for PHOBOS');
console.log('─'.repeat(52));
console.log(`   Version:     ${STIRLING_VERSION} (server jar)`);
console.log(`   Destination: ${DEST_PATH}`);

// Java check — always run it, even for --check
const java = await checkJava();
if (java.ok) {
  console.log(`   Java:        ✅ ${java.version}`);
} else {
  console.log(`   Java:        ⚠️  ${java.version || 'not found'}`);
  console.log(`   Java 21+ is required to run Stirling PDF.`);
  console.log(`   Install from: https://adoptium.net`);
  if (checkOnly) process.exit(1);
  // Non-fatal for download — user may install Java later.
}

// Check-only mode
if (checkOnly) {
  const present = fs.existsSync(DEST_PATH) && fs.statSync(DEST_PATH).size >= SERVER_JAR_MIN_BYTES;
  if (present) {
    console.log(`\n✅ Stirling-PDF-server.jar is present (${(fs.statSync(DEST_PATH).size / 1e6).toFixed(1)} MB)`);
    if (!java.ok) console.log(`   ⚠️  Java 21+ not found — required to run.`);
  } else {
    console.log(`\n❌ Stirling-PDF-server.jar not found.`);
    console.log(`   Run: node scripts/fetch-stirling.js`);
  }
  process.exit(present ? 0 : 1);
}

// Fast path — already present and valid size
if (fs.existsSync(DEST_PATH) && fs.statSync(DEST_PATH).size >= SERVER_JAR_MIN_BYTES) {
  const size = fs.statSync(DEST_PATH).size;
  console.log(`\n✅ Stirling-PDF-server.jar already present (${(size / 1e6).toFixed(1)} MB)`);
  if (!java.ok) {
    console.log(`\n⚠️  Java 21+ not found on PATH.`);
    console.log(`   Install from: https://adoptium.net`);
    console.log(`   Stirling PDF will not start until Java is available.`);
  } else {
    console.log(`   Enable in PHOBOS → CREATE → Text → PDF.\n`);
  }
  process.exit(0);
}

fs.mkdirSync(DEST_DIR, { recursive: true });

console.log(`\n📥 Downloading Stirling PDF ${STIRLING_VERSION} server jar…`);
console.log(`   ${SERVER_JAR_URL}`);

try {
  await downloadFile(SERVER_JAR_URL, DEST_PATH);
} catch (err) {
  console.error(`\n❌ Download failed: ${err.message}`);
  process.exit(1);
}

// Verify size
const finalSize = fs.statSync(DEST_PATH).size;
if (finalSize < SERVER_JAR_MIN_BYTES) {
  console.error(`❌ Downloaded file too small (${(finalSize / 1e6).toFixed(1)} MB) — may be corrupt.`);
  process.exit(1);
}

const sha = await sha256(DEST_PATH);
console.log(`✅ Stirling PDF ${STIRLING_VERSION} server jar ready`);
console.log(`   Size:   ${(finalSize / 1e6).toFixed(1)} MB`);
console.log(`   SHA256: ${sha}`);

if (!java.ok) {
  console.log(`\n⚠️  Java 21+ not found on PATH.`);
  console.log(`   Install from: https://adoptium.net`);
  console.log(`   Stirling PDF will not start until Java is on PATH.`);
} else {
  console.log(`\n✅ Ready. Enable in PHOBOS → CREATE → Text → PDF.\n`);
}
