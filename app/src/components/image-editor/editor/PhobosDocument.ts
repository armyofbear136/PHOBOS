import { CommandStack }  from './CommandStack';
import { SelectionMask } from './SelectionMask';
import { PhobosLayer }   from './PhobosLayer';
import type { BlendMode } from '../types';

// =============================================================================
// PhobosDocument
//
// The root document object. Owns:
//   - The ordered layer list
//   - The CommandStack (undo/redo)
//   - The SelectionMask
//   - The pre-allocated BFS queue (shared by flood-fill and magic-wand tools)
//   - The pre-allocated flatten canvas (used by export and layer compositor)
//
// CSS pixel dimensions are stored on the document. Physical pixel dimensions
// (used for all canvas and ImageData operations) are cssSize × dpr.
//
// One document is open per session (v1). The constructor is the only place
// where large buffers are allocated — all tools borrow from these.
// =============================================================================

export interface LayerAddOptions {
  name?:      string;
  opacity?:   number;
  blendMode?: BlendMode;
  visible?:   boolean;
  locked?:    boolean;
  /** If provided, this ImageData is drawn onto the new layer immediately. */
  imageData?: ImageData;
}

export class PhobosDocument {
  // ── Identity ────────────────────────────────────────────────────────────────
  readonly id:  string;

  // ── Dimensions ──────────────────────────────────────────────────────────────
  /** Width in CSS pixels. */
  readonly cssWidth:      number;
  /** Height in CSS pixels. */
  readonly cssHeight:     number;
  /** Device pixel ratio — locked at document creation. */
  readonly dpr:           number;
  /** Width of all layer canvases, in physical pixels. */
  readonly physicalWidth: number;
  /** Height of all layer canvases, in physical pixels. */
  readonly physicalHeight: number;

  // ── Core subsystems ─────────────────────────────────────────────────────────
  readonly history:   CommandStack;
  readonly selection: SelectionMask;

  // ── Layer list ──────────────────────────────────────────────────────────────
  private _layers:          PhobosLayer[];
  private _activeLayerIndex: number;

  // ── Pre-allocated shared buffers ─────────────────────────────────────────────
  /**
   * BFS queue for flood-fill and magic-wand tools.
   * Sized to the maximum possible pixel count (physicalWidth × physicalHeight).
   * Borrowed by tools during their operation — never held across async
   * boundaries or between two concurrent operations.
   */
  readonly fillQueue: Uint32Array;

  /**
   * Single offscreen canvas used for layer flattening (export, merge, preview).
   * Pre-allocated at document size. Reused across all flatten operations.
   */
  readonly flattenCanvas: OffscreenCanvas;
  readonly flattenCtx:    OffscreenCanvasRenderingContext2D;

  // ── State ────────────────────────────────────────────────────────────────────
  dirty: boolean;

  constructor(
    cssWidth:  number,
    cssHeight: number,
    dpr:       number,
    options: {
      historyLimit?: number;
      /** Pre-populate the document with an existing image (e.g. on file open). */
      backgroundImage?: ImageBitmap;
    } = {},
  ) {
    if (cssWidth  < 1) throw new RangeError('Document width must be >= 1');
    if (cssHeight < 1) throw new RangeError('Document height must be >= 1');
    if (dpr       < 1) throw new RangeError('DPR must be >= 1');

    this.id           = generateId();
    this.cssWidth     = cssWidth;
    this.cssHeight    = cssHeight;
    this.dpr          = dpr;
    this.physicalWidth  = Math.round(cssWidth  * dpr);
    this.physicalHeight = Math.round(cssHeight * dpr);

    this.history   = new CommandStack(options.historyLimit ?? 50);
    this.selection = new SelectionMask(this.physicalWidth, this.physicalHeight);

    this._layers           = [];
    this._activeLayerIndex = 0;
    this.dirty             = false;

    // Pre-allocate the BFS queue.
    this.fillQueue = new Uint32Array(this.physicalWidth * this.physicalHeight);

    // Pre-allocate the flatten canvas.
    this.flattenCanvas = new OffscreenCanvas(this.physicalWidth, this.physicalHeight);
    const flatCtx = this.flattenCanvas.getContext('2d');
    if (!flatCtx) throw new Error('Failed to get 2D context for flatten canvas');
    this.flattenCtx = flatCtx;

    // Create the initial background layer.
    const bg = this._createLayer('Background');
    if (options.backgroundImage) {
      bg.ctx.drawImage(options.backgroundImage, 0, 0, this.physicalWidth, this.physicalHeight);
    } else {
      // Default: white background.
      bg.ctx.fillStyle = '#ffffff';
      bg.ctx.fillRect(0, 0, this.physicalWidth, this.physicalHeight);
    }
    this._layers.push(bg);
  }

  // ---------------------------------------------------------------------------
  // Layer accessors
  // ---------------------------------------------------------------------------

  get layers(): readonly PhobosLayer[] {
    return this._layers;
  }

  get activeLayerIndex(): number {
    return this._activeLayerIndex;
  }

  get activeLayer(): PhobosLayer {
    return this._layers[this._activeLayerIndex];
  }

  setActiveLayer(index: number): void {
    if (index < 0 || index >= this._layers.length) {
      throw new RangeError(`Layer index ${index} out of bounds (${this._layers.length} layers)`);
    }
    this._activeLayerIndex = index;
  }

