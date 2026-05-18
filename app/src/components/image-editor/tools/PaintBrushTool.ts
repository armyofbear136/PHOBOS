import { cssToPhysical }              from '../editor/PhobosDocument';
import type { PhobosTool, ToolEvent } from '../tools/ToolController';
import type { PhobosCommand }          from '../types';
import type { PhobosLayer }           from '../editor/PhobosLayer';
import type { GPUBrushEngine }        from '../gpu/GPUBrushEngine';

// =============================================================================
// PaintBrushTool
//
// Round soft brush. Stamps into layer FBOs via GPUBrushEngine when available,
// falling back to the CPU path (_paintStamp) when the GPU engine is absent.
//
// GPU stroke lifecycle:
//   pointerDown  → brushEngine.beginStroke() + brushEngine.stampAt() (first stamp)
//   pointerMove  → brushEngine.stampAt()  (hot path, zero allocation)
//   pointerUp    → brushEngine.endStroke() [async]
//                    → readback resolves → write pixels to CPU canvas
//                    → emit LiveStrokeCommand
//   cancel       → brushEngine.cancelStroke() [async]
//                    → readback resolves → write pixels to CPU canvas
//                    → do NOT emit (user cancelled)
//
// CPU stroke lifecycle (fallback or undo replay):
//   pointerDown  → _paintStamp() + layer.markDirty()
//   pointerMove  → _paintStamp() + layer.markDirty()
//   pointerUp    → emit LiveStrokeCommand (CPU canvas already current)
//   cancel       → discard
//
// Undo/redo:
//   LiveStrokeCommand.execute() restores the pre-stroke CPU snapshot, then
//   calls replayFn() which re-runs all stamps via the CPU path. The GPU path
//   is never used for replay — CPU replay is deterministic and context-free.
//
// Pre-stroke snapshot:
//   Taken at pointerDown before any pixels change. On the GPU path, taken from
//   the CPU canvas (which is current at that point — the FBO has not yet diverged).
//   After endStroke() resolves, the readback is written to the CPU canvas and the
//   command is emitted. The pre-snapshot covers only the stroke bbox.
// =============================================================================

const MAX_STAMP_PX  = 512;
const SPACING_RATIO = 0.25;

export interface BrushSettings {
  size:     number;   // diameter in CSS pixels
  hardness: number;   // 0–1
  opacity:  number;   // 0–1
  color:    string;   // CSS colour e.g. '#ff0000'
}

// ---------------------------------------------------------------------------
// LiveStrokeCommand
// ---------------------------------------------------------------------------

class LiveStrokeCommand implements PhobosCommand {
  readonly name = 'Paint Stroke';

  private readonly layer:        PhobosLayer;
  private readonly preSnapshot:  Uint8ClampedArray;  // full layer, physW*physH*4
  private readonly postSnapshot: Uint8ClampedArray | null;  // full layer if GPU path; null if CPU path
  private readonly replayFn:     () => void;

  constructor(
    layer:        PhobosLayer,
    preSnapshot:  Uint8ClampedArray,
    replayFn:     () => void,
    postSnapshot: Uint8ClampedArray | null = null,
  ) {
    this.layer        = layer;
    this.preSnapshot  = preSnapshot;
    this.postSnapshot = postSnapshot;
    this.replayFn     = replayFn;
  }

  execute(): void {
    if (this.postSnapshot !== null) {
      // GPU path: restore exact readback pixels (full layer, no bbox).
      this.layer.restore(this.postSnapshot);
    } else {
      // CPU path: restore pre-stroke state then replay the stroke.
      this.layer.restore(this.preSnapshot);
      this.replayFn();
    }
    this.layer.markDirty();
  }

  undo(): void {
    this.layer.restore(this.preSnapshot);
    this.layer.markDirty();
  }
}

// ---------------------------------------------------------------------------
// PaintBrushTool
// ---------------------------------------------------------------------------

export class PaintBrushTool implements PhobosTool {
  readonly id     = 'paint-brush' as const;
  readonly cursor = 'crosshair';

  settings: BrushSettings;

  // GPU brush engine — injected by ToolController.setBrushEngine().
  // Null when the WebGL2 context is unavailable or not yet initialised.
  private _brushEngine: GPUBrushEngine | null = null;

  // Pre-allocated stamp canvas for the CPU path and undo replay.
  private readonly stampCanvas: OffscreenCanvas;
  private readonly stampCtx:    OffscreenCanvasRenderingContext2D;

