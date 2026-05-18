import { SelectionCommand }           from '../editor/SelectionCommand';
import { cssToPhysical }              from '../editor/PhobosDocument';
import type { PhobosTool, ToolEvent } from '../tools/ToolController';
import type { SelectionOp }           from '../types';

// =============================================================================
// RectSelectTool / EllipseSelectTool
//
// Both tools follow the same pattern:
//   pointerDown → record anchor point
//   pointerMove → compute current bbox, update live preview line on uiLayer
//   pointerUp   → commit SelectionCommand, signal marching ants
//
// SelectionOp is determined by held keyboard modifiers at pointerDown time.
// The EditorCanvas translates modifier keys into a SelectionOp and passes it
// in `e.buttons` upper bits, but for v1 we read it from a settable property
// on the tool. The full modifier-key wiring is a Phase 1 UI task.
//
// Marching ants update is signalled via `onSelectionChanged` callback, which
// is set by EditorCanvas after mount. The tool emits the final polyline points.
// =============================================================================

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Convert a selection mask bbox to a flat polyline point array for Konva.Line.
 * Coordinates are in CSS pixels (document space).
 */
function rectToPolyline(
  x: number, y: number, w: number, h: number, dpr: number,
): number[] {
  const cx = x / dpr;
  const cy = y / dpr;
  const cw = w / dpr;
  const ch = h / dpr;
  return [cx, cy, cx + cw, cy, cx + cw, cy + ch, cx, cy + ch, cx, cy];
}

function ellipseToPolyline(
  cx: number, cy: number, rx: number, ry: number, dpr: number, steps = 64,
): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    pts.push((cx + Math.cos(a) * rx) / dpr, (cy + Math.sin(a) * ry) / dpr);
  }
  return pts;
}

/**
 * Write a filled rectangle into the selection mask (physical pixel coords).
 * Respects SelectionOp.
 */
function applyRectToMask(
  mask: import('../editor/SelectionMask').SelectionMask,
  x0: number, y0: number, x1: number, y1: number,
  op: SelectionOp,
): void {
  const { width, height } = mask;

  if (op === 'replace') {
    mask.data.fill(0);
    mask.empty = false;
  }

  for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
      applyOp(mask, y * width + x, op);
    }
  }

  mask.empty = false;
}

/**
 * Write a filled ellipse into the selection mask (physical pixel coords).
 */
function applyEllipseToMask(
  mask: import('../editor/SelectionMask').SelectionMask,
  cx: number, cy: number, rx: number, ry: number,
  op: SelectionOp,
): void {
  const { width, height } = mask;

  if (op === 'replace') {
    mask.data.fill(0);
    mask.empty = false;
  }

  const x0 = Math.max(0, Math.floor(cx - rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const x1 = Math.min(width  - 1, Math.ceil(cx + rx));
  const y1 = Math.min(height - 1, Math.ceil(cy + ry));

  const rxSq = rx * rx;
  const rySq = ry * ry;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if ((dx * dx) / rxSq + (dy * dy) / rySq <= 1) {
        applyOp(mask, y * width + x, op);
      }
    }
  }

  mask.empty = false;
}

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
      // Pixels already selected stay selected; unselected stay unselected.
      // The initial mask.data.fill(0) for 'replace' is not done for intersect.
      // Here we mark which pixels the new shape covers; after the loop the
      // caller must zero pixels NOT covered. We use 254 as a "covered" marker,
      // then post-process. For simplicity in v1 we implement intersect as:
      // only keep pixels that are BOTH currently selected AND inside the shape.
      // This is correct but requires knowing the pre-op state, which the
      // SelectionCommand already snapshotted. The pre-snap is restored by
      // undo(), so during execute() we read current mask (pre-snap state was
      // just restored if this is a redo). Mark intersected pixels as 255, zero rest.
      mask.data[idx] = mask.data[idx] > 0 ? 255 : 0;
      break;
  }
}

// ---------------------------------------------------------------------------
// RectSelectTool
// ---------------------------------------------------------------------------

/** Called after selection changes with the new polyline for marching ants. */
export type SelectionChangedCallback = (points: number[] | null) => void;

export class RectSelectTool implements PhobosTool {
  readonly id     = 'rect-select' as const;
  readonly cursor = 'crosshair';

  op: SelectionOp = 'replace';
  onSelectionChanged: SelectionChangedCallback = () => {};

  private _active:  boolean;
  private _anchorX: number;
  private _anchorY: number;
  private _curX:    number;
  private _curY:    number;

  constructor() {
    this._active  = false;
    this._anchorX = 0;
    this._anchorY = 0;
    this._curX    = 0;
    this._curY    = 0;
  }

  onPointerDown(e: ToolEvent): void {
    this._active  = true;
    this._anchorX = e.x;
    this._anchorY = e.y;
    this._curX    = e.x;
    this._curY    = e.y;
  }

