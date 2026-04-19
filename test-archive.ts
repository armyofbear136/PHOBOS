/**
 * test-archive.ts — PHOBOS Archive end-to-end test
 *
 * Starts SYBIL itself — PHOBOS core does NOT need to be running.
 * Reads documents from ./test-outputs/extractor/ (or creates a synthetic file).
 *
 * Usage:
 *   npx tsx test-archive.ts             — normal run
 *   npx tsx test-archive.ts --verbose   — show chunk previews and XML output
 *   npx tsx test-archive.ts --keep      — don't delete test DB on exit
 *   npx tsx test-archive.ts --no-sybil  — skip embedding tests (schema/classifier only)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── CLI flags ─────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const VERBOSE   = args.includes('--verbose');
const KEEP      = args.includes('--keep');
const NO_SYBIL  = args.includes('--no-sybil');

// ── Result tracking ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let warned = 0;

function pass(label: string, detail = '') {
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  passed++;
}

function fail(label: string, detail = '') {
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  failed++;
}

function warn(label: string, detail = '') {
  console.warn(`  ⚠ ${label}${detail ? ` — ${detail}` : ''}`);
  warned++;
}

function section(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 54 - title.length))}`);
}

// ── Supported extensions ──────────────────────────────────────────────────────

const SUPPORTED_EXT = new Set([
  '.md', '.txt', '.pdf', '.html', '.htm',
  '.py', '.ts', '.js', '.json', '.rs',
  '.docx', '.csv', '.xlsx', '.epub',
]);

function findTestFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => SUPPORTED_EXT.has(path.extname(f).toLowerCase()))
    .map(f => path.join(dir, f));
}

// ── SYBIL management ──────────────────────────────────────────────────────────

/** Poll the embed endpoint until it returns a valid vector or we time out. */
async function waitForSybilReady(timeoutMs = 30_000): Promise<boolean> {
  const { embed } = await import('./ai/EmbedClient.js');
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const vec = await embed('warmup').catch(() => null);
    if (vec !== null && vec.length === 768) return true;
    // Exponential backoff: 200ms, 400ms, 800ms, then 1s intervals
    const delay = Math.min(200 * Math.pow(2, attempt - 1), 1_000);
    await new Promise(r => setTimeout(r, delay));
  }
  return false;
}

async function startSybilForTest(): Promise<boolean> {
  console.log('  Starting SYBIL (nomic-embed-text-v1.5)…');
  console.log(`  Searching in: ${path.join(process.cwd(), 'dist', 'phobos', 'models')}`);
  console.log('  This may take 10–30 seconds on first load.');
  try {
    const { startSybil, getServerStatus } = await import('./phobos/LlamaServerManager.js');
    await startSybil();

    // waitForPort (inside startSybil) confirms TCP connection, but the model
    // may still be loading into memory. Poll the actual /embedding endpoint
    // until it returns a valid vector before proceeding with any tests.
    process.stdout.write('  Waiting for embedding endpoint to warm up');
    const ready = await waitForSybilReady(45_000);
    process.stdout.write('\n');


    const status = getServerStatus();
    if (ready && status.sybil.state === 'running') {
      pass('SYBIL started and ready', `port=${status.sybil.port}`);
      return true;
    } else {
      warn('SYBIL did not become ready', `state=${status.sybil.state}, error=${status.sybil.error ?? 'none'}`);
      console.log('');
      console.log('  Model not found. Ensure it is in one of:');
      console.log(`    ${path.join(process.cwd(), 'dist', 'phobos', 'models', 'nomic-embed-text-v1.5.Q4_K_M.gguf')}`);
      console.log(`    ${path.join(process.env.HOME ?? process.env.USERPROFILE ?? '~', '.phobos', 'models', 'nomic-embed-text-v1.5.Q4_K_M.gguf')}`);
      console.log('  Or download it: node scripts/fetch-sybil-model.js');
      console.log('');
      return false;
    }
  } catch (err) {
    fail('SYBIL startup threw', (err as Error).message);
    return false;
  }
}

async function stopSybilAfterTest(): Promise<void> {
  try {
    const { stopServer } = await import('./phobos/LlamaServerManager.js');
    await stopServer('sybil');
    console.log('  SYBIL stopped.');
  } catch { /* non-fatal */ }
}

