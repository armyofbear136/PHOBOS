/**
 * MachineMenuPanel — generic interact menu for all placed machines.
 *
 * Shown when the player walks up to any machine and presses interact.
 * Handles three build states:
 *   blueprint / building → supply materials view
 *   built                → machine function stub + manage options
 *
 * Dismantle and Relocate are available in all states.
 */

import { useState, useMemo, useCallback } from 'react';
import {
  MACHINE_BY_ID, buildProgress, progressToState, slotFulfillment, computeContribution,
  type MaterialSlot, type MachineEntry,
} from './HubBuildingCatalog';
import { MATERIAL_BY_ID } from './CraftingMaterials';
import type { GameItem } from './ItemDefinitions';

// ── Types ──────────────────────────────────────────────────────────────────

export interface MachineRecord {
  recordId:          string;
  buildingId:        string;
  state:             'blueprint' | 'building' | 'built';
  config:            string;   // JSON: { slotId: { materialId: qty } }
  last_collected_at: string | null;
}

interface Props {
  record:      MachineRecord;
  inventory:   GameItem[];
  ether:       number;
  engineUrl:   string;
  onClose:     () => void;
  /** Called after supply — parent re-fetches buildings */
  onSupplied:  (recordId: string) => void;
  onDismantled:(recordId: string) => void;
  onRelocate:  (recordId: string, buildingId: string, label: string) => void;
}

// ── Shared style tokens ────────────────────────────────────────────────────

const PANEL_BG  = 'rgba(10,10,10,0.97)';
const BORDER    = '#2a2a2a';
const ACCENT    = '#f59e0b';
const BLUE      = '#60a5fa';
const TEXT_DIM  = '#555';
const TEXT_MED  = '#888';
const TEXT_MAIN = '#ccc';
const RED       = '#ef4444';

// ── Helpers ────────────────────────────────────────────────────────────────

function parseConfig(json: string): Record<string, Record<string, number>> {
  try { return JSON.parse(json) as Record<string, Record<string, number>>; }
  catch { return {}; }
}

/** Count how many of a given materialId the player has in inventory. */
function countInInventory(inventory: GameItem[], materialId: string): number {
  return inventory
    .filter(i => i.type === 'crafting_material' && (i as any).materialId === materialId)
    .reduce((sum, i) => sum + (i.quantity ?? 1), 0);
}

// ── Material Picker ────────────────────────────────────────────────────────
// Shown when player clicks a slot — lists accepted materials, highlights
// owned ones, lets player choose quantity to submit.

