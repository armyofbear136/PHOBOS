/**
 * test-jellyfin.ts — Validates Jellyfin can start, manage per-user libraries,
 * index content, and enforce user library isolation.
 *
 * Run from dual-reasoning/:
 *   npx tsx test-jellyfin.ts
 *
 * Expects:
 *   - Jellyfin binary at ~/.phobos/services/jellyfin/jellyfin[.exe]
 *   - ./test-outputs/videos/movies — place video files here for content tests
 *
 * Options (env vars):
 *   JELLYFIN_TEST_TIMEOUT   max ms to wait for port (default: 300000)
 *   JELLYFIN_SKIP_START     set to '1' to test a running instance
 *   JELLYFIN_KEEP_RUNNING   set to '1' to leave running after test
 *   JELLYFIN_WIPE=1         ⚠️  DELETE jellyfin.db before start — destroys ALL user data.
 *                           Only safe on a dedicated test instance, never production.
 */

import * as path from 'node:path';
import * as fs   from 'node:fs';
import * as os   from 'node:os';
import { fileURLToPath } from 'url';

import {
  JELLYFIN_PORT,
  JELLYFIN_RELEASE,
  isBinaryPresent,
  isFFmpegPresent,
  resolveBinaryPath,
  resolveFFmpegPath,
  resolveDataDir,
  defaultMediaPath,
  startJellyfin,
  stopJellyfin,
  getJellyfinStatus,
  triggerScan,
  getStats,
  addLibrary,
  removeLibrary,
  listLibraries,
  jellyfinApiRequest,
  provisionUser,
  deprovisionUser,
} from './services/JellyfinManager.js';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const MOVIES_PATH   = path.resolve(__dirname, 'test-outputs', 'videos', 'movies');
const SKIP_START    = process.env.JELLYFIN_SKIP_START === '1';
const KEEP_RUNNING  = process.env.JELLYFIN_KEEP_RUNNING === '1';
// JELLYFIN_WIPE=1 deletes jellyfin.db before starting — destroys ALL user accounts and libraries.
// Only use on a dedicated test instance. NEVER run against your production Jellyfin.
const WIPE_DB       = process.env.JELLYFIN_WIPE === '1';
const TEST_PASSWORD = 'phobos-test-pw-jf-localonly';
const TEST_USER     = `jf-test-${Date.now().toString(36)}`;
const PHOBOS_DIR    = path.join(os.homedir(), '.phobos');

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const warns: string[] = [];

function ok(label: string, value: unknown) {
  if (value) { console.log(`  ✅  ${label}`); passed++; }
  else        { console.error(`  ❌  ${label}`); failed++; }
}

function warn(label: string, detail?: string) {
  console.warn(`  ⚠️   ${label}${detail ? ': ' + detail : ''}`);
  warns.push(label);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(f => !f.startsWith('.')).length;
}

// ── Banner ────────────────────────────────────────────────────────────────────

console.log('\n📺  PHOBOS Jellyfin Validation Test');
console.log('─'.repeat(52));
console.log(`   Jellyfin:      ${JELLYFIN_RELEASE}`);
console.log(`   Port:          ${JELLYFIN_PORT}`);
console.log(`   Owner videos:  ${defaultMediaPath()}`);
console.log(`   Movies path:   ${MOVIES_PATH}  (${countFiles(MOVIES_PATH)} files)`);
console.log(`   Skip start:    ${SKIP_START}`);
console.log(`   Test user:     ${TEST_USER}`);
console.log();

// ── [ 1 ] Binary check ────────────────────────────────────────────────────────

console.log('[ 1/12 ] Binary check...');
ok('Jellyfin binary present', isBinaryPresent());
if (!isBinaryPresent()) {
  console.error(`\n   ❌ Not found: ${resolveBinaryPath()}`);
  process.exit(1);
}
console.log(`   ✅ ${resolveBinaryPath()}`);

// ── [ 2 ] FFmpeg check ────────────────────────────────────────────────────────

console.log('\n[ 2/12 ] FFmpeg check...');
if (isFFmpegPresent()) {
  console.log(`   ✅ ${resolveFFmpegPath()}`);
  ok('FFmpeg present', true);
} else {
  warn('FFmpeg not found at bundled path');
}

