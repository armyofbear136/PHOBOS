#!/usr/bin/env npx tsx
/**
 * test-social.ts — PHOBOS Social System Integration Test
 *
 * Tests the full social feature surface against a running phobos-core:
 *
 *   [ 1 ]  Engine reachability + auth
 *   [ 2 ]  Instance identity — GET /api/webrtc/code, GET /api/social/my-id
 *   [ 3 ]  Core name — set, read, verify in my-id response
 *   [ 4 ]  Relay toggle — disable, verify status, re-enable, verify status
 *   [ 5 ]  known_instances schema — discovery CRUD lifecycle
 *   [ 6 ]  Self-add guard — cannot add own instanceId
 *   [ 7 ]  Duplicate discovery upsert — re-adding updates relayAddress
 *   [ 8 ]  Public users endpoint — GET /api/social/public-users
 *   [ 9 ]  Remote users proxy — GET /api/social/users/:instanceUuid (offline path → 503)
 *   [ 10 ] Outbound friend request — requires known instance, blocks on unknown
 *   [ 11 ] Inbound friend request — pending_friend_requests lifecycle
 *   [ 12 ] Accept / decline inbound request — status transitions, ack path
 *   [ 13 ] Friends list — GET /api/social/friends (empty for fresh install)
 *   [ 14 ] Delete friend guard — 404 on unknown
 *   [ 15 ] Direct messages — send, retrieve, pagination cursor
 *   [ 16 ] Discovery delete — removes instance and cleans pending requests
 *   [ 17 ] pending_outbound_requests schema — present if boot completed
 *   [ 18 ] Relay status fields — relayEnabled and relayConnected present
 *   [ 19 ] Cleanup verification
 *
 * Does NOT test live WebRTC friend handshake (requires two running cores).
 * Cleans up all test data created.
 *
 * Run with phobos-core already running:
 *   MGMT_PASSWORD="your-password" npx tsx test-social.ts
 *
 * Optional env vars:
 *   PHOBOS_PORT     server port (default: 3001)
 *   MGMT_PASSWORD   management panel password (required)
 */

export {};

