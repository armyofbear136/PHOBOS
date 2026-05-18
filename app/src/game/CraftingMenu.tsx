/**
 * CraftingMenu — Full crafting station UI.
 *
 * Physical location: Forge Pad in the player zone (tile 30-31, 20-21).
 * Opened by pressing R at the forge. Rendered as a React overlay by PhobosGame.
 *
 * TABS
 * ────
 * FORGE    — Craft weapons. Pick base, then pick materials for head/shaft/grip.
 *            Live stat preview updates as materials are selected.
 *            Requires materials in inventory.
 *
 * ARMORY   — Craft armor. Pick base (helm/body/legs), pick main + backing material.
 *            Live stat preview.
 *
 * REFINE   — Convert 4× tier-N material → 1× tier-(N+1).
 *            Shows available stacks from inventory.
 *
 * CRYSTALS — Spend elemental shards to generate an Ability Crystal.
 *            Shows shard counts per element. Choose element + size.
 *
 * RINGS    — Craft a ring. Requires 20 shards + 5 FO + 10 VP of chosen element.
 *            Shows current inventory counts. Confirms ingredient cost before crafting.
 *
 * All crafting consumes items from `inventory`. Results are passed back via
 * `onCraft(newItem, consumedIds)` so the parent can persist changes.
 */

import { useState, useMemo } from 'react';
import {
  WEAPON_BASES, ARMOR_BASES, RARITIES,
  type GameItem, type EquipSlot,
} from './ItemDefinitions';
import {
  ALL_MATERIALS, getMaterialsForRole, REFINE_COST,
  type MaterialProps,
} from './CraftingMaterials';
import {
  craftWeapon, craftArmor, generateCrystal, craftRing,
} from './ItemGenerator';
import { CRYSTAL_SHARD_COST, type CrystalSize } from './CraftingMods';
// CraftingSystem stat computation used internally via craftWeapon/craftArmor
import type { ElementType } from './PlayerClasses';

// ── Palette ────────────────────────────────────────────────────────────────

const PANEL_BG  = 'rgba(10,10,10,0.97)';
const BORDER    = '#2a2a2a';
const ACCENT    = '#f59e0b';
const ACCENT2   = '#60a5fa';
const TEXT_DIM  = '#555';
const TEXT_MED  = '#888';
const TEXT_MAIN = '#ccc';

function tabBtn(active: boolean, color = ACCENT): React.CSSProperties {
  return {
    padding: '5px 12px', fontSize: 9, fontFamily: 'monospace', fontWeight: 700,
    background: active ? color + '22' : 'rgba(20,20,20,0.8)',
    color: active ? color : TEXT_DIM,
    border: `1px solid ${active ? color + '66' : BORDER}`,
    borderRadius: 4, cursor: 'pointer', letterSpacing: 1,
  };
}

function sectionLabel(text: string) {
  return (
    <div style={{ fontSize: 7, color: TEXT_DIM, fontFamily: 'monospace', letterSpacing: 2, marginBottom: 6, marginTop: 10 }}>
      {text}
    </div>
  );
}

// ── Material picker ────────────────────────────────────────────────────────

