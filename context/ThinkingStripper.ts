/**
 * Removes <think>...</think> blocks from message content before
 * using messages as input to future AI dispatches.
 *
 * DeepSeek's thinking content should never be re-injected into
 * the next turn's input — only the final output matters.
 * The thinking content is stored separately in messages.thinking_trace.
 */
export class ThinkingStripper {
  /**
   * Extract thinking content and clean output from a raw DeepSeek response.
   * Returns { thinking, output } where output is safe to store as message content.
   */
  strip(rawContent: string): { thinking: string; output: string } {
    const thinkBlocks: string[] = [];
    let cleaned = rawContent;

    // Extract all <think>...</think> blocks
    const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
    let match;

    while ((match = thinkRegex.exec(rawContent)) !== null) {
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
