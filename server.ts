import 'dotenv/config';
import Fastify, { type FastifyError } from 'fastify';

// ── Per-request user identity ─────────────────────────────────────────────────
// DataChannelHandler stamps x-webrtc-user on every fastify.inject() call.
// The hook below promotes it to req.phobosUser so all route handlers have a
// single typed field to read — no header parsing scattered across route files.
declare module 'fastify' {
  interface FastifyRequest {
    phobosUser: string;
    phobosRole: string;
  }
}
import cors from '@fastify/cors';
import os from 'node:os';
import { mkdirSync, existsSync as fsExistsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
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
import { initWecloneSlotManager } from './phobos/WecloneSlotManager.js';
import { Worker }                  from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
import { registerSocialRoutes, setSocialContext, setSocialSignalingClient } from './routes/social.js';
import { registerAudioRoutes } from './routes/audio.js';
import { shutdownKokoroDaemon, shutdownAllVcDaemons, shutdownSupertonicDaemon, preWarmKokoro, preWarmVcDaemons, preWarmSupertonic } from './phobos/AudioServerManager.js';
import { ServiceStore } from './db/ServiceStore.js';
import { stopMeridian, startMeridian, getMeridianStatus, setMeridianSignalingClient, repairAllUserLibraries as repairMeridianUserLibraries } from './services/MeridianManager.js';
import { stopPolaris, startPolaris, isBinaryPresent as isPolarisBinaryPresent } from './services/PolarisManager.js';
import {
  stopJellyfin,
  startJellyfin,
  isBinaryPresent as isJellyfinBinaryPresent,
  repairAllUserLibraries as repairJellyfinUserLibraries,
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
  repairAllUserLibraries as repairKavitaUserLibraries,
} from './services/KavitaManager.js';
import { registerKavitaIngestRoutes } from './routes/kavitaIngestRoutes.js';
import { registerJellyfinIngestRoutes } from './routes/jellyfinIngestRoutes.js';
import { registerPolarisIngestRoutes } from './routes/polarisIngestRoutes.js';
import { registerMeridianIngestRoutes } from './routes/meridianIngestRoutes.js';
import { registerSyncProxyRoutes }      from './routes/syncProxy.js';
import { registerWebRTCRoutes, setWebRTCContext } from './routes/webrtc.js';
import { registerBootEventsRoute } from './routes/bootEvents.js';
import { UserStore }               from './db/UserStore.js';
import { provisionSystemUser }     from './db/UserProvisioner.js';
import { setBootPhase, setBootProgress, snapshot as bootSnapshot } from './boot/BootState.js';
import { waitForServicesToSettle } from './boot/waitForServices.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

const PHOBOS_DATA_DIR = process.env.PHOBOS_DATA_DIR ?? path.join(os.homedir(), '.phobos');
mkdirSync(PHOBOS_DATA_DIR, { recursive: true });

const DB_PATH = process.env.DB_PATH ?? path.join(PHOBOS_DATA_DIR, 'phobos.duckdb');

// WORKSPACES_ROOT is per-user. Resolved dynamically at call time from
// getActiveUser() so user switching doesn't require a restart.
// Routes read process.env.WORKSPACES_ROOT which is updated on switch.
function getWorkspacesRoot(): string {
  return process.env.WORKSPACES_ROOT ?? path.join(userDir(getActiveUser()), 'workspaces');
}
function applyWorkspacesRoot(): void {
  process.env.WORKSPACES_ROOT = getWorkspacesRoot();
}

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

  // Promote x-webrtc-user and x-webrtc-role headers to typed req fields.
  // Falls back to 'owner' / 'owner' for any request without the headers
  // (e.g. browser direct, health checks, startup init calls).
  fastify.addHook('preHandler', (req, reply, done) => {
    req.phobosUser = (req.headers['x-webrtc-user'] as string | undefined)?.trim() || 'owner';
    req.phobosRole = (req.headers['x-webrtc-role'] as string | undefined)?.trim() || 'owner';

    // ── Role-based access control ──────────────────────────────────────────
    // guest: chat + game only — all other routes return 403.
    // read:  same as guest for writes; may read thread/message data.
    // admin/full/owner: unrestricted.
    const role = req.phobosRole;
    if (role === 'guest' || role === 'read') {
      const url = req.url.split('?')[0];

      const guestAllowedPrefixes = [
        '/api/threads',
        '/api/copilot',
        '/api/status',
        '/api/stats',
        '/api/version',
        '/api/config/models',
        '/api/game',
        '/health',
        '/api/webrtc',
        '/api/social',
      ];

      // read role additionally cannot POST/PATCH/DELETE to message endpoints.
      const allowed = guestAllowedPrefixes.some(p => url === p || url.startsWith(p + '/'));
      if (!allowed) {
        reply.status(403).send({ error: 'Forbidden: insufficient role' });
        return;
      }

      // read role: block all mutations.
      if (role === 'read' && req.method !== 'GET' && req.method !== 'HEAD') {
        reply.status(403).send({ error: 'Forbidden: read-only role' });
        return;
      }
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
  await registerSocialRoutes(fastify);

  // ── First-run setup ────────────────────────────────────────────────────────
  // Registered statically so it's available before listen() is called.
  // The handler rejects requests unless boot phase is 'awaiting_setup' —
  // this prevents it being callable once the server is fully running.
  // continueBootSequence calls setBootPhase('awaiting_setup') then returns;
  // when the form is submitted this route provisions the owner and resumes boot.
  fastify.post<{
    Body: { username: string; displayName?: string };
  }>('/api/setup/init', async (req, reply) => {
    if (bootSnapshot().phase !== 'awaiting_setup') {
      return reply.status(503).send({ error: 'Server is not in setup mode.' });
    }

    const { username, displayName } = req.body ?? {};
    if (!username || typeof username !== 'string' || !/^[a-z0-9_\-]{2,32}$/.test(username)) {
      return reply.status(400).send({ error: 'Username must be 2–32 lowercase alphanumeric characters.' });
    }

    // _setupContext is populated by continueBootSequence before entering the
    // awaiting_setup phase. It holds the db, userStore, webrtcRelayUrl, and
    // instanceId needed to resume boot after the account is created.
    const ctx = _setupContext;
    if (!ctx) {
      return reply.status(500).send({ error: 'Setup context not initialised — this is a bug.' });
    }

    try {
      const result = await provisionSystemUser(username, 'admin', ctx.userStore, displayName ?? username);
      writeActiveUser(username);
      console.log(`[Boot] Owner account '${username}' created. Resuming boot.`);
      if (result.errors.length > 0) {
        console.warn('[Boot] Setup provision warnings:', result.errors);
      }
      setImmediate(() => resumeBootAfterSetup(ctx.fastify, ctx.db, ctx.webrtcRelayUrl, ctx.instanceId));
      return reply.send({ ok: true, username });
    } catch (err) {
      console.error('[Boot] Setup provision failed:', err);
      return reply.status(500).send({ error: String(err) });
    }
  });

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
  process.env.WORKSPACES_ROOT = getWorkspacesRoot();

  // ── WAL cleanup ────────────────────────────────────────────────────────────
  // DuckDB WAL files left by a hard crash cause an internal assertion failure
  // on the next open ("Failure while replaying WAL file"). Wipe them before
  // opening any DB connection. Safe to delete unconditionally: the WAL only
  // contains uncommitted writes from the crashed session; committed data is
  // already in the .duckdb file. Any user DB WALs under users/* are also wiped.
  {
    const walTargets: string[] = [
      DB_PATH + '.wal',
    ];
    // Sweep users/*/phobos.duckdb.wal and users/*/conversations.duckdb.wal
    const usersDir = path.join(PHOBOS_DATA_DIR, 'users');
    try {
      for (const username of readdirSync(usersDir)) {
        const userPath = path.join(usersDir, username);
        if (!statSync(userPath).isDirectory()) continue;
        walTargets.push(
          path.join(userPath, 'phobos.duckdb.wal'),
          path.join(userPath, 'conversations.duckdb.wal'),
        );
      }
    } catch { /* usersDir may not exist yet on first boot */ }
    for (const walPath of walTargets) {
      try {
        unlinkSync(walPath);
        console.log(`[Boot] Removed stale WAL: ${walPath}`);
      } catch { /* not present — fine */ }
    }
  }

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

  // ── PHASE 1: Dependency prep ───────────────────────────────────────────────
  // Fastify starts immediately so /api/boot/events is reachable during prep.
  // The frontend subscribes to the SSE stream and shows granular progress.
  //
  // DepPrep is imported lazily so that tsx/ESM test environments with
  // PHOBOS_SKIP_DEP_PREP=1 never evaluate DepPrep.ts (which uses __dirname,
  // unavailable in raw ESM). The built client compiles to CJS where __dirname
  // is injected by the bundler — no change needed there.

  const _skipDep = process.env.PHOBOS_SKIP_DEP_PREP === '1';
  const _depPrep = _skipDep ? null : await import('./boot/DepPrep.js');

  if (!_skipDep && _depPrep && !_depPrep.isPrepComplete()) {
    console.log('⚙️  [Boot] Phase 1: Dependency prep — downloading missing assets...');
    setBootPhase('prep_deps');

    // Initialize DB before buildServer() — routes call DatabaseManager.getInstance()
    // and ensureTable() at plugin registration time and need a live connection.
    // System DB only — user DB is opened after the first-run gate in
    // resumeBootAfterSetup, once we know the actual owner username.
    const db = DatabaseManager.getInstance(DB_PATH);
    await initializeDbWithRetry(db, 'system');

    const fastify = await buildServer();
    try {
      await fastify.listen({ port: PORT, host: HOST });
      console.log(`[Boot] HTTP listening on :${PORT} — boot events active`);
    } catch (err) {
      fastify.log.error(err);
      process.exit(1);
    }

    await _depPrep.runDepPrep((evt) => {
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
  // System DB only before buildServer() — user DB is opened after the
  // first-run gate in resumeBootAfterSetup, once we know the actual username.
  console.log('⚙️  Initializing Phobos Core Systems...');
  setBootPhase('db_init');

  const fastDb = DatabaseManager.getInstance(DB_PATH);
  await initializeDbWithRetry(fastDb, 'system');

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
  // The user DB is intentionally NOT opened here — it is opened inside
  // resumeBootAfterSetup, after the first-run gate, once we know the actual
  // owner username. Opening it here would create users/owner/ on a fresh
  // install before setup runs.
  const db = existingDb ?? DatabaseManager.getInstance(DB_PATH);
  if (!existingDb) await db.initialize();

  // Instance identity and relay URL — resolved early so route handlers and
  // WebRTC init both read from the same values.
  const webrtcRelayUrl = process.env.WEBRTC_RELAY_URL ?? 'wss://autarch.net/relay';
  const instanceId     = await getInstanceId(db);
  console.log(`[Boot] Instance ID: ${instanceId}`);

  // ── FIRST-RUN GATE ─────────────────────────────────────────────────────────
  // If no users exist, pause boot and wait for the owner account to be created
  // via POST /api/setup/init. That route is registered statically in buildServer()
  // and guards on boot phase 'awaiting_setup'. The SSE stream pushes this phase
  // to the frontend which renders the account creation form inside ConnectionSplash.
  const userStore  = new UserStore(db);
  const userCount  = await db.query<{ n: number }>('SELECT COUNT(*)::INT AS n FROM users');
  const hasUsers   = (userCount[0]?.n ?? 0) > 0;

  if (!hasUsers) {
    console.log('[Boot] No users found — entering first-run setup.');
    // Stash everything the /api/setup/init route handler needs to resume boot.
    // The route is already registered in buildServer() and guards on this phase.
    _setupContext = { fastify, db, userStore, webrtcRelayUrl, instanceId };
    setBootPhase('awaiting_setup');
    // Hold — resumeBootAfterSetup will be called by /api/setup/init.
    return;
  }

  await resumeBootAfterSetup(fastify, db, webrtcRelayUrl, instanceId);
}

// ── In-process user switch ────────────────────────────────────────────────────
// Mutable refs updated by performUserSwitch so the shutdown closure and
// checkpoint timer always close/stop the correct instances.
const _live = {
  scheduler:    null as ReturnType<typeof initScheduler> | null,
  userDb:       null as ReturnType<typeof DatabaseManager.getUserDb> | null,
  checkpointFn: null as (() => void) | null,
};

// Populated by continueBootSequence when entering the awaiting_setup phase.
// Read by the static /api/setup/init route in buildServer().
let _setupContext: {
  fastify:        Awaited<ReturnType<typeof buildServer>>;
  db:             ReturnType<typeof DatabaseManager.getInstance>;
  userStore:      InstanceType<typeof UserStore>;
  webrtcRelayUrl: string;
  instanceId:     string;
} | null = null;

// Called by userManagement POST /api/admin/switch-user instead of process.exit.
export async function performUserSwitch(
  username:      string,
  securityStore: InstanceType<typeof SecurityStore>,
  port:          number,
): Promise<void> {
  console.log(`[UserSwitch] Switching active user to '${username}'...`);

  // 1. Stop the current scheduler — its timer fires against the old userDb.
  _live.scheduler?.stop();

  // 2. Checkpoint and explicitly close the old user DB so its file handle is
  //    released. This is critical on Windows — DuckDB holds an OS lock on the
  //    .duckdb file; without closing, a subsequent deprovision rm() will EBUSY.
  if (_live.userDb) {
    try { await _live.userDb.checkpoint(); } catch { /* best-effort */ }
    try { await _live.userDb.close(); }      catch { /* best-effort */ }
    // Remove from cache so getUserDb creates a fresh instance on next access.
    await DatabaseManager.evictUser(getActiveUser());
  }

  // 3. Write the new active user and update process.env for workspace paths.
  writeActiveUser(username);
  applyWorkspacesRoot();
  mkdirSync(getWorkspacesRoot(), { recursive: true });

  // 4. Open (or retrieve from cache) the new user's DB.
  // getUserDb returns the cached instance — already initialized from provisioning.
  // Call ensureReady() as a safety net in case the instance was evicted between
  // provisioning and the switch (e.g. a failed prior switch evicted it).
  const newUserDb = DatabaseManager.getUserDb(username);
  await newUserDb.ensureReady();

  // 5. Ensure all user-scoped tables exist for this user.
  const newMemoryStore  = new MemoryStore(newUserDb);
  await newMemoryStore.ensureTable();

  const newTaskStore = new ScheduledTaskStore(newUserDb);
  await newTaskStore.ensureTable();

  const newVaultStore = new VaultStore(newUserDb);
  await initVaultManager(newVaultStore);

  const newGameStore = new GameStore(newUserDb);
  await newGameStore.ensureTable();

  // 6. Reinit scheduler against new user DB.
  const newScheduler = initScheduler(newUserDb);
  registerSecurityHandlers(newScheduler, securityStore, port);
  await syncScheduledTasks(securityStore, newTaskStore);
  newScheduler.start();

  // 7. Update live refs so shutdown and checkpoint timer use new instances.
  _live.scheduler = newScheduler;
  _live.userDb    = newUserDb;

  console.log(`[UserSwitch] Active user is now '${username}'.`);
}

// ── resumeBootAfterSetup ───────────────────────────────────────────────────────
// Everything from Phase 3 onward. Called directly on normal boot (users exist),
// or via setImmediate from the setup route after owner account is created.

async function resumeBootAfterSetup(
  fastify:        Awaited<ReturnType<typeof buildServer>>,
  db:             ReturnType<typeof DatabaseManager.getInstance>,
  webrtcRelayUrl: string,
  instanceId:     string,
): Promise<void> {
  console.log('⚙️  [Boot] Phase 3: Core init...');
  setBootPhase('core_init');

  // Open the user DB here — after the first-run gate — so we never create
  // users/owner/ before setup runs on a fresh install. getActiveUser() now
  // returns the real username (written by provisionSystemUser in the setup
  // route, or already present on a returning boot).
  applyWorkspacesRoot();
  mkdirSync(getWorkspacesRoot(), { recursive: true });

  const userDb = DatabaseManager.getUserDb();
  await userDb.initialize();

  // Schema init for stores that were previously eager-initialized in route
  // registration against getUserDb('owner'). Now runs here — post-gate —
  // so a fresh install never touches the user DB before setup completes.
  {
    const { MessageAttachmentStore } = await import('./db/MessageAttachmentStore.js');
    await new MessageAttachmentStore(userDb).ensureTable();
  }
  {
    const { EffectRackStore }  = await import('./db/EffectRackStore.js');
    const { DawProjectStore }  = await import('./db/DawProjectStore.js');
    await new EffectRackStore(userDb).ensureTable();
    await new DawProjectStore(userDb).ensureTable();
  }

  const memoryStore = new MemoryStore(userDb);
  await memoryStore.ensureTable();

  await ModelPathStore.loadAsync(db);
  await reconfigureClients();

  // ── SYBIL ──────────────────────────────────────────────────────────────────
  const allUsers          = await new UserStore(db).list();
  const allUsernames      = allUsers.map((u: { username: string }) => u.username);
  const archiveHasContent = ArchiveStore.hasAnyContent(allUsernames);

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

  // Wire live refs so performUserSwitch and shutdown always use current instances.
  _live.scheduler = scheduler;
  _live.userDb    = userDb;

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

  // ── WeClone Slot State ──────────────────────────────────────────────────────
  // Restores any clone activation that persisted across a server restart.
  await initWecloneSlotManager();

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
    const correctDefaultPath = path.join(os.homedir(), '.phobos', 'media', 'meridian', 'owner', 'phobosPhotos');
    if (!merRecord.libraryPath || merRecord.libraryPath.endsWith('phobosPictures') || merRecord.libraryPath.endsWith('photos') || merRecord.libraryPath === path.join(os.homedir(), '.phobos', 'media', 'meridian', 'phobosPhotos')) {
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
    }).then(() => {
      // Reconcile all PHOBOS users against Meridian on every boot.
      // Creates per-user library rows, scans missing libraries, and starts watchers.
      repairMeridianUserLibraries(allUsernames).catch(err =>
        console.warn('[MediaHub] repairMeridianUserLibraries failed (non-fatal):', err.message),
      );
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
      const defaultPath = path.join(os.homedir(), '.phobos', 'media', 'polaris', 'owner', 'phobosMusic');
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
      const defaultPath = path.join(os.homedir(), '.phobos', 'media', 'jellyfin', 'owner', 'phobosVideos');
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
    ).then(() => {
      // Reconcile all PHOBOS users against Jellyfin on every boot.
      // Re-provisions any user whose account was wiped and creates missing libraries.
      repairJellyfinUserLibraries(allUsernames).catch(err =>
        console.warn('[MediaHub] repairJellyfinUserLibraries failed (non-fatal):', err.message),
      );
    }).catch(err => console.warn('[MediaHub] Jellyfin auto-start failed:', err.message));
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
        // Reconcile all PHOBOS users against Kavita on every boot.
        repairKavitaUserLibraries(allUsernames).catch(err =>
          console.warn('[MediaHub] repairKavitaUserLibraries failed (non-fatal):', err.message),
        );
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
    _live.userDb?.checkpoint().catch((err: unknown) =>
      console.warn('[DB] Periodic user checkpoint failed (non-fatal):', err)
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
    const jsPath = path.join(_dirname_server, 'coordinator', 'coordinator.js');
    if (fsExistsSync(jsPath)) return jsPath;
    // tsx dev: compiled .js doesn't exist — use the .ts source directly.
    return path.join(_dirname_server, 'coordinator', 'coordinator.ts');
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

  // In tsx dev mode the coordinator entry is coordinator.ts. Worker threads do
  // not inherit the parent's module hooks, so TypeScript resolution (.js->.ts)
  // must be bootstrapped inside the worker itself. module.register() via a
  // static .mjs shim is the correct tsx 4.x API; --loader is deprecated in
  // Node v20+ and tsx 4.x throws if it detects --loader in execArgv.
  // In the SEA build coordinatorPath is .cjs and execArgv is empty.
  const _workerBootstrap = pathToFileURL(
    path.join(_dirname_server, 'coordinator-worker-bootstrap.mjs'),
  ).href;

  const spawnCoordinator = (): Worker => new Worker(coordinatorPath, {
    workerData: { sharedBuffer },
    execArgv: coordinatorPath.endsWith('.ts')
      ? ['--import', _workerBootstrap, '--no-warnings']
      : [],
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
        username: msg.username,
        query:    msg.query,
        domains:  msg.domains,
        k:        msg.k,
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
      const result = await retrieveWorkspaceMemory(msg.query, 5, msg.username ?? 'owner');
      worker.postMessage({ type: 'MEMORY_SEARCH_REPLY', requestId: msg.requestId, result,  });
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
  // LocalSignalingServer is always created — it handles LAN connections even
  // when the relay is unreachable. WebRTCServer is always created for the same
  // reason. SignalingClient (relay) is optional: if webrtcRelayUrl is empty or
  // autarch.net is unreachable, LAN-only mode still works.
  const { LocalSignalingServer } = await import('./webrtc/LocalSignalingServer.js');
  const { WebRTCServer }         = await import('./webrtc/WebRTCServer.js');

  const localSignaling = new LocalSignalingServer();

  let webrtcSignalingClient: import('./webrtc/SignalingClient.js').SignalingClient | null = null;
  let webrtcServer: import('./webrtc/WebRTCServer.js').WebRTCServer | null = null;

  if (!webrtcRelayUrl) {
    console.log('[WebRTC] WEBRTC_RELAY_URL is empty — relay disabled, LAN-only mode');
  }

  // WebRTCServer is always instantiated (needed for LAN path even without relay)
  // signalingClient is passed as null when relay is disabled — only the LAN
  // path uses it, which goes through localSignaling instead.
  try {
    if (webrtcRelayUrl) {
      const { SignalingClient } = await import('./webrtc/SignalingClient.js');
      webrtcSignalingClient = new SignalingClient({
        relayUrl:   webrtcRelayUrl,
        instanceId,
        activeUser: 'owner',
        onCode:     (code, _ice) => console.log(`[WebRTC] Registered with relay: ${code}`),
        onOffer:    (offer)      => webrtcServer?.handleOffer(offer),
        onIce:      (ice)        => webrtcServer?.addIceCandidate(ice),
        onRelayConnect: () => {
          console.log('[WebRTC] Relay connected');
          void (async () => {
            try {
              const now  = Date.now();
              const rows = await db.query<{
                id:              string;
                to_instance_id:  string;
                payload:         string;
              }>(
                `SELECT id, to_instance_id, payload
                   FROM pending_outbound_requests
                  WHERE expires_at > ?`,
                [now],
              );
              for (const row of rows) {
                const msg = JSON.parse(row.payload) as import('./webrtc/RemoteProtocol.js').SocialRelayMessage;
                const sent = webrtcSignalingClient!.sendSocialMessage(row.to_instance_id, msg);
                if (sent) {
                  await db.run(`DELETE FROM pending_outbound_requests WHERE id = ?`, [row.id]);
                } else {
                  await db.run(
                    `UPDATE pending_outbound_requests
                        SET retry_count = retry_count + 1, last_attempt_at = ?
                      WHERE id = ?`,
                    [now, row.id],
                  );
                }
              }
            } catch (err) {
              console.error('[WebRTC] Relay connect flush error:', (err as Error).message);
            }
          })();
        },
        onRelayDisconnect: () => console.warn('[WebRTC] Relay disconnected'),
        onSocialMessage:   (msg) => {
          // Route inbound social relay messages to the social handler.
          // friend-request: store in pending_friend_requests for UI pickup.
          // friend-request-ack: clear pending_outbound_requests, trigger handshake if accepted.
          void import('./webrtc/SocialRelayHandler.js').then(m =>
            m.handleInboundSocialMessage(db, msg),
          );
        },
      });
    }

    webrtcServer = new WebRTCServer({
      fastify,
      signalingClient:  webrtcSignalingClient!,
      localSignaling,
      systemDb:         db,
      instanceId,
      relayUrl:         webrtcRelayUrl,
      onConnected:      () => console.log('[WebRTC] Mobile session connected'),
      onDisconnected:   () => console.log('[WebRTC] Mobile session disconnected'),
    });

    setWebRTCContext({ signalingClient: webrtcSignalingClient, webrtcServer, localSignaling, instanceId, systemDb: db });

    // Respect relay_enabled preference — default true if no row exists.
    let relayEnabled = true;
    try {
      const rows = await db.query<{ value: string }>(
        `SELECT value FROM instance_config WHERE key = 'relay_enabled'`, [],
      );
      if (rows.length > 0) relayEnabled = rows[0].value !== 'false';
    } catch { /* non-fatal — connect anyway */ }

    if (relayEnabled) {
      webrtcSignalingClient?.connect();
    } else {
      console.log('[WebRTC] Relay disabled by preference — skipping connect');
    }

    if (webrtcSignalingClient) {
      setSocialSignalingClient(webrtcSignalingClient);
      setMeridianSignalingClient(webrtcSignalingClient);
    }

    console.log('[WebRTC] LAN signaling ready on /api/webrtc/{ping,offer,signal,ice}');
  } catch (err) {
    console.warn('[WebRTC] Failed to initialize (non-fatal):', (err as Error).message);
  }

  // Inject context-dependent values into the user management routes now that
  // db, instanceId, and relayUrl are all resolved.
  setUserManagementContext(db, instanceId, webrtcRelayUrl, PORT);
  setSocialContext(db, instanceId, webrtcRelayUrl);

  // ── PHASE 4: Services wait → Ready ────────────────────────────────────────
  // All service start() calls above are fire-and-forgot. Give them up to 5
  // Pre-warm audio daemons before the settle wait so Kokoro's ONNX model load
  // runs in parallel with Jellyfin/Polaris/etc finishing their startup.
  // By the time waitForServicesToSettle returns, the model is already loaded.
  preWarmKokoro();
  preWarmSupertonic();
  preWarmVcDaemons(getActiveUser());

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
    try {
      await _live.userDb?.close();
      console.log('[Shutdown] User database closed cleanly');
    } catch (err) {
      console.error('[Shutdown] User database close error:', err);
    }

    _live.scheduler?.stop();
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
    shutdownSupertonicDaemon();
    shutdownAllVcDaemons();
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