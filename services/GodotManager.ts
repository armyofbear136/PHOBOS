/**
 * GodotManager.ts — Static file server for the Godot 4.6.2 web editor.
 *
 * Godot's web editor requires SharedArrayBuffer (Wasm threads), which mandates
 * cross-origin isolation on every response from the server. The required headers:
 *
 *   Cross-Origin-Opener-Policy:  same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * These are applied globally in the Fastify server bootstrap (not here) so that
 * the PHOBOS frontend itself is also cross-origin isolated — a cross-origin-isolated
 * parent page is required for an embedded iframe to use SharedArrayBuffer.
 *
 * This manager exposes only presence checks and status — no server lifecycle.
 * Fastify handles serving via @fastify/static registered in toolsRoute.ts.
 *
 * Build directory: ~/.phobos/editors/godot/
 *   Populated by: node scripts/fetch-godot-editor.js
 *   Entry point:  godot.editor.html   ← NOT index.html
 */

import * as fs   from 'node:fs';
import * as path from 'node:path';
import * as os   from 'node:os';

// ── Paths ──────────────────────────────────────────────────────────────────────

export const GODOT_DIR = path.join(os.homedir(), '.phobos', 'editors', 'godot');

// Entry point is godot.editor.html — not index.html like the other editors.
export function isGodotBuildPresent(): boolean {
  return fs.existsSync(path.join(GODOT_DIR, 'godot.editor.html'));
}

// ── Status ─────────────────────────────────────────────────────────────────────

export interface GodotStatus {
  buildPresent: boolean;
  buildDir:     string;
}

export function getGodotStatus(): GodotStatus {
  return {
    buildPresent: isGodotBuildPresent(),
    buildDir:     GODOT_DIR,
  };
}
