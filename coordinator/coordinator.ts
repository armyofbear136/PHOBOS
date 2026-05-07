/**
 * coordinator/coordinator.ts
 *
 * Coordinator process — spawned by Fastify via child_process.fork().
 *
 * C2 scope (request queue):
 *   - Receives SharedArrayBuffer from Fastify via IPC
 *   - Writes COORDINATOR_HEARTBEAT every second
 *   - Listens on named pipe for inbound messages from Fastify
 *   - Maintains TaskQueue — serialises concurrent requests, local priority
 *   - Runs LoopController per task; all SSE events and callbacks forward
 *     back to Fastify via pipe (Fastify writes to HTTP SSE stream)
 *   - Emits TASK_COMPLETE / TASK_ERROR when each task finishes
 *
 * C3 will add VramContention.ts and concurrent SAYON/SEREN dispatch.
 */

import { S, ProcessState, SHARED_BUFFER_BYTE_LENGTH } from './SharedState.js';
import { PipeServer }   from './PipeServer.js';
import { TaskQueue }    from './TaskQueue.js';
import type { QueueTask, TaskResult } from './TaskQueue.js';
import { transferOwnership } from '../phobos/LlamaServerManager.js';
import { LoopController }   from '../ai/LoopController.js';
import type { ComposeInput } from '../ai/DispatchComposer.js';

// ── SharedArrayBuffer ─────────────────────────────────────────────────────────

let sharedState: Int32Array | null = null;

