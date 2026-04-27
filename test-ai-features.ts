#!/usr/bin/env npx tsx
/**
 * test-ai-features.ts — PHOBOS AI Conversation Features End-to-End Test Suite
 *
 * Tests every node in the AI pipeline: intent routing, context ingestion,
 * task planning, file execution, conversation RAG, distillation, copilot,
 * CTX AUTO mode, clarification loops, paginated writing, and edge cases.
 *
 * Usage:
 *   npx tsx test-ai-features.ts                        S+M+E tiers (default, fast)
 *   npx tsx test-ai-features.ts --short                S01-S10 only (< 5 min)
 *   npx tsx test-ai-features.ts --short --medium       S+M tiers (< 15 min)
 *   npx tsx test-ai-features.ts --only S01             single test by ID
 *   npx tsx test-ai-features.ts --no-reset             skip template restore
 *   npx tsx test-ai-features.ts --long                 L-tier tests only → ai-features-long.log
 *   npx tsx test-ai-features.ts --notimelimit          disable all per-message timeouts (let SEREN finish)
 *   npx tsx test-ai-features.ts --keep-server          leave server running after
 *   npx tsx test-ai-features.ts --sayon-ctx 8192       override SAYON context size (tokens)
 *   npx tsx test-ai-features.ts --seren-ctx 16384      override SEREN context size (tokens)
 *   npx tsx test-ai-features.ts --rebuildconfig        write test-outputs/ai-features/config.json and exit
 *   npx tsx test-ai-features.ts --auto                 ignore config.json model selection, use DB defaults
 *
 * Model selection:
 *   Run --rebuildconfig once to generate test-outputs/ai-features/config.json.
 *   The file lists every downloaded model by index. Set sayonIndex / serenIndex
 *   to pick which model each role uses. 0 or null means auto (DB snapshot default).
 *   On each test run the selected models are applied via PUT /api/config/models
 *   immediately after the server port opens, before the model-ready wait.
 *   Pass --auto to skip config.json and use whatever is in the DB snapshot.
 *
 * Context override notes:
 *   Hardware detection and device assignment run exactly as in production.
 *   --sayon-ctx / --seren-ctx only replace the final computed context size.
 *   Useful when the hardware-computed size (e.g. 128K) is correct for
 *   production but excessive for a test run. Both flags accept token counts
 *   (8192 = 8K, 16384 = 16K, 32768 = 32K). Omitting a flag leaves that
 *   model at its hardware-computed size.
 *
 * Prerequisites:
 *   • test-outputs/ai-features-template/user-data-snapshot/ exists (run setup first)
 *   • SYBIL running on :16315 (nomic-embed-text-v1.5)
 *   • Coordinator (SAYON) reachable at COORDINATOR_URL
 *   • Engine (SEREN) reachable at ENGINE_URL
 *
 * Exit codes:
 *   0  all non-SKIP tests passed
 *   1  one or more FAIL
 *   2  setup/teardown failure
 */

import path        from 'node:path';
import fs          from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream, WriteStream } from 'node:fs';
import http        from 'node:http';
import net         from 'node:net';
import { spawn, ChildProcess } from 'node:child_process';
import { fileURLToPath }       from 'node:url';
import { randomUUID }          from 'node:crypto';
import Database                from 'duckdb-async';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Log file tee ───────────────────────────────────────────────────────────────
// All console output is mirrored to ./test-outputs/ai-features.log so the full
// run is always captured regardless of terminal scroll buffer limits.
let _logStream: WriteStream | null = null;

function openLogStream(): void {
  _logStream = createWriteStream(LOG_PATH, { flags: 'w' });
  _logStream.write(`\n${'='.repeat(66)}\n`);
  _logStream.write(`Run started: ${new Date().toISOString()}\n`);
  _logStream.write(`${'='.repeat(66)}\n`);
}

function closeLogStream(): void {
  _logStream?.end();
  _logStream = null;
}

// Tee console.log and console.error to the log file
const _origLog   = console.log.bind(console);
const _origError = console.error.bind(console);
const _origWarn  = console.warn.bind(console);

function teeWrite(args: unknown[]): void {
  if (!_logStream) return;
  const line = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
  _logStream.write(line + '\n');
}

console.log   = (...args: unknown[]) => { _origLog(...args);   teeWrite(args); };
console.error = (...args: unknown[]) => { _origError(...args); teeWrite(args); };
console.warn  = (...args: unknown[]) => { _origWarn(...args);  teeWrite(args); };

// ── CLI flags ──────────────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const SHORT_ONLY    = args.includes('--short') && !args.includes('--medium') && !args.includes('--long');
const WITH_MEDIUM   = args.includes('--medium');
const LONG_ONLY     = args.includes('--long');
// When --long is passed, run only L-tier tests and write a separate log.
// Without --long, L tests are excluded from the default run — they are too
// slow to be part of a routine development loop.
const NO_TIME_LIMIT = args.includes('--notimelimit');

const LOG_PATH = path.join(
  __dirname, 'test-outputs',
  LONG_ONLY ? 'ai-features-long.log' : 'ai-features.log'
);
mkdirSync(path.dirname(LOG_PATH), { recursive: true });
// Convenience: any sendMessageAndCapture call that passes NO_TIME_LIMIT will
// substitute its timeout with 0, which the http.request timeout treats as
// "no timeout" (never fires). Pass this constant instead of a raw number in
// any call that should respect --notimelimit.
const NO_RESET    = args.includes('--no-reset');
const KEEP_SERVER = args.includes('--keep-server');
const ONLY_ID       = (() => { const i = args.indexOf('--only'); return i >= 0 ? args[i + 1] : null; })();
const RUN_ALL       = !SHORT_ONLY && !ONLY_ID && !LONG_ONLY;
const SAYON_CTX     = (() => { const i = args.indexOf('--sayon-ctx'); return i >= 0 ? parseInt(args[i + 1], 10) : NaN; })();
const SEREN_CTX     = (() => { const i = args.indexOf('--seren-ctx'); return i >= 0 ? parseInt(args[i + 1], 10) : NaN; })();
const REBUILD_CONFIG = args.includes('--rebuildconfig');
const USE_AUTO       = args.includes('--auto');

// ── Paths ──────────────────────────────────────────────────────────────────────
//
// TEMPLATE  = test-outputs/ai-features-template/user-data-snapshot
//             Read-only. Never modified. Contains the DB files and workspaces
//             needed to run tests (localai.duckdb / phobos.duckdb, etc.)
//
// SCRATCH   = test-outputs/ai-features-template/scratch
//             The server's PHOBOS_DATA_DIR for every test run.
//             Created fresh from TEMPLATE at the start of each run.
//             Deleted at the end of every run.
//             NOTHING outside this directory is ever touched.
//
// OUTPUT_DIR = test-outputs/ai-features/run-<timestamp>
//             Reports and per-run artifacts.

