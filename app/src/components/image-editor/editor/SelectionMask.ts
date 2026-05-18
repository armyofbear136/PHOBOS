import type { BBox, SelectionOp } from '../types';

// =============================================================================
// SelectionMask
//
// A single-byte-per-pixel mask covering the entire document canvas.
//   0   = pixel is not selected
//   255 = pixel is fully selected
//   1–254 = partially selected (anti-aliased edge)
//
// Physical dimensions match the layer OffscreenCanvas (CSS px × dpr).
// The mask is pre-allocated once at document creation and never reallocated
// unless the canvas is resized. On resize, allocate a new Uint8Array and
// discard the old one.
//
// `empty = true` is the fast path — no selection active, all pixels writable.
// Every tool checks mask.empty before touching mask.data.
// =============================================================================

export class SelectionMask {
  data:   Uint8Array;
  width:  number;   // physical pixels
  height: number;   // physical pixels
  empty:  boolean;  // true = no selection, treat all pixels as fully selected

  constructor(width: number, height: number) {
    this.width  = width;
    this.height = height;
    this.data   = new Uint8Array(width * height);
    this.empty  = true;
    // Initialize to fully selected.
    this.data.fill(255);
  }

  /** Deselect everything — fill mask with 255 and set empty = true. */
  reset(): void {
    this.data.fill(255);
    this.empty = true;
  }

  /**
   * Reallocate for a new canvas size. Called only on canvas resize.
   * Pixels within the overlapping region are preserved; new pixels are
   * initialized to 255 (fully selected).
   */
  resize(newWidth: number, newHeight: number): void {
    const next = new Uint8Array(newWidth * newHeight).fill(255);
    const copyW = Math.min(this.width,  newWidth);
    const copyH = Math.min(this.height, newHeight);
    for (let y = 0; y < copyH; y++) {
      const srcOff = y * this.width;
      const dstOff = y * newWidth;
      next.set(this.data.subarray(srcOff, srcOff + copyW), dstOff);
    }
    this.data   = next;
    this.width  = newWidth;
    this.height = newHeight;
    this.empty  = false; // conservative — caller can call reset() if desired
  }

  /**
   * Invert the mask (0 ↔ 255, mid-values mirrored).
   * Used by Select → Invert.
   */
  invert(): void {
    for (let i = 0; i < this.data.length; i++) {
      this.data[i] = 255 - this.data[i];
    }
    // If the mask was empty (all 255), it is now all 0 (nothing selected).
    this.empty = false;
  }

  /**
   * Return the tight bounding box of selected pixels, or null if nothing
   * is selected. Used by crop-to-selection and move-selection.
   */
  bounds(): BBox | null {
    if (this.empty) return { x: 0, y: 0, w: this.width, h: this.height };
    let minX = this.width, minY = this.height, maxX = -1, maxY = -1;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (this.data[y * this.width + x] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX === -1) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }
}

// =============================================================================
// writePixelMasked
//
// Hot path — called per-pixel during all paint operations.
// `i` is the RGBA byte offset into `dst` (i.e. pixelIndex * 4).
// The corresponding mask index is `i >> 2`.
//
// Three cases:
//   mask.empty          → write unconditionally (fast path, no data access)
//   mask.data[px] == 255 → write unconditionally
//   mask.data[px] == 0  → skip (no write)
//   mask.data[px] 1–254 → blend proportionally (anti-aliased edge)
//
// No allocation. No function call overhead beyond the branch.
// =============================================================================

export function writePixelMasked(
  dst:  Uint8ClampedArray,
  mask: SelectionMask,
  i:    number,    // RGBA byte offset (pixelIndex * 4)
  r:    number,
  g:    number,
  b:    number,
  a:    number,
): void {
  if (mask.empty) {
    dst[i]     = r;
    dst[i + 1] = g;
    dst[i + 2] = b;
    dst[i + 3] = a;
    return;
  }
  const m = mask.data[i >> 2];
  if (m === 255) {
    dst[i]     = r;
    dst[i + 1] = g;
    dst[i + 2] = b;
    dst[i + 3] = a;
  } else if (m > 0) {
    const t    = m / 255;
    dst[i]     = (dst[i]     + (r - dst[i])     * t) | 0;
    dst[i + 1] = (dst[i + 1] + (g - dst[i + 1]) * t) | 0;
    dst[i + 2] = (dst[i + 2] + (b - dst[i + 2]) * t) | 0;
    dst[i + 3] = (dst[i + 3] + (a - dst[i + 3]) * t) | 0;
  }
  // m === 0: skip
}

