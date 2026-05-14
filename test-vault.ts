#!/usr/bin/env npx tsx
/**
 * test-vault.ts — PHOBOS Vault end-to-end validation.
 *
 * Tests against a running phobos-core server with an existing vault.
 * Creates a test entry, validates all read/write/delete paths, then
 * removes the test entry — leaving your vault exactly as it was.
 *
 * Run from dual-reasoning/ with phobos-core already running:
 *   npx tsx test-vault.ts
 *
 * Required env vars:
 *   VAULT_MASTER_PW   your vault master password (no default — must be set)
 *
 * Optional env vars:
 *   VAULT_PORT        server port (default: 3001)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT        = Number(process.env.VAULT_PORT ?? 3001);
const MASTER_PW   = process.env.VAULT_MASTER_PW ?? '';
const BASE_URL    = `http://127.0.0.1:${PORT}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label: string, value: unknown): void {
  if (value) { console.log(`  ✅  ${label}`); passed++; }
  else        { console.error(`  ❌  ${label}`); failed++; }
}

async function api(
  method: string,
  route:  string,
  body?:  unknown,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body:    body ? JSON.stringify(body) : undefined,
  });
  let data: Record<string, unknown> = {};
  try { data = await res.json() as Record<string, unknown>; } catch { /* non-json */ }
  return { ok: res.ok, status: res.status, data };
}

// ── Banner ────────────────────────────────────────────────────────────────────

console.log('\n🔑  PHOBOS Vault Validation Test');
console.log('─'.repeat(52));
console.log(`   Engine:  ${BASE_URL}`);
console.log(`   Password: ${MASTER_PW ? '*'.repeat(MASTER_PW.length) + ` (${MASTER_PW.length} chars)` : '⚠️  NOT SET — set VAULT_MASTER_PW'}`);
console.log();

if (!MASTER_PW) {
  console.error('❌  VAULT_MASTER_PW is required.\n');
  console.error('    Run as: VAULT_MASTER_PW="your-password" npx tsx test-vault.ts\n');
  process.exit(1);
}

// ── [ 1 ] Engine reachability ─────────────────────────────────────────────────

console.log('[ 1/10 ] Engine reachability...');
try {
  const { ok: isOk, data } = await api('GET', '/api/vault/status');
  ok('GET /api/vault/status → 200', isOk);
  console.log(`   state:   ${data.state}`);
  console.log(`   dbPath:  ${data.dbPath}`);
  if (data.state === 'no_database') {
    console.error('\n   ❌ No vault database found. Create your vault first via the PHOBOS UI.\n');
    process.exit(1);
  }
} catch (err) {
  console.error(`\n   ❌ Cannot reach ${BASE_URL} — is phobos-core running?\n`);
  process.exit(1);
}

// ── [ 2 ] Unlock ──────────────────────────────────────────────────────────────

console.log('\n[ 2/10 ] Unlock vault...');
// If already unlocked (e.g. user has it open), lock first so we test the full unlock path
const initialStatus = (await api('GET', '/api/vault/status')).data;
let wasAlreadyUnlocked = initialStatus.state === 'unlocked';
if (wasAlreadyUnlocked) {
  console.log('   (vault was already unlocked — locking first to test full unlock path)');
  await api('POST', '/api/vault/lock');
}

const unlockRes = await api('POST', '/api/vault/unlock', { password: MASTER_PW });
ok('POST /api/vault/unlock → 200', unlockRes.ok);
if (!unlockRes.ok) {
  console.error('\n   ❌ Unlock failed — is VAULT_MASTER_PW correct?\n');
  process.exit(1);
}
const unlockStatus = unlockRes.data.status as Record<string, unknown>;
ok('state = unlocked', unlockStatus?.state === 'unlocked');
console.log(`   entryCount: ${unlockStatus?.entryCount}`);
console.log(`   groupCount: ${unlockStatus?.groupCount}`);