async function checkSybilAlreadyRunning(): Promise<boolean> {
  const { embed } = await import('./ai/EmbedClient.js');
  // Try twice — first attempt may fail if the server is mid-request
  for (let i = 0; i < 2; i++) {
    const vec = await embed('readiness-check').catch(() => null);
    if (vec !== null && vec.length === 768) return true;
    if (i === 0) await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║           PHOBOS ARCHIVE — END-TO-END TEST             ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`\n  Archive dir: ${path.join(process.env.HOME ?? process.env.USERPROFILE ?? '~', '.phobos', 'archive')}`);

  const TEST_DOMAIN = `custom-test-${Date.now()}` as const;
  const INPUT_DIR   = path.join(__dirname, 'test-outputs', 'extractor');

  // ── 1. SYBIL ─────────────────────────────────────────────────────────────
  section('1. SYBIL Embedding Server');
  let sybilOk = false;

  if (NO_SYBIL) {
    warn('--no-sybil flag set — embedding tests skipped');
  } else {
    // Check if SYBIL is already running from a previous server.ts instance
    const alreadyUp = await checkSybilAlreadyRunning().catch(() => false);
    if (alreadyUp) {
      pass('SYBIL already running', '768-dim vector confirmed');
      sybilOk = true;
    } else {
      sybilOk = await startSybilForTest();
    }
  }

  // ── 2. Domain creation ────────────────────────────────────────────────────
  section('2. Domain Creation');
  const { ArchiveStore, ARCHIVE_DIR } = await import('./db/ArchiveStore.js');
  console.log(`  ARCHIVE_DIR: ${ARCHIVE_DIR}`);

  try {
    await ArchiveStore.ensureDomain(TEST_DOMAIN as import('./db/ArchiveStore.js').ArchiveDomain);
    pass('ensureDomain()', `created ${TEST_DOMAIN}`);
  } catch (err) {
    fail('ensureDomain()', (err as Error).message);
  }

  try {
    const domains = await ArchiveStore.listDomains();
    const found   = domains.find(d => d.domain === TEST_DOMAIN);
    found
      ? pass('listDomains()', `domain visible, ${found.chunkCount} chunks`)
      : fail('listDomains()', 'test domain not in list');
  } catch (err) {
    fail('listDomains()', (err as Error).message);
  }

  // ── 3. hasAnyContent() ────────────────────────────────────────────────────
  section('3. hasAnyContent()');
  try {
    ArchiveStore.hasAnyContent()
      ? pass('hasAnyContent() → true after domain creation')
      : warn('hasAnyContent() → false (unexpected)');
  } catch (err) {
    fail('hasAnyContent()', (err as Error).message);
  }

  // ── 4. Intent classifier (no SYBIL needed) ────────────────────────────────
  section('4. ArchiveIntentClassifier');
  const { ArchiveIntentClassifier } = await import('./ai/ArchiveIntentClassifier.js');
  const classifier = new ArchiveIntentClassifier();

  const classifierCases: Array<{ msg: string; expectArchive: boolean }> = [
    { msg: 'how does the DuckDB HNSW index work in the reference docs?', expectArchive: true },
    { msg: 'what does the research paper say about embedding models?',    expectArchive: true },
    { msg: 'what is the project architecture?',                           expectArchive: true },
    { msg: 'hi',                                                          expectArchive: false },
    { msg: 'generate an image of a sunset',                              expectArchive: false },
  ];

  for (const t of classifierCases) {
    try {
      const decision = await classifier.classify({
        userMessage: t.msg, hasActiveProject: true,
        pinnedDomains: [], isCopilot: false,
      });
      const short = t.msg.slice(0, 48).padEnd(48);
      decision.useArchive === t.expectArchive
        ? pass(`classify("${short}")`, `domains=[${decision.domains.join(',')}]`)
        : fail(`classify("${short}")`, `expected useArchive=${t.expectArchive}, got ${decision.useArchive}`);
    } catch (err) {
      fail('classify()', (err as Error).message);
    }
  }

  // ── 5. Test file discovery ────────────────────────────────────────────────
  section('5. Test File Discovery');
  let testFiles = findTestFiles(INPUT_DIR);

  if (testFiles.length === 0) {
    fs.mkdirSync(INPUT_DIR, { recursive: true });
    const syntheticPath = path.join(INPUT_DIR, 'synthetic-test.md');
    fs.writeFileSync(syntheticPath, SYNTHETIC_DOC);
    warn('No files found — created synthetic test file', syntheticPath);
    testFiles = [syntheticPath];
  } else {
    pass(`Found ${testFiles.length} test file(s)`, testFiles.map(f => path.basename(f)).join(', '));
  }

  // ── 6. Ingestion (requires SYBIL) ─────────────────────────────────────────
  section('6. Ingestion Pipeline');

  if (!sybilOk) {
    warn('Skipping ingestion — SYBIL not running');
    summarize();
    await cleanup(TEST_DOMAIN as import('./db/ArchiveStore.js').ArchiveDomain, ArchiveStore);
    return;
  }

  const { ingestSource } = await import('./ai/ArchiveIngestor.js');

  let totalChunks = 0;

  for (const filePath of testFiles) {
    const basename = path.basename(filePath);
    try {
      let chunkCount = 0;
      const sourceId = await ingestSource(
        TEST_DOMAIN as import('./db/ArchiveStore.js').ArchiveDomain,
        filePath,
        'file',
        (evt) => {
          if (evt.status === 'done')  { chunkCount = evt.total; }
          if (evt.status === 'error') { throw new Error(evt.error ?? 'ingest error'); }
          if (VERBOSE) {
            process.stdout.write(`\r    ${basename}: ${evt.pct}% (${evt.current}/${evt.total})`);
          }
        },
      );
      if (VERBOSE) process.stdout.write('\n');

      if (chunkCount > 0) {
        pass(`Ingest: ${basename}`, `${chunkCount} chunks · id=${sourceId.slice(0, 8)}…`);
        totalChunks += chunkCount;
      } else {
        warn(`Ingest: ${basename}`, 'zero chunks — no extractable text');
      }
    } catch (err) {
      fail(`Ingest: ${basename}`, (err as Error).message);
    }
  }

  if (totalChunks === 0) {
    fail('No chunks written — cannot test retrieval');
    summarize();
    await cleanup(TEST_DOMAIN as import('./db/ArchiveStore.js').ArchiveDomain, ArchiveStore);
    return;
  }

  // ── 7. Source listing ─────────────────────────────────────────────────────
  section('7. Source Listing');
  try {
    const sources = await ArchiveStore.listSources(TEST_DOMAIN as import('./db/ArchiveStore.js').ArchiveDomain);
    sources.length === testFiles.length
      ? pass('listSources()', `${sources.length} sources`)
      : warn('listSources()', `expected ${testFiles.length}, got ${sources.length}`);
    if (VERBOSE) {
      for (const s of sources) {
        console.log(`    • ${s.sourceTitle ?? s.sourcePath}  (${s.chunkCount} chunks)`);
      }
    }
  } catch (err) {
    fail('listSources()', (err as Error).message);
  }

  // ── 8. Semantic search ────────────────────────────────────────────────────
  section('8. Semantic Search (HNSW)');
  const { embed } = await import('./ai/EmbedClient.js');

  const QUERIES = [
    'knowledge retrieval and embedding vectors',
    'PHOBOS archive system design',
    'database indexing',
  ];

  for (const query of QUERIES) {
    try {
      const vec     = await embed(query);
      if (!vec) { warn(`embed("${query}")`, 'null vector'); continue; }
      const results = await ArchiveStore.semanticSearch(
        TEST_DOMAIN as import('./db/ArchiveStore.js').ArchiveDomain,
        vec, 5, 0.25,   // low floor — synthetic doc may not be super similar
      );
      if (results.length > 0) {
        pass(
          `semanticSearch("${query.slice(0, 36)}…")`,
          `${results.length} results, top score=${results[0].score.toFixed(3)}`,
        );
        if (VERBOSE) {
          console.log(`    "${results[0].chunkText.slice(0, 80).replace(/\n/g, ' ')}…"`);
        }
      } else {
        warn(`semanticSearch("${query}")`, 'no results above 0.25 — try --verbose');
      }
    } catch (err) {
      fail(`semanticSearch("${query}")`, (err as Error).message);
    }
  }

  // ── 9. Hybrid search (ArchiveClient) ─────────────────────────────────────
  section('9. Hybrid Search (ArchiveClient.searchRaw)');
  const { searchRaw } = await import('./ai/ArchiveClient.js');

  for (const query of QUERIES.slice(0, 2)) {
    try {
      const results = await searchRaw({
        query, domains: [TEST_DOMAIN as import('./db/ArchiveStore.js').ArchiveDomain],
        k: 5, minScore: 0.25,
      });
      results.length > 0
        ? pass(`searchRaw("${query.slice(0, 36)}…")`, `${results.length} results, top=${results[0].score.toFixed(3)}`)
        : warn(`searchRaw("${query}")`, 'no results');
    } catch (err) {
      fail(`searchRaw("${query}")`, (err as Error).message);
    }
  }

  // ── 10. XML context format ────────────────────────────────────────────────
  section('10. XML Context Formatter');
  const { search: archiveSearch } = await import('./ai/ArchiveClient.js');

  try {
    const xml = await archiveSearch({
      query:   'PHOBOS archive knowledge base',
      domains: [TEST_DOMAIN as import('./db/ArchiveStore.js').ArchiveDomain],
      k: 3, minScore: 0.25,
    });
    if (xml.includes('<archive_context>') && xml.includes('</archive_context>')) {
      pass('search() returns valid <archive_context> XML');
      if (VERBOSE) {
        console.log('\n    XML preview:');
        xml.split('\n').slice(0, 10).forEach(l => console.log(`    ${l}`));
      }
    } else if (xml === '') {
      warn('search() returned empty string', 'no results above threshold');
    } else {
      fail('search() returned malformed XML', xml.slice(0, 100));
    }
  } catch (err) {
    fail('search() XML formatter', (err as Error).message);
  }

  // ── 11. Source deletion ───────────────────────────────────────────────────
  section('11. Source Deletion');
  try {
    const sources = await ArchiveStore.listSources(TEST_DOMAIN as import('./db/ArchiveStore.js').ArchiveDomain);
    const first   = sources[0];
    if (first) {
      await ArchiveStore.deleteSourceById(
        TEST_DOMAIN as import('./db/ArchiveStore.js').ArchiveDomain, first.id,
      );
      const after = await ArchiveStore.listSources(TEST_DOMAIN as import('./db/ArchiveStore.js').ArchiveDomain);
      after.length === sources.length - 1
        ? pass('deleteSourceById()', `removed "${first.sourceTitle ?? first.sourcePath}"`)
        : fail('deleteSourceById()', `count: ${sources.length} → ${after.length}`);
    } else {
      warn('deleteSourceById()', 'no sources to test deletion');
    }
  } catch (err) {
    fail('deleteSourceById()', (err as Error).message);
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  summarize();
  await stopSybilAfterTest();
  await cleanup(TEST_DOMAIN as import('./db/ArchiveStore.js').ArchiveDomain, ArchiveStore);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function summarize() {
  const exit = failed > 0 ? 1 : 0;
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log(`║  ${passed} passed · ${failed} failed · ${warned} warnings`.padEnd(57) + '  ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');
  if (exit) process.exitCode = 1;
}

async function cleanup(
  domain: import('./db/ArchiveStore.js').ArchiveDomain,
  store:  typeof import('./db/ArchiveStore.js').ArchiveStore,
) {
  if (KEEP) {
    console.log(`  --keep: domain retained: ${domain}\n`);
    return;
  }
  try {
    await store.deleteDomain(domain);
    console.log('  Test domain cleaned up.\n');
  } catch (err) {
    // Windows sometimes needs an extra moment after SYBIL stops for DuckDB to 
    // release all file handles. Retry once with a longer delay.
    await new Promise(r => setTimeout(r, 1_000));
    try {
      await store.deleteDomain(domain);
      console.log('  Test domain cleaned up (after retry).\n');
    } catch (err2) {
      console.warn(`  Cleanup failed: ${(err2 as Error).message}`);
      console.warn('  Delete manually: DELETE /api/archive/domains/' + domain + '\n');
    }
  }
}

const SYNTHETIC_DOC = `# PHOBOS Archive Test Document

## Overview

This document tests the PHOBOS Archive ingestion and retrieval pipeline.
The Archive uses DuckDB with HNSW vector indexing for semantic search.

## SYBIL Embedding

SYBIL runs nomic-embed-text-v1.5 as a local embedding model. It accepts text
via an HTTP /embedding endpoint and returns 768-dimensional float vectors.
These vectors are stored in DuckDB FLOAT[768] columns indexed with HNSW.

## Chunking Strategy

Documents are split on Markdown heading boundaries, then on paragraph
boundaries. Chunks target 512 tokens (~2000 characters). Each chunk receives
a breadcrumb prefix showing its position in the document hierarchy.

## Hybrid Search

Retrieval combines semantic search (HNSW cosine similarity) with full-text
search (BM25 via the DuckDB FTS extension). Results are merged and re-ranked.
A chunk appearing in both result sets receives a score bonus.

## Knowledge Domains

The Archive organises knowledge into domains: personal, projects, reference,
research, science, literature, media, history, legal, finance, and phobos.
Each domain is an independent DuckDB file with its own HNSW index.

## Context Injection

Retrieved chunks are formatted as XML and injected into the Complete Context
before SEREN receives it. The XML block is tagged as <archive_context> to
distinguish it from <prior_memory> (session-derived workspace memory).
`;

// ── Entry point ───────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
