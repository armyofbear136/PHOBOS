import { floodSelect }                from '../editor/SelectionMask';
import { SelectionCommand }           from '../editor/SelectionCommand';
import { cssToPhysical }              from '../editor/PhobosDocument';
import type { PhobosTool, ToolEvent } from './ToolController';
import type { SelectionOp }           from '../types';
import type { SelectionChangedCallback } from './SelectTools';

// =============================================================================
// MagicWandTool
//
// Flood-selects a contiguous region of similar colour. Delegates entirely to
// the existing floodSelect() BFS in SelectionMask.ts, which already handles
// all four SelectionOps and uses doc.fillQueue (no allocation).
//
// Marching ants outline: after BFS we compute the bounding box of newly
// selected pixels and use that rectangle as the outline. A proper pixel-exact
// boundary trace is a Phase 2 improvement; the bbox is correct and cheap.
//
// Contiguous mode only in v1. Global (non-contiguous) select-by-colour is
// Phase 2.
// =============================================================================

export class MagicWandTool implements PhobosTool {
  readonly id     = 'magic-wand' as const;
  readonly cursor = 'crosshair';

  op:        SelectionOp = 'replace';
  tolerance: number      = 32;   // 0–255, matches Paint.NET default

  onSelectionChanged: SelectionChangedCallback = () => {};

  onPointerDown(e: ToolEvent): void {
    const dpr    = e.doc.dpr;
    const px     = cssToPhysical(e.x, dpr);
    const py     = cssToPhysical(e.y, dpr);
    const physW  = e.doc.physicalWidth;
    const physH  = e.doc.physicalHeight;

    if (px < 0 || px >= physW || py < 0 || py >= physH) return;

    // Read source pixels from the active layer.
    const imgData = e.doc.activeLayer.getImageData();
    const pixels  = imgData.data;

    const mask    = e.doc.selection;
    const queue   = e.doc.fillQueue;
    const op      = this.op;
    const tol     = this.tolerance;

    const cmd = new SelectionCommand('Magic Wand', mask, () => {
      floodSelect(pixels, mask, queue, px, py, tol, op);
    });

    e.emit(cmd);

    // Generate outline from bounding box of the selected region.
    const bbox = mask.bounds();
    if (bbox) {
      const cx = bbox.x / dpr;
      const cy = bbox.y / dpr;
      const cw = bbox.w / dpr;
      const ch = bbox.h / dpr;
      this.onSelectionChanged([cx, cy, cx + cw, cy, cx + cw, cy + ch, cx, cy + ch, cx, cy]);
    } else {
      this.onSelectionChanged(null);
    }
  }

  onPointerMove(_e: ToolEvent): void { /* no-op — single click tool */ }
  onPointerUp(_e: ToolEvent):   void { /* no-op */ }

  onCancel(): void {
    this.onSelectionChanged(null);
  }
}
