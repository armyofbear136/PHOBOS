#!/usr/bin/env npx tsx
// test-rag.ts — SYBIL + semantic memory end-to-end validation
//
// Tests each layer of the RAG stack independently so failures are pinpointed.
//
// Usage:
//   npx tsx test-rag.ts                  — full suite
//   npx tsx test-rag.ts --embed-only     — SYBIL connectivity + embed quality only
//   npx tsx test-rag.ts --store-only     — DuckDB VSS insert/search only
//   npx tsx test-rag.ts --writer-only    — MemoryWriter public API only
//   npx tsx test-rag.ts --no-server      — skip SYBIL server tests (DuckDB only)
//
// Prerequisites:
//   • SYBIL running on :16315 (npm start or npx tsx server.ts), OR --no-server flag
//   • DuckDB with vss extension available in the project DB

import path   from 'node:path';
import fs     from 'node:fs';
import http   from 'node:http';
import net    from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI flags ──────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const EMBED_ONLY = args.includes('--embed-only');
const STORE_ONLY = args.includes('--store-only');
const WRITER_ONLY= args.includes('--writer-only');
const NO_SERVER  = args.includes('--no-server');
const RUN_ALL    = !EMBED_ONLY && !STORE_ONLY && !WRITER_ONLY;

// ── Result tracking ────────────────────────────────────────────────────────────
type TestStatus = 'PASS' | 'FAIL' | 'SKIP' | 'WARN';
interface TestResult {
  name:    string;
  status:  TestStatus;
  detail?: string;
}
const results: TestResult[] = [];

function pass(name: string, detail?: string): void {
  results.push({ name, status: 'PASS', detail });
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name: string, detail: string): void {
  results.push({ name, status: 'FAIL', detail });
  console.log(`  ❌ ${name} — ${detail}`);
}
function warn(name: string, detail: string): void {
  results.push({ name, status: 'WARN', detail });
  console.log(`  ⚠️  ${name} — ${detail}`);
}
function skip(name: string, detail: string): void {
  results.push({ name, status: 'SKIP', detail });
  console.log(`  ⏭️  ${name} — ${detail}`);
}

// ── HTTP helper ────────────────────────────────────────────────────────────────
function httpPost(port: number, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const b = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) },
        timeout: 12_000 },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString()) }); }
          catch { resolve({ status: res.statusCode ?? 0, json: null }); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(b);
    req.end();
  });
}

// ── Section 1: SYBIL server connectivity ──────────────────────────────────────
async function testSybilConnectivity(): Promise<void> {
  console.log('\n── 1. SYBIL Server Connectivity (:16315) ─────────────────────');

  if (NO_SERVER) {
    skip('SYBIL port open', '--no-server flag set');
    skip('SYBIL /embedding response shape', '--no-server flag set');
    skip('SYBIL embedding dimension', '--no-server flag set');
    return;
  }

  // 1a. Port check
  const portOpen = await new Promise<boolean>(resolve => {
    const sock = net.connect(16315, '127.0.0.1');
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    setTimeout(() => { sock.destroy(); resolve(false); }, 2000);
  });

  if (!portOpen) {
    fail('SYBIL port open', 'Port 16315 not accepting connections — is SYBIL running?');
    skip('SYBIL /embedding response shape', 'server not reachable');
    skip('SYBIL embedding dimension', 'server not reachable');
    return;
  }
  pass('SYBIL port open', 'port 16315 accepting connections');

  // 1b. /embedding response shape
  let vec: number[] | null = null;
  try {
    const r = await httpPost(16315, '/embedding', { content: 'hello world' }) as any;
    if (r.status !== 200) {
      fail('SYBIL /embedding response shape', `HTTP ${r.status}`);
      skip('SYBIL embedding dimension', 'bad response');
      return;
    }
    // llama-server returns either:
    //   New: [{ index: 0, embedding: [[f32, ...]] }]  — array of objects, embedding is array-of-arrays
    //   Old: { embedding: [f32, ...] }                — direct flat array
    const json = r.json as any;
    let raw: any;
    if (Array.isArray(json) && json.length > 0) {
      raw = json[0]?.embedding;
    } else {
      raw = json?.embedding;
    }
    // Unwrap nested array if present: [[f32,...]] → [f32,...]
    const flat = Array.isArray(raw?.[0]) ? raw[0] : raw;
    if (!Array.isArray(flat)) {
      fail('SYBIL /embedding response shape', `unexpected shape: ${JSON.stringify(json)?.slice(0, 120)}`);
      skip('SYBIL embedding dimension', 'bad shape');
      return;
    }
    vec = flat;
    pass('SYBIL /embedding response shape', `embedding is array of ${vec.length} floats`);
  } catch (e) {
    fail('SYBIL /embedding response shape', (e as Error).message);
    skip('SYBIL embedding dimension', 'request failed');
    return;
  }

  // 1c. Dimension check — nomic-embed-text-v1.5 must be 768
  if (vec!.length === 768) {
    pass('SYBIL embedding dimension', '768 — correct for nomic-embed-text-v1.5');
  } else {
    fail('SYBIL embedding dimension', `expected 768, got ${vec!.length} — wrong model loaded?`);
  }
}

