/**
 * SecurityScanManager.ts — scan dispatcher, scheduler sync, SEREN digest.
 *
 * All five external subprocess runners have been replaced with native TypeScript
 * implementations. SystemAuditRunner and FileIntegrityRunner are unchanged.
 *
 * Public API (dispatchScan, runCodeAudit, getToolStatus, syncScheduledTasks)
 * is identical to Phase 1 — routes and frontend require no modification.
 */

import * as path  from 'node:path';
import * as os    from 'node:os';
import {
  SecurityStore,
  type ScanType,
  type SecurityFinding,
} from '../db/SecurityStore.js';
import { ScheduledTaskStore }            from '../db/ScheduledTaskStore.js';
import { computeNextRun, getScheduler }  from '../scheduling/Scheduler.js';
import { buildBaseline, checkIntegrity } from './FileIntegrityRunner.js';
import { runSystemAudit }                from './SystemAuditRunner.js';
import { runPortScan }                   from './PortScanner.js';
import { runHttpAudit }                  from './HttpAuditor.js';
import { runCodeAudit as codeAuditRun }  from './CodeAuditor.js';
import { runDependencyAudit }            from './DependencyAuditor.js';
import {
  runMalwareScan,
  clamavBinaryPath,
  runUpdateDefinitions,
}                                        from './ClamAvManager.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const RAW_OUTPUT_CAP = 64 * 1024;

// Scheduled task names — prefixed so SchedulerPanel filters them out.
const TASK_NAMES: Record<ScanType, string> = {
  port_scan:        '__security_port_scan__',
  web_scan:         '__security_web_scan__',
  malware_scan:     '__security_malware_scan__',
  dependency_audit: '__security_dependency_audit__',
  system_audit:     '__security_system_audit__',
  integrity_check:  '__security_integrity_check__',
  code_audit:       '__security_code_audit__',   // not scheduled — on-demand only
};

// Handler keys — matched by the Scheduler's handler registry.
const HANDLER_KEYS: Partial<Record<ScanType, string>> = {
  port_scan:        'security:port_scan',
  web_scan:         'security:web_scan',
  malware_scan:     'security:malware_scan',
  dependency_audit: 'security:dependency_audit',
  system_audit:     'security:system_audit',
  integrity_check:  'security:integrity_check',
};

const CLAMAV_UPDATE_TASK    = '__security_clamav_update__';
const CLAMAV_UPDATE_HANDLER = 'security:clamav_update';

// ── Tool status ───────────────────────────────────────────────────────────────

export interface ToolStatus {
  clamav: string | null;  // path to clamscan binary or null
}

export async function getToolStatus(): Promise<ToolStatus> {
  return { clamav: clamavBinaryPath() };
}

// ── Finding de-duplication key ────────────────────────────────────────────────

function findingKey(title: string, target: string | null): string {
  return `${title}||${target ?? ''}`;
}

// ── System audit wrapper ──────────────────────────────────────────────────────

async function runSystemAuditScan(store: SecurityStore, runId: string): Promise<void> {
  try {
    const priorKeys   = await store.getPriorFindingKeys('system_audit');
    const rawFindings = await runSystemAudit(runId);

    const findings = rawFindings.map(f => ({
      ...f,
      is_new: !priorKeys.has(findingKey(f.title, f.target ?? null)),
    }));

    const newCount = findings.filter(f => f.is_new).length;
    const raw      = JSON.stringify(
      findings.map(f => ({ severity: f.severity, title: f.title })),
      null, 2,
    ).slice(0, RAW_OUTPUT_CAP);

    await store.insertFindings(findings);
    await store.completeRun(runId, 'success', findings.length, newCount, raw, null, null);
  } catch (err) {
    await store.completeRun(runId, 'error', 0, 0, null, (err as Error).message, null);
  }
}

// ── Integrity check wrapper ───────────────────────────────────────────────────

async function runIntegrityCheck(store: SecurityStore, runId: string): Promise<void> {
  try {
    const baselineCount = await store.baselineCount();

    if (baselineCount === 0) {
      const entries = await buildBaseline();
      await store.upsertBaseline(entries);
      const digest = `Integrity baseline established for ${entries.length} files. No findings on first run.`;
      await store.completeRun(runId, 'success', 0, 0, `Baselined ${entries.length} files.`, null, digest);
      return;
    }

    const priorKeys   = await store.getPriorFindingKeys('integrity_check');
    const baseline    = await store.getBaseline();
    const rawFindings = await checkIntegrity(runId, baseline);

    const findings = rawFindings.map(f => ({
      ...f,
      is_new: !priorKeys.has(findingKey(f.title, f.target ?? null)),
    }));

    const newCount = findings.filter(f => f.is_new).length;
    const raw      = JSON.stringify(
      findings.map(f => ({ severity: f.severity, title: f.title, target: f.target })),
      null, 2,
    ).slice(0, RAW_OUTPUT_CAP);

    await store.insertFindings(findings);
    await store.completeRun(runId, 'success', findings.length, newCount, raw, null, null);
  } catch (err) {
    await store.completeRun(runId, 'error', 0, 0, null, (err as Error).message, null);
  }
}

// ── Code audit (on-demand) ────────────────────────────────────────────────────

