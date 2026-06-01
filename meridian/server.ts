/**
 * meridian/server.ts — PHOBOS Meridian in-process HTTP server.
 *
 * Runs as a second Fastify server inside the main PHOBOS process on port 16320.
 * Receives the already-open DatabaseManager from the main server — no second
 * DuckDB connection, no subprocess, no portable node binary required.
 *
 * Exported API:
 *   startMeridianServer(db, opts) → Promise<void>
 *   stopMeridianServer()          → Promise<void>
 *   getMeridianServerStatus()     → MeridianServerStatus
 */

import Fastify           from 'fastify';
import path              from 'node:path';
import os                from 'node:os';
import fs                from 'node:fs';
import crypto            from 'node:crypto';
import type { DatabaseManager } from '../db/DatabaseManager.js';
import { defaultConfig }         from './db/config.js';
import { MeridianDB }            from './db/db.js';
import { Scanner }               from './scanner.js';
import { LibraryWatcher }        from './watcher.js';
import { IdleClassifier, setIdle } from './idle-classifier.js';
import { statusRoutes }          from './routes/status.js';
import { fileRoutes }            from './routes/files.js';
import { albumRoutes }           from './routes/albums.js';
import { libraryRoutes }         from './routes/libraries.js';
import { searchRoutes }          from './routes/search.js';
import { syncRoutes }            from './routes/sync.js';
import { UploadDispatcher }      from './staging/UploadDispatcher.js';
import { SyncCleanupJob }        from './staging/SyncCleanupJob.js';
import type { MeridianConfig }   from './db/config.js';

declare module 'fastify' {
  interface FastifyRequest { meridianUser: string; }
}

export interface MeridianStartOpts {
  libraryPath:  string;
  idleEnabled?: boolean;
  // Resolves a username to its user-scoped DatabaseManager.
  // Required for multi-user sync routing.
  getUserDb: (username: string) => DatabaseManager;
}

export interface MeridianServerStatus {
  state:       'stopped' | 'starting' | 'running' | 'error';
  port:        number;
  error:       string | null;
  libraryPath: string | null;
  scanPhase:   string | null;
}

// ── Module-level state ────────────────────────────────────────────────────────

let _state:   'stopped' | 'starting' | 'running' | 'error' = 'stopped';
let _error:   string | null = null;
let _config:  MeridianConfig | null = null;
let _fastify: ReturnType<typeof Fastify> | null = null;
let _watcher: InstanceType<typeof LibraryWatcher> | null = null;
let _classifier:  InstanceType<typeof IdleClassifier> | null  = null;
let _dispatcher:  UploadDispatcher | null                     = null;
let _cleanupJob:  SyncCleanupJob   | null                     = null;
let _signalingClient: { notifySync(): void } | null           = null;
let _db:      MeridianDB | null                               = null;
let _scanner: InstanceType<typeof Scanner> | null             = null;

export const MERIDIAN_PORT = 16320;

/**
 * Wire the relay SignalingClient into the running sync routes.
 * Called from server.ts after webrtcSignalingClient is constructed —
 * after startMeridian() returns due to boot-sequence ordering.
 * Safe to call before or after startMeridianServer; syncRoutes reads
 * opts.signalingClient at registration time but the module-level ref
 * is the live one that notifySync() dispatches through.
 */
export function setSignalingClient(client: { notifySync(): void } | null): void {
  _signalingClient = client;
}

// ── Start ─────────────────────────────────────────────────────────────────────

