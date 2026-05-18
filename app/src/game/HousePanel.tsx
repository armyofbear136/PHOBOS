/**
 * HousePanel — Player House interface.
 *
 * Two tabs:
 *   ETHER VAULT   — deposit / withdraw ether (held ↔ banked)
 *   STORAGE       — 24-slot item stash (player inventory ↔ house storage)
 *
 * Currency: ether only. No Phobos coins in this panel.
 *
 * Backend:
 *   GET  /api/game/ether/bank                  — { ether_held, ether_banked }
 *   POST /api/game/ether/bank                  — { action, amount } → { ether_held, ether_banked }
 *   GET  /api/game/inventory?target=player     — GameInventoryItem[]
 *   GET  /api/game/inventory?target=house      — GameInventoryItem[]
 *   POST /api/game/house/storage/deposit       — { id } → { ok }
 *   POST /api/game/house/storage/withdraw      — { id } → { ok }
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { RARITIES, POTIONS, EQUIP_SLOT_NAMES, type GameItem, type RarityTier, type EquipSlot } from './ItemDefinitions';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

// ── Palette (matches EtherBankPanel / ShopPanel) ───────────────────────────
const PANEL_BG  = 'rgba(10,10,10,0.97)';
const BORDER    = '#2a2a2a';
const ACCENT    = '#a78bfa';
const TEXT_DIM  = '#555';
const TEXT_MED  = '#999';
const TEXT_MAIN = '#ddd';
const ETHER_CLR = '#c4b5fd';
const FONT      = 'monospace';

// ── Storage constants ──────────────────────────────────────────────────────
const STORAGE_SLOTS = 24;

// ── Types ──────────────────────────────────────────────────────────────────
interface HousePanelProps {
  onClose: () => void;
}

type Tab = 'vault' | 'storage';

// Raw DB row shape returned by GET /api/game/inventory
interface RawInventoryRow {
  id:       string;
  data:     string;
  equipped: boolean;
}

function parseRows(rows: RawInventoryRow[]): GameItem[] {
  return rows.flatMap(row => {
    try {
      const item = JSON.parse(row.data) as GameItem;
      item.id      = row.id;
      item.equipped = row.equipped;
      return [item];
    } catch { return []; }
  });
}

// ── Root component ─────────────────────────────────────────────────────────
export function HousePanel({ onClose }: HousePanelProps) {
  const [tab, setTab] = useState<Tab>('vault');

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
        width: 400,
        fontFamily: FONT,
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
              ⌂ PLAYER HOUSE
            </div>
            <div style={{ fontSize: 9, color: TEXT_DIM, marginTop: 2, letterSpacing: 1 }}>
              STORAGE · ETHER VAULT
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

        {/* Tabs */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr',
          borderBottom: `1px solid ${BORDER}`,
        }}>
          {(['vault', 'storage'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                background: tab === t ? 'rgba(167,139,250,0.10)' : 'transparent',
                border: 'none',
                borderBottom: tab === t ? `2px solid ${ACCENT}` : '2px solid transparent',
                color: tab === t ? ACCENT : TEXT_DIM,
                fontFamily: FONT,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 1.5,
                padding: '10px 0',
                cursor: 'pointer',
                transition: 'all 0.12s',
              }}
            >
              {t === 'vault' ? '◈ ETHER VAULT' : '⊞ STORAGE'}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {tab === 'vault'   && <EtherVaultTab />}
        {tab === 'storage' && <StorageTab />}
      </div>
    </div>
  );
}