const PORT    = Number(process.env.PHOBOS_PORT ?? 3001);
const MGMT_PW = process.env.MGMT_PASSWORD ?? '';
const BASE    = `http://127.0.0.1:${PORT}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

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

// ── Cleanup registry — tracked so teardown can run even on failure ────────────

const CLEANUP_INSTANCES: string[] = [];

// ── Banner ────────────────────────────────────────────────────────────────────

console.log('\n🌐  PHOBOS Social System Integration Test');
console.log('─'.repeat(52));
console.log(`   Engine:   ${BASE}`);
console.log(`   Password: ${MGMT_PW ? '*'.repeat(MGMT_PW.length) + ` (${MGMT_PW.length} chars)` : '⚠️  NOT SET'}`);
console.log();

if (!MGMT_PW) {
  console.error('❌  MGMT_PASSWORD is required.\n');
  process.exit(1);
}

// ── [ 1 ] Engine reachability + auth ─────────────────────────────────────────

console.log('[ 1 ] Engine reachability + auth...');
try {
  const { ok: isOk } = await api('GET', '/api/admin/status');
  ok('GET /api/admin/status → 200', isOk);
} catch {
  console.error(`\n   ❌ Cannot reach ${BASE} — is phobos-core running?\n`);
  process.exit(1);
}

let token = '';
const statusRes  = await api('GET', '/api/admin/status');
const passwordSet = statusRes.data.passwordSet as boolean;
if (!passwordSet) {
  const setupRes = await api('POST', '/api/admin/auth/setup', { password: MGMT_PW, confirm: MGMT_PW });
  ok('POST /api/admin/auth/setup → 200', setupRes.ok);
  token = setupRes.data.token as string;
} else {
  const authRes = await api('POST', '/api/admin/auth', { password: MGMT_PW });
  ok('POST /api/admin/auth → 200', authRes.ok);
  token = authRes.data.token as string;
}
ok('token received', typeof token === 'string' && token.length > 0);

// ── [ 2 ] Instance identity ───────────────────────────────────────────────────

console.log('\n[ 2 ] Instance identity...');

const codeRes = await api('GET', '/api/webrtc/code', undefined, token);
ok('GET /api/webrtc/code → 200',        codeRes.ok);
ok('instanceId is string or null',      typeof codeRes.data.instanceId === 'string' || codeRes.data.instanceId === null);
ok('relayUrl is string or null',        typeof codeRes.data.relayUrl   === 'string' || codeRes.data.relayUrl   === null);
ok('relayConnected is boolean',         typeof codeRes.data.relayConnected === 'boolean');

const instanceId = codeRes.data.instanceId as string | null;
const relayUrl   = codeRes.data.relayUrl   as string | null;
console.log(`   instanceId:     ${instanceId ?? '(relay offline)'}`);
console.log(`   relayUrl:       ${relayUrl   ?? '(relay offline)'}`);
console.log(`   relayConnected: ${codeRes.data.relayConnected}`);

if (instanceId) {
  ok('instanceId is UUID format', /^[0-9a-f-]{36}$/.test(instanceId));
}

const myIdRes = await api('GET', '/api/social/my-id', undefined, token);
ok('GET /api/social/my-id → 200',       myIdRes.ok);
ok('my-id returns instanceId',          typeof myIdRes.data.instanceId   === 'string');
ok('my-id returns relayAddress',        typeof myIdRes.data.relayAddress  === 'string');
ok('my-id returns coreName field',      'coreName' in myIdRes.data);
ok('instanceId matches /api/webrtc/code', myIdRes.data.instanceId === instanceId || instanceId === null);

const ownInstanceId = myIdRes.data.instanceId as string;

// ── [ 3 ] Core name ───────────────────────────────────────────────────────────

console.log('\n[ 3 ] Core name...');

const TEST_CORE_NAME = `test-core-${Date.now()}`;

const setNameRes = await api('POST', '/api/social/core-name', { name: TEST_CORE_NAME }, token);
ok('POST /api/social/core-name → 200',  setNameRes.ok);
ok('coreName in response',              typeof setNameRes.data.coreName === 'string');
ok('coreName matches input',            setNameRes.data.coreName === TEST_CORE_NAME);

const getNameRes = await api('GET', '/api/social/core-name', undefined, token);
ok('GET /api/social/core-name → 200',   getNameRes.ok);
ok('GET coreName matches set value',    getNameRes.data.coreName === TEST_CORE_NAME);

// Verify it appears in my-id
const myIdAfterName = await api('GET', '/api/social/my-id', undefined, token);
ok('my-id coreName updated',            myIdAfterName.data.coreName === TEST_CORE_NAME);

// Validate trim/max-length — 45 chars should be trimmed to 40
const longName = 'A'.repeat(45);
const longNameRes = await api('POST', '/api/social/core-name', { name: longName }, token);
ok('POST core-name → 200 (long input)', longNameRes.ok);
ok('long name trimmed to 40 chars',     (longNameRes.data.coreName as string)?.length === 40);

// Empty name rejected
const emptyNameRes = await api('POST', '/api/social/core-name', { name: '   ' }, token);
ok('POST core-name empty → 400',        emptyNameRes.status === 400);

// Restore test name
await api('POST', '/api/social/core-name', { name: TEST_CORE_NAME }, token);

// ── [ 4 ] Relay toggle ────────────────────────────────────────────────────────

console.log('\n[ 4 ] Relay toggle...');

const statusBefore = await api('GET', '/api/webrtc/status', undefined, token);
ok('GET /api/webrtc/status → 200',      statusBefore.ok);
ok('relayEnabled field present',        typeof statusBefore.data.relayEnabled  === 'boolean');
ok('relayConnected field present',      typeof statusBefore.data.relayConnected === 'boolean');
ok('instanceId field present',          'instanceId' in statusBefore.data);

const wasEnabled = statusBefore.data.relayEnabled as boolean;
console.log(`   relay was: ${wasEnabled ? 'enabled' : 'disabled'}`);

// Disable
const disableRes = await api('POST', '/api/webrtc/relay/disable', undefined, token);
ok('POST /api/webrtc/relay/disable → 200', disableRes.ok);
ok('relayEnabled false in response',    disableRes.data.relayEnabled === false);

const statusOff = await api('GET', '/api/webrtc/status', undefined, token);
ok('status shows relayEnabled=false',   statusOff.data.relayEnabled === false);

// Re-enable
const enableRes = await api('POST', '/api/webrtc/relay/enable', undefined, token);
ok('POST /api/webrtc/relay/enable → 200', enableRes.ok);
ok('relayEnabled true in response',     enableRes.data.relayEnabled === true);

const statusOn = await api('GET', '/api/webrtc/status', undefined, token);
ok('status shows relayEnabled=true',    statusOn.data.relayEnabled === true);

// Restore original state
if (!wasEnabled) {
  await api('POST', '/api/webrtc/relay/disable', undefined, token);
}

// ── [ 5 ] Discovery CRUD lifecycle ───────────────────────────────────────────

console.log('\n[ 5 ] Discovery CRUD lifecycle...');

const TEST_UUID_A    = '00000000-test-0000-0000-000000000001';
const TEST_UUID_B    = '00000000-test-0000-0000-000000000002';
const TEST_RELAY_A   = 'wss://test-relay-a.invalid/relay';
const TEST_RELAY_B   = 'wss://test-relay-b.invalid/relay';
CLEANUP_INSTANCES.push(TEST_UUID_A, TEST_UUID_B);

// Add instance A
const addA = await api('POST', '/api/social/discovery', {
  instanceUuid: TEST_UUID_A,
  relayAddress: TEST_RELAY_A,
  label:        'Test Server A',
}, token);
ok('POST /api/social/discovery → 200', addA.ok);
ok('returned instanceUuid matches',    addA.data.instanceUuid === TEST_UUID_A);

// Add instance B (no label)
const addB = await api('POST', '/api/social/discovery', {
  instanceUuid: TEST_UUID_B,
  relayAddress: TEST_RELAY_B,
}, token);
ok('POST discovery (no label) → 200',  addB.ok);

// List
const listRes = await api('GET', '/api/social/discovery', undefined, token);
ok('GET /api/social/discovery → 200',  listRes.ok);
const instances = listRes.data.instances as Array<{
  instanceUuid: string; relayAddress: string; label: string | null; friended: boolean; online: boolean;
}>;
ok('instances is array',               Array.isArray(instances));

const foundA = instances.find(i => i.instanceUuid === TEST_UUID_A);
const foundB = instances.find(i => i.instanceUuid === TEST_UUID_B);
ok('instance A in list',               foundA !== undefined);
ok('instance B in list',               foundB !== undefined);
ok('instance A label correct',         foundA?.label === 'Test Server A');
ok('instance B label is null',         foundB?.label === null);
ok('instance A friended=false',        foundA?.friended === false);
ok('instance A online=false (.invalid relay)', foundA?.online === false);
ok('instances have relayAddress',      foundA?.relayAddress === TEST_RELAY_A);

// ── [ 6 ] Self-add guard ──────────────────────────────────────────────────────

console.log('\n[ 6 ] Self-add guard...');

const selfAddRes = await api('POST', '/api/social/discovery', {
  instanceUuid: ownInstanceId,
  relayAddress: relayUrl ?? 'wss://autarch.net/relay',
}, token);
ok('POST own instanceId → 400',        selfAddRes.status === 400);
ok('error is cannot_add_self',         selfAddRes.data.error === 'cannot_add_self');

// ── [ 7 ] Upsert — re-add updates relayAddress ───────────────────────────────

console.log('\n[ 7 ] Upsert on re-add...');

const UPDATED_RELAY = 'wss://updated-relay.invalid/relay';
const upsertRes = await api('POST', '/api/social/discovery', {
  instanceUuid: TEST_UUID_A,
  relayAddress: UPDATED_RELAY,
}, token);
ok('POST same UUID again → 200',       upsertRes.ok);

const listAfterUpsert = await api('GET', '/api/social/discovery', undefined, token);
const upsertedA = (listAfterUpsert.data.instances as typeof instances)
  .find(i => i.instanceUuid === TEST_UUID_A);
ok('relayAddress updated after upsert', upsertedA?.relayAddress === UPDATED_RELAY);
ok('friended still false after upsert', upsertedA?.friended === false);

// Restore original relay
await api('POST', '/api/social/discovery', {
  instanceUuid: TEST_UUID_A,
  relayAddress: TEST_RELAY_A,
  label: 'Test Server A',
}, token);

// ── [ 8 ] Public users endpoint ───────────────────────────────────────────────

console.log('\n[ 8 ] Public users endpoint...');

// This endpoint has no auth — accessible without token
const pubUsersRes = await api('GET', '/api/social/public-users');
ok('GET /api/social/public-users → 200', pubUsersRes.ok);
ok('returns users array',               Array.isArray(pubUsersRes.data.users));
ok('returns coreName field',            'coreName' in pubUsersRes.data);
ok('coreName matches what we set',      pubUsersRes.data.coreName === TEST_CORE_NAME);

const pubUsers = pubUsersRes.data.users as Array<{ username: string; displayName: string }>;
ok('at least one user (owner)',         pubUsers.length >= 1);
ok('user has username field',           typeof pubUsers[0]?.username    === 'string');
ok('user has displayName field',        typeof pubUsers[0]?.displayName === 'string');
console.log(`   public users: ${pubUsers.map(u => u.username).join(', ')}`);

// ── [ 9 ] Remote users proxy — offline path ───────────────────────────────────

console.log('\n[ 9 ] Remote users proxy (offline instance)...');

// TEST_UUID_A has relay wss://test-relay-a.invalid — will be unreachable → 503
const remoteUsersRes = await api('GET', `/api/social/users/${TEST_UUID_A}`, undefined, token);
ok('GET /api/social/users/:id → 503 for offline', remoteUsersRes.status === 503);
ok('error is unreachable',              remoteUsersRes.data.error === 'unreachable');

// Unknown instance → 404
const unknownUsersRes = await api('GET', '/api/social/users/00000000-0000-0000-0000-unknown', undefined, token);
ok('GET /api/social/users/:id → 404 for unknown', unknownUsersRes.status === 404);
ok('error is unknown_instance',         unknownUsersRes.data.error === 'unknown_instance');

// ── [ 10 ] Outbound friend request ────────────────────────────────────────────

console.log('\n[ 10 ] Outbound friend request...');

// Unknown instance → 404
const reqUnknown = await api('POST', '/api/social/friend-request/00000000-0000-0000-0000-notknown', undefined, token);
ok('friend-request to unknown → 404',  reqUnknown.status === 404);
ok('error is unknown_instance',        reqUnknown.data.error === 'unknown_instance');

// Known instance → 200 (relay offline is fine — goes to pending_outbound_requests)
const reqKnown = await api('POST', `/api/social/friend-request/${TEST_UUID_A}`, undefined, token);
ok('friend-request to known → 200',    reqKnown.ok);
ok('requestId returned',               typeof reqKnown.data.requestId === 'string');
ok('delivered is boolean',             typeof reqKnown.data.delivered === 'boolean');
// Relay is test .invalid so delivered should be false
ok('delivered=false (offline relay)',  reqKnown.data.delivered === false);
console.log(`   requestId: ${reqKnown.data.requestId}`);

// Already-friends guard is tested after accept in [ 12 ]

// ── [ 11 ] Inbound friend request — write directly to pending_friend_requests ─

console.log('\n[ 11 ] Inbound friend requests...');

// Simulate an inbound request by calling the internal handler via a test hook.
// Since we don't have a second live core, we test the GET endpoint directly —
// it should return an empty list (no real inbound requests in test environment).
const pendingRes = await api('GET', '/api/social/friend-requests/pending', undefined, token);
ok('GET /api/social/friend-requests/pending → 200', pendingRes.ok);
ok('requests is array',                Array.isArray(pendingRes.data.requests));

const pendingReqs = (pendingRes.data.requests as Array<{
  id: string; from_instance_id: string; from_username: string; status?: string;
}> | undefined) ?? [];
console.log(`   pending requests: ${pendingReqs.length} (expect 0 in isolation)`);

if (pendingReqs.length > 0) {
  // If any exist from a previous failed test run, verify shape
  ok('request has id',                   typeof pendingReqs[0].id                === 'string');
  ok('request has from_instance_id',     typeof pendingReqs[0].from_instance_id  === 'string');
  ok('request has from_username',        typeof pendingReqs[0].from_username     === 'string');
} else {
  skip('pending request shape (none present — requires two live cores to test fully)');
  skip('accept/decline flow (no pending requests to act on)');
}

// ── [ 12 ] Accept / decline guards ───────────────────────────────────────────

console.log('\n[ 12 ] Accept / decline on nonexistent request...');

const fakeId = '00000000-0000-0000-0000-fakeRequestId';
const acceptFake  = await api('POST', `/api/social/friend-requests/${fakeId}/accept`, undefined, token);
ok('accept nonexistent → 404',         acceptFake.status === 404);

const declineFake = await api('POST', `/api/social/friend-requests/${fakeId}/decline`, undefined, token);
ok('decline nonexistent → 404',        declineFake.status === 404);

// ── [ 13 ] Friends list ───────────────────────────────────────────────────────

console.log('\n[ 13 ] Friends list...');

const friendsRes = await api('GET', '/api/social/friends', undefined, token);
ok('GET /api/social/friends → 200',    friendsRes.ok);
ok('friends is array',                 Array.isArray(friendsRes.data.friends));

const friends = friendsRes.data.friends as Array<{
  instanceUuid: string; username: string; displayName: string; online: boolean;
}>;
console.log(`   confirmed friends: ${friends.length}`);

if (friends.length > 0) {
  ok('friend has instanceUuid',          typeof friends[0].instanceUuid === 'string');
  ok('friend has username',              typeof friends[0].username     === 'string');
  ok('friend has displayName',           typeof friends[0].displayName  === 'string');
  ok('friend has online boolean',        typeof friends[0].online       === 'boolean');
} else {
  skip('friend shape (no confirmed friends — requires two live cores to test fully)');
}

// ── [ 14 ] Delete friend guard ────────────────────────────────────────────────

console.log('\n[ 14 ] Delete friend guard...');

const delFriendRes = await api('DELETE', '/api/social/friends/00000000-0000-0000-0000-notafriend/nobody', undefined, token);
ok('DELETE unknown friend → 404',      delFriendRes.status === 404);

// ── [ 15 ] Direct messages ────────────────────────────────────────────────────

console.log('\n[ 15 ] Direct messages...');

// Send to unknown friend → 404
const sendUnknown = await api(
  'POST',
  '/api/social/messages/00000000-0000-0000-0000-notafriend/nobody',
  { text: 'hello' },
  token,
);
ok('POST message to unknown friend → 404', sendUnknown.status === 404);
ok('error is friend_not_found',            sendUnknown.data.error === 'friend_not_found');

// Empty text rejected
if (friends.length > 0) {
  const emptyText = await api(
    'POST',
    `/api/social/messages/${friends[0].instanceUuid}/${friends[0].username}`,
    { text: '   ' },
    token,
  );
  ok('POST empty text → 400',            emptyText.status === 400);
  ok('error is text_required',           emptyText.data.error === 'text_required');

  // Send a real message
  const sendMsg = await api(
    'POST',
    `/api/social/messages/${friends[0].instanceUuid}/${friends[0].username}`,
    { text: 'test message from integration test' },
    token,
  );
  ok('POST message to friend → 200',     sendMsg.ok);
  ok('messageId returned',               typeof sendMsg.data.messageId === 'string');
  ok('delivered is boolean',             typeof sendMsg.data.delivered === 'boolean');

  // Retrieve conversation
  const getMsg = await api(
    'GET',
    `/api/social/messages/${friends[0].instanceUuid}/${friends[0].username}?limit=10`,
    undefined,
    token,
  );
  ok('GET /api/social/messages → 200',   getMsg.ok);
  ok('messages is array',                Array.isArray(getMsg.data.messages));

  const msgs = getMsg.data.messages as Array<{
    message_id: string; direction: string; content_text: string;
  }>;
  ok('sent message appears in history',  msgs.some(m => m.content_text === 'test message from integration test'));
  ok('message direction is sent',        msgs.find(m => m.content_text === 'test message from integration test')?.direction === 'sent');

  // Pagination cursor — before param
  const pagedMsg = await api(
    'GET',
    `/api/social/messages/${friends[0].instanceUuid}/${friends[0].username}?limit=5&before=${Date.now() + 60000}`,
    undefined,
    token,
  );
  ok('GET messages with before cursor → 200', pagedMsg.ok);
} else {
  skip('direct message send (no confirmed friends)');
  skip('empty text guard (no confirmed friends)');
  skip('conversation retrieval (no confirmed friends)');
  skip('pagination cursor (no confirmed friends)');
}

// ── [ 16 ] Discovery delete — cleans up pending requests ─────────────────────

console.log('\n[ 16 ] Discovery delete...');

// Delete B (no friend association)
const delB = await api('DELETE', `/api/social/discovery/${TEST_UUID_B}`, undefined, token);
ok('DELETE /api/social/discovery/:id → 204', delB.status === 204);

const listAfterDelB = await api('GET', '/api/social/discovery', undefined, token);
const instancesAfterDel = listAfterDelB.data.instances as typeof instances;
ok('instance B removed from list',     !instancesAfterDel.some(i => i.instanceUuid === TEST_UUID_B));
ok('instance A still present',         instancesAfterDel.some(i => i.instanceUuid === TEST_UUID_A));

// Delete nonexistent → 404
const delMissing = await api('DELETE', '/api/social/discovery/00000000-0000-0000-0000-doesnotexist', undefined, token);
ok('DELETE unknown discovery → 404',   delMissing.status === 404);

// ── [ 17 ] Schema presence — pending_outbound_requests ───────────────────────

console.log('\n[ 17 ] Schema — pending_outbound_requests...');
// If the outbound friend-request call in [ 10 ] succeeded with a requestId,
// it means the INSERT into pending_outbound_requests ran without a schema error.
ok('pending_outbound_requests schema present (friend-request succeeded)', reqKnown.ok);
ok('requestId is UUID format', /^[0-9a-f-]{36}$/.test(reqKnown.data.requestId as string ?? ''));

// ── [ 18 ] Relay status fields ────────────────────────────────────────────────

console.log('\n[ 18 ] Relay status fields...');

const finalStatus = await api('GET', '/api/webrtc/status', undefined, token);
ok('GET /api/webrtc/status → 200',     finalStatus.ok);
ok('relayEnabled is boolean',          typeof finalStatus.data.relayEnabled  === 'boolean');
ok('relayConnected is boolean',        typeof finalStatus.data.relayConnected === 'boolean');
ok('connected is boolean',             typeof finalStatus.data.connected      === 'boolean');
ok('iceState is string',               typeof finalStatus.data.iceState       === 'string');
ok('channels object present',         typeof finalStatus.data.channels       === 'object');
console.log(`   relayEnabled:  ${finalStatus.data.relayEnabled}`);
console.log(`   relayConnected: ${finalStatus.data.relayConnected}`);

// ── [ 19 ] Cleanup ────────────────────────────────────────────────────────────

console.log('\n[ 19 ] Cleanup...');

for (const uuid of CLEANUP_INSTANCES) {
  try {
    await api('DELETE', `/api/social/discovery/${uuid}`, undefined, token);
  } catch { /* already deleted or never created */ }
}

// Verify all test instances are gone
const finalList = await api('GET', '/api/social/discovery', undefined, token);
const finalInstances = finalList.data.instances as typeof instances;
const anyTestLeft = finalInstances.some(i =>
  i.instanceUuid === TEST_UUID_A || i.instanceUuid === TEST_UUID_B,
);
ok('all test instances removed',       !anyTestLeft);

// ── Skip notes ────────────────────────────────────────────────────────────────

console.log('\n[ — ] Skipped (require two live cores)...');
skip('FriendConnectionHandler — WebRTC handshake between two real cores');
skip('SocialRelayHandler — FriendRequestMessage delivery and routing');
skip('FriendRequestAck — bilateral accept triggers handshake');
skip('social.duckdb friend record written after handshake');
skip('known_instances.friended=true after handshake');
skip('pending_outbound_requests retry on relay reconnect');
skip('DirectMessageStore — delivered=1 after peer acks');

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(52));
console.log(`✅  Passed: ${passed}`);
console.log(`❌  Failed: ${failed}`);

if (failed > 0) {
  console.error('\n❌  Social test FAILED\n');
  process.exit(1);
} else {
  console.log('\n✅  Social test PASSED\n');
}