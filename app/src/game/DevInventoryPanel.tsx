/**
 * DevInventoryPanel — developer tool for manually seeding inventory.
 *
 * Access: type password 'sadbear' into the password field.
 * Shows all materials from CraftingMaterials with a quantity input.
 * Clicking an item adds that quantity to the player's inventory via the API.
 *
 * Not mounted in production builds conditionally — it's always in the tree
 * but requires the correct password to interact with, and the add buttons
 * are only shown after auth. Zero game impact when not in use.
 */

import { useState, useEffect, useRef } from 'react';
import { ALL_MATERIALS, type MaterialProps } from './CraftingMaterials';
import { WorldScene } from './WorldScene';
import type { WorldScene as WS } from './WorldScene';
import { PERMANENT_BUILDINGS } from './HubBuildingCatalog';

// ── Types ──────────────────────────────────────────────────────────────────

interface Props {
  engineUrl:    string;
  onClose:      () => void;
  onItemAdded:  (materialId: string, quantity: number) => void;
  onEtherAdded: (amount: number) => void;
}

// ── Style tokens ───────────────────────────────────────────────────────────

const PANEL_BG  = 'rgba(8,8,8,0.98)';
const BORDER    = '#1e1e1e';
const ACCENT    = '#a855f7';  // purple — dev-only visual indicator
const TEXT_DIM  = '#444';
const TEXT_MED  = '#777';
const TEXT_MAIN = '#bbb';
const GREEN     = '#4ade80';

const DEV_PASSWORD = 'sadbear';

// ── Category color map ─────────────────────────────────────────────────────

const CAT_COLOR: Record<string, string> = {
  textile: '#a3785a',
  stone:   '#8899aa',
  wood:    '#7a6040',
};

// ── Component ──────────────────────────────────────────────────────────────

