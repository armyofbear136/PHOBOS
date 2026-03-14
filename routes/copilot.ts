import type { FastifyInstance } from 'fastify';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { MessageStore } from '../db/MessageStore.js';
import { ThreadStore } from '../db/ThreadStore.js';
import { CopilotMemoryStore } from '../db/CopilotMemoryStore.js';
import { CopilotIndex } from '../context/CopilotIndex.js';
import { buildCopilotSystemPrompt, COPILOT_THREAD_IDS, type CopilotPersona } from '../ai/CopilotPersonas.js';

/**
 * Registers all copilot routes.
 *
 * POST /api/copilot/sayon   — stream a SAYON copilot response
 * POST /api/copilot/seren   — stream a SEREN copilot response
 * GET  /api/copilot/:persona/messages — load persisted history
 * GET  /api/copilot/overview — system-wide workspace overview
 * GET  /api/copilot/search   — cross-workspace search
 * POST /api/copilot/memory   — manual memory store (optional)
 * GET  /api/copilot/memory/:persona — list memories
 */
export async function registerCopilotRoutes(fastify: FastifyInstance): Promise<void> {
  const db = DatabaseManager.getInstance();
  const threadStore = new ThreadStore(db);
  const messageStore = new MessageStore(db);
  const memoryStore = new CopilotMemoryStore(db);
  const copilotIndex = new CopilotIndex(db);

  // Ensure memory table exists
  await memoryStore.ensureTable();

  // Ensure both copilot threads exist
  for (const [persona, threadId] of Object.entries(COPILOT_THREAD_IDS)) {
    const existing = await threadStore.getById(threadId);
    if (!existing) {
      await threadStore.insert({
        id: threadId,
        title: `Copilot — ${persona.toUpperCase()}`,
        project_id: 'default',
      });
    }
  }

  // ── GET /api/copilot/overview ───────────────────────────────────────────
  fastify.get('/api/copilot/overview', async (_req, reply) => {
    const overview = await copilotIndex.renderSystemOverview();
    return reply.send({ overview });
  });

  // ── GET /api/copilot/search?q=... ───────────────────────────────────────
  fastify.get<{ Querystring: { q: string } }>(
    '/api/copilot/search',
    async (req, reply) => {
      const query = req.query.q ?? '';
      const results = query.length > 2
        ? await copilotIndex.searchContents(query)
        : await copilotIndex.searchNotes(query);
      return reply.send({ results });
    }
  );

  // ── GET /api/copilot/:persona/messages ──────────────────────────────────
  fastify.get<{ Params: { persona: string } }>(
    '/api/copilot/:persona/messages',
    async (req, reply) => {
      const persona = req.params.persona as CopilotPersona;
      const threadId = COPILOT_THREAD_IDS[persona];
      if (!threadId) return reply.status(400).send({ error: 'Invalid persona' });
      const messages = await messageStore.getByThread(threadId, false);
      return reply.send({ messages });
    }
  );

  // ── GET /api/copilot/memory/:persona ────────────────────────────────────
  fastify.get<{ Params: { persona: string }; Querystring: { category?: string } }>(
    '/api/copilot/memory/:persona',
    async (req, reply) => {
      const persona = req.params.persona as CopilotPersona;
      if (!COPILOT_THREAD_IDS[persona]) return reply.status(400).send({ error: 'Invalid persona' });
      const memories = await memoryStore.recall(persona, req.query.category);
      return reply.send({ memories });
    }
  );

  // ── POST /api/copilot/sayon ─────────────────────────────────────────────
  fastify.post<{ Body: { content: string } }>(
    '/api/copilot/sayon',
    async (req, reply) => {
      await handleCopilotStream('sayon', req.body.content, reply, {
        messageStore, memoryStore, copilotIndex,
      });
    }
  );

  // ── POST /api/copilot/seren ─────────────────────────────────────────────
  fastify.post<{ Body: { content: string } }>(
    '/api/copilot/seren',
    async (req, reply) => {
      await handleCopilotStream('seren', req.body.content, reply, {
        messageStore, memoryStore, copilotIndex,
      });
    }
  );
}

