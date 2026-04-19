/**
 * meridian/watcher.ts — Debounced fs.watch wrapper for PHOBOS Meridian.
 *
 * Watches library root directories for changes. Debounces events to avoid
 * hammering the scanner during burst writes (e.g. photo imports).
 * Started after the initial scan completes, not before.
 */

import fs   from 'node:fs';
import path from 'node:path';
import type { Scanner } from './scanner.js';
import type { MeridianLibrary } from './db/db.js';

const DEBOUNCE_MS = 2_000;

export class LibraryWatcher {
  private watchers: Map<string, fs.FSWatcher> = new Map();
  private timers:   Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(private scanner: Scanner) {}

  watch(lib: MeridianLibrary): void {
    if (this.watchers.has(lib.id)) return;
    if (!fs.existsSync(lib.path)) {
      console.warn(`[Meridian] Watch target does not exist — skipping: ${lib.path}`);
      return;
    }

    try {
      const watcher = fs.watch(lib.path, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const fullPath = path.join(lib.path, filename);
        this._debounce(lib.id, fullPath, lib);
      });

      watcher.on('error', err => {
        console.error(`[Meridian] Watcher error for ${lib.path}:`, err.message);
        this.unwatch(lib.id);
      });

      this.watchers.set(lib.id, watcher);
      console.log(`[Meridian] Watching: ${lib.path}`);
    } catch (err) {
      // fs.watch is not supported on all platforms/filesystems (e.g. network mounts)
      console.warn(`[Meridian] Could not watch ${lib.path}: ${(err as Error).message}`);
    }
  }

  unwatch(libraryId: string): void {
    const watcher = this.watchers.get(libraryId);
    if (watcher) { watcher.close(); this.watchers.delete(libraryId); }
    const timer = this.timers.get(libraryId);
    if (timer) { clearTimeout(timer); this.timers.delete(libraryId); }
  }

  unwatchAll(): void {
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
  }

  private _debounce(libraryId: string, filePath: string, lib: MeridianLibrary): void {
    const existing = this.timers.get(libraryId + filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(libraryId + filePath);
      this.scanner.scanPath(filePath, lib).catch(err => {
        console.error(`[Meridian] Targeted scan failed for ${filePath}:`, err.message);
      });
    }, DEBOUNCE_MS);

    this.timers.set(libraryId + filePath, timer);
  }
}