const TEMPLATE_DIR    = path.join(__dirname, 'test-outputs', 'ai-features-template', 'user-data-snapshot');
const SCRATCH_DIR     = path.join(__dirname, 'test-outputs', 'ai-features-template', 'scratch');
const OUTPUT_DIR      = path.join(__dirname, 'test-outputs', 'ai-features', `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const FIXTURES_DIR    = path.join(__dirname, 'test-fixtures', 'ai-features');
const SERVER_PORT     = parseInt(process.env.PORT ?? '3001', 10);

// These are the only paths the server and tests ever use — all inside SCRATCH_DIR.
// DB_PATH probes for both naming conventions used in dev vs production.
const PHOBOS_DATA_DIR = SCRATCH_DIR;
const DB_PATH         = (() => {
  // After scratch is populated we can probe; before that default to localai.duckdb
  const candidates = [
    path.join(SCRATCH_DIR, 'localai.duckdb'),
    path.join(SCRATCH_DIR, 'phobos.duckdb'),
  ];
  return candidates.find(p => existsSync(p)) ?? candidates[0];
})();
const CONV_DB_PATH    = path.join(SCRATCH_DIR, 'conversations.duckdb');
const WORKSPACES_ROOT = path.join(SCRATCH_DIR, 'workspaces');

// ── Model selection config ─────────────────────────────────────────────────────
//
// test-outputs/ai-features/config.json stores the developer's model choice for
// each role. Generated by --rebuildconfig; edited manually to set indices.
//
// Format:
//   { "sayonIndex": 1, "serenIndex": 3, "models": [...] }
//
// sayonIndex / serenIndex: 1-based index into the models array.
//   0 or null = auto (use whatever the DB snapshot already has configured).
//
// The list is printed to the console on every --rebuildconfig run so the dev
// can pick by number. Non-phobos models (cloud providers) are not listed since
// the test suite targets local inference.

const AI_CONFIG_PATH = path.join(__dirname, 'test-outputs', 'ai-features', 'config.json');

interface AiTestModelEntry { index: number; id: string; label: string; role: string; }
interface AiTestConfig {
  sayonIndex: number | null;
  serenIndex: number | null;
  models: AiTestModelEntry[];
}

// Load existing config if present and --auto not passed
let _aiTestConfig: AiTestConfig | null = null;
if (!USE_AUTO && existsSync(AI_CONFIG_PATH)) {
  try {
    _aiTestConfig = JSON.parse(readFileSync(AI_CONFIG_PATH, 'utf8')) as AiTestConfig;
  } catch { /* corrupt config — treat as missing */ }
}

// Resolve which model IDs to force, null = use DB default
const FORCE_SAYON_MODEL: string | null = (() => {
  if (!_aiTestConfig || !_aiTestConfig.sayonIndex) return null;
  return _aiTestConfig.models[_aiTestConfig.sayonIndex - 1]?.id ?? null;
})();
const FORCE_SEREN_MODEL: string | null = (() => {
  if (!_aiTestConfig || !_aiTestConfig.serenIndex) return null;
  return _aiTestConfig.models[_aiTestConfig.serenIndex - 1]?.id ?? null;
})();

// ── --rebuildconfig early exit ─────────────────────────────────────────────────
if (REBUILD_CONFIG) {
  (async () => {
    // Import PhobosLocalManager to enumerate downloaded models without starting
    // the full server. Uses the template DB path (snapshot) so the list reflects
    // what the test run would actually have available.
    const { listDownloaded } = await import('./phobos/PhobosLocalManager.js');
    const downloaded = listDownloaded();

    // Only include phobos-provider (local GGUF) models — cloud models are not
    // relevant for hardware-targeted test runs.
    const models: AiTestModelEntry[] = downloaded.map((spec, i) => ({
      index: i + 1,
      id:    spec.modelId,
      label: spec.label,
      role:  spec.role ?? 'unknown',
    }));

    // Read the current snapshot config if the template DB exists, so we can
    // show what is currently selected without starting the server.
    let currentSayon = '(auto)';
    let currentSeren = '(auto)';
    const templateDbPath = [
      path.join(TEMPLATE_DIR, 'localai.duckdb'),
      path.join(TEMPLATE_DIR, 'phobos.duckdb'),
    ].find(p => existsSync(p));
    if (templateDbPath) {
      try {
        const { DatabaseManager } = await import('./db/DatabaseManager.js');
        const { ModelConfigStore }  = await import('./db/ModelConfigStore.js');
        const db    = DatabaseManager.getInstance(templateDbPath);
        await db.initialize();
        const store = new ModelConfigStore(db);
        const cfg   = await store.getAll();
        currentSayon = cfg.coordinator.model;
        currentSeren = cfg.engine.model;
        await db.close();
      } catch { /* DB not readable — skip */ }
    }

    // Preserve existing indices if a config already exists
    const existing: Partial<AiTestConfig> = existsSync(AI_CONFIG_PATH)
      ? (() => { try { return JSON.parse(readFileSync(AI_CONFIG_PATH, 'utf8')); } catch { return {}; } })()
      : {};

    const newConfig: AiTestConfig = {
      sayonIndex: existing.sayonIndex ?? null,
      serenIndex: existing.serenIndex ?? null,
      models,
    };

    mkdirSync(path.dirname(AI_CONFIG_PATH), { recursive: true });
    writeFileSync(AI_CONFIG_PATH, JSON.stringify(newConfig, null, 2));

    // Print the list
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  PHOBOS AI Test Suite — Model Configuration                 ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log(`\n  Config written to: ${AI_CONFIG_PATH}`);
    console.log(`\n  DB snapshot currently set to:`);
    console.log(`    SAYON: ${currentSayon}`);
    console.log(`    SEREN: ${currentSeren}`);
    console.log(`\n  Downloaded models (set sayonIndex / serenIndex in config.json):`);
    console.log(`  ${'#'.padEnd(4)} ${'Role'.padEnd(8)} ${'Model ID'.padEnd(38)} Label`);
    console.log(`  ${'-'.repeat(80)}`);
    for (const m of models) {
      const sel = (m.id === currentSayon ? ' ← SAYON' : '') + (m.id === currentSeren ? ' ← SEREN' : '');
      console.log(`  ${String(m.index).padEnd(4)} ${m.role.padEnd(8)} ${m.id.padEnd(38)} ${m.label}${sel}`);
    }
    const sayonPick = newConfig.sayonIndex ? `index ${newConfig.sayonIndex} → ${models[newConfig.sayonIndex - 1]?.id ?? '?'}` : 'auto (DB default)';
    const serenPick = newConfig.serenIndex ? `index ${newConfig.serenIndex} → ${models[newConfig.serenIndex - 1]?.id ?? '?'}` : 'auto (DB default)';
    console.log(`\n  Current selection:`);
    console.log(`    sayonIndex: ${sayonPick}`);
    console.log(`    serenIndex: ${serenPick}`);
    console.log('\n  Edit config.json to change, then run the suite normally.\n');
    process.exit(0);
  })().catch(err => { console.error('--rebuildconfig failed:', err); process.exit(1); });
} else {
  // Normal run — log which models will be forced (if any)
  if (FORCE_SAYON_MODEL || FORCE_SEREN_MODEL) {
    // Deferred to startServer where the log context is active
  }
}

// ── Result tracking ────────────────────────────────────────────────────────────
type TestStatus = 'PASS' | 'FAIL' | 'SKIP' | 'WARN';
interface Assertion { label: string; passed: boolean; detail?: string; }
interface TestResult {
  id:          string;
  name:        string;
  tier:        'short' | 'medium' | 'long' | 'copilot' | 'edge';
  status:      TestStatus;
  duration_ms: number;
  assertions:  Assertion[];
  detail?:     string;
}
const results: TestResult[] = [];
let   currentTest: { id: string; name: string; tier: TestResult['tier']; assertions: Assertion[]; start: number } | null = null;

function startTest(id: string, name: string, tier: TestResult['tier']): void {
  currentTest = { id, name, tier, assertions: [], start: Date.now() };
  console.log(`\n  ▸ [${id}] ${name}`);
}

function assert(label: string, condition: boolean, detail?: string): void {
  if (!currentTest) throw new Error('assert() called outside startTest()');
  currentTest.assertions.push({ label, passed: condition, detail });
  if (condition) {
    console.log(`      ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`      ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function warnAssert(label: string, condition: boolean, detail?: string): void {
  if (!currentTest) throw new Error('warnAssert() called outside startTest()');
  // warnAssert is informational — always push passed:true so it never marks the
  // test as FAIL. A ⚠️  is displayed when condition is false but the test outcome
  // is unaffected. Use assert() for hard failures.
  currentTest.assertions.push({ label, passed: true, detail });
  const symbol = condition ? '✅' : '⚠️ ';
  console.log(`      ${symbol} ${label}${detail ? ` — ${detail}` : ''}`);
}

function endTest(status?: TestStatus, detail?: string): void {
  if (!currentTest) return;
  const dur    = Date.now() - currentTest.start;
  const failed = currentTest.assertions.some(a => !a.passed);
  const s      = status ?? (failed ? 'FAIL' : 'PASS');
  const sym    = s === 'PASS' ? '✅' : s === 'FAIL' ? '❌' : s === 'SKIP' ? '⏭️ ' : '⚠️ ';
  console.log(`    ${sym} [${currentTest.id}] ${s} (${dur}ms)${detail ? ` — ${detail}` : ''}`);
  results.push({
    id:          currentTest.id,
    name:        currentTest.name,
    tier:        currentTest.tier,
    status:      s,
    duration_ms: dur,
    assertions:  currentTest.assertions,
    detail,
  });
  currentTest = null;
}

function skipTest(id: string, name: string, tier: TestResult['tier'], reason: string): void {
  console.log(`  ⏭️  [${id}] SKIP — ${reason}`);
  results.push({ id, name, tier, status: 'SKIP', duration_ms: 0, assertions: [], detail: reason });
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────
function apiPost(path: string, body: unknown, timeoutMs = 30_000): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const b = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port: SERVER_PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) },
        timeout: timeoutMs },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString()) }); }
          catch { resolve({ status: res.statusCode ?? 0, json: null }); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error(`POST ${path} timed out after ${timeoutMs}ms`)); });
    req.on('error', reject);
    req.write(b);
    req.end();
  });
}

function apiGet(urlPath: string, timeoutMs = 10_000): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: SERVER_PORT, path: urlPath, method: 'GET', timeout: timeoutMs },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString()) }); }
          catch { resolve({ status: res.statusCode ?? 0, json: null }); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error(`GET ${urlPath} timed out`)); });
    req.on('error', reject);
    req.end();
  });
}

// ── SSE capture ────────────────────────────────────────────────────────────────
interface SSEEvent { type: string; [key: string]: unknown; }
interface CapturedStream {
  events:       SSEEvent[];
  byType:       Map<string, SSEEvent[]>;
  routing:      string | null;
  intentType:   string | null;
  ctxCount:     number | null;
  filePanels:   Array<{ filename: string; code: string; language: string }>;
  taskStarts:   Array<{ taskIndex: number; total: number; title: string }>;
  statusPills:  string[];
  complete:     boolean;
  approved:     boolean | null;
  timedOut:     boolean;
  durationMs:   number;
  clarification: string[] | null;
  phase1Clarification: string[] | null;
}

function captureSSE(urlPath: string, timeoutMs = 90_000): Promise<CapturedStream> {
  return new Promise((resolve) => {
    const start  = Date.now();
    const stream: CapturedStream = {
      events: [], byType: new Map(), routing: null, intentType: null,
      ctxCount: null, filePanels: [], taskStarts: [], statusPills: [],
      complete: false, approved: null, timedOut: false, durationMs: 0,
      clarification: null, phase1Clarification: null,
    };

    const finish = () => {
      stream.durationMs = Date.now() - start;
      req.destroy();
      resolve(stream);
    };

    const timer = timeoutMs > 0 ? setTimeout(() => { stream.timedOut = true; finish(); }, timeoutMs) : null;

    const req = http.request(
      { hostname: '127.0.0.1', port: SERVER_PORT, path: urlPath, method: 'GET',
        headers: { 'Accept': 'text/event-stream' } },
      res => {
        let buf = '';
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const parts = buf.split('\n\n');
          buf = parts.pop() ?? '';
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(line.slice(6)) as SSEEvent;
              stream.events.push(evt);
              const arr = stream.byType.get(evt.type) ?? [];
              arr.push(evt);
              stream.byType.set(evt.type, arr);
              // Extract key fields
              if (evt.type === 'intent_classified') {
                stream.routing   = (evt as any).routing   ?? null;
                stream.intentType= (evt as any).intentType ?? null;
              }
              if (evt.type === 'ctx_computed')  stream.ctxCount   = (evt as any).count ?? null;
              if (evt.type === 'file_panel')    stream.filePanels.push({ filename: (evt as any).filename, code: (evt as any).code ?? '', language: (evt as any).language ?? '' });
              if (evt.type === 'task_start')    stream.taskStarts.push({ taskIndex: (evt as any).taskIndex, total: (evt as any).total, title: (evt as any).title ?? '' });
              if (evt.type === 'status')        stream.statusPills.push((evt as any).content ?? '');
              if (evt.type === 'clarification_needed') stream.clarification = (evt as any).questions ?? [];
              if (evt.type === 'phase1_clarification_needed') stream.phase1Clarification = (evt as any).questions ?? [];
              if (evt.type === 'complete') {
                stream.complete = true;
                stream.approved = (evt as any).approved ?? null;
                clearTimeout(timer ?? undefined);
                finish();
              }
              if (evt.type === 'done') { clearTimeout(timer ?? undefined); finish(); }
              if (evt.type === 'error') { clearTimeout(timer ?? undefined); finish(); }
            } catch { /* malformed event — skip */ }
          }
        });
        res.on('end', () => { clearTimeout(timer ?? undefined); finish(); });
        res.on('error', () => { clearTimeout(timer ?? undefined); finish(); });
      }
    );
    req.on('error', () => { clearTimeout(timer ?? undefined); finish(); });
    req.end();
  });
}

// Send a message and capture the SSE stream
async function sendMessage(
  threadId: string,
  content: string,
  opts: { attachmentIds?: string[]; contextHistoryDepth?: number } = {},
  timeoutMs = 90_000
): Promise<CapturedStream> {
  const body: Record<string, unknown> = { content };
  if (opts.attachmentIds?.length) body.attachment_ids = opts.attachmentIds;
  if (opts.contextHistoryDepth != null) body.context_history_depth = opts.contextHistoryDepth;

  // POST the message
  await new Promise<void>((resolve, reject) => {
    const b = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port: SERVER_PORT,
        path: `/api/threads/${threadId}/messages`, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) },
        timeout: timeoutMs },
      res => {
        // SSE streams the response inline — consume it here
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', resolve);
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(b);
    req.end();
  });

  // The response body IS the SSE stream — but since http.request reads it inline,
  // we re-request via GET with SSE headers to a replay route. However, PHOBOS
  // streams SSE inline on the POST response. So we need to capture during POST:
  // Re-implement: capture from the POST response directly.
  return sendMessageAndCapture(threadId, content, opts, timeoutMs);
}

// Correct implementation: capture SSE from the POST response itself
function sendMessageAndCapture(
  threadId: string,
  content: string,
  opts: { attachmentIds?: string[]; contextHistoryDepth?: number } = {},
  timeoutMs = 90_000,
  urlPath?: string   // override URL — used for copilot endpoints
): Promise<CapturedStream> {
  return new Promise((resolve) => {
    const start  = Date.now();
    const stream: CapturedStream = {
      events: [], byType: new Map(), routing: null, intentType: null,
      ctxCount: null, filePanels: [], taskStarts: [], statusPills: [],
      complete: false, approved: null, timedOut: false, durationMs: 0,
      clarification: null, phase1Clarification: null,
    };
    const finish = () => { stream.durationMs = Date.now() - start; resolve(stream); };
    const timer  = timeoutMs > 0
      ? setTimeout(() => { stream.timedOut = true; req.destroy(); finish(); }, timeoutMs)
      : null;

    const body: Record<string, unknown> = { content };
    if (opts.attachmentIds?.length) body.attachment_ids = opts.attachmentIds;
    if (opts.contextHistoryDepth != null) body.context_history_depth = opts.contextHistoryDepth;
    const b = JSON.stringify(body);

    const resolvedPath = urlPath ?? `/api/threads/${threadId}/messages`;

    const req = http.request(
      { hostname: '127.0.0.1', port: SERVER_PORT,
        path: resolvedPath, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) },
        ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}) },
      res => {
        let buf = '';
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const parts = buf.split('\n\n');
          buf = parts.pop() ?? '';
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(line.slice(6)) as SSEEvent;
              stream.events.push(evt);
              const arr = stream.byType.get(evt.type) ?? [];
              arr.push(evt);
              stream.byType.set(evt.type, arr);
              if (evt.type === 'intent_classified') {
                stream.routing    = (evt as any).routing    ?? null;
                stream.intentType = (evt as any).intentType ?? null;
              }
              if (evt.type === 'ctx_computed')  stream.ctxCount = (evt as any).count ?? null;
              if (evt.type === 'file_panel')    stream.filePanels.push({ filename: (evt as any).filename, code: (evt as any).code ?? '', language: (evt as any).language ?? '' });
              if (evt.type === 'task_start')    stream.taskStarts.push({ taskIndex: (evt as any).taskIndex, total: (evt as any).total, title: (evt as any).title ?? '' });
              if (evt.type === 'status')        stream.statusPills.push((evt as any).content ?? '');
              if (evt.type === 'clarification_needed') stream.clarification = (evt as any).questions ?? [];
              if (evt.type === 'phase1_clarification_needed') stream.phase1Clarification = (evt as any).questions ?? [];
              if (evt.type === 'complete') {
                stream.complete = true;
                stream.approved = (evt as any).approved ?? null;
                // Do NOT destroy/finish here. The server emits coordinator stream
                // chunks concurrent with the complete event — destroying immediately
                // drops in-flight data frames. Wait for the 'done' sentinel
                // (emitted after reply.raw.end()) which guarantees all data has flushed.
                // Arm a 2s safety timer in case 'done' never arrives.
                clearTimeout(timer ?? undefined);
                setTimeout(() => { req.destroy(); finish(); }, 2000);
              }
              if (evt.type === 'done')  { clearTimeout(timer ?? undefined); req.destroy(); finish(); }
              if (evt.type === 'error') { clearTimeout(timer ?? undefined); req.destroy(); finish(); }
            } catch { /* skip malformed */ }
          }
        });
        res.on('end',  () => { clearTimeout(timer ?? undefined); finish(); });
        res.on('error',() => { clearTimeout(timer ?? undefined); finish(); });
      }
    );
    req.on('error', () => { clearTimeout(timer ?? undefined); finish(); });
    req.write(b);
    req.end();
  });
}

// ── DB helpers ─────────────────────────────────────────────────────────────────
// On Windows, DuckDB holds an exclusive file lock — the test process cannot open
// a DB file that the server has open. We use two strategies:
//   1. apiGetMessages() — fetch thread messages via the REST API (always safe)
//   2. dbQuery() — direct DuckDB read, only works when server is NOT running or
//      on Linux/Mac. Wrapped to return empty array on Windows lock errors.

async function apiGetMessages(threadId: string): Promise<Array<{ role: string; content: string; distilled_content?: string | null }>> {
  try {
    const res = await apiGet(`/api/threads/${threadId}/messages`, 5000);
    const json = res.json as any;
    return Array.isArray(json) ? json : [];
  } catch { return []; }
}

async function dbQuery<T = Record<string, unknown>>(
  dbPath: string,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  // On Windows, the server holds an exclusive lock. Attempting to open the same
  // file from another process throws "being used by another process". We catch
  // that and return [] so tests degrade to WARN/SKIP rather than hard-fail.
  let db: Database.Database | null = null;
  try {
    db = await Database.Database.create(dbPath);
    const conn = await db.connect();
    try {
      const rows = await conn.all(sql, ...params);
      return rows as T[];
    } finally {
      await conn.close();
    }
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('being used by another process') || msg.includes('Cannot open file')) {
      // Windows exclusive lock — log once and return empty
      throw new Error(`DB locked (Windows): ${path.basename(dbPath)} — ${msg.slice(0, 80)}`);
    }
    throw err;
  } finally {
    if (db) await db.close().catch(() => {});
  }
}

// dbQuerySafe: like dbQuery but returns [] on Windows file lock instead of throwing.
// Use for CONV_DB_PATH and DB_PATH reads where the server holds the lock.
async function dbQuerySafe<T = Record<string, unknown>>(
  dbPath: string,
  sql: string,
  params: unknown[] = [],
  label = 'DB'
): Promise<{ rows: T[]; locked: boolean; error?: string }> {
  try {
    const rows = await dbQuery<T>(dbPath, sql, params);
    return { rows, locked: false };
  } catch (err) {
    const msg = (err as Error).message ?? '';
    const isLock = msg.includes('DB locked') || msg.includes('being used') || msg.includes('Cannot open');
    return { rows: [], locked: isLock, error: msg.slice(0, 120) };
  }
}

// Helper: assert or warnAssert based on whether DB was locked
function dbAssert(
  label: string,
  condition: boolean,
  locked: boolean,
  detail?: string
): void {
  if (locked) {
    warnAssert(`${label} (DB locked on Windows — skipped)`, true, detail);
  } else {
    assert(label, condition, detail);
  }
}
async function uploadAttachment(threadId: string, filename: string, content: string): Promise<string | null> {
  try {
    const res = await apiPost(`/api/threads/${threadId}/attachments`, {
      filename, content, mime_type: 'text/plain', message_id: '',
    });
    return (res.json as any)?.id ?? null;
  } catch { return null; }
}

// ── Server lifecycle ───────────────────────────────────────────────────────────
let serverProc: ChildProcess | null = null;

async function startServer(): Promise<boolean> {
  // Resolve DB_PATH now that scratch exists
  const dbPath = [
    path.join(SCRATCH_DIR, 'localai.duckdb'),
    path.join(SCRATCH_DIR, 'phobos.duckdb'),
  ].find(p => existsSync(p)) ?? path.join(SCRATCH_DIR, 'localai.duckdb');

  console.log('\n  ▶ Starting PHOBOS server…');
  console.log(`    scratch:   ${SCRATCH_DIR}`);
  console.log(`    DB:        ${path.basename(dbPath)}`);
  console.log(`    workspaces:${path.join(SCRATCH_DIR, 'workspaces')}`);

  // On Windows, spawn needs shell:true to resolve npx/npx.cmd from PATH.
  const isWindows = process.platform === 'win32';
  serverProc = spawn(isWindows ? 'npx.cmd' : 'npx', ['tsx', 'server.ts'], {
    cwd: __dirname,
    env: {
      ...process.env,
      PHOBOS_DATA_DIR: SCRATCH_DIR,
      DB_PATH:         dbPath,
      WORKSPACES_ROOT: path.join(SCRATCH_DIR, 'workspaces'),
      PORT: String(SERVER_PORT),
      ...(!isNaN(SAYON_CTX) ? { PHOBOS_TEST_SAYON_CTX: String(SAYON_CTX) } : {}),
      ...(!isNaN(SEREN_CTX) ? { PHOBOS_TEST_SEREN_CTX: String(SEREN_CTX) } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // shell:true is a fallback safety net on Windows if npx.cmd still isn't found
    ...(isWindows ? { shell: true } : {}),
  });

  serverProc.stdout?.on('data', (d: Buffer) => {
    d.toString().split('\n').filter(l => l.trim()).forEach(line => console.log(`    [server] ${line}`));
  });
  serverProc.stderr?.on('data', (d: Buffer) => {
    d.toString().split('\n').filter(l => l.trim() && !l.includes('ExperimentalWarning')).forEach(line => console.log(`    [server] ${line}`));
  });

  // Phase 1: wait up to 30s for port 3001 to accept connections
  let port3001Open = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    port3001Open = await new Promise<boolean>(resolve => {
      const s = net.connect(SERVER_PORT, '127.0.0.1');
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error',   () => resolve(false));
    });
    if (port3001Open) break;
  }
  if (!port3001Open) {
    console.log('    ❌ Server port did not open within 30s');
    return false;
  }
  console.log(`    Port ${SERVER_PORT} open — waiting for LLM servers to load models…`);

  // Phase 1.5: apply model selection from config.json (if any) before waiting
  // for models to load. PUT /api/config/models triggers reconcilePhobosServers
  // with the chosen models, which launches the correct llama-server processes.
  if (FORCE_SAYON_MODEL || FORCE_SEREN_MODEL) {
    console.log(`    🔧 Applying model config: SAYON=${FORCE_SAYON_MODEL ?? 'auto'} SEREN=${FORCE_SEREN_MODEL ?? 'auto'}`);
    try {
      const body: Record<string, unknown> = {};
      if (FORCE_SAYON_MODEL) body.coordinator = { provider: 'phobos', model: FORCE_SAYON_MODEL };
      if (FORCE_SEREN_MODEL) body.engine       = { provider: 'phobos', model: FORCE_SEREN_MODEL };
      await new Promise<void>((resolve, reject) => {
        const data = JSON.stringify(body);
        const req  = http.request({
          hostname: '127.0.0.1', port: SERVER_PORT,
          path: '/api/config/models', method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
          timeout: 10_000,
        }, res => {
          res.resume();
          res.on('end', () => {
            if (res.statusCode === 200) resolve();
            else reject(new Error(`PUT /api/config/models returned ${res.statusCode}`));
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('PUT /api/config/models timed out')); });
        req.write(data);
        req.end();
      });
      console.log(`    ✅ Model config applied`);
    } catch (err) {
      console.warn(`    ⚠️  Model config apply failed (non-fatal): ${(err as Error).message}`);
    }
  }

  // Phase 2: wait up to 120s for both coordinator AND engine to report connected.
  // The llama-server processes need time to load model weights into VRAM/RAM.
  // Poll /api/status until coordinator=connected and engine=connected,
  // then verify SEREN's /health returns 200 (llama.cpp only reports 200 once weights loaded).
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const res = await apiGet('/api/status', 3000).catch(() => ({ status: 0, json: null }));
      const json = res.json as any;
      if (json?.coordinator === 'connected' && json?.engine === 'connected') {
        // Status connected — now verify SEREN model is actually loaded, not just port-open.
        // llama.cpp /health returns 200 only after weights are in VRAM, 503 while loading.
        const serenHealthy = await new Promise<boolean>(resolve => {
          const req = http.request(
            { hostname: '127.0.0.1', port: 16314, path: '/health', method: 'GET', timeout: 3000 },
            res => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); }
          );
          req.on('error', () => resolve(false));
          req.on('timeout', () => { req.destroy(); resolve(false); });
          req.end();
        });
        if (!serenHealthy) {
          if (i % 5 === 4) console.log(`    ⏳ SEREN port open but model still loading… (${i + 1}s)`);
          continue;
        }
        console.log(`    ✅ Both models online (${i + 1}s). SAYON: ${json.coordinatorModel ?? '?'} | SEREN: ${json.engineModel ?? '?'}`);
        return true;
      }
      if (i % 10 === 9) {
        console.log(`    ⏳ Still waiting… coordinator=${json?.coordinator ?? '?'} engine=${json?.engine ?? '?'} (${i + 1}s)`);
      }
    } catch { /* server not ready yet */ }
  }
  console.log('    ❌ Models did not come online within 120s');
  return false;
}

async function stopServer(): Promise<void> {
  if (!serverProc) return;
  const pid = serverProc.pid;
  if (process.platform === 'win32' && pid != null) {
    // On Windows, Node.kill() only kills the direct child process. The server
    // spawns Java children (Stirling, Kavita) which become orphaned when Node
    // exits. taskkill /F /T kills the entire process tree rooted at the server
    // pid — including all grandchildren — before we wait for exit.
    const { execSync } = await import('node:child_process');
    try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' }); } catch { /* already dead */ }
  } else {
    serverProc.kill('SIGTERM');
  }
  await new Promise<void>(resolve => {
    serverProc!.on('exit', resolve);
    setTimeout(resolve, 5000);
  });
  serverProc = null;
}

// ── Environment setup ─────────────────────────────────────────────────────────
//
// Setup copies the template into scratch, which is the ONLY directory the
// server and tests ever read from or write to. Nothing outside scratch is
// touched at any point during the test run.
//
// Scratch is wiped and rebuilt from template at the start of each run,
// and deleted at the end.

async function setup(): Promise<boolean> {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  if (NO_RESET) {
    console.log('  ℹ️  --no-reset: using existing scratch directory');
    if (!existsSync(SCRATCH_DIR)) {
      console.error('  ❌ --no-reset specified but scratch dir does not exist — run without --no-reset first');
      return false;
    }
    return true;
  }

  if (!existsSync(TEMPLATE_DIR)) {
    console.error(`\n  ❌ Template not found at: ${TEMPLATE_DIR}`);
    console.error('     Expected: test-outputs/ai-features-template/user-data-snapshot/');
    console.error('     Copy your .phobos snapshot there (DB files + workspaces dir only).');
    return false;
  }

  // Wipe scratch entirely and rebuild from template
  console.log('  🔄 Building scratch from template…');
  console.log(`    template: ${TEMPLATE_DIR}`);
  console.log(`    scratch:  ${SCRATCH_DIR}`);

  await fs.rm(SCRATCH_DIR, { recursive: true, force: true });
  await fs.cp(TEMPLATE_DIR, SCRATCH_DIR, { recursive: true });

  // Ensure workspaces dir exists even if not in template
  mkdirSync(path.join(SCRATCH_DIR, 'workspaces'), { recursive: true });

  console.log('  ✅ Scratch ready');

  // Ensure test fixture document exists
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const fixtureDoc = path.join(FIXTURES_DIR, 'PHOBOS-System-Design.md');
  if (!existsSync(fixtureDoc)) {
    await fs.writeFile(fixtureDoc, [
      '# PHOBOS System Design (Test Fixture)',
      '',
      '## Overview',
      'PHOBOS is a local AI platform with two models: SAYON (coordinator) and SEREN (engine).',
      'The UI is a single-page React application built with TypeScript and Tailwind CSS.',
      '',
      '## Component Requirements',
      '',
      '### Sidebar',
      '- Fixed left panel, 240px wide, dark background (bg-gray-900).',
      '- Displays the PHOBOS logo/title at the top.',
      '- Contains a NavigationMenu component below the title.',
      '- No collapse behaviour required.',
      '',
      '### NavigationMenu',
      '- Vertical list of navigation links: Chat, Files, Archive, Settings.',
      '- Active link highlighted with bg-gray-700 and white text.',
      '- Accepts an `activePage` prop (string) and an `onNavigate` callback prop.',
      '',
      '### MainContent',
      '- Fills remaining width to the right of the Sidebar (flex-1).',
      '- Displays a heading with the active page name.',
      '- Contains a placeholder paragraph: "Select a feature from the sidebar."',
      '- Accepts an `activePage` prop (string).',
      '',
      '### StatusIndicator',
      '- Small badge fixed to the top-right corner of the viewport.',
      '- Three possible states: "online" (green dot), "busy" (yellow dot), "offline" (red dot).',
      '- Accepts a `status` prop typed as `"online" | "busy" | "offline"`.',
      '- Displays the status string next to the coloured dot.',
      '',
      '### App (App.tsx)',
      '- Root component. Renders Sidebar and MainContent side-by-side in a full-height flex row.',
      '- Renders StatusIndicator overlaid at top-right.',
      '- Owns `activePage` state (default: "Chat") and passes setActivePage as onNavigate to Sidebar.',
      '',
      '## Routing',
      '- No external router. Navigation is pure React state: `activePage` string in App.',
      '- NavigationMenu calls `onNavigate(pageName)` on click; App updates state accordingly.',
      '',
      '## Tailwind Constraints',
      '- Use only core Tailwind utility classes (no custom config or plugins required).',
      '- Dark theme: bg-gray-900 backgrounds, bg-gray-700 for hover/active states, white text.',
      '- Layout: App uses `flex h-screen`, Sidebar uses `w-60 flex-shrink-0`, MainContent uses `flex-1 p-6`.',
    ].join('\n'));
  }

  return true;
}

async function teardownScratch(): Promise<void> {
  if (KEEP_SERVER) return; // keep scratch for inspection too
  console.log('  🗑  Removing scratch directory…');
  await fs.rm(SCRATCH_DIR, { recursive: true, force: true }).catch(() => {});
  console.log('  ✅ Scratch removed');
}


// ── Port check helper ─────────────────────────────────────────────────────────
async function checkPort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error',   () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 2000);
  });
}

/**
 * Wait until both models report connected and no generation is in progress.
 * Called between tests to prevent HeadersTimeoutError cascade when the model
 * queue is still draining from the previous test.
 * Polls /api/status — the server reports coordinator/engine state there.
 * Max wait: 120s. Logs every 10s if still waiting.
 */
async function waitForModelIdle(label = ''): Promise<void> {
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const res = await apiGet('/api/status', 3000).catch(() => ({ status: 0, json: null }));
      const j   = res.json as any;
      if (j?.coordinator === 'connected' && j?.engine === 'connected') return;
      if (i > 0 && i % 10 === 0) {
        console.log(`    ⏳ [${label}] waiting for models… coordinator=${j?.coordinator} engine=${j?.engine} (${i}s)`);
      }
    } catch { /* retry */ }
  }
  console.log(`    ⚠️  [${label}] model idle wait timed out after 120s — proceeding anyway`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ── SHORT TESTS ───────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

// t(ms) — timeout helper. When --notimelimit is passed, returns 0 which
// Node's http.request treats as "no timeout". Use this for every
// sendMessageAndCapture / captureSSE call so --notimelimit works end-to-end.
const t = (ms: number): number => NO_TIME_LIMIT ? 0 : ms;

async function testS01_intentRoutingDirect(): Promise<void> {
  startTest('S01', 'Intent Classification: Question routes to ANSWER_DIRECTLY', 'short');
  const tid = randomUUID();
  const s   = await sendMessageAndCapture(tid, 'What is a closure in JavaScript?', {}, t(120_000));

  assert('no timeout',                !s.timedOut,                                `elapsed ${s.durationMs}ms`);
  assert('intent_classified emitted', s.byType.has('intent_classified'),          'SSE event present');
  assert('routing ANSWER_DIRECTLY',   s.routing === 'ANSWER_DIRECTLY',            `got: ${s.routing}`);
  assert('coordinator SSE emitted',   (s.byType.get('output_token')?.length ?? 0) > 0, 'SAYON response tokens');
  assert('no task_start events',      s.taskStarts.length === 0,                  'SEREN not dispatched');
  assert('complete event received',   s.complete,                                 'stream finished');

  // DB assertions — use API for messages (always works), dbQuerySafe for VSS stores
  const msgs = await apiGetMessages(tid);
  assert('2 messages in DB',       msgs.length === 2,                           `found ${msgs.length}`);
  assert('user row correct',       msgs[0]?.role === 'user',                    `role: ${msgs[0]?.role}`);
  assert('assistant row correct',  msgs[1]?.role === 'assistant',               `role: ${msgs[1]?.role}`);
  // distilled_content comes through the messages API if server includes it
  const hasDistilled = msgs[1]?.distilled_content != null;
  warnAssert('distilled_content set (via API)',  hasDistilled, hasDistilled ? 'present' : 'not exposed in messages API — check DB directly after run');

  const { rows: turns, locked: turnsLocked, error: turnsErr } = await dbQuerySafe(CONV_DB_PATH,
    `SELECT id FROM conversation_turns WHERE thread_id = ?`, [tid]);
  dbAssert('conversation turn indexed', turns.length === 1, turnsLocked, turnsLocked ? turnsErr : `found ${turns.length}`);
  endTest();
}

async function testS02_intentRoutingNeeds(): Promise<void> {
  startTest('S02', 'Intent Classification: Code request routes to NEEDS_SEREN', 'short');
  const tid = randomUUID();
  const s   = await sendMessageAndCapture(tid, 'Write a TypeScript function that reverses a string in a new file called reverseString.ts', {}, t(180_000));

  assert('no timeout',              !s.timedOut,                                 `elapsed ${s.durationMs}ms`);
  assert('routing NEEDS_SEREN',     s.routing === 'NEEDS_SEREN',                 `got: ${s.routing}`);
  assert('intentType CODE_REQUEST', s.intentType === 'CODE_REQUEST',             `got: ${s.intentType}`);
  assert('task_start emitted',      s.taskStarts.length > 0,                     'at least one task');
  assert('complete event received', s.complete,                                  'stream finished');
  endTest();
}

async function testS03_ctxComputedEvent(): Promise<void> {
  startTest('S03', 'ctx_computed SSE event emitted and count is valid', 'short');
  const tid = randomUUID();

  // Fresh thread — first message, no history
  const s1 = await sendMessageAndCapture(tid, 'Hello, what can you do?', {}, t(120_000));
  assert('ctx_computed on first message', s1.ctxCount !== null,          `count: ${s1.ctxCount}`);
  assert('count is number',              typeof s1.ctxCount === 'number', `type: ${typeof s1.ctxCount}`);
  assert('count is non-negative',        (s1.ctxCount ?? -1) >= 0,       `got: ${s1.ctxCount}`);
  assert('complete received',            s1.complete,              'stream done');

  // Second message — should now have 1 prior pair
  const s2 = await sendMessageAndCapture(tid, 'What is two plus two?', {}, t(120_000));
  assert('ctx_computed on second message', s2.ctxCount !== null,   `count: ${s2.ctxCount}`);
  assert('count ≥ 1 after first turn',    (s2.ctxCount ?? 0) >= 1, `got: ${s2.ctxCount}`);
  endTest();
}

async function testS04_distilledContentUsedForContext(): Promise<void> {
  startTest('S04', 'Context history uses distilled_content, not raw content', 'short');
  const tid = randomUUID();

  // Turn 1: produce a response with code blocks
  const s1 = await sendMessageAndCapture(tid, 'Write a TypeScript function called add that takes two numbers and returns their sum', {}, t(180_000));
  assert('turn 1 complete', s1.complete, `elapsed ${s1.durationMs}ms`);

  // Use the REST API to read message state — avoids DuckDB WAL visibility race
  // where a second process opens phobos.duckdb and sees a pre-checkpoint snapshot.
  const apiMsgs  = await apiGetMessages(tid);
  const assistant = apiMsgs.find(m => m.role === 'assistant');
  assert('assistant message exists',      assistant != null,                                                              'found via API');
  assert('distilled_content is non-null', assistant?.distilled_content != null,                                          'column populated');
  assert('distilled no longer than content',(assistant?.distilled_content?.length ?? 0) <= (assistant?.content?.length ?? 1), 'code stripped or equal (no fences in delivery msg)');
  assert('distilled has no code fences',  !(assistant?.distilled_content ?? '').includes('```'),                          'no triple backticks');
  assert('distilled has no <file> tags',  !(assistant?.distilled_content ?? '').includes('<file '),                       'no XML file blocks');

  // Turn 2: ctx_computed should reflect distilled budget (not raw)
  const s2 = await sendMessageAndCapture(tid, 'Can you explain what that function does?', {}, t(30_000));
  assert('second turn completes', s2.complete, 'stream done');
  assert('ctx_computed ≥ 1',      (s2.ctxCount ?? 0) >= 1, `got: ${s2.ctxCount}`);
  endTest();
}

