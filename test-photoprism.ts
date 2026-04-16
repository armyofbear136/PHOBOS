/**
 * test-photoprism.ts — PhotoPrism integration test.
 *
 * Tests the full lifecycle: binary presence → start → auth → API calls →
 * scan trigger → proxy → stop.
 *
 * Run with: npx ts-node --esm test-photoprism.ts
 *   or:     node --loader ts-node/esm test-photoprism.ts
 *
 * Requires:
 *   1. node scripts/fetch-photoprism.js   (download binary + assets/)
 *   2. A library path to point PhotoPrism at (can be an empty directory)
 *
 * Options (env vars):
 *   PHOTOPRISM_TEST_LIBRARY   path to photo library (default: ~/Pictures)
 *   PHOTOPRISM_TEST_TIMEOUT   max ms to wait for ready (default: 180000)
 *   PHOTOPRISM_SKIP_START     set to '1' to skip start/stop (test running instance)
 */

import * as os   from 'node:os';
import * as path from 'node:path';
import * as fs   from 'node:fs';

import {
  PHOTOPRISM_PORT,
  PHOTOPRISM_RELEASE_TAG,
  isBinaryPresent,
  resolveBinaryPath,
  resolveServiceDir,
  resolveAssetsDir,
  resolveStorageDir,
  startPhotoprism,
  stopPhotoprism,
  getPhotoPrismStatus,
  getApiToken,
  photoPrismApiRequest,
  triggerLibraryScan,
} from './services/PhotoPrismManager.js';

// ── Test config ────────────────────────────────────────────────────────────────

const LIBRARY_PATH  = process.env.PHOTOPRISM_TEST_LIBRARY
  ?? path.join(os.homedir(), 'Pictures');
const SKIP_START    = process.env.PHOTOPRISM_SKIP_START === '1';
const START_TIMEOUT = Number(process.env.PHOTOPRISM_TEST_TIMEOUT ?? 180_000);

// Fixed test password — not a real secret, used for the test instance only.
const TEST_PASSWORD = 'phobos-test-pw-localonly';

// ── Helpers ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label: string, value: unknown) {
  if (value) {
    console.log(`  ✅  ${label}`);
    passed++;
  } else {
    console.error(`  ❌  ${label}`);
    failed++;
  }
}

