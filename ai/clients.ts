import OpenAI from 'openai';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { ModelConfigStore, PROVIDERS, type RoleConfig } from '../db/ModelConfigStore.js';
import { reconcilePhobosServers, getServerStatus } from '../phobos/LlamaServerManager.js';
import { getSpec } from '../phobos/PhobosLocalManager.js';
import { PromptLogStore, type PromptStage } from '../db/PromptLogStore.js';
import { ThinkingTokenRouter } from './ThinkingTokenRouter.js';

/**
 * Thread-local logging context. Set this before any pipeline call so that
 * coordinatorCall / coordinatorStream / engineStream can log to prompt_log
 * without needing every call site to pass thread/message IDs explicitly.
 *
 * Usage:
 *   setLogContext({ threadId, messageId });   // at turn start
 *   clearLogContext();                         // at turn end (or in finally)
 */
let _logCtx: { threadId: string; messageId?: string | null } | null = null;

export function setLogContext(ctx: { threadId: string; messageId?: string | null }): void {
  _logCtx = ctx;
}
export function clearLogContext(): void {
  _logCtx = null;
}

async function writePromptLog(opts: {
  role: 'sayon' | 'seren';
  stage: PromptStage;
  model: string;
  prompt: string;
  response: string;
  latencyMs: number;
}): Promise<void> {
  if (!_logCtx) return; // no context set — skip silently
  try {
    const db = DatabaseManager.getInstance();
    const store = new PromptLogStore(db);
    await store.insert({
      threadId:  _logCtx.threadId,
      messageId: _logCtx.messageId ?? null,
      role:      opts.role,
      stage:     opts.stage,
      model:     opts.model,
      prompt:    opts.prompt,
      response:  opts.response,
      latencyMs: opts.latencyMs,
    });
  } catch (err) {
    // Never let logging crash the pipeline
    console.warn('[promptLog] write failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * Formats a messages array into a readable prompt string for logging.
 * Shows role labels and full content so the export reads like a script.
 */
function formatPromptForLog(
  messages: Array<{ role: string; content: string }>
): string {
  return messages.map(m => {
    const label =
      m.role === 'system'    ? '### SYSTEM'    :
      m.role === 'user'      ? '### USER'      :
      m.role === 'assistant' ? '### ASSISTANT' :
      `### ${m.role.toUpperCase()}`;
    return `${label}\n${m.content}`;
  }).join('\n\n');
}

export let coordinatorClient: OpenAI = new OpenAI({
  baseURL: 'http://localhost:52625/v1',
  apiKey: 'not-required',
});

export let COORDINATOR_MODEL = 'llama3.1:8b';
export let COORDINATOR_PROVIDER = 'fastflowllm';

export let engineClient: OpenAI = new OpenAI({
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'not-required',
});

export let ENGINE_MODEL = 'qwen3:30b-a3b';
export let ENGINE_PROVIDER = 'ollama';
// Getters — use these in other modules instead of the bare exports to avoid
// esbuild CJS live-binding issues (let exports are captured at import time).
export const getEngineProvider = () => ENGINE_PROVIDER;
export const getEngineModel    = () => ENGINE_MODEL;

function makeClient(cfg: RoleConfig): OpenAI {
  return new OpenAI({
    baseURL: cfg.endpoint,
    apiKey: cfg.apiKey ?? 'not-required',
  });
}

export async function reconfigureClients(): Promise<void> {
  const db = DatabaseManager.getInstance();
  const store = new ModelConfigStore(db);
  const { coordinator, engine } = await store.getAll();

  coordinatorClient = makeClient(coordinator);
  COORDINATOR_MODEL = coordinator.model;
  COORDINATOR_PROVIDER = coordinator.provider;

  engineClient = makeClient(engine);
  ENGINE_MODEL = engine.model;
  ENGINE_PROVIDER = engine.provider;

  console.log(`[clients] Sayon:   ${coordinator.provider} / ${coordinator.endpoint}  (${COORDINATOR_MODEL})`);
  console.log(`[clients] SEREN: ${engine.provider} / ${engine.endpoint}  (${ENGINE_MODEL})`);

  // Start/stop llama-server if either role is on the phobos provider.
  // Thread device assignment from ModelConfigStore through to LlamaServerManager.
  reconcilePhobosServers({
    coordinator: {
      provider:    coordinator.provider,
      model:       coordinator.model,
      deviceIndex: coordinator.deviceIndex,
      gpuBackend:  coordinator.gpuBackend,
      gpuLayers:   coordinator.gpuLayers,
    },
    engine: {
      provider:    engine.provider,
      model:       engine.model,
      deviceIndex: engine.deviceIndex,
      gpuBackend:  engine.gpuBackend,
      gpuLayers:   engine.gpuLayers,
    },
  }).catch(err => {
    console.error(`[reconfigureClients] reconcilePhobosServers error: ${err.message}`);
  });
}

export async function checkBackendHealth(): Promise<{
  coordinator: 'connected' | 'disconnected';
  engine:      'connected' | 'disconnected';
}> {
  // If a phobos server is mid-restart (state === 'starting'), skip the HTTP probe
  // and report it as connected. Probing a port that is not yet listening returns
  // disconnected, which flashes the offline screen during image generation restart.
  const phobosStatus   = getServerStatus();
  const coordStarting  = phobosStatus.sayon.state  === 'starting';
  const engineStarting = phobosStatus.seren.state === 'starting';

  const [coordOk, engineOk] = await Promise.all([
    coordStarting  ? Promise.resolve(true) : coordinatorClient.models.list().then(() => true).catch(() => false),
    engineStarting ? Promise.resolve(true) : engineClient.models.list().then(() => true).catch(() => false),
  ]);
  return {
    coordinator: coordOk ? 'connected' : 'disconnected',
    engine:      engineOk ? 'connected' : 'disconnected',
  };
}

// ─── Raw SSE stream for phobos provider ────────────────────────────────────
// Bypasses the OpenAI SDK which silently strips reasoning_content from deltas.
// Used by coordinatorCall, coordinatorStream, engineStream, and runSingleStream.
// All phobos-provider calls MUST use this instead of the SDK to preserve
// thinking tokens for field-path models (Nemotron, Qwen3, Magistral, etc).
async function* rawPhobosStream(
  baseURL: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    ...(signal ? { signal } : {}),
  });
  if (!resp.ok || !resp.body) throw new Error(`[rawPhobosStream] HTTP ${resp.status}`);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const json = trimmed.slice(5).trim();
      if (json === '[DONE]') return;
      try {
        const parsed = JSON.parse(json);
        const delta = parsed?.choices?.[0]?.delta;
        if (delta) yield delta as Record<string, unknown>;
      } catch { /* malformed chunk — skip */ }
    }
  }
}