export async function startMeridianServer(
  dbManager:     DatabaseManager,
  opts:          MeridianStartOpts,
  syncDbManager?: DatabaseManager,
): Promise<void> {
  if (_state === 'running' || _state === 'starting') return;

  _state = 'starting';
  _error = null;

  try {
    const cfg: MeridianConfig = {
      ...defaultConfig(),
      phobosLibPath: opts.libraryPath,
      idleEnabled:   opts.idleEnabled ?? true,
      // dbPath is irrelevant here — we use the injected DatabaseManager directly.
      // Set it for completeness in case config is serialised anywhere.
      dbPath: (dbManager as any)['dbPath'] ?? defaultConfig().dbPath,
    };
    _config = cfg;

    // Write config.json to disk so it reflects the actual runtime config.
    // This keeps the on-disk file in sync after path migrations.
    const configDir = path.join(os.homedir(), '.phobos', 'services', 'meridian');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify(cfg, null, 2),
      'utf8',
    );

    // ── Path migration: rewrite legacy phobosLibPath values on first boot ─────
    // Old defaults: ~/.phobos/media/photos  or  ~/.phobos/media/phobosPictures
    // Canonical:    ~/.phobos/media/meridian/phobosPhotos
    const legacySuffixes = ['media/photos', 'media/phobosPictures'];
    const normalised = cfg.phobosLibPath.replace(/\\/g, '/');
    if (legacySuffixes.some(s => normalised.endsWith(s))) {
      cfg.phobosLibPath = path.join(os.homedir(), '.phobos', 'media', 'meridian', 'phobosPhotos');
      fs.writeFileSync(
        path.join(configDir, 'config.json'),
        JSON.stringify(cfg, null, 2),
        'utf8',
      );
      console.log(`[Meridian] Migrated phobosLibPath → ${cfg.phobosLibPath}`);
    }

    // Ensure required directories exist.
    fs.mkdirSync(cfg.thumbCacheDir, { recursive: true });
    fs.mkdirSync(cfg.phobosLibPath, { recursive: true });

    // Use the already-open DatabaseManager from the main process — no second open.
    // syncDbManager is the owner's user DB where phobos_sync_* tables now live.
    const db = new MeridianDB(dbManager, syncDbManager);
    await db.ensureSchema();

    // Bootstrap library rows.
    async function ensureLibrary(libPath: string, label: string, userId: string) {
      let lib = await db.getLibraryByPath(libPath, userId);
      if (!lib) {
        lib = {
          id:         crypto.createHash('sha256').update(libPath + userId).digest('hex').slice(0, 16),
          path:       libPath,
          label,
          enabled:    true,
          lastScanAt: null,
          fileCount:  0,
          userId,
          createdAt:  new Date().toISOString(),
        };
        await db.upsertLibrary(lib);
      }
      return lib;
    }

    const phobosLib = await ensureLibrary(cfg.phobosLibPath, 'PHOBOS Photos', 'owner');
    const userLibs  = await Promise.all(
      cfg.userLibPaths.map((p, i) => ensureLibrary(p, `Library ${i + 1}`, 'owner'))
    );
    const allLibs = [phobosLib, ...userLibs];

    // ── Purge stale library rows ───────────────────────────────────────────
    // Delete file rows belonging to library IDs that are no longer active.
    // This cleans up after path changes (old phobosLibPath rows accumulate otherwise).
    const activeIds = new Set(allLibs.map(l => l.id));
    const allLibRows = await db.listLibraries(cfg.userId);
    for (const staleLib of allLibRows.filter(l => !activeIds.has(l.id))) {
      console.log(`[Meridian] Purging stale library ${staleLib.id} (${staleLib.path})`);
      await db.deleteFilesNotIn(staleLib.id, []);
      await db.deleteLibrary(staleLib.id);
    }

    // Build scanner, watcher, classifier, dispatcher, cleanup job.
    const scanner    = new Scanner(db, cfg);
    _watcher         = new LibraryWatcher(scanner);
    _classifier      = new IdleClassifier(db, cfg);
    _dispatcher      = new UploadDispatcher(db, cfg, scanner);
    _cleanupJob      = new SyncCleanupJob(db);
    _db              = db;
    _scanner         = scanner;

    // Build Fastify instance on port 16320.
    _fastify = Fastify({ logger: false });

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    _fastify.addHook('onRequest', (_req: import('fastify').FastifyRequest, _reply: import('fastify').FastifyReply, done: () => void) => {
      setIdle(false);
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => setIdle(true), 30_000);
      done();
    });

    _fastify.addHook('onRequest', async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
      const origin = req.headers.origin;
      if (origin) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Phobos-Library, X-Phobos-Filename, X-Phobos-Hash, X-Phobos-Taken-At, X-Phobos-Size, X-Phobos-Upload-Id, X-Phobos-Chunk-Index, X-Phobos-Chunk-Total');
      }
      if (req.method === 'OPTIONS') return reply.status(204).send();
    });

    // Resolve the requesting user from x-webrtc-user (stamped by DataChannelHandler
    // on every proxied request). Falls back to 'owner' for direct LAN HTTP.
    _fastify.addHook('preHandler', (req: import('fastify').FastifyRequest, _reply: import('fastify').FastifyReply, done: () => void) => {
      (req as import('fastify').FastifyRequest & { meridianUser: string }).meridianUser =
        (req.headers['x-webrtc-user'] as string | undefined)?.trim() || 'owner';
      done();
    });

    // Required for POST /api/sync/upload — Fastify does not parse octet-stream by default.
    _fastify.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: 2 * 1024 * 1024 * 1024 },
      (_req: import('fastify').FastifyRequest, body: Buffer, done: (err: Error | null, body: Buffer) => void) => done(null, body),
    );

    await _fastify.register(statusRoutes,  { scanner, db, config: cfg });
    await _fastify.register(fileRoutes,    { db, config: cfg });
    await _fastify.register(albumRoutes,   { db, config: cfg });
    await _fastify.register(libraryRoutes, { db, config: cfg, scanner });
    await _fastify.register(searchRoutes,  { db, config: cfg });
    await _fastify.register(syncRoutes, { db, config: cfg, scanner, dispatcher: _dispatcher, getUserDb: opts.getUserDb, signalingClient: { notifySync: () => _signalingClient?.notifySync() } });

    await _fastify.listen({ port: cfg.port, host: '127.0.0.1' });
    console.log(`[Meridian] Listening on :${cfg.port}`);

    _state = 'running';

    // Non-blocking initial scan + watcher startup.
    _classifier.start();
    _cleanupJob.start();
    setIdle(false);
    for (const lib of allLibs.filter(l => l.enabled)) {
      console.log(`[Meridian] Starting scan: ${lib.path}`);
      scanner.scanLibrary(lib);
    }
    // Capture watcher reference locally — _watcher may be nulled by stopMeridianServer()
    // if stop is called before the 5-second delay fires (e.g. in test scripts).
    const watcherRef = _watcher;
    setTimeout(() => {
      if (!watcherRef) return; // stopped before watcher delay fired
      for (const lib of allLibs.filter(l => l.enabled)) {
        watcherRef.watch(lib);
      }
      setIdle(true);
    }, 5_000);

  } catch (err) {
    _state = 'error';
    _error = (err as Error).message;
    console.error('[Meridian] Failed to start:', _error);
    throw err;
  }
}

