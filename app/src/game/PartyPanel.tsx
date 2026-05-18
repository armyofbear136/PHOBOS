/**
 * PartyPanel — Ally roster with full combat stats and party management.
 * Opened with P. 2-3x scaled up from previous version, with portrait images.
 */

import type { AllyState } from './AllyHUD';
import type { PersonaName } from './GameStore';

const BG       = 'rgba(7,7,10,0.99)';
const BORDER   = '#1a1a22';
const TEXT_DIM = '#3a3a4a';
const TEXT_MED = '#777788';
const TEXT_HI  = '#bbbbcc';
const TEXT_WH  = '#eeeeee';

const ELEMENT_COLOR: Record<string, string> = {
  plasma: '#e879f9',
  ice:    '#67e8f9',
  void:   '#818cf8',
};

interface StaticProfile {
  element: string; maxHp: number; maxSpirit: number;
  meleeDmgMin: number; meleeDmgMax: number;
  rangedDmgMin: number; rangedDmgMax: number;
  attackSpeed: number; accuracy: number; defense: number;
  elementalResist: number; role: string; abilities: string[];
}

const PROFILES: Record<PersonaName, StaticProfile> = {
  sayon: {
    element: 'plasma', maxHp: 110, maxSpirit: 60,
    meleeDmgMin: 8,  meleeDmgMax: 14, rangedDmgMin: 5,  rangedDmgMax: 10,
    attackSpeed: 1.1, accuracy: 0.82, defense: 4, elementalResist: 4,
    role: 'Frontline / Support',
    abilities: ['Coordinate Strike', 'Rally', 'Plasma Net'],
  },
  seren: {
    element: 'ice', maxHp: 75, maxSpirit: 90,
    meleeDmgMin: 4,  meleeDmgMax: 7,  rangedDmgMin: 10, rangedDmgMax: 18,
    attackSpeed: 0.9, accuracy: 0.85, defense: 2, elementalResist: 6,
    role: 'Ranged / Control',
    abilities: ['Void Lance', 'Thought Drain', 'Entropy Cascade'],
  },
  sybil: {
    element: 'void', maxHp: 90, maxSpirit: 70,
    meleeDmgMin: 6,  meleeDmgMax: 11, rangedDmgMin: 7,  rangedDmgMax: 13,
    attackSpeed: 1.2, accuracy: 0.80, defense: 3, elementalResist: 7,
    role: 'Assassin / Crowd Control',
    abilities: ['Ice Shard', 'Archive Bind', 'Catalogue of Pain'],
  },
};

interface PartyPanelProps {
  allies:    Record<string, AllyState>;
  onRelease: (persona: PersonaName) => void;
  onClose:   () => void;
}

function Bar({ value, max, color, h = 7 }: { value: number; max: number; color: string; h?: number }) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  return (
    <div style={{ width: '100%', height: h, background: '#0d0d12', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{
        width: `${pct * 100}%`, height: '100%', background: color,
        borderRadius: 3, transition: 'width 0.25s', boxShadow: `0 0 6px ${color}88`,
      }} />
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '2px 0' }}>
      <span style={{ fontSize: 11, fontFamily: 'monospace', color: TEXT_DIM, letterSpacing: 0.5 }}>{label}</span>
      <span style={{ fontSize: 12, fontFamily: 'monospace', color: TEXT_MED }}>{value}</span>
    </div>
  );
}

function Pill({ label, color }: { label: string; color: string }) {
  return (
    <div style={{
      fontSize: 9, fontFamily: 'monospace', fontWeight: 700, color,
      background: color + '18', border: `1px solid ${color}44`,
      borderRadius: 4, padding: '2px 7px', letterSpacing: 1,
    }}>{label}</div>
  );
}

