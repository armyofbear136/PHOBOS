import type { PhobosCommand } from '../types';

// =============================================================================
// CommandStack
//
// Fixed-capacity ring buffer for undo/redo history.
//
// Uses unbounded absolute integers for head, tail, and cursor so that
// comparisons are always simple arithmetic (no modulo ambiguity). Array
// indexing uses `value % limit`.
//
//   tail   — absolute index of the oldest command (inclusive lower bound).
//   head   — absolute index of the next write slot (exclusive upper bound).
//   cursor — absolute index of the current undo position.
//
// Invariants:
//   tail <= cursor <= head
//   head - tail <= limit     (never more than `limit` commands stored)
//
// Eviction happens BEFORE writing the new command, so the new command always
// lands in the slot that was just freed (or an already-empty slot).
// =============================================================================

export class CommandStack {
  private readonly ring:  (PhobosCommand | null)[];
  private readonly limit: number;
  private head:           number;  // next write position (absolute)
  private tail:           number;  // oldest occupied position (absolute)
  private cursor:         number;  // current undo position (absolute)

  constructor(limit = 50) {
    if (limit < 1) throw new RangeError('CommandStack limit must be at least 1');
    this.limit  = limit;
    this.ring   = new Array<PhobosCommand | null>(limit).fill(null);
    this.head   = 0;
    this.tail   = 0;
    this.cursor = 0;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Execute a command and record it. Any commands ahead of the cursor
   * (the redo branch) are discarded — branching history is not supported.
   * If the buffer is full the oldest command is evicted before writing.
   */
  push(cmd: PhobosCommand): void {
    // Discard any redoable commands (slots from cursor up to head).
    for (let i = this.cursor; i < this.head; i++) {
      this.ring[i % this.limit] = null;
    }
    this.head = this.cursor;

    // Evict oldest before writing if we are at capacity.
    if (this.head - this.tail >= this.limit) {
      this.ring[this.tail % this.limit] = null;
      this.tail++;
    }

    cmd.execute();

    this.ring[this.head % this.limit] = cmd;
    this.head++;
    this.cursor = this.head;
  }

  undo(): void {
    if (!this.canUndo) return;
    this.cursor--;
    (this.ring[this.cursor % this.limit] as PhobosCommand).undo();
  }

  redo(): void {
    if (!this.canRedo) return;
    (this.ring[this.cursor % this.limit] as PhobosCommand).execute();
    this.cursor++;
  }

  get canUndo(): boolean { return this.cursor > this.tail; }
  get canRedo():  boolean { return this.cursor < this.head; }

  /** Number of commands currently undoable (cursor distance from tail). */
  get depth(): number { return this.cursor - this.tail; }

  /**
   * Discard all history without calling undo on anything.
   * Used when opening a new document.
   */
  clear(): void {
    this.ring.fill(null);
    this.head   = 0;
    this.tail   = 0;
    this.cursor = 0;
  }
}
