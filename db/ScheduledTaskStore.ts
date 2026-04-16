import { DatabaseManager } from './DatabaseManager.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ScheduledTask {
  id:               string;
  name:             string;
  description:      string | null;
  cron_expression:  string;
  prompt:           string;
  enabled:          boolean;
  last_run_at:      string | null;
  last_run_status:  'success' | 'error' | 'pending' | null;
  last_run_error:   string | null;
  next_run_at:      string | null;
  created_at:       string;
  updated_at:       string;
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
    const rows = await this.db.query<ScheduledTask>(
      `SELECT * FROM scheduled_tasks ORDER BY created_at DESC`
    );
    return rows;
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

  async create(
    fields: Omit<ScheduledTask, 'id' | 'created_at' | 'updated_at' | 'last_run_at' | 'last_run_status' | 'last_run_error'>
  ): Promise<ScheduledTask> {
    const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO scheduled_tasks
         (id, name, description, cron_expression, prompt, enabled, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, fields.name, fields.description ?? null, fields.cron_expression, fields.prompt,
       fields.enabled, fields.next_run_at ?? null, now, now]
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
    const enabled         = fields.enabled         !== undefined ? fields.enabled         : task.enabled;
    const last_run_at     = fields.last_run_at     !== undefined ? fields.last_run_at     : task.last_run_at;
    const last_run_status = fields.last_run_status !== undefined ? fields.last_run_status : task.last_run_status;
    const last_run_error  = fields.last_run_error  !== undefined ? fields.last_run_error  : task.last_run_error;
    const next_run_at     = fields.next_run_at     !== undefined ? fields.next_run_at     : task.next_run_at;

    await this.db.run(
      `UPDATE scheduled_tasks SET
         name = ?, description = ?, cron_expression = ?, prompt = ?, enabled = ?,
         last_run_at = ?, last_run_status = ?, last_run_error = ?, next_run_at = ?, updated_at = ?
       WHERE id = ?`,
      [name, description, cron_expression, prompt, enabled,
       last_run_at, last_run_status, last_run_error, next_run_at, now, id]
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.run(`DELETE FROM scheduled_task_runs WHERE task_id = ?`, [id]);
    await this.db.run(`DELETE FROM scheduled_tasks WHERE id = ?`, [id]);
  }

  async recordRunStart(taskId: string, threadId: string): Promise<string> {
    const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
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
