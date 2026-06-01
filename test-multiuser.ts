#!/usr/bin/env npx tsx
/**
 * test-multiuser.ts — PHOBOS Multi-User Integration Test
 *
 * Tests the full user management lifecycle against a running phobos-core.
 * Cleans up after itself — all test users and codes created are removed.
 *
 * Phases:
 *   1  Engine reachability + activeUser/activeUserRole in /api/status
 *   2  Management auth (setup or login)
 *   3  User listing
 *   4  Create test users (full + guest) — verify admin role blocked
 *   5  Directory structure verification (phobosVideos, phobosPhotos, phobosDocs)
 *   6  Update user (patch display name / role)
 *   7  Reprovision
 *   8  Access codes — admin generation (guest + self)
 *   9  Access codes — full-user invite route (guest only, self blocked)
 *  10  Access codes — revocation
 *  11  Guards (delete owner blocked, admin role creation blocked)
 *  12  Switch user (in-process — poll for completion)
 *  13  Delete test users — verify clean removal
 *  14  Instance identity
 *
 * Run with phobos-core already running:
 *   MGMT_PASSWORD="your-password" npx tsx test-multiuser.ts
 *
 * Optional env vars:
 *   PHOBOS_PORT      server port (default: 3001)
 *   MGMT_PASSWORD    management panel password (required)
 *   SKIP_DIRS        set to '1' to skip filesystem directory checks
 */

export {};

import * as fs   from 'node:fs';
import * as os   from 'node:os';
import * as path from 'node:path';

const PORT    = Number(process.env.PHOBOS_PORT ?? 3001);
const MGMT_PW = process.env.MGMT_PASSWORD ?? '';
const BASE    = `http://127.0.0.1:${PORT}`;
const SKIP_DIRS = process.env.SKIP_DIRS === '1';
const PHOBOS_DIR = path.join(os.homedir(), '.phobos');

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label: string, value: unknown): void {
  if (value) { console.log(`  ✅  ${label}`); passed++; }
  else        { console.error(`  ❌  ${label}`); failed++; }
}

