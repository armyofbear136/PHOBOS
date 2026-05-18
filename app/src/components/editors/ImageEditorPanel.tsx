import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  useReducer,
} from 'react';
import { useAppStore }          from '@/store/useAppStore';
import { useTheme }             from '@/lib/useTheme';
import { PhobosDocument }       from '@/components/image-editor/editor/PhobosDocument';
import { ToolController }       from '@/components/image-editor/tools/ToolController';
import { PaintBrushTool }       from '@/components/image-editor/tools/PaintBrushTool';
import { PaintBucketTool }      from '@/components/image-editor/tools/PaintBucketTool';
import { ColorPickerTool }      from '@/components/image-editor/tools/ColorPickerTool';
import { RectSelectTool, EllipseSelectTool } from '@/components/image-editor/tools/SelectTools';
import { MagicWandTool }        from '@/components/image-editor/tools/MagicWandTool';
import { LassoSelectTool }      from '@/components/image-editor/tools/LassoSelectTool';
import { MoveSelectionTool }    from '@/components/image-editor/tools/MoveSelectionTool';
import { TextTool }             from '@/components/image-editor/tools/TextTool';
import { GradientTool }         from '@/components/image-editor/tools/GradientTool';
import { PencilTool, EraserTool } from '@/components/image-editor/tools/PencilEraserTools';
import { PluginWorker }         from '@/components/image-editor/plugins/PluginWorker';
import { PluginRegistry }       from '@/components/image-editor/plugins/PluginRegistry';
import { LayersPanel }          from '@/components/image-editor/ui/LayersPanel';
import { EffectDialog }         from '@/components/image-editor/ui/EffectDialog';
import { ToolOptionsBar }       from '@/components/image-editor/ui/ToolOptionsBar';
import {
  openFile, exportPNG, exportJPEG, exportWebP, exportPhi,
  pickOpenFile, downloadBlob, autoSave,
} from '@/components/image-editor/io/FileIO';
import type { PhobosPluginManifest, ToolId, RGBA } from '@/components/image-editor/types';
import type { EditorCanvasHandle } from '@/components/image-editor/ui/EditorCanvas';
import {
  ResizeDocumentCommand,
  CropToSelectionCommand,
} from '@/components/image-editor/editor/ResizeCommands';
import type { ResizeAnchor } from '@/components/image-editor/editor/ResizeCommands';

// =============================================================================
// ImageEditorPanel
//
// Top-level container for the Phobos image editor. Follows the same
// self-managing panel pattern as EffluxPanel and ImageEditor:
//   - Reads imageEditorOpen from useAppStore (reusing the existing toggle)
//   - Returns null when closed (no DOM cost)
//   - Renders fullscreen overlay when open
//
// Architecture:
//   ImageEditorPanel (state, tool singletons, plugin singletons)
//     ├─ ToolBar (left — tool selection)
//     ├─ EditorCanvas (centre — Konva stage)  [lazy imported]
//     ├─ LayersPanel (right — layer management)
//     └─ EffectDialog (modal — effect parameters, when active)
//
// EditorCanvas is lazy-imported because it depends on Konva which is only
// needed when the panel is actually mounted. All other modules are static.
// =============================================================================

// Lazy import EditorCanvas (Konva dependency).
const EditorCanvas = React.lazy(() =>
  import('@/components/image-editor/ui/EditorCanvas').then(m => ({ default: m.EditorCanvas }))
);

// ---------------------------------------------------------------------------
// Tool singletons — created once for the session
// ---------------------------------------------------------------------------

