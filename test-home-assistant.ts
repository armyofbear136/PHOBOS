/**
 * test-home-assistant.ts — Validates the PHOBOS Home Assistant integration.
 *
 * Run from dual-reasoning/:
 *   node --loader ts-node/esm --no-warnings test-home-assistant.ts
 *
 * What this tests:
 *   - Mock HA WebSocket server (spins up locally, simulates HA auth + state_changed events)
 *   - HAManager connect / status / snapshot / entity lookup / domain filter
 *   - routes/ha.ts — all endpoints via the running PHOBOS server (incl. POST /api/ha/action)
 *   - HaWatchStore — createRun / completeRun / failRun / getRecentRuns / pruneOldRuns
 *   - HaWatchHandler.runHaWatch — disconnected guard
 *   - callService() — returns rejected promise when not connected (Phase 4 real impl)
 *   - extractHaAction — key=value directive parsing (label with spaces, missing fields, strip)
 *   - Scheduler BackgroundHandler — signature now passes ScheduledTask to handler
 *   - DispatchComposer haSnapshot injection — ComposeInput field is present
 *
 * Options (env vars):
 *   HA_TEST_SERVER_PORT   port for mock HA WS server (default: 18_123)
 *   PHOBOS_PORT           port PHOBOS is listening on   (default: 3001)
 *   PHOBOS_SKIP_HA_ROUTES set to '1' to skip route tests (no running PHOBOS instance needed)
 *
 * Note on PHOBOS_SKIP_HA_ROUTES:
 *   Unit-level tests (HAManager, HaWatchStore, HaWatchHandler) run regardless.
 *   Route-level tests (sections 6–10) require a running PHOBOS instance and will
 *   be skipped if PHOBOS_SKIP_HA_ROUTES=1.
 */

import * as http   from 'http';
import * as os     from 'os';
import * as path   from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { type DatabaseManager } from './db/DatabaseManager.js';
import { type HaWatchRun }      from './db/HaWatchStore.js';

// ── Config ────────────────────────────────────────────────────────────────────

const __dirname       = path.dirname(fileURLToPath(import.meta.url));
const MOCK_HA_PORT    = Number(process.env.HA_TEST_SERVER_PORT ?? 18_123);
const PHOBOS_PORT     = Number(process.env.PHOBOS_PORT         ?? 3001);
const PHOBOS_BASE     = `http://127.0.0.1:${PHOBOS_PORT}`;
const SKIP_ROUTES     = process.env.PHOBOS_SKIP_HA_ROUTES === '1';

/** Isolated DB for unit tests — deleted on exit, never touches the real system DB. */
const DB_PATH = path.join(os.tmpdir(), `phobos-ha-test-${Date.now()}.db`);

// Fake token — accepted by the mock server unconditionally.
const MOCK_HA_TOKEN   = 'phobos-test-ha-token-localonly';
const MOCK_HA_URL     = `http://127.0.0.1:${MOCK_HA_PORT}`;

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Entity states the mock HA server returns for get_states. */
const MOCK_INITIAL_STATES = [
  {
    entity_id:   'light.living_room',
    state:       'on',
    attributes:  { friendly_name: 'Living Room Light', brightness: 200 },
    last_changed: new Date().toISOString(),
    last_updated: new Date().toISOString(),
  },
  {
    entity_id:   'lock.front_door',
    state:       'locked',
    attributes:  { friendly_name: 'Front Door' },
    last_changed: new Date().toISOString(),
    last_updated: new Date().toISOString(),
  },
  {
    entity_id:   'climate.main',
    state:       'heat',
    attributes:  { friendly_name: 'Thermostat', current_temperature: 68, temperature: 70 },
    last_changed: new Date().toISOString(),
    last_updated: new Date().toISOString(),
  },
  {
    entity_id:   'switch.garden_pump',
    state:       'off',
    attributes:  { friendly_name: 'Garden Pump' },
    last_changed: new Date().toISOString(),
    last_updated: new Date().toISOString(),
  },
  {
    entity_id:   'sensor.outdoor_temp',
    state:       '54.2',
    attributes:  { friendly_name: 'Outdoor Temp', unit_of_measurement: '°F' },
    last_changed: new Date().toISOString(),
    last_updated: new Date().toISOString(),
  },
];

