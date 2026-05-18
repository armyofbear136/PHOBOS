/**
 * GameHUD — Bottom-of-screen HUD for world combat mode.
 *
 * Layout (bottom of screen, above toolbar):
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │  [HP ORB]  [XP BAR / ABILITIES 1 2 3 + AURA]  [SP ORB]  │
 *   └──────────────────────────────────────────────────────┘
 *
 * HP Orb   — left, red, pulsing fill effect
 * SP Orb   — right, blue/indigo, pulsing fill
 * XP bar   — thin bar above the 4 ability slots
 * Ability slots — 1 2 3 (active abilities) + AURA slot (passive)
 *   Each slot shows:
 *     - Icon background (element-tinted)
 *     - Keybind label (1, 2, 3, passv)
 *     - Ability name (short)
 *     - Cooldown overlay: dark fill sweeping from top, number countdown
 *     - Spirit cost indicator
 * Combat mode indicator — M/R badge next to HP orb
 *
 * The component receives all state as props. No internal timers —
 * parent (PhobosGame) drives updates via useRef callbacks registered
 * on the WorldScene's PlayerCombatController.
 */

import { useEffect, useRef, useState } from 'react';
import type { PlayerBuild, AbilityData } from './PlayerClasses';
import { CLASS_DEFINITIONS, derivedStats } from './PlayerClasses';
import type { CombatMode } from './PlayerCombatController';

// ── Element palette ────────────────────────────────────────────────────────

const ELEMENT_COLORS: Record<string, { main: string; glow: string }> = {
  plasma:    { main: '#c080ff', glow: 'rgba(192,128,255,0.35)' },
  fire:      { main: '#ff6020', glow: 'rgba(255,96,32,0.35)'  },
  ice:       { main: '#60d0ff', glow: 'rgba(96,208,255,0.35)' },
  lightning: { main: '#ffe040', glow: 'rgba(255,224,64,0.35)' },
  void:      { main: '#8040c0', glow: 'rgba(128,64,192,0.35)' },
};

// ── Props ──────────────────────────────────────────────────────────────────

export interface GameHUDProps {
  visible:         boolean;
  build:           PlayerBuild;
  hp:              number;
  maxHp:           number;
  spirit:          number;
  maxSpirit:       number;
  xp:              number;
  xpToNext:        number;
  level:           number;
  abilityCooldowns: [number, number, number];
  combatMode:      CombatMode;
  chargeProgress:  number;   // 0–1
  isReady:         boolean;  // RMB held
}

// ── Sub-components ─────────────────────────────────────────────────────────

function Orb({
  value, max, color, glowColor, label,
}: {
  value: number; max: number;
  color: string; glowColor: string;
  label: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const displayVal = Math.ceil(value);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      {/* Orb circle */}
      <div style={{
        position: 'relative',
        width: 52,
        height: 52,
        borderRadius: '50%',
        background: 'rgba(0,0,0,0.75)',
        border: `2px solid ${color}`,
        boxShadow: `0 0 10px ${glowColor}, inset 0 0 8px rgba(0,0,0,0.5)`,
        overflow: 'hidden',
      }}>
        {/* Fill from bottom */}
        <div style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: `${pct * 100}%`,
          background: `linear-gradient(to top, ${color}cc, ${color}44)`,
          transition: 'height 0.15s ease-out',
        }} />
        {/* Value text */}
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 10,
          fontFamily: 'monospace',
          fontWeight: 700,
          color: '#fff',
          textShadow: '0 1px 2px #000',
          zIndex: 1,
        }}>
          {displayVal}
        </div>
      </div>
      <div style={{ fontSize: 8, fontFamily: 'monospace', color, letterSpacing: 1 }}>
        {label}
      </div>
    </div>
  );
}

