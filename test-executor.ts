/**
 * test-executor.ts
 *
 * Validates the PHOBOS Sandbox Executor subsystem end-to-end.
 * Run with:   npx tsx test-executor.ts
 *
 * The application must be CLOSED when this runs (no port conflicts, no DuckDB locks).
 * Tests do NOT require the executor feature flag to be enabled — they call the
 * execution layer directly, bypassing the LoopController gate.
 *
 * Expected layout (relative to this file):
 *   test-outputs/execution/javascript/pass/hello.js
 *   test-outputs/execution/javascript/fail/divide.js
 *   test-outputs/execution/python/pass/hello.py
 *   test-outputs/execution/python/fail/bad.py
 *   test-outputs/execution/bash/pass/hello.sh
 *   test-outputs/execution/bash/fail/bad.sh
 */

import * as path from 'path';
import * as fs   from 'fs/promises';
import * as os   from 'os';
import { resolveRuntime } from './execution/RuntimeResolver.js';
import { runInSandbox }   from './execution/SandboxExecutor.js';
import { createSandbox, validateEntrypoint } from './execution/SandboxManager.js';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const FIXTURES = path.join(ROOT, 'test-outputs', 'execution');
const TIMEOUT_MS = 15_000;

// ── Result tracking ───────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: TestResult[] = [];

