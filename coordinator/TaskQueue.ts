/**
 * coordinator/TaskQueue.ts
 *
 * Priority queue and dispatch loop for the Coordinator process.
 *
 * Invariants:
 *   - At most one task executing at any time (C2 scope — C3 adds concurrency).
 *   - Local-user tasks are always bumped ahead of external tasks.
 *   - Tasks are dispatched FIFO within the same priority tier.
 *   - A task that errors is removed from queue; caller receives TASK_ERROR.
 *
 * C3 will replace `_executing` with a two-slot model (SAYON + SEREN concurrent).
 */

import { EventEmitter } from 'node:events';

export type TaskPriority = 'local' | 'external';

export interface QueueTask {
  taskId:    string;
  threadId:  string;
  priority:  TaskPriority;
  payload:   unknown;           // serialized ComposeInput + LoopOptions
  enqueuedAt: number;           // Date.now()
}

export interface TaskResult {
  taskId:         string;
  attempts:       unknown[];    // AttemptResult[] — typed as unknown to avoid coordinator importing LoopController types
  lastPlanningContext: unknown;
  latencyMs:      number;
  error?:         string;
}

export type DispatchFn = (task: QueueTask) => Promise<TaskResult>;

const LOCAL_PRIORITY  = 0;
const EXTERNAL_PRIORITY = 1;

function tierOf(p: TaskPriority): number {
  return p === 'local' ? LOCAL_PRIORITY : EXTERNAL_PRIORITY;
}

export class TaskQueue extends EventEmitter {
  private _queue:     QueueTask[] = [];
  private _executing: boolean     = false;
  private _dispatch:  DispatchFn | null = null;

  /** Register the function that actually executes a task. */
  setDispatcher(fn: DispatchFn): void {
    this._dispatch = fn;
  }

  /** Queue depth — for SharedArrayBuffer write. */
  get depth(): number { return this._queue.length; }

  /** True if a task is currently executing. */
  get executing(): boolean { return this._executing; }

  /**
   * Enqueue a task. Local tasks are inserted ahead of all external tasks
   * but after any already-queued local tasks (FIFO within tier).
   * Returns the position (0 = next to execute, after any executing task).
   */
  enqueue(task: QueueTask): number {
    const tier = tierOf(task.priority);

    // Find insertion point: after all tasks of equal or higher priority.
    let insertAt = this._queue.length;
    for (let i = 0; i < this._queue.length; i++) {
      if (tierOf(this._queue[i].priority) > tier) {
        insertAt = i;
        break;
      }
    }
    this._queue.splice(insertAt, 0, task);
    this.emit('enqueued', task.taskId, insertAt);
    this._tryDispatch();
    return insertAt;
  }

  /**
   * Remove a task from the queue if it hasn't started executing yet.
   * Returns true if the task was found and removed.
   */
  abort(taskId: string): boolean {
    const idx = this._queue.findIndex(t => t.taskId === taskId);
    if (idx === -1) return false;
    this._queue.splice(idx, 1);
    this.emit('aborted', taskId);
    return true;
  }

  /**
   * Bump a local task to the front of the local tier.
   * No-op if the task is already executing or not found.
   */
  priorityBump(taskId: string): void {
    const idx = this._queue.findIndex(t => t.taskId === taskId);
    if (idx === -1) return;
    const [task] = this._queue.splice(idx, 1);
    task.priority = 'local';
    // Re-insert at front of local tier (position 0, before any external tasks).
    this._queue.unshift(task);
    this.emit('bumped', taskId);
  }

  private _tryDispatch(): void {
    if (this._executing) return;
    if (this._queue.length === 0) return;
    if (!this._dispatch) return;

    const task = this._queue.shift()!;
    this._executing = true;
    this.emit('dispatching', task.taskId);

    this._dispatch(task)
      .then((result) => {
        this._executing = false;
        this.emit('completed', result);
        this._tryDispatch();
      })
      .catch((err: Error) => {
        this._executing = false;
        const result: TaskResult = {
          taskId:             task.taskId,
          attempts:           [],
          lastPlanningContext: null,
          latencyMs:          Date.now() - task.enqueuedAt,
          error:              err.message,
        };
        this.emit('completed', result);
        this._tryDispatch();
      });
  }
}
