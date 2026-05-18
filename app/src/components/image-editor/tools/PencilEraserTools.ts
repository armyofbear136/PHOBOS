import { cssToPhysical }              from '../editor/PhobosDocument';
import type { PhobosTool, ToolEvent } from './ToolController';
import type { PhobosCommand }         from '../types';
import type { PhobosLayer }          from '../editor/PhobosLayer';

// =============================================================================
// PencilTool
//
// 1-pixel-exact drawing. Uses ctx.lineTo() with imageSmoothingEnabled = false
// for crisp pixel-level strokes. No brush softness — all edges are hard.
//
// EraserTool
//
// Same engine as Pencil but with composite operation 'destination-out',
// setting alpha to 0 on painted pixels.
//
// Both tools use the same pre-snapshot / LiveStrokeCommand pattern as
// PaintBrushTool for correct undo behaviour.
// =============================================================================

// ---------------------------------------------------------------------------
// Shared LiveStrokeCommand (local copy — same design as PaintBrushTool's)
// ---------------------------------------------------------------------------

class LiveStrokeCommand implements PhobosCommand {
  readonly name: string;

  private readonly layer:       PhobosLayer;
  private readonly preSnapshot: Uint8ClampedArray;
  private readonly replayFn:    () => void;

  constructor(name: string, layer: PhobosLayer, preSnapshot: Uint8ClampedArray, replayFn: () => void) {
    this.name        = name;
    this.layer       = layer;
    this.preSnapshot = preSnapshot;
    this.replayFn    = replayFn;
  }

  execute(): void {
    this.layer.restore(this.preSnapshot);
    this.replayFn();
    this.layer.markDirty();
  }

  undo(): void {
    this.layer.restore(this.preSnapshot);
    this.layer.markDirty();
  }
}

// ---------------------------------------------------------------------------
// Shared stroke state
// ---------------------------------------------------------------------------

interface StrokeState {
  active:      boolean;
  pts:         { x: number; y: number }[];
  preSnapshot: Uint8ClampedArray | null;
  bboxMinX:    number;
  bboxMinY:    number;
  bboxMaxX:    number;
  bboxMaxY:    number;
}

function freshStroke(): StrokeState {
  return { active: false, pts: [], preSnapshot: null, bboxMinX: 0, bboxMinY: 0, bboxMaxX: 0, bboxMaxY: 0 };
}

// ---------------------------------------------------------------------------
// PencilTool
// ---------------------------------------------------------------------------

export interface PencilSettings {
  color:   string;   // CSS colour
  opacity: number;   // 0–1
  size:    number;   // 1 = 1px, 2 = 2px … (physical pixels)
}

export class PencilTool implements PhobosTool {
  readonly id     = 'pencil' as const;
  readonly cursor = 'crosshair';

  settings: PencilSettings;
  private _s: StrokeState;

  constructor(settings: PencilSettings) {
    this.settings = settings;
    this._s       = freshStroke();
  }

  onPointerDown(e: ToolEvent): void {
    const layer = e.doc.activeLayer;
    if (layer.locked) return;
    const dpr = e.doc.dpr;
    const px  = cssToPhysical(e.x, dpr);
    const py  = cssToPhysical(e.y, dpr);

    this._s = {
      active:      true,
      pts:         [{ x: e.x, y: e.y }],
      preSnapshot: layer.snapshot(),   // full-layer: bbox grows during stroke, snapshot must cover it all
      bboxMinX:    px, bboxMinY: py,
      bboxMaxX:    px, bboxMaxY: py,
    };

    this._drawStroke(layer, dpr, e.doc.physicalWidth, e.doc.physicalHeight, [{ x: e.x, y: e.y }]);
    layer.markDirty();
  }

  onPointerMove(e: ToolEvent): void {
    if (!this._s.active) return;
    const dpr = e.doc.dpr;
    const px  = cssToPhysical(e.x, dpr);
    const py  = cssToPhysical(e.y, dpr);
    this._s.bboxMinX = Math.min(this._s.bboxMinX, px);
    this._s.bboxMinY = Math.min(this._s.bboxMinY, py);
    this._s.bboxMaxX = Math.max(this._s.bboxMaxX, px);
    this._s.bboxMaxY = Math.max(this._s.bboxMaxY, py);
    this._s.pts.push({ x: e.x, y: e.y });
    this._drawStroke(e.doc.activeLayer, dpr, e.doc.physicalWidth, e.doc.physicalHeight, this._s.pts.slice(-2));
    e.doc.activeLayer.markDirty();
  }

  onPointerUp(e: ToolEvent): void {
    if (!this._s.active) return;
    this._s.active = false;

    const preSnapshot = this._s.preSnapshot!;
    const pts         = this._s.pts.slice();
    const layer       = e.doc.activeLayer;
    const dpr         = e.doc.dpr;
    const physW       = e.doc.physicalWidth;
    const physH       = e.doc.physicalHeight;
    const tool        = this;

    // preSnapshot is full-layer. LiveStrokeCommand.execute() restores it with no
    // bbox so dimensions always match regardless of how far the stroke grew.
    const cmd = new LiveStrokeCommand('Pencil', layer, preSnapshot, () => {
      tool._drawStroke(layer, dpr, physW, physH, pts);
    });
    e.emit(cmd);
  }