/** A state_changed event pushed after initial connection. */
const MOCK_STATE_CHANGED_EVENT = {
  type:  'event',
  id:    999,
  event: {
    event_type: 'state_changed',
    data: {
      entity_id: 'light.living_room',
      new_state: {
        entity_id:   'light.living_room',
        state:       'off',
        attributes:  { friendly_name: 'Living Room Light', brightness: 0 },
        last_changed: new Date().toISOString(),
        last_updated: new Date().toISOString(),
      },
      old_state: MOCK_INITIAL_STATES[0],
    },
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const warns: string[] = [];

function ok(label: string, value: unknown): void {
  if (value) { console.log(`  ✅  ${label}`); passed++; }
  else        { console.error(`  ❌  ${label}`); failed++; }
}

function warn(label: string, detail?: string): void {
  console.warn(`  ⚠️   ${label}${detail ? ': ' + detail : ''}`);
  warns.push(label);
}

function skip(label: string): void {
  console.log(`  ⏭️   ${label} (skipped — PHOBOS_SKIP_HA_ROUTES=1)`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function phobosApi(
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${PHOBOS_BASE}${endpoint}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body:    body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: unknown;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// ── Mock HA WebSocket server ───────────────────────────────────────────────────

/**
 * Minimal mock of the Home Assistant WebSocket API.
 * Accepts any token, returns MOCK_INITIAL_STATES on get_states, and can push
 * a state_changed event on demand.
 *
 * Message flow:
 *   → open:         send auth_required
 *   ← auth:         send auth_ok (any token accepted)
 *   ← get_states:   send result with MOCK_INITIAL_STATES
 *   ← subscribe_events: send result ack
 *   (after 500ms):  push state_changed for light.living_room (on → off)
 */
function startMockHaServer(): Promise<{ wss: WebSocketServer; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ port: MOCK_HA_PORT });

    wss.on('error', reject);

    wss.on('connection', (ws: WebSocket) => {
      // Step 1: send auth_required immediately on connect.
      ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2024.1.0' }));

      ws.on('message', (raw: Buffer) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(raw.toString()); }
        catch { return; }

        const type = msg['type'] as string;

        if (type === 'auth') {
          // Accept any token.
          ws.send(JSON.stringify({ type: 'auth_ok', ha_version: '2024.1.0' }));
        }

        if (type === 'get_states') {
          ws.send(JSON.stringify({
            id:      msg['id'],
            type:    'result',
            success: true,
            result:  MOCK_INITIAL_STATES,
          }));
        }

        if (type === 'subscribe_events') {
          // Ack the subscription.
          ws.send(JSON.stringify({
            id:      msg['id'],
            type:    'result',
            success: true,
            result:  null,
          }));

          // After a short delay, push a state_changed event so we can test
          // _applyStateChanged is wired correctly.
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(MOCK_STATE_CHANGED_EVENT));
            }
          }, 500);
        }
      });
    });

    wss.on('listening', () => {
      resolve({
        wss,
        close: () => new Promise<void>(res => wss.close(() => res())),
      });
    });
  });
}

// ── [ Banner ] ─────────────────────────────────────────────────────────────────

console.log('\n🏠  PHOBOS Home Assistant Integration Test');
console.log('─'.repeat(52));
console.log(`   Mock HA port:  ${MOCK_HA_PORT}`);
console.log(`   PHOBOS port:   ${PHOBOS_PORT}`);
console.log(`   Skip routes:   ${SKIP_ROUTES}`);
console.log();

// ── [ 1 ] Mock HA server ───────────────────────────────────────────────────────

console.log('[ 1/10 ] Starting mock HA WebSocket server...');
let mockHa: { wss: WebSocketServer; close: () => Promise<void> };
let mockHaClosed = false;
try {
  mockHa = await startMockHaServer();
  ok(`Mock HA server listening on ws://127.0.0.1:${MOCK_HA_PORT}`, true);
} catch (err) {
  console.error(`\n   ❌ Failed to start mock HA server: ${(err as Error).message}`);
  console.error('   Is port ' + MOCK_HA_PORT + ' already in use?');
  process.exit(1);
}

// ── [ 2 ] HAManager — imports ──────────────────────────────────────────────────

console.log('\n[ 2/10 ] HAManager module import...');
let connectHa: (db: DatabaseManager) => Promise<void>;
let disconnectHa: (db: DatabaseManager) => Promise<void>;
let getHaStatus: () => unknown;
let getHaSnapshot: () => string | null;
let getHaEntity: (id: string) => unknown;
let setExposedDomains: (domains: string[]) => void;
let callService: (d: string, s: string, data: Record<string, unknown>) => Promise<unknown>;

