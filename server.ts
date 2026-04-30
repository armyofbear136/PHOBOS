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
import { registerSecurityRoutes } from './routes/securityRoutes.js';
import { SecurityStore }          from './db/SecurityStore.js';
import { syncScheduledTasks, registerSecurityHandlers } from './security/SecurityScanManager.js';
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
import { stopStirling, startStirling, isBinaryPresent as isStirlingBinaryPresent } from './services/StirlingManager.js';
import { ArchiveStore } from './db/ArchiveStore.js';
import { registerArchiveRoutes } from './routes/archiveRoutes.js';
import { registerMpvRoutes } from './routes/mpv.js';
import { stopMpv } from './services/MpvManager.js'
import { registerIptvRoutes } from './routes/iptv.js';
import {
  startKavita,
  stopKavita,
  isBinaryPresent as isKavitaBinaryPresent,
  defaultDocsPath,
} from './services/KavitaManager.js';
import { registerKavitaIngestRoutes } from './routes/kavitaIngestRoutes.js';
import { registerJellyfinIngestRoutes } from './routes/jellyfinIngestRoutes.js';
import { registerPolarisIngestRoutes } from './routes/polarisIngestRoutes.js';
import { registerMeridianIngestRoutes } from './routes/meridianIngestRoutes.js';
import { registerBootEventsRoute } from './routes/bootEvents.js';
import { runDepPrep, isPrepComplete } from './boot/DepPrep.js';
import { setBootPhase, setBootProgress, snapshot as bootSnapshot } from './boot/BootState.js';

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
  await registerBootEventsRoute(fastify);
  await fastify.register(phobosLocalRoute);
  await fastify.register(exportRoute);
  await fastify.register(workflowsRoute);
  await fastify.register(projectsRoute);
  await registerLicenseRoutes(fastify);
  await registerCopilotRoutes(fastify);
  await registerPluginRoutes(fastify);
  await registerUserSkillRoutes(fastify);
  await registerSchedulerRoutes(fastify);
  await registerSecurityRoutes(fastify);
  await registerGameRoutes(fastify);
  await registerServiceRoutes(fastify);
  await registerAudioRoutes(fastify);
  await registerToolsRoutes(fastify);
  await registerCartridgeRoutes(fastify);
  await registerArchiveRoutes(fastify);
  await registerKavitaIngestRoutes(fastify);
  await registerJellyfinIngestRoutes(fastify);
  await registerPolarisIngestRoutes(fastify);
  await registerMeridianIngestRoutes(fastify);
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

  // ── PHASE 1: Dependency prep ───────────────────────────────────────────────
  // Fastify starts immediately so /api/boot/events is reachable during prep.
  // The frontend subscribes to the SSE stream and shows granular progress.

  if (!isPrepComplete()) {
    console.log('⚙️  [Boot] Phase 1: Dependency prep — downloading missing assets...');
    setBootPhase('prep_deps');

    // Initialize DB before buildServer() — routes call DatabaseManager.getInstance()
    // and ensureTable() at plugin registration time and need a live connection.
    const db = DatabaseManager.getInstance(DB_PATH);
    await db.initialize();

    const fastify = await buildServer();
    try {
      await fastify.listen({ port: PORT, host: HOST });
      console.log(`[Boot] HTTP listening on :${PORT} — boot events active`);
    } catch (err) {
      fastify.log.error(err);
      process.exit(1);
    }

    await runDepPrep((evt) => {
      switch (evt.phase) {
        case 'prep_start':
          setBootProgress({ depsTotal: evt.depsTotal, depsDone: 0 });
          break;
        case 'dep_start':
        case 'dep_progress':
          setBootProgress({
            dep: evt.dep, file: evt.file,
            bytes: evt.bytes, total: evt.total, pct: evt.pct,
            depsTotal: evt.depsTotal, depsDone: evt.depsDone,
          });
          break;
        case 'dep_done':
        case 'dep_skip':
          setBootProgress({ dep: evt.dep, depsDone: evt.depsDone, depsTotal: evt.depsTotal });
          break;
        case 'dep_error':
          console.error(`[DepPrep] Non-fatal error on ${evt.dep}: ${evt.error}`);
          break;
        case 'extract_start':
          setBootProgress({ dep: evt.dep, file: evt.file });
          break;
      }
    });

    console.log('✅  [Boot] Phase 1 complete — all dependencies ready.');
    await continueBootSequence(fastify, db);
    return;
  }

  // Fast-path: prep already done on a previous boot.
  // DB must be initialized before buildServer() — routes call DatabaseManager.getInstance()
  // and ensureTable() at plugin registration time.
  console.log('⚙️  Initializing Phobos Core Systems...');
  setBootPhase('db_init');

  const fastDb = DatabaseManager.getInstance(DB_PATH);
  await fastDb.initialize();

  const fastify = await buildServer();
  try {
    await fastify.listen({ port: PORT, host: HOST });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }

  await continueBootSequence(fastify, fastDb);
}

