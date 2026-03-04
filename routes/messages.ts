import type { FastifyInstance } from 'fastify';
import { MessageStore } from '../db/MessageStore.js';
import { ThreadStore } from '../db/ThreadStore.js';
import { DocumentStore } from '../db/DocumentStore.js';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { DispatchLogStore } from '../db/DispatchLogStore.js';
import { MessageEventStore } from '../db/MessageEventStore.js';
import { ChatSummaryStore } from '../db/ChatSummaryStore.js';
import { ModelConfigStore } from '../db/ModelConfigStore.js';
import { IntentClassifier } from '../ai/IntentClassifier.js';
import { LoopController } from '../ai/LoopController.js';
import { ThreadWorkspace } from '../context/ThreadWorkspace.js';
import { CopilotIndex } from '../context/CopilotIndex.js';
import { ThinkingStripper } from '../context/ThinkingStripper.js';
import type { IntentType } from '../ai/IntentClassifier.js';
import { ENGINE_MODEL } from '../ai/clients.js';

export async function messagesRoute(fastify: FastifyInstance): Promise<void> {
  const db = DatabaseManager.getInstance();
  const messageStore = new MessageStore(db);
  const threadStore = new ThreadStore(db);
  const documentStore = new DocumentStore(db);
  const dispatchLogStore = new DispatchLogStore(db);
  const eventStore = new MessageEventStore(db);
  const summaryStore = new ChatSummaryStore(db);
  const configStore = new ModelConfigStore(db);
  const classifier = new IntentClassifier();
  const stripper = new ThinkingStripper();

  // Workspace and copilot index are module-level singletons —
  // they cache internally so no per-request filesystem walks.
  const workspace = new ThreadWorkspace(db);
  const copilotIndex = new CopilotIndex(db);

  // GET /api/threads/:id/messages
  fastify.get<{
    Params: { id: string };
    Querystring: { includeThinking?: string };
  }>('/api/threads/:id/messages', async (req, reply) => {
    const includeThinking = req.query.includeThinking === 'true';
    const messages = await messageStore.getByThread(req.params.id, includeThinking);
    const mapped = messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.created_at,
      thinking: m.thinking_trace ?? undefined,
    }));
    return reply.send(mapped);
  });

  // GET /api/threads/:id/events
  // Returns all persisted SSE events for history replay on thread load.
  // The frontend replays these in order to reconstruct file panels, coordinator
  // bubbles, and thinking traces exactly as they appeared during the stream.
  fastify.get<{ Params: { id: string } }>(
    '/api/threads/:id/events',
    async (req, reply) => {
      const events = await eventStore.getByThread(req.params.id);
      const mapped = events.map((e) => ({
        messageId: e.message_id,
        eventType: e.event_type,
        payload: JSON.parse(e.payload),
        seq: e.seq,
        createdAt: e.created_at,
      }));
      return reply.send(mapped);
    }
  );

  // GET /api/threads/:id/workspace
  // Returns the workspace index for a thread — file list with notes.
  fastify.get<{ Params: { id: string } }>(
    '/api/threads/:id/workspace',
    async (req, reply) => {
      const index = await workspace.getIndex(req.params.id);
      return reply.send(index);
    }
  );

  // GET /api/threads/:id/workspace/:filename
  // Returns the content of a specific file in the workspace.
  fastify.get<{ Params: { id: string; filename: string } }>(
    '/api/threads/:id/workspace/*',
    async (req, reply) => {
      // Fastify captures wildcard as params['*']
      const filename = (req.params as Record<string, string>)['*'];
      const content = await workspace.readFile(req.params.id, filename);
      if (content === null) return reply.status(404).send({ error: 'File not found' });
      return reply.send({ filename, content });
    }
  );

  // POST /api/threads/:id/workspace/:filename
  // User writes a file directly into the workspace.
  fastify.post<{
    Params: { id: string };
    Body: { filename: string; content: string };
  }>('/api/threads/:id/workspace', async (req, reply) => {
    const { filename, content } = req.body;
    await workspace.writeFile(req.params.id, filename, content, 'user');
    return reply.status(201).send({ ok: true, filename });
  });

  // DELETE /api/threads/:id/workspace/:filename
  fastify.delete<{ Params: { id: string } }>(
    '/api/threads/:id/workspace/*',
    async (req, reply) => {
      const filename = (req.params as Record<string, string>)['*'];
      await workspace.deleteFile(req.params.id, filename);
      return reply.status(204).send();
    }
  );

  // GET /api/copilot/overview
  // Returns the system-wide workspace overview for the Copilot panel.
  fastify.get('/api/copilot/overview', async (_req, reply) => {
    const overview = await copilotIndex.renderSystemOverview();
    return reply.send({ overview });
  });

  // GET /api/copilot/search?q=...
  // Search workspace file notes across all threads.
  fastify.get<{ Querystring: { q?: string; content?: string } }>(
    '/api/copilot/search',
    async (req, reply) => {
      const query = req.query.q ?? '';
      if (!query) return reply.send({ results: [] });
      const results = req.query.content === 'true'
        ? await copilotIndex.searchContents(query)
        : await copilotIndex.searchNotes(query);
      return reply.send({ results });
    }
  );

  /**
   * POST /api/threads/:id/messages
   *
   * Main SSE endpoint. Flow:
   * 1. Store user message
   * 2. Ensure workspace directory exists
   * 3. Classify intent (parallel with context loading)
   * 4. Build context: documents + workspace index (cached, no filesystem walk)
   * 5. Route: QUESTION/DOCUMENT_EDIT → coordinator direct; CODE/PLAN → LoopController
   * 6. After engine completes: update workspace index with any new/changed files
   * 7. Store final message + dispatch log
   */
  fastify.post<{
    Params: { id: string };
    Body: {
      content: string;
      project_root?: string;
      build_command?: string;
      skip_build?: boolean;
      attached_files?: Array<{ name: string; content: string }>;
    };
  }>('/api/threads/:id/messages', async (req, reply) => {
    const { id: threadId } = req.params;
    const { content, build_command, skip_build, attached_files } = req.body;

    // Validate/create thread
    let thread = await threadStore.getById(threadId);
    if (!thread) {
      await threadStore.insert({
        id: threadId,
        title: content.slice(0, 40),
        project_id: 'default',
      });
      thread = await threadStore.getById(threadId);
    }

    // Ensure workspace directory exists for this thread
    const workspaceDir = await workspace.ensureWorkspace(threadId);

    // Store user message
    await messageStore.insert({
      thread_id: threadId,
      role: 'user',
      content,
    });

    // Inline any attached files into the message and write them to the workspace
    let fullUserMessage = content;
    if (attached_files && attached_files.length > 0) {
      for (const f of attached_files) {
        // Write to workspace so the engine can reference by path next time
        await workspace.writeFile(threadId, f.name, f.content, 'user');
      }
      const fileBlock = attached_files
        .map((f) => `<file path="${f.name}">\n${f.content}\n</file>`)
        .join('\n\n');
      fullUserMessage += `\n\n<attached_files>\n${fileBlock}\n</attached_files>`;
    }

    // SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });

    const sendEvent = (data: object): void => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // Classify intent and load context in parallel — they're independent
      const [intent, docs, workspaceIndex] = await Promise.all([
        classifier.classify(content),
        documentStore.loadContextBundle(thread!.project_id, threadId),
        workspace.renderIndex(threadId),   // cached — no filesystem walk on cache hit
      ]);

      sendEvent({ type: 'status', content: 'Classifying intent…' });

      const history = await messageStore.getContextHistory(threadId, summaryStore);
      const priorHistory = history.slice(0, -1);

      // Collect all status events so we can persist them as a single activity event after the turn
      const activityLog: string[] = [];
      const trackingsendEvent = (data: object): void => {
        sendEvent(data);
        if ((data as any).type === 'status') activityLog.push((data as any).content as string);
      };

      // Route based on intent
      if (intent.type === 'QUESTION') {
        trackingsendEvent({ type: 'status', content: 'Answering directly via coordinator…' });
        const directMsgId = await handleDirectResponse(
          threadId,
          fullUserMessage,
          intent.type,
          docs,
          priorHistory,
          messageStore,
          eventStore,
          trackingsendEvent
        );
        if (directMsgId && activityLog.length > 0) {
          await eventStore.insert(threadId, 'activity', { type: 'activity', events: activityLog }, directMsgId);
        }
      } else {
        // CODE_REQUEST or PLAN_REQUEST — run the full loop
        const dispatchLog = await dispatchLogStore.insert({
          model: ENGINE_MODEL,
          task_type: intent.type,
          result: 'PENDING',
        });

        // Pre-create the assistant message so we have an ID to attach events to.
        // Content will be updated after the loop completes.
        const assistantMsg = await messageStore.insert({
          thread_id: threadId,
          role: 'assistant',
          content: '',
        });

        // Intercept status events before they hit the wire so we can persist the full
        // activity log after the loop finishes — enables gizmo replay on refresh.
        const loopActivityLog: string[] = [];
        const origWrite = reply.raw.write.bind(reply.raw) as (chunk: any) => boolean;
        (reply.raw as any).write = (chunk: any): boolean => {
          try {
            const str: string = typeof chunk === 'string' ? chunk : chunk.toString();
            const match = str.match(/^data: (.+)\n\n$/);
            if (match) {
              const evt = JSON.parse(match[1]) as { type: string; content?: string };
              if (evt.type === 'status' && evt.content) loopActivityLog.push(evt.content);
            }
          } catch { /* non-SSE chunk, ignore */ }
          return origWrite(chunk);
        };

        const loopController = new LoopController({
          buildCommand: build_command ?? extractBuildCommand(docs.claudeMd),
          projectRoot: workspaceDir,
          workspaceDir: workspaceDir,
          skipBuild: skip_build ?? !hasBuildCommand(docs.claudeMd),
          maxAttempts: 3,
          persistEvent: async (eventType, payload) => {
            await eventStore.insert(threadId, eventType as any, payload, assistantMsg.id);
          },
        });

        const startTime = Date.now();
        const attempts = await loopController.run(reply, {
          userMessage: fullUserMessage,
          intentType: intent.type as IntentType,
          claudeMd: docs.claudeMd,
          projectMd: docs.projectMd,
          chatMd: docs.chatMd,
          conversationHistory: priorHistory,
          repoMap: workspaceIndex,
          loadedFiles: (attached_files ?? []).map((f) => ({ path: f.name, content: f.content })),
        }, assistantMsg.id);

        const latencyMs = Date.now() - startTime;
        const bestAttempt = attempts.reduce(
          (best, curr) => (curr.reviewScore > best.reviewScore ? curr : best),
          attempts[0]
        );

        if (bestAttempt) {
          const strippedOutput = stripper.strip(bestAttempt.output).output;
          // Update the pre-created assistant message with final content
          await db.run(
            `UPDATE messages SET content = ?, thinking_trace = ?, attempt_number = ?, review_score = ?
             WHERE id = ?`,
            [
              strippedOutput || bestAttempt.output,
              bestAttempt.thinking || null,
              bestAttempt.attemptNumber,
              bestAttempt.reviewScore,
              assistantMsg.id,
            ]
          );

          await dispatchLogStore.updateResult(
            dispatchLog.id,
            bestAttempt.approved ? 'APPROVE' : 'REJECT',
            {
              latency_ms: latencyMs,
              review_score: bestAttempt.reviewScore,
              think_tokens: Math.ceil(bestAttempt.thinking.length / 4),
              output_tokens: Math.ceil(bestAttempt.output.length / 4),
            }
          );

          workspace.getIndex(threadId).catch(() => {});
        }

        // Restore original write now that loop is done
        (reply.raw as any).write = origWrite;

        // Persist final activity log so the gizmo can be replayed on refresh
        if (loopActivityLog.length > 0) {
          await eventStore.insert(threadId, 'activity', { type: 'activity', events: loopActivityLog }, assistantMsg.id);
        }
      }

      await threadStore.touch(threadId);

      // Generate rolling summary — blocks done so it's always current before next turn.
      // Fire-and-forget on error (never fail a turn just because summarisation failed).
      try {
        await generateAndPersistSummary(threadId, messageStore, summaryStore, configStore);
      } catch (summaryErr) {
        console.error('[messagesRoute] Summary generation failed (non-fatal):', summaryErr);
      }
    } catch (err: unknown) {
      console.error('[messagesRoute] Error:', err);
      sendEvent({
        type: 'error',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      reply.raw.write('data: {"type":"done"}\n\n');
      reply.raw.end();
    }
  });

  /**
   * POST /api/copilot/messages
   * Direct coordinator access for the Copilot panel.
   * Injects the system-wide overview so the Copilot has full context.
   */
  fastify.post<{ Body: { content: string } }>(
    '/api/copilot/messages',
    async (req, reply) => {
      const { content } = req.body;

      const globalThreadId = 'copilot-global';
      const thread = await threadStore.getById(globalThreadId);
      if (!thread) {
        await threadStore.insert({
          id: globalThreadId,
          title: 'Copilot Global Chat',
          project_id: 'default',
        });
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });

      const sendEvent = (data: object): void => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      try {
        // Load system overview for copilot context
        const systemOverview = await copilotIndex.renderSystemOverview();
        const docs = await documentStore.loadContextBundle('default', globalThreadId);

        await handleDirectResponse(
          globalThreadId,
          content,
          'QUESTION',
          {
            ...docs,
            // Prepend system overview to claudeMd so the copilot sees all workspaces
            claudeMd: `${docs.claudeMd}\n\n${systemOverview}`,
          },
          [],
          messageStore,
          eventStore,
          (event: Record<string, unknown>) => {
            if (event.type === 'output_token') {
              sendEvent({ type: 'token', token: event.token });
            } else {
              sendEvent(event);
            }
          }
        );
      } catch (err) {
        console.error('[CopilotRoute] Error:', err);
        sendEvent({ type: 'error', message: 'Coordinator unavailable' });
      } finally {
        reply.raw.end();
      }
    }
  );
}

