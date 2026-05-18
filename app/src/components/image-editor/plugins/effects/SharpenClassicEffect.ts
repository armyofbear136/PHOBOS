import type {
  PhobosEffect,
  PhobosPluginManifest,
  PhobosRenderContext,
} from '../../types';
import { writePixelMaskedRaw as writePixelMasked } from '../../editor/SelectionMask';

// =============================================================================
// SharpenClassicEffect  —  Unsharp Mask
//
// USM formula:  dst = src + amount * (src - blurred)
//
// A single-pass box blur (separable, two passes over scratch) is used for the
// blur step. Box blur is a good USM base — it sharpens edges without the
// ringing artifacts of a Gaussian with the same radius.
//
// Parameters:
//   radius  1–20 px     Half-width of the box blur kernel.
//   amount  0.0–3.0     Sharpening strength multiplier.
//   threshold 0–255     Minimum per-channel difference before sharpening is
//                       applied (suppresses noise amplification in flat areas).
//
// Allocation:
//   scratch  Float32Array, 4 channels × maxPixels — allocated once at
//            construction, reused across all calls.
// =============================================================================

const MAX_RADIUS = 20;

export class SharpenClassicEffect implements PhobosEffect {
  private readonly scratch: Float32Array;

  constructor(maxPixels: number) {
    this.scratch = new Float32Array(maxPixels * 4);
  }

  describe(): PhobosPluginManifest {
    return {
      id:                'dev.phobos.sharpen-classic',
      name:              'Sharpen (Classic)',
      category:          'Sharpen',
      type:              'AreaFilter',
      version:           '1.0.0',
      supportsSelection: true,
      supportsPreview:   true,
      parameters: [
        {
          id:      'radius',
          label:   'Radius',
          type:    'int',
          default: 2,
          min:     1,
          max:     MAX_RADIUS,
          step:    1,
        },
        {
          id:      'amount',
          label:   'Amount',
          type:    'float',
          default: 1.0,
          min:     0.0,
          max:     3.0,
          step:    0.05,
        },
        {
          id:      'threshold',
          label:   'Threshold',
          type:    'int',
          default: 0,
          min:     0,
          max:     255,
          step:    1,
        },
      ],
    };
  }

  render(ctx: PhobosRenderContext): void {
    const { src, dst, width, height, params, mask, progress } = ctx;

    const radius    = Math.max(1, Math.min(MAX_RADIUS, params['radius']    as number));
    const amount    = Math.max(0, Math.min(3.0,        params['amount']    as number));
    const threshold = Math.max(0, Math.min(255,        params['threshold'] as number));

    const scratch = this.scratch;
    const kLen    = radius * 2 + 1;
    const kWeight = 1 / kLen;   // uniform box kernel weight

    // ── Horizontal box blur pass: src → scratch ───────────────────────────────
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0, b = 0, a = 0;

        for (let ki = -radius; ki <= radius; ki++) {
          const sx = Math.max(0, Math.min(width - 1, x + ki));
          const si = (y * width + sx) * 4;
          r += src[si];
          g += src[si + 1];
          b += src[si + 2];
          a += src[si + 3];
        }

        const di          = (y * width + x) * 4;
        scratch[di]     = r * kWeight;
        scratch[di + 1] = g * kWeight;
        scratch[di + 2] = b * kWeight;
        scratch[di + 3] = a * kWeight;
      }

      if (y % 16 === 0) progress(y / height * 0.4);
    }

    // ── Vertical box blur pass + USM composite: scratch → dst ────────────────
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let br = 0, bg = 0, bb = 0, ba = 0;

        for (let ki = -radius; ki <= radius; ki++) {
          const sy = Math.max(0, Math.min(height - 1, y + ki));
          const si = (sy * width + x) * 4;
          br += scratch[si];
          bg += scratch[si + 1];
          bb += scratch[si + 2];
          ba += scratch[si + 3];
        }

        const blurR = br * kWeight;
        const blurG = bg * kWeight;
        const blurB = bb * kWeight;
        const blurA = ba * kWeight;

        const bi   = (y * width + x) * 4;
        const srcR = src[bi];
        const srcG = src[bi + 1];
        const srcB = src[bi + 2];
        const srcA = src[bi + 3];

        // Unsharp mask: apply only if diff exceeds threshold.
        const diffR = srcR - blurR;
        const diffG = srcG - blurG;
        const diffB = srcB - blurB;

        const outR = Math.abs(diffR) > threshold ? Math.max(0, Math.min(255, srcR + amount * diffR)) | 0 : srcR;
        const outG = Math.abs(diffG) > threshold ? Math.max(0, Math.min(255, srcG + amount * diffG)) | 0 : srcG;
        const outB = Math.abs(diffB) > threshold ? Math.max(0, Math.min(255, srcB + amount * diffB)) | 0 : srcB;

        writePixelMasked(dst, mask, bi, outR, outG, outB, srcA);
      }

      if (y % 16 === 0) progress(0.4 + y / height * 0.6);
    }
  }
}
