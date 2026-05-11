/**
 * SculptGLManager.ts — Static file server for the SculptGL web editor.
 *
 * SculptGL does not require SharedArrayBuffer, so no COOP/COEP headers are
 * needed. It runs on a dedicated port (16348) inside the PHOBOS process so its
 * iframe src points directly to that origin — bypassing the Vite dev server
 * entirely. This avoids Vite's global COEP: require-corp header being stamped
 * onto the SculptGL HTML shell, which would block its asset loads.
 *
 * Port: 16348 (permanent wire contract)
 *
 * Pattern: BlockbenchManager.ts / OmniclipManager.ts. Identical static server.
 * Difference: no COOP/COEP on responses (SculptGL needs no cross-origin isolation).
 *
 * Build directory: ~/.phobos/editors/sculptgl/
 *   Populated by: node scripts/fetch-sculptgl.js
 *   Entry point:  index.html
 */

import * as http from 'node:http';
import * as fs   from 'node:fs';
import * as path from 'node:path';
import * as os   from 'node:os';

// ── Wire constants ─────────────────────────────────────────────────────────────

export const SCULPTGL_PORT = 16348;

// ── Paths ──────────────────────────────────────────────────────────────────────

export const SCULPTGL_DIR = path.join(os.homedir(), '.phobos', 'editors', 'sculptgl');

export function isSculptGLBuildPresent(): boolean {
  return fs.existsSync(path.join(SCULPTGL_DIR, 'index.html'));
}

// ── MIME types ─────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
};

function mimeFor(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

// ── Static file handler ────────────────────────────────────────────────────────

function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const rawPath = (req.url ?? '/').split('?')[0];
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(rawPath);
  } catch {
    urlPath = rawPath;
  }

  const resolved = path.normalize(path.join(SCULPTGL_DIR, urlPath));
  if (!resolved.startsWith(SCULPTGL_DIR + path.sep) && resolved !== SCULPTGL_DIR) {
    res.writeHead(403, { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  let filePath = resolved;
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(SCULPTGL_DIR, 'index.html');
  }

  // SPA fallback
  if (!fs.existsSync(filePath)) {
    filePath = path.join(SCULPTGL_DIR, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const stat        = fs.statSync(filePath);
  const contentType = mimeFor(filePath);

  res.writeHead(200, {
    'Cross-Origin-Opener-Policy':   'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Content-Type':   contentType,
    'Content-Length': stat.size,
    'Cache-Control':  filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
  });

  if (req.method === 'HEAD') { res.end(); return; }

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('error', () => { res.destroy(); });
}

// ── Service state ──────────────────────────────────────────────────────────────

type SculptGLState = 'stopped' | 'starting' | 'running' | 'error';

interface ManagedServer {
  server: http.Server | null;
  state:  SculptGLState;
  error:  string | null;
}

const svc: ManagedServer = { server: null, state: 'stopped', error: null };

// ── Start ──────────────────────────────────────────────────────────────────────

export async function startSculptGL(): Promise<void> {
  if (svc.state === 'running')  return;
  if (svc.state === 'starting') return;

  if (!isSculptGLBuildPresent()) {
    svc.state = 'error';
    svc.error = 'SculptGL build not found. Run: node scripts/fetch-sculptgl.js';
    throw new Error(svc.error);
  }

  svc.state = 'starting';
  svc.error = null;

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      serveStatic(req, res);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      svc.state  = 'error';
      svc.error  = err.code === 'EADDRINUSE'
        ? `Port ${SCULPTGL_PORT} already in use`
        : err.message;
      svc.server = null;
      reject(new Error(svc.error));
    });

    server.listen(SCULPTGL_PORT, '127.0.0.1', () => {
      svc.server = server;
      svc.state  = 'running';
      svc.error  = null;
      console.log(`[SculptGLManager] ready on :${SCULPTGL_PORT} (${SCULPTGL_DIR})`);
      resolve();
    });
  });
}

// ── Stop ───────────────────────────────────────────────────────────────────────

export async function stopSculptGL(): Promise<void> {
  if (svc.state === 'stopped' && !svc.server) return;

  await new Promise<void>((resolve) => {
    if (!svc.server) { resolve(); return; }
    svc.server.close(() => resolve());
    svc.server = null;
  });

  svc.state = 'stopped';
  svc.error = null;
}

// ── Status ─────────────────────────────────────────────────────────────────────

export interface SculptGLStatus {
  state:        SculptGLState;
  port:         number;
  error:        string | null;
  buildPresent: boolean;
  buildDir:     string;
}

export function getSculptGLStatus(): SculptGLStatus {
  return {
    state:        svc.state,
    port:         SCULPTGL_PORT,
    error:        svc.error,
    buildPresent: isSculptGLBuildPresent(),
    buildDir:     SCULPTGL_DIR,
  };
}