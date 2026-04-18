/**
 * test-jellyfin.ts — Validates Jellyfin can start, index, and serve media.
 *
 * Run from dual-reasoning/:
 *   node --loader ts-node/esm --no-warnings test-jellyfin.ts
 *
 * Expects:
 *   - Jellyfin binary at ~/.phobos/services/jellyfin/jellyfin[.exe]
 *   - ./test-outputs/videos/movies  — place video files here before running
 *   - ./test-outputs/videos/series  — place video files here before running
 *
 * Options (env vars):
 *   JELLYFIN_TEST_TIMEOUT   max ms to wait for port (default: 300000 = 5 min)
 *   JELLYFIN_SKIP_START     set to '1' to test a running instance
 */

import * as path from 'path';
import * as fs   from 'fs';
import * as os   from 'os';
import { fileURLToPath } from 'url';

import {
  JELLYFIN_PORT,
  JELLYFIN_RELEASE,
  isBinaryPresent,
  isFFmpegPresent,
  resolveBinaryPath,
  resolveFFmpegPath,
  resolveDataDir,
  resolveServiceDir,
  startJellyfin,
  stopJellyfin,
  getJellyfinStatus,
  triggerScan,
  getStats,
  addLibrary,
  jellyfinApiRequest,
  generateAdminPassword,
} from './services/JellyfinManager.js';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const MOVIES_PATH  = path.resolve(__dirname, 'test-outputs', 'videos', 'movies');
const SERIES_PATH  = path.resolve(__dirname, 'test-outputs', 'videos', 'series');
const BASE_URL     = `http://127.0.0.1:${JELLYFIN_PORT}`;
const SKIP_START   = process.env.JELLYFIN_SKIP_START === '1';
const START_TIMEOUT = Number(process.env.JELLYFIN_TEST_TIMEOUT ?? 300_000);

// Fixed test password — not a real secret, local test instance only.
const TEST_PASSWORD = 'phobos-test-pw-jf-localonly';

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
console.log(`   Jellyfin:     ${JELLYFIN_RELEASE}`);
console.log(`   Port:         ${JELLYFIN_PORT}`);
console.log(`   Movies path:  ${MOVIES_PATH}`);
console.log(`   Series path:  ${SERIES_PATH}`);
console.log(`   Movies files: ${countFiles(MOVIES_PATH)}`);
console.log(`   Series files: ${countFiles(SERIES_PATH)}`);
console.log(`   Skip start:   ${SKIP_START}`);
console.log();

// ── [ 1 ] Binary check ────────────────────────────────────────────────────────

console.log('[ 1/11 ] Binary check...');
ok('Jellyfin binary present', isBinaryPresent());
if (!isBinaryPresent()) {
  console.error(`\n   ❌ Not found: ${resolveBinaryPath()}`);
  console.error('   Run: node scripts/fetch-jellyfin.js\n');
  process.exit(1);
}
console.log(`   ✅ ${resolveBinaryPath()}`);

// ── [ 2 ] FFmpeg check ────────────────────────────────────────────────────────

console.log('\n[ 2/11 ] FFmpeg check...');
if (isFFmpegPresent()) {
  console.log(`   ✅ ${resolveFFmpegPath()}`);
  ok('FFmpeg present', true);
} else {
  warn('FFmpeg not found at bundled path — Jellyfin will search PATH');
  warn('Transcoding will fail if system FFmpeg is also absent');
}

// ── [ 3 ] Test directories ────────────────────────────────────────────────────

console.log('\n[ 3/11 ] Test directories...');
fs.mkdirSync(MOVIES_PATH, { recursive: true });
fs.mkdirSync(SERIES_PATH,  { recursive: true });
ok('Movies directory exists', fs.existsSync(MOVIES_PATH));
ok('Series directory exists', fs.existsSync(SERIES_PATH));

const movieCount  = countFiles(MOVIES_PATH);
const seriesCount = countFiles(SERIES_PATH);
console.log(`   Movies: ${movieCount} file(s)`);
console.log(`   Series: ${seriesCount} file(s)`);
if (movieCount === 0 && seriesCount === 0) {
  warn('Both directories are empty — library counts will be zero after scan');
  warn('Place .mkv/.mp4/.avi files in test-outputs/videos/movies and test-outputs/videos/series');
}

// ── [ 4 ] Start ───────────────────────────────────────────────────────────────

if (!SKIP_START) {
  console.log('\n[ 4/11 ] Starting Jellyfin (first boot: up to 5 min for DB migration)...');
  const t0 = Date.now();
  try {
    await startJellyfin(
      { libraryPath: MOVIES_PATH, hardwareAccel: '' },
      TEST_PASSWORD,
    );
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    ok(`Jellyfin started (${elapsed}s)`, true);
  } catch (err) {
    console.error(`\n   ❌ Start failed: ${(err as Error).message}`);
    process.exit(1);
  }
} else {
  console.log('\n[ 4/11 ] JELLYFIN_SKIP_START=1 — skipping start.');
}

// ── [ 5 ] Status check ────────────────────────────────────────────────────────

console.log('\n[ 5/11 ] Status check...');
const status = getJellyfinStatus();
ok('state = running', status.state === 'running');
ok('port = 18096',    status.port === JELLYFIN_PORT);
ok('no error',        status.error === null);
console.log(`   State:  ${status.state}`);
console.log(`   Port:   ${status.port}`);
if (status.error) console.log(`   Error:  ${status.error}`);

// ── [ 6 ] System info ─────────────────────────────────────────────────────────

