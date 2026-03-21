/**
 * ThinkingTokenRouter — single source of truth for thinking token parsing.
 *
 * Replaces duplicated field-path / tag-path / safety-strip logic across
 * coordinatorCall, coordinatorStream, engineStream, runSingleStream, and
 * handleDirectResponse. One implementation, correct everywhere.
 *
 * Design:
 *   const router = new ThinkingTokenRouter(strategy, mode, onThinkToken);
 *   for (const delta of stream) {
 *     const { think, output } = router.feed(delta);
 *     if (think) sendToThinkingPanel(think);
 *     if (output) sendToOutputBuffer(output);
 *   }
 *   const { think, output } = router.flush();
 *
 * Handles:
 *   - Field-path: reasoning_content / reasoning / thinking → think channel
 *   - Tag-path: <think>...</think> inline in delta.content → split
 *   - Safety strip: leaked <think> tags in content on field-path when
 *     enable_thinking:false is ignored by the model
 *   - Cross-chunk state: <think> tag split across SSE boundaries
 *   - no_think fallback: reasoning_content → output when reasoning_format:none
 *     routes the answer to reasoning_content instead of content
 */

import type { ThinkingStrategy } from './clients.js';

/**
 * Returns the longest suffix of `text` that is a proper prefix of `tag`,
 * or '' if no such suffix exists.
 *
 * Used to detect when an SSE chunk ends mid-tag (e.g. text ends with "<th"
 * when tag is "<think>"). The returned partial is held in partialTagBuf and
 * prepended to the next chunk so the full tag can be matched.
 *
 * Examples:
 *   trailingPartialTag("hello <th",  "<think>") → "<th"
 *   trailingPartialTag("hello <thi", "<think>") → "<thi"
 *   trailingPartialTag("hello",      "<think>") → ""
 *   trailingPartialTag("</th",       "</think>") → "</th"
 */
function trailingPartialTag(text: string, tag: string): string {
  // Walk backwards from the end of text, checking if any suffix is a tag prefix
  const maxCheck = Math.min(text.length, tag.length - 1);
  for (let len = maxCheck; len >= 1; len--) {
    const suffix = text.slice(text.length - len);
    if (tag.startsWith(suffix)) return suffix;
  }
  return '';
}

export interface RouterResult {
  think: string;
  output: string;
}

export class ThinkingTokenRouter {
  private inThink: boolean;       // cross-chunk state for <think> tag parsing
  private thinkBuf = '';           // accumulated thinking text
  private outputBuf = '';          // accumulated output text
  // Holds a partial open/close tag that was split across SSE chunk boundaries.
  // e.g. model streams "<th" then "ink" then ">\n" — we buffer until complete.
  private partialTagBuf = '';

  /**
   * @param strategy  — thinking strategy for the model/provider
   * @param mode      — 'think' (capture thinking), 'no_think' (discard thinking), 'none' (no parsing)
   * @param onThinkToken — called per thinking token for real-time panel updates
   * @param startInThink — set true for models with thinking_forced_open (e.g. Nemotron)
   *                       where the chat template prepends <think> to the generation.
   *                       The <think> tag is NOT in the streamed output — generation starts
   *                       already inside the think block. Without this flag, the thinking
   *                       content before </think> is misclassified as output.
   */
  constructor(
    private readonly strategy: ThinkingStrategy,
    private readonly mode: 'think' | 'no_think' | 'none',
    private readonly onThinkToken?: (token: string) => void,
    startInThink = false,
  ) {
    this.inThink = startInThink;
  }

  /**
   * Feed a single SSE delta object. Returns any new think/output text.
   */
  feed(delta: Record<string, unknown>): RouterResult {
    if (this.mode === 'none') {
      // No thinking processing — everything is output
      const raw = delta.content as string | null | undefined;
      return { think: '', output: raw ?? '' };
    }

    if (this.strategy.thinkingPath === 'field') {
      return this.feedField(delta);
    }
    return this.feedTag(delta);
  }