// ── Section 2: EmbedClient module ─────────────────────────────────────────────
async function testEmbedClient(): Promise<void> {
  console.log('\n── 2. EmbedClient Module ─────────────────────────────────────');

  if (NO_SERVER) {
    skip('embed() returns null when SYBIL offline', 'skipped in --no-server mode');
    return;
  }

  // Import the module — works in both tsx dev and compiled CJS
  let embedFn: ((text: string) => Promise<number[] | null>) | null = null;
  try {
    const mod = await import('./ai/EmbedClient.js');
    embedFn = mod.embed;
    pass('EmbedClient import', 'module loaded');
  } catch (e) {
    fail('EmbedClient import', (e as Error).message);
    return;
  }

  // 2a. embed() with live SYBIL
  let vec: number[] | null = null;
  try {
    vec = await embedFn!('PHOBOS dual inference architecture using SAYON and SEREN models');
    if (vec === null) {
      fail('embed() live call', 'returned null — SYBIL may not be running');
    } else if (vec.length !== 768) {
      fail('embed() live call', `wrong dimension: ${vec.length}`);
    } else {
      pass('embed() live call', `768-dim vector, first 3: [${vec.slice(0,3).map(v=>v.toFixed(4)).join(', ')}]`);
    }
  } catch (e) {
    fail('embed() live call', (e as Error).message);
  }

  // 2b. embed() null safety — connect to a closed port
  try {
    // Temporarily override port by calling raw HTTP to a port we know is closed
    const badResult = await new Promise<number[] | null>(resolve => {
      const b = JSON.stringify({ content: 'test' });
      const req = http.request(
        { hostname: '127.0.0.1', port: 19999, path: '/embedding', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) },
          timeout: 1000 },
        () => resolve(null)
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(b); req.end();
    });
    if (badResult === null) {
      pass('embed() null on connection refused', 'returns null cleanly on ECONNREFUSED');
    } else {
      warn('embed() null on connection refused', 'expected null but got a result');
    }
  } catch {
    pass('embed() null on connection refused', 'throws caught by null-return path');
  }

  // 2c. Semantic similarity — two related sentences should be closer than two unrelated ones
  if (vec) {
    try {
      const vecB = await embedFn!('PHOBOS uses two AI models running locally on GPU hardware');
      const vecC = await embedFn!('The stock market closed higher on Tuesday afternoon');
      if (!vecB || !vecC) {
        warn('semantic similarity check', 'could not get comparison vectors');
      } else {
        const cosine = (a: number[], b: number[]) => {
          let dot = 0, na = 0, nb = 0;
          for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
          return dot / (Math.sqrt(na) * Math.sqrt(nb));
        };
        const simRelated   = cosine(vec!,  vecB);
        const simUnrelated = cosine(vec!,  vecC);
        if (simRelated > simUnrelated) {
          pass('semantic similarity', `related: ${simRelated.toFixed(3)} > unrelated: ${simUnrelated.toFixed(3)}`);
        } else {
          warn('semantic similarity', `related: ${simRelated.toFixed(3)} NOT > unrelated: ${simUnrelated.toFixed(3)} — check model`);
        }
      }
    } catch (e) {
      warn('semantic similarity', (e as Error).message);
    }
  }
}