// ── Ether Vault tab (full EtherBankPanel logic, inlined) ───────────────────
function EtherVaultTab() {
  const [held,   setHeld]   = useState(0);
  const [banked, setBanked] = useState(0);
  const [input,  setInput]  = useState('');
  const [busy,   setBusy]   = useState(false);
  const [flash,  setFlash]  = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
    if (!Number.isFinite(amount) || amount <= 0) { showFlash('Enter a valid amount'); return; }
    const max = action === 'deposit' ? held : banked;
    if (amount > max) { showFlash(`Not enough ◆ to ${action}`); return; }
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
    } catch { showFlash('Transaction failed'); }
    finally { setBusy(false); }
  }

  return (
    <div>
      {/* Balance display */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr',
        gap: 1, borderBottom: `1px solid ${BORDER}`,
      }}>
        <BalanceCell label="HELD"   value={held}   sub="at risk on death"  accent={false} />
        <BalanceCell label="BANKED" value={banked} sub="safe · never lost" accent={true}  />
      </div>

      {/* Transaction area */}
      <div style={{ padding: '16px' }}>
        <div style={{ fontSize: 9, color: TEXT_DIM, letterSpacing: 1, marginBottom: 8 }}>AMOUNT</div>
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
              fontFamily: FONT,
              fontSize: 14,
              padding: '7px 10px',
              outline: 'none',
            }}
          />
          <MaxButton label="MAX ↓" onClick={() => setInput(String(held))}   title="Set to held amount"   />
          <MaxButton label="MAX ↑" onClick={() => setInput(String(banked))} title="Set to banked amount" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <ActionButton
            label="DEPOSIT ↓" sub="held → banked"
            color="#7c3aed" hoverColor={ACCENT}
            disabled={busy || held === 0}
            onClick={() => transact('deposit')}
          />
          <ActionButton
            label="WITHDRAW ↑" sub="banked → held"
            color="#4338ca" hoverColor="#818cf8"
            disabled={busy || banked === 0}
            onClick={() => transact('withdraw')}
          />
        </div>

        <div style={{
          height: 20, marginTop: 10,
          textAlign: 'center', fontSize: 10,
          color: flash ? ETHER_CLR : 'transparent',
          transition: 'color 0.2s', letterSpacing: 1,
        }}>
          {flash ?? '·'}
        </div>

        <div style={{
          marginTop: 4, padding: '7px 10px',
          background: 'rgba(239,68,68,0.06)',
          border: '1px solid rgba(239,68,68,0.15)',
          borderRadius: 4, fontSize: 9,
          color: '#f87171', lineHeight: 1.6, letterSpacing: 0.5,
        }}>
          ⚠ HELD ether is at risk. On death, 10–30% drops at your location as a pickup.
          BANKED ether is always safe.
        </div>
      </div>
    </div>
  );
}

// ── Storage tab ────────────────────────────────────────────────────────────
function StorageTab() {
  const [playerItems,  setPlayerItems]  = useState<GameItem[]>([]);
  const [houseItems,   setHouseItems]   = useState<GameItem[]>([]);
  const [selected,     setSelected]     = useState<{ item: GameItem; source: 'player' | 'house' } | null>(null);
  const [busy,         setBusy]         = useState(false);
  const [flash,        setFlash]        = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    try {
      const [pResp, hResp] = await Promise.all([
        fetch(`${ENGINE_URL}/api/game/inventory?target=player`),
        fetch(`${ENGINE_URL}/api/game/inventory?target=house`),
      ]);
      const pRows: RawInventoryRow[] = await pResp.json();
      const hRows: RawInventoryRow[] = await hResp.json();
      setPlayerItems(parseRows(pRows).filter(i => !i.equipped));
      setHouseItems(parseRows(hRows));
    } catch { /* silent */ }
  }, []);

  useEffect(() => { loadItems(); }, [loadItems]);

  function showFlash(msg: string): void {
    setFlash(msg);
    setTimeout(() => setFlash(null), 1800);
  }

  async function deposit(item: GameItem): Promise<void> {
    if (houseItems.length >= STORAGE_SLOTS) { showFlash('Storage full'); return; }
    setBusy(true);
    try {
      const resp = await fetch(`${ENGINE_URL}/api/game/house/storage/deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      });
      if (!resp.ok) { showFlash('Deposit failed'); return; }
      setSelected(null);
      await loadItems();
      showFlash(`Stored: ${item.name}`);
    } catch { showFlash('Deposit failed'); }
    finally { setBusy(false); }
  }

  async function withdraw(item: GameItem): Promise<void> {
    setBusy(true);
    try {
      const resp = await fetch(`${ENGINE_URL}/api/game/house/storage/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      });
      if (!resp.ok) { showFlash('Withdraw failed'); return; }
      setSelected(null);
      await loadItems();
      showFlash(`Retrieved: ${item.name}`);
    } catch { showFlash('Withdraw failed'); }
    finally { setBusy(false); }
  }

  const storageUsed = houseItems.length;

  return (
    <div style={{ padding: '14px 16px 16px' }}>

      {/* Section: storage stash */}
      <SectionHeader
        label="HOUSE STORAGE"
        right={`${storageUsed} / ${STORAGE_SLOTS}`}
        rightColor={storageUsed >= STORAGE_SLOTS ? '#f87171' : TEXT_DIM}
      />
      <ItemGrid
        items={houseItems}
        totalSlots={STORAGE_SLOTS}
        selected={selected?.source === 'house' ? selected.item : null}
        onSelect={item => setSelected(s =>
          s?.item.id === item.id && s.source === 'house' ? null : { item, source: 'house' }
        )}
      />

      {/* Action strip for selected house item */}
      {selected?.source === 'house' && (
        <SelectedBar
          item={selected.item}
          actionLabel="RETRIEVE →"
          actionColor="#4338ca"
          actionHover="#818cf8"
          disabled={busy}
          onAction={() => withdraw(selected.item)}
          onDeselect={() => setSelected(null)}
        />
      )}

      <div style={{ height: 1, background: BORDER, margin: '14px 0' }} />

      {/* Section: player inventory (unequipped only) */}
      <SectionHeader label="INVENTORY" right="unequipped only" rightColor={TEXT_DIM} />
      <ItemGrid
        items={playerItems}
        totalSlots={Math.max(playerItems.length, 12)}
        selected={selected?.source === 'player' ? selected.item : null}
        onSelect={item => setSelected(s =>
          s?.item.id === item.id && s.source === 'player' ? null : { item, source: 'player' }
        )}
      />

      {/* Action strip for selected player item */}
      {selected?.source === 'player' && (
        <SelectedBar
          item={selected.item}
          actionLabel="← STORE"
          actionColor="#7c3aed"
          actionHover={ACCENT}
          disabled={busy || storageUsed >= STORAGE_SLOTS}
          onAction={() => deposit(selected.item)}
          onDeselect={() => setSelected(null)}
        />
      )}

      {/* Flash */}
      <div style={{
        height: 18, marginTop: 10,
        textAlign: 'center', fontSize: 10,
        color: flash ? ETHER_CLR : 'transparent',
        transition: 'color 0.2s', letterSpacing: 1,
      }}>
        {flash ?? '·'}
      </div>
    </div>
  );
}