export function DevInventoryPanel({ engineUrl, onClose, onItemAdded, onEtherAdded }: Props) {
  const [password, setPassword]   = useState('');
  const [authed,   setAuthed]     = useState(false);
  const [qty,      setQty]        = useState(5);
  const [etherAmt, setEtherAmt]   = useState(500);
  const [adding,   setAdding]     = useState<string | null>(null);
  const [addingEther, setAddingEther] = useState(false);
  const [feedback, setFeedback]   = useState<string | null>(null);
  const [filter,   setFilter]     = useState('');
  const [mouseDebug, setMouseDebug] = useState(false);
  const [debugData,  setDebugData]  = useState<WS.DebugData | null>(null);
  const [blockedOverlay, setBlockedOverlay] = useState(false);
  const [nudgeTick, setNudgeTick] = useState(0);

  const handlePasswordSubmit = () => {
    if (password === DEV_PASSWORD) setAuthed(true);
    else setPassword('');
  };

  const handleAddEther = async () => {
    if (addingEther || etherAmt < 1) return;
    const base = engineUrl.replace(/\/$/, '');
    setAddingEther(true);
    try {
      await fetch(`${base}/api/game/ether/bank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deposit', amount: etherAmt }),
      });
      onEtherAdded(etherAmt);
      setFeedback(`+${etherAmt} ether deposited`);
      setTimeout(() => setFeedback(null), 2000);
    } catch {
      setFeedback('Ether add failed');
    } finally {
      setAddingEther(false);
    }
  };

  const handleAdd = async (mat: MaterialProps) => {
    if (adding) return;
    const base = engineUrl.replace(/\/$/, '');
    setAdding(mat.id);
    try {
      for (let i = 0; i < qty; i++) {
        await fetch(`${base}/api/game/inventory/add`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            item_id:  mat.id,
            target:   'player',
            slot:     'material',
            rarity:   0,
            data:     JSON.stringify({ materialId: mat.id, name: mat.name, type: 'crafting_material' }),
          }),
        });
      }
      onItemAdded(mat.id, qty);
      setFeedback(`+${qty}× ${mat.name}`);
      setTimeout(() => setFeedback(null), 2000);
    } catch {
      setFeedback('Add failed');
    } finally {
      setAdding(null);
    }
  };

  const filtered = ALL_MATERIALS.filter(m =>
    !filter || m.name.toLowerCase().includes(filter.toLowerCase()) || m.category.includes(filter.toLowerCase())
  );

  const nudgeBtn: React.CSSProperties = {
    width: 16, height: 16, fontSize: 9, lineHeight: '16px', padding: 0,
    background: 'rgba(255,255,255,0.06)', border: '1px solid #333',
    borderRadius: 2, cursor: 'pointer', color: '#ff9999', textAlign: 'center',
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 300,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.7)',
    }}>
      <div style={{
        width: 420, maxHeight: '85vh',
        background: PANEL_BG, border: `1px solid ${ACCENT}55`,
        borderRadius: 8, display: 'flex', flexDirection: 'column',
        boxShadow: `0 0 40px ${ACCENT}22, 0 8px 40px rgba(0,0,0,0.9)`,
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '12px 16px', borderBottom: `1px solid ${BORDER}`,
          background: `linear-gradient(90deg, rgba(168,85,247,0.08) 0%, transparent 100%)`,
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 11, fontFamily: 'monospace', fontWeight: 700, color: ACCENT, letterSpacing: 2 }}>
              ⚙ DEV · INVENTORY
            </div>
            <div style={{ fontSize: 7, fontFamily: 'monospace', color: TEXT_DIM, marginTop: 2 }}>
              {authed ? 'Authorised — add materials to player inventory' : 'Enter developer password'}
            </div>
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: TEXT_DIM, fontSize: 16, cursor: 'pointer',
          }}>✕</button>
        </div>

        {/* Password gate */}
        {!authed ? (
          <div style={{ padding: '24px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handlePasswordSubmit(); }}
              placeholder="Password"
              autoFocus
              style={{
                background: '#0a0a0a', border: `1px solid ${BORDER}`,
                borderRadius: 4, padding: '8px 12px',
                fontFamily: 'monospace', fontSize: 11, color: TEXT_MAIN,
                outline: 'none',
              }}
            />
            <button
              onClick={handlePasswordSubmit}
              style={{
                padding: '7px', fontSize: 10, fontFamily: 'monospace', fontWeight: 700,
                background: 'rgba(168,85,247,0.12)', color: ACCENT,
                border: `1px solid ${ACCENT}55`, borderRadius: 4, cursor: 'pointer',
              }}
            >
              UNLOCK
            </button>
          </div>
        ) : (
          <>
            {/* Controls */}
            <div style={{
              padding: '10px 16px', borderBottom: `1px solid ${BORDER}`,
              display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0,
            }}>
              <input
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="Filter…"
                style={{
                  flex: 1, background: '#0a0a0a', border: `1px solid ${BORDER}`,
                  borderRadius: 4, padding: '5px 10px',
                  fontFamily: 'monospace', fontSize: 10, color: TEXT_MAIN, outline: 'none',
                }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <span style={{ fontSize: 9, fontFamily: 'monospace', color: TEXT_DIM }}>QTY</span>
                <button onClick={() => setQty(q => Math.max(1, q - 1))}
                  style={smallBtn}>−</button>
                <span style={{ fontSize: 11, fontFamily: 'monospace', color: TEXT_MAIN, minWidth: 20, textAlign: 'center' }}>
                  {qty}
                </span>
                <button onClick={() => setQty(q => Math.min(99, q + 1))}
                  style={smallBtn}>+</button>
              </div>
            </div>

            {feedback && (
              <div style={{
                margin: '6px 16px 0', padding: '4px 10px', fontSize: 9,
                fontFamily: 'monospace', borderRadius: 3,
                background: 'rgba(74,222,128,0.1)', color: GREEN,
                border: `1px solid #4ade8033`,
              }}>
                {feedback}
              </div>
            )}

            {/* Mouse debug toggle */}
            <div style={{ margin: '6px 16px 0' }}>
              <button
                onClick={() => {
                  const next = !mouseDebug;
                  setMouseDebug(next);
                  (window as any).__phobosDebugActivate?.(next);
                }}
                style={{
                  width: '100%', padding: '5px', fontSize: 9, fontFamily: 'monospace',
                  background: mouseDebug ? 'rgba(255,255,0,0.12)' : 'rgba(255,255,255,0.04)',
                  color: mouseDebug ? '#ffff00' : '#555',
                  border: `1px solid ${mouseDebug ? '#ffff0044' : '#1e1e1e'}`,
                  borderRadius: 4, cursor: 'pointer',
                }}
              >
                {mouseDebug ? '◉ MOUSE DEBUG ON' : '○ MOUSE DEBUG OFF'}
              </button>
            </div>

            {/* Blocked tile overlay toggle */}
            <div style={{ margin: '4px 16px 0' }}>
              <button
                onClick={() => {
                  const next = !blockedOverlay;
                  setBlockedOverlay(next);
                  (window as any).__phobosSetBlockedOverlay?.(next);
                }}
                style={{
                  width: '100%', padding: '5px', fontSize: 9, fontFamily: 'monospace',
                  background: blockedOverlay ? 'rgba(255,34,34,0.14)' : 'rgba(255,255,255,0.04)',
                  color: blockedOverlay ? '#ff4444' : '#555',
                  border: `1px solid ${blockedOverlay ? '#ff444444' : '#1e1e1e'}`,
                  borderRadius: 4, cursor: 'pointer',
                }}
              >
                {blockedOverlay ? '◉ BLOCKED TILES ON' : '○ BLOCKED TILES OFF'}
              </button>
            </div>

            {/* Footprint tuning table — only shown when overlay is active */}
            {blockedOverlay && (
              <div style={{
                margin: '4px 16px 0', padding: '6px 8px', borderRadius: 4,
                background: 'rgba(255,34,34,0.06)', border: '1px solid rgba(255,34,34,0.2)',
              }}>
                <div style={{ fontSize: 8, fontFamily: 'monospace', color: '#ff6666', marginBottom: 4, letterSpacing: 1 }}>
                  FOOTPRINT TUNING #{nudgeTick} — nudge then read console
                </div>
                {PERMANENT_BUILDINGS.map(b => (
                  <div key={b.id} style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    marginBottom: 3, fontSize: 8, fontFamily: 'monospace', color: '#ccc',
                  }}>
                    <span style={{ width: 68, flexShrink: 0, color: '#ff9999' }}>{b.id.replace('perm-', '')}</span>
                    {/* TX nudge */}
                    <span style={{ color: '#888' }}>TX</span>
                    <button onClick={() => { (window as any).__phobosNudgeFootprint?.(b.id, -1, 0); setNudgeTick(t => t + 1); }}
                      style={nudgeBtn}>←</button>
                    <button onClick={() => { (window as any).__phobosNudgeFootprint?.(b.id, +1, 0); setNudgeTick(t => t + 1); }}
                      style={nudgeBtn}>→</button>
                    {/* TY nudge */}
                    <span style={{ color: '#888', marginLeft: 4 }}>TY</span>
                    <button onClick={() => { (window as any).__phobosNudgeFootprint?.(b.id, 0, -1); setNudgeTick(t => t + 1); }}
                      style={nudgeBtn}>↑</button>
                    <button onClick={() => { (window as any).__phobosNudgeFootprint?.(b.id, 0, +1); setNudgeTick(t => t + 1); }}
                      style={nudgeBtn}>↓</button>
                    <span style={{ color: '#555', marginLeft: 4 }}>
                      ({b.anchorTx},{b.anchorTy}) {b.footprintW}×{b.footprintH}
                    </span>
                  </div>
                ))}
                <div style={{ fontSize: 7, color: '#666', marginTop: 4, fontFamily: 'monospace' }}>
                  TX ←→ = west/east  ·  TY ↑↓ = north/south  ·  overlay redraws live
                </div>
              </div>
            )}

            {/* Zone structure footprint tuning */}
            {blockedOverlay && (
              <div style={{
                margin: '4px 16px 0', padding: '6px 8px', borderRadius: 4,
                background: 'rgba(255,100,34,0.06)', border: '1px solid rgba(255,100,34,0.2)',
              }}>
                <div style={{ fontSize: 8, fontFamily: 'monospace', color: '#ff9966', marginBottom: 4, letterSpacing: 1 }}>
                  ZONE STRUCTURES #{nudgeTick}
                </div>
                {[
                  { id: 'relay_tower' }, { id: 'dispatch_desk' }, { id: 'crystal_lab' },
                  { id: 'thought_chamber' }, { id: 'telescope' }, { id: 'archive_mound' },
                  { id: 'catalogue_table' }, { id: 'obelisk' }, { id: 'portal' }, { id: 'battle_hall' },
                ].map(s => (
                  <div key={s.id} style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    marginBottom: 3, fontSize: 8, fontFamily: 'monospace', color: '#ccc',
                  }}>
                    <span style={{ width: 88, flexShrink: 0, color: '#ffbb99' }}>{s.id.replace('_', ' ')}</span>
                    <span style={{ color: '#888' }}>TX</span>
                    <button onClick={() => { (window as any).__phobosNudgeZoneFootprint?.(s.id, -1, 0); setNudgeTick(t => t + 1); }}
                      style={nudgeBtn}>←</button>
                    <button onClick={() => { (window as any).__phobosNudgeZoneFootprint?.(s.id, +1, 0); setNudgeTick(t => t + 1); }}
                      style={nudgeBtn}>→</button>
                    <span style={{ color: '#888', marginLeft: 4 }}>TY</span>
                    <button onClick={() => { (window as any).__phobosNudgeZoneFootprint?.(s.id, 0, -1); setNudgeTick(t => t + 1); }}
                      style={nudgeBtn}>↑</button>
                    <button onClick={() => { (window as any).__phobosNudgeZoneFootprint?.(s.id, 0, +1); setNudgeTick(t => t + 1); }}
                      style={nudgeBtn}>↓</button>
                  </div>
                ))}
              </div>
            )}
            <div style={{
              margin: '8px 16px 0', padding: '8px 10px', borderRadius: 5,
              background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.2)',
              display: 'flex', alignItems: 'center', gap: 8,
            }}>
              <span style={{ fontSize: 9, fontFamily: 'monospace', color: '#f59e0b', fontWeight: 700, flexShrink: 0 }}>
                ◆ ETHER
              </span>
              <input
                type="number"
                min={1}
                max={99999}
                value={etherAmt}
                onChange={e => setEtherAmt(Math.max(1, parseInt(e.target.value) || 1))}
                style={{
                  flex: 1, background: '#0a0a0a', border: '1px solid #1e1e1e',
                  borderRadius: 3, padding: '4px 8px',
                  fontFamily: 'monospace', fontSize: 10, color: '#f59e0b', outline: 'none',
                  minWidth: 0,
                }}
              />
              <button
                onClick={handleAddEther}
                disabled={addingEther}
                style={{
                  padding: '4px 12px', fontSize: 9, fontFamily: 'monospace', fontWeight: 700,
                  background: 'rgba(245,158,11,0.15)', color: '#f59e0b',
                  border: '1px solid rgba(245,158,11,0.4)', borderRadius: 3,
                  cursor: addingEther ? 'default' : 'pointer', flexShrink: 0,
                }}
              >
                {addingEther ? '…' : 'ADD'}
              </button>
            </div>

            {/* Material list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px 16px' }}>
              {filtered.map(mat => {
                const isAdding = adding === mat.id;
                const catColor = CAT_COLOR[mat.category] ?? TEXT_DIM;

                return (
                  <div
                    key={mat.id}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '6px 8px', marginBottom: 3, borderRadius: 4,
                      background: 'rgba(255,255,255,0.02)', border: `1px solid ${BORDER}`,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {/* Colour swatch */}
                      <div style={{
                        width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
                        background: mat.tint != null
                          ? `#${(mat.tint as number).toString(16).padStart(6, '0')}`
                          : catColor,
                      }} />
                      <div>
                        <span style={{ fontSize: 10, fontFamily: 'monospace', color: TEXT_MAIN }}>
                          {mat.name}
                        </span>
                        <span style={{ fontSize: 7, fontFamily: 'monospace', color: TEXT_DIM, marginLeft: 6 }}>
                          T{mat.tier} · {mat.category}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => handleAdd(mat)}
                      disabled={!!adding}
                      style={{
                        padding: '3px 10px', fontSize: 9, fontFamily: 'monospace', fontWeight: 700,
                        background: isAdding ? 'rgba(168,85,247,0.25)' : 'rgba(168,85,247,0.12)',
                        color: ACCENT,
                        border: `1px solid ${ACCENT}44`, borderRadius: 3,
                        cursor: adding ? 'default' : 'pointer', flexShrink: 0,
                      }}
                    >
                      {isAdding ? '…' : `+${qty}`}
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Module-level debug subscriber — survives panel remounts
let _debugSubscriber: ((d: WS.DebugData) => void) | null = null;

