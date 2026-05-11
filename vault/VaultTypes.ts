/**
 * VaultTypes.ts — Shared types for PHOBOS Vault.
 *
 * VaultEntry deliberately omits the password field.
 * Passwords are only accessible via VaultManager.getEntrySecret()
 * and are never serialized to DuckDB or global state.
 */

// ── Entry ─────────────────────────────────────────────────────────────────────

export interface VaultEntry {
  uuid:      string;
  groupUuid: string;
  groupName: string;
  title:     string;
  username:  string;
  url:       string;
  notes:     string;
  tags:      string[];
  createdAt: string;       // ISO
  updatedAt: string;       // ISO
  expires:   string | null;
  hasTotp:   boolean;
  // password is intentionally absent — use VaultManager.getEntrySecret()
}

// ── Entry input (create / update) ─────────────────────────────────────────────

export interface VaultEntryInput {
  groupUuid: string;
  title:     string;
  username:  string;
  password:  string;       // plaintext — wrapped in ProtectedValue immediately on receipt
  url:       string;
  notes:     string;
  tags:      string[];
  expires:   string | null;
}

// ── Group ─────────────────────────────────────────────────────────────────────

export interface VaultGroup {
  uuid:       string;
  name:       string;
  parentUuid: string | null;
  depth:      number;
  entryCount: number;
}

// ── Status ────────────────────────────────────────────────────────────────────

export type VaultState = 'locked' | 'unlocked' | 'no_database';

export interface VaultStatus {
  state:         VaultState;
  entryCount:    number;
  groupCount:    number;
  lastOpenedAt:  string | null;
  dbPath:        string;
  lockTimeout:   number;
}