/** True when the provider is phobos (local llama-server). */
function isPhobosProvider(provider: string): boolean {
  return provider === 'phobos';
}

/** Extract base URL from an OpenAI client instance. */
function clientBaseURL(client: OpenAI): string {
  return ((client as unknown as { baseURL?: string }).baseURL ?? '').replace(/\/$/, '');
}

/**
 * Thinking strategy for a given provider + model.
 *
 * FastFlowLLM / Llama3.x
 *   - Does NOT support /think prefix
 *   - Does NOT reliably use delta.reasoning_content
 *   - Thinking activated via system prompt injection
 *   - Thinking tokens arrive in delta.content wrapped in <think>…</think>
 *   - StreamParser handles extraction automatically
 *   - usesReasoningField: false — ignore reasoning_content to prevent double-emit
 *
 * Qwen3 (Ollama or FastFlowLLM)
 *   - /think prefix in user message activates extended thinking
 *   - /no_think disables it for fast routing calls
 *   - Thinking tokens arrive in delta.content as <think>…</think> OR
 *     in delta.reasoning_content depending on Ollama build
 *
 * DeepSeek-R1 (Ollama)
 *   - Thinking always on; arrives in delta.reasoning_content
 *   - usesReasoningField: true
 *
 * Nemotron 3 (Phobos)
 *   - All variants use ChatML template with thinking_forced_open = true
 *   - <think> is token ID 12, </think> is token ID 13 — SPECIAL tokens, not text
 *   - llama-server's --reasoning-format deepseek does NOT parse these special tokens
 *     into reasoning_content (known llama.cpp issue, PR #18058)
 *   - Tags arrive as LITERAL TEXT in delta.content — must use TAG path, not field
 *   - chat_template_kwargs:{enable_thinking:true/false} controls thinking on/off
 *   - reasoning_format:none tells server to leave everything in content (no broken parsing)
 *
 * Cloud providers (OpenAI, Anthropic, Google)
 *   - No thinking activation needed for standard calls
 */
