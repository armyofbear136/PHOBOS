import type { PhobosGPURenderer } from './PhobosGPURenderer';
import { BRUSH_VERT }             from './shaders/brush.vert';
import { BRUSH_FRAG }             from './shaders/brush.frag';

// =============================================================================
// GPUBrushEngine
//
// Draws brush stamps directly into layer FBOs via WebGL2.
// Called by PaintBrushTool on the pointer-event hot path.
//
// One instance per editor canvas mount. Destroyed with the canvas.
//
// Design:
//   - Owns brush.vert / brush.frag program, one VAO, one VBO.
//   - Each stamp is a single axis-aligned quad (two triangles, 6 vertices).
//   - Vertex data: [x, y, u, v] × 6 — uploaded via bufferSubData per stamp.
//     Zero allocation after warm-up. The VBO is pre-allocated once at init to
//     its maximum size (6 verts × 4 floats × 4 bytes = 96 bytes).
//   - Blending in the FBO uses source-over (SRC_ALPHA, ONE_MINUS_SRC_ALPHA)
//     so stamps accumulate correctly for sub-1 opacity brushes.
//   - After each stamp, syncLayerFBOToTexture() copies FBO → display texture
//     so PhobosGPURenderer.composite() immediately sees the new data.
//
// Coordinate convention:
//   stampAt() receives physical pixel coords (layer canvas space, top-left origin).
//   brush.vert converts physical px → NDC, flipping Y to match GL convention.
//
// Stroke lifecycle:
//   PaintBrushTool.onPointerDown → beginStroke(layer)
//   PaintBrushTool.onPointerMove → stampAt(...)      [hot path]
//   PaintBrushTool.onPointerUp   → endStrokeSync()   → readLayerFullSync() → full-layer pixels
//   PaintBrushTool.onCancel      → cancelStroke()    → readLayerFBOAsync() → CPU sync
//
// Permanent wire contracts (attribute locations, never change):
//   location 0 → a_position (vec2, physical px in layer space)
//   location 1 → a_uv       (vec2, [0,1] within the stamp quad)
// =============================================================================

// Pre-allocated vertex data buffer — 6 verts × 4 floats (x, y, u, v).
// Mutated in place by _fillQuad(). Never recreated after init.
const QUAD_VERTS = new Float32Array(24); // 6 × 4

// Byte size of the VBO — computed once from QUAD_VERTS.
const VBO_BYTE_SIZE = QUAD_VERTS.byteLength; // 96 bytes

// Uniform location struct — queried once at link, never at stamp time.
interface BrushUniforms {
  resolution: WebGLUniformLocation;
  color:      WebGLUniformLocation;
  hardness:   WebGLUniformLocation;
  opacity:    WebGLUniformLocation;
}

// ---------------------------------------------------------------------------
// Parsed brush color — pre-converted from CSS string to [0,1] RGBA floats.
// Memoised: re-parsed only when settings.color changes.
// ---------------------------------------------------------------------------
const _colorVec = new Float32Array(4); // [r, g, b, a]

// Reusable canvas for CSS color parsing — allocated once, never redrawn.
const _colorCanvas = new OffscreenCanvas(1, 1);
const _colorCtx    = _colorCanvas.getContext('2d')!;

/** Parse a CSS colour string into _colorVec [r, g, b, a], each in [0, 1]. */
function parseCSSColor(css: string): void {
  _colorCtx.clearRect(0, 0, 1, 1);
  _colorCtx.fillStyle = css;
  _colorCtx.fillRect(0, 0, 1, 1);
  const px = _colorCtx.getImageData(0, 0, 1, 1).data;
  _colorVec[0] = px[0] / 255;
  _colorVec[1] = px[1] / 255;
  _colorVec[2] = px[2] / 255;
  _colorVec[3] = px[3] / 255;
}

// =============================================================================
// GPUBrushEngine
// =============================================================================

export class GPUBrushEngine {
  // --------------------------------------------------------------------------
  // Public
  // --------------------------------------------------------------------------

  /** True when init() succeeded and the engine is usable. */
  get isReady(): boolean { return this._prog !== null; }

  // --------------------------------------------------------------------------
  // Private GL state
  // --------------------------------------------------------------------------

  private readonly _renderer: PhobosGPURenderer;
  private _gl:   WebGL2RenderingContext | null = null;
  private _prog: WebGLProgram           | null = null;
  private _vao:  WebGLVertexArrayObject | null = null;
  private _vbo:  WebGLBuffer            | null = null;
  private _u:    BrushUniforms          | null = null;