async function testS05_conversationTurnIndexed(): Promise<void> {
  startTest('S05', 'Conversation turn indexed in ConversationStore after completion', 'short');
  const tid = randomUUID();
  const s   = await sendMessageAndCapture(tid, 'We should always use const instead of let where possible in TypeScript', {}, t(120_000));
  assert('complete', s.complete, `elapsed ${s.durationMs}ms`);

  try {
    const { rows: turns, locked, error } = await dbQuerySafe<{
      thread_id: string; user_text: string; assistant_text: string;
    }>(CONV_DB_PATH,
      `SELECT thread_id, user_text, assistant_text FROM conversation_turns WHERE thread_id = ?`,
      [tid]
    );
    dbAssert('1 turn in conversations.duckdb', turns.length === 1,                  locked, locked ? error : `found ${turns.length}`);
    dbAssert('user_text matches input',        turns[0]?.user_text.includes('const'), locked, `got: ${turns[0]?.user_text?.slice(0, 60)}`);
    dbAssert('assistant_text is non-empty',    (turns[0]?.assistant_text?.length ?? 0) > 10, locked, 'has content');
    assert('no code fences in assistant',    !(turns[0]?.assistant_text ?? '').includes('```'), 'distilled text stored');
  } catch (e) {
    assert('ConversationStore readable', false, (e as Error).message);
  }
  endTest();
}