async function handleDirectResponse(
  threadId: string,
  userMessage: string,
  intentType: string,
  docs: { claudeMd: string; projectMd: string; chatMd: string },
  history: Array<{ role: string; content: string }>,
  messageStore: MessageStore,
  eventStore: MessageEventStore,
  sendEvent: (data: object) => void
): Promise<string | null> {
  const { coordinatorClient, COORDINATOR_MODEL } = await import('../ai/clients.js');

  const systemParts: string[] = [];
  if (docs.claudeMd) systemParts.push(docs.claudeMd);
  if (docs.projectMd) systemParts.push(`\n\nProject context:\n${docs.projectMd}`);
  if (docs.chatMd) systemParts.push(`\n\nChat rules:\n${docs.chatMd}`);
  const systemPrompt = systemParts.join('') || 'You are a helpful coding assistant.';

  const messages = [
    ...history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user' as const, content: `/think ${userMessage}` },
  ];

  try {
    const stream = await coordinatorClient.chat.completions.create({
      model: COORDINATOR_MODEL,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      max_tokens: 8192,
      temperature: 0.3,
      stream: true,
    });

    let thinkingBuf = '';
    let outputBuf = '';

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as Record<string, unknown>;
      const thinkToken = (delta?.reasoning_content ?? delta?.reasoning) as string | undefined;
      const outToken = delta?.content as string | undefined;
      if (thinkToken) {
        thinkingBuf += thinkToken;
        sendEvent({ type: 'think_token', token: thinkToken });
      }
      if (outToken) {
        outputBuf += outToken;
        sendEvent({ type: 'output_token', token: outToken });
      }
    }

    const msg = await messageStore.insert({
      thread_id: threadId,
      role: 'assistant',
      content: outputBuf || thinkingBuf,
      thinking_trace: thinkingBuf || null,
    });

    if (thinkingBuf) {
      sendEvent({ type: 'thinking_complete', content: thinkingBuf });
      await eventStore.insert(threadId, 'thinking_complete', { type: 'thinking_complete', content: thinkingBuf }, msg.id);
    }

    await eventStore.insert(threadId, 'coordinator', { type: 'coordinator', content: 'Answering directly via coordinator…' }, msg.id);

    sendEvent({ type: 'complete', approved: true, bestAttempt: 1 });
    return msg.id;
  } catch (err) {
    console.error('[handleDirectResponse] Error:', err);
    sendEvent({ type: 'error', message: 'Coordinator unavailable' });
    return null;
  }
}

