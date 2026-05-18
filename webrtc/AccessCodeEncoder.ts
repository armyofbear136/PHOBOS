/**
 * AccessCodeEncoder.ts — structured PHOBOS access code encoding.
 *
 * Format:  PH1.<type>.<base64url(JSON payload)>
 *
 * Types:
 *   OWN  — owner self-access (permanent, single device registration)
 *   GST  — guest access (registers a new guest user on first use)
 *   FRD  — friend invite (reserved; bilateral friend registration)
 *
 * Payload fields:
 *   r  — relay URL            (e.g. "wss://autarch.net/relay")
 *   i  — instance UUID        (permanent core identity)
 *   e  — expires_at ISO 8601  (Date.toISOString())
 *   c  — nonce                (16-byte hex, stored in access_codes.code)
 *
 * The nonce is what gets stored in the DB and used as the lookup key.
 * The full PH1.* string is never stored — it is re-encoded on read.
 */

import { randomBytes } from 'node:crypto';

export type AccessCodeType = 'OWN' | 'GST' | 'FRD';

export interface AccessCodePayload {
  r: string;  // relayUrl
  i: string;  // instanceId
  e: string;  // expires_at ISO string
  c: string;  // nonce (16-byte hex)
}

export interface DecodedAccessCode {
  type:       AccessCodeType;
  relayUrl:   string;
  instanceId: string;
  expiresAt:  Date;
  nonce:      string;
}

/** Generate a 16-byte hex nonce for use as the DB primary key. */
export function generateNonce(): string {
  return randomBytes(16).toString('hex');
}

/** Encode a structured access code from its parts. */
export function encodeAccessCode(
  type:       AccessCodeType,
  instanceId: string,
  relayUrl:   string,
  expiresAt:  Date,
  nonce:      string,
): string {
  const payload: AccessCodePayload = {
    r: relayUrl,
    i: instanceId,
    e: expiresAt.toISOString(),
    c: nonce,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `PH1.${type}.${encoded}`;
}

/** Decode and validate a PH1.* access code string. Returns null if malformed. */
export function decodeAccessCode(code: string): DecodedAccessCode | null {
  const parts = code.split('.');
  if (parts.length !== 3 || parts[0] !== 'PH1') return null;

  const type = parts[1] as AccessCodeType;
  if (!['OWN', 'GST', 'FRD'].includes(type)) return null;

  let payload: AccessCodePayload;
  try {
    payload = JSON.parse(Buffer.from(parts[2], 'base64url').toString('utf8')) as AccessCodePayload;
  } catch {
    return null;
  }

  if (!payload.r || !payload.i || !payload.e || !payload.c) return null;

  const expiresAt = new Date(payload.e);
  if (isNaN(expiresAt.getTime())) return null;

  return {
    type,
    relayUrl:   payload.r,
    instanceId: payload.i,
    expiresAt,
    nonce:      payload.c,
  };
}

/** Returns true if this string looks like a PH1.* code (does not validate payload). */
export function isStructuredCode(code: string): boolean {
  return code.startsWith('PH1.');
}