export interface ThinkingStrategy {
  /** Appended to the system prompt to instruct <think> tag usage */
  systemSuffix: string;
  /**
   * How thinking tokens arrive in the stream:
   *
   * 'tag'    — thinking arrives as <think>…</think> in delta.content (default for all
   *            providers via the OpenAI compat layer). ThinkingTokenRouter handles this.
   *            This is the correct path for:
   *              • Nemotron 3 on Phobos (special token IDs not parsed by llama-server)
   *              • Qwen3 on FastFlowLLM (always, no native thinking API)
   *              • Qwen3 on Ollama via /v1/ compat — Ollama's compat layer does NOT
   *                honour extra_body:{think:true}; you must use reasoning_effort OR
   *                the native /api/chat. Via /v1/ the model outputs raw <think> tags.
   *              • Llama3.x anywhere (system prompt instructs tags)
   *
   * 'field'  — thinking arrives in a dedicated delta field, NOT in delta.content.
   *            Read order: delta.reasoning_content → delta.reasoning → delta.thinking
   *            Used for:
   *              • Phobos jinjaTemplate models (Nemotron, Qwen3, Magistral, DeepSeek-R1 distills)
   *                when --reasoning-format deepseek is set on llama-server
   *              • Ollama native /api/chat with think:true
   *
   *            CRITICAL: The OpenAI Node SDK strips reasoning_content from delta objects.
   *            All phobos provider calls MUST use rawPhobosStream() instead of the SDK
   *            to preserve this field. This is enforced by the phobos-detection logic in
   *            coordinatorCall, coordinatorStream, and engineStream.
   */
  thinkingPath: 'tag' | 'field';
  /**
   * Extra fields to pass in extra_body to activate thinking.
   * For Ollama /v1/ compat: reasoning_effort:"high" is the correct param.
   * extra_body:{think:true} is silently ignored by Ollama's /v1/ compat layer.
   * For FastFlowLLM/Qwen3: no activation needed — Qwen3 always thinks by default.
   * For Phobos jinjaTemplate: reasoning_format + chat_template_kwargs
   */
  extraBodyThink: Record<string, unknown>;
  /** extra_body for no_think mode */
  extraBodyNoThink: Record<string, unknown>;
  /**
   * True when the model's chat template prepends <think> to every generation
   * (thinking_forced_open = true). The opening <think> tag is NOT streamed —
   * generation starts already inside the think block. ThinkingTokenRouter
   * must be initialized with startInThink=true for these models.
   *
   * Currently: all Nemotron 3 variants (4B, 9B v2, 30B-A3B).
   */
  thinkingForcedOpen?: boolean;
}

