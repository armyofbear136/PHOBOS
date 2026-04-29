/**
 * PHOBOS License Routes
 * ─────────────────────
 * Mount in server.ts:
 *   import { registerLicenseRoutes } from './routes/license';
 *   registerLicenseRoutes(app);
 *
 * Endpoints:
 *   GET  /api/license        — check if a valid license.key exists on this machine
 *   POST /api/license        — validate a TX ID (online check + offline fallback),
 *                               generate key, write ~/.phobos/license.key
 *   POST /api/license/check  — validate a raw key string against a TX ID (internal)
 *
 * Online verification:
 *   1. User submits TX ID
 *   2. phobos-core calls AUTARCH_LICENSE_URL/api/licenses/verify/:txId
 *   3. If valid → generate key, write to disk
 *   4. If server unreachable / timeout → fallback to local keygen (offline grace)
 *   5. If server explicitly says not_found → reject
 */

import { FastifyInstance } from 'fastify';
import { createHmac } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PHOBOS_LICENSE_SEED = process.env.PHOBOS_LICENSE_SEED ?? 'REPLACE_WITH_YOUR_SECRET_SEED_BEFORE_USE';
const AUTARCH_LICENSE_URL = (process.env.AUTARCH_LICENSE_URL ?? 'https://autarch.net').replace(/\/$/, '');
const VERIFY_TIMEOUT_MS = 8000;
const KEY_VERSION = 'PH1';

// ─── Paths ───────────────────────────────────────────────────────────────────
function getPhobosDir(): string {
  return join(homedir(), '.phobos');
}

function getLicenseKeyPath(): string {
  return join(getPhobosDir(), 'license.key');
}

// ─── Key generation (matches server.js and generate-license.ts) ─────────────
function generateLicenseKey(transactionId: string): string {
  const normalized = transactionId.trim().toUpperCase();
  const hmac = createHmac('sha256', PHOBOS_LICENSE_SEED);
  hmac.update(normalized);
  const hash = hmac.digest('hex').toUpperCase();
  const chunks = hash.match(/.{1,8}/g)!.slice(0, 5).join('-');
  return `${KEY_VERSION}-${chunks}`;
}

function validateKeyAgainstTx(transactionId: string, key: string): boolean {
  try {
    const expected = generateLicenseKey(transactionId);
    const a = Buffer.from(expected.padEnd(64));
    const b = Buffer.from(key.trim().padEnd(64));
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  } catch {
    return false;
  }
}

// ─── Online verification with offline fallback ──────────────────────────────
interface VerifyResult {
  valid: boolean;
  key?: string;
  reason?: string;
  source: 'online' | 'offline';
}

async function verifyOnline(transactionId: string): Promise<VerifyResult> {
  const normalized = transactionId.trim().toUpperCase();
  const url = `${AUTARCH_LICENSE_URL}/api/licenses/verify/${encodeURIComponent(normalized)}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`License server returned ${res.status} — falling back to offline`);
      return { valid: true, source: 'offline', reason: 'server_error_fallback' };
    }

    const data = await res.json() as { valid: boolean; key?: string; reason?: string };

    if (data.valid) {
      return { valid: true, key: data.key, source: 'online' };
    }

    // Server explicitly rejected — TX ID not in whitelist
    return { valid: false, reason: data.reason ?? 'not_found', source: 'online' };
  } catch (err: any) {
    const reason = err.name === 'AbortError' ? 'timeout' : 'network_error';
    console.warn(`License server unreachable (${reason}) — falling back to offline keygen`);
    return { valid: true, source: 'offline', reason };
  }
}

// ─── License file helpers ────────────────────────────────────────────────────
function readLicenseFile(): string | null {
  const path = getLicenseKeyPath();
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function extractKeyFromFile(content: string): string | null {
  const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  return lines[lines.length - 1] ?? null;
}

function isLicenseFileValid(): boolean {
  if (PHOBOS_LICENSE_SEED === 'REPLACE_WITH_YOUR_SECRET_SEED_BEFORE_USE') return false;
  const content = readLicenseFile();
  if (!content) return false;
  const key = extractKeyFromFile(content);
  if (!key || !key.startsWith(`${KEY_VERSION}-`)) return false;

  const txLine = content.split('\n').find(l => l.startsWith('# Transaction:'));
  if (!txLine) return false;
  const txId = txLine.replace('# Transaction:', '').trim();
  return validateKeyAgainstTx(txId, key);
}

function writeLicenseFile(transactionId: string, key: string, username: string): void {
  const dir = getPhobosDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().split('T')[0];
  const content = [
    '# PHOBOS License Key',
    '# Place this file at: ~/.phobos/license.key',
    '# Do not share this file. One active connection per license.',
    `# Generated: ${date}`,
    `# Transaction: ${transactionId.trim().toUpperCase()}`,
    `# Username: ${username.trim()}`,
    '',
    key,
    '',
  ].join('\n');
  writeFileSync(getLicenseKeyPath(), content, 'utf-8');
}