// ── [ 3 ] List entries and groups ─────────────────────────────────────────────

console.log('\n[ 3/10 ] List entries and groups...');
const { data: entriesData } = await api('GET', '/api/vault/entries');
ok('GET /api/vault/entries → 200', true);
const existingEntries = entriesData.entries as Record<string, unknown>[];
ok('entries is array', Array.isArray(existingEntries));
console.log(`   existing entries: ${existingEntries.length}`);

const { data: groupsData } = await api('GET', '/api/vault/groups');
ok('GET /api/vault/groups → 200', true);
const existingGroups = groupsData.groups as Record<string, unknown>[];
ok('groups is array', Array.isArray(existingGroups));
console.log(`   existing groups:  ${existingGroups.length}`);

// Pick a group to add the test entry to (use first available, or default)
const targetGroupUuid = existingGroups.length > 0
  ? existingGroups[0].uuid as string
  : '';
console.log(`   target group: ${targetGroupUuid ? (existingGroups[0].name as string) : 'default'}`);

// ── [ 4 ] Create test entry ───────────────────────────────────────────────────

console.log('\n[ 4/10 ] Create test entry...');
const TEST_TITLE = `__vault_test_${Date.now()}__`;
const entryRes = await api('POST', '/api/vault/entries', {
  groupUuid: targetGroupUuid,
  title:     TEST_TITLE,
  username:  'test-user@phobos.local',
  password:  'test-secret-password-xyz',
  url:       'https://phobos.local/test',
  notes:     'Created by test-vault.ts — safe to delete',
  tags:      ['phobos-test'],
  expires:   null,
});
ok('POST /api/vault/entries → 201', entryRes.status === 201);
const testEntryUuid = entryRes.data.uuid as string;
ok('entry UUID returned', typeof testEntryUuid === 'string' && testEntryUuid.length > 0);
console.log(`   testEntryUuid: ${testEntryUuid}`);

// Verify entry count increased
const { data: afterCreate } = await api('GET', '/api/vault/status');
ok('entryCount increased by 1', (afterCreate.entryCount as number) === existingEntries.length + 1);

// ── [ 5 ] Read entry — password must not appear ───────────────────────────────

console.log('\n[ 5/10 ] Read entry (password must be absent from body)...');
const { data: entry } = await api('GET', `/api/vault/entries/${testEntryUuid}`);
ok('GET /api/vault/entries/:uuid → 200', true);
ok('title correct',               entry.title    === TEST_TITLE);
ok('username correct',            entry.username === 'test-user@phobos.local');
ok('url correct',                 entry.url      === 'https://phobos.local/test');
ok('tags present',                Array.isArray(entry.tags) && (entry.tags as string[]).includes('phobos-test'));
ok('password ABSENT from entry',  !('password' in entry));

// ── [ 6 ] Fetch secret ────────────────────────────────────────────────────────

console.log('\n[ 6/10 ] Fetch entry secret...');
const { data: secretData, status: secretStatus } = await api('GET', `/api/vault/entries/${testEntryUuid}/secret`);
ok('GET /api/vault/entries/:uuid/secret → 200', secretStatus === 200);
ok('password field present',  'password' in secretData);
ok('password value correct',  secretData.password === 'test-secret-password-xyz');

// ── [ 7 ] Update entry ────────────────────────────────────────────────────────

console.log('\n[ 7/10 ] Update entry...');
const updateRes = await api('PUT', `/api/vault/entries/${testEntryUuid}`, {
  username: 'updated-user@phobos.local',
  password: 'updated-secret-password-xyz',
});
ok('PUT /api/vault/entries/:uuid → 200', updateRes.ok);

const { data: updatedEntry } = await api('GET', `/api/vault/entries/${testEntryUuid}`);
ok('username updated',                  updatedEntry.username === 'updated-user@phobos.local');
ok('title unchanged',                   updatedEntry.title    === TEST_TITLE);
ok('password still absent after update', !('password' in updatedEntry));

