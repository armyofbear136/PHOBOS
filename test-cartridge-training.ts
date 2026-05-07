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
  runLmTraining,
  abortLmTraining,
  resolveLatestLmCheckpoint,
  trainingCacheSizeBytes,
  trainingCacheDir,
  type LmTrainingSession,
} from './phobos/CartridgeTrainer.js';
import { getPythonPath } from './phobos/PythonEnvManager.js';

// ── CLI args ──────────────────────────────────────────────────────────────────

const args         = process.argv.slice(2);
const modelId      = _arg('--model')  ?? 'qwen3.5-4b-q4';
const vendor       = (_arg('--vendor') ?? 'cuda') as 'cuda' | 'rocm' | 'cpu';
const stepsOverride = _arg('--steps') ? parseInt(_arg('--steps')!, 10) : 0;
const onlyPhase    = _arg('--only');
const skipDownload = args.includes('--skip-download');

function _arg(flag: string): string | null {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}

function shouldRun(name: string): boolean {
  if (onlyPhase) return onlyPhase === name;
  return true;
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const OUTPUT_ROOT    = path.resolve('./test-outputs/cartridge-training');
const TEST_DB_PATH   = path.join(os.tmpdir(), `phobos-cartridge-train-test-${Date.now()}.duckdb`);

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
    const ms = Date.now() - t0;
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

// ── Minimal GGUF validator (reused from test-cartridge-validate.ts) ────────────

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

/**
 * Writes minimal training files to sessionDatasetDir.
 * Document mode: 12 .md files (~200 words each).
 * Conversation mode: 1 .jsonl with 120 turns.
 */
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

  // ── Phase 1: Python venv present ────────────────────────────────────────────
  if (shouldRun('deps')) {
    await runPhase('Phase 1: Python venv present', async () => {
      const pyBin = getPythonPath(vendor);
      assertOk(pyBin !== null, `No Python venv found for vendor '${vendor}'. Run PyTorch setup in PHOBOS settings first.`);
      assertOk(fs.existsSync(pyBin!), `Python binary not found at: ${pyBin}`);
      console.log(`       Python: ${pyBin}`);
    });
  }

  // ── Phase 2: Unsloth deps importable ────────────────────────────────────────
  // Passive check only — no installation attempted here.
  // Unsloth requires torch pre-installed before pip can resolve its extras.
  // Install manually first (instructions in FAIL message below).
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
          { timeout: 60_000, env: { ...process.env, PYTHONUTF8: '1' } },
        );
        console.log('       unsloth, trl, safetensors, huggingface_hub — all importable');
      } catch {
        const activatePath = pyBin.replace('python.exe', 'activate.bat');
        throw new Error(
          'unsloth or trl not importable. Install manually using the full venv pip path:\n' +
          '         1. & "C:\\Users\\armyo\\.phobos\\python-env\\cuda\\Scripts\\pip.exe" install torchvision --index-url https://download.pytorch.org/whl/cu128 --no-deps\n' +
          '         2. & "C:\\Users\\armyo\\.phobos\\python-env\\cuda\\Scripts\\pip.exe" install "unsloth>=2025.3.0" trl sentencepiece pypdf markdown-it-py --no-deps\n' +
          '         3. & "C:\\Users\\armyo\\.phobos\\python-env\\cuda\\Scripts\\pip.exe" install unsloth_zoo --no-deps\n' +
          '         4. Patch trl: (Get-Content $trl_path -Raw) -replace \'\\.read_text\\(\\)\', \'.read_text(encoding="utf-8")\' | Set-Content $trl_path -NoNewline\n' +
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

  // ── Phase 3: Create session ──────────────────────────────────────────────────
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
      rank:            4,                      // smallest rank — fastest training
      steps:           stepsOverride || 0,     // 0 = auto from dataset
      lr:              2e-4,
    });
    sessionId = sess.session_id;
    assertOk(!!sessionId,           'session_id not returned');
    assertOk(sess.status === 'pending', `Expected status 'pending', got '${sess.status}'`);
    assertOk(sess.rank === 4,       `Expected rank 4, got ${sess.rank}`);
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

  // ── Phase 4: Write dataset ───────────────────────────────────────────────────
  await runPhase('Phase 4: Write synthetic training dataset', async () => {
    const sess = readLmSession(sessionId)!;
    writeDataset(sess.dataset_dir, 'document');
    const files = fs.readdirSync(sess.dataset_dir);
    assertOk(files.length >= 55, `Expected 55 dataset files, got ${files.length}`);
    console.log(`       Wrote ${files.length} files to ${sess.dataset_dir}`);
  });

  // ── Phase 5: HF cache check ──────────────────────────────────────────────────
  if (!skipDownload) {
    await runPhase('Phase 5: Training cache directory accessible', async () => {
      const sess  = readLmSession(sessionId)!;
      const cDir  = trainingCacheDir(sess.training_hf_id);
      const total = trainingCacheSizeBytes();
      console.log(`       Cache dir : ${cDir}`);
      console.log(`       Cache size: ${(total / 1e9).toFixed(2)} GB`);
      // Not asserting presence — first run will download during training.
      // Just confirm the path is writable.
      fs.mkdirSync(cDir, { recursive: true });
      assertOk(fs.existsSync(cDir), `Cache dir not creatable: ${cDir}`);
    });
  } else {
    skipPhase('Phase 5: Training cache directory accessible', '--skip-download');
  }

  // ── Phase 6: Run training pipeline ──────────────────────────────────────────
  //
  // This phase downloads the HF base model on first run (~5 GB for 4B models),
  // runs unsloth LoRA training for auto-computed steps, converts to GGUF,
  // and packages the .cartridge archive.
  //
  // Expected time: 5–30 min on first run (download dominates).
  // Subsequent runs with cache present: 2–15 min depending on model and steps.
  //
  let trainedCartridgeId = '';

  await runPhase('Phase 6: Run training pipeline (download + train + convert + package)', async () => {
    console.log('       Streaming training progress…\n');

    let lastStep   = 0;
    let lastLoss   = 0;
    let lastPhase  = '';
    let stepCount  = 0;

    for await (const progress of runLmTraining(sessionId, store)) {
      switch (progress.type) {

        case 'installing':
          process.stdout.write(`       [install] ${progress.session.current_phase}\n`);
          break;

        case 'phase':
          if (progress.session.current_phase !== lastPhase) {
            lastPhase = progress.session.current_phase;
            process.stdout.write(`       [phase  ] ${lastPhase}\n`);
          }
          break;

        case 'step': {
          lastStep = progress.session.current_step;
          lastLoss = progress.session.current_loss;
          stepCount++;
          // Print every 10 steps to avoid flooding the terminal
          if (stepCount % 10 === 0 || lastStep === progress.session.total_steps) {
            process.stdout.write(
              `       [step   ] ${lastStep}/${progress.session.total_steps}  loss=${lastLoss.toFixed(4)}\n`,
            );
          }
          break;
        }

        case 'done':
          trainedCartridgeId = progress.session.cartridge_id ?? '';
          process.stdout.write(`       [done   ] cartridge_id=${trainedCartridgeId}\n`);
          break;

        case 'error':
          throw new Error(progress.message ?? progress.session.error ?? 'Training error');
      }
    }

    assertOk(lastStep > 0,             `No training steps completed (lastStep=${lastStep})`);
    assertOk(lastLoss > 0,             `Loss never updated (lastLoss=${lastLoss})`);
    assertOk(!!trainedCartridgeId,     'No cartridge_id after training completed');

    const sess = readLmSession(sessionId)!;
    assertOk(sess.status === 'done',   `Expected status 'done', got '${sess.status}'`);
    assertOk(!!sess.gguf_path,         'gguf_path not set on session after training');
    assertOk(fs.existsSync(sess.gguf_path!), `lora.gguf not on disk: ${sess.gguf_path}`);

    validateGguf(sess.gguf_path!, 1024);
    console.log(`\n       Steps completed : ${lastStep}`);
    console.log(`       Final loss       : ${lastLoss.toFixed(4)}`);
    console.log(`       lora.gguf        : ${sess.gguf_path}`);
  });

  // ── Phase 7: Cartridge record in store ──────────────────────────────────────
  await runPhase('Phase 7: Packaged cartridge in CartridgeStore', async () => {
    assertOk(!!trainedCartridgeId, 'trainedCartridgeId not set — Phase 6 must have failed');
    const record = await store.get(trainedCartridgeId);
    assertOk(record !== null,                        `Cartridge record not found: ${trainedCartridgeId}`);
    assertOk(record!.name === 'Smoke Test Cartridge','name mismatch');
    assertOk(record!.kind === 'cartridge',           `kind should be 'cartridge', got '${record!.kind}'`);
    assertOk(record!.is_protected === false,         'expected unprotected (empty password)');
    assertOk(record!.training_steps > 0,             `training_steps should be > 0, got ${record!.training_steps}`);
    assertOk(fs.existsSync(record!.lora_path),       `lora_path not on disk: ${record!.lora_path}`);
    validateGguf(record!.lora_path, 1024);
    const archivePath = path.join(record!.install_path, 'cartridge-archive.cartridge');
    assertOk(fs.existsSync(archivePath),             `cartridge archive not on disk: ${archivePath}`);
    console.log(`       Record id    : ${record!.id}`);
    console.log(`       lora_path    : ${record!.lora_path}`);
    console.log(`       archive      : ${archivePath}`);
  });

  // ── Phase 8: Auth on trained cartridge ──────────────────────────────────────
  await runPhase('Phase 8: Auth check on trained cartridge', async () => {
    assertOk(!!trainedCartridgeId, 'trainedCartridgeId not set');
    const record      = await store.get(trainedCartridgeId);
    const archivePath = path.join(record!.install_path, 'cartridge-archive.cartridge');
    const result      = store.checkAuth(archivePath, { password: '' });
    assertOk(result.ok === true,                    `Auth failed: ${!result.ok ? result.reason : ''}`);
    assertOk(result.ok && result.via === 'default', `Expected via='default', got '${result.ok ? result.via : 'n/a'}'`);
  });

  // ── Phase 9: Checkpoint present ─────────────────────────────────────────────
  await runPhase('Phase 9: Training checkpoint on disk', async () => {
    const ckpt = resolveLatestLmCheckpoint(sessionId);
    // A checkpoint may not exist if steps < save_steps threshold — not fatal.
    if (ckpt) {
      assertOk(fs.existsSync(ckpt), `Checkpoint path returned but not on disk: ${ckpt}`);
      console.log(`       Checkpoint: ${ckpt}`);
    } else {
      console.log('       No checkpoint (steps < save interval — expected for short runs)');
    }
  });

  // ── Phase 10: Abort guard ────────────────────────────────────────────────────
  // Verify that aborting a non-active session is a no-op (does not throw).
  await runPhase('Phase 10: Abort non-active session is no-op', async () => {
    abortLmTraining('nonexistent-session-id');
    abortLmTraining(sessionId);  // already done — also no-op
    console.log('       No exception thrown');
  });

  // ── Phase 11: Copy session dir to test-outputs ───────────────────────────────
  await runPhase('Phase 11: Copy session artifacts to test-outputs', async () => {
    const sess    = readLmSession(sessionId)!;
    const destDir = path.join(OUTPUT_ROOT, sessionId);
    fs.mkdirSync(destDir, { recursive: true });

    // Copy session.json
    const sessionFile = path.join(sess.session_dir, 'session.json');
    if (fs.existsSync(sessionFile)) {
      fs.copyFileSync(sessionFile, path.join(destDir, 'session.json'));
    }

    // Copy lora.gguf
    if (sess.gguf_path && fs.existsSync(sess.gguf_path)) {
      fs.copyFileSync(sess.gguf_path, path.join(destDir, 'lora.gguf'));
    }

    // Copy preprocessed.jsonl (the extracted training pairs — useful to inspect)
    const preprocessed = path.join(sess.output_dir, 'preprocessed.jsonl');
    if (fs.existsSync(preprocessed)) {
      fs.copyFileSync(preprocessed, path.join(destDir, 'preprocessed.jsonl'));
    }

    console.log(`       Output dir: ${destDir}`);
    console.log(`       Files: ${fs.readdirSync(destDir).join(', ')}`);
  });

  // ── Phase 12: Training cache size reported ───────────────────────────────────
  await runPhase('Phase 12: Training cache size reported', async () => {
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

  // ── Teardown ──────────────────────────────────────────────────────────────────
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
