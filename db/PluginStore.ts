import { createHmac, createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import AdmZip from 'adm-zip';
import { DatabaseManager } from './DatabaseManager.js';
import {
  type PluginManifest,
  type PluginRecord,
  type PluginSignature,
  type AuthResult,
  type PluginKind,
  type PluginBaseModel,
} from '../phobos/PluginTypes.js';

// ── Storage roots ─────────────────────────────────────────────────────────────

const PLUGINS_DIR     = path.join(os.homedir(), '.phobos', 'plugins');
const RAW_LORA_SUBDIR = path.join(PLUGINS_DIR, 'raw');

// scrypt parameters — N=2^14 (16384), r=8, p=1 gives ~100ms on modern hardware.
// Stored in the sig alongside the hash so parameters can be upgraded later.
const SCRYPT_N      = 16384;
const SCRYPT_R      = 8;
const SCRYPT_P      = 1;
const SCRYPT_KEYLEN = 32;

// ── License helpers ───────────────────────────────────────────────────────────

function readLicenseKey(): string | null {
  const keyPath = path.join(os.homedir(), '.phobos', 'license.key');
  try {
    const content = fs.readFileSync(keyPath, 'utf-8');
    const lines   = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    return lines[lines.length - 1] ?? null;
  } catch {
    return null;
  }
}

/** SHA256(licenseKey).hex.slice(0,16) — stored as license_fingerprint in sig.json. */
function licenseFingerprint(): string | null {
  const key = readLicenseKey();
  if (!key) return null;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

// ── Password hashing ─────────────────────────────────────────────────────────

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  }).toString('hex');
}

function verifyPassword(entered: string, storedHash: string, salt: string): boolean {
  try {
    const derived = scryptSync(entered, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
    });
    return timingSafeEqual(derived, Buffer.from(storedHash, 'hex'));
  } catch {
    return false;
  }
}

// ── HMAC ──────────────────────────────────────────────────────────────────────

/**
 * HMAC anchored to the plugin identity + both auth fields.
 * Key = password_hash (always available, no license dependency).
 * Data = id|version|created_at|password_hash|license_fingerprint_or_empty
 */
function computeHmac(
  manifest: PluginManifest,
  createdAt: string,
  passwordHash: string,
  licenseFingerprint: string | null,
): string {
  const data = [
    manifest.id,
    manifest.version,
    createdAt,
    passwordHash,
    licenseFingerprint ?? '',
  ].join('|');
  return createHmac('sha256', passwordHash).update(data).digest('hex');
}

function verifyHmac(sig: PluginSignature, manifest: PluginManifest): boolean {
  const expected = computeHmac(
    manifest,
    sig.created_at,
    sig.password_hash,
    sig.license_fingerprint,
  );
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig.hmac, 'hex'));
  } catch {
    return false;
  }
}

// ── Manifest validation ───────────────────────────────────────────────────────

const REQUIRED_MANIFEST_FIELDS: (keyof PluginManifest)[] = [
  'schemaVersion', 'id', 'name', 'author', 'version',
  'baseModel', 'compatibleModels', 'triggerWords',
  'category', 'recommendedWeight', 'weightRange', 'rank',
];

const VALID_BASE_MODELS: PluginBaseModel[] = [
  'flux-dev', 'flux-schnell', 'flux2-klein', 'sdxl', 'chroma', '*',
];

const VALID_CATEGORIES = new Set(['style', 'subject', 'lighting', 'texture', 'concept', 'generic']);

function validateManifest(manifest: unknown): asserts manifest is PluginManifest {
  if (typeof manifest !== 'object' || manifest === null) throw new Error('plugin.json is not an object');
  const m = manifest as Record<string, unknown>;
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (m[field] === undefined) throw new Error(`plugin.json missing required field: ${field}`);
  }
  if (!VALID_BASE_MODELS.includes(m.baseModel as PluginBaseModel)) {
    throw new Error(`plugin.json: invalid baseModel "${m.baseModel}"`);
  }
  if (!VALID_CATEGORIES.has(m.category as string)) {
    throw new Error(`plugin.json: invalid category "${m.category}"`);
  }
  if (!Array.isArray(m.weightRange) || m.weightRange.length !== 2) {
    throw new Error('plugin.json: weightRange must be [min, max]');
  }
}

