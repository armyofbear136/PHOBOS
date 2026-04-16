import { DatabaseManager } from './DatabaseManager.js';
import { listDownloaded } from '../phobos/PhobosLocalManager.js';

/** A single selectable model entry */
export interface ModelOption {
  id: string;
  label: string;
  contextWindow: number;
  charsPerToken: number;
  /** Which provider this model belongs to */
  provider: string;
  /** Model's recommended role: 'sayon' or 'seren'. Used for dropdown color-coding. */
  role?: 'sayon' | 'seren';
  /** Whether this model supports thinking/reasoning tokens */
  thinkingTokens?: boolean;
}

/** A provider entry — defines the API endpoint and its format */
export interface ProviderOption {
  id: string;
  label: string;
  /** Default base URL for this provider */
  defaultEndpoint: string;
  /** Whether an API key is required */
  requiresApiKey: boolean;
  /** How to activate thinking for this provider's models */
  thinkingMode: 'qwen3_prefix' | 'deepseek_field' | 'system_prompt' | 'none';
}

export interface RoleConfig {
  provider: string;
  endpoint: string;
  model: string;
  apiKey?: string;
  /** GPU device index from HardwareProfile.gpus[].index — undefined = auto/CPU */
  deviceIndex?: number;
  /** Backend for the target device — 'cuda' | 'vulkan' | 'metal' */
  gpuBackend?: string;
  /** GPU layer count — 0 = CPU, 99 = full offload */
  gpuLayers?: number;
}

/** Provider catalogue — shared for both roles */
export const PROVIDERS: ProviderOption[] = [
  {
    id: 'phobos',
    label: 'PHOBOS Local',
    defaultEndpoint: 'http://127.0.0.1:16313/v1',  // SAYON port; engine overrides to 16314
    requiresApiKey: false,
    thinkingMode: 'system_prompt',
  },
  {
    id: 'fastflowllm',
    label: 'FastFlowLLM',
    defaultEndpoint: 'http://localhost:52625/v1',
    requiresApiKey: false,
    thinkingMode: 'system_prompt',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    defaultEndpoint: 'http://localhost:11434/v1',
    requiresApiKey: false,
    thinkingMode: 'qwen3_prefix',
  },
];

/** Model catalogue — tagged by provider */
export const ALL_MODELS: ModelOption[] = [
  // FastFlowLLM
  { id: 'llama3.1:8b',          label: 'Llama3.1-8B',          contextWindow: 131072, charsPerToken: 4, provider: 'fastflowllm' },
  { id: 'qwen3:8b',              label: 'Qwen3-8B',              contextWindow: 32768,  charsPerToken: 4, provider: 'fastflowllm' },
  // Ollama
  { id: 'qwen3:8b',              label: 'Qwen3-8B',              contextWindow: 32768,  charsPerToken: 4, provider: 'ollama' },
  { id: 'qwen3:14b',             label: 'Qwen3-14B',             contextWindow: 32768,  charsPerToken: 4, provider: 'ollama' },
  { id: 'qwen3:30b-a3b',         label: 'Qwen3-30B-A3B',         contextWindow: 32768,  charsPerToken: 4, provider: 'ollama' },
  { id: 'qwen3:32b',             label: 'Qwen3-32B',             contextWindow: 32768,  charsPerToken: 4, provider: 'ollama' },
  { id: 'llama3.1:8b',           label: 'Llama3.1-8B',           contextWindow: 131072, charsPerToken: 4, provider: 'ollama' },
  { id: 'llama3.1:70b',          label: 'Llama3.1-70B',          contextWindow: 131072, charsPerToken: 4, provider: 'ollama' },
  { id: 'deepseek-r1:32b',       label: 'DeepSeek-R1-32B',       contextWindow: 65536,  charsPerToken: 4, provider: 'ollama' },
  { id: 'deepseek-r1:70b',       label: 'DeepSeek-R1-70B',       contextWindow: 65536,  charsPerToken: 4, provider: 'ollama' },
];

/** Models available for coordinator role per provider */
export function getCoordinatorModels(providerId: string): ModelOption[] {
  if (providerId === 'custom') return [];
  if (providerId === 'phobos') {
    return listDownloaded().map(s => ({
      id: s.modelId, label: s.label, contextWindow: s.contextWindow, charsPerToken: 4, provider: 'phobos',
      role: s.role as 'sayon' | 'seren', thinkingTokens: s.thinkingTokens,
    }));
  }
  return ALL_MODELS.filter(m => m.provider === providerId);
}

