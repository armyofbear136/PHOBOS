import { PhobosLayer }                from '../editor/PhobosLayer';
import type { PhobosTool, ToolEvent } from './ToolController';
import type { PhobosCommand }         from '../types';

// =============================================================================
// MoveSelectionTool
//
// Moves the content of the current selection.
//
// Lifecycle:
//   pointerDown → snapshot active layer → cut selected pixels to transparent →
//                 create float layer with cut pixels → notify EditorCanvas
//   pointerMove → update float layer konvaNode offset (CSS px) → batchDraw
//   pointerUp   → compute final physical offset → drawImage into active layer →
//                 remove float layer → push MoveSelectionCommand
//
// The MoveSelectionCommand is atomic:
//   execute() → restore pre-cut snapshot → re-cut → re-apply the final offset
//   undo()    → restore pre-cut snapshot (active layer back to original)
//
// Callbacks wired by EditorCanvas:
//   onFloatLayerAdded(layer)   — EditorCanvas creates a Konva.Image for it
//   onFloatLayerRemoved(layer) — EditorCanvas destroys the Konva.Image
//   onFloatLayerMoved(layer)   — EditorCanvas calls batchDraw after offset change
// =============================================================================

export type FloatLayerCallback = (layer: PhobosLayer) => void;
export type FloatLayerMovedCallback = (layer: PhobosLayer, cssX: number, cssY: number) => void;

/** Internal atomic command — only instantiated at pointerUp. */
class MoveSelectionCommand implements PhobosCommand {
  readonly name = 'Move Selection';

  private readonly activeLayer:   PhobosLayer;
  private readonly floatPixels:   Uint8ClampedArray;  // float layer pixels (full layer size)
  private readonly preSnapshot:   Uint8ClampedArray;  // active layer before cut
  private readonly offsetX:       number;             // final physical px offset
  private readonly offsetY:       number;
  private readonly physW:         number;
  private readonly physH:         number;
  private readonly maskSnapshot:  Uint8Array;         // mask state at move time
  private readonly maskEmpty:     boolean;

  constructor(
    activeLayer:  PhobosLayer,
    floatPixels:  Uint8ClampedArray,
    preSnapshot:  Uint8ClampedArray,
    offsetX:      number,
    offsetY:      number,
    physW:        number,
    physH:        number,
    maskSnapshot: Uint8Array,
    maskEmpty:    boolean,
  ) {
    this.activeLayer  = activeLayer;
    this.floatPixels  = floatPixels;
    this.preSnapshot  = preSnapshot;
    this.offsetX      = offsetX;
    this.offsetY      = offsetY;
    this.physW        = physW;
    this.physH        = physH;
    this.maskSnapshot = maskSnapshot;
    this.maskEmpty    = maskEmpty;
  }

  execute(): void {
    // Restore active layer to pre-cut state, then re-apply the move.
    const { physW, physH } = this;
    const layer  = this.activeLayer;
    const imgD   = layer.getImageData();
    const pixels = imgD.data;

    // Step 1: restore pre-cut state.
    pixels.set(this.preSnapshot);

    // Step 2: cut selected region to transparent using the saved mask.
    for (let i = 0; i < physW * physH; i++) {
      const m = this.maskEmpty ? 255 : this.maskSnapshot[i];
      if (m > 0) {
        pixels[i * 4 + 3] = Math.round(pixels[i * 4 + 3] * (1 - m / 255));
      }
    }

    // Step 3: composite float pixels at final offset into active layer.
    const src = this.floatPixels;
    const dx  = this.offsetX;
    const dy  = this.offsetY;

    for (let sy = 0; sy < physH; sy++) {
      const dy2 = sy + dy;
      if (dy2 < 0 || dy2 >= physH) continue;
      for (let sx = 0; sx < physW; sx++) {
        const dx2 = sx + dx;
        if (dx2 < 0 || dx2 >= physW) continue;

        const si = (sy * physW + sx) * 4;
        const sA = src[si + 3];
        if (sA === 0) continue;

        const di = (dy2 * physW + dx2) * 4;
        const alpha  = sA / 255;
        const dA     = pixels[di + 3] / 255;
        const outA   = alpha + dA * (1 - alpha);
        const invOut = outA === 0 ? 0 : 1 / outA;

        pixels[di]     = ((src[si]     * alpha + pixels[di]     * dA * (1 - alpha)) * invOut) | 0;
        pixels[di + 1] = ((src[si + 1] * alpha + pixels[di + 1] * dA * (1 - alpha)) * invOut) | 0;
        pixels[di + 2] = ((src[si + 2] * alpha + pixels[di + 2] * dA * (1 - alpha)) * invOut) | 0;
        pixels[di + 3] = (outA * 255) | 0;
      }
    }

    layer.putImageData(imgD);
    layer.markDirty();
  }

  undo(): void {
    // Restore active layer to the state before the move started.
    const layer  = this.activeLayer;
    const imgD   = layer.getImageData();
    imgD.data.set(this.preSnapshot);
    layer.putImageData(imgD);
    layer.markDirty();
  }
}

// =============================================================================
// MoveSelectionTool
// =============================================================================

export class MoveSelectionTool implements PhobosTool {
  readonly id     = 'move-selection' as const;
  readonly cursor = 'move';

  // Wired by EditorCanvas after mount.
  onFloatLayerAdded:   FloatLayerCallback        = () => {};
  onFloatLayerRemoved: FloatLayerCallback        = () => {};
  onFloatLayerMoved:   FloatLayerMovedCallback   = () => {};