/** Read first 8 bytes — enough to validate a safetensors header. */
function validateSafetensorsHeader(data: Buffer): void {
  if (data.length < 8) throw new Error('lora.safetensors too small to be valid');
  const metaLen = data.readBigUInt64LE(0);
  if (metaLen === 0n || metaLen > 100_000_000n) {
    throw new Error('lora.safetensors header metadata length out of expected range');
  }
}

// ── Archive helpers ───────────────────────────────────────────────────────────

function readManifestAndSigFromArchive(
  archivePath: string,
): { manifest: PluginManifest; sig: PluginSignature | null } {
  const zip = new AdmZip(archivePath);

  const manifestEntry = zip.getEntry('plugin.json');
  if (!manifestEntry) throw new Error('Invalid .phobos archive: missing plugin.json');
  const manifest = JSON.parse(manifestEntry.getData().toString('utf-8')) as unknown;
  validateManifest(manifest);

  const sigEntry = zip.getEntry('sig.json');
  const sig = sigEntry
    ? (JSON.parse(sigEntry.getData().toString('utf-8')) as PluginSignature)
    : null;

  return { manifest, sig };
}

/**
 * Rewrite sig.json inside an existing .phobos archive in-place.
 * All other entries are preserved.
 */
function rewriteSigInArchive(archivePath: string, newSig: PluginSignature): void {
  const zip = new AdmZip(archivePath);
  zip.deleteFile('sig.json');
  zip.addFile('sig.json', Buffer.from(JSON.stringify(newSig, null, 2), 'utf-8'));
  zip.writeZip(archivePath);
}

// ── PluginStore ───────────────────────────────────────────────────────────────

export class PluginStore {
  constructor(private db: DatabaseManager) {}

