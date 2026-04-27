/**
 * securityRoutes.ts — PHOBOS Security API routes.
 *
 * GET    /api/security/status                   — tool availability + last run summary per type
 * GET    /api/security/runs                     — recent scan runs (last 50)
 * GET    /api/security/runs/:id                 — single run detail with findings
 * GET    /api/security/findings                 — findings, filterable by type/severity/is_new
 * POST   /api/security/scans/:type/run          — trigger a scan (async, returns runId)
 * GET    /api/security/config                   — current schedule + target config
 * PUT    /api/security/config                   — patch config key-value pairs
 * GET    /api/security/baseline                 — list integrity baseline entries
 * POST   /api/security/baseline/reset           — rebuild integrity baseline
 * POST   /api/security/code-audit               — on-demand code audit (body: { targetPath })
 * POST   /api/security/tools/clamav/fetch       — download ClamAV binary + definitions (async)
 * POST   /api/security/tools/clamav/update-defs — update virus definitions only (async)
 * GET    /api/security/tools/clamav/progress    — fetch/update progress (SSE stream)
 */

import type { FastifyInstance } from 'fastify';
import * as path                from 'node:path';
import * as os                  from 'node:os';
import { DatabaseManager }      from '../db/DatabaseManager.js';
import { SecurityStore, type ScanType, type Severity, type SecurityConfigKey }
  from '../db/SecurityStore.js';
import { ScheduledTaskStore }   from '../db/ScheduledTaskStore.js';
import {
  getToolStatus,
  dispatchScan,
  runCodeAudit,
  syncScheduledTasks,
} from '../security/SecurityScanManager.js';
import { buildBaseline }        from '../security/FileIntegrityRunner.js';
import {
  fetchClamAv,
  updateDefinitions,
  runUpdateDefinitions,
  getFetchProgress,
}                               from '../security/ClamAvManager.js';

const VALID_SCAN_TYPES = new Set<ScanType>([
  'port_scan', 'web_scan', 'malware_scan',
  'dependency_audit', 'system_audit', 'integrity_check',
]);

const VALID_SEVERITIES = new Set<Severity>([
  'critical', 'high', 'medium', 'low', 'info',
]);

const VALID_CONFIG_KEYS = new Set<SecurityConfigKey>([
  'port_scan_cron', 'web_scan_cron', 'malware_scan_cron',
  'dependency_audit_cron', 'system_audit_cron', 'integrity_check_cron',
  'malware_scan_paths', 'semgrep_enabled', 'integrity_enabled',
  'clamav_update_cron',
] as SecurityConfigKey[]);

