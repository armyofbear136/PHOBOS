#!/usr/bin/env node
/**
 * PHOBOS License Key Generator
 * ─────────────────────────────
 * Usage:
 *   npx tsx scripts/generate-license.ts <PayPal_Transaction_ID>
 *   npx tsx scripts/generate-license.ts 5TY12345AB678901C
 *
 * Or generate multiple at once (for manual tester keys):
 *   npx tsx scripts/generate-license.ts 5TY12345AB678901C 3AB98765CD123456E
 *
 * Output: prints the license key to stdout AND writes license.key to ./output/
 *
 * KEEP THIS FILE AND PHOBOS_LICENSE_SEED OUT OF VERSION CONTROL.
 * Add scripts/generate-license.ts to .gitignore if distributing source.
 */

import { createHmac } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// ─── SECRET SEED ─────────────────────────────────────────────────────────────
// Reads from PHOBOS_LICENSE_SEED env var, falls back to hardcoded value.
// The hardcoded value here is your private copy — this file is gitignored.
// NEVER commit this value to version control.
const PHOBOS_LICENSE_SEED = process.env.PHOBOS_LICENSE_SEED ?? 'PHOBOS136631136631136631';

// ─── Key format version — bump if you ever change the algorithm ──────────────
const KEY_VERSION = 'PH1';

// ─── Core algorithm ──────────────────────────────────────────────────────────
// This same algorithm runs in phobos-core's license validation route.
// It is NEVER shipped to the frontend.
export function generateLicenseKey(transactionId: string): string {
  const normalized = transactionId.trim().toUpperCase();
  const hmac = createHmac('sha256', PHOBOS_LICENSE_SEED);
  hmac.update(normalized);
  const hash = hmac.digest('hex').toUpperCase();

  // Format: PH1-XXXX-XXXX-XXXX-XXXX-XXXX (readable chunks)
  const chunks = hash.match(/.{1,8}/g)!.slice(0, 5).join('-');
  return `${KEY_VERSION}-${chunks}`;
}

export function buildKeyFileContent(transactionId: string, key: string, username = ''): string {
  const date = new Date().toISOString().split('T')[0];
  return [
    '# PHOBOS License Key',
    '# Place this file at: ~/.phobos/license.key',
    '# Windows: C:\\Users\\YourName\\.phobos\\license.key',
    '# Do not share this file. One active connection per license.',
    `# Generated: ${date}`,
    `# Transaction: ${transactionId.trim().toUpperCase()}`,
    `# Username: ${username.trim()}`,
    '',
    key,
    '',
  ].join('\n');
}

// ─── Validation helper (used by phobos-core route) ───────────────────────────
export function validateLicenseKey(transactionId: string, key: string): boolean {
  try {
    const expected = generateLicenseKey(transactionId);
    // Constant-time comparison to prevent timing attacks
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

// ─── CLI entrypoint ───────────────────────────────────────────────────────────
if (process.argv[1].includes('generate-license')) {
  const txIds = process.argv.slice(2);

  if (txIds.length === 0) {
    console.error('\nUsage: npx tsx scripts/generate-license.ts <TX_ID> <USERNAME>\n');
    process.exit(1);
  }

  const txId     = txIds[0];
  const username = process.argv[3] ?? '';

  if (!username) {
    console.warn('\n⚠  No username provided — key file will have an empty # Username: line.\n');
  }

  mkdirSync(join(process.cwd(), 'output'), { recursive: true });

  const key     = generateLicenseKey(txId);
  const content = buildKeyFileContent(txId, key, username);
  const outPath = join(process.cwd(), 'output', `license-${txId.slice(0, 8)}.key`);

  writeFileSync(outPath, content, 'utf-8');

  console.log('\n──────────────────────────────────────────');
  console.log(`TX ID    : ${txId.trim().toUpperCase()}`);
  console.log(`USERNAME : ${username || '(none)'}`);
  console.log(`KEY      : ${key}`);
  console.log(`FILE     : ${outPath}`);
  console.log('──────────────────────────────────────────');
  console.log('\n✓ Done. Send the .key file to the patron.\n');
}
