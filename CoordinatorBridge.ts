/**
 * CoordinatorBridge.ts  (repo root — Fastify side)
 *
 * Fastify-side API for task execution. Called by routes/messages.ts.
 *
 * C2: enqueue() sends the task to the Coordinator via named pipe, then
 * subscribes to all pipe events for that taskId. Pipe events are handled:
 *   - SSE_EVENT        → write directly to reply.raw (SSE stream)
 *   - THINK_CHUNK      → call onThinkChunk callback
 *   - THINK_PHASE_COMPLETE → call onThinkPhaseComplete callback
 *   - PERSIST_EVENT    → call persistEvent callback
 *   - AGENT_STATE      → call onAgentState callback
 *   - DISPATCH_LOG     → call onDispatch callback
 *   - IMAGE_STATUS     → call onImageStatus callback
 *   - EXECUTE_RESULT   → call onExecuteResult callback
 *   - TASK_COMPLETE    → resolve with { attempts, lastPlanningContext, latencyMs }
 *   - TASK_ERROR       → reject with Error
 *   - TASK_ABORTED     → reject with Error('aborted')
 *
 * C3 will add abort() and priorityBump().
 */

import { randomUUID }   from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { AttemptResult } from './ai/LoopController.js';
import type { ComposeInput }  from './ai/DispatchComposer.js';
import type { CoordinatorOutbound } from './coordinator/PipeServer.js';
import { coordinatorPipe }   from './PipeClient.js';

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

export const CoordinatorBridge = {
  /**
   * Enqueue a task with the Coordinator.
   * Returns a Promise that resolves when TASK_COMPLETE arrives, forwarding
   * all intermediate pipe events to callbacks and to reply.raw (SSE).
   */
  enqueue(params: BridgeEnqueueParams): Promise<BridgeResult> {
    const { reply, composeInput, loopOptions, messageId, priority = 'local', callbacks } = params;
    const taskId = randomUUID();

    return new Promise<BridgeResult>((resolve, reject) => {
      coordinatorPipe.onTask(taskId, (msg: CoordinatorOutbound) => {
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
            coordinatorPipe.offTask(taskId);
            resolve({
              attempts:            msg.attempts as AttemptResult[],
              lastPlanningContext: msg.lastPlanningContext,
              latencyMs:           msg.latencyMs,
            });
            break;

          case 'TASK_ERROR':
            coordinatorPipe.offTask(taskId);
            reject(new Error(msg.error));
            break;

          case 'TASK_ABORTED':
            coordinatorPipe.offTask(taskId);
            reject(new Error('Task aborted'));
            break;

          default:
            break;
        }
      });

      coordinatorPipe.send({
        type:    'ENQUEUE',
        taskId,
        payload: { composeInput, loopOptions, messageId, priority },
      });
    });
  },

  requestStatus(): void {
    coordinatorPipe.send({ type: 'STATUS' });
  },
};