// ── ItemGrid ───────────────────────────────────────────────────────────────
function ItemGrid({
  items, totalSlots, selected, onSelect,
}: {
  items: GameItem[];
  totalSlots: number;
  selected: GameItem | null;
  onSelect: (item: GameItem) => void;
}) {
  const slots = Array.from({ length: totalSlots }, (_, i) => items[i] ?? null);

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(8, 1fr)',
      gap: 4,
      marginBottom: 6,
    }}>
      {slots.map((item, i) => {
        const isSelected = item !== null && selected?.id === item.id;
        const rarity = item ? (RARITIES[Number(item.rarity) as RarityTier] ?? RARITIES[0]) : null;
        return (
          <div
            key={i}
            onClick={() => { if (item) onSelect(item); }}
            title={item ? `${item.name}${item.slot ? ` · ${EQUIP_SLOT_NAMES[item.slot]}` : ''}` : undefined}
            style={{
              width: '100%',
              aspectRatio: '1',
              background: item
                ? (isSelected ? 'rgba(167,139,250,0.22)' : 'rgba(255,255,255,0.04)')
                : 'rgba(255,255,255,0.02)',
              border: `1px solid ${isSelected ? ACCENT : (item ? '#383838' : BORDER)}`,
              borderRadius: 4,
              cursor: item ? 'pointer' : 'default',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'border-color 0.1s, background 0.1s',
              boxSizing: 'border-box',
              boxShadow: isSelected ? `0 0 6px rgba(167,139,250,0.4)` : 'none',
            }}
          >
            {item && rarity && (
              <SlotItemIcon item={item} rarityColor={rarity.color} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── SlotItemIcon — compact icon for grid cells ─────────────────────────────
const ELEMENT_COLORS: Record<string, string> = {
  plasma: '#c084fc', fire: '#f97316', ice: '#60a5fa',
  lightning: '#facc15', void: '#818cf8', nature: '#4ade80',
};

const SLOT_ICONS: Partial<Record<EquipSlot, string>> = {
  helm: '⬡', body: '◈', legs: '↓', melee: '⚔',
  ranged: '◎', abilityCrystal: '✦', leftRing: '○', rightRing: '○',
};

function SlotItemIcon({ item, rarityColor }: { item: GameItem; rarityColor: string }) {
  const size = 28;

  if (item.type === 'potion') {
    const def = POTIONS[item.id as keyof typeof POTIONS];
    const c   = def?.color ?? '#888';
    return (
      <div style={{ width: size * 0.42, height: size * 0.65, background: c, borderRadius: '30% 30% 5% 5%', border: '1px solid rgba(255,255,255,0.2)', boxShadow: `0 0 4px ${c}88` }} />
    );
  }

  if (item.slot === 'abilityCrystal') {
    const c = item.abilityCrystal?.element ? ELEMENT_COLORS[item.abilityCrystal.element] ?? '#8b5cf6' : '#8b5cf6';
    return (
      <div style={{ width: size * 0.6, height: size * 0.6, background: `linear-gradient(135deg, ${c}88, ${c})`, clipPath: 'polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)', boxShadow: `0 0 6px ${c}66` }} />
    );
  }

  if (item.slot === 'leftRing' || item.slot === 'rightRing') {
    const c = item.ring?.element ? ELEMENT_COLORS[item.ring.element] ?? rarityColor : rarityColor;
    return (
      <div style={{ width: size * 0.65, height: size * 0.65, borderRadius: '50%', border: `2px solid ${c}`, boxShadow: `0 0 4px ${c}44` }} />
    );
  }

  return (
    <span style={{ fontSize: size * 0.55, color: rarityColor, lineHeight: 1 }}>
      {item.slot ? (SLOT_ICONS[item.slot] ?? '◈') : '◈'}
    </span>
  );
}

// ── SelectedBar — action strip shown below whichever grid has a selection ──
function SelectedBar({
  item, actionLabel, actionColor, actionHover, disabled, onAction, onDeselect,
}: {
  item: GameItem;
  actionLabel: string;
  actionColor: string;
  actionHover: string;
  disabled: boolean;
  onAction: () => void;
  onDeselect: () => void;
}) {
  const rarity = RARITIES[Number(item.rarity) as RarityTier] ?? RARITIES[0];
  const [hover, setHover] = useState(false);

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 10px',
      background: 'rgba(167,139,250,0.06)',
      border: `1px solid #333`,
      borderRadius: 5,
      marginTop: 4,
    }}>
      {/* Icon */}
      <div style={{
        width: 32, height: 32, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(255,255,255,0.04)', border: `1px solid #383838`, borderRadius: 4,
      }}>
        <SlotItemIcon item={item} rarityColor={rarity.color} />
      </div>

      {/* Name + type */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: rarity.color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {item.name}
        </div>
        <div style={{ fontSize: 9, color: TEXT_DIM, marginTop: 1, letterSpacing: 0.5 }}>
          {item.slot ? EQUIP_SLOT_NAMES[item.slot] : item.type}
          {item.element ? ` · ${item.element}` : ''}
        </div>
      </div>

      {/* Action */}
      <button
        onClick={onAction}
        disabled={disabled}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          flexShrink: 0,
          background: disabled ? 'rgba(255,255,255,0.02)' : (hover ? actionHover : actionColor),
          border: `1px solid ${disabled ? BORDER : (hover ? actionHover : actionColor)}`,
          borderRadius: 4,
          color: disabled ? TEXT_DIM : (hover ? '#000' : '#fff'),
          fontFamily: FONT,
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: 1,
          padding: '5px 10px',
          cursor: disabled ? 'not-allowed' : 'pointer',
          transition: 'all 0.12s',
          whiteSpace: 'nowrap',
        }}
      >
        {actionLabel}
      </button>

      {/* Deselect */}
      <button
        onClick={onDeselect}
        style={{
          flexShrink: 0,
          background: 'none', border: 'none',
          color: TEXT_DIM, fontSize: 14,
          cursor: 'pointer', lineHeight: 1, padding: '0 2px',
        }}
      >×</button>
    </div>
  );
}

// ── Shared sub-components ──────────────────────────────────────────────────

function SectionHeader({ label, right, rightColor }: { label: string; right: string; rightColor: string }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      marginBottom: 8,
    }}>
      <span style={{ fontSize: 9, color: TEXT_DIM, letterSpacing: 1.5 }}>{label}</span>
      <span style={{ fontSize: 9, color: rightColor, letterSpacing: 0.5 }}>{right}</span>
    </div>
  );
}

