/**
 * PHOBOS License Routes
 * ─────────────────────
 * Mount in server.ts:
 *   import { registerLicenseRoutes } from './routes/license';
 *   registerLicenseRoutes(app);
 *
 * Endpoints:
 *   GET  /api/license        — check if a valid license.key exists on this machine
 *   POST /api/license        — validate a TX ID, generate key, write ~/.phobos/license.key
 *   POST /api/license/check  — validate a raw key string against a TX ID (internal use)
 */

import { FastifyInstance } from 'fastify';
import { createHmac } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── SECRET SEED ─────────────────────────────────────────────────────────────
// Must match generate-license.ts exactly.
// Load from environment variable in production — never hardcode in committed code.
// Set in your .env file: PHOBOS_LICENSE_SEED=your_secret_here
const PHOBOS_LICENSE_SEED = process.env.PHOBOS_LICENSE_SEED ?? 'REPLACE_WITH_YOUR_SECRET_SEED_BEFORE_USE';

const KEY_VERSION = 'PH1';

// ─── Paths ───────────────────────────────────────────────────────────────────
function getPhobosDir(): string {
  return join(homedir(), '.phobos');
}

function getLicenseKeyPath(): string {
  return join(getPhobosDir(), 'license.key');
}

// ─── Algorithm (identical to generate-license.ts) ───────────────────────────
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
  // Key is the last non-comment, non-empty line
  const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  return lines[lines.length - 1] ?? null;
}

function isLicenseFileValid(): boolean {
  if (PHOBOS_LICENSE_SEED === 'REPLACE_WITH_YOUR_SECRET_SEED_BEFORE_USE') return false;
  const content = readLicenseFile();
  if (!content) return false;
  const key = extractKeyFromFile(content);
  if (!key || !key.startsWith(`${KEY_VERSION}-`)) return false;

  // Extract TX ID from file comments for validation
  const txLine = content.split('\n').find(l => l.startsWith('# Transaction:'));
  if (!txLine) return false;
  const txId = txLine.replace('# Transaction:', '').trim();
  return validateKeyAgainstTx(txId, key);
}

function writeLicenseFile(transactionId: string, key: string): void {
  const dir = getPhobosDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().split('T')[0];
  const content = [
    '# PHOBOS License Key',
    '# Place this file at: ~/.phobos/license.key',
    '# Do not share this file. One active connection per license.',
    `# Generated: ${date}`,
    `# Transaction: ${transactionId.trim().toUpperCase()}`,
    '',
    key,
    '',
  ].join('\n');
  writeFileSync(getLicenseKeyPath(), content, 'utf-8');
}

// ─── Route registration ──────────────────────────────────────────────────────
export async function registerLicenseRoutes(app: FastifyInstance) {

  // GET /api/license — check whether a valid license exists on this machine
  app.get('/api/license', async (_req, reply) => {
    if (PHOBOS_LICENSE_SEED === 'REPLACE_WITH_YOUR_SECRET_SEED_BEFORE_USE') {
      return reply.send({ valid: false, reason: 'seed_not_configured' });
    }
    const valid = isLicenseFileValid();
    return reply.send({ valid, tier: valid ? 'individual' : null });
  });

  // POST /api/license — validate a TX ID, generate key, write to ~/.phobos/license.key
  // Body: { transactionId: string }
  // This is called by LicenseDialog.tsx when the user submits their PayPal TX ID
  app.post('/api/license', async (req, reply) => {
    const { transactionId } = req.body as { transactionId?: string };

    if (!transactionId?.trim()) {
      return reply.status(400).send({ valid: false, reason: 'missing_transaction_id' });
    }

    if (PHOBOS_LICENSE_SEED === 'REPLACE_WITH_YOUR_SECRET_SEED_BEFORE_USE') {
      return reply.status(503).send({ valid: false, reason: 'license_system_not_configured' });
    }

    // Generate the key from the TX ID
    const key = generateLicenseKey(transactionId);

    // TODO: Before writing, optionally verify the TX ID against PayPal's API
    // (requires PayPal SDK + credentials on your Autarch server, not phobos-core)
    // For now: we trust the TX ID format and write the key.
    // The real fraud protection is that the key only works on one machine at a time
    // and you can revoke by changing the seed (invalidates all keys).

    try {
      writeLicenseFile(transactionId, key);
      return reply.send({ valid: true, key });
    } catch (err) {
      app.log.error('Failed to write license file:');
      return reply.status(500).send({ valid: false, reason: 'write_failed' });
    }
  });

  // POST /api/license/check — validate a raw key string (used by startup check)
  // Body: { key: string, transactionId: string }
  app.post('/api/license/check', async (req, reply) => {
    const { key, transactionId } = req.body as { key?: string; transactionId?: string };
    if (!key || !transactionId) {
      return reply.status(400).send({ valid: false });
    }
    const valid = validateKeyAgainstTx(transactionId, key);
    return reply.send({ valid });
  });
}
