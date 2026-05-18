import { cssToPhysical }              from '../editor/PhobosDocument';
import { RasterCommand }              from '../editor/RasterCommand';
import type { PhobosTool, ToolEvent } from '../tools/ToolController';

// =============================================================================
// PaintBucketTool
//
// BFS scanline flood fill. Uses the pre-allocated doc.fillQueue — no
// allocation during fill regardless of image size.
//
// Tolerance is a sum-of-absolute-differences across all four channels
// compared to the seed pixel's colour. Range 0–255 (matching Paint.NET).
//
// Respects the selection mask: pixels with mask = 0 are skipped entirely.
// The fill colour is composited over the destination using the tool opacity.
// =============================================================================

export interface BucketSettings {
  color:      string;  // CSS colour e.g. '#ff0000ff'
  tolerance:  number;  // 0–255
  opacity:    number;  // 0–1
  /** If true, fill all same-coloured regions (not just contiguous ones). */
  globalFill: boolean;
}

export class PaintBucketTool implements PhobosTool {
  readonly id     = 'paint-bucket' as const;
  readonly cursor = 'crosshair';

  settings: BucketSettings;

  constructor(settings: BucketSettings) {
    this.settings = settings;
  }

  onPointerDown(e: ToolEvent): void {
    const layer = e.doc.activeLayer;
    if (layer.locked) return;

    const dpr  = e.doc.dpr;
    const px   = cssToPhysical(e.x, dpr);
    const py   = cssToPhysical(e.y, dpr);
    const physW = e.doc.physicalWidth;
    const physH = e.doc.physicalHeight;

    if (px < 0 || px >= physW || py < 0 || py >= physH) return;

    const settings  = { ...this.settings };
    const fillColor = parseCssColor(settings.color);
    if (!fillColor) return;

    const mask      = e.doc.selection;
    const queue     = e.doc.fillQueue;

    const cmd = new RasterCommand('Fill', layer, undefined, () => {
      const imgData = layer.getImageData();
      const pixels  = imgData.data;

      // Read seed colour.
      const seedI = (py * physW + px) * 4;
      const seedR = pixels[seedI];
      const seedG = pixels[seedI + 1];
      const seedB = pixels[seedI + 2];
      const seedA = pixels[seedI + 3];

      if (settings.globalFill) {
        // Global fill: scan every pixel, fill matching ones regardless of adjacency.
        for (let i = 0; i < physW * physH; i++) {
          const mi = mask.empty ? 255 : mask.data[i];
          if (mi === 0) continue;

          const bi  = i * 4;
          const diff =
            Math.abs(pixels[bi]     - seedR) +
            Math.abs(pixels[bi + 1] - seedG) +
            Math.abs(pixels[bi + 2] - seedB) +
            Math.abs(pixels[bi + 3] - seedA);

          if (diff <= settings.tolerance * 4) {
            blendPixel(pixels, bi, fillColor, settings.opacity, mi);
          }
        }
      } else {
        // Contiguous BFS fill.
        // Visited array: reuse a Uint8Array view over the queue buffer's
        // upper half to avoid allocation. Queue is Uint32Array[physW*physH];
        // we need physW*physH bytes for visited. Allocate separately — only
        // one allocation per fill call, not per pixel.
        const visited = new Uint8Array(physW * physH);
        let head = 0;
        let tail = 0;

        const enqueue = (idx: number): void => {
          if (visited[idx]) return;
          visited[idx] = 1;
          queue[tail++] = idx;
        };

        enqueue(py * physW + px);

        while (head < tail) {
          const idx = queue[head++];
          const x   = idx % physW;
          const y   = (idx - x) / physW;
          const bi  = idx * 4;

          const diff =
            Math.abs(pixels[bi]     - seedR) +
            Math.abs(pixels[bi + 1] - seedG) +
            Math.abs(pixels[bi + 2] - seedB) +
            Math.abs(pixels[bi + 3] - seedA);

          if (diff > settings.tolerance * 4) continue;

          const mi = mask.empty ? 255 : mask.data[idx];
          if (mi === 0) continue;

          blendPixel(pixels, bi, fillColor, settings.opacity, mi);

          if (x > 0)           enqueue(idx - 1);
          if (x < physW - 1)   enqueue(idx + 1);
          if (y > 0)           enqueue(idx - physW);
          if (y < physH - 1)   enqueue(idx + physW);
        }
      }

      layer.putImageData(imgData);
    });

    e.emit(cmd);
  }

  onPointerMove(_e: ToolEvent): void { /* no-op */ }
  onPointerUp(_e: ToolEvent):   void { /* no-op */ }
  onCancel():                   void { /* no-op */ }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ParsedColor { r: number; g: number; b: number; a: number }

/**
 * Parse a CSS hex colour string (#rrggbb or #rrggbbaa) into RGBA bytes.
 * Returns null if the string is not a valid hex colour.
 */
function parseCssColor(css: string): ParsedColor | null {
  const s = css.replace('#', '');
  if (s.length === 6) {
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16),
      a: 255,
    };
  }
  if (s.length === 8) {
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16),
      a: parseInt(s.slice(6, 8), 16),
    };
  }
  return null;
}

/**
 * Alpha-composite a fill colour over a destination pixel in-place.
 * `maskByte` is 0–255; 255 = fully selected, 0 = skip.
 * No allocation.
 */
function blendPixel(
  pixels:    Uint8ClampedArray,
  i:         number,
  fill:      ParsedColor,
  opacity:   number,
  maskByte:  number,
): void {
  const alpha  = (fill.a / 255) * opacity * (maskByte / 255);
  const dA     = pixels[i + 3] / 255;
  const outA   = alpha + dA * (1 - alpha);
  const invOut = outA === 0 ? 0 : 1 / outA;

  pixels[i]     = ((fill.r * alpha + pixels[i]     * dA * (1 - alpha)) * invOut) | 0;
  pixels[i + 1] = ((fill.g * alpha + pixels[i + 1] * dA * (1 - alpha)) * invOut) | 0;
  pixels[i + 2] = ((fill.b * alpha + pixels[i + 2] * dA * (1 - alpha)) * invOut) | 0;
  pixels[i + 3] = (outA * 255) | 0;
}
