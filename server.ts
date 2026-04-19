import 'dotenv/config';
import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseManager } from './db/DatabaseManager.js';
import { threadsRoute } from './routes/threads.js';
import { messagesRoute } from './routes/messages.js';
import { documentsRoute } from './routes/documents.js';
import { statusRoute } from './routes/status.js';
import { phobosLocalRoute } from './routes/phobosLocal.js';
import { registerLicenseRoutes } from './routes/license.js';
import { projectsRoute } from './routes/projects.js';
import { exportRoute } from './routes/export.js';
import { workflowsRoute } from './routes/workflows.js';
import { registerCopilotRoutes } from './routes/copilot.js';
import { registerPluginRoutes } from './routes/pluginRoutes.js';
import { registerUserSkillRoutes } from './routes/userSkillRoutes.js';
import { registerSchedulerRoutes } from './routes/scheduler.js';
import { initScheduler } from './scheduling/Scheduler.js';
import { ScheduledTaskStore } from './db/ScheduledTaskStore.js';
import { scanOnStartup as scanUserSkills } from './db/UserSkillManager.js';
import { stopAllServers, startSybil } from './phobos/LlamaServerManager.js';
import { MemoryStore } from './db/MemoryStore.js';
import { reconfigureClients, COORDINATOR_MODEL, ENGINE_MODEL } from './ai/clients.js';
import * as ModelPathStore from './db/ModelPathStore.js';
import { loadRegistry } from './ai/SkillManager.js';
import { registerGameRoutes } from './routes/game.js';
import { GameStore } from './db/GameStore.js';
import { gsm } from './game/GameStateManager.js';
import { registerServiceRoutes } from './routes/services.js';
import { registerAudioRoutes } from './routes/audio.js';
import { ServiceStore } from './db/ServiceStore.js';
import { stopMeridian, startMeridian, getMeridianStatus } from './services/MeridianManager.js';
import { stopPolaris, startPolaris, isBinaryPresent as isPolarisBinaryPresent } from './services/PolarisManager.js';
import {
  stopJellyfin,
  startJellyfin,
  isBinaryPresent as isJellyfinBinaryPresent,
} from './services/JellyfinManager.js';
import { stopCarla } from './phobos/CarlaManager.js';
import { registerToolsRoutes } from './routes/toolsRoute.js';
import { stopBroadway, startBroadway } from './phobos/BroadwayManager.js';
import { registerCartridgeRoutes } from './routes/cartridgeRoutes.js';
import { CartridgeStore } from './db/CartridgeStore.js';
import { initCartridgeManager, reconcileCartridgeSlots } from './phobos/CartridgeManager.js';
import { startCamofox, stopCamofox, isCamofoxInstalled } from './phobos/CamofoxManager.js';
import { ArchiveStore } from './db/ArchiveStore.js';
import { registerArchiveRoutes } from './routes/archiveRoutes.js';
import { registerMpvRoutes } from './routes/mpv.js';
import { registerIptvRoutes } from './routes/iptv.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

const PHOBOS_DATA_DIR = process.env.PHOBOS_DATA_DIR ?? path.join(os.homedir(), '.phobos');
mkdirSync(PHOBOS_DATA_DIR, { recursive: true });

const DB_PATH         = process.env.DB_PATH         ?? path.join(PHOBOS_DATA_DIR, 'phobos.duckdb');
const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? path.join(PHOBOS_DATA_DIR, 'workspaces');
mkdirSync(WORKSPACES_ROOT, { recursive: true });

async function buildServer() {
  const fastify = Fastify({
    disableRequestLogging: process.env.PHOBOS_DEBUG !== '1',
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  await fastify.register(cors, {
    origin: (origin, cb) => {
      if (
        !origin ||
        origin.includes('localhost') ||
        origin.includes('127.0.0.1') ||
        origin.includes('autarch.net') ||
        origin.includes('onrender.com') ||
        origin.includes('10.0.0.')
      ) {
        cb(null, true);
      } else {
        cb(null, false);
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 10 * 1024 * 1024 },
    (req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 256 * 1024 * 1024 },
    (_req, body, done) => done(null, body)
  );

  await fastify.register(threadsRoute);
  await fastify.register(messagesRoute);
  await fastify.register(documentsRoute);
  await fastify.register(statusRoute);
  await fastify.register(phobosLocalRoute);
  await fastify.register(exportRoute);
  await fastify.register(workflowsRoute);
  await fastify.register(projectsRoute);
  await registerLicenseRoutes(fastify);
  await registerCopilotRoutes(fastify);
  await registerPluginRoutes(fastify);
  await registerUserSkillRoutes(fastify);
  await registerSchedulerRoutes(fastify);
  await registerGameRoutes(fastify);
  await registerServiceRoutes(fastify);
  await registerAudioRoutes(fastify);
  await registerToolsRoutes(fastify);
  await registerCartridgeRoutes(fastify);
  await registerArchiveRoutes(fastify);
  await registerMpvRoutes(fastify);
  await registerIptvRoutes(fastify);

  fastify.get('/health', async () => ({ ok: true, ts: Date.now() }));

  fastify.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: 'Not found' });
  });

  fastify.setErrorHandler((err: FastifyError, _req, reply) => {
    fastify.log.error(err);
    reply.status(err.statusCode ?? 500).send({
      error: err.message ?? 'Internal server error',
    });
  });

  return fastify;
}