export function getThinkingStrategy(provider: string, model: string): ThinkingStrategy {
  // PHOBOS Local — llama-server (llama.cpp) speaks the same OpenAI compat as Ollama.
  if (provider === 'phobos') {
    const spec = getSpec(model);

    // ── Nemotron 3: TAG path (not field) ────────────────────────────────
    // Nemotron 3 uses special token IDs 12 (<think>) and 13 (</think>) for reasoning.
    // llama-server's --reasoning-format deepseek does NOT parse these special tokens
    // into reasoning_content — they arrive as literal <think>...</think> text in
    // delta.content. This is a known llama.cpp issue (see PR #18058 discussion).
    //
    // Therefore Nemotron MUST use the tag path. The ThinkingTokenRouter's tag-path
    // handler will extract the <think> blocks from delta.content correctly.
    //
    // chat_template_kwargs:{enable_thinking:true/false} controls whether the Jinja
    // template prepends <think> to the generation. This IS honored by llama-server.
    // reasoning_format:none tells llama-server to not try (and fail) to parse the
    // think tokens — just leave everything in content where our tag parser handles it.
    if (spec?.nemotronVariant) {
      return {
        systemSuffix: '',
        thinkingPath: 'tag',
        thinkingForcedOpen: true,
        extraBodyThink:   { reasoning_format: 'none', chat_template_kwargs: { enable_thinking: true } },
        extraBodyNoThink: { reasoning_format: 'none', chat_template_kwargs: { enable_thinking: false } },
      };
    }

    // ── Other jinjaTemplate models: FIELD path ──────────────────────────
    // Qwen3, Qwen3.5, Magistral, DeepSeek-R1 Qwen3 distills — these models' think
    // tokens ARE properly parsed by llama-server's reasoning_format:deepseek into
    // delta.reasoning_content.
    if (spec?.jinjaTemplate) {
      return {
        systemSuffix: '',
        thinkingPath: 'field',
        extraBodyThink:   { reasoning_format: 'deepseek', chat_template_kwargs: { enable_thinking: true } },
        extraBodyNoThink: { reasoning_format: 'none',     chat_template_kwargs: { enable_thinking: false } },
      };
    }
    // ── Non-thinking models: NO thinking strategy ────────────────────────
    // Models with thinkingTokens: false (Mistral, Gemma, etc.) should never
    // get thinking system prompt injection — they don't have <think> training
    // and produce garbled tags that leak into the output.
    if (spec && !spec.thinkingTokens) {
      return {
        systemSuffix: '',
        thinkingPath: 'tag',     // tag path handles any accidental <think> as safety net
        extraBodyThink: {},
        extraBodyNoThink: {},
      };
    }
    // Llama-architecture models with thinking support — prompt-inject thinking
    return {
      systemSuffix:
        '\n\nThink through the problem step by step before answering. ' +
        'Write your reasoning inside <think> tags, then give your final answer after the closing </think> tag.',
      thinkingPath: 'tag',
      extraBodyThink: {},
      extraBodyNoThink: {},
    };
  }

  // Qwen3 on Ollama — CONFIRMED from debug logs:
  // delta.content is "" (empty), thinking arrives in delta.thinking.
  // extra_body:{think:true} IS working via Ollama's /v1/ compat layer.
  // Use 'field' path and read delta.thinking.
  if (model.startsWith('qwen3') && provider === 'ollama') {
    return {
      systemSuffix: '',
      thinkingPath: 'field',
      extraBodyThink: { think: true },
      extraBodyNoThink: { think: false },
    };
  }

  // DeepSeek-R1 on Ollama — same field path as Qwen3.
  if (model.startsWith('deepseek-r1') && provider === 'ollama') {
    return {
      systemSuffix: '',
      thinkingPath: 'field',
      extraBodyThink: { think: true },
      extraBodyNoThink: { think: false },
    };
  }

  // Qwen3 on FastFlowLLM — CONFIRMED from debug logs:
  // FastFlowLLM always sends thinking in delta.reasoning_content (field path).
  // delta.content has the output. chat_template_kwargs is ignored.
  // Use 'field' path — same as Ollama but different field name.
  if (model.startsWith('qwen3') && provider === 'fastflowllm') {
    return {
      systemSuffix: '',
      thinkingPath: 'field',
      extraBodyThink: {},
      extraBodyNoThink: {},
    };
  }

  // Llama 3.x — provider-dependent:
  if (/^llama3[.\-:]/.test(model) || /^llama3\./.test(model)) {
    if (provider === 'fastflowllm') {
      return {
        systemSuffix: '',
        thinkingPath: 'field',
        extraBodyThink: {},
        extraBodyNoThink: {},
      };
    }
    return {
      systemSuffix:
        '\n\nThink through the problem step by step before answering. ' +
        'Write your reasoning inside <think> tags, then give your final answer after the closing </think> tag.',
      thinkingPath: 'tag',
      extraBodyThink: {},
      extraBodyNoThink: {},
    };
  }

  // Cloud providers — no thinking strategy needed
  return {
    systemSuffix: '',
    thinkingPath: 'tag',
    extraBodyThink: {},
    extraBodyNoThink: {},
  };
}

export function isThinkingModel(model: string): boolean {
  // For phobos provider, check the spec — most authoritative source
  const spec = getSpec(model);
  if (spec) return spec.thinkingTokens;

  // Non-phobos heuristics
  if (/^llama3[.\-:]/.test(model)) return COORDINATOR_PROVIDER === 'fastflowllm';
  if (model.startsWith('qwen3')) return true;
  if (model.startsWith('deepseek-r1')) return true;
  if (model.startsWith('magistral')) return true;
  if (model.startsWith('nemotron')) return true;
  return false;
}

