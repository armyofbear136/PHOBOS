import { DatabaseManager } from './DatabaseManager.js';
import { randomUUID } from 'crypto';

export interface DispatchLog {
  id: string;
  message_id: string | null;
  model: string;
  input_tokens: number;
  think_tokens: number;
  output_tokens: number;
  latency_ms: number;
  attempt_number: number;
  review_score: number | null;
  task_type: string | null;
  result: 'APPROVE' | 'REJECT' | 'ERROR' | 'PENDING';
  created_at: string;
}

export interface CreateDispatchLogInput {
  message_id?: string | null;
  model: string;
  input_tokens?: number;
  think_tokens?: number;
  output_tokens?: number;
  latency_ms?: number;
  attempt_number?: number;
  review_score?: number | null;
  task_type?: string | null;
  result?: DispatchLog['result'];
}

export interface DispatchStats {
  task_type: string | null;
  avg_latency_ms: number;
  avg_think_tokens: number;
  avg_attempts: number;
  approve_rate: number;
  total: number;
}

export class DispatchLogStore {
  constructor(private db: DatabaseManager) {}

  async insert(input: CreateDispatchLogInput): Promise<DispatchLog> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO dispatch_log
         (id, message_id, model, input_tokens, think_tokens, output_tokens,
          latency_ms, attempt_number, review_score, task_type, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.message_id ?? null,
        input.model,
        input.input_tokens ?? 0,
        input.think_tokens ?? 0,
        input.output_tokens ?? 0,
        input.latency_ms ?? 0,
        input.attempt_number ?? 1,
        input.review_score ?? null,
        input.task_type ?? null,
        input.result ?? 'PENDING',
        now,
      ]
    );
    return (await this.db.queryOne<DispatchLog>(
      `SELECT * FROM dispatch_log WHERE id = ?`,
      [id]
    ))!;
  }

  async updateResult(
    id: string,
    result: DispatchLog['result'],
    stats: {
      output_tokens?: number;
      think_tokens?: number;
      latency_ms?: number;
      review_score?: number | null;
    }
  ): Promise<void> {
    await this.db.run(
      `UPDATE dispatch_log SET
         result = ?,
         output_tokens = COALESCE(?, output_tokens),
         think_tokens = COALESCE(?, think_tokens),
         latency_ms = COALESCE(?, latency_ms),
         review_score = COALESCE(?, review_score)
       WHERE id = ?`,
      [
        result,
        stats.output_tokens ?? null,
        stats.think_tokens ?? null,
        stats.latency_ms ?? null,
        stats.review_score ?? null,
        id,
      ]
    );
  }

  async getStats(): Promise<DispatchStats[]> {
    return this.db.query<DispatchStats>(
      `SELECT
         task_type,
         AVG(latency_ms)      AS avg_latency_ms,
         AVG(think_tokens)    AS avg_think_tokens,
         AVG(attempt_number)  AS avg_attempts,
         AVG(CASE WHEN result = 'APPROVE' THEN 1.0 ELSE 0.0 END) AS approve_rate,
         COUNT(*)             AS total
       FROM dispatch_log
       GROUP BY task_type
       ORDER BY total DESC`
    );
  }

  async getRecent(limit = 50): Promise<DispatchLog[]> {
    return this.db.query<DispatchLog>(
      `SELECT * FROM dispatch_log ORDER BY created_at DESC LIMIT ?`,
      [limit]
    );
  }
}
