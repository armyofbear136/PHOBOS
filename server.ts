import 'dotenv/config';
import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import os from 'node:os';
import { mkdirSync, existsSync as fsExistsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseManager, userDir, getActiveUser, writeActiveUser } from './db/DatabaseManager.js';
import { getInstanceId } from './db/InstanceConfig.js';
import { runE1Migration, MigrationFatalError } from './db/Migration.js';
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
import { Worker }                  from 'node:worker_threads';
import { fileURLToPath }           from 'node:url';
import { S, SHARED_BUFFER_BYTE_LENGTH } from './coordinator/SharedState.js';
import { CoordinatorBridge }       from './CoordinatorBridge.js';
import type { CoordinatorOutbound, ClientRoleConfig } from './coordinator/MessageTypes.js';
import { ModelConfigStore }        from './db/ModelConfigStore.js';
import { MemoryStore } from './db/MemoryStore.js';
import { reconfigureClients, COORDINATOR_MODEL, ENGINE_MODEL } from './ai/clients.js';
import * as ModelPathStore from './db/ModelPathStore.js';
import { loadRegistry } from './ai/SkillManager.js';
import { registerGameRoutes } from './routes/game.js';
import { GameStore } from './db/GameStore.js';
import { gsm } from './game/GameStateManager.js';
import { registerServiceRoutes } from './routes/services.js';
import { registerHaRoutes } from './routes/ha.js';
import { connectHa } from './services/HAManager.js';
import { initVaultCrypto }      from './vault/VaultCrypto.js';
import { VaultStore }           from './db/VaultStore.js';
import { initVaultManager }     from './vault/VaultManager.js';
import { registerVaultRoutes }  from './routes/vaultRoutes.js';
import { registerUserManagementRoutes, setUserManagementContext } from './routes/userManagement.js';
import { registerAudioRoutes } from './routes/audio.js';
import { shutdownKokoroDaemon } from './phobos/AudioServerManager.js';
import { ServiceStore } from './db/ServiceStore.js';
import { stopMeridian, startMeridian, getMeridianStatus } from './services/MeridianManager.js';
import { stopPolaris, startPolaris, isBinaryPresent as isPolarisBinaryPresent } from './services/PolarisManager.js';
import {
  stopJellyfin,
  startJellyfin,
  isBinaryPresent as isJellyfinBinaryPresent,
} from './services/JellyfinManager.js';
import { registerToolsRoutes } from './routes/toolsRoute.js';
import { registerCartridgeRoutes } from './routes/cartridgeRoutes.js';
import { registerTrainingRoutes }  from './routes/trainingRoutes.js';
import { registerWecloneRoutes }    from './routes/wecloneRoutes.js';
import { CartridgeStore } from './db/CartridgeStore.js';
import { initCartridgeManager, reconcileCartridgeSlots } from './phobos/CartridgeManager.js';
import { startCamofox, stopCamofox, isCamofoxInstalled } from './phobos/CamofoxManager.js';
import { stopStirling, startStirling, isBinaryPresent as isStirlingBinaryPresent } from './services/StirlingManager.js';
import { stopOmniclip, startOmniclip, isBuildPresent as isOmniclipBuildPresent } from './services/OmniclipManager.js';
import { stopBlockbench, startBlockbench, isBuildPresent as isBlockbenchBuildPresent } from './services/BlockbenchManager.js';
import { stopSculptGL,   startSculptGL,   isSculptGLBuildPresent }                    from './services/SculptGLManager.js';
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
import { registerSyncProxyRoutes }      from './routes/syncProxy.js';
import { registerWebRTCRoutes, setWebRTCContext } from './routes/webrtc.js';
import { registerBootEventsRoute } from './routes/bootEvents.js';
import { runDepPrep, isPrepComplete } from './boot/DepPrep.js';
import { setBootPhase, setBootProgress, snapshot as bootSnapshot } from './boot/BootState.js';
import { waitForServicesToSettle } from './boot/waitForServices.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