function MaterialPicker({
  slot,
  supplied,
  inventory,
  onSubmit,
  onClose,
}: {
  slot:      MaterialSlot;
  supplied:  Record<string, number>;
  inventory: GameItem[];
  onSubmit:  (materialId: string, qty: number) => void;
  onClose:   () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [qty, setQty]           = useState(1);

  const currentFulfilled = slotFulfillment(slot, supplied);
  const remaining        = slot.points - currentFulfilled;

  return (
    <div style={{
      position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 10, borderRadius: 8,
    }}>
      <div style={{
        width: 320, background: PANEL_BG, border: `1px solid ${BORDER}`,
        borderRadius: 8, padding: '14px 16px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontFamily: 'monospace', fontWeight: 700, color: BLUE }}>
            {slot.label.toUpperCase()}
          </div>
          <div style={{ fontSize: 9, fontFamily: 'monospace', color: TEXT_MED }}>
            {currentFulfilled} / {slot.points} pts filled
          </div>
        </div>

        <div style={{ maxHeight: 220, overflowY: 'auto', marginBottom: 10 }}>
          {slot.accepted.map(a => {
            const owned   = countInInventory(inventory, a.materialId);
            const matDef  = MATERIAL_BY_ID.get(a.materialId);
            const name    = matDef?.name ?? a.materialId;
            const contrib = a.contribution;
            const hasIt   = owned > 0;
            const isSelected = selected === a.materialId;

            return (
              <div
                key={a.materialId}
                onClick={() => { if (hasIt) { setSelected(a.materialId); setQty(1); } }}
                style={{
                  padding: '6px 8px', marginBottom: 3, borderRadius: 4,
                  border: `1px solid ${isSelected ? BLUE : (hasIt ? '#334' : BORDER)}`,
                  background: isSelected ? 'rgba(96,165,250,0.1)' : hasIt ? 'rgba(255,255,255,0.03)' : 'transparent',
                  cursor: hasIt ? 'pointer' : 'default',
                  opacity: hasIt ? 1 : 0.35,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}
              >
                <div>
                  <span style={{ fontSize: 10, fontFamily: 'monospace', color: hasIt ? TEXT_MAIN : TEXT_DIM }}>
                    {name}
                  </span>
                  <span style={{ fontSize: 8, fontFamily: 'monospace', color: TEXT_DIM, marginLeft: 6 }}>
                    {contrib}pt / unit · {a.category}
                  </span>
                </div>
                <span style={{ fontSize: 9, fontFamily: 'monospace', color: hasIt ? ACCENT : TEXT_DIM }}>
                  ×{owned}
                </span>
              </div>
            );
          })}
        </div>

        {selected && (() => {
          const a        = slot.accepted.find(x => x.materialId === selected)!;
          const owned    = countInInventory(inventory, selected);
          const maxByOwn = owned;
          // Don't let player submit more than needed to fill the slot
          const maxByNeed = remaining > 0 ? Math.ceil(remaining / a.contribution) : 0;
          const maxQty    = Math.min(maxByOwn, maxByNeed);
          const willFill  = Math.min(qty * a.contribution, remaining);

          return (
            <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 10 }}>
              <div style={{ fontSize: 9, fontFamily: 'monospace', color: TEXT_MED, marginBottom: 6 }}>
                Submit quantity: (max {maxQty})
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                <button onClick={() => setQty(q => Math.max(1, q - 1))}
                  style={{ ...btnSm, color: TEXT_MAIN }}>−</button>
                <span style={{ fontSize: 12, fontFamily: 'monospace', color: TEXT_MAIN, minWidth: 24, textAlign: 'center' }}>
                  {qty}
                </span>
                <button onClick={() => setQty(q => Math.min(maxQty, q + 1))}
                  style={{ ...btnSm, color: TEXT_MAIN }}>+</button>
                <span style={{ fontSize: 9, fontFamily: 'monospace', color: BLUE, marginLeft: 4 }}>
                  +{willFill}pts
                </span>
              </div>
              <button
                disabled={maxQty === 0}
                onClick={() => { onSubmit(selected, qty); onClose(); }}
                style={{
                  width: '100%', padding: '6px', fontSize: 10, fontFamily: 'monospace', fontWeight: 700,
                  background: 'rgba(96,165,250,0.15)', color: BLUE,
                  border: `1px solid ${BLUE}55`, borderRadius: 4, cursor: 'pointer',
                }}
              >
                SUBMIT
              </button>
            </div>
          );
        })()}

        <button onClick={onClose} style={{
          marginTop: 8, width: '100%', padding: '5px', fontSize: 9,
          fontFamily: 'monospace', background: 'none', color: TEXT_DIM,
          border: `1px solid ${BORDER}`, borderRadius: 4, cursor: 'pointer',
        }}>
          CANCEL
        </button>
      </div>
    </div>
  );
}

const btnSm: React.CSSProperties = {
  width: 24, height: 24, fontSize: 14, fontFamily: 'monospace',
  background: 'rgba(255,255,255,0.05)', border: `1px solid ${BORDER}`,
  borderRadius: 3, cursor: 'pointer', color: TEXT_MED,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  flexShrink: 0,
};

// ── Slot progress bar ──────────────────────────────────────────────────────

function SlotRow({
  slot, supplied, onOpenPicker,
}: {
  slot: MaterialSlot;
  supplied: Record<string, number>;
  onOpenPicker: () => void;
}) {
  const filled   = slotFulfillment(slot, supplied);
  const pct      = Math.min(1, filled / slot.points);
  const complete = pct >= 1;

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 9, fontFamily: 'monospace', color: complete ? '#4ade80' : TEXT_MED }}>
          {slot.label}
        </span>
        <span style={{ fontSize: 9, fontFamily: 'monospace', color: complete ? '#4ade80' : TEXT_DIM }}>
          {filled}/{slot.points}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <div style={{ flex: 1, height: 5, background: '#1a1a1a', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 3,
            width: `${pct * 100}%`,
            background: complete ? '#4ade80' : BLUE,
            transition: 'width 0.3s',
          }} />
        </div>
        {!complete && (
          <button onClick={onOpenPicker} style={{
            fontSize: 8, fontFamily: 'monospace', padding: '2px 8px',
            background: 'rgba(96,165,250,0.12)', color: BLUE,
            border: `1px solid ${BLUE}44`, borderRadius: 3, cursor: 'pointer', flexShrink: 0,
          }}>
            ADD
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function MachineMenuPanel({
  record, inventory, engineUrl, onClose, onSupplied, onDismantled, onRelocate,
}: Props) {
  const entry = MACHINE_BY_ID.get(record.buildingId);
  const [config, setConfig]       = useState<Record<string, Record<string, number>>>(
    () => parseConfig(record.config)
  );
  const [pickerSlot, setPickerSlot] = useState<MaterialSlot | null>(null);
  const [saving, setSaving]         = useState(false);
  const [feedback, setFeedback]     = useState<string | null>(null);
  const [confirmDismantle, setConfirmDismantle] = useState(false);

  const progress = useMemo(
    () => entry ? buildProgress(entry, config) : 1,
    [entry, config]
  );
  const visualState = progressToState(progress);

  if (!entry) return null;

  const handleSubmitMaterial = async (slotId: string, materialId: string, qty: number) => {
    const next = {
      ...config,
      [slotId]: { ...(config[slotId] ?? {}), [materialId]: ((config[slotId]?.[materialId] ?? 0) + qty) },
    };
    setConfig(next);

    const newProgress = buildProgress(entry, next);
    const newState    = progressToState(newProgress);
    setSaving(true);
    try {
      const base = engineUrl.replace(/\/$/, '');
      // Remove submitted materials from inventory via backend
      const removeRes = await fetch(`${base}/api/game/inventory/consume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ material_id: materialId, quantity: qty }),
      });
      if (!removeRes.ok) { setFeedback('Inventory error — retry.'); return; }

      await fetch(`${base}/api/game/buildings/${record.recordId}/supply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: next, state: newState }),
      });
      onSupplied(record.recordId);
      if (newState === 'built') setFeedback('Construction complete!');
    } catch {
      setFeedback('Save failed — retry.');
    } finally {
      setSaving(false);
    }
  };

  const handleDismantle = async () => {
    setSaving(true);
    try {
      const base = engineUrl.replace(/\/$/, '');
      await fetch(`${base}/api/game/buildings/${record.recordId}`, { method: 'DELETE' });
      onDismantled(record.recordId);
      onClose();
    } catch {
      setFeedback('Dismantle failed — retry.');
      setSaving(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 110,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(3px)',
    }}>
      <div style={{
        position: 'relative',
        width: 400, maxHeight: '80vh',
        background: PANEL_BG, border: `1px solid ${BORDER}`,
        borderRadius: 8, display: 'flex', flexDirection: 'column',
        boxShadow: '0 8px 40px rgba(0,0,0,0.9)', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '12px 16px', borderBottom: `1px solid ${BORDER}`, flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 700, color: BLUE, letterSpacing: 1 }}>
              {entry.label.toUpperCase()}
            </div>
            <div style={{ fontSize: 8, fontFamily: 'monospace', color: TEXT_DIM, marginTop: 2 }}>
              {entry.subtitle}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              fontSize: 8, fontFamily: 'monospace', padding: '2px 8px',
              borderRadius: 3, border: `1px solid ${visualState === 'built' ? '#4ade8044' : visualState === 'building' ? BLUE + '44' : '#44aaff44'}`,
              color: visualState === 'built' ? '#4ade80' : visualState === 'building' ? BLUE : '#44aaff',
              background: 'rgba(0,0,0,0.3)',
            }}>
              {visualState.toUpperCase()}
            </div>
            <button onClick={onClose} style={{
              background: 'none', border: 'none', color: TEXT_DIM, fontSize: 16, cursor: 'pointer',
            }}>✕</button>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>

          {/* Build progress header */}
          {visualState !== 'built' && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 9, fontFamily: 'monospace', color: TEXT_MED }}>
                  CONSTRUCTION PROGRESS
                </span>
                <span style={{ fontSize: 9, fontFamily: 'monospace', color: TEXT_MAIN }}>
                  {Math.round(progress * 100)}%
                </span>
              </div>
              <div style={{ height: 6, background: '#111', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 3, background: BLUE,
                  width: `${progress * 100}%`, transition: 'width 0.3s',
                }} />
              </div>
            </div>
          )}

          {/* Material slots */}
          {visualState !== 'built' && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 8, color: TEXT_DIM, fontFamily: 'monospace', letterSpacing: 2, marginBottom: 8 }}>
                MATERIAL SLOTS
              </div>
              {entry.slots.map(s => (
                <SlotRow
                  key={s.slotId}
                  slot={s}
                  supplied={config[s.slotId] ?? {}}
                  onOpenPicker={() => setPickerSlot(s)}
                />
              ))}
            </div>
          )}

          {/* Built state — primary function per machine type */}
          {visualState === 'built' && (
            <BuiltFunction
              entry={entry}
              record={record}
              engineUrl={engineUrl}
              onFeedback={setFeedback}
            />
          )}

          {/* Feedback */}
          {feedback && (
            <div style={{
              marginBottom: 10, padding: '5px 10px', fontSize: 9, fontFamily: 'monospace',
              borderRadius: 3,
              background: feedback.includes('complete') ? 'rgba(74,222,128,0.1)' : 'rgba(239,68,68,0.1)',
              color:      feedback.includes('complete') ? '#4ade80'              : RED,
              border: `1px solid ${feedback.includes('complete') ? '#4ade8033' : RED + '33'}`,
            }}>
              {feedback}
            </div>
          )}

          {/* Manage */}
          <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 10 }}>
            <div style={{ fontSize: 8, color: TEXT_DIM, fontFamily: 'monospace', letterSpacing: 2, marginBottom: 8 }}>
              MANAGE
            </div>
            <button
              onClick={() => { onRelocate(record.recordId, record.buildingId, entry.label); onClose(); }}
              style={{ ...manageBtn, color: TEXT_MED, borderColor: BORDER }}
            >
              ⇄ RELOCATE
            </button>
            {!confirmDismantle
              ? (
                <button onClick={() => setConfirmDismantle(true)} style={{ ...manageBtn, color: RED, borderColor: RED + '44' }}>
                  ✕ DISMANTLE
                </button>
              )
              : (
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <span style={{ fontSize: 9, fontFamily: 'monospace', color: RED, alignSelf: 'center' }}>
                    Confirm? Materials lost.
                  </span>
                  <button onClick={handleDismantle} disabled={saving} style={{ ...manageBtn, color: RED, borderColor: RED + '66', flex: 1 }}>
                    CONFIRM
                  </button>
                  <button onClick={() => setConfirmDismantle(false)} style={{ ...manageBtn, color: TEXT_DIM, borderColor: BORDER }}>
                    CANCEL
                  </button>
                </div>
              )
            }
          </div>
        </div>

        {/* Material picker overlay */}
        {pickerSlot && (
          <MaterialPicker
            slot={pickerSlot}
            supplied={config[pickerSlot.slotId] ?? {}}
            inventory={inventory}
            onSubmit={(matId, qty) => handleSubmitMaterial(pickerSlot.slotId, matId, qty)}
            onClose={() => setPickerSlot(null)}
          />
        )}

        {saving && (
          <div style={{
            position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, fontFamily: 'monospace', color: TEXT_MED, borderRadius: 8,
          }}>
            SAVING…
          </div>
        )}
      </div>
    </div>
  );
}

