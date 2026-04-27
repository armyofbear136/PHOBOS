/**
 * HttpAuditor.ts — checklist-based HTTP auditor using Node.js fetch.
 *
 * Targets http://localhost:PORT — PHOBOS's own Fastify server.
 * Checks: security headers, HTTP methods, exposed paths, information disclosure.
 * No Nikto, no Perl, no external binary.
 * 5s per request. Full audit completes in under 30 seconds.
 */

import { SecurityStore, type SecurityFinding, type Severity } from '../db/SecurityStore.js';
import { engineStream } from '../ai/clients.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 5_000;
const DIGEST_TIMEOUT_MS  = 60_000;
const RAW_OUTPUT_CAP     = 64 * 1024;
const DIGEST_INPUT_CAP   = 4_000;

// ── Security header checks ────────────────────────────────────────────────────

interface HeaderCheck {
  header:    string;
  severity:  Severity;
  detail:    string;
}

const SECURITY_HEADERS: HeaderCheck[] = [
  {
    header:   'content-security-policy',
    severity: 'high',
    detail:   'Content-Security-Policy header is missing. This allows cross-site scripting attacks.',
  },
  {
    header:   'x-frame-options',
    severity: 'medium',
    detail:   'X-Frame-Options header is missing. This allows clickjacking attacks.',
  },
  {
    header:   'x-content-type-options',
    severity: 'low',
    detail:   'X-Content-Type-Options header is missing. Browsers may MIME-sniff responses.',
  },
  {
    header:   'strict-transport-security',
    severity: 'info',
    detail:   'Strict-Transport-Security header is absent (expected on localhost, required in production).',
  },
  {
    header:   'referrer-policy',
    severity: 'info',
    detail:   'Referrer-Policy header is missing. Referrer information may leak to third parties.',
  },
];

// ── Exposed paths ─────────────────────────────────────────────────────────────

const EXPOSED_PATHS: Array<{ path: string; severity: Severity; detail: string }> = [
  { path: '/.env',           severity: 'critical', detail: 'Environment file exposed — may contain secrets, API keys, or credentials.' },
  { path: '/.git/config',    severity: 'critical', detail: 'Git repository configuration exposed — may reveal remote URLs and credentials.' },
  { path: '/config.json',    severity: 'high',     detail: 'Configuration file exposed — may contain sensitive application settings.' },
  { path: '/package.json',   severity: 'medium',   detail: 'Package manifest exposed — reveals dependency versions for fingerprinting.' },
  { path: '/api/swagger',    severity: 'medium',   detail: 'Swagger UI exposed — discloses full API surface to unauthenticated clients.' },
  { path: '/swagger-ui',     severity: 'medium',   detail: 'Swagger UI exposed — discloses full API surface to unauthenticated clients.' },
  { path: '/api-docs',       severity: 'medium',   detail: 'API documentation exposed — discloses full API surface to unauthenticated clients.' },
  { path: '/admin',          severity: 'high',     detail: 'Admin interface exposed — accessible without authentication check.' },
  { path: '/phpmyadmin',     severity: 'high',     detail: 'phpMyAdmin interface exposed — database administration accessible.' },
  { path: '/wp-admin',       severity: 'high',     detail: 'WordPress admin interface exposed.' },
  { path: '/server-status',  severity: 'medium',   detail: 'Apache server-status page exposed — reveals internal server metrics.' },
  { path: '/server-info',    severity: 'medium',   detail: 'Apache server-info page exposed — reveals module and configuration details.' },
];

