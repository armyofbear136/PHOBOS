/**
 * OmniclipManager.ts — Lifecycle manager for the Omniclip video editor.
 *
 * Omniclip is a browser-native open-source NLE (MIT license). PHOBOS serves
 * its pre-built static output on a dedicated port and embeds it in a fullscreen
 * iframe. No fork. No build step. Pinned release fetched by fetch-omniclip.js.
 *
 * Port: 16345 (permanent wire contract)
 *   Previously reserved for the Neovim WebSocket bridge. Neovim was dropped
 *   in favour of Monaco. Port is now permanently assigned to Omniclip.
 *
 * Why a dedicated port instead of a Fastify static route:
 *   Omniclip uses SharedArrayBuffer for WebCodecs threading. The browser
 *   requires Cross-Origin-Opener-Policy: same-origin + Cross-Origin-Embedder-
 *   Policy: require-corp (COOP+COEP) for SharedArrayBuffer. These headers on
 *   the main Fastify server (port 3001) would break every cross-origin resource
 *   PHOBOS loads (Jellyfin proxy, image URLs, etc.). Port 16345 carries
 *   COOP+COEP exclusively — zero impact on port 3001.
 *
 * Why Node core http.Server instead of a subprocess:
 *   Static file serving is 40 lines of node:http. No subprocess lifecycle,
 *   no SIGTERM/SIGKILL dance, no port-wait loop. The server lives inside the
 *   PHOBOS process — stop() is server.close().
 *
 * Build directory: ~/.phobos/editors/omniclip/
 *   Populated by: node scripts/fetch-omniclip.js
 *   Contains: x/ (built JS), s/ (HTML entry), assets/, node_modules/ (ESM deps)
 */

import * as http from 'node:http';
import * as fs   from 'node:fs';
import * as path from 'node:path';
import * as os   from 'node:os';

// ── Wire constants ─────────────────────────────────────────────────────────────
export const OMNICLIP_PORT = 16345;

// ── Paths ──────────────────────────────────────────────────────────────────────

export function resolveBuildDir(): string {
  // esbuild outputs CJS — __dirname is always defined. Keep the cwd fallback for
  // tsx ESM dev runs where __dirname may be undefined.
  // x/ is the compiled web root (index.html, main.bundle.js, importmap.json, assets/).
  if (typeof __dirname !== 'undefined') {
    return path.resolve(__dirname, '../node_modules/@omnimedia/omniclip/x');
  }
  return path.resolve(process.cwd(), 'node_modules/@omnimedia/omniclip/x');
}

export function isBuildPresent(): boolean {
  return fs.existsSync(path.join(resolveBuildDir(), 'index.html'));
}

export function installedVersion(): string | null {
  try {
    // package.json lives at x/../package.json
    const pkg = JSON.parse(
      fs.readFileSync(path.join(resolveBuildDir(), '..', 'package.json'), 'utf8')
    );
    return pkg.version ?? null;
  } catch { return null; }
}

// ── Stubs for broken upstream dependencies ─────────────────────────────────────
// These paths are referenced in Omniclip's importmap but either don't exist
// in the installed npm package or have unresolvable transitive deps.
// Serving empty ESM stubs prevents main.js from throwing on import.
const MODULE_STUBS: Record<string, string> = {
  // posthog-js: stub the missing es.js path AND provide a no-op posthog object.
  // main.ts calls posthog.init(...) — the stub must expose init as a no-op or
  // the call throws TypeError and stalls the loading screen.
  '/node_modules/posthog-js/dist/es.js':
    'export const posthog = { init() {}, capture() {}, identify() {}, reset() {} }; export default posthog;',

  // coi-serviceworker.js — Omniclip ships this as a COOP/COEP shim for hosts
  // that can't set real headers. We set real headers on every response, so the
  // service worker is not needed. When it runs anyway it intercepts fetch events
  // and fails (TypeError: Failed to fetch / Failed to convert value to Response)
  // which blocks the initial page load. Return a no-op script so the browser
  // installs nothing and fetch events are never intercepted.
  '/coi-serviceworker.js':
    '// no-op: COOP/COEP headers are set by the static server.',

  // sparrow-rtc's x/ build imports @e280/stz and @e280/renraku which are
  // not in the importmap and not installed — stub sparrow-rtc entirely.
  '/node_modules/sparrow-rtc/x/index.js':
    'export default {};',
  '/node_modules/sparrow-rtc/x/tools/id.js':
    'export default {};',
  '/node_modules/sparrow-rtc/x/browser/std/cable.js':
    'export default {};',
  '/node_modules/sparrow-rtc/x/browser/utils/data-channeller.js':
    'export default {};',
  '/node_modules/sparrow-rtc/x/browser/connect.js':
    'export default {};',
  '/node_modules/sparrow-rtc/x/browser/join.js':
    'export default {};',
  '/node_modules/sparrow-rtc/x/browser/api.js':
    'export default {};',
  '/node_modules/sparrow-rtc/x/browser/utils/gather-ice.js':
    'export default {};',
  '/node_modules/sparrow-rtc/x/browser/utils/wait-for-connection.js':
    'export default {};',
};


