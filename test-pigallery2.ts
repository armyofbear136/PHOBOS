/**
 * test-pigallery2.ts — Validates PiGallery2 can start, serve the API, and stop cleanly.
 *
 * Run from dual-reasoning/:
 *   node --loader ts-node/esm --no-warnings test-pigallery2.ts
 *
 * Expects:
 *   - PiGallery2 installed at ~/.phobos/services/pigallery2/ (run fetch-pigallery2.js first)
 *   - A library path on disk — defaults to ~/Pictures or ~/phobos-test-photos
 */

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  startPiGallery,
  stopPiGallery,
  isBinaryPresent,
  getPiGalleryStatus,
  resolveEntryPoint,
  getInstalledVersion,
  triggerIndexing,
  PIGALLERY_PORT,
} from './services/PiGalleryManager.js';

const BASE_URL = `http://127.0.0.1:${PIGALLERY_PORT}`;

// Use ~/Pictures if it exists, otherwise create a test dir.
const DEFAULT_LIBRARY = fs.existsSync(path.join(os.homedir(), 'Pictures'))
  ? path.join(os.homedir(), 'Pictures')
  : path.join(os.homedir(), 'phobos-test-photos');

const LIBRARY_PATH = process.env.PHOBOS_TEST_LIBRARY ?? DEFAULT_LIBRARY;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

console.log('\n🖼️  PHOBOS PiGallery2 Validation Test');
console.log('─'.repeat(50));
console.log(`   Library:  ${LIBRARY_PATH}`);
console.log(`   Port:     ${PIGALLERY_PORT}\n`);

// Ensure test library path exists.
fs.mkdirSync(LIBRARY_PATH, { recursive: true });

// ── 1: Binary check ───────────────────────────────────────────────────────────

console.log('[ 1/6 ] Installation check…');
if (!isBinaryPresent()) {
  console.error(`❌ PiGallery2 not found at: ${resolveEntryPoint()}`);
  console.error('   Run: node scripts/fetch-pigallery2.js');
  process.exit(1);
}
const version = getInstalledVersion();
console.log(`   ✅ v${version ?? 'unknown'} — ${resolveEntryPoint()}`);

// ── 2: Status before start ────────────────────────────────────────────────────

console.log('\n[ 2/6 ] Pre-start status check…');
const statusBefore = getPiGalleryStatus();
if (statusBefore.state !== 'stopped') {
  console.error(`❌ Expected state=stopped, got: ${statusBefore.state}`);
  process.exit(1);
}
console.log(`   ✅ state=${statusBefore.state}, binaryPresent=${statusBefore.binaryPresent}`);

// ── 3: Start ──────────────────────────────────────────────────────────────────

console.log('\n[ 3/6 ] Starting PiGallery2…');
const t0 = Date.now();
try {
  await startPiGallery({ libraryPath: LIBRARY_PATH });
} catch (err) {
  console.error(`❌ Start failed: ${(err as Error).message}`);
  const s = getPiGalleryStatus();
  if (s.error) console.error(`   Error detail: ${s.error}`);
  process.exit(1);
}
console.log(`   ✅ Running on :${PIGALLERY_PORT} (${Date.now() - t0}ms)`);

// ── 4: HTTP probe ─────────────────────────────────────────────────────────────

console.log('\n[ 4/6 ] HTTP probe…');
await sleep(500); // Give PiGallery2 a moment to finish initialising routes.

let rootOk = false;
let albumOk = false;

try {
  const res = await fetch(BASE_URL);
  rootOk = res.status === 200;
  console.log(`   GET / → HTTP ${res.status} ${rootOk ? '✅' : '❌'}`);
} catch (err) {
  console.error(`   ❌ GET / failed: ${(err as Error).message}`);
}

try {
  const res = await fetch(`${BASE_URL}/api/album/root`);
  albumOk = res.status === 200;
  const body = albumOk ? await res.json() : null;
  console.log(`   GET /api/album/root → HTTP ${res.status} ${albumOk ? '✅' : '❌'}`);
  if (body) console.log(`   Response keys: ${Object.keys(body as object).join(', ')}`);
} catch (err) {
  console.error(`   ❌ GET /api/album/root failed: ${(err as Error).message}`);
}

if (!rootOk || !albumOk) {
  console.error('\n❌ HTTP probe failed — stopping.');
  await stopPiGallery();
  process.exit(1);
}

// ── 5: Indexing trigger ───────────────────────────────────────────────────────

console.log('\n[ 5/6 ] Triggering indexing…');
try {
  await triggerIndexing();
  console.log('   ✅ Indexing job triggered successfully');
} catch (err) {
  // Non-fatal — the API endpoint may not exist in all PiGallery2 versions.
  console.warn(`   ⚠️  Indexing trigger failed (non-fatal): ${(err as Error).message}`);
}

// ── 6: Stop + port release ────────────────────────────────────────────────────

console.log('\n[ 6/6 ] Stopping PiGallery2…');
const t1 = Date.now();
try {
  await stopPiGallery();
} catch (err) {
  console.error(`❌ Stop failed: ${(err as Error).message}`);
  process.exit(1);
}
console.log(`   ✅ Stopped in ${Date.now() - t1}ms`);

const statusAfter = getPiGalleryStatus();
if (statusAfter.state !== 'stopped') {
  console.error(`❌ Expected state=stopped after stop, got: ${statusAfter.state}`);
  process.exit(1);
}

// Verify port is released.
await sleep(200);
const portReleased = await new Promise<boolean>(resolve => {
  const net = require('net') as typeof import('net');
  const sock = net.connect(PIGALLERY_PORT, '127.0.0.1');
  sock.once('connect', () => { sock.destroy(); resolve(false); }); // port still open = bad
  sock.once('error',   () => { sock.destroy(); resolve(true);  }); // connection refused = good
});
console.log(`   Port :${PIGALLERY_PORT} released: ${portReleased ? '✅' : '❌'}`);
if (!portReleased) {
  console.error('❌ Port still bound after stop.');
  process.exit(1);
}

console.log('\n✅ All checks passed. PiGallery2 integration is healthy.\n');
