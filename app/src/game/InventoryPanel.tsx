/**
 * InventoryPanel — Diablo II-style layout
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │ HEADER                                                      │
 * ├──────────────┬──────────────────┬───────────────────────────┤
 * │ Stats        │ Paperdoll        │ Skills (tabbed)           │
 * │ (D2 left)    │ (3×3 + sprite)   │ Abilities / Passives / Aura│
 * ├──────────────┴──────────────────┴───────────────────────────┤
 * │ [Item detail strip — shown when item selected]              │
 * ├─────────────────────────────────────────────────────────────┤
 * │ Bag grid (auto-fill, scrollable)                            │
 * └─────────────────────────────────────────────────────────────┘
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  RARITIES, EQUIP_SLOT_NAMES, POTIONS,
  type GameItem, type EquipSlot, type RarityTier,
} from './ItemDefinitions';
import {
  CLASS_DEFINITIONS, derivedStats,
  type PlayerBuild,
} from './PlayerClasses';
import {
  SKILL_TREES, canUnlockNode, TIER_LEVEL_REQ,
  type SkillNode, type NodeId,
} from './SkillTreeData';

const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const FONT = '"Courier New", Courier, monospace';

function sellPrice(item: GameItem): number {
  if (item.type === 'potion') {
    const def = POTIONS[item.id as keyof typeof POTIONS];
    return def ? def.buyPrice * item.quantity : 1;
  }
  return Math.floor(2 * ([1, 1.5, 2.5, 4, 8][item.rarity] ?? 1));
}

interface Props {
  onClose:        () => void;
  coins:          number;
  onCoinsChanged: (coins: number) => void;
  build:          PlayerBuild;
  onBuildChanged: (build: PlayerBuild) => void;
  /** Called after any equip or unequip so the parent can re-sync the build's equipment field. */
  onEquipChanged?: (equipped: Partial<Record<EquipSlot, GameItem>>) => void;
}

const SLOT_POSITIONS: Array<{ slot: EquipSlot; row: number; col: number }> = [
  { slot: 'leftRing',       row: 0, col: 0 },
  { slot: 'helm',           row: 0, col: 1 },
  { slot: 'rightRing',      row: 0, col: 2 },
  { slot: 'melee',          row: 1, col: 0 },
  // row 1 col 1 = character sprite
  { slot: 'abilityCrystal', row: 1, col: 2 },
  { slot: 'ranged',         row: 2, col: 0 },
  { slot: 'legs',           row: 2, col: 1 },
  { slot: 'body',           row: 2, col: 2 },
];

const SLOT_ICONS: Partial<Record<EquipSlot, string>> = {
  helm: '⬡', body: '◈', legs: '↓', melee: '⚔',
  ranged: '◎', abilityCrystal: '✦', leftRing: '○', rightRing: '○',
};

const ELEMENT_COLORS: Record<string, string> = {
  plasma: '#c084fc', fire: '#f97316', ice: '#60a5fa',
  lightning: '#facc15', void: '#818cf8', nature: '#4ade80',
};

type SkillTab = 'abilities' | 'passives' | 'aura';