const PHOBOS_DATA_DIR = process.env.PHOBOS_DATA_DIR ?? path.join(os.homedir(), '.phobos');
mkdirSync(PHOBOS_DATA_DIR, { recursive: true });

const DB_PATH         = process.env.DB_PATH         ?? path.join(PHOBOS_DATA_DIR, 'phobos.duckdb');
// WORKSPACES_ROOT is per-user. The active user defaults to 'owner' (E2 will
// resolve from per-request session). mkdirSync is deferred to main() so the
// E1 migration can rename a pre-existing ~/.phobos/workspaces/ into place
// before this dir gets auto-created empty.
const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? path.join(userDir(getActiveUser()), 'workspaces');

async function buildServer() {
  const fastify = Fastify({
    disableRequestLogging: process.env.PHOBOS_DEBUG !== '1',
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
    // Without this, fastify.close() waits indefinitely for keep-alive connections
    // (SSE streams, polled API clients) to drain on their own.
    forceCloseConnections: true,
  });

  await fastify.register(cors, {
    origin: (origin, cb) => {
      if (
        !origin ||
        origin.startsWith('phobos://') ||
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
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept-Version'],
    exposedHeaders: ['Content-Type'],
  });

  // Stamp CORS headers onto every response, including error/503 responses.
  // @fastify/cors only runs its hook on successful routes; error replies bypass
  // it, leaving the browser with no Access-Control-Allow-Origin and blocking.
  fastify.addHook('onSend', (_req, reply, _payload, done) => {
    const origin = _req.headers.origin;
    if (origin && !reply.hasHeader('access-control-allow-origin')) {
      reply.header('Access-Control-Allow-Origin', origin);
    }
    done();
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
  await registerHaRoutes(fastify);
  await registerVaultRoutes(fastify);
  await registerUserManagementRoutes(fastify);
  await registerAudioRoutes(fastify);
  await registerToolsRoutes(fastify);
  await registerCartridgeRoutes(fastify);
  await registerTrainingRoutes(fastify);
  await registerWecloneRoutes(fastify);
  await registerArchiveRoutes(fastify);
  await registerKavitaIngestRoutes(fastify);
  await registerJellyfinIngestRoutes(fastify);
  await registerPolarisIngestRoutes(fastify);
  await registerMeridianIngestRoutes(fastify);
  await registerSyncProxyRoutes(fastify);
  await registerMpvRoutes(fastify);
  await registerIptvRoutes(fastify);
  await registerWebRTCRoutes(fastify);

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

/**
 * Open a DatabaseManager with retry on Windows file-lock errors.
 * After runE1Migration() the system DB handle release is async at the OS level —
 * the NTFS handle from the migration's DuckDB instances lingers after close()
 * resolves in JS. setTimeout(0) inside the migration does not drain libuv's
 * native I/O thread pool, so the lock can still be active when server.ts opens
 * the same file. Polling here is the correct fix: we detect the lock at the
 * call site where it actually matters instead of hoping a fixed sleep is enough.
 */
async function initializeDbWithRetry(
  db: ReturnType<typeof DatabaseManager.getInstance>,
  label: string,
): Promise<void> {
  const delays = [100, 200, 400, 800, 1600, 3200, 5000, 10000, 15000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000, 30000];
  let lastErr: unknown;
  for (let i = 0; i <= delays.length; i++) {
    try {
      await db.initialize();
      return;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isLock = /being used by another process|sharing violation|EBUSY|EACCES/i.test(msg);
      if (!isLock || i === delays.length) throw err;
      console.warn(`[Boot] ${label} DB locked after migration — retrying in ${delays[i]}ms (attempt ${i + 1}/${delays.length})`);
      await new Promise<void>(resolve => setTimeout(resolve, delays[i]));
    }
  }
  throw lastErr;
}

async function main() {
  process.env.DB_PATH         = DB_PATH;
  process.env.WORKSPACES_ROOT = WORKSPACES_ROOT;

  // ── PHASE 0: E1 multi-user migration ───────────────────────────────────────
  // Detect the pre-E1 single-DB layout. If found, split it:
  //   ~/.phobos/phobos.duckdb → ~/.phobos/phobos.duckdb.pre-e1.backup
  //   build new system DB at ~/.phobos/phobos.duckdb (system tables only)
  //   build new user DB at  ~/.phobos/users/owner/phobos.duckdb (user tables)
  //   move ~/.phobos/conversations.duckdb → users/owner/conversations.duckdb
  //   move ~/.phobos/workspaces/          → users/owner/workspaces/
  //   move ~/.phobos/license.key          → users/owner/license.key
  //   move ~/.phobos/civitai-token.txt    → users/owner/civitai-token.txt
  //   move ~/.phobos/user/skills/         → users/owner/skills/
  //   insert {username:'owner'} row in system DB users table
  //   touch ~/.phobos/.e1-migration-complete
  //
  // Idempotent: returns immediately if .e1-migration-complete exists or the
  // layout is already split. The sentinel is only written on full success.
  //
  // Fatal-on-error: if any required migration step fails, runE1Migration()
  // throws MigrationFatalError. Boot halts, the renamed backup remains intact,
  // and the migration retries from the backup on the next boot. We must not
  // continue to dep-prep or DB init in a half-migrated state — doing so would
  // serve traffic against a partially-populated user DB.
  let migrationReport: Awaited<ReturnType<typeof runE1Migration>>;
  try {
    migrationReport = await runE1Migration();
  } catch (err) {
    if (err instanceof MigrationFatalError) {
      console.error('━'.repeat(72));
      console.error('[Boot] FATAL: E1 migration aborted.');
      console.error(`[Boot]   ${err.message}`);
      const cause = (err as Error & { cause?: unknown }).cause;
      if (cause instanceof Error) {
        console.error(`[Boot]   underlying: ${cause.message}`);
      }
      console.error('[Boot] The backup at ~/.phobos/phobos.duckdb.pre-e1.backup is intact.');
      console.error('[Boot] Migration will retry on next boot. PHOBOS will not start until it succeeds.');
      console.error('━'.repeat(72));
      process.exit(1);
    }
    throw err;
  }
  if (migrationReport.performed) {
    console.log('[Boot] E1 migration complete — multi-user layout active.');
    if (migrationReport.errors.length > 0) {
      // Only soft warnings reach this branch (best-effort lazy-table or
      // system-table copies that failed). Fatal errors throw above.
      console.warn(`[Boot] E1 migration finished with ${migrationReport.errors.length} non-fatal warning(s):`);
      for (const e of migrationReport.errors) console.warn(`  - ${e}`);
    }
  }

  // The owner's workspaces dir must exist before threads are created. After
  // migration, this is users/owner/workspaces/ — either freshly moved from the
  // pre-E1 location or created here on a fresh install.
  mkdirSync(WORKSPACES_ROOT, { recursive: true });

  // ── PHASE 1: Dependency prep ───────────────────────────────────────────────
  // Fastify starts immediately so /api/boot/events is reachable during prep.
  // The frontend subscribes to the SSE stream and shows granular progress.

  if (!isPrepComplete()) {
    console.log('⚙️  [Boot] Phase 1: Dependency prep — downloading missing assets...');
    setBootPhase('prep_deps');

    // Initialize DB before buildServer() — routes call DatabaseManager.getInstance()
    // and ensureTable() at plugin registration time and need a live connection.
    // Both DBs are opened here. The system DB holds shared config (model_config,
    // users master list, cartridges, plugins, services). The user DB holds the
    // active user's threads, messages, prompt logs, workspaces, etc.
    const db = DatabaseManager.getInstance(DB_PATH);
    await initializeDbWithRetry(db, 'system');
    // Ensure the owner user row exists. ON CONFLICT is unreliable in DuckDB 1.4.x
    // across different connection contexts — use WHERE NOT EXISTS instead, which
    // avoids the conflict-resolution binder entirely and works in all versions.
    await db.exec(
      `INSERT INTO users (username, display_name, role)
       SELECT 'owner', 'Owner', 'admin'
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'owner')`,
    );
    const userDb = DatabaseManager.getUserDb();
    await userDb.initialize();

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
  // and ensureTable() at plugin registration time. Both system and user DBs
  // open here; see the Phase 1 path above for split rationale.
  console.log('⚙️  Initializing Phobos Core Systems...');
  setBootPhase('db_init');

  const fastDb = DatabaseManager.getInstance(DB_PATH);
  await initializeDbWithRetry(fastDb, 'system');
  await fastDb.exec(
    `INSERT INTO users (username, display_name, role)
     SELECT 'owner', 'Owner', 'admin'
     WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'owner')`,
  );
  const fastUserDb = DatabaseManager.getUserDb();
  await fastUserDb.initialize();

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
  // The user DB follows the same pattern: idempotent initialize() if missing.
  const db = existingDb ?? DatabaseManager.getInstance(DB_PATH);
  if (!existingDb) await db.initialize();
  const userDb = DatabaseManager.getUserDb();
  if (!existingDb) await userDb.initialize();

  // Instance identity and relay URL — resolved early so route handlers and
  // WebRTC init both read from the same values.
  const webrtcRelayUrl = process.env.WEBRTC_RELAY_URL ?? 'wss://autarch.net/relay';
  const instanceId     = await getInstanceId(db);
  console.log(`[Boot] Instance ID: ${instanceId}`);

  // ── PHASE 3: Core init ─────────────────────────────────────────────────────
  console.log('⚙️  [Boot] Phase 3: Core init...');
  setBootPhase('core_init');

  const memoryStore = new MemoryStore(userDb);
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

  const taskStore = new ScheduledTaskStore(userDb);
  await taskStore.ensureTable();
  const scheduler = initScheduler(userDb);

  const securityStore = new SecurityStore(db);
  await securityStore.ensureTable();
  await securityStore.closeOrphanedRuns();
  registerSecurityHandlers(scheduler, securityStore, PORT);
  await syncScheduledTasks(securityStore, taskStore);

  scheduler.start();

  // HA startup reconnect: if HA was enabled when server last shut down, reconnect.
  connectHa(db).catch(err => {
    console.error('[Server] HA startup connect failed:', err.message);
  });

  // Vault intentionally does NOT auto-unlock on boot. Credentials require
  // explicit user action each session. initVaultManager only loads config
  // (db_path, lock_timeout) — no file is opened, no password is required.
  // vault_config lives in the user DB (USER_SCHEMA) — one vault per user.

  initVaultCrypto();

  const vaultStore = new VaultStore(userDb);
  await initVaultManager(vaultStore);
 

  // ── PHOBOS World game state ─────────────────────────────────────────────────
  const gameStoreInstance = new GameStore(userDb);
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

// ── Omniclip ────────────────────────────────────────────────────────────
  if (isOmniclipBuildPresent()) {
    startOmniclip().catch(err =>
      console.warn('[Omniclip] Auto-start failed (non-fatal):', (err as Error).message)
    );
  }

  // ── Blockbench ──────────────────────────────────────────────────────────
  if (isBlockbenchBuildPresent()) {
    startBlockbench().catch(err =>
      console.warn('[Blockbench] Auto-start failed (non-fatal):', (err as Error).message)
    );
  }

  // ── SculptGL ────────────────────────────────────────────────────────────
  if (isSculptGLBuildPresent()) {
    startSculptGL().catch(err =>
      console.warn('[SculptGL] Auto-start failed (non-fatal):', (err as Error).message)
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
    const correctDefaultPath = path.join(os.homedir(), '.phobos', 'media', 'meridian', 'phobosPhotos');
    if (!merRecord.libraryPath || merRecord.libraryPath.endsWith('phobosPictures') || merRecord.libraryPath.endsWith('photos')) {
      // Migrate from old incorrect default path to the correct one
      mkdirSync(correctDefaultPath, { recursive: true });
      await serviceStore.setLibraryPath('meridian', correctDefaultPath);
      merRecord = await serviceStore.get('meridian');
      console.log('[MediaHub] Meridian: set library path:', correctDefaultPath);
    }
    startMeridian({
      libraryPath:  merRecord.libraryPath!,
      idleEnabled:  Boolean(merRecord.settings.idleClassifier ?? true),
      syncDb:       userDb,
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

  // ── Coordinator worker_thread ──────────────────────────────────────────────
  // Spawn the coordinator BEFORE waitForServicesToSettle so it is up and
  // serving postMessage traffic before we declare 'ready'. Worker spawn is
  // non-blocking; the await below is only for the COORDINATOR_READY message
  // (timeout: 10s).
  //
  // Why worker_threads instead of child_process.fork:
  //   - SharedArrayBuffer cannot be transferred across child_process IPC
  //     (Node serialiser does not implement _getSharedArrayBufferId). Worker
  //     spawn structured-clone honours SAB sharing — both threads see the
  //     same backing memory, which is the entire point of using SAB for
  //     SAYON/SEREN/queue state.
  //   - SEA build constraint dissolves: Worker accepts a path to a sibling
  //     .cjs file directly via the normal Node module loader, regardless of
  //     whether the host process is a SEA binary.
  const sharedBuffer = new SharedArrayBuffer(SHARED_BUFFER_BYTE_LENGTH);
  const sharedState  = new Int32Array(sharedBuffer);

  // Expose on globalThis so routes/status.ts can read SAYON/SEREN state via
  // Atomics.load without creating a circular import (server → routes → server).
  (globalThis as Record<string, unknown>).__phobosSharedState = sharedState;

  // Seed FASTIFY_HEARTBEAT so the coordinator can detect a hung main thread.
  Atomics.store(sharedState, S.FASTIFY_HEARTBEAT, Math.floor(Date.now() / 1000));

  // Resolve coordinator entry point: dist/coordinator.cjs sibling to the SEA
  // binary in production, or coordinator/coordinator.js (resolved from .ts via
  // tsx) in dev.
  const _dirname_server: string = (() => {
    try {
      if (typeof import.meta?.url === 'string') return path.dirname(fileURLToPath(import.meta.url));
    } catch { /* CJS bundle */ }
    return typeof __dirname === 'string' ? __dirname : process.cwd();
  })();

  const coordinatorPath = (() => {
    const seaPath = path.join(path.dirname(process.execPath), 'coordinator.cjs');
    if (fsExistsSync(seaPath)) return seaPath;
    return path.join(_dirname_server, 'coordinator', 'coordinator.js');
  })();

  // Read INIT_CONFIG values once before the first spawn — these are the
  // DB-bound values the coordinator needs but cannot read itself. Pushed
  // again after every successful (re)spawn so respawned workers inherit
  // current state without ever opening DuckDB.
  const buildInitConfig = async (): Promise<{
    coordinator:     ClientRoleConfig;
    engine:          ClientRoleConfig;
    executorEnabled: boolean;
  }> => {
    const cfgStore = new ModelConfigStore(db);
    const { coordinator, engine } = await cfgStore.getAll();
    const executorEnabled = await ModelPathStore.getSandboxExecutorEnabled(db);
    return {
      coordinator: {
        provider:    coordinator.provider,
        model:       coordinator.model,
        endpoint:    coordinator.endpoint,
        apiKey:      coordinator.apiKey ?? null,
        deviceIndex: coordinator.deviceIndex ?? null,
        gpuBackend:  coordinator.gpuBackend  ?? null,
        gpuLayers:   coordinator.gpuLayers   ?? null,
      },
      engine: {
        provider:    engine.provider,
        model:       engine.model,
        endpoint:    engine.endpoint,
        apiKey:      engine.apiKey ?? null,
        deviceIndex: engine.deviceIndex ?? null,
        gpuBackend:  engine.gpuBackend  ?? null,
        gpuLayers:   engine.gpuLayers   ?? null,
      },
      executorEnabled,
    };
  };

  const spawnCoordinator = (): Worker => new Worker(coordinatorPath, {
    workerData: { sharedBuffer },
    // stdout/stderr inherit parent — log lines appear in the same console.
    stdout: false,
    stderr: false,
  });

  // ── Main-thread handlers for round-trip requests from the worker ─────────
  // The worker has no DB access. These three callbacks satisfy the requests
  // it postMessages back: archive search, workspace memory search, and code
  // audit. Each round-trip is correlated by requestId.
  const handleArchiveSearchRequest = async (
    worker: Worker,
    msg: Extract<CoordinatorOutbound, { type: 'ARCHIVE_SEARCH_REQUEST' }>,
  ): Promise<void> => {
    try {
      const { search: archiveSearch } = await import('./ai/ArchiveClient.js');
      const result = await archiveSearch({
        query:   msg.query,
        domains: msg.domains,
        k:       msg.k,
      });
      worker.postMessage({ type: 'ARCHIVE_SEARCH_REPLY', requestId: msg.requestId, result });
    } catch (err) {
      worker.postMessage({
        type: 'ARCHIVE_SEARCH_REPLY',
        requestId: msg.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleMemorySearchRequest = async (
    worker: Worker,
    msg: Extract<CoordinatorOutbound, { type: 'MEMORY_SEARCH_REQUEST' }>,
  ): Promise<void> => {
    try {
      const { retrieveWorkspaceMemory } = await import('./ai/MemoryWriter.js');
      const result = await retrieveWorkspaceMemory(msg.query);
      worker.postMessage({ type: 'MEMORY_SEARCH_REPLY', requestId: msg.requestId, result });
    } catch (err) {
      worker.postMessage({
        type: 'MEMORY_SEARCH_REPLY',
        requestId: msg.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleCodeAuditRequest = async (
    worker: Worker,
    msg: Extract<CoordinatorOutbound, { type: 'CODE_AUDIT_REQUEST' }>,
  ): Promise<void> => {
    try {
      const { SecurityStore } = await import('./db/SecurityStore.js');
      const { runCodeAudit }  = await import('./security/CodeAuditor.js');
      const nodePath          = await import('node:path');

      const projectRoot = process.cwd(); // worker passes absolute paths when possible
      const absTarget   = nodePath.isAbsolute(msg.target)
        ? msg.target
        : nodePath.join(projectRoot, msg.target);

      const secStore = new SecurityStore(db);
      await secStore.ensureTable();
      const run = await secStore.createRun('code_audit');

      await runCodeAudit(secStore, run.id, absTarget);

      const completed  = await secStore.getRunById(run.id);
      const findings   = await secStore.getFindingsByRun(run.id);
      const durationMs = Date.now() - (completed ? Date.parse(completed.started_at) : Date.now());

      const findingPreview = findings.length > 0
        ? findings[0].title.slice(0, 120)
        : 'No issues found';

      let output: string;
      if (findings.length === 0) {
        output = `[CODE AUDIT CLEAN -- ${msg.target}]\nNo security issues detected.`;
      } else {
        const bySeverity: Record<string, typeof findings> = {};
        for (const f of findings) (bySeverity[f.severity] ??= []).push(f);
        const lines: string[] = [
          `[CODE AUDIT -- ${findings.length} finding${findings.length !== 1 ? 's' : ''} in ${msg.target}]`,
          '',
        ];
        for (const sev of ['critical', 'high', 'medium', 'low', 'info'] as const) {
          const group = bySeverity[sev];
          if (!group?.length) continue;
          lines.push(`${sev.toUpperCase()} (${group.length}):`);
          for (const f of group) {
            lines.push(`  [${f.target ?? msg.target}] ${f.title}`);
            if (f.detail) lines.push(`    ${f.detail}`);
          }
          lines.push('');
        }
        if (completed?.seren_digest) lines.push('ANALYSIS:', completed.seren_digest);
        output = lines.join('\n');
      }

      worker.postMessage({
        type: 'CODE_AUDIT_REPLY',
        requestId: msg.requestId,
        result: {
          output,
          exitCode:      findings.length > 0 ? 1 : 0,
          durationMs,
          stdoutPreview: findingPreview,
          findingsCount: findings.length,
        },
      });
    } catch (err) {
      worker.postMessage({
        type: 'CODE_AUDIT_REPLY',
        requestId: msg.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handlePromptLog = async (
    msg: Extract<CoordinatorOutbound, { type: 'PROMPT_LOG' }>,
  ): Promise<void> => {
    try {
      const { PromptLogStore } = await import('./db/PromptLogStore.js');
      const store = new PromptLogStore(userDb);
      await store.insert({
        threadId:  msg.threadId,
        messageId: msg.messageId,
        role:      msg.role,
        stage:     msg.stage as never,
        model:     msg.model,
        prompt:    msg.prompt,
        response:  msg.response,
        latencyMs: msg.latencyMs,
      });
    } catch (err) {
      console.warn('[promptLog] write failed:', err instanceof Error ? err.message : err);
    }
  };

  // ── Central message dispatcher ───────────────────────────────────────────
  // Receives every postMessage from the coordinator. Round-trip requests and
  // PROMPT_LOG are handled inline; per-task lifecycle messages delegate to
  // the bridge's per-taskId handler registry.
  const dispatchCoordinatorMessage = (msg: CoordinatorOutbound): void => {
    switch (msg.type) {
      case 'PROMPT_LOG':
        handlePromptLog(msg).catch(() => {});
        break;
      case 'ARCHIVE_SEARCH_REQUEST':
        handleArchiveSearchRequest(coordinatorWorker, msg).catch(() => {});
        break;
      case 'MEMORY_SEARCH_REQUEST':
        handleMemorySearchRequest(coordinatorWorker, msg).catch(() => {});
        break;
      case 'CODE_AUDIT_REQUEST':
        handleCodeAuditRequest(coordinatorWorker, msg).catch(() => {});
        break;
      case 'COORDINATOR_READY':
        // Initial handshake handled by coordinatorReady promise below.
        break;
      default:
        // Per-task lifecycle / streaming events — delegate to the bridge.
        CoordinatorBridge.dispatchOutbound(msg);
        break;
    }
  };

  let coordinatorWorker = spawnCoordinator();

  // Wire dispatch + give the bridge a reference so enqueue() can postMessage.
  coordinatorWorker.on('message', dispatchCoordinatorMessage);
  CoordinatorBridge.setWorker(coordinatorWorker);

  // Wait for COORDINATOR_READY (10s timeout — Worker spawn is normally <100ms).
  const coordinatorReady = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      console.warn('[Boot] Coordinator did not send READY within 10s — continuing anyway');
      resolve();
    }, 10_000);
    coordinatorWorker.once('message', (msg: CoordinatorOutbound) => {
      if (msg && msg.type === 'COORDINATOR_READY') {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  // Crash recovery — re-spawn on non-zero exit, re-attach all listeners,
  // re-push INIT_CONFIG (workerData already provides the SAB).
  const onCoordinatorExit = (code: number): void => {
    if (code === 0) return; // clean shutdown
    console.warn(`[Coordinator] Worker exited code=${code} — respawning in 2s`);
    setTimeout(() => {
      coordinatorWorker = spawnCoordinator();
      coordinatorWorker.on('message', dispatchCoordinatorMessage);
      coordinatorWorker.on('exit', onCoordinatorExit);
      CoordinatorBridge.setWorker(coordinatorWorker);
      coordinatorWorker.once('message', (msg: CoordinatorOutbound) => {
        if (msg && msg.type === 'COORDINATOR_READY') {
          console.log('[Coordinator] Respawned and ready');
          buildInitConfig()
            .then(payload => coordinatorWorker.postMessage({ type: 'INIT_CONFIG', payload }))
            .catch(err => console.warn('[Coordinator] Respawn INIT_CONFIG failed:', err));
        }
      });
    }, 2_000);
  };
  coordinatorWorker.on('exit', onCoordinatorExit);
  coordinatorWorker.on('error', (err) => {
    console.error('[Coordinator] Worker error:', err instanceof Error ? err.message : err);
  });

  await coordinatorReady;

  // Push INIT_CONFIG immediately after READY so the worker's clients.ts has
  // valid OpenAI handles + executor flag before the first ENQUEUE arrives.
  try {
    const initPayload = await buildInitConfig();
    coordinatorWorker.postMessage({ type: 'INIT_CONFIG', payload: initPayload });
  } catch (err) {
    console.warn('[Boot] INIT_CONFIG send failed:', err instanceof Error ? err.message : err);
  }

  // Keep FASTIFY_HEARTBEAT alive every 5s so the coordinator can detect a
  // hung main thread.
  const fastifyHeartbeatTimer = setInterval(() => {
    Atomics.store(sharedState, S.FASTIFY_HEARTBEAT, Math.floor(Date.now() / 1000));
  }, 5_000);
  fastifyHeartbeatTimer.unref();

  // ── WebRTC signaling ───────────────────────────────────────────────────────
  // Non-fatal: if autarch.net is unreachable the relay client reconnects in
  // the background. The access code routes return null until it connects.
  let webrtcSignalingClient: import('./webrtc/SignalingClient.js').SignalingClient | null = null;
  let webrtcServer: import('./webrtc/WebRTCServer.js').WebRTCServer | null = null;
  if (!webrtcRelayUrl) {
    console.log('[WebRTC] WEBRTC_RELAY_URL is empty — relay disabled');
  }
  if (webrtcRelayUrl) try {
    const { SignalingClient } = await import('./webrtc/SignalingClient.js');
    const { WebRTCServer }    = await import('./webrtc/WebRTCServer.js');

    webrtcSignalingClient = new SignalingClient({
      relayUrl:   webrtcRelayUrl,
      instanceId,
      activeUser: 'owner',
      onCode:     (code, _ice) => console.log(`[WebRTC] Registered with relay: ${code}`),
      onOffer:    (offer)      => webrtcServer?.handleOffer(offer),
      onIce:      (ice)        => webrtcServer?.addIceCandidate(ice),
      onRelayConnect:    () => console.log('[WebRTC] Relay connected'),
      onRelayDisconnect: () => console.warn('[WebRTC] Relay disconnected'),
    });

    webrtcServer = new WebRTCServer({
      fastify,
      signalingClient: webrtcSignalingClient,
      systemDb:        db,
      instanceId,
      relayUrl:        webrtcRelayUrl,
      onConnected:     () => console.log('[WebRTC] Mobile session connected'),
      onDisconnected:  () => console.log('[WebRTC] Mobile session disconnected'),
    });

    setWebRTCContext({ signalingClient: webrtcSignalingClient, webrtcServer });
    webrtcSignalingClient.connect();
  } catch (err) {
    console.warn('[WebRTC] Failed to initialize (non-fatal):', (err as Error).message);
  }

  // Inject context-dependent values into the user management routes now that
  // db, instanceId, and relayUrl are all resolved.
  setUserManagementContext(db, instanceId, webrtcRelayUrl);

  // ── PHASE 4: Services wait → Ready ────────────────────────────────────────
  // All service start() calls above are fire-and-forgot. Give them up to 5
  // minutes to come online. The frontend holds the splash screen open and shows
  // a live per-service checklist. When every tracked service has settled (or the
  // deadline passes), we advance to 'ready', which triggers a full page reload —
  // ensuring sprites and proxied routes load against a fully warm server.
  await waitForServicesToSettle();
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

    clearInterval(fastifyHeartbeatTimer);
    await stopCamofox().catch(() => {});
    await stopStirling().catch(() => {});
    webrtcSignalingClient?.destroy();
    webrtcServer?.disconnect();
    await stopOmniclip().catch(() => {});
    await stopBlockbench().catch(() => {});
    await stopSculptGL().catch(() => {});
    await stopMeridian().catch(() => {});
    await stopPolaris().catch(() => {});
    await stopJellyfin().catch(() => {});
    await stopKavita().catch(() => {});
    await stopMpv().catch(() => {});
    // Main thread always owns llama-server processes — coordinator is now an
    // in-process worker_thread and shares lifecycle with main.
    await stopAllServers().catch(() => {});
    await coordinatorWorker.terminate().catch(() => {});
    shutdownKokoroDaemon();
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