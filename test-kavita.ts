/**
 * test-kavita.ts — Validates Kavita can start, bootstrap, provision users,
 * manage per-user libraries, and serve content.
 *
 * Run from dual-reasoning/:
 *   npx tsx test-kavita.ts
 *
 * Expects:
 *   - Kavita binary at ~/.phobos/services/kavita/Kavita[.exe]
 *   - ./test-outputs/testbooks — drop CBZ/EPUB/PDF files here for content tests
 *
 * Options (env vars):
 *   KAVITA_SKIP_START     set to '1' to test against a running instance
 *   KAVITA_TEST_TIMEOUT   max ms to wait for port (default: 120000)
 *   KAVITA_KEEP_RUNNING   set to '1' to leave Kavita running after the test
 *   KAVITA_WIPE=1         ⚠️  DELETE kavita.db before start — destroys ALL user data.
 *                         Only safe on a dedicated test instance, never production.
 */

import * as path   from 'node:path';
import * as fs     from 'node:fs';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'url';

import {
  KAVITA_PORT,
  KAVITA_RELEASE,
  KAVITA_LIB_TYPE,
  PHOBOSDOCS_LIB_NAME,
  isBinaryPresent,
  resolveBinaryPath,
  resolveConfigDir,
  defaultDocsPath,
  startKavita,
  stopKavita,
  getKavitaStatus,
  getKavitaJwt,
  listLibraries,
  createLibrary,
  triggerScan,
  getStats,
  provisionUser,
  deprovisionUser,
} from './services/KavitaManager.js';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const BOOKS_PATH   = path.resolve(__dirname, 'test-outputs', 'testbooks');
const BASE_URL     = `http://127.0.0.1:${KAVITA_PORT}`;
const SKIP_START   = process.env.KAVITA_SKIP_START === '1';
const KEEP_RUNNING = process.env.KAVITA_KEEP_RUNNING === '1';
// KAVITA_WIPE=1 deletes kavita.db before starting — destroys ALL user accounts and libraries.
// Only use on a dedicated test instance. NEVER run against your production Kavita.
const WIPE_DB      = process.env.KAVITA_WIPE === '1';

const TEST_PASSWORD  = 'phobos-test-kavita-localonly';
const TEST_TOKEN_KEY = crypto.randomBytes(256).toString('base64');
const TEST_USER      = `kavita-test-${Date.now().toString(36)}`;

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

function countFiles(dir: string, exts?: string[]): number {
  if (!fs.existsSync(dir)) return 0;
  const entries = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
  if (!exts) return entries.length;
  return entries.filter(f => exts.includes(path.extname(f).toLowerCase())).length;
}

