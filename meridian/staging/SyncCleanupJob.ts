/**
 * meridian/staging/SyncCleanupJob.ts — retention sweep for synced files.
 *
 * Runs once daily (default interval). For each policy that has retain_days set,
 * finds manifest entries older than retain_days, deletes the file from disk,
 * removes the manifest row, and removes the Meridian file index entry.
 *
 * Safe to run while the server is live — db writes are per-row, not bulk.
 * Stops cleanly when stop() is called (e.g. on server shutdown).
 */

import fs from 'node:fs';

import type { MeridianDB } from '../db/db.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── SyncCleanupJob ────────────────────────────────────────────────────────────

export class SyncCleanupJob {
  private readonly _db:       MeridianDB;
  private          _timer:    ReturnType<typeof setTimeout> | null = null;
  private          _running:  boolean                             = false;

  constructor(db: MeridianDB) {
    this._db = db;
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this._schedule();
  }

  stop(): void {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _schedule(): void {
    if (!this._running) return;
    this._timer = setTimeout(() => {
      this._sweep().catch((err: unknown) => {
        console.error('[SyncCleanupJob] sweep error:', err);
      }).finally(() => {
        this._schedule();
      });
    }, INTERVAL_MS);
  }

  private async _sweep(): Promise<void> {
    // Find all policies with an active retention window.
    type PolicyRow = { id: string; library: string; retain_days: number };
    const policies = (await this._db.rawQuery(
      'SELECT id, library, retain_days FROM phobos_sync_policies WHERE retain_days IS NOT NULL AND enabled = 1',
      [],
    )) as unknown as PolicyRow[];

    for (const policy of policies) {
      const cutoff = new Date(Date.now() - policy.retain_days * 24 * 60 * 60 * 1000);

      type ManifestRow = { content_hash: string; dest_path: string };
      const expired = (await this._db.rawQuery(
        `SELECT content_hash, dest_path
         FROM phobos_sync_manifest
         WHERE library = ? AND uploaded_at < ?`,
        [policy.library, cutoff.toISOString()],
      )) as unknown as ManifestRow[];

      for (const row of expired) {
        // Delete from disk — non-fatal if the file is already gone.
        try {
          if (fs.existsSync(row.dest_path)) {
            fs.unlinkSync(row.dest_path);
          }
        } catch (err) {
          console.warn(`[SyncCleanupJob] Could not delete ${row.dest_path}:`, err);
        }

        // Remove from Meridian's file index (by path match).
        await this._db.rawQuery(
          'DELETE FROM meridian_files WHERE path = ?',
          [row.dest_path],
        ).catch(() => {});

        // Remove the manifest entry.
        await this._db.rawQuery(
          'DELETE FROM phobos_sync_manifest WHERE content_hash = ?',
          [row.content_hash],
        ).catch(() => {});

        console.log(`[SyncCleanupJob] Expired and removed: ${row.dest_path}`);
      }
    }
  }
}