export async function runCodeAudit(
  store:      SecurityStore,
  targetPath: string,
): Promise<string> {
  const run = await store.createRun('code_audit');
  setImmediate(() =>
    codeAuditRun(store, run.id, targetPath).catch((e: unknown) =>
      console.error('[SecurityScan] code_audit error:', e)
    )
  );
  return run.id;
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export async function dispatchScan(
  store: SecurityStore,
  type:  ScanType,
  port:  number,
): Promise<string> {
  const run = await store.createRun(type);
  const id  = run.id;

  switch (type) {
    case 'port_scan':
      setImmediate(() => runPortScan(store, id).catch((e: unknown) =>
        console.error('[SecurityScan] port_scan error:', e)));
      break;

    case 'web_scan':
      setImmediate(() => runHttpAudit(store, id, port).catch((e: unknown) =>
        console.error('[SecurityScan] web_scan error:', e)));
      break;

    case 'malware_scan':
      setImmediate(() => runMalwareScan(store, id).catch((e: unknown) =>
        console.error('[SecurityScan] malware_scan error:', e)));
      break;

    case 'dependency_audit':
      setImmediate(() => runDependencyAudit(store, id).catch((e: unknown) =>
        console.error('[SecurityScan] dependency_audit error:', e)));
      break;

    case 'system_audit':
      setImmediate(() => runSystemAuditScan(store, id).catch((e: unknown) =>
        console.error('[SecurityScan] system_audit error:', e)));
      break;

    case 'integrity_check':
      setImmediate(() => runIntegrityCheck(store, id).catch((e: unknown) =>
        console.error('[SecurityScan] integrity_check error:', e)));
      break;

    default:
      throw new Error(`Unknown scan type: ${type}`);
  }

  return id;
}

// ── Scheduler sync ────────────────────────────────────────────────────────────

const SCHEDULED_TYPES: ScanType[] = [
  'port_scan', 'web_scan', 'malware_scan',
  'dependency_audit', 'system_audit', 'integrity_check',
];

const CRON_KEY: Record<string, string> = {
  port_scan:        'port_scan_cron',
  web_scan:         'web_scan_cron',
  malware_scan:     'malware_scan_cron',
  dependency_audit: 'dependency_audit_cron',
  system_audit:     'system_audit_cron',
  integrity_check:  'integrity_check_cron',
};

async function upsertTask(
  taskStore:   ScheduledTaskStore,
  name:        string,
  description: string,
  cron:        string,
  handlerKey:  string,
): Promise<void> {
  const next     = computeNextRun(cron);
  const existing = await taskStore.getAll();
  const row      = existing.find(t => t.name === name);

  if (row) {
    await taskStore.update(row.id, {
      cron_expression: cron,
      next_run_at:     next?.toISOString() ?? null,
      task_type:       'security',
      handler:         handlerKey,
      enabled:         true,
    });
  } else {
    await taskStore.create({
      name,
      description,
      cron_expression: cron,
      prompt:          '',
      task_type:       'security',
      handler:         handlerKey,
      enabled:         true,
      next_run_at:     next?.toISOString() ?? null,
    });
  }
}

export async function syncScheduledTasks(
  store:     SecurityStore,
  taskStore: ScheduledTaskStore,
): Promise<void> {
  for (const type of SCHEDULED_TYPES) {
    const cronKey = CRON_KEY[type] as Parameters<SecurityStore['getConfig']>[0];
    const cron    = await store.getConfig(cronKey);
    await upsertTask(
      taskStore,
      TASK_NAMES[type],
      `Automated security scan: ${type}`,
      cron,
      HANDLER_KEYS[type]!,
    );
  }

  // ClamAV definition update task
  const clamavCron = await store.getConfig('clamav_update_cron' as Parameters<SecurityStore['getConfig']>[0]);
  await upsertTask(
    taskStore,
    CLAMAV_UPDATE_TASK,
    'ClamAV virus definition update',
    clamavCron,
    CLAMAV_UPDATE_HANDLER,
  );

  console.log('[SecurityScanManager] Scheduled tasks synced');

  // Signal the scheduler so it re-arms its wake timer for the updated next_run_at values.
  // getScheduler() may not be initialised on the very first boot call (before server.ts
  // calls initScheduler), so guard it — server.ts calls wake() explicitly after start().
  try {
    getScheduler().wake().catch(console.error);
  } catch {
    // Scheduler not yet initialised — server.ts will call start() which arms it.
  }
}

// ── Handler registration helper ───────────────────────────────────────────────
// Called once in server.ts after initScheduler() and before scheduler.start().

export function registerSecurityHandlers(
  scheduler: import('../scheduling/Scheduler.js').Scheduler,
  store:     SecurityStore,
  port:      number,
): void {
  scheduler.registerHandler('security:port_scan',        () => dispatchScan(store, 'port_scan',        port).then(() => undefined));
  scheduler.registerHandler('security:web_scan',         () => dispatchScan(store, 'web_scan',         port).then(() => undefined));
  scheduler.registerHandler('security:malware_scan',     () => dispatchScan(store, 'malware_scan',     port).then(() => undefined));
  scheduler.registerHandler('security:dependency_audit', () => dispatchScan(store, 'dependency_audit', port).then(() => undefined));
  scheduler.registerHandler('security:system_audit',     () => dispatchScan(store, 'system_audit',     port).then(() => undefined));
  scheduler.registerHandler('security:integrity_check',  () => dispatchScan(store, 'integrity_check',  port).then(() => undefined));
  scheduler.registerHandler('security:clamav_update',    () => runUpdateDefinitions());
}