import { EventEmitter } from 'node:events';
import { ScheduledTaskStore, type ScheduledTask } from '../db/ScheduledTaskStore.js';
import { DatabaseManager } from '../db/DatabaseManager.js';

// ── Cron evaluation ───────────────────────────────────────────────────────────
// Standard 5-field: minute hour dom month dow
// Supports: * single-value ranges (1-5) lists (1,3,5) step (*/5)

function matchField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;

  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const [rangeStr, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      const lo   = rangeStr === '*' ? min : parseInt(rangeStr.split('-')[0], 10);
      const hi   = rangeStr === '*' ? max : (rangeStr.includes('-') ? parseInt(rangeStr.split('-')[1], 10) : lo);
      for (let v = lo; v <= hi; v += step) {
        if (v === value) return true;
      }
    } else if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      if (value >= lo && value <= hi) return true;
    } else {
      if (parseInt(part, 10) === value) return true;
    }
  }
  return false;
}

function cronMatches(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [mField, hField, domField, monField, dowField] = parts;
  return (
    matchField(mField,   date.getMinutes(),    0, 59) &&
    matchField(hField,   date.getHours(),      0, 23) &&
    matchField(domField, date.getDate(),       1, 31) &&
    matchField(monField, date.getMonth() + 1,  1, 12) &&
    matchField(dowField, date.getDay(),        0,  6)
  );
}

