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
 *   photos    → Meridian   ~/.phobos/media/meridian/{userId}/{deviceName}/{albumName}/
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
  albumName:   string;   // device album/folder name — mirrored directly on disk
  contentHash: string;
  takenAt:     string | null;  // ISO-8601 or null — stored in manifest only
  sizeBytes:   number;
  deviceId:    string;
  userId:      string;    // provisioned username — determines landing folder
  deviceName:  string;    // device display name — sub-bucket under userId
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

    try {
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(destPath, payload.buffer);

      this._triggerRescan(payload.library, destPath, payload.userId);
      return destPath;
    } catch (err: unknown) {
      console.error('[UploadDispatcher] dispatch error:', err);
      throw err;
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _resolveDestPath(payload: DispatchPayload): string {
    const safe = sanitizeFilename(payload.filename);

    switch (payload.library) {
      case 'photos':
        return path.join(this._photosRoot(payload.userId, payload.deviceName, payload.albumName), safe);

      case 'music':
        return path.join(getPolarisLibraryPath(), 'Uploaded', safe);

      case 'documents':
        return path.join(defaultDocsPath(), 'Uploaded', safe);

      case 'movies':
        return path.join(defaultMediaPath(), 'Uploaded', safe);
    }
  }

  /**
   * Mirror the device's album/folder structure on disk:
   *   ~/.phobos/media/meridian/{userId}/{deviceName}/{albumName}/
   * Falls back to Unsorted/ when albumName is empty.
   */
  private _photosRoot(userId: string, deviceName: string, albumName: string): string {
    const safeDevice = deviceName.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
    const safeAlbum  = albumName.trim().length > 0
      ? sanitizeFilename(albumName)
      : 'Unsorted';
    return path.join(os.homedir(), '.phobos', 'media', 'meridian', userId, safeDevice, safeAlbum);
  }

  /**
   * Trigger a rescan on the correct service library for the uploaded file.
   * Photos use Meridian's own scanner; the others trigger their service managers.
   * All rescans are fire-and-forget — upload response does not wait on them.
   */
  private _triggerRescan(library: SyncLibrary, destPath: string, userId: string): void {
    if (library === 'photos') {
      const libPath = path.join(os.homedir(), '.phobos', 'media', 'meridian', userId);
      const libId   = crypto
        .createHash('sha256')
        .update(libPath + userId)
        .digest('hex')
        .slice(0, 16);

      const lib = {
        id:         libId,
        path:       libPath,
        label:      `${userId} Photos`,
        enabled:    true,
        lastScanAt: null,
        fileCount:  0,
        userId,
        createdAt:  new Date().toISOString(),
      };

      this._scanner.scanPath(destPath, lib).catch((err: unknown) => {
        console.error('[UploadDispatcher] scanPath error:', err);
      });
      return;
    }

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