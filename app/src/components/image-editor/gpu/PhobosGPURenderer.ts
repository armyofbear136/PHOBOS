import type { PhobosLayer }    from '../editor/PhobosLayer';
import type { PhobosDocument } from '../editor/PhobosDocument';
import type { BlendMode }      from '../types';
import { COMPOSITE_VERT }      from './shaders/composite.vert';
import { COMPOSITE_FRAG }      from './shaders/composite.frag';
import { BLIT_FRAG }           from './shaders/blit.frag';

// =============================================================================
// PhobosGPURenderer
//
// Owns the WebGL2 context, all GPU resources, and the compositing pipeline.
// One instance per editor canvas mount. Destroyed on unmount.
//
// Responsibilities:
//   - Context acquisition, loss detection, and restore handling
//   - Per-layer RGBA8 texture allocation via texStorage2D (immutable, preferred)
//   - Per-layer FBO for direct brush stamp draws (used by GPUBrushEngine)
//   - Ping-pong composite FBO pair for correct layer accumulation (no feedback loop)
//   - Checkerboard background rendered analytically in fragment shader
//   - Final source-over blit to screen with pan/zoom mat3 transform
//   - Dirty-layer upload via texSubImage2D from OffscreenCanvas
//   - Async GPU→CPU readback via PIXEL_PACK_BUFFER + fenceSync (no pipeline stall)
//
// Composite algorithm — ping-pong FBO pair:
//   The naive approach of reading from and writing to the same texture is a GL
//   feedback loop (undefined behaviour). Instead we allocate two FBOs whose
//   textures alternate as source and destination each pass:
//
//     Before pass 0: clear both ping-pong textures to (0,0,0,0)
//     Pass 0: read readTex (clear), write into writeFBO → swap
//     Pass 1: read readTex (result of pass 0), write into writeFBO → swap
//     ...
//     After N layers: readTex holds the final composite
//
// Permanent wire contracts (must not change across sessions):
//   Texture unit 0  →  u_layerTex      (source layer)
//   Texture unit 1  →  u_compositeTex  (destination accumulator)
//
// Blend mode integer index: see BLEND_MODE_INDEX below (matches composite.frag.ts).
// =============================================================================

// ---------------------------------------------------------------------------
// Blend mode index — permanent contract with composite.frag.ts
// ---------------------------------------------------------------------------

export const BLEND_MODE_INDEX: Record<BlendMode, number> = {
  'normal':      0,
  'multiply':    1,
  'screen':      2,
  'overlay':     3,
  'darken':      4,
  'lighten':     5,
  'color-dodge': 6,
  'color-burn':  7,
  'hard-light':  8,
  'soft-light':  9,
  'difference':  10,
  'exclusion':   11,
  'hue':         12,
  'saturation':  13,
  'color':       14,
  'luminosity':  15,
} as const;

// ---------------------------------------------------------------------------
// Uniform location structs — queried once at link time, never per frame
// ---------------------------------------------------------------------------

interface CompositeUniforms {
  layerTex:     WebGLUniformLocation;
  compositeTex: WebGLUniformLocation;
  opacity:      WebGLUniformLocation;
  blendMode:    WebGLUniformLocation;
}


interface BlitUniforms {
  tex:          WebGLUniformLocation;
  screenToDoc:  WebGLUniformLocation;
  resolution:   WebGLUniformLocation;
}

// ---------------------------------------------------------------------------
// Internal FBO types
// ---------------------------------------------------------------------------

/** Single-texture FBO. Used for per-layer stamp FBOs (GPUBrushEngine target). */
interface LayerFBO {
  fbo:     WebGLFramebuffer;
  texture: WebGLTexture;
  width:   number;
  height:  number;
}

/**
 * Ping-pong FBO pair for the composite accumulator.
 *
 * Two FBOs, two textures. Each composite pass reads readTex and writes into
 * writeFBO. After each draw, swap() advances the pair. This avoids the GL
 * feedback loop that arises from sampling a texture while it is the current
 * colour attachment.
 */
class PingPongFBO {
  readonly fboA:   WebGLFramebuffer;
  readonly fboB:   WebGLFramebuffer;
  readonly texA:   WebGLTexture;
  readonly texB:   WebGLTexture;
  readonly width:  number;
  readonly height: number;
  private _readIsA: boolean = true;

  constructor(
    fboA: WebGLFramebuffer, texA: WebGLTexture,
    fboB: WebGLFramebuffer, texB: WebGLTexture,
    width: number, height: number,
  ) {
    this.fboA = fboA; this.texA = texA;
    this.fboB = fboB; this.texB = texB;
    this.width = width; this.height = height;
  }

  /** Texture containing the most recently committed composite result. */
  get readTex():  WebGLTexture    { return this._readIsA ? this.texA : this.texB; }

  /** FBO to render the next composite pass into. */
  get writeFBO(): WebGLFramebuffer { return this._readIsA ? this.fboB : this.fboA; }

  /** Advance roles after a draw. */
  swap(): void { this._readIsA = !this._readIsA; }

  /** Reset to initial state (readTex = texA). Call before each composite frame. */
  reset(): void { this._readIsA = true; }
}

// ---------------------------------------------------------------------------
// Async readback slot
// ---------------------------------------------------------------------------

interface ReadbackSlot {
  pbo:     WebGLBuffer;
  sync:    WebGLSync;
  byteLen: number;
  w:       number;
  h:       number;
  resolve: (data: Uint8ClampedArray) => void;
  reject:  (err: Error) => void;
  timerId: ReturnType<typeof setTimeout> | null;
}

// ---------------------------------------------------------------------------
// Pre-allocated invalidation attachment list — avoids a transient array per call
// ---------------------------------------------------------------------------

const INVALIDATE_COLOR_ATTACHMENT: GLenum[] = [
  WebGL2RenderingContext.COLOR_ATTACHMENT0,
];

// =============================================================================
// PhobosGPURenderer
// =============================================================================