function pass(name: string, detail = ''): void {
  results.push({ name, passed: true, detail });
  console.log(`  ✓  ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name: string, detail: string): void {
  results.push({ name, passed: false, detail });
  console.error(`  ✗  ${name} — ${detail}`);
}

// ── Section header ────────────────────────────────────────────────────────────

function section(title: string): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

// ── Helper: copy fixture into a fresh sandbox and run it ──────────────────────

async function runFixture(
  runtime: 'node' | 'python' | 'bash',
  fixturePath: string,   // absolute path to the fixture file
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; durationMs: number }> {
  const entrypoint = path.basename(fixturePath);
  const taskId     = `test-${runtime}-${entrypoint}-${Date.now()}`;

  const sandbox = await createSandbox({
    taskId,
    workspaceDir: path.dirname(fixturePath),
    sourceFiles:  [entrypoint],
    useWorkspace: true,
  });

  try {
    if (!validateEntrypoint(entrypoint, sandbox.sandboxDir)) {
      throw new Error(`Entrypoint "${entrypoint}" not found in sandbox after copy`);
    }
    return await runInSandbox({ runtime, entrypoint, sandboxDir: sandbox.sandboxDir, timeoutMs: TIMEOUT_MS });
  } finally {
    await sandbox.cleanup();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Section 1 — RuntimeResolver
// ═════════════════════════════════════════════════════════════════════════════

async function testRuntimeResolver(): Promise<void> {
  section('1. RuntimeResolver — runtime detection');

  for (const runtime of ['node', 'python', 'bash'] as const) {
    try {
      const resolved = await resolveRuntime(runtime);
      if (!resolved.cmd || typeof resolved.cmd !== 'string') {
        fail(`resolve ${runtime}`, `cmd is empty or non-string: ${JSON.stringify(resolved)}`);
      } else {
        pass(`resolve ${runtime}`, `cmd="${resolved.cmd}" prefixArgs=${JSON.stringify(resolved.prefixArgs)}`);
      }
    } catch (err) {
      fail(`resolve ${runtime}`, (err as Error).message);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Section 2 — SandboxManager
// ═════════════════════════════════════════════════════════════════════════════

async function testSandboxManager(): Promise<void> {
  section('2. SandboxManager — sandbox lifecycle');

  // Creates a temp dir
  let sandboxDir = '';
  const sandbox = await createSandbox({
    taskId:       'lifecycle-test',
    workspaceDir: ROOT,
    sourceFiles:  [],
    useWorkspace: false,
  });
  sandboxDir = sandbox.sandboxDir;

  try {
    const stat = await fs.stat(sandboxDir);
    if (stat.isDirectory()) {
      pass('creates temp directory', sandboxDir);
    } else {
      fail('creates temp directory', 'path exists but is not a directory');
    }
  } catch {
    fail('creates temp directory', `directory not found: ${sandboxDir}`);
  }

  // validateEntrypoint rejects directory traversal
  const rejected = !validateEntrypoint('../escape.ts', sandboxDir)
    && !validateEntrypoint('/absolute/path.ts', sandboxDir)
    && !validateEntrypoint('sub/dir/file.ts', sandboxDir);
  if (rejected) {
    pass('validateEntrypoint rejects unsafe paths');
  } else {
    fail('validateEntrypoint rejects unsafe paths', 'one or more unsafe paths were accepted');
  }

  // validateEntrypoint accepts a real file
  const tmpFile = path.join(sandboxDir, 'probe.js');
  await fs.writeFile(tmpFile, 'console.log("probe")');
  if (validateEntrypoint('probe.js', sandboxDir)) {
    pass('validateEntrypoint accepts valid entrypoint');
  } else {
    fail('validateEntrypoint accepts valid entrypoint', 'returned false for existing file');
  }

  // Cleanup removes the directory
  await sandbox.cleanup();
  try {
    await fs.stat(sandboxDir);
    fail('cleanup removes directory', 'directory still exists after cleanup');
  } catch {
    pass('cleanup removes directory');
  }

  // Source file copy: copies declared workspace files into sandbox
  const jsFixture = path.join(FIXTURES, 'javascript', 'pass');
  const copyTest = await createSandbox({
    taskId:       'copy-test',
    workspaceDir: jsFixture,
    sourceFiles:  ['hello.js'],
    useWorkspace: true,
  });
  try {
    const copied = validateEntrypoint('hello.js', copyTest.sandboxDir);
    if (copied) {
      pass('sourceFiles copied into sandbox', 'hello.js present');
    } else {
      fail('sourceFiles copied into sandbox', 'hello.js not found after copy');
    }
  } finally {
    await copyTest.cleanup();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Section 3 — JavaScript fixtures
// ═════════════════════════════════════════════════════════════════════════════

async function testJavaScript(): Promise<void> {
  section('3. SandboxExecutor — JavaScript (node/tsx)');

  // PASS: exits 0, stdout contains expected text
  try {
    const result = await runFixture('node', path.join(FIXTURES, 'javascript', 'pass', 'hello.js'));
    if (result.exitCode === 0) {
      pass('js/pass exits 0', `${(result.durationMs / 1000).toFixed(2)}s`);
    } else {
      fail('js/pass exits 0', `exitCode=${result.exitCode} stderr="${result.stderr.slice(0, 120)}"`);
    }
    if (result.stdout.includes('PHOBOS Executor')) {
      pass('js/pass stdout correct', result.stdout.trim().split('\n')[0]);
    } else {
      fail('js/pass stdout correct', `got: "${result.stdout.slice(0, 120)}"`);
    }
    if (!result.timedOut) {
      pass('js/pass did not time out');
    } else {
      fail('js/pass did not time out', 'timedOut=true');
    }
  } catch (err) {
    fail('js/pass', (err as Error).message);
  }

  // FAIL: exits non-zero, stderr contains error
  try {
    const result = await runFixture('node', path.join(FIXTURES, 'javascript', 'fail', 'divide.js'));
    if (result.exitCode !== 0) {
      pass('js/fail exits non-zero', `exitCode=${result.exitCode}`);
    } else {
      fail('js/fail exits non-zero', 'exited 0 — error was not thrown');
    }
    if (result.stderr.length > 0) {
      pass('js/fail stderr captured', result.stderr.trim().split('\n')[0]);
    } else {
      fail('js/fail stderr captured', 'stderr is empty');
    }
  } catch (err) {
    fail('js/fail', (err as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Section 4 — Python fixtures
// ═════════════════════════════════════════════════════════════════════════════

async function testPython(): Promise<void> {
  section('4. SandboxExecutor — Python');

  // Detect python availability first
  let pythonAvailable = true;
  try {
    const resolved = await resolveRuntime('python');
    if (!resolved.cmd) pythonAvailable = false;
  } catch {
    pythonAvailable = false;
  }

  if (!pythonAvailable) {
    console.log('  ⚠  Python not detected — skipping python fixtures');
    results.push({ name: 'python (skipped — not detected)', passed: true, detail: 'no python binary found' });
    return;
  }

  // PASS
  try {
    const result = await runFixture('python', path.join(FIXTURES, 'python', 'pass', 'hello.py'));
    if (result.exitCode === 0) {
      pass('python/pass exits 0', `${(result.durationMs / 1000).toFixed(2)}s`);
    } else {
      fail('python/pass exits 0', `exitCode=${result.exitCode} stderr="${result.stderr.slice(0, 120)}"`);
    }
    if (result.stdout.includes('PHOBOS Executor')) {
      pass('python/pass stdout correct', result.stdout.trim().split('\n')[0]);
    } else {
      fail('python/pass stdout correct', `got: "${result.stdout.slice(0, 120)}"`);
    }
  } catch (err) {
    fail('python/pass', (err as Error).message);
  }

  // FAIL
  try {
    const result = await runFixture('python', path.join(FIXTURES, 'python', 'fail', 'bad.py'));
    if (result.exitCode !== 0) {
      pass('python/fail exits non-zero', `exitCode=${result.exitCode}`);
    } else {
      fail('python/fail exits non-zero', 'exited 0 — ZeroDivisionError was not raised');
    }
    if (result.stderr.includes('ZeroDivisionError')) {
      pass('python/fail stderr contains ZeroDivisionError');
    } else {
      fail('python/fail stderr contains ZeroDivisionError', `stderr: "${result.stderr.slice(0, 120)}"`);
    }
  } catch (err) {
    fail('python/fail', (err as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Section 5 — Bash fixtures
// ═════════════════════════════════════════════════════════════════════════════

async function testBash(): Promise<void> {
  section('5. SandboxExecutor — Bash');

  if (process.platform === 'win32') {
    console.log('  ⚠  Bash not available on Windows — skipping bash fixtures');
    results.push({ name: 'bash (skipped — windows)', passed: true, detail: 'platform=win32' });
    return;
  }

  // PASS
  try {
    const result = await runFixture('bash', path.join(FIXTURES, 'bash', 'pass', 'hello.sh'));
    if (result.exitCode === 0) {
      pass('bash/pass exits 0', `${(result.durationMs / 1000).toFixed(2)}s`);
    } else {
      fail('bash/pass exits 0', `exitCode=${result.exitCode} stderr="${result.stderr.slice(0, 120)}"`);
    }
    if (result.stdout.includes('PHOBOS Executor')) {
      pass('bash/pass stdout correct', result.stdout.trim().split('\n')[0]);
    } else {
      fail('bash/pass stdout correct', `got: "${result.stdout.slice(0, 120)}"`);
    }
  } catch (err) {
    fail('bash/pass', (err as Error).message);
  }

  // FAIL
  try {
    const result = await runFixture('bash', path.join(FIXTURES, 'bash', 'fail', 'bad.sh'));
    if (result.exitCode !== 0) {
      pass('bash/fail exits non-zero', `exitCode=${result.exitCode}`);
    } else {
      fail('bash/fail exits non-zero', 'exited 0 — bad command was not caught');
    }
    if (result.stderr.length > 0) {
      pass('bash/fail stderr captured', result.stderr.trim().split('\n')[0]);
    } else {
      fail('bash/fail stderr captured', 'stderr is empty');
    }
  } catch (err) {
    fail('bash/fail', (err as Error).message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Section 6 — Timeout enforcement
// ═════════════════════════════════════════════════════════════════════════════

async function testTimeout(): Promise<void> {
  section('6. SandboxExecutor — Timeout enforcement');

  // Write a script that sleeps forever into a temp sandbox, run with 1s timeout
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phobos-timeout-test-'));
  try {
    const script = path.join(tmpDir, 'sleep.js');
    // Loop forever without blocking the event loop (setTimeout chain)
    await fs.writeFile(script, `
const loop = () => setTimeout(loop, 100);
loop();
`);

    const sandbox = await createSandbox({
      taskId: 'timeout-test',
      workspaceDir: tmpDir,
      sourceFiles: ['sleep.js'],
      useWorkspace: true,
    });

    try {
      const result = await runInSandbox({
        runtime: 'node',
        entrypoint: 'sleep.js',
        sandboxDir: sandbox.sandboxDir,
        timeoutMs: 1_500,   // 1.5s — well below TIMEOUT_MS
      });

      if (result.timedOut) {
        pass('timeout fires correctly', `killed after ${(result.durationMs / 1000).toFixed(2)}s`);
      } else {
        fail('timeout fires correctly', `timedOut=false exitCode=${result.exitCode}`);
      }
      if (result.durationMs < 5_000) {
        pass('timeout is prompt', `${result.durationMs}ms elapsed`);
      } else {
        fail('timeout is prompt', `took ${result.durationMs}ms — watchdog may not have fired`);
      }
    } finally {
      await sandbox.cleanup();
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Section 7 — Output cap enforcement
// ═════════════════════════════════════════════════════════════════════════════

async function testOutputCap(): Promise<void> {
  section('7. SandboxExecutor — 50 KB output cap');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phobos-cap-test-'));
  try {
    // Write a script that emits well over 50 KB of stdout
    const script = path.join(tmpDir, 'flood.js');
    await fs.writeFile(script, `
const line = 'X'.repeat(1000) + '\\n';
for (let i = 0; i < 200; i++) process.stdout.write(line);
`);

    const sandbox = await createSandbox({
      taskId: 'cap-test',
      workspaceDir: tmpDir,
      sourceFiles: ['flood.js'],
      useWorkspace: true,
    });

    try {
      const result = await runInSandbox({
        runtime: 'node',
        entrypoint: 'flood.js',
        sandboxDir: sandbox.sandboxDir,
        timeoutMs: TIMEOUT_MS,
      });

      const totalBytes = Buffer.byteLength(result.stdout, 'utf-8');
      if (totalBytes <= 52_000) {   // 50 KB + truncation marker overhead
        pass('output capped at ~50 KB', `captured ${totalBytes} bytes`);
      } else {
        fail('output capped at ~50 KB', `captured ${totalBytes} bytes — cap not enforced`);
      }
      if (result.stdout.includes('[output truncated')) {
        pass('truncation marker present');
      } else {
        fail('truncation marker present', 'truncation text not found in stdout');
      }
    } finally {
      await sandbox.cleanup();
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Section 8 — Environment isolation
// ═════════════════════════════════════════════════════════════════════════════

async function testEnvIsolation(): Promise<void> {
  section('8. SandboxExecutor — Environment isolation');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phobos-env-test-'));
  try {
    const script = path.join(tmpDir, 'env-check.js');
    // Print all env keys — none of these should leak into the sandbox
    await fs.writeFile(script, `
const env = process.env;
const keys = Object.keys(env);
// Check for known sensitive patterns
const sensitive = keys.filter(k =>
  k.includes('ANTHROPIC') ||
  k.includes('API_KEY') ||
  k.includes('PHOBOS_') ||
  k.includes('SECRET') ||
  k.includes('TOKEN') ||
  k.includes('PASSWORD') ||
  k.includes('DUCK') ||
  k.includes('DATABASE')
);
console.log(JSON.stringify({ allKeys: keys, sensitiveFound: sensitive }));
`);

    const sandbox = await createSandbox({
      taskId: 'env-test',
      workspaceDir: tmpDir,
      sourceFiles: ['env-check.js'],
      useWorkspace: true,
    });

    try {
      const result = await runInSandbox({
        runtime: 'node',
        entrypoint: 'env-check.js',
        sandboxDir: sandbox.sandboxDir,
        timeoutMs: TIMEOUT_MS,
      });

      if (result.exitCode === 0) {
        try {
          const parsed = JSON.parse(result.stdout.trim());
          if (parsed.sensitiveFound.length === 0) {
            pass('no sensitive env vars leak into sandbox', `${parsed.allKeys.length} env keys total`);
          } else {
            fail('no sensitive env vars leak into sandbox',
              `found: ${(parsed.sensitiveFound as string[]).join(', ')}`);
          }
          // Should have at minimum PATH
          if ((parsed.allKeys as string[]).includes('PATH')) {
            pass('PATH is available in sandbox');
          } else {
            fail('PATH is available in sandbox', 'PATH not found in sandbox env');
          }
        } catch {
          fail('env isolation parse', `could not parse stdout: "${result.stdout.slice(0, 120)}"`);
        }
      } else {
        fail('env isolation script ran', `exitCode=${result.exitCode} stderr="${result.stderr.slice(0, 120)}"`);
      }
    } finally {
      await sandbox.cleanup();
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Main
// ═════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('\nPHOBOS Sandbox Executor — Test Suite');
  console.log('Application must be closed before running this script.');
  console.log(`Platform: ${process.platform} | Node: ${process.version}`);

  await testRuntimeResolver();
  await testSandboxManager();
  await testJavaScript();
  await testPython();
  await testBash();
  await testTimeout();
  await testOutputCap();
  await testEnvIsolation();

  // ── Summary ───────────────────────────────────────────────────────────────
  const total  = results.length;
  const passed = results.filter(r => r.passed).length;
  const failed = total - passed;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  RESULTS: ${passed}/${total} passed${failed > 0 ? `  (${failed} failed)` : ''}`);
  if (failed > 0) {
    console.log('\n  Failed tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`    ✗  ${r.name}`);
      if (r.detail) console.log(`       ${r.detail}`);
    });
  }
  console.log('═'.repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nFatal test error:', err);
  process.exit(1);
});