const manageBtn: React.CSSProperties = {
  display: 'block', width: '100%', padding: '6px 10px',
  fontSize: 9, fontFamily: 'monospace', fontWeight: 700,
  background: 'rgba(255,255,255,0.03)', border: '1px solid',
  borderRadius: 4, cursor: 'pointer', textAlign: 'left',
  marginBottom: 6, letterSpacing: 1,
};

// ── BuiltFunction — per-machine operational UI ────────────────────────────────

interface BuiltFunctionProps {
  entry:      import('./HubBuildingCatalog').MachineEntry | undefined;
  record:     MachineRecord;
  engineUrl:  string;
  onFeedback: (msg: string | null) => void;
}

/**
 * Renders the primary function UI for a built machine.
 * menuType drives which function block is shown:
 *
 *   'rcs'      — Resonant Cavitation Shell: collect generated materials
 *   'fab_shop' — Frictionless Fab: nothing to collect; links to shop
 *   'generic'  — All other machines: status display + function description
 *
 * Generic machines show their subtitle as the function description plus an
 * ACTIVE status indicator. Machines whose function is a future unlock
 * (TST → space flight, SFG → XP zone) show a clear "Pending prerequisite"
 * note so the player knows what they're building toward.
 */
function BuiltFunction({ entry, record, engineUrl, onFeedback }: BuiltFunctionProps) {
  const [collecting, setCollecting] = useState(false);
  const [collected,  setCollected]  = useState<{ qty: number; name: string } | null>(null);

  const collectRcs = useCallback(async () => {
    if (collecting) return;
    setCollecting(true);
    onFeedback(null);
    try {
      const base = engineUrl.replace(/\/$/, '');
      const resp = await fetch(`${base}/api/game/buildings/${record.recordId}/collect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ material_id: 'rcs_output' }),
      });
      const data = await resp.json();
      if (data.units > 0) {
        setCollected({ qty: data.units, name: data.material_id ?? 'material' });
        onFeedback(`Collected ${data.units}× ${data.material_id ?? 'material'}`);
      } else {
        onFeedback('Nothing ready to collect yet.');
      }
    } catch {
      onFeedback('Collection failed.');
    } finally {
      setCollecting(false);
    }
  }, [collecting, engineUrl, record.recordId, onFeedback]);

  if (!entry) return null;

  // ── RCS: material collection ──────────────────────────────────────────────
  if (entry.menuType === 'rcs') {
    return (
      <div style={{
        padding: '12px', borderRadius: 6, marginBottom: 14,
        background: 'rgba(74,222,128,0.05)', border: '1px solid #4ade8022',
      }}>
        <div style={{ fontSize: 9, fontFamily: 'monospace', color: '#4ade80', marginBottom: 6, letterSpacing: 1 }}>
          ◈ NUCLEATION ACTIVE
        </div>
        <div style={{ fontSize: 8, fontFamily: 'monospace', color: TEXT_DIM, marginBottom: 10, lineHeight: 1.6 }}>
          Generating materials from Zero-Point Field. Collect periodically.
          {collected && (
            <span style={{ color: '#4ade80', marginLeft: 8 }}>
              Last: {collected.qty}× {collected.name}
            </span>
          )}
        </div>
        <button
          onClick={collectRcs}
          disabled={collecting}
          style={{
            width: '100%', padding: '7px 0', fontFamily: 'monospace', fontSize: 9,
            fontWeight: 700, letterSpacing: 1, borderRadius: 4, cursor: collecting ? 'not-allowed' : 'pointer',
            background: collecting ? 'rgba(255,255,255,0.02)' : 'rgba(74,222,128,0.12)',
            border: `1px solid ${collecting ? BORDER : '#4ade8055'}`,
            color: collecting ? TEXT_DIM : '#4ade80',
          }}
        >
          {collecting ? 'COLLECTING…' : '⬇ COLLECT OUTPUT'}
        </button>
      </div>
    );
  }

  // ── Fab Shop: no collect needed ───────────────────────────────────────────
  if (entry.menuType === 'fab_shop') {
    return (
      <div style={{
        padding: '12px', borderRadius: 6, marginBottom: 14,
        background: 'rgba(74,222,128,0.05)', border: '1px solid #4ade8022',
      }}>
        <div style={{ fontSize: 9, fontFamily: 'monospace', color: '#4ade80', marginBottom: 4, letterSpacing: 1 }}>
          ◈ FABRICATION ONLINE
        </div>
        <div style={{ fontSize: 8, fontFamily: 'monospace', color: TEXT_DIM, lineHeight: 1.6 }}>
          Advanced machines are now purchasable from the Plaza shop.
          Interact with the shop to browse unlocked machine blueprints.
        </div>
      </div>
    );
  }

  // ── Generic: operational status + function description ───────────────────
  // Machines with a future-gated function get a clear pending note.
  const PENDING_MACHINES: Record<string, string> = {
    'machine-tst': 'Density Bridge pending: requires Space Gateway activation.',
    'machine-sfg': 'Passive XP zone pending: zone generation system in progress.',
    'machine-fcs': 'Portable Flux Capacitor not yet implemented.',
    'machine-zpr': 'Passive power supply pending: energy grid system in progress.',
  };

  const pendingNote = PENDING_MACHINES[entry.id];

  return (
    <div style={{
      padding: '12px', borderRadius: 6, marginBottom: 14,
      background: 'rgba(74,222,128,0.05)', border: '1px solid #4ade8022',
    }}>
      <div style={{ fontSize: 9, fontFamily: 'monospace', color: '#4ade80', marginBottom: 4, letterSpacing: 1 }}>
        ◈ OPERATIONAL
      </div>
      <div style={{ fontSize: 8, fontFamily: 'monospace', color: TEXT_MED, marginBottom: pendingNote ? 6 : 0, lineHeight: 1.6 }}>
        {entry.subtitle}
      </div>
      {pendingNote && (
        <div style={{ fontSize: 8, fontFamily: 'monospace', color: ACCENT, lineHeight: 1.6, marginTop: 4 }}>
          ⚠ {pendingNote}
        </div>
      )}
    </div>
  );
}