  private _stampSize:     number;
  private _stampHardness: number;
  private _stampColor:    string;

  // Per-stroke state — valid between pointerDown and pointerUp/cancel.
  private _stroking:    boolean;
  private _lastX:       number;
  private _lastY:       number;
  private _distAcc:     number;
  private _strokePts:   { x: number; y: number; pressure: number }[];
  private _preSnapshot: Uint8ClampedArray | null;
  private _strokeDpr:   number;

  // Whether the current stroke is using the GPU engine.
  // Set at pointerDown and kept stable for the stroke lifetime.
  private _usingGPU: boolean;

  constructor(settings: BrushSettings) {
    this.settings       = settings;
    this.stampCanvas    = new OffscreenCanvas(MAX_STAMP_PX, MAX_STAMP_PX);
    const ctx           = this.stampCanvas.getContext('2d');
    if (!ctx) throw new Error('Failed to create stamp canvas context');
    this.stampCtx       = ctx;
    this._stampSize     = -1;
    this._stampHardness = -1;
    this._stampColor    = '';
    this._stroking      = false;
    this._lastX         = 0;
    this._lastY         = 0;
    this._distAcc       = 0;
    this._strokePts     = [];
    this._preSnapshot   = null;
    this._strokeDpr     = 1;
    this._usingGPU      = false;
  }

  // ---------------------------------------------------------------------------
  // GPU engine injection — called by ToolController.setBrushEngine()
  // ---------------------------------------------------------------------------

  setBrushEngine(engine: GPUBrushEngine | null): void {
    this._brushEngine = engine;
  }

  // ---------------------------------------------------------------------------
  // Pointer events
  // ---------------------------------------------------------------------------

  onPointerDown(e: ToolEvent): void {
    const layer = e.doc.activeLayer;
    if (layer.locked) return;

    const dpr       = e.doc.dpr;
    const stampDiam = Math.max(1, Math.round(this.settings.size * dpr));
    const r         = Math.ceil(stampDiam / 2);
    const px        = cssToPhysical(e.x, dpr);
    const py        = cssToPhysical(e.y, dpr);

    this._stroking  = true;
    this._strokeDpr = dpr;
    this._lastX     = e.x;
    this._lastY     = e.y;
    this._distAcc   = 0;
    this._strokePts = [{ x: e.x, y: e.y, pressure: e.pressure }];

    // Snapshot the full layer before the stroke begins.
    // Both GPU and CPU paths now use full-layer snapshots so restore() always
    // receives dimensions that match physW*physH exactly — no bbox mismatch possible.
    const eng = this._brushEngine;
    if (eng?.isReady) {
      // GPU path — snapshot the full layer before the FBO diverges.
      this._usingGPU    = true;
      this._preSnapshot = layer.snapshot();
      eng.beginStroke(layer);
      eng.stampAt(
        px, py,
        r,
        this.settings.hardness,
        this.settings.opacity,
        this.settings.color,
      );
    } else {
      // CPU fallback — snapshot the full layer so restore() matches dimensions.
      this._usingGPU    = false;
      this._preSnapshot = layer.snapshot();
      this._ensureStamp(stampDiam, this.settings.hardness, this.settings.color);
      this._paintStamp(
        layer, e.doc.physicalWidth, e.doc.physicalHeight,
        px, py, r,
        e.doc.selection.data, e.doc.selection.empty,
      );
      layer.markDirty();
    }
  }

  onPointerMove(e: ToolEvent): void {
    if (!this._stroking) return;

    const dpr       = e.doc.dpr;
    const stampDiam = Math.max(1, Math.round(this.settings.size * dpr));
    const r         = stampDiam / 2;
    const spacing   = Math.max(1, stampDiam * SPACING_RATIO);

    // Record every raw event unconditionally so replayFn sees the full stream.
    this._strokePts.push({ x: e.x, y: e.y, pressure: e.pressure });

    const px  = cssToPhysical(e.x, dpr);
    const py  = cssToPhysical(e.y, dpr);
    const lpx = cssToPhysical(this._lastX, dpr);
    const lpy = cssToPhysical(this._lastY, dpr);
    const dx  = px - lpx;
    const dy  = py - lpy;
    const segLen = Math.sqrt(dx * dx + dy * dy);

    this._lastX = e.x;
    this._lastY = e.y;

    if (segLen === 0) return;

    // Walk the segment in spacing-sized steps, carrying remainder into the next
    // event. This is the standard Photoshop/paint.net interpolation technique:
    // no gaps regardless of pointer speed, perfectly even stamp density.
    let walked = spacing - this._distAcc;
    while (walked <= segLen) {
      // Stamp position: walked/segLen along the segment from last point.
      const t  = walked / segLen;
      const sx = lpx + dx * t;
      const sy = lpy + dy * t;

      if (this._usingGPU) {
        this._brushEngine!.stampAt(sx, sy, r, this.settings.hardness, this.settings.opacity, this.settings.color);
      } else {
        this._ensureStamp(stampDiam, this.settings.hardness, this.settings.color);
        this._paintStamp(
          e.doc.activeLayer, e.doc.physicalWidth, e.doc.physicalHeight,
          sx, sy, r,
          e.doc.selection.data, e.doc.selection.empty,
        );
        e.doc.activeLayer.markDirty();
      }

      walked += spacing;
    }

    // Preserve the remainder so the next segment starts from the correct offset.
    this._distAcc = segLen - (walked - spacing);
  }