async function kavitaApi(
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const jwt = getKavitaJwt();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (jwt) headers['Authorization'] = `Bearer ${jwt}`;
  const res = await fetch(`${BASE_URL}/api${endpoint}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: unknown;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// ── Banner ────────────────────────────────────────────────────────────────────

const bookCount = countFiles(BOOKS_PATH, ['.cbz', '.cbr', '.epub', '.pdf']);

console.log('\n📚  PHOBOS Kavita Validation Test');
console.log('─'.repeat(52));
console.log(`   Kavita:       ${KAVITA_RELEASE}`);
console.log(`   Port:         ${KAVITA_PORT}`);
console.log(`   Books path:   ${BOOKS_PATH}`);
console.log(`   Book files:   ${bookCount} (.cbz/.cbr/.epub/.pdf)`);
console.log(`   Owner docs:   ${defaultDocsPath()}`);
console.log(`   Skip start:   ${SKIP_START}`);
console.log(`   Keep running: ${KEEP_RUNNING}`);
console.log(`   Test user:    ${TEST_USER}`);
console.log();

// ── [ 1 ] Binary check ────────────────────────────────────────────────────────

console.log('[ 1/11 ] Binary check...');
ok('Kavita binary present', isBinaryPresent());
if (!isBinaryPresent()) {
  console.error(`\n   ❌ Not found: ${resolveBinaryPath()}`);
  process.exit(1);
}
console.log(`   ✅ ${resolveBinaryPath()}`);

// ── [ 2 ] Config directory ────────────────────────────────────────────────────

console.log('\n[ 2/11 ] Config directory...');
fs.mkdirSync(resolveConfigDir(), { recursive: true });
ok('Config dir exists', fs.existsSync(resolveConfigDir()));
console.log(`   Config dir: ${resolveConfigDir()}`);

// ── [ 3 ] Test directory ──────────────────────────────────────────────────────

console.log('\n[ 3/11 ] Test directory...');
fs.mkdirSync(BOOKS_PATH, { recursive: true });
ok('testbooks directory created', fs.existsSync(BOOKS_PATH));
if (bookCount === 0) {
  warn('testbooks is empty — content tests limited');
}

// ── [ 4 ] Owner docs path ─────────────────────────────────────────────────────

console.log('\n[ 4/11 ] Owner docs path (must be under owner/phobosDocs)...');
const ownerDocsPath = defaultDocsPath();
ok('defaultDocsPath contains owner/', ownerDocsPath.includes(`owner${path.sep}phobosDocs`) || ownerDocsPath.includes('owner/phobosDocs'));
console.log(`   path: ${ownerDocsPath}`);

// ── [ 5 ] Start ───────────────────────────────────────────────────────────────

if (!SKIP_START) {
  if (WIPE_DB) {
    const kavitaDb = path.join(resolveConfigDir(), 'kavita.db');
    if (fs.existsSync(kavitaDb)) {
      fs.rmSync(kavitaDb, { force: true });
      for (const suffix of ['-wal', '-shm']) {
        const f = kavitaDb + suffix;
        if (fs.existsSync(f)) fs.rmSync(f, { force: true });
      }
      console.log('\n   ℹ️  Wiped kavita.db (KAVITA_WIPE=1).');
    }
  } else {
    console.log('\n   ℹ️  Using existing kavita.db. Set KAVITA_WIPE=1 to start fresh (destroys all data).');
  }

  console.log('\n[ 5/11 ] Starting Kavita...');
  const t0 = Date.now();
  try {
    await startKavita({
      tokenKey:      TEST_TOKEN_KEY,
      adminPassword: TEST_PASSWORD,
      refreshToken:  '',
      docsPath:      defaultDocsPath(),
      firstBoot:     true,
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    ok(`Kavita started (${elapsed}s)`, true);
  } catch (err) {
    console.error(`\n   ❌ Start failed: ${(err as Error).message}`);
    process.exit(1);
  }
} else {
  console.log('\n[ 5/11 ] KAVITA_SKIP_START=1 — skipping start.');
}

// ── [ 6 ] Status check ────────────────────────────────────────────────────────

console.log('\n[ 6/11 ] Status check...');
const status = getKavitaStatus();
ok('state = running', status.state === 'running');
ok(`port = ${KAVITA_PORT}`, status.port === KAVITA_PORT);
ok('no error',        status.error === null);
ok('JWT present',     getKavitaJwt() !== null);
console.log(`   State:    ${status.state}`);
console.log(`   Port:     ${status.port}`);
console.log(`   DocsPath: ${status.docsPath ?? '(not set)'}`);

// ── [ 7 ] phobosDocs library (owner) ─────────────────────────────────────────

console.log('\n[ 7/11 ] phobosDocs library (owner)...');
try {
  const libs      = await listLibraries();
  const phobosDocs = libs.find(l => l.name === PHOBOSDOCS_LIB_NAME);
  ok('phobosDocs library exists',         !!phobosDocs);
  ok('phobosDocs folder exists on disk',  phobosDocs?.folders.some(f => fs.existsSync(f)) ?? false);
  ok('phobosDocs folder under owner/',    phobosDocs?.folders.some(f => f.includes('owner')) ?? false);
  if (phobosDocs) {
    console.log(`   id:      ${phobosDocs.id}`);
    console.log(`   folders: ${phobosDocs.folders.join(', ')}`);
    console.log(`   series:  ${phobosDocs.seriesCount ?? 0}`);
  }
} catch (err) {
  ok('Library list succeeded', false);
  warn('Library list failed', (err as Error).message);
}

// ── [ 8 ] Per-user provisioning ───────────────────────────────────────────────

console.log(`\n[ 8/11 ] Per-user provisioning (${TEST_USER})...`);
let testUserKavitaId = '';
try {
  const result = await provisionUser(TEST_USER);
  ok('provisionUser succeeded',     !!result.userId);
  ok('JWT returned',                !!result.jwt);
  ok('password returned',           !!result.password);
  ok('apiKey returned',             !!result.apiKey);
  testUserKavitaId = result.userId;
  console.log(`   kavitaId: ${result.userId}`);

  // User should now appear in Kavita's user list.
  const usersRes = await kavitaApi('GET', '/Users/names');
  const names    = usersRes.data as string[];
  ok(`${TEST_USER} in Kavita users`, Array.isArray(names) && names.some(n => n.toLowerCase() === TEST_USER.toLowerCase()));

  // Per-user library should exist and be scoped to that user.
  const userLibs   = await listLibraries();
  const userLib    = userLibs.find(l => l.name === `${TEST_USER}-docs`);
  ok(`${TEST_USER}-docs library exists`, !!userLib);
  ok('library folder under username/', userLib?.folders.some(f => f.includes(TEST_USER)) ?? false);
  console.log(`   user library folders: ${userLib?.folders.join(', ') ?? '(none)'}`);
} catch (err) {
  ok('provisionUser succeeded', false);
  warn('provisionUser failed', (err as Error).message);
}

// ── [ 9 ] Test library create ─────────────────────────────────────────────────

console.log('\n[ 9/11 ] Test library create...');
let existingNames: string[] = [];
try {
  const libs = await listLibraries();
  existingNames = libs.map(l => l.name);
} catch { /* ignore */ }

if (!existingNames.includes('Test Books')) {
  try {
    const lib = await createLibrary('Test Books', KAVITA_LIB_TYPE.books, [BOOKS_PATH]);
    ok('Created "Test Books" library', !!lib.id);
    console.log(`   Created: id=${lib.id}`);
  } catch (err) {
    ok('Created "Test Books" library', false);
    warn('createLibrary failed', (err as Error).message);
  }
} else {
  console.log('   ℹ️  "Test Books" already exists — skipping create');
  ok('Test Books library present', true);
}

// ── [ 10 ] Scan + stats ───────────────────────────────────────────────────────

console.log('\n[ 10/11 ] Scan + stats...');
try {
  await triggerScan();
  ok('triggerScan succeeded', true);
} catch (err) {
  ok('triggerScan succeeded', false);
  warn('Scan trigger failed', (err as Error).message);
}

if (bookCount > 0) {
  console.log('   Waiting for scan to complete (up to 60s)...');
  // Give the scan a head start before polling — it was already in progress.
  await sleep(3_000);
  const deadline = Date.now() + 57_000;
  let seriesCount = 0;
  while (Date.now() < deadline) {
    try {
      const libs  = await listLibraries();
      seriesCount = libs.reduce((n, l) => n + (l.seriesCount ?? l.series ?? 0), 0);
      if (seriesCount > 0) break;
    } catch { /* still scanning */ }
    process.stdout.write('.');
    await sleep(2_000);
  }
  process.stdout.write('\n');
  ok('At least one series indexed', seriesCount > 0);
  console.log(`   Series indexed: ${seriesCount}`);
} else {
  warn('testbooks is empty — skipping content poll');
}

const stats = await getStats();
ok('getStats succeeded', typeof stats.libraryCount === 'number');
console.log(`   Libraries: ${stats.libraryCount}  Total series: ${stats.totalSeries}`);

// ── [ 11 ] Per-user deprovision ───────────────────────────────────────────────

console.log(`\n[ 11/11 ] Per-user deprovision (${TEST_USER})...`);
if (testUserKavitaId) {
  try {
    await deprovisionUser(TEST_USER);
    ok('deprovisionUser succeeded', true);

    // Library should be gone.
    const libsAfter = await listLibraries();
    ok(`${TEST_USER}-docs library removed`, !libsAfter.some(l => l.name === `${TEST_USER}-docs`));

    // User should be gone from Kavita.
    const usersAfter = await kavitaApi('GET', '/Users/names');
    const namesAfter = usersAfter.data as string[];
    ok(`${TEST_USER} removed from Kavita`, Array.isArray(namesAfter) && !namesAfter.some(n => n.toLowerCase() === TEST_USER.toLowerCase()));
  } catch (err) {
    ok('deprovisionUser succeeded', false);
    warn('deprovisionUser failed', (err as Error).message);
  }
} else {
  warn('Skipping deprovision — provisionUser did not succeed');
}

// ── Shutdown ──────────────────────────────────────────────────────────────────

if (!SKIP_START && !KEEP_RUNNING) {
  console.log('\n⏹  Stopping Kavita...');
  await stopKavita();
  ok('Kavita stopped', getKavitaStatus().state === 'stopped');
} else {
  console.log('\n   ℹ️  Kavita left running.');
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
  console.error('\n❌  Kavita validation FAILED\n');
  process.exit(1);
} else {
  console.log('\n✅  Kavita validation PASSED\n');
}