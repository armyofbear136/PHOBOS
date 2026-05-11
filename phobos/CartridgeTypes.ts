/**
 * PHOBOS LLM Cartridge System — Shared Types
 *
 * Auth model mirrors the Artist Plugin System exactly:
 *   - Password-protected: scrypt hash stored in sig.json; HMAC over lora.gguf.
 *   - Default password: PHOBOS_DEFAULT_CART_PASSWORD sentinel — detected on
 *     import and treated as "unprotected". Always unlocks without prompting.
 *   - Raw LoRA path: no sig.json at all — accepted as-is, no auth operations.
 *   - License unlock: optional second unlock path, identical to plugin system.
 *
 * Compatibility model:
 *   baseModel      — GGUFSpec.family the cartridge was trained on (e.g. "Gemma 4").
 *   compatibleModels — explicit GGUFSpec.modelId allow-list. ["*"] = family match.
 */

export type CartridgePersona   = 'sayon' | 'seren' | 'both';
export type CartridgeCategory  = 'expertise' | 'persona' | 'style' | 'domain' | 'task' | 'weclone';
export type CartridgeLicense   = 'personal' | 'commercial' | 'community';
export type CartridgeKind      = 'cartridge' | 'raw_lora';

/**
 * Sentinel password used when user opts out of password protection.
 * Detected on auth check — always unlocks without prompting the user.
 */
export const PHOBOS_DEFAULT_CART_PASSWORD = '__phobos_default_cart_v1__';

/** cartridge.json inside a .cartridge archive. */
export interface CartridgeManifest {
  schemaVersion:     1;
  id:                string;
  name:              string;
  author:            string;
  authorUrl?:        string;
  version:           string;
  description:       string;
  /**
   * GGUFSpec.family this cartridge was trained on, e.g. "Gemma 4", "Qwen3.5".
   * Used for family-level compatibility when compatibleModels is ["*"].
   */
  baseModel:         string;
  /**
   * Explicit GGUFSpec.modelId allow-list. Use ["*"] to permit any model in the
   * same family. Use specific IDs to lock to exact quants/sizes.
   */
  compatibleModels:  string[];
  targetPersona:     CartridgePersona;
  rank:              number;
  category:          CartridgeCategory;
  tags:              string[];
  behaviorSummary:   string;
  /** Prepended to system prompt when active. null = no injection. */
  triggerContext:    string | null;
  trainingDocuments: number;
  trainingTurns:     number;
  trainingSteps:     number;
  recommendedWeight: number;
  weightRange:       [number, number];
  license:           CartridgeLicense;
  createdAt:         string;
  /** Set when sourced from or contributed to HALCYON. null = local only. */
  halcyonId:         string | null;
}

/**
 * sig.json inside a .cartridge archive.
 * Identical structure to PluginSignature — same HMAC construction,
 * same scrypt parameters, same license fingerprint mechanism.
 *
 * HMAC key    = password_hash
 * HMAC data   = id|version|created_at|password_hash|license_fingerprint_or_empty
 * HMAC target = lora.gguf bytes (integrity of the weight file)
 *
 * When password_hash == scrypt(PHOBOS_DEFAULT_CART_PASSWORD, salt, 32),
 * the cartridge is treated as unprotected — no password prompt on import.
 */
export interface CartridgeSig {
  created_at:          string;
  password_hash:       string;        // scrypt(password, salt, 32) hex
  password_salt:       string;        // 16 random bytes hex
  lora_hmac:           string;        // HMAC-SHA256(lora.gguf bytes, password_hash) hex
  license_fingerprint: string | null;
  hmac:                string;        // HMAC over manifest identity fields
}

export type CartridgeAuthResult =
  | { ok: true;  via: 'password' | 'license' | 'default' }
  | { ok: false; reason: 'wrong_password' | 'no_license_match' | 'no_signature' | 'corrupt_signature' };

/** DuckDB row returned from CartridgeStore queries. */
export interface CartridgeRecord {
  id:                  string;
  kind:                CartridgeKind;
  name:                string;
  author:              string;
  author_url:          string | null;
  version:             string;
  description:         string;
  base_model:          string;
  compatible_models:   string;    // JSON array
  target_persona:      CartridgePersona;
  rank:                number;
  category:            CartridgeCategory;
  tags:                string;    // JSON array
  behavior_summary:    string;
  trigger_context:     string | null;
  training_documents:  number;
  training_turns:      number;
  training_steps:      number;
  recommended_weight:  number;
  weight_min:          number;
  weight_max:          number;
  license:             CartridgeLicense;
  halcyon_id:          string | null;
  lora_path:           string;    // absolute path to lora.gguf on disk
  install_path:        string;    // absolute path to cartridge install directory
  is_local_author:     boolean;
  has_license_unlock:  boolean;
  is_protected:        boolean;   // false when using default password (unprotected)
  installed_at:        string;
}

/**
 * Passed into LlamaServerManager when a cartridge is active for a persona.
 * Resolved by CartridgeManager from a CartridgeRecord at activation time.
 */
export interface CartridgeBinding {
  cartridgeId: string;
  loraPath:    string;
  weight:      number;
}

/** Result of a compatibility check. */
export type CompatibilityResult =
  | { compatible: true }
  | { compatible: false; reason: 'family_mismatch' | 'model_not_in_list'; activeModelId: string; activeFamily: string };

export const CATEGORY_LABELS: Record<CartridgeCategory, string> = {
  expertise: 'Expertise',
  persona:   'Persona',
  style:     'Style',
  domain:    'Domain',
  task:      'Task',
  weclone:   'Digital Clone',
};
