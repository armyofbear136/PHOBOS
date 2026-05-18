import type {
  PhobosEffect,
  PhobosPluginManifest,
  PhobosRenderContext,
} from '../../types';
import { writePixelMasked } from '../SelectionMaskHelpers';

// =============================================================================
// GaussianBlurEffect
//
// Separable Gaussian blur: horizontal pass → scratch buffer, vertical pass →
// dst. Two single-channel passes over the pixel data are faster than one
// 2D convolution pass and produce identical output.
//
// Kernel is pre-computed in the constructor for the maximum possible radius
// (100px). For each render call the kernel is recomputed only when radius
// has changed since the last call (cached).
//
// The scratch buffer is allocated once in the constructor at the maximum
// canvas size passed in. It is reused across all render calls.
//
// Quality levels map to kernel truncation:
//   draft  → sigma = radius / 3   (small kernel, fast, visible banding)
//   good   → sigma = radius / 2   (balanced)
//   best   → sigma = radius       (full Gaussian falloff, accurate)
// =============================================================================

const MAX_RADIUS = 100;

export class GaussianBlurEffect implements PhobosEffect {
  // Pre-allocated scratch buffer — horizontal pass output (RGBA).
  // Sized to the maximum pixel count this effect will ever be called with.
  // The caller (PluginRegistry / bootstrap) must pass maxPixels at construction.
  private readonly scratch: Float32Array;

  // Kernel cache
  private kernelRadius: number;
  private kernelSigma:  number;
  private kernel:       Float32Array;

  constructor(maxPixels: number) {
    // 4 channels × maxPixels
    this.scratch      = new Float32Array(maxPixels * 4);
    this.kernelRadius = -1;  // sentinel — no kernel cached yet
    this.kernelSigma  = -1;
    this.kernel       = new Float32Array(MAX_RADIUS * 2 + 1);
  }

  describe(): PhobosPluginManifest {
    return {
      id:                'dev.phobos.gaussian-blur',
      name:              'Gaussian Blur',
      category:          'Blur',
      type:              'AreaFilter',
      version:           '1.0.0',
      supportsSelection: true,
      supportsPreview:   true,
      parameters: [
        {
          id:      'radius',
          label:   'Radius',
          type:    'int',
          default: 4,
          min:     1,
          max:     MAX_RADIUS,
          step:    1,
        },
        {
          id:      'quality',
          label:   'Quality',
          type:    'enum',
          default: 'good',
          options: ['draft', 'good', 'best'],
        },
      ],
    };
  }

  render(ctx: PhobosRenderContext): void {
    const { src, dst, width, height, params, mask, progress } = ctx;

    const radius  = Math.max(1, Math.min(MAX_RADIUS, params['radius'] as number));
    const quality = params['quality'] as string;
    const sigma   = quality === 'draft' ? radius / 3
                  : quality === 'best'  ? radius
                  : radius / 2;                         // 'good' (default)

    this._ensureKernel(radius, sigma);
    const kernel   = this.kernel;
    const kLen     = radius * 2 + 1;
    const scratch  = this.scratch;
    const hasMask  = mask !== undefined;

    // ── Horizontal pass: src → scratch ────────────────────────────────────────
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0, b = 0, a = 0, wSum = 0;

        for (let ki = 0; ki < kLen; ki++) {
          const sx  = Math.max(0, Math.min(width - 1, x + ki - radius));
          const si  = (y * width + sx) * 4;
          const w   = kernel[ki];
          r += src[si]     * w;
          g += src[si + 1] * w;
          b += src[si + 2] * w;
          a += src[si + 3] * w;
          wSum += w;
        }

        const di          = (y * width + x) * 4;
        scratch[di]     = r / wSum;
        scratch[di + 1] = g / wSum;
        scratch[di + 2] = b / wSum;
        scratch[di + 3] = a / wSum;
      }

      if (y % 10 === 0) progress(y / height * 0.5);
    }

    // ── Vertical pass: scratch → dst ──────────────────────────────────────────
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0, b = 0, a = 0, wSum = 0;

        for (let ki = 0; ki < kLen; ki++) {
          const sy  = Math.max(0, Math.min(height - 1, y + ki - radius));
          const si  = (sy * width + x) * 4;
          const w   = kernel[ki];
          r += scratch[si]     * w;
          g += scratch[si + 1] * w;
          b += scratch[si + 2] * w;
          a += scratch[si + 3] * w;
          wSum += w;
        }

        const i = (y * width + x) * 4;
        if (hasMask) {
          writePixelMasked(dst, mask!, i,
            r / wSum | 0,
            g / wSum | 0,
            b / wSum | 0,
            a / wSum | 0,
          );
        } else {
          dst[i]     = r / wSum | 0;
          dst[i + 1] = g / wSum | 0;
          dst[i + 2] = b / wSum | 0;
          dst[i + 3] = a / wSum | 0;
        }
      }

      if (y % 10 === 0) progress(0.5 + y / height * 0.5);
    }
  }

  // ---------------------------------------------------------------------------
  // Kernel computation — cached by (radius, sigma)
  // ---------------------------------------------------------------------------

  private _ensureKernel(radius: number, sigma: number): void {
    if (radius === this.kernelRadius && sigma === this.kernelSigma) return;
    this.kernelRadius = radius;
    this.kernelSigma  = sigma;

    const twoSigmaSq = 2 * sigma * sigma;
    for (let i = 0; i <= radius * 2; i++) {
      const x         = i - radius;
      this.kernel[i]  = Math.exp(-(x * x) / twoSigmaSq);
    }
    // Kernel is not normalised here — we normalise during convolution via wSum.
  }
}

// =============================================================================
// Standalone writePixelMasked helper re-export
//
// GaussianBlurEffect needs writePixelMasked but cannot import SelectionMask
// (which is in the editor module) because effects run in the worker and must
// be independent of the editor module tree. The helper is duplicated into a
// thin plugin-local helper module imported above.
// =============================================================================