function MatPicker({
  role, inventory, selected, onSelect,
}: {
  role: string;
  inventory: GameItem[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  // All materials that can fill this role
  const candidates = getMaterialsForRole(role as any, true);
  // Count what's in inventory
  const inInventory = new Map<string, number>();
  for (const item of inventory) {
    if (item.type === 'crafting_material') {
      inInventory.set(item.name.toLowerCase().replace(/ /g,'_'), (inInventory.get(item.name.toLowerCase().replace(/ /g,'_')) ?? 0) + item.quantity);
    }
  }

  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 6,
    }}>
      {candidates.map(mat => {
        const matKey = mat.name.toLowerCase().replace(/ /g,'_');
        const qty = inInventory.get(matKey) ?? inInventory.get(mat.id) ?? 0;
        const isSelected = selected === mat.id;
        const hasIt = qty > 0;

        return (
          <button
            key={mat.id}
            onClick={() => onSelect(isSelected ? null : mat.id)}
            disabled={!hasIt}
            title={`${mat.name} — Tier ${mat.tier} ${mat.category}\nHV:${mat.hv} UTS:${mat.uts} CV:${mat.cv}`}
            style={{
              padding: '2px 6px', fontSize: 8, fontFamily: 'monospace',
              background: isSelected ? (mat.tint ? '#' + mat.tint.toString(16).padStart(6,'0') + '33' : ACCENT + '22') : 'rgba(20,20,20,0.7)',
              color: isSelected ? TEXT_MAIN : hasIt ? TEXT_MED : TEXT_DIM,
              border: `1px solid ${isSelected ? ('#' + (mat.tint ?? 0xf59e0b).toString(16).padStart(6,'0')) : hasIt ? '#333' : '#1a1a1a'}`,
              borderRadius: 3, cursor: hasIt ? 'pointer' : 'default',
              opacity: hasIt ? 1 : 0.35,
            }}
          >
            {mat.name} {hasIt ? `(${qty})` : ''}
          </button>
        );
      })}
      {candidates.length === 0 && (
        <div style={{ fontSize: 8, color: TEXT_DIM, fontFamily: 'monospace' }}>No materials for {role}</div>
      )}
    </div>
  );
}

// ── Stat preview ───────────────────────────────────────────────────────────