  /**
   * Field-path: reasoning_content is the thinking channel, content is the output channel.
   * Safety: content may contain leaked <think> tags when enable_thinking:false is ignored.
   */
  private feedField(delta: Record<string, unknown>): RouterResult {
    let thinkOut = '';
    let outputOut = '';

    // ── Thinking channel: reasoning_content / reasoning / thinking ──
    let thinkToken = (
      delta.reasoning_content ?? delta.reasoning ?? delta.thinking
    ) as string | null | undefined;

    const rawContent = delta.content as string | null | undefined;

    if (thinkToken) {
      // Strip any wrapper <think>/<\/think> tags that some providers inject into the field
      thinkToken = thinkToken.replace(/<\/?think>/g, '');
      if (thinkToken) {
        if (this.mode === 'think') {
          // Think mode: reasoning tokens go to thinking channel
          this.thinkBuf += thinkToken;
          thinkOut += thinkToken;
          this.onThinkToken?.(thinkToken);
        }
        // no_think mode: reasoning tokens are silently discarded here.
        // Exception: if content is absent and reasoning has the actual answer
        // (some builds route output to reasoning_content when reasoning_format:none).
        // This is handled below in the content-absent fallback.
      }
    }

    if (rawContent) {
      // Content field present — check for leaked think tags (angle-bracket or bracket form)
      const hasLeakedTags =
        rawContent.includes('<think>') || rawContent.includes('</think>') ||
        /\[THINK\]/i.test(rawContent) || /\[\/THINK\]/i.test(rawContent);
      if (hasLeakedTags) {
        // Normalize bracket form before stripping so stripInlineThinkTags only needs one format
        const normalized = rawContent
          .replace(/\[THINK\]/gi, '<think>')
          .replace(/\[\/THINK\]/gi, '</think>');
        outputOut += this.stripInlineThinkTags(normalized);
      } else if (!this.inThink) {
        outputOut += rawContent;
      }
      // If inThink is true (from a previous chunk's <think> tag), content is
      // part of the thinking trace leaking into content — discard or route to think.
    } else if (!thinkToken && this.mode === 'no_think') {
      // no_think fallback: some llama.cpp builds with reasoning_format:none route
      // the actual ANSWER to reasoning_content instead of content.
      // If we got a reasoning token but no content, use reasoning as output.
      // This only applies when there was a reasoning token AND no content.
    } else if (thinkToken && !rawContent && this.mode === 'no_think') {
      // The answer is in reasoning_content because reasoning_format:none is set
      // but the model still uses the reasoning field. Re-extract the stripped token.
      const stripped = (
        delta.reasoning_content ?? delta.reasoning ?? delta.thinking
      ) as string | null | undefined;
      if (stripped) {
        const clean = stripped.replace(/<\/?think>/g, '');
        if (clean) outputOut += clean;
      }
    }

    if (outputOut) this.outputBuf += outputOut;
    return { think: thinkOut, output: outputOut };
  }

  /**
   * Tag-path: everything arrives in delta.content. <think>...</think> tags
   * separate thinking from output. Cross-chunk state tracked via this.inThink.
   *
   * Also handles Ministral's [THINK]...[/THINK] bracket format — normalized to
   * angle-bracket form before parsing so all downstream logic stays unchanged.
   *
   * Partial-tag buffering: some models (e.g. Phi-4) split tags across SSE chunk
   * boundaries: "<th" + "ink" + ">\n". partialTagBuf holds incomplete tag prefixes
   * until the full tag can be assembled and matched.
   */
  private feedTag(delta: Record<string, unknown>): RouterResult {
    let thinkOut = '';
    let outputOut = '';

    const rawContent = delta.content as string | null | undefined;
    if (!rawContent) return { think: '', output: '' };

    // Normalize Ministral's bracket tags to standard angle-bracket form.
    // [THINK] and [/THINK] (case-insensitive) are aliases for <think> and </think>.
    // Done once per chunk before the parse loop so every code path handles them.
    // Then prepend any partial tag carried over from the previous chunk.
    let remaining = this.partialTagBuf + rawContent
      .replace(/\[THINK\]/gi, '<think>')
      .replace(/\[\/THINK\]/gi, '</think>');
    this.partialTagBuf = '';

    while (remaining.length > 0) {
      if (this.inThink) {
        const closeIdx = remaining.indexOf('</think>');
        if (closeIdx === -1) {
          // Check if the tail could be a partial </think> tag split across chunks.
          // If so, hold the partial suffix — don't emit or discard it yet.
          const partial = trailingPartialTag(remaining, '</think>');
          const safe = partial ? remaining.slice(0, remaining.length - partial.length) : remaining;
          if (safe && this.mode === 'think') {
            this.thinkBuf += safe;
            thinkOut += safe;
            this.onThinkToken?.(safe);
          }
          if (partial) this.partialTagBuf = partial;
          remaining = '';
        } else {
          // Found </think> — extract thinking portion, continue with rest
          const thinkChunk = remaining.slice(0, closeIdx);
          if (thinkChunk && this.mode === 'think') {
            this.thinkBuf += thinkChunk;
            thinkOut += thinkChunk;
            this.onThinkToken?.(thinkChunk);
          }
          this.inThink = false;
          remaining = remaining.slice(closeIdx + '</think>'.length);
        }
      } else {
        const openIdx = remaining.indexOf('<think>');
        if (openIdx === -1) {
          // No complete <think> tag — but the tail might be a partial open tag.
          const partial = trailingPartialTag(remaining, '<think>');
          const safe = partial ? remaining.slice(0, remaining.length - partial.length) : remaining;
          if (safe) outputOut += safe;
          if (partial) this.partialTagBuf = partial;
          remaining = '';
        } else {
          // Found <think> — emit text before it as output, enter think mode
          const before = remaining.slice(0, openIdx);
          if (before) outputOut += before;
          this.inThink = true;
          remaining = remaining.slice(openIdx + '<think>'.length);
        }
      }
    }

    this.outputBuf += outputOut;
    return { think: thinkOut, output: outputOut };
  }

