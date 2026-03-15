import type { FastifyInstance } from 'fastify';
import { MessageStore } from '../db/MessageStore.js';
import { ThreadStore } from '../db/ThreadStore.js';
import { DocumentStore } from '../db/DocumentStore.js';
import { DatabaseManager } from '../db/DatabaseManager.js';

const DEBUG = process.env.PHOBOS_DEBUG === '1' || process.env.PHOBOS_DEBUG === 'true';
const dbg = (...args: unknown[]) => { if (DEBUG) console.log(...args); };
import { DispatchLogStore } from '../db/DispatchLogStore.js';
import { MessageEventStore } from '../db/MessageEventStore.js';
import { ThinkingSegmentStore } from '../db/ThinkingSegmentStore.js';
import { ChatSummaryStore } from '../db/ChatSummaryStore.js';
import { ModelConfigStore } from '../db/ModelConfigStore.js';
import { KnowledgeStore } from '../db/KnowledgeStore.js';
import { IntentClassifier } from '../ai/IntentClassifier.js';
import { LoopController } from '../ai/LoopController.js';
import { ThreadWorkspace } from '../context/ThreadWorkspace.js';
import { ThinkingStripper } from '../context/ThinkingStripper.js';
import type { IntentType } from '../ai/IntentClassifier.js';
import type { ClassificationContext } from '../ai/IntentClassifier.js';
import { ENGINE_MODEL, COORDINATOR_MODEL as COORD_MODEL_REF, COORDINATOR_PROVIDER, getThinkingStrategy, setLogContext, clearLogContext } from '../ai/clients.js';
import * as fs from 'fs';
import * as path from 'path';
import { exec, execFile, spawn } from 'child_process';