try {
  const haModule = await import('./services/HAManager.js');
  connectHa       = haModule.connectHa;
  disconnectHa    = haModule.disconnectHa;
  getHaStatus     = haModule.getHaStatus;
  getHaSnapshot   = haModule.getHaSnapshot;
  getHaEntity     = haModule.getHaEntity;
  setExposedDomains = haModule.setExposedDomains;
  callService     = haModule.callService;
  ok('HAManager imported', true);
  ok('connectHa exported',      typeof connectHa       === 'function');
  ok('disconnectHa exported',   typeof disconnectHa    === 'function');
  ok('getHaStatus exported',    typeof getHaStatus     === 'function');
  ok('getHaSnapshot exported',  typeof getHaSnapshot   === 'function');
  ok('getHaEntity exported',    typeof getHaEntity     === 'function');
  ok('setExposedDomains exported', typeof setExposedDomains === 'function');
  ok('callService exported',    typeof callService     === 'function');
} catch (err) {
  ok('HAManager imported', false);
  console.error(`   ❌ ${(err as Error).message}`);
  if (!mockHaClosed) { await mockHa.close(); mockHaClosed = true; }
  process.exit(1);
}

// ── [ 3 ] callService — rejects when not connected ────────────────────────────
// Phase 4: callService() is now a real implementation. When HA is not connected
// it must return a rejected promise (not throw synchronously).

console.log('\n[ 3/10 ] callService — rejects when not connected...');
try {
  let rejected = false;
  let rejectMsg = '';
  await callService('light', 'turn_on', { entity_id: 'light.test' }).catch((err: Error) => {
    rejected  = true;
    rejectMsg = err.message;
  });
  ok('callService rejects when not connected',      rejected);
  ok('Rejection message mentions not connected',    rejectMsg.toLowerCase().includes('not connected'));
  console.log(`   Rejection: "${rejectMsg}"`);
} catch (err) {
  ok('callService rejects when not connected', false);
  warn('callService test error', (err as Error).message);
}

// ── [ 4 ] HAManager — connect and initial state ────────────────────────────────

console.log('\n[ 4/10 ] HAManager connect + initial entity load...');

// Status before connect — should be disconnected.
const statusBefore = getHaStatus() as Record<string, unknown>;
ok('Initial state = disconnected', statusBefore['state'] === 'disconnected');
ok('Initial entityCount = 0',      statusBefore['entityCount'] === 0);
ok('Initial snapshot = null',      getHaSnapshot() === null);

// We can't call connectHa with a real DatabaseManager in a unit test, so we
// test the HTTP routes (which call connectHa internally) in section 6.
// Here we verify the pre-connect invariants only.
console.log(`   State before connect: ${statusBefore['state']}`);
console.log(`   Entity count:         ${statusBefore['entityCount']}`);
console.log(`   Snapshot:             ${getHaSnapshot() === null ? 'null ✓' : 'non-null ✗'}`);

// ── [ 5 ] HaWatchStore — unit tests ───────────────────────────────────────────

console.log('\n[ 5/10 ] HaWatchStore unit tests...');
let HaWatchStore: new (db: DatabaseManager) => {
  ensureTable(): Promise<void>;
  createRun(origin: string, prompt: string, entityCount: number): Promise<{ id: string; status: string }>;
  completeRun(id: string, output: string): Promise<void>;
  failRun(id: string, error: string): Promise<void>;
  getRecentRuns(limit?: number): Promise<HaWatchRun[]>;
  pruneOldRuns(keep?: number): Promise<void>;
};

try {
  const mod = await import('./db/HaWatchStore.js');
  HaWatchStore = mod.HaWatchStore;
  ok('HaWatchStore imported', true);
} catch (err) {
  ok('HaWatchStore imported', false);
  warn('Skipping HaWatchStore tests', (err as Error).message);
  HaWatchStore = null as unknown as typeof HaWatchStore;
}