export function getThinkingExtraBody(provider: string, model: string, mode: 'think' | 'no_think' | 'none'): Record<string, unknown> {
  if (mode === 'none') return {};
  const s = getThinkingStrategy(provider, model);
  return mode === 'think' ? s.extraBodyThink : s.extraBodyNoThink;
}

export function applyThinkingStrategy(
  messages: Array<{ role: string; content: string }>,
  systemPrompt: string,
  provider: string,
  model: string,
  mode: 'think' | 'no_think' | 'none' = 'think',
): { messages: typeof messages; systemPrompt: string } {
  if (mode === 'none') return { messages, systemPrompt };

  const strategy = getThinkingStrategy(provider, model);

  // Ollama Qwen3 uses extra_body:{think:true/false} — no message change needed.
  if (provider === 'ollama' && model.startsWith('qwen3')) return { messages, systemPrompt };
  if (provider === 'ollama' && model.startsWith('deepseek-r1')) return { messages, systemPrompt };

  // FastFlowLLM: extra_body activates thinking via server config, no message change.
  if (provider === 'fastflowllm') return { messages, systemPrompt };

  // PHOBOS Local Jinja-template models (Qwen3, Magistral, DeepSeek-R1 Qwen3 distills, Nemotron):
  // thinking activated via chat_template_kwargs:{enable_thinking:true} in extra_body.
  // No message prefix needed.
  if (provider === 'phobos' && getSpec(model)?.jinjaTemplate) return { messages, systemPrompt };

  // System prompt injection for models that need it (Llama on Ollama, PHOBOS Llama, etc.)
  const finalSystem = mode === 'think'
    ? systemPrompt + strategy.systemSuffix
    : systemPrompt;

  return { messages, systemPrompt: finalSystem };
}

// ─── coordinatorCall ─────────────────────────────────────────────────────────
// Non-streaming coordinator (SAYON) call. Returns the output text only.
// Thinking tokens are silently discarded — use coordinatorStream if you need them.
//
// For phobos provider: uses rawPhobosStream to preserve reasoning_content.
// For other providers: uses OpenAI SDK.
export async function coordinatorCall(opts: {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  maxTokens: number;
  temperature: number;
  mode?: 'think' | 'no_think' | 'none';
  stage?: PromptStage;
}): Promise<string> {
  const { mode = 'think' } = opts;
  const t0 = Date.now();
  const { messages: stratMsgs, systemPrompt: stratSystem } = applyThinkingStrategy(
    opts.messages,
    opts.systemPrompt,
    COORDINATOR_PROVIDER,
    COORDINATOR_MODEL,
    mode
  );

  const allMessages = stratSystem
    ? [{ role: 'system' as const, content: stratSystem }, ...stratMsgs.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))]
    : stratMsgs.map(m => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content }));

  const extraBody = getThinkingExtraBody(COORDINATOR_PROVIDER, COORDINATOR_MODEL, opts.mode ?? 'think');
  console.log(`[coordinatorCall] mode=${opts.mode} extraBody=${JSON.stringify(extraBody)} model=${COORDINATOR_MODEL}`);

  const strategy = getThinkingStrategy(COORDINATOR_PROVIDER, COORDINATOR_MODEL);
  const startInThink = strategy.thinkingForcedOpen === true;
  const router = new ThinkingTokenRouter(strategy, mode, undefined, startInThink);
  let _callDbgN = 0;

  if (isPhobosProvider(COORDINATOR_PROVIDER)) {
    // ── Phobos: raw fetch to preserve reasoning_content ──
    const baseURL = clientBaseURL(coordinatorClient);
    const body: Record<string, unknown> = {
      model: COORDINATOR_MODEL,
      messages: allMessages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      // Spread extra body at top level — llama-server accepts these directly
      ...extraBody,
    };

    for await (const delta of rawPhobosStream(baseURL, body)) {
      _callDbgN++;
      if (_callDbgN <= 2) {
        console.log(`[coordinatorCall:delta:${_callDbgN}] keys=${JSON.stringify(Object.keys(delta ?? {}))} content=${JSON.stringify((delta as Record<string, unknown>)?.content)} reasoning=${JSON.stringify((delta as Record<string, unknown>)?.reasoning_content)}`);
      }
      router.feed(delta);
    }
  } else {
    // ── Non-phobos: OpenAI SDK ──
    const callParams = {
      model: COORDINATOR_MODEL,
      messages: allMessages as Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      ...(Object.keys(extraBody).length > 0 ? { extra_body: extraBody } : {}),
    };

    let stream: Awaited<ReturnType<typeof coordinatorClient.chat.completions.create>>;
    try {
      stream = await coordinatorClient.chat.completions.create({
        ...callParams,
        stream: true as const,
      });
    } catch (createErr: unknown) {
      console.error(`[coordinatorCall:error] ${createErr instanceof Error ? createErr.message : String(createErr)}`);
      console.log('[coordinatorCall:retry] Retrying without extra_body...');
      const { extra_body: _drop, ...fallbackParams } = callParams as Record<string, unknown>;
      stream = await coordinatorClient.chat.completions.create({
        ...(fallbackParams as unknown as Parameters<typeof coordinatorClient.chat.completions.create>[0]),
        stream: true as const,
      });
    }

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as Record<string, unknown>;
      _callDbgN++;
      if (_callDbgN <= 2) {
        console.log(`[coordinatorCall:delta:${_callDbgN}] keys=${JSON.stringify(Object.keys(delta ?? {}))} content=${JSON.stringify((delta as Record<string, unknown>)?.content)} reasoning=${JSON.stringify((delta as Record<string, unknown>)?.reasoning_content)}`);
      }
      router.feed(delta);
    }
  }

  router.flush();
  const _ccResult = ThinkingTokenRouter.finalStrip(router.getOutputBuf());
  await writePromptLog({
    role: 'sayon',
    stage: opts.stage ?? 'other',
    model: COORDINATOR_MODEL,
    prompt: formatPromptForLog(allMessages),
    response: _ccResult,
    latencyMs: Date.now() - t0,
  });
  return _ccResult;
}