// ── Fetch with timeout ────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url:    string,
  opts:   RequestInit = {},
): Promise<Response | null> {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Audit logic ───────────────────────────────────────────────────────────────

async function auditHeaders(
  base:      string,
  runId:     string,
  priorKeys: Set<string>,
): Promise<{ findings: Omit<SecurityFinding, 'id' | 'created_at'>[]; lines: string[] }> {
  const findings: Omit<SecurityFinding, 'id' | 'created_at'>[] = [];
  const lines:    string[]                                       = [];

  const resp = await fetchWithTimeout(base, { method: 'GET' });
  if (!resp) {
    lines.push('Header check: server did not respond');
    return { findings, lines };
  }

  for (const check of SECURITY_HEADERS) {
    if (!resp.headers.has(check.header)) {
      const title  = `Missing security header: ${check.header}`;
      const target = base;
      findings.push({
        run_id: runId, scan_type: 'web_scan', severity: check.severity,
        title, detail: check.detail, target, cve_id: null,
        is_new: !priorKeys.has(`${title}||${target}`),
      });
      lines.push(`${check.severity.toUpperCase().padEnd(8)} ${title}`);
    }
  }

  // Server header version disclosure
  const serverHeader = resp.headers.get('server');
  if (serverHeader && /[\d.]/.test(serverHeader)) {
    const title  = `Server header discloses version: ${serverHeader}`;
    const target = base;
    findings.push({
      run_id: runId, scan_type: 'web_scan', severity: 'low',
      title, detail: `Server: ${serverHeader} — version information aids fingerprinting.`,
      target, cve_id: null,
      is_new: !priorKeys.has(`${title}||${target}`),
    });
    lines.push(`LOW      ${title}`);
  }

  // X-Powered-By disclosure
  const poweredBy = resp.headers.get('x-powered-by');
  if (poweredBy) {
    const title  = `X-Powered-By header present: ${poweredBy}`;
    const target = base;
    findings.push({
      run_id: runId, scan_type: 'web_scan', severity: 'info',
      title, detail: `X-Powered-By: ${poweredBy} — technology stack disclosed.`,
      target, cve_id: null,
      is_new: !priorKeys.has(`${title}||${target}`),
    });
    lines.push(`INFO     ${title}`);
  }

  return { findings, lines };
}

async function auditMethods(
  base:      string,
  runId:     string,
  priorKeys: Set<string>,
): Promise<{ findings: Omit<SecurityFinding, 'id' | 'created_at'>[]; lines: string[] }> {
  const findings: Omit<SecurityFinding, 'id' | 'created_at'>[] = [];
  const lines:    string[]                                       = [];

  const resp = await fetchWithTimeout(base, { method: 'OPTIONS' });
  if (!resp) return { findings, lines };

  const allow = resp.headers.get('allow') ?? '';
  const methods = allow.split(',').map(m => m.trim().toUpperCase());

  if (methods.includes('TRACE')) {
    const title  = 'HTTP TRACE method enabled';
    const target = base;
    findings.push({
      run_id: runId, scan_type: 'web_scan', severity: 'medium',
      title, detail: 'TRACE enables cross-site tracing (XST) attacks. Disable in server config.',
      target, cve_id: null,
      is_new: !priorKeys.has(`${title}||${target}`),
    });
    lines.push(`MEDIUM   ${title}`);
  }

  for (const method of ['PUT', 'DELETE'] as const) {
    if (methods.includes(method)) {
      const title  = `HTTP ${method} method enabled on root`;
      const target = base;
      findings.push({
        run_id: runId, scan_type: 'web_scan', severity: 'high',
        title, detail: `${method} allowed on root path — verify this is intentional and properly authenticated.`,
        target, cve_id: null,
        is_new: !priorKeys.has(`${title}||${target}`),
      });
      lines.push(`HIGH     ${title}`);
    }
  }

  return { findings, lines };
}

async function auditExposedPaths(
  base:      string,
  runId:     string,
  priorKeys: Set<string>,
): Promise<{ findings: Omit<SecurityFinding, 'id' | 'created_at'>[]; lines: string[] }> {
  const findings: Omit<SecurityFinding, 'id' | 'created_at'>[] = [];
  const lines:    string[]                                       = [];

  // Probe each path concurrently — all are independent
  const results = await Promise.all(
    EXPOSED_PATHS.map(async (check) => {
      const url  = base + check.path;
      const resp = await fetchWithTimeout(url, { method: 'GET' });
      return { check, url, status: resp?.status ?? null };
    })
  );

  for (const { check, url, status } of results) {
    // 404 or null = expected. Anything else is a finding.
    if (status !== null && status !== 404 && status !== 405) {
      const title = `Exposed path: ${check.path} (HTTP ${status})`;
      findings.push({
        run_id: runId, scan_type: 'web_scan', severity: check.severity,
        title, detail: check.detail, target: url, cve_id: null,
        is_new: !priorKeys.has(`${title}||${url}`),
      });
      lines.push(`${check.severity.toUpperCase().padEnd(8)} ${title}`);
    }
  }

  return { findings, lines };
}

// ── Digest ────────────────────────────────────────────────────────────────────

async function buildDigest(
  port:         number,
  findingCount: number,
  newCount:     number,
  rawOutput:    string,
): Promise<string> {
  const preview = rawOutput.slice(0, DIGEST_INPUT_CAP);
  const prompt  = [
    `You are reviewing a PHOBOS HTTP security audit of localhost:${port}.`,
    'Summarize the findings in 3-5 sentences.',
    'Focus on: what changed since last run, the most critical issues, and any recommended action.',
    'Be concise. Do not repeat every finding verbatim.',
    '',
    `New findings:   ${newCount}`,
    `Total findings: ${findingCount}`,
    '',
    'Findings:',
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

export async function runHttpAudit(
  store:  SecurityStore,
  runId:  string,
  port:   number,
): Promise<void> {
  try {
    const base      = `http://localhost:${port}`;
    const priorKeys = await store.getPriorFindingKeys('web_scan');
    const allLines: string[] = [`HTTP audit of ${base}`, ''];

    const [headers, methods, paths] = await Promise.all([
      auditHeaders(base, runId, priorKeys),
      auditMethods(base, runId, priorKeys),
      auditExposedPaths(base, runId, priorKeys),
    ]);

    allLines.push('-- Security Headers --', ...headers.lines, '');
    allLines.push('-- HTTP Methods --',     ...methods.lines, '');
    allLines.push('-- Exposed Paths --',    ...paths.lines,   '');

    const findings = [...headers.findings, ...methods.findings, ...paths.findings];
    const newCount = findings.filter(f => f.is_new).length;
    const raw      = allLines.join('\n').slice(0, RAW_OUTPUT_CAP);

    await store.insertFindings(findings);
    await store.setAnalyzing(runId);
    const digest = await buildDigest(port, findings.length, newCount, raw);
    await store.completeRun(runId, 'success', findings.length, newCount, raw, null, digest);
  } catch (err) {
    await store.completeRun(runId, 'error', 0, 0, null, (err as Error).message, null);
  }
}