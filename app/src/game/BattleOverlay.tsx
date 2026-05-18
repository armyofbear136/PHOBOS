/**
 * BattleOverlay — DOM-based combat UI overlay for PHOBOS World.
 *
 * Renders on top of the Phaser canvas. Shows:
 *   - Enemy HP bars (top)
 *   - Player HP/Spirit bars (bottom)
 *   - Turn indicator
 *   - Action buttons (melee, ranged, abilities)
 *   - Combat log (last 4 results)
 *   - Victory/defeat screen
 *
 * Pure React — no Phaser dependency. CombatState drives all data.
 */

import { useState, useCallback, useRef } from 'react';
import {
  CombatState,
  BATTLE_WAVES,
  type CombatAction,
  type ActionResult,
  type WavePreset,
} from './CombatState';
import {
  CLASS_DEFINITIONS,
  type PlayerBuild,
  type ElementType,
} from './PlayerClasses';
import { RARITIES, POTIONS, type GameItem, type RarityTier } from './ItemDefinitions';
import type { StatusEffect, StatusType } from './CombatState';

// ── Element label colors ────────────────────────────────────────────────
const ELEM_HEX: Record<ElementType, string> = {
  plasma: '#e0e0e0',
  fire: '#f59e0b',
  ice: '#3b82f6',
  lightning: '#8b5cf6',
  void: '#6366f1',
};

// ── Status effect display ────────────────────────────────────────────────────

const STATUS_META: Record<StatusType, { label: string; color: string; icon: string }> = {
  burn:     { label: 'BURN',    color: '#f97316', icon: '🔥' },
  freeze:   { label: 'FREEZE',  color: '#60a5fa', icon: '❄' },
  stun:     { label: 'STUN',    color: '#facc15', icon: '⚡' },
  slow:     { label: 'SLOW',    color: '#94a3b8', icon: '⏱' },
  entropy:  { label: 'ENTROPY', color: '#a855f7', icon: '☠' },
  exposure: { label: 'EXPOSE',  color: '#e0e0e0', icon: '◎' },
};

