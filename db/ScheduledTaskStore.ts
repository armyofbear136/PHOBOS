import { DatabaseManager } from './DatabaseManager.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Task type drives how the scheduler and handler registry interpret this task.
 *
 *   conversation — signals _pending; frontend polls and opens a thread.
 *   background   — generic headless handler; runs without a frontend.
 *   security     — background task managed by SecurityScanManager.
 *   ha           — Home Assistant watch duty; task_parameters carries approval rules.
 *
 * task_parameters is a JSON blob whose shape is type-specific:
 *   ha:          string[]  — HA service patterns that require user approval before
 *                            execution, e.g. ["lock.lock","climate.*","all_writes"].
 *                            Services not in the list fire automatically.
 *   others:      reserved — null for now; will gain meaning when Phase 3 expands.
 */
export type TaskType = 'conversation' | 'background' | 'security' | 'ha';

export interface ScheduledTask {
  id:               string;
  name:             string;
  description:      string | null;
  cron_expression:  string;
  prompt:           string;
  task_type:        TaskType;
  handler:          string | null;
  /**
   * Type-specific parameters stored as a JSON array/object.
   * For 'ha' tasks: string[] of HA service patterns requiring approval.
   * For other types: null (reserved for future use).
   */
  task_parameters:  string[] | null;
  enabled:          boolean;
  last_run_at:      string | null;
  last_run_status:  'success' | 'error' | 'pending' | null;
  last_run_error:   string | null;
  next_run_at:      string | null;
  created_at:       string;
  updated_at:       string;
  /**
   * Pinned model overrides for scheduled task execution.
   * When set, the scheduler loads these instead of the active RoleConfig.
   * Null = use whatever model is currently active.
   */
  pinned_sayon_model:  string | null;
  pinned_seren_model:  string | null;
  /** Cartridge ID to insert before execution. Null = no cartridge override. */
  pinned_cartridge_id: string | null;
}

export interface ScheduledTaskRun {
  id:             string;
  task_id:        string;
  started_at:     string;
  completed_at:   string | null;
  status:         'running' | 'success' | 'error';
  output_summary: string | null;
  error_message:  string | null;
  thread_id:      string | null;
}

// ── Store ─────────────────────────────────────────────────────────────────────

export class ScheduledTaskStore {
  private db: DatabaseManager;

  constructor(db: DatabaseManager) {
    this.db = db;
  }

  async ensureTable(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id              VARCHAR PRIMARY KEY,
        name            VARCHAR NOT NULL,
        description     VARCHAR,
        cron_expression VARCHAR NOT NULL,
        prompt          TEXT NOT NULL,
        enabled         BOOLEAN DEFAULT true,
        last_run_at     TIMESTAMP,
        last_run_status VARCHAR,
        last_run_error  VARCHAR,
        next_run_at     TIMESTAMP,
        created_at      TIMESTAMP NOT NULL DEFAULT now(),
        updated_at      TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await this.db.run(`
      ALTER TABLE scheduled_tasks
      ADD COLUMN IF NOT EXISTS task_type VARCHAR DEFAULT 'conversation'
    `);

    await this.db.run(`
      ALTER TABLE scheduled_tasks
      ADD COLUMN IF NOT EXISTS handler VARCHAR
    `);

    await this.db.run(`
      ALTER TABLE scheduled_tasks
      ADD COLUMN IF NOT EXISTS pinned_sayon_model VARCHAR
    `);

    await this.db.run(`
      ALTER TABLE scheduled_tasks
      ADD COLUMN IF NOT EXISTS pinned_seren_model VARCHAR
    `);

    await this.db.run(`
      ALTER TABLE scheduled_tasks
      ADD COLUMN IF NOT EXISTS pinned_cartridge_id VARCHAR
    `);

    await this.db.run(`
      ALTER TABLE scheduled_tasks
      ADD COLUMN IF NOT EXISTS task_parameters JSON
    `);

    await this.db.run(`
      CREATE TABLE IF NOT EXISTS scheduled_task_runs (
        id             VARCHAR PRIMARY KEY,
        task_id        VARCHAR NOT NULL,
        started_at     TIMESTAMP NOT NULL,
        completed_at   TIMESTAMP,
        status         VARCHAR NOT NULL,
        output_summary VARCHAR,
        error_message  VARCHAR,
        thread_id      VARCHAR
      )
    `);
  }

  async getAll(): Promise<ScheduledTask[]> {
    return this.db.query<ScheduledTask>(
      `SELECT * FROM scheduled_tasks ORDER BY created_at DESC`
    );
  }

  async getById(id: string): Promise<ScheduledTask | null> {
    const rows = await this.db.query<ScheduledTask>(
      `SELECT * FROM scheduled_tasks WHERE id = ?`, [id]
    );
    return rows[0] ?? null;
  }

  async getDue(now: Date): Promise<ScheduledTask[]> {
    return this.db.query<ScheduledTask>(
      `SELECT * FROM scheduled_tasks
       WHERE enabled = true AND next_run_at IS NOT NULL AND next_run_at <= ?`,
      [now.toISOString()]
    );
  }

  /** Returns the earliest next_run_at across all enabled tasks, or null. */
  async getEarliestNextRun(): Promise<Date | null> {
    const rows = await this.db.query<{ next_run_at: string }>(
      `SELECT MIN(next_run_at) AS next_run_at
       FROM scheduled_tasks
       WHERE enabled = true AND next_run_at IS NOT NULL`
    );
    const val = rows[0]?.next_run_at;
    return val ? new Date(val) : null;
  }

