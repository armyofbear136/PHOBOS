/**
 * BlockbenchManager.ts — Static file server for the Blockbench web editor.
 *
 * Blockbench does not require SharedArrayBuffer, so no COOP/COEP headers are
 * needed. It runs on a dedicated port (16347) inside the PHOBOS process so its
 * iframe src points directly to that origin — bypassing the Vite dev server
 * entirely. This avoids Vite's global COEP: require-corp header being stamped
 * onto the Blockbench HTML shell, which would block its asset loads.
 *
 * Port: 16347 (permanent wire contract)
 *
 * Pattern: OmniclipManager.ts. Identical static server implementation.
 * Difference: no COOP/COEP on responses (Blockbench needs no cross-origin isolation).
 *
 * Build directory: ~/.phobos/editors/blockbench/
 *   Populated by: node scripts/fetch-blockbench.js
 *   Entry point:  index.html
 */

import * as http from 'node:http';
import * as fs   from 'node:fs';
import * as path from 'node:path';
import * as os   from 'node:os';

// ── Wire constants ─────────────────────────────────────────────────────────────

export const BLOCKBENCH_PORT = 16347;

// ── Paths ──────────────────────────────────────────────────────────────────────

export const BLOCKBENCH_DIR = path.join(os.homedir(), '.phobos', 'editors', 'blockbench');

export function isBuildPresent(): boolean {
  return fs.existsSync(path.join(BLOCKBENCH_DIR, 'index.html'));
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

  const resolved = path.normalize(path.join(BLOCKBENCH_DIR, urlPath));
  if (!resolved.startsWith(BLOCKBENCH_DIR + path.sep) && resolved !== BLOCKBENCH_DIR) {
    res.writeHead(403, { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  let filePath = resolved;
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(BLOCKBENCH_DIR, 'index.html');
  }

  // SPA fallback
  if (!fs.existsSync(filePath)) {
    filePath = path.join(BLOCKBENCH_DIR, 'index.html');
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

type BlockbenchState = 'stopped' | 'starting' | 'running' | 'error';

interface ManagedServer {
  server: http.Server | null;
  state:  BlockbenchState;
  error:  string | null;
}

const svc: ManagedServer = { server: null, state: 'stopped', error: null };

// ── Start ──────────────────────────────────────────────────────────────────────

export async function startBlockbench(): Promise<void> {
  if (svc.state === 'running')  return;
  if (svc.state === 'starting') return;

  if (!isBuildPresent()) {
    svc.state = 'error';
    svc.error = 'Blockbench build not found. Run: node scripts/fetch-blockbench.js';
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
        ? `Port ${BLOCKBENCH_PORT} already in use`
        : err.message;
      svc.server = null;
      reject(new Error(svc.error));
    });

    server.listen(BLOCKBENCH_PORT, '127.0.0.1', () => {
      svc.server = server;
      svc.state  = 'running';
      svc.error  = null;
      console.log(`[BlockbenchManager] ready on :${BLOCKBENCH_PORT} (${BLOCKBENCH_DIR})`);
      resolve();
    });
  });
}

// ── Stop ───────────────────────────────────────────────────────────────────────

export async function stopBlockbench(): Promise<void> {
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

export interface BlockbenchStatus {
  state:        BlockbenchState;
  port:         number;
  error:        string | null;
  buildPresent: boolean;
  buildDir:     string;
}

export function getBlockbenchStatus(): BlockbenchStatus {
  return {
    state:        svc.state,
    port:         BLOCKBENCH_PORT,
    error:        svc.error,
    buildPresent: isBuildPresent(),
    buildDir:     BLOCKBENCH_DIR,
  };
}