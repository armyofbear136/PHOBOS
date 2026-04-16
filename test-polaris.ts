/**
 * test-polaris.ts — Validates Polaris can start, index, and read the test music library.
 *
 * Run from dual-reasoning/:
 *   node --loader ts-node/esm --no-warnings test-polaris.ts
 *
 * Expects:
 *   - Polaris binary at ~/.phobos/services/polaris/polaris-cli.exe (Windows)
 *   - ./test-outputs/music exists and contains music files
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  startPolaris,
  stopPolaris,
  isBinaryPresent,
  resolveBinaryPath,
  getApiToken,
  POLARIS_PORT,
} from './services/PolarisManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUSIC_PATH = path.resolve(__dirname, 'test-outputs', 'music');
const BASE_URL   = `http://127.0.0.1:${POLARIS_PORT}`;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function apiGet(endpoint: string, token: string): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept-Version': '8' },
  });
  if (!res.ok) throw new Error(`GET ${endpoint} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiPost(endpoint: string, token: string): Promise<void> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Accept-Version': '8' },
  });
  if (!res.ok) throw new Error(`POST ${endpoint} → HTTP ${res.status}: ${await res.text()}`);
}

console.log('\n🎵 PHOBOS Polaris Validation Test');
console.log('─'.repeat(50));
console.log(`   Music path: ${MUSIC_PATH}`);
console.log(`   Port:       ${POLARIS_PORT}\n`);

// 1: Binary check
console.log('[ 1/8 ] Binary check...');
if (!isBinaryPresent()) {
  console.error(`❌ Not found: ${resolveBinaryPath()}`);
  console.error('   Run: node scripts/fetch-polaris.js');
  process.exit(1);
}
console.log(`   ✅ ${resolveBinaryPath()}`);

// 2: Start
console.log('\n[ 2/8 ] Starting Polaris...');
const t0 = Date.now();
try {
  await startPolaris({ adminPassword: 'phobos-test-pw', libraryPath: MUSIC_PATH, mountName: 'Test Music' });
} catch (err) {
  console.error(`❌ Start failed: ${(err as Error).message}`);
  process.exit(1);
}
console.log(`   ✅ Running on :${POLARIS_PORT} (${Date.now() - t0}ms)`);

// 3: Token
console.log('\n[ 3/8 ] Verifying Bearer token...');
let token: string;
try {
  token = await getApiToken();
  console.log(`   ✅ ${token.substring(0, 12)}…`);
} catch (err) {
  console.error(`❌ Auth failed: ${(err as Error).message}`);
  await stopPolaris(); process.exit(1);
}

// 4: Trigger index
console.log('\n[ 4/8 ] Triggering library index...');
try {
  await apiPost('/api/trigger/index', token);
  console.log('   ✅ Triggered');
} catch (err) {
  console.warn(`   ⚠️  ${(err as Error).message}`);
}

// 5: Poll for albums
console.log('\n[ 5/8 ] Polling for indexed content (up to 60s)...');
let albumCount = 0;
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  try {
    const r = await apiGet('/api/albums?random=false&offset=0&count=100', token) as any;
    const albums = r.albums ?? (Array.isArray(r) ? r : []);
    if (albums.length > 0) { albumCount = albums.length; break; }
  } catch { /* indexing */ }
  process.stdout.write('.');
  await sleep(2000);
}
process.stdout.write('\n');
console.log(albumCount > 0 ? `   ✅ ${albumCount} album(s) indexed` : '   ⚠️  No albums yet (index may still be running)');

// 6: Browse root
console.log('\n[ 6/8 ] Browsing library root...');
try {
  const b = await apiGet('/api/browse', token) as any;
  const dirs = b.directories ?? b.items ?? (Array.isArray(b) ? b : []);
  if (dirs.length > 0) {
    console.log(`   ✅ ${dirs.length} root entries:`);
    for (const d of dirs.slice(0, 8)) {
      const name = typeof d === 'string' ? path.basename(d) : (d.path ?? d.name ?? JSON.stringify(d));
      console.log(`      📁 ${name}`);
    }
    if (dirs.length > 8) console.log(`      … +${dirs.length - 8} more`);
  } else {
    console.warn(`   ⚠️  Empty. Raw: ${JSON.stringify(b).substring(0, 200)}`);
  }
} catch (err) { console.warn(`   ⚠️  ${(err as Error).message}`); }

// 7: Sample track
console.log('\n[ 7/8 ] Searching for sample track...');
let firstSong: any = null;
try {
  const r = await apiGet('/api/search/erra', token) as any;
  const songs = r.songs ?? (Array.isArray(r) ? r : []);
  if (songs.length > 0) {
    firstSong = songs[0];
    console.log('   ✅ Sample track:');
    console.log(`      Title:  ${firstSong.title  ?? '(no tag)'}`);
    console.log(`      Artist: ${firstSong.artist ?? '(no tag)'}`);
    console.log(`      Album:  ${firstSong.album  ?? '(no tag)'}`);
    console.log(`      Path:   ${firstSong.path   ?? firstSong.virtual_path ?? '(none)'}`);
  } else {
    console.warn(`   ⚠️  No results. Raw: ${JSON.stringify(r).substring(0, 200)}`);
  }
} catch (err) { console.warn(`   ⚠️  ${(err as Error).message}`); }

// 8: Audio endpoint probe
console.log('\n[ 8/8 ] Probing audio endpoint...');
if (firstSong) {
  try {
    const id  = firstSong.id ?? firstSong.path;
    const url = `${BASE_URL}/api/audio/${encodeURIComponent(id)}?auth_token=${token}`;
    const h   = await fetch(url, { method: 'HEAD' });
    if (h.ok || h.status === 206) {
      console.log(`   ✅ HTTP ${h.status} — ${h.headers.get('content-type') ?? 'unknown'}`);
    } else {
      console.warn(`   ⚠️  HTTP ${h.status}`);
    }
  } catch (err) { console.warn(`   ⚠️  ${(err as Error).message}`); }
} else {
  console.warn('   ⚠️  Skipped — no song found yet');
}

// console.log('\n⏹  Stopping Polaris...');
// // await stopPolaris();
// console.log('   ✅ Stopped');
// console.log('\n' + '─'.repeat(50));
// console.log('✅ Polaris validation complete.\n');
