/**
 * test-voice-extract.ts — manual test for phobos-voice-extract.py
 *
 * Tests the full one-shot voice profile extraction pipeline:
 *   1. Validates the reference audio (SNR, duration)
 *   2. Extracts ECAPA-TDNN speaker embedding
 *   3. Builds HuBERT FAISS index
 *   4. Writes profile.json + index.faiss + ref.wav
 *
 * Usage:
 *   npx tsx test-voice-extract.ts --ref-audio /path/to/ref.wav [--name "My Voice"] [--ref-text "optional transcript"]
 *   npx tsx test-voice-extract.ts --ref-audio /path/to/ref.wav --delete-after
 *
 * Exit codes:
 *   0 — extraction succeeded, profile written
 *   1 — extraction failed (see stderr)
 */

import path from 'path';
import os   from 'os';
import fs   from 'fs';

// ── arg parse ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const refAudio   = flag('--ref-audio') ?? path.join(process.cwd(), 'test-outputs', 'audio', 'test.wav');
const name       = flag('--name') ?? 'Test Voice';
const refText    = flag('--ref-text');
const deleteAfter = args.includes('--delete-after');

if (!fs.existsSync(refAudio)) {
  console.error(`[ERROR] ref-audio not found: ${refAudio}`);
  console.error('Place a WAV file at .\\test-outputs\\audio\\test.wav or pass --ref-audio /path/to/ref.wav');
  process.exit(1);
}

// ── run ───────────────────────────────────────────────────────────────────────

import { createVoiceProfile, listVoiceProfiles, deleteVoiceProfile } from './phobos/AudioServerManager.js';

async function main() {
  console.log('─────────────────────────────────────────');
  console.log('PHOBOS voice profile extraction test');
  console.log('─────────────────────────────────────────');
  console.log(`ref-audio : ${refAudio}`);
  console.log(`name      : ${name}`);
  if (refText) console.log(`ref-text  : ${refText}`);
  console.log('');

  const t0 = Date.now();

  let profile;
  try {
    profile = await createVoiceProfile({
      refAudioPath: refAudio!,
      name,
      refText,
      onProgress: (line) => console.log(`  ${line}`),
    });
  } catch (err) {
    console.error(`\n[FAIL] ${(err as Error).message}`);
    process.exit(1);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('');
  console.log('─────────────────────────────────────────');
  console.log(`[PASS] Extraction complete in ${elapsed}s`);
  console.log('─────────────────────────────────────────');
  console.log(`id           : ${profile.id}`);
  console.log(`name         : ${profile.name}`);
  console.log(`duration     : ${profile.durationSec}s`);
  console.log(`snr          : ${profile.snrDb} dB`);
  console.log(`embedding    : ${profile.embedding.length} dims`);
  console.log(`refText      : ${profile.refText ? `"${profile.refText.slice(0, 60)}${profile.refText.length > 60 ? '…' : ''}"` : '(none)'}`);
  console.log(`extractVersion: ${profile.extractVersion}`);

  // Verify files on disk
  const profileDir = path.join(os.homedir(), '.phobos', 'voice-profiles', profile.id);
  const files      = ['profile.json', 'index.faiss', 'ref.wav'];
  console.log('');
  console.log('Files written:');
  let allPresent = true;
  for (const f of files) {
    const p    = path.join(profileDir, f);
    const size = fs.existsSync(p) ? fs.statSync(p).size : null;
    const ok   = size !== null && size > 0;
    console.log(`  ${ok ? '✓' : '✗'} ${f}${size !== null ? ` (${(size / 1024).toFixed(1)} KB)` : ' — MISSING'}`);
    if (!ok) allPresent = false;
  }

  // Verify listVoiceProfiles sees it
  const list  = listVoiceProfiles();
  const found = list.some(p => p.id === profile.id);
  console.log(`  ${found ? '✓' : '✗'} listVoiceProfiles() returns this profile`);

  if (!allPresent || !found) {
    console.error('\n[FAIL] One or more checks failed');
    process.exit(1);
  }

  if (deleteAfter) {
    deleteVoiceProfile(profile.id);
    const gone = !fs.existsSync(profileDir);
    console.log(`\n[cleanup] deleteVoiceProfile: ${gone ? '✓ deleted' : '✗ directory still exists'}`);
  } else {
    console.log(`\nProfile stored at: ${profileDir}`);
    console.log('Pass --delete-after to clean up automatically, or use the DELETE /api/audio/voice-profiles/:id route.');
  }

  console.log('\n[DONE]');
}

main();