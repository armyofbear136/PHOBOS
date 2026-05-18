import { PhobosDocument }  from '../editor/PhobosDocument';
import { PhobosLayer }     from '../editor/PhobosLayer';
import type { PhobosCommand } from '../types';

// =============================================================================
// ResizeDocumentCommand
//
// Resizes the canvas (adds or removes pixels at the edges) without scaling
// content. Each layer is reallocated at the new physical dimensions.
// Existing pixels are preserved in the overlapping region.
//
// Anchor controls where the existing content sits within the new canvas:
//   'top-left' | 'top-center' | 'top-right'
//   'middle-left' | 'center' | 'middle-right'
//   'bottom-left' | 'bottom-center' | 'bottom-right'
//
// The SelectionMask and fillQueue are also reallocated.
//
// Undo: restore all layer snapshots and resize back to original dimensions.
// =============================================================================

export type ResizeAnchor =
  | 'top-left'    | 'top-center'    | 'top-right'
  | 'middle-left' | 'center'        | 'middle-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

interface LayerSnapshot {
  id:        number;
  data:      Uint8ClampedArray;
  physW:     number;
  physH:     number;
}

export class ResizeDocumentCommand implements PhobosCommand {
  readonly name = 'Resize Canvas';

  private readonly doc:        PhobosDocument;
  private readonly newCssW:    number;
  private readonly newCssH:    number;
  private readonly anchor:     ResizeAnchor;

  // Captured at execute() time for undo.
  private snapshots:   LayerSnapshot[] | null;
  private oldCssW:     number;
  private oldCssH:     number;
  private oldPhysW:    number;
  private oldPhysH:    number;
  private oldActiveIdx: number;

  constructor(doc: PhobosDocument, newCssW: number, newCssH: number, anchor: ResizeAnchor = 'top-left') {
    if (newCssW < 1 || newCssH < 1) throw new RangeError('New dimensions must be >= 1');
    this.doc         = doc;
    this.newCssW     = newCssW;
    this.newCssH     = newCssH;
    this.anchor      = anchor;
    this.snapshots   = null;
    this.oldCssW     = 0;
    this.oldCssH     = 0;
    this.oldPhysW    = 0;
    this.oldPhysH    = 0;
    this.oldActiveIdx = 0;
  }

  execute(): void {
    const doc     = this.doc;
    const oldPhysW = doc.physicalWidth;
    const oldPhysH = doc.physicalHeight;

    // Snapshot all layers before resize.
    this.snapshots    = doc.layers.map(l => ({
      id:    l.id,
      data:  l.snapshot(),
      physW: oldPhysW,
      physH: oldPhysH,
    }));
    this.oldCssW      = doc.cssWidth;
    this.oldCssH      = doc.cssHeight;
    this.oldPhysW     = oldPhysW;
    this.oldPhysH     = oldPhysH;
    this.oldActiveIdx = doc.activeLayerIndex;

    const newPhysW = Math.round(this.newCssW * doc.dpr);
    const newPhysH = Math.round(this.newCssH * doc.dpr);

    // Compute offset for existing content given the anchor.
    const [offX, offY] = anchorOffset(oldPhysW, oldPhysH, newPhysW, newPhysH, this.anchor);

    // Resize each layer.
    for (const layer of doc.layers) {
      resizeLayer(layer, newPhysW, newPhysH, offX, offY);
    }

    // Patch document dimensions (readonly via cast — intentional: this is
    // the one authorised mutation site).
    (doc as unknown as { cssWidth: number }).cssWidth      = this.newCssW;
    (doc as unknown as { cssHeight: number }).cssHeight    = this.newCssH;
    (doc as unknown as { physicalWidth: number }).physicalWidth   = newPhysW;
    (doc as unknown as { physicalHeight: number }).physicalHeight = newPhysH;

    // Reallocate selection mask and fill queue.
    doc.selection.resize(newPhysW, newPhysH);
    (doc as unknown as { fillQueue: Uint32Array }).fillQueue =
      new Uint32Array(newPhysW * newPhysH);

    // Reallocate flatten canvas.
    const newFlat    = new OffscreenCanvas(newPhysW, newPhysH);
    const newFlatCtx = newFlat.getContext('2d')!;
    (doc as unknown as { flattenCanvas: OffscreenCanvas }).flattenCanvas = newFlat;
    (doc as unknown as { flattenCtx: OffscreenCanvasRenderingContext2D }).flattenCtx = newFlatCtx;

    doc.dirty = true;
  }

