/**
 * SculptGLManager.ts — Static file server for the SculptGL web editor.
 *
 * SculptGL requires no COOP/COEP headers and no dedicated port — same pattern
 * as BlockbenchManager. PHOBOS serves its build output directly via Fastify
 * static routes at /tools/sculptgl/.
 *
 * This manager exposes only presence checks and status — no server lifecycle.
 * Fastify handles serving via @fastify/static registered in toolsRoute.ts.
 *
 * Build directory: ~/.phobos/editors/sculptgl/
 *   Populated by: node scripts/fetch-sculptgl.js
 *   Entry point:  index.html
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';
import * as os   from 'node:os';

// ── Paths ──────────────────────────────────────────────────────────────────────

export const SCULPTGL_DIR = path.join(os.homedir(), '.phobos', 'editors', 'sculptgl');

export function isSculptGLBuildPresent(): boolean {
  return fs.existsSync(path.join(SCULPTGL_DIR, 'index.html'));
}

// ── Status ─────────────────────────────────────────────────────────────────────

export interface SculptGLStatus {
  buildPresent: boolean;
  buildDir:     string;
}

export function getSculptGLStatus(): SculptGLStatus {
  return {
    buildPresent: isSculptGLBuildPresent(),
    buildDir:     SCULPTGL_DIR,
  };
}
