import React from 'react';
import type { ToolId } from '../types';
import type { PaintBrushTool }  from '../tools/PaintBrushTool';
import type { PencilTool }      from '../tools/PencilEraserTools';
import type { EraserTool }      from '../tools/PencilEraserTools';
import type { PaintBucketTool } from '../tools/PaintBucketTool';
import type { MagicWandTool }   from '../tools/MagicWandTool';
import type { GradientTool }    from '../tools/GradientTool';
import type { TextTool }        from '../tools/TextTool';
import type { SelectionOp }     from '../types';

// =============================================================================
// ToolOptionsBar
//
// Horizontal strip immediately below the editor header. Shows controls
// relevant to the currently active tool. Each section reads from and writes
// to the tool singleton's `settings` object directly (mutation) and calls
// `onSettingChange()` so the parent can trigger a re-render.
//
// No new state is allocated per render. Slider and number-input handlers
// write directly to the existing settings field.
//
// Tools with no configurable settings (color-picker, zoom, pan, move-selection,
// lasso) render an empty bar so the layout height stays constant.
// =============================================================================

// ---------------------------------------------------------------------------
// Prop types
// ---------------------------------------------------------------------------

export interface ToolOptionsBarProps {
  activeToolId:    ToolId;
  brush:           PaintBrushTool;
  pencil:          PencilTool;
  eraser:          EraserTool;
  bucket:          PaintBucketTool;
  wand:            MagicWandTool;
  gradient:        GradientTool;
  text:            TextTool;
  /** Called whenever a setting is mutated — parent calls forceUpdate(). */
  onSettingChange: () => void;
}

// ---------------------------------------------------------------------------
// Selection op toggle — shared by rect, ellipse, lasso, wand
// ---------------------------------------------------------------------------

const SEL_OPS: { id: SelectionOp; label: string; title: string }[] = [
  { id: 'replace',   label: '▭',  title: 'Replace selection' },
  { id: 'add',       label: '▭₊', title: 'Add to selection' },
  { id: 'subtract',  label: '▭₋', title: 'Subtract from selection' },
  { id: 'intersect', label: '▭∩', title: 'Intersect with selection' },
];