  undo(): void {
    if (!this.snapshots) return;
    const doc = this.doc;

    // Restore dimensions first.
    (doc as unknown as { cssWidth: number }).cssWidth      = this.oldCssW;
    (doc as unknown as { cssHeight: number }).cssHeight    = this.oldCssH;
    (doc as unknown as { physicalWidth: number }).physicalWidth   = this.oldPhysW;
    (doc as unknown as { physicalHeight: number }).physicalHeight = this.oldPhysH;

    // Restore each layer to its original size and pixels.
    for (const snap of this.snapshots) {
      const layer = doc.layers.find(l => l.id === snap.id);
      if (!layer) continue;
      resizeLayerBlank(layer, snap.physW, snap.physH);
      layer.restore(snap.data);
      layer.markDirty();
    }

    // Reallocate selection mask and fill queue.
    doc.selection.resize(this.oldPhysW, this.oldPhysH);
    doc.selection.reset();
    (doc as unknown as { fillQueue: Uint32Array }).fillQueue =
      new Uint32Array(this.oldPhysW * this.oldPhysH);

    const newFlat    = new OffscreenCanvas(this.oldPhysW, this.oldPhysH);
    const newFlatCtx = newFlat.getContext('2d')!;
    (doc as unknown as { flattenCanvas: OffscreenCanvas }).flattenCanvas = newFlat;
    (doc as unknown as { flattenCtx: OffscreenCanvasRenderingContext2D }).flattenCtx = newFlatCtx;

    doc.setActiveLayer(this.oldActiveIdx);
    doc.dirty = true;
  }
}

// =============================================================================
// CropToSelectionCommand
//
// Crops every layer to the bounding box of the current selection, then
// resets the selection. The document CSS dimensions shrink to match.
//
// If there is no active selection, this is a no-op.
// =============================================================================

export class CropToSelectionCommand implements PhobosCommand {
  readonly name = 'Crop to Selection';

  private readonly doc: PhobosDocument;

  // Captured at execute() for undo.
  private snapshots:   LayerSnapshot[] | null;
  private oldCssW:     number;
  private oldCssH:     number;
  private oldPhysW:    number;
  private oldPhysH:    number;
  private oldActiveIdx: number;
  private oldMask:     Uint8Array | null;
  private oldMaskEmpty: boolean;

  constructor(doc: PhobosDocument) {
    this.doc          = doc;
    this.snapshots    = null;
    this.oldCssW      = 0;
    this.oldCssH      = 0;
    this.oldPhysW     = 0;
    this.oldPhysH     = 0;
    this.oldActiveIdx = 0;
    this.oldMask      = null;
    this.oldMaskEmpty = true;
  }

  execute(): void {
    const doc  = this.doc;
    const bbox = doc.selection.bounds();

    // No selection or full canvas — no-op.
    if (!bbox || (bbox.x === 0 && bbox.y === 0 && bbox.w === doc.physicalWidth && bbox.h === doc.physicalHeight)) {
      return;
    }

    const oldPhysW = doc.physicalWidth;
    const oldPhysH = doc.physicalHeight;

    // Snapshot everything.
    this.snapshots    = doc.layers.map(l => ({
      id:    l.id,
      data:  l.snapshot(),
      physW: oldPhysW,
      physH: oldPhysH,
    }));
    this.oldCssW      = doc.cssWidth;
    this.oldCssH      = doc.cssHeight;
    this.oldPhysW     = oldPhysW;
    this.oldPhysH     = oldPhysH;
    this.oldActiveIdx = doc.activeLayerIndex;
    this.oldMask      = doc.selection.data.slice();
    this.oldMaskEmpty = doc.selection.empty;

    const { x, y, w, h } = bbox;

    // Crop each layer.
    for (const layer of doc.layers) {
      cropLayer(layer, x, y, w, h);
    }

    // Update document dimensions.
    const newCssW = w / doc.dpr;
    const newCssH = h / doc.dpr;
    (doc as unknown as { cssWidth: number }).cssWidth      = newCssW;
    (doc as unknown as { cssHeight: number }).cssHeight    = newCssH;
    (doc as unknown as { physicalWidth: number }).physicalWidth   = w;
    (doc as unknown as { physicalHeight: number }).physicalHeight = h;

    // Reallocate mask (reset — no selection after crop).
    doc.selection.resize(w, h);
    doc.selection.reset();
    (doc as unknown as { fillQueue: Uint32Array }).fillQueue = new Uint32Array(w * h);

    const newFlat    = new OffscreenCanvas(w, h);
    const newFlatCtx = newFlat.getContext('2d')!;
    (doc as unknown as { flattenCanvas: OffscreenCanvas }).flattenCanvas = newFlat;
    (doc as unknown as { flattenCtx: OffscreenCanvasRenderingContext2D }).flattenCtx = newFlatCtx;

    doc.dirty = true;
  }

