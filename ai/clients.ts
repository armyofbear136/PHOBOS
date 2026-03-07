import OpenAI from 'openai';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { ModelConfigStore, PROVIDERS, type RoleConfig } from '../db/ModelConfigStore.js';
import { reconcilePhobosServers } from '../phobos/LlamaServerManager.js';

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
  console.log(`[clients] ALLMIND: ${engine.provider} / ${engine.endpoint}  (${ENGINE_MODEL})`);

  // Start/stop llama-server if either role is on the phobos provider.
  // Fire-and-forget — server startup is async and may take a few seconds.
  reconcilePhobosServers({ coordinator, engine }).catch(err => {
    console.error(`[reconfigureClients] reconcilePhobosServers error: ${err.message}`);
  });
}

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
   *            providers via the OpenAI compat layer). StreamParser handles this.
   *            This is the correct path for:
   *              • Qwen3 on FastFlowLLM (always, no native thinking API)
   *              • Qwen3 on Ollama via /v1/ compat — Ollama's compat layer does NOT
   *                honour extra_body:{think:true}; you must use reasoning_effort OR
   *                the native /api/chat. Via /v1/ the model outputs raw <think> tags.
   *              • Llama3.x anywhere (system prompt instructs tags)
   *
   * 'field'  — thinking arrives in a dedicated delta field, NOT in delta.content.
   *            Read order: delta.thinking → delta.reasoning_content → delta.reasoning
   *            Used only when calling Ollama's NATIVE /api/chat endpoint directly
   *            (not the /v1/ compat layer).  Currently unused in this codebase.
   *
   * We use the OpenAI SDK which hits /v1/ on both providers, so 'tag' is always correct.
   */
  thinkingPath: 'tag' | 'field';
  /**
   * Extra fields to pass in extra_body to activate thinking.
   * For Ollama /v1/ compat: reasoning_effort:"high" is the correct param.
   * extra_body:{think:true} is silently ignored by Ollama's /v1/ compat layer.
   * For FastFlowLLM/Qwen3: no activation needed — Qwen3 always thinks by default.
   */
  extraBodyThink: Record<string, unknown>;
  /** extra_body for no_think mode */
  extraBodyNoThink: Record<string, unknown>;
}

export function getThinkingStrategy(provider: string, model: string): ThinkingStrategy {
  // PHOBOS Local — llama-server (llama.cpp) speaks the same OpenAI compat as Ollama.
  // Llama models: system prompt injection, tag path.
  // Qwen3 models: llama.cpp supports --think natively via extra_body, same as Ollama.
  if (provider === 'phobos') {
    if (model.startsWith('qwen3')) {
      return {
        systemSuffix: '',
        thinkingPath: 'tag',         // llama-server /v1 returns <think> in delta.content
        extraBodyThink: {},
        extraBodyNoThink: {},
      };
    }
    // Llama models — prompt-inject thinking
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
  // FastFlowLLM always exposes thinking in delta.reasoning_content regardless of model.
  // Ollama llama3.x does NOT have native thinking — no think:true support, no reasoning field.
  // For Ollama Llama: use system prompt injection + tag path (best-effort, model may ignore it).
  // For FastFlowLLM Llama: use field path — FastFlowLLM routes all thinking through reasoning_content.
  if (/^llama3[.\-:]/.test(model) || /^llama3\./.test(model)) {
    if (provider === 'fastflowllm') {
      return {
        systemSuffix: '',
        thinkingPath: 'field',
        extraBodyThink: {},
        extraBodyNoThink: {},
      };
    }
    // Ollama / other: prompt-engineer <think> tags (no native support)
    return {
      systemSuffix:
        '\n\nThink through the problem step by step before answering. ' +
        'Write your reasoning inside <think> tags, then give your final answer after the closing </think> tag.',
      thinkingPath: 'tag',
      extraBodyThink: {},
      extraBodyNoThink: {},
    };
  }

  // Cloud/unknown
  return { systemSuffix: '', thinkingPath: 'tag', extraBodyThink: {}, extraBodyNoThink: {} };
}

/**
 * Returns true if the model/provider combination natively emits thinking tokens.
 * Used by the UI to show/hide the SAYON reasoning panel gracefully.
 */
export function hasNativeThinking(provider: string, model: string): boolean {
  if (model.startsWith('qwen3')) return true;
  if (model.startsWith('deepseek-r1')) return true;
  if (/^llama3[.\-:]/.test(model)) return provider === 'fastflowllm'; // only if FastFlowLLM wraps it
  return false;
}


/**
 * Apply thinking strategy to a message array + system prompt before an API call.
 * FastFlowLLM Qwen3: injects /think or /no_think into the last user message.
 * Ollama Qwen3: no message changes needed — think:true in extra_body handles it.
 * Llama: appends thinking instructions to system prompt.
 */
export function applyThinkingStrategy(
  messages: Array<{ role: string; content: string }>,
  systemPrompt: string,
  provider: string,
  model: string,
  mode: 'think' | 'no_think' | 'none' = 'think'
): { messages: Array<{ role: string; content: string }>; systemPrompt: string } {
  if (mode === 'none') return { messages, systemPrompt };
  const strategy = getThinkingStrategy(provider, model);

  // Llama and FastFlowLLM Qwen3: system prompt injection for thinking mode
  if (strategy.systemSuffix && mode === 'think') {
    return { messages, systemPrompt: systemPrompt + strategy.systemSuffix };
  }

  // no_think mode for FastFlowLLM: no system suffix needed, model just won't be prompted to think
  // Ollama Qwen3 uses extra_body:{think:true/false} — no message change needed.

  return { messages, systemPrompt };
}

/**
 * Returns the extra_body fields needed to activate or suppress thinking.
 */
export function getThinkingExtraBody(provider: string, model: string, mode: 'think' | 'no_think' | 'none' = 'think'): Record<string, unknown> {
  if (mode === 'none') return {};
  const strategy = getThinkingStrategy(provider, model);
  return mode === 'no_think' ? strategy.extraBodyNoThink : strategy.extraBodyThink;
}

/**
 * Convenience wrapper: apply thinking strategy to a coordinator non-streaming call.
 * Handles both user prefix and system suffix injection transparently.
 */
export async function coordinatorCall(opts: {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  maxTokens: number;
  temperature: number;
  mode?: 'think' | 'no_think' | 'none';
}): Promise<string> {
  const { mode = 'think' } = opts;
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
    // FastFlowLLM may reject chat_template_kwargs — retry without it
    console.error(`[coordinatorCall:error] ${createErr instanceof Error ? createErr.message : String(createErr)}`);
    console.log('[coordinatorCall:retry] Retrying without extra_body...');
    const { extra_body: _drop, ...fallbackParams } = callParams as Record<string, unknown>;
    stream = await coordinatorClient.chat.completions.create({
      ...(fallbackParams as unknown as Parameters<typeof coordinatorClient.chat.completions.create>[0]),
      stream: true as const,
    });
  }

  const coordStrategy = getThinkingStrategy(COORDINATOR_PROVIDER, COORDINATOR_MODEL);
  let outputBuf = '';
  let inThink = false;
  let _callDbgN = 0;

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta as Record<string, unknown>;
    _callDbgN++;
    if (_callDbgN <= 2) {
      console.log(`[coordinatorCall:delta:${_callDbgN}] keys=${JSON.stringify(Object.keys(delta ?? {}))} content=${JSON.stringify((delta as any)?.content)} reasoning=${JSON.stringify((delta as any)?.reasoning)}`);
    }
    if (coordStrategy.thinkingPath === 'field') {
      // FastFlowLLM: delta.reasoning_content; Ollama: delta.reasoning — discard both here, only want output
      const d = delta as Record<string, unknown>;
      const outToken = d.content as string | null | undefined;
      if (outToken) outputBuf += outToken;
    } else {
      // FastFlowLLM: everything in delta.content, strip <think> tags
      const outToken = delta?.content as string | null | undefined;
      if (outToken) {
        let remaining = outToken;
        while (remaining.length > 0) {
          if (inThink) {
            const ci = remaining.indexOf('</think>');
            if (ci === -1) { remaining = ''; }
            else { inThink = false; remaining = remaining.slice(ci + 8); }
          } else {
            const oi = remaining.indexOf('<think>');
            if (oi === -1) { outputBuf += remaining; remaining = ''; }
            else { outputBuf += remaining.slice(0, oi); inThink = true; remaining = remaining.slice(oi + 7); }
          }
        }
      }
    }
  }

  return outputBuf.trim();
}

