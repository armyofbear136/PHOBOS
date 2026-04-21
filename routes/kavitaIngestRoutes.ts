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
  KAVITA_LIB_TYPE,
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
      const { files } = req.body ?? {};
      if (!Array.isArray(files) || files.length === 0) {
        return reply.status(400).send({ error: 'files array is required' });
      }

      // Validate paths exist.
      const valid = files.filter(f => typeof f === 'string' && fs.existsSync(f));
      if (valid.length === 0) {
        return reply.status(400).send({ error: 'No valid file paths found' });
      }

      reply.raw.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
      });

      const send = (data: object) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);

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

    for (const item of items) {
      const folder = libraryFolders[item.suggestion];
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
      } catch (err) {
        results.push({ source: item.sourcePath, dest: '', ok: false, error: (err as Error).message });
      }
    }

    // Trigger Kavita scan so new files appear immediately.
    try { await triggerScan(); } catch { /* non-fatal */ }

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
}
