import { cssToPhysical }              from '../editor/PhobosDocument';
import type { PhobosTool, ToolEvent } from '../tools/ToolController';
import type { RGBA }                  from '../types';

// =============================================================================
// ColorPickerTool
//
// Reads a single pixel from the composite view (all visible layers flattened)
// or from the active layer only, depending on `sampleAllLayers`.
//
// Calls `onColorPicked` with the sampled RGBA. The callback wires into
// React state in the parent (ToolBar or ColorPicker component) — the tool
// itself does not hold colour state.
//
// No command is emitted — picking does not modify the document.
// =============================================================================

export interface ColorPickerSettings {
  sampleAllLayers: boolean;
}

export class ColorPickerTool implements PhobosTool {
  readonly id     = 'color-picker' as const;
  readonly cursor = 'crosshair';

  settings: ColorPickerSettings;

  /** Called whenever a colour is successfully sampled. */
  onColorPicked: (color: RGBA) => void;

  constructor(
    settings:      ColorPickerSettings,
    onColorPicked: (color: RGBA) => void,
  ) {
    this.settings      = settings;
    this.onColorPicked = onColorPicked;
  }

  onPointerDown(e: ToolEvent): void {
    this._sample(e);
  }

  onPointerMove(e: ToolEvent): void {
    // Live preview while button is held.
    if (e.buttons & 1) this._sample(e);
  }

  onPointerUp(_e: ToolEvent): void { /* no-op */ }
  onCancel():                 void { /* no-op */ }

  // ---------------------------------------------------------------------------

  private _sample(e: ToolEvent): void {
    const dpr  = e.doc.dpr;
    const px   = cssToPhysical(e.x, dpr);
    const py   = cssToPhysical(e.y, dpr);
    const physW = e.doc.physicalWidth;
    const physH = e.doc.physicalHeight;

    if (px < 0 || px >= physW || py < 0 || py >= physH) return;

    let pixels: Uint8ClampedArray;

    if (this.settings.sampleAllLayers) {
      // Flatten all visible layers onto the doc's flatten canvas, then sample.
      const canvas = e.doc.flatten();
      const ctx    = e.doc.flattenCtx;
      const imgData = ctx.getImageData(px, py, 1, 1);
      pixels = imgData.data;
      void canvas;
    } else {
      // Sample the active layer directly.
      const imgData = e.doc.activeLayer.getImageData({ x: px, y: py, w: 1, h: 1 });
      pixels = imgData.data;
    }

    this.onColorPicked({
      r: pixels[0],
      g: pixels[1],
      b: pixels[2],
      a: pixels[3],
    });
  }
}