// ─── coordinatorStream ───────────────────────────────────────────────────────
// Streaming coordinator (SAYON) call WITH thinking token callback.
// Thinking tokens are sent to onThinkToken for the SAYON reasoning panel.
//
// For phobos provider: uses rawPhobosStream to preserve reasoning_content.
// For other providers: uses OpenAI SDK.
export async function coordinatorStream(opts: {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  maxTokens: number;
  temperature: number;
  mode?: 'think' | 'no_think' | 'none';
  onThinkToken?: (token: string) => void;
  stage?: PromptStage;
}): Promise<string> {
  const { mode = 'think', onThinkToken } = opts;
  const t0 = Date.now();
  const { messages: stratMsgs, systemPrompt: stratSystem } = applyThinkingStrategy(
    opts.messages,
    opts.systemPrompt,
    COORDINATOR_PROVIDER,
    COORDINATOR_MODEL,
    mode
  );

  const allMessages = stratSystem
    ? [{ role: 'system' as const, content: stratSystem }, ...stratMsgs]
    : stratMsgs;

  const extraBody = getThinkingExtraBody(COORDINATOR_PROVIDER, COORDINATOR_MODEL, opts.mode ?? 'think');
  console.log(`[coordinatorStream] mode=${opts.mode} extraBody=${JSON.stringify(extraBody)}`);

  const strategy = getThinkingStrategy(COORDINATOR_PROVIDER, COORDINATOR_MODEL);
  const startInThinkCS = strategy.thinkingForcedOpen === true;
  const router = new ThinkingTokenRouter(strategy, mode, onThinkToken, startInThinkCS);

  if (isPhobosProvider(COORDINATOR_PROVIDER)) {
    // ── Phobos: raw fetch to preserve reasoning_content ──
    const baseURL = clientBaseURL(coordinatorClient);
    const body: Record<string, unknown> = {
      model: COORDINATOR_MODEL,
      messages: allMessages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      ...extraBody,
    };

    for await (const delta of rawPhobosStream(baseURL, body)) {
      router.feed(delta);
    }
  } else {
    // ── Non-phobos: OpenAI SDK ──
    const streamParams = {
      model: COORDINATOR_MODEL,
      messages: allMessages as Array<{ role: 'user' | 'assistant' | 'system'; content: string }>,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      ...(Object.keys(extraBody).length > 0 ? { extra_body: extraBody } : {}),
    };

    let stream: Awaited<ReturnType<typeof coordinatorClient.chat.completions.create>>;
    try {
      stream = await coordinatorClient.chat.completions.create({
        ...streamParams,
        stream: true as const,
      });
    } catch (createErr: unknown) {
      console.error(`[coordinatorStream:error] ${createErr instanceof Error ? createErr.message : String(createErr)}`);
      console.log('[coordinatorStream:retry] Retrying without extra_body...');
      const { extra_body: _drop, ...fallbackParams } = streamParams as Record<string, unknown>;
      stream = await coordinatorClient.chat.completions.create({
        ...(fallbackParams as unknown as Parameters<typeof coordinatorClient.chat.completions.create>[0]),
        stream: true as const,
      });
    }

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as Record<string, unknown>;
      router.feed(delta);
    }
  }

  router.flush();
  const _csResult = ThinkingTokenRouter.finalStrip(router.getOutputBuf());
  await writePromptLog({
    role: 'sayon',
    stage: opts.stage ?? 'other',
    model: COORDINATOR_MODEL,
    prompt: formatPromptForLog(allMessages as Array<{ role: string; content: string }>),
    response: _csResult,
    latencyMs: Date.now() - t0,
  });
  return _csResult;
}