  /**
   * Strips <think>...</think> from a content string, routing think content
   * to the thinking channel and returning only the output portion.
   * Used as a safety net for field-path models where leaked tags appear in content.
   */
  private stripInlineThinkTags(raw: string): string {
    let output = '';
    let remaining = raw;

    while (remaining.length > 0) {
      if (this.inThink) {
        const closeIdx = remaining.indexOf('</think>');
        if (closeIdx === -1) {
          // Entire remainder is leaked thinking — route to think channel
          if (this.mode === 'think') {
            this.thinkBuf += remaining;
            this.onThinkToken?.(remaining);
          }
          remaining = '';
        } else {
          const thinkChunk = remaining.slice(0, closeIdx);
          if (thinkChunk && this.mode === 'think') {
            this.thinkBuf += thinkChunk;
            this.onThinkToken?.(thinkChunk);
          }
          this.inThink = false;
          remaining = remaining.slice(closeIdx + '</think>'.length);
        }
      } else {
        const openIdx = remaining.indexOf('<think>');
        if (openIdx === -1) {
          output += remaining;
          remaining = '';
        } else {
          output += remaining.slice(0, openIdx);
          this.inThink = true;
          remaining = remaining.slice(openIdx + '<think>'.length);
        }
      }
    }

    return output;
  }

  /**
   * Call after the stream ends. Returns any remaining buffered content.
   * If still inside a <think> block (model produced unclosed tag), discards it.
   * If partialTagBuf holds an incomplete tag that never completed, emits it as output.
   */
  flush(): RouterResult {
    const result: RouterResult = { think: '', output: '' };
    // If we were holding a partial tag that never completed, it's safe literal text
    if (this.partialTagBuf && !this.inThink) {
      result.output = this.partialTagBuf;
      this.outputBuf += this.partialTagBuf;
    }
    this.partialTagBuf = '';
    // If still inThink at end of stream, the model left an unclosed <think> block.
    // Discard any partial thinking — it's malformed.
    this.inThink = false;
    return result;
  }

  /**
   * Nuclear final strip: removes any surviving <think>...</think> or [THINK]...[/THINK]
   * blocks from the accumulated output buffer. Call on the final output string before
   * returning. Catches any multi-token spanning tags the streaming parser missed.
   */
  static finalStrip(text: string): string {
    return text
      .trim()
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/\[THINK\][\s\S]*?\[\/THINK\]/gi, '')
      .trim();
  }

  /** Returns accumulated thinking text */
  getThinkBuf(): string { return this.thinkBuf; }

  /** Returns accumulated output text */
  getOutputBuf(): string { return this.outputBuf; }

  /** Reset state for reuse */
  reset(startInThink = false): void {
    this.inThink = startInThink;
    this.thinkBuf = '';
    this.outputBuf = '';
    this.partialTagBuf = '';
  }
}