// ── [ 3 ] Owner media path ────────────────────────────────────────────────────

console.log('\n[ 3/12 ] Owner media path (must be under owner/phobosVideos)...');
const ownerMediaPath = defaultMediaPath();
ok('defaultMediaPath contains owner/', ownerMediaPath.includes(`owner${path.sep}phobosVideos`) || ownerMediaPath.includes('owner/phobosVideos'));
console.log(`   path: ${ownerMediaPath}`);

// ── [ 4 ] Test directories ────────────────────────────────────────────────────

console.log('\n[ 4/12 ] Test directories...');
fs.mkdirSync(MOVIES_PATH, { recursive: true });
ok('Movies directory exists', fs.existsSync(MOVIES_PATH));
const movieCount = countFiles(MOVIES_PATH);
if (movieCount === 0) warn('Movies directory is empty — library counts will be zero after scan');

// ── [ 5 ] Start ───────────────────────────────────────────────────────────────

if (!SKIP_START) {
  if (WIPE_DB) {
    const jellyfinDb = path.join(resolveDataDir(), 'data', 'jellyfin.db');
    if (fs.existsSync(jellyfinDb)) {
      fs.rmSync(jellyfinDb, { force: true });
      for (const suffix of ['-wal', '-shm']) {
        const f = jellyfinDb + suffix;
        if (fs.existsSync(f)) fs.rmSync(f, { force: true });
      }
      console.log('\n   ℹ️  Wiped jellyfin.db (JELLYFIN_WIPE=1).');
    }
  } else {
    console.log('\n   ℹ️  Using existing jellyfin.db. Set JELLYFIN_WIPE=1 to start fresh (destroys all data).');
  }

  console.log('\n[ 5/12 ] Starting Jellyfin (first boot: up to 5 min)...');
  const t0 = Date.now();
  try {
    await startJellyfin({ libraryPath: MOVIES_PATH, hardwareAccel: '' }, TEST_PASSWORD);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    ok(`Jellyfin started (${elapsed}s)`, true);
  } catch (err) {
    console.error(`\n   ❌ Start failed: ${(err as Error).message}`);
    process.exit(1);
  }
} else {
  console.log('\n[ 5/12 ] JELLYFIN_SKIP_START=1 — skipping start.');
}

// ── [ 6 ] Status check ────────────────────────────────────────────────────────

console.log('\n[ 6/12 ] Status check...');
const status = getJellyfinStatus();
ok('state = running', status.state === 'running');
ok('port = 18096',    status.port === JELLYFIN_PORT);
ok('no error',        status.error === null);

// ── [ 7 ] System info ─────────────────────────────────────────────────────────

console.log('\n[ 7/12 ] System info...');
try {
  const r    = await jellyfinApiRequest('GET', '/System/Info/Public');
  ok('GET /System/Info/Public → ok', r.ok);
  const info = await r.json() as Record<string, unknown>;
  ok('StartupWizardCompleted', info.StartupWizardCompleted === true);
  console.log(`   Version: ${info.Version ?? '(unknown)'}`);
} catch (err) {
  ok('System info succeeded', false);
  warn('System info failed', (err as Error).message);
}

// ── [ 8 ] Per-user provisioning ───────────────────────────────────────────────

console.log(`\n[ 8/12 ] Per-user provisioning (${TEST_USER})...`);
let testJellyfinUserId = '';
try {
  const result = await provisionUser(TEST_USER);
  ok('provisionUser succeeded',       !!result.userId);
  ok('accessToken returned',          !!result.accessToken);
  testJellyfinUserId = result.userId;
  console.log(`   jellyfinId: ${result.userId}`);

  // Verify per-user library was created.
  const libs    = await listLibraries();
  const userLib = libs.find(l => l.Name === `${TEST_USER}-media`);
  ok(`${TEST_USER}-media library exists`, !!userLib);
  console.log(`   library ItemId: ${userLib?.ItemId ?? '(none)'}`);

  // Verify per-user phobosVideos directory was created.
  const expectedDir = path.join(PHOBOS_DIR, 'media', 'jellyfin', TEST_USER, 'phobosVideos');
  ok(`media/jellyfin/${TEST_USER}/phobosVideos exists`, fs.existsSync(expectedDir));
  console.log(`   dir: ${expectedDir}`);
} catch (err) {
  ok('provisionUser succeeded', false);
  warn('provisionUser failed', (err as Error).message);
}

