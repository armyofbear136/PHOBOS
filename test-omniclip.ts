// test-omniclip.ts — Validates the Omniclip video editor service.
//
// Tests:
//   1. OmniclipManager path resolution — isBuildPresent() finds the npm package
//   2. Status API — GET /api/tools/omniclip/status returns correct shape
//   3. Start API  — POST /api/tools/omniclip/start brings server to 'running'
//   4. Port 16345 reachable — HTTP GET returns 200 with correct COOP/COEP headers
//   5. index.html served — content-type text/html
//   6. node_modules fallback — /node_modules/@benev/slate/x/index.js resolves (the
//      most critical dep; was returning text/html when fallback was broken)
//   7. Stop API   — POST /api/tools/omniclip/stop returns 'stopped'
//   8. Re-start   — service recovers after stop
//
// Run with PHOBOS server stopped:
//   npx tsx test-omniclip.ts
//
// Options:
//   --skip-server   assume PHOBOS is already running on :3001
//   --keep-running  don't stop Omniclip at the end (useful for manual inspection)

import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';

// ── Config ────────────────────────────────────────────────────────────────────

const PHOBOS_PORT   = 3001;
const OMNICLIP_PORT = 16345;
const BASE_URL      = `http://127.0.0.1:${PHOBOS_PORT}`;
const OMNI_URL      = `http://127.0.0.1:${OMNICLIP_PORT}`;
const SKIP_SERVER   = process.argv.includes('--skip-server');
const KEEP_RUNNING  = process.argv.includes('--keep-running');

const PASS = '✅ PASS';
const FAIL = '❌ FAIL';
const SKIP = '⏭️  SKIP';

