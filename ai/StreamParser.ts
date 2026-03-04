import { EventEmitter } from 'events';

export type ParserState = 'THINKING' | 'OUTPUTTING';

export interface StreamParserEvents {
  thinkToken: (token: string) => void;
  outputToken: (token: string) => void;
  questionDetected: (questionText: string) => void;
  complete: (result: {
    thinkingContent: string;
    outputContent: string;
    hadQuestion: boolean;
  }) => void;
  error: (err: Error) => void;
}

/**
 * Parses DeepSeek-R1 streaming output in real time.
 *
 * DeepSeek-R1 uses <think>...</think> tags to wrap chain-of-thought reasoning.
 * This parser maintains a state machine to route tokens to the right consumers:
 * - THINKING state: tokens inside <think>...</think>
 * - OUTPUTTING state: tokens after </think>
 *
 * It also detects "QUESTION:" markers in the thinking stream for intervention.
 */
export class StreamParser extends EventEmitter {
  private state: ParserState = 'OUTPUTTING';
  private thinkingBuffer = '';
  private outputBuffer = '';
  private questionBuffer = '';
  private inQuestionCapture = false;
  private tokenBuffer = ''; // partial tag accumulation
  private thinkTokenCount = 0;

  // DeepSeek uses these markers
  private static THINK_OPEN = '<think>';
  private static THINK_CLOSE = '</think>';
  private static QUESTION_MARKER = 'QUESTION:';

  reset(): void {
    this.state = 'OUTPUTTING';
    this.thinkingBuffer = '';
    this.outputBuffer = '';
    this.questionBuffer = '';
    this.inQuestionCapture = false;
    this.tokenBuffer = '';
    this.thinkTokenCount = 0;
  }

  /** Feed a raw token chunk from the stream */
  feed(chunk: string): void {
    this.tokenBuffer += chunk;
    this.processBuffer();
  }
  /** Directly accumulate a thinking token (for APIs with dedicated reasoning fields) */
  feedThinking(token: string): void {
    this.thinkingBuffer += token;
    this.thinkTokenCount += Math.ceil(token.length / 4);
    this.processThinkToken(token); // runs QUESTION: detection
  }

  /** Directly accumulate an output token (for APIs with dedicated content fields) */
  feedOutput(token: string): void {
    this.outputBuffer += token;
    this.emit('outputToken', token);
  }

  private processBuffer(): void {
    while (this.tokenBuffer.length > 0) {
      if (this.state === 'OUTPUTTING') {
        const openIdx = this.tokenBuffer.indexOf(StreamParser.THINK_OPEN);
        if (openIdx === -1) {
          // Check for partial tag at end
          const partial = this.hasPartialTag(this.tokenBuffer, StreamParser.THINK_OPEN);
          if (partial > 0) {
            const safe = this.tokenBuffer.slice(0, this.tokenBuffer.length - partial);
            if (safe) {
              this.outputBuffer += safe;
              this.emit('outputToken', safe);
            }
            break; // wait for more chunks
          }
          // No tag, emit all as output
          this.outputBuffer += this.tokenBuffer;
          this.emit('outputToken', this.tokenBuffer);
          this.tokenBuffer = '';
        } else {
          // Emit everything before the tag
          if (openIdx > 0) {
            const before = this.tokenBuffer.slice(0, openIdx);
            this.outputBuffer += before;
            this.emit('outputToken', before);
          }
          this.state = 'THINKING';
          this.tokenBuffer = this.tokenBuffer.slice(openIdx + StreamParser.THINK_OPEN.length);
        }
      } else {
        // THINKING state
        const closeIdx = this.tokenBuffer.indexOf(StreamParser.THINK_CLOSE);
        if (closeIdx === -1) {
          const partial = this.hasPartialTag(this.tokenBuffer, StreamParser.THINK_CLOSE);
          if (partial > 0) {
            const safe = this.tokenBuffer.slice(0, this.tokenBuffer.length - partial);
            if (safe) {
              this.processThinkToken(safe);
            }
            break;
          }
          this.processThinkToken(this.tokenBuffer);
          this.tokenBuffer = '';
        } else {
          const thinkContent = this.tokenBuffer.slice(0, closeIdx);
          if (thinkContent) {
            this.processThinkToken(thinkContent);
          }
          this.state = 'OUTPUTTING';
          this.tokenBuffer = this.tokenBuffer.slice(closeIdx + StreamParser.THINK_CLOSE.length);
        }
      }
    }
  }

  private processThinkToken(token: string): void {
    this.thinkingBuffer += token;
    this.thinkTokenCount += Math.ceil(token.length / 4);
    this.emit('thinkToken', token);

    // Scan for QUESTION: marker
    if (!this.inQuestionCapture) {
      const combined = this.thinkingBuffer;
      const qIdx = combined.lastIndexOf(StreamParser.QUESTION_MARKER);
      if (qIdx !== -1) {
        const newlineIdx = combined.indexOf('\n', qIdx);
        if (newlineIdx !== -1) {
          const question = combined.slice(
            qIdx + StreamParser.QUESTION_MARKER.length,
            newlineIdx
          ).trim();
          if (question.length > 0) {
            this.inQuestionCapture = true;
            this.emit('questionDetected', question);
          }
        }
      }
    }
  }

  /** Returns how many chars at the end of str could be a partial prefix of tag */
  private hasPartialTag(str: string, tag: string): number {
    for (let len = Math.min(str.length, tag.length - 1); len > 0; len--) {
      if (str.endsWith(tag.slice(0, len))) return len;
    }
    return 0;
  }

  complete(): void {
    // Flush anything remaining
    if (this.tokenBuffer) {
      if (this.state === 'THINKING') {
        this.processThinkToken(this.tokenBuffer);
      } else {
        this.outputBuffer += this.tokenBuffer;
        this.emit('outputToken', this.tokenBuffer);
      }
      this.tokenBuffer = '';
    }

    this.emit('complete', {
      thinkingContent: this.thinkingBuffer,
      outputContent: this.outputBuffer,
      hadQuestion: this.inQuestionCapture,
    });
  }

  getThinkTokenCount(): number {
    return this.thinkTokenCount;
  }

  getBuffers(): { thinking: string; output: string } {
    return {
      thinking: this.thinkingBuffer,
      output: this.outputBuffer,
    };
  }
}