// wasm must be application/wasm — browsers reject instantiation with octet-stream.

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

// ── COOP + COEP headers ────────────────────────────────────────────────────────
// Required on every response so SharedArrayBuffer is available inside the iframe.

const COI_HEADERS: Record<string, string> = {
  'Cross-Origin-Opener-Policy':   'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

// ── Static file handler ────────────────────────────────────────────────────────

function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  buildDir: string
): void {
  // Strip query string, decode URI
  const rawPath = (req.url ?? '/').split('?')[0];
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(rawPath);
  } catch {
    urlPath = rawPath;
  }

  // Serve stubs for broken upstream deps before hitting the filesystem.
  if (MODULE_STUBS[urlPath]) {
    const body = MODULE_STUBS[urlPath];
    // coi-serviceworker.js must never be cached — the browser may have a real
    // version installed from a previous run. no-store forces re-fetch every time
    // so the no-op stub is always what gets registered (or rather, doesn't).
    // Service worker scripts also require text/javascript specifically.
    const isSwFile     = urlPath === '/coi-serviceworker.js';
    const contentType  = isSwFile
      ? 'text/javascript; charset=utf-8'
      : 'application/javascript; charset=utf-8';
    const cacheControl = isSwFile ? 'no-store' : 'public, max-age=3600';
    res.writeHead(200, {
      ...COI_HEADERS,
      'Content-Type':   contentType,
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control':  cacheControl,
    });
    res.end(body);
    return;
  }

  // Omniclip's main.js uses bare absolute /node_modules/* imports.
  // buildDir is: <project>/node_modules/@omnimedia/omniclip/x
  // node_modules lives at: <project>/node_modules
  // So we need to go up 3 levels from x/ to reach the project root,
  // then back into node_modules/.
  const projectRoot  = path.resolve(buildDir, '../../../..');
  const isNodeModules = urlPath.startsWith('/node_modules/');
  const rootDir = isNodeModules ? projectRoot : buildDir;

  // Prevent path traversal
  const resolved = path.normalize(path.join(rootDir, urlPath));
  if (!resolved.startsWith(rootDir + path.sep) && resolved !== rootDir) {
    res.writeHead(403, { ...COI_HEADERS, 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // Directory → try index.html within that directory
  let filePath = resolved;
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  // SPA fallback — unknown non-module paths serve x/index.html
  if (!fs.existsSync(filePath)) {
    if (isNodeModules) {
      // A missing node_module is a real 404, not an SPA route
      res.writeHead(404, { ...COI_HEADERS, 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    filePath = path.join(buildDir, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { ...COI_HEADERS, 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  const stat        = fs.statSync(filePath);
  const contentType = mimeFor(filePath);

  res.writeHead(200, {
    ...COI_HEADERS,
    'Content-Type':   contentType,
    'Content-Length': stat.size,
    'Cache-Control':  filePath.endsWith('index.html')
      ? 'no-cache'
      : 'public, max-age=3600',
  });

  if (req.method === 'HEAD') { res.end(); return; }

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('error', () => {
    res.destroy();
  });
}

// ── Service state ──────────────────────────────────────────────────────────────

type OmniclipState = 'stopped' | 'starting' | 'running' | 'error';

interface ManagedServer {
  server: http.Server | null;
  state:  OmniclipState;
  error:  string | null;
}

const svc: ManagedServer = { server: null, state: 'stopped', error: null };

// ── Start ──────────────────────────────────────────────────────────────────────

export async function startOmniclip(): Promise<void> {
  if (svc.state === 'running')  return;
  if (svc.state === 'starting') return;

  if (!isBuildPresent()) {
    svc.state = 'error';
    svc.error = 'Omniclip build not found. Run: node scripts/fetch-omniclip.js';
    throw new Error(svc.error);
  }

  svc.state = 'starting';
  svc.error = null;

  const buildDir = resolveBuildDir();

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      serveStatic(req, res, buildDir);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      svc.state  = 'error';
      svc.error  = err.code === 'EADDRINUSE'
        ? `Port ${OMNICLIP_PORT} already in use`
        : err.message;
      svc.server = null;
      reject(new Error(svc.error));
    });

    server.listen(OMNICLIP_PORT, '127.0.0.1', () => {
      svc.server = server;
      svc.state  = 'running';
      svc.error  = null;
      console.log(`[OmniclipManager] ready on :${OMNICLIP_PORT} (${buildDir})`);
      resolve();
    });
  });
}

// ── Stop ───────────────────────────────────────────────────────────────────────

export async function stopOmniclip(): Promise<void> {
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

export interface OmniclipStatus {
  state:        OmniclipState;
  port:         number;
  error:        string | null;
  buildPresent: boolean;
  version:      string | null;
}

export function getOmniclipStatus(): OmniclipStatus {
  return {
    state:        svc.state,
    port:         OMNICLIP_PORT,
    error:        svc.error,
    buildPresent: isBuildPresent(),
    version:      installedVersion(),
  };
}