export function InventoryPanel({ onClose, coins, onCoinsChanged, build, onBuildChanged, onEquipChanged }: Props) {
  const [inventory, setInventory]       = useState<GameItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<GameItem | null>(null);
  const [loading, setLoading]           = useState(true);
  const [skillTab, setSkillTab]         = useState<SkillTab>('abilities');

  const loadInventory = useCallback(async () => {
    try {
      const resp = await fetch(`${ENGINE_URL}/api/game/inventory`);
      const rows = await resp.json();
      const items: GameItem[] = (rows as Array<{ data: string; equipped: boolean; id: string }>)
        .map(row => {
          try {
            const item = JSON.parse(row.data) as GameItem;
            item.equipped = row.equipped;
            item.id = row.id;
            return item;
          } catch { return null; }
        }).filter(Boolean) as GameItem[];
      setInventory(items);
    } catch { /* silent */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadInventory(); }, [loadInventory]);

  const equipped = useMemo(() => {
    const map: Partial<Record<EquipSlot, GameItem>> = {};
    for (const item of inventory) {
      if (item.equipped && item.type !== 'potion') map[item.slot!] = item;
    }
    return map;
  }, [inventory]);

  const bagItems = useMemo(() => {
    const order = (i: GameItem) => {
      if (i.type === 'weapon') return 0;
      if (i.type === 'armor')  return 1;
      if (i.slot === 'abilityCrystal') return 2;
      if (i.slot === 'leftRing' || i.slot === 'rightRing') return 3;
      return 4;
    };
    return inventory.filter(i => !i.equipped).sort((a, b) => order(a) - order(b) || b.rarity - a.rarity);
  }, [inventory]);

  const handleEquip = useCallback(async (item: GameItem) => {
    if (item.type === 'potion') return;
    try {
      await fetch(`${ENGINE_URL}/api/game/inventory/equip`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      });
      await loadInventory(); setSelectedItem(null);
    } catch { /* silent */ }
  }, [loadInventory]);

  const handleUnequip = useCallback(async (item: GameItem) => {
    try {
      await fetch(`${ENGINE_URL}/api/game/inventory/unequip`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      });
      await loadInventory(); setSelectedItem(null);
    } catch { /* silent */ }
  }, [loadInventory]);

  const handleSell = useCallback(async (item: GameItem) => {
    if (item.equipped) return;
    const price = sellPrice(item);
    try {
      const resp = await fetch(`${ENGINE_URL}/api/game/inventory/sell`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, sellPrice: price }),
      });
      const data = await resp.json();
      if (data.phobos_coins != null) onCoinsChanged(data.phobos_coins);
      await loadInventory(); setSelectedItem(null);
    } catch { /* silent */ }
  }, [loadInventory, onCoinsChanged]);

  const handleUnlockNode = useCallback(async (nodeId: NodeId) => {
    const check = canUnlockNode(nodeId, build.unlockedNodes, build.level, build.skillPoints);
    if (!check.ok) return;
    const tree = SKILL_TREES[build.class];
    const allNodes = [...tree.abilities.flatMap(a => a.nodes), ...tree.aura.nodes, ...tree.passives];
    const node = allNodes.find(n => n.id === nodeId);
    if (!node) return;
    const updated: PlayerBuild = {
      ...build,
      skillPoints:   build.skillPoints - node.cost,
      unlockedNodes: [...build.unlockedNodes, nodeId],
    };
    onBuildChanged(updated);
    try {
      await fetch(`${ENGINE_URL}/api/game/player`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill_points: updated.skillPoints, unlocked_nodes: JSON.stringify(updated.unlockedNodes) }),
      });
    } catch { /* silent */ }
  }, [build, onBuildChanged]);

  // Notify parent whenever equipped items change so it can push the updated
  // equipment snapshot onto cachedBuild and into the combat controller.
  useEffect(() => {
    onEquipChanged?.(equipped);
  }, [equipped, onEquipChanged]);

  const tree     = SKILL_TREES[build.class];
  const classDef = CLASS_DEFINITIONS[build.class];

  // Build a local snapshot of the build with currently equipped items attached
  // so derivedStats() can incorporate ring stats, weapon damage, armor defense,
  // freq osc passives, and ability crystal bonuses.
  const buildWithGear = useMemo((): PlayerBuild => ({
    ...build,
    equipment: {
      melee:          equipped['melee'],
      ranged:         equipped['ranged'],
      helm:           equipped['helm'],
      body:           equipped['body'],
      legs:           equipped['legs'],
      leftRing:       equipped['leftRing'],
      rightRing:      equipped['rightRing'],
      abilityCrystal: equipped['abilityCrystal'],
    },
  }), [build, equipped]);

  const stats = useMemo(() => derivedStats(buildWithGear), [buildWithGear]);
  const elemColor = ELEMENT_COLORS[build.element] ?? '#aaa';

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={S.panel} onClick={e => e.stopPropagation()}>

        {/* HEADER */}
        <div style={S.header}>
          <span style={S.title}>INVENTORY</span>
          <span style={S.levelBadge}>LV {build.level}</span>
          {build.skillPoints > 0 && (
            <span style={S.spBadge}>{build.skillPoints} skill pt{build.skillPoints !== 1 ? 's' : ''}</span>
          )}
          <span style={S.coinDisplay}>◈ {coins}</span>
          <button style={S.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* TOP ROW */}
        <div style={S.topRow}>

          {/* STATS — D2 left panel */}
          <div style={S.statsPanel}>
            <div style={S.charName}>{build.name || 'PLAYER'}</div>
            <div style={S.charSub}>
              {classDef.name.toUpperCase()}
              <span style={{ color: elemColor, marginLeft: 8 }}>{build.element.toUpperCase()}</span>
            </div>

            <div style={S.statDivider} />
            <StatBlock label="HP"         value={stats.maxHp.toString()}            color="#f87171" />
            <StatBlock label="SPIRIT"     value={stats.maxSpirit.toString()}         color="#60a5fa" />
            <StatBlock label="DEFENSE"    value={stats.defense.toString()}           color="#aaa" />
            <StatBlock label="MOVE SPD"   value={stats.moveSpeed.toFixed(1)}         color="#aaa" />

            <div style={S.statDivider} />
            <StatBlock label="MELEE DMG"  value={`${stats.meleeDmgMin}–${stats.meleeDmgMax}`}   color="#f59e0b" />
            <StatBlock label="RANGED DMG" value={`${stats.rangedDmgMin}–${stats.rangedDmgMax}`} color="#f59e0b" />
            <StatBlock label="ATK SPEED"  value={stats.attackSpeed.toFixed(2)}      color="#aaa" />
            <StatBlock label="ACCURACY"   value={`${(stats.accuracy * 100).toFixed(0)}%`} color="#aaa" />

            <div style={S.statDivider} />
            <StatBlock label="ELE RESIST" value={stats.elementalResist.toString()}  color={elemColor} />
            <StatBlock label="CDR"        value={`${(stats.cooldownReduction * 100).toFixed(0)}%`} color="#c084fc" />
            {stats.regenFlat > 0 && (
              <StatBlock label="HP REGEN" value={`+${stats.regenFlat.toFixed(2)}/s`} color="#4ade80" />
            )}
            {stats.abilityDmgBonus > 0 && (
              <StatBlock label="ABIL BONUS" value={`+${stats.abilityDmgBonus.toFixed(1)}`} color="#c084fc" />
            )}
            {stats.lifestealPct > 0 && (
              <StatBlock label="LIFESTEAL" value={`${(stats.lifestealPct * 100).toFixed(1)}%`} color="#f87171" />
            )}
            {stats.teamHealFlat > 0 && (
              <StatBlock label="TEAM HEAL" value={`+${stats.teamHealFlat.toFixed(1)}/hit`} color="#4ade80" />
            )}
            {build.unspentPoints > 0 && (
              <div style={S.unspentBadge}>▲ {build.unspentPoints} stat pt{build.unspentPoints !== 1 ? 's' : ''}</div>
            )}
          </div>

          <div style={S.vDivider} />

          {/* PAPERDOLL */}
          <div style={S.paperdollPanel}>
            <div style={S.sectionLabel}>EQUIPMENT</div>
            <div style={S.paperdollGrid}>
              {/* Center sprite */}
              <div style={S.charCell}>
                <img
                  src={`game/sprites/${build.class}-${build.body}-move.png`}
                  alt={build.class}
                  style={{
                    position: 'absolute',
                    top: 3, left: 3,
                    width: 633, height: 633,
                    imageRendering: 'pixelated',
                    transform: `scale(${80 / 633})`,
                    transformOrigin: 'top left',
                  }}
                />
              </div>
              {SLOT_POSITIONS.map(({ slot, row, col }) => {
                const item  = equipped[slot];
                const color = item ? (RARITIES[Number(item.rarity) as RarityTier] ?? RARITIES[0]).color : '#2a2a2a';
                const isSel = selectedItem?.id === item?.id && item != null;
                return (
                  <div
                    key={slot}
                    style={{ ...S.equipSlot, gridRow: row + 1, gridColumn: col + 1, borderColor: isSel ? '#f59e0b' : color, boxShadow: item ? `inset 0 0 8px ${color}22` : undefined }}
                    onClick={() => item && setSelectedItem(isSel ? null : item)}
                    title={item ? item.name : EQUIP_SLOT_NAMES[slot]}
                  >
                    {item ? <ItemIcon item={item} size={38} /> : <span style={S.slotIcon}>{SLOT_ICONS[slot] ?? '·'}</span>}
                    <span style={S.slotName}>{EQUIP_SLOT_NAMES[slot].replace(' Ring', '').toUpperCase()}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div style={S.vDivider} />

          {/* SKILLS */}
          <div style={S.skillsPanel}>
            <div style={S.tabBar}>
              {(['abilities', 'passives', 'aura'] as SkillTab[]).map(tab => (
                <button key={tab} style={{ ...S.tab, ...(skillTab === tab ? S.tabActive : {}) }} onClick={() => setSkillTab(tab)}>
                  {tab.toUpperCase()}
                </button>
              ))}
            </div>
            <div style={S.skillScroll}>
              {skillTab === 'abilities' && <AbilitiesPanel tree={tree} build={build} onUnlock={handleUnlockNode} />}
              {skillTab === 'passives'  && <PassivesPanel  tree={tree} build={build} onUnlock={handleUnlockNode} />}
              {skillTab === 'aura'      && <AuraPanel      tree={tree} build={build} onUnlock={handleUnlockNode} />}
            </div>
          </div>
        </div>

        {/* ITEM DETAIL */}
        {selectedItem && (
          <ItemDetail item={selectedItem} onEquip={handleEquip} onUnequip={handleUnequip} onSell={handleSell} onClose={() => setSelectedItem(null)} />
        )}

        <div style={S.hDivider} />

        {/* BAG */}
        <div style={S.bagSection}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexShrink: 0 }}>
            <span style={S.sectionLabel}>BAG</span>
            <span style={{ fontSize: 11, color: '#444' }}>{bagItems.length} items</span>
          </div>
          <div style={S.bagGrid}>
            {loading ? (
              <div style={S.emptyMsg}>Loading...</div>
            ) : bagItems.length === 0 ? (
              <div style={S.emptyMsg}>Empty</div>
            ) : bagItems.map(item => {
              const rColor = (RARITIES[Number(item.rarity) as RarityTier] ?? RARITIES[0]).color;
              const isSel  = selectedItem?.id === item.id;
              return (
                <div
                  key={item.id}
                  style={{ ...S.bagSlot, borderColor: isSel ? '#f59e0b' : rColor, background: isSel ? '#1a1208' : '#131313' }}
                  onClick={() => setSelectedItem(isSel ? null : item)}
                  title={item.name}
                >
                  <ItemIcon item={item} size={32} />
                  {item.type === 'potion' && item.quantity > 1 && <span style={S.stackBadge}>{item.quantity}</span>}
                  {(item.weaponStats || item.armorStats) && (
                    <div style={S.socketRow}>
                      {item.weaponStats?.vortexPhasers.map((vp, i) => (
                        <div key={i} style={{ ...S.socketPip, background: vp ? (vp.pulse > 0 ? '#60a5fa' : '#f87171') : 'transparent' }} />
                      ))}
                      {item.armorStats && <div style={{ ...S.socketPip, background: item.armorStats.vortexPhaser ? '#60a5fa' : 'transparent' }} />}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
}

// ── Abilities Panel ────────────────────────────────────────────────────────────

function AbilitiesPanel({ tree, build, onUnlock }: { tree: import('./SkillTreeData').ClassSkillTree; build: PlayerBuild; onUnlock: (id: NodeId) => void }) {
  const classDef = CLASS_DEFINITIONS[build.class];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {tree.abilities.map((ab, ai) => (
        <div key={ai} style={S.abilityBlock}>
          <div style={S.abilityTitle}>{classDef.abilities[ai].name.toUpperCase()}</div>
          {([1, 2, 3, 4, 5] as Array<1|2|3|4|5>).map(tier => {
            const tierNodes  = ab.nodes.filter(n => n.tier === tier);
            const tierLocked = build.level < TIER_LEVEL_REQ[tier];
            return (
              <div key={tier} style={S.tierRow}>
                <div style={{ ...S.tierLabel, color: tierLocked ? '#3a3a3a' : '#666' }}>T{tier}{tierLocked ? ` ·${TIER_LEVEL_REQ[tier]}` : ''}</div>
                <div style={S.tierNodes}>
                  {tierNodes.map(node => <SkillNodeBtn key={node.id} node={node} build={build} onUnlock={onUnlock} tierLocked={tierLocked} />)}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function PassivesPanel({ tree, build, onUnlock }: { tree: import('./SkillTreeData').ClassSkillTree; build: PlayerBuild; onUnlock: (id: NodeId) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ ...S.sectionLabel, marginBottom: 6 }}>CLASS PASSIVES</div>
      {tree.passives.map(p => {
        const unlocked  = build.unlockedNodes.includes(p.id);
        const canAfford = build.skillPoints >= p.cost;
        return (
          <div key={p.id} style={{ ...S.passiveRow, borderColor: unlocked ? '#1a3a1a' : canAfford ? '#252525' : '#1a1a1a', opacity: !unlocked && !canAfford ? 0.45 : 1, cursor: unlocked ? 'default' : 'pointer' }} onClick={() => !unlocked && onUnlock(p.id)}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: unlocked ? '#4ade80' : '#bbb' }}>{p.name}</span>
              {unlocked ? <span style={{ color: '#4ade80', fontSize: 13 }}>✓</span> : <span style={{ color: '#888', fontSize: 12 }}>{p.cost}pt</span>}
            </div>
            <div style={{ fontSize: 12, color: '#777', marginTop: 4 }}>{p.description}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 3, marginTop: 5 }}>
              {p.effects.filter(e => e.label).map((e, i) => <span key={i} style={S.effectTag}>{e.label}</span>)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AuraPanel({ tree, build, onUnlock }: { tree: import('./SkillTreeData').ClassSkillTree; build: PlayerBuild; onUnlock: (id: NodeId) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <div style={S.abilityTitle}>{tree.aura.name.toUpperCase()}</div>
        <div style={{ fontSize: 12, color: '#777', marginBottom: 10 }}>{tree.aura.description}</div>
        {([1, 2, 3, 4, 5] as Array<1|2|3|4|5>).map(tier => {
          const tierNodes  = tree.aura.nodes.filter(n => n.tier === tier);
          const tierLocked = build.level < TIER_LEVEL_REQ[tier];
          return (
            <div key={tier} style={S.tierRow}>
              <div style={{ ...S.tierLabel, color: tierLocked ? '#3a3a3a' : '#666' }}>T{tier}{tierLocked ? ` ·${TIER_LEVEL_REQ[tier]}` : ''}</div>
              <div style={S.tierNodes}>
                {tierNodes.map(node => <SkillNodeBtn key={node.id} node={node} build={build} onUnlock={onUnlock} tierLocked={tierLocked} />)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SkillNodeBtn({ node, build, onUnlock, tierLocked }: { node: SkillNode; build: PlayerBuild; onUnlock: (id: NodeId) => void; tierLocked: boolean }) {
  const unlocked = build.unlockedNodes.includes(node.id);
  const check    = canUnlockNode(node.id, build.unlockedNodes, build.level, build.skillPoints);
  const isBase   = node.tier === 1 && node.pathId === 'base';
  return (
    <div
      style={{ ...S.nodeCard, borderColor: unlocked ? '#3a2a08' : check.ok ? '#1a3a1a' : '#1e1e1e', background: unlocked ? '#120e02' : check.ok ? '#0a140a' : '#0e0e0e', cursor: (unlocked || !check.ok) ? 'default' : 'pointer', opacity: tierLocked && !unlocked ? 0.35 : 1, flex: isBase ? '0 0 100%' : '1 1 0' }}
      onClick={() => check.ok && !unlocked ? onUnlock(node.id) : undefined}
      title={unlocked ? 'Unlocked' : (check.reason ?? `Cost: ${node.cost}pt`)}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: unlocked ? '#f59e0b' : check.ok ? '#6ab06a' : '#555' }}>{node.name}</span>
        <span style={{ fontSize: 12, color: unlocked ? '#f59e0b' : check.ok ? '#4ade80' : '#555', marginLeft: 6, flexShrink: 0 }}>
          {unlocked ? '✓' : node.cost > 0 ? `${node.cost}pt` : ''}
        </span>
      </div>
      <div style={{ fontSize: 12, color: '#777', marginTop: 4, lineHeight: 1.4 }}>{node.description}</div>
      {node.effects.filter(e => e.label).length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 3, marginTop: 5 }}>
          {node.effects.filter(e => e.label).map((e, i) => <span key={i} style={S.effectTag}>{e.label}</span>)}
        </div>
      )}
    </div>
  );
}

function ItemIcon({ item, size }: { item: GameItem; size: number }) {
  if (item.type === 'potion') {
    const def = POTIONS[item.id as keyof typeof POTIONS];
    const c   = def?.color ?? '#888';
    return <div style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div style={{ width: size * 0.42, height: size * 0.65, background: c, borderRadius: '30% 30% 5% 5%', border: '1px solid rgba(255,255,255,0.2)', boxShadow: `0 0 4px ${c}88` }} /></div>;
  }
  if (item.slot === 'abilityCrystal') {
    const c = item.abilityCrystal?.element ? ELEMENT_COLORS[item.abilityCrystal.element] ?? '#8b5cf6' : '#8b5cf6';
    return <div style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div style={{ width: size * 0.6, height: size * 0.6, background: `linear-gradient(135deg, ${c}88, ${c})`, clipPath: 'polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%)', boxShadow: `0 0 6px ${c}66` }} /></div>;
  }
  if (item.slot === 'leftRing' || item.slot === 'rightRing') {
    const rc = (RARITIES[Number(item.rarity) as RarityTier] ?? RARITIES[0]).color;
    const c  = item.ring?.element ? ELEMENT_COLORS[item.ring.element] ?? rc : rc;
    return <div style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div style={{ width: size * 0.65, height: size * 0.65, borderRadius: '50%', border: `2px solid ${c}`, boxShadow: `0 0 4px ${c}44` }} /></div>;
  }
  return <div style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.55, color: (RARITIES[Number(item.rarity) as RarityTier] ?? RARITIES[0]).color }}>{item.slot ? (SLOT_ICONS[item.slot] ?? '◈') : '◈'}</div>;
}

function ItemDetail({ item, onEquip, onUnequip, onSell, onClose }: { item: GameItem; onEquip: (item: GameItem) => void; onUnequip: (item: GameItem) => void; onSell: (item: GameItem) => void; onClose: () => void }) {
  const rarity = RARITIES[Number(item.rarity) as RarityTier] ?? RARITIES[0];
  const price  = sellPrice(item);
  const ws = item.weaponStats; const as_ = item.armorStats; const ring = item.ring; const ac = item.abilityCrystal;
  return (
    <div style={S.detail}>
      <div style={S.detailInner}>
        <div style={S.detailIcon}><ItemIcon item={item} size={44} /></div>
        <div style={S.detailMeta}>
          <div style={{ color: rarity.color, fontSize: 15, fontWeight: 700 }}>{item.name}</div>
          <div style={{ color: '#888', fontSize: 12, marginTop: 2 }}>{rarity.name}{item.slot && ` · ${EQUIP_SLOT_NAMES[item.slot]}`}{item.element && ` · ${item.element}`}{ac?.element && ` · ${ac.element}`}{ring?.element && ` · ${ring.element}`}</div>
          <div style={{ marginTop: 6, display: 'flex', gap: 24, flexWrap: 'wrap' as const }}>
            {ws && <div>
              <DS label="Damage"     value={`${ws.dmgMin}–${ws.dmgMax}`} color="#f59e0b" />
              <DS label="Atk Speed"  value={ws.attackSpeed.toFixed(2)} />
              <DS label="Crit"       value={`${(ws.critChance*100).toFixed(1)}%`} color="#f59e0b" />
              <DS label="Durability" value={`${ws.durability}/${ws.durabilityMax}`} color="#666" />
              {ws.lifestealPct > 0 && <DS label="Lifesteal" value={`${ws.lifestealPct.toFixed(1)}%`} color="#f87171" />}
              {ws.hpRegenFlat  > 0 && <DS label="HP Regen"  value={`+${ws.hpRegenFlat.toFixed(2)}/s`} color="#f87171" />}
            </div>}
            {ws && <div>
              {ws.vortexPhasers.map((vp, i) => vp ? <DS key={i} label={`Phaser ${i+1}`} value={`${vp.pulse>0?'+':''}${(vp.pulse*100).toFixed(1)}`} color={vp.pulse>0?'#60a5fa':'#f87171'} /> : <DS key={i} label={`Phaser ${i+1}`} value="empty" color="#444" />)}
              {ws.frequencyOscillator ? <DS label="Oscillator" value={ws.frequencyOscillator.value.toFixed(3)} color="#00ffcc" /> : <DS label="Oscillator" value="empty" color="#444" />}
            </div>}
            {as_ && <div>
              <DS label="Defense"    value={`+${as_.defense}`} color="#60a5fa" />
              <DS label="Slash"      value={`+${as_.slashResist}`} />
              <DS label="Pierce"     value={`+${as_.pierceResist}`} />
              <DS label="Blunt"      value={`+${as_.bluntResist}`} />
              <DS label="Durability" value={`${as_.durability}/${as_.durabilityMax}`} color="#666" />
              {as_.hpRegenFlat > 0 && <DS label="HP Regen" value={`+${as_.hpRegenFlat.toFixed(2)}/s`} color="#f87171" />}
            </div>}
            {ring && <div>
              <DS label={ring.stat1.toUpperCase()} value={`+${ring.bonus1}`} color="#c084fc" />
              <DS label={ring.stat2.toUpperCase()} value={`+${ring.bonus2}`} color="#c084fc" />
              <div style={{ fontSize: 12, color: '#f59e0b', marginTop: 4 }}>{ring.special}</div>
            </div>}
            {ac && <div>
              <DS label="Element"   value={ac.element}        color={ELEMENT_COLORS[ac.element] ?? '#8b5cf6'} />
              <DS label="Size"      value={ac.size}           color="#bbb" />
              <DS label="Dmg Bonus" value={`+${ac.dmgBonus}`} color={ELEMENT_COLORS[ac.element] ?? '#8b5cf6'} />
              <div style={{ fontSize: 12, color: '#818cf8', marginTop: 4 }}>{ac.inspiredBonus.type.replace(/_/g,' ')}</div>
            </div>}
            {item.type === 'potion' && (() => { const def = POTIONS[item.id as keyof typeof POTIONS]; return def ? <div><DS label="Effect" value={def.type} color="#4ade80" /><DS label="Quantity" value={`×${item.quantity}`} /><DS label="Value" value={`◈${def.buyPrice}`} color="#ffd700" /></div> : null; })()}
          </div>
        </div>
        <div style={S.detailActions}>
          {item.type !== 'potion' && !item.equipped && <button style={S.actionBtn} onClick={() => onEquip(item)}>EQUIP</button>}
          {item.equipped                              && <button style={S.actionBtn} onClick={() => onUnequip(item)}>UNEQUIP</button>}
          {!item.equipped                             && <button style={{ ...S.actionBtn, ...S.sellBtn }} onClick={() => onSell(item)}>SELL ◈{price}</button>}
          <button style={S.dimBtn} onClick={onClose}>✕</button>
        </div>
      </div>
    </div>
  );
}

function StatBlock({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
      <span style={{ fontSize: 11, color: '#666', letterSpacing: '0.5px' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color: color ?? '#ccc', fontFamily: FONT }}>{value}</span>
    </div>
  );
}

function DS({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, marginBottom: 3 }}>
      <span style={{ color: '#777' }}>{label}</span>
      <span style={{ color: color ?? '#bbb', fontWeight: 600 }}>{value}</span>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const S = {
  overlay: { position: 'fixed' as const, inset: 0, zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.88)', fontFamily: FONT },
  panel: { width: 1140, maxWidth: '99vw', background: '#0c0c0c', border: '1px solid #2a2a2a', borderRadius: 6, display: 'flex', flexDirection: 'column' as const, overflow: 'hidden', boxShadow: '0 0 80px rgba(0,0,0,0.9)' },

  header: { display: 'flex', alignItems: 'center', padding: '13px 20px', borderBottom: '1px solid #222', background: '#111', gap: 12, flexShrink: 0 },
  title:       { fontSize: 20, fontWeight: 700, color: '#f59e0b', letterSpacing: '4px', flex: 1 },
  levelBadge:  { fontSize: 13, color: '#999', background: '#181818', border: '1px solid #2e2e2e', borderRadius: 3, padding: '3px 10px' },
  spBadge:     { fontSize: 13, color: '#4ade80', background: '#091409', border: '1px solid #1e4a1e', borderRadius: 3, padding: '3px 10px' },
  coinDisplay: { fontSize: 15, color: '#ffd700' },
  closeBtn:    { background: 'transparent', border: 'none', color: '#666', fontSize: 20, cursor: 'pointer', fontFamily: FONT, padding: '0 4px' },

  topRow:    { display: 'flex', flexShrink: 0, height: 340, overflow: 'hidden' },
  vDivider:  { width: 1, background: '#1e1e1e', flexShrink: 0 },
  hDivider:  { height: 1, background: '#1e1e1e', flexShrink: 0 },

  statsPanel: { width: 186, flexShrink: 0, padding: '16px 14px', display: 'flex', flexDirection: 'column' as const, background: '#090909' },
  charName:   { fontSize: 15, fontWeight: 700, color: '#ddd', letterSpacing: '1px', marginBottom: 3 },
  charSub:    { fontSize: 11, color: '#666', marginBottom: 12 },
  statDivider:{ height: 1, background: '#1e1e1e', margin: '10px 0' },
  unspentBadge: { marginTop: 14, fontSize: 12, fontWeight: 700, color: '#f59e0b', background: '#1a1208', border: '1px solid #3a2a08', borderRadius: 3, padding: '6px 8px', textAlign: 'center' as const },

  paperdollPanel: { width: 310, flexShrink: 0, padding: '14px 16px 16px', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 10, background: '#0e0e0e' },
  sectionLabel:   { fontSize: 11, color: '#666', letterSpacing: '2px', fontWeight: 700, alignSelf: 'flex-start' as const, marginBottom: 2 },
  paperdollGrid:  { display: 'grid', gridTemplateColumns: 'repeat(3, 86px)', gridTemplateRows: 'repeat(3, 86px)', gap: 6 },
  equipSlot: { width: 86, height: 86, background: '#131313', border: '1px solid #252525', borderRadius: 5, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', justifyContent: 'center', cursor: 'pointer', gap: 4, transition: 'border-color 0.12s', position: 'relative' as const },
  charCell:  { width: 86, height: 86, gridRow: 2, gridColumn: 2, background: '#0a0a0a', border: '1px solid #2a2a2a', borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', position: 'relative' as const },
  slotIcon:  { fontSize: 26, color: '#3a3a3a' },
  slotName:  { fontSize: 9, color: '#555', letterSpacing: '0.5px', textAlign: 'center' as const },

  skillsPanel: { flex: 1, display: 'flex', flexDirection: 'column' as const, overflow: 'hidden', minWidth: 0, background: '#0e0e0e' },
  tabBar:      { display: 'flex', borderBottom: '1px solid #1e1e1e', flexShrink: 0 },
  tab:         { flex: 1, padding: '12px 0', fontSize: 12, fontWeight: 700, fontFamily: FONT, background: 'transparent', border: 'none', borderBottom: '2px solid transparent', color: '#555', cursor: 'pointer', letterSpacing: '2px', transition: 'color 0.1s' },
  tabActive:   { color: '#f59e0b', borderBottomColor: '#f59e0b', background: '#0e0c00' },
  skillScroll: { flex: 1, overflow: 'auto', padding: '14px 16px' },

  abilityBlock: { borderBottom: '1px solid #181818', paddingBottom: 14, marginBottom: 4 },
  abilityTitle: { fontSize: 14, fontWeight: 700, color: '#bbb', letterSpacing: '2px', marginBottom: 10 },
  tierRow:      { display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 7 },
  tierLabel:    { fontSize: 11, width: 44, flexShrink: 0, paddingTop: 7, color: '#666' },
  tierNodes:    { display: 'flex', gap: 5, flex: 1, flexWrap: 'wrap' as const },
  nodeCard:     { border: '1px solid #1e1e1e', borderRadius: 4, padding: '8px 10px', minWidth: 0, background: '#0e0e0e', transition: 'border-color 0.1s, background 0.1s' },
  effectTag:    { fontSize: 10, color: '#5a8a5a', background: '#09110a', border: '1px solid #1a3a1a', borderRadius: 2, padding: '2px 6px' },
  passiveRow:   { border: '1px solid #222', borderRadius: 4, padding: '10px 12px', marginBottom: 5, transition: 'border-color 0.1s' },

  detail:        { borderTop: '1px solid #1e1e1e', background: '#111', padding: '12px 18px', flexShrink: 0 },
  detailInner:   { display: 'flex', gap: 16, alignItems: 'flex-start' },
  detailIcon:    { width: 60, height: 60, flexShrink: 0, background: '#181818', border: '1px solid #2a2a2a', borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  detailMeta:    { flex: 1, minWidth: 0 },
  detailActions: { display: 'flex', flexDirection: 'column' as const, gap: 6, flexShrink: 0 },
  actionBtn:     { padding: '7px 16px', fontSize: 12, fontWeight: 700, fontFamily: FONT, background: 'transparent', color: '#999', border: '1px solid #333', borderRadius: 3, cursor: 'pointer', letterSpacing: '1px', whiteSpace: 'nowrap' as const },
  sellBtn:       { borderColor: '#7f1d1d', color: '#f87171' },
  dimBtn:        { border: 'none', color: '#555', fontSize: 16, padding: '4px 8px', cursor: 'pointer', background: 'transparent', fontFamily: FONT },

  bagSection: { padding: '12px 14px 14px', display: 'flex', flexDirection: 'column' as const, height: 160, flexShrink: 0 },
  bagGrid:    { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(50px, 1fr))', gap: 5, overflow: 'auto', flex: 1, alignContent: 'flex-start' },
  bagSlot:    { aspectRatio: '1', background: '#131313', border: '1px solid #222', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', position: 'relative' as const, transition: 'border-color 0.1s' },
  stackBadge: { position: 'absolute' as const, bottom: 2, right: 3, fontSize: 10, color: '#ddd', fontWeight: 700, textShadow: '0 0 3px #000' },
  socketRow:  { position: 'absolute' as const, bottom: 2, left: 3, display: 'flex', gap: 2 },
  socketPip:  { width: 6, height: 6, borderRadius: '50%', border: '1px solid #444' },
  emptyMsg:   { fontSize: 13, color: '#555', padding: 10 },
} as const;