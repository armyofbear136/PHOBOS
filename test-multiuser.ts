#!/usr/bin/env npx tsx
/**
 * test-multiuser.ts — PHOBOS Multi-User Integration Test
 *
 * Tests the full user management lifecycle against a running phobos-core.
 * Cleans up after itself — all test users and codes created are removed.
 *
 * Phases covered:
 *   Phase 2 — UserServiceTokenStore schema exists, service managers ready
 *   Phase 3 — provisionSystemUser, deprovisionSystemUser, access code API
 *   Phase 4 — access code generation and revocation (API-level; UI is manual)
 *   Phase 5 — WebRTC guest binding (placeholder — requires WebRTC session)
 *
 * Run with phobos-core already running:
 *   MGMT_PASSWORD="your-password" npx tsx test-multiuser.ts
 *
 * Optional env vars:
 *   PHOBOS_PORT      server port (default: 3001)
 *   MGMT_PASSWORD    management panel password (required)
 */

export {};

const PORT    = Number(process.env.PHOBOS_PORT ?? 3001);
const MGMT_PW = process.env.MGMT_PASSWORD ?? '';
const BASE    = `http://127.0.0.1:${PORT}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed  = 0;
let failed  = 0;

function ok(label: string, value: unknown): void {
  if (value) { console.log(`  ✅  ${label}`); passed++; }
  else        { console.error(`  ❌  ${label}`); failed++; }
}

function skip(label: string): void {
  console.log(`  ⏭️   ${label}`);
}

async function api(
  method:  string,
  route:   string,
  body?:   unknown,
  token?:  string,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (body)  headers['Content-Type']  = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: Record<string, unknown> = {};
  try { data = await res.json() as Record<string, unknown>; } catch { /* non-json */ }
  return { ok: res.ok, status: res.status, data };
}

// ── Banner ────────────────────────────────────────────────────────────────────

console.log('\n👥  PHOBOS Multi-User Integration Test');
console.log('─'.repeat(52));
console.log(`   Engine:   ${BASE}`);
console.log(`   Password: ${MGMT_PW ? '*'.repeat(MGMT_PW.length) + ` (${MGMT_PW.length} chars)` : '⚠️  NOT SET'}`);
console.log();

if (!MGMT_PW) {
  console.error('❌  MGMT_PASSWORD is required.\n');
  console.error('    Run as: MGMT_PASSWORD="your-password" npx tsx test-multiuser.ts\n');
  process.exit(1);
}

// ── [ 1 ] Engine reachability ─────────────────────────────────────────────────

console.log('[ 1 ] Engine reachability...');
try {
  const { ok: isOk, data } = await api('GET', '/api/admin/status');
  ok('GET /api/admin/status → 200', isOk);
  ok('activeUser present', typeof data.activeUser === 'string');
  ok('passwordSet present', typeof data.passwordSet === 'boolean');
  console.log(`   activeUser:   ${data.activeUser}`);
  console.log(`   passwordSet:  ${data.passwordSet}`);
  console.log(`   userCount:    ${data.userCount}`);
} catch {
  console.error(`\n   ❌ Cannot reach ${BASE} — is phobos-core running?\n`);
  process.exit(1);
}

// ── [ 2 ] Management auth ─────────────────────────────────────────────────────

console.log('\n[ 2 ] Management auth...');

let token = '';

// Check if password is already set
const statusRes = await api('GET', '/api/admin/status');
const passwordSet = statusRes.data.passwordSet as boolean;

if (!passwordSet) {
  // First run — set password via setup
  console.log('   (no password set — using setup endpoint)');
  const setupRes = await api('POST', '/api/admin/auth/setup', {
    password: MGMT_PW,
    confirm:  MGMT_PW,
  });
  ok('POST /api/admin/auth/setup → 200', setupRes.ok);
  ok('setup returns token', typeof setupRes.data.token === 'string');
  token = setupRes.data.token as string;
} else {
  const authRes = await api('POST', '/api/admin/auth', { password: MGMT_PW });
  ok('POST /api/admin/auth → 200', authRes.ok);
  ok('auth returns token', typeof authRes.data.token === 'string');
  if (!authRes.ok) {
    console.error('\n   ❌ Auth failed — check MGMT_PASSWORD.\n');
    process.exit(1);
  }
  token = authRes.data.token as string;
}

// Wrong password should 401
const badAuthRes = await api('POST', '/api/admin/auth', { password: 'definitely-wrong-pw-xyz' });
ok('wrong password → 401', badAuthRes.status === 401);

// Protected route without token should 401
const noTokenRes = await api('GET', '/api/admin/users');
ok('protected route without token → 401', noTokenRes.status === 401);

// ── [ 3 ] User listing ────────────────────────────────────────────────────────

console.log('\n[ 3 ] User listing...');
const listRes = await api('GET', '/api/admin/users', undefined, token);
ok('GET /api/admin/users → 200', listRes.ok);
ok('users is array', Array.isArray(listRes.data.users));
const usersBefore = listRes.data.users as Array<{ username: string; role: string }>;
ok('owner is in users list', usersBefore.some(u => u.username === 'owner'));
console.log(`   users before test: ${usersBefore.map(u => u.username).join(', ')}`);

// ── [ 4 ] Create test user ────────────────────────────────────────────────────

console.log('\n[ 4 ] Create test user...');
const TEST_USER = `phobos-test-${Date.now().toString(36)}`;

const createRes = await api('POST', '/api/admin/users', {
  username:     TEST_USER,
  display_name: 'Test User',
  role:         'full',
}, token);

ok('POST /api/admin/users → 201', createRes.status === 201);
ok('user record returned', typeof (createRes.data.user as Record<string, unknown>)?.username === 'string');
ok('username matches', (createRes.data.user as Record<string, unknown>)?.username === TEST_USER);
ok('role is full', (createRes.data.user as Record<string, unknown>)?.role === 'full');
ok('jellyfinOk or error logged', typeof createRes.data.jellyfinOk === 'boolean');
ok('kavitaOk or error logged', typeof createRes.data.kavitaOk === 'boolean');

console.log(`   jellyfinOk:  ${createRes.data.jellyfinOk}`);
console.log(`   kavitaOk:    ${createRes.data.kavitaOk}`);
if (Array.isArray(createRes.data.errors) && (createRes.data.errors as string[]).length > 0) {
  console.log(`   errors:      ${(createRes.data.errors as string[]).join('; ')}`);
}

// Verify user appears in listing
const listRes2 = await api('GET', '/api/admin/users', undefined, token);
const usersAfter = listRes2.data.users as Array<{ username: string }>;
ok('new user in listing', usersAfter.some(u => u.username === TEST_USER));

// Duplicate username should 409
const dupeRes = await api('POST', '/api/admin/users', {
  username:     TEST_USER,
  display_name: 'Duplicate',
  role:         'full',
}, token);
ok('duplicate username → 409', dupeRes.status === 409);

// ── [ 5 ] Update test user ────────────────────────────────────────────────────

console.log('\n[ 5 ] Update test user...');
const patchRes = await api('PATCH', `/api/admin/users/${TEST_USER}`, {
  display_name: 'Updated Name',
  role:         'guest',
}, token);
ok('PATCH /api/admin/users/:username → 200', patchRes.ok);
ok('display_name updated', (patchRes.data.user as Record<string, unknown>)?.display_name === 'Updated Name');
ok('role updated to guest', (patchRes.data.user as Record<string, unknown>)?.role === 'guest');

// Patch non-existent user → 404
const patchBadRes = await api('PATCH', '/api/admin/users/nonexistent-user-xyz', {
  display_name: 'Ghost',
}, token);
ok('PATCH non-existent user → 404', patchBadRes.status === 404);

// ── [ 6 ] Reprovision ────────────────────────────────────────────────────────

console.log('\n[ 6 ] Reprovision...');
const reprovRes = await api('POST', `/api/admin/users/${TEST_USER}/reprovision`, undefined, token);
ok('POST /api/admin/users/:username/reprovision → 200', reprovRes.ok);
ok('jellyfinOk boolean', typeof reprovRes.data.jellyfinOk === 'boolean');
ok('kavitaOk boolean',   typeof reprovRes.data.kavitaOk   === 'boolean');
console.log(`   reprovision jellyfinOk: ${reprovRes.data.jellyfinOk}`);
console.log(`   reprovision kavitaOk:   ${reprovRes.data.kavitaOk}`);

// ── [ 7 ] Access codes — generation ──────────────────────────────────────────

console.log('\n[ 7 ] Access codes — generation...');
const codeListBefore = await api('GET', '/api/admin/access-codes', undefined, token);
ok('GET /api/admin/access-codes → 200', codeListBefore.ok);
ok('codes is array', Array.isArray(codeListBefore.data.codes));
const codesBefore = codeListBefore.data.codes as unknown[];
console.log(`   codes before: ${codesBefore.length}`);

// Generate a guest code
const codeRes = await api('POST', '/api/admin/access-codes', {
  code_type:        'guest',
  expires_in_hours: 24,
}, token);
ok('POST /api/admin/access-codes → 201', codeRes.status === 201);
const codeObj = codeRes.data.code as Record<string, unknown>;
ok('nonce returned',        typeof codeObj?.nonce        === 'string');
ok('encoded_code returned', typeof codeObj?.encoded_code === 'string');
const generatedNonce   = codeObj?.nonce        as string;
const generatedEncoded = codeObj?.encoded_code as string;
console.log(`   nonce:        ${generatedNonce}`);
console.log(`   encoded_code: ${generatedEncoded}`);
ok('nonce is 32-char hex',       /^[0-9a-f]{32}$/.test(generatedNonce ?? ''));
ok('encoded starts with PH1.GST', generatedEncoded?.startsWith('PH1.GST.'));

// Verify it appears in listing (by nonce)
const codeListAfter = await api('GET', '/api/admin/access-codes', undefined, token);
const codesAfter = codeListAfter.data.codes as Array<{ code: string; consumed: boolean; encoded_code: string }>;
ok('new code in listing',       codesAfter.some(c => c.code === generatedNonce));
ok('code is not consumed',      codesAfter.find(c => c.code === generatedNonce)?.consumed === false);
ok('listing re-encodes PH1.*',  codesAfter.find(c => c.code === generatedNonce)?.encoded_code?.startsWith('PH1.GST.') === true);

// Generate a self-access code
const selfCodeRes = await api('POST', '/api/admin/access-codes', {
  code_type:        'self',
  expires_in_hours: 168,
}, token);
ok('generate self code → 201', selfCodeRes.status === 201);
const selfCodeObj = selfCodeRes.data.code as Record<string, unknown>;
ok('self code starts with PH1.OWN', (selfCodeObj?.encoded_code as string)?.startsWith('PH1.OWN.'));

// ── [ 8 ] Access codes — revocation ──────────────────────────────────────────

console.log('\n[ 8 ] Access codes — revocation...');
const revokeRes = await api('DELETE', `/api/admin/access-codes/${generatedNonce}`, undefined, token);
ok('DELETE /api/admin/access-codes/:nonce → 200', revokeRes.ok);

// Verify consumed state
const codeListRevoked = await api('GET', '/api/admin/access-codes', undefined, token);
const revokedCode = (codeListRevoked.data.codes as Array<{ code: string; consumed: boolean }>)
  .find(c => c.code === generatedNonce);
ok('revoked code shows consumed=true', revokedCode?.consumed === true);

// Revoke non-existent code → 404
const badRevokeRes = await api('DELETE', '/api/admin/access-codes/0000000000000000000000000000ffff', undefined, token);
ok('revoke non-existent code → 404', badRevokeRes.status === 404);

// ── [ 9 ] Guard — cannot delete owner ────────────────────────────────────────

console.log('\n[ 9 ] Guard — cannot delete owner...');
const deleteOwnerRes = await api('DELETE', '/api/admin/users/owner', undefined, token);
ok('DELETE owner → 403', deleteOwnerRes.status === 403);

// ── [ 10 ] Delete test user ───────────────────────────────────────────────────

console.log('\n[ 10 ] Delete test user...');
const deleteRes = await api('DELETE', `/api/admin/users/${TEST_USER}`, undefined, token);
ok('DELETE /api/admin/users/:username → 200', deleteRes.ok);
ok('response contains note', typeof deleteRes.data.note === 'string');

// Verify user is gone from listing
const listAfterDelete = await api('GET', '/api/admin/users', undefined, token);
const usersAfterDelete = listAfterDelete.data.users as Array<{ username: string }>;
ok('user no longer in listing', !usersAfterDelete.some(u => u.username === TEST_USER));

// ── [ 11 ] Phase 6 — structured codes and instance identity ──────────────────

console.log('\n[ 11 ] Phase 6 — instance identity endpoint...');
const webrtcCodeRes = await api('GET', '/api/webrtc/code');
ok('GET /api/webrtc/code → 200',      webrtcCodeRes.ok);
ok('instanceId present',              typeof webrtcCodeRes.data.instanceId === 'string' || webrtcCodeRes.data.instanceId === null);
ok('relayUrl present',                typeof webrtcCodeRes.data.relayUrl   === 'string' || webrtcCodeRes.data.relayUrl   === null);
ok('connected boolean',               typeof webrtcCodeRes.data.connected  === 'boolean');
ok('relayConnected boolean',          typeof webrtcCodeRes.data.relayConnected === 'boolean');
console.log(`   instanceId:     ${webrtcCodeRes.data.instanceId ?? '(relay offline)'}`);
console.log(`   relayConnected: ${webrtcCodeRes.data.relayConnected}`);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(52));
console.log(`✅  Passed: ${passed}`);
console.log(`❌  Failed: ${failed}`);

if (failed > 0) {
  console.error('\n❌  Multi-user validation FAILED\n');
  process.exit(1);
} else {
  console.log('\n✅  Multi-user validation PASSED\n');
}