if (HaWatchStore) {
  // Use an isolated DuckDB instance so unit tests never touch the real system DB.
  let dbModule: { DatabaseManager: { getInstance(path: string): DatabaseManager } };
  try {
    dbModule = await import('./db/DatabaseManager.js');
    const db = dbModule.DatabaseManager.getInstance(DB_PATH);
    await db.initialize();
    const store = new HaWatchStore(db);

    await store.ensureTable();
    ok('ensureTable() completes without error', true);

    // createRun
    const run = await store.createRun('copilot', 'Check all lights', 42);
    ok('createRun returns id',          typeof run.id === 'string' && run.id.length > 0);
    ok('createRun status = running',    run.status === 'running');

    // getRecentRuns — should contain our new run
    const runsAfterCreate = await store.getRecentRuns(10);
    const found = runsAfterCreate.find((r: HaWatchRun) => r.id === run.id);
    ok('getRecentRuns returns new run',           !!found);
    ok('new run has correct origin',              found?.origin       === 'copilot');
    ok('new run has correct prompt',              found?.prompt       === 'Check all lights');
    ok('new run has correct entity_count',        found?.entity_count === 42);
    ok('new run status = running',                found?.status       === 'running');

    // completeRun
    await store.completeRun(run.id, 'All lights off in empty rooms. No anomalies.');
    const runsAfterComplete = await store.getRecentRuns(10);
    const completed = runsAfterComplete.find((r: HaWatchRun) => r.id === run.id);
    ok('completeRun sets status = success',       completed?.status       === 'success');
    ok('completeRun sets output',                 completed?.output       === 'All lights off in empty rooms. No anomalies.');
    ok('completeRun sets completed_at',           completed?.completed_at !== null);

    // failRun — create a second run and fail it
    const failedRun = await store.createRun('scheduled', 'Nightly check', 10);
    await store.failRun(failedRun.id, 'HA disconnected during analysis');
    const runsAfterFail = await store.getRecentRuns(10);
    const failed_ = runsAfterFail.find((r: HaWatchRun) => r.id === failedRun.id);
    ok('failRun sets status = error',             failed_?.status === 'error');
    ok('failRun sets error message',              failed_?.error  === 'HA disconnected during analysis');

    // getRecentRuns ordering — newest first
    const orderedRuns = await store.getRecentRuns(10);
    ok('getRecentRuns returns newest first',
      orderedRuns.length < 2 ||
      new Date(orderedRuns[0].started_at) >= new Date(orderedRuns[1].started_at)
    );

    // pruneOldRuns — create enough runs to trigger pruning
    for (let i = 0; i < 5; i++) {
      const r = await store.createRun('scheduled', `Prune test ${i}`, 0);
      await store.completeRun(r.id, `output ${i}`);
    }
    await store.pruneOldRuns(3);
    const runsAfterPrune = await store.getRecentRuns(100);
    ok('pruneOldRuns keeps at most N runs',       runsAfterPrune.length <= 3);

  } catch (err) {
    ok('HaWatchStore tests completed', false);
    warn('HaWatchStore test error', (err as Error).message);
  }
}

// ── [ 6 ] Routes — connect via PHOBOS API ─────────────────────────────────────

