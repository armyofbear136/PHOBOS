import { MessageEventStore } from './MessageEventStore.js';

const FLUSH_TOKENS = 40;   // flush after this many tokens accumulated
const FLUSH_MS    = 1500;  // flush at least every N ms

/**
 * Buffers streaming think/output tokens and periodically flushes them
 * to the message_events table as think_chunk / output_chunk records.
 *
 * This ensures that even a mid-stream browser refresh can recover partial
 * thinking and output — the DB is always within ~40 tokens of the live state.
 *
 * Usage:
 *   const p = new StreamPersister(eventStore, threadId, messageId);
 *   p.addThink(token, 'coordinator' | 'engine');
 *   p.addOutput(token);
 *   await p.finalize();   // flush remainder, mark complete
 */
export class StreamPersister {
  private thinkBuf  = '';
  private outputBuf = '';
  private thinkSource: 'coordinator' | 'engine' = 'engine';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(
    private store: MessageEventStore,
    private threadId: string,
    private messageId: string
  ) {
    this.scheduleFlush();
  }

  addThink(token: string, source: 'coordinator' | 'engine') {
    this.thinkSource = source; // last-seen source wins for the chunk
    this.thinkBuf += token;
    if (this.thinkBuf.length >= FLUSH_TOKENS) this.flush();
  }

  addOutput(token: string) {
    this.outputBuf += token;
    if (this.outputBuf.length >= FLUSH_TOKENS) this.flush();
  }

  private scheduleFlush() {
    this.timer = setTimeout(() => {
      this.flush().catch(() => {});
      this.scheduleFlush();
    }, FLUSH_MS);
  }

  private async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const think  = this.thinkBuf;
      const output = this.outputBuf;
      const src    = this.thinkSource;
      this.thinkBuf  = '';
      this.outputBuf = '';

      if (think) {
        await this.store.insert(this.threadId, 'think_chunk', {
          type: 'think_chunk', content: think, source: src,
        }, this.messageId);
      }
      if (output) {
        await this.store.insert(this.threadId, 'output_chunk', {
          type: 'output_chunk', content: output,
        }, this.messageId);
      }
    } catch {
      // non-fatal — live stream is unaffected
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Flush remaining buffered content and cancel the periodic timer.
   * Call this after the stream ends (before writing thinking_complete).
   */
  async finalize() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.flush();
  }

  /**
   * Delete all think_chunk / output_chunk events for this message.
   * Call this after writing the canonical thinking_complete/output records
   * so we don't keep redundant data.
   */
  async cleanup() {
    await this.store.deleteChunksForMessage(this.messageId);
  }
}
