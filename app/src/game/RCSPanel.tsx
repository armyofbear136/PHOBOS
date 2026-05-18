/**
 * RCSPanel — Resonant Cavitation Shell interaction panel.
 *
 * If machine is not yet built, defers to MachineMenuPanel (supply materials).
 * Once built:
 *   - Element picker dropdown (what material to generate)
 *   - Central icon showing selected element + accumulated units
 *   - Collect button — harvests all accumulated output and adds to inventory
 *
 * Accumulation: 1 unit per 10 minutes, max 144 units (24 hours).
 * Calculation is client-side using last_collected_at timestamp; server
 * confirms the actual amount on collect.
 *
 * Element selection is saved to building config as { element: materialId }.
 */

import { useState, useEffect } from 'react';
import { rcsAccumulatedUnits, buildProgress, progressToState } from './HubBuildingCatalog';
import { MATERIAL_BY_ID, ALL_MATERIALS } from './CraftingMaterials';
import type { MachineRecord } from './MachineMenuPanel';

// ── Types ──────────────────────────────────────────────────────────────────

interface Props {
  record:      MachineRecord;
  engineUrl:   string;
  onClose:     () => void;
  onCollected: (materialId: string, units: number) => void;
  onConfigSaved: (recordId: string) => void;
}

// ── Style tokens ───────────────────────────────────────────────────────────

const PANEL_BG  = 'rgba(10,10,10,0.97)';
const BORDER    = '#2a2a2a';
const ACCENT    = '#f59e0b';
const BLUE      = '#60a5fa';
const TEXT_DIM  = '#555';
const TEXT_MED  = '#888';
const TEXT_MAIN = '#ccc';
const GREEN     = '#4ade80';

// ── RCS-eligible materials ─────────────────────────────────────────────────
// All tier-1 craftable materials. Player unlocks higher tiers naturally via
// the material system — RCS generates whatever the player configures.

const RCS_MATERIALS = ALL_MATERIALS.filter(m => m.tier === 1);

// ── Helpers ────────────────────────────────────────────────────────────────

function parseConfig(json: string): Record<string, unknown> {
  try { return JSON.parse(json) as Record<string, unknown>; }
  catch { return {}; }
}

// ── Component ──────────────────────────────────────────────────────────────

