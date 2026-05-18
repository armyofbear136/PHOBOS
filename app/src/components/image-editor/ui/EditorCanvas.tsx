import React, {
  useEffect,
  useRef,
  useCallback,
  useReducer,
} from 'react';
import { PhobosDocument }   from '../editor/PhobosDocument';
import { ToolController }   from '../tools/ToolController';
import { PhobosGPURenderer } from '../gpu/PhobosGPURenderer';
import { GPUBrushEngine }   from '../gpu/GPUBrushEngine';
import type { PhobosLayer } from '../editor/PhobosLayer';

// =============================================================================
// EditorCanvas
//
// Replaces the Konva-based renderer with a WebGL2 pipeline.
//
// DOM structure:
//   <div container>               — receives all pointer/wheel/keyboard events
//     <canvas gl>                 — WebGL2 surface (base, full container size)
//     <canvas float>              — 2D overlay for float layer drag previews
//     <svg ants>                  — marching ants selection outline (CSS animated)
//
// Rendering:
//   PhobosGPURenderer owns the WebGL2 context on <canvas gl>.
//   Each frame: upload dirty CPU layers → composite → checkerboard blit → screen.
//   GPUBrushEngine draws brush stamps directly into layer FBOs.
//   composite() is called via requestAnimationFrame while a stroke is live,
//   and imperatively after any non-stroke pixel change.
//
// Float layers (MoveSelectionTool drag):
//   Float layer pixels are composited onto the 2D <canvas float> overlay at the
//   current CSS offset. Positioned absolutely over the GL canvas. No GPU involvement
//   — the float layer is a transient drag preview, committed on pointerUp.
//
// Marching ants:
//   An <svg> absolutely covers the container. A <polyline> inside it is updated
//   imperatively via updateSelectionOutline(). Animation is pure CSS
//   (stroke-dashoffset keyframe) — zero JS RAF loop.
//
// Coordinate system:
//   Pan/zoom is tracked in _transform: [scaleX, 0, 0, scaleY, panX, panY].
//   scaleX == scaleY (uniform zoom). panX/panY are in CSS pixels.
//   Tools receive document-space CSS coordinates (pan + zoom removed).
//   GPU renderer receives _transform for the checkerboard and final blit.
//
// Handle contract (EditorCanvasHandle):
//   Attached to containerRef.current.__phobos so ImageEditorPanel can call
//   syncLayerNodes(), updateSelectionOutline(), addFloatLayer(),
//   removeFloatLayer(), moveFloatLayer() imperatively.
// =============================================================================

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ZOOM_MIN  = 0.05;
const ZOOM_MAX  = 32;
const ZOOM_STEP = 0.12;

// Marching ants SVG appearance (CSS animation defined in the style tag below)
const ANTS_DASH_ARRAY  = '6 4';
const ANTS_STROKE_W    = 1;    // CSS px — SVG is in CSS space, not physical

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EditorState {
  canUndo:          boolean;
  canRedo:          boolean;
  activeLayerIndex: number;
  layerCount:       number;
  cursor:           string;
}

export interface EditorCanvasHandle {
  syncLayerNodes():                                                      void;
  updateSelectionOutline(pts: number[] | null):                         void;
  addFloatLayer(layer: PhobosLayer):                                    void;
  removeFloatLayer(layer: PhobosLayer):                                 void;
  moveFloatLayer(layer: PhobosLayer, cssX: number, cssY: number):       void;
}

interface EditorCanvasProps {
  doc:           PhobosDocument;
  controller:    ToolController;
  width:         number;
  height:        number;
  onStateChange: (state: EditorState) => void;
}

// ---------------------------------------------------------------------------
// Transform helpers
// [scaleX, 0, 0, scaleY, panX, panY]  — uniform scale, panX/panY in CSS px
// ---------------------------------------------------------------------------

type Transform = [number, number, number, number, number, number];

function makeTransform(scale: number, panX: number, panY: number): Transform {
  return [scale, 0, 0, scale, panX, panY];
}