function BalanceCell({ label, value, sub, accent }: { label: string; value: number; sub: string; accent: boolean }) {
  return (
    <div style={{
      padding: '14px 16px',
      background: accent ? 'rgba(167,139,250,0.05)' : 'transparent',
      borderRight: accent ? 'none' : `1px solid ${BORDER}`,
    }}>
      <div style={{ fontSize: 9, color: TEXT_DIM, letterSpacing: 1, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent ? ETHER_CLR : TEXT_MED, letterSpacing: -0.5 }}>
        ◆{value.toLocaleString()}
      </div>
      <div style={{ fontSize: 8, color: TEXT_DIM, marginTop: 4, letterSpacing: 0.5 }}>{sub}</div>
    </div>
  );
}

function MaxButton({ label, onClick, title }: { label: string; onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: `1px solid ${BORDER}`,
        borderRadius: 4,
        color: TEXT_DIM,
        fontFamily: FONT,
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
        fontFamily: FONT,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 1,
        padding: '9px 6px 7px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'all 0.12s',
        textAlign: 'center' as const,
        lineHeight: 1.4,
      }}
    >
      <div>{label}</div>
      <div style={{ fontSize: 8, fontWeight: 400, opacity: 0.7, marginTop: 2 }}>{sub}</div>
    </button>
  );
}