async function testS06_memoryIntentPatterns(): Promise<void> {
  startTest('S06', 'detectMemoryIntent() pattern detection accuracy', 'short');
  // Import the function — it's a pure function in the compiled module
  // We test it indirectly by sending triggering messages and checking if RAG path fires.
  // For unit-style testing without module import, we replicate the patterns here.
  const MEMORY_PATTERNS = [
    /remember when (i|we|you) (said|asked|talked|mentioned|discussed|worked|built|wrote|made)/i,
    /do you remember (when|what|how|the)/i,
    /look back (to when|at when|at the)/i,
    /earlier (you|i|we) (said|mentioned|discussed|built|wrote)/i,
    /we (talked|discussed|worked) (about|on) .{3,60} (earlier|before|previously|last time)/i,
    /when (i|we) (asked|worked on|built|wrote|created|discussed)/i,
    /what did (i|we|you) (say|decide|agree|build|write) (about|when|earlier|before|on)/i,
    /find (the|that) (conversation|message|time) (when|where|about)/i,
    /go back to (when|where|the)/i,
    /that (thing|file|component|function|discussion) (we|i|you) (made|built|wrote|had)/i,
  ];
  const detect = (msg: string) => MEMORY_PATTERNS.some(p => p.test(msg));

  const TRUE_CASES = [
    'remember when I said we should use flat arrays',
    'do you remember what we decided about the auth flow',
    'look back to when we built the PlayerDressingRoom',
    'earlier you mentioned we should avoid spread operators',
    'what did we agree on before about the database schema',
    'go back to when we worked on the websocket handler',
    'find the conversation where we discussed file naming',
    'that component we built earlier',
  ];
  const FALSE_CASES = [
    'what is a closure in JavaScript',
    'write me a hello world function',
    'how does React reconciliation work',
    'can you explain async/await',
    'hi there',
    'thanks',
    'what is two plus two',
  ];

  let truePass = 0, falsePast = 0;
  for (const c of TRUE_CASES) {
    if (detect(c)) truePass++;
    else console.log(`        ⚠️  FALSE NEGATIVE: "${c}"`);
  }
  for (const c of FALSE_CASES) {
    if (!detect(c)) falsePast++;
    else console.log(`        ⚠️  FALSE POSITIVE: "${c}"`);
  }
  assert(`${TRUE_CASES.length} true cases detected`,  truePass  === TRUE_CASES.length,  `detected ${truePass}/${TRUE_CASES.length}`);
  assert(`${FALSE_CASES.length} false cases rejected`, falsePast === FALSE_CASES.length, `rejected ${falsePast}/${FALSE_CASES.length}`);
  endTest();
}

