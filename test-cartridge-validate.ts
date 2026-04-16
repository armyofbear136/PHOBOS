/**
 * PHOBOS LLM Cartridge System — Standalone End-to-End Validation
 *
 * Runs entirely without the PHOBOS server. All operations go directly through
 * CartridgeStore and CartridgeManager — the same code paths the routes call.
 *
 * Training pipeline simulation:
 *   Place .txt / .md documents in ./test-outputs/cartridges/training/
 *   Section 13 reads them, builds a manifest derived from their content,
 *   packages a cartridge, installs it, mutates it, and validates reload.
 *
 * Run: npx tsx test-cartridge-validate.ts
 */

import { CartridgeStore }   from './db/CartridgeStore.js';
import { CartridgeManager } from './phobos/CartridgeManager.js';
import { DatabaseManager }  from './db/DatabaseManager.js';
import type { CartridgeManifest } from './phobos/CartridgeTypes.js';
import { PHOBOS_DEFAULT_CART_PASSWORD } from './phobos/CartridgeTypes.js';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import AdmZip    from 'adm-zip';

// ── Paths ─────────────────────────────────────────────────────────────────────

const TRAINING_INPUT_DIR = path.resolve('./test-outputs/cartridges/training');
const TEST_DB_PATH       = path.join(os.tmpdir(), `phobos-test-${Date.now()}.duckdb`);

// ── Result counters ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label: string, value: unknown = true): void {
  if (value) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

function fail(label: string): void {
  console.error(`  ❌ FAIL: ${label}`);
  failed++;
}

function section(title: string): void {
  console.log(`\n─── ${title}`);
}

// ── Minimal valid GGUF buffer ─────────────────────────────────────────────────

function makeGgufBuffer(sizeBytes = 512): Buffer {
  const buf = Buffer.alloc(sizeBytes, 0xab);
  buf.write('GGUF', 0, 'ascii');
  buf.writeUInt32LE(3, 4);
  buf.writeBigUInt64LE(0n, 8);
  buf.writeBigUInt64LE(0n, 16);
  return buf;
}

// ── Manifest factory ──────────────────────────────────────────────────────────

function makeManifest(overrides: Partial<CartridgeManifest> = {}): CartridgeManifest {
  return {
    schemaVersion:     1,
    id:                'test-validate-v1',
    name:              'Validation Cartridge',
    author:            'phobos-test',
    version:           '0.1.0',
    description:       'Automated validation cartridge',
    baseModel:         'Gemma 4',
    compatibleModels:  ['*'],
    targetPersona:     'seren',
    rank:              16,
    category:          'expertise',
    tags:              ['test'],
    behaviorSummary:   'Test cartridge for automated validation',
    triggerContext:    null,
    trainingDocuments: 0,
    trainingTurns:     0,
    trainingSteps:     50,
    recommendedWeight: 0.8,
    weightRange:       [0.3, 1.0],
    license:           'personal',
    createdAt:         new Date().toISOString(),
    halcyonId:         null,
    ...overrides,
  };
}

// ── Temp file helpers ─────────────────────────────────────────────────────────

const tempFiles: string[] = [];

function writeTempGguf(name: string, buf: Buffer): string {
  const p = path.join(os.tmpdir(), name);
  fs.writeFileSync(p, buf);
  tempFiles.push(p);
  return p;
}

function cleanupTempFiles(): void {
  for (const p of tempFiles) {
    try { fs.unlinkSync(p); } catch { /* non-fatal */ }
  }
}

// ── Training pipeline simulation ──────────────────────────────────────────────

/**
 * Reads all .txt and .md files from TRAINING_INPUT_DIR.
 * Returns { docCount, wordCount, sampleTexts }.
 * If the directory does not exist or is empty, returns synthetic defaults
 * so the test still exercises the packaging pipeline.
 */
