/**
 * BlockbenchManager.ts — Static file server for the Blockbench web editor.
 *
 * Blockbench requires no COOP/COEP headers and no dedicated port — unlike
 * Omniclip it does not use SharedArrayBuffer. PHOBOS serves its build output
 * directly via Fastify static routes at /tools/blockbench/.
 *
 * This manager exposes only presence checks and status — no server lifecycle.
 * Fastify handles serving via @fastify/static registered in toolsRoute.ts.
 *
 * Build directory: ~/.phobos/editors/blockbench/
 *   Populated by: node scripts/fetch-blockbench.js
 *   Entry point:  index.html
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';
import * as os   from 'node:os';

// ── Paths ──────────────────────────────────────────────────────────────────────

export const BLOCKBENCH_DIR = path.join(os.homedir(), '.phobos', 'editors', 'blockbench');

export function isBuildPresent(): boolean {
  return fs.existsSync(path.join(BLOCKBENCH_DIR, 'index.html'));
}

// ── Status ─────────────────────────────────────────────────────────────────────

export interface BlockbenchStatus {
  buildPresent: boolean;
  buildDir:     string;
}

export function getBlockbenchStatus(): BlockbenchStatus {
  return {
    buildPresent: isBuildPresent(),
    buildDir:     BLOCKBENCH_DIR,
  };
}