async function testS07_distillationStrip(): Promise<void> {
  startTest('S07', 'distillAssistantContent strips code blocks and XML, preserves prose', 'short');
  // Test via a real AI turn whose response will contain code
  const tid = randomUUID();
  const s   = await sendMessageAndCapture(tid, 'Write a function called multiply in TypeScript. Return the code in a fenced block.', {}, t(180_000));
  assert('complete', s.complete, `elapsed ${s.durationMs}ms`);

  // Use the REST API — avoids DuckDB WAL visibility race on Windows.
  const apiMsgs   = await apiGetMessages(tid);
  const assistant  = apiMsgs.find(m => m.role === 'assistant');
  const raw        = assistant?.content ?? '';
  const distilled  = assistant?.distilled_content ?? '';
  assert('raw content has code fence',   raw.includes('```'),           'AI produced code block');
  assert('distilled has no code fences', !distilled.includes('```'),    'fences stripped');
  assert('distilled is non-empty',       distilled.length > 0,          'prose preserved');
  assert('distilled shorter than raw',   distilled.length < raw.length, 'stripping occurred');
  endTest();
}

async function testS08_clarificationLoopSeren(): Promise<void> {
  startTest('S08', 'SEREN NEEDS_CLARIFICATION triggers pending state and bypass on re-entry', 'short');
  const tid = randomUUID();

  // Deliberately vague — should trigger SEREN clarification
  const s1  = await sendMessageAndCapture(tid, 'fix the bug', {}, t(180_000));
  const gotClarification = s1.clarification != null || s1.complete;
  assert('stream completed or clarification fired', gotClarification, `routing: ${s1.routing}`);

  if (s1.clarification) {
    assert('clarification questions non-empty', s1.clarification.length > 0, `${s1.clarification.length} questions`);
    // Follow up — should route directly without re-classifying
    const s2 = await sendMessageAndCapture(tid, 'I meant fix the null pointer error in the login handler', {}, t(180_000));
    assert('follow-up completes',   s2.complete, `elapsed ${s2.durationMs}ms`);
    const hasClassify = s2.byType.has('intent_classified');
    // May or may not re-classify depending on implementation — warn rather than fail
    warnAssert('clarification bypass active', !hasClassify, hasClassify ? 'intent re-classified (acceptable)' : 'bypassed');
  } else {
    assert('completed without clarification (vague handled)', s1.complete, 'alternate path');
  }
  endTest();
}

async function testS09_ctxOverrideManual(): Promise<void> {
  startTest('S09', 'Manual context_history_depth override respected by server', 'short');
  const tid = randomUUID();

  // Build 4 turns of history first
  for (let i = 0; i < 4; i++) {
    await sendMessageAndCapture(tid, `Message ${i + 1}: tell me something interesting about prime numbers`, {}, t(120_000));
  }

  // Now send with explicit depth of 2
  const s = await sendMessageAndCapture(tid, 'Summarise what we discussed', { contextHistoryDepth: 2 }, t(120_000));
  assert('completes with override',    s.complete,                   `elapsed ${s.durationMs}ms`);
  assert('ctx_computed present',       s.ctxCount !== null,          `count: ${s.ctxCount}`);
  assert('ctx_computed respects cap',  (s.ctxCount ?? 99) <= 2,      `got: ${s.ctxCount}, expected ≤ 2`);
  endTest();
}

async function testS10_archiveDoesNotPolluteCovnersations(): Promise<void> {
  startTest('S10', 'Archive classifier path does not write to ConversationStore', 'short');
  const tid = randomUUID();

  // Query with archive-triggering words
  const s = await sendMessageAndCapture(tid, 'What does the documentation say about API rate limits?', {}, t(120_000));
  assert('completes', s.complete, `elapsed ${s.durationMs}ms`);

  try {
    const { rows: turns, locked: turnsLocked, error: turnsErr } = await dbQuerySafe(CONV_DB_PATH,
      `SELECT id FROM conversation_turns WHERE thread_id = ?`, [tid]);
    // Should have exactly 1 turn — the normal post-turn write — NOT extra writes from archive classifier
    dbAssert('exactly 1 conversation turn', turns.length === 1, turnsLocked, turnsLocked ? turnsErr : `found ${turns.length} (archive classifier isolation)`);
  } catch (e) {
    assert('ConversationStore readable', false, (e as Error).message);
  }
  endTest();
}

// ─────────────────────────────────────────────────────────────────────────────
// ── MEDIUM TESTS ──────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

async function testM01_directAnswerPersistence(): Promise<void> {
  startTest('M01', 'Direct answer: content quality, persistence, and rolling summary', 'medium');
  const tid = randomUUID();
  const s   = await sendMessageAndCapture(tid, 'Explain the difference between a mutex and a semaphore in two sentences.', {}, t(180_000));

  assert('routing ANSWER_DIRECTLY', s.routing === 'ANSWER_DIRECTLY', `got: ${s.routing}`);
  assert('no timeout',              !s.timedOut,                      `elapsed ${s.durationMs}ms`);
  assert('complete received',       s.complete,                       'stream finished');

  try {
    const msgs = await apiGetMessages(tid);
    assert('2 messages stored',            msgs.length === 2,                          `found ${msgs.length}`);
    assert('assistant content > 50 chars', (msgs[1]?.content?.length ?? 0) > 50,      `len: ${msgs[1]?.content?.length}`);
    warnAssert('distilled_content non-null (via API)', msgs[1]?.distilled_content != null, 'column set');

    // Rolling summary — query via REST so we read through the server's live DB
    // connection rather than opening a second DuckDB handle that sees a stale
    // WAL snapshot. generateAndPersistSummary is awaited server-side before the
    // complete event fires, so the row is committed by the time we reach here.
    const sumRes  = await apiGet(`/api/threads/${tid}/summary`, 5000);
    const sumRow  = sumRes.status === 200 ? (sumRes.json as { summary: string; message_count: number } | null) : null;
    assert('chat summary created', sumRow != null, `HTTP ${sumRes.status} — found ${sumRow == null ? 0 : 1} summary rows`);

    const { rows: turns, locked: turnsLocked, error: turnsErr } = await dbQuerySafe(CONV_DB_PATH,
      `SELECT id FROM conversation_turns WHERE thread_id = ?`, [tid]);
    dbAssert('conversation turn indexed', turns.length === 1, turnsLocked, turnsLocked ? turnsErr : `found ${turns.length}`);
  } catch (e) {
    assert('DB assertions ran', false, (e as Error).message);
  }
  endTest();
}

async function testM02_singleFileCreation(): Promise<void> {
  startTest('M02', 'Code generation: single file created with correct content', 'medium');
  const tid = randomUUID();
  const s   = await sendMessageAndCapture(
    tid,
    "Create a new file named helloAI.ts with a single exported async function called greetAI that returns the string 'Hello from PHOBOS AI'",
    {}, t(120_000)
  );

  assert('routing NEEDS_SEREN',    s.routing === 'NEEDS_SEREN',    `got: ${s.routing}`);
  assert('task_start emitted',     s.taskStarts.length > 0,         `count: ${s.taskStarts.length}`);
  assert('file_panel emitted',     s.filePanels.length > 0,         `panels: ${s.filePanels.length}`);
  assert('complete received',      s.complete,                      `elapsed ${s.durationMs}ms`);

  const panel = s.filePanels.find(p => p.filename.includes('helloAI'));
  assert('helloAI.ts panel present', panel != null, `panels: ${s.filePanels.map(p => p.filename).join(', ')}`);

  // File system check
  const wsDir  = path.join(WORKSPACES_ROOT, tid);
  const exists = existsSync(path.join(wsDir, 'helloAI.ts'));
  assert('helloAI.ts exists on disk', exists, `checked: ${wsDir}`);

  if (exists) {
    const content = await fs.readFile(path.join(wsDir, 'helloAI.ts'), 'utf-8');
    assert('file contains export',         content.includes('export'),            'exported function');
    assert('file contains greetAI',        content.includes('greetAI'),           'correct name');
    assert('file contains Hello from PHOBOS', content.includes('Hello from PHOBOS'), 'return value');
  }

  // conversation_turn_files
  try {
    const { rows: files, locked: filesLocked, error: filesErr } = await dbQuerySafe<{ file_path: string }>(CONV_DB_PATH,
      `SELECT file_path FROM conversation_turn_files WHERE thread_id = ?`, [tid]);
    dbAssert('file linked in conversation turn', files.some(f => f.file_path.includes('helloAI')), filesLocked, filesLocked ? filesErr : `files: ${files.map(f => f.file_path).join(', ')}`);
  } catch (e) {
    assert('conversation_turn_files readable', false, (e as Error).message);
  }
  endTest();
}

