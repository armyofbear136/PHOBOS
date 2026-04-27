// ── jellyfinIngestRoutes.ts ───────────────────────────────────────────────────
//
// GET  /api/jellyfin/libraries               — list all Jellyfin virtual folders
// POST /api/jellyfin/libraries               — create a new virtual folder
// POST /api/jellyfin/libraries/:name/move    — relocate a library's folder path
// POST /api/jellyfin/scan                    — trigger full library scan
// GET  /api/jellyfin/stats                   — movie/series/episode counts
// POST /api/jellyfin/open-folder             — open folder in OS file explorer
// POST /api/jellyfin/ingest/open-file-dialog — native OS file picker
// POST /api/jellyfin/ingest/open-folder-dialog — native OS folder picker
// POST /api/jellyfin/ingest/scan-folder      — recursive walk, return all files
// POST /api/jellyfin/ingest/classify (SSE)   — classify files with progress stream
// POST /api/jellyfin/ingest/commit           — copy files into library folders

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs   from 'fs';
import os   from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  listLibraries,
  addLibrary,
  triggerScan,
  getStats,
  getJellyfinStatus,
  defaultMediaPath,
  resolveFFmpegPath,
  jellyfinApiRequest,
} from '../services/JellyfinManager.js';
import { ServiceStore } from '../db/ServiceStore.js';
import { buildIngestQueue, copyToLibrary, type JellyfinIngestItem } from '../ai/JellyfinIngestor.js';
import { DatabaseManager } from '../db/DatabaseManager.js';

const execFileAsync = promisify(execFile);

// ── Helpers ───────────────────────────────────────────────────────────────────

function jellyfinRunning(): boolean {
  return getJellyfinStatus().state === 'running';
}

