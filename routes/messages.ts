import type { FastifyInstance } from 'fastify';
import { MessageStore } from '../db/MessageStore.js';
import { ThreadStore } from '../db/ThreadStore.js';
import { DocumentStore } from '../db/DocumentStore.js';
import { DatabaseManager } from '../db/DatabaseManager.js';
import { MessageAttachmentStore } from '../db/MessageAttachmentStore.js';

const DEBUG = process.env.PHOBOS_DEBUG === '1' || process.env.PHOBOS_DEBUG === 'true';
const dbg = (...args: unknown[]) => { if (DEBUG) console.log(...args); };
import { DispatchLogStore } from '../db/DispatchLogStore.js';
import { MessageEventStore } from '../db/MessageEventStore.js';
import { ThinkingSegmentStore } from '../db/ThinkingSegmentStore.js';
import { ChatSummaryStore } from '../db/ChatSummaryStore.js';
import { ModelConfigStore } from '../db/ModelConfigStore.js';
import { KnowledgeStore } from '../db/KnowledgeStore.js';
import { IntentClassifier } from '../ai/IntentClassifier.js';
import { CoordinatorBridge } from '../CoordinatorBridge.js';
import type { AttemptResult } from '../ai/LoopController.js';
import { ThreadWorkspace } from '../context/ThreadWorkspace.js';
import { ThinkingStripper } from '../context/ThinkingStripper.js';
import type { IntentType } from '../ai/IntentClassifier.js';
import type { ClassificationContext } from '../ai/IntentClassifier.js';
import { ENGINE_MODEL, COORDINATOR_MODEL as COORD_MODEL_REF, COORDINATOR_PROVIDER, getThinkingStrategy, setLogContext, clearLogContext, getModelVisionCapability, coordinatorCall, engineStream } from '../ai/clients.js';
import { embedTaskCompletion, retrieveWorkspaceMemory } from '../ai/MemoryWriter.js';
import { runConversationRAG } from '../ai/ConversationRAGClient.js';
import { distillAssistantContent, buildEmbedInput } from '../ai/distillAssistantContent.js';
import { writeTurn } from '../db/ConversationStore.js';
import { embed } from '../ai/EmbedClient.js';
import { gsm } from '../game/GameStateManager.js';
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
  const attachmentStore = new MessageAttachmentStore(db);
  await attachmentStore.ensureTable();

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
    // SAYON's assembled planning context from the first pass — cached so that
    // on re-entry we skip re-running discovery/extraction and go straight to
    // decomposeTasks with the original context + the clarification answer appended.
    planningContext?: {
      rewrittenMessage: string;
      fileSummaries: import('../ai/ContextIngester.js').FileSummary[];
      completeContext: string;
      projectScope: import('../ai/ContextIngester.js').ProjectScope;
      repoMap: string;
    };
  }>();

  // Tracks threads where SAYON asked Phase 1 clarification before handing to SEREN.
  // Separate from pendingClarification — Phase 1 is pre-planning, SEREN hasn't seen
  // the request yet. On user reply, the full Q&A log is passed to ContextIngester
  // as phase1ClarificationLog so SAYON synthesises it into the final brief.
  const pendingPhase1Clarification = new Map<string, {
    originalIntent: IntentType;
    originalRequest: string;
    log: Array<{ questions: string[]; userReply: string }>;
  }>();

  // GET /api/threads/:id/messages
  fastify.get<{
    Params: { id: string };
    Querystring: { includeThinking?: string };
  }>('/api/threads/:id/messages', async (req, reply) => {
    const includeThinking = req.query.includeThinking === 'true';
    const messages = await messageStore.getByThread(req.params.id, includeThinking);

    // Fetch all attachments for this thread in one query, then group by message_id.
    // This is the source of truth for file chips on reload.
    const allAttachments = await attachmentStore.getByThread(req.params.id);
    const attachsByMsg = new Map<string, typeof allAttachments>();
    for (const a of allAttachments) {
      if (!attachsByMsg.has(a.message_id)) attachsByMsg.set(a.message_id, []);
      attachsByMsg.get(a.message_id)!.push(a);
    }

    const mapped = messages.map((m) => {
      const attachments = (attachsByMsg.get(m.id) ?? []).map((a) => ({
        id: a.id,
        filename: a.filename,
        is_image: a.is_image,
        size_bytes: a.size_bytes,
      }));
      return {
        id: m.id,
        role: m.role,
        content: m.content,
        distilled_content: m.distilled_content ?? undefined,
        timestamp: m.created_at,
        thinking: m.thinking_trace ?? undefined,
        ...(attachments.length > 0 ? { attachments } : {}),
      };
    });
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

  // GET /api/threads/:id/summary
  // Returns the rolling chat summary for this thread, or null if none exists yet.
  // Queries through the server's live DatabaseManager connection so the result
  // is always consistent — no WAL visibility lag for external readers.
  fastify.get<{ Params: { id: string } }>(
    '/api/threads/:id/summary',
    async (req, reply) => {
      const row = await summaryStore.get(req.params.id);
      if (!row) return reply.send(null);
      return reply.send({
        summary:              row.summary,
        message_count:        row.message_count_at_update,
        updated_at:           row.updated_at,
      });
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
  // Returns image, video, and audio files from the thread's workspace subdirectories.
  // Used on conversation load to restore media thumbnails without replaying SSE events.
  fastify.get<{ Params: { id: string } }>(
    '/api/threads/:id/workspace-media',
    async (req, reply) => {
      const threadId = req.params.id;
      const workspacesRoot = process.env.WORKSPACES_ROOT
        ? path.resolve(process.env.WORKSPACES_ROOT)
        : path.resolve(process.cwd(), 'workspaces');

      const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
      const VIDEO_EXTS = new Set(['.avi', '.mp4', '.mov', '.webm']);
      const AUDIO_EXTS = new Set(['.wav', '.mp3', '.flac', '.ogg', '.m4a']);

      const readDir = (subdir: string) => {
        const dir = path.join(workspacesRoot, threadId, subdir);
        if (!fs.existsSync(dir)) return [];
        try {
          return fs.readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isFile())
            .map((e) => {
              const ext = path.extname(e.name).toLowerCase();
              const mediaType: 'image' | 'video' | 'audio' =
                AUDIO_EXTS.has(ext) ? 'audio'
                : VIDEO_EXTS.has(ext) ? 'video'
                : 'image';
              return {
                filename:     e.name,
                absolutePath: path.join(dir, e.name),
                mediaType,
                dir:          subdir,
                createdAt:    fs.statSync(path.join(dir, e.name)).mtime.toISOString(),
              };
            })
            .filter((e) =>
              IMAGE_EXTS.has(path.extname(e.filename).toLowerCase()) ||
              VIDEO_EXTS.has(path.extname(e.filename).toLowerCase()) ||
              AUDIO_EXTS.has(path.extname(e.filename).toLowerCase())
            );
        } catch { return []; }
      };

      const files = [
        ...readDir('images'),
        ...readDir('videos'),
        // Generated audio: three sub-categories all land in the media grid
        ...readDir('audio/tts'),
        ...readDir('audio/music'),
        ...readDir('audio/sfx'),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

      return reply.send({ files });
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

  // ── Message attachments ───────────────────────────────────────────────────
  // POST /api/threads/:id/attachments
  // Upload a file to be attached to a user message. Called by the frontend
  // before submitting the message. Returns the attachment record so the
  // frontend can pass attachment_ids in the message body.
  // The file lives at <WORKSPACES_ROOT>/<threadId>/attachments/<id>-<filename>
  // and is never written to the AI-editable workspace root.
  fastify.post<{
    Params: { id: string };
    Body: { filename: string; content: string; mime_type?: string; message_id?: string };
  }>('/api/threads/:id/attachments', async (req, reply) => {
    const threadId = req.params.id;
    const { filename, content, mime_type = 'text/plain', message_id = '' } = req.body;
    if (!filename || content === undefined) {
      return reply.status(400).send({ error: 'filename and content required' });
    }
    const attachment = await attachmentStore.save(threadId, filename, content, mime_type, message_id);
    return reply.send({
      id: attachment.id,
      filename: attachment.filename,
      is_image: attachment.is_image,
      size_bytes: attachment.size_bytes,
    });
  });

  // PATCH /api/threads/:id/attachments/:attachmentId
  // Links a previously uploaded attachment to a message after the message is created.
  fastify.patch<{
    Params: { id: string; attachmentId: string };
    Body: { message_id: string };
  }>('/api/threads/:id/attachments/:attachmentId', async (req, reply) => {
    const { attachmentId } = req.params;
    const { message_id } = req.body;
    if (!message_id) return reply.status(400).send({ error: 'message_id required' });
    await db.run(
      `UPDATE message_attachments SET message_id = ? WHERE id = ?`,
      [message_id, attachmentId]
    );
    return reply.status(204).send();
  });

  // GET /api/threads/:id/attachments/:attachmentId/content
  // Returns the raw text content of an attachment — used by the file viewer chip.
  fastify.get<{ Params: { id: string; attachmentId: string } }>(
    '/api/threads/:id/attachments/:attachmentId/content',
    async (req, reply) => {
      const attachment = await attachmentStore.getById(req.params.attachmentId);
      if (!attachment || attachment.thread_id !== req.params.id) {
        return reply.status(404).send({ error: 'Attachment not found' });
      }
      if (attachment.is_image) {
        return reply.status(400).send({ error: 'Use /raw for binary files' });
      }
      const content = await attachmentStore.readContent(attachment);
      return reply.send({ content, filename: attachment.filename });
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
      '.avi':  'video/x-msvideo',
      '.mp4':  'video/mp4',
      '.mov':  'video/quicktime',
      '.webm': 'video/webm',
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
      /** IDs of pre-uploaded attachments — replaces old attached_files content array */
      attachment_ids?: string[];
      context_history_depth?: number;
    };
  }>('/api/threads/:id/messages', async (req, reply) => {
    const { id: threadId } = req.params;
    const { content, build_command, skip_build, attachment_ids, context_history_depth } = req.body;

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

    // ── Resolve active model vision capability once per turn ──────────────────
    // Used to decide: reject image attachments, build content arrays, inject descriptions.
    const { coordinatorSupportsVision, engineSupportsVision } = getModelVisionCapability();

    // Store user message — content is the user's typed text ONLY.
    // Attachment contents are never stored in the messages table; they live on disk
    // and are linked via message_attachments.message_id.
    const userMsg = await messageStore.insert({
      thread_id: threadId,
      role: 'user',
      content,
    });

    // Load attachments from disk and link them to this message.
    // Build fullUserMessage for the engine — this is the only place file content
    // enters the pipeline. It is never persisted.
    let fullUserMessage = content;
    const loadedAttachmentFiles: Array<{ path: string; content: string }> = [];
    // Image bytes for vision-capable engine — populated only when engineSupportsVision.
    const imageAttachmentsForEngine: Array<{ filename: string; base64: string; mimeType: string }> = [];
    // Image content blocks for coordinator — populated only when coordinatorSupportsVision.
    const imageBlocksForCoord: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
    // Exhaustive text descriptions of images produced by the sighted model for the blind model.
    // Key = filename, value = description text. Injected after [image: filename] in fullUserMessage.
    const imageDescriptions: Map<string, string> = new Map();

    if (attachment_ids && attachment_ids.length > 0) {
      // Pre-load all attachment records to check for images before processing.
      const allAttachRecs = await Promise.all(attachment_ids.map(aid => attachmentStore.getById(aid)));
      const validAttachRecs = allAttachRecs.filter(Boolean) as NonNullable<typeof allAttachRecs[number]>[];
      const hasImages = validAttachRecs.some(att => att.is_image);

      // ── Case 1: Neither model supports vision — reject immediately ─────────────
      // SSE headers have not been written yet so we can return a plain HTTP 400.
      if (hasImages && !coordinatorSupportsVision && !engineSupportsVision) {
        return reply.status(400).send({
          error: 'Neither model supports images. Attach text files only, or switch to a vision-capable model in settings.',
        });
      }

      // ── Case 2: Only SEREN (engine) has vision — SEREN describes for SAYON ────
      // Before other processing: SEREN sees the image first and produces an exhaustive
      // description. This description is stored and injected into SAYON's prompt after
      // the filename reference. SAYON never receives image bytes.
      // This runs synchronously before SSE headers so the description is available
      // for the entire downstream pipeline including context ingestion.
      if (hasImages && !coordinatorSupportsVision && engineSupportsVision) {
        const imageRecs = validAttachRecs.filter(att => att.is_image);
        for (const att of imageRecs) {
          try {
            const imgBuf = fs.readFileSync(att.disk_path);
            const b64 = imgBuf.toString('base64');
            const description = await engineStream({
              systemPrompt:
                'You are performing image analysis for PHOBOS. ' +
                'Describe this image exhaustively for a text-only model that cannot see it. ' +
                'Cover: subject matter, spatial layout, colors, text visible in the image, ' +
                'objects and their relationships, context, mood, and any details relevant to ' +
                'understanding the image completely. Be precise and thorough. ' +
                'This description will be the only visual context available to the coordinator.',
              messages: [
                {
                  role: 'user',
                  content: `Describe this image (filename: ${att.filename}) exhaustively:`,
                },
              ],
              maxTokens: 1024,
              temperature: 0.1,
              mode: 'no_think',
              imageAttachments: [{ filename: att.filename, base64: b64, mimeType: att.mime_type }],
              stage: 'other',
            });
            if (description.trim()) {
              imageDescriptions.set(att.filename, description.trim());
              console.log(`[messages] SEREN described ${att.filename} for SAYON (${description.length} chars)`);
            }
          } catch (descErr) {
            console.warn(
              `[messages] SEREN image description failed for ${att.filename}:`,
              descErr instanceof Error ? descErr.message : descErr
            );
          }
        }
      }

      const fileBlocks: string[] = [];

      for (const att of validAttachRecs) {
        // Link attachment to the now-created message
        await db.run(
          `UPDATE message_attachments SET message_id = ? WHERE id = ?`,
          [userMsg.id, att.id]
        );

        if (att.is_image) {
          const imgBuf = fs.readFileSync(att.disk_path);
          const b64 = imgBuf.toString('base64');

          if (coordinatorSupportsVision && engineSupportsVision) {
            // ── Case 3: Both have vision — pass bytes to both, no descriptions needed ─
            imageBlocksForCoord.push({
              type: 'image_url',
              image_url: { url: `data:${att.mime_type};base64,${b64}` },
            });
            imageAttachmentsForEngine.push({
              filename: att.filename,
              base64: b64,
              mimeType: att.mime_type,
            });
            fileBlocks.push(`[image: ${att.filename}]`);

          } else if (coordinatorSupportsVision && !engineSupportsVision) {
            // ── Case 4: Only SAYON has vision — SAYON sees bytes, SEREN gets description
            // SAYON receives the actual image bytes. The text instruction below tells SAYON
            // to produce an exhaustive description in its task brief so SEREN has full
            // visual context. SAYON does this naturally during context ingestion and task
            // decomposition — no separate description call needed here.
            imageBlocksForCoord.push({
              type: 'image_url',
              image_url: { url: `data:${att.mime_type};base64,${b64}` },
            });
            fileBlocks.push(
              `[image: ${att.filename}]\n` +
              `VISION NOTE: SEREN cannot see images. You have full visual access to this image. ` +
              `When building SEREN's task brief and any downstream task prompts, ` +
              `include an exhaustive description of the image contents — subject, layout, ` +
              `colors, text, objects, relationships, and any detail relevant to the task. ` +
              `Do not assume SEREN can infer anything from the filename alone.`
            );

          } else {
            // ── Case 5: Only SEREN has vision (came through Case 2 path) ────────────
            // SEREN already described the image above. Inject the description after the
            // filename reference so SAYON has text context. SEREN gets image bytes.
            imageAttachmentsForEngine.push({
              filename: att.filename,
              base64: b64,
              mimeType: att.mime_type,
            });
            const description = imageDescriptions.get(att.filename);
            if (description) {
              fileBlocks.push(
                `[image: ${att.filename}]\n` +
                `<image_description filename="${att.filename}">\n` +
                description +
                `\n</image_description>`
              );
            } else {
              fileBlocks.push(`[image: ${att.filename}]`);
            }
          }

        } else {
          const fileContent = await attachmentStore.readContent(att);
          fileBlocks.push(`<file path="${att.filename}">\n${fileContent}\n</file>`);
          loadedAttachmentFiles.push({ path: att.filename, content: fileContent });
        }
      }

      if (fileBlocks.length > 0) {
        fullUserMessage += `\n\n<attached_files>\n${fileBlocks.join('\n\n')}\n</attached_files>`;
      }
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

    gsm.setPersonaState('sayon', 'classifying_intent');

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

      // If this thread is mid-Phase-1 clarification (SAYON asked before handing to SEREN),
      // skip classification and route to LoopController with the Phase 1 log so
      // ContextIngester can synthesise all Q&A into the final brief for SEREN.
      const pendingPhase1 = pendingPhase1Clarification.get(threadId);

      // Stage 2 (3D): context-aware classification + knowledge search in parallel.
      // Skipped if we already know where to route (either clarification hit).
      const [intent, knowledgeResults] = (pendingClarity || pendingPhase1)
        ? [
            {
              type: (pendingClarity?.originalIntent ?? pendingPhase1?.originalIntent) as IntentType,
              confidence: 1.0,
              routing: 'NEEDS_SEREN' as const,
            },
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
      gsm.setPersonaState('sayon', 'assembling_context');

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

      const { history, ctxMessageCount } = await messageStore.getContextHistory(threadId, summaryStore, context_history_depth);
      const priorHistory = history.slice(0, -1);

      // Emit AUTO-computed context window count so the frontend CTX pill updates.
      // Fires whether the user set a manual depth or we computed it automatically.
      sendEvent({ type: 'ctx_computed', count: ctxMessageCount });

      // Conversation history RAG — runs when the message contains memory-retrieval
      // signals ("remember when", "look back to when", "when we worked on", etc.).
      // Non-blocking on failure — a RAG miss is never fatal.
      const ragResult = await runConversationRAG(threadId, content, workspaceDir).catch(() => null);
      if (ragResult?.contextBlock) {
        fullUserMessage = fullUserMessage + '\n\n' + ragResult.contextBlock;
      }

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
          trackingsendEvent,
          coordinatorSupportsVision ? imageBlocksForCoord : []
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

        // When the user is replying to a Phase 1 question, backfill their reply
        // into the log BEFORE passing to LoopController. Without this, ContextIngester
        // sees an empty userReply, skips synthesis, and rewrites only the latest
        // message in isolation — losing the original request context entirely.
        const phase1LogForLoop = pendingPhase1
          ? [
              ...pendingPhase1.log.slice(0, -1),
              { ...pendingPhase1.log[pendingPhase1.log.length - 1], userReply: fullUserMessage },
            ]
          : undefined;

        const startTime = Date.now();
        gsm.setPersonaState('sayon', 'coordinating');
        gsm.setPersonaState('seren', 'decomposing_tasks');

        const { attempts, lastPlanningContext: loopLastPlanningContext } = await CoordinatorBridge.enqueue({
          reply,
          composeInput: {
            userMessage: fullUserMessage,
            intentType: intent.type as IntentType,
            claudeMd: docs.claudeMd,
            userDirectivesMd: docs.userDirectivesMd,
            projectMd: docs.projectMd,
            chatMd: docs.chatMd,
            chatSummary: chatSummaryRow?.summary,
            conversationHistory: priorHistory,
            repoMap: workspaceIndex,
            loadedFiles: loadedAttachmentFiles,
            knowledgeContext: knowledgeResults.length > 0 ? knowledgeResults : undefined,
            clarificationIteration: pendingClarity ? pendingClarity.count : undefined,
            clarificationLog: pendingClarity ? pendingClarity.log : undefined,
            phase1ClarificationLog: phase1LogForLoop,
            phase1OriginalRequest: pendingPhase1?.originalRequest,
            serenPlanningContext: pendingClarity?.planningContext,
            imageAttachments: imageAttachmentsForEngine.length > 0 ? imageAttachmentsForEngine : undefined,
          },
          loopOptions: {
            buildCommand: build_command ?? extractBuildCommand(docs.claudeMd),
            projectRoot:  workspaceDir,
            workspaceDir: workspaceDir,
            threadId:     threadId,
            skipBuild:    skip_build ?? !hasBuildCommand(docs.claudeMd),
            maxAttempts:  3,
          },
          messageId: assistantMsg.id,
          priority: 'local',
          callbacks: {
            persistEvent: async (eventType, payload) => {
              await eventStore.insert(threadId, eventType as any, payload as object, assistantMsg.id);
            },
            onThinkChunk: async (content: string, source: 'coordinator' | 'engine') => {
              if (!content.trim()) return;
              if (!loopSegIds[source]) {
                loopSegIds[source] = await segmentStore.openSegment(threadId, assistantMsg.id, source);
              }
              await segmentStore.appendToken(loopSegIds[source]!, content);
            },
            onThinkPhaseComplete: async (source: 'coordinator' | 'engine') => {
              await segmentStore.closeLatestSegment(assistantMsg.id, source);
              loopSegIds[source] = null;
            },
            onAgentState: (event) => {
              eventStore.insert(threadId, 'agent_state', event as object, assistantMsg.id).catch(() => {});
            },
            onDispatch: async (info) => {
              try {
                const { PromptLogStore: PLS } = await import('../db/PromptLogStore.js');
                const { DatabaseManager: DM } = await import('../db/DatabaseManager.js');
                const pls = new PLS(DM.getInstance());
                const i = info as any;
                const who = i.assignedTo === 'sayon' ? 'sayon' : 'seren';
                const promptText =
                  `### SYSTEM\n${i.systemPrompt}\n\n` +
                  `### USER (Task ${i.taskIndex}/${i.total}: ${i.title})\n${i.userPrompt}`;
                await pls.insert({
                  threadId,
                  messageId: i.messageId ?? assistantMsg.id,
                  role: who,
                  stage: 'dispatch',
                  model: who === 'sayon' ? (process.env.COORDINATOR_MODEL ?? 'coordinator') : (process.env.ENGINE_MODEL ?? 'engine'),
                  prompt: promptText,
                  response: `[dispatched — op=${i.operation} file="${i.targetFile}"]`,
                  latencyMs: 0,
                });
              } catch { /* never crash the pipeline */ }
            },
            onImageStatus: (status) => {
              const s = status as any;
              sendEvent({ type: 'image_status', phase: s.phase, message: s.message, estSeconds: s.estSeconds });
              if (s.phase === 'done' && s.result) {
                sendEvent({ type: 'image_complete', outputPath: s.result.outputPath, seed: s.result.seed, elapsedMs: s.result.elapsedMs });
                eventStore.insert(threadId, 'image_complete', { type: 'image_complete', outputPath: s.result.outputPath, seed: s.result.seed, elapsedMs: s.result.elapsedMs }, assistantMsg.id).catch(() => {});
              }
            },
            onExecuteResult: (result) => {
              const r = result as any;
              sendEvent({ type: 'execute_result', taskIndex: r.taskIndex, exitCode: r.exitCode, durationMs: r.durationMs, timedOut: r.timedOut, stdoutPreview: r.stdoutPreview, mode: r.mode });
            },
          },
        });


        // ── Post-loop state tracking ─────────────────────────────────────────
        const lastAttempt = (attempts as AttemptResult[])[attempts.length - 1];

        // Phase 1 clarification (SAYON asked before SEREN):
        // - Fresh Phase 1 exit → record questions, store pending state
        // - Re-entry with user reply → backfill reply, clear state (SEREN proceeds)
        if (lastAttempt?.isPhase1Clarification) {
          const questions = lastAttempt.clarificationQuestions ?? [];
          if (pendingPhase1) {
            // Re-entry: ContextIngester fired Phase 1 again despite having a filled log.
            // The pre-fill above already put the reply in phase1LogForLoop.
            // Persist the filled log and keep state — next message will synthesise.
            pendingPhase1Clarification.set(threadId, {
              originalIntent: intent.type as IntentType,
              originalRequest: pendingPhase1.originalRequest,
              log: phase1LogForLoop ?? pendingPhase1.log,
            });
          } else {
            // Fresh Phase 1 question — record it, wait for user reply
            pendingPhase1Clarification.set(threadId, {
              originalIntent: intent.type as IntentType,
              originalRequest: fullUserMessage,
              log: [{ questions, userReply: '' }],
            });
          }
        } else if (pendingPhase1) {
          // SEREN proceeded successfully — Phase 1 is resolved, clear state
          pendingPhase1Clarification.delete(threadId);
        }

        // SEREN clarification (SEREN asked during planning):
        // - Fresh SEREN clarification → start tracking with log entry recording the questions
        // - Mid-clarification + SEREN asked again → backfill user reply into last log entry,
        //   append new entry for the new questions, increment count
        // - Mid-clarification + SEREN proceeded → clear state
        if (lastAttempt?.needsClarification && !lastAttempt?.isPhase1Clarification) {
          const questions = lastAttempt.clarificationQuestions ?? [];
          const updatedLog = pendingClarity
            ? [
                ...pendingClarity.log.slice(0, -1),
                { ...pendingClarity.log[pendingClarity.log.length - 1], userReply: fullUserMessage },
                { questions, userReply: '' },
              ]
            : [{ questions, userReply: '' }];

          // Cache SAYON's planning context from this run so the next re-entry can skip
          // Steps 1+2 (discovery + extraction) and go straight to decomposeTasks.
          const planCtx = (loopLastPlanningContext as any) ?? pendingClarity?.planningContext;

          pendingClarification.set(threadId, {
            originalIntent: intent.type as IntentType,
            originalRequest: pendingClarity?.originalRequest ?? fullUserMessage,
            count: pendingClarity ? pendingClarity.count + 1 : 1,
            log: updatedLog,
            planningContext: planCtx,
          });
        } else if (pendingClarity) {
          pendingClarification.delete(threadId);
        }

        const latencyMs = Date.now() - startTime;

        // When any clarification was returned (Phase 1 or SEREN), the coordinator bubble
        // carrying the questions was already persisted by persistAndSend. The pre-created
        // empty assistantMsg has no content and must be deleted — otherwise the
        // 600ms refetch picks it up and renders a blank message, terminating the
        // conversation visually even though input is re-enabled.
        const isClarificationReturn = attempts.length === 1 &&
          (attempts[0].needsClarification || attempts[0].isPhase1Clarification);
        if (isClarificationReturn) {
          await db.run('DELETE FROM messages WHERE id = ?', [assistantMsg.id]).catch(() => {});
        } else {
          const bestAttempt = attempts.reduce(
            (best, curr) => (curr.reviewScore > best.reviewScore ? curr : best),
            attempts[0]
          );

          if (bestAttempt) {
            const strippedOutput = stripper.strip(bestAttempt.output).output;
            const finalContent = strippedOutput || bestAttempt.output;
            const distilled = distillAssistantContent(finalContent);

            // Update the pre-created assistant message with final content + distilled prose
            await db.run(
              `UPDATE messages SET content = ?, distilled_content = ?, thinking_trace = ?, attempt_number = ?, review_score = ?
               WHERE id = ?`,
              [
                finalContent,
                distilled,
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

            // Collect workspace-relative paths of files produced this turn from
            // the file_panel events LoopController persisted. These become the
            // file linkages for conversation RAG retrieval.
            const producedFilePaths: string[] = [];
            try {
              const turnEvents = await eventStore.getByMessage(assistantMsg.id);
              for (const evt of turnEvents) {
                if (evt.event_type === 'file_panel') {
                  const payload = JSON.parse(evt.payload) as { filename?: string };
                  if (payload.filename) producedFilePaths.push(payload.filename);
                }
              }
            } catch { /* non-fatal — missing file links degrade gracefully */ }

            // Index this turn in the conversation VSS store. Fire-and-forget.
            // Embeds distilled text (prose only) so vectors capture conversation
            // content, not code noise.
            (async () => {
              try {
                const embedInput = buildEmbedInput(content, distilled);
                const vec = await embed(embedInput);
                if (vec) {
                  await writeTurn(threadId, assistantMsg.id, content, distilled, vec, producedFilePaths);
                }
              } catch { /* SYBIL unavailable — index miss, never fatal */ }
            })().catch(() => {});

            // Embed significant content from this task output into SYBIL's semantic
            // memory (workspace scope). Fire-and-forget — never blocks the response.
            embedTaskCompletion(
              threadId,
              assistantMsg.id,
              finalContent,
            ).catch(() => {});
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
      if (intent.type !== 'IMAGE_REQUEST' && intent.type !== 'VIDEO_REQUEST') {
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
      gsm.setPersonaState('sayon', 'idle');
      gsm.setPersonaState('seren', 'idle');
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
  sendEvent: (data: Record<string, unknown>) => void,
  imageContentBlocks: Array<{ type: 'image_url'; image_url: { url: string } }> = []
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
    `requiring more than a conversational response, the user expects it to be routed ` +
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
    // When coordinator supports vision, build a content array for the final user message
    // so image bytes are transmitted alongside the text. Otherwise plain string.
    ...(imageContentBlocks.length > 0
      ? [{
          role: 'user' as const,
          content: [
            { type: 'text', text: userMessage },
            ...imageContentBlocks,
          ] as unknown as string,
        }]
      : [{ role: 'user' as const, content: userMessage }]
    ),
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
    if (!token.trim()) return;  // skip whitespace-only tokens — never open a segment for them
    if (!activeSegmentId) await openCoordSegment();
    await segmentStore.appendToken(activeSegmentId!, token);
  };

  const closeCoordSegment = async (): Promise<void> => {
    if (!activeSegmentId) return;
    await segmentStore.closeSegment(activeSegmentId);
    activeSegmentId = null;
  };

  try {
    gsm.setPersonaState('sayon', 'reviewing_output');
    // ── IMAGE_REQUEST / VIDEO_REQUEST: SAYON enhances prompt → create workflow → start generation ──
    if (intentType === 'IMAGE_REQUEST' || intentType === 'VIDEO_REQUEST') {
      const isVideo = intentType === 'VIDEO_REQUEST';
      sendEvent({ type: 'status', content: isVideo ? 'Preparing video generation…' : 'Preparing image generation…' });

      // ── Discover installed image/video models to inform SAYON ──
      const { IMAGE_MODEL_CATALOGUE, isFluxDownloaded, getImageModelSpec } = await import('../phobos/PhobosLocalManager.js');
      const { buildSdConfig } = await import('../phobos/ImageServerManager.js');

      // Speed-ordered preference for image models (fastest first)
      const IMAGE_SPEED_ORDER = [
        'sdxl-turbo-fp16', 'dreamshaper-xl-turbo-v2', 'z-image-turbo-q4', 'flux2-klein-4b-q4',
        'realvisxl-v5-lightning', 'juggernaut-xl-v9-lightning', 'dreamshaper-xl-lightning',
        'flux-schnell-q4', 'flux-schnell-q8', 'chroma-q4',
        'sdxl-base-fp16', 'realvisxl-v5-fp16', 'juggernaut-xl-v9-fp16', 'pony-diffusion-v6-xl',
        'flux2-klein-9b-q4', 'flux-dev-q4', 'z-image-base-q6', 'qwen-image-q4', 'kontext-dev-q5',
      ];
      // Speed-ordered preference for video models (fastest first)
      const VIDEO_SPEED_ORDER = ['wan21-t2v-1.3b-q4', 'wan22-t2v-14b-q4', 'wan21-t2v-14b-q4', 'wan21-i2v-14b-480p-q4'];

      const installedImageModels = IMAGE_MODEL_CATALOGUE
        .filter(m => m.category !== 'video' && isFluxDownloaded(m))
        .map(m => ({ modelId: m.modelId, label: m.label }));

      const installedVideoModels = IMAGE_MODEL_CATALOGUE
        .filter(m => m.category === 'video' && isFluxDownloaded(m))
        .map(m => ({ modelId: m.modelId, label: m.label }));

      // Pick fastest available model
      const pickFastest = (installed: { modelId: string }[], order: string[]) => {
        for (const id of order) {
          const found = installed.find(m => m.modelId === id);
          if (found) return found.modelId;
        }
        return installed[0]?.modelId ?? null;
      };

      const bestImageModel = pickFastest(installedImageModels, IMAGE_SPEED_ORDER);
      const bestVideoModel = pickFastest(installedVideoModels, VIDEO_SPEED_ORDER);

      // Build model context strings for SAYON
      const imageModelList = installedImageModels.length > 0
        ? installedImageModels.map(m => `  - ${m.modelId} (${m.label})`).join('\n')
        : '  (none installed)';
      const videoModelList = installedVideoModels.length > 0
        ? installedVideoModels.map(m => `  - ${m.modelId} (${m.label})`).join('\n')
        : '  (none installed)';

      // ── SAYON prompt enhancement ──
      const mediaSystemPrompt = isVideo
        ? `You are SAYON, the video generation coordinator for PHOBOS.\n\n` +
          `Installed video models (use the first one listed unless user specifies — it is fastest):\n${videoModelList}\n\n` +
          `Compress the user's video request into a concise generation prompt.\n\n` +
          `PROMPT rules:\n` +
          `- DO NOT re-use the user's prompt verbatim"\n` +
          `- Comma-separated keywords and short phrases ONLY\n` +
          `- Describe motion, subject, scene, style\n` +
          `- 10-20 words maximum, be concise \n` +
          `- Example: "an emerald on a piece of bread, being spread like butter"\n\n` +
          `NEGATIVE PROMPT rules:\n` +
          `- Add at most 1-2 undesired quality terms specific to THIS subject/scene only\n` +
          `- The system already injects: blurry, low quality, watermark, deformed — do NOT repeat those\n\n` +
          `Respond with ONLY valid JSON:\n` +
          `{"prompt": "your compressed prompt", "negativePrompt": "1-2 terms"}`
        : `You are SAYON, the image generation coordinator for PHOBOS.\n\n` +
          `Installed image models (use the first one listed unless user specifies — it is fastest):\n${imageModelList}\n\n` +
          `Compress the user's image request into a photorealistic prompt.\n\n` +
          `POSITIVE PROMPT rules:\n` +
          `- DO NOT re-use the user's prompt verbatim"\n` +
          `- Comma-separated keywords and short noun phrases ONLY — no full sentences, no verbs, no "with a"\n` +
          `- Pattern: subject, setting, action, quality\n` +
          `- Example input: "draw me a pink haired goth girl"\n` +
          `- Example output: "a pink-haired goth girl, in a candlelit dungeon, sitting on a throne, leather corset, 8k, photorealistic"\n` +
          `- 10-16 words, each phrase 1-6 words, comma-separated — 50% subject, 25% setting, 25% action, plus 2 quality tags "8k, photorealistic"\n` +
          `- Less is okay if image calls for simplicity\n\n` +
          `NEGATIVE PROMPT rules:\n` +
          `- Add at most 1-2 undesired quality terms specific to THIS subject/scene only\n` +
          `- The system already injects: blurry, low quality, watermark, deformed — do NOT repeat those\n\n` +
          `Respond with ONLY valid JSON, no markdown, no explanation:\n` +
          `{"prompt": "your compressed prompt", "negativePrompt": "your 1-2 context-specific terms"}`;

      const mediaMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: mediaSystemPrompt },
        { role: 'user', content: userMessage },
      ];

      let enhancedPrompt = userMessage;
      let enhancedNegative = '';

      try {
        const completion = await coordinatorClient.chat.completions.create({
          model: COORDINATOR_MODEL,
          messages: mediaMessages,
          max_tokens: 1024,
          temperature: 0.7,
          stream: false,
        });

        const raw = (completion as any).choices?.[0]?.message?.content ?? '';
        // Strip thinking tokens before parsing.
        // Tag-path models (Nemotron 3, Phi-4, Ministral, SmolLM3) emit
        // <think>...</think> in delta.content when no extraBodyNoThink is applied.
        // This call goes through the raw OpenAI client — no thinking strategy is
        // applied — so the full <think> block lands in content and must be stripped
        // before we attempt JSON extraction. Without this, the entire reasoning
        // trace gets passed to sd-cli as the --prompt argument.
        const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        const cleaned = stripped.replace(/```json\s*|```/g, '').trim();
        try {
          const parsed = JSON.parse(cleaned);
          if (parsed.prompt) enhancedPrompt = parsed.prompt;
          if (parsed.negativePrompt) enhancedNegative = parsed.negativePrompt;
        } catch {
          enhancedPrompt = stripped || userMessage;
        }
      } catch (err) {
        console.warn(`[handleDirect:${isVideo ? 'video' : 'image'}] SAYON prompt enhancement failed:`, (err as Error).message);
      }

      const fullNegative = 'blurry, low quality, watermark, deformed'
        + (enhancedNegative ? ', ' + enhancedNegative : '');

      // ── Create workflow session ──
      const { createSession } = await import('../phobos/WorkflowEngine.js');

      let modelId: string;
      if (isVideo) {
        modelId = bestVideoModel ?? 'wan21-t2v-1.3b-q4';
      } else {
        modelId = bestImageModel ?? 'chroma-q4';
        // Verify the selected image model is actually loadable, fall back if not
        try {
          const cfg = await buildSdConfig({ modelId });
          if (!cfg) {
            const fallbackCfg = await buildSdConfig();
            modelId = fallbackCfg?.fluxSpec?.modelId ?? modelId;
          }
        } catch { /* keep chosen modelId */ }
      }

      const nodeType  = isVideo ? 'VideoGenerate' as const : 'Generate' as const;
      const spec      = getImageModelSpec(modelId);
      const profile   = spec?.profile;

      // Use profile defaults when available — falls back to safe hardcoded defaults
      const nodeParams = isVideo ? {
        prompt:         enhancedPrompt,
        negativePrompt: enhancedNegative || profile?.defaultNegative || '',
        steps:          profile?.defaultSteps   ?? 20,
        width:          profile?.defaultWidth    ?? 832,
        height:         profile?.defaultHeight   ?? 480,
        seed:           -1,
        fps:            12,
        videoFrames:    49,
      } : {
        prompt:         enhancedPrompt,
        negativePrompt: enhancedNegative || profile?.defaultNegative || fullNegative,
        steps:          profile?.defaultSteps   ?? 20,
        width:          profile?.defaultWidth    ?? 1024,
        height:         profile?.defaultHeight   ?? 1024,
        seed:           -1,
        sampler:        profile?.defaultSampler  ?? 'euler',
      };

      const session = createSession(
        threadId,
        userMessage.slice(0, 40).trim() || (isVideo ? 'Video' : 'Image'),
        modelId,
        [{ type: nodeType, label: nodeType, params: nodeParams }],
        isVideo ? 'video' : 'image',
      );

      const modelLabel = isVideo
        ? (installedVideoModels.find(m => m.modelId === modelId)?.label ?? modelId)
        : (installedImageModels.find(m => m.modelId === modelId)?.label ?? modelId);

      sendEvent({ type: 'status', content: `Created workflow: ${session.name}` });
      sendEvent({
        type: 'image_workflow_created',
        workflowId: session.workflowId,
        threadId,
        name: session.name,
        prompt: enhancedPrompt,
        negativePrompt: fullNegative,
      });

      // Fire and forget generation
      try {
        const runUrl = `http://localhost:${process.env.PORT ?? '3001'}/api/threads/${threadId}/workflows/${session.workflowId}/run`;
        const fetchMod = await import('node:http');
        const postData = JSON.stringify({ targetNodeIndex: 0, forceNodeIndex: 0 });
        const req = fetchMod.request(runUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        }, () => {});
        req.write(postData);
        req.end();
      } catch (runErr) {
        console.warn(`[handleDirect:${isVideo ? 'video' : 'image'}] Failed to start generation:`, (runErr as Error).message);
      }

      const mediaType = isVideo ? 'video' : 'image';
      const responseContent = `Starting ${mediaType} generation with ${modelLabel}.\n\n**Prompt:** ${enhancedPrompt}\n\n**Negative:** ${fullNegative}`;
      await messageStore.update(msg.id, { content: responseContent });
      sendEvent({ type: 'coordinator', content: responseContent, source: 'coordinator' });
      sendEvent({ type: 'complete', approved: true, bestAttempt: 1 });
      return msg.id;
    }

    // ── Normal direct response (non-image) ──────────────────────────────────
    const { getThinkingExtraBody: getExtra } = await import('../ai/clients.js');
    const { ThinkingTokenRouter } = await import('../ai/ThinkingTokenRouter.js');
    const coordExtraBody = getExtra(COORD_PROV, COORDINATOR_MODEL, 'think');
    dbg(`[handleDirect:extraBody] ${JSON.stringify(coordExtraBody)}`);
    const coordMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...stratMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];

    let thinkingBuf = '';
    let outputBuf = '';
    let _dbgCount = 0;
    const isPhobos = COORD_PROV === 'phobos';

    // ThinkingTokenRouter: single source of truth for thinking token parsing.
    // onThinkToken callback emits SSE events + persists to segment in real time.
    // startInThink: Nemotron models have thinking_forced_open — the chat template
    // prepends <think> but it's not streamed, so generation starts inside the think block.
    const forcedOpen = strategy.thinkingForcedOpen === true;
    const router = new ThinkingTokenRouter(strategy, 'think', (token: string) => {
      thinkingBuf += token;
      _dbgCount++;
      if (_dbgCount <= 3) dbg(`[handleDirect:think:${_dbgCount}] ${JSON.stringify(token.slice(0, 80))}`);
      appendToSegment(token).catch(() => {});
      sendEvent({ type: 'think_token', token, source: 'coordinator' });
      gsm.incrementTokens('sayon');
    }, forcedOpen);

    // ── Delta iterator: raw fetch for phobos, OpenAI SDK for others ──
    // Phobos MUST use raw fetch because the OpenAI SDK silently strips
    // delta.reasoning_content which field-path models (Nemotron, Qwen3, etc) need.
    async function* deltaIterator(): AsyncGenerator<Record<string, unknown>> {
      if (isPhobos) {
        const baseURL = ((coordinatorClient as unknown as { baseURL?: string }).baseURL ?? '').replace(/\/$/, '');
        const url = `${baseURL}/chat/completions`;
        const body = {
          model: COORDINATOR_MODEL,
          messages: coordMessages,
          max_tokens: 8192,
          temperature: 0.3,
          stream: true,
          // Spread extra body at top level — llama-server accepts these directly
          ...coordExtraBody,
        };
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!resp.ok || !resp.body) throw new Error(`[handleDirect:raw] HTTP ${resp.status}`);
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
              const d = parsed?.choices?.[0]?.delta;
              if (d) yield d as Record<string, unknown>;
            } catch { /* malformed chunk */ }
          }
        }
      } else {
        // Non-phobos: OpenAI SDK stream
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
        for await (const chunk of stream) {
          yield chunk.choices[0]?.delta as Record<string, unknown>;
        }
      }
    }

    for await (const delta of deltaIterator()) {
      const { output } = router.feed(delta);
      if (output) {
        outputBuf += output;
        sendEvent({ type: 'output_token', token: output });
        gsm.incrementTokens('sayon');
      }
    }
    router.flush();

    // Nuclear final strip: remove any <think> blocks that survived streaming parse
    const cleanOutput = ThinkingTokenRouter.finalStrip(outputBuf);

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
        response: cleanOutput,
        latencyMs: 0,
      });
    } catch (_plogErr) { /* never crash the pipeline */ }

    // Close and timestamp the coordinator segment
    await closeCoordSegment();

    // Update the pre-created message row with final content + distilled prose
    const directDistilled = distillAssistantContent(cleanOutput || '(no output)');
    await messageStore.update(msg.id, {
      content: cleanOutput || '(no output)',
      distilled_content: directDistilled,
      thinking_trace: thinkingBuf || null,
    });

    // Index this direct-answer turn in the conversation VSS store. Fire-and-forget.
    (async () => {
      try {
        const embedInput = buildEmbedInput(userMessage, directDistilled);
        const vec = await embed(embedInput);
        if (vec) {
          await writeTurn(threadId, msg.id, userMessage, directDistilled, vec, []);
        }
      } catch { /* SYBIL unavailable — index miss, never fatal */ }
    })().catch(() => {});

    if (thinkingBuf) {
      sendEvent({ type: 'thinking_complete', content: thinkingBuf, source: 'coordinator' });
      await eventStore.insert(threadId, 'thinking_complete', { type: 'thinking_complete', content: thinkingBuf, source: 'coordinator' }, msg.id);
    }

    sendEvent({ type: 'complete', approved: true, bestAttempt: 1 });
    gsm.setPersonaState('sayon', 'idle');
    return msg.id;
  } catch (err) {
    // Close open segment on error so it doesn't remain NULL completed_at forever
    await closeCoordSegment().catch(() => {});
    console.error('[handleDirectResponse] Error:', err);
    sendEvent({ type: 'error', message: 'Coordinator unavailable' });
    gsm.setPersonaState('sayon', 'idle');
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