import OpenAI from 'openai';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { ModelConfigStore } from '../db/ModelConfigStore.js';

/**
 * Mutable exports — all consumers import these names and automatically
 * get the live client/model after reconfigureClients() is called.
 *
 * Coordinator: Qwen3-8B (default) on AMD Ryzen AI NPU via FastFlowLM
 *   - Zero system RAM · OpenAI-compatible API · port 52625 · ~28 TPS
 *   - /no_think for fast routing · /think for dispatch composition
 *
 * Engine: Qwen3-30B-A3B (default) on system RAM via Ollama
 *   - OpenAI-compatible API · port 11434 · num_predict -1
 */
export let coordinatorClient: OpenAI = new OpenAI({
  baseURL: 'http://localhost:52625/v1',
  apiKey: 'not-required',
});

export let COORDINATOR_MODEL = 'qwen3:8b';

export let engineClient: OpenAI = new OpenAI({
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'not-required',
});

export let ENGINE_MODEL = 'qwen3:30b-a3b';

/**
 * Load persisted config from DB and hot-swap the exported clients.
 * Called once at server startup and again after any PUT /api/config/models.
 */
export async function reconfigureClients(): Promise<void> {
  const db = DatabaseManager.getInstance();
  const store = new ModelConfigStore(db);
  const { coordinator, engine } = await store.getAll();

  coordinatorClient = new OpenAI({ baseURL: coordinator.endpoint, apiKey: 'not-required' });
  COORDINATOR_MODEL = coordinator.model;

  engineClient = new OpenAI({ baseURL: engine.endpoint, apiKey: 'not-required' });
  ENGINE_MODEL = engine.model;

  console.log(`[clients] Coordinator: ${coordinator.endpoint}  (${COORDINATOR_MODEL})`);
  console.log(`[clients]     Engine: ${engine.endpoint}  (${ENGINE_MODEL})`);
}

/** Health check both backends */
export async function checkBackendHealth(): Promise<{
  coordinator: 'connected' | 'disconnected';
  engine: 'connected' | 'disconnected';
}> {
  const [coordOk, engineOk] = await Promise.all([
    coordinatorClient.models.list().then(() => true).catch(() => false),
    engineClient.models.list().then(() => true).catch(() => false),
  ]);
  return {
    coordinator: coordOk ? 'connected' : 'disconnected',
    engine:      engineOk ? 'connected' : 'disconnected',
  };
}