// ── continueBootSequence ───────────────────────────────────────────────────────
// Phases 2–4 run whether or not we went through dep prep.
// Fastify is already listening when this is called.

async function continueBootSequence(
  fastify: Awaited<ReturnType<typeof buildServer>>,
  existingDb: ReturnType<typeof DatabaseManager.getInstance> | null,
) {
  // ── PHASE 2: Database ──────────────────────────────────────────────────────
  console.log('⚙️  [Boot] Phase 2: Database init...');
  setBootPhase('db_init');

  // existingDb is passed when we already called initialize() before buildServer()
  // (the dep-prep path). On the fast-path it is null and we initialize here.
  const db = existingDb ?? DatabaseManager.getInstance(DB_PATH);
  if (!existingDb) await db.initialize();

  // ── PHASE 3: Core init ─────────────────────────────────────────────────────
  console.log('⚙️  [Boot] Phase 3: Core init...');
  setBootPhase('core_init');

  // GIMP / Broadway — boot with PHOBOS, stay alive perpetually.
  startBroadway().catch(err => console.warn('[Broadway] Startup error (non-fatal):', (err as Error).message));

  const memoryStore = new MemoryStore(db);
  await memoryStore.ensureTable();

  await ModelPathStore.loadAsync(db);
  await reconfigureClients();

  // ── SYBIL ──────────────────────────────────────────────────────────────────
  const archiveHasContent = ArchiveStore.hasAnyContent();

  if (archiveHasContent) {
    try {
      await startSybil();
    } catch (err) {
      console.error('[PHOBOS] Archive content exists but SYBIL failed to start:', err);
      console.error('[PHOBOS] Archive search will be disabled until SYBIL is running.');
      process.env.ARCHIVE_SYBIL_FAILED = '1';
    }
  } else {
    startSybil().catch(err => console.warn('[SYBIL] Startup error (non-fatal):', err));
  }

  await loadRegistry();
  await scanUserSkills();

  const taskStore = new ScheduledTaskStore(db);
  await taskStore.ensureTable();
  const scheduler = initScheduler(db);

  const securityStore = new SecurityStore(db);
  await securityStore.ensureTable();
  await securityStore.closeOrphanedRuns();
  registerSecurityHandlers(scheduler, securityStore, PORT);
  await syncScheduledTasks(securityStore, taskStore);

  scheduler.start();

  // ── PHOBOS World game state ─────────────────────────────────────────────────
  const gameStoreInstance = new GameStore(db);
  await gameStoreInstance.ensureTable();
  gsm.start();

  // ── LLM Cartridge Library ───────────────────────────────────────────────────
  const cartridgeStore = new CartridgeStore(db);
  await cartridgeStore.ensureTable();
  initCartridgeManager(cartridgeStore);
  await reconcileCartridgeSlots();

  // ── Camofox Web Browser ─────────────────────────────────────────────────────
  if (isCamofoxInstalled()) {
    startCamofox().catch(err =>
      console.warn('[Camofox] Auto-start failed (non-fatal):', (err as Error).message)
    );
  } else {
    console.warn('[Camofox] camofox-browser not found in node_modules — run: npm install');
  }

  // ── Stirling PDF ────────────────────────────────────────────────────────────
  if (isStirlingBinaryPresent()) {
    startStirling().catch(err =>
      console.warn('[Stirling] Auto-start failed (non-fatal):', (err as Error).message)
    );
  }

  // ── Media Hub ───────────────────────────────────────────────────────────────
  const serviceStore = new ServiceStore(db);
  await serviceStore.ensureTable();

  // Meridian — always starts (first-party, no binary gate)
  {
    let merRecord = await serviceStore.get('meridian');
    if (!merRecord.enabled) {
      await serviceStore.setEnabled('meridian', true);
      merRecord = await serviceStore.get('meridian');
    }
    if (!merRecord.libraryPath) {
      const defaultPath = path.join(os.homedir(), '.phobos', 'media', 'meridian', 'phobosPictures');
      mkdirSync(defaultPath, { recursive: true });
      await serviceStore.setLibraryPath('meridian', defaultPath);
      merRecord = await serviceStore.get('meridian');
      console.log('[MediaHub] Meridian: seeded default library path:', defaultPath);
    }
    startMeridian({
      libraryPath:  merRecord.libraryPath!,
      idleEnabled:  Boolean(merRecord.settings.idleClassifier ?? true),
    }).catch(err => console.warn('[MediaHub] Meridian auto-start failed:', err.message));
  }

  // Polaris — starts if binary is present
  if (isPolarisBinaryPresent()) {
    let polarisRecord = await serviceStore.get('polaris');
    if (!polarisRecord.enabled) {
      await serviceStore.setEnabled('polaris', true);
      polarisRecord = await serviceStore.get('polaris');
    }
    if (!polarisRecord.libraryPath) {
      const defaultPath = path.join(os.homedir(), '.phobos', 'media', 'polaris', 'phobosMusic');
      mkdirSync(defaultPath, { recursive: true });
      await serviceStore.setLibraryPath('polaris', defaultPath);
      polarisRecord = await serviceStore.get('polaris');
      console.log('[MediaHub] Polaris: seeded default library path:', defaultPath);
    }
    startPolaris({
      adminPassword: polarisRecord.settings.adminPassword as string,
      libraryPath:   polarisRecord.libraryPath!,
      mountName:     (polarisRecord.settings.mountName as string) || 'Music',
    }).catch(err => console.warn('[MediaHub] Polaris auto-start failed:', err.message));
  }

  // Jellyfin — starts if binary is present
  if (isJellyfinBinaryPresent()) {
    let jellyfinRecord = await serviceStore.get('jellyfin');
    if (!jellyfinRecord.enabled) {
      await serviceStore.setEnabled('jellyfin', true);
      jellyfinRecord = await serviceStore.get('jellyfin');
    }
    let adminPassword = (jellyfinRecord.settings.adminPassword as string) || '';
    if (!adminPassword) {
      const { randomBytes } = await import('node:crypto');
      adminPassword = randomBytes(24).toString('base64url');
      jellyfinRecord = await serviceStore.patchSettings('jellyfin', { adminPassword });
      console.log('[MediaHub] Generated missing Jellyfin adminPassword and persisted to DB.');
    }
    if (!jellyfinRecord.libraryPath) {
      const defaultPath = path.join(os.homedir(), '.phobos', 'media', 'jellyfin', 'phobosVideos');
      mkdirSync(defaultPath, { recursive: true });
      await serviceStore.setLibraryPath('jellyfin', defaultPath);
      jellyfinRecord = await serviceStore.get('jellyfin');
      console.log('[MediaHub] Jellyfin: seeded default library path:', defaultPath);
    }
    startJellyfin(
      {
        libraryPath:   jellyfinRecord.libraryPath,
        hardwareAccel: (jellyfinRecord.settings.hardwareAccel as string) || '',
      },
      adminPassword,
    ).catch(err => console.warn('[MediaHub] Jellyfin auto-start failed:', err.message));
  }

  // Kavita — starts if binary is present
  if (isKavitaBinaryPresent()) {
    let kavitaRecord = await serviceStore.get('kavita');
    let tokenKey      = (kavitaRecord.settings.tokenKey      as string) || '';
    let adminPassword = (kavitaRecord.settings.adminPassword as string) || '';
    if (!tokenKey || !adminPassword) {
      const { randomBytes } = await import('node:crypto');
      const patch: Record<string, string> = {};
      if (!tokenKey)      patch.tokenKey      = randomBytes(256).toString('base64');
      if (!adminPassword) patch.adminPassword = randomBytes(24).toString('base64url');
      kavitaRecord  = await serviceStore.patchSettings('kavita', patch);
      tokenKey      = kavitaRecord.settings.tokenKey      as string;
      adminPassword = kavitaRecord.settings.adminPassword as string;
      console.log('[KavitaManager] Generated missing credentials — first boot.');
    }
    const authKey  = (kavitaRecord.settings.refreshToken as string) || '';
    const docsPath = kavitaRecord.libraryPath ?? defaultDocsPath();
    const firstBoot = !authKey;
    startKavita({ tokenKey, adminPassword, refreshToken: authKey, docsPath, firstBoot })
      .then(async ({ refreshToken: newToken }) => {
        if (newToken !== authKey) await serviceStore.patchSettings('kavita', { refreshToken: newToken });
        if (!kavitaRecord.libraryPath) await serviceStore.setLibraryPath('kavita', docsPath);
      })
      .catch(async (err: Error) => {
        console.warn('[MediaHub] Kavita auto-start failed:', err.message);
        await serviceStore.patchSettings('kavita', { refreshToken: '' }).catch(() => {});
      });
  } else {
    console.log('[KavitaManager] Binary not present — will install on next boot via DepPrep.');
  }

  // ── Flush WAL after all migrations ─────────────────────────────────────────
  await db.checkpoint();
  console.log('[DB] Post-migration checkpoint complete — WAL flushed');

  const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
  const checkpointTimer = setInterval(() => {
    db.checkpoint().catch((err: unknown) =>
      console.warn('[DB] Periodic checkpoint failed (non-fatal):', err)
    );
  }, CHECKPOINT_INTERVAL_MS);
  checkpointTimer.unref();

  // ── PHASE 4: Ready ─────────────────────────────────────────────────────────
  // Signal the frontend — it will do a full page reload to enter PHOBOS.
  setBootPhase('ready');

  console.log(`\n🚀  PHOBOS Engine running on http://localhost:${PORT}`);
  console.log(`📦  Database: ${DB_PATH}`);
  console.log(`🧠  Coordinator: http://localhost:16313/v1  (${COORDINATOR_MODEL})`);
  console.log(`⚙️   Reason:      http://localhost:16314/v1  (${ENGINE_MODEL})`);
  console.log(`📖   Memory:      http://localhost:16315/v1  (nomic-embed-text-v1.5.Q4_K_M)\n`);

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${reason} — shutting down...`);

    clearInterval(checkpointTimer);
    try {
      await db.close();
      console.log('[Shutdown] Database closed cleanly');
    } catch (err) {
      console.error('[Shutdown] Database close error:', err);
    }

    scheduler.stop();
    gsm.stop();

    await stopBroadway().catch(() => {});
    await stopCamofox().catch(() => {});
    await stopStirling().catch(() => {});
    await stopMeridian().catch(() => {});
    await stopPolaris().catch(() => {});
    await stopJellyfin().catch(() => {});
    await stopKavita().catch(() => {});
    await stopMpv().catch(() => {});
    await stopCarla().catch(() => {});
    await stopAllServers().catch(() => {});
    await fastify.close().catch(() => {});

    process.exit(0);
  };

  process.once('SIGINT',  () => shutdown('SIGINT received'));
  process.once('SIGTERM', () => shutdown('SIGTERM received'));

  if (process.platform === 'win32') {
    process.once('SIGHUP', () => shutdown('SIGHUP received (console closed)'));
  }

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