#!/usr/bin/env node
// scripts/fetch-vss-extension.js — Download the DuckDB vss extension
//
// Downloads vss.duckdb_extension from the official DuckDB extension CDN into
// phobos/extensions/{version}/{platform}/ so it gets staged into dist/ on every
// build and DatabaseManager can find it without touching ~/.duckdb/.
//
// The extension is platform-specific (contains native code) but version-pinned.
// One file per platform, downloaded once, committed to bin-master/.
//
// Called automatically by master-sync.js and build-full.js when missing.
// Can also be run standalone:
//
//   node scripts/fetch-vss-extension.js

import fs           from 'node:fs';
import https        from 'node:https';
import crypto       from 'node:crypto';
import path         from 'node:path';
import zlib         from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');

// ── Platform mapping ──────────────────────────────────────────────────────────
// DuckDB CDN platform strings: https://extensions.duckdb.org/{version}/{platform}/
const PLATFORM_MAP = {
  'win32-x64':   'windows_amd64',
  'darwin-arm64':'osx_arm64',
  'darwin-x64':  'osx_amd64',
  'linux-x64':   'linux_amd64',
  'linux-arm64': 'linux_arm64',
};

function getDuckDbPlatform() {
  // Allow master-sync to override when fetching for all platforms
  const override = process.env.PHOBOS_OVERRIDE_PLATFORM;
  if (override && PLATFORM_MAP[override]) return PLATFORM_MAP[override];

  const p = process.platform;
  const a = process.arch;
  if (p === 'win32'  && a === 'x64')   return 'windows_amd64';
  if (p === 'darwin' && a === 'arm64') return 'osx_arm64';
  if (p === 'darwin' && a === 'x64')   return 'osx_amd64';
  if (p === 'linux'  && a === 'x64')   return 'linux_amd64';
  if (p === 'linux'  && a === 'arm64') return 'linux_arm64';
  throw new Error(`Unsupported platform for VSS extension: ${p}/${a}`);
}

// Read duckdb version from package.json — must stay in sync.
function getDuckDbVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return pkg.dependencies?.duckdb ?? pkg.dependencies?.['duckdb-async']?.replace(/[^0-9.]/g, '') ?? '1.4.4';
}

const DUCKDB_VERSION = getDuckDbVersion();
const PLATFORM       = getDuckDbPlatform();

// Extension is stored at the path DuckDB expects when extension_directory is set:
//   {extension_directory}/v{version}/{platform}/vss.duckdb_extension
// We use phobos/extensions/ as the extension_directory root.
const EXT_ROOT  = path.join(ROOT, 'phobos', 'extensions');
const EXT_SUBDIR = path.join(EXT_ROOT, `v${DUCKDB_VERSION}`, PLATFORM);
const EXT_FILE  = path.join(EXT_SUBDIR, 'vss.duckdb_extension');
const TMP_FILE  = EXT_FILE + '.download';

// DuckDB extension CDN — primary URL. Falls back to compressed .gz variant.
// VSS is a community extension — hosted at community-extensions.duckdb.org,
// not the core extensions.duckdb.org domain.
const COMMUNITY_BASE  = `https://community-extensions.duckdb.org/v${DUCKDB_VERSION}/${PLATFORM}`;
const CORE_BASE       = `https://extensions.duckdb.org/v${DUCKDB_VERSION}/${PLATFORM}`;
const CANDIDATE_URLS  = [
  `${COMMUNITY_BASE}/vss.duckdb_extension`,
  `${COMMUNITY_BASE}/vss.duckdb_extension.gz`,
  `${CORE_BASE}/vss.duckdb_extension`,
  `${CORE_BASE}/vss.duckdb_extension.gz`,
];

// Minimum sane size — actual file is ~2-8 MB depending on platform.
const EXPECTED_MIN_BYTES = 500_000;

// ── Helpers ───────────────────────────────────────────────────────────────────
async function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 10) { reject(new Error('Too many redirects')); return; }
      const parsed = new URL(target);
      https.get(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search,
          headers: { 'User-Agent': 'phobos-fetch-vss/1.0' } },
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

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end',  () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────