  onCancel(): void { this._s = freshStroke(); }

  private _drawStroke(
    layer: PhobosLayer,
    dpr:   number,
    physW: number,
    physH: number,
    pts:   { x: number; y: number }[],
  ): void {
    if (pts.length === 0) return;
    const ctx  = layer.ctx;
    const size = Math.max(1, this.settings.size);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha           = this.settings.opacity;
    ctx.strokeStyle           = this.settings.color;
    ctx.fillStyle             = this.settings.color;
    ctx.lineWidth             = size;
    ctx.lineCap               = 'square';
    ctx.lineJoin              = 'miter';

    if (pts.length === 1) {
      // Single dot.
      const px = cssToPhysical(pts[0].x, dpr);
      const py = cssToPhysical(pts[0].y, dpr);
      ctx.fillRect(
        Math.min(physW - size, Math.max(0, px - Math.floor(size / 2))),
        Math.min(physH - size, Math.max(0, py - Math.floor(size / 2))),
        size, size,
      );
    } else {
      ctx.beginPath();
      const first = pts[0];
      ctx.moveTo(cssToPhysical(first.x, dpr), cssToPhysical(first.y, dpr));
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(cssToPhysical(pts[i].x, dpr), cssToPhysical(pts[i].y, dpr));
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// EraserTool
// ---------------------------------------------------------------------------

export interface EraserSettings {
  size:    number;   // diameter in CSS pixels
  opacity: number;   // 0–1 (how much alpha is removed)
}

export class EraserTool implements PhobosTool {
  readonly id     = 'eraser' as const;
  readonly cursor = 'crosshair';

  settings: EraserSettings;
  private _s: StrokeState;

  constructor(settings: EraserSettings) {
    this.settings = settings;
    this._s       = freshStroke();
  }

  onPointerDown(e: ToolEvent): void {
    const layer = e.doc.activeLayer;
    if (layer.locked) return;
    const dpr = e.doc.dpr;
    const px  = cssToPhysical(e.x, dpr);
    const py  = cssToPhysical(e.y, dpr);
    const r   = Math.ceil(cssToPhysical(this.settings.size / 2, dpr));

    this._s = {
      active:      true,
      pts:         [{ x: e.x, y: e.y }],
      preSnapshot: layer.snapshot(),   // full-layer: bbox grows during stroke, snapshot must cover it all
      bboxMinX: Math.max(0, px - r),
      bboxMinY: Math.max(0, py - r),
      bboxMaxX: Math.min(e.doc.physicalWidth  - 1, px + r),
      bboxMaxY: Math.min(e.doc.physicalHeight - 1, py + r),
    };

    this._erase(layer, dpr, e.x, e.y);
    layer.markDirty();
  }

  onPointerMove(e: ToolEvent): void {
    if (!this._s.active) return;
    const dpr = e.doc.dpr;
    const r   = Math.ceil(cssToPhysical(this.settings.size / 2, dpr));
    const px  = cssToPhysical(e.x, dpr);
    const py  = cssToPhysical(e.y, dpr);
    this._s.bboxMinX = Math.min(this._s.bboxMinX, Math.max(0, px - r));
    this._s.bboxMinY = Math.min(this._s.bboxMinY, Math.max(0, py - r));
    this._s.bboxMaxX = Math.max(this._s.bboxMaxX, Math.min(e.doc.physicalWidth  - 1, px + r));
    this._s.bboxMaxY = Math.max(this._s.bboxMaxY, Math.min(e.doc.physicalHeight - 1, py + r));
    this._s.pts.push({ x: e.x, y: e.y });
    this._erase(e.doc.activeLayer, dpr, e.x, e.y);
    e.doc.activeLayer.markDirty();
  }

  onPointerUp(e: ToolEvent): void {
    if (!this._s.active) return;
    this._s.active = false;

    const preSnapshot = this._s.preSnapshot!;
    const pts         = this._s.pts.slice();
    const layer       = e.doc.activeLayer;
    const dpr         = e.doc.dpr;
    const tool        = this;

    // preSnapshot is full-layer. LiveStrokeCommand.execute() restores it with no
    // bbox so dimensions always match regardless of how far the stroke grew.
    const cmd = new LiveStrokeCommand('Eraser', layer, preSnapshot, () => {
      for (const pt of pts) tool._erase(layer, dpr, pt.x, pt.y);
    });
    e.emit(cmd);
  }

  onCancel(): void { this._s = freshStroke(); }

  private _erase(layer: PhobosLayer, dpr: number, cssX: number, cssY: number): void {
    const ctx  = layer.ctx;
    const cx   = cssToPhysical(cssX, dpr);
    const cy   = cssToPhysical(cssY, dpr);
    const r    = Math.max(1, cssToPhysical(this.settings.size / 2, dpr));

    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha              = this.settings.opacity;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}