/**
 * CoordinatorBridge.ts  (repo root — main-thread side)
 *
 * Main-thread API for task execution. Routes call CoordinatorBridge.enqueue,
 * which postMessages an ENQUEUE to the coordinator worker_thread and registers
 * a per-taskId handler. Server.ts wires the worker's `message` event to
 * CoordinatorBridge.dispatchOutbound for every message that isn't a round-trip
 * request handled directly in server.ts.
 *
 * Lifecycle:
 *   - server.ts spawns the coordinator Worker, then calls setWorker(worker).
 *     If the worker crashes and respawns, server.ts calls setWorker again.
 *   - enqueue(params) returns a Promise that resolves on TASK_COMPLETE, or
 *     rejects on TASK_ERROR / TASK_ABORTED.
 *   - Per-task handlers self-clean on terminal events.
 */

import { randomUUID } from 'node:crypto';
import type { Worker as NodeWorker } from 'node:worker_threads';
import type { FastifyReply } from 'fastify';
import type { AttemptResult } from './ai/LoopController.js';
import type { ComposeInput }  from './ai/DispatchComposer.js';
import type {
  CoordinatorOutbound,
  CoordinatorInbound,
} from './coordinator/MessageTypes.js';

export interface LoopCallbacks {
  persistEvent:        (eventType: string, payload: unknown, messageId: string) => Promise<void>;
  onThinkChunk:        (content: string, source: 'coordinator' | 'engine', messageId: string) => Promise<void>;
  onThinkPhaseComplete:(source: 'coordinator' | 'engine', messageId: string) => Promise<void>;
  onAgentState:        (event: unknown, messageId: string) => void;
  onDispatch:          (info: unknown, messageId: string) => Promise<void>;
  onImageStatus:       (status: unknown) => void;
  onExecuteResult:     (result: unknown) => void;
}

export interface BridgeEnqueueParams {
  reply:        FastifyReply;
  composeInput: ComposeInput;
  loopOptions:  {
    buildCommand?: string;
    projectRoot?:  string;
    workspaceDir?: string;
    threadId:      string;
    skipBuild?:    boolean;
    maxAttempts?:  number;
  };
  messageId:    string;
  priority?:    'local' | 'external';
  callbacks:    LoopCallbacks;
}

export interface BridgeResult {
  attempts:            AttemptResult[];
  lastPlanningContext: unknown;
  latencyMs:           number;
}

type TaskHandler = (msg: CoordinatorOutbound) => void;

let _worker:          NodeWorker | null = null;
const _taskHandlers = new Map<string, TaskHandler>();

function postToWorker(msg: CoordinatorInbound): void {
  if (!_worker) {
    console.warn('[CoordinatorBridge] postMessage before worker attached — message dropped');
    return;
  }
  _worker.postMessage(msg);
}

export const CoordinatorBridge = {
  /**
   * Called by server.ts on every Worker spawn (initial + every respawn).
   * Replaces the active worker reference; per-task handlers persist across
   * respawn but in-flight tasks against the dead worker will time out their
   * own SSE streams — recovery of pending tasks is not in C2 scope.
   */
  setWorker(worker: NodeWorker): void {
    _worker = worker;
  },

  /**
   * Called by server.ts's central `worker.on('message')` handler for every
   * outbound message that isn't a round-trip request handled inline. Routes
   * to the registered handler for the message's taskId, if any.
   */
  dispatchOutbound(msg: CoordinatorOutbound): void {
    const taskId = (msg as { taskId?: string }).taskId;
    if (!taskId) return;
    const handler = _taskHandlers.get(taskId);
    if (handler) handler(msg);
  },

  /**
   * Enqueue a task with the coordinator.
   * Returns a Promise that resolves on TASK_COMPLETE, forwarding all
   * intermediate per-task messages to callbacks and to reply.raw (SSE).
   */
  enqueue(params: BridgeEnqueueParams): Promise<BridgeResult> {
    const { reply, composeInput, loopOptions, messageId, priority = 'local', callbacks } = params;
    const taskId = randomUUID();

    return new Promise<BridgeResult>((resolve, reject) => {
      _taskHandlers.set(taskId, (msg: CoordinatorOutbound) => {
        switch (msg.type) {
          case 'SSE_EVENT':
            reply.raw.write(`data: ${JSON.stringify(msg.data)}\n\n`);
            break;

          case 'THINK_CHUNK':
            callbacks.onThinkChunk(msg.content, msg.source, msg.messageId).catch(() => {});
            break;

          case 'THINK_PHASE_COMPLETE':
            callbacks.onThinkPhaseComplete(msg.source, msg.messageId).catch(() => {});
            break;

          case 'PERSIST_EVENT':
            callbacks.persistEvent(msg.eventType, msg.payload, msg.messageId).catch(() => {});
            break;

          case 'AGENT_STATE':
            callbacks.onAgentState(msg.event, msg.messageId);
            break;

          case 'DISPATCH_LOG':
            callbacks.onDispatch(msg.info, msg.messageId).catch(() => {});
            break;

          case 'IMAGE_STATUS':
            callbacks.onImageStatus(msg.status);
            break;

          case 'EXECUTE_RESULT':
            callbacks.onExecuteResult(msg.result);
            break;

          case 'TASK_COMPLETE':
            _taskHandlers.delete(taskId);
            resolve({
              attempts:            msg.attempts as AttemptResult[],
              lastPlanningContext: msg.lastPlanningContext,
              latencyMs:           msg.latencyMs,
            });
            break;

          case 'TASK_ERROR':
            _taskHandlers.delete(taskId);
            reject(new Error(msg.error));
            break;

          case 'TASK_ABORTED':
            _taskHandlers.delete(taskId);
            reject(new Error('Task aborted'));
            break;

          default:
            // TASK_QUEUED / TASK_STARTED — informational, no action.
            break;
        }
      });

      postToWorker({
        type:    'ENQUEUE',
        taskId,
        payload: {
          composeInput,
          loopOptions,
          messageId,
          priority,
        },
      });
    });
  },

  /** Abort a queued task (no-op if it has already started executing). */
  abort(taskId: string): void {
    postToWorker({ type: 'ABORT', taskId });
  },

  /** Bump a queued task to the front of the local-priority tier. */
  priorityBump(taskId: string): void {
    postToWorker({ type: 'PRIORITY_BUMP', taskId });
  },

  /**
   * Push an updated model_config to the coordinator after the admin route
   * mutates the underlying table. Coordinator updates its OpenAI clients
   * without touching DuckDB.
   */
  updateModelConfig(coordinator: import('./coordinator/MessageTypes.js').ClientRoleConfig,
                    engine:      import('./coordinator/MessageTypes.js').ClientRoleConfig): void {
    postToWorker({ type: 'MODEL_CONFIG_UPDATE', coordinator, engine });
  },

  /** Push the executor flag after the admin route flips it. */
  updateExecutorFlag(enabled: boolean): void {
    postToWorker({ type: 'EXECUTOR_FLAG_UPDATE', enabled });
  },
};
