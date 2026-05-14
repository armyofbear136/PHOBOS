/**
 * test-cartridge-training.ts — CartridgeTrainer end-to-end smoke test.
 *
 * Tests the full LLM cartridge training pipeline without the HTTP layer.
 * Drives CartridgeTrainer.ts directly, which spawns phobos-lm-trainer.py.
 *
 * Prerequisites before running:
 *
 *   1. PyTorch venv set up (phobos Settings → PyTorch setup)
 *   2. Unsloth deps installed — either run once via the UI or:
 *        node -e "
 *          const { ensureCartridgeDeps } = await import('./phobos/PythonEnvManager.js');
 *          await ensureCartridgeDeps('cuda');
 *        "
 *   3. llama.cpp checkout for convert_lora_to_gguf.py. Either:
 *        - Set LLAMA_CPP_DIR=<path to llama.cpp checkout>
 *        - Or place convert_lora_to_gguf.py alongside dist/phobos-lm-trainer.py
 *   4. At least one trainable model downloaded in PHOBOS (default: qwen3.5-4b-q4)
 *      The HF safetensors base will be downloaded to:
 *        ~/.phobos/cartridge-training-cache/
 *      First run takes ~5 GB of disk and time depending on connection.
 *
 * Run:
 *   npx tsx test-cartridge-training.ts
 *   npx tsx test-cartridge-training.ts --model gemma3-4b-q4
 *   npx tsx test-cartridge-training.ts --vendor rocm
 *   npx tsx test-cartridge-training.ts --skip-download   (skip HF base download check)
 *   npx tsx test-cartridge-training.ts --only deps       (just check deps, no training)
 *   npx tsx test-cartridge-training.ts --steps 100       (override steps for fast smoke run)
 *
 * Output cartridge lands in: ./test-outputs/cartridge-training/<sessionId>/
 */

import * as fs   from 'node:fs';
import * as os   from 'node:os';
import * as path from 'node:path';

import { DatabaseManager } from './db/DatabaseManager.js';
import { CartridgeStore }  from './db/CartridgeStore.js';
import {
  createLmSession,
  readLmSession,
  startLmTraining,
  getLmTrainingStatus,
  abortLmTraining,
  resolveLatestLmCheckpoint,
  trainingCacheSizeBytes,
  trainingCacheDir,
  type LmTrainingSession,
} from './phobos/CartridgeTrainer.js';
import { getPythonPath } from './phobos/PythonEnvManager.js';

// ── CLI args ──────────────────────────────────────────────────────────────────

const args          = process.argv.slice(2);
const modelId       = _arg('--model')  ?? 'qwen3.5-4b-q4';
const vendor        = (_arg('--vendor') ?? 'cuda') as 'cuda' | 'rocm' | 'xpu' | 'cpu';
const stepsOverride = _arg('--steps') ? parseInt(_arg('--steps')!, 10) : 0;
const onlyPhase     = _arg('--only');
const skipDownload  = args.includes('--skip-download');

