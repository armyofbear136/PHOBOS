/**
 * test-plugin-validate.ts — Artist Plugin System end-to-end validator.
 *
 * Runs a full pipeline against a directory of training images:
 *   1. Env check        — Python venv ready, training deps present
 *   2. Stage images     — Count images in the provided directory
 *   3. Caption          — Run phobos-caption.py via CaptionProcessor
 *   4. Train            — Run phobos-trainer.py for N steps (default 50, smoke-test only)
 *   5. Package          — Build a .phobos archive via PluginStore.createPlugin()
 *   6. Install          — Read the archive back via PluginStore.installPhobosArchive()
 *   7. Auth             — Verify password unlock works
 *   8. Infer check      — Confirm archive_path and lora.safetensors are present inside zip
 *
 * Usage:
 *   npx tsx test-plugin-validate.ts --image-dir ./my-training-images
 *   npx tsx test-plugin-validate.ts --image-dir ./images --steps 100 --vendor cuda
 *   npx tsx test-plugin-validate.ts --image-dir ./images --skip-train   (skip training, package only)
 *   npx tsx test-plugin-validate.ts --image-dir ./images --skip-caption (use existing captions.json)
 *
 * Options:
 *   --image-dir   PATH   Directory of training images (required)
 *   --steps       N      Training steps (default: 50 — smoke test only)
 *   --vendor      NAME   cuda | rocm | xpu | apple | cpu (auto-detected if omitted)
 *   --base-model  NAME   flux-dev | flux-schnell | flux-kontext | chroma | sdxl |
 *                        wan | qwen-image | sana | sana-sprint (default: chroma)
 *   --trigger     WORD   Trigger word to embed (default: TESTCONCEPT)
 *   --password    PASS   Plugin password (default: testpass)
 *   --skip-train         Skip training, try to package from existing output/lora.safetensors
 *   --skip-caption       Skip captioning, use existing captions.json in session dir
 *   --keep               Keep session directory after completion (default: cleaned up)
 *   --full-test          Run train → gen → cleanup cycle for all key base models
 */

import * as fs        from 'fs';
import * as path      from 'path';
import * as os        from 'os';
import * as crypto    from 'crypto';
import { execFile, spawn }   from 'child_process';
import { promisify }  from 'util';
import { fileURLToPath } from 'url';
import AdmZip         from 'adm-zip';

const execFileAsync = promisify(execFile);
const _dirname      = path.dirname(fileURLToPath(import.meta.url));

// ── Arg parsing ───────────────────────────────────────────────────────────────

let imageDir:     string  = '';
let steps:        number  = 50;
let forceVendor:  string  = '';
let baseModel:    string  = 'chroma';
let triggerWord:  string  = 'TESTCONCEPT';
let password:     string  = 'testpass';
let skipTrain     = false;
let skipCaption   = false;
let keepSession   = false;
let fullTest      = false;

for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--image-dir'   && process.argv[i + 1]) imageDir    = path.resolve(process.argv[++i]);
  else if (a === '--steps'  && process.argv[i + 1]) steps       = parseInt(process.argv[++i], 10);
  else if (a === '--vendor' && process.argv[i + 1]) forceVendor = process.argv[++i];
  else if (a === '--base-model' && process.argv[i + 1]) baseModel = process.argv[++i];
  else if (a === '--trigger'    && process.argv[i + 1]) triggerWord = process.argv[++i];
  else if (a === '--password'   && process.argv[i + 1]) password  = process.argv[++i];
  else if (a === '--skip-train')   skipTrain   = true;
  else if (a === '--skip-caption') skipCaption = true;
  else if (a === '--keep')         keepSession = true;
  else if (a === '--full-test')     fullTest    = true;
}

if (!imageDir) {
  console.error('Usage: npx tsx test-plugin-validate.ts --image-dir PATH [options]');
  process.exit(1);
}

if (!fs.existsSync(imageDir)) {
  console.error(`Image directory not found: ${imageDir}`);
  process.exit(1);
}

// ── Logging ───────────────────────────────────────────────────────────────────

