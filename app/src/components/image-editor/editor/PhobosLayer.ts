import type { BlendMode, BBox } from '../types';

// =============================================================================
// PhobosLayer
//
// One document layer. Owns an OffscreenCanvas (the pixel surface) and its 2D
// context. Has no DOM or renderer dependency — constructable and testable
// without a GL context.
//
// All pixel dimensions are physical (CSS px × dpr). CSS coordinates must be
// converted before reaching this class.
//
// GPU integration:
//   gpuDirty — set true whenever CPU pixels change outside a GPU brush stroke.
//   PhobosGPURenderer.composite() checks this flag and re-uploads via
//   texSubImage2D before compositing. Reset to false after upload.
//
//   During a GPU brush stroke (GPUBrushEngine), stamps go directly into the
//   layer FBO — the CPU canvas is NOT updated mid-stroke. gpuDirty is not
//   used for those writes; GPUBrushEngine calls syncLayerFBOToTexture()
//   directly. At pointerUp, readLayerFBOAsync() syncs GPU→CPU and the
//   resulting LiveStrokeCommand owns the pixel delta for undo.
// =============================================================================

/** Monotonically increasing counter — never reused within a session. */
let nextLayerId = 0;

export class PhobosLayer {
  readonly id:             number;
  readonly physicalWidth:  number;
  readonly physicalHeight: number;

  canvas:    OffscreenCanvas;
  ctx:       OffscreenCanvasRenderingContext2D;

  name:      string;
  opacity:   number;    // 0–1
  blendMode: BlendMode;
  visible:   boolean;
  locked:    boolean;

  /**
   * True when the CPU canvas has pixel data the GPU texture does not yet
   * reflect. PhobosGPURenderer uploads and clears this flag before each
   * composite pass. Initialised true so the first frame always uploads.
   */
  gpuDirty: boolean = true;

  constructor(
    name:           string,
    physicalWidth:  number,
    physicalHeight: number,
    options: {
      opacity?:   number;
      blendMode?: BlendMode;
      visible?:   boolean;
      locked?:    boolean;
    } = {},
  ) {
    if (physicalWidth  < 1) throw new RangeError('Layer width must be >= 1');
    if (physicalHeight < 1) throw new RangeError('Layer height must be >= 1');

    this.id             = nextLayerId++;
    this.physicalWidth  = physicalWidth;
    this.physicalHeight = physicalHeight;
    this.name           = name;
    this.opacity        = options.opacity   ?? 1;
    this.blendMode      = options.blendMode ?? 'normal';
    this.visible        = options.visible   ?? true;
    this.locked         = options.locked    ?? false;

    this.canvas = new OffscreenCanvas(physicalWidth, physicalHeight);
    const ctx   = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error(`Failed to get 2D context for layer "${name}"`);
    this.ctx = ctx;
  }

  // ---------------------------------------------------------------------------
  // Pixel access
  // ---------------------------------------------------------------------------

  /**
   * Return a copy of this layer's pixels within `bbox`, or the full canvas
   * if bbox is omitted. Used by RasterCommand to snapshot before a stroke.
   * Allocates a new Uint8ClampedArray every call — callers hold the result
   * for the lifetime of the command.
   */
  snapshot(bbox?: BBox): Uint8ClampedArray {
    const x = bbox?.x ?? 0;
    const y = bbox?.y ?? 0;
    const w = bbox?.w ?? this.physicalWidth;
    const h = bbox?.h ?? this.physicalHeight;
    return this.ctx.getImageData(x, y, w, h).data;
  }

  /**
   * Write pixel data back into the canvas. Used by undo/redo commands.
   *
   * When `bbox` is omitted, `data` must be `physW*physH*4` bytes and covers
   * the full canvas. This is the primary path — all brush stroke commands
   * (GPU and CPU) now use full-layer snapshots.
   *
   * `bbox` is retained for other raster commands (fill, erase, etc.) that
   * still snapshot sub-regions for efficiency.
   *
   * No allocation — writes directly via putImageData.
   * Sets gpuDirty so the renderer re-uploads on the next composite.
   */
  restore(data: Uint8ClampedArray, bbox?: BBox): void {
    const x = bbox?.x ?? 0;
    const y = bbox?.y ?? 0;
    const w = bbox?.w ?? this.physicalWidth;
    const h = bbox?.h ?? this.physicalHeight;
    // ImageData requires an ArrayBuffer-backed Uint8ClampedArray (not SharedArrayBuffer).
    // Copy the view slice into a plain ArrayBuffer unconditionally — ImageData owns it.
    const pixels = new Uint8ClampedArray(data.byteLength);
    pixels.set(data);
    const imageData = new ImageData(pixels, w, h);
    this.ctx.putImageData(imageData, x, y);
    this.gpuDirty = true;
  }

  /**
   * Return the ImageData for the specified region (full canvas if omitted).
   * Callers must call putImageData to commit changes and set gpuDirty.
   */
  getImageData(bbox?: BBox): ImageData {
    const x = bbox?.x ?? 0;
    const y = bbox?.y ?? 0;
    const w = bbox?.w ?? this.physicalWidth;
    const h = bbox?.h ?? this.physicalHeight;
    return this.ctx.getImageData(x, y, w, h);
  }

  /**
   * Commit ImageData back to the canvas and mark the GPU texture stale.
   */
  putImageData(imageData: ImageData, bbox?: BBox): void {
    const x = bbox?.x ?? 0;
    const y = bbox?.y ?? 0;
    this.ctx.putImageData(imageData, x, y);
    this.gpuDirty = true;
  }

  // ---------------------------------------------------------------------------
  // GPU dirty signal
  // ---------------------------------------------------------------------------

  /**
   * Mark this layer's GPU texture as stale.
   *
   * Called by tools after any CPU pixel write (drawImage, putImageData, etc.).
   * PhobosGPURenderer.composite() will re-upload from the CPU canvas before
   * the next composite pass and clear the flag.
   *
   * Named markDirty() for call-site compatibility during the GPU migration.
   * Tools call this exactly as they called the old Konva-driven version.
   */
  markDirty(): void {
    this.gpuDirty = true;
  }

  // ---------------------------------------------------------------------------
  // Resize
  // ---------------------------------------------------------------------------

  /**
   * Reallocate the canvas at new physical dimensions.
   * Called only by ResizeDocumentCommand and CropToSelectionCommand.
   * Existing pixels within the overlap region are preserved.
   * Sets gpuDirty — the renderer must re-upload and reallocate its texture.
   */
  resizeTo(newWidth: number, newHeight: number): void {
    const next    = new OffscreenCanvas(newWidth, newHeight);
    const nextCtx = next.getContext('2d', { willReadFrequently: true });
    if (!nextCtx) throw new Error(`Failed to get 2D context on resize for layer "${this.name}"`);

    nextCtx.drawImage(this.canvas, 0, 0);

    this.canvas   = next;
    this.ctx      = nextCtx;
    this.gpuDirty = true;
  }
}