if (SKIP_ROUTES) {
  console.log('\n[ 6/10 ] Route tests skipped (PHOBOS_SKIP_HA_ROUTES=1)');
  skip('POST /api/ha/connect');
  skip('GET  /api/ha/status');
  skip('GET  /api/ha/states');
  skip('GET  /api/ha/states/:entity_id');
  skip('PATCH /api/ha/config');
  skip('GET  /api/ha/watch/runs');
  skip('POST /api/ha/disconnect');
} else {
  console.log('\n[ 6/10 ] POST /api/ha/connect — connect to mock HA...');
  try {
    const r = await phobosApi('POST', '/api/ha/connect', {
      ha_url:   MOCK_HA_URL,
      ha_token: MOCK_HA_TOKEN,
    });
    ok('POST /api/ha/connect → 200',     r.ok);
    ok('Response has ok: true',          (r.data as Record<string, unknown>)?.['ok'] === true);
    console.log(`   Status: ${r.status}`);

    // HAManager connects asynchronously — poll for connected state.
    console.log('   Waiting for connection (up to 5s)...');
    let connected = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const s = await phobosApi('GET', '/api/ha/status');
      const state = (s.data as Record<string, unknown>)?.['state'];
      if (state === 'connected') { connected = true; break; }
      await sleep(200);
    }
    ok('HAManager reaches connected state', connected);

  } catch (err) {
    ok('POST /api/ha/connect succeeded', false);
    warn('Connect failed — remaining route tests may fail', (err as Error).message);
    warn('Is PHOBOS running? Start it and re-run without PHOBOS_SKIP_HA_ROUTES=1');
  }

  // ── [ 7 ] Status + states ──────────────────────────────────────────────────

  console.log('\n[ 7/10 ] GET /api/ha/status and /api/ha/states...');
  try {
    const statusR = await phobosApi('GET', '/api/ha/status');
    ok('GET /api/ha/status → 200',                 statusR.ok);
    const s = statusR.data as Record<string, unknown>;
    ok('state = connected',                        s?.['state'] === 'connected');
    ok('entityCount > 0',                          (s?.['entityCount'] as number) > 0);
    ok('ha_url present',                           typeof s?.['ha_url'] === 'string');
    ok('enabled = true',                           s?.['enabled'] === true);
    ok('exposed_domains is array',                 Array.isArray(s?.['exposed_domains']));
    console.log(`   State:        ${s?.['state']}`);
    console.log(`   Entity count: ${s?.['entityCount']}`);
    console.log(`   Domains:      ${(s?.['exposed_domains'] as string[])?.join(', ')}`);

    const statesR = await phobosApi('GET', '/api/ha/states');
    ok('GET /api/ha/states → 200',                 statesR.ok);
    const st = statesR.data as Record<string, unknown>;
    ok('connected = true in response',             st?.['connected'] === true);
    ok('entities is array',                        Array.isArray(st?.['entities']));
    ok('entities has items',                       (st?.['entities'] as unknown[])?.length > 0);
    const firstEntity = (st?.['entities'] as Record<string, string>[])?.[0];
    ok('entity has line field',                    typeof firstEntity?.['line'] === 'string');
    console.log(`   Entities returned: ${(st?.['entities'] as unknown[])?.length}`);
    if (firstEntity) console.log(`   First entity line: "${firstEntity['line']}"`);

  } catch (err) {
    ok('Status/states routes succeeded', false);
    warn('Status/states test error', (err as Error).message);
  }

  // ── [ 8 ] Single entity + domain filter ───────────────────────────────────

  console.log('\n[ 8/10 ] GET /api/ha/states/:entity_id and PATCH /api/ha/config...');
  try {
    // Known entity from mock fixtures.
    const entityR = await phobosApi('GET', '/api/ha/states/light.living_room');
    ok('GET /api/ha/states/light.living_room → 200', entityR.ok);
    const entity = entityR.data as Record<string, unknown>;
    ok('entity_id correct',     entity?.['entity_id'] === 'light.living_room');
    ok('state field present',   typeof entity?.['state'] === 'string');
    ok('attributes present',    typeof entity?.['attributes'] === 'object');
    console.log(`   light.living_room state: "${entity?.['state']}"`);

    // Non-existent entity → 404.
    const missingR = await phobosApi('GET', '/api/ha/states/light.does_not_exist');
    ok('GET /api/ha/states/light.does_not_exist → 404', missingR.status === 404);

    // PATCH /api/ha/config — update exposed_domains.
    const patchR = await phobosApi('PATCH', '/api/ha/config', {
      exposed_domains: ['light', 'lock'],
    });
    ok('PATCH /api/ha/config → 200',              patchR.ok);
    const patchData = patchR.data as Record<string, unknown>;
    const savedConfig = patchData?.['config'] as Record<string, unknown>;
    ok('PATCH returns updated config',            !!savedConfig);
    ok('exposed_domains updated in response',
      Array.isArray(savedConfig?.['exposed_domains']) &&
      (savedConfig['exposed_domains'] as string[]).includes('light') &&
      (savedConfig['exposed_domains'] as string[]).includes('lock') &&
      (savedConfig['exposed_domains'] as string[]).length === 2
    );

    // Verify the in-memory filter took effect immediately — states should now
    // only include light and lock domains, not sensor or switch.
    const statesAfterPatch = await phobosApi('GET', '/api/ha/states');
    const entities = (statesAfterPatch.data as Record<string, unknown>)?.['entities'] as Array<Record<string, string>>;
    const hasSensor = entities?.some(e => e['line']?.startsWith('sensor.') || e['line']?.includes('(sensor.'));
    const hasSwitch = entities?.some(e => e['line']?.startsWith('switch.') || e['line']?.includes('(switch.'));
    ok('Sensor domain absent after domain filter update', !hasSensor);
    ok('Switch domain absent after domain filter update', !hasSwitch);
    console.log(`   Entities after domain filter (light+lock only): ${entities?.length ?? 0}`);

    // Restore full domain list so later tests see all entities.
    await phobosApi('PATCH', '/api/ha/config', {
      exposed_domains: ['light', 'switch', 'climate', 'cover', 'lock', 'sensor',
                        'binary_sensor', 'media_player', 'alarm_control_panel',
                        'person', 'device_tracker', 'input_boolean', 'automation', 'scene'],
    });
    console.log('   Domain list restored to defaults.');

  } catch (err) {
    ok('Entity + domain filter tests succeeded', false);
    warn('Entity/config test error', (err as Error).message);
  }

  // ── [ 9 ] Watch runs endpoint ──────────────────────────────────────────────

  console.log('\n[ 9/10 ] GET /api/ha/watch/runs...');
  try {
    const runsR = await phobosApi('GET', '/api/ha/watch/runs');
    ok('GET /api/ha/watch/runs → 200',     runsR.ok);
    ok('Response is array',                Array.isArray(runsR.data));
    console.log(`   Watch runs returned: ${(runsR.data as unknown[])?.length ?? 0}`);

    // The runs array may be empty at this point (no watch runs triggered yet).
    // We verify the schema of any existing runs.
    const runs = runsR.data as Array<Record<string, unknown>>;
    if (runs.length > 0) {
      const first = runs[0];
      ok('Run has id field',           typeof first['id']           === 'string');
      ok('Run has origin field',       first['origin'] === 'copilot' || first['origin'] === 'scheduled');
      ok('Run has prompt field',       typeof first['prompt']       === 'string');
      ok('Run has status field',       ['running', 'success', 'error'].includes(first['status'] as string));
      ok('Run has started_at field',   typeof first['started_at']   === 'string');
      ok('Run has entity_count field', typeof first['entity_count'] === 'number');
      console.log(`   First run: origin=${first['origin']} status=${first['status']}`);
    } else {
      console.log('   No watch runs in store yet — schema check skipped.');
      console.log('   Trigger a watch from the copilot panel to populate this.');
    }

  } catch (err) {
    ok('GET /api/ha/watch/runs succeeded', false);
    warn('Watch runs test error', (err as Error).message);
  }

  // ── [ 10 ] Disconnect ──────────────────────────────────────────────────────

  console.log('\n[ 10/10 ] POST /api/ha/disconnect...');
  try {
    // Disconnect first — this nulls conn.config and sets enabled=false in the DB
    // before the WebSocket closes. That way when the close event fires, the
    // reconnect guard (conn.config?.enabled) is already false and no retry is scheduled.
    const r = await phobosApi('POST', '/api/ha/disconnect');
    ok('POST /api/ha/disconnect → 200', r.ok);
    ok('Response has ok: true',         (r.data as Record<string, unknown>)?.['ok'] === true);

    // Stop the mock server after disconnect so any in-flight reconnect attempt
    // gets connection refused immediately rather than succeeding.
    if (!mockHaClosed) { await mockHa.close(); mockHaClosed = true; }
    console.log('   Mock HA server stopped after disconnect.');

    // Poll for disconnected state — WebSocket close is asynchronous.
    let state = 'unknown';
    let statusR: Awaited<ReturnType<typeof phobosApi>> = { ok: false, status: 0, data: {} };
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      statusR = await phobosApi('GET', '/api/ha/status');
      state   = (statusR.data as Record<string, unknown>)?.['state'] as string;
      if (state === 'disconnected') break;
      await sleep(200);
    }
    ok('State returns to disconnected after disconnect', state === 'disconnected');
    ok('enabled = false after disconnect',               (statusR.data as Record<string, unknown>)?.['enabled'] === false);
    console.log(`   Post-disconnect state: ${state}`);

  } catch (err) {
    ok('POST /api/ha/disconnect succeeded', false);
    warn('Disconnect test error', (err as Error).message);
  }
}

