/**
 * meridian/staging/UploadDispatcher.ts — PHOBOS MediaSync upload handler.
 *
 * Receives a validated, hash-verified Buffer from the upload route and:
 *   1. Resolves the destination folder for the given library.
 *   2. Writes the file to disk under a date-bucketed subdirectory.
 *   3. Records the file in phobos_sync_manifest (dedup guard).
 *   4. Triggers a rescan of the affected library so the file is indexed.
 *
 * Library → service mapping:
 *   photos    → Meridian   ~/.phobos/media/photos/<YYYY>/<MM>/
 *   music     → Polaris    <getLibraryPath()>/<artist|unsorted>/
 *   documents → Kavita     <defaultDocsPath()>/Uploaded/
 *   movies    → Jellyfin   <defaultMediaPath()>/Uploaded/
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import crypto from 'node:crypto';

import type { MeridianDB }   from '../db/db.js';
import type { MeridianConfig } from '../db/config.js';
import type { Scanner }       from '../scanner.js';

import { getLibraryPath as getPolarisLibraryPath } from '../../services/PolarisManager.js';
import { defaultDocsPath }   from '../../services/KavitaManager.js';
import { defaultMediaPath }  from '../../services/JellyfinManager.js';

import type { SyncLibrary } from '../routes/sync.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DispatchPayload {
  library:     SyncLibrary;
  filename:    string;
  contentHash: string;
  takenAt:     string | null;  // ISO-8601 or null
  sizeBytes:   number;
  deviceId:    string;
  buffer:      Buffer;
}

// ── UploadDispatcher ──────────────────────────────────────────────────────────

export class UploadDispatcher {
  private readonly _db:      MeridianDB;
  private readonly _config:  MeridianConfig;
  private readonly _scanner: Scanner;

  constructor(db: MeridianDB, config: MeridianConfig, scanner: Scanner) {
    this._db      = db;
    this._config  = config;
    this._scanner = scanner;
  }

  /**
   * Write the file to disk, record it in the manifest, trigger a rescan.
   * Returns the absolute destination path.
   * Throws on disk error; the upload route converts that to a 500.
   */
  async dispatch(payload: DispatchPayload): Promise<string> {
    const destPath = this._resolveDestPath(payload);
    const destDir  = path.dirname(destPath);

    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(destPath, payload.buffer);

    await this._db.execQuery(
      `INSERT INTO phobos_sync_manifest
         (content_hash, library, original_name, dest_path, size_bytes, taken_at, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (content_hash) DO NOTHING`,
      [
        payload.contentHash,
        payload.library,
        payload.filename,
        destPath,
        payload.sizeBytes,
        payload.takenAt ?? null,
        payload.deviceId,
      ],
    );

    this._triggerRescan(payload.library, destPath);

    return destPath;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _resolveDestPath(payload: DispatchPayload): string {
    const safe = sanitizeFilename(payload.filename);

    switch (payload.library) {
      case 'photos':
        return path.join(this._photosRoot(payload.takenAt), safe);

      case 'music':
        return path.join(getPolarisLibraryPath(), 'Uploaded', safe);

      case 'documents':
        return path.join(defaultDocsPath(), 'Uploaded', safe);

      case 'movies':
        return path.join(defaultMediaPath(), 'Uploaded', safe);
    }
  }

  /**
   * Bucket photos under <phobosLibPath>/<YYYY>/<MM>/.
   * Falls back to <phobosLibPath>/Unsorted/ when takenAt is unavailable.
   */
  private _photosRoot(takenAt: string | null): string {
    if (takenAt) {
      const d = new Date(takenAt);
      if (!isNaN(d.getTime())) {
        const yyyy = String(d.getUTCFullYear());
        const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
        return path.join(this._config.phobosLibPath, yyyy, mm);
      }
    }
    return path.join(this._config.phobosLibPath, 'Unsorted');
  }

  /**
   * Trigger a rescan on the correct service library for the uploaded file.
   * Photos use Meridian's own scanner; the others trigger their service managers.
   * All rescans are fire-and-forget — upload response does not wait on them.
   */
  private _triggerRescan(library: SyncLibrary, destPath: string): void {
    if (library === 'photos') {
      // Build a minimal MeridianLibrary shape so scanner.scanPath can accept it.
      const libPath = this._config.phobosLibPath;
      const libId   = crypto
        .createHash('sha256')
        .update(libPath + this._config.userId)
        .digest('hex')
        .slice(0, 16);

      const lib = {
        id:         libId,
        path:       libPath,
        label:      'PHOBOS Photos',
        enabled:    true,
        lastScanAt: null,
        fileCount:  0,
        userId:     this._config.userId,
        createdAt:  new Date().toISOString(),
      };

      this._scanner.scanPath(destPath, lib).catch((err: unknown) => {
        console.error('[UploadDispatcher] scanPath error:', err);
      });
      return;
    }

    // For non-photos libraries we call the service manager's triggerScan.
    // Imports are dynamic so we don't take a startup dep on services that may
    // not be running.
    if (library === 'music') {
      import('../../services/PolarisManager.js').then(m => m.triggerScan()).catch(() => {});
    } else if (library === 'documents') {
      import('../../services/KavitaManager.js').then(m => m.triggerScan()).catch(() => {});
    } else if (library === 'movies') {
      import('../../services/JellyfinManager.js').then(m => m.triggerScan()).catch(() => {});
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strip characters unsafe for filenames across macOS / Linux / Windows.
 * Preserves extension. Collapses runs of replacement dashes.
 */
function sanitizeFilename(name: string): string {
  const unsafe = /[<>:"/\\|?*\x00-\x1f]/g;
  const clean  = name.replace(unsafe, '-').replace(/-{2,}/g, '-').trim();
  return clean.length > 0 ? clean : 'upload';
}
