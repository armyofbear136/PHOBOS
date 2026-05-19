// test-audio-generative.ts — Generative audio pipeline smoke test.
//
// Tests each audio runner in sequence: Kokoro TTS, Whisper STT (round-trip),
// ACE-Step music generation, and F5-TTS voice cloning.
//
// Run from phobos-core (dev):
//
//   PHOBOS_BIN_DIR=dist tsx test-audio-generative.ts
//
// Or with individual runner and hardware flags:
//
//   PHOBOS_BIN_DIR=dist tsx test-audio-generative.ts --only kokoro
//   PHOBOS_BIN_DIR=dist tsx test-audio-generative.ts --only whisper
//   PHOBOS_BIN_DIR=dist tsx test-audio-generative.ts --only acestep
//   PHOBOS_BIN_DIR=dist tsx test-audio-generative.ts --only f5tts
//   PHOBOS_BIN_DIR=dist tsx test-audio-generative.ts --skip acestep
//
//   # Force a specific PyTorch backend venv (cuda | rocm | xpu | apple | cpu):
//   PHOBOS_BIN_DIR=dist tsx test-audio-generative.ts --backend rocm
//   PHOBOS_BIN_DIR=dist tsx test-audio-generative.ts --backend xpu --only f5tts
//
//   # Force a specific GPU device index (default: auto-selects first ready GPU):
//   PHOBOS_BIN_DIR=dist tsx test-audio-generative.ts --backend cuda --device-index 1
//
// Prerequisites — everything must be in place before running:
//
//   dist/
//     kokoro/model_quantized.onnx
//     ace-lm.exe / ace-lm
//     ace-synth.exe / ace-synth
//     whisper-cli.exe / whisper-cli
//     whisper.dll  ggml-base.dll  ggml-cpu.dll  ggml.dll   (Windows DLLs)
//
//   ~/.phobos/models/audio/
//     whisper/whisper-large-v3/ggml-large-v3.bin
//     acestep/acestep-5Hz-lm-1.7B-Q8_0.gguf
//     acestep/acestep-v15-sft-Q8_0.gguf
//     acestep/vae-BF16.gguf
//     acestep/Qwen3-Embedding-0.6B-Q8_0.gguf
//     f5-tts/f5-tts-v1-base/F5TTS_v1_Base/model_1250000.safetensors
//     f5-tts/f5-tts-v1-base/F5TTS_v1_Base/vocab.txt
//
//   npm install kokoro-js   (for Kokoro in-process test)

import * as fs   from 'node:fs';
import * as path from 'node:path';

import {
  generateKokoro,
  generateAceStep,
  generateF5Tts,
  transcribe,
  ensureAudioWorkspace,
  type AudioRunOptions,
} from './phobos/AudioServerManager.js';

// ── CLI args ──────────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const skipIdx = args.indexOf('--skip');
const backendIdx = args.indexOf('--backend');
const deviceIdxFlag = args.indexOf('--device-index');
const onlyRunner    = onlyIdx    !== -1 ? args[onlyIdx    + 1] : null;
const skipRunner    = skipIdx    !== -1 ? args[skipIdx    + 1] : null;
/** Force a specific PyTorch vendor venv: cuda | rocm | xpu | apple | cpu */
const overrideVendor      = backendIdx    !== -1 ? args[backendIdx    + 1] : undefined;
/** Force a specific GPU device index */
const overrideDeviceIndex = deviceIdxFlag !== -1 ? parseInt(args[deviceIdxFlag + 1], 10) : undefined;

function shouldRun(name: string): boolean {
  if (skipRunner && skipRunner === name) return false;
  if (onlyRunner) return onlyRunner === name;
  return true;
}

// ── Test workspace ────────────────────────────────────────────────────────────
// All test output stays under ./test-outputs/audiogen/ — never touches the user
// home directory. WORKSPACES_ROOT is set here so AudioServerManager writes to
// the same location.

const TEST_THREAD_ID = `audio-test-${Date.now()}`;
const TEST_OUTPUTS_ROOT = path.join(process.cwd(), 'test-outputs', 'audiogen');
const TEST_DIR = path.join(TEST_OUTPUTS_ROOT, TEST_THREAD_ID);

// Point AudioServerManager at the same root so all generated files land in
// test-outputs/audiogen/<id>/audio/{tts,music,sfx} — not the user workspace.
process.env.WORKSPACES_ROOT = TEST_OUTPUTS_ROOT;

// ── Phase harness (matches test-phobos-host.ts pattern) ──────────────────────

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

