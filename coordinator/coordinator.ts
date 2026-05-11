/**
 * coordinator/coordinator.ts
 *
 * Coordinator worker_thread — spawned by Fastify via `new Worker(coordinatorPath, { workerData })`.
 *
 * What changed from the C2 (pipe-based) implementation:
 *   - Runs as a worker_threads.Worker, not a child_process.fork.
 *   - SharedArrayBuffer arrives via workerData (preserves shared semantics).
 *   - All IPC uses parentPort.postMessage / parentPort.on('message') instead
 *     of a named pipe.
 *   - The worker NEVER touches DuckDB. Values it needs (model config,
 *     executor flag) arrive via INIT_CONFIG. Operations that previously
 *     reached DB directly (writePromptLog, archive search, memory search,
 *     code audit) now round-trip to the main thread via postMessage.
 *
 * What stayed identical:
 *   - SAB slot layout (SharedState.ts) — permanent wire contract.
 *   - TaskQueue priority semantics.
 *   - LoopController dispatch shape — just with new callback wiring.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { randomUUID }             from 'node:crypto';
import { S, ProcessState, SHARED_BUFFER_BYTE_LENGTH } from './SharedState.js';
import { TaskQueue }    from './TaskQueue.js';
import type { QueueTask, TaskResult } from './TaskQueue.js';
import { LoopController }   from '../ai/LoopController.js';
import type { ComposeInput } from '../ai/DispatchComposer.js';
import { applyClientsConfig, setPromptLogSink } from '../ai/clients.js';
import type {
  CoordinatorInbound,
  CoordinatorOutbound,
  CodeAuditResult,
  ClientRoleConfig,
} from './MessageTypes.js';

if (!parentPort) throw new Error('coordinator must be spawned as a worker_thread');

// ── SharedArrayBuffer ─────────────────────────────────────────────────────────
// SAB is provided via workerData at spawn time. This is the canonical pattern
// for cross-thread shared memory in Node — no INIT message dance.

const sharedBuffer = (workerData as { sharedBuffer: SharedArrayBuffer })?.sharedBuffer;
if (!sharedBuffer || sharedBuffer.byteLength < SHARED_BUFFER_BYTE_LENGTH) {
  console.error('[Coordinator] Invalid SharedArrayBuffer in workerData');
  process.exit(1);
}
const sharedState = new Int32Array(sharedBuffer);

function writeState(slot: number, value: number): void {
  Atomics.store(sharedState, slot, value);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ── Outbound helper ──────────────────────────────────────────────────────────

function send(msg: CoordinatorOutbound): void {
  parentPort!.postMessage(msg);
}

// ── Cached config (received via INIT_CONFIG) ─────────────────────────────────
//
// LoopController and DispatchComposer used to read these values from DuckDB
// inside the dispatch loop. The worker now caches them locally; main pushes
// updates whenever the underlying config table changes.

let _executorEnabled = false;

// ── Round-trip request correlation ───────────────────────────────────────────
//
// Three callbacks need a reply from the main thread (DB-bound work).
// Each pending request is identified by a UUID; the inbound REPLY handler
// resolves the matching promise.

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject:  (err: Error) => void;
  timer:   ReturnType<typeof setTimeout>;
}

const pendingArchive = new Map<string, PendingRequest<string>>();
const pendingMemory  = new Map<string, PendingRequest<string>>();
const pendingAudit   = new Map<string, PendingRequest<CodeAuditResult>>();

function makeRoundTrip<T>(
  pendingMap: Map<string, PendingRequest<T>>,
  send: (requestId: string) => void,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const requestId = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingMap.delete(requestId)) reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingMap.set(requestId, { resolve, reject, timer });
    send(requestId);
  });
}

function resolvePending<T>(
  pendingMap: Map<string, PendingRequest<T>>,
  requestId: string,
  result?: T,
  error?: string,
): void {
  const pending = pendingMap.get(requestId);
  if (!pending) return;
  pendingMap.delete(requestId);
  clearTimeout(pending.timer);
  if (error)             pending.reject(new Error(error));
  else if (result === undefined) pending.reject(new Error('reply missing result'));
  else                   pending.resolve(result);
}

// ── DB-bound callbacks — all round-trip to main ──────────────────────────────

async function archiveSearchRemote(query: string, domains: import('../db/ArchiveStore.js').ArchiveDomain[], k: number): Promise<string> {
  return makeRoundTrip(pendingArchive,
    (requestId) => send({ type: 'ARCHIVE_SEARCH_REQUEST', requestId, query, domains, k }),
    30_000,
    'archive search',
  );
}

async function memorySearchRemote(query: string): Promise<string> {
  return makeRoundTrip(pendingMemory,
    (requestId) => send({ type: 'MEMORY_SEARCH_REQUEST', requestId, query }),
    15_000,
    'memory search',
  );
}

async function codeAuditRemote(target: string, taskIndex: number, total: number): Promise<CodeAuditResult> {
  return makeRoundTrip(pendingAudit,
    (requestId) => send({ type: 'CODE_AUDIT_REQUEST', requestId, target, taskIndex, total }),
    300_000, // audit can be slow (multi-file scan + SEREN digest)
    'code audit',
  );
}

// ── Prompt log sink — clients.ts calls this from coordinatorCall etc ─────────
// Wire-up: pass a sink to clients.ts that postMessages PROMPT_LOG to main.
// Main writes to the prompt_log table.

let _activeTaskId: string | null   = null;
let _activeMessageId: string | null = null;
let _activeThreadId: string | null  = null;

setPromptLogSink((entry) => {
  if (!_activeTaskId) return; // no task active — log silently dropped (shouldn't happen mid-stream)
  send({
    type:      'PROMPT_LOG',
    taskId:    _activeTaskId,
    role:      entry.role,
    stage:     entry.stage,
    model:     entry.model,
    prompt:    entry.prompt,
    response:  entry.response,
    latencyMs: entry.latencyMs,
    threadId:  _activeThreadId  ?? '',
    messageId: _activeMessageId ?? null,
  });
});

// ── Heartbeat ────────────────────────────────────────────────────────────────

writeState(S.COORDINATOR_BOOT_TIME, nowSeconds());
const heartbeatTimer = setInterval(() => {
  writeState(S.COORDINATOR_HEARTBEAT, nowSeconds());
}, 1_000);
heartbeatTimer.unref();

// ── Initial state ────────────────────────────────────────────────────────────

writeState(S.SAYON_STATE,         ProcessState.STOPPED);
writeState(S.SEREN_STATE,         ProcessState.STOPPED);
writeState(S.SYBIL_STATE,         ProcessState.STOPPED);
writeState(S.QUEUE_DEPTH,         0);
writeState(S.QUEUE_ACTIVE_TASKS,  0);

// ── Queue ────────────────────────────────────────────────────────────────────

const queue = new TaskQueue();

queue.on('enqueued', () => {
  Atomics.store(sharedState, S.QUEUE_DEPTH, queue.depth);
});

queue.on('completed', (result: TaskResult) => {
  Atomics.store(sharedState, S.QUEUE_DEPTH, queue.depth);
  Atomics.store(sharedState, S.QUEUE_ACTIVE_TASKS, queue.executing ? 1 : 0);
  Atomics.add(sharedState, S.QUEUE_TOTAL_COMPLETED, 1);

  if (result.error) {
    send({ type: 'TASK_ERROR', taskId: result.taskId, error: result.error });
  } else {
    send({
      type:               'TASK_COMPLETE',
      taskId:             result.taskId,
      attempts:           result.attempts,
      lastPlanningContext: result.lastPlanningContext,
      latencyMs:          result.latencyMs,
    });
  }
});

// ── Dispatcher ───────────────────────────────────────────────────────────────

function makeReplyShim(taskId: string): { raw: { write: (chunk: string) => void } } {
  return {
    raw: {
      write(chunk: string): void {
        const dataLine = chunk.replace(/^data: /, '').trim();
        try {
          const data = JSON.parse(dataLine) as Record<string, unknown>;
          send({ type: 'SSE_EVENT', taskId, data });
        } catch {
          send({ type: 'SSE_EVENT', taskId, data: { type: 'raw', chunk } });
        }
      },
    },
  };
}

queue.setDispatcher(async (task: QueueTask): Promise<TaskResult> => {
  const startMs = Date.now();

  Atomics.store(sharedState, S.QUEUE_ACTIVE_TASKS, 1);
  Atomics.store(sharedState, S.QUEUE_DEPTH, queue.depth);

  send({ type: 'TASK_STARTED', taskId: task.taskId });

  const { composeInput, loopOptions, messageId } = task.payload as {
    composeInput: ComposeInput;
    loopOptions:  Record<string, unknown>;
    messageId:    string;
  };

  // Set thread-local context for the prompt log sink.
  const threadId = (loopOptions.threadId as string) ?? '';
  _activeTaskId    = task.taskId;
  _activeMessageId = messageId;
  _activeThreadId  = threadId;

  const replyShim = makeReplyShim(task.taskId);

  const loopController = new LoopController({
    buildCommand:  loopOptions.buildCommand as string | undefined,
    projectRoot:   loopOptions.projectRoot  as string | undefined,
    workspaceDir:  loopOptions.workspaceDir as string | undefined,
    threadId,
    skipBuild:     loopOptions.skipBuild    as boolean | undefined,
    maxAttempts:   loopOptions.maxAttempts  as number | undefined,

    // ── DB-free configuration injected from main ────────────────────────────
    executorEnabled: _executorEnabled,
    archiveSearchFn: archiveSearchRemote,
    memorySearchFn:  memorySearchRemote,
    codeAuditFn:     codeAuditRemote,

    // ── Streaming + persistence callbacks ───────────────────────────────────
    persistEvent: async (eventType, payload) => {
      send({ type: 'PERSIST_EVENT', taskId: task.taskId, messageId, eventType, payload });
    },

    onThinkChunk: async (content: string, source: 'coordinator' | 'engine') => {
      if (!content.trim()) return;
      send({ type: 'THINK_CHUNK', taskId: task.taskId, messageId, content, source });
    },

    onThinkPhaseComplete: async (source: 'coordinator' | 'engine') => {
      send({ type: 'THINK_PHASE_COMPLETE', taskId: task.taskId, messageId, source });
    },

    onOutputChunk: async () => { /* not separately persisted */ },

    onAgentState: (event) => {
      send({ type: 'AGENT_STATE', taskId: task.taskId, messageId, event });
    },

    onDispatch: async (info) => {
      send({ type: 'DISPATCH_LOG', taskId: task.taskId, messageId, info });
    },

    onImageStatus: (status) => {
      send({ type: 'IMAGE_STATUS', taskId: task.taskId, status });
    },

    onExecuteResult: (result) => {
      send({ type: 'EXECUTE_RESULT', taskId: task.taskId, result });
    },
  });

  try {
    const attempts = await loopController.run(replyShim as never, composeInput, messageId);
    return {
      taskId:             task.taskId,
      attempts,
      lastPlanningContext: loopController.lastPlanningContext ?? null,
      latencyMs:          Date.now() - startMs,
    };
  } finally {
    _activeTaskId    = null;
    _activeMessageId = null;
    _activeThreadId  = null;
  }
});