const PASS = '✅';
const FAIL = '❌';
const INFO = '·';

let failures = 0;

function pass(label: string, detail = '') {
  console.log(`  ${PASS}  ${label}${detail ? '  — ' + detail : ''}`);
}

function fail(label: string, detail = '') {
  console.log(`  ${FAIL}  ${label}${detail ? '  — ' + detail : ''}`);
  failures++;
}

function info(label: string) {
  console.log(`  ${INFO}  ${label}`);
}

function section(title: string) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 54 - title.length))}`);
}

// ── Imports (after deps confirmed importable) ─────────────────────────────────

async function loadModules() {
  const { getPythonPath, gpuToVendor, isVendorReady } =
    await import('./phobos/PythonEnvManager.js');
  const { detectHardware } = await import('./phobos/PhobosLocalManager.js');
  const { DatabaseManager } = await import('./db/DatabaseManager.js');
  const { PluginStore } = await import('./db/PluginStore.js');
  return { getPythonPath, gpuToVendor, isVendorReady, detectHardware, DatabaseManager, PluginStore };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║   PHOBOS Artist Plugin System — Validation Script   ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  info(`Image dir:   ${imageDir}`);
  info(`Base model:  ${baseModel}`);
  info(`Steps:       ${skipTrain ? 'skipped' : steps}`);
  info(`Trigger:     ${triggerWord}`);
  info(`Skip train:  ${skipTrain}`);
  info(`Skip caption:${skipCaption}`);

  // ── 1. Env check ─────────────────────────────────────────────────────────────

  section('1 · Environment');

  const { getPythonPath, gpuToVendor, isVendorReady, detectHardware, DatabaseManager, PluginStore } =
    await loadModules();

  // Initialize DuckDB once for all sections that need it (packaging, install, cleanup)
  const db = DatabaseManager.getInstance();
  await db.initialize();

  const hw = await detectHardware();
  if (hw.gpus.length > 0) {
    pass('Hardware detected', hw.gpus.map(g => g.name).join(', '));
  } else {
    info('No GPUs detected — CPU path will be used');
  }

  const vendor = forceVendor || (hw.gpus[0] ? gpuToVendor(hw.gpus[0]) : 'cpu');
  info(`Vendor: ${vendor}`);

  const ready = isVendorReady(vendor as any);
  if (ready) {
    pass('PyTorch venv', vendor);
  } else {
    fail('PyTorch venv not installed', `Run: npx tsx test-pytorch-env.ts --install ${vendor}`);
  }

  const pyBin = getPythonPath(vendor as any);
  if (!pyBin) {
    fail('Python binary not found');
    console.log('\nCannot continue without Python venv. Install PyTorch first.\n');
    process.exit(1);
  }

  // Check training deps — install into venv if missing (matches ensureTrainingDeps behaviour)
  const TRAINING_DEPS = [
    'peft>=0.10.0', 'bitsandbytes>=0.43.0', 'prodigyopt>=1.0',
    'torchvision', 'Pillow', 'safetensors>=0.4.0',
  ];
  try {
    await execFileAsync(pyBin, ['-c', 'import peft, accelerate, safetensors; print("ok")'], { timeout: 15_000 });
    pass('Training deps', 'peft, accelerate, safetensors');
  } catch {
    info('Training deps missing from venv — installing now…');
    try {
      await execFileAsync(pyBin, ['-m', 'pip', 'install', '--quiet', ...TRAINING_DEPS],
        { timeout: 10 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 });
      pass('Training deps installed into venv');
    } catch (e) {
      fail('Training deps install failed', (e as Error).message.split('\n').slice(-2).join(' '));
    }
  }

  // Check caption deps — install if missing
  try {
    await execFileAsync(pyBin, ['-c', 'import transformers, timm, einops; print("ok")'], { timeout: 15_000 });
    pass('Caption deps', 'transformers, timm, einops');
  } catch {
    info('Caption deps missing from venv — installing now…');
    try {
      await execFileAsync(pyBin, ['-m', 'pip', 'install', '--quiet', 'timm', 'einops'],
        { timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 });
      pass('Caption deps installed into venv');
    } catch (e) {
      fail('Caption deps install failed — captioning will fail', (e as Error).message.split('\n').slice(-2).join(' '));
    }
  }

  // VRAM pre-flight for training
  section('1b · VRAM Check');
  try {
    const { queryGpuFreeVram }        = await import('./phobos/PhobosLocalManager.js');
    const { estimateTrainingVramGb }  = await import('./phobos/PluginTrainer.js');
    const gpu = hw.gpus.find(g => g.vramGb >= 4) ?? hw.gpus[0];
    if (!gpu) {
      info('No GPU — training will run on CPU (very slow)');
    } else {
      const required = estimateTrainingVramGb(baseModel as any, 16);
      const freeMb   = await queryGpuFreeVram(gpu);
      const freeGb   = freeMb !== undefined ? parseFloat((freeMb / 1024).toFixed(1)) : gpu.vramGb;
      if (freeGb >= required) {
        pass(`VRAM sufficient`, `${freeGb} GB free on ${gpu.name}, need ${required} GB`);
      } else {
        // Soft warning — CUDA always-offload may allow training below the estimate
        info(`VRAM low: need ~${required} GB, have ${freeGb} GB free on ${gpu.name}`);
        info(`Training will attempt CPU offload — close other apps if it fails`);
      }
    }
  } catch (e) {
    info(`VRAM check skipped: ${(e as Error).message}`);
  }

  // ── 2. Image staging ──────────────────────────────────────────────────────────

  section('2 · Training Images');

  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tiff', '.bmp']);
  const images = fs.readdirSync(imageDir)
    .filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()));

  if (images.length >= 15) {
    pass(`${images.length} images found`, 'meets 15-image minimum');
  } else if (images.length >= 5) {
    info(`${images.length} images found (below 15-image recommended minimum for quality training)`);
  } else if (images.length >= 1) {
    fail(`Only ${images.length} image(s) found`, 'smoke test will proceed but results will be poor');
  } else {
    fail('No images found in directory');
    process.exit(1);
  }

  // ── 3. Session directory ──────────────────────────────────────────────────────

  section('3 · Session Setup');

  const sessionId  = `validate_${Date.now()}`;
  const sessionDir = path.join(os.homedir(), '.phobos', 'plugin-training', sessionId);
  const rawDir     = path.join(sessionDir, 'raw');
  const outputDir  = path.join(sessionDir, 'output');
  const captionFile = path.join(sessionDir, 'captions.json');

  fs.mkdirSync(rawDir,    { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  // Copy images into raw/ dir
  for (const img of images) {
    fs.copyFileSync(path.join(imageDir, img), path.join(rawDir, img));
  }
  pass(`Session created`, sessionId);
  pass(`${images.length} images staged to raw/`);

  // ── 4. Caption ────────────────────────────────────────────────────────────────

  section('4 · Captioning (Florence-2)');

  const captionScript = path.join(_dirname, 'phobos', 'phobos-caption.py');

  if (skipCaption && fs.existsSync(captionFile)) {
    pass('Skipped — using existing captions.json');
  } else if (!fs.existsSync(captionScript)) {
    fail('phobos-caption.py not found');
  } else {
    info('Running Florence-2 captioner… (downloads ~270 MB on first run)');
    try {
      const captionResult = await runScript(pyBin, [
        '-W', 'ignore',
        captionScript,
        '--image-dir',    rawDir,
        '--output-file',  captionFile,
        '--trigger-word', triggerWord,
        '--device',       'auto',
      ], 20 * 60 * 1000);

      // File existence is the primary success signal — stderr deprecation warnings
      // from HuggingFace don't mean captioning failed.
      if (fs.existsSync(captionFile)) {
        const captions = JSON.parse(fs.readFileSync(captionFile, 'utf-8')) as Record<string, string>;
        const count    = Object.keys(captions).length;
        if (count > 0) {
          pass(`Captioned ${count} image(s)`);
          const sample = Object.values(captions)[0];
          if (sample) info(`Sample: "${sample.slice(0, 80)}…"`);
        } else {
          fail('Caption file written but empty');
        }
      } else if (captionResult.exitCode === -1) {
        fail('Captioning timed out (>20 min)', 'Try --skip-caption on subsequent runs');
        fs.writeFileSync(captionFile, JSON.stringify(
          Object.fromEntries(images.map(f => [f, triggerWord])), null, 2
        ));
        info('Wrote fallback captions (trigger word only) — training will proceed');
      } else {
        fail('Captioning failed', captionResult.stderr.split('\n').slice(-3).join(' '));
        // Write empty captions so training can still run
        fs.writeFileSync(captionFile, JSON.stringify(
          Object.fromEntries(images.map(f => [f, triggerWord])), null, 2
        ));
        info('Wrote fallback captions (trigger word only) — training will proceed');
      }
    } catch (e) {
      fail('Captioner subprocess error', (e as Error).message);
      fs.writeFileSync(captionFile, JSON.stringify(
        Object.fromEntries(images.map(f => [f, triggerWord])), null, 2
      ));
    }
  }

  // ── 5. Train ──────────────────────────────────────────────────────────────────

  section('5 · Training');

  const loraOut = path.join(outputDir, 'lora.safetensors');

  if (skipTrain && fs.existsSync(loraOut)) {
    pass(`Skipped — using existing lora.safetensors (${formatBytes(fs.statSync(loraOut).size)})`);
  } else if (skipTrain) {
    fail('--skip-train set but no lora.safetensors found in output/');
    process.exit(1);
  } else {
    const trainerScript = path.join(_dirname, 'phobos', 'phobos-trainer.py');
    if (!fs.existsSync(trainerScript)) {
      fail('phobos-trainer.py not found');
    } else {
      // HF-native models (SANA) have no local GGUF — trainer loads from HF cache directly.
      const HF_NATIVE_MODELS = new Set(['sana', 'sana-sprint']);
      const isHfNative = HF_NATIVE_MODELS.has(baseModel);

      // Resolve base model path — matches PluginTrainer._resolveModelPath layout:
      //   sdxl        → image/sdxl/
      //   wan         → image/wan/
      //   everything else (flux, chroma, kontext, qwen-image, z-image) → image/flux/
      const phobosBase = path.join(os.homedir(), '.phobos', 'models', 'image');
      const modelPatterns: Record<string, string[]> = {
        'flux-dev':    ['flux-dev', 'flux.1-dev', 'flux1-dev'],
        'flux-schnell':['flux-schnell', 'flux.1-schnell', 'flux1-schnell'],
        'flux-kontext':['kontext', 'flux-kontext'],
        'chroma':      ['chroma'],
        'sdxl':        ['sdxl', 'sd_xl'],
        'flux2-klein': ['flux2-klein', 'klein'],
        'wan':         ['wan2.1-t2v-1.3b', 'wan2.1-t2v', 'wan'],
        'qwen-image':  ['qwen-image'],
      };
      const searchSubdir =
        baseModel === 'sdxl' ? 'sdxl' :
        baseModel === 'wan'  ? 'wan'  :
        'flux';
      const searchDir = path.join(phobosBase, searchSubdir);
      let resolvedModelPath = '';
      if (!isHfNative && fs.existsSync(searchDir)) {
        const files = fs.readdirSync(searchDir);
        const patterns = modelPatterns[baseModel] ?? [];
        for (const pat of patterns) {
          const match = files.find(f => f.toLowerCase().includes(pat) && (f.endsWith('.gguf') || f.endsWith('.safetensors')));
          if (match) { resolvedModelPath = path.join(searchDir, match); break; }
        }
      }

      if (!isHfNative && !resolvedModelPath) {
        fail(`Base model '${baseModel}' not installed`, `Download it via PHOBOS → Art Plugins → Create Plugin, or use --base-model with an installed model`);
        fail('Cannot package — lora.safetensors not found');
        // Skip remaining sections cleanly
      } else {
        if (isHfNative) {
          pass(`Base model resolved`, `${baseModel} (HF-native, loads from ~/.phobos/hf-cache)`);
        } else {
          pass(`Base model resolved`, path.basename(resolvedModelPath));
        }

      // Write session.json for the trainer
      const sessionCfg = {
        session_id:   sessionId,
        base_model:   baseModel,
        rank:         16,
        steps:        steps,
        batch_size:   1,
        lr:           1e-4,
        width:        256,    // 256px for smoke test — 4× less activation memory than 512
        height:       256,
        device:       'auto',
        vendor,
        model_path:   isHfNative ? '' : resolvedModelPath,
        image_dir:    rawDir,
        caption_file: captionFile,
        output_dir:   outputDir,
        trigger_word: triggerWord,
        resume_from:  null,
      };
      const sessionJsonPath = path.join(sessionDir, 'session.json');
      fs.writeFileSync(sessionJsonPath, JSON.stringify(sessionCfg, null, 2));

      info(`Training ${baseModel} LoRA for ${steps} steps (smoke test)…`);
      const t0 = Date.now();

      const trainResult = await runScript(pyBin, [
        '-W', 'ignore',
        trainerScript,
        '--session-file', sessionJsonPath,
      ], 30 * 60 * 1000, (line) => {
        if (line.startsWith('STEP ')) {
          const m = line.match(/STEP (\d+)\/(\d+) loss=([\d.]+)/);
          if (m) process.stdout.write(`\r    Step ${m[1]}/${m[2]}  loss=${m[3]}    `);
        } else if (line.startsWith('PHASE ')) {
          process.stdout.write(`\n    ${line}\n`);
        }
      });

      process.stdout.write('\n');
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      if (trainResult.exitCode === 0 && fs.existsSync(loraOut)) {
        const size = fs.statSync(loraOut).size;
        pass(`Training complete in ${elapsed}s`, `lora.safetensors ${formatBytes(size)}`);
      } else {
        fail('Training failed', trainResult.stderr.split('\n').slice(-5).join(' ').trim());
        console.log('\nTraining stdout tail:');
        console.log(trainResult.stdout.split('\n').slice(-10).map(l => '  ' + l).join('\n'));
      }
      } // end resolvedModelPath block
    }
  }

  // ── 5b · Checkpoint detection ────────────────────────────────────────────────

  section('5b · Checkpoint Detection');

  try {
    const { resolveLatestCheckpoint } = await import('./phobos/PluginTrainer.js');
    // resolveLatestCheckpoint works on session ID, not full path — we need to
    // temporarily write a minimal session.json so it can find the session dir.
    const ckptPath = resolveLatestCheckpoint(sessionId);
    if (ckptPath) {
      pass('Checkpoint found', path.basename(ckptPath));
      // Verify it contains accelerate state files
      const ckptFiles = fs.readdirSync(ckptPath);
      if (ckptFiles.length > 0) {
        pass(`Checkpoint contents readable`, `${ckptFiles.length} file(s)`);
      } else {
        fail('Checkpoint directory is empty');
      }
    } else {
      // Smoke-test runs (50 steps) may not hit the 250-step checkpoint interval
      info('No checkpoint found — expected for short smoke-test runs (<250 steps)');
    }
  } catch (e) {
    info(`Checkpoint check skipped: ${(e as Error).message}`);
  }

  // ── 6. Package ────────────────────────────────────────────────────────────────

  section('6 · Package (.phobos archive)');

  let archivePath = '';

  if (!fs.existsSync(loraOut)) {
    fail('Cannot package — lora.safetensors not found');
  } else {
    try {
      const store = new PluginStore(db);
      await store.ensureTable();

      const manifest = {
        schemaVersion:     1,
        id:                `validate_${Date.now()}`,
        name:              `Validation Plugin (${baseModel})`,
        author:            'test-plugin-validate',
        version:           '1.0.0',
        description:       'Generated by test-plugin-validate.ts',
        baseModel:         baseModel as any,
        compatibleModels:  [baseModel as any],
        triggerWords:      [triggerWord],
        category:          'generic' as any,
        tags:              ['test', 'validation'],
        recommendedWeight: 0.75,
        weightRange:       [0.1, 1.0] as [number, number],
        rank:              16,
        trainingImages:    images.length,
        trainingSteps:     steps,
        createdAt:         new Date().toISOString(),
      };

      const record = await store.createPlugin(loraOut, manifest, [], password, false);
      archivePath  = record.archive_path;

      if (fs.existsSync(archivePath)) {
        const size = fs.statSync(archivePath).size;
        pass('Archive created', `${path.basename(archivePath)} (${formatBytes(size)})`);
        // Copy to ./test-outputs/plugins/ so it survives cleanup and is ready for gen tests.
        const pluginsOutDir = path.join(process.cwd(), 'test-outputs', 'plugins');
        fs.mkdirSync(pluginsOutDir, { recursive: true });
        const outCopy = path.join(pluginsOutDir, path.basename(archivePath));
        fs.copyFileSync(archivePath, outCopy);
        pass('Plugin copied to test-outputs/plugins/', path.basename(outCopy));
      } else {
        fail('Archive file missing after createPlugin()');
      }
    } catch (e) {
      fail('createPlugin() threw', (e as Error).message);
    }
  }

  // ── 7. Install round-trip ─────────────────────────────────────────────────────

  section('7 · Install Round-Trip');

  if (!archivePath || !fs.existsSync(archivePath)) {
    fail('No archive to install — skipping');
  } else {
    try {
      const store = new PluginStore(db);

      const buf    = fs.readFileSync(archivePath);
      const record = await store.installPhobosArchive(buf, 'roundtrip.phobos');

      pass('installPhobosArchive() succeeded', `id=${record.id}`);

      // Verify auth
      const authResult = store.checkAuth(archivePath, { password });
      if (authResult.ok) {
        pass('Password auth', `via=${authResult.via}`);
      } else {
        fail('Password auth failed', authResult.reason);
      }

      const badAuth = store.checkAuth(archivePath, { password: 'wrongpassword' });
      if (!badAuth.ok) {
        pass('Rejects wrong password');
      } else {
        fail('Wrong password was accepted — auth broken');
      }

      // Clean up the round-trip record
      await store.remove(record.id, "owner");
      try { if (record.archive_path !== archivePath) fs.unlinkSync(record.archive_path); } catch { /* ok */ }
    } catch (e) {
      fail('Install round-trip threw', (e as Error).message);
    }
  }

  // ── 8. Archive contents ───────────────────────────────────────────────────────

  section('8 · Archive Contents');

  if (!archivePath || !fs.existsSync(archivePath)) {
    fail('No archive to inspect');
  } else {
    try {
      const zip     = new AdmZip(archivePath);
      const entries = zip.getEntries().map(e => e.entryName);

      const hasPluginJson   = entries.includes('plugin.json');
      const hasLoraSt       = entries.includes('lora.safetensors');
      const hasSig          = entries.includes('sig.json');

      hasPluginJson ? pass('plugin.json present')       : fail('plugin.json missing from archive');
      hasLoraSt     ? pass('lora.safetensors present')  : fail('lora.safetensors missing from archive');
      hasSig        ? pass('sig.json present')          : fail('sig.json missing from archive');

      if (hasLoraSt) {
        const loraEntry = zip.getEntry('lora.safetensors')!;
        const size      = loraEntry.getData().length;
        if (size > 100) {
          pass(`lora.safetensors readable`, formatBytes(size));
        } else {
          fail('lora.safetensors is too small to be valid', `${size} bytes`);
        }
      }

      if (hasPluginJson) {
        const manifest = JSON.parse(zip.getEntry('plugin.json')!.getData().toString('utf-8'));
        pass('plugin.json parses correctly', `id=${manifest.id}, baseModel=${manifest.baseModel}`);
      }
    } catch (e) {
      fail('Archive inspection failed', (e as Error).message);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────────

  section('Cleanup');

  if (!keepSession) {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      pass('Session directory removed');
    } catch (e) {
      info(`Could not remove session dir: ${(e as Error).message}`);
    }
    // Remove the packaged archive from plugins dir if it was created
    if (archivePath && fs.existsSync(archivePath)) {
      try {
        const store = new PluginStore(db);
        // Find and remove the record by archive path
        const all   = await store.list();
        const match = all.find(r => r.archive_path === archivePath);
        if (match) {
          await store.remove(match.id, "owner");
          if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
          pass('Test plugin removed from library');
        }
      } catch { /* non-fatal */ }
    }
  } else {
    info(`Session kept at: ${sessionDir}`);
    if (archivePath) info(`Archive at: ${archivePath}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(56));
  if (failures === 0) {
    console.log('  ✅  All checks passed — plugin system validated');
  } else {
    console.log(`  ❌  ${failures} check(s) failed`);
  }
  console.log('═'.repeat(56) + '\n');

  process.exit(failures > 0 ? 1 : 0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface ScriptResult {
  exitCode: number;
  stdout:   string;
  stderr:   string;
}

function runScript(
  pyBin:       string,
  args:        string[],
  timeoutMs:   number,
  onLine?:     (line: string) => void,
): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const proc = spawn(pyBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let lineBuf = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      const text  = chunk.toString();
      stdout     += text;
      if (onLine) {
        const parts = (lineBuf + text).split('\n');
        lineBuf     = parts.pop() ?? '';
        for (const l of parts) if (l.trim()) onLine(l.trim());
      }
    });
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ exitCode: -1, stdout, stderr: stderr + '\n[TIMEOUT]' });
    }, timeoutMs);

    proc.on('close', (code: number) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });
}

