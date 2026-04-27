/**
 * FileIntegrityRunner.ts — SHA-256 baseline and diff engine.
 *
 * Uses Node.js crypto only — no external binary dependency.
 * On first run with no existing baseline, establishes the baseline and
 * returns empty findings (noted in the caller's run log).
 *
 * Supported platforms: linux, darwin, win32.
 */

import { createHash }           from 'node:crypto';
import { createReadStream }     from 'node:fs';
import { stat }                 from 'node:fs/promises';
import type { SecurityFinding, ScanType, IntegrityBaseline } from '../db/SecurityStore.js';

const SCAN_TYPE: ScanType = 'integrity_check';

// ── Monitored paths by platform ───────────────────────────────────────────────

const LINUX_PATHS: string[] = [
  '/usr/bin/ssh',
  '/usr/bin/sudo',
  '/bin/sh',
  '/bin/bash',
  '/usr/bin/python3',
  '/usr/bin/node',
  '/etc/passwd',
  '/etc/sudoers',
  '/etc/hosts',
];

const DARWIN_PATHS: string[] = [
  '/bin/sh',
  '/bin/bash',
  '/usr/bin/sudo',
  '/usr/bin/ssh',
  '/usr/bin/python3',
  '/etc/pam.d/sudo',
  '/etc/hosts',
];

const WIN32_PATHS: string[] = [
  'C:\\Windows\\System32\\cmd.exe',
  'C:\\Windows\\System32\\powershell.exe',
  'C:\\Windows\\System32\\svchost.exe',
  'C:\\Windows\\System32\\lsass.exe',
  'C:\\Windows\\System32\\services.exe',
  'C:\\Windows\\System32\\winlogon.exe',
];

function platformPaths(): string[] {
  if (process.platform === 'linux')  return LINUX_PATHS;
  if (process.platform === 'darwin') return DARWIN_PATHS;
  if (process.platform === 'win32')  return WIN32_PATHS;
  return [];
}

// ── Hashing ───────────────────────────────────────────────────────────────────

async function hashFile(filePath: string): Promise<{ sha256: string; sizeBytes: number } | null> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;

    const hash = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', resolve);
      stream.on('error', reject);
    });

    return { sha256: hash.digest('hex'), sizeBytes: info.size };
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Hashes all platform paths and returns baseline entries for storage.
 * Skips paths that don't exist or can't be read (non-fatal, logged).
 */
export async function buildBaseline(): Promise<IntegrityBaseline[]> {
  const paths    = platformPaths();
  const now      = new Date().toISOString();
  const entries: IntegrityBaseline[] = [];

  for (const p of paths) {
    const result = await hashFile(p);
    if (result) {
      entries.push({ path: p, sha256: result.sha256, size_bytes: result.sizeBytes, baselined_at: now });
    } else {
      console.log(`[FileIntegrity] Skipping (not readable): ${p}`);
    }
  }

  return entries;
}

/**
 * Compares current hashes against the stored baseline.
 * Returns findings for any file that is missing or has changed.
 * Returns null if no baseline exists — caller should run buildBaseline() first.
 */
export async function checkIntegrity(
  runId:    string,
  baseline: IntegrityBaseline[],
): Promise<Omit<SecurityFinding, 'id' | 'created_at'>[]> {
  const findings: Omit<SecurityFinding, 'id' | 'created_at'>[] = [];

  for (const entry of baseline) {
    const current = await hashFile(entry.path);

    if (!current) {
      findings.push({
        run_id:    runId,
        scan_type: SCAN_TYPE,
        severity:  'critical',
        title:     'Monitored file is missing or unreadable',
        detail:    `File was present at baseline (${entry.baselined_at}) but cannot be read now.`,
        target:    entry.path,
        cve_id:    null,
        is_new:    true,
      });
      continue;
    }

    if (current.sha256 !== entry.sha256) {
      findings.push({
        run_id:    runId,
        scan_type: SCAN_TYPE,
        severity:  'high',
        title:     'Monitored file has changed since baseline',
        detail:    [
          `Baseline SHA-256:  ${entry.sha256}`,
          `Current SHA-256:   ${current.sha256}`,
          `Baseline size:     ${entry.size_bytes} bytes`,
          `Current size:      ${current.sizeBytes} bytes`,
          `Baselined at:      ${entry.baselined_at}`,
        ].join('\n'),
        target:    entry.path,
        cve_id:    null,
        is_new:    true,
      });
    }
  }

  return findings;
}
