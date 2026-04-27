/**
 * DependencyAuditor.ts — dependency vulnerability scanner via npm advisory registry.
 *
 * Single bulk POST to https://registry.npmjs.org/-/npm/v1/advisories/bulk.
 * Parses package-lock.json from PHOBOS root. No binary, no pip, network only.
 * Network failure → single info finding. Never hard-errors, never blocks.
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';
import { SecurityStore, type SecurityFinding, type Severity } from '../db/SecurityStore.js';
import { engineStream } from '../ai/clients.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const ADVISORY_ENDPOINT  = 'https://registry.npmjs.org/-/npm/v1/advisories/bulk';
const REQUEST_TIMEOUT_MS = 30_000;
const DIGEST_TIMEOUT_MS  = 60_000;
const RAW_OUTPUT_CAP     = 64 * 1024;
const DIGEST_INPUT_CAP   = 4_000;

// ── Package parsing ───────────────────────────────────────────────────────────

interface PackageEntry {
  name:    string;
  version: string;
}

interface PackageLock {
  packages?: Record<string, { version: string }>;
  dependencies?: Record<string, { version: string }>;
}

function parsePackageLock(lockPath: string): PackageEntry[] {
  let raw: string;
  try { raw = fs.readFileSync(lockPath, 'utf-8'); } catch { return []; }

  let parsed: PackageLock;
  try { parsed = JSON.parse(raw); } catch { return []; }

  const entries: PackageEntry[] = [];

  // package-lock.json v2/v3 — "packages" field (keys are node_modules/name)
  if (parsed.packages) {
    for (const [key, pkg] of Object.entries(parsed.packages)) {
      if (!key || !pkg.version) continue;
      // Strip the node_modules/ prefix
      const name = key.replace(/^node_modules\//, '').replace(/\/node_modules\//g, '/');
      if (name) entries.push({ name, version: pkg.version });
    }
    return entries;
  }

  // package-lock.json v1 — "dependencies" field
  if (parsed.dependencies) {
    for (const [name, dep] of Object.entries(parsed.dependencies)) {
      if (dep.version) entries.push({ name, version: dep.version });
    }
    return entries;
  }

  return entries;
}

function findPackageLock(): string | null {
  const execDir    = path.dirname(process.execPath);
  const execParent = path.dirname(execDir);

  const candidates = [
    process.env.PHOBOS_PACKAGE_DIR ? path.join(process.env.PHOBOS_PACKAGE_DIR, 'package-lock.json') : null,
    path.join(execDir,    'package-lock.json'),   // SEA: dist/ (staged by build); dev: project root
    path.join(execParent, 'package-lock.json'),   // fallback: dist/../ = project root
    path.join(process.cwd(), 'package-lock.json'),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// ── Advisory types ────────────────────────────────────────────────────────────

interface Advisory {
  id:             number;
  title:          string;
  severity:       string;
  url:            string;
  cves:           string[];
  vulnerable_versions: string;
  patched_versions:    string;
  recommendation:      string;
}

type BulkResponse = Record<string, Advisory[]>;

// ── Version range check ───────────────────────────────────────────────────────

// Minimal semver range check — covers the common npm advisory patterns.
// Returns true if the installed version is likely within the vulnerable range.
// For production robustness this delegates to a string comparison heuristic;
// precise semver range parsing would require the `semver` package.
function versionInRange(installedVersion: string, vulnerableRange: string): boolean {
  if (!vulnerableRange || vulnerableRange === '*') return true;
  if (vulnerableRange === '<0.0.0') return false;

  // Extract version numbers for simple comparisons
  const installed = installedVersion.split('.').map(Number);

  // Handle simple patterns: "< X.Y.Z", "<= X.Y.Z", ">= X.Y.Z && < X.Y.Z"
  const ltMatch  = vulnerableRange.match(/^<\s*([\d.]+)/);
  const lteMatch = vulnerableRange.match(/^<=\s*([\d.]+)/);

  if (ltMatch) {
    const bound = ltMatch[1].split('.').map(Number);
    return compareSemver(installed, bound) < 0;
  }
  if (lteMatch) {
    const bound = lteMatch[1].split('.').map(Number);
    return compareSemver(installed, bound) <= 0;
  }

  // Fallback: assume in range (conservative — avoid false negatives)
  return true;
}

function compareSemver(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const SEVERITY_MAP: Record<string, Severity> = {
  critical: 'critical',
  high:     'high',
  moderate: 'medium',
  medium:   'medium',
  low:      'low',
  info:     'info',
};

// ── Advisory fetch ────────────────────────────────────────────────────────────

async function fetchAdvisories(
  packages: PackageEntry[],
): Promise<BulkResponse | null> {
  // Build request body: { packageName: [version] }
  const body: Record<string, string[]> = {};
  for (const { name, version } of packages) {
    if (!body[name]) body[name] = [];
    if (!body[name].includes(version)) body[name].push(version);
  }

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const resp = await fetch(ADVISORY_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) return null;
    return await resp.json() as BulkResponse;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ── Digest ────────────────────────────────────────────────────────────────────

async function buildDigest(
  findingCount: number,
  newCount:     number,
  rawOutput:    string,
): Promise<string> {
  const preview = rawOutput.slice(0, DIGEST_INPUT_CAP);
  const prompt  = [
    'You are reviewing a PHOBOS dependency vulnerability audit.',
    'Summarize the findings in 3-5 sentences.',
    'Focus on: the most critical CVEs, which packages need urgent updates, and any recommended action.',
    'Be concise. Do not repeat every finding verbatim.',
    '',
    `New findings:   ${newCount}`,
    `Total findings: ${findingCount}`,
    '',
    'Vulnerabilities:',
    preview,
  ].join('\n');

  try {
    return await Promise.race([
      engineStream({
        systemPrompt: 'You are a concise security analyst. Respond in plain text, no markdown.',
        messages:     [{ role: 'user', content: prompt }],
        maxTokens:    512,
        temperature:  0.2,
        mode:         'no_think',
      }),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('digest timeout')), DIGEST_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    return `Digest unavailable: ${(err as Error).message}`;
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

export async function runDependencyAudit(
  store: SecurityStore,
  runId: string,
): Promise<void> {
  try {
    const lockPath = findPackageLock();
    if (!lockPath) {
      const msg = 'package-lock.json not found. Run npm install to generate it.';
      await store.completeRun(runId, 'error', 0, 0, null, msg, null);
      return;
    }

    const packages  = parsePackageLock(lockPath);
    const priorKeys = await store.getPriorFindingKeys('dependency_audit');
    const rawLines: string[] = [
      `Dependency audit: ${lockPath}`,
      `Packages checked: ${packages.length}`,
      '',
    ];

    const response = await fetchAdvisories(packages);

    if (!response) {
      // Network failure — non-fatal info finding
      const title  = 'Dependency audit skipped: npm registry unreachable';
      rawLines.push(title);
      const raw = rawLines.join('\n').slice(0, RAW_OUTPUT_CAP);
      const finding: Omit<SecurityFinding, 'id' | 'created_at'> = {
        run_id:    runId,
        scan_type: 'dependency_audit',
        severity:  'info',
        title,
        detail:    'Could not reach https://registry.npmjs.org/-/npm/v1/advisories/bulk. Check network connectivity.',
        target:    ADVISORY_ENDPOINT,
        cve_id:    null,
        is_new:    !priorKeys.has(`${title}||${ADVISORY_ENDPOINT}`),
      };
      await store.insertFindings([finding]);
      await store.setAnalyzing(runId);
    const digest = await buildDigest(1, finding.is_new ? 1 : 0, raw);
      await store.completeRun(runId, 'success', 1, finding.is_new ? 1 : 0, raw, null, digest);
      return;
    }

    // Build a version lookup for installed packages
    const installedVersions = new Map<string, string>();
    for (const { name, version } of packages) {
      installedVersions.set(name, version);
    }

    const findings: Omit<SecurityFinding, 'id' | 'created_at'>[] = [];

    for (const [pkgName, advisories] of Object.entries(response)) {
      const installedVersion = installedVersions.get(pkgName);
      if (!installedVersion) continue;

      for (const advisory of advisories) {
        if (!versionInRange(installedVersion, advisory.vulnerable_versions)) continue;

        const severity  = SEVERITY_MAP[advisory.severity?.toLowerCase()] ?? 'medium';
        const firstCve  = advisory.cves?.[0] ?? null;
        const cveList   = advisory.cves?.join(', ') ?? 'none';
        const title     = `${pkgName}@${installedVersion}: ${advisory.title}`;
        const target    = `${pkgName}@${installedVersion}`;
        const detail    = [
          advisory.title,
          `CVEs: ${cveList}`,
          `Vulnerable: ${advisory.vulnerable_versions}`,
          `Fix: ${advisory.patched_versions || 'no patch available'}`,
          advisory.recommendation ? `Recommendation: ${advisory.recommendation}` : '',
          advisory.url,
        ].filter(Boolean).join(' | ');

        findings.push({
          run_id:    runId,
          scan_type: 'dependency_audit',
          severity,
          title,
          detail,
          target,
          cve_id:    firstCve,
          is_new:    !priorKeys.has(`${title}||${target}`),
        });

        rawLines.push(`${severity.toUpperCase().padEnd(8)} ${title}`);
      }
    }

    if (findings.length === 0) {
      rawLines.push('No known vulnerabilities found in installed packages.');
    }

    const newCount = findings.filter(f => f.is_new).length;
    const raw      = rawLines.join('\n').slice(0, RAW_OUTPUT_CAP);

    await store.insertFindings(findings);
    await store.setAnalyzing(runId);
    const digest = await buildDigest(findings.length, newCount, raw);
    await store.completeRun(runId, 'success', findings.length, newCount, raw, null, digest);
  } catch (err) {
    await store.completeRun(runId, 'error', 0, 0, null, (err as Error).message, null);
  }
}