export class PhobosGPURenderer {
  // --------------------------------------------------------------------------
  // Public
  // --------------------------------------------------------------------------

  /** True when the GL context is acquired and usable. */
  get isReady(): boolean { return this._gl !== null && !this._lost; }

  readonly canvas: HTMLCanvasElement;

  // --------------------------------------------------------------------------
  // GL state
  // --------------------------------------------------------------------------

  private _gl:      WebGL2RenderingContext | null = null;
  private _lost:    boolean = false;
  private _lostExt: WEBGL_lose_context | null = null;

  private _compositeProg: WebGLProgram | null = null;
  private _blitProg:      WebGLProgram | null = null;
  private _compU:         CompositeUniforms | null = null;
  private _blitU:         BlitUniforms      | null = null;

  // VAO for the fullscreen triangle (gl_VertexID-driven, no per-vertex attributes)
  private _quadVAO: WebGLVertexArrayObject | null = null;

  // 1×1 transparent texture used as Cb=0 sentinel in _copyTextureToLayerFBO.
  // Ensures u_compositeTex samples as (0,0,0,0) rather than WebGL2's default
  // incomplete-texture value of (0,0,0,1).
  private _nullTex: WebGLTexture | null = null;

  // Per-layer GPU resources. Layer id is monotonic and never reused.
  private _layerTextures: Map<number, WebGLTexture> = new Map();
  private _layerFBOs:     Map<number, LayerFBO>     = new Map();
  // Per-layer read FBOs wrapping the display texture.
  // Used as READ_FRAMEBUFFER source in blitFramebuffer inside primeLayerFBOFromCPU.
  // One per layer; allocated alongside the stamp FBO.
  private _layerReadFBOs: Map<number, WebGLFramebuffer> = new Map();

  // Composite accumulator ping-pong pair (full canvas physical size)
  private _pingPong: PingPongFBO | null = null;


  // Physical canvas dimensions (backing store pixels, not CSS pixels)
  private _physW: number = 0;
  private _physH: number = 0;
  private _dpr:   number = 1;

  // Pre-allocated scratch mat3 for checkerboard inverse transform
  private readonly _mat3: Float32Array = new Float32Array(9);

  // Async readback state (async path only — still used by readLayerFBOAsync)
  private _readback:    ReadbackSlot | null = null;

  // Full-layer synchronous readback buffer.
  // Allocated once at init to physW*physH*4 bytes. Grown on document resize only.
  // readLayerFullSync() writes into this and returns a copy — never a view —
  // so the caller owns a stable buffer the renderer will not mutate.
  private _fullReadbackBuf: Uint8ClampedArray = new Uint8ClampedArray(0);

  // Document ref retained for context restore
  private _doc: PhobosDocument | null = null;

  // Bound handlers retained for removeEventListener
  private readonly _onLost:     (e: Event) => void;
  private readonly _onRestored: (e: Event) => void;

  // --------------------------------------------------------------------------
  // Constructor
  // --------------------------------------------------------------------------

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    this._onLost = (e: Event) => {
      e.preventDefault(); // required: allows the context to be restored
      this._handleContextLost();
    };
    this._onRestored = () => { this._handleContextRestored(); };