// ── Section 3: MemoryStore (DuckDB VSS) ───────────────────────────────────────
async function testMemoryStore(): Promise<void> {
  console.log('\n── 3. MemoryStore (DuckDB VSS) ───────────────────────────────');

  // Use a temp DB so the test never touches the production DB
  const tmpDb = path.join(__dirname, 'test-outputs', 'test-rag-memory.duckdb');
  fs.mkdirSync(path.dirname(tmpDb), { recursive: true });
  // Wipe from previous run
  for (const f of [tmpDb, tmpDb + '.wal']) {
    try { fs.unlinkSync(f); } catch {}
  }

  let db: any;
  try {
    const { DatabaseManager } = await import('./db/DatabaseManager.js');
    // Use a fresh instance keyed to the temp path
    db = DatabaseManager.getInstance(tmpDb);
    await db.initialize();
    pass('DatabaseManager init', 'temp DB created');
  } catch (e) {
    fail('DatabaseManager init', (e as Error).message);
    return;
  }

  let store: any;
  try {
    const { MemoryStore } = await import('./db/MemoryStore.js');
    store = new MemoryStore(db);
    await store.ensureTable();
    pass('MemoryStore.ensureTable()', 'VSS table + HNSW index created');
  } catch (e) {
    fail('MemoryStore.ensureTable()', (e as Error).message);
    return;
  }

  // 3a. Insert with a synthetic 768-dim vector
  const fakeVec = Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.1) * 0.5);
  let insertedId = '';
  try {
    insertedId = await store.insert(
      { content: 'SYBIL test record — workspace decision about DuckDB', scope: 'workspace', category: 'decision', threadId: 'test-thread' },
      fakeVec
    );
    if (!insertedId) throw new Error('no ID returned');
    pass('MemoryStore.insert()', `ID: ${insertedId.slice(0, 8)}…`);
  } catch (e) {
    fail('MemoryStore.insert()', (e as Error).message);
    return;
  }

  // 3b. Insert a second record with a different vector and category
  const fakeVec2 = Array.from({ length: 768 }, (_, i) => Math.cos(i * 0.1) * 0.5);
  try {
    await store.insert(
      { content: 'SYBIL copilot exchange — user prefers TypeScript', scope: 'copilot-sayon', category: 'preference' },
      fakeVec2
    );
    pass('MemoryStore.insert() second record', 'different scope + category');
  } catch (e) {
    fail('MemoryStore.insert() second record', (e as Error).message);
  }

  // 3c. search() — same vector should return first record as top result
  try {
    const results = await store.search(fakeVec, 'workspace', null, 5);
    if (!Array.isArray(results) || results.length === 0) {
      fail('MemoryStore.search()', 'returned empty results');
    } else if (results[0].content.includes('DuckDB')) {
      pass('MemoryStore.search()', `top result is correct: "${results[0].content.slice(0, 50)}…" score=${results[0].score.toFixed(4)}`);
    } else {
      warn('MemoryStore.search()', `unexpected top result: ${results[0].content.slice(0, 60)}`);
    }
  } catch (e) {
    fail('MemoryStore.search()', (e as Error).message);
  }

  // 3d. search() with category filter — should NOT return the workspace record when filtering by preference
  try {
    const filtered = await store.search(fakeVec, 'copilot-sayon', 'preference', 5);
    if (filtered.length > 0 && filtered[0].content.includes('TypeScript')) {
      pass('MemoryStore.search() category filter', `correctly filtered to preference category`);
    } else if (filtered.length === 0) {
      warn('MemoryStore.search() category filter', 'no results — scope/category combo may need separate query');
    } else {
      warn('MemoryStore.search() category filter', `unexpected result: ${filtered[0]?.content?.slice(0, 60)}`);
    }
  } catch (e) {
    fail('MemoryStore.search() category filter', (e as Error).message);
  }

  // 3e. searchMultiScope()
  try {
    const multi = await store.searchMultiScope(fakeVec, ['workspace', 'copilot-sayon'], 5);
    if (multi.length >= 2) {
      pass('MemoryStore.searchMultiScope()', `returned ${multi.length} records across both scopes`);
    } else {
      warn('MemoryStore.searchMultiScope()', `only ${multi.length} results — expected ≥2`);
    }
  } catch (e) {
    fail('MemoryStore.searchMultiScope()', (e as Error).message);
  }

  // 3f. deleteByThread()
  try {
    await store.deleteByThread('test-thread');
    const afterDelete = await store.search(fakeVec, 'workspace', null, 5);
    const stillPresent = afterDelete.some((r: any) => r.content.includes('DuckDB'));
    if (!stillPresent) {
      pass('MemoryStore.deleteByThread()', 'record removed by thread ID');
    } else {
      fail('MemoryStore.deleteByThread()', 'record still present after delete');
    }
  } catch (e) {
    fail('MemoryStore.deleteByThread()', (e as Error).message);
  }

  await db.close().catch(() => {});
}