// ── Progress printer ──────────────────────────────────────────────────────────

function makeProgress(prefix: string): AudioRunOptions['onProgress'] {
  return (line: string) => {
    process.stdout.write(`       ${prefix}: ${line}\n`);
  };
}

// ── WAV file validator ────────────────────────────────────────────────────────
// Checks RIFF header and minimum file size — does not decode audio.

function validateWav(filePath: string, minBytes: number = 44_100): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Output file not found: ${filePath}`);
  }
  const size = fs.statSync(filePath).size;
  if (size < minBytes) {
    throw new Error(`Output file too small: ${size} bytes (expected ≥ ${minBytes})`);
  }
  const fd = fs.openSync(filePath, 'r');
  const header = Buffer.alloc(12);
  fs.readSync(fd, header, 0, 12, 0);
  fs.closeSync(fd);
  const riff = header.toString('ascii', 0, 4);
  const wave = header.toString('ascii', 8, 12);
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new Error(`Output is not a valid WAV file (got: "${riff}"..."${wave}")`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('PHOBOS Audio Generative Pipeline — Smoke Test');
  console.log(`Test workspace: ${TEST_DIR}`);
  console.log(`PHOBOS_BIN_DIR: ${process.env.PHOBOS_BIN_DIR ?? '(not set — using process.execPath dir)'}`);
  if (onlyRunner) console.log(`Running only: ${onlyRunner}`);
  if (skipRunner) console.log(`Skipping: ${skipRunner}`);
  if (overrideVendor)      console.log(`Backend override: ${overrideVendor}`);
  if (overrideDeviceIndex !== undefined) console.log(`Device index override: ${overrideDeviceIndex}`);
  console.log('');

  // ── Phase 1: workspace setup ───────────────────────────────────────────────

  await runPhase('Workspace setup', async () => {
    ensureAudioWorkspace(TEST_THREAD_ID);
    const dirs = ['tts', 'music', 'sfx'].map(c =>
      path.join(TEST_DIR, 'audio', c)
    );
    for (const d of dirs) {
      if (!fs.existsSync(d)) throw new Error(`Directory not created: ${d}`);
    }
    console.log(`       Created: ${dirs.join('\n                ')}`);
  });

  // ── Phase 2: Kokoro TTS ────────────────────────────────────────────────────

  let kokoroOutputPath: string | null = null;

  if (shouldRun('kokoro')) {
    await runPhase('Kokoro TTS — synthesis', async () => {
      const result = await generateKokoro({
        threadId: TEST_THREAD_ID,
        text:     'PHOBOS audio system online. Text to speech test successful.',
        voice:    'af_heart',
        speed:    1.0,
        label:    'test-kokoro',
        onProgress: makeProgress('kokoro'),
      });
      kokoroOutputPath = result.outputPath;
      validateWav(result.outputPath, 20_000);
      console.log(`       Output: ${result.outputPath} (${result.elapsedMs} ms)`);
    });
  } else {
    skipPhase('Kokoro TTS — synthesis', '--only/--skip flag');
  }

  // ── Phase 3: Whisper STT — transcribe the Kokoro output ───────────────────
  // Round-trip test: TTS → WAV → STT → check text contains expected words.

  if (shouldRun('whisper')) {
    await runPhase('Whisper STT — transcribe Kokoro output', async () => {
      // Use the Kokoro output if available, otherwise use a known test WAV.
      const audioPath = kokoroOutputPath ?? (() => {
        // Check if there's any existing TTS wav in the workspace we can reuse
        const ttsDir = path.join(TEST_OUTPUTS_ROOT, TEST_THREAD_ID, 'audio', 'tts');
        const wavs = fs.existsSync(ttsDir)
          ? fs.readdirSync(ttsDir).filter(f => f.endsWith('.wav'))
          : [];
        if (wavs.length === 0) {
          throw new Error(
            'No input audio for transcription. Run Kokoro phase first, or ' +
            'provide a WAV at the TTS workspace path.'
          );
        }
        return path.join(ttsDir, wavs[0]);
      })();

      const text = await transcribe({
        audioPath,
        language: 'en',
        onProgress: makeProgress('whisper'),
      });

      if (!text || text.length < 5) {
        throw new Error(`Transcription returned empty or very short text: "${text}"`);
      }

      // Loose check — whisper may not be word-perfect but should contain key words
      const lowerText = text.toLowerCase();
      const expectedWords = ['phobos', 'audio', 'text'];
      const foundWords = expectedWords.filter(w => lowerText.includes(w));

      console.log(`       Transcript: "${text}"`);
      console.log(`       Key words found: ${foundWords.join(', ')} (${foundWords.length}/${expectedWords.length})`);

      if (foundWords.length === 0) {
        throw new Error(
          `Transcription did not contain any expected words.\n` +
          `Expected one of: ${expectedWords.join(', ')}\n` +
          `Got: "${text}"`
        );
      }
    });
  } else {
    skipPhase('Whisper STT — transcribe Kokoro output', '--only/--skip flag');
  }

  // ── Phase 4: ACE-Step music generation ────────────────────────────────────
  // This is the slow GPU phase — generates a 10-second clip.

  if (shouldRun('acestep')) {
    await runPhase('ACE-Step — music generation (10s clip)', async () => {
      const result = await generateAceStep({
        threadId:            TEST_THREAD_ID,
        prompt:              'ambient electronic, soft synthesizer pads, 80bpm, calm',
        duration:            10,
        steps:               30,
        cfgStrength:         7.0,
        seed:                42,
        label:               'test-acestep',
        onProgress:          makeProgress('ace-step'),
        overrideVendor,
        overrideDeviceIndex,
      });
      validateWav(result.outputPath, 100_000); // 10s @ 44100 Hz stereo 16-bit ≈ 1.7 MB
      console.log(`       Output: ${result.outputPath} (${result.elapsedMs} ms)`);
      console.log(`       RTF: ${(result.elapsedMs / 10_000).toFixed(2)} (${result.elapsedMs}ms / 10000ms)`);
    });
  } else {
    skipPhase('ACE-Step — music generation (10s clip)', '--only/--skip flag');
  }

  // ── Phase 5: F5-TTS synthesis ──────────────────────────────────────────────

  if (shouldRun('f5tts')) {
    await runPhase('F5-TTS — standard synthesis', async () => {
      const result = await generateF5Tts({
        threadId:            TEST_THREAD_ID,
        text:                'F5 text to speech engine is operational.',
        mode:                'tts',
        speed:               1.0,
        steps:               16,
        label:               'test-f5tts',
        onProgress:          makeProgress('f5-tts'),
        overrideVendor,
        overrideDeviceIndex,
      });
      validateWav(result.outputPath, 20_000);
      console.log(`       Output: ${result.outputPath} (${result.elapsedMs} ms)`);
    });
  } else {
    skipPhase('F5-TTS — standard synthesis', '--only/--skip flag');
  }

  // ── Phase 6: output file inventory ────────────────────────────────────────

  await runPhase('Output file inventory', async () => {
    const audioDir = path.join(TEST_DIR, 'audio');
    let totalFiles = 0;
    let totalBytes = 0;
    for (const category of ['tts', 'music', 'sfx']) {
      const catDir = path.join(audioDir, category);
      if (!fs.existsSync(catDir)) continue;
      const files = fs.readdirSync(catDir).filter(f => f.endsWith('.wav'));
      for (const f of files) {
        const size = fs.statSync(path.join(catDir, f)).size;
        totalFiles++;
        totalBytes += size;
        console.log(`       ${category}/${f} — ${(size / 1024).toFixed(0)} KB`);
      }
    }
    console.log(`       Total: ${totalFiles} file(s), ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
    if (totalFiles === 0 && !onlyRunner) {
      throw new Error('No output files found — all generation phases may have failed');
    }
  });

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log('\n── Summary ──');
  for (const r of results) {
    const tag = r.status === 'ok'   ? '[OK]  '
              : r.status === 'skip' ? '[SKIP]'
              : '[FAIL]';
    const extra = r.message ? `  — ${r.message}` : r.ms > 0 ? ` (${r.ms} ms)` : '';
    console.log(`${tag} ${r.name}${extra}`);
  }

  const failed  = results.filter(r => r.status === 'fail').length;
  const skipped = results.filter(r => r.status === 'skip').length;
  const passed  = results.filter(r => r.status === 'ok').length;

  console.log('');
  if (failed > 0) {
    console.error(`${failed} phase(s) FAILED — ${passed} passed, ${skipped} skipped`);
    process.exitCode = 1;
  } else {
    console.log(`OK — ${passed} passed, ${skipped} skipped`);
  }

  // Leave the workspace in place for inspection — don't auto-delete on success.
  console.log(`\nOutputs in: ${TEST_DIR}`);
}

main().catch((err) => {
  console.error(`\n[fatal] ${(err as Error).message}`);
  process.exitCode = 1;
});