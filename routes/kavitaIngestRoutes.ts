// ── kavitaIngestRoutes.ts ─────────────────────────────────────────────────────
//
// POST /api/kavita/ingest/classify  — classify files (SSE progress stream)
// POST /api/kavita/ingest/commit    — copy confirmed queue items into libraries
// GET  /api/kavita/libraries        — list all Kavita libraries
// POST /api/kavita/libraries        — create a new library
// POST /api/kavita/libraries/:id/move — move library folder (with optional content copy)
// POST /api/kavita/scan             — trigger full library scan
// GET  /api/kavita/stats            — library statistics
// POST /api/kavita/open-folder      — open a folder in the OS file explorer

import type { FastifyInstance } from 'fastify';
import fs   from 'fs';
import os   from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  listLibraries,
  createLibrary,
  updateLibraryFolders,
  triggerScan,
  getStats,
  getKavitaJwt,
  defaultDocsPath,
  KAVITA_ADMIN_USER,
  KAVITA_LIB_TYPE,
  KAVITA_PORT,
  PHOBOSDOCS_LIB_NAME,
} from '../services/KavitaManager.js';
import { buildIngestQueue, copyToLibrary, type IngestQueueItem } from '../ai/KavitaIngestor.js';

const execFileAsync = promisify(execFile);

// ── Helpers ───────────────────────────────────────────────────────────────────