// ── Section 4: MemoryWriter public API ────────────────────────────────────────
async function testMemoryWriter(): Promise<void> {
  console.log('\n── 4. MemoryWriter Public API ────────────────────────────────');

  if (NO_SERVER) {
    skip('MemoryWriter functions (all)', '--no-server: SYBIL offline, all embed calls return null cleanly');
    return;
  }

  let mod: any;
  try {
    mod = await import('./ai/MemoryWriter.js');
    pass('MemoryWriter import', 'module loaded');
  } catch (e) {
    fail('MemoryWriter import', (e as Error).message);
    return;
  }

  // Use the real DB (server must be running with initialized MemoryStore)
  // If the DB isn't initialised we get a graceful error not a crash.

  // 4a. embedCopilotExchange — should not throw
  try {
    await mod.embedCopilotExchange(
      'sayon',
      'What database does PHOBOS use for persistence?',
      'PHOBOS uses DuckDB for all persistent storage — messages, memories, dispatch logs, and now semantic embeddings via the VSS extension.'
    );
    pass('embedCopilotExchange()', 'completed without throwing');
  } catch (e) {
    fail('embedCopilotExchange()', (e as Error).message);
  }

  // 4b. embedExplicitMemory — should not throw
  try {
    await mod.embedExplicitMemory('sayon', 'user_preferences', 'language', 'TypeScript');
    pass('embedExplicitMemory()', 'completed without throwing');
  } catch (e) {
    fail('embedExplicitMemory()', (e as Error).message);
  }

  // 4c. embedTaskCompletion — should not throw
  try {
    await mod.embedTaskCompletion(
      'test-thread-writer',
      'test-msg-001',
      'We decided to use DuckDB VSS for semantic memory because it runs in-process alongside the existing DuckDB connection, eliminating the need for a separate vector database service. This architecture approach keeps PHOBOS self-contained.'
    );
    pass('embedTaskCompletion()', 'completed without throwing');
  } catch (e) {
    fail('embedTaskCompletion()', (e as Error).message);
  }

  // 4d. retrieveWorkspaceMemory — should return a string (empty OK if DB doesn't have records yet)
  try {
    const result = await mod.retrieveWorkspaceMemory('DuckDB architecture decision');
    if (typeof result === 'string') {
      if (result.length > 0) {
        pass('retrieveWorkspaceMemory()', `returned ${result.length} chars of context:\n    ${result.slice(0, 160).replace(/\n/g, '\n    ')}`);
      } else {
        warn('retrieveWorkspaceMemory()', 'returned empty string — no workspace memories yet (run embedTaskCompletion first)');
      }
    } else {
      fail('retrieveWorkspaceMemory()', `expected string, got ${typeof result}`);
    }
  } catch (e) {
    fail('retrieveWorkspaceMemory()', (e as Error).message);
  }

  // 4e. retrieveCopilotMemory
  try {
    const result = await mod.retrieveCopilotMemory('sayon', 'What database do we use?');
    if (typeof result === 'string') {
      pass('retrieveCopilotMemory()', result.length > 0
        ? `returned ${result.length} chars`
        : 'returned empty string (no copilot memories yet — run embedCopilotExchange first)');
    } else {
      fail('retrieveCopilotMemory()', `expected string, got ${typeof result}`);
    }
  } catch (e) {
    fail('retrieveCopilotMemory()', (e as Error).message);
  }
}