  async ensureTable(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS plugins (
        id                 VARCHAR PRIMARY KEY,
        kind               VARCHAR NOT NULL CHECK (kind IN ('plugin', 'raw_lora')),
        name               VARCHAR NOT NULL,
        author             VARCHAR NOT NULL,
        author_url         VARCHAR,
        version            VARCHAR NOT NULL,
        description        TEXT NOT NULL,
        base_model         VARCHAR NOT NULL,
        compatible_models  TEXT NOT NULL,
        trigger_words      TEXT NOT NULL,
        category           VARCHAR NOT NULL,
        tags               TEXT NOT NULL,
        recommended_weight DOUBLE NOT NULL,
        weight_min         DOUBLE NOT NULL,
        weight_max         DOUBLE NOT NULL,
        rank               INTEGER,
        training_images    INTEGER,
        training_steps     INTEGER,
        archive_path       VARCHAR NOT NULL,
        is_local_author    BOOLEAN NOT NULL DEFAULT false,
        has_license_unlock BOOLEAN NOT NULL DEFAULT false,
        installed_at       TIMESTAMP NOT NULL DEFAULT now()
      )
    `);
  }

  list(): Promise<PluginRecord[]> {
    return this.db.query<PluginRecord>(`SELECT * FROM plugins ORDER BY installed_at DESC`);
  }

  get(id: string): Promise<PluginRecord | null> {
    return this.db.queryOne<PluginRecord>(`SELECT * FROM plugins WHERE id = ?`, [id]);
  }

  remove(id: string): Promise<void> {
    return this.db.run(`DELETE FROM plugins WHERE id = ?`, [id]);
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  /**
   * Check whether the caller is authorised to edit this plugin.
   * Tries license unlock first (silent), then falls back to password.
   * Exactly one of password or licenseKey will be provided by the caller.
   */
  checkAuth(
    archivePath: string,
    credential: { password: string } | { useLicense: true },
  ): AuthResult {
    let manifest: PluginManifest;
    let sig: PluginSignature | null;
    try {
      ({ manifest, sig } = readManifestAndSigFromArchive(archivePath));
    } catch {
      return { ok: false, reason: 'corrupt_signature' };
    }

    if (!sig) return { ok: false, reason: 'no_signature' };

    // Verify HMAC integrity before checking credentials
    if (!verifyHmac(sig, manifest)) return { ok: false, reason: 'corrupt_signature' };

    if ('useLicense' in credential) {
      // License path
      const fp = licenseFingerprint();
      if (!fp || !sig.license_fingerprint) return { ok: false, reason: 'no_license_match' };
      try {
        const match = timingSafeEqual(Buffer.from(fp), Buffer.from(sig.license_fingerprint));
        return match
          ? { ok: true, via: 'license' }
          : { ok: false, reason: 'no_license_match' };
      } catch {
        return { ok: false, reason: 'no_license_match' };
      }
    } else {
      // Password path
      const ok = verifyPassword(credential.password, sig.password_hash, sig.password_salt);
      return ok
        ? { ok: true, via: 'password' }
        : { ok: false, reason: 'wrong_password' };
    }
  }

  /**
   * Silent license check — called at page load / panel open.
   * If local license matches sig.license_fingerprint, returns true so the
   * frontend can skip the password prompt and go straight to edit mode.
   */
  checkLicenseUnlock(archivePath: string): boolean {
    try {
      const { sig } = readManifestAndSigFromArchive(archivePath);
      if (!sig?.license_fingerprint) return false;
      const fp = licenseFingerprint();
      if (!fp) return false;
      return timingSafeEqual(Buffer.from(fp), Buffer.from(sig.license_fingerprint));
    } catch {
      return false;
    }
  }

  /**
   * Add the local license as a second unlock path for an existing plugin.
   * Requires a valid auth credential first (password or existing license).
   * Can only be added, never removed — removing would require holding the
   * license that created the entry, which is enforced here.
   */
  async addLicenseUnlock(
    id: string,
    credential: { password: string } | { useLicense: true },
  ): Promise<void> {
    const record = await this.get(id);
    if (!record) throw new Error(`Plugin not found: ${id}`);
    if (record.kind !== 'plugin') throw new Error('Raw LoRAs do not have signatures');

    const auth = this.checkAuth(record.archive_path, credential);
    if (!auth.ok) throw new Error(auth.reason);

    const fp = licenseFingerprint();
    if (!fp) throw new Error('No license key found — cannot add license unlock');

    const { manifest, sig } = readManifestAndSigFromArchive(record.archive_path);
    if (!sig) throw new Error('Archive has no signature');

    if (sig.license_fingerprint) {
      // Already has one — only the matching license may change it
      if (!this.checkLicenseUnlock(record.archive_path)) {
        throw new Error('A different license is already registered. Only that license can modify this entry.');
      }
    }

    const newSig: PluginSignature = {
      ...sig,
      license_fingerprint: fp,
      // Recompute HMAC with the new fingerprint
      hmac: computeHmac(manifest, sig.created_at, sig.password_hash, fp),
    };

    rewriteSigInArchive(record.archive_path, newSig);
    await this.db.run(`UPDATE plugins SET has_license_unlock = true WHERE id = ?`, [id]);
  }

  // ── Install: .phobos archive ──────────────────────────────────────────────

  async installPhobosArchive(archiveBuffer: Buffer, _originalFilename: string): Promise<PluginRecord> {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });

    const zip = new AdmZip(archiveBuffer);

    const manifestEntry = zip.getEntry('plugin.json');
    if (!manifestEntry) throw new Error('Invalid .phobos archive: missing plugin.json');
    const manifest = JSON.parse(manifestEntry.getData().toString('utf-8')) as unknown;
    validateManifest(manifest);
    const m = manifest;

    const loraEntry = zip.getEntry('lora.safetensors');
    if (!loraEntry) throw new Error('Invalid .phobos archive: missing lora.safetensors');
    validateSafetensorsHeader(loraEntry.getData().slice(0, 256));

    let hasLicenseUnlock = false;
    let isLocalAuthor    = false;
    const sigEntry = zip.getEntry('sig.json');
    if (sigEntry) {
      try {
        const sig = JSON.parse(sigEntry.getData().toString('utf-8')) as PluginSignature;
        hasLicenseUnlock = !!sig.license_fingerprint;
        if (sig.license_fingerprint) {
          const fp = licenseFingerprint();
          isLocalAuthor = !!fp && fp === sig.license_fingerprint;
        }
        // A plugin is "local author" if this machine's license matches,
        // OR if it has a password but no license (local creation without license).
        // The is_local_author flag only controls UI — auth is always re-verified at edit time.
      } catch { /* sig unreadable — treat as imported */ }
    }

    // Detect ID collision
    const existing = await this.get(m.id);
    const finalId  = existing ? `${m.id}_${Date.now()}` : m.id;

    const destPath = path.join(PLUGINS_DIR, `${finalId}.phobos`);
    fs.writeFileSync(destPath, archiveBuffer);

    return this._insert({
      id:                 finalId,
      kind:               'plugin',
      name:               m.name,
      author:             m.author,
      author_url:         m.authorUrl ?? null,
      version:            m.version,
      description:        m.description ?? '',
      base_model:         m.baseModel,
      compatible_models:  JSON.stringify(m.compatibleModels),
      trigger_words:      JSON.stringify(m.triggerWords),
      category:           m.category,
      tags:               JSON.stringify(m.tags ?? []),
      recommended_weight: m.recommendedWeight,
      weight_min:         m.weightRange[0],
      weight_max:         m.weightRange[1],
      rank:               m.rank,
      training_images:    m.trainingImages ?? null,
      training_steps:     m.trainingSteps  ?? null,
      archive_path:       destPath,
      is_local_author:    isLocalAuthor,
      has_license_unlock: hasLicenseUnlock,
    });
  }

  // ── Install: raw LoRA ─────────────────────────────────────────────────────

  async installRawLora(fileBuffer: Buffer, filename: string): Promise<PluginRecord> {
    fs.mkdirSync(RAW_LORA_SUBDIR, { recursive: true });

    const ext = path.extname(filename).toLowerCase();
    if (!['.safetensors', '.gguf'].includes(ext)) {
      throw new Error(`Unsupported raw LoRA format: ${ext}. Expected .safetensors or .gguf`);
    }
    if (ext === '.safetensors') validateSafetensorsHeader(fileBuffer.slice(0, 256));

    const base     = path.basename(filename, ext);
    let finalDest  = path.join(RAW_LORA_SUBDIR, filename);
    if (fs.existsSync(finalDest)) {
      finalDest = path.join(RAW_LORA_SUBDIR, `${base}_${Date.now()}${ext}`);
    }
    fs.writeFileSync(finalDest, fileBuffer);

    const id = `raw_${path.basename(finalDest, ext).replace(/[^a-z0-9_-]/gi, '_')}`;
    return this._insert({
      id,
      kind:               'raw_lora',
      name:               base,
      author:             'unknown',
      author_url:         null,
      version:            '1.0.0',
      description:        'Raw LoRA imported from external source. Compatibility unverified.',
      base_model:         '*',
      compatible_models:  JSON.stringify(['*']),
      trigger_words:      JSON.stringify([]),
      category:           'generic',
      tags:               JSON.stringify([]),
      recommended_weight: 0.8,
      weight_min:         0.1,
      weight_max:         1.0,
      rank:               null,
      training_images:    null,
      training_steps:     null,
      archive_path:       finalDest,
      is_local_author:    false,
      has_license_unlock: false,
    });
  }

  // ── Create: new plugin authored locally ───────────────────────────────────

  /**
   * Package a trained lora.safetensors + manifest into a signed .phobos archive.
   * password    — required, set by the user at creation time
   * addLicense  — if true and a local license exists, fingerprint is added to sig
   */
  async createPlugin(
    loraSafetensorsPath: string,
    manifest:            PluginManifest,
    previewImagePaths:   string[],
    password:            string,
    addLicense:          boolean,
  ): Promise<PluginRecord> {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });

    if (!password || password.length < 4) {
      throw new Error('Password must be at least 4 characters');
    }

    const createdAt    = new Date().toISOString();
    const salt         = randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);
    const fp           = addLicense ? licenseFingerprint() : null;

    const sig: PluginSignature = {
      created_at:          createdAt,
      password_hash:       passwordHash,
      password_salt:       salt,
      license_fingerprint: fp,
      hmac:                computeHmac(manifest, createdAt, passwordHash, fp),
    };

    const zip = new AdmZip();
    zip.addFile('plugin.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'));
    zip.addFile('sig.json',    Buffer.from(JSON.stringify(sig, null, 2), 'utf-8'));
    zip.addLocalFile(loraSafetensorsPath, '', 'lora.safetensors');

    for (let i = 0; i < Math.min(previewImagePaths.length, 8); i++) {
      const imgPath = previewImagePaths[i];
      if (fs.existsSync(imgPath)) {
        zip.addLocalFile(imgPath, 'preview/', `0${i + 1}.webp`);
      }
    }

    const archivePath = path.join(PLUGINS_DIR, `${manifest.id}.phobos`);
    zip.writeZip(archivePath);

    return this._insert({
      id:                 manifest.id,
      kind:               'plugin',
      name:               manifest.name,
      author:             manifest.author,
      author_url:         manifest.authorUrl ?? null,
      version:            manifest.version,
      description:        manifest.description ?? '',
      base_model:         manifest.baseModel,
      compatible_models:  JSON.stringify(manifest.compatibleModels),
      trigger_words:      JSON.stringify(manifest.triggerWords),
      category:           manifest.category,
      tags:               JSON.stringify(manifest.tags ?? []),
      recommended_weight: manifest.recommendedWeight,
      weight_min:         manifest.weightRange[0],
      weight_max:         manifest.weightRange[1],
      rank:               manifest.rank,
      training_images:    manifest.trainingImages ?? null,
      training_steps:     manifest.trainingSteps  ?? null,
      archive_path:       archivePath,
      is_local_author:    true,
      has_license_unlock: !!fp,
    });
  }

  // ── Update metadata (requires auth) ──────────────────────────────────────

  async updateMetadata(
    id:         string,
    fields:     Partial<Pick<PluginManifest, 'name' | 'description' | 'tags' | 'recommendedWeight'>>,
    credential: { password: string } | { useLicense: true },
  ): Promise<void> {
    const record = await this.get(id);
    if (!record) throw new Error(`Plugin not found: ${id}`);
    if (record.kind !== 'plugin') throw new Error('Raw LoRAs cannot be edited');

    const auth = this.checkAuth(record.archive_path, credential);
    if (!auth.ok) throw new Error(auth.reason);

    const sets: string[] = [];
    const vals: unknown[] = [];
    if (fields.name !== undefined)              { sets.push('name = ?');               vals.push(fields.name); }
    if (fields.description !== undefined)       { sets.push('description = ?');        vals.push(fields.description); }
    if (fields.tags !== undefined)              { sets.push('tags = ?');               vals.push(JSON.stringify(fields.tags)); }
    if (fields.recommendedWeight !== undefined) { sets.push('recommended_weight = ?'); vals.push(fields.recommendedWeight); }
    if (sets.length === 0) return;

    vals.push(id);
    await this.db.run(`UPDATE plugins SET ${sets.join(', ')} WHERE id = ?`, vals);
  }

  // ── Lora path for inference ───────────────────────────────────────────────

  /** Path passed to phobos-diffusers.py. For 'plugin': the .phobos zip path. */
  getLoraPathForInference(record: PluginRecord): string {
    return record.archive_path;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async _insert(
    r: Omit<PluginRecord, 'installed_at'>,
  ): Promise<PluginRecord> {
    await this.db.run(`
      INSERT INTO plugins (
        id, kind, name, author, author_url, version, description,
        base_model, compatible_models, trigger_words, category, tags,
        recommended_weight, weight_min, weight_max, rank,
        training_images, training_steps, archive_path, is_local_author, has_license_unlock
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      r.id, r.kind, r.name, r.author, r.author_url, r.version, r.description,
      r.base_model, r.compatible_models, r.trigger_words, r.category, r.tags,
      r.recommended_weight, r.weight_min, r.weight_max, r.rank,
      r.training_images, r.training_steps, r.archive_path, r.is_local_author, r.has_license_unlock,
    ]);
    return (await this.get(r.id))!;
  }
}