/** ffprobe lives alongside ffmpeg in the same directory. */
function resolveFfprobePath(): string | null {
  const ffmpeg = resolveFFmpegPath();
  if (!ffmpeg) return null;
  const exe   = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  const probe = path.join(path.dirname(ffmpeg), exe);
  return fs.existsSync(probe) ? probe : null;
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerJellyfinIngestRoutes(fastify: FastifyInstance): Promise<void> {

  // ── GET /api/jellyfin/libraries ─────────────────────────────────────────────
  fastify.get('/api/jellyfin/libraries', async (_req, reply) => {
    if (!jellyfinRunning()) return reply.status(503).send({ error: 'Jellyfin is not running' });
    try {
      const libs = await listLibraries();
      return reply.send({ libraries: libs });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── POST /api/jellyfin/libraries ────────────────────────────────────────────
  // Body: { name, folderPath, collectionType }
  // collectionType: 'movies' | 'tvshows' | 'music' | 'homevideos' | 'mixed'
  fastify.post<{ Body: { name: string; folderPath: string; collectionType: string } }>(
    '/api/jellyfin/libraries',
    async (req, reply) => {
      if (!jellyfinRunning()) return reply.status(503).send({ error: 'Jellyfin is not running' });
      const { name, folderPath, collectionType } = req.body ?? {};
      if (!name || !folderPath || !collectionType) {
        return reply.status(400).send({ error: 'name, folderPath, and collectionType are required' });
      }
      try {
        fs.mkdirSync(folderPath, { recursive: true });
        await addLibrary(name, folderPath, collectionType);
        // Re-fetch libraries so the response includes the new entry.
        const libs = await listLibraries();
        return reply.send({ ok: true, libraries: libs });
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    }
  );

  // ── POST /api/jellyfin/libraries/:name/move ─────────────────────────────────
  // Body: { newFolder, moveContent?: boolean }
  // Jellyfin has no "update folder" API — remove old VirtualFolder, add new one.
  // If moveContent=true, copies all files from old folder to new before swapping.
  fastify.post<{
    Params: { name: string };
    Body: { newFolder: string; collectionType: string; moveContent?: boolean };
  }>('/api/jellyfin/libraries/:name/move', async (req, reply) => {
    if (!jellyfinRunning()) return reply.status(503).send({ error: 'Jellyfin is not running' });

    const libName    = decodeURIComponent(req.params.name);
    const { newFolder, collectionType, moveContent } = req.body ?? {};
    if (!newFolder || !collectionType) {
      return reply.status(400).send({ error: 'newFolder and collectionType are required' });
    }

    // Find current library to get old folder.
    let oldFolder: string | null = null;
    try {
      const libs = await listLibraries();
      const lib  = libs.find(l => l.Name === libName);
      if (!lib) return reply.status(404).send({ error: `Library "${libName}" not found` });
      oldFolder = lib.Locations[0] ?? null;
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }

    // Protect the default Phobos library from being moved via this route.
    if (oldFolder && path.resolve(oldFolder) === path.resolve(defaultMediaPath())) {
      return reply.status(400).send({ error: 'The default Phobos library cannot be moved here — change it in the path field instead.' });
    }

    fs.mkdirSync(newFolder, { recursive: true });

    // Content migration.
    if (moveContent && oldFolder && fs.existsSync(oldFolder)) {
      try {
        const walk = (dir: string) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            const src  = path.join(dir, e.name);
            const rel  = path.relative(oldFolder!, src);
            const dest = path.join(newFolder, rel);
            if (e.isDirectory()) {
              fs.mkdirSync(dest, { recursive: true });
              walk(src);
            } else {
              fs.copyFileSync(src, dest);
              fs.unlinkSync(src);
            }
          }
        };
        walk(oldFolder);
        try { fs.rmdirSync(oldFolder, { recursive: true }); } catch { /* non-fatal */ }
      } catch (err) {
        return reply.status(500).send({ error: `Content migration failed: ${(err as Error).message}` });
      }
    }

    // Jellyfin: remove old virtual folder, add new one at new path.
    // DELETE /Library/VirtualFolders?name={name}
    // POST   /Library/VirtualFolders?name={name}&collectionType={type}
    try {
      const { jellyfinApiRequest } = await import('../services/JellyfinManager.js');
      const delRes = await jellyfinApiRequest(
        'DELETE',
        `/Library/VirtualFolders?name=${encodeURIComponent(libName)}`,
      );
      if (!delRes.ok && delRes.status !== 204 && delRes.status !== 404) {
        throw new Error(`Failed to remove old library: HTTP ${delRes.status}`);
      }
      await addLibrary(libName, newFolder, collectionType);
      await triggerScan();
      return reply.send({ ok: true, newFolder });
    } catch (err) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── POST /api/jellyfin/scan ─────────────────────────────────────────────────
  fastify.post('/api/jellyfin/scan', async (_req, reply) => {
    if (!jellyfinRunning()) return reply.status(503).send({ error: 'Jellyfin is not running' });
    try {
      await triggerScan();
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(503).send({ error: (err as Error).message });
    }
  });

  // ── GET /api/jellyfin/stats ─────────────────────────────────────────────────
  fastify.get('/api/jellyfin/stats', async (_req, reply) => {
    if (!jellyfinRunning()) return reply.status(503).send({ error: 'Jellyfin is not running' });
    try {
      const stats = await getStats();
      return reply.send(stats);
    } catch (err) {
      return reply.status(503).send({ error: (err as Error).message });
    }
  });

  // ── POST /api/jellyfin/open-folder ──────────────────────────────────────────
  fastify.post<{ Body: { folderPath: string } }>(
    '/api/jellyfin/open-folder',
    async (req, reply) => {
      const { folderPath } = req.body ?? {};
      if (!folderPath) return reply.status(400).send({ error: 'folderPath is required' });
      if (!fs.existsSync(folderPath)) return reply.status(404).send({ error: 'Folder does not exist' });
      try {
        if (process.platform === 'win32') {
          await execFileAsync('explorer', [folderPath]);
        } else if (process.platform === 'darwin') {
          await execFileAsync('open', [folderPath]);
        } else {
          execFile('xdg-open', [folderPath], () => {});
        }
        return reply.send({ ok: true });
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    }
  );

  // ── POST /api/jellyfin/ingest/open-file-dialog ──────────────────────────────
  fastify.post('/api/jellyfin/ingest/open-file-dialog', async (_req, reply) => {
    let selectedPath = '';
    try {
      if (process.platform === 'win32') {
        const tmpPs1 = path.join(os.tmpdir(), `phobos-jf-file-${Date.now()}.ps1`);
        const ps1 = [
          'Add-Type -AssemblyName System.Windows.Forms',
          '[System.Windows.Forms.Application]::EnableVisualStyles()',
          '$f = New-Object System.Windows.Forms.Form',
          '$f.TopMost = $true; $f.ShowInTaskbar = $false',
          '$f.WindowState = [System.Windows.Forms.FormWindowState]::Minimized',
          '$f.Show(); $f.Hide()',
          '$d = New-Object System.Windows.Forms.OpenFileDialog',
          '$d.Filter = "Video files (*.mkv;*.mp4;*.avi;*.m4v;*.mov;*.wmv;*.ts)|*.mkv;*.mp4;*.avi;*.m4v;*.mov;*.wmv;*.ts|All files (*.*)|*.*"',
          '$d.Title = "Select video file to ingest"',
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
        const { stdout } = await execFileAsync('osascript', ['-e', 'POSIX path of (choose file with prompt "Select video file to ingest")']);
        selectedPath = stdout.trim();
      } else {
        const tryExec = async (cmd: string, args: string[]) => {
          try { const { stdout } = await execFileAsync(cmd, args); return stdout.trim() || null; } catch { return null; }
        };
        selectedPath = await tryExec('zenity', ['--file-selection', '--title=Select video file to ingest'])
          ?? await tryExec('kdialog', ['--getopenfilename', os.homedir(), '*.mkv *.mp4 *.avi *.m4v *.mov *.wmv'])
          ?? '';
      }
    } catch { /* user cancelled */ }
    return reply.send({ path: selectedPath || null });
  });

  // ── POST /api/jellyfin/ingest/open-folder-dialog ────────────────────────────
  fastify.post('/api/jellyfin/ingest/open-folder-dialog', async (_req, reply) => {
    let selectedPath = '';
    try {
      if (process.platform === 'win32') {
        const tmpPs1 = path.join(os.tmpdir(), `phobos-jf-folder-${Date.now()}.ps1`);
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
        const tryExec = async (cmd: string, args: string[]) => {
          try { const { stdout } = await execFileAsync(cmd, args); return stdout.trim() || null; } catch { return null; }
        };
        selectedPath = await tryExec('zenity', ['--file-selection', '--directory', '--title=Select folder to ingest'])
          ?? await tryExec('kdialog', ['--getexistingdirectory', os.homedir()])
          ?? '';
      }
    } catch { /* user cancelled */ }
    return reply.send({ path: selectedPath || null });
  });

  // ── POST /api/jellyfin/ingest/scan-folder ───────────────────────────────────
  // Body: { folderPath: string }
  // Recursively walks folderPath, returns all files (any extension — classifier decides).
  fastify.post<{ Body: { folderPath: string } }>(
    '/api/jellyfin/ingest/scan-folder',
    async (req, reply) => {
      const { folderPath } = req.body ?? {};
      if (!folderPath) return reply.status(400).send({ error: 'folderPath is required' });

      const normalized = path.resolve(folderPath);
      if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) {
        return reply.status(400).send({ error: 'Path does not exist or is not a directory' });
      }

      const found: string[] = [];
      const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile()) found.push(full);
        }
      };
      walk(normalized);
      return reply.send({ files: found });
    }
  );

  // ── POST /api/jellyfin/ingest/classify (SSE) ────────────────────────────────
  // Body: { files: string[] }
  // Streams one progress event per file, then emits the full queue on done.
  fastify.post<{ Body: { files: string[] } }>(
    '/api/jellyfin/ingest/classify',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const files = ((req.body as any)?.files ?? [])
        .map((f: string) => f.trim())
        .filter(Boolean) as string[];

      if (files.length === 0) {
        return reply.status(400).send({ error: 'files array is required' });
      }

      const valid = files.filter(f => typeof f === 'string' && fs.existsSync(f));
      if (valid.length === 0) {
        return reply.status(400).send({
          error: `No valid file paths found. Received: ${files.slice(0, 3).join(', ')}`,
        });
      }

      const ffprobePath = resolveFfprobePath();

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type':                 'text/event-stream',
        'Cache-Control':                'no-cache',
        'Connection':                   'keep-alive',
        'Access-Control-Allow-Origin':  req.headers.origin ?? '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });

      const send = (data: object) => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
        if (typeof (reply.raw.socket as any)?.flush === 'function') {
          (reply.raw.socket as any).flush();
        }
      };

      try {
        const queue = await buildIngestQueue(valid, ffprobePath, (item, index, total) => {
          send({
            type:  'classify_progress',
            index,
            total,
            pct:   Math.round(((index + 1) / total) * 100),
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

  // ── POST /api/jellyfin/ingest/commit ────────────────────────────────────────
  // Body: {
  //   items: Array<{ sourcePath, suggestion, seriesName, seasonNumber }>,
  //   libraryFolders: { movies: string, tvshows: string, phobos: string }
  // }
  fastify.post<{
    Body: {
      items: Array<{
        sourcePath:   string;
        suggestion:   string;
        seriesName:   string;
        seasonNumber: number;
        filename:     string;
      }>;
      libraryFolders: Record<string, string>;
    };
  }>('/api/jellyfin/ingest/commit', async (req, reply) => {
    if (!jellyfinRunning()) {
      return reply.status(503).send({ error: 'Jellyfin is not running' });
    }

    const { items, libraryFolders } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      return reply.status(400).send({ error: 'items array is required' });
    }
    if (!libraryFolders || typeof libraryFolders !== 'object') {
      return reply.status(400).send({ error: 'libraryFolders map is required' });
    }

    const results: Array<{ source: string; dest: string; ok: boolean; error?: string }> = [];
    let   needsScan = false;

    for (const item of items) {
      const folder = libraryFolders[item.suggestion]
        ?? (item.suggestion === 'phobos' ? defaultMediaPath() : undefined);

      if (!folder) {
        results.push({ source: item.sourcePath, dest: '', ok: false,
          error: `No library folder mapped for type: ${item.suggestion}` });
        continue;
      }

      try {
        const queueItem: JellyfinIngestItem = {
          sourcePath:    item.sourcePath,
          filename:      item.filename ?? path.basename(item.sourcePath),
          suggestion:    item.suggestion as JellyfinIngestItem['suggestion'],
          seriesName:    item.seriesName ?? '',
          seasonNumber:  item.seasonNumber ?? 0,
          reason:        '',
          llmClassified: false,
        };
        const dest = copyToLibrary(queueItem, folder);
        results.push({ source: item.sourcePath, dest, ok: true });
        if (item.suggestion !== 'phobos') needsScan = true;
      } catch (err) {
        results.push({ source: item.sourcePath, dest: '', ok: false,
          error: (err as Error).message });
      }
    }

    if (needsScan) {
      try { await triggerScan(); } catch { /* non-fatal */ }
    }

    return reply.send({ ok: true, results });
  });

  // ── POST /api/jellyfin/library/move-default ───────────────────────────────
  // Relocates the phobosVideos default library folder. Updates the DB record,
  // recreates the Jellyfin virtual folder at the new path.
  fastify.post<{ Body: { newPath: string; moveContent: boolean } }>(
    '/api/jellyfin/library/move-default',
    async (req, reply) => {
      const { newPath, moveContent } = req.body;
      if (!newPath?.trim()) return reply.status(400).send({ error: 'newPath is required' });

      const db    = DatabaseManager.getInstance();
      const store = new ServiceStore(db);
      const record = await store.get('jellyfin');
      const oldPath = record.libraryPath;

      // Create new directory
      fs.mkdirSync(newPath, { recursive: true });

      // Optionally move content
      if (moveContent && oldPath && fs.existsSync(oldPath)) {
        const entries = fs.readdirSync(oldPath, { withFileTypes: true });
        for (const entry of entries) {
          const src  = path.join(oldPath, entry.name);
          const dest = path.join(newPath, entry.name);
          if (entry.isDirectory()) {
            fs.mkdirSync(dest, { recursive: true });
          } else {
            fs.copyFileSync(src, dest);
            fs.unlinkSync(src);
          }
        }
      }

      // Remove old virtual folder from Jellyfin and add new one
      try {
        if (oldPath) {
          await jellyfinApiRequest('DELETE', `/Library/VirtualFolders?name=${encodeURIComponent('phobosVideos')}&deleteFolder=false`);
        }
      } catch { /* non-fatal — may not exist yet */ }

      await jellyfinApiRequest(
        'POST',
        `/Library/VirtualFolders?name=phobosVideos&collectionType=homevideos`,
        { LibraryOptions: { PathInfos: [{ Path: newPath }], EnableRealtimeMonitor: true } },
      );

      // Persist new path to DB
      await store.setLibraryPath('jellyfin', newPath);

      return reply.send({ ok: true });
    },
  );
}
