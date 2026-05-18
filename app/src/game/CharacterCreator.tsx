/**
 * CharacterCreator — wide 2-column class/stat/element picker.
 *
 * Left: name, class cards, body type, element with reaction info, sprite preview.
 * Right: stat allocator, derived stats, weapons, abilities.
 * Reusable as editor with mode='edit' + initialBuild.
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  CLASS_DEFINITIONS,
  ELEMENT_COLORS,
  ELEMENT_INFO,
  STAT_NAMES,
  STAT_DESCRIPTIONS,
  getTotalStats,
  derivedStats,
  totalBonusPoints,
  createDefaultBuild,
  type ClassName,
  type BodyType,
  type ElementType,
  type StatName,
  type PlayerBuild,
} from './PlayerClasses';

// ── Class accent colors ────────────────────────────────────────────────

const CLASS_COLORS: Record<ClassName, string> = {
  fighter: '#e2e2e2',
  tank: '#9ca3af',
  healer: '#c4b5fd',
  rogue: '#a1a1aa',
};

// ── Component ──────────────────────────────────────────────────────────

interface Props {
  mode: 'create' | 'edit';
  initialBuild?: PlayerBuild;
  onConfirm: (build: PlayerBuild) => void;
  onCancel: () => void;
}

export function CharacterCreator({ mode, initialBuild, onConfirm, onCancel }: Props) {
  const [name, setName] = useState(initialBuild?.name ?? '');
  const [cls, setCls] = useState<ClassName>(initialBuild?.class ?? 'fighter');
  const [body, setBody] = useState<BodyType>(initialBuild?.body ?? 'a');
  const [element, setElement] = useState<ElementType>(initialBuild?.element ?? 'plasma');
  const [bonus, setBonus] = useState(
    initialBuild?.bonusPoints ?? { str: 0, dex: 0, int: 0, agi: 0, vit: 0 },
  );

  // Sprite preview animation frame
  const [previewFrame, setPreviewFrame] = useState(0);
  const frameTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    frameTimer.current = setInterval(() => {
      setPreviewFrame(prev => (prev + 1) % 4);
    }, 300);
    return () => { if (frameTimer.current) clearInterval(frameTimer.current); };
  }, []);

  const level = initialBuild?.level ?? 1;
  const maxPoints = totalBonusPoints(level);
  const spent = bonus.str + bonus.dex + bonus.int + bonus.agi + bonus.vit;
  const remaining = maxPoints - spent;

  const classDef = CLASS_DEFINITIONS[cls];
  const elemInfo = ELEMENT_INFO[element];
  const elemColor = ELEMENT_COLORS[element];

  // Default skill tree values for the current class/body/element — recomputed only when those change
  const defaultSkillBuild = useMemo(
    () => createDefaultBuild('Explorer', cls, body, element),
    [cls, body, element],
  );

  const previewBuild = useMemo<PlayerBuild>(() => ({
    name: name || 'Explorer',
    class: cls,
    body,
    element,
    level,
    xp: initialBuild?.xp ?? 0,
    bonusPoints: bonus,
    unspentPoints: remaining,
    skillPoints:   initialBuild?.skillPoints   ?? defaultSkillBuild.skillPoints,
    unlockedNodes: initialBuild?.unlockedNodes ?? defaultSkillBuild.unlockedNodes,
  }), [name, cls, body, element, level, bonus, remaining, initialBuild, defaultSkillBuild]);

  const derived = useMemo(() => derivedStats(previewBuild), [previewBuild]);

  const addStat = useCallback((stat: StatName) => {
    if (remaining <= 0) return;
    setBonus(prev => ({ ...prev, [stat]: prev[stat] + 1 }));
  }, [remaining]);

  const removeStat = useCallback((stat: StatName) => {
    if (bonus[stat] <= 0) return;
    setBonus(prev => ({ ...prev, [stat]: prev[stat] - 1 }));
  }, [bonus]);

  const selectClass = useCallback((c: ClassName) => {
    setCls(c);
    setBonus({ str: 0, dex: 0, int: 0, agi: 0, vit: 0 });
  }, []);

  const handleConfirm = useCallback(() => {
    onConfirm({
      ...previewBuild,
      name: name.trim() || 'Explorer',
      unspentPoints: remaining,
    });
  }, [previewBuild, name, remaining, onConfirm]);

  const elements: Array<{ id: ElementType; label: string }> = [
    { id: 'plasma', label: 'Plasma' },
    { id: 'fire', label: 'Fire' },
    { id: 'ice', label: 'Ice' },
    { id: 'lightning', label: 'Lightning' },
    { id: 'void', label: 'Void' },
  ];

  const statKeys: StatName[] = ['str', 'dex', 'int', 'agi', 'vit'];

  // Sprite sheet source for preview — 4 cols × 5 rows at 16×16, we scale up 4×
  const spriteSheetSrc = `game/sprites/${classDef.spritePrefix}-${body}-move.png`;

  return (
    <div style={styles.overlay}>
      <div style={styles.panel}>

        {/* Header */}
        <div style={styles.header}>
          <span style={styles.headerTitle}>
            {mode === 'create' ? 'CREATE CHARACTER' : 'EDIT CHARACTER'}
          </span>
          <span style={styles.headerSub}>PHOBOS WORLD</span>
        </div>

        <div style={styles.columns}>

          {/* ══════════ LEFT COLUMN ══════════ */}
          <div style={styles.leftCol}>

            {/* Name */}
            <div style={styles.section}>
              <label style={styles.label}>NAME</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Explorer"
                maxLength={20}
                style={styles.nameInput}
                autoFocus
              />
            </div>

            {/* Class Selection */}
            <div style={styles.section}>
              <label style={styles.label}>CLASS</label>
              <div style={styles.classGrid}>
                {(Object.keys(CLASS_DEFINITIONS) as ClassName[]).map(c => {
                  const def = CLASS_DEFINITIONS[c];
                  const sel = cls === c;
                  const col = CLASS_COLORS[c];
                  return (
                    <div
                      key={c}
                      style={{
                        ...styles.classCard,
                        borderColor: sel ? col : '#1e1e1e',
                        background: sel ? '#161616' : '#0c0c0c',
                      }}
                      onClick={() => selectClass(c)}
                    >
                      <div style={{ fontSize: 12, fontWeight: 700, color: sel ? col : '#666', marginBottom: 2 }}>
                        {def.name}
                      </div>
                      <div style={{ fontSize: 9, color: '#4a4a4a', marginBottom: 4, fontStyle: 'italic' }}>
                        {def.title}
                      </div>
                      <div style={{ fontSize: 10, color: sel ? '#888' : '#3a3a3a', lineHeight: '1.4' }}>
                        {def.description}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Body Type + Sprite Preview */}
            <div style={styles.section}>
              <label style={styles.label}>BODY TYPE</label>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
                  <button
                    style={{
                      ...styles.bodyBtn,
                      borderColor: body === 'a' ? '#666' : '#1e1e1e',
                      color: body === 'a' ? '#ddd' : '#444',
                      background: body === 'a' ? '#1a1a1a' : '#0a0a0a',
                    }}
                    onClick={() => setBody('a')}
                  >
                    Type A — Slim / Agile
                  </button>
                  <button
                    style={{
                      ...styles.bodyBtn,
                      borderColor: body === 'b' ? '#666' : '#1e1e1e',
                      color: body === 'b' ? '#ddd' : '#444',
                      background: body === 'b' ? '#1a1a1a' : '#0a0a0a',
                    }}
                    onClick={() => setBody('b')}
                  >
                    Type B — Sturdy / Heavy
                  </button>
                </div>

                {/* Animated Sprite Preview */}
                <div style={styles.spriteBox}>
                  <div style={{
                    width: 64,
                    height: 64,
                    overflow: 'hidden',
                    position: 'relative' as const,
                  }}>
                    {/* 
                      Sprite sheet is 64×80 (4 cols × 5 rows of 16×16).
                      Scale up 4× to 256×320 for preview.
                      Row 0 = idle-down. Show frame [previewFrame] by shifting left.
                    */}
                    <img
                      src={spriteSheetSrc}
                      alt=""
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: -(previewFrame * 64),
                        width: 256,
                        height: 320,
                        imageRendering: 'pixelated' as const,
                        filter: element !== 'plasma'
                          ? `sepia(1) saturate(3) hue-rotate(${elementHueRotate(element)}deg) brightness(1.1)`
                          : 'none',
                      }}
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  </div>
                  <div style={{ fontSize: 9, color: '#3a3a3a', marginTop: 4, textAlign: 'center' }}>
                    {classDef.title}
                  </div>
                </div>
              </div>
            </div>

            {/* Element */}
            <div style={styles.section}>
              <label style={styles.label}>ELEMENT</label>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                {elements.map(el => {
                  const sel = element === el.id;
                  const col = ELEMENT_COLORS[el.id].hex;
                  return (
                    <button
                      key={el.id}
                      style={{
                        ...styles.elemBtn,
                        background: sel ? col : '#0c0c0c',
                        color: sel ? '#000' : '#555',
                        borderColor: sel ? col : '#1e1e1e',
                        fontWeight: sel ? 700 : 400,
                      }}
                      onClick={() => setElement(el.id)}
                    >
                      {el.label}
                    </button>
                  );
                })}
              </div>
              <div style={styles.elemDesc}>
                <div style={{ color: elemColor.hex, fontWeight: 700, fontSize: 11, marginBottom: 3 }}>
                  {elemInfo.name}
                </div>
                <div style={{ color: '#777', fontSize: 10, lineHeight: '1.5', marginBottom: 4 }}>
                  {elemInfo.description}
                </div>
                <div style={{ color: '#555', fontSize: 9, lineHeight: '1.4', fontStyle: 'italic' }}>
                  {elemInfo.reaction}
                </div>
              </div>
            </div>
          </div>

          {/* ══════════ RIGHT COLUMN ══════════ */}
          <div style={styles.rightCol}>

            {/* Stats */}
            <div style={styles.section}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <label style={styles.label}>STATS</label>
                <span style={{
                  fontSize: 11,
                  color: remaining > 0 ? '#f59e0b' : '#333',
                  fontWeight: 700,
                }}>
                  {remaining > 0 ? `${remaining} points to spend` : 'All allocated'}
                </span>
              </div>

              {statKeys.map(stat => {
                const base = classDef.baseStats[stat];
                const bonusVal = bonus[stat];
                const total = base + bonusVal;
                return (
                  <div key={stat} style={styles.statRow}>
                    <span style={styles.statName}>{STAT_NAMES[stat]}</span>
                    <span style={styles.statBase}>{base}</span>
                    <button
                      style={{ ...styles.statBtn, opacity: bonusVal > 0 ? 1 : 0.25 }}
                      onClick={() => removeStat(stat)}
                    >−</button>
                    <span style={styles.statTotal}>{total}</span>
                    <button
                      style={{ ...styles.statBtn, opacity: remaining > 0 ? 1 : 0.25 }}
                      onClick={() => addStat(stat)}
                    >+</button>
                    {bonusVal > 0 ? (
                      <span style={{ fontSize: 10, color: '#f59e0b', minWidth: 24 }}>+{bonusVal}</span>
                    ) : (
                      <span style={{ minWidth: 24 }} />
                    )}
                    <span style={styles.statHint}>{STAT_DESCRIPTIONS[stat]}</span>
                  </div>
                );
              })}
            </div>

            <div style={styles.divider} />

            {/* Combat */}
            <div style={styles.section}>
              <label style={styles.label}>COMBAT</label>
              <div style={styles.combatGrid}>
                <CombatRow label="Health" value={`${derived.maxHp}`} accent="#c44" />
                <CombatRow label="Spirit" value={`${derived.maxSpirit}`} accent="#66b" />
                <CombatRow label="Defense" value={`${derived.defense}`} />
                <CombatRow label="Elem. Resist" value={`${derived.elementalResist}`} />
              </div>
              <div style={{ ...styles.combatGrid, marginTop: 4 }}>
                <CombatRow label="Atk Speed" value={`${derived.attackSpeed.toFixed(2)}/s`} />
                <CombatRow label="Move Speed" value={derived.moveSpeed.toFixed(1)} />
                <CombatRow label="CDR" value={`${(derived.cooldownReduction * 100).toFixed(0)}%`} />
                <CombatRow label="Accuracy" value={`${(derived.accuracy * 100).toFixed(0)}%`} />
              </div>
            </div>

            <div style={styles.divider} />

            {/* Weapons */}
            <div style={styles.section}>
              <label style={styles.label}>WEAPONS</label>
              <div style={styles.itemCard}>
                <div style={styles.itemRow}>
                  <span style={{ color: '#aaa' }}>⚔ {classDef.startingMelee.name}</span>
                  <span style={{ color: '#ddd', fontWeight: 700 }}>{derived.meleeDmgMin}–{derived.meleeDmgMax}</span>
                </div>
                <div style={styles.itemRow}>
                  <span style={{ color: '#aaa' }}>↗ {classDef.startingRanged.name}</span>
                  <span style={{ color: '#ddd', fontWeight: 700 }}>{derived.rangedDmgMin}–{derived.rangedDmgMax}</span>
                </div>
              </div>
            </div>

            <div style={styles.divider} />

            {/* Abilities */}
            <div style={styles.section}>
              <label style={styles.label}>ABILITIES</label>
              {classDef.abilities.map(ab => {
                const dmg = ab.baseDmg > 0
                  ? Math.round(ab.baseDmg * derived.abilityDmgMultiplier)
                  : 0;
                const cd = ab.cooldown * (1 - derived.cooldownReduction);
                return (
                  <div key={ab.name} style={styles.abilityCard}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 11, color: '#ccc', fontWeight: 700 }}>{ab.name}</span>
                      {dmg > 0 && <span style={{ fontSize: 11, color: '#f59e0b', fontWeight: 700 }}>{dmg} dmg</span>}
                    </div>
                    <div style={{ fontSize: 10, color: '#666', marginTop: 2, lineHeight: 1.4 }}>
                      {ab.description}
                    </div>
                    <div style={{ fontSize: 9, color: '#3a3a3a', marginTop: 3 }}>
                      {ab.spiritCost} spirit · {cd.toFixed(1)}s cd
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <button style={styles.cancelBtn} onClick={onCancel}>BACK</button>
          <button style={styles.confirmBtn} onClick={handleConfirm}>
            {mode === 'create' ? 'ENTER WORLD' : 'SAVE CHANGES'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function CombatRow({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
      <span style={{ color: '#555', fontSize: 10 }}>{label}</span>
      <span style={{ color: accent ?? '#bbb', fontSize: 11, fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function elementHueRotate(el: ElementType): number {
  switch (el) {
    case 'fire':      return 15;
    case 'ice':       return 190;
    case 'lightning': return 260;
    case 'void':      return 230;
    default:          return 0;
  }
}

// ── Styles ─────────────────────────────────────────────────────────────

const styles = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 100,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0, 0, 0, 0.88)',
    backdropFilter: 'blur(8px)',
  },
  panel: {
    background: '#0e0e0e',
    border: '1px solid #1e1e1e',
    borderRadius: 6,
    width: 860,
    maxWidth: '95vw',
    maxHeight: '92vh',
    overflowY: 'auto' as const,
    fontFamily: '"Courier New", Courier, monospace',
    color: '#ddd',
    fontSize: 11,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '14px 20px',
    borderBottom: '1px solid #1a1a1a',
  },
  headerTitle: { fontSize: 13, fontWeight: 700, color: '#f59e0b', letterSpacing: '2px' },
  headerSub: { fontSize: 10, color: '#2a2a2a', letterSpacing: '3px' },
  columns: { display: 'flex', gap: 0 },
  leftCol: { flex: '1 1 430px', padding: '16px 20px', borderRight: '1px solid #1a1a1a' },
  rightCol: { flex: '1 1 430px', padding: '16px 20px' },
  section: { marginBottom: 16 },
  label: {
    display: 'block' as const, fontSize: 9, color: '#444', letterSpacing: '2px',
    textTransform: 'uppercase' as const, marginBottom: 6, fontWeight: 600,
  },
  nameInput: {
    width: '100%', padding: '8px 10px', fontSize: 13,
    fontFamily: '"Courier New", Courier, monospace',
    background: '#080808', border: '1px solid #1e1e1e', borderRadius: 3,
    color: '#fff', outline: 'none', boxSizing: 'border-box' as const,
  },
  classGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 },
  classCard: {
    padding: '8px 10px', border: '1px solid #1e1e1e', borderRadius: 4,
    cursor: 'pointer' as const, transition: 'all 0.12s ease',
  },
  bodyBtn: {
    padding: '6px 12px', fontSize: 10, fontFamily: '"Courier New", Courier, monospace',
    border: '1px solid #1e1e1e', borderRadius: 3, cursor: 'pointer' as const,
    background: '#0a0a0a', textAlign: 'left' as const,
  },
  spriteBox: {
    display: 'flex', flexDirection: 'column' as const, alignItems: 'center',
    padding: '8px 14px', background: '#060606', border: '1px solid #1a1a1a', borderRadius: 4,
  },
  elemBtn: {
    padding: '5px 12px', fontSize: 10, fontFamily: '"Courier New", Courier, monospace',
    border: '1px solid #1e1e1e', borderRadius: 3, cursor: 'pointer' as const,
    transition: 'all 0.12s ease',
  },
  elemDesc: {
    padding: '8px 10px', background: '#080808', border: '1px solid #1a1a1a', borderRadius: 4,
  },
  statRow: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, padding: '2px 0' },
  statName: { width: 85, fontSize: 11, color: '#999', fontWeight: 600 },
  statBase: { width: 22, fontSize: 9, color: '#3a3a3a', textAlign: 'center' as const },
  statTotal: { width: 26, fontSize: 13, fontWeight: 700, color: '#fff', textAlign: 'center' as const },
  statBtn: {
    width: 22, height: 22, fontSize: 14, fontFamily: '"Courier New", Courier, monospace',
    background: '#151515', color: '#888', border: '1px solid #2a2a2a', borderRadius: 3,
    cursor: 'pointer' as const, display: 'flex', alignItems: 'center',
    justifyContent: 'center', padding: 0, lineHeight: 1,
  },
  statHint: { fontSize: 9, color: '#2a2a2a', flex: 1, marginLeft: 4 },
  divider: { borderTop: '1px solid #1a1a1a', margin: '10px 0' },
  combatGrid: { display: 'flex', flexDirection: 'column' as const, gap: 1 },
  itemCard: {
    padding: '6px 10px', background: '#080808', border: '1px solid #1a1a1a', borderRadius: 4,
  },
  itemRow: {
    display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 11,
  },
  abilityCard: {
    padding: '6px 10px', background: '#080808', border: '1px solid #1a1a1a',
    borderRadius: 4, marginBottom: 4,
  },
  footer: {
    display: 'flex', gap: 8, padding: '12px 20px 16px', borderTop: '1px solid #1a1a1a',
  },
  confirmBtn: {
    flex: 3, padding: '10px 0', fontSize: 12,
    fontFamily: '"Courier New", Courier, monospace', fontWeight: 700,
    background: '#f59e0b', color: '#000', border: 'none', borderRadius: 4,
    cursor: 'pointer' as const, letterSpacing: '1px',
  },
  cancelBtn: {
    flex: 1, padding: '10px 0', fontSize: 11,
    fontFamily: '"Courier New", Courier, monospace',
    background: 'transparent', color: '#444', border: '1px solid #1e1e1e',
    borderRadius: 4, cursor: 'pointer' as const,
  },
} as const;
