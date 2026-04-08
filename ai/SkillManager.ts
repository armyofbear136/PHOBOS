import fs from 'fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ── Skill scope ──────────────────────────────────────────────────────────────
// 'sayon'  — injected into SAYON prompts only
// 'seren'  — injected into SEREN prompts only
// 'both'   — injected into both
export type SkillScope = 'sayon' | 'seren' | 'both';

// ── Skill category ───────────────────────────────────────────────────────────
// 'core'   — system skills, always available for injection
// 'tools'  — on-demand runner skills
export type SkillCategory = 'core' | 'tools';

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  scope: SkillScope;
  category: SkillCategory;
  trigger: string;
  runner: string | null;     // relative path to runner script, null = context-only
  params?: Record<string, { type: string; required?: boolean; description: string }>;
}

export interface LoadedSkill {
  manifest: SkillManifest;
  skillDir: string;
  /** Content of instruction_manual.md — read by both SAYON and SEREN as needed */
  instructions: string | null;
}

// ── Injection surface identifiers ────────────────────────────────────────────
// Each surface maps to exactly one place in the pipeline where skill content
// is appended. CORE decides which skills are relevant per surface — models
// do not choose which system skills fire.
export type InjectionSurface =
  | 'seren_system'          // DispatchComposer.buildSystemPrompt  — every SEREN execution turn
  | 'seren_planning'        // TaskPlanner.decomposeTasks           — SEREN planning prompt
  | 'sayon_review'          // LoopController.runReviewDispatch     — SAYON per-task review
  | 'sayon_ingest'          // ContextIngester                      — SAYON file summarisation
  | 'seren_final_validation'; // LoopController.runFinalValidation  — SEREN holistic review

// Hard-coded surface routing for the 4 priority skills.
// Key: skill id → surfaces where its content should be injected.
const SKILL_SURFACE_MAP: Record<string, InjectionSurface[]> = {
  'interleaved-thinking':  ['seren_system'],
  'reflexion-critique':    ['seren_final_validation'],
  'llm-as-judge':          ['sayon_review'],
  'context-compression':   ['sayon_ingest'],
};

// ── Paths ─────────────────────────────────────────────────────────────────────
// All skills ship with the project inside phobos/skills/.
//
// Resolution strategy (in priority order):
//   1. SEA runtime — process.execPath gives the actual exe location on any machine.
//      Skills live next to the exe: dirname(execPath)/phobos/skills
//      This is the only correct approach for distributed binaries — __dirname is
//      baked at compile time to the dev machine's source path and is wrong everywhere else.
//   2. ESM dev (tsx/ts-node) — import.meta.url gives the source file location.
//      Skills are at: dirname(sourceFile)/../phobos/skills
//   3. CJS dev (esbuild outfile, not SEA) — __dirname is the output directory.
//      Skills are at: dirname(outfile)/../phobos/skills
//
// User-installed skill support is a future feature — not implemented yet.
import { fileURLToPath } from 'url';

function _resolveSkillsDir(): string {
  // ── 1. SEA binary: use exe location ────────────────────────────────────────
  // sea.isSea() is available in Node 21.7+ — use it when present to confirm we're
  // in a SEA context. Fallback: if process.execPath doesn't end in 'node(.exe)',
  // we're very likely running as a bundled binary rather than a plain Node process.
  try {
    const sea = require('node:sea') as { isSea?: () => boolean };
    if (typeof sea.isSea === 'function' && sea.isSea()) {
      return path.join(path.dirname(process.execPath), 'phobos', 'skills');
    }
  } catch { /* node:sea not available in this Node version */ }

  // Heuristic: if the exe name isn't 'node' or 'node.exe', treat as SEA binary
  const exeName = path.basename(process.execPath).toLowerCase().replace('.exe', '');
  if (exeName !== 'node' && exeName !== 'node.exe' && exeName !== 'tsx' && exeName !== 'ts-node') {
    return path.join(path.dirname(process.execPath), 'phobos', 'skills');
  }

  // ── 2. ESM dev (tsx / ts-node) ─────────────────────────────────────────────
  try {
    if (typeof import.meta?.url === 'string') {
      return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'phobos', 'skills');
    }
  } catch { /* import.meta not available */ }

  // ── 3. CJS dev (esbuild outfile, not SEA) ──────────────────────────────────
  if (typeof __dirname === 'string') {
    return path.resolve(__dirname, '..', 'phobos', 'skills');
  }

  // Final fallback
  return path.resolve(process.cwd(), 'phobos', 'skills');
}

const SKILLS_DIR = _resolveSkillsDir();