function skip(label: string, reason: string): void {
  console.log(`  ⏭️   ${label} — ${reason}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
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
console.log('─'.repeat(56));
console.log(`   Engine:   ${BASE}`);
console.log(`   Password: ${MGMT_PW ? '*'.repeat(MGMT_PW.length) + ` (${MGMT_PW.length} chars)` : '⚠️  NOT SET'}`);
console.log(`   Skip dirs: ${SKIP_DIRS}`);
console.log();

if (!MGMT_PW) {
  console.error('❌  MGMT_PASSWORD is required.\n');
  console.error('    Run as: MGMT_PASSWORD="your-password" npx tsx test-multiuser.ts\n');
  process.exit(1);
}

// ── [ 1 ] Engine reachability ─────────────────────────────────────────────────

console.log('[ 1 ] Engine reachability...');
let activeUser = 'owner';
try {
  const { ok: isOk, data } = await api('GET', '/api/status');
  ok('GET /api/status → 200', isOk);
  ok('activeUser present',     typeof data.activeUser === 'string');
  ok('activeUserRole present', typeof data.activeUserRole === 'string');
  const phase = data.bootPhase as string;
  if (phase === 'ready') {
    ok('bootPhase = ready', true);
  } else {
    console.log(`   ⚠️  bootPhase = ${phase} (services still starting — non-fatal)`);
  }
  activeUser = data.activeUser as string ?? 'owner';
  console.log(`   activeUser:     ${data.activeUser}`);
  console.log(`   activeUserRole: ${data.activeUserRole}`);
  console.log(`   bootPhase:      ${data.bootPhase}`);
} catch {
  console.error(`\n   ❌ Cannot reach ${BASE} — is phobos-core running?\n`);
  process.exit(1);
}

// ── [ 2 ] Management auth ─────────────────────────────────────────────────────

console.log('\n[ 2 ] Management auth...');
let token = '';

const statusRes  = await api('GET', '/api/admin/status');
const passwordSet = statusRes.data.passwordSet as boolean;

if (!passwordSet) {
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

const badAuthRes = await api('POST', '/api/admin/auth', { password: 'wrong-pw-xyz' });
ok('wrong password → 401', badAuthRes.status === 401);

const noTokenRes = await api('GET', '/api/admin/users');
ok('protected route without token → 401', noTokenRes.status === 401);

// ── [ 3 ] User listing ────────────────────────────────────────────────────────

console.log('\n[ 3 ] User listing...');
const listRes    = await api('GET', '/api/admin/users', undefined, token);
ok('GET /api/admin/users → 200', listRes.ok);
ok('users is array', Array.isArray(listRes.data.users));
const usersBefore = listRes.data.users as Array<{ username: string; role: string }>;
ok('owner is in users list', usersBefore.some(u => u.username === 'owner'));
console.log(`   users before test: ${usersBefore.map(u => `${u.username}(${u.role})`).join(', ')}`);

// ── [ 4 ] Create test users ───────────────────────────────────────────────────

console.log('\n[ 4 ] Create test users...');
const TS          = Date.now().toString(36);
const TEST_FULL   = `phobos-full-${TS}`;
const TEST_GUEST  = `phobos-guest-${TS}`;

// Create full user
const createFull = await api('POST', '/api/admin/users', {
  username:     TEST_FULL,
  display_name: 'Test Full User',
  role:         'full',
}, token);
ok('POST /api/admin/users (full) → 201', createFull.status === 201);
ok('username matches',   (createFull.data.user as Record<string,unknown>)?.username === TEST_FULL);
ok('role is full',       (createFull.data.user as Record<string,unknown>)?.role === 'full');
ok('jellyfinOk boolean', typeof createFull.data.jellyfinOk === 'boolean');
ok('kavitaOk boolean',   typeof createFull.data.kavitaOk   === 'boolean');
console.log(`   jellyfinOk: ${createFull.data.jellyfinOk}  kavitaOk: ${createFull.data.kavitaOk}`);
if ((createFull.data.errors as string[])?.length) {
  console.log(`   errors: ${(createFull.data.errors as string[]).join('; ')}`);
}

// Create guest user
const createGuest = await api('POST', '/api/admin/users', {
  username:     TEST_GUEST,
  display_name: 'Test Guest',
  role:         'guest',
}, token);
ok('POST /api/admin/users (guest) → 201', createGuest.status === 201);
ok('role is guest', (createGuest.data.user as Record<string,unknown>)?.role === 'guest');

// Admin role must be blocked
const createAdmin = await api('POST', '/api/admin/users', {
  username:     `phobos-badmin-${TS}`,
  display_name: 'Should Not Exist',
  role:         'admin',
}, token);
ok('create admin role from panel → 400', createAdmin.status === 400);

// Duplicate blocked
const dupeRes = await api('POST', '/api/admin/users', {
  username:     TEST_FULL,
  display_name: 'Dupe',
  role:         'full',
}, token);
ok('duplicate username → 409', dupeRes.status === 409);

// Both in listing
const listRes2  = await api('GET', '/api/admin/users', undefined, token);
const usersNow  = listRes2.data.users as Array<{ username: string }>;
ok('full user in listing',  usersNow.some(u => u.username === TEST_FULL));
ok('guest user in listing', usersNow.some(u => u.username === TEST_GUEST));

// ── [ 5 ] Directory structure ─────────────────────────────────────────────────

console.log('\n[ 5 ] Directory structure...');
if (SKIP_DIRS) {
  skip('Directory checks', 'SKIP_DIRS=1');
} else {
  const checkDir = (username: string, service: string, folder: string) => {
    const p = path.join(PHOBOS_DIR, 'media', service, username, folder);
    ok(`media/${service}/${username}/${folder} exists`, fs.existsSync(p));
    return p;
  };

  // Owner dirs are created at runtime by service managers, not by UserProvisioner.
  // Kavita creates owner/phobosDocs on first startKavita(). Check only if it exists.
  ok('owner phobosVideos', fs.existsSync(path.join(PHOBOS_DIR, 'media', 'jellyfin', 'owner', 'phobosVideos')));
  ok('owner phobosPhotos', fs.existsSync(path.join(PHOBOS_DIR, 'media', 'meridian', 'owner', 'phobosPhotos')));
  const ownerDocsPath = path.join(PHOBOS_DIR, 'media', 'kavita', 'owner', 'phobosDocs');
  if (fs.existsSync(ownerDocsPath)) {
    ok('owner phobosDocs', true);
  } else {
    console.log(`   ℹ️  owner phobosDocs not yet created (requires Kavita first-run) — skipping`);
  }

  // Full user directories
  checkDir(TEST_FULL,  'jellyfin', 'phobosVideos');
  checkDir(TEST_FULL,  'meridian', 'phobosPhotos');
  checkDir(TEST_FULL,  'kavita',   'phobosDocs');

  // Guest user directories
  checkDir(TEST_GUEST, 'jellyfin', 'phobosVideos');
  checkDir(TEST_GUEST, 'meridian', 'phobosPhotos');
  checkDir(TEST_GUEST, 'kavita',   'phobosDocs');
}

// ── [ 6 ] Update user ────────────────────────────────────────────────────────

console.log('\n[ 6 ] Update user...');
const patchRes = await api('PATCH', `/api/admin/users/${TEST_FULL}`, {
  display_name: 'Updated Full User',
  role:         'guest',
}, token);
ok('PATCH /api/admin/users/:username → 200', patchRes.ok);
ok('display_name updated', (patchRes.data.user as Record<string,unknown>)?.display_name === 'Updated Full User');
ok('role updated to guest', (patchRes.data.user as Record<string,unknown>)?.role === 'guest');

// Patch back to full for reprovision test
await api('PATCH', `/api/admin/users/${TEST_FULL}`, { role: 'full' }, token);

const patchBadRes = await api('PATCH', '/api/admin/users/nonexistent-xyz', { display_name: 'Ghost' }, token);
ok('PATCH non-existent → 404', patchBadRes.status === 404);

// ── [ 7 ] Reprovision ────────────────────────────────────────────────────────

console.log('\n[ 7 ] Reprovision...');
const reprovRes = await api('POST', `/api/admin/users/${TEST_FULL}/reprovision`, undefined, token);
ok('POST /api/admin/users/:username/reprovision → 200', reprovRes.ok);
ok('jellyfinOk boolean', typeof reprovRes.data.jellyfinOk === 'boolean');
ok('kavitaOk boolean',   typeof reprovRes.data.kavitaOk   === 'boolean');
console.log(`   reprovision jellyfinOk: ${reprovRes.data.jellyfinOk}`);
console.log(`   reprovision kavitaOk:   ${reprovRes.data.kavitaOk}`);

// ── [ 8 ] Access codes — admin ────────────────────────────────────────────────

console.log('\n[ 8 ] Access codes — admin...');
const codeListBefore = await api('GET', '/api/admin/access-codes', undefined, token);
ok('GET /api/admin/access-codes → 200', codeListBefore.ok);
ok('codes is array', Array.isArray(codeListBefore.data.codes));

const guestCodeRes = await api('POST', '/api/admin/access-codes', {
  code_type: 'guest', expires_in_hours: 24,
}, token);
ok('POST admin/access-codes (guest) → 201', guestCodeRes.status === 201);
const guestCode    = guestCodeRes.data.code as Record<string, unknown>;
const guestNonce   = guestCode?.nonce as string;
ok('nonce is 32-char hex',      /^[0-9a-f]{32}$/.test(guestNonce ?? ''));
ok('encoded starts PH1.GST',    (guestCode?.encoded_code as string)?.startsWith('PH1.GST.'));
console.log(`   guest nonce: ${guestNonce}`);

const selfCodeRes = await api('POST', '/api/admin/access-codes', {
  code_type: 'self', expires_in_hours: 168,
}, token);
ok('POST admin/access-codes (self) → 201', selfCodeRes.status === 201);
ok('self encoded starts PH1.OWN', ((selfCodeRes.data.code as Record<string,unknown>)?.encoded_code as string)?.startsWith('PH1.OWN.'));

const codeListAfter = await api('GET', '/api/admin/access-codes', undefined, token);
const codesAfter    = codeListAfter.data.codes as Array<{ code: string; consumed: boolean; encoded_code: string }>;
ok('guest code in listing',    codesAfter.some(c => c.code === guestNonce));
ok('guest code not consumed',  codesAfter.find(c => c.code === guestNonce)?.consumed === false);

// ── [ 9 ] Access codes — full-user invite route ───────────────────────────────

console.log('\n[ 9 ] Access codes — full-user invite route...');

// full users can generate guest codes via /api/user/invite (no panel token)
// We simulate this by hitting the endpoint with x-webrtc-role: full header.
// In real usage DataChannelHandler stamps this from the WebRTC session.
const inviteRes = await fetch(`${BASE}/api/user/invite`, {
  method:  'POST',
  headers: {
    'Content-Type':   'application/json',
    'x-webrtc-user':  TEST_FULL,
    'x-webrtc-role':  'full',
  },
  body: JSON.stringify({ code_type: 'guest', expires_in_hours: 24 }),
});
const inviteData = await inviteRes.json() as Record<string, unknown>;
ok('POST /api/user/invite (full→guest) → 201', inviteRes.status === 201);
ok('invite nonce present', typeof (inviteData.code as Record<string,unknown>)?.nonce === 'string');
ok('invite encoded starts PH1.GST', ((inviteData.code as Record<string,unknown>)?.encoded_code as string)?.startsWith('PH1.GST.'));
console.log(`   invite nonce: ${(inviteData.code as Record<string,unknown>)?.nonce}`);

// full users cannot generate self codes
const inviteSelfRes = await fetch(`${BASE}/api/user/invite`, {
  method:  'POST',
  headers: {
    'Content-Type':  'application/json',
    'x-webrtc-user': TEST_FULL,
    'x-webrtc-role': 'full',
  },
  body: JSON.stringify({ code_type: 'self', expires_in_hours: 1 }),
});
ok('POST /api/user/invite (full→self) → 403', inviteSelfRes.status === 403);

// guest users cannot use /api/user/invite at all (RBAC blocks before route)
const inviteGuestRes = await fetch(`${BASE}/api/user/invite`, {
  method:  'POST',
  headers: {
    'Content-Type':  'application/json',
    'x-webrtc-user': TEST_GUEST,
    'x-webrtc-role': 'guest',
  },
  body: JSON.stringify({ code_type: 'guest', expires_in_hours: 1 }),
});
ok('POST /api/user/invite (guest) → 403', inviteGuestRes.status === 403);

// ── [ 10 ] Access codes — revocation ─────────────────────────────────────────

console.log('\n[ 10 ] Access codes — revocation...');
const revokeRes = await api('DELETE', `/api/admin/access-codes/${guestNonce}`, undefined, token);
ok('DELETE /api/admin/access-codes/:nonce → 200', revokeRes.ok);

const codeListRevoked = await api('GET', '/api/admin/access-codes', undefined, token);
const revokedCode     = (codeListRevoked.data.codes as Array<{ code: string; consumed: boolean }>)
  .find(c => c.code === guestNonce);
ok('revoked code shows consumed=true', revokedCode?.consumed === true);

const badRevokeRes = await api('DELETE', '/api/admin/access-codes/0000000000000000000000000000ffff', undefined, token);
ok('revoke non-existent → 404', badRevokeRes.status === 404);

// ── [ 11 ] Guards ─────────────────────────────────────────────────────────────

console.log('\n[ 11 ] Guards...');
const deleteOwnerRes = await api('DELETE', '/api/admin/users/owner', undefined, token);
ok('DELETE owner → 403', deleteOwnerRes.status === 403);

const patchOwnerRoleRes = await api('PATCH', '/api/admin/users/owner', { role: 'guest' }, token);
ok('PATCH owner role → 403', patchOwnerRoleRes.status === 403);

// ── [ 12 ] Switch user ────────────────────────────────────────────────────────

console.log('\n[ 12 ] Switch user...');
const switchRes = await api('POST', '/api/admin/switch-user', { username: TEST_FULL }, token);
ok('POST /api/admin/switch-user → 200', switchRes.ok);
ok('switchingTo in response', switchRes.data.switchingTo === TEST_FULL);

// Poll /api/admin/status until activeUser changes or 5s timeout.
console.log('   Polling for switch completion...');
let switched = false;
const switchDeadline = Date.now() + 5_000;
while (Date.now() < switchDeadline) {
  await sleep(300);
  const s = await api('GET', '/api/admin/status');
  if ((s.data.activeUser as string) === TEST_FULL) { switched = true; break; }
}
ok(`activeUser switched to ${TEST_FULL}`, switched);

// Switch back to original user.
const switchBackRes = await api('POST', '/api/admin/switch-user', { username: activeUser }, token);
ok(`switch back to ${activeUser}`, switchBackRes.ok);
let switchedBack = false;
const switchBackDeadline = Date.now() + 5_000;
while (Date.now() < switchBackDeadline) {
  await sleep(300);
  const s = await api('GET', '/api/admin/status');
  if ((s.data.activeUser as string) === activeUser) { switchedBack = true; break; }
}
ok(`activeUser restored to ${activeUser}`, switchedBack);

// ── [ 13 ] Delete test users ──────────────────────────────────────────────────

console.log('\n[ 13 ] Delete test users...');
const delFullRes  = await api('DELETE', `/api/admin/users/${TEST_FULL}`, undefined, token);
ok(`DELETE ${TEST_FULL} → 200`, delFullRes.ok);
ok('no stale note field', delFullRes.data.note === undefined);

const delGuestRes = await api('DELETE', `/api/admin/users/${TEST_GUEST}`, undefined, token);
ok(`DELETE ${TEST_GUEST} → 200`, delGuestRes.ok);

const listAfterDel = await api('GET', '/api/admin/users', undefined, token);
const usersAfterDel = listAfterDel.data.users as Array<{ username: string }>;
ok('full user removed from listing',  !usersAfterDel.some(u => u.username === TEST_FULL));
ok('guest user removed from listing', !usersAfterDel.some(u => u.username === TEST_GUEST));

// Verify directories are cleaned up.
if (!SKIP_DIRS) {
  ok(`${TEST_FULL} media dirs removed`,  !fs.existsSync(path.join(PHOBOS_DIR, 'media', 'jellyfin', TEST_FULL)));
  ok(`${TEST_GUEST} media dirs removed`, !fs.existsSync(path.join(PHOBOS_DIR, 'media', 'jellyfin', TEST_GUEST)));
  ok(`${TEST_FULL} user db removed`,     !fs.existsSync(path.join(PHOBOS_DIR, 'users', TEST_FULL)));
  ok(`${TEST_GUEST} user db removed`,    !fs.existsSync(path.join(PHOBOS_DIR, 'users', TEST_GUEST)));
}

// ── [ 14 ] Instance identity ──────────────────────────────────────────────────

console.log('\n[ 14 ] Instance identity...');
const webrtcCodeRes = await api('GET', '/api/webrtc/code');
ok('GET /api/webrtc/code → 200',     webrtcCodeRes.ok);
ok('connected boolean',              typeof webrtcCodeRes.data.connected === 'boolean');
ok('relayConnected boolean',         typeof webrtcCodeRes.data.relayConnected === 'boolean');
console.log(`   instanceId:     ${webrtcCodeRes.data.instanceId ?? '(relay offline)'}`);
console.log(`   relayConnected: ${webrtcCodeRes.data.relayConnected}`);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(56));
console.log(`✅  Passed: ${passed}`);
console.log(`❌  Failed: ${failed}`);

if (failed > 0) {
  console.error('\n❌  Multi-user validation FAILED\n');
  process.exit(1);
} else {
  console.log('\n✅  Multi-user validation PASSED\n');
}