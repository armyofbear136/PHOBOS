/**
 * PHOBOS LLM Cartridge System — Library Store
 *
 * Auth model mirrors PluginStore exactly:
 *   - Password protection is opt-in at creation. Default is UNPROTECTED.
 *   - Unprotected cartridges use PHOBOS_DEFAULT_CART_PASSWORD as the password.
 *   - On auth check: if stored hash matches the default password → ok via 'default'.
 *   - Raw LoRA import: no sig.json, no auth, kind = 'raw_lora'.
 *   - License unlock: identical to plugin system.
 *
 * HMAC construction (sig.hmac):
 *   Key  = password_hash
 *   Data = id|version|created_at|password_hash|license_fingerprint_or_empty
 *
 * lora_hmac (in sig.json) = HMAC-SHA256(lora.gguf bytes, password_hash)
 *   This is a content-integrity check on the weight file itself.
 */

import { createHmac, createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import AdmZip    from 'adm-zip';
import archiver  from 'archiver';
import { createWriteStream } from 'fs';
import { DatabaseManager, userDir, getActiveUser } from './DatabaseManager.js';
import {
  PHOBOS_DEFAULT_CART_PASSWORD,
  type CartridgeManifest,
  type CartridgeRecord,
  type CartridgeSig,
  type CartridgeAuthResult,
  type CartridgePersona,
  type CartridgeCategory,
  type CartridgeLicense,
  type CartridgeKind,
} from '../phobos/CartridgeTypes.js';

// ── Storage root ──────────────────────────────────────────────────────────────

const CARTRIDGES_DIR     = path.join(os.homedir(), '.phobos', 'cartridges');
const RAW_LORA_SUBDIR    = path.join(CARTRIDGES_DIR, 'raw');

// ── scrypt parameters (match PluginStore exactly) ─────────────────────────────

const SCRYPT_N      = 16384;
const SCRYPT_R      = 8;
const SCRYPT_P      = 1;
const SCRYPT_KEYLEN = 32;

// ── License helpers (mirror PluginStore) ──────────────────────────────────────

function readLicenseKey(): string | null {
  const keyPath = path.join(userDir(getActiveUser()), 'license.key');
  try {
    const lines = fs.readFileSync(keyPath, 'utf-8')
      .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    return lines[lines.length - 1] ?? null;
  } catch {
    return null;
  }
}

function licenseFingerprint(): string | null {
  const key = readLicenseKey();
  if (!key) return null;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

// ── Password hashing ──────────────────────────────────────────────────────────

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

function isDefaultPassword(storedHash: string, salt: string): boolean {
  return verifyPassword(PHOBOS_DEFAULT_CART_PASSWORD, storedHash, salt);
}

// ── HMAC over manifest identity (mirrors PluginStore.computeHmac) ─────────────

function computeManifestHmac(
  manifest:           CartridgeManifest,
  createdAt:          string,
  passwordHash:       string,
  fp:                 string | null,
): string {
  const data = [manifest.id, manifest.version, createdAt, passwordHash, fp ?? ''].join('|');
  return createHmac('sha256', passwordHash).update(data).digest('hex');
}

function verifyManifestHmac(sig: CartridgeSig, manifest: CartridgeManifest): boolean {
  const expected = computeManifestHmac(manifest, sig.created_at, sig.password_hash, sig.license_fingerprint);
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig.hmac, 'hex'));
  } catch {
    return false;
  }
}

// ── lora.gguf content HMAC ────────────────────────────────────────────────────

function computeLoraHmac(loraBytes: Buffer, passwordHash: string): string {
  return createHmac('sha256', passwordHash).update(loraBytes).digest('hex');
}

function verifyLoraHmac(loraBytes: Buffer, sig: CartridgeSig): boolean {
  const expected = computeLoraHmac(loraBytes, sig.password_hash);
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig.lora_hmac, 'hex'));
  } catch {
    return false;
  }
}

// ── GGUF header check ─────────────────────────────────────────────────────────

