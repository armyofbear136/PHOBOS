import { DatabaseManager } from './DatabaseManager.js';

/** A single selectable model entry */
export interface ModelOption {
  id: string;        // e.g. 'qwen3:8b'
  label: string;     // display name
  contextWindow: number;   // max tokens
  /** Estimated chars per token (used for budget calculations, ~4 for most) */
  charsPerToken: number;
}

export interface RoleConfig {
  endpoint: string;
  model: string;
}

/** Hard-coded supported model catalogue per role */
export const COORDINATOR_MODELS: ModelOption[] = [
  // Local / Ollama
  { id: 'qwen3:8b',            label: 'Qwen3-8B',            contextWindow: 32768,   charsPerToken: 4 },
  { id: 'llama3.1:8b',         label: 'Llama3.1-8B',         contextWindow: 131072,  charsPerToken: 4 },
  { id: 'qwen3:14b',           label: 'Qwen3-14B',           contextWindow: 32768,   charsPerToken: 4 },
  // OpenAI
  { id: 'gpt-4o-mini',         label: 'GPT-4o Mini',         contextWindow: 128000,  charsPerToken: 4 },
  { id: 'gpt-4o',              label: 'GPT-4o',              contextWindow: 128000,  charsPerToken: 4 },
  // Anthropic
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', contextWindow: 200000, charsPerToken: 4 },
  { id: 'claude-sonnet-4-6',   label: 'Claude Sonnet 4.6',   contextWindow: 200000,  charsPerToken: 4 },
  // Google
  { id: 'gemini-2.0-flash',    label: 'Gemini 2.0 Flash',    contextWindow: 1048576, charsPerToken: 4 },
];

export const ENGINE_MODELS: ModelOption[] = [
  // Local / Ollama
  { id: 'qwen3:30b-a3b',        label: 'Qwen3-30B-A3B',       contextWindow: 32768,   charsPerToken: 4 },
  { id: 'deepseek-r1:70b',      label: 'DeepSeek-R1-70B',     contextWindow: 65536,   charsPerToken: 4 },
  { id: 'qwen3:32b',            label: 'Qwen3-32B',            contextWindow: 32768,   charsPerToken: 4 },
  { id: 'llama3.1:70b',         label: 'Llama3.1-70B',        contextWindow: 131072,  charsPerToken: 4 },
  { id: 'deepseek-r1:32b',      label: 'DeepSeek-R1-32B',     contextWindow: 65536,   charsPerToken: 4 },
  // OpenAI
  { id: 'gpt-4o',               label: 'GPT-4o',               contextWindow: 128000,  charsPerToken: 4 },
  { id: 'o4-mini',              label: 'o4-mini',              contextWindow: 128000,  charsPerToken: 4 },
  { id: 'o3',                   label: 'o3',                   contextWindow: 200000,  charsPerToken: 4 },
  // Anthropic
  { id: 'claude-sonnet-4-6',    label: 'Claude Sonnet 4.6',    contextWindow: 200000,  charsPerToken: 4 },
  { id: 'claude-opus-4-6',      label: 'Claude Opus 4.6',      contextWindow: 200000,  charsPerToken: 4 },
  // Google
  { id: 'gemini-2.5-pro',       label: 'Gemini 2.5 Pro',       contextWindow: 1048576, charsPerToken: 4 },
  { id: 'gemini-2.0-flash',     label: 'Gemini 2.0 Flash',     contextWindow: 1048576, charsPerToken: 4 },
];

const DEFAULT_COORDINATOR: RoleConfig = {
  endpoint: 'http://localhost:52625/v1',
  model: 'qwen3:8b',
};

const DEFAULT_ENGINE: RoleConfig = {
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
    try { return JSON.parse(raw) as RoleConfig; } catch { return DEFAULT_COORDINATOR; }
  }

  async getEngine(): Promise<RoleConfig> {
    const raw = await this.getRaw('engine');
    if (!raw) return DEFAULT_ENGINE;
    try { return JSON.parse(raw) as RoleConfig; } catch { return DEFAULT_ENGINE; }
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

  /** Return context window for the currently active engine model */
  async getEngineContextWindow(): Promise<number> {
    const cfg = await this.getEngine();
    return ENGINE_MODELS.find((m) => m.id === cfg.model)?.contextWindow ?? 32768;
  }

  /** Return context window for the currently active coordinator model */
  async getCoordinatorContextWindow(): Promise<number> {
    const cfg = await this.getCoordinator();
    return COORDINATOR_MODELS.find((m) => m.id === cfg.model)?.contextWindow ?? 32768;
  }
}