async function main() {
  process.env.DB_PATH         = DB_PATH;
  process.env.WORKSPACES_ROOT = WORKSPACES_ROOT;

  console.log('⚙️  Initializing Phobos Core Systems...');

  const db = DatabaseManager.getInstance(DB_PATH);
  await db.initialize();

  // GIMP / Broadway — boot with PHOBOS, stay alive perpetually.
  // A phantom WebSocket client connects to broadwayd before GIMP starts,
  // giving broadwayd a real display canvas (1920×1080) so GIMP's icon
  // scaling math never receives a zero-width and divide-by-zero crashes.
  startBroadway().catch(err => console.warn('[Broadway] Startup error (non-fatal):', (err as Error).message));

  const memoryStore = new MemoryStore(db);
  await memoryStore.ensureTable();

  await ModelPathStore.loadAsync(db);
  await reconfigureClients();

  // Earliest start point for 
  // ── SYBIL ─────────────────────────────────────────────────────────────────
  const archiveHasContent = ArchiveStore.hasAnyContent();
 
  if (archiveHasContent) {
    // Archive content exists — SYBIL is required. Wait for startup to settle.
    try {
      await startSybil();
    } catch (err) {
      console.error('[PHOBOS] Archive content exists but SYBIL failed to start:', err);
      console.error('[PHOBOS] Archive search will be disabled until SYBIL is running.');
      // archiveEnabled flag — read by /api/archive/status to surface warning banner.
      process.env.ARCHIVE_SYBIL_FAILED = '1';
    }
  } else {
    // No archive content — SYBIL startup is non-fatal (Phase 1 behaviour).
    startSybil().catch(err => console.warn('[SYBIL] Startup error (non-fatal):', err));
  }
 

  await loadRegistry();
  await scanUserSkills();

  const taskStore = new ScheduledTaskStore(db);
  await taskStore.ensureTable();
  const scheduler = initScheduler(db);
  scheduler.start();

  // ── PHOBOS World game state ───────────────────────────────────────────────
  const gameStoreInstance = new GameStore(db);
  await gameStoreInstance.ensureTable();
  gsm.start();

  // ── LLM Cartridge Library ─────────────────────────────────────────────────
  const cartridgeStore = new CartridgeStore(db);
  await cartridgeStore.ensureTable();
  initCartridgeManager(cartridgeStore);
  await reconcileCartridgeSlots();

  // ── Camofox Web Browser ───────────────────────────────────────────────────
  // Core feature — starts with PHOBOS on every boot. Non-fatal if the binary
  // hasn't been downloaded yet (first run); Camofox auto-downloads ~300 MB on
  // first npm start. If the npm package is missing entirely, logs a warning.
  if (isCamofoxInstalled()) {
    startCamofox().catch(err =>
      console.warn('[Camofox] Auto-start failed (non-fatal):', (err as Error).message)
    );
  } else {
    console.warn('[Camofox] camofox-browser not found in node_modules — run: npm install');
  }

  // ── Media Hub ─────────────────────────────────────────────────────────────
  const serviceStore = new ServiceStore(db);
  await serviceStore.ensureTable();

  const merRecord = await serviceStore.get('meridian');
  if (merRecord.enabled && merRecord.libraryPath) {
    startMeridian({
      libraryPath:  merRecord.libraryPath,
      idleEnabled:  Boolean(merRecord.settings.idleClassifier ?? true),
    }).catch(err => console.warn('[MediaHub] Meridian auto-start failed:', err.message));
  }

  const polarisRecord = await serviceStore.get('polaris');
  if (polarisRecord.enabled && polarisRecord.libraryPath) {
    if (isPolarisBinaryPresent()) {
      startPolaris({
        adminPassword: polarisRecord.settings.adminPassword as string,
        libraryPath:   polarisRecord.libraryPath,
        mountName:     (polarisRecord.settings.mountName as string) || 'Music',
      }).catch(err => console.warn('[MediaHub] Polaris auto-start failed:', err.message));
    }
  }

  const jellyfinRecord = await serviceStore.get('jellyfin');
  if (jellyfinRecord.enabled) {
    if (isJellyfinBinaryPresent()) {
      const adminPassword = (jellyfinRecord.settings.adminPassword as string) || '';
      if (adminPassword) {
        startJellyfin(
          {
            libraryPath:   jellyfinRecord.libraryPath,
            hardwareAccel: (jellyfinRecord.settings.hardwareAccel as string) || '',
          },
          adminPassword,
        ).catch(err => console.warn('[MediaHub] Jellyfin auto-start failed:', err.message));
      }
    }
  }

  // ── Flush WAL after all migrations ────────────────────────────────────────
  // ensureTable() runs ALTER TABLE ADD COLUMN IF NOT EXISTS on every boot.
  // Even though they're no-ops when columns exist, DuckDB writes them to the
  // WAL. If the process is killed before db.close(), the WAL is left dirty
  // and fails to replay on next startup. CHECKPOINT flushes the WAL to the
  // main database file immediately, so a hard kill after this point leaves
  // a clean state.
  await db.checkpoint();
  console.log('[DB] Post-migration checkpoint complete — WAL flushed');

  // ── Periodic WAL checkpoint ───────────────────────────────────────────────
  // Flush the WAL every 5 minutes so a hard kill (Windows console close,
  // power loss, crash) loses at most 5 minutes of writes instead of the
  // entire session. The checkpoint is fast (~1ms for small WALs) and
  // non-blocking for concurrent reads.
  const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
  const checkpointTimer = setInterval(() => {
    db.checkpoint().catch(err =>
      console.warn('[DB] Periodic checkpoint failed (non-fatal):', err)
    );
  }, CHECKPOINT_INTERVAL_MS);
  checkpointTimer.unref(); // don't keep the process alive just for this

  const fastify = await buildServer();

  try {
    await fastify.listen({ port: PORT, host: HOST });
    console.log(`\n🚀  PHOBOS Engine running on http://localhost:${PORT}`);
    console.log(`📦  Database: ${DB_PATH}`);
    console.log(`🧠  Coordinator: http://localhost:16313/v1  (${COORDINATOR_MODEL})`);
    console.log(`⚙️   Reason:      http://localhost:16314/v1  (${ENGINE_MODEL})`);
    console.log(`📖   Memory:      http://localhost:16315/v1  (nomic-embed-text-v1.5.Q4_K_M)\n`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }

  // ── Graceful shutdown ─────────────────────────────────────────────────────
  // CRITICAL: db.close() runs FIRST. The database WAL must be flushed before
  // anything else. LLM servers, Meridian, Polaris, etc. are stateless
  // subprocesses — they can be killed dirty with no data loss. DuckDB cannot.
  //
  // On Windows, closing the console window sends CTRL_CLOSE_EVENT which gives
  // the process ~5 seconds before force-kill. The old shutdown order
  // (stopAllServers → fastify.close → db.close) often timed out before
  // reaching db.close, leaving a corrupt WAL that fails to replay on restart.
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${reason} — shutting down...`);

    // ── PHASE 1: Database (critical — must complete) ──────────────────────
    clearInterval(checkpointTimer);
    try {
      await db.close();
      console.log('[Shutdown] Database closed cleanly');
    } catch (err) {
      console.error('[Shutdown] Database close error:', err);
    }

    // ── PHASE 2: Timers and in-process state (instant) ────────────────────
    scheduler.stop();
    gsm.stop();

    // ── PHASE 3: Subprocesses (can fail without data loss) ────────────────
    await stopBroadway().catch(() => {});
    await stopCamofox().catch(() => {});
    await stopMeridian().catch(() => {});
    await stopPolaris().catch(() => {});
    await stopJellyfin().catch(() => {});
    await stopCarla().catch(() => {});
    await stopAllServers().catch(() => {});
    await fastify.close().catch(() => {});

    process.exit(0);
  };

  // Standard Unix signals
  process.once('SIGINT',  () => shutdown('SIGINT received'));
  process.once('SIGTERM', () => shutdown('SIGTERM received'));

  // Windows: SIGHUP fires when the console window is closed via the X button.
  // This is often the only signal received on Windows before force-kill.
  if (process.platform === 'win32') {
    process.once('SIGHUP', () => shutdown('SIGHUP received (console closed)'));
  }

  // Last resort: if an uncaught exception crashes the process, at least
  // try to close the database so the WAL doesn't corrupt.
  process.once('uncaughtException', async (err) => {
    console.error('[FATAL] Uncaught exception:', err);
    await shutdown('uncaughtException');
  });

  process.once('unhandledRejection', async (reason) => {
    console.error('[FATAL] Unhandled rejection:', reason);
    await shutdown('unhandledRejection');
  });
}

main().catch(err => { console.error('Server failed:', err); process.exit(1); });