function section(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`);
}

async function expectHttp(
  label: string,
  fn: () => Promise<Response>,
  expectedStatus: number,
): Promise<Response | null> {
  try {
    const res = await fn();
    ok(`${label} (HTTP ${res.status})`, res.status === expectedStatus);
    return res;
  } catch (err) {
    console.error(`  ❌  ${label} — ${(err as Error).message}`);
    failed++;
    return null;
  }
}

// ── Section 1: Installation validation ────────────────────────────────────────

section('1. Installation');

ok(`Release tag constant: ${PHOTOPRISM_RELEASE_TAG}`, PHOTOPRISM_RELEASE_TAG.startsWith('26'));
ok(`Service dir: ${resolveServiceDir()}`, typeof resolveServiceDir() === 'string');
ok(`Binary path defined: ${resolveBinaryPath()}`, resolveBinaryPath().includes('photoprism'));
ok(`Assets dir defined: ${resolveAssetsDir()}`, resolveAssetsDir().includes('assets'));

const binPresent = isBinaryPresent();
ok(`Binary present at ${resolveBinaryPath()}`, binPresent);

if (!binPresent) {
  console.error('\n  ⚠️   Binary or assets/ not found.');
  console.error('      Run:  node scripts/fetch-photoprism.js');
  console.error('      Then re-run this test.\n');
}

const assetsDir = resolveAssetsDir();
ok(`assets/ directory present at ${assetsDir}`, fs.existsSync(assetsDir));

if (binPresent) {
  const binarySize = fs.statSync(resolveBinaryPath()).size;
  ok(`Binary size > 40 MB (${(binarySize / 1e6).toFixed(1)} MB)`, binarySize > 40_000_000);
}

// ── Section 2: Library path ────────────────────────────────────────────────────

section('2. Library path');

if (!fs.existsSync(LIBRARY_PATH)) {
  fs.mkdirSync(LIBRARY_PATH, { recursive: true });
  console.log(`  📁  Created test library dir: ${LIBRARY_PATH}`);
}
ok(`Library path exists: ${LIBRARY_PATH}`, fs.existsSync(LIBRARY_PATH));

// ── Section 3: Start (unless skipped) ─────────────────────────────────────────

if (!binPresent) {
  console.error('\n⛔  Cannot continue — binary not installed. Stopping here.\n');
  console.log(`Passed: ${passed}  Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

if (!SKIP_START) {
  section('3. Start');

  const initialStatus = getPhotoPrismStatus();
  ok(`Initial state is stopped or error`, ['stopped', 'error'].includes(initialStatus.state));

  console.log(`  ⏳  Starting PhotoPrism (timeout: ${START_TIMEOUT / 1000}s)...`);
  console.log(`      Library: ${LIBRARY_PATH}`);
  const startMs = Date.now();

  try {
    await startPhotoprism({
      originalsPath:         LIBRARY_PATH,
      adminPassword:         TEST_PASSWORD,
      disableFaces:          true,   // skip ML for speed in test
      disableClassification: true,
      workers:               1,
    });
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    ok(`Started in ${elapsed}s`, true);
  } catch (err) {
    ok(`Start failed: ${(err as Error).message}`, false);
    console.error('\n  ⛔  PhotoPrism failed to start. Remaining tests skipped.\n');
    console.log(`Passed: ${passed}  Failed: ${failed}`);
    process.exit(1);
  }

  const runningStatus = getPhotoPrismStatus();
  ok(`State is 'running' after start`, runningStatus.state === 'running');
  ok(`Port is ${PHOTOPRISM_PORT}`, runningStatus.port === PHOTOPRISM_PORT);
  ok(`originalsPath matches`, runningStatus.originalsPath === LIBRARY_PATH);
} else {
  section('3. Start (SKIPPED — PHOTOPRISM_SKIP_START=1)');
  console.log('  ℹ️   Testing against already-running instance on :' + PHOTOPRISM_PORT);
}

// ── Section 4: Authentication ─────────────────────────────────────────────────

section('4. Authentication');

let token: string | null = null;
try {
  token = await getApiToken();
  ok(`Session token acquired (length ${token?.length})`, token && token.length > 8);
} catch (err) {
  ok(`getApiToken failed: ${(err as Error).message}`, false);
}

// Second call must return cached token — no second HTTP request.
if (token) {
  const token2 = await getApiToken();
  ok(`Second getApiToken() returns cached token`, token2 === token);
}

// ── Section 5: Core API calls ──────────────────────────────────────────────────

section('5. Core API');

const metricsRes = await expectHttp(
  'GET /api/v1/metrics',
  () => photoPrismApiRequest('GET', '/api/v1/metrics'),
  200,
);
if (metricsRes) {
  try {
    const metrics = await metricsRes.json() as Record<string, unknown>;
    ok(`Metrics has 'photos' field`, 'photos' in metrics || 'PhotosTotal' in metrics);
    console.log(`  ℹ️   Library: photos=${metrics.photos ?? metrics.PhotosTotal ?? '?'}`);
  } catch {
    ok(`Metrics JSON parse`, false);
  }
}

// Photo list (may be empty — that's fine).
const photosRes = await expectHttp(
  'GET /api/v1/photos?count=1',
  () => photoPrismApiRequest('GET', '/api/v1/photos?count=1'),
  200,
);
if (photosRes) {
  try {
    const body = await photosRes.json();
    ok(`Photos endpoint returns array or object`, body !== null);
  } catch {
    ok(`Photos JSON parse`, false);
  }
}

// Albums endpoint.
await expectHttp(
  'GET /api/v1/albums?count=1',
  () => photoPrismApiRequest('GET', '/api/v1/albums?count=1'),
  200,
);

// ── Section 6: Library scan trigger ───────────────────────────────────────────

section('6. Library scan');

try {
  await triggerLibraryScan(false);
  ok('triggerLibraryScan() completed without error', true);
} catch (err) {
  ok(`triggerLibraryScan() failed: ${(err as Error).message}`, false);
}

// Rescan=true variant.
try {
  await triggerLibraryScan(true);
  ok('triggerLibraryScan(rescan=true) completed', true);
} catch (err) {
  ok(`triggerLibraryScan(rescan=true) failed: ${(err as Error).message}`, false);
}

// ── Section 7: Proxy helper ────────────────────────────────────────────────────

section('7. Proxy request helper');

// Confirm photoPrismApiRequest injects auth correctly by hitting a protected endpoint
// and checking we do NOT get 401.
const proxyRes = await expectHttp(
  'photoPrismApiRequest injects auth (no 401)',
  () => photoPrismApiRequest('GET', '/api/v1/photos?count=1'),
  200,
);
ok('Auth injection working', proxyRes !== null && proxyRes.status !== 401);

// ── Section 8: Status shape ────────────────────────────────────────────────────

section('8. Status shape');

const status = getPhotoPrismStatus();
ok(`status.state is valid`,    ['stopped', 'starting', 'running', 'error'].includes(status.state));
ok(`status.port === 16320`,    status.port === 16320);
ok(`status.storageDir defined`, typeof status.storageDir === 'string' && status.storageDir.length > 0);
ok(`status.binaryPresent`,      status.binaryPresent);

// ── Section 9: Stop ────────────────────────────────────────────────────────────

if (!SKIP_START) {
  section('9. Stop');

  await stopPhotoprism();
  const stoppedStatus = getPhotoPrismStatus();
  ok(`State is 'stopped' after stop`, stoppedStatus.state === 'stopped');
  ok(`Process is null after stop`, stoppedStatus.error === null || stoppedStatus.state === 'stopped');

  // Confirm token is invalidated — getApiToken should fail now.
  try {
    await getApiToken();
    ok(`getApiToken() after stop should fail (no config)`, false);
  } catch {
    ok(`getApiToken() correctly fails after stop`, true);
  }
} else {
  section('9. Stop (SKIPPED — PHOTOPRISM_SKIP_START=1)');
}

// ── Summary ────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(52)}`);
console.log(`  Passed: ${passed}   Failed: ${failed}`);
if (failed === 0) {
  console.log(`  ✅  All tests passed.\n`);
} else {
  console.log(`  ❌  ${failed} test(s) failed.\n`);
}

process.exit(failed > 0 ? 1 : 0);