function AbilitySlot({
  index, ability, cooldown, keyLabel, elementColor, spiritCurrent,
}: {
  index: number;
  ability: AbilityData;
  cooldown: number;
  keyLabel: string;
  elementColor: string;
  spiritCurrent: number;
}) {
  const cdPct   = ability.cooldown > 0 ? Math.min(1, cooldown / ability.cooldown) : 0;
  const onCD    = cooldown > 0;
  const noSpirit = spiritCurrent < ability.spiritCost;
  const blocked = onCD || noSpirit;

  return (
    <div
      title={`${ability.name} — ${ability.description}\nSpirit: ${ability.spiritCost}  CD: ${ability.cooldown}s`}
      style={{
        position: 'relative',
        width: 52,
        height: 56,
        borderRadius: 4,
        background: blocked ? 'rgba(0,0,0,0.75)' : 'rgba(20,20,20,0.88)',
        border: `1.5px solid ${blocked ? '#333' : elementColor}`,
        boxShadow: blocked ? 'none' : `0 0 6px ${elementColor}55`,
        overflow: 'hidden',
        cursor: 'default',
        transition: 'border-color 0.2s',
        flexShrink: 0,
      }}
    >
      {/* Cooldown sweep overlay */}
      {onCD && (
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: `${cdPct * 100}%`,
          background: 'rgba(0,0,0,0.65)',
          transition: 'height 0.1s linear',
          zIndex: 2,
        }} />
      )}

      {/* Content */}
      <div style={{
        position: 'relative',
        zIndex: 3,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '3px 2px',
      }}>
        {/* Key badge */}
        <div style={{
          fontSize: 7,
          fontFamily: 'monospace',
          fontWeight: 700,
          color: blocked ? '#555' : elementColor,
          background: 'rgba(0,0,0,0.6)',
          borderRadius: 2,
          padding: '0 3px',
          lineHeight: '12px',
        }}>
          {keyLabel}
        </div>

        {/* Ability name */}
        <div style={{
          fontSize: 6,
          fontFamily: 'monospace',
          color: blocked ? '#444' : '#ddd',
          textAlign: 'center',
          lineHeight: 1.2,
          wordBreak: 'break-word',
          maxWidth: 48,
        }}>
          {ability.name}
        </div>

        {/* Spirit cost */}
        <div style={{
          fontSize: 6,
          fontFamily: 'monospace',
          color: noSpirit ? '#ff4444' : '#6080ff',
        }}>
          {ability.spiritCost}sp
        </div>
      </div>

      {/* Cooldown timer text */}
      {onCD && (
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 14,
          fontFamily: 'monospace',
          fontWeight: 700,
          color: '#fff',
          textShadow: '0 0 4px #000',
          zIndex: 4,
          pointerEvents: 'none',
        }}>
          {cooldown.toFixed(1)}
        </div>
      )}
    </div>
  );
}

function AuraSlot() {
  return (
    <div style={{
      width: 52,
      height: 56,
      borderRadius: 4,
      background: 'rgba(10,10,10,0.7)',
      border: '1.5px dashed #333',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 2,
      flexShrink: 0,
    }}>
      <div style={{ fontSize: 14, opacity: 0.25 }}>◈</div>
      <div style={{ fontSize: 6, fontFamily: 'monospace', color: '#333', letterSpacing: 1 }}>
        AURA
      </div>
    </div>
  );
}

// ── Main HUD ───────────────────────────────────────────────────────────────

