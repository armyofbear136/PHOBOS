import React, { useCallback, useRef, useState } from 'react';
import type { PhobosDocument }   from '../editor/PhobosDocument';
import type { PhobosLayer }      from '../editor/PhobosLayer';
import { RasterCommand }         from '../editor/RasterCommand';
import { SelectionCommand }      from '../editor/SelectionCommand';
import type { CommandEmitter }   from '../tools/ToolController';
import type { BlendMode }        from '../types';
import { BLEND_MODES }           from '../types';

// =============================================================================
// LayersPanel
//
// Renders the ordered layer list (bottom → top = index 0 → N-1 displayed top
// to bottom so the top layer appears first in the UI, matching Photoshop/PDN).
//
// Operations:
//   - Click layer row → setActiveLayer
//   - Drag row → reorder (calls doc.moveLayer + syncLayerNodes)
//   - Eye icon → toggle visibility
//   - Lock icon → toggle locked
//   - Opacity slider → change opacity
//   - Blend mode dropdown → change blend mode
//   - + button → addLayer
//   - trash button → removeLayer (disabled when only 1 layer)
//
// All layer mutations call onLayersChange() which triggers syncLayerNodes() → GPU composite.
// Non-pixel mutations (opacity, visibility, blend mode, reorder) do NOT go
// through the CommandStack — they are direct mutations. This matches PDN's
// behaviour and avoids the complexity of undo-ing visual-only changes.
// Pixel-destructive operations (flatten, merge) DO go through the stack.
// =============================================================================

interface LayersPanelProps {
  doc:            PhobosDocument;
  emitter:        CommandEmitter;
  onLayersChange: () => void;   // → EditorCanvas.syncLayerNodes()
}

