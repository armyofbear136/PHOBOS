/**
 * VaultManager.ts — Process-level singleton for PHOBOS Vault.
 *
 * Owns the unlocked Kdbx object for the lifetime of a session. All interaction
 * is through exported functions — never instantiate this module directly.
 *
 * Security invariants:
 *   - Passwords never touch DuckDB or any log statement.
 *   - Secrets never leave this module as strings except through getEntrySecret().
 *   - All writes are atomic: .tmp write → rename, never direct overwrite.
 *   - ProtectedValue wraps all password input immediately on receipt.
 *   - Auto-lock timer uses .unref() — does not prevent Node exit.
 */

import * as fs         from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path       from 'node:path';
import * as os         from 'node:os';
import {
  Kdbx,
  KdbxEntry,
  KdbxGroup,
  KdbxUuid,
  ProtectedValue,
} from 'kdbxweb';
import { VaultStore }                                    from '../db/VaultStore.js';
import { makeCredentials, protectString, exposeProtected } from './VaultCrypto.js';
import type {
  VaultEntry,
  VaultEntryInput,
  VaultGroup,
  VaultStatus,
  VaultState,
} from './VaultTypes.js';

// ── Module-level state ────────────────────────────────────────────────────────

let _db:          Kdbx | null  = null;
let _dbPath:      string       = path.join(os.homedir(), '.phobos', 'vault', 'vault.kdbx');
let _lockTimeout: number       = 900_000; // ms, default 15 min
let _lockTimer:   ReturnType<typeof setTimeout> | null = null;
let _store:       VaultStore | null = null;

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initVaultManager(store: VaultStore): Promise<void> {
  _store = store;
  const cfg = await store.getAll();
  _dbPath      = cfg.db_path;
  _lockTimeout = cfg.lock_timeout_seconds * 1_000;
}

// ── State reads ───────────────────────────────────────────────────────────────

export function vaultExists(): boolean {
  return fs.existsSync(_dbPath);
}

function _state(): VaultState {
  if (!vaultExists()) return 'no_database';
  return _db ? 'unlocked' : 'locked';
}

