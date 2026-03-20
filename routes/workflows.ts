import type { FastifyInstance } from 'fastify';
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import * as crypto from 'crypto';

import {
  createSession,
  readSession,
  writeSession,
  readIndex,
  run as runWorkflow,
  type WorkflowSession,
  type WorkflowEvent,
} from '../phobos/WorkflowEngine.js';

import {
  buildSdConfig,
  type SdServerConfig,
} from '../phobos/ImageServerManager.js';

import {
  getImageModelSpec,
} from '../phobos/PhobosLocalManager.js';

import {
  snapshotServerOnDevice,
  snapshotAllServersOnDevice,
} from '../phobos/ImageGenerationHandler.js';

import {
  stopServer,
  startServer,
} from '../phobos/LlamaServerManager.js';

// ── Default node for a brand-new workflow ────────────────────────────────────
// New workflows start with a single Generate node pre-populated.

function defaultGenerateNode(variant?: string) {
  // schnell is designed for 4 steps; chroma/dev benefit from 20
  const steps = variant === 'schnell' ? 4 : 20;
  return {
    type: 'Generate' as const,
    label: 'Generate',
    params: {
      prompt:          '',
      negativePrompt:  '',
      steps,
      width:           1024,
      height:          1024,
      seed:            -1,
      sampler:         'euler',
    },
  };
}

function defaultVideoGenerateNode() {
  return {
    type: 'VideoGenerate' as const,
    label: 'Generate',
    params: {
      prompt:        '',
      negativePrompt: '',
      steps:         20,
      width:         832,   // landscape 480P — safe on all VRAM budgets
      height:        480,
      seed:          -1,
      fps:           12,
      videoFrames:   49,    // ~4s at 12fps — safe default for both 1.3B and 14B
    },
  };
}

// ── Global image generation flag ────────────────────────────────────────────
// Set true when any workflow is actively generating (sd-cli running).
// Read by /api/status so the frontend knows LLM servers are intentionally
// stopped for VRAM, not crashed.
let _imageGenerating = false;
export function isImageGenerating(): boolean { return _imageGenerating; }