// ─── STREAMING HANDLER ────────────────────────────────────────────────────────

interface CopilotDeps {
  messageStore: MessageStore;
  memoryStore: CopilotMemoryStore;
  copilotIndex: CopilotIndex;
}

async function handleCopilotStream(
  persona: CopilotPersona,
  userContent: string,
  reply: any,
  deps: CopilotDeps
): Promise<void> {
  const { messageStore, memoryStore, copilotIndex } = deps;
  const threadId = COPILOT_THREAD_IDS[persona];

  // Persist user message
  await messageStore.insert({
    thread_id: threadId,
    role: 'user',
    content: userContent,
  });

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });

  const sendEvent = (data: Record<string, unknown>): void => {
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Build context
    const [systemOverview, memoryContext] = await Promise.all([
      copilotIndex.renderSystemOverview(),
      memoryStore.renderMemoryContext(persona),
    ]);

    const systemPrompt = buildCopilotSystemPrompt(persona, systemOverview, memoryContext);

    // Load conversation history (last 15 messages for context)
    const allMessages = await messageStore.getByThread(threadId, false);
    const history = allMessages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-15)
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    // Route to the correct model
    if (persona === 'sayon') {
      await streamSayon(systemPrompt, history, sendEvent, threadId, messageStore, memoryStore);
    } else {
      await streamSeren(systemPrompt, history, sendEvent, threadId, messageStore, memoryStore);
    }
  } catch (err) {
    console.error(`[Copilot:${persona}] Error:`, err);
    sendEvent({ type: 'error', message: `${persona.toUpperCase()} unavailable` });
  } finally {
    reply.raw.end();
  }
}

// ─── SAYON STREAM (coordinator client) ────────────────────────────────────────

async function streamSayon(
  systemPrompt: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  sendEvent: (data: Record<string, unknown>) => void,
  threadId: string,
  messageStore: MessageStore,
  memoryStore: CopilotMemoryStore
): Promise<void> {
  const {
    coordinatorClient, COORDINATOR_MODEL,
    getThinkingStrategy, getThinkingExtraBody,
    applyThinkingStrategy, COORDINATOR_PROVIDER,
  } = await import('../ai/clients.js');

  const strategy = getThinkingStrategy(COORDINATOR_PROVIDER, COORDINATOR_MODEL);
  const fullSystem = systemPrompt + strategy.systemSuffix;

  const { messages: stratMessages } = applyThinkingStrategy(
    history, fullSystem, COORDINATOR_PROVIDER, COORDINATOR_MODEL, 'think'
  );

  const coordMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: fullSystem },
    ...stratMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  ];

  const extraBody = getThinkingExtraBody(COORDINATOR_PROVIDER, COORDINATOR_MODEL, 'think');

  let stream: any;
  try {
    stream = await coordinatorClient.chat.completions.create({
      model: COORDINATOR_MODEL,
      messages: coordMessages,
      max_tokens: 4096,
      temperature: 0.4,
      stream: true as const,
      ...(Object.keys(extraBody).length > 0 ? { extra_body: extraBody } : {}),
    });
  } catch {
    stream = await coordinatorClient.chat.completions.create({
      model: COORDINATOR_MODEL,
      messages: coordMessages,
      max_tokens: 4096,
      temperature: 0.4,
      stream: true as const,
    });
  }

  let outputBuf = '';
  let thinkBuf = '';
  let inThinkTag = false;

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta as Record<string, unknown>;

    if (strategy.thinkingPath === 'field') {
      let thinkToken = (delta.reasoning_content ?? delta.reasoning ?? delta.thinking) as string | null | undefined;
      const outToken = delta.content as string | null | undefined;
      if (thinkToken) {
        thinkToken = thinkToken.replace(/<\/?think>/g, '');
        if (thinkToken) {
          thinkBuf += thinkToken;
          // Emit as copilot_thinking — NOT think_token / thinking_segment
          sendEvent({ type: 'copilot_thinking', token: thinkToken });
        }
      }
      if (outToken) {
        outputBuf += outToken;
        sendEvent({ type: 'token', token: outToken });
      }
    } else {
      const rawContent = delta?.content as string | null | undefined;
      if (rawContent) {
        let remaining = rawContent;
        while (remaining.length > 0) {
          if (inThinkTag) {
            const closeIdx = remaining.indexOf('</think>');
            if (closeIdx === -1) {
              thinkBuf += remaining;
              sendEvent({ type: 'copilot_thinking', token: remaining });
              remaining = '';
            } else {
              const before = remaining.slice(0, closeIdx);
              if (before) {
                thinkBuf += before;
                sendEvent({ type: 'copilot_thinking', token: before });
              }
              inThinkTag = false;
              remaining = remaining.slice(closeIdx + '</think>'.length);
            }
          } else {
            const openIdx = remaining.indexOf('<think>');
            if (openIdx === -1) {
              outputBuf += remaining;
              sendEvent({ type: 'token', token: remaining });
              remaining = '';
            } else {
              const before = remaining.slice(0, openIdx);
              if (before) {
                outputBuf += before;
                sendEvent({ type: 'token', token: before });
              }
              inThinkTag = true;
              remaining = remaining.slice(openIdx + '<think>'.length);
            }
          }
        }
      }
    }
  }

  // Persist assistant message — NO thinking_segments writes, NO thinking_trace in DB
  const finalContent = outputBuf.trim() || '(no output)';
  await messageStore.insert({
    thread_id: threadId,
    role: 'assistant',
    content: finalContent,
  });

  // Check for memory store requests in output (simple inline format)
  await extractAndStoreMemories(finalContent, 'sayon', memoryStore);

  sendEvent({ type: 'complete' });
}

