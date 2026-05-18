import { app, BrowserWindow, protocol, net } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

// ── Constants ─────────────────────────────────────────────────────────────────

const SCHEME   = 'phobos';
const DIST_DIR = path.join(__dirname, '..', 'dist');

// ENGINE_URL is injected at build time by electron-builder via extraMetadata,
// or falls back to the standard local port.
const ENGINE_URL = process.env.VITE_ENGINE_URL ?? 'http://localhost:3001';

// ── Custom protocol ───────────────────────────────────────────────────────────
// Registers phobos:// as a standard-scheme so the renderer is treated as a
// secure origin (required for Web Crypto, WebSockets, and fetch to localhost).
// All requests are resolved against dist/. Unknown paths fall back to
// dist/index.html so react-router's client-side routing works.

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard:        true,
      secure:          true,
      supportFetchAPI: true,
      corsEnabled:     true,
    },
  },
]);

function resolveAsset(requestPath: string): string {
  // Strip the scheme + host prefix:  phobos://index/assets/foo.js → /assets/foo.js
  const relative = requestPath.replace(/^phobos:\/\/[^/]*/, '') || '/';

  // Strip the /phobos/ base that Vite stamps on all asset URLs.
  const stripped = relative.startsWith('/phobos/')
    ? relative.slice('/phobos/'.length)
    : relative.replace(/^\//, '');

  const candidate = path.join(DIST_DIR, stripped);

  if (stripped && existsSync(candidate) && !candidate.endsWith('/')) {
    return candidate;
  }

  // SPA fallback — serve index.html for any unmatched path.
  return path.join(DIST_DIR, 'index.html');
}

function handleProtocol(request: GlobalRequest): Response {
  const filePath = resolveAsset(request.url);
  const ext      = path.extname(filePath).toLowerCase();

  const MIME: Record<string, string> = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.mjs':  'application/javascript',
    '.css':  'text/css',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.ttf':  'font/ttf',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
  };

  try {
    const body = readFileSync(filePath);
    return new Response(body, {
      status:  200,
      headers: { 'Content-Type': MIME[ext] ?? 'application/octet-stream' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow(): void {
  const win = new BrowserWindow({
    width:           1920,
    height:          1080,
    minWidth:        900,
    minHeight:       600,
    backgroundColor: '#0a0a0a',
    title:           'PHOBOS',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
  });

  win.loadURL(`${SCHEME}://index/`);
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  protocol.handle(SCHEME, handleProtocol);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Surface ENGINE_URL for preload — set before any window is created.
process.env.VITE_ENGINE_URL = ENGINE_URL;