export function getVaultStatus(): VaultStatus {
  return {
    state:        _state(),
    entryCount:   _db ? _countEntries() : 0,
    groupCount:   _db ? _countGroups()  : 0,
    lastOpenedAt: null, // populated by route from VaultStore
    dbPath:       _dbPath,
    lockTimeout:  _lockTimeout / 1_000,
  };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export async function unlockVault(masterPassword: string): Promise<void> {
  const data  = await fsPromises.readFile(_dbPath);
  const creds = makeCredentials(masterPassword);
  _db = await Kdbx.load(data.buffer as ArrayBuffer, creds);
  _resetLockTimer();
  if (_store) await _store.stampLastOpened();
  console.log('[Vault] Unlocked');
}

export function lockVault(): void {
  _db = null;
  if (_lockTimer) {
    clearTimeout(_lockTimer);
    _lockTimer = null;
  }
  console.log('[Vault] Locked');
}

export async function createVault(masterPassword: string): Promise<void> {
  if (vaultExists()) throw new Error('Vault file already exists at configured path');
  fs.mkdirSync(path.dirname(_dbPath), { recursive: true });

  const creds = makeCredentials(masterPassword);
  const db    = Kdbx.create(creds, 'PHOBOS Vault');
  db.setVersion(4);

  _db = db;
  await _saveToFile();
  _resetLockTimer();
  if (_store) await _store.stampLastOpened();
  console.log('[Vault] Created and unlocked');
}

export async function changeMasterPassword(newPassword: string): Promise<void> {
  _assertUnlocked();
  _db!.credentials = makeCredentials(newPassword);
  await _saveToFile();
  console.log('[Vault] Master password changed');
}

// ── Entry reads ───────────────────────────────────────────────────────────────

export function listEntries(): VaultEntry[] {
  _assertUnlocked();
  _resetLockTimer();
  return _collectEntries(_db!.getDefaultGroup());
}

export function getEntry(uuid: string): VaultEntry | null {
  _assertUnlocked();
  _resetLockTimer();
  const entry = _findEntry(_db!.getDefaultGroup(), uuid);
  return entry ? _serializeEntry(entry) : null;
}

export function getEntrySecret(uuid: string): string | null {
  _assertUnlocked();
  _resetLockTimer();
  const entry = _findEntry(_db!.getDefaultGroup(), uuid);
  if (!entry) return null;
  const pw = entry.fields.get('Password');
  if (pw === undefined) return '';
  return pw instanceof ProtectedValue ? exposeProtected(pw) : String(pw);
}

export function searchEntries(query: string): VaultEntry[] {
  _assertUnlocked();
  _resetLockTimer();
  const q = query.toLowerCase();
  return _collectEntries(_db!.getDefaultGroup()).filter(e =>
    e.title.toLowerCase().includes(q)    ||
    e.username.toLowerCase().includes(q) ||
    e.url.toLowerCase().includes(q),
  );
}

export function listGroups(): VaultGroup[] {
  _assertUnlocked();
  _resetLockTimer();
  const result: VaultGroup[] = [];
  _walkGroups(_db!.getDefaultGroup(), null, 0, result);
  return result;
}

export function getVaultSnapshot(): string | null {
  if (!_db) return null;
  const entries = _collectEntries(_db.getDefaultGroup());
  const groups  = listGroups();

  if (entries.length === 0) {
    return '## VAULT — CREDENTIAL STORE\nThe user has a password vault unlocked but it contains no entries.';
  }

  const groupSummary = groups.map(g => `${g.name} (${g.entryCount})`).join(', ');

  const MAX_PREVIEW = 8;
  const preview = entries
    .slice(0, MAX_PREVIEW)
    .map(e => `  ${e.title}${e.url ? ` [${_stripUrlScheme(e.url)}]` : ''} — username: ${e.username || '(none)'}`)
    .join('\n');

  const remainder = entries.length > MAX_PREVIEW
    ? `\n  ... (${entries.length - MAX_PREVIEW} more entries)`
    : '';

  return [
    '## VAULT — CREDENTIAL STORE',
    `The user has a password vault unlocked with ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} across ${groups.length} ${groups.length === 1 ? 'group' : 'groups'}.`,
    '',
    `Groups: ${groupSummary}`,
    '',
    'Recent entries (by title):',
    preview + remainder,
    '',
    'Do NOT reveal, guess, or reconstruct passwords. You may tell the user which',
    'services they have credentials for, help them find an entry, or suggest they',
    'use the Vault panel to copy a password.',
  ].join('\n');
}

// ── Entry writes ──────────────────────────────────────────────────────────────

export async function createEntry(fields: VaultEntryInput): Promise<string> {
  _assertUnlocked();
  const group = fields.groupUuid ? (_resolveGroup(fields.groupUuid) ?? _db!.getDefaultGroup()) : _db!.getDefaultGroup();
  const entry = _db!.createEntry(group);
  _applyEntryFields(entry, fields);
  await _saveToFile();
  _resetLockTimer();
  console.log('[Vault] Entry created');
  return entry.uuid.id;
}

export async function updateEntry(uuid: string, fields: Partial<VaultEntryInput>): Promise<void> {
  _assertUnlocked();
  const entry = _findEntry(_db!.getDefaultGroup(), uuid);
  if (!entry) throw new Error(`Entry not found: ${uuid}`);

  if (fields.title    !== undefined) entry.fields.set('Title',    fields.title);
  if (fields.username !== undefined) entry.fields.set('UserName', fields.username);
  if (fields.url      !== undefined) entry.fields.set('URL',      fields.url);
  if (fields.notes    !== undefined) entry.fields.set('Notes',    fields.notes);
  if (fields.password !== undefined) {
    entry.fields.set('Password', protectString(fields.password));
    fields.password = ''; // discard plaintext reference
  }
  if (fields.tags !== undefined) {
    entry.tags = fields.tags;
  }
  if (fields.groupUuid !== undefined) {
    const newGroup = _resolveGroup(fields.groupUuid);
    if (newGroup) _db!.move(entry, newGroup);
  }
  if (fields.expires !== undefined) {
    if (fields.expires) {
      entry.times.expiryTime = new Date(fields.expires);
      entry.times.expires    = true;
    } else {
      entry.times.expires = false;
    }
  }

  entry.times.lastModTime = new Date();
  await _saveToFile();
  _resetLockTimer();
}

export async function deleteEntry(uuid: string): Promise<void> {
  _assertUnlocked();
  const entry = _findEntry(_db!.getDefaultGroup(), uuid);
  if (!entry) throw new Error(`Entry not found: ${uuid}`);
  _db!.remove(entry);
  await _saveToFile();
  _resetLockTimer();
  console.log('[Vault] Entry deleted');
}

// ── Group writes ──────────────────────────────────────────────────────────────

export async function createGroup(name: string, parentUuid: string | null): Promise<string> {
  _assertUnlocked();
  const parent = parentUuid ? (_resolveGroup(parentUuid) ?? _db!.getDefaultGroup()) : _db!.getDefaultGroup();
  const group  = _db!.createGroup(parent, name);
  await _saveToFile();
  _resetLockTimer();
  return group.uuid.id;
}

export async function renameGroup(uuid: string, name: string): Promise<void> {
  _assertUnlocked();
  const group = _resolveGroup(uuid);
  if (!group) throw new Error(`Group not found: ${uuid}`);
  group.name = name;
  await _saveToFile();
  _resetLockTimer();
}

export async function deleteGroup(uuid: string): Promise<void> {
  _assertUnlocked();
  const group = _resolveGroup(uuid);
  if (!group) throw new Error(`Group not found: ${uuid}`);
  _db!.remove(group);
  await _saveToFile();
  _resetLockTimer();
  console.log('[Vault] Group deleted');
}

// ── Config update ─────────────────────────────────────────────────────────────

export function applyConfigUpdate(fields: { db_path?: string; lock_timeout_seconds?: number }): void {
  if (fields.db_path !== undefined && fields.db_path !== _dbPath) {
    lockVault();
    _dbPath = fields.db_path;
  }
  if (fields.lock_timeout_seconds !== undefined) {
    _lockTimeout = fields.lock_timeout_seconds * 1_000;
    _resetLockTimer();
  }
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _assertUnlocked(): void {
  if (!_db) throw Object.assign(new Error('Vault is locked'), { vaultLocked: true });
}

function _resetLockTimer(): void {
  if (_lockTimer) clearTimeout(_lockTimer);
  if (_lockTimeout <= 0) return;
  _lockTimer = setTimeout(() => lockVault(), _lockTimeout);
  _lockTimer.unref();
}

async function _saveToFile(): Promise<void> {
  const data = await _db!.save();
  const buf  = Buffer.from(data);
  const tmp  = _dbPath + '.tmp';
  await fsPromises.writeFile(tmp, buf);
  await fsPromises.rename(tmp, _dbPath);
}

function _applyEntryFields(entry: KdbxEntry, fields: VaultEntryInput): void {
  entry.fields.set('Title',    fields.title    || '');
  entry.fields.set('UserName', fields.username || '');
  entry.fields.set('URL',      fields.url      || '');
  entry.fields.set('Notes',    fields.notes    || '');
  entry.fields.set('Password', protectString(fields.password || ''));
  entry.tags = fields.tags ?? [];
  if (fields.expires) {
    entry.times.expiryTime = new Date(fields.expires);
    entry.times.expires    = true;
  }
}

function _serializeEntry(entry: KdbxEntry): VaultEntry {
  const group    = entry.parentGroup;
  const otpField = entry.fields.get('otp') ?? entry.fields.get('TOTP');

  return {
    uuid:      entry.uuid.id,
    groupUuid: group?.uuid.id ?? '',
    groupName: group?.name    ?? '',
    title:     _safeField(entry, 'Title'),
    username:  _safeField(entry, 'UserName'),
    url:       _safeField(entry, 'URL'),
    notes:     _safeField(entry, 'Notes'),
    tags:      entry.tags ?? [],
    createdAt: entry.times.creationTime?.toISOString()  ?? new Date().toISOString(),
    updatedAt: entry.times.lastModTime?.toISOString()   ?? new Date().toISOString(),
    expires:   entry.times.expires && entry.times.expiryTime
                 ? entry.times.expiryTime.toISOString()
                 : null,
    hasTotp:   !!otpField,
  };
}

/**
 * Return the string value of a field, or '' for missing/ProtectedValue fields.
 * ProtectedValue fields (i.e. Password) are never serialized here.
 */
function _safeField(entry: KdbxEntry, key: string): string {
  const val = entry.fields.get(key);
  if (val === undefined || val === null) return '';
  if (val instanceof ProtectedValue) return '';
  return String(val);
}

function _collectEntries(group: KdbxGroup): VaultEntry[] {
  const result: VaultEntry[] = [];
  _walkEntries(group, result);
  return result;
}

function _walkEntries(group: KdbxGroup, acc: VaultEntry[]): void {
  for (const entry of group.entries) {
    acc.push(_serializeEntry(entry));
  }
  for (const sub of group.groups) {
    _walkEntries(sub, acc);
  }
}

function _walkGroups(
  group:    KdbxGroup,
  parentId: string | null,
  depth:    number,
  acc:      VaultGroup[],
): void {
  // Skip the recycle bin group — identified by UUID match against meta
  const recycleBinUuid = _db!.meta.recycleBinUuid;
  if (recycleBinUuid && group.uuid.equals(recycleBinUuid)) return;

  acc.push({
    uuid:       group.uuid.id,
    name:       group.name    ?? '',
    parentUuid: parentId,
    depth,
    entryCount: group.entries.length,
  });
  for (const sub of group.groups) {
    _walkGroups(sub, group.uuid.id, depth + 1, acc);
  }
}

function _findEntry(root: KdbxGroup, uuid: string): KdbxEntry | null {
  for (const entry of root.entries) {
    if (entry.uuid.id === uuid) return entry;
  }
  for (const sub of root.groups) {
    const found = _findEntry(sub, uuid);
    if (found) return found;
  }
  return null;
}

function _resolveGroup(uuid: string): KdbxGroup | null {
  return _db!.getGroup(uuid) ?? null;
}

function _countEntries(): number {
  let n = 0;
  const walk = (g: KdbxGroup): void => { n += g.entries.length; g.groups.forEach(walk); };
  walk(_db!.getDefaultGroup());
  return n;
}

function _countGroups(): number {
  let n = 0;
  const walk = (g: KdbxGroup): void => { n++; g.groups.forEach(walk); };
  _db!.getDefaultGroup().groups.forEach(walk);
  return n;
}

function _stripUrlScheme(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
