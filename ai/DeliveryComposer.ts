import { engineClient, ENGINE_MODEL } from './clients.js';
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
  /** Per-task outcomes from Stage 3/4 execution */
  taskResults?: Array<{
    task: { index: number; title: string; targetFile: string };
    approved: boolean;
    failReason?: string;
  }>;
}

export class DeliveryComposer {
  async compose(
    input: DeliveryInput,
    sendThinking?: (token: string) => void
  ): Promise<string> {
    const { originalUserMessage, rewrittenTask, attempts, changedFiles, approved, taskResults } = input;

    const bestAttempt = attempts.length > 0
      ? attempts.reduce((best, curr) => (curr.reviewScore > best.reviewScore ? curr : best), attempts[0])
      : null;

    const filesSection = changedFiles.length > 0
      ? `Files modified:\n${changedFiles.map((f) => `  - ${f}`).join('\n')}`
      : 'No files were modified.';

    // Build task-level outcome summary if we have it
    const taskSection = taskResults && taskResults.length > 1
      ? `Tasks:\n${taskResults.map((r) =>
          `  ${r.approved ? '✓' : '✗'} Task ${r.task.index}: ${r.task.title}` +
          (r.failReason ? ` (failed: ${r.failReason.slice(0, 80)})` : '')
        ).join('\n')}`
      : '';

    const statusLine = approved
      ? `All tasks completed successfully.`
      : `Some tasks did not complete. ${taskResults?.filter(r => !r.approved).length ?? 0} of ${taskResults?.length ?? 1} task(s) failed.`;

    const prompt =
      `/no_think Write a concise response summarising the outcome. ` +
      `Write in first person, plain prose, 2-4 sentences max. ` +
      `For file changes: mention what changed and any failures. For answers: confirm what was addressed. ` +
      `Match the tone to the task — technical for code, conversational for questions. ` +
      `Do not use bullet points or headers. Do not repeat the task verbatim.\n\n` +
      `ORIGINAL REQUEST: ${originalUserMessage}\n\n` +
      `TASK AS PLANNED: ${rewrittenTask}\n\n` +
      `${filesSection}\n\n` +
      (taskSection ? `${taskSection}\n\n` : '') +
      `${statusLine}`;

    try {
      const response = await engineClient.chat.completions.create({
        model: ENGINE_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512,
        temperature: 0.3,
        stream: false,
      });

      const raw = response.choices[0]?.message?.content?.trim() ?? '';
      const clean = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (clean.length > 20) return clean;
    } catch (err) {
      console.warn('[DeliveryComposer] Coordinator call failed, using fallback:', err);
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

