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
}

/** Provider catalogue — shared for both roles */
export const PROVIDERS: ProviderOption[] = [
  {
    id: 'phobos',
    label: 'PHOBOS Local',
    defaultEndpoint: 'http://127.0.0.1:52626/v1',  // SAYON default; engine overrides to 52627
    requiresApiKey: false,
    thinkingMode: 'system_prompt',
  },
  {
    id: 'fastflowllm',
    label: 'FastFlowLLM',
    defaultEndpoint: 'http://localhost:52625/v1',
    requiresApiKey: false,
    thinkingMode: 'system_prompt',  // Llama3.1 on NPU — use system prompt injection
  },
  {
    id: 'ollama',
    label: 'Ollama',
    defaultEndpoint: 'http://localhost:11434/v1',
    requiresApiKey: false,
    thinkingMode: 'qwen3_prefix',   // Qwen3 /think prefix works here too
  },
  {
    id: 'openai',
    label: 'OpenAI',
    defaultEndpoint: 'https://api.openai.com/v1',
    requiresApiKey: true,
    thinkingMode: 'none',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    defaultEndpoint: 'https://api.anthropic.com/v1',
    requiresApiKey: true,
    thinkingMode: 'none',
  },
  {
    id: 'google',
    label: 'Google',
    defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresApiKey: true,
    thinkingMode: 'none',
  },
  {
    id: 'custom',
    label: 'Custom',
    defaultEndpoint: '',
    requiresApiKey: false,
    thinkingMode: 'system_prompt',
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
  // OpenAI
  { id: 'gpt-4o-mini',           label: 'GPT-4o Mini',           contextWindow: 128000, charsPerToken: 4, provider: 'openai' },
  { id: 'gpt-4o',                label: 'GPT-4o',                contextWindow: 128000, charsPerToken: 4, provider: 'openai' },
  { id: 'o4-mini',               label: 'o4-mini',               contextWindow: 128000, charsPerToken: 4, provider: 'openai' },
  { id: 'o3',                    label: 'o3',                    contextWindow: 200000, charsPerToken: 4, provider: 'openai' },
  // Anthropic
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', contextWindow: 200000, charsPerToken: 4, provider: 'anthropic' },
  { id: 'claude-sonnet-4-6',     label: 'Claude Sonnet 4.6',     contextWindow: 200000, charsPerToken: 4, provider: 'anthropic' },
  { id: 'claude-opus-4-6',       label: 'Claude Opus 4.6',       contextWindow: 200000, charsPerToken: 4, provider: 'anthropic' },
  // Google
  { id: 'gemini-2.0-flash',      label: 'Gemini 2.0 Flash',      contextWindow: 1048576, charsPerToken: 4, provider: 'google' },
  { id: 'gemini-2.5-pro',        label: 'Gemini 2.5 Pro',        contextWindow: 1048576, charsPerToken: 4, provider: 'google' },
];

/** Models available for coordinator role per provider */
export function getCoordinatorModels(providerId: string): ModelOption[] {
  if (providerId === 'custom') return [];
  if (providerId === 'phobos') {
    return listDownloaded().map(s => ({
      id: s.modelId, label: s.label, contextWindow: s.contextWindow, charsPerToken: 4, provider: 'phobos',
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
    }));
  }
  return ALL_MODELS.filter(m => m.provider === providerId);
}

/** Kept for backward compat with status.ts which imports these */
export const COORDINATOR_MODELS = ALL_MODELS;
export const ENGINE_MODELS = ALL_MODELS;

const DEFAULT_COORDINATOR: RoleConfig = {
  provider: 'fastflowllm',
  endpoint: 'http://localhost:52625/v1',
  model: 'llama3.1:8b',
};

const DEFAULT_ENGINE: RoleConfig = {
  provider: 'ollama',
  endpoint: 'http://localhost:11434/v1',
  model: 'qwen3:30b-a3b',
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
      // Migrate old format (no provider field)
      if (!parsed.provider) {
        parsed.provider = parsed.endpoint?.includes('52625') ? 'fastflowllm' : 'ollama';
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
