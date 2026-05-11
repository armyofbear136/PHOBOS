import type { FastifyInstance } from 'fastify';
import { checkBackendHealth, reconfigureClients, COORDINATOR_MODEL, ENGINE_MODEL, COORDINATOR_PROVIDER, ENGINE_PROVIDER, isThinkingModel, getModelVisionCapability } from '../ai/clients.js';
import { CORE_VERSION } from '../version';
import { isImageGenerating } from './workflows.js';
import { isRelocating } from './phobosLocal.js';
import { S, ProcessState } from '../coordinator/SharedState.js';
import { DispatchLogStore } from '../db/DispatchLogStore.js';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { ModelConfigStore, PROVIDERS, getCoordinatorModels, getEngineModels } from '../db/ModelConfigStore.js';
import { isConfigOptimal, detectHardware } from '../phobos/PhobosLocalManager.js';
import { getSandboxExecutorEnabled, setSandboxExecutorEnabled } from '../db/ModelPathStore.js';
import { getCamofoxStatus } from '../phobos/CamofoxManager.js';
import { snapshot as bootSnapshot } from '../boot/BootState.js';
import { CoordinatorBridge } from '../CoordinatorBridge.js';

// ── Config optimal cache — avoids running the scoring engine on every 5s poll ──
let _optimalCache: { optimal: boolean; recommendedSayon: string; recommendedSeren: string } | null = null;
let _optimalCacheKey  = '';   // `${sayonModel}|${serenModel}` — invalidates on model change
let _optimalCacheTime = 0;
const OPTIMAL_CACHE_TTL_MS = 60_000;

export async function statusRoute(fastify: FastifyInstance): Promise<void> {
  const systemDb      = DatabaseManager.getInstance();
  const userDb        = DatabaseManager.getUserDb();
  const dispatchStore = new DispatchLogStore(userDb);
  const configStore   = new ModelConfigStore(systemDb);

  // GET /api/version
  fastify.get('/api/version', async (_req, reply) => {
    return reply.send({ version: CORE_VERSION });
  });

  // GET /api/status
  fastify.get('/api/status', async (_req, reply) => {
    const health = await checkBackendHealth();

    // Read SAYON/SEREN process state directly from SharedArrayBuffer — zero IPC cost.
    // Falls back to ProcessState.STOPPED (0) if the buffer is not yet initialised
    // (e.g. coordinator has not sent INIT_SHARED_BUFFER yet on first boot).
    const sharedBuf = (globalThis as Record<string, unknown>).__phobosSharedState as Int32Array | undefined;
    const sayonState = sharedBuf ? Atomics.load(sharedBuf, S.SAYON_STATE)  : ProcessState.STOPPED;
    const serenState = sharedBuf ? Atomics.load(sharedBuf, S.SEREN_STATE)  : ProcessState.STOPPED;

    // Config optimal check — only for phobos provider, cached 60s
    let configOptimal: boolean | null = null;
    let recommendedSayon: string | null = null;
    let recommendedSeren: string | null = null;

    const isPhobos = COORDINATOR_PROVIDER === 'phobos' || ENGINE_PROVIDER === 'phobos';
    if (isPhobos) {
      const cacheKey = `${COORDINATOR_MODEL}|${ENGINE_MODEL}`;
      const now = Date.now();
      if (_optimalCache && _optimalCacheKey === cacheKey && (now - _optimalCacheTime) < OPTIMAL_CACHE_TTL_MS) {
        configOptimal    = _optimalCache.optimal;
        recommendedSayon = _optimalCache.recommendedSayon;
        recommendedSeren = _optimalCache.recommendedSeren;
      } else {
        try {
          const hw = await detectHardware();
          const result = isConfigOptimal(COORDINATOR_MODEL, ENGINE_MODEL, hw);
          _optimalCache     = result;
          _optimalCacheKey  = cacheKey;
          _optimalCacheTime = now;
          configOptimal    = result.optimal;
          recommendedSayon = result.recommendedSayon;
          recommendedSeren = result.recommendedSeren;
        } catch { /* non-fatal — leave fields null */ }
      }
    }

    return reply.send({
      ...health,
      coordinatorModel: COORDINATOR_MODEL,
      coordinatorProvider: COORDINATOR_PROVIDER,
      engineModel: ENGINE_MODEL,
      engineProvider: ENGINE_PROVIDER,
      coordinatorHasThinking: isThinkingModel(COORDINATOR_MODEL),
      engineHasThinking: isThinkingModel(ENGINE_MODEL),
      isGenerating: isImageGenerating(),
      isRelocating: isRelocating(),
      // Server lifecycle — lets the frontend block input during model switches
      coordinatorStarting: sayonState === ProcessState.STARTING,
      engineStarting:      serenState === ProcessState.STARTING,
      // Config optimality — lets the frontend show mismatch indicators
      configOptimal,
      recommendedSayon,
      recommendedSeren,
      visionCapability: getModelVisionCapability(),
      sandboxExecutorEnabled: await getSandboxExecutorEnabled(systemDb),
      camofox: getCamofoxStatus(),
      bootPhase:    bootSnapshot().phase,
      bootProgress: bootSnapshot().progress,
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
      // Phobos engine always uses SEREN port (16314), not the shared defaultEndpoint (16313)
      const phobosEngineEndpoint = 'http://127.0.0.1:16314/v1';
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

    // Push the new client endpoints to the coordinator worker so its OpenAI
    // clients track the change without reading DuckDB.
    CoordinatorBridge.updateModelConfig(
      {
        provider:    updated.coordinator.provider,
        model:       updated.coordinator.model,
        endpoint:    updated.coordinator.endpoint,
        apiKey:      updated.coordinator.apiKey ?? null,
        deviceIndex: updated.coordinator.deviceIndex ?? null,
        gpuBackend:  updated.coordinator.gpuBackend  ?? null,
        gpuLayers:   updated.coordinator.gpuLayers   ?? null,
      },
      {
        provider:    updated.engine.provider,
        model:       updated.engine.model,
        endpoint:    updated.engine.endpoint,
        apiKey:      updated.engine.apiKey ?? null,
        deviceIndex: updated.engine.deviceIndex ?? null,
        gpuBackend:  updated.engine.gpuBackend  ?? null,
        gpuLayers:   updated.engine.gpuLayers   ?? null,
      },
    );

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

  // PUT /api/config/sandbox-executor
  // Toggle the optional sandbox executor feature flag.
  fastify.put<{ Body: { enabled: boolean } }>('/api/config/sandbox-executor', async (req, reply) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return reply.status(400).send({ error: 'enabled must be a boolean' });
    }
    await setSandboxExecutorEnabled(systemDb, enabled);
    CoordinatorBridge.updateExecutorFlag(enabled);
    return reply.send({ ok: true, sandboxExecutorEnabled: enabled });
  });

  // GET /api/stats
  fastify.get('/api/stats', async (_req, reply) => {
    const stats = await dispatchStore.getStats();
    const recent = await dispatchStore.getRecent(10);
    return reply.send({ stats, recent });
  });
}