  undo(): void {
    if (!this.snapshots) return;
    const doc = this.doc;

    (doc as unknown as { cssWidth: number }).cssWidth      = this.oldCssW;
    (doc as unknown as { cssHeight: number }).cssHeight    = this.oldCssH;
    (doc as unknown as { physicalWidth: number }).physicalWidth   = this.oldPhysW;
    (doc as unknown as { physicalHeight: number }).physicalHeight = this.oldPhysH;

    for (const snap of this.snapshots) {
      const layer = doc.layers.find(l => l.id === snap.id);
      if (!layer) continue;
      resizeLayerBlank(layer, snap.physW, snap.physH);
      layer.restore(snap.data);
      layer.markDirty();
    }

    // Restore selection mask.
    doc.selection.resize(this.oldPhysW, this.oldPhysH);
    if (this.oldMask) {
      doc.selection.data.set(this.oldMask);
      doc.selection.empty = this.oldMaskEmpty;
    } else {
      doc.selection.reset();
    }

    (doc as unknown as { fillQueue: Uint32Array }).fillQueue =
      new Uint32Array(this.oldPhysW * this.oldPhysH);

    const newFlat    = new OffscreenCanvas(this.oldPhysW, this.oldPhysH);
    const newFlatCtx = newFlat.getContext('2d')!;
    (doc as unknown as { flattenCanvas: OffscreenCanvas }).flattenCanvas = newFlat;
    (doc as unknown as { flattenCtx: OffscreenCanvasRenderingContext2D }).flattenCtx = newFlatCtx;

    doc.setActiveLayer(this.oldActiveIdx);
    doc.dirty = true;
  }
}

// =============================================================================
// Private helpers
// =============================================================================

function anchorOffset(
  oldW: number, oldH: number,
  newW: number, newH: number,
  anchor: ResizeAnchor,
): [number, number] {
  const hMap: Record<string, number> = {
    'left':   0,
    'center': Math.round((newW - oldW) / 2),
    'right':  newW - oldW,
  };
  const vMap: Record<string, number> = {
    'top':    0,
    'middle': Math.round((newH - oldH) / 2),
    'bottom': newH - oldH,
  };

  const [vPart, hPart] = anchor.split('-');
  const x = hMap[hPart] ?? 0;
  const y = vMap[vPart] ?? 0;
  return [x, y];
}

function resizeLayer(
  layer: PhobosLayer,
  newW:  number,
  newH:  number,
  offX:  number,
  offY:  number,
): void {
  const next    = new OffscreenCanvas(newW, newH);
  const nextCtx = next.getContext('2d', { willReadFrequently: true })!;
  // Draw old content at the anchor offset.
  nextCtx.drawImage(layer.canvas, offX, offY);
  swapCanvas(layer, next, nextCtx);
}

function resizeLayerBlank(layer: PhobosLayer, newW: number, newH: number): void {
  const next    = new OffscreenCanvas(newW, newH);
  const nextCtx = next.getContext('2d', { willReadFrequently: true })!;
  swapCanvas(layer, next, nextCtx);
}

function cropLayer(
  layer: PhobosLayer,
  x: number, y: number, w: number, h: number,
): void {
  const imgData = layer.ctx.getImageData(x, y, w, h);
  const next    = new OffscreenCanvas(w, h);
  const nextCtx = next.getContext('2d', { willReadFrequently: true })!;
  nextCtx.putImageData(imgData, 0, 0);
  swapCanvas(layer, next, nextCtx);
}

function swapCanvas(
  layer:   PhobosLayer,
  canvas:  OffscreenCanvas,
  ctx:     OffscreenCanvasRenderingContext2D,
): void {
  // Direct property assignment — PhobosLayer exposes canvas/ctx as mutable.
  layer.canvas = canvas;
  layer.ctx    = ctx;

  // gpuDirty is set by markDirty(). PhobosGPURenderer will re-upload and
  // reallocate the layer texture on the next composite pass.
  layer.markDirty();
}
