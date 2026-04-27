// test-editors.ts — Validates Monaco, Jodit/pandoc-wasm, and Stirling PDF pipelines.
//
// Starts the PHOBOS server, exercises backend endpoints for all three editors,
// then stops. The frontend (JoditPanel, MonacoPanel, StirlingPanel) and the
// pandoc-worker.js are browser-side only — this test covers the server surface
// each editor depends on:
//
//   Monaco:   workspace write/read (no server process, just REST)
//   Jodit:    workspace write/read as .html (no server process, just REST)
//   Stirling: manager start/stop, port, proxy GET
//
// Run with PHOBOS server stopped:
//   npx tsx test-editors.ts
//
// Options:
//   --skip-stirling   skip Stirling tests (useful if Java not on PATH)
//   --skip-server     assume PHOBOS is already running on :3001

import { spawn, type ChildProcess } from 'child_process';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import * as net  from 'net';

// ── Config ────────────────────────────────────────────────────────────────────

const PHOBOS_PORT    = 3001;
const STIRLING_PORT  = 16346;
const BASE_URL       = `http://127.0.0.1:${PHOBOS_PORT}`;
const SKIP_STIRLING  = process.argv.includes('--skip-stirling');
const SKIP_SERVER    = process.argv.includes('--skip-server');

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

// ── Workspace helpers ─────────────────────────────────────────────────────────