function validateGgufHeader(data: Buffer): void {
  if (data.length < 8) throw new Error('lora.gguf too small to be a valid GGUF file');
  if (data.slice(0, 4).toString('ascii') !== 'GGUF') {
    throw new Error('lora.gguf missing GGUF magic — not a valid GGUF file');
  }
}

// ── Manifest validation ───────────────────────────────────────────────────────

const REQUIRED_MANIFEST_FIELDS: (keyof CartridgeManifest)[] = [
  'schemaVersion', 'id', 'name', 'author', 'version', 'description',
  'baseModel', 'compatibleModels', 'targetPersona', 'rank', 'category',
  'recommendedWeight', 'weightRange', 'license', 'createdAt',
];

const VALID_PERSONAS   = new Set<CartridgePersona>(['sayon', 'seren', 'both']);
const VALID_CATEGORIES = new Set<CartridgeCategory>(['expertise', 'persona', 'style', 'domain', 'task']);
const VALID_LICENSES   = new Set<CartridgeLicense>(['personal', 'commercial', 'community']);

function validateManifest(raw: unknown): asserts raw is CartridgeManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error('cartridge.json is not an object');
  const m = raw as Record<string, unknown>;
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (m[field] === undefined) throw new Error(`cartridge.json missing required field: ${field}`);
  }
  if (m.schemaVersion !== 1)                                       throw new Error(`Unsupported schemaVersion ${m.schemaVersion}`);
  if (!VALID_PERSONAS.has(m.targetPersona as CartridgePersona))    throw new Error(`Invalid targetPersona "${m.targetPersona}"`);
  if (!VALID_CATEGORIES.has(m.category as CartridgeCategory))      throw new Error(`Invalid category "${m.category}"`);
  if (!VALID_LICENSES.has(m.license as CartridgeLicense))          throw new Error(`Invalid license "${m.license}"`);
  if (!Array.isArray(m.compatibleModels) || m.compatibleModels.length === 0) {
    throw new Error('compatibleModels must be a non-empty array');
  }
  if (!Array.isArray(m.weightRange) || m.weightRange.length !== 2) throw new Error('weightRange must be [min, max]');
  if (typeof m.id !== 'string' || !/^[a-z0-9_-]+$/i.test(m.id))  throw new Error('id must be alphanumeric with hyphens/underscores only');
}

// ── Archive helpers ───────────────────────────────────────────────────────────

function readManifestAndSig(archivePath: string): { manifest: CartridgeManifest; sig: CartridgeSig | null } {
  const zip = new AdmZip(archivePath);
  const me  = zip.getEntry('cartridge.json');
  if (!me) throw new Error('Invalid .cartridge archive: missing cartridge.json');
  const manifest = JSON.parse(me.getData().toString('utf-8')) as unknown;
  validateManifest(manifest);
  const se = zip.getEntry('sig.json');
  const sig = se ? (JSON.parse(se.getData().toString('utf-8')) as CartridgeSig) : null;
  return { manifest, sig };
}

// NOTE: rewriteSigInArchive loads the full archive into memory via adm-zip.
// For large cartridges (8B+) this will OOM. Replace with a streaming
// copy-and-replace implementation before shipping license unlock on large models.
function rewriteSigInArchive(archivePath: string, newSig: CartridgeSig): void {
  const zip = new AdmZip(archivePath);
  zip.deleteFile('sig.json');
  zip.addFile('sig.json', Buffer.from(JSON.stringify(newSig, null, 2), 'utf-8'));
  zip.writeZip(archivePath);
}

// ── CartridgeStore ────────────────────────────────────────────────────────────

export class CartridgeStore {
  constructor(private db: DatabaseManager) {}