function extractUsernameFromFile(content: string): string {
  const line = content.split('\n').find(l => l.startsWith('# Username:'));
  return line ? line.replace('# Username:', '').trim() : '';
}

// ─── Route registration ──────────────────────────────────────────────────────
export async function registerLicenseRoutes(app: FastifyInstance) {

  // GET /api/license — check whether a valid license exists on this machine
  app.get('/api/license', async (_req, reply) => {
    if (PHOBOS_LICENSE_SEED === 'REPLACE_WITH_YOUR_SECRET_SEED_BEFORE_USE') {
      return reply.send({ valid: false, reason: 'seed_not_configured' });
    }
    const valid = isLicenseFileValid();
    if (!valid) return reply.send({ valid: false, tier: null, username: null });
    const content  = readLicenseFile() ?? '';
    const username = extractUsernameFromFile(content);
    return reply.send({ valid: true, tier: 'individual', username: username || null });
  });

  // POST /api/license — validate TX ID (online + offline fallback), keygen, write
  app.post('/api/license', async (req, reply) => {
    const { transactionId, username = '' } = req.body as { transactionId?: string; username?: string };

    if (!transactionId?.trim()) {
      return reply.status(400).send({ valid: false, reason: 'missing_transaction_id' });
    }

    if (PHOBOS_LICENSE_SEED === 'REPLACE_WITH_YOUR_SECRET_SEED_BEFORE_USE') {
      return reply.status(503).send({ valid: false, reason: 'license_system_not_configured' });
    }

    // Online verification with offline fallback
    const result = await verifyOnline(transactionId);

    if (!result.valid) {
      return reply.status(403).send({
        valid: false,
        reason: result.reason ?? 'transaction_not_found',
        message: 'Transaction ID not found in the license registry. Check your PayPal receipt and try again.',
      });
    }

    // Use username from autarch response if present (set during activation), else fall back to body param
    const resolvedUsername = (result as any).username?.trim() || username.trim() || '';
    const key = generateLicenseKey(transactionId);

    try {
      writeLicenseFile(transactionId, key, resolvedUsername);
      return reply.send({
        valid: true,
        key,
        username: resolvedUsername,
        source: result.source,
      });
    } catch (err) {
      app.log.error('Failed to write license file:');
      return reply.status(500).send({ valid: false, reason: 'write_failed' });
    }
  });

  // POST /api/license/check — validate a raw key string
  app.post('/api/license/check', async (req, reply) => {
    const { key, transactionId } = req.body as { key?: string; transactionId?: string };
    if (!key || !transactionId) {
      return reply.status(400).send({ valid: false });
    }
    const valid = validateKeyAgainstTx(transactionId, key);
    return reply.send({ valid });
  });

  // GET /api/patrons — proxy to autarch; returns top 100 [{ username, amount }]
  app.get('/api/patrons', async (_req, reply) => {
    try {
      const url = `${AUTARCH_LICENSE_URL}/api/patrons`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
      const res = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/json' } });
      clearTimeout(timeout);
      if (!res.ok) return reply.status(502).send({ error: 'patrons_unavailable' });
      const data = await res.json();
      return reply.send(data);
    } catch {
      return reply.status(502).send({ error: 'patrons_unavailable' });
    }
  });
}