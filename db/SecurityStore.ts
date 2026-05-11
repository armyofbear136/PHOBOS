/**
 * SecurityStore.ts — DuckDB persistence for the PHOBOS Security subsystem.
 *
 * Four tables:
 *   security_scan_runs        — one row per completed scan invocation
 *   security_findings         — individual findings extracted from scan output
 *   security_integrity_baseline — SHA-256 hashes of monitored files
 *   security_config           — key-value schedule and target configuration
 */

import { DatabaseManager } from './DatabaseManager.js';
import { randomUUID } from 'node:crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ScanType =
  | 'port_scan'        // Nmap localhost
  | 'web_scan'         // Nikto localhost:PORT
  | 'malware_scan'     // ClamAV targeted directories
  | 'dependency_audit' // Trivy package.json
  | 'code_audit'       // Semgrep on-demand
  | 'system_audit'     // SystemAuditRunner (native Node.js)
  | 'integrity_check'; // FileIntegrityRunner (native Node.js)

export type ScanStatus = 'running' | 'analyzing' | 'success' | 'error' | 'tool_missing';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface SecurityScanRun {
  id:                string;
  scan_type:         ScanType;
  status:            ScanStatus;
  started_at:        string;
  completed_at:      string | null;
  finding_count:     number;
  new_finding_count: number;
  error_message:     string | null;
  raw_output:        string | null;
  seren_digest:      string | null;
}

export interface SecurityFinding {
  id:         string;
  run_id:     string;
  scan_type:  ScanType;
  severity:   Severity;
  title:      string;
  detail:     string | null;
  target:     string | null;
  cve_id:     string | null;
  is_new:     boolean;
  created_at: string;
}

export interface IntegrityBaseline {
  path:         string;
  sha256:       string;
  size_bytes:   number;
  baselined_at: string;
}

// ── Config keys ───────────────────────────────────────────────────────────────

export type SecurityConfigKey =
  | 'port_scan_cron'
  | 'web_scan_cron'
  | 'malware_scan_cron'
  | 'dependency_audit_cron'
  | 'system_audit_cron'
  | 'integrity_check_cron'
  | 'malware_scan_paths'   // JSON array of absolute paths
  | 'semgrep_enabled'
  | 'integrity_enabled'
  | 'clamav_update_cron';

const CONFIG_DEFAULTS: Record<SecurityConfigKey, string> = {
  port_scan_cron:        '0 3 * * 0',   // Sunday 3am
  web_scan_cron:         '0 3 * * 0',   // Sunday 3am
  malware_scan_cron:     '0 2 * * *',   // Daily 2am
  dependency_audit_cron: '0 1 * * 1',   // Monday 1am
  system_audit_cron:     '0 4 * * 0',   // Sunday 4am
  integrity_check_cron:  '0 4 * * *',   // Daily 4am
  malware_scan_paths:    '[]',
  semgrep_enabled:       'true',
  integrity_enabled:     'true',
  clamav_update_cron:    '0 3 * * 3',   // Wednesday 3am
};

// ── DDL ───────────────────────────────────────────────────────────────────────

const DDL = `
CREATE TABLE IF NOT EXISTS security_scan_runs (
  id                VARCHAR PRIMARY KEY,
  scan_type         VARCHAR NOT NULL,
  status            VARCHAR NOT NULL,
  started_at        TIMESTAMP NOT NULL,
  completed_at      TIMESTAMP,
  finding_count     INTEGER NOT NULL DEFAULT 0,
  new_finding_count INTEGER NOT NULL DEFAULT 0,
  error_message     VARCHAR,
  raw_output        VARCHAR,
  seren_digest      VARCHAR
);

CREATE TABLE IF NOT EXISTS security_findings (
  id         VARCHAR PRIMARY KEY,
  run_id     VARCHAR NOT NULL,
  scan_type  VARCHAR NOT NULL,
  severity   VARCHAR NOT NULL,
  title      VARCHAR NOT NULL,
  detail     VARCHAR,
  target     VARCHAR,
  cve_id     VARCHAR,
  is_new     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS security_integrity_baseline (
  path         VARCHAR PRIMARY KEY,
  sha256       VARCHAR NOT NULL,
  size_bytes   BIGINT  NOT NULL,
  baselined_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS security_config (
  key        VARCHAR PRIMARY KEY,
  value      VARCHAR NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
`;

