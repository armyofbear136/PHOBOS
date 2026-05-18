import { SelectionCommand }           from '../editor/SelectionCommand';
import { cssToPhysical }              from '../editor/PhobosDocument';
import type { PhobosTool, ToolEvent } from './ToolController';
import type { SelectionOp }           from '../types';
import type { SelectionChangedCallback } from './SelectTools';

// =============================================================================
// LassoSelectTool
//
// Freeform polygon (lasso) selection.
//
// During drag: collect pointer positions into a polyline.
// On pointerUp: close the path and rasterise the polygon into the selection
//   mask using scanline fill (even-odd rule). The rasterisation is correct for
//   any simple polygon including concave and self-intersecting shapes (the
//   even-odd rule handles self-intersection naturally by toggling inside/outside
//   at each crossing).
//
// The raw polyline is passed to onSelectionChanged as the marching ants
// outline — it already represents the exact selection boundary in CSS coords.
//
// Minimum point count for a valid selection: 3 distinct points.
// =============================================================================

export class LassoSelectTool implements PhobosTool {
  readonly id     = 'lasso-select' as const;
  readonly cursor = 'crosshair';

  op: SelectionOp = 'replace';
  onSelectionChanged: SelectionChangedCallback = () => {};

  /** Minimum pixel distance between recorded points (in CSS px). Reduces noise. */
  private static readonly POINT_SPACING = 2;

  private _active:  boolean;
  private _pts:     { x: number; y: number }[];  // CSS pixel coords
  private _lastX:   number;
  private _lastY:   number;

  constructor() {
    this._active = false;
    this._pts    = [];
    this._lastX  = 0;
    this._lastY  = 0;
  }

  // ---------------------------------------------------------------------------

  onPointerDown(e: ToolEvent): void {
    this._active = true;
    this._pts    = [{ x: e.x, y: e.y }];
    this._lastX  = e.x;
    this._lastY  = e.y;
  }

  onPointerMove(e: ToolEvent): void {
    if (!this._active) return;

    const dx   = e.x - this._lastX;
    const dy   = e.y - this._lastY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist >= LassoSelectTool.POINT_SPACING) {
      this._pts.push({ x: e.x, y: e.y });
      this._lastX = e.x;
      this._lastY = e.y;

      // Live outline: current open polyline + closing segment back to start.
      this.onSelectionChanged(this._buildPolyline(true));
    }
  }

  onPointerUp(e: ToolEvent): void {
    if (!this._active) return;
    this._active = false;

    // Add final point.
    this._pts.push({ x: e.x, y: e.y });

    if (this._pts.length < 3) {
      // Degenerate — deselect.
      const mask = e.doc.selection;
      const cmd  = new SelectionCommand('Deselect', mask, () => { mask.reset(); });
      e.emit(cmd);
      this.onSelectionChanged(null);
      return;
    }

    const dpr   = e.doc.dpr;
    const physW = e.doc.physicalWidth;
    const physH = e.doc.physicalHeight;
    const mask  = e.doc.selection;
    const op    = this.op;

    // Convert CSS polygon to physical pixel polygon once.
    const physPts = this._pts.map(p => ({
      x: cssToPhysical(p.x, dpr),
      y: cssToPhysical(p.y, dpr),
    }));

    const cmd = new SelectionCommand('Lasso Select', mask, () => {
      rasterisePolygon(physPts, mask, physW, physH, op);
    });

    e.emit(cmd);

    // Final closed outline in CSS coords.
    this.onSelectionChanged(this._buildPolyline(false));
  }

  onCancel(): void {
    this._active = false;
    this._pts    = [];
    this.onSelectionChanged(null);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /** Build a flat number[] for Konva.Line from current points, optionally open. */
  private _buildPolyline(open: boolean): number[] {
    const flat: number[] = [];
    for (const p of this._pts) {
      flat.push(p.x, p.y);
    }
    if (!open && this._pts.length > 0) {
      // Close: repeat first point.
      flat.push(this._pts[0].x, this._pts[0].y);
    }
    return flat;
  }
}

// =============================================================================
// rasterisePolygon
//
// Scanline fill of a polygon into a SelectionMask using the even-odd rule.
//
// Algorithm:
//   For each scanline y in [minY, maxY]:
//     Find all x-intersections of polygon edges with this scanline.
//     Sort intersections left-to-right.
//     Toggle inside/outside at each intersection and fill spans.
//
// All coordinates are in physical pixels. Operates directly on mask.data —
// no allocation beyond the per-scanline intersection array (maximum length =
// number of polygon edges, allocated once and reused via slice).
// =============================================================================

function rasterisePolygon(
  pts:   { x: number; y: number }[],
  mask:  import('../editor/SelectionMask').SelectionMask,
  physW: number,
  physH: number,
  op:    SelectionOp,
): void {
  if (pts.length < 3) return;

  if (op === 'replace') {
    mask.data.fill(0);
    mask.empty = false;
  }

  // Find vertical extent.
  let minY = pts[0].y;
  let maxY = pts[0].y;
  for (const p of pts) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(physH - 1, Math.ceil(maxY));
  const n   = pts.length;

  // Pre-allocate intersection buffer (maximum n intersections per scanline).
  const xs = new Float32Array(n);

  for (let y = y0; y <= y1; y++) {
    const yf  = y + 0.5;  // sample at pixel centre
    let count = 0;

    // Collect x-intersections for this scanline.
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];

      const ay = a.y;
      const by = b.y;

      // Skip horizontal edges and edges that don't cross this scanline.
      if (ay === by) continue;
      if (yf < Math.min(ay, by) || yf >= Math.max(ay, by)) continue;

      // x at this y via linear interpolation.
      const t      = (yf - ay) / (by - ay);
      xs[count++]  = a.x + t * (b.x - a.x);
    }

    if (count < 2) continue;

    // Sort intersections (insertion sort — count is small).
    for (let i = 1; i < count; i++) {
      const v = xs[i];
      let j   = i - 1;
      while (j >= 0 && xs[j] > v) { xs[j + 1] = xs[j]; j--; }
      xs[j + 1] = v;
    }

    // Fill between pairs of intersections (even-odd rule).
    for (let i = 0; i + 1 < count; i += 2) {
      const x0 = Math.max(0,       Math.ceil(xs[i]));
      const x1 = Math.min(physW - 1, Math.floor(xs[i + 1]));

      for (let x = x0; x <= x1; x++) {
        const idx = y * physW + x;
        applyOp(mask, idx, op);
      }
    }
  }

  mask.empty = false;
}

// ---------------------------------------------------------------------------
// Inline op application — same logic as SelectTools.ts
// ---------------------------------------------------------------------------

function applyOp(
  mask: import('../editor/SelectionMask').SelectionMask,
  idx:  number,
  op:   SelectionOp,
): void {
  switch (op) {
    case 'replace':
    case 'add':
      mask.data[idx] = 255;
      break;
    case 'subtract':
      mask.data[idx] = 0;
      break;
    case 'intersect':
      mask.data[idx] = mask.data[idx] > 0 ? 255 : 0;
      break;
  }
}
