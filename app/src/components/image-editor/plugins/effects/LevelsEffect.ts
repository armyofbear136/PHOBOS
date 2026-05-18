import type {
  PhobosEffect,
  PhobosPluginManifest,
  PhobosRenderContext,
} from '../../types';
import { writePixelMaskedRaw as writePixelMasked } from '../../editor/SelectionMask';

// =============================================================================
// LevelsEffect
//
// Per-channel (or luminosity) levels adjustment — identical to Photoshop and
// Paint.NET Levels.
//
// Parameters:
//   inputBlack   0–254   — input value that maps to 0 output
//   inputWhite   1–255   — input value that maps to 255 output (must > black)
//   gamma        0.1–10  — midpoint curve (1.0 = linear)
//   outputBlack  0–254   — minimum output value
//   outputWhite  1–255   — maximum output value
//   channel      'rgb' | 'r' | 'g' | 'b'
//
// Pipeline:
//   1. Clamp input to [inputBlack, inputWhite]
//   2. Normalise to 0–1
//   3. Apply gamma: v = v ^ (1/gamma)
//   4. Scale to [outputBlack, outputWhite]
//   → Build a 256-entry LUT, apply per-pixel
// =============================================================================

export class LevelsEffect implements PhobosEffect {
  private readonly lutR: Uint8ClampedArray;
  private readonly lutG: Uint8ClampedArray;
  private readonly lutB: Uint8ClampedArray;

  // Param cache
  private _lastParams: string;

  constructor() {
    this.lutR       = new Uint8ClampedArray(256);
    this.lutG       = new Uint8ClampedArray(256);
    this.lutB       = new Uint8ClampedArray(256);
    this._lastParams = '';
  }

  describe(): PhobosPluginManifest {
    return {
      id:                'dev.phobos.levels',
      name:              'Levels',
      category:          'Colour',
      type:              'PixelFilter',
      version:           '1.0.0',
      supportsSelection: true,
      supportsPreview:   true,
      parameters: [
        { id: 'inputBlack',  label: 'Input Black',  type: 'int',   default: 0,   min: 0,   max: 254 },
        { id: 'inputWhite',  label: 'Input White',  type: 'int',   default: 255, min: 1,   max: 255 },
        { id: 'gamma',       label: 'Gamma',        type: 'float', default: 1.0, min: 0.1, max: 10.0, step: 0.1 },
        { id: 'outputBlack', label: 'Output Black', type: 'int',   default: 0,   min: 0,   max: 254 },
        { id: 'outputWhite', label: 'Output White', type: 'int',   default: 255, min: 1,   max: 255 },
        { id: 'channel',     label: 'Channel',      type: 'enum',  default: 'rgb', options: ['rgb', 'r', 'g', 'b'] },
      ],
    };
  }

  render(ctx: PhobosRenderContext): void {
    const { params } = ctx;
    const key = JSON.stringify(params);
    if (key !== this._lastParams) {
      this._lastParams = key;
      this._buildLuts(
        params['inputBlack']  as number,
        params['inputWhite']  as number,
        params['gamma']       as number,
        params['outputBlack'] as number,
        params['outputWhite'] as number,
        params['channel']     as string,
      );
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

  private _buildLuts(
    inBlack:   number,
    inWhite:   number,
    gamma:     number,
    outBlack:  number,
    outWhite:  number,
    channel:   string,
  ): void {
    const lut = buildLut(inBlack, inWhite, gamma, outBlack, outWhite);

    if (channel === 'rgb' || channel === 'r') this.lutR.set(lut);
    else                                       buildIdentity(this.lutR);

    if (channel === 'rgb' || channel === 'g') this.lutG.set(lut);
    else                                       buildIdentity(this.lutG);

    if (channel === 'rgb' || channel === 'b') this.lutB.set(lut);
    else                                       buildIdentity(this.lutB);
  }
}

// ---------------------------------------------------------------------------
// LUT builders
// ---------------------------------------------------------------------------

function buildLut(
  inBlack:  number,
  inWhite:  number,
  gamma:    number,
  outBlack: number,
  outWhite: number,
): Uint8ClampedArray {
  const lut   = new Uint8ClampedArray(256);
  const range = Math.max(1, inWhite - inBlack);
  const outR  = outWhite - outBlack;
  const gInv  = gamma <= 0 ? 1 : 1 / gamma;

  for (let v = 0; v < 256; v++) {
    const clamped    = Math.max(inBlack, Math.min(inWhite, v));
    const normalised = (clamped - inBlack) / range;
    const corrected  = Math.pow(normalised, gInv);
    lut[v]           = Math.round(outBlack + corrected * outR);
  }
  return lut;
}

function buildIdentity(lut: Uint8ClampedArray): void {
  for (let i = 0; i < 256; i++) lut[i] = i;
}
