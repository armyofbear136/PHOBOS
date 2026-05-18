import { RasterCommand }              from '../editor/RasterCommand';
import type { PhobosTool, ToolEvent } from './ToolController';

// =============================================================================
// TextTool
//
// Text rendering pipeline:
//   pointerDown → record click position
//   (user types in the text overlay UI — managed by the parent React component)
//   commit(text, font, size, color) → rasterise onto active layer
//
// Unlike the architecture doc's Konva.Text approach (which requires Konva to
// be mounted), this tool is decoupled: it stores the pending text state and
// exposes a commit() method called by the React text overlay. The overlay is
// rendered by ImageEditorPanel.tsx — a floating <textarea> positioned over
// the canvas at the click coordinates.
//
// This keeps TextTool free of any Konva dependency, consistent with all other
// tools. The rasterisation uses OffscreenCanvas with ctx.fillText().
// =============================================================================

export interface TextSettings {
  fontFamily: string;   // e.g. 'Arial'
  fontSize:   number;   // px, at CSS pixel scale
  color:      string;   // '#rrggbb'
  bold:       boolean;
  italic:     boolean;
  antiAlias:  boolean;
}

export interface PendingText {
  cssX:    number;
  cssY:    number;
  text:    string;
  settings: TextSettings;
}

export class TextTool implements PhobosTool {
  readonly id     = 'text' as const;
  readonly cursor = 'text';

  settings: TextSettings;

  /** Set by ImageEditorPanel — fired when user places a text click. */
  onTextPlaced: (pending: PendingText) => void = () => {};

  private _pending: PendingText | null = null;

  constructor(settings: TextSettings) {
    this.settings = settings;
  }

  // ---------------------------------------------------------------------------
  // Tool events — place a text insertion point
  // ---------------------------------------------------------------------------

  onPointerDown(e: ToolEvent): void {
    const layer = e.doc.activeLayer;
    if (layer.locked) return;

    this._pending = {
      cssX:     e.x,
      cssY:     e.y,
      text:     '',
      settings: { ...this.settings },
    };

    // Signal the React overlay to open at this position.
    this.onTextPlaced(this._pending);
  }

  onPointerMove(_e: ToolEvent): void { /* no-op */ }
  onPointerUp(_e: ToolEvent):   void { /* no-op */ }

  onCancel(): void {
    this._pending = null;
  }

  // ---------------------------------------------------------------------------
  // commit — called by the React text overlay when the user finalises text
  // ---------------------------------------------------------------------------

  /**
   * Rasterise the pending text onto the active layer. Called by the React
   * text overlay when the user presses Enter or clicks away.
   *
   * @param text    The final string (may be multi-line with \n)
   * @param emitter CommandEmitter from ToolController
   * @param doc     The current PhobosDocument (passed from the overlay)
   */
  commit(text: string, emitter: (cmd: ReturnType<typeof RasterCommand.prototype.undo> extends void ? any : any) => void, doc: import('../editor/PhobosDocument').PhobosDocument): void {
    if (!this._pending || !text.trim()) {
      this._pending = null;
      return;
    }

    const { cssX, cssY, settings } = this._pending;
    this._pending = null;

    const layer  = doc.activeLayer;
    const dpr    = doc.dpr;
    const physX  = Math.round(cssX * dpr);
    const physY  = Math.round(cssY * dpr);
    const physFs = Math.round(settings.fontSize * dpr);

    const fontStr = [
      settings.italic  ? 'italic'  : '',
      settings.bold    ? 'bold'    : '',
      `${physFs}px`,
      settings.fontFamily,
    ].filter(Boolean).join(' ');

    // Measure text to compute bbox for snapshot.
    const measureCanvas = new OffscreenCanvas(1, 1);
    const measureCtx    = measureCanvas.getContext('2d')!;
    measureCtx.font     = fontStr;
    const lines         = text.split('\n');
    const lineHeight    = physFs * 1.2;
    const maxWidth      = Math.max(...lines.map(l => measureCtx.measureText(l).width));
    const totalHeight   = lineHeight * lines.length;

    const bboxX = Math.max(0, physX);
    const bboxY = Math.max(0, physY);
    const bboxW = Math.min(doc.physicalWidth  - bboxX, Math.ceil(maxWidth)  + 4);
    const bboxH = Math.min(doc.physicalHeight - bboxY, Math.ceil(totalHeight) + 4);

    if (bboxW <= 0 || bboxH <= 0) return;

    const bbox = { x: bboxX, y: bboxY, w: bboxW, h: bboxH };

    const cmd = new RasterCommand('Text', layer, bbox, () => {
      const ctx  = layer.ctx;
      ctx.save();
      ctx.font         = fontStr;
      ctx.fillStyle    = settings.color;
      ctx.textBaseline = 'top';
      if (!settings.antiAlias) {
        ctx.imageSmoothingEnabled = false;
      }

      lines.forEach((line, i) => {
        ctx.fillText(line, physX, physY + i * lineHeight);
      });

      ctx.restore();
      layer.markDirty();
    });

    emitter(cmd);
  }
}