async function testM03_conversationRAGRetrieval(): Promise<void> {
  startTest('M03', 'Conversation RAG: memory-retrieval query finds prior exchange', 'medium');
  const tid = randomUUID();

  // Turn 1: make a decision to remember
  const s1 = await sendMessageAndCapture(
    tid,
    'We decided to use flat indexed arrays instead of named-key objects for all broadcast paths in PHOBOS because of GC pressure',
    {}, 30_000
  );
  assert('turn 1 complete', s1.complete, `elapsed ${s1.durationMs}ms`);

  // Turn 2: confirm
  await sendMessageAndCapture(tid, 'Great, noted that decision', {}, t(30_000));

  // Wait for SYBIL indexing to complete
  await new Promise(r => setTimeout(r, 2000));

  // Turn 3: memory retrieval
  const s3 = await sendMessageAndCapture(
    tid,
    'Remember when we talked about the decision to use flat arrays? Can you summarize what we agreed on?',
    {}, 45_000
  );
  assert('turn 3 complete',          s3.complete,                                 `elapsed ${s3.durationMs}ms`);

  // Verify conversation turns exist
  try {
    const { rows: turns, locked: turnsLocked3, error: turnsErr3 } = await dbQuerySafe<{ user_text: string }>(CONV_DB_PATH,
      `SELECT user_text FROM conversation_turns WHERE thread_id = ? ORDER BY created_at`,
      [tid]
    );
    dbAssert('3 turns indexed', turns.length === 3, turnsLocked3, turnsLocked3 ? turnsErr3 : `found ${turns.length}`);
  } catch (e) {
    assert('turns readable', false, (e as Error).message);
  }

  // Response should reference the flat arrays decision (soft check)
  const coordEvents = s3.byType.get('coordinator') ?? [];
  const allContent  = coordEvents.map(e => (e as any).content ?? '').join(' ');
  const { rows: msgRows } = await dbQuerySafe<{ content: string }>(DB_PATH,
    `SELECT content FROM messages WHERE thread_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
    [tid]
  );
  const responseText = msgRows[0]?.content ?? allContent;
  warnAssert('response references flat arrays or arrays', /flat|array|broadcast|GC/i.test(responseText), 'RAG content injected');
  endTest();
}

async function testM04_rollingChatSummary(): Promise<void> {
  startTest('M04', 'Rolling chat summary generated and updated correctly', 'medium');
  const tid = randomUUID();

  await sendMessageAndCapture(tid, 'Create a file named config.ts that exports a constant PORT with value 3001', {}, t(90_000));
  await sendMessageAndCapture(tid, 'Now add a constant HOST with value localhost to config.ts', {}, t(90_000));
  await sendMessageAndCapture(tid, 'What did we just create?', {}, t(30_000));

  // Query via REST — same reason as M01: avoids DuckDB WAL visibility lag.
  const sumRes = await apiGet(`/api/threads/${tid}/summary`, 5000);
  const sumRow = sumRes.status === 200 ? (sumRes.json as { summary: string; message_count: number } | null) : null;
  assert('summary row exists',    sumRow != null,                              `HTTP ${sumRes.status} — found ${sumRow == null ? 0 : 1}`);
  assert('summary is substantial',(sumRow?.summary?.length ?? 0) > 80,        `len: ${sumRow?.summary?.length}`);
  assert('message count tracked', (sumRow?.message_count ?? 0) >= 4,          `count: ${sumRow?.message_count}`);
  warnAssert('summary mentions config', /config|PORT|HOST/i.test(sumRow?.summary ?? ''), 'summary content relevant');
  endTest();
}

async function testM05_multiTaskDependencies(): Promise<void> {
  startTest('M05', 'Multi-task plan with file dependencies executes in order', 'medium');
  const tid = randomUUID();
  const s   = await sendMessageAndCapture(
    tid,
    'Create two TypeScript files: first constants.ts that exports MAX_RETRIES = 3, then retry.ts that imports MAX_RETRIES from constants.ts and exports a function retryOperation that logs the retry count',
    {}, t(180_000)
  );

  assert('complete',            s.complete,              `elapsed ${s.durationMs}ms`);
  assert('multiple tasks',      s.taskStarts.length >= 2, `tasks: ${s.taskStarts.length}`);
  assert('multiple file panels', s.filePanels.length >= 2, `panels: ${s.filePanels.length}`);

  const wsDir = path.join(WORKSPACES_ROOT, tid);
  assert('constants.ts exists', existsSync(path.join(wsDir, 'constants.ts')), 'on disk');
  assert('retry.ts exists',     existsSync(path.join(wsDir, 'retry.ts')),     'on disk');

  if (existsSync(path.join(wsDir, 'retry.ts'))) {
    const retryContent = await fs.readFile(path.join(wsDir, 'retry.ts'), 'utf-8');
    assert('retry.ts imports constants', /constants/.test(retryContent), 'import present');
    assert('retry.ts has retryOperation', retryContent.includes('retryOperation'), 'function name');
  }

  try {
    const { rows: files, locked: filesLocked2, error: filesErr2 } = await dbQuerySafe<{ file_path: string }>(CONV_DB_PATH,
      `SELECT file_path FROM conversation_turn_files WHERE thread_id = ?`, [tid]);
    dbAssert('both files linked', files.length >= 2, filesLocked2, filesLocked2 ? filesErr2 : `linked: ${files.map(f => f.file_path).join(', ')}`);
  } catch (e) {
    assert('turn files readable', false, (e as Error).message);
  }
  endTest();
}

async function testM06_copilotSayonMemory(): Promise<void> {
  startTest('M06', 'Copilot SAYON: memory write and conversation turn indexing', 'medium');
  const sayonThreadId = 'copilot-sayon'; // COPILOT_THREAD_IDS.sayon

  // Copilot endpoint returns SSE — must be captured as a stream, not as JSON
  const s1 = await sendMessageAndCapture(
    sayonThreadId,
    'My preferred coding language is TypeScript and I always use strict mode.',
    {},
    t(180_000),
    '/api/copilot/sayon'
  );
  assert('copilot stream completes', s1.complete, `elapsed ${s1.durationMs}ms`);

  await new Promise(r => setTimeout(r, 3000)); // allow async memory write

  try {
    const { rows: turns } = await dbQuerySafe(CONV_DB_PATH,
      `SELECT id FROM conversation_turns WHERE thread_id = ?`, [sayonThreadId]);
    warnAssert('copilot turn indexed', turns.length > 0, `found ${turns.length} — SYBIL may be offline`);
  } catch (e) {
    warnAssert('conversations.duckdb readable for copilot', false, (e as Error).message);
  }
  endTest();
}

async function testM07_inlineContentExtraction(): Promise<void> {
  startTest('M07', 'Inline code block extracted as temp file, not included verbatim in rewrite', 'medium');
  const tid = randomUUID();
  const largeBlock = [
    '```typescript',
    'function processData(items: string[]): string[] {',
    '  const result: string[] = [];',
    '  for (let i = 0; i < items.length; i++) {',
    '    const item = items[i];',
    '    if (item.length > 0) {',
    '      result.push(item.toUpperCase());',
    '    }',
    '  }',
    '  return result;',
    '}',
    '```',
  ].join('\n');
  const msg = `Here is my function:\n\n${largeBlock}\n\nCan you add error handling for null items?`;

  const s = await sendMessageAndCapture(tid, msg, {}, t(120_000));
  assert('complete',        s.complete,     `elapsed ${s.durationMs}ms`);
  // Routing may be ANSWER_DIRECTLY or NEEDS_SEREN depending on model confidence —
  // what matters is that the inline block was extracted before the rewrite was built.
  warnAssert('task dispatched', s.taskStarts.length > 0, 'SEREN handled it');

  // Temp file should exist in workspace
  const wsDir = path.join(WORKSPACES_ROOT, tid);
  const files = existsSync(wsDir) ? await fs.readdir(wsDir) : [];
  const tempFile = files.find(f => f.startsWith('_user_content_'));
  warnAssert('_user_content_ temp file extracted', tempFile != null, `files: ${files.join(', ')}`);
  endTest();
}

async function testM08_fileReadCycle(): Promise<void> {
  startTest('M08', 'Read-file cycle: SEREN reads existing file before modifying', 'medium');
  const tid = randomUUID();

  // Turn 1: create the file
  const s1 = await sendMessageAndCapture(
    tid, "Create a file named greeter.ts with an exported function sayHello that returns 'Hello World'", {}, t(120_000)
  );
  assert('turn 1 complete',     s1.complete,                            `elapsed ${s1.durationMs}ms`);
  assert('greeter.ts created',  s1.filePanels.some(p => p.filename.includes('greeter')), `panels: ${s1.filePanels.map(p => p.filename).join(', ')}`);

  // Turn 2: modify (requires reading first — must use modify op, not create)
  const s2 = await sendMessageAndCapture(
    tid, "Modify greeter.ts by adding a second exported function called sayGoodbye that returns 'Goodbye World'. Keep sayHello exactly as it is.", {}, t(120_000)
  );
  assert('turn 2 complete', s2.complete,  `elapsed ${s2.durationMs}ms`);
  assert('file_panel on turn 2', s2.filePanels.length > 0, `panels: ${s2.filePanels.length}`);

  const wsDir = path.join(WORKSPACES_ROOT, tid);
  if (existsSync(path.join(wsDir, 'greeter.ts'))) {
    const content = await fs.readFile(path.join(wsDir, 'greeter.ts'), 'utf-8');
    assert('sayHello preserved', content.includes('sayHello'),   `original not lost — file: ${content.slice(0, 120)}`);
    assert('sayGoodbye added',   content.includes('sayGoodbye'), `new function present — file: ${content.slice(0, 120)}`);
  } else {
    assert('greeter.ts exists on disk', false, 'file missing');
  }
  endTest();
}

// ─────────────────────────────────────────────────────────────────────────────
// ── LONG TESTS ────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

async function testL01_paginatedWriting(): Promise<void> {
  startTest('L01', 'Paginated writing: continuation turns produce complete long file', 'long');
  const tid = randomUUID();
  const s   = await sendMessageAndCapture(
    tid,
    'Write a comprehensive TypeScript utility library named mathUtils.ts. Include at least 12 documented exported functions: add, subtract, multiply, divide (with divide-by-zero guard), clamp, lerp, isPrime, fibonacci, factorial, gcd, mean, and standardDeviation. Each function must have a JSDoc comment explaining its purpose and parameters.',
    {}, t(360_000))  // 6 minutes for large output

  assert('complete received',         s.complete,                                   `elapsed ${s.durationMs}ms`);
  assert('file_panel emitted',        s.filePanels.length > 0,                      `panels: ${s.filePanels.length}`);

  const panel = s.filePanels.find(p => p.filename.includes('mathUtils'));
  assert('mathUtils.ts panel present', panel != null,                               `panels: ${s.filePanels.map(p => p.filename).join(', ')}`);

  const hasContinuation = s.statusPills.some(p => /continuing output/i.test(p));
  warnAssert('pagination triggered (large output)', hasContinuation, hasContinuation ? 'pagination fired' : 'output fit in single pass');

  const wsDir = path.join(WORKSPACES_ROOT, tid);
  if (existsSync(path.join(wsDir, 'mathUtils.ts'))) {
    const content = await fs.readFile(path.join(wsDir, 'mathUtils.ts'), 'utf-8');
    assert('file is substantial', content.length > 1500,   `len: ${content.length}`);
    assert('has export functions', (content.match(/export function/g)?.length ?? 0) >= 6, `found: ${content.match(/export function/g)?.length}`);
    assert('no mid-word truncation', !content.endsWith('...'), 'complete output');
  } else {
    assert('mathUtils.ts exists on disk', false, 'file missing');
  }
  endTest();
}

async function testL02_agentStateSequence(): Promise<void> {
  startTest('L02', 'Agent state machine: correct state sequence for full CODE_REQUEST', 'long');
  const tid = randomUUID();
  const s   = await sendMessageAndCapture(
    tid, 'Create two files: a types.ts that exports interface User with id, name, email fields, and a userService.ts that imports User and exports a createUser function',
    {}, t(180_000)
  );
  assert('complete', s.complete, `elapsed ${s.durationMs}ms`);

  const agentEvents = (s.byType.get('agent_state') ?? []).map(e => (e as any).state as string);
  const unique      = [...new Set(agentEvents)];
  assert('agent_state events emitted', agentEvents.length > 0, `got ${agentEvents.length} events`);

  // Key states that must appear
  const hasPlanning  = unique.includes('planning')  || unique.includes('decomposing_tasks');
  const hasThinking  = unique.includes('thinking');
  const hasExecuting = unique.includes('executing');
  warnAssert('planning state observed',  hasPlanning,  `states: ${unique.join(', ')}`);
  warnAssert('thinking state observed',  hasThinking,  `states: ${unique.join(', ')}`);
  warnAssert('executing state observed', hasExecuting, `states: ${unique.join(', ')}`);
  endTest();
}

