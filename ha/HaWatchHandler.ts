/**
 * ha/HaWatchHandler.ts — Home Assistant watch duty core.
 *
 * `runHaWatch(prompt, db)` is the single shared entry point used by:
 *   - The copilot panel (SAYON/SEREN emit [HA_WATCH: <prompt>], intercepted
 *     by routes/copilot.ts which calls this and injects the result inline).
 *   - The scheduler (ha:watch background handler registered in server.ts).
 *
 * Both paths persist a run record to HaWatchStore. The copilot path also
 * returns the output string so it can be streamed back to the user.
 *
 * Phase 3 is strictly read-only. callService() in HAManager is a Phase 4 stub.
 * task_parameters (approval rules) are accepted by the schema but unused here.
 *
 * Design constraints:
 *   - Never allocates inside the AI response loop.
 *   - Guards against HA not connected — logs and records error, never throws.
 *   - Uses coordinatorCall (non-streaming) so the handler awaits completion
 *     before writing the run record. Background handlers must be self-contained.
 */

import { getHaSnapshot }           from '../services/HAManager.js';
import { HaWatchStore, type WatchRunOrigin } from '../db/HaWatchStore.js';
import { DatabaseManager }         from '../db/DatabaseManager.js';

// ── System prompt for the watch analysis ──────────────────────────────────────

const WATCH_SYSTEM_PROMPT =
  `You are a Home Assistant watch duty analyst for the PHOBOS system. ` +
  `You will be given a live snapshot of the user's home entity states and a watch prompt. ` +
  `Analyse the snapshot against the prompt and produce a concise, plain-language report. ` +
  `Focus only on what is notable or anomalous. ` +
  `If everything looks normal, say so briefly. ` +
  `Do not invent entity states — only reference what is in the snapshot. ` +
  `Do not ask clarifying questions — produce a report with what you have.`;

// ── Public API ────────────────────────────────────────────────────────────────

export interface WatchResult {
  runId:  string;
  output: string;
  error:  string | null;
}

/**
 * Run a watch duty analysis.
 *
 * @param prompt   The watch prompt — either the user's copilot message or the
 *                 scheduled task's prompt field.
 * @param origin   'copilot' | 'scheduled' — recorded in the run row.
 * @param db       DatabaseManager instance — used to construct HaWatchStore.
 * @returns        WatchResult with the AI output (or error). Never throws.
 */
export async function runHaWatch(
  prompt:  string,
  origin:  WatchRunOrigin,
  db:      DatabaseManager,
): Promise<WatchResult> {
  const store    = new HaWatchStore(db);
  const snapshot = getHaSnapshot();

  // Guard: HA not connected or no entities loaded.
  if (!snapshot) {
    const error = 'Home Assistant is not connected or no entities are loaded.';
    console.log(`[HaWatch] Skipping run — ${error}`);
    const run = await store.createRun(origin, prompt, 0);
    await store.failRun(run.id, error);
    return { runId: run.id, output: '', error };
  }

  const entityCount = snapshot.split('\n').length;
  const run         = await store.createRun(origin, prompt, entityCount);

  try {
    const { coordinatorCall } = await import('../ai/clients.js');

    const userMessage =
      `## HOME ASSISTANT — LIVE STATE\n${snapshot}\n\n## WATCH PROMPT\n${prompt}`;

    const output = await coordinatorCall({
      systemPrompt: WATCH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      maxTokens:   1024,
      temperature: 0.3,
      mode:        'no_think',
    });

    await store.completeRun(run.id, output);

    // Prune old runs fire-and-forget — never block the result on housekeeping.
    store.pruneOldRuns(100).catch(() => {});

    console.log(`[HaWatch] Run ${run.id} complete (${origin}, ${entityCount} entities)`);
    return { runId: run.id, output, error: null };

  } catch (err) {
    const error = (err as Error).message;
    await store.failRun(run.id, error).catch(() => {});
    console.error(`[HaWatch] Run ${run.id} failed:`, error);
    return { runId: run.id, output: '', error };
  }
}

// ── Scheduler handler registration helper ─────────────────────────────────────
// Called once in server.ts before scheduler.start().

export function registerHaWatchHandler(
  scheduler: import('../scheduling/Scheduler.js').Scheduler,
  db:        DatabaseManager,
): void {
  scheduler.registerHandler('ha:watch', async (task) => {
    // task.prompt is set by the user when creating the scheduled watch task
    // in SchedulerPanel. Fall back to a sensible default if left blank.
    const prompt = task.prompt?.trim()
      || 'Check the current home state. Report any anomalies, lights left on in unoccupied areas, ' +
         "unlocked doors, unusual temperatures, or anything else worth the user's attention. " +
         'If everything looks normal, confirm that briefly.';

    await runHaWatch(prompt, 'scheduled', db);
  });

  console.log('[HaWatchHandler] ha:watch handler registered');
}

// ── Phase 4 stub ──────────────────────────────────────────────────────────────
// callService() in HAManager will be implemented in Phase 4 alongside the
// approval gate UI. Approval rules (task_parameters) are stored in the DB
// but nothing acts on them until Phase 4.