// Advance to next matching cron minute (up to 1 year forward, checked per minute).
export function computeNextRun(expr: string, after: Date = new Date()): Date | null {
  const cursor = new Date(after);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1); // at least 1 minute in the future

  const limit = new Date(after);
  limit.setFullYear(limit.getFullYear() + 1);

  while (cursor < limit) {
    if (cronMatches(expr, cursor)) return new Date(cursor);
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

// ── Pending-fire state ────────────────────────────────────────────────────────
// Conversation tasks signal here. Frontend polls /api/scheduler/pending,
// opens a thread, and confirms back via /api/scheduler/pending/confirm.

export interface PendingFire {
  taskId:              string;
  taskName:            string;
  prompt:              string;
  firedAt:             string;
  pinned_sayon_model:  string | null;
  pinned_seren_model:  string | null;
  pinned_cartridge_id: string | null;
}

let _pending: PendingFire | null = null;

export function getPendingFire(): PendingFire | null { return _pending; }
export function clearPendingFire(): void             { _pending = null; }

// ── Handler registry ──────────────────────────────────────────────────────────

export type BackgroundHandler = () => Promise<void>;

// ── Scheduler ─────────────────────────────────────────────────────────────────

// Cap on how far in the future a single setTimeout can be set.
// Node's setTimeout max is ~24.8 days before it wraps to 1ms.
// We cap at 12 hours; scheduleNextWake re-arms itself automatically.
const MAX_WAKE_MS = 12 * 60 * 60 * 1000;

export class Scheduler extends EventEmitter {
  private store:    ScheduledTaskStore;
  private handlers: Map<string, BackgroundHandler> = new Map();
  private firing:   Set<string>                    = new Set();
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private running   = false;

  constructor(db: DatabaseManager) {
    super();
    this.store = new ScheduledTaskStore(db);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  start(): void {
    this.running = true;
    // Arm immediately — catches anything that was due while the server was down.
    this.wake().catch(console.error);
    console.log('[Scheduler] Started — event-driven');
  }

  stop(): void {
    this.running = false;
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    console.log('[Scheduler] Stopped');
  }

  // ── Handler registration ────────────────────────────────────────────────────

  registerHandler(key: string, fn: BackgroundHandler): void {
    this.handlers.set(key, fn);
  }

  // ── Public trigger ──────────────────────────────────────────────────────────

  /** Called by the route when the frontend manually triggers a task. */
  async triggerNow(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const task = await this.store.getById(taskId);
    if (!task) return { ok: false, error: 'Task not found' };

    if (task.task_type === 'background' || task.task_type === 'security' || task.task_type === 'ha') {
      setImmediate(() => { this.runBackground(task).catch(console.error); });
    } else {
      this.signalPending(task);
    }
    return { ok: true };
  }

  /** Called by the route when the user cancels the pending fire. */
  cancelPending(): void {
    if (_pending) {
      console.log(`[Scheduler] Pending fire cancelled for task ${_pending.taskId}`);
      _pending = null;
    }
  }

  /** Called by the route when the frontend confirms it has dispatched the task. */
  async confirmDispatched(taskId: string, threadId: string): Promise<void> {
    _pending = null;
    const now  = new Date();
    const task = await this.store.getById(taskId);
    if (!task) return;
    const next = computeNextRun(task.cron_expression, now);
    await this.store.update(taskId, {
      last_run_at:     now.toISOString(),
      last_run_status: 'success',
      last_run_error:  null,
      next_run_at:     next?.toISOString() ?? null,
    });
    await this.store.recordRunStart(taskId, threadId);
    // Re-arm for the next due task now that this one is rescheduled.
    this.scheduleNextWake().catch(console.error);
  }

  // ── Wake signal ─────────────────────────────────────────────────────────────

  /**
   * External callers (syncScheduledTasks, routes) call wake() after any
   * mutation that changes next_run_at so the timer re-arms without delay.
   */
  async wake(): Promise<void> {
    if (!this.running) return;
    await this.tick();
    await this.scheduleNextWake();
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private async scheduleNextWake(): Promise<void> {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }

    const earliest = await this.store.getEarliestNextRun();
    if (!earliest) return; // no enabled tasks with a future run

    const delayMs = Math.max(0, earliest.getTime() - Date.now());
    const clampedMs = Math.min(delayMs, MAX_WAKE_MS);

    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.wake().catch(console.error);
    }, clampedMs);

    // Allow the process to exit cleanly even if only this timer is live.
    this.wakeTimer.unref();
  }

  private async tick(): Promise<void> {
    try {
      const due = await this.store.getDue(new Date());

      for (const task of due) {
        if (this.firing.has(task.id)) continue;
        this.firing.add(task.id);

        // Advance next_run_at immediately — prevents re-fire on the next wake
        // if execution or confirmation is slow.
        const next = computeNextRun(task.cron_expression, new Date());
        await this.store.update(task.id, {
          next_run_at: next?.toISOString() ?? null,
        });

        if (task.task_type === 'background' || task.task_type === 'security' || task.task_type === 'ha') {
          // Fire all background tasks concurrently — no frontend gate.
          setImmediate(() => {
            this.runBackground(task)
              .catch(console.error)
              .finally(() => { this.firing.delete(task.id); });
          });
        } else {
          // Conversation tasks: one pending at a time.
          if (!_pending) {
            this.signalPending(task);
          }
          this.firing.delete(task.id);
          // Do not break — remaining background tasks in the same batch still fire.
        }
      }
    } catch (err) {
      console.error('[Scheduler] tick error:', err);
    }
  }

  private signalPending(task: ScheduledTask): void {
    _pending = {
      taskId:              task.id,
      taskName:            task.name,
      prompt:              task.prompt,
      firedAt:             new Date().toISOString(),
      pinned_sayon_model:  task.pinned_sayon_model  ?? null,
      pinned_seren_model:  task.pinned_seren_model  ?? null,
      pinned_cartridge_id: task.pinned_cartridge_id ?? null,
    };
    console.log(`[Scheduler] Conversation task pending: "${task.name}" (${task.id})`);
  }

  private async runBackground(task: ScheduledTask): Promise<void> {
    const handler = this.handlers.get(task.handler ?? '');

    if (!handler) {
      const msg = `No handler registered for key: "${task.handler}"`;
      console.error(`[Scheduler] ${msg} (task: ${task.name})`);
      await this.store.update(task.id, {
        last_run_at:     new Date().toISOString(),
        last_run_status: 'error',
        last_run_error:  msg,
      });
      return;
    }

    console.log(`[Scheduler] Background task start: "${task.name}"`);
    const runId = await this.store.recordRunStart(task.id, null);

    try {
      await handler();
      await this.store.update(task.id, {
        last_run_at:     new Date().toISOString(),
        last_run_status: 'success',
        last_run_error:  null,
      });
      await this.store.recordRunComplete(runId, 'success', null, null);
      console.log(`[Scheduler] Background task done: "${task.name}"`);
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[Scheduler] Background task error: "${task.name}": ${msg}`);
      await this.store.update(task.id, {
        last_run_at:     new Date().toISOString(),
        last_run_status: 'error',
        last_run_error:  msg,
      });
      await this.store.recordRunComplete(runId, 'error', null, msg);
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _instance: Scheduler | null = null;

export function getScheduler(): Scheduler {
  if (!_instance) throw new Error('Scheduler not initialised');
  return _instance;
}

export function initScheduler(db: DatabaseManager): Scheduler {
  _instance = new Scheduler(db);
  return _instance;
}