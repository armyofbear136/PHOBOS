// =============================================================================
// Phobos Image Editor — Shared Types
// No implementation. No imports. Everything else imports from here.
// =============================================================================

// -----------------------------------------------------------------------------
// Primitives
// -----------------------------------------------------------------------------

/** Axis-aligned bounding box in physical pixels. */
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** RGBA colour as four 0–255 components. */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

// -----------------------------------------------------------------------------
// Document / Layer
// -----------------------------------------------------------------------------

/**
 * Canvas 2D globalCompositeOperation values we support in Phase 1.
 * The seven WebGL-only modes (linear-burn etc.) are Phase 2.
 */
export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

export const BLEND_MODES: BlendMode[] = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
];

// -----------------------------------------------------------------------------
// Command / Undo
// -----------------------------------------------------------------------------

export interface PhobosCommand {
  /** Display name shown in undo history. */
  readonly name: string;
  execute(): void;
  undo(): void;
}

// -----------------------------------------------------------------------------
// Selection
// -----------------------------------------------------------------------------

export type SelectionOp = 'replace' | 'add' | 'subtract' | 'intersect';

// -----------------------------------------------------------------------------
// Tools
// -----------------------------------------------------------------------------

export type ToolId =
  | 'paint-brush'
  | 'pencil'
  | 'eraser'
  | 'paint-bucket'
  | 'color-picker'
  | 'rect-select'
  | 'ellipse-select'
  | 'lasso-select'
  | 'magic-wand'
  | 'move-selection'
  | 'gradient'
  | 'text'
  | 'zoom'
  | 'pan';

// -----------------------------------------------------------------------------
// Plugin system — manifest
// -----------------------------------------------------------------------------

export type EffectCategory =
  | 'Blur'
  | 'Colour'
  | 'Distort'
  | 'Noise'
  | 'Render'
  | 'Stylize'
  | 'Photo'
  | 'Custom';

export type EffectType =
  | 'PixelFilter'   // output pixel depends only on same-position input pixel
  | 'AreaFilter'    // output pixel depends on a neighbourhood
  | 'Generator'     // produces pixels with no input image
  | 'Compositor'    // two image inputs → one output
  | 'Transform'     // changes canvas geometry
  | 'Analyser';     // reads pixels, produces data — no pixel output

/** One control point on a Bezier curves adjustment. */
export interface CurvePoint {
  x: number;  // 0–255 input
  y: number;  // 0–255 output
}

export type ParamDef =
  | { id: string; label: string; type: 'int';   default: number;      min: number; max: number; step?: number }
  | { id: string; label: string; type: 'float'; default: number;      min: number; max: number; step?: number }
  | { id: string; label: string; type: 'bool';  default: boolean }
  | { id: string; label: string; type: 'enum';  default: string;      options: string[] }
  | { id: string; label: string; type: 'color'; default: string }        // '#rrggbbaa'
  | { id: string; label: string; type: 'curve'; default: CurvePoint[] };

export interface PhobosPluginManifest {
  /** Reverse-domain identifier. Permanent wire contract — never changes. */
  id:                string;
  name:              string;
  category:          EffectCategory;
  type:              EffectType;
  /** Semver string. Host enforces compatibility. */
  version:           string;
  supportsSelection: boolean;
  /** If true, host calls render() on a downscaled thumbnail for live preview. */
  supportsPreview:   boolean;
  parameters:        ParamDef[];
  /** URL to a .wasm module. If present, host loads WASM instead of calling JS render(). */
  wasm?:             string;
}

// -----------------------------------------------------------------------------
// Plugin system — render contract
// -----------------------------------------------------------------------------

export interface PhobosRenderContext {
  /** Source pixels — RGBA, read-only view into a SharedArrayBuffer. */
  src:      Uint8ClampedArray;
  /** Destination pixels — RGBA, write target. */
  dst:      Uint8ClampedArray;
  width:    number;
  height:   number;
  params:   Readonly<Record<string, number | boolean | string>>;
  /**
   * Selection mask — one byte per pixel, 0 = not selected, 255 = fully selected.
   * Undefined when the document has no active selection (treat as fully selected).
   */
  mask?:    Uint8Array;
  /**
   * Report progress to the host. Value is 0–1. Calls are throttled internally;
   * plugins may call this as frequently as they like.
   */
  progress: (pct: number) => void;
}

export interface PhobosEffect {
  describe(): PhobosPluginManifest;
  render(ctx: PhobosRenderContext): void;
}

// -----------------------------------------------------------------------------
// Worker message protocol
// -----------------------------------------------------------------------------

/** Messages sent from the main thread to the PluginWorker. */
export type WorkerInMessage =
  | {
      type:    'register-js';
      /** Serialised effect source — evaluated inside the worker. */
      source:  string;
      manifest: PhobosPluginManifest;
    }
  | {
      type:     'register-wasm';
      manifest: PhobosPluginManifest;
      /** ArrayBuffer of the compiled .wasm module. */
      wasmBytes: ArrayBuffer;
    }
  | {
      type:      'render';
      renderId:  number;  // caller-assigned, echoed back in the response
      pluginId:  string;
      src:       SharedArrayBuffer;
      dst:       SharedArrayBuffer;
      width:     number;
      height:    number;
      params:    Record<string, number | boolean | string>;
      mask?:     SharedArrayBuffer;
    }
  | { type: 'ping' };

/** Messages sent from the PluginWorker back to the main thread. */
export type WorkerOutMessage =
  | { type: 'ready' }
  | { type: 'pong' }
  | { type: 'render-done';  renderId: number }
  | { type: 'render-error'; renderId: number; message: string }
  | { type: 'register-ok';  pluginId: string }
  | { type: 'register-error'; pluginId: string; message: string };

// -----------------------------------------------------------------------------
// Manifest validation helpers (used by PluginRegistry)
// -----------------------------------------------------------------------------

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const ID_RE     = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

export function validateManifest(m: PhobosPluginManifest): string | null {
  if (!ID_RE.test(m.id))          return `Invalid plugin id "${m.id}" — must be reverse-domain (e.g. dev.phobos.my-effect)`;
  if (!m.name?.trim())            return `Plugin "${m.id}" is missing a name`;
  if (!SEMVER_RE.test(m.version)) return `Plugin "${m.id}" has invalid version "${m.version}" — must be semver (e.g. 1.0.0)`;
  if (!m.parameters)              return `Plugin "${m.id}" is missing parameters array`;

  for (const p of m.parameters) {
    if (!p.id?.trim())    return `Plugin "${m.id}" has a parameter with no id`;
    if (!p.label?.trim()) return `Plugin "${m.id}" parameter "${p.id}" is missing a label`;
    if (p.type === 'int' || p.type === 'float') {
      if (p.min >= p.max) return `Plugin "${m.id}" parameter "${p.id}" has min >= max`;
    }
    if (p.type === 'enum' && (!p.options || p.options.length === 0)) {
      return `Plugin "${m.id}" parameter "${p.id}" is type enum but has no options`;
    }
  }

  return null; // valid
}