function writeState(slot: number, value: number): void {
  if (!sharedState) return;
  Atomics.store(sharedState, slot, value);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ── Pipe ──────────────────────────────────────────────────────────────────────

const pipe = new PipeServer();

// ── Queue ─────────────────────────────────────────────────────────────────────

const queue = new TaskQueue();

queue.on('enqueued', (_taskId: string) => {
  if (sharedState) Atomics.store(sharedState, S.QUEUE_DEPTH, queue.depth);
});

queue.on('completed', (result: TaskResult) => {
  if (sharedState) {
    Atomics.store(sharedState, S.QUEUE_DEPTH, queue.depth);
    Atomics.store(sharedState, S.QUEUE_ACTIVE_TASKS, queue.executing ? 1 : 0);
    Atomics.add(sharedState, S.QUEUE_TOTAL_COMPLETED, 1);
  }

  if (result.error) {
    pipe.send({ type: 'TASK_ERROR', taskId: result.taskId, error: result.error });
  } else {
    pipe.send({
      type:               'TASK_COMPLETE',
      taskId:             result.taskId,
      attempts:           result.attempts,
      lastPlanningContext: result.lastPlanningContext,
      latencyMs:          result.latencyMs,
    });
  }
});

// ── Dispatcher ────────────────────────────────────────────────────────────────

function makeReplyShim(taskId: string): { raw: { write: (chunk: string) => void } } {
  return {
    raw: {
      write(chunk: string): void {
        const dataLine = chunk.replace(/^data: /, '').trim();
        try {
          const data = JSON.parse(dataLine) as Record<string, unknown>;
          pipe.send({ type: 'SSE_EVENT', taskId, data });
        } catch {
          pipe.send({ type: 'SSE_EVENT', taskId, data: { type: 'raw', chunk } });
        }
      },
    },
  };
}

queue.setDispatcher(async (task: QueueTask): Promise<TaskResult> => {
  const startMs = Date.now();

  if (sharedState) {
    Atomics.store(sharedState, S.QUEUE_ACTIVE_TASKS, 1);
    Atomics.store(sharedState, S.QUEUE_DEPTH, queue.depth);
  }

  pipe.send({ type: 'TASK_STARTED', taskId: task.taskId });

  const { composeInput, loopOptions, messageId } = task.payload as {
    composeInput: ComposeInput;
    loopOptions:  Record<string, unknown>;
    messageId:    string;
  };

  const replyShim = makeReplyShim(task.taskId);
  const loopSegIds: Record<string, string | null> = { coordinator: null, engine: null };

  const loopController = new LoopController({
    buildCommand:  loopOptions.buildCommand as string | undefined,
    projectRoot:   loopOptions.projectRoot  as string | undefined,
    workspaceDir:  loopOptions.workspaceDir as string | undefined,
    threadId:      loopOptions.threadId     as string,
    skipBuild:     loopOptions.skipBuild    as boolean | undefined,
    maxAttempts:   loopOptions.maxAttempts  as number | undefined,

    persistEvent: async (eventType, payload) => {
      pipe.send({ type: 'PERSIST_EVENT', taskId: task.taskId, messageId, eventType, payload });
    },

    onThinkChunk: async (content: string, source: 'coordinator' | 'engine') => {
      if (!content.trim()) return;
      if (!loopSegIds[source]) loopSegIds[source] = 'pending';
      pipe.send({ type: 'THINK_CHUNK', taskId: task.taskId, messageId, content, source });
    },

    onThinkPhaseComplete: async (source: 'coordinator' | 'engine') => {
      pipe.send({ type: 'THINK_PHASE_COMPLETE', taskId: task.taskId, messageId, source });
      loopSegIds[source] = null;
    },

    onOutputChunk: async (_content) => { /* not separately persisted */ },

    onAgentState: (event) => {
      pipe.send({ type: 'AGENT_STATE', taskId: task.taskId, messageId, event });
    },

    onDispatch: async (info) => {
      pipe.send({ type: 'DISPATCH_LOG', taskId: task.taskId, messageId, info });
    },

    onImageStatus: (status) => {
      pipe.send({ type: 'IMAGE_STATUS', taskId: task.taskId, status });
    },

    onExecuteResult: (result) => {
      pipe.send({ type: 'EXECUTE_RESULT', taskId: task.taskId, result });
    },
  });

  const attempts = await loopController.run(replyShim as any, composeInput, messageId);

  return {
    taskId:             task.taskId,
    attempts,
    lastPlanningContext: loopController.lastPlanningContext ?? null,
    latencyMs:          Date.now() - startMs,
  };
});

// ── Pipe message routing ──────────────────────────────────────────────────────

pipe.onMessage((msg) => {
  switch (msg.type) {
    case 'ENQUEUE': {
      if (!msg.taskId || !msg.payload) break;
      const p = msg.payload as Record<string, unknown>;
      const task: QueueTask = {
        taskId:     msg.taskId,
        threadId:   (p.loopOptions as Record<string, unknown>)?.threadId as string ?? '',
        priority:   (p.priority as 'local' | 'external') ?? 'local',
        payload:    msg.payload,
        enqueuedAt: Date.now(),
      };
      const position = queue.enqueue(task);
      if (sharedState) Atomics.add(sharedState, S.QUEUE_TOTAL_ENQUEUED, 1);
      pipe.send({ type: 'TASK_QUEUED', taskId: msg.taskId, position });
      break;
    }
    case 'ABORT': {
      if (!msg.taskId) break;
      const removed = queue.abort(msg.taskId);
      if (removed) pipe.send({ type: 'TASK_ABORTED', taskId: msg.taskId });
      break;
    }
    case 'PRIORITY_BUMP': {
      if (!msg.taskId) break;
      queue.priorityBump(msg.taskId);
      break;
    }
    case 'STATUS':
      pipe.send({ type: 'STATUS_REPLY', data: buildStatusSnapshot() });
      break;
    default:
      break;
  }
});

// ── Status snapshot ───────────────────────────────────────────────────────────

function buildStatusSnapshot(): Record<string, number> {
  if (!sharedState) return {};
  return {
    sayonState:   Atomics.load(sharedState, S.SAYON_STATE),
    serenState:   Atomics.load(sharedState, S.SEREN_STATE),
    sybilState:   Atomics.load(sharedState, S.SYBIL_STATE),
    queueDepth:   Atomics.load(sharedState, S.QUEUE_DEPTH),
    activeTasks:  Atomics.load(sharedState, S.QUEUE_ACTIVE_TASKS),
    vramLock:     Atomics.load(sharedState, S.VRAM_LOCK),
  };
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(): void {
  writeState(S.COORDINATOR_BOOT_TIME, nowSeconds());
  heartbeatTimer = setInterval(() => {
    writeState(S.COORDINATOR_HEARTBEAT, nowSeconds());
  }, 1_000);
  heartbeatTimer.unref();
}

// ── IPC bootstrap ─────────────────────────────────────────────────────────────

process.on('message', (msg: unknown) => {
  if (!msg || typeof msg !== 'object') return;
  const m = msg as Record<string, unknown>;

  if (m.type === 'INIT_SHARED_BUFFER') {
    const buf = m.buffer as SharedArrayBuffer;
    if (!buf || buf.byteLength < SHARED_BUFFER_BYTE_LENGTH) {
      console.error('[Coordinator] Received invalid SharedArrayBuffer — size mismatch');
      process.exit(1);
    }
    sharedState = new Int32Array(buf);
    writeState(S.SAYON_STATE, ProcessState.STOPPED);
    writeState(S.SEREN_STATE, ProcessState.STOPPED);
    writeState(S.SYBIL_STATE, ProcessState.STOPPED);
    writeState(S.QUEUE_DEPTH, 0);
    writeState(S.QUEUE_ACTIVE_TASKS, 0);
    transferOwnership();
    startHeartbeat();
    console.log('[Coordinator] SharedArrayBuffer received — coordinator ready');
    process.send?.({ type: 'COORDINATOR_READY' });
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

(async () => {
  try {
    await pipe.listen();
  } catch (err) {
    console.error('[Coordinator] Failed to start pipe server:', err);
    process.exit(1);
  }
})();

// ── Shutdown ──────────────────────────────────────────────────────────────────

function shutdown(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (sharedState) writeState(S.COORDINATOR_HEARTBEAT, 0);
  pipe.close();
  process.exit(0);
}

process.once('SIGINT',  () => shutdown());
process.once('SIGTERM', () => shutdown());