const BRUSH   = new PaintBrushTool({ size: 20, hardness: 0.8, opacity: 1, color: '#000000' });
const PENCIL  = new PencilTool({ color: '#000000', opacity: 1, size: 1 });
const ERASER  = new EraserTool({ size: 20, opacity: 1 });
const BUCKET  = new PaintBucketTool({ color: '#000000ff', tolerance: 32, opacity: 1, globalFill: false });
const PICKER  = new ColorPickerTool({ sampleAllLayers: true }, () => {});
const RECT    = new RectSelectTool();
const ELLIPSE = new EllipseSelectTool();
const LASSO   = new LassoSelectTool();
const WAND    = new MagicWandTool();
const MOVE    = new MoveSelectionTool();
const TEXT    = new TextTool({ fontFamily: 'Arial', fontSize: 24, color: '#000000', bold: false, italic: false, antiAlias: true });
const GRADIENT = new GradientTool({
  mode: 'linear', repeat: 'none', opacity: 1,
  stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: 'rgba(0,0,0,0)' }],
});

const ALL_TOOLS = [BRUSH, PENCIL, ERASER, BUCKET, PICKER, RECT, ELLIPSE, LASSO, WAND, MOVE, TEXT, GRADIENT];

// Plugin singletons — worker spawned lazily on first open.
let _worker:   PluginWorker   | null = null;
let _registry: PluginRegistry | null = null;

function getPlugins(): { worker: PluginWorker; registry: PluginRegistry } {
  if (!_worker || !_registry) {
    _worker   = new PluginWorker(new URL('@/components/image-editor/plugins/PluginWorker.worker.ts', import.meta.url));
    _registry = new PluginRegistry(_worker);
  }
  return { worker: _worker, registry: _registry };
}

// ---------------------------------------------------------------------------
// Editor state (non-React — updated via refs and forceUpdate)
// ---------------------------------------------------------------------------

interface EditorMeta {
  canUndo:    boolean;
  canRedo:    boolean;
  layerCount: number;
  activeLayerIndex: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ImageEditorPanel() {
  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme === 'light';
  const styles = makeStyles(isLight);
  const panelOpen    = useAppStore(s => s.imageEditorOpen);
  const togglePanel  = useAppStore(s => s.toggleImageEditor);

  const [doc,          setDoc]          = useState<PhobosDocument | null>(null);
  const [activeToolId, setActiveToolId] = useState<ToolId>('paint-brush');
  const [effectManifest, setEffectManifest] = useState<PhobosPluginManifest | null>(null);
  const [foreColor,    setForeColor]    = useState('#000000');
  const [resizeOpen,   setResizeOpen]   = useState(false);
  const [backColor,    setBackColor]    = useState('#ffffff');
  const [, forceUpdate]                 = useReducer(x => x + 1, 0);

  // Text overlay state.
  const [textOverlay, setTextOverlay]   = useState<{ cssX: number; cssY: number } | null>(null);
  const textInputRef                    = useRef<HTMLTextAreaElement>(null);

  // Canvas handle ref — EditorCanvas exposes syncLayerNodes and updateSelectionOutline.
  const canvasHandleRef = useRef<EditorCanvasHandle | null>(null);

  // ToolController singleton.
  const controllerRef = useRef<ToolController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new ToolController(BRUSH, () => {
      forceUpdate();
    });
  }
  const controller = controllerRef.current;

  // Auto-save debounce.
  const autoSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleAutoSave = useCallback((d: PhobosDocument) => {
    if (autoSaveRef.current) clearTimeout(autoSaveRef.current);
    autoSaveRef.current = setTimeout(() => { void autoSave(d); }, 2000);
  }, []);

  // ---------------------------------------------------------------------------
  // Wire selection callbacks to canvas handle
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const handle = () => {
      const el = document.getElementById('phobos-editor-canvas') as any;
      return el?.__phobos as EditorCanvasHandle | undefined;
    };

    const updateHandle = () => {
      const h = handle();
      if (h) canvasHandleRef.current = h;
    };

    // Wire selection tools to the marching ants callback.
    const onSelChange = (pts: number[] | null) => {
      canvasHandleRef.current?.updateSelectionOutline(pts);
    };
    RECT.onSelectionChanged    = onSelChange;
    ELLIPSE.onSelectionChanged = onSelChange;
    LASSO.onSelectionChanged   = onSelChange;
    WAND.onSelectionChanged    = onSelChange;