function AllyCard({ persona, state, onRelease }: { persona: PersonaName; state: AllyState; onRelease: () => void }) {
  const p      = PROFILES[persona];
  const accent = ELEMENT_COLOR[p.element] ?? '#aaa';

  return (
    <div style={{
      background: '#09090e', border: `1px solid ${state.inParty ? accent + 'aa' : BORDER}`,
      borderRadius: 8, display: 'flex', flexDirection: 'column', overflow: 'hidden',
      flex: '1 1 0', minWidth: 0, opacity: state.offline ? 0.38 : 1,
      transition: 'border-color 0.25s, opacity 0.25s',
    }}>

      {/* Portrait */}
      <div style={{ position: 'relative', width: '100%', paddingTop: '75%', overflow: 'hidden', background: '#06060a', borderBottom: `1px solid ${BORDER}` }}>
        <img
          src={`/${persona}.png`}
          alt={persona}
          style={{
            position: 'absolute', top: '-10%', left: '5%', width: '90%', height: '120%',
            objectFit: 'cover', objectPosition: 'center top',
            filter: state.offline
              ? 'grayscale(1) brightness(0.5)'
              : state.inParty
                ? `drop-shadow(0 0 12px ${accent}88)`
                : 'brightness(0.75) saturate(0.6)',
            transition: 'filter 0.3s',
          }}
        />
        <div style={{ position: 'absolute', bottom: 8, left: 8, display: 'flex', gap: 6 }}>
          <Pill label={p.element.toUpperCase()} color={accent} />
          {state.inParty && <Pill label="IN PARTY" color={accent} />}
          {state.offline && <Pill label="OFFLINE"  color="#444" />}
        </div>
        <div style={{
          position: 'absolute', top: 8, right: 8, fontSize: 9, fontFamily: 'monospace',
          color: TEXT_DIM, background: 'rgba(0,0,0,0.65)', padding: '2px 6px', borderRadius: 3,
        }}>
          {state.mode.toUpperCase()}
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>

        {/* Name */}
        <div>
          <div style={{ fontSize: 18, fontFamily: 'monospace', fontWeight: 700, color: TEXT_WH, letterSpacing: 3 }}>
            {persona.toUpperCase()}
          </div>
          <div style={{ fontSize: 10, fontFamily: 'monospace', color: TEXT_DIM, marginTop: 2, letterSpacing: 0.5 }}>
            {p.role}
          </div>
        </div>

        {/* Bars */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 1 }}>
            <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#e55' }}>HP</span>
            <span style={{ fontSize: 10, fontFamily: 'monospace', color: TEXT_DIM }}>{Math.ceil(state.hp)} / {state.maxHp}</span>
          </div>
          <Bar value={state.hp} max={state.maxHp} color="#e55" />
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, marginBottom: 1 }}>
            <span style={{ fontSize: 10, fontFamily: 'monospace', color: accent }}>SPIRIT</span>
            <span style={{ fontSize: 10, fontFamily: 'monospace', color: TEXT_DIM }}>{Math.ceil(state.spirit)} / {p.maxSpirit}</span>
          </div>
          <Bar value={state.spirit} max={p.maxSpirit} color={accent} />
        </div>

        {/* Stats */}
        <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 10 }}>
          <StatRow label="MELEE DMG"   value={`${p.meleeDmgMin} – ${p.meleeDmgMax}`} />
          <StatRow label="RANGED DMG"  value={`${p.rangedDmgMin} – ${p.rangedDmgMax}`} />
          <StatRow label="ATK SPEED"   value={p.attackSpeed.toFixed(1) + 'x'} />
          <StatRow label="ACCURACY"    value={Math.round(p.accuracy * 100) + '%'} />
          <StatRow label="DEFENSE"     value={p.defense} />
          <StatRow label="ELEM RESIST" value={p.elementalResist} />
        </div>

        {/* Abilities */}
        <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 10, flex: 1 }}>
          <div style={{ fontSize: 9, fontFamily: 'monospace', color: TEXT_DIM, letterSpacing: 1, marginBottom: 6 }}>
            ABILITIES
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {p.abilities.map(ab => (
              <div key={ab} style={{
                fontSize: 11, fontFamily: 'monospace', color: TEXT_MED,
                background: '#0f0f16', border: `1px solid ${BORDER}`,
                borderRadius: 4, padding: '4px 8px',
              }}>{ab}</div>
            ))}
          </div>
        </div>

        {/* Release */}
        {state.inParty && !state.offline && (
          <button
            onClick={onRelease}
            style={{
              marginTop: 4, padding: '9px 0', background: 'transparent',
              border: '1px solid #e55a', borderRadius: 5, color: '#e55',
              fontSize: 11, fontFamily: 'monospace', fontWeight: 700,
              letterSpacing: 1.5, cursor: 'pointer', width: '100%', transition: 'background 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = '#e5511a')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            RELEASE
          </button>
        )}
      </div>
    </div>
  );
}

export function PartyPanel({ allies, onRelease, onClose }: PartyPanelProps) {
  const personas: PersonaName[] = ['sayon', 'seren', 'sybil'];
  const partyCount = personas.filter(p => allies[p]?.inParty).length;

  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', alignItems: 'center',
      justifyContent: 'center', zIndex: 1200,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
    }}>
      <div style={{
        background: BG, border: `1px solid ${BORDER}`, borderRadius: 10,
        padding: '22px 24px', width: 'min(1060px, 96vw)', maxHeight: '92vh',
        overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18,
      }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 16, fontFamily: 'monospace', fontWeight: 700, color: TEXT_HI, letterSpacing: 3 }}>
              PARTY
            </div>
            <div style={{ fontSize: 10, fontFamily: 'monospace', color: TEXT_DIM, marginTop: 4, letterSpacing: 0.5 }}>
              {partyCount} / 3 ACTIVE &nbsp;·&nbsp; APPROACH ALLY STATION TO INVITE OR RELEASE
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', border: '1px solid #1e1e28', borderRadius: 5,
              color: TEXT_DIM, fontSize: 14, fontFamily: 'monospace', cursor: 'pointer', padding: '4px 10px',
            }}
          >✕</button>
        </div>

        {/* Cards */}
        <div style={{ display: 'flex', gap: 14, alignItems: 'stretch' }}>
          {personas.map(p => (
            <AllyCard
              key={p}
              persona={p}
              state={allies[p] ?? { hp: 0, maxHp: 100, spirit: 0, offline: true, mode: 'defensive', inParty: false }}
              onRelease={() => onRelease(p)}
            />
          ))}
        </div>

        {/* Footer */}
        <div style={{
          fontSize: 10, fontFamily: 'monospace', color: TEXT_DIM,
          textAlign: 'center', letterSpacing: 0.5,
          borderTop: `1px solid ${BORDER}`, paddingTop: 12,
        }}>
          P — TOGGLE &nbsp;·&nbsp; APPROACH NPC STATION TO INVITE OR RELEASE
        </div>
      </div>
    </div>
  );
}
