/**
 * test-kavita.ts — Validates Kavita can start, bootstrap, create libraries,
 * and serve content from the test books directory.
 *
 * Run from dual-reasoning/:
 *   node --loader ts-node/esm --no-warnings test-kavita.ts
 *
 * Expects:
 *   - Kavita binary at ~/.phobos/services/kavita/Kavita[.exe]
 *   - ./test-outputs/testbooks  — drop CBZ/EPUB/PDF files here for content tests
 *
 * Options (env vars):
 *   KAVITA_SKIP_START     set to '1' to test against an already-running instance
 *   KAVITA_TEST_TIMEOUT   max ms to wait for port (default: 120000)
 *   KAVITA_KEEP_RUNNING   set to '1' to leave Kavita running after the test
 */

import * as path from 'path';
import * as fs   from 'fs';
import * as os   from 'os';
import * as net  from 'net';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';

import {
  KAVITA_PORT,
  KAVITA_RELEASE,
  KAVITA_LIB_TYPE,
  PHOBOSDOCS_LIB_NAME,
  isBinaryPresent,
  resolveBinaryPath,
  resolveServiceDir,
  resolveConfigDir,
  resolveConfigPath,
  defaultDocsPath,
  startKavita,
  stopKavita,
  getKavitaStatus,
  getKavitaAuthKey,
  getKavitaJwt,
  listLibraries,
  createLibrary,
  triggerScan,
  getStats,
} from './services/KavitaManager.js';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const BOOKS_PATH  = path.resolve(__dirname, 'test-outputs', 'testbooks');
const BASE_URL    = `http://127.0.0.1:${KAVITA_PORT}`;
const SKIP_START  = process.env.KAVITA_SKIP_START === '1';
const KEEP_RUNNING = process.env.KAVITA_KEEP_RUNNING === '1';
const START_TIMEOUT = Number(process.env.KAVITA_TEST_TIMEOUT ?? 120_000);

// Fixed test credentials — local-only, not a real secret.
// NOTE: If kavita.db already exists from a previous server.ts run, the account
// was created with a different password (from ServiceStore). Delete
// ~/.phobos/services/kavita/config/kavita.db to reset, or run with
// KAVITA_SKIP_START=1 against the already-running server instance.
const TEST_PASSWORD = 'phobos-test-kavita-localonly';
const TEST_TOKEN_KEY = crypto.randomBytes(256).toString('base64');

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
  const key = getKavitaAuthKey();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers['x-api-key'] = key;

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
console.log(`   Skip start:   ${SKIP_START}`);
console.log(`   Keep running: ${KEEP_RUNNING}`);
console.log();

// ── [ 1 ] Binary check ────────────────────────────────────────────────────────

console.log('[ 1/10 ] Binary check...');
ok('Kavita binary present', isBinaryPresent());
if (!isBinaryPresent()) {
  console.error(`\n   ❌ Not found: ${resolveBinaryPath()}`);
  console.error('   Run: node scripts/fetch-kavita.js\n');
  process.exit(1);
}
console.log(`   ✅ ${resolveBinaryPath()}`);

// ── [ 2 ] Config directory ────────────────────────────────────────────────────

console.log('\n[ 2/10 ] Config directory...');
fs.mkdirSync(resolveConfigDir(), { recursive: true });
ok('Config dir exists', fs.existsSync(resolveConfigDir()));
console.log(`   Config dir: ${resolveConfigDir()}`);

// ── [ 3 ] Test directory ──────────────────────────────────────────────────────

console.log('\n[ 3/10 ] Test directory...');
fs.mkdirSync(BOOKS_PATH, { recursive: true });
ok('testbooks directory created', fs.existsSync(BOOKS_PATH));
console.log(`   Path:   ${BOOKS_PATH}`);
console.log(`   Files:  ${bookCount}`);
if (bookCount === 0) {
  warn('testbooks is empty — library content tests will be limited');
  warn('Drop .cbz, .epub, or .pdf files into test-outputs/testbooks and re-run');
}

// ── [ 4 ] Start ───────────────────────────────────────────────────────────────