function kavitaRunning(): boolean {
  return getKavitaJwt() !== null;
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerKavitaIngestRoutes(fastify: FastifyInstance): Promise<void> {

  // ── POST /api/kavita/ingest/classify (SSE) ─────────────────────────────────
  // Body: { files: string[] }  — absolute paths on the PHOBOS host
  // Streams one progress event per file as SSE, then emits the full queue on done.
  fastify.post<{ Body: { files: string[] } }>(
    '/api/kavita/ingest/classify',
    async (req, reply) => {
      // Trim whitespace/CR from paths (PowerShell stdout can include trailing \r).
      const files = (req.body?.files ?? []).map((f: string) => f.trim()).filter(Boolean);
      if (!Array.isArray(files) || files.length === 0) {
        return reply.status(400).send({ error: 'files array is required' });
      }

      // Validate paths exist.
      const valid = files.filter((f: string) => typeof f === 'string' && fs.existsSync(f));
      if (valid.length === 0) {
        return reply.status(400).send({ error: `No valid file paths found. Received: ${files.slice(0, 3).join(', ')}` });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type':                'text/event-stream',
        'Cache-Control':               'no-cache',
        'Connection':                  'keep-alive',
        'Access-Control-Allow-Origin': req.headers.origin ?? '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });

      const send = (data: object) => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
        // Flush the socket immediately — without this, Node may buffer small
        // frames and the client won't receive them until the connection closes.
        if (typeof (reply.raw.socket as any)?.flush === 'function') {
          (reply.raw.socket as any).flush();
        }
      };

      try {
        const queue = await buildIngestQueue(valid, (item, index, total) => {
          send({
            type:    'classify_progress',
            index,
            total,
            pct:     Math.round(((index + 1) / total) * 100),
            item,
          });
        });

        send({ type: 'classify_done', queue });
      } catch (err) {
        send({ type: 'classify_error', error: (err as Error).message });
      } finally {
        reply.raw.end();
      }
    }
  );

  // ── POST /api/kavita/ingest/commit ─────────────────────────────────────────
  // Body: { items: Array<{ sourcePath, suggestion }>, libraryFolders: Record<KavitaLibType, string> }
  // Copies each file into the appropriate library folder, then triggers a scan.
  fastify.post<{
    Body: {
      items: Array<{ sourcePath: string; suggestion: string }>;
      libraryFolders: Record<string, string>;
    };
  }>('/api/kavita/ingest/commit', async (req, reply) => {
    if (!kavitaRunning()) {
      return reply.status(503).send({ error: 'Kavita is not running' });
    }

    const { items, libraryFolders } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      return reply.status(400).send({ error: 'items array is required' });
    }
    if (!libraryFolders || typeof libraryFolders !== 'object') {
      return reply.status(400).send({ error: 'libraryFolders map is required' });
    }

    const results: Array<{ source: string; dest: string; ok: boolean; error?: string }> = [];
    let needsScan = false;

    for (const item of items) {
      // phobosdocs falls back to defaultDocsPath() if the frontend didn't supply it.
      const folder = libraryFolders[item.suggestion]
        ?? (item.suggestion === 'phobosdocs' ? defaultDocsPath() : undefined);
      if (!folder) {
        results.push({ source: item.sourcePath, dest: '', ok: false, error: `No library folder mapped for type: ${item.suggestion}` });
        continue;
      }
      try {
        const queueItem: IngestQueueItem = {
          sourcePath:    item.sourcePath,
          filename:      path.basename(item.sourcePath),
          suggestion:    item.suggestion as import('../ai/KavitaIngestor.js').IngestQueueItem['suggestion'],
          reason:        '',
          llmClassified: false,
          sample:        '',
        };
        const dest = copyToLibrary(queueItem, folder);
        results.push({ source: item.sourcePath, dest, ok: true });
        if (item.suggestion !== 'phobosdocs') needsScan = true;
      } catch (err) {
        results.push({ source: item.sourcePath, dest: '', ok: false, error: (err as Error).message });
      }
    }

    // Only trigger Kavita scan if reader-native files were committed.
    if (needsScan) {
      try { await triggerScan(); } catch { /* non-fatal */ }
    }

    return reply.send({ ok: true, results });
  });

  // ── GET /api/kavita/libraries ──────────────────────────────────────────────
  fastify.get('/api/kavita/libraries', async (_req, reply) => {
    if (!kavitaRunning()) return reply.status(503).send({ error: 'Kavita is not running' });
    try {
      const libs = await listLibraries();
      return reply.send({ libraries: libs });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── POST /api/kavita/libraries ─────────────────────────────────────────────
  // Body: { name, type, folders }
  fastify.post<{ Body: { name: string; type: number; folders: string[] } }>(
    '/api/kavita/libraries',
    async (req, reply) => {
      if (!kavitaRunning()) return reply.status(503).send({ error: 'Kavita is not running' });
      const { name, type, folders } = req.body ?? {};
      if (!name || !type || !Array.isArray(folders) || folders.length === 0) {
        return reply.status(400).send({ error: 'name, type, and folders are required' });
      }
      try {
        const lib = await createLibrary(name, type, folders);
        return reply.send({ ok: true, library: lib });
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    }
  );

  // ── POST /api/kavita/libraries/:id/move ───────────────────────────────────
  // Body: { newFolder, moveContent?: boolean }
  // Moves the library's folder path. If moveContent=true, copies all files from
  // old folder to new folder then removes originals (same pattern as model move
  // in PhobosLLMPanel).
  fastify.post<{
    Params: { id: string };
    Body: { newFolder: string; moveContent?: boolean; name: string; type: number };
  }>('/api/kavita/libraries/:id/move', async (req, reply) => {
    if (!kavitaRunning()) return reply.status(503).send({ error: 'Kavita is not running' });

    const id           = parseInt(req.params.id, 10);
    const { newFolder, moveContent, name, type } = req.body ?? {};

    if (!newFolder || typeof newFolder !== 'string') {
      return reply.status(400).send({ error: 'newFolder is required' });
    }

    // Retrieve current library to get old folder.
    let oldFolder: string | null = null;
    try {
      const libs = await listLibraries();
      const lib  = libs.find(l => l.id === id);
      if (!lib) return reply.status(404).send({ error: 'Library not found' });
      oldFolder = lib.folders[0] ?? null;
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }

    // Create destination.
    fs.mkdirSync(newFolder, { recursive: true });

    // Content migration.
    if (moveContent && oldFolder && fs.existsSync(oldFolder)) {
      try {
        const entries = fs.readdirSync(oldFolder);
        for (const entry of entries) {
          const src  = path.join(oldFolder, entry);
          const dest = path.join(newFolder, entry);
          fs.copyFileSync(src, dest);
          fs.unlinkSync(src);
        }
        // Remove old folder only if now empty.
        try { fs.rmdirSync(oldFolder); } catch { /* not empty or already gone */ }
      } catch (err) {
        return reply.status(500).send({ error: `Content migration failed: ${(err as Error).message}` });
      }
    }

    // Update Kavita library record.
    try {
      await updateLibraryFolders(id, name, type, [newFolder]);
      await triggerScan();
      return reply.send({ ok: true, newFolder });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── POST /api/kavita/scan ──────────────────────────────────────────────────
  fastify.post('/api/kavita/scan', async (_req, reply) => {
    if (!kavitaRunning()) return reply.status(503).send({ error: 'Kavita is not running' });
    try {
      await triggerScan();
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── GET /api/kavita/stats ──────────────────────────────────────────────────
  fastify.get('/api/kavita/stats', async (_req, reply) => {
    if (!kavitaRunning()) return reply.status(503).send({ error: 'Kavita is not running' });
    try {
      const stats = await getStats();
      return reply.send({ totalSeries: stats.totalSeries, libraryCount: stats.libraryCount });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── POST /api/kavita/open-folder ───────────────────────────────────────────
  // Body: { folderPath }
  // Opens the folder in the OS native file explorer.
  fastify.post<{ Body: { folderPath: string } }>(
    '/api/kavita/open-folder',
    async (req, reply) => {
      const { folderPath } = req.body ?? {};
      if (!folderPath || typeof folderPath !== 'string') {
        return reply.status(400).send({ error: 'folderPath is required' });
      }

      if (!fs.existsSync(folderPath)) {
        return reply.status(404).send({ error: 'Folder does not exist' });
      }

      try {
        if (process.platform === 'win32') {
          await execFileAsync('explorer', [folderPath]);
        } else if (process.platform === 'darwin') {
          await execFileAsync('open', [folderPath]);
        } else {
          // Linux — try xdg-open; non-fatal if no desktop environment.
          execFile('xdg-open', [folderPath], () => {});
        }
        return reply.send({ ok: true });
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    }
  );

  // ── GET /api/kavita/lib-types ──────────────────────────────────────────────
  // Returns the library type constants for the UI.
  fastify.get('/api/kavita/lib-types', async (_req, reply) => {
    return reply.send({ types: KAVITA_LIB_TYPE, phobosdocsName: PHOBOSDOCS_LIB_NAME });
  });

  // ── POST /api/kavita/series/list ───────────────────────────────────────────
  // Proxy to Kavita's series list endpoint. Body: { libraryId, pageSize, pageNumber }
  fastify.post<{ Body: { libraryId?: number; pageSize?: number; pageNumber?: number } }>(
    '/api/kavita/series/list',
    async (req, reply) => {
      if (!kavitaRunning()) return reply.status(503).send({ error: 'Kavita not running' });
      const { libraryId, pageSize = 100, pageNumber = 1 } = req.body ?? {};
      try {
        const jwt = getKavitaJwt()!;
        const params = new URLSearchParams({
          pageSize:   String(pageSize),
          pageNumber: String(pageNumber),
        });
        if (libraryId != null) params.set('libraryId', String(libraryId));
        const body: Record<string, unknown> = { pageSize, pageNumber };
        if (libraryId != null) body.libraryId = libraryId;
        const r = await fetch(
          `http://127.0.0.1:${KAVITA_PORT}/api/series/all`,
          {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        if (!r.ok) return reply.status(r.status).send({ error: `Kavita: ${r.status}` });
        // GET /api/series/all returns the series array directly (no wrapper)
        const data = await r.json();
        return reply.send({ result: Array.isArray(data) ? data : [] });
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── GET /api/kavita/in-progress ────────────────────────────────────────────
  // Returns series with reading progress for the In Progress drawer tab.
  fastify.get('/api/kavita/in-progress', async (_req, reply) => {
    if (!kavitaRunning()) return reply.status(503).send([]);
    try {
      const jwt = getKavitaJwt()!;
      // Kavita: GET /api/series/on-deck?pageSize=25&pageNumber=1
      const r = await fetch(
        `http://127.0.0.1:${KAVITA_PORT}/api/series/on-deck?pageSize=25&pageNumber=1`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageSize: 25, pageNumber: 1 }),
        },
      );
      if (!r.ok || r.status === 204) return reply.send([]);
      const data = await r.json() as Array<{
        id: number; name: string; libraryId: number;
        pages: number; pagesRead?: number; latestChapter?: { id: number };
      }>;
      const mapped = (Array.isArray(data) ? data : []).map(s => ({
        seriesId:   s.id,
        seriesName: s.name,
        libraryId:  s.libraryId,
        pages:      s.pages ?? 0,
        pagesRead:  s.pagesRead ?? 0,
        chapterId:  s.latestChapter?.id ?? null,
      }));
      return reply.send(mapped);
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── GET /api/kavita/token ────────────────────────────────────────────────────
  fastify.get('/api/kavita/token', async (_req, reply) => {
    if (!kavitaRunning()) return reply.status(503).send({ error: 'Kavita not running' });
    const token = getKavitaJwt();
    if (!token) return reply.status(503).send({ error: 'No JWT available' });
    return reply.send({ token, username: 'phobos' });
  });

  // ── GET /api/kavita/browse ───────────────────────────────────────────────────
  // Lists files and subdirectories at a given absolute path within a known
  // Kavita library folder. Validates the path is inside a registered library.
  fastify.get<{ Querystring: { dir: string } }>('/api/kavita/browse', async (req, reply) => {
    if (!kavitaRunning()) return reply.status(503).send({ error: 'Kavita not running' });
    const dir = req.query.dir;
    if (!dir) return reply.status(400).send({ error: 'dir required' });

    // Security: path must be inside a known library folder
    const libs = await listLibraries();
    const allowed = libs.flatMap(l => l.folders);
    const normalized = path.resolve(dir);
    const safe = allowed.some(f => normalized.startsWith(path.resolve(f)));
    if (!safe) return reply.status(403).send({ error: 'Path outside library' });

    try {
      const entries = fs.readdirSync(normalized, { withFileTypes: true });
      const result = entries.map(e => ({
        name:  e.name,
        isDir: e.isDirectory(),
        path:  path.join(normalized, e.name),
        ext:   e.isFile() ? path.extname(e.name).toLowerCase() : '',
      }));
      return reply.send(result);
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── POST /api/kavita/ingest/scan-folder ────────────────────────────────────
  // Body: { folderPath: string }
  // Recursively walks folderPath and returns all Kavita-compatible files found.
  // Used by the ingest UI after the user picks a folder via the OS folder dialog.
  fastify.post<{ Body: { folderPath: string } }>(
    '/api/kavita/ingest/scan-folder',
    async (req, reply) => {
      const { folderPath } = req.body ?? {};
      if (!folderPath || typeof folderPath !== 'string') {
        return reply.status(400).send({ error: 'folderPath is required' });
      }

      const normalized = path.resolve(folderPath);
      if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) {
        return reply.status(400).send({ error: 'Path does not exist or is not a directory' });
      }

      // All files are accepted — the ingestor classifier determines the destination.
      // Kavita-native formats go to a library; everything else lands in phobosDocs.
      const found: string[] = [];
      const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile()) {
            found.push(full);
          }
        }
      };

      walk(normalized);
      return reply.send({ files: found });
    }
  );

  // ── POST /api/kavita/ingest/open-file-dialog ────────────────────────────────
  // Opens a native OS file picker (any file type) for ingest.
  // Returns { path: string | null }.
  fastify.post('/api/kavita/ingest/open-file-dialog', async (_req, reply) => {
    const execFileAsync = promisify(execFile);
    let selectedPath = '';
    try {
      if (process.platform === 'win32') {
        const tmpPs1 = path.join(os.tmpdir(), `phobos-ingest-file-${Date.now()}.ps1`);
        const ps1 = [
          'Add-Type -AssemblyName System.Windows.Forms',
          '[System.Windows.Forms.Application]::EnableVisualStyles()',
          '$f = New-Object System.Windows.Forms.Form',
          '$f.TopMost = $true; $f.ShowInTaskbar = $false',
          '$f.WindowState = [System.Windows.Forms.FormWindowState]::Minimized',
          '$f.Show(); $f.Hide()',
          '$d = New-Object System.Windows.Forms.OpenFileDialog',
          '$d.Filter = "All files (*.*)|*.*"',
          '$d.Title = "Select file to ingest"',
          '$d.Multiselect = $false',
          'if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }',
          '$f.Dispose()',
        ].join('\r\n');
        try {
          fs.writeFileSync(tmpPs1, ps1, 'utf-8');
          const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1]);
          selectedPath = stdout.trim();
        } finally { try { fs.unlinkSync(tmpPs1); } catch { /* ignore */ } }
      } else if (process.platform === 'darwin') {
        const { stdout } = await execFileAsync('osascript', ['-e', 'POSIX path of (choose file with prompt "Select file to ingest")']);
        selectedPath = stdout.trim();
      } else {
        const tryExec = async (cmd: string, args: string[]) => { try { const { stdout } = await execFileAsync(cmd, args); return stdout.trim() || null; } catch { return null; } };
        selectedPath = await tryExec('zenity', ['--file-selection', '--title=Select file to ingest']) ?? await tryExec('kdialog', ['--getopenfilename', os.homedir(), '*']) ?? '';
      }
    } catch { /* user cancelled */ }
    return reply.send({ path: selectedPath || null });
  });

  // ── POST /api/kavita/ingest/open-folder-dialog ──────────────────────────────
  // Opens a native OS folder picker for ingest.
  // Returns { path: string | null }.
  fastify.post('/api/kavita/ingest/open-folder-dialog', async (_req, reply) => {
    const execFileAsync = promisify(execFile);
    let selectedPath = '';
    try {
      if (process.platform === 'win32') {
        const tmpPs1 = path.join(os.tmpdir(), `phobos-ingest-folder-${Date.now()}.ps1`);
        const ps1 = [
          'Add-Type -AssemblyName System.Windows.Forms',
          '[System.Windows.Forms.Application]::EnableVisualStyles()',
          '$f = New-Object System.Windows.Forms.Form',
          '$f.TopMost = $true; $f.ShowInTaskbar = $false',
          '$f.WindowState = [System.Windows.Forms.FormWindowState]::Minimized',
          '$f.Show(); $f.Hide()',
          '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
          '$d.Description = "Select folder to ingest"',
          '$d.UseDescriptionForTitle = $true',
          'if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }',
          '$f.Dispose()',
        ].join('\r\n');
        try {
          fs.writeFileSync(tmpPs1, ps1, 'utf-8');
          const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1]);
          selectedPath = stdout.trim();
        } finally { try { fs.unlinkSync(tmpPs1); } catch { /* ignore */ } }
      } else if (process.platform === 'darwin') {
        const { stdout } = await execFileAsync('osascript', ['-e', 'POSIX path of (choose folder with prompt "Select folder to ingest")']);
        selectedPath = stdout.trim().replace(/\/$/, '');
      } else {
        const tryExec = async (cmd: string, args: string[]) => { try { const { stdout } = await execFileAsync(cmd, args); return stdout.trim() || null; } catch { return null; } };
        selectedPath = await tryExec('zenity', ['--file-selection', '--directory', '--title=Select folder to ingest']) ?? await tryExec('kdialog', ['--getexistingdirectory', os.homedir()]) ?? '';
      }
    } catch { /* user cancelled */ }
    return reply.send({ path: selectedPath || null });
  });

  // ── GET /api/kavita/file-content ────────────────────────────────────────────
  // Validates path is inside a registered library folder.
  // Text files  → { content: string,        filename, ext, binary: false }
  // Binary docs → { content: base64 string, filename, ext, binary: true  }
  fastify.get<{ Querystring: { path: string } }>('/api/kavita/file-content', async (req, reply) => {
    if (!kavitaRunning()) return reply.status(503).send({ error: 'Kavita not running' });
    const filePath = req.query.path;
    if (!filePath) return reply.status(400).send({ error: 'path required' });

    const libs = await listLibraries();
    const allowed = libs.flatMap(l => l.folders);
    const normalized = path.resolve(filePath);
    const safe = allowed.some(f => normalized.startsWith(path.resolve(f)));
    if (!safe) return reply.status(403).send({ error: 'Path outside library' });

    const ext = path.extname(normalized).toLowerCase();
    const TEXT_EXTS   = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv', '.html', '.htm', '.xml', '.ts', '.js', '.py']);
    const BINARY_EXTS = new Set(['.docx', '.doc', '.rtf', '.odt']);

    if (!TEXT_EXTS.has(ext) && !BINARY_EXTS.has(ext)) {
      return reply.status(415).send({ error: 'Unsupported file type' });
    }

    try {
      if (BINARY_EXTS.has(ext)) {
        const buf = fs.readFileSync(normalized);
        return reply.send({
          content:  buf.toString('base64'),
          filename: path.basename(normalized),
          ext,
          binary:   true,
        });
      }
      const content = fs.readFileSync(normalized, 'utf8');
      return reply.send({ content, filename: path.basename(normalized), ext, binary: false });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });


}
