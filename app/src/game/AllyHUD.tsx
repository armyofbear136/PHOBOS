/**
 * AllyHUD — Per-persona health bars and engagement mode toggles.
 *
 * Sits in the top-right of the screen in world mode.
 * Each persona shows:
 *   - Portrait icon (coloured circle with initial until we have real portraits)
 *   - Name
 *   - HP bar (coloured to persona theme)
 *   - Current engagement mode: AGGR / DEF / PROT
 *   - Three toggle buttons to switch mode
 *   - Offline indicator for SYBIL
 *
 * Props driven by parent (PhobosGame) which polls the ally state.
 */

import type { EngagementMode } from './AllyAI';
import type { PersonaName } from './GameStore';

// Persona theme colours
// Colors match persona designs:
// SAYON = cyan/teal, SEREN = amber/orange, SYBIL = PHOBOS green (#39ff14-adjacent)
const PERSONA_COLORS: Record<PersonaName, { main: string; bg: string; initial: string }> = {
  sayon: { main: '#22d3ee', bg: 'rgba(34,211,238,0.15)',  initial: 'S' },
  seren: { main: '#f59e0b', bg: 'rgba(245,158,11,0.15)',  initial: 'R' },
  sybil: { main: '#4ade80', bg: 'rgba(74,222,128,0.15)',  initial: 'Y' },
};

const MODE_LABELS: Record<EngagementMode, string> = {
  aggressive: 'AGGR',
  defensive:  'DEF',
  protective: 'PROT',
};

const MODE_COLORS: Record<EngagementMode, string> = {
  aggressive: '#ff6644',
  defensive:  '#44aaff',
  protective: '#44ff88',
};

export interface AllyState {
  hp:      number;
  maxHp:   number;
  spirit:  number;
  offline: boolean;
  mode:    EngagementMode;
  inParty: boolean;
}

export interface AllyHUDProps {
  visible:   boolean;
  allies:    Record<PersonaName, AllyState>;
  onModeChange: (persona: PersonaName, mode: EngagementMode) => void;
}

export function AllyHUD({ visible, allies, onModeChange }: AllyHUDProps) {
  if (!visible) return null;

  const personaOrder: PersonaName[] = ['sayon', 'seren', 'sybil'];

  return (
    <div style={{
      position: 'fixed',
      top: 12,
      right: 12,
      zIndex: 40,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      pointerEvents: 'auto',
      userSelect: 'none',
    }}>
      {personaOrder.map(persona => {
        const ally    = allies[persona];
        const colors  = PERSONA_COLORS[persona];
        const hpPct   = ally.maxHp > 0 ? Math.max(0, ally.hp / ally.maxHp) : 0;
        const hpColor = hpPct > 0.5 ? colors.main : hpPct > 0.25 ? '#ffaa00' : '#ff4444';
        const offline = ally.offline;

        const inParty = ally.inParty;
        return (
          <div
            key={persona}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '5px 8px',
              background: offline ? 'rgba(10,10,10,0.65)' : 'rgba(12,12,12,0.82)',
              border: `1px solid ${offline ? '#222' : inParty ? colors.main + '99' : colors.main + '28'}`,
              borderRadius: 6,
              backdropFilter: 'blur(6px)',
              opacity: offline ? 0.45 : inParty ? 1 : 0.38,
              transition: 'opacity 0.3s, border-color 0.3s',
              minWidth: 190,
            }}
          >
            {/* Portrait icon */}
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: offline ? '#222' : colors.bg,
              border: `2px solid ${offline ? '#333' : colors.main}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700, fontFamily: 'monospace',
              color: offline ? '#444' : colors.main,
              flexShrink: 0,
              boxShadow: offline ? 'none' : `0 0 6px ${colors.main}44`,
            }}>
              {colors.initial}
            </div>

            {/* Name + HP bar */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between',
                alignItems: 'center', marginBottom: 3,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div style={{
                    fontSize: 8, fontFamily: 'monospace', fontWeight: 700,
                    color: offline ? '#444' : colors.main, letterSpacing: 1,
                  }}>
                    {persona.toUpperCase()}
                  </div>
                  {inParty && !offline && (
                    <div style={{
                      fontSize: 6, fontFamily: 'monospace', fontWeight: 700,
                      color: colors.main, background: colors.bg,
                      border: `1px solid ${colors.main}66`,
                      borderRadius: 3, padding: '0 3px', letterSpacing: 0.5,
                    }}>PARTY</div>
                  )}
                </div>
                <div style={{
                  fontSize: 7, fontFamily: 'monospace',
                  color: offline ? '#333' : '#666',
                }}>
                  {offline ? 'OFFLINE' : `${Math.ceil(ally.hp)}/${ally.maxHp}`}
                </div>
              </div>

              {/* HP bar */}
              <div style={{
                height: 4, background: 'rgba(255,255,255,0.07)',
                borderRadius: 2, overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%',
                  width: `${hpPct * 100}%`,
                  background: hpColor,
                  borderRadius: 2,
                  boxShadow: offline ? 'none' : `0 0 4px ${hpColor}88`,
                  transition: 'width 0.2s ease-out, background 0.3s',
                }} />
              </div>
            </div>

            {/* Mode toggle buttons */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
              {(['aggressive', 'defensive', 'protective'] as EngagementMode[]).map(m => {
                const active = ally.mode === m;
                return (
                  <button
                    key={m}
                    disabled={offline}
                    onClick={() => !offline && onModeChange(persona, m)}
                    style={{
                      padding: '1px 5px',
                      fontSize: 7,
                      fontFamily: 'monospace',
                      fontWeight: 700,
                      background: active ? MODE_COLORS[m] + '33' : 'rgba(0,0,0,0.5)',
                      color: active ? MODE_COLORS[m] : offline ? '#333' : '#555',
                      border: `1px solid ${active ? MODE_COLORS[m] + '88' : '#2a2a2a'}`,
                      borderRadius: 3,
                      cursor: offline ? 'default' : 'pointer',
                      transition: 'all 0.15s',
                      letterSpacing: 0.5,
                      lineHeight: '11px',
                    }}
                  >
                    {MODE_LABELS[m]}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
