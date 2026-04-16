// test-camofox.ts — validates the full Camofox pipeline
//
// Run standalone (no PHOBOS application required):
//   npx tsx test-camofox.ts
//
// The script starts and stops Camofox itself — PHOBOS does not need to be running.
// camofox-browser must be installed: npm install

import { startCamofox, stopCamofox, getCamofoxStatus, isCamofoxInstalled, CAMOFOX_PORT } from './phobos/CamofoxManager.js';
import { browseUrl, browseSearch, fetchYoutubeTranscript } from './phobos/CamofoxClient.js';

const PASS = '✅ PASS';
const FAIL = '❌ FAIL';

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? PASS : FAIL}  ${label}${detail ? '  —  ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

async function run(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║           CAMOFOX STANDALONE VALIDATION TEST             ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // ── 1. Installation ────────────────────────────────────────────────────────
  console.log('── 1. Installation check');
  check('camofox-browser in node_modules', isCamofoxInstalled());
  if (!isCamofoxInstalled()) {
    console.error('\n  Abort: package missing. Run: npm install\n');
    process.exit(1);
  }

  // ── 2. Start ───────────────────────────────────────────────────────────────
  console.log('\n── 2. Start Camofox');
  console.log('  (first run downloads Camoufox binary ~300 MB — may take a few minutes)');
  await startCamofox();
  const status = getCamofoxStatus();
  check('state === running', status.state === 'running', `state=${status.state}${status.error ? ' error=' + status.error : ''}`);
  check('pid assigned',      status.pid !== null,         `pid=${status.pid}`);
  check('port correct',      status.port === CAMOFOX_PORT, `port=${status.port}`);

  if (status.state !== 'running') {
    console.error('\n  Abort: Camofox failed to start.\n');
    process.exit(1);
  }

  // ── 3. Health endpoint (direct to Camofox, not through PHOBOS) ─────────────
  console.log('\n── 3. Health endpoint');
  try {
    const res = await fetch(`http://127.0.0.1:${CAMOFOX_PORT}/health`);
    check('/health returns 200', res.ok, `HTTP ${res.status}`);
    const body = await res.json().catch(() => null);
    check('/health returns JSON', body !== null);
  } catch (err) {
    check('/health reachable', false, (err as Error).message);
  }

  // ── 4. Browse URL ──────────────────────────────────────────────────────────
  console.log('\n── 4. Browse URL  (example.com)');
  const pageResult = await browseUrl('https://example.com');
  check('no error',                    !pageResult.error,                              pageResult.error ?? '');
  check('snapshot non-empty',          pageResult.snapshot.length > 0,                `${pageResult.snapshot.length} chars`);
  check('snapshot contains "Example"', pageResult.snapshot.toLowerCase().includes('example'), `title="${pageResult.title}"`);

  // ── 5. Google search macro ─────────────────────────────────────────────────
  console.log('\n── 5. Google search macro  (@google_search)');
  const searchResult = await browseSearch('@google_search', 'llama.cpp github');
  check('no error',           !searchResult.error,              searchResult.error ?? '');
  check('snapshot non-empty', searchResult.snapshot.length > 0, `${searchResult.snapshot.length} chars`);

  // ── 6. Wikipedia search macro ──────────────────────────────────────────────
  console.log('\n── 6. Wikipedia search macro  (@wikipedia_search)');
  const wikiResult = await browseSearch('@wikipedia_search', 'Firefox browser');
  check('no error',           !wikiResult.error,              wikiResult.error ?? '');
  check('snapshot non-empty', wikiResult.snapshot.length > 0, `${wikiResult.snapshot.length} chars`);

  // ── 7. YouTube transcript  ─────────────────────────────────────────────────
  // Uses a TED Talk with reliable manual captions. The function tries timedtext
  // API first, then falls back to page content if captions are unavailable.
  // The fallback always returns page text so transcript non-empty should pass.
  console.log('\n── 7. YouTube transcript  (~10-30s)');
  const ytResult = await fetchYoutubeTranscript('https://www.youtube.com/watch?v=8S0FDjFBj8o');
  // error is acceptable if the fallback page-content path ran — check transcript instead
  if (ytResult.error && (ytResult.transcript?.length ?? 0) === 0) {
    check('no error or fallback content', false, ytResult.error ?? '');
  } else {
    check('no error or fallback content', true, ytResult.error ? `fallback used` : 'captions extracted');
  }
  check('transcript non-empty', (ytResult.transcript?.length ?? 0) > 0, `${ytResult.transcript?.length ?? 0} chars`);
  check('title present',        (ytResult.title?.length ?? 0) > 0,      `title="${ytResult.title}"`);

  // ── 8. Stability check ─────────────────────────────────────────────────────
  console.log('\n── 8. Stability check');
  check('still running after all calls', getCamofoxStatus().state === 'running');

  // ── 9. Stop ────────────────────────────────────────────────────────────────
  console.log('\n── 9. Stop');
  await stopCamofox();
  check('state === stopped', getCamofoxStatus().state === 'stopped', `state=${getCamofoxStatus().state}`);

  // ── 10. Restart ────────────────────────────────────────────────────────────
  console.log('\n── 10. Restart');
  await startCamofox();
  check('restarts cleanly', getCamofoxStatus().state === 'running', `state=${getCamofoxStatus().state}`);
  await stopCamofox();

  // ── Summary ────────────────────────────────────────────────────────────────
  const exitCode = process.exitCode ?? 0;
  console.log('\n══════════════════════════════════════════════════════════');
  if (exitCode === 0) {
    console.log('  ✅  All Camofox tests passed.');
  } else {
    console.log('  ❌  Some tests failed. See above for details.');
  }
  console.log('══════════════════════════════════════════════════════════\n');
}

run().catch(err => {
  console.error('\n[test-camofox] Unhandled error:', err);
  process.exit(1);
});