export function RCSPanel({ record, engineUrl, onClose, onCollected, onConfigSaved }: Props) {
  const config   = parseConfig(record.config);

  // Derive build state from catalog
  // If not built, panel just shows construction state (handled by caller,
  // but we guard here for safety)
  const [selectedMat, setSelectedMat] = useState<string>(
    typeof config.element === 'string' ? config.element : (RCS_MATERIALS[0]?.id ?? '')
  );
  const [units, setUnits]         = useState(0);
  const [collecting, setCollecting] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [feedback, setFeedback]   = useState<string | null>(null);

  // Recompute accumulated units once on open, then every 30s
  useEffect(() => {
    const compute = () => {
      setUnits(rcsAccumulatedUnits(record.last_collected_at, record.state === 'built' ? record.last_collected_at ?? new Date(0).toISOString() : new Date(0).toISOString()));
    };
    compute();
    const id = setInterval(compute, 30_000);
    return () => clearInterval(id);
  }, [record.last_collected_at]);

  const handleSaveElement = async (matId: string) => {
    setSelectedMat(matId);
    const base = engineUrl.replace(/\/$/, '');
    setSavingConfig(true);
    try {
      const next = { ...config, element: matId };
      await fetch(`${base}/api/game/buildings/${record.recordId}/supply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: next, state: record.state }),
      });
      onConfigSaved(record.recordId);
    } catch {
      setFeedback('Failed to save — retry.');
    } finally {
      setSavingConfig(false);
    }
  };

  const handleCollect = async () => {
    if (units === 0 || collecting) return;
    const base = engineUrl.replace(/\/$/, '');
    setCollecting(true);
    try {
      const res = await fetch(`${base}/api/game/buildings/${record.recordId}/collect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ material_id: selectedMat }),
      });
      const data = await res.json() as { units: number; material_id: string };
      onCollected(data.material_id, data.units);
      setUnits(0);
      setFeedback(`Collected ${data.units}× ${MATERIAL_BY_ID.get(data.material_id)?.name ?? data.material_id}`);
      setTimeout(() => setFeedback(null), 3000);
    } catch {
      setFeedback('Collection failed — retry.');
    } finally {
      setCollecting(false);
    }
  };

  const selectedMatDef = MATERIAL_BY_ID.get(selectedMat);
  const pctFull        = Math.min(1, units / 144);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 110,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(3px)',
    }}>
      <div style={{
        width: 340, background: PANEL_BG, border: `1px solid ${BORDER}`,
        borderRadius: 8, overflow: 'hidden',
        boxShadow: '0 8px 40px rgba(0,0,0,0.9)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '12px 16px', borderBottom: `1px solid ${BORDER}`,
        }}>
          <div>
            <div style={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 700, color: BLUE, letterSpacing: 1 }}>
              RESONANT CAVITATION SHELL
            </div>
            <div style={{ fontSize: 8, fontFamily: 'monospace', color: TEXT_DIM, marginTop: 2 }}>
              Nucleates matter from the Zero-Point Field
            </div>
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: TEXT_DIM, fontSize: 16, cursor: 'pointer',
          }}>✕</button>
        </div>

        {/* Body */}
        <div style={{ padding: '16px' }}>

          {/* Central accumulation display */}
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            padding: '20px 0 16px', marginBottom: 16,
            background: 'rgba(96,165,250,0.04)',
            border: `1px solid ${BLUE}22`, borderRadius: 8,
          }}>
            {/* Material icon — colour swatch + name */}
            <div style={{
              width: 56, height: 56, borderRadius: '50%', marginBottom: 10,
              background: selectedMatDef?.tint != null
                ? `#${(selectedMatDef.tint as number).toString(16).padStart(6, '0')}`
                : '#334',
              border: `3px solid ${BLUE}44`,
              boxShadow: `0 0 18px ${BLUE}33`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <span style={{ fontSize: 9, fontFamily: 'monospace', color: '#fff', textAlign: 'center', fontWeight: 700 }}>
                {selectedMatDef?.name.substring(0, 3).toUpperCase() ?? '???'}
              </span>
            </div>

            <div style={{ fontSize: 22, fontFamily: 'monospace', fontWeight: 700, color: TEXT_MAIN }}>
              {units}
            </div>
            <div style={{ fontSize: 8, fontFamily: 'monospace', color: TEXT_DIM, marginTop: 2 }}>
              units accumulated
            </div>

            {/* Fill bar */}
            <div style={{ width: 160, height: 4, background: '#111', borderRadius: 2, marginTop: 10, overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: 2, background: pctFull >= 1 ? ACCENT : BLUE,
                width: `${pctFull * 100}%`, transition: 'width 0.5s',
              }} />
            </div>
            <div style={{ fontSize: 7, fontFamily: 'monospace', color: TEXT_DIM, marginTop: 3 }}>
              {units}/144 capacity · 1 unit / 10 min
            </div>
          </div>

          {/* Element picker */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 8, fontFamily: 'monospace', color: TEXT_DIM, letterSpacing: 2, marginBottom: 6 }}>
              ELEMENT
            </div>
            <select
              value={selectedMat}
              disabled={savingConfig}
              onChange={e => handleSaveElement(e.target.value)}
              style={{
                width: '100%', padding: '6px 10px',
                fontSize: 10, fontFamily: 'monospace',
                background: '#111', color: TEXT_MAIN,
                border: `1px solid ${BORDER}`, borderRadius: 4, cursor: 'pointer',
              }}
            >
              {RCS_MATERIALS.map(m => (
                <option key={m.id} value={m.id}>{m.name} ({m.category})</option>
              ))}
            </select>
            {savingConfig && (
              <div style={{ fontSize: 8, fontFamily: 'monospace', color: TEXT_DIM, marginTop: 3 }}>
                Saving…
              </div>
            )}
          </div>

          {/* Collect button */}
          <button
            onClick={handleCollect}
            disabled={units === 0 || collecting}
            style={{
              width: '100%', padding: '10px',
              fontSize: 11, fontFamily: 'monospace', fontWeight: 700,
              background: units > 0 ? 'rgba(74,222,128,0.12)' : 'rgba(30,30,30,0.5)',
              color: units > 0 ? GREEN : TEXT_DIM,
              border: `1px solid ${units > 0 ? GREEN + '55' : BORDER}`,
              borderRadius: 5, cursor: units > 0 ? 'pointer' : 'default',
              transition: 'all 0.15s', letterSpacing: 1,
            }}
          >
            {collecting ? 'COLLECTING…' : `COLLECT ${units > 0 ? `(${units})` : ''}`}
          </button>

          {feedback && (
            <div style={{
              marginTop: 8, padding: '5px 10px', fontSize: 9, fontFamily: 'monospace',
              borderRadius: 3, textAlign: 'center',
              background: feedback.includes('fail') ? 'rgba(239,68,68,0.1)' : 'rgba(74,222,128,0.1)',
              color:      feedback.includes('fail') ? '#ef4444'             : GREEN,
              border: `1px solid ${feedback.includes('fail') ? '#ef444433' : GREEN + '33'}`,
            }}>
              {feedback}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