// ── Singleton registry ────────────────────────────────────────────────────────
let _registry: LoadedSkill[] = [];
let _registryLoaded = false;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load all skills from phobos/skills/ into the in-memory registry.
 * Called once at server start by server.ts.
 * Safe to call again — rebuilds the registry from disk.
 *
 * Load order:
 *   1. Core skills — phobos/skills/_registry.json (4 system skills with instruction_manual.md)
 *   2. Tool skills — phobos/skills/tools/prime/ and phobos/skills/tools/reserve/ (700+ skills)
 */
export async function loadRegistry(): Promise<void> {
  _registry = [];

  const manifests: Array<{ path: string; manifest: SkillManifest }> = [];

  // ── 1. Core skills via registry file ────────────────────────────────────
  try {
    const raw = await fs.readFile(path.join(SKILLS_DIR, '_registry.json'), 'utf-8');
    const reg = JSON.parse(raw) as { skills: Array<{ path: string } & SkillManifest> };
    for (const s of reg.skills) {
      // Registry paths may be absolute (from a prior dev machine) or relative.
      // Always re-resolve relative to SKILLS_DIR so they work anywhere.
      const skillDir = path.isAbsolute(s.path)
        ? path.join(SKILLS_DIR, s.category, s.id)
        : path.resolve(SKILLS_DIR, s.path);
      manifests.push({ path: skillDir, manifest: s });
    }
  } catch (err) {
    console.warn('[SkillManager] Could not read _registry.json, falling back to scan:', err);
    const scanned = await scanSkillDir(path.join(SKILLS_DIR, 'core'));
    manifests.push(...scanned);
  }

  // ── 2. Tool skills — scan prime/ and reserve/ ───────────────────────────
  const toolManifests = await scanSkillDir(path.join(SKILLS_DIR, 'tools'));
  const existingIds = new Set(manifests.map(m => m.manifest.id));
  for (const m of toolManifests) {
    if (!existingIds.has(m.manifest.id)) {
      manifests.push(m);
      existingIds.add(m.manifest.id);
    }
  }

  // ── Load instruction_manual.md for each manifest ─────────────────────────
  for (const { path: skillDir, manifest } of manifests) {
    const skill = await loadSkillFromDir(skillDir, manifest);
    if (skill) _registry.push(skill);
  }

  _registryLoaded = true;
  const coreCount = _registry.filter(s => s.manifest.category === 'core').length;
  const toolCount = _registry.length - coreCount;
  console.log(`[SkillManager] Loaded ${_registry.length} skill(s) — ${coreCount} core, ${toolCount} tools (from ${SKILLS_DIR})`);
}

/**
 * Return the context string to inject at a given pipeline surface.
 * Returns empty string if no skills are registered for that surface.
 *
 * Both SAYON and SEREN surfaces read from instruction_manual.md — the same
 * content is injected regardless of which model is at the surface.
 */
export function getInjection(surface: InjectionSurface): string {
  if (!_registryLoaded || _registry.length === 0) return '';

  const parts: string[] = [];

  for (const skill of _registry) {
    const surfaces = SKILL_SURFACE_MAP[skill.manifest.id];
    if (!surfaces?.includes(surface)) continue;

    const content = skill.instructions;
    if (content?.trim()) {
      parts.push(
        `<skill id="${skill.manifest.id}" name="${skill.manifest.name}">\n${content.trim()}\n</skill>`
      );
    }
  }

  if (parts.length === 0) return '';
  return `\n\n<active_skills>\n${parts.join('\n\n')}\n</active_skills>`;
}

/**
 * Return a compact skill registry summary for SEREN's task planning prompt.
 * Used in Phase 3 so SEREN can assign skills to individual tasks.
 * Only includes 'tools' category skills — system skills are not user-selectable.
 */
