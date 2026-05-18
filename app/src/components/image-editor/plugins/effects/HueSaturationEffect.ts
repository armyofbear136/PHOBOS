import type {
  PhobosEffect,
  PhobosPluginManifest,
  PhobosRenderContext,
} from '../../types';
import { writePixelMaskedRaw as writePixelMasked } from '../../editor/SelectionMask';

// =============================================================================
// HueSaturationEffect
//
// Hue:        rotation in degrees (-180 to +180), applied in HSL space.
// Saturation: additive adjustment (-100 to +100).
// Lightness:  additive adjustment (-100 to +100), applied as LUT in RGB space
//             for performance — separate from H/S which require HSL conversion.
//
// Pipeline per pixel:
//   RGB → HSL → (H + hue, clamp(S + sat, 0, 1), L) → RGB → write
//
// HSL ↔ RGB is the standard algorithm. No external library.
// =============================================================================

export class HueSaturationEffect implements PhobosEffect {
  describe(): PhobosPluginManifest {
    return {
      id:                'dev.phobos.hue-saturation',
      name:              'Hue / Saturation',
      category:          'Colour',
      type:              'PixelFilter',
      version:           '1.0.0',
      supportsSelection: true,
      supportsPreview:   true,
      parameters: [
        { id: 'hue',        label: 'Hue',        type: 'int', default: 0,   min: -180, max: 180 },
        { id: 'saturation', label: 'Saturation', type: 'int', default: 0,   min: -100, max: 100 },
        { id: 'lightness',  label: 'Lightness',  type: 'int', default: 0,   min: -100, max: 100 },
      ],
    };
  }

  render(ctx: PhobosRenderContext): void {
    const hueDelta  = (ctx.params['hue']        as number) / 360;  // normalised 0–1
    const satDelta  = (ctx.params['saturation'] as number) / 100;
    const lightDelta = (ctx.params['lightness'] as number) / 100;

    const { src, dst, width, height, mask, progress } = ctx;
    const pixels = width * height;

    for (let i = 0; i < pixels; i++) {
      const bi = i * 4;
      const r  = src[bi]     / 255;
      const g  = src[bi + 1] / 255;
      const b  = src[bi + 2] / 255;
      const a  = src[bi + 3];

      const [h, s, l] = rgbToHsl(r, g, b);

      const newH = (h + hueDelta + 1) % 1;
      const newS = Math.max(0, Math.min(1, s + satDelta));
      const newL = Math.max(0, Math.min(1, l + lightDelta));

      const [nr, ng, nb] = hslToRgb(newH, newS, newL);

      writePixelMasked(dst, mask, bi,
        (nr * 255) | 0,
        (ng * 255) | 0,
        (nb * 255) | 0,
        a,
      );

      if ((i & 0xffff) === 0) progress(i / pixels);
    }
  }
}

// ---------------------------------------------------------------------------
// HSL ↔ RGB — standard algorithms, no allocation
// ---------------------------------------------------------------------------

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max  = Math.max(r, g, b);
  const min  = Math.min(r, g, b);
  const l    = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }

  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