  // --------------------------------------------------------------------------
  // Per-stroke state — valid between beginStroke and endStroke/cancelStroke
  // --------------------------------------------------------------------------

  private _stroking: boolean = false;
  private _layerId:  number  = -1;
  private _layerW:   number  = 0;
  private _layerH:   number  = 0;

  // --------------------------------------------------------------------------
  // Settings cache — avoids re-uploading uniforms that haven't changed
  // --------------------------------------------------------------------------

  private _cachedColor:    string = '';
  private _cachedHardness: number = -1;
  private _cachedOpacity:  number = -1;
  private _cachedResW:     number = -1;
  private _cachedResH:     number = -1;

  // --------------------------------------------------------------------------
  // Constructor
  // --------------------------------------------------------------------------

  constructor(renderer: PhobosGPURenderer) {
    this._renderer = renderer;
  }

  // --------------------------------------------------------------------------
  // Init
  // --------------------------------------------------------------------------

  /**
   * Compile the brush program and allocate the VBO/VAO.
   * Called after PhobosGPURenderer.init() succeeds — uses the same GL context.
   * Returns true on success.
   */
  init(gl: WebGL2RenderingContext): boolean {
    this._gl = gl;

    this._prog = this._buildProgram(gl);
    if (!this._prog) return false;

    this._u = this._getUniforms(gl, this._prog);
    if (!this._u) return false;

    // Pre-allocate VBO at full quad size — never resized after this point
    const vbo = gl.createBuffer();
    if (!vbo) return false;
    this._vbo = vbo;

    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, VBO_BYTE_SIZE, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // VAO: encodes the attribute layout for brush quads
    const vao = gl.createVertexArray();
    if (!vao) return false;
    this._vao = vao;

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);