function docToCanvas(
  t: Transform,
  docCssX: number,
  docCssY: number,
): { x: number; y: number } {
  return {
    x: docCssX * t[0] + t[4],
    y: docCssY * t[3] + t[5],
  };
}

function canvasToDoc(
  t: Transform,
  canvasX: number,
  canvasY: number,
): { x: number; y: number } {
  return {
    x: (canvasX - t[4]) / t[0],
    y: (canvasY - t[5]) / t[3],
  };
}

// ---------------------------------------------------------------------------
// Float layer state (per-drag transient)
// ---------------------------------------------------------------------------

interface FloatLayerEntry {
  layer:  PhobosLayer;
  cssX:   number;
  cssY:   number;
}

// =============================================================================
// Component
// =============================================================================

export const EditorCanvas = React.memo(function EditorCanvas({
  doc,
  controller,
  width,
  height,
  onStateChange,
}: EditorCanvasProps) {
  const containerRef  = useRef<HTMLDivElement>(null);
  const glCanvasRef   = useRef<HTMLCanvasElement>(null);
  const floatCanvasRef = useRef<HTMLCanvasElement>(null);
  const antsPolyRef       = useRef<SVGPolylineElement>(null);
  const antsPolyBackRef   = useRef<SVGPolylineElement>(null);

  const rendererRef   = useRef<PhobosGPURenderer | null>(null);
  const brushEngRef   = useRef<GPUBrushEngine | null>(null);

  // Current pan/zoom transform — mutated in-place on pan/zoom events
  const transformRef  = useRef<Transform>(makeTransform(1, 0, 0));

  // RAF handle for composite loop during brush strokes
  const rafRef        = useRef<number>(0);
  const strokeLiveRef = useRef<boolean>(false);

  // Float layers currently visible (MoveSelectionTool drag previews)
  const floatLayersRef = useRef<FloatLayerEntry[]>([]);

  // Panning state
  const isPanningRef  = useRef(false);
  const panStartRef   = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const spaceDownRef  = useRef(false);

  const [, forceUpdate] = useReducer(x => x + 1, 0);

  // ---------------------------------------------------------------------------
  // EditorState emission
  // ---------------------------------------------------------------------------

  const emitState = useCallback(() => {
    onStateChange({
      canUndo:          doc.history.canUndo,
      canRedo:          doc.history.canRedo,
      activeLayerIndex: doc.activeLayerIndex,
      layerCount:       doc.layers.length,
      cursor:           controller.cursor,
    });
    forceUpdate();
  }, [doc, controller, onStateChange]);

  // ---------------------------------------------------------------------------
  // Composite — single frame render
  // Uploads dirty CPU layers, runs GPU composite, draws float overlay.
  // ---------------------------------------------------------------------------

  const renderFrame = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer || !renderer.isReady) return;
    renderer.composite(doc, transformRef.current);
    _drawFloatOverlay();
  }, [doc]); // eslint-disable-line react-hooks/exhaustive-deps

  // Draw float layers onto the 2D overlay canvas
  function _drawFloatOverlay(): void {
    const canvas = floatCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const t = transformRef.current;
    for (const entry of floatLayersRef.current) {
      const { layer, cssX, cssY } = entry;
      // Convert float layer CSS offset to canvas-space pixel position
      const canvasPos = docToCanvas(t, cssX, cssY);
      ctx.save();
      ctx.setTransform(t[0], 0, 0, t[3], canvasPos.x, canvasPos.y);
      ctx.drawImage(layer.canvas, 0, 0, doc.cssWidth, doc.cssHeight);
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------------------
  // RAF composite loop — active only during brush strokes
  // ---------------------------------------------------------------------------

  const startCompositeLoop = useCallback(() => {
    if (strokeLiveRef.current) return;
    strokeLiveRef.current = true;
    const loop = (): void => {
      if (!strokeLiveRef.current) return;
      renderFrame();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [renderFrame]);

  const stopCompositeLoop = useCallback(() => {
    strokeLiveRef.current = false;
    cancelAnimationFrame(rafRef.current);
    // One final composite to capture the completed stroke
    renderFrame();
  }, [renderFrame]);

  // ---------------------------------------------------------------------------
  // Mount — create renderer and brush engine
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const glCanvas = glCanvasRef.current;
    if (!glCanvas) return;

    // Size the GL canvas backing store to physical pixels
    glCanvas.width  = Math.round(width  * doc.dpr);
    glCanvas.height = Math.round(height * doc.dpr);

    const renderer = new PhobosGPURenderer(glCanvas);
    const ok = renderer.init(doc);

    if (!ok) {
      console.error('[EditorCanvas] WebGL2 unavailable — GPU path disabled');
      // CPU fallback could be wired here; for now we log and continue
      return;
    }

    rendererRef.current = renderer;

    const gl = glCanvas.getContext('webgl2') as WebGL2RenderingContext;
    const brushEng = new GPUBrushEngine(renderer);
    if (!brushEng.init(gl)) {
      console.error('[EditorCanvas] GPUBrushEngine init failed');
    } else {
      brushEngRef.current = brushEng;
    }

    // Set initial transform: scale=1.0, pan centered so the document appears
    // in the middle of the canvas. dpr must NOT appear in scale — it is only
    // a GL backing-store concern.
    const docCssW = doc.physicalWidth  / doc.dpr;
    const docCssH = doc.physicalHeight / doc.dpr;
    const initPanX = (width  - docCssW) / 2;
    const initPanY = (height - docCssH) / 2;
    transformRef.current = makeTransform(1.0, initPanX, initPanY);

    // Wire brush engine into controller so PaintBrushTool can call it
    controller.setBrushEngine(brushEng);
    controller.bindDocument(doc);

    // Initial render
    renderer.composite(doc, transformRef.current);

    emitState();

    return () => {
      stopCompositeLoop();
      controller.setBrushEngine(null);
      controller.unbindDocument();
      brushEng.destroy();
      renderer.destroy();
      rendererRef.current = null;
      brushEngRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // once per mount

  // ---------------------------------------------------------------------------
  // Resize — resize GL canvas and renderer when container dims change
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const glCanvas = glCanvasRef.current;
    const renderer = rendererRef.current;
    if (!glCanvas || !renderer) return;

    const physW = Math.round(width  * doc.dpr);
    const physH = Math.round(height * doc.dpr);

    if (glCanvas.width !== physW || glCanvas.height !== physH) {
      glCanvas.width  = physW;
      glCanvas.height = physH;
    }

    renderFrame();
  }, [width, height, doc.dpr, renderFrame]);

  // ---------------------------------------------------------------------------
  // Coordinate conversion — client px → document CSS px
  // ---------------------------------------------------------------------------

  const toDocCoords = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const rect = containerRef.current!.getBoundingClientRect();
    return canvasToDoc(
      transformRef.current,
      clientX - rect.left,
      clientY - rect.top,
    );
  }, []);

  // ---------------------------------------------------------------------------
  // Pointer events
  // ---------------------------------------------------------------------------

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Middle-click or space+left → pan
    if (e.button === 1 || (e.button === 0 && spaceDownRef.current)) {
      isPanningRef.current = true;
      const t = transformRef.current;
      panStartRef.current = { x: e.clientX, y: e.clientY, panX: t[4], panY: t[5] };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }

    if (e.button !== 0) return;
    const { x, y } = toDocCoords(e.clientX, e.clientY);

    // Reject strokes that start outside the document boundary.
    // toDocCoords returns CSS px in document space; the document spans
    // [0, cssWidth] × [0, cssHeight]. Out-of-bounds starts cause GPU
    // stamp corruption (UV overflow + CLAMP_TO_EDGE edge smearing).
    const docCssW = doc.physicalWidth  / doc.dpr;
    const docCssH = doc.physicalHeight / doc.dpr;
    if (x < 0 || x > docCssW || y < 0 || y > docCssH) return;

    controller.pointerDown(x, y, e.pressure || 1, e.buttons);
    e.currentTarget.setPointerCapture(e.pointerId);

    // Start RAF loop for GPU brush — composite runs every frame during stroke
    startCompositeLoop();
  }, [controller, toDocCoords, startCompositeLoop]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (isPanningRef.current) {
      const t   = transformRef.current;
      const dx  = e.clientX - panStartRef.current.x;
      const dy  = e.clientY - panStartRef.current.y;
      t[4] = panStartRef.current.panX + dx;
      t[5] = panStartRef.current.panY + dy;
      renderFrame();
      return;
    }

    if (!(e.buttons & 1)) return;

    // Consume all coalesced events for high-frequency tablet input
    const coalesced = e.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const ce of coalesced) {
      const { x, y } = toDocCoords(ce.clientX, ce.clientY);
      controller.pointerMove(x, y, ce.pressure || 1, ce.buttons);
    }
    const { x, y } = toDocCoords(e.clientX, e.clientY);
    controller.pointerMove(x, y, e.pressure || 1, e.buttons);
    // Frame render happens in the RAF loop started at pointerDown
  }, [controller, toDocCoords, renderFrame]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (isPanningRef.current) {
      isPanningRef.current = false;
      e.currentTarget.releasePointerCapture(e.pointerId);
      return;
    }

    if (e.button !== 0) return;
    const { x, y } = toDocCoords(e.clientX, e.clientY);

    // Stop the composite loop before pointerUp so the final async readback
    // can settle without racing against an in-flight RAF composite.
    stopCompositeLoop();

    controller.pointerUp(x, y, e.pressure || 1, e.buttons);
    e.currentTarget.releasePointerCapture(e.pointerId);

    // Composite once more after the command is emitted (CPU canvas now updated)
    renderFrame();
    emitState();
  }, [controller, toDocCoords, stopCompositeLoop, renderFrame, emitState]);

  // ---------------------------------------------------------------------------
  // Wheel zoom — centred on cursor position
  // ---------------------------------------------------------------------------

  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = containerRef.current!.getBoundingClientRect();
    const t    = transformRef.current;

    const oldScale = t[0];
    const newScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN,
      oldScale * (1 + (e.deltaY < 0 ? 1 : -1) * ZOOM_STEP),
    ));

    // Pointer position in CSS canvas space
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    // Keep the canvas point under the cursor fixed:
    // docX = (px - panX) / oldScale  →  newPanX = px - docX * newScale
    const docX = (px - t[4]) / oldScale;
    const docY = (py - t[5]) / oldScale;

    t[0] = newScale;
    t[3] = newScale;
    t[4] = px - docX * newScale;
    t[5] = py - docY * newScale;

    renderFrame();
  }, [renderFrame]);

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.code === 'Space') { spaceDownRef.current = true; e.preventDefault(); return; }
    if (e.code === 'Escape') { controller.cancel(); renderFrame(); return; }

    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === 'KeyZ' && !e.shiftKey) {
      e.preventDefault();
      controller.undo();
      renderFrame();
      emitState();
      return;
    }
    if (ctrl && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey))) {
      e.preventDefault();
      controller.redo();
      renderFrame();
      emitState();
    }
  }, [controller, renderFrame, emitState]);

  const handleKeyUp = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.code === 'Space') {
      spaceDownRef.current  = false;
      isPanningRef.current  = false;
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Handle — attached to container DOM node for ImageEditorPanel to call
  // ---------------------------------------------------------------------------

  const syncLayerNodes = useCallback((): void => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.syncLayers(doc);
    renderFrame();
  }, [doc, renderFrame]);

  const updateSelectionOutline = useCallback((pts: number[] | null): void => {
    const poly     = antsPolyRef.current;
    const polyBack = antsPolyBackRef.current;
    if (!poly) return;

    if (!pts || pts.length === 0) {
      poly.setAttribute('points', '');
      poly.style.display = 'none';
      if (polyBack) { polyBack.setAttribute('points', ''); polyBack.style.display = 'none'; }
      return;
    }

    // pts is flat [x0,y0, x1,y1, ...] in document CSS px.
    // Convert to canvas CSS px using current transform.
    const t      = transformRef.current;
    const pairs: string[] = [];
    for (let i = 0; i < pts.length; i += 2) {
      const cx = pts[i]   * t[0] + t[4];
      const cy = pts[i+1] * t[3] + t[5];
      pairs.push(`${cx.toFixed(1)},${cy.toFixed(1)}`);
    }
    const pointsStr = pairs.join(' ');

    poly.setAttribute('points', pointsStr);
    poly.style.display = '';
    if (polyBack) { polyBack.setAttribute('points', pointsStr); polyBack.style.display = ''; }
  }, []);

  const addFloatLayer = useCallback((layer: PhobosLayer): void => {
    floatLayersRef.current.push({ layer, cssX: 0, cssY: 0 });
    _drawFloatOverlay();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const removeFloatLayer = useCallback((layer: PhobosLayer): void => {
    const arr = floatLayersRef.current;
    const idx = arr.findIndex(e => e.layer === layer);
    if (idx !== -1) arr.splice(idx, 1);
    _drawFloatOverlay();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const moveFloatLayer = useCallback((layer: PhobosLayer, cssX: number, cssY: number): void => {
    const entry = floatLayersRef.current.find(e => e.layer === layer);
    if (!entry) return;
    entry.cssX = cssX;
    entry.cssY = cssY;
    _drawFloatOverlay();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Attach handle to container DOM node after every render
  useEffect(() => {
    const el = containerRef.current as (HTMLDivElement & { __phobos?: EditorCanvasHandle }) | null;
    if (!el) return;
    el.__phobos = {
      syncLayerNodes,
      updateSelectionOutline,
      addFloatLayer,
      removeFloatLayer,
      moveFloatLayer,
    };
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const containerStyle: React.CSSProperties = {
    position:        'relative',
    width,
    height,
    overflow:        'hidden',
    cursor:          spaceDownRef.current ? 'grab' : controller.cursor,
    outline:         'none',
    // Background behind the document. The GL canvas is transparent outside the
    // document boundary (discard in blit shader), so this color shows through.
    backgroundColor: 'hsl(var(--secondary))',
  };

  const coverStyle: React.CSSProperties = {
    position:  'absolute',
    top:       0,
    left:      0,
    width:     '100%',
    height:    '100%',
    pointerEvents: 'none',
  };

  return (
    <div
      ref={containerRef}
      style={containerStyle}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
    >
      {/* WebGL2 compositing surface */}
      <canvas
        ref={glCanvasRef}
        style={{
          position:  'absolute',
          top:       0,
          left:      0,
          width:     '100%',
          height:    '100%',
          display:   'block',
        }}
      />

      {/* Float layer drag preview (MoveSelectionTool) */}
      <canvas
        ref={floatCanvasRef}
        width={width}
        height={height}
        style={{ ...coverStyle, display: 'block' }}
      />

      {/* Marching ants — CSS animated, zero JS RAF loop */}
      <svg
        style={coverStyle}
        xmlns="http://www.w3.org/2000/svg"
      >
        <style>{`
          @keyframes phobos-ants {
            from { stroke-dashoffset: 0; }
            to   { stroke-dashoffset: -${(ANTS_DASH_ARRAY.split(' ').map(Number).reduce((a,b)=>a+b,0))}px; }
          }
          .phobos-ants-line {
            animation: phobos-ants 0.4s linear infinite;
            stroke-dasharray: ${ANTS_DASH_ARRAY};
            fill: none;
          }
        `}</style>

        {/* Black outer stroke */}
        <polyline
          ref={antsPolyBackRef}
          className="phobos-ants-line"
          stroke="#000000"
          strokeWidth={ANTS_STROKE_W + 1}
          display="none"
        />
        {/* White inner stroke — same element ref, layered via two polylines */}
        <polyline
          ref={antsPolyRef}
          className="phobos-ants-line"
          stroke="#ffffff"
          strokeWidth={ANTS_STROKE_W}
          display="none"
        />
      </svg>
    </div>
  );
});
