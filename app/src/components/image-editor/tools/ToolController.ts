import type { PhobosDocument }  from '../editor/PhobosDocument';
import type { PhobosCommand, ToolId } from '../types';
import type { GPUBrushEngine } from '../gpu/GPUBrushEngine';

// =============================================================================
// ToolController
//
// Owns the active tool singleton. Receives pointer events from EditorCanvas
// and calls the active tool's handlers.
//
// Also owns the CommandEmitter — the only path through which tools mutate
// the document. After pushing a command onto the history stack, it calls
// the provided `onStateChange` callback so React can re-render panels
// that depend on history state (undo button, layer list, etc.).
//
// Holds a reference to GPUBrushEngine so paint tools can access it without
// importing EditorCanvas. Set by EditorCanvas at mount, cleared at unmount.
//
// Tools never import React and never call setState directly.
// =============================================================================

export interface ToolEvent {
  /** CSS pixels, document-relative (pan + zoom already removed). */
  x:        number;
  y:        number;
  /** 0–1 from PointerEvent.pressure. Defaults to 1 if not available. */
  pressure: number;
  /** PointerEvent.buttons bitmask. */
  buttons:  number;
  doc:      PhobosDocument;
  emit:     CommandEmitter;
}

/** The only way a tool may mutate the document. */
export type CommandEmitter = (cmd: PhobosCommand) => void;

export interface PhobosTool {
  readonly id:     ToolId;
  /** CSS cursor string applied to the stage container. */
  readonly cursor: string;
  onPointerDown(e: ToolEvent): void;
  onPointerMove(e: ToolEvent): void;
  onPointerUp(e: ToolEvent):   void;
  /** Called when the active tool is switched away or Escape is pressed. */
  onCancel(): void;
}

/** Callback fired after every command push so React can sync UI state. */
export type StateChangeCallback = (doc: PhobosDocument) => void;

export class ToolController {
  private _activeTool:   PhobosTool;
  private _doc:          PhobosDocument | null;
  private _onChange:     StateChangeCallback;
  private _brushEngine:  GPUBrushEngine | null = null;
  private readonly _emit: CommandEmitter;

  constructor(initialTool: PhobosTool, onChange: StateChangeCallback) {
    this._activeTool = initialTool;
    this._doc        = null;
    this._onChange   = onChange;

    this._emit = (cmd: PhobosCommand): void => {
      if (!this._doc) return;
      this._doc.history.push(cmd);
      this._onChange(this._doc);
    };
  }

  // ---------------------------------------------------------------------------
  // Document binding — set when a document is opened, cleared on close
  // ---------------------------------------------------------------------------

  bindDocument(doc: PhobosDocument): void {
    this._doc = doc;
  }

  unbindDocument(): void {
    this._activeTool.onCancel();
    this._doc = null;
  }

  // ---------------------------------------------------------------------------
  // GPU brush engine — set by EditorCanvas at mount, cleared at unmount.
  // PaintBrushTool reads this to stamp directly into layer FBOs.
  // ---------------------------------------------------------------------------

  setBrushEngine(engine: GPUBrushEngine | null): void {
    this._brushEngine = engine;
    // Notify the active tool if it accepts a brush engine reference.
    // This avoids the tool needing a controller import.
    const tool = this._activeTool as PhobosTool & { setBrushEngine?: (e: GPUBrushEngine | null) => void };
    tool.setBrushEngine?.(engine);
  }

  get brushEngine(): GPUBrushEngine | null {
    return this._brushEngine;
  }

  // ---------------------------------------------------------------------------
  // Active tool
  // ---------------------------------------------------------------------------

  get activeTool(): PhobosTool {
    return this._activeTool;
  }

  setActiveTool(tool: PhobosTool): void {
    if (this._activeTool.id === tool.id) return;
    this._activeTool.onCancel();
    this._activeTool = tool;
    // Forward the current brush engine to the new tool if it accepts one.
    const t = tool as PhobosTool & { setBrushEngine?: (e: GPUBrushEngine | null) => void };
    t.setBrushEngine?.(this._brushEngine);
  }

  get cursor(): string {
    return this._activeTool.cursor;
  }

  // ---------------------------------------------------------------------------
  // Pointer event dispatch — called by EditorCanvas
  // ---------------------------------------------------------------------------

  pointerDown(x: number, y: number, pressure: number, buttons: number): void {
    if (!this._doc) return;
    this._activeTool.onPointerDown(this._makeEvent(x, y, pressure, buttons));
  }

  pointerMove(x: number, y: number, pressure: number, buttons: number): void {
    if (!this._doc) return;
    this._activeTool.onPointerMove(this._makeEvent(x, y, pressure, buttons));
  }

  pointerUp(x: number, y: number, pressure: number, buttons: number): void {
    if (!this._doc) return;
    this._activeTool.onPointerUp(this._makeEvent(x, y, pressure, buttons));
  }

  cancel(): void {
    this._activeTool.onCancel();
  }

  // ---------------------------------------------------------------------------
  // Direct undo/redo — called by keyboard shortcuts in EditorCanvas
  // ---------------------------------------------------------------------------

  undo(): void {
    if (!this._doc) return;
    this._doc.history.undo();
    this._onChange(this._doc);
  }

  redo(): void {
    if (!this._doc) return;
    this._doc.history.redo();
    this._onChange(this._doc);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _makeEvent(x: number, y: number, pressure: number, buttons: number): ToolEvent {
    return {
      x,
      y,
      pressure,
      buttons,
      doc:  this._doc!,
      emit: this._emit,
    };
  }
}