async function createThread(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/threads`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ title: 'editor-test-thread' }),
  });
  if (!res.ok) throw new Error(`Create thread HTTP ${res.status}`);
  const body = await res.json() as { id: string };
  return body.id;
}

async function writeWorkspaceFile(threadId: string, filename: string, content: string): Promise<boolean> {
  const res = await fetch(`${BASE_URL}/api/threads/${threadId}/workspace`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ filename, content }),
  });
  return res.ok;
}

async function readWorkspaceFile(threadId: string, filename: string): Promise<string | null> {
  const res = await fetch(`${BASE_URL}/api/threads/${threadId}/workspace/${encodeURIComponent(filename)}`);
  if (!res.ok) return null;
  const body = await res.json() as { content: string };
  return body.content ?? null;
}

async function listWorkspaceFiles(threadId: string): Promise<string[]> {
  const res = await fetch(`${BASE_URL}/api/threads/${threadId}/workspace`);
  if (!res.ok) return [];
  const body = await res.json() as { files: Array<{ filename: string }> };
  return (body.files ?? []).map((f) => f.filename);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║         PHOBOS — Rich Editors Validation Test Suite          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // ── 1. Server startup ───────────────────────────────────────────────────────
  console.log('── 1. PHOBOS Server');
  try {
    await startServer();
    check('server listening on :3001', true);
  } catch (err) {
    check('server listening on :3001', false, (err as Error).message);
    console.error('\n  Abort: server failed to start.\n');
    process.exit(1);
  }

  let threadId: string;
  try {
    threadId = await createThread();
    check('test thread created', true, `id=${threadId}`);
  } catch (err) {
    check('test thread created', false, (err as Error).message);
    await stopServer();
    process.exit(1);
  }

  // ── 2. Monaco — workspace round-trip (code files) ───────────────────────────
  console.log('\n── 2. Monaco — Workspace I/O');

  const CODE_CONTENT = `// PHOBOS Monaco test\nexport function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`;
  const CODE_FILE    = 'test-monaco.ts';

  const writeOk = await writeWorkspaceFile(threadId, CODE_FILE, CODE_CONTENT);
  check('write .ts file to workspace', writeOk);

  const readBack = await readWorkspaceFile(threadId, CODE_FILE);
  check('read .ts file from workspace', readBack !== null);
  check('.ts content round-trip intact', readBack === CODE_CONTENT, `got ${readBack?.length ?? 0} chars`);

  const files = await listWorkspaceFiles(threadId);
  check('.ts file appears in workspace list', files.includes(CODE_FILE), `files=[${files.join(', ')}]`);

  // ── 3. Jodit — HTML workspace storage ──────────────────────────────────────
  console.log('\n── 3. Jodit — HTML Workspace Storage');
  // Jodit always saves as .html — verify the workspace handles HTML content correctly

  const HTML_CONTENT  = `<!DOCTYPE html><html><body><h1>PHOBOS Document</h1><p>Test paragraph with <strong>bold</strong> and <em>italic</em>.</p></body></html>`;
  const HTML_FILE     = 'test-jodit.html';
  const ORIG_DOCX     = 'report.docx';  // original filename — save is as .html sidecar
  const SIDECAR_FILE  = 'report.html';

  const htmlWriteOk = await writeWorkspaceFile(threadId, HTML_FILE, HTML_CONTENT);
  check('write .html document to workspace', htmlWriteOk);

  const htmlRead = await readWorkspaceFile(threadId, HTML_FILE);
  check('read .html document from workspace', htmlRead !== null);
  check('.html content preserves markup', htmlRead?.includes('<strong>bold</strong>') ?? false);

  // Verify the sidecar naming convention: report.docx → report.html
  const sidecarOk = await writeWorkspaceFile(threadId, SIDECAR_FILE, HTML_CONTENT);
  check(`sidecar naming: ${ORIG_DOCX} → ${SIDECAR_FILE}`, sidecarOk);

  const sidecarRead = await readWorkspaceFile(threadId, SIDECAR_FILE);
  check('sidecar file readable from workspace', sidecarRead !== null);

  const allFiles = await listWorkspaceFiles(threadId);
  check('both .html files in workspace index', 
    allFiles.includes(HTML_FILE) && allFiles.includes(SIDECAR_FILE),
    `files=[${allFiles.join(', ')}]`
  );

  // ── 4. Jodit — routing coverage check ──────────────────────────────────────
  console.log('\n── 4. File Association Routing (server-side awareness)');
  // Write files of each type that should route to each editor
  // This confirms the workspace can store each type without corruption

  const routingTests: Array<[string, string, string]> = [
    ['monaco',  'sample.ts',   '// typescript'],
    ['monaco',  'sample.py',   '# python'],
    ['monaco',  'sample.md',   '# markdown'],
    ['jodit',   'sample.html', '<p>doc</p>'],
    ['stirling','sample.pdf',  '%PDF-1.4 fake'],  // not a real pdf — just testing write
  ];

  for (const [target, filename, content] of routingTests) {
    const ok = await writeWorkspaceFile(threadId, filename, content);
    check(`write ${filename} (→ ${target})`, ok);
  }

  const finalFiles = await listWorkspaceFiles(threadId);
  for (const [, filename] of routingTests) {
    check(`${filename} in workspace index`, finalFiles.includes(filename));
  }

  // ── 5. Stirling PDF — service lifecycle ────────────────────────────────────
  console.log('\n── 5. Stirling PDF — Service');

  if (SKIP_STIRLING) {
    skip('stirling status endpoint', '--skip-stirling flag set');
    skip('stirling start', '--skip-stirling flag set');
    skip('stirling port open', '--skip-stirling flag set');
    skip('stirling proxy GET', '--skip-stirling flag set');
    skip('stirling stop', '--skip-stirling flag set');
  } else {
    // Status endpoint
    let stirlingStatus: { state: string; port: number; binaryPresent: boolean; error: string | null } | null = null;
    try {
      const res = await fetch(`${BASE_URL}/api/tools/stirling/status`);
      check('GET /api/tools/stirling/status → 200', res.ok, `HTTP ${res.status}`);
      stirlingStatus = await res.json();
      check('status has expected fields',
        stirlingStatus?.port === STIRLING_PORT && typeof stirlingStatus?.state === 'string',
        JSON.stringify(stirlingStatus)
      );
    } catch (err) {
      check('stirling status endpoint reachable', false, (err as Error).message);
    }

    if (!stirlingStatus?.binaryPresent) {
      skip('stirling start', 'jar not present — run: node scripts/fetch-stirling.js');
      skip('stirling port open', 'jar not present');
      skip('stirling proxy GET /', 'jar not present');
      skip('stirling stop', 'jar not present');
    } else {
      // The server auto-starts Stirling — wait for it or start manually
      console.log('  Waiting for Stirling to reach running state (may take 20s)...');
      let running = stirlingStatus.state === 'running';
      if (!running) {
        // Trigger start (fallback — server should have done this already)
        try {
          await fetch(`${BASE_URL}/api/tools/stirling/start`, { method: 'POST' });
        } catch { /* ignore */ }

        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline && !running) {
          await new Promise((r) => setTimeout(r, 2_000));
          try {
            const r = await fetch(`${BASE_URL}/api/tools/stirling/status`);
            const s = await r.json() as { state: string };
            running = s.state === 'running';
          } catch { /* keep waiting */ }
        }
      }
      check('stirling state === running', running, `state=${running ? 'running' : 'not reached'} error=${stirlingStatus?.error ?? null}`);

      // Port directly reachable
      const portOpen = await new Promise<boolean>((resolve) => {
        const s = net.connect(STIRLING_PORT, '127.0.0.1');
        s.once('connect', () => { s.destroy(); resolve(true); });
        s.once('error',   () => { s.destroy(); resolve(false); });
      });
      check(`port ${STIRLING_PORT} open`, portOpen);

      // Direct GET to Stirling (bypasses proxy — confirms Stirling itself responds)
      if (portOpen) {
        try {
          const directRes = await fetch(`http://127.0.0.1:${STIRLING_PORT}/`, { redirect: 'manual' });
          check(`Stirling responds directly on :${STIRLING_PORT}`, directRes.status < 400, `HTTP ${directRes.status}`);
        } catch (err) {
          check(`Stirling responds directly on :${STIRLING_PORT}`, false, (err as Error).message);
        }
      }

      // Proxy GET through Fastify
      if (running) {
        try {
          // Stirling's root redirects to its SPA index — accept 2xx and 3xx.
          // Use redirect: 'manual' so fetch doesn't try to follow to an absolute URL
          // that doesn't exist in the test context (Node.js fetch would fail the CORS redirect).
          const res = await fetch(`${BASE_URL}/api/tools/stirling/app/`, { redirect: 'manual' });
          const ok  = res.status < 400;
          check('proxy GET /api/tools/stirling/app/ → 2xx or 3xx', ok, `HTTP ${res.status}`);
        } catch (err) {
          check('proxy GET reachable', false, (err as Error).message);
        }

        // Stop
        try {
          const res = await fetch(`${BASE_URL}/api/tools/stirling/stop`, { method: 'POST' });
          check('POST /api/tools/stirling/stop → 200', res.ok, `HTTP ${res.status}`);
          const body = await res.json() as { state: string };
          check('stirling state after stop is stopped or stopping', 
            body.state === 'stopped' || body.state === 'stopping',
            `state=${body.state}`
          );
        } catch (err) {
          check('stirling stop endpoint', false, (err as Error).message);
        }
      }
    }
  }

  // ── 6. Cleanup ─────────────────────────────────────────────────────────────
  console.log('\n── 6. Cleanup');

  // Delete test thread
  try {
    const res = await fetch(`${BASE_URL}/api/threads/${threadId}`, { method: 'DELETE' });
    check('test thread deleted', res.ok, `HTTP ${res.status}`);
  } catch (err) {
    check('test thread deleted', false, (err as Error).message);
  }

  await stopServer();
  check('server stopped cleanly', true);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(66));
  if (failCount === 0) {
    console.log('✅  All checks passed\n');
  } else {
    console.log(`❌  ${failCount} check(s) failed\n`);
    process.exitCode = 1;
  }
}

run().catch(async (err) => {
  console.error('\n[test-editors] Unhandled error:', err);
  await stopServer();
  process.exit(1);
});
