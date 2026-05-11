/**
 * db/HaWatchStore.ts — DuckDB persistence for Home Assistant watch duty runs.
 *
 * One table: `ha_watch_runs`
 *   One row per watch invocation, whether triggered from the copilot panel
 *   or from a scheduled `ha` task. The HA panel polls this for its history
 *   section, same pattern as SecurityStore scan runs.
 *
 * Uses the system DB (DatabaseManager.getInstance()) — same as HaStore,
 * since watch runs are system-level state, not per-workspace.
 */

import { DatabaseManager } from './DatabaseManager.js';
import { randomUUID }      from 'node:crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export type WatchRunStatus = 'running' | 'success' | 'error';

/** Origin distinguishes copilot-invoked runs from scheduled background runs. */
export type WatchRunOrigin = 'copilot' | 'scheduled';

export interface HaWatchRun {
  id:           string;
  origin:       WatchRunOrigin;
  /** The prompt used for this run — user message or scheduled task prompt. */
  prompt:       string;
  status:       WatchRunStatus;
  started_at:   string;
  completed_at: string | null;
  /** AI analysis output. Null while running or on error. */
  output:       string | null;
  error:        string | null;
  /** Entity count at time of run — snapshot size sanity check. */
  entity_count: number;
}

// ── DDL ───────────────────────────────────────────────────────────────────────

const DDL = `
CREATE TABLE IF NOT EXISTS ha_watch_runs (
  id           VARCHAR   PRIMARY KEY,
  origin       VARCHAR   NOT NULL DEFAULT 'scheduled',
  prompt       VARCHAR   NOT NULL DEFAULT '',
  status       VARCHAR   NOT NULL,
  started_at   TIMESTAMP NOT NULL,
  completed_at TIMESTAMP,
  output       VARCHAR,
  error        VARCHAR,
  entity_count INTEGER   NOT NULL DEFAULT 0
);
`;

// ── Store ─────────────────────────────────────────────────────────────────────

export class HaWatchStore {
  constructor(private db: DatabaseManager) {}

  async ensureTable(): Promise<void> {
    await this.db.run(DDL);
  }

  async createRun(origin: WatchRunOrigin, prompt: string, entityCount: number): Promise<HaWatchRun> {
    const id  = randomUUID();
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO ha_watch_runs (id, origin, prompt, status, started_at, entity_count)
       VALUES (?, ?, ?, 'running', ?, ?)`,
      [id, origin, prompt, now, entityCount],
    );
    return {
      id,
      origin,
      prompt,
      status:       'running',
      started_at:   now,
      completed_at: null,
      output:       null,
      error:        null,
      entity_count: entityCount,
    };
  }

  async completeRun(id: string, output: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE ha_watch_runs
       SET status = 'success', completed_at = ?, output = ?
       WHERE id = ?`,
      [now, output, id],
    );
  }

  async failRun(id: string, error: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE ha_watch_runs
       SET status = 'error', completed_at = ?, error = ?
       WHERE id = ?`,
      [now, error, id],
    );
  }

  /** Returns the most recent runs, newest first. Capped to avoid unbounded growth. */
  async getRecentRuns(limit = 20): Promise<HaWatchRun[]> {
    const rows = await this.db.query<{
      id:           string;
      origin:       string;
      prompt:       string;
      status:       string;
      started_at:   string;
      completed_at: string | null;
      output:       string | null;
      error:        string | null;
      entity_count: number;
    }>(
      `SELECT * FROM ha_watch_runs ORDER BY started_at DESC LIMIT ?`,
      [limit],
    );
    return rows.map(r => ({
      id:           r.id,
      origin:       r.origin as WatchRunOrigin,
      prompt:       r.prompt,
      status:       r.status as WatchRunStatus,
      started_at:   r.started_at,
      completed_at: r.completed_at,
      output:       r.output,
      error:        r.error,
      entity_count: r.entity_count,
    }));
  }

  /** Prune old runs — keep only the most recent N to bound table size. */
  async pruneOldRuns(keep = 100): Promise<void> {
    await this.db.run(
      `DELETE FROM ha_watch_runs
       WHERE id NOT IN (
         SELECT id FROM ha_watch_runs ORDER BY started_at DESC LIMIT ?
       )`,
      [keep],
    );
  }
}
