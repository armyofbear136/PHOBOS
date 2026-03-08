import type { FastifyInstance } from 'fastify';
import { checkBackendHealth, reconfigureClients, COORDINATOR_MODEL, ENGINE_MODEL, COORDINATOR_PROVIDER, ENGINE_PROVIDER } from '../ai/clients.js';
import { DispatchLogStore } from '../db/DispatchLogStore.js';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { ModelConfigStore, PROVIDERS, getCoordinatorModels, getEngineModels } from '../db/ModelConfigStore.js';

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
      coordinatorProvider: COORDINATOR_PROVIDER,
      engineModel: ENGINE_MODEL,
      engineProvider: ENGINE_PROVIDER,
      timestamp: new Date().toISOString(),
    });
  });

  // GET /api/config/models
  fastify.get('/api/config/models', async (_req, reply) => {
    const config = await configStore.getAll();
    return reply.send({
      coordinator: {
        ...config.coordinator,
        options: getCoordinatorModels(config.coordinator.provider),
        providers: PROVIDERS,
      },
      engine: {
        ...config.engine,
        options: getEngineModels(config.engine.provider),
        providers: PROVIDERS,
      },
    });
  });

  // PUT /api/config/models
  // Update coordinator and/or engine config, then hot-swap the live clients.
  // Now accepts deviceIndex, gpuBackend, gpuLayers for phobos hardware assignment.
  fastify.put<{
    Body: {
      coordinator?: { provider?: string; endpoint?: string; model?: string; apiKey?: string; deviceIndex?: number; gpuBackend?: string; gpuLayers?: number };
      engine?:      { provider?: string; endpoint?: string; model?: string; apiKey?: string; deviceIndex?: number; gpuBackend?: string; gpuLayers?: number };
    };
  }>('/api/config/models', async (req, reply) => {
    if (req.body.coordinator) {
      const current = await configStore.getCoordinator();
      const patch = req.body.coordinator;
      const provider = patch.provider ?? current.provider;
      const providerDef = PROVIDERS.find(p => p.id === provider);
      const endpoint = patch.endpoint ?? (
        patch.provider && providerDef ? providerDef.defaultEndpoint : current.endpoint
      );
      // When provider changes, verify the model is valid for the new provider.
      // If not, auto-select the first available model for that provider.
      let model = patch.model ?? current.model;
      if (patch.provider && patch.provider !== current.provider) {
        const available = getCoordinatorModels(provider);
        if (!available.some(m => m.id === model)) {
          model = available[0]?.id ?? model;
        }
      }
      await configStore.setCoordinator({
        provider,
        endpoint,
        model,
        apiKey:      patch.apiKey      ?? current.apiKey,
        deviceIndex: patch.deviceIndex ?? current.deviceIndex,
        gpuBackend:  patch.gpuBackend  ?? current.gpuBackend,
        gpuLayers:   patch.gpuLayers   ?? current.gpuLayers,
      });
    }
    if (req.body.engine) {
      const current = await configStore.getEngine();
      const patch = req.body.engine;
      const provider = patch.provider ?? current.provider;
      const providerDef = PROVIDERS.find(p => p.id === provider);
      // Phobos engine always uses ALLMIND port (52627), not the shared defaultEndpoint (52626)
      const phobosEngineEndpoint = 'http://127.0.0.1:52627/v1';
      const endpoint = patch.endpoint ?? (
        patch.provider && providerDef
          ? (provider === 'phobos' ? phobosEngineEndpoint : providerDef.defaultEndpoint)
          : current.endpoint
      );
      let model = patch.model ?? current.model;
      if (patch.provider && patch.provider !== current.provider) {
        const available = getEngineModels(provider);
        if (!available.some(m => m.id === model)) {
          model = available[0]?.id ?? model;
        }
      }
      await configStore.setEngine({
        provider,
        endpoint,
        model,
        apiKey:      patch.apiKey      ?? current.apiKey,
        deviceIndex: patch.deviceIndex ?? current.deviceIndex,
        gpuBackend:  patch.gpuBackend  ?? current.gpuBackend,
        gpuLayers:   patch.gpuLayers   ?? current.gpuLayers,
      });
    }
    await reconfigureClients();
    const updated = await configStore.getAll();
    return reply.send({
      ok: true,
      coordinator: {
        ...updated.coordinator,
        options: getCoordinatorModels(updated.coordinator.provider),
        providers: PROVIDERS,
      },
      engine: {
        ...updated.engine,
        options: getEngineModels(updated.engine.provider),
        providers: PROVIDERS,
      },
    });
  });

  // GET /api/stats
  fastify.get('/api/stats', async (_req, reply) => {
    const stats = await dispatchStore.getStats();
    const recent = await dispatchStore.getRecent(10);
    return reply.send({ stats, recent });
  });
}