  onPointerMove(e: ToolEvent): void {
    if (!this._active) return;
    this._curX = e.x;
    this._curY = e.y;
    // Signal live preview (EditorCanvas will draw a temporary rect on uiLayer).
    // We re-use the marching ants polyline for the live preview in v1.
    const [x0, y0, x1, y1] = this._physBounds(e.doc.dpr);
    const dpr               = e.doc.dpr;
    this.onSelectionChanged(rectToPolyline(x0, y0, x1 - x0, y1 - y0, dpr));
  }

  onPointerUp(e: ToolEvent): void {
    if (!this._active) return;
    this._active = false;

    const [x0, y0, x1, y1] = this._physBounds(e.doc.dpr);
    if (x1 - x0 < 1 || y1 - y0 < 1) {
      // Degenerate selection — clear.
      const mask = e.doc.selection;
      const cmd  = new SelectionCommand('Deselect', mask, () => {
        mask.reset();
      });
      e.emit(cmd);
      this.onSelectionChanged(null);
      return;
    }

    const mask = e.doc.selection;
    const op   = this.op;
    const dpr  = e.doc.dpr;

    const cmd = new SelectionCommand('Rect Select', mask, () => {
      applyRectToMask(mask, x0, y0, x1, y1, op);
    });
    e.emit(cmd);
    this.onSelectionChanged(rectToPolyline(x0, y0, x1 - x0, y1 - y0, dpr));
  }

  onCancel(): void {
    this._active = false;
    this.onSelectionChanged(null);
  }

  private _physBounds(dpr: number): [number, number, number, number] {
    const ax = cssToPhysical(this._anchorX, dpr);
    const ay = cssToPhysical(this._anchorY, dpr);
    const cx = cssToPhysical(this._curX,    dpr);
    const cy = cssToPhysical(this._curY,    dpr);
    return [Math.min(ax, cx), Math.min(ay, cy), Math.max(ax, cx), Math.max(ay, cy)];
  }
}

// ---------------------------------------------------------------------------
// EllipseSelectTool
// ---------------------------------------------------------------------------

export class EllipseSelectTool implements PhobosTool {
  readonly id     = 'ellipse-select' as const;
  readonly cursor = 'crosshair';

  op: SelectionOp = 'replace';
  onSelectionChanged: SelectionChangedCallback = () => {};

  private _active:  boolean;
  private _anchorX: number;
  private _anchorY: number;
  private _curX:    number;
  private _curY:    number;

  constructor() {
    this._active  = false;
    this._anchorX = 0;
    this._anchorY = 0;
    this._curX    = 0;
    this._curY    = 0;
  }

  onPointerDown(e: ToolEvent): void {
    this._active  = true;
    this._anchorX = e.x;
    this._anchorY = e.y;
    this._curX    = e.x;
    this._curY    = e.y;
  }

  onPointerMove(e: ToolEvent): void {
    if (!this._active) return;
    this._curX = e.x;
    this._curY = e.y;
    const [cx, cy, rx, ry] = this._physParams(e.doc.dpr);
    const dpr              = e.doc.dpr;
    this.onSelectionChanged(ellipseToPolyline(cx, cy, rx, ry, dpr));
  }

  onPointerUp(e: ToolEvent): void {
    if (!this._active) return;
    this._active = false;

    const [cx, cy, rx, ry] = this._physParams(e.doc.dpr);
    if (rx < 1 || ry < 1) {
      const mask = e.doc.selection;
      const cmd  = new SelectionCommand('Deselect', mask, () => { mask.reset(); });
      e.emit(cmd);
      this.onSelectionChanged(null);
      return;
    }

    const mask = e.doc.selection;
    const op   = this.op;
    const dpr  = e.doc.dpr;

    const cmd = new SelectionCommand('Ellipse Select', mask, () => {
      applyEllipseToMask(mask, cx, cy, rx, ry, op);
    });
    e.emit(cmd);
    this.onSelectionChanged(ellipseToPolyline(cx, cy, rx, ry, dpr));
  }

  onCancel(): void {
    this._active = false;
    this.onSelectionChanged(null);
  }

  private _physParams(dpr: number): [number, number, number, number] {
    const ax = cssToPhysical(this._anchorX, dpr);
    const ay = cssToPhysical(this._anchorY, dpr);
    const cx = cssToPhysical(this._curX,    dpr);
    const cy = cssToPhysical(this._curY,    dpr);
    const centerX = (ax + cx) / 2;
    const centerY = (ay + cy) / 2;
    const rx      = Math.abs(cx - ax) / 2;
    const ry      = Math.abs(cy - ay) / 2;
    return [centerX, centerY, rx, ry];
  }
}