/** Models available for engine role per provider */
export function getEngineModels(providerId: string): ModelOption[] {
  if (providerId === 'custom') return [];
  if (providerId === 'phobos') {
    return listDownloaded().map(s => ({
      id: s.modelId, label: s.label, contextWindow: s.contextWindow, charsPerToken: 4, provider: 'phobos',
      role: s.role as 'sayon' | 'seren', thinkingTokens: s.thinkingTokens,
    }));
  }
  return ALL_MODELS.filter(m => m.provider === providerId);
}

/** Kept for backward compat with status.ts which imports these */
export const COORDINATOR_MODELS = ALL_MODELS;
export const ENGINE_MODELS = ALL_MODELS;

const DEFAULT_COORDINATOR: RoleConfig = {
  provider: 'phobos',
  endpoint: 'http://127.0.0.1:16313/v1',
  model: 'gemma4-e4b-q4',
};

const DEFAULT_ENGINE: RoleConfig = {
  provider: 'phobos',
  endpoint: 'http://127.0.0.1:16314/v1',
  model: 'gemma4-26b-a4b-q4',
};

export class ModelConfigStore {
  constructor(private db: DatabaseManager) {}

  private async getRaw(key: string): Promise<string | null> {
    const row = await this.db.queryOne<{ value: string }>(
      `SELECT value FROM model_config WHERE key = ?`,
      [key]
    );
    return row?.value ?? null;
  }

  private async setRaw(key: string, value: string): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.getRaw(key);
    if (existing !== null) {
      await this.db.run(
        `UPDATE model_config SET value = ?, updated_at = ? WHERE key = ?`,
        [value, now, key]
      );
    } else {
      await this.db.run(
        `INSERT INTO model_config (key, value, updated_at) VALUES (?, ?, ?)`,
        [key, value, now]
      );
    }
  }

  async getCoordinator(): Promise<RoleConfig> {
    const raw = await this.getRaw('coordinator');
    if (!raw) return DEFAULT_COORDINATOR;
    try {
      const parsed = JSON.parse(raw) as Partial<RoleConfig>;
      if (!parsed.provider) {
        parsed.provider = parsed.endpoint?.includes('16313') ? 'phobos' 
                        : parsed.endpoint?.includes('52625') ? 'fastflowllm' : 'ollama';
      }
      // Migrate stale phobos coordinator configs saved with old port 52626
      if (parsed.provider === 'phobos' && parsed.endpoint?.includes('52626')) {
        parsed.endpoint = 'http://127.0.0.1:16313/v1';
      }
      return parsed as RoleConfig;
    } catch { return DEFAULT_COORDINATOR; }
  }

  async getEngine(): Promise<RoleConfig> {
    const raw = await this.getRaw('engine');
    if (!raw) return DEFAULT_ENGINE;
    try {
      const parsed = JSON.parse(raw) as Partial<RoleConfig>;
      if (!parsed.provider) {
        parsed.provider = parsed.endpoint?.includes('11434') ? 'ollama' : 'fastflowllm';
      }
      // Migrate stale phobos engine configs saved with old port numbers.
      // Engine must use SEREN port 16314; coordinator uses SAYON port 16313.
      if (parsed.provider === 'phobos') {
        if (parsed.endpoint?.includes('52626') || parsed.endpoint?.includes('52627')) {
          parsed.endpoint = 'http://127.0.0.1:16314/v1';
        }
      }
      return parsed as RoleConfig;
    } catch { return DEFAULT_ENGINE; }
  }

  async setCoordinator(cfg: RoleConfig): Promise<void> {
    await this.setRaw('coordinator', JSON.stringify(cfg));
  }

  async setEngine(cfg: RoleConfig): Promise<void> {
    await this.setRaw('engine', JSON.stringify(cfg));
  }

  async getAll(): Promise<{ coordinator: RoleConfig; engine: RoleConfig }> {
    const [coordinator, engine] = await Promise.all([
      this.getCoordinator(),
      this.getEngine(),
    ]);
    return { coordinator, engine };
  }

  async getEngineContextWindow(): Promise<number> {
    const cfg = await this.getEngine();
    return ALL_MODELS.find((m) => m.id === cfg.model && m.provider === cfg.provider)?.contextWindow ?? 32768;
  }

  async getCoordinatorContextWindow(): Promise<number> {
    const cfg = await this.getCoordinator();
    return ALL_MODELS.find((m) => m.id === cfg.model && m.provider === cfg.provider)?.contextWindow ?? 32768;
  }
}