// ── Inbound message handler (replaces pipe.onMessage) ────────────────────────

parentPort.on('message', (msg: CoordinatorInbound) => {
  switch (msg.type) {
    case 'ENQUEUE': {
      if (!msg.taskId || !msg.payload) break;
      const p = msg.payload;
      const task: QueueTask = {
        taskId:     msg.taskId,
        threadId:   p.loopOptions?.threadId ?? '',
        priority:   p.priority ?? 'local',
        payload:    p,
        enqueuedAt: Date.now(),
      };
      const position = queue.enqueue(task);
      Atomics.add(sharedState, S.QUEUE_TOTAL_ENQUEUED, 1);
      send({ type: 'TASK_QUEUED', taskId: msg.taskId, position });
      break;
    }

    case 'ABORT': {
      if (!msg.taskId) break;
      const removed = queue.abort(msg.taskId);
      if (removed) send({ type: 'TASK_ABORTED', taskId: msg.taskId });
      break;
    }

    case 'PRIORITY_BUMP': {
      if (msg.taskId) queue.priorityBump(msg.taskId);
      break;
    }

    case 'INIT_CONFIG': {
      _executorEnabled = msg.payload.executorEnabled;
      applyClientsConfig({
        coordinator: msg.payload.coordinator,
        engine:      msg.payload.engine,
      });
      break;
    }

    case 'MODEL_CONFIG_UPDATE': {
      applyClientsConfig({
        coordinator: msg.coordinator,
        engine:      msg.engine,
      });
      break;
    }

    case 'EXECUTOR_FLAG_UPDATE': {
      _executorEnabled = msg.enabled;
      break;
    }

    case 'ARCHIVE_SEARCH_REPLY': {
      resolvePending(pendingArchive, msg.requestId, msg.result, msg.error);
      break;
    }

    case 'MEMORY_SEARCH_REPLY': {
      resolvePending(pendingMemory, msg.requestId, msg.result, msg.error);
      break;
    }

    case 'CODE_AUDIT_REPLY': {
      resolvePending(pendingAudit, msg.requestId, msg.result, msg.error);
      break;
    }

    default:
      break;
  }
});

// ── Ready signal ─────────────────────────────────────────────────────────────

send({ type: 'COORDINATOR_READY' });

// ── Shutdown ─────────────────────────────────────────────────────────────────

function shutdown(): void {
  clearInterval(heartbeatTimer);
  writeState(S.COORDINATOR_HEARTBEAT, 0);
  process.exit(0);
}

process.once('SIGINT',  () => shutdown());
process.once('SIGTERM', () => shutdown());