console.log('\n🔌 DuckDB VSS Extension Fetch');
console.log(`   Version:  ${DUCKDB_VERSION}`);
console.log(`   Platform: ${PLATFORM}`);
console.log('─'.repeat(56));

fs.mkdirSync(EXT_SUBDIR, { recursive: true });

// Fast-path: already present and large enough
if (fs.existsSync(EXT_FILE)) {
  const size = fs.statSync(EXT_FILE).size;
  if (size >= EXPECTED_MIN_BYTES) {
    console.log(`✅ Already present (${(size / 1e6).toFixed(2)} MB) — nothing to do.`);
    console.log(`   ${path.relative(ROOT, EXT_FILE)}`);
    process.exit(0);
  }
  console.log(`⚠️  Existing file too small (${(size / 1e6).toFixed(2)} MB) — re-downloading.`);
  fs.unlinkSync(EXT_FILE);
}

// Try each candidate URL in order — community CDN first, core CDN fallback.
// gz variants are decompressed on the fly via zlib.createGunzip().
let succeeded = false;

for (const url of CANDIDATE_URLS) {
  const isGz = url.endsWith('.gz');
  console.log(`📥 Trying: ${url}`);

  let res;
  try {
    res = await httpsGet(url);
  } catch (err) {
    console.log(`   ✗ Connection failed: ${err.message}`);
    continue;
  }

  if (res.statusCode === 404) {
    console.log(`   ✗ 404`);
    continue;
  }
  if (res.statusCode !== 200 && res.statusCode !== 206) {
    console.log(`   ✗ HTTP ${res.statusCode}`);
    continue;
  }

  // Stream download, decompress gz if needed
  const totalFromHeader = parseInt(res.headers['content-length'] ?? '0', 10);
  const TMP = EXT_FILE + '.download';

  try {
    await new Promise((resolve, reject) => {
      const fd     = fs.createWriteStream(TMP, { flags: 'w' });
      const source = isGz ? res.pipe(zlib.createGunzip()) : res;
      let received = 0;

      source.on('data', (chunk) => {
        received += chunk.length;
        if (!fd.write(chunk)) { source.pause?.(); fd.once('drain', () => source.resume?.()); }
        if (totalFromHeader > 0 && !isGz) {
          process.stdout.write(`\r   ${Math.round(received / totalFromHeader * 100)}%  ${(received / 1e6).toFixed(1)} MB`);
        } else {
          process.stdout.write(`\r   ${(received / 1e6).toFixed(1)} MB received`);
        }
      });
      source.on('end',    () => { fd.end(); });
      source.on('error',  reject);
      fd.on('finish', () => { process.stdout.write('\n'); resolve(); });
      fd.on('error',  reject);
    });
  } catch (err) {
    console.log(`   ✗ Download error: ${err.message}`);
    try { fs.unlinkSync(TMP); } catch {}
    continue;
  }

  // Verify size
  const finalSize = fs.statSync(TMP).size;
  if (finalSize < EXPECTED_MIN_BYTES) {
    console.log(`   ✗ File too small after download (${(finalSize / 1e6).toFixed(2)} MB) — corrupt or wrong format`);
    try { fs.unlinkSync(TMP); } catch {}
    continue;
  }

  // Success — move into place
  fs.renameSync(TMP, EXT_FILE);
  succeeded = true;

  const sha = await sha256File(EXT_FILE);
  console.log(`✅ vss.duckdb_extension`);
  console.log(`   Source: ${url}`);
  console.log(`   Size:   ${(finalSize / 1e6).toFixed(2)} MB`);
  console.log(`   SHA256: ${sha}`);
  console.log(`   Path:   ${path.relative(ROOT, EXT_FILE)}`);
  console.log('\n✅ VSS extension ready. Run npm run build:full to bundle it into dist/.\n');
  break;
}

if (!succeeded) {
  console.error(`\n❌ Could not download VSS extension from any source.`);
  console.error(`   Tried ${CANDIDATE_URLS.length} URLs:`);
  for (const u of CANDIDATE_URLS) console.error(`     ${u}`);
  console.error(`\n   Manual option: download from https://github.com/duckdb/duckdb_vss/releases`);
  console.error(`   and place the .duckdb_extension file at:`);
  console.error(`   ${EXT_FILE}`);
  process.exit(1);
}