// ── PRIME skill IDs ───────────────────────────────────────────────────────────
// These are presented as a compact trigger-list during SEREN's task planning.
// Everything else goes to RESERVE and is only searched on explicit request.
const PRIME_SKILL_IDS = new Set<string>([
  // Context engineering
  'context-compression', 'context-optimization', 'context-fundamentals',
  'memory-systems', 'multi-agent-patterns', 'evaluation', 'advanced-evaluation',
  'tool-design', 'project-development', 'filesystem-context', 'context-degradation',
  // General development (claude-bootstrap)
  'base', 'typescript', 'python', 'react-web', 'nodejs-backend', 'security',
  'code-review', 'commit-hygiene', 'database-schema', 'existing-repo',
  'playwright-testing', 'iterative-development', 'llm-patterns', 'agentic-development',
  // Git/PR workflow
  'git-commit', 'github-pr-creation', 'github-pr-review', 'github-pr-merge',
  'creating-skills',
  // Writing and content
  'copywriting', 'content-strategy', 'copy-editing', 'seo-audit',
  'email-sequence', 'pricing-strategy', 'social-content', 'de-ai-ify',
  // Business/founder
  'strategic-planning', 'prd-generator', 'go-to-market-plan',
  'sop-creator', 'pricing-strategist',
  // Product management
  'create-prd', 'user-stories', 'sprint-plan', 'competitor-analysis',
  'market-sizing', 'user-personas', 'sentiment-analysis', 'grammar-check',
  'prioritization-frameworks', 'product-vision', 'lean-canvas', 'swot-analysis',
  'release-notes', 'summarize-meeting', 'sql-queries',
  // Resume / career
  'resume-tailor', 'resume-bullet-writer', 'resume-ats-optimizer',
  'cover-letter-generator', 'job-description-analyzer',
  'tech-resume-optimizer', 'salary-negotiation-prep',
  // Legal / documents
  'contract-review-anthropic', 'docx-processing-anthropic',
  'pdf-processing-anthropic', 'xlsx-processing-anthropic',
  'legal-risk-assessment-anthropic', 'nda-triage-anthropic',
  // Utilities
  'finding-duplicate-functions', 'using-tmux-for-interactive-commands', 'mcp-cli',
  'baseline-ui', 'fixing-accessibility', 'output-skill', 'taste-skill',
  // Testing
  'core', 'ci', 'playwright-cli',
  // Security
  'vibesec-skill', 'security-bluebook-builder',
  // Document extraction
  'kreuzberg',
  // Media
  'download-video', 'transcribe-video', 'compress-images',
  // YouTube
  'youtube-clipper-skill',
]);

/**
 * Return a compact trigger-list of PRIME skills for SEREN's planning prompt.
 * Format: one line per skill — id + trigger. Budget: ~2K tokens for 85 skills.
 * Includes a footer instruction for triggering a RESERVE search.
 */
export function getPrimeTriggerList(): string {
  if (!_registryLoaded || _registry.length === 0) return '';

  const prime = _registry.filter(
    s => s.manifest.category === 'tools' && PRIME_SKILL_IDS.has(s.manifest.id)
  );
  if (prime.length === 0) return '';

  const lines = prime.map(s => {
    // Keep trigger to one line, max 120 chars
    const trigger = s.manifest.trigger.replace(/\n/g, ' ').slice(0, 120);
    return `  ${s.manifest.id}: ${trigger}`;
  });

  return (
    `\n\n<available_skills>\n` +
    lines.join('\n') +
    `\n\nA reserve library of 600+ additional skills is available at execution time. ` +
    `Each execution task receives the reserve list and can request specific skills on-demand.\n` +
    `</available_skills>`
  );
}

/**
 * Search the RESERVE (non-PRIME) skill library for skills matching a query.
 * Called by LoopController when SEREN emits skillId="SKILL_SEARCH".
 * Returns a formatted block of matching skills (id + full trigger + description).
 */
