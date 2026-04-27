/**
 * PortScanner.ts — pure Node.js TCP connect port scanner.
 *
 * No nmap, no raw sockets, no elevated privileges required on any platform.
 * Uses net.createConnection with 500ms timeout, 50 concurrent probes.
 * Full scan of the defined port list completes in under 3 seconds.
 */

import * as net  from 'node:net';
import * as os   from 'node:os';
import { SecurityStore, type SecurityFinding, type Severity } from '../db/SecurityStore.js';
import { engineStream } from '../ai/clients.js';

// ── Port list ─────────────────────────────────────────────────────────────────

const PORTS_TO_SCAN = [
  21, 22, 23, 25, 53, 80, 110, 111, 135, 139, 143, 389,
  443, 445, 993, 995, 1433, 1521, 2049, 3000, 3001, 3306,
  3389, 4444, 5432, 5900, 6379, 8080, 8443, 8888, 9090,
  27017, 27018,
];

const CONNECT_TIMEOUT_MS = 500;
const CONCURRENCY        = 50;
const DIGEST_TIMEOUT_MS  = 60_000;
const RAW_OUTPUT_CAP     = 64 * 1024;
const DIGEST_INPUT_CAP   = 4_000;

// ── Severity map ──────────────────────────────────────────────────────────────

const CRITICAL_PORTS = new Set([23, 4444, 5900]);
const HIGH_PORTS     = new Set([21, 135, 139, 445, 3389]);

// ── Service name map ──────────────────────────────────────────────────────────

const SERVICE_NAMES: Record<number, string> = {
  21:    'ftp',
  22:    'ssh',
  23:    'telnet',
  25:    'smtp',
  53:    'dns',
  80:    'http',
  110:   'pop3',
  111:   'rpcbind',
  135:   'msrpc',
  139:   'netbios-ssn',
  143:   'imap',
  389:   'ldap',
  443:   'https',
  445:   'microsoft-ds',
  993:   'imaps',
  995:   'pop3s',
  1433:  'mssql',
  1521:  'oracle',
  2049:  'nfs',
  3000:  'dev-server',
  3001:  'dev-server-alt',
  3306:  'mysql',
  3389:  'rdp',
  4444:  'backdoor',
  5432:  'postgresql',
  5900:  'vnc',
  6379:  'redis',
  8080:  'http-proxy',
  8443:  'https-alt',
  8888:  'http-alt',
  9090:  'websocket',
  27017: 'mongodb',
  27018: 'mongodb-shard',
};

// ── Probe ─────────────────────────────────────────────────────────────────────

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;

    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.on('connect',  () => finish(true));
    socket.on('timeout',  () => finish(false));
    socket.on('error',    () => finish(false));
  });
}

// ── Concurrency pool ──────────────────────────────────────────────────────────

async function scanPorts(ports: number[]): Promise<number[]> {
  const open: number[]    = [];
  let   idx               = 0;

  async function worker(): Promise<void> {
    while (idx < ports.length) {
      const port = ports[idx++];
      if (await probePort(port)) open.push(port);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, ports.length) }, worker);
  await Promise.all(workers);
  return open;
}

// ── Severity assignment ───────────────────────────────────────────────────────

function portSeverity(port: number, phobosKnownPorts: Set<number>): Severity {
  if (phobosKnownPorts.has(port)) return 'info';
  if (CRITICAL_PORTS.has(port))   return 'critical';
  if (HIGH_PORTS.has(port))       return 'high';
  return 'medium';
}

function resolvePhobosKnownPorts(): Set<number> {
  const known = new Set<number>();
  const envPort = parseInt(process.env.PORT ?? '', 10);
  if (!isNaN(envPort)) known.add(envPort);
  // Standard PHOBOS managed service ports
  known.add(3000);  // Fastify default dev
  known.add(8080);  // Fastify default prod
  return known;
}

// ── Digest ────────────────────────────────────────────────────────────────────

async function buildDigest(
  findingCount: number,
  newCount:     number,
  rawOutput:    string,
): Promise<string> {
  const preview = rawOutput.slice(0, DIGEST_INPUT_CAP);
  const prompt  = [
    'You are reviewing a PHOBOS port scan result.',
    'Summarize the findings in 3-5 sentences.',
    'Focus on: what changed since last run, the most critical ports, and any recommended action.',
    'Be concise. Do not repeat every finding verbatim.',
    '',
    `New findings:   ${newCount}`,
    `Total findings: ${findingCount}`,
    '',
    'Open ports found:',
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

export async function runPortScan(store: SecurityStore, runId: string): Promise<void> {
  try {
    const priorKeys       = await store.getPriorFindingKeys('port_scan');
    const phobosKnown     = resolvePhobosKnownPorts();
    const openPorts       = await scanPorts(PORTS_TO_SCAN);

    const findings: Omit<SecurityFinding, 'id' | 'created_at'>[] = [];

    for (const port of openPorts) {
      const service  = SERVICE_NAMES[port] ?? 'unknown';
      const title    = `Open port: ${port}/tcp (${service})`;
      const target   = `127.0.0.1:${port}`;
      const severity = portSeverity(port, phobosKnown);

      findings.push({
        run_id:    runId,
        scan_type: 'port_scan',
        severity,
        title,
        detail:    `Service: ${service}. Port ${port} is accepting TCP connections on localhost.`,
        target,
        cve_id:    null,
        is_new:    !priorKeys.has(`${title}||${target}`),
      });
    }

    // Sort by severity for readable raw output
    const SEV_ORDER: Record<Severity, number> = {
      critical: 0, high: 1, medium: 2, low: 3, info: 4,
    };
    findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);

    const rawLines = openPorts.length === 0
      ? 'No open ports detected.'
      : findings.map(f => `${f.severity.toUpperCase().padEnd(8)} ${f.target}  ${f.title}`).join('\n');
    const raw      = rawLines.slice(0, RAW_OUTPUT_CAP);

    const newCount = findings.filter(f => f.is_new).length;

    await store.insertFindings(findings);
    await store.setAnalyzing(runId);
    const digest = await buildDigest(findings.length, newCount, raw);
    await store.completeRun(runId, 'success', findings.length, newCount, raw, null, digest);
  } catch (err) {
    await store.completeRun(runId, 'error', 0, 0, null, (err as Error).message, null);
  }
}