function setDebugSubscriber(fn: ((d: WS.DebugData) => void) | null): void {
  _debugSubscriber = fn;
  WorldScene.onMouseDebug(fn);
}

/** Standalone debug overlay — mount once at root, always on top. */
export function MouseDebugOverlay(): React.ReactElement | null {
  const [data, setData] = useState<WS.DebugData | null>(null);
  const [active, setActive] = useState(false);

  // Expose a way for DevInventoryPanel toggle to activate this overlay
  useEffect(() => {
    (window as any).__phobosDebugActivate = (on: boolean) => {
      setActive(on);
      setDebugSubscriber(on ? (d) => setData(d) : null);
      if (!on) setData(null);
    };
    (window as any).__phobosSetBlockedOverlay = (on: boolean) => {
      WorldScene.setBlockedOverlay(on);
    };
    (window as any).__phobosNudgeFootprint = (id: string, dTx: number, dTy: number) => {
      WorldScene.nudgePermanentFootprint(id, dTx, dTy);
    };
    (window as any).__phobosNudgeZoneFootprint = (id: string, dTx: number, dTy: number) => {
      WorldScene.nudgeZoneFootprint(id, dTx, dTy);
    };
    return () => {
      delete (window as any).__phobosDebugActivate;
      delete (window as any).__phobosSetBlockedOverlay;
    };
  }, []);

  if (!active || !data) return null;
  return (
    <div style={{
      position: 'fixed', top: 8, left: 8, zIndex: 9999,
      background: 'rgba(0,0,0,0.85)', color: '#ffff00',
      fontFamily: 'monospace', fontSize: 10,
      padding: '6px 10px', borderRadius: 4,
      pointerEvents: 'none', userSelect: 'none',
      lineHeight: 1.7, whiteSpace: 'pre',
      border: '1px solid #ffff0033',
    }}>
      {`screen : ${data.screenX}, ${data.screenY}
world  : ${data.worldX}, ${data.worldY}
tile   : ${data.tileX}, ${data.tileY}
t→scr  : ${data.backX ?? '?'}, ${data.backY ?? '?'}
zoom   : ${data.zoom}
scroll : ${data.scrollX}, ${data.scrollY}
rect   : ${data.camX ?? '?'}, ${data.camY ?? '?'}
cam.xy : ${data.vpX ?? '?'}, ${data.vpY ?? '?'}
shop19 : ${data.shopX ?? '?'}, ${data.shopY ?? '?'}\nblocked: ${data.isBlocked ? '\u25a0 YES' : '\u25a1 no'}\nwalk   : ${data.walkable  ? '\u2713 yes' : '\u2717 NO'}`}
    </div>
  );
}

const smallBtn: React.CSSProperties = {
  width: 22, height: 22, fontSize: 14, fontFamily: 'monospace',
  background: 'rgba(255,255,255,0.04)', border: `1px solid #1e1e1e`,
  borderRadius: 3, cursor: 'pointer', color: '#777',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};