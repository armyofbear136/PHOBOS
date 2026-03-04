/**
 * Monitors thinking token usage per dispatch.
 * Emits warnings at 4000 tokens.
 * On next dispatch for the same task, injects a FOCUS: signal.
 */
export class ThinkingBudgetMonitor {
  private static WARN_THRESHOLD = 4000;
  private taskThinkTokens: Map<string, number> = new Map();

  recordTokens(taskId: string, count: number): void {
    const prev = this.taskThinkTokens.get(taskId) ?? 0;
    this.taskThinkTokens.set(taskId, prev + count);
  }

  shouldInjectFocus(taskId: string): boolean {
    const tokens = this.taskThinkTokens.get(taskId) ?? 0;
    return tokens >= ThinkingBudgetMonitor.WARN_THRESHOLD;
  }

  /**
   * Returns a FOCUS: injection string to prepend to the next dispatch
   * when thinking budget has been exceeded on a prior attempt.
   */
  getFocusInjection(taskId: string, taskDescription: string): string {
    const tokens = this.taskThinkTokens.get(taskId) ?? 0;
    if (tokens < ThinkingBudgetMonitor.WARN_THRESHOLD) return '';

    return `FOCUS: Your prior reasoning used ${tokens} thinking tokens. ` +
      `For this attempt, limit your analysis to what is strictly necessary to complete: "${taskDescription}". ` +
      `Skip re-analyzing context you have already processed.\n\n`;
  }

  reset(taskId: string): void {
    this.taskThinkTokens.delete(taskId);
  }

  getTokenCount(taskId: string): number {
    return this.taskThinkTokens.get(taskId) ?? 0;
  }
}