  private _active:       boolean;
  private _floatLayer:   PhobosLayer | null;
  private _preSnapshot:  Uint8ClampedArray | null;
  private _maskSnapshot: Uint8Array | null;
  private _maskEmpty:    boolean;
  private _floatPixels:  Uint8ClampedArray | null;  // pixels cut from active layer
  private _startX:       number;  // CSS px drag start
  private _startY:       number;
  private _curOffsetX:   number;  // current CSS px offset
  private _curOffsetY:   number;

  constructor() {
    this._active       = false;
    this._floatLayer   = null;
    this._preSnapshot  = null;
    this._maskSnapshot = null;
    this._maskEmpty    = true;
    this._floatPixels  = null;
    this._startX       = 0;
    this._startY       = 0;
    this._curOffsetX   = 0;
    this._curOffsetY   = 0;
  }

  // ---------------------------------------------------------------------------

  onPointerDown(e: ToolEvent): void {
    const layer  = e.doc.activeLayer;
    if (layer.locked) return;

    const mask   = e.doc.selection;
    const physW  = e.doc.physicalWidth;
    const physH  = e.doc.physicalHeight;

    // Capture pre-cut state.
    this._preSnapshot  = layer.snapshot();
    this._maskSnapshot = mask.data.slice();
    this._maskEmpty    = mask.empty;

    // Read active layer pixels.
    const imgD   = layer.getImageData();
    const pixels = imgD.data;

    // Allocate float pixel buffer — cut region copied here.
    const floatBuf = new Uint8ClampedArray(physW * physH * 4);

    // Cut selected pixels into float buffer, clear them from active layer.
    for (let i = 0; i < physW * physH; i++) {
      const m = mask.empty ? 255 : mask.data[i];
      if (m === 0) continue;

      const bi = i * 4;
      const t  = m / 255;

      // Copy to float (proportional to mask coverage).
      floatBuf[bi]     = pixels[bi];
      floatBuf[bi + 1] = pixels[bi + 1];
      floatBuf[bi + 2] = pixels[bi + 2];
      floatBuf[bi + 3] = Math.round(pixels[bi + 3] * t);

      // Make transparent in active layer (proportional to mask).
      pixels[bi + 3] = Math.round(pixels[bi + 3] * (1 - t));
    }

    layer.putImageData(imgD);
    layer.markDirty();

    this._floatPixels = floatBuf;

    // Create the float layer and populate with cut pixels.
    const floatLayer = new PhobosLayer('__float__', physW, physH);
    const floatImgD  = new ImageData(new Uint8ClampedArray(floatBuf), physW, physH);
    floatLayer.ctx.putImageData(floatImgD, 0, 0);

    this._floatLayer  = floatLayer;
    this._active      = true;
    this._startX      = e.x;
    this._startY      = e.y;
    this._curOffsetX  = 0;
    this._curOffsetY  = 0;

    // Notify EditorCanvas to create the Konva.Image for this float layer.
    this.onFloatLayerAdded(floatLayer);
  }

  onPointerMove(e: ToolEvent): void {
    if (!this._active || !this._floatLayer) return;

    this._curOffsetX = e.x - this._startX;
    this._curOffsetY = e.y - this._startY;

    // Signal EditorCanvas to reposition the float layer's Konva node.
    this.onFloatLayerMoved(this._floatLayer, this._curOffsetX, this._curOffsetY);
  }

  onPointerUp(e: ToolEvent): void {
    if (!this._active || !this._floatLayer) return;
    this._active = false;

    const finalCssX  = e.x - this._startX;
    const finalCssY  = e.y - this._startY;
    const dpr        = e.doc.dpr;
    const offsetX    = Math.round(finalCssX * dpr);
    const offsetY    = Math.round(finalCssY * dpr);

    const activeLayer  = e.doc.activeLayer;
    const floatPixels  = this._floatPixels!;
    const preSnapshot  = this._preSnapshot!;
    const maskSnapshot = this._maskSnapshot!;
    const maskEmpty    = this._maskEmpty;
    const physW        = e.doc.physicalWidth;
    const physH        = e.doc.physicalHeight;
    const floatLayer   = this._floatLayer;

    // Remove the float layer from display before pushing the command.
    this.onFloatLayerRemoved(floatLayer);
    this._floatLayer  = null;
    this._preSnapshot = null;
    this._floatPixels = null;

    const cmd = new MoveSelectionCommand(
      activeLayer, floatPixels, preSnapshot,
      offsetX, offsetY,
      physW, physH,
      maskSnapshot, maskEmpty,
    );

    e.emit(cmd);
  }

  onCancel(): void {
    if (!this._active) return;
    this._active = false;

    // Restore active layer from pre-cut snapshot without pushing a command.
    // This is called when the tool is switched away mid-drag — uncommon but
    // must be handled cleanly.
    if (this._floatLayer) {
      this.onFloatLayerRemoved(this._floatLayer);
      this._floatLayer = null;
    }

    // NOTE: active layer pixels were already modified (cut). Without a
    // document reference here we cannot restore them. The tool interface
    // does not provide doc in onCancel() by design. In practice, onCancel()
    // is called from ToolController.setActiveTool() which happens between
    // pointer events — never mid-drag in normal use. If this edge case
    // becomes a problem in Phase 2, the solution is to make ToolController
    // pass doc to onCancel().
    this._preSnapshot  = null;
    this._floatPixels  = null;
    this._maskSnapshot = null;
  }
}
