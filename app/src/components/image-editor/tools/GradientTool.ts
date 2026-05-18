import { RasterCommand }              from '../editor/RasterCommand';
import { cssToPhysical }              from '../editor/PhobosDocument';
import type { PhobosTool, ToolEvent } from './ToolController';

// =============================================================================
// GradientTool
//
// Draws a gradient from the anchor point (pointerDown) to the endpoint
// (pointerUp). Supports linear and radial modes with configurable stops.
//
// Live preview: during drag, a RasterCommand is NOT pushed. Instead, the
// gradient is drawn directly onto a temporary preview overlay on the layer.
// The final commit on pointerUp pushes the RasterCommand.
//
// To avoid live-painting corruption on undo, we follow the same pre-snapshot
// pattern as PaintBrushTool: capture the full layer snapshot at pointerDown,
// restore it on each move to re-draw the preview cleanly, commit the final
// state on pointerUp.
// =============================================================================

export type GradientMode  = 'linear' | 'radial';
export type GradientRepeat = 'none' | 'repeat' | 'reflect';

export interface GradientStop {
  offset: number;   // 0–1
  color:  string;   // CSS colour
}

export interface GradientSettings {
  mode:    GradientMode;
  repeat:  GradientRepeat;
  opacity: number;
  stops:   GradientStop[];
}

export class GradientTool implements PhobosTool {
  readonly id     = 'gradient' as const;
  readonly cursor = 'crosshair';

  settings: GradientSettings;

  private _active:      boolean;
  private _anchorX:     number;  // CSS px
  private _anchorY:     number;
  private _preSnapshot: Uint8ClampedArray | null;

  constructor(settings: GradientSettings) {
    this.settings     = settings;
    this._active      = false;
    this._anchorX     = 0;
    this._anchorY     = 0;
    this._preSnapshot = null;
  }

  // ---------------------------------------------------------------------------

  onPointerDown(e: ToolEvent): void {
    const layer = e.doc.activeLayer;
    if (layer.locked) return;

    this._active      = true;
    this._anchorX     = e.x;
    this._anchorY     = e.y;
    this._preSnapshot = layer.snapshot();
  }

  onPointerMove(e: ToolEvent): void {
    if (!this._active || !this._preSnapshot) return;

    const layer = e.doc.activeLayer;

    // Restore pre-drag state so live preview is always clean.
    layer.restore(this._preSnapshot);

    // Draw preview gradient.
    this._drawGradient(layer, e.doc.dpr, e.doc.physicalWidth, e.doc.physicalHeight, e.x, e.y);
    layer.markDirty();
  }

  onPointerUp(e: ToolEvent): void {
    if (!this._active) return;
    this._active = false;

    const preSnapshot = this._preSnapshot!;
    this._preSnapshot = null;

    const layer   = e.doc.activeLayer;
    const dpr     = e.doc.dpr;
    const physW   = e.doc.physicalWidth;
    const physH   = e.doc.physicalHeight;
    const endX    = e.x;
    const endY    = e.y;
    const settings = { ...this.settings, stops: this.settings.stops.slice() };
    const anchorX = this._anchorX;
    const anchorY = this._anchorY;
    const tool    = this;

    const cmd = new RasterCommand('Gradient Fill', layer, undefined, () => {
      // Restore pre-snapshot then draw final gradient.
      layer.restore(preSnapshot);
      tool._drawGradientDirect(
        layer, dpr, physW, physH,
        anchorX, anchorY, endX, endY, settings,
      );
    });

    e.emit(cmd);
  }

  onCancel(): void {
    this._active      = false;
    this._preSnapshot = null;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _drawGradient(
    layer: import('../editor/PhobosLayer').PhobosLayer,
    dpr:   number,
    physW: number,
    physH: number,
    endX:  number,
    endY:  number,
  ): void {
    this._drawGradientDirect(
      layer, dpr, physW, physH,
      this._anchorX, this._anchorY, endX, endY,
      this.settings,
    );
  }

  private _drawGradientDirect(
    layer:    import('../editor/PhobosLayer').PhobosLayer,
    dpr:      number,
    physW:    number,
    physH:    number,
    anchorX:  number,
    anchorY:  number,
    endX:     number,
    endY:     number,
    settings: GradientSettings,
  ): void {
    const ctx  = layer.ctx;
    const ax   = cssToPhysical(anchorX, dpr);
    const ay   = cssToPhysical(anchorY, dpr);
    const ex   = cssToPhysical(endX,    dpr);
    const ey   = cssToPhysical(endY,    dpr);

    ctx.save();
    ctx.globalAlpha = settings.opacity;

    let gradient: CanvasGradient;

    if (settings.mode === 'linear') {
      gradient = ctx.createLinearGradient(ax, ay, ex, ey);
    } else {
      const radius = Math.sqrt((ex - ax) ** 2 + (ey - ay) ** 2);
      gradient     = ctx.createRadialGradient(ax, ay, 0, ax, ay, Math.max(1, radius));
    }

    for (const stop of settings.stops) {
      gradient.addColorStop(stop.offset, stop.color);
    }

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, physW, physH);
    ctx.restore();
  }
}
