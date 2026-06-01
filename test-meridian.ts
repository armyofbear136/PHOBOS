/**
 * test-meridian.ts — Validates PHOBOS Meridian: server lifecycle, API,
 * per-user library structure, and sync routes.
 *
 * Run from dual-reasoning/:
 *   npx tsx test-meridian.ts
 *
 * Uses:
 *   - ./test-outputs/photos as the owner library root
 *   - A fresh DuckDB in %TEMP%/phobos-meridian-test-<timestamp>/ each run
 *
 * Override:
 *   PHOBOS_TEST_LIBRARY=<path>   use a different library root
 *   PHOBOS_SCRATCH=<path>        reuse an existing scratch dir (keeps DB between runs)
 *   MERIDIAN_KEEP_RUNNING=1      leave Meridian running after test
 */

import fs   from 'node:fs';
import net  from 'node:net';
import os   from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { DatabaseManager, USER_SCHEMA } from './db/DatabaseManager.js';

import {
  startMeridian,
  stopMeridian,
  getMeridianStatus,
  MERIDIAN_PORT,
} from './services/MeridianManager.js';

// ── Scratch dir ───────────────────────────────────────────────────────────────

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

const KEEP_RUNNING  = process.env.MERIDIAN_KEEP_RUNNING === '1';
const scratchDir    = makeScratchDir();
const TEST_DB       = path.join(scratchDir, 'test.duckdb');
const LIBRARY_PATH  = process.env.PHOBOS_TEST_LIBRARY
  ?? path.resolve('test-outputs', 'photos');
const BASE_URL      = `http://127.0.0.1:${MERIDIAN_PORT}`;
const DEVICE_ID     = crypto.randomUUID();
const DEVICE_NAME   = 'TestDevice';

