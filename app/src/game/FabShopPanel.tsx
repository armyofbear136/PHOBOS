/**
 * FabShopPanel — The Frictionless Fab's own shop panel.
 *
 * Opened by walking up to the player's placed Frictionless Fab (once built)
 * and pressing interact. Sells deeds for all advanced machines.
 *
 * Gating:
 *   - Each deed is locked until its unlockReq machine is 'built'.
 *   - Affordability check against current ether balance.
 *   - Purchasing a deed triggers BuildingPlacementOverlay.begin().
 *
 * Note: This panel does NOT persist a "deed item" to inventory.
 * Buying immediately enters placement mode — the deed is consumed on place.
 * This matches the design intent (deeds are not tradeable items).
 */

import { useMemo } from 'react';
import { MACHINE_CATALOG, isMachineUnlocked, type MachineEntry } from './HubBuildingCatalog';
import { BuildingPlacementOverlay } from './BuildingPlacementOverlay';

// ── Types ──────────────────────────────────────────────────────────────────

interface Props {
  ether:        number;
  builtIds:     Set<string>;   // building_ids with state === 'built'
  placedIds:    Set<string>;   // building_ids already placed (any state) — prevent duplicates
  onClose:      () => void;
  onSpendEther: (amount: number) => void;
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

// ── Deed card ──────────────────────────────────────────────────────────────

function DeedCard({
  entry, ether, unlocked, alreadyPlaced, onBuy,
}: {
  entry:         MachineEntry;
  ether:         number;
  unlocked:      boolean;
  alreadyPlaced: boolean;
  onBuy:         () => void;
}) {
  const affordable = ether >= entry.etherCost;
  const canBuy     = unlocked && affordable && !alreadyPlaced;

  let statusColor = TEXT_DIM;
  let statusText  = '';
  if (alreadyPlaced) { statusText = 'PLACED'; statusColor = GREEN; }
  else if (!unlocked) { statusText = `REQUIRES: ${entry.unlockReq?.replace('machine-', '').toUpperCase() ?? ''}`;  statusColor = '#7c6f00'; }
  else if (!affordable) { statusText = 'INSUFFICIENT ETHER'; statusColor = '#ef4444'; }

  return (
    <div style={{
      padding: '10px 12px', marginBottom: 6, borderRadius: 5,
      background: canBuy ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.2)',
      border: `1px solid ${alreadyPlaced ? GREEN + '33' : unlocked ? BORDER : '#1a1a1a'}`,
      opacity: unlocked || alreadyPlaced ? 1 : 0.55,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, fontFamily: 'monospace', fontWeight: 700, color: unlocked ? TEXT_MAIN : TEXT_DIM }}>
            {entry.label}
          </div>
          <div style={{ fontSize: 8, fontFamily: 'monospace', color: TEXT_DIM, marginTop: 2, lineHeight: 1.4 }}>
            {entry.subtitle}
          </div>
          {/* Slot summary */}
          <div style={{ fontSize: 7, fontFamily: 'monospace', color: TEXT_DIM, marginTop: 4 }}>
            {entry.slots.map(s => `${s.label} (${s.points}pt)`).join(' · ')}
          </div>
          {statusText && (
            <div style={{ fontSize: 7, fontFamily: 'monospace', color: statusColor, marginTop: 4, letterSpacing: 1 }}>
              {statusText}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0, marginLeft: 12 }}>
          <div style={{
            fontSize: 11, fontFamily: 'monospace', fontWeight: 700,
            color: affordable ? ACCENT : '#ef4444',
          }}>
            ◆{entry.etherCost}
          </div>
          <button
            onClick={onBuy}
            disabled={!canBuy}
            style={{
              padding: '4px 12px', fontSize: 9, fontFamily: 'monospace', fontWeight: 700,
              background: canBuy ? 'rgba(96,165,250,0.15)' : 'rgba(30,30,30,0.5)',
              color: canBuy ? BLUE : TEXT_DIM,
              border: `1px solid ${canBuy ? BLUE + '55' : '#1a1a1a'}`,
              borderRadius: 3, cursor: canBuy ? 'pointer' : 'default',
              letterSpacing: 1,
            }}
          >
            {alreadyPlaced ? 'OWNED' : 'BUY DEED'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function FabShopPanel({ ether, builtIds, placedIds, onClose, onSpendEther }: Props) {
  const fabEntries = useMemo(
    () => MACHINE_CATALOG.filter(m => m.vendor === 'fab_shop'),
    []
  );

  const handleBuy = (entry: MachineEntry) => {
    onClose();
    BuildingPlacementOverlay.begin(
      entry.id,
      entry.label,
      () => onSpendEther(entry.etherCost),
    );
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 110,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(3px)',
    }}>
      <div style={{
        width: 480, maxHeight: '80vh',
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
            <div style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 700, color: BLUE, letterSpacing: 2 }}>
              ◈ FRICTIONLESS FAB
            </div>
            <div style={{ fontSize: 8, fontFamily: 'monospace', color: TEXT_DIM, marginTop: 2 }}>
              Advanced machine deeds — purchase to enter placement mode
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              fontSize: 12, fontFamily: 'monospace', fontWeight: 700,
              color: ACCENT, background: 'rgba(245,158,11,0.1)',
              border: `1px solid ${ACCENT}44`, borderRadius: 4, padding: '3px 10px',
            }}>
              ◆ {ether}
            </div>
            <button onClick={onClose} style={{
              background: 'none', border: 'none', color: TEXT_DIM, fontSize: 16, cursor: 'pointer',
            }}>✕</button>
          </div>
        </div>

        {/* Deed list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
          <div style={{ fontSize: 8, color: TEXT_DIM, fontFamily: 'monospace', letterSpacing: 2, marginBottom: 10 }}>
            MACHINES
          </div>
          {fabEntries.map(entry => (
            <DeedCard
              key={entry.id}
              entry={entry}
              ether={ether}
              unlocked={isMachineUnlocked(entry.id, builtIds)}
              alreadyPlaced={placedIds.has(entry.id)}
              onBuy={() => handleBuy(entry)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