export function searchReserve(query: string): string {
  if (!_registryLoaded || _registry.length === 0) return '';

  const reserve = _registry.filter(
    s => s.manifest.category === 'tools' && !PRIME_SKILL_IDS.has(s.manifest.id)
  );
  if (reserve.length === 0) return 'No skills found in reserve library.';

  const q = query.toLowerCase();
  const tokens = q.split(/\s+/).filter(t => t.length > 2);

  // Score each skill by how many query tokens appear in its trigger/description/name
  const scored = reserve
    .map(s => {
      const haystack = [
        s.manifest.name,
        s.manifest.description,
        s.manifest.trigger,
        s.manifest.id,
      ].join(' ').toLowerCase();

      const score = tokens.reduce((n, t) => n + (haystack.includes(t) ? 1 : 0), 0);
      return { s, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8); // return at most 8 matches

  if (scored.length === 0) {
    return `No reserve skills matched the query: "${query}"`;
  }

  const lines = scored.map(({ s }) =>
    `  ${s.manifest.id}\n    ${s.manifest.description.slice(0, 120)}\n    Trigger: ${s.manifest.trigger.replace(/\n/g, ' ').slice(0, 120)}`
  );

  return (
    `<reserve_skill_results query="${query}">\n` +
    lines.join('\n\n') +
    `\n</reserve_skill_results>`
  );
}

/**
 * @deprecated Use getPrimeTriggerList() instead.
 * Kept for compatibility until TaskPlanner is updated.
 */
export function getToolSkillsForPlanning(): string {
  return getPrimeTriggerList();
}

/**
 * Compact reserve skill list for per-task injection.
 * Returns id + name only — enough to let SEREN identify relevant skills
 * without consuming the full trigger text. ~2k tokens for 600 skills.
 * Injected into every execution task prompt so SEREN can request skills on-demand.
 */
export function getReserveCompactList(): string {
  if (!_registryLoaded || _registry.length === 0) return '';

  const reserve = _registry.filter(
    s => s.manifest.category === 'tools' && !PRIME_SKILL_IDS.has(s.manifest.id)
  );
  if (reserve.length === 0) return '';

  const lines = reserve.map(s => `  ${s.manifest.id}: ${s.manifest.name}`);

  return (
    `

<reserve_skills>
` +
    `The following reserve skills are available. If any would benefit this task, ` +
    `respond with: RESERVE_SKILL_REQUEST: skill-id-1, skill-id-2
` +
    `CORE will immediately retry this task with those skill instructions injected.\n\n` +
    lines.join('\n') +
    `\n</reserve_skills>`
  );
}

/**
 * Fetch the full instruction_manual.md content for one or more skill IDs.
 * Used by LoopController when SEREN emits RESERVE_SKILL_REQUEST.
 * Returns a formatted <active_skills> block ready for prompt injection.
 */
export function getSkillInstructions(skillIds: string[]): string {
  if (!_registryLoaded || _registry.length === 0) return '';

  const parts: string[] = [];
  for (const id of skillIds) {
    const skill = _registry.find(s => s.manifest.id === id.trim());
    if (!skill) continue;
    const content = skill.instructions?.trim();
    if (content) {
      parts.push(
        `<skill id="${skill.manifest.id}" name="${skill.manifest.name}">
${content}
</skill>`
      );
    }
  }

  if (parts.length === 0) return '';
  return `\n\n<active_skills>\n${parts.join('\n\n')}\n</active_skills>`;
}

/**
 * Execute a tool skill's runner subprocess.
 * params are passed as JSON on stdin. stdout is captured and returned.
 * Throws on non-zero exit or timeout.
 */
export async function invokeSkill(
  skillId: string,
  params: Record<string, unknown>,
  workspaceDir: string,
  timeoutMs = 30_000
): Promise<string> {
  const skill = _registry.find(s => s.manifest.id === skillId);
  if (!skill) throw new Error(`[SkillManager] Unknown skill: ${skillId}`);
  if (!skill.manifest.runner) throw new Error(`[SkillManager] Skill "${skillId}" has no runner`);

  const runnerPath = path.resolve(skill.skillDir, skill.manifest.runner);

  return new Promise((resolve, reject) => {
    const child = spawn('node', [runnerPath], {
      cwd: workspaceDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.stdin.write(JSON.stringify(params));
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`[SkillManager] Skill "${skillId}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`[SkillManager] Skill "${skillId}" exited ${code}: ${stderr.slice(0, 200)}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Install a skill — reserved for future user-skill support.
 * Not implemented: all skills currently ship with the project in phobos/skills/.
 */
export async function installSkill(_sourcePath: string): Promise<SkillManifest> {
  throw new Error('[SkillManager] User-installed skills not yet supported. Skills ship with the project in phobos/skills/.');
}

/** Return all loaded skills (for the /api/skills GET endpoint). */
export function listSkills(): LoadedSkill[] {
  return [..._registry];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function loadSkillFromDir(
  skillDir: string,
  manifest: SkillManifest
): Promise<LoadedSkill | null> {
  try {
    const instructionsPath = path.join(skillDir, 'instruction_manual.md');
    const instructions = await fs.readFile(instructionsPath, 'utf-8').catch(() => null);
    return { manifest, skillDir, instructions };
  } catch (err) {
    console.warn(`[SkillManager] Failed to load skill at ${skillDir}:`, err);
    return null;
  }
}

/**
 * Recursively scan a directory for skill subdirectories.
 * Each subdirectory containing a manifest.json is a skill.
 * Subdirectories without a manifest are recursed into (handles prime/reserve nesting).
 */
async function scanSkillDir(root: string): Promise<Array<{ path: string; manifest: SkillManifest }>> {
  const results: Array<{ path: string; manifest: SkillManifest }> = [];

  async function walk(dir: string): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(dir, entry.name);
      try {
        const raw = await fs.readFile(path.join(skillDir, 'manifest.json'), 'utf-8');
        // Strip UTF-8 BOM (0xEF 0xBB 0xBF) — tool manifests are generated with BOM
        const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
        const manifest = JSON.parse(clean) as SkillManifest;
        results.push({ path: skillDir, manifest });
      } catch {
        // No manifest — recurse (e.g. tools/prime/, tools/reserve/)
        await walk(skillDir);
      }
    }
  }

  await walk(root);
  return results;
}
