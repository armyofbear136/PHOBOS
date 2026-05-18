/**
 * EtherBankPanel — Player House ether vault.
 *
 * Opened when the player interacts with the HOUSE building.
 * Two pools: HELD (on-person, lost on death) and BANKED (safe, never lost).
 * Deposit moves held → banked. Withdraw moves banked → held.
 *
 * Backend: GET/POST /api/game/ether/bank
 */

import { useEffect, useRef, useState } from 'react';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// ── Palette (matches ShopPanel) ────────────────────────────────────────────
const PANEL_BG  = 'rgba(10,10,10,0.97)';
const BORDER    = '#2a2a2a';
const ACCENT    = '#a78bfa';   // violet — distinct from shop amber
const TEXT_DIM  = '#555';
const TEXT_MED  = '#999';
const TEXT_MAIN = '#ddd';
const ETHER_CLR = '#c4b5fd';

// ── Types ──────────────────────────────────────────────────────────────────
interface EtherBankPanelProps {
  onClose: () => void;
}

// ── Component ──────────────────────────────────────────────────────────────
export function EtherBankPanel({ onClose }: EtherBankPanelProps) {
  const [held,    setHeld]    = useState(0);
  const [banked,  setBanked]  = useState(0);
  const [input,   setInput]   = useState('');
  const [busy,    setBusy]    = useState(false);
  const [flash,   setFlash]   = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load current balances on mount
  useEffect(() => {
    fetch(`${ENGINE_URL}/api/game/ether/bank`)
      .then(r => r.json())
      .then(d => {
        setHeld(d.ether_held   ?? 0);
        setBanked(d.ether_banked ?? 0);
      })
      .catch(() => {});
    inputRef.current?.focus();
  }, []);

  function showFlash(msg: string): void {
    setFlash(msg);
    setTimeout(() => setFlash(null), 1800);
  }

  async function transact(action: 'deposit' | 'withdraw'): Promise<void> {
    const amount = parseInt(input, 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      showFlash('Enter a valid amount');
      return;
    }
    const max = action === 'deposit' ? held : banked;
    if (amount > max) {
      showFlash(`Not enough ◆ to ${action}`);
      return;
    }
    setBusy(true);
    try {
      const resp = await fetch(`${ENGINE_URL}/api/game/ether/bank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, amount }),
      });
      const data = await resp.json();
      setHeld(data.ether_held   ?? 0);
      setBanked(data.ether_banked ?? 0);
      setInput('');
      showFlash(action === 'deposit' ? `Deposited ◆${amount}` : `Withdrew ◆${amount}`);
    } catch {
      showFlash('Transaction failed');
    } finally {
      setBusy(false);
    }
  }

  function setMax(source: 'held' | 'banked'): void {
    setInput(String(source === 'held' ? held : banked));
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 200,
        background: 'rgba(0,0,0,0.55)',
      }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: PANEL_BG,
        border: `1px solid ${BORDER}`,
        borderRadius: 10,
        width: 340,
        fontFamily: 'monospace',
        color: TEXT_MAIN,
        boxShadow: `0 0 40px rgba(167,139,250,0.15)`,
        overflow: 'hidden',
      }}>

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: `1px solid ${BORDER}`,
          background: 'rgba(167,139,250,0.06)',
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: ACCENT, letterSpacing: 1 }}>
              ◈ ETHER VAULT
            </div>
            <div style={{ fontSize: 9, color: TEXT_DIM, marginTop: 2, letterSpacing: 1 }}>
              PLAYER HOUSE · BANK TERMINAL
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', color: TEXT_DIM,
              fontSize: 18, cursor: 'pointer', lineHeight: 1, padding: '0 2px',
            }}
          >×</button>
        </div>

        {/* Balance display */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr',
          gap: 1, borderBottom: `1px solid ${BORDER}`,
        }}>
          <BalanceCell label="HELD" value={held} sub="at risk on death" accent={false} />
          <BalanceCell label="BANKED" value={banked} sub="safe · never lost" accent={true} />
        </div>

        {/* Transaction area */}
        <div style={{ padding: '16px' }}>
          <div style={{ fontSize: 9, color: TEXT_DIM, letterSpacing: 1, marginBottom: 8 }}>
            AMOUNT
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            <input
              ref={inputRef}
              type="number"
              min={1}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') transact('deposit'); }}
              placeholder="0"
              style={{
                flex: 1,
                background: 'rgba(255,255,255,0.04)',
                border: `1px solid ${BORDER}`,
                borderRadius: 4,
                color: ETHER_CLR,
                fontFamily: 'monospace',
                fontSize: 14,
                padding: '7px 10px',
                outline: 'none',
              }}
            />
            <MaxButton label="MAX ↓" onClick={() => setMax('held')}   title="Set to held amount"   />
            <MaxButton label="MAX ↑" onClick={() => setMax('banked')} title="Set to banked amount" />
          </div>

          {/* Action buttons */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <ActionButton
              label="DEPOSIT ↓"
              sub="held → banked"
              color="#7c3aed"
              hoverColor={ACCENT}
              disabled={busy || held === 0}
              onClick={() => transact('deposit')}
            />
            <ActionButton
              label="WITHDRAW ↑"
              sub="banked → held"
              color="#4338ca"
              hoverColor="#818cf8"
              disabled={busy || banked === 0}
              onClick={() => transact('withdraw')}
            />
          </div>

          {/* Flash message */}
          <div style={{
            height: 20,
            marginTop: 10,
            textAlign: 'center',
            fontSize: 10,
            color: flash ? ETHER_CLR : 'transparent',
            transition: 'color 0.2s',
            letterSpacing: 1,
          }}>
            {flash ?? '·'}
          </div>

          {/* Death warning */}
          <div style={{
            marginTop: 4,
            padding: '7px 10px',
            background: 'rgba(239,68,68,0.06)',
            border: '1px solid rgba(239,68,68,0.15)',
            borderRadius: 4,
            fontSize: 9,
            color: '#f87171',
            lineHeight: 1.6,
            letterSpacing: 0.5,
          }}>
            ⚠ HELD ether is at risk. On death, 10–30% drops at your location as a pickup.
            BANKED ether is always safe.
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function BalanceCell({
  label, value, sub, accent,
}: {
  label: string; value: number; sub: string; accent: boolean;
}) {
  return (
    <div style={{
      padding: '14px 16px',
      background: accent ? 'rgba(167,139,250,0.05)' : 'transparent',
      borderRight: accent ? 'none' : `1px solid ${BORDER}`,
    }}>
      <div style={{ fontSize: 9, color: TEXT_DIM, letterSpacing: 1, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{
        fontSize: 22, fontWeight: 700,
        color: accent ? ETHER_CLR : TEXT_MED,
        letterSpacing: -0.5,
      }}>
        ◆{value.toLocaleString()}
      </div>
      <div style={{ fontSize: 8, color: TEXT_DIM, marginTop: 4, letterSpacing: 0.5 }}>
        {sub}
      </div>
    </div>
  );
}

function MaxButton({
  label, onClick, title,
}: {
  label: string; onClick: () => void; title: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: `1px solid ${BORDER}`,
        borderRadius: 4,
        color: TEXT_DIM,
        fontFamily: 'monospace',
        fontSize: 9,
        padding: '0 8px',
        cursor: 'pointer',
        letterSpacing: 0.5,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

function ActionButton({
  label, sub, color, hoverColor, disabled, onClick,
}: {
  label: string; sub: string; color: string; hoverColor: string;
  disabled: boolean; onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: disabled ? 'rgba(255,255,255,0.02)' : (hover ? hoverColor : color),
        border: `1px solid ${disabled ? BORDER : (hover ? hoverColor : color)}`,
        borderRadius: 5,
        color: disabled ? TEXT_DIM : (hover ? '#000' : '#fff'),
        fontFamily: 'monospace',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 1,
        padding: '9px 6px 7px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'all 0.12s',
        textAlign: 'center',
        lineHeight: 1.4,
      }}
    >
      <div>{label}</div>
      <div style={{ fontSize: 8, fontWeight: 400, opacity: 0.7, marginTop: 2 }}>{sub}</div>
    </button>
  );
}
