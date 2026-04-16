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
      const lo = rangeStr === '*' ? min : parseInt(rangeStr.split('-')[0], 10);
      const hi = rangeStr === '*' ? max : (rangeStr.includes('-') ? parseInt(rangeStr.split('-')[1], 10) : lo);
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
    matchField(mField,   date.getMinutes(),  0, 59) &&
    matchField(hField,   date.getHours(),    0, 23) &&
    matchField(domField, date.getDate(),     1, 31) &&
    matchField(monField, date.getMonth() + 1, 1, 12) &&
    matchField(dowField, date.getDay(),      0, 6)
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
// When a task fires but the frontend is busy, we hold it here.
// The frontend polls /api/scheduler/pending and fires when it's ready.

export interface PendingFire {
  taskId:   string;
  taskName: string;
  prompt:   string;
  firedAt:  string;
}

let _pending: PendingFire | null = null;

export function getPendingFire(): PendingFire | null { return _pending; }
export function clearPendingFire(): void { _pending = null; }

// ── Scheduler ─────────────────────────────────────────────────────────────────

export class Scheduler {
  private store:   ScheduledTaskStore;
  private ticker:  ReturnType<typeof setInterval> | null = null;
  private firing:  Set<string> = new Set(); // task IDs currently being processed

  constructor(db: DatabaseManager) {
    this.store = new ScheduledTaskStore(db);
  }

  start(): void {
    this.ticker = setInterval(() => { this.tick().catch(console.error); }, 60_000);
    // Fire immediately to catch any tasks that were due while server was offline.
    // Delay 5s so DB and routes finish initialising first.
    setTimeout(() => { this.tick().catch(console.error); }, 5_000);
    console.log('[Scheduler] Started — 60s tick');
  }

  stop(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    console.log('[Scheduler] Stopped');
  }

  /** Called by the route when the frontend manually triggers a task. */
  async triggerNow(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const task = await this.store.getById(taskId);
    if (!task) return { ok: false, error: 'Task not found' };
    this.signalPending(task);
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
    const now = new Date();
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
  }

  private async tick(): Promise<void> {
    // If something is already pending, don't add more — one at a time.
    if (_pending) return;

    try {
      const due = await this.store.getDue(new Date());
      for (const task of due) {
        if (this.firing.has(task.id)) continue;
        this.firing.add(task.id);
        try {
          this.signalPending(task);
          // Advance next_run_at immediately so the same task doesn't re-fire on
          // the next tick if the frontend hasn't confirmed dispatch yet.
          const next = computeNextRun(task.cron_expression, new Date());
          await this.store.update(task.id, {
            next_run_at: next?.toISOString() ?? null,
          });
          break; // only one pending at a time
        } finally {
          this.firing.delete(task.id);
        }
      }
    } catch (err) {
      console.error('[Scheduler] tick error:', err);
    }
  }

  private signalPending(task: ScheduledTask): void {
    _pending = {
      taskId:   task.id,
      taskName: task.name,
      prompt:   task.prompt,
      firedAt:  new Date().toISOString(),
    };
    console.log(`[Scheduler] Task pending: "${task.name}" (${task.id})`);
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
