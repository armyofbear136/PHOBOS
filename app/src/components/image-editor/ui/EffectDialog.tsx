import React, {
  useState,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import type { PhobosDocument }    from '../editor/PhobosDocument';
import type { PhobosPluginManifest, ParamDef, CurvePoint } from '../types';
import type { PluginWorker }      from '../plugins/PluginWorker';
import { RasterCommand }          from '../editor/RasterCommand';
import { allocatePixelBuffer, copyImageDataToBuffer, copyBufferToImageData } from '../plugins/PluginWorker';
import type { CommandEmitter }    from '../tools/ToolController';

// =============================================================================
// EffectDialog
//
// Host-generated parameter UI for any PhobosEffect. Renders the appropriate
// control for each ParamDef in the manifest. Never uses plugin-provided UI.
//
// Preview:
//   - On parameter change, debounces 80ms then calls renderPreview().
//   - renderPreview() downsizes the active layer to a thumbnail (≤300px wide),
//     runs the effect via PluginWorker, displays result on a canvas element.
//   - The preview render shares the same PluginWorker path as the final render.
//
// Apply:
//   - Renders at full resolution via PluginWorker.
//   - Wraps result in a RasterCommand (full-layer snapshot) and emits it.
//   - Dialog closes after apply.
// =============================================================================

const PREVIEW_MAX_PX = 300;
const DEBOUNCE_MS    = 80;

interface EffectDialogProps {
  manifest:  PhobosPluginManifest;
  doc:       PhobosDocument;
  worker:    PluginWorker;
  emitter:   CommandEmitter;
  onClose:   () => void;
}

type ParamValues = Record<string, number | boolean | string | CurvePoint[]>;

export function EffectDialog({ manifest, doc, worker, emitter, onClose }: EffectDialogProps) {
  // Initialise params from manifest defaults.
  const [params, setParams] = useState<ParamValues>(() => {
    const init: ParamValues = {};
    for (const p of manifest.parameters) {
      init[p.id] = p.default;
    }
    return init;
  });

  const [applying,  setApplying]  = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const previewRef  = useRef<HTMLCanvasElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------------------------------------------------------------------------
  // Preview
  // ---------------------------------------------------------------------------

  const renderPreview = useCallback(async (currentParams: ParamValues) => {
    if (!manifest.supportsPreview) return;
    const canvas = previewRef.current;
    if (!canvas) return;

    const layer  = doc.activeLayer;
    const aspect = layer.physicalWidth / layer.physicalHeight;
    const pw     = Math.min(PREVIEW_MAX_PX, layer.physicalWidth);
    const ph     = Math.round(pw / aspect);

    // Draw downscaled layer onto an offscreen canvas.
    const thumb    = new OffscreenCanvas(pw, ph);
    const thumbCtx = thumb.getContext('2d')!;
    thumbCtx.drawImage(layer.canvas, 0, 0, pw, ph);
    const thumbData = thumbCtx.getImageData(0, 0, pw, ph);

    const src = allocatePixelBuffer(pw, ph);
    const dst = allocatePixelBuffer(pw, ph);
    copyImageDataToBuffer(thumbData, src);

    // Mask for preview: use selection mask downscaled (approximate).
    // In v1 we pass no mask for preview — selection awareness on preview
    // is a Phase 2 improvement.

    try {
      await worker.render(
        manifest.id,
        src, dst, pw, ph,
        currentParams as Record<string, number | boolean | string>,
      );

      const resultData = thumbCtx.getImageData(0, 0, pw, ph);
      copyBufferToImageData(dst, resultData);

      // Draw result onto the visible preview canvas.
      canvas.width  = pw;
      canvas.height = ph;
      const displayCtx = canvas.getContext('2d')!;
      displayCtx.putImageData(resultData, 0, 0);
    } catch {
      // Preview failure is non-fatal — silently ignore.
    }
  }, [manifest, doc, worker]);

  // Trigger debounced preview on param change.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void renderPreview(params);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [params, renderPreview]);

  // Initial preview on mount.
  useEffect(() => { void renderPreview(params); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Apply
  // ---------------------------------------------------------------------------

  const handleApply = useCallback(async () => {
    setApplying(true);
    setError(null);

    const layer  = doc.activeLayer;
    const physW  = doc.physicalWidth;
    const physH  = doc.physicalHeight;
    const mask   = doc.selection;

    const imgData = layer.getImageData();
    const src     = allocatePixelBuffer(physW, physH);
    const dst     = allocatePixelBuffer(physW, physH);
    copyImageDataToBuffer(imgData, src);

    // Copy mask into a SharedArrayBuffer if selection is active.
    const maskSab = mask.empty ? undefined : (() => {
      const sab = new SharedArrayBuffer(mask.data.length);
      new Uint8Array(sab).set(mask.data);
      return sab;
    })();

    try {
      await worker.render(
        manifest.id,
        src, dst, physW, physH,
        params as Record<string, number | boolean | string>,
        maskSab,
      );

      // Wrap the result in a RasterCommand so it's undoable.
      const preSnapshot = layer.snapshot();  // full layer snapshot before apply

      const cmd = new RasterCommand(manifest.name, layer, undefined, () => {
        const resultData = layer.getImageData();
        copyBufferToImageData(dst, resultData);
        layer.putImageData(resultData);
      });

      // Inject pre-snapshot (same pattern as PaintBrushTool's LiveStrokeCommand).
      (cmd as unknown as { snapshot: Uint8ClampedArray }).snapshot = preSnapshot;

      emitter(cmd);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setApplying(false);
    }
  }, [manifest, doc, worker, params, emitter, onClose]);

  // ---------------------------------------------------------------------------
  // Param change handler
  // ---------------------------------------------------------------------------

  const handleChange = useCallback((id: string, value: number | boolean | string | CurvePoint[]) => {
    setParams(prev => ({ ...prev, [id]: value }));
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div style={styles.overlay}>
      <div style={styles.dialog}>
        <div style={styles.header}>
          <span style={styles.title}>{manifest.name}</span>
          <button style={styles.closeBtn} onClick={onClose} disabled={applying}>✕</button>
        </div>

        <div style={styles.body}>
          {/* Preview canvas */}
          {manifest.supportsPreview && (
            <div style={styles.previewWrap}>
              <canvas ref={previewRef} style={styles.previewCanvas} />
            </div>
          )}

          {/* Parameter controls */}
          <div style={styles.params}>
            {manifest.parameters.map(param => (
              <ParamControl
                key={param.id}
                param={param}
                value={params[param.id]}
                onChange={handleChange}
                disabled={applying}
              />
            ))}
          </div>
        </div>

        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.footer}>
          <button style={styles.cancelBtn} onClick={onClose} disabled={applying}>
            Cancel
          </button>
          <button style={styles.applyBtn} onClick={handleApply} disabled={applying}>
            {applying ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// ParamControl — renders the appropriate input for each ParamDef type
// =============================================================================

interface ParamControlProps {
  param:    ParamDef;
  value:    number | boolean | string | CurvePoint[];
  onChange: (id: string, value: number | boolean | string | CurvePoint[]) => void;
  disabled: boolean;
}

function ParamControl({ param, value, onChange, disabled }: ParamControlProps) {
  switch (param.type) {
    case 'int':
    case 'float': {
      const num = value as number;
      return (
        <label style={styles.label}>
          <span style={styles.labelText}>{param.label}</span>
          <div style={styles.sliderRow}>
            <input
              type="range"
              min={param.min}
              max={param.max}
              step={param.step ?? (param.type === 'int' ? 1 : 0.01)}
              value={num}
              disabled={disabled}
              onChange={e => onChange(param.id, param.type === 'int'
                ? parseInt(e.target.value, 10)
                : parseFloat(e.target.value))}
              style={styles.slider}
            />
            <input
              type="number"
              min={param.min}
              max={param.max}
              step={param.step ?? (param.type === 'int' ? 1 : 0.01)}
              value={num}
              disabled={disabled}
              onChange={e => onChange(param.id, param.type === 'int'
                ? parseInt(e.target.value, 10)
                : parseFloat(e.target.value))}
              style={styles.numberInput}
            />
          </div>
        </label>
      );
    }

    case 'bool':
      return (
        <label style={styles.labelInline}>
          <input
            type="checkbox"
            checked={value as boolean}
            disabled={disabled}
            onChange={e => onChange(param.id, e.target.checked)}
          />
          <span style={{ marginLeft: 8 }}>{param.label}</span>
        </label>
      );

    case 'enum':
      return (
        <label style={styles.label}>
          <span style={styles.labelText}>{param.label}</span>
          <select
            value={value as string}
            disabled={disabled}
            onChange={e => onChange(param.id, e.target.value)}
            style={styles.select}
          >
            {param.options.map(opt => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </label>
      );

    case 'color':
      return (
        <label style={styles.label}>
          <span style={styles.labelText}>{param.label}</span>
          <input
            type="color"
            value={(value as string).slice(0, 7)}  // strip alpha for color input
            disabled={disabled}
            onChange={e => onChange(param.id, e.target.value + 'ff')}
            style={styles.colorInput}
          />
        </label>
      );

    case 'curve':
      return (
        <div style={styles.label}>
          <span style={styles.labelText}>{param.label}</span>
          <CurveEditor
            points={value as CurvePoint[]}
            disabled={disabled}
            onChange={pts => onChange(param.id, pts)}
          />
        </div>
      );

    default:
      return null;
  }
}

// =============================================================================
// CurveEditor
//
// 200×200 canvas widget. Renders a diagonal identity grid, the interpolated
// curve, and draggable control points.
//
// Interactions:
//   Left-click empty area  → add point at that position
//   Left-drag point        → move point
//   Right-click point      → delete point (min 2 points preserved)
// =============================================================================

const CE_SIZE   = 200;   // canvas CSS + physical px (1:1, no dpr scaling needed here)
const PT_RADIUS = 5;     // hit-test and draw radius

interface CurveEditorProps {
  points:   CurvePoint[];
  disabled: boolean;
  onChange: (pts: CurvePoint[]) => void;
}

function CurveEditor({ points, disabled, onChange }: CurveEditorProps) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const dragRef    = useRef<number | null>(null);   // index of point being dragged

  // Evaluate monotone cubic spline at every integer x 0–255, return y[].
  // Mirrors the logic in CurvesEffect so preview matches editor curve exactly.
  const evalSpline = useCallback((pts: CurvePoint[]): Uint8ClampedArray => {
    const lut    = new Uint8ClampedArray(256);
    const sorted = pts
      .slice()
      .sort((a, b) => a.x - b.x)
      .map(p => ({ x: Math.max(0, Math.min(255, p.x)), y: Math.max(0, Math.min(255, p.y)) }));

    if (sorted.length === 0) { for (let i = 0; i < 256; i++) lut[i] = i; return lut; }
    if (sorted.length === 1) { lut.fill(sorted[0].y); return lut; }

    if (sorted[0].x > 0)   sorted.unshift({ x: 0,   y: sorted[0].y });
    if (sorted[sorted.length - 1].x < 255) sorted.push({ x: 255, y: sorted[sorted.length - 1].y });

    const n = sorted.length;
    if (n === 2) {
      for (let v = 0; v <= 255; v++) {
        const t = (v - sorted[0].x) / (sorted[1].x - sorted[0].x || 1);
        lut[v]  = Math.max(0, Math.min(255, (sorted[0].y + t * (sorted[1].y - sorted[0].y)) | 0));
      }
      return lut;
    }

    const delta: number[] = new Array(n - 1);
    const m:     number[] = new Array(n);
    for (let i = 0; i < n - 1; i++) {
      delta[i] = (sorted[i + 1].y - sorted[i].y) / (sorted[i + 1].x - sorted[i].x || 1);
    }
    m[0] = delta[0]; m[n - 1] = delta[n - 2];
    for (let i = 1; i < n - 1; i++) {
      m[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2;
    }
    for (let i = 0; i < n - 1; i++) {
      if (Math.abs(delta[i]) < 1e-10) { m[i] = 0; m[i + 1] = 0; }
      else {
        const a = m[i] / delta[i]; const b = m[i + 1] / delta[i];
        const hh = Math.sqrt(a * a + b * b);
        if (hh > 3) { m[i] = 3 * delta[i] / hh * a; m[i + 1] = 3 * delta[i] / hh * b; }
      }
    }
    let seg = 0;
    for (let v = 0; v <= 255; v++) {
      while (seg < n - 2 && v > sorted[seg + 1].x) seg++;
      const x0 = sorted[seg].x; const x1 = sorted[seg + 1].x;
      const y0 = sorted[seg].y; const y1 = sorted[seg + 1].y;
      const dx = x1 - x0 || 1; const t = (v - x0) / dx;
      const t2 = t * t; const t3 = t2 * t;
      const y  = (2*t3 - 3*t2 + 1)*y0 + (t3 - 2*t2 + t)*dx*m[seg]
               + (-2*t3 + 3*t2)*y1 + (t3 - t2)*dx*m[seg + 1];
      lut[v] = Math.max(0, Math.min(255, y | 0));
    }
    return lut;
  }, []);

  // Draw the curve and control points onto the canvas.
  const draw = useCallback((pts: CurvePoint[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const S   = CE_SIZE;

    ctx.clearRect(0, 0, S, S);

    // Background.
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, S, S);

    // Grid lines (quarters).
    ctx.strokeStyle = 'hsl(var(--secondary))';
    ctx.lineWidth   = 1;
    for (let i = 1; i < 4; i++) {
      const v = (i / 4) * S;
      ctx.beginPath(); ctx.moveTo(v, 0); ctx.lineTo(v, S); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, v); ctx.lineTo(S, v); ctx.stroke();
    }

    // Identity diagonal.
    ctx.strokeStyle = '#333';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(0, S); ctx.lineTo(S, 0); ctx.stroke();

    // Spline curve.
    const lut = evalSpline(pts);
    ctx.strokeStyle = '#4a7fe8';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    for (let x = 0; x <= 255; x++) {
      const cx = (x / 255) * S;
      const cy = S - (lut[x] / 255) * S;
      x === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy);
    }
    ctx.stroke();

    // Control points.
    for (const pt of pts) {
      const cx = (pt.x / 255) * S;
      const cy = S - (pt.y / 255) * S;
      ctx.fillStyle   = '#fff';
      ctx.strokeStyle = '#4a7fe8';
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, PT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }, [evalSpline]);

  // Redraw whenever points change.
  useEffect(() => { draw(points); }, [points, draw]);

  // Convert canvas pixel coords to CurvePoint space.
  const canvasToCurve = (ex: number, ey: number, rect: DOMRect): CurvePoint => ({
    x: Math.max(0, Math.min(255, Math.round(((ex - rect.left) / CE_SIZE) * 255))),
    y: Math.max(0, Math.min(255, Math.round((1 - (ey - rect.top) / CE_SIZE) * 255))),
  });

  // Return index of closest point within hit radius, or -1.
  const hitTest = (ex: number, ey: number, rect: DOMRect): number => {
    let best = -1; let bestDist = PT_RADIUS * PT_RADIUS * 4;
    for (let i = 0; i < points.length; i++) {
      const cx = (points[i].x / 255) * CE_SIZE + rect.left;
      const cy = (1 - points[i].y / 255) * CE_SIZE + rect.top;
      const d  = (ex - cx) ** 2 + (ey - cy) ** 2;
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  };

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    const hit  = hitTest(e.clientX, e.clientY, rect);

    if (e.button === 2) {
      // Right-click: delete point (keep at least 2).
      if (hit >= 0 && points.length > 2) {
        const next = points.filter((_, i) => i !== hit);
        onChange(next);
      }
      return;
    }

    if (hit >= 0) {
      // Start drag.
      dragRef.current = hit;
    } else {
      // Add new point.
      const pt   = canvasToCurve(e.clientX, e.clientY, rect);
      const next = [...points, pt];
      onChange(next);
      dragRef.current = next.length - 1;
    }
  }, [disabled, points, onChange]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (dragRef.current === null || disabled) return;
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    const pt   = canvasToCurve(e.clientX, e.clientY, rect);
    const next = points.map((p, i) => i === dragRef.current ? pt : p);
    onChange(next);
  }, [disabled, points, onChange]);

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={CE_SIZE}
      height={CE_SIZE}
      style={{
        display:       'block',
        borderRadius:  3,
        border:        '1px solid #444',
        cursor:        disabled ? 'not-allowed' : 'crosshair',
        userSelect:    'none',
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onContextMenu={e => e.preventDefault()}
    />
  );
}

// =============================================================================
// Styles — plain objects, no external CSS dependency
// =============================================================================

const styles = {
  overlay: {
    position:        'fixed' as const,
    inset:           0,
    background:      'rgba(0,0,0,0.45)',
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'center',
    zIndex:          1000,
  },
  dialog: {
    background:    'hsl(var(--secondary))',
    color:         '#e8e8e8',
    borderRadius:  6,
    width:         360,
    maxHeight:     '85vh',
    display:       'flex',
    flexDirection: 'column' as const,
    boxShadow:     '0 8px 32px rgba(0,0,0,0.6)',
    fontFamily:    'system-ui, sans-serif',
    fontSize:      13,
  },
  header: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    padding:        '12px 16px',
    borderBottom:   '1px solid #3a3a3a',
  },
  title: {
    fontWeight: 600,
    fontSize:   14,
  },
  closeBtn: {
    background:  'none',
    border:      'none',
    color:       '#999',
    cursor:      'pointer',
    fontSize:    16,
    lineHeight:  1,
    padding:     0,
  },
  body: {
    overflowY:  'auto' as const,
    padding:    '12px 16px',
    flex:       1,
  },
  previewWrap: {
    marginBottom:  12,
    borderRadius:  4,
    overflow:      'hidden',
    background:    'hsl(var(--card))',
    display:       'flex',
    justifyContent: 'center',
  },
  previewCanvas: {
    maxWidth:  '100%',
    display:   'block',
    imageRendering: 'pixelated' as const,
  },
  params: {
    display:       'flex',
    flexDirection: 'column' as const,
    gap:           10,
  },
  label: {
    display:       'flex',
    flexDirection: 'column' as const,
    gap:           4,
  },
  labelInline: {
    display:    'flex',
    alignItems: 'center',
    cursor:     'pointer',
  },
  labelText: {
    color:     '#aaa',
    fontSize:  12,
  },
  sliderRow: {
    display:    'flex',
    alignItems: 'center',
    gap:        8,
  },
  slider: {
    flex:   1,
    cursor: 'pointer',
  },
  numberInput: {
    width:      56,
    background: 'hsl(var(--card))',
    border:     '1px solid #444',
    color:      '#e8e8e8',
    borderRadius: 3,
    padding:    '2px 4px',
    fontSize:   12,
    textAlign:  'right' as const,
  },
  select: {
    background:   'hsl(var(--card))',
    border:       '1px solid #444',
    color:        '#e8e8e8',
    borderRadius: 3,
    padding:      '4px 6px',
    fontSize:     12,
    cursor:       'pointer',
  },
  colorInput: {
    width:  40,
    height: 28,
    border: '1px solid #444',
    borderRadius: 3,
    cursor: 'pointer',
    padding: 2,
    background: 'none',
  },
  error: {
    margin:      '0 16px 8px',
    padding:     '8px 10px',
    background:  '#3a1a1a',
    borderRadius: 3,
    color:       '#f88',
    fontSize:    12,
  },
  footer: {
    display:        'flex',
    justifyContent: 'flex-end',
    gap:            8,
    padding:        '10px 16px',
    borderTop:      '1px solid #3a3a3a',
  },
  cancelBtn: {
    background:   '#3a3a3a',
    border:       '1px solid #555',
    color:        '#e8e8e8',
    borderRadius: 4,
    padding:      '6px 14px',
    cursor:       'pointer',
    fontSize:     13,
  },
  applyBtn: {
    background:   '#4a7fe8',
    border:       'none',
    color:        '#fff',
    borderRadius: 4,
    padding:      '6px 14px',
    cursor:       'pointer',
    fontSize:     13,
    fontWeight:   600,
  },
} as const;