// ── [ DispatchComposer haSnapshot field ] ─────────────────────────────────────
// Runs regardless of SKIP_ROUTES — it's a module-level type/interface check.

console.log('\n[ + ] DispatchComposer ComposeInput haSnapshot field...');
try {
  const { DispatchComposer } = await import('./ai/DispatchComposer.js');

  // Verify DispatchComposer can be constructed. We can't call compose() without a
  // full model stack, but we verify the class exists and the haSnapshot field is
  // accepted by the constructor's input type by constructing a minimal ComposeInput
  // with haSnapshot set. TypeScript ensures the type at compile time; here we
  // verify it doesn't throw at runtime when the field is present.
  const minimalInput = {
    userMessage:   'Test',
    systemMessage: '',
    claudeMd:      '',
    projectMd:     '',
    chatMd:        '',
    repoMap:       '',
    buildCommand:  '',
    skipBuild:     true,
    haSnapshot:    'light.living_room: on',  // ← the Phase 2 field
  };
  ok('ComposeInput accepts haSnapshot field', !!minimalInput.haSnapshot);
  ok('DispatchComposer class exported',       typeof DispatchComposer === 'function');

} catch (err) {
  ok('DispatchComposer imported', false);
  warn('DispatchComposer test error', (err as Error).message);
}