    canvas.addEventListener('webglcontextlost',     this._onLost,     false);
    canvas.addEventListener('webglcontextrestored', this._onRestored, false);
  }

  // --------------------------------------------------------------------------
  // Public: init
  // --------------------------------------------------------------------------

  /**
   * Acquire a WebGL2 context and initialise all GPU resources.
   * Returns true on success. If false, the caller must stay on the CPU path.
   */
  init(doc: PhobosDocument): boolean {
    this._doc   = doc;
    this._physW = doc.physicalWidth;
    this._physH = doc.physicalHeight;
    this._dpr   = doc.dpr;

    const gl = this.canvas.getContext('webgl2', {
      // alpha: true — we render a fully-opaque checkerboard background ourselves,
      // so every pixel written to the canvas has α=1. This avoids the platform
      // perf cost of alpha:false while producing the same compositor result.
      alpha:                 true,
      premultipliedAlpha:    false,  // We composite manually; no driver premultiplication
      antialias:             false,  // 2D pixel editor — MSAA adds nothing, wastes memory
      depth:                 false,
      stencil:               false,
      preserveDrawingBuffer: false,  // Let browser discard between frames (faster)
    }) as WebGL2RenderingContext | null;

    if (!gl) return false;

    this._gl      = gl;
    this._lost    = false;
    this._lostExt = gl.getExtension('WEBGL_lose_context');

    if (!this._initGL(doc)) {
      this._gl = null;
      return false;
    }
    return true;
  }

  // --------------------------------------------------------------------------
  // Public: layer sync
  // --------------------------------------------------------------------------

  /**
   * Reconcile GPU resources with the current layer stack.
   * Allocates textures/FBOs for new layers; eagerly deletes for removed layers.
   * Call after any layer add, remove, or reorder.
   */
  syncLayers(doc: PhobosDocument): void {
    const gl = this._gl;
    if (!gl || this._lost) return;

    const activeIds = new Set<number>(doc.layers.map(l => l.id));

    // Eagerly delete GPU resources for removed layers (per MDN: delete eagerly)
    for (const [id, tex] of this._layerTextures) {
      if (!activeIds.has(id)) {
        gl.deleteTexture(tex);
        this._layerTextures.delete(id);
      }
    }
    for (const [id, fbo] of this._layerFBOs) {
      if (!activeIds.has(id)) {
        this._destroyLayerFBO(gl, fbo);
        this._layerFBOs.delete(id);
      }
    }
    for (const [id, rfbo] of this._layerReadFBOs) {
      if (!activeIds.has(id)) {
        gl.deleteFramebuffer(rfbo);
        this._layerReadFBOs.delete(id);
      }
    }

    // Allocate for new layers
    for (const layer of doc.layers) {
      if (!this._layerTextures.has(layer.id)) {
        const tex = this._allocLayerTexture(gl, layer.physicalWidth, layer.physicalHeight);
        if (tex) {
          this._layerTextures.set(layer.id, tex);
          this._uploadCanvas(gl, layer.canvas, tex, layer.physicalWidth, layer.physicalHeight);
        }
      }
      if (!this._layerFBOs.has(layer.id)) {
        const fbo = this._allocLayerFBO(gl, layer.physicalWidth, layer.physicalHeight);
        if (fbo) {
          this._layerFBOs.set(layer.id, fbo);
          // Also allocate the read FBO wrapping the display texture for blitFramebuffer.
          const tex = this._layerTextures.get(layer.id);
          if (tex) {
            const rfbo = this._allocReadFBO(gl, tex);
            if (rfbo) this._layerReadFBOs.set(layer.id, rfbo);
            // Prime the stamp FBO from the display texture via blitFramebuffer.
            // rfbo may be null on context loss; fall back to _copyTextureToLayerFBO.
            if (rfbo) {
              const w = fbo.width;
              const h = fbo.height;
              gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rfbo);
              gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo.fbo);
              gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
              gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
              gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
            } else {
              this._copyTextureToLayerFBO(gl, tex, fbo);
            }
          }
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Public: resize
  // --------------------------------------------------------------------------

  /**
   * Reallocate all GPU resources for new document physical dimensions.
   * Called by document resize / crop operations only.
   */
  resize(doc: PhobosDocument): void {
    const gl = this._gl;
    if (!gl || this._lost) return;

    this._physW = doc.physicalWidth;
    this._physH = doc.physicalHeight;
    this._dpr   = doc.dpr;

    if (this._pingPong) { this._destroyPingPong(gl, this._pingPong); this._pingPong = null; }
    this._pingPong = this._allocPingPong(gl, this._physW, this._physH);

    // Grow full-layer readback buffer to new document size if needed.
    const fullByteLen = this._physW * this._physH * 4;
    if (fullByteLen > this._fullReadbackBuf.byteLength) {
      this._fullReadbackBuf = new Uint8ClampedArray(fullByteLen);
    }

    for (const tex of this._layerTextures.values()) gl.deleteTexture(tex);
    for (const fbo of this._layerFBOs.values())     this._destroyLayerFBO(gl, fbo);
    for (const rfbo of this._layerReadFBOs.values()) gl.deleteFramebuffer(rfbo);
    this._layerTextures  = new Map();
    this._layerFBOs      = new Map();
    this._layerReadFBOs  = new Map();

    this.syncLayers(doc);
  }

  // --------------------------------------------------------------------------
  // Public: composite (called once per frame or after each stamp flush)
  // --------------------------------------------------------------------------

  /**
   * Upload dirty CPU layers, composite all visible layers, blit to screen.
   *
   * transform — 6-element pan/zoom description matching Konva Stage convention:
   *   [scaleX, 0, 0, scaleY, panX, panY]
   *   scaleX == scaleY (uniform zoom), panX/panY in CSS pixels.
   */
  composite(
    doc: PhobosDocument,
    transform: readonly [number, number, number, number, number, number],
  ): void {
    const gl = this._gl;
    if (!gl || this._lost || !this._pingPong) return;

    // 1. Upload any CPU layers that changed since the last frame
    for (const layer of doc.layers) {
      if (!layer.visible || !layer.gpuDirty) continue;
      const tex = this._layerTextures.get(layer.id);
      if (tex) {
        this._uploadCanvas(gl, layer.canvas, tex, layer.physicalWidth, layer.physicalHeight);
        layer.gpuDirty = false;
      }
    }

    // 2. Composite the layer stack into the ping-pong accumulator
    this._compositeStack(gl, doc);

    // 3. Blit composited result + checkerboard to screen (combined pass)
    this._blitToScreen(gl, transform);

    // 5. Invalidate the ping-pong write target — its contents are no longer needed.
    //    On mobile tiled GPUs this avoids an expensive framebuffer writeback to DRAM.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._pingPong.writeFBO);
    gl.invalidateFramebuffer(gl.FRAMEBUFFER, INVALIDATE_COLOR_ATTACHMENT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // --------------------------------------------------------------------------
  // Public: layer FBO access (for GPUBrushEngine)
  // --------------------------------------------------------------------------

  /**
   * Return the GL FBO handle and dimensions for a layer.
   * GPUBrushEngine binds this directly to draw brush stamps.
   */
  getLayerFBO(layerId: number): { fbo: WebGLFramebuffer; w: number; h: number } | null {
    const f = this._layerFBOs.get(layerId);
    return f ? { fbo: f.fbo, w: f.width, h: f.height } : null;
  }

  /**
   * Copy a layer FBO's current contents into its display texture.
   * Called by GPUBrushEngine after each stamp flush so composite() picks up
   * the new brush data without a CPU readback.
   * GPU→GPU copy via copyTexSubImage2D — zero CPU involvement.
   */
  syncLayerFBOToTexture(layerId: number): void {
    const gl = this._gl;
    if (!gl || this._lost) return;
    const fbo = this._layerFBOs.get(layerId);
    const tex = this._layerTextures.get(layerId);
    if (!fbo || !tex) return;

    // Both the FBO and the texture share GL bottom-left Y origin.
    // copyTexSubImage2D reads from the current READ_FRAMEBUFFER into the texture.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo.fbo);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, fbo.width, fbo.height);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  }

  /**
   * Re-prime a layer FBO from its CPU canvas.
   * Called by GPUBrushEngine.beginStroke() to ensure the FBO is clean
   * before a new stroke — necessary after a cancelled stroke left stale
   * GPU stamp data in the FBO.
   *
   * Flow:
   *   1. If gpuDirty, upload CPU canvas to the layer display texture.
   *   2. Use blitFramebuffer to copy the display texture FBO → layer stamp FBO.
   *      This is a hardware GPU→GPU blit (no shader dispatch, no uniform setup).
   *
   * blitFramebuffer requires both source and destination to be FBO-attached.
   * The display texture is attached to its own per-layer read FBO allocated
   * alongside the layer stamp FBO in _allocLayerFBO. We bind it as READ_FRAMEBUFFER
   * and the stamp FBO as DRAW_FRAMEBUFFER, then blit. No intermediate draw call.
   */
  primeLayerFBOFromCPU(layer: { id: number; canvas: OffscreenCanvas; physicalWidth: number; physicalHeight: number; gpuDirty: boolean }): void {
    const gl = this._gl;
    if (!gl || this._lost) return;

    const stampFBO  = this._layerFBOs.get(layer.id);
    const tex       = this._layerTextures.get(layer.id);
    const readFBO   = this._layerReadFBOs.get(layer.id);
    if (!stampFBO || !tex || !readFBO) return;

    // Re-upload CPU canvas to the display texture if it has changed.
    if (layer.gpuDirty) {
      this._uploadCanvas(gl, layer.canvas, tex, layer.physicalWidth, layer.physicalHeight);
      layer.gpuDirty = false;
    }

    // Hardware blit: display texture FBO → stamp FBO.
    // READ_FRAMEBUFFER = readFBO (wraps display texture), DRAW_FRAMEBUFFER = stampFBO.
    // gl.NEAREST: pixel-exact copy, no interpolation.
    const w = stampFBO.width;
    const h = stampFBO.height;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFBO);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, stampFBO.fbo);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  // --------------------------------------------------------------------------
  // Public: async readback
  // --------------------------------------------------------------------------

  /**
   * Synchronously read back the entire layer FBO as RGBA8 pixels.
   *
   * Returns a new Uint8ClampedArray of physW*physH*4 bytes with top-left origin
   * (matching OffscreenCanvas convention). The returned buffer is owned by the
   * caller — the renderer does not retain a reference to it.
   *
   * Y convention: the stamp FBO is primed via blitFramebuffer from the display
   * texture. The display texture has image-top at GL row 0 (UNPACK_FLIP_Y=false
   * with OffscreenCanvas source maps canvas row 0 top → GL row 0). The blit
   * preserves this, so readPixels(0,0,w,h) already returns rows top→bottom.
   * No Y-flip is applied here.
   *
   * Safe to call only when the RAF composite loop has been stopped.
   * Returns null only on GL context loss.
   */
  readLayerFullSync(layerId: number): Uint8ClampedArray | null {
    const gl = this._gl;
    if (!gl || this._lost) return null;

    const fbo = this._layerFBOs.get(layerId);
    if (!fbo) return null;

    const w       = fbo.width;
    const h       = fbo.height;
    const byteLen = w * h * 4;

    // Grow pre-allocated buffer if the document has been resized upward.
    if (byteLen > this._fullReadbackBuf.byteLength) {
      this._fullReadbackBuf = new Uint8ClampedArray(byteLen);
    }

    // Drain the GPU pipeline before reading.
    // Safe here: the RAF loop is stopped at pointerUp before this call.
    gl.finish();

    // Read the full FBO.
    // The stamp FBO is primed via blitFramebuffer from the display texture.
    // The display texture has image-top at GL row 0 (canvas→texSubImage2D with
    // UNPACK_FLIP_Y=false maps canvas row 0 top → GL row 0). The blit preserves
    // this orientation, so the stamp FBO also has image-top at GL row 0.
    // readPixels(0, 0, w, h) returns rows GL 0→h = image top→bottom.
    // No Y-flip needed — the buffer is already top-left origin.
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo.fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this._fullReadbackBuf);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);

    // Return a copy — the caller owns this buffer independently of _fullReadbackBuf.
    const out = new Uint8ClampedArray(byteLen);
    out.set(this._fullReadbackBuf);
    return out;
  }

  /**
   * Asynchronously read back a region of a layer FBO as RGBA8 pixels.
   *
   * Implementation:
   *   1. Bind a PIXEL_PACK_BUFFER and issue readPixels() — GPU queues the DMA.
   *   2. Insert a fenceSync + flush — GPU will signal when the DMA completes.
   *   3. Poll clientWaitSync() every macrotask until signalled — no stall.
   *   4. Call getBufferSubData() into a pre-allocated CPU buffer.
   *   5. Y-flip in-place (GL bottom-left → canvas top-left).
   *   6. Resolve the Promise.
   *
   * At most one readback is in flight. A new call cancels any pending one —
   * safe because readback is only triggered at pointerUp / stroke cancel.
   *
   * The returned Uint8ClampedArray has top-left origin (matches OffscreenCanvas).
   */
  readLayerFBOAsync(
    layerId: number,
    x: number, y: number, w: number, h: number,
  ): Promise<Uint8ClampedArray> {
    return new Promise<Uint8ClampedArray>((resolve, reject) => {
      const gl = this._gl;
      if (!gl || this._lost) { reject(new Error('GL context unavailable')); return; }

      const fbo = this._layerFBOs.get(layerId);
      if (!fbo) { reject(new Error(`No FBO for layer ${layerId}`)); return; }

      if (this._readback) this._cancelReadback(gl);

      const byteLen = w * h * 4;

      const pbo = gl.createBuffer();
      if (!pbo) { reject(new Error('createBuffer failed')); return; }

      // Allocate PBO storage — STREAM_READ signals the driver this is a readback buffer
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, byteLen, gl.STREAM_READ);

      // readPixels with a PBO bound queues a GPU→PBO DMA transfer (non-blocking).
      // Y-coord: GL origin is bottom-left; convert our top-left (x, y) bbox.
      const glY = fbo.height - y - h;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo.fbo);
      gl.readPixels(x, glY, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

      // fenceSync marks the point after readPixels in the command stream.
      // clientWaitSync will signal when the GPU has completed all prior commands.
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!sync) {
        gl.deleteBuffer(pbo);
        reject(new Error('fenceSync failed'));
        return;
      }
      // flush() is required before polling clientWaitSync (MDN requirement).
      // Without it, the fence may never be submitted to the GPU command queue.
      gl.flush();

      const slot: ReadbackSlot = { pbo, sync, byteLen, w, h, resolve, reject, timerId: null };
      this._readback = slot;
      this._pollFence(gl, slot);
    });
  }

  // --------------------------------------------------------------------------
  // Public: destroy
  // --------------------------------------------------------------------------

  /**
   * Release all GPU resources and detach event listeners.
   * Call on React component unmount.
   */
  destroy(): void {
    const gl = this._gl;
    if (gl) {
      if (this._readback) this._cancelReadback(gl);
      this._destroyAllGPU(gl);
      // Eagerly lose the context to return VRAM to the OS immediately.
      // Do not wait for GC.
      this._lostExt?.loseContext();
    }
    this.canvas.removeEventListener('webglcontextlost',     this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    this._gl  = null;
    this._doc = null;
  }

  // --------------------------------------------------------------------------
  // Context loss / restore
  // --------------------------------------------------------------------------

  private _handleContextLost(): void {
    this._lost = true;

    // Cancel in-flight readback — sync object is invalid after context loss
    if (this._readback) {
      if (this._readback.timerId !== null) clearTimeout(this._readback.timerId);
      this._readback.reject(new Error('WebGL context lost'));
      this._readback = null;
    }

    // Null all GL object refs — they are invalid and must not be used
    this._compositeProg = null;
    this._blitProg      = null;
    this._compU         = null;
    this._blitU         = null;
    this._quadVAO       = null;
    this._nullTex       = null;
    this._pingPong      = null;
    this._layerTextures = new Map();
    this._layerFBOs     = new Map();
    this._layerReadFBOs = new Map();
  }

  private _handleContextRestored(): void {
    this._lost = false;
    // After restore the context object is the same but all GL resources are gone.
    // Re-query it and reinitialise everything from the CPU canvases.
    const gl = this.canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    if (!gl) return;
    this._gl      = gl;
    this._lostExt = gl.getExtension('WEBGL_lose_context');
    if (this._doc) this._initGL(this._doc);
  }

  // --------------------------------------------------------------------------
  // GL initialisation
  // --------------------------------------------------------------------------

  private _initGL(doc: PhobosDocument): boolean {
    const gl = this._gl!;

    // Pixel store state — set once, never changed.
    // UNPACK_PREMULTIPLY_ALPHA_WEBGL = false: OffscreenCanvas data is
    // non-premultiplied; we handle premultiplication entirely in the shader.
    // UNPACK_FLIP_Y_WEBGL = false: we manage Y orientation explicitly.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,            false);

    // Submit all shader compiles before querying any link status.
    // Per MDN best practices: browsers can compile on background threads when
    // compileShader calls are batched before any getProgramParameter query.
    this._compositeProg = this._buildProgram(gl, COMPOSITE_VERT, COMPOSITE_FRAG);
    this._blitProg      = this._buildProgram(gl, COMPOSITE_VERT, BLIT_FRAG);

    if (!this._compositeProg || !this._blitProg) return false;

    this._compU  = this._getCompositeUniforms(gl, this._compositeProg);
    this._blitU  = this._getBlitUniforms(gl, this._blitProg);
    if (!this._compU || !this._blitU) return false;

    // Bind sampler uniforms once at program init — these never change.
    // Texture unit 0 → u_layerTex, texture unit 1 → u_compositeTex.
    gl.useProgram(this._compositeProg);
    gl.uniform1i(this._compU.layerTex,     0);
    gl.uniform1i(this._compU.compositeTex, 1);
    gl.useProgram(null);

    // Fullscreen triangle VAO.
    // The composite.vert shader uses only gl_VertexID — no VBO attributes.
    // We create a VAO anyway to satisfy the WebGL requirement that vertex array
    // state be managed via VAOs, and to avoid potential browser emulation costs
    // on desktop OpenGL (attrib 0 emulation). No vertexAttribPointer calls needed.
    const vao = gl.createVertexArray();
    if (!vao) return false;
    this._quadVAO = vao;

    // 1×1 transparent texture — used as Cb=0 sentinel in the blit-to-screen pass.
    // Allocated once, never written to again.
    const nullTex = gl.createTexture();
    if (!nullTex) return false;
    gl.bindTexture(gl.TEXTURE_2D, nullTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 1, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this._nullTex = nullTex;

    // Ping-pong composite FBO pair
    this._pingPong = this._allocPingPong(gl, this._physW, this._physH);
    if (!this._pingPong) return false;

    // Pre-allocate full-layer readback buffer at document size.
    // Grown on resize; never shrunk.
    const fullByteLen = this._physW * this._physH * 4;
    if (fullByteLen > this._fullReadbackBuf.byteLength) {
      this._fullReadbackBuf = new Uint8ClampedArray(fullByteLen);
    }

    // Allocate GPU resources for all existing layers
    this.syncLayers(doc);
    return true;
  }

  // --------------------------------------------------------------------------
  // Composite pass
  // --------------------------------------------------------------------------

  private _compositeStack(gl: WebGL2RenderingContext, doc: PhobosDocument): void {
    const prog  = this._compositeProg;
    const compU = this._compU;
    const pp    = this._pingPong;
    if (!prog || !compU || !pp || !this._quadVAO) return;

    // Reset ping-pong: readTex = texA (was cleared at allocation / previous frame end)
    pp.reset();

    // Clear the current write target so the first pass composites onto (0,0,0,0).
    // We clear writeFBO (texB at reset state). After the first layer's draw we swap,
    // making texB the readTex for the second layer. texA (readTex for the first pass)
    // was already cleared (either at allocation or by the invalidation at frame end —
    // but invalidation is a hint, not a guarantee). Clear both to be safe.
    gl.bindFramebuffer(gl.FRAMEBUFFER, pp.fboA);
    gl.viewport(0, 0, pp.width, pp.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, pp.fboB);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // pp.reset() ensures readTex = texA, writeFBO = fboB.
    // texA is now clear → first layer composites against (0,0,0,0) correctly.

    gl.useProgram(prog);
    gl.bindVertexArray(this._quadVAO);
    // Disable GL blending — our shader implements the W3C composite formula explicitly.
    // Enabling GL blending here would double-apply alpha and corrupt the result.
    gl.disable(gl.BLEND);

    for (const layer of doc.layers) {
      if (!layer.visible) continue;
      const tex = this._layerTextures.get(layer.id);
      if (!tex) continue;

      gl.bindFramebuffer(gl.FRAMEBUFFER, pp.writeFBO);
      gl.viewport(0, 0, pp.width, pp.height);

      // Unit 0: source layer (Cs in the W3C formula)
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);

      // Unit 1: current composite accumulator (Cb / destination)
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, pp.readTex);

      gl.uniform1f(compU.opacity,   layer.opacity);
      gl.uniform1i(compU.blendMode, BLEND_MODE_INDEX[layer.blendMode]);

      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Advance: the FBO we just wrote becomes the new readTex next iteration.
      // The old readTex becomes the new writeFBO — safe to overwrite next pass.
      pp.swap();
    }

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // After the loop, pp.readTex holds the fully composited result.
  }


  // --------------------------------------------------------------------------
  // Final blit to screen
  // --------------------------------------------------------------------------

  private _blitToScreen(
    gl: WebGL2RenderingContext,
    transform: readonly [number, number, number, number, number, number],
  ): void {
    const prog   = this._blitProg;
    const blitU  = this._blitU;
    const pp     = this._pingPong;
    if (!prog || !blitU || !pp || !this._quadVAO) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

    // Clear to transparent. The container CSS background-color fills the area
    // outside the document. The blit shader discards those fragments, leaving
    // them at (0,0,0,0) so the CSS bg colour shows through.
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // No GL blending needed — the blit shader outputs alpha=1 within the
    // document (checker+composite done in shader). Discarded pixels outside
    // remain at the cleared (0,0,0,0).
    gl.disable(gl.BLEND);

    gl.useProgram(prog);
    gl.bindVertexArray(this._quadVAO);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, pp.readTex);
    gl.uniform1i(blitU.tex, 0);

    gl.uniform2f(blitU.resolution, gl.drawingBufferWidth, gl.drawingBufferHeight);

    // Build screen physical px → doc UV mat3 (column-major for GLSL).
    // docUV = screenPx * sx + tx
    // sx = 1/(scale * physW),  tx = -panX * dpr * sx
    const scale = transform[0];
    const panX  = transform[4];
    const panY  = transform[5];
    const sx    = 1 / (scale * this._physW);
    const sy    = 1 / (scale * this._physH);
    const tx    = -panX * this._dpr * sx;
    const ty    = -panY * this._dpr * sy;
    const m     = this._mat3;
    m[0] = sx;  m[3] = 0;   m[6] = tx;
    m[1] = 0;   m[4] = sy;  m[7] = ty;
    m[2] = 0;   m[5] = 0;   m[8] = 1;
    gl.uniformMatrix3fv(blitU.screenToDoc, false, m);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindVertexArray(null);
  }

  // --------------------------------------------------------------------------
  // Async readback implementation
  // --------------------------------------------------------------------------

  private _pollFence(gl: WebGL2RenderingContext, slot: ReadbackSlot): void {
    // clientWaitSync with timeout=0 is a non-blocking poll.
    // Returns CONDITION_SATISFIED or ALREADY_SIGNALED when GPU is done.
    const status = gl.clientWaitSync(slot.sync, 0, 0);

    if (status === gl.WAIT_FAILED) {
      this._cleanupSlot(gl, slot);
      slot.reject(new Error('clientWaitSync failed'));
      return;
    }

    if (status === gl.TIMEOUT_EXPIRED) {
      // Not ready yet. Yield to the event loop and poll again.
      slot.timerId = setTimeout(() => this._pollFence(gl, slot), 0);
      return;
    }

    // CONDITION_SATISFIED or ALREADY_SIGNALED — data is in the PBO.
    const { byteLen, w, h } = slot;

    // Grow pre-allocated readback buffer if needed (high-water mark).
    if (byteLen > this._fullReadbackBuf.byteLength) {
      this._fullReadbackBuf = new Uint8ClampedArray(byteLen);
    }

    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    // getBufferSubData reads from GPU PBO into CPU buffer — no stall because
    // we already waited for the fence above.
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this._fullReadbackBuf, 0, byteLen);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

    // Y-flip: GL returns rows bottom→top; OffscreenCanvas is top→bottom.
    this._yFlipFull(this._fullReadbackBuf, w, h);

    // Copy into a correctly-sized output buffer.
    const out = new Uint8ClampedArray(byteLen);
    out.set(this._fullReadbackBuf.subarray(0, byteLen));

    this._cleanupSlot(gl, slot);
    slot.resolve(out);
  }

  private _cancelReadback(gl: WebGL2RenderingContext): void {
    const slot = this._readback;
    if (!slot) return;
    if (slot.timerId !== null) clearTimeout(slot.timerId);
    slot.reject(new Error('Readback cancelled by newer request'));
    this._cleanupSlot(gl, slot);
  }

  private _cleanupSlot(gl: WebGL2RenderingContext, slot: ReadbackSlot): void {
    gl.deleteSync(slot.sync);
    gl.deleteBuffer(slot.pbo);
    if (this._readback === slot) this._readback = null;
  }

  /**
   * Y-flip all RGBA rows in-place for a w×h buffer.
   * Allocates a single row scratch buffer — called only at pointerUp, not on
   * the hot path. Correct for any w×h: stride = w*4 exactly, no high-water mismatch.
   */
  private _yFlipFull(buf: Uint8ClampedArray, w: number, h: number): void {
    const rowBytes = w * 4;
    const tmp      = new Uint8ClampedArray(rowBytes);
    const half     = h >> 1;
    for (let i = 0; i < half; i++) {
      const topOff = i        * rowBytes;
      const botOff = (h-1-i) * rowBytes;
      tmp.set(buf.subarray(topOff, topOff + rowBytes));
      buf.copyWithin(topOff, botOff, botOff + rowBytes);
      buf.set(tmp, botOff);
    }
  }

  /**
   * Allocate a read-only FBO wrapping an existing display texture.
   * Used as READ_FRAMEBUFFER source in blitFramebuffer.
   * The FBO does not own the texture — caller deletes it independently.
   */
  private _allocReadFBO(gl: WebGL2RenderingContext, tex: WebGLTexture): WebGLFramebuffer | null {
    const fbo = gl.createFramebuffer();
    if (!fbo) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.error('[PhobosGPURenderer] ReadFBO incomplete:', status.toString(16));
      gl.deleteFramebuffer(fbo);
      return null;
    }
    return fbo;
  }

  // --------------------------------------------------------------------------
  // Texture allocation (texStorage2D — immutable, preferred over texImage2D)
  // --------------------------------------------------------------------------

  /**
   * texStorage2D vs texImage2D:
   *   - texStorage2D declares the full texture layout once (immutable).
   *   - The driver can fully optimise internal memory layout at allocation.
   *   - Avoids the driver having to defer finalisation until first draw.
   *   - WebGL 2 spec: "texStorage2D should be considered a preferred alternative."
   *   - Memory cost may be lower (no double-allocation of mip chain).
   */
  private _allocLayerTexture(gl: WebGL2RenderingContext, w: number, h: number): WebGLTexture | null {
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Allocate full mip chain. Mip count = floor(log2(max(w,h))) + 1.
    // generateMipmap() is called after every _uploadCanvas() to keep the chain
    // current. This is the only way to get correct antialiasing at zoom < 50%.
    const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, w, h);
    // Trilinear: LINEAR between mip levels, LINEAR within each level.
    // This is the standard filter for raster content displayed at varying zoom.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  // --------------------------------------------------------------------------
  // FBO allocation
  // --------------------------------------------------------------------------

  private _allocLayerFBO(gl: WebGL2RenderingContext, w: number, h: number): LayerFBO | null {
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    // Nearest for FBO: brush stamps are pixel-exact; no interpolation at read
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    const fbo = gl.createFramebuffer();
    if (!fbo) { gl.deleteTexture(tex); return null; }

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    // Check completeness at allocation time — avoids runtime cost per draw
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.error('[PhobosGPURenderer] LayerFBO incomplete, status:', status.toString(16));
      gl.deleteTexture(tex);
      gl.deleteFramebuffer(fbo);
      return null;
    }

    return { fbo, texture: tex, width: w, height: h };
  }

  private _allocPingPong(gl: WebGL2RenderingContext, w: number, h: number): PingPongFBO | null {
    const texA = this._allocFBOTexture(gl, w, h);
    const texB = this._allocFBOTexture(gl, w, h);
    if (!texA || !texB) {
      if (texA) gl.deleteTexture(texA);
      if (texB) gl.deleteTexture(texB);
      return null;
    }

    const fboA = gl.createFramebuffer();
    const fboB = gl.createFramebuffer();
    if (!fboA || !fboB) {
      gl.deleteTexture(texA); gl.deleteTexture(texB);
      if (fboA) gl.deleteFramebuffer(fboA);
      if (fboB) gl.deleteFramebuffer(fboB);
      return null;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, fboA);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texA, 0);
    const sA = gl.checkFramebufferStatus(gl.FRAMEBUFFER);

    gl.bindFramebuffer(gl.FRAMEBUFFER, fboB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texB, 0);
    const sB = gl.checkFramebufferStatus(gl.FRAMEBUFFER);

    // Clear both to (0,0,0,0) at allocation — ensures correct first-layer composite
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, fboA);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (sA !== gl.FRAMEBUFFER_COMPLETE || sB !== gl.FRAMEBUFFER_COMPLETE) {
      console.error('[PhobosGPURenderer] PingPong FBO incomplete:', sA.toString(16), sB.toString(16));
      gl.deleteTexture(texA); gl.deleteTexture(texB);
      gl.deleteFramebuffer(fboA); gl.deleteFramebuffer(fboB);
      return null;
    }

    return new PingPongFBO(fboA, texA, fboB, texB, w, h);
  }

  /**
   * Allocate an RGBA8 texture for FBO attachment (ping-pong composite targets).
   *
   * MIN/MAG filter: LINEAR.
   * The ping-pong readTex is sampled by the blit shader at arbitrary zoom levels.
   * NEAREST causes point-sampling aliasing when zoomed out — each screen pixel
   * picks one arbitrary texel from an NxN document region, producing the blocky
   * stepped edges visible on curved strokes. LINEAR averages 4 texels per sample,
   * which is sufficient to eliminate the staircase at all practical zoom levels.
   *
   * The writeTex (render target) is also LINEAR — it costs nothing since the
   * compositor never reads from the writeTex, only renders into it.
   */
  private _allocFBOTexture(gl: WebGL2RenderingContext, w: number, h: number): WebGLTexture | null {
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  // --------------------------------------------------------------------------
  // FBO destruction
  // --------------------------------------------------------------------------

  private _destroyLayerFBO(gl: WebGL2RenderingContext, f: LayerFBO): void {
    gl.deleteFramebuffer(f.fbo);
    gl.deleteTexture(f.texture);
  }

  private _destroyPingPong(gl: WebGL2RenderingContext, pp: PingPongFBO): void {
    gl.deleteFramebuffer(pp.fboA); gl.deleteFramebuffer(pp.fboB);
    gl.deleteTexture(pp.texA);     gl.deleteTexture(pp.texB);
  }

  private _destroyAllGPU(gl: WebGL2RenderingContext): void {
    for (const tex of this._layerTextures.values()) gl.deleteTexture(tex);
    for (const fbo of this._layerFBOs.values())     this._destroyLayerFBO(gl, fbo);
    for (const rfbo of this._layerReadFBOs.values()) gl.deleteFramebuffer(rfbo);
    if (this._pingPong)      this._destroyPingPong(gl, this._pingPong);
    if (this._quadVAO)       gl.deleteVertexArray(this._quadVAO);
    if (this._nullTex)       gl.deleteTexture(this._nullTex);
    if (this._compositeProg) gl.deleteProgram(this._compositeProg);
    if (this._blitProg)      gl.deleteProgram(this._blitProg);
    this._layerTextures  = new Map();
    this._layerFBOs      = new Map();
    this._layerReadFBOs  = new Map();
    this._pingPong       = null;
    this._quadVAO        = null;
    this._nullTex        = null;
    this._compositeProg  = null;
    this._blitProg       = null;
    this._compU          = null;
    this._blitU          = null;
  }

  // --------------------------------------------------------------------------
  // CPU canvas upload
  // --------------------------------------------------------------------------

  private _uploadCanvas(
    gl: WebGL2RenderingContext,
    canvas: OffscreenCanvas,
    tex: WebGLTexture,
    w: number, h: number,
  ): void {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // OffscreenCanvas is a valid ImageBitmapSource for texSubImage2D in WebGL2.
    // Data is non-premultiplied RGBA8 (UNPACK_PREMULTIPLY_ALPHA_WEBGL = false).
    // GL origin is bottom-left; canvas origin is top-left. The Y inversion is
    // handled in the composite shader (v_uv.y is already correct for the fullscreen
    // triangle). This is consistent across uploads and readbacks.
    gl.texSubImage2D(
      gl.TEXTURE_2D, 0, 0, 0, w, h,
      gl.RGBA, gl.UNSIGNED_BYTE,
      canvas as unknown as ImageBitmap,
    );
    // Regenerate the mip chain from the updated base level.
    // Required for LINEAR_MIPMAP_LINEAR to produce correct zoom-out antialiasing.
    // Cost: ~0.1ms for typical document sizes; called only on dirty layers.
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }


  /**
   * Copy a texture into a LayerFBO using a fullscreen composite draw.
   * Fallback for when _allocReadFBO fails under context pressure so
   * blitFramebuffer is unavailable. Normal blend at opacity=1,
   * destination = (0,0,0,0) → output = source exactly.
   */
  private _copyTextureToLayerFBO(
    gl:  WebGL2RenderingContext,
    tex: WebGLTexture,
    fbo: LayerFBO,
  ): void {
    const prog  = this._compositeProg;
    const compU = this._compU;
    if (!prog || !compU || !this._quadVAO) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fbo);
    gl.viewport(0, 0, fbo.width, fbo.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);

    gl.useProgram(prog);
    gl.bindVertexArray(this._quadVAO);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._nullTex);

    gl.uniform1f(compU.opacity,   1.0);
    gl.uniform1i(compU.blendMode, BLEND_MODE_INDEX['normal']);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // --------------------------------------------------------------------------
  // Shader compilation
  // --------------------------------------------------------------------------

  /**
   * Compile vert + frag shaders and link them into a program.
   *
   * MDN best practices applied:
   * 1. Both compileShader calls are issued before any status query or link call.
   *    Browsers that implement KHR_parallel_shader_compile or internal parallelism
   *    can compile both shaders concurrently on background threads.
   * 2. Individual compile status is NOT checked (deferred to link time per ESSL3 spec).
   *    Only LINK_STATUS is queried — one unavoidable blocking call.
   * 3. Shader handles are deleted immediately after attachment (eager deletion).
   *    The program object holds the underlying shader; the handle is just a name.
   */
  private _buildProgram(
    gl: WebGL2RenderingContext,
    vertSrc: string,
    fragSrc: string,
  ): WebGLProgram | null {
    const vert = gl.createShader(gl.VERTEX_SHADER);
    const frag = gl.createShader(gl.FRAGMENT_SHADER);
    if (!vert || !frag) return null;

    gl.shaderSource(vert, vertSrc);
    gl.shaderSource(frag, fragSrc);
    gl.compileShader(vert);  // submitted
    gl.compileShader(frag);  // submitted — browser may compile both in parallel now

    const prog = gl.createProgram();
    if (!prog) { gl.deleteShader(vert); gl.deleteShader(frag); return null; }

    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);

    gl.deleteShader(vert); // eager deletion
    gl.deleteShader(frag);

    const ok = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean;
    if (!ok) {
      console.error('[PhobosGPURenderer] Link error:\n', gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      return null;
    }
    return prog;
  }

  // --------------------------------------------------------------------------
  // Uniform location queries
  // --------------------------------------------------------------------------

  private _getCompositeUniforms(gl: WebGL2RenderingContext, prog: WebGLProgram): CompositeUniforms | null {
    const u = {
      layerTex:     gl.getUniformLocation(prog, 'u_layerTex'),
      compositeTex: gl.getUniformLocation(prog, 'u_compositeTex'),
      opacity:      gl.getUniformLocation(prog, 'u_opacity'),
      blendMode:    gl.getUniformLocation(prog, 'u_blendMode'),
    };
    if (!u.layerTex || !u.compositeTex || !u.opacity || !u.blendMode) {
      console.error('[PhobosGPURenderer] Missing composite uniforms');
      return null;
    }
    return u as CompositeUniforms;
  }


  private _getBlitUniforms(gl: WebGL2RenderingContext, prog: WebGLProgram): BlitUniforms | null {
    const u = {
      tex:         gl.getUniformLocation(prog, 'u_tex'),
      screenToDoc: gl.getUniformLocation(prog, 'u_screenToDoc'),
      resolution:  gl.getUniformLocation(prog, 'u_resolution'),
    };
    if (!u.tex || !u.screenToDoc || !u.resolution) {
      console.error('[PhobosGPURenderer] Missing blit uniforms');
      return null;
    }
    return u as BlitUniforms;
  }
}