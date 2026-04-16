/**
 * PHOBOS User Skill Manager
 *
 * Manages user-created skills stored in ~/.phobos/user/skills/.
 * Each skill is a directory containing manifest.json + SKILL.md + optional files.
 * Dependency files live in <skillDir>/deps/ and are never treated as logic files.
 *
 * Directory layout:
 *   ~/.phobos/user/
 *     skills/
 *       <skill-id>/
 *         manifest.json      ← skill metadata
 *         SKILL.md           ← content injected into model context (sayon_context)
 *         runner.ts          ← optional execution entry point
 *         seren_context.md   ← optional SEREN-specific context
 *         deps/              ← dependency files (executables, data, etc.)
 *           <any files>
 *     _registry.json         ← auto-generated; never edit by hand
 */

import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export type UserSkillScope = 'sayon' | 'seren' | 'both';

export interface UserSkillManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  scope: UserSkillScope;
  category: 'user';
  trigger: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface DepFile {
  name: string;
  size: number;
  path: string;   // relative to deps/ dir
}

export interface UserSkillRecord extends UserSkillManifest {
  /** Full content of SKILL.md — the sayon context / primary injection content */
  skill_md: string;
  /** Optional runner.ts content */
  runner: string;
  /** Optional seren_context.md content */
  seren_context: string;
  /** Dependency files listed from <skillDir>/deps/ */
  deps: DepFile[];
  /** Absolute path to the skill directory on disk */
  skill_path: string;
}

export interface UserSkillCreateInput {
  id: string;
  name: string;
  description: string;
  version: string;
  scope: UserSkillScope;
  trigger: string;
  enabled: boolean;
  skill_md: string;
  runner: string;
  seren_context: string;
}

export interface RegistryEntry {
  id: string;
  name: string;
  scope: UserSkillScope;
  category: 'user';
  trigger: string;
  enabled: boolean;
  path: string;
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const USER_DIR     = path.join(os.homedir(), '.phobos', 'user');
const SKILLS_DIR   = path.join(USER_DIR, 'skills');
const REGISTRY_FILE = path.join(USER_DIR, '_registry.json');

function skillDir(id: string): string {
  return path.join(SKILLS_DIR, id);
}

function depsDir(id: string): string {
  return path.join(skillDir(id), 'deps');
}

// ── Boot ──────────────────────────────────────────────────────────────────────

export async function scanOnStartup(): Promise<void> {
  mkdirSync(SKILLS_DIR, { recursive: true });
  await rebuildRegistry();
}

// ── Registry ──────────────────────────────────────────────────────────────────

export async function rebuildRegistry(): Promise<RegistryEntry[]> {
  let entries: RegistryEntry[] = [];

  try {
    const dirs = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const manifestPath = path.join(SKILLS_DIR, d.name, 'manifest.json');
      try {
        const raw = await fs.readFile(manifestPath, 'utf-8');
        const m = JSON.parse(raw) as UserSkillManifest;
        if (m.category !== 'user') continue;
        entries.push({
          id:       m.id,
          name:     m.name,
          scope:    m.scope,
          category: 'user',
          trigger:  m.trigger,
          enabled:  m.enabled !== false,
          path:     path.join(SKILLS_DIR, d.name),
        });
      } catch {
        // malformed — skip
      }
    }
  } catch {
    // skills dir doesn't exist yet
  }

  const registry = {
    version:   '1.0',
    generated: new Date().toISOString(),
    skills:    entries,
  };

  await fs.writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
  return entries;
}

// ── List ──────────────────────────────────────────────────────────────────────