/**
 * Streaming coordinator call with thinking strategy applied.
 * Yields text content tokens; thinking tokens go to onThinkToken callback.
 */
export async function coordinatorStream(opts: {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  maxTokens: number;
  temperature: number;
  mode?: 'think' | 'no_think' | 'none';
  onThinkToken?: (token: string) => void;
}): Promise<string> {
  const { mode = 'think', onThinkToken } = opts;
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

  const strategy = getThinkingStrategy(COORDINATOR_PROVIDER, COORDINATOR_MODEL);
  let outputBuf = '';
  let inThink = false;
  let thinkBuf = '';

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta as Record<string, unknown>;

    if (strategy.thinkingPath === 'field') {
      // FastFlowLLM: delta.reasoning_content; Ollama: delta.reasoning — check all field names
      // FastFlowLLM also sends literal <think>/<think> as tokens inside the field — strip them.
      const d = delta as Record<string, unknown>;
      let thinkToken = (d.reasoning_content ?? d.reasoning ?? d.thinking) as string | null | undefined;
      const outToken = d.content as string | null | undefined;
      if (thinkToken) {
        thinkToken = thinkToken.replace(/<\/?think>/g, '');
        if (thinkToken) { thinkBuf += thinkToken; if (onThinkToken) onThinkToken(thinkToken); }
      }
      if (outToken) outputBuf += outToken;
    } else {
      // FastFlowLLM Qwen3 / Llama: everything in delta.content, <think> tags separate it
      const outToken = delta?.content as string | null | undefined;
      if (outToken) {
        let remaining = outToken;
        while (remaining.length > 0) {
          if (inThink) {
            const closeIdx = remaining.indexOf('</think>');
            if (closeIdx === -1) {
              thinkBuf += remaining;
              if (onThinkToken) onThinkToken(remaining);
              remaining = '';
            } else {
              const thinkChunk = remaining.slice(0, closeIdx);
              if (thinkChunk && onThinkToken) onThinkToken(thinkChunk);
              inThink = false;
              remaining = remaining.slice(closeIdx + '</think>'.length);
            }
          } else {
            const openIdx = remaining.indexOf('<think>');
            if (openIdx === -1) {
              outputBuf += remaining;
              remaining = '';
            } else {
              outputBuf += remaining.slice(0, openIdx);
              inThink = true;
              remaining = remaining.slice(openIdx + '<think>'.length);
            }
          }
        }
      }
    }
  }

  return outputBuf.trim();
}