  async create(
    fields: Omit<ScheduledTask, 'id' | 'created_at' | 'updated_at' | 'last_run_at' | 'last_run_status' | 'last_run_error' | 'task_type' | 'handler' | 'task_parameters' | 'pinned_sayon_model' | 'pinned_seren_model' | 'pinned_cartridge_id'>
      & { task_type?: TaskType; handler?: string | null; task_parameters?: string[] | null; pinned_sayon_model?: string | null; pinned_seren_model?: string | null; pinned_cartridge_id?: string | null }
  ): Promise<ScheduledTask> {
    const id  = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO scheduled_tasks
         (id, name, description, cron_expression, prompt, task_type, handler,
          task_parameters, enabled, next_run_at, pinned_sayon_model, pinned_seren_model,
          pinned_cartridge_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, fields.name, fields.description ?? null,
        fields.cron_expression, fields.prompt,
        fields.task_type ?? 'conversation', fields.handler ?? null,
        fields.task_parameters ? JSON.stringify(fields.task_parameters) : null,
        fields.enabled, fields.next_run_at ?? null,
        fields.pinned_sayon_model    ?? null,
        fields.pinned_seren_model    ?? null,
        fields.pinned_cartridge_id   ?? null,
        now, now,
      ]
    );
    return (await this.getById(id))!;
  }

  async update(id: string, fields: Partial<Omit<ScheduledTask, 'id' | 'created_at'>>): Promise<void> {
    const task = await this.getById(id);
    if (!task) return;
    const now = new Date().toISOString();

    const name            = fields.name            ?? task.name;
    const description     = fields.description     !== undefined ? fields.description     : task.description;
    const cron_expression = fields.cron_expression ?? task.cron_expression;
    const prompt          = fields.prompt          ?? task.prompt;
    const task_type       = fields.task_type       ?? task.task_type;
    const handler         = fields.handler         !== undefined ? fields.handler         : task.handler;
    const enabled         = fields.enabled         !== undefined ? fields.enabled         : task.enabled;
    const last_run_at     = fields.last_run_at     !== undefined ? fields.last_run_at     : task.last_run_at;
    const last_run_status = fields.last_run_status !== undefined ? fields.last_run_status : task.last_run_status;
    const last_run_error  = fields.last_run_error  !== undefined ? fields.last_run_error  : task.last_run_error;
    const next_run_at     = fields.next_run_at     !== undefined ? fields.next_run_at     : task.next_run_at;
    const pinned_sayon_model    = fields.pinned_sayon_model    !== undefined ? fields.pinned_sayon_model    : task.pinned_sayon_model;
    const pinned_seren_model    = fields.pinned_seren_model    !== undefined ? fields.pinned_seren_model    : task.pinned_seren_model;
    const pinned_cartridge_id   = fields.pinned_cartridge_id   !== undefined ? fields.pinned_cartridge_id   : task.pinned_cartridge_id;
    const task_parameters       = fields.task_parameters       !== undefined ? fields.task_parameters       : task.task_parameters;

    await this.db.run(
      `UPDATE scheduled_tasks SET
         name = ?, description = ?, cron_expression = ?, prompt = ?,
         task_type = ?, handler = ?, task_parameters = ?, enabled = ?,
         last_run_at = ?, last_run_status = ?, last_run_error = ?,
         next_run_at = ?,
         pinned_sayon_model = ?, pinned_seren_model = ?, pinned_cartridge_id = ?,
         updated_at = ?
       WHERE id = ?`,
      [
        name, description, cron_expression, prompt,
        task_type, handler,
        task_parameters ? JSON.stringify(task_parameters) : null,
        enabled,
        last_run_at, last_run_status, last_run_error,
        next_run_at,
        pinned_sayon_model, pinned_seren_model, pinned_cartridge_id,
        now, id,
      ]
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.run(`DELETE FROM scheduled_task_runs WHERE task_id = ?`, [id]);
    await this.db.run(`DELETE FROM scheduled_tasks WHERE id = ?`, [id]);
  }

  async recordRunStart(taskId: string, threadId: string | null): Promise<string> {
    const id  = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO scheduled_task_runs (id, task_id, started_at, status, thread_id)
       VALUES (?, ?, ?, 'running', ?)`,
      [id, taskId, now, threadId]
    );
    return id;
  }

  async recordRunComplete(
    runId:   string,
    status:  'success' | 'error',
    summary: string | null,
    error:   string | null
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE scheduled_task_runs
       SET completed_at = ?, status = ?, output_summary = ?, error_message = ?
       WHERE id = ?`,
      [now, status, summary, error, runId]
    );
  }

  async getRuns(taskId: string, limit = 20): Promise<ScheduledTaskRun[]> {
    return this.db.query<ScheduledTaskRun>(
      `SELECT * FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?`,
      [taskId, limit]
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Safely parse task_parameters from a ScheduledTask.
 * DuckDB returns JSON columns as strings; this normalises to string[] | null.
 * Used by type-specific handlers to read their parameters without
 * repeating the parse/guard logic.
 */
export function parseTaskParameters(task: ScheduledTask): string[] | null {
  const raw = task.task_parameters;
  if (!raw) return null;
  if (Array.isArray(raw)) return raw as string[];
  try {
    const parsed = JSON.parse(raw as unknown as string);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}