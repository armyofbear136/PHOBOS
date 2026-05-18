import type {
  PhobosEffect,
  PhobosPluginManifest,
  PhobosRenderContext,
  CurvePoint,
} from '../../types';
import { writePixelMaskedRaw as writePixelMasked } from '../../editor/SelectionMask';

// =============================================================================
// CurvesEffect
//
// Per-channel (or composite RGB) tone curve adjustment. Each curve is defined
// by a set of control points (x = input 0–255, y = output 0–255). Between
// control points, the output is computed by monotone cubic spline interpolation
// — produces smooth, natural-looking curves that always pass through every
// control point and never overshoot (unlike standard cubic splines).
//
// Result is pre-computed into a 256-entry LUT at render time. The LUT is
// cached by a JSON key of the control points so repeated renders with the
// same curve (e.g. preview updates) do not recompute.
//
// Parameters use the 'curve' type — the EffectDialog renders these as an
// interactive bezier editor (Phase 1 UI task). The effect itself only cares
// about the CurvePoint[] array.
// =============================================================================

const DEFAULT_CURVE: CurvePoint[] = [{ x: 0, y: 0 }, { x: 255, y: 255 }];

export class CurvesEffect implements PhobosEffect {
  private readonly lutR: Uint8ClampedArray;
  private readonly lutG: Uint8ClampedArray;
  private readonly lutB: Uint8ClampedArray;
  private _lastKey: string;

  constructor() {
    this.lutR     = new Uint8ClampedArray(256);
    this.lutG     = new Uint8ClampedArray(256);
    this.lutB     = new Uint8ClampedArray(256);
    this._lastKey = '';
    // Identity defaults.
    for (let i = 0; i < 256; i++) { this.lutR[i] = i; this.lutG[i] = i; this.lutB[i] = i; }
  }

  describe(): PhobosPluginManifest {
    return {
      id:                'dev.phobos.curves',
      name:              'Curves',
      category:          'Colour',
      type:              'PixelFilter',
      version:           '1.0.0',
      supportsSelection: true,
      supportsPreview:   true,
      parameters: [
        { id: 'curveR', label: 'Red',   type: 'curve', default: DEFAULT_CURVE },
        { id: 'curveG', label: 'Green', type: 'curve', default: DEFAULT_CURVE },
        { id: 'curveB', label: 'Blue',  type: 'curve', default: DEFAULT_CURVE },
      ],
    };
  }

  render(ctx: PhobosRenderContext): void {
    const curveR = ctx.params['curveR'] as unknown as CurvePoint[];
    const curveG = ctx.params['curveG'] as unknown as CurvePoint[];
    const curveB = ctx.params['curveB'] as unknown as CurvePoint[];

    const key = JSON.stringify([curveR, curveG, curveB]);
    if (key !== this._lastKey) {
      this._lastKey = key;
      buildCurveLut(curveR, this.lutR);
      buildCurveLut(curveG, this.lutG);
      buildCurveLut(curveB, this.lutB);
    }

    const { src, dst, width, height, mask, progress } = ctx;
    const { lutR, lutG, lutB } = this;
    const pixels = width * height;

    for (let i = 0; i < pixels; i++) {
      const bi = i * 4;
      writePixelMasked(dst, mask, bi,
        lutR[src[bi]],
        lutG[src[bi + 1]],
        lutB[src[bi + 2]],
        src[bi + 3],
      );
      if ((i & 0xffff) === 0) progress(i / pixels);
    }
  }
}

// =============================================================================
// Monotone cubic spline interpolation (Fritsch-Carlson method)
//
// Given a sorted list of (x, y) control points, produces a piecewise cubic
// polynomial that:
//   - Passes exactly through every control point.
//   - Is monotone within each interval (no overshoot).
//   - Is C1 continuous (smooth first derivative at joins).
//
// Reference: Fritsch & Carlson (1980), "Monotone Piecewise Cubic Interpolation"
// =============================================================================

function buildCurveLut(pts: CurvePoint[], lut: Uint8ClampedArray): void {
  // Sort and clamp control points.
  const sorted = pts
    .slice()
    .sort((a, b) => a.x - b.x)
    .map(p => ({ x: Math.max(0, Math.min(255, p.x)), y: Math.max(0, Math.min(255, p.y)) }));

  // Single user point → constant output at that y value.
  if (sorted.length === 1) {
    lut.fill(sorted[0].y);
    return;
  }

  // No points → identity.
  if (sorted.length === 0) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return;
  }

  // Ensure endpoints exist.
  if (sorted[0].x > 0) {
    sorted.unshift({ x: 0, y: sorted[0].y });
  }
  if (sorted[sorted.length - 1].x < 255) {
    sorted.push({ x: 255, y: sorted[sorted.length - 1].y });
  }

  const n = sorted.length;

  if (n === 1) {
    lut.fill(sorted[0].y);
    return;
  }

  if (n === 2) {
    // Linear interpolation between two points.
    for (let v = 0; v <= 255; v++) {
      const t  = (v - sorted[0].x) / (sorted[1].x - sorted[0].x);
      lut[v]   = Math.max(0, Math.min(255, (sorted[0].y + t * (sorted[1].y - sorted[0].y)) | 0));
    }
    return;
  }

  // Compute secants.
  const delta: number[] = new Array(n - 1);
  const m:     number[] = new Array(n);

  for (let i = 0; i < n - 1; i++) {
    delta[i] = (sorted[i + 1].y - sorted[i].y) / (sorted[i + 1].x - sorted[i].x || 1);
  }

  // Initialise tangents (Fritsch-Carlson).
  m[0]     = delta[0];
  m[n - 1] = delta[n - 2];

  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) {
      m[i] = 0;
    } else {
      m[i] = (delta[i - 1] + delta[i]) / 2;
    }
  }

  // Enforce monotonicity.
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(delta[i]) < 1e-10) {
      m[i]     = 0;
      m[i + 1] = 0;
    } else {
      const a = m[i]     / delta[i];
      const b = m[i + 1] / delta[i];
      const h = Math.sqrt(a * a + b * b);
      if (h > 3) {
        m[i]     = 3 * delta[i] / h * a;
        m[i + 1] = 3 * delta[i] / h * b;
      }
    }
  }

  // Evaluate spline at every integer x 0–255.
  let seg = 0;
  for (let v = 0; v <= 255; v++) {
    // Advance to the correct segment.
    while (seg < n - 2 && v > sorted[seg + 1].x) seg++;

    const x0 = sorted[seg].x;
    const x1 = sorted[seg + 1].x;
    const y0 = sorted[seg].y;
    const y1 = sorted[seg + 1].y;
    const dx = x1 - x0 || 1;
    const t  = (v - x0) / dx;
    const t2 = t * t;
    const t3 = t2 * t;

    // Hermite basis.
    const h00 =  2 * t3 - 3 * t2 + 1;
    const h10 =      t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 =      t3 -     t2;

    const y = h00 * y0 + h10 * dx * m[seg] + h01 * y1 + h11 * dx * m[seg + 1];
    lut[v]  = Math.max(0, Math.min(255, y | 0));
  }
}