// ── [ 9 ] Library policy isolation ────────────────────────────────────────────

console.log(`\n[ 9/12 ] Library isolation check for ${TEST_USER}...`);
if (testJellyfinUserId) {
  try {
    const r    = await jellyfinApiRequest('GET', `/Users/${testJellyfinUserId}/Policy`);
    ok('GET user policy → ok', r.ok);
    const pol  = await r.json() as Record<string, unknown>;
    ok('EnableAllFolders = false', pol.EnableAllFolders === false);
    const enabled = pol.EnabledFolders as string[] | undefined;
    ok('EnabledFolders is non-empty array', Array.isArray(enabled) && enabled.length > 0);
    console.log(`   EnableAllFolders: ${pol.EnableAllFolders}`);
    console.log(`   EnabledFolders:   [${(enabled ?? []).join(', ')}]`);
  } catch (err) {
    ok('User policy check succeeded', false);
    warn('User policy check failed', (err as Error).message);
  }
} else {
  warn('Skipping isolation check — provision did not succeed');
}

// ── [ 10 ] Scan trigger ───────────────────────────────────────────────────────

console.log('\n[ 10/12 ] Library scan...');
try {
  await triggerScan();
  ok('POST /Library/Refresh → ok', true);
} catch (err) {
  ok('Scan trigger succeeded', false);
  warn('Scan trigger failed', (err as Error).message);
}

// ── [ 11 ] Stats + Items API ──────────────────────────────────────────────────

console.log('\n[ 11/12 ] Stats + Items API...');
try {
  const stats = await getStats();
  ok('getStats succeeded', true);
  console.log(`   Movies: ${stats.movieCount}  Series: ${stats.seriesCount}`);
} catch (err) {
  ok('getStats succeeded', false);
  warn('getStats failed', (err as Error).message);
}

try {
  const r    = await jellyfinApiRequest('GET', '/Items?Recursive=true&Limit=5');
  ok('GET /Items → ok', r.ok);
  const data = await r.json() as { TotalRecordCount?: number };
  console.log(`   TotalRecordCount: ${data.TotalRecordCount ?? 0}`);
} catch (err) {
  ok('GET /Items succeeded', false);
  warn('Items API failed', (err as Error).message);
}

// ── [ 12 ] Per-user deprovision ───────────────────────────────────────────────

console.log(`\n[ 12/12 ] Per-user deprovision (${TEST_USER})...`);
if (testJellyfinUserId) {
  try {
    await deprovisionUser(testJellyfinUserId);
    ok('deprovisionUser succeeded', true);

    // Library should be removed.
    const libsAfter = await listLibraries();
    ok(`${TEST_USER}-media library removed`, !libsAfter.some(l => l.Name === `${TEST_USER}-media`));
  } catch (err) {
    ok('deprovisionUser succeeded', false);
    warn('deprovisionUser failed', (err as Error).message);
  }
} else {
  warn('Skipping deprovision — provision did not succeed');
}

// ── Shutdown ──────────────────────────────────────────────────────────────────

if (!SKIP_START && !KEEP_RUNNING) {
  console.log('\n⏹  Leaving Jellyfin running (comment in stopJellyfin() to stop).');
  // await stopJellyfin();
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(52));
console.log(`✅  Passed:   ${passed}`);
console.log(`❌  Failed:   ${failed}`);
if (warns.length > 0) {
  console.log(`⚠️   Warnings: ${warns.length}`);
  for (const w of warns) console.log(`     · ${w}`);
}

if (failed > 0) {
  console.error('\n❌  Jellyfin validation FAILED\n');
  process.exit(1);
} else {
  console.log('\n✅  Jellyfin validation PASSED\n');
}