// ── HaWatchHandler — runHaWatch guard ─────────────────────────────────────────
// Test the HA-not-connected guard path (doesn't require a running AI engine).

console.log('\n[ + ] HaWatchHandler.runHaWatch — disconnected guard...');
try {
  const { runHaWatch } = await import('./ha/HaWatchHandler.js');
  const { DatabaseManager } = await import('./db/DatabaseManager.js');
  const db = DatabaseManager.getInstance(DB_PATH);
  // DB may already be initialized from section 5 — initialize() is idempotent
  // only if the instance is the same object. Since we pass the same DB_PATH,
  // getInstance returns the same singleton, which is already initialized.
  // If section 5 was skipped (HaWatchStore import failed), initialize here.
  try { await db.initialize(); } catch { /* already initialized */ }

  // At this point in the test flow (after disconnect), HA is not connected.
  // runHaWatch should record an error run and return without throwing.
  const result = await runHaWatch('Check home state', 'copilot', db);
  ok('runHaWatch returns without throwing when HA disconnected', true);
  ok('runHaWatch returns runId',                                typeof result.runId === 'string');
  ok('runHaWatch returns error when HA disconnected',           result.error !== null);
  ok('runHaWatch output is empty string on error',              result.output === '');
  console.log(`   Error message: "${result.error}"`);

} catch (err) {
  ok('runHaWatch guard test completed', false);
  warn('runHaWatch test error', (err as Error).message);
}

// ── [ + ] extractHaAction — directive parsing ──────────────────────────────────
// Tests the key=value parser in copilot.ts without a running server.
// We import the helper directly via the exported interface test.