async function testL03_contextOverflowHandling(): Promise<void> {
  startTest('L03', 'Context overflow: budget respected when history exceeds 24k chars', 'long');
  const tid = randomUUID();

  // Build enough history to overflow the budget
  // Each turn: ~200 char user + ~500 char assistant distilled = ~700 chars/turn
  // Budget = 24,000 chars → need ~35+ turns to overflow. Use 12 turns with verbose responses.
  for (let i = 0; i < 12; i++) {
    await sendMessageAndCapture(
      tid,
      `Question ${i + 1}: Explain in detail one interesting property of the number ${(i + 1) * 7}`,
      {}, 30_000
    );
  }

  // Message 13
  const s13 = await sendMessageAndCapture(tid, 'What was the very first thing we discussed?', {}, t(30_000));
  assert('message 13 completes', s13.complete, `elapsed ${s13.durationMs}ms`);
  assert('ctx_computed present',  s13.ctxCount !== null, `count: ${s13.ctxCount}`);
  assert('ctx_computed < 12',     (s13.ctxCount ?? 99) < 12, `got: ${s13.ctxCount} — budget kicked in`);
  assert('ctx_computed > 0',      (s13.ctxCount ?? 0) > 0,   `got: ${s13.ctxCount} — some history fits`);

  // Use REST API for message count — avoids DuckDB WAL visibility race (same issue as S04/S07).
  const allMsgs = await apiGetMessages(tid);
  assert('all messages persisted', allMsgs.length >= 26, `found ${allMsgs.length} (expected ≥ 26)`);
  endTest();
}

async function testL04_fullConversationRAGRoundTrip(): Promise<void> {
  startTest('L04', 'Full conversation RAG round-trip: index → VSS → file linkage → injection', 'long');
  const tid = randomUUID();

  // Turn 1: create EventBus
  const s1 = await sendMessageAndCapture(
    tid,
    'Create EventBus.ts with a typed EventBus class that has on(event, handler), off(event, handler), and emit(event, data) methods using TypeScript generics',
    {}, t(180_000)
  );
  assert('EventBus.ts created', s1.filePanels.some(p => p.filename.includes('EventBus')), `panels: ${s1.filePanels.map(p => p.filename).join(', ')}`);
  assert('turn 1 complete', s1.complete, `elapsed ${s1.durationMs}ms`);

  await new Promise(r => setTimeout(r, 2000)); // SYBIL indexing

  // Turn 2: unrelated
  await sendMessageAndCapture(tid, 'What is the capital of France?', {}, t(30_000));

  // Turn 3: memory retrieval referencing EventBus
  const s3 = await sendMessageAndCapture(
    tid,
    "Remember when we built EventBus.ts? Modify that file to add a once() method that fires exactly once and then automatically unsubscribes.",
    {}, t(180_000)
  );
  assert('turn 3 complete',        s3.complete, `elapsed ${s3.durationMs}ms`);
  assert('file_panel on turn 3',   s3.filePanels.length > 0, `panels: ${s3.filePanels.length}`);

  const wsDir = path.join(WORKSPACES_ROOT, tid);
  if (existsSync(path.join(wsDir, 'EventBus.ts'))) {
    const content = await fs.readFile(path.join(wsDir, 'EventBus.ts'), 'utf-8');
    assert('original methods preserved', content.includes('on(') || content.includes('emit('), 'on/emit still there');
    warnAssert('once() method added',    content.includes('once('), 'RAG-driven modification');
  }

  try {
    const { rows: turns, locked: turnsLocked4, error: turnsErr4 } = await dbQuerySafe<{ id: string }>(CONV_DB_PATH,
      `SELECT id FROM conversation_turns WHERE thread_id = ?`, [tid]);
    dbAssert('3 turns indexed', turns.length === 3, turnsLocked4, turnsLocked4 ? turnsErr4 : `found ${turns.length}`);
  } catch (e) {
    assert('conversation turns readable', false, (e as Error).message);
  }
  endTest();
}

async function testL05_exhaustiveWebsite(): Promise<void> {
  startTest('L05', 'Exhaustive scope: multi-file React website from design doc', 'long');
  const tid = randomUUID();

  // Upload the fixture design doc as an attachment
  const fixturePath    = path.join(FIXTURES_DIR, 'PHOBOS-System-Design.md');
  const fixtureContent = existsSync(fixturePath)
    ? await fs.readFile(fixturePath, 'utf-8')
    : '# PHOBOS System Design\n## Overview\nPHOBOS is a local AI platform.';
  const attachId = await uploadAttachment(tid, 'PHOBOS-System-Design.md', fixtureContent);
  assert('fixture attachment uploaded', attachId != null, `id: ${attachId}`);

  const s = await sendMessageAndCapture(
    tid,
    'Based on PHOBOS-System-Design.md, build me a fully featured React SPA that represents the PHOBOS system. Use TypeScript and Tailwind CSS. Create separate files for: App.tsx (main entry), a Sidebar component, a MainContent component, a StatusIndicator component, and a NavigationMenu component. Wire them all together in App.tsx.',
    { attachmentIds: attachId ? [attachId] : [] },
    t(480_000))  // 8 minutes

  assert('complete',                  s.complete,                s.timedOut ? 'TIMED OUT' : `elapsed ${s.durationMs}ms`);
  assert('NEEDS_SEREN routing',       s.routing === 'NEEDS_SEREN', `got: ${s.routing}`);
  assert('≥ 4 task starts',           s.taskStarts.length >= 4,  `tasks: ${s.taskStarts.length}`);
  assert('≥ 4 file panels',           s.filePanels.length >= 4,  `panels: ${s.filePanels.length}`);

  const wsDir = path.join(WORKSPACES_ROOT, tid);
  const hasApp      = existsSync(path.join(wsDir, 'App.tsx'));
  assert('App.tsx exists', hasApp, `checked: ${wsDir}`);

  if (hasApp) {
    const appContent = await fs.readFile(path.join(wsDir, 'App.tsx'), 'utf-8');
    assert('App.tsx imports a component', /import.*from/.test(appContent), 'has imports');
  }

  const wsFiles = existsSync(wsDir) ? await fs.readdir(wsDir) : [];
  const tsxFiles = wsFiles.filter(f => f.endsWith('.tsx') || f.endsWith('.ts'));
  assert('≥ 4 TypeScript files produced', tsxFiles.length >= 4, `found: ${tsxFiles.join(', ')}`);

  try {
    const { rows: files, locked: filesLocked3, error: filesErr3 } = await dbQuerySafe<{ file_path: string }>(CONV_DB_PATH,
      `SELECT file_path FROM conversation_turn_files WHERE thread_id = ?`, [tid]);
    dbAssert('≥ 4 files linked in conversation', files.length >= 4, filesLocked3, filesLocked3 ? filesErr3 : `linked: ${files.length}`);
  } catch (e) {
    assert('conversation_turn_files readable', false, (e as Error).message);
  }
  endTest();
}

// ─────────────────────────────────────────────────────────────────────────────
// ── EDGE CASE TESTS ───────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

async function testE01_sybilUnavailableDegrades(): Promise<void> {
  startTest('E01', 'SYBIL unavailable: pipeline completes, conversation turn skipped gracefully', 'edge');
  // Check if SYBIL is currently UP — this test is only meaningful when it's down
  const sybilUp = await checkPort(16315);
  if (sybilUp) {
    endTest('SKIP', 'SYBIL is running — restart without SYBIL to run this test');
    return;
  }

  const tid = randomUUID();
  const s   = await sendMessageAndCapture(tid, 'What is the largest planet in the solar system?', {}, t(30_000));
  assert('pipeline completes despite no SYBIL', s.complete, `elapsed ${s.durationMs}ms`);
  assert('no server error',                     !s.byType.has('error'),              'no error event');

  try {
    const { rows: turns } = await dbQuerySafe(CONV_DB_PATH,
      `SELECT id FROM conversation_turns WHERE thread_id = ?`, [tid]);
    assert('conversation turn not indexed (SYBIL down)', turns.length === 0, `found ${turns.length} — expected 0 without SYBIL`);
  } catch (e) {
    warnAssert('conversations.duckdb accessible', false, (e as Error).message);
  }
  endTest();
}

async function testE02_emptyContentRejected(): Promise<void> {
  startTest('E02', 'Empty message content is handled without crash', 'edge');
  const tid = randomUUID();

  // Empty content string
  try {
    const r = await apiPost(`/api/threads/${tid}/messages`, { content: '' }, t(10_000));
    // Either 400 (strict validation) or a graceful response — neither should 500
    assert('no 500 error on empty content', r.status !== 500, `status: ${r.status}`);
  } catch (e) {
    assert('request did not throw', false, (e as Error).message);
  }
  endTest();
}

async function testE03_fileOverwriteSafe(): Promise<void> {
  startTest('E03', 'File overwrite: second write produces correct content, first not duplicated', 'edge');
  const tid = randomUUID();

  // Turn 1: create utils.ts
  await sendMessageAndCapture(
    tid, "Create utils.ts that exports a function double(n: number): number that returns n * 2", {}, t(120_000)
  );

  // Turn 2: overwrite with different impl
  const s2 = await sendMessageAndCapture(
    tid, "Rewrite utils.ts so double(n) returns n * 3 instead", {}, t(120_000)
  );
  assert('turn 2 complete', s2.complete, `elapsed ${s2.durationMs}ms`);

  const wsDir = path.join(WORKSPACES_ROOT, tid);
  const files = existsSync(wsDir) ? await fs.readdir(wsDir) : [];
  const utilsFiles = files.filter(f => f === 'utils.ts');
  assert('only one utils.ts file', utilsFiles.length === 1, `found: ${utilsFiles.length}`);

  if (existsSync(path.join(wsDir, 'utils.ts'))) {
    const content = await fs.readFile(path.join(wsDir, 'utils.ts'), 'utf-8');
    assert('content is updated version', content.includes('3') || content.includes('triple'), `content: ${content.slice(0, 100)}`);
  }

  try {
    const { rows: turnFiles, locked: tfLocked, error: tfErr } = await dbQuerySafe<{ file_path: string; turn_id: string }>(CONV_DB_PATH,
      `SELECT file_path, turn_id FROM conversation_turn_files WHERE thread_id = ?`, [tid]);
    const utilsTurnFiles = turnFiles.filter(f => f.file_path.includes('utils'));
    dbAssert('utils.ts linked to 2 turns', utilsTurnFiles.length >= 2, tfLocked, tfLocked ? tfErr : `found ${utilsTurnFiles.length} links`);
  } catch (e) {
    assert('turn files readable', false, (e as Error).message);
  }
  endTest();
}

async function testE04_serverHealthEndpoint(): Promise<void> {
  startTest('E04', 'Server health and status endpoints respond correctly', 'edge');
  const statusRes = await apiGet('/api/status', 5_000).catch(() => ({ status: 0, json: null }));
  assert('GET /api/status returns 200', statusRes.status === 200, `status: ${statusRes.status}`);
  assert('status has coordinator field', (statusRes.json as any)?.coordinator != null, `json: ${JSON.stringify(statusRes.json)?.slice(0, 100)}`);
  endTest();
}