function StatusBadges({ statuses }: { statuses: StatusEffect[] }) {
  if (!statuses.length) return null;
  return (
    <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 3 }}>
      {statuses.map((s, i) => {
        const meta = STATUS_META[s.type];
        return (
          <span key={i} style={{
            fontSize: 8, padding: '1px 4px', borderRadius: 3,
            background: meta.color + '33',
            border: `1px solid ${meta.color}66`,
            color: meta.color,
            fontFamily: 'monospace',
            whiteSpace: 'nowrap',
          }}>
            {meta.icon} {meta.label}
            {s.remaining > 1 && <span style={{ opacity: 0.7 }}> {s.remaining}t</span>}
            {s.magnitude > 1 && s.type !== 'stun' && (
              <span style={{ opacity: 0.7 }}> ×{s.magnitude}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

interface Props {
  playerBuild: PlayerBuild;
  potions: { healing: number; spirit: number };
  onExit: (xpEarned: number, coinsEarned: number, droppedItems: GameItem[]) => void;
  onPotionUsed: (type: 'healing_potion' | 'spirit_potion') => void;
}

export function BattleOverlay({ playerBuild, potions, onExit, onPotionUsed }: Props) {
  const combatRef = useRef(new CombatState());
  const [phase, setPhase] = useState(combatRef.current.phase);
  const [, forceUpdate] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [selectedWave, setSelectedWave] = useState<WavePreset | null>(null);

  const combat = combatRef.current;

  const refresh = useCallback(() => {
    setPhase(combat.phase);
    forceUpdate(n => n + 1);
  }, [combat]);

  // Run all consecutive enemy turns
  const runEnemyTurns = useCallback(() => {
    let safetyCount = 0;
    const maxIter = (combat.enemies.length + 1) * 6; // enough for full round + statuses
    while ((combat.phase as string) === 'enemy_turn' && safetyCount < maxIter) {
      // Guard: if no living enemies, force to victory
      if (combat.enemies.every(e => e.dead)) {
        (combat as any).phase = 'victory';
        break;
      }
      const action = combat.pickEnemyAction();
      const result = combat.resolveAction(action);
      const msg = formatResult(result, combat);
      setLog(prev => [...prev.slice(-3), msg]);
      safetyCount++;
    }
    // Final guard: stuck enemy_turn with no valid actors → player turn
    if ((combat.phase as string) === 'enemy_turn' && safetyCount >= maxIter) {
      (combat as any).phase = 'player_turn';
    }
    refresh();
  }, [combat, refresh]);

  // Start a battle wave
  const startWave = useCallback((wave: WavePreset) => {
    setSelectedWave(wave);
    combat.initCombat(playerBuild, wave.enemies);
    setLog([`Battle started: ${wave.name}`]);
    refresh();
    if (combat.phase === 'enemy_turn') {
      setTimeout(() => runEnemyTurns(), 600);
    }
  }, [combat, playerBuild, refresh, runEnemyTurns]);

  // Player action
  const doAction = useCallback((action: CombatAction) => {
    if (combat.phase !== 'player_turn') return;

    const result = combat.resolveAction(action);
    const msg = formatResult(result, combat);
    setLog(prev => [...prev.slice(-3), msg]);

    // resolveAction mutates combat.phase — re-read after call
    const nextPhase: string = combat.phase;
    if (nextPhase === 'enemy_turn') {
      refresh();
      setTimeout(() => runEnemyTurns(), 400);
    } else {
      refresh();
    }
  }, [combat, refresh, runEnemyTurns]);

  // Exit handler
  const handleExit = useCallback(() => {
    const xp = combat.totalXp;
    const coins = combat.totalCoins;
    const items = [...combat.droppedItems];
    combat.reset();
    onExit(xp, coins, items);
  }, [combat, onExit]);

  // Wave select screen
  if (!selectedWave || combat.phase === 'idle') {
    return (
      <div style={styles.overlay}>
        <div style={styles.wavePanel}>
          <div style={styles.waveTitle}>BATTLE HALL</div>
          <div style={styles.waveSub}>Select a challenge</div>
          {BATTLE_WAVES.map((wave, i) => (
            <button
              key={i}
              style={styles.waveBtn}
              onClick={() => startWave(wave)}
            >
              <span style={{ color: '#ddd', fontWeight: 700 }}>{wave.name}</span>
              <span style={{ color: '#555', fontSize: 9 }}>
                Tier {wave.tier} · {wave.enemies.length} {wave.enemies.length === 1 ? 'enemy' : 'enemies'}
              </span>
            </button>
          ))}
          <button style={styles.backBtn} onClick={() => onExit(0, 0, [])}>BACK</button>
        </div>
      </div>
    );
  }

  // Victory / defeat
  if (phase === 'victory' || phase === 'defeat') {
    return (
      <div style={styles.overlay}>
        <div style={styles.resultPanel}>
          <div style={{
            fontSize: 16, fontWeight: 700, letterSpacing: '3px',
            color: phase === 'victory' ? '#f59e0b' : '#c44',
            marginBottom: 16,
          }}>
            {phase === 'victory' ? 'VICTORY' : 'DEFEAT'}
          </div>
          {phase === 'victory' && (
            <div style={{ color: '#888', fontSize: 11, marginBottom: 12 }}>
              <div>+{combat.totalXp} XP</div>
              <div>+{combat.totalCoins} Coins</div>
              {combat.droppedItems.length > 0 && (
                <div style={{ marginTop: 8, borderTop: '1px solid #1a1a1a', paddingTop: 8 }}>
                  <div style={{ color: '#555', fontSize: 9, marginBottom: 4 }}>LOOT</div>
                  {combat.droppedItems.map((item, i) => (
                    <div key={i} style={{
                      color: RARITIES[item.rarity as RarityTier].color,
                      fontSize: 10,
                      marginBottom: 2,
                    }}>
                      {item.name}{item.quantity > 1 ? ` ×${item.quantity}` : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <button style={styles.confirmBtn} onClick={handleExit}>
            {phase === 'victory' ? 'COLLECT REWARDS' : 'RETURN'}
          </button>
        </div>
      </div>
    );
  }

  // Active combat UI
  const player = combat.party[0];
  const active = combat.getActiveCombatant();
  const isPlayerTurn = combat.isPlayerTurn();
  const classDef = CLASS_DEFINITIONS[playerBuild.class];

  return (
    <div style={styles.overlay}>
      {/* Turn indicator */}
      <div style={styles.turnBar}>
        <span style={{ color: isPlayerTurn ? '#f59e0b' : '#c44' }}>
          Turn {combat.turnNumber} — {active?.name ?? '???'}{isPlayerTurn ? ' (your turn)' : ''}
        </span>
      </div>

      {/* Enemy bars — top */}
      <div style={styles.enemyArea}>
        {combat.enemies.map((enemy, i) => (
          <div key={i} style={{ ...styles.enemyCard, opacity: enemy.dead ? 0.3 : 1 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <span style={{ color: ELEM_HEX[enemy.element], fontSize: 10, fontWeight: 600 }}>{enemy.name}</span>
              <span style={{ color: '#666', fontSize: 9 }}>{enemy.hp}/{enemy.maxHp}</span>
            </div>
            <HpBar current={enemy.hp} max={enemy.maxHp} color="#c44" />
            <StatusBadges statuses={enemy.statuses} />
          </div>
        ))}
      </div>

      {/* Combat log — center */}
      <div style={styles.logArea}>
        {log.slice(-4).map((msg, i) => (
          <div key={i} style={{ color: '#666', fontSize: 9, marginBottom: 2 }}>{msg}</div>
        ))}
      </div>

      {/* Player bars + actions — bottom */}
      <div style={styles.playerArea}>
        <div style={styles.playerBars}>
          <div style={{ marginBottom: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
              <span style={{ color: '#ddd', fontSize: 11, fontWeight: 600 }}>{player.name}</span>
              <span style={{ color: '#888', fontSize: 9 }}>HP {player.hp}/{player.maxHp}</span>
            </div>
            <HpBar current={player.hp} max={player.maxHp} color="#c44" />
            <StatusBadges statuses={player.statuses} />
          </div>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
              <span style={{ color: '#88a', fontSize: 9 }}>Spirit</span>
              <span style={{ color: '#88a', fontSize: 9 }}>{player.spirit}/{player.maxSpirit}</span>
            </div>
            <HpBar current={player.spirit} max={player.maxSpirit} color="#448" />
          </div>
        </div>

        {/* Action buttons — only during player turn */}
        {isPlayerTurn && (
          <div style={styles.actionRow}>
            <ActionBtn
              label={`⚔ ${classDef.startingMelee.name}`}
              sub="Melee"
              onClick={() => doAction({ type: 'melee', targetIndex: firstAliveEnemy(combat) })}
            />
            <ActionBtn
              label={`↗ ${classDef.startingRanged.name}`}
              sub="Ranged"
              onClick={() => doAction({ type: 'ranged', targetIndex: firstAliveEnemy(combat) })}
            />
            {classDef.abilities.map((ab, i) => (
              <ActionBtn
                key={i}
                label={ab.name}
                sub={`${ab.spiritCost} sp`}
                disabled={player.spirit < ab.spiritCost}
                onClick={() => doAction({ type: 'ability', abilityIndex: i, targetIndex: firstAliveEnemy(combat) })}
              />
            ))}
            {/* Potions */}
            <ActionBtn
              label="❤ Heal"
              sub={`×${potions.healing}`}
              disabled={potions.healing <= 0 || player.hp >= player.maxHp}
              onClick={() => {
                if (potions.healing <= 0) return;
                player.hp = Math.min(player.maxHp, player.hp + 40);
                onPotionUsed('healing_potion');
                setLog(prev => [...prev.slice(-3), `${player.name} used Healing Potion (+40 HP)`]);
                refresh();
              }}
            />
            <ActionBtn
              label="◆ Spirit"
              sub={`×${potions.spirit}`}
              disabled={potions.spirit <= 0 || player.spirit >= player.maxSpirit}
              onClick={() => {
                if (potions.spirit <= 0) return;
                player.spirit = Math.min(player.maxSpirit, player.spirit + 25);
                onPotionUsed('spirit_potion');
                setLog(prev => [...prev.slice(-3), `${player.name} used Spirit Potion (+25 Spirit)`]);
                refresh();
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function HpBar({ current, max, color }: { current: number; max: number; color: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (current / max) * 100)) : 0;
  return (
    <div style={{ width: '100%', height: 6, background: '#1a1a1a', borderRadius: 2 }}>
      <div style={{
        width: `${pct}%`, height: '100%', background: color,
        borderRadius: 2, transition: 'width 0.3s ease',
      }} />
    </div>
  );
}

function ActionBtn({ label, sub, disabled, onClick }: {
  label: string; sub: string; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button
      style={{
        ...styles.actionBtn,
        opacity: disabled ? 0.3 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
      disabled={disabled}
      onClick={onClick}
    >
      <div style={{ fontSize: 10, color: '#ddd', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 8, color: '#555' }}>{sub}</div>
    </button>
  );
}

function firstAliveEnemy(combat: CombatState): number {
  for (let i = 0; i < combat.enemies.length; i++) {
    if (!combat.enemies[i].dead) return i;
  }
  return 0;
}

function formatResult(r: ActionResult, combat: CombatState): string {
  const attacker = r.attackerIndex >= 0
    ? (combat.party[r.attackerIndex]?.name ?? '???')
    : '???';
  // For enemies, attackerIndex is negative-encoded in turnOrder but ActionResult stores
  // the raw enemy index. We need to check isEnemy context from the result.
  // Since resolveAction stores raw indices, reconstruct:
  const attackerName = r.actionType === 'melee' || r.actionType === 'ranged' || r.actionType === 'ability'
    ? getAttackerName(r, combat)
    : attacker;

  if (r.missed) return `${attackerName} missed!`;
  const critTag = r.critical ? ' CRIT!' : '';
  const killTag = r.killed ? ' — DEFEATED' : '';
  return `${attackerName} dealt ${r.damage} dmg${critTag}${killTag}`;
}

function getAttackerName(r: ActionResult, combat: CombatState): string {
  // Check party first
  if (r.attackerIndex >= 0 && r.attackerIndex < combat.party.length) {
    return combat.party[r.attackerIndex].name;
  }
  // Check enemies — attackerIndex for enemies is the raw enemy array index
  if (r.attackerIndex >= 0 && r.attackerIndex < combat.enemies.length) {
    // Could be either party or enemy depending on context.
    // If party[attackerIndex] exists and is player, use that. Otherwise enemy.
    if (combat.party[r.attackerIndex]) return combat.party[r.attackerIndex].name;
    return combat.enemies[r.attackerIndex]?.name ?? '???';
  }
  return '???';
}

// ── Styles ────────────────────────────────────────────────────────────

const styles = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 80,
    display: 'flex',
    flexDirection: 'column' as const,
    fontFamily: '"Courier New", Courier, monospace',
    pointerEvents: 'auto' as const,
    background: 'rgba(0, 0, 0, 0.75)',
  },
  turnBar: {
    textAlign: 'center' as const,
    padding: '8px 0',
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: '1px',
    background: 'rgba(10, 10, 10, 0.9)',
    borderBottom: '1px solid #1a1a1a',
  },
  enemyArea: {
    display: 'flex',
    gap: 12,
    justifyContent: 'center',
    padding: '16px 20px',
    flexWrap: 'wrap' as const,
  },
  enemyCard: {
    width: 140,
    padding: '8px 10px',
    background: 'rgba(14, 14, 14, 0.9)',
    border: '1px solid #1e1e1e',
    borderRadius: 4,
  },
  logArea: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    justifyContent: 'flex-end',
    padding: '0 20px 8px',
  },
  playerArea: {
    padding: '12px 20px 16px',
    background: 'rgba(10, 10, 10, 0.9)',
    borderTop: '1px solid #1a1a1a',
  },
  playerBars: {
    maxWidth: 300,
    marginBottom: 10,
  },
  actionRow: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap' as const,
  },
  actionBtn: {
    padding: '6px 12px',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 4,
    cursor: 'pointer' as const,
    fontFamily: '"Courier New", Courier, monospace',
    textAlign: 'left' as const,
    minWidth: 90,
  },
  // Wave select
  wavePanel: {
    margin: 'auto',
    padding: '24px 32px',
    background: '#0e0e0e',
    border: '1px solid #1e1e1e',
    borderRadius: 6,
    maxWidth: 360,
    width: '90%',
  },
  waveTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: '#f59e0b',
    letterSpacing: '3px',
    marginBottom: 4,
    textAlign: 'center' as const,
  },
  waveSub: {
    fontSize: 10,
    color: '#444',
    marginBottom: 16,
    textAlign: 'center' as const,
  },
  waveBtn: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    padding: '10px 14px',
    marginBottom: 6,
    background: '#0a0a0a',
    border: '1px solid #1e1e1e',
    borderRadius: 4,
    cursor: 'pointer' as const,
    fontFamily: '"Courier New", Courier, monospace',
    fontSize: 11,
  },
  backBtn: {
    width: '100%',
    padding: '8px 0',
    marginTop: 10,
    background: 'transparent',
    border: '1px solid #1e1e1e',
    borderRadius: 4,
    color: '#444',
    cursor: 'pointer' as const,
    fontFamily: '"Courier New", Courier, monospace',
    fontSize: 10,
  },
  // Result screen
  resultPanel: {
    margin: 'auto',
    padding: '24px 32px',
    background: '#0e0e0e',
    border: '1px solid #1e1e1e',
    borderRadius: 6,
    textAlign: 'center' as const,
  },
  confirmBtn: {
    padding: '10px 24px',
    fontSize: 11,
    fontWeight: 700,
    fontFamily: '"Courier New", Courier, monospace',
    background: '#f59e0b',
    color: '#000',
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer' as const,
    letterSpacing: '1px',
  },
} as const;