export async function registerSecurityRoutes(fastify: FastifyInstance): Promise<void> {
  const db        = DatabaseManager.getInstance();
  const store     = new SecurityStore(db);
  const taskStore = new ScheduledTaskStore(db);
  await store.ensureTable();

  // ── Status — tool availability + last run per type ─────────────────────────

  fastify.get('/api/security/status', async (_req, reply) => {
    const [tools, lastRuns, config] = await Promise.all([
      getToolStatus(),
      store.getLastRunPerType(),
      store.getAllConfig(),
    ]);
    return reply.send({ tools, lastRuns, config, homedir: os.homedir() });
  });

  // ── Scan runs ──────────────────────────────────────────────────────────────

  fastify.get('/api/security/runs', async (_req, reply) => {
    const runs = await store.getRecentRuns(50);
    return reply.send(runs);
  });

  fastify.get<{ Params: { id: string } }>('/api/security/runs/:id', async (req, reply) => {
    const run = await store.getRunById(req.params.id);
    if (!run) return reply.status(404).send({ error: 'Run not found' });
    const findings = await store.getFindingsByRun(req.params.id);
    return reply.send({ run, findings });
  });

  // ── Findings ───────────────────────────────────────────────────────────────

  fastify.get<{
    Querystring: {
      scan_type?: string;
      severity?:  string;
      is_new?:    string;
      limit?:     string;
    };
  }>('/api/security/findings', async (req, reply) => {
    const { scan_type, severity, is_new, limit } = req.query;

    const opts: Parameters<SecurityStore['getFindings']>[0] = {};

    if (scan_type && VALID_SCAN_TYPES.has(scan_type as ScanType)) {
      opts.scanType = scan_type as ScanType;
    }
    if (severity && VALID_SEVERITIES.has(severity as Severity)) {
      opts.severity = severity as Severity;
    }
    if (is_new !== undefined) {
      opts.isNew = is_new === 'true';
    }
    if (limit) {
      const n = parseInt(limit, 10);
      if (!isNaN(n) && n > 0 && n <= 1000) opts.limit = n;
    }

    const findings = await store.getFindings(opts);
    return reply.send(findings);
  });

  // ── Trigger scan ───────────────────────────────────────────────────────────

  fastify.post<{ Params: { type: string } }>('/api/security/scans/:type/run', async (req, reply) => {
    const type = req.params.type as ScanType;
    if (!VALID_SCAN_TYPES.has(type)) {
      return reply.status(400).send({ error: `Invalid scan type: ${type}` });
    }

    const port = parseInt(process.env.PORT ?? '3001', 10);

    try {
      const runId = await dispatchScan(store, type, port);
      return reply.status(202).send({ ok: true, runId });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── Config ─────────────────────────────────────────────────────────────────

  fastify.get('/api/security/config', async (_req, reply) => {
    const config = await store.getAllConfig();
    return reply.send(config);
  });

  fastify.put<{
    Body: Partial<Record<SecurityConfigKey, string>>;
  }>('/api/security/config', async (req, reply) => {
    const patch = req.body;
    if (!patch || typeof patch !== 'object') {
      return reply.status(400).send({ error: 'Body must be a key-value object' });
    }

    for (const [key, value] of Object.entries(patch)) {
      if (!VALID_CONFIG_KEYS.has(key as SecurityConfigKey)) {
        return reply.status(400).send({ error: `Unknown config key: ${key}` });
      }
      if (typeof value !== 'string') {
        return reply.status(400).send({ error: `Value for ${key} must be a string` });
      }
      await store.setConfig(key as SecurityConfigKey, value);
    }

    await syncScheduledTasks(store, taskStore);

    return reply.send(await store.getAllConfig());
  });

  // ── Integrity baseline ─────────────────────────────────────────────────────

  fastify.get('/api/security/baseline', async (_req, reply) => {
    const baseline = await store.getBaseline();
    return reply.send(baseline);
  });

  fastify.post('/api/security/baseline/reset', async (_req, reply) => {
    try {
      await store.clearBaseline();
      const entries = await buildBaseline();
      await store.upsertBaseline(entries);
      return reply.send({ ok: true, count: entries.length });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── On-demand code audit ───────────────────────────────────────────────────

  fastify.post<{
    Body: { targetPath: string };
  }>('/api/security/code-audit', async (req, reply) => {
    const { targetPath } = req.body ?? {};
    if (!targetPath || typeof targetPath !== 'string') {
      return reply.status(400).send({ error: 'targetPath is required' });
    }

    const workspacesRoot = process.env.WORKSPACES_ROOT ?? '';
    if (workspacesRoot) {
      const normalised = path.resolve(targetPath);
      if (!normalised.startsWith(path.resolve(workspacesRoot))) {
        return reply.status(400).send({ error: 'targetPath must be within the PHOBOS workspaces directory' });
      }
    }

    try {
      const runId = await runCodeAudit(store, targetPath);
      return reply.status(202).send({ ok: true, runId });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── ClamAV: fetch binary + definitions (async) ─────────────────────────────
  //
  // Fires off fetchClamAv() in the background. Progress is polled via the
  // /progress SSE endpoint below. Returns immediately with 202.

  let _fetchInProgress = false;

  fastify.post('/api/security/tools/clamav/fetch', async (_req, reply) => {
    if (_fetchInProgress) {
      return reply.status(409).send({ error: 'ClamAV fetch already in progress' });
    }
    _fetchInProgress = true;

    setImmediate(() => {
      fetchClamAv()
        .catch(err => console.error('[SecurityRoutes] ClamAV fetch error:', err))
        .finally(() => { _fetchInProgress = false; });
    });

    return reply.status(202).send({ ok: true });
  });

  // ── ClamAV: update definitions only (async) ────────────────────────────────

  let _updateInProgress = false;

  fastify.post('/api/security/tools/clamav/update-defs', async (_req, reply) => {
    if (_updateInProgress) {
      return reply.status(409).send({ error: 'Definition update already in progress' });
    }
    _updateInProgress = true;

    setImmediate(() => {
      runUpdateDefinitions()
        .catch(err => console.error('[SecurityRoutes] ClamAV update-defs error:', err))
        .finally(() => { _updateInProgress = false; });
    });

    return reply.status(202).send({ ok: true });
  });

  // ── ClamAV: progress SSE stream ────────────────────────────────────────────
  //
  // Client polls this or holds a connection. Returns a single SSE event per
  // request (connection: close) — the frontend polls every 1.5s rather than
  // holding a persistent stream, keeping implementation simple.

  fastify.get('/api/security/tools/clamav/progress', async (_req, reply) => {
    const progress = getFetchProgress();
    return reply
      .header('Content-Type', 'text/event-stream')
      .header('Cache-Control', 'no-cache')
      .header('Connection', 'close')
      .send(`data: ${JSON.stringify(progress)}\n\n`);
  });
}