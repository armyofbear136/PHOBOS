import { engineStream } from './clients.js';
import type { AttemptResult } from './LoopController.js';

export interface TaskResultSummary {
  taskIndex: number;
  title: string;
  targetFile: string;
  approved: boolean;
  failReason?: string;
}

export interface DeliveryInput {
  originalUserMessage: string;
  /** Coordinator's rewritten task from Stage 1 */
  rewrittenTask: string;
  attempts: AttemptResult[];
  /** Files that were successfully written/modified */
  changedFiles: string[];
  /** Whether all tasks were approved */
  approved: boolean;
  /** Intent type — controls whether file-outcome framing is included */
  intentType?: string;
  /** Per-task outcomes from Stage 3/4 execution */
  taskResults?: Array<{
    task: { index: number; title: string; targetFile: string };
    approved: boolean;
    failReason?: string;
  }>;
  /** Optional: ALLMIND's final validation result (from Stage 4.5) */
  validationSummary?: string;
}

/**
 * Stage 5: ALLMIND composes the final delivery message.
 *
 * Uses engineStream() which handles the phobos raw-fetch path correctly,
 * avoiding the OpenAI SDK stripping reasoning_content that caused Bug 8.1.
 */
export class DeliveryComposer {
  async compose(
    input: DeliveryInput,
    sendThinking?: (token: string) => void
  ): Promise<string> {
    const { originalUserMessage, rewrittenTask, attempts, changedFiles, approved, taskResults, validationSummary, intentType } = input;

    const isQuestion = intentType === 'QUESTION' || (changedFiles.length === 0 && !taskResults?.length);

    // Build task/file outcome sections — omitted entirely for questions
    const filesSection = changedFiles.length > 0
      ? `Files modified:\n${changedFiles.map((f) => `  - ${f}`).join('\n')}`
      : '';

    const taskSection = taskResults && taskResults.length > 1
      ? `Tasks:\n${taskResults.map((r) =>
          `  ${r.approved ? '✓' : '✗'} Task ${r.task.index}: ${r.task.title}` +
          (r.failReason ? ` (failed: ${r.failReason.slice(0, 80)})` : '')
        ).join('\n')}`
      : '';

    const statusLine = approved
      ? `All tasks completed successfully.`
      : `Some tasks did not complete. ${taskResults?.filter(r => !r.approved).length ?? 0} of ${taskResults?.length ?? 1} task(s) failed.`;

    const validationBlock = validationSummary
      ? `\nFINAL VALIDATION:\n${validationSummary}\n`
      : '';

    // For questions: lean delivery brief — no file outcome noise.
    // For execution: full outcome summary with files, tasks, status.
    const prompt = isQuestion
      ? `Write a concise response confirming what was addressed. ` +
        `Write in first person, plain conversational prose, 2-4 sentences max. ` +
        `Do not mention files, tasks, or whether anything was modified. ` +
        `Do not use bullet points or headers. Do not repeat the question verbatim.\n\n` +
        `ORIGINAL REQUEST: ${originalUserMessage}\n\n` +
        `TASK AS PLANNED: ${rewrittenTask}`
      : `Write a concise response summarising the outcome. ` +
        `Write in first person, plain prose, 2-4 sentences max. ` +
        `For file changes: mention what changed and any failures. ` +
        `Match the tone to the task — technical for code, conversational for questions. ` +
        `Do not use bullet points or headers. Do not repeat the task verbatim.\n\n` +
        `ORIGINAL REQUEST: ${originalUserMessage}\n\n` +
        `TASK AS PLANNED: ${rewrittenTask}\n\n` +
        (filesSection ? `${filesSection}\n\n` : '') +
        (taskSection ? `${taskSection}\n\n` : '') +
        validationBlock +
        statusLine;

    try {
      const clean = await engineStream({
        systemPrompt: '',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 512,
        temperature: 0.3,
        mode: 'no_think',
        onThinkToken: sendThinking,
      });

      if (clean.length > 20) return clean;
    } catch (err) {
      console.warn('[DeliveryComposer] Engine call failed, using fallback:', err);
    }

    return this.buildFallback(input);
  }

  private buildFallback(input: DeliveryInput): string {
    const { changedFiles, approved, attempts, taskResults } = input;

    if (!approved) {
      const failedTasks = taskResults?.filter(r => !r.approved) ?? [];
      const reason = failedTasks.length > 0
        ? `Failed: ${failedTasks.map(r => r.task.title).join(', ')}.`
        : attempts[attempts.length - 1]?.errorOutput?.slice(0, 200) ?? 'The output did not pass review.';
      return `I was unable to complete all tasks. ${reason}`;
    }

    if (changedFiles.length === 0) {
      return 'Done. No files needed to be changed.';
    }

    const fileList = changedFiles.length === 1
      ? changedFiles[0]
      : `${changedFiles.slice(0, -1).join(', ')} and ${changedFiles[changedFiles.length - 1]}`;

    const taskNote = taskResults && taskResults.length > 1
      ? ` across ${taskResults.length} tasks`
      : '';

    return `Done. Updated ${fileList}${taskNote}.`;
  }
}