let failCount = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? PASS : FAIL}  ${label}${detail ? '  —  ' + detail : ''}`);
  if (!ok) failCount++;
}

function skip(label: string, reason = ''): void {
  console.log(`  ${SKIP}  ${label}${reason ? '  —  ' + reason : ''}`);
}

// ── Server management ─────────────────────────────────────────────────────────

function waitForPort(port: number, timeoutMs = 45_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() >= deadline) { reject(new Error(`Port ${port} not open within ${timeoutMs}ms`)); return; }
        setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

let serverProc: ChildProcess | null = null;

async function startServer(): Promise<void> {
  if (SKIP_SERVER) {
    console.log('  (--skip-server: assuming PHOBOS is already running on :3001)');
    await waitForPort(PHOBOS_PORT, 5_000).catch(() => {
      throw new Error('PHOBOS not reachable on :3001. Start it or remove --skip-server.');
    });
    return;
  }

  console.log('  Spawning PHOBOS server (npx tsx server.ts)...');
  serverProc = spawn('npx', ['tsx', 'server.ts'], {
    stdio:  ['ignore', 'pipe', 'pipe'],
    env:    { ...process.env, PORT: String(PHOBOS_PORT) },
    shell:  process.platform === 'win32',
  });

  serverProc.stdout?.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) process.stdout.write(`    [server] ${line}\n`);
  });
  serverProc.stderr?.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) process.stdout.write(`    [server] ${line}\n`);
  });

  await waitForPort(PHOBOS_PORT, 45_000);
  console.log(`  PHOBOS listening on :${PHOBOS_PORT}`);
}

async function stopServer(): Promise<void> {
  if (!serverProc || SKIP_SERVER) return;
  serverProc.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { serverProc?.kill('SIGKILL'); resolve(); }, 8_000);
    serverProc!.once('exit', () => { clearTimeout(t); resolve(); });
  });
  serverProc = null;
}

// ── API helpers ───────────────────────────────────────────────────────────────

interface OmniclipStatus {
  state:        string;
  port:         number;
  error:        string | null;
  buildPresent: boolean;
  version:      string | null;
}

async function getStatus(): Promise<OmniclipStatus> {
  const res = await fetch(`${BASE_URL}/api/tools/omniclip/status`);
  if (!res.ok) throw new Error(`status HTTP ${res.status}`);
  return res.json() as Promise<OmniclipStatus>;
}

async function postStart(): Promise<OmniclipStatus> {
  const res = await fetch(`${BASE_URL}/api/tools/omniclip/start`, { method: 'POST' });
  if (!res.ok) throw new Error(`start HTTP ${res.status}`);
  return res.json() as Promise<OmniclipStatus>;
}

async function postStop(): Promise<OmniclipStatus> {
  const res = await fetch(`${BASE_URL}/api/tools/omniclip/stop`, { method: 'POST' });
  if (!res.ok) throw new Error(`stop HTTP ${res.status}`);
  return res.json() as Promise<OmniclipStatus>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function testStatusShape(): Promise<boolean> {
  console.log('\n── Status API');
  const s = await getStatus();
  check('state field present',        typeof s.state === 'string',  s.state);
  check('port field is 16345',        s.port === OMNICLIP_PORT,     String(s.port));
  check('buildPresent field present', typeof s.buildPresent === 'boolean', String(s.buildPresent));
  check('version field present',      'version' in s,               String(s.version));
  check('build is present',           s.buildPresent === true,
    s.buildPresent ? 'npm package found' : 'NOT FOUND — run npm install in phobos-core');
  if (s.version) {
    check('version is semver-ish',    /^\d+\.\d+\.\d+/.test(s.version), s.version);
  }
  return s.buildPresent;
}

async function testStart(): Promise<void> {
  console.log('\n── Start API');

  // If already running from a previous boot, stop first to test a clean start
  const initial = await getStatus();
  if (initial.state === 'running') {
    console.log('  (already running — stopping first to test clean start)');
    await postStop();
    await new Promise(r => setTimeout(r, 500));
  }

  const s = await postStart();
  check('state is running after start', s.state === 'running', s.state);
  check('error is null after start',    s.error === null,       String(s.error));

  // Wait for port to be reachable (should be near-instant — Node http.Server)
  try {
    await waitForPort(OMNICLIP_PORT, 5_000);
    check('port 16345 reachable',   true);
  } catch {
    check('port 16345 reachable',   false, 'timed out after 5s');
  }
}

async function testStaticServer(): Promise<void> {
  console.log('\n── Static server (port 16345)');

  // 1. index.html
  const htmlRes = await fetch(`${OMNI_URL}/`);
  check('GET / returns 200',
    htmlRes.status === 200,
    String(htmlRes.status));
  check('index.html content-type is text/html',
    (htmlRes.headers.get('content-type') ?? '').includes('text/html'),
    htmlRes.headers.get('content-type') ?? 'missing');

  // 2. COOP + COEP headers on every response
  const coop = htmlRes.headers.get('cross-origin-opener-policy');
  const coep = htmlRes.headers.get('cross-origin-embedder-policy');
  const corp = htmlRes.headers.get('cross-origin-resource-policy');
  check('COOP header: same-origin',    coop === 'same-origin',    coop ?? 'missing');
  check('COEP header: require-corp',   coep === 'require-corp',   coep ?? 'missing');
  // CORP must be cross-origin so the PHOBOS parent (different port = different
  // origin) can embed Omniclip in an iframe. same-origin causes the broken-image
  // grey box in the panel even though localhost:16345 loads fine on its own.
  check('CORP header: cross-origin',   corp === 'cross-origin',   corp ?? 'missing');

  // 3. main.bundle.min.js — primary app bundle
  const bundleRes = await fetch(`${OMNI_URL}/main.bundle.min.js`);
  check('main.bundle.min.js returns 200',
    bundleRes.status === 200,
    String(bundleRes.status));
  check('main.bundle.min.js content-type is javascript',
    (bundleRes.headers.get('content-type') ?? '').includes('javascript'),
    bundleRes.headers.get('content-type') ?? 'missing');
  await bundleRes.body?.cancel(); // don't buffer 9MB

  // 4. importmap.json
  const imapRes = await fetch(`${OMNI_URL}/importmap.json`);
  check('importmap.json returns 200',
    imapRes.status === 200,
    String(imapRes.status));
  check('importmap.json content-type is json',
    (imapRes.headers.get('content-type') ?? '').includes('json'),
    imapRes.headers.get('content-type') ?? 'missing');

  // 5. node_modules fallback — the critical dep that was broken
  //    @benev/slate is the most-requested dep per the error log
  const slateRes = await fetch(`${OMNI_URL}/node_modules/@benev/slate/x/index.js`);
  check('/node_modules/@benev/slate/x/index.js returns 200',
    slateRes.status === 200,
    String(slateRes.status));
  check('@benev/slate content-type is javascript (not text/html)',
    (slateRes.headers.get('content-type') ?? '').includes('javascript'),
    slateRes.headers.get('content-type') ?? 'missing');
  await slateRes.body?.cancel();

  // 6. A few more critical deps from the error log
  const deps = [
    '/node_modules/lit/index.js',
    '/node_modules/posthog-js/dist/array.js',
    '/node_modules/gsap/index.js',
  ];
  for (const dep of deps) {
    const r = await fetch(`${OMNI_URL}${dep}`);
    const ct = r.headers.get('content-type') ?? '';
    check(`${dep} returns 200`,
      r.status === 200,
      `HTTP ${r.status} — ${ct}`);
    await r.body?.cancel();
  }

  // 6b. Stub correctness — posthog stub must export posthog.init as a function.
  //     main.ts calls posthog.init(...) on boot; if the export is a plain object
  //     with no init() the call throws TypeError and stalls the loading screen.
  console.log('\n── Stub correctness');
  const posthogStubRes = await fetch(`${OMNI_URL}/node_modules/posthog-js/dist/es.js`);
  check('posthog stub /dist/es.js returns 200',
    posthogStubRes.status === 200,
    String(posthogStubRes.status));
  const posthogBody = await posthogStubRes.text();
  check('posthog stub exports init (no-op)',
    posthogBody.includes('init()'),
    posthogBody.slice(0, 120));

  // 6c. coi-serviceworker.js stub — must be a no-op script served with no-store
  //     so the browser never caches it and cannot install the real SW that would
  //     intercept fetch events and break loading.
  const coiRes = await fetch(`${OMNI_URL}/coi-serviceworker.js`);
  check('coi-serviceworker.js returns 200',
    coiRes.status === 200,
    String(coiRes.status));
  check('coi-serviceworker.js Cache-Control is no-store',
    (coiRes.headers.get('cache-control') ?? '').includes('no-store'),
    coiRes.headers.get('cache-control') ?? 'missing');
  const coiBody = await coiRes.text();
  check('coi-serviceworker.js body is no-op (no addEventListener)',
    !coiBody.includes('addEventListener'),
    coiBody.slice(0, 80));

  // 7. SPA fallback — unknown route should serve index.html, not 404
  const spaRes = await fetch(`${OMNI_URL}/some-unknown-spa-route`);
  check('Unknown route SPA-fallbacks to 200',
    spaRes.status === 200,
    String(spaRes.status));
  check('SPA fallback content-type is text/html',
    (spaRes.headers.get('content-type') ?? '').includes('text/html'),
    spaRes.headers.get('content-type') ?? 'missing');

  // 8. Missing node_module should be a real 404, not SPA fallback
  const missingRes = await fetch(`${OMNI_URL}/node_modules/nonexistent-package/index.js`);
  check('Missing node_module returns 404 (not SPA fallback)',
    missingRes.status === 404,
    String(missingRes.status));
}

async function testStop(): Promise<void> {
  console.log('\n── Stop API');
  const s = await postStop();
  check('state is stopped after stop', s.state === 'stopped', s.state);
  check('error is null after stop',    s.error === null,       String(s.error));

  // Verify port is no longer listening
  const portOpen = await waitForPort(OMNICLIP_PORT, 1_000).then(() => true).catch(() => false);
  check('port 16345 no longer listening after stop', !portOpen);
}

async function testRestart(): Promise<void> {
  console.log('\n── Restart (stop → start)');
  const s = await postStart();
  check('state is running after restart', s.state === 'running', s.state);
  try {
    await waitForPort(OMNICLIP_PORT, 5_000);
    check('port 16345 reachable after restart', true);
  } catch {
    check('port 16345 reachable after restart', false, 'timed out');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n🎬  Omniclip Video Editor — Test Suite');
  console.log('═'.repeat(52));

  try {
    await startServer();
  } catch (err) {
    console.error(`\n❌  Could not start server: ${(err as Error).message}`);
    process.exit(1);
  }

  try {
    const buildPresent = await testStatusShape();

    if (!buildPresent) {
      console.log('\n⚠️  Build not present — skipping remaining tests.');
      console.log('    Run: npm install  (in phobos-core)');
    } else {
      await testStart();
      await testStaticServer();

      if (KEEP_RUNNING) {
        skip('Stop API', '--keep-running flag set');
        skip('Restart',  '--keep-running flag set');
      } else {
        await testStop();
        await testRestart();

        // Final stop unless keeping running
        await postStop();
      }
    }
  } catch (err) {
    console.error(`\n❌  Unexpected error: ${(err as Error).message}`);
    failCount++;
  } finally {
    await stopServer();
  }

  console.log('\n' + '═'.repeat(52));
  if (failCount === 0) {
    console.log('✅  All tests passed.\n');
    process.exit(0);
  } else {
    console.log(`❌  ${failCount} test(s) failed.\n`);
    process.exit(1);
  }
}

main();