    // a_position: location 0, vec2, stride=16 bytes (4 floats × 4 bytes), offset=0
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);

    // a_uv: location 1, vec2, stride=16 bytes, offset=8 (after x,y)
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    return true;
  }

  // --------------------------------------------------------------------------
  // Stroke lifecycle
  // --------------------------------------------------------------------------

  /**
   * Begin a new stroke on the given layer.
   * Primes the layer FBO from the CPU canvas before any stamps are drawn.
   * This clears any stale data left by a previous cancelled GPU stroke.
   * Called at pointerDown.
   */
  beginStroke(
    layer: { id: number; canvas: OffscreenCanvas; physicalWidth: number; physicalHeight: number; gpuDirty: boolean },
  ): void {
    this._stroking = true;
    this._layerId  = layer.id;
    this._layerW   = layer.physicalWidth;
    this._layerH   = layer.physicalHeight;

    // Prime FBO from CPU canvas — overwrites any stale cancelled-stroke data.
    this._renderer.primeLayerFBOFromCPU(layer);
  }

  /**
   * Draw one brush stamp at (cx, cy) into the active layer FBO.
   *
   * Hot path — called on every pointer-move event that crosses the spacing
   * threshold. Zero allocation after warm-up. Mutates QUAD_VERTS and calls
   * bufferSubData. One drawArrays call per stamp.
   *
   * @param cx       Physical px, centre X in layer space
   * @param cy       Physical px, centre Y in layer space
   * @param radius   Physical px stamp radius
   * @param hardness [0, 1]
   * @param opacity  [0, 1]
   * @param color    CSS colour string (re-parsed only when changed)
   */
  stampAt(
    cx:       number,
    cy:       number,
    radius:   number,
    hardness: number,
    opacity:  number,
    color:    string,
  ): void {
    const gl = this._gl;
    if (!gl || !this._prog || !this._vao || !this._vbo || !this._u || !this._stroking) return;

    const fboHandle = this._renderer.getLayerFBO(this._layerId);
    if (!fboHandle) return;

    const r = radius;

    // Early out if the stamp quad is entirely outside the layer FBO.
    if (cx + r < 0 || cx - r > fboHandle.w || cy + r < 0 || cy - r > fboHandle.h) return;

    // Build the stamp quad vertices into QUAD_VERTS (pre-allocated, no alloc).
    // Quad corners in physical px (layer space), UV [0,1]:
    //   top-left:     (cx-r, cy-r), (0, 0)
    //   top-right:    (cx+r, cy-r), (1, 0)
    //   bottom-left:  (cx-r, cy+r), (0, 1)
    //   bottom-right: (cx+r, cy+r), (1, 1)
    // Two triangles (CW winding in layer space, flipped to CCW in shader via Y-flip):
    //   Triangle 1: TL, TR, BL
    //   Triangle 2: TR, BR, BL
    const x0 = cx - r;
    const y0 = cy - r;
    const x1 = cx + r;
    const y1 = cy + r;

    // Vert 0: TL
    QUAD_VERTS[0]  = x0; QUAD_VERTS[1]  = y0; QUAD_VERTS[2]  = 0; QUAD_VERTS[3]  = 0;
    // Vert 1: TR
    QUAD_VERTS[4]  = x1; QUAD_VERTS[5]  = y0; QUAD_VERTS[6]  = 1; QUAD_VERTS[7]  = 0;
    // Vert 2: BL
    QUAD_VERTS[8]  = x0; QUAD_VERTS[9]  = y1; QUAD_VERTS[10] = 0; QUAD_VERTS[11] = 1;
    // Vert 3: TR (repeated)
    QUAD_VERTS[12] = x1; QUAD_VERTS[13] = y0; QUAD_VERTS[14] = 1; QUAD_VERTS[15] = 0;
    // Vert 4: BR
    QUAD_VERTS[16] = x1; QUAD_VERTS[17] = y1; QUAD_VERTS[18] = 1; QUAD_VERTS[19] = 1;
    // Vert 5: BL (repeated)
    QUAD_VERTS[20] = x0; QUAD_VERTS[21] = y1; QUAD_VERTS[22] = 0; QUAD_VERTS[23] = 1;

    // Bind layer FBO as the render target
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboHandle.fbo);
    gl.viewport(0, 0, fboHandle.w, fboHandle.h);

    // Stamp blend: source-over for RGB, MAX for alpha.
    //
    // Standard source-over (SRC_ALPHA / ONE_MINUS_SRC_ALPHA) on the alpha channel
    // causes adjacent soft stamps to accumulate alpha additively where they overlap.
    // This produces ridges at stamp boundaries that read as sharp points or scalloping
    // on curves, especially at zoom-out where the sub-pixel feathering bunches up.
    //
    // MAX on alpha takes the highest alpha seen at each pixel across all stamps —
    // the stroke edge becomes the smooth outer envelope of the stamp series rather
    // than the sum of their individual feathers. This is how Photoshop and
    // Krita achieve clean edges on soft brushes at any spacing or zoom level.
    //
    // RGB still uses source-over so opacity < 1 colours blend correctly with
    // whatever is already in the FBO (existing layer content).
    gl.enable(gl.BLEND);
    gl.blendEquationSeparate(gl.FUNC_ADD, gl.MAX);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA,  // RGB: source-over
      gl.ONE,       gl.ONE,                  // A:   MAX ignores these factors
    );

    gl.useProgram(this._prog);
    gl.bindVertexArray(this._vao);

    // Upload quad vertices — bufferSubData into the pre-allocated VBO (no realloc)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, QUAD_VERTS);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // Upload u_resolution only when the FBO dimensions change (stable within a stroke)
    if (fboHandle.w !== this._cachedResW || fboHandle.h !== this._cachedResH) {
      gl.uniform2f(this._u.resolution, fboHandle.w, fboHandle.h);
      this._cachedResW = fboHandle.w;
      this._cachedResH = fboHandle.h;
    }

    // Upload uniforms that changed since the last stamp (memoised)
    if (color !== this._cachedColor) {
      parseCSSColor(color);
      gl.uniform4fv(this._u.color, _colorVec);
      this._cachedColor = color;
    }
    if (hardness !== this._cachedHardness) {
      gl.uniform1f(this._u.hardness, hardness);
      this._cachedHardness = hardness;
    }
    if (opacity !== this._cachedOpacity) {
      gl.uniform1f(this._u.opacity, opacity);
      this._cachedOpacity = opacity;
    }

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);

    // GPU→GPU copy: FBO → display texture so composite() sees this stamp immediately
    this._renderer.syncLayerFBOToTexture(this._layerId);
  }

  /**
   * End the stroke at pointerUp.
   * Initiates async GPU→CPU readback of the stroke bbox.
   * The promise resolves with a Uint8ClampedArray (top-left origin, RGBA8)
   * that the caller must write back to the layer's OffscreenCanvas before
   * emitting the LiveStrokeCommand.
   */
  endStroke(): Promise<Uint8ClampedArray> {
    return this._syncAndEnd();
  }

  /**
   * End the stroke synchronously at pointerUp.
   *
   * Returns the full-layer pixel buffer (physW×physH×4 bytes, top-left origin).
   * Full-layer readback eliminates the bbox mismatch class of bugs entirely.
   *
   * Safe only when the RAF composite loop has been stopped before this call,
   * which is guaranteed by EditorCanvas.stopCompositeLoop() in onPointerUp.
   * Returns null only on GL context loss.
   */
  endStrokeSync(): Uint8ClampedArray | null {
    return this._syncAndEndSync();
  }

  /**
   * Cancel the stroke (tool switch or focus loss mid-stroke).
   * Same as endStroke — we always sync to avoid losing GPU-side brush data.
   * The caller is responsible for deciding whether to emit a command.
   */
  cancelStroke(): Promise<Uint8ClampedArray> {
    return this._syncAndEnd();
  }

  // --------------------------------------------------------------------------
  // Destroy
  // --------------------------------------------------------------------------

  /**
   * Release all GPU resources owned by the engine.
   * Call after PhobosGPURenderer.destroy() to avoid using a dead context.
   */
  destroy(): void {
    const gl = this._gl;
    if (!gl) return;
    if (this._vao)  gl.deleteVertexArray(this._vao);
    if (this._vbo)  gl.deleteBuffer(this._vbo);
    if (this._prog) gl.deleteProgram(this._prog);
    this._vao  = null;
    this._vbo  = null;
    this._prog = null;
    this._u    = null;
    this._gl   = null;
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private _syncAndEnd(): Promise<Uint8ClampedArray> {
    if (!this._stroking) {
      return Promise.reject(new Error('GPUBrushEngine: endStroke/cancelStroke called with no active stroke'));
    }
    this._stroking = false;
    return this._renderer.readLayerFBOAsync(this._layerId, 0, 0, this._layerW, this._layerH);
  }

  private _syncAndEndSync(): Uint8ClampedArray | null {
    if (!this._stroking) {
      console.warn('GPUBrushEngine: endStrokeSync called with no active stroke');
      return null;
    }
    this._stroking = false;
    return this._renderer.readLayerFullSync(this._layerId);
  }

  // --------------------------------------------------------------------------
  // Shader compilation
  // --------------------------------------------------------------------------

  /**
   * Compile brush.vert + brush.frag and link.
   * Uses explicit attribute location binding (layout(location=N) in GLSL ES 3.00
   * is not available; we use bindAttribLocation before linkProgram instead).
   * This ensures a_position is always location 0 and a_uv is always location 1,
   * matching the VAO layout set up in init().
   */
  private _buildProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
    const vert = gl.createShader(gl.VERTEX_SHADER);
    const frag = gl.createShader(gl.FRAGMENT_SHADER);
    if (!vert || !frag) return null;

    gl.shaderSource(vert, BRUSH_VERT);
    gl.shaderSource(frag, BRUSH_FRAG);
    gl.compileShader(vert);
    gl.compileShader(frag);

    const prog = gl.createProgram();
    if (!prog) { gl.deleteShader(vert); gl.deleteShader(frag); return null; }

    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);

    // Bind attribute locations before link — guaranteed even without layout qualifiers.
    // These are the permanent wire contracts for the brush VAO layout.
    gl.bindAttribLocation(prog, 0, 'a_position');
    gl.bindAttribLocation(prog, 1, 'a_uv');

    gl.linkProgram(prog);

    gl.deleteShader(vert);
    gl.deleteShader(frag);

    const ok = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean;
    if (!ok) {
      console.error('[GPUBrushEngine] Link error:\n', gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      return null;
    }
    return prog;
  }

  private _getUniforms(gl: WebGL2RenderingContext, prog: WebGLProgram): BrushUniforms | null {
    const u = {
      resolution: gl.getUniformLocation(prog, 'u_resolution'),
      color:      gl.getUniformLocation(prog, 'u_color'),
      hardness:   gl.getUniformLocation(prog, 'u_hardness'),
      opacity:    gl.getUniformLocation(prog, 'u_opacity'),
    };
    if (!u.resolution || !u.color || !u.hardness || !u.opacity) {
      console.error('[GPUBrushEngine] Missing brush uniforms');
      return null;
    }
    return u as BrushUniforms;
  }
}