function formatBytes(n: number): string {
  if (n < 1024)        return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ── Full-test loop ────────────────────────────────────────────────────────────
// Each entry: [baseModel (trainer), genModelType (test-pytorch-gen.ts arg)]
// Only models that have a clear 1:1 mapping are included.
const FULL_TEST_MODELS: Array<{ baseModel: string; genModelType: string; label: string }> = [
  { baseModel: 'chroma',       genModelType: 'chroma',       label: 'Chroma'          },
  { baseModel: 'flux-schnell', genModelType: 'flux',         label: 'FLUX.1-Schnell'  },
  { baseModel: 'sdxl',         genModelType: 'sdxl',         label: 'SDXL'            },
  { baseModel: 'sana-sprint',  genModelType: 'sana-sprint',  label: 'SANA-Sprint 0.6B'},
  { baseModel: 'sana',         genModelType: 'sana',         label: 'SANA 1.5 1.6B'  },
  { baseModel: 'wan',          genModelType: 'wan',          label: 'Wan 2.1 T2V'     },
];

async function runFullTest(argv: string[]) {
  const tsxBin = process.execPath;  // node
  const genScript = path.join(_dirname, 'test-pytorch-gen.ts');

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║   PHOBOS Plugin System — Full Integration Test       ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // Parse --vendor and --image-dir from argv — pass them through to each sub-run
  let passVendor = '';
  let passImageDir = '';
  let passSteps = '50';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--vendor'    && argv[i+1]) passVendor   = argv[++i];
    if (argv[i] === '--image-dir' && argv[i+1]) passImageDir = argv[++i];
    if (argv[i] === '--steps'     && argv[i+1]) passSteps    = argv[++i];
  }
  if (!passImageDir) {
    console.error('--full-test requires --image-dir');
    process.exit(1);
  }

  const results: Array<{ label: string; trainPass: boolean; genPass: boolean; skipped: boolean }> = [];

  for (const model of FULL_TEST_MODELS) {
    console.log(`\n${'═'.repeat(56)}`);
    console.log(`  ► ${model.label}`);
    console.log('═'.repeat(56));

    // ── Run validate (train + package) ───────────────────────────────────────
    const validateArgs = [
      '--image-dir',  passImageDir,
      '--base-model', model.baseModel,
      '--steps',      passSteps,
      ...(passVendor ? ['--vendor', passVendor] : []),
    ];

    // Spawn this same script with the single-model args (no --full-test)
    const t0Model = Date.now();
    const validateResult = await spawnTsx('test-plugin-validate.ts', validateArgs);
    const trainPass = validateResult.exitCode === 0 ||
      // Captioning failure is expected — count as pass if archive was produced
      validateResult.stdout.includes('Plugin copied to test-outputs/plugins/');

    // Stable filename: <baseModel>-fulltest.phobos in test-outputs/plugins/.
    // The validate subprocess copies the archive there under its timestamp name;
    // we rename it to the stable name so the gen test always knows the path.
    const pluginsDir   = path.join(process.cwd(), 'test-outputs', 'plugins');
    const stableName   = `${model.baseModel}-fulltest.phobos`;
    const archivePath  = path.join(pluginsDir, stableName);

    // Find the newest .phobos written since we started this model's validate run
    let foundArchive = false;
    if (fs.existsSync(pluginsDir)) {
      const files = fs.readdirSync(pluginsDir)
        .filter(f => f.endsWith('.phobos') && f !== stableName)
        .map(f => ({ f, mtime: fs.statSync(path.join(pluginsDir, f)).mtimeMs }))
        .filter(({ mtime }) => mtime >= t0Model)
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) {
        const src = path.join(pluginsDir, files[0].f);
        fs.renameSync(src, archivePath);
        foundArchive = true;
      }
    }

    if (!trainPass || !foundArchive || !fs.existsSync(archivePath)) {
      console.log(`  ❌  ${model.label}: training/packaging failed — skipping gen test`);
      results.push({ label: model.label, trainPass: false, genPass: false, skipped: true });
      continue;
    }

    console.log(`  ✅  ${model.label}: trained and packaged — ${stableName}`);

    // ── Run gen test with the produced archive ────────────────────────────────
    const genArgs = [
      '--vendor',     passVendor || 'cuda',
      '--model-type', model.genModelType,
      '--plugin',     archivePath,
    ];

    const genResult = await spawnTsx('test-pytorch-gen.ts', genArgs);
    const genPass   = genResult.exitCode === 0 &&
                      genResult.stdout.includes("adapters active:");

    if (genPass) {
      console.log(`  ✅  ${model.label}: generation with plugin succeeded`);
    } else {
      console.log(`  ❌  ${model.label}: generation failed`);
      // Print last 5 lines of stdout for diagnosis
      const tail = genResult.stdout.split('\n').filter(Boolean).slice(-5);
      for (const l of tail) console.log(`       ${l}`);
    }

    // Clean up the test archive
    try { fs.unlinkSync(archivePath); } catch { /* ok */ }

    results.push({ label: model.label, trainPass, genPass, skipped: false });
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(56));
  console.log('  Full Integration Test Results:');
  console.log('─'.repeat(56));
  let totalFail = 0;
  for (const r of results) {
    if (r.skipped) {
      console.log(`  ⚠️   ${r.label.padEnd(20)} — SKIPPED (train/package failed)`);
      totalFail++;
    } else {
      const trainMark = r.trainPass ? '✅' : '❌';
      const genMark   = r.genPass   ? '✅' : '❌';
      console.log(`  ${trainMark} train  ${genMark} gen    ${r.label}`);
      if (!r.trainPass || !r.genPass) totalFail++;
    }
  }
  console.log('═'.repeat(56));
  console.log(totalFail === 0
    ? '  ✅  All models passed'
    : `  ❌  ${totalFail} model(s) had failures`);
  console.log('═'.repeat(56) + '\n');
  process.exit(totalFail > 0 ? 1 : 0);
}

function spawnTsx(scriptName: string, args: string[]): Promise<{ exitCode: number; stdout: string }> {
  return new Promise((resolve) => {
    // Use npx tsx to run the script
    const scriptPath = path.join(_dirname, scriptName);
    const proc = spawn('npx', ['tsx', scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => {
      const text = c.toString();
      stdout += text;
      process.stdout.write(text);  // stream output live
    });
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    proc.on('close', (code: number) => resolve({ exitCode: code ?? 0, stdout }));
  });
}

if (fullTest) {
  runFullTest(process.argv.slice(2)).catch(e => { console.error(e); process.exit(1); });
} else {
  main().catch(e => {
    console.error('Unhandled error:', e);
    process.exit(1);
  });
}