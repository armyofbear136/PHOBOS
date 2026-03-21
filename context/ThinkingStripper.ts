/**
 * Removes <think>...</think> and [THINK]...[/THINK] blocks from message content
 * before using messages as input to future AI dispatches.
 *
 * DeepSeek's and Ministral's thinking content should never be re-injected into
 * the next turn's input — only the final output matters.
 * The thinking content is stored separately in messages.thinking_trace.
 */
export class ThinkingStripper {
  /**
   * Extract thinking content and clean output from a raw response.
   * Returns { thinking, output } where output is safe to store as message content.
   * Handles both <think>...</think> (Qwen3, DeepSeek, Nemotron) and
   * [THINK]...[/THINK] (Ministral bracket format).
   */
  strip(rawContent: string): { thinking: string; output: string } {
    const thinkBlocks: string[] = [];

    // Normalize bracket form to angle-bracket form before processing
    const normalized = rawContent
      .replace(/\[THINK\]/gi, '<think>')
      .replace(/\[\/THINK\]/gi, '</think>');

    let cleaned = normalized;

    // Extract all <think>...</think> blocks
    const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
    let match;

    while ((match = thinkRegex.exec(normalized)) !== null) {
      thinkBlocks.push(match[1]);
    }

    // Remove all think blocks from content
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    return {
      thinking: thinkBlocks.join('\n\n---\n\n'),
      output: cleaned,
    };
  }

  /** Strip thinking from a message array (for context building) */
  stripHistory(
    messages: Array<{ role: string; content: string }>
  ): Array<{ role: string; content: string }> {
    return messages.map((m) => ({
      ...m,
      content: this.strip(m.content).output,
    }));
  }
}
