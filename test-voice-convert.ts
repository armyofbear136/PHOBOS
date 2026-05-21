/**
 * test-voice-convert.ts — manual test for the full WeClone TTS round-trip
 *
 * Tests the complete two-stage pipeline:
 *   Stage 1: Kokoro TTS synthesis (neutral base voice)
 *   Stage 2: VoiceConvertDaemon — HuBERT feature extraction + FAISS retrieval
 *            + WORLD vocoder synthesis with speaker identity applied
 *
 * Requires an existing voice profile (run test-voice-extract.ts first,
 * or pass --profile-id of an existing profile).
 *
 * Usage:
 *   # Use an existing profile by ID
 *   npx tsx test-voice-convert.ts --profile-id <uuid> --text "Hello, this is a test."
 *
 *   # Extract a new profile then run conversion (end-to-end test)
 *   npx tsx test-voice-convert.ts --ref-audio /path/to/ref.wav --text "Hello, this is a test." [--delete-after]
 *
 *   # Run multiple sentences to verify daemon stays resident
 *   npx tsx test-voice-convert.ts --profile-id <uuid> --text "First sentence." --text "Second sentence." --text "Third."
 *
 * Exit codes:
 *   0 — all conversions succeeded
 *   1 — any step failed
 */

import path from 'path';
import fs   from 'fs';

// ── arg parse ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

function flags(name: string): string[] {
  const results: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) results.push(args[++i]);
  }
  return results;
}

const profileId   = flag('--profile-id');
const refAudio    = flag('--ref-audio') ?? path.join(process.cwd(), 'test-outputs', 'audio', 'test.wav');
const refName     = flag('--name') ?? 'Convert Test Voice';
const sentences   = flags('--text');
const deleteAfter = args.includes('--delete-after');

if (!profileId && !refAudio) {
  console.error('Usage:');
  console.error('  npx tsx test-voice-convert.ts --profile-id <uuid> --text "Hello."');
  console.error('  npx tsx test-voice-convert.ts --ref-audio /path/to/ref.wav --text "Hello." [--delete-after]');
  process.exit(1);
}

if (sentences.length === 0) {
  console.error('[ERROR] At least one --text argument is required');
  process.exit(1);
}

// ── run ───────────────────────────────────────────────────────────────────────

import {
  createVoiceProfile,
  generateKokoroWithProfile,
  shutdownVcDaemon,
  deleteVoiceProfile,
  listVoiceProfiles,
} from './phobos/AudioServerManager.js';

function fileSize(p: string): string {
  try { return `${(fs.statSync(p).size / 1024).toFixed(1)} KB`; }
  catch { return 'not found'; }
}

async function main() {
  console.log('─────────────────────────────────────────');
  console.log('PHOBOS voice conversion round-trip test');
  console.log('─────────────────────────────────────────');

  // ── Step 1: resolve or create profile ─────────────────────────────────────

  let resolvedProfileId: string;

  if (profileId) {
    const existing = listVoiceProfiles().find(p => p.id === profileId);
    if (!existing) {
      console.error(`[ERROR] Profile not found: ${profileId}`);
      console.error('Available profiles:');
      listVoiceProfiles().forEach(p => console.error(`  ${p.id}  ${p.name}`));
      process.exit(1);
    }
    resolvedProfileId = profileId;
    console.log(`Using existing profile: ${existing.name} (${resolvedProfileId})`);
  } else {
    if (!fs.existsSync(refAudio!)) {
      console.error(`[ERROR] ref-audio not found: ${refAudio}`);
      console.error('Place a WAV file at .\\test-outputs\\audio\\test.wav or pass --ref-audio /path/to/ref.wav');
      process.exit(1);
    }
    console.log(`Extracting new profile from: ${refAudio}`);
    console.log('');
    try {
      const profile = await createVoiceProfile({
        refAudioPath: refAudio!,
        name:         refName,
        onProgress:   (line) => console.log(`  [extract] ${line}`),
      });
      resolvedProfileId = profile.id;
      console.log(`\nProfile created: ${profile.name} (${resolvedProfileId})`);
      console.log(`  SNR: ${profile.snrDb} dB  |  Duration: ${profile.durationSec}s  |  Embedding: ${profile.embedding.length}d`);
    } catch (err) {
      console.error(`\n[FAIL] Profile extraction failed: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  // ── Step 2: run conversion for each sentence ───────────────────────────────

  console.log('');
  console.log(`Running ${sentences.length} conversion job${sentences.length > 1 ? 's' : ''}...`);
  console.log('');

  const outputDir = path.join(process.cwd(), 'test-outputs', 'audio', `vc-${Date.now()}`);
  fs.mkdirSync(outputDir, { recursive: true });

  let allPassed  = true;
  const results: Array<{ sentence: string; outputPath: string; elapsedMs: number; ok: boolean }> = [];

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    console.log(`  [${i + 1}/${sentences.length}] "${sentence.slice(0, 60)}${sentence.length > 60 ? '…' : ''}"`);
    const t0 = Date.now();
    try {
      const result = await generateKokoroWithProfile({
        profileId: resolvedProfileId,
        threadId:  'test',
        text:      sentence,
        speed:     1.0,
        label:     'test',
      });
      const elapsed = Date.now() - t0;

      // Copy output to a stable named location for inspection
      const destPath = path.join(outputDir, `sentence-${i + 1}.wav`);
      fs.copyFileSync(result.outputPath, destPath);
      try { fs.unlinkSync(result.outputPath); } catch { /* best-effort cleanup */ }

      const size = fileSize(destPath);
      console.log(`         ✓ ${elapsed}ms  →  ${destPath}  (${size})`);
      results.push({ sentence, outputPath: destPath, elapsedMs: elapsed, ok: true });
    } catch (err) {
      const elapsed = Date.now() - t0;
      console.error(`         ✗ ${elapsed}ms  FAILED: ${(err as Error).message}`);
      results.push({ sentence, outputPath: '', elapsedMs: elapsed, ok: false });
      allPassed = false;
    }
  }

  // ── Step 3: daemon lifecycle check ────────────────────────────────────────

  console.log('');
  console.log('Shutting down VoiceConvertDaemon...');
  shutdownVcDaemon(resolvedProfileId);
  console.log('  ✓ daemon shut down cleanly');

  // ── Step 4: summary ───────────────────────────────────────────────────────

  console.log('');
  console.log('─────────────────────────────────────────');
  console.log(`${allPassed ? '[PASS]' : '[FAIL]'} ${results.filter(r => r.ok).length}/${results.length} conversions succeeded`);
  console.log('─────────────────────────────────────────');

  if (results.some(r => r.ok)) {
    const times = results.filter(r => r.ok).map(r => r.elapsedMs);
    const avg   = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    const min   = Math.min(...times);
    const max   = Math.max(...times);
    console.log(`Latency — avg: ${avg}ms  min: ${min}ms  max: ${max}ms`);
    console.log(`Output files: ${outputDir}`);
  }

  // ── Step 5: cleanup ───────────────────────────────────────────────────────

  if (deleteAfter && !profileId) {
    // Only auto-delete profiles we created in this run
    deleteVoiceProfile(resolvedProfileId);
    console.log(`\n[cleanup] Profile ${resolvedProfileId} deleted`);
  } else if (!profileId) {
    console.log(`\nProfile retained: ${resolvedProfileId}`);
    console.log('Pass --delete-after to clean up, or use DELETE /api/audio/voice-profiles/:id');
  }

  console.log('\n[DONE]');
  process.exit(allPassed ? 0 : 1);
}

main();