import type { PhobosCommand, BBox } from '../types';
import type { PhobosLayer }         from './PhobosLayer';

// =============================================================================
// RasterCommand
//
// Command wrapper for any operation that modifies pixels in a single layer.
// Snapshots the bounding box of affected pixels BEFORE execute(), stores the
// Uint8ClampedArray, and restores it on undo().
//
// Usage:
//   const cmd = new RasterCommand('Paint Stroke', layer, bbox, () => {
//     // write pixels into layer.ctx here — called by execute()
//   });
//   emitter(cmd);  // push() calls execute() which snapshots then draws
//
// For full-layer operations (adjustments, filters), pass bbox = undefined.
// The snapshot covers the entire layer canvas.
//
// The snapshot buffer is allocated once in execute() and held for the life
// of the command in the history ring. The ring's eviction mechanism is the
// only GC pressure from undo history.
// =============================================================================

export class RasterCommand implements PhobosCommand {
  readonly name: string;

  private readonly layer:   PhobosLayer;
  private readonly bbox:    BBox | undefined;
  private readonly drawFn:  () => void;
  private snapshot:         Uint8ClampedArray | null;

  constructor(
    name:   string,
    layer:  PhobosLayer,
    bbox:   BBox | undefined,
    drawFn: () => void,
  ) {
    this.name     = name;
    this.layer    = layer;
    this.bbox     = bbox;
    this.drawFn   = drawFn;
    this.snapshot = null;
  }

  execute(): void {
    // Snapshot current pixels in the affected region before drawing.
    this.snapshot = this.layer.snapshot(this.bbox);
    this.drawFn();
    this.layer.markDirty();
  }

  undo(): void {
    if (!this.snapshot) return;
    this.layer.restore(this.snapshot, this.bbox);
    this.layer.markDirty();
  }
}