// ─── engineStream ────────────────────────────────────────────────────────────
// Streaming engine (SEREN) call with thinking strategy applied.
//
// For phobos provider: uses rawPhobosStream to preserve reasoning_content.
// For other providers: uses OpenAI SDK.
export async function engineStream(opts: {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  maxTokens: number;
  temperature: number;
  mode?: 'think' | 'no_think' | 'none';
  onThinkToken?: (token: string) => void;
  stage?: PromptStage;
}): Promise<string> {
  const { mode = 'think', onThinkToken } = opts;
  const t0 = Date.now();

  // Use module-level vars directly — we are in the same module so no CJS binding issue.
  const liveProvider = ENGINE_PROVIDER;
  const liveModel = ENGINE_MODEL;

  const { messages: stratMsgs, systemPrompt: stratSystem } = applyThinkingStrategy(
    opts.messages,
    opts.systemPrompt,
    liveProvider,
    liveModel,
    mode
  );

  const allMessages = stratSystem
    ? [{ role: 'system' as const, content: stratSystem }, ...stratMsgs]
    : stratMsgs;

  const extraBody = getThinkingExtraBody(liveProvider, liveModel, mode);
  console.log(`[engineStream] mode=${mode} provider=${liveProvider} model=${liveModel} extraBody=${JSON.stringify(extraBody)}`);

  const strategy = getThinkingStrategy(liveProvider, liveModel);
  const startInThinkCS = strategy.thinkingForcedOpen === true;
  const router = new ThinkingTokenRouter(strategy, mode, onThinkToken, startInThinkCS);

  if (isPhobosProvider(liveProvider)) {
    // ── Phobos: raw fetch to preserve reasoning_content ──
    const baseURL = clientBaseURL(engineClient);
    const body: Record<string, unknown> = {
      model: liveModel,
      messages: allMessages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      ...extraBody,
    };

    for await (const delta of rawPhobosStream(baseURL, body)) {
      router.feed(delta);
    }
  } else {
    // ── Non-phobos: OpenAI SDK ──
    const callParams: Record<string, unknown> = {
      model: liveModel,
      messages: allMessages,
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      ...(Object.keys(extraBody).length > 0 ? { ...extraBody } : {}),
    };

    let stream: Awaited<ReturnType<typeof engineClient.chat.completions.create>>;
    try {
      stream = await engineClient.chat.completions.create({
        ...(callParams as unknown as Parameters<typeof engineClient.chat.completions.create>[0]),
        stream: true as const,
      });
    } catch (createErr: unknown) {
      console.error(`[engineStream:error] ${createErr instanceof Error ? createErr.message : String(createErr)}`);
      const { extra_body: _drop, ...fallback } = callParams as Record<string, unknown>;
      stream = await engineClient.chat.completions.create({
        ...(fallback as unknown as Parameters<typeof engineClient.chat.completions.create>[0]),
        stream: true as const,
      });
    }

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as Record<string, unknown>;
      router.feed(delta);
    }
  }

  router.flush();
  const _esResult = ThinkingTokenRouter.finalStrip(router.getOutputBuf());
  await writePromptLog({
    role: 'seren',
    stage: opts.stage ?? 'other',
    model: liveModel,
    prompt: formatPromptForLog(allMessages as Array<{ role: string; content: string }>),
    response: _esResult,
    latencyMs: Date.now() - t0,
  });
  return _esResult;
}
