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
import type { MeridianConfig }   from './db/config.js';

export interface MeridianStartOpts {
  libraryPath:  string;
  idleEnabled?: boolean;
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
let _classifier: InstanceType<typeof IdleClassifier> | null = null;

export const MERIDIAN_PORT = 16320;

// ── Start ─────────────────────────────────────────────────────────────────────

export async function startMeridianServer(
  dbManager: DatabaseManager,
  opts: MeridianStartOpts,
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

    // Ensure required directories exist.
    fs.mkdirSync(cfg.thumbCacheDir, { recursive: true });
    fs.mkdirSync(path.join(os.homedir(), '.phobos', 'media', 'photos'), { recursive: true });

    // Use the already-open DatabaseManager from the main process — no second open.
    const db = new MeridianDB(dbManager);
    await db.ensureSchema();

    // Bootstrap library rows.
    async function ensureLibrary(libPath: string, label: string) {
      let lib = await db.getLibraryByPath(libPath, cfg.userId);
      if (!lib) {
        lib = {
          id:         crypto.createHash('sha256').update(libPath + cfg.userId).digest('hex').slice(0, 16),
          path:       libPath,
          label,
          enabled:    true,
          lastScanAt: null,
          fileCount:  0,
          userId:     cfg.userId,
          createdAt:  new Date().toISOString(),
        };
        await db.upsertLibrary(lib);
      }
      return lib;
    }

    const phobosLib = await ensureLibrary(cfg.phobosLibPath, 'PHOBOS Photos');
    const userLibs  = await Promise.all(
      cfg.userLibPaths.map((p, i) => ensureLibrary(p, `Library ${i + 1}`))
    );
    const allLibs = [phobosLib, ...userLibs];

    // Build scanner, watcher, classifier.
    const scanner    = new Scanner(db, cfg);
    _watcher         = new LibraryWatcher(scanner);
    _classifier      = new IdleClassifier(db, cfg);

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
        reply.header('Access-Control-Allow-Headers', 'Content-Type');
      }
      if (req.method === 'OPTIONS') return reply.status(204).send();
    });

    await _fastify.register(statusRoutes,  { scanner, db, config: cfg });
    await _fastify.register(fileRoutes,    { db, config: cfg });
    await _fastify.register(albumRoutes,   { db, config: cfg });
    await _fastify.register(libraryRoutes, { db, config: cfg, scanner });
    await _fastify.register(searchRoutes,  { db, config: cfg });
    await _fastify.register(syncRoutes);

    await _fastify.listen({ port: cfg.port, host: '127.0.0.1' });
    console.log(`[Meridian] Listening on :${cfg.port}`);

    _state = 'running';

    // Non-blocking initial scan + watcher startup.
    _classifier.start();
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
    _watcher?.unwatchAll();
    await _fastify?.close();
  } catch (err) {
    console.error('[Meridian] Error during shutdown:', (err as Error).message);
  } finally {
    _fastify    = null;
    _watcher    = null;
    _classifier = null;
    _config     = null;
  }
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
