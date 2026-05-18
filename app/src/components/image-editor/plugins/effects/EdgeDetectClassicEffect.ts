import type {
  PhobosEffect,
  PhobosPluginManifest,
  PhobosRenderContext,
} from '../../types';
import { writePixelMaskedRaw as writePixelMasked } from '../../editor/SelectionMask';

// =============================================================================
// EdgeDetectClassicEffect  —  Sobel 3×3
//
// Computes per-pixel edge magnitude using the Sobel operator applied to the
// luminance channel. The result is optionally inverted (white edges on black)
// or left as-is (dark edges on white, classic sketch look).
//
// Sobel kernels:
//   Gx = [[-1, 0, 1],          Gy = [[-1,-2,-1],
//          [-2, 0, 2],                [ 0, 0, 0],
//          [-1, 0, 1]]                [ 1, 2, 1]]
//
// Edge magnitude: sqrt(Gx² + Gy²), clamped to 0–255.
//
// Parameters:
//   strength  0.0–2.0     Multiplier on the raw magnitude before clamping.
//   invert    bool        Invert output (white edges on black background).
//   colour    bool        When true, apply Sobel to each RGB channel
//                         independently and composite into a colour edge map.
//                         When false, use luminance only (greyscale output).
//
// Allocation: no scratch buffer needed — Sobel reads src directly.
// =============================================================================

// Sobel kernel — Gx row weights (applied to luminance or per-channel).
// [col-1, col, col+1] for rows [row-1, row, row+1]:
const GX = [-1, 0, 1, -2, 0, 2, -1, 0, 1] as const;
const GY = [-1,-2,-1,  0, 0, 0,  1, 2, 1] as const;

export class EdgeDetectClassicEffect implements PhobosEffect {
  describe(): PhobosPluginManifest {
    return {
      id:                'dev.phobos.edge-detect-classic',
      name:              'Edge Detect (Classic)',
      category:          'Stylise',
      type:              'AreaFilter',
      version:           '1.0.0',
      supportsSelection: true,
      supportsPreview:   true,
      parameters: [
        {
          id:      'strength',
          label:   'Strength',
          type:    'float',
          default: 1.0,
          min:     0.0,
          max:     2.0,
          step:    0.05,
        },
        {
          id:      'invert',
          label:   'White edges on black',
          type:    'bool',
          default: true,
        },
        {
          id:      'colour',
          label:   'Colour edges',
          type:    'bool',
          default: false,
        },
      ],
    };
  }

  render(ctx: PhobosRenderContext): void {
    const { src, dst, width, height, params, mask, progress } = ctx;

    const strength = Math.max(0, Math.min(2.0, params['strength'] as number));
    const invert   = params['invert']  as boolean;
    const colour   = params['colour']  as boolean;

    const W = width;
    const H = height;

    // Clamp pixel coordinate to image bounds (replicate border).
    const idx = (x: number, y: number): number => {
      const cx = Math.max(0, Math.min(W - 1, x));
      const cy = Math.max(0, Math.min(H - 1, y));
      return (cy * W + cx) * 4;
    };

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const bi = (y * W + x) * 4;

        let outR: number;
        let outG: number;
        let outB: number;

        if (colour) {
          // Per-channel Sobel.
          let gxR = 0, gyR = 0;
          let gxG = 0, gyG = 0;
          let gxB = 0, gyB = 0;

          for (let ky = -1; ky <= 1; ky++) {
            for (let kx = -1; kx <= 1; kx++) {
              const ki = (ky + 1) * 3 + (kx + 1);
              const si = idx(x + kx, y + ky);
              gxR += src[si]     * GX[ki];
              gyR += src[si]     * GY[ki];
              gxG += src[si + 1] * GX[ki];
              gyG += src[si + 1] * GY[ki];
              gxB += src[si + 2] * GX[ki];
              gyB += src[si + 2] * GY[ki];
            }
          }

          outR = Math.min(255, Math.sqrt(gxR * gxR + gyR * gyR) * strength) | 0;
          outG = Math.min(255, Math.sqrt(gxG * gxG + gyG * gyG) * strength) | 0;
          outB = Math.min(255, Math.sqrt(gxB * gxB + gyB * gyB) * strength) | 0;
        } else {
          // Luminance Sobel.
          let gx = 0, gy = 0;

          for (let ky = -1; ky <= 1; ky++) {
            for (let kx = -1; kx <= 1; kx++) {
              const ki  = (ky + 1) * 3 + (kx + 1);
              const si  = idx(x + kx, y + ky);
              // Rec. 601 luma weights.
              const lum = 0.299 * src[si] + 0.587 * src[si + 1] + 0.114 * src[si + 2];
              gx += lum * GX[ki];
              gy += lum * GY[ki];
            }
          }

          const mag = Math.min(255, Math.sqrt(gx * gx + gy * gy) * strength) | 0;
          outR = mag;
          outG = mag;
          outB = mag;
        }

        if (invert) {
          writePixelMasked(dst, mask, bi, outR, outG, outB, src[bi + 3]);
        } else {
          writePixelMasked(dst, mask, bi,
            255 - outR,
            255 - outG,
            255 - outB,
            src[bi + 3],
          );
        }
      }

      if (y % 16 === 0) progress(y / H);
    }
  }
}