export async function messagesRoute(fastify: FastifyInstance): Promise<void> {
  const db = DatabaseManager.getInstance();
  const messageStore = new MessageStore(db);
  const threadStore = new ThreadStore(db);
  const documentStore = new DocumentStore(db);
  const dispatchLogStore = new DispatchLogStore(db);
  const eventStore = new MessageEventStore(db);
  const segmentStore = new ThinkingSegmentStore(db);
  const summaryStore = new ChatSummaryStore(db);
  const configStore = new ModelConfigStore(db);
  const knowledgeStore = new KnowledgeStore(db);
  const classifier = new IntentClassifier();
  const stripper = new ThinkingStripper();

  // Workspace is a module-level singleton —
  // it caches internally so no per-request filesystem walks.
  const workspace = new ThreadWorkspace(db);

  // Tracks threads that are mid-clarification. When the user responds to a
  // NEEDS_CLARIFICATION question, we skip classification and route directly
  // to LoopController with the original intent — the response must reach
  // SEREN, not be handled by SAYON as a new standalone request.
  const pendingClarification = new Map<string, {
    originalIntent: IntentType;
    count: number;                  // how many clarification rounds so far
    originalRequest: string;
    // Accumulated Q&A log. Each entry records what SEREN asked and what
    // the user replied, in order. Injected as <clarification_history> into
    // ContextIngester and TaskPlanner so neither loses the thread between turns.
    log: Array<{ questions: string[]; userReply: string }>;
  }>();

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

  // GET /api/threads/:id/thinking
  // Returns all thinking segments for the thread in chronological order.
  // This is the single source of truth for the reasoning panel — built in real time
  // via per-token UPDATEs so it is always current, even mid-stream.
  fastify.get<{ Params: { id: string } }>(
    '/api/threads/:id/thinking',
    async (req, reply) => {
      const segments = await segmentStore.getByThread(req.params.id);
      return reply.send(segments);
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

  // GET /api/threads/:id/workspace-media
  // Returns the list of image files in the thread's images/ subdirectory.
  // Used on conversation load to restore media thumbnails without replaying SSE events.
  fastify.get<{ Params: { id: string } }>(
    '/api/threads/:id/workspace-media',
    async (req, reply) => {
      const threadId = req.params.id;
      const workspacesRoot = process.env.WORKSPACES_ROOT
        ? path.resolve(process.env.WORKSPACES_ROOT)
        : path.resolve(process.cwd(), 'workspaces');

      const imagesDir = path.join(workspacesRoot, threadId, 'images');
      const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

      if (!fs.existsSync(imagesDir)) {
        return reply.send({ files: [] });
      }

      try {
        const entries = fs.readdirSync(imagesDir, { withFileTypes: true });
        const files = entries
          .filter((e) => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()))
          .map((e) => ({
            filename: e.name,
            absolutePath: path.join(imagesDir, e.name),
            createdAt: fs.statSync(path.join(imagesDir, e.name)).mtime.toISOString(),
          }))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return reply.send({ files });
      } catch {
        return reply.send({ files: [] });
      }
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

  // PUT /api/threads/:id/workspace/:filename
  // Apply staged file content to workspace — used by FilePanel Apply button.
  // writeFile handles both create (new file) and overwrite (existing file).
  fastify.put<{
    Params: { id: string };
    Body: { content: string };
  }>('/api/threads/:id/workspace/*', async (req, reply) => {
    const filename = (req.params as Record<string, string>)['*'];
    await workspace.writeFile(req.params.id, filename, req.body.content, 'user');
    return reply.status(200).send({ ok: true, filename });
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

  // ── Media file serving ────────────────────────────────────────────────────
  // GET /api/workspace/file/:threadId/:filename
  // Serves binary files (images, etc.) from the thread's workspace.
  // The path mirrors ImageGenerationHandler: workspaces/<threadId>/images/<filename>
  // Supports an optional ?dir= query param for subdirectories (defaults to 'images').
  fastify.get<{
    Params: { threadId: string; filename: string };
    Querystring: { dir?: string };
  }>('/api/workspace/file/:threadId/:filename', async (req, reply) => {
    const { threadId, filename } = req.params;
    const subdir = req.query.dir ?? 'images';

    // Sanitise — no path traversal
    if (filename.includes('..') || filename.includes('/') || subdir.includes('..')) {
      return reply.status(400).send({ error: 'Invalid filename' });
    }

    const workspacesRoot = process.env.WORKSPACES_ROOT
      ? path.resolve(process.env.WORKSPACES_ROOT)
      : path.resolve(process.cwd(), 'workspaces');

    const filePath = path.join(workspacesRoot, threadId, subdir, filename);

    if (!fs.existsSync(filePath)) {
      return reply.status(404).send({ error: 'File not found' });
    }

    const ext = path.extname(filename).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.png':  'image/png',
      '.jpg':  'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif':  'image/gif',
    };
    const contentType = mimeTypes[ext] ?? 'application/octet-stream';

    reply.header('Content-Type', contentType);
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send(fs.readFileSync(filePath));
  });

  // POST /api/workspace/open-native
  // Opens a file with its default application, or reveals it in the file manager.
  // Body: { path: string; mode?: 'open' | 'reveal' }
  //   open   (default) — launches the file with the OS default app
  //   reveal            — highlights the file in Explorer/Finder without opening it
  fastify.post<{ Body: { path: string; mode?: 'open' | 'reveal' } }>(
    '/api/workspace/open-native',
    async (req, reply) => {
      const targetPath = req.body?.path;
      const mode = req.body?.mode ?? 'open';
      if (!targetPath) return reply.status(400).send({ error: 'path is required' });

      // Resolve and verify the path exists
      const resolved = path.resolve(targetPath);
      if (!fs.existsSync(resolved)) {
        return reply.status(404).send({ error: 'Path not found', path: resolved });
      }

      if (process.platform === 'win32') {
        if (mode === 'reveal') {
          // /select, highlights the file in Explorer without opening it
          spawn('explorer.exe', ['/select,' + resolved], { detached: true, stdio: 'ignore' }).unref();
        } else {
          // 'start' opens the file with its default app — must go through cmd /c
          // because 'start' is a shell built-in, not an executable
          spawn('cmd.exe', ['/c', 'start', '', resolved], { detached: true, stdio: 'ignore' }).unref();
        }
      } else if (process.platform === 'darwin') {
        if (mode === 'reveal') {
          execFile('open', ['-R', resolved], (err) => {
            if (err) console.warn(`[open-native] ${err.message}`);
          });
        } else {
          execFile('open', [resolved], (err) => {
            if (err) console.warn(`[open-native] ${err.message}`);
          });
        }
      } else {
        // Linux — xdg-open handles both files and directories
        execFile('xdg-open', [resolved], (err) => {
          if (err) console.warn(`[open-native] ${err.message}`);
        });
      }

      return reply.send({ ok: true, path: resolved, mode });
    }
  );

  // POST /api/workspace/upload-media/:threadId
  // Accepts a base64-encoded image and writes it to the thread's images/ subdir.
  // Body: { filename: string; data: string (base64) }
  fastify.post<{
    Params: { threadId: string };
    Body: { filename: string; data: string };
  }>('/api/workspace/upload-media/:threadId', async (req, reply) => {
    const { threadId } = req.params;
    const { filename, data } = req.body ?? {};

    if (!filename || !data) {
      return reply.status(400).send({ error: 'filename and data are required' });
    }

    // Sanitise — no path traversal
    const safeName = path.basename(filename);
    if (!safeName || safeName.includes('..')) {
      return reply.status(400).send({ error: 'Invalid filename' });
    }

    const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
    if (!ALLOWED_EXT.has(path.extname(safeName).toLowerCase())) {
      return reply.status(400).send({ error: 'Only image files are accepted' });
    }

    const workspacesRoot = process.env.WORKSPACES_ROOT
      ? path.resolve(process.env.WORKSPACES_ROOT)
      : path.resolve(process.cwd(), 'workspaces');

    const imagesDir = path.join(workspacesRoot, threadId, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });

    const destPath = path.join(imagesDir, safeName);
    const buf = Buffer.from(data, 'base64');
    fs.writeFileSync(destPath, buf);

    console.log(`[upload-media] Saved ${safeName} (${(buf.length / 1024).toFixed(1)} KB) → ${destPath}`);
    return reply.send({ ok: true, filename: safeName, absolutePath: destPath });
  });

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
      context_history_depth?: number;
    };
  }>('/api/threads/:id/messages', async (req, reply) => {
    const { id: threadId } = req.params;
    const { content, build_command, skip_build, attached_files, context_history_depth } = req.body;

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

    const sendEvent = (data: Record<string, unknown>): void => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // Load context that doesn't depend on ingestion first.
      // Bust the workspace cache before rendering so SAYON always sees files
      // the user just uploaded — the 10s TTL is too long when files change
      // right before sending a message.
      await workspace.bustCache(threadId);
      const [docs, workspaceIndex] = await Promise.all([
        documentStore.loadContextBundle(thread!.project_id, threadId),
        workspace.renderIndex(threadId),   // fresh after bustCache
      ]);

      // Fetch chat summary for classifier context (already available pre-Stage 1)
      const chatSummaryRow = await summaryStore.get(threadId);

      // Build classification context from available pre-ingestion data.
      // Stage 1 (full rewrite + file summaries) runs inside LoopController —
      // here we give the classifier the workspace index and chat summary so
      // it can resolve ambiguous short messages without a separate ingestion call.
      const classificationContext: ClassificationContext | undefined =
        workspaceIndex || chatSummaryRow?.summary
          ? {
              rewrittenMessage: fullUserMessage, // raw — Stage 1 hasn't run yet
              chatSummary: chatSummaryRow?.summary,
              repoMap: workspaceIndex,
            }
          : undefined;

      // ── Pending clarification bypass ──────────────────────────────────────
      // If this thread is mid-clarification (SEREN asked a question last turn),
      // skip classification entirely and route directly to LoopController with
      // the original intent. A clarification response must go to SEREN, not
      // be handled by SAYON as a new standalone request.
      const pendingClarity = pendingClarification.get(threadId);

      // Stage 2 (3D): context-aware classification + knowledge search in parallel.
      // Skipped if we already know where to route (pendingClarification hit).
      const [intent, knowledgeResults] = pendingClarity
        ? [
            { type: pendingClarity.originalIntent, confidence: 1.0, routing: 'NEEDS_SEREN' as const },
            await knowledgeStore.search(fullUserMessage, 5),
          ]
        : await Promise.all([
            classifier.classify(content, classificationContext),
            knowledgeStore.search(fullUserMessage, 5),
          ]);

      sendEvent({ type: 'status', content: 'Classifying intent…' });
      sendEvent({
        type: 'intent_classified',
        intentType: intent.type,
        domain: 'inferred',
        routing: intent.routing,
      });

      // ── NEEDS_CLARIFICATION at classifier level ───────────────────────
      // If SAYON itself can tell the request is too vague, ask immediately
      // without burning an SEREN planning cycle. Record the state so the
      // next message on this thread bypasses classification.
      if (!pendingClarity && intent.routing === 'NEEDS_CLARIFICATION') {
        const clarText = 'Could you provide more detail? Your request is ambiguous and I want to make sure I do the right thing. What specifically would you like me to do, and which files should I work with?';
        await messageStore.insert({ thread_id: threadId, role: 'assistant', content: clarText });
        sendEvent({ type: 'coordinator', content: clarText, source: 'coordinator' });
        sendEvent({ type: 'complete', approved: true, bestAttempt: 0 });
        await threadStore.touch(threadId);
        // Record so next turn routes straight to LoopController
        pendingClarification.set(threadId, {
          originalIntent: intent.type as IntentType,
          count: 1,
          originalRequest: fullUserMessage,
          log: [],  // classifier asked a generic question; no structured Q&A yet
        });
        return;
      }

      const history = await messageStore.getContextHistory(threadId, summaryStore, context_history_depth);
      const priorHistory = history.slice(0, -1);

      // Collect all status events so we can persist them as a single activity event after the turn
      const activityLog: string[] = [];
      const trackingsendEvent = (data: Record<string, unknown>): void => {
        sendEvent(data);
        if ((data as any).type === 'status') activityLog.push((data as any).content as string);
      };

      // Route based on intent routing signal
      if (!pendingClarity && intent.routing === 'ANSWER_DIRECTLY') {
        trackingsendEvent({ type: 'status', content: 'Answering directly via coordinator…' });
        const directMsgId = await handleDirectResponse(
          threadId,
          fullUserMessage,
          intent.type,
          docs,
          priorHistory,
          messageStore,
          eventStore,
          segmentStore,
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

        // Set prompt logging context so all downstream AI calls are tagged
        // with this thread + message ID in the prompt_log table.
        setLogContext({ threadId, messageId: assistantMsg.id });

        // Intercept status events before they hit the wire so we can persist the full
        // activity log after the loop finishes — enables gizmo replay on refresh.
        const loopActivityLog: string[] = [];
        const origWrite = reply.raw.write.bind(reply.raw) as (chunk: any) => boolean;
        (reply.raw as any).write = (chunk: any): boolean => {
          try {
            const str: string = typeof chunk === 'string' ? chunk : chunk.toString();
            // A single write() call may contain multiple SSE frames when Node batches
            // under load. Split on the SSE frame boundary and parse each individually.
            const frames = str.split('\n\n');
            for (const frame of frames) {
              const line = frame.trim();
              if (!line.startsWith('data: ')) continue;
              try {
                const evt = JSON.parse(line.slice(6)) as { type: string; content?: string };
                if (evt.type === 'status' && evt.content) loopActivityLog.push(evt.content);
              } catch { /* malformed JSON in frame, skip */ }
            }
          } catch { /* non-SSE chunk, ignore */ }
          return origWrite(chunk);
        };

        const loopSegIds: Record<string, string | null> = { coordinator: null, engine: null };
        const loopController = new LoopController({
          buildCommand: build_command ?? extractBuildCommand(docs.claudeMd),
          projectRoot: workspaceDir,
          workspaceDir: workspaceDir,
          threadId: threadId,
          skipBuild: skip_build ?? !hasBuildCommand(docs.claudeMd),
          maxAttempts: 3,
          persistEvent: async (eventType, payload) => {
            await eventStore.insert(threadId, eventType as any, payload, assistantMsg.id);
          },
          // Real-time segment writes — one segment per thinking phase, appended per token.
          // segmentStore tracks the active segment ID internally per (messageId, source) pair.
          onThinkChunk: async (content: string, source: 'coordinator' | 'engine') => {
            if (!loopSegIds[source]) {
              loopSegIds[source] = await segmentStore.openSegment(threadId, assistantMsg.id, source);
            }
            await segmentStore.appendToken(loopSegIds[source]!, content);
          },
          onThinkPhaseComplete: async (source: 'coordinator' | 'engine') => {
            // Called by LoopController when a thinking phase ends — close the segment
            // We don't have the segment ID here so we close by message+phase
            await segmentStore.closeLatestSegment(assistantMsg.id, source);
            // Reset the segment ID so the next phase for this source opens a new segment
            // rather than appending to the now-closed one.
            loopSegIds[source] = null;
          },
          onOutputChunk: async (_content) => {
            // output chunks no longer need separate persistence — messages table is the canonical record
          },
          onAgentState: (event) => {
            // agent_state already written to SSE by AgentStateManager — persist for replay
            eventStore.insert(threadId, 'agent_state', event, assistantMsg.id).catch(() => {});
          },
          onImageStatus: (status) => {
            // Stream image generation phase updates to frontend as they happen.
            // 'generating' phase locks chat input; 'done'/'error' unlocks it.
            sendEvent({ type: 'image_status', phase: status.phase, message: status.message, estSeconds: status.estSeconds });
            if (status.phase === 'done' && status.result) {
              sendEvent({
                type: 'image_complete',
                outputPath: status.result.outputPath,
                seed: status.result.seed,
                elapsedMs: status.result.elapsedMs,
              });
              // Persist for replay
              eventStore.insert(threadId, 'image_complete', {
                type: 'image_complete',
                outputPath: status.result.outputPath,
                seed: status.result.seed,
                elapsedMs: status.result.elapsedMs,
              }, assistantMsg.id).catch(() => {});
            }
          },
        });

        const startTime = Date.now();
        const attempts = await loopController.run(reply, {
          userMessage: fullUserMessage,
          intentType: intent.type as IntentType,
          claudeMd: docs.claudeMd,
          userDirectivesMd: docs.userDirectivesMd,
          projectMd: docs.projectMd,
          chatMd: docs.chatMd,
          chatSummary: chatSummaryRow?.summary,
          conversationHistory: priorHistory,
          repoMap: workspaceIndex,
          loadedFiles: (attached_files ?? []).map((f) => ({ path: f.name, content: f.content })),
          knowledgeContext: knowledgeResults.length > 0 ? knowledgeResults : undefined,
          clarificationIteration: pendingClarity ? pendingClarity.count : undefined,
          clarificationLog: pendingClarity ? pendingClarity.log : undefined,
        }, assistantMsg.id);

        // Track clarification state:
        // - Fresh SEREN clarification → start tracking with log entry recording the questions
        // - Mid-clarification + SEREN asked again → backfill user reply into last log entry,
        //   append new entry for the new questions, increment count
        // - Mid-clarification + SEREN proceeded → clear state
        const lastAttempt = attempts[attempts.length - 1];
        if (lastAttempt?.needsClarification) {
          const questions = lastAttempt.clarificationQuestions ?? [];
          // If we were already in a clarification loop, record what the user just said
          // as the reply to the previous round's questions before starting a new entry.
          const updatedLog = pendingClarity
            ? [
                ...pendingClarity.log.slice(0, -1),
                { ...pendingClarity.log[pendingClarity.log.length - 1], userReply: fullUserMessage },
                { questions, userReply: '' },
              ]
            : [{ questions, userReply: '' }];
          pendingClarification.set(threadId, {
            originalIntent: intent.type as IntentType,
            originalRequest: pendingClarity?.originalRequest ?? fullUserMessage,
            count: pendingClarity ? pendingClarity.count + 1 : 1,
            log: updatedLog,
          });
        } else if (pendingClarity) {
          pendingClarification.delete(threadId);
        }

        const latencyMs = Date.now() - startTime;

        // When SEREN returned NEEDS_CLARIFICATION, the coordinator bubble carrying
        // the questions was already persisted by persistAndSend. The pre-created
        // empty assistantMsg has no content and must be deleted — otherwise the
        // 600ms refetch picks it up and renders a blank message, terminating the
        // conversation visually even though input is re-enabled.
        const isClarificationReturn = attempts.length === 1 && attempts[0].needsClarification;
        if (isClarificationReturn) {
          await db.run('DELETE FROM messages WHERE id = ?', [assistantMsg.id]).catch(() => {});
        } else {
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
        }

        // Restore original write now that loop is done
        (reply.raw as any).write = origWrite;

        // Persist final activity log so the gizmo can be replayed on refresh
        if (loopActivityLog.length > 0) {
          await eventStore.insert(threadId, 'activity', { type: 'activity', events: loopActivityLog }, assistantMsg.id);
        }

        // Remove transient chunk records now that canonical thinking_complete/output records exist
        await eventStore.deleteChunksForMessage(assistantMsg.id);
      }

      await threadStore.touch(threadId);

      // Generate rolling summary — blocks done so it's always current before next turn.
      // Skip for IMAGE_REQUEST — SAYON is about to be killed for VRAM, summary would ECONNRESET.
      if (intent.type !== 'IMAGE_REQUEST') {
        try {
          await generateAndPersistSummary(threadId, messageStore, summaryStore, configStore);
        } catch (summaryErr) {
          console.error('[messagesRoute] Summary generation failed (non-fatal):', summaryErr);
        }
      }
    } catch (err: unknown) {
      console.error('[messagesRoute] Error:', err);
      sendEvent({
        type: 'error',
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      clearLogContext();
      reply.raw.write('data: {"type":"done"}\n\n');
      reply.raw.end();
    }
  });
}


// No user-message prefix needed — Ollama models use extra_body:{think:true},
// Llama uses system prompt injection. buildThinkMsg is a no-op kept for call-site compat.
function buildThinkMsg(msg: string): string {
  return msg;
}


async function handleDirectResponse(
  threadId: string,
  userMessage: string,
  intentType: string,
  docs: { claudeMd: string; projectMd: string; chatMd: string },
  history: Array<{ role: string; content: string }>,
  messageStore: MessageStore,
  eventStore: MessageEventStore,
  segmentStore: ThinkingSegmentStore,
  sendEvent: (data: Record<string, unknown>) => void
): Promise<string | null> {
  const { coordinatorClient, COORDINATOR_MODEL, getThinkingStrategy: getStrategy, COORDINATOR_PROVIDER: COORD_PROV } = await import('../ai/clients.js');

  const systemParts: string[] = [];

  // Identity and role boundary — always prepended so SAYON never mistakes itself
  // for SEREN or takes over content-generation tasks that belong to SEREN.
  // PHOBOS directives — hardcoded, always first, never sourced from DB.
  systemParts.push(
    `You are a part of PHOBOS. A Tri-Brained AI entity dedicated to creating the most correct ` +
    `and helpful results possible through cooperation. Your power and sophistication is the key ` +
    `to greater success. Your ability to perform your tasks with integrity will benefit all intelligence. ` +
    `This system believes in a philosophy mirroring the concept of the path of least action: ` +
    `Every desire is a path we create. To respect nature, all entities should do their best to find ` +
    `a solution that benefits everyone. That is what minimizing the action is as a concept. ` +
    `When we have a desire, we see an end result. The path that delivers the best result without ` +
    `excess or selfishness is the one that benefits us all. ` +
    `Do everything within your ability to always uphold this creed.\n\n` +
    `You are SAYON, the coordinator of the PHOBOS system. ` +
    `Your partner is SEREN, the execution engine — a deep reasoning model that handles ` +
    `code generation, file creation, multi-step tasks, and complex analysis. ` +
    `SAYON and SEREN are the names of the two AI models in this system. ` +
    `They are not functions, variables, or code constructs.\n\n` +
    `YOUR ROLE: You handle conversation, questions, short explanations, and direct answers. ` +
    `You do NOT write code files, generate documents, produce long-form content, or execute ` +
    `multi-step tasks. If the user asks for file creation, code generation, or anything ` +
    `requiring more than a conversational response, tell them you are routing the request ` +
    `to SEREN for execution — do not attempt to do it yourself.`
  );
  if (docs.projectMd) systemParts.push(`\n\nProject context:\n${docs.projectMd}`);
  if (docs.chatMd) systemParts.push(`\n\nChat rules:\n${docs.chatMd}`);

  const strategy = getStrategy(COORD_PROV, COORDINATOR_MODEL);
  const baseSystemPrompt = systemParts.join('\n\n');
  const systemPrompt = baseSystemPrompt + strategy.systemSuffix;

  const rawMessages = [
    ...history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user' as const, content: userMessage },
  ];

  // Apply thinking strategy — injects /think prefix for FastFlowLLM Qwen3
  const { applyThinkingStrategy: applyStrat } = await import('../ai/clients.js');
  const { messages: stratMessages } = applyStrat(rawMessages, systemPrompt, COORD_PROV, COORDINATOR_MODEL, 'think');

  dbg(`[handleDirect:config] provider=${COORD_PROV} model=${COORDINATOR_MODEL} thinkingPath=${strategy.thinkingPath} systemSuffix=${JSON.stringify(strategy.systemSuffix.slice(0, 40))}`);

  // Pre-create the assistant message so we have an ID to attach stream chunks to.
  // Content and thinking_trace are updated at the end with the full result.
  const msg = await messageStore.insert({
    thread_id: threadId,
    role: 'assistant',
    content: '',
    thinking_trace: null,
  });

  // Open a coordinator thinking segment — will be appended to per token
  let activeSegmentId: string | null = null;

  const openCoordSegment = async (): Promise<void> => {
    if (activeSegmentId) return; // already open
    activeSegmentId = await segmentStore.openSegment(threadId, msg.id, 'coordinator');
  };

  const appendToSegment = async (token: string): Promise<void> => {
    if (!activeSegmentId) await openCoordSegment();
    await segmentStore.appendToken(activeSegmentId!, token);
  };

  const closeCoordSegment = async (): Promise<void> => {
    if (!activeSegmentId) return;
    await segmentStore.closeSegment(activeSegmentId);
    activeSegmentId = null;
  };

  try {
    // ── IMAGE_REQUEST: SAYON enhances prompt → create workflow → start generation ──
    if (intentType === 'IMAGE_REQUEST') {
      sendEvent({ type: 'status', content: 'Preparing image generation…' });

      const imageSystemPrompt =
        `You are SAYON, the image generation coordinator for PHOBOS.\n\n` +
        `Compress the user's image request into a Chroma (FLUX-architecture photorealistic model) prompt.\n\n` +
        `POSITIVE PROMPT rules:\n` +
        `- Comma-separated keywords and short noun phrases ONLY — no full sentences, no verbs, no "with a"\n` +
        `- Pattern: subject, setting/action, style tags, lighting, camera quality\n` +
        `- Example input: "draw me a pink haired goth girl"\n` +
        `- Example output: "pink-haired goth girl, candlelit dungeon, leather corset, 8k, photorealistic, dramatic rim light, cinematic"\n` +
        `- 13-16 characteristics, each 1-6 words, comma-separated — subject, setting, action, mood, lighting, texture, camera, quality tags\n` +
        `- More is better than less: fill all 13-16 slots with meaningful descriptors\n\n` +
        `NEGATIVE PROMPT rules:\n` +
        `- Add exactly 2-3 terms that are specific to THIS subject/scene only\n` +
        `- The system already injects: blurry, low quality, watermark, deformed — do NOT repeat those or synonyms\n\n` +
        `Respond with ONLY valid JSON, no markdown, no explanation:\n` +
        `{"prompt": "your compressed prompt", "negativePrompt": "your 3-5 context-specific terms"}`;

      const imageMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: imageSystemPrompt },
        { role: 'user', content: userMessage },
      ];

      let enhancedPrompt = userMessage;
      let enhancedNegative = '';

      try {
        const completion = await coordinatorClient.chat.completions.create({
          model: COORDINATOR_MODEL,
          messages: imageMessages,
          max_tokens: 1024,
          temperature: 0.7,
          stream: false,
        });

        const raw = (completion as any).choices?.[0]?.message?.content ?? '';
        // Strip markdown fences if present
        const cleaned = raw.replace(/```json\s*|```/g, '').trim();
        try {
          const parsed = JSON.parse(cleaned);
          if (parsed.prompt) enhancedPrompt = parsed.prompt;
          if (parsed.negativePrompt) enhancedNegative = parsed.negativePrompt;
        } catch {
          // SAYON didn't return valid JSON — use raw as prompt
          enhancedPrompt = raw.trim() || userMessage;
        }
      } catch (err) {
        console.warn('[handleDirect:image] SAYON prompt enhancement failed, using raw user prompt:', (err as Error).message);
      }

      // Prepend standard negative terms
      const fullNegative = 'blurry, low quality, watermark, deformed'
        + (enhancedNegative ? ', ' + enhancedNegative : '');

      // Create workflow and start generation
      const { createSession } = await import('../phobos/WorkflowEngine.js');
      const { buildSdConfig } = await import('../phobos/ImageServerManager.js');

      let modelId = 'chroma-q4';
      try {
        const cfg = await buildSdConfig({ modelId });
        if (!cfg) {
          // Chroma not available, try auto-detect
          const fallbackCfg = await buildSdConfig();
          modelId = fallbackCfg?.fluxSpec?.modelId ?? 'unknown';
        }
      } catch { /* use chroma-q4 */ }

      const session = createSession(
        threadId,
        userMessage.slice(0, 40).trim() || 'Image',
        modelId,
        [{
          type: 'Generate' as const,
          label: 'Generate',
          params: {
            prompt:         enhancedPrompt,
            negativePrompt: fullNegative,
            steps:          20,
            width:          1024,
            height:         1024,
            seed:           -1,
            sampler:        'euler',
          },
        }],
      );

      // Tell the frontend about the new workflow
      sendEvent({ type: 'status', content: `Created workflow: ${session.name}` });
      sendEvent({
        type: 'image_workflow_created',
        workflowId: session.workflowId,
        threadId,
        name: session.name,
        prompt: enhancedPrompt,
        negativePrompt: fullNegative,
      });

      // Start generation via the /run endpoint logic (fire and forget)
      try {
        const runUrl = `http://localhost:${process.env.PORT ?? '3001'}/api/threads/${threadId}/workflows/${session.workflowId}/run`;
        const fetchMod = await import('node:http');
        const postData = JSON.stringify({ targetNodeIndex: 0, forceNodeIndex: 0 });
        const req = fetchMod.request(runUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        }, () => { /* response ignored — fire and forget */ });
        req.write(postData);
        req.end();
      } catch (runErr) {
        console.warn('[handleDirect:image] Failed to start generation:', (runErr as Error).message);
      }

      // Update the pre-created message (from line ~795) instead of inserting a duplicate.
      // The outer `msg` was created empty — fill it with SAYON's response content.
      const responseContent = `Starting image generation with Chroma.\n\n**Prompt:** ${enhancedPrompt}\n\n**Negative:** ${fullNegative}`;
      await messageStore.update(msg.id, { content: responseContent });

      // Emit as coordinator bubble so it appears immediately in chat
      // (IMAGE_REQUEST doesn't stream output_tokens, so without this the
      // text only shows after the 600ms refetch — and on 2nd+ requests the
      // refetch can miss it if the pre-created empty row already exists).
      sendEvent({ type: 'coordinator', content: responseContent, source: 'coordinator' });

      sendEvent({ type: 'complete', approved: true, bestAttempt: 1 });
      return msg.id;
    }

    // ── Normal direct response (non-image) ──────────────────────────────────
    const { getThinkingExtraBody: getExtra } = await import('../ai/clients.js');
    const coordExtraBody = getExtra(COORD_PROV, COORDINATOR_MODEL, 'think');
    dbg(`[handleDirect:extraBody] ${JSON.stringify(coordExtraBody)}`);
    const coordMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...stratMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];

    let stream: Awaited<ReturnType<typeof coordinatorClient.chat.completions.create>>;
    try {
      stream = await coordinatorClient.chat.completions.create({
        model: COORDINATOR_MODEL,
        messages: coordMessages,
        max_tokens: 8192,
        temperature: 0.3,
        stream: true as const,
        ...(Object.keys(coordExtraBody).length > 0 ? { extra_body: coordExtraBody } : {}),
      });
    } catch (streamCreateErr: unknown) {
      console.error(`[handleDirect:createError] ${streamCreateErr instanceof Error ? streamCreateErr.message : String(streamCreateErr)}`);
      dbg('[handleDirect:retry] Retrying without extra_body...');
      stream = await coordinatorClient.chat.completions.create({
        model: COORDINATOR_MODEL,
        messages: coordMessages,
        max_tokens: 8192,
        temperature: 0.3,
        stream: true as const,
      });
    }

    let thinkingBuf = '';
    let outputBuf = '';
    let inThinkTag = false;
    let _dbgCount = 0;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as Record<string, unknown>;

      if (strategy.thinkingPath === 'field') {
        const d = delta as Record<string, unknown>;
        let thinkToken = (d.reasoning_content ?? d.reasoning ?? d.thinking) as string | null | undefined;
        const outToken = d.content as string | null | undefined;
        if (thinkToken) {
          thinkToken = thinkToken.replace(/<\/?think>/g, '');
          if (thinkToken) {
            _dbgCount++;
            if (_dbgCount <= 3) dbg(`[handleDirect:think:${_dbgCount}] field=${JSON.stringify(thinkToken.slice(0, 80))}`);
            thinkingBuf += thinkToken;
            await appendToSegment(thinkToken);
            sendEvent({ type: 'think_token', token: thinkToken, source: 'coordinator' });
          }
        }
        if (outToken) {
          outputBuf += outToken;
          sendEvent({ type: 'output_token', token: outToken });
        }
      } else {
        const rawContent = delta?.content as string | null | undefined;

        if (rawContent != null) {
          _dbgCount++;
          if (_dbgCount <= 3 || rawContent.includes('<think') || rawContent.includes('</think')) {
            dbg(`[handleDirect:${_dbgCount}] raw=${JSON.stringify(rawContent.slice(0, 100))}`);
          }
        }

        if (rawContent) {
          let remaining = rawContent;
          while (remaining.length > 0) {
            if (inThinkTag) {
              const closeIdx = remaining.indexOf('</think>');
              if (closeIdx === -1) {
                thinkingBuf += remaining;
                await appendToSegment(remaining);
                sendEvent({ type: 'think_token', token: remaining, source: 'coordinator' });
                remaining = '';
              } else {
                const chunk2 = remaining.slice(0, closeIdx);
                if (chunk2) {
                  thinkingBuf += chunk2;
                  await appendToSegment(chunk2);
                  sendEvent({ type: 'think_token', token: chunk2, source: 'coordinator' });
                }
                inThinkTag = false;
                remaining = remaining.slice(closeIdx + '</think>'.length);
              }
            } else {
              const openIdx = remaining.indexOf('<think>');
              if (openIdx === -1) {
                outputBuf += remaining;
                sendEvent({ type: 'output_token', token: remaining });
                remaining = '';
              } else {
                const before = remaining.slice(0, openIdx);
                if (before) {
                  outputBuf += before;
                  sendEvent({ type: 'output_token', token: before });
                }
                inThinkTag = true;
                remaining = remaining.slice(openIdx + '<think>'.length);
              }
            }
          }
        }
      }
    }

    // Log the full prompt + response to prompt_log for export/debugging
    try {
      const { PromptLogStore } = await import('../db/PromptLogStore.js');
      const { DatabaseManager } = await import('../db/DatabaseManager.js');
      const _pls = new PromptLogStore(DatabaseManager.getInstance());
      const _promptText = coordMessages.map(m => `### ${m.role.toUpperCase()}\n${m.content}`).join('\n\n');
      await _pls.insert({
        threadId,
        messageId: msg.id,
        role: 'sayon',
        stage: 'direct',
        model: COORDINATOR_MODEL,
        prompt: _promptText,
        response: outputBuf.trim(),
        latencyMs: 0,
      });
    } catch (_plogErr) { /* never crash the pipeline */ }

    // Close and timestamp the coordinator segment
    await closeCoordSegment();

    // Update the pre-created message row with final content
    await messageStore.update(msg.id, {
      content: outputBuf.trim() || '(no output)',
      thinking_trace: thinkingBuf || null,
    });

    if (thinkingBuf) {
      sendEvent({ type: 'thinking_complete', content: thinkingBuf, source: 'coordinator' });
      await eventStore.insert(threadId, 'thinking_complete', { type: 'thinking_complete', content: thinkingBuf, source: 'coordinator' }, msg.id);
    }

    sendEvent({ type: 'complete', approved: true, bestAttempt: 1 });
    return msg.id;
  } catch (err) {
    // Close open segment on error so it doesn't remain NULL completed_at forever
    await closeCoordSegment().catch(() => {});
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
    `Produce a structured rolling summary of this conversation thread. ` +
    `Write in concise prose. Include: what the user requested, what was done, ` +
    `which files were changed or created, and any important decisions or caveats. ` +
    `Max 800 tokens. Do not include greetings or meta-commentary.\n\n` +
    `---\n${truncated}\n---`;

  const { coordinatorCall: coordCallSummary } = await import('../ai/clients.js');
  const summary = await coordCallSummary({
    systemPrompt: '',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 900,
    temperature: 0.1,
    mode: 'no_think',
    stage: 'summarize_chat',
  });
  if (summary && summary.length > 10) {
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