export async function workflowsRoute(fastify: FastifyInstance): Promise<void> {

  // ── GET /api/threads/:threadId/workflows ──────────────────────────────────
  // Returns the workflow index for a thread (list of sessions with thumbnails)
  // plus the saved panel state (which workflow was open, which node).
  fastify.get<{ Params: { threadId: string } }>(
    '/api/threads/:threadId/workflows',
    async (req, reply) => {
      const { threadId } = req.params;
      if (!threadId) return reply.status(400).send({ error: 'threadId required' });
      const entries = readIndex(threadId);
      // Read saved panel state
      const panelStatePath = path.join(resolveWorkspacesRoot(), threadId, 'workflows', '_panel-state.json');
      let panelState: { workflowId: string; activeNodeIndex: number; panelOpen: boolean } | null = null;
      if (fs.existsSync(panelStatePath)) {
        try { panelState = JSON.parse(fs.readFileSync(panelStatePath, 'utf8')); } catch { /* ignore */ }
      }
      return reply.send({ workflows: entries, panelState });
    }
  );

  // ── GET /api/threads/:threadId/workflows/:workflowId ─────────────────────
  // Returns the full session JSON for a specific workflow.
  fastify.get<{ Params: { threadId: string; workflowId: string } }>(
    '/api/threads/:threadId/workflows/:workflowId',
    async (req, reply) => {
      const { threadId, workflowId } = req.params;
      const session = readSession(threadId, workflowId);
      if (!session) return reply.status(404).send({ error: 'Workflow not found' });
      return reply.send({ session });
    }
  );

  // ── PUT /api/threads/:threadId/workflows/panel-state ──────────────────────
  // Saves which workflow is open and which node is active for this thread.
  // Called on panel open/close/switch and before navigating away.
  fastify.put<{
    Params: { threadId: string };
    Body:   { workflowId: string; activeNodeIndex: number; panelOpen: boolean };
  }>(
    '/api/threads/:threadId/workflows/panel-state',
    async (req, reply) => {
      const { threadId } = req.params;
      const dir = path.join(resolveWorkspacesRoot(), threadId, 'workflows');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, '_panel-state.json');
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(req.body, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      return reply.send({ ok: true });
    }
  );

  // ── POST /api/threads/:threadId/workflows ─────────────────────────────────
  // Creates a new workflow session for the thread.
  // Body: { name?: string, modelId?: string }
  fastify.post<{
    Params: { threadId: string };
    Body:   { name?: string; modelId?: string; workflowType?: 'image' | 'video' };
  }>(
    '/api/threads/:threadId/workflows',
    async (req, reply) => {
      const { threadId } = req.params;
      if (!threadId) return reply.status(400).send({ error: 'threadId required' });

      const workflowType: 'image' | 'video' = req.body?.workflowType === 'video' ? 'video' : 'image';

      // Use explicit modelId from frontend, fall back to auto-detect (image only)
      let modelId = req.body?.modelId?.trim() || '';
      if (!modelId && workflowType === 'image') {
        try {
          const cfg = await buildSdConfig();
          if (cfg) modelId = cfg.fluxSpec.modelId;
        } catch { /* no model installed */ }
      }
      if (!modelId) modelId = 'unknown';

      const defaultLabel = workflowType === 'video' ? 'Video' : 'Image';
      const name = req.body?.name?.trim() || `${defaultLabel} ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;

      const spec = modelId !== 'unknown' ? getImageModelSpec(modelId) : null;
      const variant = spec?.variant;

      const nodes = workflowType === 'video'
        ? [defaultVideoGenerateNode()]
        : [defaultGenerateNode(variant)];

      const session = createSession(threadId, name, modelId, nodes, workflowType);

      return reply.status(201).send({ session });
    }
  );

  // ── PATCH /api/threads/:threadId/workflows/:workflowId/rename ──────────────
  // Renames a workflow session.
  fastify.patch<{
    Params: { threadId: string; workflowId: string };
    Body:   { name: string };
  }>(
    '/api/threads/:threadId/workflows/:workflowId/rename',
    async (req, reply) => {
      const { threadId, workflowId } = req.params;
      const session = readSession(threadId, workflowId);
      if (!session) return reply.status(404).send({ error: 'Workflow not found' });

      const newName = req.body?.name?.trim();
      if (!newName) return reply.status(400).send({ error: 'name required' });

      session.name = newName;
      const dir  = path.join(resolveWorkspacesRoot(), threadId, 'workflows', workflowId);
      const file = path.join(dir, 'session.json');
      const tmp  = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
      fs.renameSync(tmp, file);

      // Also update _index.json so WorkflowsMenu shows the new name
      const idxPath = path.join(resolveWorkspacesRoot(), threadId, 'workflows', '_index.json');
      if (fs.existsSync(idxPath)) {
        try {
          const entries = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
          const entry = entries.find((e: any) => e.workflowId === workflowId);
          if (entry) {
            entry.name = newName;
            const idxTmp = idxPath + '.tmp';
            fs.writeFileSync(idxTmp, JSON.stringify(entries, null, 2), 'utf8');
            fs.renameSync(idxTmp, idxPath);
          }
        } catch { /* non-fatal */ }
      }

      return reply.send({ ok: true });
    }
  );

  // ── POST /api/threads/:threadId/workflows/:workflowId/nodes/:nodeId/source ─
  // Uploads a source image for a Source node. Accepts base64 PNG/JPG/WEBP.
  fastify.post<{
    Params: { threadId: string; workflowId: string; nodeId: string };
    Body:   { data: string; filename: string };
  }>(
    '/api/threads/:threadId/workflows/:workflowId/nodes/:nodeId/source',
    async (req, reply) => {
      const { threadId, workflowId, nodeId } = req.params;
      const session = readSession(threadId, workflowId);
      if (!session) return reply.status(404).send({ error: 'Workflow not found' });

      const node = session.nodes.find((n) => n.id === nodeId);
      if (!node) return reply.status(404).send({ error: 'Node not found' });

      const { data, filename } = req.body;
      if (!data) return reply.status(400).send({ error: 'data required (base64)' });

      const ext = path.extname(filename || '.png').toLowerCase();
      const ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.webp']);
      if (!ALLOWED.has(ext)) {
        return reply.status(400).send({ error: `Unsupported format. Use: ${[...ALLOWED].join(', ')}` });
      }

      // Write to node directory
      const nDir = path.join(resolveWorkspacesRoot(), threadId, 'workflows', workflowId,
        `node-${String(node.index).padStart(2, '0')}-source`);
      fs.mkdirSync(nDir, { recursive: true });
      const sourcePath = path.join(nDir, `source${ext}`);
      fs.writeFileSync(sourcePath, Buffer.from(data, 'base64'));

      // Also write as output.png so the preview endpoint serves it immediately
      const outputPath = path.join(nDir, 'output.png');
      fs.copyFileSync(sourcePath, outputPath);

      // Update node params and set outputPath so preview works without running engine
      node.params = { sourcePath };
      node.paramSnapshot = null;
      node.outputPath = outputPath;

      // Write session
      const dir  = path.join(resolveWorkspacesRoot(), threadId, 'workflows', workflowId);
      const file = path.join(dir, 'session.json');
      const tmp  = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
      fs.renameSync(tmp, file);

      return reply.send({ ok: true, sourcePath });
    }
  );

  // ── PATCH /api/threads/:threadId/workflows/:workflowId/nodes/:nodeId ──────
  // Updates a node's params in the session JSON on disk.
  fastify.patch<{
    Params: { threadId: string; workflowId: string; nodeId: string };
    Body:   { params: Record<string, unknown>; type?: string };
  }>(
    '/api/threads/:threadId/workflows/:workflowId/nodes/:nodeId',
    async (req, reply) => {
      const { threadId, workflowId, nodeId } = req.params;
      const session = readSession(threadId, workflowId);
      if (!session) return reply.status(404).send({ error: 'Workflow not found' });

      const node = session.nodes.find((n) => n.id === nodeId);
      if (!node) return reply.status(404).send({ error: 'Node not found' });

      if (req.body.type && req.body.type !== node.type) {
        // Read the previously saved alternate state (if any)
        const prevAlt = (node as any).altState ?? null;

        // Save current active state into altState
        (node as any).altState = {
          type:          node.type,
          label:         node.label ?? node.type,
          params:        node.params,
          paramSnapshot: node.paramSnapshot,
          outputPath:    node.outputPath,
          executedAt:    node.executedAt,
        };

        if (prevAlt && prevAlt.type === req.body.type) {
          // Restore the preserved state from the previous toggle
          (node as any).type = prevAlt.type;
          node.label = prevAlt.label;
          node.params = prevAlt.params;
          node.paramSnapshot = prevAlt.paramSnapshot;
          node.outputPath = prevAlt.outputPath;
          node.executedAt = prevAlt.executedAt;
        } else {
          // First time switching to this type — use defaults from request
          (node as any).type = req.body.type;
          node.label = req.body.type === 'Source' ? 'Source' : 'Generate';
          node.params = req.body.params;
          node.paramSnapshot = null;
          node.outputPath = null;
          node.executedAt = null;
        }
      } else if (!req.body.type) {
        // Normal param update, no type change
        node.params = req.body.params;
      }
      // Write updated session to disk
      const dir  = path.join(resolveWorkspacesRoot(), threadId, 'workflows', workflowId);
      const file = path.join(dir, 'session.json');
      const tmp  = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
      fs.renameSync(tmp, file);

      return reply.send({ ok: true });
    }
  );

  // ── POST /api/threads/:threadId/workflows/:workflowId/nodes ──────────────
  // Appends a new node to the session.
  // Body: { type: WorkflowNodeType, label?: string, params: Record<string, unknown> }
  fastify.post<{
    Params: { threadId: string; workflowId: string };
    Body:   { type: string; label?: string; params: Record<string, unknown> };
  }>(
    '/api/threads/:threadId/workflows/:workflowId/nodes',
    async (req, reply) => {
      const { threadId, workflowId } = req.params;
      const session = readSession(threadId, workflowId);
      if (!session) return reply.status(404).send({ error: 'Workflow not found' });

      const node = {
        id:            crypto.randomUUID(),
        index:         session.nodes.length,
        type:          req.body.type as WorkflowSession['nodes'][0]['type'],
        label:         req.body.label,
        params:        req.body.params,
        paramSnapshot: null,
        outputPath:    null,
        maskPath:      null,
        depthPath:     null,
        inputSnapshot: null,
        executedAt:    null,
        stale:         false,
      };
      session.nodes.push(node);

      const dir  = path.join(resolveWorkspacesRoot(), threadId, 'workflows', workflowId);
      const file = path.join(dir, 'session.json');
      const tmp  = file + '.tmp';
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
      fs.renameSync(tmp, file);

      return reply.status(201).send({ node });
    }
  );

  // ── GET /api/threads/:threadId/workflows/:workflowId/thumbnail ───────────
  // Serves the thumbnail image for a workflow (final.png or last node output).
  fastify.get<{ Params: { threadId: string; workflowId: string } }>(
    '/api/threads/:threadId/workflows/:workflowId/thumbnail',
    async (req, reply) => {
      const { threadId, workflowId } = req.params;
      const entries = readIndex(threadId);
      const entry   = entries.find((e) => e.workflowId === workflowId);
      // Video workflows have no thumbnail — 204 so img onError suppresses cleanly
      if (entry?.workflowType === 'video') return reply.status(204).send();
      if (!entry?.thumbPath || !fs.existsSync(entry.thumbPath)) {
        return reply.status(404).send({ error: 'No thumbnail yet' });
      }
      const stream = fs.createReadStream(entry.thumbPath);
      return reply.type('image/png').send(stream);
    }
  );

  // ── GET /api/threads/:threadId/workflows/:workflowId/nodes/:nodeIndex/output ──
  // Serves the cached output image for a specific node.
  fastify.get<{ Params: { threadId: string; workflowId: string; nodeIndex: string } }>(
    '/api/threads/:threadId/workflows/:workflowId/nodes/:nodeIndex/output',
    async (req, reply) => {
      const { threadId, workflowId, nodeIndex } = req.params;
      const session = readSession(threadId, workflowId);
      if (!session) return reply.status(404).send({ error: 'Workflow not found' });

      const idx  = parseInt(nodeIndex, 10);
      const node = session.nodes.find((n) => n.index === idx);
      if (!node?.outputPath || !fs.existsSync(node.outputPath)) {
        return reply.status(404).send({ error: 'No output yet' });
      }
      const stream = fs.createReadStream(node.outputPath);
      const ext = path.extname(node.outputPath).toLowerCase();
      const contentType = ext === '.avi' ? 'video/x-msvideo'
        : ext === '.mp4' ? 'video/mp4'
        : 'image/png';
      return reply.type(contentType).send(stream);
    }
  );

  // ── POST /api/threads/:threadId/workflows/:workflowId/abort ─────────────────
  // Kills the in-progress sd-cli process immediately. Safe to call at any time —
  // if nothing is generating it's a no-op.
  fastify.post<{ Params: { threadId: string; workflowId: string } }>(
    '/api/threads/:threadId/workflows/:workflowId/abort',
    async (req, reply) => {
      const { workflowId } = req.params;
      const status = runStatus.get(workflowId);
      if (!status?.generating) {
        return reply.send({ ok: true, message: 'Not generating' });
      }
      if (status.abort) {
        status.abort();
      }
      status.aborted   = true;
      status.generating = false;
      status.error = 'Aborted by user';
      status.completedAt = Date.now();
      return reply.send({ ok: true, message: 'Aborted' });
    }
  );

  // ── POST /api/threads/:threadId/workflows/:workflowId/nodes/:nodeId/save-batch-output ──
  // Called after each batch step completes. Copies the node's current output.png
  // to the workspace images dir using the batch naming convention:
  //   {workflowName}-{nodeIndex:02d}-output-{N}.png
  // where N is auto-incremented from whatever already exists in the images dir.
  fastify.post<{ Params: { threadId: string; workflowId: string; nodeId: string } }>(
    '/api/threads/:threadId/workflows/:workflowId/nodes/:nodeId/save-batch-output',
    async (req, reply) => {
      const { threadId, workflowId, nodeId } = req.params;
      const session = readSession(threadId, workflowId);
      if (!session) return reply.status(404).send({ error: 'Workflow not found' });

      const node = session.nodes.find((n) => n.id === nodeId);
      if (!node) return reply.status(404).send({ error: 'Node not found' });
      if (!node.outputPath || !fs.existsSync(node.outputPath)) {
        return reply.status(404).send({ error: 'No output yet for this node' });
      }

      const isVideo   = session.workflowType === 'video';
      const outExt    = isVideo ? '.avi' : '.png';
      const outSubdir = isVideo ? 'videos' : 'images';
      const outDir    = path.join(resolveWorkspacesRoot(), threadId, outSubdir);
      fs.mkdirSync(outDir, { recursive: true });

      const safeName = session.name.replace(/[^a-z0-9_\-]/gi, '_').slice(0, 48);
      const nodeIdx  = String(node.index).padStart(2, '0');
      const prefix   = `${safeName}-${nodeIdx}-output-`;

      let maxN = 0;
      try {
        for (const f of fs.readdirSync(outDir)) {
          if (f.startsWith(prefix) && f.endsWith(outExt)) {
            const n = parseInt(f.slice(prefix.length, -outExt.length), 10);
            if (!isNaN(n) && n > maxN) maxN = n;
          }
        }
      } catch { /* dir may be empty */ }

      const destFilename = `${prefix}${maxN + 1}${outExt}`;
      const destPath     = path.join(outDir, destFilename);
      fs.copyFileSync(node.outputPath, destPath);

      return reply.send({ filename: destFilename, n: maxN + 1 });
    }
  );

  // ── DELETE /api/threads/:threadId/workflows/:workflowId/nodes/:nodeId ──────────
  // Deletes the last node in the workflow. Only allowed when it's not a Generate
  // or Source node (those are permanent). Caller should verify this before calling.
  fastify.delete<{ Params: { threadId: string; workflowId: string; nodeId: string } }>(
    '/api/threads/:threadId/workflows/:workflowId/nodes/:nodeId',
    async (req, reply) => {
      const { threadId, workflowId, nodeId } = req.params;
      const session = readSession(threadId, workflowId);
      if (!session) return reply.status(404).send({ error: 'Workflow not found' });

      const idx = session.nodes.findIndex((n) => n.id === nodeId);
      if (idx < 0) return reply.status(404).send({ error: 'Node not found' });

      const node = session.nodes[idx];
      if (node.type === 'Generate' || node.type === 'Source') {
        return reply.status(400).send({ error: 'Cannot delete Generate or Source nodes' });
      }
      if (idx !== session.nodes.length - 1) {
        return reply.status(400).send({ error: 'Can only delete the last node' });
      }

      // Remove node from session and persist
      session.nodes.splice(idx, 1);
      writeSession(session);

      return reply.send({ ok: true });
    }
  );

  // ── DELETE /api/threads/:threadId/workflows/:workflowId ────────────────────
  // Deletes a workflow session and all its cached files.
  fastify.delete<{ Params: { threadId: string; workflowId: string } }>(
    '/api/threads/:threadId/workflows/:workflowId',
    async (req, reply) => {
      const { threadId, workflowId } = req.params;
      // Remove session directory
      const dir = path.join(resolveWorkspacesRoot(), threadId, 'workflows', workflowId);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      // Remove from _index.json
      const idxPath = path.join(resolveWorkspacesRoot(), threadId, 'workflows', '_index.json');
      if (fs.existsSync(idxPath)) {
        try {
          const entries = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
          const filtered = entries.filter((e: any) => e.workflowId !== workflowId);
          const tmp = idxPath + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(filtered, null, 2), 'utf8');
          fs.renameSync(tmp, idxPath);
        } catch { /* non-fatal */ }
      }
      return reply.send({ ok: true });
    }
  );

  // ── In-memory generation status per workflow ─────────────────────────────────
  // The frontend polls GET .../run-status instead of relying on SSE staying alive.
  // This survives connection drops, browser timeouts, and page refreshes.
  const runStatus = new Map<string, {
    generating:   boolean;
    phases:       { renderPhase: string; detail: string; done: boolean }[];
    progress:     { nodeIndex: number; step: number; totalSteps: number } | null;
    activeNode:   number;
    error:        string | null;
    completedAt:  number | null;  // Date.now() when done — cleared after frontend reads it
    abort:        (() => void) | null;  // call to kill the sd-cli process immediately
    aborted:      boolean;              // set early so pre-spawn phases can exit cleanly
  }>();

  // GET /api/threads/:threadId/workflows/:workflowId/run-status
  fastify.get<{ Params: { threadId: string; workflowId: string } }>(
    '/api/threads/:threadId/workflows/:workflowId/run-status',
    async (req, reply) => {
      const { workflowId } = req.params;
      const status = runStatus.get(workflowId);
      if (!status) return reply.send({ generating: false, phases: [], progress: null, activeNode: 0, error: null });
      // If completed more than 5s ago, clean up
      if (status.completedAt && Date.now() - status.completedAt > 5000) {
        runStatus.delete(workflowId);
      }
      return reply.send(status);
    }
  );

  // ── POST /api/threads/:threadId/workflows/:workflowId/run ───────────────
  // Starts generation in background. Frontend polls run-status for updates.
  fastify.post<{
    Params: { threadId: string; workflowId: string };
    Body:   { targetNodeIndex: number; isFinal?: boolean; forceNodeIndex?: number };
  }>(
    '/api/threads/:threadId/workflows/:workflowId/run',
    async (req, reply) => {
      const { threadId, workflowId } = req.params;
      const isFinal = req.body?.isFinal === true;
      const forceNodeIndex = req.body?.forceNodeIndex;
      const targetNodeIndex = isFinal
        ? undefined
        : (req.body?.targetNodeIndex ?? 0);

      const session = readSession(threadId, workflowId);
      if (!session) return reply.status(404).send({ error: 'Workflow not found' });

      // Prevent double-start
      if (runStatus.get(workflowId)?.generating) {
        return reply.status(409).send({ error: 'Already generating' });
      }

      let sdCfg = await buildSdConfig({ modelId: session.modelId });
      if (!sdCfg) {
        return reply.status(503).send({ error: 'No image model is downloaded.' });
      }

      const resolvedTarget = targetNodeIndex ?? (session.nodes.length - 1);

      // Force-dirty the clicked node (but not Source nodes — they don't generate)
      if (forceNodeIndex !== undefined && forceNodeIndex < session.nodes.length
          && session.nodes[forceNodeIndex].type !== 'Source') {
        session.nodes[forceNodeIndex].paramSnapshot = null;
      }

      // Check if any non-Source nodes need rendering before stopping LLM servers.
      const needsRender = (() => {
        for (let i = 0; i <= resolvedTarget; i++) {
          const n = session.nodes[i];
          if (n.type === 'Source') continue; // Source nodes don't need GPU
          if (!n.executedAt || !n.paramSnapshot || n.stale) return true;
          if (JSON.stringify(n.params) !== JSON.stringify(n.paramSnapshot)) return true;
        }
        return false;
      })();

      // Initialize status
      const status = {
        generating:  true,
        aborted:     false,              // set by abort endpoint, checked at each wait point
        phases:      [] as { renderPhase: string; detail: string; done: boolean }[],
        progress:    null as { nodeIndex: number; step: number; totalSteps: number } | null,
        activeNode:  resolvedTarget,
        error:       null as string | null,
        completedAt: null as number | null,
        abort:       null as (() => void) | null,
      };
      runStatus.set(workflowId, status);
      _imageGenerating = true;

      const pushPhase = (renderPhase: string, detail: string) => {
        for (const p of status.phases) p.done = true;
        status.phases.push({ renderPhase, detail, done: false });
      };

      // Reply immediately — frontend will poll run-status
      reply.send({ ok: true, generating: true });

      // Run everything in background
      (async () => {
        let snaps: ReturnType<typeof snapshotAllServersOnDevice> = [];

        try {
          if (needsRender) {
            const targetDevice = sdCfg!.deviceIndex;
            snaps = snapshotAllServersOnDevice(targetDevice);

            if (snaps.length > 0) {
              pushPhase('stopping_llm', `Pausing ${snaps.map(s => s.role.toUpperCase()).join(' + ')}…`);
              for (const snap of snaps) {
                try { await stopServer(snap.role); } catch { /* warn */ }
              }
            }

            if (status.aborted) return;

            // Re-query VRAM after stop settles.
            // Poll until free VRAM stops rising (stable = driver finished reclaiming).
            // Never use an absolute threshold — a CPU llama-server holding a CUDA context
            // permanently reduces peak free VRAM and an absolute target may never fire.
            const SETTLE_POLL_MS = 500;
            const SETTLE_MAX_MS  = 5000;
            const SETTLE_START   = Date.now();
            let lastFreeGb = sdCfg!.freeVramGb ?? 0;

            while (true) {
              await new Promise(r => setTimeout(r, SETTLE_POLL_MS));
              if (status.aborted) break;
              const candidate = await buildSdConfig({ modelId: session.modelId });
              if (candidate) {
                sdCfg = candidate;
                const free    = candidate.freeVramGb ?? 0;
                const elapsed = Date.now() - SETTLE_START;
                const stable  = free <= lastFreeGb;
                lastFreeGb    = free;
                if (stable || elapsed >= SETTLE_MAX_MS) break;
              } else if (Date.now() - SETTLE_START >= SETTLE_MAX_MS) {
                break;
              }
            }

            if (!sdCfg) {
              status.error = 'Hardware config lost after server stop.';
              status.generating = false;
              status.completedAt = Date.now();
              return;
            }
          }

          if (status.aborted) return;

          // Run the workflow engine — update status map as events arrive
          for await (const evt of runWorkflow(session, resolvedTarget, sdCfg!, isFinal, (killFn) => { status.abort = killFn; })) {
            // Check abort between every yielded event — this catches aborts that
            // happen between nodes (after one node's proc was killed, before next spawns)
            if (status.aborted) break;
            if (evt.phase === 'node_start') {
              // Also clear the kill function between nodes so a stale proc handle
              // from the previous node doesn't get called on the new node's process
              status.abort = null;
              status.activeNode = evt.nodeIndex;
              // Clear phases for new node
              status.phases = [];
            }
            if (evt.phase === 'render_phase') {
              pushPhase(evt.renderPhase, evt.detail ?? '');
            }
            if (evt.phase === 'render_progress') {
              status.progress = { nodeIndex: evt.nodeIndex, step: evt.step, totalSteps: evt.totalSteps };
            }
            if (evt.phase === 'node_done') {
              for (const p of status.phases) p.done = true;
              status.progress = null;
            }
            if (evt.phase === 'error') {
              status.error = evt.message;
            }
          }
        } catch (err) {
          status.error = (err as Error).message;
        } finally {
          // Restart all LLM servers that were stopped
          if (snaps.length > 0) {
            pushPhase('restarting_llm', `Reloading ${snaps.map(s => s.role.toUpperCase()).join(' + ')}…`);
            for (const snap of snaps) {
              try {
                await startServer(snap.role, {
                  modelId:     snap.modelId,
                  port:        snap.port,
                  gpuLayers:   snap.gpuLayers,
                  contextSize: snap.contextSize,
                  threads:     snap.threads,
                  deviceIndex: snap.deviceIndex,
                  gpuBackend:  snap.gpuBackend,
                });
              } catch { /* non-fatal */ }
            }
          }
          status.generating = false;
          _imageGenerating = false;
          status.completedAt = Date.now();
        }
      })();
    }
  );
}

function resolveWorkspacesRoot(): string {
  return process.env.WORKSPACES_ROOT
    ? path.resolve(process.env.WORKSPACES_ROOT)
    : path.resolve(process.cwd(), 'workspaces');
}