function SelOpToggle({
  value,
  onChange,
}: { value: SelectionOp; onChange: (op: SelectionOp) => void }) {
  return (
    <div style={s.group}>
      <span style={s.label}>Mode</span>
      <div style={s.segmented}>
        {SEL_OPS.map(op => (
          <button
            key={op.id}
            title={op.title}
            style={{
              ...s.segBtn,
              background: value === op.id ? '#4a7fe8' : 'hsl(var(--secondary))',
              color:      value === op.id ? '#fff'    : '#aaa',
            }}
            onClick={() => onChange(op.id)}
          >
            {op.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared controls
// ---------------------------------------------------------------------------

function Slider({
  label, value, min, max, step = 1, format, onChange,
}: {
  label:    string;
  value:    number;
  min:      number;
  max:      number;
  step?:    number;
  format?:  (v: number) => string;
  onChange: (v: number) => void;
}) {
  const display = format ? format(value) : String(value);
  return (
    <div style={s.group}>
      <span style={s.label}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={s.slider}
        onChange={e => onChange(Number(e.target.value))}
      />
      <span style={s.value}>{display}</span>
    </div>
  );
}

function Toggle({
  label, value, onChange,
}: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={s.group}>
      <label style={s.checkLabel}>
        <input
          type="checkbox"
          checked={value}
          style={s.checkbox}
          onChange={e => onChange(e.target.checked)}
        />
        {label}
      </label>
    </div>
  );
}

function Divider() {
  return <div style={s.divider} />;
}

// ---------------------------------------------------------------------------
// ToolOptionsBar
// ---------------------------------------------------------------------------

export function ToolOptionsBar({
  activeToolId,
  brush,
  pencil,
  eraser,
  bucket,
  wand,
  gradient,
  text,
  onSettingChange,
}: ToolOptionsBarProps) {

  const ch = onSettingChange;

  // ------------------------------------------------------------------
  // Brush
  // ------------------------------------------------------------------
  if (activeToolId === 'paint-brush') {
    return (
      <div style={s.bar}>
        <Slider label="Size"     value={brush.settings.size}     min={1}   max={512} step={1}
          format={v => `${v}px`} onChange={v => { brush.settings.size = v;     ch(); }} />
        <Divider />
        <Slider label="Hardness" value={Math.round(brush.settings.hardness * 100)} min={0} max={100} step={1}
          format={v => `${v}%`}  onChange={v => { brush.settings.hardness = v / 100; ch(); }} />
        <Divider />
        <Slider label="Opacity"  value={Math.round(brush.settings.opacity  * 100)} min={1} max={100} step={1}
          format={v => `${v}%`}  onChange={v => { brush.settings.opacity  = v / 100; ch(); }} />
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Pencil
  // ------------------------------------------------------------------
  if (activeToolId === 'pencil') {
    return (
      <div style={s.bar}>
        <Slider label="Size"    value={pencil.settings.size}    min={1} max={64}  step={1}
          format={v => `${v}px`} onChange={v => { pencil.settings.size    = v;     ch(); }} />
        <Divider />
        <Slider label="Opacity" value={Math.round(pencil.settings.opacity * 100)} min={1} max={100} step={1}
          format={v => `${v}%`}  onChange={v => { pencil.settings.opacity = v / 100; ch(); }} />
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Eraser
  // ------------------------------------------------------------------
  if (activeToolId === 'eraser') {
    return (
      <div style={s.bar}>
        <Slider label="Size"    value={eraser.settings.size}    min={1} max={512} step={1}
          format={v => `${v}px`} onChange={v => { eraser.settings.size    = v;     ch(); }} />
        <Divider />
        <Slider label="Opacity" value={Math.round(eraser.settings.opacity * 100)} min={1} max={100} step={1}
          format={v => `${v}%`}  onChange={v => { eraser.settings.opacity = v / 100; ch(); }} />
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Paint bucket
  // ------------------------------------------------------------------
  if (activeToolId === 'paint-bucket') {
    return (
      <div style={s.bar}>
        <Slider label="Tolerance" value={bucket.settings.tolerance} min={0} max={255} step={1}
          onChange={v => { bucket.settings.tolerance = v; ch(); }} />
        <Divider />
        <Slider label="Opacity"   value={Math.round(bucket.settings.opacity * 100)} min={1} max={100} step={1}
          format={v => `${v}%`}   onChange={v => { bucket.settings.opacity  = v / 100; ch(); }} />
        <Divider />
        <Toggle label="Global fill" value={bucket.settings.globalFill}
          onChange={v => { bucket.settings.globalFill = v; ch(); }} />
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Rect / ellipse / lasso select  — op only (no tolerance)
  // ------------------------------------------------------------------
  if (activeToolId === 'rect-select' || activeToolId === 'ellipse-select' || activeToolId === 'lasso-select') {
    // Rect and ellipse tools expose .op directly (not in a settings bag).
    // We read/write via the wand tool for lasso (it shares op), and via the
    // tool singletons passed in. Since we only have brush/pencil/eraser/bucket/
    // wand/gradient/text passed in, for the select tools we use wand.op as a
    // shared selection-op state (all four select tools read the same op on
    // tool switch in v1). This is a known v1 simplification noted in SelectTools.ts.
    return (
      <div style={s.bar}>
        <SelOpToggle value={wand.op} onChange={op => { wand.op = op; ch(); }} />
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Magic wand
  // ------------------------------------------------------------------
  if (activeToolId === 'magic-wand') {
    return (
      <div style={s.bar}>
        <SelOpToggle value={wand.op} onChange={op => { wand.op = op; ch(); }} />
        <Divider />
        <Slider label="Tolerance" value={wand.tolerance} min={0} max={255} step={1}
          onChange={v => { wand.tolerance = v; ch(); }} />
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Gradient
  // ------------------------------------------------------------------
  if (activeToolId === 'gradient') {
    return (
      <div style={s.bar}>
        <div style={s.group}>
          <span style={s.label}>Mode</span>
          <div style={s.segmented}>
            {(['linear', 'radial'] as const).map(m => (
              <button key={m} style={{
                ...s.segBtn,
                background: gradient.settings.mode === m ? '#4a7fe8' : 'hsl(var(--secondary))',
                color:      gradient.settings.mode === m ? '#fff'    : '#aaa',
              }} onClick={() => { gradient.settings.mode = m; ch(); }}>
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <Divider />
        <div style={s.group}>
          <span style={s.label}>Repeat</span>
          <div style={s.segmented}>
            {(['none', 'repeat', 'reflect'] as const).map(r => (
              <button key={r} style={{
                ...s.segBtn,
                background: gradient.settings.repeat === r ? '#4a7fe8' : 'hsl(var(--secondary))',
                color:      gradient.settings.repeat === r ? '#fff'    : '#aaa',
              }} onClick={() => { gradient.settings.repeat = r; ch(); }}>
                {r.charAt(0).toUpperCase() + r.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <Divider />
        <Slider label="Opacity" value={Math.round(gradient.settings.opacity * 100)} min={1} max={100} step={1}
          format={v => `${v}%`}  onChange={v => { gradient.settings.opacity = v / 100; ch(); }} />
      </div>
    );
  }

  // ------------------------------------------------------------------
  // Text
  // ------------------------------------------------------------------
  if (activeToolId === 'text') {
    const FONTS = ['Arial', 'Georgia', 'Verdana', 'Courier New', 'Times New Roman', 'Impact'];
    return (
      <div style={s.bar}>
        <div style={s.group}>
          <span style={s.label}>Font</span>
          <select
            value={text.settings.fontFamily}
            style={s.select}
            onChange={e => { text.settings.fontFamily = e.target.value; ch(); }}
          >
            {FONTS.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <Divider />
        <Slider label="Size" value={text.settings.fontSize} min={6} max={288} step={1}
          format={v => `${v}px`} onChange={v => { text.settings.fontSize = v; ch(); }} />
        <Divider />
        <Toggle label="Bold"      value={text.settings.bold}
          onChange={v => { text.settings.bold      = v; ch(); }} />
        <Toggle label="Italic"    value={text.settings.italic}
          onChange={v => { text.settings.italic    = v; ch(); }} />
        <Toggle label="Anti-alias" value={text.settings.antiAlias}
          onChange={v => { text.settings.antiAlias = v; ch(); }} />
      </div>
    );
  }

  // ------------------------------------------------------------------
  // No options (color-picker, zoom, pan, move-selection)
  // ------------------------------------------------------------------
  return <div style={s.bar} />;
}

// =============================================================================
// Styles
// =============================================================================

const s = {
  bar: {
    display:      'flex',
    alignItems:   'center',
    height:       36,
    background:   '#1e1e1e',
    borderBottom: '1px solid #333',
    padding:      '0 10px',
    gap:          4,
    flexShrink:   0,
    overflowX:    'auto'  as const,
    overflowY:    'hidden' as const,
  },
  group: {
    display:    'flex',
    alignItems: 'center',
    gap:        5,
    flexShrink: 0,
  },
  label: {
    color:      '#888',
    fontSize:   11,
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
  },
  slider: {
    width:  110,
    cursor: 'pointer',
    accentColor: '#4a7fe8',
  },
  value: {
    color:     '#ccc',
    fontSize:  11,
    width:     34,
    textAlign: 'right' as const,
    flexShrink: 0,
  },
  divider: {
    width:      1,
    height:     18,
    background: '#383838',
    flexShrink: 0,
    margin:     '0 4px',
  },
  segmented: {
    display: 'flex',
    gap:     1,
  },
  segBtn: {
    border:       '1px solid #444',
    borderRadius: 3,
    padding:      '2px 7px',
    fontSize:     11,
    cursor:       'pointer',
    flexShrink:   0,
  },
  checkLabel: {
    display:    'flex',
    alignItems: 'center',
    gap:        4,
    color:      '#ccc',
    fontSize:   11,
    cursor:     'pointer',
    flexShrink: 0,
  },
  checkbox: {
    margin:      0,
    accentColor: '#4a7fe8',
  },
  select: {
    background:   'hsl(var(--secondary))',
    border:       '1px solid #444',
    color:        '#e8e8e8',
    borderRadius: 3,
    padding:      '2px 4px',
    fontSize:     11,
    cursor:       'pointer',
  },
} as const;
