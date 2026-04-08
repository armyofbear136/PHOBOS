/**
 * PHOBOS Artist Plugin System — Shared Types
 *
 * PluginKind:
 *   'plugin'   — .phobos container (signed zip). Full metadata. Auth-locked edits.
 *   'raw_lora' — bare .safetensors / .gguf. No metadata form. Generic category.
 *
 * Auth model (per-plugin, not global):
 *   Every plugin has a password set at creation (stateless — prompted at edit time).
 *   Optionally a license fingerprint is stored as a second independent unlock path.
 *   Either the matching password OR the matching license key unlocks editing.
 *   License can be added in edit mode; cannot be removed without the license that added it.
 */

export type PluginKind     = 'plugin' | 'raw_lora';
export type PluginCategory = 'style' | 'subject' | 'lighting' | 'texture' | 'concept' | 'generic';
export type PluginBaseModel =
  | 'flux-dev'
  | 'flux-schnell'
  | 'flux2-klein'
  | 'sdxl'
  | 'chroma'
  | '*';

/** plugin.json inside a .phobos archive. */
export interface PluginManifest {
  schemaVersion:     number;
  id:                string;
  name:              string;
  author:            string;
  authorUrl?:        string;
  version:           string;
  description:       string;
  baseModel:         PluginBaseModel;
  compatibleModels:  PluginBaseModel[];
  triggerWords:      string[];
  category:          PluginCategory;
  tags:              string[];
  recommendedWeight: number;
  weightRange:       [number, number];
  rank:              number;
  trainingImages:    number;
  trainingSteps:     number;
  createdAt:         string;
}

/**
 * sig.json inside every .phobos archive.
 *
 * Two independent unlock paths for editing:
 *
 *   Password path (always present):
 *     password_salt  = crypto.randomBytes(16).toString('hex')
 *     password_hash  = scrypt(password, password_salt, 32).toString('hex')
 *     Verify: scrypt(entered, password_salt, 32) === password_hash
 *
 *   License path (optional, opt-in at creation or added later in edit mode):
 *     license_fingerprint = SHA256(licenseKey).slice(0, 16)   [hex]
 *     Verify: SHA256(localLicenseKey).slice(0,16) === license_fingerprint
 *     — silent check, no prompt
 *
 * HMAC anchors the sig to this specific plugin version and both auth anchors
 * so the sig cannot be transplanted or have its fields swapped:
 *   HMAC-SHA256(
 *     key    = password_hash,
 *     data   = `${id}|${version}|${created_at}|${password_hash}|${license_fingerprint ?? ''}`
 *   )
 * The HMAC key is the password hash (always present), not the license key,
 * so verification is always possible even on machines without a license.
 */
export interface PluginSignature {
  created_at:          string;        // ISO timestamp
  password_hash:       string;        // scrypt(password, salt, 32) hex
  password_salt:       string;        // 16 random bytes hex
  license_fingerprint: string | null; // SHA256(licenseKey).hex.slice(0,16) | null
  hmac:                string;        // HMAC-SHA256 hex
}

/**
 * Returned by PluginStore.checkAuth().
 * Routes use this to gate edit operations.
 */
export type AuthResult =
  | { ok: true;  via: 'password' | 'license' }
  | { ok: false; reason: 'wrong_password' | 'no_license_match' | 'no_signature' | 'corrupt_signature' };

/**
 * DuckDB row. archive_path is never extracted to disk.
 * has_license_unlock cached from sig so the frontend can show the badge
 * without reading the archive.
 */
export interface PluginRecord {
  id:                 string;
  kind:               PluginKind;
  name:               string;
  author:             string;
  author_url:         string | null;
  version:            string;
  description:        string;
  base_model:         PluginBaseModel;
  compatible_models:  string;      // JSON array
  trigger_words:      string;      // JSON array
  category:           PluginCategory;
  tags:               string;      // JSON array
  recommended_weight: number;
  weight_min:         number;
  weight_max:         number;
  rank:               number | null;
  training_images:    number | null;
  training_steps:     number | null;
  archive_path:       string;
  is_local_author:    boolean;
  has_license_unlock: boolean;
  installed_at:       string;
}

/** Per-node plugin binding — stored in WorkflowNode.params.plugins[]. */
export interface PluginBinding {
  pluginId:    string;
  archivePath: string;
  weight:      number;
  triggerWord: string;
  kind:        PluginKind;
}