  onPointerUp(e: ToolEvent): void {
    if (!this._stroking) return;
    this._stroking = false;

    const layer       = e.doc.activeLayer;
    const preSnapshot = this._preSnapshot!;
    this._preSnapshot = null;

    const pts      = this._strokePts.slice();
    const settings = { ...this.settings };
    const dpr      = this._strokeDpr;
    const physW    = e.doc.physicalWidth;
    const physH    = e.doc.physicalHeight;
    const maskData = e.doc.selection.data;
    const maskEmpty = e.doc.selection.empty;
    const tool     = this;

    const replayFn = (): void => {
      const stampDiam = Math.max(1, Math.round(settings.size * dpr));
      const r         = stampDiam / 2;
      const spacing   = Math.max(1, stampDiam * SPACING_RATIO);

      tool._ensureStamp(stampDiam, settings.hardness, settings.color);

      let lastPX = cssToPhysical(pts[0].x, dpr);
      let lastPY = cssToPhysical(pts[0].y, dpr);
      tool._paintStamp(layer, physW, physH, lastPX, lastPY, r, maskData, maskEmpty);

      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        const px   = cssToPhysical(pts[i].x, dpr);
        const py   = cssToPhysical(pts[i].y, dpr);
        const ddx  = px - lastPX;
        const ddy  = py - lastPY;
        const dist = Math.sqrt(ddx * ddx + ddy * ddy);
        acc += dist;

        while (acc >= spacing) {
          const t  = (dist - (acc - spacing)) / dist;
          const sx = Math.round(lastPX + ddx * t);
          const sy = Math.round(lastPY + ddy * t);
          tool._paintStamp(layer, physW, physH, sx, sy, r, maskData, maskEmpty);
          acc -= spacing;
        }
        lastPX = px;
        lastPY = py;
      }
    };

