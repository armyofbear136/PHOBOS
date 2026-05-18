import type { PhobosCommand }  from '../types';
import type { SelectionMask }  from './SelectionMask';

// =============================================================================
// SelectionCommand
//
// Wraps any operation that modifies the SelectionMask. Snapshots the full
// mask before execute() and restores it on undo().
//
// The mask is a flat Uint8Array (physW × physH bytes). Snapshot is a copy
// of the same size. One allocation per command, held for the ring buffer
// lifetime.
// =============================================================================

export class SelectionCommand implements PhobosCommand {
  readonly name: string;

  private readonly mask:        SelectionMask;
  private readonly applyFn:     () => void;
  private preSnapshot:          Uint8Array | null;
  private preEmpty:             boolean;

  constructor(name: string, mask: SelectionMask, applyFn: () => void) {
    this.name        = name;
    this.mask        = mask;
    this.applyFn     = applyFn;
    this.preSnapshot = null;
    this.preEmpty    = true;
  }

  execute(): void {
    // Snapshot current mask state before modifying.
    this.preSnapshot = this.mask.data.slice();
    this.preEmpty    = this.mask.empty;
    this.applyFn();
  }

  undo(): void {
    if (!this.preSnapshot) return;
    this.mask.data.set(this.preSnapshot);
    this.mask.empty = this.preEmpty;
  }
}
