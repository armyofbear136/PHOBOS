import 'dotenv/config';
import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import os from 'node:os';
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
import { stopAllServers } from './phobos/LlamaServerManager.js';
import { reconfigureClients, COORDINATOR_MODEL, ENGINE_MODEL } from './ai/clients.js';
import * as ModelPathStore from './db/ModelPathStore.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

// All persistent data lives in ~/.phobos/ so it survives updates and is never
// inside the executable's directory. Env overrides are respected for dev/testing.
const PHOBOS_DATA_DIR = process.env.PHOBOS_DATA_DIR ?? path.join(os.homedir(), '.phobos');
import { mkdirSync } from 'node:fs';
import path from 'node:path';
mkdirSync(PHOBOS_DATA_DIR, { recursive: true });

const DB_PATH          = process.env.DB_PATH          ?? path.join(PHOBOS_DATA_DIR, 'phobos.duckdb');
const WORKSPACES_ROOT  = process.env.WORKSPACES_ROOT  ?? path.join(PHOBOS_DATA_DIR, 'workspaces');
mkdirSync(WORKSPACES_ROOT, { recursive: true });

async function buildServer() {
  const fastify = Fastify({
    disableRequestLogging: process.env.PHOBOS_DEBUG !== '1',
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  // CORS — allow the Vite dev server and any localhost origin
  await fastify.register(cors, {
    origin: (origin, cb) => {
      if (
        !origin || 
        origin.includes('localhost') || 
        origin.includes('127.0.0.1') || 
        origin.includes('autarch.net') ||
        origin.includes('onrender.com') ||
        origin.includes('10.0.0.')  // local network subnet
      ) {
        cb(null, true);
      } else {
        cb(null, false);
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Increase body limit for file uploads (10MB)
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

  // Register all routes
  await fastify.register(threadsRoute);
  await fastify.register(messagesRoute);
  await fastify.register(documentsRoute);
  await fastify.register(statusRoute);
  await fastify.register(phobosLocalRoute);
  await fastify.register(exportRoute);
  await fastify.register(workflowsRoute);

  // License routes (not a Fastify plugin — direct registration)
  await fastify.register(projectsRoute);
  await registerLicenseRoutes(fastify);
  await registerCopilotRoutes(fastify);

  // Health check
  fastify.get('/health', async () => ({ ok: true, ts: Date.now() }));

  // 404 handler
  fastify.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: 'Not found' });
  });

  // Error handler
  fastify.setErrorHandler((err: FastifyError, _req, reply) => {
    fastify.log.error(err);
    reply.status(err.statusCode ?? 500).send({
      error: err.message ?? 'Internal server error',
    });
  });

  return fastify;
}

async function main() {
  // Propagate resolved paths into process.env so all modules that read these
  // env vars (ThreadWorkspace, etc.) pick up the correct ~/.phobos/ paths.
  process.env.DB_PATH         = DB_PATH;
  process.env.WORKSPACES_ROOT = WORKSPACES_ROOT;

  console.log('⚙️  Initializing Phobos Core Systems...');
  const db = DatabaseManager.getInstance(DB_PATH);
  await db.initialize();
  // Load model path config (base path + overrides) into the synchronous cache
  // before any route or PhobosLocalManager call resolves model paths.
  await ModelPathStore.loadAsync(db);
  await reconfigureClients();

  const fastify = await buildServer();

  try {
    await fastify.listen({ port: PORT, host: HOST });
    console.log(`\n🚀  AI Engine running on http://localhost:${PORT}`);
    console.log(`📦  Database: ${DB_PATH}`);
    console.log(`🧠  Coordinator: http://localhost:52625/v1  (${COORDINATOR_MODEL})`);
    console.log(`⚙️   Engine:      http://localhost:11434/v1  (${ENGINE_MODEL})\n`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.once(signal, async () => {
      console.log(`\n${signal} received — shutting down...`);
      await stopAllServers();
      await fastify.close();
      await db.close();
      process.exit(0);
    });
  }
}

main().catch(err => { console.error("Server failed:", err); process.exit(1); });