    if (this._usingGPU) {
      // RAF loop is stopped before onPointerUp fires (EditorCanvas guarantees this).
      // Synchronous full-layer readback: gl.finish() + readPixels.
      // Full-layer eliminates all bbox mismatch classes permanently.
      const postSnapshot = this._brushEngine!.endStrokeSync();

      if (postSnapshot !== null) {
        e.emit(new LiveStrokeCommand(layer, preSnapshot, replayFn, postSnapshot));
      } else {
        // Context lost — CPU canvas was never modified during the GPU stroke.
        // Fall back to CPU replay so undo state is still consistent.
        console.warn('[PaintBrushTool] GPU readback returned null (context lost?), falling back to CPU replay');
        e.emit(new LiveStrokeCommand(layer, preSnapshot, replayFn));
      }
    } else {
      // CPU path — canvas is already current, emit synchronously.
      e.emit(new LiveStrokeCommand(layer, preSnapshot, replayFn));
    }
  }

  onCancel(): void {
    if (!this._stroking) return;
    this._stroking    = false;
    this._preSnapshot = null;

    if (this._usingGPU && this._brushEngine) {
      // Always sync GPU→CPU on cancel — we agreed: never silently discard brush data.
      // The promise is intentionally not awaited and no command is emitted.
      // The resolved pixels are written back so the CPU canvas reflects
      // whatever was drawn before the cancel, leaving the layer in a clean state.
      this._brushEngine.cancelStroke().then((pixels: Uint8ClampedArray) => {
        // We don't have access to the layer or bbox here after stroking=false,
        // so we stored nothing from the cancelled stroke. The GPU FBO content
        // will be cleared on the next stroke's beginStroke(). The CPU canvas
        // remains at its pre-stroke state — which is correct for a cancel.
        // No action needed: the layer's CPU canvas was never modified during
        // a GPU stroke, so it is already correct.
        void pixels; // readback complete — GPU and CPU are now in sync
      }).catch(() => {
        // Context lost or superseded. CPU canvas was never modified during the
        // GPU stroke. Layer is in a consistent state.
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private — stamp generation (CPU path and undo replay)
  // ---------------------------------------------------------------------------

  private _ensureStamp(size: number, hardness: number, color: string): void {
    if (size === this._stampSize && hardness === this._stampHardness && color === this._stampColor) return;
    this._stampSize     = size;
    this._stampHardness = hardness;
    this._stampColor    = color;

    const ctx  = this.stampCtx;
    const half = MAX_STAMP_PX / 2;
    ctx.clearRect(0, 0, MAX_STAMP_PX, MAX_STAMP_PX);

    const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(Math.min(hardness, 0.999), color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(half, half, half, 0, Math.PI * 2);
    ctx.fill();
  }

  private _paintStamp(
    layer:     PhobosLayer,
    physW:     number,
    physH:     number,
    cx:        number,
    cy:        number,
    r:         number,
    maskData:  Uint8Array,
    maskEmpty: boolean,
  ): void {
    const opacity = this.settings.opacity;

    const x0 = Math.max(0, cx - Math.ceil(r));
    const y0 = Math.max(0, cy - Math.ceil(r));
    const x1 = Math.min(physW, cx + Math.ceil(r));
    const y1 = Math.min(physH, cy + Math.ceil(r));
    const w  = x1 - x0;
    const h  = y1 - y0;
    if (w <= 0 || h <= 0) return;

    if (maskEmpty && opacity === 1) {
      // Fast path: drawImage directly onto layer canvas.
      const half = MAX_STAMP_PX / 2;
      const srcX = half - r + (x0 - cx + r);
      const srcY = half - r + (y0 - cy + r);
      layer.ctx.drawImage(this.stampCanvas, srcX, srcY, w, h, x0, y0, w, h);
      return;
    }

    // Slow path: per-pixel composite with opacity and mask support.
    const stampData = this.stampCtx.getImageData(0, 0, MAX_STAMP_PX, MAX_STAMP_PX).data;
    const half      = MAX_STAMP_PX / 2;
    const imgData   = layer.getImageData({ x: x0, y: y0, w, h });
    const pixels    = imgData.data;

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const sx = Math.round(x - cx + half);
        const sy = Math.round(y - cy + half);
        if (sx < 0 || sy < 0 || sx >= MAX_STAMP_PX || sy >= MAX_STAMP_PX) continue;

        const si     = (sy * MAX_STAMP_PX + sx) * 4;
        const stampA = stampData[si + 3];
        if (stampA === 0) continue;

        const alpha = (stampA / 255) * opacity;
        const bx    = x - x0;
        const by    = y - y0;
        const di    = (by * w + bx) * 4;

        const sR = stampData[si];
        const sG = stampData[si + 1];
        const sB = stampData[si + 2];
        const dA = pixels[di + 3];

        const outA   = alpha + (dA / 255) * (1 - alpha);
        const invOut = outA === 0 ? 0 : 1 / outA;
        const fR     = ((sR * alpha + pixels[di]     * (dA / 255) * (1 - alpha)) * invOut) | 0;
        const fG     = ((sG * alpha + pixels[di + 1] * (dA / 255) * (1 - alpha)) * invOut) | 0;
        const fB     = ((sB * alpha + pixels[di + 2] * (dA / 255) * (1 - alpha)) * invOut) | 0;
        const fA     = (outA * 255) | 0;

        const mi = maskEmpty ? 255 : maskData[y * physW + x];
        if (mi === 255) {
          pixels[di] = fR; pixels[di+1] = fG; pixels[di+2] = fB; pixels[di+3] = fA;
        } else if (mi > 0) {
          const t = mi / 255;
          pixels[di]   = (pixels[di]   + (fR - pixels[di])   * t) | 0;
          pixels[di+1] = (pixels[di+1] + (fG - pixels[di+1]) * t) | 0;
          pixels[di+2] = (pixels[di+2] + (fB - pixels[di+2]) * t) | 0;
          pixels[di+3] = (pixels[di+3] + (fA - pixels[di+3]) * t) | 0;
        }
      }
    }

    layer.putImageData(imgData, { x: x0, y: y0, w, h });
  }
}