  getLayerById(id: number): PhobosLayer | undefined {
    return this._layers.find(l => l.id === id);
  }

  // ---------------------------------------------------------------------------
  // Layer CRUD
  // ---------------------------------------------------------------------------

  /**
   * Add a new empty layer above the current active layer.
   * Returns the new layer.
   */
  addLayer(options: LayerAddOptions = {}): PhobosLayer {
    const layer = this._createLayer(
      options.name ?? `Layer ${this._layers.length + 1}`,
      options,
    );
    if (options.imageData) {
      layer.ctx.putImageData(options.imageData, 0, 0);
    }

    // Insert above active layer.
    const insertAt = this._activeLayerIndex + 1;
    this._layers.splice(insertAt, 0, layer);
    this._activeLayerIndex = insertAt;
    this.dirty = true;
    return layer;
  }

  /**
   * Remove a layer by id. The active layer shifts down if needed.
   * Throws if removing the last layer — a document must always have one.
   */
  removeLayer(id: number): void {
    if (this._layers.length === 1) {
      throw new Error('Cannot remove the last layer');
    }
    const index = this._layers.findIndex(l => l.id === id);
    if (index === -1) throw new Error(`Layer ${id} not found`);

    this._layers.splice(index, 1);

    // Clamp active index.
    if (this._activeLayerIndex >= this._layers.length) {
      this._activeLayerIndex = this._layers.length - 1;
    }
    this.dirty = true;
  }

  /**
   * Move a layer from its current position to `toIndex`.
   * `toIndex` is the desired final position in the array (0 = bottom).
   */
  moveLayer(id: number, toIndex: number): void {
    const fromIndex = this._layers.findIndex(l => l.id === id);
    if (fromIndex === -1) throw new Error(`Layer ${id} not found`);

    const clampedTo = Math.max(0, Math.min(this._layers.length - 1, toIndex));
    if (fromIndex === clampedTo) return;

    const [layer] = this._layers.splice(fromIndex, 1);
    this._layers.splice(clampedTo, 0, layer);

    // Keep active layer pointing to the same layer (by id, not index).
    const activeId = this._layers[this._activeLayerIndex]?.id;
    if (activeId !== undefined) {
      const newIndex = this._layers.findIndex(l => l.id === activeId);
      if (newIndex !== -1) this._activeLayerIndex = newIndex;
    }
    this.dirty = true;
  }

  // ---------------------------------------------------------------------------
  // Flatten (for export and merge)
  // ---------------------------------------------------------------------------

  /**
   * Composite all visible layers onto the pre-allocated flattenCanvas,
   * respecting opacity and blend mode. Returns the flattenCanvas.
   * The caller must not hold a reference across async boundaries —
   * the canvas is reused on the next call to flatten().
   */
  flatten(): OffscreenCanvas {
    this.flattenCtx.clearRect(0, 0, this.physicalWidth, this.physicalHeight);

    for (const layer of this._layers) {
      if (!layer.visible) continue;
      this.flattenCtx.globalAlpha           = layer.opacity;
      this.flattenCtx.globalCompositeOperation = layer.blendMode as GlobalCompositeOperation;
      this.flattenCtx.drawImage(layer.canvas, 0, 0);
    }

    // Reset context state for the next caller.
    this.flattenCtx.globalAlpha              = 1;
    this.flattenCtx.globalCompositeOperation = 'source-over';
    return this.flattenCanvas;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _createLayer(name: string, options: LayerAddOptions = {}): PhobosLayer {
    const layerOptions: {
      opacity?:   number;
      blendMode?: BlendMode;
      visible?:   boolean;
      locked?:    boolean;
    } = {};
    if (options.opacity   !== undefined) layerOptions.opacity   = options.opacity;
    if (options.blendMode !== undefined) layerOptions.blendMode = options.blendMode;
    if (options.visible   !== undefined) layerOptions.visible   = options.visible;
    if (options.locked    !== undefined) layerOptions.locked    = options.locked;
    return new PhobosLayer(name, this.physicalWidth, this.physicalHeight, layerOptions);
  }
}

// ---------------------------------------------------------------------------
// Coordinate helpers — exported for use by tools
// ---------------------------------------------------------------------------

/**
 * Convert a CSS-pixel coordinate to a physical-pixel coordinate.
 * Always rounds to the nearest integer.
 */
export function cssToPhysical(cssValue: number, dpr: number): number {
  return Math.round(cssValue * dpr);
}

/**
 * Clamp a physical x-coordinate to the document bounds.
 */
export function clampX(x: number, doc: PhobosDocument): number {
  return Math.max(0, Math.min(doc.physicalWidth  - 1, x));
}

/**
 * Clamp a physical y-coordinate to the document bounds.
 */
export function clampY(y: number, doc: PhobosDocument): number {
  return Math.max(0, Math.min(doc.physicalHeight - 1, y));
}

/**
 * Convert a physical (x, y) coordinate to a flat RGBA byte offset.
 * `i` is the index of the R channel; G=i+1, B=i+2, A=i+3.
 */
export function pixelOffset(x: number, y: number, stride: number): number {
  return (y * stride + x) * 4;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function generateId(): string {
  return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
