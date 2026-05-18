/**
 * KeybindPanel — Keybind display and remapping UI.
 *
 * Shown inside the performance/settings menu in PhobosGame.
 * Uses KeybindManager.getInstance() directly — no prop drilling.
 *
 * UX: click an action row to enter "listening" mode, press any key
 * to assign it. Escape cancels. Conflicts show a warning.
 */

import { useState, useEffect, useCallback } from 'react';
import { KeybindManager, ACTION_LABELS, type GameAction } from './KeybindManager';
import type * as Phaser from 'phaser';

interface Props {
  /** Pass the Phaser game ref so we can call kb.remap() which re-registers keys */
  gameRef: React.RefObject<Phaser.Game | null>;
}

export function KeybindPanel({ gameRef: _gameRef }: Props) {
  const kb = KeybindManager.getInstance();
  const [binds, setBinds] = useState<Record<GameAction, number>>(() => kb.getAllBinds());
  const [listening, setListening] = useState<GameAction | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  // Global keydown listener when in "listening" mode
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!listening) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      setListening(null);
      setConflict(null);
      return;
    }

    // Map browser key to Phaser KeyCode
    const code = e.keyCode || e.which;
    if (!code) return;

    // Check conflict
    const existing = Object.entries(binds).find(([a, v]) => v === code && a !== listening);
    if (existing) {
      setConflict(`Conflicts with "${ACTION_LABELS[existing[0] as GameAction]}"`);
    } else {
      setConflict(null);
    }

    kb.remap(listening, code);
    setBinds(kb.getAllBinds());
    setListening(null);
  }, [listening, binds, kb]);

  useEffect(() => {
    if (listening) {
      window.addEventListener('keydown', handleKeyDown, { capture: true });
      return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
    }
  }, [listening, handleKeyDown]);

  const groupedActions: [string, GameAction[]][] = [
    ['Movement', ['move_up','move_down','move_left','move_right']],
    ['Combat',   ['melee_mode','ranged_mode','roll','jump','interact']],
    ['Abilities',['ability_1','ability_2','ability_3']],
    ['UI',       ['inventory','world_toggle']],
  ];

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 8,
      }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#f59e0b', letterSpacing: 1 }}>
          KEYBINDS
        </div>
        <button
          onClick={() => {
            kb.resetToDefaults();
            setBinds(kb.getAllBinds());
            setConflict(null);
          }}
          style={{
            padding: '2px 7px', fontSize: 8, fontFamily: 'monospace',
            background: '#1a1a1a', color: '#666',
            border: '1px solid #333', borderRadius: 3, cursor: 'pointer',
          }}
        >
          Reset
        </button>
      </div>

      {conflict && (
        <div style={{
          marginBottom: 6, padding: '3px 6px', fontSize: 8,
          background: 'rgba(255,68,68,0.12)', border: '1px solid #ff444455',
          borderRadius: 3, color: '#ff8888', fontFamily: 'monospace',
        }}>
          ⚠ {conflict}
        </div>
      )}

      {listening && (
        <div style={{
          marginBottom: 6, padding: '4px 8px', fontSize: 9,
          background: 'rgba(245,158,11,0.12)', border: '1px solid #f59e0b55',
          borderRadius: 3, color: '#f59e0b', fontFamily: 'monospace',
          textAlign: 'center', letterSpacing: 1,
        }}>
          Press any key… (Esc to cancel)
        </div>
      )}

      {groupedActions.map(([group, actions]) => (
        <div key={group} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 7, color: '#444', fontFamily: 'monospace', letterSpacing: 2, marginBottom: 3 }}>
            {group.toUpperCase()}
          </div>
          {actions.map(action => {
            const isListening = listening === action;
            return (
              <div
                key={action}
                onClick={() => { setListening(action); setConflict(null); }}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '3px 4px', borderRadius: 3, cursor: 'pointer', marginBottom: 1,
                  background: isListening ? 'rgba(245,158,11,0.15)' : 'transparent',
                  border: `1px solid ${isListening ? '#f59e0b55' : 'transparent'}`,
                  transition: 'background 0.1s',
                }}
              >
                <div style={{ fontSize: 8, fontFamily: 'monospace', color: '#999' }}>
                  {ACTION_LABELS[action]}
                </div>
                <div style={{
                  fontSize: 8, fontFamily: 'monospace', fontWeight: 700,
                  color: isListening ? '#f59e0b' : '#ccc',
                  background: 'rgba(255,255,255,0.06)',
                  border: `1px solid ${isListening ? '#f59e0b' : '#333'}`,
                  borderRadius: 3, padding: '1px 5px', minWidth: 28, textAlign: 'center',
                }}>
                  {isListening ? '…' : kb.getKeyName(action)}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