    // Wire MoveSelectionTool float layer callbacks to canvas handle.
    MOVE.onFloatLayerAdded   = (layer) => canvasHandleRef.current?.addFloatLayer(layer);
    MOVE.onFloatLayerRemoved = (layer) => canvasHandleRef.current?.removeFloatLayer(layer);
    MOVE.onFloatLayerMoved   = (layer, x, y) => canvasHandleRef.current?.moveFloatLayer(layer, x, y);

    // Wire TextTool overlay callback.
    TEXT.onTextPlaced = (pending) => {
      setTextOverlay({ cssX: pending.cssX, cssY: pending.cssY });
    };

    // Wire ColorPickerTool callback.
    PICKER.onColorPicked = (rgba: RGBA) => {
      const hex = rgbaToHex(rgba);
      setForeColor(hex);
      updateBrushColor(hex);
    };

    updateHandle();
  }, []);

  // ---------------------------------------------------------------------------
  // New document
  // ---------------------------------------------------------------------------

  const handleNew = useCallback(() => {
    const dpr    = window.devicePixelRatio || 1;
    const newDoc = new PhobosDocument(800, 600, dpr);
    controller.bindDocument(newDoc);
    setDoc(newDoc);
    setActiveToolId('paint-brush');
    controller.setActiveTool(BRUSH);
  }, [controller]);

  // Open on first mount if no doc yet.
  useEffect(() => {
    if (panelOpen && !doc) handleNew();
  }, [panelOpen, doc, handleNew]);

  // ---------------------------------------------------------------------------
  // File operations
  // ---------------------------------------------------------------------------

  const handleOpen = useCallback(async () => {
    const file = await pickOpenFile();
    if (!file) return;
    try {
      const dpr    = window.devicePixelRatio || 1;
      const newDoc = await openFile(file, dpr);
      controller.bindDocument(newDoc);
      controller.setActiveTool(BRUSH);
      setDoc(newDoc);
      setActiveToolId('paint-brush');
      canvasHandleRef.current?.syncLayerNodes();
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  }, [controller]);

  const handleExport = useCallback(async (format: 'png' | 'jpeg' | 'webp' | 'phi') => {
    if (!doc) return;
    try {
      let blob: Blob;
      let ext: string;
      switch (format) {
        case 'png':  blob = await exportPNG(doc);  ext = 'png';  break;
        case 'jpeg': blob = await exportJPEG(doc); ext = 'jpg';  break;
        case 'webp': blob = await exportWebP(doc); ext = 'webp'; break;
        case 'phi':  blob = await exportPhi(doc);  ext = 'phi';  break;
      }
      downloadBlob(blob!, `phobos-export.${ext!}`);
    } catch (err) {
      console.error('Export failed:', err);
    }
  }, [doc]);

  // ---------------------------------------------------------------------------
  // Tool selection
  // ---------------------------------------------------------------------------

  const handleToolSelect = useCallback((id: ToolId) => {
    const tool = ALL_TOOLS.find(t => t.id === id);
    if (!tool) return;
    controller.setActiveTool(tool);
    setActiveToolId(id);
  }, [controller]);

  // ---------------------------------------------------------------------------
  // Colour management
  // ---------------------------------------------------------------------------

  const updateBrushColor = (hex: string) => {
    BRUSH.settings.color   = hex;
    PENCIL.settings.color  = hex;
    BUCKET.settings.color  = hex + 'ff';
    TEXT.settings.color    = hex;
  };

  const handleForeColorChange = useCallback((hex: string) => {
    setForeColor(hex);
    updateBrushColor(hex);
  }, []);

  // ---------------------------------------------------------------------------
  // Effect menu
  // ---------------------------------------------------------------------------

  const handleEffectSelect = useCallback((manifest: PhobosPluginManifest) => {
    setEffectManifest(manifest);
  }, []);

  // ---------------------------------------------------------------------------
  // Canvas menu
  // ---------------------------------------------------------------------------

  const handleCropToSelection = useCallback(() => {
    if (!doc) return;
    const cmd = new CropToSelectionCommand(doc);
    doc.history.push(cmd);
    forceUpdate();
    canvasHandleRef.current?.syncLayerNodes();
    scheduleAutoSave(doc);
  }, [doc, scheduleAutoSave]);

  const handleResizeApply = useCallback((
    newW: number,
    newH: number,
    anchor: ResizeAnchor,
  ) => {
    if (!doc) return;
    const cmd = new ResizeDocumentCommand(doc, newW, newH, anchor);
    doc.history.push(cmd);
    setResizeOpen(false);
    forceUpdate();
    canvasHandleRef.current?.syncLayerNodes();
    scheduleAutoSave(doc);
  }, [doc, scheduleAutoSave]);

  // ---------------------------------------------------------------------------
  // Text overlay commit
  // ---------------------------------------------------------------------------

  const commitText = useCallback(() => {
    if (!doc || !textOverlay || !textInputRef.current) return;
    const text = textInputRef.current.value;
    TEXT.commit(text, controller['_emit' as any], doc);
    setTextOverlay(null);
    canvasHandleRef.current?.syncLayerNodes();
  }, [doc, textOverlay, controller]);

  // ---------------------------------------------------------------------------
  // Layers sync
  // ---------------------------------------------------------------------------

  const handleLayersChange = useCallback(() => {
    canvasHandleRef.current?.syncLayerNodes();
    forceUpdate();
    if (doc) scheduleAutoSave(doc);
  }, [doc, scheduleAutoSave]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (!panelOpen) return null;

  const { worker, registry } = getPlugins();
  const effects = registry.list();

  return (
    <div style={styles.overlay}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.title}>Phobos Image Editor</span>
        <div style={styles.headerActions}>
          <button style={styles.headerBtn} onClick={handleNew}>New</button>
          <button style={styles.headerBtn} onClick={handleOpen}>Open</button>
          <div style={styles.exportMenu}>
            <span style={styles.headerBtn}>Export ▾</span>
            <div style={styles.exportDropdown}>
              {(['png','jpeg','webp','phi'] as const).map(f => (
                <button key={f} style={styles.dropdownItem} onClick={() => handleExport(f)}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          {effects.length > 0 && (
            <div style={styles.exportMenu}>
              <span style={styles.headerBtn}>Effects ▾</span>
              <div style={styles.exportDropdown}>
                {effects.map(m => (
                  <button key={m.id} style={styles.dropdownItem} onClick={() => handleEffectSelect(m)}>
                    {m.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {doc && (
            <div style={styles.exportMenu}>
              <span style={styles.headerBtn}>Canvas ▾</span>
              <div style={styles.exportDropdown}>
                <button style={styles.dropdownItem} onClick={() => setResizeOpen(true)}>
                  Resize Canvas…
                </button>
                <button
                  style={{
                    ...styles.dropdownItem,
                    opacity: doc.selection.empty ? 0.4 : 1,
                    cursor:  doc.selection.empty ? 'default' : 'pointer',
                  }}
                  onClick={handleCropToSelection}
                  disabled={doc.selection.empty}
                >
                  Crop to Selection
                </button>
              </div>
            </div>
          )}
          {doc && (
            <>
              <button
                style={{ ...styles.headerBtn, opacity: doc.history.canUndo ? 1 : 0.4 }}
                onClick={() => { controller.undo(); forceUpdate(); canvasHandleRef.current?.syncLayerNodes(); }}
                disabled={!doc.history.canUndo}
              >↩ Undo</button>
              <button
                style={{ ...styles.headerBtn, opacity: doc.history.canRedo ? 1 : 0.4 }}
                onClick={() => { controller.redo(); forceUpdate(); canvasHandleRef.current?.syncLayerNodes(); }}
                disabled={!doc.history.canRedo}
              >↪ Redo</button>
            </>
          )}
          <button style={styles.closeBtn} onClick={togglePanel}>✕</button>
        </div>
      </div>

      {/* Tool options bar */}
      <ToolOptionsBar
        activeToolId={activeToolId}
        brush={BRUSH}
        pencil={PENCIL}
        eraser={ERASER}
        bucket={BUCKET}
        wand={WAND}
        gradient={GRADIENT}
        text={TEXT}
        onSettingChange={() => {
          // Sync selection op from WAND to the other select tools so they all
          // share the same op without a separate state variable.
          RECT.op    = WAND.op;
          ELLIPSE.op = WAND.op;
          LASSO.op   = WAND.op;
          forceUpdate();
        }}
      />

      {/* Body */}
      <div style={styles.body}>
        {/* Tool bar */}
        <ToolBar activeId={activeToolId} onSelect={handleToolSelect} foreColor={foreColor} onForeColorChange={handleForeColorChange} styles={styles} />

        {/* Canvas area */}
        <div style={styles.canvasArea} id="phobos-editor-canvas">
          {doc ? (
            <React.Suspense fallback={<div style={styles.loading}>Loading canvas…</div>}>
              <EditorCanvas
                doc={doc}
                controller={controller}
                width={window.innerWidth - 280}  // approx — toolbar (60) + layers (220)
                height={window.innerHeight - 48}
                onStateChange={() => forceUpdate()}
              />
            </React.Suspense>
          ) : (
            <div style={styles.empty}>
              <button style={styles.newBtn} onClick={handleNew}>New Document</button>
              <button style={styles.newBtn} onClick={handleOpen}>Open Image</button>
            </div>
          )}

          {/* Text overlay */}
          {textOverlay && doc && (
            <textarea
              ref={textInputRef}
              autoFocus
              style={{
                ...styles.textOverlay,
                left: textOverlay.cssX + 60,  // offset for toolbar
                top:  textOverlay.cssY + 48,  // offset for header
              }}
              placeholder="Type here, Enter to commit"
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
                if (e.key === 'Escape') { setTextOverlay(null); }
              }}
              onBlur={commitText}
            />
          )}
        </div>

        {/* Layers panel */}
        {doc && (
          <LayersPanel
            doc={doc}
            emitter={cmd => { doc.history.push(cmd); forceUpdate(); scheduleAutoSave(doc); }}
            onLayersChange={handleLayersChange}
          />
        )}
      </div>

      {/* Effect dialog */}
      {effectManifest && doc && (
        <EffectDialog
          manifest={effectManifest}
          doc={doc}
          worker={worker}
          emitter={cmd => { doc.history.push(cmd); forceUpdate(); canvasHandleRef.current?.syncLayerNodes(); scheduleAutoSave(doc); }}
          onClose={() => setEffectManifest(null)}
        />
      )}

      {/* Canvas resize dialog */}
      {resizeOpen && doc && (
        <ResizeDialog
          currentW={doc.cssWidth}
          currentH={doc.cssHeight}
          onApply={handleResizeApply}
          onClose={() => setResizeOpen(false)}
        />
      )}
    </div>
  );
}

// =============================================================================
// ToolBar
// =============================================================================

interface ToolBarProps {
  activeId:          ToolId;
  onSelect:          (id: ToolId) => void;
  foreColor:         string;
  onForeColorChange: (hex: string) => void;
  styles:            ReturnType<typeof makeStyles>;
}

const TOOL_BUTTONS: { id: ToolId; label: string; title: string }[] = [
  { id: 'paint-brush',    label: '🖌',  title: 'Paint Brush (B)' },
  { id: 'pencil',         label: '✏',   title: 'Pencil (P)' },
  { id: 'eraser',         label: '⌫',   title: 'Eraser (E)' },
  { id: 'paint-bucket',   label: '🪣',  title: 'Paint Bucket (G)' },
  { id: 'color-picker',   label: '💉',  title: 'Color Picker (K)' },
  { id: 'text',           label: 'T',   title: 'Text (T)' },
  { id: 'gradient',       label: '◫',   title: 'Gradient (G)' },
  { id: 'rect-select',    label: '▭',   title: 'Rect Select (R)' },
  { id: 'ellipse-select', label: '◯',   title: 'Ellipse Select' },
  { id: 'lasso-select',   label: '⌇',   title: 'Lasso Select (L)' },
  { id: 'magic-wand',     label: '✦',   title: 'Magic Wand (W)' },
  { id: 'move-selection', label: '✥',   title: 'Move Selection (M)' },
  { id: 'zoom',           label: '🔍',  title: 'Zoom (Z)' },
  { id: 'pan',            label: '✋',  title: 'Pan (H)' },
];

function ToolBar({ activeId, onSelect, foreColor, onForeColorChange, styles }: ToolBarProps) {
  return (
    <div style={styles.toolbar}>
      {TOOL_BUTTONS.map(t => (
        <button
          key={t.id}
          title={t.title}
          onClick={() => onSelect(t.id)}
          style={{
            ...styles.toolBtn,
            ...(activeId === t.id ? styles.toolBtnActive : {}),
          }}
        >
          {t.label}
        </button>
      ))}
      <div style={styles.colorSwatch}>
        <input
          type="color"
          value={foreColor}
          onChange={e => onForeColorChange(e.target.value)}
          style={styles.colorInput}
          title="Foreground colour"
        />
      </div>
    </div>
  );
}

// =============================================================================
// ResizeDialog
// =============================================================================

const ANCHOR_CELLS: ResizeAnchor[] = [
  'top-left',    'top-center',    'top-right',
  'middle-left', 'center',        'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];

interface ResizeDialogProps {
  currentW: number;
  currentH: number;
  onApply:  (w: number, h: number, anchor: ResizeAnchor) => void;
  onClose:  () => void;
}

function ResizeDialog({ currentW, currentH, onApply, onClose }: ResizeDialogProps) {
  const [w,      setW]      = React.useState(Math.round(currentW));
  const [h,      setH]      = React.useState(Math.round(currentH));
  const [anchor, setAnchor] = React.useState<ResizeAnchor>('top-left');

  const handleApply = () => {
    if (w < 1 || h < 1) return;
    onApply(w, h, anchor);
  };

  return (
    <div style={rdStyles.overlay}>
      <div style={rdStyles.dialog}>
        <div style={rdStyles.header}>
          <span style={rdStyles.title}>Resize Canvas</span>
          <button style={rdStyles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={rdStyles.body}>
          <label style={rdStyles.fieldRow}>
            <span style={rdStyles.fieldLabel}>Width</span>
            <input
              type="number"
              min={1}
              value={w}
              onChange={e => setW(Math.max(1, parseInt(e.target.value, 10) || 1))}
              style={rdStyles.numInput}
            />
            <span style={rdStyles.unit}>px</span>
          </label>
          <label style={rdStyles.fieldRow}>
            <span style={rdStyles.fieldLabel}>Height</span>
            <input
              type="number"
              min={1}
              value={h}
              onChange={e => setH(Math.max(1, parseInt(e.target.value, 10) || 1))}
              style={rdStyles.numInput}
            />
            <span style={rdStyles.unit}>px</span>
          </label>

          <div style={rdStyles.anchorSection}>
            <span style={rdStyles.fieldLabel}>Anchor</span>
            <div style={rdStyles.anchorGrid}>
              {ANCHOR_CELLS.map(cell => (
                <button
                  key={cell}
                  onClick={() => setAnchor(cell)}
                  style={{
                    ...rdStyles.anchorCell,
                    background: anchor === cell ? '#4a7fe8' : 'hsl(var(--card))',
                    border: anchor === cell ? '1px solid #6a9ff8' : '1px solid #444',
                  }}
                  title={cell}
                />
              ))}
            </div>
          </div>
        </div>

        <div style={rdStyles.footer}>
          <button style={rdStyles.cancelBtn} onClick={onClose}>Cancel</button>
          <button style={rdStyles.applyBtn}  onClick={handleApply}>Apply</button>
        </div>
      </div>
    </div>
  );
}

const rdStyles = {
  overlay: {
    position:       'fixed'  as const,
    inset:          0,
    background:     'rgba(0,0,0,0.45)',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    zIndex:         1000,
  },
  dialog: {
    background:    'hsl(var(--secondary))',
    color:         '#e8e8e8',
    borderRadius:  6,
    width:         280,
    boxShadow:     '0 8px 32px rgba(0,0,0,0.6)',
    fontFamily:    'system-ui, sans-serif',
    fontSize:      13,
    display:       'flex',
    flexDirection: 'column' as const,
  },
  header: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    padding:        '12px 16px',
    borderBottom:   '1px solid #3a3a3a',
  },
  title: {
    fontWeight: 600,
    fontSize:   14,
  },
  closeBtn: {
    background: 'none',
    border:     'none',
    color:      '#999',
    cursor:     'pointer',
    fontSize:   16,
    lineHeight: 1,
    padding:    0,
  },
  body: {
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  },
  fieldRow: {
    display:    'flex',
    alignItems: 'center',
    gap:        8,
  },
  fieldLabel: {
    color:    '#aaa',
    fontSize: 12,
    width:    44,
    flexShrink: 0,
  },
  numInput: {
    width:        72,
    background:   'hsl(var(--card))',
    border:       '1px solid #444',
    color:        '#e8e8e8',
    borderRadius: 3,
    padding:      '3px 6px',
    fontSize:     13,
    textAlign:    'right' as const,
  },
  unit: {
    color:    '#666',
    fontSize: 11,
  },
  anchorSection: {
    display:       'flex',
    flexDirection: 'column' as const,
    gap:           6,
    marginTop:     4,
  },
  anchorGrid: {
    display:             'grid',
    gridTemplateColumns: 'repeat(3, 28px)',
    gap:                 3,
  },
  anchorCell: {
    width:        28,
    height:       28,
    borderRadius: 3,
    cursor:       'pointer',
    padding:      0,
  },
  footer: {
    display:        'flex',
    justifyContent: 'flex-end',
    gap:            8,
    padding:        '10px 16px',
    borderTop:      '1px solid #3a3a3a',
  },
  cancelBtn: {
    background:   '#3a3a3a',
    border:       '1px solid #555',
    color:        '#e8e8e8',
    borderRadius: 4,
    padding:      '6px 14px',
    cursor:       'pointer',
    fontSize:     13,
  },
  applyBtn: {
    background:   '#4a7fe8',
    border:       'none',
    color:        '#fff',
    borderRadius: 4,
    padding:      '6px 14px',
    cursor:       'pointer',
    fontSize:     13,
    fontWeight:   600,
  },
} as const;

// =============================================================================
// Helpers
// =============================================================================

function rgbaToHex(rgba: RGBA): string {
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${toHex(rgba.r)}${toHex(rgba.g)}${toHex(rgba.b)}`;
}

// =============================================================================
// Styles
// =============================================================================

function makeStyles(isLight: boolean) {
  return {
  overlay: {
    position:      'fixed' as const,
    inset:         0,
    background:    'hsl(var(--card))',
    display:       'flex',
    flexDirection: 'column' as const,
    zIndex:        900,
    fontFamily:    'system-ui, sans-serif',
    fontSize:      13,
    color:         isLight ? 'hsl(30 15% 8%)' : '#ccc',
  },
  header: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    padding:        '0 12px',
    height:         48,
    background:     isLight ? 'hsl(220 55% 18%)' : '#111',
    borderBottom:   isLight ? '1px solid hsl(220 45% 30%)' : '1px solid #333',
    flexShrink:     0,
  },
  title: {
    fontWeight: 600,
    fontSize:   14,
    color:      isLight ? 'hsl(220 20% 88%)' : '#eee',
    letterSpacing: 0.5,
  },
  headerActions: {
    display:    'flex',
    alignItems: 'center',
    gap:        6,
  },
  headerBtn: {
    background:   isLight ? 'hsl(220 50% 26%)' : 'hsl(var(--secondary))',
    border:       isLight ? '1px solid hsl(220 45% 40%)' : '1px solid #444',
    color:        isLight ? 'hsl(220 20% 85%)' : '#ccc',
    borderRadius: 4,
    padding:      '4px 10px',
    cursor:       'pointer',
    fontSize:     12,
  },
  closeBtn: {
    background:   'none',
    border:       'none',
    color:        isLight ? 'hsl(220 20% 75%)' : '#888',
    cursor:       'pointer',
    fontSize:     18,
    padding:      '0 4px',
    lineHeight:   1,
  },
  exportMenu: {
    position: 'relative' as const,
    display:  'inline-block',
    '&:hover > div': { display: 'block' },
  },
  exportDropdown: {
    display:      'none',
    position:     'absolute' as const,
    top:          '100%',
    right:        0,
    background:   isLight ? 'hsl(35 20% 90%)' : 'hsl(var(--secondary))',
    border:       isLight ? '1px solid hsl(35 25% 60%)' : '1px solid #444',
    borderRadius: 4,
    zIndex:       10,
    minWidth:     80,
  },
  dropdownItem: {
    display:    'block',
    width:      '100%',
    background: 'none',
    border:     'none',
    color:      isLight ? 'hsl(30 15% 8%)' : '#ccc',
    padding:    '6px 12px',
    cursor:     'pointer',
    textAlign:  'left' as const,
    fontSize:   12,
  },
  body: {
    display:  'flex',
    flex:     1,
    overflow: 'hidden',
  },
  toolbar: {
    display:       'flex',
    flexDirection: 'column' as const,
    alignItems:    'center',
    gap:           2,
    padding:       '8px 4px',
    background:    isLight ? 'hsl(220 50% 22%)' : '#111',
    borderRight:   isLight ? '1px solid hsl(220 45% 32%)' : '1px solid #333',
    width:         44,
    flexShrink:    0,
    overflowY:     'auto' as const,
  },
  toolBtn: {
    background:   'none',
    border:       '1px solid transparent',
    color:        isLight ? 'hsl(220 20% 75%)' : '#aaa',
    borderRadius: 4,
    width:        34,
    height:       34,
    cursor:       'pointer',
    fontSize:     16,
    display:      'flex',
    alignItems:   'center',
    justifyContent: 'center',
  },
  toolBtnActive: {
    background:  '#2c3e50',
    borderColor: '#4a7fe8',
    color:       '#fff',
  },
  colorSwatch: {
    marginTop: 8,
    width:     28,
    height:    28,
  },
  colorInput: {
    width:  28,
    height: 28,
    border: '1px solid #555',
    padding: 0,
    cursor:  'pointer',
    borderRadius: 4,
  },
  canvasArea: {
    flex:       1,
    overflow:   'hidden',
    position:   'relative' as const,
    background: 'hsl(var(--secondary))',
  },
  loading: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    height:         '100%',
    color:          '#666',
  },
  empty: {
    display:        'flex',
    flexDirection:  'column' as const,
    alignItems:     'center',
    justifyContent: 'center',
    gap:            16,
    height:         '100%',
  },
  newBtn: {
    background:   isLight ? 'hsl(220 50% 26%)' : '#2a3a4a',
    border:       isLight ? '1px solid hsl(220 55% 45%)' : '1px solid #4a7fe8',
    color:        isLight ? 'hsl(220 20% 85%)' : '#ccc',
    borderRadius: 6,
    padding:      '10px 24px',
    cursor:       'pointer',
    fontSize:     14,
  },
  textOverlay: {
    position:   'absolute' as const,
    background: 'rgba(0,0,30,0.7)',
    border:     '1px dashed #4a7fe8',
    color:      '#fff',
    padding:    '4px 6px',
    fontSize:   16,
    fontFamily: 'Arial, sans-serif',
    minWidth:   160,
    minHeight:  32,
    resize:     'both' as const,
    outline:    'none',
    zIndex:     10,
  },
  } as const;
}