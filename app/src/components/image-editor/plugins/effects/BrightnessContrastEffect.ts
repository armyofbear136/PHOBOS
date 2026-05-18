import type {
  PhobosEffect,
  PhobosPluginManifest,
  PhobosRenderContext,
} from '../../types';
import { writePixelMaskedRaw as writePixelMasked } from '../../editor/SelectionMask';

// =============================================================================
// BrightnessContrastEffect
//
// Linear brightness/contrast adjustment matching Paint.NET's Simple B/C mode.
//
// Brightness: additive offset on all channels (-100 to +100 → -255 to +255).
// Contrast:   multiplicative scale around mid-grey 128.
//   factor = contrast >= 0 ? 1 + contrast/100 : 1 - contrast/100  (approx)
//   More precisely:
//     factor = (259 * (contrast + 255)) / (255 * (259 - contrast))
//   This matches the industry-standard contrast formula.
//
// Output per channel: clamp((value - 128) * factor + 128 + brightness, 0, 255)
//
// LUT pre-computation: build a 256-entry lookup table at render start so
// the per-pixel loop is a single table read — no floating-point arithmetic
// in the hot path.
// =============================================================================

export class BrightnessContrastEffect implements PhobosEffect {
  // Pre-allocated LUT — recomputed when params change, reused per pixel.
  private readonly lut: Uint8ClampedArray;

  // Cached param values to detect changes.
  private _lastBrightness: number;
  private _lastContrast:   number;

  constructor() {
    this.lut             = new Uint8ClampedArray(256);
    this._lastBrightness = Number.NaN;
    this._lastContrast   = Number.NaN;
  }

  describe(): PhobosPluginManifest {
    return {
      id:                'dev.phobos.brightness-contrast',
      name:              'Brightness / Contrast',
      category:          'Colour',
      type:              'PixelFilter',
      version:           '1.0.0',
      supportsSelection: true,
      supportsPreview:   true,
      parameters: [
        { id: 'brightness', label: 'Brightness', type: 'int', default: 0, min: -100, max: 100 },
        { id: 'contrast',   label: 'Contrast',   type: 'int', default: 0, min: -100, max: 100 },
      ],
    };
  }

  render(ctx: PhobosRenderContext): void {
    const brightness = ctx.params['brightness'] as number;
    const contrast   = ctx.params['contrast']   as number;

    this._ensureLut(brightness, contrast);

    const { src, dst, width, height, mask, progress } = ctx;
    const lut    = this.lut;
    const pixels = width * height;

    for (let i = 0; i < pixels; i++) {
      const bi = i * 4;
      const r  = lut[src[bi]];
      const g  = lut[src[bi + 1]];
      const b  = lut[src[bi + 2]];
      const a  = src[bi + 3];  // alpha unchanged

      writePixelMasked(dst, mask, bi, r, g, b, a);

      if ((i & 0xffff) === 0) progress(i / pixels);
    }
  }

  private _ensureLut(brightness: number, contrast: number): void {
    if (brightness === this._lastBrightness && contrast === this._lastContrast) return;
    this._lastBrightness = brightness;
    this._lastContrast   = contrast;

    const b = brightness * 2.55;  // -100..+100 → -255..+255

    // Standard contrast factor formula.
    const c = contrast;
    const factor = c >= 0
      ? (259 * (c + 255)) / (255 * (259 - c))
      : (259 * (255 + c)) / (255 * (259 - c));

    for (let v = 0; v < 256; v++) {
      this.lut[v] = Math.max(0, Math.min(255, ((v - 128) * factor + 128 + b) | 0));
    }
  }
}