export function LayersPanel({ doc, emitter, onLayersChange }: LayersPanelProps) {
  const [dragIndex, setDragIndex]   = useState<number | null>(null);
  const [overIndex, setOverIndex]   = useState<number | null>(null);
  const dragLayerId                 = useRef<number | null>(null);

  // Display order: top layer first (reversed from doc.layers array)
  const displayLayers = [...doc.layers].reverse();
  const toDocIndex    = (displayIdx: number) => doc.layers.length - 1 - displayIdx;

  // ---------------------------------------------------------------------------
  // Active layer selection
  // ---------------------------------------------------------------------------

  const handleSelect = useCallback((displayIdx: number) => {
    doc.setActiveLayer(toDocIndex(displayIdx));
    onLayersChange();
  }, [doc, onLayersChange]);

  // ---------------------------------------------------------------------------
  // Visibility / locked toggles — direct mutation, no command
  // ---------------------------------------------------------------------------

  const toggleVisible = useCallback((layer: PhobosLayer, e: React.MouseEvent) => {
    e.stopPropagation();
    layer.visible = !layer.visible;
    onLayersChange();
  }, [onLayersChange]);

  const toggleLocked = useCallback((layer: PhobosLayer, e: React.MouseEvent) => {
    e.stopPropagation();
    layer.locked = !layer.locked;
    onLayersChange();
  }, [onLayersChange]);

  // ---------------------------------------------------------------------------
  // Opacity — direct mutation
  // ---------------------------------------------------------------------------

  const handleOpacity = useCallback((layer: PhobosLayer, value: number) => {
    layer.opacity = value / 100;
    onLayersChange();
  }, [onLayersChange]);

  // ---------------------------------------------------------------------------
  // Blend mode — direct mutation
  // ---------------------------------------------------------------------------

  const handleBlendMode = useCallback((layer: PhobosLayer, mode: BlendMode) => {
    layer.blendMode = mode;
    onLayersChange();
  }, [onLayersChange]);

  // ---------------------------------------------------------------------------
  // Add / remove layers
  // ---------------------------------------------------------------------------

  const handleAdd = useCallback(() => {
    doc.addLayer({ name: `Layer ${doc.layers.length + 1}` });
    onLayersChange();
  }, [doc, onLayersChange]);

  const handleDelete = useCallback((layer: PhobosLayer, e: React.MouseEvent) => {
    e.stopPropagation();
    if (doc.layers.length === 1) return;
    try {
      doc.removeLayer(layer.id);
      onLayersChange();
    } catch { /* ignore — last layer guard */ }
  }, [doc, onLayersChange]);

  // ---------------------------------------------------------------------------
  // Rename (inline edit)
  // ---------------------------------------------------------------------------

  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const startRename = useCallback((layer: PhobosLayer, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingId(layer.id);
    setRenameValue(layer.name);
  }, []);

  const commitRename = useCallback((layer: PhobosLayer) => {
    if (renameValue.trim()) layer.name = renameValue.trim();
    setRenamingId(null);
    onLayersChange();
  }, [renameValue, onLayersChange]);

  // ---------------------------------------------------------------------------
  // Drag to reorder
  // ---------------------------------------------------------------------------

  const handleDragStart = useCallback((displayIdx: number, layer: PhobosLayer) => {
    setDragIndex(displayIdx);
    dragLayerId.current = layer.id;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, displayIdx: number) => {
    e.preventDefault();
    setOverIndex(displayIdx);
  }, []);

  const handleDrop = useCallback((displayIdx: number) => {
    if (dragLayerId.current === null || dragIndex === null || dragIndex === displayIdx) {
      setDragIndex(null);
      setOverIndex(null);
      return;
    }
    // Convert display indices to doc indices for moveLayer
    const fromDoc = toDocIndex(dragIndex);
    const toDoc   = toDocIndex(displayIdx);
    doc.moveLayer(dragLayerId.current, toDoc);
    // Restore active layer index after reorder
    const movedLayer = doc.layers.find(l => l.id === dragLayerId.current);
    if (movedLayer) {
      const newIdx = doc.layers.indexOf(movedLayer);
      if (newIdx !== -1) doc.setActiveLayer(newIdx);
    }
    setDragIndex(null);
    setOverIndex(null);
    dragLayerId.current = null;
    onLayersChange();
  }, [doc, dragIndex, onLayersChange]);

  // ---------------------------------------------------------------------------
  // Flatten visible — merges all visible layers into one RasterCommand
  // ---------------------------------------------------------------------------

  const handleFlatten = useCallback(() => {
    if (doc.layers.length < 2) return;
    const target = doc.layers[0];
    const cmd = new RasterCommand('Flatten Image', target, undefined, () => {
      const flat = doc.flatten();
      const imgData = target.getImageData();
      // Draw flattened result into layer 0
      target.ctx.clearRect(0, 0, doc.physicalWidth, doc.physicalHeight);
      target.ctx.drawImage(flat, 0, 0);
      // Remove all other layers
      const toRemove = doc.layers.slice(1).map(l => l.id);
      for (const id of toRemove) {
        try { doc.removeLayer(id); } catch { /* ignore */ }
      }
      doc.setActiveLayer(0);
    });
    emitter(cmd);
    onLayersChange();
  }, [doc, emitter, onLayersChange]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const activeLayer = doc.activeLayer;

  return (
    <div style={styles.panel}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.headerTitle}>Layers</span>
        <div style={styles.headerActions}>
          <button style={styles.iconBtn} onClick={handleFlatten} title="Flatten image" disabled={doc.layers.length < 2}>
            ⊞
          </button>
          <button style={styles.iconBtn} onClick={handleAdd} title="Add layer">
            +
          </button>
        </div>
      </div>

      {/* Blend mode + opacity for active layer */}
      {activeLayer && (
        <div style={styles.activeControls}>
          <select
            style={styles.select}
            value={activeLayer.blendMode}
            onChange={e => handleBlendMode(activeLayer, e.target.value as BlendMode)}
          >
            {BLEND_MODES.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <div style={styles.opacityRow}>
            <span style={styles.opacityLabel}>Opacity</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(activeLayer.opacity * 100)}
              onChange={e => handleOpacity(activeLayer, parseInt(e.target.value))}
              style={styles.opacitySlider}
            />
            <span style={styles.opacityValue}>{Math.round(activeLayer.opacity * 100)}%</span>
          </div>
        </div>
      )}

      {/* Layer list */}
      <div style={styles.list}>
        {displayLayers.map((layer, displayIdx) => {
          const isActive   = layer.id === activeLayer?.id;
          const isDragging = displayIdx === dragIndex;
          const isOver     = displayIdx === overIndex && displayIdx !== dragIndex;

          return (
            <div
              key={layer.id}
              draggable
              onDragStart={() => handleDragStart(displayIdx, layer)}
              onDragOver={e => handleDragOver(e, displayIdx)}
              onDrop={() => handleDrop(displayIdx)}
              onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
              onClick={() => handleSelect(displayIdx)}
              style={{
                ...styles.layerRow,
                ...(isActive   ? styles.layerRowActive   : {}),
                ...(isDragging ? styles.layerRowDragging : {}),
                ...(isOver     ? styles.layerRowOver     : {}),
              }}
            >
              {/* Thumbnail */}
              <canvas
                width={32}
                height={24}
                ref={el => {
                  if (!el) return;
                  const ctx = el.getContext('2d');
                  if (ctx) ctx.drawImage(layer.canvas, 0, 0, 32, 24);
                }}
                style={styles.thumb}
              />

              {/* Name */}
              <div style={styles.layerName}>
                {renamingId === layer.id ? (
                  <input
                    autoFocus
                    style={styles.renameInput}
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={() => commitRename(layer)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename(layer);
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <span
                    onDoubleClick={e => startRename(layer, e)}
                    style={{ opacity: layer.visible ? 1 : 0.4 }}
                  >
                    {layer.name}
                  </span>
                )}
              </div>

              {/* Actions */}
              <div style={styles.layerActions}>
                <button
                  style={styles.microBtn}
                  onClick={e => toggleVisible(layer, e)}
                  title={layer.visible ? 'Hide layer' : 'Show layer'}
                >
                  {layer.visible ? '👁' : '⊘'}
                </button>
                <button
                  style={styles.microBtn}
                  onClick={e => toggleLocked(layer, e)}
                  title={layer.locked ? 'Unlock layer' : 'Lock layer'}
                >
                  {layer.locked ? '🔒' : '🔓'}
                </button>
                <button
                  style={{ ...styles.microBtn, opacity: doc.layers.length === 1 ? 0.3 : 1 }}
                  onClick={e => handleDelete(layer, e)}
                  title="Delete layer"
                  disabled={doc.layers.length === 1}
                >
                  🗑
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// Styles
// =============================================================================

const styles = {
  panel: {
    display:       'flex',
    flexDirection: 'column' as const,
    background:    '#1e1e1e',
    borderLeft:    '1px solid #333',
    width:         220,
    height:        '100%',
    overflow:      'hidden',
    fontSize:      12,
    fontFamily:    'system-ui, sans-serif',
    color:         '#ccc',
  },
  header: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    padding:        '6px 10px',
    borderBottom:   '1px solid #333',
    flexShrink:     0,
  },
  headerTitle: {
    fontWeight: 600,
    fontSize:   12,
    color:      '#ddd',
  },
  headerActions: {
    display: 'flex',
    gap:     4,
  },
  iconBtn: {
    background:   'none',
    border:       '1px solid #444',
    color:        '#aaa',
    borderRadius: 3,
    padding:      '1px 6px',
    cursor:       'pointer',
    fontSize:     14,
    lineHeight:   1,
  },
  activeControls: {
    padding:      '6px 10px',
    borderBottom: '1px solid #2a2a2a',
    flexShrink:   0,
  },
  select: {
    width:        '100%',
    background:   'hsl(var(--secondary))',
    border:       '1px solid #444',
    color:        '#ccc',
    borderRadius: 3,
    padding:      '3px 4px',
    fontSize:     11,
    marginBottom: 4,
    cursor:       'pointer',
  },
  opacityRow: {
    display:    'flex',
    alignItems: 'center',
    gap:        6,
  },
  opacityLabel: {
    fontSize:   10,
    color:      '#888',
    flexShrink: 0,
  },
  opacitySlider: {
    flex:   1,
    cursor: 'pointer',
  },
  opacityValue: {
    fontSize:   10,
    color:      '#888',
    width:      28,
    textAlign:  'right' as const,
    flexShrink: 0,
  },
  list: {
    flex:      1,
    overflowY: 'auto' as const,
    padding:   '2px 0',
  },
  layerRow: {
    display:     'flex',
    alignItems:  'center',
    gap:         6,
    padding:     '4px 8px',
    cursor:      'pointer',
    userSelect:  'none' as const,
    borderLeft:  '2px solid transparent',
    transition:  'background 0.08s',
  },
  layerRowActive: {
    background:  '#2c3e50',
    borderLeft:  '2px solid #4a7fe8',
  },
  layerRowDragging: {
    opacity: 0.4,
  },
  layerRowOver: {
    borderTop: '2px solid #4a7fe8',
  },
  thumb: {
    width:        32,
    height:       24,
    borderRadius: 2,
    border:       '1px solid #444',
    flexShrink:   0,
    imageRendering: 'pixelated' as const,
  },
  layerName: {
    flex:         1,
    overflow:     'hidden',
    textOverflow: 'ellipsis',
    whiteSpace:   'nowrap' as const,
    fontSize:     11,
  },
  renameInput: {
    background:   '#1a2a3a',
    border:       '1px solid #4a7fe8',
    color:        '#eee',
    borderRadius: 2,
    padding:      '1px 4px',
    fontSize:     11,
    width:        '100%',
  },
  layerActions: {
    display:    'flex',
    gap:        2,
    flexShrink: 0,
  },
  microBtn: {
    background: 'none',
    border:     'none',
    cursor:     'pointer',
    padding:    1,
    fontSize:   12,
    lineHeight: 1,
    opacity:    0.7,
  },
} as const;