function StatBlock({ stats }: { stats: Record<string, string | number> }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.03)', border: `1px solid ${BORDER}`,
      borderRadius: 4, padding: '6px 8px',
    }}>
      {Object.entries(stats).map(([k, v]) => (
        <div key={k} style={{
          display: 'flex', justifyContent: 'space-between',
          fontSize: 9, fontFamily: 'monospace', marginBottom: 2,
        }}>
          <span style={{ color: TEXT_MED }}>{k}</span>
          <span style={{ color: TEXT_MAIN, fontWeight: 700 }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface CraftingMenuProps {
  inventory:  GameItem[];
  ether:      number;
  onClose:    () => void;
  onCraft:    (newItem: GameItem, consumedIds: string[]) => void;
}

type CraftTab = 'forge' | 'armory' | 'refine' | 'crystals' | 'rings';

// ── Main component ─────────────────────────────────────────────────────────

export function CraftingMenu({ inventory, ether: _ether, onClose, onCraft }: CraftingMenuProps) {
  const [tab, setTab] = useState<CraftTab>('forge');
  const [feedback, setFeedback] = useState<string | null>(null);

  const toast = (msg: string) => {
    setFeedback(msg);
    setTimeout(() => setFeedback(null), 2500);
  };

  // ── FORGE state ──────────────────────────────────────────────────────────
  const [forgeBase,    setForgeBase]    = useState<string | null>(null);
  const [forgeHead,    setForgeHead]    = useState<string | null>(null);
  const [forgeShaft,   setForgeShaft]   = useState<string | null>(null);
  const [forgeGrip,    setForgeGrip]    = useState<string | null>(null);
  const [forgeElement, setForgeElement] = useState<ElementType>('plasma');

  const forgePreview = useMemo(() => {
    if (!forgeBase || !forgeHead || !forgeShaft || !forgeGrip) return null;
    return craftWeapon(forgeBase, forgeHead, forgeShaft, forgeGrip, forgeElement, Math.random);
  }, [forgeBase, forgeHead, forgeShaft, forgeGrip, forgeElement]);

  const forgeWeapon = () => {
    if (!forgePreview) { toast('Select all components first.'); return; }
    // Find and consume one of each material from inventory
    const consumed: string[] = [];
    for (const matId of [forgeHead, forgeShaft, forgeGrip]) {
      const mat = ALL_MATERIALS.find(m => m.id === matId);
      if (!mat) continue;
      const invItem = inventory.find(i => i.type === 'crafting_material' && i.name === mat.name);
      if (!invItem) { toast(`Missing material: ${mat.name}`); return; }
      consumed.push(invItem.id);
    }
    onCraft(forgePreview, consumed);
    toast(`Forged: ${forgePreview.name}`);
    setForgeHead(null); setForgeShaft(null); setForgeGrip(null);
  };

  // ── ARMORY state ─────────────────────────────────────────────────────────
  const [armBase,    setArmBase]    = useState<string | null>(null);
  const [armMain,    setArmMain]    = useState<string | null>(null);
  const [armBacking, setArmBacking] = useState<string | null>(null);

  const armoryPreview = useMemo(() => {
    if (!armBase || !armMain || !armBacking) return null;
    return craftArmor(armBase, armMain, armBacking, Math.random);
  }, [armBase, armMain, armBacking]);

  const craftArmorPiece = () => {
    if (!armoryPreview) { toast('Select all components first.'); return; }
    const consumed: string[] = [];
    for (const matId of [armMain, armBacking]) {
      const mat = ALL_MATERIALS.find(m => m.id === matId);
      if (!mat) continue;
      const invItem = inventory.find(i => i.type === 'crafting_material' && i.name === mat.name);
      if (!invItem) { toast(`Missing: ${mat.name}`); return; }
      consumed.push(invItem.id);
    }
    onCraft(armoryPreview, consumed);
    toast(`Crafted: ${armoryPreview.name}`);
    setArmMain(null); setArmBacking(null);
  };

  // ── REFINE state ─────────────────────────────────────────────────────────
  const [refineMatId, setRefineMatId] = useState<string | null>(null);

  // Build refine candidates: tier-1 or tier-2 mats with qty >= 4
  const refineCandidates = useMemo(() => {
    const matCounts = new Map<string, { mat: MaterialProps; qty: number }>();
    for (const item of inventory) {
      if (item.type !== 'crafting_material') continue;
      const mat = ALL_MATERIALS.find(m => m.name === item.name);
      if (!mat || mat.tier === 3) continue;
      const entry = matCounts.get(mat.id);
      if (entry) entry.qty += item.quantity;
      else matCounts.set(mat.id, { mat, qty: item.quantity });
    }
    return [...matCounts.values()].filter(({ qty }) => qty >= REFINE_COST[2]);
  }, [inventory]);

  const refineSelected = refineCandidates.find(c => c.mat.id === refineMatId);

  const doRefine = () => {
    if (!refineSelected) { toast('Select a material to refine.'); return; }
    const { mat, qty } = refineSelected;
    if (qty < 4) { toast(`Need 4× ${mat.name} (have ${qty})`); return; }
    const nextMat = ALL_MATERIALS.find(m => m.tier === (mat.tier + 1 as 2|3) && m.line === mat.line);
    if (!nextMat) { toast('No higher tier for this material.'); return; }

    // Consume 4 from inventory
    const toConsume: string[] = [];
    let need = 4;
    for (const item of inventory) {
      if (need <= 0) break;
      if (item.type === 'crafting_material' && item.name === mat.name) {
        toConsume.push(item.id);
        need -= item.quantity;
      }
    }
    const result: GameItem = {
      id: `refine_${Date.now()}`, type: 'crafting_material',
      name: nextMat.name, slot: null, rarity: nextMat.tier as 0|1|2|3|4,
      quantity: 1, equipped: false,
      tint: typeof nextMat.tint === 'number' ? nextMat.tint : 0x888888,
    };
    onCraft(result, toConsume);
    toast(`Refined: ${nextMat.name}`);
  };

  // ── CRYSTALS state ───────────────────────────────────────────────────────
  const [crystalElement, setCrystalElement] = useState<ElementType>('plasma');
  const [crystalSize,    setCrystalSize]    = useState<CrystalSize>('small');

  const shardCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of inventory) {
      if (item.type !== 'elemental_fragment') continue;
      const el = item.elementalFragment?.element ?? 'plasma';
      counts[el] = (counts[el] ?? 0) + item.quantity;
    }
    return counts;
  }, [inventory]);

  const shardCost = CRYSTAL_SHARD_COST[crystalSize];
  const canCrystal = (shardCounts[crystalElement] ?? 0) >= shardCost;

  const doCrystal = () => {
    if (!canCrystal) { toast(`Need ${shardCost} ${crystalElement} shards.`); return; }
    const result = generateCrystal(crystalElement, crystalSize, Math.random);
    const consumed: string[] = [];
    let need = shardCost;
    for (const item of inventory) {
      if (need <= 0) break;
      if (item.type === 'elemental_fragment' && item.elementalFragment?.element === crystalElement) {
        consumed.push(item.id);
        need -= item.quantity;
      }
    }
    onCraft(result, consumed);
    toast(`Crystal created: ${result.name}`);
  };

  // ── RINGS state ──────────────────────────────────────────────────────────
  const [ringElement, setRingElement] = useState<ElementType>('plasma');

  const foCount     = inventory.filter(i => i.type === 'freq_oscillator').length;
  const vpCount     = inventory.filter(i => i.type === 'vortex_phaser').length;
  const ringShards  = shardCounts[ringElement] ?? 0;
  const canRing     = ringShards >= 20 && foCount >= 5 && vpCount >= 10;

  const doRing = () => {
    const result = craftRing(ringElement, inventory, Math.random);
    if (!result) { toast('Not enough materials for ring.'); return; }
    // Consume ingredients
    const consumed: string[] = [];
    let shardNeed = 20;
    for (const item of inventory) {
      if (shardNeed <= 0) break;
      if (item.type === 'elemental_fragment' && item.elementalFragment?.element === ringElement) {
        consumed.push(item.id); shardNeed -= item.quantity;
      }
    }
    let foNeed = 5;
    for (const item of inventory) {
      if (foNeed <= 0) break;
      if (item.type === 'freq_oscillator') { consumed.push(item.id); foNeed--; }
    }
    let vpNeed = 10;
    for (const item of inventory) {
      if (vpNeed <= 0) break;
      if (item.type === 'vortex_phaser') { consumed.push(item.id); vpNeed--; }
    }
    onCraft(result, consumed);
    toast(`Ring crafted: ${result.name}`);
  };

  const elements: ElementType[] = ['plasma','fire','ice','lightning','void'];
  const elemColors: Record<ElementType, string> = {
    plasma: '#c080ff', fire: '#ff6020', ice: '#60d0ff', lightning: '#ffe040', void: '#8040c0',
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)',
    }}>
      <div style={{
        width: 560, maxHeight: '85vh',
        background: PANEL_BG, border: `1px solid ${BORDER}`,
        borderRadius: 8, display: 'flex', flexDirection: 'column',
        boxShadow: '0 8px 40px rgba(0,0,0,0.8)', overflow: 'hidden',
      }}>

        {/* Header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '12px 16px', borderBottom: `1px solid ${BORDER}`, flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 13, fontFamily: 'monospace', fontWeight: 700, color: ACCENT, letterSpacing: 2 }}>
              ⚒ CRAFTING STATION
            </div>
            <div style={{ fontSize: 8, color: TEXT_DIM, fontFamily: 'monospace', marginTop: 2 }}>
              Forge equipment from gathered materials
            </div>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:TEXT_DIM, fontSize:16, cursor:'pointer' }}>✕</button>
        </div>

        {/* Tabs */}
        <div style={{
          display: 'flex', gap: 5, padding: '8px 16px',
          borderBottom: `1px solid ${BORDER}`, flexShrink: 0,
        }}>
          {(['forge','armory','refine','crystals','rings'] as CraftTab[]).map(t => (
            <button key={t} onClick={() => setTab(t)} style={tabBtn(tab === t)}>
              {t.toUpperCase()}
            </button>
          ))}
        </div>

        {/* Feedback toast */}
        {feedback && (
          <div style={{
            margin: '8px 16px 0', padding: '5px 10px', fontSize: 9,
            fontFamily: 'monospace', borderRadius: 3, flexShrink: 0,
            background: feedback.toLowerCase().includes('need') || feedback.toLowerCase().includes('miss') || feedback.toLowerCase().includes('select')
              ? 'rgba(255,68,68,0.12)' : 'rgba(68,255,120,0.10)',
            color: feedback.toLowerCase().includes('need') || feedback.toLowerCase().includes('miss') || feedback.toLowerCase().includes('select')
              ? '#ff8888' : '#66ffaa',
            border: '1px solid transparent',
          }}>
            {feedback}
          </div>
        )}

        {/* Content */}
        <div style={{ flex:1, overflowY:'auto', padding:'10px 16px 16px' }}>

          {/* ── FORGE ── */}
          {tab === 'forge' && (
            <div>
              {sectionLabel('WEAPON BASE')}
              <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom:8 }}>
                {WEAPON_BASES.map(wb => (
                  <button key={wb.id} onClick={() => setForgeBase(wb.id === forgeBase ? null : wb.id)}
                    style={tabBtn(forgeBase === wb.id, ACCENT2)}>
                    {wb.name}
                  </button>
                ))}
              </div>

              {forgeBase && (
                <>
                  {sectionLabel('ELEMENT')}
                  <div style={{ display:'flex', gap:4, marginBottom:8 }}>
                    {elements.map(el => (
                      <button key={el} onClick={() => setForgeElement(el)}
                        style={{ ...tabBtn(forgeElement === el, elemColors[el]), fontSize: 8 }}>
                        {el.toUpperCase()}
                      </button>
                    ))}
                  </div>

                  {sectionLabel('HEAD MATERIAL (damage)')}
                  <MatPicker role="head" inventory={inventory} selected={forgeHead} onSelect={setForgeHead} />

                  {sectionLabel('SHAFT MATERIAL (swing speed)')}
                  <MatPicker role="shaft" inventory={inventory} selected={forgeShaft} onSelect={setForgeShaft} />

                  {sectionLabel('GRIP MATERIAL (handling)')}
                  <MatPicker role="grip" inventory={inventory} selected={forgeGrip} onSelect={setForgeGrip} />
                </>
              )}

              {forgePreview && (
                <>
                  {sectionLabel('PREVIEW')}
                  <StatBlock stats={{
                    Name:      forgePreview.name,
                    Damage:    `${forgePreview.weaponStats?.dmgMin ?? '?'} – ${forgePreview.weaponStats?.dmgMax ?? '?'}`,
                    Speed:     (forgePreview.weaponStats?.attackSpeed ?? 0).toFixed(2),
                    Crit:      `${((forgePreview.weaponStats?.critChance ?? 0) * 100).toFixed(1)}%`,
                    Element:   forgeElement,
                    Rarity:    RARITIES[forgePreview.rarity]?.name ?? 'Common',
                    Durability:`${forgePreview.weaponStats?.durabilityMax ?? '?'}`,
                  }} />
                </>
              )}

              <button
                onClick={forgeWeapon}
                disabled={!forgePreview}
                style={{
                  marginTop: 12, width: '100%', padding: '8px', fontSize: 11,
                  fontFamily:'monospace', fontWeight:700, letterSpacing:2,
                  background: forgePreview ? 'rgba(245,158,11,0.15)' : 'rgba(30,30,30,0.5)',
                  color: forgePreview ? ACCENT : TEXT_DIM,
                  border: `1px solid ${forgePreview ? ACCENT + '55' : BORDER}`,
                  borderRadius: 4, cursor: forgePreview ? 'pointer' : 'default',
                }}
              >
                {forgePreview ? `⚒ FORGE ${forgePreview.name.toUpperCase()}` : 'SELECT ALL COMPONENTS'}
              </button>
            </div>
          )}

          {/* ── ARMORY ── */}
          {tab === 'armory' && (
            <div>
              {sectionLabel('ARMOR BASE')}
              <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginBottom:8 }}>
                {ARMOR_BASES.map(ab => (
                  <button key={ab.id} onClick={() => setArmBase(ab.id === armBase ? null : ab.id)}
                    style={tabBtn(armBase === ab.id, ACCENT2)}>
                    {ab.name}
                  </button>
                ))}
              </div>

              {armBase && (
                <>
                  {sectionLabel('MAIN MATERIAL')}
                  <MatPicker role="armor_main" inventory={inventory} selected={armMain} onSelect={setArmMain} />
                  {sectionLabel('BACKING MATERIAL')}
                  <MatPicker role="armor_backing" inventory={inventory} selected={armBacking} onSelect={setArmBacking} />
                </>
              )}

              {armoryPreview && (
                <>
                  {sectionLabel('PREVIEW')}
                  <StatBlock stats={{
                    Name:        armoryPreview.name,
                    Defense:     armoryPreview.armorStats?.defense ?? '?',
                    'Slash Res': armoryPreview.armorStats?.slashResist?.toFixed(1) ?? '?',
                    'Pierce Res':armoryPreview.armorStats?.pierceResist?.toFixed(1) ?? '?',
                    Rarity:      RARITIES[armoryPreview.rarity]?.name ?? 'Common',
                    Durability:  `${armoryPreview.armorStats?.durabilityMax ?? '?'}`,
                  }} />
                </>
              )}

              <button
                onClick={craftArmorPiece}
                disabled={!armoryPreview}
                style={{
                  marginTop: 12, width:'100%', padding:'8px', fontSize:11,
                  fontFamily:'monospace', fontWeight:700, letterSpacing:2,
                  background: armoryPreview ? 'rgba(96,165,250,0.15)' : 'rgba(30,30,30,0.5)',
                  color: armoryPreview ? ACCENT2 : TEXT_DIM,
                  border: `1px solid ${armoryPreview ? ACCENT2 + '55' : BORDER}`,
                  borderRadius: 4, cursor: armoryPreview ? 'pointer' : 'default',
                }}
              >
                {armoryPreview ? `⚒ CRAFT ${armoryPreview.name.toUpperCase()}` : 'SELECT ALL COMPONENTS'}
              </button>
            </div>
          )}

          {/* ── REFINE ── */}
          {tab === 'refine' && (
            <div>
              <div style={{ fontSize: 9, color: TEXT_MED, fontFamily:'monospace', marginBottom:10 }}>
                Combine 4 of a Tier-1 or Tier-2 material into 1 of the next tier.
              </div>
              {refineCandidates.length === 0 && (
                <div style={{ fontSize:9, color:TEXT_DIM, fontFamily:'monospace' }}>
                  No materials available for refining. You need at least 4 of a single tier-1 or tier-2 material.
                </div>
              )}
              {refineCandidates.map(({ mat, qty }) => {
                const nextMat = ALL_MATERIALS.find(m => m.tier === (mat.tier + 1 as 2|3) && m.line === mat.line);
                const isSelected = refineMatId === mat.id;
                return (
                  <div
                    key={mat.id}
                    onClick={() => setRefineMatId(isSelected ? null : mat.id)}
                    style={{
                      display:'flex', alignItems:'center', justifyContent:'space-between',
                      padding:'6px 8px', borderRadius:4, marginBottom:3, cursor:'pointer',
                      background: isSelected ? 'rgba(245,158,11,0.08)' : 'rgba(255,255,255,0.02)',
                      border: `1px solid ${isSelected ? ACCENT + '44' : BORDER}`,
                    }}
                  >
                    <div>
                      <div style={{ fontSize:10, fontFamily:'monospace', color: isSelected ? ACCENT : TEXT_MAIN }}>
                        {mat.name} <span style={{ color:TEXT_DIM }}>×{qty}</span>
                      </div>
                      {nextMat && (
                        <div style={{ fontSize:8, fontFamily:'monospace', color:TEXT_DIM }}>
                          → {nextMat.name} (costs 4)
                        </div>
                      )}
                    </div>
                    <div style={{ fontSize:8, fontFamily:'monospace', color:TEXT_DIM }}>
                      T{mat.tier} → T{mat.tier + 1}
                    </div>
                  </div>
                );
              })}
              {refineSelected && (
                <button
                  onClick={doRefine}
                  style={{
                    marginTop:10, width:'100%', padding:'8px', fontSize:11,
                    fontFamily:'monospace', fontWeight:700, letterSpacing:2,
                    background:'rgba(245,158,11,0.15)', color:ACCENT,
                    border:`1px solid ${ACCENT}55`, borderRadius:4, cursor:'pointer',
                  }}
                >
                  REFINE 4× {refineSelected.mat.name.toUpperCase()}
                </button>
              )}
            </div>
          )}

          {/* ── CRYSTALS ── */}
          {tab === 'crystals' && (
            <div>
              <div style={{ fontSize:9, color:TEXT_MED, fontFamily:'monospace', marginBottom:10 }}>
                Spend elemental shards to generate an Ability Crystal. Crystals go in the ability crystal slot.
              </div>

              {sectionLabel('ELEMENT')}
              <div style={{ display:'flex', gap:4, marginBottom:10 }}>
                {elements.map(el => {
                  const count = shardCounts[el] ?? 0;
                  return (
                    <button key={el} onClick={() => setCrystalElement(el)}
                      style={{ ...tabBtn(crystalElement === el, elemColors[el]), position:'relative' }}>
                      {el.slice(0,4).toUpperCase()}
                      <span style={{ position:'absolute', top:-4, right:-4, fontSize:6,
                        background:count > 0 ? elemColors[el] : '#333',
                        color:'#000', borderRadius:8, padding:'0 3px', fontWeight:700 }}>
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>

              {sectionLabel('SIZE')}
              <div style={{ display:'flex', gap:4, marginBottom:10 }}>
                {(['small','medium','large'] as CrystalSize[]).map(sz => (
                  <button key={sz} onClick={() => setCrystalSize(sz)} style={tabBtn(crystalSize === sz)}>
                    {sz.toUpperCase()} ({CRYSTAL_SHARD_COST[sz]} shards)
                  </button>
                ))}
              </div>

              <div style={{ fontSize:9, fontFamily:'monospace', color: canCrystal ? TEXT_MAIN : '#ff6666', marginBottom:8 }}>
                You have {shardCounts[crystalElement] ?? 0} {crystalElement} shards.
                Need {shardCost} for a {crystalSize} crystal.
              </div>

              <button
                onClick={doCrystal}
                disabled={!canCrystal}
                style={{
                  width:'100%', padding:'8px', fontSize:11, fontFamily:'monospace',
                  fontWeight:700, letterSpacing:2,
                  background: canCrystal ? `${elemColors[crystalElement]}22` : 'rgba(30,30,30,0.5)',
                  color: canCrystal ? elemColors[crystalElement] : TEXT_DIM,
                  border: `1px solid ${canCrystal ? elemColors[crystalElement] + '55' : BORDER}`,
                  borderRadius:4, cursor: canCrystal ? 'pointer' : 'default',
                }}
              >
                {canCrystal ? `◈ GENERATE ${crystalSize.toUpperCase()} ${crystalElement.toUpperCase()} CRYSTAL` : 'NOT ENOUGH SHARDS'}
              </button>
            </div>
          )}

          {/* ── RINGS ── */}
          {tab === 'rings' && (
            <div>
              <div style={{ fontSize:9, color:TEXT_MED, fontFamily:'monospace', marginBottom:10 }}>
                Craft a permanent ring. Costs 20 elemental shards + 5 Frequency Oscillators + 10 Vortex Phasers.
                Rings are never destroyed.
              </div>

              {sectionLabel('ELEMENT')}
              <div style={{ display:'flex', gap:4, marginBottom:12 }}>
                {elements.map(el => (
                  <button key={el} onClick={() => setRingElement(el)}
                    style={tabBtn(ringElement === el, elemColors[el])}>
                    {el.slice(0,4).toUpperCase()}
                  </button>
                ))}
              </div>

              {sectionLabel('INGREDIENT CHECK')}
              <StatBlock stats={{
                [`${ringElement} Shards`]: `${shardCounts[ringElement] ?? 0} / 20 ${(shardCounts[ringElement] ?? 0) >= 20 ? '✓' : '✗'}`,
                'Freq Oscillators': `${foCount} / 5 ${foCount >= 5 ? '✓' : '✗'}`,
                'Vortex Phasers':   `${vpCount} / 10 ${vpCount >= 10 ? '✓' : '✗'}`,
              }} />

              <button
                onClick={doRing}
                disabled={!canRing}
                style={{
                  marginTop:12, width:'100%', padding:'8px', fontSize:11,
                  fontFamily:'monospace', fontWeight:700, letterSpacing:2,
                  background: canRing ? `${elemColors[ringElement]}22` : 'rgba(30,30,30,0.5)',
                  color: canRing ? elemColors[ringElement] : TEXT_DIM,
                  border: `1px solid ${canRing ? elemColors[ringElement] + '55' : BORDER}`,
                  borderRadius:4, cursor: canRing ? 'pointer' : 'default',
                }}
              >
                {canRing ? `◎ FORGE ${ringElement.toUpperCase()} RING` : 'INSUFFICIENT MATERIALS'}
              </button>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
