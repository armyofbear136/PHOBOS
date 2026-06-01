/**
 * WecloneImporter.ts — Install a .weclone archive into a target user's slot.
 *
 * Validates the archive structure, extracts files to the user's weclone dir,
 * registers voice profile metadata, and creates/updates clone DB rows.
 *
 * Signature verification is advisory — unsigned or mismatched-sig archives
 * are accepted with a warning rather than rejected. This allows archives
 * created on other machines or shared between users to import cleanly.
 */

import { createHmac, scryptSync } from 'crypto';
import * as fs   from 'fs';
import * as path from 'path';
import AdmZip    from 'adm-zip';
import { DatabaseManager, userDir } from './DatabaseManager.js';
import { WecloneStore, type WecloneProfileRow } from './WecloneStore.js';
import type { WecloneExportManifest }            from './WecloneExporter.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RestoredItem {
  type:    'voice' | 'lora' | 'personality' | 'clone_profile';
  name:    string;
  detail?: string;
}

export interface WecloneImportResult {
  success:       boolean;
  reason:        string | null;
  cloneCount:    number;
  restoredItems: RestoredItem[];
  warnings:      string[];
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function voiceProfilesDir(username: string): string {
  return path.join(userDir(username), 'voice-profiles');
}

function wecloneImportDir(username: string): string {
  return path.join(userDir(username), 'weclone');
}

// ── Signature verification ────────────────────────────────────────────────────

const SCRYPT_N      = 16384;
const SCRYPT_R      = 8;
const SCRYPT_P      = 1;
const SCRYPT_KEYLEN = 32;

const EXPORT_SIGNING_PASSPHRASE = 'phobos-weclone-export-v1';

function deriveExportKey(): string {
  const salt = 'phobos-weclone-static-salt-v1';
  return scryptSync(EXPORT_SIGNING_PASSPHRASE, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  }).toString('hex');
}

function verifyExportSig(manifest: WecloneExportManifest, hmac: string): boolean {
  const exportKey = deriveExportKey();
  const data = [
    manifest.username,
    manifest.exportedAt,
    String(manifest.loraPresent),
    String(manifest.voicePresent),
    String(manifest.cartridgeCount),
  ].join('|');
  const expected = createHmac('sha256', exportKey).update(data).digest('hex');
  return expected === hmac;
}

// ── WecloneImporter ───────────────────────────────────────────────────────────

export class WecloneImporter {
  constructor(private readonly systemDb: DatabaseManager) {}