if (!SKIP_START) {
  console.log('\n[ 4/10 ] Starting Kavita (first boot: up to 2 min for DB migration)...');
  const t0 = Date.now();
  try {
    await startKavita({
      tokenKey:      TEST_TOKEN_KEY,
      adminPassword: TEST_PASSWORD,
      refreshToken:  '',       // empty → triggers bootstrap
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
  console.log('\n[ 4/10 ] KAVITA_SKIP_START=1 — skipping start.');
}

// ── [ 5 ] Status check ────────────────────────────────────────────────────────

console.log('\n[ 5/10 ] Status check...');
const status = getKavitaStatus();
ok('state = running', status.state === 'running');
ok(`port = ${KAVITA_PORT}`, status.port === KAVITA_PORT);
ok('no error',        status.error === null);
ok('JWT present', getKavitaJwt() !== null);
console.log(`   State:    ${status.state}`);
console.log(`   Port:     ${status.port}`);
console.log(`   DocsPath: ${status.docsPath ?? '(not set)'}`);
if (status.error) console.log(`   Error:    ${status.error}`);

// ── [ 6 ] Server info ─────────────────────────────────────────────────────────

console.log('\n[ 6/10 ] Server info...');
// Server info — admin-only endpoint, path confirmed from Kavita source.
try {
  // Try both casing variants — ASP.NET routing is case-insensitive but
  // some reverse proxies are not.
  let r = await kavitaApi('GET', '/server/server-info');
  if (!r.ok) r = await kavitaApi('GET', '/Server/server-info');
  if (r.ok) {
    ok('GET /api/server/server-info → ok', true);
    const info = r.data as Record<string, unknown>;
    console.log(`   Version:      ${info?.kavitaVersion ?? info?.version ?? '(unknown)'}`);
    console.log(`   OS:           ${info?.os ?? '(unknown)'}`);
  } else {
    warn('Server info returned non-200 (non-fatal, informational endpoint)', `HTTP ${r.status}`);
  }
} catch (err) {
  warn('Server info failed (non-fatal)', (err as Error).message);
}

// ── [ 7 ] phobosDocs library ──────────────────────────────────────────────────

console.log('\n[ 7/10 ] phobosDocs library...');
try {
  const libs = await listLibraries();
  ok('GET /api/Library → ok', true);
  const phobosDocs = libs.find(l => l.name === PHOBOSDOCS_LIB_NAME);
  ok('phobosDocs library exists', !!phobosDocs);
  if (phobosDocs) {
    console.log(`   ID:      ${phobosDocs.id}`);
    console.log(`   Type:    ${phobosDocs.type} (books)`);
    console.log(`   Folders: ${phobosDocs.folders.join(', ')}`);
    console.log(`   Series:  ${phobosDocs.series}`);
    ok('phobosDocs folder exists on disk', phobosDocs.folders.some(f => fs.existsSync(f)));
  }
  console.log(`\n   All libraries (${libs.length} total):`);
  for (const lib of libs) {
    console.log(`   · [${lib.id}] ${lib.name} — type ${lib.type} — ${lib.series} series — ${lib.folders[0] ?? '?'}`);
  }
} catch (err) {
  ok('Library list succeeded', false);
  warn('Library list failed', (err as Error).message);
}

// ── [ 8 ] Create test libraries ───────────────────────────────────────────────

console.log('\n[ 8/10 ] Test library create...');

// Check which libraries already exist to avoid duplicates.
let existingNames: string[] = [];
try {
  const libs = await listLibraries();
  existingNames = libs.map(l => l.name);
} catch { /* ignore */ }

// Manga test library pointing at testbooks.
if (!existingNames.includes('Test Manga')) {
  try {
    const lib = await createLibrary('Test Manga', KAVITA_LIB_TYPE.manga, [BOOKS_PATH]);
    ok('Created "Test Manga" library', !!lib.id);
    console.log(`   Created: id=${lib.id}`);
  } catch (err) {
    ok('Created "Test Manga" library', false);
    warn('createLibrary failed', (err as Error).message);
  }
} else {
  console.log('   ℹ️  "Test Manga" already exists — skipping create');
  ok('Test Manga library present', true);
}

// Books test library pointing at testbooks.
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

// ── [ 9 ] Scan + poll ─────────────────────────────────────────────────────────

console.log('\n[ 9/10 ] Scan trigger + poll for indexed content...');
try {
  await triggerScan();
  ok('POST /api/Library/scan-all → ok', true);
} catch (err) {
  ok('Scan trigger succeeded', false);
  warn('Scan trigger failed', (err as Error).message);
}

if (bookCount > 0) {
  console.log('   Polling for indexed series (up to 60s)...');
  const deadline = Date.now() + 60_000;
  let seriesCount = 0;
  while (Date.now() < deadline) {
    try {
      const libs = await listLibraries();
      seriesCount = libs.reduce((n, l) => n + l.series, 0);
      if (seriesCount > 0) break;
    } catch { /* still scanning */ }
    process.stdout.write('.');
    await sleep(2_000);
  }
  process.stdout.write('\n');
  console.log(`   Series indexed: ${seriesCount}`);
  ok('At least one series indexed', seriesCount > 0);
} else {
  warn('testbooks is empty — skipping content poll');
  console.log('   ℹ️  Drop files in test-outputs/testbooks and re-run to test indexing.');
}

// ── [ 10 ] Stats API ──────────────────────────────────────────────────────────

console.log('\n[ 10/10 ] Stats API...');
try {
  const stats = await getStats();
  ok('Stats derived from library list → ok', true);
  console.log(`   Libraries:    ${stats.libraryCount}`);
  console.log(`   Total series: ${stats.totalSeries}`);
} catch (err) {
  ok('Stats API succeeded', false);
  warn('Stats failed', (err as Error).message);
}

// ── Shutdown ──────────────────────────────────────────────────────────────────

if (!SKIP_START && !KEEP_RUNNING) {
  console.log('\n⏹  Stopping Kavita...');
  await stopKavita();
  ok('Kavita stopped', getKavitaStatus().state === 'stopped');
  console.log('   ✅ Stopped');
} else {
  console.log('\n   ℹ️  Kavita left running (KAVITA_SKIP_START or KAVITA_KEEP_RUNNING set).');
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