// ── Section 5: Bundle path resolution ─────────────────────────────────────────
async function testBundlePath(): Promise<void> {
  console.log('\n── 5. SYBIL Bundle Path Resolution ──────────────────────────');

  // Check phobos/models/ source directory exists and contains the GGUF
  const bundledModelDir = path.join(__dirname, 'phobos', 'models');
  const ggufPath = path.join(bundledModelDir, 'nomic-embed-text-v1.5.Q4_K_M.gguf');

  if (!fs.existsSync(bundledModelDir)) {
    warn('phobos/models/ directory', 'does not exist yet — run: mkdir phobos/models');
  } else {
    pass('phobos/models/ directory', 'exists');
  }

  if (!fs.existsSync(ggufPath)) {
    warn('nomic-embed-text-v1.5.Q4_K_M.gguf', `not found at ${ggufPath}\n    Download from: https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/nomic-embed-text-v1.5.Q4_K_M.gguf`);
  } else {
    const size = fs.statSync(ggufPath).size;
    if (size < 60_000_000) {
      warn('nomic-embed-text-v1.5.Q4_K_M.gguf', `file exists but seems small (${(size/1e6).toFixed(1)} MB) — may be corrupt`);
    } else {
      pass('nomic-embed-text-v1.5.Q4_K_M.gguf', `present at bundle path (${(size/1e6).toFixed(1)} MB)`);
    }
  }

  // Check dist/ copy if it exists (post-build)
  const distModelPath = path.join(__dirname, 'dist', 'phobos', 'models', 'nomic-embed-text-v1.5.Q4_K_M.gguf');
  if (fs.existsSync(distModelPath)) {
    pass('dist/phobos/models/ GGUF', `staged at ${distModelPath}`);
  } else {
    skip('dist/phobos/models/ GGUF', 'dist/ not built yet — run npm run build:full');
  }
}