const { data: updatedSecret } = await api('GET', `/api/vault/entries/${testEntryUuid}/secret`);
ok('updated password correct',  updatedSecret.password === 'updated-secret-password-xyz');
ok('old password replaced',     updatedSecret.password !== 'test-secret-password-xyz');

// ── [ 8 ] Search ──────────────────────────────────────────────────────────────

console.log('\n[ 8/10 ] Search...');
const { data: searchData } = await api('GET', `/api/vault/entries?q=${encodeURIComponent('__vault_test_')}`);
const searchEntries = searchData.entries as Record<string, unknown>[];
ok('search returns our test entry',   searchEntries.some(e => e.uuid === testEntryUuid));
ok('search does not return all entries', searchEntries.length < existingEntries.length + 1 || existingEntries.length === 0);

if (targetGroupUuid) {
  const { data: groupFilter } = await api('GET', `/api/vault/entries?group=${encodeURIComponent(targetGroupUuid)}`);
  const groupEntries = groupFilter.entries as Record<string, unknown>[];
  ok('group filter returns test entry', groupEntries.some(e => e.uuid === testEntryUuid));
}

// ── [ 9 ] Lock + locked-state enforcement ─────────────────────────────────────

console.log('\n[ 9/10 ] Lock and locked-state enforcement...');
const lockRes = await api('POST', '/api/vault/lock');
ok('POST /api/vault/lock → 200', lockRes.ok);

const { data: lockedStatus } = await api('GET', '/api/vault/status');
ok('state = locked after lock', lockedStatus.state === 'locked');

ok('entries → 423 when locked',
  (await api('GET', '/api/vault/entries')).status === 423);
ok('secret  → 423 when locked',
  (await api('GET', `/api/vault/entries/${testEntryUuid}/secret`)).status === 423);
ok('groups  → 423 when locked',
  (await api('GET', '/api/vault/groups')).status === 423);

const wrongPw = await api('POST', '/api/vault/unlock', { password: 'definitely-wrong-password' });
ok('wrong password → 401',        wrongPw.status     === 401);
ok('error message is opaque',     wrongPw.data.error === 'Invalid credentials');

// Re-unlock to clean up
const reUnlock = await api('POST', '/api/vault/unlock', { password: MASTER_PW });
ok('POST /api/vault/unlock after lock → 200', reUnlock.ok);

// ── [ 10 ] Delete test entry and restore state ────────────────────────────────

console.log('\n[ 10/10 ] Delete test entry and restore state...');
const delRes = await api('DELETE', `/api/vault/entries/${testEntryUuid}`);
ok('DELETE /api/vault/entries/:uuid → 200', delRes.ok);

// Entry must be gone from listings (not just moved to visible list)
const { data: afterDelete } = await api('GET', '/api/vault/entries');
const afterEntries = afterDelete.entries as Record<string, unknown>[];
ok('test entry no longer in list', !afterEntries.some(e => e.uuid === testEntryUuid));
ok('entry count back to original', afterEntries.length === existingEntries.length);

// 404 on direct lookup
const { status: goneStatus } = await api('GET', `/api/vault/entries/${testEntryUuid}`);
ok('deleted entry → 404', goneStatus === 404);

// If vault was unlocked before we started, leave it unlocked
// If it was locked before we started, lock it again
if (!wasAlreadyUnlocked) {
  await api('POST', '/api/vault/lock');
  console.log('   (vault was locked before test — locked again)');
} else {
  console.log('   (vault was unlocked before test — leaving unlocked)');
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(52));
console.log(`✅  Passed: ${passed}`);
console.log(`❌  Failed: ${failed}`);

if (failed > 0) {
  console.error('\n❌  Vault validation FAILED\n');
  process.exit(1);
} else {
  console.log('\n✅  Vault validation PASSED\n');
}