  async ensureTable(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS cartridges (
        id                  VARCHAR PRIMARY KEY,
        kind                VARCHAR NOT NULL CHECK (kind IN ('cartridge', 'raw_lora')),
        name                VARCHAR NOT NULL,
        author              VARCHAR NOT NULL,
        author_url          VARCHAR,
        version             VARCHAR NOT NULL,
        description         TEXT NOT NULL,
        base_model          VARCHAR NOT NULL,
        compatible_models   TEXT NOT NULL,
        target_persona      VARCHAR NOT NULL,
        rank                INTEGER NOT NULL,
        category            VARCHAR NOT NULL,
        tags                TEXT NOT NULL,
        behavior_summary    TEXT NOT NULL,
        trigger_context     VARCHAR,
        training_documents  INTEGER NOT NULL DEFAULT 0,
        training_turns      INTEGER NOT NULL DEFAULT 0,
        training_steps      INTEGER NOT NULL DEFAULT 0,
        recommended_weight  DOUBLE NOT NULL,
        weight_min          DOUBLE NOT NULL,
        weight_max          DOUBLE NOT NULL,
        license             VARCHAR NOT NULL,
        halcyon_id          VARCHAR,
        lora_path           VARCHAR NOT NULL,
        install_path        VARCHAR NOT NULL,
        is_local_author     BOOLEAN NOT NULL DEFAULT false,
        has_license_unlock  BOOLEAN NOT NULL DEFAULT false,
        is_protected        BOOLEAN NOT NULL DEFAULT false,
        installed_at        TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    // Active slot table — one row per persona, upserted on activate/deactivate.
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS cartridge_slots (
        persona      VARCHAR PRIMARY KEY,
        cartridge_id VARCHAR,
        weight       DOUBLE NOT NULL DEFAULT 1.0
      )
    `);

    // Seed the two persona slots so reads always return a row.
    for (const persona of ['sayon', 'seren']) {
      await this.db.run(
        `INSERT INTO cartridge_slots (persona, cartridge_id, weight)
         SELECT ?, NULL, 1.0
         WHERE NOT EXISTS (SELECT 1 FROM cartridge_slots WHERE persona = ?)`,
        [persona, persona],
      );
    }
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  list(): Promise<CartridgeRecord[]> {
    return this.db.query<CartridgeRecord>(`SELECT * FROM cartridges ORDER BY installed_at DESC`);
  }

  get(id: string): Promise<CartridgeRecord | null> {
    return this.db.queryOne<CartridgeRecord>(`SELECT * FROM cartridges WHERE id = ?`, [id]);
  }

  async remove(id: string): Promise<void> {
    const record = await this.get(id);
    if (!record) return;
    await this.db.run(`UPDATE cartridge_slots SET cartridge_id = NULL WHERE cartridge_id = ?`, [id]);
    try { fs.rmSync(record.install_path, { recursive: true, force: true }); } catch { /* non-fatal */ }
    await this.db.run(`DELETE FROM cartridges WHERE id = ?`, [id]);
  }

  // ── Slot management ───────────────────────────────────────────────────────

  async getActiveSlot(persona: 'sayon' | 'seren'): Promise<{ cartridgeId: string | null; weight: number }> {
    const row = await this.db.queryOne<{ cartridge_id: string | null; weight: number }>(
      `SELECT cartridge_id, weight FROM cartridge_slots WHERE persona = ?`, [persona],
    );
    return { cartridgeId: row?.cartridge_id ?? null, weight: row?.weight ?? 1.0 };
  }

  async setActiveSlot(persona: 'sayon' | 'seren', cartridgeId: string, weight: number): Promise<void> {
    await this.db.run(
      `UPDATE cartridge_slots SET cartridge_id = ?, weight = ? WHERE persona = ?`,
      [cartridgeId, weight, persona],
    );
  }

  async clearActiveSlot(persona: 'sayon' | 'seren'): Promise<void> {
    await this.db.run(`UPDATE cartridge_slots SET cartridge_id = NULL WHERE persona = ?`, [persona]);
  }

  // ── Auth (mirrors PluginStore.checkAuth) ──────────────────────────────────

  /**
   * Check credentials for a protected cartridge.
   * - If default password → ok via 'default' (unprotected, no prompt).
   * - If matching license → ok via 'license'.
   * - If matching password → ok via 'password'.
   */
  checkAuth(
    archivePath: string,
    credential: { password: string } | { useLicense: true },
  ): CartridgeAuthResult {
    let manifest: CartridgeManifest;
    let sig: CartridgeSig | null;
    try {
      ({ manifest, sig } = readManifestAndSig(archivePath));
    } catch {
      return { ok: false, reason: 'corrupt_signature' };
    }
    if (!sig) return { ok: false, reason: 'no_signature' };
    if (!verifyManifestHmac(sig, manifest)) return { ok: false, reason: 'corrupt_signature' };

    // Default password — always unlocks unprotected cartridges.
    if (isDefaultPassword(sig.password_hash, sig.password_salt)) {
      return { ok: true, via: 'default' };
    }

    if ('useLicense' in credential) {
      const fp = licenseFingerprint();
      if (!fp || !sig.license_fingerprint) return { ok: false, reason: 'no_license_match' };
      try {
        return timingSafeEqual(Buffer.from(fp), Buffer.from(sig.license_fingerprint))
          ? { ok: true, via: 'license' }
          : { ok: false, reason: 'no_license_match' };
      } catch {
        return { ok: false, reason: 'no_license_match' };
      }
    }

    return verifyPassword(credential.password, sig.password_hash, sig.password_salt)
      ? { ok: true, via: 'password' }
      : { ok: false, reason: 'wrong_password' };
  }

  checkLicenseUnlock(archivePath: string): boolean {
    try {
      const { sig } = readManifestAndSig(archivePath);
      if (!sig?.license_fingerprint) return false;
      const fp = licenseFingerprint();
      if (!fp) return false;
      return timingSafeEqual(Buffer.from(fp), Buffer.from(sig.license_fingerprint));
    } catch {
      return false;
    }
  }

  async addLicenseUnlock(
    id: string,
    credential: { password: string } | { useLicense: true },
  ): Promise<void> {
    const record = await this.get(id);
    if (!record) throw new Error(`Cartridge not found: ${id}`);
    if (record.kind !== 'cartridge') throw new Error('Raw LoRAs do not have signatures');
    const auth = this.checkAuth(record.install_path + '/cartridge-archive.cartridge', credential);
    if (!auth.ok) throw new Error(auth.reason);
    const fp = licenseFingerprint();
    if (!fp) throw new Error('No license key found — cannot add license unlock');
    const archivePath = path.join(record.install_path, 'cartridge-archive.cartridge');
    const { manifest, sig } = readManifestAndSig(archivePath);
    if (!sig) throw new Error('Archive has no signature');
    if (sig.license_fingerprint && !this.checkLicenseUnlock(archivePath)) {
      throw new Error('A different license is already registered.');
    }
    const newSig: CartridgeSig = {
      ...sig,
      license_fingerprint: fp,
      hmac: computeManifestHmac(manifest, sig.created_at, sig.password_hash, fp),
    };
    rewriteSigInArchive(archivePath, newSig);
    await this.db.run(`UPDATE cartridges SET has_license_unlock = true WHERE id = ?`, [id]);
  }

  // ── Install: .cartridge archive ───────────────────────────────────────────

  async installCartridgeArchive(archiveBuffer: Buffer): Promise<CartridgeRecord> {
    fs.mkdirSync(CARTRIDGES_DIR, { recursive: true });

    const zip = new AdmZip(archiveBuffer);

    const manifestEntry = zip.getEntry('cartridge.json');
    if (!manifestEntry) throw new Error('Invalid .cartridge archive: missing cartridge.json');
    const manifest = JSON.parse(manifestEntry.getData().toString('utf-8')) as unknown;
    validateManifest(manifest);
    const m = manifest;

    // lora.gguf is required — safetensors alone cannot be loaded by llama-server.
    const loraEntry = zip.getEntry('lora.gguf');
    if (!loraEntry) {
      throw new Error(
        'Invalid .cartridge archive: missing lora.gguf. ' +
        'Convert lora.safetensors to GGUF before packaging.',
      );
    }
    const loraBytes = loraEntry.getData();
    validateGgufHeader(loraBytes.slice(0, 8));

    // sig.json — verify HMAC integrity.
    const sigEntry = zip.getEntry('sig.json');
    if (!sigEntry) throw new Error('Invalid .cartridge archive: missing sig.json');
    const sig = JSON.parse(sigEntry.getData().toString('utf-8')) as CartridgeSig;
    if (!verifyManifestHmac(sig, m)) {
      throw new Error('Cartridge manifest HMAC verification failed — archive may be corrupted or tampered.');
    }
    if (!verifyLoraHmac(loraBytes, sig)) {
      throw new Error('Cartridge lora.gguf HMAC verification failed — weight file does not match signature.');
    }

    const isProtected  = !isDefaultPassword(sig.password_hash, sig.password_salt);
    let hasLicenseUnlock = false;
    let isLocalAuthor    = false;
    if (sig.license_fingerprint) {
      hasLicenseUnlock = true;
      const fp = licenseFingerprint();
      isLocalAuthor = !!fp && fp === sig.license_fingerprint;
    }

    // ID collision — append timestamp to avoid overwrite.
    const existing = await this.get(m.id);
    const finalId  = existing ? `${m.id}_${Date.now()}` : m.id;

    const installPath = path.join(CARTRIDGES_DIR, finalId);
    fs.mkdirSync(installPath, { recursive: true });

    const loraDestPath    = path.join(installPath, 'lora.gguf');
    const archiveDestPath = path.join(installPath, 'cartridge-archive.cartridge');
    fs.writeFileSync(loraDestPath, loraBytes);
    fs.writeFileSync(archiveDestPath, archiveBuffer);  // keep original for auth operations

    // Optional files.
    const stEntry = zip.getEntry('lora.safetensors');
    if (stEntry) fs.writeFileSync(path.join(installPath, 'lora.safetensors'), stEntry.getData());
    const thumbEntry = zip.getEntry('thumbnail.webp');
    if (thumbEntry) fs.writeFileSync(path.join(installPath, 'thumbnail.webp'), thumbEntry.getData());
    const samplesDir = path.join(installPath, 'samples');
    zip.getEntries()
      .filter(e => e.entryName.startsWith('samples/') && !e.isDirectory)
      .forEach(e => {
        fs.mkdirSync(samplesDir, { recursive: true });
        fs.writeFileSync(path.join(installPath, e.entryName), e.getData());
      });

    return this._insert({
      id:                  finalId,
      kind:                'cartridge',
      name:                m.name,
      author:              m.author,
      author_url:          m.authorUrl ?? null,
      version:             m.version,
      description:         m.description,
      base_model:          m.baseModel,
      compatible_models:   JSON.stringify(m.compatibleModels),
      target_persona:      m.targetPersona,
      rank:                m.rank,
      category:            m.category,
      tags:                JSON.stringify(m.tags ?? []),
      behavior_summary:    m.behaviorSummary ?? '',
      trigger_context:     m.triggerContext ?? null,
      training_documents:  m.trainingDocuments ?? 0,
      training_turns:      m.trainingTurns ?? 0,
      training_steps:      m.trainingSteps ?? 0,
      recommended_weight:  m.recommendedWeight,
      weight_min:          m.weightRange[0],
      weight_max:          m.weightRange[1],
      license:             m.license,
      halcyon_id:          m.halcyonId ?? null,
      lora_path:           loraDestPath,
      install_path:        installPath,
      is_local_author:     isLocalAuthor,
      has_license_unlock:  hasLicenseUnlock,
      is_protected:        isProtected,
    });
  }

  // ── Install: raw LoRA (no signature, no auth) ─────────────────────────────

  async installRawLora(fileBuffer: Buffer, filename: string): Promise<CartridgeRecord> {
    fs.mkdirSync(RAW_LORA_SUBDIR, { recursive: true });

    const ext = path.extname(filename).toLowerCase();
    if (!['.gguf'].includes(ext)) {
      throw new Error(`Raw cartridge LoRAs must be .gguf format. Received: ${ext}`);
    }
    validateGgufHeader(fileBuffer.slice(0, 8));

    const base     = path.basename(filename, ext);
    let finalDest  = path.join(RAW_LORA_SUBDIR, filename);
    if (fs.existsSync(finalDest)) {
      finalDest = path.join(RAW_LORA_SUBDIR, `${base}_${Date.now()}${ext}`);
    }
    fs.writeFileSync(finalDest, fileBuffer);

    const id = `raw_${path.basename(finalDest, ext).replace(/[^a-z0-9_-]/gi, '_')}`;
    return this._insert({
      id,
      kind:                'raw_lora',
      name:                base,
      author:              'unknown',
      author_url:          null,
      version:             '1.0.0',
      description:         'Raw LoRA imported from external source. Compatibility unverified.',
      base_model:          '*',
      compatible_models:   JSON.stringify(['*']),
      target_persona:      'both',
      rank:                16,
      category:            'expertise',
      tags:                JSON.stringify([]),
      behavior_summary:    '',
      trigger_context:     null,
      training_documents:  0,
      training_turns:      0,
      training_steps:      0,
      recommended_weight:  0.8,
      weight_min:          0.1,
      weight_max:          1.0,
      license:             'personal',
      halcyon_id:          null,
      lora_path:           finalDest,
      install_path:        RAW_LORA_SUBDIR,
      is_local_author:     false,
      has_license_unlock:  false,
      is_protected:        false,
    });
  }

  // ── Create: new cartridge authored locally ────────────────────────────────

  /**
   * Package a trained lora.gguf + manifest into a signed .cartridge archive.
   *
   * password    — user-set password, or PHOBOS_DEFAULT_CART_PASSWORD if unprotected.
   * addLicense  — if true and a local license exists, add fingerprint to sig.
   */
  async createCartridge(
    loraGgufPath:   string,
    manifest:       CartridgeManifest,
    samplePaths:    string[],
    password:       string,
    addLicense:     boolean,
  ): Promise<CartridgeRecord> {
    fs.mkdirSync(CARTRIDGES_DIR, { recursive: true });

    const isProtected = password !== PHOBOS_DEFAULT_CART_PASSWORD;
    if (isProtected && password.length < 4) {
      throw new Error('Password must be at least 4 characters');
    }

    const loraBytes  = fs.readFileSync(loraGgufPath);
    validateGgufHeader(loraBytes.slice(0, 8));

    const createdAt    = new Date().toISOString();
    const salt         = randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);
    const fp           = addLicense ? licenseFingerprint() : null;
    const loraHmac     = computeLoraHmac(loraBytes, passwordHash);

    const sig: CartridgeSig = {
      created_at:          createdAt,
      password_hash:       passwordHash,
      password_salt:       salt,
      lora_hmac:           loraHmac,
      license_fingerprint: fp,
      hmac:                computeManifestHmac(manifest, createdAt, passwordHash, fp),
    };

    // Optional: safetensors for training resume (if present alongside the gguf).
    const stPath = loraGgufPath.replace(/\.gguf$/, '.safetensors');

    const installPath     = path.join(CARTRIDGES_DIR, manifest.id);
    const archiveDestPath = path.join(installPath, 'cartridge-archive.cartridge');
    const loraDestPath    = path.join(installPath, 'lora.gguf');
    fs.mkdirSync(installPath, { recursive: true });

    // ZIP64 required — merged fp16 GGUFs exceed 2 GB for models 1.5B+.
    await new Promise<void>((resolve, reject) => {
      const output  = createWriteStream(archiveDestPath);
      const archive = archiver('zip', { zlib: { level: 0 }, forceZip64: true });
      archive.on('error', reject);
      output.on('close', resolve);
      archive.pipe(output);
      archive.append(Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'), { name: 'cartridge.json' });
      archive.append(Buffer.from(JSON.stringify(sig, null, 2), 'utf-8'),      { name: 'sig.json' });
      archive.file(loraGgufPath, { name: 'lora.gguf' });
      if (fs.existsSync(stPath)) archive.file(stPath, { name: 'lora.safetensors' });
      for (let i = 0; i < Math.min(samplePaths.length, 6); i++) {
        const sp = samplePaths[i];
        if (fs.existsSync(sp)) archive.file(sp, { name: `samples/0${i + 1}.txt` });
      }
      archive.finalize();
    });
    fs.writeFileSync(loraDestPath, loraBytes);

    return this._insert({
      id:                  manifest.id,
      kind:                'cartridge',
      name:                manifest.name,
      author:              manifest.author,
      author_url:          manifest.authorUrl ?? null,
      version:             manifest.version,
      description:         manifest.description,
      base_model:          manifest.baseModel,
      compatible_models:   JSON.stringify(manifest.compatibleModels),
      target_persona:      manifest.targetPersona,
      rank:                manifest.rank,
      category:            manifest.category,
      tags:                JSON.stringify(manifest.tags ?? []),
      behavior_summary:    manifest.behaviorSummary ?? '',
      trigger_context:     manifest.triggerContext ?? null,
      training_documents:  manifest.trainingDocuments ?? 0,
      training_turns:      manifest.trainingTurns ?? 0,
      training_steps:      manifest.trainingSteps ?? 0,
      recommended_weight:  manifest.recommendedWeight,
      weight_min:          manifest.weightRange[0],
      weight_max:          manifest.weightRange[1],
      license:             manifest.license,
      halcyon_id:          manifest.halcyonId ?? null,
      lora_path:           loraDestPath,
      install_path:        installPath,
      is_local_author:     true,
      has_license_unlock:  !!fp,
      is_protected:        isProtected,
    });
  }

  // ── Static: build archive buffer (used by training pipeline + test script) ─

  static buildArchive(
    manifest:    CartridgeManifest,
    loraBytes:   Buffer,
    password:    string = PHOBOS_DEFAULT_CART_PASSWORD,
    addLicense   = false,
    sampleTexts: Array<{ name: string; data: Buffer }> = [],
  ): Buffer {
    const createdAt    = new Date().toISOString();
    const salt         = randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);
    const fp           = addLicense ? licenseFingerprint() : null;
    const loraHmac     = computeLoraHmac(loraBytes, passwordHash);

    const sig: CartridgeSig = {
      created_at:          createdAt,
      password_hash:       passwordHash,
      password_salt:       salt,
      lora_hmac:           loraHmac,
      license_fingerprint: fp,
      hmac:                computeManifestHmac(manifest, createdAt, passwordHash, fp),
    };

    const zip = new AdmZip();
    zip.addFile('cartridge.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'));
    zip.addFile('sig.json',       Buffer.from(JSON.stringify(sig, null, 2), 'utf-8'));
    zip.addFile('lora.gguf',      loraBytes);
    for (const s of sampleTexts) zip.addFile(s.name, s.data);
    return zip.toBuffer();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async _insert(r: Omit<CartridgeRecord, 'installed_at'>): Promise<CartridgeRecord> {
    await this.db.run(`
      INSERT INTO cartridges (
        id, kind, name, author, author_url, version, description,
        base_model, compatible_models, target_persona, rank, category,
        tags, behavior_summary, trigger_context,
        training_documents, training_turns, training_steps,
        recommended_weight, weight_min, weight_max,
        license, halcyon_id, lora_path, install_path,
        is_local_author, has_license_unlock, is_protected
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      r.id, r.kind, r.name, r.author, r.author_url, r.version, r.description,
      r.base_model, r.compatible_models, r.target_persona, r.rank, r.category,
      r.tags, r.behavior_summary, r.trigger_context,
      r.training_documents, r.training_turns, r.training_steps,
      r.recommended_weight, r.weight_min, r.weight_max,
      r.license, r.halcyon_id, r.lora_path, r.install_path,
      r.is_local_author, r.has_license_unlock, r.is_protected,
    ]);
    return (await this.get(r.id))!;
  }
}
