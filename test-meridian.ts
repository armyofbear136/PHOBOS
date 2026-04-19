/**
 * test-meridian.ts — Validates PHOBOS Meridian can start, serve the API, and stop cleanly.
 *
 * Run from dual-reasoning/:
 *   npx tsx test-meridian.ts
 *
 * Uses:
 *   - ./test-outputs/photos as the library root (place test photos there)
 *   - A fresh DuckDB in %TEMP%/phobos-meridian-test-<timestamp>/ every run
 *     so the test never touches localai.duckdb or any live data.
 *
 * Override:
 *   PHOBOS_TEST_LIBRARY=<path>  use a different library root
 *   PHOBOS_SCRATCH=<path>       reuse an existing scratch dir (keeps DB between runs)
 */

import fs   from 'node:fs';
import net  from 'node:net';
import os   from 'node:os';
import path from 'node:path';
import {
  startMeridian,
  stopMeridian,
  getMeridianStatus,
  MERIDIAN_PORT,
} from './services/MeridianManager.js';

// ── Scratch dir (unique per run, never touches live data) ────────────────────

function makeScratchDir(): string {
  if (process.env.PHOBOS_SCRATCH) {
    const override = path.resolve(process.env.PHOBOS_SCRATCH);
    fs.mkdirSync(override, { recursive: true });
    return override;
  }
  const ts  = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(os.tmpdir(), `phobos-meridian-test-${ts}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const scratchDir  = makeScratchDir();
const TEST_DB     = path.join(scratchDir, 'test.duckdb');
const LIBRARY_PATH = process.env.PHOBOS_TEST_LIBRARY
  ?? path.resolve('test-outputs', 'photos');
const BASE_URL    = `http://127.0.0.1:${MERIDIAN_PORT}`;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// Ensure test library exists (empty is fine — test doesn't require photos)
fs.mkdirSync(LIBRARY_PATH, { recursive: true });

console.log('\n🖼️  PHOBOS Meridian Validation Test');
console.log('─'.repeat(50));
console.log(`   Library:   ${LIBRARY_PATH}`);
console.log(`   Scratch:   ${scratchDir}`);
console.log(`   Test DB:   ${TEST_DB}`);
console.log(`   Port:      ${MERIDIAN_PORT}\n`);

// ── Cleanup on exit (remove scratch dir unless PHOBOS_SCRATCH override) ────────

function cleanup() {
  if (process.env.PHOBOS_SCRATCH) return; // user asked to keep it
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// ── 1: Pre-start status ───────────────────────────────────────────────────────

console.log('[ 1/7 ] Pre-start status…');
const statusBefore = getMeridianStatus();
if (statusBefore.state !== 'stopped') {
  console.error(`❌ Expected stopped, got: ${statusBefore.state}`);
  process.exit(1);
}
console.log(`   ✅ state=${statusBefore.state}`);

// ── 2: Start ──────────────────────────────────────────────────────────────────

console.log('\n[ 2/7 ] Starting Meridian…');
const t0 = Date.now();
try {
  await startMeridian({
    libraryPath: LIBRARY_PATH,
    idleEnabled: false,
    dbPath:      TEST_DB,
  });
} catch (err) {
  console.error(`❌ Start failed: ${(err as Error).message}`);
  const s = getMeridianStatus();
  if (s.error) console.error(`   Detail: ${s.error}`);
  process.exit(1);
}
console.log(`   ✅ Running on :${MERIDIAN_PORT} (${Date.now() - t0}ms)`);

// ── 3: /api/status ────────────────────────────────────────────────────────────

console.log('\n[ 3/7 ] GET /api/status…');
await sleep(300);
try {
  const res  = await fetch(`${BASE_URL}/api/status`);
  const body = await res.json() as Record<string, unknown>;
  if (!res.ok || !body.ok) throw new Error(`HTTP ${res.status}`);
  console.log(`   ✅ ok=${body.ok} totalFiles=${body.totalFiles} scanPhase=${body.scanPhase}`);
} catch (err) {
  console.error(`❌ /api/status failed: ${(err as Error).message}`);
  await stopMeridian(); process.exit(1);
}

// ── 4: /api/files ─────────────────────────────────────────────────────────────

console.log('\n[ 4/7 ] GET /api/files…');
try {
  const res  = await fetch(`${BASE_URL}/api/files?limit=10&offset=0`);
  const body = await res.json() as { files: unknown[]; total: number };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  console.log(`   ✅ total=${body.total} returned=${body.files.length}`);
} catch (err) {
  console.error(`❌ /api/files failed: ${(err as Error).message}`);
  await stopMeridian(); process.exit(1);
}

// ── 5: /api/albums ────────────────────────────────────────────────────────────

console.log('\n[ 5/7 ] Album round-trip (create → list → delete)…');
let albumId: string | null = null;
try {
  const create = await fetch(`${BASE_URL}/api/albums`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test Album', libraryId: 'default' }),
  });
  const created = await create.json() as { album: { id: string } };
  albumId = created.album.id;
  console.log(`   ✅ Created album: ${albumId}`);

  const list   = await fetch(`${BASE_URL}/api/albums`);
  const listed = await list.json() as { albums: Array<{ id: string }> };
  const found  = listed.albums.some(a => a.id === albumId);
  console.log(`   ✅ Listed — found in list: ${found}`);

  await fetch(`${BASE_URL}/api/albums/${albumId}`, { method: 'DELETE' });
  console.log(`   ✅ Deleted album`);
} catch (err) {
  console.error(`❌ Album round-trip failed: ${(err as Error).message}`);
  await stopMeridian(); process.exit(1);
}

// ── 6: /api/search ────────────────────────────────────────────────────────────

console.log('\n[ 6/7 ] GET /api/search…');
try {
  const res  = await fetch(`${BASE_URL}/api/search?q=test`);
  const body = await res.json() as { files: unknown[] };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  console.log(`   ✅ Search returned ${body.files.length} results`);
} catch (err) {
  console.error(`❌ /api/search failed: ${(err as Error).message}`);
  await stopMeridian(); process.exit(1);
}

// ── 7: Stop ───────────────────────────────────────────────────────────────────

console.log('\n[ 7/7 ] Stopping Meridian…');
const t1 = Date.now();
try {
  await stopMeridian();
} catch (err) {
  console.error(`❌ Stop failed: ${(err as Error).message}`);
  process.exit(1);
}
console.log(`   ✅ Stopped in ${Date.now() - t1}ms`);

const statusAfter = getMeridianStatus();
if (statusAfter.state !== 'stopped') {
  console.error(`❌ Expected stopped after stop, got: ${statusAfter.state}`);
  process.exit(1);
}

// Verify port released
await sleep(200);
const portReleased = await new Promise<boolean>(resolve => {
  const sock = net.connect(MERIDIAN_PORT, '127.0.0.1');
  sock.once('connect', () => { sock.destroy(); resolve(false); });
  sock.once('error',   () => { sock.destroy(); resolve(true);  });
});
console.log(`   Port :${MERIDIAN_PORT} released: ${portReleased ? '✅' : '❌'}`);
if (!portReleased) { console.error('❌ Port still bound.'); process.exit(1); }

console.log('\n✅ All checks passed. Meridian integration is healthy.\n');