// ─── SEREN STREAM (engine client) ─────────────────────────────────────────────

async function streamSeren(
  systemPrompt: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  sendEvent: (data: Record<string, unknown>) => void,
  threadId: string,
  messageStore: MessageStore,
  memoryStore: CopilotMemoryStore
): Promise<void> {
  const {
    engineClient, ENGINE_MODEL,
    getThinkingStrategy, getThinkingExtraBody,
    applyThinkingStrategy, ENGINE_PROVIDER,
  } = await import('../ai/clients.js');

  const strategy = getThinkingStrategy(ENGINE_PROVIDER, ENGINE_MODEL);
  const fullSystem = systemPrompt + strategy.systemSuffix;

  const { messages: stratMessages } = applyThinkingStrategy(
    history, fullSystem, ENGINE_PROVIDER, ENGINE_MODEL, 'think'
  );

  const engineBaseURL = ((engineClient as unknown as { baseURL?: string }).baseURL ?? '').replace(/\/$/, '');
  const extraBody = getThinkingExtraBody(ENGINE_PROVIDER, ENGINE_MODEL, 'think');

  const allMessages: Array<{ role: string; content: string }> = [
    { role: 'system', content: fullSystem },
    ...stratMessages.map(m => ({ role: m.role, content: m.content })),
  ];

  const callParams: Record<string, unknown> = {
    model: ENGINE_MODEL,
    messages: allMessages,
    max_tokens: 8192,
    temperature: 0.4,
    stream: true,
    ...(Object.keys(extraBody).length > 0 ? { ...extraBody } : {}),
  };

  let outputBuf = '';
  let thinkBuf = '';

  // Phobos provider: raw fetch to preserve reasoning_content
  if (ENGINE_PROVIDER === 'phobos') {
    const resp = await fetch(`${engineBaseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(callParams),
    });
    if (!resp.ok || !resp.body) throw new Error(`[Copilot:seren] HTTP ${resp.status}`);

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
        if (json === '[DONE]') break;
        try {
          const parsed = JSON.parse(json);
          const delta = parsed?.choices?.[0]?.delta as Record<string, unknown> | undefined;
          if (!delta) continue;

          if (strategy.thinkingPath === 'field') {
            let thinkToken = (delta.reasoning_content ?? delta.reasoning ?? delta.thinking) as string | null | undefined;
            const outToken = delta.content as string | null | undefined;
            if (thinkToken) {
              thinkToken = thinkToken.replace(/<\/?think>/g, '');
              if (thinkToken) {
                thinkBuf += thinkToken;
                sendEvent({ type: 'copilot_thinking', token: thinkToken });
              }
            }
            if (outToken) {
              outputBuf += outToken;
              sendEvent({ type: 'token', token: outToken });
            }
          } else {
            const outToken = delta.content as string | null | undefined;
            if (outToken) {
              outputBuf += outToken;
              sendEvent({ type: 'token', token: outToken });
            }
          }
        } catch { /* malformed chunk */ }
      }
    }
  } else {
    // Non-phobos: OpenAI SDK stream
    let stream: any;
    try {
      stream = await engineClient.chat.completions.create({
        ...(callParams as any),
      });
    } catch {
      const { extra_body: _drop, ...fallback } = callParams;
      stream = await engineClient.chat.completions.create({
        ...(fallback as any),
        stream: true,
      });
    }

    let inThinkTag = false;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as Record<string, unknown>;
      if (strategy.thinkingPath === 'field') {
        let thinkToken = (delta.reasoning_content ?? delta.reasoning ?? delta.thinking) as string | null | undefined;
        const outToken = delta.content as string | null | undefined;
        if (thinkToken) {
          thinkToken = thinkToken.replace(/<\/?think>/g, '');
          if (thinkToken) {
            thinkBuf += thinkToken;
            sendEvent({ type: 'copilot_thinking', token: thinkToken });
          }
        }
        if (outToken) {
          outputBuf += outToken;
          sendEvent({ type: 'token', token: outToken });
        }
      } else {
        const rawContent = delta?.content as string | null | undefined;
        if (rawContent) {
          let remaining = rawContent;
          while (remaining.length > 0) {
            if (inThinkTag) {
              const closeIdx = remaining.indexOf('</think>');
              if (closeIdx === -1) {
                thinkBuf += remaining;
                sendEvent({ type: 'copilot_thinking', token: remaining });
                remaining = '';
              } else {
                const before = remaining.slice(0, closeIdx);
                if (before) {
                  thinkBuf += before;
                  sendEvent({ type: 'copilot_thinking', token: before });
                }
                inThinkTag = false;
                remaining = remaining.slice(closeIdx + '</think>'.length);
              }
            } else {
              const openIdx = remaining.indexOf('<think>');
              if (openIdx === -1) {
                outputBuf += remaining;
                sendEvent({ type: 'token', token: remaining });
                remaining = '';
              } else {
                const before = remaining.slice(0, openIdx);
                if (before) {
                  outputBuf += before;
                  sendEvent({ type: 'token', token: before });
                }
                inThinkTag = true;
                remaining = remaining.slice(openIdx + '<think>'.length);
              }
            }
          }
        }
      }
    }
  }

  // Persist assistant message — NO thinking_segments, NO thinking_trace
  const finalContent = outputBuf.trim() || '(no output)';
  await messageStore.insert({
    thread_id: threadId,
    role: 'assistant',
    content: finalContent,
  });

  await extractAndStoreMemories(finalContent, 'seren', memoryStore);

  sendEvent({ type: 'complete' });
}

// ─── MEMORY EXTRACTION ────────────────────────────────────────────────────────

/**
 * Scans model output for inline memory-store directives.
 * Format: [REMEMBER category:key=value]
 * e.g. [REMEMBER user_preferences:language=TypeScript]
 *
 * This is a lightweight fallback. The primary path is tool-use via
 * copilot_remember, but small models sometimes emit inline instead.
 */
async function extractAndStoreMemories(
  output: string,
  persona: CopilotPersona,
  memoryStore: CopilotMemoryStore
): Promise<void> {
  const pattern = /\[REMEMBER\s+(\w+):([^=]+)=([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    const [, category, key, value] = match;
    try {
      await memoryStore.store(persona, category.trim(), key.trim(), value.trim());
      console.log(`[Copilot:${persona}] Stored memory: ${category}/${key}`);
    } catch (err) {
      console.warn(`[Copilot:${persona}] Memory store failed:`, err);
    }
  }
}