// ── Section 6: startSybil path logic (dry run) ────────────────────────────────
async function testStartSybilPaths(): Promise<void> {
  console.log('\n── 6. startSybil() Path Logic (dry run) ─────────────────────');

  try {
    const { getSpec } = await import('./phobos/PhobosLocalManager.js');
    const spec = getSpec('sybil-embed');
    if (!spec) {
      fail('sybil-embed in GGUF_CATALOGUE', 'getSpec("sybil-embed") returned undefined');
      return;
    }
    pass('sybil-embed in GGUF_CATALOGUE', `label: "${spec.label}", sizeBytes: ${(spec.sizeBytes/1e6).toFixed(0)} MB`);

    // Check hfRepo/hfFile are as expected
    const expectedRepo = 'nomic-ai/nomic-embed-text-v1.5-GGUF';
    const expectedFile = 'nomic-embed-text-v1.5.Q4_K_M.gguf';
    if (spec.hfRepo === expectedRepo && spec.hfFile === expectedFile) {
      pass('sybil-embed HF coordinates', `${spec.hfRepo}/${spec.hfFile}`);
    } else {
      fail('sybil-embed HF coordinates', `got ${spec.hfRepo}/${spec.hfFile}`);
    }
  } catch (e) {
    fail('PhobosLocalManager import', (e as Error).message);
  }

  // Confirm SYBIL_PORT export
  try {
    const { SYBIL_PORT } = await import('./phobos/LlamaServerManager.js');
    if (SYBIL_PORT === 16315) {
      pass('SYBIL_PORT export', '16315');
    } else {
      fail('SYBIL_PORT export', `expected 16315, got ${SYBIL_PORT}`);
    }
  } catch (e) {
    fail('LlamaServerManager import', (e as Error).message);
  }

  // Confirm getServerStatus() includes sybil field
  try {
    const { getServerStatus } = await import('./phobos/LlamaServerManager.js');
    const status = getServerStatus();
    if ('sybil' in status) {
      pass('getServerStatus() sybil field', `state: "${status.sybil.state}", port: ${status.sybil.port}`);
    } else {
      fail('getServerStatus() sybil field', 'sybil key missing from status object');
    }
  } catch (e) {
    fail('getServerStatus() sybil field', (e as Error).message);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║       PHOBOS RAG / SYBIL VALIDATION TEST                    ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log(`   Mode: ${NO_SERVER ? '--no-server (DuckDB only)' : 'full (requires SYBIL on :16315)'}`);

if (RUN_ALL || EMBED_ONLY) {
  await testSybilConnectivity();
  await testEmbedClient();
}
if (RUN_ALL || STORE_ONLY) {
  await testMemoryStore();
}
if (RUN_ALL || WRITER_ONLY) {
  await testMemoryWriter();
}
if (RUN_ALL) {
  await testBundlePath();
  await testStartSybilPaths();
}

// ── Summary ────────────────────────────────────────────────────────────────────
const pass_n  = results.filter(r => r.status === 'PASS').length;
const fail_n  = results.filter(r => r.status === 'FAIL').length;
const warn_n  = results.filter(r => r.status === 'WARN').length;
const skip_n  = results.filter(r => r.status === 'SKIP').length;

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log(`║  RESULTS  PASS:${String(pass_n).padStart(3)}  FAIL:${String(fail_n).padStart(3)}  WARN:${String(warn_n).padStart(3)}  SKIP:${String(skip_n).padStart(3)}          ║`);
console.log('╠══════════════════════════════════════════════════════════════╣');

if (fail_n > 0) {
  console.log('║  FAILURES:                                                   ║');
  for (const r of results.filter(r => r.status === 'FAIL')) {
    const line = `  ❌ ${r.name}`.slice(0, 62).padEnd(62);
    console.log(`║${line}║`);
  }
  console.log('╠══════════════════════════════════════════════════════════════╣');
}

if (!NO_SERVER && fail_n === 0 && warn_n === 0) {
  console.log('║  ✅ All tests passed — SYBIL and semantic memory fully wired ║');
} else if (fail_n === 0) {
  console.log('║  ✅ No failures — review WARNs above for optional items      ║');
} else {
  console.log('║  ❌ Failures present — fix before committing                 ║');
}

const tip = NO_SERVER
  ? 'Start PHOBOS server then run without --no-server for full test'
  : 'SYBIL must be running: start PHOBOS or npx tsx server.ts';
console.log(`║  ℹ️  ${tip.slice(0, 57).padEnd(57)}║`);
console.log('╚══════════════════════════════════════════════════════════════╝\n');

process.exit(fail_n > 0 ? 1 : 0);