export async function listUserSkills(): Promise<UserSkillRecord[]> {
  const entries = await rebuildRegistry();
  const records: UserSkillRecord[] = [];

  for (const entry of entries) {
    const record = await readSkillDir(entry.path);
    if (record) records.push(record);
  }

  return records.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// ── Get one ───────────────────────────────────────────────────────────────────

export async function getUserSkill(id: string): Promise<UserSkillRecord | null> {
  return readSkillDir(skillDir(id));
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function createUserSkill(input: UserSkillCreateInput): Promise<UserSkillRecord> {
  const id = sanitizeId(input.id);
  const dir = skillDir(id);

  if (existsSync(dir)) {
    throw new Error(`Skill with id "${id}" already exists`);
  }

  mkdirSync(dir, { recursive: true });
  mkdirSync(depsDir(id), { recursive: true });

  const manifest: UserSkillManifest = {
    id,
    name:        input.name,
    description: input.description,
    version:     input.version || '0.1.0',
    scope:       input.scope,
    category:    'user',
    trigger:     input.trigger,
    enabled:     input.enabled !== false,
    created_at:  new Date().toISOString(),
    updated_at:  new Date().toISOString(),
  };

  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  await fs.writeFile(path.join(dir, 'SKILL.md'),       input.skill_md    || '', 'utf-8');
  await fs.writeFile(path.join(dir, 'runner.ts'),      input.runner      || '', 'utf-8');
  await fs.writeFile(path.join(dir, 'seren_context.md'), input.seren_context || '', 'utf-8');

  await rebuildRegistry();

  return (await readSkillDir(dir))!;
}

// ── Update ────────────────────────────────────────────────────────────────────

export async function updateUserSkill(
  id: string,
  patch: Partial<UserSkillCreateInput>,
): Promise<UserSkillRecord> {
  const dir = skillDir(id);
  if (!existsSync(dir)) throw new Error(`Skill "${id}" not found`);

  const existing = await readManifest(dir);
  if (!existing) throw new Error(`Skill "${id}" manifest missing`);

  const updated: UserSkillManifest = {
    ...existing,
    name:        patch.name        ?? existing.name,
    description: patch.description ?? existing.description,
    version:     patch.version     ?? existing.version,
    scope:       patch.scope       ?? existing.scope,
    trigger:     patch.trigger     ?? existing.trigger,
    enabled:     patch.enabled     ?? existing.enabled,
    updated_at:  new Date().toISOString(),
  };

  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(updated, null, 2), 'utf-8');

  if (patch.skill_md      !== undefined) await fs.writeFile(path.join(dir, 'SKILL.md'),         patch.skill_md,      'utf-8');
  if (patch.runner        !== undefined) await fs.writeFile(path.join(dir, 'runner.ts'),         patch.runner,        'utf-8');
  if (patch.seren_context !== undefined) await fs.writeFile(path.join(dir, 'seren_context.md'),  patch.seren_context, 'utf-8');

  await rebuildRegistry();
  return (await readSkillDir(dir))!;
}

// ── Toggle enabled ────────────────────────────────────────────────────────────

export async function toggleUserSkill(id: string): Promise<UserSkillRecord> {
  const dir = skillDir(id);
  const manifest = await readManifest(dir);
  if (!manifest) throw new Error(`Skill "${id}" not found`);

  manifest.enabled    = !manifest.enabled;
  manifest.updated_at = new Date().toISOString();

  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  await rebuildRegistry();

  return (await readSkillDir(dir))!;
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function deleteUserSkill(id: string): Promise<void> {
  const dir = skillDir(id);
  if (!existsSync(dir)) throw new Error(`Skill "${id}" not found`);
  await fs.rm(dir, { recursive: true, force: true });
  await rebuildRegistry();
}

// ── Dep file management ───────────────────────────────────────────────────────

export async function installDepFile(
  skillId: string,
  filename: string,
  data: Buffer,
): Promise<DepFile> {
  const dir = depsDir(skillId);
  mkdirSync(dir, { recursive: true });

  // Sanitize filename — no path traversal
  const safe = path.basename(filename).replace(/[^a-zA-Z0-9._\-]/g, '_');
  const dest = path.join(dir, safe);

  await fs.writeFile(dest, data);

  return { name: safe, size: data.length, path: safe };
}

export async function deleteDepFile(skillId: string, filename: string): Promise<void> {
  const safe = path.basename(filename);
  const target = path.join(depsDir(skillId), safe);
  await fs.rm(target, { force: true });
}

// ── ZIP import ────────────────────────────────────────────────────────────────

/**
 * Import a skill from a zip archive. Handles:
 *   1. PHOBOS user skill zips (contains manifest.json + SKILL.md)
 *   2. Claude Code SKILL.md skills (just a SKILL.md, possibly with name in frontmatter)
 *   3. Any zip with a SKILL.md at any depth (best-effort extraction)
 */
export async function importSkillFromZip(
  buf: Buffer,
): Promise<UserSkillRecord> {
  // Dynamic import to avoid top-level optional dep issue
  const AdmZip = (await import('adm-zip')).default;
  const zip    = new AdmZip(buf);
  const entries = zip.getEntries();

  // Try to find manifest.json
  const manifestEntry = entries.find(e => !e.isDirectory && e.name === 'manifest.json');
  // Try to find SKILL.md (any depth)
  const skillMdEntry = entries.find(e => !e.isDirectory && e.name === 'SKILL.md');

  let manifest: Partial<UserSkillManifest> = {};
  let skillMd = '';
  let runner  = '';
  let serenCtx = '';

  if (manifestEntry) {
    try {
      manifest = JSON.parse(manifestEntry.getData().toString('utf-8'));
    } catch { /* fallback to empty */ }
  }

  if (skillMdEntry) {
    skillMd = skillMdEntry.getData().toString('utf-8');

    // Parse Claude Code SKILL.md frontmatter for name/description
    if (!manifest.name) {
      const nameMatch  = skillMd.match(/^#\s+(.+)$/m);
      const frontmatch = skillMd.match(/^name:\s*(.+)$/m);
      manifest.name = (frontmatch?.[1] ?? nameMatch?.[1] ?? '').trim();
    }
    if (!manifest.description) {
      const descMatch = skillMd.match(/^description:\s*(.+)$/m);
      manifest.description = (descMatch?.[1] ?? '').trim();
    }
  } else {
    throw new Error('No SKILL.md found in zip — cannot import');
  }

  // runner.ts
  const runnerEntry = entries.find(e => !e.isDirectory && (e.name === 'runner.ts' || e.name === 'runner.js'));
  if (runnerEntry) runner = runnerEntry.getData().toString('utf-8');

  // seren_context.md
  const serenEntry = entries.find(e => !e.isDirectory && (e.name === 'seren_context.md' || e.name === 'SEREN.md'));
  if (serenEntry) serenCtx = serenEntry.getData().toString('utf-8');

  // Generate a unique id if one isn't in the manifest
  const rawId = (manifest.id as string | undefined)
    ?? slugify(manifest.name ?? 'imported-skill');
  const id = await uniqueId(rawId);

  const record = await createUserSkill({
    id,
    name:           manifest.name        ?? id,
    description:    manifest.description ?? '',
    version:        manifest.version     ?? '0.1.0',
    scope:          (manifest.scope      ?? 'both') as UserSkillScope,
    trigger:        manifest.trigger     ?? '',
    enabled:        manifest.enabled     ?? true,
    skill_md:       skillMd,
    runner,
    seren_context:  serenCtx,
  });

  // Install non-logic files into deps
  const LOGIC_FILES = new Set(['manifest.json', 'SKILL.md', 'runner.ts', 'runner.js', 'seren_context.md', 'SEREN.md']);
  for (const entry of entries) {
    if (entry.isDirectory || LOGIC_FILES.has(entry.name)) continue;
    await installDepFile(id, entry.name, entry.getData());
  }

  return record;
}

// ── ZIP export ────────────────────────────────────────────────────────────────

export async function exportSkillToZip(id: string): Promise<Buffer> {
  const record = await getUserSkill(id);
  if (!record) throw new Error(`Skill "${id}" not found`);

  const AdmZip = (await import('adm-zip')).default;
  const zip    = new AdmZip();

  zip.addFile('manifest.json', Buffer.from(JSON.stringify({
    id:          record.id,
    name:        record.name,
    description: record.description,
    version:     record.version,
    scope:       record.scope,
    category:    'user',
    trigger:     record.trigger,
    enabled:     record.enabled,
    created_at:  record.created_at,
    updated_at:  record.updated_at,
  }, null, 2), 'utf-8'));

  zip.addFile('SKILL.md',          Buffer.from(record.skill_md,      'utf-8'));
  zip.addFile('runner.ts',         Buffer.from(record.runner,         'utf-8'));
  zip.addFile('seren_context.md',  Buffer.from(record.seren_context,  'utf-8'));

  // Include dep files
  const depsDirPath = depsDir(id);
  if (existsSync(depsDirPath)) {
    const depFiles = await fs.readdir(depsDirPath, { withFileTypes: true });
    for (const f of depFiles) {
      if (!f.isFile()) continue;
      const data = await fs.readFile(path.join(depsDirPath, f.name));
      zip.addFile(`deps/${f.name}`, data);
    }
  }

  return zip.toBuffer();
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function readManifest(dir: string): Promise<UserSkillManifest | null> {
  try {
    const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readSkillDir(dir: string): Promise<UserSkillRecord | null> {
  const manifest = await readManifest(dir);
  if (!manifest) return null;

  const [skill_md, runner, seren_context] = await Promise.all([
    fs.readFile(path.join(dir, 'SKILL.md'),         'utf-8').catch(() => ''),
    fs.readFile(path.join(dir, 'runner.ts'),         'utf-8').catch(() => ''),
    fs.readFile(path.join(dir, 'seren_context.md'),  'utf-8').catch(() => ''),
  ]);

  // List dep files
  const depsDirPath = path.join(dir, 'deps');
  const deps: DepFile[] = [];
  try {
    const depEntries = await fs.readdir(depsDirPath, { withFileTypes: true });
    for (const f of depEntries) {
      if (!f.isFile()) continue;
      const stat = await fs.stat(path.join(depsDirPath, f.name)).catch(() => null);
      deps.push({ name: f.name, size: stat?.size ?? 0, path: f.name });
    }
  } catch { /* no deps dir */ }

  return {
    ...manifest,
    skill_md,
    runner,
    seren_context,
    deps,
    skill_path: dir,
  };
}

function sanitizeId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function slugify(name: string): string {
  return sanitizeId(name.toLowerCase().replace(/\s+/g, '-').slice(0, 60));
}

async function uniqueId(base: string): Promise<string> {
  const safe = sanitizeId(base);
  if (!existsSync(skillDir(safe))) return safe;

  const suffix = crypto.randomBytes(3).toString('hex');
  return `${safe}-${suffix}`;
}