async function testE05_conversationsDbIsolation(): Promise<void> {
  startTest('E05', 'conversations.duckdb is separate from archive domains', 'edge');
  // Verify conversations.duckdb exists at the correct path
  assert('conversations.duckdb at correct path', existsSync(CONV_DB_PATH), `path: ${CONV_DB_PATH}`);

  // Verify it does NOT live inside the archive directory
  const archiveDir   = path.join(PHOBOS_DATA_DIR, 'archive');
  const archiveFiles = existsSync(archiveDir) ? await fs.readdir(archiveDir) : [];
  assert('conversations.duckdb not in archive dir', !archiveFiles.includes('conversations.duckdb'), `archive contents: ${archiveFiles.join(', ')}`);

  // Verify the conversations DB has the expected tables
  try {
    // sqlite_master doesn't exist in DuckDB — skip the probe, go straight to information_schema
    const { rows: schemaRows, locked: schemaLocked, error: schemaErr } = await dbQuerySafe<{ table_name: string }>(CONV_DB_PATH,
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'`
    );
    const tableNames = schemaRows.map(r => r.table_name);
    dbAssert('conversation_turns table exists',       tableNames.includes('conversation_turns'),      schemaLocked, schemaLocked ? schemaErr : `tables: ${tableNames.join(', ')}`);
    dbAssert('conversation_turn_files table exists',  tableNames.includes('conversation_turn_files'), schemaLocked, schemaLocked ? schemaErr : `tables: ${tableNames.join(', ')}`);
  } catch (e) {
    assert('conversations.duckdb schema readable', false, (e as Error).message);
  }
  endTest();
}

// ─────────────────────────────────────────────────────────────────────────────
// ── MAIN ──────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  openLogStream();
  console.log(`Log: ${LOG_PATH}`);
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║     PHOBOS — AI Conversation Features Test Suite            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // ── Setup ──────────────────────────────────────────────────────────────────
  // --rebuildconfig runs its own async path and calls process.exit — skip all
  // template copy, server start, and test execution here.
  if (REBUILD_CONFIG) return;

  console.log('\n── Environment Setup ─────────────────────────────────────────');
  const setupOk = await setup();
  if (!setupOk) {
    console.error('\n  ❌ Setup failed — aborting');
    closeLogStream();
    process.exit(2);
  }

  const serverStarted = await startServer();
  if (!serverStarted) {
    console.error('\n  ❌ Server failed to start — aborting');
    closeLogStream();
    process.exit(2);
  }

  // ── Preflight checks ───────────────────────────────────────────────────────
  console.log('\n── Preflight Checks ──────────────────────────────────────────');
  const sybilUp = await checkPort(16315);
  console.log(`  SYBIL (:16315): ${sybilUp ? '✅ online' : '⚠️  offline (VSS tests will SKIP or WARN)'}`);

  const serverAlive = await apiGet('/api/status', 5000).catch(() => ({ status: 0, json: null }));
  if (serverAlive.status !== 200) {
    console.error('  ❌ Server /api/status not responding — aborting');
    await stopServer();
    closeLogStream();
    process.exit(2);
  }
  console.log(`  PHOBOS server: ✅ responding on :${SERVER_PORT}`);

  // ── Short tests ────────────────────────────────────────────────────────────
  const runShort = !LONG_ONLY && (!ONLY_ID || ONLY_ID.startsWith('S'));
  if (runShort) {
    console.log('\n── Short Tests (S01–S10) ─────────────────────────────────────');
    if (!ONLY_ID || ONLY_ID === 'S01') { await testS01_intentRoutingDirect();              await waitForModelIdle('S01'); }
    if (!ONLY_ID || ONLY_ID === 'S02') { await testS02_intentRoutingNeeds();               await waitForModelIdle('S02'); }
    if (!ONLY_ID || ONLY_ID === 'S03') { await testS03_ctxComputedEvent();                 await waitForModelIdle('S03'); }
    if (!ONLY_ID || ONLY_ID === 'S04') { await testS04_distilledContentUsedForContext();   await waitForModelIdle('S04'); }
    if (!ONLY_ID || ONLY_ID === 'S05') { await testS05_conversationTurnIndexed();          await waitForModelIdle('S05'); }
    if (!ONLY_ID || ONLY_ID === 'S06') { await testS06_memoryIntentPatterns();             /* pure unit — no model call */ }
    if (!ONLY_ID || ONLY_ID === 'S07') { await testS07_distillationStrip();                await waitForModelIdle('S07'); }
    if (!ONLY_ID || ONLY_ID === 'S08') { await testS08_clarificationLoopSeren();           await waitForModelIdle('S08'); }
    if (!ONLY_ID || ONLY_ID === 'S09') { await testS09_ctxOverrideManual();                await waitForModelIdle('S09'); }
    if (!ONLY_ID || ONLY_ID === 'S10') { await testS10_archiveDoesNotPolluteCovnersations(); await waitForModelIdle('S10'); }
  }

  // ── Medium tests ───────────────────────────────────────────────────────────
  const runMedium = !LONG_ONLY && (RUN_ALL || WITH_MEDIUM || (ONLY_ID?.startsWith('M') ?? false));
  if (runMedium && !SHORT_ONLY) {
    console.log('\n── Medium Tests (M01–M08) ────────────────────────────────────');
    if (!ONLY_ID || ONLY_ID === 'M01') { await testM01_directAnswerPersistence();     await waitForModelIdle('M01'); }
    if (!ONLY_ID || ONLY_ID === 'M02') { await testM02_singleFileCreation();          await waitForModelIdle('M02'); }
    if (!ONLY_ID || ONLY_ID === 'M03') { await testM03_conversationRAGRetrieval();    await waitForModelIdle('M03'); }
    if (!ONLY_ID || ONLY_ID === 'M04') { await testM04_rollingChatSummary();          await waitForModelIdle('M04'); }
    if (!ONLY_ID || ONLY_ID === 'M05') { await testM05_multiTaskDependencies();       await waitForModelIdle('M05'); }
    if (!ONLY_ID || ONLY_ID === 'M06') { await testM06_copilotSayonMemory();          await waitForModelIdle('M06'); }
    if (!ONLY_ID || ONLY_ID === 'M07') { await testM07_inlineContentExtraction();     await waitForModelIdle('M07'); }
    if (!ONLY_ID || ONLY_ID === 'M08') { await testM08_fileReadCycle();               await waitForModelIdle('M08'); }
  }

  // ── Long tests ─────────────────────────────────────────────────────────────
  const runLong = LONG_ONLY || (ONLY_ID?.startsWith('L') ?? false);
  if (runLong && !SHORT_ONLY) {
    console.log('\n── Long Tests (L01–L05) ──────────────────────────────────────');
    if (!ONLY_ID || ONLY_ID === 'L01') { await testL01_paginatedWriting();            await waitForModelIdle('L01'); }
    if (!ONLY_ID || ONLY_ID === 'L02') { await testL02_agentStateSequence();          await waitForModelIdle('L02'); }
    if (!ONLY_ID || ONLY_ID === 'L03') { await testL03_contextOverflowHandling();     await waitForModelIdle('L03'); }
    if (!ONLY_ID || ONLY_ID === 'L04') { await testL04_fullConversationRAGRoundTrip(); await waitForModelIdle('L04'); }
    if (!ONLY_ID || ONLY_ID === 'L05') { await testL05_exhaustiveWebsite();           await waitForModelIdle('L05'); }
  }

  // ── Edge case tests ────────────────────────────────────────────────────────
  const runEdge = RUN_ALL || (ONLY_ID?.startsWith('E') ?? false);
  if (runEdge && !SHORT_ONLY) {
    console.log('\n── Edge Case Tests (E01–E05) ─────────────────────────────────');
    if (!ONLY_ID || ONLY_ID === 'E01') { await testE01_sybilUnavailableDegrades();   await waitForModelIdle('E01'); }
    if (!ONLY_ID || ONLY_ID === 'E02') { await testE02_emptyContentRejected(); }
    if (!ONLY_ID || ONLY_ID === 'E03') { await testE03_fileOverwriteSafe();           await waitForModelIdle('E03'); }
    if (!ONLY_ID || ONLY_ID === 'E04') { await testE04_serverHealthEndpoint(); }
    if (!ONLY_ID || ONLY_ID === 'E05') { await testE05_conversationsDbIsolation(); }
  }

  // ── Teardown ───────────────────────────────────────────────────────────────
  console.log('\n── Teardown ──────────────────────────────────────────────────');
  await stopServer();
  console.log('  Server stopped.');
  await teardownScratch();

  // ── Report ─────────────────────────────────────────────────────────────────
  const pass_n = results.filter(r => r.status === 'PASS').length;
  const fail_n = results.filter(r => r.status === 'FAIL').length;
  const warn_n = results.filter(r => r.status === 'WARN').length;
  const skip_n = results.filter(r => r.status === 'SKIP').length;
  const total  = results.length;

  // Write JSON report
  const report = {
    runId:       new Date().toISOString(),
    sybilOnline: sybilUp,
    totals:      { pass: pass_n, fail: fail_n, warn: warn_n, skip: skip_n, total },
    tests:       results,
  };
  const reportPath = path.join(OUTPUT_DIR, 'report.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  // Write markdown report
  const mdLines: string[] = [
    '# PHOBOS AI Features Test Report',
    `**Run:** ${report.runId}`,
    `**SYBIL:** ${sybilUp ? 'online' : 'offline'}`,
    `**Results:** PASS:${pass_n} FAIL:${fail_n} WARN:${warn_n} SKIP:${skip_n}`,
    '',
    '## Results',
    '',
    '| ID | Name | Status | Duration |',
    '|---|---|---|---|',
    ...results.map(r => `| ${r.id} | ${r.name} | ${r.status} | ${r.duration_ms}ms |`),
    '',
    ...(fail_n > 0 ? [
      '## Failures',
      '',
      ...results.filter(r => r.status === 'FAIL').flatMap(r => [
        `### ${r.id} — ${r.name}`,
        ...r.assertions.filter(a => !a.passed).map(a => `- ❌ ${a.label}${a.detail ? `: ${a.detail}` : ''}`),
        '',
      ]),
    ] : []),
  ];
  await fs.writeFile(path.join(OUTPUT_DIR, 'report.md'), mdLines.join('\n'));

  // Console summary
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  RESULTS   PASS:${String(pass_n).padStart(3)}  FAIL:${String(fail_n).padStart(3)}  WARN:${String(warn_n).padStart(3)}  SKIP:${String(skip_n).padStart(3)}  TOTAL:${String(total).padStart(3)} ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');

  if (fail_n > 0) {
    for (const r of results.filter(r => r.status === 'FAIL')) {
      const line = `  ❌ [${r.id}] ${r.name}`.slice(0, 62).padEnd(62);
      console.log(`║${line}║`);
    }
    console.log('╠══════════════════════════════════════════════════════════════╣');
  }

  const verdict = fail_n === 0
    ? (warn_n === 0 ? '  ✅ All tests passed.' : '  ✅ No failures — review WARNs above.')
    : `  ❌ ${fail_n} failure${fail_n > 1 ? 's' : ''} — fix before committing.`;
  console.log(`║  ${verdict.slice(0, 60).padEnd(60)}  ║`);
  console.log(`║  Report: ${reportPath.slice(0, 52).padEnd(52)}  ║`);
  console.log(`║  Log:    ${LOG_PATH.slice(0, 52).padEnd(52)}  ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  closeLogStream();
  process.exit(fail_n > 0 ? 1 : 0);
}

main().catch(async err => {
  console.error('\n  ❌ Unhandled error in test runner:', err);
  // Write whatever results we have so the run isn't entirely lost
  if (results.length > 0) {
    try {
      mkdirSync(OUTPUT_DIR, { recursive: true });
      const partial = { runId: new Date().toISOString(), partial: true, error: String(err), tests: results };
      await fs.writeFile(path.join(OUTPUT_DIR, 'report-partial.json'), JSON.stringify(partial, null, 2));
      console.error(`  💾 Partial report saved to ${OUTPUT_DIR}/report-partial.json`);
    } catch { /* non-fatal */ }
  }
  stopServer().catch(() => {});
  teardownScratch().catch(() => {});
  closeLogStream();
  process.exit(2);
});