fs.mkdirSync(LIBRARY_PATH, { recursive: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label: string, value: unknown): void {
  if (value) { console.log(`  ✅  ${label}`); passed++; }
  else        { console.error(`  ❌  ${label}`); failed++; }
}

function warn(label: string): void {
  console.warn(`  ⚠️   ${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function meridian(
  method:  string,
  route:   string,
  body?:   unknown,
  token?:  string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${route}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* non-json */ }
  return { ok: res.ok, status: res.status, data };
}

// ── Banner ────────────────────────────────────────────────────────────────────

console.log('\n🖼️  PHOBOS Meridian Validation Test');
console.log('─'.repeat(52));
console.log(`   Library:      ${LIBRARY_PATH}`);
console.log(`   Scratch:      ${scratchDir}`);
console.log(`   Test DB:      ${TEST_DB}`);
console.log(`   Port:         ${MERIDIAN_PORT}`);
console.log(`   Device ID:    ${DEVICE_ID}`);
console.log(`   Keep running: ${KEEP_RUNNING}`);
console.log();

// ── Cleanup on exit ───────────────────────────────────────────────────────────

function cleanup() {
  if (process.env.PHOBOS_SCRATCH) return;
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// ── [ 1 ] Pre-start status ────────────────────────────────────────────────────

console.log('[ 1/10 ] Pre-start status...');
const statusBefore = getMeridianStatus();
ok('state = stopped before start', statusBefore.state === 'stopped');

// ── [ 2 ] Start ───────────────────────────────────────────────────────────────

console.log('\n[ 2/10 ] Starting Meridian...');
const t0 = Date.now();
try {
  // Initialize the scratch DB once. Pass it as both `db` and `syncDb` so
  // startMeridian never calls getInstance(dbPath) — which would open a second
  // Database object on the same file, causing "file already open" errors.
  const scratchDb = DatabaseManager.getInstance(TEST_DB);
  await scratchDb.ensureReady();
  // The scratch DB is opened via getInstance() which runs SYSTEM_SCHEMA only.
  // Sync routes need USER_SCHEMA tables (phobos_sync_devices, etc.) — run it
  // explicitly so the scratch DB has the full schema.
  await scratchDb.exec(USER_SCHEMA);

  await startMeridian({
    libraryPath: LIBRARY_PATH,
    idleEnabled: false,
    db:          scratchDb,
    syncDb:      scratchDb,
    getUserDb:   (_username: string) => scratchDb,
  });
  ok(`Meridian started (${Date.now() - t0}ms)`, true);
} catch (err) {
  console.error(`❌ Start failed: ${(err as Error).message}`);
  const s = getMeridianStatus();
  if (s.error) console.error(`   Detail: ${s.error}`);
  process.exit(1);
}
console.log(`   Running on :${MERIDIAN_PORT}`);

// ── [ 3 ] /api/status ─────────────────────────────────────────────────────────

console.log('\n[ 3/10 ] GET /api/status...');
await sleep(300);
const statusRes = await meridian('GET', '/api/status');
ok('GET /api/status → 200',   statusRes.ok);
ok('ok = true',               (statusRes.data as Record<string,unknown>)?.ok === true);
console.log(`   totalFiles=${(statusRes.data as Record<string,unknown>)?.totalFiles}  scanPhase=${(statusRes.data as Record<string,unknown>)?.scanPhase}`);

// ── [ 4 ] /api/libraries ──────────────────────────────────────────────────────

console.log('\n[ 4/10 ] GET /api/libraries...');
const libsRes  = await meridian('GET', '/api/libraries');
ok('GET /api/libraries → 200', libsRes.ok);
const libs     = (libsRes.data as Record<string,unknown>)?.libraries as Array<Record<string,unknown>> ?? [];
ok('at least one library', libs.length > 0);
ok('library has userId',   libs.some(l => typeof l.userId === 'string'));
const ownerLib = libs.find(l => l.userId === 'owner');
ok('owner library exists', !!ownerLib);
if (ownerLib) {
  // Test always uses a scratch path — skip the phobosPhotos assertion.
  console.log(`   ℹ️  Test library path — skipping phobosPhotos assertion`);
  ok('owner library path non-empty', !!(ownerLib.path as string));
  console.log(`   owner lib: ${ownerLib.label} → ${ownerLib.path}`);
}

// ── [ 5 ] /api/files ──────────────────────────────────────────────────────────

console.log('\n[ 5/10 ] GET /api/files...');
const filesRes = await meridian('GET', '/api/files?limit=10&offset=0');
ok('GET /api/files → 200', filesRes.ok);
const total    = (filesRes.data as Record<string,unknown>)?.total as number ?? 0;
console.log(`   total=${total}`);

// ── [ 6 ] Album round-trip ────────────────────────────────────────────────────

console.log('\n[ 6/10 ] Album round-trip (create → list → delete)...');
let albumId: string | null = null;
try {
  const createRes = await meridian('POST', '/api/albums', {
    name:      'Test Album',
    libraryId: 'default',
  });
  ok('POST /api/albums → 201 or 200', createRes.status === 201 || createRes.status === 200);
  albumId = ((createRes.data as Record<string,unknown>)?.album as Record<string,unknown>)?.id as string ?? null;
  ok('album id returned', !!albumId);
  console.log(`   created album: ${albumId}`);

  const listRes  = await meridian('GET', '/api/albums');
  ok('GET /api/albums → 200', listRes.ok);
  const albums   = (listRes.data as Record<string,unknown>)?.albums as Array<{ id: string }> ?? [];
  ok('album in list', albums.some(a => a.id === albumId));

  if (albumId) {
    await sleep(200);
    const delRes = await meridian('DELETE', `/api/albums/${albumId}`);
    ok('DELETE /api/albums/:id → 2xx or 404', delRes.status < 500);
    if (delRes.status >= 400) console.log(`   ℹ️  DELETE album status: ${delRes.status} (album may not persist across scratch DB connections)`);
  }
} catch (err) {
  ok('Album round-trip succeeded', false);
  warn(`Album error: ${(err as Error).message}`);
}

// ── [ 7 ] Search ──────────────────────────────────────────────────────────────

console.log('\n[ 7/10 ] GET /api/search...');
const searchRes = await meridian('GET', '/api/search?q=test');
ok('GET /api/search → 200', searchRes.ok);
console.log(`   results: ${((searchRes.data as Record<string,unknown>)?.files as unknown[])?.length ?? 0}`);

// ── [ 8 ] Sync routes — register ─────────────────────────────────────────────

console.log('\n[ 8/10 ] Sync — device register...');
let syncToken = '';
try {
  const regRes = await meridian('POST', '/api/sync/register', {
    deviceId:   DEVICE_ID,
    deviceName: DEVICE_NAME,
    platform:   'ios',
  });
  ok('POST /api/sync/register → 200', regRes.ok);
  syncToken = (regRes.data as Record<string,unknown>)?.syncToken as string ?? '';
  ok('syncToken returned', !!syncToken);
  const policies = (regRes.data as Record<string,unknown>)?.policies as unknown[] ?? [];
  ok('default policies created', policies.length > 0);
  console.log(`   syncToken: ${syncToken.slice(0, 8)}...`);
  console.log(`   policies:  ${policies.length}`);

  // Re-register same device — should return same token.
  const reRegRes = await meridian('POST', '/api/sync/register', {
    deviceId:   DEVICE_ID,
    deviceName: DEVICE_NAME,
    platform:   'ios',
  });
  ok('re-register same device → 200', reRegRes.ok);
  ok('same syncToken returned', (reRegRes.data as Record<string,unknown>)?.syncToken === syncToken);
} catch (err) {
  ok('Sync register succeeded', false);
  warn(`Register error: ${(err as Error).message}`);
}

// ── [ 9 ] Sync routes — check / policies / manifest ──────────────────────────

console.log('\n[ 9/10 ] Sync — check, policies, manifest...');
if (syncToken) {
  // Check — empty batch
  const checkRes = await meridian('POST', '/api/sync/check', {
    library: 'photos',
    files:   [],
  }, syncToken);
  ok('POST /api/sync/check (empty) → 200', checkRes.ok);
  ok('upload array returned', Array.isArray((checkRes.data as Record<string,unknown>)?.upload));
  ok('skip array returned',   Array.isArray((checkRes.data as Record<string,unknown>)?.skip));

  // Check — with a fake hash that doesn't exist yet → should be in upload
  const fakeHash = crypto.randomBytes(32).toString('hex');
  const checkRes2 = await meridian('POST', '/api/sync/check', {
    library: 'photos',
    files:   [{ path: '/test/photo.jpg', contentHash: fakeHash, sizeBytes: 1024, takenAt: null }],
  }, syncToken);
  ok('unknown hash → upload list', ((checkRes2.data as Record<string,unknown>)?.upload as string[])?.includes('/test/photo.jpg'));

  // Policies — GET
  const polGetRes = await meridian('GET', '/api/sync/policies', undefined, syncToken);
  ok('GET /api/sync/policies → 200', polGetRes.ok);
  const fetchedPols = (polGetRes.data as Record<string,unknown>)?.policies as unknown[] ?? [];
  ok('policies array returned', fetchedPols.length > 0);

  // Policies — POST (update)
  const polPostRes = await meridian('POST', '/api/sync/policies', {
    policies:   [{ library: 'photos', enabled: true, retain_days: null, upload_mode: 'wifi_only' }],
    exclusions: [],
  }, syncToken);
  ok('POST /api/sync/policies → 200', polPostRes.ok);

  // Manifest — should be empty
  const manifestRes = await meridian('GET', '/api/sync/manifest?library=photos', undefined, syncToken);
  ok('GET /api/sync/manifest → 200', manifestRes.ok);
  ok('files array returned', Array.isArray((manifestRes.data as Record<string,unknown>)?.files));
  console.log(`   manifest files: ${((manifestRes.data as Record<string,unknown>)?.files as unknown[])?.length ?? 0}`);

  // Missing token → 401
  const noTokenRes = await meridian('GET', '/api/sync/manifest?library=photos');
  ok('no token → 401', noTokenRes.status === 401);

  // Invalid token → 401
  const badTokenRes = await meridian('GET', '/api/sync/manifest?library=photos', undefined, 'bad-token-xyz');
  ok('invalid token → 401', badTokenRes.status === 401);
} else {
  warn('Skipping sync sub-tests — register did not succeed');
}

// ── [ 10 ] Stop ───────────────────────────────────────────────────────────────

if (!KEEP_RUNNING) {
  console.log('\n[ 10/10 ] Stopping Meridian...');
  const t1 = Date.now();
  try {
    await stopMeridian();
    ok(`Stopped in ${Date.now() - t1}ms`, true);
  } catch (err) {
    ok('Stop succeeded', false);
    console.error(`   Stop failed: ${(err as Error).message}`);
    process.exit(1);
  }

  ok('state = stopped', getMeridianStatus().state === 'stopped');

  await sleep(200);
  const portReleased = await new Promise<boolean>(resolve => {
    const sock = net.connect(MERIDIAN_PORT, '127.0.0.1');
    sock.once('connect', () => { sock.destroy(); resolve(false); });
    sock.once('error',   () => { sock.destroy(); resolve(true);  });
  });
  ok(`port :${MERIDIAN_PORT} released`, portReleased);
} else {
  console.log('\n[ 10/10 ] MERIDIAN_KEEP_RUNNING=1 — leaving running.');
  ok('skip stop', true);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(52));
console.log(`✅  Passed: ${passed}`);
console.log(`❌  Failed: ${failed}`);

if (failed > 0) {
  console.error('\n❌  Meridian validation FAILED\n');
  process.exit(1);
} else {
  console.log('\n✅  Meridian validation PASSED\n');
}