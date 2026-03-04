import type { FastifyInstance } from 'fastify';
import { checkBackendHealth, reconfigureClients, COORDINATOR_MODEL, ENGINE_MODEL } from '../ai/clients.js';
import { DispatchLogStore } from '../db/DispatchLogStore.js';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { ModelConfigStore, COORDINATOR_MODELS, ENGINE_MODELS } from '../db/ModelConfigStore.js';

export async function statusRoute(fastify: FastifyInstance): Promise<void> {
  const db = DatabaseManager.getInstance();
  const dispatchStore = new DispatchLogStore(db);
  const configStore = new ModelConfigStore(db);

  // GET /api/status
  fastify.get('/api/status', async (_req, reply) => {
    const health = await checkBackendHealth();
    return reply.send({
      ...health,
      coordinatorModel: COORDINATOR_MODEL,
      engineModel: ENGINE_MODEL,
      timestamp: new Date().toISOString(),
    });
  });

  // GET /api/config/models
  // Returns current config + the full supported model catalogue for each role.
  fastify.get('/api/config/models', async (_req, reply) => {
    const config = await configStore.getAll();
    return reply.send({
      coordinator: {
        ...config.coordinator,
        options: COORDINATOR_MODELS,
      },
      engine: {
        ...config.engine,
        options: ENGINE_MODELS,
      },
    });
  });

  // PUT /api/config/models
  // Update coordinator and/or engine config, then hot-swap the live clients.
  fastify.put<{
    Body: {
      coordinator?: { endpoint?: string; model?: string };
      engine?: { endpoint?: string; model?: string };
    };
  }>('/api/config/models', async (req, reply) => {
    if (req.body.coordinator) {
      const current = await configStore.getCoordinator();
      await configStore.setCoordinator({
        endpoint: req.body.coordinator.endpoint ?? current.endpoint,
        model:    req.body.coordinator.model    ?? current.model,
      });
    }
    if (req.body.engine) {
      const current = await configStore.getEngine();
      await configStore.setEngine({
        endpoint: req.body.engine.endpoint ?? current.endpoint,
        model:    req.body.engine.model    ?? current.model,
      });
    }
    // Hot-swap live clients immediately — no restart needed
    await reconfigureClients();
    const updated = await configStore.getAll();
    return reply.send({ ok: true, ...updated });
  });

  // GET /api/stats
  fastify.get('/api/stats', async (_req, reply) => {
    const stats = await dispatchStore.getStats();
    const recent = await dispatchStore.getRecent(10);
    return reply.send({ stats, recent });
  });
}