function readTrainingInputs(): {
  docCount:    number;
  wordCount:   number;
  sampleTexts: Array<{ name: string; data: Buffer }>;
} {
  const sampleTexts: Array<{ name: string; data: Buffer }> = [];
  let docCount  = 0;
  let wordCount = 0;

  if (fs.existsSync(TRAINING_INPUT_DIR)) {
    const entries = fs.readdirSync(TRAINING_INPUT_DIR);
    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase();
      if (ext !== '.txt' && ext !== '.md') continue;
      const fullPath = path.join(TRAINING_INPUT_DIR, entry);
      const content  = fs.readFileSync(fullPath, 'utf-8');
      docCount++;
      wordCount += content.split(/\s+/).filter(Boolean).length;
      if (sampleTexts.length < 6) {
        // Truncate to 500 chars for the sample slot.
        const preview = content.slice(0, 500);
        sampleTexts.push({
          name: `samples/0${sampleTexts.length + 1}.txt`,
          data: Buffer.from(preview, 'utf-8'),
        });
      }
    }
  }

  if (docCount === 0) {
    console.log(`  ℹ️  No training documents found in ${TRAINING_INPUT_DIR} — using synthetic data`);
    // Synthetic: 3 documents, enough to exercise the packaging path.
    for (let i = 1; i <= 3; i++) {
      const text = `Synthetic training document ${i}.\n`.repeat(40);
      docCount++;
      wordCount += text.split(/\s+/).filter(Boolean).length;
      sampleTexts.push({ name: `samples/0${i}.txt`, data: Buffer.from(text, 'utf-8') });
    }
  }

  return { docCount, wordCount, sampleTexts };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔬  PHOBOS Cartridge System — Standalone Validation\n');
  console.log(`    DB  : ${TEST_DB_PATH}`);
  console.log(`    Docs: ${TRAINING_INPUT_DIR}`);

  // Initialise shared DB + store for the whole run.
  const db      = DatabaseManager.getInstance(TEST_DB_PATH);
  await db.initialize();
  const store   = new CartridgeStore(db);
  const manager = CartridgeManager.getInstance();
  manager.initCartridgeManager(store);

  // Track installed IDs for teardown.
  let unprotectedId = '';
  let protectedId   = '';
  let rawId         = '';
  let trainedId     = '';

  // ── Section 1: DB table init ───────────────────────────────────────────────
  section('Section 1: DB table init');
  try {
    await store.ensureTable();
    const rows = await db.query<{ persona: string }>('SELECT persona FROM cartridge_slots ORDER BY persona');
    ok('cartridges table created');
    ok('cartridge_slots seeded with 2 rows', rows.length === 2);
    ok('sayon slot present', rows.some(r => r.persona === 'sayon'));
    ok('seren slot present', rows.some(r => r.persona === 'seren'));
  } catch (err) {
    fail(`DB init: ${(err as Error).message}`);
  }

  // ── Section 2: Install unprotected cartridge ───────────────────────────────
  section('Section 2: Install unprotected cartridge (default password)');
  try {
    const loraBytes = makeGgufBuffer();
    const manifest  = makeManifest({ id: 'test-unprotected-v1', name: 'Test Unprotected' });
    const archiveBuf = CartridgeStore.buildArchive(manifest, loraBytes, PHOBOS_DEFAULT_CART_PASSWORD);

    const record = await store.installCartridgeArchive(archiveBuf);
    unprotectedId = record.id;

    ok('record id returned', !!record.id);
    ok('name matches', record.name === 'Test Unprotected');
    ok('kind = cartridge', record.kind === 'cartridge');
    ok('is_protected = false', record.is_protected === false);
    ok('lora.gguf written to disk', fs.existsSync(record.lora_path));
    ok('install dir exists', fs.existsSync(record.install_path));
    ok('archive kept on disk', fs.existsSync(path.join(record.install_path, 'cartridge-archive.cartridge')));
  } catch (err) {
    fail(`Section 2: ${(err as Error).message}`);
  }

  // ── Section 3: Install password-protected cartridge ────────────────────────
  section('Section 3: Install password-protected cartridge');
  try {
    const loraBytes  = makeGgufBuffer();
    const manifest   = makeManifest({ id: 'test-protected-v1', name: 'Test Protected' });
    const archiveBuf = CartridgeStore.buildArchive(manifest, loraBytes, 'supersecret123');

    const record = await store.installCartridgeArchive(archiveBuf);
    protectedId = record.id;

    ok('record id returned', !!record.id);
    ok('is_protected = true', record.is_protected === true);
    ok('lora.gguf on disk', fs.existsSync(record.lora_path));
  } catch (err) {
    fail(`Section 3: ${(err as Error).message}`);
  }

  // ── Section 4: Install raw .gguf ───────────────────────────────────────────
  section('Section 4: Install raw .gguf');
  try {
    const loraBytes = makeGgufBuffer();
    const record    = await store.installRawLora(loraBytes, 'my-raw-lora.gguf');
    rawId = record.id;

    ok('record id returned', !!record.id);
    ok('kind = raw_lora', record.kind === 'raw_lora');
    ok('is_protected = false', record.is_protected === false);
    ok('file on disk', fs.existsSync(record.lora_path));
  } catch (err) {
    fail(`Section 4: ${(err as Error).message}`);
  }

  // ── Section 5: List ────────────────────────────────────────────────────────
  section('Section 5: List');
  try {
    const list = await store.list();
    ok('returns array', Array.isArray(list));
    ok('at least 3 entries', list.length >= 3);
    // compatible_models is stored as JSON string in DB — verify it round-trips.
    const entry = list[0];
    ok('compatible_models is JSON string', typeof entry.compatible_models === 'string');
    const parsed = JSON.parse(entry.compatible_models);
    ok('compatible_models parses to array', Array.isArray(parsed));
  } catch (err) {
    fail(`Section 5: ${(err as Error).message}`);
  }

  // ── Section 6: Slot management ─────────────────────────────────────────────
  section('Section 6: Slot management');
  try {
    // Slot should start empty.
    const emptySlot = await store.getActiveSlot('seren');
    ok('slot starts empty', emptySlot.cartridgeId === null);

    // Set a slot directly (manager.activate requires a running server for restart).
    if (unprotectedId) {
      await store.setActiveSlot('seren', unprotectedId, 0.8);
      const filled = await store.getActiveSlot('seren');
      ok('slot reflects cartridgeId', filled.cartridgeId === unprotectedId);
      ok('weight stored', filled.weight === 0.8);
    }

    // Clear it.
    await store.clearActiveSlot('seren');
    const cleared = await store.getActiveSlot('seren');
    ok('slot clears to null', cleared.cartridgeId === null);
  } catch (err) {
    fail(`Section 6: ${(err as Error).message}`);
  }

  // ── Section 7: Compatibility check ────────────────────────────────────────
  section('Section 7: Compatibility check — no model running');
  try {
    if (unprotectedId) {
      const record = await store.get(unprotectedId);
      if (!record) throw new Error('record not found');

      // With no model running, manager returns { compatible: true } (deferred check per spec §3.2).
      const result = await manager.checkCompatibility(record.id, 'seren');
      ok('result has compatible field', 'compatible' in result);
      ok('compatible = true (deferred — no model)', result.compatible === true);
      console.log(`  ℹ️  Result: ${JSON.stringify(result)}`);
    }
  } catch (err) {
    fail(`Section 7: ${(err as Error).message}`);
  }

  // ── Section 8: Auth — default password always unlocks ─────────────────────
  section('Section 8: Auth — unprotected cartridge auto-unlocks');
  try {
    if (unprotectedId) {
      const record      = await store.get(unprotectedId);
      const archivePath = path.join(record!.install_path, 'cartridge-archive.cartridge');
      const result      = store.checkAuth(archivePath, { password: PHOBOS_DEFAULT_CART_PASSWORD });
      ok('ok = true', result.ok === true);
      ok("via = 'default'", result.ok && result.via === 'default');
    }
  } catch (err) {
    fail(`Section 8: ${(err as Error).message}`);
  }

  // ── Section 9: Auth — wrong password rejected ──────────────────────────────
  section('Section 9: Auth — wrong password rejected');
  try {
    if (protectedId) {
      const record      = await store.get(protectedId);
      const archivePath = path.join(record!.install_path, 'cartridge-archive.cartridge');
      const result      = store.checkAuth(archivePath, { password: 'wrongpassword' });
      ok('ok = false', result.ok === false);
      ok("reason = 'wrong_password'", !result.ok && result.reason === 'wrong_password');
    }
  } catch (err) {
    fail(`Section 9: ${(err as Error).message}`);
  }

  // ── Section 10: Auth — correct password accepted ───────────────────────────
  section('Section 10: Auth — correct password accepted');
  try {
    if (protectedId) {
      const record      = await store.get(protectedId);
      const archivePath = path.join(record!.install_path, 'cartridge-archive.cartridge');
      const result      = store.checkAuth(archivePath, { password: 'supersecret123' });
      ok('ok = true', result.ok === true);
      ok("via = 'password'", result.ok && result.via === 'password');
    }
  } catch (err) {
    fail(`Section 10: ${(err as Error).message}`);
  }

  // ── Section 11: Tampered archive rejected ─────────────────────────────────
  section('Section 11: Tampered archive rejected (lora_hmac mismatch)');
  try {
    const loraBytes  = makeGgufBuffer();
    const manifest   = makeManifest({ id: 'test-tampered-v1' });
    const validBuf   = CartridgeStore.buildArchive(manifest, loraBytes);

    // Flip a byte in lora.gguf inside the archive.
    const zip  = new AdmZip(validBuf);
    const le   = zip.getEntry('lora.gguf')!;
    const data = le.getData();
    data[100] ^= 0xff;
    zip.deleteFile('lora.gguf');
    zip.addFile('lora.gguf', data);
    const tamperedBuf = zip.toBuffer();

    let threw = false;
    let message = '';
    try {
      await store.installCartridgeArchive(tamperedBuf);
    } catch (e) {
      threw   = true;
      message = (e as Error).message;
    }
    ok('install throws on tampered archive', threw);
    ok('error mentions HMAC', message.toLowerCase().includes('hmac'));
  } catch (err) {
    fail(`Section 11: ${(err as Error).message}`);
  }

  // ── Section 12: Missing lora.gguf rejected ────────────────────────────────
  section('Section 12: Missing lora.gguf rejected');
  try {
    const manifest = makeManifest({ id: 'test-no-gguf-v1' });
    const zip      = new AdmZip();
    zip.addFile('cartridge.json', Buffer.from(JSON.stringify(manifest), 'utf-8'));
    zip.addFile('sig.json',       Buffer.from('{"hmac":"fake"}', 'utf-8'));
    // Deliberately no lora.gguf.

    let threw = false;
    let message = '';
    try {
      await store.installCartridgeArchive(zip.toBuffer());
    } catch (e) {
      threw   = true;
      message = (e as Error).message;
    }
    ok('install throws when lora.gguf missing', threw);
    ok('error mentions lora.gguf', message.toLowerCase().includes('lora.gguf'));
  } catch (err) {
    fail(`Section 12: ${(err as Error).message}`);
  }

  // ── Section 13: Training pipeline simulation ───────────────────────────────
  section('Section 13: Training pipeline — read docs, build cartridge, modify, reload');
  try {
    // Ensure the training input dir exists (create it if the user hasn't yet).
    fs.mkdirSync(TRAINING_INPUT_DIR, { recursive: true });
    const { docCount, wordCount, sampleTexts } = readTrainingInputs();
    console.log(`  ℹ️  Loaded ${docCount} document(s), ${wordCount} words`);

    // Synthetic training step formula from spec §4.3.
    const datasetPairs = Math.max(docCount * 4, 10);  // ~4 pairs per doc
    const repeats      = Math.max(1, Math.floor(500 / datasetPairs));
    const rawSteps     = datasetPairs * repeats * 80;
    const trainingSteps = Math.min(8000, Math.max(500, rawSteps));

    const manifest = makeManifest({
      id:                'test-trained-v1',
      name:              'Training Pipeline Cartridge',
      trainingDocuments: docCount,
      trainingTurns:     0,
      trainingSteps:     trainingSteps,
      triggerContext:    'You have deep expertise in the training documents provided.',
      tags:              ['trained', 'test'],
    });

    // Simulate a post-training lora.gguf — real trainer writes this file,
    // we write a valid GGUF buffer with metadata bytes to distinguish it.
    const loraBytes = makeGgufBuffer(1024);
    // Stamp word count at offset 24 so we can verify it round-trips.
    loraBytes.writeUInt32LE(wordCount & 0xffffffff, 24);

    const archiveBuf = CartridgeStore.buildArchive(
      manifest,
      loraBytes,
      PHOBOS_DEFAULT_CART_PASSWORD,
      false,
      sampleTexts,
    );

    const record = await store.installCartridgeArchive(archiveBuf);
    trainedId = record.id;

    ok('trained cartridge installed', !!record.id);
    ok('trainingDocuments stored', record.training_documents === docCount);
    ok('trainingSteps stored', record.training_steps === trainingSteps);
    ok('triggerContext stored', record.trigger_context !== null);
    ok('lora.gguf on disk', fs.existsSync(record.lora_path));

    // Verify samples were written inside the archive.
    const installedArchivePath = path.join(record.install_path, 'cartridge-archive.cartridge');
    const installedZip         = new AdmZip(installedArchivePath);
    const sampleEntries        = installedZip.getEntries().filter(e => e.entryName.startsWith('samples/') && !e.isDirectory);
    ok(`${Math.min(sampleTexts.length, 6)} sample(s) in archive`, sampleEntries.length === Math.min(sampleTexts.length, 6));

    // ── Modify: update recommendedWeight and reload via reinstall ─────────────
    // Simulate "refine cartridge" — produce a new archive with updated metadata.
    const refinedManifest = { ...manifest, version: '0.2.0', recommendedWeight: 0.6 };
    const refinedBuf      = CartridgeStore.buildArchive(refinedManifest, loraBytes, PHOBOS_DEFAULT_CART_PASSWORD);

    // Remove the old record then install refined.
    await store.remove(trainedId);
    ok('original removed before refine', !(await store.get(trainedId)));

    const refined = await store.installCartridgeArchive(refinedBuf);
    trainedId = refined.id;

    ok('refined cartridge installed', !!refined.id);
    ok('version updated to 0.2.0', refined.version === '0.2.0');
    ok('recommendedWeight updated', refined.recommended_weight === 0.6);

    // ── Auth on trained cartridge ──────────────────────────────────────────
    const refinedArchivePath = path.join(refined.install_path, 'cartridge-archive.cartridge');
    const authResult         = store.checkAuth(refinedArchivePath, { password: PHOBOS_DEFAULT_CART_PASSWORD });
    ok('trained cartridge auth unlocks', authResult.ok === true);
    ok("trained via = 'default'", authResult.ok && authResult.via === 'default');

    // ── Compat check on trained cartridge ─────────────────────────────────
    const compatResult = await manager.checkCompatibility(refined.id, 'seren');
    ok('trained cartridge compat check returns result', 'compatible' in compatResult);

    // ── Slot assignment for trained cartridge ──────────────────────────────
    await store.setActiveSlot('seren', refined.id, refined.recommended_weight);
    const slot = await store.getActiveSlot('seren');
    ok('trained cartridge slotted', slot.cartridgeId === refined.id);
    ok('weight matches recommendedWeight', slot.weight === 0.6);

    await store.clearActiveSlot('seren');
    ok('slot cleared after trained test', (await store.getActiveSlot('seren')).cartridgeId === null);
  } catch (err) {
    fail(`Section 13: ${(err as Error).message}`);
  }

  // ── Section 14: Remove + disk cleanup ──────────────────────────────────────
  section('Section 14: Remove + disk cleanup');
  try {
    for (const [label, id] of [
      ['unprotected', unprotectedId],
      ['protected',   protectedId],
      ['raw',         rawId],
      ['trained',     trainedId],
    ] as const) {
      if (!id) continue;
      const record = await store.get(id);
      const installPath = record?.install_path ?? '';

      await store.remove(id);

      const gone = !(await store.get(id));
      ok(`${label}: DB row removed`, gone);

      if (installPath) {
        ok(`${label}: install dir deleted`, !fs.existsSync(installPath));
      }
    }
  } catch (err) {
    fail(`Section 14: ${(err as Error).message}`);
  }

  // ── Teardown ──────────────────────────────────────────────────────────────
  cleanupTempFiles();
  try { fs.unlinkSync(TEST_DB_PATH); } catch { /* non-fatal */ }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\n❌  Validation FAILED\n');
    process.exit(1);
  } else {
    console.log('\n✅  All sections passed\n');
  }
}

main().catch(err => { console.error('[FATAL]', err); process.exit(1); });
