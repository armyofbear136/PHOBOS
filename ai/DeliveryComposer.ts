import { coordinatorClient, COORDINATOR_MODEL } from './clients.js';
import type { AttemptResult } from './LoopController.js';

/**
 * Stage 5 — Delivery
 *
 * After all tasks complete, the coordinator assembles a single final
 * natural language message: what was done, what files changed, what failed
 * and why. This is the only message that appears in main chat as the
 * assistant response — the engine's raw XML tool output never reaches
 * the user directly.
 *
 * Uses /no_think for speed — the coordinator has already done its reasoning
 * during Stage 1 and review; this is just prose assembly.
 */

export interface DeliveryInput {
  originalUserMessage: string;
  /** Coordinator's rewritten task from Stage 1 */
  rewrittenTask: string;
  attempts: AttemptResult[];
  /** Files that were successfully written/modified */
  changedFiles: string[];
  /** Whether the final attempt was approved */
  approved: boolean;
}

export class DeliveryComposer {
  /**
   * Generate the final assistant message.
   * Falls back to a structured plain-text summary if the coordinator call fails.
   */
  async compose(
    input: DeliveryInput,
    sendThinking?: (token: string) => void
  ): Promise<string> {
    const { originalUserMessage, rewrittenTask, attempts, changedFiles, approved } = input;

    const lastAttempt = attempts[attempts.length - 1];
    const bestAttempt = attempts.reduce(
      (best, curr) => (curr.reviewScore > best.reviewScore ? curr : best),
      attempts[0]
    );

    // Build a compact context block for the coordinator
    const attemptSummary = attempts
      .map((a) =>
        `Attempt ${a.attemptNumber}: score=${a.reviewScore.toFixed(2)}, ` +
        `approved=${a.approved}, patchesApplied=${a.patchesApplied}, buildPassed=${a.buildPassed}` +
        (a.errorOutput ? `, error="${a.errorOutput.slice(0, 120)}"` : '')
      )
      .join('\n');

    const filesSection = changedFiles.length > 0
      ? `Files modified:\n${changedFiles.map((f) => `  - ${f}`).join('\n')}`
      : 'No files were modified.';

    const statusLine = approved
      ? `Task completed successfully (${attempts.length} attempt${attempts.length > 1 ? 's' : ''}).`
      : `Task did not fully complete after ${attempts.length} attempt${attempts.length > 1 ? 's' : ''}.`;

    const prompt =
      `/no_think Write a concise assistant response summarising what was done. ` +
      `Write in first person, plain prose, 2-4 sentences max. ` +
      `Mention what changed and any caveats. Do not use bullet points or headers. ` +
      `Do not repeat the task verbatim.\n\n` +
      `ORIGINAL REQUEST: ${originalUserMessage}\n\n` +
      `TASK AS DISPATCHED: ${rewrittenTask}\n\n` +
      `${filesSection}\n\n` +
      `${statusLine}\n` +
      `Attempt details:\n${attemptSummary}`;

    try {
      const response = await coordinatorClient.chat.completions.create({
        model: COORDINATOR_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512,
        temperature: 0.3,
        stream: false,
      });

      const raw = response.choices[0]?.message?.content?.trim() ?? '';
      // Strip any leaked thinking blocks
      const clean = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (clean.length > 20) return clean;
    } catch (err) {
      console.warn('[DeliveryComposer] Coordinator delivery call failed, using fallback:', err);
    }

    // Fallback: structured plain text assembled locally
    return this.buildFallback(input, bestAttempt);
  }

  private buildFallback(input: DeliveryInput, bestAttempt: AttemptResult): string {
    const { changedFiles, approved, attempts } = input;

    if (!approved) {
      const reason = bestAttempt.errorOutput
        ? `The last error was: ${bestAttempt.errorOutput.slice(0, 200)}`
        : 'The output did not pass review.';
      return (
        `I was unable to complete this task after ${attempts.length} attempt${attempts.length > 1 ? 's' : ''}. ` +
        `${reason}`
      );
    }

    if (changedFiles.length === 0) {
      return `Done. No files needed to be changed.`;
    }

    const fileList = changedFiles.length === 1
      ? changedFiles[0]
      : `${changedFiles.slice(0, -1).join(', ')} and ${changedFiles[changedFiles.length - 1]}`;

    const attemptNote = attempts.length > 1
      ? ` (took ${attempts.length} attempts)`
      : '';

    return `Done${attemptNote}. Updated ${fileList}.`;
  }
}