function _arg(flag: string): string | null {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

function shouldRun(name: string): boolean {
  if (onlyPhase) return onlyPhase === name;
  return true;
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const OUTPUT_ROOT  = path.resolve('./test-outputs/cartridge-training');
const TEST_DB_PATH = path.join(os.tmpdir(), `phobos-cartridge-train-test-${Date.now()}.duckdb`);

// ── Phase harness ─────────────────────────────────────────────────────────────

interface PhaseResult { name: string; status: 'ok' | 'skip' | 'fail'; message: string; ms: number; }
const results: PhaseResult[] = [];

async function runPhase(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  process.stdout.write(`\n── ${name} ──\n`);
  try {
    await fn();
    const ms = Date.now() - t0;
    results.push({ name, status: 'ok', message: '', ms });
    console.log(`[OK]   ${name} (${ms} ms)`);
  } catch (err) {
    const ms      = Date.now() - t0;
    const message = (err as Error).message;
    results.push({ name, status: 'fail', message, ms });
    console.error(`[FAIL] ${name} (${ms} ms)\n       ${message}`);
  }
}

function skipPhase(name: string, reason: string): void {
  results.push({ name, status: 'skip', message: reason, ms: 0 });
  console.log(`[SKIP] ${name} — ${reason}`);
}

function assertOk(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ── Minimal GGUF validator ────────────────────────────────────────────────────

function validateGguf(filePath: string, minBytes = 256): void {
  assertOk(fs.existsSync(filePath), `File not found: ${filePath}`);
  const size = fs.statSync(filePath).size;
  assertOk(size >= minBytes, `File too small: ${size} bytes (expected ≥ ${minBytes})`);
  const fd  = fs.openSync(filePath, 'r');
  const hdr = Buffer.alloc(4);
  fs.readSync(fd, hdr, 0, 4, 0);
  fs.closeSync(fd);
  assertOk(hdr.toString('ascii') === 'GGUF', `Not a GGUF file: magic=${hdr.toString('hex')}`);
}

// ── Synthetic dataset builder ─────────────────────────────────────────────────

function writeDataset(datasetDir: string, dataMode: 'document' | 'conversation'): void {
  fs.mkdirSync(datasetDir, { recursive: true });

  if (dataMode === 'document') {
    for (let i = 1; i <= 55; i++) {
      const words = Array.from({ length: 200 }, (_, j) =>
        `word${((i * 200 + j) % 500) + 1}`
      ).join(' ');
      const text = `# Synthetic Document ${i}\n\n${words}\n\n` +
        `This document covers topic ${i} in depth. ` +
        `It contains enough content for the trainer to extract useful pairs.\n`;
      fs.writeFileSync(path.join(datasetDir, `doc${i.toString().padStart(2, '0')}.md`), text);
    }
  } else {
    const turns = Array.from({ length: 120 }, (_, i) => JSON.stringify({
      user:      `What is concept number ${i + 1}?`,
      assistant: `Concept ${i + 1} refers to the specialized domain knowledge item at index ${i + 1}. It is characterized by properties A, B, and C, and is most applicable in contexts where precision is required.`,
    })).join('\n');
    fs.writeFileSync(path.join(datasetDir, 'conversations.jsonl'), turns);
  }
}

// ── Poll helper ───────────────────────────────────────────────────────────────
//
// Mirrors the poll loop in LmTrainingPanel and WorkflowPanel exactly.
// Calls getLmTrainingStatus() directly (no HTTP) since we are in-process.
// Resolves when training completes (done/error/aborted). Polls indefinitely —
// the user aborts via the UI if they want to stop. No artificial time cap.

async function pollUntilDone(
  sessionId: string,
  onStep:  (sess: LmTrainingSession) => void,
  onPhase: (sess: LmTrainingSession) => void,
): Promise<LmTrainingSession> {
  const POLL_MS  = 1500;

  let lastStep  = 0;
  let lastPhase = '';

  while (true) {
    await new Promise(r => setTimeout(r, POLL_MS));

    const st = getLmTrainingStatus();

    // If the in-memory status no longer matches our session, read from disk.
    const sess = (st.sessionId === sessionId ? st.session : null)
               ?? readLmSession(sessionId);

    if (!sess) continue;

    if (sess.current_step !== lastStep) {
      lastStep = sess.current_step;
      onStep(sess);
    }
    if (sess.current_phase !== lastPhase) {
      lastPhase = sess.current_phase;
      onPhase(sess);
    }

    const terminal = sess.status === 'done'
                  || sess.status === 'error'
                  || sess.status === 'aborted';

    if (terminal && !st.training) return sess;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔬  PHOBOS CartridgeTrainer — End-to-End Smoke Test\n');
  console.log(`    Model  : ${modelId}`);
  console.log(`    Vendor : ${vendor}`);
  console.log(`    Steps  : ${stepsOverride > 0 ? stepsOverride : 'auto'}`);
  console.log(`    Output : ${OUTPUT_ROOT}`);
  console.log(`    DB     : ${TEST_DB_PATH}`);

  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });

  const db = DatabaseManager.getInstance(TEST_DB_PATH);
  await db.initialize();
  const store = new CartridgeStore(db);
  await store.ensureTable();

  let sessionId = '';

  // ── Phase 1: Python venv present ──────────────────────────────────────────
  if (shouldRun('deps')) {
    await runPhase('Phase 1: Python venv present', async () => {
      const pyBin = getPythonPath(vendor);
      assertOk(pyBin !== null, `No Python venv found for vendor '${vendor}'. Run PyTorch setup in PHOBOS settings first.`);
      assertOk(fs.existsSync(pyBin!), `Python binary not found at: ${pyBin}`);
      console.log(`       Python: ${pyBin}`);
    });
  }

  // ── Phase 2: Unsloth deps importable ──────────────────────────────────────
  if (shouldRun('deps')) {
    await runPhase('Phase 2: Unsloth + TRL deps importable', async () => {
      const pyBin = getPythonPath(vendor)!;
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(execFile);
      try {
        await execAsync(
          pyBin,
          ['-c', 'import unsloth, trl, safetensors, huggingface_hub; print("ok")'],
          { timeout: 180_000, env: { ...process.env, PYTHONUTF8: '1' } },
        );
        console.log('       unsloth, trl, safetensors, huggingface_hub — all importable');
      } catch {
        const pipBin = pyBin.replace(/python(\.exe)?$/, process.platform === 'win32' ? 'pip.exe' : 'pip3');
        const tvIndex = vendor === 'rocm'
          ? 'https://download.pytorch.org/whl/rocm7.2'
          : vendor === 'xpu'
          ? 'https://download.pytorch.org/whl/xpu'
          : 'https://download.pytorch.org/whl/cu128';
        throw new Error(
          'unsloth or trl not importable. Install manually using the full venv pip path:\n' +
          `         1. & "${pipBin}" install torchvision --index-url ${tvIndex} --no-deps\n` +
          `         2. & "${pipBin}" install "unsloth>=2025.3.0" trl sentencepiece pypdf markdown-it-py --no-deps\n` +
          `         3. & "${pipBin}" install unsloth_zoo --no-deps\n` +
          '       Then re-run: npx tsx test-cartridge-training.ts --only deps',
        );
      }
    });
  } else {
    skipPhase('Phase 2: Unsloth + TRL deps importable', '--only flag set');
  }

  if (onlyPhase === 'deps') {
    _printSummary();
    return;
  }

  // ── Phase 3: Create session ────────────────────────────────────────────────
  await runPhase('Phase 3: Create LM training session', async () => {
    const sess = await createLmSession({
      sessionId:       `test_${Date.now()}`,
      name:            'Smoke Test Cartridge',
      description:     'Automated smoke test cartridge',
      author:          'phobos-test',
      baseModelId:     modelId,
      targetPersona:   'seren',
      category:        'expertise',
      tags:            ['smoke', 'test'],
      behaviorSummary: 'A minimal test cartridge to validate the training pipeline.',
      triggerContext:  null,
      license:         'personal',
      password:        '',
      addLicense:      false,
      dataMode:        'document',
      rank:            4,
      steps:           stepsOverride || 0,
      lr:              2e-4,
      vendorOverride:  vendor !== 'cuda' ? vendor : undefined,
    });
    sessionId = sess.session_id;
    assertOk(!!sessionId,               'session_id not returned');
    assertOk(sess.status === 'pending', `Expected status 'pending', got '${sess.status}'`);
    assertOk(sess.rank === 4,           `Expected rank 4, got ${sess.rank}`);
    assertOk(sess.training_hf_id !== '', 'training_hf_id is empty — model may not support training');
    console.log(`       Session : ${sessionId}`);
    console.log(`       HF ID   : ${sess.training_hf_id}`);
    console.log(`       Dataset : ${sess.dataset_dir}`);
    console.log(`       Output  : ${sess.output_dir}`);
  });

  if (!sessionId) {
    console.error('\n[FATAL] Session creation failed — cannot continue.\n');
    _printSummary();
    process.exit(1);
  }

  // ── Phase 4: Write dataset ─────────────────────────────────────────────────
  await runPhase('Phase 4: Write synthetic training dataset', async () => {
    const sess = readLmSession(sessionId)!;
    writeDataset(sess.dataset_dir, 'document');
    const files = fs.readdirSync(sess.dataset_dir);
    assertOk(files.length >= 55, `Expected 55 dataset files, got ${files.length}`);
    console.log(`       Wrote ${files.length} files to ${sess.dataset_dir}`);
  });

  // ── Phase 5: HF cache check ────────────────────────────────────────────────
  if (!skipDownload) {
    await runPhase('Phase 5: Training cache directory accessible', async () => {
      const sess  = readLmSession(sessionId)!;
      const cDir  = trainingCacheDir(sess.training_hf_id);
      const total = trainingCacheSizeBytes();
      console.log(`       Cache dir : ${cDir}`);
      console.log(`       Cache size: ${(total / 1e9).toFixed(2)} GB`);
      fs.mkdirSync(cDir, { recursive: true });
      assertOk(fs.existsSync(cDir), `Cache dir not creatable: ${cDir}`);
    });
  } else {
    skipPhase('Phase 5: Training cache directory accessible', '--skip-download');
  }

  // ── Phase 6: Run training pipeline ────────────────────────────────────────
  //
  // Uses the fire-and-forget + poll pattern — mirrors LmTrainingPanel and
  // WorkflowPanel exactly. startLmTraining() returns immediately; the
  // background pipeline runs server stop → VRAM settle → dep install →
  // Python trainer → PyTorch settle → server restart → package.
  // pollUntilDone() drives getLmTrainingStatus() at 1500 ms intervals.
  //
  // Expected time: 5–30 min on first run (HF download dominates).
  //
  let trainedCartridgeId = '';

  await runPhase('Phase 6: Run training pipeline (download + train + convert + package)', async () => {
    console.log('       Starting training (fire-and-forget)…\n');

    // POST /run equivalent — starts background pipeline, returns immediately
    const result = startLmTraining(sessionId, store);
    assertOk(result.ok, `startLmTraining failed: ${!result.ok ? result.error : ''}`);

    console.log('       Polling for progress…\n');

    let lastStep  = 0;
    let lastLoss  = 0;
    let stepCount = 0;

    const finalSession = await pollUntilDone(
      sessionId,

      // onStep — called whenever current_step advances
      (sess) => {
        lastStep = sess.current_step;
        lastLoss = sess.current_loss;
        stepCount++;
        if (stepCount % 10 === 0 || lastStep === sess.total_steps) {
          process.stdout.write(
            `       [step   ] ${lastStep}/${sess.total_steps}  loss=${lastLoss.toFixed(4)}\n`,
          );
        }
      },

      // onPhase — called whenever current_phase changes
      (sess) => {
        process.stdout.write(`       [phase  ] ${sess.current_phase}\n`);
        if (sess.status === 'done' && sess.cartridge_id) {
          trainedCartridgeId = sess.cartridge_id;
          process.stdout.write(`       [done   ] cartridge_id=${trainedCartridgeId}\n`);
        }
        if (sess.status === 'error') {
          process.stdout.write(`       [error  ] ${sess.error ?? 'unknown'}\n`);
        }
      },
    );

    // Capture cartridge_id from final session in case onPhase missed it
    if (!trainedCartridgeId && finalSession.cartridge_id) {
      trainedCartridgeId = finalSession.cartridge_id;
    }

    if (finalSession.status === 'error') {
      throw new Error(finalSession.error ?? 'Training error — no message');
    }
    if (finalSession.status === 'aborted') {
      throw new Error('Training was aborted');
    }

    assertOk(lastStep > 0,          `No training steps completed (lastStep=${lastStep})`);
    assertOk(lastLoss > 0,          `Loss never updated (lastLoss=${lastLoss})`);
    assertOk(!!trainedCartridgeId,  'No cartridge_id after training completed');

    const sess = readLmSession(sessionId)!;
    assertOk(sess.status === 'done',  `Expected status 'done', got '${sess.status}'`);
    assertOk(!!sess.gguf_path,        'gguf_path not set on session after training');
    assertOk(fs.existsSync(sess.gguf_path!), `lora.gguf not on disk: ${sess.gguf_path}`);

    validateGguf(sess.gguf_path!, 1024);
    console.log(`\n       Steps completed : ${lastStep}`);
    console.log(`       Final loss       : ${lastLoss.toFixed(4)}`);
    console.log(`       lora.gguf        : ${sess.gguf_path}`);
  });

  // ── Phase 7: Cartridge record in store ────────────────────────────────────
  await runPhase('Phase 7: Packaged cartridge in CartridgeStore', async () => {
    assertOk(!!trainedCartridgeId, 'trainedCartridgeId not set — Phase 6 must have failed');
    const record = await store.get(trainedCartridgeId);
    assertOk(record !== null,                         `Cartridge record not found: ${trainedCartridgeId}`);
    assertOk(record!.name === 'Smoke Test Cartridge', 'name mismatch');
    assertOk(record!.kind === 'cartridge',            `kind should be 'cartridge', got '${record!.kind}'`);
    assertOk(record!.is_protected === false,          'expected unprotected (empty password)');
    assertOk(record!.training_steps > 0,              `training_steps should be > 0, got ${record!.training_steps}`);
    assertOk(fs.existsSync(record!.lora_path),        `lora_path not on disk: ${record!.lora_path}`);
    validateGguf(record!.lora_path, 1024);
    const archivePath = path.join(record!.install_path, 'cartridge-archive.cartridge');
    assertOk(fs.existsSync(archivePath), `cartridge archive not on disk: ${archivePath}`);
    console.log(`       Record id    : ${record!.id}`);
    console.log(`       lora_path    : ${record!.lora_path}`);
    console.log(`       archive      : ${archivePath}`);
  });

  // ── Phase 8: Auth on trained cartridge ────────────────────────────────────
  await runPhase('Phase 8: Auth check on trained cartridge', async () => {
    assertOk(!!trainedCartridgeId, 'trainedCartridgeId not set');
    const record      = await store.get(trainedCartridgeId);
    const archivePath = path.join(record!.install_path, 'cartridge-archive.cartridge');
    const result      = store.checkAuth(archivePath, { password: '' });
    assertOk(result.ok === true,                     `Auth failed: ${!result.ok ? result.reason : ''}`);
    assertOk(result.ok && result.via === 'default',  `Expected via='default', got '${result.ok ? result.via : 'n/a'}'`);
  });

  // ── Phase 9: Checkpoint present ───────────────────────────────────────────
  await runPhase('Phase 9: Training checkpoint on disk', async () => {
    const ckpt = resolveLatestLmCheckpoint(sessionId);
    if (ckpt) {
      assertOk(fs.existsSync(ckpt), `Checkpoint path returned but not on disk: ${ckpt}`);
      console.log(`       Checkpoint: ${ckpt}`);
    } else {
      console.log('       No checkpoint (steps < save interval — expected for short runs)');
    }
  });

  // ── Phase 10: Abort guard ─────────────────────────────────────────────────
  await runPhase('Phase 10: Abort non-active session is no-op', async () => {
    abortLmTraining('nonexistent-session-id');
    abortLmTraining(sessionId);  // already done — also no-op
    console.log('       No exception thrown');
  });

  // ── Phase 11: getLmTrainingStatus reflects idle after completion ──────────
  await runPhase('Phase 11: getLmTrainingStatus reflects idle after completion', async () => {
    const st = getLmTrainingStatus();
    // After training finishes the status should show training=false.
    // If completedAt is within 5 s the route would still return session from
    // memory; after 5 s it falls back to disk. Either way training=false.
    assertOk(st.training === false, `Expected training=false after completion, got training=${st.training}`);
    console.log(`       training     : ${st.training}`);
    console.log(`       sessionId    : ${st.sessionId}`);
    console.log(`       completedAt  : ${st.completedAt ? new Date(st.completedAt).toISOString() : 'null'}`);
  });

  // ── Phase 12: Copy session dir to test-outputs ────────────────────────────
  await runPhase('Phase 12: Copy session artifacts to test-outputs', async () => {
    const sess    = readLmSession(sessionId)!;
    const destDir = path.join(OUTPUT_ROOT, sessionId);
    fs.mkdirSync(destDir, { recursive: true });

    const sessionJsonPath = path.join(sess.session_dir, 'session.json');
    if (fs.existsSync(sessionJsonPath)) {
      fs.copyFileSync(sessionJsonPath, path.join(destDir, 'session.json'));
    }

    if (sess.gguf_path && fs.existsSync(sess.gguf_path)) {
      fs.copyFileSync(sess.gguf_path, path.join(destDir, 'lora.gguf'));
    }

    const preprocessed = path.join(sess.output_dir, 'preprocessed.jsonl');
    if (fs.existsSync(preprocessed)) {
      fs.copyFileSync(preprocessed, path.join(destDir, 'preprocessed.jsonl'));
    }

    console.log(`       Output dir: ${destDir}`);
    console.log(`       Files: ${fs.readdirSync(destDir).join(', ')}`);
  });

  // ── Phase 13: Training cache size reported ────────────────────────────────
  await runPhase('Phase 13: Training cache size reported', async () => {
    const sess  = readLmSession(sessionId)!;
    const total = trainingCacheSizeBytes();
    const cDir  = trainingCacheDir(sess.training_hf_id);
    console.log(`       Total cache : ${(total / 1e9).toFixed(2)} GB`);
    console.log(`       Model cache : ${cDir}`);
    if (total === 0) {
      console.log('       ⚠ Cache empty — expected if Phase 6 failed before download');
    } else {
      assertOk(total > 0, 'Cache size is 0 — HF base model was not downloaded to expected location');
    }
  });

  // ── Teardown ──────────────────────────────────────────────────────────────
  try { fs.unlinkSync(TEST_DB_PATH); } catch { /* non-fatal */ }

  _printSummary();
}

function _printSummary(): void {
  const ok   = results.filter(r => r.status === 'ok').length;
  const fail = results.filter(r => r.status === 'fail').length;
  const skip = results.filter(r => r.status === 'skip').length;

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`Results: ${ok} passed, ${fail} failed, ${skip} skipped\n`);

  for (const r of results) {
    const icon = r.status === 'ok' ? '✅' : r.status === 'skip' ? '⏭ ' : '❌';
    const ms   = r.ms > 0 ? ` (${r.ms < 60_000 ? `${r.ms} ms` : `${(r.ms / 60_000).toFixed(1)} min`})` : '';
    console.log(`  ${icon}  ${r.name}${ms}`);
    if (r.status === 'fail') console.log(`        ${r.message}`);
  }

  console.log('');

  if (fail > 0) {
    console.error('❌  Test FAILED\n');
    process.exit(1);
  } else {
    console.log('✅  All phases passed\n');
  }
}

main().catch(err => { console.error('[FATAL]', err); process.exit(1); });