  /**
   * Import a .weclone archive, installing its contents for `targetUsername`.
   *
   * - Voice profile extracted to ~/.phobos/users/<targetUsername>/voice-profiles/<id>/
   * - LoRA weights extracted alongside the voice profile
   * - Personality config applied to create or update clone DB rows
   * - Cartridge bindings recorded but not auto-activated (the cartridges may
   *   not be installed on this machine)
   */
  async import(archivePath: string, targetUsername: string): Promise<WecloneImportResult> {
    const warnings: string[]      = [];
    const restoredItems: RestoredItem[] = [];

    // ── Validate archive ──────────────────────────────────────────────────
    if (!fs.existsSync(archivePath)) {
      return { success: false, reason: `Archive not found: ${archivePath}`, cloneCount: 0, restoredItems, warnings };
    }

    let zip: AdmZip;
    try {
      zip = new AdmZip(archivePath);
    } catch {
      return { success: false, reason: 'Invalid archive — could not open as zip', cloneCount: 0, restoredItems, warnings };
    }

    const manifestEntry = zip.getEntry('profile.json');
    if (!manifestEntry) {
      return { success: false, reason: 'Invalid .weclone archive: missing profile.json', cloneCount: 0, restoredItems, warnings };
    }

    let manifest: WecloneExportManifest;
    try {
      manifest = JSON.parse(manifestEntry.getData().toString('utf-8')) as WecloneExportManifest;
    } catch {
      return { success: false, reason: 'Invalid .weclone archive: profile.json is not valid JSON', cloneCount: 0, restoredItems, warnings };
    }

    if (manifest.schemaVersion !== 1) {
      return { success: false, reason: `Unsupported .weclone schema version: ${manifest.schemaVersion}`, cloneCount: 0, restoredItems, warnings };
    }

    // ── Signature check (advisory) ────────────────────────────────────────
    const sigEntry = zip.getEntry('sig.json');
    if (sigEntry) {
      try {
        const sig = JSON.parse(sigEntry.getData().toString('utf-8')) as { hmac?: string };
        if (sig.hmac && !verifyExportSig(manifest, sig.hmac)) {
          warnings.push('Archive signature mismatch — contents may have been modified. Import continued.');
        }
      } catch {
        warnings.push('Could not read sig.json — signature not verified. Import continued.');
      }
    } else {
      warnings.push('Archive has no sig.json — unsigned import. Proceeding.');
    }

    // ── Validate required files ───────────────────────────────────────────
    if (manifest.loraPresent && !zip.getEntry('lora.safetensors')) {
      warnings.push('profile.json declares loraPresent but lora.safetensors is missing. Voice LoRA skipped.');
    }
    if (manifest.voicePresent && !zip.getEntry('voice/reference.wav')) {
      warnings.push('profile.json declares voicePresent but voice/reference.wav is missing. Voice skipped.');
    }

    // ── Prepare extraction dirs ───────────────────────────────────────────
    const importDir  = wecloneImportDir(targetUsername);
    const vpDir      = voiceProfilesDir(targetUsername);
    fs.mkdirSync(importDir, { recursive: true });
    fs.mkdirSync(vpDir,     { recursive: true });

    // Use the original username as the voice profile ID for stable re-import.
    const voiceProfileId = `weclone_${manifest.username}`;
    const profileDir     = path.join(vpDir, voiceProfileId);
    fs.mkdirSync(profileDir, { recursive: true });

    // ── Extract voice files ───────────────────────────────────────────────
    let voiceProfileInstalled = false;

    const refWavEntry = zip.getEntry('voice/reference.wav');
    if (refWavEntry) {
      fs.writeFileSync(path.join(profileDir, 'reference.wav'), refWavEntry.getData());
      voiceProfileInstalled = true;
      restoredItems.push({ type: 'voice', name: 'reference.wav', detail: profileDir });
    }

    const embeddingEntry = zip.getEntry('voice/embedding.npy');
    if (embeddingEntry) {
      fs.writeFileSync(path.join(profileDir, 'embedding.npy'), embeddingEntry.getData());
      restoredItems.push({ type: 'voice', name: 'embedding.npy' });
    }

    const loraEntry = zip.getEntry('lora.safetensors');
    if (loraEntry) {
      fs.writeFileSync(path.join(profileDir, 'lora.safetensors'), loraEntry.getData());
      restoredItems.push({ type: 'lora', name: 'lora.safetensors', detail: profileDir });
    }

    // Write a minimal profile.json so listVoiceProfiles() can discover the profile.
    if (voiceProfileInstalled) {
      const vpMeta = {
        id:             voiceProfileId,
        name:           manifest.displayName || manifest.username,
        createdAt:      manifest.exportedAt,
        durationSec:    0,
        sampleRate:     44100,
        snrDb:          0,
        embedding:      [],
        refText:        '',
        extractVersion: 'imported',
      };
      fs.writeFileSync(
        path.join(profileDir, 'profile.json'),
        JSON.stringify(vpMeta, null, 2),
        'utf-8',
      );
    }

    // ── Restore personality / clone profiles ──────────────────────────────
    let cloneCount = 0;

    const personalityEntry = zip.getEntry('personality/config.json');
    if (personalityEntry) {
      restoredItems.push({ type: 'personality', name: 'personality/config.json' });

      let cloneRows: WecloneProfileRow[];
      try {
        cloneRows = JSON.parse(personalityEntry.getData().toString('utf-8')) as WecloneProfileRow[];
        if (!Array.isArray(cloneRows)) cloneRows = [];
      } catch {
        warnings.push('Could not parse personality/config.json — personality data skipped.');
        cloneRows = [];
      }

      const userDb      = DatabaseManager.getUserDb(targetUsername);
      const wecloneStore = new WecloneStore(userDb);
      await wecloneStore.ensureTable();

      for (const row of cloneRows) {
        try {
          await wecloneStore.createProfile({
            slot:               row.slot,
            displayName:        row.display_name,
            pronouns:           row.pronouns,
            age:                row.age,
            gender:             row.gender,
            appearance:         row.appearance,
            personalityDesc:    row.personality_desc,
            background:         row.background,
            interests:          row.interests,
            dislikes:           row.dislikes,
            hobbies:            row.hobbies,
            goals:              row.goals,
            fears:              row.fears,
            values:             row.values,
            expertise:          row.expertise,
            relationshipStyle:  row.relationship_style,
            loveLanguage:       row.love_language,
            dealbreakers:       row.dealbreakers,
            communicationStyle: row.communication_style,
            loveTopics:         row.love_topics,
            avoidTopics:        row.avoid_topics,
            humorStyle:         row.humor_style,
            responseLength:     row.response_length,
            formality:          row.formality,
            firstPerson:        row.first_person,
            contextSummary:     row.context_summary,
            limitsSummary:      row.limits_summary,
            temperature:        row.temperature,
            topP:               row.top_p,
            contextWindow:      row.context_window,
            systemPrompt:       row.system_prompt,
            // Link voice profile if we extracted one; cartridge bindings
            // are recorded but not auto-activated (may not be installed).
            voiceProfileId:     voiceProfileInstalled ? voiceProfileId : null,
            cartridgeId:        undefined,
          });
          cloneCount++;
          restoredItems.push({ type: 'clone_profile', name: row.display_name || row.slot });
        } catch (err) {
          warnings.push(`Could not restore clone profile '${row.display_name || row.slot}': ${(err as Error).message}`);
        }
      }
    }

    // ── Preserve cartridge_bindings.json for reference ─────────────────────
    const bindingsEntry = zip.getEntry('personality/cartridge_bindings.json');
    if (bindingsEntry) {
      fs.mkdirSync(path.join(importDir, 'personality'), { recursive: true });
      fs.writeFileSync(
        path.join(importDir, 'personality', 'cartridge_bindings.json'),
        bindingsEntry.getData(),
      );
    }

    console.log(`[WecloneImporter] Imported weclone for ${manifest.username} → ${targetUsername}: ${cloneCount} clone(s)`);
    return {
      success:       true,
      reason:        null,
      cloneCount,
      restoredItems,
      warnings,
    };
  }
}