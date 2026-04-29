// ── meridianIngestRoutes.ts ───────────────────────────────────────────────────
//
// POST /api/meridian/library/move       — relocate phobosPictures folder with optional content copy
// POST /api/meridian/ingest/scan-folder — recursive walk, return all files
// POST /api/meridian/ingest/commit      — copy files into phobosPictures

import type { FastifyInstance } from 'fastify';
import fs   from 'fs';
import path from 'path';
import {
  getMeridianStatus,
  startMeridian,
  stopMeridian,
  meridianApiRequest,
} from '../services/MeridianManager.js';
import { ServiceStore } from '../db/ServiceStore.js';
import { DatabaseManager } from '../db/DatabaseManager.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function meridianRunning(): boolean {
  return getMeridianStatus().state === 'running';
}

/** Recursively walk a directory, returning all file paths. */
function walkDir(dir: string, results: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkDir(full, results);
    } else {
      results.push(full);
    }
  }
  return results;
}


/**
 * True when src and dest refer to the same filesystem path.
 * On Windows NTFS, path comparison is case-insensitive.
 */
function isSamePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32'
    ? ra.toLowerCase() === rb.toLowerCase()
    : ra === rb;
}

/**
 * Recursively copy all content from src into dest, then remove originals.
 * Handles case-only renames on Windows by routing through a temp directory
 * so NTFS does not treat the source and destination as the same path.
 */
function moveTree(src: string, dest: string): void {
  const srcResolved  = path.resolve(src);
  const destResolved = path.resolve(dest);
  const caseRename   = process.platform === 'win32'
    && srcResolved.toLowerCase() === destResolved.toLowerCase()
    && srcResolved !== destResolved;

  if (caseRename) {
    const tmp = srcResolved + `.__phobos_tmp_${Date.now()}__`;
    fs.renameSync(srcResolved, tmp);
    fs.mkdirSync(destResolved, { recursive: true });
    walkCopy(tmp, destResolved);
    try { fs.rmdirSync(tmp, { recursive: true }); } catch { /* non-fatal */ }
  } else {
    walkCopy(srcResolved, destResolved);
  }
}

function walkCopy(src: string, dest: string): void {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    const srcPath  = path.join(src, e.name);
    const rel      = path.relative(src, srcPath);
    const destPath = path.join(dest, rel);
    if (e.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      walkCopy(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      fs.unlinkSync(srcPath);
    }
  }
  try { fs.rmdirSync(src, { recursive: true }); } catch { /* non-fatal */ }
}

// ── Route registration ────────────────────────────────────────────────────────

export async function registerMeridianIngestRoutes(fastify: FastifyInstance): Promise<void> {

  // ── POST /api/meridian/library/move ──────────────────────────────────────
  // Relocates the phobosPictures default library folder.
  // Updates the DB, restarts Meridian pointed at the new path.
  // Meridian's library model is path-driven — the DB record IS the library
  // config, so restart is the correct update mechanism (same as Polaris).
  // If moveContent=true, copies all files from old folder to new before swap.
  fastify.post<{ Body: { newPath: string; moveContent: boolean } }>(
    '/api/meridian/library/move',
    async (req, reply) => {
      const { newPath, moveContent } = req.body ?? {};
      if (!newPath?.trim()) {
        return reply.status(400).send({ error: 'newPath is required' });
      }

      const db     = DatabaseManager.getInstance();
      const store  = new ServiceStore(db);
      const record = await store.get('meridian');
      const oldPath = record.libraryPath;

      // Resolve paths for comparison.
      const oldResolved = oldPath ? path.resolve(oldPath) : null;
      const newResolved = path.resolve(newPath);
      const isCaseRename = process.platform === 'win32'
        && oldResolved !== null
        && oldResolved.toLowerCase() === newResolved.toLowerCase()
        && oldResolved !== newResolved;

      if (isCaseRename && oldResolved && fs.existsSync(oldResolved)) {
        // Two-step rename through a temp path so NTFS sees src and dest as different.
        const tmp = oldResolved + `.__phobos_tmp_${Date.now()}__`;
        try {
          fs.renameSync(oldResolved, tmp);
          fs.renameSync(tmp, newResolved);
        } catch (err) {
          // Roll back if possible.
          try { if (fs.existsSync(tmp)) fs.renameSync(tmp, oldResolved); } catch { /* ignore */ }
          return reply.status(500).send({ error: `Case rename failed: ${(err as Error).message}` });
        }
      } else {
        // Create destination directory.
        fs.mkdirSync(newPath, { recursive: true });

        // Content migration — recursive tree copy + delete.
        if (moveContent && oldPath && fs.existsSync(oldPath)) {
          try {
            moveTree(oldPath, newPath);
          } catch (err) {
            return reply.status(500).send({ error: `Content migration failed: ${(err as Error).message}` });
          }
        }
      }

      // Persist new path to DB.
      await store.setLibraryPath('meridian', newPath);

      // Restart Meridian pointed at the new path.
      if (meridianRunning()) {
        const idleEnabled = Boolean(record.settings.idleClassifier ?? true);
        stopMeridian().then(() => {
          startMeridian({ libraryPath: newPath, idleEnabled })
            .catch(err => console.error('[meridian] Restart after move failed:', err.message));
        });
      }

      return reply.send({ ok: true, newPath });
    },
  );

  // ── POST /api/meridian/ingest/scan-folder ─────────────────────────────────
  // Returns all files found under a given folder path.
  fastify.post<{ Body: { folderPath: string } }>(
    '/api/meridian/ingest/scan-folder',
    async (req, reply) => {
      const { folderPath } = req.body ?? {};
      if (!folderPath || typeof folderPath !== 'string') {
        return reply.status(400).send({ error: 'folderPath is required' });
      }
      const normalized = path.normalize(folderPath);
      if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) {
        return reply.status(404).send({ error: 'Folder does not exist' });
      }
      const files = walkDir(normalized);
      return reply.send({ files });
    },
  );

  // ── POST /api/meridian/ingest/commit ─────────────────────────────────────
  // Copies a list of file paths into the target library folder, then triggers
  // a Meridian scan across all known libraries.
  fastify.post<{ Body: { files: string[]; targetFolder: string } }>(
    '/api/meridian/ingest/commit',
    async (req, reply) => {
      if (!meridianRunning()) {
        return reply.status(503).send({ error: 'Meridian is not running' });
      }
      const { files, targetFolder } = req.body ?? {};
      if (!Array.isArray(files) || !targetFolder) {
        return reply.status(400).send({ error: 'files array and targetFolder are required' });
      }

      const valid = files.filter(f => typeof f === 'string' && fs.existsSync(f));
      if (valid.length === 0) {
        return reply.status(400).send({ error: 'No valid source files provided' });
      }

      fs.mkdirSync(targetFolder, { recursive: true });

      let copied = 0;
      for (const src of valid) {
        const dest = path.join(targetFolder, path.basename(src));
        try {
          fs.copyFileSync(src, dest);
          copied++;
        } catch { /* skip unreadable files */ }
      }

      // Trigger scan across all Meridian libraries.
      try {
        const res = await meridianApiRequest('GET', '/api/libraries');
        if (res.ok) {
          const { libraries } = await res.json() as { libraries: Array<{ id: string }> };
          await Promise.all(
            libraries.map(lib => meridianApiRequest('POST', `/api/libraries/${lib.id}/scan`)),
          );
        }
      } catch { /* non-fatal — Meridian will pick up files on next idle scan */ }

      return reply.send({ ok: true, copied });
    },
  );
}