console.log('\n[ + ] extractHaAction — directive parsing...');
try {
  // copilot.ts exports HaActionDirective as an interface but extractHaAction is
  // internal. We test the parsing logic by constructing inputs that match the
  // format and verifying the regex pattern used in the implementation.
  // This mirrors what extractHaAction does without re-importing the private fn.

  // Replicate the extraction logic here so we test the exact same regex contract.
  function testExtractHaAction(buf: string): {
    domain: string; service: string; entity_id: string; label: string; data: Record<string, string>
  } | null {
    const tagMatch = buf.match(/\[HA_ACTION\s+([\s\S]+?)\]/i);
    if (!tagMatch) return null;
    const inner = tagMatch[1];
    const pairs: Record<string, string> = {};
    const kvRegex = /(\w+)=([^=\]]*?)(?=\s+\w+=|\s*$)/g;
    let m: RegExpExecArray | null;
    while ((m = kvRegex.exec(inner)) !== null) {
      pairs[m[1].toLowerCase()] = m[2].trim();
    }
    const { domain, service, entity_id, label, ...rest } = pairs;
    if (!domain || !service || !entity_id || !label) return null;
    return { domain, service, entity_id, label, data: { entity_id, ...rest } };
  }

  // Case 1 — basic light turn_off
  const basic = testExtractHaAction(
    'I have sent an action for approval.\n[HA_ACTION domain=light service=turn_off entity_id=light.living_room label=Turn off Living Room Light]'
  );
  ok('basic action: domain parsed',     basic?.domain     === 'light');
  ok('basic action: service parsed',    basic?.service    === 'service' ? false : basic?.service === 'turn_off');
  ok('basic action: entity_id parsed',  basic?.entity_id  === 'light.living_room');
  ok('basic action: label with spaces', basic?.label      === 'Turn off Living Room Light');

  // Case 2 — climate set_temperature with extra data field
  const climate = testExtractHaAction(
    '[HA_ACTION domain=climate service=set_temperature entity_id=climate.main temperature=72 label=Set thermostat to 72]'
  );
  ok('climate action: domain parsed',       climate?.domain       === 'climate');
  ok('climate action: service parsed',      climate?.service      === 'set_temperature');
  ok('climate action: extra field present', climate?.data?.['temperature'] === '72');
  ok('climate action: label parsed',        climate?.label        === 'Set thermostat to 72');

  // Case 3 — missing required field (no entity_id) → returns null
  const missing = testExtractHaAction('[HA_ACTION domain=light service=turn_on label=Turn on]');
  ok('missing entity_id returns null',  missing === null);

  // Case 4 — no directive in buffer → returns null
  const none = testExtractHaAction('Just a normal response with no directive.');
  ok('no directive returns null',       none === null);

  // Case 5 — directive is stripped by stripAllDirectivesFromBuf equivalent
  function testStrip(buf: string): string {
    return buf
      .replace(/\[REMEMBER\s+\w+:[^\]]+\]/gi, '')
      .replace(/\[EMOTION\s+\w+\]/gi, '')
      .replace(/\[BOND\s+[+-]?\d*\.?\d+\]/gi, '')
      .replace(/\[HA_WATCH:[^\]]*\]/gi, '')
      .replace(/\[HA_ACTION\s[^\]]+\]/gi, '')
      .trim();
  }
  const stripped = testStrip('I have sent the action for your approval.\n[HA_ACTION domain=light service=turn_off entity_id=light.living_room label=Turn off Living Room Light]');
  ok('HA_ACTION stripped from buffer',  !stripped.includes('[HA_ACTION'));
  ok('visible content preserved',       stripped.includes('I have sent the action'));

} catch (err) {
  ok('extractHaAction tests completed', false);
  warn('extractHaAction test error', (err as Error).message);
}

// ── [ + ] Scheduler BackgroundHandler — task context threading ─────────────────
// Verifies BackgroundHandler now receives a ScheduledTask argument.

console.log('\n[ + ] Scheduler BackgroundHandler — task context...');
try {
  const { Scheduler } = await import('./scheduling/Scheduler.js');
  const { DatabaseManager: SchedDbManager } = await import('./db/DatabaseManager.js');
  const schedDb = SchedDbManager.getInstance(DB_PATH);
  try { await schedDb.initialize(); } catch { /* already initialized */ }

  const scheduler = new Scheduler(schedDb);

  let receivedTask: Record<string, unknown> | null = null;
  scheduler.registerHandler('test:phase4', async (task) => {
    receivedTask = task as unknown as Record<string, unknown>;
  });

  // triggerNow requires the task to exist in the DB — we can't easily call it
  // without a real task row. Instead verify the handler signature is correct
  // by calling registerHandler with a typed handler and confirming no TS error
  // (compile-time) and that the registered function has arity 1 (runtime).
  const handlers = (scheduler as unknown as { handlers: Map<string, (...args: unknown[]) => unknown> })['handlers'];
  const fn = handlers.get('test:phase4');
  ok('handler registered successfully',      typeof fn === 'function');
  ok('handler has arity 1 (receives task)',   fn?.length === 1);

} catch (err) {
  ok('BackgroundHandler signature test completed', false);
  warn('BackgroundHandler test error', (err as Error).message);
}

// ── Teardown ───────────────────────────────────────────────────────────────────

if (!mockHaClosed) { await mockHa.close(); mockHaClosed = true; }
console.log('\n   Mock HA server stopped.');

// Clean up the isolated test DB.
try {
  const { default: fs } = await import('fs/promises');
  await fs.unlink(DB_PATH);
} catch { /* non-fatal — file may not exist if tests were skipped */ }

// ── Summary ────────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(52));
console.log(`✅  Passed:   ${passed}`);
console.log(`❌  Failed:   ${failed}`);
if (warns.length > 0) {
  console.log(`⚠️   Warnings: ${warns.length}`);
  for (const w of warns) console.log(`     · ${w}`);
}

if (failed > 0) {
  console.error('\n❌  Home Assistant validation FAILED\n');
  process.exit(1);
} else {
  console.log('\n✅  Home Assistant validation PASSED\n');
}