/**
 * Generates a rolling chat summary using the coordinator (fast, /no_think).
 *
 * Budget rules (matching getContextHistory):
 *   - Summary must be ≤ 800 tokens (~3200 chars) — enough for rich context,
 *     small enough to never crowd the coordinator's own window.
 *   - We feed the last 6 raw messages + any existing summary as source material.
 *   - The coordinator is instructed to produce structured prose: what was
 *     requested, what was done, which files changed, key decisions.
 */
async function generateAndPersistSummary(
  threadId: string,
  messageStore: MessageStore,
  summaryStore: ChatSummaryStore,
  configStore: ModelConfigStore
): Promise<void> {
  const { coordinatorClient, COORDINATOR_MODEL } = await import('../ai/clients.js');

  // Get raw message count for the record
  const allMessages = await messageStore.getByThread(threadId, false);
  const messageCount = allMessages.length;
  if (messageCount < 2) return; // nothing meaningful to summarise yet

  // Gather source material: existing summary + last 6 turns
  const existing = await summaryStore.get(threadId);
  const recent = allMessages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-6)
    .map((m) => `[${m.role.toUpperCase()}]\n${m.content}`)
    .join('\n\n');

  const contextWindow = await configStore.getCoordinatorContextWindow();
  // Budget: summary output ≤ 800 tokens; input fed to coordinator ≤ 20% of context window
  const inputBudgetChars = Math.min(contextWindow * 4 * 0.20, 12_000);
  const sourceText = existing?.summary
    ? `Prior summary:\n${existing.summary}\n\nRecent messages:\n${recent}`
    : recent;
  const truncated = sourceText.slice(0, inputBudgetChars);

  const prompt =
    `/no_think Produce a structured rolling summary of this conversation thread. ` +
    `Write in concise prose. Include: what the user requested, what was done, ` +
    `which files were changed or created, and any important decisions or caveats. ` +
    `Max 800 tokens. Do not include greetings or meta-commentary.\n\n` +
    `---\n${truncated}\n---`;

  const response = await coordinatorClient.chat.completions.create({
    model: COORDINATOR_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 900,
    temperature: 0.1,
    stream: false,
  });

  const summary = response.choices[0]?.message?.content?.trim();
  if (summary) {
    await summaryStore.upsert(threadId, summary, messageCount);
  }
}

function extractBuildCommand(claudeMd: string): string {
  const match = claudeMd.match(/##\s*Build\s*Command\s*\n+(.+)/i);
  return match?.[1]?.trim() ?? 'npm run build';
}

function hasBuildCommand(claudeMd: string): boolean {
  return /##\s*Build\s*Command/i.test(claudeMd);
}