export function GameHUD({
  visible, build, hp, maxHp, spirit, maxSpirit,
  xp, xpToNext, level, abilityCooldowns, combatMode,
  chargeProgress, isReady,
}: GameHUDProps) {
  if (!visible) return null;

  const cls      = CLASS_DEFINITIONS[build.class];
  const element  = build.element;
  const elColor  = ELEMENT_COLORS[element] ?? ELEMENT_COLORS.plasma;
  const xpPct    = xpToNext > 0 ? Math.min(1, xp / xpToNext) : 0;

  const modeColor = combatMode === 'melee' ? '#ff9944' : '#44aaff';
  const modeLabel = combatMode === 'melee' ? 'MELEE' : 'RANGED';

  return (
    <div style={{
      position: 'fixed',
      bottom: 56,   // sits above the toolbar
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 40,
      pointerEvents: 'none',
      userSelect: 'none',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 10,
        padding: '6px 12px',
        background: 'rgba(8,8,8,0.82)',
        border: '1px solid #1a1a1a',
        borderRadius: 8,
        backdropFilter: 'blur(6px)',
        boxShadow: '0 -4px 16px rgba(0,0,0,0.5)',
      }}>

        {/* ── Left: HP orb + mode badge ──────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
          <Orb value={hp} max={maxHp} color="#ee4444" glowColor="rgba(238,68,68,0.35)" label="HP" />
          <div style={{
            padding: '2px 6px',
            fontSize: 7,
            fontFamily: 'monospace',
            fontWeight: 700,
            color: modeColor,
            background: 'rgba(0,0,0,0.7)',
            border: `1px solid ${modeColor}55`,
            borderRadius: 3,
            letterSpacing: 1,
          }}>
            {isReady ? (chargeProgress > 0 ? `CHG ${Math.round(chargeProgress*100)}%` : 'READY') : modeLabel}
          </div>
        </div>

        {/* ── Center: XP bar + abilities ─────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>

          {/* XP bar + level */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{
              fontSize: 7, fontFamily: 'monospace', color: '#f59e0b', minWidth: 28,
            }}>
              Lv{level}
            </div>
            <div style={{
              flex: 1,
              width: 228,
              height: 4,
              background: 'rgba(255,255,255,0.08)',
              borderRadius: 2,
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                width: `${xpPct * 100}%`,
                background: 'linear-gradient(to right, #f59e0b, #fbbf24)',
                borderRadius: 2,
                transition: 'width 0.4s ease-out',
                boxShadow: '0 0 4px #f59e0b88',
              }} />
            </div>
            <div style={{
              fontSize: 6, fontFamily: 'monospace', color: '#666', minWidth: 40, textAlign: 'right',
            }}>
              {xp}/{xpToNext}
            </div>
          </div>

          {/* Ability slots */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end' }}>
            {cls.abilities.map((ab, i) => (
              <AbilitySlot
                key={i}
                index={i}
                ability={ab}
                cooldown={abilityCooldowns[i]}
                keyLabel={String(i + 1)}
                elementColor={elColor.main}
                spiritCurrent={spirit}
              />
            ))}
            <AuraSlot />
          </div>
        </div>

        {/* ── Right: Spirit orb ──────────────────────────────────────── */}
        <Orb
          value={spirit}
          max={maxSpirit}
          color="#6366f1"
          glowColor="rgba(99,102,241,0.35)"
          label="SP"
        />
      </div>
    </div>
  );
}

// ── Hook for HUD state driven by PlayerCombatController ───────────────────

export interface HUDState {
  hp:               number;
  maxHp:            number;
  spirit:           number;
  maxSpirit:        number;
  abilityCooldowns: [number, number, number];
  combatMode:       CombatMode;
  chargeProgress:   number;
  isReady:          boolean;
}

export function useHUDState(initial: {
  maxHp: number; maxSpirit: number;
}): [HUDState, React.MutableRefObject<((state: Partial<HUDState>) => void) | null>] {
  // const { useState, useRef } = require('react');

  const [state, setState] = useState<HUDState>({
    hp:               initial.maxHp,
    maxHp:            initial.maxHp,
    spirit:           initial.maxSpirit,
    maxSpirit:        initial.maxSpirit,
    abilityCooldowns: [0, 0, 0],
    combatMode:       'melee',
    chargeProgress:   0,
    isReady:          false,
  });

  // Callback ref for Phaser to call without React closure stale issues
  const updater = useRef<((s: Partial<HUDState>) => void) | null>(null);
  updater.current = (patch) => setState((prev: HUDState) => ({ ...prev, ...patch }));

  return [state, updater];
}
