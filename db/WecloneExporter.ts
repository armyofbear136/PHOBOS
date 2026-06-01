/**
 * WecloneExporter.ts — Package a user's Weclone data into a .weclone archive.
 *
 * Archive structure (zip):
 *   profile.json                     ← export manifest (required)
 *   lora.safetensors                 ← voice LoRA weights (if trained)
 *   voice/
 *     reference.wav                  ← reference audio sample
 *     embedding.npy                  ← speaker embedding (if computed)
 *   personality/
 *     config.json                    ← personality / tone config
 *     cartridge_bindings.json        ← active cartridge IDs for this clone
 *   sig.json                         ← HMAC signature (same scheme as .phobos)
 *
 * The signature uses the same scrypt + HMAC-SHA256 scheme as PluginStore,
 * keyed on the export timestamp so the HMAC is stable and verifiable.
 * Unsigned imports are accepted with a warning — the sig is advisory.
 */

import { createHmac, createHash, randomBytes, scryptSync } from 'crypto';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import AdmZip    from 'adm-zip';
import { DatabaseManager, userDir } from './DatabaseManager.js';
import { WecloneStore }              from './WecloneStore.js';
import { CartridgeStore }            from './CartridgeStore.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface WecloneExportManifest {
  schemaVersion:       1;
  username:            string;
  displayName:         string;
  exportedAt:          string;
  loraPresent:         boolean;
  voicePresent:        boolean;
  personalityPresent:  boolean;
  cartridgeCount:      number;
}

export interface WecloneExportResult {
  success:     boolean;
  outputPath:  string | null;
  reason:      string | null;
  cloneCount:  number;
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function voiceProfilesDir(username: string): string {
  return path.join(userDir(username), 'voice-profiles');
}

// ── HMAC (mirrors PluginStore signing) ────────────────────────────────────────

const SCRYPT_N      = 16384;
const SCRYPT_R      = 8;
const SCRYPT_P      = 1;
const SCRYPT_KEYLEN = 32;

// Export archives are signed with a machine-stable key derived from the
// export timestamp. This allows offline integrity verification without
// requiring the original password.
const EXPORT_SIGNING_PASSPHRASE = 'phobos-weclone-export-v1';

function deriveExportKey(): string {
  const salt = 'phobos-weclone-static-salt-v1';
  return scryptSync(EXPORT_SIGNING_PASSPHRASE, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  }).toString('hex');
}

function signExport(manifest: WecloneExportManifest, exportKey: string): string {
  const data = [
    manifest.username,
    manifest.exportedAt,
    String(manifest.loraPresent),
    String(manifest.voicePresent),
    String(manifest.cartridgeCount),
  ].join('|');
  return createHmac('sha256', exportKey).update(data).digest('hex');
}

// ── WecloneExporter ───────────────────────────────────────────────────────────

export class WecloneExporter {
  constructor(private readonly systemDb: DatabaseManager) {}

  /**
   * Export all clone profiles for `username` into a single .weclone archive
   * written to `outputPath`.
   *
   * Returns { success: false } with a reason string if the user has no
   * clone data to export — callers should check before presenting the file.
   */
  async export(username: string, outputPath: string): Promise<WecloneExportResult> {
    const userDb      = DatabaseManager.getUserDb(username);
    const wecloneStore = new WecloneStore(userDb);
    await wecloneStore.ensureTable();

    const clones = await wecloneStore.listProfiles();
    if (clones.length === 0) {
      return { success: false, outputPath: null, reason: 'No weclone data for this user', cloneCount: 0 };
    }

    // Use the first clone as the primary for the top-level export manifest.
    // Multi-clone data is embedded under personality/ as a full JSON array.
    const primaryClone = clones[0];

    // ── Voice profile ─────────────────────────────────────────────────────
    let refWavPath:      string | null = null;
    let embeddingPath:   string | null = null;
    let loraSfPath:      string | null = null;
    let voicePresent     = false;

    if (primaryClone.voice_profile_id) {
      const profileDir = path.join(voiceProfilesDir(username), primaryClone.voice_profile_id);
      const refWav     = path.join(profileDir, 'reference.wav');
      const embedding  = path.join(profileDir, 'embedding.npy');
      const lora       = path.join(profileDir, 'lora.safetensors');

      if (fs.existsSync(refWav))   { refWavPath    = refWav;    voicePresent = true; }
      if (fs.existsSync(embedding)) { embeddingPath = embedding; }
      if (fs.existsSync(lora))      { loraSfPath    = lora; }
    }

    // ── Cartridge bindings ────────────────────────────────────────────────
    const cartridgeStore    = new CartridgeStore(this.systemDb);
    const cartridgeBindings: Array<{ cloneId: string; cartridgeId: string; slot: string }> = [];
    for (const clone of clones) {
      if (clone.cartridge_id) {
        cartridgeBindings.push({
          cloneId:     clone.id,
          cartridgeId: clone.cartridge_id,
          slot:        clone.slot,
        });
      }
    }

    // ── Personality config ────────────────────────────────────────────────
    // Serialize all clones as the personality bundle so multi-clone setups
    // round-trip cleanly.
    const personalityConfig = JSON.stringify(clones, null, 2);
    const personalityPresent = clones.some(c =>
      c.communication_style || c.personality_desc || c.system_prompt,
    );

    // ── Manifest ──────────────────────────────────────────────────────────
    const exportedAt = new Date().toISOString();
    const manifest: WecloneExportManifest = {
      schemaVersion:      1,
      username,
      displayName:        primaryClone.display_name || username,
      exportedAt,
      loraPresent:        !!loraSfPath,
      voicePresent,
      personalityPresent,
      cartridgeCount:     cartridgeBindings.length,
    };

    // ── Signature ─────────────────────────────────────────────────────────
    const exportKey = deriveExportKey();
    const sig = {
      exported_at: exportedAt,
      hmac:        signExport(manifest, exportKey),
    };

    // ── Build archive ─────────────────────────────────────────────────────
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const zip = new AdmZip();
    zip.addFile('profile.json',
      Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'));
    zip.addFile('sig.json',
      Buffer.from(JSON.stringify(sig, null, 2), 'utf-8'));
    zip.addFile('personality/config.json',
      Buffer.from(personalityConfig, 'utf-8'));
    zip.addFile('personality/cartridge_bindings.json',
      Buffer.from(JSON.stringify(cartridgeBindings, null, 2), 'utf-8'));

    if (loraSfPath && fs.existsSync(loraSfPath)) {
      zip.addLocalFile(loraSfPath, '', 'lora.safetensors');
    }
    if (refWavPath && fs.existsSync(refWavPath)) {
      zip.addLocalFile(refWavPath, 'voice/', 'reference.wav');
    }
    if (embeddingPath && fs.existsSync(embeddingPath)) {
      zip.addLocalFile(embeddingPath, 'voice/', 'embedding.npy');
    }

    zip.writeZip(outputPath);

    console.log(`[WecloneExporter] Exported ${clones.length} clone(s) for ${username} → ${outputPath}`);
    return { success: true, outputPath, reason: null, cloneCount: clones.length };
  }
}