// ── Store ─────────────────────────────────────────────────────────────────────

export class SecurityStore {
  constructor(private db: DatabaseManager) {}

  async ensureTable(): Promise<void> {
    await this.db.run(DDL);
  }

  // ── Scan runs ──────────────────────────────────────────────────────────────

  async createRun(scanType: ScanType): Promise<SecurityScanRun> {
    const id  = randomUUID();
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO security_scan_runs
         (id, scan_type, status, started_at, finding_count, new_finding_count)
       VALUES (?, ?, 'running', ?, 0, 0)`,
      [id, scanType, now]
    );
    return (await this.getRunById(id))!;
  }

  /** Closes any runs left in 'running' or 'analyzing' state from a previous crashed session. */
  async closeOrphanedRuns(): Promise<number> {
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE security_scan_runs
       SET status        = 'error',
           completed_at  = ?,
           error_message = 'Interrupted — PHOBOS restarted while scan was in progress.'
       WHERE status IN ('running', 'analyzing')`,
      [now]
    );
    const row = await this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM security_scan_runs WHERE completed_at = ?`, [now]
    );
    return row?.n ?? 0;
  }

  /** Transitions a run to 'analyzing' — scan finished, AI digest in progress. */
  async setAnalyzing(id: string): Promise<void> {
    await this.db.run(
      `UPDATE security_scan_runs SET status = 'analyzing' WHERE id = ?`,
      [id]
    );
  }

  async completeRun(
    id:              string,
    status:          ScanStatus,
    findingCount:    number,
    newFindingCount: number,
    rawOutput:       string | null,
    errorMessage:    string | null,
    serenDigest:     string | null,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE security_scan_runs SET
         status            = ?,
         completed_at      = ?,
         finding_count     = ?,
         new_finding_count = ?,
         raw_output        = ?,
         error_message     = ?,
         seren_digest      = ?
       WHERE id = ?`,
      [status, now, findingCount, newFindingCount, rawOutput, errorMessage, serenDigest, id]
    );
  }

  async getRunById(id: string): Promise<SecurityScanRun | null> {
    return this.db.queryOne<SecurityScanRun>(
      `SELECT * FROM security_scan_runs WHERE id = ?`, [id]
    );
  }

  async getRecentRuns(limit = 50): Promise<SecurityScanRun[]> {
    return this.db.query<SecurityScanRun>(
      `SELECT * FROM security_scan_runs ORDER BY started_at DESC LIMIT ?`, [limit]
    );
  }

  /** Returns the most recent completed run for each scan type. */
  async getLastRunPerType(): Promise<Partial<Record<ScanType, SecurityScanRun>>> {
    // Return the active running row if present, otherwise the latest completed row.
    const rows = await this.db.query<SecurityScanRun>(
      `WITH ranked AS (
         SELECT *,
           ROW_NUMBER() OVER (
             PARTITION BY scan_type
             ORDER BY
               CASE WHEN status = 'running' THEN 0 ELSE 1 END,
               started_at DESC
           ) AS rn
         FROM security_scan_runs
       )
       SELECT * EXCLUDE (rn) FROM ranked WHERE rn = 1`
    );
    const result: Partial<Record<ScanType, SecurityScanRun>> = {};
    for (const row of rows) result[row.scan_type] = row;
    return result;
  }

  // ── Findings ───────────────────────────────────────────────────────────────

  async insertFindings(findings: Omit<SecurityFinding, 'id' | 'created_at'>[]): Promise<void> {
    const now = new Date().toISOString();
    for (const f of findings) {
      await this.db.run(
        `INSERT INTO security_findings
           (id, run_id, scan_type, severity, title, detail, target, cve_id, is_new, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), f.run_id, f.scan_type, f.severity, f.title,
         f.detail ?? null, f.target ?? null, f.cve_id ?? null, f.is_new, now]
      );
    }
  }

  async getFindingsByRun(runId: string): Promise<SecurityFinding[]> {
    return this.db.query<SecurityFinding>(
      `SELECT * FROM security_findings WHERE run_id = ? ORDER BY severity, title`,
      [runId]
    );
  }

  async getFindings(opts: {
    scanType?: ScanType;
    severity?: Severity;
    isNew?: boolean;
    limit?: number;
  } = {}): Promise<SecurityFinding[]> {
    const conditions: string[] = [];
    const params:     unknown[] = [];

    if (opts.scanType !== undefined) { conditions.push('scan_type = ?'); params.push(opts.scanType); }
    if (opts.severity !== undefined) { conditions.push('severity = ?');  params.push(opts.severity); }
    if (opts.isNew    !== undefined) { conditions.push('is_new = ?');    params.push(opts.isNew); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit ?? 200;
    params.push(limit);

    return this.db.query<SecurityFinding>(
      `SELECT * FROM security_findings ${where} ORDER BY created_at DESC LIMIT ?`,
      params
    );
  }

  /**
   * Returns the set of (scan_type, title, target) tuples from the most recent
   * run of each type. Used to classify findings as new vs. recurring.
   */
  async getPriorFindingKeys(scanType: ScanType): Promise<Set<string>> {
    const rows = await this.db.query<{ title: string; target: string | null }>(
      `SELECT f.title, f.target
       FROM security_findings f
       INNER JOIN security_scan_runs r ON r.id = f.run_id
       WHERE f.scan_type = ?
         AND r.id = (
           SELECT id FROM security_scan_runs
           WHERE scan_type = ? AND status = 'success'
           ORDER BY started_at DESC
           LIMIT 1
         )`,
      [scanType, scanType]
    );
    const keys = new Set<string>();
    for (const row of rows) keys.add(`${row.title}||${row.target ?? ''}`);
    return keys;
  }

  // ── Integrity baseline ─────────────────────────────────────────────────────

  async upsertBaseline(entries: IntegrityBaseline[]): Promise<void> {
    for (const e of entries) {
      await this.db.run(
        `DELETE FROM security_integrity_baseline WHERE path = ?`, [e.path]
      );
      await this.db.run(
        `INSERT INTO security_integrity_baseline (path, sha256, size_bytes, baselined_at)
         VALUES (?, ?, ?, ?)`,
        [e.path, e.sha256, e.size_bytes, e.baselined_at]
      );
    }
  }

  async getBaseline(): Promise<IntegrityBaseline[]> {
    return this.db.query<IntegrityBaseline>(
      `SELECT * FROM security_integrity_baseline ORDER BY path`
    );
  }

  async clearBaseline(): Promise<void> {
    await this.db.run(`DELETE FROM security_integrity_baseline`);
  }

  async baselineCount(): Promise<number> {
    const row = await this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM security_integrity_baseline`
    );
    return row?.n ?? 0;
  }

  // ── Config ─────────────────────────────────────────────────────────────────

  async getConfig(key: SecurityConfigKey): Promise<string> {
    const row = await this.db.queryOne<{ value: string }>(
      `SELECT value FROM security_config WHERE key = ?`, [key]
    );
    return row?.value ?? CONFIG_DEFAULTS[key];
  }

  async setConfig(key: SecurityConfigKey, value: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(`DELETE FROM security_config WHERE key = ?`, [key]);
    await this.db.run(
      `INSERT INTO security_config (key, value, updated_at) VALUES (?, ?, ?)`,
      [key, value, now]
    );
  }

  async getAllConfig(): Promise<Record<SecurityConfigKey, string>> {
    const rows = await this.db.query<{ key: string; value: string }>(
      `SELECT key, value FROM security_config`
    );
    const result = { ...CONFIG_DEFAULTS };
    for (const row of rows) {
      result[row.key as SecurityConfigKey] = row.value;
    }
    return result;
  }
}