// ── Stop ──────────────────────────────────────────────────────────────────────

export async function stopMeridianServer(): Promise<void> {
  if (_state === 'stopped') return;
  _state = 'stopped';

  try {
    _classifier?.stop();
    _cleanupJob?.stop();
    _watcher?.unwatchAll();
    await _fastify?.close();
  } catch (err) {
    console.error('[Meridian] Error during shutdown:', (err as Error).message);
  } finally {
    _fastify    = null;
    _watcher    = null;
    _classifier = null;
    _dispatcher = null;
    _cleanupJob = null;
    _config     = null;
    _db         = null;
    _scanner    = null;
  }
}

// ── Repair ────────────────────────────────────────────────────────────────────

/**
 * Reconcile Meridian libraries for every PHOBOS system user at boot.
 *
 * For each username in the list:
 *   1. Ensure ~/.phobos/media/meridian/{username}/phobosPhotos/ exists on disk.
 *   2. Ensure a meridian_libraries row exists for that path and userId.
 *   3. If the library was just created (or its last scan was never completed),
 *      kick off a non-blocking scanLibrary() pass.
 *   4. Add the directory to the file watcher so live changes are picked up.
 *
 * Skips the owner — the owner's library is bootstrapped inside
 * startMeridianServer() and is already scanned and watched at this point.
 *
 * Fully non-fatal: one user's failure never blocks others.
 * Called from server.ts after startMeridian() resolves.
 */
export async function repairAllUserLibraries(usernames: string[]): Promise<void> {
  if (_state !== 'running' || !_db || !_scanner || !_watcher) return;

  const db      = _db;
  const scanner = _scanner;
  const watcher = _watcher;

  for (const username of usernames) {
    if (username === 'owner') continue; // bootstrapped by startMeridianServer

    try {
      const userPhotosPath = path.join(
        os.homedir(), '.phobos', 'media', 'meridian', username, 'phobosPhotos',
      );
      fs.mkdirSync(userPhotosPath, { recursive: true });

      let lib = await db.getLibraryByPath(userPhotosPath, username);
      const isNew = !lib;

      if (!lib) {
        lib = {
          id:         crypto.createHash('sha256').update(userPhotosPath + username).digest('hex').slice(0, 16),
          path:       userPhotosPath,
          label:      `${username} Photos`,
          enabled:    true,
          lastScanAt: null,
          fileCount:  0,
          userId:     username,
          createdAt:  new Date().toISOString(),
        };
        await db.upsertLibrary(lib);
        console.log(`[Meridian] repairAllUserLibraries: created library for ${username} at ${userPhotosPath}`);
      }

      // Scan if new or never completed a scan.
      if (isNew || !lib.lastScanAt) {
        scanner.scanLibrary(lib);
      }

      // Always ensure the directory is watched after startup.
      watcher.watch(lib);

    } catch (err) {
      console.warn(`[Meridian] repairAllUserLibraries: ${username} failed (non-fatal):`, (err as Error).message);
    }
  }

  console.log(`[Meridian] repairAllUserLibraries: done (${usernames.length} user(s) checked)`);
}

// ── Status ────────────────────────────────────────────────────────────────────

export function getMeridianServerStatus(): MeridianServerStatus {
  return {
    state:       _state,
    port:        MERIDIAN_PORT,
    error:       _error,
    libraryPath: _config?.phobosLibPath ?? null,
    scanPhase:   null,
  };
}