// =============================================================================
// writePixelMaskedRaw
//
// Worker-compatible variant of writePixelMasked. Takes a raw Uint8Array
// (one byte per pixel) instead of a SelectionMask object, matching the type
// of PhobosRenderContext.mask as received inside the PluginWorker thread.
//
// Used by all PhobosEffect implementations. Editor-side code uses
// writePixelMasked (above) which takes the full SelectionMask class.
// =============================================================================

export function writePixelMaskedRaw(
  dst:  Uint8ClampedArray,
  mask: Uint8Array | undefined,
  i:    number,
  r:    number,
  g:    number,
  b:    number,
  a:    number,
): void {
  if (mask === undefined) {
    dst[i]     = r;
    dst[i + 1] = g;
    dst[i + 2] = b;
    dst[i + 3] = a;
    return;
  }
  const m = mask[i >> 2];
  if (m === 255) {
    dst[i]     = r;
    dst[i + 1] = g;
    dst[i + 2] = b;
    dst[i + 3] = a;
  } else if (m > 0) {
    const t    = m / 255;
    dst[i]     = (dst[i]     + (r - dst[i])     * t) | 0;
    dst[i + 1] = (dst[i + 1] + (g - dst[i + 1]) * t) | 0;
    dst[i + 2] = (dst[i + 2] + (b - dst[i + 2]) * t) | 0;
    dst[i + 3] = (dst[i + 3] + (a - dst[i + 3]) * t) | 0;
  }
  // m === 0: skip
}

// =============================================================================
// floodSelect
//
// BFS flood selection — used by magic wand tool. Writes selection values
// into `mask` starting from the seed pixel, spreading to all contiguous
// pixels within `tolerance` of the seed colour.
//
// `queue` is a pre-allocated Uint32Array of size >= width * height.
// Callers pass their document-level queue so no allocation happens here.
//
// `op` controls how the new selection combines with the existing mask:
//   'replace'   — mask is reset to 0 first, then BFS fills with 255
//   'add'       — existing selection kept; BFS adds to it
//   'subtract'  — BFS sets matched pixels to 0
//   'intersect' — only pixels already selected AND within BFS are kept
// =============================================================================

export function floodSelect(
  pixels:    Uint8ClampedArray,  // source image RGBA
  mask:      SelectionMask,
  queue:     Uint32Array,        // pre-allocated BFS queue
  seedX:     number,
  seedY:     number,
  tolerance: number,             // 0–255
  op:        SelectionOp,
): void {
  const { width, height } = mask;
  if (seedX < 0 || seedX >= width || seedY < 0 || seedY >= height) return;

  // Read seed colour.
  const seedIdx = (seedY * width + seedX) * 4;
  const seedR = pixels[seedIdx];
  const seedG = pixels[seedIdx + 1];
  const seedB = pixels[seedIdx + 2];
  const seedA = pixels[seedIdx + 3];

  // Visited bitfield — one bit per pixel. Avoids re-queueing.
  // Allocated here once per call; cannot pre-allocate at document level
  // because it must be zeroed each time. Uint8Array over Uint32Array for
  // simpler bit access (one byte per pixel, treating >0 as visited).
  const visited = new Uint8Array(width * height);

  if (op === 'replace') {
    mask.data.fill(0);
    mask.empty = false;
  }

  let head = 0;
  let tail = 0;

  const enqueue = (x: number, y: number): void => {
    const idx = y * width + x;
    if (visited[idx]) return;
    visited[idx] = 1;
    queue[tail++] = idx;
  };

  enqueue(seedX, seedY);

  while (head < tail) {
    const idx = queue[head++];
    const x   = idx % width;
    const y   = (idx - x) / width;

    // Check tolerance against seed colour.
    const base = idx * 4;
    const diff =
      Math.abs(pixels[base]     - seedR) +
      Math.abs(pixels[base + 1] - seedG) +
      Math.abs(pixels[base + 2] - seedB) +
      Math.abs(pixels[base + 3] - seedA);

    if (diff > tolerance * 4) continue;

    // Apply selection op.
    switch (op) {
      case 'replace':
      case 'add':
        mask.data[idx] = 255;
        break;
      case 'subtract':
        mask.data[idx] = 0;
        break;
      case 'intersect':
        // Keep only if already selected.
        if (mask.data[idx] === 0) mask.data[idx] = 0;
        // else leave as-is (already selected, now confirmed by BFS).
        break;
    }

    // Queue 4-connected neighbours.
    if (x > 0)          enqueue(x - 1, y);
    if (x < width  - 1) enqueue(x + 1, y);
    if (y > 0)          enqueue(x, y - 1);
    if (y < height - 1) enqueue(x, y + 1);
  }

  // For intersect: pixels that were selected but NOT reached by BFS must be cleared.
  if (op === 'intersect') {
    for (let i = 0; i < mask.data.length; i++) {
      if (!visited[i]) mask.data[i] = 0;
    }
  }

  mask.empty = false;
}
