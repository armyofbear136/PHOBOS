import { DatabaseManager } from './DatabaseManager.js';
import { randomUUID } from 'crypto';

/**
 * Stores every raw AI call: the exact prompt sent and the exact response back.
 *
 * One row per call to coordinatorCall / coordinatorStream / engineStream.
 * This gives a complete audit trail of all internal prompts that are never
 * visible in the normal chat UI — file summaries, request rewrites, task
 * decomposition, dispatch system prompts, review calls, delivery composition, etc.
 *
 * The export route joins this table with messages + thinking_segments to produce
 * a full chronological transcript showing exactly what each model saw and said.
 */

export type PromptRole = 'sayon' | 'allmind';

/**
 * Stage labels — what was this call doing in the pipeline?
 *
 *   classify      IntentClassifier — routing decision
 *   rewrite       ContextIngester — user message rewrite + summary
 *   summarise     ContextIngester — file summarisation batch
 *   discover      TaskPlanner step 1 — which files to read
 *   extract       TaskPlanner step 2 — extract constraints from files
 *   decompose     TaskPlanner step 3 — ALLMIND task decomposition
 *   dispatch      LoopController — per-task ALLMIND execution call
 *   review        LoopController — SAYON review of ALLMIND output
 *   validate      LoopController — final holistic validation
 *   deliver       DeliveryComposer — ALLMIND final summary
 *   summarize_chat ChatSummaryStore — rolling conversation summary
 *   direct        handleDirectResponse — SAYON direct answer
 *   other         anything else
 */
export type PromptStage =
  | 'classify'
  | 'rewrite'
  | 'summarise'
  | 'discover'
  | 'extract'
  | 'decompose'
  | 'dispatch'
  | 'review'
  | 'validate'
  | 'deliver'
  | 'summarize_chat'
  | 'direct'
  | 'other';

export interface PromptLogEntry {
  id: string;
  thread_id: string;
  message_id: string | null;
  role: PromptRole;
  stage: PromptStage;
  model: string;
  /** Full prompt text sent — system prompt + messages concatenated for readability */
  prompt: string;
  /** Raw response text returned by the model */
  response: string;
  latency_ms: number;
  created_at: string;
}

export interface CreatePromptLogInput {
  threadId: string;
  messageId?: string | null;
  role: PromptRole;
  stage: PromptStage;
  model: string;
  prompt: string;
  response: string;
  latencyMs: number;
}

export class PromptLogStore {
  constructor(private db: DatabaseManager) {}

  async insert(input: CreatePromptLogInput): Promise<void> {
    const id  = randomUUID();
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO prompt_log
         (id, thread_id, message_id, role, stage, model, prompt, response, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.threadId,
        input.messageId ?? null,
        input.role,
        input.stage,
        input.model,
        input.prompt,
        input.response,
        input.latencyMs,
        now,
      ]
    );
  }

  async getByThread(threadId: string): Promise<PromptLogEntry[]> {
    return this.db.query<PromptLogEntry>(
      `SELECT * FROM prompt_log WHERE thread_id = ? ORDER BY created_at ASC`,
      [threadId]
    );
  }

  async deleteByThread(threadId: string): Promise<void> {
    await this.db.run(`DELETE FROM prompt_log WHERE thread_id = ?`, [threadId]);
  }
}