console.log('\n[ 6/11 ] System info / wizard state...');
try {
  const r    = await jellyfinApiRequest('GET', '/System/Info/Public');
  ok('GET /System/Info/Public → 200', r.ok);
  const info = await r.json() as Record<string, unknown>;
  ok('StartupWizardCompleted = true', info.StartupWizardCompleted === true);
  console.log(`   Version:   ${info.Version ?? '(unknown)'}`);
  console.log(`   ProductName: ${info.ProductName ?? '(unknown)'}`);
} catch (err) {
  ok('GET /System/Info/Public succeeded', false);
  warn('System info request failed', (err as Error).message);
}

// ── [ 7 ] Library setup ───────────────────────────────────────────────────────

console.log('\n[ 7/11 ] Adding test libraries...');

// List existing libraries first.
let existingLibraries: string[] = [];
try {
  const r   = await jellyfinApiRequest('GET', '/Library/VirtualFolders');
  const lib = await r.json() as Array<{ Name: string }>;
  existingLibraries = lib.map(l => l.Name);
  console.log(`   Existing libraries: ${existingLibraries.join(', ') || '(none)'}`);
} catch (err) {
  warn('Could not list existing libraries', (err as Error).message);
}

// Add Movies library if not already present.
if (!existingLibraries.includes('Test Movies')) {
  try {
    await addLibrary('Test Movies', MOVIES_PATH, 'movies');
    ok('Added "Test Movies" library', true);
  } catch (err) {
    ok('Added "Test Movies" library', false);
    warn('addLibrary failed', (err as Error).message);
  }
} else {
  console.log('   ℹ️  "Test Movies" library already exists — skipping create');
  ok('Movies library present', true);
}

// Add TV Shows library.
if (!existingLibraries.includes('Test Series')) {
  try {
    await addLibrary('Test Series', SERIES_PATH, 'tvshows');
    ok('Added "Test Series" library', true);
  } catch (err) {
    ok('Added "Test Series" library', false);
    warn('addLibrary failed', (err as Error).message);
  }
} else {
  console.log('   ℹ️  "Test Series" library already exists — skipping create');
  ok('Series library present', true);
}

// ── [ 8 ] Scan trigger ────────────────────────────────────────────────────────

console.log('\n[ 8/11 ] Triggering library scan...');
try {
  await triggerScan();
  ok('POST /Library/Refresh → 204', true);
} catch (err) {
  ok('POST /Library/Refresh succeeded', false);
  warn('Scan trigger failed', (err as Error).message);
}

// ── [ 9 ] Poll for library counts ─────────────────────────────────────────────

console.log('\n[ 9/11 ] Polling for indexed content (up to 60s)...');
const scanDeadline = Date.now() + 60_000;
let finalStats = { movieCount: 0, seriesCount: 0, episodeCount: 0, songCount: 0 };

while (Date.now() < scanDeadline) {
  try {
    const s = await getStats();
    if (s.movieCount > 0 || s.seriesCount > 0) {
      finalStats = s;
      break;
    }
  } catch { /* indexing */ }
  process.stdout.write('.');
  await sleep(2_000);
}
process.stdout.write('\n');

console.log(`   Movies:   ${finalStats.movieCount}`);
console.log(`   Series:   ${finalStats.seriesCount}`);
console.log(`   Episodes: ${finalStats.episodeCount}`);
console.log(`   Songs:    ${finalStats.songCount}`);

if (movieCount > 0 || seriesCount > 0) {
  // Only assert counts if we actually put files in the directories.
  ok('Library has indexed items', finalStats.movieCount > 0 || finalStats.seriesCount > 0);
} else {
  warn('Directories were empty — cannot assert library counts');
  console.log('   ℹ️  Scan completed. Put video files in the test dirs and re-run.');
}

// ── [ 10 ] Items API ──────────────────────────────────────────────────────────

console.log('\n[ 10/11 ] Items API probe...');
try {
  const r    = await jellyfinApiRequest('GET', '/Items?Recursive=true&Limit=5');
  ok('GET /Items → ok', r.ok);
  const data = await r.json() as { TotalRecordCount?: number; Items?: unknown[] };
  console.log(`   TotalRecordCount: ${data.TotalRecordCount ?? 0}`);
  console.log(`   Items returned:   ${data.Items?.length ?? 0}`);
  if (data.Items && data.Items.length > 0) {
    const first = data.Items[0] as Record<string, unknown>;
    console.log(`   First item: ${first.Name ?? '(unnamed)'} [${first.Type ?? '?'}]`);
  }
} catch (err) {
  ok('GET /Items succeeded', false);
  warn('Items API failed', (err as Error).message);
}

// ── [ 11 ] Proxy round-trip ───────────────────────────────────────────────────

console.log('\n[ 11/11 ] Proxy route probe...');
// Simulate what the frontend does: call via the PHOBOS proxy path.
// We hit the Jellyfin API directly here (server-to-server), but verify
// the jellyfinApiRequest helper works for all methods.
try {
  const r = await jellyfinApiRequest('GET', '/System/Ping');
  // Ping returns 200 with "Jellyfin Server" body.
  const body = await r.text();
  ok('GET /System/Ping → ok', r.ok);
  ok('Ping response body non-empty', body.length > 0);
  console.log(`   Ping: "${body.trim()}"`);
} catch (err) {
  ok('GET /System/Ping succeeded', false);
  warn('Ping failed', (err as Error).message);
}

// ── Shutdown ──────────────────────────────────────────────────────────────────

if (!SKIP_START) {
  // Leave running — comment this out if you want Jellyfin to stop after the test.
  // await stopJellyfin();
  // console.log('\n⏹  Jellyfin stopped.');
  console.log('\n   ℹ️  Jellyfin left running. Call stopJellyfin() or Ctrl-C to stop.');
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
